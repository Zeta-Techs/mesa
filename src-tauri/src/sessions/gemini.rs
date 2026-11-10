use super::*;

// ===== Gemini CLI =====

/// slug → 项目绝对路径映射。绝不自己推导 slug：
/// 优先 ~/.gemini/projects.json（{"projects": {"<abs path>": "<slug>"}}）反向，
/// 再以各 slug 目录里的 .project_root 标记文件兜底
pub(super) fn gemini_slug_map(tmp_root: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some(cfg) = tmp_root.parent() {
        if let Ok(text) = fs::read_to_string(cfg.join("projects.json")) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(projects) = v.get("projects").and_then(|p| p.as_object()) {
                    for (path, slug) in projects {
                        if let Some(slug) = slug.as_str() {
                            map.insert(slug.to_string(), path.clone());
                        }
                    }
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(tmp_root) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let Some(slug) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            if map.contains_key(&slug) {
                continue;
            }
            if let Ok(root) = fs::read_to_string(p.join(".project_root")) {
                let root = root.trim().to_string();
                if !root.is_empty() {
                    map.insert(slug, root);
                }
            }
        }
    }
    map
}

/// content 可能是字符串或 parts 数组（[{text}]）
pub(super) fn gemini_content_text(c: &Value) -> Option<String> {
    let text = match c {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
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

/// Gemini 开会话时先记一条 type=user 的环境上下文（`<session_context>`，hook 注入的是
/// `<hook_context>`），不是用户说的话；CLI 自己的界面也按这两个前缀跳过。
pub(super) fn gemini_is_injected_context(v: &Value) -> bool {
    gemini_display_text(v).is_some_and(|t| {
        let head = t.trim_start();
        head.starts_with("<session_context>") || head.starts_with("<hook_context>")
    })
}

/// 界面文字：有 displayContent 用它（content 里可能是展开后的 @文件），否则用 content
pub(super) fn gemini_display_text(v: &Value) -> Option<String> {
    v.get("displayContent")
        .and_then(gemini_content_text)
        .or_else(|| v.get("content").and_then(gemini_content_text))
}

/// 用户真正说的话：注入的上下文、只有工具结果（functionResponse）的记录都返回 None
pub(super) fn gemini_user_text(v: &Value) -> Option<String> {
    if gemini_is_injected_context(v) {
        None
    } else {
        gemini_display_text(v)
    }
}

pub(super) fn gemini_usage(t: &Value) -> TokenUsageDto {
    let num = |k: &str| t.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    TokenUsageDto {
        // input 含缓存读（Gemini API 口径），拆成没命中的部分（同 usage.rs）
        input: crate::usage::uncached_input(num("input"), num("cached"), 0),
        output: num("output"),
        cache_read: num("cached"),
        cache_write: 0, // gemini 的 tokens 没有写缓存概念
    }
}

/// 列表标题候选：空白或 XML 标签开头（注入内容）的不算
pub(super) fn title_from_text(text: &str) -> Option<String> {
    usable_title(text)
}

pub(super) fn gemini_file_meta(
    path: &Path,
    alive: bool,
    slug_to_path: &HashMap<String, String>,
) -> Option<SessionMetaDto> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let (mut session_id, mut created, mut title, mut summary, mut directories) =
        (None, None, None, None, None);
    for line in head.iter().chain(&tail) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // $set 控制记录：补丁元数据，summary 可作标题（后出现覆盖先出现）
        if let Some(set) = v.get("$set") {
            if let Some(s) = get_str(set, "summary") {
                if let Some(candidate) = usable_title(s) {
                    summary = Some(candidate);
                }
            }
            continue;
        }
        // 首行 metadata（无 type 字段）
        if v.get("type").is_none() {
            if session_id.is_none() {
                session_id = get_str(&v, "sessionId").map(String::from);
            }
            if created.is_none() {
                created = get_str(&v, "startTime").map(String::from);
            }
            if directories.is_none() {
                directories = v
                    .get("directories")
                    .and_then(|d| d.as_array())
                    .and_then(|a| a.first())
                    .and_then(|x| x.as_str())
                    .map(String::from);
            }
            if summary.is_none() {
                summary = get_str(&v, "summary").and_then(usable_title);
            }
            continue;
        }
        if title.is_none() && get_str(&v, "type") == Some("user") {
            if let Some(t) = gemini_user_text(&v) {
                title = title_from_text(&t);
            }
        }
    }
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let token_usage = tail_src.iter().rev().find_map(|line| {
        let v = serde_json::from_str::<Value>(line).ok()?;
        if get_str(&v, "type") == Some("gemini") {
            v.get("tokens").map(gemini_usage)
        } else {
            None
        }
    });
    // 项目归属：slug 映射 → metadata.directories。活会话都拿不到就跳过（不猜 slug）；
    // pin 快照允许占位，apply_meta 再用 session_meta.project_path 回填。
    let slug = path
        .parent()?
        .parent()?
        .file_name()?
        .to_string_lossy()
        .into_owned();
    let project_path = match slug_to_path.get(&slug).cloned().or(directories) {
        Some(p) => p,
        None if !alive => "已固定".into(),
        None => return None,
    };
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some(SessionMetaDto {
        agent: "gemini".into(),
        session_id,
        project_path: project_path.clone(),
        cwd: Some(project_path.clone()),
        title: summary.or(title),
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
        relay: Default::default(),
        title_by_user: false,
    })
}

/// Gemini 偶尔会为同一个 sessionId 留下多个 chats/*.jsonl（例如重启/恢复时重写启动记录）。
/// 会话主键在 Mesa 中是 agent + session_id，因此列表只能保留最新落盘文件作为代表。
pub(super) fn dedupe_gemini_sessions(metas: Vec<SessionMetaDto>) -> Vec<SessionMetaDto> {
    let mut latest: HashMap<String, SessionMetaDto> = HashMap::new();
    for meta in metas {
        let replace = latest.get(&meta.session_id).is_none_or(|current| {
            meta.updated_at > current.updated_at
                || (meta.updated_at == current.updated_at && meta.file_path > current.file_path)
        });
        if replace {
            latest.insert(meta.session_id.clone(), meta);
        }
    }
    latest.into_values().collect()
}

/// 同一 id 会重记（先记正文、工具调用落定后带 toolCalls 再记一遍）：CLI 按 id 原位覆盖，
/// 这里同样原位替换，否则聊天层同一段回复出现两次；新记录为空则删掉旧的
pub(super) fn gemini_upsert(
    msgs: &mut Vec<ChatMessageDto>,
    ids: &mut Vec<Option<String>>,
    id: Option<String>,
    msg: Option<ChatMessageDto>,
) {
    let pos = id
        .as_deref()
        .and_then(|key| ids.iter().position(|x| x.as_deref() == Some(key)));
    match (pos, msg) {
        (Some(i), Some(m)) => msgs[i] = m,
        (Some(i), None) => {
            msgs.remove(i);
            ids.remove(i);
        }
        (None, Some(m)) => {
            msgs.push(m);
            ids.push(id);
        }
        (None, None) => {}
    }
}

pub(super) fn parse_gemini(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs: Vec<ChatMessageDto> = Vec::new();
    let mut ids: Vec<Option<String>> = Vec::new(); // 与 msgs 平行，供 $rewindTo 定位
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // $rewindTo 控制记录：删除该消息 id 起的全部消息
        if let Some(rewind) = get_str(&v, "$rewindTo") {
            if let Some(pos) = ids.iter().position(|id| id.as_deref() == Some(rewind)) {
                msgs.truncate(pos);
                ids.truncate(pos);
            }
            continue;
        }
        if v.get("$set").is_some() {
            continue;
        }
        let ts = get_str(&v, "timestamp").map(String::from);
        let id = get_str(&v, "id").map(String::from);
        match get_str(&v, "type") {
            Some("user") => {
                // 注入的环境上下文、只有工具结果（functionResponse）的记录都不进对话视图
                let msg = gemini_user_text(&v).map(|text| ChatMessageDto {
                    role: "user".into(),
                    blocks: vec![text_block(text)],
                    timestamp: ts,
                    usage: None,
                    id: id.clone(),
                    cwd: None,
                });
                gemini_upsert(&mut msgs, &mut ids, id, msg);
            }
            Some("gemini") => {
                let mut blocks = Vec::new();
                if let Some(text) = v.get("content").and_then(gemini_content_text) {
                    blocks.push(text_block(text));
                }
                if let Some(calls) = v.get("toolCalls").and_then(|t| t.as_array()) {
                    for c in calls {
                        let call = get_str(c, "id").map(String::from);
                        blocks.push(BlockDto {
                            kind: "tool_use".into(),
                            text: c.get("args").map(|a| a.to_string()).unwrap_or_default(),
                            tool_name: get_str(c, "name").map(String::from),
                            is_error: false,
                            call_id: call.clone(),
                        });
                        if let Some(result) = c.get("result") {
                            blocks.push(BlockDto {
                                kind: "tool_result".into(),
                                text: stringify_payload(Some(result)),
                                tool_name: None,
                                is_error: false,
                                call_id: call,
                            });
                        }
                    }
                }
                let msg = (!blocks.is_empty()).then(|| ChatMessageDto {
                    role: "assistant".into(),
                    blocks,
                    timestamp: ts,
                    usage: v.get("tokens").map(gemini_usage),
                    id: id.clone(),
                    cwd: None,
                });
                gemini_upsert(&mut msgs, &mut ids, id, msg);
            }
            _ => {} // metadata / info / error / warning 不进对话视图
        }
    }
    msgs
}
