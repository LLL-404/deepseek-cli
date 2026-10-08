// 顾问桥（bridge）：本地执行器当「手」、网页 DeepSeek 当「脑」、state.md 当「记忆」。
//
// 为什么要有它：网页 DeepSeek 的上下文跨会话不互通，所以每一轮提问都必须自包含
// （目标 / 环境 / 当前状态 / 最近操作 / 当前输出或错误 / 需要它决定什么）；顾问的回复
// 必须是固定四行 ACTION/CMD/EXPECT/FAIL，这样智力有限的执行器只会复制执行、不会自由发挥。
//
// 三个子命令：
//   ask  = 生成简报 → 经 dskts 发给顾问 → 解析四行 → 落 advice.txt
//   act  = 过危险闸门 → 执行一条 CMD → 把结果追加进 state.md
//   run  = ask+act 循环，直到 done / request_info / ask_user / 轮数上限
//
// 本文件分两段：纯函数（离线可测，见 tests/bridge.test.ts）与编排（要起 dskts、要跑命令）。
// 传输层复用同目录的 dskts（stdin 灌简报、--out 落盘读答案），不新造浏览器自动化。
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_ERROR, EXIT_OK, EXIT_PREREQ } from "./constants.ts";

// —— 词表与上限（桥自己的常量，不进 constants.ts：那份自限「只登记页面结构常量」）——

/** 执行器真有的动作。规格里还列了 write_file / browser_* / screenshot，本桥没有实现——
 *  留着只会让顾问发出执行器跑不了的指令（规格自己的防呆第 3 条：动作集只允许它实际有的工具）。
 *  写文件走 shell 或 python，二者都过危险闸门。 */
export const ACTIONS = ["shell", "python", "read_file", "ask_user", "request_info", "done"] as const;
export type Action = (typeof ACTIONS)[number];

export const ADVICE_OPEN = "<<<ADVICE";
export const ADVICE_CLOSE = "ADVICE>>>";
export const BRIEF_MAX_CHARS = 6_000; // 超长直接报错，不静默截断（外发内容要可控）
export const RECENT_ROUNDS = 3; // 简报只带最近 3 轮，不带全部历史（规格要求）
export const OUTPUT_SUMMARY_CHARS = 600; // 记进 state.md 的输出摘要上限
export const READ_FILE_CHARS = 4_000; // read_file 回给顾问的字数上限
export const CMD_TIMEOUT_MS = 120_000;
/** 命令输出上限。2026-10-09 实测到一条失控命令产出 1.3 亿字（见 cmdEnv 的缘由），
 *  不设上限就是让顾问的一句话能吃光内存；超限直接杀命令并写清截断。 */
export const OUTPUT_CAP_BYTES = 256 * 1024;
export const DEFAULT_ROUNDS = 12;
export const BRIDGE_MARK = "Bridge"; // 顾问会话的归属前缀，别蹭 Qoder 的连续会话

/** CMD 交给谁跑。Windows 默认 cmd.exe 并先 chcp 65001，让中文输出是 UTF-8 而不是 GBK；
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

/** 危险闸门：删除、覆盖、支付、对外发送、装软件、改系统设置、改远端或丢工作区。
 *  这是代码级的、不接受任何参数关闭——守卫一旦可注入就等于没有（既有纪律）。
 *  宁可多拦（代价是要人确认一次）也不漏拦（代价是数据或钱）。
 *  中文关键词不能用 \b：`支付` 两侧都不是 \w，压根没有词边界（2026-10-09 实测漏过一次），
 *  所以 ASCII 词与 CJK 词分成两条正则。 */
const DANGER_PATTERNS: readonly { re: RegExp; why: string }[] = [
  { re: /\b(del|erase|rd|rmdir|rm|Remove-Item|unlink|shred|Clear-RecycleBin)\b/i, why: "删除文件/目录" },
  { re: /删除|删掉|清空回收站/, why: "删除文件/目录" },
  { re: /\b(format|diskpart|mkfs|fdisk)\b/i, why: "格盘或改分区" },
  // 重定向到 nul / /dev/null、以及 2>&1 这种文件描述符复制，都不是覆盖
  // （2026-10-09 实测两次误拦：`dir 2>nul | find /c /v ""` 与 `node x.js >/dev/null 2>&1`；
  //  闸门误拦等于把工具废掉）
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

// —— 顾问回复的解析与渲染 ——

export type Advice = { action: Action; cmd: string; expect: string; fail: string };
export type AdviceErr = { error: string };

const FIELD_RE = /^(ACTION|CMD|EXPECT|FAIL)\s*[:：]\s*(.*)$/i;

/** 解析顾问回复。任何不合规都返回 error 且**不执行任何东西**：缺字段、多步计划、
 *  动作不在词表、命令为空。宁可停下来问人，也不猜——猜错的代价是执行器跑了一条谁都没批准的命令。 */
export function parseAdvice(text: string): Advice | AdviceErr {
  let body = text;
  const open = body.indexOf(ADVICE_OPEN);
  if (open >= 0) {
    body = body.slice(open + ADVICE_OPEN.length);
    const close = body.indexOf(ADVICE_CLOSE);
    if (close >= 0) body = body.slice(0, close);
  }
  // markdown 围栏只是包装，剥掉；剥完仍按四行解析
  body = body.replace(/^\s*```[a-zA-Z]*\s*$/gm, "").replace(/^\s*```\s*$/gm, "");

  const seen = new Map<string, string[]>();
  let current: string | null = null;
  let actionLines = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const m = FIELD_RE.exec(line);
    if (m) {
      const key = m[1].toUpperCase();
      if (key === "ACTION") actionLines++;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key)!.push(m[2].trim());
      current = key;
      continue;
    }
    // 非字段行接在当前字段后面：顾问把多行命令写在 CMD 底下时必须**看得见全貌才能拒**，
    // 只取第一行会把命令静默截断成半条再执行——那比拒绝危险得多。
    if (current && line) seen.get(current)!.push(line);
  }
  const get = (k: string): string | undefined =>
    seen.has(k) ? seen.get(k)!.join("\n").trim() : undefined;

  if (actionLines === 0) return { error: "回复里没有 ACTION 行（顾问没守四行格式）" };
  if (actionLines > 1) return { error: `回复里有 ${actionLines} 条 ACTION：顾问给了多步计划，本桥一轮只执行一条` };

  const rawAction = get("ACTION") ?? "";
  const action = rawAction.toLowerCase().replace(/[^a-z_]/g, "") as Action;
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return { error: `动作「${rawAction}」不在词表里（可用：${ACTIONS.join(" / ")}）` };
  }
  const cmd = get("CMD") ?? "";
  const expect = get("EXPECT") ?? "";
  const fail = get("FAIL") ?? "";
  if (!seen.has("CMD") || !seen.has("EXPECT") || !seen.has("FAIL")) {
    const missing = ["CMD", "EXPECT", "FAIL"].filter((k) => !seen.has(k));
    return { error: `四行缺了 ${missing.join("、")}` };
  }
  if ((action === "shell" || action === "python" || action === "read_file") && !cmd) {
    return { error: `ACTION=${action} 但 CMD 是空的` };
  }
  if (cmd.split(/\r?\n/).filter((l) => l.trim()).length > 1) {
    return { error: "CMD 跨了多行：请让顾问把复杂逻辑写成脚本文件，再给一行调用" };
  }
  return { action, cmd, expect, fail };
}

export function renderAdvice(a: Advice): string {
  return `ACTION: ${a.action}\nCMD: ${a.cmd}\nEXPECT: ${a.expect}\nFAIL: ${a.fail}`;
}

// —— state.md：桥的唯一记忆 ——

export type RoundRecord = {
  round: number;
  action: Action;
  cmd: string;
  expect: string;
  verdict: string; // 成功 / 失败 / 已拦 / 待人确认 …
  summary: string; // 单行输出摘要
};

export type State = { goal: string; env: string; status: string; rounds: RoundRecord[] };

const ROUND_HEAD = "### 第 ";

/** 把输出压成单行摘要：换行换成 ⏎，超长截断并写清截了多少字。
 *  单行是为了 state.md 好解析、简报好携带。 */
export function summarizeOutput(text: string, max = OUTPUT_SUMMARY_CHARS): string {
  const flat = (text ?? "").replace(/\r?\n/g, " ⏎ ").trim();
  if (flat.length <= max) return flat || "（无输出）";
  return `${flat.slice(0, max)}…（截断，原 ${flat.length} 字）`;
}

export function parseState(md: string): State {
  const pick = (label: string): string => {
    const m = new RegExp(`^${label}：([\\s\\S]*?)(?=^\\S+：|^##|$)`, "m").exec(md);
    return m ? m[1].trim().replace(/\s+$/, "") : "";
  };
  const rounds: RoundRecord[] = [];
  const tail = md.split(/^## 轮次记录\s*$/m)[1] ?? "";
  for (const block of tail.split(/^### /m).slice(1)) {
    const g = (re: RegExp): string => (re.exec(block)?.[1] ?? "").trim();
    const n = Number(/^第 (\d+) 轮/m.exec(block)?.[1] ?? 0);
    const action = g(/^- ACTION: (\S+)/m) as Action;
    if (!n || !action) continue;
    rounds.push({
      round: n, action,
      cmd: g(/^- CMD: ([\s\S]*?)(?=^- )/m),
      expect: g(/^- EXPECT: ([\s\S]*?)(?=^- )/m),
      verdict: g(/^- 结果: ([\s\S]*?)(?=^- )/m),
      summary: g(/^- 输出摘要: ([\s\S]*?)(?=$)/m),
    });
  }
  return { goal: pick("目标"), env: pick("环境"), status: pick("当前状态"), rounds };
}

export function renderState(s: State): string {
  const lines = [
    "# 任务状态", "",
    `目标：${s.goal}`, "",
    `环境：${s.env}`, "",
    `当前状态：${s.status}`, "",
    "## 轮次记录", "",
  ];
  for (const r of s.rounds) {
    lines.push(
      `${ROUND_HEAD}${r.round} 轮`,
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

export function appendRound(s: State, r: Omit<RoundRecord, "round">): State {
  const round = (s.rounds.at(-1)?.round ?? 0) + 1;
  return { ...s, rounds: [...s.rounds, { ...r, round }], status: `第 ${round} 轮已处理：${r.verdict}` };
}

/** 生成自包含简报。超长直接报错（不静默截断）：外发的内容必须可控。 */
export function buildBriefing(s: State, extraError = ""): string | { error: string } {
  const recent = s.rounds.slice(-RECENT_ROUNDS);
  const shell = shellSpec().name;
  const parts = [
    "【执行器简报】", "",
    `目标：${s.goal || "（未写）"}`, "",
    `环境：${s.env || "（未写）"}`,
    `执行命令用的 shell：${shell}（CMD 会原样交给它，请按它的语法写；一轮只给一条命令）`,
    `可用动作：${ACTIONS.join(" / ")}`, "",
    `当前状态：${s.status || "（未写）"}`, "",
    `最近操作（最多 ${RECENT_ROUNDS} 轮，最新在最后）：`,
    ...(recent.length
      ? recent.map((r) => `${r.round}. ${r.action}：${r.cmd} → ${r.verdict}；输出摘要：${r.summary}`)
      : ["（还没有执行过任何命令）"]),
    "",
    "当前输出/错误：",
    extraError || recent.at(-1)?.summary || "（无）",
    "",
    "需要你决定：下一步做什么？",
  ];
  const text = parts.join("\n");
  if (text.length > BRIEF_MAX_CHARS) {
    return { error: `简报 ${text.length} 字，超过上限 ${BRIEF_MAX_CHARS}——请压缩目标/环境/当前状态，别把整段日志塞进来` };
  }
  return text;
}

/** 顾问的系统提示：每一轮都随简报一起发，不依赖会话记忆（上下文不互通是这套设计的前提）。 */
export function advisorPrompt(): string {
  return [
    "你是【远程顾问】。你看不到执行器的机器，只能依据下面的《执行器简报》给指令。",
    "执行器智力有限，只会复制执行、不会判断，所以指令必须一步一条、可直接复制。", "",
    "只输出下面四行，不要解释、不要多步计划、不要 markdown 围栏：",
    `ACTION: ${ACTIONS.join("|")}`,
    "CMD: 一行可复制的命令（复杂逻辑先让执行器写成脚本文件，再给一行调用）",
    "EXPECT: 预期结果（执行器据此判断成败）",
    "FAIL: 失败时要收集并回报的信息", "",
    "规则：",
    "1. 只依据本次简报，不要假设你记得之前的内容。",
    "2. 信息不足：ACTION: request_info，CMD 里列出最多 3 项要收集的信息，用 | 分隔。",
    "3. 任务完成：ACTION: done，CMD 写一句话说明完成了什么。",
    "4. 危险操作（删除、覆盖、支付、发消息、装软件、改系统设置、杀进程）：ACTION: ask_user，CMD 写清要确认什么——执行器有代码级闸门，这类命令一律不会自动跑。",
    "5. 不要给「你可以试试」这类模糊话，不要让执行器自己判断分支。",
    `6. 把整段回复包在 ${ADVICE_OPEN} 与 ${ADVICE_CLOSE} 之间。`,
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

export type RunOutcome = { rc: number; out: string };

/** 执行一条命令。CMD 来自远端模型，属于**不可信输入**：shell/python 一律过危险闸门，
 *  read_file 另有工作目录围栏——它读到的内容下一轮会随简报外发给 DeepSeek，
 *  不设围栏就是一条"读盘即外泄"的通道。 */
export function runAction(a: Advice, workdir: string, tag: string): Promise<RunOutcome> {
  if (a.action === "read_file") {
    return Promise.resolve((() => {
      const root = path.resolve(workdir);
      const p = path.resolve(root, a.cmd);
      // 围栏：只许读工作目录里面的东西（..\ 与绝对路径一律拒），且必须是文件
      if (p !== root && !p.startsWith(root + path.sep)) {
        return { rc: EXIT_PREREQ, out: `拒绝：${a.cmd} 不在工作目录 ${root} 里面（read_file 的内容会外发给顾问，不设围栏等于读盘外泄）` };
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
  if (a.action === "python") {
    // CMD 可以是一个已存在的 .py 路径，也可以是一段代码：是代码就先落成脚本再跑一行调用。
    // 路径形式同样受工作目录围栏约束，免得顾问指着仓库外的脚本让执行器跑。
    const root = path.resolve(workdir);
    const asPath = path.resolve(root, a.cmd);
    const inside = asPath === root || asPath.startsWith(root + path.sep);
    if (/\.py$/i.test(a.cmd) && fs.existsSync(asPath) && inside) {
      return exec(["python", asPath], workdir);
    }
    if (/\.py$/i.test(a.cmd) && fs.existsSync(asPath) && !inside) {
      return Promise.resolve({ rc: EXIT_PREREQ, out: `拒绝：${a.cmd} 不在工作目录 ${root} 里面` });
    }
    const target = path.join(root, `${tag}.py`);
    fs.writeFileSync(target, a.cmd, "utf8");
    return exec(["python", target], workdir);
  }
  const sh = shellSpec();
  return exec(sh.argv(a.cmd), workdir, sh.name === "cmd.exe" ? cmdEnv() : undefined, sh.verbatim);
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
  return { text: `${out.slice(0, cap)}\n（输出超过 ${cap / 1024}KB，已杀掉命令并截断）`, capped: true };
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

type Opts = { state: string; goal: string; advice: string; rounds: number; maxWaitS: number; emit: string | null; force: boolean };

function parseOpts(argv: string[]): { op: string; rest: string[]; o: Opts } {
  const o: Opts = {
    state: "state.md", goal: "", advice: "advice.txt",
    rounds: DEFAULT_ROUNDS, maxWaitS: 240, emit: null, force: false,
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
    else if (a === "--force") o.force = true;
    else if (a === "-h" || a === "--help") { process.stdout.write(HELP + "\n"); process.exit(EXIT_OK); }
    else rest.push(a);
  }
  return { op, rest, o };
}

const HELP = `bridge — 顾问桥：网页 DeepSeek 当脑，本地当手，state.md 当记忆

  node src/bridge.ts init --goal "要做什么" [--state state.md] [--force]
  node src/bridge.ts ask  [--state state.md] [--advice advice.txt] [--emit ask.txt]
  node src/bridge.ts apply <advice.txt> [--state state.md]     只解析、不执行（半自动模式）
  node src/bridge.ts act  [--state state.md] [--advice advice.txt]
  node src/bridge.ts run  [--state state.md] [--rounds ${DEFAULT_ROUNDS}]

  ask    生成自包含简报 → 经 dskts 问顾问 → 打印四行并落 advice.txt
  act    过危险闸门 → 执行一条 CMD → 把结果追加进 state.md
  run    ask+act 循环，遇到 done / request_info / ask_user / 闸门拦下 就停

半自动：ask --emit ask.txt 只产简报不发问；人把它贴进网页，回复存成 advice.txt，
再跑 apply 看解析结果、跑 act 执行。

退出码：0 正常 / 1 运行错误（含顾问不守格式）/ 2 需要人（危险命令、ask_user、request_info、未登录）
过程日志在 stderr；stdout 只有机器要读的东西（四行指令、命令输出）。`;

function readState(o: Opts): State {
  if (!fs.existsSync(o.state)) {
    log(`没有 ${o.state}：先跑 bridge init --goal "要做什么"`);
    process.exit(EXIT_PREREQ);
  }
  return parseState(fs.readFileSync(o.state, "utf8"));
}

function writeState(o: Opts, s: State): void {
  fs.writeFileSync(o.state, renderState(s), "utf8");
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
  writeState(o, { goal: o.goal.trim(), env: defaultEnvText(), status: "刚开始，还没执行任何命令。", rounds: [] });
  log(`已写 ${o.state}（目标与环境已就位；下一步 bridge ask）`);
  return EXIT_OK;
}

/** 发一轮简报，把顾问的四行指令落盘并打到 stdout。 */
async function opAsk(o: Opts): Promise<{ advice: Advice | null; rc: number }> {
  const s = readState(o);
  const brief = buildBriefing(s);
  if (typeof brief !== "string") { log(brief.error); return { advice: null, rc: EXIT_ERROR }; }
  const full = `${advisorPrompt()}\n\n${brief}`;
  if (o.emit) {
    fs.writeFileSync(o.emit, full, "utf8");
    log(`已写 ${o.emit}（${full.length} 字）。人工贴进网页后把回复存成 ${o.advice}，再跑 bridge apply / act`);
    return { advice: null, rc: EXIT_OK };
  }
  const tmp = path.join(os.tmpdir(), `bridge-answer-${process.pid}.txt`);
  log(`问顾问（简报 ${brief.length} 字，含系统提示共 ${full.length} 字）…`);
  const r = await askAdvisor(full, tmp, o.maxWaitS);
  if (r.rc !== EXIT_OK || !r.answer) {
    log(`顾问这一轮没走完（dskts 退出码 ${r.rc}，答案 ${r.answer.length} 字）`);
    return { advice: null, rc: r.rc === EXIT_PREREQ ? EXIT_PREREQ : EXIT_ERROR };
  }
  const advice = parseAdvice(r.answer);
  if ("error" in advice) {
    fs.writeFileSync(o.advice, r.answer, "utf8");
    log(`顾问没守四行格式：${advice.error}（原文已存 ${o.advice}，人工看一眼）`);
    return { advice: null, rc: EXIT_ERROR };
  }
  fs.writeFileSync(o.advice, `${renderAdvice(advice)}\n`, "utf8");
  process.stdout.write(`${renderAdvice(advice)}\n`);
  log(`已落 ${o.advice}`);
  return { advice, rc: EXIT_OK };
}

async function opApply(o: Opts, file: string): Promise<number> {
  const text = fs.readFileSync(file, "utf8");
  const advice = parseAdvice(text);
  if ("error" in advice) { log(`解析失败：${advice.error}`); return EXIT_ERROR; }
  process.stdout.write(`${renderAdvice(advice)}\n`);
  const d = classifyDanger(advice.cmd);
  if (advice.action === "shell" || advice.action === "python") {
    log(d.danger ? `闸门：拦下（${d.why.join("、")}）` : "闸门：放行");
  }
  return EXIT_OK;
}

/** 执行一条已解析的指令，并把这一轮记进 state.md。 */
async function opAct(o: Opts, advice: Advice): Promise<number> {
  const s0 = readState(o);
  const record = (verdict: string, summary: string): void => {
    writeState(o, appendRound(s0, { action: advice.action, cmd: advice.cmd, expect: advice.expect, verdict, summary }));
    log(`已记进 ${o.state}（第 ${s0.rounds.length + 1} 轮：${verdict}）`);
  };

  if (advice.action === "done") {
    process.stdout.write(`完成：${advice.cmd}\n`);
    record("完成（顾问判定 done）", summarizeOutput(advice.cmd));
    return EXIT_OK;
  }
  if (advice.action === "ask_user" || advice.action === "request_info") {
    process.stdout.write(`${advice.action === "ask_user" ? "需要人确认" : "需要补信息"}：${advice.cmd}\n`);
    record(advice.action === "ask_user" ? "待人确认（未执行）" : "待补信息（未执行）", summarizeOutput(advice.cmd));
    return EXIT_PREREQ;
  }

  const d = classifyDanger(advice.cmd);
  if (d.danger) {
    process.stdout.write(`已拦：${d.why.join("、")} → ${advice.cmd}\n要跑就人工自己跑，或改让顾问给不危险的等价步骤。\n`);
    record(`已拦（${d.why.join("、")}）`, summarizeOutput(advice.cmd));
    return EXIT_PREREQ;
  }

  log(`执行 ${advice.action}：${advice.cmd}`);
  const r = await runAction(advice, process.cwd(), `run-${s0.rounds.length + 1}`);
  const verdict = r.rc === EXIT_OK ? "成功（退出码 0）" : `失败（退出码 ${r.rc}）`;
  process.stdout.write(`${verdict}\n${r.out}\n`);
  record(verdict, summarizeOutput(r.out));
  return r.rc === EXIT_OK ? EXIT_OK : EXIT_ERROR;
}

/** 循环要不要停（纯函数，离线可测）。
 *  done = 顾问判定完成，正常收工（0）；
 *  ask_user / request_info / 被闸门拦下 = 交回给人（2）；
 *  命令自己失败**不停**——下一轮把错误带给顾问，这正是这套桥的用途。
 *  2026-10-09 实测过反面：done 返回 0 而循环只在 2 时停，于是又空转三轮问出三个 done。 */
export function loopDecision(action: Action, actRc: number): { stop: boolean; rc: number } {
  if (action === "done") return { stop: true, rc: EXIT_OK };
  if (actRc === EXIT_PREREQ) return { stop: true, rc: EXIT_PREREQ };
  return { stop: false, rc: actRc };
}

async function opRun(o: Opts): Promise<number> {
  let formatFails = 0;
  for (let round = 1; round <= o.rounds; round++) {
    log(`—— 第 ${round}/${o.rounds} 轮 ——`);
    const asked = await opAsk(o);
    if (asked.rc !== EXIT_OK) {
      if (++formatFails >= 2) { log("连续两轮没拿到合规指令，停（别在坏格式上空转）"); return EXIT_ERROR; }
      continue;
    }
    formatFails = 0;
    const advice = asked.advice!;
    const rc = await opAct(o, advice);
    const d = loopDecision(advice.action, rc);
    if (d.stop) return d.rc;
    if (d.rc !== EXIT_OK) log("这一轮命令失败了，下一轮把错误带给顾问");
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
      const advice = parseAdvice(text);
      if ("error" in advice) { log(`解析失败：${advice.error}`); return EXIT_ERROR; }
      return await opAct(o, advice);
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
