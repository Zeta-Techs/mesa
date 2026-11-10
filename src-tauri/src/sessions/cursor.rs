use super::*;

// ===== Cursor CLI（~/.cursor/projects/<编码cwd>/agent-transcripts/<uuid>/<uuid>.jsonl） =====
//
// 目录名=文件名=session id；<编码cwd> 把路径分隔符替换成 '-'（有损，不解码；Windows 是 C-Users，同 CodeBuddy，非 Claude 的 C--Users）。
// JSONL 每行带 type 字段，源码枚举（2026.08.04-aaa8809 调研）：
//   user_message / tool_call / tool_result / turn_ended / turn_id / message_id 等。
// 完整字段样本未验证——防御式解析：未知 type 跳过，文本/时间戳按多个候选字段名提取，
// 缺字段/末行截断一律容忍。会话发现只能文件扫描（agent ls 是 Ink TUI，非 TTY 会崩）。

/// 文本提取：字符串直取；数组拼接各块文本；对象取 text 字段。
/// 候选层级 message.content / content / text 依次尝试（字段名未实证，多候选兜底）
pub(super) fn cursor_text_of(x: &Value) -> Option<String> {
    match x {
        Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
        Value::Array(arr) => {
            let text = arr
                .iter()
                .filter_map(cursor_text_of)
                .collect::<Vec<_>>()
                .join("\n");
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
        Value::Object(_) => x
            .get("text")
            .and_then(cursor_text_of)
            .or_else(|| x.get("content").and_then(cursor_text_of)),
        _ => None,
    }
}

pub(super) fn cursor_text(v: &Value) -> Option<String> {
    v.get("message")
        .and_then(cursor_text_of)
        .or_else(|| v.get("content").and_then(cursor_text_of))
        .or_else(|| v.get("text").and_then(cursor_text_of))
}

/// 时间戳候选字段名未实证，逐个尝试；数字按量级区分毫秒/秒 epoch，字符串当 ISO 原样透传
pub(super) fn cursor_time(v: &Value) -> Option<String> {
    for key in ["timestamp", "time", "created_at", "createdAt", "ts"] {
        match v.get(key) {
            Some(Value::Number(n)) => {
                let raw = n.as_i64()?;
                let secs = if raw.abs() >= 1_000_000_000_000 {
                    raw / 1000
                } else {
                    raw
                };
                return u64::try_from(secs).ok().map(iso_from_unix);
            }
            Some(Value::String(s)) => return Some(s.clone()),
            _ => continue,
        }
    }
    None
}

pub(super) fn cursor_file_meta(path: &Path, alive: bool) -> Option<SessionMetaDto> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let (mut cwd, mut created, mut session_id, mut title) = (None, None, None, None);
    for line in head.iter().chain(&tail) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if cwd.is_none() {
            // cwd 字段名未实证，多候选兜底；没有就靠目录名（有损）兜底
            cwd = ["cwd", "project_path", "workingDirectory"]
                .iter()
                .find_map(|k| get_str(&v, k))
                .map(String::from);
        }
        if created.is_none() {
            created = cursor_time(&v);
        }
        if session_id.is_none() {
            // 候选只收明确的会话 id 字段名；泛化的 "id" 会误中 turn_id/message_id 事件行
            session_id = ["session_id", "sessionId"]
                .iter()
                .find_map(|k| get_str(&v, k))
                .map(String::from);
        }
        if title.is_none() && get_str(&v, "type") == Some("user_message") {
            title = cursor_text(&v).and_then(|t| usable_title(&t));
        }
    }
    // 目录名是编码后的项目路径（分隔符→'-'，有损不解码）；读不到 cwd 时原样兜底（同 Claude 规则）。
    // 结构 projects/<编码cwd>/agent-transcripts/<uuid>/<uuid>.jsonl：上三级才是编码目录名
    let project_path = cwd.clone().unwrap_or_else(|| {
        path.parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some(SessionMetaDto {
        agent: "cursor".into(),
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

pub(super) fn parse_cursor(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue; // 末行截断等坏行直接跳过
        };
        let ts = cursor_time(&v);
        match get_str(&v, "type") {
            Some("user_message") => {
                let Some(text) = cursor_text(&v) else {
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
            // 助手正文是否带独立 type 未实证，多候选；tool_call 等事件行不渲染成消息
            Some("assistant_message") => {
                let Some(text) = cursor_text(&v) else {
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
            _ => {} // tool_call/tool_result/turn_ended/turn_id/message_id 及未知 type 跳过
        }
    }
    msgs
}
