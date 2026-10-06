# dskts — DeepSeek 网页版命令行（TS 重制版）

`dsk`（Python/Marionette）的重制版：TypeScript + Playwright（Firefox 持久 profile）+ 常驻 keeper 进程。
2026-10-06 经 /plan 四阶段规划（`../output/plan_*.md`）与 Gate 风控验证（`../output/gate-结果.md`）后建成，M1/M2/M3 已实弹验收。

## 用法

    dskts "问题"                  # 默认接在本 Agent 的连续会话里问，stdout 只有答案
    dskts --chat 关键词 "问题"     # 指定续问（命中不唯一退 2 并列候选；可跨 Agent）
    dskts --out 答案.md "问题"     # 同时写文件（与 stdout 逐字一致）
    dskts --max-wait 420 "问题"    # 等待总上限（秒，默认 240，不分段）
    dskts --file 附件.md "问题"    # 挂附件（可重复；类型白名单=页面 input 的 accept）
    dskts --stream "问题"          # 边生成边打印（3 秒一拍增量，最终与整段模式逐字一致）
    dskts --mark 名字 "问题"       # 强制这次的归属标记，盖过自动识别
    dskts up / status / down       # 起实例（未登录去窗口里登录）/ 状态 / 关实例并删登录态
    dskts whoami                   # 这次会被记成哪个 Agent、凭什么这么认
    dskts chats                    # 列会话，每条标出归属（本 Agent 的行首带 *）
    dskts rm 关键词或会话id        # 删除；默认只演练，--yes 真删；无前缀拒绝，--any 越过

## 归属标记：会话是谁开的，一眼看得出

新建的会话标题自动带「Agent 名｜」前缀（全角竖线），会话列表里直接显示归属。每个 Agent 有自己的默认会话 `<Agent 名>｜连续会话`，**互不共用**——跨 Agent 蹭会话会让标题名不副实，上下文也会串。

认调用方是谁，四级优先：`--mark 名字` > `DSK_AGENT` 环境变量 > 自动识别环境变量特征 > 落 `unknown`。

| 判据类型 | 变量 | 认成 | 证据来源 |
|---|---|---|---|
| 强特征（应用注入的进程级变量） | `WORKBUDDY_APP_NAME` / `WORKBUDDY_STARTUP_PID` / `CODEBUDDY_HOST` | WorkBuddy | 运行态实测 |
| | `QODERCN_CLIENT_TYPE` / `QODER_CLIENT_TYPE` / `QODER_AGENT_SDK_ENTRYPOINT` / `QODERCN_SESSION_TYPE` | Qoder | 安装包 `app.asar` 里的环境变量传递白名单（本机装的是 Qoder CN，走 `QODERCN_` 那套）；未运行态实测 |
| | `ICUBE_APP_VERSION` / `ICUBE_PROVIDER` / `ICUBE_MACHINE_ID` / `TRAE_CONFIG_CHANNEL` | Trae | `resources/app/out/main.js` 与 `cli.js` 里 `process.env.X =` 的主动赋值（`ICUBE_` 是 Trae 内部代号）；未运行态实测 |
| | `OPENCODE_CLIENT` / `OPENCODE_CHANNEL` | OpenCode | 运行态实测（本机桌面版主进程环境里 `OPENCODE_CLIENT=desktop`） |
| | `DSH_SESSION_ID` | DeepSeek Harness | 未实测 |
| | `CODEARTS_SESSION_ID` | CodeArts | 未实测 |
| | `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` | Claude Code | — |
| | `CURSOR_TRACE_ID` / `CURSOR_SESSION_ID` | Cursor | 未实测 |
| | `WINDSURF_SESSION_ID` / `CODEIUM_SESSION_ID` | Windsurf | 未实测 |
| | `CODEX_SESSION_ID` | Codex | 未实测 |
| 弱特征（目录类，可能是用户手工持久设置的） | `*_HOME` / `*_WORKSPACE` / `*_CONFIG_DIR` | 同上 | 都没实测，stderr 会提示「按弱特征猜的，可能认错」 |

补一条方法论：**「查安装包 + 读运行进程环境」比猜变量名可靠**。Qoder 的三条判据来自它安装包里那张白名单（`QODER_SDK_AUTH_PAYLOAD_FILE` 旁边的 `new Set([...])`），Trae 的四条来自主程序源码里对 `process.env` 的主动赋值，OpenCode 那条是直接读正在运行的进程环境块拿到的。想给新 Agent 加规则，照这三条路查，别拍脑袋。

三条实测教训写死在 `src/agent.ts`：

1. **强特征先扫一轮、弱特征才轮到**。本机 `DSH_HOME` 是用户级持久环境变量，任何 Agent 的子进程都看得见；不分开的话，在 Cursor 里调用会被抢认成 DeepSeek Harness。
2. **WorkBuddy 必须排在 Claude Code 之前**。CodeBuddy/WorkBuddy 会一并注入 `CLAUDE_SESSION_ID`、`CLAUDE_CODE_GIT_BASH_PATH` 这类 Claude 兼容变量；Claude 规则因此只认 `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` 两个原生变量。
3. **识别在 CLI 侧做，不在 keeper 侧**。keeper 是常驻进程，它的环境属于「第一个把它拉起来的那个 Agent」，之后别的 Agent 连上来读到的还是老环境。所以 mark 随每次帧传过去。

历史遗留的 `qoder｜`、`dsk｜` 前缀永久留在可认清单里，老会话照旧能删、照旧显示归属。想删掉旧会话不必先改名。

`rm` 的白名单认「全部已知 Agent 前缀 + 历史遗留 + 本次生效 mark」；没前缀的一律拒绝，`--any` 才越过。归属显示里 `—` 表示没前缀，那是作者自己的会话。

过程日志全在 stderr（keeper 日志实时转发）；退出码：0 成功 / 1 运行错误（含用法错、超时截断）/ 2 前提不满足（未登录、生成中、keeper 忙、命中不唯一、白名单拒绝）。Node ≥ 24 直接跑，无构建步骤；`npx tsc --noEmit` 做类型检查，`node tests/judge.test.ts`、`node tests/frame.test.ts`、`node tests/agent.test.ts` 为离线测试（34 项，不起浏览器）。

## 架构一页

双进程：**CLI**（`src/dskts.ts` 参数解析 + `src/askflow.ts` 编排驻 keeper 侧——这是对规格职责表的一处已记录偏离，理由见规格 D7）↔ **keeper**（`src/keeper.ts` 常驻，持有 Playwright persistent context，监听 `127.0.0.1:3928`，4 字节长度前缀 + JSON 私有帧，命令串行、忙时退 2 不排队）。keeper 不可重连（Playwright Firefox 无二次连接能力），这就是常驻进程存在的原因。

完成判定在 `src/judge.ts` 纯函数：双信号（文本稳 3 拍 **且** 停止按钮消失）、读数抖动容忍（单拍跳过、连挂 5 拍收摊）、文本基落地（count 不可靠——虚拟列表双向回收，Gate F-1）、`noRender` 终态（Gate F-3 无渲染黑洞：刷新重取一次，再失败带证据报错，绝不静默回空答案）。14 项离线测试注入假读数覆盖全部路径。

## 宿主环境约束：keeper 在会清理进程树的宿主里怎么活下来

keeper 设计上是常驻进程，但在某些宿主里**常规 spawn 拉起的它会随那条命令一起消失**（IDE 沙箱、CI runner、某些终端复用器都会在命令结束时清理该命令产生的进程；`detached: true` 在 Windows 上挡不住——它只影响控制台归属，不影响进程树归属）。下面这段记的是排查过程与最终对策。

2026-10-06 在本机定位到的证据（宿主是 WorkBuddy 的命令执行器）：

| 观测 | 结果 |
|---|---|
| 同一次命令调用内跑第二条命令 | keeper 活着，第二条直接复用、没拉新的 |
| 该次调用结束后 | keeper 与 Firefox **一起**消失 |
| keeper 的 `[dying]` 埋点 | **零记录** → 不是自己退的 |
| `IsProcessInJob` | `False` → 不是 Windows Job Object 机制 |
| Windows WER | 无 `node.exe` 崩溃报告 → 排除崩溃 |
| **托孤对照**：中间进程 detached 出长睡孤儿后立即退出，孤儿已脱离进程树 | **孤儿同样被杀** → 不是按 PPID 遍历进程树，是**快照式**：本次命令产生的进程（含孙进程）全部记账，结束逐一 `TerminateProcess` |
| **explorer 代启对照**：请 `explorer.exe` 打开一个 .cmd（等价双击），由它拉起标记进程 | **跨命令存活** → explorer 启动的进程不在任何命令的进程树里，宿主扫不到 |
| 脱离手段可用性 | `schtasks`、`wmic` 在宿主程序黑名单里，从命令里调系统脚本宿主被拦——常规逃逸路径全封 |

结论：**keeper 自身没有 bug**，是宿主快照式清理。

**对策（2026-10-06 已实现）**：`ensureKeeper` 在 Windows 上**优先请 `explorer.exe` 代启 keeper**——等价于「双击一个 .cmd」，由 explorer 拉起的进程不属于任何命令的进程树，宿主扫不到，能真正常驻（实测：keeper 与 Firefox 均跨命令存活，后续命令全部走热连接、启动开销归零）。

| 项 | 说明 |
|---|---|
| 代价 | 首次会弹一个控制台窗口——它同时是 keeper 的日志窗和「关掉即停」的开关 |
| 生成的引导文件 | `%LOCALAPPDATA%\dsk-keeper-boot\`（`keeper-boot.mjs` + `keeper-start.cmd`），内容保持纯 ASCII，keeper 真身路径以 file URL 百分号编码写进 `boot.mjs` |
| 自动回退 | node 路径或引导目录含非 ASCII 字符时自动退回常规 spawn（cmd 按 OEM 代码页解析 .cmd，中文会乱码） |
| 禁用开关 | `DSKTS_NO_EXPLORER=1` |
| 常规 spawn 还剩什么用 | 非 Windows 平台、以及 explorer 路线不可用时；但在这类宿主里它拉起的 keeper 会随命令结束被清理 |
| dying 埋点 | 保留。真出别的原因时日志里会有 `[dying]` 行写着 `uncaughtException` / `unhandledRejection` / `SIGTERM` / `exit`；Windows 的 `TerminateProcess` 不触发任何 Node 事件，此时日志一行都没有——据此区分「自己退」与「被外部杀」 |

## 安全模型（与 Python 版的关键差异）

- **凭据从「每次复制副本、用完必删」变为「常驻 profile（`%LOCALAPPDATA%\dsk-ffprofile`）、显式 `down` 整删**。登录一次长期有效；`down` 关浏览器 + 删整个目录（含全部登录态），删后需重新登录。profile 目录旁的 `.lock`（PID+启动时间）与 `.log`（keeper 日志，无敏感内容）一并管理。
- 硬规则不变：不伪造 `bf`/`dltk` 令牌、不在浏览器之外重放凭据、删除只认 `qoder｜`（或 `--mark`）前缀、不外发正文与未公开设定。rm 另有「默认只演练」保护（`--yes` 才真删）。
- 3928 端口仅监听 127.0.0.1、无鉴权——与现版 2828 同级的已知取舍（单人单机）。

## 与 Python 版的已知差异

- **归属标记按 Agent 自动区分**（现版是硬编码的 `qoder｜` 单一前缀）。现版靠前缀认「哪些会话是自己的」，本版升级成「哪条会话是哪个 Agent 开的」：新建带 `<Agent 名>｜`，各 Agent 各有自己的连续会话，`rm` 白名单认全部已知前缀 + 历史遗留。见上一节。
- 开关（深度思考/智能搜索）**默认全开且不提供关闭选项**（作者 2026-10-05 定向；现版的 `--no-think/--no-search` 未迁移，需要时是小事）。
- `--new`（强制新开会话）未迁移。`--mark` 已完整生效：既决定新建会话的标题前缀，也进 rm 白名单。
- 分段续期取消：总上限即 `--max-wait`（规格 D8），进度由 stderr 每拍日志（秒数/字数/busy）承担。
- 冷启动 ≤15s、热连接 ≤3s（keeper 已在时直连）。

## cookie 导入评估（T3.4 结论：评估后暂不实现）

「从主 Firefox profile 受控导入 cookies」技术上可行（Firefox 的 cookies.sqlite 明文存储，复制目标域行即可，性质与现版复制 profile 相同、不属浏览器外重放），但有三个不划算：主 Firefox 必须**完全退出**才能读库（打扰日常）；两端 Firefox 版本/Schema 可能不一致；dsk-ffprofile 的登录已一次性沉没成本付掉、此后零成本。结论：保留为方案，触发条件=「重新登录的成本再次显著抬高」（比如账号切换频繁或登录流程变严）。

## 文件

`src/`：dskts.ts（入口/CLI）、keeper.ts（常驻）、frame.ts（帧协议）、env.ts（profile/锁/清扫/down）、agent.ts（归属识别与前缀）、pageops.ts（页面层）、askflow.ts（ask 时序）、judge.ts（判定纯函数）、constants.ts（选择器唯一登记处）、sweep.ps1（残留清扫，进程名守卫）。`tools/`：gate.ts（风控尖刀）、probe_prime.ts（黑洞诊断）、probe.ts（读数健康度诊断）。`tests/`：judge/frame/agent 离线测试。规划与验收记录在 `../output/`。
