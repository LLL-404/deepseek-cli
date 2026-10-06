// textarea 点击超时的现场诊断（临时工具）：textarea 中心点上压着什么元素、有哪些浮层。
import * as env from "../src/env.ts";
import { tryConnect, rpc } from "../src/client.ts";

const log = (...a: unknown[]) => console.error(...a);
await env.ensureKeeper(log);
const socket = await tryConnect(3_000);
if (!socket) {
  console.error("连不上 keeper");
  process.exit(1);
}
const resp = await rpc<Record<string, unknown>>(socket, "diag", {}, 30_000);
console.log(JSON.stringify(resp, null, 2));
