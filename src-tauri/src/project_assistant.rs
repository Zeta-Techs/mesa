//! 项目助手（2026-11-04 用户拍板，docs/design-project-assistant.md）：项目里有不明白、出了错，问它。
//!
//! 这里只管三样落盘与一次调用，项目快照由前端用已有命令拼（project-snapshot.ts）：
//! - **Mesa 出错记录**：前端统一接住失败的后台调用（mesa-error-capture.ts），按参数里的路径归到项目，
//!   写进配置目录 `project-assistant/<项目键>/mesa-errors.jsonl`。不写进项目 `.ccode/`——那里每多一个文件
//!   都要同步忽略规则、合并判定与保存排除表；换来的代价是记录不跟着项目换机器。
//! - **问答记录**：同目录 `assistant.jsonl`，面板显示、可清空。
//! - **问一次**：出站前整段脱敏（快照里有路径、报错原文），按专属绑定的连接 / 模型无头调用一次，回答同样脱敏后落记录。
//!
//! 只读、只解释：这里没有任何改项目文件、派活、传话的口子。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const DIR: &str = "project-assistant";
const ERRORS_FILE: &str = "mesa-errors.jsonl";
const LOG_FILE: &str = "assistant.jsonl";
/// 出错记录只留 30 天、最多 500 条；同一处错 10 分钟内再犯只加次数
const ERRORS_KEEP_DAYS: i64 = 30;
const ERRORS_CAP: usize = 500;
const DEDUPE_MINUTES: i64 = 10;
/// 问答记录最多留 200 轮（面板全显示，喂给 AI 的只取最近几轮，由前端定）
const LOG_CAP: usize = 200;
const FIELD_CAP: usize = 4000;
const ANSWER_CAP: usize = 12000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MesaErrorDto {
    /// 最后一次发生的时间（RFC3339）
    pub at: String,
    /// 第一次发生的时间
    #[serde(default)]
    pub first_at: String,
    /// 10 分钟内同一处错的次数
    #[serde(default = "one")]
    pub count: u32,
    /// invoke（后台调用失败）| toast（只有界面提示）| crash（前端未处理的报错）
    pub source: String,
    /// 后台命令名；只有界面提示时为空
    #[serde(default)]
    pub command: String,
    pub message: String,
    /// 紧跟着弹出的红色提示原文（用户真正看到的那句）
    #[serde(default)]
    pub notice: Option<String>,
    #[serde(default)]
    pub version: String,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssistantTurnDto {
    pub at: String,
    pub question: String,
    pub answer: String,
    /// 用的哪个连接（给人看的一行，如「Codex · 公司中转 · gpt-5」）
    #[serde(default)]
    pub connection: String,
}

fn truncate(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        return text.to_string();
    }
    let mut out: String = text.chars().take(cap).collect();
    out.push_str("…（已截断）");
    out
}

fn project_dir(project_root: &str) -> Result<PathBuf, String> {
    let root = crate::sessions::expand_tilde(project_root.trim());
    if root.is_empty() {
        return Err("缺少项目路径".into());
    }
    let key = crate::paths::path_key(&root);
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Ok(crate::storage::config_root()
        .ok_or("无法确定配置目录")?
        .join(DIR)
        .join(hex))
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Vec<T> {
    fs::read_to_string(path)
        .map(|text| {
            text.lines()
                .filter(|l| !l.trim().is_empty())
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn write_jsonl<T: Serialize>(path: &Path, rows: &[T]) -> Result<(), String> {
    let mut out = String::new();
    for row in rows {
        out.push_str(&serde_json::to_string(row).map_err(|e| e.to_string())?);
        out.push('\n');
    }
    crate::storage::atomic_write(path, out.as_bytes(), true)
}

fn with_lock<R>(dir: &Path, f: impl FnOnce() -> Result<R, String>) -> Result<R, String> {
    fs::create_dir_all(dir).map_err(|e| format!("建记录目录失败：{e}"))?;
    let _lock = crate::storage::lock_at(&dir.join("records.lock"))?;
    f()
}

fn parse_at(at: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(at).ok()
}

/// 合并进已有记录：同一处错（来源 + 命令 + 消息）10 分钟内再犯只加次数、更新时间；
/// 30 天前的丢掉，超过上限丢最旧的
pub(crate) fn merge_error(
    mut rows: Vec<MesaErrorDto>,
    entry: MesaErrorDto,
    now: chrono::DateTime<chrono::FixedOffset>,
) -> Vec<MesaErrorDto> {
    rows.retain(|r| {
        parse_at(&r.at).is_some_and(|t| (now - t).num_days() < ERRORS_KEEP_DAYS)
    });
    let same = rows.iter_mut().rev().find(|r| {
        r.source == entry.source
            && r.command == entry.command
            && r.message == entry.message
            && parse_at(&r.at).is_some_and(|t| (now - t).num_minutes() < DEDUPE_MINUTES)
    });
    match same {
        Some(row) => {
            row.count = row.count.saturating_add(1);
            row.at = entry.at;
            if entry.notice.is_some() {
                row.notice = entry.notice;
            }
        }
        None => rows.push(entry),
    }
    if rows.len() > ERRORS_CAP {
        let drop = rows.len() - ERRORS_CAP;
        rows.drain(..drop);
    }
    rows
}

/// 界面提示跟上来时补到最近一条还没配提示的同项目记录上（只看 5 秒内的）
pub(crate) fn attach_notice(
    rows: &mut [MesaErrorDto],
    notice: &str,
    now: chrono::DateTime<chrono::FixedOffset>,
) -> bool {
    let Some(row) = rows.iter_mut().rev().find(|r| {
        r.notice.is_none() && parse_at(&r.at).is_some_and(|t| (now - t).num_seconds().abs() <= 5)
    }) else {
        return false;
    };
    row.notice = Some(notice.to_string());
    true
}

fn now_fixed() -> chrono::DateTime<chrono::FixedOffset> {
    chrono::Local::now().fixed_offset()
}

fn record_error_sync(
    project_root: &str,
    source: &str,
    command: &str,
    message: &str,
    notice: Option<&str>,
) -> Result<(), String> {
    let source = match source {
        "invoke" | "toast" | "crash" => source,
        _ => return Err(format!("不认识的出错来源：{source}")),
    };
    let message = truncate(&crate::sessions::redact_sensitive_text(message.trim()), FIELD_CAP);
    let notice = notice
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| truncate(&crate::sessions::redact_sensitive_text(n), FIELD_CAP));
    if message.is_empty() && notice.is_none() {
        return Ok(());
    }
    let dir = project_dir(project_root)?;
    let path = dir.join(ERRORS_FILE);
    with_lock(&dir, || {
        let now = now_fixed();
        let mut rows: Vec<MesaErrorDto> = read_jsonl(&path);
        // 只有一句界面提示：先试着补到刚记下的那条后台失败上，补不上才单记一条
        if source == "toast" {
            if let Some(n) = notice.as_deref() {
                if attach_notice(&mut rows, n, now) {
                    return write_jsonl(&path, &rows);
                }
            }
        }
        let at = now.to_rfc3339();
        let entry = MesaErrorDto {
            at: at.clone(),
            first_at: at,
            count: 1,
            source: source.to_string(),
            command: command.trim().chars().take(120).collect(),
            message: if message.is_empty() { notice.clone().unwrap_or_default() } else { message },
            notice,
            version: env!("CARGO_PKG_VERSION").to_string(),
        };
        let rows = merge_error(rows, entry, now);
        write_jsonl(&path, &rows)
    })
}

#[tauri::command]
pub async fn mesa_error_record(
    project_root: String,
    source: String,
    command: Option<String>,
    message: String,
    notice: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        record_error_sync(
            &project_root,
            &source,
            command.as_deref().unwrap_or(""),
            &message,
            notice.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 最近的在后（与文件同序）
#[tauri::command]
pub async fn mesa_errors_read(project_root: String, limit: Option<usize>) -> Result<Vec<MesaErrorDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = project_dir(&project_root)?.join(ERRORS_FILE);
        let rows: Vec<MesaErrorDto> = read_jsonl(&path);
        let limit = limit.unwrap_or(ERRORS_CAP).min(ERRORS_CAP);
        Ok(rows[rows.len().saturating_sub(limit)..].to_vec())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn assistant_log_read(project_root: String) -> Result<Vec<AssistantTurnDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(read_jsonl(&project_dir(&project_root)?.join(LOG_FILE)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn assistant_log_clear(project_root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = project_dir(&project_root)?;
        let path = dir.join(LOG_FILE);
        with_lock(&dir, || match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("清空失败：{e}")),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn append_turn(project_root: &str, turn: AssistantTurnDto) -> Result<(), String> {
    let dir = project_dir(project_root)?;
    let path = dir.join(LOG_FILE);
    with_lock(&dir, || {
        let mut rows: Vec<AssistantTurnDto> = read_jsonl(&path);
        rows.push(turn);
        if rows.len() > LOG_CAP {
            let drop = rows.len() - LOG_CAP;
            rows.drain(..drop);
        }
        write_jsonl(&path, &rows)
    })
}

/// 问一次：prompt 是前端拼好的（规矩 + 项目快照 + 最近几轮 + 这次的问题），这里整段脱敏后出站。
/// profile_id 为空 = 设置里「AI 功能」的连接（fn_key = project-assistant）；model 为空 = 连接里的第一个
#[tauri::command]
pub async fn project_assistant_ask(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    project_root: String,
    profile_id: Option<String>,
    model: Option<String>,
    connection: Option<String>,
    question: String,
    prompt: String,
) -> Result<AssistantTurnDto, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let question = question.trim().to_string();
        if question.is_empty() {
            return Err("先写要问什么".into());
        }
        let prompt = crate::sessions::redact_sensitive_text(&prompt);
        let raw = crate::ai::ai_prompt_impl_model(
            profiles,
            profile_id,
            model.filter(|m| !m.trim().is_empty()),
            Some("project-assistant"),
            prompt,
        )?;
        let answer = truncate(crate::sessions::redact_sensitive_text(raw.trim()).as_str(), ANSWER_CAP);
        if answer.is_empty() {
            return Err("AI 没有回答，换个说法再问一次".into());
        }
        let turn = AssistantTurnDto {
            at: now_fixed().to_rfc3339(),
            question: truncate(&crate::sessions::redact_sensitive_text(&question), FIELD_CAP),
            answer,
            connection: connection.unwrap_or_default().chars().take(200).collect(),
        };
        // 记不下不挡回答：这次照样给人看
        let _ = append_turn(&project_root, turn.clone());
        Ok(turn)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 评审退回意见（工作副本里的 `.ccode/review-notes.md`）：快照用，只读、有上限、脱敏
#[tauri::command]
pub async fn assistant_review_notes(worktree_path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(crate::sessions::expand_tilde(&worktree_path)).join(".ccode/review-notes.md");
        let file = fs::File::open(path).ok()?;
        let mut text = String::new();
        std::io::Read::read_to_string(&mut std::io::Read::take(file, 16 * 1024), &mut text).ok()?;
        let text = text.trim();
        (!text.is_empty()).then(|| crate::sessions::redact_sensitive_text(text))
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(minutes_ago: i64) -> String {
        (now_fixed() - chrono::Duration::minutes(minutes_ago)).to_rfc3339()
    }

    fn row(command: &str, message: &str, minutes_ago: i64) -> MesaErrorDto {
        MesaErrorDto {
            at: at(minutes_ago),
            first_at: at(minutes_ago),
            count: 1,
            source: "invoke".into(),
            command: command.into(),
            message: message.into(),
            notice: None,
            version: "0".into(),
        }
    }

    #[test]
    fn same_error_within_ten_minutes_only_counts_up() {
        let rows = vec![row("save_step", "nothing added", 3)];
        let merged = merge_error(rows, row("save_step", "nothing added", 0), now_fixed());
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].count, 2);
        let merged = merge_error(merged, row("save_step", "other", 0), now_fixed());
        assert_eq!(merged.len(), 2);
        let old = vec![row("save_step", "nothing added", 30)];
        assert_eq!(merge_error(old, row("save_step", "nothing added", 0), now_fixed()).len(), 2);
    }

    #[test]
    fn old_rows_expire_and_cap_holds() {
        let rows = vec![row("a", "x", 60 * 24 * 31)];
        let merged = merge_error(rows, row("b", "y", 0), now_fixed());
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].command, "b");
        let many: Vec<_> = (0..ERRORS_CAP).map(|i| row("c", &i.to_string(), 0)).collect();
        let merged = merge_error(many, row("c", "new", 0), now_fixed());
        assert_eq!(merged.len(), ERRORS_CAP);
        assert_eq!(merged.last().unwrap().message, "new");
        assert_eq!(merged[0].message, "1");
    }

    #[test]
    fn notice_attaches_only_to_fresh_unmatched_row() {
        let mut rows = vec![row("a", "x", 0)];
        assert!(attach_notice(&mut rows, "保存失败：x", now_fixed()));
        assert_eq!(rows[0].notice.as_deref(), Some("保存失败：x"));
        assert!(!attach_notice(&mut rows, "又一句", now_fixed()), "已配过提示的不再配");
        let mut stale = vec![row("a", "x", 2)];
        assert!(!attach_notice(&mut stale, "晚到的提示", now_fixed()));
    }

    #[test]
    fn records_and_turns_live_per_project_in_config_dir() {
        let tmp = std::env::temp_dir().join(format!("mesa-assistant-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let _guard = crate::storage::redirect_config_root(&tmp);
        record_error_sync("/p/one", "invoke", "save_step", "boom", None).unwrap();
        record_error_sync("/p/one", "toast", "", "", Some("保存进项目失败：boom")).unwrap();
        record_error_sync("/p/two", "invoke", "x", "other", None).unwrap();
        let one: Vec<MesaErrorDto> = read_jsonl(&project_dir("/p/one").unwrap().join(ERRORS_FILE));
        assert_eq!(one.len(), 1, "提示补到了刚才那条后台失败上");
        assert_eq!(one[0].notice.as_deref(), Some("保存进项目失败：boom"));
        assert!(!project_dir("/p/one").unwrap().starts_with("/p/one"), "不写进项目目录");
        assert!(record_error_sync("/p/one", "weird", "", "x", None).is_err());
        append_turn("/p/one", AssistantTurnDto { at: at(0), question: "q".into(), answer: "a".into(), connection: String::new() }).unwrap();
        let turns: Vec<AssistantTurnDto> = read_jsonl(&project_dir("/p/one").unwrap().join(LOG_FILE));
        assert_eq!(turns.len(), 1);
        let none: Vec<AssistantTurnDto> = read_jsonl(&project_dir("/p/two").unwrap().join(LOG_FILE));
        assert!(none.is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }
}
