//! Grok 官方登录过期卡住的识别与收口（2026-10-26）。
//!
//! 现象：Grok 本地存着 xAI 官方登录（`~/.grok/auth.json`，OIDC 令牌 6 小时过期）时，即使 Mesa 用 API 连接
//! 拉起（`XAI_API_KEY` + 网关地址），它每发一条消息前也要先去 auth.x.ai 续期（会话令牌优先于 XAI_API_KEY）；
//! 这台电脑连不上 auth.x.ai 就每次卡 30 秒以上、几个 grok 进程还互抢 auth.json.lock，表现为「发消息没反应」。
//! 退出官方登录后改走 `xai.api_key`，立即恢复（本机 1.0.70 实测）。
//!
//! 这里只读 auth.json 的过期时间 / 是否有续期令牌（令牌值不出本模块）与 grok 自己的日志；
//! 唯一的写动作是用户点了之后调用 grok 自己的 `grok logout`（不由 Mesa 删改它的文件）。

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const DEFAULT_ISSUER: &str = "https://auth.x.ai";
/// 日志只看尾部：卡住时 grok 每 30 秒左右写一轮续期失败，512KB 足够覆盖最近几分钟
const LOG_TAIL_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrokLoginCheckDto {
    /// auth.json 里有已过期、等着续期的官方登录
    pub stale_login: bool,
    /// 续期确实卡住了：日志里 since 之后有「连不上」的续期失败，或（未给 since 时）探测连不上登录服务器
    pub blocked: bool,
}

struct StaleLogin {
    issuer: String,
}

/// grok 的家目录：`$GROK_HOME`，缺省 `~/.grok`（matrix §9）
fn grok_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("GROK_HOME")
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| crate::dirs::home_dir().map(|h| h.join(".grok")))
}

fn auth_path(dir: &Path) -> std::path::PathBuf {
    dir.join("auth.json")
}

/// auth.json 里第一条「带续期令牌且已过期」的登录；没有为 None。只读 expires_at / oidc_issuer / 续期令牌是否存在
fn stale_login_in(text: &str, now: chrono::DateTime<chrono::Utc>) -> Option<StaleLogin> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value.as_object()?.values().find_map(|entry| {
        let has_refresh = entry
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty());
        let expires = entry.get("expires_at").and_then(|v| v.as_str())?;
        let expires = chrono::DateTime::parse_from_rfc3339(expires).ok()?;
        if !has_refresh || expires > now {
            return None;
        }
        let issuer = entry
            .get("oidc_issuer")
            .and_then(|v| v.as_str())
            .filter(|s| s.starts_with("https://"))
            .unwrap_or(DEFAULT_ISSUER)
            .trim_end_matches('/')
            .to_string();
        Some(StaleLogin { issuer })
    })
}

/// auth.json 里还有没有任何登录（退出后核对用）：文件不在 = 没有
fn has_login(dir: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(auth_path(dir)) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.as_object().map(|m| !m.is_empty()))
        // 读得到却解析不了：不敢说已退出
        .unwrap_or(true)
}

/// 日志尾部里 since 之后有没有「续期时连不上」的失败（grok 1.0.70 的 `oidc refresh failed` + network_unreachable）
fn refresh_unreachable_since(log_tail: &str, since: chrono::DateTime<chrono::Utc>) -> bool {
    log_tail.lines().any(|line| {
        if !line.contains("oidc refresh failed") {
            return false;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            return false;
        };
        if v.get("msg").and_then(|m| m.as_str()) != Some("oidc refresh failed") {
            return false;
        }
        let unreachable = v
            .pointer("/ctx/network_unreachable")
            .and_then(|b| b.as_bool())
            .unwrap_or(false);
        let after = v
            .get("ts")
            .and_then(|t| t.as_str())
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .is_some_and(|t| t >= since);
        unreachable && after
    })
}

fn read_log_tail(dir: &Path) -> String {
    let path = dir.join("logs").join("unified.jsonl");
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(LOG_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    // 从中间截开的第一行不完整，丢掉
    match (start > 0, text.find('\n')) {
        (true, Some(i)) => text[i + 1..].to_string(),
        _ => text,
    }
}

/// 登录服务器连不连得上：有任何 HTTP 应答都算连得上（只关心网络，不关心内容）。
/// 与 grok 子进程同一份进程环境（API 连接启动不注入出网代理），环境里的代理变量照常生效
async fn issuer_reachable(issuer: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
    else {
        return true;
    };
    client
        .get(format!("{issuer}/.well-known/openid-configuration"))
        .send()
        .await
        .is_ok()
}

/// Grok 官方登录过期是否会卡住发消息。
/// - `since_ms` 给了（运行中的标签：本次启动时刻）：只看 grok 日志里这之后有没有「连不上」的续期失败；
/// - 没给且 `probe`（启动前）：登录过期时探一下登录服务器（最多 4 秒），连不上即卡住。
#[tauri::command]
pub async fn grok_login_check(since_ms: Option<i64>, probe: bool) -> GrokLoginCheckDto {
    let none = GrokLoginCheckDto {
        stale_login: false,
        blocked: false,
    };
    let Some(dir) = grok_dir() else {
        return none;
    };
    let scanned = tauri::async_runtime::spawn_blocking(move || {
        let text = std::fs::read_to_string(auth_path(&dir)).ok()?;
        let stale = stale_login_in(&text, chrono::Utc::now())?;
        let blocked_in_log = since_ms
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|since| refresh_unreachable_since(&read_log_tail(&dir), since));
        Some((stale, blocked_in_log))
    })
    .await
    .ok()
    .flatten();
    let Some((stale, blocked_in_log)) = scanned else {
        return none;
    };
    let blocked = match blocked_in_log {
        Some(blocked) => blocked,
        None if probe => !issuer_reachable(&stale.issuer).await,
        None => false,
    };
    GrokLoginCheckDto {
        stale_login: true,
        blocked,
    }
}

/// 用户点了「退出官方登录」：调用 grok 自己的 `grok logout`，再核对 auth.json 里确实没有登录了。
/// 别的 grok 进程正卡在续期上时它们占着 auth.json.lock，logout 会报成功却没写进去（2026-10-26 实测），
/// 所以以文件为准，没清掉就如实报出来
#[tauri::command]
pub async fn grok_logout() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = grok_dir().ok_or("无法确定 Grok 的配置目录")?;
        let bin = crate::agents::resolve_binary("grok").ok_or("没找到 grok 命令")?;
        let mut cmd = crate::process::background_command(bin);
        cmd.arg("logout");
        let out = crate::process::capture_command(&mut cmd, std::time::Duration::from_secs(30), 64 * 1024)
            .map_err(|e| format!("运行 grok logout 失败：{e}"))?;
        if out.timed_out {
            return Err("grok logout 30 秒没结束，已停止".into());
        }
        if has_login(&dir) {
            return Err(
                "Grok 的官方登录还在：可能还有别的 Grok 标签卡在续期上、占着登录文件。先关掉那些标签再试一次".into(),
            );
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("退出 Grok 官方登录失败：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&chrono::Utc)
    }

    const AUTH: &str = r#"{"https://auth.x.ai::abc":{"key":"secret","auth_mode":"oidc","refresh_token":"rt",
        "expires_at":"2026-10-25T15:24:46.876112+00:00","oidc_issuer":"https://auth.x.ai"}}"#;

    #[test]
    fn stale_login_only_when_expired_with_refresh_token() {
        let stale = stale_login_in(AUTH, utc("2026-10-26T00:00:00Z")).expect("已过期");
        assert_eq!(stale.issuer, "https://auth.x.ai");
        assert!(stale_login_in(AUTH, utc("2026-10-25T10:00:00Z")).is_none(), "还没过期");
        let no_rt = AUTH.replace(r#""refresh_token":"rt","#, "");
        assert!(stale_login_in(&no_rt, utc("2026-10-26T00:00:00Z")).is_none(), "没有续期令牌就不会去续期");
        assert!(stale_login_in("not json", utc("2026-10-26T00:00:00Z")).is_none());
        assert!(stale_login_in("{}", utc("2026-10-26T00:00:00Z")).is_none());
    }

    #[test]
    fn non_https_issuer_falls_back_to_default() {
        let odd = AUTH.replace(r#""oidc_issuer":"https://auth.x.ai""#, r#""oidc_issuer":"http://evil""#);
        assert_eq!(stale_login_in(&odd, utc("2026-10-26T00:00:00Z")).unwrap().issuer, DEFAULT_ISSUER);
    }

    #[test]
    fn refresh_failure_counts_only_after_since_and_when_unreachable() {
        // grok 1.0.70 日志原样（去掉无关字段）
        let log = concat!(
            r#"{"ts":"2026-10-26T11:28:23.762Z","lvl":"error","msg":"oidc refresh failed","ctx":{"has_refresh_token":true,"network_unreachable":true}}"#,
            "\n",
            r#"{"ts":"2026-10-26T11:29:00.000Z","lvl":"error","msg":"oidc refresh failed","ctx":{"network_unreachable":false}}"#,
            "\n",
        );
        assert!(refresh_unreachable_since(log, utc("2026-10-26T11:28:00Z")));
        assert!(!refresh_unreachable_since(log, utc("2026-10-26T11:28:30Z")), "之后只有一条非网络原因的失败");
        assert!(!refresh_unreachable_since("garbage\n", utc("2026-10-26T11:28:00Z")));
    }

    #[test]
    fn has_login_reads_auth_file() {
        let dir = std::env::temp_dir().join(format!("mesa-grok-login-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!has_login(&dir), "文件不在 = 已退出");
        std::fs::write(auth_path(&dir), "{}").unwrap();
        assert!(!has_login(&dir));
        std::fs::write(auth_path(&dir), AUTH).unwrap();
        assert!(has_login(&dir));
        std::fs::write(auth_path(&dir), "broken").unwrap();
        assert!(has_login(&dir), "解析不了不敢说已退出");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
