use super::*;

/// OpenCode 数据目录候选：OPENCODE_DB 优先；再是 $XDG_DATA_HOME/opencode（OpenCode 按 XDG 规范取数据目录）；
/// Windows 再探 %LOCALAPPDATA%\opencode 与 %APPDATA%\opencode；最后回落 unix 形态 ~/.local/share/opencode。
pub(crate) fn opencode_db_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var("OPENCODE_DB") {
        if !p.is_empty() {
            out.push(PathBuf::from(p));
        }
    }
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        out.push(PathBuf::from(xdg).join("opencode").join("opencode.db"));
    }
    #[cfg(windows)]
    {
        if let Some(local) = crate::dirs::data_local_dir() {
            out.push(local.join("opencode").join("opencode.db"));
        }
        if let Some(roaming) = crate::dirs::data_dir() {
            out.push(roaming.join("opencode").join("opencode.db"));
        }
    }
    if let Some(h) = crate::dirs::home_dir() {
        out.push(
            h.join(".local")
                .join("share")
                .join("opencode")
                .join("opencode.db"),
        );
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(crate::paths::path_key(&p.to_string_lossy())));
    out
}

#[cfg(test)]
pub(super) fn opencode_db_path() -> Option<PathBuf> {
    let cands = opencode_db_candidates();
    cands
        .iter()
        .find(|p| p.exists())
        .cloned()
        .or_else(|| cands.into_iter().next())
}

pub(super) fn is_known_opencode_db(path: &Path) -> bool {
    let got = crate::paths::path_key(&path.to_string_lossy());
    let got_canon = path
        .canonicalize()
        .ok()
        .map(|p| crate::paths::path_key(&p.to_string_lossy()));
    opencode_db_candidates().iter().any(|c| {
        let k = crate::paths::path_key(&c.to_string_lossy());
        if k == got {
            return true;
        }
        let c_canon = c
            .canonicalize()
            .ok()
            .map(|p| crate::paths::path_key(&p.to_string_lossy()));
        matches!((got_canon.as_ref(), c_canon.as_ref()), (Some(a), Some(b)) if a == b)
    })
}

/// WAL 模式只读打开 + busy_timeout；库不存在/打不开都返回 None（扫描时跳过）
pub(crate) fn open_opencode_db(path: &Path) -> Option<Connection> {
    if !path.exists() {
        return None;
    }
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(3));
    Some(conn)
}

// drizzle 迁移频繁，列级防御：SELECT * 后按列名取值，缺列给默认值而不是报错
pub(crate) fn query_rows(
    conn: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Vec<(Vec<String>, Vec<rusqlite::types::Value>)> {
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let Ok(rows) = stmt.query(params) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut rows = rows;
    while let Ok(Some(row)) = rows.next() {
        let mut vals = Vec::new();
        for i in 0..names.len() {
            vals.push(
                row.get::<_, rusqlite::types::Value>(i)
                    .unwrap_or(rusqlite::types::Value::Null),
            );
        }
        out.push((names.clone(), vals));
    }
    out
}

// 行 -> 按名取值的小包装，复用 col_string/col_i64 的防御逻辑
pub(crate) struct DbRow {
    pub names: Vec<String>,
    pub vals: Vec<rusqlite::types::Value>,
}

impl DbRow {
    pub(crate) fn as_str(&self, key: &str) -> Option<String> {
        self.names
            .iter()
            .position(|n| n == key)
            .and_then(|i| match &self.vals[i] {
                rusqlite::types::Value::Text(s) => Some(s.clone()),
                rusqlite::types::Value::Integer(n) => Some(n.to_string()),
                _ => None,
            })
    }

    pub(crate) fn as_i64(&self, key: &str) -> Option<i64> {
        self.names
            .iter()
            .position(|n| n == key)
            .and_then(|i| match &self.vals[i] {
                rusqlite::types::Value::Integer(n) => Some(*n),
                rusqlite::types::Value::Real(f) => Some(*f as i64),
                _ => None,
            })
    }
}

pub(super) fn opencode_ms_to_iso(ms: i64) -> String {
    iso_from_unix(if ms >= 0 { (ms / 1000) as u64 } else { 0 })
}

pub(super) fn opencode_usage(
    input: i64,
    output: i64,
    reasoning: i64,
    cache_read: i64,
    cache_write: i64,
) -> TokenUsageDto {
    TokenUsageDto {
        input: input as u64,
        // reasoning 计入输出侧，与 Codex 口径一致
        output: (output + reasoning) as u64,
        cache_read: cache_read as u64,
        cache_write: cache_write as u64,
    }
}

pub(super) fn opencode_scan_db(db_path: &Path) -> Vec<SessionMetaDto> {
    let Some(conn) = open_opencode_db(db_path) else {
        return Vec::new();
    };
    // project_id → worktree（"global" 项目没有 worktree，回落 session.directory）
    let mut worktrees: HashMap<String, String> = HashMap::new();
    for row in query_rows(&conn, "SELECT * FROM project", &[]) {
        let row = DbRow {
            names: row.0,
            vals: row.1,
        };
        if let (Some(id), Some(wt)) = (row.as_str("id"), row.as_str("worktree")) {
            worktrees.insert(id, wt);
        }
    }
    // 1.x 表 session 与 2.x 表 session_v2 列相同；升级时旧会话复制进新表、旧表保留，
    // 同一 id 两边都有时留 time_updated 新的那份（平手留 2.x），读消息时 opencode_store_of 同口径选表
    let mut picked: HashMap<String, (OpencodeStore, DbRow)> = HashMap::new();
    for (store, table) in [(OpencodeStore::V1, "session"), (OpencodeStore::V2, "session_v2")] {
        for row in query_rows(&conn, &format!("SELECT * FROM {table}"), &[]) {
            let row = DbRow {
                names: row.0,
                vals: row.1,
            };
            let Some(id) = row.as_str("id") else {
                continue;
            };
            let newer = picked.get(&id).map_or(true, |(_, old)| {
                row.as_i64("time_updated").unwrap_or(0) >= old.as_i64("time_updated").unwrap_or(0)
            });
            if newer {
                picked.insert(id, (store, row));
            }
        }
    }
    let mut picked: Vec<(String, (OpencodeStore, DbRow))> = picked.into_iter().collect();
    picked.sort_by_key(|(_, (_, row))| row.as_i64("time_created").unwrap_or(0));
    let mut stores: HashMap<String, OpencodeStore> = HashMap::new();
    let mut out = Vec::new();
    for (id, (store, row)) in picked {
        stores.insert(id.clone(), store);
        let project_id = row.as_str("project_id").unwrap_or_default();
        let directory = row.as_str("directory").unwrap_or_default();
        let project_path = if project_id.is_empty() || project_id == "global" {
            directory
        } else {
            worktrees.get(&project_id).cloned().unwrap_or(directory)
        };
        let t = |k: &str| row.as_i64(k).unwrap_or(0);
        let token_usage = if t("tokens_input") + t("tokens_output") + t("tokens_reasoning") > 0 {
            Some(opencode_usage(
                t("tokens_input"),
                t("tokens_output"),
                t("tokens_reasoning"),
                t("tokens_cache_read"),
                t("tokens_cache_write"),
            ))
        } else {
            None
        };
        // opencode 没有单会话文件：用行的 time_updated 判活（60 秒内被写过即在跑）
        let live = row
            .as_i64("time_updated")
            .map(|ms| {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                (now_ms - ms).abs() <= 60_000
            })
            .unwrap_or(false);
        out.push(SessionMetaDto {
            agent: "opencode".into(),
            session_id: id.clone(),
            project_path: project_path.clone(),
            cwd: Some(project_path.clone()),
            title: row.as_str("title").and_then(|t| usable_title(&t)),
            created_at: row.as_i64("time_created").map(opencode_ms_to_iso),
            updated_at: row.as_i64("time_updated").map(opencode_ms_to_iso),
            // 没有单会话文件：db 路径 + "#" + session_id，pin/回放据此定位
            file_path: format!("{}#{}", db_path.display(), id),
            token_usage,
            cli_version: row.as_str("version"),
            pinned: false,
            archived: false,
            custom_title: None,
            tags: Vec::new(),
            alive: true, // 行在即在
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
        });
    }
    // OpenCode 新会话常暂存为 "New Session"：只对占位标题的会话惰性补标题——
    // 按 session_id 限量查最早的消息，不再全表扫 message 逐行解析 JSON。
    // LIMIT 是防御兜底：首条真实用户消息通常就是最前面几条之一
    for m in out.iter_mut().filter(|m| m.title.is_none()) {
        let sid = m.session_id.clone();
        if stores.get(&sid) == Some(&OpencodeStore::V2) {
            m.title = opencode_v2_first_user_title(&conn, &sid);
            continue;
        }
        for row in query_rows(
            &conn,
            "SELECT * FROM message WHERE session_id=? ORDER BY time_created ASC LIMIT 20",
            &[&sid],
        ) {
            let row = DbRow {
                names: row.0,
                vals: row.1,
            };
            let Some(data) = row.as_str("data") else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&data) else {
                continue;
            };
            if get_str(&value, "role") != Some("user") {
                continue;
            }
            if let Some(text) = opencode_user_text(&value, &[]) {
                if let Some(title) = usable_title(&text) {
                    m.title = Some(title);
                    break;
                }
            }
        }
    }
    out
}

/// part.data → 块：text / reasoning→thinking / tool→tool_use(+tool_result)；
/// step-start/finish、file、snapshot、agent、retry、subtask、compaction 等一律跳过
pub(super) fn opencode_part_blocks(data: &Value) -> Vec<BlockDto> {
    let mut blocks = Vec::new();
    match get_str(data, "type") {
        Some("text") => {
            if let Some(t) = get_str(data, "text") {
                if !t.trim().is_empty() {
                    blocks.push(text_block(t.to_string()));
                }
            }
        }
        Some("reasoning") => {
            if let Some(t) = get_str(data, "text") {
                if !t.trim().is_empty() {
                    blocks.push(BlockDto {
                        kind: "thinking".into(),
                        text: t.to_string(),
                        tool_name: None,
                        is_error: false,
                        call_id: None,
                    });
                }
            }
        }
        Some("tool") => {
            let state = data.get("state");
            let input = state.and_then(|s| s.get("input"));
            blocks.push(BlockDto {
                kind: "tool_use".into(),
                text: input.map(|i| i.to_string()).unwrap_or_default(),
                tool_name: get_str(data, "tool").map(String::from),
                is_error: false,
                call_id: None,
            });
            // 完成给 output、失败给 error；进行中的调用只有 tool_use
            let result = state
                .and_then(|s| s.get("output"))
                .map(|v| stringify_payload(Some(v)));
            let error = state
                .and_then(|s| s.get("error"))
                .map(|v| stringify_payload(Some(v)));
            let text = match (result, error) {
                (Some(o), _) if !o.is_empty() => o,
                (_, Some(e)) if !e.is_empty() => e,
                _ => String::new(),
            };
            if !text.is_empty() {
                blocks.push(BlockDto {
                    kind: "tool_result".into(),
                    text,
                    tool_name: None,
                    is_error: false,
                    call_id: None,
                });
            }
        }
        _ => {}
    }
    blocks
}

/// 用户消息文本：summary.body（或字符串 summary）→ parts 里的 text
pub(super) fn opencode_user_text(data: &Value, parts: &[&Value]) -> Option<String> {
    let summary = data.get("summary");
    let from_summary = summary
        .and_then(|s| get_str(s, "body").or_else(|| s.as_str()))
        .filter(|t| !t.trim().is_empty())
        .map(String::from);
    from_summary.or_else(|| {
        let text = parts
            .iter()
            .filter_map(|p| {
                if get_str(p, "type") == Some("text") {
                    get_str(p, "text")
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
    })
}

/// message.data + 其 parts → ChatMessageDto；非 user/assistant 返回 None
pub(super) fn opencode_message(
    data: &Value,
    parts: Vec<&Value>,
    ts_ms: Option<i64>,
) -> Option<ChatMessageDto> {
    let ts = ts_ms
        .or_else(|| {
            data.get("time")
                .and_then(|t| t.get("created"))
                .and_then(|t| t.as_i64())
        })
        .map(opencode_ms_to_iso);
    match get_str(data, "role") {
        Some("user") => {
            let text = opencode_user_text(data, &parts)?;
            Some(ChatMessageDto {
                role: "user".into(),
                blocks: vec![text_block(text)],
                timestamp: ts,
                usage: None,
                id: None,
                cwd: None,
            })
        }
        Some("assistant") => {
            let mut blocks = Vec::new();
            for p in parts {
                blocks.extend(opencode_part_blocks(p));
            }
            if blocks.is_empty() {
                return None;
            }
            let usage = data.get("tokens").map(|t| {
                let num = |k: &str| t.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
                let cache = t.get("cache");
                let cnum = |k: &str| {
                    cache
                        .and_then(|c| c.get(k))
                        .and_then(|x| x.as_i64())
                        .unwrap_or(0)
                };
                opencode_usage(
                    num("input"),
                    num("output"),
                    num("reasoning"),
                    cnum("read"),
                    cnum("write"),
                )
            });
            Some(ChatMessageDto {
                role: "assistant".into(),
                blocks,
                timestamp: ts,
                usage,
                id: None,
                cwd: None,
            })
        }
        _ => None,
    }
}

// ----- OpenCode 2.x：session_v2 / session_message / session_part -----
// 2.x 换了表：会话在 session_v2（列同 1.x session）；消息在 session_message（type 列 + data，data 不含 id / type，
// 用户话在 data.text，assistant 内容在 data.content[]）；assistant 有 session_part 行时以 part 为准（按 ordinal）。
// 1.x 库升级时旧会话复制进新表、旧表保留，所以两套表都读；下面把 2.x 的行规整成 1.x 的 (message.data, parts) 形状，
// 出块、快照、搜索都沿用 1.x 那一套。

/// 一个会话的消息该读哪套表
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum OpencodeStore {
    V1,
    V2,
}

impl OpencodeStore {
    pub(super) fn message_table(self) -> &'static str {
        match self {
            OpencodeStore::V1 => "message",
            OpencodeStore::V2 => "session_message",
        }
    }

    pub(super) fn session_table(self) -> &'static str {
        match self {
            OpencodeStore::V1 => "session",
            OpencodeStore::V2 => "session_v2",
        }
    }
}

pub(super) fn opencode_session_updated(conn: &Connection, store: OpencodeStore, sid: &str) -> Option<i64> {
    conn.query_row(
        &format!("SELECT time_updated FROM {} WHERE id=?1", store.session_table()),
        params![sid],
        |r| r.get::<_, i64>(0),
    )
    .ok()
}

/// 只在一边有就读那边；两边都有（升级时复制）读 time_updated 新的，平手读 2.x（与列表去重同口径）
pub(crate) fn opencode_store_of(conn: &Connection, sid: &str) -> OpencodeStore {
    match (
        opencode_session_updated(conn, OpencodeStore::V1, sid),
        opencode_session_updated(conn, OpencodeStore::V2, sid),
    ) {
        (Some(v1), Some(v2)) if v1 > v2 => OpencodeStore::V1,
        (_, Some(_)) => OpencodeStore::V2,
        _ => OpencodeStore::V1,
    }
}

/// 两套表里这个会话最新的 time_updated（文件签名用）
pub(super) fn opencode_latest_updated(conn: &Connection, sid: &str) -> Option<i64> {
    let v1 = opencode_session_updated(conn, OpencodeStore::V1, sid);
    let v2 = opencode_session_updated(conn, OpencodeStore::V2, sid);
    v1.max(v2)
}

/// 工具结果 content[]：文本拼起来，文件只留名字
pub(super) fn opencode_v2_content_text(content: Option<&Value>) -> String {
    let Some(items) = content.and_then(|c| c.as_array()) else {
        return content.map(|c| stringify_payload(Some(c))).unwrap_or_default();
    };
    items
        .iter()
        .filter_map(|item| match get_str(item, "type") {
            Some("text") => get_str(item, "text").map(String::from),
            Some("file") => get_str(item, "name")
                .or_else(|| get_str(item, "uri"))
                .map(|n| format!("[文件] {n}")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 2.x assistant 的一项内容 → 1.x part 形状（text / reasoning 原样，tool 改成 {tool, state:{input, output, error}}）
pub(super) fn opencode_v2_part_as_v1(item: &Value) -> Option<Value> {
    match get_str(item, "type") {
        Some("text") | Some("reasoning") => Some(item.clone()),
        Some("tool") => {
            let state = item.get("state");
            let input = state.and_then(|s| s.get("input")).cloned().unwrap_or(Value::Null);
            let output = opencode_v2_content_text(state.and_then(|s| s.get("content")));
            let error = state
                .and_then(|s| s.get("error"))
                .map(|e| get_str(e, "message").map(String::from).unwrap_or_else(|| e.to_string()));
            let mut st = serde_json::json!({ "input": input });
            if !output.is_empty() {
                st["output"] = Value::String(output);
            }
            if let Some(e) = error.filter(|e| !e.is_empty()) {
                st["error"] = Value::String(e);
            }
            Some(serde_json::json!({
                "type": "tool",
                "tool": get_str(item, "name").unwrap_or_default(),
                "state": st,
            }))
        }
        _ => None,
    }
}

/// 2.x 的一条 session_message → 1.x 形状的 (message.data, parts)；不进对话的类型（idle、切模型、系统提示、压缩等）给 None。
/// `parts` 是这条消息的 session_part（已按 ordinal 排好），有就替换 data.content
pub(crate) fn opencode_v2_as_v1(
    kind: &str,
    data: &Value,
    parts: Option<&[Value]>,
) -> Option<(Value, Vec<Value>)> {
    let time = data.get("time").cloned().unwrap_or(Value::Null);
    match kind {
        "user" => {
            let text = get_str(data, "text").unwrap_or_default();
            Some((
                serde_json::json!({ "role": "user", "time": time }),
                vec![serde_json::json!({ "type": "text", "text": text })],
            ))
        }
        // 用户在 TUI 里直接跑的 `!命令`：按一次工具调用展示
        "shell" => {
            let output = data
                .get("output")
                .map(|o| get_str(o, "output").map(String::from).unwrap_or_else(|| stringify_payload(Some(o))))
                .unwrap_or_default();
            let part = serde_json::json!({
                "type": "tool",
                "tool": "shell",
                "state": { "input": { "command": get_str(data, "command").unwrap_or_default() }, "output": output },
            });
            Some((serde_json::json!({ "role": "assistant", "time": time }), vec![part]))
        }
        "assistant" => {
            let content: Vec<Value> = match parts {
                Some(p) if !p.is_empty() => p.to_vec(),
                _ => data
                    .get("content")
                    .and_then(|c| c.as_array())
                    .cloned()
                    .unwrap_or_default(),
            };
            let model = data.get("model");
            let mut v1 = serde_json::json!({ "role": "assistant", "time": time });
            for key in ["tokens", "cost", "error", "finish"] {
                if let Some(v) = data.get(key) {
                    v1[key] = v.clone();
                }
            }
            if let Some(id) = model.and_then(|m| get_str(m, "id")) {
                v1["modelID"] = Value::String(id.to_string());
            }
            if let Some(p) = model.and_then(|m| get_str(m, "providerID")) {
                v1["providerID"] = Value::String(p.to_string());
            }
            Some((v1, content.iter().filter_map(opencode_v2_part_as_v1).collect()))
        }
        _ => None,
    }
}

/// 2.x 会话首条用户话作标题（会话行还是占位标题时）
pub(super) fn opencode_v2_first_user_title(conn: &Connection, sid: &str) -> Option<String> {
    for row in query_rows(
        conn,
        "SELECT * FROM session_message WHERE session_id=? AND type='user' ORDER BY seq ASC LIMIT 20",
        &[&sid],
    ) {
        let row = DbRow {
            names: row.0,
            vals: row.1,
        };
        let data = row
            .as_str("data")
            .and_then(|d| serde_json::from_str::<Value>(&d).ok())?;
        if let Some(title) = get_str(&data, "text").and_then(usable_title) {
            return Some(title);
        }
    }
    None
}

/// 一条规整后的消息行：(id, time_created, 1.x 形状 data, parts)
pub(super) type OpencodeRow = (Option<String>, Option<i64>, Value, Vec<Value>);

/// 消息行（`store` 那套表里查出来的）→ 规整行：1.x 按 message_id 配 part 表，2.x 配 session_part 并改形状。
/// part 按消息 id 分批 IN 查（防 SQLite 变量上限），不整会话扫
pub(super) fn opencode_rows_with_parts(conn: &Connection, store: OpencodeStore, rows: Vec<DbRow>) -> Vec<OpencodeRow> {
    let ids: Vec<String> = rows
        .iter()
        .filter(|row| store == OpencodeStore::V1 || row.as_str("type").as_deref() == Some("assistant"))
        .filter_map(|row| row.as_str("id"))
        .collect();
    let (part_table, order) = match store {
        OpencodeStore::V1 => ("part", "time_created ASC"),
        OpencodeStore::V2 => ("session_part", "message_id ASC, ordinal ASC"),
    };
    let mut parts_by_msg: HashMap<String, Vec<Value>> = HashMap::new();
    for chunk in ids.chunks(400) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!("SELECT * FROM {part_table} WHERE message_id IN ({placeholders}) ORDER BY {order}");
        let params: Vec<&dyn rusqlite::ToSql> = chunk.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        for row in query_rows(conn, &sql, &params) {
            let row = DbRow {
                names: row.0,
                vals: row.1,
            };
            let (Some(message_id), Some(data)) = (row.as_str("message_id"), row.as_str("data")) else {
                continue;
            };
            if let Ok(value) = serde_json::from_str::<Value>(&data) {
                parts_by_msg.entry(message_id).or_default().push(value);
            }
        }
    }
    let mut out = Vec::new();
    for row in rows {
        let Some(data) = row
            .as_str("data")
            .and_then(|d| serde_json::from_str::<Value>(&d).ok())
        else {
            continue;
        };
        let id = row.as_str("id");
        let parts = id.as_ref().and_then(|id| parts_by_msg.remove(id));
        let ts = row.as_i64("time_created");
        match store {
            OpencodeStore::V1 => out.push((id, ts, data, parts.unwrap_or_default())),
            OpencodeStore::V2 => {
                let kind = row.as_str("type").unwrap_or_default();
                if let Some((v1, parts)) = opencode_v2_as_v1(&kind, &data, parts.as_deref()) {
                    out.push((id, ts, v1, parts));
                }
            }
        }
    }
    out
}

/// 整个会话的消息行（按时间序；2.x 再按 seq 排同一毫秒的行）
pub(super) fn opencode_session_rows(conn: &Connection, store: OpencodeStore, sid: &str) -> Vec<OpencodeRow> {
    let order = match store {
        OpencodeStore::V1 => "time_created ASC",
        OpencodeStore::V2 => "seq ASC",
    };
    let rows = query_rows(
        conn,
        &format!("SELECT * FROM {} WHERE session_id=? ORDER BY {order}", store.message_table()),
        &[&sid],
    )
    .into_iter()
    .map(|row| DbRow {
        names: row.0,
        vals: row.1,
    })
    .collect();
    opencode_rows_with_parts(conn, store, rows)
}

pub(super) fn opencode_parse_db(db_path: &Path, session_id: &str) -> Vec<ChatMessageDto> {
    let Some(conn) = open_opencode_db(db_path) else {
        return Vec::new();
    };
    let store = opencode_store_of(&conn, session_id);
    opencode_session_rows(&conn, store, session_id)
        .into_iter()
        .filter_map(|(_, ts, data, parts)| opencode_message(&data, parts.iter().collect(), ts))
        .collect()
}

/// pin 导出：{session:{列...}, messages:[{id,time_created,data}], parts:[{message_id,data}]}
///（自包含且保留 id 关联，回放不依赖原库；2.x 会话导出时已规整成 1.x 形状，快照解析不分版本）
pub(super) fn opencode_export_session(db_path: &Path, session_id: &str) -> Result<Value, String> {
    let conn = open_opencode_db(db_path).ok_or("OpenCode 数据库不可读")?;
    let sid = session_id.to_string();
    let store = opencode_store_of(&conn, &sid);
    let mut session_json = serde_json::json!({ "id": sid });
    // id 是主键，最多一行；查不到时保留只含 id 的兜底对象
    if let Some(row) = query_rows(
        &conn,
        &format!("SELECT * FROM {} WHERE id=?", store.session_table()),
        &[&sid],
    )
    .into_iter()
    .next()
    {
        let row = DbRow {
            names: row.0,
            vals: row.1,
        };
        let mut obj = serde_json::Map::new();
        for (i, name) in row.names.iter().enumerate() {
            let v = match &row.vals[i] {
                rusqlite::types::Value::Null => Value::Null,
                rusqlite::types::Value::Integer(n) => serde_json::json!(n),
                rusqlite::types::Value::Real(f) => serde_json::json!(f),
                rusqlite::types::Value::Text(s) => serde_json::json!(s),
                rusqlite::types::Value::Blob(_) => continue,
            };
            obj.insert(name.clone(), v);
        }
        session_json = Value::Object(obj);
    }
    let mut messages = Vec::new();
    let mut parts = Vec::new();
    for (id, ts, data, msg_parts) in opencode_session_rows(&conn, store, &sid) {
        for p in msg_parts {
            parts.push(serde_json::json!({ "message_id": id, "data": p }));
        }
        messages.push(serde_json::json!({
            "id": id,
            "time_created": ts,
            "data": data,
        }));
    }
    Ok(serde_json::json!({
        "session": session_json,
        "messages": messages,
        "parts": parts,
    }))
}

/// 快照 JSON → 消息列表：按导出时保留的 message_id 分组 parts
pub(super) fn opencode_parse_snapshot(v: &Value) -> Vec<ChatMessageDto> {
    let messages = v.get("messages").and_then(|m| m.as_array());
    let parts = v.get("parts").and_then(|p| p.as_array());
    let (Some(messages), Some(parts)) = (messages, parts) else {
        return Vec::new();
    };
    let mut parts_by_msg: HashMap<String, Vec<&Value>> = HashMap::new();
    for p in parts {
        if let Some(mid) = get_str(p, "message_id") {
            if let Some(data) = p.get("data") {
                parts_by_msg.entry(mid.to_string()).or_default().push(data);
            }
        }
    }
    let mut msgs = Vec::new();
    for m in messages {
        let Some(data) = m.get("data") else {
            continue;
        };
        let owned = get_str(m, "id")
            .and_then(|id| parts_by_msg.remove(id))
            .unwrap_or_default();
        let ts = m.get("time_created").and_then(|t| t.as_i64());
        if let Some(msg) = opencode_message(data, owned, ts) {
            msgs.push(msg);
        }
    }
    msgs
}

// ----- 旧版（pre-v1.2）storage/ 扁平 JSON -----
// 更老的 project/<slug>/storage/... 布局不兼容（此处只读 v1.1 的 storage/ 结构）

pub(super) fn opencode_legacy_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(windows)]
    if let Some(local) = crate::dirs::data_local_dir() {
        roots.push(local.join("opencode").join("storage"));
    }
    if let Some(h) = crate::dirs::home_dir() {
        roots.push(
            h.join(".local")
                .join("share")
                .join("opencode")
                .join("storage"),
        );
    }
    roots
}

/// legacy 目录下的一层 .json 文件（collect_files 只认 .jsonl[.zst]，不能复用）
pub(super) fn collect_json_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_file() && p.extension().and_then(|x| x.to_str()) == Some("json") {
            out.push(p);
        }
    }
}

pub(super) fn read_json_file(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Session Info 的时间字段：顶层 epoch ms 或嵌套 time.{created,updated}
pub(super) fn legacy_time(v: &Value, flat: &str, nested: &str) -> Option<i64> {
    v.get(flat).and_then(|t| t.as_i64()).or_else(|| {
        v.get("time")
            .and_then(|t| t.get(nested))
            .and_then(|t| t.as_i64())
    })
}

pub(super) fn legacy_tokens(v: &Value) -> Option<TokenUsageDto> {
    let t = |k: &str| v.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    if t("tokens_input") + t("tokens_output") + t("tokens_reasoning") > 0 {
        Some(opencode_usage(
            t("tokens_input"),
            t("tokens_output"),
            t("tokens_reasoning"),
            t("tokens_cache_read"),
            t("tokens_cache_write"),
        ))
    } else {
        None
    }
}

pub(super) fn opencode_scan_legacy(storage: &Path) -> Vec<SessionMetaDto> {
    // legacy 是 .json 文件，不能用 collect_files（只认 .jsonl[.zst]）
    let mut files = Vec::new();
    if let Ok(projects) = fs::read_dir(storage.join("session")) {
        for p in projects.flatten() {
            let Ok(entries) = fs::read_dir(p.path()) else {
                continue;
            };
            for e in entries.flatten() {
                let path = e.path();
                if path.extension().and_then(|x| x.to_str()) == Some("json") {
                    files.push(path);
                }
            }
        }
    }
    let mut out = Vec::new();
    for f in files {
        let Some(v) = read_json_file(&f) else {
            continue;
        };
        let id = get_str(&v, "id")
            .map(String::from)
            .or_else(|| f.file_stem().map(|s| s.to_string_lossy().into_owned()))
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        out.push(SessionMetaDto {
            agent: "opencode".into(),
            session_id: id,
            project_path: get_str(&v, "directory").unwrap_or("").to_string(),
            cwd: get_str(&v, "directory").map(String::from),
            title: get_str(&v, "title").and_then(usable_title),
            created_at: legacy_time(&v, "time_created", "created").map(opencode_ms_to_iso),
            updated_at: legacy_time(&v, "time_updated", "updated").map(opencode_ms_to_iso),
            file_path: f.to_string_lossy().into_owned(),
            token_usage: legacy_tokens(&v),
            cli_version: get_str(&v, "version").map(String::from),
            pinned: false,
            archived: false,
            custom_title: None,
            tags: Vec::new(),
            alive: true,
            chain_count: 1,
            workspace: None,
            step_name: None,
            summary: None,
            live: mtime_fresh(&f, 60),
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
        });
    }
    out
}

pub(super) fn opencode_parse_legacy(session_json: &Path) -> Vec<ChatMessageDto> {
    let storage = session_json
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent());
    let Some(storage) = storage else {
        return Vec::new();
    };
    let sid = session_json
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    // message/<sid>/<msgID>.json 按 data.time.created 排序
    let mut msg_files = Vec::new();
    collect_json_files(&storage.join("message").join(&sid), &mut msg_files);
    let mut messages: Vec<(i64, String, Value)> = Vec::new();
    for f in msg_files {
        let Some(v) = read_json_file(&f) else {
            continue;
        };
        let ts = legacy_time(&v, "time_created", "created").unwrap_or(0);
        let mid = f
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        messages.push((ts, mid, v));
    }
    messages.sort_by_key(|(ts, _, _)| *ts);
    let mut msgs = Vec::new();
    for (ts, mid, v) in messages {
        let mut part_files = Vec::new();
        collect_json_files(&storage.join("part").join(&mid), &mut part_files);
        part_files.sort();
        let parts: Vec<Value> = part_files
            .iter()
            .filter_map(|f| read_json_file(f))
            .collect();
        if let Some(m) = opencode_message(&v, parts.iter().collect(), Some(ts)) {
            msgs.push(m);
        }
    }
    msgs
}
