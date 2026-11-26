//! 原生模式的 Claude Code 驱动（docs/design-chat-native-mode.md 第 3 期）：`claude -p` 双向 stream-json，Mesa 当宿主。
//!
//! 只对 API 密钥 / 中转网关连接开放——Anthropic 不允许第三方产品提供 claude.ai 订阅登录（设计稿 §1），官方账号的
//! Claude 对话只走终端模式（pty.rs 起进程前就挡掉）。PTY 里起 `mesa_helper stdio-bridge -- claude -p …`，桥连回这里。
//!
//! 2026-11-26 Claude Code 2.1.326 实测（scripts/native-probe/claude_probe.py）：
//! - 审批交宿主要带 `--permission-prompts host --permission-prompt-tool stdio`（后者 --help 不单列），不带则一律拒；
//!   请求是 `control_request` `can_use_tool`（tool_name / input / permission_suggestions / tool_use_id），回 `control_response`
//!   `{behavior: allow, updatedInput}` 或 `{behavior: deny, message}`。
//! - 提问表单（AskUserQuestion）走同一个 `can_use_tool`：`updatedInput.answers = {题目: 选项}`，不用按键。
//! - 计划模式 ExitPlanMode 也走它（带方案全文与方案文件路径）。
//! - 边写边显示要 `--include-partial-messages`（stream_event 的 text_delta）；一轮以 `result` 收尾；停是 `control_request` interrupt。
//! - 「本会话都允许」：把 permission_suggestions 的落点一律改成 session 再回（updatedPermissions），不让 Claude 写设置文件（CLI 配置只读）。

use super::acp::{accept, write_line, writer_of, AcpPrep};
use super::{feed, ChannelEvent, Channel, Prepared, Replier};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// 实测过的起点版本（2.1.326 起 `--permission-prompts host` 在 --help 里）
const CLAUDE_NATIVE_MIN: (u32, u32, u32) = (2, 1, 326);

#[derive(Default)]
pub(crate) struct ClaudeState {
    session: Option<String>,
    next_id: i64,
    /// 未答的 can_use_tool：request_id → (原始 input, permission_suggestions)
    pending: HashMap<String, (Value, Value)>,
    /// 会话文件找到了没有（第一轮之后才落盘）
    transcript: Option<String>,
    /// 这一轮有没有在跑（stdin 里排着的话 Claude 会在这一轮里接着处理，result 只来一次）
    busy: bool,
}

pub(crate) fn supported(agent: &str) -> bool {
    agent == "claude-code" && super::version_at_least(agent, CLAUDE_NATIVE_MIN)
}

/// 启动参数里定下的会话 id（`--session-id` 新开、`--resume` 接回）
fn session_from_args(args: &[String]) -> Option<String> {
    args.iter()
        .position(|a| a == "--session-id" || a == "--resume" || a == "-r")
        .and_then(|i| args.get(i + 1))
        .filter(|v| !v.starts_with('-'))
        .cloned()
}

/// pty_spawn 在起进程前调用：`allowed` = 这条连接能用原生模式（官方订阅账号为 false）。不成返回 None，照旧终端模式
pub(crate) fn prepare(
    agent: &str,
    tab_id: Option<&str>,
    cwd: &str,
    binary: &Path,
    args: &[String],
    allowed: bool,
) -> Option<(PathBuf, Vec<String>, Vec<(String, String)>, Prepared)> {
    if !allowed || !supported(agent) {
        return None;
    }
    let tab = tab_id.map(super::sanitize_tab).filter(|t| !t.is_empty())?;
    let helper = crate::image_gen::find_bundled_helper("stdio-bridge")?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
    let addr = listener.local_addr().ok()?;
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let mut bridge_args: Vec<String> = [
        "stdio-bridge",
        "--",
        &binary.to_string_lossy(),
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompts",
        "host",
        "--permission-prompt-tool",
        "stdio",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    bridge_args.extend(args.iter().cloned());
    let env = vec![
        ("CCODE_TAB_ID".to_string(), tab.clone()),
        (crate::stdio_bridge::ADDR_ENV.to_string(), addr.to_string()),
        (crate::stdio_bridge::TOKEN_ENV.to_string(), token.clone()),
    ];
    let prepared = Prepared {
        agent: agent.to_string(),
        tab_id: tab,
        kind: "claude-native",
        dir: None,
        hooks_log: None,
        qwen_events: None,
        replier: None,
        codex: None,
        sidecar: None,
        acp: Some(AcpPrep::bridge_only(listener, token, cwd, session_from_args(args))),
        session: None,
    };
    Some((helper, bridge_args, env, prepared))
}

pub(crate) fn run(ch: Arc<Channel>, prep: AcpPrep) {
    let Some(stream) = accept(&ch, &prep.listener, &prep.token) else {
        super::disconnect(&ch);
        return;
    };
    let Ok(read_half) = stream.try_clone() else {
        super::disconnect(&ch);
        return;
    };
    let writer = Arc::new(std::sync::Mutex::new(stream));
    if let Ok(mut r) = ch.replier.lock() {
        *r = Some(Replier::Acp { stream: writer.clone() });
    }
    let sid = prep.resume.clone();
    if let Ok(mut st) = ch.claude.lock() {
        st.session = sid.clone();
    }
    let mut events = vec![ChannelEvent::Connected];
    if let Some(id) = sid {
        let path = find_transcript(&id);
        if let Ok(mut st) = ch.claude.lock() {
            st.transcript = path.clone();
        }
        events.push(ChannelEvent::Session { id, path, source: None });
    }
    feed(&ch, events);
    // SDK 宿主开头先发 initialize（控制协议握手；回包里有命令清单，这里不用）
    let init = next_request(&ch, json!({ "subtype": "initialize" }));
    let _ = write_line(&writer, &init);
    for line in BufReader::new(read_half).lines() {
        if ch.stop.load(Ordering::Acquire) {
            break;
        }
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
        if std::env::var("MESA_CHANNEL_DEBUG").is_ok() {
            eprintln!("claude← {}", msg.to_string().chars().take(300).collect::<String>());
        }
        handle(&ch, &msg);
    }
    super::disconnect(&ch);
}

fn next_request(ch: &Channel, request: Value) -> Value {
    let id = ch
        .claude
        .lock()
        .map(|mut st| {
            st.next_id += 1;
            st.next_id
        })
        .unwrap_or(0);
    json!({ "type": "control_request", "request_id": format!("mesa-{id}"), "request": request })
}

/// Claude 的会话本体：`<根>/projects/<目录编码>/<会话 id>.jsonl`（不自己编码目录，按 id 找，免得 /tmp → /private/tmp 一类对不上）
fn find_transcript(sid: &str) -> Option<String> {
    if sid.is_empty() || sid.contains(['/', '\\']) {
        return None;
    }
    let projects = crate::sessions::SessionRoots::current()?.claude_projects();
    for e in std::fs::read_dir(&projects).ok()?.flatten() {
        let p = e.path().join(format!("{sid}.jsonl"));
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}

fn handle(ch: &Arc<Channel>, msg: &Value) {
    match msg.get("type").and_then(Value::as_str) {
        Some("system") if msg.get("subtype").and_then(Value::as_str) == Some("init") => {
            let Some(id) = msg.get("session_id").and_then(Value::as_str).map(String::from) else { return };
            let known = ch.claude.lock().ok().and_then(|s| s.session.clone());
            if known.as_deref() != Some(id.as_str()) {
                if let Ok(mut st) = ch.claude.lock() {
                    st.session = Some(id.clone());
                    st.transcript = None;
                }
                feed(ch, vec![ChannelEvent::Session { id: id.clone(), path: find_transcript(&id), source: None }]);
            }
        }
        Some("control_request") => {
            let req = msg.get("request").cloned().unwrap_or(Value::Null);
            if req.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
                return;
            }
            let Some(rid) = msg.get("request_id").and_then(Value::as_str).map(String::from) else { return };
            let input = req.get("input").cloned().unwrap_or(Value::Null);
            let suggestions = req.get("permission_suggestions").cloned().unwrap_or(Value::Null);
            let has_always = suggestions.as_array().is_some_and(|a| !a.is_empty());
            let name = req.get("tool_name").and_then(Value::as_str).unwrap_or("").to_string();
            if let Ok(mut st) = ch.claude.lock() {
                st.pending.insert(rid.clone(), (input.clone(), suggestions));
            }
            if let Ok(mut t) = ch.tracker.lock() {
                if has_always {
                    t.always_labels.insert(rid.clone(), "本会话都允许".into());
                }
                if name == "AskUserQuestion" {
                    if let Some(q) = input.get("questions").filter(|q| q.is_array()) {
                        t.native_questions.insert(rid.clone(), q.clone());
                    }
                }
            }
            let detail = req
                .get("description")
                .or_else(|| req.get("decision_reason"))
                .and_then(Value::as_str)
                .map(String::from);
            feed(
                ch,
                vec![ChannelEvent::ApprovalAsked {
                    request_id: Some(rid),
                    call_id: req.get("tool_use_id").and_then(Value::as_str).map(String::from),
                    name: Some(name),
                    input,
                    replyable: true,
                    detail,
                }],
            );
        }
        Some("control_cancel_request") => {
            if let Some(rid) = msg.get("request_id").and_then(Value::as_str) {
                if let Ok(mut st) = ch.claude.lock() {
                    st.pending.remove(rid);
                }
                feed(ch, vec![ChannelEvent::ApprovalResolved { request_id: Some(rid.to_string()) }]);
            }
        }
        Some("result") => {
            if let Ok(mut st) = ch.claude.lock() {
                st.busy = false;
            }
            let mut events = result_events(msg);
            if let Some(ev) = refresh_transcript(ch) {
                events.push(ev);
            }
            feed(ch, events);
        }
        _ => feed(ch, map_message(msg)),
    }
}

fn refresh_transcript(ch: &Channel) -> Option<ChannelEvent> {
    let (sid, known) = {
        let st = ch.claude.lock().ok()?;
        (st.session.clone()?, st.transcript.is_some())
    };
    if known {
        return None;
    }
    let path = find_transcript(&sid)?;
    if let Ok(mut st) = ch.claude.lock() {
        st.transcript = Some(path.clone());
    }
    Some(ChannelEvent::Session { id: sid, path: Some(path), source: None })
}

/// 一轮的收尾：result 的 subtype / is_error → 回合结束原因（纯函数）
pub(crate) fn result_events(msg: &Value) -> Vec<ChannelEvent> {
    let subtype = msg.get("subtype").and_then(Value::as_str).unwrap_or("success");
    let is_error = msg.get("is_error").and_then(Value::as_bool) == Some(true);
    if subtype == "success" && !is_error {
        return vec![ChannelEvent::TurnEnd { reason: Some("end_turn".into()) }];
    }
    // 停下（interrupt）报 error_during_execution；其余（超轮数、出错）带原话
    let interrupted = subtype == "error_during_execution"
        && msg.get("result").and_then(Value::as_str).map_or(true, |r| r.is_empty() || r.to_lowercase().contains("interrupt"));
    if interrupted {
        return vec![ChannelEvent::TurnEnd { reason: Some("cancelled".into()) }];
    }
    let text = msg
        .get("result")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(crate::sessions::redact_sensitive_text)
        .unwrap_or_else(|| format!("这一轮没有完成（{subtype}）"));
    vec![ChannelEvent::TurnEnd { reason: Some("failed".into()) }, ChannelEvent::ErrorDetail(text)]
}

/// stream_event / assistant / user → 旁路事件（纯函数）
pub(crate) fn map_message(msg: &Value) -> Vec<ChannelEvent> {
    match msg.get("type").and_then(Value::as_str) {
        Some("stream_event") => {
            let ev = msg.get("event").unwrap_or(&Value::Null);
            if ev.get("type").and_then(Value::as_str) != Some("content_block_delta") {
                return Vec::new();
            }
            let delta = ev.get("delta").unwrap_or(&Value::Null);
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => delta
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|t| vec![ChannelEvent::TextDelta(t.to_string())])
                    .unwrap_or_default(),
                Some("thinking_delta") => delta
                    .get("thinking")
                    .and_then(Value::as_str)
                    .map(|t| vec![ChannelEvent::ThinkingDelta(t.to_string())])
                    .unwrap_or_default(),
                _ => Vec::new(),
            }
        }
        // 子 Agent 的消息（parent_tool_use_id 非空）不进主对话
        Some("assistant") if msg.get("parent_tool_use_id").is_none_or(Value::is_null) => msg
            .pointer("/message/content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
                    .map(|b| ChannelEvent::ToolStart {
                        call_id: b.get("id").and_then(Value::as_str).map(String::from),
                        name: b.get("name").and_then(Value::as_str).unwrap_or("tool").to_string(),
                        input: b.get("input").cloned().unwrap_or(Value::Null),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Some("user") if msg.get("parent_tool_use_id").is_none_or(Value::is_null) => msg
            .pointer("/message/content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
                    .map(|b| ChannelEvent::ToolEnd {
                        call_id: b.get("tool_use_id").and_then(Value::as_str).map(String::from),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// 「本会话都允许」：建议规则的落点一律改成 session，只在这段会话里生效、不写任何设置文件（纯函数）
pub(crate) fn session_only(suggestions: &Value) -> Value {
    let Some(list) = suggestions.as_array() else { return json!([]) };
    Value::Array(
        list.iter()
            .map(|s| {
                let mut s = s.clone();
                if let Some(o) = s.as_object_mut() {
                    o.insert("destination".into(), json!("session"));
                }
                s
            })
            .collect(),
    )
}

/// 回 can_use_tool 的那一条（纯函数）：answers 是提问表单的答案（题目 → 选项），合进 updatedInput
pub(crate) fn permission_reply(request_id: &str, decision: &str, input: &Value, suggestions: &Value, answers: Option<&Value>) -> Value {
    let response = if decision == "deny" {
        json!({ "behavior": "deny", "message": "用户在 Mesa 里拒绝了这一步" })
    } else {
        let mut updated = input.clone();
        if let (Some(a), Some(o)) = (answers.filter(|a| a.is_object()), updated.as_object_mut()) {
            o.insert("answers".into(), a.clone());
        }
        let mut r = json!({ "behavior": "allow", "updatedInput": updated });
        if decision == "allow_always" {
            r["updatedPermissions"] = session_only(suggestions);
        }
        r
    };
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } })
}

pub(crate) fn reply(ch: &Channel, request_id: &str, decision: &str, answers: Option<&Value>) -> Result<(), String> {
    let writer = writer_of(ch)?;
    let (input, suggestions) = ch
        .claude
        .lock()
        .map_err(|_| "实时通道已关闭")?
        .pending
        .remove(request_id)
        .ok_or("这条请求已经处理过了")?;
    write_line(&writer, &permission_reply(request_id, decision, &input, &suggestions, answers))?;
    feed(ch, vec![ChannelEvent::ApprovalResolved { request_id: Some(request_id.to_string()) }]);
    Ok(())
}

/// 发一句：这一轮还在跑也能发（Claude 在这一轮里接着处理排着的话，result 只来一次）
pub(crate) fn send(ch: &Channel, text: &str) -> Result<(), String> {
    let writer = writer_of(ch)?;
    let sid = ch.claude.lock().map_err(|_| "实时通道已关闭")?.session.clone().unwrap_or_default();
    let msg = json!({
        "type": "user",
        "message": { "role": "user", "content": text },
        "parent_tool_use_id": null,
        "session_id": sid,
    });
    write_line(&writer, &msg)?;
    let was_busy = ch.claude.lock().map(|mut st| std::mem::replace(&mut st.busy, true)).unwrap_or(false);
    if !was_busy {
        feed(ch, vec![ChannelEvent::TurnStart]);
    }
    Ok(())
}

pub(crate) fn cancel(ch: &Channel) -> Result<(), String> {
    let writer = writer_of(ch)?;
    let msg = next_request(ch, json!({ "subtype": "interrupt" }));
    write_line(&writer, &msg)?;
    let stale: Vec<String> = ch.claude.lock().map(|mut s| s.pending.drain().map(|(k, _)| k).collect()).unwrap_or_default();
    feed(ch, stale.into_iter().map(|k| ChannelEvent::ApprovalResolved { request_id: Some(k) }).collect());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_comes_from_launch_args() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(session_from_args(&a(&["--settings", "x", "--session-id", "s1"])).as_deref(), Some("s1"));
        assert_eq!(session_from_args(&a(&["--resume", "s2", "--model", "m"])).as_deref(), Some("s2"));
        assert_eq!(session_from_args(&a(&["--model", "m"])), None);
    }

    #[test]
    fn stream_json_messages_map_to_channel_events() {
        let ev = map_message(&json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"第一行"}}}));
        assert!(matches!(&ev[..], [ChannelEvent::TextDelta(t)] if t == "第一行"));
        let ev = map_message(&json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"想"}}}));
        assert!(matches!(&ev[..], [ChannelEvent::ThinkingDelta(t)] if t == "想"));
        let ev = map_message(&json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[
            {"type":"text","text":"先跑一下"},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}));
        assert!(matches!(&ev[..], [ChannelEvent::ToolStart { call_id, name, input }]
            if call_id.as_deref() == Some("toolu_1") && name == "Bash" && input["command"] == "ls"));
        let ev = map_message(&json!({"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}));
        assert!(matches!(&ev[..], [ChannelEvent::ToolEnd { call_id }] if call_id.as_deref() == Some("toolu_1")));
        // 子 Agent 的不进主对话
        assert!(map_message(&json!({"type":"assistant","parent_tool_use_id":"toolu_9","message":{"content":[{"type":"tool_use","id":"x","name":"Read","input":{}}]}})).is_empty());
    }

    #[test]
    fn result_ends_turn_as_done_cancelled_or_failed() {
        assert!(matches!(&result_events(&json!({"type":"result","subtype":"success","is_error":false,"result":"done"}))[..],
            [ChannelEvent::TurnEnd { reason }] if reason.as_deref() == Some("end_turn")));
        assert!(matches!(&result_events(&json!({"type":"result","subtype":"error_during_execution","is_error":true}))[..],
            [ChannelEvent::TurnEnd { reason }] if reason.as_deref() == Some("cancelled")));
        let ev = result_events(&json!({"type":"result","subtype":"success","is_error":true,"result":"API Error: 401 sk-live-secret-987654321"}));
        assert!(matches!(&ev[0], ChannelEvent::TurnEnd { reason } if reason.as_deref() == Some("failed")));
        assert!(matches!(&ev[1], ChannelEvent::ErrorDetail(m) if !m.contains("987654321")));
    }

    #[test]
    fn permission_reply_shapes_allow_deny_always_and_answers() {
        let input = json!({"command":"echo mesa > a.txt"});
        let sugg = json!([{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"echo mesa *"}],"behavior":"allow","destination":"localSettings"}]);
        let r = permission_reply("r1", "allow", &input, &sugg, None);
        assert_eq!(r["response"]["request_id"], "r1");
        assert_eq!(r["response"]["response"]["behavior"], "allow");
        assert_eq!(r["response"]["response"]["updatedInput"], input);
        assert!(r["response"]["response"].get("updatedPermissions").is_none());
        // 本会话都允许：不写 localSettings
        let r = permission_reply("r1", "allow_always", &input, &sugg, None);
        assert_eq!(r["response"]["response"]["updatedPermissions"][0]["destination"], "session");
        let r = permission_reply("r1", "deny", &input, &sugg, None);
        assert_eq!(r["response"]["response"]["behavior"], "deny");
        // 提问表单：答案合进 updatedInput
        let ask = json!({"questions":[{"question":"颜色？","options":[{"label":"红"},{"label":"绿"}]}]});
        let r = permission_reply("r2", "allow", &ask, &Value::Null, Some(&json!({"颜色？":"绿"})));
        assert_eq!(r["response"]["response"]["updatedInput"]["answers"]["颜色？"], "绿");
        assert_eq!(r["response"]["response"]["updatedInput"]["questions"], ask["questions"]);
    }
}
