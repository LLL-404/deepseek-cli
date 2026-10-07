// 帧协议（T1.2）：CLI ↔ keeper 的私有协议——4 字节大端长度前缀 + JSON（规格 D7）。
// 仅 127.0.0.1 自用，几十行；帧格式见 dskts/README.md「架构一页」。
import type * as net from "node:net";

export type Frame = { op: string; params?: unknown; token?: string };
export type FrameResp<T = unknown> =
  | { ok: true; data: T; progress?: boolean }
  | { ok: false; error: string; code: number };

/** 帧体上限（S3）：本协议正常帧最大也就几百 KB（进度帧/答案帧），64MB 只为挡
 *  「假长度头 + 垃圾字节流」把 keeper 内存撑爆——长度头读出来是 4GB 也不预分配，
 *  但把上限立在这里，坏客户端第一次超就断。 */
export const FRAME_MAX_BYTES = 64 * 1024 * 1024;

/** 解码层错误（S1）：坏帧一律走这里。调用方（keeper 的 socket 回调 / 客户端 rpc）
 *  必须接住——绝不让异常穿到 socket 事件回调外面，否则 uncaughtException 直接杀进程
 *  （实弹：5 字节畸形帧打死了 keeper，2026-10-06）。 */
export class FrameError extends Error {}

export function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** 流式解码：喂进任意大小的 chunk，凑满一帧就回调一次。
 *  坏帧（超长 / 非法 JSON）抛 FrameError，由调用方决定断连——这里不吞也不裸抛。 */
export function createFrameDecoder(
  onFrame: (obj: unknown) => void,
  maxLen = FRAME_MAX_BYTES
) {
  let buf: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer): void {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len > maxLen) {
          throw new FrameError(`帧长 ${len} 超出上限 ${maxLen}（正常帧只有几十 KB）`);
        }
        if (buf.length < 4 + len) return;
        const body = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        let obj: unknown;
        try {
          obj = JSON.parse(body.toString("utf8"));
        } catch {
          // 不把原始字节带进消息：帧内容可控，防止往日志里注入换行/控制字符
          throw new FrameError(`帧体不是合法 JSON（长 ${len} 字节）`);
        }
        onFrame(obj);
      }
    },
  };
}

/** 客户端便捷封装：一连接一命令；ok+progress=true 的帧是中间进度，走 onProgress，
 *  第一帧非 progress 响应才结算。token 由调用方从 env 读好传进来（S2）。 */
export function rpc<T = unknown>(
  socket: net.Socket,
  op: string,
  params: unknown,
  timeoutMs: number,
  onProgress?: (data: unknown) => void,
  token?: string | null
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
    socket.on("data", (c: Buffer) => {
      try {
        decoder.push(c);
      } catch (exc) {
        // keeper 回了坏帧：同样不许把异常抛出事件回调（S1 客户端侧）
        finish(() => reject(new Error(`keeper 回了坏帧：${(exc as Error).message}`)));
      }
    });
    socket.once("error", (e: Error) => {
      finish(() => reject(new Error(`连接中断：${e.message}`)));
    });
    socket.write(encodeFrame({ op, params, token: token ?? undefined } satisfies Frame));
  });
}
