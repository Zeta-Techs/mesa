//! 官方账号的模型别名 → 当前对应的完整型号（2026-10-28 用户：别靠 Mesa 写死的对照表）。
//!
//! Claude Code 认 `opus` / `sonnet` / `haiku` / `fable` 这类别名，启动时由 CLI 自己换成当时最新的型号，
//! 换算表在 CLI 程序里、随版本变。这里直接问本机装的那一版：本机起一个假接口（127.0.0.1，回 400），
//! 用每个别名各起一次 `claude -p`，记下它请求里的 `model`。不连 Anthropic、不用用户账号、不花额度；
//! `CLAUDE_CONFIG_DIR` 指到临时目录，不读也不写用户的 `~/.claude`。结果按 Claude Code 版本号存进
//! `<config>/ccode/official-model-aliases.json`，CLI 升级（版本号变了）才重测一次，后台跑、约十几秒。
//!
//! 用处：连接页官方账号的模型列显示完整型号；能力库查询前把别名换成型号（model_registry::chain_field）。
//! 别名名单在 tests/fixtures/{claude,gemini}-model-aliases.json，CLI 金丝雀核对。
//! Gemini（同日补）：`gemini -p hi -m pro` 配 API Key + GOOGLE_GEMINI_BASE_URL 指本机，临时 GEMINI_CLI_HOME 里把认证设成
//! API Key、加 `--skip-trust`（无头模式不信任工作目录就直接退出）；型号在请求路径 `/v1beta/models/<型号>:…` 里。
//! 注意这是 API Key 方式下的换算，用 Google 账号登录时 CLI 可能另选（界面悬停如实说）。

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const CLAUDE_ALIASES_JSON: &str = include_str!("../../tests/fixtures/claude-model-aliases.json");
const GEMINI_ALIASES_JSON: &str = include_str!("../../tests/fixtures/gemini-model-aliases.json");

type AliasTable = BTreeMap<String, BTreeMap<String, String>>;

fn fixture_of(agent: &str) -> serde_json::Value {
    let text = match agent {
        "claude-code" => CLAUDE_ALIASES_JSON,
        "gemini" => GEMINI_ALIASES_JSON,
        _ => "{}",
    };
    serde_json::from_str(text).unwrap_or_default()
}

fn str_list(v: &serde_json::Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// 这家官方账号可选的别名（第一个 = CLI 自己的默认：Claude default、Gemini auto）
pub(crate) fn aliases_of(agent: &str) -> Vec<String> {
    str_list(&fixture_of(agent), "aliases")
}

pub(crate) fn claude_aliases() -> Vec<String> {
    aliases_of("claude-code")
}

/// 要实测的别名（default / auto 随账号或请求变，不测）
fn probed_aliases(agent: &str) -> Vec<String> {
    let skip = str_list(&fixture_of(agent), "unprobed");
    aliases_of(agent).into_iter().filter(|a| !skip.contains(a)).collect()
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

/// 查官方账号状态时顺带调用：本机这家 CLI 的版本和上次实测的不一样（或从没测过）就后台重测。
/// 只接 Claude Code、Gemini；同一时间只跑一个
pub(crate) fn refresh_in_background(agent: &str) {
    if cfg!(test) || !matches!(agent, "claude-code" | "gemini") || RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let agent = agent.to_string();
    std::thread::spawn(move || {
        let _ = refresh(&agent);
        RUNNING.store(false, Ordering::SeqCst);
    });
}

fn probe(agent: &str, bin: &Path, aliases: &[String]) -> BTreeMap<String, String> {
    match agent {
        "claude-code" => probe_claude(bin, aliases),
        "gemini" => probe_gemini(bin, aliases),
        _ => BTreeMap::new(),
    }
}

fn refresh(agent: &str) -> Option<()> {
    let bin = crate::agents::resolve_binary(crate::agent_specs::agent_spec(agent)?.binary)?;
    let version = crate::agents::cli_version(agent).map(|(a, b, c)| format!("{a}.{b}.{c}"))?;
    let cache = read_cache();
    if cache.get(agent).and_then(|e| e.get("version")).and_then(|v| v.as_str()) == Some(version.as_str()) {
        return Some(());
    }
    let aliases = probe(agent, &bin, &probed_aliases(agent));
    if aliases.is_empty() {
        return None; // 一个都没测出来（CLI 起不来等）：不落盘，下次再试
    }
    let mut root = cache.as_object().cloned().unwrap_or_default();
    root.insert(
        agent.into(),
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
    let head_raw = String::from_utf8_lossy(&buf[..header_end]).to_string();
    // Gemini 把型号写在路径里：POST /v1beta/models/gemini-3.1-pro-preview:streamGenerateContent
    let from_path = head_raw
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|path| path.split("/models/").nth(1))
        .map(|rest| rest.split([':', '?', '/']).next().unwrap_or("").to_string())
        .filter(|m| !m.is_empty());
    if from_path.is_some() {
        return from_path;
    }
    let head = head_raw.to_lowercase();
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
        if let Some(model) = run_until_first_request(&ep, &mut cmd) {
            out.insert(alias.clone(), model);
        }
    }
    let _ = std::fs::remove_dir_all(&work);
    out
}

/// 会让 Gemini 不走假接口、或改写型号的环境变量
const GEMINI_ENV_STRIP: &[&str] = &[
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_GENAI_USE_GCA",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GEMINI_MODEL",
];

fn probe_gemini(bin: &Path, aliases: &[String]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(ep) = FakeEndpoint::start() else {
        return out;
    };
    let work = std::env::temp_dir().join(format!("ccode-alias-probe-{}", uuid::Uuid::new_v4()));
    let home = work.join("gemini-home");
    let dot = home.join(".gemini");
    // 认证设成 API Key（不碰用户 ~/.gemini 里的 Google 登录）；projects.json 空表免得它去扫目录
    let ok = std::fs::create_dir_all(&dot).is_ok()
        && std::fs::write(
            dot.join("settings.json"),
            r#"{"security":{"auth":{"selectedType":"gemini-api-key"},"folderTrust":{"enabled":false}}}"#,
        )
        .is_ok()
        && std::fs::write(dot.join("projects.json"), r#"{"projects":{}}"#).is_ok();
    if !ok {
        return out;
    }
    for alias in aliases {
        ep.take();
        let mut cmd = crate::process::background_command(bin);
        for k in GEMINI_ENV_STRIP {
            cmd.env_remove(k);
        }
        cmd.env("GEMINI_CLI_HOME", &home)
            .env("GEMINI_API_KEY", "mesa-alias-probe")
            .env("GOOGLE_GEMINI_BASE_URL", format!("http://127.0.0.1:{}", ep.port))
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost")
            .current_dir(&work)
            .args(["-p", "hi", "-m", alias.as_str(), "--skip-trust"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if let Some(model) = run_until_first_request(&ep, &mut cmd) {
            out.insert(alias.clone(), model);
        }
    }
    let _ = std::fs::remove_dir_all(&work);
    out
}

/// 起子进程、等到假接口收到第一条请求（或进程退出 / 40 秒），收掉进程，返回那条请求的型号
fn run_until_first_request(ep: &FakeEndpoint, cmd: &mut crate::process::BackgroundCommand) -> Option<String> {
    let mut child = cmd.spawn().ok()?;
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
    ep.take().into_iter().find(|m| !m.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_lists_aliases_and_skips_default() {
        assert_eq!(claude_aliases().first().map(String::as_str), Some("default"));
        assert!(claude_aliases().iter().any(|a| a == "opus"));
        assert!(!probed_aliases("claude-code").iter().any(|a| a == "default"));
        assert_eq!(aliases_of("gemini").first().map(String::as_str), Some("auto"));
        assert!(!probed_aliases("gemini").iter().any(|a| a == "auto"));
        assert!(aliases_of("codex").is_empty());
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
        let req = "POST /v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}";
        assert_eq!(read_model(&mut req.as_bytes()).as_deref(), Some("gemini-3.1-pro-preview"));
    }

    fn probe_real(agent: &str, binary: &str) {
        let bin = crate::agents::resolve_binary(binary).unwrap_or_else(|| panic!("没装 {binary}"));
        let got = probe(agent, &bin, &probed_aliases(agent));
        println!("{agent}: {got:?}");
        // CLI 金丝雀也跑这条：名单里每个要测的别名都得换得出型号
        for alias in probed_aliases(agent) {
            assert!(got.contains_key(&alias), "{agent} {alias} 没换出型号：{got:?}");
        }
    }

    /// 本机真跑：cargo test --lib model_aliases_probe_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn model_aliases_probe_real() {
        probe_real("claude-code", "claude");
    }

    #[test]
    #[ignore]
    fn model_aliases_probe_real_gemini() {
        probe_real("gemini", "gemini");
    }
}
