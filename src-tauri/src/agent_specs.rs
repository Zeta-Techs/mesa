//! 适配器注册表（P1d，架构 §11.4）：一个 CLI 一张声明式 AgentSpec。
//! 散落在 agents / skills / updater / profile_validation 的 per-agent 硬编码收敛到这里，
//! 各模块从注册表读规格；会话/usage 解析器不可数据化，保持每 CLI 一段格式代码（sessions.rs / usage.rs）。
//!
//! 新增 CLI checklist：
//! 1. 在 AGENT_SPECS 加一张规格（纯数据）——检测/启动/恢复/技能分发/安装更新/协议校验自动生效；
//!    set_global/mcp_write/skill_dist 三项能力按支持面照实填（不支持必须带用户可见原因，fail-loud）
//! 2. 启动注入形态若 Env / ByProtocol 表达不了，在 SpecialLaunch 加变体并在 agents::launch_plan 加分支
//! 3. 会话/usage 格式：在 sessions.rs / usage.rs 写该 CLI 的解析器（注册表只做分发入口）
//! 4. 补本文件完整性测试里的 id 清单

use serde::Serialize;

/// 一个 Agent CLI 的完整规格
pub struct AgentSpec {
    /// agent id：profile.agent、前端路由键、会话/usage DTO 的 agent 字段
    pub id: &'static str,
    /// 展示名（后端错误消息用；前端显示名/图标另行维护，不在本表）
    pub display_name: &'static str,
    /// CLI 二进制名（resolve_binary 的解析对象）
    pub binary: &'static str,
    /// 版本探测参数（统一超时由 agents::VERSION_QUERY_TIMEOUT 控制）
    pub version_args: &'static [&'static str],
    /// profile.protocol 的合法取值，第一个为缺省；空 = 该 CLI 无协议概念（不校验）
    pub protocols: &'static [&'static str],
    /// 启动注入规则（launch_plan 的差异化数据来源）
    pub launch: LaunchSpec,
    /// 交互模式初始 prompt 注入方式（一键开步的首条指令）
    pub prompt_inject: PromptInject,
    /// 「聊想法」只读模式的启动参数（2026-08-12 本机 --help 实测；空 = 不支持，只有 prompt 软约束）：
    /// claude/codebuddy --permission-mode plan、codex -s read-only（替换默认 workspace-write，
    /// 见 agents::readonly_launch_args）、gemini --approval-mode plan、kimi/cursor --plan；
    /// qwen 0.21.1 无 approval/plan 参数、opencode 无据，保持空
    pub readonly_args: &'static [&'static str],
    /// 聊天输入框权限徽标的各家原生权限档（2026-10-17 用户：各家权限开关加上；同日照 ChatGPT 收成四档）：(档, 追加参数)。
    /// 档是 Mesa 统一名：ask = 请求批准（改文件、跑命令前都问）、auto = 帮我批准（AI 判断哪些安全自动放行，
    /// 有风险的才问：Claude/CodeBuddy/Grok/Qwen `auto`、Codex `--approve-for-me`、Cursor `--auto-review`、
    /// Kimi `--yolo`「Ask When Needed」）、full = 完全访问；只讨论走 readonly_args。不在表里 = 这家没有该档的
    /// 启动参数，徽标里置灰。2026-10-17 本机 `--help` 实测（gemini 本机未装，按官方文档；Claude 2.1.292 的
    /// default 实测显示为 manual）。codex 的 ask / auto 保留 Mesa 默认的 `-s workspace-write`；full 先剔除原 -s
    /// 再追加（agents::permission_launch_args）。只作用于本次进程的命令行，不写任何 CLI 配置文件
    pub permission_args: &'static [(&'static str, &'static [&'static str])],
    /// 支持 --session-id 固定新会话文件名（pty 启动即锁定会话关联，matrix：claude-code、qwen、codebuddy）
    pub fixed_session_id: bool,
    /// 按 ID 恢复会话的参数格式
    pub resume: ResumeSpec,
    /// 技能分发目录（相对用户 home 的路径段）；symlink/copy 是运行时回退策略，不是 per-agent 数据
    pub skills_dir: &'static [&'static str],
    /// 安装与更新渠道
    pub packaging: PackagingSpec,
    /// 官方账号（P1a）：终端内登录、只读检测 auth 文件、拉起时净化残留 API env；
    /// 数据按 matrix / 官方文档 / 实机 CLI 逐家核实（opencode 无官方账号语义，保持 None 见注释）
    pub official_account: Option<OfficialAccountSpec>,
    /// 运行中模型切换（终端状态栏模型菜单用）：往 PTY 写 TUI 命令的形态。
    /// Direct 带参直切（claude `/model <name>`、gemini `/model set <id>` 实证）；
    /// Picker 唤出 TUI 选择器由用户完成（codex `/model`、kimi `/models`、opencode `/models`）；
    /// None = 未核实/无机制（qwen/codebuddy/cursor/grok），状态栏不显示模型菜单
    pub model_switch: ModelSwitch,
    /// 运行中思考档调节（终端状态栏「◈ 思考」用）：(档位表, 命令模板 "/effort {level}")；
    /// 档位表为空 = picker 形态（命令唤出 TUI 选择器）。None = 无机制不显示控件。
    /// claude /effort 带参直切实证；kimi /effort on|off 直切实证（档位随模型，布尔模型
    /// 只有 on/off）；codex 的 effort 在其 /model 选择器内（快捷键默认键位未核实，不单列）
    pub effort_levels: Option<(&'static [&'static str], &'static str)>,
    /// TUI 的 Enter 需要 CSI-u 形式（kitty 键盘协议：应用 push flags 后只认 \x1b[13u，
    /// 普通 \r 不提交）。kimi = true（0.36.1 实证）；xterm.js 不支持该协议，
    /// Mesa 在 xterm 键盘层与状态栏写入两处改写
    pub submit_csi_u: bool,
    /// 「设为全局默认」写配置文件能力（global_config.rs plan_writes 的分发依据）
    pub set_global: SetGlobalCap,
    /// MCP 分发写入能力（mcp.rs apply_to_agent 的拒写依据；只读清单解析不受限）
    pub mcp_write: McpWriteCap,
    /// 技能分发方式（skills.rs allow_symlink_for 的判定依据）
    pub skill_dist: SkillDist,
    /// 该 CLI 对应的 GUI 客户端（client_open.rs 的接力规格）。空 = 没有可接力的客户端：
    /// gemini / qwen / opencode / kimi / codebuddy / cursor / grok 本期都为空，原因与分档见
    /// docs/design-client-handoff.md §1（无客户端、存储不共享，或只能打开项目，后续分期补）
    pub clients: &'static [ClientSpec],
}

/// 一个 GUI 客户端的接力规格。深链模板里 `{session}` / `{path}` 由 client_open.rs 校验后代入
pub struct ClientSpec {
    /// 客户端 id（前端路由键、日志、诊断）
    pub id: &'static str,
    /// 界面展示名
    pub display: &'static str,
    /// 会话级深链；None = 客户端不能按会话 id 定位（只有项目级）
    pub session_url: Option<&'static str>,
    /// 项目级深链：在该目录新开对话；None = 不支持
    pub project_url: Option<&'static str>,
    /// 客户端注册的 URL scheme（macOS 读 Info.plist、Windows 查注册表来判断是否已安装）
    pub scheme: &'static str,
    /// macOS bundle id（Spotlight 兜底找应用）
    pub mac_bundle_ids: &'static [&'static str],
    /// macOS 应用名（/Applications 与 ~/Applications 下的 .app，不含扩展名）
    pub mac_app_names: &'static [&'static str],
    /// Windows 应用包名（MSIX 包全名的前段，如 OpenAI.Codex_26.1013.4894.0_x64__… 的 OpenAI.Codex）：
    /// 读版本用（2026-10-20 本机核实：两家 Windows 客户端都是 MSIX 包，scheme 注册在 HKCR 下）
    #[cfg_attr(not(windows), allow(dead_code))]
    pub win_package_names: &'static [&'static str],
    /// 下载页（未安装时给用户的出口）；没有把握的不填
    pub download_url: Option<&'static str>,
    /// 渠道（API 配置）如何到达客户端
    pub channel: ChannelPolicy,
}

/// 渠道到达客户端的方式；决定预检里「渠道」一项怎么判
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelPolicy {
    /// 客户端只认自己配置文件里有定义的渠道（codex：config.toml 的 model_providers）。
    /// Mesa 用 -c 内联的渠道客户端不认识，需先写入定义块
    RegisteredProvider,
    /// 客户端用它自己的账号 / 推理配置继续，不会带上 Mesa 里选的网关（claude 桌面版）
    OwnAccount,
}

/// 「设为全局默认」能力：把 profile 写入 CLI 自己的配置文件
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetGlobalCap {
    /// global_config::plan_writes 有该 agent 的写计划
    Supported,
    /// 不支持；值为直接给用户看的原因（fail-loud，不静默降级）
    Unsupported(&'static str),
}

/// MCP 分发写入能力
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpWriteCap {
    /// 读-改-写分发全支持
    Full,
    /// 只读清单可解析、分发/写入拒绝；值为直接给用户看的原因
    ReadOnly(&'static str),
}

/// 技能分发方式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillDist {
    /// symlink 优先、失败回退 copy
    SymlinkOrCopy,
    /// 强制 copy；值为直接给用户看的原因
    CopyOnly(&'static str),
}

/// 官方账号规格（P1a）：终端内登录、只读检测 auth 文件、拉起时净化残留 API env
pub struct OfficialAccountSpec {
    /// 终端内执行的登录子命令（不含二进制名）；空 = 裸启动 CLI 后在 TUI 内操作
    ///（gemini 无登录子命令；qwen 的 auth 子命令 0.21 起已移除，只能 TUI 内 /auth）
    pub login_cmd: &'static [&'static str],
    /// 只读探测「已连接」的 auth 文件（相对用户 home）；以 `/*` 结尾 = 扫描该目录的
    /// 直接子级 *.json（kimi credentials/<name>.json 文件名随 provider 名变化；不进子目录）
    pub auth_file_paths: &'static [&'static str],
    /// 官方账号拉起时必须 env_remove 的残留 API 密钥变量（防静默覆盖账号登录）
    pub env_purge_list: &'static [&'static str],
    /// 冲突探测（P1a 增强）：CLI 自己读的配置文件里残留 API 密钥会静默覆盖官方账号登录，
    /// env_remove 只清进程环境变量管不到文件，状态检测时逐文件扫描并告警（只读，只报变量名不读值）
    pub conflict_probes: &'static [ConflictProbe],
    /// 文件检测的已知漏报场景说明（如凭证存 OS 钥匙串）；文件未检出时随 status 返回给界面
    pub detection_note: Option<&'static str>,
    /// API Key 模式字段：auth 文件中命中这些字段 = 用户配的是 API Key（官方或第三方端点），
    /// 不算官方账号登录（codex auth.json 的 OPENAI_API_KEY：codex login --api-key 与
    /// cc-switch 等第三方中转写出来的是同一形状，文件层面无法区分，不得显示「已连接官方账号」）
    pub api_key_fields: &'static [&'static str],
}

/// 一条冲突探测：某个配置文件中存在指定变量即视为会覆盖官方账号登录
pub struct ConflictProbe {
    /// 配置文件（相对用户 home）；按扩展名分格式：.env 走 KEY=VALUE 行解析，.json 只查顶层 env 对象
    pub file: &'static str,
    /// 命中即告警的变量名（大小写敏感，与 CLI 实际读取一致）
    pub keys: &'static [&'static str],
    /// 冲突后果说明（拼在每条告警文案后）
    pub note: &'static str,
}

/// 启动注入形态
pub enum LaunchSpec {
    /// 通用形态：base_url / 密钥 / 选中模型分别注入 EnvInject 指定的 env 名
    Env(EnvInject),
    /// 多协议：按 profile.protocol 选一张注入表；不在表内（或缺省）用第一张
    ByProtocol(&'static [ProtocolEnv]),
    /// 无法纯数据化的特殊注入（env 名等数据仍在这里，分支逻辑留在 agents::launch_plan）
    Special(SpecialLaunch),
}

/// 运行中模型切换的 TUI 命令形态（终端状态栏模型菜单用）
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ModelSwitch {
    /// 带参直切：命令模板含 {model} 占位（claude `/model {model}`）
    Direct(&'static str),
    /// 唤出 TUI 选择器，由用户在终端里完成选择（kimi `/models`、codex `/model`）
    Picker(&'static str),
    /// 未核实/无机制：状态栏不显示模型菜单
    None,
}

/// 交互模式初始 prompt 的注入形态（一键开步首条指令）。
/// 各 CLI 传参方式本机 --help 已核实：claude/codex 吃位置参数，gemini/qwen 用 -i
///（--prompt-interactive，执行后继续交互）；kimi 无此参数——不得用 -p
///（那是非交互模式），填 Unsupported 让注入方跳过并提示用户手动发送。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PromptInject {
    /// 追加为命令行最后一个位置参数（claude "prompt"、codex "prompt"）
    Positional,
    /// 以 flag 传参（gemini/qwen：-i <prompt>）
    Flag(&'static str),
    /// 该 CLI 没有交互模式初始 prompt 参数（目前仅 kimi）
    Unsupported,
}

/// 通用 env 注入：None 表示该 CLI 没有对应 env（跳过）
pub struct EnvInject {
    pub base_url: Option<&'static str>,
    pub key: Option<&'static str>,
    pub model: Option<&'static str>,
    /// 无条件注入的固定 env
    pub fixed_env: &'static [(&'static str, &'static str)],
    /// 无条件追加的固定启动参数
    pub fixed_args: &'static [&'static str],
}

/// 一个协议的注入表（qwen：openai / anthropic）
pub struct ProtocolEnv {
    pub protocol: &'static str,
    pub env: EnvInject,
    /// 该协议追加的固定参数（如 --auth-type）
    pub args: &'static [&'static str],
}

/// 各家特殊注入形态（数据在这里，构造逻辑在 agents::launch_plan 的对应分支）
pub enum SpecialLaunch {
    /// claude-code：通用 env 注入 + 模型列表注册进 /model 选择器槽位
    /// （前 4 个别名槽 + 第 5 个 CUSTOM_MODEL_OPTION，见 matrix §1）
    ClaudeModelSlots(EnvInject),
    /// codex：没有 base URL 环境变量，用 -c 内联名为 ccode 的 Responses provider 并指到它
    CodexInlineProvider {
        key_env: &'static str,
        /// 默认沙箱参数（只写当前工作目录）
        sandbox_args: &'static [&'static str],
    },
    /// opencode：OPENCODE_CONFIG_CONTENT 内联配置 JSON（优先级高于 auth.json 和 env）
    OpenCodeInlineConfig {
        config_env: &'static str,
        /// 防自更新启动时替换掉检测到的二进制
        no_autoupdate_env: &'static str,
    },
    /// kimi：新旧两个产品共用 kimi 命令，新版 KIMI_MODEL_* 合成通道与旧版 KIMI_API_KEY 双写
    KimiDualChannel,
    /// cursor：密钥/端点走 env，模型没有对应 env、只能走 --model flag（支持 bracket 参数化，
    /// 如 claude-opus-4-8[context=1m,effort=high]）；端点是 Cursor 专有协议，非 OpenAI/Anthropic 兼容
    CursorFlags {
        key_env: &'static str,
        endpoint_env: &'static str,
        model_flag: &'static str,
    },
}

/// 按 ID 恢复会话的参数；args 里 {session} 占位会话 ID
pub struct ResumeSpec {
    /// codex 的 resume 是子命令需放最前，其余是位置无关的 flag
    pub prepend: bool,
    pub args: &'static [&'static str],
}

pub struct BrewPackage {
    pub name: &'static str,
    pub cask: bool,
}

/// 更新渠道（update_fallback 的顺序元素）
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum UpdateChannel {
    Brew,
    Npm,
    /// Windows 原生包管理器（仅 Windows 生效；包 ID 如 OpenAI.Codex）
    Winget,
    Uv,
    SelfUpdate,
}

/// 新旧双变体（kimi）：同一二进制两个产品，按数据目录探测，旧版走独立更新渠道
pub struct LegacyVariantSpec {
    /// 新版数据目录（相对 home，存在即新版）
    pub new_dir: &'static str,
    /// 旧版数据目录（相对 home）
    pub legacy_dir: &'static str,
    /// 旧版变体的更新渠道
    pub legacy_channel: UpdateChannel,
}

/// 安装与更新渠道；安装候选固定按 brew > npm > winget > uv > 官方脚本优先级
/// 排序（winget 仅 Windows；脚本兜底，仅无其他方式时用）
pub struct PackagingSpec {
    /// brew 安装包（install）
    pub brew_install: Option<BrewPackage>,
    /// brew 升级包（upgrade；opencode tap 安装后升级用短名，故与安装分开）
    pub brew_upgrade: Option<BrewPackage>,
    /// brew 最新版查询包（brew info）：tap 短名有歧义时用全名查询（opencode 用
    /// anomalyco/tap/opencode，唯一命中）。不声明的 agent 最新版落到 npm registry 比对，
    /// brew 用户会被 tap 滞后误报「永远有新版」
    pub brew_latest: Option<BrewPackage>,
    /// npm 全局安装包
    pub npm_install: Option<&'static str>,
    /// npm 升级包（kimi 的 npm 包装新二进制但升级走自更新，故与安装分开）
    pub npm_update: Option<&'static str>,
    /// winget 包 ID（仅 Windows；安装与升级同 ID，如 OpenAI.Codex）
    pub winget: Option<&'static str>,
    /// uv tool 包（安装与升级同名）
    pub uv: Option<&'static str>,
    /// 自更新子命令（不含二进制名）
    pub self_update: Option<&'static [&'static str]>,
    /// 自更新是方向键选择的交互式 TUI（kimi upgrade / opencode upgrade），
    /// 配置页更新的行输入（updater_write，只能应答 [y/n]）无法操作；
    /// 前端据此把更新路由到完整终端执行，不走 run_streaming_pty
    pub interactive_tui: bool,
    /// 官方安装脚本（bash -c 内容）
    pub install_script: Option<&'static str>,
    /// Windows 上的官方安装脚本（powershell -Command 内容）；None = Windows 不走脚本渠道
    pub install_script_win: Option<&'static str>,
    /// 安装脚本 URL 兼作最新版查询口：脚本正文烙着当前版本（如 cursor 的
    /// downloads.cursor.com/lab/<年.月.日-哈希>/ 下载地址），抓正文提取即可，
    /// 无包管理器渠道也能判定「已最新」；None = 脚本不带版本，不查
    pub script_latest: Option<&'static str>,
    /// 安装方式非 brew/npm/uv 命中包管理器时的更新渠道顺序（首个成功即止）
    pub update_fallback: &'static [UpdateChannel],
    /// 新旧双变体（仅 kimi）
    pub legacy_variant: Option<LegacyVariantSpec>,
}

const NO_PACKAGING: PackagingSpec = PackagingSpec {
    brew_install: None,
    brew_upgrade: None,
    brew_latest: None,
    npm_install: None,
    npm_update: None,
    winget: None,
    uv: None,
    self_update: None,
    interactive_tui: false,
    install_script: None,
    install_script_win: None,
    script_latest: None,
    update_fallback: &[],
    legacy_variant: None,
};

const CLAUDE_ENV: EnvInject = EnvInject {
    base_url: Some("ANTHROPIC_BASE_URL"),
    key: Some("ANTHROPIC_AUTH_TOKEN"),
    model: Some("ANTHROPIC_MODEL"),
    fixed_env: &[],
    fixed_args: &[],
};

const OPENAI_ENV: EnvInject = EnvInject {
    base_url: Some("OPENAI_BASE_URL"),
    key: Some("OPENAI_API_KEY"),
    model: Some("OPENAI_MODEL"),
    fixed_env: &[],
    fixed_args: &[],
};

const ANTHROPIC_ENV: EnvInject = EnvInject {
    base_url: Some("ANTHROPIC_BASE_URL"),
    key: Some("ANTHROPIC_API_KEY"),
    model: Some("ANTHROPIC_MODEL"),
    fixed_env: &[],
    fixed_args: &[],
};

static AGENT_SPECS: &[AgentSpec] = &[
    AgentSpec {
        id: "claude-code",
        display_name: "Claude Code",
        binary: "claude",
        version_args: &["--version"],
        protocols: &[],
        launch: LaunchSpec::Special(SpecialLaunch::ClaudeModelSlots(CLAUDE_ENV)),
        prompt_inject: PromptInject::Positional,
        readonly_args: &["--permission-mode", "plan"],
        permission_args: &[("ask", &["--permission-mode", "default"]), ("auto", &["--permission-mode", "auto"]), ("full", &["--permission-mode", "bypassPermissions"])],
        fixed_session_id: true,
        resume: ResumeSpec { prepend: false, args: &["-r", "{session}"] },
        skills_dir: &[".claude", "skills"],
        packaging: PackagingSpec {
            brew_install: Some(BrewPackage { name: "claude-code", cask: true }),
            brew_upgrade: Some(BrewPackage { name: "claude-code", cask: true }),
            brew_latest: Some(BrewPackage { name: "claude-code", cask: true }),
            npm_install: Some("@anthropic-ai/claude-code"),
            npm_update: Some("@anthropic-ai/claude-code"),
            winget: Some("Anthropic.ClaudeCode"),
            self_update: Some(&["update"]),
            install_script: Some("curl -fsSL https://claude.ai/install.sh | bash"),
            update_fallback: &[UpdateChannel::SelfUpdate, UpdateChannel::Brew],
            ..NO_PACKAGING
        },
        // matrix §1 + 官方文档核实：auth 子命令族 login/logout/status；
        // macOS 凭证存系统钥匙串不落文件，.credentials.json 仅 Linux/Windows 有
        official_account: Some(OfficialAccountSpec {
            login_cmd: &["auth", "login"],
            auth_file_paths: &[".claude/.credentials.json"],
            env_purge_list: &["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
            // matrix §1：settings.json 的 env 块覆盖 shell env；matrix 未确认 claude 读 .claude/.env，不探测
            conflict_probes: &[ConflictProbe {
                file: ".claude/settings.json",
                keys: &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
                note: "settings.json 的 env 块会覆盖官方账号登录，产生 API 计费",
            }],
            detection_note: Some("macOS 上凭证存于系统钥匙串，文件检测可能漏报，以 claude auth status 为准"),
            api_key_fields: &[],
        }),
        model_switch: ModelSwitch::Direct("/model {model}"),
        effort_levels: Some((&["low", "medium", "high", "xhigh", "max"], "/effort {level}")),
        submit_csi_u: false,
        set_global: SetGlobalCap::Supported,
        mcp_write: McpWriteCap::Full,
        skill_dist: SkillDist::SymlinkOrCopy,
        clients: &[ClientSpec {
            id: "claude-desktop",
            display: "Claude 桌面版",
            // resume = 把 ~/.claude/projects 里的 CLI 会话导入桌面版 Code 标签（Claude.app 2.42 源码核实）
            session_url: Some("claude://resume?session={session}"),
            project_url: Some("claude://code/new?folder={path}"),
            scheme: "claude",
            mac_bundle_ids: &["com.anthropic.claudefordesktop"],
            mac_app_names: &["Claude"],
            win_package_names: &["Claude"],
            download_url: Some("https://claude.ai/download"),
            channel: ChannelPolicy::OwnAccount,
        }],
    },
    AgentSpec {
        id: "codex",
        display_name: "Codex",
        binary: "codex",
        version_args: &["--version"],
        protocols: &[],
        launch: LaunchSpec::Special(SpecialLaunch::CodexInlineProvider {
            key_env: "CODEX_API_KEY",
            sandbox_args: &["-s", "workspace-write"],
        }),
        prompt_inject: PromptInject::Positional,
        readonly_args: &["-s", "read-only"],
        permission_args: &[("ask", &["-a", "on-request"]), ("auto", &["--approve-for-me"]), ("full", &["-a", "never", "-s", "danger-full-access"])],
        fixed_session_id: false,
        resume: ResumeSpec { prepend: true, args: &["resume", "{session}"] },
        skills_dir: &[".codex", "skills"],
        packaging: PackagingSpec {
            brew_install: Some(BrewPackage { name: "codex", cask: true }),
            brew_upgrade: Some(BrewPackage { name: "codex", cask: true }),
            brew_latest: Some(BrewPackage { name: "codex", cask: true }),
            npm_install: Some("@openai/codex"),
            npm_update: Some("@openai/codex"),
            // Windows 无 Node.js 时的原生渠道（portable zip，无需管理员）；实机包 ID 已核实
            winget: Some("OpenAI.Codex"),
            update_fallback: &[UpdateChannel::Npm, UpdateChannel::Winget],
            ..NO_PACKAGING
        },
        // matrix §2 已核实；login status / doctor 命令复用同一 login 子命令族。
        // 登录走设备码（--device-auth，0.152.1 核实）：内嵌 PTY 里浏览器回调常写不出
        // auth.json；设备码在终端打印 user code，与 cc-switch 官方登录同路、由 CLI 自己完成。
        official_account: Some(OfficialAccountSpec {
            login_cmd: &["login", "--device-auth"],
            auth_file_paths: &[".codex/auth.json"],
            env_purge_list: &["CODEX_API_KEY", "OPENAI_API_KEY"],
            // 磁盘 config.toml 的 model_provider 指向自定义网关会盖过 ChatGPT 登录。
            // ConflictProbe 不解析 TOML 顶层键，无法按变量名探测；官方启动用
            // `-c model_provider="openai"` 本进程盖过（见 apply_official_inject），不改用户文件。
            conflict_probes: &[],
            detection_note: Some("凭证也可能存于 OS 钥匙串（cli_auth_credentials_store），以 codex login status 为准"),
            // auth.json 顶层 OPENAI_API_KEY = API Key 模式（官方 --api-key 或第三方中转同一形状），
            // 不算官方账号连接
            api_key_fields: &["OPENAI_API_KEY"],
        }),
        model_switch: ModelSwitch::Picker("/model"),
        effort_levels: None,
        submit_csi_u: false,
        set_global: SetGlobalCap::Supported,
        mcp_write: McpWriteCap::Full,
        skill_dist: SkillDist::SymlinkOrCopy,
        clients: &[ClientSpec {
            id: "codex-desktop",
            display: "Codex 客户端",
            session_url: Some("codex://threads/{session}"),
            project_url: Some("codex://threads/new?path={path}"),
            scheme: "codex",
            // 内嵌于 ChatGPT.app（无独立 Codex.app，bundle id com.openai.codex，matrix §2）
            mac_bundle_ids: &["com.openai.codex"],
            mac_app_names: &["ChatGPT", "Codex"],
            win_package_names: &["OpenAI.Codex"],
            download_url: None,
            channel: ChannelPolicy::RegisteredProvider,
        }],
    },
    AgentSpec {
        id: "gemini",
        display_name: "Gemini",
        binary: "gemini",
        version_args: &["--version"],
        protocols: &[],
        launch: LaunchSpec::Env(EnvInject {
            base_url: Some("GOOGLE_GEMINI_BASE_URL"),
            key: Some("GEMINI_API_KEY"),
            model: Some("GEMINI_MODEL"),
            fixed_env: &[],
            fixed_args: &[],
        }),
        prompt_inject: PromptInject::Flag("-i"),
        readonly_args: &["--approval-mode", "plan"],
        permission_args: &[("ask", &["--approval-mode", "default"]), ("full", &["--approval-mode", "yolo"])],
        fixed_session_id: false,
        resume: ResumeSpec { prepend: false, args: &["-r", "{session}"] },
        skills_dir: &[".gemini", "skills"],
        packaging: PackagingSpec {
            brew_install: Some(BrewPackage { name: "gemini-cli", cask: false }),
            brew_upgrade: Some(BrewPackage { name: "gemini-cli", cask: false }),
            brew_latest: Some(BrewPackage { name: "gemini-cli", cask: false }),
            npm_install: Some("@google/gemini-cli"),
            npm_update: Some("@google/gemini-cli"),
            update_fallback: &[UpdateChannel::Npm],
            ..NO_PACKAGING
        },
        // matrix §3 + 官方文档/源码核实：无登录子命令，裸启动后 TUI 内 /auth 选 Sign in with Google
        // （login_cmd 空 = 终端标签只拉起 gemini）；凭证 oauth_creds.json，新版开加密存储时不落盘
        official_account: Some(OfficialAccountSpec {
            login_cmd: &[],
            auth_file_paths: &[".gemini/oauth_creds.json"],
            env_purge_list: &["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"],
            // 真实事故：cc-switch 把 GEMINI_API_KEY/GOOGLE_GEMINI_BASE_URL 写进 ~/.gemini/.env，
            // gemini CLI 启动时自行加载该文件（env 优先级仅次于 CLI 参数），静默覆盖 Google 登录走付费 API
            conflict_probes: &[ConflictProbe {
                file: ".gemini/.env",
                keys: &["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL"],
                note: "该文件中的密钥会覆盖官方账号登录，产生 API 计费",
            }],
            detection_note: Some("新版开启加密存储（GEMINI_FORCE_ENCRYPTED_STORAGE）时凭证不落该文件，可能漏报"),
            api_key_fields: &[],
        }),
        model_switch: ModelSwitch::Direct("/model set {model}"),
        effort_levels: None,
        submit_csi_u: false,
        set_global: SetGlobalCap::Supported,
        mcp_write: McpWriteCap::Full,
        skill_dist: SkillDist::SymlinkOrCopy,
        clients: &[],
    },
    AgentSpec {
        id: "qwen",
        display_name: "Qwen",
        binary: "qwen",
        version_args: &["--version"],
        protocols: &["openai", "anthropic"],
        launch: LaunchSpec::ByProtocol(&[
            ProtocolEnv { protocol: "openai", env: OPENAI_ENV, args: &["--auth-type", "openai"] },
            ProtocolEnv {
                protocol: "anthropic",
                env: ANTHROPIC_ENV,
                args: &["--auth-type", "anthropic"],
            },
        ]),
        prompt_inject: PromptInject::Flag("-i"),
        readonly_args: &[],
        permission_args: &[("ask", &["--approval-mode", "default"]), ("auto", &["--approval-mode", "auto"]), ("full", &["--approval-mode", "yolo"])],
        fixed_session_id: true,
        resume: ResumeSpec { prepend: false, args: &["-r", "{session}"] },
        skills_dir: &[".qwen", "skills"],
        packaging: PackagingSpec {
            brew_install: Some(BrewPackage { name: "qwen-code", cask: false }),
            brew_upgrade: Some(BrewPackage { name: "qwen-code", cask: false }),
            brew_latest: Some(BrewPackage { name: "qwen-code", cask: false }),
            npm_install: Some("@qwen-code/qwen-code"),
            npm_update: Some("@qwen-code/qwen-code"),
            update_fallback: &[UpdateChannel::Npm],
            ..NO_PACKAGING
        },
        // qwen 0.21.1 实机核实：`qwen auth` 子命令已移除（报 "Configure authentication (removed)"），
        // Qwen OAuth 只能交互式 TUI 内 /auth 配置（"OAuth cannot be configured with env vars alone"），
        // login_cmd 空 = 裸拉起进 TUI 操作；凭证 path.join(getGlobalQwenDir(), "oauth_creds.json")
        //（bundle 内 QWEN_CREDENTIAL_FILENAME 实证，gemini-cli 分叉同构）
        official_account: Some(OfficialAccountSpec {
            login_cmd: &[],
            auth_file_paths: &[".qwen/oauth_creds.json"],
            // matrix §4 凭证优先级 CLI flags > shell env > .env > settings env：purge 覆盖
            // Mesa 两条协议注入表的全部变量；DASHSCOPE_*/BAILIAN_* bundle 里存在但
            // Mesa 不注入、是否压 OAuth 登录态未核实，保守不收
            env_purge_list: &[
                "OPENAI_API_KEY",
                "OPENAI_BASE_URL",
                "OPENAI_MODEL",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_BASE_URL",
                "ANTHROPIC_MODEL",
            ],
            // bundle 实证 qwen 读 ~/.qwen/.env（gemini-cli 同构机制），残留密钥会接管 auth 走付费 API
            conflict_probes: &[ConflictProbe {
                file: ".qwen/.env",
                keys: &[
                    "OPENAI_API_KEY",
                    "OPENAI_BASE_URL",
                    "ANTHROPIC_API_KEY",
                    "ANTHROPIC_BASE_URL",
                ],
                note: "该文件中的密钥会覆盖官方账号登录，产生 API 计费",
            }],
            // matrix §4：Qwen OAuth 免费额度已于 2026-04 停；OAuth 本身仍在（/auth 可选）
            detection_note: Some("Qwen OAuth 免费额度 2026-04 已停，登录后按量计费；以 TUI 内 /doctor 的 auth 状态为准"),
            api_key_fields: &[],
        }),
        model_switch: ModelSwitch::None,
        // 0.22.0 bundle 实证 /effort 直切命令（写运行时 reasoning.effort；0.21.1 无此命令，
        // 旧版用户点状态栏档位会报未知命令——按现状如实标注，不另行版本门控）
        effort_levels: Some((&["low", "medium", "high", "xhigh", "max"], "/effort {level}")),
        submit_csi_u: false,
        set_global: SetGlobalCap::Supported,
        mcp_write: McpWriteCap::Full,
        skill_dist: SkillDist::SymlinkOrCopy,
        clients: &[],
    },
    AgentSpec {
        id: "opencode",
        display_name: "OpenCode",
        binary: "opencode",
        version_args: &["--version"],
        protocols: &[],
        launch: LaunchSpec::Special(SpecialLaunch::OpenCodeInlineConfig {
            config_env: "OPENCODE_CONFIG_CONTENT",
            no_autoupdate_env: "OPENCODE_DISABLE_AUTOUPDATE",
        }),
        // opencode 1.18.x exposes a top-level `--prompt` option for starting
        // an interactive session with an initial prompt.
        prompt_inject: PromptInject::Flag("--prompt"),
        readonly_args: &[],
        permission_args: &[("full", &["--auto"])],
        fixed_session_id: false,
        resume: ResumeSpec { prepend: false, args: &["--session", "{session}"] },
        skills_dir: &[".config", "opencode", "skills"],
        packaging: PackagingSpec {
            brew_install: Some(BrewPackage { name: "anomalyco/tap/opencode", cask: false }),
            brew_upgrade: Some(BrewPackage { name: "opencode", cask: false }),
            // 最新版查询用 tap 全名：短名 opencode 有歧义，全名唯一命中（2026-10-11 实测
            // brew info --json=v2 anomalyco/tap/opencode 返回 1 条 formula）。不声明时最新版
            // 落到 npm registry 比对，brew 用户刚升级完也永远显示「新版」（tap 滞后 npm：
            // 实测 brew 1.18.35 vs npm 1.19.0）；声明后按 brew 渠道比，npm 领先走「上游更前」提示。
            brew_latest: Some(BrewPackage { name: "anomalyco/tap/opencode", cask: false }),
            npm_install: Some("opencode-ai"),
            npm_update: Some("opencode-ai"),
            winget: Some("SST.opencode"),
            // 自更新是交互 TUI（方向键选择），仅非 brew/npm 安装时尝试（brew 装的走 brew 防冲突）
            self_update: Some(&["upgrade"]),
            interactive_tui: true,
            update_fallback: &[UpdateChannel::SelfUpdate, UpdateChannel::Npm],
            ..NO_PACKAGING
        },
        // opencode 1.18.10 实机调研结论：`opencode auth`（providers 别名）是多 provider 凭证管理器
        //（auth login/logout/list，凭证 ~/.local/share/opencode/auth.json，本机实测 0 credentials），
        // 没有单一「官方账号」语义——opencode zen 只是可登录的 provider 之一，auth login 是
        // 各家 key/OAuth 的通用入口；且 Mesa 的 OpenCodeInlineConfig（OPENCODE_CONFIG_CONTENT）
        // 优先级高于 auth.json，官方账号模式无从对应——保持 None 不硬加
        official_account: None,
        model_switch: ModelSwitch::Picker("/models"),
        effort_levels: None,
        submit_csi_u: false,
        set_global: SetGlobalCap::Supported,
        mcp_write: McpWriteCap::Full,
        skill_dist: SkillDist::SymlinkOrCopy,
        clients: &[],
    },
    AgentSpec {
        id: "kimi",
        display_name: "Kimi",
        binary: "kimi",
        version_args: &["--version"],
        protocols: &["kimi", "openai", "anthropic"],
        launch: LaunchSpec::Special(SpecialLaunch::KimiDualChannel),
        prompt_inject: PromptInject::Unsupported,
        readonly_args: &["--plan"],
        permission_args: &[("auto", &["--yolo"]), ("full", &["--auto"])],
        fixed_session_id: false,
        resume: ResumeSpec { prepend: false, args: &["-S", "{session}"] },
        skills_dir: &[".kimi-code", "skills"],
        packaging: PackagingSpec {
            npm_install: Some("@moonshot-ai/kimi-code"),
            // npm registry 与自更新渠道同版本发布：latest 查询口（自更新渠道本身没有轻量查询口）
            npm_update: Some("@moonshot-ai/kimi-code"),
            // winget 的是新版 Kimi Code CLI（非旧版 Python kimi-cli）
            winget: Some("MoonshotAI.KimiCodeCLI"),
            uv: Some("kimi-cli"),
            // kimi upgrade 是方向键选择的交互式 TUI，行输入无法应答（interactive_tui 的注释见 PackagingSpec）
            self_update: Some(&["upgrade"]),
            interactive_tui: true,
            install_script: Some("curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"),
            update_fallback: &[UpdateChannel::SelfUpdate],
            legacy_variant: Some(LegacyVariantSpec {
                new_dir: ".kimi-code",
                legacy_dir: ".kimi",
                legacy_channel: UpdateChannel::Uv,
            }),
            ..NO_PACKAGING
        },
        // 官方文档 + 本机 `kimi login --help` 核实：login 子命令走 RFC 8628 设备码（非交互可跑，
        // 验证 URL+user code 打 stderr 轮询），凭证与 TUI /login 同落点：
        // ~/.kimi-code/credentials/<name>.json（0600/目录 0700；managed provider 名 "managed:kimi-code"）。
        // 文件名随 provider 名走 → auth_file_paths 用 /* 目录扫描；credentials/mcp/ 子目录是
        // MCP 服务器凭证，不算 CLI 登录态（扫描不进子目录）。
        // purge：新版 CLI 明文不读 shell env 的 API key（官方文档），唯一能抢登录态的 env 是
        // KIMI_MODEL_* 合成通道（见 KimiDualChannel，env 合成的 provider 优先于 config 默认模型）；
        // 旧版变体读 KIMI_API_KEY/KIMI_BASE_URL——两组都 purge。
        official_account: Some(OfficialAccountSpec {
            login_cmd: &["login"],
            auth_file_paths: &[".kimi-code/credentials/*"],
            env_purge_list: &[
                "KIMI_MODEL_NAME",
                "KIMI_MODEL_PROVIDER_TYPE",
                "KIMI_MODEL_API_KEY",
                "KIMI_MODEL_BASE_URL",
                "KIMI_MODEL_DISPLAY_NAME",
                "KIMI_MODEL_CAPABILITIES",
                "KIMI_MODEL_MAX_CONTEXT_SIZE",
                "KIMI_API_KEY",
                "KIMI_BASE_URL",
            ],
            // config.toml 里手写的 providers.*.api_key 是独立 provider（需模型指向才生效），
            // 不会静默覆盖 OAuth managed provider；留空
            conflict_probes: &[],
            detection_note: Some("凭证文件名随 provider 名变化（credentials/<name>.json）；设了 KIMI_CODE_HOME 时数据目录整体搬迁，文件检测可能漏报"),
            api_key_fields: &[],
        }),
        // /model <别名> 带参直切（0.36.1 实证）：参数是 config.toml [models.*] 的别名
        //（非法字符清洗为 _），注入模式下模型没入表会报 Unknown model alias（TUI 可见）
        model_switch: ModelSwitch::Direct("/model {model}"),
        // /effort <level> 带参直切（0.36.1 实证；档位随模型，K3 等布尔模型只有 on/off，
        // 不支持的档会回报 Available 列表——kimi 没有 acceptsInput 的 /thinking 选择器是它的
        // TUI 内交互形态，/effort 才是命令行式入口）
        effort_levels: Some((&["on", "off"], "/effort {level}")),
        // kitty 键盘协议：kimi TUI 启动即 push flags（\x1b[>7u），之后只认 CSI-u 形式的
        // Enter（\x1b[13u），普通 \r 不提交（2026-08-17 pty 探针实证）——xterm.js 不支持
        // kitty 协议，Mesa 侧须把 Enter 改写成 CSI-u
        submit_csi_u: true,
        set_global: SetGlobalCap::Supported,
        mcp_write: McpWriteCap::Full,
        skill_dist: SkillDist::SymlinkOrCopy,
        clients: &[],
    },
    AgentSpec {
        id: "codebuddy",
        display_name: "CodeBuddy",
        binary: "codebuddy",
        version_args: &["--version"],
        protocols: &[],
        // v2.132.0 实测：只认 CODEBUDDY_* 环境变量（ANTHROPIC_* 无效），协议 Anthropic 兼容
        launch: LaunchSpec::Env(EnvInject {
            base_url: Some("CODEBUDDY_BASE_URL"),
            key: Some("CODEBUDDY_API_KEY"),
            model: Some("CODEBUDDY_MODEL"),
            fixed_env: &[],
            fixed_args: &[],
        }),
        prompt_inject: PromptInject::Positional,
        readonly_args: &["--permission-mode", "plan"],
        permission_args: &[("ask", &["--permission-mode", "default"]), ("auto", &["--permission-mode", "auto"]), ("full", &["--permission-mode", "bypassPermissions"])],
        // --session-id <uuid> 实测支持固定会话文件名
        fixed_session_id: true,
        // -r|--resume [sessionId] 可带 id；-c 是续最近（不带 id 的场景前端不用）
        resume: ResumeSpec { prepend: false, args: &["-r", "{session}"] },
        skills_dir: &[".codebuddy", "skills"],
        packaging: PackagingSpec {
            npm_install: Some("@tencent-ai/codebuddy-code"),
            npm_update: Some("@tencent-ai/codebuddy-code"),
            // codebuddy update 是非交互自更新
            self_update: Some(&["update"]),
            update_fallback: &[UpdateChannel::SelfUpdate, UpdateChannel::Npm],
            ..NO_PACKAGING
        },
        // TUI 内 /login 走浏览器 OAuth（分国际站/中国站）；实测 env 里残留 CODEBUDDY_API_KEY
        // 会压过账号登录（401 提示），官方账号拉起必须 env_remove
        official_account: Some(OfficialAccountSpec {
            login_cmd: &[],
            auth_file_paths: &[".codebuddy/.credentials.json"],
            env_purge_list: &["CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN"],
            conflict_probes: &[ConflictProbe {
                file: ".codebuddy/settings.json",
                keys: &["CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN", "CODEBUDDY_BASE_URL"],
                note: "settings.json 的 env 块会覆盖官方账号登录，产生 API 计费",
            }],
            detection_note: Some("登录走浏览器 OAuth（国际站 codebuddy.ai / 中国站 copilot.tencent.com），以 TUI 内 /login 后的状态为准"),
            api_key_fields: &[],
        }),
        model_switch: ModelSwitch::None,
        // CodeBuddy exposes --effort at launch; no runtime /effort command is assumed.
        effort_levels: None,
        submit_csi_u: false,
        set_global: SetGlobalCap::Supported,
        mcp_write: McpWriteCap::Full,
        skill_dist: SkillDist::SymlinkOrCopy,
        clients: &[],
    },
    AgentSpec {
        id: "cursor",
        display_name: "Cursor",
        // 不用 `agent`（太通用）；cursor-agent 是 legacy symlink 但稳定，
        // symlink 在 ~/.local/bin（resolve_binary 通用候选目录已覆盖）
        binary: "cursor-agent",
        version_args: &["--version"],
        // Cursor 专有协议，无 openai/anthropic 协议概念（第三方供应商预设无意义）
        protocols: &[],
        launch: LaunchSpec::Special(SpecialLaunch::CursorFlags {
            key_env: "CURSOR_API_KEY",
            endpoint_env: "CURSOR_API_ENDPOINT",
            model_flag: "--model",
        }),
        // 初始 prompt 是 argv 末尾位置参数；非交互模式为 -p/--print + --output-format
        prompt_inject: PromptInject::Positional,
        readonly_args: &["--plan"],
        permission_args: &[("auto", &["--auto-review"]), ("full", &["--force"])],
        fixed_session_id: false,
        // --resume <uuid> 必须带 id（无参会卡 Ink TUI）；--continue 续最近（前端不用）
        resume: ResumeSpec { prepend: false, args: &["--resume", "{session}"] },
        // 未验证 CLI 是否真读该目录，分发保守走 copy 模式（见下方 skill_dist 字段）
        skills_dir: &[".cursor", "skills-cursor"],
        packaging: PackagingSpec {
            // 无 brew/npm 官方包：官方安装脚本装到 ~/.local/share/cursor-agent/versions/<ver>/
            install_script: Some("curl -fsSL https://cursor.com/install | bash"),
            // Windows 原生安装器（2026-10-20 核实：装到 %LOCALAPPDATA%\cursor-agent，自带 node.exe，
            // 运行要 Git for Windows；此前文档只写 WSL）
            install_script_win: Some("irm 'https://cursor.com/install?win32=true' | iex"),
            // 安装脚本正文烙着当前版本（downloads.cursor.com/lab/<版本>/），作最新版查询口
            script_latest: Some("https://cursor.com/install"),
            // cursor-agent update 是非交互自更新
            self_update: Some(&["update"]),
            update_fallback: &[UpdateChannel::SelfUpdate],
            ..NO_PACKAGING
        },
        // login 走浏览器 OAuth；凭证默认 macOS 钥匙串，
        // 仅 AGENT_CLI_CREDENTIAL_STORE=file 时落 ~/.cursor/auth.json（双通道检测说明见 detection_note）
        official_account: Some(OfficialAccountSpec {
            login_cmd: &["login"],
            auth_file_paths: &[".cursor/auth.json"],
            env_purge_list: &["CURSOR_API_KEY"],
            // ~/.cursor 与 IDE 共享且 CLI 配置形态未核实，保守不探测配置文件冲突
            conflict_probes: &[],
            detection_note: Some("凭证默认存 macOS 钥匙串（仅设 AGENT_CLI_CREDENTIAL_STORE=file 时才落 auth.json），文件检测可能漏报，以 cursor-agent 实际登录态为准"),
            api_key_fields: &[],
        }),
        model_switch: ModelSwitch::None,
        effort_levels: None,
        submit_csi_u: false,
        set_global: SetGlobalCap::Unsupported(
            "Cursor 的全局配置写入未适配，首版仅支持启动注入",
        ),
        mcp_write: McpWriteCap::Full,
        skill_dist: SkillDist::CopyOnly(
            "~/.cursor/skills-cursor 未验证 CLI 是否真读、且 ~/.cursor 与 IDE 共享，保守强制 copy",
        ),
        clients: &[],
    },
    AgentSpec {
        id: "grok",
        display_name: "Grok Build",
        binary: "grok",
        version_args: &["--version"],
        protocols: &[],
        // xai-org/grok-build 源码调研（matrix §9）+ 1.0.5 实机核实（自带 user-guide 11-custom-models.md）：
        // base url 走 GROK_MODELS_BASE_URL——模型目录从 {base_url}/models 拉取、推理同走该 base，
        // XAI_API_KEY 作 Bearer；GROK_DEFAULT_MODEL 只是「偏好」，会跟目录比对，不在目录里静默回退
        // 默认模型——所以第三方模型必须配 GROK_MODELS_BASE_URL 让目录来自网关自身才能匹配上。
        // （GROK_CLI_CHAT_PROXY_BASE_URL 是 xAI 内部 CLI chat API 代理覆盖口，不是推理端点，勿用）
        launch: LaunchSpec::Env(EnvInject {
            base_url: Some("GROK_MODELS_BASE_URL"),
            key: Some("XAI_API_KEY"),
            model: Some("GROK_DEFAULT_MODEL"),
            fixed_env: &[],
            fixed_args: &[],
        }),
        // 交互初始 prompt 是位置参数；headless 为 -p/--print（不读 stdin）
        prompt_inject: PromptInject::Positional,
        // 「聊想法」只读注入：headless 已验证语义最硬的组合——dontAsk 是 CI 严格白名单
        //（非白名单工具请求直接 Cancelled）+ read-only 是 OS 级只读（只能写 ~/.grok 和临时目录）；
        // --permission-mode plan 的值被接受但主会话门控链路未确认，不用
        readonly_args: &["--permission-mode", "dontAsk", "--sandbox", "read-only"],
        permission_args: &[("ask", &["--permission-mode", "default"]), ("auto", &["--permission-mode", "auto"]), ("full", &["--permission-mode", "bypassPermissions"])],
        // -s/--session-id <UUID> 仅新建会话可用（matrix §9）
        fixed_session_id: true,
        // -r/--resume [ID_OR_TITLE] 按 ID 恢复；-c/--continue 续最近（前端不用）
        resume: ResumeSpec { prepend: false, args: &["-r", "{session}"] },
        // 与 Mesa SSOT 同构（目录 + SKILL.md）；首版未经实机验证，分发强制 copy（见下方 skill_dist 字段）
        skills_dir: &[".grok", "skills"],
        packaging: PackagingSpec {
            npm_install: Some("@xai-official/grok"),
            npm_update: Some("@xai-official/grok"),
            winget: Some("xAI.GrokBuild"),
            // grok update 是非交互自更新（grok update --check --json 机器可读）
            self_update: Some(&["update"]),
            install_script: Some("curl -fsSL https://x.ai/cli/install.sh | bash"),
            update_fallback: &[UpdateChannel::SelfUpdate, UpdateChannel::Npm],
            ..NO_PACKAGING
        },
        // grok login 走浏览器 OAuth（auth.x.ai），凭证落 ~/.grok/auth.json（0600，grok 自己原子重写，
        // 我们只读）；XAI_API_KEY 残留会压登录态（凭证优先级 api_key > env_key > session token），
        // 官方账号拉起必须 env_remove
        official_account: Some(OfficialAccountSpec {
            login_cmd: &["login"],
            auth_file_paths: &[".grok/auth.json"],
            env_purge_list: &["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"],
            // config.toml 顶层 api_key/env_key 是凭证优先级最高档，会静默覆盖官方账号登录；
            // 以 TOML 探测并提供带备份的清理动作
            conflict_probes: &[ConflictProbe {
                file: ".grok/config.toml",
                keys: &["api_key", "env_key"],
                note: "config.toml 中的 API 凭证会覆盖官方账号登录",
            }],
            detection_note: Some("凭证在 ~/.grok/auth.json（scope→GrokAuth 顶层 map，grok 自己原子重写）；「已连接」仅代表已登录——auth.json 不含订阅/会员字段，无会员的免费账号登录后同样显示已连接，能否用官方额度以实际使用为准"),
            api_key_fields: &[],
        }),
        // Grok 1.0.x supports /model and /effort in the running TUI.
        model_switch: ModelSwitch::Direct("/model {model}"),
        effort_levels: Some((
            &["none", "minimal", "low", "medium", "high", "xhigh", "max"],
            "/effort {level}",
        )),
        submit_csi_u: false,
        // 「设为全局默认」（2026-09-01 落地）：~/.grok/config.toml 写顶层 api_key +
        // [endpoints].models_base_url + [models].default/请求策略全局默认；
        // 写入面与冲突探针（顶层 api_key/env_key 压官方登录）语义自洽，见 global_config::patch_grok_config
        set_global: SetGlobalCap::Supported,
        mcp_write: McpWriteCap::ReadOnly(
            "Grok 的 MCP 分发暂不支持（TOML [mcp_servers] 段与 model 同文件）；请用 `grok mcp add` 或编辑 ~/.grok/config.toml",
        ),
        skill_dist: SkillDist::CopyOnly("~/.grok/skills 首版未经实机验证，保守强制 copy"),
        clients: &[],
    },
];

/// 按 id 查规格
pub fn agent_spec(id: &str) -> Option<&'static AgentSpec> {
    AGENT_SPECS.iter().find(|s| s.id == id)
}

/// 全部规格（detect / 更新检查等遍历入口）
pub fn all_agent_specs() -> &'static [AgentSpec] {
    AGENT_SPECS
}

// ===== 能力表 → 前端 DTO（置灰与原因提示由表驱动，不另维护前端硬编码） =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityFlagDto {
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDistDto {
    /// "symlinkOrCopy" | "copyOnly"
    pub mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilitiesDto {
    pub agent: &'static str,
    pub set_global: CapabilityFlagDto,
    pub mcp_write: CapabilityFlagDto,
    pub skill_dist: SkillDistDto,
    pub request_policy: RequestPolicySupportDto,
    /// 请求策略 reasoningEffort 的已知档位（非空 = 前端出下拉，空 = 自由输入）。
    /// 只收实证值集：claude /effort 闭集、opencode 配置枚举、codex catalog 模板、grok README
    pub effort_options: Vec<&'static str>,
    /// 想法期只读硬保护：readonly_args 非空 = supported
    pub readonly: CapabilityFlagDto,
    /// 无头/定时写盘：未实证则 supported=false 或 reason 写人话（qwen 禁选、grok 标无沙箱）
    pub headless_write: CapabilityFlagDto,
    /// 执行形态：九家均为 local_cli + headless；cloud 不预研
    pub runtime_kinds: Vec<&'static str>,
}

/// 逐 agent 的策略通道形态说明（求交 DTO 下发，前端策略编辑区展示；None = 标准形态不用说）
pub(crate) fn policy_channel_note(agent: &str) -> Option<&'static str> {
    match agent {
        // 0.22.0 实证：温度/topP 只经设为全局的 generationConfig.samplingParams 生效
        "qwen" => Some("temperature / topP 只在「设为全局默认」写入后生效；启动注入仅 max output 一条通道"),
        // overlay 白名单只放行 [models] 全局默认；逐模型 api_backend/context_window 走设为全局
        "grok" => Some("策略经 GROK_CONFIG overlay 的 [models] 全局默认注入；api_backend / context_window 需绑定「API 后端」字段 + 设为全局默认写入"),
        _ => None,
    }
}

/// Grok 1.0.x 校验 `models.default_reasoning_effort` 的闭集（启动报错原文）。
pub const GROK_REASONING_EFFORTS: [&str; 7] =
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// 逐 agent 的 reasoningEffort 已知档位（与 request_policy_support 同实证口径）
pub(crate) fn effort_options(agent: &str) -> Vec<&'static str> {
    match agent {
        "claude-code" => vec!["low", "medium", "high", "xhigh", "max"],
        "codebuddy" => vec!["minimal", "low", "medium", "high", "xhigh", "max"],
        // Codex 新版模型（包括第三方兼容端点上的 gpt-6 系列）可声明更高推理档。
        // 端点不支持时仍由其自身协议返回错误或忽略。
        "codex" => vec!["low", "medium", "high", "xhigh", "ultra", "max"],
        "opencode" => vec!["none", "minimal", "low", "medium", "high"],
        "grok" => GROK_REASONING_EFFORTS.to_vec(),
        // kimi 合法值随模型 catalog 漂移（low/medium/high/xhigh/max/on/off），env 通道无闭集
        // 校验且官方明确原样透传——自由输入反而更准，不给下拉
        _ => vec![],
    }
}

const KNOWN_REASONING_EFFORTS: [&str; 10] = [
    "none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max", "on", "off",
];

/// 网关逐模型思考档：逗号分隔的多档（会话里可切）+ 可选 `@默认档`。
/// 斜杠串和拼写错误整段丢掉，否则会原样写进 Grok 的 `default_reasoning_effort`。
/// 单词旧值（`high`）原样保留。
pub(crate) fn canonical_reasoning_effort(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.contains(',') && !trimmed.contains('@') {
        let v = trimmed.to_ascii_lowercase();
        return KNOWN_REASONING_EFFORTS
            .contains(&v.as_str())
            .then_some(v);
    }
    let (list, default) = trimmed
        .rsplit_once('@')
        .map(|(list, default)| (list, Some(default.trim())))
        .unwrap_or((trimmed, None));
    let mut levels: Vec<String> = Vec::new();
    for part in list.split(',') {
        let v = part.trim().to_ascii_lowercase();
        if v.is_empty() || !KNOWN_REASONING_EFFORTS.contains(&v.as_str()) {
            continue;
        }
        if !levels.iter().any(|x| x == &v) {
            levels.push(v);
        }
    }
    if levels.is_empty() {
        return None;
    }
    let default = default
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| levels.iter().any(|x| x == s));
    let mut out = levels.join(",");
    if let Some(d) = default {
        if levels.len() > 1 {
            out.push('@');
            out.push_str(&d);
        }
    }
    Some(out)
}

/// 开场写入 CLI 的那一档：多选时取 `@` 后的默认，没有则取名单第一档。
pub(crate) fn launch_reasoning_effort(raw: &str) -> Option<String> {
    let stored = canonical_reasoning_effort(raw)?;
    let (list, default) = stored
        .rsplit_once('@')
        .map(|(list, default)| (list.to_string(), Some(default.to_string())))
        .unwrap_or((stored, None));
    default.or_else(|| {
        list.split(',')
            .next()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    })
}

/// 会话内可切换的档位。单词旧值视为「只开这一档」。
pub(crate) fn reasoning_effort_levels(raw: &str) -> Vec<String> {
    let Some(stored) = canonical_reasoning_effort(raw) else {
        return Vec::new();
    };
    let list = stored.split('@').next().unwrap_or("");
    list.split(',')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPolicySupportDto {
    pub temperature: &'static str,
    pub top_p: &'static str,
    pub max_output_tokens: &'static str,
    pub reasoning_effort: &'static str,
    pub custom_headers: &'static str,
}

/// 请求策略逐字段通道表（2026-08-28 本机安装二进制 strings/配置 schema 实证，调研录 matrix §9 第 8 条）。
/// 取值按**入口**记账（2026-09-01 拆分，此前 supported 一词被求交器误当「启动可注」）：
/// - "inject" = 启动注入通道（env/flag/内联配置/overlay），内嵌终端拉起即生效
/// - "persist" = 仅「设为全局默认」写 CLI 配置文件可达（启动注入够不到）
/// - "tui" = 仅进程内原生命令（如 /effort），Mesa 不携带存储值
/// - "unsupported" = 协议支持但 CLI 无用户入口；"unknown" = 未实证
pub(crate) fn request_policy_support(agent: &str) -> RequestPolicySupportDto {
    let row = |temperature, top_p, max_output_tokens, reasoning_effort, custom_headers| {
        RequestPolicySupportDto {
            temperature,
            top_p,
            max_output_tokens,
            reasoning_effort,
            custom_headers,
        }
    };
    match agent {
        // claude-code v2.x 二进制实证：temperature/top_p 经 CLAUDE_CODE_EXTRA_BODY（JSON 对象
        // 展开进请求体）；max_output_tokens=CLAUDE_CODE_MAX_OUTPUT_TOKENS；
        // effort=CLAUDE_CODE_EFFORT_LEVEL（同 /effort）；headers=ANTHROPIC_CUSTOM_HEADERS
        "claude-code" => row("inject", "inject", "inject", "inject", "inject"),
        // codebuddy 是 claude-code fork 但 env 前缀独立：
        // CODEBUDDY_CODE_MAX_OUTPUT_TOKENS / CODEBUDDY_CUSTOM_HEADERS 实证；temperature/top_p 无入口。
        // effort：2026-10-17 假网关实测，自定义端点（CODEBUDDY_BASE_URL，走 /chat/completions）下
        // `--effort high` 在线上不出现任何思考 / 档位字段——对网关连接等于没有通道，标 unsupported，
        // 别让开聊前摆出点了没用的档（官方账号走 CodeBuddy 自家模型，不经求交器）
        "codebuddy" => row("unsupported", "unsupported", "inject", "unsupported", "inject"),
        // gemini settings schema 无 temperature/topP/maxOutputTokens 键（bundle 实证），
        // generationConfig 仅出现在 API 请求构造路径，非用户配置通道
        "gemini" => row(
            "unsupported",
            "unsupported",
            "unsupported",
            "unknown",
            "unknown",
        ),
        // codex：temperature/top_p 仅存在于 wire schema（ModelPreferences），config 无键；
        // max_output_tokens 字符串全部是 exec pragma（工具输出截断）非模型请求；
        // reasoning_effort = config model_reasoning_effort；headers = provider http_headers/env_http_headers
        "codex" => row(
            "unsupported",
            "unsupported",
            "unsupported",
            "inject",
            "inject",
        ),
        // opencode config schema 实证：agent/model options 含 temperature/topP/maxOutputTokens/
        // reasoningEffort（枚举），provider options 支持 headers
        "opencode" => row("inject", "inject", "inject", "inject", "inject"),
        // kimi 新版合成通道 KIMI_MODEL_THINKING_EFFORT（2026-08-28 二进制实证：原样透传 +
        // 小写归一，无闭集校验；**仅 kimi 协议通道读取**——求交器按绑定 protocol 再门控，
        // 见 combo.rs channel_status_for），anthropic/openai 通道静默忽略
        "kimi" => row("unknown", "unknown", "unknown", "inject", "unknown"),
        // qwen 0.22.0 bundle 实证（2026-09-01 复核，旧「无通道」结论修正）：temperature/top_p/
        // max_tokens 通道 = settings.json 条目级 generationConfig.samplingParams（snake_case
        // 线格式键名；dialog schema 未列该子键但运行时任其生效）——「设为全局」写入可达，
        // 启动 env 只有 QWEN_CODE_MAX_OUTPUT_TOKENS 一条（条目已配 samplingParams 时被跳过）。
        // effort：无注入/写盘通道，但 0.22.0 有 /effort 直切命令（见 effort_levels 字段）→ tui；
        // headers：generationConfig.customHeaders 在白名单内但请求注入点未逐键实证 → 保守 unknown
        "qwen" => row("persist", "persist", "inject", "tui", "unknown"),
        // grok v1.0.5 二进制 + 随附 README 双实证：temperature/top_p/max_completion_tokens
        // （注意键名）/reasoning_effort 与 headers 的通道是 config 不是 env（GROK_* 无此类变量）。
        // Mesa 侧接线（2026-08-31，grok-build main 源码实证）：GROK_CONFIG overlay 白名单
        // （config_override.rs OVERLAY_ALLOW_PATHS，fail-closed）只放行 [models] 全局块——
        // 五项全经 [models] 全局默认注入（temperature/top_p/max_completion_tokens/
        // default_reasoning_effort/extra_headers=$VAR 引用，见 agents::grok_config_overlay）；
        // 逐模型 [model.<id>] 表明确不在白名单内，api_backend/context_window 注不进，
        // 走绑定「API 后端」+ 设为全局（global_config::patch_grok_config）或中转目录声明
        "grok" => row("inject", "inject", "inject", "inject", "inject"),
        // cursor 本机未安装（2026-08-28），无法 strings 实证——保持 unknown 如实标注
        _ => row("unknown", "unknown", "unknown", "unknown", "unknown"),
    }
}

fn flag(supported: bool, reason: Option<&'static str>) -> CapabilityFlagDto {
    CapabilityFlagDto { supported, reason }
}

fn readonly_cap(spec: &AgentSpec) -> CapabilityFlagDto {
    if spec.readonly_args.is_empty() {
        flag(false, Some("没有只读/计划模式参数，不能以只讨论权限启动"))
    } else {
        flag(true, None)
    }
}

/// 定时/无头写盘能力：只认二进制与既有调研，未实证不假装安全。
fn headless_write_cap(agent: &str) -> CapabilityFlagDto {
    match agent {
        "qwen" => flag(false, Some("无头写盘未验证，定时任务请换别家")),
        // grok 定时任务带 --yolo：自动批准全部工具，不限课题目录
        "grok" => flag(true, Some("会批准全部操作")),
        // codex 定时任务是 -s workspace-write，只写课题目录，不必再附注
        "codex" => flag(true, None),
        // 其余无头能写文件，但没逐项核过默认权限
        _ => flag(true, Some("按该工具默认权限写文件")),
    }
}

/// 九家的三项能力一览（前端置灰/提示与后端报错同源）
#[tauri::command]
pub fn agent_capabilities() -> Vec<AgentCapabilitiesDto> {
    AGENT_SPECS
        .iter()
        .map(|s| AgentCapabilitiesDto {
            agent: s.id,
            set_global: match s.set_global {
                SetGlobalCap::Supported => flag(true, None),
                SetGlobalCap::Unsupported(r) => flag(false, Some(r)),
            },
            mcp_write: match s.mcp_write {
                McpWriteCap::Full => flag(true, None),
                McpWriteCap::ReadOnly(r) => flag(false, Some(r)),
            },
            skill_dist: match s.skill_dist {
                SkillDist::SymlinkOrCopy => SkillDistDto {
                    mode: "symlinkOrCopy",
                    reason: None,
                },
                SkillDist::CopyOnly(r) => SkillDistDto {
                    mode: "copyOnly",
                    reason: Some(r),
                },
            },
            request_policy: request_policy_support(s.id),
            effort_options: effort_options(s.id),
            readonly: readonly_cap(s),
            headless_write: headless_write_cap(s.id),
            runtime_kinds: vec!["local_cli", "headless"],
        })
        .collect()
}

/// 新旧双变体探测（kimi）：按数据目录存在性返回 "new" | "legacy"，都无 → None
pub(crate) fn variant_of(spec: &AgentSpec) -> Option<&'static str> {
    let variant = spec.packaging.legacy_variant.as_ref()?;
    let home = dirs::home_dir()?;
    if home.join(variant.new_dir).exists() {
        Some("new")
    } else if home.join(variant.legacy_dir).exists() {
        Some("legacy")
    } else {
        None
    }
}

/// which miss 后的兜底候选目录（按优先级排序）；用户目录一律走 dirs 抽象，禁写死。
/// 用户目录排在系统目录前——与用户交互终端的 PATH 解析习惯一致（~/.local/bin 里的
/// 自装副本应优先于 /opt/homebrew/bin 里的同名旧副本，避免检测到非自用的那份）。
/// 全部 agent 共用（不是 per-agent 数据），集中在本模块与注册表同维护。
pub(crate) fn binary_candidate_dirs() -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        if let Some(h) = dirs::home_dir() {
            out.push(h.join(".npm-global/bin"));
            out.push(h.join(".local/bin"));
            out.push(h.join("bin"));
            out.push(h.join(".kimi-code/bin")); // Kimi Code 新版官方安装器
            out.push(h.join(".grok/bin")); // Grok Build 官方安装器（x.ai/cli/install.sh）
            out.push(h.join(".volta/bin")); // Volta（node 版本管理器）固定 shim 目录
            out.push(h.join(".local/share/mise/shims")); // mise（node 版本管理器）固定 shim 目录
            // `quarto install tinytex` 在 macOS 的落点（没有 Homebrew 时 Mesa 这样装 TeX，不写 PATH）
            out.push(h.join("Library/TinyTeX/bin/universal-darwin"));
            out.push(h.join("Library/TinyTeX/bin/x86_64-darwin"));
        }
        out.push("/opt/homebrew/bin".into()); // Apple Silicon brew
        out.push("/usr/local/bin".into()); // Intel brew / 手动安装
        out.push("/Library/TeX/texbin".into()); // MacTeX/TeXLive（latexmk/pdflatex；GUI 短 PATH 兜底）
        // Quarto 官方 pkg 的本体目录：它往 /usr/local/bin 建链接，Apple 芯片机器上这个目录
        // 常常不存在，链接静默建不出来（2026-10-18 本机实证），装完 PATH 上找不到 quarto
        out.push("/Applications/quarto/bin".into());
        // python.org 官方 pkg 的本体（同理，/usr/local/bin 的链接可能没建成）
        out.push("/Library/Frameworks/Python.framework/Versions/Current/bin".into());
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(h) = dirs::home_dir() {
            out.push(h.join(".local/bin"));
            out.push(h.join(".kimi-code/bin")); // Kimi Code 新版官方安装器
            out.push(h.join(".grok/bin")); // Grok Build 官方安装器
            out.push(h.join(".volta/bin")); // Volta（node 版本管理器）固定 shim 目录
            out.push(h.join(".local/share/mise/shims")); // mise（node 版本管理器）固定 shim 目录
        }
        out.push("/usr/local/bin".into());
        out.push("/opt/quarto/bin".into()); // Quarto 官方 .deb / tarball 落点
    }
    #[cfg(target_os = "windows")]
    {
        // %LOCALAPPDATA%\Programs、%APPDATA%\npm（npm 全局 bin 目录）、
        // winget portable 包的 shim 目录（Links）与 winget 本体（WindowsApps）
        if let Some(local) = dirs::data_local_dir() {
            out.push(local.join("Programs"));
            out.push(local.join("Microsoft").join("WinGet").join("Links"));
            out.push(local.join("Microsoft").join("WindowsApps"));
            // GitHub Desktop 捆绑 CLI github.bat（打开指定工作树）
            out.push(local.join("GitHubDesktop").join("bin"));
            // Cursor CLI 官方 Windows 安装器（cursor-agent.cmd 启动器，进程直启见 process::cursor_entry_from_launcher）
            out.push(local.join("cursor-agent"));
        }
        if let Some(roaming) = dirs::data_dir() {
            out.push(roaming.join("npm"));
        }
        if let Some(h) = dirs::home_dir() {
            out.push(h.join(".kimi-code/bin")); // Kimi Code 新版官方安装器
            out.push(h.join(".grok/bin")); // Grok Build 官方安装器（%USERPROFILE%\.grok\bin\grok.exe）
            out.push(h.join(".local").join("bin")); // 官方 install.sh 在 MINGW 下落点
        }
        // Node.js 官方 Windows 安装器默认目录；GUI 启动时 PATH 可能未继承，
        // 仍应能找到 node/npm.cmd。
        for key in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(key) {
                let root = std::path::PathBuf::from(root);
                out.push(root.join("nodejs"));
                // Git for Windows：bash.exe 在 bin/，流水线钩子与 run 脚本需要
                out.push(root.join("Git").join("bin"));
                out.push(root.join("Git").join("usr").join("bin"));
            }
        }
        // Git for Windows（winget Git.Git / 官方安装器）默认落点
        for key in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(key) {
                out.push(std::path::PathBuf::from(root).join("Git").join("cmd"));
            }
        }
        // 只给当前用户装的 Git（winget 偏好用户范围 / 安装器选「仅为我安装」）
        if let Some(local) = dirs::data_local_dir() {
            out.push(local.join("Programs").join("Git").join("cmd"));
        }
        // Quarto 官方安装器默认落点（GUI 启动时 PATH 可能未继承）
        for key in ["ProgramW6432", "ProgramFiles"] {
            if let Some(root) = std::env::var_os(key) {
                out.push(std::path::PathBuf::from(root).join("Quarto").join("bin"));
            }
        }
        // `quarto install tinytex` 的落点（Quarto 源码 tinyTexInstallDir/BinDir）：%APPDATA%\TinyTeX，
        // APPDATA 含非 ASCII 时退到 %ProgramData%；bin\windows（TeX Live 2023+）或旧版 bin\win32。
        // 装完写进用户 PATH，但已在跑的 Mesa 进程拿不到，依赖体检靠这里认出 xelatex
        for key in ["APPDATA", "ProgramData"] {
            if let Some(root) = std::env::var_os(key) {
                let tinytex = std::path::PathBuf::from(root).join("TinyTeX").join("bin");
                out.push(tinytex.join("windows"));
                out.push(tinytex.join("win32"));
            }
        }
        // python.org 安装器落点（winget Python.Python.3.x 同）：当前用户装在
        // %LOCALAPPDATA%\Programs\Python\Python3xx，全机装在 %ProgramFiles%\Python3xx。
        // 一键补齐装完 Python 后，已在跑的 Mesa 进程 PATH 里只有应用商店占位，靠这里找到真身；
        // 新版本排前面
        let mut python_roots: Vec<std::path::PathBuf> = Vec::new();
        if let Some(local) = dirs::data_local_dir() {
            python_roots.push(local.join("Programs").join("Python"));
        }
        for key in ["ProgramW6432", "ProgramFiles"] {
            if let Some(root) = std::env::var_os(key) {
                python_roots.push(std::path::PathBuf::from(root));
            }
        }
        for root in python_roots {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            let mut found: Vec<(u32, std::path::PathBuf)> = entries
                .flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let minor: u32 = name.strip_prefix("Python3")?.parse().ok()?;
                    Some((minor, e.path()))
                })
                .collect();
            found.sort_by(|a, b| b.0.cmp(&a.0));
            out.extend(found.into_iter().map(|(_, p)| p));
        }
    }
    out
}

fn env_path(var: &str) -> Option<std::path::PathBuf> {
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
}

/// `CLAUDE_CONFIG_DIR` 整体替换 `~/.claude`（不是替换家目录）：技能在 `$CLAUDE_CONFIG_DIR/skills`
fn claude_skills_dir(config_dir: Option<std::path::PathBuf>, home: std::path::PathBuf) -> std::path::PathBuf {
    config_dir.unwrap_or_else(|| home.join(".claude")).join("skills")
}

/// 该 agent 的技能目录：搬迁变量优先，缺省 = home + `skills_dir` 段。
/// MCP 的 agent_paths 用同一套搬迁变量；两处必须同源，避免 `KIMI_CODE_HOME` 等
/// 只对 MCP 生效、技能静默落到默认家目录。
pub fn skills_dir_for(spec: &AgentSpec) -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    match spec.id {
        "claude-code" => Some(claude_skills_dir(env_path("CLAUDE_CONFIG_DIR"), home)),
        "codex" => {
            let base = env_path("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
            Some(base.join("skills"))
        }
        "gemini" => {
            let base = env_path("GEMINI_CLI_HOME").unwrap_or_else(|| home.join(".gemini"));
            Some(base.join("skills"))
        }
        "qwen" => {
            let base = env_path("QWEN_HOME").unwrap_or_else(|| home.join(".qwen"));
            Some(base.join("skills"))
        }
        "opencode" => {
            let base = env_path("XDG_CONFIG_HOME")
                .unwrap_or_else(|| home.join(".config"))
                .join("opencode");
            Some(base.join("skills"))
        }
        "kimi" => {
            let base = env_path("KIMI_CODE_HOME").unwrap_or_else(|| home.join(".kimi-code"));
            Some(base.join("skills"))
        }
        "codebuddy" => {
            let base = env_path("CODEBUDDY_CONFIG_DIR").unwrap_or_else(|| home.join(".codebuddy"));
            Some(base.join("skills"))
        }
        "cursor" => Some(home.join(".cursor").join("skills-cursor")),
        "grok" => {
            let base = env_path("GROK_HOME").unwrap_or_else(|| home.join(".grok"));
            Some(base.join("skills"))
        }
        _ => Some(spec.skills_dir.iter().fold(home, |p, seg| p.join(seg))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN_IDS: [&str; 9] = [
        "claude-code",
        "codex",
        "gemini",
        "qwen",
        "opencode",
        "kimi",
        "codebuddy",
        "cursor",
        "grok",
    ];

    /// 客户端规格：id 全局唯一，深链模板带对应占位且以自己的 scheme 开头，至少能开一种目标
    #[test]
    fn client_specs_are_well_formed() {
        let mut ids = std::collections::HashSet::new();
        for spec in all_agent_specs() {
            for c in spec.clients {
                assert!(ids.insert(c.id), "客户端 id 重复: {}", c.id);
                assert!(!c.display.is_empty() && !c.scheme.is_empty(), "{} 缺展示名或 scheme", c.id);
                assert!(
                    c.session_url.is_some() || c.project_url.is_some(),
                    "{} 既不能开会话也不能开项目",
                    c.id
                );
                let prefix = format!("{}://", c.scheme);
                if let Some(u) = c.session_url {
                    assert!(u.starts_with(&prefix) && u.contains("{session}"), "{} 会话深链模板有误", c.id);
                }
                if let Some(u) = c.project_url {
                    assert!(u.starts_with(&prefix) && u.contains("{path}"), "{} 项目深链模板有误", c.id);
                }
                assert!(
                    !c.mac_app_names.is_empty() || !c.mac_bundle_ids.is_empty(),
                    "{} 缺 macOS 探测线索",
                    c.id
                );
            }
        }
        assert_eq!(ids.len(), 2, "本期只有 claude-desktop 与 codex-desktop");
    }

    /// 注册表完整性：全部已知 agent 都有规格，必填字段非空
    #[test]
    fn registry_covers_all_known_agents_with_required_fields() {
        assert_eq!(all_agent_specs().len(), KNOWN_IDS.len());
        for id in KNOWN_IDS {
            let spec = agent_spec(id).unwrap_or_else(|| panic!("缺规格: {id}"));
            assert!(!spec.display_name.is_empty(), "{id} 缺 display_name");
            assert!(!spec.binary.is_empty(), "{id} 缺 binary");
            assert!(!spec.version_args.is_empty(), "{id} 缺 version_args");
            assert!(!spec.skills_dir.is_empty(), "{id} 缺 skills_dir");
            assert!(!spec.resume.args.is_empty(), "{id} 缺 resume 参数");
            assert!(
                spec.resume.args.iter().any(|a| a.contains("{session}")),
                "{id} 的 resume 参数缺 {{session}} 占位"
            );
            let p = &spec.packaging;
            assert!(
                p.brew_install.is_some()
                    || p.npm_install.is_some()
                    || p.uv.is_some()
                    || p.install_script.is_some(),
                "{id} 没有任何安装渠道"
            );
            assert!(
                p.brew_upgrade.is_some()
                    || p.npm_update.is_some()
                    || p.uv.is_some()
                    || p.self_update.is_some(),
                "{id} 没有任何更新渠道"
            );
            // 多协议 agent：缺省协议（第一个）必须在合法取值内（恒真，防手写错位）
            if let Some(default) = spec.protocols.first() {
                assert!(spec.protocols.contains(default), "{id} 协议表错位");
            }
            // 官方账号规格（若填）：auth 文件与 env 净化清单不能为空（login_cmd 允许为空 = 裸启动 TUI 登录）
            if let Some(oa) = &spec.official_account {
                assert!(
                    !oa.auth_file_paths.is_empty(),
                    "{id} 官方账号缺 auth 文件路径"
                );
                assert!(
                    !oa.env_purge_list.is_empty(),
                    "{id} 官方账号缺 env 净化清单"
                );
            }
        }
    }

    #[test]
    fn claude_config_dir_replaces_dot_claude() {
        let home = std::path::PathBuf::from("home");
        assert_eq!(
            claude_skills_dir(None, home.clone()),
            home.join(".claude").join("skills")
        );
        let moved = std::path::PathBuf::from("moved-claude");
        assert_eq!(claude_skills_dir(Some(moved.clone()), home), moved.join("skills"));
    }

    #[test]
    fn skills_dir_default_matches_spec_segments() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        for spec in all_agent_specs() {
            if spec.id == "opencode" && std::env::var_os("XDG_CONFIG_HOME").is_some() {
                continue;
            }
            let dir = skills_dir_for(spec).expect(spec.id);
            let expected = spec.skills_dir.iter().fold(home.clone(), |p, s| p.join(s));
            assert_eq!(dir, expected, "{}", spec.id);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_candidate_dirs_include_local_bin_and_git() {
        let dirs = binary_candidate_dirs();
        if let Some(h) = dirs::home_dir() {
            assert!(
                dirs.iter().any(|d| d == &h.join(".local").join("bin")),
                "缺 ~/.local/bin: {dirs:?}"
            );
        }
        assert!(
            dirs.iter()
                .any(|d| d.ends_with(std::path::Path::new("Git").join("bin"))),
            "缺 Git\\bin: {dirs:?}"
        );
    }

    /// 查找往返一致：遍历注册表拿到的 id 再查回同一张规格，且 id 全局唯一
    #[test]
    fn spec_lookup_round_trips_and_ids_are_unique() {
        for spec in all_agent_specs() {
            let found = agent_spec(spec.id).expect("按 id 应能查回规格");
            assert!(
                std::ptr::eq(spec, found),
                "{} 查回的不是同一张规格",
                spec.id
            );
        }
        let mut ids: Vec<&str> = all_agent_specs().iter().map(|s| s.id).collect();
        let before = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), before, "agent id 重复");
        // 未知 id → None（binary_for / resume_args 的报错路径依赖它）
        assert!(agent_spec("no-such-agent").is_none());
    }

    /// ByProtocol 形态的多协议 agent：注入表的 protocol 键与 protocols 声明一致
    #[test]
    fn by_protocol_launch_matches_declared_protocols() {
        for spec in all_agent_specs() {
            if let LaunchSpec::ByProtocol(entries) = &spec.launch {
                assert!(!entries.is_empty(), "{} 协议注入表为空", spec.id);
                for entry in entries.iter() {
                    assert!(
                        spec.protocols.contains(&entry.protocol),
                        "{} 注入表协议 {} 未在 protocols 声明",
                        spec.id,
                        entry.protocol
                    );
                }
            }
        }
    }

    /// 第一批官方账号登录命令（claude / codex / gemini）
    #[test]
    fn first_batch_official_account_login_cmds() {
        let claude = agent_spec("claude-code")
            .unwrap()
            .official_account
            .as_ref()
            .unwrap();
        assert_eq!(claude.login_cmd, &["auth", "login"]);
        let codex = agent_spec("codex")
            .unwrap()
            .official_account
            .as_ref()
            .unwrap();
        assert_eq!(codex.login_cmd, &["login", "--device-auth"]);
        let gemini = agent_spec("gemini")
            .unwrap()
            .official_account
            .as_ref()
            .unwrap();
        assert!(gemini.login_cmd.is_empty());
    }

    /// 第二批官方账号规格与实机调研结论一致（kimi/qwen 填，opencode 保持 None）
    #[test]
    fn second_batch_official_account_specs_match_verified_research() {
        // kimi：login 子命令（设备码）；凭证目录扫描（文件名随 provider 名变化）；
        // purge 覆盖 KIMI_MODEL_* 合成通道 + 旧版 KIMI_API_KEY/KIMI_BASE_URL
        let kimi = agent_spec("kimi")
            .unwrap()
            .official_account
            .as_ref()
            .unwrap();
        assert_eq!(kimi.login_cmd, &["login"]);
        assert_eq!(kimi.auth_file_paths, &[".kimi-code/credentials/*"]);
        for var in [
            "KIMI_MODEL_NAME",
            "KIMI_MODEL_PROVIDER_TYPE",
            "KIMI_MODEL_API_KEY",
            "KIMI_MODEL_BASE_URL",
            "KIMI_API_KEY",
            "KIMI_BASE_URL",
        ] {
            assert!(kimi.env_purge_list.contains(&var), "kimi purge 缺 {var}");
        }
        // qwen：auth 子命令已移除 → login_cmd 空（裸拉起 TUI /auth）；凭证 oauth_creds.json
        let qwen = agent_spec("qwen")
            .unwrap()
            .official_account
            .as_ref()
            .unwrap();
        assert!(qwen.login_cmd.is_empty());
        assert_eq!(qwen.auth_file_paths, &[".qwen/oauth_creds.json"]);
        assert!(qwen.env_purge_list.contains(&"OPENAI_API_KEY"));
        assert!(qwen.env_purge_list.contains(&"ANTHROPIC_API_KEY"));
        assert_eq!(qwen.conflict_probes.len(), 1);
        assert_eq!(qwen.conflict_probes[0].file, ".qwen/.env");
        // opencode：无单一官方账号语义（多 provider 凭证管理器），保持 None
        assert!(agent_spec("opencode").unwrap().official_account.is_none());
    }

    /// grok 规格与 xai-org/grok-build 源码调研一致（matrix §9）
    #[test]
    fn grok_spec_matches_source_research() {
        let spec = agent_spec("grok").unwrap();
        assert_eq!(spec.binary, "grok");
        let LaunchSpec::Env(env) = &spec.launch else {
            panic!("grok 应为 Env 注入形态");
        };
        assert_eq!(env.key, Some("XAI_API_KEY"));
        assert_eq!(env.model, Some("GROK_DEFAULT_MODEL"));
        assert_eq!(env.base_url, Some("GROK_MODELS_BASE_URL"));
        assert_eq!(
            spec.readonly_args,
            &["--permission-mode", "dontAsk", "--sandbox", "read-only"]
        );
        let oa = spec.official_account.as_ref().unwrap();
        assert_eq!(oa.login_cmd, &["login"]);
        assert_eq!(oa.auth_file_paths, &[".grok/auth.json"]);
        assert!(oa.env_purge_list.contains(&"XAI_API_KEY"));
        assert!(oa.env_purge_list.contains(&"GROK_CODE_XAI_API_KEY"));
        assert_eq!(spec.packaging.npm_install, Some("@xai-official/grok"));
        assert_eq!(spec.packaging.self_update, Some(&["update"][..]));
    }

    /// 交互式 TUI 自更新标记：kimi/opencode 的 upgrade 是方向键选择界面（行输入无法应答，
    /// 配置页更新按钮据此改路由到完整终端）；标记必须挂在有 self_update 的规格上
    #[test]
    fn interactive_tui_flag_only_on_self_update_specs() {
        for spec in all_agent_specs() {
            if spec.packaging.interactive_tui {
                assert!(
                    spec.packaging.self_update.is_some(),
                    "{} 标了 interactive_tui 但没有 self_update",
                    spec.id
                );
            }
        }
        assert!(agent_spec("kimi").unwrap().packaging.interactive_tui);
        assert!(agent_spec("opencode").unwrap().packaging.interactive_tui);
        // claude/codebuddy/cursor/grok 的自更新是普通非交互命令，其余 agent 无自更新渠道，均不得误标
        for id in [
            "claude-code",
            "codex",
            "gemini",
            "qwen",
            "codebuddy",
            "cursor",
            "grok",
        ] {
            assert!(
                !agent_spec(id).unwrap().packaging.interactive_tui,
                "{id} 不应标 interactive_tui"
            );
        }
    }

    /// 三项能力（设为全局默认 / MCP 分发 / 技能分发方式）的九家取值：
    /// 支持面必须与 global_config plan_writes 的 match arm、mcp/skills 消费点一致
    #[test]
    fn capability_fields_match_consumers() {
        // 「设为全局默认」：global_config::plan_writes 有写计划的八家 Supported
        for id in [
            "claude-code",
            "codex",
            "gemini",
            "qwen",
            "opencode",
            "kimi",
            "codebuddy",
            "grok",
        ] {
            assert_eq!(
                agent_spec(id).unwrap().set_global,
                SetGlobalCap::Supported,
                "{id} 应支持设为全局默认"
            );
        }
        // cursor 不支持且必须带用户可见原因（fail-loud）
        let SetGlobalCap::Unsupported(reason) = agent_spec("cursor").unwrap().set_global else {
            panic!("cursor 应为 Unsupported");
        };
        assert!(!reason.is_empty(), "cursor 缺原因文案");
        // MCP 分发：仅 grok 只读（原因指向 grok mcp add），其余八家 Full
        assert_eq!(
            agent_spec("grok").unwrap().mcp_write,
            McpWriteCap::ReadOnly(
                "Grok 的 MCP 分发暂不支持（TOML [mcp_servers] 段与 model 同文件）；请用 `grok mcp add` 或编辑 ~/.grok/config.toml"
            )
        );
        for id in [
            "claude-code",
            "codex",
            "gemini",
            "qwen",
            "opencode",
            "kimi",
            "codebuddy",
            "cursor",
        ] {
            assert_eq!(
                agent_spec(id).unwrap().mcp_write,
                McpWriteCap::Full,
                "{id} 应支持 MCP 分发"
            );
        }
        // 技能分发：cursor/grok 强制 copy（带原因），其余七家 symlink 优先
        for id in ["cursor", "grok"] {
            let SkillDist::CopyOnly(reason) = agent_spec(id).unwrap().skill_dist else {
                panic!("{id} 应强制 copy");
            };
            assert!(!reason.is_empty(), "{id} 缺原因文案");
        }
        for id in [
            "claude-code",
            "codex",
            "gemini",
            "qwen",
            "opencode",
            "kimi",
            "codebuddy",
        ] {
            assert_eq!(
                agent_spec(id).unwrap().skill_dist,
                SkillDist::SymlinkOrCopy,
                "{id} 应保持 symlink 优先"
            );
        }
        // claude 三项全支持
        let claude = agent_spec("claude-code").unwrap();
        assert_eq!(claude.set_global, SetGlobalCap::Supported);
        assert_eq!(claude.mcp_write, McpWriteCap::Full);
        assert_eq!(claude.skill_dist, SkillDist::SymlinkOrCopy);
        // DTO 形态：grok 的 MCP/技能两项带原因，set_global 已支持（2026-09-01 起）
        let dto = agent_capabilities()
            .into_iter()
            .find(|c| c.agent == "grok")
            .unwrap();
        assert!(dto.set_global.supported && dto.set_global.reason.is_none());
        assert!(!dto.mcp_write.supported && dto.mcp_write.reason.is_some());
        assert_eq!(dto.skill_dist.mode, "copyOnly");
        assert!(dto.skill_dist.reason.is_some());
        let claude_dto = agent_capabilities()
            .into_iter()
            .find(|c| c.agent == "claude-code")
            .unwrap();
        assert!(claude_dto.set_global.supported && claude_dto.set_global.reason.is_none());
        // 通道表按入口记账：inject/persist/tui/unsupported/unknown
        assert_eq!(claude_dto.request_policy.temperature, "inject");
        assert_eq!(claude_dto.request_policy.custom_headers, "inject");
        let qwen_dto = agent_capabilities()
            .into_iter()
            .find(|c| c.agent == "qwen")
            .unwrap();
        assert_eq!(qwen_dto.request_policy.temperature, "persist");
        assert_eq!(qwen_dto.request_policy.reasoning_effort, "tui");
        assert_eq!(qwen_dto.request_policy.max_output_tokens, "inject");
        assert_eq!(qwen_dto.request_policy.custom_headers, "unknown");
        assert_eq!(qwen_dto.effort_options, Vec::<&str>::new());
        assert!(!qwen_dto.readonly.supported);
        assert!(!qwen_dto.headless_write.supported);
        assert!(qwen_dto.headless_write.reason.unwrap().contains("未验证"));
        assert!(claude_dto.readonly.supported);
        let grok_caps = agent_capabilities()
            .into_iter()
            .find(|c| c.agent == "grok")
            .unwrap();
        assert!(grok_caps.headless_write.supported);
        assert!(grok_caps.headless_write.reason.unwrap().contains("会批准全部操作"));
        assert_eq!(
            agent_spec("qwen")
                .unwrap()
                .effort_levels
                .map(|(l, _)| l.len()),
            Some(5)
        );
        assert_eq!(agent_spec("gemini").unwrap().effort_levels, None);
        assert_eq!(agent_spec("codex").unwrap().effort_levels, None);
        assert_eq!(
            agent_spec("grok")
                .unwrap()
                .effort_levels
                .map(|(levels, _)| levels.len()),
            Some(7)
        );
        let kimi_dto = agent_capabilities()
            .into_iter()
            .find(|c| c.agent == "kimi")
            .unwrap();
        assert_eq!(kimi_dto.request_policy.reasoning_effort, "inject");
        assert_eq!(kimi_dto.request_policy.temperature, "unknown");
        assert_eq!(kimi_dto.request_policy.custom_headers, "unknown");
        let cursor_dto = agent_capabilities()
            .into_iter()
            .find(|c| c.agent == "cursor")
            .unwrap();
        assert_eq!(cursor_dto.request_policy.temperature, "unknown");
        let codebuddy_dto = agent_capabilities()
            .into_iter()
            .find(|c| c.agent == "codebuddy")
            .unwrap();
        assert_eq!(codebuddy_dto.request_policy.temperature, "unsupported");
        assert_eq!(codebuddy_dto.request_policy.custom_headers, "inject");
        // 自定义端点下 --effort 不上线（2026-10-17 假网关实测）
        assert_eq!(codebuddy_dto.request_policy.reasoning_effort, "unsupported");
        assert_eq!(codebuddy_dto.request_policy.max_output_tokens, "inject");
        assert_eq!(codebuddy_dto.request_policy.top_p, "unsupported");
        let gemini_dto = agent_capabilities()
            .into_iter()
            .find(|c| c.agent == "gemini")
            .unwrap();
        assert_eq!(gemini_dto.request_policy.temperature, "unsupported");
        assert_eq!(gemini_dto.request_policy.reasoning_effort, "unknown");
        assert_eq!(gemini_dto.request_policy.custom_headers, "unknown");
        assert_eq!(gemini_dto.request_policy.max_output_tokens, "unsupported");
        assert_eq!(gemini_dto.request_policy.top_p, "unsupported");
        let codex_dto = agent_capabilities()
            .into_iter()
            .find(|c| c.agent == "codex")
            .unwrap();
        assert_eq!(codex_dto.request_policy.reasoning_effort, "inject");
        assert_eq!(codex_dto.request_policy.custom_headers, "inject");
        assert_eq!(codex_dto.request_policy.temperature, "unsupported");
        let opencode_dto = agent_capabilities()
            .into_iter()
            .find(|c| c.agent == "opencode")
            .unwrap();
        assert_eq!(opencode_dto.request_policy.temperature, "inject");
        assert_eq!(opencode_dto.request_policy.reasoning_effort, "inject");
        let grok_dto2 = agent_capabilities()
            .into_iter()
            .find(|c| c.agent == "grok")
            .unwrap();
        assert_eq!(grok_dto2.request_policy.temperature, "inject");
        assert_eq!(grok_dto2.request_policy.custom_headers, "inject");
        assert_eq!(grok_dto2.request_policy.reasoning_effort, "inject");
        assert_eq!(canonical_reasoning_effort(" High "), Some("high".into()));
        assert_eq!(canonical_reasoning_effort("hign/xhign"), None);
        assert_eq!(canonical_reasoning_effort("off"), Some("off".into()));
        assert_eq!(
            canonical_reasoning_effort("low, high, xhigh@high"),
            Some("low,high,xhigh@high".into())
        );
        assert_eq!(
            launch_reasoning_effort("low,high,xhigh@xhigh").as_deref(),
            Some("xhigh")
        );
        assert_eq!(
            reasoning_effort_levels("low,high,xhigh@high"),
            vec!["low".to_string(), "high".into(), "xhigh".into()]
        );
        assert_eq!(grok_dto2.request_policy.max_output_tokens, "inject");
        assert_eq!(grok_dto2.request_policy.top_p, "inject");
        assert_eq!(claude_dto.skill_dist.mode, "symlinkOrCopy");
    }
}
