//! 官方账号令牌过期时，代为调一次官方 CLI 让它自己续期（2026-11-26 用户拍板）。
//!
//! Mesa 仍然**不碰令牌**：不自己换新令牌、不写 CLI 的登录存储；只拉起官方 CLI 的零消耗命令，
//! 由 CLI 走自己的续期流程并自己写回，等同用户手动用一次。实测（本机 2026-11-26）：
//! - Claude Code 2.1.326：`claude -p /usage` 是本地命令（`local_command: "usage"`、0 轮、0 token），
//!   令牌过期时会先续期；`claude auth status` 不续期。
//! - Codex 0.172.0：`codex app-server`（stdio JSON-RPC）的 `account/read { refreshToken: true }`
//!   「返回前主动续期」，不建会话、0 token。
//! - Grok / Kimi 本机无官方登录，没找到并实测零消耗续期命令前不接入。
//!
//! 硬条件：设置里没配出网代理就不调（避免从国内出口直连官方触发风控），照旧提示用户自己去用一次 CLI。
//! 调用时清掉网关 / API Key 变量（否则 CLI 走 Key 模式、不碰官方登录），Claude 另外不加载任何设置源
//! （用户级 settings.json 的 env 也可能写着网关地址）并关掉 hooks；同一行 10 分钟内只试一次。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

const RENEW_TIMEOUT: Duration = Duration::from_secs(30);
const RENEW_COOLDOWN_MS: i64 = 10 * 60 * 1000;

/// 拉起 Claude Code 时要清掉的变量：任一存在都会让它绕开官方登录
const CLAUDE_STRIP_ENV: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
];
const CODEX_STRIP_ENV: &[&str] = &["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"];

static LAST_TRY: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RenewOutcome {
    /// CLI 跑完了（是否真续上由调用方重读凭证判定）
    Ran,
    /// 设置里没配出网代理：不调
    NoProxy,
    /// 同一行 10 分钟内已试过
    CoolingDown,
    /// 找不到 CLI、超时或返回异常
    Failed,
}

/// 节流：`last` 里记的是上次尝试时刻；冷却期内返回 false，否则记下本次并返回 true
fn claim_in(last: &mut HashMap<String, i64>, key: &str, now: i64) -> bool {
    if last.get(key).is_some_and(|t| now - *t < RENEW_COOLDOWN_MS) {
        return false;
    }
    last.insert(key.to_string(), now);
    true
}

fn claim(key: &str) -> bool {
    let now = crate::subscription_quota::now_ms();
    let mut last = LAST_TRY.lock().unwrap_or_else(|e| e.into_inner());
    claim_in(&mut last, key, now)
}

fn claude_renew_args() -> Vec<&'static str> {
    vec![
        "-p",
        "/usage",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--tools",
        "",
        "--setting-sources",
        "",
        "--settings",
        r#"{"disableAllHooks":true}"#,
        "--strict-mcp-config",
    ]
}

/// `claude -p /usage --output-format json` 的结果是否为本地命令成功（非模型回合）
fn claude_usage_ran_locally(stdout: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) else {
        return false;
    };
    v.get("local_command").and_then(|x| x.as_str()) == Some("usage")
        && v.get("is_error").and_then(|x| x.as_bool()) == Some(false)
}

/// Codex app-server 的三条 JSON-RPC 行：initialize → initialized → account/read（要求先续期）
fn codex_renew_frames() -> String {
    let frames = [
        serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"clientInfo": {"name": "mesa", "title": null, "version": env!("CARGO_PKG_VERSION")}}}),
        serde_json::json!({"jsonrpc": "2.0", "method": "initialized"}),
        serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": "account/read", "params": {"refreshToken": true}}),
    ];
    frames.iter().map(|f| format!("{f}\n")).collect()
}

/// app-server 的一行输出若是 account/read 的应答，返回它是否成功
fn codex_account_reply(line: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    (v.get("id").and_then(|x| x.as_i64()) == Some(2)).then(|| v.get("result").is_some() && v.get("error").is_none())
}

/// 出网代理 + 清掉绕开官方登录的变量；固定在家目录运行（CLI 会按运行目录建项目目录，固定一处不乱留）
fn prepare(cmd: &mut crate::process::BackgroundCommand, outbound: &[(String, String)], strip: &[&str]) {
    for k in strip {
        cmd.env_remove(k);
    }
    for (k, v) in outbound {
        cmd.env(k, v);
    }
    if let Some(home) = crate::dirs::home_dir() {
        cmd.current_dir(home);
    }
}

fn wait_child(child: &mut std::process::Child) -> Option<std::process::ExitStatus> {
    let deadline = std::time::Instant::now() + RENEW_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return Some(st),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
}

/// 阻塞：代为让 Claude Code 续期 `config_dir`（None = 默认目录）的官方登录
pub(crate) fn renew_claude(row_id: &str, config_dir: Option<&Path>) -> RenewOutcome {
    let outbound = crate::settings::official_outbound_env();
    if outbound.is_empty() {
        return RenewOutcome::NoProxy;
    }
    if !claim(row_id) {
        return RenewOutcome::CoolingDown;
    }
    let Some(bin) = crate::agents::resolve_binary("claude") else {
        return RenewOutcome::Failed;
    };
    let mut cmd = crate::process::background_command(&bin);
    prepare(&mut cmd, &outbound, CLAUDE_STRIP_ENV);
    if let Some(dir) = config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    cmd.args(claude_renew_args())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let Ok(mut child) = cmd.spawn() else {
        return RenewOutcome::Failed;
    };
    let stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut out) = stdout {
            let _ = std::io::Read::read_to_end(&mut out, &mut buf);
        }
        buf
    });
    if wait_child(&mut child).is_none() {
        return RenewOutcome::Failed;
    }
    let out = crate::process::join_with_timeout(reader, Duration::from_secs(2));
    if claude_usage_ran_locally(&String::from_utf8_lossy(&out)) {
        RenewOutcome::Ran
    } else {
        RenewOutcome::Failed
    }
}

/// 阻塞：代为让 Codex 续期 `codex_home`（None = 默认目录）的 ChatGPT 登录
pub(crate) fn renew_codex(row_id: &str, codex_home: Option<&Path>) -> RenewOutcome {
    let outbound = crate::settings::official_outbound_env();
    if outbound.is_empty() {
        return RenewOutcome::NoProxy;
    }
    if !claim(row_id) {
        return RenewOutcome::CoolingDown;
    }
    let Some(bin) = crate::agents::resolve_binary("codex") else {
        return RenewOutcome::Failed;
    };
    let mut cmd = crate::process::background_command(&bin);
    prepare(&mut cmd, &outbound, CODEX_STRIP_ENV);
    if let Some(dir) = codex_home {
        cmd.env("CODEX_HOME", dir);
    }
    cmd.arg("app-server")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let Ok(mut child) = cmd.spawn() else {
        return RenewOutcome::Failed;
    };
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines() {
                let Ok(line) = line else { break };
                if let Some(ok) = codex_account_reply(&line) {
                    let _ = tx.send(ok);
                    break;
                }
            }
        });
    }
    let wrote = child
        .stdin
        .as_mut()
        .is_some_and(|stdin| stdin.write_all(codex_renew_frames().as_bytes()).and_then(|_| stdin.flush()).is_ok());
    let ok = wrote && rx.recv_timeout(RENEW_TIMEOUT).unwrap_or(false);
    drop(child.stdin.take());
    let _ = child.kill();
    let _ = child.wait();
    if ok {
        RenewOutcome::Ran
    } else {
        RenewOutcome::Failed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_throttles_per_row_for_ten_minutes() {
        let mut last = HashMap::new();
        assert!(claim_in(&mut last, "a", 1_000));
        assert!(!claim_in(&mut last, "a", 1_000 + RENEW_COOLDOWN_MS - 1));
        assert!(claim_in(&mut last, "b", 1_000));
        assert!(claim_in(&mut last, "a", 1_000 + RENEW_COOLDOWN_MS));
    }

    #[test]
    fn claude_args_stay_local_and_isolated() {
        let args = claude_renew_args();
        assert_eq!(&args[..2], &["-p", "/usage"]);
        for flag in ["--no-session-persistence", "--setting-sources", "--strict-mcp-config"] {
            assert!(args.contains(&flag), "缺 {flag}");
        }
        let settings = args[args.iter().position(|a| *a == "--settings").unwrap() + 1];
        assert_eq!(serde_json::from_str::<serde_json::Value>(settings).unwrap()["disableAllHooks"], true);
    }

    #[test]
    fn claude_usage_must_be_local_command() {
        assert!(claude_usage_ran_locally(r#"{"is_error":false,"num_turns":0,"local_command":"usage","result":"..."}"#));
        // 落到模型回合（没有 local_command）不算：那会耗额度
        assert!(!claude_usage_ran_locally(r#"{"is_error":false,"num_turns":1,"result":"hi"}"#));
        assert!(!claude_usage_ran_locally(r#"{"is_error":true,"local_command":"usage"}"#));
        assert!(!claude_usage_ran_locally("not json"));
    }

    #[test]
    fn codex_frames_request_refresh() {
        let lines: Vec<serde_json::Value> =
            codex_renew_frames().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["method"], "initialize");
        assert_eq!(lines[1]["method"], "initialized");
        assert_eq!(lines[2]["method"], "account/read");
        assert_eq!(lines[2]["params"]["refreshToken"], true);
    }

    #[test]
    fn codex_reply_matches_account_read_only() {
        assert_eq!(codex_account_reply(r#"{"id":1,"result":{}}"#), None);
        assert_eq!(codex_account_reply(r#"{"method":"account/updated","params":{}}"#), None);
        assert_eq!(codex_account_reply(r#"{"id":2,"result":{"account":{"type":"chatgpt"}}}"#), Some(true));
        assert_eq!(codex_account_reply(r#"{"id":2,"error":{"code":-1,"message":"x"}}"#), Some(false));
    }

    #[test]
    fn strip_lists_cover_gateway_keys() {
        assert!(CLAUDE_STRIP_ENV.contains(&"ANTHROPIC_BASE_URL"));
        assert!(CLAUDE_STRIP_ENV.contains(&"ANTHROPIC_API_KEY"));
        assert!(CODEX_STRIP_ENV.contains(&"OPENAI_API_KEY"));
    }
}
