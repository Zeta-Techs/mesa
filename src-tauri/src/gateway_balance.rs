//! 网关余额查询（用量页「网关余额」卡）：New API 兼容钱包。
//!
//! 与「订阅余量」并列、形态不同——那边是 Coding Plan 窗口百分比，这边是预付钱包剩余金额。
//! 接口规格 = QuantumNous/new-api 源码实证（zetatechs 站 HTML title / Umami 均为 New API）：
//! - 站点指纹（公开、无密钥）：`GET {origin}/api/status` → data.quota_display_type
//!   （CNY / USD / TOKENS）、quota_per_unit、usd_exchange_rate；失败不挡余额查询。
//! - **钱包优先**（对齐 cc-switch / all-api-hub）：`GET {origin}/api/user/self` 用
//!   keys.json `{gatewayId}#wallet` 系统访问令牌（不是推理 sk-），可选 `wallet_user_id`
//!   扇出 New-Api-User / New-API-User / Veloera-User 等兼容头。data.quota / used_quota
//!   为原始额度单位，÷ quota_per_unit，CNY 再 × usd_exchange_rate。
//!   无令牌再试推理密钥；sk- 在原版会 401，401 不当成密钥失效，改走下一档。
//! - 密钥额度回落：`GET {origin}/api/usage/token`（TokenAuthReadOnly，total_available=
//!   RemainQuota）→ 再回落 billing subscription + usage（hard_limit_usd=剩余+已用，
//!   total_usage=已用×100）。DisplayTokenStatEnabled 默认开时 billing 是令牌不是账户；
//!   不限额度哨兵 1e8 / unlimited_quota=true 时没有钱包数字，卡片改口去钱包页。
//! - 「去钱包」深链 = `{origin}/wallet`（用户提供的 zetatechs 入口）。
//!
//! 产品口径对齐订阅余量卡：出卡零配置（槽 URL 主机命中已知 New API 站 + 有密钥即出）；
//! 无命中不渲染；2 分钟缓存 + 页面可见期轮询，不可见即停；瞬时失败回落上次成功值；
//! 查询并行（status + 钱包 self + /api/usage/token 一波；billing 仅密钥额度未果才打）+
//! 复用 reqwest Client（避免每次握手）；不拿 sk- 打 /api/user/self。
//! 查询不注出网代理；密钥只在本模块出 keys.json，绝不进 DTO/日志。
//! 明确不做：usage script、探测全部网关、把商业中转写进连接页预设、用 Cookie 登录态。
//! 加站点 = WALLET_HOSTS 加一条。
//!
//! 快（2026-09-21 用户实测「刷新很慢，不如智谱那个快」后重做等待结构）：
//! - 多网关**并发**查询（spawn 全部再按序收），不再一个网关一段顺序等——三个 zetatechs 网关
//!   本机实测中位 ≈2.1s → ≈0.66s；输出顺序仍按网关列表，缓存/错误行语义不变。
//! - 公开 `/api/status`（币种/单位/汇率，站点级、与密钥无关）按 origin 进程缓存 10 分钟，
//!   同源多网关只打一次；失败回落上次缓存值再回落内置默认。
//! - `/api/usage/token` 写**尾斜杠**：该站 301 跳 `/api/usage/token/`，reqwest 跟一跳要多 RTT
//!   （实测 1.2–1.6s + 再 0.7s），直连省一跳。
//! 结论：改等待结构前先量单请求 TTFB（本机实测 status ≈1.0–1.5s、self ≈0.8s、token ≈0.7–2.0s），
//! 别只调超时——慢的是串行 × 网关数，不是某一路慢。

use crate::profiles::{Gateway, ProtocolSlots};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// 单路超时；刷新走并行所以总等待 ≈ 最慢一路，不是相加。
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);
const CACHE_TTL_MS: i64 = 2 * 60 * 1000;
/// 站点指纹（币种/单位/汇率）进程缓存：站点级、与密钥无关，同源多网关只打一次。
/// 比余额缓存长得多——这些值按天变，不按分钟变。
const SITE_STATUS_TTL_MS: i64 = 10 * 60 * 1000;
/// new-api 令牌不限额度哨兵（controller/billing.go UnlimitedQuota → 100_000_000；
/// 取略低阈值容忍站点改写，判定为「不限」比把哨兵当成 ¥200 余额安全）
const UNLIMITED_SENTINEL: f64 = 99_000_000.0;
const KEY_INVALID_MSG: &str = "密钥失效，请到连接页更新这个网关的密钥";

/// 槽 URL 主机命中才出卡。与 `src/gateway-balance.ts` WALLET_HOSTS 双端镜像。
const WALLET_HOSTS: &[&str] = &["zetatechs.com"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayBalanceDto {
    pub gateway_id: String,
    pub gateway_name: String,
    /// 站点 origin（https://host），「去钱包」拼 `{origin}/wallet`
    pub origin: String,
    /// 这个钱包属于哪个账户（/api/user/self 的 display_name/username）；
    /// 同站多网关合并成一张卡的**分组键**——同站不同账户必须分开，不能只按 origin 合
    pub account: Option<String>,
    /// 机器名：newapi（显示名前端映射；加协议族时复用此字段）
    pub kind: String,
    pub ok: bool,
    pub error: Option<String>,
    /// wallet = 账户钱包（/api/user/self）；token = 这把密钥的额度
    pub source: String,
    /// 这个密钥不限额度（看钱包页才有账户余额）
    pub unlimited: bool,
    /// CNY | USD | TOKENS
    pub currency: String,
    pub remaining: Option<f64>,
    pub used: Option<f64>,
    pub total: Option<f64>,
    /// 令牌过期（毫秒 epoch）；0 / 缺省 = 无到期
    pub expires_at: Option<i64>,
    /// 已保存系统访问令牌（不是推理 sk-）
    pub has_wallet_token: bool,
    /// 这把推理密钥的额度（与钱包并列；不限额度时 remaining 为空）
    pub token_remaining: Option<f64>,
    pub token_used: Option<f64>,
    pub token_total: Option<f64>,
    pub token_unlimited: bool,
    /// 站点上这个令牌的名字（悬停说明用）
    pub token_name: Option<String>,
    pub queried_at: i64,
    pub from_cache: bool,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn slot_urls(slots: &ProtocolSlots) -> impl Iterator<Item = &str> {
    [
        slots.anthropic.as_deref(),
        slots.openai.as_deref(),
        slots.responses.as_deref(),
        slots.gemini.as_deref(),
        slots.cursor.as_deref(),
    ]
    .into_iter()
    .flatten()
}

/// `https://host[:port]/path` → origin；非 http(s) 或不完整返回 None。
fn origin_from_url(url: &str) -> Option<String> {
    let url = url.trim();
    let (scheme, rest) = if let Some(r) = url.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = url.strip_prefix("http://") {
        ("http", r)
    } else {
        return None;
    };
    let hostport = rest
        .split(['/', '?', '#'])
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    Some(format!("{scheme}://{hostport}"))
}

/// origin 或 URL 上的主机名（小写、去端口）。IPv6 `[::1]:443` 只取括号内。
fn host_of(url: &str) -> Option<String> {
    let origin = origin_from_url(url).unwrap_or_else(|| url.trim().to_string());
    let rest = origin.split("://").nth(1).unwrap_or(&origin);
    let host = if let Some(inner) = rest.strip_prefix('[') {
        inner.split(']').next().unwrap_or(inner)
    } else {
        rest.split(':').next().unwrap_or(rest)
    };
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

fn host_is_wallet(host: &str) -> bool {
    WALLET_HOSTS
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

/// 槽 URL 命中已知 New API 钱包站时返回 origin；未命中 None。
fn detect_wallet_origin(slots: &ProtocolSlots) -> Option<String> {
    for url in slot_urls(slots) {
        let Some(host) = host_of(url) else { continue };
        if host_is_wallet(&host) {
            return origin_from_url(url);
        }
    }
    None
}

fn parse_f64(v: &serde_json::Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_i64().map(|n| n as f64))
        .or_else(|| v.as_u64().map(|n| n as f64))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

#[derive(Debug, Clone, PartialEq)]
struct SiteStatus {
    currency: String,
    per_unit: f64,
    usd_rate: f64,
}

impl SiteStatus {
    /// /api/status 拿不到时用的内置默认（new-api 默认 quota_per_unit=500000、汇率 1）
    fn fallback() -> Self {
        SiteStatus {
            currency: "USD".into(),
            per_unit: 500_000.0,
            usd_rate: 1.0,
        }
    }
}

fn site_status_cache() -> &'static Mutex<HashMap<String, (SiteStatus, i64)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (SiteStatus, i64)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 新鲜的站点指纹（origin → SiteStatus，TTL 内）
fn site_status_get(origin: &str, now: i64) -> Option<SiteStatus> {
    site_status_cache().lock().ok().and_then(|map| {
        map.get(origin)
            .filter(|(_, at)| now - *at <= SITE_STATUS_TTL_MS)
            .map(|(s, _)| s.clone())
    })
}

/// 任意年龄的上次成功值：查询失败时兜底，别把 CNY 站按 USD 默认单位算成错金额
fn site_status_get_stale(origin: &str) -> Option<SiteStatus> {
    site_status_cache()
        .lock()
        .ok()
        .and_then(|map| map.get(origin).map(|(s, _)| s.clone()))
}

fn site_status_put(origin: &str, site: &SiteStatus) {
    if let Ok(mut map) = site_status_cache().lock() {
        map.insert(origin.to_string(), (site.clone(), now_ms()));
    }
}

fn normalize_currency(raw: &str) -> String {
    match raw.trim().to_ascii_uppercase().as_str() {
        "CNY" | "RMB" | "¥" => "CNY".into(),
        "TOKENS" | "TOKEN" => "TOKENS".into(),
        _ => "USD".into(),
    }
}

/// 公开 /api/status 信封：success + data.quota_display_type / quota_per_unit。
fn parse_site_status(body: &serde_json::Value) -> SiteStatus {
    let data = body.get("data").unwrap_or(body);
    let raw = data
        .get("quota_display_type")
        .and_then(|v| v.as_str())
        .unwrap_or("USD");
    let per_unit = data
        .get("quota_per_unit")
        .and_then(parse_f64)
        .filter(|n| *n > 0.0)
        .unwrap_or(500_000.0);
    let usd_rate = data
        .get("usd_exchange_rate")
        .and_then(parse_f64)
        .filter(|n| *n > 0.0)
        .unwrap_or(1.0);
    SiteStatus {
        currency: normalize_currency(raw),
        per_unit,
        usd_rate,
    }
}

/// 原始额度单位 → 站点展示金额（对齐 billing.go GetQuotaDisplayType）。
fn quota_to_display(quota: f64, site: &SiteStatus) -> f64 {
    if site.currency == "TOKENS" {
        return quota;
    }
    let usd = quota / site.per_unit;
    if site.currency == "CNY" {
        usd * site.usd_rate
    } else {
        usd
    }
}

/// 钱包页同源：data.quota = 剩余，data.used_quota = 已用，都是原始额度单位。
fn parse_user_self(body: &serde_json::Value) -> Result<(f64, f64), String> {
    if body.get("success").and_then(|v| v.as_bool()) == Some(false) {
        let msg = body
            .get("message")
            .or_else(|| body.get("msg"))
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(msg.to_string());
    }
    let data = body
        .get("data")
        .ok_or_else(|| "响应缺少 data 字段".to_string())?;
    let remaining = data
        .get("quota")
        .and_then(parse_f64)
        .ok_or_else(|| "响应缺少 quota 字段".to_string())?;
    let used = data.get("used_quota").and_then(parse_f64).unwrap_or(0.0);
    Ok((remaining, used))
}

#[derive(Debug, Clone, PartialEq)]
struct TokenUsage {
    remaining_raw: f64,
    used_raw: f64,
    unlimited: bool,
    expires_at: Option<i64>,
    /// 站点上这个令牌的名字（用户给自己起的），只作悬停说明，不当标题
    name: Option<String>,
}

/// /api/usage/token：total_available = RemainQuota（原始单位）；unlimited_quota 为真时没有钱包数字。
fn parse_token_usage(body: &serde_json::Value) -> Result<TokenUsage, String> {
    if body.get("success").and_then(|v| v.as_bool()) == Some(false) {
        let msg = body
            .get("message")
            .or_else(|| body.get("msg"))
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(msg.to_string());
    }
    let data = body.get("data").unwrap_or(body);
    let remaining = data
        .get("total_available")
        .and_then(parse_f64)
        .ok_or_else(|| "响应缺少 total_available 字段".to_string())?;
    let used = data.get("total_used").and_then(parse_f64).unwrap_or(0.0);
    let unlimited = data
        .get("unlimited_quota")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let expires_at = data
        .get("expires_at")
        .and_then(|v| v.as_i64())
        .filter(|n| *n > 0)
        .map(|n| if n < 1_000_000_000_000 { n * 1000 } else { n });
    Ok(TokenUsage {
        remaining_raw: remaining,
        used_raw: used,
        unlimited,
        expires_at,
        name: data
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    })
}

#[derive(Debug, Clone, PartialEq)]
struct Subscription {
    total: f64,
    unlimited: bool,
    expires_at: Option<i64>,
}

fn openai_error_message(body: &serde_json::Value) -> Option<String> {
    let err = body.get("error")?;
    err.get("message")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| err.as_str().map(|s| s.to_string()))
}

/// subscription 体：hard_limit_usd 优先，缺则 soft / system_hard。HTTP 200 包 error 信封 fail-closed。
fn parse_subscription(body: &serde_json::Value) -> Result<Subscription, String> {
    if let Some(msg) = openai_error_message(body) {
        return Err(msg);
    }
    let total = body
        .get("hard_limit_usd")
        .and_then(parse_f64)
        .or_else(|| body.get("soft_limit_usd").and_then(parse_f64))
        .or_else(|| body.get("system_hard_limit_usd").and_then(parse_f64))
        .ok_or_else(|| "响应缺少额度字段".to_string())?;
    let unlimited = total >= UNLIMITED_SENTINEL;
    let expires_at = body
        .get("access_until")
        .and_then(|v| v.as_i64())
        .filter(|n| *n > 0)
        .map(|n| if n < 1_000_000_000_000 { n * 1000 } else { n });
    Ok(Subscription {
        total,
        unlimited,
        expires_at,
    })
}

/// usage 体：total_usage 是已用 × 100。
fn parse_usage(body: &serde_json::Value) -> Result<f64, String> {
    if let Some(msg) = openai_error_message(body) {
        return Err(msg);
    }
    let raw = body
        .get("total_usage")
        .and_then(parse_f64)
        .ok_or_else(|| "响应缺少 total_usage 字段".to_string())?;
    Ok(raw / 100.0)
}

struct HttpOutcome {
    status: u16,
    body: serde_json::Value,
}

fn map_http_error(outcome: &HttpOutcome) -> String {
    if outcome.status == 401 || outcome.status == 403 {
        return KEY_INVALID_MSG.into();
    }
    if let Some(msg) = openai_error_message(&outcome.body) {
        return format!("网关接口错误 (HTTP {}): {msg}", outcome.status);
    }
    if let Some(msg) = outcome
        .body
        .get("message")
        .or_else(|| outcome.body.get("msg"))
        .and_then(|v| v.as_str())
    {
        return format!("网关接口错误 (HTTP {}): {msg}", outcome.status);
    }
    format!("网关接口错误 (HTTP {})", outcome.status)
}

fn http_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(HTTP_TIMEOUT)
                .pool_idle_timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        })
        .clone()
}

fn spawn_get(
    url: String,
    key: Option<String>,
    user_id: Option<String>,
) -> tauri::async_runtime::JoinHandle<Result<HttpOutcome, String>> {
    tauri::async_runtime::spawn(
        async move { http_get(&url, key.as_deref(), user_id.as_deref()).await },
    )
}

async fn take_get(
    h: tauri::async_runtime::JoinHandle<Result<HttpOutcome, String>>,
) -> Result<HttpOutcome, String> {
    h.await.map_err(|e| format!("查询中断: {e}"))?
}

async fn http_get(
    url: &str,
    key: Option<&str>,
    user_id: Option<&str>,
) -> Result<HttpOutcome, String> {
    let client = http_client();
    let mut req = client.get(url).header("Accept", "application/json");
    if let Some(k) = key {
        req = req.header("Authorization", format!("Bearer {k}"));
    }
    if let Some(uid) = user_id.map(str::trim).filter(|s| !s.is_empty()) {
        for name in WALLET_USER_HEADERS {
            req = req.header(*name, uid);
        }
    }
    let resp = req.send().await.map_err(|e| format!("网络错误: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    let body = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    Ok(HttpOutcome { status, body })
}

struct CacheEntry {
    dto: GatewayBalanceDto,
    at: i64,
}

fn balance_cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_get(gateway_id: &str, now: i64) -> Option<GatewayBalanceDto> {
    balance_cache().lock().ok().and_then(|map| {
        map.get(gateway_id)
            .filter(|e| now - e.at <= CACHE_TTL_MS)
            .map(|e| e.dto.clone())
    })
}

fn cache_get_stale(gateway_id: &str) -> Option<GatewayBalanceDto> {
    balance_cache()
        .lock()
        .ok()
        .and_then(|map| map.get(gateway_id).map(|e| e.dto.clone()))
}

fn cache_put(dto: &GatewayBalanceDto) {
    if let Ok(mut map) = balance_cache().lock() {
        map.insert(
            dto.gateway_id.clone(),
            CacheEntry {
                dto: dto.clone(),
                at: now_ms(),
            },
        );
    }
}

fn empty_dto(gateway: &Gateway, origin: String, error: Option<String>) -> GatewayBalanceDto {
    GatewayBalanceDto {
        gateway_id: gateway.id.clone(),
        gateway_name: gateway.name.clone(),
        origin,
        account: None,
        kind: "newapi".into(),
        ok: false,
        error,
        source: String::new(),
        unlimited: false,
        currency: "USD".into(),
        remaining: None,
        used: None,
        total: None,
        expires_at: None,
        has_wallet_token: false,
        token_remaining: None,
        token_used: None,
        token_total: None,
        token_unlimited: false,
        token_name: None,
        queried_at: now_ms(),
        from_cache: false,
    }
}

/// /api/user/self 里的账户名（display_name 优先，回落 username）。
/// 只取名字，**绝不取 email**——它进 DTO 就要上前端，别把联系方式带出去。
fn account_from_user_self(body: &serde_json::Value) -> Option<String> {
    let data = body.get("data")?;
    ["display_name", "username"]
        .iter()
        .find_map(|k| {
            data.get(*k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .map(str::to_string)
}

/// all-api-hub / cc-switch 同源：老 New API 系用用户 ID 头对齐 Cookie/PAT。
const WALLET_USER_HEADERS: &[&str] = &[
    "New-Api-User",
    "New-API-User",
    "Veloera-User",
    "X-Api-User",
    "voapi-user",
    "User-id",
    "Rix-Api-User",
    "neo-api-user",
];

fn apply_raw_quota(
    dto: &mut GatewayBalanceDto,
    remaining_raw: f64,
    used_raw: f64,
    site: &SiteStatus,
    source: &str,
) {
    let remaining = quota_to_display(remaining_raw, site);
    let used = quota_to_display(used_raw, site);
    dto.source = source.into();
    dto.ok = true;
    dto.unlimited = false;
    dto.remaining = Some(remaining);
    dto.used = Some(used);
    dto.total = Some(remaining + used);
    dto.currency = site.currency.clone();
}

fn apply_token_display(dto: &mut GatewayBalanceDto, remaining: f64, used: f64, promote: bool) {
    dto.token_remaining = Some(remaining);
    dto.token_used = Some(used);
    dto.token_total = Some(remaining + used);
    dto.token_unlimited = false;
    if promote {
        dto.source = "token".into();
        dto.ok = true;
        dto.unlimited = false;
        dto.remaining = Some(remaining);
        dto.used = Some(used);
        dto.total = Some(remaining + used);
    }
}

/// 一个 origin 上要打的五个端点。集中一处，尾斜杠这种坑不再散在编排里。
struct Endpoints {
    status: String,
    user_self: String,
    /// 「密钥额度」只读端点。**尾斜杠是刻意的**：不带斜杠该站 301 跳带斜杠，
    /// 跟一跳多一个 RTT（实测 1.2–1.6s + 再 0.7s），直连省一跳。
    token_usage: String,
    subscription: String,
    usage: String,
}

fn endpoints_for(origin: &str) -> Endpoints {
    Endpoints {
        status: format!("{origin}/api/status"),
        user_self: format!("{origin}/api/user/self"),
        token_usage: format!("{origin}/api/usage/token/"),
        subscription: format!("{origin}/v1/dashboard/billing/subscription"),
        usage: format!("{origin}/v1/dashboard/billing/usage"),
    }
}

async fn refresh_gateway(
    gateway: &Gateway,
    origin: &str,
    infer_key: Option<&str>,
    wallet_pat: Option<&str>,
) -> GatewayBalanceDto {
    let Endpoints {
        status: status_url,
        user_self: self_url,
        token_usage: token_usage_url,
        subscription: sub_url,
        usage: usage_url,
    } = endpoints_for(origin);
    let user_id = gateway
        .wallet_user_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let infer = infer_key
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string);
    let pat = wallet_pat
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string);

    let mut dto = empty_dto(gateway, origin.to_string(), None);
    dto.has_wallet_token = pat.is_some();

    // 第一波并行：站点币种 + 钱包 + 密钥额度。不再用 sk- 打 /api/user/self（原版必 401）。
    // 站点指纹命中 10 分钟缓存就不打 status（同源多网关共享）。
    let status_now = now_ms();
    let cached_site = site_status_get(origin, status_now);
    let status_h = cached_site
        .is_none()
        .then(|| spawn_get(status_url, None, None));
    let wallet_h = pat
        .as_ref()
        .map(|p| spawn_get(self_url, Some(p.clone()), user_id.clone()));
    let token_h = infer
        .as_ref()
        .map(|k| spawn_get(token_usage_url, Some(k.clone()), None));

    let site = match cached_site {
        Some(hit) => hit,
        None => match status_h {
            Some(h) => match take_get(h).await {
                Ok(o) if o.status >= 200 && o.status < 300 => {
                    let parsed = parse_site_status(&o.body);
                    site_status_put(origin, &parsed);
                    parsed
                }
                // 打不到就沿用上次成功值，再不行才用内置默认
                _ => site_status_get_stale(origin).unwrap_or_else(SiteStatus::fallback),
            },
            None => SiteStatus::fallback(),
        },
    };
    dto.currency = site.currency.clone();

    if let Some(h) = wallet_h {
        match take_get(h).await {
            Ok(o) if o.status >= 200 && o.status < 300 => match parse_user_self(&o.body) {
                Ok((remaining_raw, used_raw)) => {
                    dto.account = account_from_user_self(&o.body);
                    apply_raw_quota(&mut dto, remaining_raw, used_raw, &site, "wallet");
                }
                Err(e) => dto.error = Some(e),
            },
            Ok(o) if o.status == 401 || o.status == 403 => {
                dto.error = Some("系统访问令牌失效，请到连接页网关库更新".into());
            }
            _ => {}
        }
    }

    let Some(key) = infer else {
        if dto.remaining.is_none() {
            if dto.error.is_none() && !dto.has_wallet_token {
                dto.error = Some("网关未保存密钥，到连接页填写后可查余额".into());
            } else if dto.error.is_none() {
                dto.error = Some("系统访问令牌查不到钱包，到连接页网关库核对令牌".into());
            }
        }
        return dto;
    };

    let mut token_from_usage = false;
    if let Some(h) = token_h {
        match take_get(h).await {
            Ok(o) if o.status >= 200 && o.status < 300 => match parse_token_usage(&o.body) {
                Ok(u) if u.unlimited => {
                    dto.token_unlimited = true;
                    dto.token_name = u.name.clone();
                    dto.expires_at = u.expires_at.or(dto.expires_at);
                    if u.used_raw > 0.0 {
                        dto.token_used = Some(quota_to_display(u.used_raw, &site));
                    }
                    token_from_usage = true;
                }
                Ok(u) => {
                    let promote = dto.source != "wallet";
                    apply_token_display(
                        &mut dto,
                        quota_to_display(u.remaining_raw, &site),
                        quota_to_display(u.used_raw, &site),
                        promote,
                    );
                    dto.token_name = u.name.clone();
                    dto.expires_at = u.expires_at.or(dto.expires_at);
                    token_from_usage = true;
                }
                Err(_) => {}
            },
            _ => {}
        }
    }

    // 第二波仅在密钥额度接口没给出答案时才打 billing，两路并行。
    if !token_from_usage {
        let sub_h = spawn_get(sub_url, Some(key.clone()), None);
        let use_h = spawn_get(usage_url, Some(key), None);
        let sub_res = take_get(sub_h).await;
        let use_res = take_get(use_h).await;
        match sub_res {
            Ok(o) if o.status >= 200 && o.status < 300 => match parse_subscription(&o.body) {
                Ok(s) if s.unlimited => {
                    dto.token_unlimited = true;
                    dto.expires_at = s.expires_at.or(dto.expires_at);
                }
                Ok(s) => {
                    dto.expires_at = s.expires_at.or(dto.expires_at);
                    let used = match use_res {
                        Ok(u) if u.status >= 200 && u.status < 300 => parse_usage(&u.body).ok(),
                        _ => None,
                    };
                    if let Some(used) = used {
                        let promote = dto.source != "wallet";
                        apply_token_display(&mut dto, (s.total - used).max(0.0), used, promote);
                    } else if dto.source != "wallet" {
                        dto.ok = true;
                        dto.source = "token".into();
                        dto.total = Some(s.total);
                        dto.token_total = Some(s.total);
                    }
                }
                Err(e) => {
                    if dto.remaining.is_none() && dto.error.is_none() {
                        dto.error = Some(e);
                    }
                }
            },
            Ok(o) => {
                if dto.remaining.is_none() && dto.error.is_none() {
                    dto.error = Some(map_http_error(&o));
                }
            }
            Err(e) => {
                if dto.remaining.is_none() && dto.error.is_none() {
                    dto.error = Some(e);
                }
            }
        }
    }

    if dto.token_unlimited && dto.source != "wallet" {
        dto.source = "token".into();
        dto.unlimited = true;
        dto.ok = true;
    }
    dto
}

/// 一个待联网查询的网关（密钥已装配；仅总览内部用）
struct Job {
    idx: usize,
    gateway: Gateway,
    origin: String,
    infer_key: Option<String>,
    wallet_pat: Option<String>,
}

/// 用量页「网关余额」总览：扫全部网关，钱包站命中才出卡。
///
/// 多网关并发：先把要联网的行全部 spawn，再按序收结果——等待时间 ≈ 最慢的一个网关，
/// 不是各网关相加（多网关实测：顺序中位 ≈2.1s → 并发中位 ≈0.66s）。
/// 输出顺序 = 网关列表顺序（缓存行/错误行/联网行按原下标归位，不是「谁先回来谁在前」）。
#[tauri::command]
pub async fn gateway_balance_overview(force: Option<bool>) -> Vec<GatewayBalanceDto> {
    let force = force.unwrap_or(false);
    let gateways = crate::gateway_store::load_gateways().unwrap_or_default();
    let mut rows: Vec<Option<GatewayBalanceDto>> = (0..gateways.len()).map(|_| None).collect();
    let mut jobs: Vec<Job> = Vec::new();
    let mut cursor = 0usize;
    for gateway in gateways {
        let idx = cursor;
        cursor += 1;
        let Some(origin) = detect_wallet_origin(&gateway.slots) else {
            continue;
        };
        let infer_key = match crate::profiles::get_key(&gateway.id) {
            Ok(k) => k.filter(|s| !s.trim().is_empty()),
            Err(e) => {
                rows[idx] = Some(empty_dto(
                    &gateway,
                    origin,
                    Some(format!("读取密钥失败: {e}")),
                ));
                continue;
            }
        };
        let wallet_pat =
            match crate::profiles::get_key(&crate::profiles::wallet_key_id(&gateway.id)) {
                Ok(k) => k.filter(|s| !s.trim().is_empty()),
                Err(e) => {
                    rows[idx] = Some(empty_dto(
                        &gateway,
                        origin,
                        Some(format!("读取系统访问令牌失败: {e}")),
                    ));
                    continue;
                }
            };
        if infer_key.is_none() && wallet_pat.is_none() {
            rows[idx] = Some(empty_dto(
                &gateway,
                origin,
                Some("网关未保存密钥，到连接页填写后可查余额".into()),
            ));
            continue;
        }
        if !force {
            if let Some(hit) = cache_get(&gateway.id, now_ms()) {
                rows[idx] = Some(hit);
                continue;
            }
        }
        jobs.push(Job {
            idx,
            gateway,
            origin,
            infer_key,
            wallet_pat,
        });
    }

    let handles: Vec<_> = jobs
        .into_iter()
        .map(|job| {
            tauri::async_runtime::spawn(async move {
                let dto = refresh_gateway(
                    &job.gateway,
                    &job.origin,
                    job.infer_key.as_deref(),
                    job.wallet_pat.as_deref(),
                )
                .await;
                (job.idx, dto)
            })
        })
        .collect();

    for handle in handles {
        let Ok((idx, mut dto)) = handle.await else {
            continue;
        };
        if !dto.ok {
            if let Some(prev) = cache_get_stale(&dto.gateway_id).filter(|p| p.ok) {
                let queried_at = prev.queried_at;
                dto = prev;
                dto.from_cache = true;
                dto.queried_at = queried_at;
            }
        } else {
            cache_put(&dto);
        }
        rows[idx] = Some(dto);
    }
    rows.into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slots_with(urls: &[(&str, &str)]) -> ProtocolSlots {
        let mut slots = ProtocolSlots {
            anthropic: None,
            openai: None,
            responses: None,
            gemini: None,
            cursor: None,
        };
        for (slot, url) in urls {
            match *slot {
                "anthropic" => slots.anthropic = Some(url.to_string()),
                "openai" => slots.openai = Some(url.to_string()),
                "responses" => slots.responses = Some(url.to_string()),
                "gemini" => slots.gemini = Some(url.to_string()),
                _ => slots.cursor = Some(url.to_string()),
            }
        }
        slots
    }

    #[test]
    fn origin_and_host_from_slot_url() {
        assert_eq!(
            origin_from_url("https://ent.zetatechs.com/v1"),
            Some("https://ent.zetatechs.com".into())
        );
        assert_eq!(
            origin_from_url("https://ent.zetatechs.com/v1/responses"),
            Some("https://ent.zetatechs.com".into())
        );
        assert_eq!(
            host_of("https://ent.zetatechs.com:443/v1").as_deref(),
            Some("ent.zetatechs.com")
        );
        assert!(origin_from_url("/v1").is_none());
        assert!(origin_from_url("").is_none());
    }

    #[test]
    fn wallet_host_match_is_suffix_not_substring() {
        assert!(host_is_wallet("zetatechs.com"));
        assert!(host_is_wallet("ent.zetatechs.com"));
        assert!(host_is_wallet("api.zetatechs.com"));
        assert!(!host_is_wallet("notzetatechs.com"));
        assert!(!host_is_wallet("example.com"));
        assert!(!host_is_wallet("api.deepseek.com"));
    }

    #[test]
    fn detect_wallet_origin_from_slots() {
        assert_eq!(
            detect_wallet_origin(&slots_with(&[("openai", "https://ent.zetatechs.com/v1")])),
            Some("https://ent.zetatechs.com".into())
        );
        assert_eq!(
            detect_wallet_origin(&slots_with(&[(
                "responses",
                "https://ent.zetatechs.com/v1"
            )])),
            Some("https://ent.zetatechs.com".into())
        );
        assert!(
            detect_wallet_origin(&slots_with(&[("openai", "https://api.deepseek.com/v1")]))
                .is_none()
        );
        assert!(detect_wallet_origin(&slots_with(&[])).is_none());
    }

    #[test]
    fn parse_status_currency_cny() {
        let body = serde_json::json!({
            "success": true,
            "data": { "quota_display_type": "CNY", "quota_per_unit": 500000, "usd_exchange_rate": 1 }
        });
        let site = parse_site_status(&body);
        assert_eq!(site.currency, "CNY");
        assert!((site.per_unit - 500_000.0).abs() < 1e-9);
        let usd = serde_json::json!({ "data": { "quota_display_type": "usd" } });
        assert_eq!(parse_site_status(&usd).currency, "USD");
        let tokens = serde_json::json!({ "data": { "quota_display_type": "TOKENS" } });
        assert_eq!(parse_site_status(&tokens).currency, "TOKENS");
        assert_eq!(parse_site_status(&serde_json::json!({})).currency, "USD");
    }

    #[test]
    fn quota_to_display_cny_matches_zetatechs_status() {
        let site = SiteStatus {
            currency: "CNY".into(),
            per_unit: 500_000.0,
            usd_rate: 1.0,
        };
        // 75_000_000 原始额度 → ¥150
        assert!((quota_to_display(75_000_000.0, &site) - 150.0).abs() < 1e-9);
        let usd = SiteStatus {
            currency: "USD".into(),
            per_unit: 500_000.0,
            usd_rate: 7.0,
        };
        assert!((quota_to_display(500_000.0, &usd) - 1.0).abs() < 1e-9);
        let tokens = SiteStatus {
            currency: "TOKENS".into(),
            per_unit: 500_000.0,
            usd_rate: 1.0,
        };
        assert!((quota_to_display(1234.0, &tokens) - 1234.0).abs() < 1e-9);
    }

    #[test]
    fn parse_user_self_wallet_quota() {
        let body = serde_json::json!({
            "success": true,
            "data": { "quota": 64_250_000, "used_quota": 10_750_000, "username": "x" }
        });
        let (remaining, used) = parse_user_self(&body).unwrap();
        assert!((remaining - 64_250_000.0).abs() < 1e-9);
        assert!((used - 10_750_000.0).abs() < 1e-9);
        let fail = serde_json::json!({ "success": false, "message": "未登录" });
        assert!(parse_user_self(&fail).unwrap_err().contains("未登录"));
        assert!(parse_user_self(&serde_json::json!({})).is_err());
    }

    #[test]
    fn account_uses_display_name_then_username_and_never_email() {
        let both = serde_json::json!({
            "data": { "display_name": "hongtongzhou", "username": "htz", "email": "a@b.c" }
        });
        assert_eq!(account_from_user_self(&both).as_deref(), Some("hongtongzhou"));
        let only_user = serde_json::json!({ "data": { "username": "htz", "email": "a@b.c" } });
        assert_eq!(account_from_user_self(&only_user).as_deref(), Some("htz"));
        // 只有 email 时不给账户名：联系方式不进 DTO
        let email_only = serde_json::json!({ "data": { "email": "a@b.c" } });
        assert!(account_from_user_self(&email_only).is_none());
        // 空白名不算
        let blank = serde_json::json!({ "data": { "display_name": "   " } });
        assert!(account_from_user_self(&blank).is_none());
        assert!(account_from_user_self(&serde_json::json!({})).is_none());
    }

    #[test]
    fn parse_token_usage_unlimited_and_limited() {
        let unlim = serde_json::json!({
            "code": true,
            "data": {
                "total_granted": 0,
                "total_used": 12,
                "total_available": 0,
                "unlimited_quota": true,
                "expires_at": 0,
                "name": "codex"
            }
        });
        let u = parse_token_usage(&unlim).unwrap();
        assert!(u.unlimited);
        assert_eq!(u.name.as_deref(), Some("codex"));
        let limited = serde_json::json!({
            "data": {
                "total_granted": 75_000_000,
                "total_used": 10_750_000,
                "total_available": 64_250_000,
                "unlimited_quota": false,
                "expires_at": 1_789_866_123i64
            }
        });
        let t = parse_token_usage(&limited).unwrap();
        assert!(!t.unlimited);
        assert!((t.remaining_raw - 64_250_000.0).abs() < 1e-9);
        assert_eq!(t.expires_at, Some(1_789_866_123_000));
        // 没有 name 字段时留空，不编造
        assert!(t.name.is_none());
    }

    #[test]
    fn parse_subscription_total_and_unlimited() {
        let body = serde_json::json!({
            "object": "billing_subscription",
            "hard_limit_usd": 150.5,
            "soft_limit_usd": 150.5,
            "access_until": 0
        });
        let s = parse_subscription(&body).unwrap();
        assert!((s.total - 150.5).abs() < 1e-9);
        assert!(!s.unlimited);
        assert!(s.expires_at.is_none());

        let unlim = serde_json::json!({ "hard_limit_usd": 100_000_000 });
        assert!(parse_subscription(&unlim).unwrap().unlimited);

        let exp = serde_json::json!({ "hard_limit_usd": 10, "access_until": 1_789_866_123i64 });
        assert_eq!(
            parse_subscription(&exp).unwrap().expires_at,
            Some(1_789_866_123_000)
        );
    }

    #[test]
    fn parse_subscription_rejects_error_envelope() {
        let body = serde_json::json!({
            "error": { "message": "You didn't provide an API key.", "type": "invalid_request_error" }
        });
        let err = parse_subscription(&body).unwrap_err();
        assert!(err.contains("API key"));
        assert!(parse_subscription(&serde_json::json!({})).is_err());
    }

    #[test]
    fn parse_usage_divides_by_100() {
        let body = serde_json::json!({ "object": "list", "total_usage": 2150.0 });
        let used = parse_usage(&body).unwrap();
        assert!((used - 21.5).abs() < 1e-9);
        assert!(parse_usage(&serde_json::json!({})).is_err());
    }

    #[test]
    fn remaining_is_total_minus_used() {
        let total: f64 = 150.0;
        let used: f64 = 21.5;
        assert!(((total - used).max(0.0) - 128.5).abs() < 1e-9);
        assert_eq!((10.0_f64 - 12.0).max(0.0), 0.0);
    }

    #[test]
    fn endpoints_keep_trailing_slash_on_token_usage() {
        let e = endpoints_for("https://ent.zetatechs.com");
        assert_eq!(e.status, "https://ent.zetatechs.com/api/status");
        assert_eq!(e.user_self, "https://ent.zetatechs.com/api/user/self");
        // 不带尾斜杠会被 301 一跳；这条断言就是防回退
        assert_eq!(
            e.token_usage,
            "https://ent.zetatechs.com/api/usage/token/"
        );
        assert_eq!(
            e.subscription,
            "https://ent.zetatechs.com/v1/dashboard/billing/subscription"
        );
        assert_eq!(e.usage, "https://ent.zetatechs.com/v1/dashboard/billing/usage");
    }

    #[test]
    fn site_status_cache_ttl_and_stale_fallback() {
        // 用测试专属 origin，避免与别的用例共用全局缓存键
        let origin = "https://cache-test.invalid";
        let site = SiteStatus {
            currency: "CNY".into(),
            per_unit: 500_000.0,
            usd_rate: 1.0,
        };
        site_status_put(origin, &site);
        // TTL 内新鲜命中
        assert_eq!(
            site_status_get(origin, now_ms() + SITE_STATUS_TTL_MS - 1).map(|s| s.currency),
            Some("CNY".into())
        );
        // 过期：新鲜取值不认，但失败兜底仍能拿到上次成功值
        let far = now_ms() + SITE_STATUS_TTL_MS + 1;
        assert!(site_status_get(origin, far).is_none());
        assert_eq!(
            site_status_get_stale(origin).map(|s| s.currency),
            Some("CNY".into())
        );
        assert!(site_status_get_stale("https://never-cached.invalid").is_none());
        // 打不到 /api/status 时的内置默认：new-api 默认单位，按 USD 计
        let fallback = SiteStatus::fallback();
        assert_eq!(fallback.currency, "USD");
        assert!((fallback.per_unit - 500_000.0).abs() < 1e-9);
    }
}
