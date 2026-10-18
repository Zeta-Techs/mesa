//! 客户端接力：把 Mesa 里的一条对话 / 一个项目交给该 agent 自己的 GUI 客户端接着做
//! （设计与分档见 docs/design-client-handoff.md）。
//!
//! 核心约束：**客户端那边的失败 Mesa 看不见**——`open_url` 只要系统里有处理程序就算成功，
//! 之后「Model provider not found」「请先登录」都是客户端自己弹的。所以一切判断都在发深链
//! **之前**做（`build_plan`，纯函数、可单测），发出去之后不再负责。
//!
//! 流程：`client_open_plan`（只读预检，返回 checks / 可选修复）→ 前端按需弹确认层 →
//! `client_open_launch`（重新预检 → 执行用户确认的修复 → 发深链）。launch 不信任前端传回的计划，
//! 每次现算，所以前端的状态过期不会造成越权写盘。

use crate::agent_specs::{self, AgentSpec, ChannelPolicy, ClientSpec};
use crate::profiles::{AccountType, ProfileStore};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ===== 对外 DTO =====

/// 要接力的对象：一条会话，或一个项目目录
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum OpenTarget {
    Session {
        agent: String,
        session_id: String,
        /// 会话原始记录文件（预检它还在不在）；未知为 None
        #[serde(default)]
        file_path: Option<String>,
        /// Codex rollout 记录的 model_provider
        #[serde(default)]
        provider: Option<String>,
        /// 启动这条会话时用的 Mesa 连接（已知才有）
        #[serde(default)]
        profile_id: Option<String>,
        /// 这条会话此刻正在 Mesa 终端里运行
        #[serde(default)]
        live_in_mesa: bool,
    },
    Project {
        path: String,
    },
}

/// 用户在确认层里选定的修复
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixChoice {
    pub kind: String,
    pub profile_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfoDto {
    pub client_id: String,
    pub agent: String,
    pub display: String,
    pub installed: bool,
    pub version: Option<String>,
    pub can_session: bool,
    pub can_project: bool,
    pub download_url: Option<String>,
    /// 不可用时给用户看的原因
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckDto {
    pub id: String,
    /// ok / note / warn / fix / block
    pub status: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CandidateDto {
    pub profile_id: String,
    pub name: String,
    pub key_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FixDto {
    /// 目前只有 codexRegister：把连接的 provider 定义块写进 ~/.codex/config.toml
    pub kind: String,
    /// 要写的定义块名（Codex 按对话记录的名字去找，必须原样）
    pub block_name: String,
    pub candidates: Vec<CandidateDto>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanDto {
    pub client_id: String,
    pub display: String,
    /// session = 精确打开这条对话；project = 只打开项目目录
    pub level: String,
    /// ready / needsFix / blocked
    pub verdict: String,
    pub checks: Vec<CheckDto>,
    pub fix: Option<FixDto>,
    pub download_url: Option<String>,
    #[serde(skip)]
    pub url: String,
}

// ===== 预检输入快照（纯函数的输入；探测在 gather_env） =====

#[derive(Debug, Clone, Default)]
pub(crate) struct ClientProbe {
    pub installed: bool,
    pub version: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ThreadState {
    Unknown,
    Missing,
    Present { archived: bool },
}

#[derive(Debug, Clone)]
pub(crate) struct ProfileLite {
    pub id: String,
    pub agent: String,
    pub name: String,
    pub official: bool,
    pub gateway_id: Option<String>,
    /// 能被「注册到 Codex 客户端」写出（API 连接、有端点、有已存密钥）
    pub registrable: bool,
    pub key_hint: Option<String>,
}

pub(crate) struct PlanEnv {
    pub probe: ClientProbe,
    pub dir_exists: bool,
    pub codex_providers: Vec<String>,
    pub codex_thread: ThreadState,
    pub session_file_exists: Option<bool>,
    pub profiles: Vec<ProfileLite>,
}

// ===== 深链拼接 =====

/// 除 RFC 3986 unreserved 外全部百分号编码（含 `/`、`:`、`\`），与前端 URLSearchParams 的
/// 取值结果一致，客户端用 searchParams.get 还原。空格编成 %20（不用 `+`）。
pub(crate) fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 会话 id 会拼进 URL，只放行 uuid 形态（字母数字与连字符），其余一律拒绝
pub(crate) fn valid_session_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// 写进 config.toml 当 TOML 键的 provider 名：只能是 Mesa 派生的 `ccode` / `ccode-<…>`
pub(crate) fn valid_block_name(name: &str) -> bool {
    crate::provider_id::is_ccode_provider(name)
        && name.len() <= 40
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn session_url(spec: &ClientSpec, session_id: &str) -> Option<String> {
    spec.session_url
        .map(|t| t.replace("{session}", &percent_encode(session_id)))
}

fn project_url(spec: &ClientSpec, path: &str) -> Option<String> {
    spec.project_url
        .map(|t| t.replace("{path}", &percent_encode(path)))
}

// ===== 预检（纯函数） =====

fn check(id: &str, status: &str, text: impl Into<String>) -> CheckDto {
    CheckDto {
        id: id.into(),
        status: status.into(),
        text: text.into(),
    }
}

fn verdict_of(checks: &[CheckDto]) -> &'static str {
    if checks.iter().any(|c| c.status == "block") {
        "blocked"
    } else if checks.iter().any(|c| c.status == "fix") {
        "needsFix"
    } else {
        "ready"
    }
}

/// Codex 会话 provider 的三类：空 / openai = ChatGPT 内置渠道，客户端天然认识；
/// ccode 系 = Mesa 启动时 -c 内联的渠道，客户端 config.toml 里没有定义；其余 = 客户端自己的渠道
enum CodexProviderKind {
    Builtin,
    Mesa,
    Disk,
}

fn codex_provider_kind(provider: Option<&str>) -> CodexProviderKind {
    match provider.map(str::trim).filter(|s| !s.is_empty()) {
        None => CodexProviderKind::Builtin,
        Some(p) if p == crate::provider_id::CODEX_CHATGPT => CodexProviderKind::Builtin,
        Some(p) if crate::provider_id::is_ccode_provider(p) => CodexProviderKind::Mesa,
        Some(_) => CodexProviderKind::Disk,
    }
}

/// 候选连接：先 profile_id 精确命中，再按网关短 id 对上 provider 名；
/// 旧版统一名 `ccode` 对不上任何网关，退而列出全部可注册连接由用户挑
fn codex_register_candidates(
    provider: &str,
    profile_id: Option<&str>,
    profiles: &[ProfileLite],
) -> Vec<CandidateDto> {
    let legacy = provider == crate::provider_id::LEGACY;
    let mut out: Vec<CandidateDto> = Vec::new();
    // 同一网关下的多个绑定写出的定义块完全一样（端点与密钥都挂在网关上），只留第一个
    let mut seen_gateways: Vec<String> = Vec::new();
    let mut push = |p: &ProfileLite| {
        if out.iter().any(|c| c.profile_id == p.id) {
            return;
        }
        if let Some(g) = &p.gateway_id {
            if seen_gateways.contains(g) {
                return;
            }
            seen_gateways.push(g.clone());
        }
        out.push(CandidateDto {
            profile_id: p.id.clone(),
            name: p.name.clone(),
            key_hint: p.key_hint.clone(),
        });
    };
    let usable = || {
        profiles
            .iter()
            .filter(|p| p.agent == "codex" && p.registrable)
    };
    if let Some(pid) = profile_id {
        for p in usable().filter(|p| p.id == pid) {
            push(p);
        }
    }
    for p in usable().filter(|p| {
        p.gateway_id
            .as_deref()
            .is_some_and(|g| crate::provider_id::gateway_matches_provider(g, provider))
    }) {
        push(p);
    }
    if legacy {
        for p in usable() {
            push(p);
        }
    }
    out
}

pub(crate) fn build_plan(
    agent: &str,
    spec: &ClientSpec,
    target: &OpenTarget,
    env: &PlanEnv,
) -> PlanDto {
    let mut checks: Vec<CheckDto> = Vec::new();
    let mut fix: Option<FixDto> = None;
    let mut url = String::new();
    let level;

    if !env.probe.installed {
        checks.push(check(
            "client_missing",
            "block",
            env.probe
                .reason
                .clone()
                .unwrap_or_else(|| format!("没有检测到 {}。", spec.display)),
        ));
    }

    match target {
        OpenTarget::Project { path } => {
            level = "project";
            if !env.dir_exists {
                checks.push(check("dir_missing", "block", format!("目录不存在或已移动：{path}")));
            }
            match project_url(spec, path) {
                Some(u) => url = u,
                None => checks.push(check(
                    "no_project_open",
                    "block",
                    format!("{}不支持按目录打开。", spec.display),
                )),
            }
        }
        OpenTarget::Session {
            session_id,
            file_path,
            provider,
            profile_id,
            live_in_mesa,
            ..
        } => {
            level = "session";
            if !valid_session_id(session_id) {
                checks.push(check("bad_session_id", "block", "会话编号格式不对，无法生成打开链接。"));
            } else if let Some(u) = session_url(spec, session_id) {
                url = u;
            } else {
                checks.push(check(
                    "no_session_open",
                    "block",
                    format!("{}不能按对话定位，只能打开项目目录。", spec.display),
                ));
            }
            if *live_in_mesa {
                checks.push(check(
                    "live_in_mesa",
                    "warn",
                    "这条对话此刻还在 Mesa 的终端里运行。两边同时写同一份记录会互相覆盖，建议先在终端里结束它再打开。",
                ));
            }
            match spec.channel {
                ChannelPolicy::RegisteredProvider => plan_codex_session(
                    session_id,
                    provider.as_deref(),
                    profile_id.as_deref(),
                    env,
                    &mut checks,
                    &mut fix,
                ),
                ChannelPolicy::OwnAccount => plan_own_account_session(
                    spec,
                    file_path.as_deref(),
                    profile_id.as_deref(),
                    env,
                    &mut checks,
                ),
            }
        }
    }
    let _ = agent;
    let verdict = verdict_of(&checks).to_string();
    PlanDto {
        client_id: spec.id.into(),
        display: spec.display.into(),
        level: level.into(),
        verdict,
        checks,
        fix,
        download_url: spec.download_url.map(str::to_string),
        url,
    }
}

fn plan_codex_session(
    session_id: &str,
    provider: Option<&str>,
    profile_id: Option<&str>,
    env: &PlanEnv,
    checks: &mut Vec<CheckDto>,
    fix: &mut Option<FixDto>,
) {
    match &env.codex_thread {
        ThreadState::Missing => checks.push(check(
            "thread_unknown",
            "warn",
            "Codex 客户端的对话表里没有找到这条对话，打开后可能是空白页或报错。",
        )),
        ThreadState::Present { archived: true } => checks.push(check(
            "thread_archived",
            "note",
            "这条对话在客户端里是归档状态。",
        )),
        ThreadState::Present { archived: false } | ThreadState::Unknown => {}
    }
    let _ = session_id;
    match codex_provider_kind(provider) {
        CodexProviderKind::Builtin => {}
        CodexProviderKind::Disk => {
            let name = provider.unwrap_or_default().trim();
            if env.codex_providers.iter().any(|p| p == name) {
                checks.push(check("provider_ok", "ok", format!("渠道「{name}」客户端已认识。")));
            } else {
                checks.push(check(
                    "provider_missing_disk",
                    "block",
                    format!(
                        "这条对话的渠道「{name}」在客户端的 config.toml 里没有定义，也不是 Mesa 创建的，Mesa 无法代写。可以用「继续」在 Mesa 里接着聊。"
                    ),
                ));
            }
        }
        CodexProviderKind::Mesa => {
            let name = provider.unwrap_or_default().trim();
            if env.codex_providers.iter().any(|p| p == name) {
                checks.push(check("provider_ok", "ok", "这条对话的渠道已写进客户端配置。"));
            } else if !valid_block_name(name) {
                checks.push(check("provider_bad_name", "block", "渠道名格式不对，无法写入客户端配置。"));
            } else {
                let candidates = codex_register_candidates(name, profile_id, &env.profiles);
                if candidates.is_empty() {
                    checks.push(check(
                        "provider_no_profile",
                        "block",
                        "找不到这条对话原来用的连接（可能已删除，或没有保存密钥），无法给客户端补渠道定义。可以用「继续」在 Mesa 里接着聊。",
                    ));
                } else {
                    checks.push(check(
                        "provider_unregistered",
                        "fix",
                        "Codex 客户端不认识这条对话的渠道，直接打开会报「Model provider not found」。需要把这个连接的端点和密钥写进 ~/.codex/config.toml（密钥明文，写前自动备份，可在连接页撤销）。",
                    ));
                    *fix = Some(FixDto {
                        kind: "codexRegister".into(),
                        block_name: name.to_string(),
                        candidates,
                    });
                }
            }
        }
    }
}

fn plan_own_account_session(
    spec: &ClientSpec,
    file_path: Option<&str>,
    profile_id: Option<&str>,
    env: &PlanEnv,
    checks: &mut Vec<CheckDto>,
) {
    match env.session_file_exists {
        Some(false) => checks.push(check(
            "transcript_missing",
            "block",
            format!("这条对话的原始记录文件已不在，{}无法导入。", spec.display),
        )),
        Some(true) | None => {
            let _ = file_path;
        }
    }
    if let Some(p) = profile_id.and_then(|pid| env.profiles.iter().find(|p| p.id == pid)) {
        if !p.official {
            checks.push(check(
                "channel_changes",
                "note",
                format!(
                    "这条对话是用 Mesa 的连接「{}」跑的。{}会用它自己的账号继续，不会走这个连接。",
                    p.name, spec.display
                ),
            ));
        }
    }
}

// ===== 探测 =====

#[cfg(target_os = "macos")]
fn read_info_plist(app: &Path) -> Option<(Vec<String>, Option<String>)> {
    let out = crate::process::background_command("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-"])
        .arg(app.join("Contents/Info.plist"))
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let schemes = v
        .get("CFBundleURLTypes")
        .and_then(|t| t.as_array())
        .map(|types| {
            types
                .iter()
                .filter_map(|t| t.get("CFBundleURLSchemes").and_then(|s| s.as_array()))
                .flatten()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let version = v
        .get("CFBundleShortVersionString")
        .and_then(|s| s.as_str())
        .map(str::to_string);
    Some((schemes, version))
}

#[cfg(target_os = "macos")]
fn probe_client_fresh(spec: &ClientSpec) -> ClientProbe {
    let mut apps: Vec<PathBuf> = Vec::new();
    let home = dirs::home_dir();
    for name in spec.mac_app_names {
        apps.push(PathBuf::from(format!("/Applications/{name}.app")));
        if let Some(h) = &home {
            apps.push(h.join("Applications").join(format!("{name}.app")));
        }
    }
    let try_app = |app: &Path| -> Option<ClientProbe> {
        let (schemes, version) = read_info_plist(app)?;
        schemes.iter().any(|s| s == spec.scheme).then(|| ClientProbe {
            installed: true,
            version,
            reason: None,
        })
    };
    for app in apps.iter().filter(|p| p.is_dir()) {
        if let Some(p) = try_app(app) {
            return p;
        }
    }
    // 装在非常规目录时靠 Spotlight 兜底；未装的常见情形也会走到这里，所以 list 侧带短缓存
    for id in spec.mac_bundle_ids {
        let Ok(out) = crate::process::background_command("/usr/bin/mdfind")
            .arg(format!("kMDItemCFBundleIdentifier == '{id}'"))
            .output()
        else {
            continue;
        };
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some(p) = try_app(Path::new(line.trim())) {
                return p;
            }
        }
    }
    ClientProbe {
        installed: false,
        version: None,
        reason: Some(format!("没有检测到 {}。", spec.display)),
    }
}

#[cfg(windows)]
fn probe_client_fresh(spec: &ClientSpec) -> ClientProbe {
    let key = format!("HKCR\\{}", spec.scheme);
    let ok = crate::process::background_command("reg")
        .args(["query", key.as_str(), "/v", "URL Protocol"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    ClientProbe {
        installed: ok,
        version: None,
        reason: (!ok).then(|| format!("没有检测到 {}。", spec.display)),
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn probe_client_fresh(spec: &ClientSpec) -> ClientProbe {
    ClientProbe {
        installed: false,
        version: None,
        reason: Some(format!("{}没有 Linux 版本。", spec.display)),
    }
}

/// 列表侧的探测带 30 秒缓存（未装时要走 Spotlight，页面反复可见不该每次都查）
fn probe_client_cached(spec: &ClientSpec) -> ClientProbe {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static CACHE: OnceLock<Mutex<HashMap<&'static str, (Instant, ClientProbe)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock() {
        if let Some((at, probe)) = map.get(spec.id) {
            if at.elapsed() < Duration::from_secs(30) {
                return probe.clone();
            }
        }
    }
    let probe = probe_client_fresh(spec);
    if let Ok(mut map) = cache.lock() {
        map.insert(spec.id, (Instant::now(), probe.clone()));
    }
    probe
}

fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
}

/// 客户端自己的会话注册表：`state_<N>.sqlite`，取版本号最大的一份（Codex 升 schema 时文件名会变）
fn codex_state_db(base: &Path) -> Option<PathBuf> {
    std::fs::read_dir(base)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let n = name
                .strip_prefix("state_")?
                .strip_suffix(".sqlite")?
                .parse::<u32>()
                .ok()?;
            Some((n, e.path()))
        })
        .max_by_key(|(n, _)| *n)
        .map(|(_, p)| p)
}

fn codex_thread_state(session_id: &str) -> ThreadState {
    match codex_home() {
        Some(base) => codex_thread_state_in(&base, session_id),
        None => ThreadState::Unknown,
    }
}

fn codex_thread_state_in(base: &Path, session_id: &str) -> ThreadState {
    let Some(db) = codex_state_db(base) else {
        return ThreadState::Unknown;
    };
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return ThreadState::Unknown;
    };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(300));
    match conn.query_row(
        "SELECT archived FROM threads WHERE id = ?1",
        [session_id],
        |r| r.get::<_, i64>(0),
    ) {
        Ok(a) => ThreadState::Present { archived: a != 0 },
        Err(rusqlite::Error::QueryReturnedNoRows) => ThreadState::Missing,
        Err(_) => ThreadState::Unknown,
    }
}

fn profiles_lite(store: &ProfileStore) -> Vec<ProfileLite> {
    store
        .list()
        .unwrap_or_default()
        .into_iter()
        .map(|p| ProfileLite {
            official: p.account_type == AccountType::Official,
            registrable: p.account_type != AccountType::Official
                && p.base_url.is_some()
                && p.has_key
                && !p.no_auth,
            gateway_id: p.gateway_id,
            id: p.id,
            agent: p.agent,
            name: p.name,
            key_hint: p.key_hint,
        })
        .collect()
}

fn gather_env(
    spec: &ClientSpec,
    target: &OpenTarget,
    profiles: Vec<ProfileLite>,
    fresh: bool,
) -> PlanEnv {
    let probe = if fresh {
        probe_client_fresh(spec)
    } else {
        probe_client_cached(spec)
    };
    let mut env = PlanEnv {
        probe,
        dir_exists: true,
        codex_providers: Vec::new(),
        codex_thread: ThreadState::Unknown,
        session_file_exists: None,
        profiles,
    };
    match target {
        OpenTarget::Project { path } => {
            let p = Path::new(path);
            env.dir_exists = p.is_absolute() && p.is_dir();
        }
        OpenTarget::Session {
            session_id,
            file_path,
            ..
        } => match spec.channel {
            ChannelPolicy::RegisteredProvider => {
                env.codex_providers = crate::agents::codex_client_config_providers();
                if valid_session_id(session_id) {
                    env.codex_thread = codex_thread_state(session_id);
                }
            }
            ChannelPolicy::OwnAccount => {
                env.session_file_exists = file_path
                    .as_deref()
                    .filter(|f| !f.is_empty())
                    .map(|f| Path::new(f).exists());
            }
        },
    }
    env
}

// ===== 命令 =====

fn find_client(client_id: &str) -> Option<(&'static AgentSpec, &'static ClientSpec)> {
    agent_specs::all_agent_specs()
        .iter()
        .find_map(|a| a.clients.iter().find(|c| c.id == client_id).map(|c| (a, c)))
}

/// 目标里的 agent 必须与客户端所属 agent 一致（防前端拿 Claude 的会话号去开 Codex）
fn target_matches_agent(target: &OpenTarget, agent: &AgentSpec) -> bool {
    match target {
        OpenTarget::Session { agent: a, .. } => a == agent.id,
        OpenTarget::Project { .. } => true,
    }
}

/// 所有已声明的客户端及本机安装情况
#[tauri::command]
pub async fn client_open_list() -> Vec<ClientInfoDto> {
    tauri::async_runtime::spawn_blocking(|| {
        agent_specs::all_agent_specs()
            .iter()
            .flat_map(|a| a.clients.iter().map(move |c| (a, c)))
            .map(|(a, c)| {
                let probe = probe_client_cached(c);
                ClientInfoDto {
                    client_id: c.id.into(),
                    agent: a.id.into(),
                    display: c.display.into(),
                    installed: probe.installed,
                    version: probe.version,
                    can_session: c.session_url.is_some(),
                    can_project: c.project_url.is_some(),
                    download_url: c.download_url.map(str::to_string),
                    reason: probe.reason,
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// 只读预检：能不能打开、要不要先修、有哪些要让用户知道的事
#[tauri::command]
pub async fn client_open_plan(
    store: tauri::State<'_, ProfileStore>,
    client_id: String,
    target: OpenTarget,
) -> Result<PlanDto, String> {
    let (agent, spec) = find_client(&client_id).ok_or("未知的客户端")?;
    if !target_matches_agent(&target, agent) {
        return Err("这条对话不属于该客户端".into());
    }
    let profiles = profiles_lite(&store);
    tauri::async_runtime::spawn_blocking(move || {
        let env = gather_env(spec, &target, profiles, true);
        build_plan(agent.id, spec, &target, &env)
    })
    .await
    .map_err(|e| e.to_string())
}

/// 执行：重新预检 → 做用户确认过的修复 → 发深链。被拦住（blocked）或还欠修复时拒绝
#[tauri::command]
pub async fn client_open_launch(
    store: tauri::State<'_, ProfileStore>,
    client_id: String,
    target: OpenTarget,
    fix: Option<FixChoice>,
) -> Result<(), String> {
    let (agent, spec) = find_client(&client_id).ok_or("未知的客户端")?;
    if !target_matches_agent(&target, agent) {
        return Err("这条对话不属于该客户端".into());
    }
    let profiles = profiles_lite(&store);
    let plan = {
        let target = target.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let env = gather_env(spec, &target, profiles, true);
            build_plan(agent.id, spec, &target, &env)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    if plan.verdict == "blocked" {
        let why = plan
            .checks
            .iter()
            .find(|c| c.status == "block")
            .map(|c| c.text.clone())
            .unwrap_or_else(|| "当前无法打开".into());
        crate::logbuf::record("warn", "client-open", &format!("{client_id} 被拦下：{why}"));
        return Err(why);
    }
    let mut fixed = "none";
    if let Some(need) = &plan.fix {
        let choice = fix.ok_or("还需要先确认修复")?;
        if choice.kind != need.kind
            || !need.candidates.iter().any(|c| c.profile_id == choice.profile_id)
        {
            return Err("所选修复不在可用范围内".into());
        }
        let profile = crate::global_config::profile_for_write(&store, &choice.profile_id)?;
        let key = crate::profiles::get_key_for_profile(&profile)?.ok_or("该连接没有已保存的密钥")?;
        let block = need.block_name.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::global_config::register_codex_client_provider_named(profile, key, block)
        })
        .await
        .map_err(|e| e.to_string())??;
        fixed = "codexRegister";
    }
    let url = plan.url.clone();
    let level = plan.level.clone();
    tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| {
        crate::logbuf::record("warn", "client-open", &format!("{client_id} 唤起失败：{e}"));
        format!("唤起{}失败：{e}", spec.display)
    })?;
    crate::logbuf::record(
        "info",
        "client-open",
        &format!("已交给 {client_id}（层级 {level}，修复 {fixed}）"),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codex() -> &'static ClientSpec {
        find_client("codex-desktop").unwrap().1
    }
    fn claude() -> &'static ClientSpec {
        find_client("claude-desktop").unwrap().1
    }

    fn lite(id: &str, gateway: Option<&str>, registrable: bool) -> ProfileLite {
        ProfileLite {
            id: id.into(),
            agent: "codex".into(),
            name: format!("连接{id}"),
            official: false,
            gateway_id: gateway.map(str::to_string),
            registrable,
            key_hint: Some("···abc1".into()),
        }
    }

    fn env_ok() -> PlanEnv {
        PlanEnv {
            probe: ClientProbe {
                installed: true,
                version: Some("1.0".into()),
                reason: None,
            },
            dir_exists: true,
            codex_providers: vec![],
            codex_thread: ThreadState::Present { archived: false },
            session_file_exists: Some(true),
            profiles: vec![],
        }
    }

    fn session(agent: &str, id: &str) -> OpenTarget {
        OpenTarget::Session {
            agent: agent.into(),
            session_id: id.into(),
            file_path: Some("/x/y.jsonl".into()),
            provider: None,
            profile_id: None,
            live_in_mesa: false,
        }
    }

    fn with_provider(provider: &str, profile_id: Option<&str>) -> OpenTarget {
        OpenTarget::Session {
            agent: "codex".into(),
            session_id: "019abc00-1234-7abc-8def-0123456789ab".into(),
            file_path: None,
            provider: Some(provider.into()),
            profile_id: profile_id.map(str::to_string),
            live_in_mesa: false,
        }
    }

    const SID: &str = "019abc00-1234-7abc-8def-0123456789ab";

    #[test]
    fn percent_encode_handles_unicode_space_and_windows_paths() {
        assert_eq!(percent_encode("/Users/me/综述文献"), "%2FUsers%2Fme%2F%E7%BB%BC%E8%BF%B0%E6%96%87%E7%8C%AE");
        assert_eq!(percent_encode("/a b/c"), "%2Fa%20b%2Fc");
        assert_eq!(percent_encode("C:\\Users\\me\\Demo"), "C%3A%5CUsers%5Cme%5CDemo");
        assert_eq!(percent_encode("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn deeplinks_match_verified_client_routes() {
        assert_eq!(
            session_url(codex(), SID).unwrap(),
            format!("codex://threads/{SID}")
        );
        assert_eq!(
            project_url(codex(), "/p/q r").unwrap(),
            "codex://threads/new?path=%2Fp%2Fq%20r"
        );
        assert_eq!(
            session_url(claude(), SID).unwrap(),
            format!("claude://resume?session={SID}")
        );
        assert_eq!(
            project_url(claude(), "/p").unwrap(),
            "claude://code/new?folder=%2Fp"
        );
    }

    #[test]
    fn session_id_and_block_name_are_validated_before_use() {
        assert!(valid_session_id(SID));
        assert!(!valid_session_id("short"));
        assert!(!valid_session_id("abc/../../etc-passwd-xxxxxxxxxxxx"));
        assert!(!valid_session_id("019abc00 1234&x=1"));
        assert!(valid_block_name("ccode"));
        assert!(valid_block_name("ccode-7f3ce8c6"));
        assert!(!valid_block_name("custom"));
        assert!(!valid_block_name("ccode-a\"]\n[evil"));
    }

    #[test]
    fn missing_client_blocks_everything() {
        let mut env = env_ok();
        env.probe = ClientProbe {
            installed: false,
            version: None,
            reason: Some("没有检测到 Codex 客户端。".into()),
        };
        let plan = build_plan("codex", codex(), &session("codex", SID), &env);
        assert_eq!(plan.verdict, "blocked");
        assert_eq!(plan.checks[0].id, "client_missing");
    }

    #[test]
    fn project_plan_requires_existing_dir() {
        let mut env = env_ok();
        let t = OpenTarget::Project { path: "/p/demo".into() };
        let plan = build_plan("codex", codex(), &t, &env);
        assert_eq!(plan.verdict, "ready");
        assert_eq!(plan.level, "project");
        assert_eq!(plan.url, "codex://threads/new?path=%2Fp%2Fdemo");
        env.dir_exists = false;
        let plan = build_plan("claude-code", claude(), &t, &env);
        assert_eq!(plan.verdict, "blocked");
        assert!(plan.checks.iter().any(|c| c.id == "dir_missing"));
    }

    #[test]
    fn codex_builtin_provider_is_ready_without_dialog_noise() {
        let env = env_ok();
        for p in [None, Some("openai")] {
            let t = OpenTarget::Session {
                agent: "codex".into(),
                session_id: SID.into(),
                file_path: None,
                provider: p.map(str::to_string),
                profile_id: None,
                live_in_mesa: false,
            };
            let plan = build_plan("codex", codex(), &t, &env);
            assert_eq!(plan.verdict, "ready");
            assert!(plan.checks.is_empty(), "{:?}", plan.checks);
            assert_eq!(plan.level, "session");
        }
    }

    #[test]
    fn codex_registered_mesa_provider_is_ok() {
        let mut env = env_ok();
        env.codex_providers = vec!["ccode-7f3ce8c6".into()];
        let plan = build_plan("codex", codex(), &with_provider("ccode-7f3ce8c6", None), &env);
        assert_eq!(plan.verdict, "ready");
        assert!(plan.checks.iter().all(|c| c.status == "ok"));
    }

    #[test]
    fn codex_unregistered_mesa_provider_offers_fix_with_ordered_candidates() {
        let mut env = env_ok();
        env.profiles = vec![
            lite("p-other", Some("11111111-aaaa"), true),
            lite("p-match", Some("7f3ce8c6-0000-0000-0000-000000000000"), true),
            lite("p-nokey", Some("7f3ce8c6-0000-0000-0000-000000000000"), false),
        ];
        let plan = build_plan("codex", codex(), &with_provider("ccode-7f3ce8c6", None), &env);
        assert_eq!(plan.verdict, "needsFix");
        let fix = plan.fix.unwrap();
        assert_eq!(fix.kind, "codexRegister");
        assert_eq!(fix.block_name, "ccode-7f3ce8c6");
        let ids: Vec<_> = fix.candidates.iter().map(|c| c.profile_id.as_str()).collect();
        assert_eq!(ids, ["p-match"], "短 id 对得上的才是候选，没存密钥的不能写");

        // profile_id 精确命中排最前，即使网关对不上
        let plan = build_plan(
            "codex",
            codex(),
            &with_provider("ccode-7f3ce8c6", Some("p-other")),
            &env,
        );
        let ids: Vec<_> = plan.fix.unwrap().candidates.iter().map(|c| c.profile_id.clone()).collect();
        assert_eq!(ids, ["p-other", "p-match"]);
    }

    #[test]
    fn codex_legacy_ccode_lists_all_registrable_profiles() {
        let mut env = env_ok();
        env.profiles = vec![
            lite("a", Some("aaaaaaaa-1"), true),
            lite("b", None, true),
            lite("c", Some("cccccccc-1"), false),
        ];
        let plan = build_plan("codex", codex(), &with_provider("ccode", Some("b")), &env);
        let ids: Vec<_> = plan.fix.unwrap().candidates.iter().map(|c| c.profile_id.clone()).collect();
        assert_eq!(ids, ["b", "a"]);
    }

    #[test]
    fn candidates_from_the_same_gateway_are_deduplicated() {
        let mut env = env_ok();
        env.profiles = vec![
            lite("deepseek", Some("7f3ce8c6-1"), true),
            lite("gpt", Some("7f3ce8c6-1"), true),
            lite("test", Some("98e3a8e6-2"), true),
        ];
        let plan = build_plan("codex", codex(), &with_provider("ccode", Some("gpt")), &env);
        let ids: Vec<_> = plan.fix.unwrap().candidates.iter().map(|c| c.profile_id.clone()).collect();
        assert_eq!(ids, ["gpt", "test"], "精确命中的绑定优先，同网关的兄弟绑定不重复列出");
    }

    #[test]
    fn codex_unregistered_without_candidates_blocks() {
        let env = env_ok();
        let plan = build_plan("codex", codex(), &with_provider("ccode-7f3ce8c6", None), &env);
        assert_eq!(plan.verdict, "blocked");
        assert!(plan.checks.iter().any(|c| c.id == "provider_no_profile"));
        assert!(plan.fix.is_none());
    }

    #[test]
    fn codex_disk_provider_is_ok_only_when_client_config_defines_it() {
        let mut env = env_ok();
        let t = with_provider("custom", None);
        assert_eq!(build_plan("codex", codex(), &t, &env).verdict, "blocked");
        env.codex_providers = vec!["custom".into()];
        assert_eq!(build_plan("codex", codex(), &t, &env).verdict, "ready");
    }

    #[test]
    fn codex_thread_missing_warns_but_does_not_block() {
        let mut env = env_ok();
        env.codex_thread = ThreadState::Missing;
        let plan = build_plan("codex", codex(), &session("codex", SID), &env);
        assert_eq!(plan.verdict, "ready");
        assert!(plan.checks.iter().any(|c| c.id == "thread_unknown" && c.status == "warn"));
        env.codex_thread = ThreadState::Unknown;
        let plan = build_plan("codex", codex(), &session("codex", SID), &env);
        assert!(plan.checks.is_empty(), "读不到客户端库时不假装知道");
    }

    #[test]
    fn live_in_mesa_warns() {
        let env = env_ok();
        let t = OpenTarget::Session {
            agent: "codex".into(),
            session_id: SID.into(),
            file_path: None,
            provider: None,
            profile_id: None,
            live_in_mesa: true,
        };
        let plan = build_plan("codex", codex(), &t, &env);
        assert_eq!(plan.verdict, "ready");
        assert!(plan.checks.iter().any(|c| c.id == "live_in_mesa" && c.status == "warn"));
    }

    #[test]
    fn bad_session_id_blocks_and_never_builds_url() {
        let env = env_ok();
        let plan = build_plan("codex", codex(), &session("codex", "x/../y"), &env);
        assert_eq!(plan.verdict, "blocked");
        assert!(plan.url.is_empty());
    }

    #[test]
    fn claude_transcript_missing_blocks() {
        let mut env = env_ok();
        env.session_file_exists = Some(false);
        let plan = build_plan("claude-code", claude(), &session("claude-code", SID), &env);
        assert_eq!(plan.verdict, "blocked");
        assert!(plan.checks.iter().any(|c| c.id == "transcript_missing"));
        env.session_file_exists = None;
        assert_eq!(
            build_plan("claude-code", claude(), &session("claude-code", SID), &env).verdict,
            "ready"
        );
    }

    #[test]
    fn claude_gateway_session_notes_channel_change_official_does_not() {
        let mut env = env_ok();
        let mut gw = lite("gw", Some("g"), true);
        gw.agent = "claude-code".into();
        let mut off = lite("off", None, false);
        off.agent = "claude-code".into();
        off.official = true;
        env.profiles = vec![gw, off];
        let mk = |pid: &str| OpenTarget::Session {
            agent: "claude-code".into(),
            session_id: SID.into(),
            file_path: Some("/x.jsonl".into()),
            provider: None,
            profile_id: Some(pid.into()),
            live_in_mesa: false,
        };
        let plan = build_plan("claude-code", claude(), &mk("gw"), &env);
        assert_eq!(plan.verdict, "ready");
        let note = plan.checks.iter().find(|c| c.id == "channel_changes").unwrap();
        assert_eq!(note.status, "note");
        assert!(note.text.contains("连接gw"));
        let plan = build_plan("claude-code", claude(), &mk("off"), &env);
        assert!(plan.checks.is_empty());
    }

    #[test]
    fn client_agent_binding_is_checked() {
        let (agent, _) = find_client("codex-desktop").unwrap();
        assert!(target_matches_agent(&session("codex", SID), agent));
        assert!(!target_matches_agent(&session("claude-code", SID), agent));
        assert!(target_matches_agent(&OpenTarget::Project { path: "/p".into() }, agent));
    }

    #[test]
    fn opentarget_deserializes_camel_case_from_frontend() {
        let t: OpenTarget = serde_json::from_str(
            r#"{"kind":"session","agent":"codex","sessionId":"abc12345","liveInMesa":true,"profileId":"p1"}"#,
        )
        .unwrap();
        match t {
            OpenTarget::Session { session_id, live_in_mesa, profile_id, .. } => {
                assert_eq!(session_id, "abc12345");
                assert!(live_in_mesa);
                assert_eq!(profile_id.as_deref(), Some("p1"));
            }
            _ => panic!("应解析为 Session"),
        }
        let p: OpenTarget = serde_json::from_str(r#"{"kind":"project","path":"/p"}"#).unwrap();
        assert!(matches!(p, OpenTarget::Project { .. }));
    }

    #[test]
    fn codex_state_db_picks_highest_schema_version() {
        let dir = std::env::temp_dir().join(format!("ccode-state-db-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for n in ["state_5.sqlite", "state_6.sqlite", "state_5.sqlite-wal", "state_x.sqlite", "logs_2.sqlite"] {
            std::fs::write(dir.join(n), b"").unwrap();
        }
        assert_eq!(codex_state_db(&dir).unwrap().file_name().unwrap(), "state_6.sqlite");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_thread_lookup_reads_threads_table_read_only() {
        let dir = std::env::temp_dir().join(format!("ccode-threads-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("state_5.sqlite");
        {
            let c = rusqlite::Connection::open(&db).unwrap();
            c.execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0);
                 INSERT INTO threads VALUES ('live-thread-1', 0), ('old-thread-1', 1);",
            )
            .unwrap();
        }
        assert_eq!(codex_thread_state_in(&dir, "live-thread-1"), ThreadState::Present { archived: false });
        assert_eq!(codex_thread_state_in(&dir, "old-thread-1"), ThreadState::Present { archived: true });
        assert_eq!(codex_thread_state_in(&dir, "nope-thread-1"), ThreadState::Missing);
        assert_eq!(codex_thread_state_in(&dir.join("nowhere"), "x"), ThreadState::Unknown);
        std::fs::remove_dir_all(&dir).ok();
    }
}
