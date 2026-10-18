//! Mesa 内部对话保留期清理（2026-10-17 用户拍板：默认开、保留 30 天，设置页可改天数或关掉）。
//!
//! 只动 Mesa 自己产生的后台对话：同时满足「被登记为内部」+「工作目录是 Mesa 的一次性临时目录
//! （`ccode-ai-<uuid>`）或定时雷达隔离目录」+「没被保留（pin）」+「最后活动早于保留期」。
//! 用户项目目录里的对话一条都不碰。删除是永久删除（不进回收站），用量历史不受影响
//! （usage::rebuild 对消失的会话只撤索引标记、保留用量行）。
//! 打开设置页这一项即视为用户对「CLI 会话目录只读」铁律的显式授权（同会话删除一类例外）。

use crate::sessions::SessionMetaDto;
use chrono::{DateTime, Duration, Utc};
use rusqlite::params;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) const DEFAULT_RETENTION_DAYS: u32 = 30;
const LAST_CLEAN_KEY: &str = "internal_cleanup_at";
/// 自动清理最短间隔：应用连开多天也只每天跑一次
const AUTO_INTERVAL_HOURS: i64 = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalSessionsStatsDto {
    pub total: usize,
    pub total_bytes: u64,
    /// 最早一条的最后活动时间（ISO）；没有为 None
    pub oldest: Option<String>,
    /// 按当前保留期，下一次清理会删的条数与体积
    pub eligible: usize,
    pub eligible_bytes: u64,
    pub retention_days: u32,
    pub auto_clean: bool,
    pub last_clean_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalCleanupResultDto {
    pub deleted: usize,
    pub bytes: u64,
    pub empty_dirs_removed: usize,
    pub failed: Vec<String>,
}

fn last_activity(s: &SessionMetaDto) -> Option<DateTime<Utc>> {
    s.updated_at
        .as_deref()
        .or(s.created_at.as_deref())
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&Utc))
}

/// Mesa 自己产生的后台对话（不论新旧）
pub(crate) fn is_mesa_owned(s: &SessionMetaDto) -> bool {
    s.internal
        && (crate::usage::is_ccode_ai_temp_cwd(&s.project_path)
            || crate::usage::is_watch_worktree_cwd(&s.project_path))
}

/// 这一条到保留期可删吗：保留（pin）的、源文件已不在的（只剩快照）、时间不明的一律不删
pub(crate) fn is_eligible(s: &SessionMetaDto, cutoff: DateTime<Utc>) -> bool {
    is_mesa_owned(s) && !s.pinned && s.alive && last_activity(s).is_some_and(|t| t < cutoff)
}

fn file_bytes(s: &SessionMetaDto) -> u64 {
    if s.file_path.contains('#') {
        return 0; // OpenCode 共享库里的行，没有独立文件
    }
    fs::metadata(&s.file_path).map(|m| m.len()).unwrap_or(0)
}

fn settings() -> (bool, u32) {
    let st = crate::settings::read_current();
    (
        st.internal_auto_clean.unwrap_or(true),
        st.internal_retention_days.unwrap_or(DEFAULT_RETENTION_DAYS),
    )
}

pub(crate) fn stats_impl() -> InternalSessionsStatsDto {
    let (auto_clean, days) = settings();
    let cutoff = Utc::now() - Duration::days(i64::from(days));
    let mut out = InternalSessionsStatsDto {
        total: 0,
        total_bytes: 0,
        oldest: None,
        eligible: 0,
        eligible_bytes: 0,
        retention_days: days,
        auto_clean,
        last_clean_at: crate::usage::kv_get(LAST_CLEAN_KEY),
    };
    let mut oldest: Option<DateTime<Utc>> = None;
    for s in crate::sessions::list_sessions_sync() {
        if !is_mesa_owned(&s) {
            continue;
        }
        let bytes = file_bytes(&s);
        out.total += 1;
        out.total_bytes += bytes;
        if let Some(t) = last_activity(&s) {
            if oldest.is_none_or(|o| t < o) {
                oldest = Some(t);
            }
        }
        if is_eligible(&s, cutoff) {
            out.eligible += 1;
            out.eligible_bytes += bytes;
        }
    }
    out.oldest = oldest.map(|t| t.to_rfc3339());
    out
}

/// Claude Code 给每个临时 cwd 建一个 projects/<编码路径> 目录；对话文件删完（或不落盘调用
/// 只建了空的 memory/）后剩空壳。只认名字以 `ccode-ai-<uuid>` 结尾、里面没有任何 .jsonl、
/// 且一天内没动过的目录。
fn sweep_empty_claude_dirs(home: &Path) -> usize {
    let root = home.join(".claude").join("projects");
    let Ok(entries) = fs::read_dir(&root) else {
        return 0;
    };
    let day_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 3600);
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(idx) = name.rfind("ccode-ai-") else {
            continue;
        };
        if !crate::usage::is_ccode_ai_temp_cwd(&name[idx..]) || !path.is_dir() {
            continue;
        }
        let fresh = fs::metadata(&path)
            .and_then(|m| m.modified())
            .is_ok_and(|m| m > day_ago);
        if fresh || dir_has_jsonl(&path) {
            continue;
        }
        if fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn dir_has_jsonl(dir: &Path) -> bool {
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = fs::read_dir(&d) else {
            return true; // 读不了就当有，宁可不删
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p
                .file_name()
                .is_some_and(|n| n.to_string_lossy().contains(".jsonl"))
            {
                return true;
            }
        }
    }
    false
}

pub(crate) fn cleanup_impl() -> Result<InternalCleanupResultDto, String> {
    let (_, days) = settings();
    let cutoff = Utc::now() - Duration::days(i64::from(days));
    let targets: Vec<SessionMetaDto> = crate::sessions::list_sessions_sync()
        .into_iter()
        .filter(|s| is_eligible(s, cutoff))
        .collect();
    let chain_members = crate::sessions::cached_scan().chain_members;
    let mut out = InternalCleanupResultDto {
        deleted: 0,
        bytes: 0,
        empty_dirs_removed: 0,
        failed: Vec::new(),
    };
    let mut conn = crate::sessions::open_db()?;
    for s in &targets {
        let bytes = file_bytes(s);
        match crate::sessions::delete_session_files(
            &s.agent,
            &s.session_id,
            &s.file_path,
            &chain_members,
            true,
        ) {
            Ok(member_ids) => {
                // 整理数据与搜索索引跟着清；用量行刻意不动（历史账）
                let tx = conn
                    .transaction()
                    .map_err(|e| format!("开启事务失败: {e}"))?;
                for id in std::iter::once(&s.session_id).chain(member_ids.iter()) {
                    let _ = tx.execute(
                        "DELETE FROM session_meta WHERE agent=?1 AND session_id=?2",
                        params![s.agent, id],
                    );
                    crate::session_search::forget_in_tx(&tx, &s.agent, id);
                }
                tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
                out.deleted += 1;
                out.bytes += bytes;
            }
            Err(e) => out.failed.push(format!("{}（{e}）", s.session_id)),
        }
    }
    if let Some(home) = dirs::home_dir() {
        out.empty_dirs_removed = sweep_empty_claude_dirs(&home);
    }
    crate::sessions::invalidate_scan_cache();
    crate::usage::kv_set(LAST_CLEAN_KEY, &Utc::now().to_rfc3339());
    Ok(out)
}

#[tauri::command]
pub async fn internal_sessions_stats() -> Result<InternalSessionsStatsDto, String> {
    tauri::async_runtime::spawn_blocking(stats_impl)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cleanup_internal_sessions() -> Result<InternalCleanupResultDto, String> {
    tauri::async_runtime::spawn_blocking(cleanup_impl)
        .await
        .map_err(|e| e.to_string())?
}

/// 启动后台自动清理：开机两分钟后看一次，之后每 6 小时看一次；
/// 开关关着或距上次不到 20 小时就跳过。失败只记日志，不打扰用户。
pub(crate) fn spawn_auto_cleanup() {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(120));
        loop {
            let (auto, _) = settings();
            let due = crate::usage::kv_get(LAST_CLEAN_KEY)
                .and_then(|t| DateTime::parse_from_rfc3339(&t).ok())
                .is_none_or(|t| {
                    Utc::now() - t.with_timezone(&Utc) > Duration::hours(AUTO_INTERVAL_HOURS)
                });
            if auto && due {
                match cleanup_impl() {
                    Ok(r) if r.deleted > 0 || r.empty_dirs_removed > 0 => eprintln!(
                        "[internal-cleanup] 删除 {} 条内部对话（{} 字节），清理空目录 {} 个",
                        r.deleted, r.bytes, r.empty_dirs_removed
                    ),
                    Ok(_) => {}
                    Err(e) => eprintln!("[internal-cleanup] {e}"),
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(6 * 3600));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(path: &str, internal: bool, pinned: bool, updated: &str) -> SessionMetaDto {
        let mut s: SessionMetaDto = serde_json::from_value(serde_json::json!({
            "agent": "codex", "sessionId": "s", "projectPath": path, "cwd": null,
            "title": null, "createdAt": null, "updatedAt": updated, "filePath": "/nope",
            "tokenUsage": null, "cliVersion": null, "pinned": pinned, "archived": false,
            "customTitle": null, "tags": [], "alive": true, "chainCount": 1,
            "workspace": null, "stepName": null, "summary": null, "live": false,
            "source": "cli", "internal": internal, "handoffFromAgent": null,
            "handoffFromSession": null, "taskId": null, "taskName": null
        }))
        .unwrap();
        s.internal = internal;
        s
    }

    #[test]
    fn eligibility_only_old_unpinned_mesa_temp_sessions() {
        let cutoff = Utc::now() - Duration::days(30);
        let tmp = "/private/var/folders/x/T/ccode-ai-0042d812-65ce-4538-870b-a99fc9883feb";
        let old = "2020-01-01T00:00:00Z";
        let fresh = Utc::now().to_rfc3339();
        assert!(is_eligible(&session(tmp, true, false, old), cutoff));
        // 保留的、太新的、没标内部的、用户项目目录里的都不删
        assert!(!is_eligible(&session(tmp, true, true, old), cutoff));
        assert!(!is_eligible(&session(tmp, true, false, &fresh), cutoff));
        assert!(!is_eligible(&session(tmp, false, false, old), cutoff));
        assert!(!is_eligible(&session("/Users/me/project", true, false, old), cutoff));
        // 名字像但不是 ccode-ai-<uuid> 的目录也不算
        assert!(!is_eligible(&session("/tmp/ccode-ai-notauuid", true, false, old), cutoff));
    }

    // 改目录 mtime 靠 File::open(dir)：Windows 打不开目录句柄（Access denied）
    #[cfg(unix)]
    #[test]
    fn sweeps_only_empty_old_ccode_ai_claude_dirs() {
        let home = std::env::temp_dir().join(format!("ccode-sweep-{}", uuid::Uuid::new_v4()));
        let root = home.join(".claude").join("projects");
        let empty = root.join("-private-var-T-ccode-ai-0042d812-65ce-4538-870b-a99fc9883feb");
        let with_file = root.join("-private-var-T-ccode-ai-1142d812-65ce-4538-870b-a99fc9883feb");
        let user = root.join("-Users-me-project");
        for d in [&empty, &with_file, &user] {
            fs::create_dir_all(d.join("memory")).unwrap();
        }
        fs::write(with_file.join("a.jsonl"), "{}").unwrap();
        // 刚建的目录一天内不动
        assert_eq!(sweep_empty_claude_dirs(&home), 0);
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3 * 24 * 3600);
        for d in [&empty, &with_file, &user] {
            fs::File::open(d).unwrap().set_modified(old).unwrap();
        }
        assert_eq!(sweep_empty_claude_dirs(&home), 1);
        assert!(!empty.exists());
        assert!(with_file.exists() && user.exists());
        let _ = fs::remove_dir_all(&home);
    }
}
