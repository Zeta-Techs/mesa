//! 原生模式的 ACP 客户端（docs/design-chat-native-mode.md 第 2 期，首家 Kimi Code）。
//!
//! 终端模式下 Kimi 的 TUI 跑在 PTY 里、聊天层旁听；原生模式下没有 TUI：PTY 里起的是 `mesa_helper stdio-bridge -- kimi acp`
//! （stdio_bridge.rs），桥连回这里开的一次性本机监听口，这一侧就是 ACP 客户端，聊天层是这段会话的主人——
//! 发话是 `session/prompt`、停是 `session/cancel`、审批是 `session/request_permission` 的一问一答（带选项编号），不读屏、不按键。
//! 事件归一成旁路同一套 ChannelEvent，前端照旧收 `chat-channel-<标签>` 快照；对话正文照旧读 Kimi 自己写的会话文件。
//!
//! 2026-11-26 Kimi 2.7.3 / 2.8.0 实测（scripts/native-probe/acp_probe.py）：模型取 Mesa 注入的 KIMI_MODEL_*；模式名与终端旗标错位——
//! 终端 `--yolo`（Ask When Needed，Mesa「帮我批准」）= ACP `auto`，终端 `--auto`（Never Ask，Mesa「完全访问」）= ACP `yolo`；
//! plan 模式下跑命令仍发审批请求，「只讨论」档由这里直接拒；`session/load` 先把历史逐条回放成 session/update，回放期间不当实时事件。

use super::{feed, now_ms, ChannelEvent, Channel, Prepared, Replier};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// 走 ACP 原生模式的家与实测过的起点版本
const ACP_MIN: &[(&str, (u32, u32, u32))] = &[("kimi", (2, 7, 0))];
/// 桥连回来的时限（PTY 起进程 + 桥启动，本机约 0.2 秒）
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(20);
/// initialize / session/new|load / set_mode 等回包的时限（load 要回放整段历史，给长一点）
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) struct AcpPrep {
    pub(super) listener: TcpListener,
    pub(super) token: String,
    pub(super) cwd: String,
    /// 接回的会话 id（Claude 原生模式另用它记启动参数里定下的会话 id）
    pub(super) resume: Option<String>,
    /// 开会话后切到的 ACP 模式（按 Mesa 的权限档换算；None = 默认）
    mode: Option<&'static str>,
    /// 「只讨论」档：计划模式里要执行 / 改文件的审批直接拒
    discuss: bool,
    /// Mesa 这次选的模型（启动参数里的 -m）：开会话后核对，对不上就改过来或说一声
    expect_model: Option<String>,
}

#[derive(Default)]
pub(crate) struct AcpState {
    session: Option<String>,
    agent: String,
    next_id: i64,
    waiters: HashMap<i64, mpsc::Sender<Value>>,
    /// 我们发出的 session/prompt：它的回包 = 这一轮结束
    prompt: Option<i64>,
    /// 未答的审批：请求 id 键 → (原 id, [(optionId, kind)])
    pending: HashMap<String, (Value, Vec<(String, String)>)>,
    /// session/load 期间回放历史：这些 session/update 不当实时事件
    loading: bool,
    discuss: bool,
    /// 会话文件找到了没有（新会话第一轮之后才落盘）
    transcript: Option<String>,
}

impl AcpPrep {
    /// 只用到监听口与令牌的桥（Claude 原生模式）：`resume` 记启动参数里定下的会话 id
    pub(super) fn bridge_only(listener: TcpListener, token: String, cwd: &str, resume: Option<String>) -> Self {
        Self { listener, token, cwd: cwd.to_string(), resume, mode: None, discuss: false, expect_model: None }
    }
}

impl AcpState {
    fn request(&mut self, method: &str, params: Value) -> (i64, Value) {
        self.next_id += 1;
        let id = self.next_id;
        (id, json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
    }
}

/// 这家这个版本能走 ACP 原生模式
pub(crate) fn supported(agent: &str) -> bool {
    ACP_MIN.iter().any(|(a, min)| *a == agent && super::version_at_least(agent, *min))
}

/// Mesa 的权限档（启动参数里的终端旗标）→ ACP 模式；只讨论档另记 discuss
pub(crate) fn mode_from_args(agent: &str, args: &[String]) -> (Option<&'static str>, bool) {
    if agent != "kimi" {
        return (None, false);
    }
    let has = |f: &str| args.iter().any(|a| a == f);
    if has("--plan") {
        (Some("plan"), true)
    } else if has("--auto") {
        (Some("yolo"), false)
    } else if has("--yolo") {
        (Some("auto"), false)
    } else {
        (None, false)
    }
}

/// pty_spawn 在起进程前调用（原生模式且这家支持时）：返回 PTY 要起的程序（随包的 mesa_helper）、参数、要加的环境变量与旁路句柄。
/// 任一步不成就返回 None，调用方照旧按终端模式起
pub(crate) fn prepare(
    agent: &str,
    tab_id: Option<&str>,
    cwd: &str,
    binary: &Path,
    args: &[String],
    resume: Option<&str>,
) -> Option<(PathBuf, Vec<String>, Vec<(String, String)>, Prepared)> {
    if !supported(agent) {
        return None;
    }
    let tab = tab_id.map(super::sanitize_tab).filter(|t| !t.is_empty())?;
    let helper = crate::image_gen::find_bundled_helper("stdio-bridge")?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
    let addr = listener.local_addr().ok()?;
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let (mode, discuss) = mode_from_args(agent, args);
    let expect_model = args
        .iter()
        .position(|a| a == "-m" || a == "--model")
        .and_then(|i| args.get(i + 1))
        .filter(|m| !m.trim().is_empty())
        .cloned();
    let bridge_args = vec![
        "stdio-bridge".to_string(),
        "--".to_string(),
        binary.to_string_lossy().into_owned(),
        "acp".to_string(),
    ];
    let env = vec![
        ("CCODE_TAB_ID".to_string(), tab.clone()),
        (crate::stdio_bridge::ADDR_ENV.to_string(), addr.to_string()),
        (crate::stdio_bridge::TOKEN_ENV.to_string(), token.clone()),
    ];
    let prepared = Prepared {
        agent: agent.to_string(),
        tab_id: tab,
        kind: "acp",
        dir: None,
        hooks_log: None,
        qwen_events: None,
        replier: None,
        codex: None,
        sidecar: None,
        acp: Some(AcpPrep {
            listener,
            token,
            cwd: cwd.to_string(),
            resume: resume.map(String::from),
            mode,
            discuss,
            expect_model,
        }),
    };
    Some((helper, bridge_args, env, prepared))
}

pub(super) fn write_line(stream: &Mutex<TcpStream>, msg: &Value) -> Result<(), String> {
    let mut s = stream.lock().map_err(|_| "实时通道已关闭")?;
    let mut line = msg.to_string();
    line.push('\n');
    s.write_all(line.as_bytes()).map_err(|e| format!("发不出去：{e}"))
}

pub(super) fn writer_of(ch: &Channel) -> Result<Arc<Mutex<TcpStream>>, String> {
    match ch.replier.lock().map_err(|_| "实时通道已关闭")?.as_ref() {
        Some(Replier::Acp { stream }) => Ok(stream.clone()),
        _ => Err("实时通道已断开".into()),
    }
}

/// 发请求等回包；返回整条回包
fn call(ch: &Channel, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let writer = writer_of(ch)?;
    let (tx, rx) = mpsc::channel();
    let (id, msg) = {
        let mut st = ch.acp.lock().map_err(|_| "实时通道已关闭")?;
        let (id, msg) = st.request(method, params);
        st.waiters.insert(id, tx);
        (id, msg)
    };
    let got = write_line(&writer, &msg).and_then(|_| rx.recv_timeout(timeout).map_err(|_| format!("{method} 没有回应")));
    if let Ok(mut st) = ch.acp.lock() {
        st.waiters.remove(&id);
    }
    got
}

fn error_text(reply: &Value) -> Option<String> {
    reply.get("error").map(|e| {
        let text = e.get("message").and_then(Value::as_str).unwrap_or("请求被拒绝");
        crate::sessions::redact_sensitive_text(text)
    })
}

/// 旁路线程：等桥连回来、核对令牌，开会话，然后一直读
pub(crate) fn run(ch: Arc<Channel>, prep: AcpPrep) {
    let AcpPrep { listener, token, cwd, resume, mode, discuss, expect_model } = prep;
    let Some(stream) = accept(&ch, &listener, &token) else {
        super::disconnect(&ch);
        return;
    };
    drop(listener);
    let Ok(read_half) = stream.try_clone() else {
        super::disconnect(&ch);
        return;
    };
    let writer = Arc::new(Mutex::new(stream));
    if let Ok(mut r) = ch.replier.lock() {
        *r = Some(Replier::Acp { stream: writer.clone() });
    }
    if let Ok(mut st) = ch.acp.lock() {
        st.discuss = discuss;
        st.agent = ch.tracker.lock().map(|t| t.snap.agent.clone()).unwrap_or_default();
    }
    let reader = {
        let ch = ch.clone();
        let writer = writer.clone();
        std::thread::spawn(move || read_loop(&ch, &writer, read_half))
    };
    match open_session(&ch, &cwd, resume.as_deref(), mode, expect_model.as_deref()) {
        Ok(()) => {}
        Err(message) => {
            feed(&ch, vec![ChannelEvent::Notice(message)]);
            // 会话没开成：关连接让桥和 CLI 退出，标签照旧显示退出
            if let Ok(s) = writer.lock() {
                let _ = s.shutdown(std::net::Shutdown::Both);
            }
        }
    }
    let _ = reader.join();
    super::disconnect(&ch);
}

pub(super) fn accept(ch: &Channel, listener: &TcpListener, token: &str) -> Option<TcpStream> {
    listener.set_nonblocking(true).ok()?;
    let deadline = Instant::now() + ACCEPT_TIMEOUT;
    while Instant::now() < deadline && !ch.stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, peer)) if peer.ip().is_loopback() => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut first = String::new();
                let ok = BufReader::new(stream.try_clone().ok()?).read_line(&mut first).is_ok()
                    && constant_eq(first.trim_end_matches(['\r', '\n']), token);
                let _ = stream.set_read_timeout(None);
                if ok {
                    let _ = stream.set_nodelay(true);
                    return Some(stream);
                }
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(30)),
            Err(_) => return None,
        }
    }
    None
}

fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn open_session(
    ch: &Channel,
    cwd: &str,
    resume: Option<&str>,
    mode: Option<&'static str>,
    expect_model: Option<&str>,
) -> Result<(), String> {
    let init = call(
        ch,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
            "clientInfo": { "name": "mesa", "title": "Mesa", "version": env!("CARGO_PKG_VERSION") }
        }),
        CALL_TIMEOUT,
    )?;
    if let Some(e) = error_text(&init) {
        return Err(format!("没连上原生模式：{e}"));
    }
    let can_load = init.pointer("/result/agentCapabilities/loadSession").and_then(Value::as_bool) == Some(true);
    let opened: Value;
    let sid = match resume {
        Some(id) if can_load => {
            if let Ok(mut st) = ch.acp.lock() {
                st.loading = true;
            }
            let r = call(ch, "session/load", json!({ "sessionId": id, "cwd": cwd, "mcpServers": [] }), CALL_TIMEOUT);
            if let Ok(mut st) = ch.acp.lock() {
                st.loading = false;
            }
            let r = r?;
            if let Some(e) = error_text(&r) {
                return Err(format!("没接回这段对话：{e}"));
            }
            opened = r;
            id.to_string()
        }
        Some(_) => return Err("这一版不支持在原生模式下接回旧对话，请关掉原生模式再接".into()),
        None => {
            let r = call(ch, "session/new", json!({ "cwd": cwd, "mcpServers": [] }), CALL_TIMEOUT)?;
            if let Some(e) = error_text(&r) {
                let auth = r.pointer("/error/code").and_then(Value::as_i64) == Some(-32000)
                    || e.to_lowercase().contains("auth");
                return Err(if auth {
                    "还没登录：关掉原生模式，在终端里登录后再打开".into()
                } else {
                    format!("没开成会话：{e}")
                });
            }
            let id = r.pointer("/result/sessionId").and_then(Value::as_str).ok_or("没开成会话：没有会话 id")?.to_string();
            opened = r;
            id
        }
    };
    if let Ok(mut st) = ch.acp.lock() {
        st.session = Some(sid.clone());
    }
    let agent = ch.acp.lock().map(|s| s.agent.clone()).unwrap_or_default();
    let path = find_transcript(&agent, &sid);
    if let Ok(mut st) = ch.acp.lock() {
        st.transcript = path.clone();
    }
    feed(
        ch,
        vec![
            ChannelEvent::Connected,
            ChannelEvent::Session { id: sid.clone(), path, source: resume.map(|_| "resume".to_string()) },
        ],
    );
    if let Some(mode) = mode {
        let r = call(ch, "session/set_mode", json!({ "sessionId": sid, "modeId": mode }), CALL_TIMEOUT)?;
        if let Some(e) = error_text(&r) {
            feed(ch, vec![ChannelEvent::Notice(format!("没切到对应的权限档：{e}"))]);
        }
    }
    // 切换模式后核对模型（设计稿公共件 3）：会话报的当前模型不是 Mesa 选的，能改就改过来，改不了就说一声
    match model_check(&opened, expect_model) {
        ModelCheck::Fine => {}
        ModelCheck::Switch(want) => {
            let r = call(ch, "session/set_config_option", json!({ "sessionId": sid, "configId": "model", "value": want }), CALL_TIMEOUT)?;
            if let Some(e) = error_text(&r) {
                feed(ch, vec![ChannelEvent::Notice(format!("没能换成 Mesa 选的模型 {want}：{e}"))]);
            }
        }
        ModelCheck::Missing { want, current } => {
            feed(ch, vec![ChannelEvent::Notice(format!("这次可用的模型里没有 Mesa 选的 {want}，正在用 {current}"))]);
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub(crate) enum ModelCheck {
    Fine,
    Switch(String),
    Missing { want: String, current: String },
}

/// session/new|load 的回包里 configOptions 的 model 一项 vs Mesa 选的模型（纯函数）
pub(crate) fn model_check(opened: &Value, want: Option<&str>) -> ModelCheck {
    let Some(want) = want else { return ModelCheck::Fine };
    let Some(opt) = opened
        .pointer("/result/configOptions")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find(|o| o.get("id").and_then(Value::as_str) == Some("model")))
    else {
        return ModelCheck::Fine;
    };
    let current = opt.get("currentValue").and_then(Value::as_str).unwrap_or("");
    if current == want {
        return ModelCheck::Fine;
    }
    let offered = opt
        .get("options")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().any(|o| o.get("value").and_then(Value::as_str) == Some(want)));
    if offered {
        ModelCheck::Switch(want.to_string())
    } else {
        ModelCheck::Missing { want: want.to_string(), current: current.to_string() }
    }
}

/// Kimi 的会话本体：`<根>/sessions/<目录哈希>/<会话 id>/agents/main/wire.jsonl`（新会话第一轮之后才落盘）
fn find_transcript(agent: &str, sid: &str) -> Option<String> {
    if agent != "kimi" || sid.is_empty() || sid.contains(['/', '\\']) {
        return None;
    }
    let roots = crate::sessions::SessionRoots::current()?;
    let sessions = roots.kimi_code.join("sessions");
    for e in std::fs::read_dir(&sessions).ok()?.flatten() {
        let p = e.path().join(sid).join("agents").join("main").join("wire.jsonl");
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}

fn read_loop(ch: &Arc<Channel>, writer: &Arc<Mutex<TcpStream>>, stream: TcpStream) {
    for line in BufReader::new(stream).lines() {
        if ch.stop.load(Ordering::Acquire) {
            break;
        }
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
        if std::env::var("MESA_CHANNEL_DEBUG").is_ok() {
            eprintln!("acp← {}", msg.to_string().chars().take(300).collect::<String>());
        }
        handle(ch, writer, &msg);
    }
}

fn rpc_key(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn handle(ch: &Arc<Channel>, writer: &Mutex<TcpStream>, msg: &Value) {
    let method = msg.get("method").and_then(Value::as_str);
    let id = msg.get("id");
    match (method, id) {
        // 对我们请求的回包
        (None, Some(id)) => {
            let n = id.as_i64();
            let (waiter, was_prompt) = {
                let Ok(mut st) = ch.acp.lock() else { return };
                let waiter = n.and_then(|n| st.waiters.remove(&n));
                let was_prompt = n.is_some() && st.prompt == n;
                if was_prompt {
                    st.prompt = None;
                }
                (waiter, was_prompt)
            };
            if let Some(tx) = waiter {
                let _ = tx.send(msg.clone());
            }
            if was_prompt {
                let mut events = prompt_end_events(msg);
                if let Some(ev) = refresh_transcript(ch) {
                    events.push(ev);
                }
                feed(ch, events);
            }
        }
        // 对方的请求：只认审批，别的一律回「不支持」（初始化时也没声明文件 / 终端能力）
        (Some(m), Some(id)) => {
            if m != "session/request_permission" {
                let _ = write_line(
                    writer,
                    &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Mesa 不支持这个请求" } }),
                );
                return;
            }
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let options = permission_options(&params);
            let discuss = ch.acp.lock().map(|s| s.discuss).unwrap_or(false);
            if discuss && is_mutating(&params) {
                // 只讨论档：要执行 / 改文件的一律拒，不交给人点（这类对话本来就不动手）
                if let Some(opt) = pick_option(&options, "deny") {
                    let _ = write_line(writer, &selected(id, &opt));
                }
                feed(ch, vec![ChannelEvent::Notice("只讨论模式下，已拒绝一次要执行或改文件的请求".into())]);
                return;
            }
            let key = rpc_key(id);
            let has_always = options.iter().any(|(_, k)| k == "allow_always");
            if let Ok(mut st) = ch.acp.lock() {
                st.pending.insert(key.clone(), (id.clone(), options));
            }
            if has_always {
                if let Ok(mut t) = ch.tracker.lock() {
                    t.always_labels.insert(key.clone(), "本会话都允许".into());
                }
            }
            feed(ch, vec![approval_event(&key, &params)]);
        }
        (Some("session/update"), None) => {
            if ch.acp.lock().map(|s| s.loading).unwrap_or(false) {
                return;
            }
            if let Some(update) = msg.pointer("/params/update") {
                feed(ch, map_update(update));
            }
        }
        _ => {}
    }
}

/// session/prompt 的回包 → 这一轮怎么结束
pub(crate) fn prompt_end_events(msg: &Value) -> Vec<ChannelEvent> {
    if let Some(e) = error_text(msg) {
        return vec![ChannelEvent::TurnEnd { reason: Some("failed".into()) }, ChannelEvent::ErrorDetail(e)];
    }
    let stop = msg.pointer("/result/stopReason").and_then(Value::as_str).unwrap_or("end_turn");
    vec![ChannelEvent::TurnEnd { reason: Some(stop.to_string()) }]
}

/// 新会话第一轮之后会话文件才落盘：找到了就补报一次，前端据此锁定文件读正文
fn refresh_transcript(ch: &Channel) -> Option<ChannelEvent> {
    let (agent, sid, known) = {
        let st = ch.acp.lock().ok()?;
        (st.agent.clone(), st.session.clone()?, st.transcript.is_some())
    };
    if known {
        return None;
    }
    let path = find_transcript(&agent, &sid)?;
    if let Ok(mut st) = ch.acp.lock() {
        st.transcript = Some(path.clone());
    }
    Some(ChannelEvent::Session { id: sid, path: Some(path), source: None })
}

fn content_text(v: &Value) -> Option<String> {
    // ContentBlock（{type:text,text}）或 ToolCallContent（{type:content, content:{type:text,text}}）的数组 / 单个
    let one = |x: &Value| -> Option<String> {
        x.get("text")
            .and_then(Value::as_str)
            .or_else(|| x.pointer("/content/text").and_then(Value::as_str))
            .map(String::from)
    };
    match v {
        Value::Array(a) => {
            let parts: Vec<String> = a.iter().filter_map(one).collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        other => one(other),
    }
}

/// 工具参数：有 rawInput 用它；Kimi 不给 rawInput、把参数 JSON 写在 content 文字里，能解析就用
fn tool_input(call: &Value) -> Value {
    if let Some(raw) = call.get("rawInput").filter(|v| !v.is_null()) {
        return raw.clone();
    }
    content_text(call.get("content").unwrap_or(&Value::Null))
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
        .unwrap_or(Value::Null)
}

/// ACP 的 kind（execute / edit / read …）与标题 → 旁路的工具名（approval_from_tool 按名字认命令 / 改文件）
fn tool_name(call: &Value) -> String {
    let title = call.get("title").and_then(Value::as_str).unwrap_or("");
    match call.get("kind").and_then(Value::as_str) {
        Some("execute") if title.is_empty() || title.contains(' ') => "Bash".into(),
        Some("edit") if title.is_empty() => "Edit".into(),
        _ if !title.is_empty() => title.to_string(),
        Some(k) => k.to_string(),
        None => "tool".into(),
    }
}

/// session/update → 旁路事件（纯函数）
pub(crate) fn map_update(update: &Value) -> Vec<ChannelEvent> {
    let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
    match kind {
        "agent_message_chunk" => content_text(update.get("content").unwrap_or(&Value::Null))
            .map(|t| vec![ChannelEvent::TextDelta(t)])
            .unwrap_or_default(),
        "agent_thought_chunk" => content_text(update.get("content").unwrap_or(&Value::Null))
            .map(|t| vec![ChannelEvent::ThinkingDelta(t)])
            .unwrap_or_default(),
        "tool_call" => vec![ChannelEvent::ToolStart {
            call_id: update.get("toolCallId").and_then(Value::as_str).map(String::from),
            name: tool_name(update),
            input: tool_input(update),
        }],
        "tool_call_update" => match update.get("status").and_then(Value::as_str) {
            Some("completed" | "failed") => vec![ChannelEvent::ToolEnd {
                call_id: update.get("toolCallId").and_then(Value::as_str).map(String::from),
            }],
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn permission_options(params: &Value) -> Vec<(String, String)> {
    params
        .get("options")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|o| {
                    Some((o.get("optionId")?.as_str()?.to_string(), o.get("kind")?.as_str()?.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn is_mutating(params: &Value) -> bool {
    let call = params.get("toolCall").unwrap_or(&Value::Null);
    match call.get("kind").and_then(Value::as_str) {
        Some("execute" | "edit" | "delete" | "move") => true,
        Some(_) => false,
        // Kimi 的审批请求里不带 kind：按标题认
        None => matches!(call.get("title").and_then(Value::as_str), Some("Bash" | "Shell" | "Write" | "Edit" | "StrReplaceFile" | "WriteFile")),
    }
}

/// 用户点的（allow | allow_always | deny）→ 这家给的选项编号
pub(crate) fn pick_option(options: &[(String, String)], decision: &str) -> Option<String> {
    let want: &[&str] = match decision {
        "allow" => &["allow_once", "allow_always"],
        "allow_always" => &["allow_always", "allow_once"],
        _ => &["reject_once", "reject_always"],
    };
    want.iter().find_map(|k| options.iter().find(|(_, kind)| kind == k).map(|(id, _)| id.clone()))
}

fn selected(id: &Value, option: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": { "outcome": "selected", "optionId": option } } })
}

pub(crate) fn approval_event(key: &str, params: &Value) -> ChannelEvent {
    let call = params.get("toolCall").cloned().unwrap_or(Value::Null);
    let input = tool_input(&call);
    let detail = content_text(call.get("content").unwrap_or(&Value::Null)).filter(|_| input.is_null());
    ChannelEvent::ApprovalAsked {
        request_id: Some(key.to_string()),
        call_id: call.get("toolCallId").and_then(Value::as_str).map(String::from),
        // 不带 kind 和参数时（Kimi）由前面 tool_call 登记的工具补
        name: (!input.is_null()).then(|| tool_name(&call)),
        input,
        replyable: true,
        detail,
    }
}

/// 聊天层「等你决定」卡上点了按钮
pub(crate) fn reply(ch: &Channel, request_id: &str, decision: &str) -> Result<(), String> {
    let writer = writer_of(ch)?;
    let (id, options) = ch
        .acp
        .lock()
        .map_err(|_| "实时通道已关闭")?
        .pending
        .remove(request_id)
        .ok_or("这条请求已经处理过了")?;
    let option = pick_option(&options, decision).ok_or("这一项这家不支持")?;
    write_line(&writer, &selected(&id, &option))?;
    feed(ch, vec![ChannelEvent::ApprovalResolved { request_id: Some(request_id.to_string()) }]);
    Ok(())
}

/// 原生模式发一句：session/prompt 的回包要等这一轮结束才到，这里不等，先开回合
pub(crate) fn send(ch: &Channel, text: &str) -> Result<(), String> {
    let writer = writer_of(ch)?;
    let msg = {
        let mut st = ch.acp.lock().map_err(|_| "实时通道已关闭")?;
        let sid = st.session.clone().ok_or("还没开好这段对话，稍等一下再发")?;
        if st.prompt.is_some() {
            return Err("这一轮还没结束，等它结束或先停止再发".into());
        }
        let (id, msg) = st.request("session/prompt", json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": text }] }));
        st.prompt = Some(id);
        msg
    };
    if let Err(e) = write_line(&writer, &msg) {
        if let Ok(mut st) = ch.acp.lock() {
            st.prompt = None;
        }
        return Err(e);
    }
    feed(ch, vec![ChannelEvent::TurnStart]);
    Ok(())
}

/// 停下这一轮：session/cancel 是通知，回合由 session/prompt 的回包（stopReason = cancelled）收
pub(crate) fn cancel(ch: &Channel) -> Result<(), String> {
    let writer = writer_of(ch)?;
    let sid = ch.acp.lock().map_err(|_| "实时通道已关闭")?.session.clone().ok_or("还没开好这段对话")?;
    write_line(&writer, &json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": sid } }))?;
    // 挂着的审批随之作废
    let stale: Vec<String> = ch.acp.lock().map(|mut s| s.pending.drain().map(|(k, _)| k).collect()).unwrap_or_default();
    feed(ch, stale.into_iter().map(|k| ChannelEvent::ApprovalResolved { request_id: Some(k) }).collect());
    let _ = now_ms;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kimi_tiers_map_to_acp_modes_with_crossed_names() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(mode_from_args("kimi", &a(&["-m", "x"])), (None, false));
        // 终端 --yolo（Ask When Needed）= ACP auto；终端 --auto（Never Ask）= ACP yolo
        assert_eq!(mode_from_args("kimi", &a(&["-m", "x", "--yolo"])), (Some("auto"), false));
        assert_eq!(mode_from_args("kimi", &a(&["-m", "x", "--auto"])), (Some("yolo"), false));
        assert_eq!(mode_from_args("kimi", &a(&["-m", "x", "--plan"])), (Some("plan"), true));
        assert_eq!(mode_from_args("claude-code", &a(&["--plan"])), (None, false));
    }

    #[test]
    fn session_updates_map_to_channel_events() {
        let ev = map_update(&json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"第一段"}}));
        assert!(matches!(&ev[..], [ChannelEvent::TextDelta(t)] if t == "第一段"));
        let ev = map_update(&json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"想一下"}}));
        assert!(matches!(&ev[..], [ChannelEvent::ThinkingDelta(t)] if t == "想一下"));
        // Kimi：kind execute、参数 JSON 写在 content 文字里
        let ev = map_update(&json!({"sessionUpdate":"tool_call","toolCallId":"0:c1","title":"Bash","kind":"execute","status":"pending",
            "content":[{"type":"content","content":{"type":"text","text":"{\"command\": \"echo mesa > a.txt\"}"}}]}));
        match &ev[..] {
            [ChannelEvent::ToolStart { call_id, name, input }] => {
                assert_eq!(call_id.as_deref(), Some("0:c1"));
                assert_eq!(name, "Bash");
                assert_eq!(input["command"], "echo mesa > a.txt");
            }
            other => panic!("{other:?}"),
        }
        // agy：rawInput、标题是命令本身
        let ev = map_update(&json!({"sessionUpdate":"tool_call","toolCallId":"t2","title":"echo mesa > a.txt","kind":"execute",
            "rawInput":{"CommandLine":"echo mesa > a.txt"}}));
        assert!(matches!(&ev[..], [ChannelEvent::ToolStart { name, input, .. }] if name == "Bash" && input["CommandLine"] == "echo mesa > a.txt"));
        assert!(matches!(&map_update(&json!({"sessionUpdate":"tool_call_update","toolCallId":"0:c1","status":"completed"}))[..],
            [ChannelEvent::ToolEnd { call_id }] if call_id.as_deref() == Some("0:c1")));
        assert!(map_update(&json!({"sessionUpdate":"tool_call_update","toolCallId":"0:c1","status":"in_progress"})).is_empty());
        assert!(map_update(&json!({"sessionUpdate":"usage_update"})).is_empty());
    }

    #[test]
    fn permission_choice_maps_to_option_ids_and_discuss_blocks_mutations() {
        let kimi = permission_options(&json!({"options":[
            {"optionId":"approve_once","kind":"allow_once"},{"optionId":"approve_always","kind":"allow_always"},{"optionId":"reject","kind":"reject_once"}]}));
        assert_eq!(pick_option(&kimi, "allow").as_deref(), Some("approve_once"));
        assert_eq!(pick_option(&kimi, "allow_always").as_deref(), Some("approve_always"));
        assert_eq!(pick_option(&kimi, "deny").as_deref(), Some("reject"));
        // agy 没有「总是允许」：退回允许一次
        let agy = permission_options(&json!({"options":[{"optionId":"allow","kind":"allow_once"},{"optionId":"deny","kind":"reject_once"}]}));
        assert_eq!(pick_option(&agy, "allow_always").as_deref(), Some("allow"));
        assert!(is_mutating(&json!({"toolCall":{"title":"Bash"}})));
        assert!(is_mutating(&json!({"toolCall":{"kind":"edit","title":"改 a.txt"}})));
        assert!(!is_mutating(&json!({"toolCall":{"kind":"read","title":"读 a.txt"}})));
        // 审批不带参数（Kimi）：不硬给名字，由前面 tool_call 登记的工具补；说明文字留作 detail
        match approval_event("7", &json!({"toolCall":{"toolCallId":"0:c1","title":"Bash",
            "content":[{"type":"content","content":{"type":"text","text":"Requesting approval to Running: echo mesa"}}]}})) {
            ChannelEvent::ApprovalAsked { request_id, call_id, name, replyable, detail, .. } => {
                assert_eq!(request_id.as_deref(), Some("7"));
                assert_eq!(call_id.as_deref(), Some("0:c1"));
                assert_eq!(name, None);
                assert!(replyable);
                assert_eq!(detail.as_deref(), Some("Requesting approval to Running: echo mesa"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn model_check_switches_or_reports_when_session_model_differs() {
        let opened = |cur: &str| json!({"result":{"configOptions":[{"id":"model","currentValue":cur,
            "options":[{"value":"__kimi_env_model__"},{"value":"kimi-k3"}]}]}});
        assert_eq!(model_check(&opened("__kimi_env_model__"), Some("__kimi_env_model__")), ModelCheck::Fine);
        assert_eq!(model_check(&opened("kimi-k3"), Some("__kimi_env_model__")), ModelCheck::Switch("__kimi_env_model__".into()));
        assert_eq!(
            model_check(&opened("kimi-k3"), Some("gpt-x")),
            ModelCheck::Missing { want: "gpt-x".into(), current: "kimi-k3".into() }
        );
        assert_eq!(model_check(&opened("kimi-k3"), None), ModelCheck::Fine, "没选模型不核对");
        assert_eq!(model_check(&json!({"result":{}}), Some("x")), ModelCheck::Fine, "不报模型的家不核对");
    }

    #[test]
    fn prompt_reply_ends_turn_with_stop_reason_or_redacted_error() {
        assert!(matches!(&prompt_end_events(&json!({"id":3,"result":{"stopReason":"cancelled"}}))[..],
            [ChannelEvent::TurnEnd { reason }] if reason.as_deref() == Some("cancelled")));
        let ev = prompt_end_events(&json!({"id":3,"error":{"code":-32603,"message":"upstream 401 sk-live-secret-987654321"}}));
        assert!(matches!(&ev[0], ChannelEvent::TurnEnd { reason } if reason.as_deref() == Some("failed")));
        assert!(matches!(&ev[1], ChannelEvent::ErrorDetail(m) if !m.contains("987654321")));
        assert!(constant_eq("abc", "abc") && !constant_eq("abc", "abd") && !constant_eq("abc", "ab"));
    }
}
