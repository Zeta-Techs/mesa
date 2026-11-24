//! 订阅余量卡的官方账号行（2026-10-31，2026-11-15 补入 Antigravity CLI 与 Claude 死令牌显式提示）：
//! Claude Code 登录的 Claude 订阅（Pro / Max）、Codex 登录的 ChatGPT 套餐、Antigravity CLI 登录的 Google 账号。
//! 与网关行共用 `subscription_quota` 的 DTO、2 分钟缓存与失败回落；接口口径参照
//! `.reference/paseo` 的 claude-usage-source / codex-usage-source 与 `.reference/cc-switch` subscription_agy。
//! - Claude：凭证只读 CLI 自己的登录存储——macOS 钥匙串 `Claude Code-credentials`（设了 CLAUDE_CONFIG_DIR 时
//!   服务名追加目录 sha256 前 8 位），先带账户名查、再不带账户名查（本机实测另有一项只装 mcpOAuth，不带账户名
//!   先命中它）；其他平台读 `{配置目录}/.credentials.json`。若用户登录过且未手动退出（`claude auth logout` 会删条目），
//!   但 Claude Code 因 `invalid_grant` 把 `accessToken`/`refreshToken` 清空并置 `expiresAt=0`，仍保留该行并如实提示去连接页重登，不静默消失。
//!   GET https://api.anthropic.com/api/oauth/usage（Bearer + `anthropic-beta: oauth-2025-04-20`）：
//!   five_hour / seven_day 的 utilization（0-100）+ resets_at（ISO，5 小时窗没开始时为 null）。
//! - Codex：`{CODEX_HOME|~/.codex}/auth.json` 的 tokens.access_token（+ account_id 头）；若 `auth.json` 因第三方直连切换被
//!   `cc-switch` 暂存移走（`~/.cc-switch/codex-login-stash.json` 的 `logins[last]`，用户并未退出登录），只读回落到该暂存条目；
//!   API Key 模式无 tokens 字段，不出行。
//!   GET https://chatgpt.com/backend-api/wham/usage：rate_limit.primary_window / secondary_window 的
//!   used_percent + reset_at（秒）+ limit_window_seconds，按窗长归 5 小时 / 周 / 月（免费档实测只有 30 天窗）。
//! - Antigravity CLI（agy）：不直接读钥匙串（免弹窗、免碰令牌），调官方内置 `agy --print /usage --output-format json`
//!   （0 token、不建会话，清掉 GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL 防切到 Key 模式，带出网代理）。
//!   仅解析其自身 Gemini 额度桶（5 小时 / 本周 / Argon 本周），不混入第三方 Claude/GPT 桶（2026-11-15 用户拍板）。
//! - Codex 重置卡（2026-10-31）：GET wham/rate-limit-reset-credits 列卡（credits[] 的 id / status / expires_at，
//!   不信 available_count，只数 status==available 且没过期的；cc-switch 同口径），wham/usage 的
//!   rate_limit_reset_credits.applicable_available_count 是「此刻能用」的张数——没被限额卡住时恒 0。
//!   用卡 POST wham/rate-limit-reset-credits/consume，body {credit_id, redeem_request_id}（codex2api / ai-tools-mng 两家实现一致；
//!   redeem_request_id 是幂等键）。消费性写操作：只经显式命令 + 前端确认触发，挑最早过期的那张；此刻用不了时不发请求。
//! 纪律：令牌只在本模块内存里经过，不进 DTO / 日志；**绝不刷新、绝不回写**——令牌过期就请用户跑一次 CLI 或重新登录，
//! 由 CLI 自己续期（刷新会轮换令牌，等于改 CLI 的登录存储）。查询走设置里的出网代理（与官方账号启动同源），
//! 没配就按系统环境直连。

use crate::subscription_quota::{
    cache_get, now_ms, settle_fresh, PlanQuotaDto, PlanQuotaWindowDto, PlanResetCardsDto,
    WINDOW_FIVE_HOUR, WINDOW_MONTHLY, WINDOW_WEEKLY,
};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA: &str = "oauth-2025-04-20";
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const AGY_USAGE_TIMEOUT: Duration = Duration::from_secs(15);

const CLAUDE_ROW_ID: &str = "official:claude-code";
const CLAUDE_ROW_PREFIX: &str = "official:claude-code:";
pub(crate) const CODEX_ROW_ID: &str = "official:codex";
pub(crate) const CODEX_ROW_PREFIX: &str = "official:codex:";
pub(crate) const AGY_ROW_ID: &str = "official:agy";
const AGY_ROW_PREFIX: &str = "official:agy:";
const AGY_CLOUDCODE_API_BASE: &str = "https://daily-cloudcode-pa.googleapis.com/v1internal";
const AGY_CONSOLE_URL: &str = "https://antigravity.google";
const GROK_ROW_ID: &str = "official:grok";
const GROK_ROW_PREFIX: &str = "official:grok:";
const GROK_BILLING_ENDPOINT: &str =
    "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const GROK_SETTINGS_ENDPOINT: &str = "https://cli-chat-proxy.grok.com/v1/settings";
const GROK_CONSOLE_URL: &str = "https://grok.com";
const KIMI_ROW_ID: &str = "official:kimi";
const KIMI_ROW_PREFIX: &str = "official:kimi:";
const KIMI_DEFAULT_BASE_URL: &str = "https://api.kimi.com/coding/v1";
const KIMI_CN_CONSOLE_URL: &str = "https://www.kimi.com/code/console";
const KIMI_GLOBAL_CONSOLE_URL: &str = "https://www.kimi.ai/code/console";
const WINDOW_CREDITS: &str = "credits";
const ROW_NAME: &str = "官方账号";

/// 未检测到 agy 官方登录时的负缓存截止毫秒（2 分钟，force 强刷时跳过），免得只用 API Key 的用户每次进页都拉起一次 agy
static AGY_ABSENT_UNTIL: AtomicI64 = AtomicI64::new(0);

struct ClaudeCreds {
    /// 空串表示用户登录过且未执行 logout，但 Claude Code 因刷新被拒（invalid_grant）清空了本地令牌
    token: String,
    expires_at: Option<i64>,
    plan: Option<String>,
}

struct CodexCreds {
    token: String,
    account_id: Option<String>,
}

// ===== 凭证（只读） =====

/// 钥匙串项里的 JSON → 凭证；只认 claudeAiOauth（另一项只有 mcpOAuth，不算）。
/// 用户真正执行 `claude auth logout` 时 Claude Code 会删除钥匙串条目；若 `claudeAiOauth` 仍在且留有
/// 套餐或 `sign_in` 来源、而 `accessToken` 被置空（`expiresAt == 0`，2.1.x 在 `invalid_grant` 时的死令牌清理），
/// 说明用户并未手动退出登录，保留条目以便界面如实说明原因而非静默消失。
fn parse_claude_creds(text: &str) -> Option<ClaudeCreds> {
    let v: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    let oa = v.get("claudeAiOauth")?;
    let plan = claude_plan_label(
        oa.get("subscriptionType").and_then(|x| x.as_str()),
        oa.get("rateLimitTier").and_then(|x| x.as_str()),
    );
    let expires_at = oa.get("expiresAt").and_then(|x| x.as_i64());
    let token = oa
        .get("accessToken")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if token.is_empty() {
        let had_signin = expires_at == Some(0)
            || plan.is_some()
            || oa.get("subscriptionTypeSource").and_then(|x| x.as_str()) == Some("sign_in");
        if !had_signin {
            return None;
        }
        return Some(ClaudeCreds {
            token: String::new(),
            expires_at,
            plan,
        });
    }
    Some(ClaudeCreds {
        token,
        expires_at,
        plan,
    })
}

/// pro → Pro；max + default_claude_max_20x → Max 20x（档位只在以「数字x」结尾时追加）
fn claude_plan_label(sub: Option<&str>, tier: Option<&str>) -> Option<String> {
    let sub = sub.map(str::trim).filter(|s| !s.is_empty())?;
    let mut label = capitalize(sub);
    if let Some(t) = tier.and_then(|t| t.rsplit('_').next()) {
        let digits = t.strip_suffix('x').unwrap_or("");
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            label.push(' ');
            label.push_str(t);
        }
    }
    Some(label)
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
/// 钥匙串服务名：设了 CLAUDE_CONFIG_DIR 时 Claude Code 追加 `-{sha256(目录) 前 8 位}`（paseo 对 2.1.59 cli.js 的实证）
fn claude_keychain_service(config_dir: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    match config_dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) => {
            let hash = Sha256::digest(dir.as_bytes());
            let hex: String = hash.iter().take(4).map(|b| format!("{b:02x}")).collect();
            format!("{CLAUDE_KEYCHAIN_SERVICE}-{hex}")
        }
        None => CLAUDE_KEYCHAIN_SERVICE.to_string(),
    }
}

#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
/// 钥匙串账户名：Claude Code 用登录名，含特殊字符时退成 claude-code-user
fn claude_keychain_account(user: &str) -> String {
    if !user.is_empty() && user.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        user.to_string()
    } else {
        "claude-code-user".to_string()
    }
}

#[cfg(target_os = "macos")]
fn security_password(args: &[&str]) -> Option<String> {
    let mut child = crate::process::background_command("/usr/bin/security")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return None,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(_) => return None,
        }
    }
    let out = child.wait_with_output().ok()?;
    String::from_utf8(out.stdout).ok()
}

#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn claude_keychain_service_for_dir(config_dir: Option<&str>) -> String {
    claude_keychain_service(config_dir)
}

/// 读指定 Claude 配置目录的登录凭证（`config_dir == None` 走默认环境 + 家目录；`Some(dir)` 走该隔离目录）
fn read_claude_creds_for_dir(config_dir: Option<&std::path::Path>) -> Option<ClaudeCreds> {
    if cfg!(test) {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        let dir_str = match config_dir {
            Some(d) => Some(d.to_string_lossy().into_owned()),
            None => std::env::var("CLAUDE_CONFIG_DIR").ok(),
        };
        let service = claude_keychain_service(dir_str.as_deref());
        let account = claude_keychain_account(&std::env::var("USER").unwrap_or_default());
        let lookups: [Vec<&str>; 2] = [
            vec!["find-generic-password", "-a", &account, "-w", "-s", &service],
            vec!["find-generic-password", "-w", "-s", &service],
        ];
        for args in &lookups {
            if let Some(creds) = security_password(args).as_deref().and_then(parse_claude_creds) {
                return Some(creds);
            }
        }
    }
    let root = match config_dir {
        Some(d) => d.to_path_buf(),
        None => crate::agent_specs::agent_config_root("claude-code")?,
    };
    let path = root.join(".credentials.json");
    parse_claude_creds(&std::fs::read_to_string(path).ok()?)
}

/// 供 official_accounts 探测隔离 CLAUDE_CONFIG_DIR 是否已登录及套餐名（令牌绝不外泄）
pub(crate) fn probe_claude_dir(dir: &std::path::Path) -> Option<(bool, Option<String>)> {
    let creds = read_claude_creds_for_dir(Some(dir))?;
    Some((!creds.token.is_empty(), creds.plan))
}

/// 读 Claude Code 默认登录凭证（阻塞：macOS 要跑 security），读不到返回 None
fn read_claude_creds() -> Option<ClaudeCreds> {
    read_claude_creds_for_dir(None)
}

fn parse_codex_creds_value(v: &serde_json::Value) -> Option<CodexCreds> {
    let tokens = v.get("tokens")?;
    let token = tokens.get("access_token")?.as_str()?.trim().to_string();
    if token.is_empty() {
        return None;
    }
    Some(CodexCreds {
        token,
        account_id: tokens
            .get("account_id")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    })
}

/// Codex auth.json → 凭证；API Key 模式（只有 OPENAI_API_KEY）返回 None
fn parse_codex_creds(text: &str) -> Option<CodexCreds> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    parse_codex_creds_value(&v)
}

/// `~/.cc-switch/codex-login-stash.json` → 凭证：直连切到第三方时 cc-switch 把原生 `auth.json` 暂存在
/// `logins[last]`，只有真在 Codex 里退出登录时才清空 `last`（登出不复活）。只读回落，绝不回写。
fn parse_codex_stash(text: &str) -> Option<CodexCreds> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let last = v.get("last")?.as_str()?.trim();
    if last.is_empty() {
        return None;
    }
    parse_codex_creds_value(v.get("logins")?.get(last)?)
}

/// 读指定 Codex 目录的 auth.json（`codex_home == None` 走默认目录 + cc-switch stash 回落；隔离目录不回落 stash）
fn read_codex_creds_for_dir(codex_home: Option<&std::path::Path>) -> Option<CodexCreds> {
    if cfg!(test) {
        return None;
    }
    if let Some(dir) = codex_home {
        let text = std::fs::read_to_string(dir.join("auth.json")).ok()?;
        return parse_codex_creds(&text);
    }
    if let Some(root) = crate::agent_specs::agent_config_root("codex") {
        if let Ok(text) = std::fs::read_to_string(root.join("auth.json")) {
            if let Some(creds) = parse_codex_creds(&text) {
                return Some(creds);
            }
        }
    }
    let stash = crate::dirs::home_dir()?.join(".cc-switch/codex-login-stash.json");
    parse_codex_stash(&std::fs::read_to_string(stash).ok()?)
}

fn read_codex_creds() -> Option<CodexCreds> {
    read_codex_creds_for_dir(None)
}

// ===== 响应解析（纯函数） =====

fn iso_ms(v: Option<&serde_json::Value>) -> Option<i64> {
    let s = v?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

fn window_dto(window: &str, used_percent: f64, resets_at: Option<i64>) -> PlanQuotaWindowDto {
    PlanQuotaWindowDto {
        window: window.into(),
        used_percent: used_percent.max(0.0),
        resets_at,
        used: None,
        total: None,
    }
}

/// Claude：five_hour → 5 小时、seven_day → 本周；两个都没有算解析失败（不是「没用量」）
fn parse_claude_usage(body: &serde_json::Value) -> Result<Vec<PlanQuotaWindowDto>, String> {
    let mut out = Vec::new();
    for (field, window) in [("five_hour", WINDOW_FIVE_HOUR), ("seven_day", WINDOW_WEEKLY)] {
        let Some(w) = body.get(field).filter(|w| w.is_object()) else {
            continue;
        };
        let Some(pct) = w.get("utilization").and_then(|x| x.as_f64()) else {
            continue;
        };
        out.push(window_dto(window, pct, iso_ms(w.get("resets_at"))));
    }
    if out.is_empty() {
        return Err("Claude 用量接口的返回里没有 5 小时 / 本周额度".into());
    }
    Ok(out)
}

/// Codex 窗长 → 卡上的窗口名；不在三档附近的窗不展示。窗长缺失时按老口径：主窗 5 小时、副窗本周
fn codex_window_kind(seconds: Option<f64>, primary: bool) -> Option<&'static str> {
    match seconds {
        Some(s) if s <= 0.0 => None,
        Some(s) if s <= 8.0 * 3600.0 => Some(WINDOW_FIVE_HOUR),
        Some(s) if s <= 10.0 * 86400.0 => Some(WINDOW_WEEKLY),
        Some(s) if s <= 40.0 * 86400.0 => Some(WINDOW_MONTHLY),
        Some(_) => None,
        None if primary => Some(WINDOW_FIVE_HOUR),
        None => Some(WINDOW_WEEKLY),
    }
}

/// Codex：rate_limit 的主 / 副两窗；同名窗只留第一个。返回 (套餐, 窗口)
/// wham/usage 里「此刻能用的重置卡张数」；不报就 None
fn codex_applicable_cards(body: &serde_json::Value) -> Option<u32> {
    body.get("rate_limit_reset_credits")?
        .get("applicable_available_count")?
        .as_u64()
        .map(|n| n as u32)
}

/// wham/rate-limit-reset-credits → 可用卡（id, 过期毫秒），先过期的排前面、不过期的排最后。
/// 缺 credits 数组算解析失败（截断的响应不当成 0 张）
fn parse_codex_reset_credits(body: &serde_json::Value, now: i64) -> Result<Vec<(String, Option<i64>)>, String> {
    let list = body
        .get("credits")
        .and_then(|c| c.as_array())
        .ok_or_else(|| "重置卡列表的返回不完整".to_string())?;
    let mut cards: Vec<(String, Option<i64>)> = list
        .iter()
        .filter(|c| c.get("status").and_then(|s| s.as_str()) == Some("available"))
        .filter_map(|c| {
            let id = c.get("id")?.as_str()?.trim().to_string();
            if id.is_empty() {
                return None;
            }
            let exp = c.get("expires_at").and_then(|v| v.as_str()).map(|raw| {
                chrono::DateTime::parse_from_rfc3339(raw).ok().map(|d| d.timestamp_millis())
            });
            match exp {
                // 已过期的不算
                Some(Some(at)) if at <= now => None,
                // 认不出的到期时间当作不过期：宁可多显示一张也不吞掉
                Some(at) => Some((id, at)),
                None => Some((id, None)),
            }
        })
        .collect();
    cards.sort_by_key(|(_, at)| (at.is_none(), *at));
    Ok(cards)
}

fn parse_codex_usage(
    body: &serde_json::Value,
    now: i64,
) -> Result<(Option<String>, Vec<PlanQuotaWindowDto>), String> {
    let plan = body
        .get("plan_type")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(capitalize);
    let Some(rl) = body.get("rate_limit").filter(|x| x.is_object()) else {
        return Err("Codex 用量接口的返回里没有额度窗口".into());
    };
    let mut out: Vec<PlanQuotaWindowDto> = Vec::new();
    for (slot, primary) in [("primary_window", true), ("secondary_window", false)] {
        let Some(w) = rl.get(slot).filter(|x| x.is_object()) else {
            continue;
        };
        let Some(pct) = w.get("used_percent").and_then(|x| x.as_f64()) else {
            continue;
        };
        let Some(kind) = codex_window_kind(w.get("limit_window_seconds").and_then(|x| x.as_f64()), primary)
        else {
            continue;
        };
        if out.iter().any(|o| o.window == kind) {
            continue;
        }
        let resets_at = w
            .get("reset_at")
            .and_then(|x| x.as_i64())
            .filter(|s| *s > 0)
            .map(|s| s * 1000)
            .or_else(|| {
                w.get("reset_after_seconds")
                    .and_then(|x| x.as_i64())
                    .map(|s| now + s * 1000)
            });
        out.push(window_dto(kind, pct, resets_at));
    }
    // 后端恒按 5 小时 → 周 → 月输出（前端并列时锚靠前者）
    let rank = |w: &str| match w {
        WINDOW_FIVE_HOUR => 0,
        WINDOW_WEEKLY => 1,
        _ => 2,
    };
    out.sort_by_key(|w| rank(&w.window));
    if out.is_empty() {
        return Err("Codex 用量接口没有返回可展示的额度窗口".into());
    }
    Ok((plan, out))
}

// ===== 查询 =====

fn official_client() -> reqwest::Client {
    let proxy = crate::settings::official_outbound_env()
        .into_iter()
        .find(|(k, _)| k == "HTTPS_PROXY")
        .map(|(_, v)| v);
    let mut builder = reqwest::Client::builder().timeout(HTTP_TIMEOUT);
    if let Some(p) = proxy.and_then(|p| reqwest::Proxy::all(p).ok()) {
        builder = builder.proxy(p);
    }
    builder.build().unwrap_or_else(|_| reqwest::Client::new())
}

fn blank_row(id: &str, provider: &str, plan: Option<String>, console: &str) -> PlanQuotaDto {
    PlanQuotaDto {
        gateway_id: id.into(),
        gateway_name: ROW_NAME.into(),
        provider: provider.into(),
        plan_level: plan,
        ok: false,
        error: None,
        windows: Vec::new(),
        reset_cards_supported: false,
        reset_cards: PlanResetCardsDto::default(),
        queried_at: now_ms(),
        from_cache: false,
        console_url: console.into(),
        binding_id: None,
        account_hint: None,
        is_active_slot: None,
    }
}

fn blank_official_row(
    id: &str,
    name: &str,
    provider: &str,
    plan: Option<String>,
    console: &str,
    binding_id: Option<String>,
    account_hint: Option<String>,
    is_active_slot: Option<bool>,
) -> PlanQuotaDto {
    let mut dto = blank_row(id, provider, plan, console);
    if !name.trim().is_empty() {
        dto.gateway_name = name.trim().to_string();
    }
    dto.binding_id = binding_id;
    dto.account_hint = account_hint;
    dto.is_active_slot = is_active_slot;
    dto
}

async fn get_json(req: reqwest::RequestBuilder) -> Result<(u16, serde_json::Value), String> {
    let resp = req.send().await.map_err(|e| format!("网络错误: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    Ok((status, serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)))
}

async fn query_claude_named(
    row_id: &str,
    row_name: &str,
    binding_id: Option<String>,
    account_hint: Option<String>,
    creds: ClaudeCreds,
) -> PlanQuotaDto {
    let mut dto = blank_official_row(
        row_id,
        row_name,
        "claude",
        creds.plan.clone(),
        "https://claude.ai/settings/usage",
        binding_id,
        account_hint,
        None,
    );
    if creds.token.is_empty() {
        dto.error = Some(
            "Claude 官方登录令牌已被服务端作废（你未手动退出，多因续期冲突失效）：到连接页重新登录一次即可恢复".into(),
        );
        return dto;
    }
    if creds.expires_at.is_some_and(|t| t <= now_ms()) {
        dto.error = Some("Claude 登录凭证已过期：用一次 Claude Code 会自动续期，再回来刷新".into());
        return dto;
    }
    let req = official_client()
        .get(CLAUDE_USAGE_URL)
        .header("Authorization", format!("Bearer {}", creds.token))
        .header("anthropic-beta", CLAUDE_OAUTH_BETA)
        .header("Accept", "application/json");
    match get_json(req).await {
        Ok((status, body)) if (200..300).contains(&status) => match parse_claude_usage(&body) {
            Ok(windows) => {
                dto.ok = true;
                dto.windows = windows;
            }
            Err(e) => dto.error = Some(e),
        },
        Ok((401 | 403, _)) => {
            dto.error = Some("Claude 官方登录已失效：用一次 Claude Code 或到连接页重新登录".into())
        }
        Ok((429, _)) => dto.error = Some("查询太频繁，Claude 暂时拒绝了，稍后再刷新".into()),
        Ok((status, _)) => dto.error = Some(format!("Claude 用量接口返回 HTTP {status}")),
        Err(e) => dto.error = Some(e),
    }
    dto
}

fn agy_window_kind(bucket_id: &str) -> Option<(&'static str, usize)> {
    match bucket_id {
        // 2026-11-15 用户拍板：仅显示自己的订阅（Gemini），不在 Antigravity 卡内混出第三方 Claude / GPT 桶
        "gemini-5h" => Some((WINDOW_FIVE_HOUR, 0)),
        "gemini-weekly" => Some((WINDOW_WEEKLY, 1)),
        "gemini-argon-wtu-weekly" => Some(("agy_argon_weekly", 2)),
        _ => None,
    }
}

fn agy_location_blocked(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("unsupported_location")
        || lower.contains("not currently available in your location")
}

fn agy_failure_message(stdout: &str, stderr: &str) -> &'static str {
    if agy_location_blocked(stdout) || agy_location_blocked(stderr) {
        "当前代理出口或账号地区不支持 Google 官方个人额度（如香港节点会被拦截，Error 1008），请将代理切到美 / 新 / 日等支持地区后刷新"
    } else {
        "Antigravity 额度查询失败：请检查设置里的出网代理，或到连接页重新登录"
    }
}

/// 解析 `agy --print /usage --output-format json` 的输出：将各桶的 remaining_fraction 转为已用百分比
fn parse_agy_usage(body: &serde_json::Value) -> Result<Vec<PlanQuotaWindowDto>, String> {
    if body.get("status").and_then(|s| s.as_str()) != Some("SUCCESS") {
        let raw = body.to_string();
        if agy_location_blocked(&raw) {
            return Err(agy_failure_message(&raw, "").into());
        }
        return Err("Antigravity 用量返回未就绪".into());
    }
    let groups = body
        .get("command")
        .and_then(|c| c.get("data"))
        .and_then(|d| d.get("groups"))
        .and_then(|g| g.as_array())
        .ok_or_else(|| "Antigravity 用量返回里没有分组数据".to_string())?;
    let mut ranked: Vec<(usize, PlanQuotaWindowDto)> = Vec::new();
    for group in groups {
        let Some(buckets) = group.get("buckets").and_then(|b| b.as_array()) else {
            continue;
        };
        for bucket in buckets {
            let Some(id) = bucket.get("id").and_then(|x| x.as_str()) else {
                continue;
            };
            let Some((kind, order)) = agy_window_kind(id) else {
                continue;
            };
            let Some(rem) = bucket.get("remaining_fraction").and_then(|x| x.as_f64()) else {
                continue;
            };
            if ranked.iter().any(|(_, w)| w.window == kind) {
                continue;
            }
            let used_pct = ((1.0 - rem.clamp(0.0, 1.0)) * 100.0).max(0.0);
            ranked.push((order, window_dto(kind, used_pct, iso_ms(bucket.get("reset_time")))));
        }
    }
    if ranked.is_empty() {
        return Err("Antigravity 用量接口没有返回可识别的额度桶".into());
    }
    ranked.sort_by_key(|(order, _)| *order);
    Ok(ranked.into_iter().map(|(_, w)| w).collect())
}

fn agy_token_file_present() -> bool {
    crate::dirs::home_dir().is_some_and(|h| {
        h.join(".gemini/antigravity-cli/antigravity-oauth-token")
            .metadata()
            .is_ok_and(|m| m.is_file() && m.len() > 0)
    })
}

fn run_agy_usage_cli(bin: &std::path::Path) -> Option<(bool, String, String)> {
    let mut cmd = crate::process::background_command(bin);
    for (k, v) in crate::settings::official_outbound_env() {
        cmd.env(k, v);
    }
    // 剥掉环境里的 Gemini API Key / 自定义地址，防止 agy 切入 Key 模式而跳过官方 Google 账号
    cmd.env_remove("GEMINI_API_KEY")
        .env_remove("GOOGLE_GEMINI_BASE_URL")
        .args(["--print", "/usage", "--output-format", "json"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let deadline = std::time::Instant::now() + AGY_USAGE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(_) => return None,
        }
    };
    let out = child.wait_with_output().ok()?;
    let stdout = String::from_utf8(out.stdout).unwrap_or_default();
    let stderr = String::from_utf8(out.stderr).unwrap_or_default();
    Some((status.success(), stdout, stderr))
}

async fn query_agy_row(force: bool, now: i64) -> Option<PlanQuotaDto> {
    if cfg!(test) {
        return None;
    }
    if !force {
        if let Some(hit) = cache_get(AGY_ROW_ID, now) {
            return Some(hit);
        }
    }
    let has_token_file = agy_token_file_present();
    if !force && !has_token_file && now < AGY_ABSENT_UNTIL.load(Ordering::Relaxed) {
        return None;
    }
    let bin = tauri::async_runtime::spawn_blocking(|| crate::agents::resolve_binary("agy"))
        .await
        .ok()
        .flatten()?;
    let ran = tauri::async_runtime::spawn_blocking(move || run_agy_usage_cli(&bin))
        .await
        .ok()
        .flatten();
    let mut dto = blank_row(AGY_ROW_ID, "agy", None, AGY_CONSOLE_URL);
    match ran {
        Some((true, stdout, stderr)) => {
            let body: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap_or(serde_json::Value::Null);
            match parse_agy_usage(&body) {
                Ok(windows) => {
                    AGY_ABSENT_UNTIL.store(0, Ordering::Relaxed);
                    dto.ok = true;
                    dto.windows = windows;
                    return Some(settle_fresh(dto));
                }
                Err(e) if has_token_file => {
                    let msg = if agy_location_blocked(&stdout) || agy_location_blocked(&stderr) {
                        agy_failure_message(&stdout, &stderr).to_string()
                    } else {
                        e
                    };
                    dto.error = Some(msg);
                    return Some(settle_fresh(dto));
                }
                Err(_) => {}
            }
        }
        Some((false, stdout, stderr)) if has_token_file => {
            dto.error = Some(agy_failure_message(&stdout, &stderr).into());
            return Some(settle_fresh(dto));
        }
        None if has_token_file => {
            dto.error = Some("Antigravity 额度查询超时：请检查设置里的出网代理后刷新".into());
            return Some(settle_fresh(dto));
        }
        _ => {}
    }
    AGY_ABSENT_UNTIL.store(now + 120_000, Ordering::Relaxed);
    None
}

/// 解析 `daily-cloudcode-pa` `retrieveUserQuotaSummary` 的返回：仅映射自家 Gemini 桶（与 `parse_agy_usage` 同口径）
fn parse_agy_cloudcode_summary(body: &serde_json::Value) -> Result<Vec<PlanQuotaWindowDto>, String> {
    let groups = body
        .get("groups")
        .and_then(|g| g.as_array())
        .ok_or_else(|| "Antigravity 额度接口缺少 groups 字段".to_string())?;
    let mut ranked: Vec<(usize, PlanQuotaWindowDto)> = Vec::new();
    for group in groups {
        let Some(buckets) = group.get("buckets").and_then(|b| b.as_array()) else {
            continue;
        };
        for bucket in buckets {
            let Some(id) = bucket
                .get("bucketId")
                .or_else(|| bucket.get("id"))
                .and_then(|x| x.as_str())
            else {
                continue;
            };
            let Some((kind, order)) = agy_window_kind(id) else {
                continue;
            };
            let Some(rem) = bucket
                .get("remainingFraction")
                .or_else(|| bucket.get("remaining_fraction"))
                .and_then(|x| x.as_f64())
            else {
                continue;
            };
            if ranked.iter().any(|(_, w)| w.window == kind) {
                continue;
            }
            let used_pct = ((1.0 - rem.clamp(0.0, 1.0)) * 100.0).max(0.0);
            let reset_val = bucket
                .get("resetTime")
                .or_else(|| bucket.get("reset_time"));
            ranked.push((order, window_dto(kind, used_pct, iso_ms(reset_val))));
        }
    }
    if ranked.is_empty() {
        return Err("Antigravity 额度接口没有返回可识别的 Gemini 额度桶".into());
    }
    ranked.sort_by_key(|(order, _)| *order);
    Ok(ranked.into_iter().map(|(_, w)| w).collect())
}

fn agy_cloudcode_plan_label(body: &serde_json::Value) -> Option<String> {
    for key in ["paidTier", "currentTier"] {
        let Some(tier) = body.get(key) else { continue };
        let name = tier
            .get("name")
            .or_else(|| tier.get("id"))
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(n) = name {
            return Some(n.to_string());
        }
    }
    None
}

async fn query_agy_snapshot_api(
    row_id: &str,
    row_name: &str,
    binding_id: Option<String>,
    account_hint: Option<String>,
    snapshot_id: &str,
    is_active: bool,
) -> PlanQuotaDto {
    let mut dto = blank_official_row(
        row_id,
        row_name,
        "agy",
        None,
        AGY_CONSOLE_URL,
        binding_id,
        account_hint,
        Some(is_active),
    );
    let token = match crate::official_accounts::agy_access_token_for_quota(snapshot_id).await {
        Ok(t) => t,
        Err(e) => {
            dto.error = Some(e);
            return dto;
        }
    };
    let ua = format!("mesa/{} (antigravity/cli/1.5.8)", env!("CARGO_PKG_VERSION"));
    let client = official_client();
    // 1) loadCodeAssist 取 project、套餐名与地区资格
    let load_req = client
        .post(format!("{AGY_CLOUDCODE_API_BASE}:loadCodeAssist"))
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", &ua)
        .json(&serde_json::json!({"metadata": {"ideType": "ANTIGRAVITY"}}));
    let mut project: Option<String> = None;
    match get_json(load_req).await {
        Ok((401, _)) => {
            dto.error = Some("Antigravity 登录已失效（401），请切到该账号重新登录".into());
            return dto;
        }
        Ok((status, body)) if (200..300).contains(&status) => {
            let raw = body.to_string();
            if agy_location_blocked(&raw) {
                dto.error = Some(agy_failure_message(&raw, "").into());
                return dto;
            }
            if let Some(reason) = body
                .get("ineligibleTiers")
                .and_then(|v| v.as_array())
                .and_then(|arr| arr.iter().find_map(|x| x.get("reasonMessage").and_then(|m| m.as_str())))
            {
                dto.error = Some(if agy_location_blocked(reason) {
                    agy_failure_message(reason, "").into()
                } else {
                    reason.to_string()
                });
                return dto;
            }
            dto.plan_level = agy_cloudcode_plan_label(&body);
            project = body
                .get("cloudaicompanionProject")
                .and_then(|p| {
                    p.as_str()
                        .map(str::to_string)
                        .or_else(|| p.get("id").and_then(|x| x.as_str()).map(str::to_string))
                });
        }
        _ => {}
    }
    // 2) retrieveUserQuotaSummary 取 Gemini 桶
    let req_body = match project {
        Some(p) => serde_json::json!({ "project": p }),
        None => serde_json::json!({}),
    };
    let quota_req = client
        .post(format!("{AGY_CLOUDCODE_API_BASE}:retrieveUserQuotaSummary"))
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", &ua)
        .json(&req_body);
    match get_json(quota_req).await {
        Ok((status, body)) if (200..300).contains(&status) => match parse_agy_cloudcode_summary(&body) {
            Ok(windows) => {
                dto.ok = true;
                dto.windows = windows;
            }
            Err(e) => dto.error = Some(e),
        },
        Ok((401 | 403, body)) => {
            let raw = body.to_string();
            dto.error = Some(if agy_location_blocked(&raw) {
                agy_failure_message(&raw, "").into()
            } else {
                "Antigravity 登录已失效或无权限，请切到该账号重新登录".into()
            });
        }
        Ok((429, _)) => dto.error = Some("查询太频繁，Antigravity 暂时拒绝了，稍后再刷新".into()),
        Ok((status, _)) => dto.error = Some(format!("Antigravity 额度接口返回 HTTP {status}")),
        Err(e) => dto.error = Some(e),
    }
    dto
}

fn codex_request(method: reqwest::Method, url: &str, creds: &CodexCreds) -> reqwest::RequestBuilder {
    let mut req = official_client()
        .request(method, url)
        .header("Authorization", format!("Bearer {}", creds.token))
        .header("Accept", "application/json")
        .header("User-Agent", "Mozilla/5.0");
    if let Some(acc) = &creds.account_id {
        req = req.header("ChatGPT-Account-Id", acc);
    }
    req
}

/// 查 Codex 重置卡列表；失败只降级重置卡这一栏，不拖垮额度
async fn query_codex_cards(creds: &CodexCreds) -> Result<Vec<(String, Option<i64>)>, String> {
    match get_json(codex_request(reqwest::Method::GET, CODEX_RESET_CREDITS_URL, creds)).await {
        Ok((status, body)) if (200..300).contains(&status) => parse_codex_reset_credits(&body, now_ms()),
        Ok((status, _)) => Err(format!("重置卡列表返回 HTTP {status}")),
        Err(e) => Err(e),
    }
}

async fn query_codex_named(
    row_id: &str,
    row_name: &str,
    binding_id: Option<String>,
    account_hint: Option<String>,
    creds: CodexCreds,
) -> PlanQuotaDto {
    let mut dto = blank_official_row(
        row_id,
        row_name,
        "codex",
        None,
        "https://chatgpt.com/codex/settings/usage",
        binding_id,
        account_hint,
        None,
    );
    dto.reset_cards_supported = true;
    match get_json(codex_request(reqwest::Method::GET, CODEX_USAGE_URL, &creds)).await {
        Ok((status, body)) if (200..300).contains(&status) => match parse_codex_usage(&body, now_ms()) {
            Ok((plan, windows)) => {
                dto.ok = true;
                dto.plan_level = plan;
                dto.windows = windows;
                dto.reset_cards.general_applicable = codex_applicable_cards(&body);
                match query_codex_cards(&creds).await {
                    Ok(cards) => {
                        dto.reset_cards.ok = true;
                        dto.reset_cards.general = cards.len() as u32;
                        dto.reset_cards.general_expires_at = cards.first().and_then(|(_, at)| *at);
                    }
                    Err(e) => dto.reset_cards.error = Some(e),
                }
            }
            Err(e) => dto.error = Some(e),
        },
        Ok((401 | 403, _)) => {
            dto.error = Some("Codex 登录已过期或失效：用一次 Codex 会自动续期，仍不行就到连接页重新登录".into())
        }
        Ok((429, _)) => dto.error = Some("查询太频繁，Codex 暂时拒绝了，稍后再刷新".into()),
        Ok((status, _)) => dto.error = Some(format!("Codex 用量接口返回 HTTP {status}")),
        Err(e) => dto.error = Some(e),
    }
    dto
}

/// 解析某个 Codex 官方行 ID 对应的 `(row_name, binding_id, account_hint, isolated_dir)`
fn resolve_codex_row_target(
    row_id: &str,
) -> Result<(String, Option<String>, Option<String>, Option<std::path::PathBuf>), String> {
    if row_id == CODEX_ROW_ID {
        let bindings = crate::gateway_store::load_bindings().unwrap_or_default();
        let default_b = bindings.into_iter().find(|b| {
            b.agent == "codex"
                && b.kind == crate::profiles::BindingKind::Official
                && b.official_ref
                    .as_ref()
                    .map(|r| &r.mode)
                    .unwrap_or(&crate::official_accounts::OfficialAccountMode::Default)
                    == &crate::official_accounts::OfficialAccountMode::Default
        });
        let name = default_b
            .as_ref()
            .map(|b| b.name.clone())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| ROW_NAME.to_string());
        let bid = default_b.as_ref().map(|b| b.id.clone());
        let hint = default_b.and_then(|b| b.official_ref).and_then(|r| r.account_hint);
        return Ok((name, bid, hint, None));
    }
    let bid = row_id
        .strip_prefix(CODEX_ROW_PREFIX)
        .ok_or_else(|| "未知的 Codex 官方账号行标识".to_string())?;
    let bindings = crate::gateway_store::load_bindings()?;
    let b = bindings
        .into_iter()
        .find(|b| b.id == bid && b.agent == "codex" && b.kind == crate::profiles::BindingKind::Official)
        .ok_or_else(|| "该 Codex 官方账号绑定不存在或已被删除".to_string())?;
    let dir = b
        .official_ref
        .as_ref()
        .and_then(|r| r.local_dir_id.as_deref())
        .map(|id| crate::official_accounts::isolated_dir_path("codex", id))
        .transpose()?;
    let name = if b.name.trim().is_empty() {
        ROW_NAME.to_string()
    } else {
        b.name.clone()
    };
    let hint = b.official_ref.and_then(|r| r.account_hint);
    Ok((name, Some(b.id), hint, dir))
}

/// 用一张 Codex 重置卡（消费性写操作，前端已确认）：按行 ID 定位对应账号的 auth.json，此刻用不了就不发请求
pub async fn use_codex_reset_card(row_id: &str) -> Result<PlanQuotaDto, String> {
    let (row_name, binding_id, account_hint, iso_dir) = resolve_codex_row_target(row_id)?;
    let dir_for_read = iso_dir.clone();
    let creds = tauri::async_runtime::spawn_blocking(move || read_codex_creds_for_dir(dir_for_read.as_deref()))
        .await
        .ok()
        .flatten()
        .ok_or_else(|| "读不到该 Codex 账号的登录信息：请先用 ChatGPT 账号登录".to_string())?;
    // 先重查一遍「此刻能不能用」：界面上的数可能是 2 分钟前的
    let (status, usage) = get_json(codex_request(reqwest::Method::GET, CODEX_USAGE_URL, &creds)).await?;
    if !(200..300).contains(&status) {
        return Err(format!("查 Codex 额度失败（HTTP {status}），没有用卡"));
    }
    if codex_applicable_cards(&usage) == Some(0) {
        return Err("Codex 现在没被限额卡住，重置卡用不了；额度用满被卡住后再来".into());
    }
    let cards = query_codex_cards(&creds).await?;
    let (credit_id, _) = cards.first().cloned().ok_or_else(|| "没有可用的 Codex 重置卡".to_string())?;
    let payload = serde_json::json!({
        "credit_id": credit_id,
        "redeem_request_id": uuid::Uuid::new_v4().to_string(),
    });
    let (status, body) = get_json(
        codex_request(reqwest::Method::POST, &format!("{CODEX_RESET_CREDITS_URL}/consume"), &creds).json(&payload),
    )
    .await?;
    if !(200..300).contains(&status) {
        let msg = body
            .get("detail")
            .or_else(|| body.get("message"))
            .or_else(|| body.get("error").and_then(|e| e.get("message")))
            .and_then(|v| v.as_str())
            .map(|m| format!("：{m}"))
            .unwrap_or_default();
        return Err(format!("用卡失败（HTTP {status}）{msg}"));
    }
    crate::subscription_quota::cache_invalidate(row_id);
    Ok(settle_fresh(
        query_codex_named(row_id, &row_name, binding_id, account_hint, creds).await,
    ))
}

// ===== Grok Build（SuperGrok）官方订阅额度（只读，绝不刷新令牌） =====

#[derive(Debug, Clone, PartialEq, Eq)]
enum GrokTokenState {
    Valid,
    RefreshPending,
    Expired,
}

#[derive(Debug, Clone)]
struct GrokCreds {
    token: String,
    state: GrokTokenState,
}

fn is_iso_expired_at(iso: &str, now_secs: i64) -> bool {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(iso) {
        dt.timestamp() < now_secs
    } else if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S%.f") {
        dt.and_utc().timestamp() < now_secs
    } else {
        false
    }
}

/// 解析 `~/.grok/auth.json`（scope → entry 顶层 map）：优先 OIDC SuperGrok，回退 legacy sign-in；只读不刷新
fn parse_grok_auth_json(content: &str, now_secs: i64) -> Option<GrokCreds> {
    let parsed: serde_json::Value = serde_json::from_str(content).ok()?;
    let root = parsed.as_object()?;
    let mut oidc_candidate = None;
    let mut legacy_candidate = None;
    for (scope, value) in root {
        let Some(entry) = value.as_object() else { continue };
        let has_key = entry
            .get("key")
            .and_then(|v| v.as_str())
            .is_some_and(|k| !k.trim().is_empty());
        if !has_key {
            continue;
        }
        if scope.starts_with("https://auth.x.ai::") {
            oidc_candidate = Some(entry);
        } else if scope == "https://accounts.x.ai/sign-in" || scope.contains("/sign-in") {
            legacy_candidate = Some(entry);
        }
    }
    let entry = oidc_candidate.or(legacy_candidate)?;
    let token = entry.get("key")?.as_str()?.trim().to_string();
    let state = match entry.get("expires_at").and_then(|v| v.as_str()) {
        Some(iso) if is_iso_expired_at(iso, now_secs) => {
            let has_refresh = entry
                .get("refresh_token")
                .and_then(|v| v.as_str())
                .is_some_and(|t| !t.trim().is_empty());
            if has_refresh {
                GrokTokenState::RefreshPending
            } else {
                GrokTokenState::Expired
            }
        }
        _ => GrokTokenState::Valid,
    };
    Some(GrokCreds { token, state })
}

fn read_grok_creds_for_dir(config_dir: Option<&std::path::Path>) -> Option<GrokCreds> {
    if cfg!(test) {
        return None;
    }
    let root = match config_dir {
        Some(d) => d.to_path_buf(),
        None => crate::agent_specs::agent_config_root("grok")?,
    };
    let text = std::fs::read_to_string(root.join("auth.json")).ok()?;
    parse_grok_auth_json(&text, chrono::Utc::now().timestamp())
}

#[derive(Default)]
struct GrokProtobufScan {
    fixed32_fields: Vec<(Vec<u64>, f32, usize)>,
    varint_fields: Vec<(Vec<u64>, u64)>,
}

fn grok_read_varint(bytes: &[u8], index: &mut usize) -> Option<u64> {
    let mut value: u64 = 0;
    let mut shift: u32 = 0;
    while *index < bytes.len() && shift < 64 {
        let byte = bytes[*index];
        *index += 1;
        value |= u64::from(byte & 0x7F) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
    }
    None
}

fn grok_scan_protobuf(
    bytes: &[u8],
    depth: usize,
    path: &[u64],
    order: usize,
    scan: &mut GrokProtobufScan,
) -> usize {
    let mut index = 0;
    let mut next_order = order;
    while index < bytes.len() {
        let field_start = index;
        let key = match grok_read_varint(bytes, &mut index) {
            Some(k) if k != 0 => k,
            _ => {
                index = field_start + 1;
                continue;
            }
        };
        let field_number = key >> 3;
        let wire_type = key & 0x07;
        let mut field_path = path.to_vec();
        field_path.push(field_number);
        match wire_type {
            0 => match grok_read_varint(bytes, &mut index) {
                Some(v) => scan.varint_fields.push((field_path, v)),
                None => index = field_start + 1,
            },
            1 => {
                if index + 8 > bytes.len() {
                    return next_order;
                }
                index += 8;
            }
            2 => {
                let len = match grok_read_varint(bytes, &mut index) {
                    Some(l) if l <= (bytes.len() - index) as u64 => l as usize,
                    _ => {
                        index = field_start + 1;
                        continue;
                    }
                };
                let end = index + len;
                if depth < 4 {
                    next_order =
                        grok_scan_protobuf(&bytes[index..end], depth + 1, &field_path, next_order, scan);
                }
                index = end;
            }
            5 => {
                if index + 4 > bytes.len() {
                    return next_order;
                }
                let bits = u32::from_le_bytes([
                    bytes[index],
                    bytes[index + 1],
                    bytes[index + 2],
                    bytes[index + 3],
                ]);
                scan.fixed32_fields
                    .push((field_path, f32::from_bits(bits), next_order));
                next_order += 1;
                index += 4;
            }
            _ => index = field_start + 1,
        }
    }
    next_order
}

fn grok_grpc_data_frames(data: &[u8]) -> Vec<&[u8]> {
    let mut frames = Vec::new();
    let mut index = 0;
    while index < data.len() {
        if index + 5 > data.len() {
            return Vec::new();
        }
        let flags = data[index];
        let length = u32::from_be_bytes([
            data[index + 1],
            data[index + 2],
            data[index + 3],
            data[index + 4],
        ]) as usize;
        let start = index + 5;
        let end = start + length;
        if end > data.len() {
            return Vec::new();
        }
        if flags & 0x80 == 0 {
            frames.push(&data[start..end]);
        }
        index = end;
    }
    frames
}

fn grok_percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn grok_grpc_trailers(data: &[u8]) -> std::collections::HashMap<String, String> {
    let mut fields = std::collections::HashMap::new();
    let mut index = 0;
    while index + 5 <= data.len() {
        let flags = data[index];
        let length = u32::from_be_bytes([
            data[index + 1],
            data[index + 2],
            data[index + 3],
            data[index + 4],
        ]) as usize;
        let start = index + 5;
        let end = start + length;
        if end > data.len() {
            break;
        }
        if flags & 0x80 != 0 {
            if let Ok(text) = std::str::from_utf8(&data[start..end]) {
                for line in text.lines().filter(|l| !l.is_empty()) {
                    if let Some((k, v)) = line.split_once(':') {
                        fields.insert(k.trim().to_ascii_lowercase(), grok_percent_decode(v.trim()));
                    }
                }
            }
        }
        index = end;
    }
    fields
}

fn grok_parse_billing_payload(data: &[u8], now_secs: i64) -> Result<(f64, Option<i64>), String> {
    let mut payloads = grok_grpc_data_frames(data);
    if payloads.is_empty() {
        if let Some(&first) = data.first() {
            if (first >> 3) > 0 && matches!(first & 0x07, 0 | 1 | 2 | 5) {
                payloads = vec![data];
            }
        }
    }
    if payloads.is_empty() {
        return Err("Grok 账单响应缺少有效数据".into());
    }
    let mut scan = GrokProtobufScan::default();
    for payload in payloads {
        grok_scan_protobuf(payload, 0, &[], 0, &mut scan);
    }
    let parsed_percent = scan
        .fixed32_fields
        .iter()
        .filter(|(path, v, _)| path.last() == Some(&1) && v.is_finite() && *v >= 0.0 && *v <= 100.0)
        .min_by_key(|(path, _, order)| (path.len(), *order))
        .map(|(_, v, _)| f64::from(*v));

    let reset_candidates: Vec<(&[u64], i64)> = scan
        .varint_fields
        .iter()
        .filter(|(_, v)| (1_700_000_000..=2_100_000_000).contains(v))
        .map(|(path, v)| (path.as_slice(), *v as i64))
        .filter(|(_, ts)| *ts > now_secs)
        .collect();
    let reset = reset_candidates
        .iter()
        .filter(|(path, _)| *path == [1, 5, 1])
        .map(|(_, ts)| *ts)
        .min()
        .or_else(|| reset_candidates.iter().map(|(_, ts)| *ts).min());

    let has_usage_period = scan.varint_fields.iter().any(|(path, v)| {
        path.starts_with(&[1, 6]) || (path.as_slice() == [1, 8, 1] && (*v == 1 || *v == 2))
    });
    let no_usage_yet = parsed_percent.is_none()
        && scan.fixed32_fields.is_empty()
        && reset.is_some()
        && has_usage_period;

    let used_percent = parsed_percent
        .or(if no_usage_yet { Some(0.0) } else { None })
        .ok_or_else(|| "未能从 Grok 账单响应解析出额度比例".to_string())?;
    Ok((used_percent.clamp(0.0, 100.0), reset))
}

fn grok_parse_plan(body: &serde_json::Value) -> Option<String> {
    let settings = body.get("settings").unwrap_or(body);
    let text = |key: &str| {
        settings
            .get(key)
            .or_else(|| body.get(key))?
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    if let Some(display) = text("subscription_tier_display") {
        return Some(display.to_string());
    }
    let raw = text("subscription_tier")?;
    let letters: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase();
    Some(match letters.as_str() {
        "supergrokheavy" | "heavy" => "SuperGrok Heavy".to_string(),
        "supergrok" => "SuperGrok".to_string(),
        _ => raw.to_string(),
    })
}

fn grok_window_for_reset(resets_at: Option<i64>, now_secs: i64) -> &'static str {
    if let Some(ts) = resets_at {
        let days = ((ts - now_secs) as f64 / 86400.0).round() as i64;
        if (4..=12).contains(&days) {
            return WINDOW_WEEKLY;
        }
        if (20..=45).contains(&days) {
            return WINDOW_MONTHLY;
        }
    }
    WINDOW_CREDITS
}

fn grok_grpc_error_message(status: i64, message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if status == 16
        || (status == 7
            && (lower.contains("bad-credentials")
                || lower.contains("unauthenticated")
                || lower.contains("invalid")
                || lower.contains("expired")))
    {
        return "Grok 登录已过期或被拒绝：用一次 Grok 自动续期，仍不行就到连接页重新 `grok login`".into();
    }
    if status == 9 && matches!(lower.trim(), "no personal team" | "no personal team.") {
        return "当前是 xAI 团队账号，账单接口暂未开放个人额度查询".into();
    }
    format!("Grok 账单接口返回错误（grpc-status {status}）：{message}")
}

async fn query_grok_plan(client: &reqwest::Client, access_token: &str) -> Option<String> {
    let resp = client
        .get(GROK_SETTINGS_ENDPOINT)
        .bearer_auth(access_token)
        .header("Accept", "application/json")
        .header("User-Agent", format!("mesa/{}", env!("CARGO_PKG_VERSION")))
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = serde_json::from_slice(&resp.bytes().await.ok()?).ok()?;
    grok_parse_plan(&body)
}

async fn query_grok_named(
    row_id: &str,
    row_name: &str,
    binding_id: Option<String>,
    account_hint: Option<String>,
    creds: GrokCreds,
) -> PlanQuotaDto {
    let mut dto = blank_official_row(
        row_id,
        row_name,
        "grok",
        None,
        GROK_CONSOLE_URL,
        binding_id,
        account_hint,
        None,
    );
    match creds.state {
        GrokTokenState::RefreshPending => {
            dto.error = Some("Grok 登录令牌待刷新：用一次 Grok 后再刷新，CLI 会自动续期".into());
            return dto;
        }
        GrokTokenState::Expired => {
            dto.error = Some("Grok 登录已过期，请到连接页重新执行 `grok login`".into());
            return dto;
        }
        GrokTokenState::Valid => {}
    }
    let client = official_client();
    let plan_client = client.clone();
    let plan_token = creds.token.clone();
    let plan_task = tauri::async_runtime::spawn(async move {
        query_grok_plan(&plan_client, &plan_token).await
    });
    let billing_res = client
        .post(GROK_BILLING_ENDPOINT)
        .header("Authorization", format!("Bearer {}", creds.token))
        .header("Origin", "https://grok.com")
        .header("Referer", "https://grok.com/?_s=usage")
        .header("Accept", "*/*")
        .header("Content-Type", "application/grpc-web+proto")
        .header("x-grpc-web", "1")
        .header("x-user-agent", "connect-es/2.1.1")
        .header("User-Agent", format!("mesa/{}", env!("CARGO_PKG_VERSION")))
        .body(vec![0u8; 5])
        .timeout(HTTP_TIMEOUT)
        .send()
        .await;
    dto.plan_level = plan_task.await.ok().flatten();

    let resp = match billing_res {
        Ok(r) => r,
        Err(e) => {
            dto.error = Some(format!("查询 Grok 额度失败（请检查出网代理）: {e}"));
            return dto;
        }
    };
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        dto.error = Some("Grok 登录已过期或失效：用一次 Grok 自动续期，仍不行就重新 `grok login`".into());
        return dto;
    }
    let header_status = resp
        .headers()
        .get("grpc-status")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok());
    let header_msg = resp
        .headers()
        .get("grpc-message")
        .and_then(|v| v.to_str().ok())
        .map(grok_percent_decode)
        .unwrap_or_default();
    if !status.is_success() {
        dto.error = Some(format!("Grok 额度接口返回 HTTP {}", status.as_u16()));
        return dto;
    }
    if let Some(code) = header_status.filter(|c| *c != 0) {
        dto.error = Some(grok_grpc_error_message(code, &header_msg));
        return dto;
    }
    let raw = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            dto.error = Some(format!("读取 Grok 额度响应失败: {e}"));
            return dto;
        }
    };
    let trailers = grok_grpc_trailers(&raw);
    if let Some(code) = trailers
        .get("grpc-status")
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|c| *c != 0)
    {
        let msg = trailers.get("grpc-message").map(String::as_str).unwrap_or("");
        dto.error = Some(grok_grpc_error_message(code, msg));
        return dto;
    }
    let now_secs = chrono::Utc::now().timestamp();
    match grok_parse_billing_payload(&raw, now_secs) {
        Ok((used_percent, resets_at_secs)) => {
            dto.ok = true;
            dto.windows = vec![window_dto(
                grok_window_for_reset(resets_at_secs, now_secs),
                used_percent,
                resets_at_secs.map(|s| s * 1000),
            )];
        }
        Err(e) => dto.error = Some(e),
    }
    dto
}

// ===== Kimi Code 官方 OAuth 订阅额度（只读，绝不刷新令牌） =====

#[derive(Debug, Clone, PartialEq, Eq)]
enum KimiTokenState {
    Valid,
    RefreshPending,
    Expired,
}

#[derive(Debug, Clone)]
struct KimiOfficialCreds {
    token: String,
    state: KimiTokenState,
    base_url: String,
    device_id: String,
}

fn parse_kimi_official_creds(
    cred_json: &str,
    base_url: String,
    device_id: String,
    now_secs: i64,
) -> Option<KimiOfficialCreds> {
    let v: serde_json::Value = serde_json::from_str(cred_json).ok()?;
    let access = v
        .get("access_token")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let has_refresh = v
        .get("refresh_token")
        .and_then(|x| x.as_str())
        .is_some_and(|s| !s.trim().is_empty());
    let expires_at = v.get("expires_at").and_then(|x| x.as_i64());
    if access.is_empty() && !has_refresh {
        return Some(KimiOfficialCreds {
            token: String::new(),
            state: KimiTokenState::Expired,
            base_url,
            device_id,
        });
    }
    let expired = access.is_empty() || expires_at.is_some_and(|exp| exp <= now_secs);
    let state = if !expired {
        KimiTokenState::Valid
    } else if has_refresh {
        KimiTokenState::RefreshPending
    } else {
        KimiTokenState::Expired
    };
    Some(KimiOfficialCreds {
        token: access,
        state,
        base_url,
        device_id,
    })
}

fn read_kimi_creds_for_dir(config_dir: Option<&std::path::Path>) -> Option<KimiOfficialCreds> {
    if cfg!(test) {
        return None;
    }
    let root = match config_dir {
        Some(d) => d.to_path_buf(),
        None => crate::agent_specs::agent_config_root("kimi")?,
    };
    // 1) 从 config.toml 找 managed:kimi-code 或带 oauth 段的官方 provider 的 base_url 与凭据槽名
    let mut base_url = KIMI_DEFAULT_BASE_URL.to_string();
    let mut cred_name = "kimi-code".to_string();
    if let Ok(cfg_text) = std::fs::read_to_string(root.join("config.toml")) {
        if let Ok(doc) = toml::from_str::<toml::Value>(&cfg_text) {
            if let Some(providers) = doc.get("providers").and_then(|v| v.as_table()) {
                let target = providers.get("managed:kimi-code").or_else(|| {
                    providers
                        .values()
                        .find(|p| p.get("oauth").and_then(|o| o.as_table()).is_some())
                });
                if let Some(p) = target {
                    if let Some(u) = p
                        .get("base_url")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        base_url = u.trim_end_matches('/').to_string();
                    }
                    if let Some(oauth) = p.get("oauth").and_then(|o| o.as_table()) {
                        if oauth
                            .get("storage")
                            .and_then(|s| s.as_str())
                            .is_some_and(|s| s != "file")
                        {
                            return None;
                        }
                        if let Some(key) = oauth.get("key").and_then(|k| k.as_str()) {
                            let stripped = key.strip_prefix("oauth/").unwrap_or(key);
                            if !stripped.is_empty()
                                && stripped
                                    .bytes()
                                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                            {
                                cred_name = stripped.to_string();
                            }
                        }
                    }
                }
            }
        }
    }
    // 2) 只读 credentials/{cred_name}.json，找不到则扫 credentials/*.json 兜底
    let creds_dir = root.join("credentials");
    let primary = creds_dir.join(format!("{cred_name}.json"));
    let cred_path = if primary.is_file() {
        primary
    } else {
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&creds_dir)
            .ok()?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("json"))
            .collect();
        files.sort();
        files.into_iter().next()?
    };
    let text = std::fs::read_to_string(&cred_path).ok()?;
    let device_id = std::fs::read_to_string(root.join("device_id"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "mesa-readonly".to_string());
    parse_kimi_official_creds(&text, base_url, device_id, chrono::Utc::now().timestamp())
}

fn parse_kimi_me(body: &serde_json::Value) -> (Option<String>, Option<String>) {
    let pick = |key: &str| {
        body.get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    (pick("user_level_name"), pick("nickname"))
}

async fn query_kimi_me(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    device_id: &str,
) -> (Option<String>, Option<String>) {
    let endpoint = format!("{}/me", base_url.trim_end_matches('/'));
    let resp = client
        .get(&endpoint)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .header("User-Agent", format!("mesa/{}", env!("CARGO_PKG_VERSION")))
        .header("X-Msh-Platform", "kimi_code_cli")
        .header("X-Msh-Version", env!("CARGO_PKG_VERSION"))
        .header("X-Msh-Device-Id", device_id)
        .header("X-Msh-Os-Version", std::env::consts::OS)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await;
    let Ok(r) = resp else { return (None, None) };
    if !r.status().is_success() {
        return (None, None);
    }
    let Ok(body) = r.json::<serde_json::Value>().await else {
        return (None, None);
    };
    parse_kimi_me(&body)
}

async fn query_kimi_official_named(
    row_id: &str,
    row_name: &str,
    binding_id: Option<String>,
    account_hint: Option<String>,
    creds: KimiOfficialCreds,
) -> PlanQuotaDto {
    let console = if creds.base_url.contains("kimi.ai") {
        KIMI_GLOBAL_CONSOLE_URL
    } else {
        KIMI_CN_CONSOLE_URL
    };
    let mut dto = blank_official_row(
        row_id,
        row_name,
        "kimi",
        None,
        console,
        binding_id,
        account_hint,
        None,
    );
    match creds.state {
        KimiTokenState::RefreshPending => {
            dto.error = Some("Kimi 登录令牌待刷新：用一次 Kimi Code 后再刷新，CLI 会自动续期".into());
            return dto;
        }
        KimiTokenState::Expired => {
            dto.error = Some("Kimi Code 登录已过期，请到连接页重新执行 `kimi login`".into());
            return dto;
        }
        KimiTokenState::Valid => {}
    }
    let client = official_client();
    let me_client = client.clone();
    let me_base = creds.base_url.clone();
    let me_token = creds.token.clone();
    let me_device = creds.device_id.clone();
    let me_task = tauri::async_runtime::spawn(async move {
        query_kimi_me(&me_client, &me_base, &me_token, &me_device).await
    });
    let usages_url = format!("{}/usages", creds.base_url.trim_end_matches('/'));
    let usage_req = client
        .get(&usages_url)
        .bearer_auth(&creds.token)
        .header("Accept", "application/json")
        .header("User-Agent", format!("mesa/{}", env!("CARGO_PKG_VERSION")))
        .timeout(HTTP_TIMEOUT);
    let usage_res = get_json(usage_req).await;
    let (plan, nickname) = me_task.await.unwrap_or((None, None));
    if dto.plan_level.is_none() {
        dto.plan_level = plan;
    }
    if dto.account_hint.is_none() {
        dto.account_hint = nickname;
    }
    match usage_res {
        Ok((status, body)) if (200..300).contains(&status) => {
            match crate::subscription_quota::parse_kimi_quota_windows(&body) {
                Ok(windows) => {
                    dto.ok = true;
                    dto.windows = windows;
                }
                Err(e) => dto.error = Some(e),
            }
        }
        Ok((401 | 403, _)) => {
            dto.error = Some("Kimi 登录已过期或失效：用一次 Kimi Code 自动续期，仍不行就重新 `kimi login`".into());
        }
        Ok((429, _)) => dto.error = Some("查询太频繁，Kimi 暂时拒绝了，稍后再刷新".into()),
        Ok((status, _)) => dto.error = Some(format!("Kimi 额度接口返回 HTTP {status}")),
        Err(e) => dto.error = Some(e),
    }
    dto
}

/// 五家官方账号的行（Claude Code / Codex / Grok Build / Kimi Code / Antigravity CLI）：
/// 并发查询本机默认槽位 + 连接页里全部附加隔离账号 / 托管快照账号；没登录不出行（已显式加号的附加号除外，会在卡面提示未登录）
pub async fn official_rows(force: bool) -> Vec<PlanQuotaDto> {
    official_rows_streaming(force, 0, None).await
}

/// 并发探查并渐进回报全部官方账号余量：每家账号的凭证读取与网络请求在独立任务内执行
/// （避免 Claude 钥匙串等慢探针阻塞 Codex / Kimi / Grok / Antigravity），命中 2 分钟缓存时 0ms 直接回报。
pub(crate) async fn official_rows_streaming(
    force: bool,
    order_base: usize,
    sink: Option<std::sync::Arc<crate::subscription_quota::QuotaPartialSink>>,
) -> Vec<PlanQuotaDto> {
    if cfg!(test) {
        return Vec::new();
    }
    let now = now_ms();
    let bindings = crate::gateway_store::load_bindings().unwrap_or_default();

    // 整理五家带官方额度卡的官方绑定
    let mut claude_default: Option<crate::profiles::Binding> = None;
    let mut claude_isolated: Vec<crate::profiles::Binding> = Vec::new();
    let mut codex_default: Option<crate::profiles::Binding> = None;
    let mut codex_isolated: Vec<crate::profiles::Binding> = Vec::new();
    let mut grok_default: Option<crate::profiles::Binding> = None;
    let mut grok_isolated: Vec<crate::profiles::Binding> = Vec::new();
    let mut kimi_default: Option<crate::profiles::Binding> = None;
    let mut kimi_isolated: Vec<crate::profiles::Binding> = Vec::new();
    let mut agy_managed: Vec<crate::profiles::Binding> = Vec::new();
    let mut agy_default: Option<crate::profiles::Binding> = None;

    for b in bindings {
        if b.kind != crate::profiles::BindingKind::Official {
            continue;
        }
        let mode = b
            .official_ref
            .as_ref()
            .map(|r| &r.mode)
            .unwrap_or(&crate::official_accounts::OfficialAccountMode::Default);
        match (b.agent.as_str(), mode) {
            ("claude-code", crate::official_accounts::OfficialAccountMode::Default) => {
                if claude_default.is_none() {
                    claude_default = Some(b);
                }
            }
            ("claude-code", crate::official_accounts::OfficialAccountMode::IsolatedDir) => {
                claude_isolated.push(b);
            }
            ("codex", crate::official_accounts::OfficialAccountMode::Default) => {
                if codex_default.is_none() {
                    codex_default = Some(b);
                }
            }
            ("codex", crate::official_accounts::OfficialAccountMode::IsolatedDir) => {
                codex_isolated.push(b);
            }
            ("grok", crate::official_accounts::OfficialAccountMode::Default) => {
                if grok_default.is_none() {
                    grok_default = Some(b);
                }
            }
            ("grok", crate::official_accounts::OfficialAccountMode::IsolatedDir) => {
                grok_isolated.push(b);
            }
            ("kimi", crate::official_accounts::OfficialAccountMode::Default) => {
                if kimi_default.is_none() {
                    kimi_default = Some(b);
                }
            }
            ("kimi", crate::official_accounts::OfficialAccountMode::IsolatedDir) => {
                kimi_isolated.push(b);
            }
            ("agy", crate::official_accounts::OfficialAccountMode::ManagedSnapshot) => {
                agy_managed.push(b);
            }
            ("agy", crate::official_accounts::OfficialAccountMode::Default) => {
                if agy_default.is_none() {
                    agy_default = Some(b);
                }
            }
            _ => {}
        }
    }

    let mut next_order = order_base;
    let mut alloc_order = || {
        let o = next_order;
        next_order += 1;
        o
    };

    let mut tasks: Vec<tauri::async_runtime::JoinHandle<Option<PlanQuotaDto>>> = Vec::new();

    // 1) Claude 默认 + 隔离目录（各自独立任务，钥匙串探针不再阻塞其他家）
    {
        let order = alloc_order();
        let name = claude_default
            .as_ref()
            .map(|b| b.name.clone())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| ROW_NAME.to_string());
        let bid = claude_default.as_ref().map(|b| b.id.clone());
        let hint = claude_default
            .as_ref()
            .and_then(|b| b.official_ref.as_ref())
            .and_then(|r| r.account_hint.clone());
        let s = sink.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            if !force {
                if let Some(hit) = cache_get(CLAUDE_ROW_ID, now) {
                    if let Some(ref sk) = s {
                        sk.push(order, hit.clone());
                    }
                    return Some(hit);
                }
            }
            let creds = tauri::async_runtime::spawn_blocking(read_claude_creds)
                .await
                .ok()
                .flatten()?;
            let dto = settle_fresh(query_claude_named(CLAUDE_ROW_ID, &name, bid, hint, creds).await);
            if let Some(ref sk) = s {
                sk.push(order, dto.clone());
            }
            Some(dto)
        }));
    }
    for b in claude_isolated {
        let order = alloc_order();
        let dir = b
            .official_ref
            .as_ref()
            .and_then(|r| r.local_dir_id.as_deref())
            .and_then(|id| crate::official_accounts::isolated_dir_path("claude-code", id).ok());
        let bid = b.id.clone();
        let row_id = format!("{CLAUDE_ROW_PREFIX}{bid}");
        let name = if b.name.trim().is_empty() { ROW_NAME.to_string() } else { b.name.clone() };
        let preset_hint = b.official_ref.as_ref().and_then(|r| r.account_hint.clone());
        let s = sink.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            if !force {
                if let Some(hit) = cache_get(&row_id, now) {
                    if let Some(ref sk) = s {
                        sk.push(order, hit.clone());
                    }
                    return Some(hit);
                }
            }
            let Some(dir) = dir else { return None };
            let (creds, hint) = tauri::async_runtime::spawn_blocking(move || {
                let c = read_claude_creds_for_dir(Some(&dir));
                let h = preset_hint.or_else(|| crate::official_accounts::read_claude_account_hint(&dir));
                (c, h)
            })
            .await
            .ok()?;
            let creds = creds?;
            let dto = settle_fresh(query_claude_named(&row_id, &name, Some(bid), hint, creds).await);
            if let Some(ref sk) = s {
                sk.push(order, dto.clone());
            }
            Some(dto)
        }));
    }

    // 2) Codex 默认 + 隔离目录
    {
        let order = alloc_order();
        let name = codex_default
            .as_ref()
            .map(|b| b.name.clone())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| ROW_NAME.to_string());
        let bid = codex_default.as_ref().map(|b| b.id.clone());
        let hint = codex_default
            .as_ref()
            .and_then(|b| b.official_ref.as_ref())
            .and_then(|r| r.account_hint.clone());
        let s = sink.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            if !force {
                if let Some(hit) = cache_get(CODEX_ROW_ID, now) {
                    if let Some(ref sk) = s {
                        sk.push(order, hit.clone());
                    }
                    return Some(hit);
                }
            }
            let creds = tauri::async_runtime::spawn_blocking(read_codex_creds)
                .await
                .ok()
                .flatten()?;
            let dto = settle_fresh(query_codex_named(CODEX_ROW_ID, &name, bid, hint, creds).await);
            if let Some(ref sk) = s {
                sk.push(order, dto.clone());
            }
            Some(dto)
        }));
    }
    for b in codex_isolated {
        let order = alloc_order();
        let dir = b
            .official_ref
            .as_ref()
            .and_then(|r| r.local_dir_id.as_deref())
            .and_then(|id| crate::official_accounts::isolated_dir_path("codex", id).ok());
        let bid = b.id.clone();
        let row_id = format!("{CODEX_ROW_PREFIX}{bid}");
        let name = if b.name.trim().is_empty() { ROW_NAME.to_string() } else { b.name.clone() };
        let preset_hint = b.official_ref.as_ref().and_then(|r| r.account_hint.clone());
        let s = sink.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            if !force {
                if let Some(hit) = cache_get(&row_id, now) {
                    if let Some(ref sk) = s {
                        sk.push(order, hit.clone());
                    }
                    return Some(hit);
                }
            }
            let Some(dir) = dir else { return None };
            let (creds, hint) = tauri::async_runtime::spawn_blocking(move || {
                let c = read_codex_creds_for_dir(Some(&dir));
                let h = preset_hint.or_else(|| crate::official_accounts::probe_isolated_codex(&dir).1);
                (c, h)
            })
            .await
            .ok()?;
            let creds = creds?;
            let dto = settle_fresh(query_codex_named(&row_id, &name, Some(bid), hint, creds).await);
            if let Some(ref sk) = s {
                sk.push(order, dto.clone());
            }
            Some(dto)
        }));
    }

    // 3) Grok 默认 + 隔离目录
    {
        let order = alloc_order();
        let name = grok_default
            .as_ref()
            .map(|b| b.name.clone())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| ROW_NAME.to_string());
        let bid = grok_default.as_ref().map(|b| b.id.clone());
        let hint = grok_default
            .as_ref()
            .and_then(|b| b.official_ref.as_ref())
            .and_then(|r| r.account_hint.clone());
        let s = sink.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            if !force {
                if let Some(hit) = cache_get(GROK_ROW_ID, now) {
                    if let Some(ref sk) = s {
                        sk.push(order, hit.clone());
                    }
                    return Some(hit);
                }
            }
            let creds = tauri::async_runtime::spawn_blocking(|| read_grok_creds_for_dir(None))
                .await
                .ok()
                .flatten()?;
            let dto = settle_fresh(query_grok_named(GROK_ROW_ID, &name, bid, hint, creds).await);
            if let Some(ref sk) = s {
                sk.push(order, dto.clone());
            }
            Some(dto)
        }));
    }
    for b in grok_isolated {
        let order = alloc_order();
        let dir = b
            .official_ref
            .as_ref()
            .and_then(|r| r.local_dir_id.as_deref())
            .and_then(|id| crate::official_accounts::isolated_dir_path("grok", id).ok());
        let bid = b.id.clone();
        let row_id = format!("{GROK_ROW_PREFIX}{bid}");
        let name = if b.name.trim().is_empty() { ROW_NAME.to_string() } else { b.name.clone() };
        let preset_hint = b.official_ref.as_ref().and_then(|r| r.account_hint.clone());
        let s = sink.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            if !force {
                if let Some(hit) = cache_get(&row_id, now) {
                    if let Some(ref sk) = s {
                        sk.push(order, hit.clone());
                    }
                    return Some(hit);
                }
            }
            let Some(dir) = dir else { return None };
            let (creds, hint) = tauri::async_runtime::spawn_blocking(move || {
                let c = read_grok_creds_for_dir(Some(&dir));
                let h = preset_hint.or_else(|| crate::official_accounts::probe_isolated_grok(&dir).1);
                (c, h)
            })
            .await
            .ok()?;
            let creds = creds?;
            let dto = settle_fresh(query_grok_named(&row_id, &name, Some(bid), hint, creds).await);
            if let Some(ref sk) = s {
                sk.push(order, dto.clone());
            }
            Some(dto)
        }));
    }

    // 4) Kimi 默认 + 隔离目录
    {
        let order = alloc_order();
        let name = kimi_default
            .as_ref()
            .map(|b| b.name.clone())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| ROW_NAME.to_string());
        let bid = kimi_default.as_ref().map(|b| b.id.clone());
        let hint = kimi_default
            .as_ref()
            .and_then(|b| b.official_ref.as_ref())
            .and_then(|r| r.account_hint.clone());
        let s = sink.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            if !force {
                if let Some(hit) = cache_get(KIMI_ROW_ID, now) {
                    if let Some(ref sk) = s {
                        sk.push(order, hit.clone());
                    }
                    return Some(hit);
                }
            }
            let creds = tauri::async_runtime::spawn_blocking(|| read_kimi_creds_for_dir(None))
                .await
                .ok()
                .flatten()?;
            let dto = settle_fresh(query_kimi_official_named(KIMI_ROW_ID, &name, bid, hint, creds).await);
            if let Some(ref sk) = s {
                sk.push(order, dto.clone());
            }
            Some(dto)
        }));
    }
    for b in kimi_isolated {
        let order = alloc_order();
        let dir = b
            .official_ref
            .as_ref()
            .and_then(|r| r.local_dir_id.as_deref())
            .and_then(|id| crate::official_accounts::isolated_dir_path("kimi", id).ok());
        let bid = b.id.clone();
        let row_id = format!("{KIMI_ROW_PREFIX}{bid}");
        let name = if b.name.trim().is_empty() { ROW_NAME.to_string() } else { b.name.clone() };
        let hint = b.official_ref.as_ref().and_then(|r| r.account_hint.clone());
        let s = sink.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            if !force {
                if let Some(hit) = cache_get(&row_id, now) {
                    if let Some(ref sk) = s {
                        sk.push(order, hit.clone());
                    }
                    return Some(hit);
                }
            }
            let Some(dir) = dir else { return None };
            let creds = tauri::async_runtime::spawn_blocking(move || read_kimi_creds_for_dir(Some(&dir)))
                .await
                .ok()
                .flatten()?;
            let dto = settle_fresh(query_kimi_official_named(&row_id, &name, Some(bid), hint, creds).await);
            if let Some(ref sk) = s {
                sk.push(order, dto.clone());
            }
            Some(dto)
        }));
    }

    // 5) Antigravity（托管多号或本机默认）
    let agy_base = alloc_order();
    let agy_sink = sink.clone();
    let agy_task = tauri::async_runtime::spawn(async move {
        if agy_managed.is_empty() {
            let mut row = query_agy_row(force, now).await?;
            if let Some(b) = agy_default {
                if !b.name.trim().is_empty() {
                    row.gateway_name = b.name.clone();
                }
                row.binding_id = Some(b.id);
                row.account_hint = b.official_ref.and_then(|r| r.account_hint);
            }
            if let Some(ref sk) = agy_sink {
                sk.push(agy_base, row.clone());
            }
            return Some(vec![row]);
        }
        let active_sid = tauri::async_runtime::spawn_blocking(
            crate::official_accounts::agy_active_snapshot_id,
        )
        .await
        .ok()
        .flatten();
        let mut handles = Vec::new();
        for (i, b) in agy_managed.into_iter().enumerate() {
            let slot_order = agy_base + i;
            let row_id = format!("{AGY_ROW_PREFIX}{}", b.id);
            let row_name = if b.name.trim().is_empty() {
                ROW_NAME.to_string()
            } else {
                b.name.clone()
            };
            let sid = b
                .official_ref
                .as_ref()
                .and_then(|r| r.snapshot_id.clone());
            let hint = b
                .official_ref
                .as_ref()
                .and_then(|r| r.account_hint.clone());
            let is_active = sid.is_some() && active_sid == sid;
            let bid = b.id.clone();
            let s = agy_sink.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                let dto = if !force {
                    if let Some(mut hit) = cache_get(&row_id, now) {
                        hit.is_active_slot = Some(is_active);
                        hit
                    } else if let Some(snapshot_id) = sid {
                        settle_fresh(
                            query_agy_snapshot_api(&row_id, &row_name, Some(bid), hint, &snapshot_id, is_active)
                                .await,
                        )
                    } else {
                        let mut dto = blank_official_row(
                            &row_id,
                            &row_name,
                            "agy",
                            None,
                            AGY_CONSOLE_URL,
                            Some(bid),
                            hint,
                            Some(false),
                        );
                        dto.error = Some("该 Antigravity 账号尚未收录凭证，请到连接页收录".into());
                        dto
                    }
                } else if let Some(snapshot_id) = sid {
                    settle_fresh(
                        query_agy_snapshot_api(&row_id, &row_name, Some(bid), hint, &snapshot_id, is_active)
                            .await,
                    )
                } else {
                    let mut dto = blank_official_row(
                        &row_id,
                        &row_name,
                        "agy",
                        None,
                        AGY_CONSOLE_URL,
                        Some(bid),
                        hint,
                        Some(false),
                    );
                    dto.error = Some("该 Antigravity 账号尚未收录凭证，请到连接页收录".into());
                    dto
                };
                if let Some(ref sk) = s {
                    sk.push(slot_order, dto.clone());
                }
                dto
            }));
        }
        let mut rows = Vec::new();
        for h in handles {
            if let Ok(r) = h.await {
                rows.push(r);
            }
        }
        Some(rows)
    });

    let mut out = Vec::new();
    for t in tasks {
        if let Ok(Some(dto)) = t.await {
            out.push(dto);
        }
    }
    if let Ok(Some(agy_rows)) = agy_task.await {
        out.extend(agy_rows);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_creds_need_claude_ai_oauth_and_keep_dead_signin_row() {
        let c = parse_claude_creds(
            r#"{"claudeAiOauth":{"accessToken":"t","expiresAt":5,"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}"#,
        )
        .unwrap();
        assert_eq!(c.token, "t");
        assert_eq!(c.expires_at, Some(5));
        assert_eq!(c.plan.as_deref(), Some("Max 20x"));
        // 2026-11-15 本机实况：未手动 logout，invalid_grant 后 Claude Code 清空 accessToken/refreshToken 并置 expiresAt=0，仍保留套餐
        let dead = parse_claude_creds(
            r#"{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,"subscriptionType":"pro","subscriptionTypeSource":"sign_in","rateLimitTier":"default_claude_ai"}}"#,
        )
        .unwrap();
        assert_eq!(dead.token, "");
        assert_eq!(dead.expires_at, Some(0));
        assert_eq!(dead.plan.as_deref(), Some("Pro"));
        // 完全空的残壳（无套餐、无 sign_in、无 expiresAt=0）不算登录
        assert!(parse_claude_creds(r#"{"claudeAiOauth":{}}"#).is_none());
        // 只有 mcpOAuth 的那一项不算登录
        assert!(parse_claude_creds(r#"{"mcpOAuth":{"x":{"accessToken":"t"}}}"#).is_none());
        assert!(parse_claude_creds("not json").is_none());
        assert_eq!(claude_plan_label(Some("pro"), Some("default_claude_ai")).as_deref(), Some("Pro"));
    }

    #[test]
    fn agy_usage_maps_only_own_gemini_buckets() {
        let body = serde_json::json!({
            "status": "SUCCESS",
            "command": {
                "name": "usage",
                "data": {
                    "groups": [
                        {
                            "name": "Gemini Models",
                            "buckets": [
                                {"id": "gemini-weekly", "remaining_fraction": 0.75, "reset_time": "2026-11-21T22:42:06Z"},
                                {"id": "gemini-5h", "remaining_fraction": 1.0, "reset_time": "2026-11-15T10:00:00Z"},
                                {"id": "gemini-argon-wtu-weekly", "remaining_fraction": 0.6, "reset_time": "2026-11-21T22:42:06Z"}
                            ]
                        },
                        {
                            "name": "Claude and GPT models",
                            "buckets": [
                                {"id": "3p-weekly", "remaining_fraction": 0.1, "reset_time": "2026-11-21T22:42:06Z"},
                                {"id": "unknown-bucket", "remaining_fraction": 0.5}
                            ]
                        }
                    ]
                }
            }
        });
        let w = parse_agy_usage(&body).unwrap();
        assert_eq!(
            w.iter().map(|x| x.window.as_str()).collect::<Vec<_>>(),
            ["five_hour", "weekly", "agy_argon_weekly"]
        );
        assert_eq!(w[0].used_percent.round(), 0.0);
        assert_eq!(w[1].used_percent.round(), 25.0);
        assert_eq!(w[2].used_percent.round(), 40.0);
        assert!(parse_agy_usage(&serde_json::json!({"status": "ERROR"})).is_err());
        let loc_err = parse_agy_usage(&serde_json::json!({
            "status": "ERROR",
            "error": "Your current account is not eligible for Gemini Code Assist for individuals because it is not currently available in your location."
        }))
        .unwrap_err();
        assert!(loc_err.contains("Error 1008"));
        assert_eq!(
            blank_row(AGY_ROW_ID, "agy", None, AGY_CONSOLE_URL).console_url,
            "https://antigravity.google"
        );
    }

    #[test]
    fn claude_keychain_service_hashes_config_dir() {
        assert_eq!(claude_keychain_service(None), "Claude Code-credentials");
        assert_eq!(claude_keychain_service(Some("  ")), "Claude Code-credentials");
        let s = claude_keychain_service(Some("/tmp/claude"));
        assert!(s.starts_with("Claude Code-credentials-"));
        assert_eq!(s.len(), "Claude Code-credentials-".len() + 8);
        assert_eq!(claude_keychain_account("alice.b"), "alice.b");
        assert_eq!(claude_keychain_account("张三"), "claude-code-user");
    }

    #[test]
    fn claude_usage_maps_five_hour_and_week() {
        // 2026-10-31 本机实测形状：5 小时窗没开始时 resets_at 为 null
        let body = serde_json::json!({
            "five_hour": {"utilization": 0.0, "resets_at": null},
            "seven_day": {"utilization": 51.0, "resets_at": "2026-11-01T21:00:00.356855+00:00"},
            "seven_day_opus": null,
        });
        let w = parse_claude_usage(&body).unwrap();
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].window, "five_hour");
        assert_eq!(w[0].resets_at, None);
        assert_eq!(w[1].window, "weekly");
        assert_eq!(w[1].used_percent, 51.0);
        assert_eq!(w[1].resets_at, Some(1_793_566_800_356));
        assert!(parse_claude_usage(&serde_json::json!({"five_hour": null})).is_err());
    }

    #[test]
    fn codex_reset_credits_only_unexpired_available_earliest_first() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-04T00:00:00Z").unwrap().timestamp_millis();
        let body = serde_json::json!({
            "available_count": 9,
            "credits": [
                {"id": "a", "status": "available", "expires_at": "2026-10-20T00:00:00Z"},
                {"id": "b", "status": "available", "expires_at": "2026-10-03T00:00:00Z"},
                {"id": "c", "status": "redeemed", "expires_at": "2026-10-30T00:00:00Z"},
                {"id": "d", "status": "available", "expires_at": null},
                {"id": "e", "status": "available", "expires_at": "2026-10-08T12:00:00Z"}
            ]
        });
        let cards = parse_codex_reset_credits(&body, now).unwrap();
        assert_eq!(cards.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["e", "a", "d"]);
        assert!(parse_codex_reset_credits(&serde_json::json!({"available_count": 3}), now).is_err());
        assert_eq!(
            codex_applicable_cards(&serde_json::json!({"rate_limit_reset_credits": {"available_count": 2, "applicable_available_count": 0}})),
            Some(0)
        );
        assert_eq!(codex_applicable_cards(&serde_json::json!({})), None);
    }

    #[test]
    fn codex_creds_skip_api_key_mode_and_read_login_stash() {
        let c = parse_codex_creds(r#"{"tokens":{"access_token":"a","account_id":"acc"}}"#).unwrap();
        assert_eq!(c.token, "a");
        assert_eq!(c.account_id.as_deref(), Some("acc"));
        assert!(parse_codex_creds(r#"{"OPENAI_API_KEY":"sk-x","tokens":null}"#).is_none());
        let stashed = parse_codex_stash(
            r#"{"last":"sub:u|account:acc","logins":{"sub:u|account:acc":{"tokens":{"access_token":"st","account_id":"acc"}}}}"#,
        )
        .unwrap();
        assert_eq!(stashed.token, "st");
        assert_eq!(stashed.account_id.as_deref(), Some("acc"));
        // 真在 Codex 登出后 last 为空：不复活旧暂存
        assert!(parse_codex_stash(
            r#"{"last":null,"logins":{"sub:u|account:acc":{"tokens":{"access_token":"st"}}}}"#,
        )
        .is_none());
    }

    #[test]
    fn codex_usage_classifies_by_window_length() {
        // 免费档实测：只有一个 30 天主窗
        let free = serde_json::json!({
            "plan_type": "free",
            "rate_limit": {
                "primary_window": {"used_percent": 6, "limit_window_seconds": 2592000, "reset_at": 1795755014},
                "secondary_window": null
            }
        });
        let (plan, w) = parse_codex_usage(&free, 0).unwrap();
        assert_eq!(plan.as_deref(), Some("Free"));
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].window, "monthly");
        assert_eq!(w[0].resets_at, Some(1_795_755_014_000));
        // 付费档：5 小时 + 周；窗长缺失按主 / 副兜底，reset_after_seconds 补重置时间
        let plus = serde_json::json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": {"used_percent": 30, "limit_window_seconds": 18000, "reset_after_seconds": 60},
                "secondary_window": {"used_percent": 80}
            }
        });
        let (_, w) = parse_codex_usage(&plus, 1000).unwrap();
        assert_eq!(w.iter().map(|x| x.window.as_str()).collect::<Vec<_>>(), ["five_hour", "weekly"]);
        assert_eq!(w[0].resets_at, Some(61_000));
        assert!(parse_codex_usage(&serde_json::json!({"plan_type": "plus"}), 0).is_err());
    }

    #[test]
    fn grok_auth_prefers_oidc_and_distinguishes_refresh_pending_from_expired() {
        let now = 1_800_000_000;
        let json = r#"{
            "https://accounts.x.ai/sign-in": {"key": "legacy-tok"},
            "https://auth.x.ai::client": {
                "key": "oidc-tok",
                "refresh_token": "rt-1",
                "expires_at": "2030-01-01T00:00:00Z"
            }
        }"#;
        let c = parse_grok_auth_json(json, now).unwrap();
        assert_eq!(c.token, "oidc-tok");
        assert_eq!(c.state, GrokTokenState::Valid);

        let pending_json = r#"{
            "https://auth.x.ai::client": {
                "key": "oidc-tok",
                "refresh_token": "rt-1",
                "expires_at": "2020-01-01T00:00:00Z"
            }
        }"#;
        let p = parse_grok_auth_json(pending_json, now).unwrap();
        assert_eq!(p.state, GrokTokenState::RefreshPending);

        let expired_json = r#"{
            "https://auth.x.ai::client": {
                "key": "oidc-tok",
                "expires_at": "2020-01-01T00:00:00Z"
            }
        }"#;
        let e = parse_grok_auth_json(expired_json, now).unwrap();
        assert_eq!(e.state, GrokTokenState::Expired);
    }

    #[test]
    fn grok_billing_protobuf_and_plan_parsing() {
        // 构造一个包含 field 1 = float 42.5 (wire 5: tag 0x0d) 与未来时间戳的 gRPC-web 帧
        let mut msg = Vec::new();
        msg.push((1 << 3) | 5);
        msg.extend_from_slice(&42.5_f32.to_le_bytes());
        // field 2 varint = 1_800_600_000 (约 7 天后)
        msg.push((2 << 3) | 0);
        let mut ts: u64 = 1_800_600_000;
        loop {
            let mut b = (ts & 0x7F) as u8;
            ts >>= 7;
            if ts != 0 {
                b |= 0x80;
            }
            msg.push(b);
            if ts == 0 {
                break;
            }
        }
        let mut frame = vec![0u8];
        frame.extend_from_slice(&(msg.len() as u32).to_be_bytes());
        frame.extend_from_slice(&msg);

        let (pct, reset) = grok_parse_billing_payload(&frame, 1_800_000_000).unwrap();
        assert!((pct - 42.5).abs() < 0.01);
        assert_eq!(reset, Some(1_800_600_000));
        assert_eq!(grok_window_for_reset(reset, 1_800_000_000), WINDOW_WEEKLY);

        assert_eq!(
            grok_parse_plan(&serde_json::json!({"subscription_tier_display": "SuperGrok Heavy"})).as_deref(),
            Some("SuperGrok Heavy")
        );
        assert_eq!(
            grok_parse_plan(&serde_json::json!({"settings": {"subscription_tier": "SUPERGROK"}})).as_deref(),
            Some("SuperGrok")
        );
    }

    #[test]
    fn kimi_official_creds_readonly_states_and_me_parsing() {
        let now = 1_800_000_000;
        let valid = parse_kimi_official_creds(
            r#"{"access_token":"at","refresh_token":"rt","expires_at":1800003600}"#,
            KIMI_DEFAULT_BASE_URL.into(),
            "dev1".into(),
            now,
        )
        .unwrap();
        assert_eq!(valid.state, KimiTokenState::Valid);

        let pending = parse_kimi_official_creds(
            r#"{"access_token":"at","refresh_token":"rt","expires_at":1700000000}"#,
            KIMI_DEFAULT_BASE_URL.into(),
            "dev1".into(),
            now,
        )
        .unwrap();
        assert_eq!(pending.state, KimiTokenState::RefreshPending);

        let revoked = parse_kimi_official_creds(
            r#"{"access_token":"","refresh_token":"","expires_at":0}"#,
            KIMI_DEFAULT_BASE_URL.into(),
            "dev1".into(),
            now,
        )
        .unwrap();
        assert_eq!(revoked.state, KimiTokenState::Expired);

        let (plan, nick) = parse_kimi_me(&serde_json::json!({
            "user_level_name": "Allegretto",
            "nickname": "Alice"
        }));
        assert_eq!(plan.as_deref(), Some("Allegretto"));
        assert_eq!(nick.as_deref(), Some("Alice"));
    }
}
