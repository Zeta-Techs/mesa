use super::*;

// ===== Grok Build（~/.grok/sessions/<encoded-cwd>/<session-id>/，xai-org/grok-build 源码调研 2026-08） =====
//
// 目录式会话：每会话一个 <session-id-uuidv7>/ 目录，内含
//   summary.json   —— info{id,cwd}、generated_title、parent_session_id（compact/继续的父会话）、created_at/updated_at
//   updates.jsonl  —— 权威对话日志（append-only），本解析器的消费对象
//   chat_history.jsonl 等（原始请求消息，不解析）
// updates.jsonl 每行：{"timestamp": <unix秒>, "method": "session/update", "params": <ACP SessionNotification>}；
// 消费方式 = params.update.sessionUpdate：user_message_chunk / agent_message_chunk
//（content 为 ACP ContentBlock，text 在 content.text）/ tool_call / tool_call_update / plan 等，
// 另有 _x.ai/ 前缀扩展通知。~/.grok/sessions/session_search.sqlite 只是 FTS 索引，不是会话本体。
// 防御式：未知 sessionUpdate 类型/缺字段/末行截断一律跳过。

/// ACP ContentBlock 提取文本（text 在 content.text；容错 content 为字符串直取）
pub(super) fn grok_content_text(update: &Value) -> Option<String> {
    let content = update.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Object(_) => get_str(content, "text")?.to_string(),
        _ => return None,
    };
    let text = unwrap_prompt_tags(&text);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// 行时间戳：unix 秒数字转 ISO（容错字符串原样透传）
pub(super) fn grok_time(v: &Value) -> Option<String> {
    match v.get("timestamp") {
        Some(Value::Number(n)) => n.as_u64().map(iso_from_unix),
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// 会话目录路径：.../sessions/<encoded-cwd>/<session-id>/<file>
/// 回退两级取 encoded-cwd 目录名（有损不解码）；summary.json 的 info.cwd 优先
pub(super) fn grok_session_dir(path: &Path) -> Option<&Path> {
    path.parent()
}

/// 从同目录 summary.json 读元信息（缺文件/缺字段容错回落）
pub(super) fn grok_summary(path: &Path) -> Option<Value> {
    let dir = grok_session_dir(path)?;
    read_json_file(&dir.join("summary.json"))
}

pub(super) fn grok_file_meta(path: &Path, alive: bool) -> Option<(SessionMetaDto, Option<String>)> {
    // 会话文件本体是 updates.jsonl；meta 优先 summary.json，回落 updates.jsonl 行内提取
    let summary = grok_summary(path);
    let info = summary.as_ref().and_then(|s| s.get("info"));
    let parent = summary
        .as_ref()
        .and_then(|s| get_str(s, "parent_session_id"))
        .map(String::from);
    let (mut created, mut updated, mut title) = (None, None, None);
    let cwd = info.and_then(|i| get_str(i, "cwd")).map(String::from);
    let session_id = info.and_then(|i| get_str(i, "id")).map(String::from);
    if let Some(s) = &summary {
        created = grok_time_field(s, "created_at").or_else(|| grok_time(s));
        updated = grok_time_field(s, "updated_at");
        title = get_str(s, "generated_title").and_then(usable_title);
    }
    // summary.json 读不到时从 updates.jsonl 行内补（head 提首条用户消息做标题，尾行时间戳做 updated）
    if created.is_none() || title.is_none() || cwd.is_none() {
        if let Some((head, tail)) = read_head_tail(path, 64 * 1024) {
            for line in head.iter().chain(&tail) {
                let Ok(v) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                if created.is_none() {
                    created = grok_time(&v);
                }
                if updated.is_none() {
                    updated = grok_time(&v);
                }
                if title.is_none() {
                    if let Some(update) = v.get("params").and_then(|p| p.get("update")) {
                        if get_str(update, "sessionUpdate") == Some("user_message_chunk") {
                            title = grok_content_text(update).and_then(|t| usable_title(&t));
                        }
                    }
                }
            }
        }
    }
    let project_path = cwd.clone().unwrap_or_else(|| {
        // 目录名是 URL 编码的 cwd（超长则 slug+hash），不解码；读不到 info.cwd 时原样兜底（同 Claude 规则）
        grok_session_dir(path)
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let session_id = session_id
        .or_else(|| {
            grok_session_dir(path)
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
        })
        .unwrap_or_default();
    Some((
        SessionMetaDto {
            agent: "grok".into(),
            session_id,
            project_path: project_path.clone(),
            cwd: cwd.clone(),
            title,
            created_at: created,
            updated_at: updated.or_else(|| mtime_iso(path)),
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
            title_by_user: false,
        },
        parent,
    ))
}

/// summary.json 的 updated_at 字段（created_at 走 grok_time 复用 timestamp 键——summary 顶层
/// 是 created_at/updated_at 不是 timestamp，分开取）
pub(super) fn grok_time_field(v: &Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_u64().map(iso_from_unix),
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

pub(super) fn parse_grok(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs: Vec<ChatMessageDto> = Vec::new();
    // 流式 chunk 聚合（2026-08-24）：grok 一条消息是多个连续 chunk，逐 chunk 独立成条会把
    // 一句话刷成一屏碎片——连续同角色 chunk 追加进上一条消息；tool_call/tool_call_update
    // 打断连续性（其后的 chunk 是工具回合后的新一轮输出）；plan/未知类型跳过且不打断
    let mut break_run = true;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue; // 末行截断等坏行直接跳过
        };
        let Some(update) = v.get("params").and_then(|p| p.get("update")) else {
            continue;
        };
        let ts = grok_time(&v);
        match get_str(update, "sessionUpdate") {
            Some(kind @ ("user_message_chunk" | "agent_message_chunk")) => {
                let Some(text) = grok_content_text(update) else {
                    continue;
                };
                let role = if kind == "user_message_chunk" {
                    "user"
                } else {
                    "assistant"
                };
                if !break_run && msgs.last().is_some_and(|m| m.role == role) {
                    let m = msgs.last_mut().unwrap();
                    if let Some(b) = m.blocks.first_mut() {
                        b.text.push_str(&text);
                    }
                } else {
                    msgs.push(ChatMessageDto {
                        role: role.into(),
                        blocks: vec![text_block(text)],
                        timestamp: ts,
                        usage: None,
                        id: None,
                        cwd: None,
                    });
                }
                break_run = false;
            }
            Some("tool_call" | "tool_call_update") => break_run = true,
            // plan 及未知 sessionUpdate 类型（含 _x.ai/ 扩展）跳过且不打断流式连续性
            _ => {}
        }
    }
    msgs
}

/// Grok 的 `updates.jsonl` 是 UI 事件流；完整历史在同目录的
/// `chat_history.jsonl`。优先读取后者，避免 compact 后旧回合不在事件流窗口中。
pub(super) fn grok_history_path(updates_path: &Path) -> Option<PathBuf> {
    Some(updates_path.parent()?.join("chat_history.jsonl"))
}

pub(super) fn grok_history_text(content: &Value) -> Option<String> {
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                if let Value::String(s) = item {
                    return Some(s.clone());
                }
                let obj = item.as_object()?;
                (obj.get("type").and_then(Value::as_str) == Some("text")).then(|| {
                    obj.get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                })
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    let text = unwrap_prompt_tags(&text);
    (!text.is_empty()).then_some(text)
}

pub(super) fn parse_grok_history(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut messages = Vec::new();
    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let role = get_str(&value, "type");
        // 工具结果：并进发起调用的那条助手消息，按 tool_call_id 与调用配对
        if role == Some("tool_result") {
            let text = match value.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => grok_history_text(other).unwrap_or_else(|| other.to_string()),
                None => String::new(),
            };
            push_tool_result(
                &mut messages,
                vec![BlockDto {
                    kind: "tool_result".into(),
                    text,
                    tool_name: None,
                    is_error: false,
                    call_id: get_str(&value, "tool_call_id").map(String::from),
                }],
                None,
            );
            continue;
        }
        let is_user_prompt = role == Some("user")
            && value.get("prompt_index").is_some()
            && value.get("synthetic_reason").is_none();
        let is_assistant = role == Some("assistant");
        if !is_user_prompt && !is_assistant {
            continue;
        }
        let mut blocks: Vec<BlockDto> = grok_history_text(value.get("content").unwrap_or(&Value::Null))
            .map(text_block)
            .into_iter()
            .collect();
        // 助手的工具调用（Grok 1.0.62：{id, name, arguments: JSON 串}；兼容 OpenAI 式 function 包一层）。
        // 以前只取文字，Grok 对话里读文件 / 改文件 / 跑命令一条都看不到（2026-10-20 Windows 实跑发现，与平台无关）
        if is_assistant {
            for call in value.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                let f = call.get("function").unwrap_or(call);
                let Some(name) = get_str(f, "name") else {
                    continue;
                };
                blocks.push(BlockDto {
                    kind: "tool_use".into(),
                    text: stringify_payload(f.get("arguments")),
                    tool_name: Some(name.into()),
                    is_error: false,
                    call_id: get_str(call, "id").map(String::from),
                });
            }
        }
        if blocks.is_empty() {
            continue;
        }
        messages.push(ChatMessageDto {
            role: if is_user_prompt { "user" } else { "assistant" }.into(),
            blocks,
            timestamp: None,
            usage: None,
            id: None,
            cwd: None,
        });
    }
    messages
}

pub(super) fn grok_history_messages(path: &Path) -> Option<Vec<ChatMessageDto>> {
    let history = grok_history_path(path)?;
    let bytes = read_session_bytes(&history)?;
    let mut messages = parse_grok_history(&to_lines(&String::from_utf8_lossy(
        &bytes,
    )));
    // chat_history.jsonl 不带时间，回合起止时间取自同目录的事件流（读不到就不标，只是少一个「已工作 X 秒」）
    if let Some(updates) = read_session_bytes(path) {
        let spans = grok_turn_spans(&to_lines(&String::from_utf8_lossy(&updates)));
        stamp_grok_history(&mut messages, &spans);
    }
    Some(messages)
}

/// 事件流里每个回合的（开始, 结束）时间：一段连续的 user_message_chunk 开一个回合，之后任何事件都把结束往后推
pub(super) fn grok_turn_spans(lines: &[String]) -> Vec<(String, String)> {
    let mut spans: Vec<(String, String)> = Vec::new();
    let mut prev_user = false;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(update) = v.get("params").and_then(|p| p.get("update")) else {
            continue;
        };
        let Some(ts) = grok_time(&v) else {
            continue;
        };
        let is_user = get_str(update, "sessionUpdate") == Some("user_message_chunk");
        match spans.last_mut() {
            Some(last) if !(is_user && !prev_user) => last.1 = ts,
            _ if is_user => spans.push((ts.clone(), ts)),
            _ => {}
        }
        prev_user = is_user;
    }
    spans
}

/// 用户提问盖回合开始时间、每个回合最后一条助手消息盖结束时间（对话页「已工作 X」只看这两头）。
/// 事件流有窗口（compact 后旧回合不在里面），所以从尾部往前对齐
pub(super) fn stamp_grok_history(messages: &mut [ChatMessageDto], spans: &[(String, String)]) {
    let users: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == "user")
        .map(|(i, _)| i)
        .collect();
    let n = users.len().min(spans.len());
    for k in 0..n {
        let (start, end) = &spans[spans.len() - n + k];
        let ui = users[users.len() - n + k];
        let next = users.get(users.len() - n + k + 1).copied().unwrap_or(messages.len());
        messages[ui].timestamp = Some(start.clone());
        if let Some(last) = (ui + 1..next).rev().find(|i| messages[*i].role == "assistant") {
            messages[last].timestamp = Some(end.clone());
        }
    }
}

/// grok 尾部状态：从后往前找最近的已知事件。
/// user_message_chunk = 用户刚发消息（回合进行中）→ working；
/// agent_message_chunk = 助手输出 → 文本问句收尾判 confirm，否则 done；
/// tool_call/tool_call_update = 工具回合进行中 → working。
pub(super) fn grok_tail_state(lines: &[String]) -> &'static str {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(update) = v.get("params").and_then(|p| p.get("update")) else {
            continue;
        };
        match get_str(update, "sessionUpdate") {
            Some("user_message_chunk") => return "working",
            Some("agent_message_chunk") => {
                let text = grok_content_text(update).unwrap_or_default();
                return if ends_with_question(&text) {
                    "confirm"
                } else {
                    "done"
                };
            }
            Some("tool_call") | Some("tool_call_update") => return "working",
            _ => continue,
        }
    }
    "unknown"
}
