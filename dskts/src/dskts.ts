// dskts 入口（T1.7）：参数解析 + 三流契约——stdout 只有答案、stderr 过程日志、退出码三档
// （0 成功 / 1 运行错误含用法错，对齐旧 Python 版 SystemExit 习惯 / 2 前提不满足）。
const [maj] = process.versions.node.split(".").map(Number);
if (maj < 24) {
  console.error(
    `dskts 需要 Node >= 24（当前 ${process.versions.node}）：` +
    "type stripping 靠它免构建直接跑 .ts"
  );
  process.exit(1);
}

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_MAX_WAIT_S, EXIT_ERROR, EXIT_OK, EXIT_PREREQ, KEEPER_PORT, MAX_WAIT_S_CAP } from "./constants.ts";
import { resolveMark, type MarkDecision } from "./agent.ts";
import * as env from "./env.ts";
import { rpc, tryConnect } from "./client.ts";
import type { FrameResp } from "./frame.ts";
import type { AskResult } from "./askflow.ts";

function log(m: string): void {
  console.error(m);
}

/** 归属识别结果 → 一行 stderr 说明；显式指定和自动识别要能分辨出来 */
export function describeMark(d: MarkDecision): string {
  if (d.source === "cli") return `归属标记：${d.mark}（--mark 指定）`;
  if (d.source === "env") return `归属标记：${d.mark}（DSK_AGENT 声明）`;
  if (!d.hitVariable) {
    return `归属标记：${d.mark}（自动识别失败，落 unknown——用 --mark 或 DSK_AGENT 指定）`;
  }
  if (d.confidence === "weak") {
    return `归属标记：${d.mark}（按弱特征 ${d.hitVariable} 猜的，可能认错——想确凿就 --mark 指定）`;
  }
  return `归属标记：${d.mark}（自动识别：${d.hitVariable}）`;
}

type Args = {
  op: "up" | "down" | "status" | "chats" | "rm" | "whoami" | null; // null = 默认提问
  question: string;
  chat: string | null;
  out: string | null;
  mark: string | null;
  files: string[];
  maxWaitS: number;
  anyFlag: boolean;
  yesFlag: boolean;
  streamFlag: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    op: null, question: "", chat: null, out: null,
    mark: null, files: [], maxWaitS: DEFAULT_MAX_WAIT_S,
    anyFlag: false, yesFlag: false, streamFlag: false,
  };
  const SUBS = ["up", "down", "status", "chats", "rm", "whoami"];
  let rest = [...argv];
  if (rest.length && (SUBS as string[]).includes(rest[0])) {
    args.op = rest[0] as Args["op"];
    rest = rest.slice(1);
    if (rest.length && !rest[0].startsWith("--") && (args.op === "rm" || args.op === "chats")) {
      args.question = rest.shift()!; // chats/rm 的关键词沿用 question 字段
    }
  } else if (rest.length && !rest[0].startsWith("--")) {
    args.question = rest.shift()!;
  }
  while (rest.length) {
    const a = rest.shift()!;
    const needValue = (flag: string): string => {
      if (!rest.length) {
        log("有个选项缺了值：--out / --chat / --file / --mark / --max-wait 后面都要跟一个参数");
        process.exit(EXIT_ERROR);
      }
      return rest.shift()!;
    };
    if (a === "--chat") args.chat = needValue(a);
    else if (a === "--out") args.out = needValue(a);
    else if (a === "--mark") {
      const v = needValue(a).trim();
      if (!v) {
        log("--mark 不能是空的；想强制归属就写个名字，比如 --mark WorkBuddy");
        process.exit(EXIT_ERROR);
      }
      args.mark = v;
    }
    else if (a === "--file") args.files.push(needValue(a));
    else if (a === "--max-wait") {
      const v = needValue(a);
      const n = Number(v);
      if (!Number.isInteger(n)) {
        log("--max-wait 要秒数，比如 --max-wait 420");
        process.exit(EXIT_ERROR);
      }
      if (n <= 0) {
        log("--max-wait 要正的秒数");
        process.exit(EXIT_ERROR);
      }
      if (n > MAX_WAIT_S_CAP) {
        log(`--max-wait 上限 ${MAX_WAIT_S_CAP} 秒（再大就碰 Node 定时器 32 位溢出、会秒超时），本次按上限处理`);
        args.maxWaitS = MAX_WAIT_S_CAP;
      } else {
        args.maxWaitS = n;
      }
    } else if (a === "--any") args.anyFlag = true;
    else if (a === "--yes") args.yesFlag = true;
    else if (a === "--stream") args.streamFlag = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write(HELP + "\n");
      process.exit(EXIT_OK);
    } else if (a.startsWith("--")) {
      log(`不认识的参数：${a}（--help 看用法）`);
      process.exit(EXIT_ERROR);
    } else if (!args.question) {
      args.question = a; // 选项后面跟的位置参数 = 问题本身
    } else {
      log(`多余的位置参数：${a}`);
      process.exit(EXIT_ERROR);
    }
  }
  return args;
}

const HELP = `dskts — DeepSeek 网页版命令行（TS 版，M1）

  dskts "问题"                提问；stdout 只有答案
  dskts --chat 关键词 "问题"   指定续问（命中不唯一退 2 并列候选）
  dskts --out 文件 "问题"      答案同时落盘（与 stdout 逐字一致）
  dskts --max-wait 秒 "问题"   等待总上限（默认 ${DEFAULT_MAX_WAIT_S}，上限 ${MAX_WAIT_S_CAP}）
  dskts --file 附件 "问题"     挂附件（可重复；类型白名单=页面 input 的 accept）
  dskts --stream "问题"        边生成边打印（3 秒一拍增量）
  dskts up                    起实例；未登录则去窗口里登录（等 10 分钟）
  dskts down                  关实例并删除 profile 目录（含全部登录态）
  dskts status                实例/登录态/目录状态
  dskts whoami                这次会被记成哪个 Agent（归属标记怎么来的）
  dskts chats                 列出全部会话，每条标出归属
  dskts rm 关键词或会话id      删除会话；默认只演练，--yes 真删
                              没带已知前缀的拒绝，--any 越过

归属标记：新建的会话标题自动带「<Agent 名>｜」前缀，会话列表里一眼看出谁开的。
怎么认出调用方：--mark 指定 > DSK_AGENT 环境变量 > 自动识别环境变量特征 > unknown。
每个 Agent 有自己的默认会话（<Agent 名>｜连续会话），上下文互不串。

过程日志都在 stderr；退出码 0=成功 1=运行错误 2=前提不满足`;

async function readStdinQuestion(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** ask/up 期间把 keeper 日志增量转到本进程 stderr（规格：keeper 日志原样转发） */
function startTail(): () => void {
  let pos = 0;
  try { pos = fs.statSync(env.logPath()).size; } catch { /* 文件还没出现 */ }
  const timer = setInterval(() => {
    try {
      const s = fs.statSync(env.logPath());
      if (s.size > pos) {
        const fd = fs.openSync(env.logPath(), "r");
        const buf = Buffer.alloc(s.size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos);
        fs.closeSync(fd);
        pos = s.size;
        process.stderr.write(buf.toString("utf8"));
      } else if (s.size < pos) {
        pos = s.size;
      }
    } catch { /* 文件还没出现 */ }
  }, 500);
  return () => clearInterval(timer);
}

async function call<T>(
  op: string, params: unknown, timeoutMs: number,
  onProgress?: (data: unknown) => void
): Promise<FrameResp<T>> {
  const socket = await tryConnect(3_000);
  if (!socket) throw new Error(`连不上 keeper（127.0.0.1:${KEEPER_PORT}）`);
  return await rpc<T>(socket, op, params, timeoutMs, onProgress, env.readToken());
}

async function cmdAsk(args: Args): Promise<number> {
  let question = args.question.trim();
  if (!question) question = (await readStdinQuestion()).trim();
  if (!question) {
    log('用法：dskts "问题"（或把问题从 stdin 管进来）');
    return EXIT_ERROR;
  }
  const decided = resolveMark(args.mark);
  log(describeMark(decided));
  await env.ensureKeeper(log).then((boot) => boot.destroy());
  const login = await call<{ loggedIn: boolean }>("checkLogin", {}, 60_000);
  if (!login.ok) {
    log(`登录检查失败：${login.error}`);
    return login.code === 2 ? EXIT_PREREQ : EXIT_ERROR;
  }
  if (!login.data.loggedIn) {
    log("未登录：先跑 dskts up，去窗口里登录一次（登录态常驻 profile，之后免登录）");
    return EXIT_PREREQ;
  }
  const stopTail = startTail();
  let streamed = 0; // --stream 时已打到 stdout 的字数
  let resp: FrameResp<AskResult>;
  try {
    resp = await call<AskResult>(
      "ask",
      {
        question, chat: args.chat, maxWaitMs: args.maxWaitS * 1000,
        mark: decided.mark,
        files: args.files.map((f) => path.resolve(f)),
      },
      args.maxWaitS * 1000 + 180_000,
      args.streamFlag
        ? (data) => {
            const d = data as { type?: string; text?: string };
            if (d?.type === "delta" && typeof d.text === "string") {
              process.stdout.write(d.text);
              streamed += d.text.length;
            } else if (d?.type === "reset" && typeof d.text === "string") {
              process.stdout.write(`\n[dskts：输出重置]\n${d.text}`);
              streamed = d.text.length;
            }
          }
        : undefined
    );
  } finally {
    stopTail();
  }
  if (!resp.ok) {
    log(`这问没走完：${resp.error}`);
    return resp.code === 2 ? EXIT_PREREQ : EXIT_ERROR;
  }
  const r = resp.data;
  if (args.out) {
    fs.writeFileSync(args.out, r.answer + "\n", "utf8");
    log(`已存 ${args.out}`);
  }
  if (args.streamFlag) {
    const rest = r.answer.slice(streamed);
    if (rest) process.stdout.write(rest);
    process.stdout.write("\n");
  } else {
    process.stdout.write(r.answer + "\n");
  }
  if (r.truncated) {
    log("警告：到 --max-wait 上限还没判定停笔，答案可能被截断");
    return EXIT_ERROR;
  }
  return EXIT_OK;
}

async function cmdUp(): Promise<number> {
  const boot = await env.ensureKeeper(log);
  boot.destroy(); // 同 cmdAsk：探活连接用完即断，否则进程不退出
  const stopTail = startTail();
  let resp: FrameResp<{ url: string }>;
  try {
    resp = await call<{ url: string }>("up", {}, 11 * 60_000);
  } finally {
    stopTail();
  }
  if (!resp.ok) {
    log(`up 失败：${resp.error}`);
    return resp.code === 2 ? EXIT_PREREQ : EXIT_ERROR;
  }
  log(`已就绪（${resp.data.url}）。之后 dskts "问题" 直接问。`);
  return EXIT_OK;
}

async function cmdDown(): Promise<number> {
  const live = await tryConnect(2_000);
  if (live) {
    const resp = await rpc<{ profileDeleted: boolean }>(live, "down", {}, 60_000, undefined, env.readToken());
    if (resp.ok) {
      log(`已 down（profile 目录删除=${resp.data.profileDeleted}）`);
      return EXIT_OK;
    }
    log(`down 失败：${resp.error}`);
    return EXIT_ERROR;
  }
  const r = env.downFallback(log);
  if (r.profileDeleted) {
    log("已 down（兜底清扫：残留进程已清、目录已删）");
    return EXIT_OK;
  }
  log(`down 兜底没删干净：${r.error}`);
  return EXIT_ERROR;
}

async function cmdStatus(): Promise<number> {
  const live = await tryConnect(2_000);
  if (live) {
    const resp = await rpc<{ pid: number; browser: boolean; url: string | null; loggedIn: boolean }>(
      live, "status", {}, 15_000, undefined, env.readToken()
    );
    if (resp.ok) {
      const d = resp.data;
      log(`keeper：运行中（pid=${d.pid}）`);
      log(`浏览器：${d.browser ? "在" : "不在"}；已登录：${d.loggedIn ? "是" : "否"}`);
      log(`页面：${d.url ?? "无"}`);
      return EXIT_OK;
    }
    log(`status 失败：${resp.error}`);
    return EXIT_ERROR;
  }
  const lock = env.readLock();
  log("keeper：未运行");
  log(`profile 目录：${fs.existsSync(env.profileDir()) ? "在" : "不在"}（${env.profileDir()}）`);
  if (lock) {
    log(`锁文件：在（pid=${lock.pid}，进程${env.pidAlive(lock.pid) ? "活" : "已死——下次命令自动接管"}，启动于 ${lock.since}）`);
  } else {
    log("锁文件：无");
  }
  return EXIT_OK;
}

async function cmdChats(args: Args): Promise<number> {
  const decided = resolveMark(args.mark);
  const boot = await env.ensureKeeper(log);
  boot.destroy();
  const resp = await call<{ rows: { title: string; id: string; owner: string | null }[] }>(
    "chats", { mark: decided.mark }, 90_000
  );
  if (!resp.ok) {
    log(`chats 失败：${resp.error}`);
    return resp.code === 2 ? EXIT_PREREQ : EXIT_ERROR;
  }
  // 排序：本 Agent 的最前，其次别的 Agent 的，最后是无前缀（作者自己的）
  const rank = (owner: string | null): number =>
    owner === decided.mark ? 0 : owner ? 1 : 2;
  const rows = [...resp.data.rows].sort((a, b) => rank(a.owner) - rank(b.owner));
  const width = Math.max(6, ...rows.map((r) => (r.owner ?? "—").length));
  for (const r of rows) {
    const lead = r.owner === decided.mark ? "*" : " ";
    process.stdout.write(
      `${lead}${(r.owner ?? "—").padEnd(width)}  ${r.title}  id=${r.id}\n`
    );
  }
  if (!rows.length) log("侧栏没有任何会话（或没渲染出来——再跑一次看看）");
  log(`* = 本 Agent（${decided.mark}）的会话；— = 没有前缀，作者自己的`);
  return EXIT_OK;
}

async function cmdWhoami(args: Args): Promise<number> {
  const d = resolveMark(args.mark);
  process.stdout.write(`${d.mark}\n`);
  log(describeMark(d));
  log(`Agent 名：${d.agent}`);
  log(`默认会话：${d.mark}连续会话`);
  return EXIT_OK;
}

async function cmdRm(args: Args): Promise<number> {
  const kw = args.question.trim();
  if (!kw) {
    log("用法：dskts rm 关键词或会话id [--yes 真删] [--any 越过前缀白名单]");
    return EXIT_ERROR;
  }
  if (kw === "连续会话" && !args.anyFlag) {
    log("「连续会话」是默认问答会话，rm 拒绝；要删请用完整标题或会话 id");
    return EXIT_PREREQ;
  }
  const decided = resolveMark(args.mark);
  const boot = await env.ensureKeeper(log);
  boot.destroy();
  const stopTail = startTail();
  let resp: FrameResp<{ title: string; id: string; deleted: boolean; dryRun: boolean }>;
  try {
    resp = await call<{ title: string; id: string; deleted: boolean; dryRun: boolean }>(
      "rm", { keyword: kw, yes: args.yesFlag, any: args.anyFlag, mark: decided.mark }, 120_000
    );
  } finally {
    stopTail();
  }
  if (!resp.ok) {
    log(`rm 拒绝：${resp.error}`);
    return resp.code === 2 ? EXIT_PREREQ : EXIT_ERROR;
  }
  const r = resp.data;
  if (r.dryRun) {
    log(`演练完成，未删除（${r.title}）。确认就加 --yes`);
  } else if (r.deleted) {
    log(`已删除：${r.title}`);
  } else {
    log(`删除后复查未见生效：${r.title}（可能列表没刷新）`);
    return EXIT_ERROR;
  }
  return EXIT_OK;
}

async function main(argv: string[]): Promise<number> {
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP + "\n");
    return EXIT_OK;
  }
  const args = parseArgs(argv);
  if (!args.op && !args.question) {
    // 无参数也不是子命令：等 stdin（管道用法），ctrl+C 可退
    return await cmdAsk(args);
  }
  switch (args.op) {
    case "up": return await cmdUp();
    case "down": return await cmdDown();
    case "status": return await cmdStatus();
    case "chats": return await cmdChats(args);
    case "rm": return await cmdRm(args);
    case "whoami": return await cmdWhoami(args);
    default: return await cmdAsk(args);
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((exc: unknown) => {
  log(`dskts 出错：${(exc as Error).message ?? exc}`);
  return EXIT_ERROR;
});
