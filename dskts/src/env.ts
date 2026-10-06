// 环境层（T1.3）：profile 目录、锁文件、keeper 生命周期、崩溃残留清扫、down 全序。
// 只该知道进程与文件系统；不该知道 DOM（规格第四节职责表）。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROFILE_DIR_NAME } from "./constants.ts";
import { tryConnect } from "./client.ts";

export function localRoot(): string {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}
export const profileDir = (): string => path.join(localRoot(), PROFILE_DIR_NAME);
export const lockPath = (): string => profileDir() + ".lock";
export const logPath = (): string => profileDir() + ".log";

export type Lock = { pid: number; since: string };

export function readLock(): Lock | null {
  try {
    const o = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as Lock;
    return typeof o.pid === "number" ? o : null;
  } catch {
    return null;
  }
}

export function writeLock(pid: number): void {
  fs.writeFileSync(lockPath(), JSON.stringify({ pid, since: new Date().toISOString() }));
}

export function clearLock(): void {
  try { fs.unlinkSync(lockPath()); } catch { /* 不存在就算清了 */ }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // 存在但无权发信号 = 活着
  }
}

/** 同步睡一会（env 层都是同步清理逻辑，不引 async） */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 按进程名 + 命令行精确杀：firefox（带本 profile 参数）与 node keeper。
 *  严禁裸字符串全局匹配——实弹教训：命令行里恰好带着 profile 名的 bash 祖先会被误杀。 */
export function killStaleByProfileName(log: (m: string) => void): void {
  try {
    const ps1 = fileURLToPath(new URL("./sweep.ps1", import.meta.url));
    const out = spawnSyncOut(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1,
       "-ProfileName", PROFILE_DIR_NAME, "-ExceptPid", String(process.pid)],
    );
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\|(.+)$/);
      if (!m) continue;
      try {
        process.kill(Number(m[1]));
        log(`  已清残留进程：${m[2]}（pid=${m[1]}）`);
      } catch { /* 已死就算清了 */ }
    }
  } catch { /* 枚举失败不致命，让端口竞态兜底 */ }
}

function spawnSyncOut(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { shell: false, windowsHide: true, encoding: "utf8" });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

/** 崩溃残留清扫：死 PID 锁接管 + 孤儿进程清除。仅在连不上 keeper 时调用。 */
export function sweepStale(log: (m: string) => void): void {
  const lock = readLock();
  if (lock && !pidAlive(lock.pid)) {
    log(`发现死 PID 锁（pid=${lock.pid}，启动于 ${lock.since}），接管`);
    clearLock();
  }
  killStaleByProfileName(log);
}

/** 拉起 keeper 并等到端口就绪；已在跑就直接复用连接（热连接路径）。 */
export async function ensureKeeper(
  log: (m: string) => void,
  waitMs = 20_000
): Promise<import("node:net").Socket> {
  const live = await tryConnect(2000);
  if (live) return live;
  sweepStale(log);
  const keeperTs = fileURLToPath(new URL("./keeper.ts", import.meta.url));
  // stdio 不能用 "ignore"：Node 自己打的错误输出（未捕获异常的堆栈等）会被丢进黑洞，
  // keeper 死起来就没痕迹可查。改成追加写进同一个 keeper 日志文件。
  const out = fs.openSync(logPath(), "a");
  const child = spawn(process.execPath, [keeperTs], {
    detached: true,
    stdio: ["ignore", out, out],
    // 告诉 keeper「你的 stderr 已经在日志文件里了」，别再写第二遍；
    // 同时这段环境也让 keeper 里未捕获异常的堆栈能落盘。
    env: { ...process.env, DSK_LOG_STDIO: "1" },
    windowsHide: true,
  });
  fs.closeSync(out);
  child.unref();
  // spawn 失败（权限、沙箱禁建子进程等）走的是异步 error 事件，不会同步抛。
  // 接住它并给出可操作的提示，别让调用方等满 20 秒再看一句"端口没就绪"。
  let spawnError: Error | null = null;
  child.on("error", (e: Error) => {
    spawnError = e;
    log(`拉起 keeper 失败：${e.message}`);
  });
  log(`已拉起 keeper（pid=${child.pid}），等端口就绪…`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (spawnError) {
      const e: Error = spawnError;
      throw new Error(
        `拉不起 keeper：${e.message}\n` +
        "  这个环境可能禁止创建子进程。先在系统终端里跑一次 dskts up，" +
        "或双击常驻启动脚本把 keeper 起起来——之后本命令会自动热连接它，" +
        "不再需要创建进程。用 dskts status 可以确认 keeper 在不在。"
      );
    }
    const s = await tryConnect(1500);
    if (s) return s;
    if (Date.now() > deadline) {
      throw new Error(`keeper 端口 ${Math.round(waitMs / 1000)}s 内没就绪；看日志 ${logPath()}`);
    }
  }
}

/** down 的兜底路径：连不上 keeper 时，杀干净进程再删目录。 */
export function downFallback(log: (m: string) => void): { profileDeleted: boolean; error?: string } {
  sweepStale(log);
  sleepSync(1000);
  const r = deleteProfileDir(log);
  return { profileDeleted: r.ok, error: r.error };
}

export function deleteProfileDir(log?: (m: string) => void): { ok: boolean; error?: string } {
  for (let i = 0; i < 3; i++) {
    try {
      fs.rmSync(profileDir(), { recursive: true, force: true });
      return { ok: true };
    } catch (e) {
      log?.(`  删 profile 目录失败（第 ${i + 1} 次）：${(e as Error).message}`);
      sleepSync(1000);
    }
  }
  return { ok: false, error: `profile 目录删不掉（文件仍被占用？）：${profileDir()}` };
}
