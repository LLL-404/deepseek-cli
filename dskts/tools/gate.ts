// Gate 尖刀脚本（T0.2，一次性，不走最终架构）——验证 DeepSeek 对 Playwright
// 定制版 Firefox 的风控。判据见 output/plan_phase2_PRD.md F0：
//   登录无验证码墙（人工旁观）；≥10 次真实问答全部完整；正文容器行为与旧 Python 版一致。
//
// 用法：node tools/gate.ts "问题1" "问题2" ...
// 选择器与 JS 片段从旧 Python 版 平移（ANSWER_SEL/READ_LAST_ANSWER/TOGGLE_FINDER），
// 完成判定语义对齐旧 Python 版 answer_state + wait_for_answer（双信号 + 抖动容忍）。
// 判读结论人工确认后写入 output/gate-结果.md（T0.3）。
import { firefox } from "playwright";
import os from "node:os";
import path from "node:path";

const CHAT_URL = "https://chat.deepseek.com/";
// 一条助手消息的正文容器；思考过程在 .ds-think-content（不在这容器里）；
// 代码块横幅在容器内部，读数前临时隐藏——三者都从旧 Python 版平移。
const ANSWER_SEL = ".ds-assistant-message-main-content";
const BANNER_SEL = ".md-code-block-banner-wrap";
const PROFILE_DIR = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "dsk-ffprofile"
);

// 等待参数（对齐旧 Python 版语义：3 秒一拍、文本稳 3 拍且至少等过 12 秒、忙门、总上限）
const TICK = 3_000;
const MIN_WAIT = 12_000;
const STABLE_NEED = 3;
const CAP = 300_000; // Gate 单问上限 300 秒（旧 Python 版默认 240；Gate 稍宽以免误判）
const READ_FAIL_MAX = 5;
const LOGIN_WAIT = 15 * 60_000;

const log = (...a: unknown[]) => console.error(...a);

// —— 旧 Python 版 READ_LAST_ANSWER 平移（加 bars/think 两个容器行为证据字段）。
// 用真函数 + 单参数对象：Playwright 的字符串 evaluate 是表达式语义，
// 函数体字符串在多行形态下不被识别为函数，求值成函数对象回传 undefined——首轮 Gate 就栽在这。——
type Sample = { count: number; busy: boolean; last: string; bars: number; think: number };

async function readOnce(page: import("playwright").Page): Promise<Sample> {
  return await page.evaluate(([sel, banner]): Sample => {
    const els = [...document.querySelectorAll(sel)];
    const busy = !!document.querySelector("[class*=stop-btn],[aria-label*=停止]");
    const think = document.querySelectorAll(".ds-think-content").length;
    let last = "", bars = 0;
    if (els.length) {
      const node = els[els.length - 1] as HTMLElement;
      const barEls = [...node.querySelectorAll(banner)] as HTMLElement[];
      bars = barEls.length;
      for (const b of barEls) b.style.setProperty("display", "none", "important");
      last = node.innerText || "";
      for (const b of barEls) b.style.removeProperty("display");
    }
    return { count: els.length, busy, last, bars, think };
  }, [ANSWER_SEL, BANNER_SEL]);
}

// —— 旧 Python 版 set_toggle 平移：文本叶子的最近 aria-pressed 祖先。
// 用 xpath 定位器真点击（旧 Python 版 ElementClick 的等价物），不走合成事件。——
function toggleLocator(page: import("playwright").Page, label: string) {
  return page.locator(
    `xpath=//*[normalize-space(text())='${label}']/ancestor::*[@aria-pressed][1]`
  );
}

async function setToggles(page: import("playwright").Page) {
  // 新 profile 的界面语言跟随浏览器 locale；两套标签都试（中/英）。
  for (const variants of [["深度思考", "DeepThink"], ["智能搜索", "Search"]]) {
    let hit: import("playwright").Locator | null = null;
    let used = "";
    for (const label of variants) {
      const loc = toggleLocator(page, label);
      try {
        await loc.waitFor({ state: "attached", timeout: 3000 });
        hit = loc; used = label;
        break;
      } catch { /* 试下一个语言变体 */ }
    }
    if (!hit) {
      log(`  警告：开关 ${variants.join("/")} 都没找到，保持原样`);
      continue;
    }
    const now = await hit.getAttribute("aria-pressed");
    if (now === "true") {
      log(`  开关（${used}）已是 true，不动`);
      continue;
    }
    await hit.click();
    await page.waitForTimeout(1500);
    log(`  开关（${used}）${now} -> ${await hit.getAttribute("aria-pressed")}（要 true）`);
  }
}

type QResult = {
  question: string; answer: string; done: boolean; truncated: boolean;
  seconds: number; chars: number; landed: boolean; busyAtEnd: boolean;
  bars: number; think: number; error?: string;
};

async function askOne(page: import("playwright").Page, question: string): Promise<QResult> {
  const pre = await readOnce(page);
  if (pre.busy) {
    return { question, answer: "", done: false, truncated: false, seconds: 0, chars: 0,
      landed: false, busyAtEnd: true, bars: pre.bars, think: pre.think,
      error: "提交前就有停止按钮（上一条还在生成）——提交会被吃掉，本问跳过" };
  }
  const countBefore = pre.count;
  const lastBefore = (pre.last || "").trim();

  const ta = page.locator("textarea").last();
  await ta.fill(question);
  const val = await ta.inputValue();
  if (val !== question) {
    return { question, answer: "", done: false, truncated: false, seconds: 0, chars: 0,
      landed: false, busyAtEnd: false, bars: pre.bars, think: pre.think,
      error: `填题回读不一致（要 ${question.length} 字，实 ${val.length} 字）——不提交` };
  }
  await ta.press("Enter");
  // 提交验证：提交成功后页面会清空输入框；还留着原文就补回车（防吃键）。
  // Gate 第三轮教训：Q7 回车被吃，脚本对着一个没提交的问题瞎等了 300 秒。
  let submitted = false;
  for (let attempt = 0; attempt <= 2; attempt++) {
    await page.waitForTimeout(3000);
    if ((await ta.inputValue()) !== question) { submitted = true; break; }
    if (attempt < 2) {
      log(`  输入框未清空，疑似回车被吃，补提交（第 ${attempt + 1} 次）`);
      await ta.press("Enter");
    }
  }
  if (!submitted) {
    return { question, answer: "", done: false, truncated: false, seconds: 9, chars: 0,
      landed: false, busyAtEnd: false, bars: 0, think: 0,
      error: "回车连吃 3 次（输入框始终未清空），提交失败" };
  }
  log(`  已提交，等落地与停笔（单问上限 ${CAP / 1000}s）…`);

  let last = "", stable = 0, waited = 0, failRun = 0;
  let landed = false, done = false, truncated = false, busyAtEnd = false;
  let bars = 0, think = 0;
  while (true) {
    await page.waitForTimeout(TICK);
    waited += TICK;
    let d: Sample;
    try {
      d = await readOnce(page);
      failRun = 0;
    } catch (exc) {
      failRun++;
      if (failRun >= READ_FAIL_MAX) {
        log(`  读数连挂 ${failRun} 拍（${exc}），收摊`);
        return { question, answer: last, done: false, truncated: true, seconds: waited / 1000,
          chars: last.length, landed, busyAtEnd: busyAtEnd, bars, think,
          error: `连挂 ${failRun} 拍读不上页面` };
      }
      log(`  第 ${failRun}/${READ_FAIL_MAX} 拍读数失败（${exc}），当空采样`);
      continue;
    }
    bars = d.bars; think = d.think; busyAtEnd = d.busy;
    const txt = (d.last || "").trim();
    if (!landed) {
      // 旧 Python 版 answer_state 的落地认法（忠实平移）：最后容器文本离开提交前那条且非空即落地；
      // 条数增多只是常见形态——虚拟列表卸旧回合会让 count 缩水，count 不是落地的必要条件。
      // Gate 首轮教训：Q7/Q8 答案已生成但 count 从 6 缩到 2，两条 count 条件全败，瞎等 300 秒。
      const pending = d.count === 0 || !txt ||
        (d.count <= countBefore && txt === lastBefore);
      if (!pending) {
        landed = true;
        log(`  新回合已落地（count ${countBefore}→${d.count}，文本 ${txt.length} 字）`);
      } else if (waited >= CAP) {
        // 落地失败收摊前抓一次现场证据（虚拟列表/dialog/toast/URL）
        try {
          const diag = await page.evaluate((sel: string): string => {
            const els = [...document.querySelectorAll(sel)];
            const think = document.querySelectorAll(".ds-think-content").length;
            const popups = [...document.querySelectorAll(
              "[role=dialog],[class*=toast],[class*=modal]"
            )].map(e => (e.textContent || "").trim().slice(0, 60)).filter(Boolean);
            return JSON.stringify({ count: els.length, think, popups, path: location.pathname });
          }, ANSWER_SEL);
          log(`  落地失败现场：${diag}`);
        } catch { /* 诊断失败不影响收摊 */ }
        truncated = true;
        break;
      } else {
        continue;
      }
    }
    if (txt && txt === last && waited >= MIN_WAIT) {
      stable++;
      if (stable >= STABLE_NEED && !d.busy) { done = true; break; }
    } else {
      stable = 0;
    }
    last = txt;
    if (waited >= CAP) { truncated = true; break; }
  }
  const answer = last; // 收摊时 last 就是已得文本（done 与否都打印）
  return { question, answer, done, truncated, seconds: waited / 1000,
    chars: last.length, landed, busyAtEnd, bars, think };
}

async function main(): Promise<number> {
  const questions = process.argv.slice(2);
  if (!questions.length) {
    log('用法：node tools/gate.ts "问题1" "问题2" ...（建议 10 问）');
    return 1;
  }
  log(`profile：${PROFILE_DIR}`);
  const context = await firefox.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    locale: "zh-CN", // 钉死中文界面：新 profile 默认 en-US 会让中文选择器扑空（M1 环境层沿用）
    args: ["--start-maximized"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    log(`导航 ${CHAT_URL} …`);
    await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    log(`页面标题：「${await page.title()}」`);
    log(`请在打开的 Firefox 窗口里登录 DeepSeek（若已登录会自动继续）；最长等 ${LOGIN_WAIT / 60000} 分钟。`);
    log(`登录过程中若有验证码/风控墙，请记录现象——这是 Gate 判据之一。`);
    await page.waitForSelector("textarea", { timeout: LOGIN_WAIT });
    log(`检测到输入框，判定已登录（URL：${page.url()}）`);
    await page.waitForTimeout(3000);
    const pressed = await page.evaluate(() =>
      [...document.querySelectorAll("[aria-pressed]")].map(
        (e) => `${(e.textContent || "").trim().slice(0, 30)}=${e.getAttribute("aria-pressed")}`
      ).join(" | ")
    );
    log(`aria-pressed 元素盘点：${pressed || "（一个都没有）"}`);
    await setToggles(page); // 设一次即可：开关状态在会话里持续存在（对齐旧 Python 版语义）

    const results: QResult[] = [];
    const t0 = Date.now();
    for (const [i, q] of questions.entries()) {
      log(`=== GATE Q${i + 1}/${questions.length} START: ${q}`);
      let r: QResult;
      try {
        r = await askOne(page, q);
      } catch (exc) {
        r = { question: q, answer: "", done: false, truncated: false, seconds: 0, chars: 0,
          landed: false, busyAtEnd: false, bars: -1, think: -1, error: String(exc) };
      }
      results.push(r);
      console.log(`=== Q${i + 1} ANSWER ===`);
      console.log(r.answer || (r.error ? `(无答案：${r.error})` : "(无答案)"));
      console.log(`=== Q${i + 1} END done=${r.done} truncated=${r.truncated} ` +
        `sec=${r.seconds.toFixed(0)} chars=${r.chars} landed=${r.landed} ` +
        `busyAtEnd=${r.busyAtEnd} bars=${r.bars} think=${r.think}` +
        (r.error ? ` error="${r.error}"` : ""));
      await page.waitForTimeout(2000);
    }
    const wall = ((Date.now() - t0) / 1000).toFixed(0);
    const answered = results.filter(r => r.chars > 0).length;
    const truncated = results.filter(r => r.truncated).length;
    const failed = results.filter(r => r.error).length;
    console.log(`=== GATE SUMMARY ===`);
    console.log(`questions=${questions.length} answered=${answered} truncated=${truncated} ` +
      `failed=${failed} totalChars=${results.reduce((s, r) => s + r.chars, 0)} wallSec=${wall}`);
    const ok = answered === questions.length && truncated === 0 && failed === 0;
    console.log(`verdict=${ok ? "CANDIDATE-PASS" : "PROBLEM"}（机器判据；` +
      `人工判据另计：登录过程有无验证码墙、答案内容抽查）`);
    return ok ? 0 : 1;
  } finally {
    await context.close().catch(() => {});
  }
}

process.exitCode = await main();
