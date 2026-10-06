// 页面层（T1.5/T1.6）：选择器、等待、读数、会话/开关/填题/提交/改名。
// 只该知道 Playwright API 与 DOM；不该知道命令行与进程（规格第四节职责表）。
// 全部从现版 dsk.py 平移，并按 Gate 实证（output/gate-结果.md F-1~F-4）修正。
import type { Page } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ANSWER_SEL, BANNER_SEL, BUSY_SEL, CHAT_URL,
  SUBMIT_VERIFY_GAP_MS, SUBMIT_VERIFY_TRIES, TOGGLE_LABELS,
} from "./constants.ts";
import { homeTitleFor, isOwned, ownedPrefixes, ownerOf } from "./agent.ts";
import { createJudge, type Reading, type Judge, type Terminal } from "./judge.ts";
import { TICK_MS, MIN_WAIT_MS, STABLE_NEED, READ_FAIL_MAX } from "./constants.ts";

export type Sample = { text: string; busy: boolean; count: number };
export type ConvRow = { title: string; id: string };

/** 带退出码语义的错误：code=2 前提不满足，code=1 运行错误（规格退出码表） */
export class FlowError extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

// —— 读数器（现版 READ_LAST_ANSWER 平移；横幅先隐藏再取词）——
export async function readOnce(page: Page): Promise<Sample> {
  return await page.evaluate(({ sel, banner }: { sel: string; banner: string }) => {
    const els = [...document.querySelectorAll(sel)];
    const busy = !!document.querySelector("[class*=stop-btn],[aria-label*=停止]");
    let last = "";
    if (els.length) {
      const node = els[els.length - 1] as HTMLElement;
      const bars = [...node.querySelectorAll(banner)] as HTMLElement[];
      for (const b of bars) b.style.setProperty("display", "none", "important");
      last = node.innerText || "";
      for (const b of bars) b.style.removeProperty("display");
    }
    return { count: els.length, busy, text: last };
  }, { sel: ANSWER_SEL, banner: BANNER_SEL });
}

export async function gotoChat(page: Page): Promise<void> {
  await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
}

export async function isLoggedIn(page: Page, timeoutMs = 5_000): Promise<boolean> {
  try {
    await page.waitForSelector("textarea", { state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** 等输入框出现；超时带着页面证据报错（对齐现版「找不到输入框」路径） */
export async function waitTextarea(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForSelector("textarea", { state: "visible", timeout: timeoutMs });
  } catch {
    const head = await page.evaluate(() =>
      (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 160)
    );
    throw new FlowError(`找不到输入框。当前页 ${page.url()}；页面开头：${head}`);
  }
}

// —— 会话锚点（现版 ANCHORS / conv_anchors_wait 平移）——
export async function convAnchors(page: Page): Promise<ConvRow[]> {
  return await page.evaluate((): ConvRow[] =>
    [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/a/chat/s/"]')]
      .map((a) => ({
        title: (a.textContent || "").trim().slice(0, 60),
        id: (a.getAttribute("href") || "").split("/").pop() || "",
      }))
      .filter((x) => x.title && x.id)
  );
}

/** 侧栏慢渲染时第一把常常是空的，连读几把再放弃（现版同款，防连续会话裂开） */
export async function convAnchorsWait(
  page: Page, tries = 5, gapMs = 2_000
): Promise<ConvRow[]> {
  let rows: ConvRow[] = [];
  for (let i = 0; i < tries; i++) {
    rows = await convAnchors(page);
    if (rows.length) return rows;
    if (i < tries - 1) await page.waitForTimeout(gapMs);
  }
  return rows;
}

// —— 开关（现版 set_toggle 平移；xpath 真点击 + Gate F-4 双语标签）——
function toggleLocator(page: Page, label: string) {
  return page.locator(
    `xpath=//*[normalize-space(text())='${label}']/ancestor::*[@aria-pressed][1]`
  );
}

export async function setToggles(page: Page): Promise<void> {
  for (const variants of TOGGLE_LABELS) {
    let hit = false;
    for (const label of variants) {
      const loc = toggleLocator(page, label);
      try {
        await loc.waitFor({ state: "attached", timeout: 3_000 });
      } catch {
        continue; // 试下一个语言变体
      }
      hit = true;
      if ((await loc.getAttribute("aria-pressed")) === "true") break;
      await loc.click();
      await page.waitForTimeout(1_500);
      break;
    }
    if (!hit) console.error(`  警告：开关 ${variants.join("/")} 都没找到，保持原样`);
  }
}

// —— 会话选择（现版 ask() 的选择段平移）——
export type SessionChoice =
  | { kind: "nav"; id: string; title: string }
  | { kind: "created"; emptySidebar: boolean };

export async function selectSession(
  page: Page, chat: string | null, mark: string, log: (m: string) => void
): Promise<SessionChoice> {
  const rows = await convAnchorsWait(page);
  const homeTitle = homeTitleFor(mark);
  if (chat) {
    const hits = rows.filter((r) => r.title.includes(chat));
    if (!hits.length) {
      throw new FlowError(
        `侧栏里没有含「${chat}」的会话。可选的有：\n  ` +
        rows.slice(0, 20).map((r) => r.title).join("\n  "), 2);
    }
    if (hits.length > 1) {
      throw new FlowError(
        `「${chat}」命中 ${hits.length} 条，说得更具体些：\n  ` +
        hits.map((r) => r.title).join("\n  "), 2);
    }
    log(`进会话「${hits[0].title}」`);
    return { kind: "nav", id: hits[0].id, title: hits[0].title };
  }
  // 只认本 Agent 的会话：跨 Agent 蹭会话会让归属标记名不副实
  //（标题写着 Qoder，实际是 WorkBuddy 在写），上下文也会互相污染。
  // 要跨 Agent 用某条会话，走 --chat 显式指定。
  const home = rows.filter((r) => r.title.startsWith(homeTitle));
  const mine = rows.filter((r) => ownerOf(r.title, mark) === mark);
  if (home.length) {
    log(`复用本 Agent 的连续会话「${home[0].title}」`);
    return { kind: "nav", id: home[0].id, title: home[0].title };
  }
  if (mine.length) {
    log(`没有「${homeTitle}」，先复用本 Agent 现成的会话「${mine[0].title}」`);
    return { kind: "nav", id: mine[0].id, title: mine[0].title };
  }
  const others = rows.filter((r) => isOwned(r.title, mark) && ownerOf(r.title, mark) !== mark);
  if (others.length) {
    log(`侧栏里有 ${others.length} 条别的 Agent 的会话，不蹭；本 Agent 另开一条`);
  }
  const clicked = await page.evaluate((): string => {
    const hit = [...document.querySelectorAll<HTMLElement>("button,[role=button],a,div,span,li")]
      .filter((e) => !e.children.length)
      .find((e) => (e.textContent || "").trim().startsWith("开启新对话"));
    if (hit) { hit.click(); return "clicked"; }
    return "not-found";
  });
  if (clicked !== "clicked") log(`  警告：「开启新对话」没点到（${clicked}），直接用当前页输入`);
  if (!rows.length) {
    log("警告：侧栏连读几把都是空的——要么这账号真没会话，要么列表没渲染出来或改版了。" +
      `先开新对话顶着（答完会自动改名成「${homeTitle}」）；侧栏明明有会话的话，先 dsk chats 验一验`);
  }
  await page.waitForTimeout(1_500);
  return { kind: "created", emptySidebar: rows.length === 0 };
}

// —— 提问与提交（现版填题回读 + 前提校验 + Gate F-2 提交验证）——
export async function fillAndVerify(page: Page, question: string): Promise<void> {
  const ta = page.locator("textarea").last();
  await ta.waitFor({ state: "visible", timeout: 15_000 });
  // 不做 ta.click()：Playwright 的 fill 自带 focus；click 的 hit-target 检查会被任何
  // 页面浮层卡死（M4 实弹：旧 keeper 会话里 12 连败的根因），Marionette 时代的
  // 「先点再填」在这里是有害的 Cargo。
  await ta.fill(question);
  const typed = await ta.inputValue();
  if (typed !== question) {
    throw new FlowError(`输入框内容与问题不一致（读到 ${typed.length} 字），已中止`);
  }
}

export async function guardNotBusy(page: Page): Promise<void> {
  const d0 = await readOnce(page);
  if (d0.busy) {
    throw new FlowError(
      "上一条还在生成（页面有「停止」按钮），这条会被吃掉。等它答完再问，或 dsk down 后重来", 2);
  }
}

export async function submitWithVerify(
  page: Page, question: string, log: (m: string) => void
): Promise<void> {
  const ta = page.locator("textarea").last();
  await ta.press("Enter");
  // 提交验证：成功提交后页面会清空输入框；还留着原文就补回车（Gate F-2）
  for (let attempt = 0; attempt < SUBMIT_VERIFY_TRIES; attempt++) {
    await page.waitForTimeout(SUBMIT_VERIFY_GAP_MS);
    if ((await ta.inputValue()) !== question) return;
    if (attempt < SUBMIT_VERIFY_TRIES - 1) {
      log(`  输入框未清空，疑似回车被吃，补提交（第 ${attempt + 1} 次）`);
      await ta.press("Enter");
    }
  }
  throw new FlowError("回车连吃 3 次（输入框始终未清空），提交失败");
}

// —— 等待判定循环（judge 的运行时外壳；3 秒一拍喂读数）——
export type LoopResult = { terminal: Terminal; text: string };

export async function judgeLoop(
  page: Page, judge: Judge, log: (m: string) => void,
  onTick?: (text: string) => void
): Promise<LoopResult> {
  for (;;) {
    await page.waitForTimeout(TICK_MS);
    let reading: Reading;
    try {
      reading = { ok: true, sample: await readOnce(page) };
    } catch (exc) {
      reading = { ok: false, error: String(exc) };
    }
    const v = judge.tick(reading);
    log(`  t=${(v.waitedMs / 1000).toFixed(0)}s landed=${v.landed} ` +
      `chars=${v.text.length} terminal=${v.terminal ?? "-"}`);
    if (onTick) onTick(v.text);
    if (v.terminal) return { terminal: v.terminal, text: v.text };
  }
}

export function makeJudge(countBefore: number, lastBefore: string, maxWaitMs: number): Judge {
  return createJudge(countBefore, lastBefore, {
    tickMs: TICK_MS, minWaitMs: MIN_WAIT_MS, stableNeed: STABLE_NEED,
    readFailMax: READ_FAIL_MAX, maxWaitMs,
  });
}

// —— 附件（现版 attach 平移；类型白名单以页面 input[accept] 为准）——
// Playwright 的 setInputFiles 不要求元素可见，省掉现版的显形舞蹈。
export async function attachFile(
  page: Page, filePath: string, log: (m: string) => void
): Promise<void> {
  if (!fs.existsSync(filePath)) throw new FlowError(`文件不存在：${filePath}`);
  const name = path.basename(filePath);
  const accept = await page.evaluate((): string =>
    document.querySelector('input[type=file]')?.getAttribute("accept") ?? "");
  const ext = path.extname(filePath).toLowerCase();
  const dotTokens = accept.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((t) => t.startsWith("."));
  if (dotTokens.length && !dotTokens.includes(ext)) {
    throw new FlowError(
      `附件类型不在白名单（页面 input accept=${accept}）：${name}`, 2);
  }
  await page.setInputFiles("input[type=file]", filePath);
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2_000);
    const inBody = await page.evaluate((n: string): boolean =>
      (document.body?.innerText || "").includes(n), name);
    if (inBody) {
      log(`  已挂上附件：${name}`);
      return;
    }
  }
  throw new FlowError(`喂了文件但 20 秒内页面没出现文件名：${name}`);
}

// —— 改名（现版 rename() 平移：菜单真点、填值交 JS 防 React 句柄失效）——
async function currentTitle(page: Page, chatId: string): Promise<string | null> {
  const rows = await convAnchors(page);
  const hit = rows.find((r) => r.id === chatId);
  return hit ? hit.title : null;
}

export async function renameTo(
  page: Page, chatId: string, newTitle: string, mark: string, log: (m: string) => void
): Promise<boolean> {
  const state = await page.evaluate((id: string): string => {
    const a = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/a/chat/s/"]')]
      .find((e) => (e.getAttribute("href") || "").includes(id));
    if (!a) return "no-anchor";
    const b = a.querySelector("[role=button]");
    if (!b) return "no-button";
    (b as HTMLElement).click();
    return "menu-open";
  }, chatId);
  if (state !== "menu-open") {
    log(`  改名失败：打不开行菜单（${state}）`);
    return false;
  }
  await page.waitForTimeout(1_200);
  const item = "//div[contains(@class,'ds-dropdown-menu-option')][.//*[normalize-space(text())='重命名']]";
  if ((await clickXpathFirst(page, item)) !== "clicked") {
    log("  改名失败：菜单里没有「重命名」");
    return false;
  }
  await page.waitForTimeout(1_500);
  const old = await currentTitle(page, chatId);
  // 填值改用 Playwright 原生 fill + press：它内部就是用 native setter + input 事件骗 React，
  // 但会处理句柄失效与等待。手搓 evaluate 在这里踩过两次坑：XPath 前缀被当成比较表达式、
  // 以及 Firefox 的 "object is not, or is no longer, usable"（元素被 React 重渲染换掉）。
  const cands = page.locator("input");
  const total = await cands.count();
  let box: ReturnType<typeof cands.nth> | null = null;
  for (let i = 0; i < total; i++) {
    const c = cands.nth(i);
    if (!(await c.isVisible().catch(() => false))) continue;
    if (box === null) box = c; // 兜底候选：第一个可见输入框
    const v = await c.inputValue().catch(() => null);
    if (old !== null && v === old) { box = c; break; } // 值等于旧标题 = 就是它
  }
  if (box === null) {
    log("  改名失败：弹窗里没找到可见的输入框");
    return false;
  }
  await box.fill(newTitle);
  await box.press("Enter");
  await page.waitForTimeout(2_500);
  const after = await currentTitle(page, chatId);
  if (after === newTitle || (after && after.startsWith(mark))) {
    log(`  已改名：${old ?? "?"} → ${after}`);
    return true;
  }
  // DeepSeek 会截断过长标题，带上前缀就算成功（现版同款判定）
  log(`  改名没生效：现在叫「${after}」`);
  return false;
}

// —— 菜单项点击：JS 合成点击（React 委托可靠），绕开 locator 真点击的 hit-target 检查
//（菜单遮罩/React 重渲染会让它间歇性卡死——M4 实弹：演练成功过、复跑即超时）——
async function clickXpathFirst(page: Page, xpath: string): Promise<string> {
  return await page.evaluate((xp: string): string => {
    // 必须剥掉 Playwright 的 "xpath=" 前缀：整串喂给 document.evaluate 会被解析成
    // 「xpath = //div[...]」这个比较表达式（元素名与节点集比），返回布尔值，与请求的
    // FIRST_ORDERED_NODE_TYPE 类型不符 → "Result type mismatch"，改名就是这么挂的。
    const expr = xp.startsWith("xpath=") ? xp.slice(6) : xp;
    const el = document.evaluate(expr, document, null,
      XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement | null;
    if (!el) return "not-found";
    el.click();
    return "clicked";
  }, xpath);
}

// —— 会话归属与删除（现版 delete_conversation 平移：白名单 + 默认演练两道保护）——
// 归属判定在 src/agent.ts：内置全部 Agent 全名 + 历史遗留前缀 + 本次生效 mark。

export type RmResult = { title: string; id: string; deleted: boolean; dryRun: boolean };

export async function rmConversation(
  page: Page, keyword: string,
  opts: { apply: boolean; allowUnmarked: boolean },
  mark: string,
  log: (m: string) => void
): Promise<RmResult> {
  const allRows = await convAnchorsWait(page);
  const hits = keyword.length >= 32 && keyword.includes("-")
    ? allRows.filter((r) => r.id === keyword)
    : allRows.filter((r) => r.title.includes(keyword));
  if (hits.length && !opts.allowUnmarked && !hits.some((r) => isOwned(r.title, mark))) {
    throw new FlowError(
      `这几条没有 dsk 前缀，不敢删（万一是你自己的会话）：\n  ` +
      hits.map((r) => r.title).join("\n  ") +
      `\n可认前缀：${ownedPrefixes(mark).join(" ")}` +
      "\n确认要删再加 --any",
      2);
  }
  if (!hits.length) {
    throw new FlowError(
      `没有标题含「${keyword}」的会话。侧栏现有：\n  ` +
      allRows.slice(0, 20).map((r) => r.title).join("\n  "), 2);
  }
  if (hits.length > 1) {
    throw new FlowError(
      `「${keyword}」命中 ${hits.length} 条，太宽泛不敢删：\n  ` +
      hits.map((r) => `${r.title}  id=${r.id}`).join("\n  "), 2);
  }
  const row = hits[0];
  log(`目标会话：${row.title}  id=${row.id}`);
  // 打开行菜单：菜单项必须真点（合成事件不生效——现版经验）
  const state = await page.evaluate((id: string): string => {
    const a = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/a/chat/s/"]')]
      .find((e) => (e.getAttribute("href") || "").includes(id));
    if (!a) return "no-anchor";
    const b = a.querySelector("[role=button]");
    if (!b) return "no-button";
    (b as HTMLElement).click();
    return "menu-open";
  }, row.id);
  if (state !== "menu-open") throw new FlowError(`打不开这条会话的行菜单：${state}`);
  await page.waitForTimeout(1_500);
  // 菜单项点击全部走 JS 合成点击（与上方菜单打开同款），理由见 clickXpathFirst 注释。
  const delXp = "//div[contains(@class,'ds-dropdown-menu-option')][.//*[normalize-space(text())='删除']]";
  if ((await clickXpathFirst(page, delXp)) !== "clicked") throw new FlowError("菜单里没有「删除」项");
  await page.waitForTimeout(2_000);

  const BTN = "//*[self::button or @role='button' or contains(@class,'ds-button')]";
  if (!opts.apply) {
    const cancel = await clickXpathFirst(page,
      `${BTN}[normalize-space(text())='取消' or .//*[normalize-space(text())='取消']]`
    );
    log(cancel === "clicked"
      ? "演练模式：已打开确认框又点了「取消」，会话没删。要真删加 --yes"
      : "警告：没找到「取消」按钮，确认框可能还开着，请人工看一眼");
    return { title: row.title, id: row.id, deleted: false, dryRun: true };
  }
  const confirm = await clickXpathFirst(page,
    `${BTN}[normalize-space(text())='删除该对话' or .//*[normalize-space(text())='删除该对话']]`
  );
  if (confirm !== "clicked") {
    throw new FlowError("确认框里没找到「删除该对话」按钮，已停手，请人工看一眼");
  }
  await page.waitForTimeout(3_000);
  const gone = !(await convAnchors(page)).some((r) => r.id === row.id);
  log(`已删除：${row.title}（复查侧栏${gone ? "已无此条" : "仍能看到，可能列表没刷新"}）`);
  return { title: row.title, id: row.id, deleted: gone, dryRun: false };
}

// —— probe 诊断（T3.2）：读数健康度四项检查，跑在 keeper 进程内（复用活实例）——
export type ProbeReport = {
  convTitle: string;
  count: number; busy: boolean; bars: number;
  rawLen: number; strippedLen: number;
  deterministic: boolean; marker: string | null;
};

const PROBE_MARKERS = ["已思考", "我应该", "用户要求", "深度思考", "内容由 AI"];

export async function probeRead(
  page: Page, mark: string, log: (m: string) => void
): Promise<ProbeReport> {
  await gotoChat(page);
  await page.waitForTimeout(2_000);
  const rows = await convAnchorsWait(page);
  if (!rows.length) throw new FlowError("侧栏没有任何会话锚点：页面可能改版了");
  // probe 只诊断读数健康度，不挑归属：优先本 Agent 的连续会话，否则随便一条
  const home = rows.find((r) => r.title.startsWith(homeTitleFor(mark)))
    ?? rows.find((r) => isOwned(r.title, mark))
    ?? rows[0];
  await page.goto(`https://chat.deepseek.com/a/chat/s/${home.id}`, {
    waitUntil: "domcontentloaded", timeout: 60_000,
  });
  await page.waitForTimeout(3_000);
  const read = async () =>
    await page.evaluate(({ sel, banner }: { sel: string; banner: string }) => {
      const els = [...document.querySelectorAll(sel)];
      const busy = !!document.querySelector("[class*=stop-btn],[aria-label*=停止]");
      const node = els[els.length - 1] as HTMLElement | undefined;
      let raw = "", stripped = "";
      let bars = 0;
      if (node) {
        const barEls = [...node.querySelectorAll(banner)] as HTMLElement[];
        bars = barEls.length;
        raw = node.innerText || "";
        for (const b of barEls) b.style.setProperty("display", "none", "important");
        stripped = node.innerText || "";
        for (const b of barEls) b.style.removeProperty("display");
      }
      return { count: els.length, busy, bars, raw, stripped };
    }, { sel: ANSWER_SEL, banner: BANNER_SEL });
  const d1 = await read();
  const d2 = await read();
  const marker = PROBE_MARKERS.find((m) => d1.stripped.includes(m)) ?? null;
  const report: ProbeReport = {
    convTitle: home.title,
    count: d1.count, busy: d1.busy, bars: d1.bars,
    rawLen: d1.raw.length, strippedLen: d1.stripped.length,
    deterministic: d1.stripped === d2.stripped, marker,
  };
  if (marker) log(`警告：答案正文里出现了「${marker}」——页面结构变了，取词逻辑要重摸`);
  return report;
}

export { BUSY_SEL };
