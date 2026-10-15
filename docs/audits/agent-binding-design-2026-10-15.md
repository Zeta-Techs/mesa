# Agent 绑定体系整体设计：按步骤 / 任务 / 定时 / 用途绑专属配置

| 字段 | 值 |
|---|---|
| 作者 | Mesa |
| 日期 | 2026-10-15 |
| 状态 | **B1–B5 全部实施（2026-10-15）**。B1 内含当日用户拍板修订：商量类入口不吃步骤绑定。运行口径沉淀 `docs/conventions/agent-binding.md`。三轮验证：全量代码调研（四路并行）→ 对抗批判（四视角 38 条发现，20 条 blocker/major 全部吸收，15 条复核 13 确认 2 驳倒——驳倒的两条恰证实既有处理）→ v2 新决策终检（六点裁决：名册/六注入点通过，三处 B1 语义病修正后并入本文，即 v3）。 |
| 范围 | 步骤 / 目标 / 定时任务 / 问 AI 与聊想法 / 精读的 agent 连接+模型绑定；Agents 页信息架构 |
| 前置 | `docs/conventions/agent-workbench.md`；`docs/conventions/pipeline.md`；`docs/conventions/profiles.md`；design-system.md:159 名册定稿 |

> 本文是实现规格：函数名、表名、文件路径对应当前代码。拍板后分五批落地（§3），每批基线全绿才进下一批。

---

## Overview

现状的 agent 配置散在四层（全局记忆 localStorage / 全局设置 settings / 项目默认 projects 表 / 两个实体先例 tasks 表与 schedules.json），且只有「项目默认」一层有完整 UI。本方案把它收成一座**解析塔**，把「哪个用途用哪条连接+模型」做成可声明的绑定，覆盖用户点名的全部面：**每个流程步骤、每个目标、定时任务（执行+雷达解读）、问 AI 与聊想法、精读**；开工弹层仍可临时现选（绑定只是预填默认，不锁死）。

三句设计立场：

1. **绑定 = 一条连接+模型**（用哪个 CLI 跟着连接走，不单独绑工具）；密钥永远只在连接，实体只存引用。
2. **绑定是显式声明，赢过一切隐式记忆**；本次手选永远最高。
3. **不用一张新表**：步骤/用途绑定复用 `projects.task_bindings` 槽位表，目标/定时绑定补在各自实体上。

---

## 1. 解析塔（统一心智）

```
本次手选（弹层/启动栏改的，永远最高）
L4 实体绑定   step:<步骤名> 槽 / 目标 tasks.agent+profile_id+model / 定时 schedule.profile_id+model
L3 用途槽位   reader（精读）/ discuss（问 AI 与聊想法）
L2 项目默认   defaultAgent + defaultProfiles/defaultModels（Agents 名册）
L1 记忆       ccode.wsLast（目录）/ ccode.kickoffLast.<projectRoot>（开工，新键）/ ccode.askAi（问 AI）/ ccode.quickChat
L0 全局设置   settings.defaultProfiles / ai_profile_id / ai_profiles[fn]（按功能，含翻译与新增雷达解读）
```

通用规则：上层失效回落下层；显式绑定尊重停用项；绑定连接被删 → 写侧级联清理（`clear_project_default_profile` projects.rs:625-689 已通用覆盖任意槽键）+ 读侧回落。

**定时任务例外（口径细化）**：`scheduler.rs:1089` 铁律「显式连接失效必须停止，不得换供应商出站」只管**连接层**（pinned profile 失效 fail-loud）；model 不在该连接名单 → 同连接内回落名单第一（换档不换认证，不算换家），但定时是无值守场景——执行链在运行历史 summary 前缀披露一句「绑定模型 X 已不在名单，本次用 Y」（沿 scheduler.rs:1081 披露先例），不拦不停。

**resume 例外（口径保留）**：恢复会话恒用会话原 agent（v3.93「回到那个对话」）；绑定连接只作为 `autoLaunchProfileId` 预填，且 `terminal-resume.ts:126-129` 的 agent 匹配守卫天然不跨家。

---

## 2. projectAgentPrefs 全消费点指派表（实现时的防漏改防误改清单）

| 调用点 | 归属 |
|---|---|
| ProjectGroup:1245（资源问 AI）、WorkspacesPage:2470→ProjectFilesView（文件问 AI）、OfficeProjectView:252/291（问 AI/＋新对话）、ProjectChatsView:149（＋新对话） | **discuss 槽**（B4 换 `slotPrefs`） |
| TaskCardsSection 派生点（154-163）：onDiscuss 聊想法（374-395）与 claimForCard 的 onDiscuss 调用 | **discuss 槽**（B4） |
| claimForCard（358-364，helper）| **参数化 claimForCard(card, launch?)**：认领 agent 必须与实际拉起 agent 一致（claim 键 = agent+cwd，sessions.rs:6119-6122）——onDiscuss 传 discussLaunch、onContinue 传 stepLaunch（按 card.step 现解析，非聚焦步骤的 stepLaunch）、onStart 维持预测（spawn 时 claim_next_session_for_step 兜底，StepFlow.tsx:1193-1196） |
| StepFlow chatDraft（1180-1236，任务书讨论）、StepFlow MCP 登录（2333-2347） | **不吃步骤绑定**（2026-10-15 用户拍板：商量类与步骤任务类型无关，保持一致体验）——B4 起走 discuss 槽 > 项目默认 |
| TaskCardsSection onContinue（463-479，工作树里「继续做到完成标准」＝执行续场） | **步骤绑定 > discuss > 项目默认**（执行面：同一步首场/续场不换马；按 card.step 现解析） |
| ProjectGroup:2476 → KickoffConfirmDialog（开工） | **步骤绑定**（B1，弹层内注入） |
| CodingProjectView:481/598（编程进树/建树） | **项目默认，不动** |
| ask-ai.ts / projectAgentPrefs 本体 | **不动**（discuss 用新纯函数 `slotPrefs(profiles, project, slot)`） |

槽位命名注意：产品定稿词「**商量**」专指边聊边改任务书（TaskCardsSection:842 文案定稿），那归**步骤绑定**；discuss 槽的 UI 文案叫「**问 AI / 聊想法**」，不得用「商量」。

---

## 3. 批次设计

### B1 步骤绑定（核心批）

**后端（小改动）**
- `PROJECT_AGENT_BINDING_SLOTS` 校验放宽（projects.rs:3303/3318 两处；get 侧 `get_project_agent_binding` 无白名单校验已通用）：B1 只加 `step:` 前缀；`"discuss"` 留到 B4 与消费同批（避免可写无人读的中间态）。
- 步骤重名防御：PipelineEditor 保存查重（现只拦空名，PipelineEditor.tsx:371-376）+ `write_project_config` 后端同拦（模板追加路径本就保证不重名，projects.rs:6567-6603）；改名/换模板确认文案补「步骤专属绑定按步骤名匹配，可能失效或转移」（ProjectGroup.tsx:725-742）。
- 无新表无新列。

**前端纯逻辑（project-agents.ts，全部 node --test 可测）**
- `stepSlotKey(name)`、`resolveStepLaunch(profiles, taskBindings, stepName, projectDefaultLaunch)` = step 槽 `taskBindingLaunch`（project-agents.ts:295-308 复用）?? 项目默认三元组。
- `workspaceLaunchChain(launch, stepLaunch, last)` 同步纯函数：launch > stepLaunch > wsLast（从 async 的 buildWorkspaceTerminalRequest 抽出纯链）。
- `pickKickoffLaunch` **不改**——弹层把步骤绑定解析的三元组当 preferred* 传入。口径：步骤绑定只是弹层**预选来源**，弹层内可见选择即最终启动值；绑定模型不在名单时按弹层自身链回落（预选失效≠启动错误，pickKickoffLaunch 与 taskBindingLaunch 的回落差只影响预选展示，不影响启动正确性）。

**七个注入点（全清单，批判+终检补齐）**
1. **开工弹层**：弹层已有 step 与 projectPath（KickoffConfirmDialog:90/101），props 加 taskBindings（ProjectGroup 挂载点 2471-2490 有 project）。弹层内**两处** pickKickoffLaunch 调用（初值 useMemo 251-262、重置 useEffect 276-292）都传步骤绑定，**重置 effect 依赖数组补绑定项**（否则异步到位后不重置）。`editingLaunch` 初值改为 **`!(stepBinding || preferredAgent || kickoffLast)`**——任一预填源在即折叠 launchLine；弹层**彻底删除 useDefault 概念**（终检实证：旧公式读的 remembered.useDefault 来自 ccode.askAi，与双键拆分互相串味；kickoffLast 无该字段）。kickoffLast 缺失时**只读回落** loadAskAiRemembered() 做首跑预填（不回写），保老用户肌肉记忆。
2. **「存为本步骤默认」两态**（替换现「记住这次选择」706-713；终检推翻了 v2 的「不勾=清槽」——那会让「临时换一次保留绑定」无路可走，违反「绑定=预填默认不锁死」）：勾 → `set_project_agent_binding("step:<名>", 当前三元组)`；**不勾 → 槽原样不动（不写不清）**。清槽收敛到 Agents 页步骤组行内清除（saveSlotBinding 既有通道）+ 坏行可清。勾选框初值 = `槽存在 && 当前选择 == 槽值`（防「开弹层直接确认」误清/误存）；折叠态确认 = 不动槽；展开态选择≠槽值时 launchLine 旁标「已存默认 X · 本次用 Y」披露。同时开工确认**无条件写项目级新键** `ccode.kickoffLast.<projectRoot>`（{agentId,profileId,model}）；弹层对 ccode.askAi 的写入停掉。
3. **chatDraft / MCP 登录（撤，2026-10-15 用户拍板）**：商量类不吃步骤绑定（讨论质量与步骤任务类型无关，全项目一致）；StepFlow 维持 projectLaunch（B4 换 discuss 感知）。
4. **onContinue**（TaskCardsSection:463-479）：**按 card.step 现解析** stepLaunch（执行续场——CONTINUE_STEP_PROMPT 是「继续做到完成标准」，与开工同口径；可发生在非聚焦步骤的卡上）。
5. **buildWorkspaceTerminalRequest**（pipeline-start.ts:272-312）：加可选参 `stepLaunch`，顺序 **launch > stepLaunch > wsLast**（显式声明 > 目录记忆；v3.93 resume 优先权不变——resume 命中即以会话为准，301-303 已置空）。调用方：WorkspaceReviewView:1541（researchContext.step 自持，1285-1290 按工作区名解析，rewrite 新会话分支生效）；**WorkspacesPage:474 不传**（startPipelineStep onOpenTerminal 透传通道，开工 launch 直传不受影响）；StepFlow 三处终端入口不传（商量类撤除后，其 resume 优先入口的 wsLast 回落即「回到那个对话」语义，比绑定更忠实）。归属判定用 **`cfg.steps.find(s => s.workspaceName === ws.name)` first-match**——注意与 ProjectGroup wsStepMap（528-530）不同：fromEntries 是 last-wins，勿混用。
6. **WorkspacesPage:3000 help-wanted「去终端回答」**（步骤工作区语境，执行面）：resolveStepLaunchByWorkspace 解析后传入；无会话回落才生效（该入口 resume 优先，影响面小）。
7. **整理为笔记派发**（TerminalPage organizePdfExcerpt 6585-6612，执行面）：改用 `workspaceLaunchChain` 纯函数拼三元组（6541 已自定位精读步骤），免两处顺序漂移。

**Agents 页（②专属绑定区扩展）**
- 挂载读一次 `read_project_config` 取步骤清单（catch 降级无步骤组）；`project-agents-ui.test.ts` 桩同步。
- 「流程步骤」组：每步一行 ProfileMenu（复用 reader 槽全套：unboundLine「跟随项目默认」+ 行内清除（两态勾选的清槽唯一入口）+ 跨 agent 拍平清单）；默认收起，但摘要「N 步 · M 步已专属 · K 步绑定已失效」放**组头常显**（不随折叠隐藏，名册扫下来一眼感知）；**无步骤但存在 step:* 槽 → 组仍出现只列坏行**（可清）。
- **名册零改动**：未绑步骤不进名册不进 unassigned（2026-09-11 定稿「只改展示」+「同一事实只在摘要行表达一次」；roster 函数与 12 个既有测试不破）。

**测试（函数级）**：resolveStepLaunch / workspaceLaunchChain / pickKickoffLaunch 新入参路径；弹层新增 invoke 全部 `.catch` 降级（research-kickoff-ui.test.ts:27-38 桩对未知命令 throw）；cargo：set 接受 `step:*` 拒绝垃圾键、write_project_config 步骤重名拒绝。

### B2 目标 model

- tasks 表 `ALTER ADD COLUMN model TEXT` **追加队尾**（map_task runs.rs:383-411 按位置索引，插中间静默串列）；TASK_COLS / CreateTaskInput（1399-1413）/ INSERT（1519-1541）/ TaskDto 同步；旧行 NULL 回落。
- 抽 `resolveTaskModel` 纯函数（现内联 ProjectUserTasksView:320-325）+ 三档回落测试。
- 新建目标表单与 AskAiModal「验收后写入」带 model。

### B3 定时任务 model + 雷达解读槽

- Schedule 加 `#[serde(default)] model: Option<String>`（linked_step:80-81 同款先例，旧档兼容）。**同步改全链**：CreateScheduleInput（139-150）、UpdateSchedulePatch（156-170，镜像 profileId 的 Option<Option>+空串清空约定 161-163）、ScheduleDto+From（97-123）、前端**两表单**（新建 330-350 + EditScheduleModal 507-578）四保存点（204/525/879/901）；commit_watch_skill_draft 直建链路（1970-1981）不透传 model（落 None，用户去编辑弹层绑）。
- 表单模型下拉**仅显式选定 profile 时可用**（「自动」时禁用注「跟随执行时解析」——profile 执行期才解析，名单此刻未知）；后端 model 与 profile_id 独立存。
- 执行链（1161-1168）：task.model 在名单 > 现链；失效回落名单第一 + 运行历史披露（§1 口径）。
- 雷达解读：LitWatchCard:1290-1294 fnKey `null → "watch-explain"`；ai.rs `FN_WATCH_EXPLAIN`；设置页 AI_FN_ROWS 加「雷达解读」。
- cargo：旧 schedules.json 无 model 键解析；schedule-section-ui.test 两表单基线。

### B4 discuss 槽（问 AI 与聊想法）

- 白名单加 `"discuss"`（同批有消费）。
- 新纯函数 `slotPrefs(profiles, project, slot)`（discuss 槽 ?? projectAgentPrefs 同形三件套；签名带 profiles——绑定→agent 需解析）。
- **派生钉死**（防中间层漏换）：`discussLaunch = discuss 槽 ?? projectLaunch`（TaskCardsSection:154-163 原位换基变量）；`stepLaunch = step 槽 ?? discussLaunch`——chatDraft/onContinue/MCP 登录引用同一 stepLaunch 即自然成为「步骤 > discuss > 项目默认」。onContinue 按 **card.step 现解析**（可发生在非聚焦步骤的卡上，不得复用聚焦步骤的 stepLaunch）。
- 换展开点（§2 表前两组）：ProjectGroup:1245、WorkspacesPage:2470、OfficeProjectView:252/291、ProjectChatsView:149、TaskCardsSection 派生点。**不换**：CodingProjectView、ProjectGroup:2476、projectAgentPrefs 本体。
- 步骤语境入口此时自然成为「步骤绑定 > discuss > 项目默认」。
- Agents 页固定用途组加行「问 AI / 聊想法」。

### B5 收口

- Agents 页最终形态：名册（不动）+ 专属绑定区（固定用途两行 + 流程步骤组）+ 未指派目标（不动）+ **一行**「AI 功能（翻译/摘要/雷达解读…）与快速开聊在设置页配置」（不逐项总览——全局项不在每个项目页重复）。
- 编程车道**无需适配**（终检实证）：`!!project ||` 由 commit 92b8b55（2026-09-13）引入、kickoff-launch.test:95-118 已钉住两臂。精确边界：编程项目可以没有 defaultAgent（设默认引导只在科研/办公 fresh 出现），受影响面 = 无默认编程项目 + 从未勾过问 AI「设为默认」的用户——autoStart=false 只是回落预填+手点启动，非功能损坏。可选补强：无默认编程项目首进给一行「设默认」引导（复用 projectNeedsDefaultAgent）。
- 文档：conventions 新文件 `agent-binding.md`（解析塔+指派表+三态+顺序拍板）、user-guide（§3.4/§4 开工勾选/§5 定时/§6.2/§13.3）、code-structure、architecture §10。

---

## 4. 风险表（v2 残留，均有处置）

| 风险 | 处置 |
|---|---|
| 步骤改名/换模板丢绑定 | 悬空→坏行可清+摘要报失效数；编辑器+后端查重防同名歧义；换模板文案提示 |
| kickoff 停写 ccode.askAi | 预填改 kickoffLast（项目级，语义更准）；问 AI 记忆只剩 AskAiModal 写入（by design）；编程车道不受波及（autoStart 判定现状已含 \|\| !!project，kickoff-launch.ts:95） |
| launch>stepLaunch>wsLast 推翻「上次使用」 | 显式>隐式的塔原则；仅步骤工作区+已绑定时才变；手建工作区不动 |
| 临时换一次 vs 持久绑定 | 两态勾选（不勾=槽不动）+ 旁标「已存默认 X · 本次用 Y」披露；清槽唯一入口在 Agents 页步骤组 |
| 步进器悬浮 wsLastConfig（ProjectGroup:1789-1793）显示「上次实际」而非绑定值 | 纯展示低危，不改（终检裁决），记此备查 |
| 中间态批次 | 白名单随消费批走（B1 只 step:*，B4 加 discuss） |

## 5. 执行与验收

B1 → B2 → B3 → B4 → B5；每批 `npm test` + `cargo test` + `npm run build` 全绿才进下一批；B1/B4 界面验收走 Mesa Dev（弹层三态、步骤组折叠/坏行、问 AI 换档、开工预填连续性）。
