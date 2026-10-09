// env 层离线测试：清扫门槛，以及 sweep.ps1 能不能真把参数绑上。
// 这两件事决定会不会误杀正在用的浏览器，所以必须离线可重复。跑法：node tests/env.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { shouldSweepProcesses } from "../src/env.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sweepBytes = (): Buffer =>
  fs.readFileSync(path.join(HERE, "..", "src", "sweep.ps1"));

test("锁里 pid 还活着 = 有个 keeper 正在冷启动，绝不清扫进程", () => {
  // 这条是 2026-10-09 那次 ECONNRESET 的一半根因：keeper 在 listen 回调里才写锁，
  // 端口就绪前那几秒 pid 已经活了；第二条 CLI 命令连不上就无条件杀，
  // 把正在启动的 keeper 和它的火狐一起杀掉。
  assert.equal(shouldSweepProcesses(true, true), false);  // 锁在 + pid 活 → 等它起完
  assert.equal(shouldSweepProcesses(true, false), true);  // 死锁 → 接管并清扫
  assert.equal(shouldSweepProcesses(false, false), true); // 没锁 = 没人 claim，扫孤儿
  // 「没锁但 pid 活」这个组合调用方产不出来（sweepStale 只在有锁时才问 pidAlive），
  // 不给不可能的输入编断言——那条永远绿，不算判据。
});

test("sweep.ps1 必须是 UTF-8 带 BOM，否则 PowerShell 读不到 param()", () => {
  // 2026-10-09 实弹：没有 BOM 时 Windows PowerShell 5.1 按 GBK 读这个文件，中文注释
  // 把 param() 那行吞掉，脚本照样跑但三个参数一个都没绑上——$ProfileName 变空，
  // `-like "*"` 于是命中机器上**每一个** firefox.exe，$ExceptPid 变 0 连豁免都失效。
  // 这个断言只看头三个字节：这个坑不看字节就看不见。
  const b = sweepBytes();
  assert.deepEqual([b[0], b[1], b[2]], [0xef, 0xbb, 0xbf], "sweep.ps1 缺 UTF-8 BOM");
});

test("sweep.ps1 必须带「参数没绑上就报错退出」的守卫", () => {
  // 光有 BOM 不够：谁再编辑一次把 BOM 弄丢，故障会以「误杀全部火狐」的形式重现，
  // 而那时最难读的恰恰是这条线索。守卫让它在参数缺失时当场失败，而不是带空匹配继续跑。
  const text = sweepBytes().toString("utf8").replace(/^\uFEFF/, "");
  assert.match(text, /if \(-not \$ProfileName -or \$ExceptPid -le 0\)/);
  assert.match(text, /exit 2/);
  // 且 param() 必须在守卫之前——守卫读的就是这两个绑定值
  assert.ok(text.indexOf("param(") < text.indexOf("if (-not $ProfileName"),
    "守卫写到了 param() 前面，PowerShell 会先解析失败");
});
