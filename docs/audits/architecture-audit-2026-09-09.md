# Mesa 架构审计基线（2026-09-09）

> 审计结论：**B．方向正确，但核心架构需要重构**。重构对象是三个核心边界——Project 如何提供
> 一致可追溯的工作环境、Agent 产出如何成为有版本的待审结果、Review 如何可靠更新项目文件与状态——
> 不是推翻 Tauri/React/CLI 适配器/工作树实现。
>
> 本文只沉淀审计的**已确认事实与问题清单**（后续重构的对照基线）。报告中的建议方案
> （ChangeSet、ContextSnapshot、AcceptRecord 等）**尚未拍板**，不代表已决架构；
> 方案定稿后应进 `docs/architecture.md` §10 决策记录，不在本文追加。

## 审计基线

- 仓库 `仓库根`，分支 `main`，提交 `30ee84e`（2026-09-09）。
- 检查了核心模型、实际 SQLite Schema、Tauri 接口、前端状态、Agent 启动链、四条回流路径及相关测试。
- 数据库只读结构，未读密钥与会话正文；审计未修改代码。
- 四个场景（30 篇综述 / 实验记录+周报 / 客户汇报 PPT / 登录修复）为代码走读模拟，非真实 Agent 端到端验收。

## 当前架构事实

系统不是统一的 `Project → Goal → Result → Review` 内核，而是
**共享桌面基础设施 + 项目注册与配置 + 多条按场景建立的执行和回流链路**。

持久化现状：Project = SQLite `projects`（路径主键）+ `project.toml`；用户目标 = SQLite `tasks`；
科研步骤 = `project.toml` 的 `steps[]`；讨论卡 = `project.toml` 的 `[[tasks]]`（会话分组，非 Task）；
编程单元 = worktree + `coding_lanes`；Run = `runs`/`run_events`；Artifact = 文件系统/提货单/Run 扫描/
定时冻结证据并存；Review = 科研 Git 评审、普通目标采纳、编程 Git 操作、定时产物采纳四条路径；
项目状态另有 `project-status.json`（按目标名替换、最多 20 条）。

三条心智并存：控制台心智（选 Agent/配置/目录启动）、科研流水线心智（模板/步骤/工作区/合并）、
项目目标心智（目标→结果→意见→接受）。三者共存可以接受，但对权限、完成、产物、验收和长期状态
的定义不一致是当前核心问题。

## 问题清单（按严重度）

| # | 级别 | 问题 | 状态 |
|---|---|---|---|
| 4.1 | P0 | Agent 派生结果写主仓规则不一致：TASK.md 要求大型产物直写项目根，与「验收后写入」冲突；编程合并未复用 protected_paths 检查 | **已修复（2026-09-09，口径 C）**：派生产物写工作区、合并时带回（冲突点名）；文献 PDF/人工导入直写项目根；编程合并补保护路径检查 |
| 4.2 | P0 | 普通目标采纳的基线在采纳调用时读取，未绑定任务开始时的项目基线与冻结结果版本；`run_artifacts` 用 mtime 推断归属 | **已修复（2026-09-09）**：开工基线 + 收尾冻结 + 采纳三向判定，规格 `docs/conventions/review-freeze.md` |
| 4.3 | P0 | `task_prepare_run_impl` 复用上一版目录时，`open_run_impl` 失败会 `remove_dir_all` 删掉旧成果（runs.rs） | **已修复（2026-09-09）**：`cleanup_failed_prepare` 只清本次新建目录，回归测试 `failed_prepare_cleanup_never_deletes_reused_isolation_dir` |
| 4.4 | P1 | 目标「能否验收」被进程退出状态控制：只有 completed Run 可查看采纳；Execution Status / Result Readiness / Goal Completion 未分离 | **入口侧已解绑（2026-09-09）**：冻结证据存在即可审可采纳（含失败/停止的部分成果），目标随冻结提升待验收；Run 状态机与显式验收条件对象仍未做 |
| 4.5 | P1 | 回流四步（写文件→更新 Task→Run 事件→项目状态）无一致性边界，项目状态写入错误被忽略；删除目标连带删除 Run/事件/隔离目录，成果来源被抹掉 | **已修复（2026-09-09）**：append-only 账本 `.ccode/acceptance-log.jsonl` 必写、失败可见可重试；摘要降级为投影；删除目标不再抹验收来源 |
| 4.6 | P1 | Project 身份 = 路径主键，无稳定 ProjectId 串起全部引用 | **首期+二期地基已修（2026-09-09）**：档案卡 `id` 稳定身份 + 移动认回；tasks/runs 双写 project_id 并按路径回填；读取侧按路径的全量迁移留下一期 |
| 4.7 | P1 | Task 语义过载：用户目标 / 自动建 Task / 科研 Step / 编程 Lane / 讨论卡共用一个身份；无目标执行被 `ensure_task_at` 强制入 Task | **已修（2026-09-09）**：scratch/reader/办公闲聊不再登记 Task；TaskCard 用户可见文案统一为「话题」 |
| 4.8 | P1 | Context 是启动时动态拼接文本，无「本次实际使用的文件/规则/技能版本」快照；TASK.md 与 Context Pack 两套体系 | **已修普通目标侧（2026-09-09）**：实际下发文本冻结为 context.json（全文+哈希），评审可核对；科研侧 TASK.md 落盘即等价凭证；Memory 最小闭环已做（人勾选才进 `.ccode/memory.md`，无独立 Agent 提议区） |
| 4.9 | P1 | 技能挂载只有「全局→Agent」「科研 Step→技能」；定时采纳固定四类文献台账，不认任意 Skill 输出；科研复现验收绑定科研 workspace_id | **已修（2026-09-09）**：contentDigest + 项目技能池 + 目标点名 + 快照记版本；定时采纳 = 四类基线 + 技能声明产出契约；科研复现解绑 workspace_id 未做 |
| 4.10 | P1 | 「准备环境—启动—收尾—回流」链散落在各页面（ProjectUserTasksView / 科研开步 / 编程页 / 对话弹层 / scheduler），新增入口易再实现一份 | **普通目标链已收口（2026-09-09）**：`src/goal-run.ts` 共享启动链，ProjectUserTasksView 与 AskAiModal 双入口复用；科研开步本有 pipeline-start.ts 单一出处；编程/定时入口保留各自实现 |

## 重构方向边界（审计给出的取舍，供拍板时参考）

- 应删的是**身份与规则**而非文件：无目标执行强制 Task、TaskCard 的任务身份、以 Run 次数当成果版本号、
  mtime 当产物来源权威证据、派生结果直写项目根的旧规则。
- 应合并：启动环境数据收集逻辑、验收写回上层协议（基线/保护路径/版本确认/恢复日志/接受记录）、
  成果证据查询口径、Project State 更新入口。
- 不应合并：Conversation 与 Run、Skill 与 Workflow、科研与编程两套 worktree 库、科学结论验收与 Git 合并。
- 应复用：`watch_review` 已有的冻结证据/冲突拒绝/回滚机制，不另起通用成果引擎。
- P0 未完成前不投入：自动拆任务/智能路由、Workflow DSL、自研 Agent 循环、Cloud Runtime、
  向量记忆平台等新功能入口。

## 2026-09-10 复核后的补充边界

- §4.2：不可变版本目录、校验与写回同一采纳锁、返修继承未采纳成果；旧证据保留。已接受版本的后续返修只认账本内容哈希，不以项目现读内容重设基线。
- §4.4：Run 退出不能重开已完成目标；人显式返修可以。不是新增枚举就视为状态闭环。
- §4.5：普通目标账本按结果版本/路径集合/意见幂等；Git 补账重放原事实而非最新 HEAD，补记不合并新提交、未补记不归档。缺失凭证不能伪造补齐。
- §4.6：目标与 Run 当前定位已按 ID 查询，搬家时补关联旧记录；同 ID 的现存副本拒绝接管。原生会话文件及 Git 指针没有自动改写，跨机/三平台/实机搬家仍需专项验收。

## 验证记录

审计时（`main@30ee84e`）：`npm test` 796 通过；`tsc --noEmit` 通过；
`cargo test --lib runs::tests::` 16 通过、`watch_review::tests::` 11 通过、`workspaces::tests::merge_` 7 通过。

§4.3 修复后（2026-09-09）：`cargo test --offline --lib runs::tests::` 17 通过（含新增回归测试）。
