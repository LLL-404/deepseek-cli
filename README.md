<div align="center">

# deepseek-cli（dskts）

**在终端里问 DeepSeek 网页版**

`stdout 只有答案` · `热连接 ≈3s` · `不开 API 付费` · `不撞人机验证`

</div>

> [!IMPORTANT]
> 答案打到 <samp>stdout</samp>、过程日志打到 <samp>stderr</samp>，能进管道、能被脚本和其他 Agent 直接调。

实现只有一份，在 [`dskts/`](dskts/)（TypeScript + Playwright + 常驻 keeper 进程）；用法全表、归属标记规则、架构与安全模型见 [`dskts/README.md`](dskts/README.md)。更早还有一版手写 Marionette 协议的 Python 实现，已被本版取代并移除；它的设计与实测细节留在 `output/`、`docs/` 的历史存档和 git 记录里。

## ⌨️ 快速开始

```
dskts up                      # 起实例；未登录会弹窗，登一次即可（登录态常驻）
dskts "你的问题"               # 默认接在本 Agent 的连续会话里问，stdout 只有答案
dskts --stream "你的问题"       # 边生成边打印（3 秒一拍增量）
dskts --out 答案.md "你的问题"  # 答案同时落盘（与 stdout 逐字一致）
dskts --file 附件.md "你的问题" # 挂附件（可重复；类型白名单=页面 input 的 accept）
dskts --max-wait 420 "你的问题" # 等待总上限（默认 240 秒，封顶 3600）
dskts --chat 关键词 "你的问题"  # 指定续问（命中不唯一退 2 并列候选）
dskts chats / rm 关键词 / status / down / whoami
```

日常手感：<kbd>dskts up</kbd> → <kbd>dskts "随便问"</kbd> → <kbd>dskts down</kbd>

需要 Node ≥ 24（靠 type stripping 免构建直接跑 `.ts`），首次用 `npx playwright install firefox` 装浏览器内核。

## ⚙️ 它是怎么工作的

<abbr title="Keep Alive 常驻进程">keeper</abbr> 常驻的意义：把冷启动的代价从「每一次提问」压缩成「当天第一次」。双进程结构在 <mark>127.0.0.1:3928</mark> 上只允许一条自动化连接——keeper 忙时后来的命令直接退 2，不排队。

```
dskts CLI ──── 127.0.0.1:3928 ────▶ keeper 常驻 ──── Playwright ────▶ DeepSeek 网页版
 解析·识别调用方                     Firefox persistent ctx            你自己的已登录会话
 串行 · 忙时退 2                     冷启动 ≤15s 仅一次 · 热连接 ≈3s     正文容器直读

 stdout = 答案原文    stderr = 过程日志    登录态常驻 %LOCALAPPDATA%\dsk-ffprofile
```

答案怎么读出来：正文容器、思考块、代码块横幅、「停止」按钮四个点取词；「停止」按钮出现且不再消失才判定本轮结束。读数与判稳细节收在折叠里。

<details>
<summary><b>读数与判稳细节</b></summary>

`.ds-assistant-message-main-content`（正文）、`.ds-think-content`（思考）、`.md-code-block-banner-wrap`（代码块横幅）、「停止」按钮。判定与读数策略：题目提交后按钮出现 → 本轮开始；按钮消失 → 本轮结束，读「全部」内容。

**归属标记识别**：连续会话靠页面消息容器自动前缀（`bf`、`dltk` 等反爬令牌不伪造），题目原文带标记即可续问；命中不唯一退 2 并列候选，绝不猜。

</details>

## 📏 三条硬规矩

> [!WARNING]
> **不外发** —— 只发工具用法、报错原文、通用技术问题；正文和未公开设定一律不出门。
>
> **不伪造** —— 不做 `bf`、`dltk` 这类反爬令牌，不在浏览器之外重放会话凭据。
>
> **删除设限** —— 只认已知 Agent 前缀的会话，没前缀的一律拒绝；<kbd>--any</kbd> 是显式动作。

## 🧪 怎么验

```
node tests/bridge.test.ts   # 顾问桥：协议解析、闸门、EXPECT 判定
node tests/env.test.ts      # 清扫门槛与 sweep.ps1 的编码守卫
node tools/mutate_bridge.mjs # 变异自检：把实现逐条改坏，看有没有用例变红
node tools/probe_prime.ts   # 联网诊断：选择器是否失效、读数健康度
```

三层各自能证明什么不能互相替代：离线测试只证明判定逻辑，联网诊断只证明「现在这个页面还长这样」，唯一算数的端到端判据是 <mark>stdout 逐字等于页面上人眼看到的答案</mark>。

## 🗂 仓库地图

| 路径 | 内容 |
|---|---|
| `dskts/` | 实现全部（CLI、keeper、bridge、tests、`tools/` 诊断器） |
| `dskts/README.md` | 用法全表、归属标记识别规则、架构一页、宿主环境约束、安全模型 |
| `output/` | dskts 迁移的规划件与 Gate 风控验收记录 |
| `docs/` | 外部评审原文与技术笔记，记着大量实测细节（历史存档） |

<details>
<summary><b>已知软肋与待办</b></summary>

### 已知软肋

它自动化的是你自己已登录的网页版界面，这未必符合站点的服务条款；账号被限制或静默降级的风险由使用者自己承担。

页面改版会让选择器失效，具体是这几个点：`.ds-assistant-message-main-content`（正文）、`.ds-think-content`（思考）、`.md-code-block-banner-wrap`（代码块横幅）、「停止」按钮。届时要重探，`dskts/tools/probe_prime.ts` 会把污染直接报出来。

一次只允许一条自动化连接：keeper 忙时后来的命令退 2，不排队。

### 待办

- **评估是否并入 `D:\G\github\游览器agent`**（browser-agent 3.0.0 已有 MCP Server、CLI 和插件机制），而不是平行长一套。
- **扩展路线已搁置**：改用 Edge 扩展 + Native Messaging、直接拿页面响应流而非从 DOM 取词。它原要解决的三个问题里，凭据落盘已由「常驻 profile + 显式 down 整删」解决，冷启动慢已由「keeper 常驻 + 热连接」解决，剩下的「DOM 取词、改版要重摸」暂不构成换路线的理由。触发重开的条件：响应流拿不到，或选择器频繁失效。

</details>

---

<div align="center">

**[🌍 个人站](https://lll-404.github.io/)** · **[GitHub](https://github.com/LLL-404)** · **[📧 邮箱](mailto:2350178663@qq.com)**

</div>
