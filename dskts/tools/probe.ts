// probe 诊断（T3.2）：读数健康度四项检查的薄客户端。诊断本体跑在 keeper 里
// （复用活实例——probe 自己起 persistent context 会撞 Firefox 单实例，探针首跑即踩）。
// 用法：node tools/probe.ts
import * as env from "../src/env.ts";
import { tryConnect, rpc } from "../src/client.ts";
import type { FrameResp } from "../src/frame.ts";
import type { ProbeReport } from "../src/pageops.ts";

const log = (...a: unknown[]) => console.error(...a);

async function call<T>(op: string, timeoutMs: number): Promise<FrameResp<T>> {
  const socket = await tryConnect(3_000);
  if (!socket) throw new Error("连不上 keeper（先跑 node src/dskts.ts up）");
  return await rpc<T>(socket, op, {}, timeoutMs);
}

process.exitCode = await (async (): Promise<number> => {
  try {
    await env.ensureKeeper(log);
    const resp = await call<ProbeReport>("probe", 90_000);
    if (!resp.ok) {
      log(`probe 失败：${resp.error}`);
      return 1;
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
