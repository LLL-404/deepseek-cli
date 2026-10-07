// askflow（编排·keeper 侧）：一次提问的完整时序（规格第二节 1~11 步）。
// keeper 模型下流程顺序驻留在 keeper 进程内（它持有 page 与 judge）——
// 这是对规格第四节「编排层在 CLI」表的一处已记录偏离，理由见 D7；CLI 侧 commands 只负责
// 参数、连 keeper、收发帧与退出码映射。
import type { Page } from "playwright";
import { homeTitleFor } from "./agent.ts";
import { CHAT_URL } from "./constants.ts";
import {
  attachFile, convAnchorsWait, fillAndVerify, guardNotBusy, gotoChat, judgeLoop,
  makeJudge, readOnce, renameTo, selectSession, setToggles, submitWithVerify,
  FlowError,
} from "./pageops.ts";

export type AskParams = {
  question: string;
  /** 本次调用的归属前缀（Agent 识别结果），形如 WorkBuddy｜ */
  mark: string;
  chat?: string | null;
  files?: string[];
  maxWaitMs: number;
  /** --stream：每拍把答案增量发给 CLI（keeper→CLI 中间帧） */
  emit?: (data: unknown) => void;
};

export type AskResult = {
  answer: string;
  truncated: boolean;
  convId: string | null;
  created: boolean;
  seconds: number;
};

type Log = (m: string) => void;

export async function askFlow(page: Page, params: AskParams, log: Log): Promise<AskResult> {
  const t0 = Date.now();
  // 导航到 chat 首页。CLI 在 ask 前刚跑过 checkLogin（同一条命令内、刚导航过同一页），
  // 页面已在 chat 域名时跳过这次重复整页加载（P1：每问省一次导航）。
  if (!page.url().startsWith(CHAT_URL)) await gotoChat(page);
  const choice = await selectSession(page, params.chat ?? null, params.mark, log);
  let created = false;
  if (choice.kind === "nav") {
    await page.goto(`https://chat.deepseek.com/a/chat/s/${choice.id}`, {
      waitUntil: "domcontentloaded", timeout: 60_000,
    });
    // 旧 Python 版导航后固定 sleep 4s；这里留 2.5s——预读快照必须等「最后一条容器」稳定为上一答，
    // 否则 count_before/last_before 会带着半渲染状态进 judge。
    await page.waitForTimeout(2_500);
  } else {
    created = true;
  }
  await setToggles(page);
  for (const f of params.files ?? []) await attachFile(page, f, log);
  await fillAndVerify(page, params.question);
  await guardNotBusy(page);
  const pre = await readOnce(page);
  log("已填入并回读一致，提交中…");
  await submitWithVerify(page, params.question, log);

  // 等待判定；noRender 时按 Gate F-3 刷新重取一次。
  // --stream 时每拍把答案增量发给 CLI（文本只增假设成立；缩短则发 reset 全量）。
  let sent = 0;
  const emitDelta = (text: string): void => {
    if (!params.emit) return;
    if (text.length < sent) {
      params.emit({ type: "reset", text });
      sent = text.length;
      return;
    }
    if (text.length > sent) {
      params.emit({ type: "delta", text: text.slice(sent) });
      sent = text.length;
    }
  };
  let judge = makeJudge(pre.count, pre.text, params.maxWaitMs);
  let loop = await judgeLoop(page, judge, log, emitDelta);
  if (loop.terminal === "noRender") {
    log("  提交后未见回合，刷新会话页重取一次（Gate F-3 对策）");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3_000);
    const re = await readOnce(page);
    judge = makeJudge(re.count, re.text, params.maxWaitMs);
    sent = 0; // 刷新后基线重建，全量重发
    loop = await judgeLoop(page, judge, log, emitDelta);
  }
  if (loop.terminal === "noRender") {
    const d = await readOnce(page).catch(() => ({ count: -1, busy: false, text: "" }));
    throw new FlowError(
      `提交后两轮共 ${Math.round(params.maxWaitMs / 500)}s 没等到新回合（无渲染黑洞或被吞）。\n` +
      `  停在 ${page.url()}\n  正文容器 ${d.count} 条，生成中=${d.busy}`
    );
  }
  const answer = loop.text;

  let convId: string | null = null;
  const href = page.url();
  if (href.includes("/a/chat/s/")) {
    convId = href.split("/a/chat/s/")[1]?.split(/[?#]/)[0] ?? null;
  }
  if (created && convId) {
    try {
      await renameTo(page, convId, homeTitleFor(params.mark), params.mark, log);
    } catch (exc) {
      log(`  改名这步出错，答案不受影响：${(exc as Error).message}`);
    }
  }
  return {
    answer,
    truncated: loop.terminal === "truncated",
    convId,
    created,
    seconds: (Date.now() - t0) / 1000,
  };
}
