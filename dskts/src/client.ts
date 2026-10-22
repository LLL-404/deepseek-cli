// 客户端（CLI 侧）：连 keeper、发命令收响应。一连接一命令，第一帧即响应。
import * as net from "node:net";
import { KEEPER_PORT } from "./constants.ts";
import {
  createFrameDecoder, encodeFrame, rpc, type Frame, type FrameResp,
} from "./frame.ts";

export function tryConnect(timeoutMs = 2_000): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const s = net.connect({ port: KEEPER_PORT, host: "127.0.0.1" });
    let done = false;
    const finish = (v: net.Socket | null) => {
      if (done) return;
      done = true;
      s.removeAllListeners();
      s.setTimeout(0);
      // R15：connect 成功到 rpc 挂上 error 监听之间有个空窗，socket 此刻被重置会
      // 变成未处理的 'error' 直接抛异常。留一个空监听垫住；rpc 另挂的监听照常工作。
      if (v) s.on("error", () => { /* 空窗兜底 */ });
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => { s.destroy(); finish(null); });
    s.once("connect", () => finish(s));
    s.once("error", () => finish(null));
  });
}

export type KeeperProbe =
  | { kind: "keeper"; socket: net.Socket }
  | { kind: "vacant" }
  | { kind: "foreign" }
  | { kind: "unauthorized" };

/** 探活并确认对方真是 dskts keeper（R8）。端口可连不等于 keeper 在跑——别的程序
 *  占着 3928 时，原实现会把对方当 keeper，之后的命令一律撞超时，还查不出原因。
 *  ping 是 keeper 已有的 handler，token 校验照常生效。 */
export async function probeKeeper(
  token: string | null, timeoutMs = 2_000
): Promise<KeeperProbe> {
  const s = await tryConnect(timeoutMs);
  if (!s) return { kind: "vacant" };
  const verdict = await new Promise<"keeper" | "foreign" | "unauthorized">((resolve) => {
    let settled = false;
    const done = (k: "keeper" | "foreign" | "unauthorized"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(k);
    };
    const timer = setTimeout(() => done("foreign"), timeoutMs);
    const decoder = createFrameDecoder((obj: unknown) => {
      const f = obj as FrameResp;
      if (!f || typeof f !== "object" || !("ok" in f)) { done("foreign"); return; }
      // keeper 正忙时 ping 会回 busy 错误帧——那也是我们的 keeper，别误判成外来程序
      if (f.ok === false && String(f.error).startsWith("unauthorized")) done("unauthorized");
      else done("keeper");
    });
    s.on("data", (c: Buffer) => {
      try { decoder.push(c); } catch { done("foreign"); }
    });
    s.once("error", () => done("foreign"));
    s.once("close", () => done("foreign"));
    try { s.write(encodeFrame({ op: "ping", token: token ?? undefined } satisfies Frame)); }
    catch { done("foreign"); }
  });
  if (verdict === "keeper") return { kind: "keeper", socket: s };
  s.destroy();
  if (verdict === "unauthorized") return { kind: "unauthorized" };
  return { kind: "foreign" };
}

export { rpc };
export type { FrameResp };
