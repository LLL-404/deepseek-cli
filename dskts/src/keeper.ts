// keeper（T1.3/T1.7）：常驻实例进程，等价现版「Firefox 实例」的角色（规格 D7）。
// 持有 Playwright persistent context；监听 127.0.0.1:3928；命令串行，忙时立即回 busy。
// 启动顺序：listen 成功 → 写锁 → 服务；端口被占 = 已有 keeper，静默退出。
import type { BrowserContext, Page } from "playwright";
import * as fs from "node:fs";
import * as net from "node:net";
import { firefox } from "playwright";
import {
  CHAT_URL, KEEPER_PORT, PROFILE_DIR_NAME,
} from "./constants.ts";
import { clearLock, logPath, profileDir, writeLock } from "./env.ts";
import { createFrameDecoder, encodeFrame, type Frame, type FrameResp } from "./frame.ts";
import { ownerOf } from "./agent.ts";
import { askFlow, type AskParams, type AskResult } from "./askflow.ts";
import * as ops from "./pageops.ts";
import { FlowError } from "./pageops.ts";

// env.ts 拉起本进程时会把 stdio 重定向进 keeper 日志文件，并注入 DSK_LOG_STDIO=1；
// 此时 console.error 已经落在同一个文件里，再 appendFileSync 就是每行两遍。
// 直接手起 node keeper.ts（没有这个标记）时，两边都写，痕迹不丢。
const STDIO_TO_FILE = process.env.DSK_LOG_STDIO === "1";

function log(m: string): void {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.error(line);
  if (STDIO_TO_FILE) return;
  try { fs.appendFileSync(logPath(), line + "\n"); } catch { /* 日志失败不致命 */ }
}

// —— dying 埋点（2026-10-06 加）——
// keeper 此前会自己消失且日志里什么都不留，原因是 spawn 用了 stdio:"ignore"，
// Node 自己的错误输出被丢进黑洞，keeper 里又没有任何退出埋点。这里把每条退出路径
// 都记下来。判读：日志里出现 [dying] = 它自己退的（能拿到原因）；什么都没出现
// = 被外部强杀（Windows 的 TerminateProcess 不触发任何 Node 事件）。
const BOOT_AT = Date.now();
function noteExit(reason: string, extra = ""): void {
  const up = Math.round((Date.now() - BOOT_AT) / 1000);
  log(`[dying] ${reason} ${extra} uptime=${up}s ppid=${process.ppid} rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
}
process.on("uncaughtException", (e: unknown) => {
  noteExit("uncaughtException", String((e as Error)?.stack ?? e));
  process.exit(1);
});
process.on("unhandledRejection", (e: unknown) => {
  noteExit("unhandledRejection", String((e as Error)?.stack ?? e));
});
process.on("SIGTERM", () => { noteExit("SIGTERM"); process.exit(143); });
process.on("SIGINT", () => { noteExit("SIGINT"); process.exit(130); });
process.on("exit", (code: number) => { noteExit("exit", `code=${code}`); });

let context: BrowserContext | null = null;
let page: Page | null = null;
let busy = false;

async function ensureContext(): Promise<Page> {
  if (context && page) {
    try {
      if (!page.isClosed()) return page;
    } catch { /* 老句柄失效，重建 */ }
  }
  log("启动浏览器（persistent context，有头）…");
  context = await firefox.launchPersistentContext(profileDir(), {
    headless: false,
    viewport: null,
    locale: "zh-CN", // Gate F-4：钉死中文界面，中文选择器才成立
    args: ["--start-maximized"],
  });
  context.on("close", () => {
    log("浏览器断开（窗口被关或崩溃）");
    context = null;
    page = null;
  });
  page = context.pages()[0] ?? (await context.newPage());
  return page;
}

async function opUp(): Promise<{ url: string }> {
  const p = await ensureContext();
  await ops.gotoChat(p);
  if (!(await ops.isLoggedIn(p))) {
    log("请在打开的 Firefox 窗口里登录 DeepSeek（手机号+验证码）；最长等 10 分钟。");
    log("登录过程中若有验证码/风控墙，记录现象——这是安全判据。");
    await ops.waitTextarea(p, 10 * 60_000);
    log("检测到输入框，判定已登录。");
  }
  return { url: p.url() };
}

async function opStatus(): Promise<{
  pid: number; browser: boolean; url: string | null; loggedIn: boolean;
}> {
  return {
    pid: process.pid,
    browser: !!context,
    url: page && !page.isClosed() ? page.url() : null,
    loggedIn: page && !page.isClosed() ? await ops.isLoggedIn(page, 3_000) : false,
  };
}

async function opAsk(params: unknown, emit?: (data: unknown) => void): Promise<AskResult> {
  const p = params as AskParams;
  if (!p?.question) throw new FlowError("ask 缺 question");
  const page = await ensureContext();
  return await askFlow(page, { ...p, emit }, log);
}

async function opCheckLogin(): Promise<{ loggedIn: boolean; url: string }> {
  const p = await ensureContext();
  await ops.gotoChat(p);
  await p.waitForTimeout(2_000);
  return { loggedIn: await ops.isLoggedIn(p), url: p.url() };
}

async function opDown(): Promise<{ profileDeleted: boolean }> {
  log("down：关闭浏览器并删除 profile 目录（含全部登录态）");
  try { await context?.close(); } catch { /* 已死就算了 */ }
  context = null;
  page = null;
  clearLock();
  let profileDeleted = false;
  for (let i = 0; i < 3 && !profileDeleted; i++) {
    try {
      fs.rmSync(profileDir(), { recursive: true, force: true });
      profileDeleted = true;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  log(profileDeleted ? "profile 目录已删除" : "警告：profile 目录没删掉（文件被占用？）");
  return { profileDeleted };
}

/** 从帧参数里取本次调用的归属前缀；keeper 自己不认识 Agent——那是 CLI 侧的事 */
function markOf(params: unknown): string {
  return ((params as { mark?: string } | null)?.mark ?? "").trim();
}

async function opChats(params: unknown): Promise<{
  rows: { title: string; id: string; owner: string | null }[];
}> {
  const mark = markOf(params);
  const p = await ensureContext();
  await ops.gotoChat(p);
  const rows = await ops.convAnchorsWait(p);
  // owner = 命中哪个已知前缀；null = 没前缀（作者自己的会话）
  return { rows: rows.map((r) => ({ ...r, owner: ownerOf(r.title, mark) })) };
}

type RmParams = { keyword?: string; yes?: boolean; any?: boolean };

async function opRm(params: unknown): Promise<ops.RmResult> {
  const p0 = (params ?? {}) as RmParams;
  const p = await ensureContext();
  await ops.gotoChat(p);
  await p.waitForTimeout(1_500);
  return await ops.rmConversation(
    p, p0.keyword ?? "",
    { apply: !!p0.yes, allowUnmarked: !!p0.any },
    markOf(params),
    log
  );
}

async function opProbe(params: unknown): Promise<ops.ProbeReport> {
  const p = await ensureContext();
  return await ops.probeRead(p, markOf(params), log);
}

async function opDiag(): Promise<unknown> {
  const p = await ensureContext();
  await ops.gotoChat(p);
  await p.waitForTimeout(2_500);
  return await p.evaluate(() => {
    const ta = [...document.querySelectorAll("textarea")].pop();
    if (!ta) return { err: "no-textarea" };
    const r = ta.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    const describe = (e: Element | null): string =>
      e ? `${e.tagName}.${String(e.className).slice(0, 80)}` : "null";
    const overlays = [...document.querySelectorAll(
      "[role=dialog],[class*=modal],[class*=popover],[class*=toast],[class*=mask],[class*=overlay],[class*=guide],[class*=banner],[class*=drawer]"
    )].map((e) => `${e.tagName}.${String(e.className).slice(0, 60)}|${(e.textContent || "").trim().slice(0, 50)}`);
    return {
      point: { x: Math.round(cx), y: Math.round(cy) },
      topAt: describe(top),
      topIsTextarea: top === ta || ta.contains(top),
      overlays: overlays.slice(0, 8),
    };
  });
}

type Handler = (params: unknown, emit: (data: unknown) => void) => Promise<unknown>;
const handlers: Record<string, Handler> = {
  ping: async () => ({ pid: process.pid }),
  status: () => opStatus(),
  up: () => opUp(),
  checkLogin: () => opCheckLogin(),
  ask: (p, emit) => opAsk(p, emit),
  chats: (p) => opChats(p),
  rm: (p) => opRm(p),
  probe: (p) => opProbe(p),
  diag: () => opDiag(),
  down: () => opDown(),
};

const server = net.createServer((socket: net.Socket) => {
  const decoder = createFrameDecoder((obj: unknown) => {
    const frame = obj as Frame;
    if (busy) {
      socket.write(encodeFrame({
        ok: false, error: "busy：上一条命令还在处理", code: 2,
      } satisfies FrameResp));
      return;
    }
    const handler = handlers[frame.op];
    if (!handler) {
      socket.write(encodeFrame({ ok: false, error: `未知命令 ${frame.op}`, code: 1 } satisfies FrameResp));
      return;
    }
    busy = true;
    log(`→ ${frame.op}`);
    handler(frame.params, (data: unknown) => {
      socket.write(encodeFrame({ ok: true, data, progress: true } satisfies FrameResp));
    })
      .then(
        (data) => socket.write(encodeFrame({ ok: true, data } satisfies FrameResp)),
        (exc: unknown) => {
          const err = exc as { message?: string; code?: number };
          socket.write(encodeFrame({
            ok: false, error: err?.message ?? String(exc), code: err?.code === 2 ? 2 : 1,
          } satisfies FrameResp));
        },
      )
      .finally(() => {
        busy = false;
        if (frame.op === "down") setTimeout(() => process.exit(0), 200);
      });
  });
  socket.on("data", (c: Buffer) => decoder.push(c));
  socket.on("error", () => { /* 客户端断开不致命 */ });
});

server.on("error", (e: Error) => {
  log(`端口 ${KEEPER_PORT} 监听失败（${e.message}）——多半已有 keeper 在跑，本次退出`);
  process.exit(0);
});

server.listen(KEEPER_PORT, "127.0.0.1", () => {
  writeLock(process.pid);
  log(`keeper 就绪：127.0.0.1:${KEEPER_PORT} pid=${process.pid} profile=${profileDir()} ` +
      `（${PROFILE_DIR_NAME}）`);
});
