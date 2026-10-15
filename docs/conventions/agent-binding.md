# Agent 绑定体系（按用途 / 步骤 / 任务 / 日程绑专属配置）

> 2026-10-15 定稿并全部落地（B1–B5），设计全文与验证过程见 `docs/audits/agent-binding-design-2026-10-15.md`。
> 改任何「谁用什么配置启动」的路径前必读本文；改配置解析顺序须同步 `tests/project-agents.test.ts` / `tests/kickoff-launch.test.ts` 基线。

## 解析塔（统一心智）

```
本次手选（弹层/启动栏改的，永远最高）
L4 实体绑定   step:<步骤名> 槽 / 目标 tasks.agent+profile_id+model / 日程 schedule.profile_id+model
L3 用途槽位   reader（精读）/ chat（项目对话）/ discuss（问 AI 与聊想法）
L2 项目默认   defaultAgent + defaultProfiles/defaultModels（Agents 名册）
L1 记忆       ccode.wsLast（目录）/ ccode.kickoffLast.<projectRoot>（开工）/ ccode.askAi（问 AI）/ ccode.quickChat
L0 全局设置   settings.defaultProfiles / ai_profile_id / ai_profiles[fn]（含 translate、watch-explain）
```

规则：上层失效回落下层；**agent 恒随 profile 所属 CLI**（不单独绑工具）；密钥只在连接，实体只存引用；显式绑定尊重停用项；绑定连接被删 → 写侧级联清理（`clear_project_default_profile` 对任意槽键通用）+ 读侧回落。

## 存储与命令

- 槽位绑定：SQLite `projects.task_bindings`（`slot → {profile, model?}`）。白名单 `reader` / `chat` / `discuss` + `step:` 前缀（`valid_agent_binding_slot`）；写 `set_project_agent_binding`（模型须在名单）、读 `get_project_agent_binding`（无白名单校验）。
- 目标绑定：`tasks` 表 `agent + profile_id + model`（只在创建时写入；model 列**追加队尾**——map_task 按位置索引，插中间静默串列，有回归测试钉住）。
- 日程绑定：`schedules.json` `profile_id + model`（`#[serde(default)]` 兼容旧档；UpdateSchedulePatch 的 model 走 `Option<Option>+空串清空`，与 profileId 同口径；行内换配置连带清 model）。

## 指派表（谁吃哪层——改前对照，防漏改防误改）

| 入口 | 归属 |
|---|---|
| 开工弹层（KickoffConfirmDialog） | **步骤绑定**（预选来源；弹层内可见选择即最终值） |
| 任务卡「继续」（「AI 干活」行；仅当这一步的 Agent 没在出字/等确认。与「去终端看看」互斥。聚焦步骤自己的工作区卡片不重复这颗按钮） | **步骤绑定 > discuss > 项目默认**（新会话，预填继续做到完成标准；不接回旧 Agent，不复用旧标签。按步骤名现读 step: 槽）。上次工作区会话是另一家 Agent 时先问：带上 = 简报写入工作区 `.ccode/handoff-*.md`（用户原话与助手正文逐条原文；配了提炼才追加结论，且模型不得改写用户原话。未配提炼则只有原文），`mark_handoff` 的目录用仓库路径（扫描后 project_path 是仓库），新会话首条是读简报再做到完成标准；不带 = 现在这条空白继续。同一家不问 |
| 「去终端看看」 | 只在 Agent 正在出字或等确认时出现，回到那次对话 |
| 评审退回修改 / help-wanted 去终端回答 / 整理为笔记 | **步骤绑定**（执行面；resume 优先。显式要接回的，以及「去终端回答」，仍回原会话；绑定只在没有可接回的会话时作新开预填） |
| 项目「对话」里的 ＋ 新对话（含办公项目的项目对话） | **chat 槽 > 项目默认**。已有对话的继续仍用原会话 agent；agent 与 chat 槽相同才用该槽连接预填 |
| 「跟 AI 商量一下」（任务书讨论）/ MCP 登录 / 聊想法（onDiscuss）/ 文件·资源·文档问 AI | **discuss 槽 > 项目默认**（2026-10-15 用户拍板：商量类与步骤任务类型无关，不吃步骤绑定；不吃 chat 槽） |
| 编程进树/建树（CodingProjectView） | 项目默认，**不动** |
| 快速开聊 | 全局记忆 ccode.quickChat，**不进塔** |
| 接力/提炼接力/外部恢复 | 会话连续性优先，**不进塔** |
| resume（继续会话） | 恒用会话原 agent；绑定连接只作 autoLaunchProfileId 预填（agent 匹配才采纳） |
| AI 无头功能（摘要/起名/提交/翻译/雷达解读 watch-explain…） | settings.ai_profiles[fn]，全局按功能，与项目塔无关 |

派生钉死（TaskCardsSection）：`discussLaunch = discuss 槽 ?? projectLaunch`；`stepLaunch = step 槽 ?? discussLaunch`——引用同一基变量，B4 中间层自动生效。

## 关键机制

- **开工弹层两态勾选**「存为本步骤默认」：勾=写槽；不勾=槽原样不动（临时换一次不毁绑定）；清槽唯一入口在 Agents 页步骤组行内。勾选框初值=槽存在且当前选择==槽值；偏离时自动摘勾并披露「已存默认 X；本次用 Y」。
- **开工记忆拆键**：确认无条件写项目级 `ccode.kickoffLast.<projectRoot>`（预填+折叠判定 `!(stepBinding || preferredAgent || kickoffLast)`）；弹层停写 ccode.askAi（那是 AskAiModal 自管的键）。kickoffLast 缺失时只读回落 askAi 记忆做首跑预填（不回写）。
- **工作区配置三链**：`workspaceLaunchChain`（launch > stepLaunch > wsLast）纯函数单一出处——buildWorkspaceTerminalRequest 与 organizePdfExcerpt 共用，勿在别处手拼。归属判定 `cfg.steps.find(s => s.workspaceName === ws.name)` **first-match**（wsStepMap 是 last-wins，勿混用）。
- **步骤名是槽键**：编辑器+write_project_config 双端查重（重名会让绑定/坏行归堆错乱）；改名/换模板绑定可能悬空 → Agents 页步骤组坏行（⚠ 前缀）可清；摘要行「N 步 · M 已专属 · K 失效」组头常显。
- **日程例外**：pinned profile 失效 fail-loud 不换供应商（铁律只管连接层）；model 不在名单回落名单第一 + 运行历史 summary 前缀披露（无人值守不静默换档）。
- **Agents 页**：名册两列定稿不动（步骤不进名册——同一事实只在专属绑定区表达一次）；专属绑定、定时任务、科研步骤都是两列卡片（标题在左、状态标签在右、连接和模型在下）。固定用途：项目对话；科研为「问 AI / 聊想法」，编程和工作只显示「问 AI」（没有聊想法）；沉浸阅读对话只在科研项目出现。未绑时卡片里写出实际会用的项目默认，下拉第一项是「项目默认」。标题旁可「全部跟随项目默认」，清掉 chat/discuss/reader 与 step: 槽，不动定时任务。没有定时任务则不出现这一组。科研步骤直接铺开，不设收起。按项目自己的工作来：科研有步骤才显示「科研步骤」；科研无流程显示「新建目标」；工作项目显示「工作目标」；编程项目显示「开工」（工作树用项目默认，不按树绑），专属绑定不出现沉浸阅读对话。新建目标不单开槽，默认用名册项目默认。有科研步骤时，已有目标仍单独成组，可改这一条的连接（task_set_launch；正在跑则拒绝）。编程项目列出工作树，一律显示项目默认，不能按树改。编程和工作项目即使存过 reader 槽，打开阅读区也不吃它。

## 测试钉住面

`tests/project-agents.test.ts`（slotPrefs/resolveStepLaunch/resolveTaskModel/workspaceLaunchChain/taskBindingLaunch）、`tests/kickoff-launch.test.ts`（pickKickoffLaunch 链/kickoffLast 往返）、`tests/project-agents-ui.test.ts`（名册+绑定区，read_project_config 桩）、`research-kickoff-ui.test.ts`（弹层 invoke catch 降级）、cargo（槽位白名单/步骤重名/tasks model 列位/旧 schedules.json 兼容）。

## 2026-10-15 审查修复批拍板（四项，用户按推荐裁定）

- **①停用连接的启动语义＝A**：显式绑定指向停用（隐藏）连接时照常拉起 + 启动披露一句（与 Agents 页换绑侧同向）；连接被删才 fail-loud 引导重绑。目标启动侧已按此实现（goalBoundLaunch）。
- **②编程侧自由搭配＝C2a 推荐形态起步**：进入/建树默认即点即拉起；解析连接停用/失效时降为预填不自动拉起+提示（gateCodingAutoStart）。lane: 槽（C2b 终态）未开，需要时另立拍板。
- **③office/coding 遗留绑定＝可见可清**：Agents 页「遗留绑定（仅清理）」组（reader/step: 槽）。
- **④归并后 workspace 标签＝分支名**：编程工作树会话归并主仓行、workspace 列填分支名（与科研「仓库+工作区名」同构；只认 ~/ccode/worktrees/ 下的树，科研先归并防抢）。

同批落地：task_set_launch / update_schedule 写侧三件套（连接存在、agent 恒随 profile、模型在名单）；删连接级联清 tasks 引用（schedules 不清——fail-loud 铁律，读侧标失效）；profile_usage_refs 删前清点；Agents 页目标/定时卡死引用坏行。
