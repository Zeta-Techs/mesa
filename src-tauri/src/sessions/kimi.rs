use super::*;

// ===== Kimi Code（新版 kimi-code + 旧版 kimi-cli，统一 agent id "kimi"） =====

/// wire/context 记录的时间是 epoch 毫秒（容忍字符串形式）
pub(super) fn kimi_time(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => n.as_u64().map(|ms| iso_from_unix(ms / 1000)),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// content 可能是字符串或 parts 数组 [{type:"text",text},{type:"think",think}]
pub(super) fn kimi_content_text(c: &Value) -> Option<String> {
    let text = match c {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter(|p| get_str(p, "type") != Some("think"))
            .filter_map(|p| get_str(p, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

pub(super) fn kimi_content_blocks(c: &Value) -> Vec<BlockDto> {
    let mut blocks = Vec::new();
    match c {
        Value::String(s) => {
            if !s.trim().is_empty() {
                blocks.push(text_block(s.clone()));
            }
        }
        Value::Array(arr) => {
            for p in arr {
                match get_str(p, "type") {
                    Some("think") => {
                        if let Some(t) = get_str(p, "think") {
                            blocks.push(BlockDto {
                                kind: "thinking".into(),
                                text: t.to_string(),
                                tool_name: None,
                                is_error: false,
                                call_id: None,
                            });
                        }
                    }
                    _ => {
                        if let Some(t) = get_str(p, "text") {
                            blocks.push(text_block(t.to_string()));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    blocks
}

/// toolCalls/tool_calls（两个变体拼写不同）→ tool_use 块；arguments 是 JSON 字符串原样保留
pub(super) fn kimi_tool_call_blocks(m: &Value) -> Vec<BlockDto> {
    let calls = m
        .get("toolCalls")
        .or_else(|| m.get("tool_calls"))
        .and_then(|t| t.as_array());
    let Some(calls) = calls else {
        return Vec::new();
    };
    calls
        .iter()
        .map(|c| {
            let f = c.get("function");
            BlockDto {
                kind: "tool_use".into(),
                text: f
                    .and_then(|f| get_str(f, "arguments"))
                    .unwrap_or("")
                    .to_string(),
                tool_name: f.and_then(|f| get_str(f, "name")).map(String::from),
                is_error: false,
                call_id: get_str(c, "id").map(String::from),
            }
        })
        .collect()
}

pub(super) fn kimi_usage(u: &Value) -> TokenUsageDto {
    let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    // inputOther 是非缓存输入；缓存读/写单列，与 Claude 口径一致
    TokenUsageDto {
        input: num("inputOther"),
        output: num("output"),
        cache_read: num("inputCacheRead"),
        cache_write: num("inputCacheCreation"),
    }
}

/// 新版 kimi-code：session_index.jsonl 给 (sessionId, sessionDir, workDir)，
/// 会话本体在 sessionDir/agents/main/wire.jsonl（agents/agent-* 是子 agent，不读）
pub(super) fn kimi_wire_file_meta(
    path: &Path,
    alive: bool,
    session_id: &str,
    project_path: String,
    state: Option<&Value>,
) -> Option<SessionMetaDto> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let (mut created, mut title) = (None, None);
    for line in &head {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match get_str(&v, "type") {
            Some("metadata") => {
                if created.is_none() {
                    created = v.get("created_at").and_then(kimi_time);
                }
            }
            Some("turn.prompt") => {
                if title.is_none()
                    && v.get("origin").and_then(|o| get_str(o, "kind")) == Some("user")
                {
                    if let Some(t) = v.get("input").and_then(kimi_content_text) {
                        title = title_from_text(&t);
                    }
                }
            }
            _ => {}
        }
    }
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let token_usage = tail_src.iter().rev().find_map(|line| {
        let v = serde_json::from_str::<Value>(line).ok()?;
        if get_str(&v, "type") == Some("usage.record") {
            v.get("usage").map(kimi_usage)
        } else {
            None
        }
    });
    // 标题以 state.json 为准（CLI 自己维护，含 AI 起题），否则首条用户输入
    let state_title = state
        .and_then(|s| get_str(s, "title"))
        .and_then(usable_title);
    if created.is_none() {
        created = state.and_then(|s| s.get("createdAt")).and_then(kimi_time);
    }
    Some(SessionMetaDto {
        agent: "kimi".into(),
        session_id: session_id.to_string(),
        project_path: project_path.clone(),
        cwd: Some(project_path.clone()),
        title: state_title.or(title),
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage,
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
    })
}

pub(super) fn parse_kimi(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs: Vec<ChatMessageDto> = Vec::new();
    let mut last_usage = None;
    let mut last_prompt: Option<String> = None; // 用于去掉 append_message 对 prompt 的回显
                                                // 新协议里 assistant 的输出走 append_loop_event 流式事件；cur 是当前 step 打开的 assistant 消息
    let mut cur: Option<usize> = None;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ts = v.get("time").and_then(kimi_time);
        match get_str(&v, "type") {
            Some("turn.prompt") => {
                cur = None;
                if v.get("origin").and_then(|o| get_str(o, "kind")) != Some("user") {
                    continue; // slash 命令等非用户来源不进对话
                }
                if let Some(text) = v.get("input").and_then(kimi_content_text) {
                    msgs.push(ChatMessageDto {
                        role: "user".into(),
                        blocks: vec![text_block(text.clone())],
                        timestamp: ts,
                        usage: None,
                        id: None,
                        cwd: None,
                    });
                    last_prompt = Some(text);
                }
            }
            Some("context.append_loop_event") => {
                let Some(e) = v.get("event") else {
                    continue;
                };
                match get_str(e, "type") {
                    // 一个 step = 一次 LLM 响应 = 一条 assistant 消息
                    Some("step.begin") => {
                        msgs.push(ChatMessageDto {
                            role: "assistant".into(),
                            blocks: Vec::new(),
                            timestamp: ts,
                            usage: None,
                            id: None,
                            cwd: None,
                        });
                        cur = Some(msgs.len() - 1);
                    }
                    Some("content.part") => {
                        let Some(i) = cur else { continue };
                        let Some(p) = e.get("part") else { continue };
                        match get_str(p, "type") {
                            Some("think") => {
                                if let Some(t) = get_str(p, "think") {
                                    msgs[i].blocks.push(BlockDto {
                                        kind: "thinking".into(),
                                        text: t.to_string(),
                                        tool_name: None,
                                        is_error: false,
                                        call_id: None,
                                    });
                                }
                            }
                            _ => {
                                if let Some(t) = get_str(p, "text") {
                                    msgs[i].blocks.push(text_block(t.to_string()));
                                }
                            }
                        }
                    }
                    // args 是对象（不同于 append_message 的 JSON 字符串）
                    Some("tool.call") => {
                        let Some(i) = cur else { continue };
                        msgs[i].blocks.push(BlockDto {
                            kind: "tool_use".into(),
                            text: e.get("args").map(|a| a.to_string()).unwrap_or_default(),
                            tool_name: get_str(e, "name").map(String::from),
                            is_error: false,
                            call_id: None,
                        });
                    }
                    Some("tool.result") => {
                        let r = e.get("result");
                        let text = {
                            let via_output = stringify_payload(r.and_then(|r| r.get("output")));
                            if via_output.is_empty() {
                                stringify_payload(r)
                            } else {
                                via_output
                            }
                        };
                        let block = BlockDto {
                            kind: "tool_result".into(),
                            text,
                            tool_name: None,
                            is_error: false,
                            call_id: None,
                        };
                        match cur {
                            Some(i) => msgs[i].blocks.push(block),
                            None => push_tool_result(&mut msgs, vec![block], ts),
                        }
                    }
                    Some("step.end") => {
                        if let Some(i) = cur.take() {
                            if let Some(u) = e.get("usage").map(kimi_usage) {
                                msgs[i].usage = Some(u);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Some("context.append_message") => {
                let Some(m) = v.get("message") else {
                    continue;
                };
                match get_str(m, "role") {
                    Some("user") => {
                        // 注入内容（system-reminder 等）跳过
                        let kind = m.get("origin").and_then(|o| get_str(o, "kind"));
                        if kind.is_some() && kind != Some("user") {
                            continue;
                        }
                        let Some(text) = m.get("content").and_then(kimi_content_text) else {
                            continue;
                        };
                        if last_prompt.take().as_deref() == Some(text.as_str()) {
                            continue; // turn.prompt 的回显，已发过
                        }
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
                        let mut blocks =
                            kimi_content_blocks(m.get("content").unwrap_or(&Value::Null));
                        blocks.extend(kimi_tool_call_blocks(m));
                        if blocks.is_empty() {
                            continue;
                        }
                        msgs.push(ChatMessageDto {
                            role: "assistant".into(),
                            blocks,
                            timestamp: ts,
                            usage: None,
                            id: None,
                            cwd: None,
                        });
                    }
                    Some("tool") => {
                        let text = m
                            .get("content")
                            .and_then(kimi_content_text)
                            .unwrap_or_default();
                        push_tool_result(
                            &mut msgs,
                            vec![BlockDto {
                                kind: "tool_result".into(),
                                text,
                                tool_name: None,
                                is_error: false,
                                call_id: None,
                            }],
                            ts,
                        );
                    }
                    _ => {}
                }
            }
            Some("usage.record") => {
                if let Some(u) = v.get("usage").map(kimi_usage) {
                    last_usage = Some(u);
                }
            }
            _ => {}
        }
    }
    if let Some(u) = last_usage {
        if let Some(m) = msgs.iter_mut().rev().find(|m| m.role == "assistant") {
            if m.usage.is_none() {
                m.usage = Some(u);
            }
        }
    }
    // step.begin 后没有任何内容的空 assistant 消息（被中断的 step）不出现在视图里
    msgs.retain(|m| !m.blocks.is_empty() || m.usage.is_some());
    msgs
}

/// 旧版 kimi-cli：~/.kimi/sessions/<md5(workDir)>/<uuid>/context.jsonl，
/// bucket → 项目路径靠 kimi.json 的 work_dirs[].path 逐个 md5 反查
pub(super) fn kimi_workdir_buckets(kimi_json: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(text) = fs::read_to_string(kimi_json) else {
        return map;
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return map;
    };
    if let Some(dirs) = v.get("work_dirs").and_then(|d| d.as_array()) {
        for d in dirs {
            if let Some(path) = get_str(d, "path") {
                let bucket = format!("{:x}", md5::compute(path.as_bytes()));
                map.insert(bucket, path.to_string());
            }
        }
    }
    map
}

pub(super) fn kimi_legacy_file_meta(
    path: &Path,
    alive: bool,
    session_id: &str,
    project_path: String,
    state: Option<&Value>,
) -> Option<SessionMetaDto> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let mut title = None;
    for line in &head {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if get_str(&v, "role") == Some("user") {
            if let Some(t) = v.get("content").and_then(kimi_content_text) {
                title = title_from_text(&t);
                break;
            }
        }
    }
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let token_usage = tail_src.iter().rev().find_map(|line| {
        let v = serde_json::from_str::<Value>(line).ok()?;
        if get_str(&v, "role") == Some("_usage") {
            kimi_legacy_usage(&v)
        } else {
            None
        }
    });
    let state_title = state
        .and_then(|s| get_str(s, "title"))
        .and_then(usable_title);
    let created = state.and_then(|s| s.get("createdAt")).and_then(kimi_time);
    Some(SessionMetaDto {
        agent: "kimi".into(),
        session_id: session_id.to_string(),
        project_path: project_path.clone(),
        cwd: Some(project_path.clone()),
        title: state_title.or(title),
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage,
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
    })
}

/// 旧版 _usage 记录是累计 token 数；字段位置未核实，usage 对象或 content JSON 字符串都试
pub(super) fn kimi_legacy_usage(v: &Value) -> Option<TokenUsageDto> {
    let u = v.get("usage").cloned().or_else(|| {
        v.get("content")
            .and_then(|c| c.as_str())
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
    })?;
    let num = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| u.get(*k).and_then(|x| x.as_u64()))
            .unwrap_or(0)
    };
    Some(TokenUsageDto {
        input: num(&["input_tokens", "prompt_tokens"]),
        output: num(&["output_tokens", "completion_tokens"]),
        cache_read: num(&["cached_tokens", "cache_read"]),
        cache_write: num(&["cache_write"]),
    })
}

pub(super) fn parse_kimi_legacy(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    let mut last_usage = None;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let role = get_str(&v, "role").unwrap_or("");
        if role == "_usage" {
            if let Some(u) = kimi_legacy_usage(&v) {
                last_usage = Some(u);
            }
            continue;
        }
        if role.starts_with('_') {
            continue; // 内部记录不进对话
        }
        match role {
            "user" => {
                if let Some(text) = v.get("content").and_then(kimi_content_text) {
                    msgs.push(ChatMessageDto {
                        role: "user".into(),
                        blocks: vec![text_block(text)],
                        timestamp: None,
                        usage: None,
                        id: None,
                        cwd: None,
                    });
                }
            }
            "assistant" => {
                let mut blocks = kimi_content_blocks(v.get("content").unwrap_or(&Value::Null));
                blocks.extend(kimi_tool_call_blocks(&v));
                if blocks.is_empty() {
                    continue;
                }
                msgs.push(ChatMessageDto {
                    role: "assistant".into(),
                    blocks,
                    timestamp: None,
                    usage: None,
                    id: None,
                    cwd: None,
                });
            }
            "tool" => {
                let text = v
                    .get("content")
                    .and_then(kimi_content_text)
                    .unwrap_or_default();
                push_tool_result(
                    &mut msgs,
                    vec![BlockDto {
                        kind: "tool_result".into(),
                        text,
                        tool_name: None,
                        is_error: false,
                        call_id: None,
                    }],
                    None,
                );
            }
            _ => {}
        }
    }
    if let Some(u) = last_usage {
        if let Some(m) = msgs.iter_mut().rev().find(|m| m.role == "assistant") {
            if m.usage.is_none() {
                m.usage = Some(u);
            }
        }
    }
    msgs
}

/// 快照文件名丢失变体线索（wire.jsonl / context.jsonl 都变成 <id>.jsonl），
/// 按内容首行判别：新版 wire 记录带 type 字段，旧版 context 记录顶层是 role
pub(super) fn kimi_looks_like_wire(lines: &[String]) -> bool {
    lines
        .iter()
        .find_map(|l| serde_json::from_str::<Value>(l).ok())
        .map_or(false, |v| v.get("type").is_some())
}
