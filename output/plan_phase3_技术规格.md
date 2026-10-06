# Phase 3 技术规格：dskts

写于 2026-10-06，同日经无上下文读者测试修订一轮。基于 [Phase 1 需求梳理](plan_phase1_需求梳理.md) 与 [Phase 2 PRD](plan_phase2_PRD.md)。这是开工前的最后一份设计件，Phase 4 把它拆成任务。现版术语见文末对照表。

## 一、技术选型与理由

| 项 | 选择 | 理由 | 被否的备选 |
|---|---|---|---|
| 运行时 | Node ≥ 24 LTS | 原生跑可擦除语法的 .ts（type stripping），CLI 入口零构建步骤；Active LTS；机器已就绪 | Bun/Deno（生态可但无额外收益，保守选 Node） |
| 语言 | TypeScript strict，`tsc --noEmit` 只做类型检查 | 类型与运行解耦，改完即跑。**限制：只用可擦除语法——不用 enum/namespace/参数属性**，用 union 与 `as const` 替代 | 纯 JS + JSDoc（类型防线弱一档）；完整 tsc 构建链（违背零构建决策） |
| 浏览器驱动 | Playwright，Firefox，**有头** + persistent context | auto-wait 表达元素级等待；`page.evaluate` 当读数器；自带 Firefox 不依赖用户本机安装；协议层观察响应流是**可能收益**（P2 探测，见 R2），不是承诺 | Selenium+geckodriver（**保留为 Gate 失败的 fallback**：保住原版 Firefox 与 profile 副本模型，但拿不到流）；手写协议 TS 平移（无第三方收益）；headless（登录与风控不利，且丢失可视化调试） |
| 实例模型 | **keeper 常驻进程**（详见第二节与 D7） | Playwright 的 Firefox **不支持第二个进程重连已运行的浏览器**（`connectOverCDP` 仅 Chromium）——要兑现 PRD「热连接 ≤3 秒」与 up/down/status 语义，必须有一个持有 context 的常驻进程 | 每次命令重新 launchPersistentContext（每次多付浏览器冷启 4~8 秒，破坏热连接承诺，`up` 无意义） |
| 测试 | `node:test`（stdlib） | 测试面 = judge 纯函数 + CLI 解析，内置 runner 够用；对齐现版「不引 pytest」的轻量精神 | vitest/@playwright/test（fixture 体系重） |
| 打包 | 无 | 入口 `node dskts.ts` 直接跑；PATH 用 .cmd 桩。esbuild 仅在「单文件分发」成为真实需求时引入 | esbuild 默认打包（当前无需求） |
| 依赖面 | 运行时仅 `playwright`；`typescript` 仅 devDep | CLI↔keeper 的帧协议手写（4 字节长度前缀 + JSON，仅 127.0.0.1 自用，几十行）；不引 zod（消息形状少，手写类型守卫够）、commander/yargs（参数解析要逐字对齐现版行为）、chalk | — |

## 二、系统架构：双进程模型

沿用 DESIGN.md 的分层纪律，落在两个进程里：

```
CLI 进程（每次命令一个，退出即结束）
  dskts.ts ──── 参数解析（对齐现版逐字行为）+ stdout/stderr/exit 契约
  commands/ ─── 编排层：ask / up / down / status / chats / rm
                只懂流程顺序与退出码映射；不碰 DOM，不起浏览器
  client.ts ─── 连接 keeper（无则经 env 逻辑拉起）、收发命令帧
        │
        │  127.0.0.1:3928，4 字节长度前缀 + JSON 帧（私有协议，自用）
        ▼
keeper 进程（常驻，等价现版的「Firefox 实例」角色）
  env    ── persistent context（有头，profile=%LOCALAPPDATA%\dsk-ffprofile）、
            登录态校验、锁文件（PID+启动时间）、崩溃残留清扫
  page/  ── 会话选择、开关、填题校验、提交、读数器、取词、改名、删除、附件
  judge  ── 读数序列 → 完成判定（纯函数，与进程无关，可离线测）
  调度   ── 命令串行执行；处理中收到新命令 → 立即回 {error:"busy"}（不排队）
```

**进程与生命周期**：`up`/首次命令拉起 keeper（detached，锁文件写 PID）；`down` 连上发 shutdown → keeper `context.close()` → 删锁 → CLI 删整个 profile 目录（含登录态）；锁文件指向死 PID → 视为崩溃残留，接管重启。keeper 的过程日志原样转发到 CLI 的 stderr。

**一次提问的完整时序**（任何一步不满足就带着证据停下）：

1. `dskts.ts` 解析参数（`--chat/--out/--mark/--file/--max-wait` 等，缺值/非法值立即退 1，文案对齐现版）→ client 连 keeper。
2. 连不上 → 拉起 keeper（写锁）→ 等端口就绪（≤15 秒）；keeper 忙（另一命令在处理）→ **退 2**，报「忙：上一条还在处理」。
3. keeper 校验登录态：未登录 → `ask` 退 2 提示先 `up`；`up` 则等窗口里人工登录完自动继续。
4. 页面层选会话：最近带 `qoder｜`（或 `--mark` 自定义）前缀的会话优先；`--chat 关键词` 唯一命中才进，0/多条退 2 并列候选；无前缀会话则新开对话。
5. 开关设值（深度思考/智能搜索默认全开；已是目标值不动）。
6. `--file` 附件：显形隐藏 input → 填路径 → 轮询文件名上屏（≤20 秒）。
7. 填题回读校验逐字一致，不等退 1（防半截提交）。
8. 提交前验前提：有停止按钮 → 退 2（上一条在生成）。
9. 记提交前快照 `count_before / last_before`（即 ReadSample 的 count 与 text）→ 发回车提交。
10. 完成判定：3 秒一拍 `page.evaluate(READ_ONCE)` 取 `ReadSample` → 先认**新回合落地**（count 增多，或 count 不变但 text 变化——虚拟列表会卸掉旧回合，沿用现版认法）→ 再判完成（judge.ts，见第五节）；每拍向 stderr 发进度日志（已等秒数、字数、busy）。
11. 收尾：完整 → stdout 打印答案 / `--out` 落盘 → 退 0；**超时截断且有部分文本 → stdout 照打已得文本、stderr 标「可能被截断」、退 1**；一字未得 → 退 1 带证据（URL、容器条数、busy）。
12. 新建会话改名打前缀（在 11 之前完成；菜单项真点、填值走 JS，防 React 重渲染失效——经验平移）。

## 三、数据模型

```ts
type ConvRow    = { id: string; title: string };   // 侧栏锚点
type ReadSample = { text: string; busy: boolean; count: number };
//   text  = 最后一条正文容器取词（横幅隐藏后）；
//   busy  = 页面存在停止按钮（= 生成中）；
//   count = 正文容器条数。
type AskResult  = { answer: string; truncated: boolean;
                    convId: string; created: boolean };
type Frame      = { op: string; params: object };  // CLI→keeper
type FrameResp  = { ok: true; data: object } | { ok: false; error: string; code: ExitCode };
type ExitCode   = 0 | 1 | 2;
```

**退出码语义（写死，验收对照）**：

- `0` 成功；
- `1` 运行错误：超时截断返回、填题校验失败、取不到正文容器、一字未得、**参数/用法错误**（对齐现版 SystemExit 习惯——用法错退 1）；
- `2` 运行时前提不满足：未登录、上一条在生成中、keeper 忙、`--chat` 命中 0/多条、`rm` 撞白名单且无 `--any`。

配置零配置文件：常量全部集中在 `constants.ts`；前缀、白名单、默认值与现版逐字一致（`--mark` 自定义前缀供 rename/rm 共用，对齐现版语义）。

## 四、关键模块职责（只该知道 / 不该知道）

| 块 | 文件（进程） | 只该知道 | 不该知道 |
|---|---|---|---|
| 常量 | `constants.ts`（两进程共用） | 选择器、前缀、白名单、默认值、端口 | 页面结构之外的任何细节 |
| 环境层 | `env.ts`（keeper） | profile 目录、锁、persistent context、清扫 | DOM、命令行 |
| 页面层 | `page/*.ts`（keeper） | 定位器、等待、取词、注入 JS 片段 | 命令行、帧协议 |
| 判定 | `judge.ts`（keeper 引用；纯函数） | ReadSample 序列 → 落地/完成判定 | Playwright、DOM、文件 |
| 编排层 | `commands/*.ts`（CLI） | 流程顺序、退出码映射、帧收发 | 直接 DOM、直接起浏览器 |
| 入口 | `dskts.ts`（CLI） | 参数解析、三流契约 | 业务流程 |

**工程布局**：项目根下新建 `dskts/` 子目录（`package.json`、`tsconfig.json`、`src/`），`dsk.py` 与现有文档留在根；Python 版退役时 dskts 提升为根。Playwright 版本锁进 lockfile，Firefox 二进制由 `npx playwright install firefox` 安装，`engines` 锁 `node >=24`（入口首行检测版本）。

**拆包触发条件（预登记）**：① CLI 选项再添一批；② 出现第二个站点；③ 选择器要上回归测试。触发前不拆包。

## 五、关键设计点：完成判定的 Playwright 化

**读数器与判定器分离**——整份规格最重要的一条决策：

- Playwright 的 auto-wait 只承担元素级等待（容器出现、开关可点、导航完成），**不承担「生成完成」判定**——那需要跨拍状态（上一拍文本、稳了几拍、是否落地），`waitForFunction` 单次注入表达不了。
- 读数器：keeper 内每 3 秒一拍 `page.evaluate(READ_ONCE)` 取 `ReadSample`（横幅先隐藏再取词，逻辑平移现版）。
- 判定器：`judge.ts` 纯函数，两个阶段——**落地判定**（第 9/10 步：count 增多或 text 变化）与**完成判定**（文本稳定 N 拍 **且** `busy=false`）。现版 `answer_state`/`wait_for_answer` 的双信号语义、读数抖动容忍（单拍失败跳过、连挂 5 拍收摊：有部分文本按截断收、一字无则报错）在纯函数层对齐移植，`node:test` 注入假读数离线测——现版 14 项测试思路完整延续。

**分段续期：取消（Phase 3 拍板，回应 PRD 留白）**。理由：现版的 30 秒分段只是总预算内的日志刻度，总上限从来就是 `--max-wait`；分段带来的状态与文案复杂度不值得。总上限即 `--max-wait`（默认 240 秒），到点按第 11 步截断收摊；PRD「超时续期可见」由每拍 stderr 进度日志满足（秒数/字数/busy）。

## 六、风险点与技术决策记录

**风险**

| # | 风险 | 对策 |
|---|---|---|
| R1 | DeepSeek 对 Playwright 定制版 Firefox 风控（Gate） | F0 一锤子验证先行（判据见 PRD F0：登录无验证码墙、≥10 次问答完整、容器行为一致）；**不做任何反检测/stealth 注入**——被拦即切 Selenium 备选，不伪装 |
| R2 | Firefox 上增量读流受限（全量 body 稳、逐块不保证） | P0 不依赖流；F9 流式输出做成「探测可用才启用」，拿不到就整段返回；结构化解析以完成后全量 body 为保底 |
| R3 | 持久 profile 首次要手动登录 | 接受；「停主 Firefox 后从其 cookies.sqlite 受控导入目标域 cookie」作 P2 便利项评估——与现版复制 profile 同性质，不属浏览器外重放 |
| R4 | 页面改版取词失效 | 选择器唯一登记于 `constants.ts`；marker 警告与 probe 工具 TS 化保回归能力；报错带证据，不给空答案 |
| R5 | keeper 崩溃残留 / 并发 | 锁文件（O_CREAT\|O_EXCL，内容 PID+启动时间）+ PID 存活检查，死 PID 接管重启；keeper 命令串行 + 忙时退 2，两个终端不再互相掐断（升级点） |
| R6 | Node 版本门槛（type stripping 需 ≥24） | engines + 入口检测，低了明确报错 |
| R7 | 与 Python 版并行冲突 | 独立命令名（dskts）、独立 profile 目录（dsk-ffprofile ≠ dsk-ffcopy）、不碰 2828；迁移期 Python 版只修致命 bug |
| R8 | 3928 本地端口无鉴权 | 仅监听 127.0.0.1；与现版 2828 同级的已知取舍，单人单机语境下接受，登记在案 |

**决策记录（ADR 简条）**

- **D1** Playwright 为主、Selenium 为死规定 fallback：理由 = auto-wait + TS 原生 + 官方维护 Firefox；切换条件 = F0 失败。
- **D2** 零构建步骤：Node 24 type stripping + `tsc --noEmit`；代价 = 放弃 enum/namespace，接受。
- **D3** 判定保持纯函数：延续离线测试能力；Playwright 降级为读数器。
- **D4** 不引 zod/commander/chalk：协议面小、CLI 行为要对齐现版逐字语义。
- **D5** 不做反检测：硬规则精神延伸——不伪造、不伪装；被拦就是路线信号。
- **D6** 安全模型变更：凭据从「每次副本、用完必删」变「常驻 profile、显式 down 整删」——`status` 可见目录状态，README 写明行为变化。
- **D7** 引入 keeper 常驻进程（读者测试后新增）：Firefox 下 Playwright 无法二次重连已运行浏览器，per-invocation launch 破坏 PRD「热连接 ≤3 秒」；keeper 等价现版 Firefox 实例的角色，**不违背 Phase 1「不做守护进程」**——那条约束指系统级服务/开机自启，keeper 是工具自管实例，由 up/down 显式管理、随 down 退出。私有帧协议手写（帧格式与 DESIGN-dsk2 描述一致，纯本地自用）。
- **D8** 分段续期取消，总上限即 `--max-wait`（第五节）。

## 七、术语与现版对照（读者测试后补）

| 术语 | 含义 |
|---|---|
| 现版 | `dsk.py`（Python 857 行，Marionette 路线），本迁移的前身 |
| 2828 | 现版 Marionette 协议端口；dskts 不使用，R8 的 3928 是它在新架构的对应物 |
| SystemExit 习惯 | 现版参数错 `raise SystemExit("文案")` → 退出码 1；dskts 沿用（用法错=1） |
| `answer_state` / `wait_for_answer` | 现版的读数状态判定与等待循环；对应 dskts 的 judge.ts（落地+完成两阶段） |
| `sweep_stale` | 现版的崩溃残留清扫；对应 env.ts 死 PID 接管 |
| `set_toggle` | 现版的开关设置函数；对应 page 层开关设值 |
| `bf`、`dltk` | DeepSeek 网页自己生成并随请求携带的反爬签名参数；硬规则禁止伪造/浏览器外重放 |
| Gate / F0 | PRD 里的风控一锤子验证，全计划第一道闸 |
| 双信号 | 完成判定 = 文本稳定 N 拍 **且** 停止按钮消失（busy=false） |
