use super::*;

// ===== Codex CLI =====

pub(super) fn codex_message_text(p: &Value) -> Option<String> {
    if get_str(p, "type") != Some("message") {
        return None;
    }
    let parts = p.get("content")?.as_array()?;
    let text = parts
        .iter()
        .filter_map(|c| match get_str(c, "type") {
            Some("input_text") | Some("output_text") => get_str(c, "text"),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Codex 推理条目里看得见的字：有摘要（官方模型的 `**小标题**` 摘要）用摘要，没有用原始推理（第三方模型）；
/// 只有加密内容的返回 None
pub(super) fn codex_reasoning_text(p: &Value) -> Option<String> {
    let collect = |key: &str| {
        p.get(key)
            .and_then(|v| v.as_array())
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|c| get_str(c, "text"))
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
            .unwrap_or_default()
    };
    let summary = collect("summary");
    let text = if summary.is_empty() { collect("content") } else { summary };
    (!text.is_empty()).then_some(text)
}

/** Codex 会把工作区规则/导入历史作为 user response_item 写入会话；这类上下文不是用户对话，不能展示在聊天层。
 *  中途换权限 / 目录时它还会再补一条 `<environment_context>`（2026-10-26 审查：显示成了一条用户气泡） */
pub(crate) fn is_injected_context_message(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("# AGENTS.md")
        || trimmed.starts_with("\\# AGENTS.md")
        || trimmed.starts_with("<environment_context>")
        || trimmed.starts_with("<user_instructions>")
        || trimmed.starts_with("The following is the Codex agent history")
        || trimmed.starts_with("The following is the Claude Code history")
}

pub(super) fn codex_token_usage(v: &Value) -> Option<TokenUsageDto> {
    if get_str(v, "type") != Some("event_msg") {
        return None;
    }
    let p = v.get("payload")?;
    if get_str(p, "type") != Some("token_count") {
        return None;
    }
    let t = p.get("info")?.get("total_token_usage")?;
    let num = |k: &str| t.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    Some(TokenUsageDto {
        // input_tokens 含缓存读、output_tokens 含推理（实机 total_tokens = input + output）：拆缓存、推理不另加
        input: crate::usage::uncached_input(num("input_tokens"), num("cached_input_tokens"), 0),
        output: num("output_tokens"),
        cache_read: num("cached_input_tokens"),
        cache_write: num("cache_write_input_tokens"),
    })
}

/// 聊天消息上挂的用量：最后一次请求（last_token_usage），口径同别家——input 只算没命中缓存的部分、
/// 命中的记 cache_read（codex 的 input_tokens 已经含 cached_input_tokens）。聊天层上下文圆环取
/// 「input + cache」= 这一次请求塞进上下文的量。原先挂的是整场累计（total），会话一长就超过窗口，
/// 圆环一下满到 100%（2026-10-19 用户截图：1.1M / 1M；codex /status 写 40.9K / 996K）。
/// 会话列表的整场用量仍走 codex_token_usage（累计）。旧版没有 last_token_usage 就不挂
pub(super) fn codex_last_request_usage(v: &Value) -> Option<TokenUsageDto> {
    if get_str(v, "type") != Some("event_msg") {
        return None;
    }
    let p = v.get("payload")?;
    if get_str(p, "type") != Some("token_count") {
        return None;
    }
    let t = p.get("info")?.get("last_token_usage")?;
    let num = |k: &str| t.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let cached = num("cached_input_tokens");
    Some(TokenUsageDto {
        input: num("input_tokens").saturating_sub(cached),
        // output_tokens 已含 reasoning_output_tokens，不另加
        output: num("output_tokens"),
        cache_read: cached,
        cache_write: num("cache_write_input_tokens"),
    })
}

/// 返回值附带 forked_from_id（resume/fork 链的父线程 id，可能不存在），供扫描时合并链
pub(super) fn codex_file_meta(
    path: &Path,
    alive: bool,
    archived: bool,
) -> Option<(SessionMetaDto, Option<String>)> {
    // Codex 开头的 user_instructions 块可能很大，头部放宽到 256KB 才更常拿到真实首条提问。
    // 归档 zst 懒解压（2026-10-16）：只读头窗、不解剩余流——尾窗只为 token_usage，
    // 归档会话给 None，换取冷启动不整流解码归档
    let archived_lazy = archived && path.extension().and_then(|e| e.to_str()) == Some("zst");
    let (head, tail) = if archived_lazy {
        (read_head_only(path, 256 * 1024)?, Vec::new())
    } else {
        read_head_tail(path, 256 * 1024)?
    };
    let (mut cwd, mut created, mut session_id, mut version, mut title) =
        (None, None, None, None, None);
    let mut forked_from_id = None;
    // rollout 元信息的 model_provider：恢复会话时按它挑兼容 profile（"ccode" = 内联 provider）
    let mut provider = None;
    for line in &head {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if created.is_none() {
            created = get_str(&v, "timestamp").map(String::from);
        }
        if get_str(&v, "type") == Some("session_meta") {
            if let Some(p) = v.get("payload") {
                cwd = get_str(p, "cwd").map(String::from);
                session_id = get_str(p, "id")
                    .or_else(|| get_str(p, "session_id"))
                    .map(String::from);
                version = get_str(p, "cli_version").map(String::from);
                forked_from_id = get_str(p, "forked_from_id").map(String::from);
                provider = get_str(p, "model_provider").map(String::from);
                if let Some(t) = get_str(p, "timestamp") {
                    created = Some(t.to_string());
                }
            }
        }
        if title.is_none() && get_str(&v, "type") == Some("response_item") {
            if let Some(p) = v.get("payload") {
                if get_str(p, "role") == Some("user") {
                    if let Some(t) = codex_message_text(p) {
                        let t = t.trim();
                        // 跳过注入的指令块和粘贴的导出历史，取第一条真实提问作标题
                        if !t.starts_with('<')
                            && !is_injected_context_message(t)
                            && !t.starts_with("The following is the ")
                        {
                            title = usable_title(t);
                        }
                    }
                }
            }
        }
    }
    // 归档懒解压路径没有尾窗：token_usage 宁缺毋滥给 None（head 里翻出来的是
    // 会话中段的旧计数，不是最终值，展示出来是错数据）
    let token_usage = if archived_lazy {
        None
    } else {
        // 小文件全在头部、tail 为空，此时从头部找最后一条 token_count
        let tail_src = if tail.is_empty() { &head } else { &tail };
        tail_src.iter().rev().find_map(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|v| codex_token_usage(&v))
        })
    };
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some((
        SessionMetaDto {
            agent: "codex".into(),
            session_id,
            project_path: cwd.clone().unwrap_or_default(),
            cwd,
            title,
            created_at: created,
            updated_at: mtime_iso(path),
            file_path: path.to_string_lossy().into_owned(),
            token_usage,
            cli_version: version,
            pinned: false,
            archived,
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
            provider,
            profile_id: None,
            forked_from: None,
            reader: false,
            reader_pdf: None,
            step_meta: Default::default(),
            title_by_user: false,
        },
        forked_from_id,
    ))
}

pub(super) fn parse_codex(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    let mut legacy = Vec::new();
    let mut has_response_message = false;
    let mut last_usage = None;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ts = get_str(&v, "timestamp").map(String::from);
        match get_str(&v, "type") {
            Some("response_item") => {
                let Some(p) = v.get("payload") else {
                    continue;
                };
                match get_str(p, "type") {
                    Some("message") => {
                        let role = get_str(p, "role").unwrap_or("");
                        if role != "user" && role != "assistant" {
                            continue; // developer/system 指令不进对话视图
                        }
                        if let Some(text) = codex_message_text(p) {
                            if role == "user" && is_injected_context_message(&text) {
                                continue;
                            }
                            has_response_message = true;
                            msgs.push(ChatMessageDto {
                                role: role.into(),
                                blocks: vec![text_block(text)],
                                timestamp: ts,
                                usage: None,
                                id: get_str(p, "id").map(String::from),
                                cwd: None,
                            });
                        }
                    }
                    Some("function_call") | Some("custom_tool_call") => msgs.push(ChatMessageDto {
                        role: "assistant".into(),
                        blocks: vec![BlockDto {
                            kind: "tool_use".into(),
                            text: get_str(p, "arguments")
                                .or_else(|| get_str(p, "input"))
                                .unwrap_or("")
                                .to_string(),
                            tool_name: get_str(p, "name").map(String::from),
                            is_error: false,
                            call_id: get_str(p, "call_id").map(String::from),
                        }],
                        timestamp: ts,
                        usage: None,
                        id: get_str(p, "id").map(String::from),
                        cwd: None,
                    }),
                    // 思考：别家的思考都进「思考」过程行，Codex 原先整条丢了（2026-10-26 审查：本机 71 条有正文的推理一条没显示）
                    Some("reasoning") => {
                        if let Some(text) = codex_reasoning_text(p) {
                            msgs.push(ChatMessageDto {
                                role: "assistant".into(),
                                blocks: vec![BlockDto {
                                    kind: "thinking".into(),
                                    text,
                                    tool_name: None,
                                    is_error: false,
                                    call_id: None,
                                }],
                                timestamp: ts,
                                usage: None,
                                id: get_str(p, "id").map(String::from),
                                cwd: None,
                            });
                        }
                    }
                    Some("function_call_output") | Some("custom_tool_call_output") => {
                        let text = stringify_payload(p.get("output"));
                        push_tool_result(
                            &mut msgs,
                            vec![BlockDto {
                                kind: "tool_result".into(),
                                text,
                                tool_name: None,
                                is_error: false,
                                call_id: get_str(p, "call_id").map(String::from),
                            }],
                            ts,
                        );
                    }
                    _ => {}
                }
            }
            Some("event_msg") => {
                let Some(p) = v.get("payload") else {
                    continue;
                };
                match get_str(p, "type") {
                    // 旧格式兜底：新文件里它与 response_item 重复，只在没有 response_item 消息时采用
                    Some("user_message") | Some("agent_message") => {
                        if let Some(t) = get_str(p, "message") {
                            if get_str(p, "type") == Some("user_message")
                                && is_injected_context_message(t)
                            {
                                continue;
                            }
                            let role = if get_str(p, "type") == Some("user_message") {
                                "user"
                            } else {
                                "assistant"
                            };
                            legacy.push(ChatMessageDto {
                                role: role.into(),
                                blocks: vec![text_block(t.to_string())],
                                timestamp: ts,
                                usage: None,
                                id: None,
                                cwd: None,
                            });
                        }
                    }
                    Some("token_count") => {
                        if let Some(u) = codex_last_request_usage(&v) {
                            last_usage = Some(u);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    let mut msgs = if has_response_message { msgs } else { legacy };
    // 最后一次请求的用量挂在最后一条 assistant 消息上（聊天层上下文圆环读它）
    if let Some(u) = last_usage {
        if let Some(m) = msgs.iter_mut().rev().find(|m| m.role == "assistant") {
            if m.usage.is_none() {
                m.usage = Some(u);
            }
        }
    }
    msgs
}
