//! 本机使用计数（2026-11-02 拍板）：只记几项次数，不记任何内容；只在用户于反馈弹层勾选
//! 「附带使用计数」时随反馈发出，默认不发。用来在没有遥测的前提下判断核验 / 记录是否真被用上。
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalStats {
    /// 第一次计数的日期（YYYY-MM-DD）
    #[serde(default)]
    pub since: String,
    /// 写进研究记录的运行次数
    #[serde(default)]
    pub runs_recorded: u64,
    /// 保存进项目 / 采纳的次数（验收账本新增一条记一次）
    #[serde(default)]
    pub accepted: u64,
    #[serde(default)]
    pub checks_passed: u64,
    #[serde(default)]
    pub checks_blocked: u64,
    #[serde(default)]
    pub checks_needs_human: u64,
    /// 研究记录导出次数（AI 使用声明、复现包、过程报告）
    #[serde(default)]
    pub exports: u64,
}

fn stats_path() -> Option<PathBuf> {
    // 测试不碰真实配置目录；纯逻辑另测 bump_at
    if cfg!(test) {
        return None;
    }
    crate::storage::config_root().map(|dir| dir.join("local-stats.json"))
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn read_at(path: &Path) -> LocalStats {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn bump_at(path: &Path, change: impl FnOnce(&mut LocalStats)) -> Result<(), String> {
    let mut stats = read_at(path);
    if stats.since.is_empty() {
        stats.since = today();
    }
    change(&mut stats);
    let text = serde_json::to_string_pretty(&stats).map_err(|e| e.to_string())?;
    crate::storage::atomic_write(path, text.as_bytes(), true)
}

/// best-effort：计数失败不影响任何业务
fn bump(change: impl FnOnce(&mut LocalStats)) {
    let Some(path) = stats_path() else {
        return;
    };
    let Ok(_lock) = crate::storage::config_lock("local-stats") else {
        return;
    };
    let _ = bump_at(&path, change);
}

fn apply_record_run(s: &mut LocalStats, checks: Option<crate::research_record::CheckCounts>) {
    s.runs_recorded += 1;
    if let Some(c) = checks {
        s.checks_passed += c.passed as u64;
        s.checks_blocked += c.blocked as u64;
        s.checks_needs_human += c.needs_human as u64;
    }
}

fn apply_replace_run_checks(
    s: &mut LocalStats,
    old: Option<crate::research_record::CheckCounts>,
    next: Option<crate::research_record::CheckCounts>,
) {
    let o = old.unwrap_or_default();
    let n = next.unwrap_or_default();
    s.checks_passed = s.checks_passed.saturating_sub(o.passed as u64) + n.passed as u64;
    s.checks_blocked = s.checks_blocked.saturating_sub(o.blocked as u64) + n.blocked as u64;
    s.checks_needs_human =
        s.checks_needs_human.saturating_sub(o.needs_human as u64) + n.needs_human as u64;
}

pub(crate) fn record_run(checks: Option<crate::research_record::CheckCounts>) {
    bump(|s| apply_record_run(s, checks));
}

/// 同一 Run 被接回后再次收尾：运行总次数不重复加，核验三档按新旧差值原地替换
pub(crate) fn replace_run_checks(
    old: Option<crate::research_record::CheckCounts>,
    next: Option<crate::research_record::CheckCounts>,
) {
    if old == next {
        return;
    }
    bump(|s| apply_replace_run_checks(s, old, next));
}

pub(crate) fn record_accept() {
    bump(|s| s.accepted += 1);
}

pub(crate) fn record_export() {
    bump(|s| s.exports += 1);
}

#[tauri::command]
pub async fn local_stats_read() -> Result<LocalStats, String> {
    Ok(stats_path().map(|p| read_at(&p)).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bump_starts_dating_and_accumulates() {
        let dir = std::env::temp_dir().join(format!("ccode-stats-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("local-stats.json");
        bump_at(&path, |s| s.runs_recorded += 1).unwrap();
        bump_at(&path, |s| {
            s.runs_recorded += 1;
            s.checks_blocked += 2;
        })
        .unwrap();
        let stats = read_at(&path);
        assert_eq!(stats.runs_recorded, 2);
        assert_eq!(stats.checks_blocked, 2);
        assert_eq!(stats.since.len(), 10);
    }

    #[test]
    fn unreadable_file_counts_from_zero() {
        let dir = std::env::temp_dir().join(format!("ccode-stats-bad-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("local-stats.json");
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(read_at(&path), LocalStats::default());
    }

    #[test]
    fn replace_run_checks_updates_delta_without_double_counting_runs() {
        let dir = std::env::temp_dir().join(format!("ccode-stats-replace-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("local-stats.json");
        bump_at(&path, |s| {
            apply_record_run(
                s,
                Some(crate::research_record::CheckCounts { passed: 1, blocked: 2, needs_human: 0 }),
            )
        })
        .unwrap();
        bump_at(&path, |s| {
            apply_replace_run_checks(
                s,
                Some(crate::research_record::CheckCounts { passed: 1, blocked: 2, needs_human: 0 }),
                Some(crate::research_record::CheckCounts { passed: 4, blocked: 0, needs_human: 1 }),
            )
        })
        .unwrap();
        let got = read_at(&path);
        assert_eq!(got.runs_recorded, 1);
        assert_eq!((got.checks_passed, got.checks_blocked, got.checks_needs_human), (4, 0, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
