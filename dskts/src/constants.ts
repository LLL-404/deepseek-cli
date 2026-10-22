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
/** noRender 刷新重取的固定预留（Gate F-3）。黑洞场景几乎总是首轮把 max-wait 耗满，
 *  若只共享 max-wait 一个截止时间，刷新就没预算可用、恢复能力等于废掉。预留覆盖
 *  reload 导航 + 落稳 + 至少几拍判定；正常路径用不到，总耗时不变。 */
export const REFRESH_RESERVE_MS = 90_000;
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

/** 可能触发浏览器冷启动的调用，CLI 侧超时预算。必须覆盖 keeper 侧最坏总耗时：
 *  浏览器冷启动 120 秒 + 导航 60 秒 + 页面操作（侧栏连读、附件、改名等）。
 *  2026-10-09 实测的错配：checkLogin 只给 60 秒，keeper 那边还在等火狐起，CLI 先超时退出，
 *  keeper 随后把这条命令挂成 busy，接下来的命令一律退 2——用户看到的是「它卡死了」。
 *  2026-10-14 又撞一次同款：probe 只给 90 秒，profile 被删后的全新首启超了 90 秒。
 *  2026-10-22（R7）：150 秒仍短于 chats/rm/probe 的最坏路径（冷启动 + 导航 + 连读），提到 300 秒。 */
export const COLD_LAUNCH_BUDGET_MS = 300_000;

/** up 时等用户登录的时长。CLI 超时按「登录等待 + 冷启动预算」算（R6），
 *  keeper 侧等待与 CLI 预算必须同源，否则用户还在输验证码、CLI 已经退了。 */
export const LOGIN_WAIT_MS = 10 * 60_000;

/** ask 的 CLI 超时在「等待上限 + 刷新预留」之外再留的余量：导航、附件上传、
 *  读数抖动与帧传输。keeper 看门狗按同一个值算，两边不许各写一份。 */
export const ASK_OVERHEAD_BUDGET_MS = 180_000;

/** keeper 服务端看门狗的宽限（R3）：比 CLI 对应超时多这么多——先让 CLI 报错，
 *  再由 keeper 关页面中止命令、释放 busy，避免 CLI 走了 keeper 还挂着 busy。 */
export const WATCHDOG_GRACE_MS = 30_000;

// 附件：类型白名单以页面 input[accept] 为准（旧 Python 版同款设计），这里不硬编码扩展名。
export const ATTACH_SETTLE_MS = 20_000; // 上传后轮询文件名上屏的上限

// 退出码（写死，验收对照；用法错=1 对齐旧 Python 版 SystemExit 习惯）
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_PREREQ = 2;
