// Q7 黑洞诊断探针（一次性）：「用 Python 写一个判断质数的函数」三轮 Gate 同题全败，
// 提交被接受（输入框清空）但 300 秒无任何新回合。本探针逐拍转储页面状态，
// 并只读观测页面自己发出的 completion 网络响应（不读取、不伪造、不重放——硬规则允许观测）。
import { firefox } from "playwright";
import os from "node:os";
import path from "node:path";

const CHAT_URL = "https://chat.deepseek.com/";
const ANSWER_SEL = ".ds-assistant-message-main-content";
const PROFILE_DIR = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "dsk-ffprofile"
);
const log = (...a: unknown[]) => console.error(...a);

async function main(): Promise<number> {
  const context = await firefox.launchPersistentContext(PROFILE_DIR, {
    headless: false, viewport: null, locale: "zh-CN", args: ["--start-maximized"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    page.on("response", (r) => {
      const u = r.url();
      if (u.includes("completion") || u.includes("chat")) {
        log(`[net] ${r.status()} ${u.slice(0, 110)}`);
      }
    });
    page.on("requestfailed", (r) => {
      log(`[net-fail] ${r.failure()?.errorText ?? "?"} ${r.url().slice(0, 110)}`);
    });
    await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("textarea", { timeout: 120_000 });
    await page.waitForTimeout(3000);
    const q = "用 Python 写一个判断质数的函数";
    const ta = page.locator("textarea").last();
    await ta.fill(q);
    await ta.press("Enter");
    await page.waitForTimeout(3000);
    log(`回车后输入框长度：${await ta.inputValue().then(v => v.length).catch(() => -1)}（0=已被清空）`);
    log(`开始 240 秒逐拍观察（URL：${page.url()}）……`);
    for (let t = 5; t <= 240; t += 5) {
      await page.waitForTimeout(5000);
      const s = await page.evaluate((sel: string): string => {
        const els = [...document.querySelectorAll(sel)];
        const busy = !!document.querySelector("[class*=stop-btn],[aria-label*=停止]");
        const think = document.querySelectorAll(".ds-think-content").length;
        const popups = [...document.querySelectorAll(
          "[role=dialog],[class*=toast],[class*=modal],[class*=popover]"
        )].map(e => (e.textContent || "").trim().slice(0, 80)).filter(Boolean);
        const ta2 = document.querySelector("textarea");
        const last = els.length
          ? (els[els.length - 1] as HTMLElement).innerText || ""
          : "";
        return JSON.stringify({ count: els.length, busy, think, popups,
          taLen: ta2 ? ta2.value.length : -1, lastLen: last.length,
          lastHead: last.slice(0, 40) });
      }, ANSWER_SEL);
      log(`t=${String(t).padStart(3)}s ${s}`);
    }
    const tail = await page.evaluate(() => (document.body.innerText || "").slice(-600));
    log("=== 页面正文末尾 600 字 ===");
    log(tail);
    return 0;
  } finally {
    await context.close().catch(() => {});
  }
}

process.exitCode = await main();
