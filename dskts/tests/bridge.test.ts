// 顾问桥离线测试：STATE/EXEC 两块解析、state.md 两区往返、危险闸门与 EXPECT 判定、简报生成。
// 不起浏览器、不发问、不跑命令，跑法：node tests/bridge.test.ts
//
// 每条用例都注明「实现写错时这条会不会变红」。凡是断言"没发生某事"的，都用 existsSync
// 或字符串不出现来反证——只看返回值绿了不等于副作用没发生。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXIT_ERROR, EXIT_OK, EXIT_PREREQ } from "../src/constants.ts";
import {
  ACTIONS, BRIEF_MAX_CHARS, MAX_STEPS_PER_ROUND, OUTPUT_CAP_BYTES, PROTECTED_FILES, RECENT_ROUNDS,
  advisorPrompt, appendStep, buildBriefing, capOutput, checkExpect, classifyDanger, emptyPlan,
  extractBlock, loopDecision, mergePlan, parseExecBlock, parsePlanBlock, parseReply, parseState,
  renderReply, renderState, runAction, shellSpec, stepDecision, stepGate, summarizeOutput, withinDir,
  type ExecStep, type Plan, type State,
} from "../src/bridge.ts";

// —— 样例回复：作者改定的形状（思考文字 + STATE + 多步 EXEC）——

const REPLY_OK = [
  "## 形势判断",
  "目标合理，但环境未侦察；先确认 Python 是否可用，不要猜。",
  "## 全局策略",
  "分三阶段：侦察 → 归档脚本 → 校验。",
  "## 风险与回滚",
  "移动文件前先列清单；失败就把 .snap 里的名字念一遍交回给人。",
  "## 状态更新",
  "```STATE",
  "阶段：环境侦察",
  "目标：把下载文件夹按类型归档",
  "成功标准：所有文件进入分类目录，无重复，无丢失",
  "已完成：确认系统为 Windows 11",
  "待办：确认 Python 是否可用",
  "关键决策：用 Python 脚本而不是 PowerShell",
  "未决问题：是否有 OneDrive 同步目录",
  "```",
  "## 执行包",
  "```EXEC",
  "STEP: 1",
  "ACTION: shell",
  "CMD: python --version",
  "EXPECT: 包含:Python",
  "ON_FAIL: 收集完整 stderr 与退出码，停止",
  "DANGER: no",
  "---",
  "STEP: 2",
  "ACTION: read_file",
  "CMD: C:\\Users\\xxx\\Downloads",
  "EXPECT: 非空",
  "ON_FAIL: 收集错误，停止",
  "DANGER: yes",
  "```",
].join("\n");

const step = (o: Partial<ExecStep> & { action: ExecStep["action"] }): ExecStep =>
  ({ step: 1, cmd: "", expect: "", onFail: "", danger: false, ...o });

// —— extractBlock / parseReply ——

test("extractBlock：STATE 与 EXEC 各自取到，块外的思考文字不算内容", () => {
  const st = extractBlock(REPLY_OK, "STATE");
  assert.ok(!("error" in st), JSON.stringify(st));
  if (!("body" in st)) return;
  assert.match(st.body, /^阶段：环境侦察/);
  assert.equal(st.body.includes("形势判断"), false, "把块外文字混进来了");
  const ex = extractBlock(REPLY_OK, "EXEC");
  assert.ok(!("error" in ex));
  assert.match(ex.body, /^STEP: 1/);
});

test("parseReply：七个 STATE 字段与两步 EXEC 都解析到位（CRLF 输入也一样）", () => {
  const r = parseReply(REPLY_OK.replace(/\n/g, "\r\n"));
  assert.ok(!("error" in r), JSON.stringify(r));
  assert.equal(r.plan.phase, "环境侦察");
  assert.equal(r.plan.success, "所有文件进入分类目录，无重复，无丢失");
  assert.equal(r.plan.decisions, "用 Python 脚本而不是 PowerShell");
  assert.equal(r.plan.open, "是否有 OneDrive 同步目录");
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[1].cmd, "C:\\Users\\xxx\\Downloads");
  assert.equal(r.steps[1].danger, true, "DANGER: yes 没绑上");
  assert.equal(r.steps[1].action, "read_file");
  assert.equal(r.steps[0].onFail, "收集完整 stderr 与退出码，停止");
});

test("只有 STATE、没有 EXEC 是合法的（记忆必须能落盘，不能因为没活干就报错）", () => {
  const text = "## 状态更新\n```STATE\n阶段：等侦察\n目标：x\n```\n这轮我想先看点东西。";
  const r = parseReply(text);
  assert.ok(!("error" in r), JSON.stringify(r));
  if ("error" in r) return;
  assert.equal(r.plan.phase, "等侦察");
  assert.deepEqual(r.steps, [], "没有 EXEC 却凭空造出了步骤");
});

test("完全没有 STATE 就报错（滚动记忆断了要当场知道）", () => {
  const err = parseReply("ACTION: shell\nCMD: dir /b\nEXPECT: 有输出\nFAIL: 报错");
  assert.ok("error" in err);
  assert.match(err.error, /STATE/);
});

test("v1 的四行回复要指名是新格式问题，不能被当成「空 EXEC」放过去", () => {
  const err = parseReply("ACTION: shell\nCMD: dir /b\nEXPECT: x\nFAIL: y");
  assert.ok("error" in err, JSON.stringify(err));
  assert.match(err.error, /STATE/);
});

test("出现两个 STATE 块就报错——取第一个会静默丢掉一半记忆", () => {
  const two = REPLY_OK + "\n```STATE\n阶段：第二块\n```\n";
  const err = parseReply(two);
  assert.ok("error" in err, JSON.stringify(err));
  assert.match(err.error, /两个 STATE|STATE 块/);
});

test("外层四反引号、内层三反引号：EXEC 内容不被提前截断", () => {
  const text = "````EXEC\nSTEP: 1\nACTION: shell\nCMD: type f.md | findstr \"```\"\nEXPECT: 非空\nON_FAIL: -\nDANGER: no\n````";
  const r = parseReply("````STATE\n阶段：围栏测试\n````\n" + text);
  assert.ok(!("error" in r), JSON.stringify(r));
  if ("error" in r) return;
  assert.equal(r.steps[0].cmd, 'type f.md | findstr "```"', "围栏判定错，命令被吃了");
});

test("CMD 里的 --- 不当步骤分隔：只有后面紧跟 STEP: 才切步", () => {
  const body = [
    "STEP: 1", "ACTION: write_file", "CMD: out/a.txt", "--- 这段是文件内容的一部分", "第二行内容",
    "EXPECT: 非空", "ON_FAIL: -", "DANGER: no",
  ].join("\n");
  const steps = parseExecBlock(body);
  assert.ok(!("error" in steps), JSON.stringify(steps));
  if ("error" in steps) return;
  assert.equal(steps.length, 1, "内容里的 --- 被当成切步");
  assert.equal(steps[0].cmd, "out/a.txt\n--- 这段是文件内容的一部分\n第二行内容");
});

test("步数超过上限整批拒（静默截断会跑出顾问没打算跑的组合）", () => {
  const many = Array.from({ length: MAX_STEPS_PER_ROUND + 1 }, (_, i) =>
    ["STEP: " + (i + 1), "ACTION: shell", `CMD: echo ${i + 1}`, "EXPECT: 非空", "ON_FAIL: -", "DANGER: no"].join("\n")
  ).join("\n---\n");
  const err = parseExecBlock(many);
  assert.ok("error" in err, JSON.stringify(err));
  assert.match(err.error, new RegExp(String(MAX_STEPS_PER_ROUND)));
});

test("缺字段要指名第几步缺什么", () => {
  const body = "STEP: 1\nACTION: shell\nCMD: dir\nEXPECT: x\nON_FAIL: -\nDANGER: no\n---\nSTEP: 2\nACTION: shell\nCMD: dir\nON_FAIL: -\nDANGER: no";
  const err = parseExecBlock(body);
  assert.ok("error" in err, JSON.stringify(err));
  assert.match(err.error, /第 2 步/);
  assert.match(err.error, /EXPECT/);
});

test("动作不在词表里就拒（顾问不能发明执行器没有的手）", () => {
  const err = parseExecBlock("STEP: 1\nACTION: browser_click\nCMD: #submit\nEXPECT: 非空\nON_FAIL: -\nDANGER: no");
  assert.ok("error" in err, JSON.stringify(err));
  assert.match(err.error, /不在词表/);
});

test("DANGER 只认 yes/no，写「可能危险」这类模糊值一律拒", () => {
  for (const [v, want] of [["yes", true], ["YES", true], ["有", true], ["true", true], ["no", false], ["-", false], ["", false]] as [string, boolean][]) {
    const s = parseExecBlock(`STEP: 1\nACTION: shell\nCMD: dir\nEXPECT: 非空\nON_FAIL: -\nDANGER: ${v}`);
    assert.ok(!("error" in s), `DANGER: ${v} 竟被拒`);
    if (!("error" in s)) assert.equal(s[0].danger, want, `DANGER: ${v} 绑错`);
  }
  const err = parseExecBlock("STEP: 1\nACTION: shell\nCMD: dir\nEXPECT: 非空\nON_FAIL: -\nDANGER: 可能危险");
  assert.ok("error" in err, JSON.stringify(err));
});

test("执行类动作的 CMD 不能为空；多行只许 write_file 与 python", () => {
  const e1 = parseExecBlock("STEP: 1\nACTION: shell\nCMD:\nEXPECT: 非空\nON_FAIL: -\nDANGER: no");
  assert.ok("error" in e1, JSON.stringify(e1));
  const e2 = parseExecBlock("STEP: 1\nACTION: shell\nCMD: cd /d D:\\x\ndir\nEXPECT: 非空\nON_FAIL: -\nDANGER: no");
  assert.ok("error" in e2, JSON.stringify(e2));
  const ok = parseExecBlock("STEP: 1\nACTION: write_file\nCMD: a.txt\nline1\nline2\nEXPECT: 非空\nON_FAIL: -\nDANGER: no");
  assert.ok(!("error" in ok), JSON.stringify(ok));
});

test("done 与 ask_user 允许 CMD 是说明文字", () => {
  for (const action of ["done", "ask_user"]) {
    const s = parseExecBlock(`STEP: 1\nACTION: ${action}\nCMD: 已归档 47 个文件\nEXPECT: -\nON_FAIL: -\nDANGER: no`);
    assert.ok(!("error" in s), action);
  }
});

test("renderReply → parseReply 往返不丢字段", () => {
  const r = parseReply(REPLY_OK);
  assert.ok(!("error" in r), JSON.stringify(r));
  if ("error" in r) return;
  const back = parseReply(renderReply(r));
  assert.ok(!("error" in back), JSON.stringify(back));
  if ("error" in back) return;
  assert.deepEqual(back.steps, r.steps);
  assert.deepEqual(back.plan, r.plan);
});

test("parsePlanBlock：字段名写错不报错，但已知字段照常取到", () => {
  const p = parsePlanBlock("阶段：x\n未知字段：y");
  assert.ok(!("error" in p), JSON.stringify(p));
  if ("error" in p) return;
  assert.equal(p.phase, "x");
  // 关键在这里：不认识的标签不能被当续行吞进上一个字段，否则「已完成事项：…」
  // 这类写错的标签会把整段内容串进已完成的值里（记忆串味，比丢一行更坏）
  assert.equal(p.doneItems.includes("未知字段"), false, JSON.stringify(p));
});

test("parsePlanBlock：没有标签的续行仍接在当前字段后面（不许静默截断）", () => {
  const p = parsePlanBlock("已完成：第一步\n第二步还在跑\n阶段：归档");
  assert.ok(!("error" in p));
  if ("error" in p) return;
  assert.equal(p.doneItems, "第一步\n第二步还在跑");
  assert.equal(p.phase, "归档");
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
    // 采纳 DeepSeek 建议后要用的哨兵写法，不能被覆盖规则误拦（& 之后 echo 是实测过的形状）
    'node -e "console.log(1)" && echo __R3_OK__',
  ]) {
    const d = classifyDanger(cmd);
    assert.equal(d.danger, false, `误拦：${cmd} → ${d.why.join()}`);
  }
});

test("真覆盖仍然要拦：nul 豁免不能顺手放过写文件", () => {
  for (const cmd of ["echo x > important.md", "copy /Y a.txt b.txt", "Set-Content -Path a -Value b"]) {
    assert.equal(classifyDanger(cmd).danger, true, `漏拦：${cmd}`);
  }
});

test("闸门理由去重", () => {
  assert.equal(classifyDanger("rm -rf a && rm -rf b").why.length, 1);
});

// —— stepGate：声明与扫描取并集，两条都要能单独拦住 ——

test("stepGate：顾问标 no 但关键词命中，仍然要人（只信声明的实现在这条会红）", () => {
  const g = stepGate(step({ action: "shell", cmd: "del /q note.txt", danger: false }));
  assert.equal(g.need, true, JSON.stringify(g));
  assert.ok(g.why.some((w) => w.includes("删除")));
});

test("stepGate：顾问标 yes 但命令看着无害，也要人（只信扫描的实现在这条会红）", () => {
  const g = stepGate(step({ action: "shell", cmd: "node --version", danger: true }));
  assert.equal(g.need, true, JSON.stringify(g));
  assert.ok(g.why.some((w) => w.includes("声明")));
});

test("stepGate：两边都说安全才算安全", () => {
  const g = stepGate(step({ action: "shell", cmd: "dir /b", danger: false }));
  assert.equal(g.need, false, JSON.stringify(g));
});

// —— checkExpect：五种机械形式之外一律「未判定」——

test("checkExpect：exit / 退出码 看的是退出码，不是输出文本", () => {
  assert.equal(checkExpect("exit=0", 0, "啥都没有"), "满足");
  assert.equal(checkExpect("exit=0", 1, "ALPHA-7731 在里面"), "不满足");
  assert.equal(checkExpect("退出码 2", 2, ""), "满足");
});

test("checkExpect：包含 / 不含 看的是输出，与退出码无关", () => {
  assert.equal(checkExpect("包含:ALPHA-7731", 0, "…ALPHA-7731…"), "满足");
  assert.equal(checkExpect("包含:ALPHA-7731", 0, "没有那个串"), "不满足");
  assert.equal(checkExpect("不含:error", 0, "all good"), "满足");
  assert.equal(checkExpect("不含:error", 0, "An Error occurred"), "不满足");
  assert.equal(checkExpect("包含:python", 0, "Python 3.12.7"), "满足", "大小写归一没做");
});

test("checkExpect：regex 与 非空", () => {
  assert.equal(checkExpect("regex:Python \\d+\\.\\d+", 0, "Python 3.12.7"), "满足");
  assert.equal(checkExpect("regex:(", 0, "任意"), "未判定", "非法正则该判未判定，不该当满足");
  assert.equal(checkExpect("非空", 0, "x"), "满足");
  assert.equal(checkExpect("非空", 0, "   \n"), "不满足");
});

test("checkExpect：散文式预期一律未判定（不许猜模型的意思）", () => {
  for (const e of ["", "输出 Python 3.x", "应该列出文件名", "-"]) {
    assert.equal(checkExpect(e, 0, "Python 3.12.7"), "未判定", `「${e}」被当成可判定`);
  }
});

// —— state.md 两区：顾问记忆整块覆盖，轮次记录只追加 ——

const EMPTY: State = {
  goal: "把 a 转成 b", env: "OS=win32；Shell=cmd.exe", status: "刚开始",
  plan: emptyPlan(), rounds: [],
};

test("renderState → parseState 往返：两个区都不丢", () => {
  const s = parseState(renderState(EMPTY));
  assert.equal(s.goal, "把 a 转成 b");
  assert.equal(s.env, "OS=win32；Shell=cmd.exe");
  assert.equal(s.status, "刚开始");
  assert.deepEqual(s.plan, emptyPlan());
  assert.deepEqual(s.rounds, []);
});

test("mergePlan 是整块覆盖：上一轮的「已完成」文本必须消失", () => {
  const p1: Plan = { ...emptyPlan(), phase: "侦察", doneItems: "已确认 Windows 11" };
  const p2: Plan = { ...emptyPlan(), phase: "归档", doneItems: "已确认 Python 可用" };
  const s = mergePlan(mergePlan(EMPTY, p1), p2);
  const text = renderState(s);
  assert.equal(text.includes("已确认 Windows 11"), false, "覆盖写成了追加，记忆会越滚越长");
  assert.match(text, /已确认 Python 可用/);
  assert.equal(s.plan.phase, "归档");
});

test("appendStep 按批编号、只追加，前一步原文留着", () => {
  let s = appendStep(EMPTY, { round: 1, k: 1, of: 2, step: 1, action: "shell", cmd: "dir /b", expect: "非空", verdict: "满足（退出码 0）", summary: "a.txt ⏎ b.txt" });
  s = appendStep(s, { round: 1, k: 2, of: 2, step: 2, action: "read_file", cmd: "a.txt", expect: "包含:x", verdict: "失败（退出码 1）", summary: "读不到" });
  assert.equal(s.rounds.length, 2);
  const back = parseState(renderState(s));
  assert.equal(back.rounds.length, 2);
  assert.equal(back.rounds[1].action, "read_file");
  assert.equal(back.rounds[1].cmd, "a.txt");
  assert.equal(back.rounds[1].verdict, "失败（退出码 1）");
  assert.equal(back.rounds[1].summary, "读不到");
  assert.equal(back.rounds[0].cmd, "dir /b", "追加写把上一条覆盖了");
  // k/of 写在标题行上，parseState 必须从那儿取回来。曾经的写法去找一个不存在的
  // 「- 步骤 k/of」字段，重读一遍 state.md 后步骤号全退成 1/1，失败简报就指错步骤。
  assert.deepEqual(
    back.rounds.map((r) => [r.round, r.k, r.of, r.step]),
    [[1, 1, 2, 1], [1, 2, 2, 2]]
  );
});

test("顾问记忆区里的「目标：」不能被当成头部的「目标：」", () => {
  // 头部目标是人写的任务契约；STATE.目标 是顾问对目标的理解。两者同名，
  // 旧的 pick() 用 ^目标： 会跨区乱抓，这里各归各位。
  const s: State = { ...EMPTY, plan: { ...emptyPlan(), goal: "顾问理解的版本" } };
  const back = parseState(renderState(s));
  assert.equal(back.goal, "把 a 转成 b");
  assert.equal(back.plan.goal, "顾问理解的版本");
});

test("v1 留下的 state.md 要读得动（旧动作名不报错，轮次不消失）", () => {
  const v1 = [
    "# 任务状态", "", "目标：老任务", "", "环境：OS=win32", "", "当前状态：跑了一轮", "",
    "## 轮次记录", "", "### 第 1 轮", "- ACTION: request_info", "- CMD: 列出 x",
    "- EXPECT: y", "- 结果: 待补信息（未执行）", "- 输出摘要: 无", "",
  ].join("\n");
  const s = parseState(v1);
  assert.equal(s.goal, "老任务");
  assert.equal(s.rounds.length, 1, "旧轮次丢了");
  assert.equal(s.rounds[0].action, "request_info");
});

// —— buildBriefing ——

test("简报自包含：契约/STATE/环境/动作表/上限都在", () => {
  const s = mergePlan(EMPTY, { ...emptyPlan(), phase: "侦察", success: "无重复无丢失" });
  const b = buildBriefing(s);
  assert.ok(typeof b === "string", JSON.stringify(b));
  if (typeof b !== "string") return;
  for (const needle of ["【执行器简报】", "目标：把 a 转成 b", "成功标准：无重复无丢失",
    "阶段：侦察", "执行命令用的 shell：", "可用动作：", `一轮至多 ${MAX_STEPS_PER_ROUND} 步`]) {
    assert.ok(b.includes(needle), `简报里缺 ${needle}`);
  }
  for (const action of ACTIONS) assert.ok(b.includes(action), `动作词表缺 ${action}`);
});

test("简报只带最近 N 轮，不带全部历史", () => {
  let s = EMPTY;
  for (let i = 1; i <= 6; i++) {
    s = appendStep(s, { round: i, k: 1, of: 1, step: i, action: "shell", cmd: `cmd-${i}`, expect: "非空", verdict: "满足（退出码 0）", summary: `out-${i}` });
  }
  const b = buildBriefing(s);
  assert.ok(typeof b === "string");
  if (typeof b !== "string") return;
  assert.equal(b.includes("cmd-3"), false, `只该带最近 ${RECENT_ROUNDS} 轮`);
  assert.equal(b.includes("cmd-6"), true);
});

test("STATE 某字段爆长时先折叠再报错：简报必须留在预算内", () => {
  const s = mergePlan(EMPTY, { ...emptyPlan(), todo: Array.from({ length: 60 }, (_, i) => `待办项 ${i}`).join("\n") });
  const b = buildBriefing(s);
  assert.ok(typeof b === "string", `超长直接报错，折叠没生效：${JSON.stringify(b)}`);
  if (typeof b !== "string") return;
  assert.ok(b.length <= BRIEF_MAX_CHARS, `折叠后仍 ${b.length} 字`);
  assert.match(b, /折叠|截断/);
});

test("契约本身就超长时仍然报错不截断（外发内容必须可控）", () => {
  const s: State = { ...EMPTY, goal: "长".repeat(BRIEF_MAX_CHARS) };
  const r = buildBriefing(s);
  assert.ok(typeof r !== "string");
  if (typeof r !== "string") assert.match(r.error, /超过上限/);
});

test("没有轮次时写清「还没执行过任何命令」，不留空段", () => {
  const b = buildBriefing(EMPTY);
  assert.ok(typeof b === "string");
  if (typeof b === "string") assert.match(b, /还没有执行过任何命令/);
});

test("顾问提示词里写死了本轮新加的三条规矩", () => {
  const p = advisorPrompt();
  assert.match(p, /STATE/, "没让顾问写 STATE 块");
  assert.match(p, /EXEC/, "没让顾问写 EXEC 块");
  assert.match(p, /&&/, "哨兵写法没进去（实测 & echo 分不出成败）");
  assert.match(p, /未判定/, "没告诉它散文式 EXPECT 会被判未判定并停下");
  assert.match(p, /DANGER/, "没写危险标注规则");
  assert.equal(p.includes("browser_click"), false, "词表漏进执行器没有的手");
});

// —— summarizeOutput / capOutput ——

test("输出摘要压成单行、超长截断并写清原字数、空输出有占位", () => {
  assert.equal(summarizeOutput("a\nb\r\nc"), "a ⏎ b ⏎ c");
  assert.equal(summarizeOutput(""), "（无输出）");
  const long = summarizeOutput("字".repeat(1200), 600);
  assert.match(long, /截断，原 1200 字/);
  assert.ok(long.length < 700);
});

test("输出上限：超限截断并写清上限，未超原样返回", () => {
  assert.deepEqual(capOutput("abc"), { text: "abc", capped: false });
  const big = capOutput("x".repeat(OUTPUT_CAP_BYTES + 10));
  assert.equal(big.capped, true);
  assert.match(big.text, /已杀掉命令并截断/);
});

// —— runAction：围栏（read_file 的内容会随下一轮简报外发，等于读盘外泄通道）——
//
// 这三条都断言「外面的文件没被造出来」，所以断言之前必须先把前置清掉，
// 并且用进程号唯一的文件名：跑变异自检时（tools/mutate_bridge.mjs）围栏是被拆掉的，
// 它会往共享临时目录留下 evil.txt——不唯一的话，下一轮正常测试会被那个残留假红。
const TAG = String(process.pid);
const outsideDir = (): string => path.join(os.tmpdir(), `bridge-out-${TAG}`);

test("read_file 拒绝工作目录之外的路径", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-in-"));
  const out = outsideDir();
  fs.mkdirSync(out, { recursive: true });
  const outside = path.join(out, "bridge-secret.txt");
  fs.writeFileSync(outside, "TOP-SECRET", "utf8");
  try {
    const r = await runAction(step({ action: "read_file", cmd: outside }), root, "t1");
    assert.equal(r.rc, EXIT_PREREQ, JSON.stringify(r));
    assert.match(r.out, /拒绝/);
    assert.equal(r.out.includes("TOP-SECRET"), false, "内容被读出来了，围栏没生效");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("read_file 允许工作目录之内的文件，且超长会截断", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-in-"));
  fs.writeFileSync(path.join(root, "a.txt"), "字".repeat(9000), "utf8");
  try {
    const r = await runAction(step({ action: "read_file", cmd: "a.txt" }), root, "t2");
    assert.equal(r.rc, EXIT_OK, r.out.slice(0, 80));
    assert.match(r.out, /截断，原 9000 字/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("python 拒绝跑工作目录之外的脚本", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-in-"));
  const out = outsideDir();
  fs.mkdirSync(out, { recursive: true });
  const outside = path.join(out, "bridge-evil.py");
  fs.writeFileSync(outside, "print('ran')\n", "utf8");
  try {
    const r = await runAction(step({ action: "python", cmd: outside }), root, "t3");
    assert.equal(r.rc, EXIT_PREREQ, JSON.stringify(r));
    assert.match(r.out, /拒绝/);
    assert.equal(r.out.includes("ran"), false, "脚本真跑了，围栏没生效");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("write_file：在工作目录里建文件，内容逐字节等值", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-w-"));
  try {
    const r = await runAction(
      step({ action: "write_file", cmd: "out/fix.py\nprint('A')\nprint('B')\n" }), root, "w1");
    assert.equal(r.rc, EXIT_OK, r.out.slice(0, 120));
    const p = path.join(root, "out", "fix.py");
    assert.equal(fs.existsSync(p), true, "回报成功但文件没落地");
    assert.equal(fs.readFileSync(p, "utf8"), "print('A')\nprint('B')\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("write_file：工作目录之外的路径拒，且不落盘", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-w-"));
  const out = outsideDir();
  fs.mkdirSync(out, { recursive: true });
  const evil = path.join(out, "evil.txt");
  fs.rmSync(evil, { force: true }); // 前置清干净，否则上一轮残留会把它假红
  try {
    const r = await runAction(step({ action: "write_file", cmd: `${evil}\nx` }), root, "w2");
    assert.equal(r.rc, EXIT_PREREQ, JSON.stringify(r));
    assert.equal(fs.existsSync(evil), false, "文件写到外面去了");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("write_file：目标已存在就拒（覆盖是危险动作，得由人做）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-w-"));
  fs.writeFileSync(path.join(root, "has.txt"), "OLD", "utf8");
  try {
    const r = await runAction(step({ action: "write_file", cmd: "has.txt\nNEW" }), root, "w3");
    assert.equal(r.rc, EXIT_PREREQ, JSON.stringify(r));
    assert.equal(fs.readFileSync(path.join(root, "has.txt"), "utf8"), "OLD", "旧内容被盖掉了");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("write_file：不许改执行器自己的账本", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-w-"));
  for (const name of PROTECTED_FILES) {
    const r = await runAction(step({ action: "write_file", cmd: `${name}\nx` }), root, "w4");
    assert.equal(r.rc, EXIT_PREREQ, `${name} 竟然让写：${JSON.stringify(r)}`);
    assert.equal(fs.existsSync(path.join(root, name)), false, `${name} 被写出来了`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("withinDir：.. 与绝对路径都挡，嵌套子目录放行", () => {
  const root = path.resolve("D:\\work\\proj");
  assert.equal(withinDir(root, path.resolve(root, "a/b.txt")), true);
  assert.equal(withinDir(root, path.resolve(root, "..", "x.txt")), false);
  assert.equal(withinDir(root, root), true);
  assert.equal(withinDir(root, path.resolve("D:\\other\\a.txt")), false);
  // 前缀相似但不是子目录（D:\\work\\proj2 不能被当成 proj 里面）
  assert.equal(withinDir(root, path.resolve("D:\\work\\proj2\\a.txt")), false);
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

// —— 循环判据：一批跑完后要不要再问顾问 ——

const round = (stopped: string, rc: number) =>
  ({ ran: [], stopped, rc, reason: "" } as never);

test("stepDecision：失败、不满足、未判定都停批；done 与 ask_user 各归各", () => {
  // 批内停不停是纯判据（跑命令的部分留给实弹）。这条不测，"失败还接着跑第 3 步"就没人管。
  assert.deepEqual(stepDecision("shell", EXIT_ERROR, "不满足"), { stop: true, stopped: "失败即停", rc: EXIT_ERROR });
  assert.deepEqual(stepDecision("shell", EXIT_OK, "不满足"), { stop: true, stopped: "失败即停", rc: EXIT_ERROR });
  assert.deepEqual(stepDecision("shell", EXIT_OK, "未判定"), { stop: true, stopped: "未判定即停", rc: EXIT_ERROR });
  assert.deepEqual(stepDecision("shell", EXIT_OK, "满足"), { stop: false, stopped: "全部完成", rc: EXIT_OK });
  assert.deepEqual(stepDecision("done", EXIT_OK, "满足"), { stop: true, stopped: "顾问判定done", rc: EXIT_OK });
  assert.deepEqual(stepDecision("ask_user", EXIT_PREREQ, "未判定"), { stop: true, stopped: "待人", rc: EXIT_PREREQ });
});

test("loopDecision：done 收工返 0；待人/不合规交回给人；失败与未判定继续问", () => {
  assert.deepEqual(loopDecision(round("顾问判定done", EXIT_OK)), { stop: true, rc: EXIT_OK });
  assert.deepEqual(loopDecision(round("全部完成", EXIT_OK)), { stop: false, rc: EXIT_OK });
  assert.deepEqual(loopDecision(round("失败即停", EXIT_ERROR)), { stop: false, rc: EXIT_ERROR });
  assert.deepEqual(loopDecision(round("未判定即停", EXIT_ERROR)), { stop: false, rc: EXIT_ERROR });
  assert.deepEqual(loopDecision(round("待人", EXIT_PREREQ)), { stop: true, rc: EXIT_PREREQ });
  assert.deepEqual(loopDecision(round("不合规", EXIT_ERROR)), { stop: true, rc: EXIT_ERROR });
});
