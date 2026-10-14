// probe 诊断（T3.2）：读数健康度四项检查的薄客户端。诊断本体跑在 keeper 里
// （复用活实例——probe 自己起 persistent context 会撞 Firefox 单实例，探针首跑即踩）。
// 用法：node tools/probe.ts
import * as env from "../src/env.ts";
import { tryConnect, rpc } from "../src/client.ts";
import { TOKEN_RETRY, TOKEN_RETRY_GAP_MS, COLD_LAUNCH_BUDGET_MS } from "../src/constants.ts";
import type { FrameResp } from "../src/frame.ts";
import type { ProbeReport } from "../src/pageops.ts";

const log = (...a: unknown[]) => console.error(...a);

async function call<T>(op: string, timeoutMs: number): Promise<FrameResp<T>> {
  // 冷启动竞态（dskts.ts call 同款重试）：keeper 端口就绪与 token 落盘之间有几毫秒
  // 窗口，第一帧会被拒——重读 token 再发，而不是让诊断误报一次失败。
  for (let attempt = 0; ; attempt++) {
    const socket = await tryConnect(3_000);
    if (!socket) throw new Error("连不上 keeper（先跑 node src/dskts.ts up）");
    const resp = await rpc<T>(socket, op, {}, timeoutMs, undefined, env.readToken());
    const tokenRefused = !resp.ok && resp.error.startsWith("unauthorized");
    if (!tokenRefused || attempt >= TOKEN_RETRY) return resp;
    log(`keeper 刚起、token 还没落盘，${TOKEN_RETRY_GAP_MS}ms 后重读重试（${attempt + 1}/${TOKEN_RETRY}）…`);
    await new Promise((r) => setTimeout(r, TOKEN_RETRY_GAP_MS));
  }
}

process.exitCode = await (async (): Promise<number> => {
  try {
    // 探活连接用完即断（同 dskts.ts cmdUp）：不断的话 socket 常驻，报告打印完进程也不退出
    await env.ensureKeeper(log).then((boot) => boot.destroy());
    // probe 总可能触发浏览器冷启动（keeper 的 ensureContext 会补起），超时用冷启动预算
    const resp = await call<ProbeReport>("probe", COLD_LAUNCH_BUDGET_MS);
    if (!resp.ok) {
      log(`probe 失败：${resp.error}`);
      return resp.code === 2 ? 2 : 1; // 前提不满足（未登录等）退 2，对齐 CLI 退出码契约
    }
    const d = resp.data;
    log(`会话：${d.convTitle}`);
    log(`正文容器 ${d.count} 条，生成中=${d.busy}，最后一条里有 ${d.bars} 个代码块横幅`);
    log(`隐藏横幅前 ${d.rawLen} 字 -> 之后 ${d.strippedLen} 字` +
      (d.bars > 0 && d.rawLen === d.strippedLen ? "（警告：横幅没隐掉？）" : ""));
    log(`两次读数${d.deterministic ? "一致（确定性 OK）" : "不一致（警告：读数不确定，judge 的落地判定会被干扰）"}`);
    if (d.marker) {
      log(`警告：答案正文里出现了「${d.marker}」——页面结构变了，取词逻辑要重摸`);
      return 1;
    }
    log("答案正文里没有任何思考/页脚标记（结构健康）");
    return 0;
  } catch (exc) {
    log(`probe 出错：${(exc as Error).message}`);
    return 1;
  }
})();
