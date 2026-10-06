// 客户端（CLI 侧）：连 keeper、发命令收响应。一连接一命令，第一帧即响应。
import * as net from "node:net";
import { KEEPER_PORT } from "./constants.ts";
import { rpc, type FrameResp } from "./frame.ts";

export function tryConnect(timeoutMs = 2_000): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const s = net.connect({ port: KEEPER_PORT, host: "127.0.0.1" });
    let done = false;
    const finish = (v: net.Socket | null) => {
      if (done) return;
      done = true;
      s.removeAllListeners();
      s.setTimeout(0);
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => { s.destroy(); finish(null); });
    s.once("connect", () => finish(s));
    s.once("error", () => finish(null));
  });
}

export { rpc };
export type { FrameResp };
