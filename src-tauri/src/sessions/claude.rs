use super::*;

// ===== Claude Code =====

/// 从 user 行提取标题候选；命令输出/meta 样式（XML 标签开头）不算
pub(super) fn claude_user_title(v: &Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr.iter().find_map(|b| {
            if get_str(b, "type") == Some("text") {
                get_str(b, "text").map(String::from)
            } else {
                None
            }
        })?,
        _ => return None,
    };
    usable_title(&text)
}

pub(super) fn claude_usage(u: &Value) -> TokenUsageDto {
    let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    TokenUsageDto {
        input: num("input_tokens"),
        output: num("output_tokens"),
        cache_read: num("cache_read_input_tokens"),
        cache_write: num("cache_creation_input_tokens"),
    }
}

pub(super) fn claude_tool_result_text(b: &Value) -> String {
    match b.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|p| get_str(p, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        other => stringify_payload(other),
    }
}

pub(super) fn claude_file_meta(path: &Path, alive: bool) -> Option<SessionMetaDto> {
    claude_file_meta_lineage(path, alive).map(|(m, _)| m)
}

/// Claude 会话文件的接续关系（2026-10-21 实证，Claude 桌面版「继续」）：在旧对话上接着聊会新建
/// `<新id>.jsonl`，开头原样复制旧对话全部历史（行里 sessionId 仍是旧 id），之后的新内容才用新 id。
/// 文件名才是会话自己的 id；开头的旧 id 只说明「从哪条接续而来」。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct ClaudeLineage {
    /// 直接上游：第一条自身行之前最后出现的别的 sessionId（链式接续时不是最早那条）
    pub(crate) parent: Option<String>,
    /// 分出来的时刻：第一条带时间戳的自身行
    pub(crate) branch_at: Option<String>,
    /// 本文件最后一条带时间戳的行。不用 mtime：Claude 会往旧文件补写不带时间戳的标题行
    pub(crate) last_at: Option<String>,
    /// 分叉后用户问的第一句（分叉行的标题用它，否则跟原会话同名）
    pub(crate) own_title: Option<String>,
}

pub(crate) fn is_uuid_like(s: &str) -> bool {
    s.len() == 36
        && s.chars()
            .enumerate()
            .all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

pub(super) fn json_line_session_id(line: &[u8]) -> Option<&str> {
    const KEY: &[u8] = br#""sessionId":""#;
    let at = line.windows(KEY.len()).position(|w| w == KEY)? + KEY.len();
    let rest = &line[at..];
    let end = rest.iter().position(|&b| b == b'"')?;
    std::str::from_utf8(&rest[..end]).ok()
}

/// 流式找分叉点：只做字节查找，第一条自身行之前不解析 JSON
pub(super) fn claude_branch_info(path: &Path, own: &str) -> (Option<String>, Option<String>, Option<String>) {
    use std::io::BufRead;
    let Ok(f) = fs::File::open(path) else {
        return (None, None, None);
    };
    let mut reader = std::io::BufReader::new(f);
    let (mut parent, mut branch_at, mut own_title) = (None, None, None);
    let mut own_seen = 0usize;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Some(sid) = json_line_session_id(&buf) else { continue };
        if sid != own {
            if own_seen == 0 {
                parent = Some(sid.to_string());
            }
            continue;
        }
        own_seen += 1;
        let Ok(v) = serde_json::from_slice::<Value>(&buf) else { continue };
        if branch_at.is_none() {
            branch_at = get_str(&v, "timestamp").map(String::from);
        }
        if own_title.is_none()
            && get_str(&v, "type") == Some("user")
            && v.get("isSidechain").and_then(|x| x.as_bool()) != Some(true)
            && v.get("isMeta").and_then(|x| x.as_bool()) != Some(true)
        {
            own_title = claude_user_title(&v);
        }
        if (branch_at.is_some() && own_title.is_some()) || own_seen > 400 {
            break;
        }
    }
    (parent, branch_at, own_title)
}

pub(super) fn claude_file_meta_lineage(path: &Path, alive: bool) -> Option<(SessionMetaDto, ClaudeLineage)> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let (mut cwd, mut created, mut session_id, mut version) = (None, None, None, None);
    let (mut title, mut ai_title) = (None, None);
    // 顺着 head→tail 读到底，最后一个时间戳就是末行的（小文件整段落在 head、tail 为空）
    let mut last_at: Option<String> = None;
    for line in head.iter().chain(&tail) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(ts) = get_str(&v, "timestamp") {
            last_at = Some(ts.to_string());
        }
        if cwd.is_none() {
            cwd = get_str(&v, "cwd").map(String::from);
        }
        if created.is_none() {
            created = get_str(&v, "timestamp").map(String::from);
        }
        if session_id.is_none() {
            session_id = get_str(&v, "sessionId").map(String::from);
        }
        if version.is_none() {
            version = get_str(&v, "version").map(String::from);
        }
        if get_str(&v, "type") == Some("ai-title") {
            if let Some(t) = get_str(&v, "aiTitle") {
                if let Some(candidate) = usable_title(t) {
                    ai_title = Some(candidate); // 尾部后出现的有效标题覆盖先出现的
                }
            }
        }
        if title.is_none()
            && get_str(&v, "type") == Some("user")
            && v.get("isSidechain").and_then(|x| x.as_bool()) != Some(true)
            && v.get("isMeta").and_then(|x| x.as_bool()) != Some(true)
        {
            title = claude_user_title(&v);
        }
    }
    // 目录名是 sanitize 后的项目路径（有损），不解码；读不到 cwd 时原样兜底
    let project_path = cwd.clone().unwrap_or_else(|| {
        path.parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let content_id = session_id;
    // 真实 Claude 文件名就是会话 uuid；接续文件开头的 sessionId 是上游的，不能拿来当自己的 id
    let mut lineage = ClaudeLineage {
        last_at,
        ..Default::default()
    };
    let session_id = if is_uuid_like(&stem) {
        if content_id.as_deref().is_some_and(|c| c != stem) {
            let (parent, branch_at, own_title) = claude_branch_info(path, &stem);
            lineage.parent = parent.or(content_id);
            lineage.branch_at = branch_at;
            lineage.own_title = own_title;
        }
        stem
    } else {
        content_id.unwrap_or(stem)
    };
    let meta = SessionMetaDto {
        agent: "claude-code".into(),
        session_id,
        project_path: project_path.clone(),
        cwd: Some(project_path.clone()),
        title: ai_title.or(title),
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage: None, // Claude 的用量分散在每行，全量统计留给 P3
        cli_version: version,
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
    };
    Some((meta, lineage))
}

pub(super) fn tag_inner<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(&text[start..end])
}

/// Claude Code 把斜杠命令与 `!` 命令及其输出写成带标签的 user 行（2.1.x 起不再标 isMeta）：
/// `<command-name>/model</command-name><command-args>glm-5.2</command-args>`、
/// `<local-command-stdout>Set model to …\x1b[2m…</local-command-stdout>`、`<bash-input>` / `<bash-stdout>`。
/// 原样当用户气泡会把标签和 ANSI 一起露出来（2026-10-17 用户截图），这里拆成 command / command_output 块。
/// 返回 None = 不是命令行；Some(None) = 是命令行但没有可显示的内容（如空输出、caveat）。
pub(super) fn claude_command_block(text: &str) -> Option<Option<BlockDto>> {
    let t = text.trim_start();
    let block = |kind: &str, text: String| {
        Some(Some(BlockDto {
            kind: kind.into(),
            text,
            tool_name: None,
            is_error: false,
            call_id: None,
        }))
    };
    if t.starts_with("<command-name>") || t.starts_with("<command-message>") {
        let name = tag_inner(t, "<command-name>", "</command-name>")
            .map(str::trim)
            .unwrap_or("");
        let args = tag_inner(t, "<command-args>", "</command-args>")
            .map(str::trim)
            .unwrap_or("");
        if name.is_empty() {
            return Some(None);
        }
        let cmd = if args.is_empty() {
            name.to_string()
        } else {
            format!("{name} {args}")
        };
        return block("command", cmd);
    }
    if t.starts_with("<bash-input>") {
        let cmd = tag_inner(t, "<bash-input>", "</bash-input>").unwrap_or("").trim();
        return if cmd.is_empty() {
            Some(None)
        } else {
            block("command", format!("! {cmd}"))
        };
    }
    const OUTPUT_TAGS: [(&str, &str); 4] = [
        ("<local-command-stdout>", "</local-command-stdout>"),
        ("<local-command-stderr>", "</local-command-stderr>"),
        ("<bash-stdout>", "</bash-stdout>"),
        ("<bash-stderr>", "</bash-stderr>"),
    ];
    if OUTPUT_TAGS.iter().any(|(open, _)| t.starts_with(open)) {
        // 一行里可能同时带 stdout 与 stderr：都收进来
        let parts: Vec<String> = OUTPUT_TAGS
            .iter()
            .filter_map(|(open, close)| tag_inner(t, open, close))
            .map(|inner| {
                crate::updater::strip_ansi(inner)
                    .lines()
                    .map(str::trim_end)
                    .collect::<Vec<_>>()
                    .join("\n")
                    .trim()
                    .to_string()
            })
            .filter(|clean| !clean.is_empty())
            .collect();
        return if parts.is_empty() {
            Some(None)
        } else {
            block("command_output", parts.join("\n"))
        };
    }
    if t.starts_with("<local-command-caveat>") {
        return Some(None);
    }
    None
}

/// Claude 拒绝 / 打断工具时另写一条 user 文本「[Request interrupted by user for tool use]」：
/// 那是它自己的机读标记，不是用户说的话，当成气泡显示会冒充用户发言（2026-10-19 用户截图）。
/// 被拒的那一步已经在过程里标成「被拒绝」，这里直接丢掉。
pub(super) fn is_claude_interrupt_marker(text: &str) -> bool {
    let t = text.trim();
    t.eq_ignore_ascii_case("[Request interrupted by user]")
        || t.eq_ignore_ascii_case("[Request interrupted by user for tool use]")
}

/// Claude 会话文件里，`after_ms`（unix 毫秒）之后这一轮有没有收尾：被打断（拒绝工具 / Esc）返回 "interrupted"，
/// 正常写了 system/turn_duration 返回 "end_turn"，没有返回 None。只看尾部 64KB、时间早于 after_ms 的行就停
pub(crate) fn claude_turn_end_after(path: &Path, after_ms: i64) -> Option<&'static str> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    // 小文件整份在头窗里、尾窗为空
    let tail = if tail.is_empty() { head } else { tail };
    let mut ended = None;
    for line in tail.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(ts) = get_str(&v, "timestamp")
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.timestamp_millis())
        else {
            continue;
        };
        if ts < after_ms {
            break;
        }
        match get_str(&v, "type") {
            Some("system") if get_str(&v, "subtype") == Some("turn_duration") => {
                ended.get_or_insert("end_turn");
            }
            Some("user") => {
                let content = v.get("message").and_then(|m| m.get("content"));
                let interrupted = match content {
                    Some(Value::String(s)) => is_claude_interrupt_marker(s),
                    Some(Value::Array(arr)) => arr.iter().any(|b| {
                        get_str(b, "type") == Some("text") && get_str(b, "text").is_some_and(is_claude_interrupt_marker)
                    }),
                    _ => false,
                };
                if interrupted {
                    return Some("interrupted");
                }
            }
            _ => {}
        }
    }
    ended
}

/// 一条字符串内容的 Claude 用户 / 本地命令行：命令标签拆成 command / command_output 块，
/// 命令输出并进紧挨着的那条命令（聊天里一行「命令 → 结果」），其余是用户文本
pub(super) fn push_claude_user_string(
    msgs: &mut Vec<ChatMessageDto>,
    s: &str,
    ts: Option<String>,
    id: Option<String>,
) {
    if let Some(cmd) = claude_command_block(s) {
        let Some(block) = cmd else {
            return;
        };
        let joins = block.kind == "command_output"
            && msgs.last().is_some_and(|m: &ChatMessageDto| {
                m.role == "user" && m.blocks.last().is_some_and(|b| b.kind == "command")
            });
        if joins {
            msgs.last_mut().unwrap().blocks.push(block);
        } else {
            msgs.push(ChatMessageDto {
                role: "user".into(),
                blocks: vec![block],
                timestamp: ts,
                usage: None,
                id,
                cwd: None,
            });
        }
    } else if !s.trim().is_empty() && !is_claude_interrupt_marker(s) {
        msgs.push(ChatMessageDto {
            role: "user".into(),
            blocks: vec![text_block(s.to_string())],
            timestamp: ts,
            usage: None,
            id,
            cwd: None,
        });
    }
}

/// 图片附件的来源行（isMeta）：`[Image: source: /abs/path.png]`，一张图一个 text 块
pub(super) fn claude_image_sources(v: &Value) -> Option<Vec<String>> {
    let arr = v.get("message")?.get("content")?.as_array()?;
    let sources = arr
        .iter()
        .map(|b| {
            get_str(b, "text")?
                .trim()
                .strip_prefix("[Image: source: ")?
                .strip_suffix(']')
                .map(String::from)
        })
        .collect::<Option<Vec<_>>>()?;
    (!sources.is_empty()).then_some(sources)
}

/// 去掉正文里的 `[Image #N]` 占位（连同后面一个空格），返回去掉后的正文与去掉了几个
pub(super) fn strip_claude_image_placeholders(text: &str) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut count = 0;
    let mut rest = text;
    while let Some(at) = rest.find("[Image #") {
        let tail = &rest[at + "[Image #".len()..];
        let digits = tail.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 || tail.as_bytes().get(digits) != Some(&b']') {
            out.push_str(&rest[..at + 1]);
            rest = &rest[at + 1..];
            continue;
        }
        out.push_str(&rest[..at]);
        rest = &tail[digits + 1..];
        rest = rest.strip_prefix(' ').unwrap_or(rest);
        count += 1;
    }
    out.push_str(rest);
    (out, count)
}

/// 聊天层发图是「正文 + 一行一个图片路径」，Claude Code 把单独一行的图片路径收成图片附件：正文里换成前置的
/// `[Image #N]`、图本身以 base64 记进同一行，路径另记一条 isMeta 的 `[Image: source: 路径]`（2.1.308 实测）。
/// 照原文拼回「正文 + 路径行」：气泡画出图片卡，也对得上聊天层刚发出的那条（2026-11-04 用户截图：
/// 同一句出现两次，一条带「[Image #2]」没图、一条有图）。占位与来源数对不上（终端里直接贴的剪贴板图没有来源）
/// 不动占位，只把认得出的路径接在后面
pub(super) fn restore_claude_image_paths(msg: &mut ChatMessageDto, sources: &[String]) {
    let paths = sources.join("\n");
    let Some(block) = msg.blocks.iter_mut().find(|b| b.kind == "text") else {
        msg.blocks.push(text_block(paths));
        return;
    };
    let (stripped, count) = strip_claude_image_placeholders(&block.text);
    let body = if count == sources.len() { stripped.trim().to_string() } else { block.text.clone() };
    block.text = if body.is_empty() { paths } else { format!("{body}\n{paths}") };
}

pub(super) fn parse_claude(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    // 最近一条带图片附件的用户消息：（在 msgs 里的下标，promptId）——等它的 `[Image: source:]` 来源行
    let mut awaiting_sources: Option<(usize, Option<String>)> = None;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue; // 末行截断等坏行直接跳过
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue; // 子 agent 支线消息不进主对话
        }
        if v.get("isMeta").and_then(|x| x.as_bool()) == Some(true) {
            if let (Some((idx, prompt)), Some(sources)) = (&awaiting_sources, claude_image_sources(&v)) {
                let same_prompt = match (prompt.as_deref(), get_str(&v, "promptId")) {
                    (Some(a), Some(b)) => a == b,
                    _ => true,
                };
                if same_prompt {
                    if let Some(msg) = msgs.get_mut(*idx) {
                        restore_claude_image_paths(msg, &sources);
                    }
                    awaiting_sources = None;
                }
            }
            continue;
        }
        let ts = get_str(&v, "timestamp").map(String::from);
        match get_str(&v, "type") {
            Some("user") => {
                // Agent 闲着时到的后台通知（后台命令 / 子 Agent 跑完、Monitor 事件）记成普通 user 行，只带
                // origin.kind = task-notification、不标 isMeta，不是用户说的话（2026-10-25）。只认 human，没有 origin 的旧版照旧
                if v.get("origin").and_then(|o| get_str(o, "kind")).is_some_and(|kind| kind != "human") {
                    continue;
                }
                let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
                    continue;
                };
                match content {
                    Value::String(s) => push_claude_user_string(&mut msgs, s, ts, get_str(&v, "uuid").map(String::from)),
                    Value::Array(arr) => {
                        let mut blocks = Vec::new();
                        for b in arr {
                            match get_str(b, "type") {
                                Some("text") => {
                                    if let Some(t) = get_str(b, "text") {
                                        // 宿主塞进用户消息的 `<system-reminder>` 段（如「用户从这里分叉了一个会话」）不是人说的话
                                        // （2026-10-26 审查：分叉提示显示在了用户气泡里）
                                        if !is_claude_interrupt_marker(t) && !t.trim_start().starts_with("<system-reminder>") {
                                            blocks.push(text_block(t.to_string()));
                                        }
                                    }
                                }
                                Some("tool_result") => blocks.push(BlockDto {
                                    kind: "tool_result".into(),
                                    text: claude_tool_result_text(b),
                                    tool_name: None,
                                    is_error: b.get("is_error").and_then(Value::as_bool) == Some(true),
                                    call_id: get_str(b, "tool_use_id").map(String::from),
                                }),
                                _ => {}
                            }
                        }
                        if blocks.is_empty() {
                            continue;
                        }
                        if blocks.iter().all(|b| b.kind == "tool_result") {
                            push_tool_result(&mut msgs, blocks, ts);
                        } else {
                            if arr.iter().any(|b| get_str(b, "type") == Some("image")) {
                                awaiting_sources =
                                    Some((msgs.len(), get_str(&v, "promptId").map(String::from)));
                            }
                            msgs.push(ChatMessageDto {
                                role: "user".into(),
                                blocks,
                                timestamp: ts,
                                usage: None,
                                id: get_str(&v, "uuid").map(String::from),
                                cwd: None,
                            });
                        }
                    }
                    _ => {}
                }
            }
            // 新版 Claude 把本地斜杠命令（/model、/usage、/context…）记成 system/local_command 行，
            // content 是同一套 <command-name> / <local-command-stdout> 标签（旧版是 user 行）
            Some("system") if get_str(&v, "subtype") == Some("local_command") => {
                if let Some(text) = get_str(&v, "content") {
                    push_claude_user_string(&mut msgs, text, ts, get_str(&v, "uuid").map(String::from));
                }
            }
            // 这一轮还在跑时用户发的话，Claude 在下一步工具调用结束时一起交给模型，记成 attachment/queued_command，
            // 不是 user 行（2026-10-22 实测 2.1.292：原先这类话聊天层与回放里都看不到）。只认用户自己发的：
            // origin.kind = human，旧版没有 origin 的按 commandMode = prompt 认；后台任务通知、别的会话发来的不算
            Some("attachment") => {
                let Some(a) = v.get("attachment") else {
                    continue;
                };
                if get_str(a, "type") != Some("queued_command") || get_str(a, "commandMode") != Some("prompt") {
                    continue;
                }
                if a.get("origin").and_then(|o| get_str(o, "kind")).is_some_and(|kind| kind != "human") {
                    continue;
                }
                let text = match a.get("prompt") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(parts)) => parts
                        .iter()
                        .filter_map(|p| get_str(p, "text"))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    _ => continue,
                };
                if !text.trim().is_empty() {
                    push_claude_user_string(&mut msgs, &text, ts, get_str(&v, "uuid").map(String::from));
                }
            }
            Some("assistant") => {
                let Some(msg) = v.get("message") else {
                    continue;
                };
                let mut blocks = Vec::new();
                if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
                    for b in arr {
                        match get_str(b, "type") {
                            Some("text") => {
                                if let Some(t) = get_str(b, "text") {
                                    blocks.push(text_block(t.to_string()));
                                }
                            }
                            Some("thinking") => {
                                if let Some(t) = get_str(b, "thinking") {
                                    blocks.push(BlockDto {
                                        kind: "thinking".into(),
                                        text: t.to_string(),
                                        tool_name: None,
                                        is_error: false,
                                        call_id: None,
                                    });
                                }
                            }
                            Some("tool_use") => blocks.push(BlockDto {
                                kind: "tool_use".into(),
                                text: b.get("input").map(|i| i.to_string()).unwrap_or_default(),
                                tool_name: get_str(b, "name").map(String::from),
                                is_error: false,
                                call_id: get_str(b, "id").map(String::from),
                            }),
                            _ => {}
                        }
                    }
                }
                if blocks.is_empty() {
                    continue;
                }
                msgs.push(ChatMessageDto {
                    role: "assistant".into(),
                    blocks,
                    timestamp: ts,
                    usage: msg.get("usage").map(claude_usage),
                    id: get_str(&v, "uuid").map(String::from),
                    cwd: get_str(&v, "cwd").map(String::from),
                });
            }
            _ => {} // summary / ai-title / file-history-snapshot 等非对话类型
        }
    }
    msgs
}
