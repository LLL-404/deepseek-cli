# bridge — 顾问桥：网页 DeepSeek 当脑，本地当手，state.md 当记忆

写于 2026-10-09。规格来自作者那份「执行器 / 远程顾问」提示词方案；这份文档记的是**实际建成了什么、每条设计是被哪次实测逼出来的**。

一句话：每一轮把一份自包含的简报发给网页 DeepSeek，它只回四行指令，本地照抄执行一条，结果记进 `state.md`，下一轮再把最近三步带回去问。网页 DeepSeek 的上下文跨会话不互通，所以简报必须自包含；执行器可能智力有限，所以回复必须是固定四行、不给它判断空间。

## 快速上手

```
node src/bridge.ts init --goal "要做什么"        # 建 state.md（已存在则拒绝，--force 才覆盖）
node src/bridge.ts ask                          # 发简报给顾问，四行指令打到 stdout 并落 advice.txt
node src/bridge.ts act                          # 过闸门 → 执行 advice.txt 里那一条 → 记进 state.md
node src/bridge.ts run --rounds 12              # ask+act 循环，遇到 done / 待人 / 被拦 就停
```

半自动（人当信使，不让程序碰网页）：

```
node src/bridge.ts ask --emit ask.txt           # 只产简报，不发问
# 人把 ask.txt 贴进网页 DeepSeek，回复存成 advice.txt
node src/bridge.ts apply advice.txt             # 只解析、只报闸门会不会拦，不执行
node src/bridge.ts act --advice advice.txt      # 确认过了再执行
```

`--state` 换状态文件路径，`--max-wait` 换顾问等待上限（秒，默认 240），`--rounds` 换循环上限（默认 12）。

## 四行协议

```
ACTION: shell|python|read_file|ask_user|request_info|done
CMD: 一行可复制的命令
EXPECT: 预期结果（执行器据此判断成败）
FAIL: 失败时要收集并回报的信息
```

规格里还列了 `write_file` / `browser_open` / `browser_click` / `browser_type` / `screenshot`，**本桥刻意不实现**——规格自己的防呆第 3 条就是「动作集必须固定，只允许它实际有的工具」，留着只会让顾问发出执行器跑不了的指令。写文件走 `shell` 或 `python`，两者都过闸门。

解析规矩（`parseAdvice`）：`<<<ADVICE ... ADVICE>>>` 标记可有可无，markdown 围栏会被剥掉，中文全角冒号也认；但**缺字段、给了多条 ACTION、CMD 跨多行、动作不在词表，一律判失败并且不执行任何东西**。这里有个实测出来的细节：CMD 底下的续行必须被看见才能拒——只取第一行会把命令静默截断成半条再执行，那比拒绝危险得多。

## state.md

桥的唯一记忆，人也能读能改。头部三段（目标 / 环境 / 当前状态）+ `## 轮次记录`，每轮一条：

```
### 第 1 轮
- ACTION: shell
- CMD: dir /b /a-d 2>nul | find /c /v ""
- EXPECT: 最后输出文件总数
- 结果: 成功（退出码 0）
- 输出摘要: one.txt ⏎ two.txt ⏎ 2
```

简报只带**最近 3 轮**（规格要求，不带全部历史），外加当前输出或错误。输出摘要压成单行（换行变 `⏎`）、超 600 字截断并写清原字数。

## 三道闸门，都是实测逼出来的

1. **危险命令闸门**（关键词级，代码里，不接受任何参数关闭）：删除、格盘、覆盖、支付下单、对外发送、对外网络请求、装软件、改系统设置/服务/计划任务、杀进程、`git push`/`reset --hard`/`clean -f`。命中就不执行，打印「已拦：原因」，退出码 2，并在 state.md 记「已拦」。
   - 中文关键词不能用 `\b`：`支付` 两侧都不是 `\w`，压根没有词边界，实测漏过一次，所以 ASCII 词与 CJK 词分成两条正则。
   - 反方向也测：`2>nul`、`>/dev/null`、`2>&1` 都不是覆盖。这两次误拦是实弹跑出来的——`dir /b /a-d 2>nul | find /c /v ""` 被拦时，闸门就等于把工具废掉了。
2. **工作目录围栏**：`read_file` 与 `python`（路径形式）只许碰工作目录里面的东西，`..\` 与绝对路径一律拒（退出码 2）。理由是 `read_file` 读到的内容下一轮会随简报**外发给 DeepSeek**，不设围栏就是一条「读盘即外泄」的通道。
3. **输出上限 256KB**：超限立刻杀命令并截断。这条来自一次真实事故：Git 的 `/usr/bin` 在 PATH 里排在 System32 前面，顾问给的 `find /c /v ""` 里的 `find` 于是解析成 **GNU find**，它把 `/c` 当成 `C:\` 递归了整个 C 盘，一次产出 **132,258,887 字**。对策是两条：`cmd.exe` 这条路上把 System32 提到 PATH 最前（`cmdEnv()`），以及无论谁跑都要有输出上限（`capOutput()`）。

闸门是关键词级的，**不是沙箱**：`shell` 拿到的是真 shell，能 `cd` 到任何地方。真正的边界是「每轮都记在 state.md 里、人随时能翻」，加上危险家族一律要人确认。

## 传输：全部经 dskts，不自己碰浏览器

- 简报走 **stdin** 灌给 `dskts`（`--mark Bridge --out <临时文件>`），长多行文本不经命令行参数，避开 Windows 引号与 cmd OEM 代码页坑。
- 答案从 `--out` 落盘文件读，不读 stdout——终端回显会整段丢行，落盘文件才是证据。
- 顾问会话是 `Bridge｜连续会话`，**不蹭 Qoder 的连续会话**（跨 Agent 蹭会让上下文串）。
- 顾问的系统提示**每一轮都随简报重发**，不依赖会话记忆——「上下文不互通」是这套设计的前提，不是缺陷。
- 凭据一律不经桥：登录态、profile、keeper 全归 dskts 管。

## 退出码

沿用 dskts 那三档：`0` 正常（含顾问判定 done）；`1` 运行错误（顾问不守格式、命令自己失败、输出超限被杀）；`2` 需要人（危险命令被拦、`ask_user`、`request_info`、没有 state.md、围栏拒绝）。

循环的停止判据是纯函数 `loopDecision`：`done` 收工返 0；`ask_user` / `request_info` / 被闸门拦下返 2 交回给人；**命令自己失败不停**，下一轮把错误带给顾问——这正是这套桥的用途。反面实测过：`done` 返回 0 而循环只在 2 时停，于是又空转三轮问出三个 `done`。

## 与作者规格的逐条对照

| 规格要素 | 状态 | 说明 |
|---|---|---|
| 四行 ACTION/CMD/EXPECT/FAIL | ✅ | `parseAdvice` / `renderAdvice` |
| `<<<ADVICE ... ADVICE>>>` 标记 | ✅ | 有就取标记内，没有也能解析 |
| 一轮只执行一条 | ✅ | 多条 ACTION 直接拒 |
| 动作集只给执行器真有的工具 | ✅ | 6 个动作；`write_file`/`browser_*`/`screenshot` 刻意不做 |
| 自包含简报（目标/环境/状态/最近操作/输出/待定） | ✅ | `buildBriefing`，只带最近 3 轮，超 6000 字报错不截断 |
| 危险操作要人确认 | ✅ | 代码级闸门，无参数可关 |
| 复杂命令写脚本再跑 | ✅（部分） | CMD 跨多行一律拒并回这句话；`python` 动作会把代码落成 `run-N.py` 再跑一行调用 |
| 失败不自己修，只收集报错再问 | ✅ | 命令失败记进 state.md，下一轮简报自动带上 |
| state.md 外部记忆 | ✅ | 人可读可改，`init` 生成、`act` 追加 |
| 半自动 ask.txt / advice.txt | ✅ | `ask --emit` + `apply` + `act --advice` |
| `ask_advisor()` / `execute()` 两个工具 | ❌ 刻意不做 | 执行器若是 Qoder 系，直接调本 CLI 即可；MCP 层要等执行器换成别的宿主再说 |

## 验证记录（2026-10-09，全部实弹）

- **离线**：`node tests/bridge.test.ts` → 30 项全绿；`npx tsc --noEmit` 干净。**变异测试 10 个**（闸门放行、多步不拒、跨行不拒、简报带全部历史、两道围栏拆掉、简报超长不报、词表不校验、done 不停、上限不触发）逐个变红，`NOT-DISCRIMINATED = none`。
- **M0 长简报**：30 行文本经 stdin 送达，答案原样抄回首行标记 `ALPHA-7731` 与末行标记 `OMEGA-4412`，`--out` 落盘 22 字节与 stdout 一致。
- **M2 真实往返**：顾问回四行 → `act` 执行 `dir /b /a-d & … | find /c /v ""` → 输出 4 个文件名与总数 4 → state.md 记下「成功（退出码 0）」。
- **闸门反证**：手工喂 `del /q note.txt` → 打印「已拦：删除文件/目录」、退出码 2、`note.txt` 仍在；同一套代码放行 `dir /b`（双向都验，只验一边等于没验）。
- **输出上限**：喂一条喷 900KB 的命令 → 截在 262,168 字、命令被杀、退出码 1、state.md 摘要 616 字。
- **M3 循环**：`run --rounds 5` 两轮收工（第 1 轮执行、第 2 轮顾问 `done`），退出码 0，state.md 恰好 2 条记录，没有空转。

## 顺手修掉的一个 dskts 冷启动 bug

第一次实弹就撞上：`unauthorized：token 不匹配`。根因是 keeper 在 `listen` 回调里才写 token（这个顺序是对的——只有抢到端口的那个 keeper 才该写），但端口可连与 token 落盘之间有几毫秒窗口，冷启动时磁盘上还是上一个死 keeper 的旧 token。修在 CLI 侧：`call()` 读到 unauthorized 就重读 token 重试（最多 6 拍、每拍 400ms），已经开始吐进度就不重试（否则同一段增量会打两遍）。**没有改 keeper 的写序**——提前写会让抢端口失败的那个 keeper 把活 keeper 的 token 冲掉。实测冷启动日志出现 `token 还没落盘，400ms 后重读重试（1/6）…` 后当轮成功。

## 已知边界

- 顾问可能不守格式：连续两轮拿不到合规指令，`run` 就停（退出码 1），不在坏格式上空转。
- `cmd.exe` 是默认 shell，简报里会告诉顾问实际用的是哪个 shell；`BRIDGE_SHELL=bash|powershell` 可换（换成 bash 就不动 PATH，那种情况下用户要的就是 Unix 工具）。
- 闸门按关键词判，改个写法就能绕过（`Remove-Item` 换成 `.Delete()` 之类）——它挡的是「顾问顺手给出明显危险命令」，不是恶意对抗。真正的兜底是每轮都落 state.md、人随时能翻。
- `python` 动作要求机器上有 `python`；没有就报「起不来」，不会静默成功。
