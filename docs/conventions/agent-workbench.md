# 约定：多 Agent 工作台对象模型

| 字段 | 值 |
|---|---|
| 作者 | Mesa |
| 日期 | 2026-09-06 |
| 状态 | Accepted（v3.221 设计定稿；第 0–3 期核心行为已落地，后续只按本文件的验收标准维护，不按对象标签另起路线） |
| 范围 | 产品对象 Project → Task → Run；编程并行车道；Agent Runtime 抽象 |
| 前置决策 | 架构 v3.4 人负责拍板；v3.5 否决自动拆任务；v3.7 否决智能路由；v3.10 验收层是护城河；v3.179 科研/编程/办公三档；v3.202 编程 Git 环 |

> **改工作台主卡、终端标签生命周期、编程并行、无头/定时执行入口、AgentSpec 执行形态前必读。**
> Git 原语仍以 `coding-git.md` 为准；科研工作区生命周期仍以 `pipeline.md` 为准。本文管「一次干活是什么」，不吞那两套库。

---

## 0. 产品合同

Mesa 是 **Agent 的项目工作环境**：以 Project 为家，给人文件、规则、上下文、保护路径；人只说要完成什么（可先记下）；Agent 自己规划；改文件必须验收才进项目。CLI 是第一种 Runtime，不是产品本身。用户名词是项目 / 文件 / 目标 / 验收。Run 是账本，不进手册正文。

| 做 | 不做 |
|---|---|
| 一个项目 = 一个工作空间；里面可同时有多条隔离车道 | 把一句话自动拆成多个 Agent |
| 一次干活 = 一棵树 + 一个 Agent + 一份上下文 + 一种权限 | 系统替用户选谁做前端、谁做测试 |
| 写文件默认进隔离副本，人看过 diff 才进主仓 | 绕过评审自动合并 |
| CLI / 无头 / 以后的云端，都只是 Runtime | 自研 meta-agent、自研云端 Agent、自研 tool-call 循环 |
| 界面仍叫工作台；内核按 Project → Task → Run 长 | 改名为 AI Development OS；为叙事重做八页信息架构 |

跨厂商中立（纪律三）继续成立：Claude 不会调度 Codex。工作台的壁垒是**跨厂商 + 跨科研/编程/办公 + 主仓门**，不是更好看的 CLI。

科研步骤保持顺序（模板声明 + 人开步），是 Agent 仍弱或必须按序验收时的护栏。并行车道是**编程**的主增量。无流程科研与办公的「目标」默认把整个项目复制进隔离副本，人验收后写回。＋新对话默认在项目根直接改；要落成稿时人选「验收后写入」。禁止自动拆任务、智能路由、创建时空目录模板。

**模型越强，产品越往上走。** Agent 自己规划、自己调工具、自己出结果时，Mesa 不跟它比「我也能执行」。Mesa 管项目环境、规则、隔离、验收和长期状态。闲聊用对话；成稿用目标。Agent 弱时科研步骤仍可当护栏；Agent 强时把引导撤掉，Project 更重要。

---

## 1. 对象模型（全期共用，现在定稿）

```
Project                         已有 project.toml
  work_mode: research | coding | office

  Task                          人声明的工作单元
    有流程科研 = 流水线一步（已有 steps[] + 任务卡）
    无流程科研 / 办公 = 目标（一句话 + 默认整仓隔离 + 验收写回）
    编程 = Lane（第 2 期）：名 + 分支 + 可选主题分组

    Run                         一次执行（第 1 期）
      runtime      local_cli | headless | custom | cloud
      isolation    worktree 路径；哨兵任务才允许 project_root
      agent        用户指定的绑定
      permission   discuss | write_tree
      context      TASK.md / 简报 / 提货单 / 技能
      session      只读解析
      events       待确认 / 求助 / 失败 / 可评审
      view         终端标签是视图，不是身份
```

### 1.1 字段（实现时用 camelCase DTO）

```text
Run
  id              UUID；关标签不删
  projectRoot     注册项目根；scratch 可空
  taskKind        pipeline_step | coding_lane | office_doc | watch | reader | scratch
  taskRef         步骤名 / 分支 / 文档路径 / 日程 id
  isolationPath   实际 cwd（科研 worktree / 编程 worktree / 项目根 / ~）
  runtime         local_cli | headless | custom | cloud
  agent           AgentSpec.id
  profileId       绑定 id；custom 可空
  permission      discuss | write_tree
  reuseKey        见 §1.3；同一隔离单元的活标签去重键
  sessionId       解析到的会话；可空
  createdAt
  closedAt        进程结束或用户关掉；Run 行仍在，可恢复
```

`tabId` 只活在前端内存，**不进 SQLite**，只是 Run 的终端视图指针。跨页面必须传 `runId`；`reuseKey` 仅在入口做幂等找回，不承担身份。

### 1.2 设计不变量（实现不可绕过）

1. **Run 是身份，标签是视图**：同一 Run 可以没有活标签；关标签、进程退出都不能删除 Run。
2. **Task 是意图，Run 是执行**：重试/恢复不得复制 Task；同一 Task 可以先后产生多个 Run，但同一 `reuseKey` 同时最多一个活跃交互 Run。
3. **隔离先于启动**：除明确标记 `sentinel` 的定时任务外，`isolationPath` 必须在启动前解析并通过 canonicalize 校验；失败就不启动。
4. **人选权限，Runtime 负责翻译**：`discuss` / `write_tree` 是唯一对外政策名；CLI 旗标只存在 Adapter 内，能力不足必须置灰并说明原因。
5. **事实只有一个来源**：工作台、收件箱、对话页都按 `runId` join；`reuseKey` 只用于找回，不再承担身份、状态和标题三种职责。

### 1.3 Run 生命周期与幂等

**接受状态边界（2026-09-10）**：Run 收尾不得覆盖已完成目标；只有用户显式返修才能重新置 running。
返修若复用活 Run，保存修改意见，不要求先退出 CLI。目标与 Run DTO 按 ProjectId 解析项目当前位置，
保留数据库历史路径与原生会话来源；同 ID 的原目录仍存在时不自动将副本认作搬家。


状态由事件记录并由当前快照派生，不另建可编辑状态机：

```text
created → starting → running → {completed | failed | stopped}
```

- `created` 写入成功后才允许 `pty_spawn` / `run_agent_task`；启动失败保留 `failed` Run 和原因。
- 恢复是同一 Run 的新执行句柄；若原 Run 已 `completed`，用户明确点「再次运行」才新建 Run。
- 创建请求带 `reuseKey` 幂等检查：发现同一隔离单元已有活跃交互 Run 时复用它，不重复起进程；Custom/Headless 的新执行不得伪装成会话恢复。
- `sessionId`、`tabId`、进程句柄都可空；展示层不得以任一字段存在与否推断 Run 是否存在。
- 收件箱动作首选 `{ type: "run", runId }`；旧 `tab` / `review` 仅作为数据迁移输入；新页面和新动作不得再产生或依赖它们，映射失败必须显示原动作而不是静默丢弃。

### 1.2 Isolation 两套库不合并

| 工作方式 | Isolation 实现 | 路径 |
|---|---|---|
| 科研（有流程） | `workspaces.rs` | `~/ccode/workspaces/<仓>/<步骤工作区名>` |
| 编程 | `coding.rs` | `~/ccode/worktrees/<仓>/<分支路径>` |
| 无流程科研 / 办公声明任务 | `runs.rs` `task-runs` | `<data>/ccode/task-runs/<taskId>/<staging>` |
| ＋新对话 / scratch | 无新树 | 项目根或 `~/ccode/scratch` |
| Custom Runtime | 无新树（除非人已在工作树里点它） | 当前终端目录；默认工作目录只在空目录或 scratch 时启用 |

写盘必须离开主仓的规则只约束 `pipeline_step` / `coding_lane` / `watch`。Custom Runtime 在项目根或随手聊目录启动是普通终端，不得套这条拒绝。

无流程科研 / 办公的 `task-runs` 容量清理是显式两步（先工作副本，再历史冻结），各需确认；不得删除仍被其他项目或运行引用的目录，中断后待删目录被外部改过则拒绝继续。清理后任务与接受记录保留，不能从已删副本续跑。

Run 只引用 `isolationPath`。禁止把编程树并进 `workspaces` 表（`coding-git.md` Non-Goal）。用户心智统一为「给 Agent 的独立目录」，代码保持两套。

### 1.3 reuseKey 闭集（已有字符串升格为 Run 键）

| 前缀 | 含义 | 已有出处 |
|---|---|---|
| `ws:<worktreePath>` | 科研工作区 | `workspaceReuseKey` |
| `reader:<projectRoot>` | 沉浸阅读注入 | TerminalPage |
| `login:<agentId>` | 官方账号登录 | ProfilesPage |
| `office:…` | 办公问 AI（按文件/项目） | `officeFileReuseKey` / `projectChatReuseKey` |
| 编程车道 | `lane:<worktreePath>` | 当前使用；旧 `wt:` 入口升格为 `lane:` |
| Custom Runtime | `custom:<runtimeId>:<cwd>` | 隔离目录决定 Task 种类，不当成固定编程车道 |
| 定时任务 | `watch:<scheduleId>:<isolation>` | 当前使用；每次执行绑定隔离路径 |
| scratch | 现有快速开聊键 | `quick-chat.ts` |
| 人声明目标 | `task:<taskId>` | 无流程科研 / 办公「新建目标」 |

同一 `reuseKey` 同时只允许一个活标签（现有 `PendingTerminal.reuseKey` 语义，不得退回堆标签）。

### 1.4 Permission 政策 → Adapter 翻译

用户选政策，不选 CLI 旗标。启动入口字段是 `PendingTerminal.permission`（`discuss` / `write_tree`）；旧 `readonly` 布尔只作回落。翻译表已有 `AgentSpec.readonly_args`：

| 政策 | 用户可见 | 翻译 |
|---|---|---|
| `discuss` | 只讨论，不改文件 | 新建/恢复均注入 `readonly_args`；空表拒绝启动并提示换 Agent，计划模式不等同 OS 沙箱 |
| `write_tree` | 可以改这棵树 | 现有默认启动（codex 交互 `workspace-write` 等） |

某家做不到 `discuss` 硬保护：置灰 + 原因，和 `set_global` / `mcp_write` 同一 fail-loud 口径。禁止第三档「自动 yolo 出网」当默认。

### 1.5 Context Pack（已有科研开步，编程第 0/2 期补齐）

**普通目标环境闭环（2026-09-11）**：准备前估算输入容量；目标规则/知识失败、点名技能缺失/Agent 副本漂移均拒绝启动。
启动环境保存完整提示词和有限范围的材料/规则/技能版本清单，不宣称 Agent 实际使用了这些材料。
返修上下文独立保留，成果绑定当时 contextId；会话仍不强制制造目标，也不暗中改成隔离工作。
readiness 在评审 DTO 由成果事实派生，Run 进程态不承担目标完成语义。具体限制见 review-freeze.md。


一次 Run 允许看到的输入由系统打包，用户不复制路径：

- 科研：`renderTaskMd`（简报、提货单、技能、项目根绝对路径、项目规则、保护路径）——已落地
- 无流程科研 / 办公 / 编程开工：`renderProjectContextPack` **目标包**（项目身份、顶层文件、规则、保护路径、当前目标、已验收产出、尚未完成、上一版意见）
- ＋新对话 / 问 AI / 进入已有编程工作树：同一函数的 **会话包**（身份、顶层文件、规则、已验收事实；跟用户这次说的做；不带目标/技能名单/尚未完成/验收写回）
- 编程：最短 `TASK.md`（分支、基准、一句话意图）——第 0 期
- 接力：结构化简报，禁止称「无缝继续」

---

## 2. 现状对照（设计以它为起点，不重做已有）

| 对象 | 今天 | 缺口 |
|---|---|---|
| Project | `project.toml` + 三档 `work_mode` | 无 |
| Task（科研） | 步骤 + 任务卡 + 开工弹层 | 够用；不要编程式并行车道 |
| Task（编程） | Lane 覆盖层：名称 + 主题分组 +「再开一条」 | 无；合并 / PR 仍按树 |
| Run | `runs` 持久化记录 + `runId` + 终端标签视图；无头 Run 标记 `internal` | 无；`tabId` 仅用于终端视图聚焦 |
| Permission | `Run.permission` + `PendingTerminal.permission`（`discuss` / `write_tree`）；旧 `readonly` 仅回落 | 无 |
| Event | 收件箱文案与工作台摘要同一句式（名字+状态）；新写入 `{ type: "run", runId }`，活标签无 runId 时带 `tabId` 不丢条 | 无 |
| Runtime | `LocalCli`、`Headless`、`Custom` 三种执行形态已登记 | Cloud 仍只预留；Custom 不提供会话恢复 |
| 工作台 | `pickWorkbenchNow` 按项目收卡并展示多次 Run；「继续」优先 `runId`，无活标签时按可恢复 Run 找回 | 无 |
| 开步选 Agent | 科研弹层 + 编程 `codingTerminalLaunch` 同款记忆键 | 无 |

---

## 3. 当前基线 — 表面收口（不作为未来一期）

目标：用户感到「我在管几条活」，不是「我开了几个 CLI」。禁止新表、禁止改 AgentSpec 形状。

### 3.1 工作台主卡列出多次 Run

**已有：** `pickWorkbenchNow` 按项目聚合，`runningCount` 是次数。

**改：** `WorkbenchNowItem` 增加：

```ts
runs: {
  tabId: string;
  agentId: string;
  attention: "confirm" | "working" | "done" | null;
  taskLabel: string; // 工作区名 / 分支 / 文档名，不是 CLI 名
}[];
```

规则：

- 主卡 / 紧凑行展示 `runs`（待确认在前）；「继续」仍跳优先级最高的那条（confirm > working > 其余）
- `heroStatusLine`：多次时「2 个 Agent 在跑 · Codex 在等你确认」，单次保持现状
- `tabId/agentId/attention` 三字段保留为「继续」指针，等于 `runs[0]` 的优先条，避免全站改调用
- 纯逻辑 `src/workbench-hero.ts`，测试先改再接线 `WorkbenchPage.tsx`

### 3.2 编程「再开一条」

位置：`CodingProjectView` 工作树区。主 CTA 仍是「从 &lt;base&gt; 开工」。

次动作 **「再开一条」**：位于对应工作树的 ⋯ 菜单（2026-09-11，顶部不重复 ＋）。

- 出现条件：已有至少一棵非主仓功能树（或用户刚从基准开过）
- 行为：焦点回到分支名输入；用当前树分支派生预填值（`feature/login` → `feature/login-2`），**不自动提交**
- 确认后走现有 `coding_create_worktree` + `fromBase`；同名本地分支仍 `branch_exists` fail-loud
- **不**自动选 Agent、不拆任务、不合并、不合成 PR
- 每条树「进入」仍开终端，cwd = 该树

后端 v0 可不动。

### 3.3 编程开工带上 Agent 选择

科研开工弹层已经选 Agent。编程「从基准开工 / 再开一条 / 进入」要对齐：

- 创建树成功后的 `PendingTerminal` 用 `pickKickoffLaunch` 同款规则（`ccode.askAi` 记住的连接还在就用）
- 若用户勾过「设为默认」，`autoStart: true`；否则预填启动栏不自动拉起
- 不新造第三套记忆键

### 3.4 标签标题先任务、后 Agent

| 来源 | 标题 |
|---|---|
| 科研工作区 | 工作区名（已是 `ws.name`） |
| 编程树 | 分支名 |
| 办公问 AI | 文档名 |
| 阅读注入 | `阅读 · {pdf 主名}`（已有） |
| scratch | 现有快速开聊标题 |

Agent / 模型只出现在状态栏（进程起来之后，v3.213 口径）。禁止把 `claude-code` 放进标签主名。

### 3.5 收件箱文案带任务名

`InboxItem.text` 模板：`{taskLabel}{状态}`（与工作台摘要同一句式，例如「文献精读待确认」）。

`taskLabel` 推导：科研 worktree → 工作区名；编程树 → 分支；否则项目名。状态紧贴名字（待确认 / 有冲突 / 待评审），不写「去」。新写入动作使用 `{ type: "run", runId }`；旧 `tab` / `review` 只在迁移入口读取。

### 3.6 编程树最短 TASK.md

`coding_create_worktree` 在 `fromBase` 成功后 best-effort 写入工作树 `TASK.md`：

```markdown
# {branch}

- 基准：{baseBranch}
- 意图：{用户在输入框留下的分支名或稍后可改的一句话}

先读本文件再改代码。只改这棵树，不要切回主仓文件夹。
```

- 注入：`initialPrompt` = 「先读 TASK.md 再动手」（有 prompt 则不 resume，与 `buildWorkspaceTerminalRequest` 同口径）
- 不进 git：复用 `exclude_task_md`（`.git/info/exclude`），全 worktree 生效
- 失败不阻断建树
- 不挂技能、不做开工弹层、不引入流水线步骤

### 3.7 能力表补只读 / 无头人话

`AgentCapabilitiesDto` 增加（与 `readonly_args` / 架构 §11.4 backlog 同源，不另造表）：

```ts
readonly: CapabilityFlagDto;          // readonly_args 非空 = supported
headlessWrite: CapabilityFlagDto;     // 定时/无头写盘：未实证则 supported:false 或 reason 写「权限未实测」
```

前端：想法期开关、定时任务选 Agent 时置灰 + 原因。qwen 无头未验证则禁选；grok 标「会批准全部操作」；其余能跑的标「按该工具默认权限写文件」。Codex 无附注。不默默降级。

### 3.8 当前基线明确不做

- 不为 Run/Lane 再造第二套对象或 UI；当前已分别有持久化 Run 记录与编程车道记录
- 不改侧栏八页
- 不开步弹层里加「拆成三个 Agent」
- 不把科研工作区改成编程车道 UI

---

## 4. 第 1 期 — Run 身份

把「一次干活」从标签升格为可恢复对象。终端标签变成 `view`。

**两层不得混（v3.222）**：机器里可以给无头一次编号；人看见的「正在进行」只列交互活。无头没有「接着聊」的价值——人要的是雷达/收件箱里的结果，不是那次对话。沿用既有纪律：无头标 `internal`，不进「本项目会话」。

| 层 | 列什么 | 人能不能看见 |
|---|---|---|
| 机器 Run | 交互启动 + 无头/定时（对账、失败归因） | 默认看不见 |
| 「正在进行」/ 可恢复任务 | 开步、进工作树、普通终端、阅读区**正开着的**标签 | 看见 |
| 收件箱 / 雷达 | 无头的**结果**：新文献、巡检失败 | 看见结果，不看见一次对话 |

「正在进行」白名单：用户点开、会改文件、关了还想找回来的交互会话。  
「正在进行」黑名单：定时雷达、雷达解读、提交信息/融合简报/其它 `ai.rs` 无头。成功只更新雷达或收件箱；失败一条「巡检没跑完」，不冒充对话。  
阅读注入：窗口还开着，可以出现在「正在进行」（那就是用户开的标签）；关掉后不当项目任务留着，也不进「本项目会话」（现有 `filterProjectSessions`）。

### 4.1 存储

SQLite `runs` 表（`app.db`），字段见 §1.1。不把 PTY id、密钥、env、scrollback 写入（对齐标签持久化白名单）。

写入点（创建 Run，失败则启动 fail-closed 或降级由调用方决定——**交互 pty_spawn 必须先有 Run id**）：

| 入口 | taskKind | runtime | permission |
|---|---|---|---|
| 科研开步 / 去终端 | `pipeline_step` | `local_cli` | 默认 `write_tree`；聊想法 `discuss` |
| 编程进入树 | `coding_lane` | `local_cli` | `write_tree` |
| 办公问 AI | `office_doc` | `local_cli` | 按场景 |
| 阅读注入 | `reader` | `local_cli` | 默认 `write_tree`（改笔记） |
| 快速开聊 | `scratch` | `local_cli` | `write_tree` |
| `ai.rs` 无头 | 调用方声明 | `headless` | 一次性 prompt = `discuss`；**internal，不进工作台** |
| `scheduler` | `watch` | `headless` | 见 §7；**internal，不进工作台** |

进程退出：写 `closedAt`，保留 `sessionId`。用户点「恢复」= 新 PTY + 同一 Run（resume 会话），不新建 Run。

### 4.2 前端

- `PendingTerminal.runId?: string`；spawn 后标签持有它
- 重启恢复白名单增加 `runId`（仍不含 PTY/密钥）
- 收件箱 `action` 新写 `{ type: "run"; runId: string }`；旧 `tab` / `review` 只读兼容，不能映射时保留原动作并显示原因
- 工作台 `runs[]` 只 join **非 internal** 的交互 Run + 活标签；无头 Run 不得出现在工作台主卡/紧凑行
- 无头失败走收件箱（现有 `lit:` / 定时历史），不新造「无头对话」卡

### 4.3 验收

- 关标签 ≠ 丢**交互**任务：工作台 / 收件箱 / 项目「对话」页能用同一 `runId` 对上开步、工作树、普通终端
- 无头巡检成功：只更新雷达/收件箱，工作台不出现一张「刚巡检过」
- 无头巡检失败：收件箱一条失败，不是一次可恢复对话
- 阅读区问 AI：仅当对应标签还活着才进「正在进行」；结束后不进本项目会话
- 会话解析仍只读；Run 行不得回写 CLI 会话文件

**用户行为验收（一期完成线）**：从工作台「继续」、收件箱动作、项目「对话」页进入时，三处都定位到同一个 `runId`；关掉标签后仍可找回；无头成功/失败只更新结果入口，不生成可聊天任务。

---

## 5. 第 2 期 — 编程车道（Lane = Task）

人声明的并行，不是自动拆工。科研不要套这套 UI。

### 5.1 对象

```text
Lane
  id
  repoPath
  name          界面名，如「登录 · 前端」；缺省 = 分支名
  theme         可选展示分组，如「登录」；不是 DAG、不是编排
  branch
  worktreePath
  currentRunId  可空
```

落 `app.db`（不进仓库 git）。`coding.rs` 的工作树事实来源仍是 `git worktree list`；Lane 是覆盖层：有树无 Lane 时按分支名现算一条（`name = branch`，`theme = null`）。

### 5.2 界面

编程页左栏：

```
主仓    {project.path}     基准 {base}     不要让 Agent 写这里

{theme 或「未分组」}
  {lane.name}   {branch}   {agent 或空闲}   可推 · 开 PR
  …

[ 从 {base} 开工 ]   [ 已有分支 ]
（对应树 ⋯ → 再开一条）
```

- 「再开一条」升为：问分支名；主题默认上一条的 `theme`（可改、可空）。未分组的树事后可 ⋯「分组…」，不必开工时先填。
- 合并 / PR / Desktop / 逐 hunk **全部仍按树、按分支**，不引入「三条合成一个 PR」
- 以后若「这几条一起评审」：人勾选多棵树，再进现有评审覆盖层——仍不是 Review Agent。本期不做

### 5.4 明确不做

- 自然语言 → 自动开三条车道
- Lane 之间自动接力或自动选 Agent
- 并入科研 `workspaces` 表
- 任意 git 命令框（v3.179）

**用户行为验收（二期完成线）**：用户能从 `main` 建两条命名车道，分别看到分支、当前 Run 和推送/PR 状态；删除或合并一条车道不会改动另一条；系统不会因同一主题自动启动、接力或合并车道。

---

## 6. 第 3 期 — Runtime 可替换

`AgentSpec` 描述 Runtime，不再默认「必有本机二进制 + PTY」。缺省仍是今天的 Local CLI。

### 6.1 RuntimeKind

```text
local_cli   现有 PTY + launch_plan     交互 Agent 的 100%
headless    现有 ai.rs / scheduler     升格为正式 Runtime，不再像内部杂务
  custom      用户登记的命令 + cwd + env 用来证明「不是 CLI 也能进工作台」
cloud       预留；有稳定官方 API 再加一张规格，不预研、不自建
```

新功能按 `AgentRuntime` 挂：

```text
start(run) -> handle
stop(handle)
resume(session) -> handle    // 无会话格式则 Unsupported + 原因
```

`LocalCli` = `pty_spawn`。`Headless` = `run_agent_task`。会话解析器 / usage 提取器仍每 CLI 一份，不数据化（v3.13 边界）。

### 6.2 Custom Runtime（本期最小验收）

用户登记：`name` + `command`（经 `resolve_binary`）+ `args` + 可选 `cwd` / `env`。无 Mesa 密钥注入、无 session 解析、无 MCP/技能分发。`cwd` 只能落在 Run 的隔离树内，环境变量值不得写入 Run 记录。

- 直接在 `isolationPath` 内启动用户登记的可执行命令，不默认包裹 shell；只有用户登记的 shell 命令才由该命令解释脚本
- 能停、能看输出
- 若改了文件，走现有改动面板 / 评审
- 退出码、停止原因和输出尾部进入 Run 事件；非零退出不自动判定文件成果可合并
- 命令相对路径拒写（与 MCP stdio 同一红线）
- 不进九家清单，不当第九+一家 CLI

这是抽象证明，不是插件市场。

### 6.3 Cloud

只定边界：鉴权走现有网关/官方账号双轨之一；事件映射进 Run events；隔离仍是本机 worktree（云端沙箱 = 对方的事，Mesa 不自建 Docker/VM，v3.8）。**没有稳定、可本机鉴权的官方 API 之前不写实现、不占 UI。**

**用户行为验收（三期完成线）**：用户登记一个命令后，可在隔离树中启动、停止、查看输出；退出后若有改动仍进入现有评审入口。Custom 不出现在九家 CLI、技能或 MCP 清单中；没有可恢复会话时明确显示「该 Runtime 不支持恢复」，不伪造会话。

---

## 7. 定时写入隔离（随第 3 期权限/Runtime 一并收口）

当前基线：scheduler 先创建/复用隔离 worktree，再启动 Run；产物保留供人工评审，不自动合并。

**当前实现规则（不要另开第三套）：**

- 每个日程一次 Run，`taskKind=watch`，`isolationPath` = `~/ccode/watch-worktrees/<repo>/<schedule-id>`（同一日程复用；保留供评审，不自动合并）
- 建树后从主仓播种：每次刷新 `papers/watchlist.md`；隔离树没有才拷 `papers/watch-seen.md`、`papers/watch-followup.md`、`notes/inbox.md`、`notes/references.bib`
- 技能简报继续约束只写 `notes/inbox.md`、`papers/watch-*.md`
- 跑完收件箱「去评审 N 条新命中」打开本次冻结产物评审；人点「采纳进主仓」才把冻结结果写回项目根，禁止静默合进主仓；当前隔离树只读评审保留为独立入口
- 失败 / 超时分列状态（`error` / `timeout`）
- **冻结产物评审（2026-09-07）**：工作目录继续按日程复用，但每次成功执行后把四类可采纳台账的「执行前主仓 / 执行前隔离目录 / 执行结果」冻结在配置目录 `ccode/watch-reviews/<runId>.json`。历史评审首先展示冻结文本，当前 worktree 另设明确标注的入口，不把当前内容称作历史快照。每文件最大 2 MB；原始证据仅本机存储，返回 UI 前脱敏。
- **采纳检查**：只接受 completed 且历史为 ok、有完整冻结证据的运行；先检查所有变更文件的保护路径、主仓起始版本及隔离目录起始版本，冲突和删除不自动覆盖。整批写前留恢复材料，逐文件原子替换，失败尝试回滚；回滚遇到新的外部编辑不得再次覆盖，错误须给恢复目录。旧记录不伪造证据，可查看当前目录并手动合并。
- **跨实例执行锁**：日程在读取/播种工作目录前持有独立 OS 文件锁；自动 tick 抢锁后重新确认到期，手动重复执行明确报错。Run 在 claim_start 前持 OS 存活锁，终态落库后释放；启动恢复只结束可取得锁的陈旧运行。只覆盖使用此锁版本的实例，不宣称兼容仍运行的旧版实例，配置 JSON 另由 storage/profiles/scheduler 的跨进程读改写锁保护。


默认任务必须使用上面的隔离 worktree，无法创建或校验失败时失败并保留原因；当前没有面向用户的主仓 `sentinel` 配置入口，因此定时任务不得直接写主仓。

---

## 8. 三档工作方式怎么用这套对象

| | 科研 | 编程 | 办公 |
|---|---|---|---|
| Task | 流程一步（已有） | Lane（第 2 期） | 文档（现有即可） |
| 并行 | 默认顺序；多想法卡 ≠ 多车道 | 人声明多 Lane | 不作为主路径 |
| Isolation | 步骤 worktree | 分支 worktree | 通常无 |
| 开 Run | 开工弹层（已选 Agent） | 进入树 / 再开一条 | 问 AI |
| 验收 | 有流程：工作区评审合并。无流程目标：按文献 / 笔记 / 数据 / 论文分组验收产物 | 改动面板 + 合进基准 / PR（不走目标验收弹层） | 目标按文档 / 表格 / 幻灯分组验收文档 |

异构项目（仓里既有论文又有代码）仍是一张主界面、一种 `work_mode`，不做转换（v3.179）。

---

### 运行取消与退出（2026-09-08）

Headless 支持取消但不承诺会话恢复；定时任务行显示「停止运行」，通用无头任务在设置→诊断→后台任务停止。取消后的运行是 stopped，定时历史显示已取消，不可采纳。原生应用退出负责回收执行体，页面卸载只负责视图清理；外部打开的应用不在自动回收范围内。

## 9. 现在不能完成的设计（不要假装写完）

| 项 | 原因 |
|---|---|
| 具体哪家 Cloud API 的字段表 | 没有稳定官方 API；到时候加一张规格 |
| 自动拆工 DAG / Review Agent | 已否决（v3.5 / v3.10） |
| 科研/编程 worktree 并库 | 已否决 |
| 定时是否改隔离树 | 已落地：默认创建并校验独立 worktree；当前没有主仓 sentinel UI，不能把定时任务写主仓 |
| 多 Lane 一起开一个 PR | 第 2 期明确不做；真要做再单独立项 |
| 编排语言 / 自研 MCP host / Docker 沙箱 | 已否决 |

---

## 10. 落地顺序与改动面

| 期 | 内容 | 主要文件 | 状态 |
|---|---|---|---|
| 0 | 工作台 `runs[]`；编程再开一条；编程开工带 Agent；标签标题；收件箱文案；编程 TASK.md；能力表只读/无头 | `workbench-hero.ts` `WorkbenchPage.tsx` `CodingProjectView.tsx` `coding.rs` `kickoff-launch.ts` `inbox.ts` `agent_specs.rs` `types.ts` | **已实现** |
| 1 | `runs` 表；spawn/无头/定时登记；收件箱 `action.run` | `pty.rs` `ai.rs` `scheduler.rs` `store.ts` `sessions.rs` | **已实现；旧数据仅在迁移入口兼容** |
| 2 | `lanes` 表；编程页分组 UI | `coding.rs` `CodingProjectView.tsx` | **已实现** |
| 3 | `RuntimeKind` + Custom | `agent_specs.rs` `custom_runtime.rs` `runtime.rs` | **Custom 最小闭环已实现；Cloud 不实现** |
| 7 | 定时进 watch 工作区 | `scheduler.rs` `lit_watch.rs` | **隔离路径 + 播种 + 只读评审 + 采纳进主仓已实现；无主仓 sentinel UI** |

实现某一期时同步 `docs/guide/user-guide.md` 对应操作；未实现不得写进手册当已有功能。发版才写 `CHANGELOG.md`。


## 11. 项目页表面视图（2026-09-05）

项目页在不改变既有科研流程、办公文档和编程工作树行为的前提下，提供三个表面视图：

```text
科研项目：[科研任务] [文件] [Agents]
工作项目：[工作任务] [文件] [Agents]
编程项目：[编程任务] [文件] [Agents]
```

- 任务视图是该工作方式的主面：有流程科研仍是步骤/工作区；无流程科研是人声明任务 + 雷达 + 右侧对话/定时巡检；办公是人声明任务 + 右侧对话；编程仍是工作树。科研流程步骤以 `.ccode/project.toml` 为真相。
- 文件视图三种工作方式同一套：左目录、右就地预览（PDF/图片/表格/docx/源码与笔记）；预览滚动时左侧列表固定；侧边预览可切窗口预览。类型徽标统一为 `fileTypeIcon` 短标签。不自动创建或移动目录。
- Agents 视图是这个项目的 Agent 名册（卡片：谁在干活、默认给谁、正在负责哪些目标），不是连接页的模型配置表单。当前配置点选切换，不用下拉。不自动分派，不保存密钥。分派发生在「新建目标」或开步/工作树，不在本页。
- Binding.name 独立于 Gateway.name，旧绑定缺名时展示层回退网关名；修改一个 profile 名称不得改动共享网关名或其他绑定。
- 页签按项目路径记忆。
- 「新建目标」出现在工作项目和无流程科研：写一句话，可先记下再开始，默认整仓进隔离副本，验收后写回。＋新对话默认直接改项目根，可选「验收后写入」。不自动建分类空目录。有流程科研和编程不提供这条入口。禁止自动拆任务与智能路由。
- 项目规则写在 `project.toml` 的 `settings`（人保存后 `rules_owned`，不再自动加回默认条）。有研究流程时纪律来自该模板的 `projectRules`（综述≠数据处理≠毕业论文）；无流程才用工作方式默认条，不把综述纪律套到每一个科研项目。空的全局设定表格不进 TASK.md。保护路径 `protected_paths` 只在科研/工作的验收写回时让这些文件夹保持项目原样（独立副本改动不写回；不是另存一份，也不是审核后再合并）。界面勾选文件夹，不手填路径。编程页不展示。规则在任务页默认收起，主操作（新建目标 / 从基准开工）在第一眼。
- 普通目标列表按待验收 / 进行中 / 需要处理 / 尚未开始 / 已完成排序；单一状态不重复组头，失败/停止仍在卡片保留具体状态。卡片标题最多两行原文，状态、Agent 与写回数量同一副行；已写入产物和声明输出范围分别计数，不把声明当成实际产出。卡片只突出第一项可执行动作，已完成目标的返修降为辅助按钮；「详情」保留完整要求、路径、完整「生成 → 意见 → 第 N 版 → 已接受」记录和归档，不展示孤立「生成」或 Run 编号。不改写目标、不裁剪交给 Agent 的指令。归档仍确认且保留记录，已归档默认收起可恢复。科研验收按文献/笔记/数据/论文分组产物；工作验收按文档/表格/幻灯分组文档；编程不进这层，走改动面板 / 合进基准 / PR。不编造「读了多少篇 / 主要发现」。
- Context Pack 分两套：目标包带工作环境（按科研/工作/编程各写两句）、项目规则、保护路径、已验收目标及其产出与意见、尚未完成的目标、上一版修改意见；会话包只带身份、目录、规则和「按这次说的做」，不把未完成目标塞进对话。
- 验收接受写入 `.ccode/project-status.json`（目标名、产出路径、意见）。普通目标页头只列数量，不重复卡片名称；「项目现在」摘要只保留给工作台等聚合面。无独立记忆页。有流程科研仍用简报。
- 定时巡检是独立侧栏汇总页；巡检仍是后台 Run，不进入交互工作台「正在进行」。
- 项目对话是任务页右侧栏，不是第四个页签。科研 / 工作 / 编程同一套：展开时标题行「＋ 新对话」和收起钮；收起后标题行仍能再打开。侧栏「对话」页仍是全局历史。
