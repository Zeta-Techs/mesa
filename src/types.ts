export interface Profile {
  id: string;
  agent: string;
  name: string;
  /** 账号类型：api = 端点+密钥；official = CLI 官方账号登录（P1a），缺省 api */
  accountType: "api" | "official";
  /** API profile explicitly allows no credential, normally for localhost endpoints. */
  noAuth: boolean;
  protocol: string | null;
  /** Grok 专用：API 后端（chat_completions/responses/messages），仅「设为全局默认」写入消费 */
  apiBackend?: string | null;
  baseUrl: string | null;
  /** 可用模型列表，首个为默认 */
  models: string[];
  /** 模型分工：后台小模型 / 子 Agent（只有 Claude Code、Grok、OpenCode 消费）；不设 = 跟主模型 */
  roleModels?: RoleModels;
  /** 附加环境变量，启动时注入，优先级高于 adapter 内置 env */
  extraEnv: Record<string, string>;
  requestPolicy: RequestPolicy;
  /** 密钥尾号提示（如 "···abc1"），用于区分多个 key */
  keyHint: string | null;
  hasKey: boolean;
  /** 最近一次用该配置启动的时间（ISO）；null = 从未使用 */
  lastUsedAt: string | null;
  /** 所属网关；官方账号为 null */
  gatewayId?: string | null;
  /** 该 Agent 所需协议槽未填 */
  slotMissing?: boolean;
  /** 连接状态机细分状态，由后端统一判定 */
  connectionStatus?: string;
  /** 绑定模型相对网关目录的同步状态 */
  modelSyncStatus?: "synced" | "stale" | "missing" | "unknown" | string;
  modelSyncNote?: string | null;
}

export type ProbeStatus = "never" | "passed" | "failed";

export interface ComboSurfaceDto {
  agent: string;
  agents: string[];
  model: string;
  gatewayId: string | null;
  slot: string | null;
  thinking: boolean;
  vision: boolean;
  context: number;
  output: number;
  showNativeEffort: boolean;
  /** 网关勾选的可切换档。空 = 用 CLI 整张档位表。 */
  effortLevels: string[];
  /** 这次启动会注入的开场档；没注入（通道不通 / 没存策略）= null，状态栏不得冒充某一档 */
  launchEffort: string | null;
  injectEffortAllowed: boolean;
  injectTemperatureAllowed: boolean;
  injectTopPAllowed: boolean;
  injectMaxTokensAllowed: boolean;
  injectHeadersAllowed: boolean;
  effortReadonly: boolean;
  temperatureReadonly: boolean;
  topPReadonly: boolean;
  maxTokensReadonly: boolean;
  mixedModelsNote: string | null;
  /** 逐字段通道种类并集（inject/persist/tui/unsupported/unknown） */
  channelEffort: string;
  channelTemperature: string;
  channelTopP: string;
  channelMaxTokens: string;
  channelHeaders: string;
  probeEffort: ProbeStatus;
  probeTemperature: ProbeStatus;
  probeHeaders: ProbeStatus;
  probeNote: string | null;
  /** 策略通道形态说明（如 qwen「温度/topP 仅设为全局生效」） */
  policyChannelNote?: string | null;
  missingSlot: boolean;
}

export interface ProtocolSlots {
  anthropic?: string | null;
  openai?: string | null;
  responses?: string | null;
  gemini?: string | null;
  cursor?: string | null;
}

export interface GatewayModel {
  id: string;
  source: string;
  status?: "available" | "stale" | string;
  lastSeenAt?: string | null;
  catalogSlot?: string | null;
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number | null;
  reasoningEffort: string | null;
}

export interface ProbeRecord {
  slot: string;
  model: string | null;
  urlFp: string;
  keyFp: string;
  streaming: ProbeStatus;
  effort: ProbeStatus;
  sampling: ProbeStatus;
  headers: ProbeStatus;
  basic: ProbeStatus;
  probedAt: string;
  latencyMs?: number | null;
}

export interface SlotProbeSummary {
  slot: string;
  lastLatencyMs: number | null;
  lastProbeAt: string | null;
  lastOk: boolean | null;
}

export interface Gateway {
  id: string;
  name: string;
  noAuth: boolean;
  keyHint: string | null;
  slots: ProtocolSlots;
  headerEnv: Record<string, string>;
  models: GatewayModel[];
  catalogFetchedAt: string | null;
  catalogFromSlot: string | null;
  lastProbe: ProbeRecord[];
  slotProbes?: SlotProbeSummary[];
  revision?: string;
  /** New API 钱包查询用户 ID（非密钥） */
  walletUserId?: string | null;
  /** 系统访问令牌尾号；本体不进前端 */
  walletKeyHint?: string | null;
}

export interface GlobalDriftDto {
  status: "matches" | "drifted" | "neverWritten" | "error" | string;
  files: string[];
  message: string | null;
}

export interface GatewayUsageRow {
  gatewayId: string;
  gatewayName: string;
  bucket: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  costPartial: boolean;
  sessionCount: number;
  agents: string[];
}

export interface ImportV2Result {
  addedGateways: number;
  addedBindings: number;
  skippedSlots: string[];
}

export interface GatewayInput {
  name: string;
  noAuth: boolean;
  slots: ProtocolSlots;
  headerEnv: Record<string, string>;
  models: GatewayModel[];
  apiKey: string | null;
  expectedRevision?: string | null;
  /** 明确删除密钥；不发或 false = 不改 */
  clearKey?: boolean;
  /** 前端拉取目录后保存时回传；None = 不改（新建时可带） */
  catalogFetchedAt?: string | null;
  catalogFromSlot?: string | null;
  /** New API 系统访问令牌；空 = 不改。清除走 clear_gateway_wallet_token（带二次确认） */
  walletAccessToken?: string | null;
  /** 空串清空；缺省不改 */
  walletUserId?: string | null;
}

/** 绑定的模型分工（profiles.rs RoleModels）。不设 = 跟主模型（这次启动选的模型） */
export interface RoleModels {
  /** 后台小模型：会话标题、摘要、输入提示这类小任务 */
  small?: string | null;
  /** 子 Agent 模型（Claude Code） */
  subagent?: string | null;
}

export interface BindingInput {
  agent: string;
  /** 绑定级显示名；留空时后端回退网关名。 */
  name?: string;
  gatewayId: string | null;
  kind: "api" | "official";
  protocol: string | null;
  apiBackend?: string | null;
  models: string[];
  roleModels?: RoleModels;
  extraEnv: Record<string, string>;
}

export interface ProfileInput {
  agent: string;
  name: string;
  accountType: "api" | "official";
  noAuth: boolean;
  protocol: string | null;
  apiBackend?: string | null;
  baseUrl: string | null;
  models: string[];
  /** 模型分工；不带 = 不改 */
  roleModels?: RoleModels;
  extraEnv: Record<string, string>;
  requestPolicy?: RequestPolicy;
  /** 明文密钥，仅保存时提交；编辑时留空表示不修改 */
  apiKey: string | null;
  expectedGatewayRevision?: string | null;
}

/** 请求级策略声明。仅在对应 Agent/协议支持时才会实际生效。 */
export interface RequestPolicy {
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number | null;
  reasoningEffort: string | null;
  /** Header 名 → 读取值的环境变量名，避免把密钥明文存入 Profile。 */
  headerEnv: Record<string, string>;
}

export interface ModelCapabilityDto {
  model: string;
  thinking: boolean;
  context: number;
  tools: boolean | null;
  vision: boolean | null;
  video: boolean | null;
  streaming: boolean | null;
}

/** 模型能力覆盖条目（model-capabilities.json，注册链最高层；api_backend 不进 UI、往返保留） */
export interface ModelCapsOverrideDto {
  prefix: string;
  thinking: boolean | null;
  context: number | null;
  output: number | null;
  vision: boolean | null;
  api_backend: string | null;
}

/** 订阅余量（用量页「订阅余量」卡）：智谱 GLM Coding Plan 先行，窗口名闭集供多供应商复用 */
export interface PlanQuotaWindowDto {
  /** five_hour | weekly | monthly（monthly 为保留位） */
  window: string;
  /** 已用百分比 0-100 */
  usedPercent: number;
  /** 重置时间（毫秒 epoch），null = 未知 */
  resetsAt: number | null;
  /** 已用/总量的绝对值（智谱积分、Kimi 配额点数）；只给百分比的供应商为 null */
  used: number | null;
  total: number | null;
}

export interface PlanResetCardsDto {
  ok: boolean;
  fiveHour: number;
  weekly: number;
  /** 每类最早过期的可用卡（毫秒 epoch）；用卡按它优先消费 */
  fiveHourExpiresAt: number | null;
  weeklyExpiresAt: number | null;
  lastFiveHourResetAt: string | null;
  lastWeekResetAt: string | null;
  error: string | null;
}

export interface PlanQuotaDto {
  gatewayId: string;
  gatewayName: string;
  /** zhipu | kimi | minimax（显示名前端映射） */
  provider: string;
  planLevel: string | null;
  ok: boolean;
  error: string | null;
  windows: PlanQuotaWindowDto[];
  /** 只有智谱有重置卡接口；false 时不渲染重置卡行 */
  resetCardsSupported: boolean;
  resetCards: PlanResetCardsDto;
  /** 本条数据时间（毫秒 epoch） */
  queriedAt: number;
  fromCache: boolean;
}

/** 网关余额（用量页「网关余额」卡）：New API 预付钱包，与订阅余量并列 */
export interface GatewayBalanceDto {
  gatewayId: string;
  gatewayName: string;
  /** 站点 origin，去钱包拼 `{origin}/wallet` */
  origin: string;
  /** 这个钱包属于哪个账户；同站多网关合并成一张卡的分组键（同站不同账户必须分开） */
  account: string | null;
  /** newapi（显示名前端映射） */
  kind: string;
  ok: boolean;
  error: string | null;
  /** wallet = 账户钱包；token = 这把密钥的额度 */
  source: string;
  /** 这个密钥不限额度（看钱包页才有账户余额） */
  unlimited: boolean;
  /** CNY | USD | TOKENS */
  currency: string;
  remaining: number | null;
  used: number | null;
  total: number | null;
  /** 令牌过期（毫秒 epoch） */
  expiresAt: number | null;
  /** 已保存系统访问令牌 */
  hasWalletToken: boolean;
  /** 这把推理密钥的额度，与钱包并列 */
  tokenRemaining: number | null;
  tokenUsed: number | null;
  tokenTotal: number | null;
  tokenUnlimited: boolean;
  /** 站点上这个令牌的名字（悬停说明用） */
  tokenName: string | null;
  queriedAt: number;
  fromCache: boolean;
}

/** fetch_models 返回：模型列表 + 缓存命中标记 + 拉取时间（RFC3339 本地） */
export interface FetchModelsResultDto {
  models: string[];
  fromCache: boolean;
  fetchedAt: string;
  capabilityMetadataCount: number;
}

/** fetch_gateway_catalog：写入网关目录，并带回本次 /models 里解析到的能力条数 */
export interface FetchGatewayCatalogDto {
  gateway: Gateway;
  capabilityMetadataCount: number;
}

/** 官方账号连接状态（official_account_status，P1a） */
export interface OfficialAccountStatusDto {
  /** 注册表已填该 agent 的官方账号规格 */
  supported: boolean;
  /** auth 文件检出凭证 */
  connected: boolean;
  /** 检测说明（漏报场景/文件异常） */
  detail: string | null;
  /** 终端内执行的登录命令（含二进制名；不支持时 null） */
  loginCommand: string | null;
  /** 配置文件冲突告警（只含文件名与变量名，不含密钥值） */
  conflicts: string[];
  cleanupSupported: boolean;
  /** 组头登录标签要注入的环境（出网代理；连接 extraEnv 再覆盖） */
  loginEnv: Record<string, string>;
}

export interface ValidationCheckDto {
  status: "passed" | "failed" | "skipped";
  message: string;
  latencyMs: number | null;
}

export interface ProfileValidationDto {
  ok: boolean;
  checkedAt: string;
  local: ValidationCheckDto;
  cli: ValidationCheckDto;
  api: ValidationCheckDto;
}

export interface GlobalApplyResultDto {
  files: string[];
  validation: ProfileValidationDto;
}

export interface GlobalWriteChangeDto {
  path: string;
  op: string;
  before: string | null;
  after: string | null;
}

export interface GlobalWriteFilePreviewDto {
  path: string;
  tag: string;
  action: string;
  changes: GlobalWriteChangeDto[];
  omitted: number;
}

export interface GlobalWritePreviewDto {
  files: GlobalWriteFilePreviewDto[];
  skippedPolicies: string[];
  restartNote: string;
  scopeNote: string;
}

/** 启动计划预览：只展示环境变量名称与脱敏参数，不返回密钥值。 */
export interface LaunchPlanPreviewDto {
  agent: string;
  binary: string | null;
  args: string[];
  /** 注入环境变量（名称 + 来源标注）；同键重复属正常（覆盖语义），原样列出 */
  env: { name: string; source: string }[];
  envRemove: string[];
  promptSupported: boolean;
  requestPolicy: RequestPolicy;
  /** 配置 overlay 预览（白名单放行、值里无密文才带原文）；note 交代注不进的字段去向 */
  overlays: { name: string; content: string; note: string | null }[];
  /** agent 级协议/上下文说明行（如 codex 的 Responses 与 catalog 上下文窗口） */
  notes: string[];
}

/** 网关体检探针结果：绕过 CLI 直连端点的裸响应观测（流式/参数透传/Header 接受度） */
export interface GatewayProbeDto {
  ok: boolean;
  model: string;
  checks: ValidationCheckDto[];
}

export interface DetectResult {
  id: string;
  binaryPath: string | null;
  version: string | null;
  /** 该 CLI 有进程级只读参数（--permission-mode plan / -s read-only 之类）。
   *  false（qwen / opencode）= 「只读保护」对它只剩 prompt 软约束，agent 可以无视 */
  readonlySupported: boolean;
  /** 能在启动参数里指定的原生权限档（agent_specs permission_args）：ask 请求批准 / auto 帮我批准 / full 完全访问 */
  permissionModes: string[];
  /** 运行中模型切换命令（终端状态栏模型菜单；null = 无机制不显示） */
  modelSwitch: { kind: "direct" | "picker"; command: string } | null;
  /** 运行中思考档调节（档位表 + 命令模板；null = 不显示「◈ 思考」控件） */
  effort: { levels: string[]; command: string } | null;
  /** TUI 的 Enter 需要 CSI-u 形式（kitty 键盘协议；kimi）——xterm 层与状态栏写入改写 */
  submitCsiU: boolean;
}

/** 终端主工作区的显示层；仅运行时状态，不写入标签恢复数据。 */
export type SurfaceMode = "chat" | "terminal";

/** 聊天输入统一发送到当前标签 PTY 后的结果。 */
export interface ChatSendResult {
  error: string | null;
  /** CLI 需要终端专属交互或不支持启动注入，调用方应切回终端。 */
  needsTerminal?: boolean;
}

/** 会话文件同步通道状态。 */
export type SessionSyncState =
  | "detecting"
  | "watching"
  | "waiting"
  | "polling";

/** 单会话累计用量（终端状态栏 token 段） */
export interface SessionUsageDto {
  input: number;
  output: number;
  costUsd: number;
  /** 至少一个模型命中定价表（false = 费用无意义，只显示 token） */
  priced: boolean;
}

export interface TokenUsageDto {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionMetaDto {
  agent: string;
  sessionId: string;
  projectPath: string;
  /** 原始会话工作目录；项目路径可能因 worktree 归并为主仓库 */
  cwd?: string | null;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  filePath: string;
  tokenUsage: TokenUsageDto | null;
  cliVersion: string | null;
  pinned: boolean;
  archived: boolean;
  customTitle: string | null;
  tags: string[];
  /** 源文件是否还在；不在则回放走 pin 快照 */
  alive: boolean;
  /** 接着聊产生的多份文件合并成一条时的文件数（Codex resume、Grok 继续、Claude 桌面版继续）；无链为 1 */
  chainCount: number;
  /** 会话发生在任务工作区（git worktree）里时的工作区名；此时 projectPath 已改写为真实仓库 */
  workspace: string | null;
  /** 工作区名命中项目流水线 steps[].workspaceName 时的步骤名；null 时回落显示 workspace 原名 */
  stepName: string | null;
  /** AI 生成的会话摘要（命中缓存；null = 尚未生成） */
  summary: string | null;
  /** 后端探测到该会话的 CLI 进程仍存活（外部 live；无终端标签可跳转） */
  live: boolean;
  /** 会话来源：普通 CLI 为 cli，Mesa 无头 AI 为 ccode-ai。 */
  source: string;
  /** 后端精确标记的 Mesa 内部 AI 会话。 */
  internal: boolean;
  /** 接力来源（P3 机制四）：该会话接自哪个 agent 的哪个会话；非接力会话为 null */
  handoffFromAgent: string | null;
  handoffFromSession: string | null;
  /** 归入的话题（卡片 = 对话的文件夹）；后端按项目回填卡片名，卡片删除后两者回落 null */
  taskId: string | null;
  taskName: string | null;
  /** Codex rollout 元信息的 model_provider："ccode" = Mesa 内联 provider 启动的会话，
   *  恢复时只能用带 Base URL 的配置（否则 codex 报 provider not found）；其他 agent 为 null */
  provider?: string | null;
  /** Mesa profile used to start this session, when the launch was observed by Mesa. */
  profileId: string | null;
  /** 从同一 agent 的哪条对话中途分出来（原对话分开后还在继续写）；直线接续已合并，不填 */
  forkedFrom?: string | null;
}

/** 会话瘦身检测结果（session_slim.rs，只读估算；level 由后端按请求体大小判定） */
export interface SlimInspectDto {
  /** false = 不是 Claude Code 会话文件 / 不在白名单内：不显示任何瘦身入口 */
  supported: boolean;
  fileBytes: number;
  /** false = 文件小，没扫描（下面的数字是 0，不代表没有图） */
  scanned: boolean;
  /** 下次请求会带上的截图/文档附件张数（最近一次压缩之后） */
  mediaCount: number;
  mediaBytes: number;
  /** 下次请求体估算字节数 */
  bodyBytes: number;
  level: "ok" | "warn" | "danger";
  /** 按默认保留数可移除多少张 */
  removable: number;
  keep: number;
  recentlyWritten: boolean;
}

export interface SlimApplyDto {
  removed: number;
  kept: number;
  bytesBefore: number;
  bytesAfter: number;
  bodyBefore: number;
  bodyAfter: number;
  backupPath: string;
}

export interface SessionSearchHitDto {
  agent: string;
  sessionId: string;
  score: number;
  snippet: string | null;
  matchedKeywords: string[];
}

/** 一条对话里的一处命中（一条消息算一处）；打开搜索结果时由 locate_session_matches 现算 */
export interface SessionMatchDto {
  /** jsonl 字节偏移 / OpenCode time_created，交给分页接口的 around */
  around: number | null;
  timestamp: string | null;
  role: string;
  snippet: string | null;
  score: number;
}

export interface SessionMatchesDto {
  /** 按对话里的先后顺序 */
  matches: SessionMatchDto[];
  /** 最该先看的那处（整句 > 词最全 > 最早） */
  best: number | null;
  truncated: boolean;
  keywords: string[];
}

export interface SessionSearchResultDto {
  hits: SessionSearchHitDto[];
  /** 还没建好索引的对话条数（后台在建）；>0 时结果可能不全 */
  pending: number;
}

export interface SessionExportKey {
  agent: string;
  sessionId: string;
  filePath: string;
  title: string | null;
  projectPath: string;
  provider?: string | null;
  pinned: boolean;
  customTitle: string | null;
  tags: string[];
  summary: string | null;
}

export interface ImportPreviewEntryDto {
  index: number;
  agent: string;
  sessionId: string;
  title: string | null;
  projectPath: string;
  /** 会话文件里的真实 cwd；工作区会话可能与 projectPath（主仓）不同 */
  cwd: string | null;
  provider: string | null;
  status: "ok" | "needs-path" | "conflict" | "unsupported" | string;
  reason: string | null;
  needsClientRegister: boolean;
}

export interface CodexBindingDto {
  id: string;
  name: string;
  baseUrl: string | null;
  hasKey: boolean;
}

export interface ImportPreviewDto {
  exportedAt: string;
  appVersion: string;
  entries: ImportPreviewEntryDto[];
  codexBindings: CodexBindingDto[];
}

export interface ImportDecisionDto {
  index: number;
  skip: boolean;
  targetDir: string | null;
}

export interface ImportItemReportDto {
  index: number;
  agent: string;
  sessionId: string;
  status: string;
  reason: string | null;
}

export interface ImportReportDto {
  imported: number;
  skipped: number;
  failed: number;
  items: ImportItemReportDto[];
  registerNote: string | null;
}

/** 接力目标（handoff_targets）：各 CLI 的安装与启动注入支持情况 */
export interface HandoffTargetDto {
  id: string;
  installed: boolean;
  /** false（目前仅 kimi）= 无交互注入参数，简报路径需手动发送 */
  promptSupported: boolean;
}

/** build_handoff_brief 返回：简报文件路径 + 一句话概述 */
export interface HandoffBriefDto {
  filePath: string;
  summary: string;
}

export interface BlockDto {
  /** command / command_output：Claude 斜杠命令、! 命令及其本地输出（sessions.rs claude_command_block） */
  kind: "text" | "thinking" | "tool_use" | "tool_result" | "command" | "command_output";
  text: string;
  toolName: string | null;
  /** 工具结果被 CLI 自己标成出错（Claude 的 is_error；没出错不带这个字段） */
  isError?: boolean;
  /** 工具调用 id（tool_use / tool_result 两头都带，按它配对；来源没有就不带，退回按顺序配对） */
  callId?: string;
}

export interface ChatMessageDto {
  role: string;
  blocks: BlockDto[];
  timestamp: string | null;
  usage: TokenUsageDto | null;
  /** 来源给的消息 id（Claude 行 uuid、Codex 条目 id …）：稳定身份，没有就不带 */
  id?: string;
  /** 仅前端乐观消息：上一轮还在生成时发出、CLI 排队待处理（会话文件记下后由解析结果替换，不再带这个标记） */
  queued?: boolean;
}

export interface ConversationPageDto {
  messages: ChatMessageDto[];
  /** 下一页上界：文件会话为字节偏移，OpenCode 为 time_created。 */
  cursor: number | null;
}

/** 任务工作区（§6.10）：一条 ccode/<name> 分支 + 一个 git worktree */
export interface SetupResultDto {
  ok: boolean;
  outputTail: string;
}

export interface WorkspaceDto {
  id: string;
  repoPath: string;
  repoName: string;
  name: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  portBase: number;
  status: "creating" | "active" | "archived";
  createdAt: string;
  archivedAt: string | null;
  /** 「合并（保留工作区）」后置位：已合并进基准分支的时间；继续提交后按 ahead>0 隐藏 */
  mergedAt: string | null;
  /** 上游漂移提醒（启发式）：上游步骤晚于本步最后推进时间合并时，回填该上游步骤名 */
  staleUpstream: string | null;
  /** 仅创建时返回：setup 脚本执行结果（失败不阻断创建） */
  setupResult: SetupResultDto | null;
  projectId?: string | null;
}

/** 引用健康检查（check_citation_health）：.md 引用键对照 references.bib 的可解析统计 */
export interface CitationHealthDto {
  totalRefs: number;
  resolved: number;
  missing: string[];
  bibFound: boolean;
}

/** 端口运行时监控（portwatch.rs）：一条 LISTEN 端口及其归属 */
export interface PortInfoDto {
  port: number;
  protocol: string;
  pid: number;
  process: string;
  /** 进程工作目录（Windows 端恒为 null） */
  cwd: string | null;
  ownerKind: "workspace" | "project" | "range" | "other";
  /** 白话归属文案（工作区 · xxx / 项目 · xxx / 端口段 … / 系统/其他），直接展示 */
  ownerLabel: string;
}

export interface RepoDto {
  path: string;
  name: string;
  /** 该仓库最近一条会话的更新时间；用于“最近项目”稳定排序。 */
  lastActive: string | null;
}

/** 项目级 .ccode/settings.toml 三层合并结果（W2） */
export interface RunScriptDto {
  name: string;
  command: string;
  default: boolean;
}

export interface WsSettingsDto {
  filesToCopy: string[];
  runMode: string;
  setup: string | null;
  archive: string | null;
  run: RunScriptDto[];
}

export type ResearchWorkspaceRef = Pick<WorkspaceDto, "id" | "repoPath" | "worktreePath" | "status">;
export interface ResearchSourceDto {
  root: string;
  projectId: string | null;
  resultVersion: string;
  revision: string;
  warnings: string[];
}

export interface ResearchRunDto {
  id: string;
  workspaceId: string;
  worktreePath: string;
  command: string[];
  entry: string;
  entryRevision: string | null;
  input: string;
  outputDir: string;
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputs: string[];
  resultFile: string | null;
  startedAt: string;
  finishedAt: string | null;
  projectId?: string | null;
  resultVersion?: string | null;
  sourceRevision?: string | null;
  sourceChanged?: boolean;
  resultRevision?: string | null;
}

export interface ResearchAcceptedFile {
  path: string;
  revision: string;
}

export interface ResearchAcceptanceDto {
  verdict: "accept" | "accept_with_conditions" | "return" | string;
  stepName: string;
  workspaceId: string;
  files: ResearchAcceptedFile[];
  conclusionScope: string;
  openBlockers: string[];
  runId: string | null;
  createdAt: string;
  projectId?: string | null;
  resultVersion?: string | null;
  sourceRevision?: string | null;
  sourceRoot?: string | null;
  sourceRunId?: string | null;
}

export interface GitFileDto {
  path: string;
  /** "M" | "A" | "D" | "R" | "??" */
  status: string;
  additions: number | null;
  deletions: number | null;
}

/** 保存历史时间线条目（project_history：当前分支 first-parent 主线） */
export interface HistoryEntryDto {
  hash: string;
  /** ISO 8601 提交时间 */
  time: string;
  author: string;
  /** 提交信息首行 */
  message: string;
  /** numstat 汇总；merge commit 无 diff，恒为 0 */
  files: number;
  additions: number;
  deletions: number;
  merge: boolean;
  /** 并入的分支名（解析不到为空串） */
  mergedBranch: string;
}

/** 工作区任务累计 diff（merge-base(base, branch) 为基准，W3） */
export interface WorkspaceDiffDto {
  inWorkspace: boolean;
  workspaceId: string;
  workspaceName: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  mergeBase: string;
  files: GitFileDto[];
  totalAdd: number;
  totalDel: number;
  /** 无头/定时 Run 的只读评审视图，不对应科研 workspaces 记录。 */
  reviewOnly?: boolean;
}

/** 人工事项（步骤的人机分工清单，声明在 project.toml steps[].human_tasks）：
 *  引擎不识语义（科研语义只进模板），只做文本/路径透传 */
export interface HumanTaskDto {
  /** 一句话说明（checklist 条目文本） */
  title: string;
  /** 引导说明（渠道选项等，只告知不推荐）；空串 = 无 */
  guidance: string;
  /** 交付落点（相对项目根/工作树）：目录（结尾 /）、精确文件、或「目录/通配」；
      空串 = 纯脑力事项，只能手动勾选 */
  target: string;
  /** 时机：before（开工前）| during（并行）| after（收尾） */
  timing: string;
  /** 可选事项：不做也不影响这一步跑完；缺省 false = 必办 */
  optional?: boolean;
  /** 完成判定：exists = 落点出现即检测完成；manual = 必须人工确认；
   * all = 目标通配/清单全部满足；no_placeholders = 文件存在且不含待填占位；
   * decisions_cleared = 裁决清单每条的「裁决：」都已填、且无「待裁决」。 */
  completion?: "exists" | "manual" | "all" | "no_placeholders" | "decisions_cleared";
  /** all 的显式目标总数；缺省时仅对 papers/*.pdf 从 to-fetch.md 推导 */
  expectedCount?: number;
  /** all 的目标清单；每行一个目标，空行与 # 注释行不计数 */
  manifestPath?: string;
}

/** 人工事项派生状态（list_human_task_states）：后端统一计算 done；显式取消会压过落点检测结果。 */
export interface HumanTaskStateDto {
  step: string;
  title: string;
  guidance: string;
  target: string;
  timing: string;
  /** 可选事项：流程线标「可选」，且不计入「N 件待做」 */
  optional?: boolean;
  /** 落点位置检测到文件 */
  detected: boolean;
  /** 落点命中的文件数（v3.97，目录/通配现算、两侧根取 max；未命中/空 target 无此字段） */
  hitCount?: number;
  /** 待获取清单总篇数（v3.97，仅 papers/*.pdf 落点且存在 to-fetch.md 时有） */
  expectedCount?: number;
  /** 后端采用的完成判定口径 */
  completion?: "exists" | "manual" | "all" | "no_placeholders" | "decisions_cleared";
  /** 人手动勾成完成（勾了系统不再追问） */
  manual: boolean;
  /** 人手动取消过。自动完成不得把它勾回来。 */
  explicitCancel: boolean;
  done: boolean;
}

/** import_human_deliverable 返回：复制落位 + 提货单登记结果（登记失败不否决复制） */
export interface ImportDeliverableDto {
  destPath: string;
  destRel: string;
  destRoot: string;
  registered: boolean;
  registerError: string | null;
}

/** agent 人工请求（.ccode/help-wanted.md 约定文件，list_help_requests 返回） */
export interface HelpRequestDto {
  /** 来源根（工作树根或主仓根） */
  root: string;
  workspaceId: string | null;
  workspaceName: string | null;
  repoName: string;
  items: string[];
}

/** 提货单 artifacts.yaml 条目（§11.3 机制五）：产物本体不进 git，清单随分支提交传递 */
export interface ArtifactEntryDto {
  name: string;
  /** 绝对路径 */
  path: string;
  /** md5 hex */
  hash: string;
  size: number;
  /** 产出工作区名 */
  producedBy: string;
  createdAt: string;
}

/** 工作区健康度（ReadyToMerge 判定输入，W3） */
export interface WorkspaceHealthDto {
  uncommitted: boolean;
  ahead: number;
  behind: number;
  /** 与 base 是否冲突；无法判定时为 null */
  conflict: boolean | null;
  /** 冲突文件清单（conflict 为 true 时非空） */
  conflictFiles: string[];
  /** 主仓库未停在基准分支 */
  mainOffBase: boolean;
  /** 主仓库有未提交改动 */
  mainDirty: boolean;
  /** 冲突现场已落后基准（MERGE_HEAD ≠ 基准 tip），需重新同步后再选边 */
  staleBase: boolean;
  readyToMerge: boolean;
  worktreeHead?: string | null;
  gitdirDetached?: boolean;
  /** 持久恢复记录需要补记；重新打开项目仍可找回。 */
  ledgerPending?: boolean;
}

/** 产物待核验（收件箱）：活跃工作区绑定步骤的预期产物已全部产出且够新 */
export interface PendingArtifactDto {
  workspaceId: string;
  workspaceName: string;
  repoName: string;
}

export interface WorkspaceDriftIssueDto {
  code:
    | "creating_incomplete"
    | "repo_missing"
    | "branch_missing"
    | "worktree_missing"
    | "worktree_unregistered"
    | "worktree_branch_mismatch"
    | "archived_worktree_present"
    | "merge_in_progress";
  message: string;
}

export interface WorkspaceDriftDto {
  healthy: boolean;
  issues: WorkspaceDriftIssueDto[];
  canRemount: boolean;
  canRelocate: boolean;
  canMarkArchived: boolean;
  canCleanRecord: boolean;
  canResolveMerge: boolean;
}

/** git 提交/推送的分阶段结果；push 失败时 committed 仍为 true。 */
export interface GitCommitResultDto {
  committed: boolean;
  pushed: boolean;
  failedPhase: "push" | null;
  message: string;
  output: string;
  /** 提交短哈希（rev-parse --short HEAD；取不到为 null） */
  hash: string | null;
}

/** 本地合并/归档的分阶段结果；归档失败时 merged 仍为 true。 */
export interface WorkspaceDeliverableReviewDto {
  token: string;
  workspaceId: string;
  projectRoot: string;
  payloadDir: string;
  files: { path: string; size: number; sha256: string | null; disposition: "copy" | "protected" | "conflict" | "too_large" | "tracked" }[];
}

export interface WorkspaceMergeResultDto {
  merged: boolean;
  archived: boolean;
  failedPhase: "state" | "archive" | null;
  message: string;
  output: string;
  versionId?: string | null;
  reviewedSha?: string | null;
  ledgerWritten?: boolean;
  salvage?: { copied: string[]; conflicts: string[]; skippedProtected: string[]; failed: string[] };
}

/** 推送分支/创建 PR 的分阶段结果。 */
export interface WorkspacePrResultDto {
  pushed: boolean;
  prCreated: boolean;
  prUrl: string | null;
  failedPhase: "push" | "pr" | null;
  message: string;
}

/** 技能库条目（技能页）：apps 记录各 agent 的应用开关 */
export interface SkillDto {
  id: string;
  name: string;
  description: string;
  /** 可顶替的内置技能位（闭集=内置技能名；frontmatter provides 声明，list 时现算） */
  provides?: string[] | null;
  /** 合成溯源（「AI 优化另存」记录源技能名单；纯展示，不做运行时依赖） */
  derivedFrom?: { name: string; digest?: string | null }[] | null;
  /** builtin | ccode（Mesa 新建）| local（本地导入；旧数据含早期自建）| zip | github | discovered */
  source: string;
  repo: string | null;
  repoRef: string | null;
  repoSubdir: string | null;
  sourceRevision: string | null;
  apps: Record<string, boolean>;
  installedAt: string;
  /** 用户自定义分类（null = 未分类；内部列表分组字段） */
  category: string | null;
  /** 用户自定义标签（名称后展示的小 pill，最多 4 个；旧数据无此字段时用 ?? [] 兜底） */
  tags?: string[];
  /** 内容已与库版本不一致的副本（所在 agent id 列表；空 = 无漂移） */
  /** 副本过期的 agent（后端空数组时省略该字段） */
  staleCopies?: string[];
  /** 各 agent 的分发形态（"symlink" | "copy"；仅启用的 agent 有键） */
  appModes?: Record<string, string>;
  /** SKILL.md 正文提及 MCP 工具/服务器（后端内容扫描，serde camelCase） */
  mentionsMcp: boolean;
  /** SKILL.md frontmatter 声明的产物路径（目录带尾斜杠，list 时现算）；空/缺 = 未声明，不参与产物冲突检测 */
  outputs?: string[];
  /** SKILL.md frontmatter 声明的读取路径（口径同 outputs，list 时现算） */
  inputs?: string[];
  /** true = inputs/outputs 来自正文推断而非 frontmatter 声明（外部技能常见；提示按「推断」口径） */
  interfaceInferred?: boolean;
  /** 库目录内容摘要（list 时现算）：执行快照/项目上下文按它记录技能版本 */
  contentDigest?: string | null;
}

/** skill_md_path 返回：SKILL.md 绝对路径 + 技能库目录（◈ 优化开终端的 cwd） */
export interface SkillPathDto {
  mdPath: string;
  dir: string;
}

export interface SkillImportConflictDto {
  name: string;
  existingId: string | null;
  source: string;
  updateAvailable: boolean;
}

export interface SkillImportResultDto {
  added: string[];
  updated: string[];
  skipped: string[];
  conflicts: SkillImportConflictDto[];
}

export interface SkillUpdateDto {
  id: string;
  updateAvailable: boolean;
  currentRevision: string | null;
  latestRevision: string | null;
  message: string;
}

/** 未被纳管的已发现技能（各 agent 目录里已存在但不在库中） */
export interface DiscoveredSkillDto {
  name: string;
  description: string;
  path: string;
  fromAgent: string;
}

/** 用量统计（统计页） */
export interface UsageCardsDto {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  sessions: number;
  /** 计费范围（不含官方账号与内部活动）内已计价模型的份额合计 */
  costUsd: number | null;
  /** true = 计费桶里另含未计价模型的用量，costUsd 只是已计价份额 */
  costPartial: boolean;
  /** 计费范围内已计价模型的缓存读相对全价输入省下的钱；无定价缓存为 null */
  cacheSavingsUsd: number | null;
  /** 官方账号（订阅制）用量的 token 量：单列展示，不计入费用 */
  officialTokens: number;
  /** 内部活动（无头 AI / 定时巡检）的 token 量：单列展示，不计入费用 */
  internalTokens: number;
}

export interface UsageTrendDayDto {
  day: string;
  costUsd: number | null;
  costPartial: boolean;
  hasUsage: boolean;
}

export interface UsageTrendDto {
  days: UsageTrendDayDto[];
  rateUsdCny: number;
}

export interface UsageTopSessionDto {
  agent: string;
  sessionId: string;
  projectPath: string;
  title: string | null;
  tokens: number;
  costUsd: number | null;
  costPartial: boolean;
}

/** 活跃度热力图的单日行：四列主量只计非 internal（官方订阅计入）；
 *  official/internal 子计量仅供「显示内部活动」开关做展示层注记 */
export interface UsageActivityDayDto {
  /** 本机时区日期 YYYY-MM-DD；只出现有行的天，年份窗口零填由前端做 */
  day: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 当天非 internal 不重复会话数 */
  sessions: number;
  /** 其中官方订阅份额（四类合计），不参与计费 */
  officialTokens: number;
  /** 内部活动四类合计：不进格子着色与连续天数 */
  internalTokens: number;
  internalSessions: number;
  /** 与 usage_trend 同口径：无可计费行记 0，全未计价为 null（显示 ~） */
  costUsd: number | null;
  costPartial: boolean;
}

/** 全历史非零日序列：翻年/streak/开关全部前端推导，零重查 */
export interface UsageActivityDto {
  /** 查询时刻的本机日期（前端年份窗口与「今天」宽限的唯一今天出处） */
  today: string;
  /** 最早有记录的日子；空库为 null（区块不渲染） */
  firstDay: string | null;
  days: UsageActivityDayDto[];
  /** 增量索引刷新失败但返回了已建索引数据 */
  stale: boolean;
  /** 冷启动兜底：重建超预算仍在后台跑、先返回了旧数据（后台刷完发事件补拉） */
  refreshing: boolean;
}

/** 按 agent 的单日分解（四类合计；非 internal） */
export interface UsageDayAgentRowDto {
  agent: string;
  tokens: number;
  sessions: number;
}

/** 点格下钻的当日会话行：标题出站前已脱敏；无自定义名为 null（前端回落扫描标题/短 id） */
export interface UsageDaySessionDto {
  agent: string;
  sessionId: string;
  title: string | null;
  projectPath: string;
  tokens: number;
  official: boolean;
  internal: boolean;
  /** 仅可计费会话有估算费用；订阅/内部会话为 null */
  costUsd: number | null;
  costPartial: boolean;
}

/** 点格下钻：当日总量 + 按 agent 分解 + 会话列表 */
export interface UsageDayDetailDto {
  day: string;
  totals: UsageActivityDayDto;
  /** tokens 降序 */
  byAgent: UsageDayAgentRowDto[];
  /** 四类合计降序，internal 沉底 */
  sessions: UsageDaySessionDto[];
}

/** 按 agent 拆分的年矩阵（筛选胶囊用） */
export interface UsageActivityAgentsDayDto {
  day: string;
  byAgent: UsageDayAgentRowDto[];
}

export interface UsageActivityAgentsDto {
  year: number;
  /** 该年出现过的非 internal agent（按年总量降序） */
  agents: string[];
  days: UsageActivityAgentsDayDto[];
}

export interface AgentUsageDto {
  agent: string;
  tokens: number;
  costUsd: number | null;
  costPartial: boolean;
  /** 统计范围内该 agent 用过的不同模型数 */
  modelCount: number;
  /** 官方账号（订阅制）用量：不按量计费，费用栏显示「订阅」 */
  official: boolean;
}

export interface ProjectUsageDto {
  projectPath: string;
  tokens: number;
  sessions: number;
  costUsd: number | null;
  costPartial: boolean;
  /** 后端登记的来源，例如 cli / ccode-ai。 */
  source: string;
  internal: boolean;
  /** 官方账号（订阅制）用量：不按量计费，费用栏显示「订阅」 */
  official: boolean;
}

export interface ModelUsageDto {
  model: string;
  input: number;
  output: number;
  costUsd: number | null;
  costPartial: boolean;
  source: string;
  internal: boolean;
}

/** 任务成本：usage 落在某工作区 worktree 内的部分按工作区成桶 */
export interface WorkspaceUsageDto {
  workspaceName: string;
  /** 所属项目（仓库）名 */
  repoName: string;
  tokensIn: number;
  tokensOut: number;
  /** 已计价模型份额合计；全部不明价为 null（显示 ~） */
  cost: number | null;
  costPartial: boolean;
  /** 统计范围内用过的不同模型数 */
  models: number;
  internal: boolean;
  /** 官方账号（订阅制）用量：不按量计费，费用栏显示「订阅」 */
  official: boolean;
}

/** 按天的 token 与费用（升序）：统计页趋势线用 */
export interface UsageDayDto {
  /** 本机日期 YYYY-MM-DD */
  day: string;
  input: number;
  output: number;
  costUsd: number | null;
  costPartial: boolean;
}

export interface UsageStatsDto {
  cards: UsageCardsDto;
  daily: UsageDayDto[];
  byAgent: AgentUsageDto[];
  byProject: ProjectUsageDto[];
  byModel: ModelUsageDto[];
  /** 按工作区/任务归因的成本（仅含命中工作区的用量，按 token 降序） */
  byWorkspace: WorkspaceUsageDto[];
  /** 美元→人民币汇率（官方价换算用，默认 7.2） */
  rateUsdCny: number;
}

/** Zotero 进料口（只读适配器，不做文献库）：探测结果 */
export interface ZoteroCollectionDto {
  id: number;
  name: string;
  /** 该分类下的条目数（不含附件与笔记） */
  count: number;
}

export interface ZoteroLibraryDto {
  dbPath: string;
  storageDir: string;
  collections: ZoteroCollectionDto[];
  /** 全库条目数（含未分类） */
  total: number;
}

export const AGENTS = [
  { id: "claude-code", label: "Claude Code", binary: "claude" },
  { id: "codex", label: "Codex", binary: "codex" },
  { id: "gemini", label: "Gemini CLI", binary: "gemini" },
  { id: "qwen", label: "Qwen Code", binary: "qwen" },
  { id: "opencode", label: "OpenCode", binary: "opencode" },
  { id: "kimi", label: "Kimi Code", binary: "kimi" },
  { id: "codebuddy", label: "CodeBuddy", binary: "codebuddy" },
  { id: "cursor", label: "Cursor", binary: "cursor-agent" },
  { id: "grok", label: "Grok Build", binary: "grok" },
] as const;

/** 多协议 agent 的协议选项与默认值（其余 agent 返回 null，profile 不存协议） */
export const AGENT_PROTOCOLS: Record<string, { options: string[]; default: string }> = {
  qwen: { options: ["openai", "anthropic"], default: "openai" },
  kimi: { options: ["kimi", "anthropic", "openai"], default: "kimi" },
};

/** 项目注册表条目（§11.4 P1b；app.db projects 表） */
export interface ProjectDto {
  /** 稳定身份（uuid，存 project.toml 顶层 id 行，跟随文件夹移动）；空串 = 旧项目尚未分配 */
  id?: string;
  /** canonical 绝对路径，注册表主键 */
  path: string;
  name: string;
  createdAt: string | null;
  lastOpenedAt: string | null;
  /** research / coding / office；缺省 research */
  workMode?: string;
  /** 项目级默认 Agent；密钥与 profile 不落在项目注册表。 */
  defaultAgent?: string | null;
  /** Agent id → 项目默认 profile id；只保存引用。 */
  defaultProfiles?: Record<string, string>;
  /** Agent id → 本项目在该默认连接里选用的模型。空 = 用连接名单的第一个。 */
  defaultModels?: Record<string, string>;
  /** 槽位 → 专属绑定（固定用途单独指一条连接+模型，agent 跟随连接；键见
   *  project-agents.ts READER_BINDING_SLOT 等，与后端 PROJECT_AGENT_BINDING_SLOTS 同源） */
  taskBindings?: Record<string, { profile: string; model?: string | null }>;
}

/** 档案卡 .ccode/project.toml 的资源条目 */
export interface ProjectResourceDto {
  name: string;
  path: string;
  /** paper | dataset | reference | other */
  type: string;
  readonly: boolean;
  note: string;
}

export interface ProjectStepRunDto {
  name: string;
  command: string;
  default: boolean;
}

/** 步骤决策项（模板预置的「开工前要拍板的选择题」）：答案可枚举的走这里——点一下就答完，
 *  不开会话；真正开放、需要来回讨论的留在 discussionSeeds。同样不进 TASK.md：
 *  答案选定后写进任务书草稿，草稿才是开工合同 */
export interface StepDecisionDto {
  /** 问题（短句，不带问号） */
  q: string;
  /** 可选答案，首项即推荐值（「全部用推荐值」按首项一键应用）；后端保证非空 */
  options: string[];
}

/** 档案卡流水线步骤：工作区名/简报/技能/预期产物/人工事项均为可编辑预设 */
export interface ProjectStepDto {
  name: string;
  workspaceName: string;
  brief: string;
  expectedArtifacts: string[];
  /** 人可核对的内容级验收条件；路径存在只是最低门槛。 */
  acceptanceCriteria?: string[];
  /** 决策暂停：auto_continue | soft_pause | hard_pause */
  decisionMode?: "auto_continue" | "soft_pause" | "hard_pause" | string;
  /** 结构化输入依赖；相对项目根路径或上游提货单路径。缺省兼容旧配置。 */
  inputs?: string[];
  /** 可选输入：存在则读取，不存在不阻断步骤。 */
  optionalInputs?: string[];
  /** 输入二选一/多选一组：每组至少满足一项即可。 */
  anyOfInputs?: string[][];
  skills: string[];
  /** 必须执行的技能子集；未列出的挂载技能按可选处理。 */
  requiredSkills?: string[];
  run: ProjectStepRunDto[];
  /** 资源绑定：[[resources]] 条目的 path；空/缺省 = 绑定全部资源（向后兼容旧后端与旧配置） */
  resources?: string[];
  /** 人工事项（人机分工清单）；缺省 = 无（向后兼容旧后端与旧配置） */
  humanTasks?: HumanTaskDto[];
  /** 讨论种子（模板预置的「开工前建议想清楚的问题」）：卡片区按步骤列出，点击即聊；不进 TASK.md */
  discussionSeeds?: string[];
  /** 决策项（可枚举的拍板点，点选即答）；缺省 = 无（向后兼容旧后端与旧配置） */
  decisions?: StepDecisionDto[];
  /** 这一步主要由谁出场：ai（AI 干活，你验收）| you（要你出场）| both（协作）；缺省 ai。
   *  只影响界面角色标记，不参与流程判定 */
  role?: string;
  /** 「这一步要先拍板文献从哪来」（模板声明）：流程线「定方向」节点里出现
   *  文献来源选择器 + 就地导入入口，答案写 config.litSource。
   *  与 decisions 分属两类——decisions 写草稿只做记录，这条写项目配置且带动作 */
  asksLitSource?: boolean;
  /** 预置完成：产物已在主仓（示例课题检索步），步进器视为已完成。真建了工作区后以工作区为准 */
  seedComplete?: boolean;
}

export interface TaskDraftDto {
  relPath: string;
  text: string | null;
  revision: string | null;
}

export interface ProjectConfigDto {
  /** 课题主题：一键开步写进 TASK.md「课题主题」段；可空 */
  topic?: string | null;
  /** 项目规则：贯穿全程的决定（综述角度/篇幅/读者/文风，以及默认行为规则）。
   *  每条一行；随 Context Pack / TASK.md 下发。 */
  settings?: string[];
  /** 人在规则编辑器里保存过完整列表。未置位时启动仍补工作方式默认规则。 */
  rulesOwned?: boolean;
  /** 验收写回时拒绝覆盖的相对路径（目录或文件）。有研究步骤的科研不在界面展示。 */
  protectedPaths?: string[];
  artifactDir: string;
  resources: ProjectResourceDto[];
  steps: ProjectStepDto[];
  /** 「不使用研究流程」显式标记：true = 隐藏模板引导横幅；选 true 时同时清空步骤表。选模板后后端自动清回 false */
  pipelineOptOut?: boolean;
  /** 文献来源：search（默认，让 agent 系统检索）| zotero | folder。
   *  后两者 = 用户已有文献库，TASK.md 会加「文献来源」段把检索步骤降级为「盘点 + 查漏补缺」。
   *  缺省 = search（向后兼容旧后端与旧配置） */
  litSource?: string;
  /** 投稿流程分支：initial = 首投，revision = 返修。缺省表示尚未选择。 */
  submissionMode?: "initial" | "revision";
  /** 当前返修轮次；首投不使用。 */
  submissionRound?: number;
  /** 文献雷达筛选：新命中展示与推送计数按期刊指标过滤；null/全空 = 不筛选 */
  litWatchFilter?: LitWatchFilterDto | null;
  /** 项目技能池（技能库 name）：仅无流程科研 / 办公 / 编程进上下文包；有研究步骤的科研不用此字段 */
  skills?: string[];
  /** 工作方式：research / coding / office；缺省 research */
  workMode?: string;
  /** 对话注入：＋新对话 / 问 AI 的 session 包开关。auto = 自动生成（缺省）；
   *  custom = 按模板（占位符开对话时填入）；off = 不注入。
   *  只管 session 包；开工/验收后写入/编程车道 goal 的目标包不受影响。 */
  sessionInjectionMode?: "auto" | "custom" | "off";
  /** 自定义模板全文；空 = 未编辑（按 auto 处理）。占位符清单见 project-context.ts SESSION_TEMPLATE_VARS。 */
  sessionInjectionTemplate?: string;
}

export interface AcceptedGoalStatusDto {
  name: string;
  outputs: string[];
  note?: string;
}

export interface ProjectStatusDto {
  accepted: AcceptedGoalStatusDto[];
}

/** 文献雷达筛选（存 project.toml；设了条件而指标未知的条目不显示，口径见 lit-watch.ts entryPassesFilter） */
export interface LitWatchFilterDto {
  /** 只看 IF ≥ 此值的期刊；null/缺省 = 不限 */
  minIf?: number | null;
  /** 只收中科院 N 区及以上（1 = 仅 1 区 … 4 = 不限）；null/缺省 = 不限 */
  maxCasQuartile?: number | null;
  /** 只要中科院 Top 期刊 */
  topOnly?: boolean;
}

/** 话题（list_task_cards 等）：挂在项目下的「对话文件夹」，无独立状态机 */
export interface TaskCardDto {
  /** "t-<短随机>"，项目内唯一 */
  id: string;
  /** 卡片名（同项目内唯一，大小写敏感） */
  name: string;
  /** 挂到的流水线步骤名（steps[].name）；未挂为 null */
  step: string | null;
  /** 开工后绑定的工作区名（预留字段，后端暂无写入入口） */
  workspace: string | null;
  /** 卡片种类：draft = 服务于任务书草稿的讨论卡；idea = 自由想法卡（只读纯聊、结论可追加进任务书）。
   *  旧卡缺 kind 时后端按 step 推断回填（step 非空 → draft，否则 idea） */
  kind: "idea" | "draft";
  createdAt: string;
}

/** read_project_config 返回：坏字段不阻断，逐条进 warnings */
export interface ProjectConfigReadDto {
  config: ProjectConfigDto;
  warnings: string[];
}

/** 用户另存的流水线模板（list/save/delete_pipeline_template）；内置模板在前端 pipeline-presets.ts */
export interface PipelineTemplateDto {
  id: string;
  name: string;
  description: string;
  steps: ProjectStepDto[];
  createdAt: string;
}

/** append_pipeline_steps 返回：实际追加步数 + 因步骤名重复跳过的步骤名 + 工作区改名明细 */
export interface AppendStepsResultDto {
  appended: number;
  skipped: string[];
  /** 工作区名冲突时自动加后缀，避免模板步骤被静默丢弃 */
  renamed: { name: string; from: string; to: string }[];
}

export interface DiscoveredResourceDto {
  /** 相对项目根，统一正斜杠 */
  path: string;
  /** paper | dataset | reference */
  type: string;
  size: number;
  mtime: string | null;
  /** 已在 project.toml 资源清单里登记过 */
  exists: boolean;
}

export interface EnsureGitDto {
  /** 本次执行了 git init */
  initialized: boolean;
  /** 本次新建了 .gitignore */
  gitignoreWritten: boolean;
}

export interface BootstrapCommitDto {
  /** 本次是否产生了提交 */
  committed: boolean;
  /** 实际提交的文件（相对仓库根，仅 .ccode 与 .gitignore 内） */
  paths: string[];
}

export interface CodingWorktreeDto {
  path: string;
  branch: string;
  isPrimary: boolean;
  isBase: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
  unpushed: number;
  hasUpstream: boolean;
  detached: boolean;
  lastCommitAt?: string | null;
  dirtyCount?: number;
  upstreamBehind?: number;
  /** 打开改动时记下的 worktree HEAD，合并时作 expectReviewedSha */
  head?: string | null;
  /** 持久恢复记录需要补记；重新打开项目仍可找回。 */
  ledgerPending?: boolean;
}

export interface CodingBranchDto {
  name: string;
  worktreePath: string | null;
  isPrimary: boolean;
  isBase: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
  unpushed: number;
  hasUpstream: boolean;
  upstreamBehind?: number;
}

export type CodingOpCode =
  | "ok"
  | "branch_exists"
  | "worktree_busy"
  | "invalid_url"
  | "no_origin"
  | "not_github"
  | "no_upstream"
  | "not_worktree"
  | "ff_only"
  | "desktop_missing"
  | "gh_unauth"
  | "git_failed";

export type CodingOpPhase = "add" | "fetch" | "push" | "pr" | "open" | null;

export interface CodingOpDto {
  ok: boolean;
  code: CodingOpCode;
  failedPhase: CodingOpPhase;
  message: string;
  setUpstream?: boolean;
  createdInitialCommit?: boolean;
  method?: "github-cli" | "macos-open" | "gh-view" | "gh-create-web" | "compare-url";
  url?: string | null;
  tried?: string[];
  worktree?: CodingWorktreeDto | null;
}

export interface CodingRemoteDto {
  name: string;
  url: string;
  display: string;
  hostKind: "github" | "other";
}

export interface CodingRemoteBranchDto {
  remote: string;
  name: string;
  hasLocal: boolean;
  occupiedPath: string | null;
}

export interface CodingOverviewDto {
  repoPath: string;
  baseBranch: string;
  isRepo: boolean;
  worktrees: CodingWorktreeDto[];
  branches: CodingBranchDto[];
  createdInitialCommit?: boolean;
  merging?: boolean;
  mergingCwd?: string | null;
  origin?: CodingRemoteDto | null;
  remoteBranches?: CodingRemoteBranchDto[];
  lanes?: CodingLaneDto[];
}

export interface CodingMergeDto {
  merged: boolean;
  conflict: boolean;
  cwd: string;
  message: string;
  code?: "ok" | "base_not_checked_out";
  versionId?: string | null;
  reviewedSha?: string | null;
  ledgerWritten?: boolean;
}

export interface OfficeDocDto {
  path: string;
  name: string;
  rel: string;
  size: number;
  modified: string | null;
}

/** MCP server 清单项（src-tauri/src/mcp.rs；分发规格 = docs/agent-integration-matrix.md §10） */
export interface McpEnvPair {
  key: string;
  /** 字面值，或 $VAR / ${VAR} 引用环境变量（不落明文密钥） */
  value: string;
}

/** MCP 密钥栏尾号（list_mcp_env_secrets）；不含密钥本体 */
export interface McpEnvSecretHintDto {
  name: string;
  /** 如 ···Y41 */
  hint: string;
}

export interface McpServerDto {
  id: string;
  /** [A-Za-z0-9-]（下划线禁：gemini policy 引擎按下划线切分） */
  name: string;
  kind: "stdio" | "remote";
  command: string;
  args: string[];
  cwd: string;
  env: McpEnvPair[];
  url: string;
  headers: McpEnvPair[];
  /** agent id → 是否分发到其用户级配置 */
  apps: Record<string, boolean>;
  /** 全局启用开关（v3.93）：false = 已从所有 agent 移除条目但保留分发映射，重开按原样重投 */
  enabled: boolean;
  /** 来源标记：ccode = 本应用新建；imported:<agent> = 收编；imported:json = 粘贴导入；
   *  空串 = 旧数据来源未知，删除分流按收编条目对待（mcp.rs） */
  origin: string;
  /** 慢启动 server 的启动超时声明（毫秒，可空）：收编 codex/grok 的 startup_timeout_sec
   *  自动带入，也可在编辑表单手调；只被体检消费（按 8–30s clamp 生效） */
  startupTimeoutMs?: number | null;
  /** 最近一次体检沉淀（单条/批量检测都会更新，随清单落盘） */
  lastCheck?: McpLastCheckDto | null;
}

/** 相对路径命令的修复候选（resolve_mcp_command_fix）：
 *  解析出的绝对路径命令 + 规范化后的工作目录（相对 cwd 已改成命中基准目录） */
export interface McpCommandFixCandidate {
  command: string;
  cwd: string;
}

/** 最近一次连通性体检的沉淀（随 mcp-servers.json 落盘） */
export interface McpLastCheckDto {
  /** ISO 时间戳（UTC） */
  at: string;
  ok: boolean;
  latencyMs: number;
  /** 失败原因；成功为 null */
  error: string | null;
}

/** check_mcp_server 返回：连通性健康检测（v3.93） */
export interface McpHealthDto {
  ok: boolean;
  /** 握手/请求耗时（毫秒） */
  latencyMs: number;
  /** 失败原因；成功为 null */
  error: string | null;
  /** stdio = serverInfo.name@version；remote = HTTP 状态行 */
  detail: string | null;
  /** 状态细分（闭集，与 src-tauri/src/mcp.rs McpHealthDto 同源）：
   *  handshake = MCP initialize 握手成功；reachable = 地址可达但握手未确认；
   *  auth = 认证失败（401/403）；not_found = 路径错误（404）；error = 其余失败 */
  status: "handshake" | "reachable" | "auth" | "not_found" | "error";
}

// ===== 能力表（src-tauri/src/agent_specs.rs agent_capabilities） =====

export interface CapabilityFlagDto {
  supported: boolean;
  /** 不支持时的用户可见原因（fail-loud） */
  reason?: string;
}

/** 九家三项能力一览：前端置灰/提示与后端报错同源，不另维护硬编码 */
export interface AgentCapabilitiesDto {
  agent: string;
  setGlobal: CapabilityFlagDto;
  mcpWrite: CapabilityFlagDto;
  skillDist: { mode: "symlinkOrCopy" | "copyOnly"; reason?: string };
  requestPolicy: {
    temperature: "supported" | "unsupported" | "unknown";
    topP: "supported" | "unsupported" | "unknown";
    maxOutputTokens: "supported" | "unsupported" | "unknown";
    reasoningEffort: "supported" | "unsupported" | "unknown";
    customHeaders: "supported" | "unsupported" | "unknown";
  };
  /** reasoningEffort 已知档位集（非空 = 表单出下拉，空 = 自由输入） */
  effortOptions: string[];
  /** 想法期只读硬保护（readonly_args 非空） */
  readonly: CapabilityFlagDto;
  /** 无头/定时写盘：不支持则禁选；支持但有 reason 则当附注（grok 无沙箱） */
  headlessWrite: CapabilityFlagDto;
  /** local_cli / headless；cloud 不预研 */
  runtimeKinds: string[];
}

export interface RunDto {
  id: string;
  projectRoot: string | null;
  taskKind: string;
  taskRef: string | null;
  isolationPath: string;
  runtime: string;
  agent: string;
  profileId: string | null;
  permission: string;
  reuseKey: string | null;
  sessionId: string | null;
  internal: boolean;
  sentinel: boolean;
  createdAt: string;
  closedAt: string | null;
  status: "created" | "starting" | "running" | "completed" | "failed" | "stopped";
  exitCode: number | null;
  closeReason: string | null;
  /** 归属的 Task；旧记录可能为空字符串。 */
  taskId: string;
  /** Custom Runtime 的稳定配置 id；普通 Runtime 为 null。 */
  customRuntimeId: string | null;
  capabilities: RuntimeCapabilitiesDto;
}

/** 持久化用户意图；科研流程步骤仍以 project.toml 为真相，只有实际使用时才 materialize。 */
export interface TaskDto {
  id: string;
  projectRoot: string | null;
  kind: string;
  taskRef: string | null;
  name: string;
  description: string;
  status: string;
  inputPaths: string[];
  outputPaths: string[];
  reviewRequired: boolean;
  archivedAt: string | null;
  agent: string | null;
  profileId: string | null;
  /** 目标绑定的模型（B2；空 = 该连接名单第一） */
  model?: string | null;
  createdAt: string;
  updatedAt: string;
  /** 人在「新建任务」里声明的步骤。会话/开步自动登记的为 false。 */
  declared?: boolean;
  /** 最近一次验收写回的相对路径。 */
  adoptedPaths?: string[];
  /** 本目标点名的技能（新建目标时从项目技能池勾选）；空 = 不点名 */
  skills?: string[];
  /** 项目稳定 id（双写中；旧数据可能为空） */
  projectId?: string | null;
  pendingApplyRunId?: string | null;
  workspaceCleared?: boolean;
  reviewCleared?: boolean;
  storageCleanupPending?: boolean;
}

export interface TaskStorageUsageDto {
  bytes: number;
  files: number;
  directories: number;
}
export interface TaskStorageReviewDto {
  taskId: string;
  workspace: TaskStorageUsageDto;
  review: TaskStorageUsageDto;
  revision: string;
  blockedReason: string | null;
  reviewBlockedReason: string | null;
  pending: { id: string; scope: "workspace" | "review" } | null;
}

/** 长期验收账本 `.ccode/acceptance-log.jsonl` 的一行（只读展示） */
export interface AcceptanceLogEntryDto {
  goalId: string;
  goalName: string;
  runId: string;
  paths: string[];
  note: string;
  frozen: boolean;
  decidedAt: string;
  kind?: string;
  versionId?: string;
  reviewedSha?: string | null;
  projectId?: string | null;
  sceneRef?: string | null;
}

export interface RunEventDto {
  id: string;
  runId: string;
  eventType: string;
  payload: string | null;
  createdAt: string;
}

export interface TaskOutputChangeDto {
  path: string;
  kind: "added" | "modified" | "deleted" | string;
  bytes: number;
  tooLarge?: boolean;
}

/** 目标评审：frozen=true 时变更来自收尾冻结副本，预览与采纳只读 payloadDir。 */
export interface TaskReviewDto {
  frozen: boolean;
  payloadDir: string | null;
  /** 冻结版本号（回合再冻结递增）；采纳时回传绑定「看过的那版」 */
  seq?: number | null;
  changes: TaskOutputChangeDto[];
  freezeRequired?: boolean;
  readiness?: "none" | "reviewable" | "blocked" | "applied" | "ledger_pending";
  pendingApply?: { id: string; versionId: string; paths: string[]; phase: string; note: string; memorize: boolean } | null;
}

/** 开工时冻结的有效上下文快照（Context Pack + 目标行全文）。 */
export interface TaskContextDto {
  runId: string;
  createdAt: string;
  sha256: string;
  text: string;
  environment?: { projectId: string | null; projectRoot: string; isolationPath: string; agent: string; permission: string; inputPaths: string[]; outputPaths: string[]; files: { path: string; copySize?: number }[]; skills: { name: string; libraryDigest: string; runtimeDigest: string | null }[]; warnings: string[] } | null;
}

export interface RuntimeCapabilitiesDto {
  canResume: boolean;
  canStop: boolean;
  streamsOutput: boolean;
  canReview: boolean;
  resumeReason: string | null;
}

export interface RunArtifactDto {
  path: string;
  kind: string;
  producerRunId: string;
  expected: boolean;
  reviewStatus: string;
}

export interface CustomRuntimeDto {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  createdAt: string;
}

export interface CodingLaneDto {
  id: string;
  repoPath: string;
  name: string;
  theme: string | null;
  branch: string;
  worktreePath: string;
  currentRunId: string | null;
  projectId?: string | null;
}

// ===== 定时雷达（src-tauri/src/scheduler.rs） =====

/** 单次运行记录（status: "ok" | "error"；at 为 ISO 时间） */
export interface RunRecordDto {
  at: string;
  status: string;
  /** 脱敏后截断的简报/错误信息 */
  summary: string;
  /** 本次巡检的新命中数（仅 lit-watch 类任务成功时有值；老记录缺省） */
  newEntries?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  /** 本次运行时间窗内写入的隔离树相对路径（最多 50 条） */
  artifacts?: string[];
  runId?: string | null;
  isolationPath?: string | null;
  /** 隔离树产物是否已采纳进主仓 */
  adopted?: boolean;
}

  /** 定时任务（serde camelCase）；默认 lit-watch，也可运行技能库中的其它技能 */
export interface ScheduleDto {
  id: string;
  runningRunId?: string | null;
  /** 到点该跑但还没跑起来（并发上限或同项目互斥在等）；排队中标记的数据源 */
  queued?: boolean;
  name: string;
  /** 项目根绝对路径（任务 cwd） */
  projectRoot: string;
  skill: string;
  /** null = 每次运行现解析（设置页 AI 专用 profile → 最近使用） */
  profileId: string | null;
  /** 任务钉住的模型（B3）：在所选连接名单内生效；null = 名单第一 */
  model?: string | null;
  /** "daily" | "weekly" */
  frequency: string;
  /** weekly 时 1-7（周一=1）；daily 忽略 */
  weekday: number | null;
  hour: number;
  minute: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  /** 旧字段。2026-09-29 起界面不再设置；保存时写 null 清掉。 */
  linkedStep?: string | null;
  /** 最近 20 条，新的在前 */
  history: RunRecordDto[];
}

export interface CreateScheduleInput {
  name?: string;
  projectRoot: string;
  skill?: string;
  profileId?: string | null;
  /** 任务钉住的模型；空 = 名单第一 */
  model?: string | null;
  frequency: string;
  weekday?: number | null;
  hour: number;
  minute: number;
  /** 固定不传。旧客户端若还带着，后端仍能收下，界面不再提供。 */
  linkedStep?: string | null;
}

/** 更新补丁：字段全可选（不传 = 不改）。profileId 清掉必须传**空串**——后端 Option<Option>
 *  语义下显式 null 与缺失同为「不改」（scheduler.rs 测试钉死），发 null 的清除会静默失效 */
export interface UpdateSchedulePatch {
  name?: string;
  skill?: string;
  profileId?: string | null;
  frequency?: string;
  weekday?: number | null;
  hour?: number;
  minute?: number;
  enabled?: boolean;
  /** 传 null 清掉旧的关联步骤。 */
  linkedStep?: string | null;
}

/** 新建巡检技能：确认落盘前的草稿（.ccode/drafts/watch-*.meta.json） */
export interface WatchSkillDraftDto {
  id: string;
  name: string;
  skillName: string;
  intent: string;
  frequency: string;
  weekday: number | null;
  hour: number;
  minute: number;
  profileId: string | null;
  linkedStep?: string | null;
  draftRelPath: string;
  hasDraft: boolean;
  draftText?: string | null;
}

/** scheduler-run-done 事件载荷（summary 已脱敏） */
export interface SchedulerRunDonePayload {
  scheduleId: string;
  projectRoot: string;
  scheduleName: string;
  skill: string;
  newEntries?: number | null;
  status: string;
  summary: string;
  /** 本次运行改动过的文件（changed_artifacts，相对项目根） */
  artifacts?: string[];
}

/** 应用数据占用（设置页「数据与存储」） */
export interface StorageEntryDto {
  label: string;
  path: string;
  bytes: number;
  exists: boolean;
  /** 可清理（快照/备份/缓存）；配置与索引一律 false */
  clearable: boolean;
  /** 清理用的条目键（配置目录下的相对名；工作副本为 ~worktrees / ~workspaces） */
  id: string;
  /** 统计达到条目上限提前收手：bytes 是下限，显示「≥」 */
  approx: boolean;
  /** config = Mesa 配置目录；home = 当前家目录（默认 ~/ccode）下的工作副本；
   *  home-old = 换位置前遗留在旧家目录里的工作副本 */
  root: "config" | "home" | "home-old";
}

/** 用量里出现过、但查不到价格的模型（设置页「自定义定价」待补清单） */
export interface UnpricedModelDto {
  model: string;
  tokens: number;
  lastDay: string;
}
