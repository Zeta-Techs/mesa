use super::*;
use std::collections::VecDeque;

// ===== Antigravity CLI（~/.gemini/antigravity-cli/ 与 --gemini_dir 隔离根，1.5.8 实测 2026-11） =====
//
// 会话文件：优先读 `brain/<conversation_id>/.system_generated/logs/transcript_full.jsonl`（缺省退回 `transcript.jsonl`）；
//           纯文字外部/内嵌对话尚未导出 `brain/<id>` 时，只要 `conversations/<id>.db` 存在，即以
//           `<agy_root>/conversation_summaries.db#<id>` 虚拟路径只读解析 `conversations_fts` 索引里的完整问答正文，
//           且一旦运行中导出了 `brain/<id>/.../transcript*.jsonl` 自动无缝升级读完整日志。
// 元信息库：`conversation_summaries.db`（只读打开，严禁写入；与 Antigravity 桌面版共用，只保留 `app_data_dir='antigravity-cli'`
//           且排除子智能体 `nesting_depth>0` / `parent_conversation_id` 非空的行），辅以 `cache/conversation_metadata.json`
//           （排除 `is_internal`）、`cache/last_conversations.json` 与 `history.jsonl` 补齐工作目录。
// 多数据根：除默认 `~/.gemini/antigravity-cli` 外，一并扫描 `$ANTIGRAVITY_APP_DATA_DIR` 与 `~/.cc-switch/agy/*/antigravity-cli`；
//           落在隔离根的会话续聊时自动补 `--gemini_dir=<dir>`。
// 不解析 implicit/*.pb 与 SQLite 内 protobuf 字段。

pub(crate) type AgyMetaSourcesSig = [Option<FileSig>; 5];

#[derive(Debug, Clone, Default)]
pub(crate) struct AgySummaryEntry {
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub step_count: i64,
    /// 库或 metadata 明确记为桌面版、内部会话或子智能体会话：顶层列表跳过
    pub excluded: bool,
}

impl AgySummaryEntry {
    pub(crate) fn has_content(&self) -> bool {
        self.step_count > 0 || self.title.is_some()
    }
}

pub(crate) fn valid_agy_cid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 枚举所有候选 Antigravity CLI 数据根 `(agy_root, custom_gemini_dir)`：
/// 1) 主目录 `~/.gemini/antigravity-cli`（无需 `--gemini_dir`）
/// 2) 进程环境 `ANTIGRAVITY_APP_DATA_DIR`（非测试态）
/// 3) `~/.cc-switch/agy/<provider>/antigravity-cli`（续聊需 `--gemini_dir=<~/.cc-switch/agy/<provider>>`）
pub(crate) fn agy_data_roots(primary_agy_root: &Path) -> Vec<(PathBuf, Option<PathBuf>)> {
    let home = primary_agy_root
        .parent()
        .filter(|g| g.file_name().and_then(|n| n.to_str()) == Some(".gemini"))
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .or_else(|| {
            #[cfg(not(test))]
            {
                crate::dirs::home_dir()
            }
            #[cfg(test)]
            {
                None
            }
        });
    let env_dir: Option<PathBuf> = {
        #[cfg(not(test))]
        {
            std::env::var_os("ANTIGRAVITY_APP_DATA_DIR")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        }
        #[cfg(test)]
        {
            None
        }
    };
    agy_data_roots_with(primary_agy_root, home.as_deref(), env_dir.as_deref())
}

pub(crate) fn agy_data_roots_with(
    primary_agy_root: &Path,
    home: Option<&Path>,
    env_app_data_dir: Option<&Path>,
) -> Vec<(PathBuf, Option<PathBuf>)> {
    let mut out: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push_root = |root: PathBuf, gemini_dir: Option<PathBuf>| {
        let key = crate::paths::path_key(&root.to_string_lossy());
        if seen.insert(key) {
            out.push((root, gemini_dir));
        }
    };

    push_root(primary_agy_root.to_path_buf(), None);

    if let Some(env_root) = env_app_data_dir {
        let gemini_dir = if crate::paths::same_path(
            &env_root.to_string_lossy(),
            &primary_agy_root.to_string_lossy(),
        ) {
            None
        } else if env_root.file_name().and_then(|n| n.to_str()) == Some("antigravity-cli") {
            env_root.parent().map(Path::to_path_buf)
        } else {
            None
        };
        push_root(env_root.to_path_buf(), gemini_dir);
    }

    if let Some(h) = home {
        let cc_agy = h.join(".cc-switch").join("agy");
        if let Ok(entries) = fs::read_dir(&cc_agy) {
            let mut dirs: Vec<PathBuf> = entries
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| e.path())
                .collect();
            dirs.sort();
            for dir in dirs {
                let sub = dir.join("antigravity-cli");
                if sub.is_dir() {
                    push_root(sub, Some(dir));
                }
            }
        }
    }

    out
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

fn agy_ns_to_iso(ns: i64) -> Option<String> {
    if ns <= 0 {
        return None;
    }
    let secs = (ns / 1_000_000_000) as u64;
    (secs > 0).then(|| iso_from_unix(secs))
}

fn agy_max_iso(a: Option<String>, b: Option<String>) -> Option<String> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (Some(x), None) => Some(x),
        (None, Some(y)) => Some(y),
        (None, None) => None,
    }
}

/// agy 元信息外部文件的组合指纹：
/// `[conversation_summaries.db, -wal, cache/last_conversations.json, cache/conversation_metadata.json, history.jsonl]`
pub(crate) fn agy_meta_sources_sig(agy_root: &Path) -> AgyMetaSourcesSig {
    let db = agy_root.join("conversation_summaries.db");
    let mut wal_os = db.as_os_str().to_owned();
    wal_os.push("-wal");
    let cache = agy_root.join("cache");
    let last = cache.join("last_conversations.json");
    let meta = cache.join("conversation_metadata.json");
    let hist = agy_root.join("history.jsonl");
    [
        file_sig(&db),
        file_sig(Path::new(&wal_os)),
        file_sig(&last),
        file_sig(&meta),
        file_sig(&hist),
    ]
}

/// 只读加载 `conversation_summaries.db`（含 `conversations_fts` 摘要行）、
/// `cache/conversation_metadata.json`、`cache/last_conversations.json` 与 `history.jsonl` 元信息映射
pub(crate) fn agy_load_meta_map(agy_root: &Path) -> HashMap<String, AgySummaryEntry> {
    let mut map: HashMap<String, AgySummaryEntry> = HashMap::new();
    let db_path = agy_root.join("conversation_summaries.db");
    if let Some(conn) = open_opencode_db(&db_path) {
        for (names, vals) in query_rows(&conn, "SELECT * FROM conversation_summaries", &[]) {
            let row = DbRow { names, vals };
            let Some(cid) = row.as_str("conversation_id").filter(|s| valid_agy_cid(s.trim())) else {
                continue;
            };
            let cid = cid.trim().to_string();
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
                    step_count: 0,
                    excluded: false,
                },
            );
        }

        // FTS5 摘要行（chunk_index = -1）：补齐未导出 brain/ 时的 step_count、纳秒级最后活跃时间与首句标题
        for (names, vals) in query_rows(
            &conn,
            "SELECT conversation_id, step_count, last_step_created_at, title FROM conversations_fts WHERE chunk_index = -1",
            &[],
        ) {
            let row = DbRow { names, vals };
            let Some(cid) = row.as_str("conversation_id").filter(|s| valid_agy_cid(s.trim())) else {
                continue;
            };
            let entry = map.entry(cid.trim().to_string()).or_default();
            if entry.excluded {
                continue;
            }
            if let Some(steps) = row.as_i64("step_count") {
                entry.step_count = entry.step_count.max(steps);
            }
            if let Some(fts_ts) = row.as_i64("last_step_created_at").and_then(agy_ns_to_iso) {
                entry.updated_at = agy_max_iso(entry.updated_at.take(), Some(fts_ts));
            }
            if entry.title.is_none() {
                entry.title = row.as_str("title").and_then(|t| usable_title(&t));
            }
        }

        // 首句是「你好」等寒暄时摘要行 title 会被 usable_title 过滤；继续从首个正文分片的 user_body 取下一句实质提问
        let untitled_ids: Vec<String> = map
            .iter()
            .filter(|(_, e)| !e.excluded && e.step_count > 0 && e.title.is_none())
            .map(|(cid, _)| cid.clone())
            .collect();
        for cid in untitled_ids {
            for (names, vals) in query_rows(
                &conn,
                "SELECT user_body FROM conversations_fts WHERE conversation_id = ?1 AND chunk_index >= 0 ORDER BY chunk_index ASC LIMIT 2",
                &[&cid as &dyn rusqlite::ToSql],
            ) {
                let row = DbRow { names, vals };
                if let Some(found_title) = row
                    .as_str("user_body")
                    .and_then(|body| body.lines().find_map(usable_title))
                {
                    if let Some(entry) = map.get_mut(&cid) {
                        entry.title = Some(found_title);
                    }
                    break;
                }
            }
        }
    }

    // cache/conversation_metadata.json：排除 is_internal 会话，并补齐 WorkspaceURIs / Title / Preview / NumSteps
    let meta_json = agy_root.join("cache").join("conversation_metadata.json");
    if let Some(Value::Object(root_obj)) = read_json_file(&meta_json) {
        if let Some(convs) = root_obj.get("conversations").and_then(|v| v.as_object()) {
            for (cid_raw, item) in convs {
                let cid = cid_raw.trim();
                if !valid_agy_cid(cid) {
                    continue;
                }
                let summary = item.get("summary");
                let is_internal = item
                    .get("is_internal")
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false)
                    || summary
                        .and_then(|s| s.get("Internal"))
                        .and_then(|b| b.as_bool())
                        .unwrap_or(false);
                let non_cli = summary
                    .and_then(|s| get_str(s, "AppDataDir"))
                    .is_some_and(|d| !d.trim().is_empty() && d.trim() != "antigravity-cli");
                let entry = map.entry(cid.to_string()).or_default();
                if is_internal || non_cli {
                    entry.excluded = true;
                    continue;
                }
                if entry.excluded {
                    continue;
                }
                if entry.cwd.is_none() {
                    entry.cwd = summary
                        .and_then(|s| s.get("WorkspaceURIs"))
                        .and_then(|u| u.as_array())
                        .and_then(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str())
                                .find_map(agy_file_uri_to_path)
                        });
                }
                if entry.title.is_none() {
                    entry.title = summary
                        .and_then(|s| get_str(s, "Title"))
                        .and_then(usable_title)
                        .or_else(|| {
                            summary
                                .and_then(|s| get_str(s, "Preview"))
                                .and_then(usable_title)
                        });
                }
                if let Some(steps) = summary
                    .and_then(|s| s.get("NumSteps"))
                    .and_then(|n| n.as_i64())
                {
                    entry.step_count = entry.step_count.max(steps);
                }
                let meta_ts = agy_max_iso(
                    summary
                        .and_then(|s| get_str(s, "UpdatedAt"))
                        .and_then(agy_normalize_timestamp),
                    get_str(item, "last_modified_time").and_then(agy_normalize_timestamp),
                );
                entry.updated_at = agy_max_iso(entry.updated_at.take(), meta_ts);
            }
        }
    }

    // 回退补工作目录 1：cache/last_conversations.json 格式为 {"<cwd>": "<conversation_id>"}
    let last_conv = agy_root.join("cache").join("last_conversations.json");
    if let Some(Value::Object(obj)) = read_json_file(&last_conv) {
        for (cwd_key, val) in obj {
            let Some(cid) = val.as_str().map(str::trim).filter(|s| valid_agy_cid(s)) else {
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

    // 回退补工作目录 2：history.jsonl 按输入历史记 `{"workspace":"<cwd>","conversationId":"<cid>"}`
    // （解决同一目录后续又开了新会话覆盖 last_conversations.json，且旧会话 workspace_uris 为空的情况）
    let history_path = agy_root.join("history.jsonl");
    if history_path.is_file() {
        for line in last_lines(&history_path, 256 * 1024).into_iter().rev() {
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(cid) = get_str(&v, "conversationId")
                .map(str::trim)
                .filter(|s| valid_agy_cid(s))
            else {
                continue;
            };
            let Some(ws) = get_str(&v, "workspace")
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let entry = map.entry(cid.to_string()).or_default();
            if !entry.excluded && entry.cwd.is_none() {
                entry.cwd = Some(
                    crate::paths::strip_verbatim(PathBuf::from(ws))
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }

    map
}

/// 枚举 `agy_root` 下所有会话候选文件（优先 `brain/<id>/.../transcript*.jsonl`，未导出则取 `conversations/<id>.db`）
pub(crate) fn agy_collect_session_files(agy_root: &Path) -> Vec<(String, PathBuf)> {
    let mut out = agy_collect_transcripts(&agy_root.join("brain"));
    let seen: std::collections::HashSet<String> =
        out.iter().map(|(cid, _)| cid.clone()).collect();
    if let Ok(entries) = fs::read_dir(agy_root.join("conversations")) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            if p.extension().and_then(|s| s.to_str()) != Some("db") {
                continue;
            }
            let Some(cid) = p
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|s| valid_agy_cid(s))
            else {
                continue;
            };
            if !seen.contains(cid) {
                out.push((cid.to_string(), p));
            }
        }
    }
    out
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

/// 剥去 `GENERIC` 工具输出开头可能重复出现的 `Created At: ...` / `Completed At: ...` 时间戳头
fn agy_strip_tool_headers(raw: &str) -> String {
    let mut rest = raw;
    loop {
        let trimmed = rest.trim_start_matches(['\r', '\n']);
        if trimmed.starts_with("Created At:") || trimmed.starts_with("Completed At:") {
            rest = match trimmed.find('\n') {
                Some(nl) => &trimmed[nl + 1..],
                None => "",
            };
        } else {
            return trimmed.to_string();
        }
    }
}

fn agy_extract_media_paths(v: &Value) -> Vec<String> {
    let Some(arr) = v.get("media").and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for item in arr {
        if let Some(p) = get_str(item, "uri").and_then(agy_file_uri_to_path) {
            if !p.is_empty() && !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

fn agy_merge_media_lines(media_paths: &[String], body: Option<String>) -> Option<String> {
    let body_ref = body.as_deref().unwrap_or("");
    let mut prefix: Vec<&str> = media_paths
        .iter()
        .map(String::as_str)
        .filter(|p| !body_ref.lines().any(|l| l.trim() == *p))
        .collect();
    if prefix.is_empty() {
        return body;
    }
    let joined = prefix.drain(..).collect::<Vec<_>>().join("\n");
    match body.filter(|b| !b.trim().is_empty()) {
        Some(b) => Some(format!("{joined}\n{b}")),
        None => Some(joined),
    }
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

/// 仅落在 `conversations/<cid>.db` + `conversation_summaries.db`、尚未导出 `brain/<cid>` 日志的外部/纯文字会话
pub(super) fn agy_db_session_meta(
    summaries_db: &Path,
    conv_db: &Path,
    session_id: &str,
    entry: &AgySummaryEntry,
) -> Option<SessionMetaDto> {
    if entry.excluded || !entry.has_content() || !valid_agy_cid(session_id) {
        return None;
    }
    let mut wal_os = conv_db.as_os_str().to_owned();
    wal_os.push("-wal");
    let wal_path = Path::new(&wal_os);
    let conv_mtime = mtime_iso(conv_db);
    let wal_mtime = mtime_iso(wal_path);
    let updated_at = [entry.updated_at.clone(), conv_mtime.clone(), wal_mtime]
        .into_iter()
        .flatten()
        .max();
    let created_at = conv_mtime.or_else(|| entry.updated_at.clone());
    let cwd = entry.cwd.clone();
    let project_path = cwd.clone().unwrap_or_default();
    let live = mtime_fresh(conv_db, 60) || mtime_fresh(wal_path, 60);
    Some(SessionMetaDto {
        agent: "agy".into(),
        session_id: session_id.to_string(),
        project_path,
        cwd,
        title: entry.title.clone(),
        created_at,
        updated_at,
        file_path: format!("{}#{session_id}", summaries_db.display()),
        token_usage: None,
        cli_version: None,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive: true,
        chain_count: 1,
        workspace: None,
        step_name: None,
        summary: None,
        live,
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

/// 扫描全部候选 agy 数据根（默认根 + `$ANTIGRAVITY_APP_DATA_DIR` + `~/.cc-switch/agy/*/antigravity-cli`），
/// 合并 `brain/` 导出日志与 `conversations/*.db` 仅落库对话；同 `session_id` 多根出现时，有完整日志的覆盖仅落库行
pub(crate) fn agy_scan_roots(
    primary_agy_root: &Path,
    agy_cache: &mut HashMap<String, (FileSig, SessionMetaDto)>,
    agy_meta_sig: &mut HashMap<String, AgyMetaSourcesSig>,
    agy_meta_map: &mut HashMap<String, HashMap<String, AgySummaryEntry>>,
) -> Vec<SessionMetaDto> {
    let roots = agy_data_roots(primary_agy_root);
    let mut agy_next: HashMap<String, (FileSig, SessionMetaDto)> =
        HashMap::with_capacity(agy_cache.len());
    let mut active_root_keys: std::collections::HashSet<String> =
        std::collections::HashSet::with_capacity(roots.len());
    let mut out: Vec<SessionMetaDto> = Vec::new();
    let mut seen_idx: HashMap<String, usize> = HashMap::new();

    for (agy_root, _gemini_dir) in roots {
        let root_key = cache_key(&agy_root);
        active_root_keys.insert(root_key.clone());
        let cur_sig = agy_meta_sources_sig(&agy_root);
        let sources_changed = agy_meta_sig.get(&root_key) != Some(&cur_sig);
        if sources_changed || !agy_meta_map.contains_key(&root_key) {
            agy_meta_map.insert(root_key.clone(), agy_load_meta_map(&agy_root));
            agy_meta_sig.insert(root_key.clone(), cur_sig);
        }
        let Some(meta_map) = agy_meta_map.get(&root_key) else {
            continue;
        };

        let mut root_sessions: Vec<SessionMetaDto> = Vec::new();
        let mut transcript_cids: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        for (cid, f) in agy_collect_transcripts(&agy_root.join("brain")) {
            let Some(sig) = file_sig(&f) else { continue };
            let key = cache_key(&f);
            let meta = match agy_cache.get(&key) {
                Some((old_sig, old)) if !sources_changed && *old_sig == sig => old.clone(),
                _ => match agy_file_meta(&f, Some(&cid), true, meta_map) {
                    Some(m) => m,
                    None => continue,
                },
            };
            transcript_cids.insert(meta.session_id.clone());
            agy_next.insert(key, (sig, meta.clone()));
            root_sessions.push(meta);
        }

        let summaries_db = agy_root.join("conversation_summaries.db");
        if summaries_db.is_file() {
            let convs_dir = agy_root.join("conversations");
            for (cid, entry) in meta_map {
                if transcript_cids.contains(cid) || entry.excluded || !entry.has_content() {
                    continue;
                }
                let conv_db = convs_dir.join(format!("{cid}.db"));
                if !conv_db.is_file() {
                    continue;
                }
                if let Some(meta) = agy_db_session_meta(&summaries_db, &conv_db, cid, entry) {
                    root_sessions.push(meta);
                }
            }
        }

        for meta in root_sessions {
            match seen_idx.get(&meta.session_id).copied() {
                None => {
                    seen_idx.insert(meta.session_id.clone(), out.len());
                    out.push(meta);
                }
                Some(idx)
                    if out[idx].file_path.contains('#') && !meta.file_path.contains('#') =>
                {
                    out[idx] = meta;
                }
                Some(_) => {}
            }
        }
    }

    *agy_cache = agy_next;
    agy_meta_sig.retain(|k, _| active_root_keys.contains(k));
    agy_meta_map.retain(|k, _| active_root_keys.contains(k));
    out
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
                let media_paths = agy_extract_media_paths(&v);
                let user_text = get_str(&v, "content").and_then(agy_extract_user_text);
                let Some(text) = agy_merge_media_lines(&media_paths, user_text) else {
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
                let media_paths = agy_extract_media_paths(&v);
                let content_body = get_str(&v, "content")
                    .filter(|s| !s.trim().is_empty())
                    .map(String::from);
                if let Some(c) = agy_merge_media_lines(&media_paths, content_body) {
                    blocks.push(text_block(c));
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
                    || !agy_extract_media_paths(v).is_empty()
                {
                    return "working";
                }
            }
            _ => {}
        }
    }
    "unknown"
}

/// 解析 `<agy_root>/conversation_summaries.db#<cid>` 形式的虚拟路径
pub(crate) fn agy_split_db_target(file_path: &str) -> Option<(&Path, &str)> {
    let (db_raw, cid) = file_path.split_once('#')?;
    if !valid_agy_cid(cid) {
        return None;
    }
    let db = Path::new(db_raw);
    (db.file_name().and_then(|n| n.to_str()) == Some("conversation_summaries.db"))
        .then_some((db, cid))
}

/// 当原以 `<db>#<cid>` 关联的会话在后续步骤导出了 `brain/<cid>/.system_generated/logs/transcript*.jsonl`，
/// 自动升级读取完整日志文件（保留工具调用、thinking 与 token 统计）
pub(crate) fn agy_resolve_live_transcript(db_path: &Path, cid: &str) -> Option<PathBuf> {
    if !valid_agy_cid(cid) {
        return None;
    }
    let agy_root = db_path.parent()?;
    let logs = agy_root
        .join("brain")
        .join(cid)
        .join(".system_generated")
        .join("logs");
    let full = logs.join("transcript_full.jsonl");
    if full.is_file() {
        return Some(full);
    }
    let compact = logs.join("transcript.jsonl");
    compact.is_file().then_some(compact)
}

fn agy_slice_fts_steps(
    offsets_raw: Option<&[u8]>,
    body: &str,
    role: &'static str,
) -> Vec<(i64, &'static str, String)> {
    let Some(bytes) = offsets_raw.filter(|b| !b.is_empty()) else {
        return Vec::new();
    };
    let Ok(pairs) = serde_json::from_slice::<Vec<(i64, usize)>>(bytes) else {
        return Vec::new();
    };
    if pairs.is_empty() {
        return Vec::new();
    }
    let body_bytes = body.as_bytes();
    let mut out = Vec::with_capacity(pairs.len());
    for i in 0..pairs.len() {
        let (step_idx, start) = pairs[i];
        let end = pairs
            .get(i + 1)
            .map(|(_, next)| (*next).min(body_bytes.len()))
            .unwrap_or(body_bytes.len());
        if start >= end || start > body_bytes.len() {
            continue;
        }
        let raw_piece = String::from_utf8_lossy(&body_bytes[start..end]);
        let piece = raw_piece
            .strip_suffix('\n')
            .unwrap_or(&raw_piece)
            .strip_suffix('\r')
            .unwrap_or_else(|| raw_piece.strip_suffix('\n').unwrap_or(&raw_piece));
        let cleaned = if role == "user" {
            agy_extract_user_text(piece).unwrap_or_else(|| piece.trim().to_string())
        } else {
            piece.to_string()
        };
        if !cleaned.trim().is_empty() {
            out.push((step_idx, role, cleaned));
        }
    }
    out
}

/// 只读从 `conversation_summaries.db` 的 `conversations_fts` 还原未导出 `brain/` 会话的完整问答消息
pub(crate) fn agy_parse_fts_db(db_path: &Path, cid: &str) -> Vec<ChatMessageDto> {
    if !valid_agy_cid(cid) {
        return Vec::new();
    }
    let Some(conn) = open_opencode_db(db_path) else {
        return Vec::new();
    };
    let cid_owned = cid.to_string();
    let rows = query_rows(
        &conn,
        "SELECT chunk_index, last_step_created_at, user_step_byte_offsets, agent_step_byte_offsets, user_body, agent_body \
         FROM conversations_fts WHERE conversation_id = ?1 ORDER BY CAST(chunk_index AS INTEGER) ASC",
        &[&cid_owned],
    );
    let mut last_ts: Option<String> = None;
    let mut steps: Vec<(i64, &'static str, String)> = Vec::new();
    for (names, vals) in rows {
        let row = DbRow { names, vals };
        let chunk_idx = row
            .as_i64("chunk_index")
            .or_else(|| row.as_str("chunk_index").and_then(|s| s.parse::<i64>().ok()))
            .unwrap_or(0);
        if chunk_idx < 0 {
            last_ts = row.as_i64("last_step_created_at").and_then(agy_ns_to_iso);
            continue;
        }
        let user_body = row.as_str("user_body").unwrap_or_default();
        let agent_body = row.as_str("agent_body").unwrap_or_default();
        steps.extend(agy_slice_fts_steps(
            row.as_bytes("user_step_byte_offsets"),
            &user_body,
            "user",
        ));
        steps.extend(agy_slice_fts_steps(
            row.as_bytes("agent_step_byte_offsets"),
            &agent_body,
            "assistant",
        ));
    }
    steps.sort_by_key(|(idx, _, _)| *idx);
    let mut deduped: Vec<(i64, &'static str, String)> = Vec::with_capacity(steps.len());
    for item in steps {
        if let Some(last) = deduped.last_mut().filter(|(idx, _, _)| *idx == item.0) {
            *last = item;
        } else {
            deduped.push(item);
        }
    }
    let total = deduped.len();
    deduped
        .into_iter()
        .enumerate()
        .map(|(pos, (step_idx, role, text))| ChatMessageDto {
            role: role.into(),
            blocks: vec![text_block(text)],
            timestamp: (pos + 1 == total).then(|| last_ts.clone()).flatten(),
            usage: None,
            id: Some(step_idx.to_string()),
            cwd: None,
        })
        .collect()
}

/// 将仅落库会话导出为标准 `agy` JSONL 行，供 `pin_session` 生成与普通 transcript 同构的快照文件
pub(crate) fn agy_fts_synthetic_lines(db_path: &Path, cid: &str) -> Result<Vec<String>, String> {
    let msgs = agy_parse_fts_db(db_path, cid);
    if msgs.is_empty() {
        return Err("会话尚无可导出的消息内容".into());
    }
    let mut lines = Vec::with_capacity(msgs.len());
    for (idx, m) in msgs.into_iter().enumerate() {
        let step_index = m
            .id
            .as_deref()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(idx as i64);
        let text = m
            .blocks
            .into_iter()
            .filter(|b| b.kind == "text")
            .map(|b| b.text)
            .collect::<Vec<_>>()
            .join("\n");
        let step_type = if m.role == "user" {
            "USER_INPUT"
        } else {
            "PLANNER_RESPONSE"
        };
        let content = if m.role == "user" {
            format!("<USER_REQUEST>{text}</USER_REQUEST>")
        } else {
            text
        };
        let obj = serde_json::json!({
            "step_index": step_index,
            "type": step_type,
            "status": "DONE",
            "created_at": m.timestamp.unwrap_or_default(),
            "content": content,
        });
        lines.push(obj.to_string());
    }
    Ok(lines)
}

pub(crate) fn agy_conversation_page(
    db_path: &Path,
    cid: &str,
    before: Option<u64>,
    around: Option<u64>,
) -> Result<ConversationPageDto, String> {
    if let Some(promoted) = agy_resolve_live_transcript(db_path, cid) {
        return plain_conversation_page("agy", &promoted, before, around);
    }
    let all = agy_parse_fts_db(db_path, cid);
    let end = match before {
        Some(b) => (b as usize).min(all.len()),
        None => all.len(),
    };
    let start = end.saturating_sub(OPENCODE_PAGE_MESSAGES);
    let cursor = (start > 0).then_some(start as u64);
    let mut messages = all[start..end].to_vec();
    redact_conversation(&mut messages);
    Ok(ConversationPageDto { messages, cursor })
}

pub(crate) fn agy_db_tail_state(db_path: &Path, cid: &str) -> &'static str {
    if let Some(promoted) = agy_resolve_live_transcript(db_path, cid) {
        let lines = last_lines(&promoted, 64 * 1024);
        if !lines.is_empty() {
            return agy_tail_state(&lines);
        }
    }
    let msgs = agy_parse_fts_db(db_path, cid);
    let Some(last) = msgs.last() else {
        return "unknown";
    };
    match last.role.as_str() {
        "user" => "working",
        "assistant" => {
            let text = last
                .blocks
                .iter()
                .rev()
                .find(|b| b.kind == "text")
                .map(|b| b.text.as_str())
                .unwrap_or("");
            if ends_with_question(text) {
                "confirm"
            } else {
                "done"
            }
        }
        _ => "unknown",
    }
}

pub(crate) fn agy_db_file_sig(db_path: &Path, cid: &str) -> Option<(u64, u64)> {
    if let Some(promoted) = agy_resolve_live_transcript(db_path, cid) {
        let md = std::fs::metadata(promoted).ok()?;
        let mtime_ms = md
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis() as u64;
        return Some((mtime_ms | (1u64 << 62), md.len()));
    }
    let conn = open_opencode_db(db_path)?;
    let cid_owned = cid.to_string();
    let meta_row = query_rows(
        &conn,
        "SELECT step_count, last_step_created_at FROM conversations_fts WHERE conversation_id = ?1 AND chunk_index = -1",
        &[&cid_owned],
    )
    .into_iter()
    .next();
    let (steps, last_ns) = meta_row
        .map(|(names, vals)| {
            let row = DbRow { names, vals };
            (
                row.as_i64("step_count").unwrap_or(0).max(0) as u64,
                row.as_i64("last_step_created_at").unwrap_or(0).max(0) as u64,
            )
        })
        .unwrap_or((0, 0));
    let conv_mtime_ms = db_path
        .parent()
        .map(|r| r.join("conversations").join(format!("{cid}.db")))
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let wal_len = std::fs::metadata(format!("{}-wal", db_path.display()))
        .map(|m| m.len())
        .unwrap_or(0);
    let stamp = (last_ns / 1_000_000).max(conv_mtime_ms);
    Some((stamp, (steps << 32) ^ wal_len))
}

fn agy_root_from_session_file(file_path: &str) -> Option<PathBuf> {
    if let Some((db, _)) = agy_split_db_target(file_path) {
        return db.parent().map(Path::to_path_buf);
    }
    let p = Path::new(file_path);
    let logs = p.parent().filter(|d| d.file_name().and_then(|n| n.to_str()) == Some("logs"))?;
    let sys = logs
        .parent()
        .filter(|d| d.file_name().and_then(|n| n.to_str()) == Some(".system_generated"))?;
    let conv_dir = sys.parent()?;
    let brain_dir = conv_dir
        .parent()
        .filter(|d| d.file_name().and_then(|n| n.to_str()) == Some("brain"))?;
    brain_dir.parent().map(Path::to_path_buf)
}

/// 若会话落在非默认 `--gemini_dir`（如 `~/.cc-switch/agy/<provider>/antigravity-cli`），返回续聊所需的 `<gemini_dir>`
pub(crate) fn agy_gemini_dir_for_session_file(
    file_path: &str,
    default_agy_root: &Path,
) -> Option<PathBuf> {
    let agy_root = agy_root_from_session_file(file_path)?;
    if crate::paths::same_path(
        &agy_root.to_string_lossy(),
        &default_agy_root.to_string_lossy(),
    ) {
        return None;
    }
    (agy_root.file_name().and_then(|n| n.to_str()) == Some("antigravity-cli"))
        .then(|| agy_root.parent().map(Path::to_path_buf))
        .flatten()
}

#[cfg_attr(test, allow(dead_code))]
pub(crate) fn agy_session_gemini_dir(session_id: &str) -> Option<PathBuf> {
    if !valid_agy_cid(session_id) {
        return None;
    }
    let roots = SessionRoots::current()?;
    let scan = cached_scan();
    if let Some(hit) = scan
        .sessions
        .iter()
        .find(|s| s.agent == "agy" && s.session_id == session_id)
    {
        return agy_gemini_dir_for_session_file(&hit.file_path, &roots.agy);
    }
    for (root, gemini_dir) in agy_data_roots(&roots.agy) {
        let Some(dir) = gemini_dir else {
            continue;
        };
        if agy_resolve_live_transcript(&root, session_id).is_some()
            || root
                .join("conversations")
                .join(format!("{session_id}.db"))
                .is_file()
        {
            return Some(dir);
        }
    }
    None
}

fn remove_path_mode(target: &Path, permanent: bool) -> Result<(), String> {
    if !target.exists() {
        return Ok(());
    }
    if permanent {
        if target.is_dir() {
            fs::remove_dir_all(target)
                .map_err(|e| format!("删除 {} 失败: {e}", target.display()))?;
        } else {
            fs::remove_file(target)
                .map_err(|e| format!("删除 {} 失败: {e}", target.display()))?;
        }
    } else {
        crate::projects::trash_to_recycle_bin(target)
            .map_err(|e| format!("删除 {} 失败: {e}", target.display()))?;
    }
    Ok(())
}

/// 删除 agy 会话：校验所属 `<agy_root>/brain` 在会话目录白名单内后，一并移除 `brain/<id>/` 与
/// `conversations/<id>.db`（避免删完 brain 目录后下次扫描又以仅落库对话复活）；绝不写 `conversation_summaries.db`
pub(super) fn delete_agy_session_dir(
    file_path: &str,
    dirs: &[(PathBuf, bool)],
    permanent: bool,
) -> Result<bool, String> {
    let is_known_agy_root = |agy_root: &Path| -> bool {
        let brain = agy_root.join("brain");
        let convs = agy_root.join("conversations");
        dirs.iter().any(|(allowed, _)| {
            let same_raw = crate::paths::same_path(
                &allowed.to_string_lossy(),
                &brain.to_string_lossy(),
            ) || crate::paths::same_path(
                &allowed.to_string_lossy(),
                &convs.to_string_lossy(),
            );
            if same_raw {
                return true;
            }
            let Ok(canon_allowed) = allowed.canonicalize() else {
                return false;
            };
            brain
                .canonicalize()
                .ok()
                .is_some_and(|cb| cb == canon_allowed)
                || convs
                    .canonicalize()
                    .ok()
                    .is_some_and(|cc| cc == canon_allowed)
        })
    };

    if let Some((db, cid)) = agy_split_db_target(file_path) {
        let Some(agy_root) = db.parent() else {
            return Err(format!("无效的 Antigravity 会话路径: {file_path}"));
        };
        if !is_known_agy_root(agy_root) {
            return Err(format!(
                "拒绝删除非会话数据目录下的 Antigravity 会话: {file_path}"
            ));
        }
        let session_dir = agy_root.join("brain").join(cid);
        let conv_db = agy_root.join("conversations").join(format!("{cid}.db"));
        let conv_wal = agy_root.join("conversations").join(format!("{cid}.db-wal"));
        let conv_shm = agy_root.join("conversations").join(format!("{cid}.db-shm"));
        if !session_dir.exists() && !conv_db.exists() {
            return Ok(false);
        }
        remove_path_mode(&session_dir, permanent)?;
        remove_path_mode(&conv_db, permanent)?;
        let _ = fs::remove_file(conv_wal);
        let _ = fs::remove_file(conv_shm);
        return Ok(true);
    }

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
    if let Some(session_dir) = canon_file
        .parent()
        .filter(|d| d.file_name().and_then(|n| n.to_str()) == Some("logs"))
        .and_then(|d| d.parent())
        .filter(|d| d.file_name().and_then(|n| n.to_str()) == Some(".system_generated"))
        .and_then(|d| d.parent())
    {
        let cid = session_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        let agy_root = session_dir.parent().and_then(Path::parent);
        if valid_agy_cid(cid) && agy_root.is_some_and(is_known_agy_root) {
            remove_path_mode(session_dir, permanent)?;
            if let Some(root) = agy_root {
                let conv_db = root.join("conversations").join(format!("{cid}.db"));
                let conv_wal = root.join("conversations").join(format!("{cid}.db-wal"));
                let conv_shm = root.join("conversations").join(format!("{cid}.db-shm"));
                remove_path_mode(&conv_db, permanent)?;
                let _ = fs::remove_file(conv_wal);
                let _ = fs::remove_file(conv_shm);
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

    #[test]
    fn agy_scans_db_only_fts_sessions_multi_roots_and_promotes_live_transcript() {
        let tmp = TempDir::new();
        let default_root = tmp.path().join(".gemini/antigravity-cli");
        let cc_provider = tmp.path().join(".cc-switch/agy/provider-a");
        let cc_root = cc_provider.join("antigravity-cli");
        fs::create_dir_all(default_root.join("cache")).unwrap();
        fs::create_dir_all(default_root.join("conversations")).unwrap();
        fs::create_dir_all(cc_root.join("conversations")).unwrap();

        // 1) 默认根：造一条未导出 brain/ 的外部纯文字多轮中文对话（模仿真实 f15dea76 / b12f4f34）
        //    + 一条 is_internal 会话（应被过滤）
        let db_path = default_root.join("conversation_summaries.db");
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
                CREATE VIRTUAL TABLE conversations_fts USING fts5(
                    conversation_id UNINDEXED,
                    chunk_index UNINDEXED,
                    chunk_first_step UNINDEXED,
                    chunk_last_step UNINDEXED,
                    step_count UNINDEXED,
                    last_step_created_at UNINDEXED,
                    archived UNINDEXED,
                    workspace,
                    title,
                    user_step_byte_offsets UNINDEXED,
                    agent_step_byte_offsets UNINDEXED,
                    user_body,
                    agent_body
                );
                INSERT INTO conversation_summaries VALUES
                    ('ext-fts-1', '', '', '0001-01-01 00:00:00+00:00', '', '', 0, 'antigravity-cli'),
                    ('internal-1', '内部任务', '', '2026-11-14 01:00:00+00:00', '[\"file:///tmp/p\"]', '', 0, 'antigravity-cli');",
            )
            .unwrap();
            // user_body: "你好\n再来一段" -> "你好\n" 占 7 字节，第二句从偏移 7 开始
            let user_body = "你好\n再来一段";
            let user_offsets = br#"[[0,0],[2,7]]"#.to_vec();
            // agent_body: "你好！\n收到第二段？" -> "你好！\n" 占 10 字节，第二句从偏移 10 开始
            let agent_body = "你好！\n收到第二段？";
            let agent_offsets = br#"[[1,0],[3,10]]"#.to_vec();
            conn.execute(
                "INSERT INTO conversations_fts VALUES ('ext-fts-1', -1, 0, 0, 4, 1794621552000000000, 0, 'scratch', '你好', '', '', '', '')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO conversations_fts VALUES ('ext-fts-1', 0, 0, 3, 0, 0, 0, '', '', ?1, ?2, ?3, ?4)",
                rusqlite::params![user_offsets, agent_offsets, user_body, agent_body],
            )
            .unwrap();
        }
        fs::write(default_root.join("conversations/ext-fts-1.db"), b"sqlite-stub").unwrap();
        fs::write(default_root.join("conversations/internal-1.db"), b"sqlite-stub").unwrap();
        fs::write(
            default_root.join("cache/conversation_metadata.json"),
            r#"{"conversations":{"internal-1":{"is_internal":true,"summary":{"Internal":true}}}}"#,
        )
        .unwrap();
        // last_conversations.json 已被更新的会话覆盖，ext-fts-1 靠 history.jsonl 找回工作目录
        fs::write(
            default_root.join("history.jsonl"),
            "{\"display\":\"你好\",\"workspace\":\"/tmp/scratch-proj\",\"conversationId\":\"ext-fts-1\"}\n",
        )
        .unwrap();

        // 2) ~/.cc-switch/agy/provider-a/antigravity-cli 隔离根下的外部会话
        let cc_logs = cc_root
            .join("brain")
            .join("cc-ext-1")
            .join(".system_generated/logs");
        fs::create_dir_all(&cc_logs).unwrap();
        fs::write(
            cc_logs.join("transcript_full.jsonl"),
            "{\"step_index\":0,\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"created_at\":\"2026-11-14T02:00:00Z\",\"content\":\"<USER_REQUEST>外部 cc-switch 会话</USER_REQUEST>\"}\n",
        )
        .unwrap();

        let mut cache = HashMap::new();
        let mut sigs = HashMap::new();
        let mut maps = HashMap::new();
        let found = agy_scan_roots(&default_root, &mut cache, &mut sigs, &mut maps);
        let ids: Vec<&str> = found.iter().map(|m| m.session_id.as_str()).collect();
        assert_eq!(ids, vec!["ext-fts-1", "cc-ext-1"], "{found:?}");

        let fts_meta = found.iter().find(|m| m.session_id == "ext-fts-1").unwrap();
        assert!(fts_meta.file_path.ends_with("conversation_summaries.db#ext-fts-1"));
        assert_eq!(fts_meta.cwd.as_deref(), Some("/tmp/scratch-proj"));
        // 首句「你好」为寒暄被 usable_title 跳过，标题自动落到第二轮实质输入「再来一段」
        assert_eq!(fts_meta.title.as_deref(), Some("再来一段"));
        assert_eq!(agy_gemini_dir_for_session_file(&fts_meta.file_path, &default_root), None);

        let cc_meta = found.iter().find(|m| m.session_id == "cc-ext-1").unwrap();
        assert_eq!(
            agy_gemini_dir_for_session_file(&cc_meta.file_path, &default_root),
            Some(cc_provider.clone())
        );

        // 只读还原 FTS 多轮问答消息与尾部状态（最后一句带问号 → confirm）
        let msgs = conversation_impl("agy", &fts_meta.file_path);
        assert_eq!(msgs.len(), 4, "{msgs:?}");
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].text, "你好");
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].blocks[0].text, "你好！");
        assert_eq!(msgs[2].blocks[0].text, "再来一段");
        assert_eq!(msgs[3].blocks[0].text, "收到第二段？");
        assert_eq!(tail_state_impl("agy", &fts_meta.file_path), "confirm");

        // 运行中导出 brain/ext-fts-1/.../transcript_full.jsonl 后，旧 `#` 路径无缝升级读完整日志
        let promoted_logs = default_root
            .join("brain")
            .join("ext-fts-1")
            .join(".system_generated/logs");
        fs::create_dir_all(&promoted_logs).unwrap();
        fs::write(
            promoted_logs.join("transcript_full.jsonl"),
            concat!(
                "{\"step_index\":0,\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"media\":[{\"mime_type\":\"image/png\",\"uri\":\"file:///tmp/demo%20shot.png\"}],\"content\":\"<USER_REQUEST>看这张图</USER_REQUEST>\"}\n",
                "{\"step_index\":1,\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"id\":\"c1\",\"name\":\"run_command\",\"args\":{\"CommandLine\":\"echo hi\"}}]}\n",
                "{\"step_index\":2,\"type\":\"GENERIC\",\"status\":\"DONE\",\"content\":\"Created At: 2026-11-14T02:00:01Z\\nCompleted At: 2026-11-14T02:00:02Z\\nCreated At: 2026-11-14T02:00:01Z\\nCompleted At: 2026-11-14T02:00:02Z\\nhi\\n\"}\n",
                "{\"step_index\":3,\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"content\":\"执行完毕。\"}\n"
            ),
        )
        .unwrap();
        let upgraded = conversation_impl("agy", &fts_meta.file_path);
        assert_eq!(upgraded.len(), 3, "{upgraded:?}");
        assert!(upgraded[0].blocks[0].text.starts_with("/tmp/demo shot.png\n看这张图"));
        assert_eq!(upgraded[1].blocks[1].text.trim(), "hi", "重复的 Created/Completed 头均须剥净");
        assert_eq!(tail_state_impl("agy", &fts_meta.file_path), "done");

        // 删除会话同时清掉 brain/<id> 与 conversations/<id>.db，防止仅落库记录死灰复燃，且不碰 summaries.db
        let allowed = vec![(default_root.join("brain"), false)];
        let deleted = delete_agy_session_dir(&fts_meta.file_path, &allowed, true).unwrap();
        assert!(deleted);
        assert!(!default_root.join("brain/ext-fts-1").exists());
        assert!(!default_root.join("conversations/ext-fts-1.db").exists());
        assert!(db_path.exists());
    }
}
