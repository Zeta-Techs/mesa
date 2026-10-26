# 九个 CLI Agent 适配参考（调研蒸馏版）

> 供实现 AgentAdapter 时查阅。来源：2026-07-30 对官方文档与源码的调研（多数核到源码行号）。
> 2026-08-05 补充核实各供应商 Anthropic/OpenAI 兼容端点（见 §1 附注），来源均为官方文档页面。
> 2026-08-06 新增 §7 CodeBuddy Code（v2.132.0 实机验证，含真实会话样本与 product.json 核实）。
> 2026-08 新增 §9 Grok Build（xai-org/grok-build 源码调研；标注「待实机验证」处未经实机核对）。
> 2026-08-20 新增 §12 精确注意力 hooks 桥接调研（九家，实现 = hooks.rs 的 BRIDGE_SPECS；cursor/opencode 未接入结论同记）。
> 2026-10-21 起 Claude Code / Codex 有每日金丝雀（`scripts/cli-canary/`）：Mesa 已核对到的版本与指纹见 `scripts/cli-canary/baseline/<平台>/<agent>.json` 的 `version`，比本表各处「x.y 实测」更新。
> 标记「易漂移」的均为各 CLI 内部格式，解析必须防御式（跳过未知类型、容忍缺字段、容忍末行截断）。

## 1. Claude Code

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `claude`；`claude --version`；`claude auth status`（JSON，exit 0=已登录，适合预检） |
| 注入 env | `ANTHROPIC_BASE_URL`（中转端点；**CLI 自己拼 `/v1/messages`，base 不得带版本段**——2026-10-19 探针实测带 `/v1` 会请求 `/v1/v1/messages?beta=true`，Mesa 物化 Profile 时剥掉槽位末尾版本段）、`ANTHROPIC_AUTH_TOKEN`（Bearer，网关场景首选）、`ANTHROPIC_API_KEY`（X-Api-Key；交互模式首次使用会弹一次性确认）、`ANTHROPIC_MODEL` |
| 全局配置 | `~/.claude/settings.json`：`{"env": {...}, "model": "..."}`。**注意：settings 的 env 块会覆盖 shell env**；也可用 `--settings <file-or-json>` 注入不落地 |
| 会话存储 | `~/.claude/projects/<sanitize(cwd)>/<session-uuid>.jsonl`；目录名 = 路径中所有非字母数字字符替换为 `-` |
| 会话格式 | JSONL。envelope：`uuid/parentUuid/timestamp/sessionId/cwd/gitBranch/version/isSidechain/type`；`type=user/assistant`，assistant 的 `message` 是原始 API 响应（content blocks + usage）；另有 `ai-title`（会话标题）、`summary`、`file-history-snapshot` 等类型，未知 type 必须跳过。**多行粘贴包装**（2026-10-19 实测，2.1.29x）：Mesa 聊天层发多行提问等于一次终端粘贴，Claude 把它记成 `"\n\n<pasted_content id=\"79fb\">\n…\n</pasted_content id=\"79fb\">"`（user 行 content 为字符串，收尾标签也带 id）；单行提问不包。回放与标题只要里面的话（`sessions.rs unwrap_pasted_content`，仅用户消息）。**易漂移** |
| 关键启动参数 | `--model`、`-p`（非交互）、`-c/-r`（续会话）、`--session-id`（固定会话 ID=文件名）、`--settings` |
| 接续文件（2026-10-21 本机实证，entrypoint `claude-desktop-3p`） | 桌面版在旧对话上「继续」会新建 `<新id>.jsonl`：开头逐行复制上游全部历史（行里 `sessionId` 仍是上游 id），之后的新行才用新 id；链式接续时复制的是整条链（行里依次出现各上游 id）。**会话 id 只能取文件名**，开头第一个 `sessionId` 不是本文件的。上游文件之后可能被补写不带 `timestamp` 的 `custom-title` / `agent-name` 行，mtime 不能判断上游是否还在聊，要看最后一个带时间戳的行。复制来的 assistant 行带着原 `usage`，记账只算本文件 id 的行 |
| 坑 | 非官方 base URL 会禁用 Remote Control 与部分 MCP 行为；CLI 自己会给配置文件做时间戳备份（我们不是唯一写者）；`CLAUDE_CONFIG_DIR` 可整体搬迁配置目录（完全隔离方案，但会话也随之隔离）；`/model` 选择器默认只显示内置别名，Ccode 用 `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL`(+`_NAME`) 注册前 4 个模型、第 5 个走 `ANTHROPIC_CUSTOM_MODEL_OPTION`，更多模型需 `/model <id>` 手输；`_NAME` 是选择器显示名（Ccode 填「配置名 · 模型」）。运行中切换（2026-08-17 v2.1.212 strings 实证，终端状态栏用）：`/model <name>` 带参直切（session 级）、`/effort <low\|medium\|high\|xhigh\|max>` 带参直切。**子 agent 模型**（2.1.226 二进制实证）：Ccode 不写 `CLAUDE_CODE_SUBAGENT_MODEL`，保留 Task/frontmatter/继承链；`--settings` 用于把本次连接的 base_url / 密钥 / 模型选择一并提升到配置层，屏蔽全局 env 的覆盖。**凭据必须与 base_url 同层配对**（2026-09-27 修）：只提 base_url 不提 token 时，磁盘 `settings.json` 的 `env` 块里残留的旧 `ANTHROPIC_AUTH_TOKEN` 会胜出，形成「新版端点 + 旧版令牌」组合，网关报 401；令牌写 0600 临时文件后以路径传入，不进 argv。**长上下文声明**（2026-09-01 起启动注入与设为全局同键同条件）：claude 对不认识的第三方模型按 200K 上下文假设，`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 在注册链确知 >200K 时注入，防长会话提前 compact。**`-p`/SDK 查询打良性模型警告**（2026-10-03，2.1.285 实证）：对任何非官方模型 id（网关模型如 `glm-5.3`）在发请求前往 stderr 打一行 `[claude-code:unrecognized_model] {"model":"…","query_source":"sdk"}`（warn 级遥测 `tengu_api_unrecognized_model`，打完请求照发、任务正常完成——假端点 + 真实网关双重验证；交互 TUI 不打；`ANTHROPIC_DEFAULT_*` 别名注册绕不过，别名解析成自定义 id 后照打）。Ccode 在 ai.rs `strip_known_cli_noise` 捕获层整行过滤，防它混进任务摘要冒充错误正文 |

**Anthropic 兼容端点（2026-08-05 核实，来源均为官方文档）**：

- **智谱 GLM**：`ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic` + `ANTHROPIC_AUTH_TOKEN`（国内站；国际站为 `https://api.z.ai/api/anthropic`，两站账号不通用）。官方推荐模型映射 `glm-4.7`（haiku）/ `glm-5.2[1m]`（sonnet/opus）。来源：docs.bigmodel.cn/cn/guide/develop/claude、docs.z.ai/devpack/tool/claude；实测 `POST /api/anthropic/v1/messages` 无 key 返回 401，端点存活。
- **DeepSeek**：`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` + `ANTHROPIC_AUTH_TOKEN`。官方推荐 `deepseek-v4-pro[1m]`（opus/sonnet）+ `deepseek-v4-flash`（haiku/轻量任务）；传入 claude 模型名会自动映射。来源：api-docs.deepseek.com/guides/anthropic_api、/quick_start/agent_integrations/claude_code。
- 两家兼容端点注入方式与官方一致（同一组 env），适配器无需特殊分支；注意「坑」行所述非官方 base URL 的副作用同样适用。

## 2. Codex CLI

> **0.163 默认工具（2026-10-21 假网关实测，官方 gpt-5.5 与第三方模型同）**：不再发 `update_plan`（改发 goals：create_goal / update_goal / get_goal），
> `tools.update_plan.enabled=true` 打开（`tools.update_plan` 是表，写 `=true` 报 invalid type）；`request_user_input` 照发，但只有 Plan 模式能用，
> Default 模式调用返回「request_user_input is unavailable in Default mode」（`features.default_mode_request_user_input` 开发中、默认关，Mesa 不开）。

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `codex`；`codex --version`；`codex login status`；`codex doctor` |
| 注入 env | `CODEX_API_KEY`（优先级高于 auth.json）、`OPENAI_API_KEY`。**没有 base URL / 默认模型的环境变量** |
| base URL 注入方式 | 启动参数 `-c model_providers.<id>.base_url='"https://..."'`（需同时在 config 里定义 provider）或写 `~/.codex/config.toml`：`openai_base_url` 或 `[model_providers.<id>]`（`base_url` + `env_key` = 存放 key 的环境变量名） |
| 全局配置 | `~/.codex/config.toml`（TOML）+ `~/.codex/auth.json`；`CODEX_HOME` 可整体搬迁（目录必须预先存在） |
| 会话存储 | `~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl`；旧文件会被后台 **zstd 压缩为 `.jsonl.zst`**（magic `28 b5 2f fd`），两者都要能读；归档目录 `archived_sessions/` 是**扁平结构**（rollout 直接在根下、无日期分层，0.151 实测，扫描须兼容两种形态）；另有 `history.jsonl`（仅用户 prompt）和 SQLite 镜像库（版本化文件名，勿依赖）。Ccode 观察到会话关联成功后，会在自己的 `app.db` 记录 profile 归属，历史/外部会话可能为空。 |
| 会话格式 | JSONL `RolloutLine {timestamp, type, payload}`；首行 `session_meta`（含 **cwd** = 项目归属依据）；`response_item`（消息）、`event_msg`（含 token_count）、`turn_context`（每轮 model/cwd）。不按项目分目录，**项目归属靠 session_meta.cwd**。**易漂移**。`session_meta.model_provider` 记的是 **config 里的 provider 名，不记认证身份**：`requires_openai_auth=true` 时官方账号（ChatGPT 登录）对话同样落本地 rollout 且记该 provider 名（2026-08-31 实测）；同一 provider 名下换过 Key 的历史会话事后无法区分 |
| 关键启动参数 | `-m`、`--profile`、`-c key=value`（最高优先级）、`codex exec`（非交互，`--json` 输出事件流）、`codex resume` |
| 官方账号 | `codex login --device-auth`（设备码，0.152.1 核实；内嵌 PTY 比浏览器 OAuth 可靠）/ `codex login`（浏览器 OAuth）/ `codex logout`；凭证 `~/.codex/auth.json` 或 OS 钥匙串。内置 ChatGPT 渠道名是保留字 `openai`（读 ChatGPT 登录态）。磁盘 `config.toml` 的 `model_provider` 指向自定义网关会盖过 ChatGPT 登录（2026-09-02 本机：启动栏选官方账号仍走网关计费）。Ccode 官方启动注入 `-c model_provider="openai"`（`-c` 最高优先级，本进程、不改用户文件、不写 `[model_providers.*]`）。auth.json 顶层仅 `OPENAI_API_KEY` = API Key 模式，不算官方登录 |
| 桌面客户端 | 内嵌于 ChatGPT.app（`Contents/Frameworks/Codex Framework/…/Helpers/Codex`，无独立 Codex.app；2026-08-31 实测 151.0.7922）。会话进统一注册表 `~/.codex/state_5.sqlite` 的 `threads` 表：cli/exec/vscode/桌面端来源混存、**不按登录身份分区**（host 仅 `local`）——切换登录方式不碰会话存储，双向实测对话不丢；`thread_history_1.sqlite` 为内容缓存。rollout→DB 有迁移机制，失败文件记 `rollout_migration_skipped_rollouts`（带 skip_reason）——**文件在盘但客户端不显示**，Ccode 直扫文件免疫。「换登录方式丢对话」的真凶多为云端线程（网页版/云任务不落本地），非本地过滤。登出即删 `auth.json`，客户端 UI 登录态可能滞后于磁盘（注销「没反应」多为已生效未刷新，重启客户端即正常）。深链 **`codex://threads/<session_id>`** 精确打开指定对话（macOS 实测跳转成功；Windows 待验证）——Mesa 对话页「在 Codex 客户端打开」用之（2026-10-18 起统一走 `client_open.rs` 预检，见 §13）；**客户端打开会话时校验 `model_provider` 须在 config.toml 有定义**——Ccode 内联 provider（`ccode`/`ccode-<短id>`）会话跳转会报「Model provider `ccode` not found」无法继续（2026-08-31 实测），Ccode 按 `codex_client_config_providers`（读 config.toml 的 model_providers 名单）对这类会话置灰跳转入口；缺渠道定义时由 `client_open_launch` 的「写入并打开」补写定义块（2026-10-19 起连接页不再有「注册 / 移除注册」入口，撤销走「撤销上次写入」）。**补写定义块 / 设为全局认证口径（v3.250）**：定义块写 `experimental_bearer_token`（ChatGPT 自带 Codex 的 ModelProviderInfo 认这个字段），`requires_openai_auth = false`，**不写 auth.json**，也不写 `http_headers`（MCP 字段，写在 provider 上客户端加载失败报 Model provider not found）。密钥明文落 config.toml。旧 `http_headers` / `requires_openai_auth`+auth.json 再补写或再设为全局一次即迁移。 |
| 坑 | **只支持 Responses API**（`wire_api="chat"` 已移除并报错）——中转必须实现 `/v1/responses`；`codex exec` 默认要求 git 仓库（`--skip-git-repo-check`）；凭证可能存 OS keyring 而非 auth.json；auth.json 顶层只有 `OPENAI_API_KEY` = API Key 模式（官方 `--api-key` 与第三方中转同一形状，**不算官方账号登录**，检测见 v3.55）；TUI `/model` 选择器的模型目录来自 `model_catalog_json` 指定的 JSON 文件（**仅启动时读取**，Ccode 已为每条绑定生成 catalog：display_name = 「配置名 · 模型」，context_window/max_context_window 取自 model_registry；reasoning levels 全量模板 [low/medium/high]，与 cc-switch 同口径——模型不支持时端点忽略 effort）；**`/model` 无内联参数**（main 源码 `supports_inline_args` 名单不含 Model，0.154 核实，2026-09-15）——会话内换模型只能走选择器，Mesa 状态栏 picker 档点芯片即唤选择器、不摆模型假菜单；内置 `codex_apps` MCP（ChatGPT apps 连接器，0.153.0 起随启动拉起，只认 ChatGPT OAuth）——本机 auth.json 留有失效登录态时启动必刷 `401 token_revoked`；**关内置 apps：0.154 起网关不注 `features.apps=false`**（会把用户 HTTP MCP 收成 `mcp__<名>` 占位），改 `-c plugins.codex-app-tools@openai-bundled.enabled=false`；`mcp_servers.codex_apps.enabled=false` 报 `invalid transport` 不可用（内置 server 不接受 transport 反序列化）。官方账号保留 apps |
| 兼容端点（2026-09-15 核实） | 智谱 GLM 的 Codex 专用 Responses 端点为 **`https://open.bigmodel.cn/api/v1`**（官方 docs.bigmodel.cn/cn/coding-plan/tool/codex，配套 `wire_api="responses"`）；`https://open.bigmodel.cn/api/paas/v4` 仅 `chat/completions`，Codex 打 `/responses` 实测 404（zai-org/GLM-5#39 同结论）。**模型目录只有 `paas/v4/models` 有**（api/v1 的 `/models` 对列表请求回 HTTP 200 包错误体，不出目录）——正确填法 = Base URL/OpenAI 槽 `paas/v4` + Responses 槽 `api/v1` 分槽填。预设表按 api/v1 收录；网关库 responses 槽/主输入命中 bigmodel paas/v4 时前端告警（`responsesSlotUrlWarning`）。智谱习惯把业务错误包成 HTTP 200（`{"code":…,"msg":…,"success":false}` / `{"error":{…}}`），fetch_models 已按错误体识别（`gateway_error_envelope`）不误报「0 个模型」。无 key 空探针只到鉴权层（三条路径同返 1001），分不出路由死活，别用未认证探针下结论 |

## 3. Gemini CLI

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `gemini`（npm `@google/gemini-cli`，Node ≥ 20）；`gemini --version`。**0.64 实测（2026-10-20）**：`~/.gemini/projects.json` 不存在时，每次启动都异步「写 `projects.json.<uuid>.tmp` + 改名」登记项目，`--version` 先退出、改名来不及做，tmp 文件留在 `~/.gemini` 越积越多（每次两个；已有 projects.json 时不写，交互跑过一次后自然消失）。Mesa 的无头探测（版本、启动预检）因此带 `GEMINI_CLI_HOME=<系统临时目录>/ccode-gemini-probe` 并预放 projects.json（`agents::quiet_cli_probe`），不碰用户目录 |
| 注入 env | `GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL`（设了即进入 GATEWAY 模式，官方支持中转；要求 HTTPS 或 localhost；**CLI 对 base 无条件自拼 `/v1beta/models/<模型>:…`——2026-10-19 探针实测带 `/v1` 的 base 会请求 `/v1/v1beta/…` 被中转 404、CLI 报「Model … not found or is invalid」，Mesa 物化 Profile 与拉目录时剥掉槽位末尾版本段**）、`GEMINI_MODEL`。env 优先级仅次于 CLI 参数 |
| 全局配置 | `~/.gemini/settings.json`（`model.name`、`security.auth.selectedType`）；`GEMINI_CLI_HOME` 可整体搬迁 |
| 会话存储 | `~/.gemini/tmp/<slug>/chats/session-<时间>-<id8>.jsonl`；**slug 映射读 `~/.gemini/projects.json` 和目录内 `.project_root` 标记，不要自己推导**（旧版是 sha256 目录，有迁移）；**0.64 实测**：目录没登记进 projects.json 时 Gemini 会扫 `tmp/*/.project_root` 自行认领并回写登记；已登记的只认登记的 slug，落到别的目录看不见（会话包导入因此先查 projects.json） |
| 会话格式 | JSONL。首行 metadata；消息 `{id, timestamp, content, type: user/info/error/warning/gemini}`，gemini 类型带 `toolCalls` 和 `tokens{input,output,cached,thoughts,tool,total}`；**控制记录 `$rewindTo`（截断后续消息）和 `$set`（patch 元数据）必须处理**，不能简单拼接。旧版单 JSON 文件仍需兼容。若多个落盘文件声明同一 `sessionId`，按最新文件作为唯一会话代表。**易漂移** |
| 关键启动参数 | `-m`、`-p`（进入 headless）、`--output-format stream-json`、`-r/--resume`、`--list-sessions` |
| 坑 | **默认 30 天自动删除会话**（`general.sessionRetention`）；新目录首次运行有信任确认（`--skip-trust` 绕过）；管道 stdio 会静默进入 headless；会话文件边写边追加，末行可能残缺；**多模型切换无配置注入机制**（已核实），只能在 TUI 里 `/model set <id>` 手动切换。**0.46 实机核实补充**：`/model` 的「Select Model」选择器列表**硬编码**（main 视图 Auto/Manual 两项 + Manual 子视图官方模型），`GEMINI_MODEL` env 的值不进列表（优先级 `--model` > `GEMINI_MODEL` > settings `model.name`）；`/model set <id>` 零校验任意 id 当场生效。自定义模型进选择器的官方机制：`experimental.dynamicModelConfiguration: true` + `modelConfigs.modelDefinitions`（与内置表 merge，`tier:"custom"` + `isVisible:true` 进 Manual 子视图；实验开关，requiresRestart）——**Ccode「设为全局默认」已写入该登记**（2026-09-01：开关 + 逐模型 definition，displayName = 配置名·模型，thinking/multimodalToolUse 按注册表确知才写；只写不删旧条目）。**闪烁**：inline 模式 UI 高度超终端行数即整区重绘（内置 useFlickerDetector 检测；上游已知问题簇，官方 Epic google-gemini/gemini-cli#10673，与终端种类无关，维护者背书 alternate buffer 可根治），缓解 = settings `ui.useAlternateBuffer: true`（默认 false；开了之后 `ui.incrementalRendering`（默认 true）才生效），可叠加 `ui.showSpinner: false` / `ui.loadingPhrases: "off"` |

## 4. Qwen Code

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `qwen`（npm `@qwen-code/qwen-code`，Node ≥ 22；或 brew）；`qwen --version` |
| 注入 env（按协议） | openai 协议：`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`；anthropic 协议：`ANTHROPIC_*` 三件套；配合 `--auth-type openai|anthropic`。credential 优先级：CLI flags > shell env > .env > settings env。策略 env（0.22.0 bundle 全量扫 `QWEN_CODE_*` 实证）：仅 `QWEN_CODE_MAX_OUTPUT_TOKENS` 与 `QWEN_CODE_API_TIMEOUT_MS` 两条，无 temperature/top_p |
| 全局配置 | `~/.qwen/settings.json`：`modelProviders.<协议>.models[{id, baseUrl, envKey, generationConfig}]` + `security.auth.selectedType` + `model.name`；`QWEN_HOME` 整体搬迁 |
| 会话存储 | `~/.qwen/projects/<sanitize(cwd)>/chats/<uuid>.jsonl`（sanitize 规则同 Claude）；归档在 `chats/archive/`；目录名可能碰撞，**项目归属以首条记录的 `cwd` 为准** |
| 会话格式 | JSONL `ChatRecord {uuid, parentUuid, sessionId, timestamp, type: user/assistant/tool_result/system, subtype, cwd, version, message（genai Content 格式）, usageMetadata, model}`；`custom_title` 系统记录给标题。旧版（约 <0.10，具体版本未核实）是单 JSON 文件。**易漂移** |
| 关键启动参数 | `-m`、`--auth-type`、`--openai-api-key/--openai-base-url`（仅有的凭证 flags）、`--session-id`、`--continue/--resume` |
| 坑 | Qwen OAuth 免费额度已于 2026-04 停；绑定需记录协议类型（多协议 agent）；录制可被关闭（`general.chatRecording:false`），此时无会话文件；TUI `/model` 对话框列出的就是 `modelProviders.<协议>.models` 条目（仅全局写入模式可注入多模型，注入模式单模型是 CLI 限制） |

**兼容端点（2026-08-05 核实）**：openai 协议可接智谱 GLM（`https://open.bigmodel.cn/api/paas/v4`，官方 quick-start 仍在用）；anthropic 协议（`--auth-type anthropic` + `ANTHROPIC_*` 三件套）理论上可接 §1 附注的 GLM/DeepSeek Anthropic 兼容端点，但未实测，接入前需验证。

## 5. OpenCode

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `opencode`（npm `opencode-ai`；仓库已更名 anomalyco/opencode）；`opencode --version` |
| 注入方式 | **无通用 key/baseURL env**。用 `OPENCODE_CONFIG_CONTENT`（内联配置 JSON，优先级几乎最高）+ `OPENCODE_AUTH_CONTENT`（内联凭证 JSON，未文档化但源码确认）做启动注入。provider 配置：`provider.<id>.options.{apiKey, baseURL}` + `npm: "@ai-sdk/openai-compatible"` 接任意中转；provider 级 `name` 与 models 条目 `name`/`reasoning`/`limit.context` 是 models.dev 覆盖语义（官方文档 2026-08-17 核实），Ccode 填显示名（配置名 · 模型）+ 思考模型 `reasoning: true` + 上下文 limit（model_registry） |
| 全局配置 | `~/.config/opencode/opencode.json(c)`（支持 `{env:VAR}` 插值）。**优先级坑：config > auth.json > env**，注入必须走 config 层才确定 |
| 会话存储 | **v1.2.0+：单一 SQLite**。Unix：`~/.local/share/opencode/opencode.db`；Windows：优先 `%LOCALAPPDATA%\opencode\opencode.db`，回落 `%APPDATA%\opencode` 与 unix 形态路径（`OPENCODE_DB` 环境变量仍优先）。WAL 模式（**新会话 / 新消息先只进 `opencode.db-wal`，主库要等自动检查点（约 1000 页）才动——变更判定必须连 `-wal` 一起看，只看主库会几分钟扫不到新会话**，2026-10-21 实测）；表：`session/message/part/project`，`message.data`/`part.data` 为 JSON 列。更早版本是 `storage/` 目录的扁平 JSON 文件（需双解析） |
| 会话格式 | `session` 表直接有 `title/cost/tokens_*/time_*`；项目 = git 首个 commit hash，`project.worktree` 列给路径；message.data：`{role, time, model, tokens, cost, ...}`；part.data：`type: text/reasoning/tool/...` 判别联合。**drizzle 迁移频繁，易漂移** |
| 官方替代路径（推荐优先用） | `opencode export <id>`（完整 JSON）、`opencode session list --format json`、`opencode db "<sql>" --format json`、`opencode serve`（HTTP+OpenAPI）——比解析内部 DB 稳定 |
| 关键启动参数 | `-m/--model`、`--prompt`（交互会话首条指令）、`-s/--session`（按 ID 继续） |
| 坑 | 自更新会在启动时替换二进制（`OPENCODE_DISABLE_AUTOUPDATE=1`）；provider SDK 运行时下载（首跑要联网）；Windows 数据路径已按 `%LOCALAPPDATA%\opencode` 优先探测（2026-08-31）；`/models`（别名 `/mo`）的 run 不吃参数、只弹切换对话框（1.18.21 二进制实证，2026-09-15）——会话内换模型只能走选择器 |

## 6. Kimi Code（注意：两个产品都叫 `kimi`）

| 项 | 新版 kimi-code（TS，0.x，现役） | 旧版 kimi-cli（Python，1.x，收缩中） |
|---|---|---|
| 检测 | `~/.kimi-code/` 存在；`kimi doctor` 可用 | `~/.kimi/` 存在；`kimi --version` 为 1.x |
| 注入 env | **故意忽略 shell env 的 API key**。唯一注入通道：合成模型 `KIMI_MODEL_NAME` + `KIMI_MODEL_API_KEY` + `KIMI_MODEL_BASE_URL` + `KIMI_MODEL_PROVIDER_TYPE`（kimi/anthropic/openai）。合成通道另有元数据字段（2026-08-17 二进制 strings 实证）：`KIMI_MODEL_CAPABILITIES`（逗号分隔小写）、`KIMI_MODEL_DISPLAY_NAME`（选择器 label 优先它）、`KIMI_MODEL_MAX_CONTEXT_SIZE`、`KIMI_MODEL_THINKING_EFFORT`/`ADAPTIVE_THINKING`/`REASONING_KEY` 等；Ccode 注入 display_name=配置名·模型、max_context_size 与 capabilities 判定统一走 model_registry（内置表 + model-capabilities.json 覆盖 + 关键词推断兜底） | `KIMI_API_KEY`/`KIMI_BASE_URL`/`KIMI_MODEL_NAME`（最高优先级）；或 `--config-file` / `--config '<json>'` |
| 全局配置 | `~/.kimi-code/config.toml`：`[providers.x]`（type/base_url/api_key/custom_headers）+ `[models.x]` + `default_model`；也可脚本化 `kimi provider add/remove`；`KIMI_CODE_HOME` 整体搬迁 | `~/.kimi/config.toml`，同构字段；`KIMI_SHARE_DIR` 整体搬迁 |
| 会话存储 | `~/.kimi-code/session_index.jsonl`（枚举入口：sessionId/sessionDir/**workDir**）+ `sessions/<wd_*>/<id>/agents/main/wire.jsonl`；**目录名规则（2026-10-21 kimi.exe 源码 + 本机实证）**：`wd_<末段slug>_<sha256(路径，反斜杠先换成斜杠、去尾斜杠)[:12]>`，slug=小写、非 `[a-z0-9._-]` 连续段并成 `-`、去首尾 `-`、截 40，空记 `workspace`；wire.jsonl 的 `runtime.set_binding.workspaceId` 必须等于所在目录名，否则恢复报「runtime binding workspace … does not match」 | `~/.kimi/sessions/<md5(workDir)>/<uuid>/context.jsonl`（无时间戳；时间戳在 `wire.jsonl`，标题在 `state.json`）；项目映射读 `~/.kimi/kimi.json` 的 `work_dirs[]` |
| 会话格式 | wire.jsonl：版本化 record（`metadata` / `turn.prompt`（用户输入）/ `context.append_message`（assistant/tool）/ `usage.record`（token）），协议 v1.0→v1.4 有迁移 | context.jsonl：`{role, content, tool_calls, tool_call_id}`；`_` 开头的 role 是内部记录（跳过）；content 可能是字符串或 parts 数组；tool_calls.arguments 是 JSON 字符串 |
| 坑 | 密钥在 config.toml 里是明文；旧版 1.47+ 会催用户升级新版；模型选择器按 `[models.*]` 别名列出（注入模式的 KIMI_MODEL_* 合成通道是单模型设计，多模型需走全局写入）。运行中切换（0.36.1 pty 探针实证）：`/model <别名>` 与 `/effort <档>` 带参直切（/model 吃的是别名不是模型 id；档位随模型，K3 等布尔模型只有 on/off）；**kitty 键盘协议坑**：TUI 启动 push flags（`\x1b[>7u`）后只认 CSI-u 的 Enter（`\x1b[13u`），普通 `\r` 不提交——xterm.js 不支持该协议，Ccode 在 xterm 键盘层与写入链路两处改写（注册表 `submit_csi_u`） | 正在被新版替代，安装新版会迁移其数据（不改旧数据） |

**兼容端点（2026-08-05 核实）**：`KIMI_MODEL_PROVIDER_TYPE=openai` 可接任意 OpenAI 兼容端点（如智谱 `https://open.bigmodel.cn/api/paas/v4`、DeepSeek `https://api.deepseek.com/v1`）；`=anthropic` 理论上可接 §1 附注的 Anthropic 兼容端点，未实测。

## 7. CodeBuddy Code（本机 2.137.1 实测）

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `codebuddy`（别名 `cbc`，npm 包 `@tencent-ai/codebuddy-code`）；`codebuddy --version` |
| 注入 env | **`CODEBUDDY_API_KEY` / `CODEBUDDY_BASE_URL` / `CODEBUDDY_MODEL`**（`ANTHROPIC_*` 无效）；**协议是 OpenAI Chat Completions**（2026-10-21 2.171 源码 `resolveModelBaseURL` + 实测更正，原记「Anthropic 兼容」是错的）：`CODEBUDDY_BASE_URL` 原样当 base、CLI 自拼 `/chat/completions`，不加 `/v1`；官方端点 = product endpoint + `/v2`。给 Anthropic 地址（如 `…/api/anthropic`）时网关回 200 + 非流式错误体，CLI 只画「└ Model returned no valid response」——Mesa 按 OpenAI 槽取地址（`slot_for_agent`），连接验证同走 chat/completions 形状 |
| 官方端点 | 国际站 `https://www.codebuddy.ai`（product.json `endpoint`，默认）/ 中国站 `https://copilot.tencent.com`（`officialEndpoints` 同源核实） |
| 全局配置 | `~/.codebuddy/settings.json`（env 块，同 Claude 形态） |
| 会话存储 | `~/.codebuddy/projects/<slug>/<uuid>.jsonl`，slug = CLI 源码 `compressWorkspacePathName`（2026-10-21 2.170.0 实测）：`/ \ :`→`-`、去首尾 `-`、连续 `-` 并成一个（Windows 的 `C:\Users` 是 `C-Users`，**不是 Claude 的 `C--Users`**），超 255 字节改成「截 180 字节 + `-` + djb2 base36」；有损不解码，项目归属读行内 `cwd`，兜底目录名 |
| 会话格式 | 工具（2.172.1 金丝雀实测）：`{"type":"function_call","callId","name","arguments":"<JSON 串>"}` / `{"type":"function_call_result","callId","status","output":{"type":"text","text"}}`，ptc 模式 name 是 `REPL`、参数里是一段调用别的工具的 JS；`{"type":"message","role":"user","content":[{"type":"input_text","text":...}],"sessionId":...,"cwd":...,"timestamp":<毫秒 epoch>}`；assistant 块为 `output_text`；`file-history-snapshot` 等事件行跳过。**与 Claude schema 不同构，独立解析器**；usage/工具调用字段未实证（防御式跳过） |
| 关键启动参数 | 交互初始 prompt = 位置参数（`codebuddy "<prompt>"`）；`-p` 无头；`-r|--resume [sessionId]` 按 ID 恢复（`-c` 续最近）；`--session-id <uuid>` 固定会话文件名 |
| 官方账号 | TUI 内 `/login`（浏览器 OAuth，分国际/中国站）；凭证 `~/.codebuddy/.credentials.json`。**env 优先压账号**（实测 401 提示），官方账号拉起必须 `env_remove CODEBUDDY_API_KEY`（连同 `CODEBUDDY_AUTH_TOKEN`） |
| 技能 | `~/.codebuddy/skills/<name>/SKILL.md`（frontmatter 与库格式兼容） |
| 安装 / 更新 | npm `@tencent-ai/codebuddy-code`；自更新 `codebuddy update`（非交互，可走行输入渠道） |

## 8. Cursor CLI（2026.08.04-aaa8809 实机验证）

| 项 | 值 |
|---|---|
| 二进制 / 检测 | **`cursor-agent`**（不要用 `agent`——太通用；cursor-agent 是 legacy symlink 但稳定）；安装到 `~/.local/share/cursor-agent/versions/<ver>/`，symlink 在 `~/.local/bin`（resolve_binary 通用候选已覆盖）；`cursor-agent --version` |
| 注入 | API key = `--api-key <key>` flag 或 env **`CURSOR_API_KEY`**；端点 = `-e/--endpoint` 或 env **`CURSOR_API_ENDPOINT`**（**Cursor 专有协议，非 OpenAI/Anthropic 兼容——第三方供应商预设无意义**）；模型 = **`--model <name>` flag（非 env）**，支持 `claude-opus-4-8[context=1m,effort=high]` bracket 参数化 |
| 关键启动参数 | 交互初始 prompt = argv 末尾位置参数；非交互 `-p/--print` + `--output-format text|json|stream-json`；`--resume <uuid>` 按 ID 恢复（必须带 id，无参会卡 Ink TUI）；`--continue` 续最近 |
| 会话存储 | `~/.cursor/projects/<编码cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`（目录名=文件名=session id；cwd 编码：**2026-10-21 静态读 cursor-agent 源码**（`workspace-paths`）= 非字母数字→`-`、连续 `-` 并成一个、去首尾 `-`，Windows 的 `C:\Users` 是 `C-Users`，空格/下划线/点/中文也变 `-`，有损不解码）。**续聊不读这份 jsonl**：`--resume <id>` 只读 `~/.cursor/chats/<md5(cwd)>/<id>/store.db`（SQLite），`agent-transcripts` 是从它导出的副本——所以会话包导入的 Cursor 对话「Mesa 可看、Cursor 不一定能接着聊」（静态结论，未真机验证）。**`agent ls` 是 Ink TUI 非 TTY 会崩，会话发现只能文件扫描** |
| 会话格式 | JSONL 带 type 字段，源码枚举：`user_message`/`tool_call`/`tool_result`/`turn_ended`/`turn_id`/`message_id` 等（**完整字段样本未验证——防御式解析，未知 type 跳过**） |
| 官方账号 | `cursor-agent login`（浏览器 OAuth）；凭证**默认 macOS 钥匙串**，设 `AGENT_CLI_CREDENTIAL_STORE=file` 时落 `~/.cursor/auth.json`（检测需双通道：auth.json + 钥匙串只读查询）；官方账号拉起 `env_remove CURSOR_API_KEY` |
| 技能 | `~/.cursor/skills-cursor/`（**未验证 CLI 是否真读，分发走 copy 模式**）；`~/.cursor` 与 IDE 共享——**会话删除白名单必须限定 `projects/*/agent-transcripts/**/*.jsonl`** |
| 安装 / 更新 | 官方安装脚本（`curl -fsSL https://cursor.com/install | bash`）；自更新 `cursor-agent update`（非交互）；无 brew/npm 官方包。**Windows（2026-10-20 核实）**：官方有原生安装器 `irm 'https://cursor.com/install?win32=true' \| iex`，装到 `%LOCALAPPDATA%\cursor-agent`（写进用户 PATH），`cursor-agent.cmd` → PowerShell `cursor-agent.ps1` → 挑 `versions\<YYYY.M.D-提交>` 最新目录跑自带 `node.exe index.js`（Mesa 直启后两者，`process::cursor_entry_from_launcher`）；安装器提示运行需要 Git for Windows。本机 2026.10.19-6bbf2c4 版本探测已核；**登录、会话目录（预计仍是 `~/.cursor/projects/...`）需要 Cursor 账号，未核** |

## 9. Grok Build（本机 1.0.13 实测，2026-09-05）

| 项 | 值 |
|---|---|
| 二进制 / 检测 | **`grok`**（xAI 官方终端编码 agent，二进制也叫 grok）；`grok --version`；本机为 `grok 1.0.13`；`grok version --json` 给 `{"currentVersion":"X.Y.Z (commit)","channel":"stable"}`。官方安装落 `~/.grok/bin/grok`（另尝试 `~/.local/bin`、`/usr/local/bin` symlink；resolve_binary 已把 `~/.grok/bin` 收进三平台候选目录） |
| 注入 env | **`XAI_API_KEY`**（别名 `GROK_CODE_XAI_API_KEY`）、模型 **`GROK_DEFAULT_MODEL`**、base url 覆盖 **`GROK_MODELS_BASE_URL`**（1.0.5 实机核实，自带 user-guide 11-custom-models.md：模型目录从 `{base_url}/models` 拉取、推理同走该 base，`XAI_API_KEY` 作 Bearer；另可用 `GROK_MODELS_LIST_URL` 单独覆盖列表地址）。**`GROK_DEFAULT_MODEL` 只是「偏好」**：与可用模型目录比对，不在目录里走 `preferred model not in available models, falling back` 静默回退默认——第三方模型必须配 `GROK_MODELS_BASE_URL` 让目录来自网关自身。勿用 `GROK_CLI_CHAT_PROXY_BASE_URL`（xAI 内部 CLI chat API 代理覆盖口，非推理端点，第三方端点注进去模型流量不走它）。**模型列表收敛（1.0.5 实机核实）**：`GROK_CONFIG` env 是 JSON overlay 深合并进 config.toml（白名单含 `models` 表），注入 `{"models":{"allowed_models":[...]}}` 可把选择器/`-m` 可选范围收敛到绑定模型列表（不注则网关全量目录进选择器；空列表勿注——fail-closed 全不匹配），选中模型兜底并入。**`default` 与 `allowed_models` 的一致性（1.0.34 实机复现，2026-09-20）**：开会话前 grok 先拿「有效默认模型」比对 `allowed_models`，不匹配直接拒启动——原话 `"<id>" (your default) isn't allowed by allowed_models. Broaden the patterns or remove allowed_models, then try again.`（`remote_config/resolution.rs`）；有效默认取自 config.toml 的 `[models].default`（可能是别家绑定「设为全局默认」留下的模型），`GROK_DEFAULT_MODEL` 只是「偏好」、在这道门之后才生效（调试日志 `default model resolved … source=env`），救不回被拒的启动——所以 Ccode overlay 在本次有启动模型时同时写 `[models].default`（既是本次会话默认，也让比对通过；已实测 overlay 白名单放行 `default`）。**白名单边界（2026-08-31 main 源码实证，`OVERLAY_ALLOW_PATHS` fail-closed）**：只放行 `[models]` 全局块/`[features]`/少量 toolset 叶子，逐模型 `[model.<id>]` 明确除外——`api_backend`/`context_window` overlay 注不进，由中转 `/models` 目录条目字段 `apiBackend`（responses/chat_completions/messages）/`contextWindow`（缺省 256_000）或 config.toml 提供；Ccode 另经 overlay 注入请求策略的 `[models]` 全局默认（五项，见第 8 条）。凭证优先级：config.toml `api_key` > `env_key` > 登录 session token > `XAI_API_KEY` |
| 官方端点 | xAI 官方 API 是 OpenAI chat_completions 兼容：`https://api.x.ai/v1`；config.toml `[model.<name>]` 的 `api_backend` 支持 chat_completions/responses/messages 三种 |
| 全局配置 | `$GROK_HOME`（缺省 `~/.grok`，三平台同）下 `config.toml`（主配置 TOML：`[model.<name>]` 段 + `[mcp_servers.<name>]` 段）；项目级 `<cwd>/.grok/config.toml` 只贡献 `[mcp_servers]` 等少数段。**「设为全局默认」2026-09-01 起支持**（`global_config.rs patch_grok_config`）：写顶层 `api_key` + `[endpoints].models_base_url` + `[models].default`（首个绑定模型）与请求策略 `[models]` 全局默认（temperature/top_p/max_completion_tokens/default_reasoning_effort/extra_headers=`$VAR` 引用，`load_toml_file` 读盘时展开，密文不落盘）；`[models]` 通用键**只设不删**（防误清用户手写值）。每个绑定模型都写 `[model.<id>]` 段（name=配置名·模型；段键 = 目录模型 id，含 `/` 的 id 自动加引号）。绑定设了「API 后端」或权威层确知上下文窗口时同段再写 api_backend / context_window——这是 api_backend 在 Ccode 侧的唯一通道（overlay 白名单不放行 [model.*]），中转目录声明仍优先推荐。同段补推理强度菜单（2026-09-22，Grok 1.0.40）：`supports_reasoning_effort = true` + `reasoning_efforts`（`value`/`label`/`description`，四档 xhigh/high/medium/low，与内置 grok-4.6 同形；旧 `{ effort = "..." }` 整段被忽略）。中转 `/v1/models` 不带 `reasoning_efforts` 时不写这段则 `/effort` 不出；只写 `[models].default_reasoning_effort` 也不出菜单。已有 `reasoning_efforts` 不覆盖。中转目录把模型标成 `supports_reasoning_effort = false` 时改回 true，否则菜单写了也不出。思考档只收单词闭集，斜杠串与拼写错误不写入 `default_reasoning_effort`。首版不支持的旧决策作废——`[models].default` 字段与 `[endpoints]` 段已从官方 user-guide 实证 |
| 官方账号 | `grok login`（浏览器 OAuth，auth.x.ai）/ `grok login --device-auth` / `grok logout`；凭证落 `~/.grok/auth.json`（0600，顶层 map：scope → GrokAuth{key, auth_mode, refresh_token, expires_at}，grok 自己原子重写——我们只读）。官方账号拉起必须 `env_remove XAI_API_KEY`/`GROK_CODE_XAI_API_KEY` |
| 会话存储 | `~/.grok/sessions/<encoded-cwd>/<session-id-uuidv7>/` 目录式会话（目录 0700）：`summary.json`（info{id,cwd}、generated_title、created_at/updated_at、num_messages、current_model_id）+ **`updates.jsonl`（权威对话日志，append-only）** + `chat_history.jsonl` 等；`<encoded-cwd>` 是 cwd 的 URL 编码（超长则 slug+hash 且目录内有 `.cwd` 元数据文件）。**`~/.grok/sessions/session_search.sqlite` 只是 FTS 索引不是会话本体**，扫描须排除。项目归属以 `summary.json` 的 `info.cwd` 为准（比解码目录名可靠） |
| 会话格式 | `updates.jsonl` 每行 `{"timestamp": <unix秒>, "method": "session/update", "params": <ACP SessionNotification>}`；消费方式 = `params.update.sessionUpdate`：`user_message_chunk`/`agent_message_chunk`（content 为 ACP ContentBlock，text 在 `content.text`）/`tool_call`/`tool_call_update`/`plan` 等，另有 `_x.ai/` 前缀扩展通知；未识别类型跳过（防御式）。token usage 在 turn 结束通知上（2026-09-22 本机实锤：`method` 为 `_x.ai/session/update`，`sessionUpdate=turn_completed`，对象在 **`params.update.usage`**，camelCase：`inputTokens`/`outputTokens`/`cachedReadTokens`/`cacheCreationTokens`/`reasoningTokens` + `modelUsage{<model>:{同名字段}}`）。`inputTokens` 已含缓存读（`cachedReadTokens ≤ inputTokens`，`totalTokens = input + output`），入库时拆成未命中输入；`reasoningTokens` 不是 total 之外的第三项，不另加。多模型按 `modelUsage` 各记各的。流式行上的 `params._meta.totalTokens` 只是累计计数，不是用量记录。早期猜测的 `params._meta.usage` / `params.update._meta.usage`（snake_case `input_tokens`）磁盘上未出现，解析器仍认，避免旧夹具失效 |
| 关键启动参数 | `-p/--print`（headless，**不读 stdin**，prompt 必须走参数）+ `--output-format plain\|json\|streaming-json`；`-m/--model`、`--cwd`、`-r/--resume [ID_OR_TITLE]`、`-c/--continue`、`-s/--session-id <UUID>`（仅新建会话，固定会话关联）、`--max-turns`、`--yolo`、`--tools/--disallowed-tools`、`--permission-mode <default\|acceptEdits\|auto\|dontAsk\|bypassPermissions\|plan>`、`--sandbox <off\|workspace\|read-only\|strict>` |
| 只读模式 | headless 已验证语义最硬的组合：**`--permission-mode dontAsk`（CI 严格白名单，非白名单工具请求直接 Cancelled）+ `--sandbox read-only`（OS 级只读，只能写 ~/.grok 和临时目录）**。`--permission-mode plan` 的值被接受但主会话门控链路**未确认**，不要用 |
| 技能 | `~/.grok/skills/<name>/SKILL.md`（目录+SKILL.md，与 Ccode SSOT 同构；另兼容读 `~/.claude/skills`、`~/.cursor/skills`）。首版未经实机验证，分发**强制 copy**（同 cursor 口径） |
| MCP | `~/.grok/config.toml` 的 **`[mcp_servers.<name>]` 段（TOML，不是 JSON）**——stdio = `command`+`args[]`+`env{}`+`cwd`；远程 = `url`+`type`("http"/"sse"，省略时 url 以 /sse 结尾即 sse)+`headers{}`+`bearer_token_env_var`（env 读 token 注入 Authorization: Bearer，密钥不落盘）；通用 `enabled`/`startup_timeout_sec`/`tool_timeout_sec`；headers/env 值支持 `${VAR}` 引用。grok 另兼容读 `~/.claude.json`/`.mcp.json`/`~/.cursor/mcp.json`（可在 config 关）。**Ccode 首版：MCP 页只读清单（解析 TOML 段）+ 分发/写入不支持**（grok 自带 `grok mcp add` CLI；不为首版硬造 TOML 原子写管线） |
| 安装 / 更新 | 官方脚本 `curl -fsSL https://x.ai/cli/install.sh \| bash`（mac/Linux/Git Bash）→ `~/.grok/bin/grok`；Windows `irm https://x.ai/cli/install.ps1 \| iex` → `%USERPROFILE%\.grok\bin\grok.exe`；**npm 官方包 `@xai-official/grok`**（postinstall 解压到 `~/.grok/bin/`）。自更新 `grok update`（非交互；`grok update --check --json` 机器可读）。Windows 支持官方称 best-effort |
| 坑 | `auth.json` grok 自己原子重写（0600），我们只读；`session_search.sqlite` 不是会话本体；headless 不读 stdin；`--permission-mode plan` 门控链路未确认别用；base url 注入必须走 `GROK_MODELS_BASE_URL`（见「注入 env」行），`GROK_CLI_CHAT_PROXY_BASE_URL` 是 xAI 内部代理口勿用；`GROK_DEFAULT_MODEL` 不在目录即静默回退；当前版本支持 `-m/--model`、`--reasoning-effort`，Ccode 启动时优先使用 flag；**未选模型时 Ccode 用绑定模型清单第一个兜底注入 `GROK_DEFAULT_MODEL`+`-m`（2026-09-17 实测）**——grok 按 id 路由，不注会回落 config.toml `[models].default` 的第一方 grok-* 模型，第一方 id 绕过网关直连 `cli-chat-proxy.grok.com`，网络不通的环境表现为「连接超时」而非「模型不存在」，极易误诊成网关不通；`[models].default` 与注入的 `allowed_models` 不一致会**直接拒启动**（1.0.34 实证，见「注入 env」行——Ccode 已改为 overlay 同时写 `default`）；`api_backend`/`context_window` 仍必须来自 `[model.<id>]` 或网关目录，声明非 `chat_completions` 但未登记时 Ccode 会阻止启动

## 跨 agent 共性结论

1. **会话格式全是内部格式**——解析层统一防御式策略，并准备「原始 JSON 视图」作为降级。
2. **项目归属推导各家各样**——在各自 adapter 的 `list_sessions` 里解决，对上层统一暴露 `project_path`。
3. **注入模式没有统一三件套**——Claude/Gemini/Qwen(openai 协议）/旧 Kimi/CodeBuddy 有标准 env；Codex 靠 `-c` 参数；OpenCode 靠 `OPENCODE_CONFIG_CONTENT`；新 Kimi 靠 `KIMI_MODEL_*` 合成通道；Cursor 是 env（key/端点）+ flag（模型）混合；Grok 是 `XAI_API_KEY`+`GROK_*` env 三件套，当前版本另用 `-m`/`--reasoning-effort` 直传模型与思考档。`launch_plan { env, args }` 抽象覆盖了全部九种情况。
4. **前六家都有整体搬迁环境变量**（`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GEMINI_CLI_HOME`/`QWEN_HOME`/`KIMI_CODE_HOME`/`KIMI_SHARE_DIR`；CodeBuddy 未核实；Grok 有 `GROK_HOME`）——可做「完全隔离 profile」的进阶功能，但会连会话历史一起隔离，MVP 不用。
5. **都支持非交互模式**——为「绕过终端直接驱动 agent」留了路。
6. **只读/计划模式参数（2026-08-12 本机 `--help` 实测，「聊想法」想法期只读保护用）**：claude `--permission-mode plan`、
   codex `-s read-only`（替换 Ccode 默认注入的 `-s workspace-write`，重复 -s 生效顺序未文档化故先剔除）、
   gemini `--approval-mode plan`、kimi（新版）`--plan`、cursor `--plan`（= `--mode plan`）、codebuddy `--permission-mode plan`；
   **qwen 0.21.1 无 approval/plan 类参数**（`--safe-mode` 只是禁用自定义配置，非只读）；opencode 1.18.10 有 `--prompt` 但没有已核实的只读/计划参数，因此只读保护仍只有 prompt 软约束。
   grok（源码调研，待实机验证）：`--permission-mode dontAsk --sandbox read-only`（CI 严格白名单 + OS 级只读；
   `--permission-mode plan` 门控链路未确认，不用）。
   注册表落点：`agent_specs.rs` 的 `AgentSpec.readonly_args`，应用逻辑 `agents::readonly_launch_args`。
   **Claude 计划模式的出口（2026-10-26，2.1.308 假网关 TRIGGER_PLAN 实测）**：系统提示给出方案文件路径（`~/.claude/plans/<名>.md`），
   模型先 Write 进去再调 ExitPlanMode（参数只剩已弃用的 allowedPrompts；hook 的 tool_input 由 CLI 补 `plan` 全文与 `planFilePath`，
   会话文件里的这条调用也带）。屏上「Ready to code? / Here is Claude's plan: / ╌ 方案 ╌ / Would you like to proceed?」，选项随本机设置，
   实测「1. Yes, and use auto mode / 2. Yes, manually approve edits / 3. Tell Claude what to change（下一行 shift+tab to approve with this feedback）」；
   第 3 项是能打字的一行：挪过去、打字、回车 = 带意见拒绝（工具结果「the user said: <意见>」，留在计划模式）。开工后会话文件记
   `permission-mode`（如 auto）。没写方案文件就调只问「Exit plan mode?」（1. Yes, and switch to default (ask each time) / 2. No）。
   其余几家计划 / 只读模式写完方案的出口未核实。
   **模型路由端到端核对（2026-10-17，`scripts/e2e-model-routing/`）**：Claude 2.1.292 / CodeBuddy / Codex / Qwen / Kimi / OpenCode / Grok
   的请求都带所选模型（Claude `/v1/messages`、Codex `/v1/responses`、其余 `/v1/chat/completions`，Grok 先 GET `/v1/models`；
   OpenCode、Qwen 的标题 / 记忆小任务也用所选模型）。Claude 的 settings.json env 压过进程 env：用户级 env 里的
   `ANTHROPIC_DEFAULT_HAIKU_MODEL`（会话标题 query_source=generate_session_title 用它）与 `CLAUDE_CODE_SUBAGENT_MODEL`（子 agent，
   `[1m]` 后缀发请求时去掉）会盖过 Mesa 未填的槽——见 profiles.md 模型配置约定。Gemini 0.64：认证只看 settings 的
   `security.auth.selectedType`（`configuredAuthType || getAuthTypeFromEnv()`），设了 `GOOGLE_GEMINI_BASE_URL` 时环境推断为 gateway 而
   CLI 模式不收；`GEMINI_CLI_SYSTEM_SETTINGS_PATH` 文件须归 root（普通用户写的静默跳过）；无头模式在未信任目录要 `GEMINI_CLI_TRUST_WORKSPACE=true`。
   **原生权限档（2026-10-17 本机 `--help` 实测，聊天权限菜单四档用）**：请求批准 / 帮我批准 / 完全访问 =
   claude / codebuddy / grok `--permission-mode default|auto|bypassPermissions`（claude 2.1.292 PTY 实测：default 显示「manual mode on」，
   auto 是它的新默认「auto mode on」，bypassPermissions 首次启动弹「WARNING: Bypass Permissions mode」确认菜单、默认高亮 No）；
   codex `-a on-request` / `--approve-for-me`（帮助文字：经自动评审放行，用 workspace-write 沙箱）/ `-a never -s danger-full-access`
   （ask 保留 Mesa 默认 `-s workspace-write`；auto、full 先剔原 -s——**`--approve-for-me` 与 `-s` 同给时 codex 0.163 拒绝启动**
   「the argument '--sandbox' cannot be used with '--approve-for-me'」，2026-10-18 实录）；qwen `--approval-mode default|auto|yolo`（auto = LLM 分类器）；
   gemini `--approval-mode default|yolo`（无分类器档；本机未装，按官方文档）；kimi 无「请求批准」参数，`--yolo`（Ask When Needed）/
   `--auto`（Never Ask）；cursor `--auto-review`（服务端分类器）/ `--force`；opencode 只有 `--auto`。注册表落点
   `AgentSpec.permission_args`，应用逻辑 `agents::permission_launch_args`。
   **聊天层第三期逐家抓屏（2026-10-18，假 API + PTY，`scripts/e2e-model-routing/chat-capture.py`）**：
   - 审批菜单（发「跑一条命令」的工具调用）：Claude 2.1.292「Do you want to proceed? / ❯ 1. Yes / 2. Yes, and always allow access to
     <折行路径>…」（虚线框夹命令；**按 y 无效**，回车 / 数字 / 方向键有效）；Codex 0.163 沙箱内命令不问，申请出沙箱
     （`sandbox_permissions: require_escalated` + `justification`；只给 justification 不给 sandbox_permissions 会被它退回）才弹
     「Would you like to run the following command? / › 1. Yes, proceed (y)」，`--approve-for-me` 把出沙箱请求交给自动评审
     （guardian，要真模型）；Qwen 0.25「Allow execution of: 'echo'? / › 1. Yes, allow once」，auto 档交给 LLM 分类器（分类器答不出时
     退回问人并建议切 Default）；Gemini 0.64 整个审批画在 ╭│╰ 框里「Allow execution of [Shell]? / ● 1. Allow once」；
     Kimi 2.2「▶ Run this command? / ▶ 1. Approve once」，`--yolo` 普通命令直接放行；CodeBuddy 2.168 ptc 模式只给一个 `REPL` 工具
     （JS 里 `await Bash({ command })`），审批框「Confirm … Are you sure you want to do this? / > 1. Yes」，auto 档交给它的分类器；
     Grok 1.0.62 单选「2 (●) Yes, proceed / 3 (○) No, reject」。七家方向键 + 回车都能选中（Kimi 的 CSI-u 回车也行）。
   - 屏上流式：Claude、Codex、Qwen、Gemini、Grok、Kimi 都是逐行画出（各家行首符号与输入框形态见 `src/live-reply.ts` 文件头）；
     **CodeBuddy 生成中只画「✹ Waking… (streaming · ↓ N tokens)」，写完才一次画出**；OpenCode 分栏整屏重绘，不按行排。
   - 读回：Gemini `/model set x` 回显「ℹ Model set to x」，底栏右下也写模型；Codex 底栏「<模型> <档位> · <目录>」；Qwen 0.25.1
     `/effort low` 后屏上只剩空的「●」，档位写在底栏「➜ 目录 · 模型 档位」；Grok 输入框下边写的是连接里的显示名（不一定是模型 id）。
   - 中途换模型：Kimi 用 Mesa 接口连接（环境变量只带一个模型）时 `/model <别名>` 报「Unknown model alias」——只认它配置文件里的别名；
     CodeBuddy `/model x` 只认它自家的模型清单。
   - **中途切换会写回全局配置**（临时 HOME 里比对切换前后的配置文件）：Claude 2.1.292 `/model x` → settings.json `"model"`，`/effort l` →
     settings.json 里该模型的 `effortLevel`（回显都写「saved as your default for new sessions」）；Codex 0.163 `/model` 选择器 → config.toml
     `model` 与 `model_reasoning_effort`（回显「• Model changed to gpt-6.1-sol low」，选择器列官方模型不列自定义 provider 的 catalog）；
     Grok 1.0.62 `/model x` → config.toml `[models] default`；Qwen 0.25 `/effort l` → settings.json `reasoningEffort`；Kimi 2.2 `/effort off` →
     config.toml thinking `enabled = false`。不写的：Gemini 0.64 `/model set x`（只管这一段）、Grok `/effort`。Mesa 据此改为重开接回（switch-strategy.ts）。
   **Claude 2.1.292 中途 `/model X`、`/effort L` 都先弹确认菜单**（「Switch model? / Change effort level?」，▔ 边框 + ❯ 1. Yes / 2. No），
   确认后回显「Set model to X and saved as your default for new sessions」（写 settings.json 的 model；effort max 是 this session only）。
7. **模型能力元数据统一走 `model_registry.rs`**（2026-08-17 起；2026-08-26 扩为分层数据源）：**逐字段**查询链 =
   用户覆盖文件（model-capabilities.json）> **网关实测缓存**（model-capabilities-relay.json，
   「获取模型」时 fetch_models 顺带解析 OpenRouter 风格 /models 元数据落盘，最准）> **公共能力库**
   （model-capabilities-db.json，配置页 ⋯ 菜单主动下载：models.dev 优先、OpenRouter 回落——
   models.dev 本机直连超时实证）> 内置前缀表 > 关键词推断兜底。能力字段四项：thinking/context/output/vision，
   **全 Option——「这层不知道」继续向下找，显式 false 只在数据源如实给出时生效**（网关只报上下文不挡公共库的推理声明）。
   kimi 的 capabilities/max_context_size、codex catalog、opencode 的 reasoning/limit/modalities 全从这条链出；
   内置表宁缺毋滥（收错比漏报有害）。
   **声明层 vs 估值层（2026-09-26）**：兜底层（`fallback_context_size` 的 128K/256K/1M、关键词推断 thinking、
   硬编码视觉清单）是**已知会错**的一层，只能喂 UI 显示；写进别人家配置的值必须走 `model_*_declared_for`
   （只认链上显式值的三个访问器，未命中 = 不知道）。分流口径按**目标格式的必填性**：
   可省略的未知就不写（codex catalog 的 context_window/max_context_window/input_modalities、codex `-c` 两键、
   kimi `KIMI_MODEL_MAX_CONTEXT_SIZE`）；必填的写保守下限并注明不是声明（kimi config.toml `max_context_size`——
   二进制无值硬抛；opencode `limit.*`——`limit` 键存在则 context/output 强制）。
   理由：把 128K 猜测当声明写进 codex `-c model_context_window` 是硬覆盖，会把 codex 自带 registry 认得的
   272K/1M 窗口**压低**，比不写更坏；`input_modalities: ["text"]` 则是替用户断言「这是纯文本模型」，
   中继上的视觉模型会在 CLI 里丢掉图像输入。
   有能力声明通道的只有 kimi/codex/opencode/claude；gemini/qwen/codebuddy/cursor/grok 无此机制（2026-08-25 逐家核实）。
   各通道声明面（2026-08-25 补齐，字段可用性见上条）：codex catalog = context_window + effective_context_window_percent(95) +
   input_modalities（`model_supports_vision`）+ supports_search_tool(false) + reasoning levels（前两者可选，未知即缺省）；
   kimi = max_context_size（config.toml 必填 / env 可省）+
   capabilities（补集写入：env 通道恒写 `tool_use` + 保留 CLI 缺省里未被声明为假的成员；config.toml 通道仅写声明为真的成员、未确知则整键省略；详见 profiles.md 硬规则）；
   opencode = limit.context/output（条件必填）+ reasoning + modalities（视觉模型 input 加 image；tool_call 缺省即开，实测请求带全量
   工具）；claude = 显示名槽 + CLAUDE_CODE_MAX_CONTEXT_TOKENS（注册表 >200K 才写，不需要时清旧值）。
   注意边界：streaming/function calling/结构化输出是协议层能力（声明补不了）；web search/file search/code interpreter
   等 hosted tools 是第一方服务端能力，第三方中继没有对应物，声明了等于摆死工具——如实不写。

8. **请求策略不是通用请求代理**（2026-08-27；2026-08-30 拆层后载体改到网关模型行）：
   可迁移声明仍是 `temperature`、`top_p`、`max_output_tokens`、`reasoning_effort`，以及 Header 名到环境变量名的引用。
   Header 存在**网关**；思考档/温度/输出上限存在**网关的每个模型**。启动只取当时选中模型上、且求交允许的字段。
   扁平 `Profile.requestPolicy` 是物化视图，不是落盘形状。Ccode 当前在启动计划中只注入各 Agent 已核实的环境变量/命令行参数，不重写 HTTP body；能力未知或不支持时保留配置、
   在校验结果提示并跳过强制注入。Header 值必须由用户在运行环境提供，网关不落密文。真实请求级注入若以后实现，
   必须按「Agent + protocol」建立逐字段适配和测试矩阵，不能把 `max_output_tokens` 直接等同为所有 CLI 的 `max_tokens`。

   逐字段通道实证（2026-08-28，Windows 本机安装二进制 strings/配置 schema；实现见 `agent_specs.rs`
   `request_policy_support`）。**2026-09-01 起取值按入口记账**（旧 supported 一词被求交器误当
   「启动可注」，qwen 温度被画成可注入即此案）：`inject` = 启动注入（env/flag/内联/overlay，
   拉起即生效）；`persist` = 仅「设为全局默认」写 CLI 配置文件可达；`tui` = 仅进程内原生命令
   （如 /effort），Ccode 不携带存储值；`unsupported` = 协议支持但 CLI 无入口；`unknown` = 未实证。
   求交器 `combo.rs` 的 `inject_*_allowed` 只认 inject；persist 字段存储可携带（可编辑、
   设为全局要写）但启动不注；协议维度在 `channel_status_for` 门控（kimi effort 仅 kimi 协议通道）：
   - **claude-code**（v2.x exe，全五项 inject）：temperature/top_p 经 `CLAUDE_CODE_EXTRA_BODY`
     （env 解析为 JSON 对象后展开进 API 请求体，反编译实证）；`CLAUDE_CODE_MAX_OUTPUT_TOKENS`；
     `CLAUDE_CODE_EFFORT_LEVEL`（同 `/effort`，档位闭集 low/medium/high/xhigh/max，保存期校验）；
     `ANTHROPIC_CUSTOM_HEADERS`（`Name: value` 逐行）。
   - **codebuddy**（claude-code fork，env 前缀独立，无 EXTRA_BODY/EFFORT 入口）：
     `CODEBUDDY_CODE_MAX_OUTPUT_TOKENS`、`CODEBUDDY_CUSTOM_HEADERS` 实证 → inject；
     temperature/top_p → unsupported；effort → unknown。
   - **codex**：temperature/top_p 仅存在于 wire schema（ModelPreferences），config 无键；
     二进制里的 `max_output_tokens` 全部是 exec pragma（工具输出截断）非模型请求 → unsupported；
     `model_reasoning_effort`（config 键）与 provider `http_headers`/`env_http_headers` 实证 → inject。
   - **gemini**：settings schema chunk 内 temperature/topP/maxOutputTokens 零命中 → unsupported；
     effort/headers 未核实 → unknown（modelConfigs.customAliases 可挂生成参数但需 experimental
     开关且消费链未逐键实证，不接线）。
   - **qwen**（0.22.0 bundle 复核，2026-09-01，旧「无通道」结论修正）：temperature/top_p/
     max_output_tokens 通道 = settings.json **条目级** `generationConfig.samplingParams`
     （snake_case 线格式键名 temperature/top_p/max_tokens；dialog schema 未列该子键——「代码读、
     schema 未写」的半隐藏通道，条目级优先于顶层 model.generationConfig，逐字段合并实证）
     → persist（「设为全局」写入；启动 env 够不到）。env 侧仅 `QWEN_CODE_MAX_OUTPUT_TOKENS`
     一条策略通道（条目已配 samplingParams 时被跳过）。注意：条目配了 samplingParams 会跳过
     qwen 的 known-model max_tokens 自动钳制，用户显式值原样下发（超上限 400 风险自控）。
     effort：无注入通道；但 0.22.0 有 `/effort low|medium|high|xhigh|max` 直切命令
     （写运行时 reasoning.effort，effortCommand 实证）→ effort_levels 状态栏槽位已接。
     headers：`generationConfig.customHeaders` 在字段白名单内但请求注入点未逐键实证 → 保守 unknown。
   - **opencode**：config schema 实证 agent/model options 含 temperature/topP/maxOutputTokens/
     reasoningEffort（枚举），provider options 支持 headers → 全 inject。
   - **kimi**（2026-08-28 二进制反编译实证）：`KIMI_MODEL_THINKING_EFFORT` 原样透传 + 小写归一，
     env 路径无闭集校验（合法值随模型 catalog 漂移：low/medium/high/xhigh/max/on/off），但**仅
     kimi 协议通道读取**，anthropic/openai 兼容通道静默忽略 → reasoning_effort inject；余 unknown。
     求交按绑定 protocol 门控（combo.rs channel_status_for：非 kimi 协议的绑定该字段按 unknown 计）。
     配套（2026-09-01 语义核实，判决**不接入自动注入**，留 extra_env 逃生口）：
     `KIMI_MODEL_ADAPTIVE_THINKING`（布尔）是 Anthropic 思考 wire 形态开关（true=adaptive 新形态
     带 effort 透传 / false=budget 旧形态收敛档位 / 未设=按模型家族+档位自动推断），**仅 anthropic
     兼容通道读**——Ccode 缺省 kimi 原生通道下是死参数，且形态正误取决于模型代际+中转实现，
     注错 = 请求 400；`KIMI_MODEL_REASONING_KEY` 是思考字段方言 pin，**仅 openai 兼容通道读**，
     正确取值取决于中转方言（本地无可推导依据），缺省三键自动探测已覆盖常态（DeepSeek/
     OpenRouter），explicit pin 是异常中转的修复手段。
   - **grok**（v1.0.5 二进制 + 随附 README 双实证，全五项 inject）：通道是 config 不是 env
     （GROK_* 无此类变量）。Ccode 侧接线（2026-08-31，main 源码实证）：GROK_CONFIG overlay 白名单
     （`config_override.rs OVERLAY_ALLOW_PATHS`，fail-closed 丢弃未列出键）只放行 `[models]` 全局块，
     **逐模型 `[model.<id>]` 明确不在内**（源码注释原话 "not the per-model [model.<id>] block"）——
     故五项全经 `[models]` 全局默认注入（temperature/top_p/max_completion_tokens/
     default_reasoning_effort/extra_headers=`$VAR` 引用，overlay 管线会展开 env 变量）；
     `api_backend`/`context_window` 是 `[model.<id>]` 字段，overlay 注不进——Ccode 侧通道 =
     绑定级「API 后端」字段 +「设为全局默认」写 `[model.*]` 段（2026-09-01 起；context_window
     只写权威层值：用户覆盖/网关实测缓存，估值层不配覆盖目录声明）；中转 `/models` 目录条目
     （`apiBackend`/`contextWindow`，`parse_remote_model_value` 实证解析）仍是首选渠道；
     目录缺 contextWindow 时 grok 按 256_000 计。
   - **cursor**：本机未安装（2026-08-28），无法 strings 实证——保持全 unknown，装机后补。
   - 汇总：claude-code 全五项 inject、codebuddy max output+headers inject、codex effort+headers inject、
     gemini 前三项 unsupported、qwen 温度/topP persist + max output inject + effort tui、
     opencode 全五项 inject、kimi effort inject（协议门控）、grok 全五项 inject（overlay [models] 全局默认）。

   接线状态（2026-08-28 第二批）：`launch_plan` 已接 claude-code（EXTRA_BODY 合并
   temperature/top_p + MAX_OUTPUT_TOKENS + EFFORT_LEVEL + CUSTOM_HEADERS）、codebuddy
   （CODEBUDDY_ 前缀两条）、codex（`-c model_reasoning_effort` + provider `env_http_headers`，
   无 base_url 时 headers 无处挂载不注）、opencode（OPENCODE_CONFIG_CONTENT 的 model options 四项
   + provider options.headers，headers 值拉起瞬间从进程环境解析——只在 env 内联合并不进
   opencode_provider_json，防全局写入路径把密文落盘）、kimi（KIMI_MODEL_THINKING_EFFORT，仅
   kimi 协议通道）、grok（GROK_CONFIG overlay 的 [models] 全局默认五项，2026-08-31 白名单
   源码实证后接线；headers 以 $VAR 引用透传不解析密文）、qwen（QWEN_CODE_MAX_OUTPUT_TOKENS
   一条 env，2026-09-01；temperature/top_p 走「设为全局」的条目级 generationConfig.samplingParams）。
   「设为全局」侧的条目级策略写入：opencode models.*.options 四项、kimi [models.*]、qwen
   generationConfig.samplingParams 三项（均按各模型自己的值）。claude 另接
   CLAUDE_CODE_SUBAGENT_MODEL（名单 ≥3 时复用 HAIKU 槽，启动注入与设为全局同键，2026-09-01）。
   只注用户填了的字段；extra_env 仍最后注入可覆盖；官方账号拉起不注策略。

   网关体检探针（2026-08-28，`profile_validation.rs probe_gateway`）：绕过 CLI 直连端点发
   max_tokens=16 的最小请求，观测裸响应回答「网关把请求怎么了」——① 基础请求（鉴权+模型存在）
   ② 裸 stream:true 看回不回 SSE ③ 带请求策略参数再发流式（对比②定位「加参数就不流式」的降级）
   ④ 自定义 Header 接受度（值从进程环境解析，未设置的变量名在结果里点名）。鉴权镜像 CLI 真实
   形态（claude/codebuddy 走 Bearer 同 ANTHROPIC_AUTH_TOKEN 口径）；cursor 专有协议与 gemini
   协议暂不支持探针。出站文案统一过 redact_sensitive_text。

   配套防护（2026-08-28）：Anthropic 通道 Base URL 以 `/v1` 结尾会被 SDK 拼成 `/v1/v1/messages` 404
   （实测），且「获取模型」走 OpenAI 风格 `{base}/models` 照样成功、极具迷惑性——profile 校验给提醒
   （不阻断保存），配置弹层 Base URL 行内同步警示。

## 10. MCP 配置分发调研（2026-08-10，八家经官方文档/源码/本机实测核实；grok 为 2026-08 源码调研，首版只读不分发）

**目标**：Ccode 维护一份 MCP server 清单，一键分发进各 CLI 自己的配置文件。本节是实现规格的单一出处——写字段/路径前以此为准，不要凭印象。

### 10.1 分发通道总表

| CLI | 用户级配置落点 | 顶层键 | 格式 | 分发主通道 | 备选通道 |
|---|---|---|---|---|---|
| claude-code | `~/.claude.json`（**高频共享状态文件，高危**） | `mcpServers` | JSON | 项目级 `<repo>/.mcp.json`（独立单用途文件，最安全；交互会话有审批闸） | `claude mcp add --scope user`（CLI 自己做读改写） |
| codex | `~/.codex/config.toml`（与 model/notice/trust 同文件） | `[mcp_servers.<name>]`（下划线） | TOML | `codex mcp add/remove`（原子写；add 命中 OAuth server 会弹浏览器登录，注意） | 读-改-原子写 config.toml 只动 `mcp_servers` 段 |
| gemini | `~/.gemini/settings.json`（混合状态文件） | `mcpServers` | JSONC（容忍注释） | `gemini mcp add/remove -s user`（**scope 默认 project，必须显式 user**） | 读-改-合并写 settings.json 只动 `mcpServers` 键 |
| qwen | `~/.qwen/settings.json`（Ccode「设为全局」已写同文件） | `mcpServers` | JSONC | **直接写用户级 settings.json**（免审批 + 运行时热加载；JSON 损坏会被 CLI 清空重置，必须原子写+备份） | `qwen mcp add`（scope 默认 user，逐条无批量） |
| opencode | `~/.config/opencode/opencode.json(c)`（三个文件合并加载：config.json→opencode.json→opencode.jsonc，写已存在者） | `mcp` | JSONC | 直接写文件（纯用户设置文件，最友好；`mcp add` 只能写全局且无 remove） | `opencode mcp add`（非交互，保注释） |
| kimi | `~/.kimi-code/mcp.json`（`KIMI_CODE_HOME` 可搬迁；**MCP 专用纯声明文件，引擎只读不写**） | `mcpServers` | JSON | **直接写文件**（无可脚本化 CLI 命令，TUI `/mcp-config` 不算） | —（只能写文件；写后新会话生效） |
| codebuddy | `~/.codebuddy/.mcp.json`（MCP 专用文件，回退链 mcp.json→.codebuddy.json） | `mcpServers` + 并列 `disabledMcpServers` | JSONC | `codebuddy mcp add-json -s user`（默认 scope 是 local，寄生全局状态文件，禁用） | 直写 user 级 .mcp.json（保留 disabledMcpServers 键；有 watch 热生效） |
| cursor | `~/.cursor/mcp.json`（**CLI 与 IDE 共享**，写入同时改变 IDE 行为） | `mcpServers` | JSON | **直接写文件**（CLI 无 add/remove 子命令；`agent mcp list` 是交互 TUI 不能用于校验） | —（全局 server 免审批，项目级逐工作区批准） |
| grok | `$GROK_HOME/config.toml`（缺省 `~/.grok/config.toml`，与 model/hooks 同文件） | `[mcp_servers.<name>]`（**TOML 段**，非 JSON） | TOML | `grok mcp add`（CLI 自己做读改写；**Ccode 首版只读清单、不分发**——TOML 段结构独立，不硬造原子写管线） | 手工编辑 config.toml（grok 兼容读 `~/.claude.json`/`.mcp.json`/`~/.cursor/mcp.json`，可在 config 关） |

### 10.2 条目 schema 映射（Ccode 统一模型 → 各家字段）

Ccode 清单模型只收公共子集：stdio（command/args/env/cwd）+ remote（url/headers）+ enabled（v3.93 已落地：
清单级全局开关，停用 = 从各 agent 移除条目但保留 apps 映射，重开按原样重投——各家条目 schema 无原生禁用字段，
故不停用各家配置表达，codebuddy 的 `disabledMcpServers` / grok 的 `enabled` 暂不接入）。映射表：

| Ccode 字段 | claude | codex (TOML) | gemini | qwen | opencode | kimi | codebuddy | cursor | grok (TOML，首版只读) |
|---|---|---|---|---|---|---|---|---|---|
| stdio | `command/args/env`（显式 `type:"stdio"`） | `command/args/env/cwd`（有 command 即 stdio） | `command/args/env/cwd` | 同 gemini | `type:"local"`，**command 是数组**（命令+参数合一），env 叫 `environment` | `command/args/env/cwd`（无 transport 自动推断） | `type:"stdio"` + command/args/env | command/args/env（type 可省略） | `command/args/env/cwd`（有 command 即 stdio；通用 `enabled`/`startup_timeout_sec`/`tool_timeout_sec`） |
| remote | `type:"http"` + url/headers | `url` + `http_headers`（SSE 不支持） | **`httpUrl`**（url=SSE 已 legacy） | 同 gemini（httpUrl） | `type:"remote"` + url/headers | url/headers（http；SSE 须显式 transport） | `type:"http"` + url/headers | url/headers（自动协商 transport） | `url` + `type`("http"/"sse"，省略时 /sse 结尾即 sse) + `headers`/`bearer_token_env_var` |
| cwd | 未核实，**不写** | `cwd` | `cwd` | `cwd` | `cwd` | `cwd` | 未核实，**不写** | 未核实，**不写** | `cwd` |

### 10.3 密钥与插值（防明文落盘口径）

- claude/codebuddy：`${VAR}` / `${VAR:-default}` 插值（codebuddy **只认全大写变量名**）；codex：**无通用插值**，用 `bearer_token_env_var`/`env_http_headers`/`env_vars` 按名引用环境变量（内联 `bearer_token` 会被显式拒绝）；gemini/qwen：`$VAR`/`${VAR}` 全文件插值（gemini 有出站 env 脱敏，密钥必须在 env 块显式声明）；opencode：`{env:VAR}` 语法；kimi：`bearerTokenEnvVar` 间接引用；cursor：`${VAR}` 与 `${env:NAME}`；grok：headers/env 值支持 `${VAR}` 引用 + `bearer_token_env_var`（env 读 token 注入 `Authorization: Bearer`，密钥不落盘）。
- 结论：Ccode 清单里密钥一律存「环境变量名引用」，各家映射成各自的间接引用字段，不落明文。

### 10.4 共性红线

- **绝不整文件覆盖**：claude/codex/gemini/qwen 的目标文件都是混合状态文件（存登录态/信任记录/model 选择等），只读-改-写一个键/段，写前备份 + 原子写（复用 global_config.rs 的 agent 级事务批次模式）。
- **企业管理层探测**：claude（managed-mcp.json 三系统路径）/opencode（managed 目录）存在即放弃分发并提示。
- **项目级都有审批闸**（claude/qwen/cursor/codebuddy 逐工作区批准，gemini/qwen 未信任目录整层忽略）——默认只写用户级。
- **校验手段**：claude `mcp get`（不要 `mcp list`，会真连 server）、codex `mcp list --json`（脱敏）、cursor 没有非交互校验命令（只能解析文件）。
- **stdio 命令解析**（Ccode 侧分发义务）：裸命令名必须经 `resolve_binary` 落绝对路径（GUI/打包环境 PATH 短）；node 系 shim（`#!/usr/bin/env node` shebang 的脚本/symlink，如 npx）要再换成 node 绝对路径 + shim 真实路径首参，否则宿主 PATH 无 node 时 spawn ENOENT（实机踩坑：npx symlink → npx-cli.js，shebang 依赖 PATH 里的 node）。**相对路径命令（`./` `../` 开头）先解后拦**（2026-09-03 起，替代旧的直接拒写）：基准序 = 条目自己的绝对 cwd → 来源 agent 配置家目录 → 有实证的插件/缓存目录（目前仅 codex 的 `~/.codex/computer-use`、`~/.codex/plugins`）；收编/粘贴导入时命中即存绝对路径并把相对 cwd 规范化为命中基准，全部不命中 fail-open 照原样收进清单（清单页 `mcp_command_path_status` 标 relative 告警 + `resolve_mcp_command_fix` 一键修复）；分发时按条目自己的 cwd 先试解，解不出才拒写（2026-08-17 实机案例：codex 插件的 computer-use 以 `./…` 收编后分发 kimi 连不上；2026-09-03 实机案例：ChatGPT 桌面版写入的 `[mcp_servers.computer-use]` 为 `./Codex Computer Use.app/…` + `cwd="."`，只有以插件目录为工作目录拉起才解析得到，Ccode 内嵌终端在项目目录拉起即 ENOENT）。
- **kimi `/mcp-config` 交互编辑器实测坑**：曾把启动参数整体写进 `cwd` 字段（`"cwd": "-y <pkg> <dir>"`），spawn 时目录不存在报 ENOENT——报错文案指向 command 路径，极具迷惑性。遇到 kimi MCP ENOENT 先查 cwd 是否合法目录，再查命令路径。
- **server 命名**：统一 `[A-Za-z0-9_-]`；gemini 额外要求**不含下划线**（policy 引擎按下划线切分 FQN，含下划线安全策略静默失效）。

## 11. 图片输入实测表（2026-08-17 调研）

九家 CLI **全部内建图片输入**，且「把图片/文件的绝对路径文本写进输入框」九家通吃——这是 Ccode 终端
图片/文件输入的实现基础（paste 事件拦图片 → 落盘 → 路径写 PTY；macOS Ctrl+V 透传 `\x16` 由 CLI 自读剪贴板）。

| CLI | 粘贴剪贴板图片（键位 + 机制） | 拖入图片 | @路径引用图片 | 模型能力门控 | 来源 |
|---|---|---|---|---|---|
| claude | macOS **Ctrl+V**（CLI 收到按键后自读系统剪贴板；Cmd+V 只在新版终端部分支持） | 拖入 = 路径文本，发送时升级为真附件 | 支持，自动升级为真附件 | 多模态模型才消费（当前默认模型均可） | [docs](https://docs.anthropic.com/en/docs/claude-code/interactive-mode) |
| codex | macOS Ctrl+V（TUI 自读剪贴板）；Windows/Linux Alt+V | 路径文本 → 真附件 | 支持 | 取决于所配模型是否多模态 | [repo](https://github.com/openai/codex) |
| gemini | macOS Ctrl+V；Windows Alt+V | 路径文本 | 路径原文进上下文，模型经工具读图 | 同左 | [repo](https://github.com/google-gemini/gemini-cli) |
| qwen | 同 gemini（fork 同源键位） | 路径文本 | 路径原文 + 工具读图 | 同左 | [repo](https://github.com/QwenLM/qwen-code) |
| opencode | macOS Ctrl+V；Windows Alt+V | 路径文本 → 真附件 | 支持 | 同左 | [docs](https://opencode.ai/docs/tui/) |
| kimi | macOS Ctrl+V；Windows Alt+V | 路径文本 | 路径原文 + 工具读图 | 同左 | [repo](https://github.com/MoonshotAI/kimi-cli) |
| codebuddy | macOS **Ctrl+V 与 Cmd+V 都认**；Windows Alt+V | 路径文本 | 路径原文 + 工具读图 | 同左 | [官网](https://www.codebuddy.ai) |
| cursor | 剪贴板图片键位同上口径；路径引用为主 | 路径文本 | 路径原文 + 工具读图 | 同左 | [docs](https://cursor.com/docs/cli) |
| grok | Ctrl+V（**另认 Cmd+V**，九家中仅 codebuddy/grok 两家） | 路径文本 → 真附件 | 支持 | 同左 | [repo](https://github.com/xai-org/grok-build) |

要点：

- **macOS 的网页侧坑**：Ctrl+V 在 WKWebView 里不产生 paste 事件也不进 PTY，Ccode 在键盘层改写为
  `\x16` 透传（kimi 因 kitty 键盘协议改写为 CSI-u `\x1b[118;5u`，待实机验证）；Cmd+V / Chromium 的 Ctrl+V
  走 paste 事件，有图片时拦下落盘转路径。Windows 各家贴图用 **Alt+V**（本就透传为 ESC+v，无需处理）。
- **路径文本的升级行为分两派**：claude/codex/qwen/grok/opencode 会把输入框里的图片路径升级为真附件
  （多模态直读）；gemini/kimi/codebuddy/cursor 是路径原文进上下文、模型经工具读图。两派用户体验等价，
  Ccode 只需保证写进去的是**转义后的绝对路径**。
- 临时落盘文件在 `<config>/ccode/tmp/paste-*`，保存时顺带清理 7 天前残留（clipboard.rs）。
- **2026-10-25 按聊天层的发法逐家实测（修正上一条）**：聊天层发的是「正文 + 换行 + 图片路径」整段（多行走 bracketed paste，
  pty_write_submit）。假网关 `E2E_DUMP` 看请求体：**只有 Claude Code 2.1.306** 把单独一行的图片路径升级成图片块（粘贴当下就变 `[Image #1]`）；
  Codex 0.164.0、Qwen 0.25.3、OpenCode 1.19.3、Grok 1.0.70、Gemini 0.65.0、Kimi 2.3.1、CodeBuddy 2.175.0 都按文字原样发（假模型 e2e-picked，
  能力未知；它们的升级可能只在「整段粘贴就是一个路径」或模型声明能看图时发生）。前面带字的行（`原图：/a.png`）九家都按文字发，
  Claude Code 也不升级。聊天层改图据此把图写成「原图：」「标注图：」行（`src/chat-image.ts attachmentLines`），看不了图的模型也不报错。
  Cursor 只能用官方账号，没走假网关，改用 `cursor-agent -p` 真跑一次核对出图工具可用。
- **出图工具逐家核对（2026-10-25）**：Mesa 给每个 PTY 都注入 `MESA_IMAGE_TOOL`（pty.rs，不分 agent）。九家都在完全访问档跑通
  `"$MESA_IMAGE_TOOL" image --image … --out …`（假网关回 shell 工具调用、出图工具换成同参数的桩）。
  回复里写出的图片路径，聊天层按回复文字出图片卡（`mentionedImageFiles`，与 agent 无关），前提是这家的回复能从会话文件读出来——
  九家都能，金丝雀每天核「解析器读到回复」。
  Codex 默认沙箱不让命令联网，真出图时它会申请出沙箱（技能 image-gen 已写）；其余八家没有默认沙箱。

## 12. 精确注意力 hooks 桥接调研（2026-08-20；实现 = hooks.rs 的 BRIDGE_SPECS，写字段/事件名前以本节为准）

**目标**：注意力标记从「会话尾部文本推断」升级为「CLI 原生事件实时驱动」——向各家 CLI 的 hooks 配置写入三个事件
（用户提交→工作中 / 轮次结束→已回复 / 等待确认→待确认）的命令条目，事件触发时 CLI 把原始 payload（加 unix 秒前缀）
追加到 `<config>/ccode/hooks-state/<tag>-hooks.jsonl`；注意力分类对已开启的 agent 优先读该日志，缺失或超 10 分钟
无更新回落尾部推断（消费侧零改动）。

### 12.1 桥接总表

| CLI | 配置文件 | 格式/写入形态 | 三事件映射（工作中 / 已回复 / 待确认） | 生效门槛 | 证据与版本 | Ccode 状态 |
|---|---|---|---|---|---|---|
| claude-code | `~/.claude/settings.json` hooks 键 | JSON | UserPromptSubmit / Stop / Notification | 无 | 原有落地（v3.32） | ✅ 已接入 |
| qwen | `~/.qwen/settings.json` hooks 键 | JSONC 容错读 | UserPromptSubmit / Stop / Notification（matcher `permission_prompt\|idle_prompt`） | 无 | 本机包源码核实 0.21.1 | ✅ 已接入 |
| codebuddy | `~/.codebuddy/settings.json` hooks 键 | JSON | UserPromptSubmit / Stop / Notification（matcher `permission_prompt\|idle_prompt`）——与 Claude 完全同名同语义 | **启动快照 hooks 配置**：运行中外部改文件需在 /hooks 面板 review 才生效（该行为未实测） | 官方文档+本机包源码核实 2.132.0 | ✅ 已接入 |
| gemini | `~/.gemini/settings.json` hooks 键 | JSONC 容错读 | **BeforeAgent / AfterAgent / Notification（matcher `*`，仅 ToolPermission 型）** | 无 | 本机包源码核实 0.46.0（官方 migrate 命令映射表确认事件对应） | ✅ 已接入 |
| kimi | `~/.kimi-code/config.toml` `[[hooks]]` | TOML strict 四字段（event/matcher/command/timeout，多写字段整个配置加载失败） | UserPromptSubmit / Stop / **PermissionRequest**（kimi 的 Notification 是后台任务通知，陷阱勿用） | 无 | 二进制内嵌源码+官方文档核实 0.37.2 | ✅ 已接入 |
| grok | `~/.grok/hooks/ccode.json`（整文件归 Ccode，全局目录免 folder trust） | JSON 整文件形态（开启=写文件，关闭=删文件，不含 marker 的外来文件拒绝覆盖） | UserPromptSubmit / Stop（**payload reason=end_turn 才算**，teardown 会以 shutdown/channel_closed 重发）/ Notification（matcher `permission_prompt\|idle_prompt`） | 无 | **实机验证 1.0.5** | ✅ 已接入 |
| codex | `~/.codex/hooks.json` | JSON，handler 带 `async: true` | UserPromptSubmit / Stop / **PermissionRequest** | **非托管 hook 需在 TUI /hooks 面板审核信任后才执行**（按 hook 定义 hash 记信任，改命令失效需重审） | 本机 0.148.0 实测 features stable + 官方仓库源码核实 | ✅ 已接入 |
| cursor | `~/.cursor/hooks.json`（扁平结构 `{version:1, hooks:{事件:[{command}]}}`） | JSON | beforeSubmitPrompt / stop / **无「等待确认」等价事件** | CLI 逐事件触发与 conversation_id↔会话文件映射未实机验证（未登录） | bundle 调用链+官方文档核实 2026.08.04 | ❌ 未接入（无等待确认等价事件 + 机制未实机验证） |
| opencode | 无 shell hooks 形态 | — | —（仅进程内 JS 插件：`~/.config/opencode/plugins/*.ts`，事件 session.idle/permission.asked 等，事件名 v2 重构中不稳定） | — | 官方文档+SDK 类型核实 1.18.18，本机未装未实测 | ❌ 未接入（无 shell hooks 形态） |

### 12.2 各家全事件集要点与陷阱（挂钩前核对）

- **qwen（0.21.1）**：共 21 事件，含 idle_prompt/PermissionRequest/StopFailure；**UserPromptSubmit 语义比 Claude 宽**
  （工具续轮也触发，`submitted_prompt` 才是纯用户提交）——桥接仍挂 UserPromptSubmit，多报的 working 会被后续 Stop 纠正。
- **gemini（0.46.0）**：共 11 事件；**AfterModel 每 chunk 触发，勿挂**；SessionEnd 不等待 hook 完成（不能用于同步收尾）；
  官方 migrate 命令的映射表确认 Claude→Gemini 对应（UserPromptSubmit→BeforeAgent / Stop→AfterAgent / Notification→Notification）。
- **kimi（0.37.2）**：另有 SessionHeartbeat 每 60s 活性信号（本批未用）；`[[hooks]]` 是 TOML strict——event/matcher/command/timeout
  四字段多写一个整个配置加载失败，写入走 toml_edit 保格式、只增删条目。
- **codex（0.148.0）**：共 11 事件；另有 legacy `notify` 配置项（仅 agent-turn-complete 一个事件、payload 走 argv）——桥接不用它。
- **grok（1.0.5）**：envelope 键是 camelCase（sessionId/hookEventName/transcriptPath）、事件值是 snake_case
  （user_prompt_submit/stop/notification）；Stop 在会话 teardown 时会以 reason=shutdown/channel_closed 重复 fire。

### 12.3 日志解析与写入防护统一口径（hooks.rs）

- **双信封兼容**：claude/qwen/codebuddy/gemini/codex/kimi 的 payload 键是 snake_case，grok 是 camelCase——解析时两键都探。
- **事件名归一化**：去下划线 + 全小写（grok 的 snake_case 值与其余各家的 PascalCase 归到同一判定表）。
- **grok Stop 去重**：只认 reason 缺失或 `end_turn` 的记录，shutdown/channel_closed 跳过不更新状态。
- **会话归属双键匹配**：`session_id == 会话文件主名` 或 `transcript_path == 会话文件完整路径`（grok 会话文件主名恒为
  `updates`，必须靠 transcript_path 命中；kimi 无 transcript_path 自然只用前者）。
- **写入防护**（同 global_config 约定）：写前备份（同前缀留 10 份）+ 原子写 + 只动 hooks 段/键 + 用户已有 hooks 合并
  而非覆盖 + 移除只删含状态日志路径（marker 子串，匹配前反斜杠归一化为正斜杠）的条目并回收空壳键 + 配置损坏拒绝写入；
  **grok 整文件形态例外**（文件归 Ccode，外来文件拒绝覆盖）。

## 13. 桌面客户端接力调研（2026-10-18；实现 = client_open.rs，决策见 architecture §10 当日条目）

V = 源码 / 官方文档 / 本机实测核实，I = 推断。Codex、Claude 两家直接读本机已装客户端的 app.asar 源码；其余七家由调研代理查官方文档与源码（含本机各 CLI 家目录与 VS Code 扩展）。

### 13.1 总表

| agent | GUI 客户端 | 共享 CLI 会话存储 | 按会话 id 打开 | 按目录打开 / 新开 | 本期 |
|---|---|---|---|---|---|
| codex | ChatGPT.app 内嵌（bundle `com.openai.codex`，scheme `codex`，本机 26.1013；V） | 是，`~/.codex/state_<N>.sqlite` 的 `threads` 表（V；不能用 rollout 文件在不在判断——`.jsonl` 会被压成 `.zst`） | `codex://threads/<id>`（V） | `codex://threads/new?path=<绝对路径>`（V，`path` 经 `mi()` 校验必须绝对路径；另认 `prompt` / `mode` / `projectId` / `originUrl`） | 做 |
| claude-code | Claude 桌面版（`com.anthropic.claudefordesktop`，scheme `claude`，本机 2.42304；V）；VS Code 扩展 `anthropic.claude-code`（V） | 是，`~/.claude/projects`（V，桌面版 Code 标签就是 CLI 会话） | `claude://resume?session=<uuid>` = `importCliSession` 把 CLI 会话导入桌面版（V 源码）；VS Code `vscode://anthropic.claude-code/open?session=&prompt=`（V，但按窗口工作目录 `--resume`，落哪个窗口 Mesa 控制不了，**不做**） | `claude://code/new?folder=<路径>&q=<提示>`（V，folder 可多值） | 桌面版做 |
| kimi | Kimi Code Desktop ≥1.1.0（macOS/Windows/Linux）、`kimi web`、VS Code 扩展 `moonshot-ai.kimi-code`（V 文档） | 是，`~/.kimi-code/sessions`（V） | **无**：`kimi-code://open` 只认 `root` 与 `new=1`（V 源码）；浏览器兜底 `kimi vis <id>` | `kimi-code://open?root=<编码路径>&new=1`（`kimi app [path]` 即用它；已有工作区开的是新草稿不是旧会话，V） | 项目级，后续 |
| opencode | 桌面版（Electron beta，scheme `opencode`）、`opencode web`、VS Code 扩展（只在终端跑 CLI） | 是，`~/.local/share/opencode/opencode.db`（V 本机；桌面版内置 CLI 服务共用，I） | scheme 上无；TUI `opencode -s <id>`，web 路由 `/:dir/session/:id`（V） | `opencode://open-project?directory=` / `opencode://new-session?directory=&prompt=`（V，v1.19.3 源码；本机未装，版本待实测） | 项目级，后续 |
| qwen | Tauri 版 Qwen Code Desktop（仓库 0.0.1，是否公开发布未确认）、`qwen serve` Web Shell、VS Code `qwenlm.qwen-code-vscode-ide-companion` | 是（daemon 扫 CLI 的 JSONL；VS Code 走 ACP `session/list`/`load`，V） | 仅浏览器 `http://127.0.0.1:4170/session/<id>?workspace=<id>`，桌面版无 scheme | `qwen serve --workspace <abs> --open`（实验性，cwd 与注册工作区不符返回 400） | 不做（要管服务进程） |
| codebuddy | 内置 Web UI `codebuddy --serve --open`；VS Code/JetBrains 用 `--ide`。WorkBuddy.app 是另一套存储（`~/.workbuddy`，V 本机） | Web UI 同进程同存储（I） | 无 | `cd <dir> && codebuddy --serve --open` | 不做 |
| gemini | **无会话级客户端**：VS Code / Antigravity 的 Gemini CLI Companion 只做 diff 与上下文（V）；Antigravity 是另一套存储，不读 Gemini CLI 会话（V 本机 `~/.gemini/antigravity*/conversations/*.db`） | 不适用 | 无 | `code <dir>` 再手动运行 | 不做 |
| cursor | Cursor IDE / Agents Window（本机未装）。`cursor://anysphere.cursor-deeplink/` 只有 `prompt` / `command` / `rule` 三类（V 文档） | 未见读 CLI 会话（I；CLI 在 `~/.cursor/chats/<hash>/<id>/store.db`） | 无（`agent --resume <id>` 仅终端） | `cursor <dir>`（I，VS Code fork 惯例） | 不做；CLI 只认 Cursor 自家账号，不能走第三方网关（V） |
| grok | **无已核实客户端**：文档只列 ACP 编辑器（Zed / Neovim / Emacs / marimo），JetBrains 即将（V）。本机 Grok Bot.app（`com.anysphere.sand`，schemes `grokbot` / `sand`）是 Cursor / SpaceXAI 的云电脑产品，与 `~/.grok` 无关，**不是** Grok Build 客户端（V） | 不适用 | 无 | 无 | 不做 |

Zed 是唯一核实过的跨 agent 路线：可从已配置的 ACP agent 导入会话到 Thread History（V Zed 文档）；未核实其 URL scheme。

### 13.2 Claude 桌面版深链细节（Claude.app 2.42304.0 app.asar 源码）

- 路由：`claude://resume?session=<uuid>`（`Ml.Resume`）、`claude://code/new?folder=&q=`（`jl.Code` 的 `/new`，`q` 与 `prompt` 同义）、`claude://code/continue?session=<uuid|last>`、`claude://code/needs-input`、`claude://code/search`。`folder` 带 `src=external`，由桌面版自己处理工作区信任。
- `resume` 只收 UUID 形态的 session；导入走 `LocalSessionManager.importCliSession` → `adoptCliSession`，要求已登录账号（无账号信息直接抛「Unable to import session」）、拒绝正在被删除 / 属于 Cowork 的 id。工作区未信任抛 `WorkspaceUntrusted`。
- 失败全部在桌面版内 toast，类别 `auth_expired` / `network` / `transcript_missing` / `other`——**Mesa 看不到**，只能在发链接前预检 transcript 文件存在。
- 桌面版继续时用自己的账号 / 推理配置，不带 Mesa 注入的 `ANTHROPIC_BASE_URL` 等环境变量（环境变量只对 Mesa 拉起的 CLI 进程生效）。

### 13.3 共性结论

1. **环境变量注入对所有 GUI 客户端无效**：它们都不带 Mesa 的注入启动。渠道能到达客户端的只有写盘配置（Codex 的 provider 定义块、「设为全局默认」）；claude 桌面版走自己的账号。
2. 客户端是否「无缝」取决于三条：读不读同一份会话存储、能否按 id / 目录定位、渠道能否带过去；缺一档降一档。
3. 本机 Codex 0.163 的 provider 支持 `command` 取令牌（`command / timeout_ms / refresh_interval_ms / cwd`，字符串表核实，**未实测 ChatGPT 内嵌客户端认不认**），若认则 `experimental_bearer_token` 明文落盘可替换为命令取密钥；单独起验证任务，不并入本期。

4. **Windows（2026-10-20 本机核实）**：Codex 客户端（MSIX 包 OpenAI.Codex 26.1013.4894.0）与 Claude 桌面版（MSIX 包 Claude 2.42304.2.0）的
   scheme 都注册在 `HKCR\<scheme>`（含 `URL Protocol` 值；Claude 另有 shell\open\command 指向 WindowsApps 下的 Claude.exe，Codex 没有，靠应用包激活）。
   版本从 `HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages` 的子键名（包全名）读，
   不起 PowerShell。深链打开本身仍需人点验（会真的拉起客户端）。

## 14. 聊天层结构化旁路（2026-10-20；实现 = chat_channel.rs + hooks.rs launch_hooks_value，设计 docs/design-chat-structured-channels.md）

**目标**：TUI 照常跑在 PTY 里，同时让 CLI 自己把「会话是哪个、这一轮在哪步、在等批准什么、正在写什么」用结构化事件交给 Mesa；
**不写用户配置**（只用启动参数 / 环境变量 / Mesa 自己目录下的临时文件）。核实工具：`scripts/e2e-model-routing/channel-probe.py`、
`codex-appserver-probe.py`（CLI 机制），`chat_channel::e2e::e2e_channel`（Mesa 实现）。

| CLI（核实版本） | 旁路 | 会话 | 回合边界 | 审批 | 实时文字 | 回复审批 |
|---|---|---|---|---|---|---|
| claude-code 2.1.292 | `--settings` 带 hooks（并进 Mesa 的 0600 覆盖文件；没有覆盖文件时内联 JSON）；与用户 `~/.claude/settings.json` 的 hooks **合并、都触发**（V） | SessionStart：`session_id` + `transcript_path` + `source`（startup / resume / **clear** / compact）（V） | UserPromptSubmit / Stop（带 `last_assistant_message`）（V） | PreToolUse 带 `tool_name` / `tool_input` / `tool_use_id`；Notification `notification_type=permission_prompt` 比 PreToolUse 晚约 6 秒（V） | 无 | 只能终端菜单 |
| codebuddy 2.169.0 | `--settings <JSON>`（帮助未列，二进制有 `--settings <file-or-json>`）（V） | 同 Claude（V） | 同 Claude（V） | ptc 模式只有 `REPL` 工具，参数是 JS 代码（V） | 无 | 只能终端菜单 |
| qwen 0.25.2 | Dual Output：`--json-file <事件>` + `--input-file <命令>`；首行 `system/session_start` 带 `protocol_version: 2` 与 `supported_events`（V）。另：`QWEN_CODE_SYSTEM_DEFAULTS_PATH` 注入 hooks 也通（V，未用） | `session_start.session_id`（V） | 用户消息 / **交互态不发 `result`**：一次模型回复里没有 `tool_use` = 本轮结束（V） | `control_request{subtype:can_use_tool, tool_name, tool_use_id, input, permission_suggestions}`（V） | `stream_event` 的 `text_delta`（V） | input 文件追加 `{"type":"confirmation_response","request_id","allowed"}`，哪边先答算哪边（V） |
| opencode 1.19.3 | TUI 自带服务 `--port <n>`，`OPENCODE_SERVER_PASSWORD` 开 Basic 鉴权（用户名 opencode；无口令 401）（V） | SSE `session.created`（只给 id）（V） | `session.status` busy / idle、`session.idle`（V） | `permission.asked{id, permission, patterns, metadata.command, tool.callID}`（V） | `message.part.delta`（V） | `POST /permission/<id>/reply {"reply":"once"\|"always"\|"reject"}`（V） |
| codex 0.163.0 | 私有 `codex app-server --listen ws://127.0.0.1:<n> --ws-auth capability-token --ws-token-sha256 <hex>`（带 Mesa 的 `-c` 注入）+ TUI `--remote ws://… --remote-auth-token-env <变量>`；Mesa 作为第二个客户端（V） | `thread/started` 带 `thread.path`（rollout 路径）；恢复的会话不广播，靠 `thread/loaded/list`（V） | `turn/started` / `turn/completed`；未订阅前也广播 `thread/status/changed` active / idle（V） | 服务端请求 `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`；`serverRequest/resolved` 撤卡（V） | `item/agentMessage/delta`（V） | JSON-RPC 响应 `{"decision":"accept"\|"acceptForSession"\|"decline"}`（V） |
| gemini 0.64.0 | **无**：系统设置 / 系统默认设置路径（`GEMINI_CLI_SYSTEM_SETTINGS_PATH` / `_DEFAULTS_PATH`）注入的 hooks 被丢——文件必须属 root（`isFileAndDirectorySecureSync`）（V） | — | — | — | — | — |
| kimi 2.2.0 | **无**：没有指定配置文件的参数或环境变量（二进制环境变量清单核实）（V） | — | — | — | — | — |
| grok 1.0.67 | **程序状态 OSC 7501**（2026-10-22）：终端答 `OSC 7501 ; ?` 后 Grok 把状态写进输出流（`program_status = auto`）；不写任何配置（V：本机抓到 + 假网关 e2e_channel 走完一轮）。原先 `GROK_CONFIG` 覆盖层按白名单只收 models / features / toolset / shell_environment_policy，hooks 被丢（I） | 无（照旧认领） | `working`（msg = 它自己的进度一句：`Waiting for response…`、`Connection failed \| Retrying (1/15)`、工具说明）/ `done`（msg `Turn complete in 3.3s.`）后再报 `clear`（V） | `blocked:kind=permission`，msg 是工具说明（「写一个探针文件」）；启动信任菜单也报 blocked（msg `Trust this folder?`）（V） | 无 | 只能终端菜单 |
| cursor | 无「等待确认」事件 | — | — | — | — | — |

**程序状态 OSC 7501（2026-10-22，`program_status.rs`；规格 superlogical.com/rex/docs/build/program-status，机制参照 Orca `.reference/orca/src/main/agent-hooks/README.md`）**：
CLI 往输出流写 `ESC ] 7501 ; state=<idle|working|done|blocked|error>[:kind=<permission|question|auth>][:app=…][:msg=<base64>] ST`；多数要终端先答探询。
本机实测：Claude Code 2.1.306 启动探测一次写出 XTVERSION、Kitty `?u`、`OSC 7501;?`、DA1，答了报 `state=idle:app=claude-code`；**环境里有
`CLAUDE_CODE_DISABLE_TERMINAL_TITLE` 就不问**（从 Claude Code 会话里起的进程会继承）。Grok 1.0.67 见上表。Codex 0.163 不问也报 idle / working（启动时
idle → working → idle 一次，不是在回答问题）。Gemini / Kimi / OpenCode / Qwen / CodeBuddy / Cursor 未见（Orca 表 2026-10-17 同）。Mesa 只在这家没有别的旁路时用它。
**Windows 用不了**（2026-10-25 本机 ConPTY 探针，Grok 1.0.67）：经 ConPTY 出来的输出里只有 `OSC 0`（标题）、`OSC 12`（光标色）和 DA1，
`OSC 7501;?` 被吞掉（macOS 上它排在 DA1 前面）；Mesa 写回去的 OSC 也会被输入侧剥掉（terminal.md「OSC 底色握手被 ConPTY 双向封死」）。所以 Windows 不接这条旁路。

**「现在在做什么」（2026-10-21，聊天层生成中那一行，`chat-status.ts`）**：正在跑的工具五家都有（Claude / CodeBuddy PreToolUse·PostToolUse、Qwen 的 tool_use·tool_result、OpenCode tool part 的 status、Codex `item/started`·`item/completed` 的 commandExecution / fileChange / mcpToolCall）；思考摘要只有三家：Codex `item/reasoning/summaryTextDelta`（每段前 `summaryPartAdded`；没摘要的模型只有 `item/reasoning/textDelta` 原始推理，拿来兜底）、Qwen `content_block_delta` 的 `thinking_delta`、OpenCode reasoning part 的 `message.part.delta`（V：假网关 TRIGGER_THINK，四家 e2e_channel 逐家核对，Codex 0.163.0 / Qwen 0.25.2 / OpenCode 1.19.3）。Claude hooks 不带思考，聊天层用会话文件里刚落盘的思考块兜底。

**生成中再发一句（2026-10-22，聊天层排队 / 立即发送，`src/mid-turn-send.ts`）**：本机假网关逐家实测（`chat-capture.py` 的 `QUEUE_*` 一幕：先让它跑一条
`sleep 9` 命令，第 4–6 秒打一句回车，看这句出现在假网关哪个请求里；`QUEUE_THEN` 再按一个键看能不能让它马上处理）。「下一步」= 和工具结果同一个请求，
插进这一轮；「轮后」= 这一轮说完后新起的请求。纯文字回复（这一轮没有工具调用）时「下一步」几家也是等说完再发。

| CLI（实测版本） | 回车之后终端里的样子 | 落在哪 | 别的键 | 让它马上处理 |
|---|---|---|---|---|
| claude-code 2.1.292 | 那句挂在过程下面「ctrl+enter to send now」，输入框「Press up to edit queued messages」 | 下一步（`The user sent a new message while you were working: …`） | ↑ 拿回来改 | Ctrl+Enter 或 Esc：打断手头这一步并马上发（V） |
| codex 0.163.0 | 「Messages to be submitted after next tool call (press esc to interrupt and send immediately)」 | 下一步（steer） | Tab =「Queued follow-up inputs」，轮后（V） | Esc：「Model interrupted to submit steer instructions」（V） |
| codebuddy 2.170.0 | 同 Codex 的提示 | 下一步（`<system-reminder data-role="message-queue">`） | — | Esc：打断并马上发（V） |
| qwen 0.25.2 | 底栏「Enter to steer · Ctrl+Q to queue」，「⏳ 1 queued」 | 下一步（steer） | Ctrl+Q 轮后 | 无：Esc 取消这一轮，排着的那句不发（V） |
| opencode 1.19.3 | 输入框里「QUEUED」 | 下一步（跟在工具结果后） | — | 未核实：Esc 要按两次才打断 |
| gemini 0.65.0 | 「Queued (press ↑ to edit)」 | 轮后 | ↑ 拿回来改 | Esc：取消这一轮并马上发（`[The previous response was interrupted…]`）（V） |
| kimi 2.2.0 | 「↑ to edit · ctrl-s to steer immediately」 | 轮后 | Ctrl+S（kitty 下 `ESC[115;5u`）= 插进这一轮（下一步），不打断（V） | 同左 |
| grok 1.0.62 | 「#1 …」「Queued · Enter to send now」，底栏「Ctrl+;:queue」 | 轮后 | — | 输入框空着再按回车：马上插进这一轮（`The user sent a message while you were working`），正在跑的命令照常跑完（V） |
| cursor | 未测（第三方网关钥匙进不了 Cursor） | — | — | — |

Claude 会话文件：排上记 `queue-operation`（`enqueue` 带原文；轮后被取走 `dequeue`；下一步插进去 `remove` + `reason: absorbed_mid_turn`），
插进去的那句另记一行 `attachment` / `queued_command`（`prompt` 原文、`commandMode: prompt`、`origin.kind: human`），**不是 user 行**——
解析要认它（`sessions.rs parse_claude`），否则聊天层与回放里这句话消失。后台任务通知、别的会话发来的也是 `queued_command`
（`commandMode: task-notification` / `origin.kind: peer`），不算用户说的。
Agent 闲着时到的后台通知（后台命令 / 子 Agent 跑完、2.1.310 起第三方网关下也开放的 Monitor 事件）则是**普通 user 行**：
`origin.kind: task-notification`、`promptSource: system`、**不标 `isMeta`**，内容是 `<task-notification>…`。`parse_claude` 对 user 行只认
`origin.kind` 缺省（旧版）或 `human`，其余跳过（2026-10-25；`peer` 本来就标 `isMeta`）。

**Claude 只画在屏上的两样（2026-10-22，2.1.306，假网关 126×29 抓屏 + 源码）**：
- **猜你下一句（prompt suggestion）**：一轮做完另发一次请求（系统提示带 `[SUGGESTION MODE: …]`，带整段历史），回的话当占位字灰着放进输入框；
  Tab 填入、空着回车直接发（`acceptMethod` tab / enter），打出一样的字也算采纳，连着 20 次没用会少出。服务端开关 growthbook
  `tengu_chomp_inflection`，`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1/0` 强开强关，设置里 `promptSuggestionEnabled: false` 关；头一轮不猜
  （对话里助手消息少于两条）、计划模式 / 有待批权限 / 限流时不猜；终端失焦（ESC[O）后实测照样出。会话文件、hooks 都不记——
  聊天层读屏（`src/prompt-suggestion.ts`）：占位字整句 SGR 2、终端有焦点时第一个字反色；同一位置还有新手示例 `Try "…"`、排队提示
  `Press up to edit queued messages`、队友 `Message @…`。
- **提问表单（AskUserQuestion）**：画在输入框的位置（`src/tui-ask.ts` 文件头有逐行样子）；题签行当前题只靠底色（permission 色）标；
  最后一项「Type something.」是就地输入行，多选里打字自动勾上；横线下是「Chat about this」（工具结果「User declined to answer questions」，
  模型接着说）；多题答完是确认页（只有一道多选题时交了也要过这一页；交了马上再按回车，隔 80ms 实测也能过），Cancel 同样记 declined 但这一轮直接停。←→ / Tab 换题，↑↓ 逐行，回车选 / 勾。工具结果
  「User answered Claude's questions: · 问句 → 答案」。

**陷阱（实证）**：
- **Codex `-c hooks.<事件>=…`** 认得出（来源记作 Session flags），但每次都要在 /hooks 面板审核信任才执行——不能当默认通道。
- **Codex 新线程第一条消息前没有 rollout**：`thread/resume` 报「no rollout found」；线程转 active 时再订，resume 会重放挂着的审批。
- **Codex 远程 TUI 恢复会话拒收权限参数**（`Permission overrides are not supported when resuming a remote task`）：改成 app-server 的
  `-c sandbox_mode / approval_policy / approvals_reviewer="auto_review"`；`-m` 照收。
- **Codex app-server 的工具在服务进程里跑**：环境变量（连接密钥、MCP 密钥、工作区端口段）要和 TUI 同一份；代理变量同理。
- **OpenCode 的 `OPENCODE_CONFIG_CONTENT` 不能整份覆盖**：Mesa 用它注入连接，覆盖会打到 OpenCode 自己的免费模型（2026-10-20 探针误触一次）。
- **Codex 同一回复里并行的工具各自开始 / 结束**（2026-10-21 用户实录：要提权的 `exec_command` 与 MCP `js` 同一刻发出，MCP 先结束）：审批要按 `serverRequest/resolved` 或它自己那个 item 结束撤卡，别的工具开始 / 结束不代表答过。
- **Kimi 2.3 启动**：先发 DA1 查询，约 1.5 秒后才推 kitty 键盘、画界面；之前写进 PTY 的字全丢（2026-10-21 ConPTY 探针 3/3）。
- **读屏字形（2026-10-21）**：Kimi 2.3 等首字时转月相「🌑 · Tip: …」；Qwen 0.25.3 的字形带 U+FE0E（「◆︎ 正文」「∴︎ Thought for 1s (click or ctrl+o to expand)」）；Gemini 0.65 输入框上方「? for shortcuts」单独一行、「Shift+Tab to accept edits / auto-accept edits  Shift+Tab to manual」随权限档变、MCP 后跟「· N skills」，粘贴多行后回显下多一行「Press Ctrl+O to expand pasted text」。
- **Gemini 0.65 hook 显示名**：转圈行写「Executing Hook: <name>」，`name` 缺省时取 `command` 原文（`getHookName`）——Mesa 写 `name`。
- **Grok 1.0.62 内置 web_search 经第三方网关必 401**（2026-10-21 用户实测）：它是 xAI 服务端搜索，另用 `models.web_search`（缺省 grok-4.x）、拿 `XAI_API_KEY` 去 xAI 鉴权；网关钥匙不认。顶层 `--disable-web-search` 摘掉它（连带 web_fetch，后者 `features.web_fetch` 缺省本就关），假网关核对请求里的工具从 26 个变 25 个。Mesa：API 连接且地址不是 `*.x.ai` 时加这个参数（`agents.rs`）。
