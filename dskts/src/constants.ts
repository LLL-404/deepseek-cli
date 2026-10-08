// 常量层（T1.1）：页面结构的唯一登记处——选择器、前缀、默认值、端口。
// 来源：旧 Python 版 逐字平移 + Gate 实证（output/gate-结果.md 的 F-1~F-6）。
// 本文件只该知道这些常量本身；不该知道任何流程与 DOM 之外的结构。

export const CHAT_URL = "https://chat.deepseek.com/";

// 会话标记（哪个 Agent 造的）不在这里——它是运行时决定的，见 src/agent.ts。
// 本文件只登记页面结构常量，别把归属前缀再写回来。

// 一条助手消息的正文容器。思考过程在 THINK_SEL 里，取正文容器天然不含它；
// 代码块横幅（语言名+复制+下载）在容器内部，读数前临时隐藏（Gate 实证 bars 证据可用）。
export const ANSWER_SEL = ".ds-assistant-message-main-content";
export const BANNER_SEL = ".md-code-block-banner-wrap";
export const THINK_SEL = ".ds-think-content";
// 「生成中」= 页面挂着停止按钮
export const BUSY_SEL = "[class*=stop-btn],[aria-label*=停止]";

// 开关：文本叶子的最近 aria-pressed 祖先；locale 钉死 zh-CN 后走中文，英文变体兜底（Gate F-4）
export const TOGGLE_LABELS: readonly (readonly string[])[] = [
  ["深度思考", "DeepThink"],
  ["智能搜索", "Search"],
];

// —— 等待判定参数（对齐旧 Python 版语义 + Gate F-1/F-2/F-3）——
export const TICK_MS = 3_000; // 一拍 3 秒
export const MIN_WAIT_MS = 12_000; // 至少等过 12 秒才开始计稳
export const STABLE_NEED = 3; // 文本连续 3 拍不变
export const READ_FAIL_MAX = 5; // 连挂 5 拍读数就收摊
export const DEFAULT_MAX_WAIT_S = 240; // --max-wait 默认总上限（不分段，D8）
export const MAX_WAIT_S_CAP = 3_600; // --max-wait 上限（S8）：再大就碰 Node 32 位 setTimeout 溢出（约 24.8 天），封顶 1 小时
export const SUBMIT_VERIFY_TRIES = 3; // 提交验证：输入框未清空就补回车（Gate F-2）
export const SUBMIT_VERIFY_GAP_MS = 3_000;

// —— 环境层 ——
export const KEEPER_PORT = 3928; // 仅监听 127.0.0.1；无鉴权是已知取舍（规格 R8）
export const PROFILE_DIR_NAME = "dsk-ffprofile"; // %LOCALAPPDATA% 下；≠ 旧 Python 版用过的副本目录名

// keeper 是在 listen 回调里才写 token 的（只有抢到端口的那个才该写），端口可连与 token
// 落盘之间有个几毫秒窗口；冷启动时磁盘上往往还留着上一个死 keeper 的旧 token，CLI 一读
// 就被判 unauthorized。这不是配置错，重读重试几拍就好——修在 CLI 侧而不是把 keeper 的
// 写序提前，是因为提前写会让抢端口失败的那个 keeper 把活 keeper 的 token 冲掉。
export const TOKEN_RETRY = 6; // 重读 token 的重试次数
export const TOKEN_RETRY_GAP_MS = 400; // 每拍间隔

// 附件：类型白名单以页面 input[accept] 为准（旧 Python 版同款设计），这里不硬编码扩展名。
export const ATTACH_SETTLE_MS = 20_000; // 上传后轮询文件名上屏的上限

// 退出码（写死，验收对照；用法错=1 对齐旧 Python 版 SystemExit 习惯）
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_PREREQ = 2;
