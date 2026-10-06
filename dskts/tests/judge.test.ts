// judge 离线测试（T1.4）：注入假读数，不起浏览器。14 项，语义对齐现版 tests/test_answer.py
// 的思路并覆盖 Gate 实证的四条新教训（F-1 文本基落地 / F-3 noRender / busy 门 / 抖动收摊）。
// 跑法：node tests/judge.test.ts（Node 24 type stripping 直接执行，node:test 自报结果）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJudge, type JudgeConfig, type Reading, type Sample } from "../src/judge.ts";

const FAST: JudgeConfig = {
  tickMs: 1, minWaitMs: 0, stableNeed: 3, readFailMax: 5, maxWaitMs: 10_000,
};

const ok = (count: number, busy: boolean, text: string): Reading => ({
  ok: true, sample: { count, busy, text } satisfies Sample,
});
const bad = (err = "读数挂了"): Reading => ({ ok: false, error: err });

/** 按顺序喂读数，返回每拍的判定 */
function run(judge: ReturnType<typeof createJudge>, readings: Reading[]) {
  return readings.map((r) => judge.tick(r));
}

test("count 增多落地，稳 3 拍且不 busy 判完成", () => {
  const j = createJudge(0, "", FAST);
  const v = run(j, [
    ok(1, true, "答案开头"),
    ok(1, true, "答案开头"),
    ok(1, true, "答案开头"),
    ok(1, false, "答案开头"),
  ]);
  assert.equal(v[0].landed, true);
  assert.equal(v[0].terminal, null);
  assert.equal(v[1].terminal, null);
  assert.equal(v[2].terminal, null);
  assert.equal(v[3].terminal, "done");
  assert.equal(v[3].text, "答案开头");
});

test("虚拟列表缩容也落地：文本离开提交前那条即可（F-1）", () => {
  const j = createJudge(5, "旧答案", FAST);
  const v = run(j, [ok(2, true, "新答案开头")]);
  assert.equal(v[0].landed, true);
});

test("count<=before 且文本未变 = 一直 pending，到上限按 noRender 收", () => {
  const j = createJudge(3, "旧答案", { ...FAST, maxWaitMs: 4 });
  const v = run(j, [ok(3, false, "旧答案"), ok(3, false, "旧答案"),
                    ok(3, false, "旧答案"), ok(3, false, "旧答案")]);
  assert.deepEqual(v.map(x => x.landed), [false, false, false, false]);
  assert.equal(v[3].terminal, "noRender");
});

test("空文本一直 pending，到上限 noRender", () => {
  const j = createJudge(0, "", { ...FAST, maxWaitMs: 3 });
  const v = run(j, [ok(1, true, ""), ok(1, true, ""), ok(1, true, "")]);
  assert.equal(v[2].terminal, "noRender");
});

test("busy 门：文本冻结但生成中不判完，到上限按截断收（现版第 10 项）", () => {
  const j = createJudge(0, "", { ...FAST, maxWaitMs: 6 });
  const v = run(j, [
    ok(1, true, "半截"), ok(1, true, "半截"), ok(1, true, "半截"),
    ok(1, true, "半截"), ok(1, true, "半截"), ok(1, true, "半截"),
  ]);
  assert.equal(v[5].terminal, "truncated");
  assert.equal(v[5].text, "半截");
});

test("busy 消失且文本未变，下一拍立即判完成", () => {
  const j = createJudge(0, "", FAST);
  const v = run(j, [
    ok(1, true, "答案"), ok(1, true, "答案"), ok(1, true, "答案"),
    ok(1, false, "答案"),
  ]);
  assert.equal(v[2].terminal, null);
  assert.equal(v[3].terminal, "done");
});

test("单拍读数失败当空采样跳过，不中断判定", () => {
  const j = createJudge(0, "", FAST);
  const v = run(j, [
    ok(1, true, "答案"), ok(1, true, "答案"), bad(), ok(1, true, "答案"),
    ok(1, false, "答案"),
  ]);
  assert.equal(v[2].terminal, null);
  assert.equal(v[4].terminal, "done");
});

test("连挂 readFailMax 拍收摊：已拿到文本按截断返回", () => {
  const j = createJudge(0, "", FAST);
  const v = run(j, [
    ok(1, true, "已见答案"), bad(), bad(), bad(), bad(), bad(),
  ]);
  assert.equal(v[5].terminal, "truncated");
  assert.equal(v[5].text, "已见答案");
});

test("连挂 readFailMax 拍收摊：一个字没有按 noRender 报错", () => {
  const j = createJudge(0, "", FAST);
  const v = run(j, [bad(), bad(), bad(), bad(), bad()]);
  assert.equal(v[4].terminal, "noRender");
});

test("min_wait 之前不算稳：稳定计数从 min_wait 起步（对齐现版 18 秒现象）", () => {
  // tickMs=1, minWaitMs=100, stableNeed=3：稳定拍从第 100 拍才开始累计
  const j = createJudge(0, "", { ...FAST, minWaitMs: 100 });
  const readings = Array.from({ length: 103 }, () => ok(1, false, "长答案"));
  const v = run(j, readings);
  assert.equal(v[98].terminal, null); // 第 99 拍：还没到 min_wait
  assert.equal(v[100].terminal, null); // stable 才 2
  assert.equal(v[101].terminal, "done"); // stable=3
});

test("文本变化重置稳定计数", () => {
  const j = createJudge(0, "", FAST);
  const v = run(j, [
    ok(1, false, "a"), ok(1, false, "a"), // st: 0,1
    ok(1, false, "b"), // 变了 → 0
    ok(1, false, "b"), ok(1, false, "b"), ok(1, false, "b"), // 1,2,3 → done
  ]);
  assert.equal(v[2].terminal, null);
  assert.equal(v[5].terminal, "done");
  assert.equal(v[5].text, "b");
});

test("上限收摊：landed 有部分文本按 truncated（可能被截断）", () => {
  const j = createJudge(0, "", { ...FAST, maxWaitMs: 5 });
  const v = run(j, [
    ok(1, true, "一"), ok(1, true, "一二"), ok(1, true, "一二三"),
    ok(1, true, "一二三四"), ok(1, true, "一二三四五"),
  ]);
  assert.equal(v[4].terminal, "truncated");
  assert.equal(v[4].text, "一二三四五");
});

test("上限内完成优先于收摊", () => {
  const j = createJudge(0, "", { ...FAST, maxWaitMs: 5 });
  const v = run(j, [
    ok(1, true, "答案"), ok(1, true, "答案"), ok(1, true, "答案"),
    ok(1, false, "答案"), ok(1, false, "答案"),
  ]);
  assert.equal(v[3].terminal, "done");
});

test("终态幂等：done 之后继续喂数返回同一判定", () => {
  const j = createJudge(0, "", FAST);
  run(j, [
    ok(1, false, "答案"), ok(1, false, "答案"), ok(1, false, "答案"), ok(1, false, "答案"),
  ]);
  const again = j.tick(ok(1, false, "别的"));
  assert.equal(again.terminal, "done");
  assert.equal(again.text, "答案");
});
