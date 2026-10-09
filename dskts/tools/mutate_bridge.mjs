// 变异自检：把 bridge.ts 的某一条实现逐条改坏，跑离线测试，看有没有用例变红。
// 全绿 = 那条改动没被任何测试盯住（NOT-DISCRIMINATED），必须补测试。
// 跑法：node tools/mutate_bridge.mjs       （跑完自动还原 src/bridge.ts）
// 为什么要它：断言「返回 0」不等于「没执行副作用」；只有把守卫拆掉还红，才证明守卫是真的。
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src", "bridge.ts");
const TEST = path.join(HERE, "..", "tests", "bridge.test.ts");

/** 每条：name = 改坏的东西，from = 原文（必须唯一命中），want = 期望变红的用例名片段。 */
const MUTATIONS = [
  { name: "闸门只信声明（丢掉关键词扫描）",
    from: `const scan = classifyDanger(s.cmd);`, to: `const scan = { danger: false, why: [] };`,
    want: "stepGate：顾问标 no" },
  { name: "闸门只信扫描（丢掉声明）",
    from: `const why = [...(s.danger ? ["顾问声明（DANGER: yes）"] : []), ...scan.why];`,
    to: `const why = [...scan.why];`, want: "stepGate：顾问标 yes" },
  { name: "未判定当成满足（继续跑）",
    from: `  if (verdict === "未判定") return { stop: true, stopped: "未判定即停", rc: EXIT_ERROR };`,
    to: `  if (verdict === false) return { stop: true };`, want: "stepDecision" },
  { name: "步数超限静默截断",
    from: `  if (chunks.length > MAX_STEPS_PER_ROUND) {`, to: `  if (false) {`, want: "步数超过上限" },
  { name: "STATE 整块覆盖改成追加",
    from: `  return { ...s, plan: { ...p } };`, to: `  return { ...s, plan: { ...s, ...p, doneItems: [s.plan.doneItems, p.doneItems].filter(Boolean).join("\\n") } };`,
    want: "mergePlan 是整块覆盖" },
  { name: "k/of 从标题行改回找不存在的字段行",
    from: `      k: Number(head?.[2] ?? 1),
      of: Number(head?.[3] ?? 1),`,
    to: `      k: Number(/^- 步骤 (\\d+)\\//m.exec(block)?.[1] ?? 1),
      of: Number(/^- 步骤 \\d+\\/(\\d+)/m.exec(block)?.[1] ?? 1),`,
    want: "appendStep 按批编号" },
  { name: "简报带全部历史",
    from: `].slice(-RECENT_ROUNDS);`, to: `].slice(-999);`, want: "简报只带最近" },
  { name: "write_file 拆掉工作目录围栏",
    from: `      if (!withinDir(root, rel)) {`, to: `      if (false) {`, want: "write_file：工作目录之外" },
  { name: "read_file 拆掉工作目录围栏",
    from: `      if (!withinDir(root, s.cmd)) {`, to: `      if (false) {`, want: "read_file 拒绝工作目录之外" },
  { name: "done 不再收工（返 1 让循环空转）",
    from: `  if (r.stopped === "顾问判定done") return { stop: true, rc: EXIT_OK };`,
    to: `  if (r.stopped === "顾问判定done") return { stop: false, rc: EXIT_ERROR };`,
    want: "loopDecision：done 收工" },
  { name: "散文式 EXPECT 被当成满足",
    from: `  return "未判定";
}

/** 这一步之后批内还继续吗`, to: `  return "满足";
}

/** 这一步之后批内还继续吗`, want: "散文式预期一律未判定" },
];

const orig = fs.readFileSync(SRC, "utf8");
const undetected = [];
for (const m of MUTATIONS) {
  const hits = orig.split(m.from).length - 1;
  if (hits !== 1) {
    console.log(`跳过（原文命中 ${hits} 次，不是 1）：${m.name}`);
    undetected.push(`${m.name}（锚点没命中，变异没跑成）`);
    continue;
  }
  fs.writeFileSync(SRC, orig.replace(m.from, m.to), "utf8");
  const r = spawnSync(process.execPath, [TEST], { encoding: "utf8", cwd: path.join(HERE, "..") });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const failed = [...out.matchAll(/^✖ (.+?) \(/gm)].map((x) => x[1]);
  const caught = failed.some((f) => f.includes(m.want.slice(0, 8)));
  console.log(`${caught ? "红（被盯住）" : "绿（没人管！）"}  ${m.name}` +
    (failed.length ? `  → 变红用例：${failed.slice(0, 3).join("｜")}` : "  → 没有任何用例变红"));
  if (!caught) undetected.push(m.name);
}
fs.writeFileSync(SRC, orig, "utf8");

// 还原后必须全绿，否则说明脚本本身把源文件弄坏了
const check = spawnSync(process.execPath, [TEST], { encoding: "utf8", cwd: path.join(HERE, "..") });
const restored = /^ℹ fail 0$/m.test((check.stdout ?? "") + (check.stderr ?? ""));
console.log(`\n还原后测试：${restored ? "全绿" : "有红（脚本弄坏了源文件，去 git diff 看）"}`);
console.log(`NOT-DISCRIMINATED = ${undetected.length ? "\n  " + undetected.join("\n  ") : "none"}`);
process.exitCode = undetected.length || !restored ? 1 : 0;
