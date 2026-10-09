// 顾问桥 v2：网页 DeepSeek 当「脑」（总架构师：质疑目标、侦察、定阶段、根因、重规划、
// 必要时自己写脚本），本地执行器当「手」，state.md 当「记忆」。
//
// 协议形状（2026-10-09 与作者改定）：顾问的回复 = 随便写的思考文字 + 恰好一个 ```STATE 块
// + 一个 ```EXEC 多步块。执行器**只读这两个块**，块外的字一概不看——这样它既能充分思考，
// 又不会把弱执行器绕晕。STATE 每轮由顾问全量重写、本地整块覆盖，这就是跨轮记忆：
// 网页端上下文跨会话不互通，所以每轮简报必须自包含。
//
// 三个子命令：
//   ask  = 生成自包含简报 → 经 dskts 发给顾问 → 解析两块 → 原文落 advice.txt、STATE 落 state.md
//   act  = 逐步过闸门 → 按 STEP 顺序执行 → 每步结果写穿 state.md → 失败/未判定即停
//   run  = ask+act 循环，直到 done / 待人 / 不合规 / 轮数上限
//
// 本文件分两段：纯函数（离线可测，见 tests/bridge.test.ts）与编排（要起 dskts、要跑命令）。
// 传输层复用同目录的 dskts（stdin 灌简报、--out 落盘读答案），不新造浏览器自动化。
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { EXIT_ERROR, EXIT_OK, EXIT_PREREQ } from "./constants.ts";

// —— 词表与上限（桥自己的常量，不进 constants.ts：那份自限「只登记页面结构常量」）——

/** 执行器真有的动作。规格里还列了 browser_open / browser_click / browser_type / screenshot，
 *  本桥没有实现——桥摸不到 keeper 里的 page，列进词表只会让顾问发出执行器跑不了的指令
 *  （规格自己的防呆第 3 条：动作集只允许它实际有的工具）。
 *  v1 的 request_info 去掉了：多步 EXEC 本身就用来「先侦察」，未决问题走 STATE.未决问题。 */
export const ACTIONS = ["shell", "python", "read_file", "write_file", "ask_user", "done"] as const;
export type Action = (typeof ACTIONS)[number];

export const BRIEF_MAX_CHARS = 6_000; // 超长直接报错，不静默截断（外发内容要可控）
export const RECENT_ROUNDS = 3; // 简报只带最近 3 轮，不带全部历史（规格要求）
export const PLAN_FIELD_CHARS = 300; // STATE 单字段进简报的逐字上限
export const PLAN_LIST_ITEMS = 6; // 列表型字段（已完成/待办/关键决策）只带最近 N 项
export const OUTPUT_SUMMARY_CHARS = 600; // 记进 state.md 的输出摘要上限
export const READ_FILE_CHARS = 4_000; // read_file 回给顾问的字数上限
export const FAIL_OUT_CHARS = 1_500; // 失败简报里带的输出量
export const CMD_TIMEOUT_MS = 120_000;
/** 一轮最多几步。超过就整批拒——静默截断会跑出「顾问没打算一起跑的组合」，
 *  比拒了重问危险得多（同 CMD 跨行不截断的旧纪律）。 */
export const MAX_STEPS_PER_ROUND = 8;
/** 命令输出上限。2026-10-09 实测到一条失控命令产出 1.3 亿字（见 cmdEnv 的缘由），
 *  不设上限就是让顾问的一句话能吃光内存；超限直接杀命令并写清截断。 */
export const OUTPUT_CAP_BYTES = 256 * 1024;
export const DEFAULT_ROUNDS = 12;
export const BRIDGE_MARK = "Bridge"; // 顾问会话的归属前缀，别蹭 Qoder 的连续会话
/** 执行器的账本，顾问不许隔着 write_file 改。 */
export const PROTECTED_FILES = ["state.md", "advice.txt", "ask.txt"];

// —— STATE 块（顾问的滚动记忆）——

export type Plan = {
  phase: string; goal: string; success: string;
  doneItems: string; todo: string; decisions: string; open: string;
};

/** [字段名, 块里用的中文标签]。列表型字段的下标也在这张表里，压缩规则按它判。 */
export const PLAN_FIELDS: readonly [keyof Plan, string][] = [
  ["phase", "阶段"], ["goal", "目标"], ["success", "成功标准"], ["doneItems", "已完成"],
  ["todo", "待办"], ["decisions", "关键决策"], ["open", "未决问题"],
];

export const emptyPlan = (): Plan =>
  ({ phase: "", goal: "", success: "", doneItems: "", todo: "", decisions: "", open: "" });

// —— EXEC 块（多步执行包）——

export type ExecStep = {
  step: number; action: Action; cmd: string; expect: string; onFail: string; danger: boolean;
};

const PLAN_LABEL_RE = new RegExp(`^(${PLAN_FIELDS.map(([, l]) => l).join("|")})\\s*[:：]\\s*(.*)$`);
const EXEC_FIELD_RE = /^(STEP|ACTION|CMD|EXPECT|ON_FAIL|DANGER)\s*[:：]\s*(.*)$/i;
/** 围栏：开栏带语言标记（```STATE / ````EXEC），闭栏必须是**同数量或更多的裸反引号行**
 *  （CommonMark）。模型爱用四反引号包住含三反引号的命令，判错就会把命令内容吃掉半截。 */
const FENCE_RE = /^\s*(`{3,})([A-Za-z_]*)\s*$/;

// —— CMD 交给谁跑 ——

/** Windows 默认 cmd.exe 并先 chcp 65001，让中文输出是 UTF-8 而不是 GBK；
 *  可用 BRIDGE_SHELL=bash / powershell 改。简报里会把实际用的 shell 告诉顾问，
 *  它才知道该按哪种语法写命令（`;` 在 cmd 里不是分隔符，这类坑只能靠说明避免）。
 *
 *  cmd.exe 这条必须 `verbatim: true`：Node 默认的 argv 转义会把命令里的 `""` 写成 `\"\"`，
 *  而 cmd 不认反斜杠转义——2026-10-09 实测 `dir /b | find /c /v ""` 因此变成让 find 去读
 *  根目录，报 `Access denied - \`。改成自己按 cmd 的 `/s` 规则加一层外引号（cmd 会脱掉
 *  首尾引号后原样执行），并让 Node 别再动这些参数。 */
export function shellSpec(platform: string = process.platform): {
  name: string; verbatim: boolean; argv: (cmd: string) => string[];
} {
  const want = (process.env.BRIDGE_SHELL ?? "").trim().toLowerCase();
  if (want === "bash" || want === "sh") return { name: "bash", verbatim: false, argv: (c) => ["bash", "-c", c] };
  if (want === "powershell") {
    return { name: "powershell", verbatim: false, argv: (c) => ["powershell.exe", "-NoProfile", "-Command", c] };
  }
  if (platform === "win32") {
    return {
      name: "cmd.exe", verbatim: true,
      argv: (c) => ["cmd.exe", "/d", "/s", "/c", `"chcp 65001>nul&&${c}"`],
    };
  }
  return { name: "sh", verbatim: false, argv: (c) => ["sh", "-c", c] };
}

// —— 危险闸门 ——

/** 关键词级，代码里的，不接受任何参数关闭——守卫一旦可注入就等于没有（既有纪律）。
 *  宁可多拦（代价是要人确认一次）也不漏拦（代价是数据或钱）。
 *  中文关键词不能用 \b：`支付` 两侧都不是 \w，压根没有词边界（2026-10-09 实测漏过一次），
 *  所以 ASCII 词与 CJK 词分成两条正则。 */
const DANGER_PATTERNS: readonly { re: RegExp; why: string }[] = [
  { re: /\b(del|erase|rd|rmdir|rm|Remove-Item|unlink|shred|Clear-RecycleBin)\b/i, why: "删除文件/目录" },
  { re: /删除|删掉|清空回收站/, why: "删除文件/目录" },
  { re: /\b(format|diskpart|mkfs|fdisk)\b/i, why: "格盘或改分区" },
  // 重定向到 nul / /dev/null、以及 2>&1 这种文件描述符复制，都不是覆盖
  // （2026-10-09 实测两次误拦：`dir 2>nul | find /c /v ""` 与 `node x.js >/dev/null 2>&1`；
  //  闸门误拦等于把工具废掉。采纳哨兵写法后又多出一种形状：`A && echo __OK__` 不是覆盖）
  { re: /(^|[^>])>(?!>|\s*&|\s*nul\b|\s*\/dev\/null\b)|\b(Out-File|Set-Content|Tee-Object)\b|--force\b|\bcp\s+-f\b|\/Y\b/i, why: "覆盖已有文件" },
  { re: /\b(pay|payment|checkout|purchase)\b/i, why: "支付或下单" },
  { re: /支付|付款|下单|购买|订单|结账/, why: "支付或下单" },
  { re: /\b(send|post|publish|push|tweet|webhook|mail)\b/i, why: "对外发送内容" },
  { re: /发邮件|发消息|发送|推送|群发|发帖/, why: "对外发送内容" },
  { re: /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/i, why: "对外网络请求（可能外发数据）" },
  { re: /\b(npm\s+i|npm\s+install|pip\s+install|pip3\s+install|winget|choco|scoop|apt-get|apt\s+install|brew\s+install|Install-Package)\b/i, why: "安装软件" },
  { re: /\b(reg\s+(add|delete|import)|Set-ItemProperty|New-ItemProperty|netsh|schtasks|Set-Service|sc\s+(config|create|delete)|bcdedit|shutdown|restart-computer)\b/i, why: "改系统设置/服务/计划任务" },
  { re: /\b(taskkill|Stop-Process|kill|killall)\b/i, why: "杀进程" },
  { re: /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--|restore\s+--)\b/i, why: "改远端或丢弃工作区" },
];

export type DangerVerdict = { danger: boolean; why: string[] };

export function classifyDanger(cmd: string): DangerVerdict {
  const why = DANGER_PATTERNS.filter((p) => p.re.test(cmd)).map((p) => p.why);
  return { danger: why.length > 0, why: [...new Set(why)] };
}

/** 单步的待人判据：**顾问声明与本地关键词扫描取并集**，两边都说安全才算安全。
 *  只信声明——顾问看不到本机，它标的 no 是意图层面的；只信扫描——它抓不到
 *  「这条命令在这台机器上会碰到什么」之外的语义。两个各看一半。 */
export function stepGate(s: ExecStep): { need: boolean; why: string[] } {
  const scan = classifyDanger(s.cmd);
  const why = [...(s.danger ? ["顾问声明（DANGER: yes）"] : []), ...scan.why];
  return { need: why.length > 0, why: [...new Set(why)] };
}

// —— EXPECT 的机械判定 ——

export type ExpectVerdict = "满足" | "不满足" | "未判定";

/** 只认五种机械形式，其余一律「未判定」：
 *   exit=N / 退出码 N、包含:X、不含:X、regex:X、非空
 *  为什么这么死板：执行器智力有限，把散文式预期（「应该列出文件名」）交给它判，
 *  它会把任何输出都读成满足。未判定不等于满足——runSteps 会因此停下（stepDecision），
 *  因为 2026-10-09 那轮问答里说中了一条：不可判定往往就是编码/CRLF/吞行这类
 *  会连续复现的字节问题，放过去就是基于错假设继续动手。 */
export function checkExpect(expect: string, rc: number, out: string): ExpectVerdict {
  const e = (expect ?? "").trim();
  const hay = (out ?? "").toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^(?:exit|退出码)\s*=?\s*(-?\d+)$/i.exec(e))) {
    return rc === Number(m[1]) ? "满足" : "不满足";
  }
  if ((m = /^包含\s*[:：]\s*([\s\S]+)$/i.exec(e))) {
    return hay.includes(m[1].trim().toLowerCase()) ? "满足" : "不满足";
  }
  if ((m = /^不含\s*[:：]\s*([\s\S]+)$/i.exec(e))) {
    return hay.includes(m[1].trim().toLowerCase()) ? "不满足" : "满足";
  }
  if ((m = /^regex\s*[:：]\s*([\s\S]+)$/i.exec(e))) {
    try {
      return new RegExp(m[1], "i").test(out ?? "") ? "满足" : "不满足";
    } catch {
      return "未判定"; // 正则本身写坏了：不能当成满足放行
    }
  }
  if (/^非空$/.test(e)) return (out ?? "").trim() ? "满足" : "不满足";
  return "未判定";
}

/** 这一步之后批内还继续吗（纯函数，离线可测）。
 *  失败、不满足、未判定都停批——停下来的东西原样带回给顾问，正是这套桥的用途。
 *  done 收工返 0；ask_user 交回给人返 2。 */
export type StopReason = "全部完成" | "失败即停" | "未判定即停" | "待人" | "顾问判定done" | "不合规";

export function stepDecision(
  action: Action, rc: number, verdict: ExpectVerdict
): { stop: boolean; stopped: StopReason; rc: number } {
  if (action === "done") return { stop: true, stopped: "顾问判定done", rc: EXIT_OK };
  if (action === "ask_user") return { stop: true, stopped: "待人", rc: EXIT_PREREQ };
  if (rc !== EXIT_OK) return { stop: true, stopped: "失败即停", rc: EXIT_ERROR };
  if (verdict === "不满足") return { stop: true, stopped: "失败即停", rc: EXIT_ERROR };
  if (verdict === "未判定") return { stop: true, stopped: "未判定即停", rc: EXIT_ERROR };
  return { stop: false, stopped: "全部完成", rc: EXIT_OK };
}

// —— 顾问回复的解析与渲染 ——

export type Reply = { plan: Plan; steps: ExecStep[] };
export type ReplyErr = { error: string };

const isErr = (v: unknown): v is ReplyErr =>
  typeof v === "object" && v !== null && "error" in (v as Record<string, unknown>);

/** 从回复里取出某个标签的围栏块正文。出现两块同标签就报错——取第一个会静默丢掉一半记忆，
 *  而记忆丢了下一轮简报就再也补不回来（顾问每轮只看简报，它不知道自己写过什么）。 */
export function extractBlock(text: string, tag: "STATE" | "EXEC"): { body: string } | ReplyErr {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const found: string[][] = [];
  let open: { fence: number; tag: string | null; buf: string[] } | null = null;
  for (const line of lines) {
    const f = FENCE_RE.exec(line);
    if (open) {
      // 闭栏：裸反引号行（无语言标记），且长度不少于开栏
      if (f && f[2] === "" && f[1].length >= open.fence) {
        found.push(open.buf);
        open = null;
      } else open.buf.push(line);
      continue;
    }
    if (f) {
      const info = f[2].toUpperCase();
      if (info === "" || info === tag) open = { fence: f[1].length, tag: info === "" ? null : tag, buf: [] };
      else open = { fence: f[1].length, tag: "OTHER", buf: [] }; // 别的语言的围栏：整块跳过
      continue;
    }
    // 围栏外没有内容可取（思考文字一概不看，这是分工的正面体现）
  }
  if (open) {
    found.push(open.buf); // 模型忘了闭栏：内容仍然要看见，不能因此丢整块
  }
  const mine = found.filter((buf) => {
    const body = buf.join("\n");
    // 无标记的围栏靠内容归类：有 STEP: 就是 EXEC，有 STATE 标签就是 STATE
    if (tag === "EXEC") return /^STEP\s*[:：]/im.test(body);
    return PLAN_LABEL_RE.test((body.split("\n").find((l) => l.trim()) ?? "").trim());
  });
  if (mine.length === 0) return { error: `回复里没有 ${tag} 块（只读 STATE 与 EXEC 两个代码块）` };
  if (mine.length > 1) return { error: `回复里有两个 ${tag} 块：不知道以哪块为准，请只写一个` };
  return { body: mine[0].join("\n") };
}

/** STATE 块正文 → Plan。字段值可以多行（无标签的续行接在当前字段后面）。
 *  但「看着像标签、却不认识」的行**不能**当续行吞进上一个字段：顾问把「已完成」写成
 *  「已完成事项」时，整段待办会被并进已完成——那是记忆串味，比丢一行更坏。
 *  这种行直接丢弃并把累积关掉；简报会原样带上解析后的字段，人一眼看得出它漏了哪个。 */
export function parsePlanBlock(body: string): Plan | ReplyErr {
  const p = emptyPlan();
  const labelToKey = new Map(PLAN_FIELDS.map(([k, l]) => [l, k] as [string, keyof Plan]));
  let current: keyof Plan | null = null;
  for (const raw of (body ?? "").split("\n")) {
    const line = raw.trim().replace(/^[-*]\s*/, ""); // 模型爱给字段加项目符号
    const m = PLAN_LABEL_RE.exec(line);
    if (m) {
      const key = labelToKey.get(m[1])!;
      current = key;
      p[key] = p[key] ? `${p[key]}\n${m[2].trim()}` : m[2].trim();
      continue;
    }
    if (!line) continue;
    if (/^[^：:]{1,24}[：:]/.test(line)) { current = null; continue; } // 像标签不认识 → 断开
    if (current) p[current] = `${p[current]}\n${line}`;
  }
  return p;
}

/** EXEC 块正文 → 多步。切步只认「`---` 且之后第一个非空行是 STEP:」——
 *  write_file 的内容里出现 `---` 不能被当成步骤分隔。 */
export function parseExecBlock(body: string): ExecStep[] | ReplyErr {
  const chunks = splitOnDash((body ?? "").replace(/\r\n?/g, "\n")).filter((t) => t.trim());
  if (chunks.length > MAX_STEPS_PER_ROUND) {
    return { error: `一轮给了 ${chunks.length} 步，上限 ${MAX_STEPS_PER_ROUND} 步：请拆到下一轮，后续步骤写进 STATE.待办` };
  }
  const steps: ExecStep[] = [];
  for (const chunk of chunks) {
    const s = parseOneStep(chunk.split("\n"), steps.length + 1);
    if (isErr(s)) return s;
    steps.push(s);
  }
  if (!steps.length) return { error: "EXEC 块里一步都没有" };
  return steps;
}

/** 把「STEP:」开头的段落当成新步切开；正文里的 `---` 不算。 */
function splitOnDash(text: string): string[] {
  const lines = text.split("\n");
  const out: string[][] = [[]];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^-{3,}$/.test(line)) {
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (next && /^STEP\s*[:：]/i.test(next.trim())) { out.push([]); continue; }
    }
    out[out.length - 1].push(lines[i]);
  }
  return out.map((l) => l.join("\n"));
}

const DANGER_YES = ["yes", "y", "true", "有", "是", "危险"];
const DANGER_NO = ["no", "n", "false", "", "-", "无", "否", "安全"];

function parseOneStep(chunk: string[], idx: number): ExecStep | ReplyErr {
  const seen = new Map<string, string[]>();
  let current: string | null = null;
  for (const raw of chunk) {
    const line = raw.trim();
    const m = EXEC_FIELD_RE.exec(line);
    if (m) {
      const key = m[1].toUpperCase();
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key)!.push(m[2].trim());
      current = key;
      continue;
    }
    // 非字段行接在当前字段后面：多行命令必须**看见全貌才能拒**，
    // 只取第一行会把命令静默截断成半条再执行——那比拒绝危险得多（v1 实测教训）。
    if (current && line) seen.get(current)!.push(line);
  }
  const get = (k: string): string | undefined =>
    seen.has(k) ? seen.get(k)!.join("\n").trim() : undefined;

  const declared = Number((get("STEP") ?? "").trim());
  const label = Number.isFinite(declared) && declared > 0 ? declared : idx;
  const rawAction = get("ACTION");
  if (rawAction === undefined) return { error: `第 ${label} 步缺 ACTION` };
  const action = rawAction.toLowerCase().replace(/[^a-z_]/g, "") as Action;
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return { error: `第 ${label} 步的动作「${rawAction}」不在词表里（可用：${ACTIONS.join(" / ")}）` };
  }
  const missing = (["CMD", "EXPECT", "ON_FAIL", "DANGER"] as const).filter((k) => get(k) === undefined);
  if (missing.length) return { error: `第 ${label} 步缺 ${missing.join("、")}` };

  const cmd = get("CMD")!;
  const expect = get("EXPECT")!;
  const onFail = get("ON_FAIL")!;
  const dangerRaw = get("DANGER")!.toLowerCase().replace(/\s/g, "");
  const danger = DANGER_YES.includes(dangerRaw) ? true : DANGER_NO.includes(dangerRaw) ? false : null;
  if (danger === null) {
    return { error: `第 ${label} 步的 DANGER 值是「${get("DANGER")}」，只许写 no 或 yes（模糊值等于没标）` };
  }
  if ((action === "shell" || action === "python" || action === "read_file" || action === "write_file") && !cmd) {
    return { error: `第 ${label} 步 ACTION=${action} 但 CMD 是空的` };
  }
  const multiLine = cmd.split("\n").filter((l) => l.trim()).length > 1;
  if (multiLine && action !== "write_file" && action !== "python") {
    return { error: `第 ${label} 步 CMD 跨了多行：只有 write_file 与 python 允许多行，其余请用 write_file 先落成脚本再一行调用` };
  }
  return { step: label, action, cmd, expect, onFail, danger };
}

/** 唯一入口：回复全文 → { plan, steps }。任何不合规都返回 error 且**不执行任何东西**。
 *  缺 EXEC 是合法的（顾问这一轮只想更新记忆/要信息），缺 STATE 不合法（记忆会断）。 */
export function parseReply(text: string): Reply | ReplyErr {
  const st = extractBlock(text, "STATE");
  if (isErr(st)) return st;
  const plan = parsePlanBlock(st.body);
  if (isErr(plan)) return plan;
  const ex = extractBlock(text, "EXEC");
  if (isErr(ex)) {
    // 完全没有 EXEC 块时，区分「顾问这一轮没给活」和「它没守格式」：
    // 有 ACTION: 字样说明它还在写 v1 四行，那要指名，不能当空批放过去。
    if (/^\s*ACTION\s*[:：]/im.test(text ?? "")) {
      return { error: "这是 v1 的四行格式：STATE 与 EXEC 两个代码块都缺，本桥只吃 v2" };
    }
    return { plan: plan as Plan, steps: [] };
  }
  const steps = parseExecBlock(ex.body);
  if (isErr(steps)) return steps;
  return { plan: plan as Plan, steps };
}

export function renderReply(r: Reply): string {
  const plan = PLAN_FIELDS.map(([k, l]) => `${l}：${r.plan[k]}`).join("\n");
  const blocks = ["```STATE", plan, "```"];
  if (r.steps.length) {
    const body = r.steps.map((s) =>
      ["STEP: " + s.step, "ACTION: " + s.action, "CMD: " + s.cmd, "EXPECT: " + s.expect,
        "ON_FAIL: " + s.onFail, "DANGER: " + (s.danger ? "yes" : "no")].join("\n")
    ).join("\n---\n");
    blocks.push("```EXEC", body, "```");
  }
  return blocks.join("\n");
}

// —— state.md：两个区，一个整块覆盖、一个只追加 ——

export type StepRecord = {
  round: number; k: number; of: number; step: number; action: Action;
  cmd: string; expect: string; verdict: string; summary: string;
};

export type State = { goal: string; env: string; status: string; plan: Plan; rounds: StepRecord[] };

const ROUND_HEAD = "### 第 ";
const PLAN_ZONE = "## 顾问记忆";
const ROUNDS_ZONE = "## 轮次记录";

/** 把输出压成单行摘要：换行换成 ⏎，超长截断并写清截了多少字。
 *  单行是为了 state.md 好解析、简报好携带。 */
export function summarizeOutput(text: string, max = OUTPUT_SUMMARY_CHARS): string {
  const flat = (text ?? "").replace(/\r?\n/g, " ⏎ ").trim();
  if (flat.length <= max) return flat || "（无输出）";
  return `${flat.slice(0, max)}…（截断，原 ${flat.length} 字）`;
}

export function parseState(md: string): State {
  const text = (md ?? "").replace(/\r\n?/g, "\n");
  const head = text.split(new RegExp(`^${PLAN_ZONE}\\s*$`, "m"))[0];
  const pick = (label: string): string => {
    const m = new RegExp(`^${label}：([\\s\\S]*?)(?=^\\S+：|^##|$)`, "m").exec(head);
    return m ? m[1].trim() : "";
  };
  const plan = emptyPlan();
  const zone = text.split(new RegExp(`^${PLAN_ZONE}\\s*$`, "m"))[1];
  if (zone) {
    const body = zone.split(new RegExp(`^${ROUNDS_ZONE}\\s*$`, "m"))[0];
    const p = parsePlanBlock(body);
    if (!isErr(p)) Object.assign(plan, p);
  }
  const rounds: StepRecord[] = [];
  const tail = text.split(/^## 轮次记录\s*$/m)[1] ?? "";
  for (const block of tail.split(/^### /m).slice(1)) {
    const g = (re: RegExp): string => (re.exec(block)?.[1] ?? "").trim();
    // 轮次与步骤序号都写在标题行上（### 第 2 轮 步骤 1/3）。曾经只在这里取轮次、
    // k/of 去找一个不存在的字段行，结果重读一遍 state.md 步骤号全退成 1/1——
    // 往返必须把这两个值取回来，简报的「最近 3 轮」和失败简报的步骤定位都靠它。
    const head = /^第 (\d+) 轮(?: 步骤 (\d+)\/(\d+))?/m.exec(block);
    const n = Number(head?.[1] ?? 0);
    const action = g(/^- ACTION: (\S+)/m) as Action;
    const cmd = g(/^- CMD: ([\s\S]*?)(?=^- )/m);
    if (!cmd) continue; // v1 留下的空壳条目没有意义
    rounds.push({
      round: n,
      k: Number(head?.[2] ?? 1),
      of: Number(head?.[3] ?? 1),
      step: Number(/^- STEP: (\d+)/m.exec(block)?.[1] ?? n),
      action, cmd,
      expect: g(/^- EXPECT: ([\s\S]*?)(?=^- )/m),
      verdict: g(/^- 结果: ([\s\S]*?)(?=^- )/m),
      summary: g(/^- 输出摘要: ([\s\S]*?)(?=$)/m),
    });
  }
  return { goal: pick("目标"), env: pick("环境"), status: pick("当前状态"), plan, rounds };
}

export function renderState(s: State): string {
  const lines = [
    "# 任务状态", "",
    `目标：${s.goal}`, "",
    `环境：${s.env}`, "",
    `当前状态：${s.status}`, "",
    PLAN_ZONE, "",
    ...PLAN_FIELDS.map(([k, l]) => `- ${l}：${s.plan[k]}`), "",
    ROUNDS_ZONE, "",
  ];
  for (const r of s.rounds) {
    lines.push(
      `${ROUND_HEAD}${r.round} 轮 步骤 ${r.k}/${r.of}`,
      `- STEP: ${r.step}`,
      `- ACTION: ${r.action}`,
      `- CMD: ${r.cmd}`,
      `- EXPECT: ${r.expect}`,
      `- 结果: ${r.verdict}`,
      `- 输出摘要: ${r.summary}`,
      ""
    );
  }
  return lines.join("\n");
}

export function appendStep(s: State, r: StepRecord): State {
  return {
    ...s, rounds: [...s.rounds, r],
    status: `第 ${r.round} 轮 步骤 ${r.k}/${r.of}（${r.action}）：${r.verdict}`,
  };
}

/** 整块覆盖：滚动记忆的语义就是「顾问这一轮的版本是最新的」。
 *  实现成追加会让 STATE 每轮变长，简报先撞上限（v2 那轮问答里这是差异式记忆的崩坏条件之一）。 */
export function mergePlan(s: State, p: Plan): State {
  return { ...s, plan: { ...p } };
}

// —— 自包含简报 ——

/** 简报里的字段压缩策略：逐字类各留 300 字；列表类折叠成「共 N 项，只列最近 6 项」。
 *  先折叠、折叠完仍超上限才报错——外发内容必须可控，但一个长待办不该让整轮卡死。 */
function foldPlanField(key: keyof Plan, value: string): string {
  const v = (value ?? "").trim();
  if (!v) return "（空）";
  const isList = key === "doneItems" || key === "todo" || key === "decisions";
  const items = v.split("\n").map((l) => l.trim()).filter(Boolean);
  if (isList && items.length > PLAN_LIST_ITEMS) {
    const kept = items.slice(-PLAN_LIST_ITEMS);
    return `（折叠，共 ${items.length} 项，只列最近 ${PLAN_LIST_ITEMS} 项）\n${kept.join("\n")}`;
  }
  if (v.length > PLAN_FIELD_CHARS) {
    return `${v.slice(0, PLAN_FIELD_CHARS)}…（截断，原 ${v.length} 字）`;
  }
  return v;
}

export function buildBriefing(s: State, extraError = ""): string | ReplyErr {
  const shell = shellSpec().name;
  const rounds = s.rounds;
  const recentRoundNos = [...new Set(rounds.map((r) => r.round))].slice(-RECENT_ROUNDS);
  const recent = rounds.filter((r) => recentRoundNos.includes(r.round));
  const parts = [
    "【执行器简报】", "",
    "任务契约：",
    `目标：${s.goal || "（未写）"}`,
    `成功标准：${s.plan.success || "（未写）"}`,
    `约束：一轮至多 ${MAX_STEPS_PER_ROUND} 步；CMD 原样交给 ${shell}，执行器不改写、不合并、不猜；`,
    `      输出超 ${Math.round(OUTPUT_CAP_BYTES / 1024)}KB 会被杀；危险动作（删除/覆盖/支付/外发/装软件/改系统/杀进程/丢工作区）一律停下来交给人，`,
    "      且执行器自己还会按关键词扫一遍——你标 DANGER: no 不会让闸门放行。", "",
    `外部记忆 STATE（你上一轮写的，执行器整块覆盖保存；本轮请你全量重写全部 ${PLAN_FIELDS.length} 个字段）：`,
    ...PLAN_FIELDS.map(([k, l]) => `${l}：${foldPlanField(k, s.plan[k])}`), "",
    `环境：${s.env || "（未写）"}`,
    `执行命令用的 shell：${shell}（CMD 原样交给它，请按它的语法写）`,
    `可用动作：${ACTIONS.join(" / ")}`,
    `多行只允许 write_file 与 python 的 CMD；write_file 的 CMD 首行是工作目录内的相对路径、其余是内容`, "",
    `当前状态：${s.status || "（未写）"}`, "",
    `最近执行（最多 ${RECENT_ROUNDS} 轮，最新在最后）：`,
    ...(recent.length
      ? recent.map((r) => `${r.round}.${r.k}/${r.of} ${r.action}：${r.cmd.split("\n")[0]} → ${r.verdict}；输出摘要：${r.summary}`)
      : ["（还没有执行过任何命令）"]), "",
    "当前输出/错误：",
    extraError || recent.at(-1)?.summary || "（无）", "",
    "需要你：1) 形势判断与根因分析（随便写，执行器不看）；2) 全量重写 STATE 块；3) 下一段 EXEC 块。",
  ];
  const text = parts.join("\n");
  if (text.length > BRIEF_MAX_CHARS) {
    return { error: `简报 ${text.length} 字，超过上限 ${BRIEF_MAX_CHARS}——请压缩目标/环境，别让整段日志进来` };
  }
  return text;
}

/** 顾问的系统提示：每一轮都随简报一起发，不依赖会话记忆（上下文不互通是这套设计的前提）。 */
export function advisorPrompt(): string {
  return [
    "你是【远程总顾问】：架构师、诊断专家、项目经理。执行器是一台机器上的弱模型，只会机械执行。",
    "你看不到它的屏幕，只能依据《执行器简报》工作。",
    "你的价值不是「给下一条命令」，而是：质疑目标是否合理、先侦察再动手、划分阶段与检查点、",
    "做根因分析、按失败动态重规划、复杂逻辑由你写成脚本。", "",
    "回复形状：先用自由文字写 ## 形势判断 / ## 全局策略 / ## 风险与回滚（想多长都行，执行器不看这些），",
    "然后给出两个代码块——**只认这两个块**：", "",
    "```STATE",
    ...PLAN_FIELDS.map(([, l]) => `${l}：`),
    "```",
    "七个字段每轮全量重写（执行器整块覆盖，不重发就丢掉）。", "",
    "```EXEC",
    "STEP: 1",
    "ACTION: " + ACTIONS.join("|"),
    "CMD: 要原样执行的命令",
    "EXPECT: 机械预期（见下）",
    "ON_FAIL: 失败时收集并回报什么",
    "DANGER: no|yes",
    "---",
    "STEP: 2",
    "```",
    `步与步用 --- 分隔，一轮最多 ${MAX_STEPS_PER_ROUND} 步；超出的写进 STATE.待办，下一轮再给。`, "",
    "规则：",
    "1. 只依据本次简报，不要假设你记得之前的内容。",
    "2. 信息不足就先侦察：用 shell/read_file 收集，别猜；需要人拍板用 ACTION: ask_user。",
    "3. 完成用 ACTION: done，CMD 写一句话说明完成了什么（done 之后的步骤不会执行）。",
    "4. EXPECT 必须是机械形式，只认这五种：exit=N、退出码 N、包含:X、不含:X、regex:X、非空。",
    "   写成散文（「应该列出文件名」）会被判「未判定」并立即停批。",
    "5. 判成败用哨兵，别用 %ERRORLEVEL%：实测 `命令 & echo __OK__` 在命令失败时也打印哨兵、",
    "   整行退出码还是 0；要用 `命令 && echo __R3_OK__` 配 EXPECT: 包含:__R3_OK__。",
    "   单行里 %ERRORLEVEL% 是解析期展开的，读到的不是刚跑完那条命令的退出码。",
    "6. 复杂逻辑：先 write_file 落成脚本，再一行调用（python 或 shell）。不要用 `>` 重定向写文件，",
    "   那会被闸门当覆盖拦下。write_file 的 CMD 首行=工作目录内的相对路径，其余行=内容；",
    "   已存在的文件不许盖（闸门会拦）。",
    "7. 危险动作（删除、覆盖、支付、对外发送、装软件、改系统设置、杀进程、改远端/丢工作区）标 DANGER: yes，",
    "   并说明要人确认什么。执行器有代码级关键词闸门，标 no 也可能被拦——命中时它会把两边理由一起给人。",
    "8. 步骤失败别让它自己修：在 ON_FAIL 里写清要收集什么，它会把原样输出带回来问你。",
    `9. 一轮最多 ${MAX_STEPS_PER_ROUND} 步；步数、字段、动作名照本契约写，越界整批拒。`,
  ].join("\n");
}

// —— 编排（要起 dskts、要跑命令）——

function log(m: string): void { console.error(m); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DSKTS_ENTRY = path.join(HERE, "dskts.ts");

export type AskOutcome = { answer: string; rc: number; stderr: string };

/** 把简报交给 dskts 发出去。走 stdin（长多行文本不经命令行参数，避开引号与代码页坑），
 *  答案用 --out 落盘再读——终端回显会丢行，落盘文件才是证据。 */
export function askAdvisor(briefing: string, out: string, maxWaitS: number): Promise<AskOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [DSKTS_ENTRY, "--mark", BRIDGE_MARK, "--out", out, "--max-wait", String(maxWaitS)],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      stderr += s;
      process.stderr.write(s); // dskts 的过程日志原样转发
    });
    child.stdout.resume(); // 答案从 --out 读，stdout 丢掉避免重复
    child.on("error", reject);
    child.on("close", (rc) => {
      let answer = "";
      try { answer = fs.readFileSync(out, "utf8").replace(/\n$/, ""); } catch { /* 没落盘就是没答案 */ }
      resolve({ answer, rc: rc ?? EXIT_ERROR, stderr });
    });
    child.stdin.end(briefing);
  });
}

/** 路径必须落在工作目录里面。read/write/python 三个动作共用这条围栏：
 *  读到的内容下一轮会随简报外发给顾问，写/跑外面等于给了一条越狱通道。 */
export function withinDir(root: string, p: string): boolean {
  const r = path.resolve(root);
  const abs = path.resolve(r, p);
  return abs === r || abs.startsWith(r + path.sep);
}

export type RunOutcome = { rc: number; out: string };

/** 执行一步。CMD 来自远端模型，属于**不可信输入**：shell/python 过危险闸门，
 *  read_file/write_file/python 另有工作目录围栏。 */
export function runAction(s: ExecStep, workdir: string, tag: string): Promise<RunOutcome> {
  const root = path.resolve(workdir);
  if (s.action === "read_file") {
    return Promise.resolve((() => {
      const p = path.resolve(root, s.cmd);
      if (!withinDir(root, s.cmd)) {
        return { rc: EXIT_PREREQ, out: `拒绝：${s.cmd} 不在工作目录 ${root} 里面（read_file 的内容会外发给顾问，不设围栏等于读盘外泄）` };
      }
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) return { rc: EXIT_PREREQ, out: `拒绝：${p} 不是文件` };
        const text = fs.readFileSync(p, "utf8");
        return { rc: EXIT_OK, out: text.length > READ_FILE_CHARS
          ? `${text.slice(0, READ_FILE_CHARS)}\n…（截断，原 ${text.length} 字）` : text };
      } catch (e) { return { rc: EXIT_ERROR, out: `读不到 ${p}：${(e as Error).message}` }; }
    })());
  }
  if (s.action === "write_file") {
    return Promise.resolve((() => {
      const nl = s.cmd.indexOf("\n");
      const rel = (nl < 0 ? s.cmd : s.cmd.slice(0, nl)).trim();
      const content = nl < 0 ? "" : s.cmd.slice(nl + 1);
      if (!rel) return { rc: EXIT_PREREQ, out: "拒绝：write_file 的 CMD 首行必须是相对路径" };
      if (!withinDir(root, rel)) {
        return { rc: EXIT_PREREQ, out: `拒绝：${rel} 不在工作目录 ${root} 里面` };
      }
      if (PROTECTED_FILES.includes(path.basename(rel).toLowerCase())) {
        return { rc: EXIT_PREREQ, out: `拒绝：${rel} 是执行器自己的账本，顾问不能改` };
      }
      const p = path.resolve(root, rel);
      if (fs.existsSync(p)) {
        return { rc: EXIT_PREREQ, out: `拒绝：${p} 已存在（覆盖是危险动作，要人来做；请让顾问换个文件名或先读给你看）` };
      }
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, "utf8");
        return { rc: EXIT_OK, out: `已写 ${rel}（${content.length} 字）` };
      } catch (e) { return { rc: EXIT_ERROR, out: `写不进 ${p}：${(e as Error).message}` }; }
    })());
  }
  if (s.action === "python") {
    // CMD 可以是一个已存在的 .py 路径，也可以是一段代码：是代码就先落成脚本再跑一行调用。
    const asPath = path.resolve(root, s.cmd);
    const inside = withinDir(root, s.cmd);
    if (/\.py$/i.test(s.cmd) && fs.existsSync(asPath) && inside) {
      return exec(["python", asPath], workdir);
    }
    if (/\.py$/i.test(s.cmd) && fs.existsSync(asPath) && !inside) {
      return Promise.resolve({ rc: EXIT_PREREQ, out: `拒绝：${s.cmd} 不在工作目录 ${root} 里面` });
    }
    const target = path.join(root, `${tag}.py`);
    fs.writeFileSync(target, s.cmd, "utf8");
    return exec(["python", target], workdir);
  }
  const sh = shellSpec();
  return exec(sh.argv(s.cmd), workdir, sh.name === "cmd.exe" ? cmdEnv() : undefined, sh.verbatim);
}

/** cmd.exe 专用环境：把 System32 提到 PATH 最前。
 *  缘由（2026-10-09 实测）：本机 PATH 里 Git 的 /usr/bin 排在前面，顾问给的
 *  `dir /b /a-d | find /c /v ""` 里的 `find` 于是解析成 GNU find——它把 `/c` 当成
 *  `C:\`，递归整个 C 盘，一次产出 1.3 亿字。同名命令被 Unix 版顶掉是 Windows + Git Bash
 *  的常态，所以在 cmd.exe 这条路上必须让系统自带的 find/sort/more 优先。
 *  显式 BRIDGE_SHELL=bash 时不动 PATH：那种情况下用户要的就是 Unix 工具。 */
function cmdEnv(): NodeJS.ProcessEnv {
  const sys = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const e: Record<string, string | undefined> = { ...process.env };
  const cur = e.PATH ?? e.Path ?? "";
  delete e.Path;
  e.PATH = `${sys};${cur}`;
  return e as NodeJS.ProcessEnv;
}

/** 输出上限的纯判定（杀进程在 exec 里做，这里只管文本）。抽出来是为了能离线测：
 *  上限本身是 2026-10-09 那条 1.3 亿字事故的对策，不该只能靠实弹验证。 */
export function capOutput(out: string, cap = OUTPUT_CAP_BYTES): { text: string; capped: boolean } {
  if (out.length <= cap) return { text: out, capped: false };
  return { text: `${out.slice(0, cap)}\n（输出超过 ${Math.round(cap / 1024)}KB，已杀掉命令并截断）`, capped: true };
}

function exec(argv: string[], cwd: string, env?: NodeJS.ProcessEnv, verbatim = false): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const [file, ...rest] = argv;
    const child = spawn(file, rest, {
      cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false, env,
      windowsVerbatimArguments: verbatim,
    });
    let out = "";
    let capped = false;
    const pump = (c: Buffer): void => {
      if (capped) return;
      const r = capOutput(out + c.toString("utf8"));
      out = r.text;
      if (r.capped) {
        capped = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", pump);
    child.stderr.on("data", pump);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      out += `\n（超过 ${CMD_TIMEOUT_MS / 1000} 秒，已杀）`;
    }, CMD_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); resolve({ rc: EXIT_ERROR, out: `起不来：${e.message}` }); });
    child.on("close", (rc) => {
      clearTimeout(timer);
      resolve({ rc: capped ? EXIT_ERROR : (rc ?? EXIT_ERROR), out });
    });
  });
}

// —— CLI ——

type Opts = {
  state: string; goal: string; advice: string; rounds: number; maxWaitS: number;
  emit: string | null; force: boolean; only: number; from: number;
};

function parseOpts(argv: string[]): { op: string; rest: string[]; o: Opts } {
  const o: Opts = {
    state: "state.md", goal: "", advice: "advice.txt",
    rounds: DEFAULT_ROUNDS, maxWaitS: 240, emit: null, force: false, only: 0, from: 1,
  };
  const op = argv[0] ?? "";
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const need = (): string => {
      const v = argv[++i];
      if (v === undefined) { log(`选项 ${a} 后面缺一个值`); process.exit(EXIT_ERROR); }
      return v;
    };
    if (a === "--state") o.state = need();
    else if (a === "--goal") o.goal = need();
    else if (a === "--advice") o.advice = need();
    else if (a === "--rounds") o.rounds = Number(need());
    else if (a === "--max-wait") o.maxWaitS = Number(need());
    else if (a === "--emit") o.emit = need();
    else if (a === "--only") o.only = Number(need());
    else if (a === "--from") o.from = Number(need());
    else if (a === "--force") o.force = true;
    else if (a === "-h" || a === "--help") { process.stdout.write(HELP + "\n"); process.exit(EXIT_OK); }
    else rest.push(a);
  }
  return { op, rest, o };
}

const HELP = `bridge — 顾问桥 v2：网页 DeepSeek 当脑，本地当手，state.md 当记忆

  node src/bridge.ts init --goal "要做什么" [--state state.md] [--force]
  node src/bridge.ts ask  [--state state.md] [--advice advice.txt] [--emit ask.txt]
  node src/bridge.ts apply <advice.txt>      只解析、只报闸门，一步都不跑
  node src/bridge.ts act  [--only k] [--from k]   跑一批（默认从第 1 步）
  node src/bridge.ts run  [--state state.md] [--rounds ${DEFAULT_ROUNDS}]

顾问回复 = 自由思考文字 + STATE 代码块 + EXEC 多步块；执行器只读这两个块。
STATE 每轮整块覆盖，轮次记录只追加。

半自动：ask --emit ask.txt 只产简报不发问；人把它贴进网页，回复存成 advice.txt，
再跑 apply 看预检、跑 act 执行。危险步骤一律停下来交给人——要跑就人自己跑，
然后 act --from k+1 接着走（没有任何参数能降级闸门）。

退出码：0 正常 / 1 运行错误（含顾问不守格式、命令失败、未判定）/ 2 需要人。
过程日志在 stderr；stdout 只有机器要读的东西（预检表、命令输出）。`;

function readState(o: Opts): State {
  if (!fs.existsSync(o.state)) {
    log(`没有 ${o.state}：先跑 bridge init --goal "要做什么"`);
    process.exit(EXIT_PREREQ);
  }
  return parseState(fs.readFileSync(o.state, "utf8"));
}

/** 原子写：先写 .tmp 再 rename。DeepSeek 在那轮问答里点出这条——弱执行器只会 writeFile，
 *  写一半断掉就静默丢掉整轮记忆。本仓实测 fs.renameSync 在 Windows 上能覆盖已存在目标
 *  （输出「rename 覆盖 OK, 现内容= NEW」），所以这条路可用。 */
function writeState(o: Opts, s: State): void {
  const tmp = `${o.state}.tmp`;
  fs.writeFileSync(tmp, renderState(s), "utf8");
  fs.renameSync(tmp, o.state);
}

function envLine(): string {
  return `OS=${process.platform} ${os.release()}；Shell=${shellSpec().name}；` +
    `工作目录=${process.cwd()}；Node=${process.versions.node}`;
}

function defaultEnvText(): string { return envLine(); }

async function opInit(o: Opts): Promise<number> {
  if (fs.existsSync(o.state) && !o.force) {
    log(`${o.state} 已存在，不覆盖（要重来加 --force）`);
    return EXIT_PREREQ;
  }
  if (!o.goal.trim()) { log('用法：bridge init --goal "要做什么"'); return EXIT_ERROR; }
  writeState(o, { goal: o.goal.trim(), env: defaultEnvText(), status: "刚开始，还没执行任何命令。", plan: emptyPlan(), rounds: [] });
  log(`已写 ${o.state}（目标与环境已就位；下一步 bridge ask）`);
  return EXIT_OK;
}

function printStepTable(steps: ExecStep[]): void {
  process.stdout.write(
    steps.map((s) => {
      const g = stepGate(s);
      const expectKind = /^(exit|退出码|包含|不含|regex|非空)/i.test(s.expect.trim()) ? "机械" : "散文→未判定";
      return `${s.step}. ${s.action}｜闸门${g.need ? "拦" : "放"}${g.need ? `(${g.why.join("、")})` : ""}｜EXPECT:${expectKind}｜${s.cmd.split("\n")[0]}`;
    }).join("\n") + "\n"
  );
}

/** 发一轮简报：顾问原文落 advice.txt（思考文字也要留，人要看它怎么想的），
 *  STATE 落进 state.md，EXEC 打到 stdout。 */
async function opAsk(o: Opts): Promise<{ reply: Reply | null; rc: number }> {
  const s = readState(o);
  const brief = buildBriefing(s);
  if (typeof brief !== "string") { log(brief.error); return { reply: null, rc: EXIT_ERROR }; }
  const full = `${advisorPrompt()}\n\n${brief}`;
  if (o.emit) {
    fs.writeFileSync(o.emit, full, "utf8");
    log(`已写 ${o.emit}（${full.length} 字）。人工贴进网页后把回复存成 ${o.advice}，再跑 bridge apply / act`);
    return { reply: null, rc: EXIT_OK };
  }
  const tmp = path.join(os.tmpdir(), `bridge-answer-${process.pid}.txt`);
  log(`问顾问（简报 ${brief.length} 字，含系统提示共 ${full.length} 字）…`);
  const r = await askAdvisor(full, tmp, o.maxWaitS);
  if (r.rc !== EXIT_OK || !r.answer) {
    log(`顾问这一轮没走完（dskts 退出码 ${r.rc}，答案 ${r.answer.length} 字）`);
    return { reply: null, rc: r.rc === EXIT_PREREQ ? EXIT_PREREQ : EXIT_ERROR };
  }
  fs.writeFileSync(o.advice, r.answer, "utf8");
  const reply = parseReply(r.answer);
  if (isErr(reply)) {
    log(`顾问不守 v2 格式：${reply.error}（原文已存 ${o.advice}，人工看一眼）`);
    return { reply: null, rc: EXIT_ERROR };
  }
  writeState(o, mergePlan(s, reply.plan));
  log(`已落 ${o.advice}（原文）与 ${o.state}（顾问记忆整块覆盖）`);
  if (!reply.steps.length) {
    process.stdout.write("本批 0 步（顾问只更新了记忆或要你补信息）\n");
    log("顾问没给 EXEC：下一轮简报会带上这条事实");
    return { reply: { ...reply, steps: [] }, rc: EXIT_OK };
  }
  printStepTable(reply.steps);
  return { reply, rc: EXIT_OK };
}

/** 按 --only/--from 取范围。只改范围，不改闸门。 */
function selectSteps(steps: ExecStep[], o: Opts): ExecStep[] {
  if (o.only > 0) return steps.filter((s) => s.step === o.only);
  return steps.filter((s) => s.step >= o.from);
}

async function opApply(o: Opts, file: string): Promise<number> {
  const text = fs.readFileSync(file, "utf8");
  const reply = parseReply(text);
  if (isErr(reply)) { log(`解析失败：${reply.error}`); return EXIT_ERROR; }
  if (!reply.steps.length) {
    process.stdout.write("（本回复没有 EXEC 步）\n");
  } else printStepTable(reply.steps);
  const planLines = PLAN_FIELDS.map(([k, l]) => `  ${l}：${foldPlanField(k, reply.plan[k]).split("\n")[0]}`);
  log(`STATE 解析到 ${planLines.length} 个字段：\n${planLines.join("\n")}`);
  return EXIT_OK;
}

export type StepResult = { rec: StepRecord; rc: number; verdict: string };
export type RoundResult = {
  ran: StepResult[]; stopped: StopReason; rc: number; reason: string;
};

/** 在流中问人，默认 No。只在真的是交互终端时才问——
 *  非 TTY 宿主里读标准输入会挂死整轮，那种情况直接停下来交回给人。 */
async function askHuman(what: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const a = (await rl.question(`要人确认：${what}\n输入 y 才跑这一步（默认 N）：`)).trim().toLowerCase();
    return a === "y" || a === "yes";
  } finally { rl.close(); }
}

/** 跑一批步骤：逐步过闸门、原样执行、检查 EXPECT、每步立刻写穿 state.md。
 *  任一步失败/不满足/未判定 → 停批（后面的步一步都不跑），把原因原样带回给顾问。 */
export async function runSteps(
  steps: ExecStep[], round: number, o: Opts, wd: string
): Promise<RoundResult> {
  const ran: StepResult[] = [];
  let stopped: StopReason = "全部完成";
  let rc = EXIT_OK;
  let reason = "";
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const rec = (verdict: string, res: { rc: number; out: string }): StepResult => {
      const r: StepResult = {
        rec: { round, k: i + 1, of: steps.length, step: s.step, action: s.action,
          cmd: s.cmd, expect: s.expect, verdict, summary: summarizeOutput(res.out) },
        rc: res.rc, verdict,
      };
      // 每步立刻写穿：进程被打断也不丢账（顾问下一轮只能靠简报，简报来自 state.md）
      writeState(o, appendStep(readState(o), r.rec));
      ran.push(r);
      return r;
    };
    if (s.action === "done") {
      const v = `完成：${s.cmd}`;
      process.stdout.write(v + "\n");
      rec(v, { rc: EXIT_OK, out: "" });
      return { ran, stopped: "顾问判定done", rc: EXIT_OK, reason: v };
    }
    if (s.action === "ask_user") {
      const v = `待人确认（未执行）：${s.cmd}`;
      process.stdout.write(v + "\n");
      rec(v, { rc: EXIT_PREREQ, out: "" });
      return { ran, stopped: "待人", rc: EXIT_PREREQ, reason: v };
    }
    const g = stepGate(s);
    if (g.need) {
      const ok = await askHuman(`第 ${s.step} 步（${g.why.join("、")}）：${s.cmd}`);
      if (!ok) {
        const v = `已拦（${g.why.join("、")}），未执行`;
        process.stdout.write(`${v}\n要跑就人工自己跑这一步，再 act --from ${s.step + 1} 接着走。\n`);
        rec(v, { rc: EXIT_PREREQ, out: "" });
        return { ran, stopped: "待人", rc: EXIT_PREREQ, reason: v };
      }
      log("  人已确认，继续");
    }
    log(`执行第 ${s.step} 步 ${s.action}：${s.cmd.split("\n")[0]}${s.cmd.includes("\n") ? "（多行）" : ""}`);
    const r = await runAction(s, wd, `r${round}-${s.step}`);
    const ev = r.rc === EXIT_OK ? checkExpect(s.expect, r.rc, r.out) : "不满足";
    const verdict = r.rc === EXIT_OK
      ? `${ev}（退出码 0）`
      : `失败（退出码 ${r.rc}）`;
    process.stdout.write(`${verdict}\n${r.out}\n`);
    rec(verdict, { rc: r.rc, out: r.out });
    const d = stepDecision(s.action, r.rc, ev);
    if (d.stop) {
      stopped = d.stopped; rc = d.rc;
      reason = `第 ${s.step} 步${d.stopped}：${s.cmd.split("\n")[0]}｜EXPECT：${s.expect}` +
        `｜ON_FAIL：${s.onFail}｜输出：${summarizeOutput(r.out, FAIL_OUT_CHARS)}`;
      break;
    }
  }
  return { ran, stopped, rc, reason };
}

/** 循环要不要停（纯函数，离线可测）。
 *  done = 收工（0）；待人/不合规 = 交回给人；
 *  批内失败或未判定**不停轮**——下一轮把错误带给顾问，这正是这套桥的用途。
 *  2026-10-09 实测过反面：done 返回 0 而循环只在 2 时停，于是又空转三轮问出三个 done。 */
export function loopDecision(r: RoundResult): { stop: boolean; rc: number } {
  if (r.stopped === "顾问判定done") return { stop: true, rc: EXIT_OK };
  if (r.stopped === "待人") return { stop: true, rc: EXIT_PREREQ };
  if (r.stopped === "不合规") return { stop: true, rc: EXIT_ERROR };
  return { stop: false, rc: r.rc };
}

async function opAct(o: Opts, reply: Reply): Promise<number> {
  const s0 = readState(o);
  const steps = selectSteps(reply.steps, o);
  if (!steps.length) { log(`没有要跑的步骤（--only=${o.only} --from=${o.from}）`); return EXIT_PREREQ; }
  const round = (s0.rounds.at(-1)?.round ?? 0) + 1;
  const r = await runSteps(steps, round, o, process.cwd());
  if (r.stopped !== "全部完成") log(`本批停在「${r.stopped}」：${r.reason}`);
  return r.rc;
}

async function opRun(o: Opts): Promise<number> {
  let formatFails = 0;
  for (let round = 1; round <= o.rounds; round++) {
    log(`—— 第 ${round}/${o.rounds} 轮 ——`);
    const asked = await opAsk(o);
    if (asked.rc !== EXIT_OK || !asked.reply) {
      if (++formatFails >= 2) { log("连续两轮没拿到合规回复，停（别在坏格式上空转）"); return EXIT_ERROR; }
      continue;
    }
    formatFails = 0;
    const reply = asked.reply;
    const steps = selectSteps(reply.steps, { ...o, only: 0, from: 1 });
    if (!steps.length) {
      // 0 步不是错误（顾问可能只在更新记忆），但也别原地空转：
      // 下一轮简报会带上「上一轮没给活」这个事实，连着两轮就停。
      if (++formatFails >= 2) { log("连续两轮没有可执行步骤，停"); return EXIT_PREREQ; }
      log("顾问这一轮没给 EXEC 步，再问一轮");
      continue;
    }
    formatFails = 0;
    const r = await runSteps(steps, round, o, process.cwd());
    if (r.stopped !== "全部完成") log(`本批停在「${r.stopped}」：${r.reason}`);
    const d = loopDecision(r);
    if (d.stop) return d.rc;
    if (d.rc !== EXIT_OK) log("这一批失败了，下一轮把错误带给顾问");
  }
  log(`到轮数上限 ${o.rounds}，停`);
  return EXIT_ERROR;
}

async function main(argv: string[]): Promise<number> {
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP + "\n");
    return EXIT_OK;
  }
  const { op, rest, o } = parseOpts(argv);
  switch (op) {
    case "init": return await opInit(o);
    case "ask": { const r = await opAsk(o); return r.rc; }
    case "apply": {
      if (!rest[0]) { log("用法：bridge apply <advice.txt>"); return EXIT_ERROR; }
      return await opApply(o, rest[0]);
    }
    case "act": {
      const text = fs.existsSync(o.advice)
        ? fs.readFileSync(o.advice, "utf8")
        : rest[0] ?? "";
      if (!text) { log(`没有 ${o.advice}，也没有位置参数：先跑 bridge ask`); return EXIT_ERROR; }
      const reply = parseReply(text);
      if (isErr(reply)) { log(`解析失败：${reply.error}`); return EXIT_ERROR; }
      return await opAct(o, reply);
    }
    case "run": return await opRun(o);
    default: log(`不认识的子命令：${op}（--help 看用法）`); return EXIT_ERROR;
  }
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = await main(process.argv.slice(2)).catch((e: unknown) => {
    log(`bridge 出错：${(e as Error).message ?? e}`);
    return EXIT_ERROR;
  });
}
