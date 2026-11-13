use super::*;
use std::collections::VecDeque;

// ===== Antigravity CLI（~/.gemini/antigravity-cli/，1.5.8 实测 2026-11） =====
//
// 会话文件：brain/<conversation_id>/.system_generated/logs/transcript_full.jsonl（未截断、工具参数为原生 JSON），
//           不存在时退回同目录 transcript.jsonl。同一步从 RUNNING 变 DONE 会追加同 step_index 的新行，按 step_index 取最新。
// 元信息库：conversation_summaries.db（只读打开，严禁写入；与 Antigravity 桌面版共用，只保留 app_data_dir='antigravity-cli'
//           且排除子智能体 nesting_depth>0 / parent_conversation_id 非空的行）；库不可用时退回 cache/last_conversations.json。
// 不解析 implicit/*.pb 与 SQLite 内 protobuf 字段。

#[derive(Debug, Clone, Default)]
pub(crate) struct AgySummaryEntry {
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    /// 库里明确记为桌面版（app_data_dir != 'antigravity-cli'）或子智能体会话：顶层列表跳过
    pub excluded: bool,
}

/// 将 `file://` URI 解码为本地路径（兼容 macOS/Linux `/Users/...` 与 Windows `/C:/...`、百分号编码）
pub(crate) fn agy_file_uri_to_path(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let rest = if let Some(s) = raw.strip_prefix("file://localhost") {
        s
    } else if let Some(s) = raw.strip_prefix("file://") {
        s
    } else if Path::new(raw).is_absolute() {
        return Some(
            crate::paths::strip_verbatim(PathBuf::from(raw))
                .to_string_lossy()
                .into_owned(),
        );
    } else {
        return None;
    };
    let decoded = percent_decode_utf8(rest);
    if decoded.is_empty() {
        return None;
    }
    // Windows 的 file:///C:/foo 解出后带前导斜杠 `/C:/foo`，剥掉前导 `/`
    let bytes = decoded.as_bytes();
    let path_str = if bytes.len() >= 3
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b':'
    {
        &decoded[1..]
    } else {
        decoded.as_str()
    };
    Some(
        crate::paths::strip_verbatim(PathBuf::from(path_str))
            .to_string_lossy()
            .into_owned(),
    )
}

fn percent_decode_utf8(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// 将 agy 的时间戳（RFC3339 或 SQLite 的 `YYYY-MM-DD HH:MM:SS.ffffff+00:00`）统一成 `YYYY-MM-DDTHH:MM:SSZ`
/// （与 `iso_from_unix` 同形，保证字典序比较与 `iso_within_secs` 一致；忽略 Go 零值 `0001-01-01...`）
pub(crate) fn agy_normalize_timestamp(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.starts_with("0001-") {
        return None;
    }
    let candidate = if s.len() > 10 && s.as_bytes()[10] == b' ' {
        let mut owned = s.to_string();
        owned.replace_range(10..11, "T");
        std::borrow::Cow::Owned(owned)
    } else {
        std::borrow::Cow::Borrowed(s)
    };
    chrono::DateTime::parse_from_rfc3339(&candidate)
        .ok()
        .map(|dt| {
            dt.with_timezone(&chrono::Utc)
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string()
        })
}

/// agy 元信息外部文件的组合指纹：(conversation_summaries.db, -wal, cache/last_conversations.json)
pub(crate) fn agy_meta_sources_sig(
    agy_root: &Path,
) -> (Option<FileSig>, Option<FileSig>, Option<FileSig>) {
    let db = agy_root.join("conversation_summaries.db");
    let mut wal_os = db.as_os_str().to_owned();
    wal_os.push("-wal");
    let last = agy_root.join("cache").join("last_conversations.json");
    (file_sig(&db), file_sig(Path::new(&wal_os)), file_sig(&last))
}

/// 只读加载 `conversation_summaries.db` 与 `cache/last_conversations.json` 元信息映射
pub(crate) fn agy_load_meta_map(agy_root: &Path) -> HashMap<String, AgySummaryEntry> {
    let mut map: HashMap<String, AgySummaryEntry> = HashMap::new();
    let db_path = agy_root.join("conversation_summaries.db");
    if let Some(conn) = open_opencode_db(&db_path) {
        for (names, vals) in query_rows(&conn, "SELECT * FROM conversation_summaries", &[]) {
            let row = DbRow { names, vals };
            let Some(cid) = row.as_str("conversation_id").filter(|s| !s.trim().is_empty()) else {
                continue;
            };
            let app_dir = row.as_str("app_data_dir");
            let desktop = app_dir
                .as_deref()
                .is_some_and(|d| !d.trim().is_empty() && d.trim() != "antigravity-cli");
            let has_parent = row
                .as_str("parent_conversation_id")
                .is_some_and(|p| !p.trim().is_empty());
            let nested = row.as_i64("nesting_depth").is_some_and(|n| n > 0);
            if desktop || has_parent || nested {
                map.insert(
                    cid,
                    AgySummaryEntry {
                        excluded: true,
                        ..Default::default()
                    },
                );
                continue;
            }
            let cwd = row
                .as_str("workspace_uris")
                .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
                .and_then(|uris| uris.into_iter().find_map(|u| agy_file_uri_to_path(&u)));
            let title = row
                .as_str("title")
                .and_then(|t| usable_title(&t))
                .or_else(|| row.as_str("preview").and_then(|p| usable_title(&p)));
            let updated_at = row
                .as_str("last_modified_time")
                .and_then(|t| agy_normalize_timestamp(&t));
            map.insert(
                cid,
                AgySummaryEntry {
                    cwd,
                    title,
                    updated_at,
                    excluded: false,
                },
            );
        }
    }
    // 回退补工作目录：cache/last_conversations.json 格式为 {"<cwd>": "<conversation_id>"}
    let last_conv = agy_root.join("cache").join("last_conversations.json");
    if let Some(Value::Object(obj)) = read_json_file(&last_conv) {
        for (cwd_key, val) in obj {
            let Some(cid) = val.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                continue;
            };
            if cwd_key.trim().is_empty() {
                continue;
            }
            let norm_cwd = crate::paths::strip_verbatim(PathBuf::from(&cwd_key))
                .to_string_lossy()
                .into_owned();
            let entry = map.entry(cid.to_string()).or_default();
            if !entry.excluded && entry.cwd.is_none() {
                entry.cwd = Some(norm_cwd);
            }
        }
    }
    map
}

/// 枚举 `brain/*/.system_generated/logs/` 下的会话日志：优先 `transcript_full.jsonl`，缺省退回 `transcript.jsonl`
pub(crate) fn agy_collect_transcripts(brain_root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(brain_root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(cid) = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty() && !s.starts_with('.'))
        else {
            continue;
        };
        let logs = dir.join(".system_generated").join("logs");
        let full = logs.join("transcript_full.jsonl");
        if full.is_file() {
            out.push((cid, full));
            continue;
        }
        let compact = logs.join("transcript.jsonl");
        if compact.is_file() {
            out.push((cid, compact));
        }
    }
    out
}

/// 从 `brain/<id>/.system_generated/logs/transcript*.jsonl` 提取 `<id>`
pub(crate) fn agy_session_id_from_path(path: &Path) -> Option<String> {
    let logs = path.parent()?;
    if logs.file_name()?.to_str()? != "logs" {
        return None;
    }
    let sys = logs.parent()?;
    if sys.file_name()?.to_str()? != ".system_generated" {
        return None;
    }
    sys.parent()?
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
}

/// 提取 `USER_INPUT` 里用户真正输入的话：优先取 `<USER_REQUEST>…</USER_REQUEST>` 内部正文，
/// 丢弃 `<ADDITIONAL_METADATA>` 与 `<USER_SETTINGS_CHANGE>` 系统注入块；纯设置变更行返回 None
pub(crate) fn agy_extract_user_text(raw: &str) -> Option<String> {
    const OPEN: &str = "<USER_REQUEST>";
    const CLOSE: &str = "</USER_REQUEST>";
    if let Some(start) = raw.find(OPEN) {
        let body_start = start + OPEN.len();
        let inner = match raw[body_start..].find(CLOSE) {
            Some(rel_end) => &raw[body_start..body_start + rel_end],
            None => &raw[body_start..],
        };
        let trimmed = inner.trim();
        return (!trimmed.is_empty()).then(|| trimmed.to_string());
    }
    let stripped = strip_xml_section(raw, "USER_SETTINGS_CHANGE");
    let stripped = strip_xml_section(&stripped, "ADDITIONAL_METADATA");
    let trimmed = stripped.trim();
    if trimmed.is_empty() || trimmed.starts_with('<') {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn strip_xml_section(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = text.to_string();
    while let Some(start) = out.find(&open) {
        if let Some(rel_end) = out[start..].find(&close) {
            out.replace_range(start..start + rel_end + close.len(), "");
        } else {
            out.truncate(start);
            break;
        }
    }
    out
}

/// 按 `step_index` 去重（同一步 RUNNING → DONE 追加两行，保留最后一行并维持首次出现顺序）
pub(crate) fn agy_dedup_steps(lines: &[String]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut by_step: HashMap<i64, usize> = HashMap::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !v.is_object() {
            continue;
        }
        if let Some(idx) = v.get("step_index").and_then(|x| x.as_i64()) {
            if let Some(&pos) = by_step.get(&idx) {
                out[pos] = v;
            } else {
                by_step.insert(idx, out.len());
                out.push(v);
            }
        } else {
            out.push(v);
        }
    }
    out
}

/// agy 的 `input_tokens` 已是扣掉缓存读后的新增输入（实测 prompt=100, cached=20 → input_tokens=80），不二次扣减
pub(super) fn agy_step_usage(v: &Value) -> Option<TokenUsageDto> {
    if get_str(v, "status") != Some("DONE") {
        return None;
    }
    let input = v.get("input_tokens").and_then(|x| x.as_u64());
    let output = v.get("output_tokens").and_then(|x| x.as_u64());
    let cache_read = v.get("cache_read_tokens").and_then(|x| x.as_u64());
    if input.is_none() && output.is_none() && cache_read.is_none() {
        return None;
    }
    Some(TokenUsageDto {
        input: input.unwrap_or(0),
        output: output.unwrap_or(0),
        cache_read: cache_read.unwrap_or(0),
        cache_write: 0,
    })
}

/// 兼容 `transcript_full.jsonl`（原生对象）与 `transcript.jsonl`（整段 JSON 字符串或字段值二次字符串化）
fn agy_normalize_tool_args(args: Option<&Value>) -> String {
    let Some(args) = args else {
        return String::new();
    };
    match args {
        Value::Null => String::new(),
        Value::String(s) => serde_json::from_str::<Value>(s)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| s.clone()),
        Value::Object(map) => {
            let mut cleaned = serde_json::Map::with_capacity(map.len());
            for (k, val) in map {
                let next = match val {
                    Value::String(s) if s.starts_with('"') && s.ends_with('"') && s.len() >= 2 => {
                        serde_json::from_str::<String>(s)
                            .map(Value::String)
                            .unwrap_or_else(|_| val.clone())
                    }
                    _ => val.clone(),
                };
                cleaned.insert(k.clone(), next);
            }
            Value::Object(cleaned).to_string()
        }
        other => other.to_string(),
    }
}

/// 剥去 `GENERIC` 工具输出开头的 `Created At: ...` / `Completed At: ...` 时间戳头
fn agy_strip_tool_headers(raw: &str) -> String {
    let mut rest = raw;
    for prefix in ["Created At:", "Completed At:"] {
        let trimmed = rest.trim_start_matches(['\r', '\n']);
        if trimmed.starts_with(prefix) {
            rest = match trimmed.find('\n') {
                Some(nl) => &trimmed[nl + 1..],
                None => "",
            };
        }
    }
    rest.trim_start_matches(['\r', '\n']).to_string()
}

pub(super) fn agy_file_meta(
    path: &Path,
    session_id_hint: Option<&str>,
    alive: bool,
    meta_map: &HashMap<String, AgySummaryEntry>,
) -> Option<SessionMetaDto> {
    let session_id = session_id_hint
        .map(String::from)
        .or_else(|| agy_session_id_from_path(path))
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    if session_id.is_empty() {
        return None;
    }
    let summary = meta_map.get(&session_id);
    if summary.is_some_and(|s| s.excluded) {
        return None;
    }
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let mut created_at = None;
    let mut first_title = None;
    for line in &head {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if created_at.is_none() {
            created_at = get_str(&v, "created_at").and_then(agy_normalize_timestamp);
        }
        if first_title.is_none() && get_str(&v, "type") == Some("USER_INPUT") {
            first_title = get_str(&v, "content")
                .and_then(agy_extract_user_text)
                .and_then(|t| usable_title(&t));
        }
        if created_at.is_some() && first_title.is_some() {
            break;
        }
    }
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let mut tail_updated = None;
    let mut token_usage = None;
    for line in tail_src.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if tail_updated.is_none() {
            tail_updated = get_str(&v, "created_at").and_then(agy_normalize_timestamp);
        }
        if token_usage.is_none() && get_str(&v, "type") == Some("PLANNER_RESPONSE") {
            token_usage = agy_step_usage(&v);
        }
        if tail_updated.is_some() && token_usage.is_some() {
            break;
        }
    }
    let cwd = summary.and_then(|s| s.cwd.clone());
    let project_path = cwd.clone().unwrap_or_else(|| {
        if !alive {
            "已固定".into()
        } else {
            String::new()
        }
    });
    let updated_at = [
        tail_updated,
        summary.and_then(|s| s.updated_at.clone()),
        mtime_iso(path),
    ]
    .into_iter()
    .flatten()
    .max();
    Some(SessionMetaDto {
        agent: "agy".into(),
        session_id,
        project_path,
        cwd,
        title: summary.and_then(|s| s.title.clone()).or(first_title),
        created_at,
        updated_at,
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

pub(super) fn parse_agy(lines: &[String]) -> Vec<ChatMessageDto> {
    let steps = agy_dedup_steps(lines);
    let mut msgs: Vec<ChatMessageDto> = Vec::new();
    let mut pending_calls: VecDeque<String> = VecDeque::new();
    for v in steps {
        let ts = get_str(&v, "created_at").and_then(agy_normalize_timestamp);
        let step_id = v
            .get("step_index")
            .and_then(|x| x.as_i64())
            .map(|n| n.to_string());
        match get_str(&v, "type") {
            Some("USER_INPUT") => {
                let Some(text) = get_str(&v, "content").and_then(agy_extract_user_text) else {
                    continue;
                };
                pending_calls.clear();
                msgs.push(ChatMessageDto {
                    role: "user".into(),
                    blocks: vec![text_block(text)],
                    timestamp: ts,
                    usage: None,
                    id: step_id,
                    cwd: None,
                });
            }
            Some("PLANNER_RESPONSE") => {
                pending_calls.clear();
                let mut blocks = Vec::new();
                if let Some(th) = get_str(&v, "thinking")
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    blocks.push(BlockDto {
                        kind: "thinking".into(),
                        text: th.to_string(),
                        tool_name: None,
                        is_error: false,
                        call_id: None,
                    });
                }
                if let Some(c) = get_str(&v, "content").filter(|s| !s.trim().is_empty()) {
                    blocks.push(text_block(c.to_string()));
                }
                if let Some(calls) = v.get("tool_calls").and_then(|x| x.as_array()) {
                    let prefix = step_id.as_deref().unwrap_or("x");
                    for (idx, call) in calls.iter().enumerate() {
                        let cid = get_str(call, "id")
                            .map(String::from)
                            .unwrap_or_else(|| format!("agy-{prefix}-{idx}"));
                        let name = get_str(call, "name")
                            .or_else(|| get_str(call, "tool_name"))
                            .map(String::from);
                        let args_text = agy_normalize_tool_args(
                            call.get("args").or_else(|| call.get("arguments")),
                        );
                        blocks.push(BlockDto {
                            kind: "tool_use".into(),
                            text: args_text,
                            tool_name: name,
                            is_error: false,
                            call_id: Some(cid.clone()),
                        });
                        pending_calls.push_back(cid);
                    }
                }
                if !blocks.is_empty() {
                    msgs.push(ChatMessageDto {
                        role: "assistant".into(),
                        blocks,
                        timestamp: ts,
                        usage: agy_step_usage(&v),
                        id: step_id,
                        cwd: None,
                    });
                }
            }
            Some("GENERIC") => {
                let raw = get_str(&v, "content").unwrap_or_default();
                let looks_like_tool = raw.trim_start().starts_with("Created At:");
                let call_id = pending_calls.pop_front();
                if call_id.is_none() && !looks_like_tool {
                    // 系统收尾提示（如 "Task is complete..."）无前置工具调用，折叠跳过
                    continue;
                }
                let text = agy_strip_tool_headers(raw);
                let is_error = get_str(&v, "status") == Some("ERROR");
                push_tool_result(
                    &mut msgs,
                    vec![BlockDto {
                        kind: "tool_result".into(),
                        text,
                        tool_name: None,
                        is_error,
                        call_id,
                    }],
                    ts,
                );
            }
            _ => {}
        }
    }
    msgs
}

pub(super) fn agy_tail_state(lines: &[String]) -> &'static str {
    let steps = agy_dedup_steps(lines);
    for v in steps.iter().rev() {
        let status = get_str(v, "status").unwrap_or("");
        let calls = v
            .get("tool_calls")
            .and_then(|x| x.as_array())
            .filter(|a| !a.is_empty());
        let asks_user = calls.is_some_and(|arr| {
            arr.iter()
                .any(|c| get_str(c, "name") == Some("ask_question"))
        });
        if !matches!(status, "DONE" | "ERROR" | "CANCELLED" | "CANCELED") {
            return if asks_user { "confirm" } else { "working" };
        }
        if matches!(status, "ERROR" | "CANCELLED" | "CANCELED") {
            return "settled";
        }
        match get_str(v, "type") {
            Some("PLANNER_RESPONSE") => {
                if calls.is_some() {
                    return if asks_user { "confirm" } else { "working" };
                }
                let text = get_str(v, "content").unwrap_or_default();
                return if ends_with_question(text) {
                    "confirm"
                } else {
                    "done"
                };
            }
            Some("GENERIC") => {
                if get_str(v, "content")
                    .unwrap_or_default()
                    .trim_start()
                    .starts_with("Created At:")
                {
                    return "working";
                }
            }
            Some("USER_INPUT") => {
                if get_str(v, "content")
                    .and_then(agy_extract_user_text)
                    .is_some()
                {
                    return "working";
                }
            }
            _ => {}
        }
    }
    "unknown"
}

/// 删除 agy 会话：先按会话白名单校验 transcript 文件，再把所属 `brain/<id>/` 整目录移入回收站
/// （测试态走 `trash_to_recycle_bin` 直删隔离缝）；绝不写 `conversation_summaries.db`
pub(super) fn delete_agy_session_dir(
    file_path: &str,
    dirs: &[(PathBuf, bool)],
    permanent: bool,
) -> Result<bool, String> {
    let p = PathBuf::from(file_path);
    if !p.exists() {
        return Ok(false);
    }
    if !deletable_session_file(&p, dirs) {
        return Err(format!(
            "拒绝删除非会话文件（不在会话数据目录或后缀不符）: {file_path}"
        ));
    }
    let canon_file = p
        .canonicalize()
        .map_err(|e| format!("解析会话路径失败: {e}"))?;
    // 标准布局：.../brain/<id>/.system_generated/logs/transcript*.jsonl → 删 brain/<id> 目录
    if let Some(session_dir) = canon_file
        .parent()
        .filter(|d| d.file_name().and_then(|n| n.to_str()) == Some("logs"))
        .and_then(|d| d.parent())
        .filter(|d| d.file_name().and_then(|n| n.to_str()) == Some(".system_generated"))
        .and_then(|d| d.parent())
    {
        let under_known_brain = dirs.iter().any(|(root, _)| {
            root.canonicalize()
                .ok()
                .is_some_and(|canon_brain| session_dir.parent() == Some(canon_brain.as_path()))
        });
        if under_known_brain {
            if permanent {
                fs::remove_dir_all(session_dir)
                    .map_err(|e| format!("删除 {} 失败: {e}", session_dir.display()))?;
            } else {
                crate::projects::trash_to_recycle_bin(session_dir)
                    .map_err(|e| format!("删除 {} 失败: {e}", session_dir.display()))?;
            }
            return Ok(true);
        }
    }
    delete_source_file_mode(file_path, permanent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agy_file_uri_decodes_unix_and_windows_paths() {
        assert_eq!(
            agy_file_uri_to_path("file:///Users/alice/my%20proj"),
            Some("/Users/alice/my proj".into())
        );
        assert_eq!(
            agy_file_uri_to_path("file:///C:/Users/alice/work%20dir"),
            Some("C:/Users/alice/work dir".into())
        );
        assert_eq!(agy_file_uri_to_path(""), None);
    }

    #[test]
    fn agy_timestamp_normalizes_sqlite_and_skips_zero_time() {
        assert_eq!(
            agy_normalize_timestamp("2026-11-13 18:51:16.460442+00:00"),
            Some("2026-11-13T18:51:16Z".into())
        );
        assert_eq!(
            agy_normalize_timestamp("2026-11-14T09:00:05+08:00"),
            Some("2026-11-14T01:00:05Z".into())
        );
        assert_eq!(
            agy_normalize_timestamp("0001-01-01 00:00:00+00:00"),
            None
        );
    }

    #[test]
    fn agy_parses_fixture_dedups_steps_and_redacts_secrets() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tests/fixtures/agy/sample-transcript.jsonl");
        let msgs = conversation_impl("agy", &fixture.to_string_lossy());
        // step 4 纯设置变更、step 3 无前置调用系统提示、step 6 截断行均不产生幽灵消息
        assert_eq!(msgs.len(), 3, "{msgs:?}");
        assert_eq!(msgs[0].role, "user");
        assert!(
            msgs[0].blocks[0].text.contains("检查当前目录并运行探针命令"),
            "{:?}",
            msgs[0].blocks[0].text
        );
        assert!(
            !msgs[0].blocks[0].text.contains("sk-secret1234567890abcd"),
            "出站文本必须脱敏: {:?}",
            msgs[0].blocks[0].text
        );
        assert!(
            !msgs[0].blocks[0].text.contains("ADDITIONAL_METADATA"),
            "系统附加元数据不应进用户气泡"
        );

        // step 1 RUNNING 与 DONE 按 step_index 合一，且 GENERIC 工具结果挂在同一条 assistant 下
        assert_eq!(msgs[1].role, "assistant");
        let kinds: Vec<&str> = msgs[1].blocks.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds, vec!["thinking", "tool_use", "tool_result"]);
        assert_eq!(msgs[1].blocks[1].tool_name.as_deref(), Some("run_command"));
        assert!(msgs[1].blocks[1].text.contains("\"CommandLine\":\"echo ok\""));
        assert!(!msgs[1].blocks[2].text.contains("Created At:"));
        assert!(msgs[1].blocks[2].text.contains("Command exited with code 0."));
        let usage = msgs[1].usage.as_ref().expect("DONE 步骤带 token 统计");
        assert_eq!((usage.input, usage.cache_read, usage.output), (80, 20, 12));

        assert_eq!(msgs[2].role, "assistant");
        assert!(msgs[2]
            .blocks
            .iter()
            .any(|b| b.kind == "text" && b.text.contains("探针命令已跑通")));
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("ccode-agy-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn agy_meta_map_filters_desktop_and_subagents_with_json_fallback() {
        let tmp = TempDir::new();
        let root = tmp.path().join(".gemini/antigravity-cli");
        fs::create_dir_all(root.join("cache")).unwrap();
        let db_path = root.join("conversation_summaries.db");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE conversation_summaries (
                    conversation_id TEXT PRIMARY KEY,
                    title TEXT,
                    preview TEXT,
                    last_modified_time TEXT,
                    workspace_uris TEXT,
                    parent_conversation_id TEXT,
                    nesting_depth INTEGER,
                    app_data_dir TEXT
                );
                INSERT INTO conversation_summaries VALUES
                    ('cli-1', 'CLI 对话', '', '2026-11-14 01:02:03+00:00', '[\"file:///tmp/work%20a\"]', '', 0, 'antigravity-cli'),
                    ('desk-1', '桌面对话', '', '2026-11-14 01:02:03+00:00', '[\"file:///tmp/desk\"]', '', 0, 'antigravity'),
                    ('sub-1', '子任务', '', '2026-11-14 01:02:03+00:00', '[\"file:///tmp/work%20a\"]', 'cli-1', 1, 'antigravity-cli'),
                    ('cli-nocwd', '待补目录', '', '0001-01-01 00:00:00+00:00', '[]', '', 0, 'antigravity-cli');",
            )
            .unwrap();
        }
        fs::write(
            root.join("cache/last_conversations.json"),
            r#"{"/tmp/fallback-proj": "cli-nocwd", "/tmp/only-cache": "cache-only"}"#,
        )
        .unwrap();

        let map = agy_load_meta_map(&root);
        assert_eq!(map["cli-1"].cwd.as_deref(), Some("/tmp/work a"));
        assert!(!map["cli-1"].excluded);
        assert!(map["desk-1"].excluded, "桌面版记录必须标记排除");
        assert!(map["sub-1"].excluded, "子智能体会话必须标记排除");
        assert_eq!(
            map["cli-nocwd"].cwd.as_deref(),
            Some("/tmp/fallback-proj"),
            "库里无 workspace_uris 时退回 last_conversations.json"
        );
        assert_eq!(map["cli-nocwd"].updated_at, None, "0001 零值时间不采信");
        assert_eq!(map["cache-only"].cwd.as_deref(), Some("/tmp/only-cache"));

        // 造三份 brain 目录验证扫描只产出 CLI 顶层会话，且优先读 transcript_full.jsonl
        for (id, file, text) in [
            ("cli-1", "transcript_full.jsonl", "{\"step_index\":0,\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"created_at\":\"2026-11-14T01:00:00Z\",\"content\":\"<USER_REQUEST>hello</USER_REQUEST>\"}\n"),
            ("desk-1", "transcript_full.jsonl", "{\"step_index\":0,\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"created_at\":\"2026-11-14T01:00:00Z\",\"content\":\"<USER_REQUEST>desk</USER_REQUEST>\"}\n"),
            ("sub-1", "transcript.jsonl", "{\"step_index\":0,\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"created_at\":\"2026-11-14T01:00:00Z\",\"content\":\"<USER_REQUEST>sub</USER_REQUEST>\"}\n"),
        ] {
            let logs = root.join("brain").join(id).join(".system_generated/logs");
            fs::create_dir_all(&logs).unwrap();
            fs::write(logs.join(file), text).unwrap();
        }
        let found: Vec<SessionMetaDto> = agy_collect_transcripts(&root.join("brain"))
            .into_iter()
            .filter_map(|(cid, p)| agy_file_meta(&p, Some(&cid), true, &map))
            .collect();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].session_id, "cli-1");
        assert_eq!(found[0].project_path, "/tmp/work a");
        assert_eq!(found[0].title.as_deref(), Some("CLI 对话"));

        // 删除会话：删掉整个 brain/cli-1 目录，不碰 conversation_summaries.db 与 settings.json
        fs::write(root.join("settings.json"), "{}").unwrap();
        let brain_dirs = vec![(root.join("brain"), false)];
        let deleted = delete_agy_session_dir(&found[0].file_path, &brain_dirs, false).unwrap();
        assert!(deleted);
        assert!(!root.join("brain/cli-1").exists(), "brain/<id> 整目录已移除");
        assert!(db_path.exists(), "conversation_summaries.db 不得被触碰");
        assert!(root.join("settings.json").exists(), "settings.json 不得被触碰");
    }

    #[test]
    fn agy_tail_state_tracks_running_confirm_and_done() {
        let user = vec![r#"{"step_index":0,"type":"USER_INPUT","status":"DONE","content":"<USER_REQUEST>hi</USER_REQUEST>"}"#.to_string()];
        assert_eq!(agy_tail_state(&user), "working");

        let running = vec![
            user[0].clone(),
            r#"{"step_index":1,"type":"PLANNER_RESPONSE","status":"RUNNING","content":"thinking"}"#.to_string(),
        ];
        assert_eq!(agy_tail_state(&running), "working");

        let ask = vec![
            user[0].clone(),
            r#"{"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"ask_question","args":{}}]}"#.to_string(),
        ];
        assert_eq!(agy_tail_state(&ask), "confirm");

        let done = vec![
            user[0].clone(),
            r#"{"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","content":"已完成修改。"}"#.to_string(),
        ];
        assert_eq!(agy_tail_state(&done), "done");

        let question = vec![
            user[0].clone(),
            r#"{"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","content":"要不要继续执行下一步？"}"#.to_string(),
        ];
        assert_eq!(agy_tail_state(&question), "confirm");
    }
}
