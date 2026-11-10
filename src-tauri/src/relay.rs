//! 聊天里换一家 Agent 接着做（docs/design-chat-relay.md）。
//!
//! 用户眼里是一段对话，底下是几家 CLI 各自的几段会话：各家会话文件只读不写，换一家就开一段新的原生会话
//! （或接回那家原来那段），由 Mesa 写交接简报、记下前后关系（`relay_links`）、在界面上串成一段。
//! 接力关系按简报文件名记：接手那段的第一句（或换回时那一句）带着接力抬头和简报路径，
//! 认抬头就能知道这一句接的是谁、交到哪一条为止——不靠「同目录最新那段」去猜（旧 handoff_links 的毛病）。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::relay_brief::{self, BriefInput, BriefKind, Round};
use crate::sessions::{self, ChatMessageDto, RelaySegmentRef, SessionMetaDto};

/// 时间线往回追几层（防环、防极长链）
const MAX_DEPTH: usize = 12;
/// 换回时：原来那段上下文用了这么多（‰）就建议新开
const CONTEXT_FULL_PERMILLE: u64 = 700;
/// 换回时：原来那段这么多天没动就建议新开
const STALE_DAYS: i64 = 3;
/// 展开前一段时最多摆多少条消息
const SEGMENT_TAIL: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RelayLink {
    pub brief_name: String,
    pub parent_agent: String,
    pub parent_session: String,
    /// 交到前一段第几条消息为止（conversation_impl 的条数；会话只追加，条数稳定）
    pub parent_through: usize,
    pub child_agent: Option<String>,
    pub child_session: Option<String>,
    /// full | delta
    pub kind: String,
    pub created_at: String,
}

pub(crate) fn ensure_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS relay_links(
            brief_name TEXT PRIMARY KEY,
            parent_agent TEXT NOT NULL,
            parent_session TEXT NOT NULL,
            parent_through INTEGER NOT NULL,
            child_agent TEXT,
            child_session TEXT,
            kind TEXT NOT NULL,
            created_at TEXT NOT NULL);",
    )
    .map_err(|e| format!("初始化接力记录失败: {e}"))
}

fn row_to_link(r: &rusqlite::Row) -> rusqlite::Result<RelayLink> {
    Ok(RelayLink {
        brief_name: r.get(0)?,
        parent_agent: r.get(1)?,
        parent_session: r.get(2)?,
        parent_through: r.get::<_, i64>(3)?.max(0) as usize,
        child_agent: r.get(4)?,
        child_session: r.get(5)?,
        kind: r.get(6)?,
        created_at: r.get(7)?,
    })
}

const COLS: &str = "brief_name, parent_agent, parent_session, parent_through, child_agent, child_session, kind, created_at";

fn insert_link(conn: &Connection, link: &RelayLink) -> Result<(), String> {
    ensure_table(conn)?;
    conn.execute(
        &format!("INSERT OR REPLACE INTO relay_links({COLS}) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"),
        params![
            link.brief_name,
            link.parent_agent,
            link.parent_session,
            link.parent_through as i64,
            link.child_agent,
            link.child_session,
            link.kind,
            link.created_at
        ],
    )
    .map_err(|e| format!("记下接力关系失败: {e}"))?;
    Ok(())
}

pub(crate) fn link_by_brief(conn: &Connection, name: &str) -> Option<RelayLink> {
    ensure_table(conn).ok()?;
    conn.query_row(
        &format!("SELECT {COLS} FROM relay_links WHERE brief_name=?1"),
        params![name],
        row_to_link,
    )
    .optional()
    .ok()
    .flatten()
}

fn all_links(conn: &Connection) -> Vec<RelayLink> {
    if ensure_table(conn).is_err() {
        return Vec::new();
    }
    let Ok(mut stmt) = conn.prepare(&format!("SELECT {COLS} FROM relay_links ORDER BY created_at")) else {
        return Vec::new();
    };
    stmt.query_map([], row_to_link)
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

/// 接手那段认出来了：补上 child（只补空的，已有不改——同一份简报不会接给两段）
fn attach_at(conn: &Connection, name: &str, agent: &str, session: &str) -> Result<bool, String> {
    ensure_table(conn)?;
    let n = conn
        .execute(
            "UPDATE relay_links SET child_agent=?2, child_session=?3
             WHERE brief_name=?1 AND child_session IS NULL
               AND NOT (parent_agent=?2 AND parent_session=?3)",
            params![name, agent, session],
        )
        .map_err(|e| format!("记下接力关系失败: {e}"))?;
    if n > 0 {
        sessions::invalidate_scan_cache();
    }
    Ok(n > 0)
}

/// 会话文件：扫描结果（含并进接续链的成员）里按 agent + id 找
pub(crate) fn session_file(agent: &str, session_id: &str) -> Option<String> {
    let scan = sessions::cached_scan();
    scan.sessions
        .iter()
        .chain(scan.hidden_members.iter())
        .find(|s| s.agent == agent && s.session_id == session_id)
        .map(|s| s.file_path.clone())
}

fn session_meta(agent: &str, session_id: &str) -> Option<SessionMetaDto> {
    let scan = sessions::cached_scan();
    scan.sessions
        .into_iter()
        .chain(scan.hidden_members)
        .find(|s| s.agent == agent && s.session_id == session_id)
}

fn message_text(m: &ChatMessageDto) -> String {
    m.blocks
        .iter()
        .filter(|b| b.kind == "text")
        .map(|b| b.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 这段会话里最后一句带接力抬头的人话：(消息下标, 简报名)
fn last_relay_marker(messages: &[ChatMessageDto]) -> Option<(usize, String)> {
    messages.iter().enumerate().rev().find_map(|(i, m)| {
        if m.role != "user" {
            return None;
        }
        let text = message_text(m);
        let after_pack = sessions::strip_project_pack(&text);
        relay_brief::split_relay_prompt(after_pack).and_then(|p| p.brief_name.map(|n| (i, n)))
    })
}

/// 整条时间线（这段会话往回追到最早那家）。upto：只取这段会话的前 upto 条消息。
/// 遇到接力抬头：抬头之前的部分换成前一段（交到 parent_through 为止）的时间线——
/// 换回时抬头之前是这家自己早先的那几轮，前一段的时间线已经包含它们，不重复
pub(crate) fn timeline(
    conn: Option<&Connection>,
    agent: &str,
    session_id: &str,
    file_path: &str,
    upto: Option<usize>,
) -> Vec<Round> {
    timeline_at(conn, agent, session_id, file_path, upto, 0)
}

fn timeline_at(
    conn: Option<&Connection>,
    agent: &str,
    session_id: &str,
    file_path: &str,
    upto: Option<usize>,
    depth: usize,
) -> Vec<Round> {
    let mut messages = sessions::conversation_impl(agent, file_path);
    if let Some(n) = upto {
        messages.truncate(n);
    }
    let load = |a: &str, s: &str| session_file(a, s).map(|f| sessions::conversation_impl(a, &f));
    timeline_of(conn, agent, session_id, &messages, depth, &load)
}

/// 已读好的一段消息（「从这里分叉」截过的）拼时间线；读不了库时只切这一段
pub(crate) fn timeline_from_messages(agent: &str, session_id: &str, messages: &[ChatMessageDto]) -> Vec<Round> {
    let conn = sessions::open_db().ok();
    let load = |a: &str, s: &str| session_file(a, s).map(|f| sessions::conversation_impl(a, &f));
    timeline_of(conn.as_ref(), agent, session_id, messages, 0, &load)
}

/// load：按 agent + id 读一段会话的消息（测试里换成内存）
fn timeline_of(
    conn: Option<&Connection>,
    agent: &str,
    session_id: &str,
    messages: &[ChatMessageDto],
    depth: usize,
    load: &dyn Fn(&str, &str) -> Option<Vec<ChatMessageDto>>,
) -> Vec<Round> {
    let Some(conn) = conn.filter(|_| depth < MAX_DEPTH) else {
        return relay_brief::split_rounds(agent, session_id, messages);
    };
    let Some((k, name)) = last_relay_marker(messages) else {
        return relay_brief::split_rounds(agent, session_id, messages);
    };
    let link = link_by_brief(conn, &name)
        .filter(|l| !(l.parent_agent == agent && l.parent_session == session_id));
    let prefix = link.as_ref().and_then(|l| {
        if l.child_session.is_none() {
            let _ = attach_at(conn, &name, agent, session_id);
        }
        let mut parent = load(&l.parent_agent, &l.parent_session)?;
        parent.truncate(l.parent_through);
        Some(timeline_of(Some(conn), &l.parent_agent, &l.parent_session, &parent, depth + 1, load))
    });
    let mut out = match prefix {
        Some(p) => p,
        // 前一段找不到了：退回这段自己抬头之前的几轮
        None => relay_brief::split_rounds(agent, session_id, &messages[..k]),
    };
    out.extend(relay_brief::split_rounds(agent, session_id, &messages[k..]));
    out
}

/// 简报文件名：时间戳 + 4 位随机，同一秒两份不撞（文件名只含字母数字与 -，抬头里认得出）
fn brief_name() -> String {
    let stamp: String = sessions::now_iso().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let rand: String = uuid::Uuid::new_v4().simple().to_string().chars().take(4).collect();
    format!("handoff-{stamp}-{rand}.md")
}

fn write_brief(cwd: &str, name: &str, text: &str) -> Result<PathBuf, String> {
    let root = crate::paths::canonicalize_plain(Path::new(&sessions::expand_tilde(cwd)))
        .map_err(|e| format!("项目目录无效: {e}"))?;
    if !root.is_dir() {
        return Err("项目路径不是目录".into());
    }
    let path = root.join(".ccode").join(name);
    fs::create_dir_all(root.join(".ccode")).map_err(|e| format!("创建 .ccode 目录失败: {e}"))?;
    crate::handoff::ensure_handoff_ignored(&root);
    crate::profiles::atomic_write(&path, &crate::handoff::redact_and_cap(text))?;
    Ok(path)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayPrepareDto {
    /// full：新开一段整份交接；delta：接回原来那段补增量；resume_only：接回、没有要补的
    pub kind: String,
    pub brief_path: Option<String>,
    pub brief_name: Option<String>,
    /// 写在人那句话前面的接力抬头（不含「----」与人话）；resume_only 为 None
    pub framing: Option<String>,
    /// 接回哪段（delta / resume_only）
    pub resume_session_id: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelaySource {
    pub agent: String,
    pub session_id: String,
    pub file_path: String,
    pub cwd: String,
    pub title: Option<String>,
}

fn prepare_impl(
    conn: &Connection,
    source: &RelaySource,
    target_agent: &str,
    resume_session: Option<&str>,
    with_words: bool,
) -> Result<RelayPrepareDto, String> {
    if target_agent == source.agent && resume_session.is_none() {
        return Err("接力要换一家 Agent；同一家另开请用「分叉成新对话」".into());
    }
    let through = sessions::conversation_impl(&source.agent, &source.file_path).len();
    if through == 0 {
        return Err("这段对话还没有记录，直接换 Agent 开聊即可".into());
    }
    let rounds = timeline(Some(conn), &source.agent, &source.session_id, &source.file_path, None);
    let git = crate::git_info::git_status_sync(&source.cwd).ok();
    let title = source.title.clone().unwrap_or_default();
    let name = brief_name();
    let rel = format!(".ccode/{name}");

    if let Some(resume) = resume_session {
        // 换回：从这家那段最后一轮之后算起
        let left = rounds
            .iter()
            .rposition(|r| r.agent == target_agent && r.session_id == resume);
        if let Some(w) = left {
            let after = &rounds[w + 1..];
            if after.is_empty() {
                return Ok(RelayPrepareDto {
                    kind: "resume_only".into(),
                    brief_path: None,
                    brief_name: None,
                    framing: None,
                    resume_session_id: Some(resume.to_string()),
                    summary: "离开后没有新的轮次，直接接回".into(),
                });
            }
            let text = relay_brief::render(&BriefInput {
                kind: BriefKind::Delta { target: target_agent, left_after: w + 1 },
                title: &title,
                from_agent: &source.agent,
                from_session: &source.session_id,
                cwd: &source.cwd,
                rounds: after,
                first_no: w + 2,
                git: git.as_ref(),
                ai_conclusions: None,
            });
            let path = write_brief(&source.cwd, &name, &text)?;
            insert_link(
                conn,
                &RelayLink {
                    brief_name: name.clone(),
                    parent_agent: source.agent.clone(),
                    parent_session: source.session_id.clone(),
                    parent_through: through,
                    child_agent: Some(target_agent.to_string()),
                    child_session: Some(resume.to_string()),
                    kind: "delta".into(),
                    created_at: sessions::now_iso(),
                },
            )?;
            let by = relay_brief::rounds_by(after);
            return Ok(RelayPrepareDto {
                kind: "delta".into(),
                brief_path: Some(path.to_string_lossy().into_owned()),
                brief_name: Some(name),
                framing: Some(relay_brief::delta_framing(&by, &rel)),
                resume_session_id: Some(resume.to_string()),
                summary: format!("补充简报：{by}"),
            });
        }
        // 那段不在这条时间线上：按新开整份交接
    }

    let text = relay_brief::render(&BriefInput {
        kind: BriefKind::Full,
        title: &title,
        from_agent: &source.agent,
        from_session: &source.session_id,
        cwd: &source.cwd,
        rounds: &rounds,
        first_no: 1,
        git: git.as_ref(),
        ai_conclusions: None,
    });
    let path = write_brief(&source.cwd, &name, &text)?;
    insert_link(
        conn,
        &RelayLink {
            brief_name: name.clone(),
            parent_agent: source.agent.clone(),
            parent_session: source.session_id.clone(),
            parent_through: through,
            child_agent: None,
            child_session: None,
            kind: "full".into(),
            created_at: sessions::now_iso(),
        },
    )?;
    Ok(RelayPrepareDto {
        kind: "full".into(),
        brief_path: Some(path.to_string_lossy().into_owned()),
        brief_name: Some(name),
        framing: Some(relay_brief::full_framing(&source.agent, &source.session_id, &rel, with_words)),
        resume_session_id: None,
        summary: format!("交接简报：共 {} 轮", rounds.len()),
    })
}

/// 发送那一刻：写交接简报（或补充简报）、记下接力关系，回抬头给聊天层拼在人那句话前面
#[tauri::command]
pub async fn relay_prepare(
    source: RelaySource,
    target_agent: String,
    resume_session: Option<String>,
    with_words: Option<bool>,
) -> Result<RelayPrepareDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = sessions::open_db()?;
        prepare_impl(&conn, &source, &target_agent, resume_session.as_deref(), with_words.unwrap_or(true))
    })
    .await
    .map_err(|e| format!("生成交接简报失败: {e}"))?
}

/// 提炼接力（DigestPicker）发给另一家时登记：简报已由 build_session_digest 写好
#[tauri::command]
pub async fn relay_register_brief(brief_path: String, source: RelaySource) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = Path::new(&brief_path)
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| relay_brief::brief_name_in(n).as_deref() == Some(*n))
            .ok_or("简报文件名不对")?
            .to_string();
        let conn = sessions::open_db()?;
        insert_link(
            &conn,
            &RelayLink {
                brief_name: name.clone(),
                parent_agent: source.agent.clone(),
                parent_session: source.session_id.clone(),
                parent_through: sessions::conversation_impl(&source.agent, &source.file_path).len(),
                child_agent: None,
                child_session: None,
                kind: "full".into(),
                created_at: sessions::now_iso(),
            },
        )?;
        Ok(relay_brief::full_framing(&source.agent, &source.session_id, &format!(".ccode/{name}"), false))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 接手那段认出来了（标签认出自己的会话、看到第一句带接力抬头时）
#[tauri::command]
pub async fn relay_attach(brief_name: String, agent: String, session_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = sessions::open_db()?;
        attach_at(&conn, &brief_name, &agent, &session_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayTargetQuery {
    pub agent: String,
    /// 接回时要用的模型（算上下文窗口）；不知道为 None
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayOptionDto {
    pub agent: String,
    /// 这家在这段接力对话里最近的那段
    pub prior_session: String,
    pub prior_file: Option<String>,
    /// 它离开之后有几轮、谁做的
    pub delta_rounds: usize,
    pub rounds_by: String,
    /// 能接回（记录还在、这家支持按 id 接回）
    pub resumable: bool,
    /// 建议新开（上下文快满、隔太久、记录不在）
    pub recommend_new: bool,
    pub reason: Option<String>,
}

fn context_used(messages: &[ChatMessageDto]) -> Option<u64> {
    messages
        .iter()
        .rev()
        .find_map(|m| m.usage.as_ref())
        .map(|u| u.input + u.cache_read + u.cache_write)
}

fn days_since(iso: &str) -> Option<i64> {
    let t = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    Some((chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_days())
}

/// 换配置层列接力目标时：这段接力对话里已经有哪几家、各自换回是接回原来那段还是建议新开
fn options_impl(conn: &Connection, source: &RelaySource, targets: &[RelayTargetQuery]) -> Vec<RelayOptionDto> {
    let rounds = timeline(Some(conn), &source.agent, &source.session_id, &source.file_path, None);
    let mut out = Vec::new();
    for t in targets {
        if t.agent == source.agent {
            continue;
        }
        let Some(w) = rounds.iter().rposition(|r| r.agent == t.agent) else {
            continue;
        };
        let prior = rounds[w].session_id.clone();
        let after = &rounds[w + 1..];
        let file = session_file(&t.agent, &prior);
        let can_resume = !crate::agents::resume_args(&t.agent, &prior).1.is_empty();
        let mut reason = None;
        match &file {
            None => reason = Some("原来那段的记录已不在".to_string()),
            Some(f) => {
                let used = context_used(&sessions::conversation_impl(&t.agent, f));
                let window = t
                    .model
                    .as_deref()
                    .and_then(|m| crate::model_registry::model_context_size_known_for(m, None))
                    .filter(|w| *w > 0);
                if let (Some(u), Some(w)) = (used, window) {
                    let permille = u.saturating_mul(1000) / w as u64;
                    if permille >= CONTEXT_FULL_PERMILLE {
                        reason = Some(format!("原来那段上下文已用 {}%", permille / 10));
                    }
                }
                if reason.is_none() {
                    let days = session_meta(&t.agent, &prior)
                        .and_then(|m| m.updated_at)
                        .and_then(|u| days_since(&u));
                    if let Some(d) = days.filter(|d| *d >= STALE_DAYS) {
                        reason = Some(format!("原来那段已经 {d} 天没动"));
                    }
                }
            }
        }
        if !can_resume && reason.is_none() {
            reason = Some(format!("{} 不支持按会话接回", relay_brief::agent_label(&t.agent)));
        }
        out.push(RelayOptionDto {
            agent: t.agent.clone(),
            prior_session: prior,
            prior_file: file.clone(),
            delta_rounds: after.len(),
            rounds_by: relay_brief::rounds_by(after),
            resumable: file.is_some() && can_resume,
            recommend_new: reason.is_some(),
            reason,
        });
    }
    out
}

#[tauri::command]
pub async fn relay_options(source: RelaySource, targets: Vec<RelayTargetQuery>) -> Result<Vec<RelayOptionDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = sessions::open_db()?;
        Ok(options_impl(&conn, &source, &targets))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelaySegmentDto {
    pub parent_agent: String,
    pub parent_session: String,
    pub parent_title: Option<String>,
    pub parent_file: Option<String>,
    pub kind: String,
    /// 前一段交出前的最后几条（已脱敏）；记录不在为空
    pub messages: Vec<ChatMessageDto>,
    /// 前面还有没摆出来的
    pub more_before: bool,
}

/// 聊天里展开接力卡：前一段交出前的那几轮
#[tauri::command]
pub async fn relay_segment(brief_name: String) -> Result<Option<RelaySegmentDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = sessions::open_db()?;
        let Some(link) = link_by_brief(&conn, &brief_name) else {
            return Ok(None);
        };
        let meta = session_meta(&link.parent_agent, &link.parent_session);
        let file = meta.as_ref().map(|m| m.file_path.clone());
        let mut messages = file
            .as_deref()
            .map(|f| sessions::conversation_impl(&link.parent_agent, f))
            .unwrap_or_default();
        messages.truncate(link.parent_through);
        let start = messages.len().saturating_sub(SEGMENT_TAIL);
        let more_before = start > 0;
        let messages = messages.split_off(start);
        Ok(Some(RelaySegmentDto {
            parent_title: meta.as_ref().and_then(|m| m.custom_title.clone().or(m.title.clone())),
            parent_agent: link.parent_agent,
            parent_session: link.parent_session,
            parent_file: file,
            kind: link.kind,
            messages,
            more_before,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 列表收尾：一段接力对话只占一行。代表 = 最近一次接力接手的那段（还在列表里的话），
/// 其余各段从列表里拿掉、记进代表的 relay_segments；代表的标题没人改过时用第一段的标题
pub(crate) fn apply_relay_chains(conn: &Connection, list: &mut Vec<SessionMetaDto>) {
    let links: Vec<RelayLink> = all_links(conn)
        .into_iter()
        .filter(|l| l.child_session.is_some())
        .collect();
    if links.is_empty() {
        return;
    }
    let key = |a: &str, s: &str| format!("{a}\n{s}");
    // 并查集：按接力关系把各段连成一家
    let mut parent: HashMap<String, String> = HashMap::new();
    fn find(p: &mut HashMap<String, String>, x: &str) -> String {
        let up = p.get(x).cloned().unwrap_or_else(|| x.to_string());
        if up == x {
            return up;
        }
        let root = find(p, &up);
        p.insert(x.to_string(), root.clone());
        root
    }
    for l in &links {
        let a = key(&l.parent_agent, &l.parent_session);
        let b = key(l.child_agent.as_deref().unwrap_or(""), l.child_session.as_deref().unwrap_or(""));
        let ra = find(&mut parent, &a);
        let rb = find(&mut parent, &b);
        if ra != rb {
            parent.insert(ra, rb);
        }
    }
    // 每一家：各段按第一次出现的先后（最早那段的 parent 在前），代表 = 最后一次接力的 child
    let mut groups: HashMap<String, (Vec<String>, String)> = HashMap::new();
    for l in &links {
        let a = key(&l.parent_agent, &l.parent_session);
        let b = key(l.child_agent.as_deref().unwrap_or(""), l.child_session.as_deref().unwrap_or(""));
        let root = find(&mut parent, &a);
        let g = groups.entry(root).or_insert_with(|| (Vec::new(), String::new()));
        for k in [&a, &b] {
            if !g.0.contains(k) {
                g.0.push(k.clone());
            }
        }
        g.1 = b;
    }
    let index: HashMap<String, usize> = list
        .iter()
        .enumerate()
        .map(|(i, s)| (key(&s.agent, &s.session_id), i))
        .collect();
    let mut hide: Vec<usize> = Vec::new();
    for (_, (order, rep_key)) in groups {
        let present: Vec<&String> = order.iter().filter(|k| index.contains_key(*k)).collect();
        if present.len() < 2 {
            continue;
        }
        let rep_i = match index.get(&rep_key) {
            Some(i) => *i,
            None => present
                .iter()
                .map(|k| index[k.as_str()])
                .max_by(|x, y| list[*x].updated_at.cmp(&list[*y].updated_at))
                .unwrap_or(0),
        };
        let segments: Vec<RelaySegmentRef> = present
            .iter()
            .map(|k| {
                let s = &list[index[k.as_str()]];
                RelaySegmentRef {
                    agent: s.agent.clone(),
                    session_id: s.session_id.clone(),
                    title: s.custom_title.clone().or(s.title.clone()),
                    file_path: s.file_path.clone(),
                    updated_at: s.updated_at.clone(),
                }
            })
            .collect();
        let mut agents: Vec<String> = Vec::new();
        for seg in &segments {
            if !agents.contains(&seg.agent) {
                agents.push(seg.agent.clone());
            }
        }
        let first = segments.first().cloned();
        let rep = &mut list[rep_i];
        if !rep.title_by_user {
            if let Some(t) = first.and_then(|f| f.title).filter(|t| !t.trim().is_empty()) {
                rep.custom_title = Some(t);
            }
        }
        rep.relay.relay_agents = agents;
        rep.relay.relay_segments = segments;
        if rep.handoff_from_agent.is_none() {
            if let Some(l) = links.iter().rev().find(|l| {
                l.child_agent.as_deref() == Some(rep.agent.as_str())
                    && l.child_session.as_deref() == Some(rep.session_id.as_str())
            }) {
                rep.handoff_from_agent = Some(l.parent_agent.clone());
                rep.handoff_from_session = Some(l.parent_session.clone());
            }
        }
        for k in present {
            let i = index[k.as_str()];
            if i != rep_i {
                hide.push(i);
            }
        }
    }
    if hide.is_empty() {
        return;
    }
    hide.sort_unstable();
    hide.dedup();
    let mut i = 0;
    list.retain(|_| {
        let keep = hide.binary_search(&i).is_err();
        i += 1;
        keep
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::BlockDto;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        ensure_table(&c).unwrap();
        c
    }

    fn msg(role: &str, text: &str) -> ChatMessageDto {
        ChatMessageDto {
            role: role.into(),
            blocks: vec![BlockDto { kind: "text".into(), text: text.into(), tool_name: None, is_error: false, call_id: None }],
            timestamp: None,
            usage: None,
            id: None,
            cwd: None,
        }
    }

    fn link(name: &str, pa: &str, ps: &str, through: usize, ca: Option<&str>, cs: Option<&str>, kind: &str, at: &str) -> RelayLink {
        RelayLink {
            brief_name: name.into(),
            parent_agent: pa.into(),
            parent_session: ps.into(),
            parent_through: through,
            child_agent: ca.map(String::from),
            child_session: cs.map(String::from),
            kind: kind.into(),
            created_at: at.into(),
        }
    }

    #[test]
    fn timeline_follows_full_then_delta_back() {
        let conn = db();
        // A（Claude）两轮 → 交给 B（Codex）一轮 → 换回 A 补一轮
        insert_link(&conn, &link("handoff-1-aaaa.md", "claude-code", "A", 4, None, None, "full", "1")).unwrap();
        insert_link(&conn, &link("handoff-2-bbbb.md", "codex", "B", 2, Some("claude-code"), Some("A"), "delta", "2")).unwrap();
        let a = vec![
            msg("user", "第一问"),
            msg("assistant", "答一"),
            msg("user", "第二问"),
            msg("assistant", "答二"),
            msg("user", &format!("{}\n----\n回来了", relay_brief::delta_framing("Codex 做了 1 轮", ".ccode/handoff-2-bbbb.md"))),
            msg("assistant", "接上了"),
        ];
        let b = vec![
            msg("user", &format!("{}\n----\n修测试", relay_brief::full_framing("claude-code", "A", ".ccode/handoff-1-aaaa.md", true))),
            msg("assistant", "修好了"),
        ];
        let (a2, b2) = (a.clone(), b.clone());
        let load = move |agent: &str, _s: &str| -> Option<Vec<ChatMessageDto>> {
            Some(if agent == "codex" { b2.clone() } else { a2.clone() })
        };
        let rounds = timeline_of(Some(&conn), "claude-code", "A", &a, 0, &load);
        let said: Vec<(&str, &str)> = rounds.iter().map(|r| (r.agent.as_str(), r.user.as_str())).collect();
        assert_eq!(
            said,
            vec![("claude-code", "第一问"), ("claude-code", "第二问"), ("codex", "修测试"), ("claude-code", "回来了")]
        );
        // B 第一条认出后补上 child
        assert_eq!(link_by_brief(&conn, "handoff-1-aaaa.md").unwrap().child_session.as_deref(), Some("B"));
        // 前一段读不到：退回自己的几轮
        let alone = timeline_of(Some(&conn), "codex", "B", &b, 0, &|_, _| None);
        assert_eq!(alone.len(), 1);
    }

    fn meta(agent: &str, id: &str, updated: &str) -> SessionMetaDto {
        let mut s = crate::handoff::test_session(agent, id, "/p", updated);
        s.title = Some(format!("{agent}-{id}"));
        s
    }

    #[test]
    fn chains_collapse_to_latest_child_with_first_title() {
        let conn = db();
        insert_link(&conn, &link("handoff-1-aaaa.md", "claude-code", "A", 4, Some("codex"), Some("B"), "full", "1")).unwrap();
        insert_link(&conn, &link("handoff-2-bbbb.md", "codex", "B", 2, Some("claude-code"), Some("A"), "delta", "2")).unwrap();
        insert_link(&conn, &link("handoff-3-cccc.md", "claude-code", "A", 8, None, None, "full", "3")).unwrap();
        let mut list = vec![meta("claude-code", "A", "3"), meta("codex", "B", "2"), meta("kimi", "K", "9")];
        apply_relay_chains(&conn, &mut list);
        assert_eq!(list.len(), 2, "B 并进 A 那一行");
        let a = list.iter().find(|s| s.session_id == "A").unwrap();
        assert_eq!(a.relay.relay_agents, vec!["claude-code".to_string(), "codex".to_string()]);
        assert_eq!(a.relay.relay_segments.len(), 2);
        assert_eq!(a.custom_title.as_deref(), Some("claude-code-A"));
        assert!(list.iter().any(|s| s.session_id == "K" && s.relay.relay_agents.is_empty()));
    }

    #[test]
    fn attach_fills_only_once_and_never_self() {
        let conn = db();
        insert_link(&conn, &link("handoff-9-dddd.md", "codex", "B", 2, None, None, "full", "1")).unwrap();
        assert!(!attach_at(&conn, "handoff-9-dddd.md", "codex", "B").unwrap(), "不接到自己");
        assert!(attach_at(&conn, "handoff-9-dddd.md", "kimi", "K").unwrap());
        assert!(!attach_at(&conn, "handoff-9-dddd.md", "kimi", "K2").unwrap());
        assert_eq!(link_by_brief(&conn, "handoff-9-dddd.md").unwrap().child_session.as_deref(), Some("K"));
    }

    #[test]
    fn brief_names_are_unique_and_parseable() {
        let a = brief_name();
        let b = brief_name();
        assert_ne!(a, b);
        assert_eq!(relay_brief::brief_name_in(&format!(".ccode/{a}")).as_deref(), Some(a.as_str()));
    }
}
