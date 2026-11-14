//! 官方账号线路体检（docs/design-outbound-route.md 一期）：经与官方启动同源的代理环境，访问这家服务
//! 自己的公开诊断地址（`agent_specs::RouteProbe`），判「通过 / 拦下 / 待你判断」。
//! 只读、不带凭据；只对官方账号。规则分流的代理下出口随域名变，所以必须用这家服务自己的域名测，
//! 中立的查 IP 网站测出来的出口可能不是它的。判定是纯函数（`judge`），网络只在 `probe` 里。
//! 二期：出口记忆（配置目录 `route-history.json`，每家最近 20 次的地区 + IP 前缀，不记完整 IP、不记账号）——
//! 和最近 7 天常用地区不一样就「待你判断」；本机已装的代理软件可一键打开（修复动作）。

use crate::agent_specs::{agent_spec, RouteProbe, ServiceCheck};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Pass,
    Block,
    Review,
}

/// 断在哪一段（前一段失败后面不测）
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Proxy,
    Reach,
    Region,
}

/// 这次启动会用的代理从哪来：连接的附加环境变量 > 设置里的出网代理 > 登录 shell 带进 Mesa 的
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProxySource {
    Connection,
    Settings,
    Shell,
    None,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteCheckDto {
    pub agent: String,
    pub verdict: Verdict,
    pub stage: Option<Stage>,
    /// 给人看的一句话
    pub reason: String,
    pub proxy_source: ProxySource,
    /// 去掉账号密码后的代理地址
    pub proxy: Option<String>,
    pub probe_host: String,
    /// 服务端看到的出口国家 / 地区两位码
    pub exit_region: Option<String>,
    pub exit_region_name: Option<String>,
    pub latency_ms: Option<u64>,
    /// 最近 7 天常用的出口地区（出口记忆；还没记录时为空）
    pub usual_region: Option<String>,
    pub usual_region_name: Option<String>,
    /// 这次出口地区和常用的不一样（界面给「记为常用出口」）
    pub region_changed: bool,
    /// 服务方自己的答复：allowed / blocked / unknown；这家没有这项检查时为空
    pub service_says: Option<ServiceSays>,
    /// unix 秒
    pub checked_at: i64,
}

/// 一次探测的结果（judge 的输入）
#[derive(Debug, Clone, PartialEq)]
pub enum ProbeOutcome {
    /// ip 是前缀（进出口记忆）；addr 是完整出口 IP，只留在内存里给「查出口类型」用，不落盘
    Ok { loc: Option<String>, ip: Option<String>, addr: Option<String>, latency_ms: u64 },
    Timeout,
    Failed(String),
    /// 这个代理形态测不了（SOCKS：reqwest 没开 socks 特性），不当失败
    Unsupported(String),
}

const PROXY_KEYS: [&str; 4] = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];

/// 按官方启动的注入顺序算出 CLI 实际会用的代理：extra_env 最后注入（同名覆盖）> 设置 > 继承的进程环境。
/// 连接里把代理变量显式填空 = 这条连接不走代理
pub fn resolve_proxy(
    settings_env: &[(String, String)],
    extra_env: &HashMap<String, String>,
    inherited: impl Fn(&str) -> Option<String>,
) -> (ProxySource, Option<String>) {
    for key in PROXY_KEYS {
        if let Some(v) = extra_env.get(key) {
            let v = v.trim();
            return (ProxySource::Connection, (!v.is_empty()).then(|| v.to_string()));
        }
    }
    if let Some((_, v)) = settings_env.iter().find(|(k, _)| k == "HTTPS_PROXY") {
        return (ProxySource::Settings, Some(v.clone()));
    }
    for key in PROXY_KEYS {
        if let Some(v) = inherited(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            return (ProxySource::Shell, Some(v));
        }
    }
    (ProxySource::None, None)
}

/// 代理地址去掉账号密码（界面与日志都只用这个）
pub fn redact_proxy(proxy: &str) -> String {
    match reqwest::Url::parse(proxy) {
        Ok(mut url) => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.to_string().trim_end_matches('/').to_string()
        }
        Err(_) => proxy.split('@').next_back().unwrap_or(proxy).to_string(),
    }
}

/// 常见地区的中文名；其余原样显示两位码
pub fn region_name(code: &str) -> String {
    let name = match code {
        "GB" => "英国",
        "US" => "美国",
        "JP" => "日本",
        "SG" => "新加坡",
        "KR" => "韩国",
        "TW" => "台湾",
        "HK" => "香港",
        "MO" => "澳门",
        "CN" => "中国大陆",
        "DE" => "德国",
        "FR" => "法国",
        "NL" => "荷兰",
        "CA" => "加拿大",
        "AU" => "澳大利亚",
        "IN" => "印度",
        "MY" => "马来西亚",
        "TH" => "泰国",
        "VN" => "越南",
        "PH" => "菲律宾",
        "ID" => "印度尼西亚",
        "RU" => "俄罗斯",
        "TR" => "土耳其",
        "AE" => "阿联酋",
        "BR" => "巴西",
        _ => return code.to_string(),
    };
    name.to_string()
}

/// 从 Cloudflare `/cdn-cgi/trace` 的 `键=值` 行里取 loc
pub fn parse_trace_loc(body: &str) -> Option<String> {
    body.lines()
        .find_map(|l| l.strip_prefix("loc="))
        .map(|v| v.trim().to_ascii_uppercase())
        .filter(|v| v.len() == 2)
}

/// 从 trace 里取出口 IP，只留前缀（IPv4 /24、IPv6 前 3 段）：够看出「换没换线路」，不留完整 IP
pub fn parse_trace_prefix(body: &str) -> Option<String> {
    let ip = body.lines().find_map(|l| l.strip_prefix("ip="))?.trim();
    if let Ok(v4) = ip.parse::<std::net::Ipv4Addr>() {
        let o = v4.octets();
        return Some(format!("{}.{}.{}.0/24", o[0], o[1], o[2]));
    }
    if let Ok(v6) = ip.parse::<std::net::Ipv6Addr>() {
        let s = v6.segments();
        return Some(format!("{:x}:{:x}:{:x}::/48", s[0], s[1], s[2]));
    }
    None
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ExitRecord {
    pub region: String,
    #[serde(default)]
    pub prefix: Option<String>,
    pub at: i64,
}

/// 「这是我故意换的」：从 at 起以 region 为常用出口
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AcceptedRegion {
    pub region: String,
    pub at: i64,
}

#[derive(Serialize, Deserialize, Default, Debug)]
pub struct RouteHistory {
    #[serde(default)]
    pub records: HashMap<String, Vec<ExitRecord>>,
    #[serde(default)]
    pub accepted: HashMap<String, AcceptedRegion>,
}

const HISTORY_KEEP: usize = 20;
const USUAL_WINDOW_SECS: i64 = 7 * 24 * 3600;

/// 常用出口：最近 7 天、且在「记为常用」之后的记录里出现最多的地区；没有这样的记录就用记为常用的那个
pub fn usual_region(records: &[ExitRecord], accepted: Option<&AcceptedRegion>, now: i64) -> Option<String> {
    let since = (now - USUAL_WINDOW_SECS).max(accepted.map(|a| a.at).unwrap_or(i64::MIN));
    let mut count: HashMap<&str, (usize, i64)> = HashMap::new();
    for r in records.iter().filter(|r| r.at >= since) {
        let e = count.entry(r.region.as_str()).or_insert((0, i64::MIN));
        e.0 += 1;
        e.1 = e.1.max(r.at);
    }
    // 次数相同取最近出现过的
    count
        .into_iter()
        .max_by_key(|(_, (n, last))| (*n, *last))
        .map(|(r, _)| r.to_string())
        .or_else(|| accepted.map(|a| a.region.clone()))
}

fn history_path() -> Option<std::path::PathBuf> {
    Some(crate::dirs::config_dir()?.join("ccode").join("route-history.json"))
}

static HISTORY_LOCK: Mutex<()> = Mutex::new(());

fn read_history() -> RouteHistory {
    if cfg!(test) {
        return RouteHistory::default();
    }
    history_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_history(h: &RouteHistory) {
    if cfg!(test) {
        return;
    }
    if let (Some(p), Ok(text)) = (history_path(), serde_json::to_string_pretty(h)) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = crate::profiles::atomic_write(&p, &text);
    }
}

/// 服务方对这个出口的答复（不带密钥问出来的）
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceSays {
    Allowed,
    Blocked,
    Unknown,
}

/// Anthropic：不带密钥调接口，地区放行时卡在鉴权（401 authentication_error），地区被拒时直接 403 forbidden。
/// 2026-11-06 实测：英国出口回 401「x-api-key header is required」，国内直连回 403「Request not allowed」
pub fn read_anthropic_keyless(status: u16, body: &str) -> ServiceSays {
    match status {
        401 if body.contains("authentication_error") => ServiceSays::Allowed,
        403 if body.contains("forbidden") || body.contains("Request not allowed") => ServiceSays::Blocked,
        _ => ServiceSays::Unknown,
    }
}

/// OpenAI：合规接口在被拒地区回 unsupported_country；正常地区回 cookie_consent_required 字段
pub fn read_openai_compliance(status: u16, body: &str) -> ServiceSays {
    if body.contains("unsupported_country") {
        ServiceSays::Blocked
    } else if status == 200 && body.contains("cookie_consent_required") {
        ServiceSays::Allowed
    } else {
        ServiceSays::Unknown
    }
}

fn service_label(check: ServiceCheck) -> &'static str {
    match check {
        ServiceCheck::AnthropicKeyless => "Claude",
        ServiceCheck::OpenAiCompliance => "OpenAI",
    }
}

/// 问服务方：与体检同一个代理，不带任何密钥 / Cookie；网络出错当「没答复」，不当被拒
async fn ask_service(check: ServiceCheck, proxy: Option<&str>) -> ServiceSays {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(6));
    builder = match proxy {
        Some(p) => match reqwest::Proxy::all(p) {
            Ok(px) => builder.proxy(px),
            Err(_) => return ServiceSays::Unknown,
        },
        None => builder.no_proxy(),
    };
    let Ok(client) = builder.build() else { return ServiceSays::Unknown };
    let req = match check {
        ServiceCheck::AnthropicKeyless => client
            .post("https://api.anthropic.com/v1/messages")
            .header("content-type", "application/json")
            .header("anthropic-version", "2023-06-01")
            .body("{}"),
        ServiceCheck::OpenAiCompliance => client.get("https://api.openai.com/compliance/cookie_requirements"),
    };
    let Ok(resp) = req.send().await else { return ServiceSays::Unknown };
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    match check {
        ServiceCheck::AnthropicKeyless => read_anthropic_keyless(status, &body),
        ServiceCheck::OpenAiCompliance => read_openai_compliance(status, &body),
    }
}

pub struct JudgeInput<'a> {
    pub probe: &'a RouteProbe,
    pub source: ProxySource,
    pub proxy: Option<&'a str>,
    /// 本机代理端口在不在听：Some(false) = 代理没开；远端代理 / 没代理为 None
    pub proxy_down: Option<String>,
    pub outcome: Option<ProbeOutcome>,
    /// 出口记忆里的常用地区
    pub usual: Option<&'a str>,
    /// 服务方的答复：明确放行 / 被拒时以它为准，没答复才看不支持地区名单
    pub service: Option<ServiceSays>,
}

/// 延迟写成「1.0 秒」
pub fn secs(ms: u64) -> String {
    format!("{:.1} 秒", ms as f64 / 1000.0)
}

/// 判定：纯函数，§4.3 三档。文案要短：通过只写「英国 · 1.0 秒」
pub fn judge(input: &JudgeInput) -> (Verdict, Option<Stage>, String, Option<String>, Option<u64>) {
    let host = input.probe.host;
    if let Some(target) = &input.proxy_down {
        let from = match input.source {
            ProxySource::Connection => "（连接里设的）",
            ProxySource::Shell => "（终端环境带来的）",
            _ => "",
        };
        return (Verdict::Block, Some(Stage::Proxy), format!("代理 {target} 没开{from}"), None, None);
    }
    let unreachable = |why: &str| {
        if input.proxy.is_some() {
            format!("经代理连不上 {host}（{why}）")
        } else {
            format!("直连连不上 {host}，要设出网代理")
        }
    };
    match input.outcome.as_ref() {
        None => (Verdict::Review, None, "还没测".into(), None, None),
        Some(ProbeOutcome::Unsupported(msg)) => (Verdict::Review, None, msg.clone(), None, None),
        Some(ProbeOutcome::Timeout) => (Verdict::Block, Some(Stage::Reach), unreachable("超时"), None, None),
        Some(ProbeOutcome::Failed(err)) => (Verdict::Block, Some(Stage::Reach), unreachable(err), None, None),
        // 这家本来就不告诉出口地区（Gemini、Cursor）：连得上就算通过
        Some(ProbeOutcome::Ok { latency_ms, .. }) if input.service == Some(ServiceSays::Blocked) => {
            let loc = match input.outcome.as_ref() {
                Some(ProbeOutcome::Ok { loc, .. }) => loc.clone(),
                _ => None,
            };
            let svc = input.probe.service_check.map(service_label).unwrap_or("服务方");
            let reason = match &loc {
                Some(l) => format!("{}，{svc} 不支持这个地区", region_name(l)),
                None => format!("{svc} 不支持这个地区"),
            };
            (Verdict::Block, Some(Stage::Region), reason, loc, Some(*latency_ms))
        }
        Some(ProbeOutcome::Ok { loc: None, latency_ms, .. }) if !input.probe.reports_region => {
            (Verdict::Pass, None, format!("连得上 · {}", secs(*latency_ms)), None, Some(*latency_ms))
        }
        Some(ProbeOutcome::Ok { loc: None, latency_ms, .. }) => (
            Verdict::Review,
            None,
            format!("连得上，没拿到地区 · {}", secs(*latency_ms)),
            None,
            Some(*latency_ms),
        ),
        Some(ProbeOutcome::Ok { loc: Some(loc), latency_ms, .. }) => {
            let name = region_name(loc);
            let listed = input.probe.unsupported_regions.contains(&loc.as_str());
            let (verdict, stage, reason) = if listed && input.service != Some(ServiceSays::Allowed) {
                (Verdict::Block, Some(Stage::Region), format!("{name}，不支持这个地区"))
            } else if let Some(usual) = input.usual.filter(|u| *u != loc.as_str()) {
                (Verdict::Review, None, format!("{name}（常用{}）", region_name(usual)))
            } else {
                (Verdict::Pass, None, format!("{name} · {}", secs(*latency_ms)))
            };
            (verdict, stage, reason, Some(loc.clone()), Some(*latency_ms))
        }
    }
}

/// 真去访问一次：与启动同源的代理；没代理时显式直连（不让 reqwest 自己读进程环境里的代理变量）
async fn probe(url: &str, proxy: Option<&str>, reports_region: bool) -> ProbeOutcome {
    if let Some(p) = proxy {
        if p.trim_start().to_ascii_lowercase().starts_with("socks") {
            return ProbeOutcome::Unsupported("SOCKS 代理，只确认了端口开着".into());
        }
    }
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(6));
    builder = match proxy {
        Some(p) => match reqwest::Proxy::all(p) {
            Ok(px) => builder.proxy(px),
            Err(e) => return ProbeOutcome::Failed(format!("代理地址不可用：{e}")),
        },
        None => builder.no_proxy(),
    };
    let client = match builder.build() {
        Ok(c) => c,
        Err(e) => return ProbeOutcome::Failed(e.to_string()),
    };
    let started = std::time::Instant::now();
    match client.get(url).send().await {
        Ok(resp) => {
            let latency_ms = started.elapsed().as_millis() as u64;
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if reports_region && !status.is_success() && parse_trace_loc(&body).is_none() {
                return ProbeOutcome::Failed(format!("HTTP {}", status.as_u16()));
            }
            ProbeOutcome::Ok {
                loc: parse_trace_loc(&body),
                ip: parse_trace_prefix(&body),
                addr: body.lines().find_map(|l| l.strip_prefix("ip=")).map(|v| v.trim().to_string()),
                latency_ms,
            }
        }
        Err(e) if e.is_timeout() => ProbeOutcome::Timeout,
        Err(e) if e.is_connect() => ProbeOutcome::Failed("连接被拒或中断".into()),
        Err(e) => ProbeOutcome::Failed(short_error(&e)),
    }
}

fn short_error(e: &reqwest::Error) -> String {
    let s = e.to_string();
    s.chars().take(80).collect()
}

static CACHE: Mutex<Option<HashMap<String, RouteCheckDto>>> = Mutex::new(None);
/// 每家最近一次的完整出口 IP（只在内存，Mesa 关了就没了）
static LAST_ADDR: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
/// 出口类型查询结果，按 IP 缓存 24 小时
static EXIT_TYPE_CACHE: Mutex<Option<HashMap<String, (i64, ExitTypeDto)>>> = Mutex::new(None);

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 有探测点的 Agent（设置页体检卡只列这些）
#[tauri::command]
pub fn route_check_agents() -> Vec<String> {
    crate::agent_specs::all_agent_specs()
        .iter()
        .filter(|s| s.official_account.as_ref().is_some_and(|o| o.route_probe.is_some()))
        .map(|s| s.id.to_string())
        .collect()
}

/// 体检一家官方账号。profile_id 给了就叠加这条连接的附加环境变量（与启动同源）；
/// max_age_secs 内有结果就直接用（启动预检传 300，「重测」传 0）
#[tauri::command]
pub async fn route_check(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    agent_id: String,
    profile_id: Option<String>,
    max_age_secs: Option<u64>,
) -> Result<RouteCheckDto, String> {
    let spec = agent_spec(&agent_id).ok_or("未知的 Agent")?;
    let probe_spec = spec
        .official_account
        .as_ref()
        .and_then(|o| o.route_probe.as_ref())
        .ok_or("这家暂不做线路体检")?;
    let extra_env = match profile_id.as_deref() {
        Some(id) => store.get(id)?.extra_env,
        None => HashMap::new(),
    };
    let cache_key = format!("{agent_id}|{}", profile_id.as_deref().unwrap_or(""));
    if let Some(max_age) = max_age_secs.filter(|s| *s > 0) {
        let cached = CACHE.lock().ok().and_then(|c| c.as_ref()?.get(&cache_key).cloned());
        if let Some(dto) = cached.filter(|d| now_secs() - d.checked_at <= max_age as i64) {
            return Ok(dto);
        }
    }
    let settings_env = crate::settings::official_outbound_env();
    let (source, proxy) = resolve_proxy(&settings_env, &extra_env, |k| std::env::var(k).ok());
    let proxy_down = match proxy.as_deref() {
        Some(p) => {
            let p = p.to_string();
            tauri::async_runtime::spawn_blocking(move || {
                crate::settings::loopback_proxy_target(&p).filter(|_| !crate::settings::proxy_url_alive(&p))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        None => None,
    };
    let outcome = if proxy_down.is_some() {
        None
    } else {
        Some(probe(probe_spec.url, proxy.as_deref(), probe_spec.reports_region).await)
    };
    let service = match (&outcome, probe_spec.service_check) {
        (Some(ProbeOutcome::Ok { .. }), Some(check)) => Some(ask_service(check, proxy.as_deref()).await),
        _ => None,
    };
    let now = now_secs();
    let usual = {
        let _g = HISTORY_LOCK.lock().map_err(|e| e.to_string())?;
        let h = read_history();
        usual_region(
            h.records.get(&agent_id).map(Vec::as_slice).unwrap_or(&[]),
            h.accepted.get(&agent_id),
            now,
        )
    };
    let probed_prefix = match &outcome {
        Some(ProbeOutcome::Ok { ip, .. }) => ip.clone(),
        _ => None,
    };
    if let Some(ProbeOutcome::Ok { addr: Some(addr), .. }) = &outcome {
        if let Ok(mut m) = LAST_ADDR.lock() {
            m.get_or_insert_with(HashMap::new).insert(agent_id.clone(), addr.clone());
        }
    }
    let (verdict, stage, reason, exit_region, latency_ms) = judge(&JudgeInput {
        probe: probe_spec,
        source,
        proxy: proxy.as_deref(),
        proxy_down,
        outcome,
        usual: usual.as_deref(),
        service,
    });
    let region_changed = matches!((&exit_region, &usual), (Some(e), Some(u)) if e != u)
        && verdict == Verdict::Review;
    // 拿到出口地区才记（连不上的那次不算一次出口）
    if let Some(region) = exit_region.clone() {
        if let Ok(_g) = HISTORY_LOCK.lock() {
            let mut h = read_history();
            let list = h.records.entry(agent_id.clone()).or_default();
            list.push(ExitRecord { region, prefix: probed_prefix, at: now });
            let excess = list.len().saturating_sub(HISTORY_KEEP);
            list.drain(..excess);
            write_history(&h);
        }
    }
    let dto = RouteCheckDto {
        agent: agent_id,
        verdict,
        stage,
        reason,
        proxy_source: source,
        proxy: proxy.as_deref().map(redact_proxy),
        probe_host: probe_spec.host.to_string(),
        exit_region_name: exit_region.as_deref().map(region_name),
        exit_region,
        latency_ms,
        usual_region_name: usual.as_deref().map(region_name),
        usual_region: usual,
        region_changed,
        service_says: service,
        checked_at: now,
    };
    if let Ok(mut c) = CACHE.lock() {
        c.get_or_insert_with(HashMap::new).insert(cache_key, dto.clone());
    }
    Ok(dto)
}

/// 「记为常用出口」：以这家最近一次的出口地区为常用，清掉它的体检缓存好让下次重判
#[tauri::command]
pub fn route_accept_region(agent_id: String) -> Result<(), String> {
    let _g = HISTORY_LOCK.lock().map_err(|e| e.to_string())?;
    let mut h = read_history();
    let region = h
        .records
        .get(&agent_id)
        .and_then(|l| l.last())
        .map(|r| r.region.clone())
        .ok_or("还没有这家的出口记录")?;
    h.accepted.insert(agent_id.clone(), AcceptedRegion { region, at: now_secs() });
    write_history(&h);
    if let Ok(mut c) = CACHE.lock() {
        if let Some(map) = c.as_mut() {
            map.retain(|k, _| !k.starts_with(&format!("{agent_id}|")));
        }
    }
    Ok(())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExitTypeDto {
    /// residential | datacenter | unknown
    pub kind: &'static str,
    /// 住宅 / 机房 / 看不出来
    pub label: &'static str,
    /// 出口 IP 所属的网络（如「AS2856 British Telecommunications Limited」）
    pub org: String,
    /// IP 注册在哪国（RDAP，两字母代码；ARIN 只给英文国名时换不成代码就原样放）；查不到为 None
    pub registered_country: Option<String>,
    pub registered_country_name: Option<String>,
    /// 原生 IP：注册国家与这次测到的所在地相同；任一边不知道为 None
    pub native: Option<bool>,
}

const DATACENTER_HINTS: &[&str] = &[
    "oracle", "amazon", "aws", "google", "microsoft", "azure", "digitalocean", "vultr", "choopa", "linode",
    "akamai", "ovh", "hetzner", "alibaba", "aliyun", "tencent", "huawei cloud", "cloudflare", "contabo",
    "leaseweb", "m247", "datacamp", "cdn77", "hostinger", "it7", "bandwagon", "racknerd", "colocrossing",
    "psychz", "zenlayer", "gcore", "g-core", "scaleway", "upcloud", "kamatera", "hosting", "server",
    "data center", "datacenter", "cloud", "vps", "dedicated",
];
const RESIDENTIAL_HINTS: &[&str] = &[
    "dynamic", "dsl", "broadband", "pool", "dhcp", "ftth", "fiber", "fibre", "cable", "ppp", "telecom",
    "telekom", "telefonica", "mobile", "comcast", "verizon", "at&t", "charter", "hinet", "chunghwa",
];

/// 住宅还是机房：先认云厂商 / 托管（名字带 AI 的节点常是机房 IP），再认运营商与动态地址的反解名；都不像就说看不出来
pub fn classify_exit(org: &str, hostname: &str) -> (&'static str, &'static str) {
    let org_l = org.to_ascii_lowercase();
    let host_l = hostname.to_ascii_lowercase();
    if DATACENTER_HINTS.iter().any(|k| org_l.contains(k)) {
        return ("datacenter", "机房");
    }
    if RESIDENTIAL_HINTS.iter().any(|k| org_l.contains(k) || host_l.contains(k)) {
        return ("residential", "住宅");
    }
    ("unknown", "看不出来")
}

/// RDAP 返回里取注册国家：RIPE / APNIC / LACNIC / AFRINIC 有顶层 `country`；
/// ARIN 没有，取注册人地址（vCard adr 的 label）最后一行的英文国名
pub fn parse_rdap_country(v: &serde_json::Value) -> Option<String> {
    if let Some(c) = v.get("country").and_then(|x| x.as_str()).filter(|c| c.len() == 2) {
        return Some(c.to_ascii_uppercase());
    }
    let entities = v.get("entities")?.as_array()?;
    let registrant = entities.iter().find(|e| {
        e.get("roles").and_then(|r| r.as_array()).is_some_and(|r| r.iter().any(|x| x == "registrant"))
    })?;
    let props = registrant.get("vcardArray")?.get(1)?.as_array()?;
    let label = props
        .iter()
        .find(|p| p.get(0).and_then(|x| x.as_str()) == Some("adr"))?
        .get(1)?
        .get("label")?
        .as_str()?;
    let last = label.lines().map(str::trim).filter(|l| !l.is_empty()).last()?;
    Some(match last {
        "United States" => "US".to_string(),
        "Canada" => "CA".to_string(),
        other => other.to_string(),
    })
}

/// 依次直连、经出网代理 GET 一个 JSON；都不通为 None
async fn fetch_json(url: &str) -> Option<serde_json::Value> {
    let settings_proxy = crate::settings::official_outbound_env()
        .into_iter()
        .find(|(k, _)| k == "HTTPS_PROXY")
        .map(|(_, v)| v);
    for proxy in [None, settings_proxy.as_deref()] {
        let mut b = reqwest::Client::builder().timeout(Duration::from_secs(8));
        b = match proxy {
            Some(p) => match reqwest::Proxy::all(p) {
                Ok(px) => b.proxy(px),
                Err(_) => continue,
            },
            None => b.no_proxy(),
        };
        let Ok(client) = b.build() else { continue };
        if let Ok(resp) = client.get(url).header("Accept", "application/rdap+json, application/json").send().await {
            if let Ok(v) = resp.json::<serde_json::Value>().await {
                return Some(v);
            }
        }
    }
    None
}

/// 「查出口类型」：把这家最近一次的出口 IP 发给 ipinfo.io 查所属网络。只在用户点按钮时查（要把 IP 发给第三方），
/// 顺带查 RDAP 注册国家判原生 IP；结果按 IP 缓存 24 小时；先直连查，不通再经出网代理
#[tauri::command]
pub async fn route_exit_type(agent_id: String) -> Result<ExitTypeDto, String> {
    let addr = LAST_ADDR
        .lock()
        .ok()
        .and_then(|m| m.as_ref()?.get(&agent_id).cloned())
        .ok_or("先测一次线路")?;
    if addr.parse::<std::net::IpAddr>().is_err() {
        return Err("出口地址不对".into());
    }
    let now = now_secs();
    if let Some((at, dto)) = EXIT_TYPE_CACHE.lock().ok().and_then(|m| m.as_ref()?.get(&addr).cloned()) {
        if now - at < 24 * 3600 {
            return Ok(dto);
        }
    }
    let v = fetch_json(&format!("https://ipinfo.io/{addr}/json")).await.ok_or("查不到（ipinfo.io 连不上）")?;
    let org = v.get("org").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let hostname = v.get("hostname").and_then(|x| x.as_str()).unwrap_or("");
    let (kind, label) = classify_exit(&org, hostname);
    // 原生 IP：查公开注册信息（从 RIPE 的 RDAP 进，它会转到这段地址所属的注册机构；rdap.org 国内直连不通），和这次测到的所在地比；所在地以探测为准（服务方看到的也是它）
    let registered_country = match fetch_json(&format!("https://rdap.db.ripe.net/ip/{addr}")).await {
        Some(r) => parse_rdap_country(&r),
        None => None,
    };
    let located = CACHE
        .lock()
        .ok()
        .and_then(|m| m.as_ref()?.get(&agent_id)?.exit_region.clone())
        .or_else(|| v.get("country").and_then(|x| x.as_str()).map(str::to_ascii_uppercase));
    let native = match (&registered_country, &located) {
        (Some(r), Some(l)) if r.len() == 2 => Some(r == l),
        _ => None,
    };
    let dto = ExitTypeDto {
        kind,
        label,
        org,
        registered_country_name: registered_country.as_deref().map(region_name),
        registered_country,
        native,
    };
    if let Ok(mut m) = EXIT_TYPE_CACHE.lock() {
        m.get_or_insert_with(HashMap::new).insert(addr, (now, dto.clone()));
    }
    Ok(dto)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProxyAppDto {
    pub name: String,
    pub path: String,
}

/// 常见代理客户端（显示名，macOS .app 名 / Windows 相对安装位置）
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
const PROXY_APPS: &[(&str, &str, &[&str])] = &[
    ("Clash Verge", "Clash Verge.app", &["Clash Verge\\clash-verge.exe"]),
    ("Mihomo Party", "Mihomo Party.app", &["mihomo-party\\Mihomo Party.exe"]),
    ("FlClash", "FlClash.app", &["FlClash\\FlClash.exe"]),
    ("ClashX Pro", "ClashX Pro.app", &[]),
    ("ClashX Meta", "ClashX Meta.app", &[]),
    ("ClashX", "ClashX.app", &[]),
    ("Clash for Windows", "Clash for Windows.app", &["Clash for Windows\\Clash for Windows.exe"]),
    ("Surge", "Surge.app", &[]),
    ("Stash", "Stash.app", &[]),
    ("V2rayU", "V2rayU.app", &[]),
    ("v2rayN", "v2rayN.app", &["v2rayN\\v2rayN.exe"]),
    ("Hiddify", "Hiddify.app", &["Hiddify\\Hiddify.exe"]),
];

/// 本机装了哪些常见代理客户端（修复「代理没在运行」用：给出「打开 XX」按钮）
#[tauri::command]
pub fn route_proxy_apps() -> Vec<ProxyAppDto> {
    let mut found = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let mut roots = vec![std::path::PathBuf::from("/Applications")];
        if let Some(home) = crate::dirs::home_dir() {
            roots.push(home.join("Applications"));
        }
        for (name, app, _) in PROXY_APPS {
            if let Some(p) = roots.iter().map(|r| r.join(app)).find(|p| p.exists()) {
                found.push(ProxyAppDto { name: name.to_string(), path: p.to_string_lossy().into_owned() });
            }
        }
    }
    #[cfg(windows)]
    {
        let roots: Vec<std::path::PathBuf> = ["ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(|k| std::env::var_os(k).map(std::path::PathBuf::from))
            .chain(std::env::var_os("LOCALAPPDATA").map(|l| std::path::PathBuf::from(l).join("Programs")))
            .collect();
        for (name, _, rels) in PROXY_APPS {
            if let Some(p) = rels.iter().flat_map(|rel| roots.iter().map(move |r| r.join(rel))).find(|p| p.exists()) {
                found.push(ProxyAppDto { name: name.to_string(), path: p.to_string_lossy().into_owned() });
            }
        }
    }
    found
}

/// 打开一个代理客户端：只认 route_proxy_apps 列出来的路径，不开任意程序
#[tauri::command]
pub async fn route_open_proxy_app(path: String) -> Result<(), String> {
    if !route_proxy_apps().iter().any(|a| crate::paths::same_path(&a.path, &path)) {
        return Err("不是已识别的代理软件".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let r = crate::process::background_command("open").args(["-a", &path]).status().map(|_| ());
        #[cfg(windows)]
        let r = crate::process::background_command(&path).spawn().map(|_| ());
        #[cfg(not(any(target_os = "macos", windows)))]
        let r: std::io::Result<()> = Err(std::io::Error::other("这个平台暂不支持"));
        r.map_err(|e| format!("打开失败：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROBE: RouteProbe = RouteProbe {
        url: "https://claude.ai/cdn-cgi/trace",
        host: "claude.ai",
        reports_region: true,
        unsupported_regions: &["CN", "HK"],
        service_check: Some(ServiceCheck::AnthropicKeyless),
    };

    fn input(outcome: Option<ProbeOutcome>) -> JudgeInput<'static> {
        JudgeInput {
            probe: &PROBE,
            source: ProxySource::Settings,
            proxy: Some("http://127.0.0.1:7897"),
            proxy_down: None,
            outcome,
            usual: None,
            service: None,
        }
    }

    #[test]
    fn proxy_source_follows_launch_injection_order() {
        let settings = vec![("HTTPS_PROXY".to_string(), "http://127.0.0.1:7897".to_string())];
        let none = HashMap::new();
        let shell = |k: &str| (k == "https_proxy").then(|| "http://127.0.0.1:1080".to_string());
        let mut extra = HashMap::new();
        extra.insert("HTTPS_PROXY".to_string(), "http://10.0.0.2:3128".to_string());
        assert_eq!(resolve_proxy(&settings, &extra, shell), (ProxySource::Connection, Some("http://10.0.0.2:3128".into())));
        assert_eq!(resolve_proxy(&settings, &none, shell), (ProxySource::Settings, Some("http://127.0.0.1:7897".into())));
        assert_eq!(resolve_proxy(&[], &none, shell), (ProxySource::Shell, Some("http://127.0.0.1:1080".into())));
        assert_eq!(resolve_proxy(&[], &none, |_| None), (ProxySource::None, None));
        let mut cleared = HashMap::new();
        cleared.insert("HTTPS_PROXY".to_string(), " ".to_string());
        assert_eq!(resolve_proxy(&settings, &cleared, shell), (ProxySource::Connection, None), "连接里显式填空 = 不走代理");
    }

    #[test]
    fn redacts_credentials() {
        assert_eq!(redact_proxy("http://user:pass@127.0.0.1:7897"), "http://127.0.0.1:7897");
        assert_eq!(redact_proxy("socks5://u:p@[::1]:1080"), "socks5://[::1]:1080");
    }

    #[test]
    fn parses_trace_loc() {
        assert_eq!(parse_trace_loc("fl=1\nip=31.94.12.127\nloc=GB\ntls=TLSv1.3\n").as_deref(), Some("GB"));
        assert_eq!(parse_trace_loc("ip=1.2.3.4\n"), None);
    }

    #[test]
    fn dead_local_proxy_blocks_before_probing() {
        let mut i = input(None);
        i.proxy_down = Some("127.0.0.1:7888".into());
        let (v, stage, reason, ..) = judge(&i);
        assert_eq!((v, stage), (Verdict::Block, Some(Stage::Proxy)));
        assert_eq!(reason, "代理 127.0.0.1:7888 没开");
    }

    #[test]
    fn unreachable_blocks_and_says_which_leg() {
        let (v, stage, reason, ..) = judge(&input(Some(ProbeOutcome::Timeout)));
        assert_eq!((v, stage), (Verdict::Block, Some(Stage::Reach)));
        assert_eq!(reason, "经代理连不上 claude.ai（超时）");
        let mut direct = input(Some(ProbeOutcome::Failed("连接被拒或中断".into())));
        direct.proxy = None;
        direct.source = ProxySource::None;
        let (_, _, reason, ..) = judge(&direct);
        assert_eq!(reason, "直连连不上 claude.ai，要设出网代理");
    }

    #[test]
    fn unsupported_region_blocks() {
        let (v, stage, reason, region, _) = judge(&input(Some(ProbeOutcome::Ok { loc: Some("HK".into()), ip: None, addr: None, latency_ms: 300 })));
        assert_eq!((v, stage, region.as_deref()), (Verdict::Block, Some(Stage::Region), Some("HK")));
        assert_eq!(reason, "香港，不支持这个地区");
    }

    #[test]
    fn supported_region_passes_and_unknown_is_review() {
        let (v, stage, reason, region, latency) = judge(&input(Some(ProbeOutcome::Ok { loc: Some("GB".into()), ip: None, addr: None, latency_ms: 1030 })));
        assert_eq!((v, stage, region.as_deref(), latency), (Verdict::Pass, None, Some("GB"), Some(1030)));
        assert_eq!(reason, "英国 · 1.0 秒");
        let (v, ..) = judge(&input(Some(ProbeOutcome::Ok { loc: None, ip: None, addr: None, latency_ms: 900 })));
        assert_eq!(v, Verdict::Review);
        const NO_REGION: RouteProbe = RouteProbe { url: "https://api2.cursor.sh/", host: "api2.cursor.sh", reports_region: false, unsupported_regions: &[], service_check: None };
        let mut cursor = input(Some(ProbeOutcome::Ok { loc: None, ip: None, addr: None, latency_ms: 1200 }));
        cursor.probe = &NO_REGION;
        assert_eq!(judge(&cursor).0, Verdict::Pass, "本来就不回地区的，连得上就算通过");
        assert_eq!(judge(&cursor).2, "连得上 · 1.2 秒");
        let (v, ..) = judge(&input(Some(ProbeOutcome::Unsupported("SOCKS".into()))));
        assert_eq!(v, Verdict::Review, "测不了不当失败");
    }

    #[test]
    fn usual_region_is_recent_majority_and_respects_accept() {
        let now = 10 * 24 * 3600;
        let rec = |region: &str, at: i64| ExitRecord { region: region.into(), prefix: None, at };
        let list = vec![rec("US", now - 9 * 24 * 3600), rec("GB", now - 3600), rec("GB", now - 1800), rec("US", now - 60)];
        assert_eq!(usual_region(&list, None, now).as_deref(), Some("GB"), "7 天外的 US 不算");
        assert_eq!(usual_region(&[], None, now), None, "第一次没有常用地区，不提示");
        let accepted = AcceptedRegion { region: "US".into(), at: now - 100 };
        assert_eq!(usual_region(&list, Some(&accepted), now).as_deref(), Some("US"), "记为常用之后只看之后的记录");
        assert_eq!(usual_region(&[], Some(&accepted), now).as_deref(), Some("US"));
    }

    #[test]
    fn region_change_is_review_but_unsupported_still_blocks() {
        let mut i = input(Some(ProbeOutcome::Ok { loc: Some("US".into()), ip: None, addr: None, latency_ms: 800 }));
        i.usual = Some("GB");
        let (v, _, reason, ..) = judge(&i);
        assert_eq!(v, Verdict::Review);
        assert_eq!(reason, "美国（常用英国）");
        let mut hk = input(Some(ProbeOutcome::Ok { loc: Some("HK".into()), ip: None, addr: None, latency_ms: 300 }));
        hk.usual = Some("GB");
        assert_eq!(judge(&hk).0, Verdict::Block, "地区不支持优先于地区变化");
        let mut same = input(Some(ProbeOutcome::Ok { loc: Some("GB".into()), ip: None, addr: None, latency_ms: 300 }));
        same.usual = Some("GB");
        assert_eq!(judge(&same).0, Verdict::Pass);
    }

    #[test]
    fn reads_first_party_answers_seen_in_practice() {
        // 2026-11-06 实测原文
        let gb = r#"{"type":"error","error":{"type":"authentication_error","message":"x-api-key header is required"}}"#;
        let cn = r#"{"error":{"type":"forbidden","message":"Request not allowed"}}"#;
        assert_eq!(read_anthropic_keyless(401, gb), ServiceSays::Allowed);
        assert_eq!(read_anthropic_keyless(403, cn), ServiceSays::Blocked);
        assert_eq!(read_anthropic_keyless(403, "<html>Just a moment...</html>"), ServiceSays::Unknown, "Cloudflare 拦脚本不算地区被拒");
        assert_eq!(read_anthropic_keyless(500, ""), ServiceSays::Unknown);
        assert_eq!(read_openai_compliance(200, "{\n  \"cookie_consent_required\": true\n}"), ServiceSays::Allowed);
        assert_eq!(read_openai_compliance(403, r#"{"error":{"code":"unsupported_country"}}"#), ServiceSays::Blocked);
        assert_eq!(read_openai_compliance(502, ""), ServiceSays::Unknown);
    }

    #[test]
    fn service_answer_beats_the_static_region_list() {
        let ok_hk = || Some(ProbeOutcome::Ok { loc: Some("HK".into()), ip: None, addr: None, latency_ms: 300 });
        let mut i = input(ok_hk());
        i.service = Some(ServiceSays::Allowed);
        assert_eq!(judge(&i).0, Verdict::Pass, "服务方放行就不按名单拦");
        let mut gb = input(Some(ProbeOutcome::Ok { loc: Some("GB".into()), ip: None, addr: None, latency_ms: 300 }));
        gb.service = Some(ServiceSays::Blocked);
        let (v, stage, reason, ..) = judge(&gb);
        assert_eq!((v, stage), (Verdict::Block, Some(Stage::Region)));
        assert_eq!(reason, "英国，Claude 不支持这个地区");
        let mut unknown = input(ok_hk());
        unknown.service = Some(ServiceSays::Unknown);
        assert_eq!(judge(&unknown).0, Verdict::Block, "服务方没答复时名单兜底");
    }

    #[test]
    fn classifies_exit_networks_seen_in_practice() {
        // 2026-11-06 实测过的几种出口
        assert_eq!(classify_exit("AS2856 British Telecommunications Limited", "").1, "住宅");
        assert_eq!(classify_exit("AS3462 Data Communication Business Group", "36-232-2-128.dynamic-ip.hinet.net").1, "住宅");
        assert_eq!(classify_exit("AS31898 Oracle Corporation", "").1, "机房", "名字带 AI 的节点实际是甲骨文云");
        assert_eq!(classify_exit("AS16509 Amazon.com, Inc.", "ec2-1-2-3-4.compute.amazonaws.com").1, "机房");
        assert_eq!(classify_exit("AS4134 CHINANET-BACKBONE", "").1, "看不出来");
    }

    #[test]
    fn rdap_country_from_regional_registries() {
        // 2026-11-07 实测：RIPE 有顶层 country；ARIN 只有注册人地址
        let ripe = serde_json::json!({"country": "GB", "name": "EE-MOBILE", "port43": "whois.ripe.net"});
        assert_eq!(parse_rdap_country(&ripe).as_deref(), Some("GB"));
        let arin = serde_json::json!({"name": "GOGL", "entities": [{"roles": ["registrant"], "vcardArray": ["vcard", [
            ["version", {}, "text", "4.0"],
            ["adr", {"label": "1600 Amphitheatre Parkway\nMountain View\nCA\n94043\nUnited States"}, "text", ["", "", "", "", "", "", ""]]
        ]]}]});
        assert_eq!(parse_rdap_country(&arin).as_deref(), Some("US"));
        assert_eq!(parse_rdap_country(&serde_json::json!({"name": "X"})), None);
    }

    #[test]
    fn trace_prefix_drops_host_part() {
        assert_eq!(parse_trace_prefix("ip=31.94.12.127\nloc=GB").as_deref(), Some("31.94.12.0/24"));
        assert_eq!(parse_trace_prefix("ip=2408:8340:828:1ea0::1\n").as_deref(), Some("2408:8340:828::/48"));
        assert_eq!(parse_trace_prefix("loc=GB"), None);
    }

    /// 真联网冒烟（默认跳过，CI 不跑）：`ROUTE_CHECK_PROXY=http://127.0.0.1:7897 cargo test real_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_probe_smoke() {
        let proxy = std::env::var("ROUTE_CHECK_PROXY").ok();
        for url in ["https://claude.ai/cdn-cgi/trace", "https://chatgpt.com/cdn-cgi/trace"] {
            let out = tauri::async_runtime::block_on(probe(url, proxy.as_deref(), true));
            println!("{url} via {proxy:?} → {out:?}");
        }
        for check in [ServiceCheck::AnthropicKeyless, ServiceCheck::OpenAiCompliance] {
            println!("{check:?} 经 {proxy:?} → {:?}", tauri::async_runtime::block_on(ask_service(check, proxy.as_deref())));
            println!("{check:?} 直连 → {:?}", tauri::async_runtime::block_on(ask_service(check, None)));
        }
        for ip in ["8.8.8.8", "31.94.12.1", "1.1.1.1"] {
            let r = tauri::async_runtime::block_on(fetch_json(&format!("https://rdap.db.ripe.net/ip/{ip}")));
            println!("RDAP {ip} → {:?}", r.as_ref().and_then(parse_rdap_country));
        }
        println!("本机代理软件 → {:?}", route_proxy_apps());
        let dead = tauri::async_runtime::block_on(probe(PROBE.url, Some("http://127.0.0.1:1"), true));
        println!("死代理 → {dead:?}");
        assert!(matches!(dead, ProbeOutcome::Failed(_) | ProbeOutcome::Timeout));
    }

    #[test]
    fn first_class_agents_have_probes() {
        for id in ["claude-code", "codex"] {
            let p = agent_spec(id).unwrap().official_account.as_ref().unwrap().route_probe.as_ref().unwrap();
            assert!(p.url.ends_with("/cdn-cgi/trace") && p.url.contains(p.host));
            assert!(p.unsupported_regions.contains(&"CN"));
        }
        assert_eq!(route_check_agents(), ["claude-code", "codex", "gemini", "cursor", "grok", "agy"].map(String::from).to_vec());
    }
}
