//! 对话正文搜索：标题/标签之外，按会话里说过的话找。
//!
//! 多关键词按「命中多少 + 落在哪」打分，同分再按更新时间。正文不进前端，
//! 只回脱敏后的一句摘录。源文件只读；抽出的可检索文本缓存在 app.db。

use crate::sessions::{
    self, conversation_impl_raw, is_injected_context_message, parse_session_lines,
    redact_sensitive_text, SessionMetaDto,
};
use rusqlite::{params, Connection, Transaction};
use serde::Serialize;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{Duration, Instant, UNIX_EPOCH};

const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];
const TEXT_CAP: usize = 96 * 1024;
const DECODE_CAP: usize = 8 * 1024 * 1024;
const INDEX_BUDGET: Duration = Duration::from_millis(1200);
const SNIPPET_RADIUS: usize = 42;

const W_TITLE: u32 = 80;
const W_SUMMARY: u32 = 40;
const W_TAG: u32 = 30;
const W_STEP: u32 = 25;
const W_TASK: u32 = 25;
const W_WORKSPACE: u32 = 20;
const W_PROJECT: u32 = 15;
const W_CONTENT: u32 = 35;
const W_CONTENT_TF: u32 = 4;
const CONTENT_TF_CAP: u32 = 8;
const ALL_TOKENS_BONUS: u32 = 50;
const PHRASE_BONUS: u32 = 40;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchHitDto {
    pub agent: String,
    pub session_id: String,
    pub score: u32,
    pub snippet: Option<String>,
    pub matched_keywords: Vec<String>,
    /// jsonl：命中行在（解压后）流中的字节偏移；OpenCode：time_created。
    pub around: Option<u64>,
    pub match_timestamp: Option<String>,
    pub match_role: Option<String>,
}

#[tauri::command]
pub async fn search_sessions(query: String) -> Result<Vec<SessionSearchHitDto>, String> {
    tauri::async_runtime::spawn_blocking(move || search_impl(&query))
        .await
        .map_err(|e| e.to_string())?
}

fn search_impl(query: &str) -> Result<Vec<SessionSearchHitDto>, String> {
    let tokens = tokenize(query);
    if tokens.is_empty() {
        return Ok(Vec::new());
    }
    let phrase = phrase_of(query);
    let sessions = sessions::list_sessions_sync();
    let mut conn = sessions::open_db()?;
    ensure_table(&conn)?;
    refresh_index(&mut conn, &sessions);
    let texts = load_indexed_text(&conn)?;
    let mut hits = Vec::new();
    for s in &sessions {
        let content = texts
            .get(&(s.agent.clone(), s.session_id.clone()))
            .cloned()
            .unwrap_or_default();
        let (score, snippet, matched) = score_session(s, &content, &tokens, phrase.as_deref());
        if score == 0 {
            continue;
        }
        hits.push((
            s.updated_at.clone().unwrap_or_default(),
            s.file_path.clone(),
            s.agent.clone(),
            SessionSearchHitDto {
                agent: s.agent.clone(),
                session_id: s.session_id.clone(),
                score,
                snippet,
                matched_keywords: matched,
                around: None,
                match_timestamp: None,
                match_role: None,
            },
        ));
    }
    hits.sort_by(|a, b| b.3.score.cmp(&a.3.score).then_with(|| b.0.cmp(&a.0)));
    let mut located = 0usize;
    for (_, file_path, agent, hit) in &mut hits {
        if located >= 80 {
            break;
        }
        if hit.snippet.is_none() {
            continue;
        }
        if let Some((around, ts, role)) = locate_match(agent, file_path, &hit.matched_keywords) {
            hit.around = Some(around);
            hit.match_timestamp = ts;
            hit.match_role = Some(role);
            located += 1;
        }
    }
    Ok(hits.into_iter().map(|(_, _, _, h)| h).collect())
}

fn phrase_of(query: &str) -> Option<String> {
    let t = query.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.split_whitespace().count() >= 2 {
        Some(t.to_lowercase())
    } else {
        None
    }
}

pub(crate) fn tokenize(query: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw in query.split_whitespace() {
        let trimmed = trim_punct(raw);
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_lowercase();
        if !keep_token(&lower) {
            continue;
        }
        if seen.insert(lower.clone()) {
            out.push(lower);
        }
    }
    out
}

fn keep_token(t: &str) -> bool {
    if t.chars().any(is_cjk) {
        return true;
    }
    t.chars().count() >= 2
}

fn is_cjk(c: char) -> bool {
    matches!(
        c,
        '\u{3400}'..='\u{4dbf}'
            | '\u{4e00}'..='\u{9fff}'
            | '\u{f900}'..='\u{faff}'
            | '\u{3040}'..='\u{30ff}'
            | '\u{ac00}'..='\u{d7af}'
    )
}

fn is_trim_punct(c: char) -> bool {
    c.is_ascii_punctuation()
        || matches!(
            c,
            '，' | '。'
                | '；'
                | '：'
                | '！'
                | '？'
                | '、'
                | '“'
                | '”'
                | '‘'
                | '’'
                | '（'
                | '）'
                | '【'
                | '】'
                | '《'
                | '》'
        )
}

fn trim_punct(s: &str) -> &str {
    s.trim_matches(is_trim_punct)
}

fn project_base(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn haystack_meta(s: &SessionMetaDto) -> (String, String, String, String) {
    let title = format!(
        "{} {}",
        s.custom_title.as_deref().unwrap_or(""),
        s.title.as_deref().unwrap_or("")
    )
    .to_lowercase();
    let summary = s.summary.as_deref().unwrap_or("").to_lowercase();
    let tags = s.tags.join("\n").to_lowercase();
    let rest = format!(
        "{}\n{}\n{}\n{}\n{}",
        s.workspace.as_deref().unwrap_or(""),
        s.step_name.as_deref().unwrap_or(""),
        s.task_name.as_deref().unwrap_or(""),
        s.project_path,
        project_base(&s.project_path)
    )
    .to_lowercase();
    (title, summary, tags, rest)
}

fn score_session(
    s: &SessionMetaDto,
    content: &str,
    tokens: &[String],
    phrase: Option<&str>,
) -> (u32, Option<String>, Vec<String>) {
    let (title, summary, tags, rest) = haystack_meta(s);
    let content_l = content.to_lowercase();
    let mut score = 0u32;
    let mut matched = Vec::new();
    let mut all_hit = true;
    for tok in tokens {
        let mut hit = false;
        if title.contains(tok) {
            score = score.saturating_add(W_TITLE);
            hit = true;
        }
        if summary.contains(tok) {
            score = score.saturating_add(W_SUMMARY);
            hit = true;
        }
        if tags.contains(tok) {
            score = score.saturating_add(W_TAG);
            hit = true;
        }
        if rest.contains(tok) {
            if s.step_name
                .as_deref()
                .is_some_and(|v| v.to_lowercase().contains(tok))
            {
                score = score.saturating_add(W_STEP);
            } else if s
                .task_name
                .as_deref()
                .is_some_and(|v| v.to_lowercase().contains(tok))
            {
                score = score.saturating_add(W_TASK);
            } else if s
                .workspace
                .as_deref()
                .is_some_and(|v| v.to_lowercase().contains(tok))
            {
                score = score.saturating_add(W_WORKSPACE);
            } else {
                score = score.saturating_add(W_PROJECT);
            }
            hit = true;
        }
        let n = count_matches(&content_l, tok);
        if n > 0 {
            score = score.saturating_add(W_CONTENT);
            let extra = (n.saturating_sub(1) as u32).min(CONTENT_TF_CAP);
            score = score.saturating_add(extra.saturating_mul(W_CONTENT_TF));
            hit = true;
        }
        if hit {
            matched.push(tok.clone());
        } else {
            all_hit = false;
        }
    }
    if all_hit && tokens.len() > 1 {
        score = score.saturating_add(ALL_TOKENS_BONUS);
    }
    if let Some(p) = phrase {
        if title.contains(p) || summary.contains(p) || content_l.contains(p) {
            score = score.saturating_add(PHRASE_BONUS);
        }
    }
    let snippet = if matched.iter().any(|t| content_l.contains(t.as_str())) {
        snippet_around(content, &matched).map(|s| redact_sensitive_text(&s))
    } else {
        None
    };
    (score, snippet, matched)
}

fn count_matches(hay: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    hay.matches(needle).count()
}

fn snippet_around(text: &str, tokens: &[String]) -> Option<String> {
    let lower = text.to_lowercase();
    let mut best: Option<usize> = None;
    for tok in tokens {
        if let Some(i) = lower.find(tok.as_str()) {
            best = Some(match best {
                Some(b) if b <= i => b,
                _ => i,
            });
        }
    }
    let at = best?;
    let chars: Vec<char> = text.chars().collect();
    let char_at = orig_char_index(text, at);
    let start = char_at.saturating_sub(SNIPPET_RADIUS);
    let end = (char_at + SNIPPET_RADIUS + 8).min(chars.len());
    let mut s: String = chars[start..end].iter().collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 {
        s = format!("…{s}");
    }
    if end < chars.len() {
        s.push('…');
    }
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 小写串里的字节下标 → 原文字符下标。部分字符小写后 UTF-8 长度会变（İ、K 开尔文号、Ω 欧姆号），
/// 直接拿去切原文会落在字符中间而 panic，整个搜索命令随之失败。
fn orig_char_index(text: &str, lower_byte: usize) -> usize {
    let mut acc = 0usize;
    for (i, c) in text.chars().enumerate() {
        if acc >= lower_byte {
            return i;
        }
        acc += c.to_lowercase().map(char::len_utf8).sum::<usize>();
    }
    text.chars().count()
}

fn ensure_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_search_text (
            agent TEXT NOT NULL,
            session_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            mtime_ms INTEGER NOT NULL,
            size INTEGER NOT NULL,
            text TEXT NOT NULL,
            PRIMARY KEY (agent, session_id)
        );",
    )
    .map_err(|e| format!("初始化会话搜索索引失败: {e}"))
}

pub(crate) fn forget_in_tx(tx: &Transaction<'_>, agent: &str, session_id: &str) {
    let _ = tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_search_text (
            agent TEXT NOT NULL,
            session_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            mtime_ms INTEGER NOT NULL,
            size INTEGER NOT NULL,
            text TEXT NOT NULL,
            PRIMARY KEY (agent, session_id)
        );",
    );
    let _ = tx.execute(
        "DELETE FROM session_search_text WHERE agent=?1 AND session_id=?2",
        params![agent, session_id],
    );
}

fn refresh_index(conn: &mut Connection, sessions: &[SessionMetaDto]) {
    let existing = load_stamps(conn);
    let start = Instant::now();
    for s in sessions {
        if start.elapsed() > INDEX_BUDGET {
            break;
        }
        let (mtime, size) = source_stamp(s);
        let stale = existing
            .get(&(s.agent.clone(), s.session_id.clone()))
            .map(|(p, m, n)| p != &s.file_path || *m != mtime || *n != size)
            .unwrap_or(true);
        if !stale {
            continue;
        }
        let text = extract_session_text(s);
        let _ = conn.execute(
            "INSERT INTO session_search_text(agent, session_id, file_path, mtime_ms, size, text)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(agent, session_id) DO UPDATE SET
               file_path=excluded.file_path,
               mtime_ms=excluded.mtime_ms,
               size=excluded.size,
               text=excluded.text",
            params![s.agent, s.session_id, s.file_path, mtime, size as i64, text],
        );
    }
}

fn load_stamps(
    conn: &Connection,
) -> std::collections::HashMap<(String, String), (String, i64, u64)> {
    let mut out = std::collections::HashMap::new();
    let Ok(mut stmt) = conn
        .prepare("SELECT agent, session_id, file_path, mtime_ms, size FROM session_search_text")
    else {
        return out;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)? as u64,
        ))
    }) else {
        return out;
    };
    for row in rows.flatten() {
        out.insert((row.0, row.1), (row.2, row.3, row.4));
    }
    out
}

fn load_indexed_text(
    conn: &Connection,
) -> Result<std::collections::HashMap<(String, String), String>, String> {
    let mut out = std::collections::HashMap::new();
    let mut stmt = conn
        .prepare("SELECT agent, session_id, text FROM session_search_text")
        .map_err(|e| format!("读取会话搜索索引失败: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("读取会话搜索索引失败: {e}"))?;
    for row in rows.flatten() {
        out.insert((row.0, row.1), row.2);
    }
    Ok(out)
}

fn source_stamp(s: &SessionMetaDto) -> (i64, u64) {
    if s.agent == "opencode" {
        let ms = s.updated_at.as_deref().and_then(iso_to_ms).unwrap_or(0);
        return (ms, 0);
    }
    let path = Path::new(&s.file_path);
    match path.metadata() {
        Ok(m) => {
            let ms = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            (ms, m.len())
        }
        Err(_) => (0, 0),
    }
}

fn iso_to_ms(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn extract_session_text(s: &SessionMetaDto) -> String {
    let raw = if s.agent == "opencode" {
        messages_to_text(&conversation_impl_raw(&s.agent, &s.file_path))
    } else {
        extract_jsonl_text(&s.agent, Path::new(&s.file_path))
    };
    let capped = if raw.len() > TEXT_CAP {
        raw.chars().take(TEXT_CAP).collect()
    } else {
        raw
    };
    redact_sensitive_text(&capped)
}

struct MatchLoc {
    around: u64,
    timestamp: Option<String>,
    role: String,
}

fn locate_match(
    agent: &str,
    file_path: &str,
    tokens: &[String],
) -> Option<(u64, Option<String>, String)> {
    if tokens.is_empty() {
        return None;
    }
    let loc = if agent == "opencode" {
        locate_in_messages(&conversation_impl_raw(agent, file_path), tokens)
    } else {
        locate_jsonl(agent, Path::new(file_path), tokens)
    }?;
    Some((loc.around, loc.timestamp, loc.role))
}

fn message_has_token(m: &sessions::ChatMessageDto, tokens: &[String]) -> bool {
    if m.role != "user" && m.role != "assistant" {
        return false;
    }
    m.blocks.iter().any(|b| {
        if b.kind != "text" {
            return false;
        }
        let lower = b.text.to_lowercase();
        tokens.iter().any(|t| lower.contains(t.as_str()))
    })
}

fn locate_in_messages(msgs: &[sessions::ChatMessageDto], tokens: &[String]) -> Option<MatchLoc> {
    for m in msgs {
        if !message_has_token(m, tokens) {
            continue;
        }
        let around = m
            .timestamp
            .as_deref()
            .and_then(iso_to_ms)
            .map(|ms| ms as u64)
            .unwrap_or(0);
        return Some(MatchLoc {
            around,
            timestamp: m.timestamp.clone(),
            role: m.role.clone(),
        });
    }
    None
}

fn locate_jsonl(agent: &str, path: &Path, tokens: &[String]) -> Option<MatchLoc> {
    let iter = jsonl_lines_with_offset(path)?;
    let mut items: Vec<(u64, String)> = Vec::new();
    let mut decoded = 0usize;
    for (offset, line) in iter {
        decoded = decoded.saturating_add(line.len());
        items.push((offset, line));
        if decoded >= DECODE_CAP {
            break;
        }
    }
    if items.is_empty() {
        return None;
    }
    // kimi 等把一条 assistant 拆成 step.begin + 多条 content.part；单行 parse 会丢掉正文。
    let lines: Vec<String> = items.iter().map(|(_, l)| l.clone()).collect();
    let msgs = parse_session_lines(agent, &lines);
    let m = msgs.iter().find(|msg| message_has_token(msg, tokens))?;
    let around = offset_of_message(&items, m, tokens).unwrap_or(items[0].0);
    Some(MatchLoc {
        around,
        timestamp: m.timestamp.clone(),
        role: m.role.clone(),
    })
}

/// 从命中消息里取一段不易撞车的原文，去 jsonl 里找对应行的字节偏移。
fn offset_of_message(
    items: &[(u64, String)],
    m: &sessions::ChatMessageDto,
    tokens: &[String],
) -> Option<u64> {
    if let Some(n) = text_needle(m, tokens) {
        if n.chars().count() >= 2 {
            for (off, line) in items {
                if line_has_fragment(line, &n) {
                    return Some(*off);
                }
            }
        }
    }
    for (off, line) in items {
        let lower = line.to_lowercase();
        if tokens.iter().any(|t| lower.contains(t.as_str())) {
            return Some(*off);
        }
    }
    None
}

fn text_needle(m: &sessions::ChatMessageDto, tokens: &[String]) -> Option<String> {
    for b in &m.blocks {
        if b.kind != "text" {
            continue;
        }
        let lower = b.text.to_lowercase();
        for t in tokens {
            let Some(byte_at) = lower.find(t.as_str()) else {
                continue;
            };
            let char_at = orig_char_index(&b.text, byte_at);
            let chars: Vec<char> = b.text.chars().collect();
            let tok_len = t.chars().count();
            let to = (char_at + tok_len + 24).min(chars.len());
            let mut n = String::new();
            for c in chars.iter().take(to).skip(char_at) {
                if *c == '\n' {
                    break;
                }
                n.push(*c);
            }
            if n.chars().count() >= 2 {
                return Some(n);
            }
        }
    }
    None
}

fn line_has_fragment(line: &str, fragment: &str) -> bool {
    if line.contains(fragment) {
        return true;
    }
    if let Ok(escaped) = serde_json::to_string(fragment) {
        let inner = escaped.trim_matches('"');
        if inner.len() >= 2 && line.contains(inner) {
            return true;
        }
    }
    line.to_lowercase().contains(&fragment.to_lowercase())
}

fn jsonl_lines_with_offset(path: &Path) -> Option<LineOffsetIter> {
    let mut file = File::open(path).ok()?;
    let mut magic = [0u8; 4];
    let n = file.read(&mut magic).ok()?;
    file.seek(SeekFrom::Start(0)).ok()?;
    let boxed: Box<dyn BufRead> = if n == 4 && magic == ZSTD_MAGIC {
        let dec = zstd::stream::read::Decoder::new(file).ok()?;
        Box::new(BufReader::new(dec))
    } else {
        Box::new(BufReader::new(file))
    };
    Some(LineOffsetIter {
        reader: boxed,
        offset: 0,
    })
}

struct LineOffsetIter {
    reader: Box<dyn BufRead>,
    offset: u64,
}

impl Iterator for LineOffsetIter {
    type Item = (u64, String);
    fn next(&mut self) -> Option<Self::Item> {
        let mut buf = Vec::new();
        let n = self.reader.read_until(b'\n', &mut buf).ok()?;
        if n == 0 {
            return None;
        }
        let start = self.offset;
        self.offset += n as u64;
        while buf.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
            buf.pop();
        }
        Some((start, String::from_utf8_lossy(&buf).into_owned()))
    }
}

fn extract_jsonl_text(agent: &str, path: &Path) -> String {
    let Some(reader) = jsonl_line_reader(path) else {
        return String::new();
    };
    let mut lines = Vec::new();
    let mut decoded = 0usize;
    for line in reader {
        decoded = decoded.saturating_add(line.len());
        lines.push(line);
        if decoded >= DECODE_CAP {
            break;
        }
    }
    messages_to_text(&parse_session_lines(agent, &lines))
}

fn jsonl_line_reader(path: &Path) -> Option<impl Iterator<Item = String>> {
    let mut file = File::open(path).ok()?;
    let mut magic = [0u8; 4];
    let n = file.read(&mut magic).ok()?;
    file.seek(SeekFrom::Start(0)).ok()?;
    let boxed: Box<dyn BufRead> = if n == 4 && magic == ZSTD_MAGIC {
        let dec = zstd::stream::read::Decoder::new(file).ok()?;
        Box::new(BufReader::new(dec))
    } else {
        Box::new(BufReader::new(file))
    };
    Some(boxed.split(b'\n').map_while(Result::ok).map(|bytes| {
        let s = String::from_utf8_lossy(&bytes);
        s.trim_end_matches('\r').to_string()
    }))
}

fn messages_to_text(msgs: &[sessions::ChatMessageDto]) -> String {
    let mut out = String::new();
    for m in msgs {
        if m.role != "user" && m.role != "assistant" {
            continue;
        }
        for b in &m.blocks {
            if b.kind != "text" {
                continue;
            }
            let t = b.text.trim();
            if t.is_empty() || is_injected_context_message(t) {
                continue;
            }
            out.push_str(t);
            out.push('\n');
            if out.len() >= TEXT_CAP {
                return out;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(title: &str, summary: &str, path: &str) -> SessionMetaDto {
        SessionMetaDto {
            agent: "claude-code".into(),
            session_id: "s1".into(),
            project_path: path.into(),
            cwd: Some(path.into()),
            title: Some(title.into()),
            created_at: None,
            updated_at: Some("2026-09-01T00:00:00Z".into()),
            file_path: "/tmp/s.jsonl".into(),
            token_usage: None,
            cli_version: None,
            pinned: false,
            archived: false,
            custom_title: None,
            tags: vec!["实验".into()],
            alive: true,
            chain_count: 1,
            workspace: None,
            step_name: Some("结果分析".into()),
            summary: Some(summary.into()),
            live: false,
            source: "cli".into(),
            internal: false,
            handoff_from_agent: None,
            handoff_from_session: None,
            task_id: None,
            task_name: None,
            provider: None,
            profile_id: None,
        }
    }

    #[test]
    fn tokenize_splits_and_drops_short_ascii() {
        assert_eq!(
            tokenize("  消融  transformer,  a  IF  "),
            vec!["消融", "transformer", "if"]
        );
        assert_eq!(tokenize("酶"), vec!["酶"]);
        assert!(tokenize("   ，，  ").is_empty());
    }

    #[test]
    fn more_keywords_rank_higher_than_recency_tiebreak_only() {
        let a = meta("消融", "", "/p/alpha");
        let b = meta("别的", "", "/p/beta");
        let tokens = tokenize("消融 方差");
        let (sa, _, ma) = score_session(
            &a,
            "我们做了消融实验，看方差变化",
            &tokens,
            Some("消融 方差"),
        );
        let (sb, _, mb) = score_session(&b, "随便聊聊天气", &tokens, Some("消融 方差"));
        assert!(sa > sb, "{sa} vs {sb}");
        assert!(ma.contains(&"消融".to_string()));
        assert!(mb.is_empty() || !mb.contains(&"消融".to_string()) || sb < sa);
    }

    #[test]
    fn all_tokens_outscore_single_token() {
        let s = meta("笔记", "", "/p/x");
        let both = tokenize("消融 方差");
        let (full, _, _) = score_session(&s, "消融实验的方差分析", &both, Some("消融 方差"));
        let (one, _, _) = score_session(&s, "只提了消融", &both, Some("消融 方差"));
        assert!(full > one, "{full} vs {one}");
    }

    #[test]
    fn title_beats_content_for_same_token() {
        let titled = meta("消融实验", "", "/p/x");
        let body = meta("闲聊", "", "/p/x");
        let tokens = tokenize("消融");
        let (st, _, _) = score_session(&titled, "没有这个词", &tokens, None);
        let (sc, _, _) = score_session(&body, "正文里写了消融", &tokens, None);
        assert!(st > sc, "标题命中应重于仅正文, {st} vs {sc}");
    }

    #[test]
    fn snippet_centers_on_keyword() {
        let text = "前面垫一些无关的话，然后说到消融实验设计，后面还有别的。";
        let sn = snippet_around(text, &["消融".into()]).unwrap();
        assert!(sn.contains("消融"));
    }

    #[test]
    fn snippet_survives_case_folding_that_changes_byte_length() {
        // İ 小写后多一个字节、K（开尔文号）少两个：命中位置不得错切到「字」中间
        let text = format!("{}回复超 1500 字的说明", "İK".repeat(30));
        let sn = snippet_around(&text, &["字".into()]).unwrap();
        assert!(sn.contains("1500 字"), "{sn}");
    }

    #[test]
    fn extract_jsonl_keeps_user_and_assistant_text() {
        let dir = std::env::temp_dir().join(format!("ccode-ss-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s.jsonl");
        std::fs::write(
            &file,
            concat!(
                r#"{"type":"user","message":{"role":"user","content":"帮我看看消融实验"}}"#,
                "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"可以对比去掉模块后的方差"}]}}"#,
                "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"不该进索引"}]}}"#,
                "\n",
            ),
        )
        .unwrap();
        let text = extract_jsonl_text("claude-code", &file);
        assert!(text.contains("消融实验"));
        assert!(text.contains("方差"));
        assert!(!text.contains("不该进索引"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn locate_jsonl_points_at_matching_line() {
        let dir = std::env::temp_dir().join(format!("ccode-ss-loc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s.jsonl");
        let pad = format!(
            "{}\n",
            r#"{"type":"user","message":{"role":"user","content":"前面垫话"}}"#
        )
        .repeat(20);
        let hit = r#"{"type":"user","timestamp":"2026-09-02T01:00:00Z","message":{"role":"user","content":"帮我看看消融实验"}}"#;
        let content = format!("{pad}{hit}\n");
        std::fs::write(&file, &content).unwrap();
        let expect = content.find(hit).unwrap() as u64;
        let loc = locate_jsonl("claude-code", &file, &["消融".into()]).unwrap();
        assert_eq!(loc.around, expect);
        assert_eq!(loc.role, "user");
        assert_eq!(loc.timestamp.as_deref(), Some("2026-09-02T01:00:00Z"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn locate_jsonl_kimi_loop_events_needs_full_parse() {
        let dir = std::env::temp_dir().join(format!("ccode-ss-kimi-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("wire.jsonl");
        let lines = [
            r#"{"type":"metadata","protocol_version":"1.4","created_at":1785307071000}"#,
            r#"{"type":"turn.prompt","input":[{"type":"text","text":"跑一下测试"}],"origin":{"kind":"user"},"time":1785307072000}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"step.begin","step":1},"time":1785307072100}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"think","think":"先想"}},"time":1785307072200}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"我来跑 web_search 参数"}},"time":1785307072300}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":500,"output":60}},"time":1785307072600}"#,
        ];
        let mut content = String::new();
        let mut hit_at = 0u64;
        for (i, line) in lines.iter().enumerate() {
            if i == 4 {
                hit_at = content.len() as u64;
            }
            content.push_str(line);
            content.push('\n');
        }
        std::fs::write(&file, &content).unwrap();
        let loc = locate_jsonl("kimi", &file, &["web".into()]).expect("kimi 流式正文应能定位");
        assert_eq!(loc.around, hit_at);
        assert_eq!(loc.role, "assistant");
        assert!(loc.timestamp.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }
}
