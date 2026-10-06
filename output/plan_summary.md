# DeepSeek命令行 全面换装 TS —— 规划汇总（plan_summary）

2026-10-06，四阶段流水线完成。本文是唯一入口，细节见各阶段产物。

## 目标一句话

把 DeepSeek 网页版命令行工具（Python 手写 Marionette 的 `dsk`）整体迁移到 TypeScript + Playwright（过渡期命令名 `dskts`，退役 Python 版后接管 `dsk`）：能力全量对齐或更强，硬规则不变。

## 已确认的四项决定

1. **驱动路线 = Playwright**（Firefox 持久 profile + keeper 常驻进程）；Selenium + 原版 Firefox 是死规定的 fallback。
2. **旧 Python 版 = 保留为后备**，dskts 过一周真实使用再退役。
3. **扩展路线（dsk2）= 搁置、文档保留**；Playwright 若能拿到响应流，其存在理由消失。
4. **范围 = 全量对齐**（P0 问答链路 / P1 会话管理 / P2 附件、离线测试、流式输出、probe）。

## 路线核心（三句话）

- **Gate 先行**：开工第一件事是风控一锤子验证——DeepSeek 对 Playwright 定制版 Firefox 的态度未验证，不过则全线回 Phase 3 换 Selenium 备选。不做任何反检测，被拦即切路线。
- **双进程架构**：Playwright 的 Firefox 无法被第二个进程重连，故由常驻 keeper 进程持有浏览器（等价现版 Firefox 实例角色），CLI 走 127.0.0.1:3928 私有帧协议；热连接 ≤3 秒、并发明确报忙不互掐。
- **判定保持纯函数**：完成判定（双信号：文本稳定且停止按钮消失）与新回合落地判定留在 `judge.ts`，Playwright 只当读数器——现版 14 项离线测试思路完整延续。

## 里程碑与工时

| 里程碑 | 内容 | 净工时 | 回退点 |
|---|---|---|---|
| M0 | Gate 风控验证（脚手架 + 尖刀脚本 + 10 连问答判读） | ≈3h | **唯一路线级回退点**：失败 → Selenium 备选 |
| M1 | P0 问答链路（常量/帧协议/env/judge/页面层/编排/验收） | ≈11~13h | 无路线回退，修到过验收 |
| M2 | P1 会话管理（chats / rm 白名单） | ≈2h | 同上 |
| M3 | P2（附件 / probe / 流式探测 / cookie 导入评估 / 文档） | ≈4.5~7h | 同上 |
| M4 | 观察期与退役（日历 7 天，与 M2/M3 并行） | — | 退役判据不过 → 继续 Python 后备 |

开发合计约 **21~25h**，可压缩在 3~4 个工作日 + 7 天观察期。

## 不变的东西（硬规则）

1. 不伪造 `bf`/`dltk` 反爬令牌；不在浏览器之外重放会话凭据（驱动真浏览器、页面自己签名）。
2. `rm` 只认 `qoder｜`（或 `--mark`）前缀会话，`--any` 越过。
3. 不往外发正文和未公开设定。
4. 凭据只存在于 profile 目录，`down` 一键整体删除且删后需重新登录。

**安全模型变化（需知悉）**：凭据从「每次复制副本、用完必删」变为「常驻 profile、显式 down 整删」——README 将显著标注。

## 产物索引

| 阶段 | 文件 |
|---|---|
| Phase 1 需求梳理 | [plan_phase1_需求梳理.md](plan_phase1_需求梳理.md) |
| Phase 2 PRD | [plan_phase2_PRD.md](plan_phase2_PRD.md) |
| Phase 3 技术规格（经无上下文读者测试修订） | [plan_phase3_技术规格.md](plan_phase3_技术规格.md) |
| Phase 4 任务拆解 | [plan_phase4_任务拆解.md](plan_phase4_任务拆解.md) |

## 下一步

批准后从 **M0/T0.1（工程脚手架）** 开工；T0.3 Gate 判读结果出来前，不写任何最终架构代码。
