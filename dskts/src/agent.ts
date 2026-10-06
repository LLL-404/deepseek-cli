// agent（T4.1）：归属识别——判断这次是哪个 Agent 在调用 dskts，产出会话标题前缀。
//
// 为什么探测放在 CLI 侧而不是 keeper 侧：keeper 是常驻进程，它的进程环境属于
// 「第一个把它拉起来的那个 Agent」，之后别的 Agent 连上来读到的还是老环境。
// 所以识别必须在每次调用的 CLI 进程里做，再把 mark 随帧传给 keeper。
//
// 识别优先级（高 → 低）：
//   1. --mark 显式指定           —— 人工兜底，永远最高
//   2. DSK_AGENT 环境变量         —— 调用方可以自己声明身份
//   3. 环境变量特征表 RULES       —— 自动认；认不出落 unknown
//
// 规则表的顺序即优先级，取第一个命中。**WorkBuddy 必须排在 Claude Code 之前**：
// 本机实测 CodeBuddy/WorkBuddy 会一并注入 CLAUDE_SESSION_ID、CLAUDE_CODE_GIT_BASH_PATH
// 这类 Claude 兼容变量，顺序一颠倒就会把 WorkBuddy 认成 Claude Code。

export const PREFIX_SEP = "｜";
export const HOME_SUFFIX = "连续会话";
export const UNKNOWN_AGENT = "unknown";
/** 前缀总长封顶：会话标题会被页面截断，标记太长就把问题原文挤没了 */
export const MAX_AGENT_NAME_LEN = 16;

export type AgentRule = {
  /** 归一化后的 Agent 名，直接用作前缀主体 */
  name: string;
  /** 强特征：Agent 应用启动子进程时注入的进程级变量，可信度高 */
  strong: readonly string[];
  /** 弱特征：路径/目录类变量，用户可能自己持久设置（如 DSH_HOME 就是用户级环境变量，
   *  从任何 Agent 里调用都能看到）。一级全不命中时才轮到它，避免被别的 Agent 抢认。 */
  weak?: readonly string[];
  /** 未实测的规则在注释里标出来 */
  note?: string;
};

export const RULES: readonly AgentRule[] = [
  {
    name: "WorkBuddy",
    strong: ["WORKBUDDY_APP_NAME", "WORKBUDDY_STARTUP_PID", "CODEBUDDY_HOST"],
  },
  { name: "Qoder", strong: ["QODER_SESSION_ID"], weak: ["QODER_HOME", "QODER_WORKSPACE"], note: "弱特征未实测" },
  { name: "Trae", strong: ["TRAE_SESSION_ID"], weak: ["TRAE_HOME", "TRAE_APP_ID"], note: "弱特征未实测" },
  { name: "DeepSeek Harness", strong: ["DSH_SESSION_ID"], weak: ["DSH_HOME"], note: "DSH_HOME 是本机已存在的用户级变量" },
  { name: "CodeArts", strong: ["CODEARTS_SESSION_ID"], weak: ["CODEARTS_HOME"], note: "弱特征未实测" },
  // 只认 Claude 原生变量；CLAUDE_SESSION_ID 在本机是 WorkBuddy 注入的兼容变量，不能用
  { name: "Claude Code", strong: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] },
  { name: "Cursor", strong: ["CURSOR_TRACE_ID", "CURSOR_SESSION_ID"], weak: ["CURSOR_HOME"], note: "弱特征未实测" },
  { name: "Windsurf", strong: ["WINDSURF_SESSION_ID", "CODEIUM_SESSION_ID"], note: "未实测" },
  { name: "Codex", strong: ["CODEX_SESSION_ID"], weak: ["CODEX_HOME"], note: "弱特征未实测" },
];

/** 历史遗留前缀：早先硬编码过这两个（qoder｜ 是 Python 版默认，dsk｜ 更早）。
 *  永久保留在可认清单里——不然老会话既删不掉、也给不了正确的归属显示。 */
export const LEGACY_PREFIXES: readonly string[] = ["qoder｜", "dsk｜"];

export type Env = Record<string, string | undefined>;

/** 把任意输入规范成一个可安全嵌进标题的前缀主体 */
export function normalizeName(raw: string): string {
  let s = (raw ?? "").trim();
  // 换行/制表会把标题撑坏，一律压成空格
  s = s.replace(/[\r\n\t]+/g, " ");
  // 去掉用户自己带的尾分隔符，避免出现 qoder｜｜
  s = s.replace(/[｜|]+$/, "").trim();
  s = s.replace(/[｜|]/g, ""); // 主体中间也不许有竖线
  if (!s) return UNKNOWN_AGENT;
  if (s.length > MAX_AGENT_NAME_LEN) s = s.slice(0, MAX_AGENT_NAME_LEN);
  return s;
}

/** 名字 → 标记（带全角竖线分隔符） */
export function toMark(name: string): string {
  return normalizeName(name) + PREFIX_SEP;
}

export type Confidence = "strong" | "weak" | null;

export type Detection = { name: string; hitVariable: string | null; confidence: Confidence };

/** 两轮扫描：先把所有强特征扫一遍，全不命中才轮到弱特征。
 *  这样本机那个用户级 DSH_HOME 抢不了 Cursor/Qoder 这类真调用方的位置。 */
export function detectAgent(env: Env): Detection {
  const hit = (key: string): boolean => !!(env[key] ?? "").trim();
  for (const rule of RULES) {
    for (const key of rule.strong) {
      if (hit(key)) return { name: rule.name, hitVariable: key, confidence: "strong" };
    }
  }
  for (const rule of RULES) {
    for (const key of rule.weak ?? []) {
      if (hit(key)) return { name: rule.name, hitVariable: key, confidence: "weak" };
    }
  }
  return { name: UNKNOWN_AGENT, hitVariable: null, confidence: null };
}

export type MarkSource = "cli" | "env" | "auto";

export type MarkDecision = {
  /** 最终前缀，形如 WorkBuddy｜ */
  mark: string;
  /** 归一化后的 Agent 名（去分隔符） */
  agent: string;
  source: MarkSource;
  /** 自动识别命中的环境变量名；显式指定时为 null */
  hitVariable: string | null;
  /** 识别把握：人工声明=strong；自动命中强/弱特征按实测；认不出=null */
  confidence: Confidence;
};

/** 决定本次调用的归属标记。cliValue 为 --mark 的原值（未指定传 null） */
export function resolveMark(cliValue: string | null, env: Env = process.env): MarkDecision {
  if (cliValue !== null && cliValue.trim()) {
    return {
      mark: toMark(cliValue),
      agent: normalizeName(cliValue),
      source: "cli",
      hitVariable: null,
      confidence: "strong",
    };
  }
  const declared = (env.DSK_AGENT ?? "").trim();
  if (declared) {
    return {
      mark: toMark(declared),
      agent: normalizeName(declared),
      source: "env",
      hitVariable: "DSK_AGENT",
      confidence: "strong",
    };
  }
  const d = detectAgent(env);
  return {
    mark: toMark(d.name),
    agent: d.name,
    source: "auto",
    hitVariable: d.hitVariable,
    confidence: d.confidence,
  };
}

/** 全部可认前缀：内置 Agent 全名 + 历史遗留 + 本次生效的 mark */
export function ownedPrefixes(currentMark?: string | null): string[] {
  const base = RULES.map((r) => toMark(r.name));
  base.push(toMark(UNKNOWN_AGENT));
  base.push(...LEGACY_PREFIXES);
  if (currentMark && !base.includes(currentMark)) base.push(currentMark);
  return base;
}

/** 这条会话标题归谁：命中则返回那个前缀，没有则 null（=作者自己的会话） */
export function ownerOf(title: string, currentMark?: string | null): string | null {
  return ownedPrefixes(currentMark).find((p) => (title ?? "").startsWith(p)) ?? null;
}

export function isOwned(title: string, currentMark?: string | null): boolean {
  return ownerOf(title, currentMark) !== null;
}

/** 本 Agent 的默认会话标题 */
export function homeTitleFor(mark: string): string {
  return mark + HOME_SUFFIX;
}
