use super::*;

// ===== CodeBuddy Code（~/.codebuddy/projects/<slug>/<uuid>.jsonl；slug 把路径分隔符换成 '-'，Windows 是 C-Users 不是 Claude 的 C--Users，见 matrix §7） =====
//
// 行 schema（v2.132.0 实测）：
//   {"type":"message","role":"user","content":[{"type":"input_text","text":...}],
//    "sessionId":"<uuid>","cwd":"<项目路径>","timestamp":<毫秒 epoch>}
//   assistant 行 content 块为 output_text；file-history-snapshot 等事件行跳过。
//   工具（2.172.1 实测，CLI 金丝雀 2026-10-22 发现原先没读）：{"type":"function_call","callId","name","arguments":"<JSON 串>"}、
//   {"type":"function_call_result","callId","name","status":"completed","output":{"type":"text","text":...}}；
//   ptc 模式下 name 是 REPL，arguments 里是一段调用别的工具的 JS（code）和一句 description。
// 与 claude schema 不同构，独立解析器；防御式：未知 type/缺字段/末行截断一律跳过。

/// 时间戳是毫秒 epoch 数字（容错 ISO 字符串），统一转 ISO
pub(super) fn codebuddy_time(v: &Value) -> Option<String> {
    match v.get("timestamp") {
        Some(Value::Number(n)) => n.as_u64().map(|ms| iso_from_unix(ms / 1000)),
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// content 数组里指定块类型的文本拼接（input_text / output_text）
pub(super) fn codebuddy_content_text(v: &Value, block_type: &str) -> Option<String> {
    let arr = v.get("content")?.as_array()?;
    let text = arr
        .iter()
        .filter_map(|b| {
            if get_str(b, "type") == Some(block_type) {
                get_str(b, "text")
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

pub(super) fn codebuddy_file_meta(path: &Path, alive: bool) -> Option<SessionMetaDto> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let (mut cwd, mut created, mut session_id, mut title) = (None, None, None, None);
    for line in head.iter().chain(&tail) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if cwd.is_none() {
            cwd = get_str(&v, "cwd").map(String::from);
        }
        if created.is_none() {
            created = codebuddy_time(&v);
        }
        if session_id.is_none() {
            session_id = get_str(&v, "sessionId").map(String::from);
        }
        if title.is_none()
            && get_str(&v, "type") == Some("message")
            && get_str(&v, "role") == Some("user")
        {
            title = codebuddy_content_text(&v, "input_text").and_then(|t| usable_title(&t));
        }
    }
    // 目录名是 sanitize 后的项目路径（有损），不解码；读不到 cwd 时原样兜底（同 Claude 规则）
    let project_path = cwd.clone().unwrap_or_else(|| {
        path.parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some(SessionMetaDto {
        agent: "codebuddy".into(),
        session_id,
        project_path: project_path.clone(),
        cwd: cwd.clone(),
        title,
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage: None,
        cli_version: None,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive,
        chain_count: 1,
        workspace: None,
        step_name: None,
        summary: None,
        live: alive && mtime_fresh(path, 60),
        source: default_session_source(),
        internal: false,
        handoff_from_agent: None,
        handoff_from_session: None,
        task_id: None,
        task_name: None,
        provider: None,
        profile_id: None,
        forked_from: None,
        reader: false,
        reader_pdf: None,
        step_meta: Default::default(),
        relay: Default::default(),
        title_by_user: false,
    })
}

pub(super) fn parse_codebuddy(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue; // 末行截断等坏行直接跳过
        };
        let ts = codebuddy_time(&v);
        match get_str(&v, "type") {
            Some("function_call") => {
                msgs.push(ChatMessageDto {
                    role: "assistant".into(),
                    blocks: vec![BlockDto {
                        kind: "tool_use".into(),
                        text: get_str(&v, "arguments").unwrap_or("").to_string(),
                        tool_name: get_str(&v, "name").map(String::from),
                        is_error: false,
                        call_id: get_str(&v, "callId").map(String::from),
                    }],
                    timestamp: ts,
                    usage: None,
                    id: get_str(&v, "id").map(String::from),
                    cwd: None,
                });
                continue;
            }
            Some("function_call_result") => {
                let output = v.get("output");
                let text = output
                    .and_then(|o| o.get("text"))
                    .and_then(Value::as_str)
                    .map(String::from)
                    .unwrap_or_else(|| stringify_payload(output));
                push_tool_result(
                    &mut msgs,
                    vec![BlockDto {
                        kind: "tool_result".into(),
                        text,
                        tool_name: None,
                        is_error: matches!(get_str(&v, "status"), Some("error" | "failed")),
                        call_id: get_str(&v, "callId").map(String::from),
                    }],
                    ts,
                );
                continue;
            }
            Some("message") => {}
            _ => continue, // file-history-snapshot 等事件行
        }
        match get_str(&v, "role") {
            Some("user") => {
                let Some(text) = codebuddy_content_text(&v, "input_text") else {
                    continue;
                };
                msgs.push(ChatMessageDto {
                    role: "user".into(),
                    blocks: vec![text_block(text)],
                    timestamp: ts,
                    usage: None,
                    id: None,
                    cwd: None,
                });
            }
            Some("assistant") => {
                let Some(text) = codebuddy_content_text(&v, "output_text") else {
                    continue;
                };
                msgs.push(ChatMessageDto {
                    role: "assistant".into(),
                    blocks: vec![text_block(text)],
                    timestamp: ts,
                    usage: None,
                    id: None,
                    cwd: None,
                });
            }
            _ => {}
        }
    }
    msgs
}
