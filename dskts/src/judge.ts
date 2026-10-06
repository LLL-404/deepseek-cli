// judge（T1.4）：完成判定的纯函数核心。不碰任何 IO——读数由调用方（keeper 页面层）
// 每拍喂进来，这里只做状态迁移；node:test 注入假读数离线测试（对齐现版 14 项思路）。
//
// 语义对齐现版 answer_state + wait_for_answer，并吸收 Gate 实证（output/gate-结果.md）：
//   落地（F-1）  最后容器文本离开提交前那条且非空即落地；count 无论增减都不可作必要条件
//                （虚拟列表双向回收）。
//   完成        双信号：文本连续 stableNeed 拍不变 且 至少等过 minWait 且 最后一拍不 busy
//                ——页面还挂着「停止」时文本再稳也不算完，否则生成中途一停顿就把半截
//                答案当成品。
//   读数抖动    单拍失败当空采样跳过；连挂 readFailMax 拍收摊：已拿到的字数按截断返回，
//                一个字没有按 noRender 报错——问题已经提交了，能捞回多少是多少。
//   总上限      到 maxWait 仍没完成就收摊（不分段，规格 D8）：见过回合按 truncated 返回
//                已得文本；从未见过回合按 noRender（Gate F-3 偶发黑洞，调用方应刷新重取
//                或报错带证据，不得当空答案返回）。

export type Sample = { text: string; busy: boolean; count: number };
export type Reading = { ok: true; sample: Sample } | { ok: false; error: unknown };

export type JudgeConfig = {
  tickMs: number;
  minWaitMs: number;
  stableNeed: number;
  readFailMax: number;
  maxWaitMs: number;
};

export type Terminal = "done" | "truncated" | "noRender" | "readsGaveUp";

export type TickVerdict = {
  /** 是否已见新回合（一旦为真持续为真） */
  landed: boolean;
  /** 终态；非空时 tick 序列应停止 */
  terminal: Terminal | null;
  /** 当前已得文本（trim 后；终态前是最后一拍看到的文本） */
  text: string;
  waitedMs: number;
};

type Internal = {
  landed: boolean;
  terminal: Terminal | null;
  last: string;
  stable: number;
  waitedMs: number;
  failRun: number;
};

export type Judge = {
  /** 每物理一拍调用一次；终态后继续调用返回同一判定（幂等） */
  tick(reading: Reading): TickVerdict;
};

export function createJudge(
  countBefore: number,
  lastBefore: string,
  config: JudgeConfig
): Judge {
  const st: Internal = {
    landed: false,
    terminal: null,
    last: "",
    stable: 0,
    waitedMs: 0,
    failRun: 0,
  };
  const lastBeforeTrim = lastBefore.trim();

  const verdict = (): TickVerdict => ({
    landed: st.landed,
    terminal: st.terminal,
    text: st.last,
    waitedMs: st.waitedMs,
  });

  const finish = (t: Terminal) => {
    st.terminal = t;
  };

  // 上限收摊：见过回合且有文本 = truncated；否则 = noRender
  const capOut = (): TickVerdict => {
    finish(st.landed && st.last ? "truncated" : "noRender");
    return verdict();
  };

  return {
    tick(reading: Reading): TickVerdict {
      if (st.terminal) return verdict();
      st.waitedMs += config.tickMs;

      if (!reading.ok) {
        st.failRun += 1;
        if (st.failRun >= config.readFailMax) {
          // 有字按可能截断收，一个字没有按 noRender——问题已经提交了，能捞回多少是多少
          finish(st.landed && st.last ? "truncated" : "noRender");
        }
        return verdict();
      }
      st.failRun = 0;

      const s = reading.sample;
      const txt = (s.text || "").trim();

      if (!st.landed) {
        // 现版 answer_state 的落地认法（忠实平移 + Gate F-1）
        const pending =
          s.count === 0 || !txt || (s.count <= countBefore && txt === lastBeforeTrim);
        if (!pending) st.landed = true;
      }

      if (st.landed) {
        if (txt && txt === st.last && st.waitedMs >= config.minWaitMs) {
          st.stable += 1;
          if (st.stable >= config.stableNeed && !s.busy) finish("done");
        } else {
          st.stable = 0;
        }
        st.last = txt;
      }

      if (!st.terminal && st.waitedMs >= config.maxWaitMs) return capOut();
      return verdict();
    },
  };
}
