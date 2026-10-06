// agent 归属识别离线测试：探测规则、优先级、名字规范化、白名单。
// 不起浏览器、不读真实环境（env 显式注入），跑法：node tests/agent.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_PREFIXES, ownedPrefixes, ownerOf, isOwned, homeTitleFor,
  detectAgent, normalizeName, resolveMark, toMark, type Env,
} from "../src/agent.ts";

test("WorkBuddy 优先于 Claude 兼容变量：本机实测顺序陷阱", () => {
  // CodeBuddy/WorkBuddy 会一并注入 CLAUDE_SESSION_ID、CLAUDE_CODE_GIT_BASH_PATH
  const env: Env = {
    WORKBUDDY_APP_NAME: "WorkBuddy",
    CODEBUDDY_HOST: "workbuddy-desktop",
    CLAUDE_SESSION_ID: "11111111-2222-3333-4444-555555555555",
    CLAUDE_CODE_GIT_BASH_PATH: "C:/tools/bash.exe",
  };
  const d = detectAgent(env);
  assert.equal(d.name, "WorkBuddy");
  assert.equal(d.hitVariable, "WORKBUDDY_APP_NAME");
});

test("只带 Claude 兼容变量、没有原生 CLAUDECODE 时不算 Claude Code", () => {
  const env: Env = {
    CLAUDE_SESSION_ID: "11111111-2222-3333-4444-555555555555",
    CLAUDE_CODE_GIT_BASH_PATH: "C:/tools/bash.exe",
    CLAUDE_PROJECT_DIR: "D:/work/project",
  };
  assert.equal(detectAgent(env).name, "unknown");
});

test("Claude Code 原生变量可认", () => {
  assert.equal(detectAgent({ CLAUDECODE: "1" }).name, "Claude Code");
  assert.equal(detectAgent({ CLAUDE_CODE_ENTRYPOINT: "cli" }).name, "Claude Code");
});

test("其他 Agent 特征变量", () => {
  assert.equal(detectAgent({ QODER_SESSION_ID: "x" }).name, "unknown"); // 老猜的名字不算数了
  assert.equal(detectAgent({ QODERCN_CLIENT_TYPE: "x" }).name, "Qoder");
  assert.equal(detectAgent({ QODER_AGENT_SDK_ENTRYPOINT: "x" }).name, "Qoder");
  assert.equal(detectAgent({ ICUBE_APP_VERSION: "x" }).name, "Trae");
  assert.equal(detectAgent({ TRAE_CONFIG_CHANNEL: "x" }).name, "Trae");
  assert.equal(detectAgent({ OPENCODE_CLIENT: "desktop" }).name, "OpenCode");
  assert.equal(detectAgent({ DSH_SESSION_ID: "x" }).name, "DeepSeek Harness");
  assert.equal(detectAgent({ CURSOR_TRACE_ID: "x" }).name, "Cursor");
  assert.equal(detectAgent({ WINDSURF_SESSION_ID: "x" }).name, "Windsurf");
  assert.equal(detectAgent({ CODEX_SESSION_ID: "x" }).name, "Codex");
});

test("Qoder / Trae / OpenCode 的判据来自本机安装包实测，不再是猜的名", () => {
  // Qoder CN：app.asar 里的环境变量传递白名单
  assert.equal(detectAgent({ QODERCN_SESSION_TYPE: "x" }).name, "Qoder");
  // Trae：main.js 里 process.env.X = 的主动赋值，ICUBE_ 是其内部代号
  assert.equal(detectAgent({ ICUBE_PROVIDER: "x" }).name, "Trae");
  assert.equal(detectAgent({ ICUBE_MACHINE_ID: "x" }).name, "Trae");
  // OpenCode：本机桌面版主进程环境里实测到 OPENCODE_CLIENT=desktop
  const d = detectAgent({ OPENCODE_CLIENT: "desktop" });
  assert.equal(d.name, "OpenCode");
  assert.equal(d.confidence, "strong");
});

test("弱特征（目录类）只在强特征全不命中时才用", () => {
  const weak = detectAgent({ DSH_HOME: "D:/home/tester/.dsh" });
  assert.equal(weak.name, "DeepSeek Harness");
  assert.equal(weak.confidence, "weak");
});

test("用户级弱特征抢不了真调用方：Cursor 里带 DSH_HOME 仍认 Cursor", () => {
  // DSH_HOME 这类目录变量是用户级持久环境变量，任何 Agent 的子进程都能看到
  const d = detectAgent({
    DSH_HOME: "D:/home/tester/.dsh",
    CURSOR_TRACE_ID: "trace-abc",
    QODER_HOME: "C:/home/tester/.qoder",
  });
  assert.equal(d.name, "Cursor");
  assert.equal(d.confidence, "strong");
  assert.equal(d.hitVariable, "CURSOR_TRACE_ID");
});

test("强特征命中时 confidence=strong，认不出时 null", () => {
  assert.equal(detectAgent({ WORKBUDDY_APP_NAME: "WorkBuddy" }).confidence, "strong");
  assert.equal(detectAgent({}).confidence, null);
});

test("空值与纯空白不算命中", () => {
  const d = detectAgent({ WORKBUDDY_APP_NAME: "", QODER_HOME: "   " });
  assert.equal(d.name, "unknown");
  assert.equal(d.hitVariable, null);
});

test("resolveMark 优先级：--mark > DSK_AGENT > 自动识别", () => {
  const env: Env = { WORKBUDDY_APP_NAME: "WorkBuddy", DSK_AGENT: "我的手搓Agent" };
  assert.equal(resolveMark("Qoder", env).source, "cli");
  assert.equal(resolveMark("Qoder", env).mark, "Qoder｜");
  assert.equal(resolveMark(null, env).source, "env");
  assert.equal(resolveMark(null, env).mark, "我的手搓Agent｜");
  assert.equal(resolveMark(null, { WORKBUDDY_APP_NAME: "WorkBuddy" }).source, "auto");
  assert.equal(resolveMark(null, {}).mark, "unknown｜");
  assert.equal(resolveMark(null, {}).hitVariable, null);
});

test("--mark 传空串视为未指定，不产生空前缀", () => {
  assert.equal(resolveMark("", { TRAE_HOME: "x" }).mark, "Trae｜");
  assert.equal(resolveMark("   ", {}).mark, "unknown｜");
});

test("名字规范化：去竖线、去尾分隔符、压换行、截断", () => {
  assert.equal(normalizeName("qoder｜"), "qoder");
  assert.equal(normalizeName("  WorkBuddy  "), "WorkBuddy");
  assert.equal(normalizeName("a｜b"), "ab");
  assert.equal(normalizeName("a\nb\tc"), "a b c");
  assert.equal(normalizeName(""), "unknown");
  assert.equal(normalizeName("｜｜｜"), "unknown");
  const long = normalizeName("一二三四五六七八九十一二三四五六七八九十");
  assert.equal(long.length, 16);
  assert.equal(toMark("Qoder"), "Qoder｜");
});

test("可认前缀含全部内置 Agent、unknown 与历史遗留", () => {
  const list = ownedPrefixes("MyAgent｜");
  for (const p of ["WorkBuddy｜", "Qoder｜", "Trae｜", "Claude Code｜", "Cursor｜",
    "Windsurf｜", "Codex｜", "DeepSeek Harness｜", "CodeArts｜", "unknown｜"]) {
    assert.ok(list.includes(p), `缺 ${p}`);
  }
  for (const p of LEGACY_PREFIXES) assert.ok(list.includes(p), `缺遗留 ${p}`);
  assert.ok(list.includes("MyAgent｜"), "本次生效 mark 必须入白名单");
});

test("归属判定：本 Agent / 别的 Agent / 历史遗留 / 无前缀", () => {
  const cur = "WorkBuddy｜";
  assert.equal(ownerOf("WorkBuddy｜连续会话", cur), "WorkBuddy｜");
  assert.equal(ownerOf("Qoder｜连续会话", cur), "Qoder｜");
  assert.equal(ownerOf("qoder｜连续会话", cur), "qoder｜");
  assert.equal(ownerOf("dsk｜旧会话", cur), "dsk｜");
  assert.equal(ownerOf("我的私人会话", cur), null);
  assert.equal(isOwned("我的私人会话", cur), false);
  assert.equal(isOwned("Trae｜x"), true);
});

test("默认会话标题按 Agent 分条，互不共用", () => {
  assert.equal(homeTitleFor("WorkBuddy｜"), "WorkBuddy｜连续会话");
  assert.equal(homeTitleFor("Qoder｜"), "Qoder｜连续会话");
  assert.notEqual(homeTitleFor("WorkBuddy｜"), homeTitleFor("Qoder｜"));
});

test("--mark 指定的前缀不会被别的 Agent 认领", () => {
  // 一次显式改名不污染下次自动识别的结果
  const a = resolveMark("临时会话", { WORKBUDDY_APP_NAME: "WorkBuddy" });
  assert.equal(a.mark, "临时会话｜");
  const b = resolveMark(null, { WORKBUDDY_APP_NAME: "WorkBuddy" });
  assert.equal(b.mark, "WorkBuddy｜");
  assert.ok(ownedPrefixes(b.mark).includes("临时会话｜") === false);
});
