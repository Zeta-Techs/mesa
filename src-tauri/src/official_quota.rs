//! 订阅余量卡的官方账号行（2026-10-31）：Claude Code 登录的 Claude 订阅（Pro / Max）与 Codex 登录的
//! ChatGPT 套餐。与网关行共用 `subscription_quota` 的 DTO、2 分钟缓存与失败回落；接口口径参照
//! `.reference/paseo` 的 claude-usage-source / codex-usage-source 两个插件，2026-10-31 本机实测过响应形状。
//! - Claude：凭证只读 CLI 自己的登录存储——macOS 钥匙串 `Claude Code-credentials`（设了 CLAUDE_CONFIG_DIR 时
//!   服务名追加目录 sha256 前 8 位），先带账户名查、再不带账户名查（本机实测另有一项只装 mcpOAuth，不带账户名
//!   先命中它）；其他平台读 `{配置目录}/.credentials.json`。只认 `claudeAiOauth.accessToken`。
//!   GET https://api.anthropic.com/api/oauth/usage（Bearer + `anthropic-beta: oauth-2025-04-20`）：
//!   five_hour / seven_day 的 utilization（0-100）+ resets_at（ISO，5 小时窗没开始时为 null）。
//!   按模型 / 按入口的周限额（seven_day_opus、limits[] weekly_scoped）卡面暂不展示。
//! - Codex：`{CODEX_HOME|~/.codex}/auth.json` 的 tokens.access_token（+ account_id 头）；API Key 模式无此字段，不出行。
//!   GET https://chatgpt.com/backend-api/wham/usage：rate_limit.primary_window / secondary_window 的
//!   used_percent + reset_at（秒）+ limit_window_seconds，按窗长归 5 小时 / 周 / 月（免费档实测只有 30 天窗）。
//! - Codex 重置卡（2026-10-31）：GET wham/rate-limit-reset-credits 列卡（credits[] 的 id / status / expires_at，
//!   不信 available_count，只数 status==available 且没过期的；cc-switch 同口径），wham/usage 的
//!   rate_limit_reset_credits.applicable_available_count 是「此刻能用」的张数——没被限额卡住时恒 0。
//!   用卡 POST wham/rate-limit-reset-credits/consume，body {credit_id, redeem_request_id}（codex2api / ai-tools-mng 两家实现一致；
//!   redeem_request_id 是幂等键）。消费性写操作：只经显式命令 + 前端确认触发，挑最早过期的那张；此刻用不了时不发请求。
//! 纪律：令牌只在本模块内存里经过，不进 DTO / 日志；**绝不刷新、绝不回写**——令牌过期就请用户跑一次 CLI，
//! 由 CLI 自己续期（刷新会轮换令牌，等于改 CLI 的登录存储）。查询走设置里的出网代理（与官方账号启动同源），
//! 没配就按系统环境直连。

use crate::subscription_quota::{
    cache_get, now_ms, settle_fresh, PlanQuotaDto, PlanQuotaWindowDto, PlanResetCardsDto,
    WINDOW_FIVE_HOUR, WINDOW_MONTHLY, WINDOW_WEEKLY,
};
use std::time::Duration;

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA: &str = "oauth-2025-04-20";
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

const CLAUDE_ROW_ID: &str = "official:claude-code";
pub(crate) const CODEX_ROW_ID: &str = "official:codex";
const ROW_NAME: &str = "官方账号";

struct ClaudeCreds {
    token: String,
    expires_at: Option<i64>,
    plan: Option<String>,
}

struct CodexCreds {
    token: String,
    account_id: Option<String>,
}

// ===== 凭证（只读） =====

/// 钥匙串项里的 JSON → 凭证；只认 claudeAiOauth.accessToken（另一项只有 mcpOAuth，不算）
fn parse_claude_creds(text: &str) -> Option<ClaudeCreds> {
    let v: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    let oa = v.get("claudeAiOauth")?;
    let token = oa.get("accessToken")?.as_str()?.trim().to_string();
    if token.is_empty() {
        return None;
    }
    Some(ClaudeCreds {
        token,
        expires_at: oa.get("expiresAt").and_then(|x| x.as_i64()),
        plan: claude_plan_label(
            oa.get("subscriptionType").and_then(|x| x.as_str()),
            oa.get("rateLimitTier").and_then(|x| x.as_str()),
        ),
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

/// 读 Claude Code 的登录凭证（阻塞：macOS 要跑 security），读不到返回 None
fn read_claude_creds() -> Option<ClaudeCreds> {
    if cfg!(test) {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        let config_dir = std::env::var("CLAUDE_CONFIG_DIR").ok();
        let service = claude_keychain_service(config_dir.as_deref());
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
    let path = crate::agent_specs::agent_config_root("claude-code")?.join(".credentials.json");
    parse_claude_creds(&std::fs::read_to_string(path).ok()?)
}

/// Codex auth.json → 凭证；API Key 模式（只有 OPENAI_API_KEY）返回 None
fn parse_codex_creds(text: &str) -> Option<CodexCreds> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
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

fn read_codex_creds() -> Option<CodexCreds> {
    if cfg!(test) {
        return None;
    }
    let path = crate::agent_specs::agent_config_root("codex")?.join("auth.json");
    parse_codex_creds(&std::fs::read_to_string(path).ok()?)
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
    }
}

async fn get_json(req: reqwest::RequestBuilder) -> Result<(u16, serde_json::Value), String> {
    let resp = req.send().await.map_err(|e| format!("网络错误: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    Ok((status, serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)))
}

async fn query_claude(creds: ClaudeCreds) -> PlanQuotaDto {
    let mut dto = blank_row(CLAUDE_ROW_ID, "claude", creds.plan.clone(), "https://claude.ai/settings/usage");
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

async fn query_codex(creds: CodexCreds) -> PlanQuotaDto {
    let mut dto = blank_row(CODEX_ROW_ID, "codex", None, "https://chatgpt.com/codex/settings/usage");
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

/// 用一张 Codex 重置卡（消费性写操作，前端已确认）：此刻用不了就不发请求；挑最早过期的一张；成功后作废缓存重查
pub async fn use_codex_reset_card() -> Result<PlanQuotaDto, String> {
    let creds = tauri::async_runtime::spawn_blocking(read_codex_creds)
        .await
        .ok()
        .flatten()
        .ok_or_else(|| "读不到 Codex 的登录信息：先用 ChatGPT 账号登录 Codex".to_string())?;
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
    crate::subscription_quota::cache_invalidate(CODEX_ROW_ID);
    Ok(settle_fresh(query_codex(creds).await))
}

/// 两家官方账号的行：哪家本机登录了官方账号才出哪家；没登录不出行（不是错误）
pub async fn official_rows(force: bool) -> Vec<PlanQuotaDto> {
    // 读钥匙串要跑 security 子进程：放阻塞线程，不占异步运行时
    let (claude, codex) = tauri::async_runtime::spawn_blocking(|| (read_claude_creds(), read_codex_creds()))
        .await
        .unwrap_or((None, None));
    let now = now_ms();
    let mut out = Vec::new();
    if let Some(creds) = claude {
        out.push(match cache_get(CLAUDE_ROW_ID, now).filter(|_| !force) {
            Some(hit) => hit,
            None => settle_fresh(query_claude(creds).await),
        });
    }
    if let Some(creds) = codex {
        out.push(match cache_get(CODEX_ROW_ID, now).filter(|_| !force) {
            Some(hit) => hit,
            None => settle_fresh(query_codex(creds).await),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_creds_need_claude_ai_oauth() {
        let c = parse_claude_creds(
            r#"{"claudeAiOauth":{"accessToken":"t","expiresAt":5,"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}"#,
        )
        .unwrap();
        assert_eq!(c.token, "t");
        assert_eq!(c.expires_at, Some(5));
        assert_eq!(c.plan.as_deref(), Some("Max 20x"));
        // 只有 mcpOAuth 的那一项不算登录
        assert!(parse_claude_creds(r#"{"mcpOAuth":{"x":{"accessToken":"t"}}}"#).is_none());
        assert!(parse_claude_creds("not json").is_none());
        assert_eq!(claude_plan_label(Some("pro"), Some("default_claude_ai")).as_deref(), Some("Pro"));
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
    fn codex_creds_skip_api_key_mode() {
        let c = parse_codex_creds(r#"{"tokens":{"access_token":"a","account_id":"acc"}}"#).unwrap();
        assert_eq!(c.token, "a");
        assert_eq!(c.account_id.as_deref(), Some("acc"));
        assert!(parse_codex_creds(r#"{"OPENAI_API_KEY":"sk-x","tokens":null}"#).is_none());
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
}
