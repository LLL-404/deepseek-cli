// textarea 点击超时的现场诊断（临时工具）：textarea 中心点上压着什么元素、有哪些浮层。
import * as env from "../src/env.ts";
import { tryConnect, rpc } from "../src/client.ts";
import { TOKEN_RETRY, TOKEN_RETRY_GAP_MS, COLD_LAUNCH_BUDGET_MS } from "../src/constants.ts";
import type { FrameResp } from "../src/frame.ts";

const log = (...a: unknown[]) => console.error(...a);
// 探活连接用完即断（同 dskts.ts cmdUp）：不断的话 socket 常驻，进程不会退出
await env.ensureKeeper(log).then((boot) => boot.destroy());

async function call(): Promise<FrameResp<Record<string, unknown>>> {
  // 冷启动竞态（dskts.ts call 同款重试）：keeper 端口就绪与 token 落盘之间有几毫秒窗口
  for (let attempt = 0; ; attempt++) {
    const socket = await tryConnect(3_000);
    if (!socket) {
      console.error("连不上 keeper");
      process.exit(1);
    }
    // diag 同样可能触发浏览器冷启动（ensureContext 补起），超时用冷启动预算
    const resp = await rpc<Record<string, unknown>>(socket, "diag", {}, COLD_LAUNCH_BUDGET_MS, undefined, env.readToken());
    const tokenRefused = !resp.ok && resp.error.startsWith("unauthorized");
    if (!tokenRefused || attempt >= TOKEN_RETRY) return resp;
    log(`keeper 刚起、token 还没落盘，${TOKEN_RETRY_GAP_MS}ms 后重读重试（${attempt + 1}/${TOKEN_RETRY}）…`);
    await new Promise((r) => setTimeout(r, TOKEN_RETRY_GAP_MS));
  }
}

console.log(JSON.stringify(await call(), null, 2));
