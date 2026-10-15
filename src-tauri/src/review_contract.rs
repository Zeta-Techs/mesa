//! Review 契约：账本、版本 token 校验、派生可审。禁止在此实现 git / 文件拷贝 / merge。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::projects::{
    append_acceptance_log_at, project_id_at, read_acceptance_log_at, AcceptanceLogEntry,
};

pub const KIND_GOAL_ADOPT: &str = "goal_adopt";
pub const KIND_PIPELINE_MERGE: &str = "pipeline_merge";
pub const KIND_CODING_MERGE: &str = "coding_merge";
pub const KIND_WATCH_ADOPT: &str = "watch_adopt";

/// 合并闸门的台账豁免（2026-10-13 双台账拍板）：解析 porcelain 状态行，按路径分两档。
/// - **只豁免未跟踪（??）**：Mesa 审计/缓存与积累账。reading-list 只豁免 ?? 是防呆设计——
///   agent 若违规把积累账提交进工作区分支，合并后它变 tracked，后续写入产生 M 会拦合并并点名。
/// - **未跟踪与改动都豁免**：日常积累面（雷达台账 + 用户笔记 + 验收台账）。闸门只负责提前拦，
///   git merge 自身的脏文件保护仍会拒绝任何真覆盖——真同文件并发走 git 三向合并或明确报错。
pub fn is_untracked_ledger_file(status: &str) -> bool {
    let line = status.trim_end();
    if line.len() < 4 {
        return false;
    }
    let untracked = line.starts_with("??");
    // porcelain 路径可能带引号（非 ASCII）；重命名行是 "old -> new"，两侧都认
    fn strip(p: &str) -> &str {
        p.trim().trim_matches('"')
    }
    let sides: Vec<&str> = line[3..].split(" -> ").map(strip).collect();
    let hit = |f: fn(&str) -> bool| sides.iter().any(|p| f(p));
    if untracked {
        return hit(is_untracked_only_ledger) || hit(is_accumulation_ledger);
    }
    hit(is_accumulation_ledger)
}

/// 只豁免未跟踪态的 Mesa 台账（迁移完成前它们可能仍被跟踪；迁出后 ignore 双保险）。
fn is_untracked_only_ledger(path: &str) -> bool {
    matches!(
        path,
        ".ccode/watch-explains.json"
            | ".ccode/pending-registrations.json"
            | "papers/reading-list.md"
    )
}

/// 日常积累面：雷达台账、用户精读笔记、本机验收台账、雷达订阅——任何常规状态都不拦合并。
/// notes/index.json 是流程正典（.json），不在此列。
fn is_accumulation_ledger(path: &str) -> bool {
    matches!(
        path,
        "notes/inbox.md"
            | "papers/watch-seen.md"
            | "papers/watch-followup.md"
            | ".ccode/acceptance-log.jsonl"
            | ".ccode/acceptance-log.lock"
    ) || (path.starts_with("notes/") && path.ends_with(".md"))
        || path.starts_with(".ccode/watch/")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResultReadiness {
    None,
    Reviewable,
    Blocked,
    Applied,
    LedgerPending,
}

#[derive(Debug, Clone, Default)]
pub struct ReadinessInput {
    pub kind: String,
    pub has_snapshot: bool,
    pub has_adoptable: bool,
    pub protected_hit: bool,
    pub expect_seq_mismatch: bool,
    pub run_completed: bool,
    pub git_ahead: bool,
    pub salvage_candidates: bool,
    pub conflict: bool,
    pub apply_blocked: bool,
    pub is_ancestor: bool,
    pub ledger_has_fact: bool,
    pub pending_exists: bool,
    pub watch_completed: bool,
}

pub fn assert_seq(expect: u32, actual: u32) -> Result<(), String> {
    if expect != actual {
        return Err(format!(
            "你看过之后这版结果又更新了（第 {expect} 版 → 第 {actual} 版），请重新过一遍再采纳"
        ));
    }
    Ok(())
}

/// Git：合并**前**比对功能分支 / 工作树 tip。禁止拿合并后 HEAD 来比。
pub fn assert_reviewed_sha(expect: &str, current_tip: &str) -> Result<(), String> {
    let expect = expect.trim();
    let current = current_tip.trim();
    if expect.is_empty() {
        return Err("请先打开评审再合并".into());
    }
    if expect != current {
        return Err("你看过之后工作区又有新提交，请重新过一遍改动再合并（尚未合并进主仓）".into());
    }
    Ok(())
}

/// 四条写回链共用的项目锁；文件阶段与接受事实不能被另一条链插入。
pub fn apply_lock(root: &Path) -> Result<fs::File, String> {
    let locks = pending_dir()?.join("apply-locks");
    fs::create_dir_all(&locks).map_err(|e| format!("创建项目验收锁失败：{e}"))?;
    let key = crate::paths::path_key(&crate::projects::canonical_key(root));
    crate::storage::lock_at(&locks.join(format!("{:x}.lock", md5::compute(key.as_bytes()))))
        .map_err(|e| format!("项目正在验收或无法加锁，请稍后重试：{e}"))
}

pub fn commit_fact(root: &Path, entry: &AcceptanceLogEntry) -> Result<(), String> {
    let dir = root.join(".ccode");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 .ccode 目录失败: {e}"))?;
    let lock_path = dir.join("acceptance-log.lock");
    let _lock = crate::storage::lock_at(&lock_path)?;
    append_acceptance_log_at(root, entry)
}

pub fn fact_from_goal_adopt(
    root: &Path,
    goal_id: &str,
    goal_name: &str,
    run_id: &str,
    seq: Option<u32>,
    paths: Vec<String>,
    note: String,
    frozen: bool,
    decided_at: String,
) -> AcceptanceLogEntry {
    let version_id = match seq {
        Some(seq) => format!("{run_id}:{seq}"),
        None => run_id.to_string(),
    };
    AcceptanceLogEntry {
        goal_id: goal_id.to_string(),
        goal_name: goal_name.to_string(),
        run_id: run_id.to_string(),
        paths,
        note,
        frozen,
        decided_at,
        kind: KIND_GOAL_ADOPT.into(),
        version_id,
        reviewed_sha: None,
        project_id: project_id_at(root),
        scene_ref: None,
        content_fingerprints: Vec::new(),
    }
}

pub fn pending_dir() -> Result<PathBuf, String> {
    #[cfg(test)]
    let dir = std::env::temp_dir().join(format!("ccode-pending-tests-{}", std::process::id()));
    #[cfg(not(test))]
    let dir = dirs::config_dir()
        .ok_or("无法确定配置目录")?
        .join("ccode")
        .join("pending-admission");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 pending-admission 失败: {e}"))?;
    Ok(dir)
}

pub fn pending_path(scene_key: &str) -> Result<PathBuf, String> {
    let name = crate::paths::sanitize_fs_name(scene_key).unwrap_or_else(|_| "pending".into());
    Ok(pending_dir()?.join(format!("{name}.json")))
}

pub fn write_pending(scene_key: &str, entry: &AcceptanceLogEntry) -> Result<(), String> {
    let path = pending_path(scene_key)?;
    let text = serde_json::to_string_pretty(entry).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(&path, &text)
}

pub fn read_pending(scene_key: &str) -> Result<Option<AcceptanceLogEntry>, String> {
    let path = pending_path(scene_key)?;
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("验收恢复记录损坏，未重新合并：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取验收恢复记录失败：{e}")),
    }
}

/// 缺失是无待办；损坏/不可读也必须露出入口，点击时再给出具体错误。
pub fn pending_needs_attention(scene_key: &str) -> bool {
    !matches!(read_pending(scene_key), Ok(None))
}

pub fn clear_pending(scene_key: &str) -> Result<(), String> {
    match fs::remove_file(pending_path(scene_key)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("清理验收恢复记录失败：{e}")),
    }
}

pub fn record_pending_fact(
    root: &Path,
    scene_key: &str,
    entry: &AcceptanceLogEntry,
) -> Result<(), String> {
    write_pending(scene_key, entry)?;
    commit_fact(root, entry)?;
    clear_pending(scene_key)
}

/// 补账只重放原事实；没有凭证时拒绝用当前 HEAD / 最新 diff 编造历史。
pub fn recover_fact(
    root: &Path,
    scene_key: &str,
    kind: &str,
    scene_ref: &str,
    reviewed_sha: &str,
) -> Result<AcceptanceLogEntry, String> {
    let entry = match read_pending(scene_key)? {
        Some(entry) => entry,
        None => read_acceptance_log_at(root)
            .into_iter()
            .rev()
            .find(|entry| {
                entry.kind == kind
                    && entry.scene_ref.as_deref() == Some(scene_ref)
                    && entry.reviewed_sha.as_deref() == Some(reviewed_sha)
            })
            .ok_or(
                "文件已在基准中，但没有可核对的验收凭证；请检查历史，不会按当前 HEAD 猜测补记",
            )?,
    };
    if entry.kind != kind
        || entry.scene_ref.as_deref() != Some(scene_ref)
        || entry.version_id.is_empty()
    {
        return Err("验收恢复记录与本次工作不匹配，未重新合并".into());
    }
    if let (Some(expected), Some(actual)) = (&entry.project_id, project_id_at(root)) {
        if *expected != actual {
            return Err("验收恢复记录属于另一个项目".into());
        }
    }
    Ok(entry)
}

/// 派生可审。不写库、不改 runs.status。
pub fn result_readiness(input: &ReadinessInput) -> ResultReadiness {
    if input.ledger_has_fact {
        return ResultReadiness::Applied;
    }
    match input.kind.as_str() {
        KIND_GOAL_ADOPT => {
            if input.pending_exists {
                return ResultReadiness::LedgerPending;
            }
            if !input.has_snapshot && !input.has_adoptable {
                return ResultReadiness::None;
            }
            if input.protected_hit
                || input.expect_seq_mismatch
                || (!input.has_snapshot && !input.run_completed)
            {
                return ResultReadiness::Blocked;
            }
            if input.has_adoptable {
                ResultReadiness::Reviewable
            } else {
                ResultReadiness::None
            }
        }
        KIND_WATCH_ADOPT => {
            if input.pending_exists {
                return ResultReadiness::LedgerPending;
            }
            if !input.has_snapshot {
                return ResultReadiness::None;
            }
            if !input.watch_completed {
                return ResultReadiness::Blocked;
            }
            if input.has_adoptable {
                ResultReadiness::Reviewable
            } else {
                ResultReadiness::None
            }
        }
        KIND_PIPELINE_MERGE | KIND_CODING_MERGE => {
            if input.is_ancestor || input.pending_exists {
                return ResultReadiness::LedgerPending;
            }
            if !input.git_ahead && !input.salvage_candidates {
                return ResultReadiness::None;
            }
            if input.conflict || input.apply_blocked {
                return ResultReadiness::Blocked;
            }
            ResultReadiness::Reviewable
        }
        _ => ResultReadiness::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_fact_replays_original_version_and_rejects_corruption() {
        let root = std::env::temp_dir().join(format!("ccode-admission-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let key = uuid::Uuid::new_v4().to_string();
        let fact = AcceptanceLogEntry {
            kind: KIND_PIPELINE_MERGE.into(),
            version_id: "original-merge".into(),
            reviewed_sha: Some("reviewed-tip".into()),
            scene_ref: Some("workspace".into()),
            paths: vec!["report.md".into()],
            decided_at: "original-time".into(),
            ..Default::default()
        };
        write_pending(&key, &fact).unwrap();
        let recovered = recover_fact(
            &root,
            &key,
            KIND_PIPELINE_MERGE,
            "workspace",
            "new-unreviewed-tip",
        )
        .unwrap();
        assert_eq!(recovered.version_id, "original-merge");
        assert_eq!(recovered.decided_at, "original-time");
        record_pending_fact(&root, &key, &recovered).unwrap();
        assert!(read_pending(&key).unwrap().is_none());
        assert_eq!(
            recover_fact(
                &root,
                &key,
                KIND_PIPELINE_MERGE,
                "workspace",
                "reviewed-tip"
            )
            .unwrap()
            .paths,
            fact.paths
        );
        assert!(
            recover_fact(&root, &key, KIND_PIPELINE_MERGE, "workspace", "unknown-tip").is_err()
        );
        fs::write(pending_path(&key).unwrap(), "broken JSON").unwrap();
        assert!(read_pending(&key).unwrap_err().contains("损坏"));
        clear_pending(&key).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_untracked_ledger_files_are_nonblocking() {
        assert!(is_untracked_ledger_file("?? .ccode/acceptance-log.jsonl"));
        assert!(is_untracked_ledger_file("?? .ccode/acceptance-log.lock"));
        // 验收台账已跟踪态也豁免：合并写台账不应拦住下一次合并
        assert!(is_untracked_ledger_file(" M .ccode/acceptance-log.jsonl"));
        assert!(is_untracked_ledger_file("M  .ccode/acceptance-log.lock"));
        // 积累面：雷达台账与用户笔记，?? 与 M 双态豁免
        assert!(is_untracked_ledger_file("?? notes/inbox.md"));
        assert!(is_untracked_ledger_file(" M papers/watch-seen.md"));
        assert!(is_untracked_ledger_file(" M papers/watch-followup.md"));
        assert!(is_untracked_ledger_file("?? notes/my-note.md"));
        assert!(is_untracked_ledger_file(" M notes/slug/我的笔记.md"));
        assert!(is_untracked_ledger_file("?? papers/reading-list.md"));
        // 雷达订阅目录（.ccode/watch/<任务id>/watchlist.md）同属积累面
        assert!(is_untracked_ledger_file("?? .ccode/watch/s1/watchlist.md"));
        assert!(is_untracked_ledger_file(" M .ccode/watch/s1/watchlist.md"));
        assert!(is_untracked_ledger_file("?? .ccode/watch-explains.json"));
        assert!(is_untracked_ledger_file("?? .ccode/pending-registrations.json"));
        // 积累账只豁免 ??：agent 违规提交后变 tracked，M 态要拦并点名（防呆）
        assert!(!is_untracked_ledger_file(" M papers/reading-list.md"));
        assert!(!is_untracked_ledger_file(" M .ccode/watch-explains.json"));
        // 流程正典与其它文件照常保护
        assert!(!is_untracked_ledger_file(" M notes/index.json"));
        assert!(!is_untracked_ledger_file("?? .ccode/memory.md"));
        assert!(!is_untracked_ledger_file("?? .ccode/project.toml"));
        assert!(!is_untracked_ledger_file(" M papers/included.md"));
        assert!(!is_untracked_ledger_file(" M manuscript/main.md"));
        // 重命名行两侧都认；引号路径剥壳；近邻路径不误豁免
        assert!(is_untracked_ledger_file("R  notes/old.md -> notes/new.md"));
        assert!(is_untracked_ledger_file("?? \"notes/带空格 的笔记.md\""));
        assert!(!is_untracked_ledger_file("?? notes/inbox.md.bak"));
        assert!(!is_untracked_ledger_file("?? papers/watch-seen-report.md"));
        assert!(!is_untracked_ledger_file("?? sub/notes/inbox.md"));
    }

    #[test]
    fn assert_reviewed_sha_refuses_drift_and_empty() {
        assert!(assert_reviewed_sha("abc", "abc").is_ok());
        assert!(assert_reviewed_sha("abc", "def")
            .unwrap_err()
            .contains("尚未合并"));
        assert!(assert_reviewed_sha("", "abc").is_err());
    }

    #[test]
    fn assert_seq_matches_goal_expect() {
        assert!(assert_seq(2, 2).is_ok());
        assert!(assert_seq(1, 2).unwrap_err().contains("第 1 版"));
    }

    #[test]
    fn readiness_git_ahead_is_reviewable_even_if_main_dirty() {
        let input = ReadinessInput {
            kind: KIND_PIPELINE_MERGE.into(),
            git_ahead: true,
            apply_blocked: false,
            conflict: false,
            is_ancestor: false,
            ledger_has_fact: false,
            ..Default::default()
        };
        assert_eq!(result_readiness(&input), ResultReadiness::Reviewable);
        let pending = ReadinessInput {
            kind: KIND_PIPELINE_MERGE.into(),
            is_ancestor: true,
            ledger_has_fact: false,
            git_ahead: false,
            ..Default::default()
        };
        assert_eq!(result_readiness(&pending), ResultReadiness::LedgerPending);
        let applied = ReadinessInput {
            kind: KIND_PIPELINE_MERGE.into(),
            ledger_has_fact: true,
            is_ancestor: true,
            ..Default::default()
        };
        assert_eq!(result_readiness(&applied), ResultReadiness::Applied);
    }

    #[test]
    fn readiness_watch_failed_run_is_blocked() {
        let input = ReadinessInput {
            kind: KIND_WATCH_ADOPT.into(),
            has_snapshot: true,
            has_adoptable: true,
            watch_completed: false,
            ..Default::default()
        };
        assert_eq!(result_readiness(&input), ResultReadiness::Blocked);
    }

    #[test]
    fn readiness_goal_applied_wins() {
        let input = ReadinessInput {
            kind: KIND_GOAL_ADOPT.into(),
            ledger_has_fact: true,
            has_adoptable: true,
            ..Default::default()
        };
        assert_eq!(result_readiness(&input), ResultReadiness::Applied);
    }
}
