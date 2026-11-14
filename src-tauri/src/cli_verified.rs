//! 已核对 CLI 版本联网前移（2026-11-04 用户拍板，设计 docs/design-chat-fidelity.md §1「按版本降级」）。
//!
//! 核对版本原本只在打包时从金丝雀基线读进安装包；Claude Code 几乎天天发版，装好的 Mesa 一两天后就一直「未核对」，
//! 替人按的步骤一直停着。CI 金丝雀每天在 main 上把「指纹没变、只是版本往前走」的基线前移，这里把它取回来：
//! **只有远端基线的指纹（除 version / checks 外的全部字段）与本包随带的基线完全一样**才认它的版本——
//! 指纹变了说明 CLI 改了样子、main 上的 Mesa 为它改过代码，这个旧包不会，照旧降级。
//! 取不到就用缓存，缓存也没有就只用随包的（前端 cli-verified.ts 与随包表取较新的）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;

/// 依次试，连不上就换下一个。api.github.com 排第一：本机国内网络实测 raw.githubusercontent.com 被重置、
/// jsDelivr 解析超时，只有 API 通（2026-11-04）；未登录限额每小时 60 次，半天 9 次够用。
/// 仓库地址再转移时与 tauri.conf updater 一起改
const BASELINE_HOSTS: [&str; 3] = [
    "https://api.github.com/repos/Zeta-Techs/mesa/contents/scripts/cli-canary/baseline",
    "https://raw.githubusercontent.com/Zeta-Techs/mesa/main/scripts/cli-canary/baseline",
    "https://cdn.jsdelivr.net/gh/Zeta-Techs/mesa@main/scripts/cli-canary/baseline",
];
/// 金丝雀一天一跑，半天取一次足够
const CACHE_TTL_SECS: i64 = 12 * 3600;
const FETCH_TIMEOUT: Duration = Duration::from_secs(6);
const BASELINE_CAP: usize = 512 * 1024;

macro_rules! bundled {
    ($plat:literal) => {
        &[
            ("claude-code", include_str!(concat!("../../scripts/cli-canary/baseline/", $plat, "/claude-code.json"))),
            ("codebuddy", include_str!(concat!("../../scripts/cli-canary/baseline/", $plat, "/codebuddy.json"))),
            ("codex", include_str!(concat!("../../scripts/cli-canary/baseline/", $plat, "/codex.json"))),
            ("cursor", include_str!(concat!("../../scripts/cli-canary/baseline/", $plat, "/cursor.json"))),
            ("gemini", include_str!(concat!("../../scripts/cli-canary/baseline/", $plat, "/gemini.json"))),
            ("grok", include_str!(concat!("../../scripts/cli-canary/baseline/", $plat, "/grok.json"))),
            ("kimi", include_str!(concat!("../../scripts/cli-canary/baseline/", $plat, "/kimi.json"))),
            ("opencode", include_str!(concat!("../../scripts/cli-canary/baseline/", $plat, "/opencode.json"))),
            ("qwen", include_str!(concat!("../../scripts/cli-canary/baseline/", $plat, "/qwen.json"))),
        ]
    };
}

#[cfg(target_os = "macos")]
const PLATFORM: &str = "darwin";
#[cfg(target_os = "macos")]
const BUNDLED: &[(&str, &str)] = bundled!("darwin");
#[cfg(windows)]
const PLATFORM: &str = "win32";
#[cfg(windows)]
const BUNDLED: &[(&str, &str)] = bundled!("win32");
/// 只在部分平台有基线的：OpenCode 2.x（opencode2，金丝雀 2026-11-04 起 macOS、2026-11-06 起 Windows；Linux 没有）、
/// Antigravity CLI（agy，2026-11-14 起 macOS；Windows 待本机 --accept 建好后补进 win32）
#[cfg(target_os = "macos")]
const BUNDLED_EXTRA: &[(&str, &str)] = &[
    ("opencode2", include_str!("../../scripts/cli-canary/baseline/darwin/opencode2.json")),
    ("agy", include_str!("../../scripts/cli-canary/baseline/darwin/agy.json")),
];
#[cfg(windows)]
const BUNDLED_EXTRA: &[(&str, &str)] =
    &[("opencode2", include_str!("../../scripts/cli-canary/baseline/win32/opencode2.json"))];
#[cfg(not(any(target_os = "macos", windows)))]
const BUNDLED_EXTRA: &[(&str, &str)] = &[];
// Linux 没有金丝雀基线（本版本未开发），前端照旧取别的平台里最新的
#[cfg(not(any(target_os = "macos", windows)))]
const PLATFORM: &str = "linux";
#[cfg(not(any(target_os = "macos", windows)))]
const BUNDLED: &[(&str, &str)] = &[];

#[derive(Serialize, Deserialize, Default)]
struct Cache {
    app_version: String,
    fetched_at: i64,
    /// agent → 前移后的核对版本（只放比随包新的）
    advanced: BTreeMap<String, String>,
}

/// 与前端 chat-fidelity.ts parseVersion 同口径：取第一个 x.y.z
fn parse_version(text: &str) -> Option<[u64; 3]> {
    text.split(|c: char| !c.is_ascii_digit() && c != '.').find_map(|tok| {
        let mut it = tok.split('.').filter(|s| !s.is_empty());
        let v = [it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next()?.parse().ok()?];
        Some(v)
    })
}

/// 去掉不算指纹的字段；canary.py 比基线时同样不看 version / checks，这次没抓屏（screen 为 null）不算画面变化
fn fingerprint(v: &Value, ignore_screen: bool) -> Value {
    let mut v = v.clone();
    if let Some(o) = v.as_object_mut() {
        o.remove("version");
        o.remove("checks");
        if ignore_screen {
            o.insert("screen".into(), Value::Null);
        }
    }
    v
}

/// 远端基线能不能替这个包把核对版本往前挪：指纹一样、版本更新才返回远端版本
fn advanced_version(bundled: &str, remote: &str) -> Option<String> {
    let b: Value = serde_json::from_str(bundled).ok()?;
    let r: Value = serde_json::from_str(remote).ok()?;
    let rv = r.get("version")?.as_str()?;
    let bv = b.get("version")?.as_str()?;
    if parse_version(rv)? <= parse_version(bv)? {
        return None;
    }
    let ignore_screen = r.get("screen").is_none_or(Value::is_null);
    (fingerprint(&b, ignore_screen) == fingerprint(&r, ignore_screen)).then(|| rv.to_string())
}

fn cache_path() -> Option<std::path::PathBuf> {
    Some(crate::dirs::config_dir()?.join("ccode").join("cli-verified-cache.json"))
}

fn read_cache() -> Option<Cache> {
    let text = std::fs::read_to_string(cache_path()?).ok()?;
    let c: Cache = serde_json::from_str(&text).ok()?;
    // 换了 Mesa 版本，随包基线变了，旧缓存是对着旧基线算的
    (c.app_version == env!("CARGO_PKG_VERSION")).then_some(c)
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    // contents API 带这个头直接回文件原文（不是 base64 包装）；另两个源不看这个头
    let resp = client
        .get(url)
        .header("Accept", "application/vnd.github.raw")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = crate::storage::response_bytes(resp, BASELINE_CAP).await?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

/// 前端取：agent → 比随包新、经指纹核对可用的核对版本。半天内用缓存；取不到不报错，退回缓存或空表
#[tauri::command]
pub async fn cli_verified_advanced() -> BTreeMap<String, String> {
    let now = chrono::Utc::now().timestamp();
    let cached = read_cache();
    if let Some(c) = &cached {
        if now - c.fetched_at < CACHE_TTL_SECS {
            return c.advanced.clone();
        }
    }
    let Ok(client) = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent("Mesa cli-verified (https://github.com/Zeta-Techs/mesa)")
        .build()
    else {
        return cached.map(|c| c.advanced).unwrap_or_default();
    };
    let mut advanced = cached.as_ref().map(|c| c.advanced.clone()).unwrap_or_default();
    let mut hosts: Vec<&str> = BASELINE_HOSTS.to_vec();
    let mut fetched_any = false;
    for (agent, bundled) in BUNDLED.iter().chain(BUNDLED_EXTRA) {
        let mut remote = None;
        while let Some(host) = hosts.first().copied() {
            match fetch_text(&client, &format!("{host}/{PLATFORM}/{agent}.json")).await {
                Ok(t) => {
                    remote = Some(t);
                    break;
                }
                // 这一家远端没有（新加的 CLI 还没进 main）：不算源坏了
                Err(e) if e == "HTTP 404 Not Found" => break,
                // 这个源连不上 / 限额用完：后面几家也不再试它
                Err(_) if hosts.len() > 1 => {
                    hosts.remove(0);
                }
                Err(_) => break,
            }
        }
        let Some(remote) = remote else { continue };
        fetched_any = true;
        match advanced_version(bundled, &remote) {
            Some(v) => advanced.insert(agent.to_string(), v),
            None => advanced.remove(*agent),
        };
    }
    if fetched_any {
        let cache = Cache {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            fetched_at: now,
            advanced: advanced.clone(),
        };
        if let (Some(path), Ok(text)) = (cache_path(), serde_json::to_string_pretty(&cache)) {
            let _ = crate::storage::atomic_write(&path, text.as_bytes(), false);
        }
    }
    advanced
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(version: &str, screen: Value) -> String {
        serde_json::json!({
            "agent": "kimi",
            "version": version,
            "checks": {"抓屏跑完": true},
            "request": {"main": {"bodyKeys": ["messages", "model"]}},
            "screen": screen,
        })
        .to_string()
    }

    #[test]
    fn same_fingerprint_newer_version_advances() {
        let b = base("2.4.1", serde_json::json!({"idle": "abc"}));
        let r = base("2.4.3", serde_json::json!({"idle": "abc"}));
        assert_eq!(advanced_version(&b, &r).as_deref(), Some("2.4.3"));
    }

    #[test]
    fn changed_fingerprint_does_not_advance() {
        let b = base("2.4.1", serde_json::json!({"idle": "abc"}));
        let r = base("2.4.3", serde_json::json!({"idle": "xyz"}));
        assert_eq!(advanced_version(&b, &r), None);
    }

    #[test]
    fn older_or_same_remote_does_not_advance() {
        let b = base("2.4.1", serde_json::json!({}));
        assert_eq!(advanced_version(&b, &base("2.4.1", serde_json::json!({}))), None);
        assert_eq!(advanced_version(&b, &base("2.3.9", serde_json::json!({}))), None);
    }

    #[test]
    fn checks_differences_are_ignored_and_missing_screen_is_not_a_change() {
        let b = base("1.0.0", serde_json::json!({"idle": "abc"}));
        let mut r: Value = serde_json::from_str(&base("1.0.1", Value::Null)).unwrap();
        r["checks"] = serde_json::json!({"别的检查": true});
        assert_eq!(advanced_version(&b, &r.to_string()).as_deref(), Some("1.0.1"));
    }

    #[test]
    fn bundled_baselines_parse_with_version() {
        for (agent, text) in BUNDLED.iter().chain(BUNDLED_EXTRA) {
            let v: Value = serde_json::from_str(text).unwrap_or_else(|e| panic!("{agent}: {e}"));
            assert!(parse_version(v["version"].as_str().unwrap_or("")).is_some(), "{agent}");
        }
    }
}
