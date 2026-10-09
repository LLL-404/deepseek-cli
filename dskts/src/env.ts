// 环境层（T1.3）：profile 目录、锁文件、keeper 生命周期、崩溃残留清扫、down 全序。
// 只该知道进程与文件系统；不该知道 DOM（规格第四节职责表）。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROFILE_DIR_NAME } from "./constants.ts";
import { tryConnect } from "./client.ts";

export function localRoot(): string {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}
export const profileDir = (): string => path.join(localRoot(), PROFILE_DIR_NAME);
export const lockPath = (): string => profileDir() + ".lock";
export const logPath = (): string => profileDir() + ".log";

/** 会话 token 文件（S2，2026-10-06 加）：keeper 每次启动生成随机 token 写这里，
 *  CLI 每帧带上、keeper 校验。文件落在 %LOCALAPPDATA%（用户私有 ACL）——回环 TCP
 *  对同机所有账户开放，文件 ACL 不开放，访问边界因此从「全机」收到「本用户」。 */
export const tokenPath = (): string => profileDir() + ".token";

export function writeToken(token: string): void {
  fs.writeFileSync(tokenPath(), token, { encoding: "utf8", mode: 0o600 });
}

/** 读不到就返回 null：CLI 会发空 token，keeper 明确拒绝并提示重启 */
export function readToken(): string | null {
  try {
    const t = fs.readFileSync(tokenPath(), "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

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
 *  严禁裸字符串全局匹配——实弹教训：命令行里恰好带着 profile 名的 bash 祖先会被误杀。
 *  keeper 认 `--dsk-keeper` 标记（S4，2026-10-06）：两个启动路径都会带上它；
 *  旧的 `*keeper.ts*` 子串匹配已去掉（会误杀其它项目里恰好同名的文件）。 */
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
  // timeout（P2）：PowerShell 卡死（WMI 服务异常等）时不要拖着 CLI 一起无限等。
  const r = spawnSync(cmd, args, {
    shell: false, windowsHide: true, encoding: "utf8", timeout: 20_000,
  });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

/** 清扫进程前先问：有没有一个**还活着的** keeper 正占着这个 profile？
 *  keeper 在 listen 回调里写锁（keeper.ts），所以端口未就绪的那几秒里 pid 已经活了。
 *  实测（2026-10-09）：第二条 CLI 命令连不上就无条件杀，结果杀掉了正在启动的 keeper
 *  和它的火狐，Playwright 连接被重置成 ECONNRESET，parent.lock 留在原地。 */
export function shouldSweepProcesses(lockExists: boolean, lockPidAlive: boolean): boolean {
  return !(lockExists && lockPidAlive);
}

/** 崩溃残留清扫：死 PID 锁接管 + 孤儿进程清除。仅在连不上 keeper 时调用。 */
export function sweepStale(log: (m: string) => void): void {
  const lock = readLock();
  const alive = lock ? pidAlive(lock.pid) : false;
  if (lock && !alive) {
    log(`发现死 PID 锁（pid=${lock.pid}，启动于 ${lock.since}），接管`);
    clearLock();
  }
  if (!shouldSweepProcesses(!!lock, alive)) {
    // 锁里的 pid 还活着：那多半是个正在冷启动的 keeper（火狐要十几秒）。
    // 这时候杀 = 把它杀在半路上，后面的命令全都撞它。
    log(`  锁里的 pid=${lock?.pid} 还活着但端口没就绪，多半在冷启动；不清扫进程，继续等`);
    return;
  }
  killStaleByProfileName(log);
}

/** explorer 代启用的引导文件放哪。必须纯 ASCII 路径——见 launchKeeperViaExplorer 注释。 */
export const bootDir = (): string => path.join(localRoot(), "dsk-keeper-boot");

/**
 * 路线一：请 explorer.exe 代为启动 keeper（等价于「双击一个 .cmd」）。
 *
 * 为什么要绕这一下：宿主命令执行器会在命令结束时按**快照**清理「本次命令产生的
 * 所有进程」——detached 与托孤都挡不住（2026-10-06 实测：孤儿进程同样被杀）。
 * 而 explorer 启动的进程不属于任何命令的进程树，宿主扫不到它，能真正常驻
 * （同日实测：同法启动的标记进程跨命令存活 ≥12s 且持续，常规 spawn 的同时刻已死）。
 *
 * 代价与前提：
 *   - 会弹一个控制台窗口（它同时是 keeper 的日志窗和「关掉即停」的开关）；
 *   - 本地路径必须纯 ASCII：cmd.exe 按 OEM 代码页解析 .cmd 内容，中文路径写进去
 *     会乱码。任一环节含非 ASCII 就放弃本路线，退回常规 spawn。
 *
 * 禁用本路线：环境变量 DSKTS_NO_EXPLORER=1。
 */
function launchKeeperViaExplorer(log: (m: string) => void): boolean {
  const keeperTs = fileURLToPath(new URL("./keeper.ts", import.meta.url));
  const nodeExe = process.execPath;
  const dir = bootDir();
  const bootJs = path.join(dir, "keeper-boot.mjs");
  const startCmd = path.join(dir, "keeper-start.cmd");
  const asciiOnly = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);
  // cmd 里 `%` 是变量展开符，写进 .cmd 的路径必须把 % 转成 %%
  const escCmdPct = (s: string): string => s.replace(/%/g, "%%");
  // 只有「写进 .cmd 的」两样需要纯 ASCII：node.exe 路径和引导目录。
  // keeper.ts 的真身路径不需要——它只出现在 boot.mjs 里，而 boot.mjs 是 Node 按
  // UTF-8 读的，路径已百分号编码成 file URL。
  if (!asciiOnly(nodeExe) || !asciiOnly(bootJs) || !asciiOnly(startCmd)) {
    log("  explorer 代启跳过：node 路径或引导目录含非 ASCII 字符（cmd 解析不了）");
    return false;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    // boot.mjs 由 Node 读（按 UTF-8），真身路径编码成 file URL，内容因此仍是纯 ASCII
    fs.writeFileSync(
      bootJs,
      "// 自动生成，别手改——dskts 用它把 keeper 从 explorer 手里拉起来。\n" +
      "// 内容保持纯 ASCII：keeper 真身路径已百分号编码进下面的 file URL。\n" +
      `await import(${JSON.stringify(pathToFileURL(keeperTs).href)});\n`,
      "utf8"
    );
    // .cmd 内容必须纯 ASCII，所以提示语用英文（中文会乱码）。
    // 不加 chcp：控制台默认代码页即可，keeper 日志里的中文由 Node 以 UTF-8 写文件。
    fs.writeFileSync(
      startCmd,
      [
        "@echo off",
        "title dskts keeper - close this window to stop",
        // `%` 必须转义成 `%%`（S6）：路径里万一带 %（用户名含 %、自定义安装位置），
        // cmd 会把 %xx% 当变量展开。--dsk-keeper 是进程标记，sweep 按它精确认 keeper（S4）。
        `"${escCmdPct(nodeExe)}" "${escCmdPct(bootJs)}" --dsk-keeper`,
        "",
      ].join("\r\n"),
      "ascii"
    );
    const c = spawn("explorer.exe", [startCmd], { detached: true, stdio: "ignore", windowsHide: true });
    c.unref();
    log("  已请 explorer 代启 keeper（会弹出一个控制台窗口；关掉它就等于停掉 keeper）");
    return true;
  } catch (e) {
    log(`  explorer 代启失败（${(e as Error).message}），改走常规 spawn`);
    return false;
  }
}

/** 路线二：常规直接拉起。非 Windows、或 explorer 路线走不通时用。 */
function spawnKeeperDirect(log: (m: string) => void, onError: (e: Error) => void): void {
  const keeperTs = fileURLToPath(new URL("./keeper.ts", import.meta.url));
  // stdio 不能用 "ignore"：Node 自己打的错误输出（未捕获异常的堆栈等）会被丢进黑洞，
  // keeper 死起来就没痕迹可查。改成追加写进同一个 keeper 日志文件。
  const out = fs.openSync(logPath(), "a");
  const child = spawn(process.execPath, [keeperTs, "--dsk-keeper"], {
    detached: true,
    stdio: ["ignore", out, out],
    // 告诉 keeper「你的 stderr 已经在日志文件里了」，别再写第二遍；
    // 同时这段环境也让 keeper 里未捕获异常的堆栈能落盘。
    // --dsk-keeper 是进程标记：sweep.ps1 只按它清残留（S4），keeper.ts 自己不解析参数。
    env: { ...process.env, DSK_LOG_STDIO: "1" },
    windowsHide: true,
  });
  fs.closeSync(out);
  child.unref();
  // spawn 失败（权限、沙箱禁建子进程等）走的是异步 error 事件，不会同步抛。
  child.on("error", (e: Error) => {
    log(`拉起 keeper 失败：${e.message}`);
    onError(e);
  });
  log(`已拉起 keeper（pid=${child.pid}），等端口就绪…`);
}

/** 拉起 keeper 并等到端口就绪；已在跑就直接复用连接（热连接路径）。 */
export async function ensureKeeper(
  log: (m: string) => void,
  waitMs = 20_000
): Promise<import("node:net").Socket> {
  const live = await tryConnect(2000);
  if (live) return live;
  sweepStale(log);

  let spawnError: Error | null = null;
  const viaExplorer =
    process.platform === "win32" &&
    process.env.DSKTS_NO_EXPLORER !== "1" &&
    launchKeeperViaExplorer(log);
  if (!viaExplorer) {
    spawnKeeperDirect(log, (e) => { spawnError = e; });
  }

  // explorer「假成功」兜底（A2，2026-10-06）：explorer 的 spawn 不抛但实际没起来时
  // （被拦/被策略吃掉），干等 20 秒只会得到一句超时。等 6 秒端口还没就绪就补一次常规
  // spawn。端口独占保证不会出现两个 keeper——后到的那个 listen 失败会静默退出。
  let directTried = !viaExplorer;
  const explorerFallbackAt = Date.now() + 6_000;

  const deadline = Date.now() + waitMs;
  for (;;) {
    if (spawnError) {
      const e: Error = spawnError;
      throw new Error(
        `拉不起 keeper：${e.message}\n` +
        "  这个环境禁止创建子进程。请先在系统终端里跑一次 dskts up 把 keeper 起起来，" +
        "之后的命令会自动热连接它，不再需要创建进程。dskts status 可确认 keeper 在不在。"
      );
    }
    const s = await tryConnect(1500);
    if (s) return s;
    if (!directTried && Date.now() > explorerFallbackAt) {
      // 兜底 spawn 失败不再抛硬错：explorer 那条路可能只是慢，继续等到 deadline 为止
      log("  explorer 代启 6 秒还没就绪，补一次直接拉起（兜底）…");
      spawnKeeperDirect(log, (e) => { log(`  兜底直接拉起也失败：${e.message}`); });
      directTried = true;
    }
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
