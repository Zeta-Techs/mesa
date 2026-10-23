# Mesa 架构方案

> 一个「AI 科研工作台」：以 Project 为家，让不同 Agent 在长期环境里完成目标、结果经人验收。底层仍是九个 Agent CLI 的适配（启动器 + 配置 + 会话只读），表面是科研流水线，并覆盖编程/办公。**AI 负责干活，Mesa 负责环境和验收，人负责拍板。** 不是 CLI 聚合器，也不是任务编排器。
> 本文档是项目的总体逻辑架构，配合 `docs/agent-integration-matrix.md`（九个 CLI 的适配细节）使用。
> 所有关于各 CLI 的事实均来自 2026-07-30 对官方文档/源码的调研，标注「易漂移」的字段需防御式处理。
> v0.2：固化五项产品决策（命名 Ccode、项目自动聚合、终端↔对话联动、token 统计留在 P3、三平台同步）。
> v3.4：定位演进为 AI 科研工作台（§11 演进线）；通用控制台架构（§1–§10）作为其底层继续成立。

## 1. 产品定位与核心概念

> 2026-08 起定位演进为「AI 科研工作台」（§11）；本节三项能力是其底层控制台，继续成立。

让用户在一个桌面应用里：

1. 为多个终端 AI agent（Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Kimi Code、CodeBuddy Code、Cursor CLI、Grok Build）管理**多套 API 配置**（端点 + 密钥 + 模型），一键切换；
2. 在**内嵌终端**里一键拉起任意 agent + 任意配置 + 任意项目目录；
3. **可视化浏览**各 agent 的历史会话（按项目自动聚合组织），并与内嵌终端联动，实时观看进行中的对话。

三个核心领域概念：

- **Agent**：一种 CLI 程序（如 Claude Code）。每种 agent 对应一个「适配器」。
- **Profile（配置档）**：属于某个 agent 的一套 API 配置：`{ base_url, api_key, model, 额外参数 }`。一个 agent 下可有多个 profile（如「官方」「中转 A」「中转 B」）。
- **Profile 认证模式**：API（默认必须有 Mesa 密钥）、官方账号（由 CLI 自己登录）和明确的无密钥本地端点；无密钥模式启动时清理继承认证环境，禁止静默接管其他账号。
- **Session（会话）**：某 agent 在某项目目录下的一次对话，数据来源于该 CLI 自己落盘的会话文件（只读解析，零侵入）。

## 2. 已确认的决策

| 决策点 | 结论 |
|---|---|
| 应用名称 | **Mesa**（展示名；内部身份仍 `ccode`：bundle ID / `.ccode/` / `~/ccode/` / Codex `ccode` provider。v0.2 曾命名 Ccode） |
| 技术栈 | Tauri v2（Rust 后端）+ React + TypeScript + Vite 前端 |
| MVP 范围 | 配置中心 + 内嵌终端一键启动 + 历史会话浏览 |
| 会话数据源 | 解析各 CLI 本地会话文件（只读），文件监听实现准实时 |
| 切换机制 | 双模式：默认**启动时注入环境变量**（零污染），另提供「设为全局默认」写入 CLI 配置文件 |
| 终端形态 | 内嵌终端（xterm.js + Rust PTY），**与会话视图联动** |
| 项目来源 | **从各 agent 历史会话自动聚合「常用项目」并分类**，辅以手动添加 |
| Agent 范围 | 六个全部进 MVP，通过适配器接口隔离差异（v3.23/v3.24 起八家，v3.80 起九家） |
| 分发 | **三平台（macOS / Windows / Linux）同步**，代码从第一天起保持跨平台 |
| token/费用统计 | P3 顺带做（usage 字段已确认可解析） |
| 实现方式 | 主要由 AI 编码，架构保持简单直接 |

## 3. 总体架构

```
┌────────────────────────────────────────────────────────┐
│ 前端 React + TS（Tauri WebView）                        │
│  ├─ ProfilesPage    配置中心：agent × profile 增删改查  │
│  ├─ LauncherPage    启动面板：选 agent/profile/项目     │
│  ├─ WorkspaceView   工作区：终端 + 结构化对话双栏联动   │
│  │    ├─ TerminalView  内嵌终端标签页（xterm.js）       │
│  │    └─ SessionView   当前会话的结构化对话（准实时）   │
│  ├─ ProjectsPage    常用项目（自动聚合 + 分类 + 置顶）  │
│  ├─ SessionsPage    会话浏览：项目 → 会话 → 对话回放    │
│  └─ (后期) FilesPage / 编辑器 / 统计面板                │
├────────────────── Tauri IPC（commands + events）────────┤
│ Rust 核心                                               │
│  ├─ ProfileStore    网关+绑定持久化（JSON + 0600 keys.json） │
│  ├─ AgentAdapter    trait，九个实现（见 §4）            │
│  ├─ PtyManager      portable-pty 拉起/管理 CLI 进程     │
│  ├─ SessionIndexer  扫描各 agent 会话目录 → 统一索引    │
│  ├─ SessionParser   每种格式一个 parser（防御式）       │
│  ├─ ProjectAggregator 跨 agent 聚合/分类项目列表        │
│  ├─ SessionLink     终端标签 ↔ 新会话文件关联           │
│  ├─ FileWatcher     notify 监听会话目录，增量推送       │
│  └─ ConfigWriter    「设为全局默认」写各 CLI 配置文件   │
└────────────────────────────────────────────────────────┘
```

模块职责与边界：

- **前端不直接碰文件系统**，一切经 Tauri command；终端字节流和会话增量更新走 Tauri event/channel 推送。
- **AgentSpec 是能力与参数声明的中央入口**。新增 Agent 还须核对会话/用量解析、全局写入、MCP、技能、无头与恢复权限，并补逐平台样本测试；不能承诺只加一条规格即可完整支持。
- **SessionIndexer 只做索引**（session 列表 + 元数据），**SessionParser 按需解析**单个会话全文，避免启动时全量解析几百 MB 历史。
- 解析全部**只读**。写各 CLI 会话目录仅限用户显式操作（会话删除、会话导入，防护见 `docs/conventions/safety.md`）；写配置仅限用户显式点「设为全局默认」（先备份）。

## 4. AgentAdapter 接口设计

下面的 Trait 是早期职责示意，不是当前源码接口；当前使用 `agent_specs.rs` 注册表与各领域适配函数。

```rust
trait AgentAdapter {
    fn id(&self) -> AgentId;                    // "claude-code" | "codex" | ...
    fn detect(&self) -> DetectResult;           // 是否安装、版本、二进制路径
    /// 注入模式：把 profile 翻译成启动环境变量 + 额外 CLI 参数
    fn launch_plan(&self, p: &Profile) -> LaunchPlan;  // { env: Map, args: Vec, cwd }
    /// 全局模式：把 profile 写入该 CLI 的配置文件（先备份原文件）
    fn apply_global(&self, p: &Profile) -> Result<BackupHandle>;
    fn session_roots(&self) -> Vec<PathBuf>;    // 会话目录（可能多个/不存在）
    fn list_sessions(&self, project: Option<&Path>) -> Vec<SessionMeta>;
    fn parse_session(&self, id: &SessionId) -> Conversation;
    /// 联动支持：能否在启动时指定会话 ID（见 §6.7）
    fn supports_session_id_flag(&self) -> bool;
}
```

九个 agent 的关键适配结论（细节见 matrix 文档，此处只列**影响架构的事实**）：

| Agent | 注入模式可行？ | 注意点 |
|---|---|---|
| Claude Code | ✅ `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` | settings.json 里的 `env` 块会**覆盖** shell env；`--session-id` 可固定会话文件名 |
| Codex | ⚠️ 有 `CODEX_API_KEY`，但**没有 base URL 环境变量** | base URL 只能走 `-c model_providers.x.base_url=...` 启动参数或写 config.toml；且只支持 Responses API 协议的中转 |
| Gemini CLI | ✅ `GEMINI_API_KEY` / `GOOGLE_GEMINI_BASE_URL` / `GEMINI_MODEL` | env 优先级仅次于 CLI 参数，注入干净 |
| Qwen Code | ✅ `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` + `--auth-type openai` | 多协议（openai/anthropic/gemini），profile 需记录协议类型；`--session-id` 可用 |
| OpenCode | ⚠️ **无通用 key/baseURL 环境变量** | 用 `OPENCODE_CONFIG_CONTENT`（内联配置 JSON）+ `OPENCODE_AUTH_CONTENT`（内联凭证）注入，优先级足够高且确定 |
| Kimi Code | ⚠️ **新版故意忽略 shell env 里的 API key** | 新版只能用 `KIMI_MODEL_NAME/API_KEY/BASE_URL/PROVIDER_TYPE` 合成模型通道，或写 config.toml；旧版（Python）可直接 `KIMI_API_KEY`/`KIMI_BASE_URL`。两个产品命令都叫 `kimi`，检测时必须区分 |

结论：注入模式**不能假设「每个 agent 都有统一的 env 三件套」**，`launch_plan` 返回 `env + args` 组合正是为了吸收这种差异（Codex/OpenCode 主要靠 args/env 内联配置）。

## 5. 核心数据模型

```rust
// 存储真相（已落地，见 docs/conventions/profiles.md）：
struct Gateway {
    id: Uuid,
    slots: { anthropic, openai, responses, gemini, cursor },
    header_env: Map<String,String>,
    models: Vec<GatewayModel>, // 稀疏：temperature / top_p / max_output / reasoning_effort
    last_probe: Vec<ProbeRecord>,
}
struct Binding {
    id: Uuid,                  // 复用旧 profile id，会话/定时任务锚不变
    agent: AgentId,
    gateway_id: Option<Uuid>,  // None = 官方账号
    models: Vec<String>,
    extra_env: Map<String,String>,
}

// Profile 是启动/列表用的扁平 DTO（Binding × Gateway 物化），不是落盘形状。
struct Profile {
    id: Uuid,                  // = binding id
    agent: AgentId,
    name: String,              // 来自网关名 / 「官方账号」
    protocol: Option<String>,
    base_url: Option<String>,  // 该 Agent 对应槽的 URL
    key_hint: Option<String>,
    models: Vec<String>,
    extra_env: Map<String,String>,
    request_policy: RequestPolicy, // 启动时按选中模型现算，不是连接级单份
    gateway_id: Option<Uuid>,
    slot_missing: bool,
}

struct RequestPolicy {
    temperature: Option<f64>,
    top_p: Option<f64>,
    max_output_tokens: Option<u64>,
    reasoning_effort: Option<String>,
    header_env: Map<String,String>, // Header 名 → 环境变量名，不保存 Header 密文
}

struct Project {               // 聚合后的项目条目
    path: PathBuf,             // 展示与启动用的工作目录
    git_root: Option<PathBuf>, // 用于跨目录归并
    agents: Vec<AgentId>,      // 哪些 agent 在此有过会话
    session_count: u32,
    last_active: DateTime,
    pinned: bool, hidden: bool, tags: Vec<String>,  // 用户可整理
}

struct Workspace {             // 任务工作区（借鉴 Conductor，§6.10）
    id: Uuid,
    repo_path: PathBuf,        // 所属 git 仓库（主工作树）
    name: String,              // 任务名（目录名 <repo>/<name>）
    branch: String,            // ccode/<name>，评审与合并单元
    worktree_path: PathBuf,    // ~/ccode/workspaces/<repo>/<name>
    base_branch: String,       // 创建时的基准分支名（如 main；起点固定为本地分支，不用 origin）
    port_base: u16,            // 分配的端口段起点（CCODE_PORT..+9）
    status: Active | ReadyToMerge | Archived,
    created_at: DateTime, archived_at: Option<DateTime>,
}

struct SessionMeta {           // 索引条目，列表页用
    agent: AgentId,
    session_id: String,
    project_path: PathBuf,     // 统一的项目维度（各 agent 推导方式不同，见下）
    title: Option<String>,
    created_at: DateTime, updated_at: DateTime,
    file_path: PathBuf,        // 源文件（opencode 则是 db 路径 + 行 id）
    token_usage: Option<TokenUsage>,
    cli_version: Option<String>,
}

struct Conversation { messages: Vec<ChatMessage> }
struct ChatMessage {
    role: User | Assistant | ToolCall | ToolResult | System,
    blocks: Vec<ContentBlock>, // text / thinking / tool_use(name,args) / tool_result
    timestamp: Option<DateTime>,
    usage: Option<TokenUsage>,
}
```

「项目」维度的统一是解析层最麻烦的部分，各 agent 推导方式不同（全部已核实）：

- Claude Code：目录名即 sanitize 后的项目路径，**可逆解码**
- Codex：读每个 session 首行 `session_meta.cwd`
- Gemini CLI：读 `~/.gemini/projects.json` 映射 + slug 目录里的 `.project_root` 标记文件，**不要自己推导 slug**
- Qwen Code：读 session 首条记录的 `cwd` 字段（目录名有碰撞可能）
- OpenCode：SQLite `project` 表的 `worktree` 列
- Kimi Code：新版读 `session_index.jsonl` 的 `workDir`；旧版读 `kimi.json` 的 `work_dirs[]`

## 6. 关键机制设计

### 6.1 配置切换（双模式）

- **注入模式（默认）**：`PtyManager` 拉起 CLI 时注入 `launch_plan` 的 env/args。不改用户任何全局文件，多个 profile 并存无冲突。
- **全局模式**：`ConfigWriter` 改写目标 CLI 的配置文件（如 `~/.claude/settings.json` 的 `env` 块、`~/.codex/config.toml` 的 `[model_providers]`）。同一 agent 的全部目标文件按事务批次处理：先生成并验证内容 → 建同批备份清单 → 写入并同步全部临时文件 → 统一替换；任一步失败回滚整批。恢复选择最近一个完整批次，恢复前再备份当前状态，原恢复点不消耗。每类备份保留最近 5 份。UI 上必须明示「这会修改该 CLI 的全局配置，影响你在其他终端里的使用」。**Codex 不写 `auth.json`**（v3.249 / v3.250）：密钥只落 provider 块的 `experimental_bearer_token`（ChatGPT 自带 Codex 的 ModelProviderInfo 认这个字段，不认 MCP 用的 `http_headers`）；`auth.json` 是官方登录 / API Key 单槽，中转密钥写进去，渠道一撤就会打到 `api.openai.com` 报 401。
- **Profile 可用性验证**：保存与可用分离。`profile_validation` 返回三层结构化结果：本地字段及活配置解析 → CLI doctor/启动预检 → 最小 API 请求（协议、鉴权、模型存在性、延迟）。密钥只在 Rust 层读取并参与请求，所有回传文本先脱敏。「设为全局」成功后至少自动执行前两层，避免写入成功却留下 CLI 无法解析的配置。**Codex doctor 0.154+** 注入自定义 provider 时会把中转探测 404、桌面 CDN、会话库等打成 overallStatus=fail / exit 1；CLI 层只认 `config`/`auth` 两项，连通性归 API 层与网关库测试，不得把整份 JSON 尾巴当失败原因。

### 6.2 密钥存储

- 密钥本体存 `<平台配置目录>/ccode/keys.json`，文件权限 0600（与 Codex `auth.json`、Claude Code 在 Linux 的 `.credentials.json` 同一威胁模型）；`profiles.json` 里只存尾号提示（`key_hint`）。MCP 引用变量的值另存同目录 `mcp-keys.json`（0600，键是环境变量名如 `CONSENSUS_API_KEY`），不与网关 id 混表。
- **不用系统钥匙串**（v0.1 曾用，已废弃）：macOS 钥匙串 ACL 与代码签名绑定，未签名的开发构建每次热重编译产生新 cdhash，旧条目即失配读不到，表现为「密钥消失」；Linux 的 Secret Service 在无桌面环境下也不可用。读取时保留从钥匙串的一次性迁移，兼容旧版本数据。
- 注入时从 `keys.json` 读出，只存在于子进程环境变量中，不进日志、不前端回显（UI 只显示尾号掩码）。MCP 引用变量同时注入 `mcp-keys.json`。

### 6.3 内嵌终端

- Rust 侧 `portable-pty` 创建 PTY 并 spawn CLI（带上 launch_plan 的 env/args/cwd）；输出字节流经 Tauri channel 推给前端 xterm.js；前端输入/resize 反向 command。Windows 走 ConPTY（portable-pty 已封装）。
- 支持多标签：每个标签一个 PTY 实例，`PtyManager` 按 id 管理。
- 每个终端标签记录 `(agent, profile, project_dir, linked_session_id)` 元数据，供工作区面板展示与联动。
- 应用重启只恢复**可重新启动的标签元数据**：label/cwd/agent/profile/model/sessionId 白名单写入 localStorage；PTY id、scrollback、密钥、环境变量、run 脚本命令均不持久化。重开后是明确的非运行占位标签，用户点击才创建新 PTY；目录/profile 失效时停在可编辑启动栏，不自动换目标。

### 6.4 会话索引与准实时监控

- 首次扫描 + 增量监听（`notify` crate 监听各 agent 会话根目录）。
- 索引结果缓存到 app 自己的 SQLite（app 数据目录），启动秒开列表；源文件 mtime/大小变化才重解析。
- 解析器防御式规则（调研确认各家格式都是**内部格式、随版本漂移**）：逐行解析、跳过未知 type、容忍最后一行截断、不依赖单一字段存在。Claude/Qwen 每行带 `version` 字段，可用于问题定位。
- 已知特殊处理：Codex 旧 rollout 会被 **zstd 压缩**成 `.jsonl.zst`；Gemini 有 `$rewindTo`/`$set` 控制记录（不能简单拼接）；OpenCode v1.2+ 是 **SQLite（WAL 模式只读打开）**，更早版本是 JSON 文件。

### 6.5 会话分类与保留（借鉴 Wave Terminal）

会话文件的两大风险：会被 CLI 自动清除（Gemini 默认 30 天）、格式会被迁移压缩（Codex zstd、OpenCode 换存储）。因此「分类」和「保留」必须由 Ccode 自己的存储承担：

- **整理数据存 app.db，源文件只读**：`session_meta` 表以 `(agent, session_id)` 为键，存 `{ pinned, archived, custom_title, tags[], note, pinned_at }`。借鉴 Wave 的 namespaced meta 思路——语义全在我们这边演进，不碰 CLI 任何文件。
- **pin 即保留（快照拷贝）**：借鉴 Wave「named = saved」的零按钮理念——用户点 pin 时，Ccode 把会话源文件**拷贝**为 `<app-data>/ccode/snapshots/<agent>/<session_id>.jsonl`（OpenCode 则导出该会话的消息行）。此后 CLI 端无论自动清除还是迁移，回放都走快照；未 pin 的会话源文件消失时，仅在列表标注「已失效」。
- **分类三个维度**：① 自动——按项目聚合（§6.6 的 ProjectAggregator）；② 手动——tags + custom_title；③ 状态——pinned / archived / 默认。列表页支持按 agent、tag、时间范围过滤，以及标题 + **会话正文**关键词搜索（Wave 恰恰没有全局搜索，这是我们可以做透的空白；机制见 v3.166）。
- **注意力标记（后续）**：Wave 用 Claude Code hooks + badge 做「哪个会话需要输入」的优先级汇总，P3 可借鉴，配合 SessionLink 在终端标签上显示状态。

### 6.6 项目聚合与分类（ProjectAggregator）

- 数据源：各 adapter 的 `list_sessions` 产出的 `project_path` 集合，跨 agent 归并。
- **归并规则**：路径规范化（resolve `~`、符号链接、尾部斜杠、大小写按平台）→ 若同属一个 git root（向上找 `.git`）则合并为一个项目，展示名取 git root 目录名。
- **分类**：自动标注每个项目「哪些 agent 用过 / 会话数 / 最近活跃时间」；默认按最近活跃排序；支持用户置顶（pinned）、隐藏（hidden）、打标签（tags）。这些用户整理数据存 app 自己的 `app.db`，不参与归并逻辑。
- 也支持手动添加一个尚无会话的目录。

### 6.7 终端 ↔ 会话联动（SessionLink）

工作区双栏：左边终端，右边该会话的结构化对话（随文件监听准实时刷新）。关联策略：

1. **优先确定性关联**：对支持 `--session-id` 的 agent（Claude Code、Qwen Code），启动时由 Ccode 生成 UUID 并传入，会话文件名即可预测，启动即锁定。
2. **兜底探测关联**：其余 agent 在启动时记录 `(agent, project_dir, launch_time)`，FileWatcher 在该 agent 会话根目录下发现 `mtime > launch_time` 且项目归属匹配的新文件，即关联到该终端标签；多个候选取最新。
3. 关联失败不阻塞终端使用，右栏显示「等待会话文件产生」；会话结束后仍可回放。

### 6.8 App 自身数据

```
<平台 app-data 目录>/ccode/
├── profiles.json          # profile 定义（无密钥明文）
├── keys.json              # API 密钥（0600）
├── catalogs/              # codex model catalog（按 profile 生成）
├── snapshots/             # pin 的会话快照
├── app.db                 # 会话索引缓存 + session_meta（SQLite）
└── backups/               # 全局模式改写前的配置文件备份
```

### 6.9 工作区：工作树与并行可视化（借鉴 VS Code）

VS Code 的五区布局（活动栏/侧栏/编辑器区/面板/状态栏）映射到 Ccode 的产品逻辑——核心对象是「(agent, profile, 项目) 的并行会话」：

- **工作树（Explorer）**：终端页左侧可折叠栏，根目录 = 活动终端标签的 cwd，切标签即切根。借鉴 VS Code Explorer 的懒加载（展开才读子目录，`list_dir` command）与单击预览（右侧预览面板，只读、文本上限 256KB、二进制拒绝，`read_file_preview` command，路径限制在项目根内）。刷新：切回标签自动 + 手动按钮；文件监听自动刷新留 P4。
- **运行中总览**：工作树下方固定面板，列出全部终端标签（借鉴 VS Code 终端标签列表）：状态点（绿=agent 运行 / 蓝=shell / 灰=已退出）、agent、profile、模型、项目 basename、启动时长；点击激活标签。这是并行工作的可视化入口；P3 接 hooks badge 后叠加「等待输入」标记（Wave 思路）。
- **布局**：终端页三带 `[上下文（项目/工作区/文件树） | Agent 聊天/终端 | 成果工作台（文件 / 改动）]`，左栏可折叠，主工作区默认以终端层展示当前会话（2026-09-02 起，此前默认聊天层）。聊天与终端共享同一 TerminalView、PTY、xterm 和会话文件；聊天可拉起同一会话的终端：底栏真实分栏并 fit（v3.168 / v3.177 界面名「拉起终端」；不能裁全高 xterm 底部，Codex inline 底下是空行）。右侧工作台只负责文件预览编辑和 Git 改动，避免重复渲染实时对话；任务审阅仍从改动页进入既有全宽覆盖层。右侧宽度可拖拽并记忆，宽屏动作只隐藏工作树、不杀终端。App 主区与终端三带均以 `h-full/min-h-0` 约束，外层裁切溢出，滚动只落在文件树、聊天消息、diff 等具体内容区；避免页面级滚动或无约束 flex 子项在窗口缩放、拖动或长内容后留下黑屏/空白。
- **改动面板（借鉴 VS Code Source Control 与 Codex 环境信息）**：右栏第三页签，量化 agent 的工作成果——当前分支、领先/落后远程、对比 HEAD 的 `+/-` 行数（含未跟踪文件）、文件级列表。普通仓库默认不选择文件，`git_commit(paths)` 与 `ai_commit_message(paths)` 使用 `--literal-pathspecs` 且重新校验当前 status，只暂存/读取用户勾选项；工作区任务维持全量提交语义。提交信息非空时按原文执行「提交 / 提交并推送」，留空时同一按钮切为「快速提交 / 快速提交并推送」，前端按所选文件状态或数量即时生成中性默认信息，不启动 AI。Git 失败保留默认信息。独立 ◈ 仍可按需生成更完整的信息。8 秒轮询刷新，非 git 仓库明确提示；git 写操作始终只由用户点击触发，命令输出与错误回显。
- **明确不借鉴**：VS Code 服务化 workbench 架构（过重）；文件树 git 装饰（标改动）留 P4；真正的编辑器留 P4 Monaco，预览只读先行。

### 6.10 任务工作区编排（借鉴 Conductor，全量整合）

Conductor 的核心模型「工作区 = git worktree + 分支」解决我们的并行冲突隐患：现在多个终端标签在同一目录跑 agent 会共享文件与 git 状态。整合方案：

**工作区模型与位置**
- 位置：`~/ccode/workspaces/<repo名>/<任务名>/`（worktree 实体）；元数据存 `app.db` 的 `workspaces` 表
- 一个工作区 = 一条 `ccode/<任务名>` 分支 + 一个 worktree；分支是评审与合并单元
- worktree 与主仓库共享对象库，创建是秒级；归档只移除 worktree 不删分支，可恢复（含会话历史）

**生命周期**
1. **创建**：SQLite `BEGIN IMMEDIATE` 原子预留端口并写 `status=creating` → 从**本地基准分支**拉 `ccode/<name>`（含未推送提交，镜像本地项目现状；曾从 `origin/<base>` 拉导致未推送工作丢失，已改）→ `git worktree add` → **files-to-copy**（`.env*` 等 gitignored 文件按 `.ccode/settings.toml` 的 `files_to_copy` 复制进 worktree）→ 激活记录 → **setup 脚本** → 自动开终端标签（cwd = worktree，注入端口段 `CCODE_PORT..CCODE_PORT+9`）。worktree/复制/激活失败执行补偿事务：移除 worktree、prune、删除分支和 creating 行并释放端口；复制错误必须中断并点名文件。setup 失败沿用非阻断语义，保留工作区供修复
2. **工作**：现有三带工作区全部适用；git 面板的 diff 基准从 HEAD 改为 `merge-base(base, branch)`，能看到任务累计改动
3. **合并**：改动面板扩展——提交后可选「合并回 `<base>`」（本地 merge）或「创建 PR」（复用机器上的 `gh` CLI 认证，不做应用内 GitHub 登录）；冲突时提示让 agent 解决
4. **归档**：先拒绝 merge 进行中、未提交改动和仍运行的 agent/run 脚本；脏工作区提供「提交并归档」→ 跑 archive 脚本 → `git worktree remove`（不带 `--force`，保留分支）→ 状态 Archived；恢复 = 从分支重新 `worktree add`。`--force` 仅用于用户明确确认的删除操作

**一致性与修复**：`workspace_drift` 对 DB、仓库、分支、worktree 注册和 merge 状态做显式对账。异常时普通危险动作停用，只暴露与问题匹配的修复：重新挂载/修复 worktree 链接、重新定位仓库、元数据标记归档、元数据清理记录，或进入统一冲突审阅。标记归档与清理记录不得删除磁盘/分支。`ReadyToMerge` 必须同时满足 `ahead > 0`、无未提交、无冲突、主仓在基准分支且干净；空工作区不能合并。

**操作呈现**：工作区列表是任务索引，只保留任务、状态详情和「终端 / 评审」主路径；PR、归档及其确认都定位到全宽评审内执行，避免在列表页形成第二套完成流程。唯一高频例外是已进入 merge 的冲突工作区：列表直接显示「解决冲突」，但仍只进入同一全宽审阅覆盖层。

**项目级配置**（三层合并：用户级 `~/.config/ccode/settings.toml` → 仓库 `.ccode/settings.toml`（可提交共享）→ `.ccode/settings.local.toml`（本地覆盖））：
```toml
files_to_copy = [".env", ".env.local"]
run_mode = "concurrent"            # nonconcurrent 时 run 按钮互斥
[scripts]
setup = "pnpm install"
archive = "docker compose down"
[scripts.run]
web = { command = "pnpm dev", default = true }
test = { command = "pnpm test" }
```
run 脚本在终端页以按钮呈现（在工作区上下文时），run_mode=nonconcurrent 保证单实例。

**与现有架构的咬合点**
- ProjectAggregator：worktree 路径（`~/ccode/workspaces/...`）的会话归并到「仓库 + 工作区名」标签下，不散落成独立项目
- 终端标签：携带 workspace 徽标；「运行中」面板可按工作区分组
- 会话/pin/回放：无变化（路径自然落进 worktree 目录的会话记录里）
- 端口注入走 pty 的 spawn env，与 profile env 叠加

**分阶段实施**
- **阶段 A（核心闭环）**：Workspace 模型与 app.db 表、创建/归档/恢复/删除、files-to-copy、端口注入、ProjectAggregator 归并、新「工作区」页面（仓库 → 工作区列表 + 状态 + 打开终端）
- **阶段 B（自动化）**：`.ccode/settings.toml` 三层合并、setup/archive 脚本执行、run 脚本按钮
- **阶段 C（评审流）**：diff 基准改 merge-base、合并回 base、gh PR 创建、状态机（ReadyToMerge 判定：`ahead > 0`、无未提交改动、与 base 无冲突、主仓位置与状态正确）

**明确不做**：云工作区、多人协作、应用内 GitHub 登录、城市命名游戏化、agent 系统提示注入（后续按需）。

### 6.11 P3 设计：OpenCode 解析、用量统计、注意力标记

**页面结构**：侧栏由四页扩为五页——配置 / 工作区 / 终端 / 会话 / **统计**。

**OpenCode 会话解析（补齐第六个 agent）**
- 数据源：`~/.local/share/opencode/opencode.db`（v1.2+ SQLite，WAL 只读打开，`busy_timeout`）；旧版（<v1.2）`storage/` 扁平 JSON 做兼容回退
- 表映射：`session`（id/title/cost/tokens_*/time_*/directory）→ SessionMetaDto；`message`（data JSON：role/model/tokens/cost）+ `part`（data JSON：text/reasoning/tool 判别联合）→ ChatMessageDto；项目归属：`project.worktree` 列
- 解析策略：只读查询 + JSON 列防御式解析；drizzle schema 随版本迁移，列缺失时降级而非报错；优先用官方 `opencode export`？否——用户机器上 opencode 未装时仍需能读库，直读 SQLite 为主

**用量与费用统计（新「统计」页）**
- 数据模型：解析层为 usage 事件产出 `{ agent, model, project_path, day, input, output, cache_read, cache_write, source, internal }`，按本机日期聚合存 app.db（避免每次全量重算；扫描增量更新）。普通 JSONL 与 Codex zstd 会话逐行流式解析，峰值内存由单条记录决定，不得以整个会话文件大小为由丢弃用量。普通会话默认为 `source=cli/internal=false`；Ccode 的 ◈ 无头调用在进程启动前写 `usage_provenance(agent, exact_project_path)`（独占临时 cwd，一次运行一个目录），重建索引时精确关联为 `source=ccode-ai/internal=true`；v3.255 起 `session_meta.internal` 的会话级登记（雷达解读/定时巡检按会话 id）同样纳入索引。项目/模型 DTO 保留该维度，同一模型的普通和内部用量不能混行。路径与模型名只允许做跨平台规范化，不得参与内部活动判定；用户在 `/tmp` 主动运行仍是普通活动。官方账号（订阅制）按会话级 provenance 登记（v7 schema，`usage_provenance` 加 session_id 列）；总额/趋势/榜单共用同一计费范围——官方账号与 internal 不计费，token 量单列展示
- 定价表：内置 `model_pricing.json`（模型名/前缀 → 每百万 token 输入/输出价，参照 cc-switch `model_pricing.rs` 与 models.dev，允许用户在设置里覆盖）；中转模型价格不明时只显示 token 数，费用标「~」
- 页面结构：顶部卡片（今日/本周/本月 token 与估算费用）→ agent 分布 → 项目排行 → 模型明细表
- 边界：codex/gemini 的非累计 per-turn 用量按行聚合求和；claude cache_read 单列（它的计费大头）

**注意力标记（哪个 agent 需要你）**
- v1 启发式（零侵入，覆盖全部 agent）：终端标签有进程在跑 + 会话文件最后一条是「assistant 文本收尾（无待执行工具）」→ 「已完成/等待输入」蓝点；最后一条是「工具调用待结果」或进程高速输出 → 「工作中」绿点；权限请求类提示 → 「待确认」琥珀点。数据源：SessionLink 已有的轮询 + PTY 输出速率
- v2 精确化（后续）：Claude Code hooks（`~/.claude/settings.json` 的 hooks 字段，Notification/Stop 事件 → 写临时状态文件供 Ccode 读）——写入用户配置需备份与用户授权，单独评估
- 展示位：终端标签圆点、运行中面板状态、工作区行

**实施顺序**：OpenCode 解析 → 用量统计 → 注意力标记 v1。

### 6.12 跨模块闭环功能（会话 ↔ 终端 ↔ 工作区 ↔ 配置）

四个模块不再是孤岛，通过五条连接形成闭环：

- **A. 会话一键恢复到终端**：会话行/回放页「在终端恢复」→ 开终端标签：cwd = 会话项目目录、agent 对应、profile 取该 agent 上次使用的、并把恢复参数传给 CLI（claude `-r`、codex `resume`、qwen `-r`、kimi `-S`、gemini `-r`、opencode `--session`）。`pty_spawn` 加 `resume_session_id` 参数：注入恢复参数、跳过 `--session-id`（恢复的是已有会话）、hint 直接用该 id，SessionLink 确定性联动
- **B. 会话「进行中」标记 + 反向跳转**：终端标签 SessionLink 关联成功后，在 zustand 注册 `liveSessions`（sessionId → tabId）；会话页显示 🟢「进行中」，点击 → `setPage("terminal")` + 激活对应标签（`focusTabId` 桥）
- **C. 工作区记住上次配置**：localStorage 按 worktreePath 存 `{agentId, profileId}`；「打开终端」预填
- **D. 工作区行 → 查看会话**：会话页搜索字段加入 workspace 名；工作区行「会话」按钮 → `setPage("sessions")` + 预设搜索词
- **E. profile 上次使用时间**：`Profile.last_used_at`（启动时更新），配置页行显示相对时间，识别死配置

### 6.13 技能管理（Skills，借鉴 cc-switch 与 Agent Skills 开放标准）

侧栏第五页「技能」（配置/工作区/终端/会话/**技能**）。技能 = 目录 + `SKILL.md`（开放标准，frontmatter `name`/`description` 必填，各 CLI 扩展字段防御式忽略）。

**模型：技能库（SSOT）+ 分发**
- 库位置：`<config>/ccode/skills/<name>/`；元数据存 `skills.json`（name、description、source、apps 六 agent 布尔、installed_at）
- **应用到 agent** = 把库里的技能分发到各 CLI 的技能目录：
  - claude-code → `~/.claude/skills/`；codex → `~/.codex/skills/`；gemini → `~/.gemini/skills/`；qwen → `~/.qwen/skills/`；opencode → `~/.config/opencode/skills/`；kimi → `~/.kimi-code/skills/`
  - 分发方式 Auto（symlink 优先，失败回退 copy；Windows 无权限时自动 copy）
  - 嵌套技能目录（`skills/doc/docx/`）拍平为单段目录名；判定单位 = 含 SKILL.md 的目录，找到不下钻，跳过 `.` 开头目录
- 卸载自动备份（`<config>/ccode/skill-backups/`，保留 5 份）

**导入（四路）**
1. **本地目录**：选一个目录，递归扫描含 SKILL.md 的子目录批量入库
2. **ZIP 文件**：扫描 ZIP 内含 SKILL.md 的条目；安全三件套（解压预算 ≤128MB/10000 条、路径穿越校验、symlink 物化为副本）
3. **GitHub 仓库**：`owner/repo[/subdir]`，下载 `archive/refs/heads/<branch>.zip`（main→master 回退）后按 ZIP 流程；预设 anthropics/skills 等常用源
4. **从应用目录发现**：扫描六 CLI 技能目录 + `~/.agents/skills/` 里未纳管的技能，一键收编入库

同名导入返回结构化 `added/updated/skipped/conflicts`；用户可选择跳过、备份后覆盖或另存为。覆盖先备份旧库，ZIP 先完整解压到 staging，元数据保存失败回滚库目录。GitHub 来源额外持久化 repo/ref/subdir/revision，`check_skill_updates` 提示 revision 变化；`apply_skill_update` 一键应用更新——按记录的 repo/ref/subdir 重下 zipball，`import_zip_impl` 加 `only` 过滤只覆盖同名技能（其余不新增不覆盖，走同一覆盖+备份路径），成功后刷新 revision 基线；上游改名/移动时明确报错并引导手动重新导入（仍走冲突确认）。

**内置技能种子（v3.124）**：18 个内置技能内容单一出处在 `src-tauri/resources/skills/<name>/SKILL.md`，经 `include_str!` 编进二进制（dev 与打包行为一致，不配 bundle resources）；启动时 `seed_builtin_skills` 幂等播种——只补库里没有的同名项，**永不覆盖用户已有/改过的技能**；库目录下 `.builtin-seed-version` marker 记录已播种版本，集合有新增时 `BUILTIN_SEED_VERSION` +1 触发补播，用户删掉的内置技能不会被复活。元数据 `source = "builtin"`，更新检测只对 github 来源生效、天然不碰内置技能。新增 `research-writing` 专用于实证科研论文 IMRaD 写作，避免把综述写作规范误套到实证论文。

**导出**：单个/多个技能打包为 ZIP（系统保存对话框）。

**页面**：技能行（名称 + description + 六个 agent 的应用开关徽标）+ 操作（查看 SKILL.md、重新应用、导出、删除）；顶部 导入/导出 按钮。查看用只读预览复用现有组件。

**后续（v2）**：来源更新检测（content_hash 比对）、SKILL.md 在线编辑、自定义命令（commands/prompts）管理。

### 6.14 诊断包与 Windows 后台进程边界

设置页「诊断」提供一键导出 `ccode-diagnostics-<时间>.zip`，固定写入下载目录的 `ccode-exports/`。诊断包由 Rust 层统一组装，包含：

- Windows 版本、WebView2 版本、显卡与驱动；前端补充 WebView user agent、语言、屏幕和 WebGL vendor/renderer；
- 当前文化、用户语言、默认与活动输入法布局，以及 CTF/TextInputHost 活动；
- 应用功能开关的脱敏快照（不输出 profile id、密钥或环境变量）；
- `logbuf` 最近 500 条应用日志；
- 自 Ccode 启动后的进程生命周期：程序、脱敏参数、PID/父 PID、开始/结束/最后观察时间、CPU/内存、类别、采集方式与时间是否估算。

直接经 `process::background_command` 启动的后台命令在 spawn/wait 边界精确登记程序、参数、PID、父 PID 与退出码；250ms
进程扫描补齐 WebView2、conhost、命令包装器的子孙进程和 CPU/内存，扫描拿不到创建时间时明确标记为估算。记录采用内存环形缓冲
（上限 2000），只覆盖 Ccode 子孙进程；系统级例外仅观察
`ctfmon.exe` / `TextInputHost.exe`，避免采集无关应用命令行。诊断包不读取任何子进程环境变量，命令参数和日志写入 ZIP 前必须经过
Rust 层密钥脱敏；路径与普通参数仍保留，README 明示发送前可先解压检查。ZIP 只使用 UTF-8 JSON/TXT，目标是 Windows 现场采集后
带回 macOS 离线分析，不依赖注册表导出、事件查看器格式、Ccode 或 Windows 专用查看器。

Windows release 构建使用 `windows_subsystem = "windows"`，没有可继承的父控制台。后台 console 程序若直接
`Command::new` 会创建可见 `conhost.exe`，终端右栏 Git 的 8 秒轮询因此表现为周期性闪黑窗。所有非交互后台命令统一走
`process::background_command` 加 `CREATE_NO_WINDOW` 并登记生命周期；这些包装与进程扫描均由 `cfg(windows)` 隔离，macOS/Linux
仍直接使用标准 `Command` 且不启动监控线程。用户明确打开的外部终端是唯一可见窗口例外。

### 6.15 MCP server 清单与分发

MCP 页（第八页，⌘6）：Ccode 自有统一清单（`<config>/ccode/mcp-servers.json`，`mcp.rs`），按开关分发到各 CLI 的**用户级** MCP 配置（grok 首版只读清单、不分发，见 matrix §10.1）。规格与调研结论的单一出处是 `docs/agent-integration-matrix.md` §10（分发通道总表 / schema 映射 / 密钥插值 / 共性红线），改映射前先读它。

要点：

- **统一模型**：name（各家交集 `[A-Za-z0-9-]`，下划线禁——gemini policy 引擎按下划线切分）+ kind（stdio/remote）+ command/args/cwd/env + url/headers；env 与 header 的值允许 `$VAR`/`${VAR}` 引用形式。引用变量可在 MCP 表单密钥栏填写，存 `mcp-keys.json`，启动与体检时注入。
- **映射层**：codex 走 TOML `[mcp_servers.<name>]`（toml_edit 保格式；引用转 `env_vars`/`env_http_headers`/`bearer_token_env_var`，内联 bearer 会被 codex 显式拒绝）；opencode 顶层键是 `mcp` 且 command 为数组、env 叫 `environment`、引用语法 `{env:VAR}`；gemini/qwen 的 remote 写 `httpUrl`（url=SSE 已 legacy）；kimi 无插值（header 的 Bearer 引用转 `bearerTokenEnvVar`，env 引用直接拒写报错）；claude/codex/gemini/qwen 的目标文件是混合状态文件，只读-改-写一个键/段。
- **分发纪律**：只写用户级（项目级在 claude/qwen/cursor/codebuddy 有审批闸）；写前备份 + 原子写 + 读回校验；JSONC 容错读（注释/尾逗号 stripper 自实现）；claude 的 managed-mcp.json 存在即拒写；cursor 配置与 IDE 共享（UI 明示）。
- **不用 CLI 自带 mcp 命令分发**：各家语义不一（gemini 默认 project scope、codebuddy 默认 local、codex add 命中 OAuth server 会弹浏览器登录、kimi/cursor 没有可脚本化命令），直写文件八家统一且可批量。
- **编辑重投放**：save 时先重写到所有已开启 agent、全部成功才落库（防「清单说已分发但 agent 侧没写成」的假状态）；删除先逐 agent 移除条目再出清单。
- **安全闸**：清单文件 0600（对齐 keys.json）；明文密钥拦截——env/header 值命中常见密钥前缀且非 `$VAR` 引用时，保存/粘贴导入报 `PLAINDETECT:` 由前端二次确认；移除/删除前比对 agent 侧条目与当前映射产物，外部改过的报 `EXTMOD:` 确认后才强删；粘贴导入两阶段（预览命令清单 → 确认落库），stdio 命令等于任意执行必须明示。

## 7. 技术选型清单

| 层 | 选型 | 理由 |
|---|---|---|
| 壳 | Tauri v2 | 已确认；体积小，Rust 层适合文件/进程/PTY |
| 前端 | React 19 + TypeScript + Vite + Tailwind | Tauri 标配，生态熟 |
| 终端 | `@xterm/xterm` + `addon-fit`；Rust `portable-pty` | 事实标准组合，Windows 走 ConPTY |
| 文件监听 | `notify` | 跨平台 |
| SQLite | `rusqlite`（bundled） | 读 OpenCode db + 自身索引缓存 |
| 压缩 | `zstd` crate | Codex `.jsonl.zst` |
| 密钥 | `keyring` crate | 三平台系统钥匙串抽象 |
| 路径 | `dirs` crate | 三平台 app-data / home 目录 |
| 状态管理 | zustand | 轻量，够用 |
| TOML/JSON | `toml` / `serde_json` | 写各 CLI 配置文件 |
| CI | GitHub Actions 三平台构建矩阵 | 三平台同步的保障，P1 接入 |

刻意不做的事（MVP 阶段）：无后端服务、无账号体系、无云同步、无插件系统、不自研编辑器（后期直接嵌 Monaco）。

## 8. 分阶段路线图

> 以下为通用控制台阶段的原始规划；标记为完成的是对应历史阶段的验收范围，不代表后续 Run/Runtime 收口已全部完成。2026-08 起的新阶段见 §11 演进线。

- **P0 — 骨架跑通**：Tauri 工程 + Profile CRUD（含钥匙串）+ Claude Code / Codex 两个 adapter 的 detect + 注入式 launch + 单标签内嵌终端。验收：在 app 里用「中转 profile」拉起 claude 并对话。
- **P1 — 配置中心完整**：其余四个 adapter 的 detect + launch；全局写入模式（含备份/恢复）；多标签终端；启动面板；**接入 GitHub Actions 三平台构建**。
- **P2 — 会话可视化**：SessionIndexer + 四个 jsonl 系 parser（Claude/Codex/Gemini/Qwen）+ **ProjectAggregator** + 项目 → 会话 → 回放三级页面 + **会话分类与保留（session_meta 表 + pin 快照，§6.5）** + 全局搜索 + 文件监听准实时刷新 + **SessionLink 终端联动**。
- **P3 — 会话可视化补全**：OpenCode（SQLite + legacy JSON 双解析）、Kimi 双版本 wire 协议解析（**已提前完成**）、**token/费用统计面板**。
- **P4 — IDE 形态**：项目文件树、Monaco 编辑器、（可选）本地 API 代理用于精确计费/实时结构化对话。
- **W1 — 任务工作区核心闭环（§6.10 阶段 A）**：Workspace 模型、创建/归档/恢复、files-to-copy、端口注入、工作区页面、ProjectAggregator 归并。
- **W2 — 工作区自动化（阶段 B）**：`.ccode/settings.toml` 三层配置、setup/archive/run 脚本。
- **W3 — 评审流（阶段 C）**：merge-base diff、合并回 base、gh PR 创建、工作区状态机。

## 9. 主要风险与对策

| 风险 | 对策 |
|---|---|
| 各 CLI 会话格式是内部格式，随版本漂移（调研已确认六家都漂移） | 防御式解析；每行带 version 时记录；解析失败降级为「原始视图」而不是报错 |
| Codex 中转必须讲 Responses API，很多 Anthropic 系中转不支持 | UI 上对该 profile 类型给出协议提示；不强推 Codex + 任意中转的组合 |
| Gemini 会话默认 30 天自动清除 | 列表页容忍会话消失；重要会话提供「导出快照」 |
| 新旧 Kimi 命令同名、格式完全不同 | detect 时按版本号 + 数据目录区分，UI 显示为两个 agent 条目或标注版本 |
| 全局模式写坏用户配置 | 多文件事务批次 + 失败整批回滚 + 恢复前再备份当前状态 + UI 明示影响范围 |
| 三平台差异（路径大小写、ConPTY、keyring 后端、会话目录） | `dirs`/`keyring`/`portable-pty` 均已封装；P0 在 macOS 开发但禁写平台特定代码，P1 起 CI 三平台构建验证 |
| Windows 上 Gemini/Qwen/Kimi 依赖 Node 或 Git Bash 环境 | detect 结果里给出缺失依赖提示，不静默失败 |

## 10. 决策记录

### 2026-10-23 · 抽查精读笔记改在沉浸阅读里对照原文看

用户：「抽查三篇笔记还要跳转到运行页，太麻烦了，且无法对照原文。」原先点名单走运行页单栏预览，看不到 PDF；能对照原文的
沉浸阅读又拒收未合并的工作区笔记（`reader_for_note` 报「评审合并后再进」），而抽查恰在保存进项目之前。设计两处由用户拍板
「都按推荐做」：

一，**抽查 = 沉浸阅读的核对档**：点一篇直接盖上阅读区（左笔记、中原文，仅摘要的篇中栏放题录摘要），三篇在顶栏切，退出回流程页。
二，**笔记只读**：工作区笔记是待评审产物，人在这里改，评审看到的就不再是 AI 交付的那一版；写笔记的动作（标注、插图、存译段、
让 AI 起草）在核对档全收。
三，**右栏是问题单，不派阅读会话**：阅读会话在项目根运行，改的是主仓笔记，会改错地方。划段「记成问题」带出处进问题单，看完一次
「发给这一步的 AI」（接回原对话，要求改这几篇并复查同类，事项不勾），或「N 篇都没问题」勾上。
后端新命令 `spot_check_item` 解析每篇（不复用 `reader_for_note` 的主仓映射）。实现口径见 terminal.md「抽查核对档」。
同日追加（用户：问题单窄一点，左侧保留阅读宽度）：核对档栏宽另记一套，缺省笔记 34%、问题单 18%，放不下先压问题单。
同日再追加（用户：翻译悬浮球脱出了 PDF）：「译」球的坐标域从整窗收回 PDF 栏（修订 2026-10-14「整窗可拖」），球与卡共用 `readerTlBallOffset`；核对档译文卡不出「问这段」。
同日第三批（用户：译文悬浮窗可以做什么优化，「1–4 都做」）：卡开着时 PDF 上常驻标出它的原文段，悬浮卡压到就挪到那段上方或下方；表头只留原文 / 存进笔记 / 复制 / ⋯ / ×；悬浮卡译文改阅读字号 13px；下面还有字时卡底渐隐。逐句对照（第 5 条）暂缓。

### 2026-10-23 · 初稿步复查整改：参考文献表在渲染时整理

用户跑完 HER 综述「综述初稿」后让查产物（「全部按建议来」）。PDF 文献表三处毛病：Pandoc 读 BibTeX 把英文标题改成
句首大写，元素符号跟着变小写（Ru → ru、Ni-Mo-B → ni-mo-b）；Zotero 题名前的人手编号（【74】、19~.）与「p. 待补」
印进文献表；没有 References 标题。定为**渲染时整理、引文库不改**：quarto-render 新增 `scripts/references.lua`，
`manuscript_font.py` 拷到源稿旁并写进 YAML `filters`（标题整体加保护、去编号、缺口标记字段不印、缺 `#refs` 时补不编号标题）。
不选「引文库标题统一加双花括号」：写引文库的入口多（Zotero 导入、lit_records、Agent 手写），读的地方也多，渲染是唯一咽喉。
稿件内容的事实错误（摘要把非贵金属 NiSb 写成贵金属标杆等）与自绘示意图文字重叠发回该步 AI 改，不改模板。

### 2026-10-23 · 大纲步复查整改：用户自己的库不由 Agent 排除、Zotero 只登记正文 PDF

用户跑完 HER 综述的「综述大纲」后让看会话（「全部按建议来」）：大纲本身扎实，问题都在上游。

一，**用户自己的库不由 Agent 排除**：检索步把人从 Zotero 导入的 9 篇按检索年份窗口排掉，只写在 screening.md、不进
included.json——Mesa 文献清单里看不到、改不回，大纲步任务书拍板「改判纳入」后 Agent 只能让人手改 JSON。定为：
人导入的每条都进 included.json，检索过滤不套用，Agent 最多标待确认、写「建议排除」；Zotero 导入登记的正文 PDF 即全文，
不进待获取。`lit_records.py check` 机器点名。细则 pipeline.md「用户自己的库不由 Agent 排除」条。

二，**从 Zotero 导入只登记正文 PDF**：一个条目挂正文和 SI 两份时按数据库顺序取第一份，Fan2022 拿成了 SI。按附件标题、
下载地址、文件名与 Zotero 全文索引第一行认补充材料，缺 %%EOF 的没下完文件也不算；只剩这些时不当全文（列待获取）。
项目资源名同时去掉人手编号前缀。

三，Windows 任务书「读 PDF 用 PyMuPDF」提示扩到输入提到 PDF 或项目资源挂着 PDF 的步骤（大纲步要直读原文）。

### 2026-10-23 · 同步到文献库：Windows 真导入、整份导入、导出题录写法

用户在 Windows 上点「同步到 Zotero / EndNote」导不进、核查导出题录后定下：

一，**Windows 交给 Zotero 用 `zotero.exe -url <百分号编码的 file URL>`**：「用 Zotero 打开」在 Windows 是裸路径参数，Zotero 命令行不理；
`-file <中文路径>` 转给已开着的 Zotero 时路径变样。**Zotero 6 一律导不进**（自动更新来的 2026 年格式转换器在 Firefox 60 内核上解析失败，
用户调试日志实证），同步前读 application.ini 版本，低于 7 提示升级、不交文件。EndNote 装在非默认目录时先查注册表（只读）。

二，**整份导入、库里已有的也交**（改 2026-10-11 的「Zotero 按 DOI 差量」）：Mesa 题录字段全是卖点，重复条目由人在文献库里挑着合并；
检索时排除的篇不导；同步写单独的 `papers/zotero-library.ris` / `endnote-library.ris` / `endnote-journals.txt`（gitignored），
不改检索清单那份 `endnote-import.ris`。

三，**导出题录与界面同一写法**：化学式按整词判定（bridge.py 与 screening-review.ts 镜像、测试逐条比对）；题名去人手编号前缀；
缩写收拾写法；ACS 与 ISO 4 不同的刊两种都给（Mesa 兜底表第三列；EndNote 缩写 2 + 期刊术语表，Zotero「其他」）；
缺字段、有 DOI 的老条目同步前补到临时副本。细则 pipeline.md「同步到文献库写单独的整库文件」条。

### 2026-10-23 · 精读步复查整改（HER 文献精读与笔记）

用户跑完 HER 综述的「文献精读与笔记」后让看会话：23 分钟读完 9 篇 117 页，没有空转；查出的问题用户「全部按建议来」，定下：

一，**「继续」接回原对话带上绑定的模型**：resume 时只带连接（autoLaunchProfileId），启动侧落到连接名单第一个——glm-5.3
的对话接回成 glm-5.3-flash。同一家 Agent 时绑定的模型一并预填（agent-binding.md resume 行）。

二，**只按卷编排的刊期号记「无期号」**：Appl. Catal. B、Chin. J. Catal. 在 Crossref 有卷没期，旧口径写「待补」——永远补不上，
引文库 `number = {待补}` 会渲染进参考文献。`lit_records.py` 补字段时 Crossref 有正式记录、有卷没期就记「无期号」，
不算缺口、不进 RIS、引文库不写 number（早先写的待补行拿掉）；`screening-review.ts` 与 bridge.py 同口径，「待核」也不再漏进 RIS 标签。

三，**精读步不给项目根 PDF 改名**（推翻 v3.97「精读开工统一重命名」）：Agent 照简报把 9 个 PDF 改成「作者年份-短标题」，
流程期间暂缓的资源登记（`.ccode/pending-registrations.json`）全指向旧名，收尾回放会登记一串不存在的路径；沉浸阅读的标注与笔记
也按路径认。改为开工跑 `lit_records.py write --root`：按 DOI、标题认已有 PDF，在 included.json 记 `pdf`、给 to-fetch.md 打 ✓，
to-fetch.md 不手改。认 PDF 多一层：原始字节里搜不到 DOI（元数据在对象流里）时有 PyMuPDF 就抽前两页文字找。

四，**评审移出文献后待获取篇数重算**：`drop_fetch_line` 只删行，留下「还没有全文的 16 篇」下面列 9 行。

五，**Windows 读 PDF 的步骤提示用 PyMuPDF**：本机没装 poppler，Claude Code 读 PDF 报 pdftoppm is not installed，Agent 只抽文字层、
图一张没看；任务书「本机 Python（Windows）」节对精读 / 拼图 / 输入含 PDF 的步骤多带一行（抽字 get_text，看图先 get_pixmap 存图）。

核对后不改的一条：照 PDF 首页补的摘要只进了 references.bib——同步到文献库本就按 references.bib 生成（`zotero.rs refresh_library_ris`），不缺。
HER 当日处理：lit-notes 工作区三篇改「无期号」、引文库去掉 number 行、清单经 write 重出（9 篇 pdf 全认出，先在副本干跑一致）；
主仓暂缓登记里 9 条旧文件名换成新名（备份在临时目录）。

### 2026-10-22 · 检索步复查整改（Windows 实跑 3 小时没跑完）

用户在 Windows 上跑 HER 综述的「文献检索与筛选」（Claude Code 2.1.307 经网关跑 deepseek-v4.1-flash，权限档「自动」），3 小时没收尾。
逐条看会话记录：等模型约 80 分钟、每条 Bash 前的自动档安全检查约 65 分钟（含 9 次超时），真正跑命令约 14 分钟；补字段 / 出 RIS
整条链重跑 26 次；116 次 Python 调用加了 `-I`，69 次输出乱码。用户「按建议全部改」，定下：

一，**开工首句的 MCP 盘点只看工具列表**：Agent 为找 MCP 去读 `~/.claude/settings.json`，网关密钥进了会话记录（已请用户作废换新）。
首句与 lit-search 技能写明不读 `~/.claude`、`~/.codex` 等 CLI 配置文件；某个 MCP 只剩 `authenticate` / `complete_authentication`
两个工具 = 没登录，不调用、不停下来问，记覆盖缺口后继续（登录是步骤面板「配置学术检索 MCP」那一项）。

二，**开放获取版本规则**（`OA_VERSION_CLAUSE`，进检索与精读两步的共用合同）：先正式发表版，其次机构库里的已录用稿；预印本服务器
（arXiv、Research Square、bioRxiv、ChemRxiv、SSRN 等）上的版本只在来源级别允许预印本时才下——看托管处，不只看版本标签
（OpenAlex 把 Research Square 标成 acceptedVersion）。原简报把「作者主页 preprint」列进开放获取，与「不收预印本」矛盾。

三，**要提交的脚本放 `scripts/`**：TASK.md 产物目录段写明「简报没指定位置就放 scripts/（进 git），产物目录只放一次性调试脚本和接口
缓存」。实证：14 个脚本写进被忽略的 `artifacts/`，收尾提交不了又整体搬家。

四，**步骤「继续」默认接回原会话**（改 2026-10-15 的「新会话、不接回」）：上次工作区对话是同一家 Agent 就 resume 它，下一句
`CONTINUE_RESUME_PROMPT`（接着做到完成标准，任务书有改动以新版为准）；另一家仍先问带不带接力简报；没有可接的才新开。有可接对话时
「继续」前面跟一个次要的「新开一轮」（原对话太长或跑偏时用）。理由：新开的 Agent 不知道上次做到哪、卡在哪（本例它正在修
to-fetch.md 32 行对 RIS 16 条的不一致），只能从文件重新摸索；代价是长会话每一步上下文都大，所以留「新开一轮」。

五，**聊天层状态行的计划跨轮找**：Claude Code 的 Task 清单整个会话共用，终端转圈行一直显示进行中那一项（「检索候选…」）；聊天层原先
只在最后一句提问之后拼计划，人发过「继续」就拼不出、只剩光标。这一轮没动计划时改用整段对话的（`conversation-tools.ts sessionPlan`，
只扫待办类工具块按 callId 配结果，不做整段分组）；这一轮自己更新过的仍以这一轮为准。与平台无关，Mac 同样受益。

六，**题录走固定脚本，检索 → 精读 → 文献库一条数据链**（用户：「后面要同步到文献库作为参考文献的，每个步骤任务是一环扣一环的」）：
`lit-search/scripts/lit_records.py`（lit-search、lit-notes 各随一份，依赖同目录的 bridge.py 与 Mesa 缩写表）。`papers/included.json` 是唯一来源：
enrich 一次补齐（Crossref 为准、OpenAlex 补摘要与论文关键词、ISO 4 查表，接口缓存在系统临时目录、6 路并发，HER 28 篇首轮 25 秒、重跑 0 次联网），
fetch 按版本规则下开放获取全文并在 json 记 `pdf`，write 只从 json 出 included.md / to-fetch.md / 两份 RIS，check 校验同序与标签，
精读步 bib 从 json 写 references.bib（已有条目不改键、只补空的）。RIS 拼法与 `screening-review.ts risBody` 双端镜像、测试逐条比对。
顺带修了链上四处：Crossref 日期（issued 取早的，拿它比网络出版日永远相等，网络出版日一直丢）、JabRef 缩写表逗号后带空格
（缩写带上引号）、刊名里的 `&amp;`、引文库里的「待补」被原样同步进 Zotero / EndNote；TS 侧数组作者用逗号拼、RIS 整串成一个作者。
干跑：HER 检索步的 28 篇在临时目录跑 enrich → write → check 通过，4 篇已有全文按文件名认出。

七，**同一步只有一个终端标签**（用户实证：收件箱「去终端回答」新开了终端，标签名一会儿 lit-notes 一会儿「文献精读与笔记」）：
「继续 / 新开一轮」也带 `ws:` 复用键；工作区复用键进重启持久化白名单；最近那条还在外部跑时不 resume 更早的、带 `focusSession`
认回持有它的标签；复用键与会话 id 都对不上（Claude 接续换了新会话文件）时按工作树认正在跑 Agent 的标签；标签名统一步骤名。

八，**人工请求一步一份、只放没答的**（用户：「这个人工请求的作用在哪」——收件箱里全是检索步早答过的问题、一张表被拆成九条）：
`.ccode/help-wanted.md` 进 `.gitignore`（新项目模板；HER 当日补上并停止跟踪，已在临时克隆里试合并精读分支无冲突）；
任务书写明答完删、不写历史、不放表格；Mesa 只认条目行，已拍板 / 备查小节整节跳过。

### 2026-10-22 · 实时预览长回复不再重贴整屏：接法按位置对齐，读屏避开半帧

用户截图：Claude Code（经网关跑 gpt-6-luna）流式写一段一千五百多字的 Markdown，聊天层预览上下滑全是重复段落，第二节写到一半
接着又是第一节的后半段。复现：假网关按 6 字一块流出同一份回复（`E2E_LONG_FILE` / `E2E_LONG_CHUNK`），抓下终端原始输出
（`chat-capture.py CAP_RAW=1`），用真 xterm.js 逐块回放读屏（`live-replay.ts`）——旧接法重复 158 行（Kimi 1150、Gemini 1123）。

原因：回复长过一屏后屏上只剩续行，`mergeLiveReply` 要求「上一次结尾 = 屏顶开头」逐字相同才接；CLI 生成中会重画正在写的那一块
（列表项先画「-」再出字、「4.」后才跟内容、表格每多一格列宽和行都重排、「**加粗**」收尾前后两样），尾巴一变就判成对不上、整屏
接在后面，300ms 一次。定下：

一，**接法按位置对齐**：只比字母数字汉字（空行、表格边框、光有「-」的行不参与），在上一次里找屏顶第一行，连续对上两行以上
（或一直对到上一次结尾，末行可只写了半截）就从那儿起换成屏上这一截——屏上画的是最新的样子。对不上时屏上大半已有不接，大半是新的
才接（两次读之间滚过了一整屏）。三家回放重复都降到 0、不漏行。

二，**读屏避开半帧**：同步输出 `?2026h` 没收尾时不读（Claude 每帧都包，一帧常分两块到；逐块读约四成落在半帧上），50ms 后再看，
连等 20 次照读，免得 CLI 忘了收尾时预览不动。

同日回放还看出三处，用户「全部修复」，同日修：

三，**Gemini 完全访问认不出输入框**：输入框行首按状态换字（平时「>」、YOLO「*」、shell「!」、翻历史「(r:)」，0.65 InputPrompt），
原先只认「>」。连带三处跟着坏：预览整轮不出；`terminalHasInputBox` 为假，生成中「esc to cancel」被 `tui-panel` 认成开着面板
（YOLO 抓屏 40 帧里 31 帧），聊天层按代码会出「关闭面板」卡、按了是 Esc 取消这一轮；`promptIdle` 恒假。另跳过「YOLO Ctrl+Y」那行。

四，**表格和工具框分开认**：Gemini 工具框是圆角 ╭ ╰、表格是直角 ┌ ├ └，行首都是 │，原先一律当工具框，表格只剩边框。现按连续一段
框线里有没有「直角 + 横线」认表格（所有家通用；Codex 工具输出的「└ total 8」框角后不是横线，不算）。

五，**Grok 钉住提问时读成一截**：回显下面隔空行是「▲」= 回复开头卷上去了（`scrolledHint`），按 `anchored: false` 接；卷动的过渡帧
（回显还在、头两行已裁掉、「▲」还没画）看着像「看得见开头」，`mergeLiveReply` 在上一次的开头不在屏上、屏顶对得上上一次中段时
保留上一次的开头。为免把上一轮的开头补到这一轮，读屏记下回显，换了一条回显（在终端里直接发的下一句）就从头攒。

回放（`live-replay.ts`，五份抓屏）：Claude、Gemini（完全访问 / 请求批准）、Kimi、Grok 都是重复 0、漏 0，结构与原文逐行一致（差别只在
各家渲染：Gemini 代码行号、公式上标）。未验：Mesa Dev 窗口里实点一遍长回复。

### 2026-10-22 · 首装主题改琥珀 + 跟随系统；终端与聊天层配色对齐；聊天回答的字按长读调

用户问「第一次安装用哪个主题、默认主题要不要换搭配」，补充「有的主题在聊天层不适合长时间聊天」，看过对照稿
（`docs/design-theme-defaults-mockup.html`）后「全部按推荐改」。定下：

一，**首装 = 琥珀 + 跟随系统深浅**（原沉浸黑、不跟随）。沉浸黑同屏四种强调色（粉 CTA、靛蓝侧栏、琥珀发送块、珊瑚行内代码），
琥珀的 CTA 就是品牌琥珀光标，一种强调色。存过值的老设置不变；跟随开着时启动不强制窗口外观，避免系统浅色的机器首帧闪深色。

二，**深色终端底 = 画布底**（沉浸黑 `#0e1015`、灰蓝正红 `#111827` 两行改；editor-bg 同步）。浅色终端保留近白卡：跟灰画布同色时
Light+ 的绿 / 黄掉到 2.2:1。

三，**终端调色板默认「跟随主题」**：深色 One Dark、暮紫 Catppuccin、浅色 Light+；手动选过的照旧，设置页加「跟随主题」一格。

四，**沉浸黑侧栏选中色跟 CTA**（原靛蓝），十四套同口径。

五，**聊天回答的字按长读调**：加粗与小标题只往 l1 走六成（回答里加粗多，满格 l1 对画布 13–18:1，在 10:1 的正文里跳）；正文
落在 8.5–11.5:1、色偏收住——极简灰蓝（12.5→10.2）、暮紫（去一半蓝紫色偏）、暮紫·浅（7.1→9.0）、琥珀·浅（8.0→9.5）覆写。
只管 `.md-chat`，其余页面层级不动。

### 2026-10-22 · 用量口径：输入一律存「没命中缓存的部分」，对话 token 合计算上缓存

用户：「底部状态栏的 token 数是不是显示有误」。核对本机真实数据，两处错：

一，**状态栏合计漏了缓存**：只加「新输入 + 输出」。Claude 这类带缓存的长对话每轮把整段上下文从缓存读一遍，读缓存才是大头
（本机一段对话新输入 4 万、输出 54 万、读缓存 1.87 亿），显示五十多万、旁边的费用却按含缓存计价，对不上。改为合计 = 新输入 + 读缓存 +
写缓存 + 输出（`token-format.ts usageTotal`），悬停拆四项并说明读缓存为什么大、按一折计费；`session_usage` 多给 cacheRead / cacheWrite。
终端变体 ↑ 同样含缓存。

二，**Codex / Gemini / Qwen 入库口径错**：三家的输入数本就含缓存读（实机：Codex total_tokens = input + output，Qwen totalTokenCount =
prompt + candidates，Gemini total = input + output + thoughts），原样入库后缓存在费用里按全价再加一折、在合计里算两遍；Codex 的
output_tokens 已含 reasoning_output_tokens，又加了一遍。统一走 `usage::uncached_input`（Grok camelCase 原先已拆，并入同一个助手），
三处解析（usage.rs 用量索引、ai.rs 一次性调用记账、sessions.rs 会话列表 / 聊天消息用量）同口径。**规矩：各家入库的 input 一律是没命中缓存的输入，
含缓存的在解析处拆，新增一家先拿实机 total 核对字段关系。**

用量表 v8→v9 只重抽这三家能从会话文件重抽的行（有 seen 标记）及其 seen 标记，文件已不在的行与其它 agent 不动（用量历史永久保留）；v7 直升 v9 时
Grok 一并重抽。提交前在真实 app.db 副本上干跑（HOME 指向副本、会话目录只读链接）：Codex 1116 行一条不少，输入 44.6 亿 → 6.6 亿、输出 2241 万 → 1459 万，
另有两段旧索引重复入账的会话读缓存减半；其余 agent 不变。

### 2026-10-22 · 聊天画布、气泡、输入框三层配色统一

用户：「画布和输入框的颜色该如何设计」→ 看过对比稿（`docs/design-chat-color-mockup.html`）后「全部执行」。原来输入框借 raised、气泡借 bubble 75%，
这两样是给浮层 / 通用气泡、每套主题各调各的：深色七套里气泡比输入框还亮（默认深色 +12 对 +10），默认深色与 shadcn 的输入框像一整块砖；
浅色七套反而层级对（输入框白、气泡嵌入）。定下：新令牌 `--color-chat-bubble` / `--color-composer` / `--color-composer-edge` 由 canvas 与 l1 在 OKLab
按固定比例混出（深色 +3 / +5 / +9~10，浅色 −4 / 纯白 / −10），新主题不用再配；输入框顶部 1px 内高光（零阴影）；对话流底部渐隐进画布；
画布不动（牵连终端、侧栏全应用）；聚焦只提亮描边一档、不加彩色焦点环，琥珀只留给光标 / 发送块 / 思考滑块，警示色只留给完全访问那道线。

### 2026-10-22 · 聊天输入框与底部状态栏第二版：Mesa 自己的样子，状态栏去重

用户：「输入框可以做什么 UI 优化和功能……不要仿照他们（现在的权限界面就和 Codex 一样），要有 Mesa 自己的小巧思，偏 Claude 客户端的简洁」，
看过两版设计稿（`docs/design-chat-composer-mockup.html`）后：「开聊前底栏一句话太复杂」「权限符号不想和 Codex 一致」「思考滑块融进 Mesa 图标，
发送钮做成图标里的小方块」「状态栏去掉重复信息、同步设计」「全部做完」。定下：

一，**品牌元素只取 M▁**：琥珀光标（`--color-mesa-amber`，浅色主题深一档）用在三处——输入框插入符（`caret-color`）、发送钮（横向圆角块
`.ccode-send-block`：没字灰块 / 有字琥珀带余辉 / 回复中琥珀描边 + 实心方块、不闪 / 回复中又打字时旁边写「排队」并亮出发送块）、思考强度滑块的光标块。
发送钮不跟主题 CTA 色（品牌光标，与 M▁ 同色）。思考档用小 M 表示：中间那道 V 随档位加深（`effort-depth.ts` / `EffortMark`），默认档画灰 M，
滑块下一句白话说这一档意味着什么。

二，**权限符号「界线」**（用户选 A，否决沿用 Codex 的眼睛 / 手掌 / 盾牌）：竖线 = 要你点头的那条线，小方块 = Mesa 的光标；空心块停线外 = 只讨论，
实心块抵线 = 请求批准，线剩上半截、块从下面过 = 帮我批准，线没了、块走远 = 完全访问（caution 色）。菜单不再是「图标 + 标题 + 说明 + 勾」：
拿一件具体的事说明四档（示例按项目类型取，`chat-permission.ts`），选中整行铺 seg 底；开聊前输入框里 ⇧Tab 轮换（跳过没有的档，完全访问照旧二次确认）。
权限写在输入框本身上：完全访问上沿一道 caution 细线，只讨论虚线框，其余档不加东西。同日用户追加：完全访问的细线常驻太花，改为只在**切到**这一档时亮约 2.4 秒后淡掉（挂载时已是完全访问不亮），常驻提醒交给权限芯片的琥珀字；只讨论虚线框照旧常驻。

三，**开聊前回到三颗芯片**（项目 · 权限 · 模型；第一版「一句话底栏」用户否决）。只有项目芯片带小箭头。项目弹层与另外两个同一族：能搜、按项目类型给图标、
编程项目写当前分支、写项目默认 Agent；选了已添加项目且这个标签没手动换过 Agent / 连接 / 搭配，按项目「＋ 新对话」同一条塔带上用谁
（chat 槽 > 项目默认，`projectChatLaunch`），输入框上闪「按项目默认」。终端空态卡的目录菜单走同一个入口（`pickDir`）。开聊前把文件夹拖到聊天面板 = 在那里聊。

四，**模型菜单先给搭配**：从聊天层开聊时按工作目录记一整套（Agent + 连接 + 模型 + 思考档，`launch-combos.ts`，本机 localStorage、只存 id，最多 3 套），
菜单顶上「最近在某项目用过」一点四样一起换；和当前一样的、连接已删的不列。输入框里有图时，能力库确知看不了图的模型标「看不了图」，
当前模型看不了时附件下面说一句；查不到的不标。芯片最前是**品牌色 M**（Mesa 标志的 M 染成这家 Agent 的品牌色，形状固定，同日用户修订：圆点换成品牌色 M、M 只代表哪家 Agent，模型与思考档照写文字），芯片不再写 Agent 名；模型菜单里 Agent 行与「最近用过」各行同用这个 M。

五，**输入框**：开聊后一行起（空态居中仍两行）；↑ / ↓ 在自己发过的话里一路翻（`userTextHistory`），翻出来的那条改过就回到移动光标。

六，**底部状态栏（聊天变体）去重重排**：输入框管「这一句怎么发」，状态栏管「这段活落在哪、花了多少」，两边不重复字段。去掉状态圆点（对话末尾的
M▁ 那一行与「AI 已停下」已说）、Agent 名（看芯片圆点）、目录胶囊（开聊前项目芯片选、开聊后不能换）、运行时长（每一轮用时在生成那一行）、
「换模请重开」（模型菜单已写）。分支与改动加强：是 git 仓库就常驻（干净写「无改动」）、不铺胶囊不用等宽字不用绿色渐变、只 +/− 带增删色、点开改动面板；
「提交…」与终端变体同一套流程同一道门（Agent 在跑不给提交），旁边小齿轮进提交设置；右边「经 某连接」+ token 总数（中文万 / 亿，`token-format.ts`）与费用，
悬停分输入 / 输出。不是 git 仓库只写项目名 / 随手聊。终端变体布局不动，提交流程的英文文案全部改中文（「提交并推送」「生成提交信息…」「已推送」「只预览」）。

### 2026-10-22 · Mac 终端默认改走 WebGL

用户看过上一条的复测结论后拍板：「Mac 自动档改走 WebGL，设置页『终端渲染』的选项文案和使用说明一起改」。取代 2026-09-19 的
「Mac 默认 DOM、只有 Gemini 例外」。定下：

一，**自动档两个平台都走 WebGL**：`wantsWebglRenderer` 只看设置，不再看平台和 agent；按 agent 加载 / 卸下 WebGL 的那套随之删掉，
上下文丢失退回 DOM 时补上重挂滚动按行挪位（原先只有卸下路径会挂）。软件渲染探针与 ≤3 次重试照旧。

二，**设置只留两档**：「自动（WebGL）」与「兼容（DOM）」。原「流畅（WebGL）」与自动行为完全相同（同一探针、同一回退），留着只会让人
以为两者有别，故收掉；旧设置里的 `webgl` 显示成自动、后端闭集照收，`dom` 显示成兼容。「清晰」一词不再用——复测下 WebGL 不比 DOM 糊。

三，**说明书 §13.2 同步**：写清两档各自的样子（显卡绘制、框线连成片 / 网页排版、带连写、框线留缝）和何时选兼容，并告诉老用户旧选项
对应到哪一档。未验：Mesa Dev 窗口里实机看字与框线（Mac Retina 与外接屏）、Windows。

### 2026-10-22 · 聊天层生成中再发一句：排队与立即发送照各家终端的真实行为

用户：「对话没结束的时候，发送消息排队以及立即发送这一块，需要和终端联动吧」。原口径（2026-10-18）是「发出即写进终端、由 CLI 排队，气泡一律写
『排队中 · 这一轮结束后处理』」——逐家实测后这句话对一半的家是错的。定下：

一，**照实写**：本机假网关逐家实测（`chat-capture.py` 新增 `QUEUE_*` 一幕，看那句落在哪个请求里），结论写成 `mid-turn-send.ts` 一张表与 matrix §14 一节。
Claude / Codex / CodeBuddy / Qwen / OpenCode 是「下一步时交给它」（做完手头这一步就插进这一轮），Gemini / Kimi / Grok 是「这一轮结束后处理」。
Mesa 仍不另设队列、仍不做撤回（撤回在终端里 ↑ 拿回来改）。

二，**立即发送 = 按这家终端里提示的那个键**：Claude / Codex / CodeBuddy / Gemini 按 Esc（打断手头这一步并马上发），Grok 输入框空着再按回车（不打断），
Kimi 按 Ctrl+S（插进这一轮，按钮写「插进这一轮」不写「立即」）；Qwen（Esc 会丢掉排着的那句）、OpenCode（未核实）、Cursor 不给。
入口在最后一条排着的气泡旁。

三，**Claude 插进这一轮的话补进解析**：它不记 user 行，记 `attachment/queued_command`（`origin.kind: human`）；原先聊天层与回放里这句话直接消失
（本机历史里 67 条）。只认用户自己发的，后台任务通知与别的会话发来的不算。

### 2026-10-21 · 终端性能第二批：聊天层盖住停画、输出走通道加流控、WebGL 单元格宽就近取整

用户：「之前提到的优化都做；现在有聊天层作为显示，终端画面是否更应该高性能优化了」。聊天层成了主显示后，xterm 多数时间
被盖住，但它不能停——聊天层读屏（信任菜单、实时回复、连接错误、模型读回）都读它的缓冲。所以方向是**照常解析、看不见就不画**，
看得见时用更快的渲染。定下：

一，**聊天层盖住时停画**：xterm 宿主加 `content-visibility: hidden`，xterm 的可见性观察判为不可见、停画，揭开整屏重画一次。
WKWebView 实测盖住期间 20 次写入：`visibility: hidden` 照画 19 帧，content-visibility 0 帧，揭开后内容一致（DOM / WebGL 同）。

二，**输出走 Channel + 流控**：替掉 `pty-output-<id>` 事件。≥8KB 的帧发原始字节（Tauri fetch 取回，不转义不拼脚本），更小的仍是
JSON 字符串；前端每画完 5000 字确认一次，后端未确认超 10 万字停读 PTY（VS Code 同参数），刷屏时 Ctrl+C 立刻见效；停读 5 秒无确认
视为前端失联、放行。用一个最小 Tauri 应用实测过通道四种帧（小 JSON、<1KB 原始字节、≥8KB 原始字节走 fetch、尾帧）按序到达，
解码后长度与 Rust `encode_utf16` 计数一致。

三，**WebGL「发软」复测**：同字体同字号逐像素量锐度，DOM 与 WebGL 持平（细节见 terminal.md「终端渲染器」），
2026-09 的结论在 xterm 6 下已不成立；真正的差别是 addon-webgl 把单元格宽向下取整（Retina 窄 3.8%，1 倍屏窄 10%），改成就近取整。
DOM 渲染器反而在框线与半格方块上断线留缝。**Mac 自动档是否改走 WebGL 交用户拍板**，拍板前默认不动。
复测脚手架：Swift 起 WKWebView（关掉窗口遮挡检测才有 rAF）跑测试页、截图，再按像素算半调占比与梯度/墨迹。
未验：Mesa Dev 窗口里实机点验（刷屏 Ctrl+C、聊天 / 终端来回切、外接屏、Windows）。

### 2026-10-21 · 聊天正文排版：对照 Claude / Codex 客户端，只管已落盘内容怎么排

用户：「借鉴 Claude 客户端以及 Codex 客户端的聊天层 UI 和文字布局显示……交互方面有另一个对话正在优化，你不要和他做重复」→ 看过十四项方案后「全部都做」。
与同日「生成中那一行」分工：那边管这一轮在动时怎么呈现（状态行、光带、光标、过程行进行中、审批卡），这里只管落盘后的正文、版式与科研内容。定下：

一，**AI 回复不截断**：原先超过 4000 字先切成纯文本原文、要点「展开全部」才排版，作废；一律按 Markdown 排。用户自己的长消息改为量行收起（约 12 行、底部渐隐）。

二，**聊天字号阶梯**：聊天里一切字按正文字号（`--ccode-chat-fs`，默认 Mac 13.5 / Windows 14）取比例——回答 / 气泡 / 预览 1、过程 0.94、过程里的代码 0.86。
起因：Mac 根字号 14px 下 `text-sm` 只有 12.25px，用户气泡与回答同屏两种字号，过程行与代码不跟设置走。聊天里不再用 text-sm / text-xs 写正文与过程。
顺带修 Windows：`.md-body` 的 Windows 块把字体写死 Segoe 且选择器更具体，聊天字体设置在 Windows 上从未生效。

三，**栏宽按字数**：聊天字号 × 52（回答一行约 52 字），对话流、输入框、状态栏、对话页回放同一类，字号调大栏跟着变宽；不再固定 max-w-4xl。

四，**节奏与层级**：新问题前留大空、一轮之内收紧；做完的一轮里中途说明降一级（还在写时不降，那时它可能就是回答）；长回复分节小标题照 Markdown 级别渲染（原 button 被 `font: inherit` 吞成正文样）。

五，**中文排版**：text-autospace / text-wrap: pretty / line-break: strict，本机 WKWebView 实测支持，WebView2 同；不开 hanging-punctuation。这是与两家英文优先客户端拉开差距的一处。

六，**科研内容**：公式（聊天另认 `\( \)` / `\[ \]`，笔记不开以免改变已有笔记）、代码高亮（highlight.js 按需加载，只认写明的语言，配色复用聊天强调色，新增依赖已 gen:notices）、
表格横滚壳与数字列右对齐、`[@key]` 引用胶囊（新命令 `cite_lookup`，与引用健康检查同白名单，只读 bib）。

七，**文件路径就地可点**：正文与行内代码里的路径经新命令 `existing_files` 核实在会话目录内才变链接，点开预览；回复末尾文件胶囊行删除（同一路径出现两次）。
原胶囊点开走右侧改动面板，改为预览——与同一回复里 Markdown 本地链接的行为一致；看改动仍走过程行「在改动里查看」。

规格见 `docs/conventions/design-system.md`「聊天正文排版」，使用说明见 user-guide §8.1「读回复：公式、表格、引用和文件」。

### 2026-10-21 · 聊天层生成中那一行：说在做的事，不说程序阶段

用户：「借鉴 Claude 客户端以及 Codex 客户端的聊天层 UI 和显示交互……现在的『正在生成回复』『正在用』太机械了」→ 看过方案后「全部做，也要注意 Windows 的显示」。定下：

一，**状态说这一轮在做的事**（`chat-status.ts`）：正在跑的工具用过程行同一套动词 + 对象（「运行 npm test」「编辑 store.ts」「调用 blender · get_scene_info」），
不露工具原名；没有工具时说思考的小标题（Codex 推理摘要 `**小标题**`，别家取第一句）、计划里进行中的一项（Claude 的 activeForm），都没有写「思考中」；
刚发出 1.5 秒内只亮 M▁ 光标。「已送出 / 正在生成回复 / 正在用 X」三段式作废（「正在生成回复」实为在等会话文件，词不达意）。

二，**同一件事只说一次**：过程里已经有那一行在跑时，状态行不再重复（只留光标，或说计划里那一项）；那一行自己不再写「进行中…」，改为动词与对象共用一道光带，
等你决定时写「等你决定」。实时预览在出字时不另起状态行，Mesa 光标（`MesaCaret`）接在最后一个字后面。时间满 10 秒才写，「看实时输出」安静满 10 秒才给。

三，**取数**：旁路快照新增 `activity`（正在跑的工具，按开始 / 结束登记，开始写正文或一轮结束清空；参数截断并逐个脱敏）与 `thinking`
（Codex `item/reasoning/summaryTextDelta`，没摘要时用原始推理兜底；Qwen `thinking_delta`；OpenCode reasoning part）。没有旁路的家照会话文件推断，慢几秒但说法一样。
出站快照的实时文字与思考在 Rust 层脱敏（原先实时文字未脱敏，顺带补上）。假网关加 `TRIGGER_THINK`，Codex / Qwen / OpenCode / Claude Code 四家 e2e_channel 逐家核过。

四，**Windows**：光带用 background-clip:text（WebView2 与 WKWebView 都支持，WebKit 带前缀）；减弱动态效果与 Windows 高对比度（forced-colors）下不扫光、
退回各段字色（否则透明字整行消失）；Codex 在 Windows 上命令外面套的 PowerShell 外壳显示时剥掉；路径按 Windows 方言相对化；Windows 上 Claude 后台 hooks
结束先于开始到达时不误判在跑。不学 Claude Code 随机换的俏皮动词（语气要专业）。未验：Mesa Dev 窗口里实机点验（Mac / Windows），交给用户。

### 2026-10-21 · 终端性能：会等待的命令挪出主线程

用户问「Mesa 用的是伪终端，终端性能是不是被这个方式定了上限」。结论：PTY 不是上限——原生终端同样从 PTY 读，本机实测 macOS
单个 PTY 约 49 MB/s，agent 界面每秒只出几 KB 到几十 KB。上限在 PTY 之后：Rust 读线程 → 16ms 合帧 → Tauri 事件（JSON 拼进
一段脚本在网页里执行，要排主线程的队）→ 网页主线程上的 xterm.js 解析与渲染，天花板约在 VS Code 内置终端一档。查出四处差距，
用户让先做第一处：

一，**会等待的命令挪出主线程**。不带 `async` 的 Tauri 命令在主线程上执行；`pty_spawn` 起 Codex 标签要等 app-server 就绪（最长
4 秒）、`pty_kill` 要等子进程退出（最长 2 秒）并可能冻结评审快照，这期间所有标签的输出和按键都停住。改为 `async` +
`spawn_blocking`，同批挪出外部终端三命令（等 osascript / open，首次控制终端应用还会等授权框）、`run_close`（冻结快照）、
`delete_schedule`（Finder 回收站）、`schedule_run_delete`、`adopt_watch_run`。三种拉起之间用 `SPAWN_LOCK` 保持原来的逐个进行；
挪出后命令不再按调用顺序串行，停止后要按同一 Run 重拉的调用方必须 await `pty_kill`。规则写进 AGENTS.md 与 terminal.md。
排查中另见粘贴图片按 JSON 数字数组走 IPC（5MB 截图编出 18.7MB JSON，网页与 Rust 主线程各编解一遍），改为请求体原样传字节、
扩展名放请求头（`saveClipboardImage`），同样后台落盘。

二，**其余三处另行处理**：没有流控（刷屏时 Ctrl+C 要等写入队列消化完，已开单独任务，按 VS Code 的确认机制做）；Mac 默认 DOM
渲染器（清晰度拍板不改，值得做的是查 WebGL 在 WKWebView 里发软的根因）；事件走 JSON + 脚本执行（改 Channel 二进制，刷屏时才有
明显收益，优先级最低）。**不做原生终端视图**（嵌 libghostty 一类）：信任菜单 / 终端菜单 / 实时回复 / 连接错误 / 模型读回 / 回放 /
搜索 / 选中引用都直接读 xterm.js 的屏幕内容，换掉要全部改成从 Rust 读屏，分屏与浮层叠放要重做，三平台各写一套渲染。

### 2026-10-21 · 从手机添加：已配对的手机随时能发，Mesa 收到自动弹窗

用户：「现在必须在 Mesa 打开页面手机才可以传，能否手机直接传，然后 Mesa 打开弹窗」。这推翻了当日上一条「不做 Mesa 开着就自动接收」
（那条写明需另行拍板，这就是拍板）。定下：

一，**常驻等候**：配对过手机且开着「随时接收」（缺省开）时，Mesa 一启动就在固定端口上等，**只认已配对手机的设备地址**，扫码配对路由
关着（配新手机仍要人点开始、出二维码）；不因空闲停；每 20 秒看一次网卡，换了 Wi-Fi 就换绑。主动接收（人点开始）结束或被停止时，
该等候就自动转回常驻等候。Mesa 退出即停——不做 Mesa 关着也能收（那需要独立后台进程，§11.5 daemon 化仍不做）。

二，**收到即弹窗**：不是往某个输入框送的东西（手机直接发来的）一到，Mesa 弹出「从手机添加」的「收到的」列表；窗口不在前面时再发
一条系统通知（跟「长任务 OS 通知」开关，不新增设置项）。从输入框点过「从手机添加」的那段时间照旧直接成附件卡、不弹窗。

三，**能关**：弹窗状态卡里的「Mesa 开着就随时接收」关掉即回到「人点了才收」，没有任何常开监听；手机全移除也一样。
合计上限改按 24 小时窗口算（常驻一开就是几天）。安全口径更新在 safety.md「从手机添加」①⑥。

### 2026-10-21 · 对话正文搜索：全文索引、命中定位、搜索语法

用户：「这个会话搜索这块如何做完善……全部做」。起因是搜「回复超 1500 字」整个搜索失败（小写换算错位崩溃，已单独修）。定下：

一，**全文索引，不再截 96KB**。旧版每条对话只存前 96KB 文字、每次搜索把整表读进内存比对；本机 27 条长对话后半段搜不到。
改为 app.db `session_search_doc`（用户说的 / AI 回复分两列，脱敏后存，单列封顶 4MB 防归档撑库）+ FTS5 trigram 索引。
用 `detail=column`：本机 1855 条对话正文 23MB，索引 27MB（detail=full 要 59MB）；代价是不支持多三元组短语，长词拆成三元组
AND 查询，可能多召回，按原文逐个核对。一两个字的词 trigram 用不上，退回 LIKE（在 SQLite 里扫，不进内存）。
实测召回与暴力扫描逐词一致，候选查询 3–25ms。

二，**索引建不完交后台，结果如实报缺口**。搜索时顺手补 0.8 秒，剩下的交后台线程一次做完（全量约 10 秒），
结果带 `pending`，前端写「还有 N 条对话在建索引，结果会自动补全」并隔 2.5 秒重搜，不再悄悄少结果。

三，**单字不驱动命中**。查询里有两字以上的词时，单个字只参与打分，不单独把对话拉进结果（「回复超 1500 字」从 796 条降到
几十条）；整句只有单字时照常。

四，**命中定位打开时现算，一处不漏**。旧版每次搜索给前 80 条结果逐个解析文件找「第一处任一词」（搜索要 0.5–1.2 秒，
跳过去常常是开头一个无关的「字」）。改为搜索只回摘录（实测 60–230ms），点开结果时 `locate_session_matches`
解析这一条对话，列出全部命中消息（按先后，上限 300），按「整句原样 > 驱动词种数 > 最早」选最该先看的那处；回放上方
「上一处 / 下一处」按各处的 `around` 重新取页。摘录与跳转同一套锚点规则。该命令只读 Mesa 已列出的对话文件。

五，**搜索语法**。`"整句"` / `“整句”` / `「整句」` 必须原样出现；`agent:`（`来自:`）按 agent id 前缀筛；`role:`（`角色:`）
只搜用户说的或 AI 回复——走索引的分列，且标题命中不算；`after:` / `before:`（`从:` / `到:`）按对话更新日期（本地时区，
可写到年/月/日）。认不出的 `x:y` 原样当普通词，不吞字。后端 `parse_query` 与前端 `parseSearchQuery` 双端镜像，
测试用同一组样例钉住；认出的筛选在搜索框下写成人话，让人知道生效了。agent / 日期与列表上方已有的快筛、范围条并存，
语法是给只用键盘的人的捷径，不替代那些控件。

### 2026-10-21 · Claude 接续文件按文件名认会话：直线接续合并成一条，真分叉单列标「分支」

用户问对话搜索里为什么出现同名的两条，是重复还是分叉。实查本机：Claude 桌面版在旧对话上「继续」会新建文件，开头原样复制上游
全部历史（行里 sessionId 仍是上游 id），Mesa 拿文件里第一个 sessionId 当 id，于是新旧两份文件被认成同一条：同标题两行，
在新那行点 **继续** 接的是旧文件（最新进展丢失），整理数据两行联动，用量按同一 id 互相覆盖。本机三组：两组是直线接续
（`0c9e97d4→4bdadf35`、`1d7dfe92→86c0922c→1c8a15f1`），一组是真分叉（`efaf0c1e→8ff62499`，上游分开后又写了 2942 行）。定下：

一，**Claude 会话 id 取文件名**（uuid 形态时；非 uuid 文件名仍取内容 id）。开头复制来的上游 id 只记作接续来源；直接上游取第一条自身行之前
最后出现的别的 id（链式接续不是最早那条）。分叉点 = 第一条自身行的时间，只做字节查找，不解析上游部分。

二，**直线接续合并、真分叉单列**。上游最后一个带时间戳的行早于分叉点 = 直线接续，与 Codex/Grok 链同口径合并成一条，
代表取链尾（「继续」必须接它），标「N 次继续」；上游分开后还在写，或同一点被接续第二次 = 真分叉，两条各自列出，
分出去的那条 `forked_from` 指向上游所在行、标题改用分开后第一句，列表标「分支」，回放头可点回原对话。不合并分叉：
合并会藏掉另一边独有的内容。

三，**用量逐文件只算本文件 id 的行**。被并掉的链成员不进列表但进 `ScanResult.hidden_members`，用量重建照样逐个过；
复制来的历史行不再重复记账。已有用量行靠 seen 标记的时间戳差异自然重抽，不改表版本。删除代表连带成员文件（与 Codex/Grok 同）。
扫描落盘缓存版本升到 2（新增 claude 一栏，接续关系存 parent 列）。

### 2026-10-21 · 从手机添加二期：记住这台手机（扫码配对一次，手机主屏直接发）

用户：「记住这台手机……先做这个，感觉最常用」。一期每次开始接收都要重新扫码。定下：

一，**扫码即配对**。扫码地址 `/p/<本次配对令牌>/` 一打开就向电脑要一个长期设备令牌，手机页跳到 `/d/<设备令牌>/`，提示加到主屏幕；
同一台手机再扫会先认出自己存过的设备地址，不重复配对。名字按浏览器标识起（iPhone / 安卓手机，重名加序号），最多 8 台。

二，**令牌只存哈希、可移除**。配对簿 `<配置根>/phone-devices.json` 只存 SHA-256；弹窗「已配对的手机」可移除，移除即失效。
「人点了才收」不放宽：已配对的手机也只在 Mesa 开始接收时连得上；没在接收时手机页说明原因，排着的东西连上后自动补发
（页面要开着）。不做「Mesa 开着就自动接收」——那会把「人点了才收」变成常开，需另行拍板。

三，**地址要稳**：端口第一次选定后固定（被占就这次临时换并提示）；主机用电脑的 mDNS 名（`xxx.local`），换了 Wi-Fi、IP 变了主屏网页
照样连得上。macOS 默认电脑名（Bonjour 常驻广播）；Windows / Linux 手机能否解析待实测，默认 IP、电脑名作可选项。为此改为在
所有局域网网卡上同端口监听（仍不绑 0.0.0.0），Host 校验认「绑定 IP:端口 / 电脑名:端口」。

四，**有已配对手机时少点一步**：聊天输入框「+ → 从手机添加」直接开始接收、不弹窗，输入框上方那一行写「iPhone 已连上 · 已收 N」，
「展开」可扫码配新手机或管理已配对的。⌘K 入口照旧弹窗。

安全口径更新在 safety.md「从手机添加」；规格见 `docs/design-phone-drop.md` §9。未做真机（手机）与 Mesa Dev 实机界面验收。

### 2026-10-20 · 从手机添加：手机往桌面单向投递，Mesa 开着才收；§11.5「手机同步」收窄

用户要「手机上发消息、传文件，直接显示在 Mesa 上」。§11.5 自 v3.8 起把「手机同步」列为不做（贬值层）。当时否决的是
双向同步与后台常驻，本次需求是单向投递，范围小得多，收窄后放行（用户 2026-10-20「按你推荐 执行吧」）。定下：

一，**定位是采集口，不是手机版 Mesa**。手机只把东西送进来：拍照、照片或文件、写一句话。看会话、批准操作、启动 agent、
看 diff、采纳一律不在手机上做——拍板留在桌面。

二，**单向、Mesa 开着才收**。人在 Mesa 里点「从手机添加」才开始监听；点停止、30 分钟没有收到新东西、Mesa 退出，任一发生
即停。不做后台常驻、双向同步、云中转。

三，**一期只走局域网**。`phone_drop.rs` 在本机起一个只收不出的小服务（`tiny_http`，不手写 HTTP 解析），手机扫码打开网页上传，
手机上不装东西；数据不出本机所在网络，我方零基础设施。网络禁止设备互访（校园网、公司网常见）时，绕法是电脑连手机热点。
飞书机器人等第二条通道，等隔离网络的反馈再定，并与 Backlog「评审请求外推微信 / 飞书 / 邮件」合成一个「消息通道」批次拍板。
安卓系统分享菜单直接投递要装成 PWA、PWA 要 HTTPS，局域网 HTTP 做不到，不列候选。

四，**先暂存，人点了才进项目**。手机来的文件先落 `<配置根>/phone-inbox/`，不直接写项目：项目根多出未跟踪文件会挡工作区合并
（`review_contract` 闸门），放哪也该人点一下。进项目只走已有入口——PDF 走浏览器扩展同一条入库链进 `papers/`（字节去重、
资源登记相位感知），图片进 `notes/assets/`（与沉浸阅读截图共用 `reader::write_notes_asset`），文字进 `notes/clips.md`
（新建时文件头由「终端摘记」改为通用的「摘记」，已有文件不改写）；编程项目不放（同「存进笔记」口径）；其他文件只给「另存为」。
PDF 一期不写积累账（一行要题录，从 PDF 里拿不可靠），之后在文献卡里照常加入积累。

五，**从对话输入框打开时，收到的东西直接变成这个输入框的附件卡或文字，不自动发送**；弹层可以收起，输入框上方留一行
「手机接收中 · 已收 N · 展开 · 停止」。从 ⌘K 打开的进「收到的」列表逐条处理，关弹层即停止；关着弹层还有没处理的，收件箱出
新类别「手机」（`phone:`，通报类，可全部已读）。

安全口径进 safety.md「从手机添加」。规格与真机点验清单见 `docs/design-phone-drop.md`。未做真机（手机）与 Mesa Dev 实机界面验收。

### 2026-10-21 · 英文综述 Windows 全流程核验（用户：「核验一下……各项操作有什么问题」→「全部修」）

在 Windows 11 + Quarto 1.10.19 + TinyTeX 上用真实 run 命令与随包脚本干跑一遍（临时项目，界面没点）。查出四处，全部修，**规则如下**：

一，**`quarto render` 的产物落点（影响全部带渲染的模板）**。没有 `_quarto.yml` 时 Quarto 把稿件所在目录当项目根，`--output-dir` 相对它解析：
旧写法 `--output-dir output` 落进 `manuscript/output/`，且先 docx 后 PDF 时后一次渲染清掉前一次，评审只认根 `output/` → docx 缺。与 `--output` 同用时成品还会落到工作区根。
定下：稿件都在一级目录（`manuscript/`、`submission/`），命令统一 `--output-dir ../output`、**不带 `--output`**（默认文件名本就是稿件同名）；项目根不放 `_quarto.yml`
（`../output` 会越出项目），要配置放 `manuscript/_quarto.yml`。`tests/pipeline-presets.test.ts` 钉住所有模板（含返修轮次变体）。
存量项目的步骤定义存在各自 `.ccode/project.toml`，**不随模板自动更新**：本机两个项目（HER催化综述、Ccode 示例课题）已手工改完并用 TOML 解析验证；
以后再改 run 命令，同样要处理存量 `project.toml`（开步只按项目里存的 `step.run` 写 settings，不回读模板）。

二，**PDF 文本层分号变 U+037E**（2026-10-11 审计已见、当时只定「记录不放行」）。Times New Roman 字形同挂 U+003B / U+037E，xdvipdfmx 的 ToUnicode 选了后者，复制/检索/查重全坏。
定下：`manuscript_font.py` 在 PDF 的 `include-in-header` 写 `\ifdefined\XeTeXgenerateactualtext\XeTeXgenerateactualtext=1\fi`（`\ifdefined` 守卫，换 lualatex 不报错；旧稿重跑补行、重复跑不叠）；
随包 `check_pdf_text.py`（PyMuPDF，不依赖 pdftotext——普通 Windows 没有）渲完抽检 U+037E / U+FFFD / U+FFFF / 私有区，退出码 1 即按渲染缺陷处理。实测同一份稿：无开关 4 处 U+037E，有开关 0。

三，**两份域稿 docx 的中文字体写死 `Songti SC`**（macOS 字体，Windows 的 Word 里悄悄换字体）。定下：`cite_docx.py`（`zotero_docx.py` 复用）读 `manuscript/typeface.md`，
稿在 `submission/` 下也找同级 `manuscript/`；没有这份文件才回落（macOS Songti SC，其余宋体）。域稿与阅读稿字体一致，不再各写各的。

四，**Agent 起的 Python 在 Windows 上按 GBK 输出**：管道里打印 `²` `⁺` 直接 UnicodeEncodeError，Agent 读回的中文也乱码。此前只有 Mesa 自己起的 Python（endnote.rs / research_quality.rs）带编码变量。
定下：`process::agent_python_io_env()`——Windows 且用户没自设时给 **PTY 子进程**（`pty_command`，含 Agent、shell、run 脚本标签）和**无头 Agent 运行**（`ai.rs`）补 `PYTHONIOENCODING=utf-8`。
**不设 `PYTHONUTF8`**：它连 `open()` 默认编码一起改，会让 Agent 写的、读 GBK 数据文件的脚本变样。控制台（ConPTY）里的 Python 本就走 UTF-8，不受影响。

顺带：首次渲 PDF 会现装 `xecjk` 等宏包（实测约 2.5 分钟、无进度），写进 quarto-render 技能与说明书，避免被当成卡死。
**未验证、留给下一轮**：①本机 Codex 配的是 `elevated` 沙箱，而 TinyTeX 装在 `%APPDATA%`（用户目录）——同「Codex 沙箱读不了用户目录里的工具」那条，Codex 渲 PDF 很可能失败（含 tlmgr 现装宏包），
需真实 Codex 跑一次确认，对策方向同 Python（全机安装或 unelevated）；②Mesa 界面里的整条流程、Word 里真点 EndNote Update / Zotero Refresh、Consensus / Undermind 检索工具都没验。

### 2026-10-21 · Codex 计划工具随提示词打开；端到端计划补上启动前追加参数

用户实测 Codex（glm-5.3-flash）两句：「当前会话没有暴露任务清单/计划工具」「提问工具当前不可用」。查明：一，Codex 0.163 默认不发 `update_plan`
（官方 gpt-5.5 也不发，改走 goals），但 Mesa 经 catalog 给的 base_instructions——即 Codex 给未登记模型的默认提示词——仍写「你有 `update_plan` 工具」，
提示词与工具对不上。定下：提示词里提到 update_plan、Codex ≥ 0.163、用户 config.toml 没配 `[tools.update_plan]` 时，`prepare_launch` 加
`-c tools.update_plan.enabled=true`（`agents::codex_plan_tool_args`）；聊天层本就认 update_plan 画计划卡。与 Claude 那条（非 Claude 模型开任务清单工具）
同理：对上 CLI 自己给的说明，不替官方模型改判断。二，`request_user_input` 照发但只在 Plan 模式可用（Default 模式调用即返回不可用），
是 Codex 的设计、开关还在开发中，不动。三，**端到端计划此前漏了 `prepare_launch` 追加的参数**（Codex 的 catalog、--no-daemon），
`e2e_dump_launch_plans` 改为照 pty.rs 接上（并按本机真实 Codex 版本拼），金丝雀因此首次核对到 catalog 提示词；drive.py 的 `codex exec` 去掉 --no-daemon。
金丝雀按流程走了一遍：报「工具清单多了 update_plan、上下文多了 Planning / Windows 小标题、请求多了 text 字段」，旁路端到端照过，记成新基线。

### 2026-10-21 · CLI 金丝雀：Claude Code / Codex 每天装最新版自动核对

起因：同一天两次撞上 Claude Code 新版悄悄改默认行为（对第三方模型藏工具搜索、不发任务清单工具），都是用户先撞见。用户问各家 CLI 一天一版
Mesa 怎么跟，拍板先做 Claude Code 与 Codex 两家。定下：
一，**不追求当天全适配，追求当天知道**：`scripts/cli-canary/canary.py` 把已有的假网关、`chat_channel` 端到端、聊天层抓屏串成一条，
抽五层指纹——主对话请求（工具清单、系统提示词小标题、用户这句前注入的上下文标签、请求字段、`anthropic-beta` 等头）、旁路（会话认出、回合状态序列、
审批形态）、会话文件（记录类型与字段）及 Mesa 解析器读出的工具来回、读屏（审批菜单、实时预览）、Codex 默认提示词可取——和
`scripts/cli-canary/baseline/<平台>/<agent>.json` 比；报告附两版之间更新日志里沾边的条目（Claude 取 GitHub CHANGELOG / 本机缓存，Codex 取 Releases）。
二，**临时 HOME 不拷本机配置**（`E2E_CLEAN_HOME` / `CLEAN_HOME`，只预置 Claude「已走完首次引导」、Codex 的 CODEX_HOME 目录）：用户自己的 MCP / 插件
会改工具清单，拷了就没法跨机器、跨 CI 比；「用户全局配置盖不盖 Mesa 注入」仍归 e2e-model-routing。基线按平台分存（两边画面本就不同）。
三，**CI 每天跑、不挡主线**：`.github/workflows/cli-canary.yml` 北京时间 9:17 在 macOS / Windows 装 `@latest` 跑，报告进运行摘要、明细进 artifact；
红了是 CLI 变了。适配后（或判定无需适配）在同一平台 `--accept` 把新指纹随改动一起提交，基线的 `version` 即「Mesa 已核对到的版本」，
取代散落在 matrix 各处的「x.y 实测」。检查没全过时 `--accept` 拒绝。
四，不替用户锁 CLI 版本（自动更新是用户的选择，锁住收不到修复）；运行时遇到未知会话记录 / 工具名留诊断记录、各家更新日志关键词监看，留作后续。
首跑（Windows，Claude Code 2.1.306 / Codex 0.163.0）两家检查全过并建了 win32 基线；连跑两次除临时目录名外无变化（已归一成 `<工作目录>`），
人为从基线去掉 TaskCreate 后报告准确报出「工具清单多了 TaskCreate」。darwin 基线待在 Mac 上跑一次 `--accept`。

### 2026-10-21 · Claude 被拒绝 / 打断后回合靠会话文件收；Windows 上 Claude 回复不流式是 CLI 自己的画法

用户报两件。一，**终端已结束、聊天层仍「正在回复」**：在审批菜单里拒绝工具（或按 Esc）时 Claude 写一行 user
「[Request interrupted by user for tool use]」和 system/turn_duration 就结束这一轮，**不触发 Stop hook**（用户会话实证：正常一轮有
stop_hook_summary，被拒那轮没有），旁路回合一直开着、又压过会话尾部的推断。定下：会话尾部判成收尾时前端调
`chat_channel_settle_from_transcript`，后端只认这一轮开始之后的打断标记 / turn_duration（`sessions::claude_turn_end_after`），
按 interrupted 收掉；三平台同。（同日补：非 Claude 模型关工具搜索见本条三；Claude 中途弹「Enter to continue · Esc to cancel」的通知——经第三方网关时 auto mode 分类器计费说明——原先被认成面板、聊天层只给按 Esc（=取消），改为 `tui-panel.ts parseTuiNotice` 认出、给「继续」（回车）卡。）二，**Claude 的回复不是流式出来的**：不是模型也不是网关——直连智谱 Anthropic 端点 glm-5.3-flash 流式，
正文 228 个增量、每块 1–12 字、4.7 秒内陆续到（之前另有约 20 秒思考，开不开 thinking 参数都思考）；Windows 上用假网关慢速吐字抓屏，
Claude Code 2.1.305 与 2.1.292 都是转圈计 token、整条消息收完才一次画出（Mac 上 2.1.292 同一假网关是逐行画出，见 live-reply 测试样本）。
Mesa 对 Claude 只能读屏（hooks 不带正文），所以 Windows 上 Claude 的聊天层没有逐字预览；长思考期间屏上也只有「Thinking」。
同日用户拍板补救：「正在回复」后面显示转圈行里的已生成 token 数（`live-reply.ts claudeOutputTokens`，只认 ↓；有逐字预览时不显示），两平台同。
三，**Claude 说「没有加载文件与命令行类工具」**：上一次判成纯模型问题，这次会话实证到原因——Claude Code 对第三方网关也开工具搜索，
Write / Bash 等照常发、另把十来个少用的工具藏在 ToolSearch 后面；glm-5.3-flash 拿 ToolSearch 去搜 Write / Bash（它只搜延迟列表，
当然搜不到），就断定没工具。定下：非 `claude-*` 模型注入 `ENABLE_TOOL_SEARCH=false`（`agents::claude_model_env`，用户自设不动），
假网关核对 Mesa 的真实启动计划：ToolSearch 与占位工具消失、24 个工具一次发全；代价是每次请求多几千 token 输入。用户问「Mac 上不出现」：同一假网关什么都不注入时 Claude Code 2.1.305 发 ToolSearch、2.1.292 不发——是 CLI 新版的变化（本机 Windows 已自动升级到 2.1.305），Mac 升级后同样会遇到，这次的注入两边都生效。
四，**Claude 说「本会话没有 TodoWrite 类工具」、用 Markdown 列计划**：Claude Code 2.1.306 的任务清单工具（TaskCreate / TaskUpdate / TaskList / TaskGet，
取代旧 TodoWrite）只对自家老模型（≤ opus-4-7 / sonnet-4-6 / haiku-4-5）默认发，其余模型名（含 claude-opus-5 与一切第三方模型）不发，
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 打开。假网关核对：glm-5.3 不注入 23 个工具、注入后 27 个（多 4 个 Task 工具）。定下：非 `claude-*` 模型注入它
（同 ENABLE_TOOL_SEARCH 口径，用户自设不动）；Claude 新模型是官方有意不发，不动。聊天层计划卡同步认 Task 工具：一轮里 TaskCreate 逐条建
（编号取自结果「Task #N created successfully」）、TaskUpdate 按编号改状态 / deleted 删除，拼回一张清单（`conversation-tools.ts taskPlan`，
照 Claude Code 自己的拼法）；上一轮建的任务本轮只改状态时拼不出标题，不画卡。

### 2026-10-20 · 聊天层 Windows 八家抓屏核对：读屏与 macOS 同形；Grok 多行改写 CR

用户要求看 Windows 上各家在聊天层的显示与交互问题、Mac 是否同样存在。`chat-capture.py` 在 Windows 上走 ConPTY（pywinpty）跑八家
（Cursor 未装），逐帧喂给 Mesa 自己的读屏函数（parseTuiMenu / parseTrustPrompt / extractLiveReply / terminalHasInputBox / detectModelOnScreen）。
结论：读屏实时预览、审批菜单、信任提示、Codex 底栏模型都与 macOS 同形（Claude / Gemini / Kimi / Grok 的 Windows 字形差异另一批已收进 live-reply.ts /
tui-menu.ts）；聊天层的答题键实际按下去七家都放行。**唯一要改的：Windows 上 Grok 把粘贴包里的 LF 丢掉**（多行连成一行，网关收到的也是连着的），
CR 才算换行；八家逐个试 CR，Codex 会把第一行单独发出、CodeBuddy / OpenCode 把字写错位，所以只对 Windows 的 Grok 改写
（`pty_write_submit` 加 `paste_newline`，pty.rs `chat_paste_body`；前端 writeChatMessage 点名），macOS 不动。另记：Gemini 开着全局精确注意力时
hook 同步跑 PowerShell，每个事件约一秒，工具调用的审批菜单约 10 秒才出（Windows 独有，交给 Gemini 那一批）。

### 2026-10-20 · Windows / Mac 两端完善批（用户：盘点后「全部做」）

先盘点两端各自还缺什么（8 月底 Windows 审计的优先级表前 11 项已修，只剩第 6 项一半），用户「全部做」。定下与实测：

一，**流程 run 脚本在 Windows**：人点「运行脚本」本来就走 Git Bash（`script_shell_argv`），盘点时说「点了必错」不准；真正的缺口是
Agent 照简报跑 `render-pdf` 时，命令工具是 PowerShell 的几家（Codex 等）跑不了 bash 写法。步骤 run 条目加 `command_windows`
（PowerShell 写法，编译器经 `cmd /c` 跑并在 cmd 里重定向——日志按原字节落盘、不走 5.1 的 UTF-16；失败用 `cmd /c exit` 收尾，非零退出又
不关交互 shell；本机 TinyTeX 实跑成功 / 失败 / 无 TeX 三种）。TASK.md 只在 Windows、只列简报点名的脚本，给 PowerShell 与 Git Bash
两种写法——macOS 任务书长度不变（`research-usability` 的篇幅上限钉着）。
二，**内置终端 shell 可选**（设置 `terminal_shell`，只列本机找得到的）+ **Windows 跟随 cd**：PowerShell 的 Set-Location 不改进程工作目录，
所以由 shell 每次出提示符写目录记录文件（PowerShell 包 prompt、Git Bash `PROMPT_COMMAND` 跑 `pwd -W`），cmd 读进程 PEB；四种 shell
在 ConPTY 里真起、`cd` 后读回已有测试。前端写 cd 改走 `pty_cd`（cmd 不认单引号、跨盘要 `/d`）。
三，**hooks 原生小程序**：随包的 `mesa_helper` 加 `hook` 模式（只用标准库），Windows 上每次启动注入的 Claude Code / CodeBuddy 找得到它就用它、
同步跑；`e2e_channel` 实跑 Claude（网关 / 官方账号 + 带 `|%^` 的首条消息）与 CodeBuddy 全通过，Stop hook 87–109ms（PowerShell 1241ms）。
没用新 sidecar。同日应统筹会话要求，写全局配置的三家（Gemini / Kimi / Grok）也换上：helper 拷成 `hooks-state/ccode-hook.exe`，命令里程序路径
不加引号、用正斜杠——Gemini 在 PowerShell 里跑 hook 不认双引号开头的命令，这种写法 cmd / PowerShell / bash 三种宿主都认；路径有空格等退回 `.ps1`，
启动时按该用的写法重写（写前备份）。Gemini 实跑（假网关、临时 HOME）hooks 照常记录，整轮 2.8 秒（原先每个事件约 1 秒、屏上挂「Executing Hook」）。
四，**读屏兜底在 ConPTY 下核对**（`chat-capture.py` 加 Windows 分支，`capture-check.ts` 用 Mesa 自己的解析器读逐帧画面）：Claude / Gemini / Kimi /
Grok 的审批菜单与实时预览都认得出，前提是补上 Windows 字形——Claude 正文行首 `●`（Mac 是 `⏺`，原 `CLAUDE_STATUS` 把顶格 `●` 当状态吞掉）、
Grok `>` / `♦` / `○` / 单选 `•`；没有回显也没有行首、屏顶是没缩进的字（启动横幅、排队中的提问）时不再预览（两平台同一条）。
五，**Win11 贴靠布局**：自绘最大化按钮悬停 500ms 替用户按 Win+Z（只在 build ≥ 22000、Mesa 在前台时），系统给前台窗口弹同一个布局菜单。
六，**客户端接力 Windows 事实**（设计稿 §8 第 3 条）：本机 Codex（OpenAI.Codex 26.1013.4894.0）与 Claude（2.42304.2.0）都是 MSIX 包，scheme 注册在
HKCR 下（Codex 没有 shell\open\command，靠应用包激活）；版本改从当前用户应用包仓库的子键名读，不起 PowerShell。打开动作本身仍留给人点。
七，**Cursor CLI 在 Windows 上能装能用**：官方其实有原生安装器（`irm 'https://cursor.com/install?win32=true' | iex`，装到 `%LOCALAPPDATA%\cursor-agent`），
此前「只支持 WSL」的口径作废。`PackagingSpec.install_script_win` 走 PowerShell；启动器 `cursor-agent.cmd` 转手 PowerShell 再起自带 node，
Mesa 照同一挑法直启 `node.exe index.js`。本机已装并核对版本探测；登录与会话目录需要 Cursor 账号，未核。
八，**Codex 无头写盘在 Windows**（定时雷达用）：临时 CODEX_HOME + 假网关实测——没配 `[windows] sandbox` 时 `exec -s workspace-write` 的命令一律
「blocked by policy」；`unelevated` 能跑但 pwsh 7 下命令落在 pwsh 安装目录、相对路径写错地方；`elevated` 要 UAC 初始化，没在测试里起。
能力表按用户配置给提示，不改启动参数（要不要在 Windows 上给 Codex 定时任务放开沙箱是安全取舍，留给用户定——同日已拍板，见下下条）。
九，**其余 Windows 小项**：未压缩 aiff 后端转 wav 再给 WebView2 放；setup / archive 钩子测试三平台同跑（Windows 走 Git Bash）；SmartScreen 写进
README 与说明书；`manuscript_font.py` 两处 Windows 毛病（子进程输出按 GBK 解码崩、fc-list 的 `C:` 盘符让族名全认不出）。
十，**Mac 没有 Homebrew 也能一键装依赖**：Node.js / Python / Quarto 走各家官网 .pkg（查版本索引 → curl → osascript 提权跑 installer，系统密码框，
Mesa 碰不到密码），TeX 由 Quarto 装 TinyTeX。只在 Windows 上编译与单测过解析逻辑，Mac 实机未跑。
十一，**发布**：推翻 v1.3「Intel 包暂缓」——Apple 芯片 runner 交叉编译 `x86_64-apple-darwin`，`verify-release` 加 `darwin-x86_64` 校验；
macOS 签名公证接进 workflow，六个 `APPLE_*` secrets 配齐才启用（缺一个就照旧出未签名包），开通步骤见 docs/release.md。
十二，**子进程不继承 Mesa 的 PWD**（同日另一会话报：`opencode run` 用 `process.env.PWD ?? cwd`，无头 opencode 把文件写进了 src-tauri/src）：
`background_command` 删掉 PWD，PTY 拉起时 PWD 设成工作目录，三平台同口径。
**没做**：应用内更新的国内镜像（当时要先定托管方；同日用户拍板后已接上，见下一条）；CI 里的
「CLI 版本 × 平台」端到端（`e2e_channel` 依赖本机各家 CLI 的首次启动状态，要在 GitHub 上迭代，本地端到端仍是闸门）；
界面点验（清单在 docs/qa/acceptance-2026-10.md）。

### 2026-10-20 · 用户拍板两件：Windows 上 Codex 定时任务确认后开沙箱；应用内更新国内镜像「配齐就启用」

一，**Codex 定时任务的 Windows 沙箱**（上条第八条的取舍）。补测（假网关、git 工作树作工作目录，同定时任务的隔离副本）：
`-c windows.sandbox="unelevated"`（非提权，不要管理员）命令能跑，第一次约 20–30 秒，给工作树里每个文件加一条给 Codex 沙箱身份的
「修改」权限，主仓与 `.git` 不动；但 Codex 0.163 在这种模式下 shell 起在 PowerShell 自己的安装目录（5.1 与 7 都是），相对路径写
被拒、绝对路径正常。用户本机已配的 elevated（提权）命令与相对路径都正常（多一个 CodexSandboxUsers 组的权限；`~/.codex/cap_sid`
记下这次的工作目录）。Codex 没有命令行做 elevated 的初始化（要管理员 UAC），所以 Mesa 能替用户开的只有 unelevated。定下：
用户在定时任务弹层（选了 Codex 时出「了解并开启」）或 **设置 → AI 与 Agent** 看过说明、点确认，设置 `codex_win_sandbox_consent`
（全局一个：权限只动 Mesa 自己建的隔离副本，与哪个任务无关）才生效；生效时定时运行加 `-c windows.sandbox="unelevated"`（只对这次
运行，不改 `config.toml`），任务说明追加「读写文件用绝对路径」一句（`scheduler::codex_win_unelevated_note`）。用户在 Codex 里自己配了
`[windows] sandbox` 时照用户的、不问。没确认 = 现状（提示会被拦、不开）。
二，**更新镜像**：托管 = 公司自有对象存储 + CDN（S3 兼容接口，阿里云 OSS 一类），不用第三方加速域名。应用侧：仓库变量
`UPDATE_MIRROR_BASE` 配了，打包时把 `<镜像>/latest.json` 加到 updater 地址最前、GitHub 第二（Tauri 按顺序试）；没配就只有 GitHub，
源码不写死域名。同步：新 workflow `mirror-release.yml` 在 Release **published** 时触发（草稿阶段不同步），取 `latest.json` 改写下载地址
（`scripts/mirror-latest-json.mjs`，签名原样、缺签名拒绝）、先传包后传清单、读回核对；凭据走 secrets，没配齐跳过并写日志。改写逻辑
对现有已发布的 `latest.json` 干跑过；工作流本身没在真实对象存储上跑过（开通步骤见 docs/release.md）。只对配好后打出的版本生效。

### 2026-10-20 · 没有旁路的家 /clear 后跟到新会话；多 Agent 聊天层核对统筹结论

用户让本会话统筹几个并行核对 Agent CLI 聊天层的会话，补做没人核对的「会话跟随」。Windows 上六家（Gemini / Kimi / Grok / Qwen /
OpenCode / CodeBuddy）在含中文与空格的目录里实跑（假网关、临时家目录），Mesa 解析出的项目路径都与启动目录 same_path 相等、消息都读得出
（Gemini 存的是全小写路径，same_path 在 Windows 不分大小写，照样对上）。**查出三平台共有的缺口**：Gemini / Kimi / Grok 打 `/clear`
都另开新会话文件（三家实测），这三家默认没有旁路报「换了会话」，标签一直盯旧文件，之后的回复聊天层看不到。用户拍板修：
`sessions::claim_session_successor`——已认领的标签，同 agent 同目录出现比当前认领更新、启动前没有、没被任何标签认领过的会话就改认
（取最新）；**同 agent 同目录还有别的标签登记时不猜**（分不清谁开的新对话，宁可不跟也不串）；前端 `linkTick` 在旁路没给会话 id 时
每轮问一次，换过去走 `relinkTo`（「已切到新的会话」）。按会话 id 恢复的标签不登记认领，仍不跟随（已知限制）。
同批分派：Grok 回放丢工具调用（分叉会话修，见上条）、`opencode run` 取 `PWD` 当工作目录（待完善项会话修 process.rs）、Windows 上
cmd 内建 `del` 等不带外壳也算改文件（tool-activity.ts）。

### 2026-10-20 · Grok 回放 / 聊天层带上工具调用：chat_history.jsonl 的 tool_calls 与 tool_result 不再丢

用户问「除了 Codex，其他 Agent CLI 改文件有什么问题、是否只在 Windows」。Windows 上六家真网关实跑同一条「新建→改→删」
（Claude / Qwen / OpenCode / Kimi / Grok 智谱 glm-5.3-flash，Gemini Zeta gemini-4-argon，临时 HOME、无头），按 Mesa 的会话解析
+ tool-activity 渲染核对：五家新建 / 修改走各自的 Write / Edit 类工具、差异正常；删除各家都只有 shell 命令（CLI 没有删除工具，
三平台同）。**Grok 例外**：Mesa 读 Grok 优先用 `chat_history.jsonl`（`parse_grok_history`），只取文字，`assistant.tool_calls`
与 `tool_result` 整个丢掉，回放和聊天层看不到任何工具调用——数据本身完整（Grok 1.0.62：`tool_calls[{id,name,arguments 串}]`，
`tool_result{tool_call_id,content}`），与平台无关。用户拍板修：工具调用解析成 tool_use 块（参数原样、带 call_id），结果并进发起调用的
助手消息并按 call_id 配对；兼容 OpenAI 式 `function` 包一层、参数为对象。`updates.jsonl` 回落解析（`parse_grok`，没有 chat_history 时用）
仍只取文字，未改。同批另两条：Qwen 在 Windows 上用 cmd 内建 `del` 删文件，摘要不算改文件（tool-activity 补 cmd 内建表）；
OpenCode `run` 取目录用 `process.env.PWD ?? cwd`，Mesa 进程带 PWD 时无头运行会跑错目录（另行处理）。

### 2026-10-20 · Codex 模型清单的基础指令换回 Codex 默认原文：模型才会用 apply_patch，聊天层才有差异

用户问「Codex 不显示写入删除的 diff，是读不到还是要完善」，要求先实跑再修。用户今天 5 个 Codex 会话（智谱网关 glm-5.3）里改文件
全是 PowerShell 的 Set-Content / Remove-Item，会话文件与 app-server 都没有改动前后内容；8 月不经 Mesa 清单的会话全走 apply_patch、差异正常。
原因是 Mesa 写的 catalog `base_instructions` = 「You are a coding agent.」，整段替换了 Codex 的系统提示词，模型不知道 apply_patch。
实跑（同网关同模型、隔离 CODEX_HOME，`codex exec`）：一句话版 5 次改文件全走 PowerShell；换 Codex 默认原文后走 apply_patch，
**但 Windows 上只有「整条命令就是一个 bash heredoc」Codex 才接住**（出 FileChange、带差异），PowerShell 的引号串 / here-string / 管道、
heredoc 前后串别的命令都失败，模型先试错几轮。0.163 的 `apply_patch_tool_type` 只认 `freeform`（中转拒收，维持不声明）。定下：
一，catalog 填 Codex 对未登记模型的默认提示词原文（不得换回一句话占位）。**同日追加（用户：做根因第 1 条）**：原文改为
**向本机 Codex 取、按版本缓存**（`<配置根>/catalogs/codex-base-instructions-<版本>.md`，新版本取到后删旧缓存）——Codex 没有导出命令
（`debug models` 只有 GPT 专用条目），做法是一次性 CODEX_HOME 里跑 `codex exec`、渠道密钥变量故意不给：会话首行 session_meta 已带原文，
发请求前报缺变量退出，不联网、实测 0.5–2 秒、每版本一次；取不到才用随包 0.163 原文（`codex_base_instructions.md`，Apache-2.0，
THIRD-PARTY 有条目），本进程内不再重试该版本。Windows 上 codex 退出后约 1.3 秒目录句柄才放，临时目录放后台重试删、下次取前先扫；二，**只在 Windows** 另拼 `codex_windows_patch_note.md`（只用单独一条
bash heredoc 调 apply_patch、不经 PowerShell、报 command not found 就单独重发），实跑 glm-5.3 改文件一次成功，glm-5.3-flash 偶尔仍先
串命令、按提示自行纠正；三，前端 `tool-activity.ts` 认 shell 里的 apply_patch（argv 形式或整条 heredoc，PowerShell 里调的不算——
文件没改），会话回放画成新建 / 编辑 + 差异；四，app-server `fileChange` 的新建 / 删除差异是文件原文，`chat_channel.rs` 补 + / − 再给审批卡。
代价：每次请求输入多约 5 千 token。用 Remove-Item 删文件、用脚本改文件仍只有命令，属正常。实跑时注意：`codex exec` 不关 stdin 会一直等输入；
CODEX_HOME 放在系统临时目录下 Codex 不建 apply_patch 别名，结论会失真。

### 2026-10-20 · 新标签默认随手聊；Windows 上 Codex 在主目录启动先确认；聊天层提交间隔 250ms

用户在 Mesa Dev 里测 Codex 聊天层，报两件事。一，**发出去的话留在终端输入框**：聊天发送是正文、隔 60ms、回车，Codex 把连着到达的字当粘贴，
粘贴后 120ms 内的回车只换行（codex-rs `paste_burst.rs`）；Windows 端到端实测 60ms 复现、150ms 通过，`pty_input::SUBMIT_GAP` 取 250ms（terminal.md 同步）。
二，**Codex 执行任务时 Mesa 直接退出**：新标签默认目录是主目录，用户配置了 Codex Windows 沙箱（`[windows] sandbox = "elevated"`），第一条沙箱命令前
Codex 给工作目录下每一项改访问权限（`~/.codex/cap_sid` 记了 89 个路径，含 Desktop），一路改进 Mesa 源码；tauri dev 把权限变动当源码改动，
杀掉 Mesa 重编译重启，app-server 随任务组一起被收，Codex 目标续跑又触发同一条命令，循环三次（只改权限、不改内容即可复现）。打包版不退出，
但同样会改整个用户文件夹的权限。用户拍板：**新标签没给目录时默认随手聊**（`ensure_scratch_dir`，恢复标签 / 接回会话不动，主目录要人在目录菜单里选）；
**Windows + Codex + 主目录 + 非完全访问启动前弹确认**（`quick-chat.ts codexSandboxCoversHome`），取消时聊天层报具体原因。仓库上 Codex 遗留的
继承权限已用 `icacls /reset /T` 清回（36889 个文件）。开发时测 Codex 不要用包住 Mesa 仓库的目录（主目录、Desktop、仓库本身）。

### 2026-10-20 · 聊天层 Windows 实测反馈：Claude 审批答完即收卡、实时预览滤掉折行提示（两处 Mac 共有）

用户在 Mesa Dev 里按测试提示词逐条点 Claude Code，报三件事，定因后两件是 Mac 共有、Windows 上更显眼，一件与 Mesa 无关：
一，**审批卡先英文后中文**：英文是读屏认出的终端菜单卡；答完后 Claude 不报「已答」，旁路要等那个工具跑完（PostToolUse）才撤，
期间屏上没菜单、注意力仍是「等确认」，冒出中文兜底卡（WebFetch 批准后挂了 14 秒；Windows 上 hooks 后台跑，快命令也多挂约 1 秒）。
定下：**屏上回到这家的输入框、没有菜单 = 已答**（`chat-channel.ts hooksApprovalAnswered`，注意力回 working；旁路报「等批准」时补扫一次屏，
聊天层点了菜单按钮先按已答、下一次扫屏纠正）。只作用于读屏认得出输入框的 hooks 家（Claude Code），CodeBuddy 与能从聊天层答的家不变。
二，**实时预览一直挂着一行英文**：转圈下「⎿  Tip: …」（Claude 2.1.304 的 workflow 提示）长过一行，第二行没有 ⎿、被当成回复；
`live-reply.ts` 加 `wrapSkip`，⎿ 行折下来、比正文缩进深的续行一并跳过。三，**Claude 说「本会话没有写文件 / shell 工具」**：
Claude 自己的会话记录里每次请求都带着 Bash / Read / Write / Edit 等全套工具，Mesa 的「请求批准」档不删工具，Windows 上假网关端到端也照常调用工具；
是 glm-5.3-flash（经智谱网关）只认出 ToolSearch、拿它搜不到内置工具就断定没有，换平台结果一样。不改 Mesa；换模型复测。

### 2026-10-20 · 聊天层 Windows 适配：CLI 绕开 cmd 直启、Claude hooks 在 Windows 后台跑、app-server 随 Mesa 同生共死

用户在 Windows 上要求核对 Mac 上做的聊天层（结构化旁路）是否适配、需要什么完善，并要求**不影响 Mac 端**。把 `chat_channel::e2e`
移植到 Windows（`storage::config_root` 测试接缝 + USERPROFILE / CODEX_HOME + `pty_command` 认 shim），五家真 CLI + 假网关逐家跑。
查出并定下：一，**Agent CLI 的参数不经 cmd 传**——npm 装的 Claude Code / OpenCode 的 .cmd shim 指向原生 exe、CodeBuddy 指向
无扩展名 node 脚本，原先都回落 `cmd /c call`：官方账号的 Claude 带的内联 `--settings`（hooks matcher 含 `|`）让 Claude 直接起不来
（「文件名、目录名或卷标语法不正确」），聊天层随启动带的首条消息多行只剩首行、`%PATH%` 被展开进消息。shim 深化补这两种
（`process::exe_from_cmd_shim` / node shebang），Windows 上官方账号的 hooks 设置另写旁路目录里的 settings.json 传路径。
二，**Windows 上 Claude 的注入 hooks 带 `async: true`**：hook 要起 PowerShell，实测每次 0.9–1.2 秒，同步挂着每个工具调用前后各卡一秒；
后台跑会乱序，另挂 PermissionRequest 拿审批内容，`Tracker::async_hooks` 按身份对账（同步模式规则不动）。CodeBuddy 未核实 async，仍同步。
原生小程序代替 PowerShell（再快一个数量级、可保持同步）要加 Windows 专属 sidecar，未做，列为后续。三，**共用 hook 脚本**只删回车换行
（原先折叠 `\s+` 吃掉审批卡命令 / 差异的缩进）、写日志撞车重试（12 并发实测丢 1 条，丢的若是 Stop 聊天层会一直「在回复」）。
四，**Codex app-server 挂进 Windows 任务组**（`BackgroundCommand::spawn_tied_to_app`，句柄关即全杀），Mesa 崩溃 / 被强杀不留占端口、
占会话写锁的孤儿（实测强杀后 0 残留）；收旁路先杀后删目录。五，审批卡与「已工作」摘要认 PowerShell 外壳（`unwrapPowerShell`）和
常见 cmdlet，别名只在确认是 PowerShell 时认。全部改动按平台门控或对 Mac 输入恒等（bash/zsh 命令、POSIX 路径输出不变）。
未验：Mesa Dev 窗口里逐家点一遍；Windows 上读屏兜底（审批菜单 / 实时预览，Claude / Gemini / Kimi / Grok）在 ConPTY 下的形态。

### 2026-10-20 · Gemini 版本探测不再往用户 ~/.gemini 里留 projects.json.*.tmp

新用户沙盒里发现 `~/.gemini` 十几分钟积了 28 个 `projects.json.<uuid>.tmp`。定因（本机 gemini 0.64 复现 + 读源码
`ProjectRegistry.save`）：`projects.json` 不存在时 CLI 每次启动都异步写 tmp 再改名，`gemini --version` 打完版本就退出，
改名没做成；已有 projects.json 时不写。Mesa 的连接检测（2 分钟缓存过期就重探）、更新检查、启动预检都跑 `--version`，
在没交互跑过 Gemini 的新装机器上每次留两个。定下：一，**无头探测不得在用户的 CLI 目录里留东西**——Gemini 的探测
带 `GEMINI_CLI_HOME` 指到 Mesa 自己的临时目录并预放一份 projects.json（`agents::quiet_cli_probe`，版本探测与启动预检
共用；实测这样零 tmp），交互启动不动。二，已经留在用户 ~/.gemini 里的 tmp 不替用户删（CLI 目录只读口径），矩阵与
CHANGELOG 写明成因，可放心删；交互跑一次 Gemini 后也不再增加。三，问题在上游（退出前没等异步写完），Mesa 侧只做绕开。

### 2026-10-20 · 新用户上手引导：欢迎页 + 侧栏进度行 + 清单浮层 + 连接页引导条 + 「下一步」提示

用户要求做新用户初次使用引导（连接页装 Agent、可能要配代理、新建网关、保存后加连接、新对话、提醒对话改名、建项目），形式交由我定。
定下：一，**形式**：新装第一次打开弹一次欢迎页（七步一览，主按钮直接去做第一个没做的步骤）；之后由侧栏系统段上方的「上手引导」行
（进度环 + 「下一步：…」）承载，点开是贴侧栏向右展开的清单浮层（当前步自动展开，写做法 + 能直接点的按钮）；连接页页头下方有当前这一步
在本页怎么做的引导条（装 Agent / 网关 / 连接 / 第一段对话四步）；每做完一步右下角弹「结果 + 下一步」提示，带那一步的按钮。**不做聚光灯
遮罩式导览**：步骤散在好几页、装 Agent 要等几分钟，遮罩一离开预设路线就失效。二，**完成状态由真实数据现算**（装没装 Agent、网关数、
连接数、非内部对话数、已添加项目数），不存「做到第几步」——可跳着做、在别处做完自动打勾、删掉变回没做；只有「切到终端看看」「认识对话标题」与「用官方
账号跳过网关」没有数据可推，靠确认。持久化只存判定结果 / 欢迎页看过 / 三个确认（localStorage `ccode.onboarding`）。
三，**谁会看到**：首屏数据到齐后判定一次——已有连接的老用户直接收起（不弹、不占侧栏），其余当新用户；判定结果写死，之后不按数据回头改。
帮助菜单与 ⌘K「上手引导」随时可再打开（收起过的恢复）。四，**第一段对话出现那一刻先提示「可以切到终端看」**（同日用户追加：聊天和终端是同一段对话的两种画面，提示里一键切过去；
运行页真切过一次终端——标签栏切换钮或 `/terminal`——即自动确认，经 `store.ackOnboarding` / `surfaceSwitchReq`），**接着是对话改名提醒**：提示讲清自动起名（临时标题 →
「月日|类型|主题」、会用少量 token）和手动改名入口（对话页右键「编辑标题与标签」、项目对话页签铅笔），点「知道了」才算这一步完成。
五，**顺带修路上的坑**：网关库头部（标题、关闭、错误 / 结果提示）改为吸顶——原先提示在长表单顶上，点最底下的「保存网关」看不见；新建保存
后「Agent 配置」滚进视野；改已有网关保存补右下角「已保存」。「＋ 添加连接」打开时，有还没连接在用的网关就默认「选用已有网关」并选中它
（取最后建的），Agent 默认挑已装好、该网关填了它协议槽的那家（`gateway-option.ts addConnectionDefaults`），对上「网关库建好 → 关掉 → 添加连接」
这条路。六，toast 加能力：带动作按钮、常驻（sticky）、同 key 顶替（`toast.ts`），引导的「下一步」只留最新一条，收起引导即撤。
实现：`src/onboarding.ts`（步骤表 / 判定 / 文案，tests/onboarding.test.ts）+ `src/components/OnboardingGuide.tsx`。界面手感未在 Mesa Dev 实机点验。

### 2026-10-20 · Mac 上 Gemini 标签自动档改走 WebGL：半格方块留白在 DOM 渲染器下断成细线加缝

用户截图问 Gemini 终端为什么显示成这样（每个对话框上下各一条灰线、中间隔着缝），选了「Gemini 标签自动用流畅渲染」。定因：gemini 0.64
用半格方块 ▄ / ▀ 给消息框、输入框做上下留白；Mac 自动档走 DOM 渲染器，按字体画这两个字，行高 1.2 下盖不满一行。同一 xterm 内核在
无界面浏览器对比实测：DOM 上下各一道缝，WebGL（自绘方块字符）一整块。定下：一，「终端渲染」自动档在 Mac 上对 Gemini 标签例外走
WebGL（`src/terminal-renderer.ts` 名单，代价是这类标签文字略软），其余 agent 与 shell 照旧清晰档；用户显式选「清晰」「流畅」不被覆盖。
二，同一标签换 agent 重开时按实际 agent 加载或卸下 WebGL（卸下后重新挂 DOM 滚动按行挪位）。三，没选「DOM 下把方块字符拉满整行」——
要改渲染层，工作量和风险大。同次排查：截图里的「light terminal background」警告与框色一深一浅，是 Gemini 运行中先后问到浅色和深色两个
终端底色（启动时 Mesa 终端回答的是当时主题的底色），与渲染器无关，重开标签即可。

### 2026-10-21 · 聊天层阅读体验四项可调：字号 / 字体 / 行内代码强调色 / 滚动条淡出（用户拍板「都做、合适优化、强调色放设置里可调」）

- 四项都是白名单字符串（settings.rs `KNOWN_CHAT_*` ↔ chat-style.ts 逐表镜像，测试钉住），设置 → 外观；预览框用真 `.md-chat` 样式，改了当场变。
- **默认值**：字号 normal / 字体 system / 滚动条 auto 都等于「不写变量」，没调过的人字号字体与改版前一致；强调色默认 warm（用户要求加强调色），off 回灰白。
- 强调色只染行内代码（字色 + 同色 14% 薄底），深浅主题各一套；围栏代码块、终端不动。链接在 `.md-chat` 里加细下划线（不单靠蓝色）。
- 滚动条「淡出」纯 CSS（`:hover` + ChatSurface 滚动期间打的 `data-scrolling`，停 0.9s 摘），轨道 10px、拇指透明描边内缩成细条；只作用于聊天滚动区 `.ccode-chat-scroll`，全局 6px 滚动条不变。
- 不做：聊天层以外（笔记阅读 `.md-body`、终端）不跟随；不提供自定义 hex 颜色与任意字体名（挡位 + 预设，同 chrome_opacity 理由：每一档都能比出可读性）。

### 2026-10-20 · 上下文圆环点开是上下文浮层：分类取 CLI 自己的 /context，横条按分类上色

用户给 Claude 客户端的「Context window」面板截图，问用量显示能不能做成这样，随后「按推荐的来」。定下：一，点圆环弹浮层（悬停仍是一句话）：
已用 / 窗口、分类横条加自动压缩竖线、分类列表、离自动压缩还有多少、「压缩上下文」（斜杠面板 Mesa 组同一个动作）。
二，分类只取 CLI 自己的 `/context`，Mesa 用标签同一套启动参数在后台跑一次（`context_breakdown.rs`）：只有 Claude Code
（`-p "/context" --resume <id> --no-session-persistence`，关 hooks）与 Qwen Code（`-p "/context" --resume <id>`）能无头跑，实测对话文件
一字节不变、不调用模型；CodeBuddy 无头模式把 `/context` 当普通提问发给模型，其余家没有这类命令——只显示总量，Mesa 不自己估分类。
三，配色：起初按推荐守「颜色只表达风险」做三段灰，用户看过后同日改要每类一个颜色——对话 / MCP 工具 / 内置工具 / 系统提示四大类
各一色（dataviz 参考调色板前四槽，深浅主题各一套，按横条相邻顺序在 Mesa 深色浮层底与浅色白底上用校验器验过色盲区分），小类同灰，
颜色跟着分类固定、不按大小排；快满只让标题数字变橙。这是「颜色只表达风险」在数据图上的有意例外。
四，点开才读、同一轮（用量不变）缓存，数字标「估算」。

### 2026-10-20 · 智谱预设按计费方式拆两条：套餐 OpenAI 槽走 /api/coding/paas/v4

用户问对话里启动 Grok 为什么报「Retry failed: 余额不足或无可用资源包，请充值」，同一网关在别的 agent 能用。实测：同一把 key
打 `open.bigmodel.cn/api/paas/v4/chat/completions` 回 `1113 余额不足`，打 `/api/coding/paas/v4` 正常；`/api/anthropic`、`/api/v1`
（Responses）两种计费都通——按量端点不抵扣 Coding Plan 套餐，所以走 OpenAI 槽的 Grok / Qwen / OpenCode / Kimi 挂、Claude / Codex 不挂。
定下：一，原「智谱 GLM」预设拆为「智谱 GLM Coding Plan（套餐）」（OpenAI 槽 coding 端点）与「智谱 GLM（按量付费）」（paas/v4），
Anthropic / Responses 槽两条相同。二，两址 `/models` 都 200，探测和拉目录分不出来，只在地址上提示：网关库与添加连接表单对智谱
（含 `api.z.ai`）`/api/paas/v4` 出黄色提示。三，不自动改用户已存的地址（Mesa 不知道用户买没买套餐）；本机这条网关按用户情况手工改过。

### 2026-10-20 · 聊天层结构化旁路：TUI 照跑，逐家接 CLI 自带的结构化事件；精确注意力五家改为启动时自动带

用户问聊天层（CLI 的解析渲染层）有没有可借鉴的开源项目，要求「只做正确借鉴」出方案，随后「按推荐的来，一次性做完」，并追问
「默认带上每次注入的 hooks 都可以做吗，是不是设置页不要开关了」。方案与实施记录：`docs/design-chat-structured-channels.md`。定下：
一，**运行方式不变**（PTY + TUI、终端是事实来源、两层共用一个进程）；聊天层取数优先级 = CLI 自带结构化旁路 > 会话文件 > 读屏，
旁路起不来照旧启动、功能不减。借 Qwen Dual Output（「终端 + 聊天双界面」本就是它的首要用例）、happy 的 SessionStart 注入与幂等回合、
vibe-kanban 的工具状态与 shell 命令再分类、ACP 的工具 kind / status / diff / plan 模型；**不借**切界面就重启进程、拦截 CLI fetch、
交互对话改走无头或 ACP、免确认时自动选第一项、阻塞式 hook、AGPL 项目实现。
二，**逐家旁路**（chat_channel.rs）：Claude Code / CodeBuddy 用 `--settings` 带 hooks（与用户 hooks 合并）；Qwen 用 Dual Output；
OpenCode 用 TUI 自带服务（每标签随机端口 + 口令）；Codex 用私有 app-server（本机 WebSocket + 能力令牌，TUI `--remote` 连上去，Mesa 作为
第二个客户端；恢复时权限参数改成服务配置）。hook 一律不阻塞、不替用户回答；审批只在用户点按钮后经 CLI 官方通道送回（Qwen / OpenCode /
Codex），其余照旧按菜单原文写按键，卡上补命令原文 / 差异。hook 命令记标签号（PTY 注入 `CCODE_TAB_ID`），按标签认会话、跟随 `/clear`。
三，**设置页开关**：逐家实测后不能全撤——Gemini（系统设置文件须属 root）、Kimi（无指定配置的入口）、Grok（覆盖层不收 hooks）只能写
全局配置，保留开关；其余五家不再给开关，启动时收回以前写进全局配置的 Mesa 条目（写前备份）。用户 `~/.codex/hooks.json` 的收回在开发中
被 Mesa Dev 热重启先于干跑执行，事后核对备份只含 Mesa 的三条。四，消息与工具调用带来源 id（`ChatMessageDto.id` / `BlockDto.callId`），
前端以 id 当身份并按 id 配对调用与结果；没另起增量补丁协议（一条消息常跨多行，按偏移增量解析会切坏）。五，过程里加计划卡、只读命令
并进「查阅」、在跑的一步标「进行中…」。细则：`docs/conventions/terminal.md`「聊天层结构化旁路」、safety.md 同名条、matrix §14。

### 2026-10-19 · 自拼版本段的槽位地址归一：gemini / claude-code 物化时剥掉末尾 `/v1` 一类版本段

用户报告：gemini 绑定（中转 `ent.zetatechs.com`、模型 `gemini-4-argon`）一开口就报 `Model "gemini-4-argon" was not found or is invalid`。
探针实测定因：gemini CLI 0.64 对 `GOOGLE_GEMINI_BASE_URL` **无条件**追加 `/v1beta/models/<模型>:streamGenerateContent`——槽位里填的
OpenAI 风格 `/v1` 地址会拼出 `/v1/v1beta/…`，中转 404，CLI 只报「模型不存在」；同日实测 Claude Code 对 `ANTHROPIC_BASE_URL` 同病
（`/v1` → `POST /v1/v1/messages?beta=true`）。用户把 `/v1` 地址填进这两槽是常态：网关保存把主地址折进全部五个槽，同址网关必然如此。
定下：`gateway_store::materialize` 对 **gemini / claude-code** 绑定剥掉槽位末尾版本段（`models::strip_trailing_version_segment`，
复用 `ends_with_version_segment` 判据），启动注入、`--settings` 覆盖层、设为全局（`~/.gemini/.env` 的 `GOOGLE_GEMINI_BASE_URL`）全走
materialize 单一漏斗；gemini 拉目录候选链（`models::model_list_candidates` 抽成纯函数）同口径先剥再拼 `/v1beta/models` → `/models`，
与 CLI 真实请求对齐。**只收已实证的两家**：codebuddy、qwen / kimi 的 anthropic 协议通道未实证自拼行为，不剥（避免未实证就注）；
openai 系（codex / grok / opencode / qwen / kimi 的 openai 协议）`/v1` 是约定一部分，原样保留。槽位存储不动（slots 是唯一真相，
anthropic / openai 槽合法带 `/v1`），归一只发生在物化出口。端到端复验：根地址 + 真密钥 gemini 0.64 正常回话。细则进
`docs/conventions/profiles.md` §2 归一段；matrix 两个注入行同步；user-guide §9.2 常见坑改口。

### 2026-10-19 · 连接行「在终端使用」换成「新对话」：点哪条连接用哪条，发一句话验证可用

用户：连接页的「在终端使用」统一换成跳到新对话页，这样能快速检查配置的连接是否可用。原入口新开终端标签（有上次目录就直接启动），
在聊天层成为默认面之后既不是人们验证连接的地方、也不落在「新对话」那一页。定下：①入口换成对话图标（`NAV_ICONS.quickChat`），
落点与侧栏「新对话」相同——聊天面、文件夹「随手聊」、发第一句才启动；②**点哪条连接用哪条**（`chatChoiceForProfile`），模型取该连接名单第一个，
不看「上次快速开聊记住的」那套默认，所以输入框里写着的就是点的那条；③**不预先挡不可用的连接**（缺端点 / 缺密钥 / 已停用都照样打开），
问题由输入框和启动提示如实说出，不在入口处替人拒绝；④**已有还没说过话的空白随手聊标签时复用它，但把输入框改成这条连接**
（`PendingTerminal.reseedBlank`，复用 `adoptExisting` 的重新预选）——快速开聊复用空白标签时刻意不改人已换过的选择，连接页点名要连接则必须改，
否则会落在选着别的连接的标签上、检查白做；⑤旧入口的「有上次目录就直接启动」不保留（验证连接不需要进某个项目目录）。
「外部终端」按钮不动。

### 2026-10-19 · 网关库「解绑并删除」

用户提：删网关时被「请先解绑」拦住，要去每个连接里逐条解绑，能否直接提供「解绑并删除」。采纳，但保留 profiles §9 的底线：后端 `delete_gateway` 仍拒绝有绑定的网关，不做后端级联；前端在网关库确认弹窗里列出连接与影响面（定时任务不置空、项目/目标引用清理，文案与连接页解绑共用 `unbind-impact.ts`），确认后逐条 `delete_profile` 再删网关，与手动解绑同一清理口径。非原子，中途失败刷新并如实提示。深浅同日另改：深色应用图标描边由 14% 加亮（深色底板在深紫程序坞上轮廓缩进，浅色因 90% 白描边无此问题，字形大小不是原因）。

### 2026-10-19 · 删连接页「注册到 / 移除 Codex 客户端注册」，渠道补写只走客户端接力

用户问连接页的注册入口还要不要：对话与项目在客户端打开已不依赖它。核对后定下：①项目级打开不涉及 Mesa 连接，Claude 桌面版用自己的账号，
二者本就与注册无关；②Codex 里用 Mesa 连接开的对话仍需要 `config.toml` 有渠道定义块，但由「在 Codex 客户端打开」弹层的「写入并打开」
当场补写（`register_codex_client_provider_named`），不再需要手动步骤；③应用未发版，没有存量注册记录（本机 config.toml 只有 `custom`），
按「未发布不养闲机器」把「注册 / 移除注册」两个菜单项连同 `codex_register_client_provider` / `codex_unregister_client_provider` /
`codex_client_registered_profiles` 三条命令、`patch_codex_config_unregister`、`codex_default_is` 及其测试一并删除；④撤销改走连接页
Codex 组头「撤销上次写入」（补写与「设为全局」共用备份批次，只能回到最近一次写入前，写过几次要撤几次），弹层与文档照此措辞。
会话包导入弹窗里的「注册到 Codex 客户端」勾选是另一条路径，保留。

### 2026-10-19 · 会话瘦身：撞网关 413「Request body too large」时原地去掉较早的截图

用户一条做宣传视频的 Claude 会话卡死，网关报 `status_code=413 Request body too large`。实查会话文件：请求体约 33 MB，其中 65 张
base64 截图占 32.7 MB（每张约 0.5 MB），文字不到 1 MB。**根因**：Claude Code 每次提问把整段历史连图重发，上限按**字节**算（官方 API
单请求 32 MB），token 还只用了约 77.5 万 / 1M 窗口，自动压缩不触发；撞限后 `/compact` 自己也要带同样的请求体，同样 413。
**413 不会写进会话文件**（文件里只有「Request timed out」的 api_error 行），所以检测只能靠估算请求体大小，不能靠错误文字。
用户拍板「检测 413 并一键瘦身续接」，Mesa 此前没有同类功能（最近的「提炼接力」是 AI 蒸馏成新会话，会丢细节、不检测）。规则：
一，**原地瘦身而不是另存副本**——副本是新会话，每行 sessionId 要改（Mesa 取第一行 sessionId，不改会与原会话撞 id），用量页按每条
assistant 行累计，副本还会把整段历史再算一遍；原地改这两个问题都没有。二，**只换较早的、留最近 6 张**（`DEFAULT_KEEP`）：被换的媒体块
（`image` / `document`，base64）换成一行文字占位，没动的行逐字节原样，同一张图在 `toolUseResult.file.base64` 里的界面副本一并去掉；
最近一次压缩边界之前的消息不会再发给模型，不算也不动（边界格式取自公开行为，本机无压缩样本，未实测）。三，**防护**：写前完整备份到
`<配置目录>/ccode/backups/session-slim/`（同会话留最近 3 份）、最近一分钟还有写入就拒绝（与列表「进行中」同口径）、写完前复核源文件
长度与 mtime 没变、tmp + rename 原子替换并保持原 mtime（列表顺序与用量标记不变）、路径必须在 `~/.claude/projects` 内。四，**入口**：会话回放里
估算请求体 ≥ 20 MB 出提示条（≥ 30 MB 为红色）、「⋯」菜单有「瘦身会话…」；弹层给「只瘦身」与「瘦身并在终端继续」；Mesa 终端标签里正开着这条会话时
拒绝（进程内存里还是旧历史）。五，**已在客户端里开着的会话**要在客户端归档再恢复一次才读到新记录——Mesa 管不到别家进程，弹层如实写明。
**真实数据干跑（2026-10-19）**：用户那条 68 MB / 65 图会话的副本，2.2 秒、请求体 34.1 → 5.2 MB，所有行仍是合法 JSON，与此前被 Claude
成功续上的手工瘦身版逐行比对零语义差异。仅支持 Claude Code；其余家的会话格式不同，没有同类问题证据前不做。

### 2026-10-18 · 客户端接力：预检再发深链；对话级只有 Codex / Claude，其余不显示按钮

用户：Mesa 的对话和项目能在 Codex 客户端打开但常出错、配置绕，问九家是否都能在各自客户端无缝打开。逐家查源码后结论是**不能**，
按能力分档：对话级（精确打开某条）仅 Codex（`codex://threads/<id>`）与 Claude 桌面版（`claude://resume?session=<uuid>`，
Claude.app 2.42 源码里是「把 CLI 会话导入桌面版 Code 标签」）；项目级另有 Kimi（`kimi-code://open?root=&new=1`）、OpenCode 桌面版
（`opencode://open-project?directory=`，本机未装待实测），本期未做；Qwen / CodeBuddy 要起本机 Web 服务，Gemini / Cursor / Grok
没有可接的客户端（Antigravity 不读 Gemini CLI 会话、Cursor IDE 与 cursor-agent 存储分离、本机 Grok Bot.app 不是 Grok Build 的客户端），
这几家不显示按钮。依据与来源见 matrix §13。

定下的规则：①**客户端那边的失败 Mesa 看不见**（`open_url` 只要有处理程序就算成功，Model provider not found / 请先登录都是客户端自己弹），
所以判断全在发深链**之前**——`client_open_plan` 只读预检，`client_open_launch` 每次现算不信前端回传的计划，修复只能选预检候选里的连接；
②预检的结论只分 ok / note / warn / fix / block，**读不到的不假装知道**（读不到客户端库就不报「对话不在」，不读客户端登录态）；
③按钮文案如实写层级，项目级写「打开项目」，不冒充能定位对话；没装客户端就不显示；④修复就地完成：Codex 缺 provider 定义块时
弹层里「写入并打开」（沿用 `register_codex_client_provider_named` 的备份/原子写/回滚），连接页「注册到客户端」降为提前写与撤销入口；
⑤Claude 桌面版继续时用它自己的账号，不走 Mesa 里选的网关——预检给一条提示，不拦；⑥对话在 Mesa 终端里运行时警告两边同写；
⑦会话 id 与写进 TOML 的块名在后端校验（id 只放行字母数字连字符、块名只放行 `ccode` / `ccode-…`）；Codex 查客户端注册表取版本号最大的
`state_<N>.sqlite`，**不用 rollout 文件在不在判断**（本机 1395 条活跃对话的原文已压成 .zst）。

实现：`agent_specs.rs` 新增 `ClientSpec` / `ChannelPolicy`（一个 agent 可挂多个客户端）；`client_open.rs`（探测 + 纯函数 `build_plan` + 三条命令）；
前端 `client-open.ts` 纯逻辑 + `ClientOpenDialog.tsx`（`useClientOpen` 钩子 + 确认层），对话页底栏 / 右键菜单与工作台三处入口共用；
删除 `codex-client.ts`（深链拼接移到后端，单测随迁）。**设计稿 §P2 的 VS Code 扩展作第二客户端没做**：它的 `vscode://anthropic.claude-code/open?session=`
落在最前面的 VS Code 窗口里，按该窗口工作目录去 `--resume`，窗口目录与对话项目不同就找不到，Mesa 控制不了落哪个窗口。
待实测（需动用户真实数据）：`claude://resume` 导入一条走第三方网关的会话后桌面版的行为、导入是接管还是另起一份；Windows 上两家 scheme 的注册表探测。
设计稿 `docs/design-client-handoff.md`。

### 2026-10-18 · 快速开聊＝新对话，不弹窗；运行页「+」跟当前标签的目录

用户问快速开聊和运行页有什么区别、该怎么设计（两个入口开的是同一种标签，只差默认值；再点快速开聊会切回聊过的旧对话；
弹层三行和输入框里的选择重复）。用户拍板全按以下做：一，**快速开聊直达空白对话，弹层去掉**——侧栏、⌘K、工作台页头、导航岛同一条路，
选择全在输入框里（Agent · 连接 · 模型 · 思考、权限、文件夹默认随手聊），默认取上次快速开聊发第一句时的选择（不记文件夹和权限），
记住的连接失效就换同家另一条 / 上次启动的 / 装了的第一家，输入框里写着是哪条（取代 2026-09-06「直达只接受记住的那条，失效退回弹层」与
v3.171 ②「每次都先问我」）。二，**再点只复用还没说过话的随手聊标签**，聊过的开新的；每个标签自带 `quickchat:<uuid>` 复用键——
后端按复用键认 Run，共用一个键会让第二个标签接到第一个的 Run 上。三，仍是发第一句才启动（2026-10-17 用户选定不变）；终端那一面写一句
「在聊天里发出第一句时自动运行」，主按钮改「现在运行」（修订 v3.213「空态卡无说明小字」）。四，原弹层下半「继续上次」挪进聊天空态：
文件夹是随手聊时列最近 5 条，点一条接着聊并收掉空白标签（2026-10-17「输入框下面不列旧对话」对随手聊开例外）。五，**运行页「+」＝在当前项目里
再开一个 Agent**：目录跟当前标签走（原先一律主目录），当前标签在主目录或 Mesa 隔离目录（工作副本 / 工作树 / 定时隔离树）时仍开在主目录。
同日追加（用户拍板）：界面名「快速开聊」改为 **「新对话」**——按钮做的就是开一段新对话，和侧栏「对话」页成对，「开聊」偏口语。与项目里的「＋新对话」、
`/new` 同名同义、落点不同；默认文件夹与标签标题仍叫「随手聊」（那是地方，不是动作）。⌘K 保留旧搜索词，内部标识（`quick-chat`、`quickchat:`）不改。

### 2026-10-18 · 「正在回复」按确定的收尾标记熄灭；Codex 底栏模型只从屏上读

用户截图两处（快速开聊用 Codex 说一句「你好」）：一，回答早已显示，聊天层仍「正在回复 20 秒」。会话文件里 Codex 写了 `task_complete`，
本机又开着 Codex 的精确注意力、Stop 钩子也到了，但两处都映射成普通 `done`，前端仍要等 PTY 静下来 8 秒才收尾——内嵌终端里有重绘就一直等。
2026-10-17 只给 Claude 的 `turn_duration` 开了「确定收尾」（`settled`）。定：凡是写了回合级收尾标记的都判 `settled`——Codex `task_complete` /
`turn_aborted`、Kimi `turn.ended`、Cursor `turn_ended`、hooks 的 `Stop` / `AfterAgent`；没有这类标记的四家（Gemini / Qwen / CodeBuddy / Grok）
维持原口径。二，模型芯片显示「[14;5H好」：Codex 底栏「模型 档位 · 目录」原先从输出流里认，而 Codex 差量重绘、只重画变了的格子，
档位前面是输入框回显的光标定位和字。定：整行底栏只从 xterm 画好的可视区读（自下往上第一行），读回的名字须像模型名；拼帧尾巴不从转义序列中间开始。

### 2026-10-18 · 对话里的过程按「轮」收起，一步一行

用户截图对比别家软件：Mesa 聊天层的过程显示「太粗糙」——折叠条「过程 · 思考与 N 次工具调用」点开是斜体英文思考、原样 JSON 参数、
原样工具结果。定下：一，**以轮为单位**——用户一句话之后助手的思考、工具调用、中途说明收在一行「已工作 X 分 Y 秒」下（后跟「改了 N 个文件 ·
运行 N 条命令」、有失败加「N 步没成功」），过程之后的正文是回答、露在外面；默认收起。二，**展开是动作行，不是数据**——「编辑 文件名 目录 +2 −2」
「运行 说明 命令」「查阅 · 读了 3 个文件，搜索 2 次」「思考 · 8 秒」，点一行才出细节（差异 / 命令与输出 / 思考正文）；九家工具名按名字归类、
按常见参数键取对象（tool-activity.ts），认不出的照「调用 工具名」。三，**进行中的一轮不收起、不切回答**（聊天层传 working；最后一个调用没回结果
也算），做完自动收起——否则说到一半的正文会被当成回答、过程被收起，再出一个工具又弹开。四，失败不再拆成独立消息（取代 2026-10-17
「失败 / 权限确认 / 中断不并入」），改在行尾标「失败 / 被拒绝 / 已中断」并进收起摘要，免得一轮被切成几段。聊天层、对话页回放、项目对话预览
同一套；聊天层末尾「正在回复 · 秒数」只在生成中出现，与「已工作」不重复。细则 design-system.md「对话页三栏」条。

### 2026-10-18 · 沉浸阅读补齐九项：查找/目录、高亮批注记进笔记、笔记与 PDF 互跳、AI 起草、阅读会话收窄权限

用户看完沉浸阅读的待完善清单说「全部都做」。此前（v3.96 同日拍板）阅读区「不做扩展性功能，只做场景必需」；这九项是用户点名的
读文献刚需，按场景必需处理。定下：一，**标注不另建存储**——高亮与批注一行一条记进当前笔记的「## 标注」小节
（`- p.3 「摘句」 —— 批注`），PDF 上按摘句重定位画回，不存坐标、不进 localStorage：随笔记走 git、跨机器在、精读 Agent 读得到；
格式在 reader-note.ts ↔ reader.rs 双端镜像，lit-notes 技能与精读步合同把「标注」与「译段」「我的想法」并列原样保留。
二，**查找、标注、跳转一闪共用一套页文本口径**（pdf-search.ts）：页级计数与页内高亮按同一规则组装，第 k 处在两边是同一处。
三，笔记里的页码/图表编号可点跳 PDF（图表找行首图注），PDF 高亮可回到笔记那一行。四，八小节全空时笔记栏给「让 AI 起草」，
直发给右栏阅读会话。五，**阅读会话固定「请求批准」**（本机设完全访问也收窄），Claude Code 额外预放行 `notes/` 下的编辑。
六，阅读区里的状态栏不出 Commit & Push；顶栏题名从题录找真实题名（雷达下载的截断文件名也认）；悬浮译文卡只在 PDF 栏里展开；
笔记栏标题字号收一档。同日追加（用户问「最右边的 agent 栏能否把聊天层切换加上」）：右栏可切「聊天 / 终端」，
与终端页同一份标签 surface，缺省聊天层、选择跨次记住；这修订了 2026-08-18「右栏改为真实终端」——终端画面仍在，
只是不再是唯一形态。焦点在右栏时 Esc 一律归右栏（聊天输入框里误按 Esc 会连会话一起关掉）。用户随后截图两处问题：
简报字躺在 Claude Code 输入行里没发出去、聊天层却一直「正在回复」——根因是直接发送把正文和回车一次写进 PTY，被当成粘贴；
定下「直接发送一律走标签 sendMessage（pty_write_submit）」；用户复测仍「终端没发、聊天层显示已发出」，假网关 PTY 复现出第二个根因：
简报在进程刚拉起、还没进入读键状态时就写了进去——定下「拉起后的第一次发送先等 CLI 画出界面再安静 400ms」。窄栏里状态栏与输入框左下角叠字，改为按宽度收段、截断。
细则 terminal.md「沉浸阅读区」。

### 2026-10-18 · 换模型不写 CLI 全局配置；「等你确认」不再依赖 hooks

用户追问两件没做的事。一，在 Mesa 里切 Claude 的模型 / 思考档会改掉终端里 `claude` 的默认值。逐家实测发现不止 Claude：Codex（选择器，
而且列的是官方模型）、Grok 的 /model，Qwen、Kimi 的 /effort 都会写回各自的全局配置——Mesa 替用户敲的命令等于替用户改了 CLI 配置，
和「CLI 配置目录只读」相冲。定：这几样改成停下 AI、带新启动参数接回原对话（与换权限同一条路，`switch-strategy.ts` 记实测表），
代价是等几秒、接回时重读对话；启动时注不进思考档的组合退回命令并写明会存成默认；Gemini /model set、Grok /effort 不写配置，照旧中途切。
二，终端里等你确认时 Mesa 不提醒。收件箱「待确认」、标签黄点、系统通知早就有，缺的是信号——只认 hooks 精确注意力（逐家手动开）。
第三期已经能读屏认出七家的审批菜单，现在读屏认出的菜单（审批 / 信任 / 切换确认）直接算 confirm，七家不用装 hooks（OpenCode / Cursor 的审批菜单未核实），下游全部
沿用不新造通道；对话页与项目对话页签把「进行中」绿点换成「等你确认」黄点。hooks 保留：更准，且认得出 Mesa 之外终端里的对话。

### 2026-10-18 · 终端层与聊天层同步；聊天两张弹层收小、往下开

用户看了终端层问「需要同步加上什么」「本次是干嘛的」，定下「全部都做」。一，终端启动栏补「思考」「权限」两格，与聊天输入框
写同一份标签级选择——原先聊天里选的「完全访问」终端点运行照样生效，界面上却看不见，这是两层不一致里最危险的一处。
二，「本次」按钮删掉：它和左边那行身份文字说的是同一件事，而且卡里第一句「这次进程不会改，要换先停止」已经不对（模型 / 思考
运行中可切、权限可重开接回、连接可换了接着聊）。现在点身份文字打开「这次启动」卡，五样信息列全，换权限、换连接直接在卡里做，
复用聊天层与连接出错提示的同一套动作。三，⋯ 补「对话操作」，与斜杠面板 Mesa 组同源。四，底栏补上下文用量圆环。
不同步的：确认卡、实时预览、消息操作、排队、@ 引用——终端里 CLI 自己的界面就承担这些。同日用户还嫌聊天的权限菜单与模型菜单
「有点大」「应该在下面弹出」、权限菜单的「了解更多」去掉：两张弹层收到 19rem、行距字号收一档；方向按 `popover-side.ts`
——下面放得下（开聊前输入框居中）就往下开，贴底时只能往上。

### 2026-10-18 · 聊天层第三期：九家逐家抓屏，审批按原文给按钮、实时预览扩到六家

按设计稿用假 API + PTY 逐家跑「慢慢流出 10 行 / 回一个跑命令的工具调用 / 切换命令」三幕（`scripts/e2e-model-routing/chat-capture.py`），
结论见 agent-integration-matrix「聊天层第三期逐家抓屏」与设计稿 §7。定下：一，**工具审批在聊天层按菜单原文给按钮**——七家审批都是
带序号的菜单，方向键 + 回车都能选，但原先的「批准 / 拒绝」按钮写的是 y / n，Claude 2.1.292 按 y 根本没反应；现在这一轮没结束前一直
扫屏认菜单（排除用户刚发的编号清单回显），y / n 只在认不出时兜底。二，**实时预览按每家画面布局读**，加 Codex、Qwen、Gemini、Grok、
Kimi；CodeBuddy 拿掉（它生成中屏上只有转圈，原先挂着等于空转），OpenCode 不做。三，两处真问题当场修：Codex「帮我批准」
`--approve-for-me` 与 Mesa 默认的 `-s workspace-write` 同给时 Codex 拒绝启动，这一档原先根本开不了聊；Kimi 用接口连接时 `/model 别名`
只认它配置文件里的别名，聊天层不再给运行中换模型。四，读回补 Gemini「Model set to」、Codex 底栏模型、Qwen 底栏思考档；
CodeBuddy 中途换不了模型，不再读。五，抓屏脚本的教训：Claude 的连接在计划的 `--settings` 文件里，文件被清理后脚本曾去掉这个参数
继续跑，落回本机 settings.json，三次请求打到了真实网关（模型名不存在，400 返回）；现在文件不在就停下。

### 2026-10-18 · 聊天层第二期：输入框操作与消息操作，接上终端会话的两项

用户：「继续做第二期和第三期；另一个会话在改终端部分，你做聊天层，两边的适配你来做。」第二期按设计稿 §10 落地，
几处与稿子不同的定法：一，**排队没有撤回**——Mesa 不另设队列，发出即写进终端由 CLI 排队，「还没写进终端才能撤」的
情形不存在；排队气泡只标「排队中 · 这一轮结束后处理」，撤回去终端删。顺带修了乐观消息的放回位置：原先插在整页第一条
回复前，长对话里刚发的那句会跳到页顶，改为插在「发送那一刻还没有的第一条回复」前，排队的一律接末尾（`placePendingUsers`）。
二，**从这里分叉 = 简报截到这条回复**：`build_handoff_brief` 加 `until_text`，按正文认（聊天层只载入尾部几页，下标对不上全文），
认不出就报错，不悄悄给全文。三，**标签条 ⋯ 只在聊天层**：终端层已有启动行 ⋯，两处一样的按钮并排没意义。
四，与「Mesa内嵌终端优化」会话的接口：终端选中文字走 `onConversationInsert(tabId, text, {send})`（带 tabId 防击穿 memo），
父级按标签此刻在哪一层分派；`connIssue` 在聊天层是确认卡，优先级排在审批、信任之后、切换确认菜单之前，同家连接各一个
「换到 X，接着这段对话」按钮、最多三条（终端顶栏是下拉，聊天卡片照「等你决定」卡的一贯做法摆按钮）。

### 2026-10-18 · 聊天空态问候的标志去掉底板

用户：方方正正的图标放在问候上面不好看，像摆了个 App 图标；要保留图案。改为字标 `MesaMark`：从图标源
`src-tauri/icons/source/mesa-*.svg` 取 M 与光标两段路径，不要圆角底板、渐变和投影；M 用当前文字色，光标保留品牌琥珀
（深色底带余辉），viewBox 裁到图形本身、底边即基线，与问候同行按基线对齐，读作「M▁ 夜深了」；光标出现时有界闪三下
（沿用 `animate-pulse-brief`，不做无限闪）。「应用图标」设置不再影响这里。

### 2026-10-17 · 科研流程（英文综述）× 定时雷达 × 项目绑定审查修复（用户「全部都修，按推荐」）

用户要审查综述流程、与定时任务的衔接、项目专属 Agent 绑定。审查出 13 项，当日全修。
**雷达采纳链（最重）**：隔离树台账「没有才拷」只播一次 + 采纳整文件覆盖，隔离树与主仓一旦分叉就永久采纳
不了（同项目第二条雷达的采纳、整理为笔记写主仓收件箱、按巡检日补记都会触发；人删的行被写回；几轮未采纳只
能采纳一轮、余下成「幽灵待采纳」）。定：每轮以主仓为真源播种（收件箱/跟进/引文镜像、已见取并集、正典与积累账
镜像为关联推荐的只读种子），采纳＝主仓当前 + 本轮新增按条目追加（已见并集、跟进按待办、引文按键），排除只对
本轮新命中生效；采纳契约硬排除流程正典（`watch_path_denied`，旧 `papers/` 整目录把 included.md 等全放进了可采纳
范围）；PDF 只拷本轮新下且未被排除的（冻结证据记 `pdfsInitial/pdfsAfter`）。真实证据三份干跑通过。
随包 lit-watch 技能去掉写死的个人邮箱（mailto 取本机 git user.email）。**综述流程**：初稿/定稿出 Word 改由字体脚本
把 `reference-doc` 写进 YAML 的 format.docx（run 脚本原先不带 --reference-doc，出来是等线）；「整理为笔记」改写
`notes/excerpts.md`、精读工作区在跑才写工作区，不再替人提前建工作区；`same-ids` 跳过 `decision=excluded`、
`count` 加 `::except=`（handoff.md 不再自证「写了笔记」），精读进度不算排除篇；检索步 RIS 范围与存量来源两处矛盾、
定稿步编号、引用样式「开工先问」与流程线选择器两套时机统一到流程线；三套初稿步标「一起」（要问字体、人审初稿）；
综述初稿读 handoff 写作约束；沉浸阅读截图 `notes/assets/` 进合并豁免与开工接驳。**绑定**：未钉连接的定时任务
回落项目默认（解析塔 L4→L2，那家不能定时写盘或没设默认才回落设置页 AI 专用/最近使用，原因写进运行历史），
界面「自动」改叫「跟随项目默认」并写出实际会用的连接。另：依赖检查 quarto 能跑才算装好（本机 PATH 上是
conda 里缺 deno 的壳）、开工工具检查对 quarto-render 步骤预报；删掉前端已无调用、能绕过双台账写 included.md 的
`add/remove_included_entry`；验证中发现 git 2.55 中文环境把 merge-tree 说明行本地化、冲突文件名单混进「自动合并 x」，
改 `--no-messages` + 首个空行截断。**10-18 装好官方 Quarto 后补两处**：①字体脚本的 Word 主题换字体从没生效——
找字体槽结束位置时找到的是开标签自己，reference.docx 与成稿 Word 一直是 Aptos / 等线（「综述流程测试」的 draft/
review-final.docx 实测如此），改为找闭合标签并抽成 `theme_fonts` 加测试，run 脚本出的 Word 实测为 Times New Roman /
Songti SC；②官方 pkg 在 Apple 芯片上常建不出 `/usr/local/bin/quarto` 链接，`/Applications/quarto/bin`（及 Linux
`/opt/quarto/bin`、Windows `Program Files\Quarto\bin`）进解析候选，开工工具检查对「Mesa 找得到但不在 PATH 上」单独报。
细则：pipeline.md「台账播种与采纳合并」、agent-binding.md「日程未钉连接」、safety.md「整理为笔记」、environment.md「conda 里的 quarto」。

### 2026-10-17 · 命令面板重做：默认列表只放高频入口，其余靠搜索

用户问「命令面板需要优化吗」。走查结论：28 条里一半是主题（十四套 + 自定义 + 色卡），真正常用的新建项目、切项目、
设置分区、反馈 / 诊断都没有；键盘移到可视区外不滚动；拼音输入法确认候选的 Enter 会直接执行命令；切页与侧栏的快捷键提示
写死默认值。定下：一，`PaletteCommand.searchOnly`——设置分区（复用 `SETTINGS_SEARCH_INDEX` 的别名）、单个主题、第 6 个
以后的项目、外链只在搜索时出现，默认列表 = 快速操作 / 最近项目 / 页面 / 外观 / 帮助。二，搜索按得分排序，组按组内最高分排、
组内连续，不打散分组标题；设置分区靠别名命中时行尾标出命中词。三，主题收进「切换主题…」：同日用户嫌列表式「有点丑」，改为与设置页主题卡同长相的
7 列网格（深浅上下对齐、方向键四向移动、当前打勾；跟随系统时只列与系统同深浅的一排、走 `followedTheme`），
不做方向键实时预览（每按一次都会改窗口材质）。四，行首图标、选中只用底色（去掉左侧强调竖条，与右键菜单 /
帮助菜单同口径）、分组标题 l3 不加字距。

### 2026-10-17 · 侧栏课题行加 ⋯ 与置顶

用户拿 Claude 桌面会话菜单（Open in / Pin / Mark as unread / Rename / Fork / Move to group / Archive / Delete）问侧栏
要不要。逐项判定后落地：悬停 ⋯（右键不可发现）、置顶（单列「置顶」段，本机偏好）、「在终端打开」（替代 Open in，
访达已有）；重命名/移除本就有。不做：标为未读、分叉（会话概念）、移到分组（与「工作方式终身一种」冲突）、字母
快捷键（中文菜单不协调）。纯逻辑 project-tree.ts 配单测。

### 2026-10-17 · 帮助菜单四个应用内弹窗重做：反馈可附诊断包、检查更新就地安装、关于带许可页

用户：「帮助里在 Mesa 内部打开的功能——反馈提需求、诊断、检查、关于——优化 UI，看功能哪里还需要完善。」定下：
一，反馈的通道从「端点 > 直发 > mailto 自动降级 + 页脚四五个按钮」改为**用户在表单里选发送方式**（邮件应用 / 网页邮箱 /
邮箱直发，记本机 `ccode.feedback.channel`；没选过时配过直发用直发）；端点配置后不给选择、只走端点。页脚只留「复制全文」+
随方式变的主按钮。二，附件补上**诊断包**（表单内现导出，或诊断弹窗导出后「附到反馈…」带入）；直发与端点是真实附件，
后端按路径白名单自读（规则见 safety.md「诊断包随反馈出站」）；邮件应用 / 网页邮箱带不了附件，落盘后在交接提示里给打开入口——
网页邮箱此前直接丢截图，一并修。交接后由人点「已发出，清空草稿 / 还没发，保留」：Mesa 不知道外部邮件发没发，不替人清。
三，邮箱直发配置改「保存并测试」、结果就地显示（535 排查清单不进 toast）；首次保存失败回滚已写入的授权码，
「清除残留授权码」按钮随之删除。四，检查更新从「toast + 提示框 + 跳设置去装」改为弹窗内完整流程（检查中 / 最新 / 失败带
发布页出口 / 新版带更新说明、下载进度与安装），安装与设置 → 更新共用 `useAppUpdateInstall`；已知新版时菜单行尾标版本。
五，诊断弹窗日志按级别筛、计数、复制、本机时区。六，关于加图标、版本一键复制、更新状态（只读 store、不发请求，点开进检查更新）；
「开源许可与致谢」两处共用 `ThirdPartyNotices`：致谢与数据来源按阅读版式渲染，组件许可解析 gen:notices 的两张表可搜索
（清单格式一变 tests/third-party-notices.test.ts 先红）。实现时再次撞上「全站 `button { font: inherit }`」：弹窗里字号挂容器。

### 2026-10-17 · 连接加「模型分工」，九家别家模型适配二轮

用户：补齐槽位、子 agent 的规则要在连接里看得见、能自定义；其他 CLI 的连接配置一起修到正确，别家模型也能适配。定下：
一，绑定加 `role_models { small, subagent }`，连接表单「模型分工」只对能分开指定的家显示（Claude Code / Grok / OpenCode），
Claude 下附四个别名的实际指向。二，假网关逐家抓线上参数（`E2E_EFFORT=high`）后修：Grok 用户全局把会话标题 / 摘要指到另一家网关的
模型（本机实例），overlay 钉成分工或主模型；Grok 对未声明档位的别家模型无视思考参数、CodeBuddy 自定义端点不发思考字段——两处都改为
不给档位而不是摆个没用的；Claude 对能力库确知不会思考的模型不发 thinking；权限探查补 Grok（本机 `permission_mode = always-approve`）。
三，Gemini 认证方式不对时启动前拦下（见前条）。Qwen 的思考档只有 /effort 与它自己的 settings（本机 `model.reasoningEffort = xhigh`），
启动注入够不到，维持「运行中切换」。

### 2026-10-17 · 各家 CLI 模型配置端到端核对

用户问 Mesa 在各家 CLI 里能否正确配置模型。做法：`agents.rs` 的 ignored 测试 `e2e_dump_launch_plans` 按假网关生成真实启动计划，
`scripts/e2e-model-routing/` 用它拉起本机各家 CLI（HOME 换临时目录、拷入用户真实配置），看假网关收到的请求。结论：Claude Code、
CodeBuddy、Codex、Qwen、Kimi、OpenCode、Grok 的请求都带「这次选的」模型、打到各自协议路径；Cursor 第三方网关按设计拒绝
（只认 cursor.com 钥匙）；修两处——①Claude：用户全局 settings.json 的 HAIKU 槽与子 agent 模型会漏进 Mesa 会话（会话标题、
子 agent 请求带着全局 glm-5.3），改为四槽全填、子 agent / 上下文窗口在用户全局设了时盖掉，修后全部请求带所选模型；
②Gemini：认证方式不是 API Key 时注入全被无视、带地址时报 Invalid auth，系统设置层要 root 走不通，改为启动前只读检查并说明改法。
另：Codex + GLM 的 Responses 槽（open.bigmodel.cn/api/v1）未带钥匙时回 HTTP 200 + 非 OpenAI 格式错误体，是否真支持 Responses 协议待用钥匙实测。

### 2026-10-17 · 内嵌终端两项：选中文字交给对话、连接出问题换连接接着聊

用户澄清要的不是对标 iTerm，而是 Mesa 终端能做、普通终端做不到的事；从十个点子里选了「选中终端文字直接交给对话」和「出错时换个连接
接着聊」。前者：选区浮条 / 右键加「引用」「问 AI」（交父级按当前层分派，由「聊天层」会话负责）和「存进笔记」（项目 notes/clips.md，
不混进文献摘录，编程项目不给）。后者：用假网关回 429（GLM 额度原文）/ 401 / 500 把七家的报错画面实录下来，按形态识别并分类，
终端顶栏与聊天确认卡给「换这条接着聊」，实现为先换连接再停下、按原会话接回（与换权限同一条路）。Qwen 重试期间屏上无任何报错，
认不出，如实写进说明书。两边接口（`onConversationInsert`、`connIssue`、`switchConnection` / `dismissConnIssue`）与聊天层会话当面约定。

### 2026-10-17 · 内嵌终端逐家实测：Shift+Enter、⌘ 行编辑键、信任菜单三处补齐

用户澄清：原以为 Mesa 内嵌终端就是 iTerm，问的是内嵌终端在用 Agent CLI 上要优化什么。内嵌终端是 Mesa 自己的（xterm.js 6，
和 VS Code 内置终端同一内核），与本机装哪个终端无关。按 Mesa 的真实应答口径（假网关 + 应答 DA1 / XTVERSION / kitty 查询 /
DECRQM）把七家 CLI 在 PTY 里实测一遍：协议能力正常（Claude 自己的调试日志确认 kitty 键盘、同步输出都开了；⌥← 七家都按词跳），
找到三处不如 iTerm 的地方并已修：一，Grok、CodeBuddy 按 Shift+Enter 直接发送（两家不推 kitty），改写为 ESC+CR；二，⌘← / ⌘→ / ⌘⌫
只有 Claude 认，改写为 Ctrl+A / E / U 后七家全部生效；三，Kimi、CodeBuddy（及 Gemini）的信任菜单聊天层认不出，扩展识别并只选
范围最窄的「只信任这个文件夹」，Kimi 的代答回车改用 CSI-u。未实测：Gemini（本机走 Google 账号登录）、Cursor（第三方网关拒绝启动）。
测试脚本沿用 `scripts/e2e-model-routing/` 的假网关。

### 2026-10-17 · 外部终端（iTerm / Ghostty）里用 Agent CLI 的三处补强

用户问用 iTerm 时 Mesa 这一块要完善什么。核对发现本机未装 iTerm2，在用的是 Ghostty（`tauri:dev` 就跑在 Ghostty 里，
Mesa 外部终端设置也是 Ghostty），以下三条两种终端都适用。一，外部终端里正在跑的对话，Mesa 里点「继续」会再起一个进程续写
同一段记录，现先确认。二，「复制恢复命令」原写「粘贴到任意终端即可」不实：命令不带密钥、用终端全局配置，改为如实说明并在
Codex 需要密钥时点名。三，iTerm 打开逻辑：认 `~/Applications`，命令写进新建的窗口。另记两件未做、待拍板的：Mesa 里切 Claude 的
模型 / 思考档会写进 Claude 全局默认（`effortLevel` 等），终端里新开的 `claude` 跟着变；外部终端里的对话等确认时 Mesa 不提醒。

### 2026-10-17 · 聊天层第一期落地：权限四档、模型 · 思考单菜单、对话末尾确认卡

用户确认设计稿后开工。权限菜单收成「只讨论 / 请求批准 / 帮我批准 / 完全访问」，注册表 `permission_args` 的 `auto_edit` 档换成
`auto`（各家 AI 自判断模式）；本机设置不再是一档，`cli_default_permission` 增加 `tier` 字段标出对应档。走查同时发现 Codex 的
本机提示不实：Mesa 启动 Codex 一律带 `-s workspace-write`，本机 `danger-full-access` 被盖掉，原先却报「完全访问」——改为只看
`approval_policy`。模型 · 思考合成 `ChatModelMenu`（原 `ChatLaunchPicker` / `ChatModelChip` 删除），顶行 Agent · 配置二级、模型带
能力灰字、思考分段控件。三种顶部横条合成对话末尾的 `ChatDecisionCard`。细则见 design-system「输入框三芯片」。

### 2026-10-17 · 聊天层定位为「九家 CLI 外面的统一客户端」：设计稿待确认

用户拿 ChatGPT 权限菜单（请求批准 / 帮我批准 / 完全访问）说：聊天层就像 Codex、Claude 客户端，可以切模型、思考强度、
访问权限、添加操作，需要完善的设计。设计稿 `docs/design-chat-layer.md`（附视觉稿 `docs/design-chat-layer-mockup.html`），
要点：三原则（一个控件对应一个已核实的 CLI 机制、终端是事实来源、同一件事只放一处）；权限收成四档并接入各家
「帮我批准」模式（Claude auto、Codex --approve-for-me、Qwen auto、Cursor --auto-review、Kimi --yolo…），本机设置不再是一档、
改为在对应档上标注；模型 · 思考开聊前后同一个单栏菜单（思考用分段控件）；三种「等你决定」横条合成对话末尾的确认卡；
「+」加文件 / 引用项目文件，「/」分 Mesa 操作与 CLI 命令两组；消息悬停操作、排队、上下文用量圆环；各家能力矩阵按 ✓/△/✗
标明核实程度，分三期落地。设计期间顺手修了三处缺陷：斜杠表键 `claude` ≠ agent id `claude-code`（Claude 用户只剩 /help）、
完全访问启动时的 Bypass 警告聊天层无按钮（启动后 20 秒识别确认菜单）、菜单下方按键提示行被当成选项。实测另得：
Claude 2.1.292 的默认权限已是 auto，`--permission-mode default` 显示为 manual。

### 2026-10-17 · 聊天层三轮：thinking 误认成模型、长回复预览中断、运行中换权限

用户截图：模型芯片写着「thinking」；长回复显示一半后预览消失；发完消息权限改不了。原因与定下：一，模型读回去掉「X with
LEVEL effort」句式，转圈行「thinking with high effort」同句式，只认「Set model to X」。二，长回复开头滚出可视区后预览读不到锚点
返回空，改为续行按重合接到上一次后面（本机假 API 抓屏实录长回复画面）。三，权限运行中可换，实现为停下再按原会话恢复，确认框
写明会重开、生成中不可点；不做进程内切换（各家机制不一，Claude 的 shift+tab 循环读不准当前档）。四，截图里「加载更早的消息」+ 只剩
一句提问：Claude 每轮写一行几百 KB 的 prompt_snapshot，分页首屏改为至少 6 条消息才停。

### 2026-10-17 · 聊天层二轮：命令行渲染、模型读回、五档权限、实时预览

用户截图：切完模型，聊天里出现 `<command-name>` 标签原文和 ANSI 乱码；要求清单全做、各家权限开关加上且完全访问二次确认、
「看实时输出」时终端比聊天层先显示体验不好。定下：一，Claude 斜杠命令与本地输出在解析层拆成 command / command_output 块，
聊天渲染一行「命令 + 结果」，本地命令输出算回合已结束（不再转圈）。二，模型以屏上读回为真值，切完未读回标「待确认」。
三，权限徽标五档，后三档用各家原生启动参数、只作用本次命令行；完全访问必须二次确认、不进持久化。四，Claude Code / CodeBuddy
生成中从终端画面抽出正在写的段落画进聊天层，会话文件追上即让位，取代「看实时输出」。依据是本机用假 API + PTY 抓 Claude 2.1.292
真实画面（含中途换模型 / 换档的确认菜单）。另记：Claude 的 /model 会写它自己的 settings.json 默认模型，弹层明说，不替用户改回。

### 2026-10-17 · 聊天输入框照 ChatGPT 摆法：右下「模型 · 思考」、左下权限徽标、切换后的确认搬到聊天层

用户拿 ChatGPT 输入框截图问：开聊后想换思考档怎么换；切换档位时终端有时会要你确认。改成三件事。一，Agent · 模型 · 思考档
从左下挪到发送钮左边，开聊前是选择器，开聊后同一位置是「模型 · 思考」芯片，和终端底栏共用一份逻辑
（`runtime-model-effort.ts`），聊天变体底栏不再重复摆。二，权限从选择器弹层里拿出来，做成左下徽标；本机放开权限时徽标直接写
「完全访问」并用提醒色，开聊后只读。三，切换命令写进终端后扫屏 5 秒，认出 CLI 弹的确认 / 选择菜单就在聊天顶部列成按钮
（`tui-menu.ts`），不替用户选；写命令前记一份屏上基线，防止对话记录里的多行提问被误认成菜单。只能在 CLI 选择器里选的
（Codex 模型等）直接露出下方终端。细则见 design-system 开聊前选择那一条。

### 2026-10-17 · 聊天开聊前选择器补「思考」与「权限」

用户问：聊天页设置不了推理强度、思考开关和各家 CLI 的权限程度，该怎么设计。我给了建议，用户选「按建议做」，内容有三条。一，思考强度加在
选择器第四栏，和开工弹层用同一个 combo 判定，只作本次覆盖，调不了就不显示。二，不单独做思考开关，档位里本来就含关闭那一档。
三，权限只做「可以改文件 / 只讨论」两档，沿用 Mesa 的统一口径；不做各家原生权限模式的开关，原因是各家语义不同，「全部自动批准」
也不该一点即开。但会只读探查本机设置，如实提示一句。排查时发现用户本机 Claude 设了 `defaultMode = bypassPermissions`，这正是
前面截图里 TUI 显示「bypass permissions on」的来源，并非 Mesa 打开。细则见 design-system 开聊前选择那一条、profiles.md 思考档优先级。

### 2026-10-17 · 「新建项目」与「添加已有文件夹」分开

用户发现目录菜单里的「新建项目…」弹出的是系统选目录窗：它复用了「添加项目」的入口，而那个入口先选已有文件夹。现在两条路分开。
新建走 `newProjectOpenReq`，打开 AddProjectModal 的新建形态：填项目名（同时作文件夹名），位置默认系统「文档」，可以更改；
选好工作方式后先建文件夹，再走同一套注册（编程项目初始化 git、科研项目扫描资源和挑模板），不另写一份。侧栏「＋」也同步拆成
「新建项目… / 添加已有文件夹…」。同日追加：从聊天或终端标签发起的新建，建好后回到原标签并把目录换成新项目（`tabCwdReq`），跳过建后的模板弹窗，模板留到项目页再挑。

### 2026-10-17 · 聊天空态五轮：目录芯片代替「将在 ~ 开始」，输入框下只留起手提示

用户提了两点：「将在 ~ 开始」应该是选项目或新建项目；输入框下面的噪声可以去掉，留下我认为需要的。改动是：「将在 ~ 开始」换成
目录芯片，写项目名、随手聊或主目录，点开是终端空态卡那张目录菜单，并新增「新建项目…」；开聊后芯片不再显示。输入框下面只留
起手提示；「N 段对话 · 接着上一段」整块删除，连同对话清单逻辑和测试。恢复占位标签的「上次的对话还没接回」保留，因为它是这个
标签自己的状态，不是导航。

### 2026-10-17 · 聊天空态四轮：品牌标志加问候，整组收窄；对话清单就地展开

用户提了两点：「N 段对话」点了不应该跳到别的页面；整体还是空旷。现在点「N 段对话」在原地展开一张小清单，只列有标题的对话。
空旷的问题给了三个方向，用户选「品牌标志 + 问候，整组收窄」：输入框上方放 Mesa 光标图标和一句时段问候，问候、输入框和下方一组
统一收窄到 45rem 居中。v3.214 否决的是居中写引导语、和占位文字重复；问候只是问候，不算重复。规格见 design-system「聊天空态内容」。

### 2026-10-17 · 设置页逐分区细化（用户「全部都做」）

用户贴了十张设置页截图，要看每项功能是否完善。逐分区审出缺陷、布局和缺功能三类问题后，用户拍板全部做。确立的规则：
分区标题升一档；下拉只留三档宽；高控件行标签顶对齐；卡内条件动作固定占位。低频编辑器默认收起，信息性内容进说明卡，
不占设置行。设置分区「统计」改名「用量」，与侧栏一致，id 不改。细则见 design-system「设置页细节口径」。
新增三项能力：
- **主题跟随系统深浅**：`themeFollowSystem` 缺省关。theme 始终写成生效值（同名 twin），窗口外观交还系统，自定义配色不跟随。
- **用量里查不到价格的模型**：`usage_unpriced_models`，订阅额度不列。
- **本机占用补列工作副本与总计，并可就地清理**：`clear_storage_entry` 走白名单、移回收站。

实现时核过三项可清理条目，否决了原「快照 / 备份 / 缓存可以直接删」的说法：备份里有连接页「恢复初始状态」要用的首次写入前
原样；Codex 模型目录被「设为全局默认」写进了 `~/.codex/config.toml`。白名单目前只放会话快照。
另一处纠偏：灵动岛设置并非只在「完全隐藏」启动形态下生效，运行中用快捷键隐藏侧栏同样会用到，所以不做置灰，只改说明。
同日用户看截图追加两处：「本机占用」的「清理」改为每行固定占位，不再只在快照一行出现，大小列因此对齐；「Mesa 内部对话」卡收成
卡头一句加一行「自动清理」。「关于」再收一轮：GitHub 与开源许可改成身份卡右侧链接，致谢与数据来源并进许可浮层，隐私压成页脚
一句。关于页承载的内容一项没少，只是降了层级。

### 2026-10-17 · 聊天空态三轮收敛：输入框居中，不做第二个工作台

用户截图问：二轮的空态（最近对话 5 条加「换到项目里聊」）会不会做成第二个工作台。判断是会。它和工作台的「最近对话」重复，项目跳转
本来归工作台和侧栏，换目录在输入框里也已经有入口。我给了三个方向，用户选了输入框居中。空态现在只回答「这一段对话怎么开始」：
输入框放在中线偏上，下面是一排起手提示，再加一行「这个目录还有 N 段对话 · 接着上一段」。「换到项目里聊」连同它的逻辑一并删除。
规则见 design-system「聊天空态内容」。

### 2026-10-17 · 运行页默认聊天层；聊天空态二轮；模型名单按连接分开

用户提了三点。第一，点到运行页默认显示聊天层：`DEFAULT_SURFACE_MODE` 从终端改为聊天，推翻 09-02 的终端默认；纯 shell、脚本、
登录标签仍显式落终端。恢复占位标签在聊天层直接发送时，会先接回原会话再写入。第二，聊天空态上半屏太空：整组改为垂直居中，
最近对话放宽到 5 条，补「这个标签上次的对话」和「换到项目里聊」两块。第三，模型名单里有一堆不属于这份连接的模型：原因是
手填历史按 Agent 混记，现在改为按 Agent + 连接分开记；新标签从上次启动带来的模型，如果不属于当前连接，也换回这份连接的默认模型。

### 2026-10-17 · 聊天层开聊前选 Agent / 模型；快速开聊改为落聊天空态

用户问：聊天层启动会话前怎么选 Agent 和模型，和「快速开聊」是否冲突。我给了三个方案：输入框里直接选、只加一个跳去终端的入口、
只在快速开聊里选。用户选了第一个。具体做法是在输入框底栏放三栏选择 `ChatLaunchPicker`，和终端启动栏共用同一组写入函数。
快速开聊改为不自动启动，打开后停在聊天层，发出第一句时才启动。这推翻了「快速开聊显式 autoStart」的旧口径。规格见
design-system「聊天空态」条。

### 2026-10-17 · 聊天层显示与同步修三处（用户截图）

一，文本被折成一串空标题：冒号行一律当小标题，且默认只展开第一节。改为只有长回复才分节，并且默认全部展开。二，「正在回复」
永不熄灭：Claude 的状态行一直重绘，PTY 永远不静止。改用 Claude 每轮写入的 `turn_duration` 作为确定的收尾标记（`settled`）。
三，正常开聊也弹出半屏终端：8 秒卡住判定之前从来不触发，上一条修复让它开始触发，却没区分「模型在思考」和「卡在菜单上」。
现在加上 PTY 静止 4 秒的条件，因卡住而自动拉起的终端在会话接上后也会自动收回。另外把「正在写盘」改成「正在生成回复」，
并加了「看实时输出」。细则见 terminal.md「聊天层收尾与卡住判定」、design-system「聊天长回复分节」。

### 2026-10-17 · 聊天层代答启动信任菜单 + 修「8 秒卡住出口」从不触发

用户在主目录用聊天层发第一条消息，Claude Code 先在终端弹出「是否信任这个目录」菜单，聊天层一直停在「已送出 / 等待会话文件」。
原设计的出口是 8 秒无会话文件时拉起终端，但判定要求 `messages.length === 0`，而聊天发送会先乐观显示用户那条消息，所以这个出口
从来不触发。本次两处都修了：一是判定改为只有用户自己刚发的消息就算卡住；二是在会话文件接上之前读终端屏幕，认出信任菜单就在
聊天层给按钮代答。新版菜单默认高亮在 No，所以代答必须按当前高亮算出方向键，不能直接按回车。细则见 terminal.md「启动信任菜单在
聊天层代答」。

### 2026-10-17 · 聊天空态：最近在这个目录 + 试试

用户截图说聊天终端的空白页太单调，问该做什么设计。我给了四个方向，前提是都避开 v3.214 已否决的两种做法，即居中引导语和点阵。
用户选了「接着聊 + 起手提示」：贴在输入框上方，上面是本目录最近三段可恢复的对话，点一行在新标签里恢复；下面是按目录类型给的
三到四个起手提示，点一下只填进输入框，不替用户发送。其余三个方向是只放提示、只放对话、品牌水印加问候，均未选。规格见
design-system「聊天空态内容」。

### 2026-10-17 · 弹窗与表单统一 + 用量页改版

用户要求「其他弹窗和表单也统一优化」及用量页 UI/功能优化。弹窗：53 处旧式本地按钮（rounded-sm px-3 py-1.5 text-sm，
9 种变体）批量换 PageFrame 共享类，新增 `quietActionClass`（弹窗页脚低调动作，32px）；Modal/Sheet 关闭钮由文字「×」
改 Lucide X、页脚去分隔线、新增 `layer="overlay"`（z-60）；6 个自建遮罩对话框（连接远程、人工请求、Zotero 导入、
接续确认、创建 PR、归档工作区）迁入 Modal——此前缺 Esc 关闭/焦点圈闭/焦点归还；表单提交钮在页脚经 form 属性接回。
两处逐字复制的输入框类换 fieldClass。用量页：六个分布页签（新增「模型」，原页底单独折叠表并入）统一为一种行
（DistList：名称+说明 · 占比条 · tokens · 占比 · 费用），去掉表格分隔线；项目表静默 slice(0,20) 改为先露 10 行 +
「显示全部 N 项」；Agent 行下钻对话页（sessionScopeReq kind:agent）；新增「复制表格」（TSV 到剪贴板）；总览卡次要指标
由一句长话拆为 KpiStat 小格；分区小标题 l4→l3（卡面对比度底线）。纯逻辑 usage-dist.ts 配单测。未做实机验收。

### 2026-10-17 · 恢复会话前核验已落盘（修「继续工作」报 No conversation found）

工作台「继续工作」恢复测试项目时，Claude Code 报「No conversation found」并以 1 退出。查 Run 记录，这条 Run 前一天启动后 3 秒就被
停掉，Claude 在第一条消息前不落盘，于是 Run 上记着预分配的 `--session-id`，盘上却没有这段对话，此后每次恢复都失败。
修法放在所有恢复入口共用的 `pty_spawn`：先核验会话文件，确定不存在就在原目录开新会话，并把 Run 的会话换成新 id，
终端提示一句。只判布局已核实的 claude-code 和 codebuddy，其余照常恢复。用户在开发窗口点了一次，新代码在这条真实 Run 上
记下 `run.session_replaced`，新会话正常启动。细则见 terminal.md「恢复前核验会话已落盘」。

### 2026-10-17 · 二次确认框统一改版（全站 126 处）

用户截图「清除 Mesa 痕迹」确认框要求优化。问题：标题/清单/注意整段同字号靠 \n 排版；「保留 / 可找回 / 彻底删除」
三种后果同色；危险按钮是淡粉小块「确认」（用的是状态 pill 配方 bg-err+text-err-text），说不清后果；危险操作默认
焦点在确认，一个回车就执行。不逐处改 126 处文案，组件自动结构化（parseConfirmMessage：标题/对照表/注意条，后果
语气着色；inferConfirmText 从标题取动词作按钮字），新增 PageFrame `dangerActionClass`（实心 err-text + canvas 字），
**危险操作默认焦点改为「取消」**（行为变化：危险确认框按回车不再执行，需点按钮或 Tab 过去）。自建删除弹层（技能、
MCP、对话批量删除内联二段确认）同步换危险钮、技能删除弹层焦点改给取消。口径入 design-system「二次确认框统一口径」。

### 2026-10-17 · 设置页全面优化 + 「应用图标」外观设置

用户要求加一个手动切换深浅应用图标的设置，同时对设置页做一次全面优化。**应用图标**：放在外观分区，三选一，选项是跟随系统、
深色、浅色，只换运行中的程序坞、任务栏和托盘图标（app_icon.rs）。打包图标仍由系统决定，所以文案要如实说明 Finder 和
启动台不受影响。这条推翻了同日「不做运行时换图」的口径，属于用户明确要求。**设置页**：骨架不变，仍是左分类、右单分区。
重排了归属：终端相关行从外观拆出，单独成「终端」分区，外部终端和自定义运行时也并进去，后者原先错放在数据与存储；
「启动行为」改名「通用」，收入系统通知和顶部灵动岛小节；「集成」改名「AI 与 Agent」，收入想法期只读保护；
brew 镜像挪到网络；统计挪到管理组。分区 id 全部不改，深链和记忆都不受影响。组件上统一为三种结构，即 Row、SubHeading
和 Card/CardRow，组的总开关进卡头。还补了这几处：分区说明行、导航图标、ⓘ 悬浮说明、可关闭的吸顶结果横幅（统一计时，
修掉了后一条提示被前一条计时器提前抹掉的问题）、关于页身份卡，以及定价卡的空态。规则见 design-system「设置页分区」
「应用图标」，说明书 §13 已整章重排。

### 2026-10-17 · 应用图标换为「光标 M_」，macOS 按系统外观切深浅

旧图标是通用终端 `>_`，看不出是科研产品。几轮比稿后，用户否决了场景类和装饰类方案（台地日落、光谱、节点网络、
星芒等，理由是「太花哨」），也否决了纯字母方案（「太素」），最终选定：几何 M 加一枚基线上的琥珀色光标。光标保留
「Agent 控制台」的来历，单字母瓷砖的结构对标 Zotero 和 EndNote。用户追加要求深浅两版都保留，按外观切换。macOS 26+
用 Icon Composer 文档做外观特化，预编译成 Assets.car（tauri 拷进包后写 CFBundleIconName），旧系统回落 icns。
Windows 和 Linux 没有系统级的深浅图标机制，统一用墨底版，不做运行时换图。打包时不跑 actool，因为 tauri 子进程的
stdin 是关着的，actool 会报 Bad file descriptor。规格、源文件和重生成命令（`npm run gen:icons`）见
design-system「应用图标」一节。

### 2026-10-17 · 顶栏左侧与灵动岛按侧栏形态分工

用户提：侧栏改了，顶栏的项目/运行中是否该优化，「有用而不是没用的展示和重复入口」，并完善隐藏侧栏的灵动岛。
审查：展开态下顶栏项目名与「N 运行中」都和侧栏重复；「N 运行中」只跳页、看不到谁在等确认；contextLabel.step 从未
被写过（死分支）；岛休眠面的跑完播报鼠标点不到（指针进岛即展开、休眠面被藏）；岛上「项目」挂收件箱角标与顶栏右侧
重复；全隐藏后无处切项目。定稿（规则抽 shell-context.ts 配单测）：展开态顶栏左侧留空、等确认信号落侧栏运行行；
图标态顶栏给项目芯片（不在项目页时）+ 活动芯片；全隐藏项目芯片常驻、活动进岛。活动入口统一 RunActivityButton
（agent 列表、待确认排首、点行直达标签），运行计数单一出处 useRunActivity。岛：活动胶囊与播报在两副面孔各一份、
去掉导航角标及其死样式。浮层 portal 到 body（岛的 transform/backdrop-filter 会劫持 fixed 定位）。说明书 §1.1 补了
此前完全缺失的顶栏左侧与灵动岛说明。未做实机验收。**同日用户拍板修订**：图标态侧栏文件夹改为纯「去项目页」（与其他侧栏图标同语义），切项目只留顶栏项目芯片一处；为此
图标态芯片由「不在项目页才出」改为常驻（否则项目页里无处切项目）。RailProjectSwitch 删除。**灵动岛休眠面改版（同日用户拍板「你来设计」）**：休眠面由「只有一颗恢复侧栏」改为纯状态——当前页标签 + 只读活动
（RunActivityStatus）+ 只读播报；恢复侧栏挪到展开面居首。原则：休眠＝状态、展开＝操作；项目归顶栏芯片不在岛上报。
播报点硬编码 #3fb950/#f85149 换 ok-text/err-text 令牌（浅色主题对比）。测试 nav-capsule.test.ts 改为切出两副面孔断言。

### 2026-10-17 · 侧栏二轮：补功能缺口 + 玻璃态一致性 + 透明度设置

用户要求菜单改完后审查侧栏还缺什么、玻璃态下搜索框相应改、并优化「侧栏 / 顶栏透明度」。审查出并落地：① 运行页
原先只在有 agent 跑时才有入口（平时只能 ⌘3）→ 常驻，在跑时行尾绿点+数，图标态右上角绿点；② 图标态项目树不可见、
课题完全不可达 → 加 RailProjectSwitch 文件夹按钮弹分组课题菜单；③ 项目树外层非 flex 列，课题多时被 aside
overflow-hidden 裁掉且不能滚动 → 父容器与树根都改 flex 列；④ 在别的页时课题行仍铺选中底与系统段「双选中」→ 仅项目页
铺底、其余页只加粗；⑤ 分组折叠记忆；⑥ 「⑂」字符换 Lucide 终端图标；⑦ 对话移回工作入口（它是干活的页，不是系统设置）。
玻璃态：搜索框弃 fieldClass 实心底，改 `.ccode-rail-search` 前景色薄雾（不随透明度档缩放——它是控件不是罩色，0 档
也得看得出是个框），课题 >5 个才出搜索；侧栏加 0.5px 内描边玻璃边缘。透明度：下拉改六格分段按钮（短标签
chromeOpacityShortLabel，完整说法进 title），档位白名单与 Rust KNOWN_CHROME_OPACITIES 不动、默认仍原样（scale=1
逐字节还原不变式保留）。未做实机验收，交用户按清单核对。

### 2026-10-17 · 右键 / ⋯ 菜单统一改版（全站 25 处）

用户截图项目树右键菜单要求完善「这种很多的 UI」。问题在共享组件 ContextMenu：text-sm 偏大、整行贴边无圆角、
恒留一个空状态点位（纯文字菜单凭空缩进）、无图标、危险项与普通项混排、不能键盘操作。定稿：组件对齐顶栏帮助菜单
视觉（p-1 面板/行内圆角/xs/13px 图标列按需出现），新增 `icon`/`hint` 字段，危险项自动沉底分组（纯函数
`normalizeMenuItems` 抽到 `src/context-menu.ts` 配单测），键盘导航；随后逐个菜单补图标并理顺顺序——连接行菜单
按「验证/预览/刷新 → 停用/默认/复制 → 外部写入 → 解绑」重排（原解绑夹在中间、验证沉底），技能行菜单分四组且删除
补 `danger`，文件树删除补 `danger`、两处文件菜单补齐「在访达中显示 / 复制路径」，项目树右键加「在访达中显示」，
`revealFolderLabel` 抽到 path-utils（显式传平台）。**当日补漏**：对话页回放头部 ⋯、列表行右键、「移到卡片…」三处是页内手写浮层（不走 ContextMenu，按组件使用方清点时漏掉）
→ 全改走 ContextMenu（字符图标 ⇗⧉◈⚑ 换 Lucide、AI 动作 hint、删除标 danger；「移到卡片」由屏幕居中改为就地弹在右键
位置、当前卡打勾）；附带修复「复制恢复命令」的「已复制」反馈写在菜单项上、菜单一点即关所以永远看不到 → 改 toast。
清点口径补一条：除 `<ContextMenu` 使用方外，还要搜 `ccode-float-surface py-1` / 本地 `menuItem` 常量这类手写菜单特征。菜单文案去掉 ◈ ⛶ ◫ ✦ 前缀（步骤菜单「◫ 定位目录」→
「在终端定位目录」，AI 动作改 `hint: "AI"`）。口径入 design-system「右键 / ⋯ 菜单统一口径」，说明书 §1.1/§3.1 同步。

### 2026-10-16 · 侧栏工作台化（项目列表上移侧栏，项目页拆内层栏）

用户提：侧栏完全是一个路由、项目模块还有自己的项目侧栏（双层导航）。定稿：侧栏＝品牌区 + 快速入口（工作台 ⌘1 /
快速开聊＋右键历史 / 有 agent 跑才出现的「N 运行中」）+ **项目树**（ProjectTree：「项目」标签行含 ＋ 添加、搜索框、
按工作方式分组的课题列表含「未添加」仓库段、行右键全套管理动作）+ 系统段（对话/连接/技能/MCP/用量/设置）；
快速入口贴品牌区、项目标签在搜索框上面（用户逐条拍板的顺序）。主区回到 **page 驱动**：workbench=概览、
workspaces=选中课题详情——选中仍是 `selectProjectReq` **一次性请求**（项目页消费选分组后清空，与收件箱/对话页/
统计页跳转同一条链），**禁止再拿它当持久选中态渲染**（当日事故根因：曾据此条件渲染 WorkspacesPage，请求一被
消费就弹回工作台、树点击又只改请求不切 page，两向都跳不动）。持久选中镜像用既有 `contextLabel.projectPath`
（项目页唯一写入方）喂树高亮，单一事实源。WorkspacesPage 内层 208px 项目栏整体拆除（收起开关/课题名切换下拉/
栏行右键随之消失），管理动作迁入 ProjectTree 自持（动作后 `loadProjects` + 新增 store `projectsVersion` 代数通知
项目页与树重拉）；「＋」是两项目菜单——「添加项目…」经 `addProjectOpenReq`、「✦ 创建示例课题」经
`demoProjectOpenReq` 一次性请求交项目页（完整注册流程与创建逻辑仍在那），并先
setPage("workspaces") 保证消费方已挂载。RenameProjectModal 拆独立文件（页面是懒加载 chunk，树静态引入会把
整页拖进主包）。navigation.ts 恢复九页全量——侧栏不按它渲染，但隐藏态胶囊/设置页导航项目/快捷键页序都吃它，
删页会静默弄坏三处（当日就删过）。树行状态点只保留绿点（「此刻在跑」，复用 projectRailStatus），待处理黄点
归顶栏收件箱不在树里重复计算。文档同步：user-guide §1.1/§3.1、code-structure、design-system 导航条目。

### 2026-10-16 · 对话注入可配置（自动 / 自定义模板 / 不注入，只管 session 包）

用户提：项目页开新对话自动注入的项目环境说明（课题名/工作方式/目录、顶层文件地图、课题主题、工作环境提示、
规则、人的决定、技能纪律、长期知识、已验收）整段写死——有的用户不需要（嫌长），有的想自定义注入提示词。
两条拍板（AskUserQuestion 当场确认）：①形态＝**模板＋占位符**——自定义文本支持 `{{课题主题}}`、`{{项目规则}}`、
`{{文件地图}}`、`{{长期知识}}`、`{{已验收}}` 等占位符（清单单一出处 `SESSION_TEMPLATE_VARS`），开对话按项目
**当时**数据填入（规则改动自动跟进，不冻结过期）；写纯文本＝完全自定；未知占位符**原样保留**（预览可见，不静默吞）；
②范围＝**只管 session 包**（＋新对话 / 问 AI 直接聊 / 编程车道对话）——开工任务书、「验收后写入」、编程车道
goal 的目标包**不受影响**（验收门/权限合同行不开放自由改写）。三态存 `.ccode/project.toml`
（`session_injection_mode`：auto 缺省 / custom / off，非法值告警按 auto；`session_injection_template` 非空即写盘、
切 mode 不清草稿，空模板 fail-open 自动）。实现：`renderProjectContextPack` 重构为命名分块
（packSections，空块 ""）单一出处——自动包与 `DEFAULT_SESSION_TEMPLATE` 渲染逐字节一致（测试钉住）；
分叉在 `loadProjectContextPack`（off→空串，custom→`renderSessionInjection`）；UI＝项目设置抽屉
「对话注入」面板（ProjectInjectionPanel，三态 SegTabs + 填入默认模板 + 占位符插条 + 展开式实时预览），挂科研
ProjectGroup 抽屉「基本」与共用 ProjectSettingsDrawer「规则与验收」两处。文档同步：user-guide §1.3/§3.3、
code-structure、conventions/pipeline.md「对话注入」。

**同日/次日两轮对抗审查收口（六维工作流 + 限流断头补审，10+3 条确认全处置）**：①占位符判定收敛 `isSessionTemplateKey`
单一出处（渲染与面板同判，`Object.hasOwn` 口径的可移植写法挡 `{{constructor}}` 原型链污染，带空格占位符两端不再口径相反）；
②保存改走 **`project_set_session_injection`**（projects.rs 配置锁内单键读改写）——注入面板与规则面板同卡片并存，
整卡 `write_project_config` 的前端读改写往返会互相覆盖，单键写后注入键的落盘不再伤及/受制于其他键，前端 saveChain
串行化保落盘顺序、touchedRef 防迟到的挂载读档覆盖用户刚改的表单；③预览每次展开重读 + ↻ 手动刷新 + previewSeq
序号守卫（保存触发的重读与手动刷新并发时旧读后到即弃）；④模板 textarea 封顶改内部滚动（overflow-hidden 会把
「填入默认模板」一键写入的 19 行模板尾部锁死在鼠标够不到的地方）；⑤未知占位符之外补「单独成行的 ----」点名——
它与 composeLaunchPrompt 拼接用户消息的分隔符同形，模板里出现会让 AI 分不清说明边界；⑥文案/文档口径补全：
面板导语与 user-guide §3.3 写明受控入口是**一切直接开聊**（＋新对话 / 问 AI / 编程页「进入」 / 定时巡检开聊），
「纯文本=原文」措辞按空行折叠实际行为改准，文件型问 AI 的 `{{项目名}}` 填文件名（存量行为）补例外说明。
主动不修两条：render_config 丢新键行上手写注释（全部 managed 键同一沿袭，整卡注释保真另立项）；argv 注入链路的
长度上限与首行 flag 防护（存量共享通道，自动包同路径，非本功能引入）。测试补齐：tests/project-context-load.test.ts
（invoke 桩钉三态分派五分支，含 goal 免疫）、原型链/带空格/等价边界（段内连续空行 custom 折叠 vs auto 保留，钉住语义）、
projects.rs 单键原子写（只动两键、手写注释保留、坏档拒写）与首尾空白/非字符串容错。

### 2026-10-16 · 热力图色阶重做（cta 单极梯子，替换 oklab 两段式）

用户逐主题走查：仅沉浸黑（浅粉 cta）看着还行，其余发闷；黄色系强调色（自定义主题也要支持）另议。oklab 数值
诊断：①旧两段式「cta→黑压深再落回画布」把近中性画布混进色阶——暖画布上拉色相、塌彩度；②浅色侧竟是 srgb
直混画布，三档浅色挤成同亮度粉彩（ayu-light 三档 L=0.84/0.81/0.79）、顶档猛跳深阶；③neutral 深蓝 cta
（L≈0.53）整套梯子压在暗部（顶档对卡底仅 3.26:1）；④画布偏亮主题（terracotta/dracula）底档距底色
ΔL<0.05 贴死。定案＝**全部只向无彩极点（黑/白）做 oklab 混合**（色相恒定、彩度按比例单调，自定义强调色经
令牌链自动跟随）：深色 = cta→黑 54/69/84 + 顶档纯 cta；terracotta 覆写 66/78/89；neutral 锚点先向白抬
55%（亮 azure）再走同语法；浅色 = 白/黑双极倒转 36%白→68%白→86%本体→58%黑——顶档压深保任意 cta（含黄色，
纯 cta 黄对近白卡底 1.96:1）≥3:1，黄色两侧天然成立（暗侧金烬→纯金；浅侧香槟金→纯金→古铜）。「色阶锚
--color-cta」2026-10-12 拍板不变。断言从「亮度递增+顶档 3:1」升级为完整梯子语法契约（方向单调/步进 ≥0.04/
彩度单调/梯内色相漂 ≤3°/底档距空槽 ≥0.05/顶档 ≥3:1），压位种子加黄强调 × 深浅两画布。已知边界：自定义
暗强调色在暗画布上顶档偏暗（与 CTA 按钮同病）。**同日用户给参考图**（别家产品的深色热力图，单色蓝、空槽若隐
若现、顶档发亮）追加两处手感：深色通用梯子比例 54/69/84 → 50/68/86（凸彩度曲线：底档更收敛、顶档更近纯 cta），
深色空槽从全亮度 inset 改 --heat-0（inset×canvas 70:30，比卡底微亮、若隐若现）；浅色空槽维持 inset 不动
（GitHub 浅色口径，空格应是可见浅灰）。用户同日问「是否该换各主题强调色让热力图更好看」——结论**不换**：
cta 是主题性格本体（按钮/选中/pill 全跟着走），热力图职责是从任意 cta 派生好梯子；若个别主题整体强调色不顺眼，
按重调主题单独立项。

### 2026-10-16 · 活跃度热力图收成单模布局（胶囊全上卡头）

用户拿宽屏截图点名：左侧胶囊栏左边出现大片留白（主区 hug 居中 + 左栏组合的必然结果），整体排版要重排；
常规模式的胶囊行也占掉网格上方一整行。定案＝收成**单模**：①卡头一行 = 标题「活跃度」+「全部/各家」胶囊
（窄窗自然换行）+ 窗口范围行尾右贴；②主区只剩网格 + 统计行——左栏胶囊（≥1020 双列 256px 落地版，及
148/192 单双列、heatFill 底边对齐两代未落码草案）、头部三列栅格 headgrid、右挂统计 wide（≥220 阈值 +
40px 回差）整档撤销，2026-10-12/13 十二轮定稿中的「三档响应布局」一节作废；③「少 → 多」色阶原只活在
超宽右挂里，随右挂撤销移到网格下方统计行行尾**常驻**（原先常规模式看不见色阶，顺带补齐）；④格子边长
上限 16 → 28（10-15 曾计划抬 20 未落码）：胶囊让出的宽度全给格子，1440 限宽页实际最大 ~21–22px，28 只是
放开限宽前的地砖闸；11px 下限、3px 间距、固定正方形、按周列数算死表宽、封顶后主区收内容宽居中、观察器
只盯满宽哨兵等 2026-10-13 口径全部保留。背景：10-15 会话曾按「全部上头 + 各家左栏单列 + 底边对齐」写过
测试与 user-guide 草稿但未落码（测试红灯挂了一晚），本日随单模定稿一并重写收绿；整年网格
buildYearGrid/yearBounds 与 future 标记是时间窗改口后的死码，同批移除。时间窗口径（去年同月
1 日到今天，2026-10-15 改口）不变。设计细则同步 design-system「活跃度热力图」条目。

### 2026-10-16 · 收件箱一键已读（仅信息类）

用户提议收件箱（含工作台）加一键已读。定案：**只对信息通报类开放批量**（白名单 lit/ready/artifacts/
digest/skill，`inbox.ts BULK_READABLE`）——决策与故障类（conflict/confirm/dep/update/profile/help）
不进批量：忽略表的复活语义是「状态变→签名变→条目回」，冲突这类状态不变就不回来，批量收走等于
把待拍板的事藏死。store 加 `dismissInboxBulk`（逐条签名、一次落盘），三个界面挂同一按钮：标题栏
收件箱下拉底部、工作台「待你处理」标题行、项目页待处理 strip 下拉底部；按钮带数量与白名单说明
tooltip。user-guide §1.4 同步（含「哪些不会被收走」）。

### 2026-10-16 · 启动过渡盖到首屏数据就位（BootGate）

用户反馈（冷启动已提速后）：先看到的工作台里最近项目和会话仍有延迟弹出。拍板：**延长启动过渡、
就位后直接满屏**——App 外包 BootGate：五项首屏数据（loadAll/loadSessions/loadProjects/
loadRecentRepos/loadSettings，含主题）allSettled 就位或 **2.5s 硬顶**前，渲染与 index.html **同一个**
`.boot-splash`（同 class 令 html:has 底色选择器继续生效，与 pre-React 占位无缝衔接；零新增 CSS、
不碰 z-index 台账）；就位后应用树才挂载，会话已在 store、工作台首屏即满。更新检查/依赖体检不进闸
（网络与外部命令不拖长过渡）；任一加载失败 toast 后照常放行；硬顶防后端卡死困在过渡。已知语义：
应用树延后挂载 = 各页挂载期副作用（聚焦同步、页签恢复等）整体后移 ≤2.5s，可接受。
**同日追加拍板（两轮收敛）：启动底跟随应用主题**——首试「统一浅色毛玻璃」半透明底被用户实证白屏：
WKWebView 加载期自铺不透明白底层（lib.rs 400ms 二次清底针对的就是它），半透明启动底罩不住；二试
「统一浅色不透明」又被用户指出深色模式下亮瞎。终案：底色跟随主题——App 把 `isLightTheme(settings.theme)`
持久化到 `localStorage.ccodeBootTheme`（settings 未载入不写，防 undefined 误记深色），index.html head 内
同步脚本首帧前读它定 `html[data-boot]`，没存过值回落系统外观（prefers-color-scheme）；深=#11131a /
浅=#eef0f4 两套不透明底。首次启动（无存值）跟系统外观，与 Rust 侧 set_theme 的系统回落口径一致。
**三修（Codex 调研后）：亮窗即毛玻璃（ready-to-show 模式）→ 试后被用户退回**——调研本机 ChatGPT.app
（bundle ID com.openai.codex，Electron + app.asar）：其全程毛玻璃 = ① Electron/Chromium 创建即透明
（无 WKWebView 自铺白底层的怪癖）+ ② 主进程 4 处 `ready-to-show`（窗口隐藏到内容就绪）。②平移试运行
（主窗 visible:false + 前端挂载 800ms 亮窗）被用户实证**无窗静默期读起来像卡死**，退回。**终案**：窗口
保持创建即见（无死区），主题色实心底首帧即现（永不白屏），CSS 底色 400ms 后淡出纯毛玻璃（白底层
的清理时限是 lib.rs 的 400ms 二次清底，压线通过）——观感：点开即有反馈，短暂主题色过渡即入磨砂。
Electron 的「创建即透明」在 WKWebView 无等价物，这是平台差异的边界。

### 2026-10-16 · 冷启动扫描三连修（Codex 批量压缩历史引发）

背景实证：Codex CLI 更新后于 10-15 把全部历史会话批量压缩成 .zst（1743 个文件、归档 2.8GB，ctime 同日；mtime 保留
致「语料早已存在」的误判）——read_head_tail 为取尾窗对每个 zst 整流解码，且尾窗环形缓冲逐字节搬运、debug 构建下
zstd C 库按 -O0 编译，冷启动扫描一夜之间从亚秒涨到 ~90 秒；对话列表/工作台最近对话（list_sessions）与最近项目
（list_repos）都排在同一次 cached_scan 后，全部一起慢。三连修（90s→17.5s→8.2s→**3.2s** 实测）：① zstd 尾窗
逐字节 extend/pop 改批量滑窗（drain 让位 + extend_from_slice，memmove 级）；② Cargo.toml 对 zstd/zstd-safe/
zstd-sys 三个包在 dev profile 单独 opt-level=3（C 解码器不再 -O0）；③ **归档 zst 懒解压**——codex_file_meta 对
archived_sessions 下的 zst 只读头窗即停（read_head_only），元数据全在头部（title/session_meta/created），
updated_at 本就取 mtime，尾窗唯一用途 token_usage 对归档会话宁缺毋滥给 None；活跃会话（sessions/ 目录）仍全量
读保 token 精度。语义钉在 read_head_tail 等价性测试（含 read_head_only 两断言）。**同日四修（秒开）**：新增 `scan_persist.rs`——
五张 meta 缓存表按「键+指纹」整表落 app.db（表 scan_meta_cache），新进程首轮扫描前装回、cached_scan 首轮后落盘，
坏行自愈、失败静默；**schema 演进靠 SCAN_CACHE_VER 版本戳整表作废**（serde 对缺字段是静默取默认值不是报错，
逐行跳过拦不住——对照 usage.rs USAGE_SCHEMA_VERSION 先例，复审坐实后补上）；实测冷扫描 3.2s → **~0.8s**。已知局限：cached_plain 每段整表替换的既有语义使 plain 表只留
最后一段（claude 明文 seek 读亚秒，不为它动共享热路径），落盘大头是 chained（codex/grok）与 kimi。仍遗留：
list_repos 逐仓库 git rev-parse 收口。教训入档：并行会话共享工作树，sessions.rs 曾发生整区域覆盖（懒解压首版被
冲掉后重放）——两会话同文件并发编辑时，后写者基于陈旧快照会静默抹掉对方 hunks，落盘前后必须 grep 验证关键符号仍在。

### 2026-10-15 · 热力图冷启动先出数（含自激环事故修复）

用户拍板「按推荐修、现在修」（背景：dev 频繁重启后打开用量页，热力图卡在骨架好几秒）。定案：
`usage_activity` 的增量 rebuild 加 800ms 预算——稳态（进程内缓存热）几十毫秒完成、行为不变；
冷启动超预算先返回库里现有数据（DTO 新增 `refreshing`，不占 `stale` 的「刷新失败」语义位），
重建转后台、完成后发 `usage-activity-refreshed` 事件，前端在页补拉一次，图先出来几秒内自动变新。
**首版当日翻车并修复（教训入档）**：事件→补拉→仍超预算→再发事件，在活跃大文件重解析的叠加下
自激成环，后端被打满、sessions/projects 请求全部饿死（用户实证：对话与工作台全空；数据无损）。
终版三道闸：① Rust `USAGE_REBUILD_IN_FLIGHT` 单飞——已有后台重建时不叠新任务；② 事件只在
「等待方已超时离开」（channel send 失败）时发，快路径绝不发；③ 前端每个旧数周期最多自动补拉
一次（拿到非 refreshing 数据才复位）。用户引导同步 user-guide 活跃度节、code-structure usage.rs 条目。
**2026-10-16 补课复审修订（用户问「还需完善吗」触发，4 项坐实）**：① 快路径旧快照——查询先于重建、预算内刷完只回填
布尔不重查，隔夜外部会话被静默吞掉且与同屏 agents 矩阵自相矛盾（对 HEAD「先索引后查询」的新鲜度回退）→ Ok 分支
重查一次（等待已付、毫秒级聚合），重查失败回落旧数显性置 stale；② IN_FLIGHT 早退方无通知渠道（重建快于预算时
refreshing 永无终点）→ 新增 USAGE_REBUILD_WAITERS 等待计数，重建完成按计数补发事件；③ 慢+失败象限原被 !failed
压制事件而完全静默 → 失败也发（前端仅一次补拉命中快失败路径把 stale 警示浮出，每周期一闸保证不成环）；④ 函数文档
改回与实现一致的三段式口径。

### 2026-10-15 · 收件箱雷达推送合并为单条

用户拍板（收件箱被定时雷达推的文献刷屏；一条就够，点了「开读」也只是跳到雷达卡）。`lit:` 条目不再按篇展开，
v3.215「按篇标题开读」作废：每个 run 一条「<项目名>有N条新命中 / 去看看」，action 只带 projectRoot，点击经
setProjectFocusReq(focus:"lit") 跳该项目文献雷达卡；**点击不再隐式加积累账、不再自动开 PDF 进沉浸阅读**——
逐篇动作只在雷达卡/「积累 N」抽屉由人发起（与 2026-10-14「加入积累只写账不跳转」同口径；原「开读」点击静默
写 reading-list.md 的隐藏副作用一并消失）。隔离树未采纳 run 的「待评审」单条（review 动作）不变；跑完 OS 通知
本就每 run 一条，不动。忽略语义随 key 改变：`lit:<scheduleId>:<run时间>`，新 run 即新条目（上一 run 忽略过不拦
新推送；旧按篇 key 是内容哈希、永不与新 key 相撞，localStorage 忽略表残留无害）。死代码同批清除：
papersForLitCandidate（含测试）、openLitInboxPaper（含 paperResourceFor import）、WorkspacesPage 收件箱侧
list_watch_entries 扇出（litEntriesByRoot，顺带省每次刷新的逐项目后端调用）、focusEntryId 四文件链（store 类型 →
WorkspacesPage → ProjectSchedulesView → LitWatchCard focusEntryId/startOpen）。细则 pipeline.md「收件箱 lit 类别」。

### 2026-10-15 · Agent 绑定体系（B1–B5 全量落地）

按用途/步骤/任务/日程绑专属 agent 连接+模型，用户拍板分批实施完毕。要点：解析塔
（本次手选 > 实体绑定 step:/tasks/schedule > 用途槽位 reader/discuss > 项目默认 >
记忆 kickoffLast/wsLast/askAi > 全局设置）；槽位存 projects.task_bindings（白名单
reader/discuss + step: 前缀）；目标 tasks 表补 model 列、日程 schedules.json 补 model；
开工弹层「存为本步骤默认」两态（不勾=槽不动）+ kickoffLast 项目级记忆拆键（弹层停写
全局 askAi）；工作区三链 workspaceLaunchChain（手选>步骤绑定>wsLast）单一出处；
**商量类（任务书讨论/问 AI/聊想法/MCP 登录）不吃步骤绑定**（用户拍板：与步骤任务类型
无关，走 discuss 槽>项目默认）；雷达解读 fnKey=watch-explain 进设置页按功能行；步骤名
做槽键→编辑器+后端双端查重。全文 `docs/conventions/agent-binding.md`，设计过程与
三轮验证 `docs/audits/agent-binding-design-2026-10-15.md`。

### 2026-10-16 · 定时雷达执行模型：跨项目并行 + 同项目互斥

用户问「为什么综述流程的定时任务没在跑」（当日实证：9:00 旧实例触发后应用异常退出，
9:08 补跑的 codex 雷达卡 25 分钟被手动取消，claude-code 雷达同秒接上——串行队列把
两条不同项目的雷达捆成一根独木桥）与「为什么不能一起跑」，拍板改并行。定案：
due 任务各自 spawn **跨项目并行**，两道闸门没过的保持 due、下一 tick 重试，界面呈
「排队中」；**同一项目根一次只跑一条**（`project_lock`，锁键 canonical_key——并行写
同一份追加式台账会坏账，2026-10-15 实测并行 lit-watch 把 watch-seen.md 写出重复条目；
后端本就不拦同项目建多条任务，这把锁补上真正的洞）；**tick 同时在跑 ≤ 2**
（`MAX_CONCURRENT_TICK_RUNS`，防启动补跑瞬间拉起 N 个 CLI：token 尖峰 + OpenAlex
已在限流）。手动「立即运行」不占上限额度（显式用户意图），同项目互斥仍生效
（占用时报「这个项目已有雷达在跑」）。基础设施本就齐备：每任务独立 worktree +
per-task flock（跨实例安全）+ 手动跑本就在调度线程外 spawn——串行只是 tick 循环
一个 for 的写法。配套：拉起即发 `scheduler-run-started`（排队→运行就地翻牌），
`ScheduleDto.queued`（= enabled 且 due 且无在跑 Run，纯 Rust is_due 单源，不在 TS
镜像 due 逻辑）支撑排队标记。锁顺序恒为 任务锁→项目锁、sched_lock 恒叶子。
细则 pipeline.md「执行模型」条。

### 2026-10-16 · lit-watch 检索面四项升级（GitHub 文献推送调研后拍板）

用户要求对照 GitHub 文献推送生态优化 lit-watch（对标物：TideDra/zotero-arxiv-daily
库上下文嵌入推荐、chenhengzh/daily_paper LLM 多维评分、openags/paper-search-mcp
free-first 全文、blazickjp/arxiv-mcp-server topic watches、S2 Recommendations API）。
拍板全做四项：**关联推荐通道**（S2 `forlist`，种子=included/积累账 DOI ≥3 篇才启用、
与关键词命中同一套精选、失败隔离）、**OA 直链下载**（OpenAlex `best_oa_location.pdf_url`
优先于盲猜 .pdf 后缀）、**限流卫生**（OpenAlex mailto 礼貌池 + arXiv 3s 间隔 +
Retry-After 重试一次，治两轮实录 429）、**双版本去重**（arXiv 版/期刊版算一篇）。
明确不做：邮件/微信推送（收件箱即推送）、arXiv 分类全量扫（无嵌入排序=噪声消防栓）、
多维评分（保守收录口径不推翻）。同日随下载时间盒（每篇 --max-time 60、合计 ≤5 分钟）
一并落 lit-watch SKILL.md 与任务 prompt；技能种子版本升 10，存量库走内置更新通道。

### 2026-10-16 · 雷达采纳冲突闸门修「排除卡死后续采纳」（+ forlist 端点修正）

用户实证：综述流程测试 09:44 那次采纳排除过 2 篇后，10:34 轮（1 篇新命中）采纳被
「notes/inbox.md 与任务起始版本冲突」永久拦死。根因：采纳闸门旧条件
`current != before || initial != before` 的后半句把**两个方向**一刀切——隔离树领先
主仓（「排除的不写入」+「隔离树只增不改」两条既定口径的必然结果，排除后恒成立）
是合法分叉却被当冲突；主仓领先隔离树（两次运行间有人手改主仓、隔离树没带上）才是
真该拦的。修法：`initial != before` 等式判定拆成方向敏感的**逐行子集判定**
`main_start_lost`（主仓起始内容在隔离树起跑线缺行才拦，顺序无关、空行不算），
`current != before`（第三方改动）保留；整文件写入语义不变。配套回归测试三个方向
钉死（排除遗留放行 / 主仓领先拦 / 整文件写回+回滚不破）。同日：lit-watch §2b 的
S2 `forlist` 端点未认证层实测 405，首轮干跑中 agent 自行降级 `forpaper`（同引擎、
每种子 100 条推荐）验证可用，§2b 改写为 forpaper 逐种子形态（种子 3–8、间隔 3s、
空推荐/404 换下一篇），种子版本 11。

### 2026-10-16 · 定时雷达隔离 worktree 冒充「最近项目」收口（双闸）

用户实证：「测试项目」的定时任务「文献雷达」（schedule id `f4334054…` 一类 UUID）
以任务 UUID 为目录名出现在工作台「最近项目」。事实修正——2026-10-13「定时雷达只
产生自动活动不产生会话」的前提对 codex exec 不成立：无头运行会在 CLI 本地留下真
会话文件（当日三次运行留三条 rollout，cwd 都是隔离树）；且 internal 标记靠运行结
束后从 CLI 输出解析会话 id（`mark_session_internal`），**失败/超时的运行解析不到
id 就漏标**（当日实证：09:00 失败运行的两条 codex 会话 internal=0，10:34 成功运行
那条已标）。漏标会话喂给 `interactiveLast` 闸门当「交互历史」放行。修法双闸：
① `list_repos` 排除 `~/ccode/watch-worktrees` 根（与 workspaces 根同口径——隔离树
是真 git 仓库，rev-parse 必过，不排除必漏）；② `apply_provenance` 读取侧按路径
兜底——`is_watch_worktree_cwd` 命中的会话恒 internal（存量漏标不改库，读取时归位，
用量/会话口径同享）。顺带 `watch_worktrees_root()` 收敛 scheduler 两处字面量。

### 2026-10-16 · 项目设置抽屉三方式统一外壳与分区 idiom（UI 优化轮）

用户指令「科研/编程/工作三个项目的项目设置面板做一轮全面 UI 优化，借鉴 Mesa 原有的
与优秀软件的」。审查发现三个抽屉两套实现：科研（ProjectGroup 内联 aside）无滑入/退场
动画、无 Esc、无对话框语义，编程/工作（ProjectSettingsDrawer）有动画但同样缺 Esc/
焦点圈闭；分区折叠头四种字号字色混用（h3-l3 / fold-l3 / 文献与数据 fold 无 font-medium /
验收记录 micro-l4 / 长期知识 h3-l2 常开），「基本」井里读写行与折叠面板交错，研究流程
三枚同权按钮违反「同一视觉层超 5 个等权控件必须分级」。定案：①外壳收敛为
ProjectSettingsDrawer 导出的 **SettingsDrawerShell**（ccode-sheet-right 滑入/退场 + Esc
关闭 + Tab 焦点圈闭 + role=dialog/aria-modal + 遮罩 mousedown 靶命中关闭 + 关后焦点还原，
与 Modal 侧滑 sheet 同款），科研抽屉弃内联 aside 改用外壳，抽屉头加项目名副题；②**「规则
与验收」（规则/验收记录/对话注入）三种方式同一分区组件 SettingsRulesSection**，科研不再
叠进「基本」，验收账本由分区自取（ProjectGroup 删除本地 acceptLog state/effect）；③折叠头
单一 idiom＝xs·font-medium·l3 + FoldMark + micro/l4 摘要，验收记录、文献与数据、项目长期
知识统一；长期知识默认折叠（摘要给有效条数）、内容入井、表单走 surfaceFieldClass、原生
details 换 FoldMark；④研究流程按钮分级：更换/选择模板=secondary 主按钮、另存为模板=ghost、
「不使用研究流程」=ghost 悬停转红；模板库选择器收进研究流程分区井内；⑤井内节奏统一
space-y-2、井间距 space-y-5（原 mb-2/3/4 混用）；项目路径值提亮 l4→l3。行为不变项：另存为
模板仍关抽屉开内联表单、opt-out 仍走 danger 确认弹层、文献与数据默认折叠与 resFocus 高亮、
模板应用成功连抽屉一起关。守卫同步：content-surfaces 的 data-surface 名单移除 ProjectGroup
（canvas 覆盖层已归外壳所在文件）、project-memory-panel 测试补「先点开折叠头」。
user-guide §3.3 表格同步。

### 2026-10-17 · 工作台第二轮：收件箱冷启动修复 + 上次停在 + 记下目标

用户要求「看工作台 UI 怎么优化、加什么功能」，审查后拍板「按推荐的都执行」。
**修四处**：①**收件箱冷启动恒空**——`store.inboxItems` 与顶栏项目上下文唯一写入方是
WorkspacesPage，而它懒挂载、数据刷新又只认自身 `visible`；默认首页是工作台，于是不点
一次「项目」，工作台「待你处理」与顶栏待处理只剩「更新」。定案：App 首屏后即隐藏挂载
项目页；项目页的 `refresh` / 外部会话尾态 / 跑完跃迁三个效应改认
`inboxLive = visible || page==="workbench"`（停在工作台时收件箱也随运行更新）。
②**逐项目扇出**——轻量三件（list_projects/list_workspaces/run_list）随运行启停重拉；
编程 git 与科研档案卡只在项目集合变化、有运行跑完（done 签名）、回到本页、点重试时拉；
`task_list` 改一次全量再按已添加项目过滤；主卡不再单独重读档案卡；失败按类合成一条
提示（`workbenchLoadFailureMessage`）。③页头副标题删掉（步骤名已在主卡，同一事实只说
一次）。④首轮项目列表回来前画骨架，不闪「从一个项目开始」。
**界面**：三区分图标（正在进行 CircleDot / 待你处理 Inbox / 待你验收 ClipboardCheck）；
「待你验收」并入右栏排在「待你处理」下，计数改中性芯片（黄芯片只留给待处理）；待处理行
补所属项目名（`inboxItemProjectRoot`，正文已含项目名不重复），**非信息类条目按钮常驻**
（冲突/待确认/人工请求等不再靠悬停才现，信息类仍悬停）；紧凑行去掉每行常驻「继续」字，
改悬停箭头。未采纳的分类胶囊：条目正文本就是「名·状态」一句，再加分类即重复。
**新增**：①**上次停在**——主卡显示该项目最近一次人参与对话里你说的最后一句（尾页、
Rust 层已脱敏、跳过工具结果与系统注入，`lastUserInstruction` / `latestProjectSession`），
点开进对话页；紧凑行放在悬停提示里。②**记下一个目标**——主区一行输入，只记不开工，
与项目页「新建目标 → 记下」同一组默认（整个项目当资料、验收后写回、Agent 开工时再选）；
可选项目与项目页目标视图同口径（办公，或科研里「不使用研究流程」且无步骤；编程走车道
不进，`goalCaptureTargets`）。未做：右栏常驻两栏、最近项目缩条、今日小结（与 v3.114
「不做仪表盘」冲突，留待拍板）。user-guide §2 同步。
**同日看图复审（用户截图）追加**：①空闲时区块标题由「继续工作」改「最近在做」——主卡
按钮就叫「继续工作」，标题再说一遍是重复；②工作方式标签改描边、与项目名同行（well 上
bg-strip 看不见，单独一行像错位缩进）；③其余「正在进行」项并进一口井、细线分隔，空闲行
不画灰点（与侧栏「没事不画点」同口径）；④副行去掉「项目现在：」前缀（行首已是项目名，
句子本身不变）；⑤「记下一个目标」默认收成一行文字入口，点开才是输入框（常驻全宽输入框
像全局搜索、抢主卡），默认项目在主卡不可记时取最近交互过的可记项目，占位文案按办公/科研
区分；⑥「查看全部」降为文字链级（原按钮比区块标题还醒目），最近项目/对话行尾悬停箭头去掉。

### 2026-10-17 · 快速开聊 / 运行空态 / 对话页走查收口（用户截图，「按推荐的都执行」）

①**快速开聊**：档位标题改中文常规字、删代号格；连接档补默认模型、目录档全路径折 ~；
「继续上次」品牌点对齐标题。②**运行页空态**：「将在 … 启动」由直接弹系统选目录窗改为目录
菜单（随手聊 / 最近已添加项目 / 主目录 / 选择文件夹…，`welcomeDirChoices`）——新标签默认落
主目录，而想去的通常是随手聊或某个项目；卡片其余（身份只在启动栏、快捷键括号小字）按 v3.213
不动。③**对话页**：列表 meta 行补项目名（`sessionProjectLabel`，单项目范围不写），进行中绿点
不再顶出缩进；回放头部改两行（页签钉在第二行右端，原一行 flex-wrap 把页签挤到左下），agent 与
「查看项目」并进头部第二行、底栏只留外部续聊；**回放把单独成条的思考并进过程组**
（`isProcessOnlyAssistant`，Claude Code 思考单独写一条助手消息，原先「思考过程」「执行记录」
一行一行交替刷屏），标题 processFoldLabel，组内思考直接铺开。
④**运行中插入出两个列表（用户报）**：收缩行「插入」与标签栏 ✦ 共用一个 `insertMenuOpen` 布尔，
任一处点开两处浮层同时渲染（✦ 那份还是无分段/无说明的简版、钉在窗口右上角）。修：状态改
`insertMenuFrom: "bar" | "tab" | null` 按锚点分开；✦ 浮层贴按钮下沿弹出；三处条目收成
`InsertMenuItems` 一个组件；进程活着时收缩行不再摆「插入」（v3.213「运行态插入在当前标签」本意）。
⑤聊天视图「有新消息 ↓」偏左半个身位（sticky 上 left-1/2 无效、-translate-x-1/2 仍生效）修正。
⑥**底栏思考档显示与实际不符（用户截图：Claude Code 屏上 xhigh，底栏 low）**：滑块初值硬写
「第 2 格」，从不读实际档。改为 `currentEffort` 三级真值（屏上认出 > 本次覆盖 > 绑定开场档），
`combo_surface` 补 `launchEffort`，TerminalView 在 PTY 输出里认 Claude Code 三种成句形态
（`detectEffortInOutput`，拼上一帧 160 字尾巴防切句）；都没有时不点亮、标「默认」。细则 profiles.md。同日追加（用户：其他 CLI 也要正确显示）：本机 PTY 实录 Codex/Grok/Kimi/Qwen 启动画面与包内
字符串，认档改为按 CLI 分形态（Codex 底栏 default 即用默认、Grok 边框「(档) ·」、Qwen /effort 回显、
Kimi 底栏 thinking=on）；底栏不能切档的 CLI 加只读「◈ 档名」。

### 2026-10-17 · 连接 / 技能 / MCP 页走查（代码审查，未截图）

①技能预览 SKILL.md 由整份等宽 `<pre>` 改为 Markdown 排版（`marked` + `sanitizeDocumentHtml` + `md-body`，
与产物预览同口径），frontmatter 拆字段小表（name/description 顶部已写不重复），「源码」可切回原文；
②技能「内置技能有新版」对照区原是裸 HTML 按钮与 details（无任何样式），换全站控件与左右对照；
③技能「应用到 Agent」与 MCP 分发格：本机未安装的 CLI 降权并标「未安装」（仍可预先分发），技能
「一键应用」计数与 applyAllAgents 同口径只数已安装；④MCP 列表加载改 LoadingRows、「用于」悬停列出
分发到的 CLI；⑤连接行模型列首个（启动默认）提一档字色并悬停注明。
**同日按用户截图追加**：连接弹窗下拉全换 MenuSelect、「高级设置」改 FoldMark、编辑态「请求策略」空框收成一句、
「同时绑到」灰项写明原因；网关库行按钮分级、「n 条配置」改「n 个连接在用」、协议槽超 3 种收成「前两种 等 N 种」
（gateway-option.ts）；技能 frontmatter 行内数组去括号、组名已含来源时不重复标来源；MCP 分发状态改为全部条目读
（收起行「用于」列标「· N 处异常」），「外部已删除/外部已禁用」徽标直接点重写（原需先关再开），MCP 表单补字段标题。
**操作结果提示统一（用户：「所有这种弹出的文字说明 UI 也优化一下」）**：NoticeBar 加 err 档与 Lucide 图标、纯文本自动
分「结果标题 + 说明行」（notice-text.ts），页面级整段绿/红字横幅全部换 NoticeBar；右下浮动提示同样分层并按字数
延长停留。MCP「用于」列 96→148px（「8 个 CLI · 2 处异常」原折两行）。细则 design-system「操作结果提示统一口径」。用户追问「其他地方也优化了吗」后全量扫：新增行内版 `InlineNotice`，表单 / 面板 / 列表行里 70 余处整段红绿琥珀字
（含多行写法）一并换掉，涉及 45 个文件；评审页结果条、Git 面板提示保留条形只改配色口径。

### 2026-10-17 · 对话页「范围」选择面重排（用户：筛选这块有点乱）

原问题：Agent 段在项目之前；「按项目」组头计数是项目个数（56）而其余行是对话条数；已添加项目
（backend-admin 注册名「后端管理」）用目录名，且与家目录 tongzhouhong、tmp、lit-notes 混排；点 Agent
名只展开、要再点一层「全部项目」才筛；「Mesa 内部 AI」在范围与「更多」快筛各有一个开关。定案：分段
全部/随手聊 → 项目（注册名）→ 其他目录（折叠，家目录写主目录）→ Agent（点名即筛，箭头单独展开细分）→
其他（内部 AI）；段头无计数；「更多」去掉内部 AI；范围条标签用注册名。纯逻辑 `scopeDirRows`。

### 2026-10-17 · Mesa 内部对话的长期处理（用户：越堆越多怎么办；三项均按推荐拍板）

本机实测：Mesa 后台调用（大头是会话自动命名，每个对话两次）留下 1787 条内部对话、约 150 MB，近期约每天 30 条；
另查出用量页 Claude Code 历史只剩 30 天——Claude Code 默认清 30 天前对话，Mesa 重建用量时「文件消失就删行」。
定案三层：①**源头不落盘**——`ai_prompt_impl` 一次性调用对 Claude Code 加 `--no-session-persistence`（json 输出）、
Codex 加 `--ephemeral --json`（2026-10-17 本机 `--help` 与实跑确认不写 rollout），花费从输出解析直接记账
（`record_ephemeral_usage`，session_id=`ephemeral-<run id>`）；Kimi/Grok 无同类开关照旧落盘；定时任务不变。
②**保留期清理**——默认开、保留 30 天（7–365），开机两分钟后起、每天至多一次，设置可关 / 改天数 / 立即清理；
目标限 internal + Mesa 临时目录或雷达隔离目录 + 未保留，永久删除；打开开关即对「CLI 目录只读」铁律的显式授权
（safety.md 第 6 类）。③**用量历史永久保留**——文件消失只撤 seen 标记不删用量行，只有用户亲手删除对话才连用量删；
表版本升级不再整表清空。实施前在真实数据副本上完整跑过一遍清理（见 safety.md）。已经丢掉的 9 月 17 日前
Claude Code 用量无法恢复。

- **md 预览「双击段落跳源码行」+ 编辑态折行（2026-10-14 用户拍板）**：背景——预览是单向渲染（marked 只读 HTML 阅读 + Monaco 源码编辑，⌘E 整页切换），用户唯一高频手写区（lit-notes「译段/我的想法」自留区）的编辑模式是「渲染态读、源码态短改」，痛在定位：reflowBlockText 接成的中文单行长行 + 笔记栏默认 22% 窄栏 + Monaco 无折行，改一个译词要在横向滚动的长行里盲找。三条改造路线经评估矩阵（9 agent：四路摸底/三视角/对抗验证）后拍板：**小改路线现在做**——阅读态双击段落切编辑态并定位到该块源码行；**左右分屏对照缓做**（撞「边看边写走沉浸阅读三栏」（design-system）与「不做扩展性功能」（terminal.md 2026-08-18）两条拍板，且最痛的窄栏物理放不下分屏，要做先解除）；**Typora 式 contenteditable 内核不做**（未发布不养闲机器；单向「先清洗再显示」安全边界不动；保存链/划选/粘贴图片/KaTeX/mermaid 全量重接 15+ 人日）。实现口径：marked 18 token 无行号，行号靠 lexer raw 前缀累积自算（`src/md-block-map.ts`，**lexer 必须无参调用**——带 options 会整体替换 defaults 丢 md-math 扩展，实测 $$ 块退化 paragraph）；标记不烘进 HTML（DOMPurify 白名单剥自造 data-*），双击时惰性配对「.md-body 顶层子节点 ↔ 块 token」（div.md-code / div.md-mermaid 归一 pre；不用常驻 Map——装饰链 replaceWith 会留死键），配对失败回落纯切编辑态；定位走 {line, nonce} 通道（modeTick 先例）防同值不重触发，reveal 等一帧再居中（隐藏态高度未定）。**wordWrap:'on'（md 限定）同批拍板**——近零成本消掉源码态横向滚动，并压缩分屏路线的残余价值。同日用户实测反馈三连：①⌘E 在编辑器内被 Monaco 默认绑定「用所选内容查找」吃掉（findController CtrlCmd+KeyE）——编辑器 DOM capture 拦截修复（仅阅读区宿主，见 terminal.md）；②查找控件固定宽 ≈367px 在窄笔记栏溢出被裁——App.css max-width+换行收缩适配；③**md 编辑能力补齐**——编辑态格式行（B/I/S/`/•/☑/❝/<a>）+ ⌘B/⌘I/⌘⇧X/⌘⇧C 行内标记切换 + 回车续列表（任务清单重置未勾选、空项退出）+ md 缩进 2 空格，纯逻辑 src/md-edit.ts；当晚 13-agent 全量审查（六视角+对抗验证）修掉七处：addCommand 全局键绑定服务的泄漏/跨编辑器串扰/压查找框 Enter 三坑（改编辑器 DOM capture 单监听）、IME 确认候选 Enter 穿透（ime-guard 锁）、评审视图双击丢批注草稿（草稿开着不跳）、只读态格式行收起、行级前缀按完整标记比对换标记不叠层（"- [ ] x" 对 "- " 不算已有，防孤儿复选框）、undo 前后双止点；补组件级测试 tests/md-jump-ui.test.ts（双击→切编辑态→定位行 7/链接不跳）；已知边角：重复链接定义无空行紧跟内容时行号重同步可能假阳性（输入面窄，失败模式是跳错行不崩溃，暂记）；查找按钮悬停提示贴编辑器顶边被裁（monaco hover 浮层在 overflow-guard 内）——按用户拍板「显示不了就去掉」，App.css 对 `.monaco-hover` 整体隐藏（Mesa 编辑器无值得保留的内容悬停）。同步 user-guide §6.1/§6.2、terminal.md md 阅读版式条目。
- **文献双台账：积累账与流程正典拆分（2026-10-13 用户拍板「全按推荐+抽屉同批」）**：当日背景——`papers/included.md` 身兼**流程正典**与雷达「加入精读」落点两职，是污染根源：用户随手加的行在主仓是未提交改动，进不了已开工的步骤、还得靠人记得提交才放行合并；雷达台账（inbox/watch-seen/watch-followup）在模板没忽略它们的老项目里被 git 跟踪，**两种状态都拦合并**——?? 态算未跟踪脏行，采纳一次产生一批 M 态改动更把后续所有合并拦死（2026-09-11 只豁免了 acceptance-log 的 ?? 态，治标）。定案＝积累与正典彻底拆层：①**数据分层**——`papers/reading-list.md`＝积累账（gitignored，「加入积累」唯一落点，按钮由「加入精读」改名；去重域=两表并集，卡内「积累 N」抽屉可列可删）；`papers/included.md`+`included.json`＝流程正典（检索步/人审/开工接驳三入口）；雷达台账（inbox/watch-seen/watch-followup/watch-explains/pending-registrations/acceptance-log）全部 gitignored，永不进任何步骤、永不影响合并。②**开工两动作**——接驳提交（弹层显式同意「要不要把 N 条清单新行/M 篇笔记接驳进基准」，scoped 提交把主仓未提交的 included 存量行＋用户笔记并入基准分支，bootstrap 后、create_workspace 前）＋冻结快照（`freeze_reading_list_intake`：reading-list 非空则复制为工作区 `.ccode/handoff-lit-intake.md`，best-effort）；检索步简报把它与 included 存量、imports、检索候选统一去重当进料口，不回写不清空——agent 读开工定格副本，流程期间继续「加入积累」不影响本轮。③**合并闸门白名单重写**（`review_contract::is_untracked_ledger_file`，merge 闸门/开工脏文件点名/编程改动计数/迁移前置四处共用）：?? 态豁免 reading-list/watch-explains/pending-registrations（reading-list 只豁免 ?? 是防呆——agent 违规提交后变 tracked，后续 M 态仍拦合并并点名）；?? 与 M 双态豁免 `notes/*.md`（index.json 除外，那是流程正典）、inbox/watch-seen/watch-followup/acceptance-log×2。④**PDF 资源登记相位感知**：项目有 active/creating 工作区时 `register_pdf` 不写 project.toml（流程期间档案卡属基准），改记 `.ccode/pending-registrations.json`（按 path 覆盖去重），项目打开与工作区归档时回放。⑤**存量收口**：当日为两个存量项目手工迁移完（等价序列=.gitignore 追加台账 marker 块→`git rm --cached` 台账文件→只 add .gitignore→整索引单独提交；注意**不能**走 git add 台账路径——rm --cached 后它们已被忽略，add 拒收）；迁移命令与界面曾实现（幂等 marker＋前置点名＋回滚），**当晚按「未发布、留着没用就删」用户拍板移除**，重建按上述序列即可；新项目 .gitignore 模板直接带台账面；存量 included.md 旧雷达行不搬，由下轮检索步当存量进料补齐 json。⑥**运行期规则**：平时「加入积累」攒账＋随时开读写笔记；流程中雷达照常推送/采纳/积累（台账 git 不可见，不进任何步骤不拦合并）；后到文献=下一轮的积累。lit-search 技能同步进料口径（handoff-lit-intake.md / reading-list.md 是用户积累候选，统一去重并入，不回写不删改，产出契约不变）。细则落 conventions/pipeline.md「双台账」。
- **步骤工作区重跑撞分支的三分支口径（2026-10-13，修「旧轮工作区永久挂『有冲突』」）**：步骤工作区名固定（lit-search 等）而重跑是常态，旧口径「分支已存在请换任务名」对步骤等于死路；未合并旧轮遇上主仓前进（重跑产物已进主仓）后试合并恒冲突（典型 add/add 于 papers/included.md），卡片永久「有冲突」，且「解决冲突」会把过时清单盖进主仓。定案：`ensure_branch_free` 按占用行分情况——活动行指路（继续它或删除后重开）；已归档且已合并的旧轮让位（删行删分支、记日志）；无行引用的悬空 ccode/* 分支清理后继续创建。冲突卡片在 behind>0 时明说「主仓已前进 N 提交、旧轮被重跑取代可直删工作区」。当日实例：测试项目 lit-search 旧轮（218 篇清单被 6 个后续提交取代）已清。
- **资源管理五页超宽屏居中限宽（2026-10-13 用户拍板）**：连接、技能、MCP、用量、设置五页从 `PageFrame width="fluid"` 统一改 `width="wide"`（1440px 限宽、`mx-auto` 居中）——超宽屏下表格右缘曾拖出上千像素页底空白（热力图 16px 封顶 `.ccode-heat-hug` 收成内容宽后空白留在卡外，尤甚）。这是对 v3.119/v3.182 fluid 口径的收回（用户原话「早些时候的方案我当时否决了，但是发现只有这样了」），第八/九轮「整页 1080 阅读列」否决同步解除。留白刻度（同日补充拍板）：**只需保持热力图完美显示，不需太多**——1440 恰好让格子顶到 16px、统计栏右挂吸掉余量（右挂阈值 ≥220px），再窄热力图降档、再宽统计栏吸不完又出空白。页内响应布局（auto-fill 列数、热力图三档、设置行 40rem 切换、MCP 五列网格）全部保留，只封外壳顶；工作台/项目页保持 fluid。同日稍后修订：16px 封顶后热力图卡片不再收窄（原 hug「收成内容宽、空白留卡外」在限宽居中语境下会比兄弟卡短一截），卡片恒与列宽对齐；晚间再修——封顶后主区（图+右挂统计）在卡内整体居中、余量左右均分，不留单侧右缘。
- **定时雷达定位与评审/采纳收口（2026-10-13 用户拍板）**：雷达文献是项目内的**日常积累/资源储备**，不进科研流程——精读的文献清单与 RIS 在流程开始时即确定，流程开始后不得随意加文献；雷达命中与「留下/排除」只决定**哪些进项目**（收件箱/papers），绝不写 `papers/included.md`、`notes/index.json`、`references.bib`（巡检 prompt 明锁）。精读由人发起：雷达行「加入精读」单篇自读，或从这批积累上发起检索/科研流程后由精读步逐篇读。**精读接续（关键）**：某篇已有笔记（沉浸阅读建的/用户手写/上一轮流程）时，agent 精读必须在原笔记上续写优化，「译段」「我的想法」两节与用户手写内容原样保留、不另起平行笔记（lit-notes 技能 §1a + 精读步 TASK 合同双落）。同日修三类实病症：①评审页改只列**该次运行的新命中**（冻结 after−initial；此前列整个累积收件箱，每次评审都一样、越看越乱）；②「排除」落语义——采纳前按决定把被排除条目从冻结 inbox 文本整段剔除（`drop_excluded_from_snapshot`/`drop_inbox_entries`），此前决定除评审页标徽外零消费、被排除条目照样整份进项目；③已采纳态收口——历史行「已采纳·查看」、评审只读，后端双闸（`adopt_watch_run` 拒已采纳、`watch_run_decide` 拒改已采纳决定），修「每次重开都显示可点的采纳按钮」；决定文件损坏时写入 fail-closed 不静默清空。**同日追加拍板**：④**历史运行记录支持删除**——单条走 `schedule_run_delete`（Run 账行+事件+历史行+冻结证据；worktree 按日程共享保留；已采纳产物不动）；删任务/移项目必级联（`purge_schedule_side_effects` 清该日程全部 Run/快照/watch 任务行，worktree 走回收站可反悔，先拒删有未结束运行的任务）——修「删任务留孤儿」（当日手工清掉 13 条孤儿运行与 3 个 worktree）；⑤**雷达筛选语义修订（用户按推荐拍板）**：设筛选后指标未知（期刊未收录/IF 不可解析）=不匹配，不设筛选全显示，筛选清空列表给「点不限看全部」空态——pipeline.md 2026-08-25「一律放行不误伤」旧口径作废，user-guide 与卡头提示同步。
- **用量页活跃度热力图（2026-10-12 用户拍板）**：GitHub 风格年历落进用量页（侧栏九页闭集内，不新增页面）。拍板要点：①**色阶锚 `--color-cta`**（用户指定——UI 与用量页整体界面同族，折线图同强调族；备选 done 绿被否）；②**着色量纲=四类合计**（input+output+cacheRead+cacheWrite，ccusage/Codex 口径；注意与页内 KPI「总 tokens」的输入+输出口径不同，tooltip 文案披露）；③**streak 展示但降权**（微统计行 + 今天宽限从昨天前推 + 中性文案，不做断签施压）；④**载体 DOM 真表格**——v3.88「手绘 SVG」修订为「手绘不引库」（WKWebView 焦点/月份 colspan/0.5px 线三项都更稳）；⑤**rebuild 并发锁独立先行**（修复 session_usage×手动刷新并发双跑 ON CONFLICT 累加翻倍的存量隐患，四个调用点全走 rebuild_locked）；⑦**视觉十二轮定稿（2026-10-12/13，详见 design-system「活跃度热力图」条目否决谱系）**：色阶=color-mix(in oklab) 两段式同色系派生；格子 13px 下限有界流式（无界拉伸曾被否、后以「下限+封顶」解禁）；**三档响应布局**——常规=胶囊横排+统计在网格下方；≥1020px（ResizeObserver）=头部三列栅格统计+左侧 256px 双列胶囊；16px 格子右边还剩 ≥220px 时统计改挂网格右侧（按栏宽 1–4 列）并在其上加「少→多」五档色阶。**格子固定正方形（2026-10-13 用户拍板）**：宽高同由 `--heat-cell` 决定，边长取 11–16px 里当前宽度放得下的最大整数，**16px 封顶（地砖禁令，最大化窗口也不得抬）**；到顶后主区收成内容宽、卡片保持列宽对齐兄弟卡，主区在卡内居中、余量左右均分（当日下午修订：限宽居中落地后卡片收窄比兄弟卡「少一截」，原「收成内容宽、空白留在卡外」作废；同日晚间再修：余量只留右缘左右不均，用户点名后改主区居中）。表格宽度按周列数算死；窗口任意拉伸不得把格子拉成长方形、不得让列与列宽窄不一；间距由 2.5px 改 3px 整数，避开非整数缩放下的 1px 分差。布局观察页面满宽哨兵，禁止观察 hug 后的主区（`width:max-content` 与 ResizeObserver 互改会抖动；超宽档 40px 回差）。此前「有界流式铺满卡宽 / 网格封顶 1280」收回；月份标签下置；用量页保持 fluid（第八/九轮 1080 阅读列试行后随宽模式落地反转；当日稍后随「资源管理五页居中限宽」拍板改 wide 1440，见上方同日条目）；⑥下钻与 agent 筛选原定二期，**同日用户拍板「第二期做上」提前实装**（usage_day_detail 点格浮层→setOpenSessionReq 直跳会话视图 + sessionScopeReq day 深链；usage_activity_agents day×agent 矩阵+筛选胶囊，胶囊口径下分档/活跃/峰值/连续全部按该 agent 重算、streak 限所选年并注明）。口径铁律：着色/活跃/streak 恒只算非 internal（official 订阅计入——订阅日也是真实使用）；「显示内部活动」开关只追加 tooltip 注记，永不改格子颜色与统计（与「开关只改展示分组」既有硬规则同构）；时间窗=自然年翻页与 range 彻底解耦（dsh v4 实证砍掉每日/每周/累计三态）；分档=非零天四分位（GitHub 官方 GraphQL schema 同构，对 170 倍偏斜免疫）；相邻档 ≥3:1 明确不作为目标（GitHub 自身 ~1.6:1），靠 tooltip 数字+图例 sr-only 档名+forced-colors 渐大圆点补偿；浅色主题最高档覆写 cta×l1（纯 cta 在近白卡底不足 3:1，ayu-light 实测 1.96:1），档差断言钉在 theme-contrast.test.ts。
- **AI 优化另存新技能：多源合成、名字权威、溯源不参与运行（2026-10-11 全方位摸底后拍板）**：◈ 优化弹层扩为去向二选一——原地改（开终端，现状不变）｜另存为新技能（勾选一个或多个源技能 + 写优化方向 → AI 合成出稿 → 人预览/再编辑 → 确认落库，两阶段与「适配到流水线」同管线）。要点：①新技能名是**权威参数**——预览输入框的值写回 frontmatter（AI 稿必带合法名，只当 fallback 会被静默压掉，两轮复审实证后改为 create_user_skill 落库前重写 name 行）；②source=ccode 不开新枚举（下游行为恰好全对：更新不提示、播种不覆盖、删除走备份）；③derivedFrom 溯源只存 skills.json 不进 frontmatter（compose 重写链会剥字段），纯展示（删除影响面/详情面板），悬空静默过滤，绝不做「源变则失效」的运行时判定；④一次请求一份稿——AI 认为该拆多份只能写进正文建议；⑤provides 由 AI 按职责声明、预览显形、provides-only 稿的 create 门槛已修；⑥provides 缓存 120s TTL 有界陈旧（技能页显式失效 + TTL 兜住技能页外的库变更：终端直改/定时草稿/agent 改库文件），防陈旧映射把缺挂载步骤持久化进 project.toml。多选合成是 N→1（人勾源 → 人确认一份库文件），不产生工作结构，不撞自动拆任务红线。
- **个性化技能接管流水线：占位引用 + provides 声明位（2026-10-11 全方位审查后拍板）**：技能名不再焊死在合同正文与前端行为键里。① 模板简报的 51 处按名引用改为 `{skill:锚名}` 占位（锚名闭集=内置技能名），TASK.md 渲染时按步骤挂载名单解析——provides 声明优先、名字精确匹配兜底，换技能后正文指令跟随，不再与「本步骤技能」段打架；空缺锚保留原样、StepSkillsChips 提醒（不拦截）。② SKILL.md frontmatter 新增 `provides:`（可顶替的内置位），前端行为键（文献同步/开读这一篇/Origin/文献雷达卡等）按占位判定，用户技能声明即点亮；「适配到流水线」AI 出稿顺带写 provides。③ 红线保持：选择必须人显式（禁智能路由/隐式推断）、验收真源仍是步骤合同与提货单（换技能不换验收）、无流程科研不得引入项目级技能池。④ 定时域仅文献雷达卡槽位化，inbox 候选/收件箱分类的深层过滤仍按名（后续分期）。
- **综述初稿复盘写进技能（2026-09-28）**：裁图只认块首题注并同栏取图，超过 4 块必须分行。正文数字与笔记不符时按原文改稿并回写笔记。Quarto 安装以 `quarto check` 为准；`--output-dir` 落进 `output/manuscript/` 时归位到 `output/`。材料名 `@` 写成 `\@`，子图引用写 `@fig-2(a–c)`。bib 标题 U+2010 在 Times 下会缺字，渲染前换成 ASCII 连字符。
- **评审沉淀只写下一步还没有的约束（2026-09-28）**：AI 起草对照下一步任务书、本步预期产物正文和审阅意见。已有句子、验收过程、补交上游文件不写。没有新约束时返回空，人留空即可。
- **审阅划选加进意见（2026-09-28）**：稿件阅读态划中文字后点「加进意见」，写下这一处怎么改，追加到同一个意见框。退回修改 / 按意见重写仍读这一框，不另开批注清单。已保存进项目后不再划选批注。Word 和 PDF 预览不能划选加意见。
- **审阅先等文件再显示（2026-09-24）**：有页签的步骤在 diff 到达前显示「正在打开…」，不先画 Git 对照。笔记和稿件改成左侧可搜索列表，不再横排标签。
- **保存后 help-wanted 仍进收件箱（2026-09-24）**：已合并、未归档的工作区也扫描 `.ccode/help-wanted.md`。补全文和授权不进下一步任务书，人从收件箱打开这份清单。
- **文献库同步在精读之后（2026-09-24）**：检索步不再放同步按钮。精读保存后，点同步先按 references.bib 重写 to-fetch.ris 与 endnote-import.ris 再打开。PDF 从同一行「打开 papers」拖到对应条目上。
- **endnote-import.ris 只归检索（2026-09-24）**：精读不把这份文件列为产物，不按 references.bib 整份重写。只追加 bib 里还没有的 DOI，已有记录保持原样。
- **精读交接给大纲（2026-09-24）**：`notes/handoff.md` 只写写作约束。补全文、登录、授权留在 help-wanted。大纲开工先读这份，不把验收摘要整段贴进 TASK.md。
- **精读不再等核心篇名单（2026-09-24）**：有 PDF 的全部精读，没有的按摘要记。图号认文本层图注。脚本和缓存不写项目根。已有课题保存流程后才更新任务书。
- **综述初稿必须交图或降级引用（2026-09-24）**：用图计划的「拼」要有 `figures/figN.png`，裁不到写「见 Fig.n」和 `figures/README.md`。正文含「待绘制」则机器验收不通过。已有课题保存流程后才更新任务书。
- **定时巡检的运行配置按写盘范围标注（2026-09-29）**：Codex 无附注（`-s workspace-write`，只写课题目录）。Grok 写「会批准全部操作」（`--yolo`）。其余能跑的写「按该工具默认权限写文件」。Qwen 仍禁选。文献雷达选 Codex。
- **定时巡检不挂步骤（2026-09-29）**：新建和编辑都不再有「关联步骤」。新命中只进雷达。旧日程保存时清掉 `linkedStep`。步骤圆点和雷达卡片不再写「产物可能过期」。
- **检索第 6 条把 RIS 和题录拆开（2026-09-29）**：原文「把 to-fetch.md 转成 题录同时写入 included.json」是两句粘在一起。现为转成 `papers/to-fetch.ris` 与 `papers/endnote-import.ris`；同一批已纳入、缺全文的题录写入 `included.json`；pending 只留 `included.json`。人工事项「配置学术检索 MCP」写明本机 Consensus 已填密钥时可跳过；Undermind 仍要登录。已有课题不自动改写；「综述流程测试」的档案卡与各工作区副本已改这一句。
- **开工检查不误拦精读（2026-09-24）**：工具合同只比所选技能，产物名单增减不挡开始。技能要读的文件若是本步预期产物，不报上游没有。
- **开工先记下本步要读的文件（2026-09-24）**：点「记下并开始」先提交命中本步输入的未存改动，再开工。不再为这些文件二次确认，也不在开工弹层提醒与本步无关的改动。项目页黄点仍可展开后存进历史。
- **验收账本不计入未存入历史（2026-09-24）**：项目页「N 处改动未存入历史」不数未跟踪的 `.ccode/acceptance-log.jsonl` 和 `.lock`。这是保存时 Mesa 自己写的账本。已跟踪的改动仍提醒。
- **保存后收起审阅意见（2026-09-24）**：已保存进项目后不再显示退回意见框。沉淀的 AI 起草改读主仓里这一步的合并提交。未做 Mesa Dev 实机验收。
- **审阅文件目录可收起（2026-09-24）**：文件页对照长行换行，目录默认收起，顶栏开关。窄窗口仍是抽屉。未做 Mesa Dev 实机验收。
- **审阅各步同一套页签（2026-09-24）**：检索是清单／过程／文件，写作是笔记或稿件／过程／文件，实验是结果／过程／文件。文件页只留 Git 对照，顶部不再列非 Git 产物。验收摘要和复现只在结果页。「过程」只放本步记录（筛选记录、精读进度、章节状态、引用核对、运行清单、清洗清单、help-wanted）。脚本和缓存留在「文件」。
- **审阅意见不随文件刷新回填（2026-09-24）**：`.ccode/review-notes.md` 只在打开这一步时读进意见框。文件列表变化不再重读，删掉的字留空，直到退回时才写回。
- **检索审阅不摊过程文件（2026-09-24）**：纳入清单和待获取留在主面。`artifacts/api-cache`、`.py`、`scripts/`、`.gitignore`、`included.json` 在收集非 Git 产物时跳过，不进顶部清单，也不随保存带回项目。文件留在工作区。右侧「过程」默认折叠。
- **期刊缩写用 ISO 4（2026-09-24）**：每个缩写词后加句点。检索步只查 JabRef 的 ACS 等五张表，不查 UBC。UBC 有而五张表没有的，写入 `src-tauri/resources/journal-abbreviations.csv`。除本课题缺的 9 个外，另补化学与能源常见刊（Nature Electronics、Nature Sustainability、Nature Chemical Engineering、Nature Synthesis、Communications Chemistry、Communications Engineering、npj Flexible Electronics、Science Robotics、Chem Catalysis、Cell Reports Physical Science、Journal of Energy Storage、Materials Today Energy、Materials Today Nano、Small Methods、Advanced Powder Materials、Science Bulletin、Science China Chemistry、Science China Technological Sciences、Battery Energy、Carbon Energy、Next Materials、Energy Storage、Electrochemical Energy Reviews、Energy Material Advances、Energy Advances、Sustainable Energy & Fuels、Green Energy & Environment、Fundamental Research）。Joule、Chem、Matter、InfoMat、SusMat、EcoMat、Next Energy、The Innovation、Research、Engineering 在 UBC 也没有，不编。Frontiers in Batteries and Electrochemistry 公开表都没有，按 Frontiers 同系列写成 Front. Batteries Electrochem.。一词刊名的缩写写全称，同步时 J2 也写。已生成的旧 RIS 下次点同步才重写。
- **同步不打开目录（2026-09-24）**：同步到 Zotero / EndNote 只交题录。自动打开会落到检索工作区的 `papers/`，Finder 分栏把 `~/ccode/workspaces` 整条摊开，也不是课题 PDF 落点。PDF 由「打开 papers」打开课题根。
- **Zotero 与 EndNote 的 RIS 分标签（2026-09-23）**：下一次检索各写一份。Zotero 的 `to-fetch.ris` 期刊全称只写 `T2`、缩写只写 `J2`，不写 `JO` 和 `N1`。EndNote 的 `endnote-import.ris` 页写 `SP`、起始页码写 `M2`、文章类型写 `M3`，不写 `M1`。已生成的旧文件不改写。纳入追加也按目标文件选标签。定稿的 `zotero_rtf.py` 与 `bridge.py` 同样分开。未在 Zotero 或 EndNote 里点过导入。
- **学术检索 MCP 配好且已登录才自动勾上（2026-09-23）**：检索步「配置学术检索 MCP」在 Consensus 与 Undermind 都已添加、Consensus 密钥已存、Undermind 已登录时自己勾上。缺哪一项，步骤卡上写一句现状。登录态只认 CLI 状态和钥匙串账号名，不读令牌，也不把 Mesa 体检的 401 当成已登录。人手取消过的保持取消。未做 Mesa Dev 实机界面验收。
- **付费墙事项就地登录学校账号（2026-09-23）**：检索步「下载付费墙文献全文」展开「待获取」后出现「登录学校账号」，跳到设置 → 网络。收起时不显示。登录仍只在设置里完成。未做 Mesa Dev 实机界面验收。
- **待确认拍完自动勾上（2026-09-23）**：检索步「核对待确认篇目」在 `included.json` 已有篇目、且每篇都是纳入或排除时自己勾上。空清单和空白判定不算拍完。人手取消过的保持取消。步骤卡和检索评审清单同一口径。已有项目不改档案卡。未做 Mesa Dev 实机界面验收。
- **EndNote 导入带上卷期页和作者全名（2026-09-23）**：检索和精读有 DOI 时向 Crossref 取作者全名、期刊、卷、期、页、日期、ISSN、摘要、关键词、期刊缩写，写入 `references.bib` 和 `papers/to-fetch.ris`。OpenAlex 只补 Crossref 没有的摘要和缩写。没有的字段留空。检索写 `papers/endnote-import.ris` 时一次写全。EndNote 2025 的 RefMan RIS 过滤器里：页是 `SP`，起始页码是 `M2`，文章类型是 `M3`，期刊缩写是 `J2`。缩写按 ISSN 查 NLM Catalog，没有再用 Semantic Scholar 的期刊别名。点「同步到 EndNote」只打开这一份，不再重新检索。定稿自动交差仍只转 bib，不联网。未在本机 EndNote 里点过导入。
- **定稿同时交 EndNote 与 Zotero 两份域稿（2026-09-28）**：润色与定稿、学位论文格式与定稿、期刊格式适配都交 `output/endnote.docx`（`ADDIN EN.CITE`，人点一次 Update）和 `output/zotero.docx`（`ADDIN ZOTERO_ITEM CSL_CITATION`，人点一次 Refresh）。不再按「文献库」二选一，也不再交 `output/zotero.rtf`。未匹配键不交 docx。LaTeX 不交。写作源稿仍是 `[@键]` 与 `references.bib`。已有课题的档案卡不自动改写；下一轮开步用新任务书才带上这两份。
- **Zotero 与 EndNote 都能导入、同步、交稿（2026-09-22）**：导入在文献来源（Zotero 读库；EndNote 用导出的 XML/RIS，不读 .enl）。同步在待获取清单（同步到 Zotero / 同步到 EndNote）。交稿口径已由 2026-09-28 改为两份域稿同时交。写作源稿仍是 `[@键]` 与 `references.bib`。
- **文献库把 Zotero 与 EndNote 收成同一种选择（2026-09-22）**：项目设置「文献库」为不使用 / Zotero / EndNote，一篇只接一个，管导入和同步。定稿交稿已由 2026-09-28 改为两份域稿同时交。写作源稿仍是 `[@键]` 与 `references.bib`。
- **英文综述的库同步只留一处（2026-09-22；2026-09-30 改按钮名）**：综述检索不默认写 `papers/zotero-sync.md`，精读按钮是「同步到文献库」，不再叫「导入到 EndNote」。文献来源选了 Zotero 才挂 `zotero-sync`。EndNote 交差只在润色定稿交 `output/endnote.docx`，人点一次 Update，不叠 RIS 导入和同步报告。科研论文和毕业论文的精读导入保持原样。
- **引用样式按 PDF 推荐，EndNote 改动经确认写回（2026-09-22；2026-09-28 改为流程线行内选定）**：不再默认 IEEE。样式改由人在流程线上选具体形式（编号方括号/上标、作者-年两种），「按期刊」可列 `references.bib` 里出现最多的刊名或自己填。`citation_style.py` 的「选定：」写入口已不在流程里，脚本仍随技能分发、老档案兼容。`output/endnote.docx` 仍是域稿，人点 Update 排版，Export Traveling Library 由人把文献抄进自己的库。人改过的 Word 由 `sync_docx.py` 出报告，只有接受的删除和新文献写回 Markdown 与 `references.bib`。细则 `conventions/pipeline.md`。未在本机 EndNote 里点过 Update。
- **目标期刊从初稿步起就落盘、下一步自动沿用（2026-09-28）**：任何步骤在「更换引用样式 → 按期刊」里选定刊名，都写 `submission/target-journal.md`（来源记「沿用已定」或「本次选定」）；打开面板时按「工作区 → 项目根」顺序读回，已定刊名显示成「沿用已定：X」按钮，不再重问。此前只在「润色与定稿」步写、且沿用按钮读的是已无人写入的 `manuscript/citation-style.md`，等于每次都重问。
- **引用样式改了要能看出落没落（2026-09-28）**：点选时记下改前 `manuscript/citation.csl` 属于哪一类（数字制/作者-年，`styleFamilyOf` 判 `citation-format` 与 `citation-number` 布局），人再打开这一排时重读比对；样式文件没变就用行内提示说「可能只重渲了 PDF」，不谎报成功。`citation.csl` 不进 `expectedArtifacts`：从没选过样式的稿子会被机械门卡住。
- **想法卡片接回上次对话（2026-09-29）**：同一张想法卡再点「聊想法」接回归在这张卡上的最近一次会话，没有才新开。「沉淀进任务书」仍只在这一步开工前出现。
- **初稿开工时问正文字体（2026-09-29；2026-09-30 改到工作区）**：综述、论文、学位论文初稿在开工后、第一次渲染前问一次：默认英文 Times New Roman、中文宋体。不做成话题种子，也不放进「跟 AI 商量一下」——那条会话只允许改任务书和项目规则里点名的行，写不了 `manuscript/reference.docx`。`manuscript_font.py` 写入 YAML 的 `mainfont` / `CJKmainfont`，并生成 `manuscript/reference.docx` 与 `manuscript/typeface.md`，两份都是初稿步预期产物。PDF 走 xelatex，Word 必须带 `--reference-doc`。本机没有这套字体就停。定稿沿用 `manuscript/typeface.md`。
- **完结文件在项目卡，全部步骤保存后才出现（2026-09-29）**：流程里有定稿步，且每一步都已保存进项目，项目卡才列出完结文件。后面追加的步骤还没完成时不出现。顺序是最终稿、可改源稿、图、文献来源、核对与修改、精读笔记。工作区里这一轮的文件优先于项目里的旧同名文件。点开到文件页。`output/figures/` 和样式文件不列。
- **域稿带上正文拼图，渲染副本不进产物清单（2026-09-29）**：`cite_docx.py` / `zotero_docx.py` 把 `![说明](../figures/figN.png)` 嵌进域稿，说明里的 `[@键]` 仍是引用域。找不到图或读不出尺寸就不交 docx。`output/figures/` 是 Quarto 为普通 Word/PDF 复制的同一张图，非 Git 产物评审不再列出。
- **审查条目在步骤上点，点完接回对话（2026-09-29）**：润色、定稿、期刊格式、返修、LaTeX 定稿的「逐条决定审查报告」，以及综述润色的「逐条裁决」，在步骤行内逐条点接受、拒绝、修改，也可以全部接受，写回报告。全部点完后点「让 Agent 按决定继续」，才勾上这一行并接回原来的对话。去评审不写入这些决定，稿件在且 Agent 没在出字时就出现。域稿两行收成可选「换样式时打开域稿」，只说明打开哪一份、在 Word 里点 Update 或 Refresh；不挂同步到 Zotero / EndNote / 打开 papers。
- **内嵌终端补齐四项协议（2026-10-10）**：对照 Codex / Grok / Gemini / Qwen / Kimi / OpenCode 的公开终端实现。① Kitty 键盘只应答 flags 5，不宣布松开；子进程推了非空 flags 后功能键与带修饰键走 CSI-u，弹出则恢复。② OSC 8 只开 http(s) 与 mailto；OSC 52 限长后写入系统剪贴板。③ 运行中「修改」改为「本次」浮层，不撑高 xterm。④ Kitty 图形到了才在右下角预览，不把 `TERM_PROGRAM` 改成 Ghostty 或 Kitty。Sixel 只从文字流拿走、不解码。细则 `conventions/terminal.md`。未做 Mesa Dev 实机界面验收。
- **换引用样式时四份成稿一起重做（2026-09-29）**：定稿开工先问沿用初稿编号还是改成目标期刊。换期刊读作者须知，并从 `references.bib` 取该刊最近 2–3 篇综述核对；库里没有或两边不一致就停下来问。选定后重渲 PDF 和普通 Word，并重新生成 `output/endnote.docx` 与 `output/zotero.docx`。初稿仍固定编号，不问格式。
- **引用格式只在定稿步定，初稿固定编号制（2026-09-29）**：三套模板的起草步（综述初稿、论文初稿、学位论文初稿）**不再挂「更换引用样式」**——初稿步没有讨论种子、没有决策项，五个全局设定（综述角度/目标篇幅/读者与文风/去向/综述深度）也不含引用格式，所以「跟 AI 商量一下」这条路本来就不管格式；唯一能定格式的地方是流程线选择器。去掉后初稿按编号制渲（YAML 写 `csl: citation.csl` 并放随包 `ieee.csl`），各起草步简报写明「引用格式在定稿步的『更换引用样式』里再定，这一步不装选择器」。定稿步保持「更换引用样式」（空落点纯脑力事项）。
- **原「确认引用样式」形态已回退（2026-09-28 提出，2026-09-29 撤）**：曾把三套定稿步（综述润色与定稿、科研论文润色与投稿准备、毕业论文格式与定稿）改成「确认引用样式」，带核实面板、`manuscript/citation-confirmed.md` 落盘、绑定 csl 版本，并新增 `decisions_cleared` 完成判定。该口径已整体删除（含 `isCitationConfirmTask`、`citationConfirmDoc`、`citationConfirmChecks`、确认面板与相关测试）——引用样式只有「更换」一种形态，`isCitationStyleTask` 认新旧标题（「更换引用样式」/「填写引用样式」），流程线标签统一走 `humanTaskLabel`。
- **未裁决的 [待核实] 拦住定稿（2026-09-28）**：润色步 agent 按 `[待核实]` 与 citation-check 的「疑似编造/元数据存疑」列全 `manuscript/verification-decisions.md`，**裁决与依据两栏留空、不得代填**（代填等于替人拍板）；人工事项「逐条裁决」走新完成判定 `decisions_cleared`——每条 `- … 裁决：<非空>` 都填、且无「待裁决」才算完成。与 `no_placeholders` 分开的理由：后者认的「待填/待确认/[待补/TODO」在正文里是正常行文，拿它判会把这一步误卡死。新增判定同时改 `types.ts`（两处联合类型）、`normalize_human_completion`、`HUMAN_COMPLETION_LABELS`、`task-md.ts` 与 `HumanTasksList` 的文案。
- **科研论文加大纲，改稿先出审查报告（2026-09-22）**：科研论文在结果分析与初稿之间增加「论文大纲」，产出 `manuscript/outline.md`。其余五套模板不增步骤。分析结果写「## 结论条目」；精读/开题写「## 已批准问题与范围」，实验设计写「## 已批准设计」，后续任务书只执行已批准的句子。初稿与 LaTeX 章节写作另写 `manuscript/section-status.md`（允许集 + 每节状态），不拆成八个写作步骤。润色、学位定稿、LaTeX 定稿、期刊格式、返修的科学改动先写入审查报告，人逐条写成接受、拒绝或修改后才改稿；科学改动与措辞分开。步骤卡显示报告自述的质量状态和待核实/待确认计数。已有项目不改档案卡。同名步骤的交付文件变了，整套追加会被拒绝，避免把大纲插到末尾或悄悄换掉正在用的任务书。新课题应用模板才带上。细则 `conventions/pipeline.md`。未做 Mesa Dev 实机界面验收。
- **Grok 推理强度可多选、开场只注一档（2026-09-23）**：网关思考档勾多档，存成 `low,high,xhigh@high`（`@` 后是开场默认；单词旧值仍是单档）。启动只把默认档写进 `default_reasoning_effort` / `--reasoning-effort`。设为全局把勾选档写成该模型的 `reasoning_efforts` 菜单，会话里切换。斜杠串和拼写错误丢掉。中转目录把模型标成 `supports_reasoning_effort = false` 时改回 true。菜单仍只走设为全局（overlay 放不进 `[model.*]`）。未做 Mesa Dev 实机点选。
- **Grok 设为全局写出推理强度菜单（2026-09-22）**：自定义端点的 `/v1/models` 不带 `reasoning_efforts` 时，Grok 1.0.40 不出 `/effort`。`[models].default_reasoning_effort` 只是默认值。`patch_grok_config` 对每个绑定模型写 `[model.<id>]`：`supports_reasoning_effort = true` 与四档 `reasoning_efforts`（`value`/`label`/`description`，对齐内置 grok-4.6）。字段写成 `{ effort = "..." }` 会被整段丢掉。已有菜单不覆盖。2026-09-23 起显式 false 改回 true。启动注入的 GROK_CONFIG overlay 仍放不进 `[model.*]`，菜单只走设为全局。未做 Mesa Dev 实机点选。
- **Quarto 成稿曾默认编号引用（2026-09-22，同日改为按 PDF 推荐）**：不写 `csl` 时 Quarto 会走芝加哥作者-年。编号样式仍随包为 `ieee.csl`，作者-年为 `author-date.csl`，但不再默认套上。人选定后才写 `manuscript/citation.csl`。源稿仍是 `[@bib键]`。
- **人工精读修改进得了下一步（2026-09-20）**：两道口一起补。① 文件页沉浸阅读入口对称化：PDF 与 `.md` 笔记行（目录树行 + 搜索/筛选平铺行 + 预览工具条）都能 ⺆ 进阅读区，md 走 `reader_for_note` 配对（无配对 PDF 就报错不硬进，仅摘要笔记仍无阅读区——纯笔记模式未立项）；配对回退层从「只扫 project.toml 登记 paper 资源」放宽为也扫 `papers/` 顶层（agent 直下全文没走登记通道也能配）。② 开工确认弹层新增未存进历史软门：未提交改动与本步 inputs 相交 → 列文件 + 就地「存进历史」（只提交命中子集，消息「开工前存档」）+ 二击开工；不相交仍只是主仓提醒行。场景：精读步合并后在阅读区改笔记，未提交就开综述大纲——工作区从基准 HEAD 建树，人工修改静默进不去。死代码 NotesListSection/DataListSection 一并删除。细则 `conventions/step-panel.md`。未做 Mesa Dev 实机界面验收。
- **停工门按步骤从合同派生**（2026-09-19）：六套模板的 TASK.md 都走 `decisionPolicyBlock`。必须停的来自硬暂停决策、先报再问、开工前/执行中必做人工事项、格式适配的样张。可选收尾（如沉浸阅读）不算中途停工。批次提交不是停工。开步首条与「继续」同一句。不靠自动拆任务或自动连发「继续」。已有项目改任务书或下一轮开步才带新口径。细则 `conventions/pipeline.md` / `step-decisions.ts`。
- **精读流程线不再问文献库交付**（2026-09-19）：三个胶囊不是执行钮，和检索步「同步到 Zotero」抢同一件事。Zotero 进库只留待获取那一颗；`libraryExport` 只保留 EndNote，问在项目设置（无精读才问投稿适配）。zotero-sync 只跟 `lit_source`。
- **精读步不再挂「继续精读笔记」人工事项**（2026-09-19）：那是说明书，不是收尾活；占主干、写「验收后」却排在去评审前。入口只留笔记/PDF 上的「⛶ 沉浸阅读」。文献库交付仍问在精读、可选、不挡去评审。已有课题档案卡同步删这一条。
- **技能「副本需同步」必须有按钮（2026-09-20）**：预览头「内置」旁的「副本需同步」是 copy 分发漂移（Cursor/Grok），原先只在行内 ⋯「重新分发副本」，用户找不到更新钮。预览头与列表行都加「同步副本」走 `resync_skill_copies`。内置种子新版仍在页顶「查看差异 → 备份并采用新版」。新内置技能只在启动播种，须重启 Mesa Dev。
- **综述用图从笔记铺到初稿（2026-09-20）**：用户：拼图不能初稿临时想；随后要自动从 PDF 裁图拼板、美观交给 agent。精读记可引用图 → 大纲用图计划 → 初稿挂 `review-figures`（PyMuPDF 按题注裁切 fail-closed，脚本组 panel 写 figures/，裁失败降级为「见 Fig.n」）。不新做裁图 GUI。已有笔记不静默补图号。细则 lit-notes / review-framework / review-figures。
- **精读可选区继续精读（2026-09-20；2026-09-30 改按钮名）**：用户要在文献库按钮底下加「继续精读笔记」。不是人工事项、不挡评审。与「同步到文献库」同一套复选框+右侧按钮。保存进项目后点「去笔记夹」打开文件页 `notes/`（不替你开某一篇 PDF），再点笔记行 ⛶。英文综述大纲、毕业论文开题、科研论文实验设计的 inputs 都含 `notes/`；人改过的笔记靠未存进历史软门进下一步。细则 `conventions/step-panel.md`。
- **文件类评审对齐检索/精读页签**（2026-09-20）：用户发现综述大纲仍是 Git 双栏，随后否决「对照改动」抽屉（过时）。检索/精读/大纲同一套基础检查旁页签：清单或笔记/稿件／过程／文件；默认内容页，Git 只在「文件」。`help-wanted.md` 进过程组。同日补齐：`survey/` `submission/` `rebuttal/` 进稿件主面，渲染 PDF 不抢源稿；六套模板含返修每步分档 + files 档产物能进主面有单测守。
- **评审壳增加 files 档**（2026-09-19）：用户发现精读评审套了实验验收壳。分流改为 screening / files / acceptance / default。精读与写作看分组文件后保存进项目；实验/清洗/EDA 才有验收摘要和接受/退回。六套模板按产物判定，不按步骤名各做一页。
- **精读笔记禁止摘要灌装交差**（2026-09-18）：叙述用中文，术语可留英文原词，禁止整段粘贴英文摘要；未读完不生成占位文件（否则界面标已读）；机器验收只管 index 覆盖，不要求每篇都有 `notePath`。TASK 简报不得写「每篇产出笔记」当完成标准。技能与三套精读模板同步。已有项目下一轮开步才带新简报。细则 `conventions/pipeline.md` / lit-notes 技能。
- **机构访问通道=人登录一次、系统复用会话（2026-09-16）**：付费墙全文获取不做「AI 拿学校账号自动登录」（MFA 过不去、SSO 密钥敏感、脚本式批量下载会被出版商风控连坐全校）。用户在设置 → 网络「机构访问」配 EZproxy/OpenAthens 前缀 + 在独立登录窗自己完成 SSO（含 MFA），后端 `inst_access.rs` 读登录窗 Cookie 落 0600 `inst-session.json`；`fetch_paper_fulltext` 阶梯 = 开放直链 → DOI 合法开放副本（Unpaywall/OpenAlex）→ 机构通道（前缀改写 + 会话逐跳注入 + 落地页 citation_pdf_url 提取）。入口三处（to-fetch 清单/雷达来源行/watch-followup 待办），只由人逐篇触发，无头不携带会话。同日夜修订：窗口点 PDF 不得主框架导航（Wiley/ACS epdf 是图片阅读器，WKWebView 内联 PDF 也像跳进一张图）——拦住走下载漏斗；开窗 about:blank 刷浅底防黑屏。细则 `conventions/pipeline.md`「机构访问通道」/ `safety.md` 会话罐。未做 Mesa Dev 实机界面验收。
- **启动注入切聊天要立刻「进行中」（2026-09-14）**：带首条指令的新会话启动同时拉起聊天 `pendingReply`。从终端切到聊天，会话文件还没落盘也要显示正在回复、发送钮变进行中；TUI 开屏不算这一轮已经说完。纯逻辑 `tab-working.ts` `onPtyWorkingSilence`。
- **Codex Shift+Enter 换行（2026-09-15）**：内嵌 xterm 对 Shift+Enter 仍发 `\r`，Codex composer 当成发送。键盘层改写为 kitty CSI-u `\x1b[13;2u`。细则 `conventions/terminal.md`。
- **Codex 网关不要关 `features.apps`（2026-09-15）**：0.154 上 `-c features.apps=false` 会把用户 HTTP MCP（Consensus / Undermind）收成 `mcp__<名>` 占位，调用即 `unsupported call`（密钥已注入、端点可达也一样）。网关只关内置插件 `plugins.codex-app-tools@openai-bundled.enabled=false`，仍注 `web_search=disabled` / `service_tier=auto`。禁止 `enable_mcp_apps`。远程 MCP 不要默认写长 `startup_timeout_sec`（恢复会话会等满超时才画 TUI）。细则 `conventions/safety.md`。
- **MCP 密钥栏由 Mesa 注入（2026-09-15）**：引用 `$VAR`/`${VAR}` 的 MCP 在表单给出密钥栏，值存 `<config>/ccode/mcp-keys.json`（0600），清单与各 CLI 配置仍只留引用。体检 `expand_host_value` 与 Agent 启动（PTY / 无头）注入该表；系统环境是回落。Consensus 把密钥误填进 `${ak_…}` 变量名时，保存自动改回 `Bearer ${CONSENSUS_API_KEY}` 并收进密钥表。细则 `conventions/safety.md`。
- **检索步学术 MCP 只留入口（2026-09-15）**：可选事项「配置学术检索 MCP」不写就地小字（候选库怎么并进本步、认证状态）。只留 Consensus / Undermind 预设入口和「去终端登录」。悬停 title 仍说密钥/OAuth。不配也能用 OpenAlex/Semantic Scholar。MCP 仍是 Agent 用户级分发。细则 `conventions/pipeline.md`。
- **检索步学术 MCP 就地给做法（2026-09-14）**：可选事项「配置学术检索 MCP」不再只剩勾选。认证做法：Consensus 在 MCP 页填 API 密钥（不必设系统环境变量）；Undermind 登录在 CLI 里，Mesa 体检 401 也正常，须先「去终端登录」（空会话、不注入检索）——点「开始」会直接干活。预设入口打开 MCP 页表单。流程线小字已撤，见上条。
- **商量过写在按钮文案上（2026-09-14）**：流程线「跟 AI 商量一下」在能接回本步上次认领会话时改「继续讨论」（同款线框，不用强调色），点下去 resume 那条会话（不注入开场、不另开一轮）；接不回仍是「跟 AI 商量一下」。TASK.md 有正文时只用强调色字、不加框。细则 `conventions/step-panel.md` / `pipeline.md`。
- **创建设定屏交付字段分级（2026-09-14）**：选完模板后的设定屏只填项目全局设定。稿件载体问在会换正式稿的步骤（期刊格式适配 / 返修），不在综述/论文写作步问——那些步仍出 Markdown。文献库交付问在精读（无精读才在投稿适配）；Origin、Blender 问在用得上的那一步且不挡主动作（结果分析 / 实验设计或研究方法；综述不问 Blender）。答案仍是项目级 `科研工具/*`。文献从哪来仍只在检索步。流程编辑器仍可改。细则 `conventions/pipeline.md` / `step-panel.md`。
- **「跟 AI 商量一下」直接进终端（2026-09-12）**：检索等步骤点入口后自动启动，用项目 Agents 页的默认 Agent 和绑定，不是上次终端连接。没设项目默认才停在启动栏。不再带开右栏 TASK.md 预览。看任务书用流程线「预览/编辑 TASK.md」。撤回 v3.77「开聊自动带开草稿预览」在这条入口上的行为。细则 `conventions/pipeline.md`。未做 Mesa Dev 实机界面验收。
- **项目内新会话走 Agents 名册（2026-09-12）**：＋新对话、跟 AI 商量、聊想法、问 AI（带了项目默认时）解析 `projectAgentLaunch`：有项目默认 Agent 且这家有连接则直接启动该绑定（绑定已删回落该家第一条）。未设项目默认才回落问 AI 勾过的「设为默认」，再否则弹层选。⌘/Ctrl 点仍强制重选。编程进入工作树同一口径。不沿用 `ccode.lastLaunch`。未做 Mesa Dev 实机界面验收。
- **文献来源单一触点收回流程线（2026-09-12）**：添加项目不再问「文献主来源」。文献从哪来只在检索步「确定文献来源」写 `lit_source`（search / zotero / folder）；选 Zotero 才给检索/精读步补 `zotero-sync`。稿件载体、Origin、Blender、文献库交付仍是项目工具合同；问在用得上的那一步或「编辑研究流程」，不在创建设定屏。旧 `科研工具/literature` 写回时剥掉。EndNote 导出走 folder（放入 `papers/imports/`）。细则 `conventions/pipeline.md`。未做 Mesa Dev 实机界面验收。
- **普通目标副本两步清理（2026-09-11）**：工作副本与历史冻结版本分两次、各需确认；清理后保留任务与接受账本，禁止从已删副本续跑，只能从当前项目重新开始。中途失败保留恢复单与「继续清理」。不得删除仍被其他项目或运行引用的目录；中断后待删目录被外部修改或替换则拒绝继续删除。归档确认须写明归档不等于清理、副本仍占磁盘；待验收可归档（主列表不再提醒），未完成接受或未完成清理不得归档/恢复。细则见 `conventions/review-freeze.md`。未做 Mesa Dev 实机界面验收。
- **普通目标卡摘要与详情分层（2026-09-11）**：卡面标题限两行原文，副行合并状态、Agent 与数量型写回摘要；已采纳文件和声明输出范围分别计数。点「详情」展开为任务卡：要求 / 成果 / 历程分栏，底栏归档与释放副本；同一段原文只出现一次。已完成目标的返修降为辅助操作，待验收/继续/开始的优先级不变。只改展示，不生成 AI 标题、不覆盖存储目标、不改变传给 Agent 的指令或接受契约。细则见 `conventions/design-system.md`。
- **普通目标验收弹层稳定性（2026-09-11）**：首次清单、保护路径和工作环境合并呈现，外框受视口约束、正文独立滚动。打开期间固定所审版本；目标列表轮询不得因 Run 对象重建而重载评审、替换勾选或切换预览。关闭重开读取当前版本，采纳仍携带原 `expectSeq` 并由后端判定版本漂移；读取失败不伪装空成果。细则见 `conventions/review-freeze.md`。
- **可靠性收口：原版本接收与中断恢复（2026-09-11）**：普通目标接受前持久化原版本、选择、前后哈希、备份及人工决定，文件/账本/目标状态/摘要逐阶段恢复；已完成文件阶段不因后续用户编辑而重写。恢复原文件先标 rolling_back，重启后不能误继续接受。列表从原 Run 的恢复单找回入口，未完成不得归档/返修。科研非 Git 产物改为评审时冻结的完整哈希副本，合并要求 Git SHA + 产物 token；合并前保存父提交与接收计划，中断只定位原合并，不猜最新版本。归档必须确认 ignored 产物已安全保留。详细边界见 review-freeze.md / pipeline.md；此条替代历史「实时扫描带回」与「只提示重复采纳」实现口径，不扩展编排功能。

- **设置分类常驻（2026-09-11）**：设置页恢复左侧分类/右侧内容，常用与管理所有分类常驻；取消横向描边芯片和高级总折叠，选中分区只显示静态标题。布局按设置区实际宽度响应，窄窗口导航上移而不隐藏分类；存储与诊断按当前分区加载，旧折叠存储不删除但不再消费。收件箱分区跳转、可更新提示、各设置保存及安装/诊断操作保持原语义。细则见 `conventions/design-system.md`。
- **科研工具与步骤交接（2026-09-11）**：保留六套模板，以 settings 中显式工具偏好扩展现有步骤合同，不建独立编排/自动路由。来源与库交付分离；Origin 仅 Windows、EndNote 仅文件桥/人工插件、Blender 仅可追溯示意并保留后台重建。Zotero 采用只读在线内存快照，增量导入独立候选并登记引用资源；已有 citekey 不自动重写。模板追加同时核对同名交付，旧模板/技能升级先看差异并人工确认。复现输出/脚本合同统一；上游科研验收可引用但不自动放行新的执行，文件合并与科学批准继续分离。具体安全与验收边界见 conventions/pipeline.md、conventions/safety.md。


- **全局内容卡按所在画布派生（2026-09-11）**：统一范围从项目扩到工作台/连接/技能/MCP/定时/用量/设置及展开子卡。`.ccode-well` 共用「工作面基色 65% + raised 35%」不透明混色；`PageFrame data-surface` 区分 canvas 与 workspace（rail2），独立 canvas 抽屉/覆盖层重置继承。CSS 放 components 层，不压住 hover/选中工具类。按钮、输入框、语义色、浮层外壳及代码/diff/PDF/xterm 不纳入刷底；不把透明列表强行卡片化。覆盖此前仅项目页的固定 rail2 配方，细则 `conventions/design-system.md`。
- **普通目标区聚焦当前动作（2026-09-11）**：无流程科研与办公共用紧凑目标清单，页头不重复卡片标题，待验收优先；单一状态不重复分组，只有第一项可执行动作高亮。历程按需展开、已归档默认收起，归档确认与恢复、重试复用隔离副本、冻结验收契约均不变。科研流程步骤和编程工作树不进入本改动面；视觉细则见 `conventions/design-system.md`。
- **项目卡片底色统一派生（2026-09-11）**：项目实际画布为 `rail2`，内容卡一律共用 `.ccode-well` 的 `rail2 65% + raised 35%` 不透明混色；科研步骤/流程带/工作区与编程工作树、普通目标、资源面不再各取 inset/strip。深浅与自定义主题同一配方，连线遮罩同色，嵌套不累积透明度；按钮、状态与选中态不纳入统一刷底。细则 `conventions/design-system.md`，替代 v3.247 的深浅分配色口径。
- **普通目标有效环境与成果上下文绑定（2026-09-11）**：context.json 不只是提示词摘要；保存实际传入文本、隔离文件清单、项目规则参考、知识摘要与点名技能库/Agent 副本完整摘要，读取关键材料失败或点名技能未同步拒绝开工。返修上下文独立存储，结果快照带 contextId，不能用下一轮上下文解释上一版成果。明确未封存 CLI 全部有效指令和外部工具状态，不宣称 Agent 实际用了某技能。
- **科研验收按版本而不是工作区名字（2026-09-11）**：科研/自由目标共用来源解析与面板，人工接受绑定 Project + 结果版本 + 来源指纹 + 证据文件；复现记录绑定同一来源并记录独立结果指纹。来源/结果变化后不得沿用；归档回落项目根只表示当前版本，不冒充历史复现。Git 接受与科学接受仍分开。
- **人工项目知识可修订与失效（2026-09-11）**：仍存 memory.md，不做向量库或自动记忆；结构化块有来源、文件指纹、状态、替代关系及依据。项目设置可人工新增/修订/作废/停用旧自由文本；版本检查+文件锁+历史备份，旧内容不丢。有效知识最新优先，来源漂移或超过校验预算只提示待确认，不当作当前结论注入。
- **有界大文件与显式可审状态（2026-09-11）**：输入复制前预检，保持 512 MB/20,000 文件隔离上限；普通结果默认单文件 64 MB/总 512 MB，人确认后允许本 Run 单文件 1 GB/每版总 4 GB。冻结、备份、写回按流处理；新 Run 冻结失败不降级为实时采纳，旧 Run 兼容单列。收尾重新核对部分成果，无内容变化不增版本；readiness 由事实派生进评审 DTO，不拿退出码或执行次数冒充结果状态/版本。
- **办公成果审阅不冒充格式验证（2026-09-11）**：幻灯建议同次输出同名 PDF；评审只配对同一结果集合中的 PDF，不从别处猜旧预览。可打开原文件或定位；配套 PDF 是独立文件，Mesa 不自动证明 PPT/PDF 一致。文本预览截断必须提示，切换文件不能残留上一份正文/错误。

- **项目 Agents 保留两列（2026-09-11）**：按紧凑名册样式收敛信息层级，但沿用原两列与窄屏单列；默认入口常驻、连接名与模型分行、管理连接是跳转而非本页配置表单。只改展示，不改默认 Agent / profile 解析、目标归属或分配入口。视觉细则见 `conventions/design-system.md`。
- **项目可以另选连接里的模型（2026-09-22）**：Agents 下拉列出该连接名单上的每一个模型，不再只显示第一个。点选写入项目 `defaultModels`（agent → 模型 id），启动（开聊、开工、跟 AI 商量、进入工作树、目标开始）在该模型仍属于这条连接时使用它；不在名单里则回落第一个。不改连接页的名单顺序，也不改 Mesa 启动栏或 CLI 全局配置。加减模型仍去连接页。
- **编程工作树展示分层（2026-09-11）**：工作树是开工入口，本地分支是折叠管理区；已检出分支不重复树状态。主仓降为两行与轻入口，改动/拉/推进菜单，基准标记只认真实检出；原安全确认不变。功能树进入用文字次按钮，Agent 活动与 Git 事实分开，基准多/少提交与远程同步各自写清；无上游不推断从未推送。再开一条只在对应树菜单，仍由人确认创建。细则 `conventions/coding-git.md` / `conventions/design-system.md`。
- **文献雷达日期与缺失态（2026-09-11）**：巡检新产出仍用 `watch-run` 注释；消费层只读兼容旧版明确的巡检日期标题，按最近批次归属并校验日历日期，不猜发表日/文件时间。补识别日期不更换旧条目忽略 ID；趋势明确标名，缺日期不显示成零命中，部分缺失须说明漏计。细则 `conventions/pipeline.md`。
- **结果版本与执行身份分离（2026-09-10）**：普通目标每版冻结副本不可变，当前清单只作入口；旧版本不随回合刷新删除。返修继承原始基线与未采纳成果；先前已接受内容由账本完整哈希授权为下一版的前态，外部漂移仍拒绝。采纳必须绑定所审 seq，项目锁覆盖检查、原子文件替换与接受记录。普通目标幂等键含结果版本、路径集合与意见，不能用 Run 次数吞掉后续接受事实。细则 `conventions/review-freeze.md`，替代 9 月 9 日初版的共享 payload/按 Run 去重口径。
- **接受事实不由进程退出重写（2026-09-10）**：完成目标只能由人显式返修重新开启；CLI 正常退出、失败或停止均不得覆盖已完成状态。显式返修可复用活 Run，但必须记录意见并把目标重新置为进行中。
- **Git 接受与补账分阶段（2026-09-10）**：新合并必须绑定已审提交并按该 SHA 合并；界面自己的提交只在返回提交哈希与当前完整 HEAD 匹配时重新绑定，静默刷新不得换已审版本。补账只重放原凭证的版本、路径与时间，不按最新 HEAD/diff 推断，不顺带合并新工作；凭证损坏或缺失需人工处理。账本未完成不归档；已合并后可单独补账、归档。未跟踪的验收账本与锁不阻塞下一次合并，已跟踪改动与其它 `.ccode` 文件仍按用户工作保护；编程接受版本取实际基准工作树 HEAD，不动项目根检出。
- **项目位置按稳定身份解析（2026-09-10）**：目标启动/采纳及 Run 查询按 ProjectId 解析注册表当前位置，历史路径与 CLI 源文件不改写。真正搬家时事务内关联旧目标/Run 的缺失 ID；原目录仍存在的同 ID 副本拒绝自动接管，不自动改任一项目身份；多位置冲突不任取一项。Git 工作树指针修复仍遵守显式漂移处理，不以更新项目路径代替 Git 修复。

- **继续会话回收过期 Run 锁（2026-09-10）**：交互 `pty_spawn` 在没有活 PTY 时回收内存/文件锁，并把 `starting`/`running` 的僵尸 Run 拉回可启动；有活 PTY 仍拒绝。前端同一 Run 启动未完成时不连点。无头路径不走这条。

- **项目继续会话预填项目绑定（2026-09-10）**：项目 Agents 页给这家绑的配置（含 Codex 官方账号）必须出现在启动栏，不能被「这条对话上次走网关」的兼容池悄悄换回旧连接。渠道和上次不同时预填绑定、不自动启动，提示确认后点运行。侧栏全局对话页没绑项目配置时仍按原 Run / 渠道挑。

- **项目页继续会话不要误报「进程已退出」（2026-09-10）**：项目对话「继续」会复用旧 Run 并自动启动。开发态 StrictMode 会把自动启动跑两遍，第二次抢同一把 Run 锁，界面同时出现「进程已退出」和「此运行已在启动或执行中」。自动启动改为卸载可取消；启动失败不再标成进程退出；同一 resume 标签没在跑时再点继续会重试。项目绑定配置（优先用项目里选的连接）仍走这条链路，不是根因。

- **会话包与目标包拆开（2026-09-10，用户拍板）**：项目页＋新对话 / 问 AI 与「新建目标」不再共用同一份开工说明。会话包 = 项目身份、顶层目录、规则、长期知识、已验收事实 +「这是对话不是副本，按用户这次说的做」；不注入当前目标、尚未完成、技能名单、写回时跳过、「产出经人验收后才进项目」。目标包维持原说明（材料、技能点名、尚未完成、验收写回）。勾「验收后写入」仍走目标包。编程：进入已有工作树用会话包，从基准新建工作树用目标包。实现 `ContextPackKind`（`src/project-context.ts`）。闲聊用对话、成稿用目标（v3.241）补上注入层。

- **项目内「对话」页签（2026-09-10）**：排在科研/工作/编程任务前面；打开项目默认仍进任务页。只列当前项目会话，默认铺开列表、点一条才回放。任务页不再放右侧对话栏。规则和验收记录收进项目设置抽屉。侧栏「对话」仍是全局历史。覆盖此前「项目对话不成第四个页签」。
- **内核契约 + 科研流程保留（2026-09-10，用户「全部执行」拍板）**：规格 `docs/audits/workspace-kernel-design-2026-09-09.md`。抽出 `review_contract.rs`（账本 `commit_fact`、Git `reviewed_sha` 与合并后 HEAD 分列、派生 Result Readiness）。科研半自动化流程对象全部保留；合并 = 文件准入记账（`pipeline_merge`），科学结论仍单独点。编程合进基准写 `coding_merge`；定时采纳写 `watch_adopt`。tasks/runs 读取按 `project_id` 三分支；搬家更新工作区/车道位置缓存。不新建 ChangeSet 表、不改导航、不自动拆任务。

- **归档案面与验收账本可见（2026-09-09，审计整改优化，已落地）**：普通目标 `task_list` 默认不返回已归档行（`include_archived` 才带上）；目标页「已归档」折叠可恢复（`task_unarchive` 清 `archived_at`，幂等）。验收账本 `.ccode/acceptance-log.jsonl` 经 `read_acceptance_log` 在目标页只读展示最近若干条。勾选「沉淀进项目长期知识」写入失败与账本同口径 fail-closed（文件与账本已写下则提示再点一次采纳补记；`memory.md` 按 run_id 幂等不重复行）。不改科研/编程回流，也不做 §4.6 读取侧全量迁移。未做 Mesa Dev 实机界面验收。

- **Grok 继续链合并（2026-09-10）**：Grok compact/继续会 fork 新目录并写 `parent_session_id`，`generated_title` 常与父会话相同。扫描时与 Codex `forked_from` 走同一套并查集，列表只留最新代表，`chain_count` 显示「N 次继续」；删除代表时成员文件一并进回收站。

- **全站界面按工作面收敛，不换皮（2026-09-09，第一波已落地）**：对照 Linear 与十五张截图评审，病在空间分配和主次，不在配色。不重做导航、不加主题、不把青绿写成产品默认（自定义主题的强调色归用户）。规则：① 项目任务井 container 窄于 56rem 时右侧对话改抽屉，开关 `ccode.projectSessionsOpen`；② 空态只回答下一步（无目标 EmptyState；终端去掉点阵，一个「运行」；标签不用 `~`）。工作台「正在进行」只在有活进程时使用。对话回放跨消息合并纯工具调用为「执行记录」。编程工作树行保留进入/改动/拉取/推送符号，其余进 ⋯。浮层禁用原生 select（`MenuSelect`）。项目页深色阶梯学 Linear：应用栏最深，项目栏与内容同底 rail2，目标/工作树/步骤/预览 inset 浮起一档，不套井。第二波（自定义浅色降饱和）与第三波（资源页精修）未做。

- **会话聊完自动起名（2026-09-09，2026-09-10 收紧主题，已落地）**：展示标题格式 `MMDD|类型|主题`；日期用会话创建日、上海时区，不用更新时间或当天。类型闭集：功能/设计/修复/优化/发布/探索/文档/研究。主题 8–28 字、至少 4 个汉字，写成对象+动作，须能区分同类工作。开头只根据第一条真正的用户问题写临时标题；Agent 退出后再用用户原话（首条意图 / 中途纠正 / 最后定题）校正，不送助手回复。写入 `session_meta.custom_title`，`title_source=auto`，不写回 CLI 源文件。人手改过的标题（`title_source=user`）不覆盖；问候-only / 无创建日 / 内部无头会话保持原标题。已占用的「类型|主题」不得重复（提示模型改写，仍撞车则加 `·2`）。打开对话页时对过短/空泛/缺标题/撞车的自动标题按新规则重起名。配置复用「会话摘要」profile。外部 CLI 自行发起的对话不自动起名。未做 Mesa Dev 实机界面验收。2026-10-11 起设置页「集成 → 会话自动命名」可关（`auto_title_sessions` 默认开）：关 = early/final 起名与补名重起全停，已有标题保留。

- **普通目标评审冻结（2026-09-09，已落地）**：普通目标（free_research/office_doc）采纳从「采纳瞬间现读目录」改为「开工写基线哈希 + 收尾冻结变更内容 + 采纳三向判定」。开工 `write_baseline` 记隔离目录与项目根双侧 sha256（写失败 = 开工失败，Run 记 failed）；Run 收尾冻结变化文件内容进 `task-runs/<task>/review/<run>/payload/`（快照拒绝改写，失败/停止的 Run 也冻结）；评审与预览只读冻结副本，采纳时逐文件判定「项目现读 == 基线才允许写」并再校 payload 哈希——人审的版本与写入的版本逐字节绑定，任务期间项目被改则点名拒绝。删除永不自动写回；单文件 >64 MB 进清单不可自动采纳；旧 Run 无快照退回旧路径并前端明示「未冻结」。复用 watch_review 同构机制而非另起引擎；mtime 降为候选发现、不作归属依据。「completed 才能审」的入口解绑留后续批次。规格 `docs/conventions/review-freeze.md`；同日修复复用上一版目录时启动失败误删旧成果（`cleanup_failed_prepare` 只清本次新建目录）。未做 Mesa Dev 实机界面验收。

- **验收接受记录长期化（2026-09-09，已落地）**：普通目标采纳写文件成功后先写 append-only 账本 `.ccode/acceptance-log.jsonl`（目标/Run/路径/意见/是否冻结/时间，按 run_id 去重，重试幂等）；账本落盘失败 = 采纳返回可见错误引导重试，不静默成功。`project-status.json` 降为账本的「最近摘要」投影，摘要写失败记 logbuf + 事件。删除目标只清工作数据（Run/事件/隔离目录/评审证据），不再连带删接受摘要；账本随项目 `.ccode/` 存续。归档案面与账本只读展示见同日后续决策「归档案面与验收账本可见」。未做 Mesa Dev 实机界面验收。

- **Agent 写入主仓政策统一为口径 C（2026-09-09，用户拍板，已落地）**：**派生产物过评审、原始资料直写**。科研 TASK.md 与六套模板、quarto-render/data-clean/figure-forge 技能种子改为：清洗数据/实验结果/渲染成品等派生产物写**本工作区**产物目录与 `output/`（不进 git），评审合并时经 `copy_untracked_deliverables` 带回主仓；文献 PDF 与人工导入属原始资料仍直写项目根 `papers/`；清单/manifest 记录产物的项目根相对路径，不记工作区绝对路径。salvage 从「已存在静默跳过」升级为同名冲突点名交人对比。编程合并 `merge_at` 补 protected_paths 检查，与科研验收合并同一口径（分支触碰保护路径即拒绝并点名）。「＋新对话」直改项目根与定时 sentinel 维持原状（用户显式动作/显式哨兵，不在 Agent 派生写入政策内）。下一步工作区从合并后的 main 重建，上一步产物在项目根按相对路径可读。未做 Mesa Dev 实机界面验收。

- **验收入口与进程退出状态解绑（2026-09-09，已落地）**：有冻结证据的 Run，审核与采纳不再要求 `completed`——失败/停止的 Run 冻结到可审成果时，目标同样提升为 `pending_review`（`review_status_for`，无可审成果保持 failed/stopped），评审弹层对非正常完成显示「部分成果已冻结」横幅。未冻结的旧 Run 维持 completed 门槛。「接受」仍是人拍板目标完成的唯一途径；Run 状态机未新增字段，Result Readiness 目前由「快照是否存在 + 是否有可审变更」表达。未做 Mesa Dev 实机界面验收。

- **回合结束即冻结 + 实机性能修正（2026-09-09，实机走查驱动，已落地）**：实机确认交互式 CLI（Codex 等）交付一轮后停在提示符不退出，「等进程死亡才待验收」永远不触发。改为：终端侦测到回合结束（attention → 已回复）调 `task_freeze_turn`——冻结当前成果（`freeze_or_refresh`：同 Run 可再冻结、seq 递增、payload.new 暂存构建成功才换入）、有可审成果即把目标从 running 提升 pending_review、并发 `goal-review-ready` 事件（App.tsx 发 OS 通知，复用长任务通知开关）；`close_at` 不再覆盖 pending_review；采纳新增 `expectSeq` 绑定，看过之后又有新版本则拒绝并要求重看。性能：基线与冻结判定从全量 sha256 改为 stat 快路径（size+mtime，git 同源口径），小文件（≤8MB）保留内容哈希兜底「保存未改」，大文件 stat-only——47 个 PDF 的项目开工 14 秒的退化不得回退。

- **Run 可以没有 Goal（2026-09-09，已落地，审计 §4.7 前半）**：随手聊（scratch）、沉浸阅读（reader）、办公文件闲聊（office_doc 自动会话）不再经 `ensure_task_at` 强制登记 tasks 行，`runs.task_id` 直接落 NULL（读取侧原本就容忍 NULL）。自动登记只保留给有归属语义的对象（科研步骤/编程车道/定时巡检，`run_needs_task`）；声明目标始终显式带 task_id。§4.7 后半「TaskCard 与工作目标共享任务身份」是 UI 命名层的产品决策，待拍板。未做 Mesa Dev 实机界面验收。

- **有效上下文快照（2026-09-09，已落地，审计 §4.8）**：普通目标与「验收后写入」开聊在 `task_prepare_run` 时把前端**实际拼装**的下发文本（Context Pack + 目标行）经 `contextText` 传入并冻结为 `review/<run>/context.json`（全文 + sha256，写入拒绝改写，读取校验哈希，写失败 = 开工失败）。评审弹层「本次工作环境」折叠区可核对这版成果基于什么材料。快照记的是实际下发的文本而非后端重建，避免双轨漂移；科研流水线以工作区 TASK.md 落盘为等价凭证，不重复冻结。经审核的知识沉淀见同日第二波 `memory.md` 最小闭环。未做 Mesa Dev 实机界面验收。

- **普通目标启动链收口（2026-09-09，审计 §4.10）**：新增 `src/goal-run.ts` 作为普通目标/「验收后写入」的单一启动链——`prepareGoalRun`（拼上下文 → 开工冻结，`packGoal`/`goalLine` 可覆盖）+ `goalRunTerminalFields`（终端请求公共字段）；ProjectUserTasksView 与 AskAiModal 双入口复用，页面只补 model/预览等自有字段。科研开步本有 pipeline-start.ts 单一出处；编程/定时入口保持各自实现，不强行合并不同形态的流程。

- **项目级技能与执行版本记录（2026-09-09，审计 §4.9 前半，已落地）**：`SkillDto.contentDigest` = 库目录清单哈希（与漂移检测同一口径，list 现算）；项目档案卡新增 `skills = [...]` 选用名单（空不写行，解析去重去空白、坏值进 warnings）；规则面板新增「项目技能」勾选区。选用技能进上下文包「项目技能」段（名称 + 版本前 8 位 + 读取/产出契约；库里没有如实标「未安装」），并随 §4.8 的 context.json 快照冻结——「本次用的是技能的哪个版本」由此可查。步骤级挂载（有流程科研）起初与本字段互补不合并；**2026-09-10 起有研究步骤的科研不再使用技能池**（见下条）。§4.9 后半（定时采纳从文献白名单扩展为技能声明的通用结果契约、科研复现验收脱离 workspace_id）未做。未做 Mesa Dev 实机界面验收。

- **有研究流程不用项目技能池（2026-09-10）**：流程已定，项目内技能合同只有步骤挂载。`projectUsesSkillPool`：科研且 `steps.length > 0` → 规则面板不展示技能池，上下文包不注入 `config.skills`。档案卡名单不自动删除（去掉流程后池子按原名单回来）。无流程科研 / 办公 / 编程仍用池 + 目标点名。技能分发仍在技能页，开步不代查。

- **有研究流程不展示「保持原样」（2026-09-10）**：`projectShowsProtectedPaths`：科研且有步骤、或编程 → 规则面板不展示；TASK.md 不再写验收写回段；上下文包不注入 `protected_paths`。档案卡不自动删除。合并 / 定时采纳后端仍认。无流程科研 / 办公仍是目标验收写回的合同。

- **主仓未存入历史就地保存（2026-09-10）**：科研步骤卡点「N 处改动未存入历史」展开文件名单，「存进历史」走现有 `git_commit`（不推送）；「打开改动」才去运行页改动面板。冲突/合并中禁用一键保存。不自动提交。纯逻辑 `src/main-history-save.ts`。

- **稳定 ProjectId（2026-09-09，审计 §4.6 首期，已落地）**：项目身份 = 档案卡顶层 `id`（uuid），**跟随文件夹**（移动/备份/换机都在）；`projects.path` 降为当前位置。注册时分配（无则补写档案卡 `id` 行）；同一 id 出现在新路径 = 目录被移动，注册行改写路径、保留 created_at 与项目默认配置，不建新行；`write_config_at` 保证配置写出的卡片必带 id（目录不存在的纯拼装调用跳过）；列表读到档案卡 id 时回填注册表旧行（纯 DB 写，list 不做文件副作用）。**引用迁移留后续**：tasks/runs/workspaces/coding_lanes/session_meta 仍按路径关联——审计明确「逐步迁移，不重写全部存储」；移动目录后这些历史关联仍指旧路径（会话归属/目标列表按路径查询），身份已认回、关联迁移是下一期。未做 Mesa Dev 实机界面验收。

- **审计收口第二波（2026-09-09，用户拍板「按推荐执行」，已落地）**：① TaskCard 与工作目标解绑命名——用户可见文案统一为「话题」（对话分组），数据不动。② 目标删除即归档——`task_delete` 改置 `archived_at`（Run/事件/隔离目录/评审证据/账本全保留），列表过滤归档项；恢复入口见同日后续决策「归档案面与验收账本可见」。③ Memory Proposal 最小闭环——`.ccode/memory.md` 只进人确认的内容（验收弹层勾选「沉淀进项目长期知识」才把意见写入，带时间与出处目标），上下文包注入「项目长期知识」段（1500 字截断），Agent 自称的结论不进。④ §4.9 后半——定时巡检采纳从固定四类台账扩展为「四类基线 + 技能 frontmatter 声明的产出契约」（`watch_adopt_patterns_for`，目录模式展开限 200 个文本文件/2MB，契约外路径采纳即拒，旧快照兼容）。⑤ §4.6 二期地基——tasks/runs 双写 `project_id` 并按路径回填旧行（`backfill_project_ids`）；读取侧仍按路径，引用全量迁移留下一期。注意：runs 的 task_id 旧回填同步收窄为有归属语义的 kind（§4.7 的 NULL 设计不被回填抵消）。未做 Mesa Dev 实机界面验收。

- **系统审计收口（2026-09-08）**：Vite 显式 TS 配置，生产 CSP 与清洗双层防护；profiles/settings、schedules 和 global-config 读改写分别用 OS 文件锁，私有临时文件创建即 0600、失败不先删原件，拆层迁移 pending 日志可重放并最后提交；损坏配置保留拒写。终端输入独立有界串行队列、诊断输出异步批量有界落盘，运行恢复不得丢失 discuss 权限。无头取消、Windows 挂起加入 Job 后启动和原生退出回收形成同一生命周期，外部应用启动器例外。日志出站统一脱敏、网络响应按实际解压量限额。保留两套 worktree、混合存储和页面保活，不因审计推倒重构；实机验证限制列入 `docs/audit-remediation.md`。

- **网关与绑定入口一致（2026-09-08）**：设为全局对 Mesa 管理字段做完整替换（模型槽变短、思考档清空、空名单都要删旧值）。绑定更新只改绑定字段，不回写共享网关 URL/Header/密钥；跨窗口保存用内容指纹拒绝覆盖。导入按绑定身份规则还原多条模型配置，不按 Agent+网关静默合并。体检按槽+模型+地址/密钥指纹消费，思考档与采样分开发、分字段记录；迟到回包对不上当前指纹则丢弃。获取目录合并策略不覆盖未保存值。未做九家联网验收与 Mesa Dev 窗口点选。

- **网关库先测后存（2026-09-11）**：填完地址和密钥即可测试、获取模型，测的是当前表单，不必先保存。草稿探测与拉目录不写密钥、不把未保存地址记进 lastProbe；地址与已存槽一致且未提交新密钥时仍落体检。通过后再由人点保存。编辑区默认收起协议槽/Header/Agent 配置/模型策略，同址只填 Base URL。已有网关更新目录走 `fetch_gateway_catalog`（列表行 / 添加连接选用已有 / 连接行 ⋯），现拉并写入网关，不改绑定勾选。`/models` 无 OpenRouter 风格能力字段时据实提示去公共能力库，计数与是否已有 gateway id 无关。未做 Mesa Dev 窗口点选。

- **默认与应用分口（2026-09-09）**：保存网关、添加 Agent 配置、Mesa 启动默认、项目默认、写入 CLI 全局默认、注册到客户端语义分开。写入 CLI 全局前给出脱敏字段预览（增删改、此入口带不上的策略、已开进程需新开）。未做 Mesa Dev 窗口点选。

- **科研决定、复现执行与验收记录对应（2026-09-08）**：开工门禁认决定状态（批准／仅准备／待补／不批准），旧纯文本不自动批准；批准绑定当时报告指纹，指纹变了要重确认。带约定的 Python 复现入口由后端实际执行，输出在 `~/ccode/reproductions/`，界面只读本次运行的输出清单。科研验收决定与 Git 合并分开记录。桌面窗口端到端与真人小项目仍未验收。UI 与数据契约见 pipeline.md「科研摘要前端闭环」。

- **检索步评审主面是纳入表（2026-09-17）**：文献检索/筛选不套实验验收骨架，也不把 `included.json` 的 Git diff 当第一眼。人先看纳入/待确认/待获取与待拍板，再记下筛选决定；JSON/脚本归过程组。Git 拦截直接写原因。合并不等于接受清单。细则见 pipeline.md 科研摘要前端闭环。
- **检索评审待确认优先（2026-09-18）**：表默认先出 pending；筛选决定贴在「要你决定」之下；`included.md`/`included.json` 不与纳入表并列摊 diff。
- **评审按步骤类型拼区块（2026-09-18）**：一张 `WorkspaceReviewView`，闭集档案 screening / acceptance / default（`step-review.ts`）。禁止每步一张独立评审页。
- **科研保存链白话（2026-09-18）**：评审按钮与时间线用「保存进项目」，不在单页单点换词；编程「合进基准」不动。文案单一出处 `review-save-copy.ts`。

- **科研流程减负（2026-09-08）**：共用底线只在步骤合同生成一次，原报告开头提供验收摘要；人看带证据/代价的决策摘要后选择，不凭空填批准。决策问题文本是已有草稿键，减重不重命名。格式适配与 G5 终审分工，复用仍有效检查；默认计算模板交付实际运行过的项目复现入口，文献保持来源/论断复核。两个小试跑分别用真实公开全文与合成数据，故障检查不被宣传为真人/多 Agent 验证；现有预览足以承载当前摘要，暂不新建复杂面板，结论与界限见 research-workflow-pilot.md。

- **研究开工合同失败即停（2026-09-08）**：任务书写入失败不能继续自动启动 Agent；保留工作区和原始错误供恢复，修复/核对合同后才能继续。不要把早期后端兼容 best-effort 作为绕过人工决定与质量约束的理由。

- **科研质量不是文件完成（2026-09-07）**：保留六套模板及阶段数，在模板/技能中落实 G1 问题、G2 设计权限、G3 数据实现、G4 证据结论、G5 投稿归档；报告区分待审/有条件接受/证据通过/阻塞，人决定核心问题、口径、结论和授权。未知允许阻塞，不能靠占位或默认继续掩盖。空选项 decisions 是需人填写依据，编辑器/后端必须保留且不推荐代答；复用 hard_pause 而非建科研专用状态机。通用 same-ids 只检查计划/交付集合，用于产物待审，非合并禁令/科学保证；评审「可信度」更名「基础检查」。已有项目和本机技能不静默覆盖。详细契约、迁移与适用范围见 pipeline.md「科研质量契约」。

- **后台生命周期与定时证据（2026-09-07）**：普通捕获命令共享 stdout/stderr 有界捕获和总 deadline，父退出不等于输出完成；Unix 捕获命令独立进程组、退出/超时同步收尾有界，PTY 后置登记失败回收进程。无头凭证及 Run 登记 fail-closed。定时工作目录继续复用，不再作为历史产物真源：`watch_review.rs` 冻结四类可采纳台账，UI 默认展示冻结文本，采纳先核对两份起始基线/保护路径，再备份替换，失败尝试回滚。日程执行与 Run 存活采用 OS 文件锁保护同版本多实例；配置 JSON 事务、Windows 脱离子进程与跨文件崩溃恢复仍是独立未完成边界，禁止以此批修改宣称全部解决。

- **项目规则按流程/工作方式分（2026-09-07）**：有研究流程用该模板自己的纪律（`projectRules`），不把六套模板的空全局设定写进每一份 TASK.md。没填的「问题：（选项）」不是规则。无流程科研/办公/编程只用工作方式默认条，不套综述纪律。

- **文档内容信任与版本保存（2026-09-07）**：本地文档和 Agent 产物不因文件位置而成为可信 HTML；各预览在图片字符串重写后统一经 DOMPurify 文档白名单，再交给 DOM/受控图片水合/KaTeX。保留正常表格、图片、脚注、公式和任务复选框，不执行脚本、事件、页面嵌入或文档样式。文本读取返回可写完整内容的 SHA-256 版本，保存必须携带基线版本；外部变化、截断、编码不支持时拒绝覆盖，保存期间继续编辑保持 dirty。根外 symlink 沿用只读预览，`../` 绕根拒绝。细则见 safety.md 与 terminal.md；不将乐观检查描述为跨进程强锁。

- **设置页首次进入不切主题读色（2026-09-07）**：主题色卡预览色从 `App.css` 源文本抽 rail/canvas/cta/l1（`src/theme-swatch.ts`），禁止临时改 `documentElement.dataset.theme` 再 `getComputedStyle`。字体状态跟外观分区一起拉；定价、hooks 清单、连接列表、应用版本等到对应分区才请求。

- **确认框与自动路径诚实性（2026-09-06）**：应用内确认框默认焦点在确认钮；Enter 激活当前焦点按钮，焦点在「取消」时不得确认。Custom Runtime 不是隔离工作树任务：只有 `pipeline_step` / `coding_lane` / `watch` 的写盘才要求离开主仓。快速开聊直达必须是记住的那条配置本身。网关目录按槽刷新，一个槽的获取不得把其它槽模型一律标成历史失效。交互写入（含 PDF/笔记问 AI）失败必须可见。

- **统计页花费洞察（2026-08-30）**：用量页在概览卡下回答「花得快不快 / 钱花在哪几次 / 缓存省了多少」。环比与命中率纯逻辑在 `src/stats-insight.ts`（本周=近 7 天、上周=前 7 天、无上周数据不出徽章；所选范围盖不住上周时也不出）。后端 `usage_trend` / `top_sessions` 走现有定价链；官方账号与 internal 活动不进花费折线和最贵榜；会话自定义标题出站前过 `redact_sensitive_text`。折线与最贵榜均跟随页顶范围。

- **界面注意力收口（2026-08-30）**：每屏一个主 CTA、全局待办单入口（顶栏圆点，文献雷达留在项目页）、项目身份行只留名称+课题（全局设定芯片进抽屉）、运行页默认只留会话画布（文件树/成果面板按需滑出并记忆）、连接页空组默认折叠且「+ 添加连接」只留页头、选用已有网关从目录勾选模型不得整表预填。步骤面板 R1–R7 不动：「开始」仍是唯一实心主路径，TASK.md 预览降为 ghost。规格见 `docs/conventions/design-system.md`。

- **网关库体验批次（2026-08-30）**：网关库补齐按槽测速摘要、求交三态（绑了该网关的 Agent 通道并集）、顺序拉取模型目录、配置漂移子集比对（只对 Ccode 写入的键）、用量按网关归因（session_meta.profile_id ⋈ binding.gateway_id，未关联/官方订阅/已删网关三桶如实呈现）、导出 v2。不引入本地代理。规格见 `docs/conventions/profiles.md`。

- **网关 + 绑定拆层（2026-08-30，已落地）**：配置模型层从「一条 Profile 粘住 Agent+端点+密钥+模型+策略」拆成网关（密钥+协议分槽+逐模型策略+Header）与绑定（某 Agent 选用的网关与模型名单）。产品承诺是按 Agent×启动模型×网关槽×体检诚实呈现，不走本地代理、不解析 TUI `/model`。托盘只写「设为全局」、不改注入默认。规格见 `docs/conventions/profiles.md`。

- **Windows 安装渠道补 winget + .cmd shim 深化（2026-08-27）**：Windows 无 Node.js 的机器上 codex 等曾无任何可用安装渠道（brew 仅 macOS、官方脚本渠道不支持 Windows），表现为「无法安装」。决策：① PackagingSpec 新增 `winget` 包 ID 字段（已实机核实并登记五家官方包：Anthropic.ClaudeCode / OpenAI.Codex / SST.opencode / MoonshotAI.KimiCodeCLI / xAI.GrokBuild，均 portable 免管理员；gemini/qwen/codebuddy 无官方包、cursor 官方脚本拒装 Windows，这四家维持 npm/脚本渠道）；安装候选顺序 brew > npm > winget（仅 Windows）> uv > 官方脚本；winget 安装走 `winget install --id <id> -e --source winget --accept-* --disable-interactivity`，更新同 ID `winget upgrade`，检测口径为二进制路径含 `WinGet`（Links shim 与 canonicalize 后 Packages 实体同判），最新版查 `winget show` 本地化输出（找「版本:/Version:」标签行取 x.y.z，解析失败回落普通「更新」按钮不虚构）；winget 的 Links/WindowsApps 两目录进 `binary_candidate_dirs`（装完不用重启即可检测到）。② Windows 上 npm 系 CLI 是 .cmd 批处理 shim，ConPTY/CreateProcess 不能直接执行：`process::pty_command` 统一把 shim 深化为 node 直启（cmd-shim 两代文本格式解析 %~dp0/%dp0% 入口；npm.cmd 自身是安装器变量化脚本，走固定布局 node_modules/npm/bin/npm-cli.js special case），解析失败才回落 `cmd /c call`——参数不过 cmd 解析，含引号/%/& 的 prompt 不被吞；`background_command` 同口径深化（--version 探测也走它）。③ 两个实机新坑一并修复并记入 AGENTS.md 环境档案：候选目录同名 shell 脚本抢在 .cmd 前命中（os error 193，find_in_dirs 改扩展名优先）；ConPTY 里 npm 发 DSR 光标查询（ESC[6n）读 stdin 等回答、无人应答永久挂起（run_streaming_pty reader 代答）。updater 安装更新与终端 agent 拉起共用此入口。

- **运行页显示层切换符号化（2026-08-22）**：聊天/终端切换属于高频但窄空间操作，使用 28×28px 符号按钮并保留 tooltip/aria-label；不改变每个标签独立保存的 surface mode 与 PTY/会话联动。

- **终端聊天头部宽度（2026-08-22）**：聊天标题与低频操作不占满终端主区，使用较窄阅读宽度并避免无意义的 `flex-1` 横向拉伸；操作可用性与会话状态机不变。

- **表单原生控件主题化（2026-08-22）**：连接表单中的复选框必须使用主题 CTA accent；紧凑表单里的短动作按钮需设置固定最小宽度与 `white-space: nowrap`，防止窄视口文字折行。

- **连接弹层尺寸与按钮层级（2026-08-22）**：添加连接仅作为表单弹层，不使用接近整页的宽度；默认最大宽度约 500px。测试、获取模型、添加属于次级动作，保存是唯一主 CTA，均复用共享按钮令牌，避免旧 `bg-btn` 造成主题色不一致。

- **命令面板尺寸约束（2026-08-22）**：命令面板是快速选择器而非页面容器，宽度按视口响应式收敛，最大约 520px、内容区约 400px 高；搜索焦点不叠加额外黑色边框，命令标题保持左对齐。命令过滤与执行语义不变。

- **连接配置与命令面板的信息层级（2026-08-22）**：连接表单按配置决策顺序分段展示，预设不再与身份字段混成无标题控件；命令面板按快速操作、页面、外观分组，并保留原有过滤与执行顺序。该决策只改变 UI 信息架构，不改变 ProfileStore 保存、密钥处理、模型探测或页面命令路由。

- **工作台与运行外壳视觉收敛（2026-08-22）**：工作台只保留当前工作主卡、待处理和活动流，删除重复的底部运行入口；最近项目仅作为恢复线索，不冒充当前项目上下文。聊天头部、消息区和 composer 统一限宽、降低附属信息密度；运行页工作树固定 224px、标签/成果面板/状态栏采用紧凑高度。该决策只改变表现层，PTY 生命周期、会话同步、技能/MCP 插入与文件/改动状态机不变。

- **运行页上下文与显示层（2026-08-22）**：项目/工作区导航与文件树浏览分离；浏览根不改变终端 cwd，运行中切换项目改为新标签打开；聊天/终端显示层按标签隔离；布局相关入口统一收进「布局」菜单。

- **模型请求策略的安全边界（2026-08-27）**：Profile 可以保存 `temperature`、`top_p`、`max_output_tokens`、`reasoning_effort` 与「Header 名→环境变量名」引用，作为跨 Agent 的可迁移声明；保存时做格式/范围校验，并按 Agent 能力表提示支持、未知或不支持。当前启动器只负责环境变量/命令行注入，不伪造 HTTP 请求体，也不把 Header 密文写入 Profile。后续若实现真实请求注入，必须新增按 Agent + 协议逐字段适配，并保留启动计划预览与验证提示。

- **模型配置能力保持与 fail-closed（2026-09-05）**：Claude Code 启动用 `--settings` 覆盖本次连接的非敏感模型选择，不再写 `CLAUDE_CODE_SUBAGENT_MODEL`，以保留 Task 参数/frontmatter/主模型继承链；CodeBuddy 2.137.x 的 effort 走 `--effort`；Grok 1.0.x 的模型和思考档走 `-m`/`--reasoning-effort`。Anthropic 槽拒绝完整 `/messages` 地址；Grok 的非 `chat_completions` `api_backend` 若未在 `[model.<id>]` 或网关目录中确认，启动和无头调用均拒绝，不静默回退。Codex 启动按选中模型覆盖上下文与 95% 自动压缩阈值；模型能力查询必须带网关 ID。

| 版本 | 决策 |
|---|---|
| v0.1 | 技术栈 Tauri + React；MVP = 配置中心 + 启动 + 历史浏览；数据源 = 解析本地会话文件；双模式切换；内嵌终端；六 agent 全进 MVP；AI 主导编码 |
| v0.2 | 命名 **Ccode**；项目列表 = 从各 agent 历史自动聚合 + 分类（§6.5）；终端 ↔ 结构化对话联动（§6.6）；token/费用统计保持 P3；三平台同步分发，CI 矩阵 P1 接入 |
| v0.3 | 密钥存储弃用系统钥匙串，改 0600 `keys.json`（macOS 钥匙串 ACL 与未签名开发构建冲突导致密钥丢失）；借鉴 CC Switch 落地：原子写入（tmp+rename）、内置端点预设（只收官方/公开端点）、profile 导入导出（不含密钥）；Claude 多模型经 `ANTHROPIC_DEFAULT_*_MODEL` 别名槽注册进 `/model` 选择器（最多 5 槽） |
| v0.4 | 借鉴 Wave Terminal 细化会话设计（§6.5）：pin 即保留（快照拷贝到自家目录，对抗 CLI 自动清除/格式迁移）；整理数据（pinned/tags/custom_title）存 app.db 不碰源文件；分类 = 项目聚合 + tags + 状态三维度；全局搜索作为差异化做透。明确不借鉴：序列化终端缓冲区快照（与解析路线重复）、AI 会话内存存储（不可靠） |
| v0.5 | 参考实现扩展为三个（+ VS Code，长期有效）；新增 §6.9 工作区设计：工作树（懒加载+只读预览）+ 运行中总览面板 + 终端页三带布局；多模型切换按各 CLI 机制实现（claude 别名槽 / codex model_catalog_json / qwen modelProviders / kimi [models.*] / opencode provider.models / gemini 手输）；会话删除为用户显式指令的只读原则例外 |
| v0.6 | 全站暖黑主题（Conductor 风，令牌集中 `src/App.css` @theme，禁蓝色系，用户否决浅色+渐变方案（浅色否决已于 v3.44 作废））；安装/更新命令必须 PTY 执行（管道块缓冲坑）；brew 走 TUNA 镜像；**全量采纳 Conductor 工作区编排**（§6.10）：任务工作区 = git worktree + 分支，分 A/B/C 三阶段实施（W1/W2/W3）；明确不做云工作区/多人协作/应用内 GitHub 登录；重大改变沉淀规则到 AGENTS.md + 本节（用户指令） |
| v0.7 | P3 设计定稿（§6.11）：侧栏扩为五页（+统计）；OpenCode 直读 SQLite（WAL 只读 + 防御式）；用量按天聚合入 app.db、内置定价表可覆盖、中转不明价只显 token；注意力标记 v1 走零侵入启发式（会话尾态+输出速率），Claude Code hooks 精确化留 v2 单独评估（需写用户配置）；功能增改必须同步 `docs/user-guide.md` |
| v0.8 | 跨模块闭环 A-E 实施（§6.12）：会话一键恢复（pty_spawn resumeSessionId）、进行中标记 + 反向跳转、工作区记住配置、工作区→会话筛选、profile 上次使用；**主题二次定稿为沉浸冷黑**（四层浮起结构，保留绿 CTA，暖棕色系被用户否决）；配置页按用户详版规格重构（折叠分组 + 五列网格 + 筛选搜索）；图标按钮点击区 ≥28px |
| v0.9 | 新增技能管理模块（§6.13）：SSOT 技能库 + 六 CLI 分发（Auto symlink/copy），四路导入（本地/ZIP/GitHub 仓库/应用目录发现），ZIP 导出，卸载备份；采纳 Agent Skills 开放标准（SKILL.md 防御式解析）；更新检测与在线编辑留 v2；git 推送改走 SSH:443 通道 + repo deploy key（HTTPS 网络不稳） |
| v1.0 | P3/P4 完成后迭代：费用统一官方价口径（27 项定价、供应商前缀剥离、部分估算标 ≥）+ $/¥ 一键换算；**工作树逻辑统一**（当前项目锚点=tab cwd、最近项目真进入、操作边界=树当前根、运行中默认折叠、搜索范围明示）；文件操作加重要路径删除保护（系统目录/关键用户目录/CLI 配置/.git）；预览按扩展名语法高亮；安全原则重申：删除保护只覆盖 UI 操作，agent 权限依赖各 CLI 自身机制 |
| v1.1 | 设置页 + 主题系统：七套深色主题（实测色板融合，各带独立强调色，[data-theme] CSS 变量运行时切换；删除暖夜/墨绿/深紫）；「活跃」「可合并」pill 用 cta-pill 同步强调色，其余状态保持语义色（干净优先）；**AI headless 层**（ai.rs，复用 launch_plan 注入，六 CLI print 模式，profile 按 last_used_at 解析）；profile 用量按模型近似归属（悬浮卡展示）；侧栏可折叠为图标栏；符号语言统一（◈=AI、⚑=pin，禁彩色 emoji）；WKWebView 不支持 window.prompt——输入一律内联 |
| v1.2 | 终端会话回路补全：shell 回落提示语义化（「会话已保存，可一键恢复」）；收缩状态行加「⟳恢复」（resumeSessionId 直接续聊）与「⤴对话」（跳会话页打开回放做整理）；确立「进程一次性、会话永久」的展示语义；终端字形回调清瘦（400/600、行高 1.2、零字距，向 Ghostty 锐利度靠） |
| v1.3 | v0.1.0 发版：性能一轮（终端页 memo 化、SessionLink 轮询文件签名门控、页签保持挂载消切换迟滞、工作树收缩 xterm 重 fit）；终端字体打包 JetBrains Mono woff2 + 设置页字体/调色板可配；**安全**：删除保护 canonicalize 双校验（堵符号链接绕过）、codex 默认沙箱（交互 workspace-write / AI 无头 read-only）；应用图标全套（emerald-mint）；**CI 发布流水线**：tag/手动 dispatch → 三平台 cargo test → tauri build → Release 草稿（workflow 配 contents:write；CI 测试禁墙钟时序断言、unix 语义门控、路径断言 Path 比较）；**macOS 签名公证暂缓**（用户拍板，未签名包首开需右键打开；后续办 Apple Developer 会员后在 CI 配 6 个 APPLE_* secrets 即可补） |
| v1.4 | 设置页「AI 专用配置」：◈ 三功能（提交信息/摘要/PR）profile 解析顺序改为 显式 id > 设置专用 > 最近使用（settings.ai_profile_id，空串清空回自动；专用被删明确报错不静默回落）；动因：自动落大模型导致生成慢，小任务应走快模型。**工作区起点改为本地基准分支**（create/base_ref/git_info 三处，原从 origin/<base> 拉导致用户未推送提交不进工作区；工作区语义 = 本地项目现状） |
| v1.5 | CLI 二进制解析加 GUI 短 PATH 兜底：`agents::resolve_binary` 统一入口（先 which 继承 PATH，miss 查平台候选目录——macOS `/opt/homebrew/bin`·`/usr/local/bin`·`~/.npm-global/bin` 等，Linux `~/.local/bin`，Windows `%LOCALAPPDATA%\Programs`·`%APPDATA%\npm`）；detect/终端启动/AI 无头/更新安装（含 brew/npm 工具检测与 PTY spawn）/gh PR 全部改走它 |
| v1.6 | 优化一批：list_repos 60s 进程内缓存（create 后失效）；**前端分包**（页面 React.lazy + visited 保挂载语义、Monaco/xterm vendor chunk，首屏 4.7MB→224KB，monaco 3.9MB 固有体积按需加载）；终端 Cmd+F 搜索（SearchAddon，按活跃标签隔离）；会话导出 Markdown（~/Downloads/ccode-exports/）；诊断日志面板（logbuf 环形 500 条 + 前端 onerror/unhandledrejection 上报 + 设置页分区）；**Tauri updater**（plugin-updater + minisign 密钥，私钥 ~/.tauri/ccode-updater.key 不进 git，CI 配 TAURI_SIGNING_* secrets，设置页「更新」分区手动/自动检查） |
| v1.7 | 评审闭环与预览/用色规范：评审面板（任务 diff + 逐文件彩色 diff + 冲突区——并入主分支、两侧内容预览、逐文件/一键选边、◈ AI 选侧建议 `ai_conflict_advice`，AI 只建议不执行）；合并拆分「合并（保留工作区，落 `merged_at` 列显示已合并 pill）/ 合并并归档」，`ws-archived` 广播让滞留终端自动 cd 回主仓库；合并健康检查前置主仓库状态（main_dirty/main_off_base）；**预览编辑器 = 稳定文档**（禁「预览跟随」——同名文件跨仓库静默切换曾致误改主仓库，教训入 AGENTS.md），主仓库文件保存警示色 + 二次确认，外部改写自动刷新；真实 cwd 跟踪（`pty_get_cwd`：macOS lsof / Linux /proc）；专注模式重构（标签与 ⋯ 动作菜单 portal 到 App 侧栏插槽，navCollapsed 入 store）；用色规范：强调色只给可操作状态、纯状态 pill 灰底 + 语义色小圆点、结果横幅灰底 + ✓/✗ 文字；会话 ⇗ 外部恢复 / ⧉ 复制恢复命令不带 profile env（密钥不进剪贴板/外部 shell）；kimi 检测补 `~/.kimi-code/bin` 候选目录 |
| v1.8 | 外部拉起与更新渠道修正：⇗ 外部恢复命令改用**二进制绝对路径** + shell `-l -i` 交互登录（非交互 `zsh -l -c` 不加载 `.zshrc`，官方安装器目录如 `~/.kimi-code/bin` 只写在交互 rc——Ghostty failed to launch 的根因）；**候选目录用户目录优先于系统目录**（`~/.local/bin` > `/opt/homebrew/bin`，与用户交互终端 PATH 解析一致，防止检测到同名旧副本）；**npm 更新用与目标二进制同目录的 npm（`updater::npm_for`）**（同机多份 node/npm 装错 prefix）；brew 安装的 opencode 走 `brew upgrade`（自更新 TUI 交互无法行输入应答）；kimi-k3 定价按官方 ¥20/¥100 修正（缓存命中一折口径与 cost_of 0.1 系数一致） |
| v1.9 | 工作台界面收敛：配置/工作区/技能/统计/设置统一页面框架、标题与主操作层级；终端展开态固定“agent → profile → 模型 → 目录 → 启动”主流程，辅助动作独立，启动后收缩和标签常驻语义不变；会话树响应式压缩、列表明确当前/搜索/总量，运行态改语义色点；统计默认归并 `ccode-ai-*`、临时目录与 `<synthetic>` 内部记录，提供本机记忆的“显示内部活动”。**会话敏感信息边界**：已保存密钥与常见密钥前缀必须在 Rust 层统一脱敏后，才允许进入列表 DTO、结构化回放、AI 摘要响应或 Markdown 导出；六 CLI 会话源文件仍保持只读。 |
| v2.0 | 工作区创作闭环收敛：新增终端全宽任务审阅覆盖层，工作区「评审」（无冲突）与终端「改动 → 审阅」共用；按文件树定位并连续懒加载双栏 diff，在同屏完成 AI 提交信息、提交与本地合并。默认「提交并合并」保留工作区且不推送，次级动作保留「仅提交 / 合并并归档」；操作前后都复用 `workspace_health`，提交后重新检查再合并。终端标签/PTY 在覆盖层下保持挂载；原改动面板「提交 / 提交并推送」及工作区「合并 / PR / 归档 / 会话」不删。有冲突时复用工作区既有逐文件选边与 AI 建议，不建立冲突处理分叉。 |
| v2.1 | 文件树与预览同步规则调整：切换项目、工作区、终端标签 cwd 或手动树根时清空旧预览，不自动映射新根下的同相对路径文件；若预览有未保存改动则确认，取消同时阻止树根切换。保留当前根内稳定文档与外部改写刷新语义，兼顾切换反馈和跨工作区误编辑防护。 |
| v2.2 | 工作区合并状态与冲突闭环：保留工作区合并后，`merged_at && ahead == 0` 时行内合并按钮显示禁用的「已合并」，新提交令 `ahead > 0` 后恢复普通合并动作。冲突入口使用「开始解决冲突」而非暴露“把 main 并入工作区”；底层仍在隔离工作树内同步和选边，默认完成动作串联 `workspace_finish_merge → workspace_health → merge_workspace(archive=false)`，把 Git 必需的解决提交隐藏为内部步骤；保留「仅保存解决结果」。若解决提交成功而最终合并失败，明确报告部分成功并刷新为普通可恢复状态，禁止自动重建 merge commit。 |
| v2.3 | 改动面板提交摩擦收敛：保留手写提交信息与独立 ◈ 生成入口；消息为空时，按钮变为「快速提交 / 快速提交并推送」，前端根据单文件状态（添加/更新/删除/重命名）或多文件数量同步生成中性默认信息后直接调用 `git_commit`，不额外启动 AI。Git 阶段失败回填默认信息供重试；成功 toast 展示实际提交标题。终端与会话页复用同一 `GitPanel`，行为一致。 |
| v2.4 | 开发预览与正式应用隔离：新增 `npm run tauri:dev`，合并 `tauri.dev.conf.json` 后以 **Ccode Dev** / `com.ccode.dev.hmr` /「Ccode Dev - 热更新」启动 Vite HMR 窗口。正式版、打包调试版和热更新开发版不再依赖同一个应用名定位；自动化验收禁止模糊匹配 `Ccode`，必须使用开发窗口标题或产物绝对路径。 |
| v2.5 | P0 数据安全闭环：归档改为无损语义——merge 中、脏工作树、agent/run 脚本运行中均拒绝，脏工作区提供「提交并归档」，非删除流程禁用 `worktree remove --force`；最终本地 merge 失败自动 `merge --abort` 保持主仓干净。commit/push、merge/archive、push/PR 改为结构化分阶段结果，后阶段失败只重试该阶段。全局 CLI 配置升级为 agent 级事务批次：完整备份清单、全部临时文件预写与同步、失败整批回滚；恢复前备份当前状态且不消耗原恢复点。 |
| v2.6 | 冲突审阅视觉闭环：工作区「解决冲突」与普通「评审」统一进入终端全宽覆盖层，删除原工作区行内冲突面板及跨页面回跳状态。新增只读 `workspace_conflict_content`，从 Git index stage 2/3 读取任务分支/基准分支原始内容并生成全文件双栏 diff；冲突文件连续浏览、右栏定位、逐文件/全部选边、◈ AI 建议、完成解决并合并均在同屏完成。底层继续只在隔离 worktree 执行 `workspace_sync_base → workspace_resolve_file → workspace_finish_merge`，不改主仓库冲突处理边界。 |
| v2.7 | 评审工作台视觉重构：保持 v2.6 的 Git 与冲突状态机不变，将完成动作固定到顶部，第二工具行承载分支统计、提交信息、批量选边和 AI 建议；右侧收敛为可搜索文件树与进度。主区继续多文件连续双栏审阅，新增文件标题吸顶、长段未修改内容折叠、滚动与右树选中同步。冲突选边改为每个文件标题下的紧凑双侧控件，AI 理由单行呈现并要求用户显式执行。 |
| v2.8 | 冲突基准一致性：工作区「解决冲突」在工作树干净时自动执行 `workspace_sync_base`，同步完成前不展示普通 merge-base diff，避免把累计任务 diff 误认成当前 main。`UnmergedDto.stale_base` 比较 `MERGE_HEAD` 与当前基准分支 tip；基准在冲突处理中前进时，冲突内容读取、选边和完成提交全部拒绝，UI 隐藏旧对照并要求用户确认后执行 `merge --abort → merge <latest-base>`。回归测试覆盖旧 main 冲突生成后 main 再推进、重启冲突后 stage 3 等于最新 main。 |
| v2.9 | P1/P2 可靠性闭环：工作区创建引入 `creating` 状态、SQLite 原子端口预留与 worktree/分支/DB 补偿回滚，空分支要求 `ahead>0` 才可合并，并提供 DB↔Git 状态漂移诊断与显式非破坏修复；Profile 增加本地解析、CLI 预检、最小 API 三层验证，全局写入后自动复检；普通仓库提交支持安全 pathspec 勾选，工作区仍全量提交；技能同名导入结构化冲突、覆盖备份/另存为与 GitHub revision 更新检测。终端重启仅恢复白名单元数据占位，不恢复 PTY 或敏感运行态；usage 内部活动改为后端启动前登记的精确 provenance，事件和项目/模型 DTO 显式携带 `source/internal`，彻底移除 `/tmp`、目录名和模型名启发式。 |
| v3.0 | 统计长会话与本地日期修复：usage 索引从“整文件读入 + 超过 10 MB 跳过”改为普通 JSONL / zstd 逐行流式解析，活跃的超长 Codex/Kimi 会话不再导致今日统计为空；事件日期和今日/近 7 天/近 30 天截止日统一按本机时区计算。索引 schema 升级为 v3，首次加载自动清空旧日桶并从只读会话源重建。 |
| v3.1 | 对话与改动信息架构收敛：终端右栏统一称“对话”，只轮询最近 50 条，增加会话头部、精确完整回放和仅近底部跟随滚动；无固定 ID 的 CLI 改为启动前 claim、同项目并发排他分配，所有运行态与跳转使用 agent+sessionId 复合键。会话页长回放改为有界尾窗 + 向前分页，标题拒绝占位值并回落首条真实用户消息；内部 AI 会话按后端 provenance 归并，归档开关统一左栏计数。Git 改动文件支持安全展开单文件 diff；会话页仅只读展示“当前项目改动”，明确不是历史快照，提交/推送回到终端处理。 |
| v3.2 | 终端信息密度与首开稳定性：最近项目由后端按仓库最大会话 updated_at 聚合排序，前端启动预取并缓存上次成功结果，终端最多显示 4 个且排除当前项目，无缓存时用固定骨架避免异步弹出造成布局跳动。紧凑单文件 diff 取消整行绿/红背景，只保留语义色文字、细边和 hunk 轻底色。右侧对话/预览/改动采用可拖拽且记忆宽度的分栏，并提供“隐藏工作树但保留终端”的宽屏展开/还原；不新增与任务审阅冲突的普通内容全屏路由。 |
| v3.3 | 全站信息层级收敛：管理列表行只保留识别、状态与主路径，低频操作统一进「⋯」；工作区 PR/归档收口到唯一全宽评审内确认，进行中的 merge 冲突保留直接「解决冲突」入口但不新增第二套界面。终端/App 布局固定 `h-full/min-h-0` 与局部滚动边界，避免窗口缩放、拖动或长内容后出现底部黑屏/空白。 |
| v3.4 | **定位转向（2026-08 定稿，§11）**：从「通用 Agent 控制台」演进为 **AI 科研工作台**（底层六 CLI 统一控制台 + 表面科研流水线；AI 干活、Ccode 管活、人拍板）。理由：harness（启动/配置/监控外壳）随 CLI 厂商自带工具成熟而贬值，验收层（人工评审才合并）反而升值；科研流水线是控制台能力的深水用法，能把工作区/评审/技能/统计串成完整链路。同步定稿三条纪律（科研语义进模板不进逻辑 / 验收层是护城河 / 跨厂商中立 API+官方账号双轨）、量化目标（开步 ≤3 次点击、产物传递 0 次手动复制路径）与五个核心机制（project.toml 档案卡 / Pipeline 模板 / 一键开步 / 接力包 / artifacts.yaml 提货单），新阶段 P0–P5 见 §11.4 |
| v3.5 | 否决 AI 自动拆任务 / Agent 编排引擎：等于自造 meta-agent，复杂度与责任边界失控，与「人负责拍板」定位冲突；流水线步骤由模板预设 + 人工开步驱动 |
| v3.6 | 否决 MCP 协议接入 / 自建协议：Ccode 无 tool-call 循环，接入 MCP 属概念错位；**MCP 配置分发 ≠ 接入**，分发仅列 backlog 调研项 |
| v3.7 | 否决智能路由引擎（按任务自动选 agent/模型）：只做使用数据展示（统计页），不替用户做路由决策，避免黑盒归因与厂商中立性争议 |
| v3.8 | 否决 Docker/VM 沙箱、daemon 化、手机同步：均属贬值层，投入大、与桌面控制台形态不符，安全边界依赖各 CLI 自身机制（codex 沙箱等）即可 |
| v3.9 | 否决 Zotero 式文献库 / 数据表格查看器：别人的战场；文献与数据只做流水线产物（笔记/bib/提货单），不做专业管理工具；此决策仍有效：内核 `zotero_import` 只读 sqlite 快照写项目，个人库写入仅可由可选技能在用户明确意图和授权下执行 |
| v3.10 | 否决 AI 全自动写论文绕过评审：触碰「验收层是护城河」底线——每步成果必须人工评审才合并进入下一步 |
| v3.11 | 否决 keyring 回退：macOS 钥匙串对未签名开发构建因 cdhash 失配丢条目（v0.3 已定论），0600 `keys.json` 不动摇 |
| v3.12 | 否决「无缝继续」表述：跨 Agent 交接在技术上不存在真正的上下文无缝迁移，一律称「接力」（结构化简报 + 显式接力链，AI 摘要仅可选增强） |
| v3.13 | 适配器注册表（§11.4 P1d）：「添加新 agent」澄清为新增 CLI 厂商（第七八个终端工具），要求降低接入成本——agents.rs / skills.rs / updater.rs / profiles / 官方账号字段等 per-agent 硬编码 match 收敛为中央声明式 AgentSpec 注册表（一个 CLI 一张规格），各模块从注册表读规格；**边界：会话解析器与 usage 提取器不可纯数据化**（各家格式本质不同），保持每 CLI 一个解析器文件，注册表只做分发入口。效果：加新 CLI = 一张规格表（纯数据）+ 一个解析器文件 + 测试。P1d 先行或与 P1a 背靠背（官方账号字段正是规格表字段，先注册表后填数据避免改两遍），250 个既有测试兜底重构安全；P5 的「适配层标准路径文档」随之撤销 |
| v3.14 | P2a PDF 内嵌预览落地：**直接上 pdf.js**（跳过 WKWebView spike——原生渲染拿不到选区文本且三平台行为不齐，选段问 AI 是硬需求）；pdfjs-dist 精确 pin，渲染器随 PdfPreview 组件动态 import 拆独立 chunk，worker 走 `?url` 资产；canvas + textLayer 只渲染当前页 ±1。新增 `read_pdf_bytes` command：**四类白名单**（注册项目登记资源 / 注册项目根 / 工作区·仓库根 / 终端标签 cwd hint）之外拒绝，canonicalize 防符号链接绕过，单文件 100 MB 上限；**传输走 base64 字符串而非 raw bytes**——macOS/iOS 的 Raw 响应会退化为逐字节 JSON 数字数组（tauri protocol.rs 实测），大 PDF 下不可用。选段问 AI = pty_write 逐字注入活跃标签输入框，不自动回车 |
| v3.15 | P3 接力 v1 落地（§11.3 机制四，handoff.rs）：`build_handoff_brief` 复用有界尾窗组装结构化简报（任务信息 / 最近 5 条用户要点 + 最后助手回复 / 当前 git 状态 / 接力说明），全文脱敏 + 64KB 上限后原子写 `cwd/.ccode/handoff-<时间>.md`（自定义路径限项目根内，父目录取最近已存在祖先 canonicalize 校验）；v1 不调 AI，AI 摘要保持可选增强。接力链两阶段：发起时按 agent+cwd 登记 `handoff_links` 小表（目标会话尚不存在），列表扫描到「登记后有活动的最新同目录会话」时固化进 `session_meta.handoff_from_*` 并**消费登记**（同目录后续新会话不再误标）；前端「◈ 接力到…」入口 = 终端专注栏 ⋯ 与对话页回放头部 ⋯，目标清单由注册表 prompt_inject + resolve_binary 合成（kimi/opencode 标注需手动并复制简报路径），接力会话在对话页显示「⇄ 接自 <Agent>」 |
| v3.16 | RX2a 笔记阅读模式：md 文件预览默认「阅读版式」——marked 渲染（pin 版本，静态 import 随 FilePreviewEditor 懒加载 chunk，不进主包）；渲染源为 read_file_preview 根约束内的本地可信文件，**不引 sanitize 重库**。排版样式集中 App.css `.md-body`（全主题令牌），v1 代码块不做语法高亮。「阅读/编辑」切换时 Monaco 保持挂载仅隐藏（脏内容/undo 不丢）；「⛶ 沉浸阅读」为 `fixed inset-0 z-30` 全宽覆盖层（与评审覆盖层同形态，终端/PTY 保持挂载，Esc 退出）；外部写盘自动刷新沿用既有 watcher 链路，编辑中（dirty）不覆盖语义不变 |
| v3.17 | P1a 官方账号 + P1d 适配器注册表落地：profile 双类型（API/官方账号，第一批 Claude/Codex/Gemini），连接走终端内 CLI 登录命令、断开引导 CLI 自己的 logout（auth 文件只读）；拉起不注入 API env 且 `env_remove` 同协议残留密钥变量；状态行检测 CLI 配置文件残留 API 密钥并黄色提示「N 项配置冲突」。per-agent 硬编码 match 收敛为 `agent_specs.rs` 中央声明式 AgentSpec 注册表（一个 CLI 一张规格：detect/launch_plan/resume/env、技能分发、安装更新、协议与密钥 env 名、官方账号 login/auth/env_remove）；**边界守住**：会话解析器与 usage 提取器不数据化，注册表只做分发入口 |
| v3.18 | P1b 流水线骨架 + RX1 落地：`.ccode/project.toml` 档案卡（资源清单 + 流水线定义，跟 git 走）与项目注册；工作区页按项目分组 + 步骤胶囊概览（状态从绑定工作区派生，无双状态机；分段进度条收敛为「研究流程 d/t」文字计数）；一键开步 = ensure_git_repo → `commit_project_bootstrap`（只提交 `.ccode`/`.gitignore` 两个自有路径，literal pathspec）→ 建工作区 → TASK.md → 终端预填；**TASK.md 自动加入 `.git/info/exclude`**（脚手架非产物，防全量提交带进分支污染主项目根）；资源面板只登记路径 + 自动发现候选；首启引导做轻量版（空流水线走模板选择器），演示数据完整版留 backlog。RX1：`PipelineEditor` 全宽编辑器为步骤编辑唯一入口（撤销步骤 ⋯ 内联编辑与 + 步骤表单），步骤资源绑定 `resources?: string[]`（空/缺省 = 全部资源，renderTaskMd 只在非空时过滤） |
| v3.19 | P2b 整理为笔记 + RX2b/RX3a 落地：`pdf_owner_project` 归属反查只在后端（登记资源 canonical 精确命中 → 项目根最长前缀，前端不做路径猜测）；写入只走 `append_workspace_inbox`（固定 `notes/inbox.md`、≤64KB、读-改-原子写、canonicalize 双校验防 symlink 逃逸）；无活跃工作区复用一键开步链路。RX2b：跨页「文件树切根」走 store 一次性 `enterCwdReq`；步骤产物面板打开时 `list_dir` 拉取一次（不进轮询；已完成读项目根 main，其余读工作树）。RX3a：会话步骤化——`session_meta` 附流水线步骤名（工作区名命中档案卡 steps[].workspaceName），对话页 badge/搜索/项目内分组统一走该映射 |
| v3.20 | P3 数据 + 接力落地：提货单 `artifacts.yaml` v1 务实版（手动登记 + 流式 md5/大小，已 git 跟踪文件拒绝登记，重复登记更新；大产物不进 git、清单随分支提交，下一步 TASK.md 自动带「上一步产物」段）；图片评审 `ImagePairView` 双栏看图（评审与改动面板共用，>20MB 回落提示）；长任务 OS 通知（注意力状态跃迁 + 窗口未聚焦 + 同标签 30s 去抖，设置页可关）；接力 v1 见 v3.15。RX3b：技能新建/编辑（create_skill/update_skill_content，重名拒绝、覆盖前备份、辅助文件保留）+「◈ 优化」开终端让 Agent 直改库文件；步骤可挂 `skills = [...]`，TASK.md 落「本步骤推荐技能」段（技能本体不进简报） |
| v3.21 | P4 论文 + RX4a + P5 打磨落地：科研论文/毕业论文模板自带 `quarto render` 脚本（开步写入项目 `.ccode/settings.toml`，run 菜单出现 render-draft/render-final；RX4a 追加 export-docx 同 md 导出 docx）；docx 走 mammoth 阅读版式（只读，>50MB 不渲染）；提货单登记的根外产物按精确路径纳入 PDF 白名单（P4 白名单扩展）；bib 联动以模板简报引用 references.bib 的务实形式落地。**逐 hunk 验收 v1 边界 = 仅未提交改动**：hunks 一律取未暂存 diff（工作树 vs 暂存区），丢弃 = `git apply -R`、暂存 = `git apply --cached`（补丁再经 `patch_targets_single_file` 校验只指向该文件）；勾选提交遇部分暂存走临时索引提交（`commit_selected_with_index`，提交后按路径 `git reset -q HEAD --` 同步真实索引）；已提交的累计 diff 禁止逐 hunk；新文件整文件算一块。**订阅口径**：官方账号用量显示「订阅」不计费（usage schema v6）；任务成本按工作区归因（schema v5）；跨标签聚合视图 `run-overview.ts` 纯逻辑按「要你管」排序 |
| v3.22 | 界面白话双层 + 精简收敛：主文案一律白话（保存到历史 / 多出 N 个保存点 / 改动说明 / 相对主分支），git 技术信息降二级（小字 mono、悬浮 title、详情 popover），**不加任何模式开关**；纯逻辑集中 `git-status-groups.ts`。管理列表只保留识别信息、状态与一到两个高频动作，低频项进「⋯」；工作区 PR/归档收口到统一全宽评审内确认执行（唯一例外：进行中的 merge 冲突保留行内「解决冲突」入口，仍进同一覆盖层）。Monaco 预览关闭 unicode 高亮（WKWebView locale 不命中致全角标点被黄框套住，中文笔记纯噪音） |
| v3.23 | 接入第七个 agent **CodeBuddy Code**（v2.132.0 实机验证，matrix §7）：注入只认 `CODEBUDDY_API_KEY/BASE_URL/MODEL`（ANTHROPIC_* 无效），协议 Anthropic 兼容；prompt_inject=位置参数、`-p` 无头、`-r <id>` 恢复、`--session-id` 固定会话名（pty 复用既有固定 ID 链路）。会话 `~/.codebuddy/projects/<slug>/<uuid>.jsonl`（slug 规则同 Claude；行 schema 与 Claude 不同构故独立解析器，时间戳为毫秒 epoch；usage 字段未实证，提取器尽力而为待真账号补全）。官方账号 TUI `/login`（浏览器 OAuth），env 优先压账号（实测 401）故拉起必须 env_remove；设为全局写 `~/.codebuddy/settings.json` env 块。落地形态验证 v3.13 注册表设计：新 CLI = 一张 AgentSpec（纯数据）+ 独立会话/usage 解析器 + 测试，agents/pty/updater/skills 零改动 |
| v3.24 | 接入第八个 agent **Cursor CLI**（2026.08.04-aaa8809 实机验证，matrix §8）：二进制用 `cursor-agent`（不用太通用的 `agent`）；**首个 env+flag 混合注入**——key/端点走 env（`CURSOR_API_KEY`/`CURSOR_API_ENDPOINT`），模型只能走 `--model` flag（bracket 参数化原样透传），注册表新增 `SpecialLaunch::CursorFlags` 变体（api/official 两路径同形，official 不注入 key 但保留模型 flag）。端点是 **Cursor 专有协议**（非 OpenAI/Anthropic 兼容）：不设供应商预设（presets.ts 注释说明），profile 三层验证的第三层标记「不支持云端验证」只给本地两层（不硬套 ApiKind）。会话 `~/.cursor/projects/<编码cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`（目录名=文件名=session id；`agent ls` 是 Ink TUI 非 TTY 会崩，发现只能文件扫描；type 枚举已知但完整字段样本未验证——独立防御式解析器，未知 type 跳过，文本/时间戳/会话 id 按候选字段名提取）。`~/.cursor` 与 IDE 共享：**会话删除不走目录级白名单**，由 `cursor_deletable` 精确限定 `projects/*/agent-transcripts/**/*.jsonl`（同根 auth.json/IDE 文件拒绝）；凭证默认 macOS 钥匙串（`AGENT_CLI_CREDENTIAL_STORE=file` 才落 auth.json），检测说明标注双通道；技能 `~/.cursor/skills-cursor` 未验证 CLI 是否真读，**强制 copy 分发**（`allow_symlink_for`）；无 brew/npm 包，安装走官方脚本、更新走非交互自更新 `cursor-agent update`；Windows 路径未验证（注释标注）。usage 提取器按字段名候选尽力而为，待真账号样本补全 |
| v3.25 | 全站界面确立“科研工作台优先”的信息架构：侧栏保留全部页面但按 **工作（工作区/终端/对话）→ 能力（配置/技能）→ 管理（统计/设置）** 分层，首次启动默认进入工作区；不把配置中心继续当首页。视觉借鉴高密度桌面工作台的对象列表、上下文栏和三栏结构，但不照搬 Git 客户端导航；工作区流水线、Agent 执行与人工评审仍是产品主轴。常规页统一使用 `PageFrame/PageHeader/PageToolbar`，标题栏只放当前上下文与唯一主动作，筛选进入独立工具栏；终端、对话和技能预览保留各自分栏与挂载语义。全站继续使用七套沉浸深色主题、零阴影、hairline 分隔与单一 CTA，不新增浅色或彩色图标（浅色否决已于 v3.44 作废）。 |
| v3.26 | 工作台布局进一步按对象规模收敛：工作区页从“所有项目纵向堆叠”改为 **左侧项目导航 + 右侧当前项目流水线/任务详情**，项目状态点直接表达活跃与待处理数量；技能页取消“一个 Agent 一列”的横向矩阵，主列表固定为技能/来源/应用计数/操作，选中后在右侧详情以自动换行网格管理 Agent 分发和阅读 SKILL.md，新增 Agent 不再改变主表列数。终端模块的文件树、标签、启动栏及右侧面板 UI 字号统一提高一级，xterm 新用户默认字号由 13 调为 14（仍尊重设置页 11–18 的用户选择）。 |
| v3.27 | 工作区、终端、对话三类高频工作页确立两级控件尺寸：标题栏与终端启动表单统一 32px，任务行、步骤胶囊、回放头部和图标操作统一 28px；可点击状态项同样保证 28px 点击区。主次操作只通过 CTA 填充、边框和文字色区分，不再通过同一操作组内的高度差制造层级。终端工作区外层与 xterm 画布共用主题 canvas 背景，避免空终端出现突兀色块。 |
| v3.28 | 全站页面建立统一留白节拍：常规页标题区、工具栏和主体内边距统一提升一级；工作区项目头、流水线步骤带和任务行增加适度垂直空间，低对象数量时保留连续主题画布，不用额外卡片或说明填空。 |
| v3.29 | 工作区项目详情建立单一职责入口：流水线步骤条改为等分列，每个步骤上方进度线与下方胶囊一一对应，窄窗口整体横向滚动而不换行。流程仅保留「开始 / 恢复 / 解决冲突」这类推进步骤的动作；未创建步骤只显示「开始」，不再重复显示同义的「待开始」，已归档步骤显示「已归档 + 恢复」。终端与普通评审统一由下方工作区任务行执行，产物查看与目录定位收进步骤「⋯」。编辑流水线、模板替换等项目级操作统一进入项目头「⋯」，不在流程末尾重复。已合并且无新提交的任务行只保留左侧「已合并」状态，不再显示语义冲突的「评审」；新提交后评审入口恢复。底层终端、评审覆盖层、产物读取与 Git 状态机均不变。 |
| v3.30 | 终端工作台参照 Codex/Review 的稳定三段结构：左侧只负责上下文（项目、工作区、文件树），中间只负责 Agent 终端执行，右侧成果工作台固定为「对话 / 文件 / 改动」三模式并默认可见。启动栏删除重复的「对话」按钮，右侧工作台增加统一标题、当前目录上下文和唯一入口；「文件」包含文本/PDF/docx 预览编辑，「改动」包含 Git 状态、提交和任务审阅入口。保留右侧拖拽宽度、宽屏隐藏工作树、PTY/会话挂载和全宽评审覆盖层，不改变底层进程与 Git 语义。 |
| v3.31 | 端口运行时监控（portwatch.rs，工作区页尾部默认折叠区）：列出本机 LISTEN 端口并标注归属——cwd 最长前缀命中工作区 worktree / 注册项目优先（项目嵌套归内层，组件级前缀比较防 myrepo2 误命中 myrepo），回落**活跃**工作区 CCODE_PORT 段（仅 active，与端口 env 下发口径一致），其余「系统/其他」；归属数据源（app.db 工作区/项目表）读取失败降级为空标注，不阻断端口列表本身。「终止」v1 只发 SIGTERM（进程不退由用户稍候重试，不自动升级 KILL），kill 前重新列举确认该 pid 仍在监听，防 pid 复用误杀；unix 走 lsof（resolve_binary → /usr/sbin 等固定候选，GUI 短 PATH 兜底），cwd 批量取 `lsof -a -p <pids> -d cwd -Fn`；Windows 走 netstat -ano + tasklist（无 cwd 轻量接口，cwd 归属不可用、段归属仍可用）。前端展开才拉取 + 手动刷新，不轮询 |
| v3.32 | Claude Code hooks 精确注意力标记落地（v0.7 留 v2 的评估项，ruflo 实证 hooks→状态文件链路可行）：设置页开关显式开启后才写 `~/.claude/settings.json` 的 hooks 段（UserPromptSubmit/Stop/Notification 三事件，命令把事件 JSON 加 unix 秒前缀追加到 `<config>/ccode/hooks-state/claude-hooks.jsonl`），写入遵守备份+原子写、只动 hooks 键、用户已有 hooks 合并不覆盖、移除只删含状态日志路径的条目、配置损坏拒绝写。`session_tail_state` 对 claude-code 优先读事件日志按 session_id 取最新事件（UserPromptSubmit→working / Stop→done / Notification→confirm），缺失或超 10 分钟无更新回落尾部推断；消费侧（终端注意力点/运行中聚合/OS 通知）零改动。备份文件命名用纳秒后缀防同秒开关覆盖 |
| v3.33 | 走查去层级冗余：终端右栏页签行与对话头部**合并为一行**（撤销 v3.30 的「统一标题 + 当前目录」行——标题/agent/会话 ID/状态/完整回放收进页签行右侧小字，文件/改动上下文由各自内容头部承担），终端三带头部同为 h-9 对齐；左栏「打开的标签」「最近项目」改一行式折叠（默认收起，三区标题统一 10px 灰字、点击区 ≥28px），项目区+文件树为常驻主体——评估过「打开的标签并入项目区」方案后否决：聚合视图是跨项目「要你管」排序，项目区只覆盖当前项目，合并会丢跨项目总览且增加项目区噪音（工作区注意力点项目区已有）。对话页分类筛选展开后 agent 节点直接平铺项目，去掉 agent 层二次折叠（计数/右键删除不变）。默认主题 hairline 自 #2d3448 调柔至 #282e42（用户反馈“亮线生硬”；其余六主题 hairline-vs-inset 对比度实测在同一档，不动）；对话页列表栏标题对齐 PageHeader 的 16px semibold 档 |
| v3.34 | 对话页分类筛选改**左右主从栏**（撤销 v3.33 的「agent 平铺项目」——全平铺导致项目一多就要长滚动找目标）：展开后左栏固定列出 全部对话/Ccode 内部 AI/各 agent 及计数（一眼看全，无需滚动），点 agent 即筛选并在右栏列出其项目（顶部「全部项目」回到 agent 整体），再点项目精确筛选，两击到位、无嵌套折叠；两栏各自 max-h 滚动互不挤压。评估过 pill 行筛选方案后否决：8 个 agent × N 项目的胶囊行换行不可控，照样吃纵向空间且项目计数无法同屏。右栏聚焦 agent 独立 state（显式点选优先，失效回落当前筛选/列表第一家）；项目行右键批量删除、计数口径与归档开关联动不变；agent 行由 div 改 button，键盘 Tab 可达 |
| v3.35 | 界面线条语言批次（用户反馈"看着像一个个格子区域"）：确立**去格子化**规则——内联内容容器（工具栏/分区/面板/卡片式列表）一律去 1px 描边，靠底色明暗差 + 统一圆角 + hairline 分隔线分层；边框只保留给浮层（弹窗/浮出菜单）与控件（按钮/输入框）；PageToolbar、设置页 Section、端口区、流水线 strip、资源/产物/模板面板、PipelineEditor 步骤卡、历史时间线列表、终端搜索条等全站收敛。七主题浮起梯度校准（ayu/mocha/neutral/dracula/shadcn 的 strip=inset 塌陷全部拉开，默认主题 strip→inset→raised 步进匀开）；新增 `--color-editor-bg/fg/line` 令牌（各主题独立取值），Monaco 编辑器经 MutationObserver 监听 data-theme 实时换肤（原焊死默认主题色）。共享控件收敛进 PageFrame.tsx（rowActionClass/ghostActionClass/fieldClass/searchFieldClass/hoverRevealClass + SegTabs 组件，约 100 处散落复制替换），删除配置页专属别名令牌 pg/grp/hl2/pl1/pl2/okb/warnb。对话页分类筛选修正主从交互（修 v3.34 的"点 agent 即筛选"）：左栏点 agent 只聚焦右栏、不再立即筛选并关闭回放，右栏才落筛选，选中自动收起 |
| v3.36 | 改动面板改**主从分栏**（用户给外部 Git GUI 参考图：左 diff 右文件列表）：点文件行从「行内展开」改为左栏 diff 主区 + 右栏 176px 紧凑文件列（状态徽标 + 文件名，勾选框保留，选中行浅填充，再点当前行或 × 收起回全宽列表）；diff 主区承接原展开区全部能力（逐 hunk 丢弃/暂存、部分暂存提示、图片双栏、截断标记），取消行内展开的 max-h 高度帽（分栏后由主区自滚动）。WKWebView 不显示 title 悬浮——diff 入口改 hover 才现的可见「diff」小字提示。随后用户拍板两处视觉校准：紧凑 diff 增删行**整行铺语义深底**（bg-ok/bg-err，推翻 v3.2 的禁铺色约定，参考图即整行铺色更清晰）；**全局字体去"发白发飘"**——body 去掉 `-webkit-font-smoothing: antialiased` 恢复次像素渲染（macOS 深色下 antialiased 把笔画削薄），diff 正文 11px→12px 档（终端工作台内实际 13px） |
| v3.37 | 线框二次收敛（用户 Dracula 主题截图走查"还是像格子"）：**六套非默认主题 hairline/field 全部调柔**（v3.33 只调过默认主题；实测 Dracula hairline 与底色亮度差 ≈40 远硬于默认主题 ≈12，六主题统一压到默认档位）；终端左栏「打开的标签/最近项目/项目」区标题与工作区 rail 底部横线**去线改留白分层**（错位横线是最强的格子感来源）；搜索框去描边化（searchFieldClass 改 inset 底色 + 聚焦加深，不再画框）。对话页分类筛选**改回单列纵向手风琴**（用户反馈左右主从栏"一横一竖难受"，取代 v3.34/v3.35）：点 agent 只展开/收起项目子列表（左侧缩进线表达层级），「全部项目」/单项目行落筛选并自动收起，点 agent 不再动筛选/关回放的语义保持。同批**侧栏向 Codex 看齐**：品牌区去渐变去下线、工作区 rail/终端工作树/对话列表栏的头部横线全拆，侧栏只留全高竖分界 + 底部管理区一根横线，分区间一律留白 |
| v3.38 | 侧栏按页面自动收展（用户提出「移到顶端」，评估后否决全局顶栏：垂直空间全页征税、与 macOS 标题栏叠罗汉、专注模式插槽与运行徽标需重设计；多列宽度压力其实只在终端/对话页）：进入终端/对话页自动收成 56px 图标栏，离开恢复 localStorage 手动偏好；手动折叠/展开置 `navManual`（session 级）停止自动跟随；`setNavCollapsedAuto` 不写 localStorage，防自动行为污染手动偏好。同批**全站线条细化**（用户反馈"线条再细一点"）：App.css 统一把 border/border-t/b/l/r 与 divide-x/y 覆写为 0.5px（Retina 出真发丝线，1x 屏浏览器兜底 1 物理像素；focus-visible outline 保持 1px 不动）；侧栏底部管理区横线改 5% 白隐约细线（用户否决全拆），常规页 PageHeader 底线同批拆除（标题栏靠留白分层） |
| v3.39 | **首页注意力收件箱**（第一性原理讨论后用户拍板做第①条）：工作区首页顶部新增「待你处理」区——聚合工作区冲突/可合并（health 页内已有）+ 终端标签待确认/已完成，排序 冲突 > 待确认 > 可合并 > 已完成，为空整块不渲染（零噪音）；每条 = 状态点 + 一句话 + 直达按钮（复用 openReview / resolve-conflict intent）。数据管道：TerminalPage 的 run-overview inputs 镜像进 store（`terminalRunInputs`，不新增轮询），跳转走一次性 `focusTabReq`（终端页可见时消费 → activateTab；已关闭标签静默忽略） |
| v3.40 | 键盘流与唤回闭环（第一性原理建议③④⑤落地）：**⌘K 命令面板**（`CommandPalette.tsx` 浮层 + `command-palette.ts` 过滤纯逻辑，命令 = 七页跳转 / 七主题切换 / 侧栏显隐；↑↓+Enter+Esc）；**⌘1–⌘7 页切**（顺序同侧栏分层）；**⌘\\ 执行态隐藏侧栏**（store `chromeHidden`，session 级不持久化；⌘K 与 xterm 无冲突——清屏是模拟器键位本应用未实现，⌘F 已被终端搜索占用）。**通知唤回闭环**：注册 `ccode.attention` 通知动作类型（「去处理」按钮），`onAction` → 聚焦窗口 + 回首页收件箱；macOS 横幅样式不显按钮（系统设置决定），正文点击走系统默认激活，收件箱双通道接住。主题清单抽 `src/themes.ts` 单一出处（设置页/命令面板共用） |
| v3.41 | **快捷键自定义**（设置页「快捷键」分区）：命令面板/隐藏侧栏两个绑定支持点击录制新组合键（`hotkeys.ts` 组合串纯逻辑："mod+shift+key"，mod=⌘/Ctrl，空串=禁用，冲突拒绝），⌘1–⌘7 页切整组开关；三个字段入 settings.rs（hotkeyPalette/hotkeyHideChrome/hotkeyPageSwitch，patch 语义 Some 覆盖含空串）。**通知直达**（补 v3.40 的半步）：通知 extra 携带 tabId/cwd/kind，onAction 分级路由——已完成且 cwd 命中任务工作区（`list_workspaces` 精确比对）→ 直达评审覆盖层；待确认/其余 → 聚焦对应终端标签；无 extra → 首页收件箱。**收件箱后端直查**：外部 live 会话（无终端标签可跳）经 `session_tail_state` 直查（live 且非内部、上限 10 条），待确认条目进收件箱，点击走 `openSessionReq` 打开对话页回放——终端页未挂载不再是收件箱盲区 |
| v3.42 | **科研操作流去摩擦批**（第一性原理走查后用户拍板全做，六件）：①产物微循环——步骤产物面板升级**核验清单**（✓/— + mtime + 10 分钟「刚更新」+ 手动刷新不轮询），md/PDF 选段浮动条加「↵ 直接发送」（pty_write 一次拼接 \r）；②**沉淀为技能**——选段「✦ 沉淀为技能」→ `ai_distill_skill`（脱敏+8KB+JSON 容错）→ 技能页新建弹窗预填（`skillDraftReq` 一次性请求）；③结构归位——收件箱上提**横跨两栏**（全局事项不嵌单项目详情栏），终端左栏两段化（删「打开的标签」区，「最近项目」收进搜索行 ⌄ 浮层）；④启动栏模型改 **combo-box**（可输可选，`ccode.modelHistory.<agent>` 历史上限 10，「新增模型」概念消失）；⑤对话筛选 chip 行并入「分类筛选」行尾（当前口径 + × 同行）；⑥**评审合并成功一键开下一步**——开步链路抽 `src/pipeline-start.ts` 单一出处（renderTaskMd/startPipelineStep/buildWorkspaceTerminalRequest），合并成功横幅挂「▶ 开始下一步」（下一步 = 当前步按 workspaceName 命中后第一个无同名工作区的步骤；合并并归档成功即关覆盖层不出入口） |
| v3.43 | **16 条走查批**（用户逐条反馈）：①侧栏自动收展删除（收展全手动）；②统计归入「能力」组、底部只留设置，组标题 11px；③侧栏品牌/图标尺寸随宽度优化；④胶囊/菜单重复入口去重（终端/评审只留任务行，产物只留胶囊按钮）；⑤端口区分本应用/系统其他两段 + 外部进程终止二次确认；⑥ok 绿改深色兼容哑光绿 #4cc38a；⑦「已合并」改行内小字状态；⑧状态点全局统一 size-2；⑨左栏 « 收起态删除；⑩修 chromeHidden 下专注渲染失败（portal 机制随专注收敛整体删除）；⑪专注内容遮罩去模糊；⑫专注收敛为「专注终端/专注内容」双模式 + Esc 退出；⑬筛选选中不再自动收起面板；⑭profile ⋯ 菜单「复制到其他 agent…」（后端 `copy_profile_to_agent` 密钥不出站，同协议族校验，双份口径前端禁用/后端强制）；⑮GitHub 导入技能自动分类（默认仓库名）+ 来源列可点跳原地址（plugin-opener）；⑯修快捷键录制（WKWebView 点击 button 不给焦点 → 改 window capture 监听 + `captureDecision` 纯逻辑） |
| v3.44 | **五件走查批**：①流水线 strip 收敛（删列间 → 箭头、待开始列也渲染灰点状态补齐五列结构、⚠ 提示改 strip 右上角浮贴不独占行）；②修专注内容"终端黑了"（遮罩 bg-black/50→25 且不遮顶部标签条）；③对话筛选：浏览筛选不收起、**选中具体会话才自动收起**；④技能列表加「分类」列、技能列只显名称（描述收进详情面板）；⑤**主题系统扩容**：七套深色文本对比度按阅读上调一档 + **新增七套对应浅色**（方向翻转配方：rail 略暗于 canvas、面板向白浮起、cta 加深保对比；Catppuccin 浅色直接用官方 Latte、shadcn 用官方浅色骨架；白色半透明 hover/缩进线/滚动条在浅色下统一翻转为黑色半透明；Monaco editor-* 令牌与 xterm bg/fg 表同步补齐；主题清单 themes.ts/settings.rs KNOWN_THEMES/XTERM_BG_FG 三处同步）。「浅色模式否决」就此作废 |
| v3.45 | **流水线胶囊状态分层 + 产物入口搬家**（用户明确规格）：胶囊只突出当前步骤，全部状态文字（已完成/进行中/待开始）从胶囊撤下——已完成/已合并 = ✓ + 步骤名；当前步骤（进行中/待评审/阻塞/已归档待恢复）= cta 描边高亮 + 第二行按状态展开动作（待评审无动作显示「到下方任务行操作」小字）；未开始 = 编号 + 名称降对比，「开始」hover/focus 才现；步骤 ⋯ 收胶囊右上角 hover 才现；进度段不动。产物核验清单从胶囊移到**任务行行内手风琴**（抽共享组件 `ArtifactChecklist.tsx`，步骤按 workspaceName 反查 project.toml；已合并行保留入口读项目根/main，其余读工作树；打开拉取一次 + 手动 ⟳ 刷新语义不变；展开态按工作区 id 记忆、切项目清空）。开步/评审/合并逻辑零改动 |
| v3.46 | **流水线大圆步进器**（取代 v3.45 胶囊分层与进度段）：名称带与步进器带两个同列网格；虚线为**真实 flex 块节律**（`StepperCell`：5px 块 + 5px 间隙全是真实元素，块数按列宽 ResizeObserver 现算，与圆心同轴、跨列连续，永无渐变相位残段/双块）；**大圆 24px 纯色实心（内无字符）= 状态色 + 唯一主推进点击**（done=ok、进行中/checking=cta pulse、待评审=cta-pill、阻塞=warn、pending=实心灰；点击按状态 startStep / 恢复归档 / 跳终端——进行中/待评审/阻塞圆均跳终端 / done 开主仓 shell 终端，状态与目录/agent/profile 收进悬浮 title）；**圆前/圆后小方块 = 节律中的普通虚线块 + 28px 透明热区**，视觉混在虚线里、hover/focus 提亮才现——圆前 = 打开流水线编辑器并定位该步骤卡片（聚焦简报框），圆后 = strip 下方就地展开 ArtifactChecklist 产物手风琴（root 口径同任务行：done 读项目根、其余读工作树、无工作区禁用）；解决冲突/评审/合并仍归下方任务行，步进器不再放第二行动作 |
| v3.47 | 走查零碎批 + 按功能 AI 配置：技能页三修（来源列显示 owner/repo[/subdir] 具体地址并可点跳原地址；详情面板只钉名称行、其余随内容滚动——修"上半部分被挡住"；SKILL.md「◈ 翻译为中文」复用 ai_prompt 一次性调用、译文随会话缓存不写库）；课题主题从悬浮提示改为项目头常驻小字（悬浮只放补充信息的规则确立）；配置页模型列全量展示（`·` 连排）；工作区项目栏右键菜单（重命名/复制路径/移除注册）+ rail 底部占位删除（添加入口收进栏头 + 钮）；**内置 AI 按功能独立配 profile**（`settings.aiProfiles` map：commit/summarize/pr/distill/conflict/translate 六键，解析顺序 显式 > 功能专属 > 全局专用 > 最近使用，专属失效回落）——动因：翻译等轻任务落到大模型太慢；**步进器完成色独立为 `--color-done`**（14 主题各配低饱和绿，与 ok 状态绿解耦，用户反馈亮绿突兀） |
| v3.48 | **长时工作色彩校准**（用户反馈沉浸黑实为墨蓝、不适合长时间编码/阅读）：默认主题去蓝化——基底从深蓝黑改暖中性炭黑（rail #0a0b0e/canvas #101218），文字从冷白灰蓝改暖纸白（l1 #e9e6e2/l2 #bdbab4），folder/tabline/editor 面同步去蓝；shadcn 深色同步减蓝；midnight-light canvas 调暖（#f4f4f1）；xterm midnight bg/fg 跟随。原则：不纯黑、低蓝光、文字不刺眼 |
| v3.49 | **macOS 对话框与关窗链路收口**：wry 0.55 的 WKWebView 未实现原生 JS `confirm/alert/prompt` 委托，确认、提示与输入一律使用应用内组件，禁再引入原生 JS 对话框；全局 promise 版 `ConfirmDialog.tsx` 宿主挂 App 根部，覆盖普通页面与全屏评审层。终端 `onCloseRequested` 仍只对存活 Agent 统一确认，但 Tauri 前端封装会调用 `window.destroy()`，确认后还会调用 `window.close()`，因此主窗口 capability 必须同时保留 `core:window:allow-destroy` 与 `core:window:allow-close`，否则进入终端页挂载监听后无法退出 |
| v3.50 | **Release 触发去重**：SSH:443 的 tag push 是否自动触发 Actions 以 GitHub 实际 run 为准，不再假定 deploy key 一定不触发；推 tag 后先检查对应 SHA/tag 的 push run，存在则复用，30 秒内不存在才手动 workflow_dispatch。两个入口不得并行打包同一 tag，避免 tauri-action 竞争创建或上传同一个 Release |
| v3.51 | **Windows 闪窗修复 + 一键诊断包**：正式版无父控制台时，终端页 Git 状态轮询会让每个 `git.exe` 创建 `conhost.exe`，开发版因继承控制台而无法复现；所有非交互后台命令统一经 `process.rs` 加 `CREATE_NO_WINDOW`，外部终端保持可见。设置页诊断升级为 ZIP 支持包：系统/WebView2/GPU/WebGL、语言/输入法、功能开关、应用日志和有界进程生命周期；不采集环境变量，参数与日志 Rust 层脱敏，系统级只额外观察 CTF/TextInputHost。后台命令包装与 250ms 扫描由 `cfg(windows)` 隔离，macOS/Linux 继续使用标准 `Command` 且无监控线程。 |
| v3.52 | **诊断包驱动的收尾修复**（Windows 现场包 `ccode-diagnostics-2026-08-09` 离线分析结论）：① git 仓库探测风暴——改动面板 8s×挂载标签轮询使非仓库 cwd 每轮真 spawn git（实测 85 秒 73 次同目录 `rev-parse`），`git_info::probe_is_work_tree` 增加 30s 负缓存（只缓存否定结果，init 后主动失效）；② `list_repos` home 排除被 `canonicalize` 的 `\\?\` 前缀绕过，home 改同口径规范化后再比；③ WebGL 探针「renderer 不明保守回退」收窄为仅 Windows，避免 WKWebView 屏蔽 debug renderer 信息时误伤 macOS WebGL 渲染。spawn-hook/扫描辅助函数全部 `cfg(windows)` 门控，非 Windows 构建零警告。 |
| v3.53 | **技能一键应用更新**（§6.13 收尾）：`apply_skill_update` 按安装时记录的 repo/ref/subdir 重下 zipball，`import_zip_impl` 新增 `only` 过滤保证只覆盖同名技能（同仓库其他技能不新增不覆盖），复用覆盖+备份路径并刷新 revision 基线；下载循环与版本回写抽为 `download_github_zipball`/`record_github_revision` 供导入与更新共用。上游改名/移动时明确报错引导手动重新导入。前端在详情面板「GitHub 可更新」旁与行 ⋯ 菜单各加一处一键入口，确认走 confirmDialog。 |
| v3.54 | **步进器信息可达性 + 原生控件主题同步**：① 大圆悬浮信息从原生 title 改应用内 tooltip（`useHoverTip`/`HoverTip`：fixed 定位、横向钳制、滚动/缩放/点击即关，事件挂包裹 span 禁用态可用）——原生 title 在 WKWebView 不渲染或残留串到相邻控件；圆与小方块统一，禁回退原生 title。② 大圆右上角注意力角标（待确认=warn/已完成=done，confirm 优先），只读消费 `terminalRunInputs` 镜像不新增轮询。③ 切主题同步原生窗口外观（`applyTheme` → `setTheme`），修复深色主题下原生 `<select>` 弹出系统浅色列表；capabilities 加 `core:window:allow-set-theme`。 |
| v3.55 | **官方账号检测不再把 API Key 模式算成「已连接」**：codex `auth.json` 顶层 `OPENAI_API_KEY` 从凭证字段表移除，改由 `OfficialAccountSpec.api_key_fields` 单独识别——官方 `--api-key` 与第三方中转（cc-switch 等）写出的文件形状相同，无法区分，状态行如实显示「API Key 配置，不是官方账号登录」（`AuthProbe::ApiKeyMode`，优先级在损坏之下、未识别之上）。同批：**脉冲动画有界化**——新增 `animate-pulse-brief`（App.css，3 周期≈6s 后静止，状态复归重播），步进器进行中圆与项目区工作区状态点从无限 `animate-pulse` 换用；骨架屏等加载态保持无限脉冲不变。 |
| v3.56 | **MCP server 统一清单与分发**（matrix §10 调研落地，§6.15）：新增第八页 MCP（⌘6，能力组技能与统计之间）——统一清单 + 按 agent 开关直写八家用户级配置（读-改-写一个键/段 + 备份 + 原子写 + 读回校验）；codex 走 TOML、四家 JSONC 容错读、密钥引用转各家间接引用字段不落明文；不用各家 CLI 的 mcp 命令分发（语义不一且 codex add 有 OAuth 弹窗副作用）；server 名取交集禁下划线。同批：自定义定价改表格编辑（pricing.json 格式与后端校验不变，存量 `_rate` 保留）；技能分类存量批量回填（`backfill_skill_categories`，GitHub 来源无分类补仓库名）；技能页未分类组固定沉底。 |
| v3.57 | **提炼接力（◈ AI 蒸馏简报续作）**：补 resume（全量上下文带回，长会话污染）与 v3.15 快速简报（仅尾窗摘录）之间的空档——`build_session_digest` 读全会话文本（DTO 层已脱敏，`cap_text_middle` 24KB）经无头 AI（新功能键 `digest`，进设置页按功能 AI 配置）蒸馏成结构化简报（任务目标/关键决策/已完改动/状态待办/下一步/环境约束），AI 输出再过 `redact_and_cap` 落盘 `.ccode/handoff-<时间>.md`；失败行内报错可重试，不免 AI 静默降级。消费三路径：内部同 Agent 新会话（DigestPicker 目标列表来源 agent 置顶，不走 resume）/ 内部跨 Agent（复用接力链登记）/ 外部（`digest_command_line` 按注册表 prompt_inject 拼「新会话 + 读简报首条指令」——**非 resume**，⧉ 复制命令 / ⇗ 外部终端；kimi/opencode 无注入参数复制指令文本手动发送）。入口：对话页回放头部「恢复 ▾」与行内 ⋯、终端标签 ⋯ 与状态条 ⋯。 |
| v3.58 | **页切快捷键逐页可自定义**（取代 v3.41 的整组开关单控）：页切清单抽 `hotkeys.ts` `PAGE_HOTKEY_DEFS` 单一出处（id/名称/默认 mod+1..8，App.tsx 全局监听与设置页录制 UI 同源）；settings.json 新增 `hotkeyPages` map（键 = 页面 id，缺省回落默认，整图覆盖同 ai_profiles 口径），整组总开关 `hotkeyPageSwitch` 保留。`captureDecision` 冲突判定从单一冲突方改为多冲突方数组（八页切 + 面板 + 侧栏互判）。 |
| v3.59 | **收件箱顶部悬浮化 + 按项目摊开 + 侧栏徽标 + done 态文案纠偏**（用户三连反馈："N 条事项把工作区页顶下去"、"没看到收件箱在哪"、"只是回合结束就提示已完成"）：① 收件箱改**顶部悬浮 pill**（absolute 覆盖不占布局，pill 带总数 + 分类摘要「2 冲突 · 1 待确认」，点按向下展开明细浮层，遮罩/Esc 收起，为空不渲染）；② 导航行「待处理」扩到收件箱全口径（`run-overview.ts attributeToProject` 纯逻辑：分隔符归一 + 段边界防 /repo/a2 误中 /repo/a，嵌套根取最长）；③ 条目数镜像进 store（`inboxCount`，WorkspacesPage 唯一写入方），侧栏「工作区」图标挂 warn 色计数徽标（复用终端运行数徽标模式，任意页面可见、有事才出现）；④ **注意力 done 态用户面文案从「已完成」改「已回复」**（收件箱/标签悬浮/通知正文/步进器角标/设置页）——尾部推断只能看到「回合结束等你输入」，看不到任务完成，文案必须如实。三层分工：徽标报数 → 悬浮收件箱列事 → 导航行给分布。走查续批（用户五连反馈）：⑤ 步进器大圆「已回复」绿点角标移除（每回合结束都亮，噪音大于信号），只留待确认黄点；⑥ 侧栏徽标三轮后**全删**（数字胶囊突兀 → 圆点与项目行状态点撞语义 → 裸数字仍嫌吵；用户拍板三平台一个不留，计数只留悬浮 title 与标题栏胶囊/页内 strip），nav 保留 overflow-x-hidden 兜底；⑦ MCP 页 PageFrame standard→wide 对齐技能页；⑧ 收件箱悬浮 pill 遮挡内容被否决 → **文档流单行 strip（32px）+ 展开明细悬浮下拉**（不推布局不遮挡）；⑨ **macOS 收件箱收进自绘标题栏**（用户要 Ghostty 式：`titleBarStyle: Overlay` + `hiddenTitle`，App.tsx 渲染 40px 拖拽区 + 窗口标题 + 标题后收件箱胶囊/下拉；条目改可序列化 `InboxItem` 镜像进 store，`runInboxAction` 统一派发；capabilities 加 `core:window:allow-title`；⌘\ 执行态随 chrome 一起隐藏）。Windows/Linux 保留原生标题栏 + 页内 strip（Overlay 仅 macOS 生效，功能不裁剪、仅 chrome 集成随平台能力）。 |
| v3.62 | **任务卡层：对话的文件夹 + 定稿简报的收集夹**（核心哲学：对话是日志、简报是记忆，卡片是两者的容器）——卡片挂在项目 `.ccode/project.toml` 旁（projects.rs task_cards，写操作过 `ensure_task_project_root` 门槛，list 对非项目返回空表），可挂流水线步骤；**无独立状态机**（卡片自身没有任何状态，进度仍从绑定工作区/会话派生），不碰工作区与评审流程。会话归置存 `session_meta.task_id`（`assign_session_task`，删卡自动清归置，SessionMetaDto 回填 taskName/taskId）。**简报与 TASK.md 的分工**：步骤简报是合同（做什么、交付什么，写死在模板/档案卡），定稿简报是进度与思想快照（做到哪、为什么这么决策）；TASK.md 不预存——开步时三来源现拼（步骤简报 + 项目资源/提货单 + 卡片最新定稿简报全文，`startPipelineStep` 加可选 `briefPath`，读取走 `read_file_preview` 根约束、best-effort 不阻断开步）。**提炼简报升级八段**（原六段 + 思路与理由 + 已否决方向，用户消息原文锚定防 AI 自由发挥），且 DigestPicker 变两段（定稿页 → 发送页）：AI 初稿进可编辑文本框，**人工定稿后才落盘钉卡**（`save_task_brief` → `.ccode/brief-<时间>.md`；定稿简报是项目文档，不走 handoff-*.md 的 gitignore 规则；发送一律用定稿路径 `digestJob.finalized`，AI 初稿留盘不再用；「暂不发送」= 仅定稿落盘钉卡）。工作区页步进器下方新增卡片区（`TaskCardsSection`，按步骤分桶、失效步骤并入「未挂步骤」桶）：「开工」= 开步链路注入最新定稿简报，「继续」= pendingTerminal 预填「阅读简报并继续任务」（kimi/opencode 无注入由 promptDropped 既有处理兜底）。对话页项目筛选下**从按步骤分组升级为按卡分组**（「未归置」恒最前，同原「无工作区会话排最前」口径），meta 行「▤ 卡片名」chip 经一次性 `selectProjectReq` 跳工作区页，⋯「移到卡片…」仅项目筛选下出现。**评审「沉淀到下一步」**：合并成功横幅旁次级入口，评审结论 → 下一步步骤首张卡片（无则以步骤名 `create_task_card`）→ `save_task_brief` 钉入，供下次开工/继续注入。前端纯逻辑集中 `src/task-cards.ts`（分桶/排序/分组/简报时间解析，tests 同步），store 按项目根缓存 `taskCards`、删卡/归置顺带刷新会话列表。 |
| v3.63 | **评审可信度证据 + 上游漂移提醒 + 沉淀触点统一**：① 评审覆盖层顶部新增「可信度」行——`check_citation_health`（新模块 citation.rs，纯 Rust 无 AI）扫工作树 .md 的 Quarto/Pandoc 引用键（`[@key]`/`[@k1; @k2]`/`[-@key]`，保守口径：项必须以 `[-]@key` 起头，带前缀的 `[cf. @k]` 不收）对照 references.bib（根目录优先、其次 `manuscript/`），同行附「产物 X/Y 已产出」摘要（复用 ArtifactChecklist 的 list_dir 定位机制，不另造请求）；路径白名单同 pdf.rs（注册项目根 + 工作区工作树/主仓，canonicalize 后判定）；无 bib/全文无引用/无预期产物时不渲染，进评审一次性读取不轮询，失败静默降级。② **上游漂移提醒（启发式非硬状态）**：`stale_upstream_for` 纯逻辑——步骤 k 的任一上游步骤（序号更小，按 project.toml steps[].workspace_name 绑定工作区）晚于本步「最后推进时间」（已合并取 merged_at、未合并取 created_at；均为 now_iso 定宽 UTC 串，字典序即时间序）发生合并 → WorkspaceDto 附 `staleUpstream`（最晚合并的上游步骤名，仅 list_workspaces 计算）；本步再次合并后 merged_at 推进、自然恢复新鲜，无需额外状态位。前端三处同文案警告色提醒（步进器悬浮卡/任务行状态详情/评审覆盖层顶部），只提醒不阻断。③ **定稿触点统一为「AI 起草 → 人定稿 → 落盘钉卡」**：评审「沉淀到下一步」编辑区加「◈ AI 起草」（`ai_distill_review`，上下文 = 本步提交清单 + diff numstat + TASK.md 全文，**功能键复用 `digest`** 不新增设置项，设置页该行标签改「提炼接力 / 评审沉淀」），输出过 `redact_sensitive_text` 返回、落盘仍走 save_task_brief 的 redact_and_cap 兜底；失败行内报错可重试，不静默降级。沉淀编辑区说明行与 DigestPicker 定稿页措辞统一（「AI 初稿，改完定稿后才会落盘」）。 |
| v3.64 | **开工确认弹层（「开工」改两步：点开工 → 确认弹层 → 确认开工）**：统一承载三诉求——① TASK.md 全文预览（所见即所得：弹层预览与实际落盘共用 `pipeline-start.ts` 的 `renderTaskMd`/新抽取的 `gatherTaskMdExtras`+`readTaskBriefs`，禁复制拼装逻辑；只读 mono 预览）；② 多卡简报融入——本步骤含简报的卡片逐个勾选（纯逻辑 `briefSourcesForStep`/`defaultCheckedSources`/`checkedBriefRefs` 进 task-cards.ts），`renderTaskMd` 的 `finalBrief` 参数改 `briefs: TaskBriefInput[]`（单份直排、多份按卡片名分小节），`startPipelineStep` 的 `briefPath` 改 `briefs: TaskBriefRef[]`；勾选 ≥2 张出现「◈ 融合所选简报」→ 新 command `ai_fuse_briefs`（逐份 canonicalize 根校验 + 每份 8KB/总量 24KB cap，**功能键复用 `digest`**，prompt 要求保留各来源关键决策/思路理由/已否决方向、冲突显式呈现不擅自裁决、末尾注明融合来源）→ 弹层内定稿态（与 DigestPicker/评审沉淀同一措辞）→ `save_task_brief` 钉目标卡（默认出处卡，可换卡或新建）→ TASK.md 改用融合简报；③ 主仓改动协同——弹层顶部与卡片区标题行各一条警告色提醒「主仓 N 个未提交改动」（复用 `git_status`，进项目详情读一次 + 弹层打开刷新，不轮询；非 git 不渲染；**只提醒不阻断**，想法期实验性改动留主仓合法），卡片区提醒点击经 `PendingTerminal.rightTab: "git"` 一次性交接直达终端页改动面板。入口口径：弹层只挂步进器大圆与卡片「开工」两处；评审「开始下一步」保留直开（连续流，简报已沉淀到下一步卡）；「继续」不经弹层。 |
| v3.65 | **项目移除加中间档「清除 Ccode 痕迹（保留文件夹）」**（用户原话：只保留没建项目时的文件夹，其余都删掉）——新 command `purge_project_traces`（projects.rs，结构仿 delete_project_dir_impl）：canonicalize + `guard_project_dir` 防护复用 → `delete_workspaces_for_repo` 清全部工作区（worktree/分支彻底删，同删除项目目录口径）→ `.ccode/` 走 `trash::delete` 系统回收站（可反悔）→ `remove_project_at` 摘注册（未注册容忍）；三者皆无报「没有 Ccode 痕迹」。**不自动 git rm/提交**（自动提交用户仓库违反既有纪律）：.ccode 若被跟踪过，删除显在改动面板由用户自行提交，后端摘要与前端确认框均提示。前端：项目导航右键菜单在「移除注册」与「删除项目目录…」之间加红色项，确认框写清三档命运（文件夹与用户文件保留 / .ccode 入回收站 / 工作区与注册彻底删）；至此三档 = 移除注册（只摘登记）/ 清除痕迹（回未建项目状态）/ 删除目录（连文件夹入回收站）。 |
| v3.66 | **开工确认弹层实测修复批（四件）**：① 勾选区来源范围 bug——`briefSourcesForStep` 原只按 `card.step === stepName` 精确匹配，未挂步骤卡（step=null）与步骤改名后失效的卡永远落选，且来源为空时整个区域不渲染；修复：范围 = 本步骤卡 + 未挂步骤/失效步骤卡（与 bucketCardsByStep 的「未挂步骤」桶同口径），空来源也渲染引导语「还没有定稿简报——对话页 ◈ 提炼接力定稿后会自动钉到卡片」。② 步骤级只读预览：任务卡桶头部「预览 TASK.md」（无卡无工作区也可预览），走 `buildTaskMdPreview`（gatherTaskMdExtras + readTaskBriefs + renderTaskMd 同一出处）。③ **想法期只读保护（软硬两道 + 可切换）**：软 = 聊想法预填指令带「只讨论不动文件」约束；硬 = `AgentSpec.readonly_args` 注册表 + `agents::readonly_launch_args`（codex 剔除 `-s workspace-write` 再追加 `-s read-only`，重复 -s 生效顺序未文档化不赌）→ `PendingTerminal.readonly` → pty_spawn 注入（仅全新会话）。支持矩阵（2026-08-12 本机 --help 实测，录入 matrix 跨 agent 共性结论 §6）：claude/codebuddy `--permission-mode plan`、codex `-s read-only`、gemini `--approval-mode plan`、kimi/cursor `--plan` 为硬保护，qwen 0.21.1 与 opencode 只有软约束。**用户拍板不焊死**：settings.json `discussReadonly`（默认开）由卡片区标题行就地开关（设置页不加行），卡片 ⋯「聊想法（允许改文件）」为单次豁免（开关关时不渲染）。④ **TASK.md 从拼接升级为融合**：弹层预览区改可编辑（状态机 `taskMdEditorReduce`，dirty 后重拼不覆盖人编辑/融合稿，可「恢复默认拼装」），「◈ 融合为连贯 TASK.md」→ `ai_fuse_task_md`（模板简报为主干、卡片思想融入对应段落、去重复与过程性描述、已否决方向保留为约束、冲突显式列出、提货单段由 Rust 按 renderTaskMd 同款格式渲染并要求 AI 逐字照抄到结尾；功能键复用 digest，脱敏不落盘）→ 确认开工落盘 = 编辑区最终内容（`startPipelineStep.taskMdOverride`，写盘仍 write_workspace_task_md 单一路径）。 |
| v3.67 | **文献检索第二层（人肉中转）+ 步骤技能区前置到预览界面**：① lit-search 技能扩写（include_str! 内嵌种子，只影响新播种不覆盖用户副本）——「外部 AI 检索站导出导入」节（Elicit/Undermind/X-MOL/Scholar 网页端导出 RIS/BibTeX/CSV → `papers/imports/`（来源-日期命名）→ Agent 解析去重合并进 screening.md 与 references.bib，DOI 优先标题模糊兜底，保留来源标注，原档备查不删）+「带 key 的 API 检索」节（WoS `$WOS_API_KEY`、Consensus `$CONSENSUS_API_KEY`、Scholar 走 OpenAlex/S2 替代或 SerpAPI `$SERPAPI_KEY`，curl 示例 key 全走环境变量）。② **MCP 预设不造机制**：MCP 页无预设/模板机制，不为三个条目新建预设系统——推荐配置（Consensus hosted MCP `https://mcp.consensus.app/mcp`（实测 401 鉴权在，HTTP 传输，以官方文档为准）+ Playwright `npx @playwright/mcp@latest`（官方仓库核实））写进 lit-search 技能「推荐 MCP」节，用户去 MCP 页走既有粘贴导入（含安全清单确认）；Semantic Scholar 无权威社区 MCP 不加，用官方 REST API 替代。③ **步骤技能区进预览界面**：`StepSkillsChips` 共享组件——步骤级「预览 TASK.md」弹层只读（chip 点击展开一句话描述），开工确认弹层可编辑（× 移除 + ＋ 下拉添加）；增删经新 command `update_step_skills(project_root, step_name, skills)`（项目门槛 + 步骤存在校验 + 读-改-原子写 project.toml，不走整份 write_project_config 往返）**写回步骤定义**（影响以后所有开工），成功后重读档案卡同步弹层与父级 cfg，TASK.md 预览即时联动。 |

| v3.68 | **人工事项（人机分工清单）+ agent 人工请求 + 收件箱分类胶囊**：① 步骤获一等属性 `[[steps.human_tasks]]`（title/guidance/target/timing=before·during·after），引擎不识语义（科研语义只进模板），编辑唯一入口 PipelineEditor，五套内置模板补齐声明（guidance 只告知渠道选项不替用户选择）。**状态派生无状态机**：done = 手动勾选（app.db `human_task_checks`，行在=人勾了）|| 落点检测（`human_target_hit`：目录递归限量/「目录/通配」末段通配/精确文件；检测根 = 项目根 + 绑定工作区工作树），**手动优先**——勾了系统不再追问，取消删行回到检测口径。提交交付 = `import_human_deliverable`（复制进落点 + best-effort 登记提货单 produced_by=人工交付，登记失败不否决复制），入口 = 卡片 checklist 行「提交产物」/ 拖拽文件到行。三触点告知全部只提醒不阻断：开工弹层人工事项区（before 档未完成警告色提示仍要开始也可以）、卡片行 badge「N 件事等你做」+ 展开 checklist（共享 `HumanTasksList`）、评审可信度行「收尾事项 N 件待做」（仅 after 档）。② **agent 动态人工请求**：约定文件 `.ccode/help-wanted.md`（工作树/主仓），每条必带兜底句「若未回复则按 ×× 继续」，**统一非阻断**（否决阻断式请求——agent 写完按兜底继续，偏差靠评审兜底）；`list_help_requests` 扫活跃工作区 + 主仓 → 收件箱「人工请求」类（可 ✕ dismiss，localStorage 签名口径，内容变自动复现；新来源 edge-trigger + 30s 去抖 OS 通知，复用「长任务 OS 通知」开关不新增设置项）；TASK.md 在步骤有人工事项时自动带该约定说明。③ **收件箱分类胶囊**：单一「待你处理 N」拆为按类别胶囊（点胶囊展开该类条目），类别推导/分组纯逻辑 `src/inbox.ts`（key 前缀即类别，未知前缀回落待确认防静默丢失）。④ **待拍板问题零新存储**：简报 `## 待拍板` 小节在卡片展开态渲染成列表（`extractOpenQuestions`），点了带问题去聊想法（沿用只读保护）；讨论在终端、结论靠提炼定稿钉卡，卡片只做索引。演示课题第一步预置两条人工事项（补充已知文献 before / 下载付费墙文献 after）。**否决项**：卡片不内置产物清单（ArtifactChecklist 已有，不重复造）；不内嵌浏览器/不做文献库（v3.9 口径延续）；人工事项不给独立状态机。 |


| v3.69 | **人工事项迁到步骤级 + 讨论种子 + 当前步骤条**（v3.68 上线后用户走查修正「乱」）：① **人工事项是步骤级不是卡片级**——卡片是想法容器，一步多卡时步骤级清单在每张卡重复渲染属挂错层；卡片展开与卡片行 badge 中的人工事项全部移除，步骤级唯一展示位 = 步骤 ⋯「人工事项（N 件待做）」展开的 strip 下手风琴（与产物核验同位单开，共享 `HumanTasksList`）；开工弹层与评审收尾提醒两触点保留不动。卡片回归纯净：展开只剩待拍板 + 简报。② **讨论种子（`discussion_seeds`）**——「卡片里聊什么不该靠用户凭空想」：模板按步骤预置开工前建议想清楚的拍板点（与人工事项分工 = 种子「要商量的」/ 人工事项「要动手做的」），卡片区步骤桶内「开工前聊聊：」chips 点击即聊（以问题为名自动建卡、同名续聊、只读保护照走），手动「＋ 添加想法」保留为种子覆盖不到的口子；纯执行步骤不给种子；种子不进 TASK.md（给人的入口，不是给 agent 的合同）。③ **当前步骤条**（步进器下方一行）=「现在该干嘛」的单一答案：第一个未完成步骤的白话状态 + 「等你做 N 件」（点击展开人工事项）+ 唯一主按钮（待开始=开始 / 待评审=去评审 / 阻塞=去处理冲突 / 进行中=去终端；评审类直达评审覆盖层不绕终端）；全部完成则不渲染，保持安静。演示课题第一步预置 3 条种子 + 既有 2 条人工事项。 |

| v3.70 | **大圆 = 步骤聚焦（删终端入口）+ 顺序引导情境化**（用户走查拍板：圆的跳终端/开步语义删除，界面信息按步骤收敛）：① 点大圆 = 卡片区只看该步骤（种子 + 卡片 + 人工事项清单一屏内），选中圆中性高亮环，未选过默认聚焦当前步骤，「显示全部步骤」还原；推进动作归位——开步=当前步骤条/卡片行「开始」，跳终端=当前步骤条「去终端」/任务行，恢复已归档=任务行；步骤 ⋯「人工事项」从 strip 下手风琴改为同效聚焦入口。② 当前步骤条情境化（顺序引导 A 案）：待开始按本步骤是否有定稿简报分「建议先点下方种子聊聊」/「想法已就位，可以开始」；应用模板成功给一次性引导带（可关，组件态不持久化）指向第 1 步种子。③ 术语：界面与用户手册「流水线」→「研究流程」（科研视角），代码标识符与开发文档沿用 pipeline——映射说明见 conventions/pipeline.md 文头；课题主题两入口（注册弹窗/模板区）合一：模板区回显同一字段，消除"第三样东西"错觉。 |

| v3.71 | **步骤内协同流程线（StepFlow）**：用户直指「元素堆一块、没有可视化流程」——聚焦视图顶部新增有序节点链：讨论种子 → before 人工事项 → agent 执行 → during 人工事项（并行段）→ after 人工事项 → 评审合并；当前节点 = 第一个未完成（高亮 + 就地操作区：种子 chips/提交产物/开始/去终端/去评审），回答「谁先谁后、轮到谁、在哪操作」。纯逻辑 `src/step-flow.ts`（buildStepFlow；runStatus 四态由 ProjectGroup 从 deriveStepStatus 映射，blocked 并入 review）；人工事项状态/勾选/交付/拖拽逻辑抽 `useHumanTasks`（HumanTasksList 导出）供平铺清单（开工弹层）与流程线共用。时机语义按用户拍板排序：聊想法 → 补已知文献（before）→ agent 检索 → 补付费文献（after）。 |

| v3.72 | **任务书草稿：拆除「讨论→合同」中间层**（用户第一性原理追问：想法既然服务于 TASK.md，就该直接在 agent 里聊、直接改它）：每步骤一份 `.ccode/drafts/<workspace_name>.md`（项目根、随 .ccode 进 git；路径单一出处 `draft_rel_path`）。聊任务书 = 非只读启动 + 指令约束只许写草稿文件（种子点击同口径，仍建卡归档）；开工弹层草稿优先于模板拼装（编辑区初始 = 草稿，「恢复默认拼装」可回）；评审「沉淀到下一步」从钉卡改为 `append_step_draft` 追加进下一步草稿。简报/钉卡/◈ 提炼机制保留（长会话接力场景仍成立）但撤出主路径；卡片退位为纯对话归档夹。流程线 discuss 节点改名「任务书」（完成口径 = 草稿已起草 || 有定稿简报，兼容旧项目），节点内嵌「跟 Agent 聊任务书」+「预览/编辑草稿」+ 种子；agent 节点内嵌「预览 TASK.md」。 |

| v3.73 | **工作区页信息架构重组：删「当前步骤条」**（用户拍板：当前步骤被步骤条/流程线/桶头三层重复表达，「等你做 N 件」「显示全部步骤」点击无感）：① 步骤条整段删除，功能不丢——状态短语并入**聚焦头部**（步骤名 + describeStep 白话状态 + 右侧「总览全部步骤」），主推进入口并入流程线节点：开始/恢复工作区（归档时替代开始）在 agent 节点、去评审/去处理冲突（带 resolve-conflict 意图）在评审节点、去终端看看在 agent 节点进行中态。② 「等你做」从计数按钮改为**流程线 human 节点橙点**（口径仍是 `actionableHumanTasks`：after 档 agent 完成前不计；ProjectGroup 算好标题列表经 props 传入），点橙点 scrollIntoView 定位 + 1.5s 高亮。③ 「总览全部步骤」真切换：总览态桶强制展开，无卡无种子桶占位「该步骤还没开始」；聚焦态桶头去重（步骤名/预览 TASK.md 不重复，**预览 TASK.md 全页唯一入口 = agent 节点**）。④ 工作区列表跟随聚焦步骤过滤（归属 = `steps[].workspaceName` === 工作区名；ProjectGroup children 改 render prop 回传 focusStepName/steps/showAll/onToggleShowAll），标题「{步骤名} · 工作区（N）」+「全部/按步骤」切换，空态区分「该步骤还没有」与「项目还没有」。大圆步进器 strip 一行未动（硬约束）。 |

| v3.74 | **资源提醒时机 + papers/imports/ 人肉中转入口**（用户拍板：资源发现不做全局 banner，只在两个决策点出现；闭源检索站导出靠人搬）：① **开工确认弹层资源提醒**：打开弹层时 `discover_resources` 只读扫描一次，有未登记候选才在简报勾选区下方出小节（默认不勾选不打扰），「登记选中」= resources 数组整体写回 project.toml（与资源面板同一口径），成功后小节消失。② **人工交付导入后的登记追问**：交付落在项目根时提示「要登记为项目资源吗 [登记]」（工作区落点不追问——临时目录登记没意义），关掉不纠缠。③ **「导入检索结果」两入口**：StepFlow 落点在 `papers/` 的人工节点旁 + 资源面板「发现资源」旁；`import_human_deliverable` 最小扩展（`step`/`title` 转可选 + 新增 `target_override`）：无步骤语境 = 纯导入落主仓 `papers/imports/`、不登记提货单；lit-search 协议 = agent 开工时自动解析、去重、合并进筛选清单；文件命名「来源-日期」只在 title 里提示，不强制。 |

| v3.64 | **内置技能种子机制落地**（backlog 项提前，用户拍板）：14 个内置技能（原 9 个本机技能补强 + 新内化 5 个：rebuttal-crafter 返修回复 / stats-check 统计审查 / figure-forge 投稿级出图 / slides-deck 汇报幻灯片 / proposal-writer 开题基金），内容经 16 个外部技能仓库调研后按 Ccode 工作流中文重写（MIT/Apache 源可借鉴并致谢，无许可/CC BY-NC 源只借机制不取内容）；补强点 = bib-check 可选外部元数据核验（Crossref/arXiv）、data-eda 统计结论先过 stats-check、lit-search 多库检索清单。机制见 §6.13：include_str! 内嵌 + 版本 marker 幂等播种、不覆盖用户同名技能、不复活用户已删技能。五套流水线模板按步骤挂载技能（简报同步「（按 X 技能）」口径）；技能页来源列新增「内置」标签 |

| v3.75 | **定时雷达（每日/每周自动巡检）+ lit-watch 技能升级**：① **lit-watch 多源精选化**（对照 xuezheng627/daily-literature-digest 等外部技能后补强）：检索从「arXiv API + WebSearch 兜底」升级为 arXiv/OpenAlex/Crossref 三路官方 API 确定性检索（web 仅订阅行显式声明才用、标低置信）；DOI 优先跨源去重合并；新增精选档——新命中按「标题命中 > 摘要命中 > 主题相关」排序取 Top 3–5 标「推荐」，条目相关性三档（推荐/相关/待确认）；无摘要/付费墙进 `papers/watch-followup.md` 跟进队列；订阅行备注 `+bib` 时推荐条目生成 BibTeX 追加 references.bib（替代 Zotero 的原生口径）；watchlist 来源列支持 `arxiv,openalex` 多选与窗口备注。**不抄的**：Gmail 推送（走收件箱+OS 通知）、静态 HTML 文献库（Ccode 自身即工作台）、config.json 替代 watchlist.md。② **调度器 `scheduler.rs`**：app 级 `schedules.json`（config_dir/ccode/，原子写 + 进程内锁），任务 = 项目根 + 技能 + profile（可空走自动回落）+ 每日/每周+时分（本地时区，不引 cron 表达式）；60s tick 判定 due（「最近应跑时刻 > last_run」），**启动补跑天然覆盖睡眠漏跑、多次漏跑 coalesce 只补一次**；执行复用 ai.rs 无头链路（`run_agent_task`：resolve_binary + 拉起瞬间 get_key 注入 + launch_plan + background_command），唯二差异 = cwd 用按任务生成的隔离 worktree（项目根只用于归属，token 仍归因给项目）与 `headless_task_args`（codex 用 `-s workspace-write`，只读跑不了巡检）；10 分钟超时、历史留 20 条、简报/错误出站前 redact_sensitive_text；跑完发 `scheduler-run-done` 事件 → App.tsx 全局监听弹 OS 通知（复用 notificationsEnabled 开关不新增设置项）。③ UI = 工作区页项目分组「◔ 定时任务」区块（ScheduleSection）：列表/启停/立即跑/历史/删除 + 新建弹层；**不做独立「任务中心」页**（任务必绑项目，全局页是过早抽象）。风险遗留：各家 CLI 无头模式的写权限/工具放行行为未经全量实测（matrix 无记录），qwen 无头参数为位置参数兜底——首批用户验证后按 matrix 校准。 |

| v3.76 | **内置技能更新检测 + 一键更新**（播种器「永不覆盖」的配套出口：种子后续增强时老用户库内旧副本永远拿不到更新，本批治本）：`check_builtin_skill_updates` 库内 SKILL.md 与 include_str! 种子**逐字节比对**，只提示 skills.json 里 source == "builtin" 的项（同名用户自建不算；用户在内置技能上的自改照样提示，更不换由人拍板），库目录缺失/读失败跳过（缺失归播种器管）；`apply_builtin_skill_update` 校验名在内置表 → 原文件备份为同目录 `SKILL.md.bak-<yyyymmdd>`（同日重名追加 -2/-3）→ 种子内容原子写入（复用 profiles::atomic_write）→ skills.json 描述按新文件重解析。UI = 技能页顶部提示条（PageHeader 下方，bg-inset）：列出待更新技能名 + 逐个「更新」按钮，成功移出提示条并刷新列表、失败行内报错；检测 best-effort 失败静默。 |

| v3.77 | **任务书沉淀统一走草稿：砍掉「提炼定稿 → 钉卡 → 开工勾选/融合」中间层**（v3.72 主路径切换的收尾，中间层残留整体拆除）：① 后端删 `save_task_brief`/`attach_brief_to_card`/`ai_fuse_briefs`/`ai_fuse_task_md` 四命令，TaskCardDto 去 briefs 字段；旧 project.toml 的 `briefs = [...]` 解析忽略、写回丢弃，旧 `.ccode/brief-*.md` 文件留盘不删。② 结论单一出口 = 步骤草稿 `.ccode/drafts/<步骤>.md`：种子/自定义话题/挂步骤卡片的「聊想法」全部走草稿口径（非只读、指令约束只许动草稿这一个文件）；未挂步骤卡片维持只读纯聊归档（「想法期只读保护」开关只服务这一路）。③ **开聊自动带开草稿预览**：种子/话题/「聊任务书」进终端时自动在右侧打开草稿预览（FilePreviewEditor 目录监听外部变化自动重载，agent 写入实时可见；想法期无工作树，讨论与草稿都在项目根）。④ 待拍板问题数据源从简报换草稿：`extractOpenQuestions` 从草稿文本提取「## 待拍板」，卡片展开按需读草稿，讨论指令要求 agent 把未定问题记进该小节；discuss 完成口径收为纯草稿（hasDraft）。⑤ 开工确认弹层：删简报勾选区与「◈ 融合所选简报」「◈ 融合为连贯 TASK.md」两按钮，编辑区保持草稿优先；无草稿且存在旧简报时显示一行提示 +「并入草稿」（`list_legacy_briefs` + `append_step_draft`，一次性兜底不恢复勾选区）；技能区加归处标记——SkillDto 新增 `mentionsMcp`，含「推荐 MCP」的技能显示标记并可跳 MCP 页。⑥ **DigestPicker 单页化**：AI 初稿就绪后同页「初稿编辑框 + 发送目标列表」，不再强制两段定稿；点目标直接发送（零改动用 AI 初稿 handoff-*.md；有改动先 `finalize_digest_brief` 写回——校验 `.ccode/` 内 + `handoff-` 前缀 + `redact_and_cap` + atomic_write——再发）；「暂不发送」= 有改动才落盘 + 关闭；不再有「钉入任务卡」；三条发送路径（内部新会话/⧉ 复制外部命令/⇗ 外部终端）与收件箱「待发送」胶囊不变。⑦ 卡片回归纯归档（claim 认领 + 按卡分组 + 开工入口，不再有简报 meta/简报列表），示例课题播种改播示范草稿。 |

| v3.78 | **五套内置流水线模板内容重设计 + 模板接壤 + 「从模板追加」**：① **模板内容重设计**（src/pipeline-presets.ts）：准绳 =「讨论种子 → 草稿 → TASK.md → 执行」全链相辅相成——种子逐条对准 TASK.md/执行中的真实拍板点（删空洞种子、补缺口种子；纯执行步骤不给种子，沿用 v3.69 口径）；简报坚持输入/决策/交付写死，expectedArtifacts 精确化；技能挂载按当时已注册的内置技能核对（research-paper 首步 +lit-notes、结果分析/毕业论文实验步 +stats-check、毕业论文初稿/定稿 +quarto-render、data-eda 步 +stats-check；submission-rebuttal 摘除不存在的假技能 pre-submission-reviewer，投稿前自查口径内联进简报）；MCP 归处——lit-search 链路步骤新增 before 人工事项「（可选）配置学术检索 MCP」（MCP 页预设导入 Consensus/Undermind，key 走环境变量引用；不配也能跑：OpenAlex/Semantic Scholar 免 key 兜底），付费墙文献全程有人工事项接应（落点 `papers/*.pdf`）。② **模板接壤**：五套 = 同一条科研流水线的相邻段，产物路径固定对齐——综述末步产 `manuscript/review-final.md`、科研论文末步产 `manuscript/paper-final.md`，投稿与返修首步输入精确指向两者 + `references.bib`；综述的 `notes/`+`references.bib` 可被科研论文/毕业论文首步复用，数据处理的 `analysis/` 可接科研论文实验段；每套模板首步简报带双口径输入说明（接自上游随仓库合并自带 / 独立启动先放入对应目录或资源面板绑定上游项目目录），投稿与返修首步另有 before 人工事项「放入成稿与 references.bib」（落点 `manuscript/`）。③ **「＋ 从模板追加」**（PipelineEditor 工具区「+ 添加步骤」旁）：区别于「使用模板 = 整体替换 steps」，把选定模板（内置五套 + 用户另存）的步骤追加到当前项目 steps 末尾——步骤链/提货单/资源机制对新步骤天然生效；后端新 command `append_pipeline_steps`（projects.rs：`ensure_task_project_root` 写门槛；读-改-原子写；name 或非空 workspace_name 重名跳过——撞已有步骤或撞本批次刚追加的都跳过，避免覆盖已有工作区绑定；全跳过不落盘、空批次拒绝；返回 `{appended, skipped}` 供行内提示「已追加 N 步；跳过 N 步（同名）」）；追加直接写盘不经编辑器未保存草稿（dirty 先弹确认），成功后前端重读 `read_project_config` 刷新步骤卡与脏检查基准（`onConfigReload` 回推父组件）。典型用法：科研论文写完 → 追加「投稿与返修」三步 → 同一项目续走。 |
| v3.79 | **技能挂载产物冲突检测**：技能内容是 markdown 指导文件，内容级「职责重叠」无法自动判定，但产物路径相撞可检测——14 个内置技能 SKILL.md frontmatter 新增 `outputs` 声明（YAML 行内/多行列表均容忍，目录带尾斜杠、文件写全路径，只声明会写的主要产物；老用户库内旧副本经既有 check_builtin_skill_updates 逐字节比对检出、走一键更新）；`parse_skill_md` 扩展解析 outputs 进 `SkillDto.outputs`（list 时现算不入库，compose_skill_md 不写——自建技能不参与）；前端纯逻辑 `src/skill-conflicts.ts`（skillOutputConflicts：两两比对，路径相同或互为目录前缀即相交，同一对技能多处相交只报一次）；StepSkillsChips 加可选 `skillLib` prop，有冲突时 chips 下方逐行 ⚠ 提示「确认步骤简报里写明了分工」——只提醒不拦截，只读/可编辑两态都显示（KickoffConfirmDialog/TaskCardsSection 两处调用方传入）。 |
| v3.80 | **接入第九个 agent Grok Build**（xAI 官方终端编码 agent，xai-org/grok-build 源码调研 2026-08，标注「待实机验证」处未经实机核对，matrix §9）：纯 env 注入三件套（`XAI_API_KEY` / `GROK_CLI_CHAT_PROXY_BASE_URL`（CLI chat 代理端点覆盖，作第三方端点注入通道**待实机验证**）/ `GROK_DEFAULT_MODEL`），归 OpenAI 兼容族（官方端点 https://api.x.ai/v1，presets 设官方预设行；`[model.*]` 的 `api_backend` 另支持 responses/messages）。官方账号 `grok login`（OAuth，凭证 `~/.grok/auth.json`，拉起 env_remove 两个 XAI key 变量；TOML 配置无冲突探测，detection_note 写明）。会话 `~/.grok/sessions/<url编码cwd>/<uuidv7>/`：`updates.jsonl` 为权威日志（ACP session/update 通知流，防御式解析跳过未知类型），`summary.json` 供 meta（info.cwd 比解码目录名可靠）；`session_search.sqlite` 只是 FTS 索引，扫描只收文件名恰为 `updates.jsonl` 的。usage 从 updates 内 `_meta.usage`（`params._meta` 与 `params.update._meta` 两层兼容探测）。聊想法只读 = `--permission-mode dontAsk --sandbox read-only`（`--permission-mode plan` 门控链路未确认不用）。headless `-p`（不读 stdin，prompt 走参数），scheduler 任务追加 `--yolo`（headless 默认权限行为未确认，防请求被 Cancelled 静默失败，照 codex `-s workspace-write` 先例）。**两个首版不做**：「设为全局默认」显式不支持（config.toml 是 `[model.<name>]` 段结构且默认模型指针机制未确认，学 cursor 落到显式报错）；MCP 只读清单不分发（`[mcp_servers.*]` TOML 段与 model/hooks 同文件属高危混合状态文件，且 grok 自带 `grok mcp add` 做读改写，不硬造 TOML 原子写管线；前端 `MCP_DISTRIBUTE_UNSUPPORTED` 显示「只读」）。技能 `~/.grok/skills` 强制 copy（未实机验证，仿 cursor，`allow_symlink_for` 改集合判断）。安装走官方脚本（`~/.grok/bin` 进 resolve_binary 三平台候选）/ npm `@xai-official/grok`，更新自更新 `grok update` 优先。matrix 重编号：MCP 调研节 §9→§10（Grok 占 §9），代码与文档全部引用同步 |
| v3.81 | **浅色主题 diff 铺底修复 + 改动面板文件类型徽标**：① diff 增删行从复用 `bg-ok/bg-err`（深底浅字 pill 口径）拆出专用令牌 `--color-diff-add-bg/fg`、`--color-diff-del-bg/fg`（App.css @theme；深色主题值不变），`[data-theme$="-light"]` 统一覆写为 GitHub 式浅底深字（add #d9f2e2/#177245、del #fbe3e6/#b02a42）——ok/err 深底整行铺在浅底上会显黑（用户反馈）。改动面板 `diffLineClass` 与审阅视图 `DiffSide` 同换新令牌（审阅行 fg 从 text-add/del 并入，深色下略有加深，口径统一）；状态字母 pill 等小块用法不动。② 改动面板文件名前加**文件类型小徽标**（`src/file-icons.ts` 纯逻辑：扩展名 → 短标签 + 固定识别色不随主题，未收录类型留空槽位对齐；GitPanel 全宽行与紧凑行均接入，tests/file-icons.test.ts） |
| v3.82 | **改动面板改跟左栏文件树的根**（用户拍板：原「跟随聚焦终端标签 cwd」口径下，工作区页点了项目但终端标签停在别处（典型：停在已归档工作区的死路径）时面板错位显示「不是 git 仓库」，心智负担大）：FileTree 新增 `onRootNavigated` 回调（nav 与 cwd 同步两个 setRoot 出口都上报，与 onRootChange 守卫配对只在真切换后触发）；TerminalPage 记 `treeRoot`，GitPanel 改吃 `treeRoot ?? activeCwd`；activeCwd 变化时 TerminalPage 主动清空 treeRoot 兜底（专注终端等树未挂载场景无人上报）。对话页签与文件预览口径不动。配套：git_status_sync 对不存在的目录先报「目录不存在（可能已被归档或删除）」（与误判「不是仓库」区分，含 Rust 测试） |
| v3.83 | **标签条变更芯片（Codex 式）+ 隐藏 GitPanel 实例保轮询**：用户诉求「不用点进改动页再保存」——标签条右侧（可合并 pill 前）新增变更芯片：`⑂ 分支 +N -M`（仅 isRepo 且有未提交改动时出现），点数字打开「改动」页签，「✓ 保存」全量快速提交（defaultCommitMessage 本地生成说明；工作区视图 paths=null，与面板留空「快速保存到历史」同口径；行内 保存中/已保存/失败 2.5s 复位）。GitPanel `onTotals` 从 `{add,del}` 扩展为 `GitSummary`（+isRepo/branch/inWorkspace/files），TerminalPage 侧按内容签名比较免空转重渲染。**关键配套**：右栏关闭/专注终端时改动面板随右栏整体卸载、8s 轮询停止，芯片会无数据——故在 TerminalPage 挂 display:none 的隐藏 GitPanel 实例持续轮询（与右栏内实例按 `(!rightOpen || focusMode)` 互斥），页签 +N 徽标顺带也变成常驻准确 |
| v3.84 | **删流程线「等你做」行内标签**（用户拍板）：human 节点旁的醒目色「等你做」标签与整条 props 链（ProjectGroup `focusHumanPending` → TaskCardsSection → StepFlow `humanPending`）连同 `actionableHumanTasks` 纯逻辑与测试一并移除。人工事项告知触点收敛为两处（开工确认弹层 / 评审可信度行「收尾事项 N 件待做」）；流程线 human 节点只保留勾选框、落点操作与「← 当前」高亮，步骤 ⋯「人工事项（N 件待做）」计数口径（`pendingHumanTasks`）不动。 |
| v3.85 | **浅色补完 + 去线条化（全站优化第 1 批）**：① **终端 ANSI 调色板深浅成对**——v3.44 上了七套浅色主题，但四套 ANSI 预设全是深色向的，`buildXtermTheme` 把它们直接铺在近白底上：`white #e5e5e5` 对比度 ≈1.05:1、`brightWhite #ffffff` 全隐形、`yellow #e5e510` ≈1.4:1，加上写死的 `cursor #aeafad`（≈1.9:1）与 `selectionBackground #264f78`（深底压深字，选中即不可读）——即用户报的「浅色模式下终端字体显示不清楚」。代码原注释让用户「去设置页另选调色板」，但根本没有浅色调色板可选。新增四套 twin（light-plus / solarized-light / one-light / latte，取各家官方浅色板，仅对近白底上 <1.5:1 的槽位加深并注明），`cursor`/`selectionBackground` 从写死改为入表；`resolvePaletteId(paletteId, isLightTheme(themeId))` 按主题亮暗解析、不符自动换 twin，设置页只列匹配当前亮暗的四套并在自动切换时给一行说明。**三处同步点**：`PALETTE_LIST` ↔ `settings.rs KNOWN_PALETTES`（原白名单只认四套深色，漏改会让新调色板被静默丢弃）↔ `XTERM_BG_FG`；主题亮暗判定收敛为 `themes.ts isLightTheme()` 单一出处。顺带修掉 `mocha-light` 主题 App chrome 早已用官方 Latte、终端却仍是 Mocha 深色的不一致。② **浅色语义色令牌补齐**——`[data-theme$="-light"]` 原先只覆写 hover 与 diff 四色，`--color-ok/err/warn`（`#10331f`/`#381e24`/`#37300f`）保持深底口径，导致全站 69 处 `bg-ok/bg-err/bg-warn` 在浅色下是白页上的深色块（与 v3.81 已为 diff 行做过的浅底深字修正自相矛盾）；补 ok/err/warn/add/del 八个令牌为浅底深字，组件零改动。**确立 `--color-*` 只作 pill 底色、`--color-*-text` 供 pill 文字与一切实心圆点/圆形使用的硬分工**，并据此修掉三处误用底色档铺实心形状（步进器 blocked 大圆、大圆注意力角标、任务卡主仓改动点——浅色下是浅黄铺在近白 canvas 上，等于消失；且同为实心圆的 done 本就用 `-text` 档，原先自相矛盾）。`.ccode-float-surface` 的白色内高光在白底不可见，浅色改为极淡内暗边 + `0 0 0 0.5px` 外描线（零偏移零模糊，不违反零阴影）。③ **去线条化**（用户反馈「工作区界面有点线条化」）——v3.35/v3.37 拆掉描边与横线后变成一堆等高细条，反而更像线；确立三条规则：同屏最多 2 条横向带（工作区页只留大圆步进器带）、页面级对象列表用卡片 + 卡间留白（禁 `divide-y`）而块内密集行用 `space-y` + hover 高亮、块间用 ≥16px 留白且禁画分隔横线。落地：工作区列表 `divide-y` 细行改 `bg-strip` 卡片（卡内状态 pill 顺势升到 `bg-raised`——用 inset 做卡会让 pill 无处可去，浅色主题 inset/raised 已接近纯白），项目身份行与端口折叠区标题的横线拆除，任务卡/想法卡/定时任务三处行分隔线改留白。④ 新增**跨页视觉三原则**（同权重元素 ≤5 必分级 / 一屏容器边界 ≤4 / 每屏一个「现在该干嘛」的答案），后续每批 UI 改动自查。⑤ **实机截图走查补两处**（用户给浅色主题截图）：**开关渲染成白底黑疙瘩**——`Toggle` 滑块用 `bg-l1`、轨道用 `bg-inset`，浅色主题下 l1 是近黑 `#171a26`、inset 是近白，滑块与轨道明暗全反；改走专用令牌 `--color-switch-off`/`--color-switch-knob`（深色值保持原样、外观不变，浅色为白滑块 + 可见灰轨道）。**七套浅色浮起阶梯塌陷**——`canvas→strip→inset→raised` 实测亮度差只有 1–4（ayu/shadcn 最差到 0.9），已直接违反本文档「strip/inset/raised 三级梯度七套主题必须可分辨」，表现为整页发平、③ 新做的卡片与页面底糊在一起；浅色「浮起 = 更亮」在 raised = 白处到顶，只能靠压深 canvas 换空间，故按「从白往下每档降约 4.5 亮度」统一重排七套（保各主题色相；midnight 家族随 v3.48 去蓝一并转暖；mocha-light 不再照搬 Latte 官方 base/mantle/crust——那套是「越深越低」，方向相反）。同批把梯度步进、浮起次序、选中/线条深度、语义色浅底深字 + WCAG AA、开关明暗写成可执行断言 `tests/theme-contrast.test.ts`（直接解析 App.css），把原先只存在于文档里的口径变成会失败的测试。 |
| v3.86 | **工作区与项目管理（全站优化第 2 批）**：① **项目详情页固定三段**——身份段 / 流程段 / 工作段，段间只用留白。核心是新增**「当前步骤卡」**：v3.73 删掉「当前步骤条」后，「现在该干嘛」被摊薄到聚焦头（白话状态）、大圆步进器（状态色）、流程线（动作）三条独立细带上，信息都在但没有一处给出单一答案——这正是「详情页不够清楚」与「线条化」的共同来源。现在聚焦头与 `StepFlow` 并进同一张 `bg-inset` 卡（`StepFlow` 加 `bare` 去掉自带底色由外层承载，卡内再浮一层改 `bg-raised`）；**大圆步进器规格一行未动**（用户明确要求保留）。身份段项目名提到 16px semibold，课题主题为空时给可点占位。② **步骤字段激进精简 + 高级折叠**——一个步骤 10 个可编辑字段、一屏放不下一张卡；常驻收到 4 项（步骤名 / 简报 / 预期产物 / 推荐技能，即决定 TASK.md 全部内容的合同本体），其余分「人机分工」（人工事项 · 决策项 · 讨论种子，按 v3.69「要商量的 / 要动手做的」同源归组）与「高级」（工作区名 · run 脚本 · 资源绑定）两折叠区；**字段一个不删**，折叠区标题带「已填 N 项」且已填默认展开。推荐技能补进编辑器（复用 `StepSkillsChips` 可编辑态）。**顺带修一处静默数据丢失**：`toStep` 漏传 `humanTasks[].optional`，编辑器一保存就把内置模板标「不做也能跑」的事项升级为必办，同批补「可选」勾选框。③ **项目级配置收进「项目设置」右侧抽屉**（不是页面、不进侧栏、不占路由）：基本 / 研究流程 / 文献与数据 / 定时巡检四组，资源面板与 ScheduleSection 整体搬入——详情页少两条常驻带，项目 `⋯` 从八项收到四项（编辑研究流程 · 项目设置… · 历史 · 移除项目注册；清除痕迹与删除目录仍只在项目栏右键菜单，不做第二套删除入口）。**模板库实例随之住进抽屉**，所有打开模板库的入口必须连抽屉一起开。④ **全局「快速开聊」**（用户拍板）：侧栏「工作」组首位 + ⌘K 命令 → 弹层只问 agent/配置/目录 → 开标签并自动启动（新增 `PendingTerminal.autoStart`，无可用配置降级为只预填）。回答「进软件想随便聊聊」——原先所有入口都是项目/流程优先。明确不建项目/工作区、不写 `.ccode`、不注册、不落 TASK.md；默认落脚 `~/ccode/scratch`（新 command `ensure_scratch_dir` 只 create_dir_all，**不 git init**）。转正走终端标签 ⋯「转为项目…」= 仅 `register_project`，会话历史跟 cwd 走自动归属，无需迁移。⑤ **走查续批**：步骤卡折叠区默认值纠偏——原按「已填就展开」处理，但模板步骤个个都带 `workspace_name`（保存时自动派生的机械字段）与 `human_tasks`（模板内容），两档在每张卡上全是展开的，等于没折叠；改为**一律默认收起**，标题从含糊的「已填 N 项」换成真明细（如「人工事项 2 · 决策项 3」，空则「未设置」），「自定义工作区名」只在与派生值不同时才计入。**步骤 ⋯ 菜单 6 → 1~3 项**：删「人工事项」（`onSelect` 就是 `focusByIndex`，与点大圆完全同效，且「N 件待做」是 v3.84 已删的「等你做」计数的最后残留）、「复制工作区名」（近零频次）、「删除步骤」（结构性编辑归编辑器，破坏性动作不该紧挨大圆悬停即出）；「产物核验 / 定位目录」改为无工作区时**不渲染**而非禁用（原 6 项里常年 2 项是灰的）。菜单至此只剩非破坏性动作，并顺带清掉只为那条计数存在的 `list_human_task_states` 调用与 `humanStates` 状态（清单本体在 `useHumanTasks` 里自取自刷）。 |
| v3.87 | **「输入准备」独立成块：文献来源从四处收敛到一处**（用户实测提出：人工事项落点写 `papers/` 但 Zotero 导入不往那儿写，担心流程走不通）。查证结论先立此存照：`zotero_import` 是**只读适配器**——`references.bib` 写项目根、PDF **按绝对路径登记为资源且不复制**，这是 §11.3 机制一「资料只记位置不复制」的既定设计；人工事项落点检测根是「项目根 + 绑定的活跃工作树」，两个都查，所以 `papers/` 放项目文件夹是认的，**但 Zotero 路径本就不经过 `papers/`**，那条事项因此不会自动打勾。**流程不断**（TASK.md「项目资源」段带绝对路径、PDF 预览白名单含登记资源、`lit_source` 让检索步降级为盘点+查漏），是体验裂缝：模板 guidance 写着「到『文献与数据』导入即可」，暗示会自动完成，与行为矛盾——已改成明说「Zotero 导入不会进 papers/，导完手动勾一下」。**根因是同一个问题被问了四遍**（设置抽屉的文献来源开关、Zotero 导入按钮、决策项、人工事项）且互不通气。收敛方案：新增步骤级模板声明 `steps[].asks_lit_source`（引擎只透传；**评估过按 `skills` 含 `lit-search` 推断后否决**——隐式魔法，用户删个技能功能就没了），为真时流程线「定方向」出现「输入 · 文献从哪来」三选一 + **选中即就地出现导入按钮**；抽屉里只留只读回显与跳转指引，导入动作保留为二级入口。**与决策项刻意分块**（用户拍板「不是同一类」）：决策项答案写草稿、纯记录、答的是「这一步怎么做」；输入准备答案写 `config.lit_source`、带动作、答的是「输入从哪来」。`setLitSource` 由两档特判（「已是 zotero 就不降级」）改为三值显式。配套：`PipelineEditor` 的 `StepDraft` 透传新字段（漏传即为 `humanTasks[].optional` 同类静默丢失，已加 Rust 往返测试守住），「高级」折叠区给出开关。**同批走查续修三处（用户实测）**：①「刚喊完单一触点就自造第二处」——初版在流程线又摆了一套导入按钮，撤回为「去『文献与数据』导入 →」链接，**导入动作全局只此一处**，分工定为「输入准备管从哪来、文献与数据管有什么+进料」；② 冗余人工事项「补充你已知的关键文献」整条删除（与输入准备完全重合，且 `papers/` 落点对 Zotero 路径永不成立，是个打不上的勾；仅影响新建项目，存量 project.toml 需用户自行删）；③ 修 v3.85 引入的回归——新项目「已自动扫描到 N 个资源」反馈随「文献与数据」面板搬进抽屉后变成「在关着的抽屉里展开」，用户看不见，改为直接显示在详情页的新项目提示条上并带「查看 / 补充」直达。**编辑器补「改了会不会上流程线」说明**（用户第二问的落地）：展开「人机分工」写明三项都会成为流程线节点/定方向内容，展开「高级」写明均为幕后生效并提示改工作区名会让该步失去绑定。**Q1 正面修复（A 案，用户拍板）**：新增 `lit_library_hit`——`lit_source` 为 zotero/folder 时，登记资源中存在 PDF 类条目即视为 `papers/` 系落点满足，与落点文件检测、手动勾选三者取或；`search` 模式一字不变，非 `papers/` 落点不放宽，只有 bib/csv 不算全文到位。此前只删掉了矛盾最刺眼的那条事项（治标），剩余 4 条付费墙类事项无法删（真人工活）故必须正面修。同批修掉自己的漏删：示例课题 `demo_project_config` 里还有第二份「补充你已知的关键文献」且为必办，连同守它的断言一并更正。 |
| v3.88 | **全站优化收尾（批次 3/4/5/6 + 配置页缺口）**：① **模型切换可靠性**（真 bug 面）——抽 `src/model-switch.ts` 单一出处（能力表原本只活在配置页表单里），修四个成因：换 profile 静默清掉手填模型（`modelOnProfileSwitch`：手填值不在新表里则保留并提示「仍按原样注入」）、`models` 为空时后端完全不注入而界面无提示（`pty.rs` 的静默陷阱）、各 CLI 多模型能力差异只写在文档里（`launchModelNote` 挪到启动栏下拉）、手填模型零校验（失焦软提示不拦截——中转模型名千奇百怪）；保存配置后若该 agent 有标签在跑追加「要重开标签才生效」横幅。② **profile 的「启用/停用」按注入语义落地**——**不加 `enabled` 布尔**（会与「配置只在启动那一刻注入」打架，且和「设为全局」形成两套激活概念），改为 `settings.defaultProfiles`（每 agent 默认，启动栏预选顺序 默认 > 上次 > 首个）+ `settings.hiddenProfiles`（隐藏项沉到启动栏下拉「更多」optgroup 且预选跳过，不删数据不改行为）+ 行内「⌨ 在终端使用」（配置页原本没有任何通往终端的路）。③ **统计趋势线**：`UsageStatsDto.daily` 按天聚合（数据本就按天存），手绘 SVG 不引图表库。④ **终端标签条 13 类 → 5 类**：布局三开关（分屏/工作台/专注）合成分段控件，git 芯片/✓保存/可合并 pill 下移中带底部状态条（结果不是入口，v3.83 行为语义一字未改），`⋯` 改常驻并合并原先分散的两套菜单。⑤ **对话页筛选**：抽 `src/session-filter.ts`——一行 chip 快筛（保留/进行中/今天/近7天/内部/归档，这些维度早在 DTO 里却一个都没进 UI）+ 搜索给结构化建议落成可叠加 scope chip（同类取或、异类取与），取代手风琴三次钻取；补对话↔工作区双向链接（新增 `sessionScopeReq` 一次性请求）。⑥ **收件箱通用忽略**：`filterDismissed` 把 `help:` 独有的屏蔽推广到七类，签名变化即复现。⑦ **顶栏升为全局上下文栏**：左项目·步骤（`contextLabel` 镜像）+ 中 ⌘K 搜索 + 右运行数/收件箱；不冲突 v3.38（那条否决新增垂直占用，此处是利用 Overlay 模式已恒占且不可省的 40px）。⑧ 配置页缺口：gemini/cursor 的空预设下拉改为说明文案（`NO_PRESET_REASON`），grok 补 OpenAI 兼容端点预设。**走查后补齐**：顶栏中间的 ⌘K 假输入框**撤除**（用户否决「顶栏摆输入框不好看」，命令面板入口不设第二处）；对话行操作分级（⚑ 保留提行内、已保留时状态标记自身可点取消，⋯ 由 11 项平铺改「整理/继续/危险」三组，外部恢复两项并为「在外部继续 · 打开终端 / 复制命令」）；技能详情「哪些步骤在用」反查（纯前端扫已注册项目 `steps[].skills`，删技能前知道影响谁）；`mcp_distribution_status` 只读命令把后端早有的 `entry_modified_externally` 透到界面上（三态点：已写入/被外部改过/未开启——此前只在删除时用来拦假状态，用户不知道 agent 侧手改会被覆盖）；设置页「数据与存储」（`app_storage_usage` 递归求大小，符号链接不跟随、2 万条目预算上限）与「想法期只读保护」补行。**明确暂缓**：技能+MCP pill 合一（要重构两套菜单，收益低于风险）、收件箱生产者搬进 store（130 行、8 个数据依赖，回归风险高于收益，现耦合可用是因 WorkspacesPage 恒挂载）、工作树 `.*`/`⟳` 改 hover（`⟳` 常用，藏起来是负优化）。 |
| v3.90 | **「草稿」概念并入 TASK.md（用户拍板）+ 无注入 CLI 指令自动复制**：① **预览/编辑入口合一**——界面上不再有「草稿」：流程线「预览 TASK.md」（只读弹层）与「预览/编辑草稿」合并为「预览/编辑 TASK.md」（StepFlow 内弹层），没编辑过显示模板默认拼装（只读展示不落盘、纯看不留痕）、可直接改，保存才落地；开工弹层/沉淀到下一步/融合进任务书/删除项目确认等文案同步去「草稿」。存储不变（`.ccode/drafts/<名>.md` 与 read/write/append_task_draft 均不动——开工前内容总要有存盘处，草稿只是实现细节）。② **「跟 AI 商量一下」播种**——开聊前若文件为空或仅含「已定方向」（`isDecisionsOnly`），先把当前模板拼装（`buildTaskMdPreview`，与开工落盘同一出处）整份写入作为起点，指令从「从零起草」改为「通读 → 逐个问拿不准的点 → 按回答直接改这份文件」。动机：从零起草的草稿开工时整体替代模板拼装，会把简报/预期产物/提货单全丢掉；播种后「替代」语义变安全。已有正文不覆盖；决策答案不丢（拼装「已定方向」段本就解析自该文件）。**已知代价（接受）**：播种后内容是拼装那一刻的快照，之后提货单/简报再变不回灌——已编辑 = 人已介入定稿，要最新拼装走开工弹层「恢复默认拼装」。播种失败不开聊、行内报错。实现：`StepFlow` 加 `onSeedDraft`/`onLoadTaskMd` 两回调（由 TaskCardsSection 实现——它有 `cfg` 与拼装出处）。**走查修复**：快照不回灌把「文献来源」段也冻住了（选 Zotero/PDF 库后 TASK.md 不跟着变）——该段是改变检索步骤性质的硬前提，抽 `task-md-sections.ts` 纯函数（`litSourceSectionLines`/`upsertLitSourceSection`，renderTaskMd 同一出处），切换 `lit_source` 时就地同步进各步骤已有正文的内容文件。③ **确定 TASK.md 的两条路径同形对仗（用户拍板）**——方式一（决策项点卡片）与方式二（跟 AI 聊）原本各说各话像两个不相关功能；现在两行同形：都是默认折叠的一行（▸ 展开露动作），行首箭头列对齐，行尾固定位分别是「全部用推荐值」/「预览/编辑 TASK.md」；节点引导句统摄「点卡片或跟 AI 聊，都进 TASK.md」；无决策项的步骤不标方式二（方式一不存在时单标只会让人找方式一），聊天入口维持单按钮。④ **promptDropped 路径补复制**——无启动注入参数的 CLI（kimi/opencode）启动后指令文本留在 disabled 输入框里**不可选中**，「请手动发送」实际无从下手；改为自动写剪贴板（与 HandoffPicker/DigestPicker 接力流同口径）+ 指令行加「⧉」一键复制兜底（仅运行中且指令非空时出现），提示文案改为「指令已复制，请在终端里粘贴发送」。 |
| v3.91 | **步骤认领：商量会话也能被「本步骤的对话」捞到**（用户实测：点「跟 AI 商量一下」进入的对话 live 可见，但点「本步骤的对话」跳对话页带步骤 chip 后筛空）。根因：步骤归属（`stepName`）唯一依据是会话目录落进该步骤 worktree（`sessions.rs` 扫描时按 workspace→步骤名现算）；「跟 AI 商量一下」在项目根开终端只改 TASK.md 不建工作区，这类会话 `stepName` 恒为 None，步骤过滤一律筛掉。修法与 `card_claims` 同构：新增 `step_claims` 表（`agent,cwd` 主键覆盖登记）+ `claim_next_session_for_step` command——`PendingTerminal.stepName` 透传到终端标签，`TerminalView.launch` 在 spawn 前以最终 agent/cwd 登记（发起时不登记：启动栏还可改 agent/目录，spawn 时的实时值才作数，resume 不登记）；`apply_step_claims` 在 `list_sessions` 消费：取该 agent+cwd 下登记后活动、`step_name` 尚空的最新会话回填步骤名、固化进 `session_meta.step_name` 持久列并删登记（有 worktree 归属的不抢占、登记前旧会话不误归；worktree 命中优先于持久列）。**初版教训**：曾按「无持久列、消费即删」实现，结果归属只活在消费那一轮——对话页 8s 轮询的下一轮 `stepName` 又丢回 None，实测依旧筛空；持久列（与归卡同口径）才是正解。**限定**：只覆盖登记后新发起（含 reuseKey 切回已有进行中标签再登录记）的会话；修复前已存在且不再更新的旧商量会话不回补——用户重新发起即归位。 |
| v3.95 | **文献雷达应用层消费（定时任务「产出回流」三件套落地，用户拍板口径）**：§11.4 Backlog 细目「定时任务与研究流程的结合」第 1–3 条（产出进收件箱 / 关联步骤 / 复用 staleUpstream 口径）就此落地；第 4 条落点收敛与「跑进工作区」当时未做（v3.224 隔离树、v3.225 播种与采纳进主仓已补齐）。① **应用层解析巡检产物**——新模块 `lit_watch.rs` 把 lit-watch 产物解析为 DTO：`notes/inbox.md` 条目（标题/来源/作者/摘要首句/命中关键词/相关性三档/期刊/中文一句话，日期取 `<!-- watch-run: YYYY-MM-DD -->` 批次标记，上限 500 条）、`papers/watch-followup.md` 付费墙待办、`papers/watchlist.md` 订阅清单、`papers/included.md` 精读清单；命令 `list_watch_entries` / `list_watch_subscriptions` / `save_watch_subscriptions`（整表写回、保留注释行）/ `list_included_entries` / `add_included_entry`（规范化标题去重）/ `remove_included_entry` / `download_paper_pdf`（reqwest 仅 http/https、60MB 上限流式中止、`%PDF-` 魔数校验、文件名 sanitize、落 papers/ 重名 -2/-3、自动登记 project.toml `[[resources]]` type="paper"）；所有操作门槛 = 已注册项目根 + canonicalize 防逃逸 + 读-改-原子写。② **雷达卡片**——新组件 `LitWatchCard.tsx`（「◔ 文献雷达」，挂项目详情工作段 TaskCardsSection 之后）：SegTabs「新命中｜精读清单」（默认新命中）、近 8 周手绘 SVG 迷你趋势、按日分组（今天/昨天/更早，组内 推荐>相关>待确认）、条目双行（相关性 pill：推荐=cta-pill、其余灰底语义点；有中文一句话则显示）；动作「→ 精读」常驻 + hover 才现「◈ 解读 / ↓ 全文 / ⋯（打开来源/忽略/复制标题）」；◈解读走 ai_prompt 不传功能键、输出三行（做了什么/为什么重要/和本课题的关系，课题取 cfg.topic）、缓存+失败重试；↓全文非直链（如出版商页）禁用提示手动下载；followups 折叠区「待人工下载 N」。精读清单行 = 标题 + 作者年份 + 已读/未读状态点（notes/ 有匹配笔记文件即已读，规范化标题互相包含判定，**派生不建状态机**）+ 主按钮「开读」（有已下载 PDF 走 previewReq 跳终端页预览，没有则变「↓ 全文」先下载）+ ⋯（获取全文/移出清单）。订阅弹层 w-[36rem] 表格化编辑（关键词/来源多选 chips/备注/＋加一行/编辑源文件）；空态整卡一句话「还没有追踪关键词，添加第一条」。纯逻辑 `src/lit-watch.ts`（groupEntriesByDay/weeklyBuckets/pdfUrlFor/includedLineFor/isRead/paperResourceFor/staleLitHint/litInboxCandidates 等，tests/lit-watch.test.ts 12 例）。③ **收件箱「文献」类别**——`inbox.ts` key 前缀 `lit:`，胶囊排在「待确认」之后：定时任务最近一次成功 run 有 newEntries>0 且 24h 内 → 条目「文献雷达 · <项目名>：N 条新命中」，点击跳项目详情；dismiss 走既有签名机制。④ **scheduler 关联步骤与新命中计数**——`Schedule.linkedStep`（可空；update 时空串归 None 清除；ScheduleSection 新建弹层加可选「关联步骤」下拉、任务行内回显「→ 步骤名」）+ `RunRecord.newEntries`（跑 lit-watch 前后数 inbox.md `## ` 标题数取差，超时/失败不记）；雷达卡片在关联步骤有满足条件的新命中时显示警告色小字「雷达有新命中，『X』步的产物可能过期」（staleLitHint：linkedStep 非空 && newEntries>0 && 巡检时间晚于该步骤工作区 mergedAt/createdAt；复用 staleUpstream 口径，只提醒不阻断）。⑤ **技能双因子精选与批次标记**——lit-watch SKILL.md 升级（播种走既有字节比对更新提示机制）：精选排序改 相关度 × 期刊档次 双因子（内置主流高刊名单，名单外不降级只作加分；期刊档次只影响排序不影响收录），条目格式新增「期刊」「中文一句话」两行（中文一句话每条必写），批次标记约定 `<!-- watch-run: YYYY-MM-DD -->`。⑥ **用户拍板口径**——组织单位 = 项目级落盘 + 全局收件箱聚合，不建独立文献库页；信息源三路 API 够用、精选要高相关×高刊；条目默认中文一句话扫读、单篇点「◈ 解读」才调 AI；主路径「先攒后读」（→ 精读清单为主按钮） |
| v3.96 | **沉浸阅读区落地（Backlog「深度阅读器」就此落地，批次 B1/B2/B3，用户拍板口径）**：**形态**——终端页内全屏覆盖层 `ReaderOverlay`（fixed inset-0 z-40 页面模态档），三栏「笔记｜PDF｜Agent 终端」，**不要底部终端**（用户拍板）；Esc 退出（Esc 级联阅读区最优先，专注模式 Esc 让路），底下终端/PTY/右栏全程保持挂载；分隔条拖拽记宽度（localStorage `ccode.readerSplitL/R`），左右栏可收起；v1 单窗全屏，结构上预留 v2 独立弹窗能力（未做）。**入口三处**——终端页 PDF 预览工具条「⛶ 沉浸阅读」、文献雷达精读清单「开读」（从 previewReq 跳内嵌预览改为发 readerReq 进阅读区）、文件树 PDF 右键「沉浸阅读」；统一走 store 一次性请求 `readerReq: { pdfPath, projectRoot }`。① **笔记栏**——后端 `ensure_paper_note` 建档 `notes/<slug>.md`（七固定小节：研究问题/方法/主要结果/局限/可引用点/译段/我的想法，已存在不覆盖；结构对齐 lit-notes 技能口径）；嵌入 FilePreviewEditor（阅读/编辑双态、watcher 外部重载）；md 阅读版式图片与相对链接后处理（相对/绝对图片经 `read_image_bytes` 转 data URL、**http 图片不加载**（隐私，用户拍板）、相对链接笔记栏原地打开 +「← 回笔记」）；编辑态粘贴图片落 notes/assets/ 并在光标处插图（非项目内文件回落临时图路径文本）。② **PDF 栏**——`PdfContinuousView` 连续滚动虚拟化（可视窗口 ±2 页懒渲染 canvas+textLayer）、缩放/适配宽度；选段浮动条四钮「译 / ◈ 问 AI / ＋生词 / ⋯（↵ 直接发送）」；「▦ 圈选」页内拖框 → canvas 裁 PNG，两个去向：「◈ 发给 agent」走 `save_clipboard_image` 临时图落盘、路径+预填 prompt 注入终端输入行**不自动发送**，「＋ 插入笔记」走 `save_reader_capture` 落 notes/assets/ 并 `append_note_image` 追加到笔记「我的想法」小节；⌘/Ctrl+点击段落对照翻译（textLayer 行分组 + 段界判定；结果进点击位置旁的选区同款浮卡）；进度记忆（停 2s 记页码、再进自动回滚 + 提示）与护眼反色（按文件记忆，CSS filter 只反 canvas 层不动数据）；术语淡高亮（textLayer 文本节点整词匹配包 `span.ccode-gloss`，点状下划线 + 悬停释义，cleanup 还原、不破坏 textLayer 文档流）。③ **Agent 终端栏**——右栏 = 阅读会话标签的 xterm 终端画面（TerminalPage `useLayoutEffect` 把该标签容器宿主节点（`data-terminal-host=<tabId>`）搬进覆盖层槽位、关闭搬回原位，Monaco 宿主移动同款先例，PTY/xterm/scrollback 不重建不丢；容器既有 ResizeObserver 尺寸变化自动 fit；打开时该标签提到活跃）；**进入阅读区自动起会话**（reuseKey `reader:<projectRoot>` 找回同项目阅读标签、退出再进接着聊、无可用配置给引导卡跳配置页）；无独立对话视图/输入框——「◈ 问 AI」/圈选截图注入写该标签 PTY，文字出现在终端输入行正好可见；焦点在终端里时 Esc 归终端（打断生成/vim）、不关阅读区，退出用「← 返回」。④ **后端 `reader.rs`**——`ensure_paper_note` / `read_image_bytes`（白名单判定复用 pdf.rs `read_whitelisted_sync` 内核，png/jpg/jpeg/gif/webp/svg，20MB）/ `save_reader_capture`（PNG 魔数校验 + 同秒重名 -2/-3 递增）/ `append_note_image` / `list_glossary` / `append_glossary`（术语小写去重、重复 = 更新释义）/ `remove_glossary_entry` / `append_note_translation`（「## 译段」小节）；全部 gated_root 注册项目根门槛 + canonicalize 防逃逸 + 原子写。⑤ **共用内核与纯逻辑**——TerminalPage `injectToActiveAgent` 抽为 `injectToTab(tabId, data, send)` 共用内核（右栏选段与阅读区注入同一条链路，行为口径不变）；纯逻辑 `src/reader.ts`（分栏钳制与像素换算/圈选命中与 canvas 映射/截图注入格式/glossary 表格契约（与 Rust 双端镜像，改动需同步）/段落边界提取/术语匹配/进度与护眼存储键，tests/reader.test.ts）。**顺带修复**：pdf.js TextLayer 重渲染前未清空导致重复文本片（PdfPreview.tsx 的 PdfPageView 渲染前先 replaceChildren）。**拍板口径**：舒适功能做划词即译/术语高亮/段落对照/护眼与进度，不做长难句拆解；OCR 不引本地引擎——扫描件走圈选截图发视觉 agent；整页中文覆盖层留 v2。2026-08-18 用户拍板：不做扩展性功能，只做场景必需；快捷 chips（图导游/总结这页/帮我改笔记）与「✦ 工具」页签（译历史/生词本表格/大纲，ReaderToolsPanel 已删）砍掉待需求，右栏从结构化对话视图改为真实终端画面 |
| v3.97 | **LaTeX 支持落地（批次 E 先行，用户拍板口径）**：**路线拍板**——① 确立「只做场景必需、不做扩展性功能，用户需要时再加」原则（批次 B 已据此裁改，见 v3.96 末）；② 场景 4 不做独立产品能力，后续由按需挂载的 `origin-plot` 技能承接；③ 批次顺序调整：E（LaTeX）先行，C（实验数据分析）/D（表征分析）转待办；④ LaTeX 范围 = 全要（.tex 工作流 + 公式/表格转换）+ 内置骨架与导入兜底 + tectonic 优先；**不做应用内 LaTeX 安装器**（检测与安装引导放脚本输出与可选人工事项）。① **KaTeX 公式渲染**——新依赖 `katex@0.18.4`（pin）；`src/md-math.ts`：marked 扩展按 Pandoc 口径切分 `$...$`/`$$...$$`（`$` 边界规则、`\$` 转义、代码块不渲染、货币 `$5` 不误判），先渲染成 `.md-math` 占位、HTML 上屏后 `renderMathInto` 动态 import katex + CSS（懒加载独立 chunk，主包为零——构建产物实测验证），渲染失败回落原始源码；受益面 = FilePreviewEditor 阅读版式 + StepFlow 的 TASK.md 预览 + ArtifactChecklist 内联预览（tests/md-math.test.ts 25 例）。② **第六套内置模板「LaTeX 论文」**（pipeline-presets.ts，4 步）：搭建骨架（文档类决策项 elsarticle/IEEEtran/achemso/ctexart/学位论文通用架 + natbib/biblatex 决策项；期刊模板 zip 走可选人工事项解压到 `manuscript/template/` 由 agent 读说明适配，无内置解析器）→ 章节写作（挂 review-writing，`\cite{bib键}` 沿用 references.bib）→ 编译与排错（读 `.log` 对症改不绕路；装环境是可选人工事项）→ 定稿导出（`manuscript/main.pdf` 进 expectedArtifacts）；run 脚本 `render-pdf` 各步共用同一常量：tectonic 优先 → latexmk 回落 → 都没有打印安装引导 + exit 1（开步时经既有 ws_settings 机制写入 `.ccode/settings.toml`）。③ **.tex 高亮**——monaco-editor 0.56 ESM 实际不带 latex 语言（VS Code 的来自扩展），自带紧凑 Monarch 定义注册（`src/editor-languages.ts`），`.tex/.sty/.cls/.bib` 命中（tests/editor-languages.test.ts 4 例）。④ **resolve_binary macOS 候选 +`/Library/TeX/texbin`**（MacTeX/TeXLive 的 latexmk/pdflatex；agent_specs.rs `binary_candidate_dirs` 一行 + agents.rs 既有测试补断言）；Linux 不加（`/usr/bin` 已覆盖，TeXLive 版本化路径固定候选覆盖不了，宁缺） |
| v3.98 | **精读笔记产物直连沉浸阅读区**（用户需求：notes/<序号-短标题>.md 结合对应 PDF 全屏阅读、笔记直编、agent 可改同一文件）：`readerReq`/阅读区 state 加可选 `notePath`——非空时 ReaderOverlay 跳过 `ensure_paper_note` 建档、笔记栏直接编辑这份 md（避免按 PDF slug 再建第二份模板笔记，与 lit-notes 序号前缀口径并存打架）；配对内核 `pair_pdf_at`（reader.rs）：笔记 stem × project.toml `type="paper"` 资源 stem 做 `normalize_title` 互相包含（lit_watch.rs 提 pub(crate) 复用，与前端 lit-watch.ts `paperResourceFor` 同口径），多命中取最长、无命中入口就地提示（**不做手动选择器**，需要再加）。两个 command：`pdf_for_note`（根已知，返回 Option）与 `reader_for_note`（根未知反查归属：注册项目根 canonical 前缀直含 → 工作区 worktree 包含映射主仓副本，主仓未合并明确报错）。md 入口三处：产物核验清单 md 预览弹层「⛶ 沉浸阅读」、终端页文件树 md 右键、终端页 md 预览工具条 ⛶（read 态经 FilePreviewEditor 新 prop `onOpenReader` 接管，缺省保持自带单栏沉浸层）。左栏编辑/外部重载、右栏阅读会话（reuseKey `reader:<projectRoot>`、cwd=项目根）全部复用既有机制零改动。**模板调整（用户拍板）**——英文综述模板「文献精读与笔记」步：删掉「继续补投付费全文」人工事项（付费全文的补投入口保留在检索步「下载付费墙文献全文」），收尾新增可选人工事项「继续精读笔记（沉浸阅读区）」（timing=after）——引导验收后回阅读区补读/修正笔记；因阅读区改的是主仓笔记、下一步工作区只含已提交内容，guidance 明确「改完到改动面板提交」，开工确认弹层既有「主仓未提交改动」提醒兜底，保证后续步骤读到的是用户精读改过的版本 |
| v3.99 | **hooks 精确注意力桥接推广到七家 + AgentSpec 能力表结构化 + 生效配置自省**（借鉴 deepseek harness 的三项对齐，本批未发版）：① **hooks 桥接推广**——claude_hooks.rs 泛化为 hooks.rs：BRIDGE_SPECS 每 agent 一张桥接规格（claude/qwen/codebuddy/gemini/kimi/grok/codex），**复用各家原生 hooks 格式与事件名、不自创协议**；统一引擎沿用 v3.32 防护口径（写前备份留 10 份 + 原子写 + 只动 hooks 键/段 + marker 合并/移除 + 配置损坏拒写；grok 为整文件形态特例——`~/.grok/hooks/ccode.json` 整份归 Ccode，外来文件拒覆盖）；日志解析兼容 snake_case/camelCase 双信封、事件名去下划线小写归一、grok Stop 只认 reason=end_turn、会话归属双键匹配（session_id==文件主名 或 transcript_path==完整路径）；10 分钟 TTL 回落尾部推断与消费侧零改动。settings 字段 `claude_hooks_attention` 迁移为 `hooks_attention: map<agent,bool>`（旧字段仅保留反序列化兼容）；设置页「集成」区改按 `hooks_attention_support()` 清单渲染（九家全列、不支持置灰带原因）。各家事件映射调研录 matrix §12。**cursor/opencode 不接入的原因**：cursor 无「等待确认」等价事件且逐事件触发机制未实机验证（未登录）；opencode 无 shell hooks 形态（仅进程内 JS 插件，事件名 v2 重构中不稳定）。**codex 信任审核不自动 bypass 的取舍**：非托管 hook 必须在 Codex TUI /hooks 面板人工信任后才执行（按 hook 定义 hash 记信任，改命令失效需重审）——安全优先不做绕过，UI 备注「首次生效需在 Codex /hooks 面板信任该 hook」引导；codebuddy 启动快照 hooks 配置，备注「已运行的会话需重启后生效」。② **能力表 fail-loud**——AgentSpec 新增 set_global/mcp_write/skill_dist 三个能力字段（不支持必须带用户可见原因，后端报错与前端置灰同源）：global_config.rs 进 match 前查表拒绝、mcp.rs 的 grok 只读硬编码改查表、skills.rs 的 allow_symlink_for 改查表；新 command `agent_capabilities()`，MCP 页删硬编码 Set 改读表（置灰 + HoverTip 原因）、配置页「设为全局」菜单项按表置灰；行为零变化。③ **生效配置自省**（config_dump.rs，只读）——`dump_effective_config` / `export_effective_config`（落盘 `~/Downloads/ccode-exports/ccode-effective-config-<时间戳>.json`）：快照含 generatedAt/appVersion/appSettings（with_defaults 完整 DTO）/profiles（仅 keyHint 尾号、剔除 extra_env，绝无密钥）/hooksAttention/capabilities（复用 agent_capabilities）/workspaceSettings（传 root 时 ws_settings 三层合并终值 + 每键来源层标注），整份出站前过 `sessions::redact_sensitive_text`；设置页「诊断」区新增「生效配置快照」卡片（诊断包卡片下方，同款一键导出交互） |

| v3.100 | **恢复标签失效目录与会话刷新竞态收口**：重启恢复标签只保存元数据，不自动迁移 cwd；恢复前验证目录，失效时保留 agent/profile/model/sessionId，并提供「选择新目录 / 回到主目录 / 重新检查」，用户显式修复后再恢复，文件树同步使用可恢复的人话错误。`loadSessions(force?)` 统一协调窗口聚焦、页面轮询、跳转和 mutation 刷新：普通刷新复用在途请求，变更使用强制刷新，请求代次只允许最新结果写入 Zustand，旧请求返回当前列表。
| v3.101 | **Codex 风格界面设计基线**：以当前 `tauri dev` 热更新窗口为唯一视觉基线，新增 `docs/conventions/codex-style-ui.md`，明确外壳、导航、页面模块、按钮层级、状态、弹层、空/加载/错误态、跨平台规则与逐项验收清单；不改变现有项目隔离、任务书、评审合并、Agent 能力和密钥安全语义。后续 UI 优化按该文档分批实现并在热更新窗口核验。

| v3.102 | **外部终端安全临时复现**：外部恢复/提炼接力不再依赖 Agent 全局配置；前端只传明确选中的 profile/model 等非敏感元数据，缺少或失效的 profile 必须 fail-closed，不静默取第一套配置；后端读取本地密钥并复用 AgentSpec 启动计划生成一次性 wrapper。wrapper 启动后自删、失败立即清理、超时兜底删除；Ghostty 运行中实例通过原生 AppleScript 新窗口设置工作目录并启动 `/bin/sh`，再由 `initial input` 执行带 shell 引号的 wrapper 路径，规避 `Application Support` 等带空格路径在 `command` 字段中的解析失败；不依赖辅助功能模拟粘贴。复制命令仍保持无密钥的全局配置模式。终端能力差距与九家 Agent 审计记录在 `docs/audits/terminal-agent-audit-2026-08-21.md`。
| v3.103 | **Codex 风格外壳第一批落地**：新增「工作台」默认入口；侧栏改为工作（工作台/项目/运行/对话）→资源（连接/技能/MCP）→管理（用量/设置）；顶栏统一承载项目上下文、运行中数量、收件箱和唯一命令面板入口；页面快捷键扩为 `⌘1–⌘9`。新增 `WorkbenchPage` 只消费现有 store 镜像与最近仓库/会话，不改项目、终端、会话的核心状态机；工作台「快速开聊」与侧栏、命令面板共用真实 QuickChatModal；开发配置显式绑定 Vite 热更新地址，避免验收误载旧 dist。
| v3.104 | **Codex 风格界面第二批**：工作台使用紧凑卡片间距与嵌入式空态，保持「添加项目/快速开聊」两个明确入口；侧栏展开宽度调整为 208px，收起态导航统一使用 portal tooltip 并补齐 `aria-label`；顶栏收件箱增加总数摘要、分类浮层改为轻量卡片行；项目工作区卡片常驻「继续」，普通评审、脚本和其他低频动作收进 `⋯`，仅合并冲突保留行内直达。
| v3.105 | **侧栏宽度微调**：根据热更新窗口走查，将 Codex 风格侧栏展开宽度从 208px 收紧为 192px，收起态继续保持 56px；仅调整外壳占用，不改变导航层级、交互语义或页面内容布局。
| v3.106 | **Codex 风格界面第三批（运行页）**：运行上下文栏默认只显示 Agent、连接、模型、目录与启动动作；首条指令、技能、MCP 收进 `⋯` 的「高级启动选项」分组，仍复用原有 PTY 注入、技能使用和 MCP 管理逻辑，不改变启动参数或权限语义。
| v3.107 | **运行时快捷入口调整**：根据用户走查，技能与 MCP 恢复为运行页启动栏展开态和收缩状态行的常驻入口；高级启动选项仅承载首条指令，不改变 PTY 注入、技能使用或 MCP 管理语义。 |
| v3.108 | **Codex 风格界面第四批（连接页）**：用户面统一使用「连接」术语；连接页组头补充连接数量与「添加连接」入口，连接行由满屏分隔线改为卡片间留白与 hover 层级，编辑/终端使用统一 28px 行按钮，导入/导出/验证/复制/全局写入等低频动作继续收进 `⋯`。只改界面层，不改变 profile 数据模型、密钥安全、验证、全局写入或终端注入语义。 |
| v3.109 | **Codex 风格界面第五批（对话双栏与详情操作）**：对话回放头部常驻「继续 / 提炼简报 / 导出 / ⋯」，底部只读操作区提供「继续这个对话 / 在外部继续 / 查看项目」；当前项目改动仍为只读磁盘状态，不新增历史改动快照或任务书写入语义。 |
| v3.110 | **Codex 风格界面第六批（技能与 MCP 管理页）**：技能列表改为分类内卡间留白、轻量 hover 操作栏并统一「创建技能」文案；MCP 页面统一用户术语为「MCP」，列表改为卡间留白，添加/编辑/收编文案同步。只改界面层，不改变技能分发、MCP 分发、健康检查或能力表语义。 |
| v3.111 | **Codex 风格界面第七批（用量与设置）**：用量页新增突出「总 tokens」主指标，项目排行名称可跳转项目页；设置页改为左侧分区导航 + 右侧单区内容，选中分区始终展开，保留折叠记忆仅作默认值。统计计算、设置存储和诊断能力不变。 |
| v3.112 | **对话与用量页走查修正**：对话页移除底部重复的应用内「继续这个对话」，只保留头部「继续」主入口；「查看项目」仅对命中已注册项目的会话显示。用量明细表固定费用列宽，金额过长省略显示并保留悬浮完整值，不改变统计口径。 |
| v3.113 | **Codex 风格界面第八批（导航图标系统）**：侧栏与工作台相关入口统一使用 Lucide 描边图标（16px、统一线宽），移除混用 Unicode 符号；选中态收敛为浅色背景 + 强调色图标 + 强文字，取消额外左侧色条；快速开聊和项目上下文按钮沿用同一图标系统。只改视觉表达与无障碍名称，不改变路由、快捷键或业务语义。 |
| v3.114 | **工作台主焦点与活动流重构**：工作台从同权重卡片仪表盘改为「继续当前工作」主卡 +「待你处理」注意力区 + 最近项目/最近对话活动流；主卡突出当前项目、步骤、路径与运行状态，列表使用留白和 hover 背景表达层级，保留添加项目、快速开聊、继续工作、收件箱与运行跳转行为。 |
| v3.115 | **Codex/Linear 视觉批次 1–8 收口**：共享框架新增流程卡片内轻量操作、紧凑主动作与紧凑输入令牌；项目页仅调整身份段、项目 rail 与外围留白，研究流程带几何/状态/点击语义冻结；运行与对话页减少重复横线和边界；连接、技能、MCP、用量、设置统一为块间留白与低频操作按需显现；警示与目录入口改为单色符号/Lucide，浮层回归 `.ccode-float-surface`。不改变 PTY、会话归属、技能/MCP 分发、用量口径、密钥与 worktree/评审语义。 |
| v3.116 | **项目页大窗口流式布局**：`PageFrame` 新增显式 `fluid` 宽度档位，项目页详情和收件箱 strip 使用主区剩余宽度；项目 rail 保持固定宽度，流程带内部几何、步骤顺序、状态和点击语义冻结。其他阅读型管理页继续使用各自最大宽度，避免超宽窗口造成信息过度稀释。 |
| v3.117 | **工作台大窗口流式布局**：工作台切换到 `PageFrame width="fluid"`，继续沿用「继续当前工作 / 待你处理 / 最近项目 / 最近对话」结构，最大化时仅扩展分栏容器，不放大卡片、按钮或字号，也不改变跳转和运行语义。 |
| v3.121 | **项目流程页信息收敛**：项目头部只显示需要用户介入的阻塞数量；聚焦步骤隐藏与流程节点重复的普通状态短语；流程线移除人工事项/Agent 的通用时机与落点 hint，详细操作保留在按钮 tooltip 和「怎么做 / 落点」展开区；长 guidance 采用一句摘要 + 可展开详情；讨论、想法和人工事项分组改用短标签。流程节点顺序、状态派生、开工/评审/交付动作与 TASK.md 语义不变。 |
| v3.118 | **设置页中宽布局**：设置页 `PageFrame` 外壳从 820px 调整为约 1080px，解决分区导航与右侧内容拥挤、与其他页面宽度断层的问题；设置行的说明文本、表单控件和定价表仍按局部可读宽度约束，不改变设置存储与生效语义。 |
| v3.119 | **资源与用量页流式布局**：连接、技能、MCP、用量统一使用 `PageFrame width="fluid"`；列表/表格使用主区剩余宽度，技能详情栏继续保留自身上限，费用列等固定字段不被拉伸。只调整页面容器，不改变 profile、技能/MCP 分发、健康检查或用量统计语义。 |
| v3.120 | **用量/项目与设置页走查修正**：用量真实项目排行名称增加明确的 `↗` 跳转提示并复用 `selectProjectReq` 聚焦项目，内部聚合行不显示误导性跳转；项目流程线的已选来源/决策项按钮统一使用主题感知的 pill 令牌，评审状态大圆改用强调色文字档，避免浅色主题黑色控件与深色主题深红块；技能表描述列设上限让来源列自然贴近；设置页快捷键按侧栏顺序拆分为页面/全局两组，数据与存储「定位」改为系统文件管理器定位并显示失败原因。统计、项目流程、技能分发、设置存储语义不变。 |
| v3.251 | **侧栏桌面磨砂**：窗口透明，macOS 用 `underWindowBackground`（需 `macOSPrivateApi`，不上 Mac App Store），Windows 11 用整窗 Mica 并跟随 Mesa 深浅主题。标题栏、侧栏和四周 8px 缝只留主题色罩（展开 42%、图标态 28%、选中行 88%）；主画布、终端、阅读层保持实心。Linux 与系统「减少透明度」回落实心 rail。页头与顶部胶囊的网页内玻璃不改。细则 `conventions/design-system.md`。
| v3.121 | **三态侧栏与顶部导航胶囊**：全局侧栏固定为展开、图标、完全隐藏三态；品牌按钮只在展开↔图标之间切换，完全隐藏由 `⌘\\`、命令面板或顶部胶囊恢复入口控制。`navCollapsed` 继续持久化普通状态，`chromeHidden` 仅当前窗口有效并保存进入隐藏前的普通状态用于恢复。完全隐藏保留 40px 系统上下文栏，仅隐藏项目/运行上下文；顶部胶囊固定悬浮在其下方，复用九页导航与快速开聊入口，按热区唤出、延迟隐藏、失焦立即收起，层级高于沉浸阅读区但低于命令面板/确认框。新增 `startupNavMode`（缺省兼容旧 `navCollapsed`）与 `navCapsuleHideDelayMs`（500/1000/2000/5000，默认 1000）设置；前者仅影响下次启动，后者即时生效。 |
| v3.132 | **顶部导航胶囊显示偏好**：新增 `navCapsuleDisplayMode`（`both`/`icons`/`labels`，默认 `both`）与 `navCapsuleVisibleItems`（缺省=全部入口）设置。入口只支持显示/隐藏，不改变固定的工作→资源→管理顺序；恢复侧栏始终保留，当前页面即使被配置隐藏也临时保留，切换页面后按配置收起。设置修改即时作用于当前窗口。 |
| v3.122 | **科研模板 P0 语义收口**：步骤新增可选 `inputs` 字段，保存为 `project.toml` 并在开工生成的 `TASK.md` 中以「本步骤输入」列出；从第二步起，输入必须能由上游 `expected_artifacts` 或项目资源覆盖，第一步保留外部/跨项目输入自由度，旧档案卡缺省兼容。人工事项新增 `completion` 判定（`exists` / `manual` / `all` / `no_placeholders`），其中 `manual` 不因文件存在自动完成，`all` 支持 `papers/to-fetch.md` 零条目完成，`no_placeholders` 检查常见待填标记。产物核验与人工落点支持末段 `*` 通配，旧目录条目继续兼容。投稿模板结构化分为首投两步与按 `submissionRound` 隔离的返修单步；返修读 `reviews/round-N.md` 和上一轮修订稿，产物带 `rN` 后缀。追加模板时只因步骤名重复跳过，工作区名冲突自动加 `-2`、`-3` 后缀并返回改名明细，避免静默丢步骤。 |
| v3.123 | **科研模板 P1 可靠性收口**：人工事项完成判定由前端按落点类型过滤，并在保存时归一不可兼容旧值；步骤输入依赖编辑器提供前序产物与项目资源建议。投稿/返修追加统一走 `append_pipeline_steps_with_submission`，把分支、返修轮次、步骤追加与 `pipeline_opt_out` 清理放进同一次 project.toml 读-改-原子写，即使步骤名全部重复也不丢分支元数据。 |
| v3.124 | **科研模板 P1 全量收口**：模板三处入口统一走 `apply_pipeline_template` 原子事务，按问题名合并项目级设定并保留已有答案；步骤输入增加可选项与 `any_of_inputs` 二选一组，TASK.md 明确必需/可选/任一；人工事项增加 `expected_count`/`manifest_path`，空落点默认人工确认，`all` 无总数不再误判，文本占位检查拒绝二进制；科研论文拆分检索筛选与精读/研究空白，毕业论文拆分实验执行与结果分析，结果依赖问题改为看到结果后按需询问；新增 `research-writing` 技能，Quarto/LaTeX 正式渲染物纳入预期产物。 |
| v3.125 | **科研模板契约增强**：步骤新增 `acceptance_criteria` 与 `required_skills`；TASK.md 输出内容级验收条件、人工事项完成口径和技能权限；提货单按当前步骤结构化输入过滤；输入/产物通配统一为真正的 `*` 匹配，空文件不算完成。Quarto 与 LaTeX 可再生产物统一写入 `output/`，新项目默认忽略该目录。 |
| v3.131 | **科研模板技能证据链补齐**：文献精读步骤把 `papers/to-fetch.md` 作为回写产物；所有实际执行 `bib-check`/`stats-check` 的步骤在 `expected_artifacts` 登记报告，跨步骤/返修轮次使用专属文件名避免覆盖；`bib-check` 的调用方可为投稿格式、LaTeX 与返修指定报告落点。返修模板的直接改稿授权收口到 TASK.md 明示，技能默认仍不改正文。 |
| v3.126 | **聊天主区沉浸式收敛**：聊天/终端切换改为终端标签栏内的轻量 inline action，移除独立切换行；聊天内容和 composer 使用居中最大宽度，聊天模式隐藏终端底部状态栏，终端模式保持原状态栏与操作。Agent、模型、目录、同步状态和 Skill/MCP 数量显示在聊天上下文栏，composer 直接复用当前 Agent 的技能/MCP 清单并通过同一 PTY 发送提示；不新增持久化显示开关，不改变 PTY、会话同步或分叉语义。 |
| v3.127 | **项目页项目列表可收起**：项目页左侧项目导航 rail 增加局部收起/展开入口，默认展开，收起后保留窄栏恢复按钮并记忆用户选择；不与全局侧栏联动、不随窗口尺寸自动切换，`selectedGroupKey`、项目上下文和右侧详情保持不变。只改变项目页导航可见性，不改变项目分组、工作区列表或项目操作语义。 |
| v3.128 | **运行页上下文与显示层收口**：项目/工作区导航与文件树浏览分离；浏览根不改变终端 cwd，Agent 运行中切换项目改为新标签打开；聊天/终端显示层按标签隔离；布局、分屏、成果面板和专注终端统一进入「布局」菜单。 |
| v3.129 | **项目 rail 图标语义收口**：主项目使用文件夹图标；研究流程工作区使用两位步骤序号；未绑定流程的手动工作区使用 Git 分支图标，移除抽象斜线符号，不改变导航与工作区语义。 |
| v3.128 | **项目页收缩态去除空竖栏**：项目列表 rail 收缩后变为零宽，不再保留空白窄栏或整条竖分隔线；「显示项目列表」恢复按钮移到项目页标题左侧，随页面标题保持可见。展开态仍恢复 230px rail，收缩记忆、当前项目选择和详情上下文不变。 |
| v3.130 | **聊天输入与快捷键误触收口**：Codex 会话解析过滤写入会话文件的 `AGENTS.md`/导入历史上下文，避免规则文本冒充首条用户消息；聊天 composer 的技能/MCP 入口改为只插入可编辑提示、不自动发送，与终端入口一致；会话回复等待状态使用 ref 与最新文件刷新同步，避免 Agent 已回答后仍显示处理中；全局命令面板和页面快捷键在输入控件、可编辑元素及 IME 组合输入期间不拦截，避免编辑时意外弹出。 |
| v3.132 | **聊天回复可靠性修复**：聊天发送后保留本地用户消息，旧会话快照不得覆盖；只有读取到发送之后的新 assistant 消息才结束加载状态。等待回复期间增加约 700ms 的短兜底刷新，降低单次 session watcher 事件丢失导致回复不显示的风险；真实会话文件仍是最终消息来源，不改变 PTY 或解析口径。 |
| v3.133 | **聊天发送写入一致性**：聊天发送以 TerminalView 当前 PTY 引用为唯一目标，通过后端 `pty_write_submit` 在同一把 PTY 锁内先按 bracketed-paste 规则写文本、再写提交键，避免异步状态镜像、拆分 IPC 或多行粘贴导致消息停留在输入行而未提交；普通 CLI 使用回车，Kimi 使用 CSI-u 提交序列。 |
| v3.133 | **科研模板契约闭环**：所有声明 Quarto `run` 的步骤同时挂载 `quarto-render`；LaTeX 章节写作/定稿对可选的 `notes/` 与 `references.bib` 明确缺失处理；模板回归检查固定 `lit-search` 四项检索产物并禁止返修产物丢失 `rN` 轮次后缀。 |
| v3.134 | **文献雷达与历史语义收口**：雷达解析与 scheduler 新增计数统一只认有效文献块，巡检摘要不再伪装成命中；收件箱文献动作精确聚焦雷达，雷达立即跑只选择 lit-watch；定时通知携带项目/任务上下文并按任务名显示；定时任务支持编辑；任务分支提交与项目主线历史在界面上明确区分；DOI 来源可直接打开，精读清单已读判定收紧。 |
| v3.135 | **运行页顶部标签与专注状态收口**：终端标签采用 Ghostty 式连续标签栏，当前标签独立圆角高亮，非当前标签使用细分隔线，标签区可收缩/滚动且「＋」固定在右侧；布局/聊天终端图标独立保留。恢复标签默认使用紧凑状态行，移除恢复态上方多余启动配置与模型提示留白；专注操作菜单仅在专注态显示退出项，快速开聊退出后不残留「退出专注终端」。聊天输入区移除底部说明文字。 |
| v3.136 | **终端菜单职责收敛**：布局菜单移除重复的聊天/终端项；启动栏 `⋯` 收敛为打开 Shell/高级启动选项/转为项目；顶部标签 `⋯` 保留查找、修改启动配置及跨标签会话动作，查找不再重复出现；专注退出项只在专注状态显示。 |
| v3.137 | **启动栏窄窗口防覆盖**：配置组由固定宽度改为响应式可收缩控件，技能/MCP/运行/更多动作保持独立布局；恢复任务与更多按钮不共享挤压空间，窄窗口通过收缩/换行/截断处理，不允许视觉覆盖。 |
| v3.138 | **启动栏层级间距**：TerminalView 启动栏与顶部终端标签之间增加固定上内边距，恢复态动作行不再贴住标签下边框；Agent/连接/模型选择器采用窄幅响应式宽度，避免窗口变宽时模型栏异常放大。 |
| v3.139 | **启动配置条内容宽度**：Codex/连接/模型容器按内容收缩，避免 flex 增长造成整行空白和视觉覆盖；仅在窄窗口时压缩/换行，恢复态动作行保持额外上间距。 |
| v3.140 | **启动栏右侧动作组**：技能、MCP、运行/恢复和更多按钮统一靠右，模型异常提示独占下一行，避免配置控件与动作按钮互相挤压。 |
| v3.141 | **外部技能流水线适配五件套（用户需求：GitHub 下载的科研 skill 即装即配研究流程）**：核心判断——挂载本就按名字即插即用（TASK.md 只引用技能名、本体不进简报），缺口在「外部技能不声明接口、Ccode 不校验」。① **TASK.md 路径兜底**（成本最低收益最广先做）：「本步骤技能」段固定尾行「技能正文读取/产出路径与本文件不一致时以本文件为准」（pipeline-start.ts），未适配技能也被拉回约定落点。② **frontmatter 契约扩展 + 推断兜底**：`parse_skill_md` 改返回 SkillFrontmatter 结构（name/description/outputs/inputs 四字段，行内/多行列表写法同容忍）；`SkillDto` 加 `inputs` 与 `interface_inferred`；外部技能两侧都未声明时 `infer_interface_from_body` 从正文推断（逐行路径 token + 行内动词分类、双侧动词不猜、URL/中文 token 剔除、每侧上限 8 条，宁缺毋滥）——推断只进 DTO 打标不回写。`compose_skill_md` 支持写 inputs/outputs，`update_content_impl` 普通编辑保留库中已声明接口（顺带修了自建技能编辑静默丢 outputs 的旧缺口）。③ **跨步骤链路校验**：skill-conflicts.ts 新增 `skillChainWarnings`（inputs 对调用方汇总的 supply 找供给、outputs 对 expectedArtifacts 对账，支持 `*` 通配与目录/文件互含，推断接口照检但文案标「供参考」）；StepSkillsChips 加 `chainSupply`/`expectedArtifacts` 可选 props，开工确认弹层与流水线编辑器两处接入——断链从运行时发现提前到配置时。④ **◈ 适配到流水线**：`adapt_skill_to_pipeline`（FN_DISTILL 功能键，`build_adapt_prompt` 内嵌规范路径表单一出处，输出剥代码围栏 + redact_and_cap）出稿 → 弹层预览/再编辑 → `write_skill_md` 确认落盘（name 强制沿用库中条目、description/inputs/outputs 取稿件解析值、备份/回滚复用 update_content_impl）——机械适配自动化、语义适配 AI 辅助、人拍板。⑤ **反向挂载**：技能页 ⋯ 菜单与预览面板「哪些步骤在用」区各加「挂载到步骤」入口（list_projects → read_project_config → update_step_skills，已挂载置灰）。全部只提醒/确认制，无静默改写。 |
| v3.142 | **profile「停用」语义收紧 +「设为全局」生效追踪**（用户对照 cc-switch「启用」后的取舍：注入主线不变，「在 Ccode 配置、去外部终端用」给可区分标记）：① **隐藏 → 软停用**——`hiddenProfiles`（字段名不改存储）从纯展示偏好升级为「不被自动路径挑中」：恢复会话 `pickResumeProfile` 加 hiddenIds 参数（wishedId 是「上次使用」记忆而非当下显式选择，指向停用项同样跳过；全停用时回落含停用项池，不拦死）；AI 无头调用 `resolve_profile_from` 加 hidden 集合、只作用于「最近使用」回落槽（显式/功能专属/AI 专用槽是用户显式绑定，照常尊重），scheduler 同源；UI 文案「隐藏此连接/已隐藏/更多（已隐藏）」→「停用此连接/已停用/已停用（可手选）」。② **「全局生效」追踪**——settings 新增 `active_global_profiles`（agent→profile id，record_active_global/clear_active_global 维护，不走 update_settings patch）：`apply_profile_global` 写成功即记录（其后的验证失败不影响——文件已真实写入），`restore_global_backup` 成功后清除（恢复后全局内容不再是任何 profile 的快照），`clear_profile_refs` 删除 profile 时同步清引用；配置页名称行加绿色「全局生效」徽标，title 注明「上次由 Ccode 写入、外部手改配置文件后可能失真」——只代表上次写入，不声称绝对生效态（cc-switch 式回填保真不做，复杂度不值）。仍**不加 enabled 布尔**（v3.88 口径不变）：注入模式没有全局激活态，「全局生效」是写文件动作的记录而非状态开关。 |
| v3.143 | **codex「设为全局」复检误报修复 + 外部终端密钥指引**（v3.142 走查实测发现）：codex 自定义 provider **只从 env_key 环境变量取密钥，auth.json 不喂自定义 provider**（0.149.1 隔离 CODEX_HOME 实测四变体：env_key=CODEX_API_KEY 或 OPENAI_API_KEY 都 fail；覆盖内建 `[model_providers.openai]` 直接 config.load 失败——openai 是保留名；仅内建 openai provider 会读 auth.json）。后果：Ccode 写出的 `model_provider="ccode"` + env_key=CODEX_API_KEY 配置，外部终端必须 `export CODEX_API_KEY` 才可用（密钥不落 config.toml 是有意为之，auth.json 的 OPENAI_API_KEY 只在用户切回内建 provider 时生效）；而 `validate_after_global_write` 以 injected=false 跑 `codex doctor` 不注入密钥 → 必报「active model provider auth env var is missing」误报未通过。修复：`cli_check` codex 分支有密钥即注入 CODEX_API_KEY（复检验证「文件+密钥」自洽，与 GUI 进程是否 export 无关）；写入成功弹层对 codex 追加外部终端 export 指引。 |
| v3.144 | **opencode 全局配置缺 limit.output 修复**（v3.142 走查实测发现）：opencode 1.18 起 config schema **强制要求 `provider.*.models.*.limit.output`**，缺了 `opencode debug config` 直接「Configuration is invalid」退出 1（XDG_CONFIG_HOME 隔离实测：旧形状复现报错、新形状 exit 0）。`model_registry` 的 ModelCaps 加 `output: Option<i64>`（覆盖文件支持 `"output"` 键，内置表不逐模型收——宁缺毋滥同 context 口径），新增 `model_output_limit` 兜底 8192（models.dev 多数 chat 模型常见值，opencode 拿它当 max output tokens，宁小勿大）；`opencode_provider_json` 的 limit 从只写 context 改为 context+output 双写。启动注入与全局写入共用该函数，两条路一起修好。 |
| v3.145 | **codex 全局写入改走 `requires_openai_auth`（取代 v3.143 的复检注入与 export 指引）**：用户追问「cc-switch 为什么可以直接配置」后的实测发现——codex 自定义 provider 有 `requires_openai_auth = true` 开关：开了即改用 OpenAI 认证（auth.json 的 OPENAI_API_KEY / ChatGPT 登录），不再查 env_key 环境变量（0.149.1 本地抓包实证：无任何环境变量时对自定义 base_url 发出 `Authorization: Bearer <auth.json 密钥>`；doctor auth.credentials 转 ok；用户真实 config.toml 模拟新形状零 fail）。cc-switch 官方账号代理路由（cc-switch-official provider）用的正是同一开关。`patch_codex_config` 改为写 `requires_openai_auth = true`、不再写 env_key，旧写入遗留的 env_key 行顺带清除（ccode provider 表归 Ccode 管，留着误导）；v3.143 加的「复检注入 CODEX_API_KEY」与「成功弹层 export 指引」随之回滚——auth.json 落盘后复检方与外部终端都零 export 可用。启动注入路径（agents.rs 的 -c 内联 provider + env 注钥）不受影响、保持原样。 |
| v3.146 | **「设为全局」进度弹层 + 永久原始快照（恢复初始状态）**：两条同一来源的用户走查反馈——① 确认后写文件 + doctor 复检要几秒到十几秒、零反馈像没反应：顶部横幅被用户否为「不明显」，改为确认后立即弹出 `GlobalApplyDialog` 进度/结果弹层（进行中禁关防误触，完成后同层显示文件清单 + CLI 复检摘要，未通过一键换三层验证详情层；替代原 alertDialog 链）；② 用户连点多次「设为全局」后点「恢复备份」回不到 codex 原模型——常规批次备份每 tag 只留 5 份、清单只留 5 份，连续写入/恢复会把「Ccode 首次动手前」的状态轮换掉。修复：transact 的 apply 路径首次写入时用 `backup_actions` 已读到的写入前内容落 `backups/<agent>/original/` **永久快照**（不参与轮换，prune 不碰子目录；快照失败只记日志不清主流程，半份清掉下次重试），新增 `has_original_backup`/`restore_original_backup` 命令与「恢复初始状态」菜单项（快照里不存在的文件 = 当时 Ccode 新建，恢复即删除；当前状态先存常规批次可反悔；恢复后清「全局生效」标记同 restore 口径）。 |
| v3.147 | **逐 agent 全局写入审计（对照 cc-switch + 隔离 HOME 抓包实证）**：claude/qwen/opencode/kimi/codebuddy 五家 ✅（各自抓包确认 base_url/密钥/模型三要素真实生效，既有字段保留；kimi 的 `default_model` root 落点用同版本 toml_edit 0.22 复刻验证无错位）；**gemini ❌ 唯一硬错误**——只写 `.env` 不够：gemini ≥0.46 在 base URL 存在时把 env 认证推断为 `gateway`，`validateAuthMethod` 不认 → headless 直接 auth 报错起不来，必须加写 `~/.gemini/settings.json` 的 `security.auth.selectedType="gemini-api-key"`（cc-switch `write_packycode_settings` 同口径）。修复：`patch_gemini_settings`（JSONC 容错读复用 `mcp::strip_jsonc`、其余字段保留、损坏拒写）+ `target_specs` 加条目（备份/恢复/原始快照随之覆盖）。实证：隔离 HOME 下 gemini 0.46.0 headless 请求发往 .env 写入的 base_url、URL 模型段 = GEMINI_MODEL（注意 .env 加载有目录信任门槛，真实家目录无此问题）。已知可选改进（非错误，留 backlog）：claude 对未知模型补 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（cc-switch 有）；qwen/kimi 用户文件含 JSONC 注释时严格解析拒写（fail-loud 安全方向）；kimi 模型别名清洗可能撞名（`a.b`/`a/b` 同成 `a_b`）。 |
| v3.148 | **cc-switch 互操作诊断（非 Ccode bug，文档口径）**：用户报「Ccode 设为全局后 cc-switch 改不了 codex」。实证链：① live config 对 codex 有效、无锁无只读标志、严格 TOML 解析通过；② cc-switch DB（~/.cc-switch/cc-switch.db）里 NewAPI provider 的存档 config **已被污染成 Ccode 写入的快照**（含 `model_provider = "ccode"` + `[model_providers.ccode]` 表）——元凶是 cc-switch 的「双向同步回写保护」：切换时把当前 live 配置回填进切走的 provider 记录，Ccode 写入占据 live 期间在 cc-switch 里操作即被吸收，此后「启用 NewAPI」= 把 Ccode 配置原样写回；③ 文件 mtime 顺序（config 先于 auth）证明最后一次写入是 Ccode 的 apply，用户在 cc-switch 试完后又在 Ccode 重设了一次，覆盖了试验结果。Ccode 侧无可修（无法阻止他方快照 live，也不应阻止）；口径入用户手册：同一 agent 的全局写入固定一侧做，被污染的对侧记录在该工具里编辑修正。 |
| v3.149 | **codex catalog 能力字段补齐（对照 cc-switch 模板逐字段比对）**：cc-switch 的 catalog 模板（resources/codex_native_responses_template.json）比 Ccode 多若干字段，逐个评估后补三个真实影响行为的：`effective_context_window_percent: 95`（自动压缩阈值，缺了容易先撞上下文上限才压缩）、`input_modalities`（按能力注册表 `model_supports_vision` 如实声明，只认确知多模态系列）、`supports_search_tool: false`（web_search 是官方 hosted tool，中继不支持，不摆死工具）。刻意不跟的：`apply_patch_tool_type: freeform` 保留（cc-switch 不带是出于它们代理转换场景，Ccode 直连中继无碍）、`support_verbosity: true` 保留。其余 config.toml 声明（MCP/desktop/trust 等）Ccode 是补丁式合并、本就保留用户既有内容——与 cc-switch 整文件替换的口径差异，非能力缺失。实证：带新字段的 catalog 喂 codex 0.149.1，`exec` 正常发请求且不再报 metadata 回落警告。 |
| v3.150 | **模型能力声明全 agent 补齐**（用户场景：第三方模型接入任意 CLI 不应因声明不全丧失能力）：matrix 第 7 条核实有能力声明通道的只有 kimi/codex/opencode/claude 四家，其余五家无此机制（非遗漏）。本期补齐：① claude 写 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（注册表 >200K 才写，不需要时清旧值——claude 对未知模型按 200K 假设）；② kimi capabilities 从「仅 thinking」扩到按模型组合 `tool_use,thinking,image_in`（注册表 `model_supports_vision` 新增，`model_capability` 同源），注入通道（KIMI_MODEL_CAPABILITIES，仅兼容协议）与全局写盘通道（[models.*]）同步改；③ opencode 视觉模型补 `modalities.input` 加 image（实测 1.18.18：缺省条目工具调用本就全开——请求带 10 个工具、stream=true、max_tokens=8192 即 limit.output，无缺失；modalities 形状 debug config 校验通过）。边界口径入 matrix：streaming/function calling/结构化输出是协议层能力（声明补不了）；hosted tools（web search/code interpreter 等）是第一方服务端能力，中继无对应物，如实不声明。 |
| v3.151 | **模型能力分层数据源**（用户拍板：静态注册表对新模型/网关改名模型是卡点）：查询链从「覆盖文件 > 内置表」扩为**用户覆盖 > 网关实测缓存 > 公共能力库 > 内置表 > 关键词兜底**。① 网关实测：`fetch_models` 原先只取 id 丢弃元数据，现顺带解析 OpenRouter 风格 /models 响应的 `context_length`/`architecture.input_modalities`/`top_provider.max_completion_tokens`/`supported_parameters`（reasoning）落 `model-capabilities-relay.json`（合并最新赢、纯 id 列表 no-op、原子写）——网关自己最清楚它卖的模型，含改名模型；② 公共库：配置页 ⋯ 菜单「下载模型能力库」，`download_model_db` 先 models.dev 后 OpenRouter 回落（本机实测 models.dev 直连 60s 超时、OpenRouter 3s 可达），统一解析进 `model-capabilities-db.json`（与覆盖文件同形状，`parse_caps_map` 单一出处），进程内 RwLock 缓存、下载后失效重载；`model_db_status` 报数量与下载时间。ModelCaps 加 `vision: Option<bool>`，`model_supports_vision` 改为「外部源声明优先、确知清单兜底」的并集口径。③ 不做实测探测（发测试请求探能力）：费 token、探不出上下文窗口、不可靠。 |
| v3.152 | **能力查询链改逐字段（修「网关部分字段遮挡公共库」）**：用户追问「网关缓存不完整会不会继续查公共库」暴露真问题——v3.151 的链是整条命中即返回，且 `supported_parameters` 缺席时 thinking 被错记显式 false（「不知道」≠「不会」），网关半份数据会挡住公共库的正确答案。修复：ModelCaps 全字段 Option 化（None = 这层不知道），`chain_field` 逐字段沿链向下找（context 用网关实测、thinking 用公共库可共存），显式 false 只在数据源如实给出时生效；`supported_parameters` 缺席 → thinking=None。附带修了测试隔离缺陷：三个文件型加载器在 `cfg!(test)` 下不读本机真实缓存（本机已下载能力库后，断言内置表值的旧测试会随机器状态漂移）。 |
| v3.153 | **运行页标签栏收口（用户拍板）**：聊天/终端两个并排按钮合并为单击切换（图标显示当前层，再点切到另一层，按标签隔离与 PTY 共享语义不变）。布局菜单去掉文件树显隐（左侧 `PanelLeftOpen` 已是唯一入口）。成果面板升为标签栏右侧常驻按钮（`PanelRightOpen` / 打开后 `PanelRightClose`，写入 `ccode.terminal.rightOpen`），与左侧文件树对仗；专注终端下隐藏该按钮。布局菜单只留分屏对照与专注终端。 |
| v3.154 | **对话页范围增加「按项目」**（用户拍板）：范围选择面在 Agent 手风琴下方增加跨 Agent 的项目分组（`groupSessionsByProjectPath`，比较键 `pathKey`，按最近更新排序）。点项目落 `projectPath` 筛选（不限 Agent），点完回到会话列表；Agent 行展开该 Agent 下项目的既有口径不变。 |
| v3.155 | **对话页范围 Agent 手风琴可收起**：展开态只认 `expandedAgent` 显式开关，不再用当前筛选 agent 做回落（选中后点同一行无法折叠）。Agent 行只展开/收起项目；筛这家改点其下「全部项目」。 |
| v3.156 | **对话页范围排除无头 AI 临时目录**：`ccode-ai-<uuid>` 是 `ai.rs` 为 ◈ 无头调用建的临时 cwd，用完即删。provenance 原 7 天清理后会话文件仍在，被当成普通项目铺满「按项目」。现：① 对话列表把该目录名归入内部 AI（`isCcodeAiTempCwd` / `is_ccode_ai_temp_cwd`，与 UUID 命名同步）；② 内部 provenance 不再 prune；③ 用量统计仍只认 provenance 表，不按路径改写 `usage_daily`。 |
| v3.157 | **运行页文件树搜索隐藏配置 + 折叠钮与双击进入分离**：`search_files` 不再跳过全部 `.` 目录（`.kimi-code` / `.claude` 配置搜不到）；噪声目录仍跳过，隐藏目录在「显示隐藏文件 / 查询以 `.` 开头 / 目录名命中」时进入，点结果自动打开隐藏显示。折叠 chevron 只 toggle，双击进入仍在行上其它区域。 |
| v3.158 | **文件树按后缀搜索**：`pdf` / `.pdf` / `*.pdf` 按扩展名匹配；`doc` 覆盖 `.doc`/`.docx`（ppt/xls/jpg/htm/md 同组）。后缀命中单独成桶优先于文件名包含，避免 50 条上限被名字里带 pdf 的笔记挤掉。 |
| v3.159 | **运行页空白标签默认主仓库 + 表格预览**：无任务标签的默认 cwd 回升到工作区 `repoPath` / 最近注册项目，不继承 lastLaunch 工作树。`.xlsx`/`.xls`/`.ods` 走 calamine 第一张表只读预览（白名单同 PDF/docx）。 |
| v3.160 | **md 阅读本地 png/gif**：渲染前把 img src 改成 data-md-src，避免 WebView 相对路径 404 裂图；本地图走 `read_image_bytes`（加魔数校验）。文件预览允许 https 图；聊天仍不加载外链图。 |
| v3.161 | **md 本地图占位 + 文件树图片预览**：rewrite 把待加载 img 换成 `md-img-pending` span（无 src 的 img 在 WKWebView 仍会画问号）；水合覆盖绝对路径与 marked 百分号编码的中文文件名。文件树点 png/jpg/gif/webp/svg 走 `ImagePreview`（`read_image_bytes` 同一通道），不再落入文本预览的「二进制不支持」。 |
| v3.163 | **运行页空白标签改回家目录**：用户拍板：没必要一直显示当前项目主仓，点进项目再展示其目录。第一次进运行 / 关最后标签 /「＋」空标签默认 `~`，不预填主仓、不继承 lastLaunch 工作树。点项目走既有「真进入」。恢复的任务标签仍用记下的 cwd。 |
| v3.164 | **Excel 宽表预览**：不再 32 列截断 + 每格 `max-w-56` 挤扁。抽指定工作表最多 200×256，列字母/行号冻结可横滑；点格子在顶栏看全文（WKWebView 无 title）。多表底栏切换。只读，不当编辑器。 |
| v3.165 | **md 内嵌图卡在「图片加载中」**：`dangerouslySetInnerHTML` 被父级重绘盖回占位后，水合 effect 因 html 未变不重跑。改为每次 layout 扫剩余 `data-md-src`，本地图读盘结果缓存 32 张。 |
| v3.162 | **会话导出/导入（session-transfer）**：把本机八家 agent（不含 opencode）的会话打成 `.ccode-sessions.zip`（manifest v1 + 原文文件），在另一台 Ccode 导入后列表/回放/注意力/外部恢复可用；跨机路径由向导选定 B 机目录，导入时 JSON 行级改写已知 cwd 键并按各家布局重建落位。manifest 同时记 `projectPath`（列表侧主仓，向导推荐目录）与 `cwd`（会话文件真实工作目录，改写与「本机是否还在」用它）。工作区会话二者不同：改写旧路径取文件 cwd，不以归并后的主仓为准。Mac→Win 落盘目录名经 `fs_safe_component` 去掉非法字符。Codex 内联 `ccode-*` provider 可按 rollout 原名注册到客户端（一批多名指向用户选的一个绑定）。安全是只读原则第五个写例外（zip-slip/白名单/同 id 跳过/原子写）。**已知边界（不藏）**：同 id 只跳过不覆盖；嵌套 tool-call 文件路径不改写；cursor cwd 字段名本机无 jsonl 样本，按扫描器候选名单存在才改；grok 超长路径 slug 的 hash 算法未开源（写 `.cwd` + `info.cwd`，Ccode 列表不依赖目录名）；codex 多网关联名会话全部指向所选绑定；A 机自定义密钥若不符常见前缀，B 机脱敏遮不住（与导出警告一致）。opencode / hooks-state / 云端同步不做。 |
| v3.171 | **科研模板全量收口（用户确认方案）**：① gitignored 产物写项目根——TASK.md 给出项目根与产物目录绝对路径；`papers/` 与 PDF 人工导入强制主仓；合并成功后把工作区未跟踪的 `papers/`、产物目录、`output/` 拷到主仓（已有不覆盖）。② 毕业论文拆成与综述同名的「文献检索与筛选 → 文献精读与笔记 → 开题报告与综述」再接原方法/实验链（8 步）；开题挂 `review-framework`。③ 投稿 `any_of` 含 `thesis-final.md`，返修 r1 优先 `submission/formatted.md`，格式适配渲染 `output/formatted.pdf`。④ 科研论文承认计算实验、有上游笔记则查漏补缺不覆盖；实验设计/findings 审阅改为非可选；清单改名避免与投稿 `checklist.md` 对撞。⑤ LaTeX 改为排版后端（有成稿转写）。⑥ 图主交付 SVG/PNG 进 `figures/`。存量 project.toml 不迁移。 |
| v3.166 | **对话页正文搜索**：搜索框从元数据（标题/标签/步骤/摘要）扩到会话 user/assistant 文本。查询按空白分词（短英文丢掉、汉字单字保留），OR 打分：标题最重、正文按是否命中 + 词频封顶，全部词都中有加分，完整短语再加分；同分按 `updated_at`。正文不进 React，只回脱敏摘录。抽出文本缓存在 `app.db` 的 `session_search_text`（mtime/size 变了才重抽，单次刷新 1.2s 预算），源文件只读；thinking / 工具参数不进索引。已知边界：超长会话只抽前约 8MB JSONL / 96KB 文本。 |
| v3.167 | **搜索命中打开即定位**：命中正文时记下 jsonl 字节偏移（zstd 为解压流偏移）或 OpenCode `time_created`。`get_session_conversation_page` 增加 `around`，打开该对话加载命中附近一窗而不是总是尾部；前端按时间戳/摘录/关键词对准那条消息滚进视野并高亮。压缩会话不能再向前翻页（与原先 zstd 尾窗相同）。定位最多对排序后前 80 条正文命中做二次扫描。 |
| v3.171 | **快速开聊三处收口（用户拍板）**：① 随手聊历史只认 `~/ccode/scratch`（`isScratchCwd`），未注册的编码仓库不再涌进。② 侧栏记住过 agent 即直达终端；勾「每次都先问我」才每次开弹层（旧 `ccode.quickChatSkip=0` 迁成 always-ask）。⌘K / 工作台页头仍开弹层。③ 弹层下半改「继续上次」：最近一条独立按钮，其余列表跟在后面，与「开聊」主路径分开。 |
| v3.170 | **快速开聊随手聊历史同步显示**：弹层打开时不再 `list_sessions` + `list_projects` round-trip（历史区后到把弹层撑高，表现为「顿一下」）。改用启动已进 store 的 `sessions` + `projectPaths` 现算 `pickQuickChatHistory`；`live` 用终端页 `liveSessions` 补标，正在跑的随手聊仍排除。侧栏右键浮层去掉「读取中…」。默认目录即时显示 `~/ccode/scratch`（点开聊才 `ensure_scratch_dir`）；弹层回车提交。 |
| v3.169 | **工作台主卡跟真实运行对齐（用户拍板）**：主卡回答「现在最值得做什么」，数据源不再是「上次选中的项目名 + 全应用运行计数」。① 有 `running` 或待确认的终端标签时，按 cwd 归到已添加项目根（含工作树）或最近仓库，名称用注册名；「N 个运行中」与底栏状态只计这张卡所属目录，点「继续工作」走 `focusTabReq` 激活该标签。② 没有存活工作时才回落项目页上次选中项 / 时间序里最近的已添加项目 / 最近仓库；已添加项读档案卡，副标题为流水线第一个未合并步骤（全完成回末步）。③ 待你处理空着不占右栏，主卡拉满；最近项目不再把已添加项抬到时间序之前；最近对话丢掉无标题条目。纯逻辑 `src/workbench-hero.ts`。 |
| v3.168 | **聊天 ⇄ 终端交接与窥视（不复制 TUI 解析器）**：聊天仍是同一 PTY 的结构化层。新增 `src/chat-handoff.ts` 交接表（chat_ok / peek / must_switch）：普通发送与带参直切命令留在聊天；picker / 审批 / 登录与信任目录默认底栏真实分栏并 fit（约 32% 高度；裁全高 xterm 底部会看到 Codex inline 的空行）；Kimi 首条注入失败仍整层切终端并复制指令。等待文案改为已送出/正在写盘/正在用工具；工具块进会话文件即渲染，assistant 正文才结束等待。聊天尾窗可向前翻页（zstd 无更早页）。头部复用状态栏的模型/思考档；文件拖入聊天输入框（盖住终端的坐标不写 PTY）。斜杠表补 opencode `/models`、codebuddy `/login`。Kimi CSI-u 序列收到 `terminal-input.ts`。聊天 Enter 组词未上屏不发送（WKWebView 上 compositionend 后 isComposing 已假，见 `ime-guard.ts`）。 |
| 2026-09-05 | **科研外部工具三线正式融入**：`origin-plot`、`zotero-sync`、`endnote-bridge` 注册为内置技能，种子版本升至 4；仅 `zotero-sync` 默认挂到英文综述、科研论文、毕业论文的文献检索步骤且为可选技能。Origin 仍是 Windows + Origin 2021+ 的可选外部驱动，图型与期刊规格仍由 `figure-forge` 决定；EndNote 仍只做 XML/RIS 格式桥接，禁止 CWYW 无人值守自动化；内核 `zotero_import` 读取 `zotero.sqlite` 快照、只写项目文件，不写回 Zotero；Zotero 写库只能由技能在用户明确意图和实机授权下执行。`lit_source=zotero` 以库为进料口、技能只补检索缺口；`lit_source=search` 中 Zotero 只是可选导出目标；`lit_source=folder` 不触碰 Zotero。检索步骤不写 `references.bib`、不默认 `autoexport.add`，并始终留下 `papers/zotero-sync.md`；通道不可用时回落 RIS/BibTeX 文件流程，不阻塞科研检索。 |
| 2026-09-02 | **依赖体检 + 一键安装（git/node，三平台）**（用户给的参考流程：首启检测不阻断 → 用到再提示 → 一键装 → 自动复检；两处修正经对齐：git 提到首启检测——worktree 是核心机制，node 不进首启——它只是 npm 渠道依赖）：① **后端 `dep_check.rs`**——`check_dependencies`（git 三态 ok/missing/`clt_stub` + node + 渠道 brew/winget/xcode/none；启动时前端拉一次进 store，不持久化）+ `install_dependency("git"|"node")`：macOS brew 优先（TUNA 镜像自动带）、无 brew 时 git 触发 `xcode-select --install` 系统弹窗**不等待**（弹窗异步、无法流式观测的妥协）由「重新检测」收口；Windows 走 winget `Git.Git`/`OpenJS.NodeJS.LTS`（复用 updater 的 winget_args 模板）；Linux 只给发行版命令指引不一键装（碎片化）。复用 updater.rs 的 `run_streaming_pty` 管线（提 pub(crate)，行为零变化），装完 invalidate 缓存 + 复检写 versionAfter。② **macOS CLT stub 判定**——`/usr/bin/git` 未装 CLT 时是 stub：which 命中但一跑就弹系统窗、还会被版本探测 5s 超时杀掉；必须先 `xcode-select -p` 判定，stub 场景禁跑 `git --version`。③ **缺 git 常驻提醒走收件箱 `dep:` 类别**（不造顶部横幅——v3.146 用户已否「顶部横幅不明显」；dismiss 走既有签名机制，装好自动消失）；设置页「诊断」区加「依赖体检」Row（状态三行 + 重新检测 + 一键安装，照字体安装的 listen+invoke 模式，共享 `useDepInstall` hook）；改动面板与一键开步的「找不到 git」报错经 `isGitMissingError` 升级为带「一键安装 Git」按钮；node 只在连接页 npm 渠道装 CLI 缺它时提示（`installToolHelp` 升级带按钮）。④ **候选目录补齐**——Windows 加 `Program Files\Git\cmd` 三件套（winget 装完 GUI 短 PATH 也能复检命中）；macOS/Linux 加 volta/mise 固定 shim 目录；nvm/fnm 动态版本目录不做（find_in_dirs 不支持 glob，过度工程）。**不做**：首启向导页（体检是 backlog 首启引导完整版的素材但不绑定）、brew/winget 本体一键装（brew 安装要 sudo 交互）。Windows 全流程与 macOS CLT 路径未实机走查，CI 编译 + 单测保底。 |
| v3.172 | **Windows 全链路断点收口**（审查 `docs/audits/windows-audit-2026-08-31.md`，不改 macOS/Linux 行为；原分支编号 v3.153，合并时因主线已占用顺延）：① 外部终端改为 `powershell.exe -NoExit -File` + CREATE_NEW_CONSOLE，禁止 `cmd /C start` 被 `Command::args` 加壳；wrapper 目录/文件 icacls 收紧。② codex `-c` catalog 路径反斜杠改正斜杠（TOML `\U` 非法转义）。③ `ensure_task_project_root` 返回剥 verbatim 的 canonical 根，reader/lit_watch/citation 走 `path_within`。④ MCP 体检超时 `kill_process_tree` + `join_with_timeout` 读 stderr；分发 `.cmd` 深化为 `node + js`。⑤ setup/archive 与 run 脚本走 Git Bash；render-pdf 安装提示补 winget。⑥ git 统一 `-c core.quotepath=false`。⑦ OpenCode 会话探 `%LOCALAPPDATA%\opencode`。⑧ Cursor Windows 安装 fail-loud 指 WSL。⑨ gemini pin 把 `project_path` 写入 session_meta。⑩ 复制命令改 PowerShell 方言。其余：相对路径 MCP 命令按 `Path::is_absolute` 拒写、技能目录跟随 `*_HOME`、会话删除进回收站、grok transcript 走 `same_path`。 |
| v3.173 | **Windows PDF 预览白屏**（用户实测「无法预览、闪屏白屏」；原分支编号 v3.154）：三处叠加。① pdf.js v6 默认 `getContext("2d", { alpha:false })`，Chromium/WebView2 在全局 `color-scheme:dark` 下把不透明 canvas 合成白块；页宿主再叠加 pdf_viewer.css `.textLayer { color-scheme:only light; inset:0 }` 会给盖住 canvas 的 stacking context 铺 Canvas 白底。修复：渲染前先以 `alpha:true` 绑定 2d 上下文（后续 getContext 忽略新属性）、页宿主 `color-scheme: only light`、textLayer 透明底。② `ResizeObserver` 每次回调都 `setRenderKey` 并把 `key` 绑上 renderKey——Windows 经典滚动条出现使 `clientWidth` 跳 ~17px → 拆掉 canvas 重挂 → 滚动条消失 → 振荡闪白。修复：`nextFitScale` 亚像素门槛、`scrollbar-gutter: stable`、页视图 key 只用页码。③ Windows 关掉 ImageDecoder（WebView2 会把部分 JPEG/JBIG2 解成空白位图），macOS 保持默认。口径入 `docs/conventions/terminal.md`。 |
| v3.174 | **Windows「在外部继续」卡顿回退**（原分支编号 v3.155）：v3.172 把可见窗口改成 `start powershell.exe -NoExit -File`，PowerShell 5.1 当 conhost 会包一层 native I/O，Claude/Codex/Gemini 等 TUI 全部变得像 grok 一样慢；启动前还同步 icacls，Defender 下再卡数秒。改回 `start "" /D <cwd> cmd.exe /K powershell.exe -File <wrapper>`（raw_arg 直投、外层 CREATE_NO_WINDOW 不变）：窗口秒开、TUI 控制台是 cmd，powershell 只负责读 wrapper 注入密钥；%APPDATA%\ccode 默认 ACL 已够，热路径不再跑 icacls。禁止再把 powershell `-NoExit` 当成可见宿主。 |
| v3.175 | **Windows 外部终端可选 cmd / PowerShell**（原分支编号 v3.156）：设置页两项可切换。`cmd`（默认）走 `start cmd.exe /K <binary> <args>`，密钥在父进程环境块经 start 继承，命令行过长才写无密钥 UTF-16 `.cmd`；`powershell` 仍走 `-NoExit -File` wrapper。用户可对照哪条更快。 |
| v3.176 | **Codex 官方账号必须盖过磁盘默认渠道**（用户：启动栏选官方账号仍走网关计费）。根因：`~/.codex/config.toml` 的 `model_provider` 指向自定义网关时，官方启动只 `env_remove` 密钥、不改渠道，`-c` 未覆盖则磁盘默认赢。修复：`apply_official_inject` 对本进程注入 `-c model_provider="openai"`（内置 ChatGPT 渠道，读 auth.json/钥匙串；不写 `[model_providers.*]`、不改用户文件）。登录改 `codex login --device-auth`（0.152.1 核实）：内嵌 PTY 里浏览器 OAuth 常写不出 auth.json；设备码印在终端，与 cc-switch「添加官方账号」同路，由 CLI 自己完成，不抄其 in-app OAuth/多账号库。未选模型时磁盘 `model` 仍生效（网关专用名在 ChatGPT 上可能不可用）。外部终端仍走磁盘默认；官方「设为全局」仍是恢复初始快照。**出网是第三层**（用户拍板：设置页「出网代理」+ 连接 extra_env 可覆盖）：官方直连 OpenAI 时国内网络常 WebSocket→HTTPS 被 RST（os error 54）；设置 `outbound_proxy` 只注入官方启动与组头登录（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY/NO_PROXY），网关启动不走、不建本地反代理、官方失败不回落到中转。extra_env 同名键最后覆盖。不解析 TUI 告警。 |
| v3.177 | **运行页聊天/标签栏收口（用户拍板）**：① 聊天头部「窥视终端」改称「拉起终端」，布局菜单不再重复该开关。② 去掉「专注终端」——它就是收起左边工作树；快速开聊 `pt.clean` 改为 `persistTreeOpen(false)`，删除 `focusMode`。③ 布局菜单删除；分屏对照、查找终端输出升为标签栏 lucide 图标（`Columns2` / `Search`，与聊天/终端、成果面板同一套描边）。④ 标签栏查找右侧的 `⋯` 整颗去掉（停止走启动栏、恢复走空态、接力/对话页走对话页）。⑤ 聊天输入区「插入 ⌄」换成 `Plus` 图标。 |
| v3.178 | **只读文献不必挂研究流程**（用户拍板：只想用 Ccode 读文献写笔记，不另做第二产品）：沉浸阅读/写笔记仍要求已添加项目（写沙箱，不是模板门槛）。`pdf_owner_project` 未命中时询问是否把所在文件夹（PDF 在当前终端目录内则用该目录）添加为项目并默认 `pipeline_opt_out`；家目录/盘符根拒绝。无研究流程时「整理为笔记」写项目根 `notes/inbox.md`（`notesInboxTarget`）。模板选择层与空步骤横幅标明只读文献走「不使用研究流程」。不新增「文献精读」迷你模板。 |
| v3.179 | **项目工作方式三档 + 工作台并行「正在进行」**（用户拍板：终身一张主界面，仓库内容不排他）。添加项目在命名后选 **科研 / 编程 / 办公**，写入 `project.toml` `work_mode`（缺省/旧项目 = 科研）。科研维持现页（主题 + 模板）；编程是 git 原语工作树台 + 分支台（目录 `~/ccode/worktrees/<仓>/<分支>`，不占科研工作区库；状态自动归类未开始/正在开发/需同步/等待合并/可清理；创建/进入/删除工作树，fetch/推送/拉取，合并进基准，冲突去终端改动面板）；办公是文档库（类型筛选 + 最近打开，TASK.md 同款就地预览，问 AI 进终端聊天层）。工作台主区改为正在进行列表：第一条大卡、其余紧凑行，按确认 > 运行 > 需同步/等待合并排序，方式标记在行上；编程工作树路径计入项目归属。不做转换、不做任意 git 命令框。 |
| v3.181 | **四张项目页密度对齐（用户拍板修正）**。无流程科研主区 = 文献 / 笔记 / 雷达，空态降档；流程科研不加第五容器，只排序工作区 + 会话折叠。编程/办公吃完整骨架（冲突行置顶、继续上次单卡、端口折叠）。身份段只加方式 pill，不造仪表盘。复用标签补投 prompt。资源清单与会话区抽共享件。 |
| v3.182 | **MCP 页与设置页随窗口变宽**（用户：这两页窗口拉大不适应）。外壳从 `PageFrame width="settings"`（约 1080px 居中）改为 `fluid`，与连接/技能/用量同一档。MCP 五列网格把多出来的宽度分给名称和配置，启用开关留在末列（2026-08-25 限宽是因为当时没有这张网格）。设置行标签列封顶约 20rem，控件跟在标签右侧，主题色卡/快捷键卡/定价表占满主区。不放大按钮和字号。 |
| v3.183 | **项目页三处补口**（用户：建议做的直接补）。无流程文献行「已读」= `list_paper_notes` 配对笔记，「精读」= `included.md` 且无笔记，点「笔记」打开对应 md（再可进沉浸阅读）；办公文档 `officeDocMatchesQuery` 搜文件名/相对路径，无命中「没有匹配」；编程工作树「查看改动」`pendingTerminal.rightTab=git`（冲突行已有「去解决」，不重复）。 |
| v3.180 | **工作方式三档走查收口**。重复添加预读 `project.toml` 并锁定已选定方式（提交时再读一遍，防预填未返回就写回科研）。路径归属一律 `pathWithin`（办公进行中、工作台运行归属）。编程 merge/push 走 `git_long` + `-c commit.gpgsign=false`；`branch -d` 失败不得静默 `-D`。办公问 AI `reuseKey` 到文件；csv 文本预览、`.doc`/rtf/幻灯走系统打开，`file_ext` 小写化。改动面板 `merging` + 冲突分组 + 「取消合并」；冲突引导文案用「终端」。工作台紧凑行保留色点/运行数，回落 hero 带 `workMode`。编程页刷新、overview 按树/分支并行 git。编程 gitignore 不含 `*.pdf`；CLT stub 禁跑 git init；空仓库浏览提示已写初始提交。 |
| v3.184 | **工作台最近项目区分已添加 / 未添加**（用户：和项目列表对不上、外部 Codex 仓库混进来）。数据源仍是 `list_repos`（各 Agent 会话扫 git 仓库，含 Ccode 外的 Codex），不是 `list_projects`。行上已添加用注册名，未添加标「未添加」；点击分流不变（已添加进项目页，未添加进运行页真进入）。纯逻辑 `workbenchRecentRows`。 |
| v3.185 | **工作台跳转 Codex 客户端**（用户：会话能跳客户端，项目也可以）。深链 `codex://threads/new?path=<绝对路径>`（ChatGPT.app 0.152 解析 path 查询参数，在该目录新开对话）。主卡只有「继续工作」是主按钮，「在 Codex 打开」收进底栏微字；最近项目行「Codex」与未添加/时间同一套微字、排在左边。仅 macOS/Windows。URL 单一出处 `src/codex-client.ts`（会话 `codex://threads/<id>` 同源）。 |
| v3.185 | **办公「系统打开」走后端**（用户：Excel 点系统打开报 `opener.open_path not allowed`）。`opener:default` 不含 `allow-open-path`（放行会让 WebView 打开任意可执行文件）。新增 `fs_tree::open_in_system`：项目根 canonicalize + `path_within` + 办公扩展名白名单后 `tauri_plugin_opener::open_path`。 |
| v3.188 | **Codex 中转启动盖掉 ChatGPT hosted 能力**（用户：Ccode 配的 Codex 打 DeepSeek 报 `service_tier=priority` 与 `web_search_20250305`）。catalog 已 `supports_search_tool: false` 仍挡不住请求——工具来自磁盘/ChatGPT 登录默认开。网关启动追加 `-c web_search="disabled"`、`-c service_tier="auto"`（只盖本进程），catalog 加空 `service_tiers`。官方账号启动不注。不写 config.toml。 |
| v3.186 | **问 AI 先选配置 + 官方账号不跟 DeepSeek**。项目区问 AI 弹层选 Agent/配置/模型，可设默认；默认终端面 + 右栏预览（PDF 撑开，同 previewReq）。官方账号启动丢掉中转模型名（`official_model_allowed` 双端镜像），Codex 不再 `-m deepseek` 撞上 `service_tier=priority`。 |
| v3.187 | **无流程项目页列表对齐**。文献/笔记/数据/雷达/会话同一骨架（默认展开先 10 条、搜索、strip）。只读文献身份段不放课题主题占位（有流程仍要）。纯逻辑 `lit-list.ts`。 |
| v3.189 | **办公页双栏与空态 CTA**（用户截图走查）。左文档右对话+定时，不造身份仪表盘、不用彩色 emoji、不把定时任务拆成两个空计数。少文件（<4）收掉「继续上次」卡、列表标最近编辑；子路径只在有目录时显示。文件行用类型色块图标，「进行中」胶囊加点微光。空对话给针对当前文件的建议 +「发起新对话」。纯逻辑 `officeShowContinueCard` / `officeDirLabel` / `officePromptSuggestions`。 |
| v3.190 | **编程页双栏收口**（用户截图走查）。左工作树右会话侧栏（全高竖分界、可收起、零阴影），不造身份仪表盘、不用彩色 emoji、不调 AI 生成标题。按钮分级：创建工作树主色，进入次级，查看改动 ghost，拉取/推送组合，fetch/合并/删除进 ⋯。git 事实 `codingFactChips` 只亮非默认态。会话标题 `tidySessionTitle` 去 URL/中断/resume/未命名噪声，中断改警告胶囊；悬停保留/重命名/删除。否决：侧栏投影、↑0↓0 占位、会话改称「对话」、侧栏「+ 新对话」（快速开聊已是全局入口）。 |
| v3.192 | **项目页按文件夹分级可折叠**（用户截图：Finder 式套夹）。`buildFolderTree`：路径分段建树，本层文件与子文件夹并列；文献剥 `papers/`、笔记剥 `notes/`、数据剥 `data/`。组头 FoldMark + 计数，搜索或筛类型时展开。笔记改走 `list_office_docs` 才能扫到 `notes/` 子夹。 |
| v3.191 | **无头 AI 不自动跟官方 OAuth**（用户：雷达解读甩 Codex `token_revoked` 整段日志；快速开聊选手选官方也是同一条 401）。`chatgpt.com` 401 / `token_revoked` 是 ChatGPT 登录态本身失效，不是官方/API 凭证串台——手选官方仍走 `-c model_provider="openai"` + env_remove API 密钥。`resolve_profile_from` 最近使用回落跳过官方账号（有 API 配置才跳；显式/功能专属/AI 专用仍尊重官方）；`summarize_headless_error` 把 CLI stderr 收成一句中文，雷达解读不再展示 4000 字日志。 |
| v3.192 | **雷达解读快筛化 + 落盘**（用户：进行中白板、三行口号太浅、下次应直接出来）。prompt 五节学术快筛（标题+摘要，禁编造）；结果 `.ccode/watch-explains.json` 按规范化标题去重，list 出口带回，点解读不重跑（面板「重跑」才再调）。加载态「解读进行中…」，不用与 inset 底板同色的骨架条。 |
| v3.193 | **无头 AI 不进本项目会话**（用户：雷达解读和雷达发起的巡检出现在项目会话里）。`filterProjectSessions` / `sessionLooksInternal` 排除 internal、`ccode-ai` 来源、临时 cwd、以及解读/巡检 prompt 标题。新的无头调用按 session id 写入 `session_meta.internal`（`--session-id` 能锁的先锁；Codex 从 stderr `session id:` 回填）。禁止把项目路径登记进 `usage_provenance.internal`——那会把该 Agent 在此项目的交互会话一并藏掉。定时巡检 token 仍按项目归因。 |
| v3.194 | **本项目会话再排除问 AI / 阅读注入**（用户截图：列表仍是「看这份文件」「【阅读上下文】」）。`sessionExcludedFromProjectList` 在 internal 之外再按标题拿掉问 AI、沉浸阅读简报、`.ccode/handoff-` 接力。这些仍是项目对话，对话页照列，不进内部 AI。 |
| v3.196 | **项目页 md 预览走本地图片通道**（用户：办公弹层预览裂成问号）。`OfficePreviewModal` 漏了 `rewriteMdImageHtml` + `hydrateMdImages`，WebView 把相对路径当网站地址拉。与运行页 `FilePreviewEditor` 同口径：占位 span → `read_image_bytes`。 |
| v3.194 | **办公页截图走查**（文件名叠日期/「进行中」、对话标题「看这份文件：/」、右侧栏不能收、文件夹全展开）。文档行 `truncate` + 日期/动作叠槽；`tidySessionTitle` 绝对路径改文件名；右侧对话+定时改编程页同款可收侧栏；文件夹展开集 persist（默认收起，搜索仍展开）。 |
| v3.196 | **无流程科研会话侧栏**（用户：不使用研究流程的科研页也做成可隐藏侧栏）。`liteResearch` 主区改左文献/笔记/数据/雷达、右 `ProjectSessionsSection variant=sidebar`，收起口径同编程/办公。有流程的科研页会话仍在主区下方。 |
| v3.195 | **项目页左侧按工作方式分组**（用户截图：五种类型混排）。rail 按科研 → 编程 → 办公分段，未添加仓库沉底；组内 last_opened；组头微字留白，行上不再写类型。默认选中仍是最近打开项。纯逻辑 `groupByWorkMode`。 |
| v3.198 | **项目区会话「继续」进终端**（用户：点行去对话页，要另有入口直接进 Agent）。`ProjectSessionsSection` 行上常驻「继续」，走 `resumeSessionInTerminal`（含 provider、reuseKey；已在跑则 `focusTab`）。点标题仍 `openSessionReq` 回放。失效且未保留禁用。 |
| v3.197 | **工作台最近项目并入已添加清单**（用户：新建「AI应用教程」不出现）。`workbenchRecentRows` 改为已添加项目 ∪ `list_repos` 会话扫仓库：办公/无 git/还没开过 Agent 会话的新项目也列出；按 lastOpenedAt / 会话 lastActive 降序。最近项目与最近对话默认最多 10 条。 |
| v3.199 | **工作台最近项目去掉常驻 Codex 字**（用户截图：每行「Codex」噪声太大）。跳客户端改悬停外开图标（`SquareArrowOutUpRight`），与「未添加 / 时间」分层；主卡底栏「在 Codex 打开」不动。 |
| v3.200 | **课题主题挪到选模板层顶部**（用户：添加项目不该问课题主题，那是科研流程才要的）。`AddProjectModal` 去掉主题输入；`TemplatePickModal` 第一屏顶部可选填，随 `apply_pipeline_template` 写入；稍后/不用流程若已填也落盘。 |
| v3.200 | **会话收起主区铺满**（用户截图：收起后文献卡右侧仍留空）。收起 aside `w-0 overflow-visible`，展开钮 `-translate-x-full` 叠右上；编程/办公/无流程科研同口径。 |
| v3.201 | **无流程科研去掉身份行 ⋯**（用户截图：右上角三点）。`liteResearch` 不渲染项目菜单；rail 右键仍可重命名/移除。 |
| v3.202 | **能力声明分「确知」与「不知道」两档（写进别人家配置的值不再用估值顶替）**：审计发现 `model_registry` 的兜底层（`fallback_context_size` 128K/256K/1M、关键词推断 thinking、硬编码视觉清单）会把**猜测**当**声明**写进 codex catalog / kimi env / opencode limit / claude env，而兜底层本身是已知会错的一层。后果分两类：① **把真窗口压低**（最严重）——codex `-c model_context_window=131072` 是硬覆盖，codex 自带 registry 认得 272K/1M 的模型会被按 128K 提前压缩，比不写更坏；catalog 的 `context_window` 同理。② **把未知说成确定**——`input_modalities: ["text"]` 替用户断言「这是纯文本模型」，中继上的视觉模型在 CLI 里丢掉图像输入。修复：新增 `model_*_declared_for` 三个**声明层**访问器（只认查询链里的显式值，兜底层不算），并按目标格式的必填性分流——**可省略的就省略**（codex catalog 的 `context_window`/`max_context_window`/`input_modalities`：实证 cc-switch 的 `CODEX_CATALOG_PARSER_REQUIRED_FIELDS` 只列 `supports_reasoning_summaries`，可选字段「缺省=解析器默认」语义要保住；codex `-c` 两键；kimi `KIMI_MODEL_MAX_CONTEXT_SIZE`：实证 2.1.0 二进制走 `parsePositiveInt(raw) ?? DEFAULT_MAX_CONTEXT_SIZE`，不设不报错）；**必填的写保守值但注明是下限**（kimi `config.toml` 的 `max_context_size`：二进制无值时硬抛 `must define a positive max_context_size`；opencode 的 `limit.context`/`limit.output`：条件必填，`limit` 键存在则二者强制）。`model_supports_vision_for` 的硬编码清单收进 `BUILTIN_CAPS`（新增 `capsv`），使「不在表里」真正等于「不知道」。附带修两处语义漂移：① `combo::apply_to_profile` 原来用 `surface.thinking`（bool）决定是否**删除**用户已存的 `reasoning_effort`，未知模型被当成不思考、配置被无声抹掉——改用声明层，只有确知 `false` 才删，未知一律保留；② 代码里「kimi 0.31+ 必填」「codex schema 强制要求 limit.output」等注释是**无实证的版本边界与措辞**（全仓的必填说法源头都是代码注释，文档/CHANGELOG/测试只是复述），已按二进制实证改写，并记下真正的复现缺口（无 `docs/probes/`，probe 输出与 catalog fixture 未归档）。 |
| v3.202 | **编程页 Git / GitHub 环**（规格 `docs/conventions/coding-git.md`）。根因：心智模型与 Desktop 绑的是「一个文件夹的当前检出」，Ccode 用共享 `.git` 的多工作副本。主路径 = 从基准 `worktree add -b` 拉新分支（CTA「从 <base> 开工」与 `fromBase` fail-loud 同船，同名 `branch_exists` 确认后改 Local）；次路径挂已有本地 / `origin/foo`。overview 下发 origin（hostKind 仅精确 `github.com` / `ssh.github.com`）+ remoteBranches + `upstreamBehind`；芯片拆相对基准 vs 相对上游。写操作回 `CodingOpDto`（`git_failed` catch-all），合并不折进该类型。Desktop 只走 `github <absPath>` CLI（macOS 无 CLI 才 `open -a … --cli-open=`；不用已删协议、不用 Windows exe+路径）。开 PR：工作树卡常驻 + GitPanel toast（门控 = `coding_overview.worktrees[].path`，不是 `project.path`）；`gh pr view --web` 否则 `create --web`，未登录 compare URL。v1 不切主仓检出：基准无处检出则给基准建树。不做任意 git 命令框、不做应用内 OAuth。 |
| v3.203 | **添加项目后打开该项目**（用户：加完应跳到新项目页）。注册回调先把该项写入 `projects` 再 `setSelectedGroupKey`；此前先选中再 refresh，分组表还没有这项会被 effect 重置成原来的第一项（与 `onCreateDemo` 同一口径）。 |
| v3.203 | **收起/展开同一位置**（用户：展开钮要在上面，和编程页一样，从哪收从哪开）。收起 aside 只留顶上展开钮（`sticky self-start`，不占 20rem）；钮不进文献/文档筛选行。 |
| v3.204 | **会话栏三页对齐 + 收起铺满**（用户：无流程科研会话偏下；收起后按钮下面仍空）。liteResearch 身份进左栏、会话从项目名顶对齐（同编程/办公）。收起不渲染 aside，展开钮在项目名行右上，主区 100% 宽。 |
| v3.205 | **沉浸阅读 PDF 手势缩放**（用户：顶栏 −/＋ 点着麻烦；随后卡顿/黑屏；再随后鼠标抖、不跟手，双指松手顿一下再抖）。手势只做整页 CSS `transform:scale` + sizer（不经 React），指针锚点同步 scroll；停稳才 bake，同一帧清 transform；旧 canvas 拉伸到新页盒，离屏画完再换。画布像素 `pdfCanvasOutputScale` 夹 4096²。 |
| v3.206 | **Mac 全屏取消红绿灯让位**（用户截图：全屏三个按钮收起，标题栏左边空一块）。`isFullscreen` 为真时顶栏与阅读区顶栏不用 `pl-[78px]`。纯逻辑 `macOverlayPadClass`。 |
| v3.207 | **项目会话「继续」改悬停符号**（用户：不必一直显示「继续」，用符号和后面两个并排）。行上空闲只留标题+日期；悬停 ▶ 与 ⚑ / ✎ 并排，走 `resumeSessionInTerminal`。点标题仍回放。失效且未保留禁用。 |
| v3.208 | **运行页项目区覆盖并行的已添加项目**（用户：多项目同时进行时左侧要能看见别的项目文件夹）。`buildProjectRailSections`：科研活跃工作区 ∪ 活标签（running/confirm）归属的已添加项目（编程工作树经 coding_overview 路径）∪ 当前 cwd。不铺编程树/办公文档；文件树仍一棵。 |
| v3.209 | **办公继续上次去白板 + 文件「进行中」收口**（用户截图：白卡片突兀；七月的 gif 也标进行中）。继续上次不再 `bg-raised`，与文档 strip 同底。文件行进行中只认 `officeFileReuseKey` 对上的活标签（running/confirm）；七日内打开预览 / 项目根 cwd 不再标。工作台项目卡仍用 `isOfficeInProgress`（仓级）。 |
| v3.209 | **文件树单击只原地开合**（用户：点一次展开、再点进去；箭头连点无效）。行上拿掉双击进入；箭头不再 `detail>1` 吞第二次点击。钻取改悬停「进入」。 |
| v3.210 | **kimi capabilities 改为补集写入（实证纠错）**。二进制实证（`~/.kimi-code/bin/kimi` 2.1.0）推翻了旧注释：`capabilities` 是**完备声明**（`capabilities.some(===)` 判成员，不在表里==不支持），而 `["tool_use"]` 缺省属于 `CUSTOM_REGISTRY_DEFAULT_CAPABILITIES`（自定义注册项），**不是** env 通道——env 未设时走 `DEFAULT_CAPABILITIES = ["image_in","thinking"]`（**不含 tool_use**）。旧实现「think/vision 都假就整键省略」在 env 通道会把 tool_use 交给缺省（丢工具），而「thinking 真」时写 `tool_use,thinking` 又会摘掉缺省本有的 image_in。现改为：`thinking != Some(false)` 保留、`vision != Some(false)` 保留，恒含 `tool_use`——只可能加、不可能减，确知为假才摘。config.toml 通道不同：`capabilities` 为 schema 可选、缺失时由 `capabilitiesForModel` 按模型自身布尔线索推导（`resolveCapabilities` 的 `["tool_use"]` 仅属注册项路径），边界猜不出，故改为仅写 `== Some(true)`、未确知整键省略。两者都停用估值层（关键词推断/保守默认）参与声明。同步修 `apply_to_profile` 删除语义：剥 `reasoning_effort` 需 `model_thinking_declared_for == Some(false)`，未知不再当不思考剥掉用户配置。补 combo.rs 测试 4 例。 |
| v3.210 | **项目页内容井跟画布走**（用户截图：文档容器浅色下是一块白）。`.ccode-well` = `color-mix(canvas 62%, strip)`，办公文档/笔记/文献/雷达/工作树/定时任务卡从 `bg-strip` 换过来。浅色 strip 近白、混画布才同色相。 |
| v3.211 | **文献「已读」去语义绿**（用户：绿胶囊不协调，深浅都要舒服）。`ResourceListSection` 已读从 `bg-ok text-ok-text` 改为 `bg-inset text-l3`；精读仍描边。ok 绿留给结果/成功，不铺状态微标。 |
| 2026-09-04 | **自定义主题（一个槽）**：用户只选左栏/画布/强调，`custom-theme.ts` 派生其余令牌写到 `:root` inline 变量。id `custom` / `custom-light` 由画布亮度现算，不进十四套清单、不进 App.css。状态色/hover/开关仍走 `[data-theme$="-light"]`。settings.rs 白名单加这两 id + `customTheme` 三色校验。切回预设必须清 inline 变量。另存色卡 `customThemes`（最多 12，名字+三色）；`theme` 仍是 custom/custom-light，选中卡用 `customThemeCardId`。改取色器清空卡 id（回到正在调的自定义），不覆盖已存卡。 |
| 2026-09-04 | **应用自更新提示收口**：原先启动 `check()` 命中后只在设置页「更新」分区标绿点，默认分区是外观、失败还写成「未发现新版本」，用户几乎看不见。改：① 收件箱 `update:` 类别（顶栏胶囊 / 工作台待你处理 / 项目页 strip），点「去安装」走既有 `settingsSectionReq`；项目页未挂载时 `visibleInboxItems` 现算合并，不造横幅、侧栏不挂徽标（v3.59/v3.146）。② 检查三态（checking/none/error/dev）+ 失败中文摘要，开发模式不打 GitHub。③ 下载进度；http(s) 出网代理可带给 updater。④ 发版 `vX.Y.Z` 必须与 package.json / tauri.conf.json / Cargo.toml version 一致（CI package job 拦），updater 只认这个版本不认决策号。纯逻辑 `src/app-update.ts`。 |
| v3.211 | **Excel 预览走查**（用户截图：弹层裁掉「输出」列、文件名出现两次、合并表头变成空格）。办公弹层表格加宽（约 96vw/1280）、网格自己滚动；xlsx 读 `merged_regions` 做 rowspan/colspan；格子去掉 `max-w-48` 改横滑看全列。只读，不当编辑器。 |
| v3.212 | **项目侧栏「＋ 新对话」三页对齐**（用户：办公有，无流程科研/编程没有）。`ProjectSessionsSection.onNewChat`；`beginProjectChat` + `projectChatReuseKey`。办公沿用 `office:…:project`。覆盖 v3.190 对编程侧栏「+ 新对话」的否决。 |
| v3.213 | **终端未启动空态去重**（用户截图：中间小卡浮在白纸上，Codex / 配置 / 模型说了三遍）。卡上删掉 agent+配置身份行，改「将在 {目录} 启动/恢复」（点击选文件夹，家目录折 `~`）；底栏无 PTY 时只留状态点 + 目录胶囊，模型芯片/git 等进程起来再出现。卡片从玻璃拟态+大投影改 `.ccode-well` + 极浅勾边，补齐 v3.92 点阵网格（此前约定有、代码没有）。启动栏模型段加宽到 18rem。技能未启动写入首条指令仍藏在高级选项，本批不动。纯逻辑 `src/terminal-welcome.ts`。 |
| v3.214 | **聊天空态去重**（用户截图：中央「从一个问题开始」+ 头上「等待会话文件」；随后否点阵铺满「很丑」）。未发过也没在跑时不把同步通道默认 `waiting` 显示成丢了文件；答案在输入框（占位「问一个问题…」），目录短句收进 composer 底栏。**聊天画布不加点阵**（点阵只留终端未启动卡周围）。＋新建/历史会话建立后才出现。`chatHeaderStatus` 在 `chat-handoff.ts`。 |
| v3.215 | **科研英雄路径收口（对外入口不变）**：示例课题改为 15 分钟精读环（检索步 `seed_complete`、开读进三栏），步骤与内置英文综述模板同一份 JSON；开步确认后 `autoStart`；合并后按 `expected_artifacts` 自动提货；雷达收件箱按篇标题开读；接力 prompt 改科研小节，「去下一步」把简报写入草稿。编程/办公入口不收。 |
| 2026-09-07 | **「开读这一篇」不得漏到普通模板**（用户：全部模板流程线都出现该按钮）。根因是 v3.215 按「项目有 PDF 资源」给所有步骤挂 `onReadPaper`。改为 `demoReadPaperResource`：仅示例课题（`seedComplete`）+ 当前精读步（`lit-notes`）+ 已有 PDF。普通模板只显示「开始」。 |
| 2026-09-07 | **对话页 Codex「加载更早对话」卡死**：JSONL 按 192KB 切窗，Codex 工具行常超过窗口；旧逻辑在超长行尾把 cursor 设回本窗终点，再点同一窗。改为整行跳过 + 空窗连跳（上限约 4.5MB/次）。zstd 压缩会话仍无更早页。 |
| 2026-09-07 | **保护路径填写口收口**（用户：看到根本不会填）。规则栏不再写「哪些数据不能动」；保护栏标题改「不要覆盖的文件夹」，说明一行一个文件夹名（`数据/raw`），无芯片时提示对着文件页抄名字。 |
| 2026-09-07 | **保护路径语义与勾选**（用户：不要覆盖是审核合并还是留副本？对着文件名填不方便）。含义定死：验收写回时勾上的文件夹保持项目原样，独立副本改动不写回；不是另存一份，也不是审核后再合并。UI 改为顶层+下一层文件夹勾选，不再手填路径。 |
| 2026-09-07 | **保护勾选排版**（用户截图：子文件夹整树摊开、同名项重复；随后：文件不能勾）。只列项目根下一层，文件夹和文件都能勾；勾文件夹覆盖其内全部。说明压成一句，列表限高滚动。 |
| 2026-09-07 | **项目对话列表收口**（用户：全部列出来；行上只留继续和归档符号，其余进可选项；归档之前只有删除）。`filterProjectSessions` 默认不截断、排除已归档。行悬停 ▶ 继续 + 归档，保留/重命名/删除进 ⋯。归档从本列表拿掉，不删文件。 |
| 2026-09-07 | **编程页符号与领先落后**（用户：符号要专业；分支领先落后用状态条）。去掉 ⇡⇣↑↓∅*。相对基准 ahead/behind 用双向状态条（`codingDivergenceBar`）；其余事实 Lucide 芯片；进入改 Terminal。 |
| v3.216 | **项目页内容井再抬半档**（用户：降一层后跟画布分不清）。`.ccode-well` 从 `color-mix(canvas 62%, strip)` 改为 `canvas 40%`：仍在 canvas→strip 之间、色相跟画布，浅色能看成一层，不到纯 strip 白纸。 |
| v3.217 | **对话搜索点进即定位（修 v3.167）**：搜索本身已有摘录；点开会话却常停在末尾。根因两处——① kimi 等把一条 assistant 拆成 `step.begin` + 多条 `content.part`，定位按单行 `parse_session_lines` 拿不到正文，`around` 为空就加载尾窗；改为整段 parse 再用命中原文去 jsonl 找字节偏移。② 摘录把换行收成空格，前端按原文 `includes` 对不上；改为空白折叠，同一秒多条用摘录区分。回放展开超长正文并标出关键词。 |
| v3.218 | **自定义定时任务 = 巡检技能 + 挂日程**（用户：除文献雷达外技能下拉不能用；复杂技能要跟 Agent 写完再落盘）。种类 = 文献雷达 / 已有「巡检」技能 / 新建。新建：意图+日程 → 跟 AI 写 `.ccode/drafts/watch-*.md` → 确认才入库并分发、再 `create_schedule`。`Schedule.skill` 用目录名。非 lit-watch 跑前检查已分发。不在任务记录里存 prompt。 |
| v3.219 | **定时任务入口按工作方式露面**（用户：无流程科研页没有；编程要不要放）。无流程科研挂主区雷达下（该页无 ⋯，抽屉进不去）；有流程仍在项目设置抽屉。编程右侧会话栏下与办公同款。 |
| v3.220 | **档案卡文件头勿删注释**（用户：GitHub Desktop 丢弃未跟踪 `.ccode/` 后网页设计掉回科研）。`work_mode` 只在 `project.toml`，缺省 research。写入时补两行文件头（缺则补、已有不重复），Git 客户端 diff 先看到勿删说明。不把工作方式再抄一份进 app.db。 |
| v3.221 | **多 Agent 工作台对象模型定稿**（规格 `docs/conventions/agent-workbench.md`）。产品合同：人指挥的工作台，不是 CLI 聚合器，也不是自动拆工的 OS。一等对象 Project → Task → Run；终端标签是 Run 的视图。并行只来自人声明或模板（编程「再开一条」/Lane），禁止自动拆任务与智能路由（v3.5/v3.7 维持）。科研/编程两套 worktree 库不合并。Agent 是 Runtime，CLI 是第一种实现（LocalCli / Headless / Custom；Cloud 等稳定官方 API 再加规格，不预研不自建）。分期：0 表面优化（工作台列出多次 Run、编程再开一条与最短 TASK.md、标签/收件箱先任务名、能力表只读/无头）→ 1 Run 表 → 2 编程 Lane → 3 RuntimeKind+Custom。定时任务默认进入隔离 worktree，非 Git 项目失败；仅显式 sentinel 可写主仓（约定 §7）。不为 OS 叙事重做八页信息架构。 |
| v3.222 | **第 1 期「正在进行」不含无头**（用户：定时雷达/阅读问 AI/无头没有保留价值，会变成信息噪声）。机器层仍可给无头 Run 编号（对账、失败归因、继续标 `internal` 不进本项目会话）；人看见的工作台「正在进行」只列交互活（开步、工作树、普通终端、阅读区**仍开着的**标签）。无头成功只更新雷达/收件箱，失败一条「巡检没跑完」，不冒充可恢复对话。规格改 `docs/conventions/agent-workbench.md` §4。 |
| v3.223 | **未来三期路线收口**：①先做 Run 身份（`runs` 表，交互 spawn 必有 id，无头 internal，收件箱逐步改用 `action.run`）；②再把编程车道升格为 Task（`coding_lanes` 主题分组，仍由人声明）；③最后抽出可替换 Runtime（Custom 最小闭环，相对路径拒写；Cloud 仅预留，不预研）。已有表面优化是当前基线，不另列为一期。 |
| v3.223 | **Codex 三条渠道分开**（用户：Ccode 里 401 Missing bearer，同一会话在 Codex 客户端能继续）。根因是自动恢复把磁盘 `custom` / 未登录官方接到 `-c model_provider="openai"` 且清掉密钥。`pickResumeProfile`：`ccode*`→网关，`openai`→官方（未登录改网关），其他名字→只挑网关；启动栏未登录官方不预选，硬启动先说明；对话页标渠道。不把客户端渠道伪装成官方。 |
| v3.224 | **第 0–3 期收口**：工作台「正在进行」含还开着的阅读/任务标签（含自定义运行时），仍排除登录、无头、空闲未命名 shell；交互 Run 补 project_root/task_ref，无头一次性 prompt = discuss；编程行展示车道名与空闲/Agent，⋯ 点选自定义运行时并登记 `runtime=custom` 的 Run。定时隔离树已落地：默认使用 `~/ccode/watch-worktrees/<repo>/<schedule-id>`，仅显式 sentinel 可写主仓。 |
| v3.225 | **工作台约定对账收口**（对照 `agent-workbench.md`）。定时隔离接上回流：建树播种 `watchlist`/`inbox` 等，收件箱「去评审」打开隔离树只读 diff，人点「采纳进主仓」才拷产出；超时与真失败分列。关标签后工作台「继续」按可恢复 `runId` 找回，收件箱待确认无 `runId` 时仍带活标签不丢条。启动入口 `PendingTerminal.permission`（`discuss`/`write_tree`），旧 `readonly` 仅回落。旧 `wt:` 升格为 `lane:`。Cloud / sentinel UI / Runtime trait 仍不做。 |
| v3.226 | **项目任务/文件/Agents 三视图与自由任务闭环**：已注册项目在现有项目页增加「科研任务 / 工作任务 / 编程任务 + 文件 + Agents」三视图；默认页签按项目记忆，文件视图只读展示真实目录并保留跳终端/预览/系统定位入口，Agents 视图保存项目级默认 Agent id（不保存密钥/profile）。新增独立「定时巡检」侧栏页汇总计划与历史；原科研流程、办公/编程页面、对话/运行入口保持不变。自由科研与工作任务复用 app.db 的 Task/Run，写入任务先复制到 Ccode 独立目录，完成后用户采纳输出才回写项目根。
| v3.227 | **项目 Agent 配置细化**：绑定名称从共享 Gateway 名称中独立为 Binding.name；同一 Agent 可在同一网关下保存不同模型选择；项目 `app.db` 按 Agent 保存默认 profile id。Agents 视图列出该项目可用的全部 profile，任务/科研开工/项目文件问 AI 优先使用项目默认 Agent + profile，仍允许单次覆盖；旧绑定无 name 时回退网关名。 |
| v3.228 | **任务创建与工作项目表面去重**：新建自由科研/工作任务默认使用整个项目作为输入，写入任务默认把独立副本中的新增/修改文件作为输出；输入/输出路径降为「调整范围」下的高级选项，采纳不自动同步删除。工作项目任务页本身已包含文档文件夹和项目对话，因此不再显示重复的「文件」页签；科研/编程项目保留独立文件视图。 |
| v3.229 | **项目三视图收口**：任务页回到「事情进行到哪」——办公/无流程科研以自由任务列表为主面（名称+目标即开始，进行中可继续），不再叠在文档库上；有流程科研/编程主面不变。文件页恢复三种工作方式都有：科研/编程就地预览真实目录，办公文件页沿用文档库。Agents 页收成默认 Agent + 该 Agent 默认配置（点选即存）。待审核列出新增/修改文件，勾选后才回写；未勾选不覆盖。 |
| v3.230 | **三视图再收口**：无流程科研任务页回到文献/笔记/雷达，不再在下面叠文件、也不再提供「新建任务」。「新建任务」只留在工作项目，含义是让 Agent 在副本里改文件、人勾选后写回；看文件走文件页。科研/编程文件页改为左目录右预览（源码走 FilePreviewEditor，与运行页右栏同一套），点文件不跳走、不改用系统打开。 |
| v3.231 | **文件页三态合一**：科研/工作/编程的「文件」都是左目录右预览；预览区滚动时左侧列表固定；侧边预览可一键切成窗口预览。文件类型徽标统一为 `fileTypeIcon` 短标签，不再用办公页那套按种类换 Lucide 图标。 |
| v3.232 | **人声明任务，不是对话包装**（用户：若任务系统不改变 Agent 的工作方式，只是把对话重新包装，就没有产品价值）。无流程科研/办公的「新建任务」= 人把一件复杂事拆成步骤：显式选资料（不带入 / 勾选路径 / 整个项目）、选 Agent、写入进独立副本后审核回流。禁止静默默认整个项目（废止 v3.228 的默认整仓复制）。列表只显示 `user:` 声明步骤，会话自动登记的路径名 Task 不进列表。＋新对话仍在项目根直接聊。禁止自动拆任务 / 智能路由（v3.5 / v3.7 维持）。有流程科研与编程入口不变。 |
| v3.233 | **项目 Agents 名册**（随 v3.232：任务按步骤选 Agent 之后，两下拉的「项目默认」页对不上控制层）。Agents 页改为这个项目的名册：每家自己的默认配置、谁是＋新对话默认、各 Agent 正在负责哪些声明步骤。不自动分派、不进连接/密钥。有流程科研仍在开步弹层选 Agent，编程仍在工作树里选。 |
| v3.234 | **项目页顶栏是当前项目身份**：去掉「项目」页名 + 「添加项目」胶囊；名称、工作方式、课题主题、校验、路径和 ⋯ 提到页顶，文件/Agents 页也看得到。添加项目只留左侧列表 +。 |
| v3.235 | **Agent Workspace 第一期**：产品是项目工作环境（Context Pack + 目标 + 验收），不是编排器。新建目标一句话、默认整仓隔离、验收后写回；＋新对话默认直接改、可选验收后写入。不自动建分类空目录。编程 Git 环不动，只注入 Pack。Run 不进用户手册。 |
| v3.236 | **同一目标出下一版 + 文件关联**：验收不满意写意见，沿用上一版隔离目录再跑（不新建目标）。列表标第 N 版。文件页给待验收文件打标。Context Pack 带上已验收目标名和修改意见。 |
| v3.237 | **项目环境补齐**：项目规则可编辑（`settings` + `rules_owned`，未改过仍补工作方式默认条）；保护路径 `protected_paths` 验收写回拒绝覆盖；目标可先记下再开始；列表按尚未开始/进行中/待验收/已完成分组，时间线是「生成 → 意见 → 第 N 版 → 已接受」。验收层只列事实（产出、改动文件、Agent、版次、上一版意见）。Context Pack 带已验收产出路径、未完成目标和保护路径。不自动建空目录、不加人设 Agent、不改编程 Git 环。 |
| v3.238 | **三种工作方式的验收分开**：科研目标按文献/笔记/数据/论文分组验收产物；工作目标按文档/表格/幻灯分组验收文档；编程仍走工作树改动面板、合进基准、PR，不套目标验收弹层。文案、文件页打标、工作台待验收行、＋新对话「验收后写入」随工作方式变化。 |
| v3.239 | **四期收口**：三种任务页第一眼分开（科研目标+雷达，工作文档目标，编程从基准开工）；规则默认收起；保护路径只建议数据/合同类目录。验收接受写入 `.ccode/project-status.json`，任务页头部「项目现在：…」，Context Pack 带工作环境、已验收产出与意见。验收条目可就地预览。编程 Git 环不动。 |
| v3.240 | **对话 / 巡检 / Agents 对齐工作环境**：对话页按项目看历史（chip 称目标，不进后台巡检）。定时巡检只在项目内创建，侧栏页只汇总；不进正在进行。项目 Agents 是名册（＋新对话默认 + 正在负责的目标），点目标回任务页，不自动分派。 |
| v3.241 | **目标和开聊分开**：空项目写清「成稿用新建目标、问一句用＋新对话」。新建目标弹层先一句话，资料/Agent 默认收起。验收后「项目现在」更显眼。产品策略：模型越强越不跟 CLI 比聊天，管环境和验收。 |
| v3.242 | **Agents 绑定可见、编程页收字**：项目 Agents 点配置名换该项目绑定（一条也有下拉，可去连接页添加）；默认家常显「默认」。没有目标时整页一句空状态，不逐家重复「还没有目标交给这家」。编程工作树 ⋯ 可事后分组（未分组也能再分组）；开工表单不再先填名称/主题；行内动作与 git 事实改图标/符号，悬停看说明；分支列表默认收起。 |
| v3.243 | **无流程科研任务页收成模块**：目标 + 文献雷达（折叠头+图标工具）。对话收起后重开按钮进「目标」标题行，与办公页对齐。数据/图像不在任务页预留空块，文件浏览仍在「文件」。以后要盯的工作再加同款折叠模块。 |
| v3.244 | **文件页与规则面板收字**：文件页顶栏改类型图标（空类型不占位）+ 搜索 + 刷新，去掉重复「项目文件」标题。规则面板去掉说明句，「保持原样」默认收起，数据/合同类目录排前。 |
| v3.245 | **密度铺完**：文件/办公行悬停改图标；办公筛选与文件页同一套图标。雷达条目动作改图标，徽章保留。项目对话未命名显示「对话」，超过 8 条收进「更早」。有进行中/待验收/没做完的目标时雷达默认收起，「项目现在」加大。 |
| v3.246 | **工作台只对齐两处**：最近对话与项目侧栏同一套标题清洗，未命名不列。正在进行副行优先「某目标待验收/进行中」，没有才回落到步骤名。不搬文件筛选、雷达书签、规则面板。 |
| v3.247 | **一句话贯穿 + 对话/运行/验收收字**：收件箱与工作台正在进行用同一句「项目现在」（名字+状态）。全局对话页与项目侧栏同一套标题清洗，未命名显示「对话」，列表全部展开不收「更早」；标题留首句、不砍成首词，Grok `<user_query>` 在解析时剥掉不进回放。运行页改动面板收字；终端底部状态栏仍用英文（Commit & Push）。验收弹层分三段：勾选写进项目、写意见再出一版、接受后记住路径。 |
| v3.239 | **雷达新命中收成精读清单密度**（用户截图：每条下面铺英文摘要太乱；随后：不一定要一行一条，必要信息要留）。默认两行：标题截断 + 中文一句话/期刊/日期；点开才看英文摘要。禁止摘要墙，也不把标题挤回单行。 |
| v3.243 | **会话导出后直接出「打开」**（用户：会话的导出直接显示打开按钮）。Markdown / 会话包导出成功后，回放头与批量栏出「打开」，`revealItemInDir` 在文件管理器定位该文件；不再铺截断路径。 |
| v3.247 | **深色内容井抬到 inset**（用户截图：编程项目页深色有点暗）。`.ccode-well` 深色改 `inset`，浅色仍混 40% 画布；工作树卡不再贴死画布。 |
| v3.248 | **展示名改为 Mesa**（用户：可以换名；随后定为 Mesa）。只改窗口标题、安装包 productName、界面/手册里的产品名、`TERM_PROGRAM`、Codex provider 显示名。不改 bundle ID `com.ccode.dev`、项目 `.ccode/`、`~/ccode/`、Codex provider 键 `ccode`/`ccode-<短id>`、仓库 `hongtongzhou-design/ccode`。旧自动提交前缀 `Ccode:` 与档案卡「Ccode 项目档案卡」仍识别。 |
| v3.249 | **Codex「设为全局」不再写 auth.json**（用户：Ccode 配完再撤销，cc-switch 配 Codex 报 401 Incorrect API key，请求打到 api.openai.com）。根因是 v3.145 把中转密钥写入 `auth.json` 的 `OPENAI_API_KEY` 单槽；撤销只滚回 `config.toml` 的渠道选择，密钥槽仍是中转 key，Codex 默认走内置 `openai` → 官方拒。改为密钥只写 provider 块、**不碰 auth.json**。 |
| v3.250 | **Codex 客户端续聊渠道定义**（用户：ChatGPT 无法加载 config.toml，Model provider `ccode-…` not found）。ChatGPT 自带 Codex 的 `ModelProviderInfo` 认 `experimental_bearer_token`，不认写在 provider 上的 `http_headers`（那是 MCP 字段）；写了客户端整段渠道加载失败。设为全局/注册改为 `experimental_bearer_token` + `requires_openai_auth = false`，并清掉旧 `http_headers`。 |
| v3.251 | **配置模块顺带收口**：catalog 补 `supports_reasoning_summaries`（≥0.144.5 缺则整份目录被拒，设为全局会写进 ChatGPT 读的 `model_catalog_json`）；「移除注册」若该块正是 `model_provider` 默认则拒绝（只删块会留下指向空渠道）；带 `http_headers` 的旧块不当成已注册，菜单才能再点「注册」迁走。 |
| v3.252 | **对话搜索含已归档**（用户：搜不到已归档会话）。搜索时放宽归档排除，命中沉底挂「已归档」组头；左侧分类计数仍不含归档，不必先开快筛。 |
| v3.252 | **Codex「设为全局」保留但挡路**（用户拍板）。检测到 cc-switch catalog / `custom` 渠道时连接页二次确认，默认焦点在取消；托盘不写盘，通知去连接页。不挡注册到客户端。Mesa 内仍只注入。 |
| v3.253 | **设为全局挡路扩到所有 Agent**（用户：其他 agent 也同样设置）。本机有 `~/.cc-switch` 时 Claude/Gemini/Qwen/OpenCode/CodeBuddy/Kimi/Grok 同样二次确认、托盘不写。Codex 仍叠加 live custom/catalog 检测。cursor 不支持设为全局，不挡。 |
| v3.250 | **侧栏 Mesa 字标**（用户截图：标题有点小、位置不对）。字标改 `.ccode-brand-mark` 20px/600、略收字距，不走按钮 `text-*`（会被 `font: inherit` 吞掉）。水平与「工作」组头对齐（`px-3.5`），贴底靠近导航，去掉 `tracking-wide`。 |
| v3.254 | **MCP 预设支持 stdio + 安装引导**：remote 填 url/headers；stdio 填 command/args，`{home}` 打开表单时展开为家目录绝对路径（三平台统一走家目录，不用官方 Windows 示例的 `C:\`）。需要本机软件的 server 用 setup 步骤引导，Mesa 不代装。从预设新建点「添加并启用」即写入 MCP 可写的 Agent，新开对话可用（Grok 只读除外）。Blender 官方 MCP 走这条：`uv --directory ~/blender_mcp/mcp run --with mcp<2 blender-mcp`（官方依赖 `mcp>=1.2.0` 会装到 v2，`FastMCP`/`MCPServer` 改名后秒退），先装 Blender 5.1 与官方插件。打开弹层只读探测本机（Blender 版本 / 插件文件 / uv / `~/blender_mcp` / TCP 9876），已就绪打勾，查不到不假装完成。 |
| v3.257 | **聚合读取加有界防线**（审计 N2 收口；云同步/网络盘无响应时项目列表、引用检查、PDF 预览整个挂死）。根因是 `list_projects_in` 回填 id 与 `project_roots_and_resources` 聚合白名单都**逐个同步**读每个注册项目的 `.ccode/project.toml`，而 iCloud「桌面与文档」未落地态、网络盘断连时 `open()` 在内核里阻塞（`O_NONBLOCK` 也堵）——2026-09-13 只修了测试侧（`cfg!(test)` 空返回），产品侧一直没修。`storage.rs` 加有界读取：阻塞在 syscall 内无中断点，只能放线程 + 调用方按预算放弃；超时路径记入 `stuck_reads`，后续调用直接 `StillStuck` 不再新起线程（否则 2s 轮询 × 坏路径数＝线程无界增长）；批量读**共享总预算**（N 个坏路径仍是 2s，不是 N×2s）；线程读完置标志，下次读取自动移出记账表——**恢复无需用户操作**，故日志只说到「文件系统恢复后自动重新可读」。超时只让该项目资源缺席并记 warn（重复观察不记，免得刷爆日志）。未采用「注册时禁止云同步目录」：枚举式启发列不全云服务，且挡掉合法用法。 |
| v3.256 | **能力写入记账 + 黄金样本**（模块审计收口，非用户报障）。新增 `capability_manifest.rs`：全表登记「哪个 agent × 哪个目标键 × requiredness/completeness/harm × 依据强度」，未知时动作由属性推出而非逐行写死，配五条检查（新增 CLI 必须显式记账、免除须带理由、完备声明不得用保守下限、必填不得 Omit、kimi env 必须取并集）。新增 `capability_golden.rs` + `tests/golden/capability_writes.json`：按**用户可见的最终文本**（启动 env 表、写盘的 toml/json）锁住跨层结论——此前单测逐写入点各断各的，kimi `KIMI_MODEL_CAPABILITIES` 那条错的注释（缺省集被当成 `["tool_use"]`，实为 `["image_in","thinking"]` 且**不含 tool_use**，非思考模型整个不写＝静默剥夺工具能力）正是因为没人对照过「注册链说了什么」与「CLI 收到什么」才活下来。 |
| v3.256 | **旧密钥认领加歧义闸门**（模块审计收口）。`repair_legacy_key_links` 的判据是密钥尾 4 位，但拆分迁移没把旧 `base_url` 留在 binding 上，端点身份无从比对——文档注释却声称检测「换过端点」。改为承认这个上限并消除歧义：尾号在多个网关间撞车时不认领（留作孤立密钥），因为错误认领会把 A 的密钥装给 B，表现为请求持续 401 而 UI 显示已配置。 |
| 2026-09-18 | **评审沉淀不得顶掉 TASK.md 模板**（用户：精读步任务书只剩「上一步评审沉淀」一段）。根因是 v3.72 `append_step_draft` 在下一步无文件时只写标题头+沉淀段，开工弹层把非 `isDecisionsOnly` 的草稿当全文。闸门改为 `isTaskMdStub`（空/仅标题/仅已定方向/仅评审沉淀），`resolveTaskMdSource` 走模板拼装并把沉淀接到后面；预览/播种同一口径。精读步模板简报未改。 |
| 2026-09-18 | **精读开工不把 papers/ 已接到的 PDF 再标未登记**（用户：13 个未登记文件是不是我一篇篇下的付费文献）。检索步 Agent 把开放获取全文直写 `papers/`（作者年份-短标题.pdf），不写档案卡；付费墙「获取全文」才登记。弹层「上一步接到 papers/ · N 篇」已计数。未登记列表改排除本步骤声明输入（`isDeclaredStepInput`）。 |
| 2026-09-18 | **长跑时转圈/已跑完/人工请求跳转**（用户：精读还在跑，标签不转、聊天无运行态、步骤却「已跑完 / 去评审」；人工请求只有知道了）。Codex `agent_message` 中途不当 done；PTY 还在出字时会话尾部 done 不得停转圈；活进程优先于 git ahead，步骤保持进行中。「去终端回答」取代「知道了」。 |
| 2026-10-09 | **文献检索标准档不做发现空转**（用户：测试项目检索太慢；期刊缩写和两套 RIS 保留）。实测 565 篇候选里，Semantic Scholar 独有 158 篇只纳入 8，Crossref 独有 16 篇只纳入 2，近义式重复取回。三套检索简报与 lit-search 改为：OpenAlex 一条主式，Consensus/Undermind 各一轮；Semantic Scholar、Crossref 标题检索、非预印本来源的 arXiv 不做发现，429 不重试；标准档不做引文扩展；PDF 直链连续 3 次 403 即停；缩写与两套 RIS 只补纳入和待确认。已有课题任务书不静默改写。 |
| 2026-10-10 | **终端/聊天批改动的全面核查与修正**（用户委托逐条核对 + 九家开源 CLI 终端要求调研，15 个核查 agent 对抗复核、9 条 P1 全部坐实后修复）。修正项：① Kitty 键盘编码按规范重写——无修饰功能键保持传统序列（只改写 Esc），带修饰方向/Home/End 用 `CSI 1;mod` 字母形（57417-57426 是小键盘编号，gemini-cli 无此映射、方向键全打乱码）；弹栈认 `CSI < n u`、push 省略 flags 按 0、进程退出即解除 armed。② 回放链路重设计——不在卸载时存（应用退出不触发，整条失效），存点改进程退出 + 页面隐藏 + 关窗守卫放行前；备用屏 TUI 改拍备用屏可视行；启动后 `prune_terminal_replays` 清孤儿。③ OSC 9;4 进度序列不是通知（kimi 每秒发「4;3」刷屏）；OSC 777 三段式拆标题；claude 的通知通道是 BEL（挂 `onBell`）；通知并入断帧 pending 管线并过设置开关/前台门/限频。④ 路径链接用 xterm `outColumns` 换算单元格列号（中文宽字符错位）、支持 `:行:列`、句尾标点不吞。⑤ chat 折叠识别代码围栏；确认条按钮清理死代码。⑥ Unicode11 显式激活（原只注册未生效）；粘贴包 bracketed paste 标记；claude/cursor 的 Shift+Enter（`\x1b\r` / CSI-u）；codex 0.162 重探 OSC 10/11 → 白名单跟进；opencode 注入 `OPENTUI_NOTIFICATION_PROTOCOL=osc777`；XTVERSION 应答带 xterm.js 自述 + XTGETTCAP 答 Ms（OpenCode 超链接/剪贴板由此启用）；阅读卡 overflow 裁切修复；聊天文件胶囊未命中改动回落文件预览。调研结论与借鉴清单另见当日会话记录。仍未做 Mesa Dev 实机界面验收。 |
| 2026-10-10 | **终端借鉴二批：Hyper/Tabby/VS Code 可直接落地的机制全量落地**（用户拍板「P1/P2 现在可以做的全做」）。① 相对路径链接：带 `/` 候选（`~/`、`./`、`../`、行号或扩展名）点击时经新增 `terminal_link_target`（cwd 拼 + `~` 展开 + canonicalize 存在性）终审后打开，误报词点了一下给提示。② 粘贴防线 `paste-guard.ts`：收尾回车一律剪（防粘贴即执行）、shell 多行先确认、agent/备用屏不拦；Cmd+V 的 paste 事件 capture 整接（图/文本/文件三分发），Finder/资源管理器复制的文件粘贴成引号路径（`read_clipboard_files`：mac NSPasteboard / win CF_HDROP，linux 暂空回落）。③ 查找升级：正则/全词/大小写开关 + 命中计数 + 250ms 防抖增量高亮。④ WebGL 丢失预算恢复（聚焦/可见时重试 ≤3 次，不再永久退 DOM）。⑤ OSC 9;4 进度直通标签条徽章（百分比/「…」，退出即清）。⑥ 崩溃收口：agent 非零退出先写红色横幅再存回放（死因随画面持久）。⑦ Windows 声明 `windowsPty: conpty`；resize/容器变化 rAF 合帧；「本次」浮层带配置指纹（网关 id · 密钥尾号 · 附加变量名）。明确不做：xterm 写入背压（需 Rust 侧流控才成立，xterm 内部队列已吸收突发）；命令角标/sticky scroll（依赖 shell 集成注入，属产品决策，zsh 默认不发 OSC 133）。 |
| 2026-10-11 | **二轮核实（18 个核查 agent 对抗复核，12 条 P0/P1 全坐实后修复）**。要害：① 候选正则零宽匹配在行首边界字符（缩进/引号/分号/全角标点）上死循环冻结整窗（P0）——零宽保护提到循环体第一行 + 回归锚；② `translateToString` 的 outColumns 参数在 xterm 6.0.0 编译产物中不存在（src 有、lib 无），路径链接曾整体失效——改逐格自算列号映射；③ Windows `OpenClipboard(0)` 类型错（本地 cfg 分支不编译、CI 才炸）——null_mut；④ 手动「停止」误报崩溃横幅——负数退出码是 kill 哨兵，横幅只认 code>0；⑤ WebGL 恢复无健康守卫（每次聚焦重建上下文）；⑥ armed 下 Ctrl/⌘+V 双发（CSI-u + 粘贴文本）——键位豁免 + 粘贴同内容 80ms 去重；⑦ 帧尾完整短 OSC 9 被当半截扣住（kimi 8 字符进度帧卡死终点）——半截判定锚定帧尾；⑧ 通知/进度对后台标签失效（可见性门控拦了数据流）——Rust `gated_emit` 带外发 `pty-signal-<id>` 只喂通知/进度；⑨ 中文弯引号/开括号/全角冒号缺席边界集（吞前文、丢行号）；⑩ GitPanel status 未加载时抢先回落预览；⑪ revealLine 依赖缺 ready（首开丢行号）；⑫ OSC 777 非 notify 子命令、畸形 9;4 漏成通知。另修：粘贴只剪换行不剪缩进、崩溃横幅写入回调后再快照、搜索开关切换清防抖、浮层网关显名、进度 state 2 显 !、关窗无 agent 也等 120ms 落盘、App.css 不再强制死滑块常驻。 |
| 2026-10-11 | **实机自动化验收（我操作真实 Mesa Dev 窗口逐项过检）**。**活体验证通过**：应用带全批改动干净启动（多次）；协议应答管线端到端（shell 里 `printf '\x1b[c'`→`^[[?1;2c`、`\x1b[?u`→`\x1b[?5u`、`\x1b[>q`→`^[[P>\|Mesa (xterm.js 6.0.0)^\` 三应答被 readline 回显）；OSC 9;4 进度徽章（printf 出 42% 显示、state 0 清除）；多行粘贴防线（确认框弹出、行数正确、确认后写入不执行）；路径链接点击 → 右侧预览（文件在 /tmp、cwd 在 ~，root=dirname 修复同验）；查找（三开关 + 命中计数 1/3）。**挖出两个存量/新问题并修**：① 前端 `getCurrentWindow().onCloseRequested` 在红绿灯关窗时整条不执行（三根探针实证，连既有的 agent 关窗确认守卫也是死代码）——关窗存盘下沉到 Rust `on_window_event`（`[flush]` 探针证实拦截/放行链路活着），前端接 `mesa:flush-before-close` 事件分发存盘；② 关窗时序链路在卡死/极端场景下仍不可全信——补 **30 秒周期回放快照**（任何死亡方式最多丢最后 30 秒画面）。自动化验收方法学记录：透明 webview（背景清除）+ 合成事件 + 用户同时使用机器的组合会让截屏拍到窗后内容、键入落到用户窗口，深测因此收手，剩余 E 组（回放/通知/崩溃横幅）留给人工过检。临时探针（debug_log 命令、三处 eprintln）已全部移除。 |
| 2026-10-11 | **三轮多维审查（并发/性能/安全/内存/跨平台/UX/状态机/契约 八镜头 ×12 agent，双镜头复核）**。P1 两条：① 后台标签 BEL 通知断链——pty-signal 转发了含 BEL 的帧但前端信号流不认裸 BEL，claude 后台等待确认永远不通知；signal 监听补 `text.includes("\x07")` 判定（完整 OSC 连同终结符已被消费，残留 BEL 必为裸响铃）。② `consumeTerminalQueries` 逐字符拼接在 256KB-1MB 帧上 20-65ms 超帧预算（实测），饱和主线程——加五标记特征快速路径（**五个不能少四个**：`\x1b[c` 是 Kimi 的 DA1 哨兵）+ ESC 段拼接 + pending 4KB 上限 + ST 断在 ESC 上的边角，1MB 带色帧 6.9ms、输出与旧实现逐字节一致。P2/P3 修 15 项：TerminalView memo 击穿（onForkChat/onOpenPath/onProgress 改稳定回调+值判重，kimi 1Hz 进度不再全页重渲）、回放脱敏补 xai-/gho_/glpat-/gsk_/sk-ant/裸 JWT 前缀、滑块 `:not(.invisible)` 让位、链接起点改 lookbehind（行首单个边界字符后的路径可命中）、`9;4;1;` 空进度段按不定、搜索零命中显「无结果」、粘贴去重窗 250ms + 失败不静默、通知正文带 Agent 来源、开关钮 28px 下限、贴图/浮层走 ccode-float-surface、阅读卡走 ccode-well、聊天折叠钮换 FoldMark、崩溃横幅文案不再指向不存在的按钮、根级文件 root 兜底、注释/文档口径清理。已知不修（记录）：后台退出尾部输出随 backlog 丢弃、kkp 无栈深、ST 终结 OSC 后台断流、双实例 prune 互删、Windows %VAR% 展开（存量）。 |
| 2026-09-18 | **精读笔记禁止摘要灌装交差**（用户：精读应是读后消化，不是英文摘要模板；随后：中文不是绝对，术语可留英文）。根因是 TASK 写「每篇产出笔记」+ 机器验收要求 index 全量且 `notePath` 非空，Agent 用脚本把 OpenAlex 摘要填进八段。技能改为读完再写、叙述中文/术语可留英文、未读 pending 且 `notePath` 可空；三套精读简报同步；`records` 不再要求 `notePath`。已有项目不静默改 TASK.md。细则 `conventions/pipeline.md` / lit-notes 技能。 |
| 2026-09-19 | **评审壳 files 档**（用户：精读评审不是检索那套，后续步骤和其他模板一起改）。非检索步骤不再一律 acceptance。精读/大纲/写作/排版走文件分组；实验执行、分析、清洗、EDA 才验收。 |
| 2026-09-27 | **修复：GLM 连接在 Claude Code 里 401「令牌已过期或验证不正确」**（用户：Mesa 里配的 GLM 报 401；测试连接和拉模型都正常）。`claude_settings_override` 只把 `ANTHROPIC_BASE_URL` 提升进 `--settings` 的 env 块、**不带 token**（原设计「认证密钥仍只存在子进程环境中」），而磁盘 `~/.claude/settings.json` 的 `env` 块优先级高于子进程环境变量——于是 base_url 换成了智谱、token 还是旧家，形成「新端点 + 旧令牌」组合。探针不经过 settings 层，所以测试连接绿着但 CLI 401。修法：token 与 base_url 同层配对写进覆盖层（与 `global_config::patch_claude_settings` 的成对写法一致），并改走 **0600 临时文件 + `--settings <路径>`**，密钥不进 argv；`sweep_stale_external_wrappers` 一并回收 `claude-settings-*`；`launch_plan` / `launch_plan_with_prompt` 改返回 `Result` 以传导写盘失败。另加 API 模式的只读提醒（`api_launch_conflict_notes` → 启动预览 notes，**只提示不阻断**），覆盖官方账号防线轮不到的键。 |
| 2026-09-27 | **修复：Shift+标点按第一下没反应，要按两下**（用户：输入框里 Shift+符号第一下不出字）。全局键盘探针实测（`main.tsx` 临时 `[kbd]` 钩子）：WKWebView 上 Shift+`/` 报的是 **keyCode 229 而非 191**（`key="?" code="Slash" which=229`），`defaultPrevented=false`，且每次都有 `input` 事件与正确的 `data="?"`。229 让 xterm 走 `_compositionHelper.keydown` → `_handleAnyTextareaChanges` 的 `setTimeout(…, 0)`，而该定时器读 textarea 时 `input` 还没写长（`t.length > e.length` 不成立）→ xterm 不发 → 第一下丢字。修法：229 与 keyCode 0 同走当场补发（`printableKeyFallback` 认 0 与 229 两个值），由既有的 `swallowPrintableChar` 哨兵吞掉 xterm 可能补发的那一次；另修一处结构性问题——原补发分支在 `ptyIdRef.current` 为空时仍设哨兵并 `return false`，等于 xterm 与 PTY 都没收到、按键凭空消失，现改为无 id 时原样放行。**同日曾误撤 229 补发**（把「一个字母出两个」的成因误判为「补发多余」），实测证明该分支是这一记的唯一兜底，遂恢复。 |
| 2026-09-29 | **检索清单挂影响因子，已纳入可移出**（用户：检索步没有影响因子，待确认不在步骤卡，已纳入无法拿掉）。标签复用期刊指标表现查（刊名优先，ISSN 兜底），不写入 included.json。步骤卡与审阅同一份清单：待确认纳入/排除，已纳入移出（改 excluded，同步纳入行、待获取和两份 RIS，编号不重排；PDF、笔记、bib 不删），已排除可恢复为待确认。 |
| 2026-09-29 | **大纲和初稿不另挂审阅**（用户：和去评审重复，硬伤条数也不写）。看稿、写意见、退回、保存只在「去评审」。流程线上不另加勾选，也不在按钮旁列硬伤计数。 |
| 2026-09-28 | **定稿同时交 EndNote 与 Zotero 两份域稿**（用户：润色与定稿怎么没有这两份 Word）。原先按项目设置「文献库」二选一，默认不交；Zotero 交的是 `output/zotero.rtf`。现 `polish` / `research-paper-polish` / `thesis-final` / `journal-format` 默认交 `output/endnote.docx` 与 `output/zotero.docx`。已有课题档案卡不自动改写。 |
| 2026-09-28 | **修复：中文输入法下 Shift+1 不出感叹号、Shift+3 第二下变成两个井号**。只认物理键 Slash 时，Shift+1（`code=Digit1`、`key=Process`、keyCode 229）补不出 `!`。Shift+3 第一下由 xterm 写出 `#`，第二下组词收尾再写一遍。改为按美式键盘物理键表补 Shift 档（Digit1→`!`、Digit3→`#`、Slash→`?` 等），只在 keyCode 0/229 补，并 `return false`。回声守卫按次数吞（400ms），连按两次得到两个符号。汉字 `code` 不在表内，不补。 |
| 2026-09-28 | **修复：中文输入法下 Shift+问号第一下没反应**。只按 `e.key` 是否为 ASCII 标点补发时，中文输入法开着的 Shift+/ 上报 `key="Process"`、`isComposing=true`、`code="Slash"`、keyCode 229，补发被跳过，xterm 的 229 分支又发不出。`printableKeyFallback` 对 Shift + 物理键 Slash + keyCode 0/229 直接补 `?`，不看 isComposing。汉字上屏仍不补。 |
| 2026-09-28 | **修复：中文输入法上屏一个字出现两个**（用户：Claude Code 里中文输入法打一个字出两个，英文正常）。229 补发本为 Shift+标点（WKWebView 上报 229 且 xterm 来不及发）。中文确认候选同样是 keyCode 229，且 `e.key` 就是那个汉字，不是 `"Process"`——宿主先写一次，xterm 组词结束再写一次。`printableKeyFallback` 的 229 只补 ASCII 标点；汉字与全角标点不补，组词中 `isComposing` 也不补。keyCode 0 仍当场补发。 |
| 2026-09-27 | **修复：终端里输入一个字母出现两个**（用户：打一个字母出两个）。根因是旧的 defer 补发分支用「等一拍看 `textarea.value.length` 是否增长」判断 xterm 有没有发过，而 xterm 的三个发送分支（`_handleAnyTextareaChanges` 的增长/等长替换/删除、`_finalizeComposition`）里**只有「增长」会被这个长度判据捕获**，等长替换分支下宿主补发一次、xterm 再发一次。修法是去掉那个延迟哨兵式补发，改为 229 也走当场补发 + `swallowPrintableChar` 哨兵（见上一条）；顺带消掉那个无句柄、清理时不取消的 `setTimeout`（卸载后仍可能 `pty_write` 到已 kill 的 PTY）。 |
不是查找坏了：全屏 TUI 跑在备用屏，`buffer.hasScrollback === false` → `ydisp`/`ybase` 恒 0，`@xterm/addon-search` 的扫描上界 `baseY + rows` 塌缩成当前一屏，跳页分支 `row >= viewportY + rows \|\| row < viewportY` 恒假——**没有别的页可去**。普通 shell 里翻页一直正常。修法只做交代：检测到备屏时查找条下方出一行说明。状态由 `buffer.onBufferChange` 驱动（只在类型翻转时 setState，备屏开启会连发数次事件），打开查找条时按 `buffer.active.type` 补一次初始值。真要在 TUI 里搜历史需宿主机侧另存 PTY 原始输出（要剥转义序列、高亮落不到 TUI 画面上），未做。 |
| 2026-09-24 | **终端 Shift+标点与 ⌘V 图片**。xterm 只在 keyCode≥48 时发送单个字符；WKWebView 上 Shift+标点可能是 0 或输入法占位 229，第一次进不了 PTY。keyCode 0 当场补发；229 等这一拍，隐藏输入框没多字再补。Mac 的 ⌘V 先读剪贴板，有图走落盘路径，无图当文本。Ctrl+V 仍是 `\x16`。 |
| 2026-09-24 | **运行中启动栏不占高度，查找盖在画面上**（设计 PR4 / PR6）。进程起来后顶部高度为 0。身份只在底栏。「修改」是浮层。「插入」在当前标签上。查找条绝对定位，打开和关闭不改变终端行数，也不通知进程。 |
| 2026-09-24 | **内嵌终端第一帧按收起后的格子启动**（设计 `docs/design-embedded-terminal.md` PR1）。带首条指令且能注入的新会话，在 `openpty` 之前收起高级选项再量格子。退回修改不收栏。量不到格子不起进程。有 `runId` 先只读 `pty_id_for_run`，已在跑则不收栏、不改行列（`SpawnResult.adopted`）。`attach` 与防抖 `onResize` 在进程活着之后不再 `pty_resize`。查找和运行中「修改」仍可改变画面高度，但不通知进程。 |
| 2026-09-24 | **审阅退回不再先按 80 列重放**（用户：交回审阅意见、回到原来的会话终端，往上滑同一段出现两份，一份窄一份宽）。「退回修改」会 resume 原会话。PTY 固定 24×80 拉起，Claude 在第一帧按 80 列把整段对话写进滚动记录；前端随后 fit 再 `pty_resize`，同一段按实际宽度再写一份。修法：启动前 `fittedPtySize` 量当前 xterm 格子，经 `pty_spawn` / `shell_spawn` / `pty_spawn_custom` 的 cols/rows 传给 `spawn_tracked`；没量到仍 24×80。已经留在滚动记录里的旧副本清不掉。 |
| 2026-09-22 | **DOM 终端滚动按行挪位**（用户：鼠标滚轮滑动也卡）。合帧只合并同一帧里的多枚触控板事件，鼠标一格通常只有一枚 wheel，xterm 仍 `refresh(0, rows-1)` 把整屏行 `replaceChildren`。`terminal-row-reuse.ts` 包住 DOM 渲染器的 `renderRows`：视口平移不到一整屏且留在屏幕上的行文字与缓冲区一致时，挪已有行节点，只重画新进入的行；对不上、超过一屏、局部重画则维持原范围。`smoothScrollDuration` 仍为 0。WebGL 无逐行 DOM，不走这条。 |
| 2026-09-21 | **终端清晰度与触控板滚动分头修**（用户：ccode 里 grok 终端文字不如 Ghostty 清晰；触控板上下滑卡顿）。两条独立根因：① 清晰度——当时设置是 renderer=webgl + 字体 Menlo，而 Ghostty 空配置是 JetBrains Mono 13px（`ghostty +show-face --string=Mesa` 实测）；macOS 上 WebGL 走 GPU 字形图集，图集按整数设备像素取整单元格（DPR 2 即 0.5px 步进），同一字体同一字号实测字宽 7.8 被压成 7.5（−3.8%），笔画发虚。② 卡顿——xterm 真正滚动的节点是 `.xterm-scrollable-element`（`term.element`/`.xterm-viewport` 实测命中 0），`attachCustomWheelEventHandler` 拿到事件时位置已经写过，一帧内多次位置写入 + 多次 onScroll/滚动条更新。修法：字体链收敛到单一出处 `src/terminal-font.ts`（选中族名 + App.css `--font-mono` computed 值，`terminalFontStack` 单一生成），修掉 TerminalPage 手拼链缺 `ui-monospace`、重复 `'SF Mono'` 的漂移——macOS 公开族名 `SF Mono` **不存在**（`SFNSMono.ttf` 的 family 是私有名 `.SF NS Mono`），只有 CSS 关键字 `ui-monospace` 拿得到（advance=narrow=8.036）；下拉清单同源，`SF Mono` 标「需自行安装」、JetBrains Mono 标「与 Ghostty 默认同款」。滚动合帧 `src/terminal-wheel-scroll.ts`：在 `term.element` 的 capture 阶段 `preventDefault+stopPropagation` 截住，累计到 rAF 再用合成 `WheelEvent` 派回原始深层 target（DOM 渲染器每次重绘会重建 `.xterm-rows` 子节点，不许缓存目标），备用屏／鼠标上报模式／修饰键／横向滚动一律放行。实测 420 个事件（24px/个、3972 行可滚）：DOM 位置写入 240→143、WebGL 240→142（约 −40%），滚动距离 240→235 行（<3%），帧 p95 两者 9–10ms 无长帧，**渲染次数不变**——故设置页/说明书文案不许写成「清晰与流畅兼得」。测试 `tests/terminal-font.test.ts`（与 App.css 逐字比对）+ `tests/terminal-wheel-scroll.test.ts`（假 DOM 时序）。 |
| 2026-09-20 | **文件类评审对齐检索页签**（用户：综述审阅还是 Git 双栏；随后：对照改动已经过时，看前两步）。精读/大纲/写作与检索同一套 笔记或稿件／过程／文件；默认内容页。 |
| 2026-09-19 | **撤精读步「继续精读笔记」人工事项**（用户：那条和文献库交付是否合理）。说明书不是收尾活；沉浸阅读入口在文件上。 |
| 2026-09-19 | **精读不问文献库交付**（用户：三个按钮怎么执行，前面不是已有同步到 Zotero）。Zotero 进库只留待获取执行钮；EndNote 交差改项目设置。 |
| 2026-09-19 | **步进器大圆去掉待确认黄点**（用户：没必要）。v3.59 已拿掉「已回复」绿点，待确认角标一并删除。待确认仍在运行页标签、聊天审批条、收件箱。 |
| 2026-09-19 | **brew bottle 加速改南大 ghcr 代理 + 更新超时改闲置判定**（用户：配置页更新 Qwen Code / OpenCode 卡住）。诊断实锤：brew 4+ 的 bottle 是 ghcr.io OCI 件，国内平铺镜像（TUNA `HOMEBREW_BOTTLE_DOMAIN` 等）已全部停供（403/404），qwen 46MB bottle 靠 ghcr 直连 73KB/s 爬 9 分钟、opencode（tap 走 GitHub Release）爬 13 分钟，均贴着 900s 硬超时的边。修法：① `brew_env_pairs` 弃 BOTTLE_DOMAIN，注入 `HOMEBREW_ARTIFACT_DOMAIN=https://ghcr.nju.edu.cn`（OCI 语义改写 ghcr 域名，bottle 实测 6.7MB/s；非 ghcr URL 代理 404 后 brew 交错回落原地址，tap/cask 无回归；API 元数据仍走 TUNA）；② `run_streaming_pty` 超时拆双档——`pty_deadline_kind` 纯函数：600s 无任何输出判挂死即杀、1800s 硬上限，慢下载时 curl 进度条持续出字（PTY 实测）不误伤；闲置优先于硬上限，报错文案分开。设置页/连接页镜像文案同步为「元数据 TUNA、包体南大 ghcr 代理」。 |
| 2026-09-19 | **出网代理扩展到下载侧**（用户：电脑和 Mesa 都配了代理，为什么更新下载不走代理）。两个原因叠加：CLI 子进程（curl/brew/npm）不读 macOS 系统代理只认环境变量，GUI 拉起的 Mesa 环境里没有；而 Mesa 自己的 outbound_proxy 此前按决策只注入官方账号启动与组头登录。现 `download_proxy_env`（settings.rs，同源 outbound_proxy）注入 `run_streaming_pty`（agent 安装/更新、依赖安装、字体）与更新检查（npm_latest/brew_latest）：大小写成对写（curl 的 http_proxy 只认小写）；国内镜像主机（TUNA/南大 ghcr，镜像开启时）并入 NO_PROXY 直连——镜像走代理绕道境外反而慢；用户环境已带任一代理变量时不覆盖（终端 export 后拉起 Mesa 的场景）；网关启动仍不走（原决策不变）。设置页提示与 user-guide 同步。 |
| 2026-09-19 | **终端渲染器可切（settings terminal_renderer）**（用户：内嵌终端滚动不如原生终端流畅）。根因：macOS 默认走 xterm DOM 渲染器（2026-09 前为清晰度弃 WebGL 的拍板），DOM 渲染器滚动时逐行建/拆 DOM 节点，滚动流畅度天然吃亏。修法：不动默认（平台分流保持 auto = Windows WebGL（软件渲染探针不变）/ macOS DOM），新增设置页「终端渲染」三档 auto/webgl/dom（VS Code gpuAcceleration 同款思路）——Mac 用户可切「流畅（WebGL）」换取滚动顺滑，文字锐度自行取舍；选 webgl 仍过 isSoftwareWebGL 探针 + onContextLoss 回退；只对新开终端生效；闭集读时过滤（KNOWN_RENDERERS）。canvas 渲染器 addon 只声明支持 xterm 5（截至 0.8.0-beta.48），不引入。conventions/terminal.md 渲染器条目重写。 |
| 2026-09-19 | **用量页「订阅余量」卡（智谱 Coding Plan 先行，含重置卡）**。接口规格 = 四个开源实现交叉实证（cc-switch / OmniRoute / CodingPlanQuota / quotio-desktop）：额度 `GET {base}/api/monitor/usage/quota/limit`（limits[] 按 unit 锚定 5h/周，禁按重置时间排序——cc-switch #3036；CREDIT_LIMIT 积分制套餐同收）+ 重置卡 `GET|POST {base}/api/biz/customer-package-reset/{list,use}`（仅 OmniRoute 有实现；信封 fail-closed、双桶截断不当 0 张、code 1001=密钥失效）；Bearer 鉴权；团队版从网关 headerEnv 隐式识别。产品口径：出卡零配置（槽 URL 含 bigmodel.cn / api.z.ai + 有密钥即出）；无命中不渲染；2 分钟缓存（对齐页面可见期自动轮询，不可见即停）+ 瞬时失败回落上次成功值；**用卡是消费性写操作**——显式按钮 + 确认弹窗（focusCancel）+ 服务端挑最早过期可用卡，绝不自动；「去控制台」深链兜底（bigmodel.cn/coding-plan/personal/usage，用户提供）。明确不做：月余量空位（智谱无数据源，窗口名 monthly 留闭集位）、后台轮询/OS 通知、出网代理注入。Claude/Codex OAuth 余量后续挂同一 DTO 另立批次。模块 `subscription_quota.rs` + 前端 `plan-quota.ts`（时间显式传 now）。同日扩展（用户：其他家也要做、一张卡可切换）：接入 **Kimi For Coding**（api.kimi.com/coding/v1/usages，多模型 5h 窗取 utilization 最紧、usage=周窗、used=limit-remaining）与 **MiniMax**（/v1/api/openplatform/coding_plan/remains，general 条目剩余百分比反转、周桶仅 status==1）；多家时卡头 SegTabs 按网关切换（同供应商多网关追加网关名），重置卡行按 `reset_cards_supported` 仅智谱渲染；火山方舟未接（控制面 OpenAPI 需 IAM AK/SK 签名，与网关单密钥模型不符，待网关加 AK/SK 字段后单批做）。 |
| 2026-09-19 | **模型能力声明补口（对照 cc-switch 审计）**。三件事：① 覆盖层 `model-capabilities.json` 补写入通道——网关库「模型策略」行新增「能力声明」编辑（表单只收 context/思考/视觉，留空=未声明、显式 false 硬挡下层；output 不进表单——其用户旋钮是策略字段 max output，能力层 output 只喂 opencode `limit.output`（schema 必填、有 8192 兜底），与策略并排两个输出框属重复；`set/clear/list_model_capability_override` 原子写，output/api_backend 往返保留），注册链四层全 miss 的中转新模型不再只能低报（claude 提前 compact / codex catalog 窗口低报 / grok 回落 256000）；② Claude `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 与 `MAX_CONTEXT_TOKENS` 同值成对注入/清除（只抬上限不抬压缩窗口会把 auto-compact 触发点留在旧档）；③ Codex catalog 不写 `apply_patch_tool_type`（freeform=custom 工具被原生 /responses 与 Anthropic 网关拒/丢，cc-switch 非代理档实证；编辑走 `shell_type: "shell_command"`）。明确不做：`[1m]` 模型名后缀通道与代理层运行时整形（不走本地代理主线不变）；`input_modalities` 仍按注册链如实声明（宁缺毋滥），查不到由覆盖层补口。细则 conventions/profiles.md §6.1–6.3。 |
| 2026-09-19 | **未登记提醒改全流水线口径**（用户：综述大纲步开工弹层报「发现 65 个未登记文件」）。根因：检索步按技能把开放获取 PDF 直写 `papers/` 不登记（2026-09-18 拍板），而 9-18 的排除逻辑只看**本步骤**声明输入——`papers/*.pdf` 只在精读步声明为可选输入，综述大纲步自己的 inputs 是 `notes/`+`included.md`，65 个 PDF 整批重新冒出来。修法：`isFlowDeclaredPath`（kickoff-inputs.ts）——任一步骤声明过的输入（inputs/optionalInputs/anyOfInputs）或预期产物（expectedArtifacts）都不算陌生发现，弹层过滤从单步换全流水线；真正的陌生文件（人工数据集、根下散落 PDF）仍提醒。测试 kickoff-launch.test.ts 补全流水线用例。 |
| 2026-09-19 | **转圈冻结修复：收尾被推迟必须重试 + armed 静默硬上限**（用户：综述大纲生成结束了标签转圈还在转）。诊断：会话文件 17:24 已落最终助手正文、尾部分类=done、PTY 空闲静默（claude TUI 实测无空闲动画）——转圈不灭的机制是死锁：收尾刷新落在 `ptyLive` 8s 窗内（claude 写完 away_summary 还在渲染）→ applyTailAttention 按 9-18 设计推迟熄灭；此后会话文件再无新写入 → 5s 轮询被签名门（sig 未变）拦住不再重跑 → 「已收尾但被推迟」永远没有第二次判定。修法两层：① `scheduleSettleRetry`（TerminalPage）——收尾判定因 ptyLive 被推迟时，`PTY_LIVE_MS+1s` 后强制 fetchConversation(true) 重判一次（持续出字则自续重试直到 PTY 静默）；② `PTY_ARMED_SILENCE_CAP_MS=120s`（tab-working.ts）——armed 回合完全无声超上限熄灭转圈但**保留 armed**（PTY 再出字立即复亮，不重演 2026-09-15「再也点不亮」）；真实思考/执行期间 TUI 动画仍在出字，完全无声≠思考间隙。tab-working.test.ts 补上限用例。 |
| 2026-09-19 | **底部状态栏统一开关**（用户：会话框底部与终端各见一条状态栏，觉得复杂；设置里只有聊天页能关）。原「聊天页显示状态栏」（status_bar_in_chat，关 = invisible 占位保终端几何）升级为「底部状态栏」（status_bar，默认开）：终端层与聊天层同进退，关 = 两层都不渲染——两层一致故切层时终端行列数天然稳定，SIGWINCH/codex transcript 重放问题不因开关产生，invisible 条件占位与「干净标签不占位」的特殊分支整体退役；旧 status_bar_in_chat=false 读时迁移为关（with_defaults：status_bar 显式值 > 旧字段 > 默认 true）。关闭的代价（就地切模型/思考档、git 保存推送、时长/token 随栏消失）写进设置行 hint；阅读区右栏槽位对缺失状态栏节点空安全。conventions/terminal.md 与 design-system.md 对应条目同步。 |
| 2026-09-21 | **订阅余量卡双窗同构**（用户：周额度与 5 小时展示逻辑不一致、倒计时冗长、重置卡挤一行）。5 小时 / 本周同一套「指标名 + 百分比 + 绝对值 + 粗条 + 倒计时」，最紧的窗口排第一；倒计时卡面只写「还有 N 小时」，时刻悬停；已用超过总量时卡面封顶显示；重置卡两块 raised 并排，危急窗按钮强调色、0% 不禁用。正常档仍不着色。 |
| 2026-09-20 | **用量页「网关余额」卡（New API 预付钱包，ZetaTechs 先行）**。与订阅余量并列、形态不同（金额剩余 vs Coding Plan 窗口百分比）。用户入口 = `https://ent.zetatechs.com/wallet`（站 HTML title / Umami 均为 QuantumNous New API）。查询顺序：① 系统访问令牌（keys.json `{id}#wallet`，cc-switch PAT，网关库选填；带 New-Api-User 等兼容头，all-api-hub 口径）`GET {origin}/api/user/self` → ② 推理 sk- 碰同一接口（401 不当成密钥失效）→ ③ `GET {origin}/api/usage/token` → ④ billing `subscription`+`usage`。`source` 区分钱包/密钥额度。不限额度且无钱包数字时改口去网关库填令牌。公开 `GET {origin}/api/status` 取币种（zetatechs 实测 CNY、quota_per_unit=500000）。产品口径：出卡零配置（槽主机 `zetatechs.com` 后缀命中 + 有密钥即出；加站点 = `WALLET_HOSTS` 加一条）；无命中不渲染；2 分钟缓存 + 页面可见期轮询；瞬时失败回落上次成功值；「去钱包」=`{origin}/wallet`；查询不注出网代理。明确不做：usage script、探测全部网关、把商业中转写进连接页预设、为查钱包再要一把仪表盘 PAT。模块 `gateway_balance.rs` + 前端 `gateway-balance.ts`。 |
| 2026-10-11 | **会话自动命名加设置开关**（用户：功能没法关）。`auto_title_sessions`（默认开，settings.json，with_defaults/merge 常规口径）：关 = 聊完起名（early/final）与打开对话页补名（`ai_retitle_all_sessions`）全停——补名命令虽是批量，唯一触发点是打开对话页的自动补跑、无手动入口，不随开关停就是「关不掉」。闸门在两个 Tauri 命令入口（`settings::auto_title_sessions_enabled`，最终防线）；前端 `scheduleAutoTitle`/SessionsPage 补名 effect 同步跳过，省掉「后端返回 None → 前端 8s 重试两次」的白跑。已有标题保留；手改标题（`title_source=user`）本就不被覆盖。设置页「集成」分区加行（AI 专用配置上方），搜索索引补「自动命名/起名/标题」别名。评审补强：补名批循环逐轮复查闸门（中途关掉即停在当前会话，不再有新标题落盘）、关停语义有测试钉住（`retitle_all_sessions_impl` 闸门收进参数，关闭态全零返回）；「会话摘要」功能槽在设置页改标「会话摘要 / 起名」，开关 hint/说明书写明起名配置来源（默认跟 AI 专用配置，「会话摘要 / 起名」行可单独换）。 |
| 2026-10-12 | **雷达空态入口只认有任务的卡**（用户截图：定时任务页没建任务时摆着「添加」，点了却是加关键词）。产品依据：订阅在没有定时任务时毫无效果——「立即跑」只认有雷达巡检的卡（radarSchedules 门控），新命中只来自巡检运行，先订关键词是订了个永远不跑的空转。改为：没订阅且没雷达巡检 → 整块空态行不渲染，定时任务页只留「＋ 定时巡检」一条主路；没订阅但有雷达巡检 → 「文献雷达 · 还没订阅读」+ 按钮改标「订阅关键词」（不再裸写「添加」，有任务语境下它就是给任务喂关键词）。建任务 → 卡上出空态行 → 订关键词，顺序自然成立。design-system.md 空态规格与 user-guide §5.1 / tutorial §9.1 同步；lit-watch-ui.test.ts 钉住两种空态。同日补桥：新建/删除任务不发 scheduler-run-done（那只管跑完），ScheduleSection 加 onSchedulesChanged（八处调用点：启停、行内改配置成败两分支、删除、创建 onCreated/onDraftStarted、草稿确认落盘、编辑保存）→ ProjectSchedulesView 持 schedulesVersion 传 LitWatchCard 触发重拉——建完首个雷达任务空态行就地出现、删掉唯一任务就地隐掉，不用切页。复审完善（同日，5 透镜 23 条确认全收口）：①门控对 schedules 判空与 subs 对称（list_schedules 静默吞错时不再把有任务的卡判没）；②反向死态——有订阅没雷达任务出警示行「已订阅 N 个关键词，但没有雷达巡检任务」+去建巡检；③删最后一条雷达任务且有关键词时确认层说清「不再巡检」；④创建弹层没订阅给首跑提示；⑤**编辑弹层清空运行配置发 null 被后端 Option<Option> 当「不改」（清不掉的静默失效），改发空串**，types.ts 契约注释更正；⑥schedulesForProject 从自带 normPath 改走 path-utils samePath（verbatim/大小写漂移不再丢任务）；⑦pendingRow 补进空态早返回分支（主渲染死三元清除）；⑧SchedulerRunDonePayload 补 artifacts 字段；⑨孤儿 litWatchSchedules 删除；⑩code-structure 挂载点描述更正（唯一挂载点 ProjectSchedulesView）。已知保留：provides 点亮 vs 后端名字判定的不对称（注释+guide 写明，计数/采纳只认内置 lit-watch）；skillProvides 120s TTL 滞后为既有接受项。新增 tests/schedule-section-ui.test.ts（桥七点、空串清除、确认文案、创建提示）与 lit-watch-ui provides 接线钉。 |
| 2026-10-12 | **开源发布合规批（公司身份对外，五路审计 + 4 项红旗复核后逐条执行）**。①协议 MIT → Apache-2.0：LICENSE 换标准全文（落款 hongtongzhou-design 不变）、新增 NOTICE，package.json / Cargo.toml / README 徽章 / CONTRIBUTING（加 DCO 签署要求）/ 关于页 hint 同步；理由 = 显式专利授权 + §6 商标不随代码授权（为 Mesa 品牌留路），单人开发期为换证零成本窗口。②商业中转预设移出开源默认：`src/presets.ts` 删「ZetaTechs 中转」条目（含「未备案境外模型下架」运营措辞），恢复 2026-09-20「明确不做」口径，tests/presets.test.ts 改钉反向断言；网关余额功能与 `WALLET_HOSTS` 不动（用户自配网关的功能性支持）。③借鉴署名收口：`docs/licenses/THIRD-PARTY.md` 重构——补 KaTeX 字体（OFL-1.1，dist 内 59 文件 12 字族，此前误记 katex 整体 MIT）、zhipu/kimi/minimax 图标署名（逐字节源自 cc-switch icons/extracted，真实上游 lobe-icons MIT © lobehub）、Rust 侧特殊许可条目（MPL-2.0 五件套随包需附文本、CDLA-Permissive webpki-roots、ring Apache+ISC、SQLite/liblzma 公共领域、libzstd 择 BSD-3、bzip2 专有宽松、notify CC0）、dompurify 明示择 Apache-2.0、运行期数据来源（JabRef 缩写表 CC0 / NLM MedlineTA / ShowJCR / Crossref / OpenAlex）、设计参考致谢（cc-switch MIT / waveterm Apache-2.0 / vscode MIT，学机制不抄代码；代码层唯一例外即上述三图标）。④随包清单自动化：`scripts/gen-third-party-notices.mjs`（npm 锁文件生产依赖 187 项 + cargo metadata --locked 635 项，maxBuffer 放大防 ENOBUFS）生成 `src-tauri/resources/third-party-notices.md`，`npm run gen:notices` 手动、tauri beforeBuildCommand 自动；进 bundle.resources（OFL「随包携带声明」的文件出口）+ `about.rs` include_str! 嵌二进制（`read_third_party_notices` 命令）。⑤关于页体系化：设置「关于」从两行扩为版本（含 build_info 平台/架构/渠道——Intel 自构建版可辨认）/版权（Mesa-ccode 双身份白话）/开源许可浮层（NoticesOverlay，懒加载）/致谢/数据来源/隐私（密钥 0600、更新检查向 GitHub 发请求）/问题反馈/商标声明；macOS 菜单栏 About 面板（lib.rs setup，cfg 门控；编辑子菜单显式带齐，set_menu 整替默认菜单后缺它文本框复制粘贴失灵）；settings-search 补别名、user-guide 补 §13.9。⑥开源卫生：教程 8 处绝对路径图片改相对（GitHub 裂图）、docs/audits 两处路径中性化、OpenAlex 礼貌池邮箱换 hong.tongzhou@zetatechs.com（用户指定）、gateway_balance 注释去「本机三个」习惯暴露、删 public/vite.svg+tauri.svg 模板残留与 index.html favicon 引用、git rm .tmp-adversarial-repro 四个 .mts 残留、.gitignore 防御性补 keys.json/.env/.tmp-*/。遗留待办（人工/GitHub 侧）：social preview、topics、DCO App 安装、figure-composer 上游许可核实、公司 org 转移时 updater endpoint/README/发版命令三处同步。 |
| 2026-10-12 | **顶栏帮助菜单 + 应用内反馈通道**（用户明确要求提需求不跳 GitHub）。帮助按钮在命令面板左侧（?），三组入口：使用（教程/说明书 ↗ 外链、快捷键跳设置）、支持（反馈与提需求、报告安全问题 ↗、诊断跳设置）、应用（检查更新/关于跳设置）；下拉结构与关闭范式复用收件箱（Esc/遮罩/再点），应用内目标沿 settingsSectionReq 同一条路。「反馈与提需求」= 应用内表单（FeedbackModal，帮助菜单与设置→关于双入口）：类型四档（功能需求/缺陷/疑问/其他）+ 标题 + 详情（类型化引导 placeholder）+ 选填联系方式 + 环境行（getVersion + build_info，默认附、界面可见、可关）。通道双轨：**公司端点为主**（feedback.rs `FEEDBACK_ENDPOINT` 常量，POST JSON 15s 超时，端点上线改一行即切，DTO camelCase 与前端 feedbackPayload 同构）；未配置回落 **mailto**（表单在 Mesa 填好、一键调邮件应用全预填）；「复制全文」兜底（正文结构两通道一致）。隐私口径：只在用户点发送时出网、只寄表单字段与环境行、无自动采集（关于页隐私行注明）；报告安全问题保留 GitHub 私密报告外链（漏洞披露需要保密通道，与需求收集不同）。 |
| 2026-10-12 | **版权落款改公司主体**（用户提供注册名）：`hongtongzhou-design` → `泽塔前沿科技（杭州）有限公司`，七处同步（LICENSE 附录/NOTICE/Cargo authors/tauri.conf publisher/设置→关于版权行/macOS About 面板/gen 脚本随包清单头，清单已再生成）。语言口径：版权声明对语言无要求，中文注册名是唯一精确主体名；公司未注册官方英文名前不写英文转译（自造英文名指向模糊），将来有官方英文名或出海时改中英并列。仓库链接与 updater endpoint 仍指个人 repo 不变（转 org 时按三处同步口径换）。 |
| 2026-10-16 | **文件页收口（体检后用户拍板「全做」）**。修三 bug：①「刷新」只重载根目录、展开的子目录缓存永不失效（收起再展开也不重拉）——刷新改根+已展开目录全部重读；②预览开着时 ↑/↓ 在 window 捕获层抢键，Monaco/输入框里按方向键直接跳文件（连带丢编辑）——`inTypingContext`（project-files.ts 唯一判据）放行打字焦点与组合键，口径=会话列表「仅非打字焦点」；③切文件/关预览静默丢未保存编辑——`ProjectFilePreview` 透传 `onDirtyChange`，宿主 `confirmLoseDirty` 在换文件/↑↓/关预览/深链替换/关窗口前确认（终端页脏点与终端树切根确认同款保护）。功能补齐：文件监听自动刷新（终端树同套 watch_dir/fs-changed，500ms 防抖，根+已展开就地重载+office 清单重拉，失败退手动刷新）；搜索/筛选平铺态预览头「定位」退回树视图并展开父链（复用 ancestorDirsToReveal，点击平铺行仍只开预览——保住在结果列表里 ↑/↓ 步进）；「最近」视图（FileKindFilters 末尾胶囊，数据=officeDocs 后端已按修改时间降序，recent 是视图不参与类型收窄，fileMatchesProjectFilter 恒真）；右键管理最小集（文件夹：在此打开新终端/新建文件夹（fs_create_dir，行内输入同终端树形态）；都有：复制路径（navigator.clipboard，先例 CodingProjectView）、删除（确认→fs_delete_path 走系统回收站，后端保护路径/根目录护栏；删中当前预览即关）。结构修正：窗口预览不再与侧栏预览同屏双挂载（原两份 Monaco 实例各持各的脏态、互不知情）——`preview && !windowed` 单实例，关窗回侧栏前过脏确认（重挂重读盘）。小修：Esc 关就地预览（焦点在预览内/搜索框/窗口态归各自处理者）、搜索框 Esc 清词+placeholder 与终端树统一、目录 2000 项与办公清单 400 条截断点名提示。不做（拍板记录在案）：文件页挂积累/正典台账徽标（与雷达抽屉重复，同一事实说两次）；git 字母装饰整套搬入（科研产物大头 gitignored，git 视角归终端树/改动面板）。user-guide §6.1、code-structure（ProjectFilesView/project-files.ts 条目）同步；tests/project-files.test.ts 钉 recent 语义与打字上下文。 |
| 2026-10-17 | **项目页走查（用户逐页截图「直接执行」）**。规则：①**科研台账整份读写走专用通道**——`read_research_ledger`/`save_research_ledger`（fs_tree.rs，16 MB 上限、白名单 papers/included.json·included.md·to-fetch.md·to-fetch.ris·endnote-import.ris·screening.md、notes/index.json、references.bib，带版本防覆盖、与预览保存同锁）；待确认清单、检索评审清单、待获取清单禁止回落 256 KB 预览通道（实证：199 篇带摘要的 included.json 298 KB，被截断后 `readFirst` 当「不存在」，界面误报「还没有 included.json」，8 篇待确认整块不可见、纳入/排除也存不回）。②**「确定文献来源」完成口径 = 选了非默认来源 或 这一步已开工**：默认检索不落值，旧口径只认非 search，AI 交付后「当前」竖线仍钉在来源行，真正该做的去评审不是当前。③**流程线删除线只给打勾的人工事项**：AI 干活/来源等节点完成态只用空心圆+降级色（划掉读作「取消/跳过」）。④**核对待确认篇目有待确认时不标「可选」**，行尾换黄字「待确认 N 篇」（模板口径本就是「没有待确认可跳过」）。⑤**精读步「AI 干活」行下给进度**（notes/index.json：reviewed 才算写完，全文/仅摘要分计，进行中 20 秒重读+窗口回前台重读；`src/notes-progress.ts`）——精读分批跑几十分钟，流程线原先看不出读到哪。⑥项目对话页：CLI 在跑的标绿点，步骤工作区里的对话标步骤名（编程标工作树名）。⑦文献雷达：巡检全停用时卡头标「已暂停」；筛选后小字由重复的「共 N 篇」改「筛掉 N 篇 / 另有 N 篇未显示」。⑧文件页行悬停图标改为行内排在行尾、顶替修改时间（`--color-hover` 半透明，旧浮层压在时间上透字）；类型徽标定宽槽，文件名对齐同一列。⑨目标详情历程每版/每条意见带时间。⑩对话注入面板去掉口语「都随便」。未做 Mesa Dev 实机界面验收（交用户按清单核对）。 |
| 2026-10-17 | **项目页走查二批（用户：「两个建议都做」+「综述项目雷达怎么没了」）**。①**步进器圆下加状态小字**（修订 v3.46「状态文字只进悬浮」）：第三条同列网格，进行中/等你确认/等你查看/待评审/有冲突/已完成/已归档，待开始与检查中不写、全不写时不占行；文案色单一出处 `src/stepper-status.ts`。②**精读步挂可选人工事项「抽查 3 篇笔记」**（综述/科研论文/毕业论文三套模板；after+optional+manual，不挡评审、不触发收尾软门），行下就地列三篇候选（全文/仅摘要各一+尾部补，确定性），点开在运行页预览；测试项目档案卡已同步加上（干跑副本验证 TOML 结构后落盘），综述流程测试精读步已完成未加。③**雷达「没了」根因是数据丢失**：订阅弹层「编辑源文件」把弹层 `initial` 整表写回，从巡检行打开时 initial 恒为空——一点就把关键词清光（综述流程测试 `.ccode/watch/<id>/watchlist.md` 10-17 14:59 被写成只剩注释）；关键词清空后雷达卡又整块收成一行「还没订阅读」，攒下的命中全被藏掉。修：新增 `ensure_watch_subscriptions_file`（不存在才建，存在不动）取代写回；关键词为空但有命中时整卡照常显示并加黄字提示行；用户的两条关键词（镁硫电池、球磨法）按当日巡检隔离树里的副本恢复。 |
| 2026-10-17 | **「N 处改动未存入历史」不再催 Mesa 自己的档案（用户截图：只列 project.toml）**。该提醒本义是「你改的文件下一步 AI 看不到」，但 `.ccode/`（台账除外）与 `.gitignore` 是 Mesa 自有档案，开工前已由 `commit_project_bootstrap` 自动提交——提醒它们等于让人提交一份自己没碰过的文件；且主仓脏会挡评审合并（ready_to_merge 要求 !main_dirty），设置页改规则、选文献来源都会写档案卡，人得先去提交面板处理。改：项目页提醒与开工弹层改用 `userWorkDirtyFiles`（剔档案路径）；评审打开时主仓脏先调 `commit_project_bootstrap`（同提交信息「Mesa: 项目档案卡与 gitignore 自动提交」，每次打开每主仓一次），剩下的才交提交面板（面板仍用 `userDirtyFiles`）。不改成「写档案卡即提交」：一次设置点击一个提交是历史噪声。本次触发源是二批给测试项目档案卡加「抽查 3 篇笔记」时直接改了被 git 跟踪的 project.toml。 |
| 2026-10-19 | **Windows 去原生标题栏（用户：比 Mac 多一行框，三个系统按钮应放命令面板右边）**。`lib.rs` setup 里 `#[cfg(windows)] set_decorations(false)`（不进 tauri.conf：`titleBarStyle` 只在 macOS 生效，且 dev 配置覆盖会整体替换 windows 数组）；前端标题栏 Windows 也走 `data-tauri-drag-region`，自绘 `WindowControls` 紧贴命令面板/待处理右侧（不放进会淡出的右组）；`ReaderOverlay` 顶栏盖住标题栏，同样挂一份；capability 补 `allow-minimize` / `allow-toggle-maximize`。代价：失去 Win11 最大化按钮的贴靠布局悬浮菜单（Win+方向键仍可用）。**Windows 字体发虚排查定论**（同日用户两轮并排对比，不再重复试）：透明窗口（Mica）下 WebView2 根层一律灰度抗锯齿；铺不透明 body、`--enable-lcd-text` / `--disable-font-subpixel-positioning`（WebView2 经环境变量追加，渲染进程不收）、`-webkit-text-stroke` 加粗均无效。曾用「页面容器 `will-change: opacity` 独立合成为不透明层 + 主区禁 `backdrop-filter`」拿到 ClearType，**用户实看彩边像马赛克，当日撤回**；且 `PrintWindow` 无损抓 Claude 客户端证实其正文同样是灰度抗锯齿——它看着清楚靠白字压近黑底的高对比，不靠渲染方式。**Windows 保持灰度渲染，清晰度只从文字对比度/字重上补**（同日已落：Windows 下深浅 14 套主题 l3/l4 再加深一档，细则 design-system「文字梯队」），不要再走 ClearType 合成层路线（另有层叠上下文压住页内弹层、`transform` 会成为 fixed 定位基准等副作用）。截图对比用 `PrintWindow` 抓窗口自身 PNG，别用 webp（有损压缩抹淡彩边、导致误判）；Windows 注册表缩放与实际不一致，以渲染进程 `--device-scale-factor` 为准（本机 1.5）。 |
| 2026-10-19 | **依赖一键安装 Windows 实测三处修复 + 选择器死循环**。①Windows 的 TeX：winget 源里没有 Tectonic（`winget search tectonic` 无结果，原 `TectonicTypesetting.Tectonic` 一装即「找不到程序包」），改 `quarto install tinytex --no-prompt --update-path`（Quarto 官方推荐、渲染时自动补宏包；须先装 Quarto），Windows 候选目录补 `%APPDATA%`/`%ProgramData%` `TinyTeXinwindows|win32`；macOS 仍 brew tectonic 不变。②Python：Windows 未装 Python 时 PATH 上的 python 是应用商店占位程序（AppInstallerPythonRedirector，跑起来无输出、错误码退出），找 Python 改为「PATH 与候选目录的全部同名程序逐个试跑 `import sys`」（`agents::resolve_binary_all`；macOS CLT 未装时跳过 `/usr/bin/python3` 不试跑，免弹系统窗）。**同日用户拍板「一键补齐」（Windows + Mac）**：缺 Python 时 DTO 带 `prereq: "python"`，按钮照给，先代装 Python（Windows `winget install Python.Python.3.13 --scope user --custom PrependPath=1`，不弹 UAC、排在应用商店占位前；macOS `brew install python`；无渠道给 python.org 出口），再一条 pip 把 PyMuPDF + Pillow 一起装（两行按钮前后端都互斥）；PEP 668 重试改带 `--user --break-system-packages`（旧的只加 `--user` 必然再失败）；Windows 候选目录补 `%LOCALAPPDATA%\Programs\Python\Python3xx` / `%ProgramFiles%\Python3xx`（新版本优先），装完不重启就能找到；PyMuPDF 探测优先 `import pymupdf`、旧版退 `fitz`，版本取末行（新版 `fitz` 导入先打弃用警告，曾被当成版本号）；设置页两行加白话用途（综述拼图：从 PDF 里裁图 / 把图排成一版）。本机实测：点一次装好 Python 3.13 + PyMuPDF 1.28.2 + Pillow 13.0.0，约 2 分钟。 **同日追加「用到时再装」的 Git / Node.js 收口**：①共用 `GitInstallOffer`（dep-install.tsx）——错误为「找不到 git 可执行文件」时就地一键安装，用在改动面板、科研步骤「历史」浮层、开步失败的项目页报错条（装好后前两者自动重读，开工提示再点一次）；Mac 无 brew 走 xcode 时只提示「已打开系统安装窗口」不报装好。②连接页缺 Node.js：记住要装的 Agent，Node 装好后清报错并自动接着弹该 Agent 的安装确认。③winget 装 Node.js 钉 `--scope machine`（其用户范围包是绿色解压版、没有 npm.cmd，winget 偏好用户范围时会被选中）；winget 系统级安装前先提示 UAC 要点「是」。④安装类子进程 PATH 前插程序所在目录（刚装的 Node 不在已运行 Mesa 的 PATH 上，npm postinstall 里的 `node` 会找不到）。⑤安装命令报错但程序已就位（winget「已安装/无可用升级」）按装好处理。⑥Windows 候选目录补 `%LOCALAPPDATA%\Programs\Git\cmd`。**未实测**：本机已装 Git / Node.js，拆掉会断开发环境，全新安装需在干净 Windows 与 Mac 上点验。 **同日 Windows 排查修复 python3**：`endnote.rs` / `research_quality.rs` / `zotero.rs` 原先先找 `python3`，Windows 上必中应用商店占位（python.org 只装 python.exe），EndNote 导出、Zotero 导出、复现检查装了 Python 照样失败（cargo test 4 项实证）；三处改走 `dep_check::usable_python()`（PATH 未刷新也靠候选目录找到）。技能 blender-research / endnote-bridge / zotero-sync / review-figures 标题下注明「Windows 上改用 python」，review-figures 的 `python` 统一为 `python3`（Mac 常无 `python`）；正文字体指令（manuscript-font.ts）同注。 **同日 Windows 全量排查修复（用户「全部修」，四组并行）**：①自绘标题栏回归——z-30 全屏页（流水线编辑器 / 历史 / 沉浸编辑）右上按钮压在窗口按钮下、z≥40 遮罩挡住窗口按钮，Windows 上一律从标题栏下沿起铺（沉浸阅读 `ccode-covers-titlebar` 豁免）；②WebView2 刷新 / 打印 / 查找 / Alt+←→ / 鼠标侧键与正式版默认右键收口（windows-shell.ts）；③内嵌终端 PowerShell `-ExecutionPolicy Bypass`，复制命令写 .exe/.cmd 绝对路径；④精确注意力 hooks 改 `.ps1 -File`，启动自动迁移旧写法；⑤人工事项勾选、交接摘要、产物清单的 `\?\` 前缀；⑥终端开在工作树里时拒绝归档 / 删除（Windows 删不掉会删一半）；⑦写配置有限重试、git longpaths、删除保护补 Windows 目录（AppData 整体保护但放行 %TEMP% 子路径）；⑧编码：卸载按退出码判、诊断 PowerShell 切 UTF-8、Python 子进程 UTF-8、clip.exe UTF-16；⑨MCP 的 npx.cmd 解析、外部 cmd 拉起引号与 `%`、配置 BOM；⑩端口监控 /T /F + IPv6、更新超时杀进程树、winget show 参数与超时、更新渠道识别、EndNote 启动不等待；⑪终端中文标点重复、Ctrl+C 复制后清选区、写 shell 用 `\r`、Win10 无 Mica 回实心底、收件箱重复、Finder/⌘ 文案、字体安装按钮；⑫「用系统应用打开」补 opener 打开路径权限（全平台）、`CLAUDE_CONFIG_DIR` 下技能目录（全平台）。验证：cargo test 1473 / npm test 1738 全过、生产构建通过；**界面点验未做**（实施时 Windows 锁屏）。规则沉淀见 conventions/environment.md「Windows 硬化规则」。PTY 命令失败且零输出时回报退出码。③安装日志刷屏：`
` 改为拼接后再展开（`strip_ansi_keep_cr` + `collapse_cr`；`CSI G` 回第 1 列视同 `
`），前端 `stream-text.ts` 同口径，依赖安装 / CLI 更新 / 字体安装三处日志共用。④zustand 5 选择器 `?? []` 每次新数组，`hiddenProfiles` 为 null 时项目页三组件一挂载就 Maximum update depth exceeded、应用起不来（跨平台潜伏 bug）：改共用 `selectHiddenProfiles` 回落模块常量，`tests/store-selector-lint` 钉住选择器里不写新建对象的缺省值。 |
| 2026-10-18 | **编程页分支地图（用户截图：要清楚体现复杂的分支关系和状态、保持美观；领先落后进度条不美观）**。规则：①领先/落后只相对基准算 → 工作树与本地分支合成一棵以基准为根的树（`arrangeBranchMap`），节点形状表位置（基准环+芯 / 已检出实心 / 未检出空心）、颜色表活动（空闲 / Agent 在跑 / 冲突），圆角肘线挂主干；②**撤掉双向进度条**（取代 2026-09-07 `codingDivergenceBar`），改写「比 <基准> 领先 N · 落后 M 个提交」（GitHub 中文口径），只有落后数着 warn 色；③其余 git 事实语义色只给图标、正文中性、不铺胶囊底（整行琥珀色让什么都不突出）；④「本地分支」区并入地图：已检出分支只出现一次，未检出收末尾折叠头（≤3 默认展开），「合并进 <基准>」随工作树卡 ⋯；⑤身份段不再重复「基准 X」，孤立的「为 X 建工作树」与「主仓不在基准」芯片收进地图根行。细则 design-system.md / coding-git.md §4。 |
| 2026-10-18 | **工作副本家目录可自定义（用户：Windows 缓存越用越多撑满 C 盘；「只做工作副本根目录」）**。设置 → 数据与存储 →「工作副本位置」选目录 `B`，此后新建的编程工作树 / 科研工作副本 / 定时隔离树落 `B/ccode/{worktrees,workspaces,watch-worktrees}`。**保留 `ccode` 这一层**：`runs.rs` / `run-model.ts` 靠路径片段 `/ccode/workspaces/` 等推断任务类型，不能因挪位置失灵。**只管新建、不自动搬**：已有树的路径在库里，原地照常用（git 工作树带内部路径引用，悄悄搬会坏）；换位置后旧位置仍在「本机占用」里单列「旧位置」让人看见 C 盘还剩什么，走项目页归档/删除释放。**红线**：①所有「在哪新建」走 `ccode_home::current()`，所有「是不是 Mesa 自己的路径」类判定（会话归并编程树、watch 会话兜底标 internal、recent_repos 排除、卸载、定时任务删除时清隔离树）走 `all_roots()/all_sub()`（当前根 + 曾用根 + 默认根），漏一处就会让旧位置的树被当成普通项目或清不掉；②自定义位置不可用（盘没挂上）时**不悄悄回落 C 盘**，建目录处报错，免得两处各放一半；③只经 `set_workspace_root` 写（校验：绝对路径、非盘根、不落进 `~/ccode` 或配置目录、可写探测），`update_settings` 的 merge 不搬运这两个字段；④`workspace_root_history` 记曾用基目录（封顶 8），换位置/恢复默认时旧值入名单、新值出名单。**不动**：Mesa 数据（`%APPDATA%\ccode`，app.db/密钥/锁都在里面，56 处直读平台配置目录，改整体位置风险大）、`scratch`（快速开聊历史按 `~/ccode/scratch` 列）、`reproductions`（复现输出受「须在受管目录内」校验）、`%LOCALAPPDATA%\ccode\task-runs`（普通目标副本，有自己的清理入口）、各家 CLI 自己的会话目录。 |
| 2026-10-17 | **开工确认弹层重排 + 上游未保存提醒（用户截图「开工卡片的 UI 优化一下」）**。截图暴露三类问题：①**流程**——检索步待评审时开精读，「已有材料」只列项目里的旧清单（included.md 6 篇、included.json 还没有），新清单 191 篇还在检索工作区，弹层不点破，人会读着旧清单开工；②**同一事实说两遍**——「所选 Agent 的技能与工具」整块只说 lit-notes 已启用，下面「技能」又列一遍；③**版式**——标签各占一行、间距各异，「已有材料」芯片因全站 `button { font: inherit }` 吞掉 text-micro 比「本步产物」大一号，弹层容器的 title 悬浮「工作区 lit-notes」压在任务书正文上。改：上游未保存软门（`unsavedUpstreamSteps`，必读输入与前面进行中/待评审/有冲突步骤的预期产物重叠即报，置顶 + 去评审/去处理冲突，与收尾软门共用二击「仍要开工」，不阻断，守 R6）；技能预检就绪时收成一行小字；标签列版式 读入→产出→执行→思考档→技能→权限→任务书（「已有材料/本步产物」改名「读入/产出」并按先读后写排序）；工作区名移到标题行。用临时 harness + 17575 Vite + headless Chrome 截真组件核过两态（上游未保存 / 技能缺口）。全站按钮字号被吞的问题未在本批处理（另起任务）。 |
| 2026-10-17 | **项目设置抽屉收口 + 对话注入补完（用户截图：「项目设置这块 UI，对话注入功能是否完善」）**。注入功能核对：四个直接开聊入口（＋新对话 / 问 AI 走 beginAskAi，编程页「进入」enterTree，巡检开聊 ScheduleSection→beginAskAi）都按三态取包，目标包不受影响——口径成立。补三处缺口：①**选了自定义却等于没选**——切到自定义时模板为空就直接填默认版式并保存（空模板 fail-open 回自动的规则不变，只在人清空时出现）；「填入默认模板」改为「恢复默认模板」，覆盖非默认内容前确认；②**预览不是所见即所得**——预览原先读盘上已保存的配置，改模板要先失焦保存才看得到；`loadProjectContextPack` 加 `sessionOverride`（只管 session 包），预览按面板当前档位/草稿 400ms 防抖重渲；③保存合并的「最后一次入队」原是每次渲染重置的普通 let，跨渲染两次保存会都落盘、可能旧盖新——改 ref。界面：占位符 11 个大按钮改成「插入」后一排小标签（显示名字、悬停说明）；↻ 移到预览标题行；说明句缩成一行小字。验收记录由三行一条（技能名 lit-watch、版本短号、与类型重复的系统备注「定时巡检采纳」）改一条一行「对象 · 发生了什么 · N 个文件 + 时间」（`acceptanceEntryRow`：lit-watch→文献雷达、版本与文件清单进悬浮、系统备注不重复）。字号：基本 / 研究流程 / 文献与数据 / 注入 / 验收各容器定 text-xs（全站 button 吞 text-* 的问题另起任务）；「文献与数据」折叠标记去掉方框与其余分区统一。临时 harness 截真组件核过自动/自定义两态。 |
| 2026-10-17 | **对话注入「自定义」改分段编辑（用户：编辑方式不好用，贴了满是 `{{占位符}}` 与空行的模板原文）**。原形态是一整块模板文本框：增删一段要记占位符名字、数空行，看不出每段会带进去什么，排顺序只能剪切粘贴。改为有序清单（`SessionTemplateEditor` + 纯逻辑 `session-template-blocks.ts`）：独占一段的内容占位符（文件地图/课题主题/工作环境/项目规则/人的决定/技能纪律/长期知识/已验收）一行一个，显示本项目此刻的内容摘要（`sessionTemplateValues` 与渲染同一出处，空段明说「开对话时省略」），悬停 ↑↓×，去掉的在下方「加回」、按标准顺序插回原位；其余段是可直接改字的文字块，聚焦时可插入行内名字（项目名/工作方式/项目目录）。**存储格式不变**（盘上仍是同一份模板文本，后端/渲染/旧档案零改动），拆了拼回与原文等价（测试钉住默认模板往返一致、夹在文字里的占位符/重复段/未知名字按文字保留不丢字）。逐字控制版式仍可「编辑源文本」切回原文框。结构变化即存，文字失焦存。 |
| 2026-10-17 | **对话注入「自定义」定为「勾选 + 补充一段话」（用户三轮：原文模板、可排序段落清单都「不方便」，三选一拍板，取代上一条的分段清单）**。日常要的只是「这段带不带」和「再交代几句」，排顺序、记占位符名字都是负担。形态：9 枚开关标签（项目基本信息 + 八个内容段，悬停看本项目此刻内容，勾着为空标「（空）」）+「我的补充」文本框（放说明末尾）；顺序固定为标准顺序；标签即存、补充失焦存。存储格式仍不变（同一份模板文本：基本信息段 → 勾中内容段 → 补充），`parseSimpleTemplate` 认不出的手工版式（顺序调过、文字夹在中间）明说「用勾选改不了」并给「编辑源文本 / 改用勾选（只丢顺序不丢字）」。调顺序、逐字控制只走「编辑源文本」。分段清单编辑器同批删除，不留第二套。 |
| 2026-10-19 | **聊天层播放本机音频（用户：读音能不能在聊天里直接播；「这是不是聊天层的优势，终端不能放」）**。回复里提到本机音频（mp3/wav/m4a/aac/aiff/flac/ogg，相对 / 绝对 / `~/` 都认，网址不认）就在正文下给播放条；音频不再出「打开文件」小标签。**口径**：①字节只经 `read_audio_bytes`（与图片同一套 `read_whitelisted_sync` 白名单、20MB、文件头校验，扩展名对内容不对的拒绝），前端拼 Blob 交 `<audio>`；②CSP 生产与开发同加 `media-src 'self' blob:`，**不放 data: / https:**——会话内容按不可信处理，远程音频与 data URL 都不开；③`![x](a.aiff)` 这种把音频写成图片的不进读图通道，留文字；④Mac 上 `say -o` 的 AIFC 经真实 WKWebView 实测可放；Windows 的 WebView2 放不了 aiff，播放条如实提示，不另转码。AI 只用 `say` 直接朗读时没有文件，聊天层无从播放（说明书写明请 AI 存成文件）。 |
| 2026-10-19 | **Codex 终端启动 warning 收口（用户：终端显示 3 个 warning）**。本机 0.163 PTY 实录 F2 逐条：①`disable_response_storage` 是用户 `~/.codex/config.toml` 里的旧键（cc-switch 模板写入，Mesa 不写）；②`service_tier auto not advertised`——Mesa 的 `-c service_tier="auto"`（v3.188 防 priority 进中转）；③`Running without the shared background server`——Mesa 用 -c 注入就只能内嵌运行。0.163 起 CLI 自己丢掉没声明的档位（实测：配置 priority 时网关收不到 service_tier），②改为只给旧版 / 查不到版本时塞；③交互式启动显式加 `--no-daemon`（`resume`/`fork` 也认，`exec` 不认，所以只加在 `prepare_launch` 不进 `launch_plan`）。版本门槛 = 实测过的 0.163，旧版不认 `--no-daemon`，带了起不来。①不替用户改 CLI 配置（只读口径），说明来源由用户决定删不删。MCP 两条（Consensus 密钥、Undermind 登录）是用户环境，不在此列。 |
| 2026-10-20 | **用户文档术语统一（用户：按术语审查建议优化教程与说明书）**。说明书 §14.1 改为「常用词对照」，作为 tutorial.md / user-guide.md 共用的术语表：同一概念只用一个词（项目＝通用、课题＝科研叙述、项目文件夹＝讲路径；工作副本＝AI 处理成果的独立空间，工作树只用于编程；审核成果→保存到项目，「合并」只用于 Git 机制；运行＝一次执行过程、对话＝交流内容、历史会话＝已保存记录；Agent / 模型 / 网关 / 连接分开说）。**界面原文不在文档里单方面改名**：去评审、保存进项目、逐条裁决、主仓、任务书等仍以粗体原样写出，首次出现用括号白话解释；要改按钮名须先改界面再同步两份文档。「任务书」保留（高校常用词，界面 26 处在用），文档不另造「任务说明」。**同日界面改名三处**（用户「你觉得需要改吗」→ 同意推荐）：开工确认弹层勾选项「开工接驳」→「一并带上未保存的清单与笔记」，评审横幅「沉淀到下一步」→「带到下一步」，想法卡「◈ 沉淀进任务书」→「◈ 写入任务书」；内部代码名、接驳提交的 git 提交信息与 TASK.md 里「评审沉淀」小节标题（step-decisions 解析标记）不改。叙述性口语与内部黑话（课题是家、成稿走副本、密钥不出门、拍板、随口问一句、总账、闭环、留痕等）退出用户文档。 |
| 2026-10-21 | **回放往上翻自动加载更早的（用户：对话列表看对话、聊天层都要一直点「加载更早」）**。两处一起改：后端一页从至少 6 条提到 40 条（工具调用也算条数，6 条往往不到一轮），凑不够时窗口 192KB 起逐次翻倍、单步封顶 1.5MB、单次请求最多扫约 7.5MB；前端对话页、项目「对话」、聊天层共用 `useAutoLoadOlder`，滚到离顶 360px 内或在顶部向上滚轮即拉下一页，不满一屏自动补页，只认用户滚动、不在挂载时按 scrollTop 判断（首屏先在顶部渲染，会被误判成翻到顶一路拉完）。同日用户反馈「按钮还在，滑的时候闪」：顶部按钮去掉；前插后的位置恢复从 rAF 挪到 layout effect（绘制前），不再先画一帧跳位。随后用户要「无缝衔接」：加载提示行也去掉、顶部不留占位，预取提前到离顶一屏半（下限 360px），滑到顶之前更早的内容已经接上。再反馈「一瞬间的顿挫感」：滑动途中前插要同步改 scrollTop，WebKit 里打断惯性外加整列重排；改为预取提前到三屏、拉回来先攒着，手停（140ms 无滚动事件）才接上去，离顶不到半屏才不等。再反馈「已工作」收起行在加载更多时时长、命令数会变：分页按字节切，开头常是半轮（提问在更早一页），所以还有更早一页时先不显示开头的半轮（`firstCompleteTurnIndex`），加载到它的提问再一起出来；分页本身不改。项目「对话」原先前插后不保阅读位置，同批补上；聊天层的位置补偿改成只在原首条往后挪时生效（等旧页途中最新窗刷新会把补偿用错）。 |

### 从 AGENTS.md 迁入的拍板记录（2026-09-06 ~ 09-08，2026-09-22 归档）

- **项目页视图（2026-09-06；2026-09-10 加「对话」页）**：项目页顶栏是当前项目身份（名称、工作方式、课题主题、路径），添加项目在左侧列表 +。已注册项目页签顺序为「对话 → 科研任务 / 工作任务 / 编程任务 → 定时任务 → 文件 → Agents」。**对话**只看当前项目的记录（默认铺开列表，点一条才回放；展开后列表不显示 Agent 标签，关闭在右上角，方向键换会话；思考/工具调用默认折成一条过程；可继续/归档、＋新对话），不是侧栏那份全局历史；打开项目默认仍进任务页。＋新对话注入**会话包**（项目是谁、顶层有什么、规则、跟这次说的做），不把目标说明、技能名单、「尚未完成」或「验收后才进项目」塞进对话；勾「验收后写入」才改走目标包。任务页是该工作方式的主面（有流程科研=步骤/工作区，无流程科研=目标，办公=人声明任务，编程=工作树），**不再放右侧对话栏**。文献雷达和定时任务在「定时任务」页签。规则和验收记录收进顶栏 ⋯「项目设置」抽屉。文献/笔记/数据/图像只在「文件」页，任务页不预留空块。文件页：点文件才弹出右侧预览；预览有上下切换，窗口预览时方向键也换文件；顶栏类型图标（空类型不占位）+ 搜索 + 刷新；行悬停图标（问 AI / 沉浸阅读 / 显示，不挤文件名）——沉浸阅读给 PDF 与 `.md` 笔记（md 走 `reader_for_note` 配对 PDF，无配对就报错不硬进），目录树行与搜索/筛选平铺行都有，预览工具条同入口；可切窗口预览。规则面板无说明句。**有研究步骤的科研不展示技能和「写回时跳过」**（技能以步骤挂载为准；写回时跳过是目标验收不覆盖的路径）。无流程科研 / 办公才用技能 + 目标点名，以及写回时跳过；编程用技能、不展示写回时跳过。办公文档筛选与文件页同一套图标。本项目对话未命名显示「对话」。有进行中/待验收目标时雷达默认收起。Agents 页是这个项目的 Agent 名册（点配置名换该项目绑定，下拉列出这条连接的每一个模型，点一个只记在本项目；＋新对话 / 跟 AI 商量 / 聊想法 / 开工用这份绑定和模型，未另选则用名单第一个；本项目继续该家会话也用这份绑定、正在负责哪些目标），点目标回任务页；不是连接页的模型配置表单。加减模型仍去连接页。项目内新会话不沿用上次终端连接。继续会话启动栏必须显示该绑定，不能因 Codex 渠道兼容池静默换回上次的网关；渠道不同时预填绑定、不自动启动，确认后点运行。没有目标时不逐家重复空状态。不自动分派，密钥仍在连接页。编程工作树 ⋯ 可事后分组。侧栏「对话」仍是跨项目全局历史；定时任务在项目「定时任务」页签创建，后台不进正在进行、不进本项目对话。**侧栏没有定时任务页**（2026-09-13 用户移除）：侧栏九页 = 工作台/项目/运行/对话/连接/技能/MCP/用量/设置，页切快捷键、启动页选项、导航胶囊、settings.rs KNOWN_PAGES 都按这九页对齐；全局 page id `schedules` 只作旧持久化值的重定向（App.tsx 转到项目定时任务页签），不得再把定时任务加回侧栏或九页清单。
- **绑定与网关命名（2026-09-06）**：Gateway.name 是共享端点/网关名称，Binding.name 是单个 Agent 配置名称，必须分开存储；旧 Binding 缺 name 时展示回退 Gateway.name。修改 profile 名称只更新 Binding.name，不得改共享 Gateway.name 或其他 Binding。相同 Agent + 网关允许不同模型选择，完全相同的模型/协议/附加环境变量仍拒绝重复。
- **模型越强，产品越管环境和验收（2026-09-07）**：不跟 Codex/Claude 比「我也能执行」。闲聊用＋新对话（项目根直接改）；成稿用新建目标（隔离 + 人验收 + 项目记住）。Agent 弱时科研步骤仍可当护栏；Agent 强时把引导撤掉。禁止靠更强编排/自动拆任务来对抗更强模型。
- **有流程科研的决定、复现与验收（2026-09-08）**：硬暂停认决定状态，不认非空文字。状态闭集为批准指定范围／仅允许准备／待补证据／不批准，与说明分开写；旧纯文本不自动批准，不用关键词猜授权。批准绑定当时报告指纹，指纹变了要重确认。复现只认脚本约定（`MESA_REPRODUCE` 或 `reproduce` 子命令），输出必须独立于输入项目，落 `~/ccode/reproductions/`，界面只读本次运行输出。科研验收决定（接受／有条件接受／退回）写 `.ccode/research-acceptance.json`，不替代也不禁止 Git 合并。运行结束、计算检查、人工验收三层状态不得合成一个绿灯。不得把报告里的「通过」自动当成质量通过。
- **目标与验收（2026-09-06；2026-09-10 会话包/目标包拆开）**：无流程科研和工作的「新建目标」写一句话即可，可先记下再开始；默认把整个项目复制进隔离副本，人验收后写回。可选用指定资料或不带入。＋新对话默认直接改项目根；开聊可选「验收后写入」。列表只显示 `user:` 声明目标，按尚未开始 / 进行中 / 待验收 / 已完成分组，时间线是生成→意见→下一版→已接受。验收不满意写意见，同一目标沿用上一版隔离目录再跑。文件页待验收文件打标。**目标** Context Pack 带工作环境、项目规则、保护路径、已验收产出与意见、未完成目标；**会话**只带身份、目录、规则和「按这次说的做」，不把目标当对话任务。验收接受写入 `.ccode/project-status.json`。任务页头部「项目现在」。项目规则可编辑（未改过补工作方式默认条）。**「写回时跳过」和技能只给无流程目标 / 办公**（勾上的路径验收写回不覆盖；技能 = 名单 + 点名）；编程用技能、不展示写回时跳过。有研究流程的科研只用步骤挂载，不设技能名单，也不展示写回时跳过。科研目标验收按文献/笔记/数据/论文分组并可预览；工作目标按文档/表格/幻灯分组并可预览；编程验收仍是工作树改动面板、合进基准、PR，不套目标验收弹层。有流程科研走步骤/工作区。禁止自动拆任务、智能路由、创建时空目录、人设 Agent 槽。普通目标副本清理分两步、各需确认（先工作副本，再历史冻结）；清理后任务与接受记录保留，不能从已删副本续跑。不得删除仍被其他项目或运行引用的目录；中断后待删目录被外部改过则拒绝继续删除。归档不等于清理副本；待验收可归档，未完成接受或未完成清理不得归档，清理未完成也不得恢复。
- **确认框与自动路径（2026-09-06）**：`confirmDialog` 默认焦点在确认钮，Enter 激活当前焦点按钮（焦点在取消则取消）。「设为全局」本机有 cc-switch 时挡路（Codex 另认 live custom/catalog），焦点在取消（`focusCancel`）。快速开聊直达只接受记住的那条 profile，失效退回弹层。Custom Runtime 不是隔离工作树任务；写盘必须离开主仓只约束 pipeline/coding/watch。网关目录按槽刷新。交互 `pty_write`（含选段问 AI）失败必须可见。

## 11. 演进线（2026-08 定稿）

定位从「通用 Agent 控制台」演进为 **AI 科研工作台**：底层仍是九个 Agent CLI（Claude Code / Codex / Gemini / Qwen / OpenCode / Kimi / CodeBuddy / Cursor / Grok Build）的统一控制台，表面是科研流水线（读文献 → 整数据 → 做图 → 写论文）。一句话：**AI 负责干活，Mesa 负责管活，人负责拍板。**

### 11.1 三条纪律

1. **科研语义进模板和数据，不进逻辑**：流水线步骤、任务简报、技能包都是可编辑预设；引擎保持通用，不认识「文献」「论文」这些概念。
2. **验收层是护城河**：每一步成果必须人工评审才合并进入下一步（沿用 §6.10 评审流与全宽评审覆盖层）。
3. **跨厂商中立是生存线**：九个 CLI 平等支持；API 与官方账号双轨并行（§11.4 P1a）。

### 11.2 量化目标

- 任何一步从「想做」到「Agent 在跑」≤ 3 次点击。
- 步骤间产物传递 0 次手动复制路径。

### 11.3 五个核心机制

1. **项目档案卡 `.ccode/project.toml`**：资源清单 + 流水线定义，跟着 git 走；资料只记位置不复制。
2. **流水线 Pipeline**：内置可编辑模板（默认英文综述路径：文献检索与筛选 → 文献精读与笔记 → 综述大纲 → 综述初稿 → 润色与定稿），每步预设工作区名/任务简报/技能/run 脚本/预期产物。
3. **一键开步**：点「开始」= 建工作区 + 启 Agent + 注入简报 + 落成 TASK.md，一次点击；是既有工作区创建与终端启动能力的组合调用，不破坏手动启动栏主流程。
4. **接力包**：跨 Agent 交接——从当前会话生成结构化简报（目标/结论/进展/git 状态）落成文件，新 Agent 带简报启动，记录接力链；明示是**接力不是记忆转移**（v1 结构化模板，AI 摘要可选增强）。
5. **提货单 `artifacts.yaml`**：大产物（数据/图/PDF）不进 git，清单进 git（名称/路径/hash/来源），随合并传给下一步。

### 11.4 阶段表（新 P0–P5）

| 阶段 | 内容 |
|---|---|
| **P0** | 收尾当前批次：全量文档同步 → 走查 → `[skip ci]` 提交 → 可选发版 |
| **P1a ✅** | 官方账号：profile 双类型（API / 官方账号）；终端内跑 CLI 登录命令连接；只读检测 auth 文件显示已连接 + 冲突配置黄色警告；拉起不注入 API env 且 `env_remove` 残留密钥变量；统计页官方账号显示「订阅」不计费；第一批 Claude / Codex / Gemini（随 P1d 注册表落地，v3.17） |
| **P1b ✅** | 流水线骨架（v3.18）：project.toml 读写 + 项目注册；工作区页按项目分组 + 步骤胶囊概览（状态从工作区派生，无双状态机；进度条收敛为「研究流程 d/t」文字；后演进为大圆步进器，v3.46）；一键开步（含 bootstrap 自动提交、TASK.md 进 `.git/info/exclude`）；资源面板登记 + 自动发现；非 git 目录引导 init（默认 .gitignore 含 `*.pdf`）；首启引导为轻量版（模板选择器），演示数据完整版留 backlog；工作区类型驱动默认值（数据类跳端口）未做，留 backlog |
| **P1c ✅** | 供应商预设补齐：claude-code 补 DeepSeek/智谱 Anthropic 兼容端点、codex/qwen/kimi/opencode 补 DeepSeek/智谱等；此后加供应商 = `src/presets.ts` 预设表加一行 |
| **P1d ✅** | 适配器注册表（v3.17）：per-agent 硬编码 match 收敛为 `agent_specs.rs` 中央声明式 AgentSpec 注册表（一个 CLI 一张规格）；会话解析器与 usage 提取器保持每 CLI 一个解析器文件，注册表只做分发入口；加新 CLI = 一张规格表 + 一个解析器文件 + 测试 |
| **P2 ✅** | 文献：PDF 预览（P2a 直接 pdf.js，WKWebView spike 跳过，`read_pdf_bytes` 白名单，v3.14）；选段问 AI（pty_write 注入活跃标签输入框不自动回车）；整理为笔记（P2b，`pdf_owner_project` + `append_workspace_inbox`，v3.19）；文献技能包（lit-search/lit-notes/review-framework/review-writing） |
| **P3 ✅** | 数据 + 接力（v3.15/v3.20）：数据处理模板 + 技能包（data-clean/data-eda）；提货单 artifacts.yaml v1（手动登记 + md5/大小，下一步 TASK.md 自动带提货单段）；图片评审双栏看图；长任务 OS 通知；接力包 + 接力链对话页可回溯 |
| **P4 ✅** | 论文（v3.21）：manuscript 模板（科研论文/毕业论文）+ quarto render 脚本（RX4a 追加 export-docx）+ quarto-render 技能；提货单登记的根外 PDF 产物纳入预览白名单；bib 联动以模板简报引用 references.bib 务实落地 |
| **P5 部分 ✅** | 通用层打磨（v3.21/v3.22）：逐 hunk 验收 ✅（v1 边界=仅未提交）、跨标签聚合视图 ✅、成本按工作区归因 ✅（任务成本）、订阅口径 ✅、历史时间线视图 ✅（first-parent 主线 + 白话翻译）；批量验收、云端会话双源调研留 backlog |

**Backlog（记录不动手）**：SSH 远程执行（数据集在实验室服务器时启动）、MCP 配置分发调研、团队协作 2.0、PDF 批注系统（永远不做）、深度阅读器（✅ 已落地为沉浸阅读区，v3.96）、批量验收、云端会话双源调研、首启引导完整版（示例课题带演示数据 + 示例 PDF）、工作区类型驱动默认值（数据类跳端口）。

#### 历史设计记录：定时任务与研究流程的结合（已落地部分闭环，2026-08-18）

**先定一条边界：不给每个步骤配定时任务。** 研究步骤绝大多数是一次性的（检索一次、精读一次、写一次），逐步挂调度属过早抽象，与 v3.75「不做独立任务中心页——任务必绑项目，全局页是过早抽象」同源（方向相反的同一类错误）。定时任务的正确形态是**跨步骤的后台哨兵**。

真正的缺口是**产出与流程脱节**：`lit-watch` 把新文献写进 `notes/inbox.md`，流程里没有任何地方消费它，用户得自己想起来去看。结合点应是「产出回流」而非「配置下沉」，且尽量复用既有机制：

1. **产出进收件箱**：定时任务发现新条目 → 进「待你处理」（`inbox.ts` 已有分类体系），而不是新造一套提醒。（✅ v3.95）
2. **关联步骤**：定时任务增加可选的「关联步骤」字段（如 lit-watch → 文献检索与筛选），产出挂到那一步，而不是浮在项目层。（✅ v3.95）
3. **复用上游漂移语义**：已完成的步骤收到新输入，与 `staleUpstream`（「上游 X 有更新，产物可能过期」）是同一个概念——不新造第二套「有新发现」提醒，直接沿用该口径与文案。（✅ v3.95）
4. **落点收敛**：定时任务的技能简报统一写死「只允许新建/追加 `notes/inbox.md`、`papers/watch-*.md`，其余文件一律不动」（lit-watch 已基本如此，推广为通用约定）。语义进模板不进引擎，符合纪律一。

**同时记录三条已确认的风险**（`ai.rs:60-90`、v3.75 风险遗留）：

- **写权限边界九家不齐**：仅 codex 有沙箱（`-s workspace-write`）；grok 用 `--yolo`（全放行、无沙箱，且注释自陈「默认权限模式未确认」）；claude-code/gemini/kimi/codebuddy/cursor/opencode 不带权限参数、依赖各自默认；**qwen 是纯位置参数兜底，能否无头跑都未验证**。定时任务是唯一在用户不在场时写项目文件的路径，却验证最少。
- **绕过验收层（历史）**：v3.75 曾把 `cwd` 设为项目根。v3.224 起默认定时隔离 worktree；v3.225 补播种与「采纳进主仓」。不得再把「cwd = 项目根」当成当前实现。
- **超时状态不可分**：10 分钟超时记为 `error`，用户分不清「真失败」与「没跑完」（订阅行多时 lit-watch 跑三路 API + 去重可能偏紧）。超时应单列状态。

**历史优先级建议（2026-08-18）**：先做能力标注、落点收敛，再做产出回流与工作区评审。上述能力目前均已进入实现；非 Git 项目 fail-loud。剩余验证属于实机/运行观测，不改变当前运行规则；不得把本历史风险段当作当前实现缺口。


### 11.5 明确不做（附理由，否决记录见 §10 v3.5–v3.12）

- AI 自动拆任务 / Agent 编排引擎（造 meta-agent）
- MCP 协议接入 / 自建协议（Ccode 无 tool-call 循环，概念错位；MCP 配置分发 ≠ 接入）
- 智能路由引擎（只做使用数据展示）
- Docker/VM 沙箱、daemon 化、手机同步（双向、常驻）、云中转（贬值层；手机往桌面单向投递、Mesa 开着才收已于 2026-10-20 放行，
  见 §10 当日条目「从手机添加」）
- Zotero 式文献库 / 数据表格查看器（别人的战场；Zotero 仅作为内核只读进料口，用户明确授权时可由 `zotero-sync` 技能写入，Ccode 不接管个人库）
- AI 全自动写论文绕过评审（底线）
- keyring 回退（cdhash 坑，v0.3 已定论）
- 会话「无缝继续」表述（技术不存在，一律称接力）
- 把科研 `workspaces` 与编程 `coding.rs` 并成一个库（隔离语义统一、表不合并；v3.202 / v3.221）
- 为「操作系统」叙事重做侧栏与八页信息架构（v3.221：对象模型升级，表面仍是工作台）

### 11.6 Run / Task / Runtime 当前硬规则

- 产品对象关系固定为 `Project → Task → Run`。Task 表达人的意图，Run 表达一次执行；重试或恢复不得复制 Task。
- `runId` 是工作台、收件箱、对话页和评审请求的唯一跨界关联键；`tabId` 只是终端视图指针，`reuseKey` 只用于入口幂等找回。
- `WorkspaceReviewRequest.runId` 若存在必须原样传入评审；`worktreePath` 只决定 diff 所在目录，评审不得从 cwd 猜 Run。缺少 runId 时可以打开未归因评审，但必须明确显示未绑定。
- 启动顺序固定为：创建 Run → 校验隔离路径 → 启动 Runtime。任一步失败都不得启动后续进程，并保留可诊断的失败原因。
- `Custom` 直接启动用户登记的命令；进程 cwd 必须在该次 Run 的工作目录内。Custom 不是隔离工作树任务，项目根和 scratch 可以启动。没有会话恢复能力，结束后再次运行创建新 Run。
- 定时任务默认使用隔离 worktree，不自动合并；成功产物经只读评审，人点「采纳进主仓」才拷回项目根。当前没有主仓 sentinel 配置入口，不能把“定时成功”理解为已写入主仓。
- 自研云端 Agent / 预研未存在的 Cloud API（v3.221：有稳定官方 API 再加 Adapter）

### 11.7 主要风险

- **PDF 预览已落地（v3.14）**：WKWebView spike 跳过，直接 pdf.js + `read_pdf_bytes` 白名单；docx（RX4a）复用同一白名单通道，后续新增二进制预览类型沿用同一模式。
- **官方账号 env 净化需按 matrix 逐家核实**：各 CLI 账号登录与 API env 的优先级关系不同，以 `docs/agent-integration-matrix.md` 源码级结论为准，勿凭印象。
- **quarto/latex 可用性**：经 `agents::resolve_binary` 兜底解析，缺失时明示引导安装，不静默失败。
- **一键开步触碰旧约定**（终端手动启动主流程、工作区创建语义）：以新约定为准——开步是预设参数的组合调用，手动启动栏主流程不变。

### 11.8 新增约定

- 流水线开步 = 预设参数的组合调用（建工作区 + 启 Agent + 注入简报 + 落成 TASK.md），全部复用既有能力；手动启动栏「Agent → profile → 模型 → 目录 → 启动」主流程不变。
- 官方账号的 CLI auth 文件只读检测「已连接」；断开引导用户用 CLI 自己的 logout，Ccode 不删 auth 文件。
- 官方账号拉起不注入 API env，且必须 `env_remove` 同协议残留 API 密钥变量（防静默覆盖账号登录）。**Codex 官方账号还必须** `-c model_provider="openai"`：磁盘 `config.toml` 的默认渠道会盖过 ChatGPT 登录，只盖本进程、不改用户文件。
- **出网代理只给官方账号**：设置 `outbound_proxy` 注入 HTTPS_PROXY 等，范围 = 官方启动 + 组头登录；网关启动不走；连接 extra_env 同名键覆盖。不建本地反代理，官方连不上不回落中转。
- API 连接默认必须有 Ccode 密钥；只有用户明确勾选「本地端点无密钥」时才清理继承环境并允许无 key 启动。连接创建后 Agent 不可直接改，跨 Agent 使用复制；会话成功关联后记录 profile provenance。
- 「接力」是唯一的跨 Agent 交接表述，禁用「无缝继续」。
- 科研语义只进模板/数据/技能包，不进引擎逻辑。
- **多 Agent 工作台（v3.221 / v3.222 / v3.224 / v3.225）**：一等对象是 Project → Task → Run，不是终端标签；并行只来自人声明或模板；Agent 是 Runtime，CLI 是第一种实现。工作台「正在进行」只列交互活（含还开着的阅读标签），无头不进主卡；关标签后按 `runId` 找回。定时隔离产物经评审才进主仓。细则 `docs/conventions/agent-workbench.md`。
- **侧栏桌面磨砂（v3.251）**：只磨标题栏、全局侧栏和四周缝；主画布不透明。macOS 依赖 `macOSPrivateApi`（GitHub Release 分发，不上 Mac App Store）。Windows 用 Mica，跟随 Mesa 主题深浅。Linux 与系统「减少透明度」保持实心。细则 `docs/conventions/design-system.md`。
- **浮层退场动效（v3.258，apple-motion 批）**：弹层关闭不再瞬时卸载——纯 dismiss（Esc/遮罩/点外）先播 150ms 逆向退场再卸载（挂载延续由 `src/exit-animation.ts` 统一负责，reduced-motion 跳过）；commit（选中命令/菜单项）不播退场立即执行；滚动关闭右键菜单即时（位置脱锚）。居中对话框 pop、侧滑抽屉 slide 按形态分口径（`--ccode-motion-spring` 弹簧缓动，linear() 旧引擎回退）；菜单展开锚定触发器一侧（`ccode-anchor-topleft/top`）。细则 `docs/conventions/design-system.md`「动效口径」。
- **macOS 菜单栏命令覆盖 + ⌘, 设置（v3.259，HIG 批）**：app 菜单挂设置…（⌘,）与命令面板（⌘K），窗口/帮助子菜单补齐（HIG：每个命令可从菜单栏到达、设置归 app 菜单）。菜单事件经 Rust `on_menu_event` → `"menu:action"` 事件 → 前端 App.tsx 监听（IS_MAC 门控）；帮助两项直接 opener 开 GitHub。⌘, webview 兜底服务 Windows/Linux（Ctrl+,），输入框内也生效。仅 macOS 有菜单（cfg 门控），Windows 无菜单栏惯例不改。

## 12. 当前待办与批次状态（滚动维护）

> 2026-09-22 自 AGENTS.md「路线图」整节迁入（原文未改）。演进线定稿见 §11；新条目追加在本节。

- **发布前检查项（2026-10-13 立，做一轮发布准备时逐条过）**：①**文献台账迁移**——双台账口径落地时应用未发布、无外部老用户，
  迁移命令与界面按「留着没用就删」移除；发布后若存在双台账口径之前创建的老用户项目，按
  `docs/conventions/pipeline.md`「双台账·存量收口」的 git 序列重建迁移功能（注意坑：`rm --cached` 后台账已被忽略，
  不能对台账路径 `git add`）。②同理核查其它「未发布期删掉的机器」有没有随发布重新需要的（当时拍板都记在 §10 对应条目）。


- 通用控制台阶段 P0–W3 ✅（六 agent 适配器、双模式配置、多标签终端、会话可视化、统计页、IDE 形态、任务工作区与评审流）
  ——2026-08 起演进为「AI 科研工作台」。
- **P1 四条并行线 ✅**：P1a 官方账号（profile 双类型、终端内 CLI 登录、只读检测 auth 文件 + 冲突配置黄色警告、拉起不注入
  API env 且 env_remove 残留密钥变量、统计页「订阅」不计费）；P1b 流水线骨架（`.ccode/project.toml` 档案卡 + 项目注册、
  工作区页按项目分组 + 流水线步进器概览（v3.46 起大圆步进器：状态从工作区派生、大圆状态色表达进度、校验提示收进 ⚠ 浮层）、一键开步（bootstrap
  自动提交 + TASK.md exclude）、资源面板与自动发现、非 git 目录引导 init；首启引导完整版与工作区类型驱动默认值留 backlog）；
  P1c 供应商预设补齐（各 agent 补 DeepSeek/智谱等端点；加供应商 = `src/presets.ts` 加一行）；P1d 适配器注册表
  （`agent_specs.rs` 中央声明式注册表，一个 CLI 一张规格；解析器与 usage 提取器保持每 CLI 一个文件，注册表只做分发入口）
- **P2 文献 ✅**：PDF 预览 + 选段问 AI（P2a）、整理为笔记（P2b）、文献技能包（lit-search/lit-notes/review-framework/
  review-writing，notes/*.md + references.bib 规范）
- **P3 数据 + 接力 ✅**：数据处理模板 + 技能包（data-clean/data-eda）、提货单 artifacts.yaml v1（手动登记 + md5/大小，下一步
  TASK.md 自动带提货单段）、图片评审（ImagePairView 双栏看图）、长任务 OS 通知（notify.ts）、接力包 + 接力链可回溯
  （handoff.rs，对话页「⇄ 接自」badge）
- **P4 论文 ✅**：科研论文/毕业论文 manuscript 模板 + quarto render 脚本（render-draft/render-final，RX4a 追加 export-docx）、
  quarto-render 技能、提货单登记的 PDF 产物纳入预览白名单（根外产物按精确路径放行）；bib 联动以模板简报引用 references.bib 落地
- **RX 体验批 ✅**：RX1 流水线编辑器 + 步骤资源绑定；RX2a md 阅读版式/沉浸、RX2b 步骤胶囊对照（◫ 切根 + 产物面板）；RX3a
  对话步骤化（步骤名 badge/分组/搜索）、RX3b 技能新建/编辑/◈ 优化 + 步骤挂载技能；RX4a docx 预览 + export-docx；笔记对话式
  批改（选段「◈ 讨论/改写此段」）；界面白话双层 + 工作区页/列表精简
- **P5 通用层打磨（部分 ✅）**：逐 hunk 验收 ✅、跨标签聚合视图 ✅、成本按工作区归因 ✅、历史时间线视图 ✅（first-parent
  主线 + 白话翻译：✓ 保存进项目/⚙ 自动保存/◔ 保存）、**hooks 精确注意力标记 ✅**（设置页按 agent 显式开关，
  hooks.rs 七家桥接；v3.32 Claude 首发，v3.99 推广到七家，见架构 v3.32/v3.99）、**内置技能种子 ✅**（当前 18 个内置技能，include_str! 播种、不覆盖不复活，
  六套流水线模板按步骤挂载）、**定时雷达 ✅**（v3.75：scheduler.rs 每日/每周无头巡检 + lit-watch 多源精选升级，
  约定见 conventions/pipeline.md「定时雷达」）、**模板重设计与接壤 ✅**（v3.78：六套模板内容重设计（种子对准拍板点/技能挂载核对/
  学术 MCP 人工事项）+ 产物路径接壤（投稿与返修接综述/科研论文成稿）+ 编辑器「＋ 从模板追加」）；批量验收、云端会话双源调研留 backlog
- **Backlog（记录不动手）**：SSH 远程执行、团队协作 2.0、PDF 批注系统（永远不做）、深度阅读器（✅ 已落地为
  沉浸阅读区，v3.96）、批量验收、云端会话双源调研、首启引导完整版（示例课题最小版已落地：工作区空态「✦ 创建示例课题（演示）」→
  `create_demo_project`，演示 PDF/引文/综述流水线齐备；完整版引导的更丰富演示数据留 backlog）、工作区类型驱动默认值（数据类跳端口）
  - **对标云端电脑型 Agent（2026-10-17 讨论，未拍板）**：差距在「人不在场也能跑 / 随处拍板 / 浏览器操作 / 开箱环境」；
    优势（本地数据、跨厂商中立、验收层、本机工具链）不丢。方向＝云作 Runtime，不自建 VM、不自研 Agent 循环、不做通用
    Manus 竞品。顺序：①SSH 远程执行 Runtime（即上条，数据不出单位）②官方云端 Runtime（Claude Code 云端会话 / Codex
    cloud，有稳定接口才加 Adapter，产物照走评审冻结，与 §11.6 一致）③浏览器 MCP 主攻全文 PDF 下载 ④评审请求外推
    微信/飞书/邮件、采纳仍回桌面 ⑤科研环境模板（uv/conda、quarto 一键装）。**后台常驻与④触碰 §11.5「daemon 化、
    手机同步」否决，动手前须用户重新拍板**；先出 §10 决策草案 + 远程 Runtime 规格再实现。2026-10-20 放行的「从手机添加」
    只是手机→桌面单向投递（局域网、Mesa 开着才收），不算④；④与将来的飞书等投递通道合成一个「消息通道」批次再拍板
  - **从手机添加（一期 2026-10-20、二期「记住这台手机」2026-10-21 已实现，待真机点验）**：清单见 `docs/design-phone-drop.md`
    §6 / §9；后续候选（换网络自动跟上、PDF 顺手加入积累、终端层入口、手机上选项目、断点续传）等使用反馈

**当前待办**：

- ~~用量页活跃度热力图二期~~ **已于 2026-10-12 当日提前实装**（用户拍板「第二期做上」）：
  ①点格下钻 `usage_day_detail(day)`——日详情浮层（四分类 + 按 agent 分解条 + 当日会话
  列表，标题过 redact_sensitive_text），会话行走既有 `setOpenSessionReq` + `setPage("sessions")`
  通路直跳结构化会话视图（Mesa 差异化主打）；日期出口走 `sessionScopeReq` 的 `kind:"day"`
  （session-filter.ts 匹配器按会话最近更新时间本机归日 + SCOPE_KIND_LABEL「日期」）。
  ②`usage_activity_agents(year)` day×agent 矩阵 + 按 agent 筛选胶囊（单选、AGENT_BRAND
  色相、分档/统计按该 agent 重算、streak 限所选年并注明口径）；codebuddy/cursor 胶囊
  title 披露「数据可能偏薄」。遗留观感项：浮层与胶囊的 GUI 验收待 `npm run tauri:dev`。
- **架构审计基线（2026-09-09）**：`docs/audits/architecture-audit-2026-09-09.md` 记录了
  「执行/结果/验收/项目状态未分离」十大问题清单。**P0 全部落地**：§4.3 复用目录误删修复、
  §4.2 评审冻结（开工基线 + 收尾冻结 + 采纳三向判定，`docs/conventions/review-freeze.md`）、
  §4.5 接受记录长期化（`.ccode/acceptance-log.jsonl` 账本）、§4.1 写入政策统一为口径 C
  （派生产物写工作区、评审合并带回主仓、冲突点名；文献 PDF/人工导入直写项目根；编程合并补
  protected_paths 检查，见 pipeline.md「合并带回」）。P1 已推进：§4.4 验收入口与进程退出状态解绑
  （冻结证据存在即可审可采纳，失败/停止 Run 有可审成果时目标提升待验收）；§4.7 前半
  「Run 可以没有 Goal」（scratch/reader/办公闲聊不再强制登记 Task，task_id 可空）；
  §4.8 普通目标侧有效上下文快照（`context.json` 冻结实际下发文本，评审可核对）；
  §4.10 普通目标启动链收口进 `src/goal-run.ts`（页面只补自有终端字段）；
  §4.9 前半（`SkillDto.contentDigest` + 档案卡 `skills` 名单 + 规则面板「项目技能」勾选，
  版本随快照记录）；§4.6 首期稳定 ProjectId（档案卡顶层 `id` 跟随文件夹，移动后重新添加即认回，
  路径降为当前位置；tasks/runs/会话等按路径的关联迁移留下一期）。
  内核契约（2026-09-10 拍板并落地）：`review_contract.rs` + 四条回流写同一账本；
  科研流程保留。Result Readiness 为派生枚举不改 Run 状态列；session_meta 本波只双写。
  第二波已落地（2026-09-09）：TaskCard 改名「话题」、目标删除即归档（archived_at，数据全保留）、
  Memory Proposal 最小闭环（.ccode/memory.md 只进人确认内容、进上下文包）、定时巡检采纳契约
  扩展（四类基线 + 技能声明产出）、tasks/runs 双写 project_id + 回填。
  同日优化：目标页「已归档」可恢复 + 验收账本只读展示；`task_list` 默认不含归档行；
  沉淀知识失败与账本同口径 fail-closed（按 run_id 幂等）。
- P0 收尾当前批次：批次 A（文献雷达应用层，v3.95）、批次 B（沉浸阅读区，v3.96）与批次 E（LaTeX 支持，v3.97）
  均已落地；后续只保留文档/回归走查与发布动作，不把历史批次重复列为功能未完成。
  批次顺序为用户拍板：E 先行，批次 C（实验数据分析）/D（表征分析）转待办；场景 4（agent 辅助做图）不做独立产品能力，改由按需挂载的 origin-plot 技能承接、
  已移出独立路线（「只做场景必需、不做扩展性功能」原则，见架构 v3.97）
- **科研工具交付合同（2026-09-11；2026-09-12 收口来源）**：六套模板不另扩编排；库交付、Origin 数值图、Blender 示意和稿件载体由人选择，统一补进现有步骤技能/产物/人工事项。**文献从哪来只在检索步 `lit_source`**，不在创建弹层或 `科研工具/literature` 再问一遍；选 Zotero 才挂 `zotero-sync`。设定屏只填全局设定。稿件载体问在会换正式稿的步骤；Zotero 进库只走检索步待获取「同步到 Zotero」，精读流程线不问文献库交付；EndNote 交差在项目设置（无精读才问投稿适配）；Origin/Blender 问在用得上的那一步且不挡主动作。综述大纲不问 Blender。种子 v5 加 `blender-research` 及随包脚本；已有技能只经差异预览确认升级。模板同名但交付不同不可跳过。Zotero 只读在线内存快照、增量独立候选、来源+资源一起保存；外部 PDF 仅精确登记只读路径可配对阅读。复现合同与面板统一；上游验收引用不自动批准本步。细则见 `docs/conventions/pipeline.md` 末节。
- **科研外部工具三线（2026-09-05 已融入）**：`origin-plot` / `zotero-sync` / `endnote-bridge` 已注册为内置技能并随种子版本 4 播种；仅 `zotero-sync` 默认挂到英文综述、科研论文、毕业论文的文献检索步骤。Origin 仍只作 Windows + Origin 2021+ 的可选外部工具驱动。EndNote：XML/RIS 导入桥 + 定稿 `[@键]` → `output/endnote.docx`（真正的 `ADDIN EN.CITE`，不点插件）；不默认进模板。Zotero 通道需按实机版本/授权探测，失败时回落 RIS/BibTeX 文件流程，不阻塞检索。
  Origin 只做 Windows 实机（Mac 虚拟机方案否决）、EndNote 只走格式桥接（CWYW 无人值守否决）、Zotero 写库只走技能或 UI 显式动作且必须有用户意图（2026-09-16 放宽：to-fetch 清单「同步到 Zotero」按钮即用户意图——zotero.rs zotero_attach_fulltexts 直连本地 API 按 DOI 挂 linked_file 附件，引用 papers/ 绝对路径不复制；Zotero 须运行中并允许本机通信，首次写入授权）；场景 4 以 origin-plot 技能形态重新纳入。
- **定时任务与研究流程结合（核心路径已落地，细目见架构 §11.4 历史记录）**：边界已定——不给每步配定时任务，
  结合点是「产出回流」而非「配置下沉」。产出回流三件套已上线（v3.95：lit_watch.rs 解析巡检产物 + LitWatchCard
  雷达卡片 + 收件箱 lit: 文献胶囊 / Schedule.linkedStep 关联步骤 + RunRecord.newEntries / staleLitHint 复用
  staleUpstream 口径只提醒不阻断）。
  当前规则：默认定时任务进入隔离 worktree，无法创建或校验失败则 fail-closed；启动前登记 Run，启动失败也保留 failed Run 记录；超时与真失败分列。成功产物经只读评审，人点「采纳进主仓」才拷回项目根，不自动合并。当前没有主仓 sentinel 配置入口，不能把定时成功理解为已写入主仓。不同 Agent 的无头权限差异仍以能力表和实机验证为准。关标签后交互 Run 按 `runId` 从工作台「继续」或收件箱找回。
- macOS 签名公证：**workflow 已接好**（2026-10-20），六个 APPLE_* secrets 配齐自动启用；剩开通 Apple Developer 账号与配 secrets（docs/release.md）
- Intel macOS 安装包 ✅（2026-10-20 用户「全部做」推翻暂缓：Apple 芯片 runner 交叉编译 x86_64，latest.json 带 darwin-x86_64，verify-release 校验）
- Windows 代码签名（未做：要证书；SmartScreen 的点法已写进 README 与说明书）
- 应用内更新的国内镜像：**流程已接好**（2026-10-20 拍板：公司对象存储 + CDN，Release 发布时同步）；剩建桶、绑域名、配变量与 secrets（docs/release.md）
- OpenCode Windows 数据路径 ✅：`sessions.rs` 依次探测 `OPENCODE_DB` / `%LOCALAPPDATA%\opencode` / `%APPDATA%\opencode` / `~/.local/share/opencode`（2026-08-31）
- Skills 一键更新 ✅：更新检测（check_skill_updates）+ 检测后一键应用更新（apply_skill_update，v3.53）均已落地
