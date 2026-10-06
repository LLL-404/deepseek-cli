// 帧协议（T1.2）：CLI ↔ keeper 的私有协议——4 字节大端长度前缀 + JSON（规格 D7）。
// 仅 127.0.0.1 自用，几十行；帧格式与 DESIGN-dsk2 描述一致。
import type * as net from "node:net";

export type Frame = { op: string; params?: unknown };
export type FrameResp<T = unknown> =
  | { ok: true; data: T; progress?: boolean }
  | { ok: false; error: string; code: number };

export function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** 流式解码：喂进任意大小的 chunk，凑满一帧就回调一次 */
export function createFrameDecoder(onFrame: (obj: unknown) => void) {
  let buf: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer): void {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) return;
        const body = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        onFrame(JSON.parse(body.toString("utf8")));
      }
    },
  };
}

/** 客户端便捷封装：一连接一命令；ok+progress=true 的帧是中间进度，走 onProgress，
 *  第一帧非 progress 响应才结算 */
export function rpc<T = unknown>(
  socket: net.Socket,
  op: string,
  params: unknown,
  timeoutMs: number,
  onProgress?: (data: unknown) => void
): Promise<FrameResp<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`${op} 超时（${Math.round(timeoutMs / 1000)}s 无响应）`)));
    }, timeoutMs);
    const decoder = createFrameDecoder((obj) => {
      const frame = obj as FrameResp<T>;
      if (frame && typeof frame === "object" && "ok" in frame &&
          frame.ok === true && frame.progress === true) {
        onProgress?.(frame.data);
        return;
      }
      finish(() => resolve(frame));
    });
    socket.on("data", (c: Buffer) => decoder.push(c));
    socket.once("error", (e: Error) => {
      finish(() => reject(new Error(`连接中断：${e.message}`)));
    });
    socket.write(encodeFrame({ op, params } satisfies Frame));
  });
}
