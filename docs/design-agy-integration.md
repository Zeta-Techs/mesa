# 接入 Antigravity CLI（agy）设计稿

> 状态：已实测核对并实现（macOS 基线）。分支 `feat/agy`。2026-11-14 定稿。
> 实测环境：macOS，agy 1.5.8（`/opt/homebrew/bin/agy`），本地假 Gemini SSE 网关 + 隔离沙箱 HOME 端到端实测；Windows、Linux 待真机补基线。
> 参照：`.reference/magpie`（`internal/agent/agy.go`、`internal/sessions/agy.go`）、`.reference/cc-switch`（`docs/agy-integration-zh.md`、`src-tauri/src/agy_config.rs`）、agy 1.5.8 内置技能文档（`antigravity_guide`、`agy-customizations`）。
> 本稿逐个模块对照现有九家写，每节写「照哪家做」「不同在哪」「改哪些文件」。文件位置以 `src-tauri/src/`、`src/` 为根。

## 0. 结论

- 作为第十家接入，内部 id `agy`，展示名 **Antigravity CLI**，二进制 `agy`。id 与二进制同名，和 magpie 一致，进 `.ccode/`、会话库、用量表后不再改。
- 支持分级：**维护级**（AGENTS.md「CLI 支持分级」）。能启动、能注入连接、能看会话、能分发 MCP/技能/hooks、金丝雀不红；跨厂商复核、核验接入等需要进程级只读保证的场景不放开，走 AgentSpec 能力表写明原因。
- 最近的参照是 **Gemini CLI**：同属 Google，走 Gemini 协议，配置都在 `~/.gemini/` 下。会话格式、OSC 7501 状态旁路与会话级设置文件则参照 **Grok**。
- 主线三条：
  1. **启动注入不碰用户的 `settings.json`，也不改 shell 配置**。API 密钥与第三方中转统一由 Mesa 生成 0600 会话级设置文件，经 `--settings <文件> --model mesa/<模型>` 交给当次会话，配合 `GEMINI_API_KEY` 与 `GOOGLE_GEMINI_BASE_URL` 注入。
  2. **会话只读 `brain/<id>/.system_generated/logs/transcript_full.jsonl`（缺省退回 `transcript.jsonl`）**，按 `step_index` 去重，不解析 `.pb` 和 SQLite 里的 protobuf；工作目录从 `conversation_summaries.db` 只读取（只留 `app_data_dir = 'antigravity-cli'` 且排除子智能体）。
  3. **MCP、技能、hooks 全部写 `~/.gemini/config/`**，不写 `~/.gemini/antigravity-cli/settings.json`（官方文档：放在那里的 hooks 不加载），也不碰 `~/.gemini/skills/`（与 Gemini CLI 共用会串载）。

## 1. 实测与文档事实

| 方面 | 事实 | 来源 |
|---|---|---|
| 版本探测 | `agy --version` → `1.5.8`，实测不向 `HOME` 写任何文件 | 本机沙箱实测 |
| 配置根 | `~/.gemini/antigravity-cli/`：`settings.json`、`brain/<会话id>/`、`conversation_summaries.db`、`cache/last_conversations.json`、`implicit/*.pb` | 本机实测 |
| 全局扩展目录 | `~/.gemini/config/`：`hooks.json`、`mcp_config.json`、`skills/`、`plugins/` | 本机 + 内置文档 |
| 项目目录 | `.agents/skills/`、`.agents/hooks.json`、`.agents/mcp_config.json`；旧 `.agent/skills` 仍认 | 内置文档 |
| 规则文件 | 项目里 `AGENTS.md` 和 `GEMINI.md` 都读 | 本机实测 |
| 全局技能 | 认 `~/.gemini/config/skills`、`~/.gemini/skills`、`~/.gemini/antigravity-cli/skills`（**不认** `~/.agents/skills`）；实测目录软链接正常跟随并加载 | 本机沙箱实测 |
| 认证 | 默认 Google 账号 OAuth（macOS 钥匙串 `service="gemini", account="antigravity"`，`go-keyring` 格式；支持 `agy acp --login`）；`GEMINI_API_KEY` 只在 `"modelProvider": "gemini"` 时生效，`GOOGLE_API_KEY` 与 `.env` 都不认；另有 `AGY_ADC_AUTH=true` | 内置文档 + 沙箱实测 |
| 自定义端点 | `GOOGLE_GEMINI_BASE_URL`；底层用 `google-genai-sdk/1.77.0`，自动拼 `/v1beta/models/<m>:streamGenerateContent?alt=sse`，端点末尾不能带 `/v1` 或 `/v1beta` | 假网关抓包实测 |
| 自定义模型 | 实测仅设 `"modelProvider": "gemini"` 传 `--model gemini-2.5-flash` 仍报 `not recognized as a known model or custom model in settings`；**官方 API 密钥与第三方中转都必须写 `customModelsConfig.customModels.<键>` = `{apiProvider: "API_PROVIDER_GOOGLE_GEMINI", modelName}` 并带 `--model <键>`** | 沙箱实测 |
| 官方模型列表 | `agy models` 输出制表符分隔的 `<cli_id>\t<Display Name>`（含 Gemini 3.8 Flash、Claude Sonnet/Opus 4.6、GPT-OSS 120B 等） | 本机实测 |
| 会话级设置 | `--settings <文件路径>` 叠加在用户 `settings.json` 之上，只管当次进程；其中 `customModelsConfig.customModels` 整键覆盖，合并时须带上用户原有项 | magpie + 沙箱实测 |
| 首条提示词 | **不接受位置参数**（`rc=2`：`Prompts are read only from -p/--print, -i/--prompt-interactive, or stdin`）；交互首条用 `-i <提示词>`，无头用 `-p <提示词>`（总是落盘，无 `--ephemeral`） | 沙箱实测 |
| 模式与只读 | `--mode accept-edits\|auto\|plan`、`--dangerously-skip-permissions`；实测 `--mode plan` 仍暴露 `write_file`/`edit_file`/`run_command` 全部 13 个工具，配合免审时 `write_file` 会真实写盘，无进程级只读保证 | 假网关 + 沙箱实测 |
| 思考档位 | `--effort low\|medium\|high` 实测生效（发 `thinkingConfig: {includeThoughts: true, thinkingLevel: "LOW"\|"MEDIUM"\|"HIGH"}`）；`xhigh`、`max` 在 Gemini 模型上报不支持；`settings.json` 无对应键 | 假网关实测 |
| 恢复与分叉 | `--conversation <id>`、`-c/--continue`；会话内 `/fork`（别名 `/branch`），无 CLI 级分叉参数 | 官方 + 实测 |
| 斜杠命令 | `/model <name>`、`/effort <level>`、`/clear`、`/fork`、`/plan`、`/help` | 内置文档 + 二进制 |
| 程序状态 | 回应 `OSC 7501 ; ?`，上报 `app=antigravity` | 本机实测 |
| hooks | `~/.gemini/config/hooks.json` 顶层为组名对象；`SessionStart`/`PreInvocation`/`PostInvocation`/`Stop` 为扁平 handler 数组，`PreToolUse`/`PostToolUse` 为 `[{"matcher": "*", "hooks": [...]}]`；实测 `matcher: "*"` 匹配全部工具，空 stdout `exit 0` 只记录、不拦截也不自动放行 | 沙箱实测 |
| MCP | `~/.gemini/config/mcp_config.json`（首次启动可能生成 **0 字节空文件**），根键 `mcpServers`；远程写 `serverUrl`（读回兼容 `serverUrl` 与 `url`），只支持 Streamable HTTP，不支持 SSE | `agy mcp add` 实测 |
| 安装与更新 | macOS/Linux `curl -fsSL https://antigravity.google/cli/install.sh \| bash`；Windows `irm https://antigravity.google/cli/install.ps1 \| iex`；自带 `agy update`；本机 `/opt/homebrew/bin/agy` 为独立 Go 二进制（非 brew 包） | 本机实测 |

## 2. 规格表（`agent_specs.rs`）

在 `AGENT_SPECS` 加 `agy` 规格，字段对照 `gemini` 与 `grok`：

| 字段 | 取值 | 说明 |
|---|---|---|
| `id` / `label` / `binary` | `agy` / `Antigravity CLI` / `agy` | |
| 首条提示词 | `PromptStyle::Flag("-i")` | 实测位置参数报 `rc=2`，交互首条提示词用 `-i`（`--prompt-interactive`） |
| `readonly_args` | `["--mode", "plan"]` | 仅供交互聊天「先出方案」；进程级只读（`inspect_readonly_args`、研讨、项目助手只读查看）一律不放开 |
| `permission_args` | `auto` → `["--mode", "auto"]`；`full` → `["--dangerously-skip-permissions"]` | |
| resume | `["--conversation", "{session}"]` | |
| fork | `None` | `/fork` 仅会话内可用，无命令行分叉参数 |
| `ModelSwitch` | `Direct("/model")` | 会话内换模型 |
| `effort_levels` | `["low", "medium", "high"]`，CLI `--effort <档>`，TUI `/effort <档>` | `xhigh`/`max` 在 Gemini 模型上报错，开放通用三档 |
| `config_root` | `~/.gemini/antigravity-cli` | `agent_config_root_with` 必加（否则 `sessions.rs` 断言 panic） |
| PATH 候选目录 | Unix `~/.local/bin`；Windows `%LOCALAPPDATA%\agy\bin` | `binary_candidate_dirs` |
| `mcp_write` | `Full` | 写 `~/.gemini/config/mcp_config.json`，§9 |
| `SkillDist` | 软链接优先（失败退复制） | 实测 `~/.gemini/config/skills/` 软链接可加载，§10 |
| `set_global` | `Supported`（仅官方 Google 账号连接可执行） | API 密钥与第三方中转置灰并写明原因，§4 |
| `route_probe` | `GeminiModels` | 与 `gemini` 同走 `/v1beta/models` 探测 |
| `official_account` | 登录命令 `Some(&["acp", "--login"])`，`auth_file_paths` 空，`detection_note` 说明凭证存系统钥匙串、Mesa 不主动读取以免触发钥匙串弹窗 | `cache/onboarding.json` 只代表首次引导完成，不当登录态 |
| `packaging` | 更新渠道 `SelfUpdate`（`agy update`）；安装命令按平台给官方脚本 | §15 |
| `request_policy` | 仅 `effort` 为 `inject`（`--effort`）；`temperature`、`top_p`、`max_tokens`、`headers` 均为 `unsupported` | `agy` 无采样参数与自定义请求头入口 |
| `headless_write` | 支持 `-p <prompt>` 配合权限参数；`inspect_readonly_args` 保持 `None` | `-p` 总是落盘，一次性无痕调用 `ai_prompt_impl` 不派给 agy |
| `support_tier` | 维护级（不进 `TIER1_AGENTS`） | |

能力清单 `capability_manifest.rs`：登记全局配置、MCP、技能、hooks 四类写入路径，通过 `every_agent_is_accounted_for` 守卫。

前端 `src/types.ts` 的 `AGENTS` 加 `{ id: "agy", label: "Antigravity CLI", binary: "agy" }`。

## 3. 连接与启动注入（`agents.rs::launch_plan`）

### 3.1 为什么不写 `settings.json`、不改 shell 配置

magpie 早期把 `modelProvider: "gemini"` 和自定义模型直接写进 `~/.gemini/antigravity-cli/settings.json`，导致用户之后在终端直接跑 `agy` 也全部走 API 密钥、Google 账号登录和远程能力失效；magpie 随后改为写独立设置文件并往用户 shell rc 里注入 `agy()` 包装函数。Mesa 本身就是「默认启动注入、零污染」，每次拉起都由后端拼命令行，直接用 `--settings <会话文件>` 即可，**绝不修改用户的 shell 配置文件**。

### 3.2 三种连接

| 连接 | 注入方式 |
|---|---|
| 官方 Google 账号 | 不注入 API 环境变量、不传 `--settings`；若选了具体官方模型则传 `--model <模型>`；显式 `env_remove("GEMINI_API_KEY")`、`env_remove("GOOGLE_GEMINI_BASE_URL")` |
| Gemini 官方 API 密钥 | env 注入 `GEMINI_API_KEY=<钥>`，`env_remove("GOOGLE_GEMINI_BASE_URL")`；生成 0600 会话级设置文件写 `modelProvider: "gemini"`、`model: "mesa/<模型>"` 与 `customModelsConfig.customModels`；命令行加 `--settings <文件> --model mesa/<模型>` |
| 第三方中转（Gemini 协议） | 同上，额外注入 `GOOGLE_GEMINI_BASE_URL=<剥去末尾 /v1 或 /v1beta 的端点>` |

注：沙箱实测确认，即便连接的是 Google 官方 Gemini API 端点，只要 `"modelProvider": "gemini"`，直接传 `--model gemini-2.5-flash` 也会报 `model gemini-2.5-flash is not recognized as a known model or custom model in settings`；因此官方 API 密钥与第三方中转统一走 `mesa/<模型>` 自定义模型映射（`{"apiProvider": "API_PROVIDER_GOOGLE_GEMINI", "modelName": "<原模型名>"}`）。

`customModelsConfig.customModels` 在 `--settings` 叠加时整键替换，生成会话级文件前只读解析用户的 `~/.gemini/antigravity-cli/settings.json`（支持 JSONC 注释与尾逗号），把用户原有的非 `mesa/` 项原样并入，再写入当前绑定的 `mesa/<模型>` 项；用户文件不存在时只写 Mesa 项，存在但语法损坏时记录告警并只写当次会话文件（绝不回写用户文件）。

### 3.3 会话级设置文件与端点归一

- 位置：`<Mesa 配置目录>/agy-settings/<会话或运行 id>.json`，创建即 `0600`。文件内不含任何密钥（密钥只经子进程环境变量传递）。
- 生命周期：启动前创建，PTY/子进程退出后清理；应用启动时顺带清扫超过 7 天的残留文件（与 Grok overlay 同机制）。
- 端点归一：`gateway_store::materialize` 对 `agy` 与 `gemini` 一样剥除末尾 `/v1` 或 `/v1beta`（`google-genai-sdk` 会自行拼 `/v1beta/models/...`）。

### 3.4 拦截、提示与官方模型

- `validate_launch_compatibility`：`agy` 只认 Gemini 协议端点（`Slot::Gemini`），绑定到 OpenAI / Anthropic 槽或选了非对话模型（出图/向量等）时启动前拦下。
- 官方账号提示：只读检查用户 `~/.gemini/antigravity-cli/settings.json`，若里面已有 `"modelProvider": "gemini"`，在连接诊断中提示「你的 settings.json 设了 modelProvider=gemini，官方账号启动会被它覆盖；可在官方连接上点『设为全局默认』恢复」，不私自改写。
- Gemini CLI 个人账号提示（`agents.rs`）：原提示「改推 Antigravity」更新为引导用户直接在 Mesa 里选用 Antigravity CLI。
- `official_models_for("agy")`：后台调用 `agy models` 解析 `<cli_id>\t<Display Name>` 并缓存；未装或调用失败时退回内置常用模型表。

## 4. 设为全局默认（`global_config.rs`）

严格遵守 `docs/conventions/profiles.md` §12 九条规则：

- **第三方中转与 Gemini 官方 API 密钥不支持设为全局**：`agy` 只从环境变量读 `GEMINI_API_KEY` 与 `GOOGLE_GEMINI_BASE_URL`，不支持配置文件或 `.env` 落盘，而 Mesa 不改用户 shell 配置。后端拒收并返回明确原因，前端连接页将这两类绑定的「设为全局默认」按钮置灰并悬停说明：「Antigravity CLI 只从环境变量读端点和密钥，Mesa 不改你的 shell 配置；请从 Mesa 启动，或点这行的「外部终端」图标在系统终端打开。」
- **外部终端拉起与会话归属**：连接行「外部终端」图标每次弹目录选择框（默认预填上次工作目录），经一次性启动脚本携带 `--settings` 临时设置文件与环境密钥拉起 `agy`；后端记录启动前快照并在新 `brain/<id>/` 会话落盘后按工作目录匹配回写 `(profile_id, launch_model, effort)`，保证外部终端新建会话的用量计费模型与后续续聊连接归属不丢失；复制裸 `agy --conversation` 命令时对 API / 中转连接给出不含密钥提示。
- **官方 Google 账号支持设为全局**：写前完整备份 `~/.gemini/antigravity-cli/settings.json`（走统一备份与恢复表），用 JSONC 保格式编辑撤除 `modelProvider`（当值为 `"gemini"` 时）、指向 `mesa/` 的 `model`，以及 `customModelsConfig.customModels` 下 `mesa/` 前缀的条目，保留用户的 `trustedWorkspaces`、自定义模型和注释。
- `official_global_is_patch` 与前端 `OFFICIAL_GLOBAL_AGENTS` 双端同步加入 `"agy"`。

## 5. 权限、只读、授权

- `cli_permission.rs`：只读解析 `~/.gemini/antigravity-cli/settings.json` 的 `agentMode` 与 `toolPermission`（`toolPermission == "always-proceed"` → `full`；`agentMode == "auto"` 或 `toolPermission == "proceed-in-sandbox"` → `auto`；其余有显式配置时按默认交互档）。
- `grant.rs`：授权运行 `full` 传 `--dangerously-skip-permissions`；不默认加 `--sandbox`（1.4.4 起沙箱不可用时静默降级，不能当安全边界）。
- **只读隔离边界**：沙箱实测证明 `--mode plan` 在免审设置下仍可执行 `write_file` 落盘，没有进程级工具白名单或沙箱只读保证。因此研讨（`group_consult`）、项目助手只读查文件（`inspect_readonly_args`）等硬只读场景**不纳入 `agy`**，仅在用户主动点交互聊天「先出方案」时传 `--mode plan`。

## 6. 会话解析（`sessions.rs` + `sessions/agy.rs`）

### 6.1 数据源与过滤口径

- 多数据根扫描：除默认 `~/.gemini/antigravity-cli` 外，一并扫描 `$ANTIGRAVITY_APP_DATA_DIR`（设置时）以及外部配置工具（如 `cc-switch` 的 `~/.cc-switch/agy/*/antigravity-cli`）通过 `--gemini_dir` 隔离的数据根；跨根同 `conversation_id` 以已导出完整 `transcript*.jsonl` 的记录优先去重。
- 会话文件两层来源：
  1. 已导出日志：遍历 `<agy_root>/brain/<id>/.system_generated/logs/`，**优先读 `transcript_full.jsonl`**（未截断正文，且 `tool_calls[].args` 为原生 JSON 对象），不存在时退回读 `transcript.jsonl`；
  2. 仅落库会话：纯文字外部终端对话在首次触发工具/附件前 `agy` 不写 `brain/<id>`，只落盘 `conversations/<id>.db` 与 `conversation_summaries.db` 的 `conversations_fts` 表。对此类会话生成 `<agy_root>/conversation_summaries.db#<id>` 虚拟路径，只读按字节偏移切片还原 `conversations_fts`（`user_body` / `agent_body` + `user_step_byte_offsets` / `agent_step_byte_offsets` BLOB）多轮问答消息；一旦运行中导出 `brain/<id>/.../transcript*.jsonl`，旧 `#<id>` 路径无缝实时升级读完整日志。
- 元数据与工作目录：`rusqlite` 以 `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX` 打开 `<agy_root>/conversation_summaries.db`，结合 `conversation_summaries`、`conversations_fts`（`chunk_index = -1` 摘要行与首分片寒暄跳过标题兜底）、`cache/conversation_metadata.json`、`cache/last_conversations.json` 与 `history.jsonl`：
  - **只保留 `app_data_dir = 'antigravity-cli'`** 的行，排除 Antigravity 桌面版/IDE 会话；
  - **排除子智能体与内部会话**（`COALESCE(nesting_depth, 0) > 0`、`COALESCE(parent_conversation_id, '') != ''`，或 `conversation_metadata.json` 标记 `is_internal` / `summary.Internal`），避免后台子任务刷屏顶层对话列表；
  - 工作目录优先级：`conversation_summaries.workspace_uris` → `conversation_metadata.json` 的 `WorkspaceURIs` → `last_conversations.json`（`{"<cwd>": "<conversation_id>"}`）→ `history.jsonl`（`{"workspace": "<cwd>", "conversationId": "<id>"}`，防同目录新会话覆盖 `last_conversations.json`）；仍无则工作目录记空（不猜测，无工作目录时不暴露恢复按钮）。
- 不读：`implicit/*.pb`、`conversations/*.pb`、`conversations/<id>.db` 内部加密/二进制载荷、`logs/chunks/`。

### 6.2 Transcript 行结构与去重

`agy` 在同一步从 `RUNNING` 变为 `DONE` 时会往 JSONL 再追加一行同 `step_index` 的记录。解析器先按 `step_index` 合并去重（保留同 `step_index` 最后一次出现的记录，按首次出现顺序排列）：

| 字段 | 处理规则 |
|---|---|
| `type == "USER_INPUT"` | 提取 `<USER_REQUEST>…</USER_REQUEST>` 内正文（剥离 `<ADDITIONAL_METADATA>`、`<USER_SETTINGS_CHANGE>` 等系统注入块），并将 `media[].uri` 本地文件 URI 还原成首行本地路径供聊天层展示图片缩略图；若整段仅有 `<USER_SETTINGS_CHANGE>` 则作为设置变更事件提取模型名，不渲染成空白用户气泡 |
| `type == "PLANNER_RESPONSE"` | `thinking` 进思考折叠块，`content` 进助手正文，`tool_calls[]`（兼容 `args` 为对象或 JSON 字符串）进工具调用块；`status != "DONE"` 判为回复进行中 |
| `type == "GENERIC"` | 循环剥去开头可能重复两遍的 `Created At:` / `Completed At:` 时间头，挂接在最近一次未配对工具调用下作为工具输出；无前置工具调用的系统提示折叠处理 |
| 文本脱敏 | 标题、预览、消息正文、思考内容、工具参数与结果在出 Rust 层前一律经 `redact_sensitive_text` 脱敏 |

### 6.3 接入点与删除口径

- `sessions.rs` 接入 `mod agy`、多数据根扫描、增量快照、尾部状态检测、`parse_session_lines` 分发、`SessionRoots` 根路径及多根删除白名单；全文搜索（`session_search.rs`）与固定快照（`pin_session`）同步支持 `#<id>` 仅落库会话。
- 删除会话：校验所属 `<agy_root>/brain` 在白名单内后，一并将 `brain/<id>/` 与 `conversations/<id>.db`（含 `-wal` / `-shm`）移入系统回收站（测试态走直删隔离缝），避免仅落库会话删后重现；严格遵守只读原则**不写 `conversation_summaries.db`**，删除说明提示 `agy` 原生列表可能保留空摘要项。

## 7. 用量统计（`usage.rs`）

- 假网关精确对账结论（上游返回 `promptTokenCount=100, cachedContentTokenCount=20, candidatesTokenCount=5, thoughtsTokenCount=7`）：
  - `input_tokens = 80`（**已是扣除缓存后的新增输入 token，严禁再减 `cache_read_tokens`**）；
  - `cache_read_tokens = 20`；
  - `output_tokens = 12`（已含思考 token）。
- `agy_events`：先按 `step_index` 去重，只计 `type == "PLANNER_RESPONSE"` 且 `status == "DONE"` 且含 token 统计的步骤。
- 模型名解析：跟踪对话内 `<USER_SETTINGS_CHANGE>` 的 `Model Selection` 变更（将 `Gemini 3.8 Flash (High)` 等官方展示名归一为 `gemini-3.8-flash-high`），若为自定义模型（`Model Selection` 为空）则查 Mesa 会话模型记录；都没有则记 `"unknown"`，费用不估价（显示「—」）。
- 升级 `USAGE_SCHEMA_VERSION` 并将 `"agy"` 加入增量部分重建列表（只重抽带 `seen:` 标记的会话，绝不清空 `usage_daily`）。

## 8. 恢复、分叉、迁移、接力

- 恢复：`agy --conversation <id>`（在原工作目录下拉起；若原会话来自 `~/.cc-switch/agy/<provider>/antigravity-cli` 等外部 `--gemini_dir` 数据根，自动前置 `--gemini_dir=<目录>` 定位原会话库）。
- 分叉、会话迁移（`session_transfer.rs`）、客户端深链接力（`client_open.rs`）：均不做，能力表如实说明原因（无 CLI 分叉参数、不写第三方 SQLite、无公开对话深链）。
- 聊天内换一家接力（`relay_brief.rs`、`handoff.rs`）：支持作为交出方（从 transcript 生成交接简报）与接手方（带简报开新对话）。

## 9. MCP（`mcp.rs`）

- 路径：`~/.gemini/config/mcp_config.json`，根键 `mcpServers`；兼容首次启动产生的 **0 字节空文件**。
- 写入：stdio 写 `{command, args, env, cwd, disabled}`；Streamable HTTP 写 `{serverUrl, headers, disabled}`（不写 Gemini CLI 专用的 `httpUrl`）；SSE 类型跳过并提示「Antigravity CLI 只支持 stdio 与 Streamable HTTP（不支持 SSE）」。
- 读回：同时识别 `serverUrl` 与 `url`；写前备份，只管理 Mesa 分发的条目。

## 10. 技能与规则文件（`skills.rs`）

- 全局技能：`~/.gemini/config/skills/`（不碰 Gemini CLI 共享的 `~/.gemini/skills/`）；Unix 优先软链接、Windows 失败退复制。
- 项目技能：复用 `.agents/skills/`（与 Codex 等共用）。
- 项目规则：Mesa 已写项目根 `AGENTS.md`，`agy` 原生读取，不重复生成 `GEMINI.md`。

## 11. Hooks 与注意力（`hooks.rs`）

- 全局文件：`~/.gemini/config/hooks.json`，归入「用户显式开启的全局精确注意力开关」（与 Gemini、Kimi、Grok 同类，写前备份、关闭时收回 `"mesa-attention"` 键）。
- 结构：顶层保留用户与其他插件的所有键，只读写 `"mesa-attention"`：
  - `SessionStart`、`PreInvocation`、`Stop`：`[{"type": "command", "command": "<追加事件到 Mesa JSONL>"}]`；
  - `PreToolUse`、`PostToolUse`：`[{"matcher": "*", "hooks": [{"type": "command", "command": "<同上>"}]}]`。
- 命令不向 stdout 输出 JSON（0 字节退出码 0），实测既不拦截工具调用，也不会把需要审批的操作自动放行。
- 前端 `src/chat-handoff.ts` 的 `HOOKS_AGENTS` 同步加入 `"agy"`。

## 12. 聊天层与前端能力表

- 结构化旁路（`chat_channel.rs`）：Unix 上接入 `program_status.rs`（OSC 7501，`app=antigravity`，`PROGRAM_STATUS_MIN` 设为 `(1, 5, 8)`）；Windows 与 Grok/Kimi 一致不接 OSC 7501。
- 前端必改表：`src/types.ts`、`src/chat-fidelity.ts`（含测试）、`src/terminal-tab-persistence.ts`（含测试）、`src/slash-commands.ts`、`src/session-title.ts`、`src/model-switch.ts`（含测试）、`src/reasoning-effort.ts`。
- 依赖真机 TUI 抓屏的表（`live-reply.ts`、`mid-turn-send.ts`、`terminal-wait.ts`、`tui-menu.ts`）：按规范不编造假屏幕样张，先走会话文件 + OSC 7501 状态，后续抓真屏再补读屏兜底。

## 13. 网关、连接片段与路由探测

- `gateway_store.rs`、`src/gateway-slot.ts`、`src/profile-copy.ts`、`src/gateway-autoconfig.ts`、`src/presets.ts`：`agy` 归入 `Gemini` 协议槽（厂商 Google），复用 Gemini 预设与路由探测（`route_check.rs`）。
- `profile_validation.rs`：识别 `ApiKind::Gemini`，本地配置摘要只读展示 `~/.gemini/antigravity-cli/settings.json` 的 `modelProvider` 与 `model`。
- `connection_snippet.rs` & `src/connection-snippet.ts`：生成含会话级 `agy-settings.json` 示例、`GEMINI_API_KEY` / `GOOGLE_GEMINI_BASE_URL` 环境变量与 `agy --settings ... --model mesa/...` 的可复制片段。

## 14. 界面、图标与开源署名

- 图标：采用 `lobe-icons`（MIT）中的 Antigravity 官方彩色图标存为 `src/assets/agent-icons/agy.svg`（`AgentIcon.tsx` 自动重写内部渐变 ID 防多实例冲突），同步登记 `src/agent-colors.ts`、`src/vendor-icon.ts`，更新 `docs/licenses/THIRD-PARTY.md`（9 → 10 个 Agent 标识）并运行 `npm run gen:notices` 校验。

## 15. 安装与更新

- 安装（`src/agent-install.ts`）：macOS/Linux 展示 `curl -fsSL https://antigravity.google/cli/install.sh | bash`，Windows 展示 `irm https://antigravity.google/cli/install.ps1 | iex`，经用户确认后在终端执行。
- 更新（`src-tauri/src/updater.rs`）：走 `SelfUpdate`（`agy update`），非 winget 名单加入 `"agy"`。

## 16. CLI 金丝雀与假网关

- `scripts/e2e-model-routing/gateway.py`：`shell_args` 识别 `agy` 的 `run_command` 参数（`CommandLine` / `WaitMsBeforeAsync` / `toolSummary`），使假网关工具往返探测覆盖 `agy`。
- `scripts/cli-canary/canary.py`、`upstream.json`、`.github/workflows/cli-canary.yml`、`src-tauri/src/cli_verified.rs`：接入 `agy`，在本机实跑 `canary.py --accept --agents agy` 生成 `scripts/cli-canary/baseline/darwin/agy.json`；`win32/agy.json` 在编译期允许暂缺，待 Windows CI / 真机生成后补入。

## 17. 文档同步清单

与实现同批更新：`AGENTS.md`、`docs/agent-integration-matrix.md`（新增第 10 节并顺延横向章节引用）、`docs/architecture.md` §10、`docs/conventions/profiles.md`、`docs/conventions/safety.md`、`docs/conventions/open-source.md`、`docs/code-structure.md`、`docs/licenses/THIRD-PARTY.md`、`docs/guide/user-guide.md`（含 §14.1 术语表并跑 `cargo test project_assistant`）、`README.md`、`README.en.md`、`CHANGELOG.md`。

## 18. 测试清单

- 更新全部逐家穷举测试（`agent_specs`、`capability_manifest`、`hooks`、`handoff`、`connection_snippet`、`route_check`、`updater`、`chat-fidelity`、`terminal-tab-persistence`、`model-switch`）。
- 新增单测与集成干跑：
  - `sessions/agy.rs`：脱敏真实结构样张（`USER_REQUEST` 剥离、`step_index` 去重、原生与字符串双态 `tool_calls.args`、`GENERIC` 工具结果配对、进行中状态）、SQLite `app_data_dir` 与子智能体过滤、`last_conversations.json` 回退；
  - `usage.rs`：`input_tokens` 不二次扣减缓存、`DONE` 去重计量、`Model Selection` 与 `unknown` 不猜价；
  - `agents.rs` & `global_config.rs`：0600 会话设置合并 JSONC 用户自定义模型、端点 `/v1beta` 剥离、官方设为全局保注释撤 `mesa/` 键且中转/API 密钥拒收；
  - `mcp.rs`、`skills.rs`、`hooks.rs`：0 字节 `mcp_config.json`、`serverUrl` 读写与 SSE 拦截、软链接技能、`hooks.json` 仅改 `"mesa-attention"`；
  - 沙箱 `HOME` + 假 Gemini 网关端到端干跑验证。

## 19. 实测核对记录与跨平台剩余项

| 原待验证项 | 实测结论 |
|---|---|
| 首条提示词能否用位置参数 | **不能**（`rc=2`）；交互必须用 `-i <prompt>`，无头用 `-p <prompt>` |
| `--mode plan` 写文件是否硬拦截 | **不硬拦截**：仍暴露 `write_file` 等工具，配合免审会真实写盘；硬只读场景排除 `agy` |
| `-p` 有无不落盘参数 | **无**；每次 `-p` 均写 `brain/<id>/` 与 `conversation_summaries.db`，`ai_prompt_impl` 不派给 `agy` |
| 官方 Gemini API Key 是否不用写 `customModels` | **必须写**：不写时报 `not recognized as a known model or custom model in settings` |
| `--effort` 支持档位 | `low`、`medium`、`high` 生效（`xhigh`、`max` 在 Gemini 模型报错） |
| `agy update`、`agy models`、`agy acp` | 均存在；`agy models` 可直接提供官方模型表，`agy acp --login` 可触发登录 |
| `/opt/homebrew/bin/agy` 来源 | 独立 235MB Go 二进制，不在 Homebrew Cellar/Caskroom 中 |
| `~/.gemini/config/skills/` 软链接 | **支持**，模型请求内可见完整技能列表 |
| `hooks.json` 的 `matcher: "*"` 与空输出 | **匹配全部工具**，0 字节 stdout `exit 0` 不拦截且不自动放行未授权工具 |
| `agy --version` 是否写文件 | **不写任何文件** |
| 官方账号凭证位置 | macOS 钥匙串 `service="gemini", account="antigravity"`（Mesa 不主动读钥匙串） |
| Windows / Linux 路径、安装与 `win32/agy.json` 基线 | 待 Windows 实机/CI 运行 `--accept` 补齐 `win32` 指纹与 TUI 抓屏样张 |

## 20. 不做

- 不写用户 shell profile 里的 `agy` 包装函数。
- 不写 `conversation_summaries.db`，不解析 `.pb` protobuf。
- 不做会话迁移、客户端深链接力、CLI 级原生分叉。
- 不用 `--gemini_dir` 换整个配置根（避免 Mesa 内外对话历史割裂）。
- 不用未公开文档的企业网关变量 `AGY_LLM_GATEWAY_*`。
- 不混入 Antigravity 桌面版对话（严格按 `app_data_dir = 'antigravity-cli'` 过滤）。
