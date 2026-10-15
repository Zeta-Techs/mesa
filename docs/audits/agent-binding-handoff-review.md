# Agent 绑定体系 + 阅读区改进：交接审查清单

> 2026-10-15 · 交给审查 agent 的完整验证清单。逐条走查，每条标注 ✅/❌/⚠️（⚠️=部分成立需说明）。
> 仓库 `/Users/tongzhouhong/Documents/Ccode`，分支 `main`，全部为未提交改动（`git diff` 查看）。
> 设计规格：`docs/audits/agent-binding-design-2026-10-15.md` · 运行约定：`docs/conventions/agent-binding.md`

---

## 一、解析塔与数据模型

### 1.1 槽位机制（projects.rs）
- [ ] `PROJECT_AGENT_BINDING_SLOTS = ["reader", "discuss"]`，`STEP_SLOT_PREFIX = "step:"`
- [ ] `valid_agent_binding_slot()` 接受 `reader`/`discuss`/`step:非空非纯空白名`，拒绝 `step:`/`step`/空串/垃圾
- [ ] `set_project_agent_binding` 校验槽位白名单 + 模型须在连接名单（`accept_project_model`）
- [ ] `get_project_agent_binding` 无白名单校验（读取通用）
- [ ] `clear_project_default_profile` 对 `task_bindings` 全槽位通用清理（含 `step:*` 前缀键）
- [ ] tasks 表 `model` 列追加在 TASK_COLS **末尾**（`map_task` 按位置索引 `r.get(19)`，插中间会串列——有测试 `task_model_round_trips_without_column_shift` 钉住）
- [ ] Schedule 结构体 `model: Option<String>` 带 `#[serde(default)]`（旧 schedules.json 兼容——有测试 `schedule_model_defaults_for_old_json`）

### 1.2 纯逻辑（src/project-agents.ts）
- [ ] `taskBindingLaunch(profiles, binding)` — 绑定→三元组，失联→null，模型不在名单→名单第一
- [ ] `stepSlotKey(name)` = `"step:" + name`
- [ ] `resolveStepLaunch(profiles, taskBindings, stepName, fallbackLaunch)` = step 槽 ?? fallback
- [ ] `slotPrefs(profiles, project, slot)` = 槽命中→三件套，未绑→`projectAgentPrefs(project)` 同形
- [ ] `DISCUSS_BINDING_SLOT = "discuss"`
- [ ] `resolveTaskModel(input)` 三档：目标绑定在名单 > 命中项目默认连接取项目模型 > 名单第一
- [ ] `workspaceLaunchChain(launch, stepLaunch, last)` 字段级三链：手选 > 步骤绑定 > wsLast

---

## 二、指派表核对（谁吃哪层——**逐文件逐行验证**）

| 入口 | 期望 | 文件:行 |
|---|---|---|
| 开工弹层 | 步骤绑定作预选（弹层可见选择=最终值） | `KickoffConfirmDialog.tsx:253-320` |
| 任务卡「继续」 | DB 直查步骤绑定 → props 链降级；标题带 agent 名 | `TaskCardsSection.tsx:499-553` |
| StepFlow「去终端看看」 | DB 直查步骤绑定 → buildWorkspaceTerminalRequest | `StepFlow.tsx:1391-1416` |
| StepFlow 决策续跑/引用改样式 | resume 优先（stepLaunch 不影响 resume 短路） | `StepFlow.tsx:1095,1123` |
| 「跟 AI 商量一下」(chatDraft) | **不吃步骤绑定**——用 discussLaunch（TaskCardsSection 传入的 projectLaunch prop） | `StepFlow.tsx:1210-1270` |
| StepFlow MCP 登录 | 同上，discussLaunch | `StepFlow.tsx:2340-2355` |
| 聊想法 (onDiscuss) | discussLaunch | `TaskCardsSection.tsx:410-435` |
| 文件/资源/文档问 AI | slotPrefs(discuss) | `ProjectGroup.tsx:1251, WorkspacesPage.tsx:2473, OfficeProjectView.tsx:253, ProjectChatsView.tsx:150` |
| ＋新对话 | slotPrefs(discuss) | `OfficeProjectView.tsx:292` |
| 编程进树/建树 | **项目默认，不动**（不引用 slotPrefs） | `CodingProjectView.tsx:481,598` |
| 评审退回修改 | DB 直查步骤绑定 → stepLaunch 参 | `WorkspaceReviewView.tsx:1530-1565` |
| help-wanted 去终端回答 | resolveStepLaunchByWorkspace | `WorkspacesPage.tsx:3000-3015` |
| 整理为笔记 | workspaceLaunchChain(null, stepLaunch, wsLast) | `TerminalPage.tsx:6600-6630` |
| 精读阅读会话 | get_project_agent_binding(reader) → taskBindingLaunch | `TerminalPage.tsx:6245-6300` |

**特别核查**：
- [ ] `CodingProjectView` 不引用 `slotPrefs`/`DISCUSS_BINDING_SLOT`（grep 确认零命中）
- [ ] `ask-ai.ts` 本体不引用 `slotPrefs`（preferred 三件套全在调用方展开）
- [ ] `projectAgentPrefs` 本体未改（签名/行为与改前一致——对照 git diff）

---

## 三、开工弹层（KickoffConfirmDialog）

- [ ] props 接收 `taskBindings`（ProjectGroup 挂载点 2483 行下发）
- [ ] `stepBinding = taskBindingLaunch(profiles, taskBindings?.[stepSlotKey(step.name)])`
- [ ] **两处** `pickKickoffLaunch` 调用（初值 useMemo ~253 行、重置 useEffect ~280 行）都传步骤绑定作 preferred
- [ ] 重置 effect 依赖数组包含 `stepBinding` 和 `kickoffMemory`（否则异步到位后不重置）
- [ ] `editingLaunch` 初值 = `!(stepBinding || preferredAgent || kickoffMemory)`
- [ ] `kickoffMemory` = `loadKickoffLast(projectPath) ?? (remembered || null)`——kickoffLast 优先，askAi 全量只读回落（**不过滤 useDefault**）
- [ ] `saveStepDefault` 两态：勾=写槽，不勾=**槽原样不动**（不写不清）
- [ ] `saveStepDefault` 初值 = `selectionMatchesSlot`（槽存在且当前选择==槽值）
- [ ] 偏离时自动摘勾 effect 存在且依赖 `[selectionMatchesSlot]`
- [ ] 展开态选择≠槽值时披露行「已存默认 X；本次用 Y（不勾即不改默认）」
- [ ] `confirmKickoff()`：无条件写 `saveKickoffLast(projectPath, ...)` + 勾选时 fire-and-forget `set_project_agent_binding`（`.catch(() => {})` 不拦开工）
- [ ] `saveAskAiRemembered` **不再被调用**（弹层停写全局 askAi——grep 确认 `saveAskAiRemembered` 零引用）
- [ ] 折叠行旁标「· 本步骤默认」（`selectionMatchesSlot` 时）
- [ ] `slotLine` 用 `kickoffLaunchLabel({...stepBinding, effort: null}, ...)`
- [ ] `pickKickoffLaunch` 签名已拓宽：`remembered: Pick<AskAiRemembered, "agentId"|"profileId"|"model"> | null`（kickoffLast 三件组可传入）

### 3.1 kickoffLast 记忆（kickoff-launch.ts）
- [ ] `kickoffLastKey(root)` = `"ccode.kickoffLast." + root`
- [ ] `loadKickoffLast` 坏 JSON / 缺字段 → null（不抛）
- [ ] `saveKickoffLast` 隐私模式静默不记

---

## 四、TaskCardsSection 派生链

- [ ] `projectLaunch = useMemo(projectAgentLaunch(...), [profiles, preferredAgent/Profile/Model])`（**已 memo 化**——否则 discussLaunch memo 永不命中）
- [ ] `discussLaunch = useMemo(() => taskBindingLaunch(profiles, taskBindings?.[DISCUSS_BINDING_SLOT]) ?? projectLaunch, [...])`
- [ ] `stepLaunchFor(stepName)` = `resolveStepLaunch(profiles, taskBindings, stepName, discussLaunch)` — **fallback 是 discussLaunch 不是 projectLaunch**
- [ ] `onContinue` 是 `async`：先 DB 直查（`get_project_agent_binding` + `stepSlotKey(card.step)`），失败走 props 链 `stepLaunchFor(card.step)`
- [ ] `onContinue` 标题带 agent 名：`${card.name} · ${agentLabel}`
- [ ] `onContinue` 整链空时 `setError` 不开死终端
- [ ] `claimForCard(card, launch?)` 参数化——`onDiscuss` 传 `discussLaunch`，`onContinue` 传解析出的 `launch`
- [ ] `onStart` 不传 launch（spawn 时 `claim_next_session_for_step` 兜底）
- [ ] StepFlow 挂载传 `projectLaunch={discussLaunch}`（**不是** projectLaunch 变量）

---

## 五、pipeline-start.ts 三链

- [ ] `buildWorkspaceTerminalRequest(ws, prompt?, opts?)` — `opts.stepLaunch` 可选参
- [ ] 内部用 `workspaceLaunchChain(opts?.launch, opts?.stepLaunch, last)` 纯函数
- [ ] `autoStart = Boolean(opts?.autoStart && chain.profileId)`（**无** `|| opts.launch?.profileId` 冗余）
- [ ] resume 短路在链之前（`resume?.agentId ?? chain.agentId`，`resume ? undefined : chain.profileId`）
- [ ] `resolveStepLaunchByWorkspace(ws, profiles)` — read_project_config first-match + get_project_agent_binding
- [ ] `workspaceReuseKey` 注释在正确位置（**不**挂在 resolveStepLaunchByWorkspace 头上）

---

## 六、WorkspaceReviewView / WorkspacesPage / TerminalPage

- [ ] WorkspaceReviewView 退回修改：`researchContext?.step` + `repoPath` → DB 直查 → `stepLaunch` 传入 buildWorkspaceTerminalRequest
- [ ] WorkspacesPage help-wanted（~3000 行）：`resolveStepLaunchByWorkspace(ws, profiles)` → stepLaunch
- [ ] WorkspacesPage:474 **不传** stepLaunch（startPipelineStep 透传通道，开工 launch 直传）
- [ ] TerminalPage organizePdfExcerpt：`workspaceLaunchChain(null, stepL, last)` 纯函数拼三元组（不自拼 `??` 链）
- [ ] TerminalPage resolveReaderLaunch：`get_project_agent_binding(slot=READER_BINDING_SLOT)` → `taskBindingLaunch`

---

## 七、B2 目标模型

- [ ] runs.rs：`CreateTaskInput.model` / `task_create` INSERT 带 model / `TaskDto.model` / `TASK_COLS` 末尾追加 / `map_task r.get(19)`
- [ ] ProjectUserTasksView `startTask`：`resolveTaskModel({models, taskModel: task.model, profileId, defaultProfileId, defaultModel})`
- [ ] 新建目标表单：模型胶囊行（随连接换档重置，空名单不显示）
- [ ] AskAiModal 验收后写入：`model: choice.model || null`

---

## 八、B3 日程模型 + 雷达解读

- [ ] scheduler.rs：`Schedule.model` / `ScheduleDto.model` / `From<Schedule>` / `CreateScheduleInput.model` / `UpdateSchedulePatch.model`（`Option<Option<String>>` 空串清空）
- [ ] 执行链：`pinned_model` **不** filter `pinned.is_some()`（模型与连接独立生效）
- [ ] 名单空时 fallback `None` + 披露「连接名单为空，本次未指定模型」（不拼空名句）
- [ ] `commit_watch_skill_draft` 直建链路 `model: None`（不透传）
- [ ] ScheduleSection 两表单：模型下拉仅显式连接时可用，「自动」时禁用
- [ ] 行内 `changeProfile`：patch 带 `model: ""` 清空
- [ ] LitWatchCard `fnKey: "watch-explain"`（不是 null）
- [ ] SettingsPage `AI_FN_ROWS` 含 `{ key: "watch-explain", label: "雷达解读" }`

---

## 九、B4 discuss 槽调用点（五处全查）

- [ ] `ProjectGroup.tsx` askAiResource（~1251 行）：`...slotPrefs(profiles, project, DISCUSS_BINDING_SLOT)`
- [ ] `WorkspacesPage.tsx` ProjectFilesView props（~2473 行）：同上
- [ ] `OfficeProjectView.tsx` 两处（问AI ~253、＋新对话 ~292）：同上
- [ ] `ProjectChatsView.tsx` ＋新对话（~150 行）：同上
- [ ] 以上组件都有 `const profiles = useAppStore(s => s.profiles)` 订阅

---

## 十、Agents 页 UI

- [ ] 名册两列定稿（2026-09-11）**未动**：`buildProjectAgentRoster` / `ProjectAgentRow` 零改动
- [ ] 专属绑定区用 `SlotCard` 组件（名册同款：卡片底色 `ccode-well`/`bg-seg-sel`、品牌位圆点换符号、连接+模型分行 ProfileMenu）
- [ ] 固定用途两卡常显：精读（◐）/ 问 AI 聊想法（◈）
- [ ] 科研步骤组：默认收起，组头摘要常显（N 步 · M 已专属 · K 失效）
- [ ] `stepGlyphFor(name, skills)` 步骤符号推导（检索🔍 精读📖 大纲📋 写作✍ 润色✨ 数据📊 画图📈 复现🔬 兜底◇）
- [ ] 步骤清单从 `read_project_config` 现读（含 `skills` 字段供符号推导）
- [ ] `pipelineSteps === null` 时**不做** stale 判定（防加载窗口误标）
- [ ] 无步骤但有 `step:*` 槽 → 组仍出现只列坏行（⚠ 前缀，可清）
- [ ] ProfileMenu `unbound` 面部渲染 `unboundLine` 文字（**不**显示空白按钮）
- [ ] 底部一行「AI 功能（翻译/摘要/雷达解读…）在设置页配置」（**不含快速开聊**）

---

## 十一、阅读区（ReaderOverlay / ReaderTlFloat / ReaderTranslatePanel）

### 11.1 侧栏收起动画
- [ ] 侧栏常挂载，收起用负 margin 滑出（`readerPanelSlideMargin` = -(栏宽+6)）
- [ ] 过渡类 `ccode-reader-panel` 只在滑动窗口内挂（`leftSlide`/`rightSlide` 状态 + transitionend + 260ms 兜底）
- [ ] open 态进依赖数组让连点重臂定时器
- [ ] 栏宽全程不变（Monaco/xterm 宿主零重排）

### 11.2 PDF
- [ ] `FIT_SETTLE_MS = 150` 停稳防抖（RO 连发期间不重算）
- [ ] 横向滚动条隐藏（`.ccode-pdf-scroll::-webkit-scrollbar:horizontal`）
- [ ] `pageRenderGate = new RenderGate(2)` 限并发

### 11.3 译文悬浮球
- [ ] 球+卡挂**覆盖层根**（坐标域整窗，可贴边）
- [ ] 位置存原始百分比 0-100，渲染 `clamp(18px, x%, calc(100% - 18px))`
- [ ] 拖球 <4px 判点击（翻转展开），>4px 换位（松手落 localStorage）
- [ ] `startOpen`（钉住接续）+ `openTick` 递进（新翻译/失败自动展开，只认变化不认存量）
- [ ] 手动收球时在途翻译压掉下一次自动展开
- [ ] 卡锚定用与球同一份 clamp 值；角柄 4px 阈值 + 基值取当前渲染尺寸
- [ ] 历史抽屉按实际空隙定方向/最大高/宽

---

## 十二、回归面（改前行为不变）

- [ ] 无步骤绑定时，开工弹层/继续/去终端/问 AI 的行为与改前完全一致
- [ ] 无 discuss 绑定时，`slotPrefs` 回落 `projectAgentPrefs` 同形三件套
- [ ] `pickKickoffLaunch` / `projectAgentLaunch` / `askAiDirectLaunch` 函数签名/行为未改
- [ ] 快速开聊（QuickChatModal）不引用任何新导出
- [ ] 接力/提炼接力/外部恢复不引用任何新导出
- [ ] resume 恒用会话原 agent（terminal-resume.ts 守卫未动）

---

## 十三、测试基线

- [ ] `npm test` 全绿（当前 1483）
- [ ] `cd src-tauri && cargo test` 全绿（当前 1360）
- [ ] `npm run build` 通过
- [ ] 新增测试：`stepSlotKey` / `resolveStepLaunch` / `workspaceLaunchChain` / `resolveTaskModel` / `slotPrefs` / `kickoffLast` 往返 / `task_model_round_trips` / `schedule_model_defaults` / `agent_binding_slot` 白名单 / `step_names_must_be_nonempty_and_unique`
- [ ] `project-agents-ui.test.ts` 桩认 `read_project_config`（返回 steps）且挂载后清零 calls

---

## 十四、文档一致性

- [ ] `docs/conventions/agent-binding.md` 存在且内容与代码一致
- [ ] `docs/audits/agent-binding-design-2026-10-15.md` 状态行标「B1–B5 全部实施」
- [ ] AGENTS.md 主题约定索引有 agent-binding 行
- [ ] architecture.md §10 有 2026-10-15 决策记录
- [ ] user-guide.md §3.4（Agents 页）/ §4.7（开工弹层勾选）/ §4.12（新建目标模型）/ §5（定时模型）/ §6.2（阅读区）/ §13.3（翻译+雷达解读行）已同步
- [ ] code-structure.md 有 agent-binding 体系 + render-gate.ts + ReaderTlFloat 条目

---

## 审查输出格式

每条标注 ✅（通过）/ ❌（不通过，附代码证据 file:line + 问题描述）/ ⚠️（部分成立，说明原因）。
最后汇总：❌ 条数 / ⚠️ 条数 / 总体判定（可发布 / 需修复后发布 / 阻断）。
