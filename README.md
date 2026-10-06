# DeepSeek 命令行（dsk）

仓库：<https://github.com/LLL-404/deepseek-cli>（公开）

在终端里问 DeepSeek 网页版，答案打到 stdout、过程日志打到 stderr，可以进管道、可以脚本调。

> **TS 重制版（dskts）已可用**（2026-10-06）：TypeScript + Playwright + 常驻 keeper 进程，不再复制 profile——登录态常驻 `%LOCALAPPDATA%\dsk-ffprofile`，`dskts down` 一键整删（安全模型变化详见 [`dskts/README.md`](dskts/README.md)）。支持 `--stream` 边生成边打印、附件、会话管理（演练/白名单双保护）。**会话归属按 Agent 自动区分**：新建会话标题带 `<Agent 名>｜` 前缀，各 Agent 各有自己的连续会话，`dskts whoami` 看这次被认成谁（识别规则表见 `dskts/README.md`）。keeper 在会清理进程树的宿主（IDE 沙箱等）里会自动改由 explorer 代启，所以能跨命令常驻，之后每次调用走 3 秒热连接。规划与验收记录在 `output/`（Gate 风控验证 PASS）。Python 版按计划保留为后备，本文其余部分描述的是 Python 版。

    dsk "你的问题"                # 默认接在 qoder｜连续会话 里问，不新开
    dsk --new "问题"              # 确实要另开一条时才加，会命名成 qoder｜问题前 16 字
    dsk -  < 问题.txt             # 从标准输入读
    dsk --out 答案.md "问题"      # 同时写文件
    dsk --file 附件.md "问题"     # 先挂附件（可重复）
    dsk --no-think --no-search "问题"  # 「深度思考」「智能搜索」默认都开，要关哪个加哪个
    dsk --max-wait 420 "问题"     # 等待总上限（秒）；深度思考+搜索双开容易超默认 240
    dsk chats                     # 列会话
    dsk --chat 关键词 "问题"      # 接到指定会话后面
    dsk rm 关键词                 # 删会话；默认只演练，加 --yes 才真删
    dsk up / status / down        # 起环境 / 看状态 / 收摊

完整选项表在 `dsk --help`（就写在本文件同级的 dsk.py 头部）。

## 它是怎么工作的

复制一份你的火狐 profile 到 `%LOCALAPPDATA%\dsk-ffcopy`，用 `--marionette` 起一个独立火狐实例，我按 Marionette 协议在网页里发问、等生成、读回答案。不碰你正开着的火狐窗口，不撞图形人机验证。副本里有登录凭据，所以每次用完都要 `dsk down` 关掉并删除。

复制的取舍写在 `COPY_IGNORE`（`dsk.py` 常量区）：密码库 `logins.json` 和浏览历史 `places.sqlite` 对本次问答没用，一律不抄；但 **`key4.db` 必须留着**——cookies 要用它解密，不带就没有登录态，起来是个没登录的窗口。Marionette 的协议细节（帧格式、命令名、为什么提交要发特殊键）集中在 `dsk.py` 头部的「命令名与帧格式」备忘里，别处不重抄一遍。

实测耗时（2026-10-05，本机）：冷启动（复制 profile + 起实例）约 27 秒，副本还在时复用约 21 秒出答案。

答案取的是页面自己的容器，不是整页正文的切片：一条助手回答的正文在 `.ds-assistant-message-main-content` 里，思考过程在另一个容器 `.ds-think-content` 里，两者是兄弟，所以读正文容器天然不带思考独白；代码块的横幅（语言名、复制、下载）在正文容器**里面**，读数前临时隐藏、读完还原。判「这一问答完没有」要两个信号同时点头：正文容器比提交前多出一条（或最后一条的文本变了）且文本连续几拍不变，**同时**页面上「停止」按钮已经消失——只看文本稳不稳，生成中途一停顿就会把半截答案当成品、退出码还是 0。等待中读数偶尔抖一拍会自动跳过重读，连挂五拍才收摊（已拿到字就按可能截断返回）；等待总上限默认 240 秒，`--max-wait` 可调。侧栏连读几把都是空才当真——侧栏慢渲染时一把空的就开新会话，会把「连续会话」裂成好几条（2026-10-05 收紧）。提交前先把前提验掉——上一条还在生成时，回车会被页面吃掉。

2026-10-05 之前不是这样的，那版把「问题文本在整页 `body.innerText` 里第 N+1 次出现之后」当作答案，N 是提交前数出来的次数。这条路有个改不掉的干扰：侧栏会把每条会话的首个问题当标题列出来，同一段文字因此在页面上出现好几次，次数被算多就切到末尾、返回空答案，而退出码照旧。真实代价是一次 0 字答案配退出码 4。

## 怎么验

```
python tests/test_answer.py            # 14 项离线测试：answer_state() 7 项 + wait_for_answer() 7 项（注入假读数，不起浏览器）
python tools/probe_answer_container.py # 在真页面上量容器读数（会自己起环境）
```

两套不能互相替代：标准库执行不了页面 JS，选择器失效只能靠第二条撞出来；反过来第二条不验状态判定，那部分只能离线测。测试件用 `compile+exec` 载入 `dsk.py` 而不是 `import`，因为字节码缓存的失效判据是「源码 mtime 秒数 + 字节数」——2026-10-05 变异测试实测到：把 `("generating" if busy else "ready")` 两个词对调（字节数不变）后一秒内写回原文件，测试仍报 `FAILED (failures=3)`，删掉 `__pycache__` 才恢复；`python -B` 挡不住，它只禁止写字节码，照样读旧的。

dskts 侧的对应验证（都在 `dskts/` 下跑，同样不起浏览器）：`npx tsc --noEmit` 做类型检查，`node tests/judge.test.ts`、`node tests/agent.test.ts`、`node tests/frame.test.ts` 共 34 项离线测试，另有 `tools/probe.ts`、`tools/probe_prime.ts` 两个联网诊断器。

## 三条硬规矩

不往外发正文和未公开设定，只发工具用法、报错原文、通用技术问题。不伪造 `bf`、`dltk` 这类反爬令牌，也不在浏览器之外重放你的会话凭据。删除只认 `qoder｜` 前缀的会话，没前缀的一律拒绝（`--any` 才能越过，那是显式动作）。

## 文件都在哪

真身 `dsk.py` 在这个目录里。PATH 上的入口是三个小文件，都在 `~/.qoder-cn/bin/`：`dsk`（Git Bash 用）、`dsk.cmd`（cmd 和 PowerShell 用）、`dsk.py`（ASCII 路径的转发桩）。桩是必需的：cmd.exe 按 OEM 代码页解析 `.cmd`，中文路径写进去会乱码，所以入口文件名和路径全 ASCII，由 Python 按 UTF-8 源码去找真身。

`DESIGN.md` 是这套东西的总设计：为什么选「驱动带登录态的浏览器副本」这条路、四层各自该知道什么、一次提问的完整时序与退出码契约、失败模式表、验证的三层分工，以及还欠着的技术债。`DESIGN-dsk2.md` 是下一步的设计件：改用 Edge 扩展加 Native Messaging，不再复制 profile，也不再从 DOM 容器里取词——拿的是页面自己发出的响应流，思考、答案、结束原因本来就是分开的字段。`docs/` 里是三轮外部评审的原文和我用来提问的问题件——放在这里是因为它们记着很多实测细节，散在临时目录迟早被清。

`tests/test_answer.py` 是离线回归件（标准库 unittest，14 项：`answer_state` 7 项 + `wait_for_answer` 7 项，后者注入假读数序列、tick 调到毫秒级，照样不起浏览器），`tools/probe_answer_container.py` 是联网探测器：它对着真页面报容器条数、隐藏代码块横幅前后的字数差、两次读数是否一致，以及答案里有没有混进思考标记——这四个类名一旦失效，它先叫。这两个目录是 2026-10-05 按结构评审的建议建的，评审那句「一次性探测脚本不要删，改成可重复跑的工具」就是它存在的理由。

## 已知软肋

它自动化的是你自己已登录的网页版界面，这未必符合站点的服务条款；账号被限制或静默降级的风险由使用者自己承担。所以代码里划死了三条边界：不伪造反爬令牌、不在浏览器之外重放凭据、删除只认自己打的前缀。

`Navigate` 之后是固定 sleep，慢网页上会取到没渲染完的页面（会带着当前 URL 报错，不会静默出错）。一次只允许一条自动化连接，两个终端同时跑会互相掐——2026-10-05 实测到的形态是：另一条会话执行 `dsk down`，正在等答案的这条当场 `ConnectionResetError 10054`，问题已经提交、答案却拿不到，只能重问。页面改版会让选择器失效，具体是这四个：`.ds-assistant-message-main-content`（正文）、`.ds-think-content`（思考）、`.md-code-block-banner-wrap`（代码块横幅）、「停止」按钮，届时要重探，`tools/probe_answer_container.py` 会直接把污染报出来。2026-10-05 因为用正文关键词判断会话归属，误删过两条作者自己的会话，此后删除必须只认前缀。

## 待办

**项目当前方向**（2026-10-06 定）：

1. **M4 观察期跑到 10-13 再做移交**。判据：一周内 ≥20 次真实问答（只用 dskts）、0 次「答案残缺但退出码 0」、≥3 次删除演练正确。期满达标就把 `dsk` 命令名移交给 dskts（移交包已在 `dskts/bin/` 预演通过），Python 版降为后备入口 `dskpy`。
2. **扩展路线（`DESIGN-dsk2.md`）已搁置，文档保留**。它原本要解决的三个问题里，凭据落盘已由「常驻 profile + 显式 down 整删」解决，冷启动慢已由「keeper 常驻 + 热连接」解决，剩下的「从 DOM 取词、改版要重摸」暂不构成换路线的理由。触发重开的条件：响应流拿不到或选择器频繁失效。
3. **评估要不要并进 `D:\G\github\游览器agent`**（browser-agent 3.0.0 已有 MCP Server、CLI 和插件机制），而不是平行长一套。

**Python 版（后备）遗留**——下面三条只针对 Python 版，dskts 里已分别解决或不再适用，列在这里是因为 Python 版代码还留着：

- 跨进程单实例锁没有：dskts 用「keeper 单实例 + 端口独占 + 忙时退 2 不排队」替代，Python 版仍缺（配方在 `docs/笔记-Windows文件锁.md`）。
- 错误分类与退出码：dskts 有 0/1/2 三档；Python 版仍只有 0 和 4。
- `--file` 直接喂 `.py` 会不会被页面类型白名单拒掉：dskts 已按页面 `input[accept]` 校验并明确报错，Python 版未做对照。

Python 版是后备路线，除非 dskts 出问题，否则不再动它。
