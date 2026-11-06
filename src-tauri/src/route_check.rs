//! 官方账号线路体检（docs/design-outbound-route.md 一期）：经与官方启动同源的代理环境，访问这家服务
//! 自己的公开诊断地址（`agent_specs::RouteProbe`），判「通过 / 拦下 / 待你判断」。
//! 只读、不带凭据；只对官方账号。规则分流的代理下出口随域名变，所以必须用这家服务自己的域名测，
//! 中立的查 IP 网站测出来的出口可能不是它的。判定是纯函数（`judge`），网络只在 `probe` 里。

use crate::agent_specs::{agent_spec, RouteProbe};
use serde::Serialize;
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
    /// unix 秒
    pub checked_at: i64,
}

/// 一次探测的结果（judge 的输入）
#[derive(Debug, Clone, PartialEq)]
pub enum ProbeOutcome {
    Ok { loc: Option<String>, latency_ms: u64 },
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

pub struct JudgeInput<'a> {
    pub display_name: &'a str,
    pub probe: &'a RouteProbe,
    pub source: ProxySource,
    pub proxy: Option<&'a str>,
    /// 本机代理端口在不在听：Some(false) = 代理没开；远端代理 / 没代理为 None
    pub proxy_down: Option<String>,
    pub outcome: Option<ProbeOutcome>,
}

/// 判定：纯函数，§4.3 三档
pub fn judge(input: &JudgeInput) -> (Verdict, Option<Stage>, String, Option<String>, Option<u64>) {
    let host = input.probe.host;
    if let Some(target) = &input.proxy_down {
        let where_ = match input.source {
            ProxySource::Connection => "这条连接的附加环境变量里",
            ProxySource::Shell => "登录 shell 带进来的",
            _ => "设置里的",
        };
        return (
            Verdict::Block,
            Some(Stage::Proxy),
            format!("{where_}出网代理 {target} 没有在运行：先打开代理软件，或到设置 → 网络改掉"),
            None,
            None,
        );
    }
    let via = if input.proxy.is_some() { "经出网代理" } else { "直连" };
    let hint_no_proxy = if input.proxy.is_none() {
        "；官方账号在国内一般要设出网代理"
    } else {
        "：代理软件的节点或它的下一跳可能不通"
    };
    match input.outcome.as_ref() {
        None => (Verdict::Review, None, "还没体检".into(), None, None),
        Some(ProbeOutcome::Unsupported(msg)) => (Verdict::Review, None, msg.clone(), None, None),
        Some(ProbeOutcome::Timeout) => (
            Verdict::Block,
            Some(Stage::Reach),
            format!("{via}访问 {host} 超时{hint_no_proxy}"),
            None,
            None,
        ),
        Some(ProbeOutcome::Failed(err)) => (
            Verdict::Block,
            Some(Stage::Reach),
            format!("{via}访问 {host} 失败（{err}）{hint_no_proxy}"),
            None,
            None,
        ),
        Some(ProbeOutcome::Ok { loc: None, latency_ms }) => (
            Verdict::Review,
            None,
            format!("{host} 能连上，但没拿到出口地区"),
            None,
            Some(*latency_ms),
        ),
        Some(ProbeOutcome::Ok { loc: Some(loc), latency_ms }) => {
            let name = region_name(loc);
            if input.probe.unsupported_regions.contains(&loc.as_str()) {
                (
                    Verdict::Block,
                    Some(Stage::Region),
                    format!(
                        "{} 的请求从{name}出去，这个地区它不提供服务：到代理软件里把这家服务换到别的地区的节点",
                        input.display_name
                    ),
                    Some(loc.clone()),
                    Some(*latency_ms),
                )
            } else {
                (
                    Verdict::Pass,
                    None,
                    format!("从{name}出去，{latency_ms} 毫秒"),
                    Some(loc.clone()),
                    Some(*latency_ms),
                )
            }
        }
    }
}

/// 真去访问一次：与启动同源的代理；没代理时显式直连（不让 reqwest 自己读进程环境里的代理变量）
async fn probe(url: &str, proxy: Option<&str>) -> ProbeOutcome {
    if let Some(p) = proxy {
        if p.trim_start().to_ascii_lowercase().starts_with("socks") {
            return ProbeOutcome::Unsupported("出网代理是 SOCKS，线路体检暂时测不了，只确认了本机代理端口在运行".into());
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
            if !status.is_success() && parse_trace_loc(&body).is_none() {
                return ProbeOutcome::Failed(format!("HTTP {}", status.as_u16()));
            }
            ProbeOutcome::Ok { loc: parse_trace_loc(&body), latency_ms }
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
        Some(probe(probe_spec.url, proxy.as_deref()).await)
    };
    let (verdict, stage, reason, exit_region, latency_ms) = judge(&JudgeInput {
        display_name: spec.display_name,
        probe: probe_spec,
        source,
        proxy: proxy.as_deref(),
        proxy_down,
        outcome,
    });
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
        checked_at: now_secs(),
    };
    if let Ok(mut c) = CACHE.lock() {
        c.get_or_insert_with(HashMap::new).insert(cache_key, dto.clone());
    }
    Ok(dto)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROBE: RouteProbe = RouteProbe {
        url: "https://claude.ai/cdn-cgi/trace",
        host: "claude.ai",
        unsupported_regions: &["CN", "HK"],
    };

    fn input(outcome: Option<ProbeOutcome>) -> JudgeInput<'static> {
        JudgeInput {
            display_name: "Claude Code",
            probe: &PROBE,
            source: ProxySource::Settings,
            proxy: Some("http://127.0.0.1:7897"),
            proxy_down: None,
            outcome,
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
        assert!(reason.contains("127.0.0.1:7888") && reason.contains("设置里的"), "{reason}");
    }

    #[test]
    fn unreachable_blocks_and_says_which_leg() {
        let (v, stage, reason, ..) = judge(&input(Some(ProbeOutcome::Timeout)));
        assert_eq!((v, stage), (Verdict::Block, Some(Stage::Reach)));
        assert!(reason.contains("经出网代理") && reason.contains("下一跳"), "{reason}");
        let mut direct = input(Some(ProbeOutcome::Failed("连接被拒或中断".into())));
        direct.proxy = None;
        direct.source = ProxySource::None;
        let (_, _, reason, ..) = judge(&direct);
        assert!(reason.starts_with("直连") && reason.contains("要设出网代理"), "{reason}");
    }

    #[test]
    fn unsupported_region_blocks() {
        let (v, stage, reason, region, _) = judge(&input(Some(ProbeOutcome::Ok { loc: Some("HK".into()), latency_ms: 300 })));
        assert_eq!((v, stage, region.as_deref()), (Verdict::Block, Some(Stage::Region), Some("HK")));
        assert!(reason.contains("香港"), "{reason}");
    }

    #[test]
    fn supported_region_passes_and_unknown_is_review() {
        let (v, stage, reason, region, latency) = judge(&input(Some(ProbeOutcome::Ok { loc: Some("GB".into()), latency_ms: 1030 })));
        assert_eq!((v, stage, region.as_deref(), latency), (Verdict::Pass, None, Some("GB"), Some(1030)));
        assert_eq!(reason, "从英国出去，1030 毫秒");
        let (v, ..) = judge(&input(Some(ProbeOutcome::Ok { loc: None, latency_ms: 900 })));
        assert_eq!(v, Verdict::Review);
        let (v, ..) = judge(&input(Some(ProbeOutcome::Unsupported("SOCKS".into()))));
        assert_eq!(v, Verdict::Review, "测不了不当失败");
    }

    /// 真联网冒烟（默认跳过，CI 不跑）：`ROUTE_CHECK_PROXY=http://127.0.0.1:7897 cargo test real_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_probe_smoke() {
        let proxy = std::env::var("ROUTE_CHECK_PROXY").ok();
        for url in ["https://claude.ai/cdn-cgi/trace", "https://chatgpt.com/cdn-cgi/trace"] {
            let out = tauri::async_runtime::block_on(probe(url, proxy.as_deref()));
            println!("{url} via {proxy:?} → {out:?}");
        }
        let dead = tauri::async_runtime::block_on(probe(PROBE.url, Some("http://127.0.0.1:1")));
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
        assert_eq!(route_check_agents(), vec!["claude-code".to_string(), "codex".to_string()]);
    }
}
