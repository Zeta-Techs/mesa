# 约定：网关与绑定（配置模型层）

> 状态：**已落地**。改 `profiles.rs` / `launch_plan` / 设为全局 / 模型能力 / 配置页 / 托盘前必读。
> 产品决策来自 2026-08-30 设计梳理；实现前走查补丁（洞 1–7）已并入本文，覆盖代码以括号内路径为准。

Mesa 的配置单位从「一条连接粘住 Agent + 端点 + 密钥 + 模型 + 策略」拆成两层：**网关**（怎么跟端点说话）和 **绑定**（某个 Agent 用这个网关的哪些模型）。控件是否出现按组合求交，不改写 HTTP，不解析 TUI `/model`。

## 1. 产品承诺（已锁定）

| 主题 | 选择 |
|---|---|
| 第三方模型对不上 CLI 原生命令 | 按 **Agent × 启动模型 × 网关槽 × 体检** 求交后只展示真能生效的控件。不走本地代理。 |
| 配置单位 | 网关一等；Agent 只绑定。同一 Agent + 网关允许不同模型选择；完全相同的模型/协议/附加环境变量仍拒绝重复。 |
| 端点 | 一把密钥 + 协议分槽：`anthropic` / `openai` / `responses` / `gemini` / `cursor`。 |
| 用户策略 | Header 在网关；思考档 / 温度 / 输出上限在网关的**每个模型**上（稀疏）；Agent 绑定只决定能不能注入，以及 `extraEnv`。 |
| 会话里 `/model` | 不改进程 env。状态栏按**启动时选中的模型**决定原生命令。混用时提示「换模要重开才按新模型注入」。不追踪 TUI。 |
| 配置页 | 主列表仍按 Agent 看绑定；网关进同页工具条里的库。 |
| 官方账号 / 本地 | 官方 = 无网关绑定；Ollama 等无密钥本地端点 = 普通网关（`noAuth`）。 |
| 相对 cc-switch | 商业中转预设不收录（2026-10-12 拍板：开源仓库不内置自家商业端点，用户手填；曾短暂开过 `address-only` 例外收录通道，已随 ZetaTechs 条目移除关闭）；不做本地代理、云同步、切走回写。**要做托盘一键「设为全局」**，且托盘只写全局文件、不改启动栏默认绑定。 |
| 内外双轨 | 「默认」（注入预选）和「全局生效」（上次写入 CLI 文件）是两个徽标，不合成「启用」。 |

明确不做：解析 TUI `/model`、热切已开内嵌标签、请求改写。

## 2. 对象模型

```
Gateway
  id            新发 UUID（见 §3：不复用 profile id）
  name
  noAuth
  keyHint       密钥本体在 keys.json，键 = gateway id
  walletUserId  New API 钱包查询用户 ID（非密钥，给 New-Api-User 兼容头；老站点才要）
  walletKeyHint 系统访问令牌尾号；本体在 keys.json 键 `{id}#wallet`（查钱包，不是推理 sk-）
  slots         { anthropic, openai, responses, gemini, cursor } 均可空
  headerEnv     Header 名 → 环境变量名（不落密文）
  models[]      GatewayModel（目录 ∪ 手填；策略字段稀疏）
  catalogFetchedAt, catalogFromSlot
  lastProbe[]   见 §8
  slotProbes[]  list 时按槽现算 latest（lastLatencyMs / lastOk / lastProbeAt）；不落盘

GatewayModel
  id            网关认识的模型 id
  source        fetched | user
  status        available = 最近一次获取目录仍存在；stale = 目录已不再返回。
                旧配置缺省 available——迁移不该把用户的模型藏起来
  lastSeenAt    最近一次在目录里见到它的时间（ISO）；手填的为 null
  catalogSlot   最近一次把该 id 标为 available 的协议槽；按槽刷新时只 stale 本槽
  temperature / topP / maxOutputTokens / reasoningEffort   用户设了才存

Binding
  id            见 §3
  agent
  kind          api | official
  gatewayId     api 必填；official 为空
  protocol      仅 qwen / kimi 需要（同一 openai 槽可当 kimi 或 openai）
  apiBackend    仅 grok（chat_completions/responses/messages；仅「设为全局」写 [model.*] 消费，启动注入够不到）
  models[]      有序，首个 = 启动默认
  extraEnv      CLI 专用，不自动拆去网关
  lastUsedAt

约束
  同一 (agent, gatewayId, protocol, apiBackend, models, extraEnv) 至多一条 api 绑定
  每个 agent 至多一条 official 绑定
  绑定时该 Agent 所需协议槽必须已填，否则先补槽（缺槽态见 §9）
  绑定更新不得回写共享网关的 URL / Header / noAuth / 密钥
  导入按绑定身份规则还原，不得把不同模型选择静默合并成一条
```

**唯一约束的执行口（2026-09-21）**：判据是 `has_duplicate_binding(bindings, skip_id, candidate)` 单一函数，
**新建 / 复制到其他 Agent / 编辑 / 导入 v2 四条路都必须过它**（编辑传 `skip_id` 排除自身）。
原先只有新建、复制、导入守这条，`update` 漏了——把 A 的模型选择改成与 B 完全相同即可绕过；
导入也漏了字段校验（外来的未知 agent / 非法协议 / 非法 `extraEnv` 名会静默落盘成前端看不见的幽灵条目）。
比较前模型列表先归一（空白 / 空串 / 重复不影响判定），比较含 `protocol` 与 `apiBackend`。
导入的绑定还要过与新建同口径的 `validate_profile_fields`，落盘用归一后的模型列表，
不合格者进 `skippedSlots` 原文列出。
编辑路径有一个例外：**模型选择本身没动就放行**（`update_selection_conflicts`）——
约束补上之前由编辑路径造出的历史重复对，否则那条连接连改名字都存不了；
只要协议 / 后端 / 名单 / `extraEnv` 真的变了就照拦。别把这个例外当冗余删掉。

槽对照（与现 `launch_plan` 一致，不是新发明）：

| Agent | 槽 | 现实现 |
|---|---|---|
| Claude Code | `anthropic` | `ANTHROPIC_*` env |
| CodeBuddy | `openai` | `CODEBUDDY_*` env（2026-10-21 起，见下文更正段；原在 anthropic 槽） |
| Codex | `responses` | `-c model_providers.<id>.*`，`wire_api=responses` |
| Gemini | `gemini` | `GOOGLE_GEMINI_BASE_URL` 等 |
| Cursor | `cursor` | 只在端点是 `*.cursor.sh` / `*.cursor.com` 时注入 `CURSOR_API_KEY` + `CURSOR_API_ENDPOINT`；第三方地址拒绝启动。模型仍是 `--model` |
| Grok / OpenCode | `openai` | grok：`GROK_MODELS_BASE_URL`；opencode：`OPENCODE_CONFIG_CONTENT` 内联 JSON |
| Qwen / Kimi | 绑定 `protocol` → `openai` 或 `anthropic` | kimi 官方协议仍用 openai 槽 URL + `provider_type=kimi`；kimi 双写 `KIMI_MODEL_BASE_URL` / `KIMI_BASE_URL` |

**自拼版本段的槽位地址归一（2026-10-19 定）**：gemini CLI 对 `GOOGLE_GEMINI_BASE_URL` 无条件追加 `/v1beta/models/<模型>:…`、Claude Code 对 `ANTHROPIC_BASE_URL` 自拼 `/v1/messages`（当日本机探针实测：base 带 `/v1` 分别拼出 `/v1/v1beta/…`、`/v1/v1/messages?beta=true`，中转 404，gemini 报「Model … not found or is invalid」）。用户把 OpenAI 风格 `/v1` 地址填进这两槽是常态——网关保存把主地址折进全部槽，同址网关必然如此。所以 `gateway_store::materialize` 对 **gemini / claude-code** 绑定剥掉槽位末尾版本段（`models::strip_trailing_version_segment`），启动注入 / 设为全局 / 验证拉目录拿到的都是 CLI 真正要的 base；gemini 拉目录候选链（`models::model_list_candidates`）同口径。**仅限已实证的两家**——qwen / kimi 的 anthropic 协议通道未实证自拼行为，不剥，等实测后再收；openai 系（codex / grok / opencode / qwen / kimi 的 openai 协议）版本段是约定的一部分，原样保留。

显示名：绑定无独立名字，列表用网关名（一对一）。官方绑定固定叫「官方账号」。

「复制到其他 agent」改为：**把该网关绑到目标 Agent**。缺槽当场补 URL，不复制密钥。

## 3. 第 0 原则：binding id 复用旧 profile id

磁盘上大量以 profile id 为锚，迁移不得重发 binding id。

**binding id = 旧 profile id**（UUID 原样）。**gateway 另发新 id**。

因此以下全部不断链，适配层只改「读到的对象从 Profile 变成 Binding」：

| 锚点 | 位置 |
|---|---|
| Codex catalog 文件名 | `ccode/catalogs/codex-<id>.json`（`agents.rs` `codex_catalog_path`） |
| 定时任务 | `schedules.json` 的 `profile_id`（`scheduler.rs`） |
| 会话归属 | `app.db` `session_meta.profile_id` |
| 设置五字段 | `ai_profile_id` / `ai_profiles` / `default_profiles` / `hidden_profiles` / `active_global_profiles`（字段名暂不改存储，语义改为 binding id）。`ai_model` / `ai_profile_models` 挂在前两个 id 上，解绑时随 id 一起清 |
| localStorage | `ccode.terminalTabs.v1`（`profileId`）、`ccode.lastProfile.<agent>`、`ccode.lastLaunch`、`ccode.wsLast.<cwd>`、`ccode.quickChat`（`profileId`） |

**必须重键的只有 `keys.json`**：密钥从 profile id 迁到 gateway id。`get_key` 的入参改为 gateway id；启动路径 = binding → gateway → key。官方绑定不查密钥。

被合并掉的旧 profile（见 §13）id 进合并清单，供「拆开这次自动合并」还原；这些 id 不再出现在绑定表里，指向它们的 schedules / lastProfile 在合并当时改写为保留下来的 binding id。

## 4. Provider 身份不得再叫死常量 `ccode`

启动注入是进程级，多网关不打架。真正冲突在落盘身份和会话元信息：

- Codex 全局：`[model_providers.ccode]` 只有一段，后写覆盖先写（`global_config.rs` `patch_codex_config`）。与「每 agent 一个全局生效徽标」自洽，可接受。
- Codex rollout 只记 `model_provider="ccode"`（`agents.rs` `codex_inline_provider_args` 注释），不含网关。拆层后若仍用常量，旧会话恢复会静默指到当前随便一个带 URL 的绑定。
- OpenCode 内联 / 全局：`provider.ccode`，模型 `ccode/{m}`。
- Kimi 全局：`providers.ccode`，`[models.*].provider = "ccode"`，占位别名也曾叫 `models.ccode`。

**规则**：provider 名从网关派生，注入与全局写入同一函数：

```
provider_id(gateway) = "ccode-" + gateway.id 去掉连字符后的前 8 位十六进制
```

（kimi 别名字符集 `[A-Za-z0-9_-]`、TOML 裸键、OpenCode provider 键都吃得下。）实现固定取 8 位；碰撞极罕见，不做加长。辅助函数单一出处，禁止各 adapter 再写死 `"ccode"`。

新会话 / 新全局写入用派生名。**写派生名时清掉 Mesa 历史上写的无后缀 `ccode` 段**（`model_providers.ccode` / `provider.ccode` / `providers.ccode`），避免两套并存。

**恢复回落**：

| 会话记录的 provider | 行为 |
|---|---|
| `ccode-<短id>` | 按短 id 找网关，注入同名 provider；找不到再走下面的旧口径 |
| `ccode` 或不含网关（迁移前 rollout） | 按 `session_meta.profile_id`（= binding id）恢复；没有则 `pickResumeProfile` 原顺序（期望 id → 该 agent 带槽 URL 的绑定）。注入时 provider 名仍用 **`ccode`**，以便对上旧 rollout。不要把旧会话改写成派生名。 |
| 其它 / 空 | 维持现顺序 |

`src/resume-profile.ts` 的 `provider === "ccode"` 判断改为：`ccode` **或** `ccode-` 前缀。派生名命中网关后，只在该网关的绑定里挑，不再「任意带 baseUrl」。

## 5. 求交器

纯逻辑，**后端单算、前端消费 DTO**（测试锁死）。前端不得自己查能力链——能力链在 `model_registry.rs`，状态栏隐藏 `/effort` 与网关库三态字段都只读 `combo_surface` / `combo_surface_for_gateway`。

```
surface(agent, modelId, gatewayId, slot, launchSelected: bool) → ControlSurface
```

消费：

- 模型能力：`model_registry` 五层链（thinking / context / output / vision）。relay 层按 §6 带网关维度。给界面的能力 DTO 逐字段三态：链上显式 false 原样出线，只有查不到才 None（2026-10-23：vision 曾把 false 折成 None，带图提醒失效）。
- **能力库与价目怎么认模型（2026-10-28）**：查表前一律走 `model_registry::model_key`（剥 provider 前缀、去 `:batch` / `:free` 变体、**点号当横杠**），
  OpenRouter 的 `claude-opus-5.5` 与 Claude Code 的 `claude-opus-5-5` 才对得上。**逐个型号的层（网关实测、公共库）只认同一型号**
  （统一写法后相等，或去掉 8 位日期 / YYYY-MM-DD / latest 快照后缀后相等；四位数是版本号不剥），**不按前缀退到别的型号**；
  按系列写的层（用户覆盖、内置表、内置价目）照旧最长前缀。usage.rs 价目链同口径（`match_in` + `KeyMatch`）。
  反例：曾按前缀把 Opus 5.5 退到 `claude-opus-5`，价格多算约 25%；中转自起名模型拿到别的型号的上下文。
  公共库：models.dev 与 LiteLLM（jsDelivr 镜像，国内直连通常可达）**两家都下、按型号合并**（models.dev 先占，LiteLLM 补缺），
  两家都不通才退 OpenRouter；每家里同一型号原厂优先（`MODELS_DEV_VENDORS` / `LITELLM_VENDORS`）、先到先得，变体不收，LiteLLM 只收 chat / responses。
  启动时没下过或超过 14 天后台重下；每个源先直连、连不上再经设置里的出网代理。**随包快照** `src-tauri/data/model-db-snapshot.json`
  （同一套逻辑生成，`npm run gen:model-db`，发版前刷新）在本机下载那份之后补缺，新装 / 没联网的用户也有这一层。
  网关目录把模型标 stale 时从网关实测缓存删掉（`forget_relay_models`）。
- **官方账号模型别名（2026-10-28）**：Claude 别名名单在 `tests/fixtures/claude-model-aliases.json`（Rust 与金丝雀共读），别名对应的完整型号
  **不写死**，由 `model_aliases.rs` 按本机 CLI 版本实测（本机假接口、临时 `CLAUDE_CONFIG_DIR`、不连厂商不花额度，版本变了才重测），
  连接页显示与能力库查询都用实测结果；测不出来就显示别名、不猜。`default` 随账号变，不测。
  Gemini 同口径（名单 `tests/fixtures/gemini-model-aliases.json`）：临时 `GEMINI_CLI_HOME` 把认证设成 API Key、带 `--skip-trust`，
  型号取请求路径 `/v1beta/models/<型号>:…`；`auto` 是按请求路由，不测。这是 API Key 方式下的换算，Google 账号登录时 CLI 可能另选，悬停如实写。
- Agent 通道：`request_policy_support`（supported / unsupported / unknown）。
- 用户在该模型上存的策略（稀疏）。
- `lastProbe`（§8）。
- Agent TUI 原生命令：`effort_levels` / `model_switch`。

显示规则（2026-09-01 起通道按入口记账：`inject` 启动注入 / `persist` 仅设为全局 / `tui` 仅会话内命令 / `unsupported` / `unknown`）：

- **可改** = 模型能力允许 ∧ 通道 `inject`（体检未失败）∨ 通道 `persist`（启动不注、设为全局生效）。
- **只读可见** = 模型上已存值，但通道为 `tui`/`unsupported`/`unknown` → 「已保存在网关，当前 CLI 没有通道」（tui 另有专用文案「仅会话内原生命令生效」）。
- **不出现** = 模型不会思考，或托管工具（web search 等）在第三方上。继续如实不声明 hosted tools。
- **状态栏 `/effort`** = 仅启动时选中模型求交为「原生档位可用」。绑定名单能力混杂（思考或已存采样策略不一致）→ 固定一句重开提示。
- **协议维度**：kimi 的 effort 通道仅 kimi 协议读取，绑 anthropic/openai 协议的绑定求交按 unknown 计（`channel_status_for`）。
- **从未体检 ≠ 体检失败**，见 §8。

「未实证一律不注」仍只约束 **Agent 通道表** 为 unknown/unsupported 的字段，与体检无关。

## 6. 能力数据源：唯一破例是 relay 键

查询链其余层不动，键仍是纯模型名前缀（`model_registry.rs` `normalize` / `longest_match`）：用户覆盖、公共库、内置表、关键词兜底都与 URL/网关无关。

**例外**：`model-capabilities-relay.json` 今日以模型名为键，「同一模型在不同网关能力不同时最新一次拉取赢」（`record_relay_models_to`）。多网关下两家中转同卖 `deepseek-v3.1` 会互踩。

- 新写入键：`{gatewayId}|{modelId}`（modelId 用网关返回的原始 id，查询时再 `normalize` 末段）。
- `chain_field` 增加可选 `gateway_id`：relay 表只查带该前缀的键；其它表仍只认模型名。
- 升级后**不读**无 `|` 的旧键（避免继续互踩）。各网关第一次「获取模型」才填新键；在此之前求交跳过 relay，走公共库 / 内置表。
- `record_relay_models` 必须传入 `gateway_id`，禁止再写无前缀键。

### 6.1 用户覆盖层的写入通道（2026-09-19）

`model-capabilities.json` 是查询链最高层，此前只能手编 JSON。现在网关库「模型策略」行展开尾部有「能力声明」编辑（`model_registry.rs` `set_model_capability_override` / `clear_model_capability_override` / `list_model_capability_overrides`，原子写、前缀归一小写、`output`/`api_backend` 不进 UI 但往返保留）。约定：

- **字段全 Option、留空＝未声明**：UI 只写用户填了的字段，未填字段继续走下层（公共库 / relay / 内置表），声明「不支持」（显式 false）则硬挡下层。
- **表单只有 context/思考/视觉**：`output` 不进表单——它的用户旋钮是策略字段 max output（逐模型 `maxOutputTokens`），能力层的 `output` 只喂 opencode `limit.output`（schema 必填、有 8192 兜底），做成两个并排输入框只会让人分不清；手写进文件的 `output`/`api_backend` 在 UI 保存时透传保留。
- **键是全局模型前缀**（与查询链同口径），不按网关分——覆盖的是「这个模型本身」的能力，所有 Agent、设为全局、注入共用。
- **校验前后端同口径**：前缀非空、至少一个字段、context/output 正整数（前端 `model-caps-override.ts` 与 Rust `validate_override` 消息一致）。
- 覆盖保存后前端须重拉 `model_capabilities` 让行徽章反映覆盖生效（链最高层即时改变解析值）。

### 6.2 Claude 上下文声明成对注入（2026-09-19）

`CLAUDE_CODE_MAX_CONTEXT_TOKENS`（>200K 才注）与 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` **同值成对**注入（启动 env + 设为全局同键同条件、不需要时两键都清）。口径来自 cc-switch 校准：Claude Code 用 AUTO_COMPACT_WINDOW 算 auto-compact 触发点，只抬上限不抬它，压缩触发点留在旧窗口档。勿再单写上限。

### 6.3 Codex catalog 不声明 freeform apply_patch（2026-09-19）

catalog 条目不写 `apply_patch_tool_type`（freeform＝type=custom 工具会被原生 /responses 与 Anthropic 协议网关拒/丢，cc-switch 非代理档实证剥除）；编辑走既有 `shell_type: "shell_command"` 的 shell 版 apply_patch，能力不受影响。

## 7. 逐模型策略是新维度，不是搬字段

今日 `RequestPolicy` 是连接级单份（`profiles.rs`）。OpenCode 注入把同一份 `model_opts` 套到 `provider.ccode.models` 的每一个条目（`agents.rs` 约 436–442 行）。Codex 的 `model_reasoning_effort` 也是启动级一条。

拆层后：

- **存储**：`GatewayModel` 上的稀疏字段，四头全新（存储 / 注入按启动模型取值 / 求交 / 模型行展开编辑）。排期不得按「把 request_policy 挪个位置」估。
- **注入**：只取**启动时选中模型**上的值，且求交允许才注。不再把一份策略套到名单里每个模型。
- **全局写入**：CLI 文件格式支持逐模型的（OpenCode `models.*.options`、Kimi `[models.*]`、Codex catalog 的 reasoning 仍是模板全量、effort 仍是一条 `model_reasoning_effort`）按各模型自己的值写；只有一条槽位的 env（`CLAUDE_CODE_EFFORT_LEVEL`、Codex `model_reasoning_effort`）用绑定名单**首个**模型的值。
- **迁移摊派**：旧连接级 `request_policy` 的思考档 / 温度 / 输出上限摊到该连接当时模型名单里的**每一个**模型（唯一合法迁法）。Header 进网关 `headerEnv`。同一模型多条旧连接值冲突：非空合并，全冲突则留 `lastUsedAt` 较新的。

`extraEnv` 全部进绑定，迁移不猜测拆分。

## 8. lastProbe：新状态，必须有失效规则

今日探针结果不落盘，每次重探（`profile_validation.rs`）。方案把 `lastProbe` 存进网关之后：

**存什么**：按 **槽 + 模型 + URL 指纹 + 密钥有无** 存各检查项：`never` | `passed` | `failed`，外加探测时间。基础连通、流式、思考档、采样（temperature/top_p）、Header **分字段记录**；思考档失败不得关掉采样。写入前对照当前网关指纹，地址或密钥已变则丢弃迟到回包，不得写成新配置的结论。消费必须匹配当前槽、模型与指纹，禁止用「该槽最近一条」株连其他模型。**这条同时管连接状态徽标**（`gateway_store::connection_state` 与 `probe_field_status` 同一过滤口径）：绑定默认模型换了、槽地址或密钥指纹变了，徽标就回「未体检」，不得沿用同槽别的模型的结论——徽标骗人比不显示更糟。

**作废**：该槽 URL 变更、网关密钥变更（含从有到无 / 轮换）、`noAuth` 翻转。作废 = 回到 `never`，不把旧失败带到新端点。

**探针线格式按目标协议定，不是一律 chat/completions**（2026-09-17 起）：anthropic 槽走 `/v1/messages`（thinking 块）；openai 槽走 `/v1/chat/completions`；responses 槽（codex、grok 的 responses 后端）走 **OpenAI Responses 线格式**——`POST {base}/responses`、`input` 单字符串、`max_output_tokens`、思考档用规范字段 `reasoning.effort`。原因：GLM 这类 Responses-only 网关对 chat/completions 形状回 403 `model_access_denied`、对 `/responses` 放行，用错形状会把能用的槽误报成失败。目录解析同理：Responses 形状目录除 OpenAI 的 `data[].id` 外还认 GLM codex 目录的 `models[].slug`。URL 拼接的版本段规则见 `models.rs::ends_with_version_segment`（`/v1`、`/v4` 等版本段结尾直接拼资源名，不再补 `/v1`）。

**求交**：

| 体检 | 控件 |
|---|---|
| `never`（从未体检） | **不否定**。通道 supported 且模型能力允许 → 可改（乐观）。 |
| `passed` | 放行。 |
| `failed` | 否定该项：即使通道 supported 也禁用，并显示体检摘要。 |

**与注入侧的不对称**（必须写进用户手册）：

- 注入「未实证一律不注」= Agent **通道表** unknown/unsupported，跟体检无关。Claude 的 effort 通道是 supported，从未体检也会注。
- 体检失败才会挡住已有通道的注入。
- 手册原句建议：「网关体检不是开关。没跑过体检时，Mesa 只按 CLI 是否真有注入通道决定；体检明确失败才会关掉对应控件。」

官方绑定、无密钥网关：无 API 探针；求交不看 probe。

## 9. 删除网关 / 清槽 / 悬挂绑定

- **有绑定的网关后端禁止删除**（`delete_gateway` 仍拒，是最终闸门）。**前端「解绑并删除」（2026-10-19 用户要求，免去逐条连接解绑）**：网关库点删除、该网关有绑定时弹确认，列出连接并摊开影响面（定时/项目/目标，文案与连接页「解绑」同一出处 `unbind-impact.ts`），确认后前端逐条走 `delete_profile`（与手动解绑完全同一清理口径，包括 schedules 不置空）再 `delete_gateway`；非原子，中途失败会刷新并提示「没有全部完成」，已解绑的不回滚。不是后端级联——绑定 id 是 schedules / 会话锚，不得在 `delete_gateway` 里偷偷删绑定。
- **槽可清空**。依赖该槽的绑定进入 **缺槽态**：配置页行 ⚠「这个网关还没配该协议的端点」；启动栏该项禁选；设为全局 / 托盘该项禁用。绑定记录保留（id 不断）。
- **解绑**：删除绑定行。先走 `clear_profile_refs` 清理 **settings 五字段**：`ai_profile_id`、`ai_profiles`、`default_profiles`、`hidden_profiles`、`active_global_profiles`（漏清会留下永远指不到实体的幽灵 id，停用/默认徽标跟着脏）。挂在这些 id 上的 `ai_model` / `ai_profile_models` 一起清。catalog 文件可删。不解绑网关、不动密钥。
- **schedules 不置空**（2026-09-20 拍板，改原先「置空」口径）：定时任务的 `profile_id` 是**显式连接声明**，解绑只删绑定行、保留该引用，于是运行时硬 pin 拒绝静默回落（`scheduler` 留一条失败 Run，原因写明配置不存在）。理由：无人确认时替用户换供应商/认证出站，比让任务停下更糟。配套**前端义务**：解绑确认弹窗按 `list_schedules` 现算并列出受影响任务条数与名称，不得只说「其它 Agent 的绑定不受影响」。
- **删除无绑定的网关**：删网关行 + `keys.json` 对应键 + 该网关的 relay 前缀键（尽力而为）+ 该网关 lastProbe。

## 10. 配置页信息架构

主列表按 Agent 分组（启动路径不变）。每行一条绑定：网关名、模型摘要、两个徽标：

- **默认**：启动栏预选（`default_profiles`，值 = binding id）。
- **官方账号模型（v3.186）**：启动不得把中转/国产网关模型名（deepseek / qwen / glm…）注入官方通道。Codex 官方只接受 `gpt-` / `o1`/`o3`/`o4` / 含 `codex` 的模型；否则不传 `-m`，避免 ChatGPT 订阅的 `service_tier=priority` 打到 DeepSeek 上。前端 `officialModelAllowed` 与 `agents.rs official_model_allowed` 双端镜像。
- **全局生效**：上次由 Mesa 写入该 CLI 文件的绑定（`active_global_profiles`）。口径仍是「上次写入」不是绝对生效态；托盘见 §12。

行内：编辑绑定（模型名单 / 默认模型 / extraEnv）· 新对话（跳到新对话页并预选这条连接，用来验证可用性） · 写入 CLI 全局默认 · 停用 · 解绑。每条配置展示一句：网关 · 协议 · 默认模型 · 影响 Mesa 启动预选还是外部 CLI。

操作分口（不得混用「应用到 Agent」）：

| 操作 | 含义 |
|---|---|
| 保存网关 | 保存地址（折进 slots）、凭证、目录和逐模型策略 |
| 为此网关添加连接 | 打开预选好这个网关的「添加连接」弹层，选 Agent、模型、哪个默认；不写 CLI 文件（2026-10-31 起库内不再有单独的「添加 Agent 配置」表单） |
| 设为 Mesa 启动默认 | 只影响 Mesa 新启动时的预选 |
| 设为项目默认 | 只影响当前项目的默认连接；项目里另选的模型也只记在这个项目上，不改连接的模型名单 |
| 写入 CLI 全局默认 | 修改外部 CLI 的配置文件；确认前给出脱敏预览 |

「添加」= 选用已有网关（缺槽则先补）或新建网关再绑定。选用已有网关时从该网关目录勾选启动模型，禁止把整份目录预填进绑定。

**一键接入（2026-09-15）**：预设表升级为 provider 级——`src/presets.ts` `PROVIDER_PRESETS` 一份预设描述该供应商的各协议槽端点 + 推荐模型 + 适用 Agent（`presetsForAgent` 按 Agent 协议槽派生下拉，加供应商 = 加一条）；配套纯逻辑在 `src/preset-flow.ts`（tests/preset-flow.test.ts）。硬规则：

- **推荐模型 ≤3、与实际目录求交后才选中**（`intersectCatalog`：保推荐顺序；交集空不预填；目录有而推荐没有的不自动加——整目录预填红线不变）。用户手改过名单（与推荐清单逐项相同判定）后不再覆盖；名单仍空时默认选目录第一个，**不留空名单**（空名单 = pty 完全不注入的静默陷阱）。推荐模型 ID 允许过时：交集为空只是不自动选，不会配出无效模型。
- **「验证并获取」合并原「测试」/「获取模型」**：force 真实请求一次完成验证 + 拉目录 + 自动选模，不再走缓存与 ↻。选用已有网关的「获取模型」（现拉并写入网关目录）路径不变。
- **表单 Base URL 是便利层，slots 是唯一真相（2026-09-26）**：网关编辑器只暴露一个 Base URL 输入框，`masterUrl` 仅存在于草稿态；**保存时 `effectiveSlotUrl(slots, key, masterUrl)` 把主输入折进五个槽再序列化**（`GatewayLibrary.tsx` save）。读取路径一直用这个函数（探测、拉目录、槽体检、告警都走它），所以只序列化原始 `slots` 会让「只填 Base URL、不展开槽区」的网关存成**五槽全空**：当次探测正常（读路径有 masterUrl 兜底），保存后地址凭空消失，再次打开全是空槽。禁止写回任何 `masterUrl` 字段——后端只有 `slots`。
- **「同时绑到」**：新建网关时勾选额外 Agent，保存走 saveGateway → bindGateway×N（**不走 create_profile**——它一次只建一条绑定且只填一个槽）。槽位由 `gatewayDraftSlots` 拼装：主槽永远 = 表单 Base URL（预设不覆盖用户正在填的地址）；预设定义的其他槽以预设值为准（智谱 responses 专用端点不被同址回落盖掉）；无预设时额外 Agent 的槽回落同一地址（中转同址惯例）。额外绑定的协议由 `extraBindTargets` 推导（复用 `apiKindOf` 同族过滤；多协议 Agent 优先 openai——第三方端点最稳；kimi 官方 kimi 协议只认预设 `protocolByAgent` 显式给）。绑定失败**不回滚网关**，错误文案指路网关库补绑（避免重试再建重复网关）。
- ~~**网关库新建即绑**：新建保存后自动展开 Agent 配置区，在库里直接选 Agent 和模型建绑定~~（2026-10-31 用户拍板推翻，见下条）。仍有效的部分：新建表单可选预设（同址只填主输入、分槽直填并展开槽区；推荐模型仅在目录为空时播种，不动手填内容）；`save_gateway` / `bind_gateway` command 返回保存后的 DTO（store 透传），前端禁止再用「列表末位」猜新建网关。
- **建连接只有一个入口（2026-10-31 用户拍板）**：网关库里原先的「Agent 配置」（名称自动起、不能改，没有模型分工和 Claude 映射表，协议下拉列内部值，默认模型靠勾选顺序）撤掉，改为「用这个网关的连接」：列出已绑连接（点一下打开它的编辑弹层），底下「＋ 为此网关添加连接」打开预选好这个网关的添加连接弹层（`addConnectionDefaults` 的 `presetGatewayId`）；从库里进去的弹层关掉后回到库里这个网关。新建网关保存后自动展开这一块并滚到眼前。离开库前有没保存的修改先问（`confirmDiscard`）。

官方账号收进组头芯片（已安装才显示）：未连接是「登录」钮（终端跑 CLI 登录），已连接是绿点 +「官方」。不占一整行。启动栏里官方也是一条绑定。

网关库（同页工具条，不是新的一级导航）：密钥、五个协议槽、Header、获取模型、按模型展开策略、按槽体检。**2026-10-31 起用全站 `Modal`**：标题在编辑时写「‹ 网关库 / 编辑「名称」」（点 ‹ 回列表），保存 / 取消常驻底栏，Esc 与关闭钮走 `confirmDiscard`，有没保存的修改时点遮罩不关；结果提示固定在内容顶上。表单顺序：服务商（新建，下拉显示选中项）→ 名称 → 地址 → 无密钥 → 密钥（勾了无密钥就收起）→ 测试 / 获取模型（先填密钥再测，免得先测出 401）→ 协议槽（测试钮与输入框同一行，「测试全部槽」汇总成一条）→ Header 与兼容选项 → 用这个网关的连接 → 模型。模型区可手填模型（`manualModelError` 校验；拉不到 `/models` 的端点靠它）、移除模型（失效的常驻「移除」）、行上标「已设参数」、可「只看设了参数的」；目录 ≤20 个时不折叠厂商组。能力声明单独成块并标「单独保存 · 对所有 Agent 生效」，没点保存的能力声明草稿也算没保存的修改。列表行带状态点（`gatewayHealth`：缺密钥 > 测试失败 > 测试通过 > 未测，只读已存结果）与「测试」。失败文案统一补下一步（`connection-form.ts probeHint`，与添加连接、上手向导同一份）。草稿探测不写 lastProbe，也不落密钥。

**2026-10-31 简洁化（用户：更美观更简洁）**：网关库列表每个网关一张可点行卡（点了就是编辑，禁 divide-y），状态只是名字旁一个点（`gatewayHealth` 按**最近一次**测试算，通过 / 未测不写字，失败 / 缺密钥才写），第二行只写地址（同址补密钥尾号）· 几个连接 · 近 30 天花费，协议与模型数进悬停；测试 / 重新获取模型 / 删除是 `hoverRevealClass` 的 `RowAction` 图标。添加连接：Agent 与账号类型一行，「网关」标题与「新建 / 选用已有」一行，「最多 N 个模型」只在到上限时出现，空名单提醒只在有目录可选时出现，「同时绑到」改名「顺便给这几家也建一条」、只列协议兼容的几家做成点选胶囊（不兼容的原因进标题悬停）。

**添加连接（2026-10-31 再一轮，用户截图）**：选用已有网关时选中即收起列表（`gwListOpen`，只留选中行 +「更换」），网关行第二行用 `gatewayHostLine`（主机 · 同址密钥尾号）· 可用模型数，协议进悬停；模型面板改厂商胶囊（常用 / 全部 / 各厂商，`pickerVendor` 空 = 自动：常用 > 第一个已选模型那家 > 全部），平铺列表，有筛选词时在全部模型里找；**填过内容（`touched`：表单相对打开时的快照变了〔协议不算，会被自动推导改写〕、换了网关、选了顺便建的 Agent）时点遮罩不关，Esc / 关闭 / 取消走 `guardedClose` 先确认**，同网关库口径。

**添加连接弹层（2026-10-31 审查后）**：保存前缺什么（`saveBlocker`：先选网关 / 先填地址 / 先起名字 / 选中网关缺协议地址）写在底栏按钮左边常驻，保存失败也写在那里；「同时绑到」部分失败后按钮变「补绑剩下的」（记住已建网关与已成功的几家，再点只补剩下的，不重复建网关）；选用已有网关时缺这家协议地址的网关灰掉（`gatewayMissingSlot`），选中默认带目录第一个能对话的模型，空名单提醒；服务商下拉显示选中项，换 Agent 清掉预设地址；Qwen / Kimi 新建网关时「接口协议」放在地址上面，协议值显示「Anthropic 兼容 / OpenAI 兼容 / Kimi 官方协议」；目录面板最前一组「常用」（服务商推荐 + 别的连接在用的），点一下加入、再点去掉，分组 ≤3 时全展开；名单行「设为默认」；高级设置分「跟着网关走」「只对这条连接」两节，策略标签用中文。

## 11. 启动注入

启动栏：Agent → 绑定（网关名 / 官方账号）→ 模型（绑定名单）。

拉起那一刻按当时选中模型求交后注入。`launch_plan` 入参改为 `Binding + selected_model + Gateway`。预览仍脱敏。

需要「启动时把名单注册进选择器」的 CLI（Claude 最多 5 槽、Codex catalog、OpenCode models、Grok `allowed_models`）：写入绑定的整份名单。Codex catalog 路径仍 `codex-<binding_id>.json`（§3）。

Grok 还须同时写 `[models].default` = 本次启动模型（2026-09-20 1.0.34 实机复现）：grok 开会话前先拿 config.toml 的 `[models].default` 比对注入的 `allowed_models`，不匹配直接拒启动（`"<id>" (your default) isn't allowed by allowed_models …`），而 `GROK_DEFAULT_MODEL` 只是「偏好」、在这道门之后才生效，救不回被拒的启动。全局默认很可能是别家绑定「设为全局默认」留下的模型，故 overlay 白名单放行 `default`（实证）时必须写。详见 matrix §9「注入 env」行。

`launch_plan` 把空串/纯空白模型归一成「未选模型」（前端 `buildAskAiPending` 会带空串占位防被启动栏上次模型顶掉）：不归一会让 grok 的绑定清单兜底与各处 `filter` 全部失效，并把空模型写进 `GROK_DEFAULT_MODEL` / `allowed_models` / `[models].default`。

官方绑定：不注 API、`env_remove` 残留密钥变量（现口径）。`extraEnv` 仍最后注入。

**别家留下的连接键（2026-10-28，对照 cc-switch「关键字段」口径，假网关实测）**：「连接键」= 请求发到哪、凭什么鉴权、用哪个模型、走哪种协议。Claude 是全部 `ANTHROPIC_*`、`CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,GATEWAY,MANTLE,ANTHROPIC_AWS,ANTHROPIC_GOOGLE_CLOUD}`、`CLAUDE_CODE_OAUTH_*`（`agents::claude_connection_env_key`）与顶层 `apiKeyHelper` / `fallbackModel`；CodeBuddy 是 `CODEBUDDY_{BASE_URL,API_KEY,AUTH_TOKEN,MODEL,CUSTOM_HEADERS}`。
- **在 Mesa 里用 API 连接启动**：磁盘 settings.json 的 env 盖过进程 env，别家的键会跟着这次连接一起发出（实测：别家 `ANTHROPIC_API_KEY` 作 x-api-key、别家请求头原样发到 Mesa 的网关；`CLAUDE_CODE_USE_BEDROCK=1` 时请求不去网关；`apiKeyHelper` 的输出也作 x-api-key 发出；CodeBuddy 磁盘的地址和密钥压过 Mesa 注入的，请求整个去了磁盘那家）。`finalize_settings_overlay` 在启动计划最后补进 `--settings`：Claude 在已有 0600 覆盖文件里给用户设过、覆盖层没写的连接键填进程 env 里的值（如请求头）或空串，顶层两键写空；CodeBuddy 新建 0600 覆盖文件，五个连接键一律写（没有的写空串）。AWS / Vertex 区域不写空（协议开关空了它们不起作用，可能是给 Claude 里跑的命令用的）。这两家因此不再出「磁盘残留会盖过本次注入」的启动提醒。
- **设为全局（API）**：Claude 写完 Mesa 自己的键后，撤掉 env 里其余连接键与顶层 `apiKeyHelper`；`CLAUDE_CODE_OAUTH_*` 不动（官方账号的长期登录令牌，API 令牌在时它不起作用）。CodeBuddy 撤 `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_CUSTOM_HEADERS`。官方「设为全局」同样撤其余连接键与 `apiKeyHelper`。

**共用环境变量（2026-10-28 用户要求补齐，对照 cc-switch 的「通用配置」）**：设置 `shared_env`（设置 → AI 与 Agent → 共用环境变量），`agents::shared_env` 在 `launch_plan` 两条路径（API / 官方）都于连接 `extra_env` 之前注入，连接同名键覆盖。只放与连接无关的设置；`settings::shared_env_rejection` 拒收像密钥（KEY / TOKEN / SECRET / PASSWORD / AUTH / COOKIE / CREDENTIAL / _PAT）、地址与模型（`*_BASE_URL` / `*_MODEL` / `*_ENDPOINT`）、代理（归出网代理）、终端与路径（PATH / HOME / TERM…）——设置文件不是 0600 密钥库；保存时拒、读时再滤一遍。只作用于 Mesa 启动，不写进「设为全局」。

**网关兼容选项（2026-10-28 用户要求补齐，参照 cc-switch 预设的「供应商独有字段」）**：`Gateway.compat`（`GatewayCompat`：`timeout_secs` / `no_experimental_betas` / `no_thinking`），materialize 带进 `RequestPolicy.compat`；网关编辑表单「Header 与兼容选项」里改，`GatewayInput.compat` 为 None 时不改（别处的保存不能把它清掉）；进内容指纹与导入导出。只收二进制实证存在的键（Claude 2.1.308、Codex 0.164）：Claude `API_TIMEOUT_MS` / `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` / `CLAUDE_CODE_DISABLE_THINKING`（`agents::claude_compat_env`），Codex 渠道 `stream_idle_timeout_ms`。启动：Claude 写进 `--settings` 覆盖层（磁盘 env 盖过进程 env），没开而磁盘留着上一家开关的写空串；Codex `-c model_providers.<pid>.stream_idle_timeout_ms`。设为全局：Claude 开的写、没开的两个开关撤掉、超时没设不动（可能是用户自己的全局偏好）；Codex 共用渠道块整块重建，开了才写。

**Codex 的另外几处模型与网页搜索（2026-10-28）**：`review_model`、`agents.default_subagent_model`、`memories.extract_model` / `consolidation_model` 另外点名模型（`agents::CODEX_SIDE_MODEL_KEYS`，0.164 都认 `-c`，隔离 CODEX_HOME 的 `config/read` 核对）。走中转启动时磁盘设过的经 `-c` 改成这次的模型（`codex_relay_model_args`，没设的不加，让 Codex 自己继承）；API 设为全局同样把设过的改成这次的模型，并写 `web_search = "disabled"`（与启动的 `codex_relay_compat_args` 同口径——之前只在启动里关，外部 Codex 走中转仍带网页搜索被拒）。官方设为全局撤 `openai_base_url`（会把内置 openai 改道）、值为 `disabled` 的 `web_search`，以及上面几处里不是官方模型的。

**Grok 标题 / 提示用的模型（2026-10-28）**：`[models].session_summary` / `prompt_suggestion` 没设时 Grok 用内置 grok-* 却发到默认模型的地址（中转不认，标题生成失败），设着的常是上一家的模型。API 设为全局（地址不是 x.ai 时）与启动覆盖层同口径：钉成连接「模型分工」的后台小模型，没指定用主模型。官方设为全局撤掉这两项里不是 grok 模型的。

**官方账号在 Mesa 里启动：进程级盖过磁盘残留，盖不过才拦（2026-10-28，取代「磁盘有残留一律拒绝启动」）**：用户问在 Mesa 里能不能直接用官方账号。各家实测（隔离 HOME + 假网关 + 死代理挡真网络，只看请求是否还去中转）：
- Claude Code / CodeBuddy：settings.json env 盖过进程 env，`env_remove` 管不到；`--settings` **内联** JSON 把端点 / 密钥键写成空串即等于没设，回到 CLI 自己的登录（Claude 2.1.308、CodeBuddy 2.177.0 实证）。Claude 一律写空 `ANTHROPIC_BASE_URL` / `_AUTH_TOKEN` / `_API_KEY`，用户全局设过的模型槽 / 子 agent / 上下文键也写空，选了模型时 `ANTHROPIC_MODEL` 写这次的模型（`official_settings_blanks`）。覆盖层不含密钥，故内联不落盘，聊天层 hooks 照常并进。
- Qwen：`--auth-type qwen-oauth`（命令行参数优先级最高，磁盘 .env / settings 的密钥不再起作用；0.x 实证，并提示 OAuth 免费额度已停）。
- Codex：沿用 `-c model_provider="openai"`。
- Kimi：没选模型时 `-m` 用 config.toml 里 `managed:kimi-code` 的模型（`kimi_official_alias`，当前默认是官方的就用它）；一个都没有 = 没 `kimi login`，拦。
- Grok（2026-10-28 用户登录后实测）：config.toml 的 `[models].default` / `session_summary` / `prompt_suggestion` 常是中转留下的，甚至有借官方名字（`[model."grok-4.5"]`）转去中转的段。官方启动经 GROK_CONFIG 覆盖层把三项钉成这次的官方模型（没选用 `grok models` 的默认），借名段从官方名单剔掉（`grok_relay_model_sections`）。名单缓存 `official-models/grok.json`：查登录状态时（auth.json 在）带出网代理跑 `grok models`，6 小时一次。实测 `grok -p` 带覆盖层回复正常。能定出官方模型时磁盘默认是中转模型也不拦。
- Gemini 个人 Google 账号（2026-10-28 实测）：登录成功、凭证文件在，但请求报 `IneligibleTierError: … no longer supported for Gemini Code Assist for individuals`（Google 改推 Antigravity），Workspace / 企业版 Code Assist 不在此列。凭证文件看不出账号类型，故不拦：已连接详情接一句提醒（`official_connected_caveat`），后台报错映射成中文（`ai::summarize_headless_error`）。
- Gemini：认证方式只认 settings 的 selectedType，系统设置层要 root 才生效，进程级盖不过——selectedType 不是 `oauth-personal` 就拦；没设时照旧按 .env 探测。Grok：config.toml 顶层 `api_key` 进程级盖不过，照旧按探测拦。
- **中转留下的模型名**（2026-10-28 逐家补）：Claude 顶层 `model`（不在 env 里）是中转模型且这次没选模型时，覆盖层写 `"model": ""`（= CLI 默认；`null` 不顶用，2.1.308 实测），选了模型走 `--model`；官方「设为全局」同样撤顶层中转 `model`。Gemini 进程里写空 `GEMINI_MODEL` 压不住 `.env`（0.65 实测），`.env` 里是中转模型名就拦。Grok `[models].default` 不是 grok 模型就拦。Qwen 自己会回落 coder-model（实测提示）。CodeBuddy 顶层 `model` 无从判断是不是官方可用（没有可查的官方名单），不动。
拦下的文案改指「在官方账号那行点地球图标切回官方」。前端冲突弹层按 `MESA_OVERRIDES_OFFICIAL`（与 `official_launch_conflicts` 放行的三家一致）区分「只影响外部」与「Mesa 里也拦」。

**官方账号的模型名单（2026-10-28）**：官方账号连接没在 Mesa 里列模型时，`materialize` 用 `agents::official_models_for` 补上——目前只有 Codex：读 `models_cache.json`（Codex 自己从 ChatGPT 后端拉的目录）里 `visibility = "list"` 的，按 priority 排（与 app-server `model/list` 结果一致，同日真账号核对）。Codex 官方启动没选到模型（或选的中转模型被 `official_model_allowed` 滤掉）时 `-m` 取名单第一个，不让磁盘 config.toml 里中转留下的 `model` 顶上（否则 ChatGPT 账号 400「model is not supported」）。名单是派生的，不写回绑定。其余来源：Kimi = config.toml 里 `managed:kimi-code` 的模型（默认排第一）；Cursor / Grok = `cursor-agent models` / `grok models`（要联网，查登录状态时顺手拉，缓存 `official-models/<agent>.json`，6 小时内不重拉；连接列表只读缓存，Grok 启动时缓存空才当场问，`official_models_for_launch`）；没有本地名单的三家用 CLI 认的固定别名，第一个是 CLI 自己的默认：Claude `default / opus / sonnet / haiku`（假网关实测解析成 claude-opus-5-5 等，default = 不传时）、Gemini `auto / pro / flash / flash-lite`（0.65 bundle 的别名常量）、Qwen OAuth `coder-model`。CodeBuddy 没有可靠来源，不列，界面写「CLI 默认模型」。

**重启 Codex 客户端（2026-10-28）**：一键切换 Codex 后，装了客户端时提示条加「重启 Codex 客户端」，确认后调 `client_open::client_restart`：macOS 按 bundle id `tell application id … to quit`（走客户端自己的退出确认，不强杀），最多等 20 秒退干净再 `open -b`；Windows 正常退出的进程 / 包名没在真机核实，如实报错让人手动重开，不猜进程名强杀。

**官方账号行「测试」（2026-10-28）**：状态列后端对官方账号恒给「官方账号」，测过以后以这次结果为准（同日用户实测：结果被固定文字盖住，只看到「测试中」）。官方账号没有网关可测，已登录时行上给「测试」，点了经 `ai_prompt`（无头一次性调用，走 CLI 自己的登录）发一句固定话，回复即通过；会用一点官方额度，不自动跑。2026-10-28 本机逐家实跑查出并修掉：Claude 未登录时报错是整段 JSON（`summarize_headless_error` 改为认「Not logged in / Please run /login / Authentication required」并取 JSON 的 `result`）；Cursor 在没信任过的目录 `-p` 直接退出要人选（一次性调用跑在 Mesa 自建的临时目录，`headless_oneshot_args` 给 Cursor 加 `--trust`，实测回复正常）；Grok 官方名单没缓存过时启动被拦（`official_models_for("grok")` 缓存空时当场问一次）。注意 `cfg(test)` 下官方名单、Gemini 认证方式等走测试桩，拿单测跑真 CLI 的结论不可信，要用 dev 窗口或直接跑 CLI 核对。

**Claude / Cursor 官方登录检测（2026-10-28）**：macOS 凭证在钥匙串、不落文件，只看文件会把已登录显示成未登录（用户以为要重登）。文件查不到时问 CLI：Claude `claude auth status --json`（`loggedIn` / `authMethod`，说未登录时详情直说「已过期或已登出」；**全局 settings.json 的 env 或进程环境里有 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 时它会把中转令牌当登录说「已登录」（authMethod=oauth_token），官方启动时这些键被盖空、实际是未登录（2026-10-29 实证）——这种情形换空令牌环境重问：令牌类变量置空，macOS 再把 HOME 指到空临时目录（钥匙串与 HOME 无关）**），Cursor `cursor-agent status`（含「Logged in」）；`official_account_status` 因此改 async + spawn_blocking。

**官方账号一键添加与图标（2026-10-28）**：组头在「这家支持官方账号、已安装、还没有官方账号连接」时给 **＋ 官方账号**，直接 `create_profile`（名字后端固定「官方账号」）。官方账号行按 Agent 配厂商图标 `vendorForOfficialAgent`（claude-code→anthropic、codex→openai、gemini→gemini、qwen→alibaba、kimi、codebuddy→tencent、grok→xai；Cursor 无图标首字占位）；新增 Gemini 图标（lobe-icons 经 cc-switch，同时认 `generativelanguage.googleapis.com`）。

**Codex 官方绑定额外注入** `-c model_provider="openai"`：磁盘 `config.toml` 的 `model_provider` 指向自定义网关时会盖过 ChatGPT 登录（选官方账号仍走网关计费）。`-c` 优先级最高，只影响本进程，不改用户文件、不写 `[model_providers.*]`。登录走 `codex login --device-auth`（设备码印在内嵌终端；不在 Mesa 内自建 OAuth）。未选模型时磁盘 `model` 仍会生效。`chatgpt.com` 401 / `token_revoked` 是 ChatGPT 登录态本身失效，不是官方/API 凭证串台。

**Codex 恢复不得串台（v3.223）**：rollout 的 `model_provider` 分三条——`ccode`/`ccode-<短id>` = Mesa 网关；`openai` = ChatGPT 官方；其他名字（磁盘 `custom` 等）= 客户端/全局配置渠道。自动恢复时客户端渠道只挑带 Base URL 的网关，绝不落到官方账号（否则强制 `api.openai.com` 且 `env_remove` 密钥，报 401 Missing bearer，同一会话在客户端却能继续）。官方未登录时 `openai` 会话也改挑网关；启动栏未登录的官方账号不自动预选，硬启动先确认。纯逻辑 `src/resume-profile.ts`。

**无头调用（雷达解读 / 提交信息等）** 的「最近使用」回落跳过官方账号：OAuth 过期会把 CLI stderr 甩到界面。有 API 配置就走 API；只有官方才回落官方。显式 id、功能专属、AI 专用仍尊重官方。失败文案走 `summarize_headless_error`，不回整段日志。终端里手选「官方账号」不受这条约束。

**Grok 网关绑定加 `--disable-web-search`（2026-10-21）**：Grok 内置 web_search 是 xAI 服务端搜索、拿 `XAI_API_KEY` 去 xAI 鉴权，网关钥匙 401；API 连接且地址不是 `*.x.ai` 时摘掉（官方地址与官方账号不动）。

**Codex 网关绑定额外注入** `-c web_search="disabled"` 与 `-c service_tier="auto"`：ChatGPT 登录/磁盘默认会把官方 hosted 网页搜索和订阅优先档带进本进程；catalog 的 `supports_search_tool: false` 挡不住请求。DeepSeek 等中转会拒 `web_search`（有的网关转成 Anthropic `web_search_20250305`）。只盖本进程，官方账号启动不注。**按 codex 版本分（2026-10-19，本机 0.163 实测）**：0.163 起 CLI 自己丢掉模型目录 / 兜底元数据没声明的档位（配置里的 priority 不会带到中转），再塞 `service_tier="auto"` 只会每次报「not advertised」warning，故只给旧版与查不到版本时塞；交互式启动（内嵌 / 外部终端，经 `prepare_launch`）在 0.163 起加 `--no-daemon`——Mesa 一律 -c 注入，只能不走共享后台服务，明说才不报「Running without the shared background server」。**`exec` 不认 `--no-daemon`，不得加进 `launch_plan`**（无头调用共用）。版本取检测缓存，缺了现查 `--version`；查不到按旧版参数，保证起得来。

**Codex 交互式启动关掉它自己的更新提示（2026-10-29 用户拍板）**：`prepare_launch` 对所有版本、官方与网关都加 `-c check_for_update_on_startup=false`。
Codex 的「Update available」在对话中途跑 `brew upgrade` / npm 更新、跑完就退出；打包版 v0.1.0 子进程 PATH 短，点了直接报 `os error 2` 退出码 1。
CLI 更新统一走连接页组头「新版 / 更新」（`updater.rs`，brew 装的走 `brew upgrade`、npm 装的用同目录 npm）。只加在本次命令行，不写 `config.toml`；
`exec` 本来不检查更新，不进 `launch_plan`。**聊天层旁路下这个 `-c` 必须留给 TUI**（`chat_channel::split_codex_args` 的 TUI 配置键表）：远程 TUI 按本地配置弹提示，
只给 app-server 关不掉。本机 0.143 / 0.165 PTY 实测（含 `--remote` 新开与恢复）。
**思考档 `model_reasoning_effort` 两边都给**（同函数的两边配置键表，2026-10-30）：只给 app-server 时回合照样按注入档跑（rollout `turn_context` 记的就是它），
但远程 TUI 底栏画「<模型> default」，读屏优先的 `currentEffort` 把聊天芯片显示成「默认」。以后新增「会画在 TUI 上」的注入配置同样两边给。

**其余家只关会弹进对话的更新（2026-10-29 用户拍板）**：Qwen 启动 3 秒后查更新，brew 装的在对话里冒「update available … brew upgrade」，
npm 装的后台更新后要求退出重启——`launch_plan_with_prompt`（内嵌 / 外部终端的交互启动都经它）注入 `QWEN_CODE_SKIP_UPDATE_CHECK_ONCE=true`
（`agents::update_prompt_off_env`；它自我重启用的内部开关，不在官方文档，升级适配时核对；0.26.1 本机 PTY 实测不设出提示、设了不出）。
**后台静默更新、不打断对话的保持原样**：Claude Code / CodeBuddy（`DISABLE_AUTOUPDATER`）、Kimi（`KIMI_CODE_NO_AUTO_UPDATE`）、
Grok（`GROK_DISABLE_AUTOUPDATER`）、Cursor（隐藏参数 `--disable-auto-update`）都有开关但不设；Gemini 只有设置文件开关（系统层要 root），本来也关不了。
OpenCode 的 `OPENCODE_DISABLE_AUTOUPDATE` 是另一条理由（启动时换掉检测到的二进制），照旧。

**出网代理**（设置 `outbound_proxy`）：只注入官方启动与组头登录（`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY`）。网关 API 启动不走。连接 `extraEnv` 同名键最后覆盖。不建本地反代理，官方失败不回落中转。

## 12. 设为全局与托盘

**设为全局写入规则（2026-10-30 用户拍板「全部都修复」，九家对照官方文档 / 源码 / 实测审计后定）**——改任何一家的写计划前逐条对照：
1. **写到 CLI 实际读的目录**：目标路径一律 `cli_dir`（= `agent_specs::agent_config_root_with`，认搬迁变量），与 MCP、技能同一个函数。
2. **与启动注入同源**：能写进配置文件的必须写，写法尽量复用启动那一份（Claude 的 `claude_model_env`、OpenCode 的 `opencode_provider_json`）；写不了的在预览 `skippedPolicies` 逐项说明。通道表 `request_policy_support` 的 `persist` 格子与写盘函数由 `policy_channel_table_agrees_with_patch_functions` 互锁。
3. **只管自己写的键，写之前先清干净**：这条连接没有的值一律撤（地址、模型、输出上限、上一份更长名单的槽位、上几次留下的 Mesa 渠道），值认得出是 Mesa 写的才撤（`MAX_THINKING_TOKENS=0` 一类），用户自己的键与条目不动。Mesa 写的条目要有可认的标记（名字「配置名 · 模型」、`ccode*` 渠道名、`${CODEBUDDY_API_KEY}` 引用）。
4. **写之前说清会被什么盖掉**：预览与一键结果带 `overrideNotes`（见下「写之前说清会被什么盖掉」）。
5. **用户能改的写在用户层**：不用最高优先级的 env 压住用户在外面 `/model`、`/effort` 的选择（Claude 写顶层 `model` / `effortLevel`）。
6. **官方切回只撤 Mesa 写过的**：不写死某种登录方式（Gemini 不写 `oauth-personal`、Qwen 不写已停用的 `qwen-oauth`），不删用户自带密钥的配置段。
7. **被全局配置引用的文件不随连接删除**（Codex 模型目录，`profiles::codex_config_references`）。
8. **密钥能引用就不写明文**：OpenCode `{file:}`、CodeBuddy `models.json` 的 `${CODEBUDDY_API_KEY}`、Codex 续聊补的 `ccode-<短id>` 渠道 `auth.command`（`mesa_helper codex-token`）、请求头只写变量名引用（Codex `env_http_headers` / OpenCode `{env:}` / Grok `$VAR`），只认明文的家不写请求头。
9. **CLI 升级后自动复核**：CLI 金丝雀「全局配置」层（`global_phase` + `e2e_write_global_config`）用真写计划写进临时 HOME、不经 Mesa 起 CLI，核对请求的模型与密钥；新写法上线前同样先用真 CLI + 假网关跑一遍（本条起，静态审查代替不了，见 AGENTS「动真实数据先干跑」）。

「写入 CLI 全局默认」是绑定上的动作（一键入口不预览，见下「一键设为全局」），复用现事务写入 / 备份 / 原始快照 / 复检弹层。确认前 `preview_profile_global` 给出脱敏变更预览（文件、字段增删改、此入口带不上的策略、已开进程需新开）。成功更新「外部 CLI 上次写入」追踪，**不**改 Mesa 启动默认，也不改项目默认。无密钥网关仍禁止（`plan_writes` 现拒绝 `noAuth`，保持）。

**写到 CLI 实际读的目录（2026-10-30）**：目标文件一律经 `global_config::cli_dir` = `agent_specs::agent_config_root_with` 解析，认各家搬迁变量（`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_CLI_HOME`〔顶替家目录〕/ `QWEN_HOME` / `XDG_CONFIG_HOME` / `KIMI_CODE_HOME` / `KIMI_SHARE_DIR` / `CODEBUDDY_CONFIG_DIR` / `GROK_HOME`），与 MCP、技能同一个函数，禁再写 `home.join(".xxx/…")`。登录 shell 导入放行这些变量（environment.md 同名条）。测试态 `relocation_env` 不读环境，防写到本机真实目录。

**设为全局挡路（v3.252 / v3.253）**：本机有 `~/.cc-switch` 时，所有支持「设为全局」的 Agent 连接页二次确认（默认焦点在取消）；托盘一点不写盘，转连接页确认（见下「托盘挡路转交」）。Codex 另认 live `config.toml` 的 cc-switch catalog / `custom` 渠道（即使卸了 cc-switch）。不挡 Codex「注册到客户端」。官方账号「设为全局」也要改 CLI 配置，与 API 绑定同样挡（连接页与托盘同口径）。

**托盘挡路转交（2026-10-23 用户拍板）**：原「托盘一点只发系统通知」作废——通知没授权 / 被专注模式吞掉时点了等于没反应。现口径：
- 挡路判定在**点击时**现算（`set_global_conflict_message`），建菜单时同口径决定首行；
- 挡路时该 Agent 子菜单**首行可点**：装着 cc-switch 写「本机装了 cc-switch · 在 Mesa 里设为全局…」，只有 Codex live 痕迹写「config.toml 里有 cc-switch 的渠道 · …」；点首行 = 打开主窗口跳连接页；
- 点 api 绑定 = 不写盘，打开主窗口、跳连接页、弹**该绑定**的设为全局确认（与连接页同一个 `onApplyGlobal` 预览 + 挡路说明，默认焦点在取消）；事件 `tray:set-global {agent, profileId|null}` → store `trayGlobalReq`（连接未加载完等下一轮）；重绘撤回 macOS 点击自带的勾选翻转；
- 每次被挡记一条 `logbuf`（source `tray`，info），设置 → 诊断可查；
- 托盘绝不替人过二次确认，也不因挡路把该 Agent 藏掉或整组置灰。

**Codex 全局渠道共用 `custom`（2026-10-28 用户拍板，与 cc-switch 同名）**：「设为全局」不再按网关写 `ccode-<短id>`，一律写 `[model_providers.custom]` 并 `model_provider = "custom"`（`CODEX_GLOBAL_PROVIDER`），整块替换（上一家留下的 `requires_openai_auth` / `supports_websockets` / `env_key` 等残键不带过来）。理由：客户端侧栏只列启动时默认渠道下的对话（matrix §1 实测），每个网关一个名字会让切换后其余连接的对话全藏起来；用 cc-switch 的同名，两边的对话归在一处。**官方账号不进 `custom`**（同日用户实测否决「官方也写进 custom」）：同一渠道名下的老对话会被接到新连接上，中转跑过的对话接到官方时，历史里中转留下的条目官方接口不收（客户端报 `input[n].content: array too long`，整段续不上）；中转之间互切没见到这类问题。Mesa 自己启动用的 `-c` 内联 `ccode-<短id>` 不变（恢复会话靠它认网关），客户端接力补写的 `ccode-<短id>` 定义块不动，只删旧 `ccode` 块。cc-switch 痕迹判定（`codex_other_switcher_marks`）随之改：`custom` 块 `name = "Mesa"`（Mesa 写的）或 ChatGPT 登录形态不算别家；别的名字、cc-switch 模型目录、指着 `custom` 却没定义块才算。

**Codex 客户端续聊：切全局只动默认，老对话要用的只加不删（2026-10-31 用户拍板，`codex_continuity.rs`）**：Codex 的对话在开对话时定死渠道，渠道定义与模型目录却是全局的，切全局拿掉老对话要用的东西，客户端就报 `Model provider ... not found` / `This model isn't available`（用户两张截图）。规则：
- **渠道定义只加不删**：设为全局（中转与官方都算）时，对话表（只读 `state_<N>.sqlite`，不含归档）里出现过、Mesa 认得出网关的 `ccode-<短id>` 一并补定义块，与启动内联同形，认证写 `[model_providers.<名>.auth] command = <配置根>/bin/mesa_helper, args = ["codex-token", <网关 id>]`——helper 现取 keys.json（只读文件，不碰钥匙串），config.toml 不落明文；Mesa 以前写的明文块（`name = "Mesa"` + `experimental_bearer_token`）顺带改成这样；用户自己写的同名块、认不出网关的（连接已删、旧版 `ccode`）不碰。客户端接力「写入并打开」同样写 auth 形态（找不到随包 helper 才退回明文）。共用渠道 `custom` 仍写 `experimental_bearer_token`（金丝雀「全局配置」层按它核对，改形态另议）。
- **auth 与 env_key / bearer 不能并存**（0.166 实测：`provider auth cannot be combined with env_key`，整份 config 加载失败）：Mesa 启动与复制的恢复命令见到磁盘该渠道有 `auth` 就不注 `env_key`（`agents::codex_disk_provider_has_auth`），认证交给那条命令，取的是同一把密钥。命令坏了（Mesa 卸了）只坏那一个渠道，不影响配置加载（同日实测）。
- **模型目录只追加**：设为全局写 Mesa 专用的 `<配置根>/catalogs/codex-global.json`（不再指每连接那份——启动会按绑定重写它）。中转默认：当前连接的模型在前，再接老对话用过、渠道有定义的模型；有官方老对话且 ChatGPT 登录着，官方模型整组带上（照抄 `models_cache.json` 里 visibility = list 的条目，显示名前缀「ChatGPT · 」；codex 认原样条目，`codex debug models` 核过）。官方默认：没有中转老对话就撤掉 Mesa 目录、回落 Codex 自己的模型表；有就写「官方模型 + 中转老对话的模型」。同一个模型名在几条连接的老对话里都有，显示名写「老对话 · 模型」不挂某条连接。上限 60 条。
- **只进预览与写入，不进漂移比对**：对话表天天在变，进比对会误报「外部改过」；续聊层只加渠道块（config.toml 子集比对照样成立）、目录只在尾部追加——漂移比对的数组是整组比的，所以基础计划生成目录时，磁盘上的目录以这次的条目开头就当作 Mesa 写的样子（`codex_catalog_as_written`；没有这条，追加后一直报「外部改过」，「按 Mesa 重写」也消不掉）。官方基础计划留着指向 `codex-global.json` 的引用（由续聊层决定撤不撤），整份比对才不误报。
- **体检与补齐**：连接页 Codex 一栏按对话数提示「N 条对话接不上（缺渠道定义 / 模型不在目录里）」与「N 个渠道存着明文密钥」，点「补齐」只加渠道定义、重建目录，不动默认渠道与模型，走同一套备份可「撤销上次写入」。新连接开出的对话不会自动补——写 CLI 配置只在用户点了以后。
- **启动刷新**：config.toml 正指着 `codex-global.json` 时，Mesa 启动按当前官方模型表重建这个文件（只动 Mesa 自己的文件），顺带把 helper 拷贝换成这一版。测试态目录在临时目录（`agents::catalogs_dir`），写计划的测试不得写进用户的 catalogs/。

**Codex 全局写入与启动同口径的几项（2026-10-30）**：`patch_codex_relay_extras` 在共用渠道之外再写——顶层 `model_context_window` / `model_auto_compact_token_limit` 按确知窗口改写（压缩点 95%），不知道就撤（上一家的旧窗口会盖过模型目录）；`[plugins."codex-app-tools@openai-bundled"] enabled = false`（同启动 `codex_relay_compat_args`，防失效登录态 401）；自定义请求头写成 `custom` 块的 `env_http_headers`（变量名引用，不落密文）。官方切回撤掉关掉的插件与两项窗口。**删除连接时**，外部 config.toml 的 `model_catalog_json` 还指着这条连接的模型目录就不删那个文件（删了外部 codex 直接起不来，隔离 `CODEX_HOME` 实测）。

**Qwen / Gemini 全局写入补的落盘通道（2026-10-30）**：通道表 `request_policy_support` 改 `persist`——Qwen 思考档写条目级 `samplingParams.reasoning_effort`、模型条目 `envKey` 用 Mesa 专用 `MESA_QWEN_API_KEY`（防项目 `.env` 的 `OPENAI_API_KEY` 顶掉）、确知窗口写 `generationConfig.contextWindowSize`；Gemini 温度 / top_p / 输出上限写 `modelConfigs.customOverrides`（只管 `match` 恰为 `{model: 本连接模型}` 的条目，先撤再写）并另写 `model.name`（`.env` 常因目录信任 / 项目 `.env` 读不到）。改通道表必须同改写盘函数：`policy_channel_table_agrees_with_patch_functions` 会拦。

**Claude Code / CodeBuddy 全局写入（2026-10-30）**：Claude「谁用哪个模型」整套走 `agents::claude_model_env`（与 `--settings` 覆盖层同一份：四槽缺的用主模型补、后台小模型、子 Agent、确知不思考的 `MAX_THINKING_TOKENS=0`、非 Claude 模型的 ToolSearch / 任务清单开关），**主模型写顶层 `model`、思考档写顶层 `effortLevel`**（`max` 只能走 env），不写 `ANTHROPIC_MODEL` / `CLAUDE_CODE_EFFORT_LEVEL`——env 两项优先级最高，会把用户在外面 `/model`、`/effort` 的选择改回来。这条连接没有的值一律撤（地址、顶层 `fallbackModel` / `apiKeyHelper`、上一份更长名单的槽位与 `_DESCRIPTION`；Mesa 写过、值认得出来的 `MAX_THINKING_TOKENS=0` / `ENABLE_TOOL_SEARCH=false` / `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 先撤再按这次重算）。CodeBuddy 同样「没有就撤」（地址 / 模型 / `CODEBUDDY_CODE_MAX_OUTPUT_TOKENS`），模型名单写 `models.json`（每模型一条，`apiKey` 写 `${CODEBUDDY_API_KEY}` 引用不重复存明文，Mesa 条目认「配置名 · 模型」名字，用户条目与 `availableModels` 不动）；官方切回撤 Mesa 条目与非官方顶层 `model`。

**OpenCode / Kimi 全局写入（2026-10-30）**：OpenCode 密钥落 Mesa 自己的 0600 文件（`<配置目录>/ccode/secrets/opencode-<渠道>.key`，与配置同一批事务写），`opencode.json` 里写 `{file:<路径>}` 引用；预览 / 漂移明细对 `.key` 文件只报「已脱敏 · N 字」。有 `opencode.jsonc` 就写它（全局目录 config.json → opencode.json → opencode.jsonc 依次合并、后者盖前者；注释剥掉写回严格 JSON），否则写 `opencode.json`。别的 Mesa 渠道（`ccode*`）按「老对话要用的只加不删」（2026-10-31）：密钥是 `{file:}` 引用且文件还在的留着；认得出网关的（对话库 `opencode.db` 里出现过、或磁盘已有）由 `extend_opencode_plans` 按 `{file:}` 重写，老对话用过的模型补进它的 `models`；明文密钥且认不出网关的、引用的文件已不在的撤掉——**`{file:}` 指向不存在的文件整份配置加载失败**（1.19.5 实测 `bad file reference … does not exist`），所以删连接不得顺手删这些 `.key` 文件，`small_model` 跟连接「模型分工」，这次没有就撤还指着 Mesa 旧渠道的 `model` / `small_model`；**不再写 `autoupdate: false`**（那是 Mesa 启动时自己用 env 关的）。真 opencode 1.19 + 假网关验过 `{file:}` 与 `{env:}`。Kimi 两版都写 `max_context_size`（旧版官方文档同样必填）；kimi 协议的思考档写模型段 `default_effort`，**必须连 `support_efforts` 一起写**（2.4.0 假网关实测只写前者请求里没有 effort），段里已有档位表不覆盖；官方切回撤 Mesa 渠道里的明文 `api_key`（渠道与别名照旧留着）。

**写之前说清会被什么盖掉（2026-10-30）**：预览 DTO `overrideNotes`（`override_notes_with`）列出外部终端里会盖过这次写入的来源——登录 shell 确实导出了的变量（Gemini `GEMINI_*` / `GOOGLE_*`、Qwen `OPENAI_BASE_URL` 等、Kimi `KIMI_*`、Grok `GROK_MODELS_BASE_URL` / `GROK_DEFAULT_MODEL`、OpenCode `OPENCODE_CONFIG*`）只报名字不报值；Claude 本机有托管设置时报；项目级配置看不到，按家说一句（Codex 已信任项目的 `.codex/config.toml`、OpenCode 项目 `opencode.json`、CodeBuddy 项目 `models.json`、Gemini 只读第一个 `.env`）。shell 变量名来自 `shell_env::login_shell_has`：导入时按凭据口径跳过的变量只记名字。一键切换不弹预览，`GlobalApplyResultDto.overrideNotes` 里 shell 那几条用黄色提示条说。Claude / CodeBuddy 的 settings env 本身盖过 shell，不报。

**请求头的全局写入口径（2026-10-30）**：Header 的值取自环境变量。能写「变量名引用」的写引用（Codex `env_http_headers`、OpenCode `{env:VAR}`、Grok `$VAR`）；只认明文的（Claude / CodeBuddy / Qwen / Gemini / Kimi）不写，预览 `skipped_policies` 写明「只在 Mesa 启动时带上」。禁止为了全局生效把 Header 明文写进 CLI 配置。

**官方账号「设为全局」= 撤掉 API 键、交回 CLI 登录（2026-10-28 用户拍板，取代下段「恢复首次快照」）**：七家（codex / claude-code / gemini / qwen / codebuddy / kimi / grok；OpenCode 没有官方账号，Cursor 不支持设为全局）都走 `plan_official_writes` 写计划，与 API 绑定同一套预览、事务备份、cc-switch 挡路、`record_active_global`、漂移与托盘勾选。每家只撤会盖过官方登录的东西，其余配置与别的渠道定义一律不动；文件不存在不写：

| Agent | 撤 / 改 |
|---|---|
| Codex | 撤 `model_provider`（回落内置 openai，认证交 auth.json 的 ChatGPT 登录）、别家的 `model_catalog_json`（Mesa 的 `codex-global.json` 交续聊层：有中转老对话就重建成官方模型 + 它们的模型，没有就撤，见上「Codex 客户端续聊」）、`model_context_window` / `model_auto_compact_token_limit`、Mesa 关掉的 `codex-app-tools` 插件，非官方模型名撤 `model`；**`custom` 块原样留着**，中转老对话照旧走原连接（曾写成 cc-switch 统一官方块同形，用户实测续不上中转老对话，已改回）。客户端侧栏在官方与中转之间切换时会互相藏对话，这是两者不能共用渠道的代价 |
| Claude Code | settings.json env 撤端点 / 两种密钥、四个别名槽及 `_NAME`、第五槽、上下文成对键、旧子 agent 键；`ANTHROPIC_MODEL` 是 claude 模型或别名（opus / sonnet …）时留 |
| Gemini | `.env` 删 `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GEMINI_BASE_URL`，非 gemini 模型删 `GEMINI_MODEL`；settings.json 认证方式是 Mesa 写的 `gemini-api-key` 就撤掉（**不写死 `oauth-personal`**，2026-10-30：Vertex / 自带 AI Studio 密钥的人会被改掉，个人 Google 账号也常用不了；撤掉后 Gemini 进门让用户选），非 gemini 的 `model.name` 撤 |
| Qwen | 认证方式是 Mesa 写的协议名（openai / anthropic）就撤掉，**不改成 `qwen-oauth`**（2026-10-30：Qwen OAuth 免费档已停用，切过去用不了；官方账号启动直接拦并说明）；env 撤两套协议的密钥 / 端点 / 模型与 `MESA_QWEN_API_KEY`；`modelProviders.*.models` 里 Mesa 的条目（`envKey` 是 `MESA_QWEN_API_KEY`）撤掉，用户自己的留着；`model.name` 等于被撤模型名时撤 |
| CodeBuddy | env 撤 `CODEBUDDY_BASE_URL` / `_API_KEY` / `_AUTH_TOKEN`，非官方模型撤 `CODEBUDDY_MODEL` 与顶层 `model`；`models.json` 撤 Mesa 写的条目 |
| Kimi | `default_model` 改指 `kimi login` 配好的 `managed:kimi-code` 模型（当前默认就是则不动）；没登录过就撤 `default_model`；Mesa 渠道（`ccode*`）里的明文 `api_key` 撤掉，渠道与别名留着。新旧两个配置目录存在的都改 |
| Grok | 撤顶层 `api_key` / `env_key`、`[endpoints].models_base_url`；非 grok 默认模型撤；指向非 x.ai 地址的 `[model.<id>]`：Mesa 写的（`name` 是「配置名 · 模型」）连同密钥整段撤、没有自己密钥的整段撤（留着官方令牌会发去中转），**用户手写、带自己 `api_key` / `env_key` 的留着**（2026-10-30）。官方启动另查「中转段没有自己密钥」并拦下 |

官方计划是删键，**比对磁盘必须整份比**（`disk_equals_plans`）——API 计划用的子集比对对删键永远为真，托盘会两项都打勾、「已是官方」会跳过写入。`plans_match_disk` 按账号类型分派。前后端判定 `official_global_is_patch` ↔ `officialGlobalIsPatch` 双端镜像。未登录官方账号时前端先确认一次。

**一键设为全局（2026-10-28 用户拍板：每次写都弹「预览」和「进度」两个框太麻烦，照 cc-switch 直接切）**：连接行悬停出地球图标，点了**不弹预览、不弹进度**——`apply_profile_global(validate: false)` 写完立刻返回，提示条「外部 X 已切到…」带 **撤销**（之前有 Mesa 写的全局连接就切回它、连记录一起回来；没有就 `restore_global_backup`）；复检随后经 `validate_global_profile` 在后台跑，没通过才再出提示（带「查看」）。cc-switch 挡路每个 Agent 只问一次（`confirmDialog`「切换，以后不再问」→ settings `global_conflict_ack`），之后连接页一键与托盘都直接写（托盘挡路首行也不再挂）；**⋯ 菜单的「写入 CLI 全局默认…」保留完整预览 + 进度 + 挡路提醒**，要看改什么走它。本段取代本节开头「确认前 preview」对一键入口的要求，事务备份 / 回滚不变。

**全局那条怎么显示（2026-10-28 用户嫌 cta-pill 地球与「全局生效」胶囊不好看，照 cc-switch「● 使用中」）**：名称旁不再挂「全局生效」胶囊；整行淡强调底（cta 8%）+ 左缘 2px 强调短条（同侧栏选中口径），~~操作列地球位置换成「● 全局使用中」~~（2026-10-31 改为名称旁小签「● 全局」：bg-inset 胶囊 + cta 点 + l1 字，与实心强调的「默认」区分；操作列不再放它，未全局行的地球照旧悬停才出）。外部改过时小签变琥珀「● 外部改过」（原名称下说明行一并取消），点开**改动明细**（`global_drift_detail` / `drift_files`）：before = 按当前连接重算的 Mesa 计划、after = 磁盘，脱敏同预览；API 连接只报 Mesa 管的键被改 / 被删（磁盘多出用户自己的键不算，与漂移子集比对同口径），官方账号整份比、多出的键也报。明细里两个去向：**按 Mesa 重写**（走一键路径）、**保留外部改动**（`forget_active_global`，文件不动，只清 `active_global_profiles` 记录，提醒随之消失）。漂移在连接变化、全局写入、回到本页时重查。

**生效时机**：预览的 `restart_note` 按 Agent 出。Codex 写明「外部终端新开生效；客户端重启」——app-server 新建对话会重读渠道，但客户端自带模型选择与预热对话、模型目录只在启动时读，不能承诺免重启；其余写「Mesa 不用重启，外部新开的会话生效」。

**旧口径（已被上两段取代，留档）**：官方绑定「设为全局」曾是 `restore_original_backup`——整份恢复首次写入前快照并 `clear_active_global`；问题是会冲掉之后的改动、首次写入前若是 cc-switch 中转则「恢复」回去仍不是官方。「恢复初始状态」菜单仍保留这个动作。

**托盘**（仓库里目前没有，本批新增）：

```
Mesa             → 打开主窗口
Claude Code      → 各绑定（含官方账号）
Codex            → …
（set_global unsupported 的 Agent 整组置灰，原因与配置页同源）
退出
```

点击 api 绑定 = 同一套 `apply_global`。失败 OS 通知，不弹进度层。不改启动栏默认，不热切已开标签。

**托盘选中态不要把「上次写入」画成收音机承诺**（洞 7）：

`active_global_profiles` 在用户于 Mesa 外手改文件后会失真。配置页徽标可以靠 title 交代；托盘 `●` 会放大成「这就是当前全局」。

菜单弹出时对该 agent 做一次 **dry-run**：`plan_writes` 产物与磁盘现文件比对（忽略无关空白 / JSON 键序若现实现已有归一就用）。

| 比对 | 托盘 |
|---|---|
| 与某绑定计划一致 | 该项 `●`，其余 `○` |
| 谁都比不上（手改 / 他方工具写过） | 全部 `○`，菜单顶一行「全局文件已在 Mesa 外改过」；装着 cc-switch 时加「，多半是 cc-switch」（比对只知道变了、不知道谁改的，不得写成断言） |
| dry-run 失败（读文件失败、超时） | 回落「上次写入」徽标口径，并在该项 title 标明「未校验磁盘」 |

不在托盘做 cc-switch 式回填保真。比对只影响显示，不自动写回。

## 13. 迁移

升级时一次性，可拆回。合并清单落 `ccode/gateway-merge.json`（或同等），「拆开这次自动合并」按清单把被吞掉的 binding / 单槽网关还原，并把 keys 再拆回去。

步骤：

1. 备份 `profiles.json` + `keys.json`。
2. 官方账号 profile → official 绑定，**id 不变**，`gatewayId` 空。
3. API profile 按 `keys.json` 密钥指纹分组（无密钥的 `noAuth` 按「无密钥 + 规范化 URL」分组，避免把所有本地端点合成一个网关）。
4. 一组一把密钥 → **一份新 id 网关**；每条旧连接按当时 Agent 协议把 URL 填进对应槽。
5. **同槽两个不同 URL → 拆成两份网关**（密钥相同，不盲合）。
6. **同一 `(agent, gateway)` 撞唯一约束**（今日允许同一 agent 两份同密钥同 URL 连接，即「工作 / 省钱」不同名单）：
   - 合并模型名单（保序去重：先 `lastUsedAt` 较新那条的名单，再追加另一条里尚未出现的）。
   - 保留较新那条的其余属性（extraEnv、protocol、停用态等），**保留其 profile id 作为 binding id**。
   - 另一条进合并清单：记下被丢弃的 id、名单、extraEnv，供拆开还原。
   - 指向被丢弃 id 的 settings / schedules / lastProfile / session_meta **改写为保留 id**（否则「接着聊」会指向幽灵 id）。
7. 旧 `request_policy` 按 §7 摊派。
8. `keys.json` 重键到 gateway id；旧 profile id 键删除（官方本无键）。
9. `default_profiles` / `hidden_profiles` / `active_global_profiles` / `ai_*` 已是 binding id，仅当第 6 步发生改写。
10. 旧 `profiles.json` 备份保留；网关库提供「拆开这次自动合并」。

用户侧：曾经复制到 Claude / Codex / Qwen 的同一把 NewAPI → 一份多槽网关 + 三条绑定（各 binding id = 原三条 profile id）。

## 14. 获取模型：分槽保留现状，不要只走 OpenAI

列表缓存键今日已是 `agent|protocol|base_url`（`models.rs`），改造为 **`gatewayId|slot`** 即可。

「优先走 OpenAI 槽」只决定**网关库点一次「获取模型」时先拉哪一个槽**。每个槽的 HTTP 路径必须保留现状，尤其：

- **Gemini 网关绑定要求 CLI 认证方式是 API Key（2026-10-17 端到端实测，gemini 0.64）**：认证只看用户 `~/.gemini/settings.json` 的
  `security.auth.selectedType`，环境变量只在它没设时兜底。oauth-personal 时 Mesa 注入的密钥 / 地址全被无视（要开浏览器登录）；
  没设但带了 `GOOGLE_GEMINI_BASE_URL` 时环境推断成 gateway 认证，CLI 报 Invalid auth method。能压过用户设置的系统设置层
  （`GEMINI_CLI_SYSTEM_SETTINGS_PATH`）要求文件归 root，普通用户写的被静默跳过——走不通。所以启动前只读检查（`agents::gemini_auth_blocker`），
  不是 `gemini-api-key` 就拒绝并给出改法（连接「设为全局默认」会写 selectedType 并先备份，或 gemini 里 /auth）；不替用户改文件。
- Gemini：`/v1beta/models` 候选（`models.rs` `model_list_candidates`），query `key=`，不是 `{base}/v1/models`；槽位带版本段先剥掉再拼候选（CLI 自拼 `/v1beta`，见 §2 归一口径）。
- Anthropic 槽：现 Claude 拉目录的路径与鉴权（Bearer）不得改成 OpenAI 形（CodeBuddy 2026-10-21 起走 OpenAI 槽，不再占这一槽）。
- Cursor：继续拒绝通用 `/models`（现直接报错）。
- OpenAI / Responses：现 `{base}/v1/models` 或 `{base}/models` 候选链。

分槽拉取失败不互相覆盖缓存。目录合并进网关 `models[]` 时打 `catalogFromSlot`；手填 id 始终允许。Relay 写入带 `gatewayId`（§6）。

## 15. 落地时要改口的假设

- 逐模型策略是四头新工作，不是迁字段（§7）。
- 落地第 1 步不是纯前端：状态栏隐藏无效 `/effort` 需要「该模型会不会思考」，能力链在 Rust，要先有 `combo_surface`（或同等）command / DTO。
- Gemini 拉目录路径特殊（§14）。
- 文档清单必须包含 **AGENTS.md 本身**（`profiles.rs` 条目、密钥/注入硬约束措辞随对象改名：密钥键从 profile id 改为 gateway id；`launch_plan` 入参；「复制到其他 agent」）。另改 `docs/guide/user-guide.md` 连接章、本文、`docs/architecture.md` §5/§10、matrix 里 Profile 称谓、`docs/conventions/safety.md` 的 RequestPolicy 条。

## 16. 落地顺序

真正的新硬骨头只有三块：**provider 派生名（§4）**、**relay 缓存键（§6）**、**逐模型策略载体（§7）**。其余是迁移细则。

1. **求交 DTO + 单测**。Rust 出口 `combo_surface`；状态栏按启动模型隐藏无效 `/effort`。存储仍是 Profile。relay 键改造可与此并行，但求交已按可选 gatewayId 查（旧数据无网关则跳过 relay）。
2. **Gateway / Binding 存储 + §3/§13 迁移**（含撞唯一约束的名单合并）。`get_key` 改键。`launch_plan` / `plan_writes` 改读新对象；provider 名改派生 + 旧 rollout 回落。配置页可先用适配层，UI 仍像今天。
3. **配置页拆开**：Agent 绑定列表 + 网关库；缺槽态；解绑 / 禁删。
4. **逐模型策略 UI + 体检挂槽 + 注入按选中模型求交**。OpenCode 不再把一份 options 套所有模型。
5. **托盘**：按 Agent 列绑定；`plan_writes` dry-run 选中态；官方 = 恢复初始快照。
6. **文档**：§15 清单一次齐。

## 17. Key Decisions

1. 诚实呈现，不走本地代理、不解析 TUI `/model`。
2. 网关 / 绑定拆层；`(agent, gateway)` 一对一。
3. **binding id 复用 profile id，gateway 新发 id**——迁移不断锚。
4. Provider 名 `ccode-<网关短id>`；旧 rollout 的 `ccode` 按 binding id 回落并仍以常量名注入。
5. Relay 缓存键带网关；其它能力层不动。
6. 体检从未 ≠ 失败；与通道表「未实证不注」不对称，手册写明。
7. 托盘只写全局、不改注入默认；选中态以 dry-run 文件比对为准，比不了对回落「上次写入」。
8. 有绑定禁删网关；清槽 → 缺槽态保留绑定 id。
9. 官方设为全局 = 恢复初始快照。
10. 预设表仍只收官方 / 公开端点。
11. 一键接入（2026-09-15）：预设 provider 级一份多槽；推荐模型 ≤3 且与实际目录求交（整目录预填红线不变）；「同时绑到」走 saveGateway + bindGateway×N，主槽永远跟随表单地址；「验证并获取」合并测试与获取（force 真实请求）。
12. 网关保存折槽（2026-09-26）：表单 Base URL 保存时折进五槽（slots 唯一真相，不落 masterUrl）；逐模型 id 合并保留后端目录元数据（source/status/catalogSlot/lastSeenAt）；清除密钥走显式 `clearKey`，不再由「空 apiKey + noAuth」隐式推断；`bindGateway` 保存后重算连接状态。

## 18. 导出 / 导入 v2

文件形状（`export_gateways_v2` / `import_gateways_v2`）：

```
{
  version: 2,
  gateways: [{ name, noAuth, slots, headerEnv, models, apiKey? }],
  bindings: [{ agent, gatewayRef: { name, slotFp }, protocol, apiBackend?, models, extraEnv }]
}
```

- `slotFp`：已填槽的 `name=规范化URL` 用 `|` 拼接，导入按它（及可选密钥指纹）对上网关。
- 默认不含密钥。含密钥须二次确认，落盘 0600；`extraEnv` 仍按名剔除含 KEY/TOKEN/SECRET/PASSWORD/AUTH 的项 **∪ `AUTH_BEARING_ENV` 闭集**，再过 `redact_sensitive_text`，然后才把 `apiKey` 写回。闭集（`auth_bearing_env_name`）是无密钥校验与导出剔除的**同一张表**：`OPENCODE_CONFIG_CONTENT` 这类内嵌整份凭据、名字里没有 KEY/TOKEN 字面的项，只有闭集能兜住；两处各写一份名单必然漂移。
- 导入：先按密钥指纹匹配，没有或对不上再按槽指纹。同网关槽 URL 冲突、Header / extraEnv / 协议冲突进 `skippedSlots`（界面列出原文）。唯一约束命中则合并模型名单。逐条绑定还要过 §2 的字段校验（agent 白名单 / 协议闭集 / `apiBackend` / `extraEnv` 名），不合格同样进 `skippedSlots` 而不是静默落盘。
- 旧 profiles 数组仍能导入（v1 回落）。

## 配置存储与恢复（2026-09-08）

- ProfileStore/settings 的读改写持同一进程锁和 OS 文件锁；schedules 独立锁。跨锁依赖顺序为 profiles→schedules；scheduler 读完日程先放锁再解析 Profile。全局配置先读取 Profile/密钥再取 global-config 锁，持全局锁时不得再次读取 Profile。
- 官方账号 bind 走 create 前释放已有 profiles 锁，防同线程重入死锁。
- 拆层迁移先写私有 pending 日志，写网关→密钥→绑定→合并日志→引用，最后删除 pending。失败后用相同 ID 重放；bindings 存在不再绕过 pending 恢复。
- 私有 JSON 从临时文件创建起就是 0600；普通文本原子替换保留可执行位。损坏密钥原件保留并备份，损坏设置保留且拒绝 patch，不把“读失败”当“空配置”。
- 定时任务绑定缺失时拒绝静默回落；交互 AI 默认选择仍遵守既有显式/专属/默认优先级。

## 非对话模型与出图模型（2026-10-23）

- 网关目录把出图 / 视频 / 向量 / 重排 / 语音 / 审核模型和对话模型混列（New API `supported_endpoint_types` 只有 gpt-image 系标了
  `image-generation`，不可依赖），一律**按模型名分类**：`image_gen::model_kind` ↔ `src/model-kinds.ts` 镜像，共读
  `tests/fixtures/model-kinds.json`。新增厂商命名规则两侧同改并补样例；判定顺序视频先于出图、重排先于向量。
- 非对话模型不得成为 Agent 的对话模型：连接目录面板隐藏并报数、手填标「不能对话」（保存不拦）、对话菜单置灰、启动栏名单过滤；
  最终闸在 `agents::validate_launch_compatibility`（终端 / 无头 / 内置 AI 三条路径共用）。分类误伤对话模型时改规则，不加开关绕过。
- 出图模型是**单选**（存设置 `image_gen_gateway_id` + `image_gen_model`，同进退），不进绑定、不进模型名单；**编辑处只在连接页**「出图模型」一块（2026-10-24），设置页只显示现状跳过去；名单全是非对话模型的连接标「只有出图模型」并给「改作出图模型」，不自动删连接；Agent 用 `--model`
  点名别家时按「默认网关目录 → 任一网关目录 → 默认网关」找。接口按模型选：Gemini 系原生 generateContent → 退对话接口；
  其余 OpenAI `/images/generations`（base 带版本段直接挂，否则补 `/v1`，同 `ends_with_version_segment`）。

## 模型配置约定（2026-09-05 起）

> 2026-09-22 自 AGENTS.md「模型配置约定」整节迁入（原文未改）。改配置/注入/设为全局/模型能力前与本文件其余章节一起读。

- Claude Code 启动必须用 `--settings` 覆盖本次连接的 base_url、密钥与模型选择，避免用户级 `settings.json.env` 覆盖 Mesa（三者必须同层配对：只提 base_url 会让磁盘上残留的旧 token 胜出，形成「新端点 + 旧令牌」而报 401）；密钥写 0600 临时文件后以路径传入，不进 argv。**覆盖层与进程 env 共用 `agents::claude_model_env` 一份（2026-10-17 端到端核对后定）**：
  四个别名槽（SONNET / OPUS / HAIKU / FABLE）全填——绑定名单不够四个时空槽用这次选的模型补（名单为空则不补，沿用 Claude 自己的别名映射），
  `ANTHROPIC_SMALL_FAST_MODEL` 跟 HAIKU 槽；`CLAUDE_CODE_SUBAGENT_MODEL(_FORCE)` 默认不写（保留 Task 参数、frontmatter 与主模型继承链），
  **只在用户级 settings.json env 设了时盖成这次的模型**；上下文窗口确知 >200K 才声明，用户级设过而这次不确知时写回 200000。
  依据：假网关实测，用户全局 settings 里的 HAIKU / 子 agent 模型原先会漏进 Mesa 会话（会话标题、子 agent 请求带着全局 glm-5.3 打到所选网关）。
  用户级 env 只读键名（`claude_user_settings_env_keys`），单测经 thread_local 注入、不读本机。
- **模型分工 RoleModels（2026-10-17 用户：补齐规则要在连接里看得见、能改）**：绑定字段 `role_models { small, subagent }`（None = 跟主模型），
  连接表单「模型分工」只对能分开指定的家显示（`src/role-models.ts`）：Claude Code（small → HAIKU 槽 + `ANTHROPIC_SMALL_FAST_MODEL`；
  subagent → 显式写 `CLAUDE_CODE_SUBAGENT_MODEL`）、Grok（small → overlay `[models].session_summary` + `prompt_suggestion`，
  未指定时钉成这次的主模型——用户全局常把它们指到别的网关；small 并入 allowed_models）、OpenCode（small → `small_model`）。
  选项只能是名单里的模型；名单删掉的模型对应分工自动作废。不改任何 CLI 配置文件；导出导入随绑定带走。
- **Claude 显式别名映射（2026-10-30 用户拍板，设计稿 `docs/design-connection-agent-forms.md`）**：`role_models.slots`（sonnet / opus / fable → 名单里的模型，
  缺的键跟默认；haiku 仍是 `small`）与 `role_models.display_names`（模型 → /model 显示名，没设用「连接名 · 模型」）。`slots` 为 None = 旧绑定，
  `agents::claude_slot_models` 仍按名单前四个占槽；连接弹层保存时 `explicitClaudeRoles` 按同一规则算好写成显式（haiku 没设时 small 取名单第 3 个），
  用户看到的指向不变，**不做数据迁移**。「默认」行 = 名单第一个，改它是挪名单顺序（挪前先转显式，挪顺序不能顺带改别名）。/model 另加项
  （`ANTHROPIC_CUSTOM_MODEL_OPTION`）：旧绑定名单第 5 个，显式时第一个没被占用、也不是默认的模型。前后端双端镜像，共读 `tests/fixtures/claude-slots.json`。
  2026-10-31 窄弹层排版：表只留三列（角色 / 实际请求模型 / 上下文 · 声明 1M），显示名收进表下「改 /model 里的显示名」折叠行，下拉选项写「跟默认」不带模型名；Claude 连接的模型名单不再标「默认」/「设为默认」（默认在表里定）。
  表里的「1M」写的是全局能力声明（`set_model_capability_override`，按模型、所有 Agent 共用），能力库确知 ≥1M 的锁着打勾；不做 Claude 专属勾选，免得同一个模型各家声明不一致。
- **连接弹层生效预览（2026-10-30）**：已保存的连接底部常驻折叠行「看实际会拿到什么」（`EffectPreview`），展开两栏调 `preview_launch_plan` 与
  `preview_profile_global`，按已保存内容算；不支持设为全局的家右栏写原因。九家同一块。
- **非 Claude 模型关工具搜索（2026-10-21）**：主模型不是 `claude-*` 时写 `ENABLE_TOOL_SEARCH=false`（用户 settings.json 设过不动）。Claude Code 对第三方网关也开 ToolSearch、把少用的工具藏到它后面；glm-5.3-flash 会拿 ToolSearch 去「搜」本来就在的 Write / Bash，搜不到就断定没工具、整轮不干活（用户会话实证）。假网关核对：关掉后 ToolSearch 与占位工具消失、24 个工具一次发全（多几千 token 输入）。**这是 Claude Code 新版才有的**：同一假网关、什么都不注入时，2.1.305 发 14 个工具（含 ToolSearch 与占位），2.1.292 发全 24 个——旧版机器上（用户的 Mac）不出这个问题，升级后会出。
- **Codex 计划工具随提示词打开（2026-10-21）**：Mesa 给的 catalog 提示词（Codex 对未登记模型的默认提示词）提到 `update_plan`、Codex ≥ 0.163、用户 config.toml 没有 `[tools.update_plan]` 时，交互启动加 `-c tools.update_plan.enabled=true`（`agents::codex_plan_tool_args`）。0.163 默认不发这个工具，提示词却说有，模型就答「没有计划工具」。`request_user_input` 只在 Plan 模式可用是 Codex 设计，不改。
- **非 Claude 模型开任务清单工具（2026-10-21）**：主模型不是 `claude-*` 时写 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`（用户设过不动）。Claude Code 2.1.306 的 TaskCreate / TaskUpdate / TaskList / TaskGet 只对 ≤ opus-4-7 / sonnet-4-6 / haiku-4-5 默认发，别的模型名不发，模型就说没有待办工具。假网关核对：glm-5.3 注入前 23 个工具、注入后 27 个。claude-opus-5 等新 Claude 模型官方有意不发，不注入。
- **别家模型适配（2026-10-17 假网关实测）**：Claude 主模型被能力库确知「不会思考」时写 `MAX_THINKING_TOKENS=0`（去掉 adaptive
  thinking 字段；`CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` 实测不去）。Grok 的思考档只对 config 里 `[model."<id>"]` 声明了档位的模型生效，
  其余被忽略并警告——求交器在只绑 grok 时据 `agents::grok_model_declares_effort`（只读）关掉开聊前与运行中的档位。
  CodeBuddy 自定义端点下 `--effort` 在线上不出现任何思考字段，effort 通道改 unsupported。
- Anthropic 兼容槽只接受基础 URL；保存时拒绝以 `/messages` 结尾的完整资源地址。
- CodeBuddy 的 `reasoning_effort` 通过当前 CLI 的 `--effort` 启动参数注入；Grok 的模型/思考档通过 `-m`/`--reasoning-effort` 注入。
- Grok 的 `api_backend`、`context_window` 不得通过受限 `GROK_CONFIG` 猜测注入；若绑定声明非 `chat_completions`，必须先在 Grok `[model.<id>]` 配置中登记，否则启动和无头调用均 fail-closed。
- Codex 网关端点必须实现 `/responses`（CLI 已移除 `wire_api="chat"`）：智谱专用端点是 `https://open.bigmodel.cn/api/v1`，`/api/paas/v4` 只有 `chat/completions`，Codex 打过去 404；且 api/v1 **不提供 `/models` 目录**（智谱把错误包成 HTTP 200），目录只有 `paas/v4/models` 有——网关库正确填法 = Base URL/OpenAI 槽 `paas/v4` + Responses 槽 `api/v1` 分槽填（预设与网关库告警已对齐；fetch_models 用 `gateway_error_envelope` 识别 200 包错误体，不误报「0 个模型」；qwen/kimi/opencode/grok 走 openai 槽用 `paas/v4` 不受影响；2026-09-15 实证）。
- **智谱 OpenAI 槽按计费方式分址（2026-10-20 实测）**：`/api/paas/v4` 按量扣账户余额，`/api/coding/paas/v4` 才抵扣 Coding Plan 套餐；套餐 key 打前者报 HTTP 429 + `1113 余额不足或无可用资源包`（Grok 当限流重试后显示「Retry failed」），`/api/anthropic` 与 `/api/v1`（Responses）两种计费都通——所以「Claude/Codex 能用、OpenAI 协议 Agent 不能用」就是这一条。两址 `/models` 都 200，探测与拉目录区分不了，只能靠地址：预设拆成「Coding Plan（套餐）」「按量付费」两条，网关库与添加连接表单对 `open.bigmodel.cn`/`api.z.ai` 的 `/api/paas/v4` 给黄色提示（`zhipuOpenAiSlotBillingHint`）。coding 端点同样不实现 `/responses`（404），Codex 仍走 `api/v1`。
- Codex 从步骤工作区启动时，pty_spawn 把主仓 `papers/` 预授权进沙箱（`-c sandbox_workspace_write.writable_roots=[...]`，`workspaces::papers_dir_for_worktree` 映射）：口径 C 允许原始文献直写主仓 papers/，不预授权则每写一篇 PDF 都停下等提权（2026-09-15 用户实测「总是让我授权」）。**只加 papers/ 子目录**——派生产物仍必须走工作区 + 评审合并，不得放宽到整个主仓。
- 配置页查询模型能力必须带 `gatewayId`，网关级能力声明优先于公共/内置能力库；写 Grok 逐模型上下文时只使用显式声明值，不使用通用估值。
- **状态栏当前思考档（2026-10-17）**：`currentEffort` = TUI 屏上认出的档（`detectEffortInOutput(text, agentId)`，**按 CLI 分形态、只认带固定上下文的成句**，2026-10-17 本机 PTY 实录：Claude Code/CodeBuddy 横幅「with X effort」/输入框右上「◉ X · /effort」/回显「Set effort level to X」；Codex 0.163 底栏「<模型> X · <目录>」逐段 CUP 定位、没设档写 default（认出 default = 用默认，**不回落注入值**）；Grok 1.0.x 边框「<模型> (X) · <权限>」；Qwen 0.25 底栏不写档，只认 /effort 回显三句；Kimi 2.1 底栏「<模型> thinking  <目录>」= on；其余 CLI 不认。光标右移/CUP 先换空格再剥转义，含人手敲 /effort）> 本次开工覆盖（TabStatus.effortOverride）> `combo_surface.launchEffort`（逐模型策略开场档，**仅 injectEffortAllowed 时有值**——没注入就是 null）。都没有 = 不知道：滑块不点亮任何一格、标「默认」，**禁止再用「档位表第 N 格」冒充当前档**（原初值硬写下标 1，CLI 实跑 xhigh 时显示 low）。拖动后的本地选择在真值变化（回显到达/换 PTY）时让位。底栏不能切档（无 showNativeEffort）但模型会思考的 CLI 显示只读「◈ 档名 / ◈ 默认」。CLI 升级改了界面文案会认不出——认不出只是回落到覆盖/开场档/「默认」，不会显示错档；发现回落时重新 PTY 实录补形态。
- 思考档注入优先级（2026-09-15；2026-10-17 聊天输入框开聊前选择器「思考」栏同样写 Tab.effort）：开工弹层 / 聊天选择器的本次覆盖（`KickoffLaunch.effort` → PendingTerminal → Tab → `pty_spawn` 的 `effortOverride`）> 绑定逐模型策略（网关库 `reasoningEffort`）> 端点默认。弹层选择器按 `combo_surface.injectEffortAllowed` 判定显示（不给调不了的东西）；值只影响本次进程不写回绑定；运行中调整仍在状态栏（起点/运行两层同源 combo）。执行权限不做成弹层选项——步骤执行固定 write_tree + 沙箱，只读讨论走聊想法/商量（弹层只有一行权限边界可见性文案）。
- **能力声明与能力通道（2026-09-19，对照 cc-switch 补口）**：Claude 长上下文 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 与 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` **同值成对**注入/清除（启动 + 设为全局；只抬上限不抬压缩窗口会把压缩触发点留在旧档，勿拆对）。Codex catalog **不写** `apply_patch_tool_type`（freeform=custom 工具会被原生 /responses 与 Anthropic 网关拒/丢，编辑走 `shell_type: "shell_command"`）。模型能力注册链四层全 miss 时用户可经网关库「能力声明」写覆盖（`model-capabilities.json` 最高层；表单只收 context/思考/视觉——output 的旋钮是策略字段 max output，能力层 output 只喂 opencode limit.output，与策略并排摆两个输出框属重复），`input_modalities` 等按注册链如实声明（宁缺毋滥）+ 覆盖层补口的口径不变。
- **声明层与估值层分家（2026-09-26，硬规则）**：写进**别人家 CLI 配置文件**的能力值只能来自 `model_*_declared_for` 声明层访问器，兜底层（`fallback_context_size` 的 128K/256K/1M、关键词推断 thinking、内置表确知多模态清单）**一律不得**当声明写出——它只配喂 UI 显示与自己家状态的估算。分流按目标格式的必填性决定：**可省略的未知就不写**（codex catalog 的 `context_window`/`max_context_window`/`input_modalities`，实证可选；codex `-c model_context_window`/`model_auto_compact_token_limit`；kimi `KIMI_MODEL_MAX_CONTEXT_SIZE`，env 通道有 CLI 兜底不报错），**必填的写保守下限**（kimi `config.toml` 的 `max_context_size`；opencode 的 `limit.context`/`limit.output`）。理由：`-c model_context_window` 是硬覆盖，写 128K 猜测会把 codex 自带 registry 认得的 272K/1M 窗口压低（比不写更坏）；`input_modalities: ["text"]` 是替用户断言「纯文本」；未知≠假，凡**破坏性/删除性**决策（如 `combo::apply_to_profile` 剥 `reasoning_effort`）只认显式 `Some(false)`，未知一律保留。反面对照：凡是注释里出现「必填/强制/schema 要求」的说法，改前先去二进制或上游源码找非注释证据（本仓此类说法源头都是注释，文档/测试只是复述）。
  第三个分流维度是**目标键是不是「完备声明」**：`capabilities` 这类数组由 CLI 用 `some(===)` 判成员（不在表里 == 不支持），所以写进去就是替用户断言「不在此表即没有」，未确知不得写入；但**若该键有已知缺省集，就可以写「缺省集 ∪ 确知为真」，只可能加不可能减**。kimi env 通道正属此列：缺省 `["image_in","thinking"]` 是已知有限集（且**不含 `tool_use`**——省了就是丢工具），故恒写 `tool_use` 并保留未被声明为假的缺省成员；config.toml 通道的 `capabilities` 缺省由 CLI 按模型自身线索推导、边界不可知，故只在 `== Some(true)` 时写、未确知整键省略。**未确知的缺省集不许猜**：`["tool_use"]` 是 `CUSTOM_REGISTRY_DEFAULT_CAPABILITIES`（注册项路径）的缺省，曾被误当 env 通道缺省引用，勿再复述。

**CodeBuddy 走 OpenAI 槽（2026-10-21 更正）**：CodeBuddy 把 `CODEBUDDY_BASE_URL` 原样当 base 拼 `/chat/completions`（2.171 源码 `resolveModelBaseURL`），不是 Anthropic 协议。`slot_for_agent` / `api_kind` / `api_kind_label` 与前端 `slotForAgent` / `apiKindOf` 同改，连接验证按 chat/completions 形状探针；内置预设的 CodeBuddy 自家端点写 `openai: <endpoint>/v2`。原口径下验证能过（Anthropic 地址的 `/v1/messages` 可用）、运行只得空回复（网关对 `…/anthropic/chat/completions` 回 200 + 错误体），是「验证通过 ≠ 运行可用」的又一例。

**给人看的上下文窗口只用确知值（2026-10-21）**：状态栏 / 聊天层上下文圈、模型菜单、网关库「当前解析」走 `model_context_size_known_for`（查询链声明 + kimi 官方映射），查不到是 `None` / `null`，界面不画不写；`model_context_size_for` 的 128K 保守兜底只留给 schema 必填的写配置场景（OpenCode `limit.context`、Kimi config.toml）。原先显示层也吃兜底，库外模型一律「131K」，而各家 CLI 按自己的默认算（Gemini 1M、Claude / Qwen 200K），圈比 CLI 实际满得多。
