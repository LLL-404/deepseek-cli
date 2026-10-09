// 一次性诊断件：绕开 keeper/CLI，直接用 Playwright 起这个 profile。
// 目的只有一个——看「陈旧 parent.lock 在不在」时启动分别是什么结果，以及进程是自己抛错还是被人杀。
import { firefox } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const dir = path.join(process.env.LOCALAPPDATA, "dsk-ffprofile");
const lock = path.join(dir, "parent.lock");
console.log(`parent.lock 在吗：${fs.existsSync(lock)}`);
const t0 = Date.now();
const at = (s) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
try {
  const ctx = await firefox.launchPersistentContext(dir, {
    headless: false, viewport: null, locale: "zh-CN",
    args: ["--start-maximized"], timeout: 60_000,
  });
  at(`启动成功，pages=${ctx.pages().length}`);
  // KEEP_S=N：让浏览器多活 N 秒，用来当「只探不杀」的靶子（不传就是起来就关掉）
  const keep = Number(process.env.KEEP_S || 0);
  if (keep > 0) {
    at(`按要求保持打开 ${keep}s（父 node pid=${process.pid}）`);
    await new Promise((r) => setTimeout(r, keep * 1000));
  }
  await ctx.close();
  at("已关闭");
} catch (e) {
  at(`THREW: ${String(e && e.message).split("\n")[0]}`);
}
at("脚本走到末尾，进程还在");
