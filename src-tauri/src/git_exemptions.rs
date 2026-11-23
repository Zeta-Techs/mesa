//! Mesa 不进 git 的过程文件与台账路径单一真源（2026-11-21 根因收口）。
//!
//! 前后端共用同一份 `src/mesa-git-exemptions.json`：
//! - 后端编译期 `include_str!` 读入，供 `git_info`、`workspaces`、`review_contract`、`projects` 共用；
//! - 前端 `src/git-status-groups.ts` 直接 `import` 同一份 JSON；
//! - 新过程文件一律落在 `.ccode/local/` 下，以后新增功能无需再逐处补豁免名单；
//! - `sync_git_exclude` 批量写入 `<git_common_dir>/info/exclude`，主仓与所有已有 worktree 立即生效且不脏 `.gitignore`。

use serde::Deserialize;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

const EXEMPTIONS_JSON: &str = include_str!("../../src/mesa-git-exemptions.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Exemptions {
    workspace_transient_files: Vec<String>,
    workspace_transient_dirs: Vec<String>,
    ledger_any_state_files: Vec<String>,
    ledger_any_state_dirs: Vec<String>,
    ledger_untracked_only_files: Vec<String>,
    git_exclude_lines: Vec<String>,
}

fn table() -> &'static Exemptions {
    static TABLE: OnceLock<Exemptions> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str(EXEMPTIONS_JSON)
            .expect("src/mesa-git-exemptions.json must be valid JSON")
    })
}

fn normalize_rel(path: &str) -> String {
    path.trim()
        .trim_matches('"')
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_string()
}

/// 工作区过程文件：只留在工作区、永不进 git 提交、不触发「有未提交改动」拦截。
/// 含 `.ccode/review-notes.md`、`.ccode/next-actions.json`、`.ccode/step-next/`、`.ccode/local/`。
pub(crate) fn is_workspace_transient(path: &str) -> bool {
    let p = normalize_rel(path);
    if p.is_empty() {
        return false;
    }
    let t = table();
    if t.workspace_transient_files.iter().any(|f| f == &p) {
        return true;
    }
    if t.workspace_transient_dirs
        .iter()
        .any(|dir| p.starts_with(dir.as_str()) || p == dir.trim_end_matches('/'))
    {
        return true;
    }
    // 兼容按文件名匹配 review-notes.md（老逻辑保留）
    p.rsplit('/').next() == Some("review-notes.md")
}

/// 任何常规 git 状态都不拦合并/不标脏的积累面台账（含全部工作区过程文件 + `notes/*.md`）。
pub(crate) fn is_accumulation_ledger(path: &str) -> bool {
    let p = normalize_rel(path);
    if p.is_empty() {
        return false;
    }
    if is_workspace_transient(&p) {
        return true;
    }
    let t = table();
    if t.ledger_any_state_files.iter().any(|f| f == &p) {
        return true;
    }
    if t.ledger_any_state_dirs.iter().any(|dir| p.starts_with(dir.as_str())) {
        return true;
    }
    p.starts_with("notes/") && p.ends_with(".md")
}

/// 只豁免未跟踪态（`??`）的台账：若被违规提交后变成 tracked 修改（`M`）仍会显形。
pub(crate) fn is_untracked_only_ledger(path: &str) -> bool {
    let p = normalize_rel(path);
    if p.is_empty() {
        return false;
    }
    table().ledger_untracked_only_files.iter().any(|f| f == &p)
}

/// 供 `projects::commit_bootstrap_at` 使用的 `.ccode/` 排除路径清单（单一真源派生，
/// 彻底消灭手抄 BOOTSTRAP_EXCLUDES，避免开步/评审前误把过程文件提交成 tracked）。
pub(crate) fn bootstrap_exclude_paths() -> Vec<String> {
    let t = table();
    let mut out = Vec::new();
    let mut push = |raw: &str| {
        let p = raw.trim().trim_start_matches('/').trim_end_matches('/');
        if p.starts_with(".ccode/") && !p.contains('*') && !out.iter().any(|x| x == p) {
            out.push(p.to_string());
        }
    };
    for p in &t.workspace_transient_files {
        push(p);
    }
    for p in &t.workspace_transient_dirs {
        push(p);
    }
    for p in &t.ledger_any_state_files {
        push(p);
    }
    for p in &t.ledger_any_state_dirs {
        push(p);
    }
    for p in &t.ledger_untracked_only_files {
        push(p);
    }
    for p in &t.git_exclude_lines {
        push(p);
    }
    out
}

/// 解除老项目里已被历史提交跟踪的 Mesa 过程文件（如 `.ccode/review-notes.md`、`next-actions.json`、`.ccode/local/*`）：
/// 只做 `git rm --cached` 移出版本跟踪，本地磁盘文件原样保留。best-effort，非 git 仓静默返回空。
pub(crate) fn untrack_committed_transients(repo: &Path) -> Vec<String> {
    let Ok(listed) = crate::workspaces::run_git(
        repo,
        &["ls-files", "--", ".ccode"],
        std::time::Duration::from_secs(30),
    ) else {
        return Vec::new();
    };
    let tracked: Vec<String> = listed
        .lines()
        .map(|l| l.trim().trim_matches('"').to_string())
        .filter(|p| is_workspace_transient(p))
        .collect();
    if tracked.is_empty() {
        return Vec::new();
    }
    let mut args: Vec<&str> = vec!["rm", "--cached", "-q", "--"];
    args.extend(tracked.iter().map(String::as_str));
    if crate::workspaces::run_git(repo, &args, std::time::Duration::from_secs(30)).is_ok() {
        tracked
    } else {
        Vec::new()
    }
}

/// 把所有 Mesa 过程文件/本机台账规则一次原子同步到 `<git_common_dir>/info/exclude`：
/// 主仓与所有已有工作副本立即生效、不污染分支的 `.gitignore`。best-effort，不阻断主流程。
pub(crate) fn sync_git_exclude(worktree_root: &Path) {
    let Ok(common) = crate::workspaces::run_git(
        worktree_root,
        &["rev-parse", "--git-common-dir"],
        std::time::Duration::from_secs(30),
    ) else {
        return;
    };
    let common = common.trim();
    if common.is_empty() {
        return;
    }
    let dir = Path::new(common);
    let dir = if dir.is_absolute() {
        dir.to_path_buf()
    } else {
        worktree_root.join(dir)
    };
    let exclude = dir.join("info").join("exclude");
    let existing = fs::read_to_string(&exclude).unwrap_or_default();
    let have: std::collections::HashSet<&str> = existing.lines().map(str::trim).collect();
    let missing: Vec<&str> = table()
        .git_exclude_lines
        .iter()
        .map(String::as_str)
        .filter(|line| !have.contains(*line))
        .collect();
    if missing.is_empty() {
        return;
    }
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    for line in missing {
        content.push_str(line);
        content.push('\n');
    }
    if let Some(parent) = exclude.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = crate::profiles::atomic_write(&exclude, &content);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_paths_cover_local_dir_and_legacy_files() {
        assert!(is_workspace_transient(".ccode/review-notes.md"));
        assert!(is_workspace_transient(".ccode/next-actions.json"));
        assert!(is_workspace_transient(".ccode/step-next/lit-notes.json"));
        assert!(is_workspace_transient(".ccode/local/anything.json"));
        assert!(is_workspace_transient(".ccode/local/nested/state.md"));
        assert!(!is_workspace_transient(".ccode/project.toml"));
        assert!(!is_workspace_transient("papers/included.md"));
    }

    #[test]
    fn sync_git_exclude_is_idempotent_and_applies_to_worktrees() {
        let dir = std::env::temp_dir().join(format!("ccode-exclude-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let init = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap();
        assert!(init.success());
        sync_git_exclude(&dir);
        let first = fs::read_to_string(dir.join(".git/info/exclude")).unwrap();
        assert!(first.lines().any(|l| l.trim() == "/.ccode/local/"));
        assert!(first.lines().any(|l| l.trim() == "/.ccode/next-actions.json"));
        assert!(first.lines().any(|l| l.trim() == "/.ccode/step-next/"));
        // 幂等：二次调用不重复追加
        sync_git_exclude(&dir);
        let second = fs::read_to_string(dir.join(".git/info/exclude")).unwrap();
        assert_eq!(first, second);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bootstrap_excludes_and_untrack_committed_transients() {
        let excludes = bootstrap_exclude_paths();
        assert!(excludes.iter().any(|p| p == ".ccode/next-actions.json"));
        assert!(excludes.iter().any(|p| p == ".ccode/step-next"));
        assert!(excludes.iter().any(|p| p == ".ccode/local"));
        assert!(excludes.iter().any(|p| p == ".ccode/review-notes.md"));
        assert!(excludes.iter().any(|p| p == ".ccode/versions"));

        let dir = std::env::temp_dir().join(format!("ccode-untrack-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join(".ccode")).unwrap();
        let git = |args: &[&str]| {
            let st = std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .status()
                .unwrap();
            assert!(st.success(), "git {:?} failed", args);
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "Test"]);
        git(&["config", "user.email", "test@example.com"]);
        fs::write(dir.join(".ccode/review-notes.md"), "old tracked note\n").unwrap();
        fs::write(dir.join(".ccode/project.toml"), "work_mode = \"research\"\n").unwrap();
        git(&["add", "-f", ".ccode/review-notes.md", ".ccode/project.toml"]);
        git(&["-c", "commit.gpgsign=false", "commit", "-q", "-m", "legacy"]);

        let removed = untrack_committed_transients(&dir);
        assert_eq!(removed, vec![".ccode/review-notes.md".to_string()]);
        // 本地磁盘文件原样保留，仅移出索引
        assert!(dir.join(".ccode/review-notes.md").is_file());
        // project.toml 仍被跟踪
        let tracked = crate::workspaces::run_git(&dir, &["ls-files", "--", ".ccode"], std::time::Duration::from_secs(10)).unwrap();
        assert!(tracked.lines().any(|l| l.trim() == ".ccode/project.toml"));
        assert!(!tracked.lines().any(|l| l.trim() == ".ccode/review-notes.md"));
        let _ = fs::remove_dir_all(&dir);
    }
}
