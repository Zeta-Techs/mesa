use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "ccode";

/// 账号类型（P1a）：api = 端点+密钥注入；official = CLI 官方账号登录，
/// 拉起时不注入 API env 并按规格 purge 残留密钥变量。缺省 api 向后兼容旧 profiles.json
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AccountType {
    #[default]
    Api,
    Official,
}

/// 请求级策略。这里仅保存“可安全复用的声明”，不会假设所有 Agent 都支持这些字段。
/// header_env 的 value 是环境变量名，不保存 Header 密文本体；真正的值在启动时由 CLI/网关读取。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RequestPolicy {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_output_tokens: Option<u64>,
    pub reasoning_effort: Option<String>,
    pub header_env: BTreeMap<String, String>,
    /// 所属网关的兼容选项（materialize 从网关带过来；绑定本身不存）
    #[serde(skip_serializing_if = "GatewayCompat::is_empty")]
    pub compat: GatewayCompat,
}

/// 绑定的「模型分工」（2026-10-17 用户：补齐槽位、子 agent 的规则要在连接里看得见、能自定义）。
/// 只有能分开指定的 CLI 才消费：Claude Code（haiku 槽 / 子 agent）、Grok（会话标题与摘要、输入提示）、
/// OpenCode（small_model）。None = 跟主模型（这次启动选的模型；没选用名单第一个）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleModels {
    /// 后台小模型：会话标题、摘要、输入提示这类小任务
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub small: Option<String>,
    /// 子 Agent 模型（Claude Code Task / Agent 工具派出的子任务）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
    /// Claude Code 别名显式指向（2026-10-30 用户拍板「模型映射表」）：键 sonnet / opus / fable → 名单里的模型，
    /// 缺的键 = 跟默认模型；haiku 由 `small` 管。**None = 旧绑定**，仍按「名单前四个依次占槽」算
    /// （`agents::claude_slot_models`），在连接弹层里保存一次即转成显式
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slots: Option<BTreeMap<String, String>>,
    /// 模型在 CLI 选择器里的显示名（模型 id → 名字）；没设用「连接名 · 模型」。目前 Claude Code 消费
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub display_names: BTreeMap<String, String>,
}

/// Claude Code 可显式指向的别名槽（haiku 归 RoleModels.small）
pub const CLAUDE_PINNABLE_SLOTS: [&str; 3] = ["sonnet", "opus", "fable"];

impl RoleModels {
    pub fn is_empty(&self) -> bool {
        self.small.is_none() && self.subagent.is_none() && self.slots.is_none() && self.display_names.is_empty()
    }
    /// 去空白；空串当没设；槽只认 sonnet / opus / fable
    pub fn normalized(self) -> Self {
        let clean = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let slots = self.slots.map(|m| {
            m.into_iter()
                .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
                .filter(|(k, v)| CLAUDE_PINNABLE_SLOTS.contains(&k.as_str()) && !v.is_empty())
                .collect()
        });
        let display_names = self
            .display_names
            .into_iter()
            .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
            .filter(|(k, v)| !k.is_empty() && !v.is_empty())
            .collect();
        Self {
            small: clean(self.small),
            subagent: clean(self.subagent),
            slots,
            display_names,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub agent: String,
    pub name: String,
    /// 账号类型；旧数据无此字段按 api 处理
    #[serde(default)]
    pub account_type: AccountType,
    /// API profile explicitly allowed to run without a credential (normally a local endpoint).
    /// This is fail-closed by default; it is not the same as inheriting a shell credential.
    #[serde(default)]
    pub no_auth: bool,
    pub protocol: Option<String>,
    /// Grok 专用：API 后端（绑定级，仅设为全局写入消费；其余 agent 不消费）
    #[serde(default)]
    pub api_backend: Option<String>,
    pub base_url: Option<String>,
    /// 可用模型列表，首个为默认；同一端点下通常有多个模型可切换
    #[serde(default)]
    pub models: Vec<String>,
    /// 模型分工（后台小模型 / 子 Agent），见 RoleModels
    #[serde(default)]
    pub role_models: RoleModels,
    /// 附加环境变量，启动时注入且优先级高于 adapter 内置 env（供覆盖）
    #[serde(default)]
    pub extra_env: std::collections::HashMap<String, String>,
    /// 请求策略声明；是否实际生效由 Agent/协议能力表决定。
    #[serde(default)]
    pub request_policy: RequestPolicy,
    /// 密钥尾号提示（如 "···abc1"），仅用于界面区分多个 key，非敏感信息
    #[serde(default)]
    pub key_hint: Option<String>,
    /// 旧版单模型字段，仅用于读取时迁移，写回后即消失；不作为业务字段使用
    #[serde(default, skip_serializing)]
    pub model: Option<String>,
    /// 上次用于启动的时间（ISO），配置页据此识别活跃/闲置配置（§6.12 E）
    #[serde(default)]
    pub last_used_at: Option<String>,
    /// 密钥本体在 0600 keys.json，这里只反映是否已存
    pub has_key: bool,
    /// 所属网关；官方账号绑定为 None。物化视图字段，旧 profiles.json 无此键。
    #[serde(default)]
    pub gateway_id: Option<String>,
    /// 该 Agent 所需协议槽未填
    #[serde(default)]
    pub slot_missing: bool,
    /// 连接状态机的当前细分状态，供配置页直接展示，避免前端重复推断。
    #[serde(default)]
    pub connection_status: String,
    /// 绑定模型相对网关目录的同步状态：synced / stale / missing / unknown。
    #[serde(default)]
    pub model_sync_status: String,
    #[serde(default)]
    pub model_sync_note: Option<String>,
    /// 仅启动瞬间现算：按会话 meta.provider 对齐 rollout 名字，不落盘。
    #[serde(default, skip_serializing)]
    pub provider_override: Option<String>,
}

impl Profile {
    pub fn provider_name(&self) -> String {
        if let Some(p) = &self.provider_override {
            return p.clone();
        }
        match &self.gateway_id {
            Some(gid) => crate::provider_id::provider_id(gid),
            None => crate::provider_id::LEGACY.to_string(),
        }
    }

    /// 恢复会话时按 rollout 记下的 provider 现算注入名。
    /// `ccode` → 注 LEGACY；`ccode-<短id>` → 注该派生名；其它/空 → 用网关派生。
    pub fn apply_session_provider(&mut self, session_provider: Option<&str>) {
        let Some(p) = session_provider.map(str::trim).filter(|s| !s.is_empty()) else {
            self.provider_override = None;
            return;
        };
        if crate::provider_id::is_ccode_provider(p) {
            self.provider_override = Some(p.to_string());
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BindingKind {
    #[default]
    Api,
    Official,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProbeStatus {
    #[default]
    Never,
    Passed,
    Failed,
}

impl ProbeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ProbeStatus::Never => "never",
            ProbeStatus::Passed => "passed",
            ProbeStatus::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProtocolSlots {
    pub anthropic: Option<String>,
    pub openai: Option<String>,
    pub responses: Option<String>,
    pub gemini: Option<String>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GatewayModel {
    pub id: String,
    pub source: String,
    /// available = 最近一次获取模型目录仍存在；stale = 网关目录已不再返回。
    /// 旧配置缺省为 available，避免迁移后误隐藏模型。
    #[serde(default = "default_gateway_model_status")]
    pub status: String,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    /// 最近一次把该 id 标为 available 的协议槽；按槽刷新时只 stale 本槽模型。
    #[serde(default)]
    pub catalog_slot: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_output_tokens: Option<u64>,
    pub reasoning_effort: Option<String>,
}

fn default_gateway_model_status() -> String {
    "available".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRecord {
    pub slot: String,
    pub model: Option<String>,
    pub url_fp: String,
    pub key_fp: String,
    pub streaming: ProbeStatus,
    pub effort: ProbeStatus,
    /// 采样参数（temperature/top_p）独立于思考档；旧记录缺省为 never。
    #[serde(default)]
    pub sampling: ProbeStatus,
    pub headers: ProbeStatus,
    pub basic: ProbeStatus,
    pub probed_at: String,
    /// 基础请求延迟；旧记录无此键。
    #[serde(default)]
    pub latency_ms: Option<u64>,
}

/// 每槽体检摘要（list 时现算，不落盘）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SlotProbeSummary {
    pub slot: String,
    pub last_latency_ms: Option<u64>,
    pub last_probe_at: Option<String>,
    pub last_ok: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gateway {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub no_auth: bool,
    #[serde(default)]
    pub key_hint: Option<String>,
    #[serde(default)]
    pub slots: ProtocolSlots,
    #[serde(default)]
    pub header_env: BTreeMap<String, String>,
    #[serde(default)]
    pub models: Vec<GatewayModel>,
    #[serde(default)]
    pub catalog_fetched_at: Option<String>,
    #[serde(default)]
    pub catalog_from_slot: Option<String>,
    #[serde(default)]
    pub last_probe: Vec<ProbeRecord>,
    /// list 现算，不落盘
    #[serde(default, skip_deserializing, skip_serializing_if = "Vec::is_empty")]
    pub slot_probes: Vec<SlotProbeSummary>,
    /// list 现算：槽、密钥尾、Header、模型策略的内容指纹
    #[serde(default, skip_deserializing, skip_serializing_if = "String::is_empty")]
    pub revision: String,
    /// New API 钱包查询用的用户 ID（非密钥，给 New-Api-User 兼容头）；老站点才要
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wallet_user_id: Option<String>,
    /// 系统访问令牌尾号；本体在 keys.json 键 `{id}#wallet`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wallet_key_hint: Option<String>,
    /// 这家中转的兼容选项（2026-10-28）：跟着网关走，所有绑到它的 Agent 启动时按各自通道注入
    #[serde(default, skip_serializing_if = "GatewayCompat::is_empty")]
    pub compat: GatewayCompat,
}

/// 网关兼容选项：只收各家 CLI 二进制里实证存在、对中转常见毛病有用的几项（2026-10-28，参照 cc-switch 预设里的
/// 「供应商独有字段」）。值跟着网关，启动注入与「设为全局」同口径；没设的不注入
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GatewayCompat {
    /// 请求超时（秒）：慢中转 / 长思考模型。Claude `API_TIMEOUT_MS`、Codex 渠道 `stream_idle_timeout_ms`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u32>,
    /// 不发实验性请求头（anthropic-beta）：部分中转见到就鉴权失败或 400。Claude `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub no_experimental_betas: bool,
    /// 不发思考参数：不收 thinking 字段的中转。Claude `CLAUDE_CODE_DISABLE_THINKING=1`
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub no_thinking: bool,
}

impl GatewayCompat {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub id: String,
    pub agent: String,
    /// 绑定级配置名；旧数据为空时回退共享网关名。
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: BindingKind,
    #[serde(default)]
    pub gateway_id: Option<String>,
    pub protocol: Option<String>,
    /// Grok 专用：API 后端（chat_completions/responses/messages），仅「设为全局默认」
    /// 写 [model.*] 段时消费；启动注入够不到（overlay 白名单不含 [model.*]）
    #[serde(default)]
    pub api_backend: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default, skip_serializing_if = "RoleModels::is_empty")]
    pub role_models: RoleModels,
    #[serde(default)]
    pub extra_env: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayInput {
    pub name: String,
    #[serde(default)]
    pub no_auth: bool,
    pub slots: ProtocolSlots,
    #[serde(default)]
    pub header_env: BTreeMap<String, String>,
    /// 兼容选项；None = 不改（只有网关编辑表单会带，别处的保存不能把它清掉）
    #[serde(default)]
    pub compat: Option<GatewayCompat>,
    #[serde(default)]
    pub models: Vec<GatewayModel>,
    pub api_key: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<String>,
    /// New API 系统访问令牌（查钱包）；空 / None = 不改。清除不走这里——
    /// 见 `clear_gateway_wallet_token`（带二次确认的专用命令）
    #[serde(default)]
    pub wallet_access_token: Option<String>,
    /// Some("") 清空；None 不改
    #[serde(default)]
    pub wallet_user_id: Option<String>,
    /// 明确删除密钥；不发或 false = 不改（save_gateway 不通过推断隐式删密钥）
    #[serde(default)]
    pub clear_key: bool,
    /// 前端拉取目录后保存时回传；None = 不改
    #[serde(default)]
    pub catalog_fetched_at: Option<String>,
    #[serde(default)]
    pub catalog_from_slot: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingInput {
    pub agent: String,
    /// 绑定级配置名；选用已有网关时也必须独立保存。
    #[serde(default)]
    pub name: String,
    pub gateway_id: Option<String>,
    #[serde(default)]
    pub kind: BindingKind,
    pub protocol: Option<String>,
    #[serde(default)]
    pub api_backend: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub role_models: RoleModels,
    #[serde(default)]
    pub extra_env: std::collections::HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    pub agent: String,
    pub name: String,
    #[serde(default)]
    pub account_type: AccountType,
    #[serde(default)]
    pub no_auth: bool,
    pub protocol: Option<String>,
    #[serde(default)]
    pub api_backend: Option<String>,
    pub base_url: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    /// 模型分工；None = 不改（旧调用方不带这个键时保留已存的分工）
    #[serde(default)]
    pub role_models: Option<RoleModels>,
    #[serde(default)]
    pub extra_env: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub request_policy: RequestPolicy,
    /// 明文密钥，写入 keys.json 后丢弃；空 / None 表示不设置或不修改
    pub api_key: Option<String>,
    /// 绑定保存时对照的网关内容版本；不匹配则拒绝，避免旧表单覆盖共享网关。
    #[serde(default)]
    pub expected_gateway_revision: Option<String>,
}

/// keys.json 里系统访问令牌的键：网关 id + `#wallet`（UUID 不含 #，不与推理密钥撞）
pub(crate) fn wallet_key_id(gateway_id: &str) -> String {
    format!("{gateway_id}#wallet")
}

/// 取密钥尾号做界面提示，过短的 key 整体打码
fn key_hint_of(key: &str) -> String {
    let tail: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if key.chars().count() > 4 {
        format!("···{tail}")
    } else {
        "····".into()
    }
}

/// 清洗模型列表：去空白、去空串、去重保序
fn normalize_models(models: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    models
        .into_iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .filter(|m| seen.insert(m.clone()))
        .collect()
}

/// 同一 Agent/网关下，只有完全相同的模型选择与绑定参数才算重复。
/// 模型列表顺序有意义：第一个模型是该连接的默认模型。
fn same_binding_selection(
    binding: &Binding,
    agent: &str,
    gateway_id: &str,
    protocol: Option<&str>,
    api_backend: Option<&str>,
    models: &[String],
    extra_env: &std::collections::HashMap<String, String>,
) -> bool {
    binding.agent == agent
        && binding.gateway_id.as_deref() == Some(gateway_id)
        && binding.protocol.as_deref() == protocol
        && binding.api_backend.as_deref() == api_backend
        && normalize_models(binding.models.clone()) == models
        && binding.extra_env == *extra_env
}

/// §2 唯一约束的单一入口：candidate 与现有绑定逐条比对，`skip_id` 用于编辑场景排除自身。
/// 新建 / 复制 / 编辑 / 导入四条路都必须过这里——少一条就能「改一次模型」绕过约束。
fn has_duplicate_binding(bindings: &[Binding], skip_id: Option<&str>, candidate: &Binding) -> bool {
    let Some(gid) = candidate.gateway_id.as_deref() else {
        return false;
    };
    let models = normalize_models(candidate.models.clone());
    bindings.iter().any(|b| {
        Some(b.id.as_str()) != skip_id
            && same_binding_selection(
                b,
                &candidate.agent,
                gid,
                candidate.protocol.as_deref(),
                candidate.api_backend.as_deref(),
                &models,
                &candidate.extra_env,
            )
    })
}

/// 编辑路径的 §2 判定（`update`；store 方法要写真实配置目录，无法单测，故独立成纯函数）。
/// `original` 是改之前那条，`bindings[idx]` 是改之后的：
/// **模型选择本身没动就放行**——约束补上之前由编辑路径造出的历史重复对，
/// 否则那条连接连改名字都存不了；只要选择真的变了（协议 / 后端 / 名单 / extraEnv）
/// 就走单一入口照拦。
fn update_selection_conflicts(bindings: &[Binding], idx: usize, original: &Binding) -> bool {
    let Some(cur) = bindings.get(idx) else {
        return false;
    };
    let Some(gid) = cur.gateway_id.as_deref() else {
        return false;
    };
    let selection_moved = !same_binding_selection(
        original,
        &cur.agent,
        gid,
        cur.protocol.as_deref(),
        cur.api_backend.as_deref(),
        &cur.models,
        &cur.extra_env,
    );
    selection_moved && has_duplicate_binding(bindings, Some(cur.id.as_str()), cur)
}

/// 认证类环境变量闭集：既是「无密钥模式不得附加」的判据（profile_validation），
/// 也是导出时按名剔除的判据——**两处必须同源**，否则会出现「认证变量被原样导出成明文」。
/// `OPENCODE_CONFIG_CONTENT` 不含 KEY/TOKEN 字面（它内嵌整份带凭据的配置），
/// 只有这张表能兜住：导出剔除必须查它，不能只靠子串启发式。
pub(crate) const AUTH_BEARING_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "CODEBUDDY_API_KEY",
    "CODEBUDDY_AUTH_TOKEN",
    "CURSOR_API_KEY",
    "XAI_API_KEY",
    "GROK_CODE_XAI_API_KEY",
    "KIMI_API_KEY",
    "KIMI_MODEL_API_KEY",
    "OPENCODE_CONFIG_CONTENT",
];

/// 闭集精确命中（大小写不敏感）：用于「无密钥模式不得附加认证变量」的 fail-loud 判定。
pub(crate) fn auth_bearing_env_name(name: &str) -> bool {
    AUTH_BEARING_ENV.contains(&name.to_ascii_uppercase().as_str())
}

/// 导出/展示侧按名剔除：闭集命中，外加 KEY/TOKEN/SECRET/PASSWORD/AUTH 子串启发式。
/// 宁可多剔（子串误伤无害），不可漏剔（一次泄漏就进别人的导入文件）。
pub(crate) fn sensitive_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    auth_bearing_env_name(name)
        || ["KEY", "TOKEN", "SECRET", "PASSWORD", "AUTH"]
            .iter()
            .any(|part| upper.contains(part))
}

pub struct ProfileStore {
    path: PathBuf,
    /// 测试专用：持有配置根重定向的守卫，store 活多久隔离就维持多久。
    /// 生产构建下是零大小占位（见 `storage::ConfigRootGuard`）。
    ///
    /// 放在 store 上而不是让测试自己记着「进进出出」，是因为隔离一旦靠人守就容易漏：
    /// `save_gateway` 等入口调的是 `gateway_store` 的自由函数，它们不看 store 参数，
    /// 只看当前线程上有没有覆盖。
    _root_guard: crate::storage::ConfigRootGuard,
}

/// 用户 Codex 配置的 `model_catalog_json` 是否指着这个文件
fn codex_config_references(path: &std::path::Path) -> bool {
    crate::agent_specs::codex_user_config()
        .and_then(|cfg| cfg.get("model_catalog_json")?.as_str().map(str::to_string))
        .is_some_and(|p| crate::paths::same_path(&p, &path.to_string_lossy()))
}

impl ProfileStore {
    pub fn new() -> Result<Self, String> {
        let dir = crate::storage::config_root().ok_or("无法确定平台配置目录")?;
        fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
        Ok(Self {
            path: dir.join("profiles.json"),
            _root_guard: crate::storage::inert_config_root(),
        })
    }

    /// 只读场景的构造（config_dump 自省快照）：配置目录不存在返回 None，
    /// 不像 new() 那样建目录——只读路径不得有写副作用
    pub(crate) fn existing() -> Option<Self> {
        let dir = crate::storage::config_root()?;
        dir.is_dir().then(|| Self {
            path: dir.join("profiles.json"),
            _root_guard: crate::storage::inert_config_root(),
        })
    }

    /// 测试专用：在任意目录建一个 store，不碰真实配置目录。
    ///
    /// 重定向的不只是 `profiles.json`——整个配置根都跟着走（gateways.json、
    /// bindings.json、keys.json、锁）。以前只挪了 `profiles.json`，于是
    /// `save_gateway` 这类经 `gateway_store` 自由函数的入口仍写真实目录，
    /// 网关库里攒下 68 条 `api.example.com` 假网关（2026-09-26 修）。
    #[cfg(test)]
    pub(crate) fn new_for_test(dir: &std::path::Path) -> Self {
        Self {
            path: dir.join("profiles.json"),
            _root_guard: crate::storage::redirect_config_root(dir),
        }
    }

    fn read_legacy_profiles(&self) -> Result<Vec<Profile>, String> {
        match fs::read_to_string(&self.path) {
            Ok(text) => {
                serde_json::from_str(&text).map_err(|e| format!("解析 profiles.json 失败: {e}"))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(format!("读取 profiles.json 失败: {e}")),
        }
    }

    /// 首次把 profiles.json 拆成 gateways.json + bindings.json。调用方须已持 store_lock。
    pub(crate) fn ensure_split_locked(&self) -> Result<(), String> {
        let pending = self.path.with_file_name("gateway-split.pending.json");
        if pending.exists() {
            let result = serde_json::from_str::<crate::gateway_store::MigrationResult>(
                &fs::read_to_string(&pending).map_err(|e| e.to_string())?,
            )
            .map_err(|e| format!("配置迁移恢复记录损坏，拒绝覆盖：{e}"))?;
            return finish_split_migration(&pending, &result);
        }
        if crate::gateway_store::split_migrated() {
            // 旧版曾在写完 bindings 后、迁移 keys 前中断；保留 ID 可无猜测修复引用。
            let keys_file = keys_path()?;
            let mut keys = read_keys_at(&keys_file)?;
            let bindings = crate::gateway_store::load_bindings()?;
            let gateways = crate::gateway_store::load_gateways()?;
            if repair_legacy_key_links(&bindings, &gateways, &mut keys) {
                write_keys_at(&keys_file, &keys)?;
            }
            return Ok(());
        }
        let old = self.read_legacy_profiles()?;
        if old.is_empty() && !self.path.exists() {
            crate::gateway_store::save_gateways(&[])?;
            crate::gateway_store::save_bindings(&[])?;
            return Ok(());
        }
        let keys_file = keys_path()?;
        let mut old_keys = read_keys_at(&keys_file)?;
        for p in &old {
            if old_keys.contains_key(&p.id) {
                continue;
            }
            if let Some(k) = key_entry(&p.id)
                .ok()
                .and_then(|e| e.get_password().ok())
                .filter(|s| !s.is_empty())
            {
                old_keys.insert(p.id.clone(), k);
            }
        }
        let result = crate::gateway_store::migrate_from_profiles(old, old_keys);
        backup_split_sidecars(&self.path, &keys_file)?;
        let text = serde_json::to_vec(&result).map_err(|e| e.to_string())?;
        crate::storage::atomic_write(&pending, &text, true)?;
        finish_split_migration(&pending, &result)
    }

    fn materialize_locked(&self, selected_model: Option<&str>) -> Result<Vec<Profile>, String> {
        self.ensure_split_locked()?;
        let gateways = crate::gateway_store::load_gateways()?;
        let bindings = crate::gateway_store::load_bindings()?;
        let mut out = Vec::with_capacity(bindings.len());
        for b in &bindings {
            let gw = b
                .gateway_id
                .as_deref()
                .and_then(|id| gateways.iter().find(|g| g.id == id));
            let mut p = crate::gateway_store::materialize(b, gw, selected_model);
            p.has_key = match &b.gateway_id {
                Some(gid) => has_key_locked(gid)?,
                None => false,
            };
            crate::gateway_store::refresh_profile_connection_state(&mut p, b, gw);
            if p.models.is_empty() {
                if let Some(m) = p.model.take() {
                    p.models = vec![m];
                }
            }
            out.push(p);
        }
        Ok(out)
    }

    /// list 的锁内版本：调用方须已持 store_lock
    fn list_locked(&self) -> Result<Vec<Profile>, String> {
        self.materialize_locked(None)
    }

    pub fn list(&self) -> Result<Vec<Profile>, String> {
        let _g = store_lock()?;
        self.list_locked()
    }

    pub fn get(&self, id: &str) -> Result<Profile, String> {
        self.get_with_model(id, None)
    }

    /// 按启动选中模型物化策略字段（温度/effort 取该模型，不是名单首个）。
    pub fn get_with_model(
        &self,
        id: &str,
        selected_model: Option<&str>,
    ) -> Result<Profile, String> {
        let _g = store_lock()?;
        self.get_locked_with_model(id, selected_model)
    }

    /// get 的锁内版本：调用方须已持 store_lock
    fn get_locked(&self, id: &str) -> Result<Profile, String> {
        self.get_locked_with_model(id, None)
    }

    fn get_locked_with_model(
        &self,
        id: &str,
        selected_model: Option<&str>,
    ) -> Result<Profile, String> {
        self.ensure_split_locked()?;
        let bindings = crate::gateway_store::load_bindings()?;
        let b = bindings
            .iter()
            .find(|b| b.id == id)
            .ok_or_else(|| format!("profile 不存在: {id}"))?;
        let gateways = crate::gateway_store::load_gateways()?;
        let gw = b
            .gateway_id
            .as_deref()
            .and_then(|gid| gateways.iter().find(|g| g.id == gid));
        let mut p = crate::gateway_store::materialize(b, gw, selected_model);
        p.has_key = match &b.gateway_id {
            Some(gid) => has_key_locked(gid)?,
            None => false,
        };
        crate::gateway_store::refresh_profile_connection_state(&mut p, b, gw);
        Ok(p)
    }

    pub fn create(&self, input: ProfileInput) -> Result<Profile, String> {
        let _g = store_lock()?;
        self.ensure_split_locked()?;
        if input.account_type == AccountType::Official {
            let mut bindings = crate::gateway_store::load_bindings()?;
            if bindings
                .iter()
                .any(|b| b.agent == input.agent && b.kind == BindingKind::Official)
            {
                return Err("该 Agent 已有官方账号绑定".into());
            }
            let binding = Binding {
                id: uuid::Uuid::new_v4().to_string(),
                agent: input.agent,
                name: "官方账号".into(),
                kind: BindingKind::Official,
                gateway_id: None,
                protocol: None,
                api_backend: None,
                models: normalize_models(input.models),
                role_models: input.role_models.clone().unwrap_or_default().normalized(),
                extra_env: input.extra_env,
                last_used_at: None,
            };
            let profile = crate::gateway_store::materialize(&binding, None, None);
            crate::profile_validation::validate_profile_fields(&profile)?;
            bindings.push(binding);
            crate::gateway_store::save_bindings(&bindings)?;
            return Ok(profile);
        }
        let models = normalize_models(input.models);
        let mut gateway = Gateway {
            id: uuid::Uuid::new_v4().to_string(),
            name: input.name.clone(),
            no_auth: input.no_auth,
            key_hint: None,
            wallet_user_id: None,
            wallet_key_hint: None,
            slots: ProtocolSlots::default(),
            header_env: input.request_policy.header_env.clone(),
            models: models
                .iter()
                .map(|id| GatewayModel {
                    id: id.clone(),
                    source: "user".into(),
                    status: "available".into(),
                    last_seen_at: None,
                    catalog_slot: None,
                    temperature: input.request_policy.temperature,
                    top_p: input.request_policy.top_p,
                    max_output_tokens: input.request_policy.max_output_tokens,
                    reasoning_effort: input.request_policy.reasoning_effort.clone(),
                })
                .collect(),
            catalog_fetched_at: None,
            catalog_from_slot: None,
            last_probe: Vec::new(),
            slot_probes: Vec::new(),
            revision: String::new(),
            compat: Default::default(),
        };
        let slot = crate::gateway_store::slot_for_agent(&input.agent, input.protocol.as_deref());
        crate::gateway_store::set_slot_url(
            &mut gateway.slots,
            slot,
            input.base_url.clone().filter(|s| !s.is_empty()),
        );
        let pending_key = input.api_key.filter(|k| !k.is_empty());
        if let Some(key) = &pending_key {
            gateway.key_hint = Some(key_hint_of(key));
        }
        let binding = Binding {
            id: uuid::Uuid::new_v4().to_string(),
            agent: input.agent.clone(),
            name: input.name.clone(),
            kind: BindingKind::Api,
            gateway_id: Some(gateway.id.clone()),
            protocol: input.protocol.clone(),
            api_backend: input.api_backend.clone(),
            models: models.clone(),
            role_models: input.role_models.clone().unwrap_or_default().normalized(),
            extra_env: input.extra_env.clone(),
            last_used_at: None,
        };
        let mut profile = crate::gateway_store::materialize(&binding, Some(&gateway), None);
        profile.has_key = gateway.key_hint.is_some();
        crate::profile_validation::validate_profile_fields(&profile)?;
        let mut gateways = crate::gateway_store::load_gateways()?;
        let mut bindings = crate::gateway_store::load_bindings()?;
        let old_gateways = gateways.clone();
        let old_bindings = bindings.clone();
        let gid = gateway.id.clone();
        gateways.push(gateway);
        bindings.push(binding);
        commit_gateway_binding_files(&old_gateways, &old_bindings, &gateways, &bindings)?;
        if let Some(key) = pending_key {
            if let Err(error) = set_key(&gid, &key) {
                let _ = commit_gateway_binding_files(
                    &gateways,
                    &bindings,
                    &old_gateways,
                    &old_bindings,
                );
                return Err(error);
            }
        }
        Ok(profile)
    }

    /// 复制配置：克隆网关（新 id）再绑到同一 Agent。同一网关不能绑两次。
    pub fn duplicate(&self, id: &str) -> Result<Profile, String> {
        let _g = store_lock()?;
        self.ensure_split_locked()?;
        let src = self.get_locked(id)?;
        if src.account_type == AccountType::Official {
            return Err("官方账号绑定不能复制".into());
        }
        let Some(gid) = src.gateway_id.clone() else {
            return Err("这条绑定没有网关".into());
        };
        let mut gateways = crate::gateway_store::load_gateways()?;
        let mut bindings = crate::gateway_store::load_bindings()?;
        let src_gw = gateways
            .iter()
            .find(|g| g.id == gid)
            .ok_or("网关不存在")?
            .clone();
        let mut gw = src_gw;
        gw.id = uuid::Uuid::new_v4().to_string();
        let existing: Vec<&str> = gateways.iter().map(|g| g.name.as_str()).collect();
        gw.name = copy_name(&existing, &gw.name);
        gw.last_probe.clear();
        let pending_key = get_key_locked(&gid)?;
        let new_gid = gw.id.clone();
        let binding = Binding {
            id: uuid::Uuid::new_v4().to_string(),
            agent: src.agent.clone(),
            name: copy_name(
                &bindings
                    .iter()
                    .filter(|b| b.agent == src.agent)
                    .map(|b| b.name.as_str())
                    .collect::<Vec<_>>(),
                &src.name,
            ),
            kind: BindingKind::Api,
            gateway_id: Some(gw.id.clone()),
            protocol: src.protocol.clone(),
            api_backend: src.api_backend.clone(),
            models: src.models.clone(),
            role_models: Default::default(),
            extra_env: src.extra_env.clone(),
            last_used_at: None,
        };
        let mut copy = crate::gateway_store::materialize(&binding, Some(&gw), None);
        copy.has_key = pending_key.is_some();
        crate::profile_validation::validate_profile_fields(&copy)?;
        let old_gateways = gateways.clone();
        let old_bindings = bindings.clone();
        gateways.push(gw);
        bindings.push(binding);
        commit_gateway_binding_files(&old_gateways, &old_bindings, &gateways, &bindings)?;
        if let Some(key) = pending_key {
            if let Err(error) = set_key(&new_gid, &key) {
                let _ = commit_gateway_binding_files(
                    &gateways,
                    &bindings,
                    &old_gateways,
                    &old_bindings,
                );
                return Err(error);
            }
        }
        if let Some(tok) = get_key_locked(&wallet_key_id(&gid))? {
            if let Err(error) = set_key(&wallet_key_id(&new_gid), &tok) {
                let _ = delete_key(&new_gid);
                let _ = commit_gateway_binding_files(
                    &gateways,
                    &bindings,
                    &old_gateways,
                    &old_bindings,
                );
                return Err(error);
            }
        }
        Ok(copy)
    }

    /// 把该网关绑到目标 Agent。缺槽时把源 URL 填进目标槽（与旧「复制」同 URL 行为）。
    pub fn copy_to_agent(&self, id: &str, target_agent: &str) -> Result<Profile, String> {
        let _g = store_lock()?;
        self.ensure_split_locked()?;
        let src = self.get_locked(id)?;
        if target_agent == src.agent {
            return Err("目标与来源是同一个 agent，请用「复制配置」".into());
        }
        if src.account_type == AccountType::Official {
            return Err("官方账号不能绑到其他 Agent".into());
        }
        let protocol = pick_copy_protocol(&src, target_agent)?;
        let Some(gid) = src.gateway_id.clone() else {
            return Err("这条绑定没有网关".into());
        };
        let mut bindings = crate::gateway_store::load_bindings()?;
        let models = normalize_models(src.models.clone());
        // 先拼候选再查重（唯一约束单一入口），候选本身随后就是要落盘的那条
        let binding = Binding {
            id: uuid::Uuid::new_v4().to_string(),
            agent: target_agent.to_string(),
            name: src.name.clone(),
            kind: BindingKind::Api,
            gateway_id: Some(gid.clone()),
            protocol,
            // grok 专用字段不跨 agent 携带；绑到 grok 时取缺省（chat_completions）
            api_backend: None,
            models,
            role_models: src.role_models.clone(),
            extra_env: src.extra_env.clone(),
            last_used_at: None,
        };
        if has_duplicate_binding(&bindings, None, &binding) {
            return Err("该 Agent 已经有相同模型选择的绑定".into());
        }
        let mut gateways = crate::gateway_store::load_gateways()?;
        let old_gateways = gateways.clone();
        let old_bindings = bindings.clone();
        let gw = gateways
            .iter_mut()
            .find(|g| g.id == gid)
            .ok_or("网关不存在")?;
        let slot = crate::gateway_store::slot_for_agent(target_agent, binding.protocol.as_deref());
        if crate::gateway_store::slot_url(&gw.slots, slot).is_none() {
            crate::gateway_store::set_slot_url(&mut gw.slots, slot, src.base_url.clone());
        }
        let mut copy = crate::gateway_store::materialize(&binding, Some(gw), None);
        copy.has_key = has_key_locked(&gid)?;
        crate::profile_validation::validate_profile_fields(&copy)?;
        bindings.push(binding);
        commit_gateway_binding_files(&old_gateways, &old_bindings, &gateways, &bindings)?;
        Ok(copy)
    }

    pub fn update(&self, id: &str, input: ProfileInput) -> Result<Profile, String> {
        let _g = store_lock()?;
        self.ensure_split_locked()?;
        let mut bindings = crate::gateway_store::load_bindings()?;
        let idx = bindings
            .iter()
            .position(|b| b.id == id)
            .ok_or_else(|| format!("profile 不存在: {id}"))?;
        if bindings[idx].agent != input.agent {
            return Err("连接创建后不能直接更换 Agent，请使用「复制到其他 Agent」".into());
        }
        if input.account_type == AccountType::Official && input.no_auth {
            return Err("官方账号不能设置为无密钥模式".into());
        }
        // 改之前的原样：用来判断「模型选择本身有没有动」（历史遗留的重复对不该连改名都存不了）
        let original = bindings[idx].clone();
        if !input.name.trim().is_empty() {
            bindings[idx].name = input.name.trim().to_string();
        }
        bindings[idx].protocol = input.protocol.clone();
        bindings[idx].api_backend = input.api_backend.clone();
        bindings[idx].models = normalize_models(input.models.clone());
        // 模型分工：调用方带了才改；名单里已没有的分工作废（回到「跟主模型」）
        if let Some(roles) = input.role_models.clone() {
            bindings[idx].role_models = roles.normalized();
        }
        let listed = bindings[idx].models.clone();
        let roles = &mut bindings[idx].role_models;
        for slot in [&mut roles.small, &mut roles.subagent] {
            if slot.as_ref().is_some_and(|m| !listed.contains(m)) {
                *slot = None;
            }
        }
        bindings[idx].extra_env = input.extra_env.clone();
        let gateways = crate::gateway_store::load_gateways()?;
        if bindings[idx].kind == BindingKind::Official {
            if input.account_type != AccountType::Official {
                return Err("官方账号绑定不能改成 API 连接，请新建".into());
            }
            let profile = crate::gateway_store::materialize(&bindings[idx], None, None);
            crate::profile_validation::validate_profile_fields(&profile)?;
            crate::gateway_store::save_bindings(&bindings)?;
            return Ok(profile);
        }
        let gid = bindings[idx].gateway_id.clone().ok_or("这条绑定没有网关")?;
        // §2 唯一约束在编辑路径同样成立（原先只有新建/复制/导入守这条：
        // 把 A 的模型选择改成与 B 完全相同即可绕过）
        if update_selection_conflicts(&bindings, idx, &original) {
            return Err("该 Agent 已经有相同模型选择的绑定".into());
        }
        let gw_idx = gateways
            .iter()
            .position(|g| g.id == gid)
            .ok_or("网关不存在")?;
        if let Some(expected) = input
            .expected_gateway_revision
            .as_deref()
            .filter(|s| !s.is_empty())
        {
            let current = crate::gateway_store::gateway_content_revision(&gateways[gw_idx]);
            if current != expected {
                return Err("网关已被其他窗口修改，未写入绑定。请关闭后重新打开再保存。".into());
            }
        }
        // 绑定编辑只改绑定字段。端点、密钥、noAuth、Header 只走网关接口，避免旧表单覆盖共享网关。
        let mut profile =
            crate::gateway_store::materialize(&bindings[idx], Some(&gateways[gw_idx]), None);
        profile.has_key = has_key_locked(&gid)?;
        crate::profile_validation::validate_profile_fields(&profile)?;
        crate::gateway_store::save_bindings(&bindings)?;
        Ok(profile)
    }

    /// 解绑。不删网关、不动密钥。
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let _g = store_lock()?;
        self.ensure_split_locked()?;
        let mut bindings = crate::gateway_store::load_bindings()?;
        bindings.retain(|b| b.id != id);
        crate::gateway_store::save_bindings(&bindings)?;
        // 外部 Codex 的 config.toml 还指着这份模型目录（这条连接曾设为全局）时留着：删了外部 codex 直接起不来
        //（`failed to load configuration`，2026-10-30 隔离 CODEX_HOME 实测）
        let catalog = crate::agents::codex_catalog_path(id);
        if let Some(p) = catalog.filter(|p| !codex_config_references(p)) {
            let _ = fs::remove_file(p);
        }
        crate::settings::clear_profile_refs(id);
        crate::projects::clear_project_default_profile(id);
        // W2a：tasks 表（科研/工作目标的显式绑定）同口径级联——agent 恒随 profile，
        // 连接没了 agent 一并回落；schedules.json 不清（无人值守 fail-loud 铁律，
        // 死引用由读侧标 missing + 执行侧留失败 Run，清了反而会静默换家）
        crate::runs::clear_task_profile_refs(id);
        Ok(())
    }

    pub fn clear_key(&self, id: &str) -> Result<(), String> {
        let _g = store_lock()?;
        self.ensure_split_locked()?;
        let bindings = crate::gateway_store::load_bindings()?;
        let b = bindings
            .iter()
            .find(|b| b.id == id)
            .ok_or_else(|| format!("profile 不存在: {id}"))?;
        let Some(gid) = &b.gateway_id else {
            return Ok(());
        };
        let mut gateways = crate::gateway_store::load_gateways()?;
        let old_gateways = gateways.clone();
        if let Some(g) = gateways.iter_mut().find(|g| g.id == *gid) {
            g.key_hint = None;
            crate::gateway_store::invalidate_all_probes(g);
        }
        crate::gateway_store::save_gateways(&gateways)?;
        if let Err(error) = delete_key(gid) {
            let _ = crate::gateway_store::save_gateways(&old_gateways);
            return Err(error);
        }
        Ok(())
    }

    /// 每次用于启动即刷新 last_used_at（§6.12 E）；失败静默，不影响启动
    pub fn touch_last_used(&self, id: &str) {
        let Ok(_g) = store_lock() else { return };
        let _ = (|| -> Result<(), String> {
            self.ensure_split_locked()?;
            let mut bindings = crate::gateway_store::load_bindings()?;
            if let Some(b) = bindings.iter_mut().find(|b| b.id == id) {
                b.last_used_at = Some(crate::sessions::now_iso());
                crate::gateway_store::save_bindings(&bindings)?;
            }
            Ok(())
        })();
    }

    pub fn list_gateways(&self) -> Result<Vec<Gateway>, String> {
        let _g = store_lock()?;
        self.ensure_split_locked()?;
        let mut items = crate::gateway_store::load_gateways()?;
        for g in &mut items {
            g.key_hint = if has_key_locked(&g.id)? {
                g.key_hint.clone().or(Some("····".into()))
            } else {
                None
            };
            g.wallet_key_hint = if has_key_locked(&wallet_key_id(&g.id))? {
                g.wallet_key_hint.clone().or(Some("····".into()))
            } else {
                None
            };
            g.slot_probes = crate::gateway_store::slot_probe_summaries(&g.last_probe);
            g.revision = crate::gateway_store::gateway_content_revision(g);
        }
        Ok(items)
    }

    pub fn save_gateway(&self, id: Option<String>, input: GatewayInput) -> Result<Gateway, String> {
        let _g = store_lock()?;
        self.ensure_split_locked()?;
        crate::profile_validation::validate_slot_urls(&input.slots)?;
        let mut gateways = crate::gateway_store::load_gateways()?;
        if let Some(id) = id {
            let idx = gateways
                .iter()
                .position(|g| g.id == id)
                .ok_or("网关不存在")?;
            if let Some(expected) = input.expected_revision.as_deref().filter(|s| !s.is_empty()) {
                let current = crate::gateway_store::gateway_content_revision(&gateways[idx]);
                if current != expected {
                    return Err("网关数据已变更（可能是后台目录刷新），未覆盖。请重新打开后再保存。".into());
                }
            }
            let old = gateways[idx].clone();
            gateways[idx].name = input.name;
            gateways[idx].no_auth = input.no_auth;
            gateways[idx].slots = input.slots;
            gateways[idx].header_env = input.header_env;
            if let Some(c) = input.compat {
                gateways[idx].compat = c;
            }
            // 按 id 合并：保留目录同步字段（status/last_seen_at/catalog_slot），
            // 用 input 的策略字段（temperature/top_p 等）覆盖；input 没有的条目保留原有记录。
            {
                let mut next: Vec<GatewayModel> = input.models.iter().map(|incoming| {
                    if let Some(existing) = gateways[idx].models.iter().find(|m| m.id == incoming.id) {
                        GatewayModel {
                            id: incoming.id.clone(),
                            source: incoming.source.clone(),
                            status: existing.status.clone(),
                            last_seen_at: existing.last_seen_at.clone(),
                            catalog_slot: existing.catalog_slot.clone(),
                            temperature: incoming.temperature,
                            top_p: incoming.top_p,
                            max_output_tokens: incoming.max_output_tokens,
                            reasoning_effort: incoming.reasoning_effort.clone(),
                        }
                    } else {
                        incoming.clone()
                    }
                }).collect();
                // 保留 input 里没有但原来存在的条目（例如目录已拉取、用户未选的模型）
                for existing in &gateways[idx].models {
                    if !next.iter().any(|m| m.id == existing.id) {
                        next.push(existing.clone());
                    }
                }
                gateways[idx].models = next;
            }
            // Bug #6: 前端在保存前已拉取目录时回传 catalog 字段；None 表示不改（保留后端已有值）
            if let Some(fetched_at) = input.catalog_fetched_at {
                gateways[idx].catalog_fetched_at = Some(fetched_at);
            }
            if let Some(from_slot) = input.catalog_from_slot {
                gateways[idx].catalog_from_slot = Some(from_slot);
            }
            if old.slots.anthropic != gateways[idx].slots.anthropic {
                crate::gateway_store::invalidate_slot_probes(
                    &mut gateways[idx],
                    crate::gateway_store::Slot::Anthropic,
                );
            }
            if old.slots.openai != gateways[idx].slots.openai {
                crate::gateway_store::invalidate_slot_probes(
                    &mut gateways[idx],
                    crate::gateway_store::Slot::Openai,
                );
            }
            if old.slots.responses != gateways[idx].slots.responses {
                crate::gateway_store::invalidate_slot_probes(
                    &mut gateways[idx],
                    crate::gateway_store::Slot::Responses,
                );
            }
            if old.slots.gemini != gateways[idx].slots.gemini {
                crate::gateway_store::invalidate_slot_probes(
                    &mut gateways[idx],
                    crate::gateway_store::Slot::Gemini,
                );
            }
            if old.slots.cursor != gateways[idx].slots.cursor {
                crate::gateway_store::invalidate_slot_probes(
                    &mut gateways[idx],
                    crate::gateway_store::Slot::Cursor,
                );
            }
            let key_changed = input.api_key.as_deref().is_some_and(|k| !k.is_empty());
            if key_changed || old.no_auth != gateways[idx].no_auth {
                crate::gateway_store::invalidate_all_probes(&mut gateways[idx]);
            }
            let pending_key = input.api_key.filter(|k| !k.is_empty());
            let clear_key = input.clear_key && pending_key.is_none();
            if let Some(key) = &pending_key {
                gateways[idx].key_hint = Some(key_hint_of(key));
            } else if clear_key {
                gateways[idx].key_hint = None;
            }
            let pending_wallet = input.wallet_access_token.filter(|k| !k.trim().is_empty());
            if let Some(tok) = &pending_wallet {
                gateways[idx].wallet_key_hint = Some(key_hint_of(tok));
            }
            if let Some(uid) = input.wallet_user_id {
                let t = uid.trim();
                gateways[idx].wallet_user_id = if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                };
            }
            let saved = gateways[idx].clone();
            crate::gateway_store::save_gateways(&gateways)?;
            if let Some(key) = pending_key {
                if let Err(error) = set_key(&id, &key) {
                    gateways[idx] = old;
                    let _ = crate::gateway_store::save_gateways(&gateways);
                    return Err(error);
                }
            } else if clear_key {
                if let Err(error) = delete_key(&id) {
                    gateways[idx] = old;
                    let _ = crate::gateway_store::save_gateways(&gateways);
                    return Err(error);
                }
            }
            if let Some(tok) = pending_wallet {
                if let Err(error) = set_key(&wallet_key_id(&id), &tok) {
                    gateways[idx] = old;
                    let _ = crate::gateway_store::save_gateways(&gateways);
                    return Err(error);
                }
            }
            Ok(saved)
        } else {
            let mut gw = Gateway {
                id: uuid::Uuid::new_v4().to_string(),
                name: input.name,
                no_auth: input.no_auth,
                key_hint: None,
                wallet_user_id: None,
                wallet_key_hint: None,
                slots: input.slots,
                header_env: input.header_env,
                compat: input.compat.unwrap_or_default(),
                models: input.models,
                catalog_fetched_at: input.catalog_fetched_at,
                catalog_from_slot: input.catalog_from_slot,
                last_probe: Vec::new(),
                slot_probes: Vec::new(),
                revision: String::new(),
            };
            let pending_key = input.api_key.filter(|k| !k.is_empty());
            if let Some(key) = &pending_key {
                gw.key_hint = Some(key_hint_of(key));
            }
            let pending_wallet = input.wallet_access_token.filter(|k| !k.trim().is_empty());
            if let Some(tok) = &pending_wallet {
                gw.wallet_key_hint = Some(key_hint_of(tok));
            }
            if let Some(uid) = input.wallet_user_id {
                let t = uid.trim();
                gw.wallet_user_id = if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                };
            }
            let gid = gw.id.clone();
            let old_gateways = gateways.clone();
            gateways.push(gw.clone());
            crate::gateway_store::save_gateways(&gateways)?;
            if let Some(key) = pending_key {
                if let Err(error) = set_key(&gid, &key) {
                    let _ = crate::gateway_store::save_gateways(&old_gateways);
                    return Err(error);
                }
            }
            if let Some(tok) = pending_wallet {
                if let Err(error) = set_key(&wallet_key_id(&gid), &tok) {
                    let _ = delete_key(&gid);
                    let _ = crate::gateway_store::save_gateways(&old_gateways);
                    return Err(error);
                }
            }
            Ok(gw)
        }
    }

    pub fn delete_gateway(&self, id: &str) -> Result<(), String> {
        let _g = store_lock()?;
        self.ensure_split_locked()?;
        let bindings = crate::gateway_store::load_bindings()?;
        if bindings.iter().any(|b| b.gateway_id.as_deref() == Some(id)) {
            return Err("还有 Agent 绑着这个网关，请先解绑".into());
        }
        let mut gateways = crate::gateway_store::load_gateways()?;
        let old_gateways = gateways.clone();
        gateways.retain(|g| g.id != id);
        crate::gateway_store::save_gateways(&gateways)?;
        if let Err(error) = delete_gateway_secrets(id) {
            let _ = crate::gateway_store::save_gateways(&old_gateways);
            return Err(error);
        }
        crate::model_registry::purge_relay_for_gateway(id);
        Ok(())
    }

    pub fn bind_gateway(&self, input: BindingInput) -> Result<Profile, String> {
        let _g = store_lock()?;
        self.ensure_split_locked()?;
        if input.kind == BindingKind::Official {
            drop(_g);
            return self.create(ProfileInput {
                agent: input.agent,
                name: "官方账号".into(),
                account_type: AccountType::Official,
                no_auth: false,
                protocol: None,
                api_backend: None,
                base_url: None,
                models: input.models,
                role_models: Some(input.role_models.clone()),
                extra_env: input.extra_env,
                request_policy: RequestPolicy::default(),
                api_key: None,
                expected_gateway_revision: None,
            });
        }
        let gid = input.gateway_id.clone().ok_or("请选择网关")?;
        let models = normalize_models(input.models.clone());
        let binding = Binding {
            id: uuid::Uuid::new_v4().to_string(),
            agent: input.agent.clone(),
            name: input.name.clone(),
            kind: BindingKind::Api,
            gateway_id: Some(gid.clone()),
            protocol: input.protocol.clone(),
            api_backend: input.api_backend.clone(),
            models,
            role_models: input.role_models.clone().normalized(),
            extra_env: input.extra_env.clone(),
            last_used_at: None,
        };
        let mut bindings = crate::gateway_store::load_bindings()?;
        if has_duplicate_binding(&bindings, None, &binding) {
            return Err("该 Agent 已经有相同模型选择的绑定".into());
        }
        let gateways = crate::gateway_store::load_gateways()?;
        let gw = gateways.iter().find(|g| g.id == gid).ok_or("网关不存在")?;
        let slot =
            crate::gateway_store::slot_for_agent(&binding.agent, binding.protocol.as_deref());
        if crate::gateway_store::slot_url(&gw.slots, slot).is_none() {
            return Err("这个网关还没配该协议的端点，请先在网关库补槽".into());
        }
        let mut profile = crate::gateway_store::materialize(&binding, Some(gw), None);
        profile.has_key = has_key_locked(&gid)?;
        crate::gateway_store::refresh_profile_connection_state(&mut profile, &binding, Some(gw));
        crate::profile_validation::validate_profile_fields(&profile)?;
        bindings.push(binding);
        crate::gateway_store::save_bindings(&bindings)?;
        Ok(profile)
    }

    pub fn record_probe(&self, gateway_id: &str, rec: ProbeRecord) -> Result<(), String> {
        let _g = store_lock()?;
        self.ensure_split_locked()?;
        let mut gateways = crate::gateway_store::load_gateways()?;
        let gw = gateways
            .iter_mut()
            .find(|g| g.id == gateway_id)
            .ok_or("网关不存在")?;
        if !crate::gateway_store::probe_record_still_valid(gw, &rec, has_key_locked(&gateway_id)?) {
            // 探测期间用户改了地址或密钥：旧回包不得写成新配置的结论。
            return Ok(());
        }
        gw.last_probe.retain(|p| {
            !(p.slot == rec.slot
                && p.model == rec.model
                && p.url_fp == rec.url_fp
                && p.key_fp == rec.key_fp)
        });
        gw.last_probe.push(rec);
        crate::gateway_store::save_gateways(&gateways)
    }

    pub fn merge_fetched_models(
        &self,
        gateway_id: &str,
        slot: &str,
        ids: Vec<String>,
    ) -> Result<Gateway, String> {
        let _g = store_lock()?;
        self.ensure_split_locked()?;
        let mut gateways = crate::gateway_store::load_gateways()?;
        let gw = gateways
            .iter_mut()
            .find(|g| g.id == gateway_id)
            .ok_or("网关不存在")?;
        let ids = normalize_models(ids);
        if crate::gateway_store::Slot::from_str(slot).is_none() {
            return Err(format!("未知协议槽: {slot}"));
        }
        let fetched_at = crate::sessions::now_iso();
        crate::gateway_store::apply_fetched_catalog(gw, slot, &ids, &fetched_at);
        let mut saved = gw.clone();
        saved.slot_probes = crate::gateway_store::slot_probe_summaries(&saved.last_probe);
        crate::gateway_store::save_gateways(&gateways)?;
        // 下架的模型不再留在网关实测能力缓存里
        let stale: Vec<String> = saved
            .models
            .iter()
            .filter(|m| m.status == "stale")
            .map(|m| m.id.clone())
            .collect();
        crate::model_registry::forget_relay_models(gateway_id, &stale);
        Ok(saved)
    }

    pub fn clear_gateway_key(&self, id: &str) -> Result<(), String> {
        let _g = store_lock()?;
        self.ensure_split_locked()?;
        let mut gateways = crate::gateway_store::load_gateways()?;
        let old_gateways = gateways.clone();
        if let Some(g) = gateways.iter_mut().find(|g| g.id == id) {
            g.key_hint = None;
            crate::gateway_store::invalidate_all_probes(g);
        }
        crate::gateway_store::save_gateways(&gateways)?;
        if let Err(error) = delete_key(id) {
            let _ = crate::gateway_store::save_gateways(&old_gateways);
            return Err(error);
        }
        Ok(())
    }

    pub fn clear_gateway_wallet_token(&self, id: &str) -> Result<(), String> {
        let _g = store_lock()?;
        self.ensure_split_locked()?;
        let mut gateways = crate::gateway_store::load_gateways()?;
        let old_gateways = gateways.clone();
        if let Some(g) = gateways.iter_mut().find(|g| g.id == id) {
            g.wallet_key_hint = None;
        } else {
            return Err("网关不存在".into());
        }
        crate::gateway_store::save_gateways(&gateways)?;
        if let Err(error) = delete_key(&wallet_key_id(id)) {
            let _ = crate::gateway_store::save_gateways(&old_gateways);
            return Err(error);
        }
        Ok(())
    }
}

/// 旧版拆分中断后的无猜测修复：把还挂在 binding id 下的密钥搬回网关 id。
///
/// 只在「确实同一把密钥」时搬。早先只比对「网关有没有 key_hint」，于是任何一把
/// 残留密钥都会被认领——包括当初指向别的端点的那把。用户在旧版换过网关地址后，
/// 这把错密钥会转正成当前网关的凭证，请求带着它打到新端点（每次都是 401，
/// 而 UI 显示「已配置密钥」）。
///
/// 认领判据是密钥**尾 4 位**。尾号不是身份，只是当时能拿到的上界——拆分迁移没有把
/// 旧 `base_url` 留在 binding 上（只留了 id），所以端点身份无从比对，这里不假装能比。
/// 能做的是消除歧义：尾号在多个网关间撞车时不认领（见函数内注释）。
fn repair_legacy_key_links(
    bindings: &[Binding],
    gateways: &[Gateway],
    keys: &mut std::collections::HashMap<String, String>,
) -> bool {
    let mut changed = false;
    for binding in bindings {
        let Some(gid) = binding.gateway_id.as_ref() else {
            continue;
        };
        if keys.contains_key(gid) {
            continue;
        }
        let Some(gateway) = gateways
            .iter()
            .find(|gateway| gateway.id == *gid && gateway.key_hint.is_some())
        else {
            continue;
        };
        let Some(key) = keys.get(&binding.id).cloned() else {
            continue;
        };
        let hint = key_hint_of(&key);
        // hint 是尾 4 位。对不上就是换过密钥，宁可不修也不能认错。
        if gateway.key_hint.as_deref() != Some(hint.as_str()) {
            continue;
        }
        // 尾号不是身份，只是上界：两把不同的密钥撞尾号时，认领会把 A 的密钥装到 B。
        // 端点本来能区分它们，但拆分迁移没有把 base_url 留在 binding 上（只留了 id），
        // 所以这里不再装作能认出端点——只在尾号**无歧义**时才认领：如果还有别的网关
        // 也挂着同一个尾号，那把密钥归谁就是赌，此时不搬（留作孤立密钥）比搬错强，
        // 搬错的表现是请求带着别人的密钥打到新端点（持续 401，而 UI 显示已配置）。
        if gateways
            .iter()
            .any(|other| other.id != *gid && other.key_hint.as_deref() == Some(hint.as_str()))
        {
            continue;
        }
        keys.insert(gid.clone(), key);
        changed = true;
    }
    changed
}

/// pending 文件是恢复日志；所有阶段可重放，只有最后一步才删除完成标记。
fn finish_split_migration(
    pending: &std::path::Path,
    result: &crate::gateway_store::MigrationResult,
) -> Result<(), String> {
    finish_split_at(
        pending,
        result,
        || crate::gateway_store::apply_rewrites_to_settings_and_schedules(&result.rewrites),
        |_| Ok(()),
    )
}

fn finish_split_at(
    pending: &std::path::Path,
    result: &crate::gateway_store::MigrationResult,
    rewrite_refs: impl FnOnce() -> Result<(), String>,
    mut after_stage: impl FnMut(usize) -> Result<(), String>,
) -> Result<(), String> {
    let root = pending.parent().ok_or("迁移日志路径无效")?;
    crate::storage::atomic_write(
        &root.join("gateways.json"),
        &serde_json::to_vec_pretty(&result.gateways).map_err(|e| e.to_string())?,
        true,
    )?;
    after_stage(1)?;
    write_keys_at(&root.join("keys.json"), &result.keys)?;
    after_stage(2)?;
    crate::storage::atomic_write(
        &root.join("bindings.json"),
        &serde_json::to_vec_pretty(&result.bindings).map_err(|e| e.to_string())?,
        true,
    )?;
    after_stage(3)?;
    if !result.journal.entries.is_empty() {
        crate::storage::atomic_write(
            &root.join("gateway-merge.json"),
            &serde_json::to_vec_pretty(&result.journal).map_err(|e| e.to_string())?,
            true,
        )?;
    }
    after_stage(4)?;
    rewrite_refs()?;
    after_stage(5)?;
    fs::remove_file(pending).map_err(|e| format!("完成配置迁移失败：{e}"))
}

/// 迁移前备份 profiles.json 与 keys.json（.json.bak-gateway-split），已有原始备份不覆盖。
fn backup_split_sidecars(
    profiles_path: &std::path::Path,
    keys_path: &std::path::Path,
) -> Result<(), String> {
    for path in [profiles_path, keys_path] {
        if path.exists() {
            let bak = path.with_extension("json.bak-gateway-split");
            if !bak.exists() {
                crate::storage::atomic_write(
                    &bak,
                    &fs::read(path).map_err(|e| e.to_string())?,
                    true,
                )?;
            }
        }
    }
    Ok(())
}

/// 目标名未被占用则沿用，否则追加 -2/-3…
fn copy_name(existing: &[&str], base: &str) -> String {
    if !existing.contains(&base) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}-{n}");
        if !existing.contains(&candidate.as_str()) {
            return candidate;
        }
        n += 1;
    }
}

/// 复制到其他 agent 的协议取值（copy_to_agent 用）：目标无协议概念时用固有协议族判定；
/// 多协议目标优先保留源协议取值，其次取首个与源同族的候选；不同协议族报错拒绝
fn pick_copy_protocol(src: &Profile, target_agent: &str) -> Result<Option<String>, String> {
    let spec = crate::agent_specs::agent_spec(target_agent)
        .ok_or_else(|| format!("未知 agent: {target_agent}"))?;
    let kind = crate::profile_validation::api_kind_label(&src.agent, src.protocol.as_deref());
    if spec.protocols.is_empty() {
        if crate::profile_validation::api_kind_label(target_agent, None) == kind {
            return Ok(None);
        }
    } else {
        // find 的谓词收到的是条目的引用（&&&str），逐层解引用到 &str
        let matched = |p: &&&'static str| {
            crate::profile_validation::api_kind_label(target_agent, Some(**p)) == kind
        };
        if let Some(p) = spec
            .protocols
            .iter()
            .find(|p| matched(p) && Some(**p) == src.protocol.as_deref())
            .or_else(|| spec.protocols.iter().find(matched))
        {
            return Ok(Some((*p).to_string()));
        }
    }
    let src_name = crate::agent_specs::agent_spec(&src.agent)
        .map(|s| s.display_name)
        .unwrap_or(&src.agent);
    Err(format!(
        "协议不兼容：{} 的配置（{kind} 协议）不能复制到 {}",
        src_name, spec.display_name
    ))
}

// ===== 密钥存储：0600 权限的 keys.json =====
// 不直接用 macOS 钥匙串的原因：未签名的开发构建每次热重编译都会产生新 cdhash，
// 钥匙串 ACL 随之失配，旧条目表现为"密钥消失"。0600 文件与 Codex auth.json、
// Claude Code 在 Linux 的 .credentials.json 是同一威胁模型，行为确定。
// 读取时仍会从钥匙串做一次性迁移，兼容旧版本写入的条目。

fn keys_path() -> Result<PathBuf, String> {
    Ok(crate::storage::config_root()
        .ok_or("无法确定平台配置目录")?
        .join("keys.json"))
}

/// 读取 keys.json：文件缺失视为空表；解析失败说明文件损坏——保留原件并备份为
/// keys.json.corrupt-<ts> 并返回错误，绝不当作空表继续（否则下次写回会静默清空其余密钥）
fn read_keys_at(
    path: &std::path::Path,
) -> Result<std::collections::HashMap<String, String>, String> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(e) => return Err(format!("读取 {} 失败: {e}", path.display())),
    };
    serde_json::from_str(&text).map_err(|e| {
        let backup = corrupt_backup_path(path);
        let backup_result = crate::storage::atomic_write(&backup, text.as_bytes(), true);
        match backup_result {
            Ok(()) => format!(
                "keys.json 已损坏，原件已保留并备份为 {}: {e}",
                backup.display()
            ),
            Err(error) => format!("keys.json 已损坏，原件已保留；备份失败：{error}: {e}"),
        }
    })
}

/// 损坏文件备份名：keys.json.corrupt-<unix 秒>（不用 ISO 时间，冒号在 Windows 文件名非法）
fn corrupt_backup_path(path: &std::path::Path) -> PathBuf {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".corrupt-{ts}"));
    PathBuf::from(name)
}

fn write_keys_at(
    path: &std::path::Path,
    keys: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let text = serde_json::to_string_pretty(keys).map_err(|e| e.to_string())?;
    let legacy_tmp = path.with_extension("tmp");
    match fs::remove_file(&legacy_tmp) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("清理旧密钥临时文件失败：{e}")),
    }
    crate::storage::atomic_write(path, text.as_bytes(), true)
}

fn restrict_file_mode(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
}

/// 原子写入：先写临时文件再 rename，避免中途崩溃留下半截 JSON（借鉴 CC Switch）。
/// 父目录不存在时先建（MCP 分发会写到尚未初始化的 agent 配置目录，如 ~/.cursor、
/// ~/.config/opencode；缺了这步报的是「系统找不到指定的路径」，还会把用户没见过的
/// .tmp 名字吐到界面上）。任何失败路径都清掉残留 tmp，不在用户项目树里留垃圾。
pub(crate) fn atomic_write(path: &std::path::Path, text: &str) -> Result<(), String> {
    atomic_write_bytes(path, text.as_bytes())
}

/// 二进制原子写（会话导入的 jsonl/zst）：唯一同目录临时名，保留原文件权限，失败不删除原件。
pub(crate) fn atomic_write_bytes(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    crate::storage::atomic_write(path, bytes, false)
}

/// profiles.json / keys.json 的读-改-写序列化锁：多标签页并发保存时防互相覆盖
/// （原子写只保证单文件不碎，不保证 A读-B读-A写-B写 的丢失更新）
static STORE_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) struct StoreGuard {
    _file: fs::File,
    _process: std::sync::MutexGuard<'static, ()>,
}

pub(crate) fn store_lock() -> Result<StoreGuard, String> {
    let process = STORE_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let file = crate::storage::config_lock("profiles")?;
    Ok(StoreGuard {
        _process: process,
        _file: file,
    })
}

// ===== 共享密钥（keys.json 里的非 profile 条目）=====
// 反馈邮箱授权码（feedback-smtp）等非网关密钥也存同一份 keys.json，
// 写入必须与 profile 密钥共持同一把锁（进程互斥 + OS 文件锁），不许无锁并发写。

/// 写一个共享密钥（存在则覆盖）。持 store_lock。
pub(crate) fn set_shared_key(id: &str, secret: &str) -> Result<(), String> {
    let _g = store_lock()?;
    let path = keys_path()?;
    let mut keys = read_keys_at(&path)?;
    keys.insert(id.to_string(), secret.to_string());
    write_keys_at(&path, &keys)
}

/// 读一个共享密钥（只读不加锁，与既有注入期读取同口径）
pub(crate) fn get_shared_key(id: &str) -> Result<Option<String>, String> {
    let path = keys_path()?;
    Ok(read_keys_at(&path)?
        .into_iter()
        .find(|(k, _)| k == id)
        .map(|(_, v)| v))
}

/// 清除一个共享密钥（不存在则静默成功）。持 store_lock。
pub(crate) fn clear_shared_key(id: &str) -> Result<(), String> {
    let _g = store_lock()?;
    let path = keys_path()?;
    let mut keys = read_keys_at(&path)?;
    if keys.remove(id).is_some() {
        write_keys_at(&path, &keys)?;
    }
    Ok(())
}

fn commit_gateway_binding_files(
    old_gateways: &[Gateway],
    old_bindings: &[Binding],
    gateways: &[Gateway],
    bindings: &[Binding],
) -> Result<(), String> {
    crate::gateway_store::save_gateways(gateways)?;
    if let Err(error) = crate::gateway_store::save_bindings(bindings) {
        if let Err(rollback) = crate::gateway_store::save_gateways(old_gateways) {
            return Err(format!(
                "绑定写入失败（{error}），网关回退也失败（{rollback}）。请检查配置目录后重试。"
            ));
        }
        let _ = crate::gateway_store::save_bindings(old_bindings);
        return Err(format!("绑定写入失败，已回退网关清单：{error}"));
    }
    Ok(())
}

fn key_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| format!("钥匙串不可用: {e}"))
}

/// 写入密钥；调用方须已持 store_lock（create/update/duplicate 均持锁调用，本函数不再重复加锁）
fn set_key(id: &str, key: &str) -> Result<(), String> {
    let path = keys_path()?;
    let mut keys = read_keys_at(&path)?;
    keys.insert(id.to_string(), key.to_string());
    write_keys_at(&path, &keys)
}

/// get_key 的锁内版本：调用方须已持 store_lock
fn get_key_locked(id: &str) -> Result<Option<String>, String> {
    let path = keys_path()?;
    let keys = read_keys_at(&path)?;
    if let Some(k) = keys.get(id) {
        return Ok(Some(k.clone()));
    }
    // 一次性迁移：旧版本写入钥匙串的条目读回文件（回写在锁内进行，防并发丢更新）
    let Some(key) = key_entry(id).ok().and_then(|e| e.get_password().ok()) else {
        return Ok(None);
    };
    let mut keys = keys;
    keys.insert(id.to_string(), key.clone());
    let _ = write_keys_at(&path, &keys);
    Ok(Some(key))
}

/// 读取密钥；keys.json 损坏时返回错误而非谎报「无密钥」
pub fn get_key(id: &str) -> Result<Option<String>, String> {
    let _g = store_lock()?;
    get_key_locked(id)
}

/// 启动/写入用：官方账号无密钥；API 从网关 id 取（迁移后 keys.json 键是网关 id）。
pub fn get_key_for_profile(profile: &Profile) -> Result<Option<String>, String> {
    if profile.account_type == AccountType::Official {
        return Ok(None);
    }
    if let Some(gid) = &profile.gateway_id {
        return get_key(gid);
    }
    get_key(&profile.id)
}

/// 仅供后端展示脱敏使用；调用方不得把返回值序列化给前端或写入日志。
/// 阈值 ≥8 的取舍：更短的「密钥」与普通单词/标识符碰撞率高，全文替换脱敏会误伤会话正文；
/// 漏遮极短密钥的风险低于破坏全部回放文本，故不收录（如确需覆盖短密钥，降到 6 是下限）。
/// 展示脱敏只读文件；解析失败沿用上次成功快照，写入路径另行报错，不在展示路径改名密钥文件。
pub(crate) fn stored_secrets() -> Vec<String> {
    static LAST_GOOD: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> =
        std::sync::OnceLock::new();
    let cache = LAST_GOOD.get_or_init(Default::default);
    let loaded = keys_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| {
            serde_json::from_str::<std::collections::HashMap<String, String>>(&text).ok()
        });
    let mut last = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(keys) = loaded {
        *last = keys
            .into_values()
            .filter(|v| v.chars().count() >= 8)
            .collect();
    }
    let mut out = last.clone();
    out.extend(crate::mcp::stored_mcp_secrets());
    out
}

/// has_key 的锁内版本：调用方须已持 store_lock
fn has_key_locked(id: &str) -> Result<bool, String> {
    Ok(get_key_locked(id)?.is_some())
}

/// 删除密钥；调用方须已持 store_lock。文件读写失败必须上报，不能假装已清除。
fn delete_key(id: &str) -> Result<(), String> {
    let path = keys_path()?;
    let mut keys = read_keys_at(&path)?;
    if keys.remove(id).is_some() {
        write_keys_at(&path, &keys)?;
    }
    if let Ok(entry) = key_entry(id) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

/// 删网关时推理密钥与系统访问令牌一次写回，避免只清了一半。
fn delete_gateway_secrets(id: &str) -> Result<(), String> {
    let path = keys_path()?;
    let mut keys = read_keys_at(&path)?;
    let wallet = wallet_key_id(id);
    let changed = keys.remove(id).is_some() | keys.remove(&wallet).is_some();
    if changed {
        write_keys_at(&path, &keys)?;
    }
    if let Ok(entry) = key_entry(id) {
        let _ = entry.delete_credential();
    }
    if let Ok(entry) = key_entry(&wallet) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

#[tauri::command]
pub fn list_profiles(store: tauri::State<'_, ProfileStore>) -> Result<Vec<Profile>, String> {
    store.list()
}

#[tauri::command]
pub fn create_profile(
    store: tauri::State<'_, ProfileStore>,
    input: ProfileInput,
) -> Result<Profile, String> {
    store.create(input)
}

#[tauri::command]
pub fn update_profile(
    store: tauri::State<'_, ProfileStore>,
    id: String,
    input: ProfileInput,
) -> Result<Profile, String> {
    store.update(&id, input)
}

/// 删连接前的引用清点（W2b）：点名「还有谁在用」。只做计数提示，不做拦截——
/// 删除本身的级联清理在 delete() 里（项目默认/槽位/tasks 表），schedules 走
/// fail-loud 铁律保留死引用。前端确认弹层据此把「删了会怎样」说在事前。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUsageRefsDto {
    /// 项目数：名册默认连接或任意专属槽位引用它
    pub projects: usize,
    /// 目标数：tasks 表显式钉住它（删除后回落项目默认）
    pub goals: usize,
}

#[tauri::command]
pub async fn profile_usage_refs(id: String) -> Result<ProfileUsageRefsDto, String> {
    tauri::async_runtime::spawn_blocking(move || profile_usage_refs_sync(id))
        .await
        .map_err(|e| e.to_string())?
}
fn profile_usage_refs_sync(id: String) -> Result<ProfileUsageRefsDto, String> {
    let conn = crate::sessions::open_db()?;
    // projects：default_profiles / default_models 不含 id（那是 agent→id 的 map，值才
    // 是连接 id）；default_profiles JSON 值命中或 task_bindings 任意槽引用都算
    let mut projects = 0usize;
    {
        let mut stmt = conn
            .prepare("SELECT default_profiles, task_bindings FROM projects")
            .map_err(|e| format!("读取项目表失败: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0).unwrap_or_default(),
                    r.get::<_, String>(1).unwrap_or_default(),
                ))
            })
            .map_err(|e| format!("读取项目表失败: {e}"))?;
        for (defaults_raw, bindings_raw) in rows.flatten() {
            let defaults: serde_json::Value =
                serde_json::from_str(&defaults_raw).unwrap_or(serde_json::Value::Null);
            let in_defaults = defaults
                .as_object()
                .map(|map| map.values().any(|v| v.as_str() == Some(id.as_str())))
                .unwrap_or(false);
            let in_bindings = bindings_raw.contains(&format!("\"{id}\""));
            if in_defaults || in_bindings {
                projects += 1;
            }
        }
    }
    // tasks：显式绑定引用（级联会清掉，回落项目默认）
    let goals = conn
        .query_row(
            "SELECT COUNT(*) FROM tasks WHERE profile_id=?1",
            rusqlite::params![id],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n as usize)
        .unwrap_or(0);
    Ok(ProfileUsageRefsDto { projects, goals })
}

#[tauri::command]
pub fn delete_profile(store: tauri::State<'_, ProfileStore>, id: String) -> Result<(), String> {
    store.delete(&id)
}

#[tauri::command]
pub fn clear_profile_key(store: tauri::State<'_, ProfileStore>, id: String) -> Result<(), String> {
    store.clear_key(&id)
}

#[tauri::command]
pub fn duplicate_profile(
    store: tauri::State<'_, ProfileStore>,
    id: String,
) -> Result<Profile, String> {
    store.duplicate(&id)
}

/// 复制配置到其他 agent（#14）：密钥在后端 0600 文件内直读直写，不经前端
#[tauri::command]
pub fn copy_profile_to_agent(
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
    target_agent: String,
) -> Result<Profile, String> {
    store.copy_to_agent(&profile_id, &target_agent)
}

/// 导出全部 profile 到指定路径；密钥本体与尾号一律不导出
#[tauri::command]
pub fn export_profiles(store: tauri::State<'_, ProfileStore>, path: String) -> Result<(), String> {
    let mut profiles = store.list()?;
    for p in &mut profiles {
        p.has_key = false;
        p.key_hint = None;
        p.extra_env.retain(|name, _| !sensitive_env_name(name));
    }
    let text = serde_json::to_string_pretty(&profiles).map_err(|e| e.to_string())?;
    atomic_write(std::path::Path::new(&path), &text)
}

/// 从指定路径导入 profile：id 冲突换发新 id；(agent, name, base_url) 完全相同的跳过；
/// 密钥不包含在文件里，导入后需逐个补填。返回新增数量。
#[tauri::command]
pub fn import_profiles(
    store: tauri::State<'_, ProfileStore>,
    path: String,
) -> Result<usize, String> {
    let text = fs::read_to_string(&path).map_err(|e| format!("读取导入文件失败: {e}"))?;
    let incoming: Vec<Profile> =
        serde_json::from_str(&text).map_err(|e| format!("导入文件格式不正确: {e}"))?;
    let existing = store.list()?;
    let mut added = 0;
    for p in incoming {
        let dup = existing
            .iter()
            .any(|q| q.agent == p.agent && q.name == p.name && q.base_url == p.base_url);
        if dup {
            continue;
        }
        store.create(ProfileInput {
            agent: p.agent,
            name: p.name,
            account_type: p.account_type,
            no_auth: p.no_auth && p.account_type == AccountType::Api,
            protocol: p.protocol,
            api_backend: p.api_backend,
            base_url: p.base_url,
            models: p.models,
            role_models: Default::default(),
            extra_env: p.extra_env,
            request_policy: p.request_policy,
            api_key: None,
            expected_gateway_revision: None,
        })?;
        added += 1;
    }
    Ok(added)
}

fn slot_fingerprint(slots: &ProtocolSlots) -> String {
    let pairs = [
        ("anthropic", slots.anthropic.as_deref()),
        ("openai", slots.openai.as_deref()),
        ("responses", slots.responses.as_deref()),
        ("gemini", slots.gemini.as_deref()),
        ("cursor", slots.cursor.as_deref()),
    ];
    let mut parts = Vec::new();
    for (name, url) in pairs {
        if let Some(u) = url.map(str::trim).filter(|s| !s.is_empty()) {
            parts.push(format!("{name}={}", u.trim_end_matches('/')));
        }
    }
    parts.join("|")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayExportV2 {
    name: String,
    no_auth: bool,
    slots: ProtocolSlots,
    header_env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "GatewayCompat::is_empty")]
    compat: GatewayCompat,
    models: Vec<GatewayModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wallet_access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wallet_user_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BindingExportV2 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    agent: String,
    gateway_ref: GatewayRefV2,
    protocol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_backend: Option<String>,
    models: Vec<String>,
    #[serde(default, skip_serializing_if = "RoleModels::is_empty")]
    role_models: RoleModels,
    extra_env: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayRefV2 {
    name: String,
    slot_fp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigExportV2 {
    version: u32,
    gateways: Vec<GatewayExportV2>,
    bindings: Vec<BindingExportV2>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportV2Result {
    pub added_gateways: usize,
    pub added_bindings: usize,
    pub skipped_slots: Vec<String>,
}

fn extra_env_for_export(
    env: &std::collections::HashMap<String, String>,
) -> std::collections::HashMap<String, String> {
    env.iter()
        .filter(|(name, _)| !sensitive_env_name(name))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn build_export_v2(
    gateways: &[Gateway],
    bindings: &[Binding],
    keys: &std::collections::HashMap<String, String>,
    include_keys: bool,
) -> Result<(ConfigExportV2, String), String> {
    let mut out_gws = Vec::new();
    for g in gateways {
        out_gws.push(GatewayExportV2 {
            name: g.name.clone(),
            no_auth: g.no_auth,
            slots: g.slots.clone(),
            header_env: g.header_env.clone(),
            compat: g.compat.clone(),
            models: g.models.clone(),
            api_key: None,
            wallet_access_token: None,
            wallet_user_id: g.wallet_user_id.clone(),
        });
    }
    let out_binds: Vec<BindingExportV2> = bindings
        .iter()
        .filter(|b| b.kind == BindingKind::Api)
        .filter_map(|b| {
            let gw = gateways
                .iter()
                .find(|g| Some(g.id.as_str()) == b.gateway_id.as_deref())?;
            Some(BindingExportV2 {
                name: (!b.name.trim().is_empty()).then(|| b.name.clone()),
                agent: b.agent.clone(),
                gateway_ref: GatewayRefV2 {
                    name: gw.name.clone(),
                    slot_fp: slot_fingerprint(&gw.slots),
                },
                protocol: b.protocol.clone(),
                api_backend: b.api_backend.clone(),
                models: b.models.clone(),
                role_models: b.role_models.clone(),
                extra_env: extra_env_for_export(&b.extra_env),
            })
        })
        .collect();
    let mut doc = ConfigExportV2 {
        version: 2,
        gateways: out_gws,
        bindings: out_binds,
    };
    let mut text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    text = crate::sessions::redact_sensitive_text(&text);
    if include_keys {
        doc = serde_json::from_str(&text).unwrap_or(doc);
        for (g, ge) in gateways.iter().zip(doc.gateways.iter_mut()) {
            ge.api_key = keys.get(&g.id).cloned();
            ge.wallet_access_token = keys.get(&wallet_key_id(&g.id)).cloned();
        }
        text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    }
    Ok((doc, text))
}

#[tauri::command]
pub fn export_gateways_v2(
    store: tauri::State<'_, ProfileStore>,
    path: String,
    include_keys: bool,
) -> Result<(), String> {
    let _g = store_lock()?;
    store.ensure_split_locked()?;
    let gateways = crate::gateway_store::load_gateways()?;
    let bindings = crate::gateway_store::load_bindings()?;
    let mut keys = std::collections::HashMap::new();
    if include_keys {
        for g in &gateways {
            if let Ok(Some(k)) = get_key_locked(&g.id) {
                keys.insert(g.id.clone(), k);
            }
        }
    }
    let (_, text) = build_export_v2(&gateways, &bindings, &keys, include_keys)?;
    let dest = std::path::Path::new(&path);
    atomic_write(dest, &text)?;
    if include_keys {
        restrict_file_mode(dest);
    }
    Ok(())
}

fn match_existing_gateway(
    gateways: &[Gateway],
    incoming: &GatewayExportV2,
    keys: &std::collections::HashMap<String, String>,
) -> Option<String> {
    let fp = slot_fingerprint(&incoming.slots);
    if let Some(k) = incoming.api_key.as_deref().filter(|s| !s.is_empty()) {
        let kfp = format!("{:x}", md5::compute(k.as_bytes()));
        if let Some(id) = gateways
            .iter()
            .find(|g| {
                keys.get(&g.id)
                    .map(|live| format!("{:x}", md5::compute(live.as_bytes())) == kfp)
                    .unwrap_or(false)
            })
            .map(|g| g.id.clone())
        {
            return Some(id);
        }
    }
    if !fp.is_empty() {
        return gateways
            .iter()
            .find(|g| slot_fingerprint(&g.slots) == fp)
            .map(|g| g.id.clone());
    }
    None
}

fn apply_import_v2(
    doc: ConfigExportV2,
    gateways: &mut Vec<Gateway>,
    bindings: &mut Vec<Binding>,
    keys: &mut std::collections::HashMap<String, String>,
) -> ImportV2Result {
    let mut skipped = Vec::new();
    let mut added_gws = 0;
    let mut added_binds = 0;
    let mut ref_to_id: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();

    for incoming in doc.gateways {
        let fp = slot_fingerprint(&incoming.slots);
        let existing = match_existing_gateway(gateways, &incoming, keys);
        let gid = if let Some(id) = existing {
            if let Some(idx) = gateways.iter().position(|g| g.id == id) {
                merge_incoming_slots(&mut gateways[idx], &incoming, &mut skipped);
                if let Some(k) = incoming.api_key.as_deref().filter(|s| !s.is_empty()) {
                    keys.insert(id.clone(), k.to_string());
                    gateways[idx].key_hint = Some(key_hint_of(k));
                }
                if let Some(k) = incoming
                    .wallet_access_token
                    .as_deref()
                    .filter(|s| !s.is_empty())
                {
                    keys.insert(wallet_key_id(&id), k.to_string());
                    gateways[idx].wallet_key_hint = Some(key_hint_of(k));
                }
                if incoming.wallet_user_id.is_some() {
                    gateways[idx].wallet_user_id = incoming
                        .wallet_user_id
                        .clone()
                        .filter(|s| !s.trim().is_empty());
                }
            }
            id
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            let mut gw = Gateway {
                id: id.clone(),
                name: incoming.name.clone(),
                no_auth: incoming.no_auth,
                key_hint: None,
                wallet_user_id: incoming.wallet_user_id.clone(),
                wallet_key_hint: None,
                slots: incoming.slots.clone(),
                header_env: incoming.header_env.clone(),
                compat: incoming.compat.clone(),
                models: incoming.models.clone(),
                catalog_fetched_at: None,
                catalog_from_slot: None,
                last_probe: Vec::new(),
                slot_probes: Vec::new(),
                revision: String::new(),
            };
            if let Some(k) = incoming.api_key.as_deref().filter(|s| !s.is_empty()) {
                keys.insert(id.clone(), k.to_string());
                gw.key_hint = Some(key_hint_of(k));
            }
            if let Some(k) = incoming
                .wallet_access_token
                .as_deref()
                .filter(|s| !s.is_empty())
            {
                keys.insert(wallet_key_id(&id), k.to_string());
                gw.wallet_key_hint = Some(key_hint_of(k));
            }
            gateways.push(gw);
            added_gws += 1;
            id
        };
        ref_to_id.insert((incoming.name, fp), gid);
    }

    for b in doc.bindings {
        let Some(gid) = ref_to_id
            .get(&(b.gateway_ref.name.clone(), b.gateway_ref.slot_fp.clone()))
            .cloned()
            .or_else(|| {
                gateways
                    .iter()
                    .find(|g| {
                        g.name == b.gateway_ref.name
                            && slot_fingerprint(&g.slots) == b.gateway_ref.slot_fp
                    })
                    .map(|g| g.id.clone())
            })
        else {
            skipped.push(format!("绑定 {} 找不到对应网关", b.agent));
            continue;
        };
        let incoming_models = normalize_models(b.models.clone());
        let binding = Binding {
            id: uuid::Uuid::new_v4().to_string(),
            name: b
                .name
                .clone()
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| b.gateway_ref.name.clone()),
            // grok 专用字段：导入对象非 grok 时丢弃
            api_backend: if b.agent == "grok" {
                b.api_backend.clone()
            } else {
                None
            },
            agent: b.agent.clone(),
            kind: BindingKind::Api,
            gateway_id: Some(gid.clone()),
            protocol: b.protocol.clone(),
            // 落盘用归一后的模型（原先只拿归一值查重、落盘却是脏列表）
            models: incoming_models,
            role_models: b.role_models.clone().normalized(),
            extra_env: b.extra_env.clone(),
            last_used_at: None,
        };
        if has_duplicate_binding(bindings, None, &binding) {
            skipped.push(format!(
                "{}「{}」已有相同模型选择，未合并名单",
                b.agent, binding.name
            ));
            continue;
        }
        // 导入同样不得绕过字段校验（agent 白名单 / 协议闭集 / api_backend / 附加环境变量名）：
        // 外来的脏绑定落盘后会变成前端看不见、只能手改文件的幽灵条目
        let Some(gw) = gateways.iter().find(|g| g.id == gid) else {
            skipped.push(format!("绑定 {} 找不到对应网关", b.agent));
            continue;
        };
        let profile = crate::gateway_store::materialize(&binding, Some(gw), None);
        if let Err(error) = crate::profile_validation::validate_profile_fields(&profile) {
            skipped.push(format!("{}「{}」未导入：{error}", b.agent, binding.name));
            continue;
        }
        bindings.push(binding);
        added_binds += 1;
    }
    ImportV2Result {
        added_gateways: added_gws,
        added_bindings: added_binds,
        skipped_slots: skipped,
    }
}

#[tauri::command]
pub fn import_gateways_v2(
    store: tauri::State<'_, ProfileStore>,
    path: String,
) -> Result<ImportV2Result, String> {
    let text = fs::read_to_string(&path).map_err(|e| format!("读取导入文件失败: {e}"))?;
    let doc: ConfigExportV2 =
        serde_json::from_str(&text).map_err(|e| format!("导入文件格式不正确: {e}"))?;
    if doc.version != 2 {
        return Err("不是 v2 网关导出".into());
    }
    let _g = store_lock()?;
    store.ensure_split_locked()?;
    let mut gateways = crate::gateway_store::load_gateways()?;
    let mut bindings = crate::gateway_store::load_bindings()?;
    let old_gateways = gateways.clone();
    let old_bindings = bindings.clone();
    let mut keys = std::collections::HashMap::new();
    for g in &gateways {
        if let Ok(Some(k)) = get_key_locked(&g.id) {
            keys.insert(g.id.clone(), k);
        }
    }
    let result = apply_import_v2(doc, &mut gateways, &mut bindings, &mut keys);
    commit_gateway_binding_files(&old_gateways, &old_bindings, &gateways, &bindings)?;
    for g in &gateways {
        if let Some(k) = keys.get(&g.id) {
            if let Err(error) = set_key(&g.id, k) {
                let _ = commit_gateway_binding_files(
                    &gateways,
                    &bindings,
                    &old_gateways,
                    &old_bindings,
                );
                return Err(error);
            }
        }
    }
    Ok(result)
}

fn merge_incoming_slots(gw: &mut Gateway, incoming: &GatewayExportV2, skipped: &mut Vec<String>) {
    merge_one_slot(
        "anthropic",
        incoming.slots.anthropic.as_deref(),
        &mut gw.slots.anthropic,
        &gw.name,
        skipped,
    );
    merge_one_slot(
        "openai",
        incoming.slots.openai.as_deref(),
        &mut gw.slots.openai,
        &gw.name,
        skipped,
    );
    merge_one_slot(
        "responses",
        incoming.slots.responses.as_deref(),
        &mut gw.slots.responses,
        &gw.name,
        skipped,
    );
    merge_one_slot(
        "gemini",
        incoming.slots.gemini.as_deref(),
        &mut gw.slots.gemini,
        &gw.name,
        skipped,
    );
    merge_one_slot(
        "cursor",
        incoming.slots.cursor.as_deref(),
        &mut gw.slots.cursor,
        &gw.name,
        skipped,
    );
    if gw.compat.is_empty() {
        gw.compat = incoming.compat.clone();
    }
    for m in &incoming.models {
        if !gw.models.iter().any(|x| x.id == m.id) {
            gw.models.push(m.clone());
        }
    }
    for (k, v) in &incoming.header_env {
        match gw.header_env.get(k) {
            None => {
                gw.header_env.insert(k.clone(), v.clone());
            }
            Some(existing) if existing == v => {}
            Some(_) => skipped.push(format!("{} 的 Header {k} 冲突，已跳过", gw.name)),
        }
    }
}

fn merge_one_slot(
    name: &str,
    incoming: Option<&str>,
    live: &mut Option<String>,
    gw_name: &str,
    skipped: &mut Vec<String>,
) {
    let Some(url) = incoming.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    match live.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => *live = Some(url.to_string()),
        Some(existing) if existing.trim_end_matches('/') == url.trim_end_matches('/') => {}
        Some(_) => skipped.push(format!("{gw_name} 的 {name} 槽冲突，已跳过")),
    }
}

#[tauri::command]
pub fn list_gateways(store: tauri::State<'_, ProfileStore>) -> Result<Vec<Gateway>, String> {
    store.list_gateways()
}

#[tauri::command]
pub fn merge_gateway_models(
    store: tauri::State<'_, ProfileStore>,
    gateway_id: String,
    slot: String,
    ids: Vec<String>,
) -> Result<Gateway, String> {
    store.merge_fetched_models(&gateway_id, &slot, ids)
}

#[tauri::command]
pub fn save_gateway(
    store: tauri::State<'_, ProfileStore>,
    id: Option<String>,
    input: GatewayInput,
) -> Result<Gateway, String> {
    store.save_gateway(id, input)
}

#[tauri::command]
pub fn delete_gateway(store: tauri::State<'_, ProfileStore>, id: String) -> Result<(), String> {
    store.delete_gateway(&id)
}

#[tauri::command]
pub fn bind_gateway(
    store: tauri::State<'_, ProfileStore>,
    input: BindingInput,
) -> Result<Profile, String> {
    store.bind_gateway(input)
}

#[tauri::command]
pub fn unbind_split_merge(store: tauri::State<'_, ProfileStore>) -> Result<usize, String> {
    let _g = store_lock()?;
    store.ensure_split_locked()?;
    let path = crate::gateway_store::merge_journal_path()?;
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("读取合并清单失败: {e}")),
    };
    let journal: crate::gateway_store::MergeJournal =
        serde_json::from_str(&text).map_err(|e| format!("合并清单损坏: {e}"))?;
    if journal.entries.is_empty() {
        return Ok(0);
    }
    let mut gateways = crate::gateway_store::load_gateways()?;
    let mut bindings = crate::gateway_store::load_bindings()?;
    let old_gateways = gateways.clone();
    let old_bindings = bindings.clone();
    let (restored, copies) =
        crate::gateway_store::restore_merged_bindings(&journal, &mut gateways, &mut bindings);
    let mut pending_keys = Vec::new();
    for (from, to) in copies {
        if let Ok(Some(k)) = get_key_locked(&from) {
            if let Some(g) = gateways.iter_mut().find(|g| g.id == to) {
                g.key_hint = Some(key_hint_of(&k));
            }
            pending_keys.push((to, k));
        }
    }
    commit_gateway_binding_files(&old_gateways, &old_bindings, &gateways, &bindings)?;
    for (to, k) in pending_keys {
        if let Err(error) = set_key(&to, &k) {
            let _ =
                commit_gateway_binding_files(&gateways, &bindings, &old_gateways, &old_bindings);
            return Err(error);
        }
    }
    let _ = fs::remove_file(&path);
    Ok(restored)
}

#[tauri::command]
pub fn clear_gateway_key(store: tauri::State<'_, ProfileStore>, id: String) -> Result<(), String> {
    store.clear_gateway_key(&id)
}

#[tauri::command]
pub fn clear_gateway_wallet_token(
    store: tauri::State<'_, ProfileStore>,
    id: String,
) -> Result<(), String> {
    store.clear_gateway_wallet_token(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_key_repair_preserves_binding_and_gateway_identity() {
        let binding: Binding = serde_json::from_value(serde_json::json!({"id":"old-binding", "agent":"codex", "kind":"api", "gatewayId":"new-gateway", "models":[], "extraEnv":{}})).unwrap();
        let mut gateway: Gateway = serde_json::from_value(serde_json::json!({
            "id": "new-gateway",
            "name": "gateway",
            "keyHint": key_hint_of("synthetic-key"),
        }))
        .unwrap();
        let mut keys = [("old-binding".into(), "synthetic-key".into())]
            .into_iter()
            .collect();
        assert!(repair_legacy_key_links(
            &[binding.clone()],
            &[gateway.clone()],
            &mut keys
        ));
        assert_eq!(
            keys.get("new-gateway").map(String::as_str),
            Some("synthetic-key")
        );
        keys.insert("new-gateway".into(), "newer-key".into());
        assert!(!repair_legacy_key_links(
            &[binding.clone()],
            &[gateway.clone()],
            &mut keys
        ));
        assert_eq!(
            keys.get("new-gateway").map(String::as_str),
            Some("newer-key")
        );
        keys.remove("new-gateway");
        gateway.key_hint = None;
        assert!(
            !repair_legacy_key_links(&[binding], &[gateway], &mut keys),
            "明确清除的密钥不能被恢复"
        );
    }

    #[test]
    fn legacy_key_repair_refuses_a_key_the_gateway_does_not_claim() {
        // 网关现在挂着别的密钥（用户在旧版换过端点/换过密钥）。残留的这把不该被认领，
        // 否则它会转正成当前网关的凭证，请求带着错密钥打到新端点。
        let binding: Binding = serde_json::from_value(serde_json::json!({"id":"old-binding", "agent":"codex", "kind":"api", "gatewayId":"new-gateway", "models":[], "extraEnv":{}})).unwrap();
        let gateway: Gateway = serde_json::from_value(serde_json::json!({
            "id": "new-gateway",
            "name": "gateway",
            "keyHint": key_hint_of("sk-currentAAA7"),
        }))
        .unwrap();
        let mut keys = [("old-binding".into(), "sk-supersededB2C9".into())]
            .into_iter()
            .collect();
        assert!(
            !repair_legacy_key_links(&[binding], &[gateway], &mut keys),
            "尾号对不上就不是同一把密钥"
        );
        assert!(keys.get("new-gateway").is_none());
    }

    #[test]
    fn legacy_key_repair_trusts_a_unique_hint_tail() {
        // 只有一个网关挂着这个尾号时，尾号就是可用的判据：一致即认领。
        // 这不是「认出了身份」，是「没有别的候选」。
        let binding: Binding = serde_json::from_value(serde_json::json!({"id":"old-binding", "agent":"codex", "kind":"api", "gatewayId":"new-gateway", "models":[], "extraEnv":{}})).unwrap();
        let gateway: Gateway = serde_json::from_value(serde_json::json!({
            "id": "new-gateway",
            "name": "gateway",
            "keyHint": key_hint_of("sk-aaaaaaaaBBBB"),
        }))
        .unwrap();
        let mut keys = [("old-binding".into(), "sk-zzzzzzzzBBBB".into())]
            .into_iter()
            .collect();
        assert!(
            repair_legacy_key_links(&[binding], &[gateway], &mut keys),
            "尾号一致且无其他候选网关时认领"
        );
        assert_eq!(
            keys.get("new-gateway").map(String::as_str),
            Some("sk-zzzzzzzzBBBB")
        );
    }

    #[test]
    fn legacy_key_repair_declines_when_the_hint_tail_is_ambiguous() {
        // 两个网关撞同一个尾号：这把密钥归谁无从判断，此时**不搬**。
        // 搬错的表现是请求带着 A 的密钥打到 B 的端点（持续 401，UI 却显示已配置）；
        // 不搬只是留一把孤立密钥——两害相权取其轻。端点身份本可区分二者，
        // 但拆分迁移没把旧 base_url 留在 binding 上，所以这里只能拒绝猜测。
        let binding: Binding = serde_json::from_value(serde_json::json!({"id":"old-binding", "agent":"codex", "kind":"api", "gatewayId":"new-gateway", "models":[], "extraEnv":{}})).unwrap();
        let hint = key_hint_of("sk-aaaaaaaaBBBB");
        let gateway: Gateway = serde_json::from_value(serde_json::json!({
            "id": "new-gateway",
            "name": "gateway",
            "keyHint": hint,
        }))
        .unwrap();
        let other: Gateway = serde_json::from_value(serde_json::json!({
            "id": "another-gateway",
            "name": "another",
            "keyHint": hint,
        }))
        .unwrap();
        let mut keys = [("old-binding".into(), "sk-zzzzzzzzBBBB".into())]
            .into_iter()
            .collect();
        assert!(
            !repair_legacy_key_links(&[binding], &[gateway, other], &mut keys),
            "尾号在多个网关间撞车时不认领"
        );
        assert!(keys.get("new-gateway").is_none());
        assert!(keys.get("another-gateway").is_none());
    }

    #[test]
    fn migration_recovers_every_interrupted_stage_with_stable_keys() {
        for fail_at in 1..=5 {
            let root =
                std::env::temp_dir().join(format!("ccode-migration-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let pending = root.join("gateway-split.pending.json");
            let result = crate::gateway_store::MigrationResult {
                gateways: Vec::new(),
                bindings: Vec::new(),
                keys: [("stable-id".to_string(), "synthetic-secret".to_string())]
                    .into_iter()
                    .collect(),
                journal: crate::gateway_store::MergeJournal::default(),
                rewrites: Vec::new(),
            };
            crate::storage::atomic_write(&pending, &serde_json::to_vec(&result).unwrap(), true)
                .unwrap();
            assert!(finish_split_at(
                &pending,
                &result,
                || Ok(()),
                |stage| if stage == fail_at {
                    Err("injected".into())
                } else {
                    Ok(())
                }
            )
            .is_err());
            assert!(pending.exists());
            let saved = serde_json::from_str(&fs::read_to_string(&pending).unwrap()).unwrap();
            finish_split_at(&pending, &saved, || Ok(()), |_| Ok(())).unwrap();
            assert!(!pending.exists());
            assert_eq!(
                read_keys_at(&root.join("keys.json"))
                    .unwrap()
                    .get("stable-id")
                    .map(String::as_str),
                Some("synthetic-secret")
            );
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn migration_keeps_pending_when_reference_update_fails() {
        let root =
            std::env::temp_dir().join(format!("ccode-migration-ref-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let pending = root.join("gateway-split.pending.json");
        fs::write(&pending, "pending").unwrap();
        let result = crate::gateway_store::MigrationResult {
            gateways: vec![],
            bindings: vec![],
            keys: Default::default(),
            journal: Default::default(),
            rewrites: vec![],
        };
        assert!(finish_split_at(
            &pending,
            &result,
            || Err("refs unavailable".into()),
            |_| Ok(())
        )
        .is_err());
        assert!(pending.exists());
        fs::remove_dir_all(root).unwrap();
    }

    // ===== atomic_write 的两条跨平台前置条件 =====

    #[test]
    fn atomic_write_creates_missing_parent_dirs() {
        // MCP 分发会写到尚未初始化的 agent 配置目录（本机 ~/.cursor 就不存在）；
        // 缺这步用户看到的是「系统找不到指定的路径」外加一个没见过的 .tmp 名字。
        let dir = std::env::temp_dir().join(format!("ccode-aw-{}", uuid::Uuid::new_v4()));
        let path = dir.join("nested").join("deep").join("cfg.json");
        atomic_write(&path, "{}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn atomic_write_replaces_readonly_target_and_leaves_no_tmp() {
        // Windows 的 MoveFileExW 对只读目标返回 ERROR_ACCESS_DENIED，
        // 而 POSIX rename(2) 只看父目录权限 —— 这条在 macOS 上本来就过。
        let dir = std::env::temp_dir().join(format!("ccode-aw-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");
        atomic_write(&path, "v1").unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&path, perms).unwrap();

        atomic_write(&path, "v2").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "v2");
        assert!(!dir.join("note.tmp").exists(), "成功路径不得留下 .tmp");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn keys_file_roundtrip_with_0600_perms() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keys.json");
        let mut keys = std::collections::HashMap::new();
        keys.insert("p1".to_string(), "sk-secret".to_string());
        write_keys_at(&path, &keys).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let loaded = read_keys_at(&path).unwrap();
        assert_eq!(loaded.get("p1").map(|s| s.as_str()), Some("sk-secret"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_keys_file_reads_as_empty() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("keys.json");
        let loaded = read_keys_at(&path).unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn corrupt_keys_file_is_backed_up_and_errors() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keys.json");
        std::fs::write(&path, "{ 不是合法 json").unwrap();

        let err = read_keys_at(&path).unwrap_err();
        assert!(err.contains("已损坏"), "报错须说明损坏: {err}");
        assert!(path.exists(), "原损坏文件必须保留，防下一次误当空表覆盖");
        let backups: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("keys.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1, "应生成唯一 corrupt 备份: {backups:?}");
        // 损坏内容完整保留在备份里，可被人工恢复
        let kept = std::fs::read_to_string(dir.join(&backups[0])).unwrap();
        assert_eq!(kept, "{ 不是合法 json");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_keys_cleans_stale_tmp_before_rename() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keys.json");
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, "崩溃残留").unwrap();

        let mut keys = std::collections::HashMap::new();
        keys.insert("p1".to_string(), "sk-secret".to_string());
        write_keys_at(&path, &keys).unwrap();

        assert!(!tmp.exists(), "写入后不得残留 keys.tmp");
        let loaded = read_keys_at(&path).unwrap();
        assert_eq!(loaded.get("p1").map(|s| s.as_str()), Some("sk-secret"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "rename 后即 0600，无 0644 暴露窗口");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wallet_key_id_does_not_collide_with_gateway_uuid() {
        let id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        assert_eq!(wallet_key_id(id), format!("{id}#wallet"));
        assert_ne!(wallet_key_id(id), id);
    }

    #[test]
    fn key_hint_masks_short_keys() {
        assert_eq!(key_hint_of("sk-1234567"), "···4567");
        assert_eq!(key_hint_of("abc"), "····");
    }

    #[test]
    fn copy_name_dedups_within_target_agent() {
        assert_eq!(copy_name(&[], "中转 A"), "中转 A");
        assert_eq!(copy_name(&["中转 A"], "中转 A"), "中转 A-2");
        assert_eq!(copy_name(&["中转 A", "中转 A-2"], "中转 A"), "中转 A-3");
    }

    #[test]
    fn pick_copy_protocol_matches_api_kind() {
        let src = |agent: &str, protocol: Option<&str>| Profile {
            id: "x".into(),
            agent: agent.into(),
            name: "n".into(),
            account_type: AccountType::Api,
            no_auth: false,
            protocol: protocol.map(str::to_string),
            api_backend: None,
            base_url: None,
            models: vec![],
            role_models: Default::default(),
            extra_env: Default::default(),
            request_policy: RequestPolicy::default(),
            key_hint: None,
            model: None,
            last_used_at: None,
            has_key: false,
            gateway_id: None,
            slot_missing: false,
            connection_status: String::new(),
            model_sync_status: String::new(),
            model_sync_note: None,
            provider_override: None,
        };
        // 同族可行：anthropic → qwen 取 anthropic；openai 源保留源协议取值
        assert_eq!(
            pick_copy_protocol(&src("claude-code", None), "qwen").unwrap(),
            Some("anthropic".to_string())
        );
        assert_eq!(
            pick_copy_protocol(&src("kimi", Some("openai")), "qwen").unwrap(),
            Some("openai".to_string())
        );
        // 无协议概念的同族目标：协议清为 None（codebuddy 是 openai 族，2026-10-21 更正）
        assert_eq!(
            pick_copy_protocol(&src("qwen", Some("openai")), "codebuddy").unwrap(),
            None
        );
        assert!(pick_copy_protocol(&src("qwen", Some("anthropic")), "codebuddy").is_err());
        // grok 归 openai 族（xAI 官方 API 是 OpenAI chat_completions 兼容），无协议概念目标协议清 None
        assert_eq!(
            pick_copy_protocol(&src("codex", None), "grok").unwrap(),
            None
        );
        assert!(
            pick_copy_protocol(&src("claude-code", None), "grok").is_err(),
            "anthropic → grok 不同族应拒绝"
        );
        // 不同族拒绝：anthropic → codex/gemini；cursor 专有协议与谁都不互通
        assert!(pick_copy_protocol(&src("claude-code", None), "codex").is_err());
        assert!(pick_copy_protocol(&src("codex", None), "gemini").is_err());
        assert!(pick_copy_protocol(&src("codex", None), "cursor").is_err());
        assert!(pick_copy_protocol(&src("cursor", None), "codex").is_err());
        // 未知目标报错
        assert!(pick_copy_protocol(&src("codex", None), "not-an-agent").is_err());
    }

    #[test]
    fn profile_without_account_type_defaults_to_api() {
        // 旧 profiles.json 无 accountType 字段 → api（向后兼容）
        let old = r#"{"id":"1","agent":"codex","name":"n","protocol":null,"baseUrl":null,"models":[],"extraEnv":{},"hasKey":false}"#;
        let p: Profile = serde_json::from_str(old).unwrap();
        assert_eq!(p.account_type, AccountType::Api);
        // 显式 official 往返
        let new = r#"{"id":"1","agent":"codex","name":"n","accountType":"official","protocol":null,"baseUrl":null,"models":[],"extraEnv":{},"hasKey":false}"#;
        let p: Profile = serde_json::from_str(new).unwrap();
        assert_eq!(p.account_type, AccountType::Official);
        let text = serde_json::to_string(&p).unwrap();
        assert!(text.contains("\"accountType\":\"official\""));
        // api 序列化为 "api"（导出/导入兼容）
        let p = Profile {
            account_type: AccountType::Api,
            ..p
        };
        assert!(serde_json::to_string(&p)
            .unwrap()
            .contains("\"accountType\":\"api\""));
    }

    #[test]
    fn profile_without_request_policy_defaults_to_empty_policy() {
        let old = r#"{"id":"1","agent":"codex","name":"n","accountType":"api","protocol":null,"baseUrl":null,"models":[],"extraEnv":{},"hasKey":false}"#;
        let p: Profile = serde_json::from_str(old).unwrap();
        assert_eq!(p.request_policy, RequestPolicy::default());

        let mut p = p;
        p.request_policy
            .header_env
            .insert("X-Relay-Key".into(), "RELAY_KEY".into());
        let text = serde_json::to_string(&p).unwrap();
        assert!(text.contains("requestPolicy"));
        assert!(text.contains("RELAY_KEY"));
        assert!(!text.contains("sk-secret"));
    }

    #[test]
    fn apply_session_provider_uses_rollout_name() {
        let gid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let mut p = Profile {
            id: "b".into(),
            agent: "codex".into(),
            name: "n".into(),
            account_type: AccountType::Api,
            no_auth: false,
            protocol: None,
            api_backend: None,
            base_url: Some("https://example.com".into()),
            models: vec![],
            role_models: Default::default(),
            extra_env: Default::default(),
            request_policy: RequestPolicy::default(),
            key_hint: None,
            model: None,
            last_used_at: None,
            has_key: true,
            gateway_id: Some(gid.into()),
            slot_missing: false,
            connection_status: String::new(),
            model_sync_status: String::new(),
            model_sync_note: None,
            provider_override: None,
        };
        assert_eq!(p.provider_name(), crate::provider_id::provider_id(gid));
        p.apply_session_provider(Some("ccode"));
        assert_eq!(p.provider_name(), crate::provider_id::LEGACY);
        p.apply_session_provider(Some("ccode-a1b2c3d4"));
        assert_eq!(p.provider_name(), "ccode-a1b2c3d4");
        p.apply_session_provider(None);
        assert_eq!(p.provider_name(), crate::provider_id::provider_id(gid));
        p.apply_session_provider(Some("openai"));
        assert_eq!(p.provider_name(), crate::provider_id::provider_id(gid));
    }

    #[test]
    fn backup_split_sidecars_copies_both_files() {
        let dir = std::env::temp_dir().join(format!("ccode-bak-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let profiles = dir.join("profiles.json");
        let keys = dir.join("keys.json");
        std::fs::write(&profiles, "{\"a\":1}").unwrap();
        std::fs::write(&keys, "{\"k\":\"v\"}").unwrap();
        backup_split_sidecars(&profiles, &keys).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("profiles.json.bak-gateway-split")).unwrap(),
            "{\"a\":1}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("keys.json.bak-gateway-split")).unwrap(),
            "{\"k\":\"v\"}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    fn sample_gw(id: &str, name: &str, url: &str) -> Gateway {
        Gateway {
            id: id.into(),
            name: name.into(),
            no_auth: false,
            key_hint: None,
            wallet_user_id: None,
            wallet_key_hint: None,
            slots: ProtocolSlots {
                anthropic: Some(url.into()),
                ..Default::default()
            },
            header_env: Default::default(),
            models: vec![],
            catalog_fetched_at: None,
            catalog_from_slot: None,
            last_probe: vec![],
            slot_probes: vec![],
            revision: String::new(),
            compat: Default::default(),
        }
    }

    fn sample_bind(agent: &str, gid: &str, models: &[&str]) -> Binding {
        Binding {
            id: uuid::Uuid::new_v4().to_string(),
            agent: agent.into(),
            name: "sample".into(),
            kind: BindingKind::Api,
            gateway_id: Some(gid.into()),
            protocol: None,
            api_backend: None,
            models: models.iter().map(|s| (*s).to_string()).collect(),
            role_models: Default::default(),
            extra_env: Default::default(),
            last_used_at: None,
        }
    }

    #[test]
    fn same_gateway_allows_different_model_selection_but_rejects_exact_duplicate() {
        let existing = sample_bind("claude-code", "g1", &["model-a"]);
        let env = std::collections::HashMap::new();
        let model_b = vec!["model-b".to_string()];
        let model_a = vec!["model-a".to_string()];
        assert!(!same_binding_selection(
            &existing,
            "claude-code",
            "g1",
            None,
            None,
            &model_b,
            &env,
        ));
        assert!(same_binding_selection(
            &existing,
            "claude-code",
            "g1",
            None,
            None,
            &model_a,
            &env,
        ));
    }

    #[test]
    fn duplicate_binding_check_excludes_self_but_covers_edit_path() {
        let a = sample_bind("claude-code", "g1", &["model-a"]);
        let other = sample_bind("claude-code", "g1", &["model-b"]);
        let all = vec![a.clone(), other];
        // 编辑自己但模型选择没变：排除自身，不得拦
        assert!(!has_duplicate_binding(&all, Some(a.id.as_str()), &a));
        // 编辑成与另一条完全相同：必须拦（原先 update 不查这条）
        let mut me = a.clone();
        me.models = vec!["model-b".into()];
        assert!(
            has_duplicate_binding(&all, Some(a.id.as_str()), &me),
            "编辑路径同样受 §2 唯一约束"
        );
        // 新建路径：与既有完全相同 → 拦；不同 → 放行
        let same = sample_bind("claude-code", "g1", &["model-a"]);
        assert!(has_duplicate_binding(&all, None, &same));
        let different = sample_bind("claude-code", "g1", &["model-c"]);
        assert!(!has_duplicate_binding(&all, None, &different));
        // 归一后比较：空白/空串/重复不影响判定
        let dirty = sample_bind("claude-code", "g1", &[" model-a ", "", "model-a"]);
        assert!(has_duplicate_binding(&all, None, &dirty));
        // 官方绑定（无网关）不参与这套判定
        let mut official = sample_bind("claude-code", "g1", &["model-a"]);
        official.gateway_id = None;
        assert!(!has_duplicate_binding(&all, None, &official));
    }

    #[test]
    fn legacy_duplicate_pair_stays_editable_until_selection_moves() {
        // 约束补上之前由编辑路径造出的历史重复对（两条一模一样的绑定）
        let a = sample_bind("claude-code", "g1", &["model-a"]);
        let b = sample_bind("claude-code", "g1", &["model-a"]);
        let c = sample_bind("claude-code", "g1", &["model-b"]);
        let mut pair = vec![a.clone(), b, c];
        let original = pair[0].clone();
        // 只改名字（选择没动）：放行，否则那条连接连改名都存不了
        pair[0].name = "工作用".into();
        assert!(!update_selection_conflicts(&pair, 0, &original));
        // 选择真的动了且撞上第三条：拦
        pair[0].models = vec!["model-b".into()];
        assert!(update_selection_conflicts(&pair, 0, &original));
        // 单独一条（无重复）：怎么改都放行
        let solo = sample_bind("claude-code", "g1", &["model-a"]);
        let mut alone = vec![solo.clone()];
        alone[0].models = vec!["model-z".into()];
        assert!(!update_selection_conflicts(&alone, 0, &solo));
    }

    #[test]
    fn import_v2_validates_binding_fields_and_normalizes_models() {
        let gw = sample_gw("g1", "中转 A", "https://api.example.com");
        let fp = slot_fingerprint(&gw.slots);
        let mut gateways = vec![gw.clone()];
        let mut bindings: Vec<Binding> = Vec::new();
        let mut keys = std::collections::HashMap::new();
        let mk = |agent: &str, protocol: Option<&str>, models: &[&str], env: &[(&str, &str)]| {
            BindingExportV2 {
                name: Some(format!("{agent} 绑定")),
                agent: agent.into(),
                gateway_ref: GatewayRefV2 {
                    name: "中转 A".into(),
                    slot_fp: fp.clone(),
                },
                protocol: protocol.map(str::to_string),
                api_backend: None,
                models: models.iter().map(|s| (*s).to_string()).collect(),
                role_models: Default::default(),
                extra_env: env
                    .iter()
                    .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                    .collect(),
            }
        };
        let doc = ConfigExportV2 {
            version: 2,
            gateways: vec![],
            bindings: vec![
                // 未知 agent：白名单外不得落盘
                mk("not-a-real-agent", None, &["m1"], &[]),
                // 协议不在闭集（qwen 有 openai/anthropic 两槽，claude-code 是空表=无协议概念）
                mk("qwen", Some("nope"), &["m1"], &[]),
                // 附加环境变量名非法
                mk("claude-code", None, &["m1"], &[("BAD=NAME", "x")]),
                // 合法但模型列表脏：落盘必须是归一后的
                mk("claude-code", None, &[" m1 ", "", "m1"], &[]),
            ],
        };
        let res = apply_import_v2(doc, &mut gateways, &mut bindings, &mut keys);
        assert_eq!(res.added_bindings, 1, "{:?}", res.skipped_slots);
        assert_eq!(bindings.len(), 1);
        assert_eq!(
            bindings[0].models,
            vec!["m1".to_string()],
            "导入落盘必须是归一后的模型列表"
        );
        assert!(
            res.skipped_slots.iter().any(|s| s.contains("未知 agent")),
            "{:?}",
            res.skipped_slots
        );
        assert!(
            res.skipped_slots.iter().any(|s| s.contains("不支持协议")),
            "{:?}",
            res.skipped_slots
        );
        assert!(
            res.skipped_slots
                .iter()
                .any(|s| s.contains("环境变量名不合法")),
            "{:?}",
            res.skipped_slots
        );
    }

    #[test]
    fn extra_env_for_export_drops_key_token_names() {
        let mut env = std::collections::HashMap::new();
        env.insert("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into());
        env.insert("CUSTOM_API_KEY".into(), "sk-should-not-export".into());
        env.insert("AUTH_TOKEN".into(), "tok".into());
        // 内嵌整份带凭据配置的认证变量：不含 KEY/TOKEN 字面，靠闭集兜住（§18）
        env.insert(
            "OPENCODE_CONFIG_CONTENT".into(),
            r#"{"apiKey":"sk-inside-json"}"#.into(),
        );
        // 反向哨兵：非认证同名变量不得被误伤
        env.insert("OPENCODE_CONFIG".into(), "/tmp/opencode.json".into());
        let out = extra_env_for_export(&env);
        assert_eq!(
            out.get("HTTPS_PROXY").map(String::as_str),
            Some("http://127.0.0.1:7890")
        );
        assert!(!out.contains_key("CUSTOM_API_KEY"));
        assert!(!out.contains_key("AUTH_TOKEN"));
        assert!(
            !out.contains_key("OPENCODE_CONFIG_CONTENT"),
            "opencode 整份配置内嵌凭据，导出必须剔除"
        );
        assert_eq!(
            out.get("OPENCODE_CONFIG").map(String::as_str),
            Some("/tmp/opencode.json")
        );
    }

    #[test]
    fn auth_bearing_names_are_one_case_insensitive_list() {
        assert!(sensitive_env_name("OPENCODE_CONFIG_CONTENT"));
        assert!(auth_bearing_env_name("opencode_config_content"));
        assert!(auth_bearing_env_name("Anthropic_API_Key"));
        assert!(!auth_bearing_env_name("OPENCODE_CONFIG"));
        // 子串启发式只在导出剔除侧生效（闭集判定保持精确，避免误伤非认证变量）
        assert!(sensitive_env_name("MY_KEYSTONE_PATH"));
        assert!(!auth_bearing_env_name("MY_KEYSTONE_PATH"));
    }

    #[test]
    fn export_import_v2_roundtrip_and_unique_constraint() {
        let gw = sample_gw("g1", "中转 A", "https://api.example.com");
        let b = sample_bind("claude-code", "g1", &["m1"]);
        let mut keys = std::collections::HashMap::new();
        keys.insert("g1".into(), "sk-live-secret-abcdef".into());
        let (doc, text) = build_export_v2(&[gw.clone()], &[b.clone()], &keys, true).unwrap();
        assert!(text.contains("sk-live-secret-abcdef"));
        assert_eq!(
            doc.gateways[0].api_key.as_deref(),
            Some("sk-live-secret-abcdef")
        );

        let mut gateways = vec![gw.clone()];
        let mut bindings = vec![b.clone()];
        let mut live_keys = keys.clone();
        let incoming = ConfigExportV2 {
            version: 2,
            gateways: vec![GatewayExportV2 {
                compat: Default::default(),
                name: "中转 A".into(),
                no_auth: false,
                slots: gw.slots.clone(),
                header_env: {
                    let mut h = std::collections::BTreeMap::new();
                    h.insert("X-Trace".into(), "TRACE_ID".into());
                    h
                },
                models: vec![],
                api_key: Some("sk-live-secret-abcdef".into()),
                wallet_access_token: None,
                wallet_user_id: None,
            }],
            bindings: vec![BindingExportV2 {
                name: Some("另一个连接".into()),
                agent: "claude-code".into(),
                gateway_ref: GatewayRefV2 {
                    name: "中转 A".into(),
                    slot_fp: slot_fingerprint(&gw.slots),
                },
                protocol: Some("anthropic".into()),
                api_backend: None,
                models: vec!["m2".into()],
                role_models: Default::default(),
                extra_env: {
                    let mut e = std::collections::HashMap::new();
                    e.insert("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into());
                    e
                },
            }],
        };
        let res = apply_import_v2(incoming, &mut gateways, &mut bindings, &mut live_keys);
        assert_eq!(res.added_gateways, 0);
        assert_eq!(res.added_bindings, 1, "不同模型选择应保留为第二条绑定");
        assert_eq!(gateways.len(), 1);
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].models, vec!["m1".to_string()]);
        assert_eq!(bindings[1].models, vec!["m2".to_string()]);
        assert_eq!(bindings[1].name, "另一个连接");
        assert_eq!(bindings[1].protocol.as_deref(), Some("anthropic"));
        assert_eq!(
            bindings[1].extra_env.get("HTTPS_PROXY").map(String::as_str),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            gateways[0].header_env.get("X-Trace").map(String::as_str),
            Some("TRACE_ID")
        );
    }

    #[test]
    fn import_v2_rotated_key_falls_back_to_slot_fingerprint() {
        let gw = sample_gw("g1", "中转 A", "https://api.example.com");
        let mut gateways = vec![gw.clone()];
        let mut bindings = vec![];
        let mut keys = std::collections::HashMap::new();
        keys.insert("g1".into(), "sk-old-key-11111111".into());
        let incoming = ConfigExportV2 {
            version: 2,
            gateways: vec![GatewayExportV2 {
                compat: Default::default(),
                name: "中转 A".into(),
                no_auth: false,
                slots: gw.slots.clone(),
                header_env: Default::default(),
                models: vec![],
                api_key: Some("sk-new-key-22222222".into()),
                wallet_access_token: None,
                wallet_user_id: None,
            }],
            bindings: vec![],
        };
        let res = apply_import_v2(incoming, &mut gateways, &mut bindings, &mut keys);
        assert_eq!(res.added_gateways, 0, "换密钥的同一槽应并入已有网关");
        assert_eq!(gateways.len(), 1);
        assert_eq!(
            keys.get("g1").map(String::as_str),
            Some("sk-new-key-22222222")
        );
    }

    #[test]
    fn import_v2_slot_conflict_and_header_conflict_are_skipped_with_detail() {
        let mut gw = sample_gw("g1", "中转 A", "https://api.example.com");
        gw.header_env.insert("X-Trace".into(), "OLD".into());
        let mut gateways = vec![gw.clone()];
        let mut bindings = vec![];
        let mut keys = std::collections::HashMap::new();
        keys.insert("g1".into(), "sk-same".into());
        let mut slots = gw.slots.clone();
        slots.anthropic = Some("https://other.example.com".into());
        let incoming = ConfigExportV2 {
            version: 2,
            gateways: vec![GatewayExportV2 {
                compat: Default::default(),
                name: "中转 A".into(),
                no_auth: false,
                slots,
                header_env: {
                    let mut h = std::collections::BTreeMap::new();
                    h.insert("X-Trace".into(), "NEW".into());
                    h
                },
                models: vec![],
                api_key: Some("sk-same".into()),
                wallet_access_token: None,
                wallet_user_id: None,
            }],
            bindings: vec![],
        };
        let res = apply_import_v2(incoming, &mut gateways, &mut bindings, &mut keys);
        assert_eq!(res.added_gateways, 0);
        assert!(
            res.skipped_slots
                .iter()
                .any(|s| s.contains("anthropic") && s.contains("跳过")),
            "{:?}",
            res.skipped_slots
        );
        assert!(
            res.skipped_slots
                .iter()
                .any(|s| s.contains("Header X-Trace")),
            "{:?}",
            res.skipped_slots
        );
        assert_eq!(
            gateways[0].slots.anthropic.as_deref(),
            Some("https://api.example.com")
        );
        assert_eq!(
            gateways[0].header_env.get("X-Trace").map(String::as_str),
            Some("OLD")
        );
    }

    #[test]
    fn export_v2_redact_reload_keeps_keys_when_requested() {
        let gw = sample_gw("g1", "中转 A", "https://api.example.com");
        let mut keys = std::collections::HashMap::new();
        keys.insert("g1".into(), "sk-live-secret-abcdef".into());
        let (_, text) = build_export_v2(&[gw], &[], &keys, true).unwrap();
        let doc: ConfigExportV2 = serde_json::from_str(&text).unwrap();
        let mut gateways = vec![];
        let mut bindings = vec![];
        let mut live = std::collections::HashMap::new();
        let res = apply_import_v2(doc, &mut gateways, &mut bindings, &mut live);
        assert_eq!(res.added_gateways, 1);
        assert_eq!(
            live.values().next().map(String::as_str),
            Some("sk-live-secret-abcdef")
        );
    }

    #[cfg(unix)]
    #[test]
    fn export_with_keys_sets_0600() {
        let dir = std::env::temp_dir().join(format!("ccode-exp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.json");
        atomic_write(&path, "{\"k\":\"v\"}").unwrap();
        restrict_file_mode(&path);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== save_gateway / bind_gateway / delete_gateway 编排测试 =====

    fn make_store_in(dir: &std::path::Path) -> ProfileStore {
        ProfileStore::new_for_test(dir)
    }

    fn minimal_gateway_input(name: &str, url: &str) -> GatewayInput {
        GatewayInput {
            name: name.into(),
            no_auth: true,
            slots: crate::profiles::ProtocolSlots {
                anthropic: Some(url.into()),
                openai: Some(url.into()),
                responses: None,
                gemini: None,
                cursor: None,
            },
            header_env: Default::default(),
            compat: Default::default(),
            models: vec![],
            api_key: None,
            expected_revision: None,
            wallet_access_token: None,
            wallet_user_id: None,
            clear_key: false,
            catalog_fetched_at: None,
            catalog_from_slot: None,
        }
    }

    #[test]
    fn save_gateway_create_then_update_preserves_catalog_fields() {
        let dir = std::env::temp_dir().join(format!("ccode-gw-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = make_store_in(&dir);

        // 新建
        let input = minimal_gateway_input("test", "https://api.example.com");
        let gw = store.save_gateway(None, input).unwrap();
        assert_eq!(gw.name, "test");
        assert_eq!(gw.catalog_fetched_at, None);

        // 更新 — 带 catalog_fetched_at 回传
        let mut update = minimal_gateway_input("test-updated", "https://api.example.com");
        update.expected_revision = Some(gw.revision.clone());
        update.catalog_fetched_at = Some("2026-01-01T00:00:00Z".into());
        update.catalog_from_slot = Some("openai".into());
        let gw2 = store.save_gateway(Some(gw.id.clone()), update).unwrap();
        assert_eq!(gw2.name, "test-updated");
        assert_eq!(gw2.catalog_fetched_at.as_deref(), Some("2026-01-01T00:00:00Z"));
        assert_eq!(gw2.catalog_from_slot.as_deref(), Some("openai"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_gateway_model_merge_preserves_catalog_metadata() {
        let dir = std::env::temp_dir().join(format!("ccode-gw-merge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = make_store_in(&dir);

        // 新建带一个 fetched 模型
        let mut input = minimal_gateway_input("merge-test", "https://api.example.com");
        input.models = vec![GatewayModel {
            id: "model-a".into(),
            source: "fetched".into(),
            status: "available".into(),
            last_seen_at: Some("2026-01-01T00:00:00Z".into()),
            catalog_slot: Some("openai".into()),
            temperature: None,
            top_p: None,
            max_output_tokens: None,
            reasoning_effort: None,
        }];
        let gw = store.save_gateway(None, input).unwrap();

        // 更新 — 前端回传相同 id 但不带目录元数据，应保留后端 catalog_slot
        let mut update = minimal_gateway_input("merge-test", "https://api.example.com");
        update.expected_revision = Some(gw.revision.clone());
        update.models = vec![GatewayModel {
            id: "model-a".into(),
            source: "fetched".into(),
            status: "available".into(),
            last_seen_at: None,
            catalog_slot: None,
            temperature: Some(0.7),
            top_p: None,
            max_output_tokens: None,
            reasoning_effort: None,
        }];
        let gw2 = store.save_gateway(Some(gw.id.clone()), update).unwrap();
        let model = gw2.models.iter().find(|m| m.id == "model-a").unwrap();
        // catalog_slot 来自后端，不应被前端的 None 覆盖
        assert_eq!(model.catalog_slot.as_deref(), Some("openai"));
        // temperature 来自前端更新
        assert_eq!(model.temperature, Some(0.7));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_gateway_explicit_clear_key_flag() {
        let dir = std::env::temp_dir().join(format!("ccode-gw-ck-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = make_store_in(&dir);

        let gw = store.save_gateway(None, minimal_gateway_input("key-test", "https://api.example.com")).unwrap();

        // no_auth=true と clear_key=false → 不应清除密钥
        let mut update = minimal_gateway_input("key-test", "https://api.example.com");
        update.expected_revision = Some(gw.revision.clone());
        update.no_auth = true;
        update.clear_key = false;
        let gw2 = store.save_gateway(Some(gw.id.clone()), update).unwrap();
        // key_hint 初始为 None（没有密钥），保持 None — clear 没副作用
        assert_eq!(gw2.key_hint, None);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bind_gateway_returns_correct_connection_state() {
        let dir = std::env::temp_dir().join(format!("ccode-bind-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = make_store_in(&dir);

        let gw = store.save_gateway(None, minimal_gateway_input("bind-gw", "https://api.example.com")).unwrap();
        let binding_input = BindingInput {
            agent: "claude-code".into(),
            name: String::new(),
            gateway_id: Some(gw.id.clone()),
            kind: BindingKind::Api,
            protocol: None,
            api_backend: None,
            models: vec![],
            role_models: Default::default(),
            extra_env: Default::default(),
        };
        let profile = store.bind_gateway(binding_input).unwrap();
        // slot_missing=false (anthropic slot is set), no key needed (no_auth=true)
        // → connection_state should not be slot_missing or credential_missing
        assert_ne!(profile.connection_status, "slot_missing");
        assert_ne!(profile.connection_status, "credential_missing");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_gateway_removes_gateway_and_leaves_bindings_orphaned() {
        let dir = std::env::temp_dir().join(format!("ccode-del-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = make_store_in(&dir);

        let gw = store.save_gateway(None, minimal_gateway_input("del-gw", "https://api.example.com")).unwrap();
        store.delete_gateway(&gw.id).unwrap();

        let gateways = store.list_gateways().unwrap();
        assert!(gateways.iter().all(|g| g.id != gw.id));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `new_for_test` 必须把**整个配置根**挪走，不只是 `profiles.json`。
    ///
    /// 这是 2026-09-26 那次修复的回归闸：以前只重定向了 `profiles.json`，
    /// `save_gateway` 走 `gateway_store` 的自由函数照旧写真实配置目录，
    /// 于是每跑一轮 `cargo test` 就往用户的网关库里塞假网关（实测攒到 68 条）。
    /// 断言打在「写入落在临时目录内」上，而不是「真实目录没变」——
    /// 后者在别人的机器上会假绿。
    #[test]
    fn store_isolation_redirects_the_whole_config_root() {
        let dir = std::env::temp_dir().join(format!("ccode-isolation-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = make_store_in(&dir);

        // 网关落点：gateway_store 的自由函数必须也认这个临时根
        let gw = store
            .save_gateway(None, minimal_gateway_input("iso-gw", "https://api.example.com"))
            .unwrap();
        for name in ["gateways.json", "bindings.json"] {
            assert!(
                dir.join(name).exists(),
                "{name} 没有落在临时目录里——配置根没被重定向（gateway_store 会写真实配置目录）"
            );
        }
        let on_disk: Vec<crate::profiles::Gateway> =
            serde_json::from_str(&fs::read_to_string(dir.join("gateways.json")).unwrap()).unwrap();
        assert!(on_disk.iter().any(|g| g.id == gw.id), "网关没写进临时目录的 gateways.json");

        // 锁也要跟走：否则测试会和真实运行中的实例抢同一把锁
        let roots = crate::storage::config_root().unwrap();
        assert_eq!(roots, dir, "config_root 没指向临时目录");

        // 守卫 drop 后必须还原，否则隔离会漏给同线程的后续用例。
        // 还原目标 = 该线程此前的根（通常是真实配置目录），总之不再是临时目录。
        drop(store);
        let restored = crate::storage::config_root().unwrap();
        assert_ne!(
            restored, dir,
            "store 已 drop，配置根却没还原到「{}」",
            restored.display()
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
