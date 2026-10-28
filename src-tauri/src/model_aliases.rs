//! 官方账号的模型别名 → 当前对应的完整型号（2026-10-28 用户：别靠 Mesa 写死的对照表）。
//!
//! Claude Code 认 `opus` / `sonnet` / `haiku` / `fable` 这类别名，启动时由 CLI 自己换成当时最新的型号，
//! 换算表在 CLI 程序里、随版本变。这里直接问本机装的那一版：本机起一个假接口（127.0.0.1，回 400），
//! 用每个别名各起一次 `claude -p`，记下它请求里的 `model`。不连 Anthropic、不用用户账号、不花额度；
//! `CLAUDE_CONFIG_DIR` 指到临时目录，不读也不写用户的 `~/.claude`。结果按 Claude Code 版本号存进
//! `<config>/ccode/official-model-aliases.json`，CLI 升级（版本号变了）才重测一次，后台跑、约十几秒。
//!
//! 用处：连接页官方账号的模型列显示完整型号；能力库查询前把别名换成型号（model_registry::chain_field）。
//! 别名名单本身在 tests/fixtures/claude-model-aliases.json，CLI 金丝雀拿 `claude --help` 核对。
//! Gemini 的 pro / flash 没接：0.66 用 API Key + GOOGLE_GEMINI_BASE_URL 起不到本机假接口（2026-10-28 实测），保持别名原样。

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const CLAUDE_ALIASES_JSON: &str = include_str!("../../tests/fixtures/claude-model-aliases.json");

type AliasTable = BTreeMap<String, BTreeMap<String, String>>;

fn fixture() -> serde_json::Value {
    serde_json::from_str(CLAUDE_ALIASES_JSON).unwrap_or_default()
}

fn str_list(v: &serde_json::Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// Claude Code 官方账号可选的别名（第一个 default = CLI 自己的默认）
pub(crate) fn claude_aliases() -> Vec<String> {
    str_list(&fixture(), "aliases")
}

/// 要实测的别名（default 随账号变，不测）
fn claude_probed_aliases() -> Vec<String> {
    let skip = str_list(&fixture(), "unprobed");
    claude_aliases().into_iter().filter(|a| !skip.contains(a)).collect()
}

fn cache_path() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("ccode").join("official-model-aliases.json"))
}

static CACHE: std::sync::OnceLock<std::sync::RwLock<Option<serde_json::Value>>> = std::sync::OnceLock::new();

fn read_cache() -> serde_json::Value {
    if cfg!(test) {
        return serde_json::Value::Null;
    }
    let lock = CACHE.get_or_init(|| std::sync::RwLock::new(None));
    if let Some(v) = lock.read().ok().and_then(|g| g.clone()) {
        return v;
    }
    let v = cache_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null);
    if let Ok(mut g) = lock.write() {
        *g = Some(v.clone());
    }
    v
}

fn table_from(v: &serde_json::Value) -> AliasTable {
    let mut out = AliasTable::new();
    if let Some(obj) = v.as_object() {
        for (agent, entry) in obj {
            if let Some(map) = entry.get("aliases").and_then(|a| a.as_object()) {
                let m: BTreeMap<String, String> = map
                    .iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect();
                out.insert(agent.clone(), m);
            }
        }
    }
    out
}

/// 各家实测到的别名表：{agent: {alias: 完整型号}}；没测过的家没有键
pub(crate) fn table() -> AliasTable {
    table_from(&read_cache())
}

/// 能力库查询用：是某家实测过的别名就换成完整型号，否则原样
pub(crate) fn resolve(model: &str) -> String {
    let m = model.trim();
    table()
        .values()
        .find_map(|map| map.get(m).cloned())
        .unwrap_or_else(|| model.to_string())
}

#[tauri::command]
pub fn official_model_aliases() -> AliasTable {
    table()
}

static RUNNING: AtomicBool = AtomicBool::new(false);

/// 查官方账号状态时顺带调用：本机 Claude Code 的版本和上次实测的不一样（或从没测过）就后台重测
pub(crate) fn refresh_claude_in_background() {
    if cfg!(test) || RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        let _ = refresh_claude();
        RUNNING.store(false, Ordering::SeqCst);
    });
}

fn refresh_claude() -> Option<()> {
    let bin = crate::agents::resolve_binary("claude")?;
    let version = crate::agents::cli_version("claude-code").map(|(a, b, c)| format!("{a}.{b}.{c}"))?;
    let cache = read_cache();
    if cache.get("claude-code").and_then(|e| e.get("version")).and_then(|v| v.as_str()) == Some(version.as_str()) {
        return Some(());
    }
    let aliases = probe_claude(&bin, &claude_probed_aliases());
    if aliases.is_empty() {
        return None; // 一个都没测出来（CLI 起不来等）：不落盘，下次再试
    }
    let mut root = cache.as_object().cloned().unwrap_or_default();
    root.insert(
        "claude-code".into(),
        serde_json::json!({ "version": version, "aliases": aliases, "probedAt": crate::sessions::now_iso() }),
    );
    let path = cache_path()?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(root.clone())).ok()?;
    crate::profiles::atomic_write(&path, &text).ok()?;
    if let Some(lock) = CACHE.get() {
        if let Ok(mut g) = lock.write() {
            *g = Some(serde_json::Value::Object(root));
        }
    }
    Some(())
}

/// 本机假接口：收到请求就记下 body 里的 model，回 400（CLI 拿到错误就退出，不重试多久）
struct FakeEndpoint {
    port: u16,
    seen: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    stop: std::sync::Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl FakeEndpoint {
    fn start() -> Option<Self> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
        listener.set_nonblocking(true).ok()?;
        let port = listener.local_addr().ok()?.port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let (seen2, stop2) = (seen.clone(), stop.clone());
        let handle = std::thread::spawn(move || {
            while !stop2.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut conn, _)) => {
                        let _ = conn.set_nonblocking(false);
                        let _ = conn.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                        if let Some(model) = read_model(&mut conn) {
                            if let Ok(mut g) = seen2.lock() {
                                g.push(model);
                            }
                        }
                        let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"mesa alias probe"}}"#;
                        let _ = write!(
                            conn,
                            "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                            body.len()
                        );
                    }
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
                }
            }
        });
        Some(Self { port, seen, stop, handle: Some(handle) })
    }

    fn take(&self) -> Vec<String> {
        self.seen.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default()
    }
}

impl Drop for FakeEndpoint {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// 读一个 HTTP 请求，取 JSON body 的 model 字段
fn read_model(conn: &mut impl Read) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        let n = conn.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > 1 << 20 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_lowercase();
    let len: usize = head
        .lines()
        .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
        .unwrap_or(0);
    while buf.len() < header_end + len {
        let n = conn.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body: serde_json::Value = serde_json::from_slice(&buf[header_end..]).ok()?;
    body.get("model")?.as_str().map(String::from)
}

/// 会让 CLI 不走假接口、或改写别名换算的环境变量：一律不带给探测进程
const CLAUDE_ENV_STRIP: &[&str] = &[
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_OAUTH_TOKEN",
];

fn probe_claude(bin: &Path, aliases: &[String]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(ep) = FakeEndpoint::start() else {
        return out;
    };
    let work = std::env::temp_dir().join(format!("ccode-alias-probe-{}", uuid::Uuid::new_v4()));
    let config = work.join("claude-config");
    if std::fs::create_dir_all(&config).is_err() {
        return out;
    }
    for alias in aliases {
        ep.take();
        let mut cmd = crate::process::background_command(bin);
        for k in CLAUDE_ENV_STRIP {
            cmd.env_remove(k);
        }
        cmd.env("CLAUDE_CONFIG_DIR", &config)
            .env("ANTHROPIC_BASE_URL", format!("http://127.0.0.1:{}", ep.port))
            .env("ANTHROPIC_API_KEY", "sk-mesa-alias-probe")
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost")
            .env("DISABLE_AUTOUPDATER", "1")
            .current_dir(&work)
            .args(["-p", "--model", alias.as_str(), "--no-session-persistence", "hi"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let Ok(mut child) = cmd.spawn() else { continue };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(40);
        loop {
            // 收到第一条请求就够了，不等 CLI 自己退出
            if !ep.seen.lock().map(|g| g.is_empty()).unwrap_or(true) {
                break;
            }
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() >= deadline => break,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        if let Some(model) = ep.take().into_iter().find(|m| !m.trim().is_empty()) {
            out.insert(alias.clone(), model);
        }
    }
    let _ = std::fs::remove_dir_all(&work);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_lists_aliases_and_skips_default() {
        assert_eq!(claude_aliases().first().map(String::as_str), Some("default"));
        assert!(claude_aliases().iter().any(|a| a == "opus"));
        assert!(!claude_probed_aliases().iter().any(|a| a == "default"));
    }

    #[test]
    fn table_reads_cache_shape() {
        let v = serde_json::json!({ "claude-code": { "version": "2.1.308", "aliases": { "opus": "claude-opus-5-5" } } });
        let t = table_from(&v);
        assert_eq!(t["claude-code"]["opus"], "claude-opus-5-5");
        assert!(table_from(&serde_json::Value::Null).is_empty());
    }

    #[test]
    fn read_model_parses_http_body() {
        let body = r#"{"model":"claude-opus-5-5","max_tokens":1}"#;
        let req = format!("POST /v1/messages HTTP/1.1\r\nContent-Length: {}\r\n\r\n{body}", body.len());
        assert_eq!(read_model(&mut req.as_bytes()).as_deref(), Some("claude-opus-5-5"));
    }

    /// 本机真跑：cargo test --lib model_aliases_probe_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn model_aliases_probe_real() {
        let bin = crate::agents::resolve_binary("claude").expect("没装 claude");
        let got = probe_claude(&bin, &claude_probed_aliases());
        println!("{got:?}");
        // CLI 金丝雀也跑这条：名单里每个要测的别名都得换得出型号
        for alias in claude_probed_aliases() {
            assert!(got.contains_key(&alias), "{alias} 没换出型号：{got:?}");
        }
    }
}
