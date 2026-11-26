//! 多官方账号管理（2026-11-21，设计稿 docs/design-multi-official-accounts.md）：
//! - 目录隔离并发（6 家，凭据只读、绝不刷新/回写）：
//!   Claude Code (`CLAUDE_CONFIG_DIR`)、Codex (`CODEX_HOME`)、Grok Build (`GROK_HOME`)、
//!   Kimi Code (`KIMI_CODE_HOME` + `KIMI_SHARE_DIR`)、Gemini CLI (`GEMINI_CLI_HOME`)、
//!   CodeBuddy (`CODEBUDDY_CONFIG_DIR`)。
//! - Antigravity CLI (`agy`)：底层写死全局单条系统钥匙串（service `gemini`、account `antigravity`），
//!   不支持多官方号并发；本模块维护 0600 本地快照库 `official-accounts/agy-accounts.json`（不进导出/诊断包），
//!   支持多号收录、切号前必收回、副本刷新查余量、以及进程内单活并发护栏。

use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const OFFICIAL_ACCOUNTS_DIR: &str = "official-accounts";
const AGY_ACCOUNTS_FILE: &str = "agy-accounts.json";
const AGY_KEYCHAIN_SERVICE: &str = "gemini";
const AGY_KEYCHAIN_ACCOUNT: &str = "antigravity";
const GO_KEYRING_PREFIX: &str = "go-keyring-base64:";

/// agy 内置安装型 OAuth 客户端（仅用于非激活副本查余量时的 access_token 刷新，绝不用于回写钥匙串）
const AGY_OAUTH_CLIENT_ID: &str =
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const AGY_OAUTH_CLIENT_SECRET_PARTS: [&str; 2] = ["GOCSPX-", "K58FWR486LdLJ1mLB8sXC4z6qDAf"];
const AGY_OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const TOKEN_REFRESH_MARGIN_SECS: i64 = 120;

// ===== 核心模型（与 profiles.rs / 前端 types.ts 共享） =====

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum OfficialAccountMode {
    /// 指向本机 CLI 默认登录位置（~/.claude、~/.codex、系统默认钥匙串）
    #[default]
    Default,
    /// Mesa 管理的隔离目录（Claude: CLAUDE_CONFIG_DIR / Codex: CODEX_HOME）
    IsolatedDir,
    /// Mesa 托管的凭证快照（Antigravity 钥匙串轮换）
    ManagedSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OfficialAccountRef {
    #[serde(default)]
    pub mode: OfficialAccountMode,
    /// 隔离目录的相对短 ID（防绝对路径污染配置导出）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_dir_id: Option<String>,
    /// 托管快照 ID（仅 agy：对应 agy-accounts.json 中的键）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    /// 非敏感展示副标题（如邮箱、组织名），仅作界面区分
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_hint: Option<String>,
}

/// 连接页展示的单条官方绑定状态 DTO
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialBindingStatusDto {
    pub binding_id: String,
    pub agent: String,
    pub name: String,
    pub mode: OfficialAccountMode,
    pub connected: bool,
    pub detail: Option<String>,
    pub email: Option<String>,
    pub plan: Option<String>,
    /// 仅对 agy 托管账号有意义：当前系统钥匙串是否正激活这一条
    pub is_active_slot: Option<bool>,
    /// 登录命令（已拼好，可直接进终端执行）
    pub login_command: Option<String>,
    /// 登录需注入的环境变量（含隔离目录 + 出网代理）
    pub login_env: BTreeMap<String, String>,
    /// 仅本机参考，非敏感
    pub isolated_dir: Option<String>,
}

/// 创建附加官方账号的返回结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOfficialAccountResult {
    pub profile: crate::profiles::Profile,
    pub login_command: Option<String>,
    pub login_env: BTreeMap<String, String>,
    pub already_connected: bool,
}

/// 正在运行的 Antigravity 官方会话（单活并发护栏用）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgyActiveSessionDto {
    pub tab_id: String,
    pub binding_id: String,
    pub snapshot_id: Option<String>,
    pub label: String,
}

/// 哪几家 Agent 支持添加多个官方账号（6 家原生目录隔离 + Antigravity 托管快照）
#[allow(dead_code)]
pub fn supports_multi_official(agent: &str) -> bool {
    matches!(
        agent,
        "claude-code" | "codex" | "agy" | "grok" | "kimi" | "gemini" | "codebuddy"
    )
}

#[allow(dead_code)]
pub fn multi_official_mode(agent: &str) -> Option<OfficialAccountMode> {
    match agent {
        "claude-code" | "codex" | "grok" | "kimi" | "gemini" | "codebuddy" => {
            Some(OfficialAccountMode::IsolatedDir)
        }
        "agy" => Some(OfficialAccountMode::ManagedSnapshot),
        _ => None,
    }
}

pub fn is_isolated_dir_agent(agent: &str) -> bool {
    matches!(
        agent,
        "claude-code" | "codex" | "grok" | "kimi" | "gemini" | "codebuddy"
    )
}

/// 同一 Agent 的两个连接在对话里切换时，是否因跨隔离官方账号而必须走接力简报（不能原 session_id 直连）
#[allow(dead_code)]
pub fn is_isolated_or_managed_official(official_ref: Option<&OfficialAccountRef>) -> bool {
    matches!(
        official_ref.map(|r| &r.mode),
        Some(OfficialAccountMode::IsolatedDir | OfficialAccountMode::ManagedSnapshot)
    )
}

// ===== 隔离目录管理（Claude / Codex） =====

pub fn official_accounts_root() -> Result<PathBuf, String> {
    let base = crate::storage::config_root().ok_or_else(|| "无法确定平台配置目录".to_string())?;
    Ok(base.join(OFFICIAL_ACCOUNTS_DIR))
}

pub fn validate_local_dir_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err("隔离目录标识长度不合法".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("隔离目录标识只能包含字母、数字、连字符和下划线".into());
    }
    Ok(())
}

fn agent_dir_segment(agent: &str) -> Result<&'static str, String> {
    match agent {
        "claude-code" => Ok("claude"),
        "codex" => Ok("codex"),
        "grok" => Ok("grok"),
        "kimi" => Ok("kimi"),
        "gemini" => Ok("gemini"),
        "codebuddy" => Ok("codebuddy"),
        other => Err(format!("{other} 不支持隔离目录模式")),
    }
}

pub fn isolated_dir_path(agent: &str, local_dir_id: &str) -> Result<PathBuf, String> {
    validate_local_dir_id(local_dir_id)?;
    let seg = agent_dir_segment(agent)?;
    Ok(official_accounts_root()?.join(seg).join(local_dir_id))
}

pub fn ensure_isolated_dir(agent: &str, local_dir_id: &str) -> Result<PathBuf, String> {
    let dir = isolated_dir_path(agent, local_dir_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建隔离账号目录失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// 删除附加隔离账号的本地目录与 macOS 隔离钥匙串项（绝不碰默认目录与默认钥匙串项）
pub fn remove_isolated_dir(agent: &str, local_dir_id: &str) -> Result<(), String> {
    let dir = isolated_dir_path(agent, local_dir_id)?;
    if agent == "claude-code" {
        #[cfg(target_os = "macos")]
        {
            if let Some(dir_str) = dir.to_str() {
                let service = crate::official_quota::claude_keychain_service_for_dir(Some(dir_str));
                // 只删带目录哈希后缀的隔离项，绝不删无后缀默认项
                if service != "Claude Code-credentials" {
                    let _ = crate::process::background_command("/usr/bin/security")
                        .args(["delete-generic-password", "-s", &service])
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                }
            }
        }
    }
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("清理隔离账号目录失败: {e}"))?;
    }
    Ok(())
}

/// 枚举某 Agent 所有已登记的附加隔离目录 `(binding_id, path)`
pub fn all_isolated_roots(agent: &str) -> Vec<(String, PathBuf)> {
    if !is_isolated_dir_agent(agent) {
        return Vec::new();
    }
    let Ok(bindings) = crate::gateway_store::load_bindings() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for b in bindings {
        if b.agent != agent || b.kind != crate::profiles::BindingKind::Official {
            continue;
        }
        let Some(r) = b.official_ref.as_ref() else {
            continue;
        };
        if r.mode != OfficialAccountMode::IsolatedDir {
            continue;
        }
        let Some(dir_id) = r.local_dir_id.as_deref() else {
            continue;
        };
        if let Ok(path) = isolated_dir_path(agent, dir_id) {
            out.push((b.id, path));
        }
    }
    out
}

/// 给定历史会话文件路径，检查它是否落在某个附加隔离账号目录内；命中时返回该隔离目录（供续聊回注环境变量）
#[allow(dead_code)]
pub fn isolated_dir_for_session_file(agent: &str, file_path: &Path) -> Option<PathBuf> {
    let canon_file = file_path.canonicalize().unwrap_or_else(|_| file_path.to_path_buf());
    for (_, root) in all_isolated_roots(agent) {
        let canon_root = root.canonicalize().unwrap_or_else(|_| root.clone());
        if canon_file.starts_with(&canon_root) || file_path.starts_with(&root) {
            return Some(root);
        }
    }
    None
}

fn outbound_env_map() -> BTreeMap<String, String> {
    crate::settings::official_outbound_env().into_iter().collect()
}

/// 为指定隔离目录构造官方账号登录 env（叠加出网代理 + 对应隔离目录变量）
pub fn login_env_for_isolated(agent: &str, dir: &Path) -> BTreeMap<String, String> {
    let mut env = outbound_env_map();
    let dir_str = dir.to_string_lossy().to_string();
    match agent {
        "claude-code" => {
            env.insert("CLAUDE_CONFIG_DIR".into(), dir_str);
        }
        "codex" => {
            env.insert("CODEX_HOME".into(), dir_str);
        }
        "grok" => {
            env.insert("GROK_HOME".into(), dir_str);
        }
        "kimi" => {
            env.insert("KIMI_CODE_HOME".into(), dir_str);
            // 同步隔离旧版 kimi-cli 目录，避免落回 ~/.kimi
            env.insert(
                "KIMI_SHARE_DIR".into(),
                dir.join("legacy").to_string_lossy().to_string(),
            );
        }
        "gemini" => {
            // GEMINI_CLI_HOME 顶替家目录，CLI 会在其下读写 .gemini/
            env.insert("GEMINI_CLI_HOME".into(), dir_str);
        }
        "codebuddy" => {
            env.insert("CODEBUDDY_CONFIG_DIR".into(), dir_str);
        }
        _ => {}
    }
    env
}

// ===== 隔离账号凭据/身份只读探测（Claude / Codex） =====

/// 解码 JWT 的中间 payload 段（不校验签名，仅提取非敏感展示字段 email / sub / name）
pub(crate) fn decode_jwt_payload(jwt: &str) -> Option<Value> {
    let mut parts = jwt.split('.');
    let _header = parts.next()?;
    let payload_b64 = parts.next()?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .or_else(|_| {
            // 容忍带 padding 的实现
            let padded = match payload_b64.len() % 4 {
                2 => format!("{payload_b64}=="),
                3 => format!("{payload_b64}="),
                _ => payload_b64.to_string(),
            };
            base64::engine::general_purpose::URL_SAFE.decode(padded)
        })
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// 从 Claude 配置目录的 `.claude.json` 只读提取账号邮箱/组织提示（非敏感）
pub fn read_claude_account_hint(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(".claude.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let oa = v.get("oauthAccount")?;
    let email = oa
        .get("emailAddress")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let org = oa
        .get("organizationName")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match (email, org) {
        (Some(e), Some(o)) if !e.eq_ignore_ascii_case(o) => Some(format!("{e} · {o}")),
        (Some(e), _) => Some(e.to_string()),
        (None, Some(o)) => Some(o.to_string()),
        (None, None) => None,
    }
}

/// 只读探测某个隔离 `CLAUDE_CONFIG_DIR` 的登录态、邮箱和套餐
pub fn probe_isolated_claude(dir: &Path) -> (bool, Option<String>, Option<String>) {
    let hint = read_claude_account_hint(dir);
    let creds = crate::official_quota::probe_claude_dir(dir);
    match creds {
        Some((has_token, plan)) => (has_token, hint, plan),
        None => (false, hint, None),
    }
}

/// 只读探测某个隔离 `CODEX_HOME` 的登录态、邮箱和套餐
pub fn probe_isolated_codex(dir: &Path) -> (bool, Option<String>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(dir.join("auth.json")) else {
        return (false, None, None);
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return (false, None, None);
    };
    let Some(tokens) = v.get("tokens") else {
        return (false, None, None);
    };
    let access = tokens
        .get("access_token")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .unwrap_or("");
    if access.is_empty() {
        return (false, None, None);
    }
    let jwt = tokens
        .get("id_token")
        .and_then(|x| x.as_str())
        .and_then(decode_jwt_payload);
    let email = jwt
        .as_ref()
        .and_then(|p| p.get("email"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let plan = jwt
        .as_ref()
        .and_then(|p| p.get("https://api.openai.com/auth"))
        .and_then(|a| a.get("chatgpt_plan_type"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    (true, email, plan)
}

/// 只读探测某个隔离 `GROK_HOME` 的登录态（auth.json 中存在非空 `key` 的 OIDC / sign-in 条目）
pub fn probe_isolated_grok(dir: &Path) -> (bool, Option<String>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(dir.join("auth.json")) else {
        return (false, None, None);
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return (false, None, None);
    };
    let Some(root) = v.as_object() else {
        return (false, None, None);
    };
    let mut oidc = None;
    let mut legacy = None;
    for (scope, val) in root {
        let Some(entry) = val.as_object() else { continue };
        let has_key = entry
            .get("key")
            .and_then(|k| k.as_str())
            .is_some_and(|s| !s.trim().is_empty());
        if !has_key {
            continue;
        }
        if scope.starts_with("https://auth.x.ai::") {
            oidc = Some(entry);
        } else if scope == "https://accounts.x.ai/sign-in" || scope.contains("/sign-in") {
            legacy = Some(entry);
        }
    }
    let Some(entry) = oidc.or(legacy) else {
        return (false, None, None);
    };
    let email = entry
        .get("email")
        .and_then(|x| x.as_str())
        .or_else(|| {
            entry
                .get("id_token")
                .and_then(|x| x.as_str())
                .and_then(|_| None)
        })
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            entry
                .get("id_token")
                .and_then(|x| x.as_str())
                .and_then(decode_jwt_payload)
                .and_then(|p| p.get("email").and_then(|x| x.as_str()).map(str::to_string))
        });
    (true, email, None)
}

/// 只读探测某个隔离 `KIMI_CODE_HOME` 的登录态（`credentials/*.json` 中存在有效 access_token 或 refresh_token）
pub fn probe_isolated_kimi(dir: &Path) -> (bool, Option<String>, Option<String>) {
    let creds_dir = dir.join("credentials");
    let Ok(entries) = std::fs::read_dir(&creds_dir) else {
        return (false, None, None);
    };
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    candidates.sort();
    for path in candidates {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let has_access = v
            .get("access_token")
            .and_then(|x| x.as_str())
            .is_some_and(|s| !s.trim().is_empty());
        let has_refresh = v
            .get("refresh_token")
            .and_then(|x| x.as_str())
            .is_some_and(|s| !s.trim().is_empty());
        if has_access || has_refresh {
            return (true, None, None);
        }
    }
    (false, None, None)
}

/// 只读探测某个隔离 `GEMINI_CLI_HOME` 的登录态（`<dir>/.gemini/oauth_creds.json`）
pub fn probe_isolated_gemini(dir: &Path) -> (bool, Option<String>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(dir.join(".gemini").join("oauth_creds.json")) else {
        return (false, None, None);
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return (false, None, None);
    };
    let has_token = v
        .get("access_token")
        .or_else(|| v.get("refresh_token"))
        .and_then(|x| x.as_str())
        .is_some_and(|s| !s.trim().is_empty());
    if !has_token {
        return (false, None, None);
    }
    let email = v
        .get("id_token")
        .and_then(|x| x.as_str())
        .and_then(decode_jwt_payload)
        .and_then(|p| {
            p.get("email")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
    (true, email, None)
}

/// 只读探测某个隔离 `CODEBUDDY_CONFIG_DIR` 的登录态（`<dir>/.credentials.json`）
pub fn probe_isolated_codebuddy(dir: &Path) -> (bool, Option<String>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(dir.join(".credentials.json")) else {
        return (false, None, None);
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return (false, None, None);
    };
    let Some(obj) = v.as_object() else {
        return (false, None, None);
    };
    if obj.is_empty() {
        return (false, None, None);
    }
    // 任意嵌套层级含非空 token / accessToken / access_token / refreshToken / refresh_token 即视为已登录
    fn has_nonempty_token(val: &Value) -> bool {
        match val {
            Value::Object(map) => map.iter().any(|(k, v)| {
                let lk = k.to_ascii_lowercase();
                if (lk.contains("token") || lk == "jwt" || lk == "session")
                    && v.as_str().is_some_and(|s| !s.trim().is_empty())
                {
                    return true;
                }
                has_nonempty_token(v)
            }),
            Value::Array(arr) => arr.iter().any(has_nonempty_token),
            _ => false,
        }
    }
    if !has_nonempty_token(&v) {
        return (false, None, None);
    }
    let email = obj
        .get("email")
        .or_else(|| obj.get("userEmail"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    (true, email, None)
}

// ===== Antigravity (`agy`) 托管凭证快照库（0600）与钥匙串轮换 =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgySnapshotEntry {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// agy 钥匙串内原始 JSON，原样保存以便未来字段兼容
    pub credential: Value,
    pub authenticated_at: i64,
    #[serde(default)]
    pub requires_reauth: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgySnapshotFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    accounts: BTreeMap<String, AgySnapshotEntry>,
}

static AGY_STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn agy_store_lock() -> std::sync::MutexGuard<'static, ()> {
    AGY_STORE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

pub fn agy_keychain_supported() -> bool {
    cfg!(target_os = "macos")
}

/// 本机有没有存 Antigravity 登录凭据：`~/.gemini/antigravity-cli/antigravity-oauth-token`，或 go-keyring 那一项
/// （macOS 钥匙串 service `gemini` / account `antigravity`，Windows 凭据管理器的普通凭据 `gemini:antigravity`）。
/// 只看有没有，不读内容（macOS 不带 -w，不弹钥匙串授权）。
/// `Some(false)` = 确定没登录：别在后台跑 `agy --print …`——未登录的打印模式会转去交互式 OAuth、自己弹浏览器登录页，
/// Mesa 几秒后就收掉进程，回调页成了死路（2026-11-25 Windows agy 1.5.16 实测：余量环查 `--print /usage` 每两分钟弹一次）。
/// 查不了（Linux 等）返回 None，调用方照旧
pub fn agy_credential_present() -> Option<bool> {
    if cfg!(test) {
        return None;
    }
    let token_file = crate::dirs::home_dir().is_some_and(|h| {
        h.join(".gemini/antigravity-cli/antigravity-oauth-token")
            .metadata()
            .is_ok_and(|m| m.is_file() && m.len() > 0)
    });
    if token_file {
        return Some(true);
    }
    agy_credential_present_os()
}

#[cfg(target_os = "macos")]
fn agy_credential_present_os() -> Option<bool> {
    let status = crate::process::background_command("/usr/bin/security")
        .args(["find-generic-password", "-s", AGY_KEYCHAIN_SERVICE, "-a", AGY_KEYCHAIN_ACCOUNT])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()?;
    match status.code() {
        Some(0) => Some(true),
        Some(44) => Some(false), // errSecItemNotFound
        _ => None,
    }
}

#[cfg(windows)]
fn agy_credential_present_os() -> Option<bool> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC};
    // go-keyring 的 Windows 实现：凭据名 = service + ":" + user
    let target: Vec<u16> = format!("{AGY_KEYCHAIN_SERVICE}:{AGY_KEYCHAIN_ACCOUNT}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
    // SAFETY：target 以 0 结尾；成功时 cred 由系统分配，随即 CredFree 释放，不读其中内容
    let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) };
    if ok != 0 {
        unsafe { CredFree(cred as *const std::ffi::c_void) };
        return Some(true);
    }
    (unsafe { GetLastError() } == ERROR_NOT_FOUND).then_some(false)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn agy_credential_present_os() -> Option<bool> {
    None
}

fn agy_accounts_path() -> Result<PathBuf, String> {
    Ok(official_accounts_root()?.join(AGY_ACCOUNTS_FILE))
}

fn load_agy_store_locked() -> Result<AgySnapshotFile, String> {
    let path = agy_accounts_path()?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("解析 agy-accounts.json 失败: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AgySnapshotFile {
            version: 1,
            accounts: BTreeMap::new(),
        }),
        Err(e) => Err(format!("读取 agy-accounts.json 失败: {e}")),
    }
}

fn save_agy_store_locked(store: &AgySnapshotFile) -> Result<(), String> {
    let path = agy_accounts_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let text = serde_json::to_string_pretty(store)
        .map_err(|e| format!("序列化 agy-accounts.json 失败: {e}"))?;
    crate::storage::atomic_write(&path, text.as_bytes(), true)
}

pub fn decode_go_keyring(raw: &str) -> Result<Value, String> {
    let raw = raw.trim();
    let json = match raw.strip_prefix(GO_KEYRING_PREFIX) {
        Some(encoded) => {
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| "Antigravity 登录数据不是有效的 base64".to_string())?;
            String::from_utf8(bytes)
                .map_err(|_| "Antigravity 登录数据不是有效的 UTF-8".to_string())?
        }
        None => raw.to_string(),
    };
    let val: Value =
        serde_json::from_str(&json).map_err(|_| "Antigravity 登录数据不是有效 JSON".to_string())?;
    if !val.is_object() {
        return Err("Antigravity 登录数据不是 JSON 对象".into());
    }
    Ok(val)
}

pub fn encode_go_keyring(credential: &Value) -> Result<String, String> {
    let json =
        serde_json::to_string(credential).map_err(|e| format!("编码 Antigravity 登录失败: {e}"))?;
    Ok(format!("{GO_KEYRING_PREFIX}{}", STANDARD.encode(json)))
}

fn refresh_token_of(cred: &Value) -> Option<&str> {
    cred.get("token")
        .and_then(|t| t.get("refresh_token"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn access_token_of(cred: &Value) -> Option<&str> {
    cred.get("token")
        .and_then(|t| t.get("access_token"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn expiry_epoch_secs_of(cred: &Value) -> Option<i64> {
    let exp = cred.get("token")?.get("expiry")?;
    if let Some(s) = exp.as_str() {
        return chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|d| d.timestamp());
    }
    exp.as_i64()
}

/// 从钥匙串 JSON 提取 `(稳定 id, email, name)`
pub fn extract_agy_identity(cred: &Value) -> (String, Option<String>, Option<String>) {
    let jwt = cred
        .get("id_token")
        .and_then(|x| x.as_str())
        .and_then(decode_jwt_payload);
    let sub = jwt
        .as_ref()
        .and_then(|p| p.get("sub"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let email = jwt
        .as_ref()
        .and_then(|p| p.get("email"))
        .and_then(|x| x.as_str())
        .or_else(|| cred.get("id_token_email").and_then(|x| x.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let name = jwt
        .as_ref()
        .and_then(|p| p.get("name"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let id = if let Some(s) = sub {
        s
    } else if let Some(e) = &email {
        let hash = Sha256::digest(e.to_lowercase().as_bytes());
        format!(
            "em-{}",
            hash.iter()
                .take(8)
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        )
    } else if let Some(rt) = refresh_token_of(cred) {
        let hash = Sha256::digest(rt.as_bytes());
        format!(
            "rt-{}",
            hash.iter()
                .take(8)
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        )
    } else {
        format!("agy-{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
    };
    (id, email, name)
}

/// 在库中按 id / refresh_token / email 对回已收录的快照键（兼容 agy 1.5 不再写 id_token 的情况）
fn match_existing_agy_id(store: &AgySnapshotFile, cred: &Value) -> Option<String> {
    let (id, email, _) = extract_agy_identity(cred);
    if store.accounts.contains_key(&id) {
        return Some(id);
    }
    if let Some(rt) = refresh_token_of(cred) {
        if let Some((k, _)) = store
            .accounts
            .iter()
            .find(|(_, v)| refresh_token_of(&v.credential) == Some(rt))
        {
            return Some(k.clone());
        }
    }
    if let Some(em) = email {
        if let Some((k, _)) = store.accounts.iter().find(|(_, v)| {
            v.email
                .as_deref()
                .is_some_and(|e| e.eq_ignore_ascii_case(&em))
        }) {
            return Some(k.clone());
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn read_agy_keychain_raw() -> Result<Option<String>, String> {
    if cfg!(test) {
        return Ok(None);
    }
    let output = crate::process::background_command("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            AGY_KEYCHAIN_SERVICE,
            "-a",
            AGY_KEYCHAIN_ACCOUNT,
            "-w",
        ])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("读取 Antigravity 钥匙串失败: {e}"))?;
    // errSecItemNotFound = 44
    if output.status.code() == Some(44) {
        return Ok(None);
    }
    if !output.status.success() {
        return Err(format!(
            "读取 Antigravity 钥匙串失败（退出码 {:?}）",
            output.status.code()
        ));
    }
    let value = String::from_utf8(output.stdout)
        .map_err(|_| "Antigravity 钥匙串内容不是有效 UTF-8".to_string())?;
    let trimmed = value.trim_end_matches(['\r', '\n']).to_string();
    Ok((!trimmed.is_empty()).then_some(trimmed))
}

#[cfg(not(target_os = "macos"))]
fn read_agy_keychain_raw() -> Result<Option<String>, String> {
    Err("当前平台暂不支持自动切换 Antigravity 钥匙串（目前仅支持 macOS）".into())
}

#[cfg(target_os = "macos")]
fn write_agy_keychain_raw(encoded: &str) -> Result<(), String> {
    if cfg!(test) {
        return Ok(());
    }
    use std::io::Write;
    use std::process::Stdio;
    // 用 `security -i` 通过 stdin 管道写入，令牌不进 argv，不被 `ps` 看见
    if encoded.contains(['\n', '\r', '"', '\\']) {
        return Err("Antigravity 钥匙串编码值含非法字符".into());
    }
    let line = format!(
        "add-generic-password -U -s \"{AGY_KEYCHAIN_SERVICE}\" -a \"{AGY_KEYCHAIN_ACCOUNT}\" -w \"{encoded}\"\n"
    );
    let mut child = crate::process::background_command("/usr/bin/security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 security 写入钥匙串失败: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("写入 security 管道失败: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("等待 security 写入结束失败: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "写入 Antigravity 钥匙串失败（{}）",
            stderr.trim()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn write_agy_keychain_raw(_encoded: &str) -> Result<(), String> {
    Err("当前平台暂不支持自动切换 Antigravity 钥匙串（目前仅支持 macOS）".into())
}

/// 纯逻辑内核：将当前钥匙串登录收回进快照库，供生产和单测共用
fn upsert_agy_snapshot(store: &mut AgySnapshotFile, cred: Value, now_secs: i64) -> AgySnapshotEntry {
    let matched = match_existing_agy_id(store, &cred);
    let (derived_id, email, name) = extract_agy_identity(&cred);
    let id = matched.unwrap_or(derived_id);
    let prev = store.accounts.get(&id);
    let entry = AgySnapshotEntry {
        id: id.clone(),
        email: email.or_else(|| prev.and_then(|p| p.email.clone())),
        name: name.or_else(|| prev.and_then(|p| p.name.clone())),
        credential: cred,
        authenticated_at: now_secs,
        requires_reauth: false,
    };
    store.accounts.insert(id, entry.clone());
    entry
}

/// 读取当前钥匙串属于哪个已收录快照（若匹配则顺手更新副本里续期后的新 token）
pub fn agy_active_snapshot_id() -> Option<String> {
    if !agy_keychain_supported() {
        return None;
    }
    let raw = read_agy_keychain_raw().ok().flatten()?;
    let cred = decode_go_keyring(&raw).ok()?;
    let _g = agy_store_lock();
    let mut store = load_agy_store_locked().ok()?;
    let matched = match_existing_agy_id(&store, &cred)?;
    let now = chrono::Utc::now().timestamp();
    upsert_agy_snapshot(&mut store, cred, now);
    let _ = save_agy_store_locked(&store);
    Some(matched)
}

/// 收录当前系统钥匙串里已登录的 Antigravity 账号，返回快照摘要（不含令牌）
pub fn agy_capture_current_snapshot() -> Result<(String, Option<String>, Option<String>), String> {
    if !agy_keychain_supported() {
        return Err("Antigravity 多账号轮换目前仅支持 macOS".into());
    }
    let raw = read_agy_keychain_raw()?
        .ok_or_else(|| "本机尚未登录 Antigravity 官方账号，请先在终端完成 `agy login`".to_string())?;
    let cred = decode_go_keyring(&raw)?;
    let _g = agy_store_lock();
    let mut store = load_agy_store_locked()?;
    let now = chrono::Utc::now().timestamp();
    let entry = upsert_agy_snapshot(&mut store, cred, now);
    save_agy_store_locked(&store)?;
    Ok((entry.id, entry.email, entry.name))
}

/// 切换系统钥匙串到目标快照（切之前必先把当前钥匙串收回，确保绝不弄丢登录）
pub fn agy_switch_keychain_to(snapshot_id: &str) -> Result<(), String> {
    if !agy_keychain_supported() {
        return Err("Antigravity 多账号轮换目前仅支持 macOS".into());
    }
    let _g = agy_store_lock();
    let mut store = load_agy_store_locked()?;
    // 1. 切之前收回当前钥匙串里的登录态（已收录则更新，未收录也自动收存）
    if let Ok(Some(current_raw)) = read_agy_keychain_raw() {
        if let Ok(current_cred) = decode_go_keyring(&current_raw) {
            let now = chrono::Utc::now().timestamp();
            upsert_agy_snapshot(&mut store, current_cred, now);
            save_agy_store_locked(&store)?;
        }
    }
    let target = store
        .accounts
        .get(snapshot_id)
        .ok_or_else(|| "找不到该 Antigravity 账号快照，请重新登录并收录".to_string())?;
    let encoded = encode_go_keyring(&target.credential)?;
    write_agy_keychain_raw(&encoded)?;
    crate::subscription_quota::cache_invalidate(crate::official_quota::AGY_ROW_ID);
    Ok(())
}

pub fn agy_delete_snapshot(snapshot_id: &str) -> Result<(), String> {
    let _g = agy_store_lock();
    let mut store = load_agy_store_locked()?;
    if store.accounts.remove(snapshot_id).is_some() {
        save_agy_store_locked(&store)?;
    }
    Ok(())
}

pub fn agy_get_snapshot(snapshot_id: &str) -> Option<AgySnapshotEntry> {
    let _g = agy_store_lock();
    let store = load_agy_store_locked().ok()?;
    store.accounts.get(snapshot_id).cloned()
}

#[allow(dead_code)]
pub fn agy_list_snapshots() -> Vec<AgySnapshotEntry> {
    let _g = agy_store_lock();
    load_agy_store_locked()
        .map(|s| s.accounts.into_values().collect())
        .unwrap_or_default()
}

/// 供非激活 Antigravity 账号查余量用：取 access_token，快过期时在本地副本刷新（绝不回写系统钥匙串）
pub async fn agy_access_token_for_quota(snapshot_id: &str) -> Result<String, String> {
    let entry = agy_get_snapshot(snapshot_id)
        .ok_or_else(|| "找不到该 Antigravity 账号凭证，请重新登录收录".to_string())?;
    let now = chrono::Utc::now().timestamp();
    let needs_refresh = match (
        access_token_of(&entry.credential),
        expiry_epoch_secs_of(&entry.credential),
    ) {
        (Some(tok), Some(exp)) if exp - now > TOKEN_REFRESH_MARGIN_SECS => return Ok(tok.to_string()),
        (Some(_), _) => true,
        (None, _) => true,
    };
    if !needs_refresh {
        if let Some(tok) = access_token_of(&entry.credential) {
            return Ok(tok.to_string());
        }
    }
    let refresh_token = refresh_token_of(&entry.credential)
        .ok_or_else(|| "该 Antigravity 账号缺少刷新令牌，请切到它后重新登录".to_string())?
        .to_string();

    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(15));
    let outbound = outbound_env_map();
    let proxy_url = outbound
        .get("HTTPS_PROXY")
        .or_else(|| outbound.get("ALL_PROXY"))
        .or_else(|| outbound.get("HTTP_PROXY"));
    let no_proxy = outbound.get("NO_PROXY").map(String::as_str);
    if let Some(p) = proxy_url {
        if let Ok(proxy) = crate::settings::build_reqwest_proxy(p, no_proxy) {
            builder = builder.proxy(proxy);
        }
    }
    let client = builder
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;
    let secret = AGY_OAUTH_CLIENT_SECRET_PARTS.concat();
    let resp = client
        .post(AGY_OAUTH_TOKEN_URL)
        .form(&[
            ("client_id", AGY_OAUTH_CLIENT_ID),
            ("client_secret", secret.as_str()),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| format!("刷新 Antigravity 令牌失败（请检查出网代理）: {e}"))?;
    let status = resp.status().as_u16();
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 Google 刷新令牌响应失败: {e}"))?;
    if !(200..300).contains(&status) {
        if body.get("error").and_then(|x| x.as_str()) == Some("invalid_grant") {
            let _g = agy_store_lock();
            if let Ok(mut store) = load_agy_store_locked() {
                if let Some(acc) = store.accounts.get_mut(snapshot_id) {
                    acc.requires_reauth = true;
                    let _ = save_agy_store_locked(&store);
                }
            }
            return Err("Antigravity 登录已失效（invalid_grant），请切到该账号重新登录".into());
        }
        return Err(format!("刷新 Antigravity 令牌失败（HTTP {status}）"));
    }
    let new_token = body
        .get("access_token")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Google 响应缺少 access_token".to_string())?
        .to_string();
    let expires_in = body
        .get("expires_in")
        .and_then(|x| x.as_i64())
        .unwrap_or(3600);
    let new_expiry = chrono::Utc::now() + chrono::Duration::seconds(expires_in);
    let new_expiry_rfc3339 = new_expiry.to_rfc3339();

    // 只写回 Mesa 本地副本，绝不回写系统钥匙串
    {
        let _g = agy_store_lock();
        if let Ok(mut store) = load_agy_store_locked() {
            if let Some(acc) = store.accounts.get_mut(snapshot_id) {
                if let Some(tok_obj) = acc
                    .credential
                    .as_object_mut()
                    .and_then(|o| o.get_mut("token"))
                    .and_then(|t| t.as_object_mut())
                {
                    tok_obj.insert("access_token".into(), Value::String(new_token.clone()));
                    tok_obj.insert("expiry".into(), Value::String(new_expiry_rfc3339));
                    tok_obj.insert("expires_in".into(), Value::from(expires_in));
                }
                acc.requires_reauth = false;
                let _ = save_agy_store_locked(&store);
            }
        }
    }
    Ok(new_token)
}

// ===== Antigravity 单活并发护栏注册表 =====

static AGY_ACTIVE_REGISTRY: OnceLock<Mutex<HashMap<String, AgyActiveSessionDto>>> = OnceLock::new();

fn agy_registry() -> std::sync::MutexGuard<'static, HashMap<String, AgyActiveSessionDto>> {
    AGY_ACTIVE_REGISTRY
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

pub fn register_agy_active(
    tab_id: String,
    binding_id: String,
    snapshot_id: Option<String>,
    label: String,
) {
    let mut reg = agy_registry();
    reg.insert(
        tab_id.clone(),
        AgyActiveSessionDto {
            tab_id,
            binding_id,
            snapshot_id,
            label,
        },
    );
}

pub fn unregister_agy_active(tab_id: &str) {
    agy_registry().remove(tab_id);
}

/// 检查切换到目标 `target_snapshot_id`（或默认槽位）时是否存在异号运行中的 agy 官方会话
pub fn check_agy_conflicts(
    target_snapshot_id: Option<&str>,
    exclude_tab_id: Option<&str>,
) -> Vec<AgyActiveSessionDto> {
    let reg = agy_registry();
    reg.values()
        .filter(|s| {
            if exclude_tab_id.is_some_and(|ex| ex == s.tab_id) {
                return false;
            }
            match (s.snapshot_id.as_deref(), target_snapshot_id) {
                (Some(a), Some(b)) => a != b,
                (None, None) => false,
                _ => true,
            }
        })
        .cloned()
        .collect()
}

// ===== Tauri 命令 =====

fn resolve_binding_snapshot_id(binding_id: &str) -> Result<Option<String>, String> {
    let bindings = crate::gateway_store::load_bindings()?;
    let binding = bindings
        .into_iter()
        .find(|b| b.id == binding_id && b.kind == crate::profiles::BindingKind::Official)
        .ok_or_else(|| format!("找不到官方账号绑定: {binding_id}"))?;
    if binding.agent != "agy" {
        return Err("只有 Antigravity 官方账号需要钥匙串切换".into());
    }
    Ok(binding.official_ref.and_then(|r| r.snapshot_id))
}

fn default_login_command(agent: &str) -> Option<String> {
    let spec = crate::agent_specs::agent_spec(agent)?;
    let oa = spec.official_account.as_ref()?;
    Some(
        std::iter::once(spec.binary)
            .chain(oa.login_cmd.iter().copied())
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// 为支持目录隔离的官方 Agent（Claude / Codex / Grok / Kimi / Gemini / CodeBuddy）创建一条隔离目录官方账号绑定，返回新 Profile + 带隔离目录的登录命令
#[tauri::command]
pub async fn official_create_account(
    agent: String,
    name: String,
) -> Result<CreateOfficialAccountResult, String> {
    if !is_isolated_dir_agent(&agent) {
        return Err(format!("{agent} 请使用对应的官方账号接入方式"));
    }
    let clean_name = name.trim().to_string();
    if clean_name.is_empty() {
        return Err("请填写账号备注名（如「个人 Max」「团队号」）".into());
    }
    let dir_id = format!("acc-{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
    let dir = ensure_isolated_dir(&agent, &dir_id)?;
    let official_ref = OfficialAccountRef {
        mode: OfficialAccountMode::IsolatedDir,
        local_dir_id: Some(dir_id),
        snapshot_id: None,
        account_hint: None,
    };
    let store = crate::profiles::ProfileStore::new()?;
    let profile = store.create_official_with_ref(&agent, &clean_name, official_ref)?;
    let login_command = default_login_command(&agent);
    let login_env = login_env_for_isolated(&agent, &dir);
    Ok(CreateOfficialAccountResult {
        profile,
        login_command,
        login_env,
        already_connected: false,
    })
}

fn capture_agy_binding_with_store(
    store: &crate::profiles::ProfileStore,
    snapshot_id: String,
    email: Option<String>,
    display_name: Option<String>,
    name: Option<&str>,
) -> Result<crate::profiles::Profile, String> {
    let hint = email.clone().or(display_name);
    let chosen_name = name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            email
                .as_deref()
                .and_then(|e| e.split('@').next())
                .map(|p| format!("Antigravity · {p}"))
        })
        .unwrap_or_else(|| "Antigravity 官方号".to_string());

    let bindings = crate::gateway_store::load_bindings()?;
    if let Some(existing) = bindings.into_iter().find(|b| {
        b.agent == "agy"
            && b.kind == crate::profiles::BindingKind::Official
            && b.official_ref
                .as_ref()
                .and_then(|r| r.snapshot_id.as_deref())
                == Some(snapshot_id.as_str())
    }) {
        // 已收录：刷新备注与 account_hint
        return store.update_official_meta(
            &existing.id,
            name.map(str::trim).filter(|s| !s.is_empty()),
            hint.as_deref(),
        );
    }

    let official_ref = OfficialAccountRef {
        mode: OfficialAccountMode::ManagedSnapshot,
        local_dir_id: None,
        snapshot_id: Some(snapshot_id),
        account_hint: hint,
    };
    // 若原先只有一条裸默认「官方账号」，首次收录直接原地升级为托管号（保留 ID、模型与所有引用，避免留出重叠默认行）
    if let Some(upgraded) =
        store.upgrade_default_official_to_ref("agy", &chosen_name, official_ref.clone())?
    {
        return Ok(upgraded);
    }
    store.create_official_with_ref("agy", &chosen_name, official_ref)
}

/// 收录本机当前已登录的 Antigravity 官方账号为托管官方绑定（若已收录则更新提示；若有裸默认官方号则原地升级）
#[tauri::command]
pub async fn official_capture_agy_current(
    name: Option<String>,
) -> Result<CreateOfficialAccountResult, String> {
    let (snapshot_id, email, display_name) =
        tauri::async_runtime::spawn_blocking(agy_capture_current_snapshot)
            .await
            .map_err(|e| format!("收录 Antigravity 账号失败: {e}"))??;
    crate::agents::invalidate_official_status_cache("agy");
    let store = crate::profiles::ProfileStore::new()?;
    let profile = capture_agy_binding_with_store(
        &store,
        snapshot_id,
        email,
        display_name,
        name.as_deref(),
    )?;
    crate::subscription_quota::cache_invalidate(crate::official_quota::AGY_ROW_ID);
    Ok(CreateOfficialAccountResult {
        profile,
        login_command: default_login_command("agy"),
        login_env: outbound_env_map(),
        already_connected: true,
    })
}

/// 批量查询某个 Agent 所有官方绑定的状态（默认号 + 隔离号 / agy 托管号）
#[tauri::command]
pub async fn official_bindings_status(agent_id: String) -> Vec<OfficialBindingStatusDto> {
    tauri::async_runtime::spawn_blocking(move || official_bindings_status_sync(&agent_id))
        .await
        .unwrap_or_default()
}

pub fn official_bindings_status_sync(agent_id: &str) -> Vec<OfficialBindingStatusDto> {
    let Ok(bindings) = crate::gateway_store::load_bindings() else {
        return Vec::new();
    };
    let default_status = crate::agents::official_account_status_sync_pub(agent_id);
    let agy_active = if agent_id == "agy" {
        agy_active_snapshot_id()
    } else {
        None
    };
    let mut out = Vec::new();
    for b in bindings {
        if b.agent != agent_id || b.kind != crate::profiles::BindingKind::Official {
            continue;
        }
        let mode = b
            .official_ref
            .as_ref()
            .map(|r| r.mode.clone())
            .unwrap_or(OfficialAccountMode::Default);
        let display_name = if b.name.trim().is_empty() {
            "官方账号".to_string()
        } else {
            b.name.clone()
        };
        match mode {
            OfficialAccountMode::Default => {
                out.push(OfficialBindingStatusDto {
                    binding_id: b.id,
                    agent: b.agent,
                    name: display_name,
                    mode,
                    connected: default_status.connected,
                    detail: default_status.detail.clone(),
                    email: default_status.email.clone(),
                    plan: default_status.plan.clone(),
                    is_active_slot: if agent_id == "agy" {
                        Some(agy_active.is_none() && default_status.connected)
                    } else {
                        None
                    },
                    login_command: default_status.login_command.clone(),
                    login_env: default_status.login_env.clone(),
                    isolated_dir: None,
                });
            }
            OfficialAccountMode::IsolatedDir => {
                let dir_id = b
                    .official_ref
                    .as_ref()
                    .and_then(|r| r.local_dir_id.as_deref());
                let dir = dir_id.and_then(|id| isolated_dir_path(agent_id, id).ok());
                let (connected, email, plan) = match (agent_id, dir.as_deref()) {
                    ("claude-code", Some(d)) => probe_isolated_claude(d),
                    ("codex", Some(d)) => probe_isolated_codex(d),
                    ("grok", Some(d)) => probe_isolated_grok(d),
                    ("kimi", Some(d)) => probe_isolated_kimi(d),
                    ("gemini", Some(d)) => probe_isolated_gemini(d),
                    ("codebuddy", Some(d)) => probe_isolated_codebuddy(d),
                    _ => (false, None, None),
                };
                let login_env = dir
                    .as_deref()
                    .map(|d| login_env_for_isolated(agent_id, d))
                    .unwrap_or_else(outbound_env_map);
                out.push(OfficialBindingStatusDto {
                    binding_id: b.id,
                    agent: b.agent,
                    name: display_name,
                    mode,
                    connected,
                    detail: Some(if connected {
                        "已登录独立隔离账号".into()
                    } else {
                        "尚未登录：点击登录后在终端完成认证".into()
                    }),
                    email: email.or_else(|| {
                        b.official_ref.as_ref().and_then(|r| r.account_hint.clone())
                    }),
                    plan,
                    is_active_slot: None,
                    login_command: default_login_command(agent_id),
                    login_env,
                    isolated_dir: dir.map(|d| d.to_string_lossy().to_string()),
                });
            }
            OfficialAccountMode::ManagedSnapshot => {
                let sid = b
                    .official_ref
                    .as_ref()
                    .and_then(|r| r.snapshot_id.as_deref());
                let entry = sid.and_then(agy_get_snapshot);
                let connected = entry.as_ref().is_some_and(|e| !e.requires_reauth);
                let is_active = sid.is_some() && agy_active.as_deref() == sid;
                let email = entry
                    .as_ref()
                    .and_then(|e| e.email.clone())
                    .or_else(|| b.official_ref.as_ref().and_then(|r| r.account_hint.clone()));
                out.push(OfficialBindingStatusDto {
                    binding_id: b.id,
                    agent: b.agent,
                    name: display_name,
                    mode,
                    connected,
                    detail: Some(if entry.is_none() {
                        "本机未找到该账号快照，请重新登录并收录".into()
                    } else if !connected {
                        "登录已失效，请切到该账号后重新 `agy login`".into()
                    } else if is_active {
                        "当前系统钥匙串正激活此账号".into()
                    } else {
                        "已收录（切换或发起会话时自动切钥匙串）".into()
                    }),
                    email,
                    plan: None,
                    is_active_slot: Some(is_active),
                    login_command: default_login_command(agent_id),
                    login_env: outbound_env_map(),
                    isolated_dir: None,
                });
            }
        }
    }
    out
}

/// 检查激活某个 Antigravity 官方绑定是否与正在运行的其他 agy 官方会话冲突
#[tauri::command]
pub fn official_agy_check_conflicts(
    binding_id: String,
    exclude_tab_id: Option<String>,
) -> Result<Vec<AgyActiveSessionDto>, String> {
    let target = resolve_binding_snapshot_id(&binding_id)?;
    Ok(check_agy_conflicts(
        target.as_deref(),
        exclude_tab_id.as_deref(),
    ))
}

/// 激活指定 Antigravity 托管官方账号（写入系统钥匙串，写入前必收回当前号）
#[tauri::command]
pub async fn official_agy_activate(
    binding_id: String,
    exclude_tab_id: Option<String>,
) -> Result<(), String> {
    let target = resolve_binding_snapshot_id(&binding_id)?;
    let conflicts = check_agy_conflicts(target.as_deref(), exclude_tab_id.as_deref());
    if !conflicts.is_empty() {
        return Err(format!(
            "还有 {} 个 Antigravity 官方会话正在使用其他账号，请先停止它们再切换",
            conflicts.len()
        ));
    }
    let Some(sid) = target else {
        // Default 槽位无需写钥匙串
        return Ok(());
    };
    let res = tauri::async_runtime::spawn_blocking(move || agy_switch_keychain_to(&sid))
        .await
        .map_err(|e| format!("切换 Antigravity 账号失败: {e}"))?;
    if res.is_ok() {
        crate::agents::invalidate_official_status_cache("agy");
    }
    res
}

#[tauri::command]
pub fn official_agy_register_session(
    tab_id: String,
    binding_id: String,
    label: String,
) -> Result<(), String> {
    let snapshot_id = resolve_binding_snapshot_id(&binding_id).ok().flatten();
    register_agy_active(tab_id, binding_id, snapshot_id, label);
    Ok(())
}

#[tauri::command]
pub fn official_agy_unregister_session(tab_id: String) {
    unregister_agy_active(&tab_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_local_dir_id_rejects_traversal() {
        assert!(validate_local_dir_id("acc-1234abcd").is_ok());
        assert!(validate_local_dir_id("work_2").is_ok());
        assert!(validate_local_dir_id("").is_err());
        assert!(validate_local_dir_id("../etc").is_err());
        assert!(validate_local_dir_id("a/b").is_err());
        assert!(validate_local_dir_id("a b").is_err());
    }

    /// 实机：查得到本机钥匙串 / 凭据管理器里 Antigravity 那一项的有无（没登录时应为 Some(false)）。
    /// `cargo test --lib agy_credential_present_os_real -- --ignored --nocapture`
    #[test]
    #[ignore = "读本机钥匙串 / 凭据管理器"]
    fn agy_credential_present_os_real() {
        let got = agy_credential_present_os();
        eprintln!("Antigravity 登录凭据：{got:?}");
        if cfg!(any(target_os = "macos", windows)) {
            assert!(got.is_some(), "macOS / Windows 上应查得出有无");
        }
    }

    #[test]
    fn go_keyring_roundtrip_and_plain_json() {
        let cred = serde_json::json!({
            "token": { "access_token": "ya29.test", "refresh_token": "1//ref" },
            "id_token_email": "alice@example.com"
        });
        let encoded = encode_go_keyring(&cred).unwrap();
        assert!(encoded.starts_with(GO_KEYRING_PREFIX));
        assert_eq!(decode_go_keyring(&encoded).unwrap(), cred);
        // 兼容无前缀的裸 JSON
        assert_eq!(decode_go_keyring(&cred.to_string()).unwrap(), cred);
    }

    #[test]
    fn agy_identity_and_upsert_preserves_existing_id() {
        let mut store = AgySnapshotFile {
            version: 1,
            accounts: BTreeMap::new(),
        };
        let payload = URL_SAFE_NO_PAD
            .encode(r#"{"sub":"sub-001","email":"alice@gmail.com","name":"Alice"}"#);
        let cred_v14 = serde_json::json!({
            "token": { "access_token": "tok1", "refresh_token": "ref-same" },
            "id_token": format!("hdr.{payload}.sig")
        });
        let e1 = upsert_agy_snapshot(&mut store, cred_v14, 1000);
        assert_eq!(e1.id, "sub-001");
        assert_eq!(e1.email.as_deref(), Some("alice@gmail.com"));

        // 模拟 agy 1.5 续期后去掉了 id_token，只剩 refresh_token 与 id_token_email
        let cred_v15 = serde_json::json!({
            "token": { "access_token": "tok2", "refresh_token": "ref-same" },
            "id_token_email": "alice@gmail.com"
        });
        let e2 = upsert_agy_snapshot(&mut store, cred_v15, 2000);
        assert_eq!(e2.id, "sub-001");
        assert_eq!(store.accounts.len(), 1);
        assert_eq!(access_token_of(&e2.credential), Some("tok2"));
    }

    #[test]
    fn agy_conflict_guard_allows_same_account_and_blocks_other() {
        let t1 = format!("test-tab-1-{}", uuid::Uuid::new_v4());
        let t2 = format!("test-tab-2-{}", uuid::Uuid::new_v4());
        register_agy_active(t1.clone(), "b1".into(), Some("sub-a".into()), "A号".into());
        // 同号多开不冲突
        assert!(check_agy_conflicts(Some("sub-a"), None).is_empty());
        // 切异号冲突，且列出 t1
        let c = check_agy_conflicts(Some("sub-b"), None);
        assert!(c.iter().any(|x| x.tab_id == t1));
        // 排除自己不冲突
        assert!(check_agy_conflicts(Some("sub-b"), Some(&t1)).is_empty());
        register_agy_active(t2.clone(), "b2".into(), None, "默认".into());
        assert!(check_agy_conflicts(Some("sub-a"), None)
            .iter()
            .any(|x| x.tab_id == t2));
        unregister_agy_active(&t1);
        unregister_agy_active(&t2);
    }

    #[test]
    fn probe_isolated_codex_reads_jwt_email_and_plan() {
        let dir = std::env::temp_dir().join(format!("mesa-codex-iso-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let payload = URL_SAFE_NO_PAD.encode(
            r#"{"email":"bob@openai.test","https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}"#,
        );
        let auth = serde_json::json!({
            "tokens": {
                "access_token": "acc-tok",
                "id_token": format!("hdr.{payload}.sig")
            }
        });
        std::fs::write(dir.join("auth.json"), auth.to_string()).unwrap();
        let (ok, email, plan) = probe_isolated_codex(&dir);
        assert!(ok);
        assert_eq!(email.as_deref(), Some("bob@openai.test"));
        assert_eq!(plan.as_deref(), Some("plus"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_isolated_grok_kimi_gemini_codebuddy() {
        let base = std::env::temp_dir().join(format!("mesa-multi-iso-{}", uuid::Uuid::new_v4()));
        // Grok
        let grok_dir = base.join("grok");
        std::fs::create_dir_all(&grok_dir).unwrap();
        std::fs::write(
            grok_dir.join("auth.json"),
            r#"{"https://auth.x.ai::client1":{"key":"grok-tok","refresh_token":"rt"}}"#,
        )
        .unwrap();
        assert!(probe_isolated_grok(&grok_dir).0);

        // Kimi
        let kimi_dir = base.join("kimi");
        std::fs::create_dir_all(kimi_dir.join("credentials")).unwrap();
        std::fs::write(
            kimi_dir.join("credentials").join("kimi-code.json"),
            r#"{"access_token":"km-tok","refresh_token":"km-rt"}"#,
        )
        .unwrap();
        assert!(probe_isolated_kimi(&kimi_dir).0);

        // Gemini (under .gemini/)
        let gem_dir = base.join("gemini");
        std::fs::create_dir_all(gem_dir.join(".gemini")).unwrap();
        let payload = URL_SAFE_NO_PAD.encode(r#"{"email":"gem@google.test"}"#);
        std::fs::write(
            gem_dir.join(".gemini").join("oauth_creds.json"),
            format!(r#"{{"access_token":"g-tok","id_token":"h.{payload}.s"}}"#),
        )
        .unwrap();
        let (g_ok, g_email, _) = probe_isolated_gemini(&gem_dir);
        assert!(g_ok);
        assert_eq!(g_email.as_deref(), Some("gem@google.test"));

        // CodeBuddy
        let cb_dir = base.join("codebuddy");
        std::fs::create_dir_all(&cb_dir).unwrap();
        std::fs::write(
            cb_dir.join(".credentials.json"),
            r#"{"oauth":{"accessToken":"cb-tok"},"email":"dev@tencent.test"}"#,
        )
        .unwrap();
        let (cb_ok, cb_email, _) = probe_isolated_codebuddy(&cb_dir);
        assert!(cb_ok);
        assert_eq!(cb_email.as_deref(), Some("dev@tencent.test"));

        // Env var mapping
        let kimi_env = login_env_for_isolated("kimi", &kimi_dir);
        assert_eq!(
            kimi_env.get("KIMI_CODE_HOME").map(String::as_str),
            Some(kimi_dir.to_string_lossy().as_ref())
        );
        assert!(kimi_env.contains_key("KIMI_SHARE_DIR"));
        assert!(login_env_for_isolated("grok", &grok_dir).contains_key("GROK_HOME"));
        assert!(login_env_for_isolated("gemini", &gem_dir).contains_key("GEMINI_CLI_HOME"));
        assert!(login_env_for_isolated("codebuddy", &cb_dir).contains_key("CODEBUDDY_CONFIG_DIR"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn agy_first_capture_upgrades_default_official_in_place_and_blocks_duplicate_default() {
        let dir = std::env::temp_dir().join(format!("mesa-agy-upgrade-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = crate::profiles::ProfileStore::new_for_test(&dir);

        // 1. 先建一条裸默认「官方账号」（带用户选好的模型与环境变量）
        let mut extra = HashMap::new();
        extra.insert("CUSTOM_FLAG".to_string(), "1".to_string());
        let default_prof = store
            .create(crate::profiles::ProfileInput {
                agent: "agy".into(),
                name: "官方账号".into(),
                account_type: crate::profiles::AccountType::Official,
                no_auth: false,
                protocol: None,
                api_backend: None,
                base_url: None,
                models: vec!["gemini-4-neon-high".into()],
                role_models: None,
                extra_env: extra,
                request_policy: Default::default(),
                api_key: None,
                expected_gateway_revision: None,
            })
            .unwrap();

        // 2. 首次收录第一个 Antigravity 账号：应原地升级原 Default 绑定（保留 ID、模型、env，不留多余裸官方账号）
        let first = capture_agy_binding_with_store(
            &store,
            "sub-first".into(),
            Some("tongzhouhong@gmail.com".into()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(first.id, default_prof.id);
        assert_eq!(first.name, "Antigravity · tongzhouhong");
        assert_eq!(first.models, vec!["gemini-4-neon-high"]);
        assert_eq!(first.extra_env.get("CUSTOM_FLAG").map(String::as_str), Some("1"));
        assert_eq!(
            first.official_ref.as_ref().map(|r| &r.mode),
            Some(&OfficialAccountMode::ManagedSnapshot)
        );
        assert_eq!(
            first.official_ref.as_ref().and_then(|r| r.snapshot_id.as_deref()),
            Some("sub-first")
        );
        assert_eq!(store.list().unwrap().len(), 1);

        // 3. 再收录第二个账号：新增一条托管绑定，总数变为 2
        let second = capture_agy_binding_with_store(
            &store,
            "sub-second".into(),
            Some("tzhong911425@gmail.com".into()),
            None,
            None,
        )
        .unwrap();
        assert_ne!(second.id, first.id);
        assert_eq!(second.name, "Antigravity · tzhong911425");
        assert_eq!(store.list().unwrap().len(), 2);

        // 4. 重复收录第一个账号：只更新元信息，不新建第三条
        let refreshed = capture_agy_binding_with_store(
            &store,
            "sub-first".into(),
            Some("tongzhouhong@gmail.com".into()),
            None,
            Some("主号"),
        )
        .unwrap();
        assert_eq!(refreshed.id, first.id);
        assert_eq!(refreshed.name, "主号");
        assert_eq!(store.list().unwrap().len(), 2);

        // 5. 已有托管号时禁止再建裸默认「官方账号」，防再次出现重叠行
        let dup_err = store
            .create(crate::profiles::ProfileInput {
                agent: "agy".into(),
                name: "官方账号".into(),
                account_type: crate::profiles::AccountType::Official,
                no_auth: false,
                protocol: None,
                api_backend: None,
                base_url: None,
                models: vec![],
                role_models: None,
                extra_env: HashMap::new(),
                request_policy: Default::default(),
                api_key: None,
                expected_gateway_revision: None,
            })
            .unwrap_err();
        assert!(dup_err.contains("添加官方号"));

        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
