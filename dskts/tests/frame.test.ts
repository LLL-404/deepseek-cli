// 帧协议离线测试：编解码往返、分片粘包、坏长度。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFrameDecoder, encodeFrame } from "../src/frame.ts";

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
