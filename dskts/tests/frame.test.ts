// 帧协议离线测试：编解码往返、分片粘包、坏长度。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFrameDecoder, encodeFrame, FrameError } from "../src/frame.ts";

test("编解码往返：中文与嵌套结构原样", () => {
  const seen: unknown[] = [];
  const dec = createFrameDecoder((o) => seen.push(o));
  const msg = { op: "ask", params: { question: "qoder｜中文「引号」\n换行", n: 42 } };
  dec.push(encodeFrame(msg));
  assert.deepEqual(seen, [msg]);
});

test("分片到达：逐字节喂也能凑出帧", () => {
  const seen: unknown[] = [];
  const dec = createFrameDecoder((o) => seen.push(o));
  const whole = encodeFrame({ op: "status", params: { a: 1 } });
  for (const byte of whole) dec.push(Buffer.from([byte]));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { op: "status", params: { a: 1 } });
});

test("粘包：两帧一块到、一帧半到都各归各位", () => {
  const seen: unknown[] = [];
  const dec = createFrameDecoder((o) => seen.push(o));
  const a = encodeFrame({ op: "ping" });
  const b = encodeFrame({ op: "down", params: { x: "y" } });
  dec.push(Buffer.concat([a, b.subarray(0, 3)]));
  assert.equal(seen.length, 1);
  dec.push(b.subarray(3));
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], { op: "down", params: { x: "y" } });
});

test("连续多帧无粘连", () => {
  const seen: unknown[] = [];
  const dec = createFrameDecoder((o) => seen.push(o));
  for (let i = 0; i < 50; i++) dec.push(encodeFrame({ op: "t", params: { i } }));
  assert.equal(seen.length, 50);
  assert.equal((seen[49] as { params: { i: number } }).params.i, 49);
});

// —— 坏帧防护（S1/S3，2026-10-06 加）——
// 实弹背景：keeper 曾被 5 字节畸形帧直接打死（JSON.parse 裸调用 + 原型链 op）。
// 现在解码器把坏帧统一抛 FrameError、由调用方断连；这里把该契约锁死。

test("坏 JSON：抛 FrameError，且消息里不带原始字节（防日志注入）", () => {
  const dec = createFrameDecoder(() => {
    throw new Error("坏帧不该走到帧回调");
  });
  const body = Buffer.from("not json!\n[injected]", "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  assert.throws(
    () => dec.push(Buffer.concat([head, body])),
    (e: unknown) =>
      e instanceof FrameError && !String((e as Error).message).includes("injected")
  );
});

test("超长帧头：超过上限立刻抛（不会傻等 4GB 数据）", () => {
  const dec = createFrameDecoder(() => {}, 1024);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(2048, 0);
  assert.throws(() => dec.push(head), /超出上限/);
});

test("上限内的大帧照常解码（限长不影响正常帧）", () => {
  const seen: unknown[] = [];
  const dec = createFrameDecoder((o) => seen.push(o), 4096);
  const big = "x".repeat(2000);
  dec.push(encodeFrame({ op: "ask", params: { question: big } }));
  assert.equal(
    (seen[0] as { params: { question: string } }).params.question.length, 2000
  );
});
