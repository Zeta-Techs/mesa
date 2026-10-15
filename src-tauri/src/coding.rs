//! 编程项目：git 原语工作树 / 分支台（不走科研工作区库）。
//! 新工作树落 `~/ccode/worktrees/<仓库名>/<分支路径>`；`git worktree list` 是事实来源。

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const T: Duration = Duration::from_secs(20);
const T_LONG: Duration = Duration::from_secs(60);

fn expand(path: &str) -> PathBuf {
    PathBuf::from(crate::sessions::expand_tilde(path))
}

pub(crate) fn worktrees_root() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(p) = TEST_WT_ROOT.with(|c| c.borrow().clone()) {
        return Ok(p);
    }
    Ok(dirs::home_dir()
        .ok_or("无法确定用户主目录")?
        .join("ccode")
        .join("worktrees"))
}

#[cfg(test)]
thread_local! {
    static TEST_WT_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    crate::workspaces::run_git(repo, args, T)
}

fn git_long(repo: &Path, args: &[&str]) -> Result<String, String> {
    crate::workspaces::run_git(repo, args, T_LONG)
}

fn merging_at(path: &Path) -> bool {
    git(path, &["rev-parse", "--verify", "-q", "MERGE_HEAD"]).is_ok()
}

pub(crate) fn is_git_repo(path: &Path) -> bool {
    git(path, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

fn repo_name(repo: &Path) -> String {
    repo.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into())
}

/// 分支名 → 工作树相对路径：按 `/` 分段，每段走 sanitize_fs_name。
fn branch_dir_rel(branch: &str) -> Result<PathBuf, String> {
    let b = branch.trim().trim_start_matches("refs/heads/");
    if b.is_empty() {
        return Err("分支名不能为空".into());
    }
    let mut out = PathBuf::new();
    for part in b.split(['/', '\\']) {
        if part.is_empty() {
            continue;
        }
        out.push(crate::paths::sanitize_fs_name(part)?);
    }
    if out.as_os_str().is_empty() {
        return Err("分支名清洗后为空".into());
    }
    Ok(out)
}

fn default_worktree_path(repo: &Path, branch: &str) -> Result<PathBuf, String> {
    Ok(worktrees_root()?
        .join(repo_name(repo))
        .join(branch_dir_rel(branch)?))
}

fn strip_heads(name: &str) -> String {
    name.trim().trim_start_matches("refs/heads/").to_string()
}

struct ParsedRemote {
    owner_repo: String,
    display: String,
    host_kind: String,
    /// 仅测试断言读取：URL 是否带用户信息段（生产展示用 url_stripped）
    #[cfg_attr(not(test), allow(dead_code))]
    has_userinfo: bool,
    url_stripped: String,
}

fn git_host_kind(host: &str) -> String {
    let h = host.to_ascii_lowercase();
    if h == "github.com" || h == "ssh.github.com" {
        "github".into()
    } else {
        "other".into()
    }
}

fn host_ok(host: &str) -> bool {
    if host.is_empty() || host.starts_with('-') || host.contains('@') {
        return false;
    }
    let ipv4 = host.split('.').all(|p| p.parse::<u8>().is_ok()) && host.matches('.').count() == 3;
    if ipv4 {
        return true;
    }
    host.split('.').all(|lab| {
        let b = lab.as_bytes();
        !b.is_empty()
            && b.len() <= 63
            && b[0].is_ascii_alphanumeric()
            && b[b.len() - 1].is_ascii_alphanumeric()
            && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
    })
}

fn normalize_repo_path(path: &str) -> Option<String> {
    let mut p = path
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_string();
    if p.to_ascii_lowercase().ends_with(".git") {
        p.truncate(p.len() - 4);
    }
    if p.is_empty() {
        return None;
    }
    let segs: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() < 2 {
        return None;
    }
    if segs
        .iter()
        .any(|s| *s == "." || *s == ".." || s.contains('\\'))
    {
        return None;
    }
    Some(segs.join("/"))
}

fn forbidden_raw(raw: &str) -> bool {
    raw.is_empty()
        || raw.starts_with('-')
        || raw.contains("..")
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// 与 src/coding-git.ts parseGitRemoteUrl 双端镜像。
fn parse_git_remote_url(raw: &str) -> Option<ParsedRemote> {
    let input = raw.trim();
    if forbidden_raw(input) {
        return None;
    }
    if !input.contains("://") {
        if let Some((userhost, path)) = input.split_once(':') {
            if let Some((user, host)) = userhost.split_once('@') {
                if user.starts_with('-') || !host_ok(host) {
                    return None;
                }
                let owner_repo = normalize_repo_path(path)?;
                let host_kind = git_host_kind(host);
                return Some(ParsedRemote {
                    display: format!("{host}/{owner_repo}"),
                    host_kind: host_kind.into(),
                    has_userinfo: false,
                    url_stripped: format!("{user}@{host}:{owner_repo}.git"),
                    owner_repo,
                });
            }
        }
    }
    let (scheme, rest) = input.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "ssh" {
        return None;
    }
    let (auth_host, path) = rest.split_once('/')?;
    let (userinfo, hostport) = if let Some((u, h)) = auth_host.split_once('@') {
        (Some(u), h)
    } else {
        (None, auth_host)
    };
    let host = hostport.split_once(':').map(|(h, _)| h).unwrap_or(hostport);
    if !host_ok(host) {
        return None;
    }
    let owner_repo = normalize_repo_path(path)?;
    let has_userinfo = userinfo.is_some();
    let host_kind = git_host_kind(host);
    let url_stripped = if scheme == "ssh" {
        match userinfo.and_then(|u| {
            u.split_once(':')
                .map(|(n, _)| n)
                .or(Some(userinfo.unwrap()))
        }) {
            Some(user) if !user.is_empty() => format!("ssh://{user}@{host}/{owner_repo}.git"),
            _ => format!("ssh://{host}/{owner_repo}.git"),
        }
    } else {
        format!("https://{host}/{owner_repo}.git")
    };
    Some(ParsedRemote {
        display: format!("{host}/{owner_repo}"),
        host_kind: host_kind.into(),
        has_userinfo,
        url_stripped,
        owner_repo,
    })
}

fn encode_ref(r: &str) -> String {
    r.split('/')
        .map(|p| {
            let mut out = String::new();
            for b in p.bytes() {
                match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                        out.push(b as char)
                    }
                    _ => out.push_str(&format!("%{b:02X}")),
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn github_compare_url(owner_repo: &str, base: &str, head: &str) -> String {
    format!(
        "https://github.com/{owner_repo}/compare/{}...{}",
        encode_ref(base),
        encode_ref(head)
    )
}

fn origin_dto(repo: &Path) -> Option<CodingRemoteDto> {
    let raw = git(repo, &["remote", "get-url", "origin"]).ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed = parse_git_remote_url(raw)?;
    Some(CodingRemoteDto {
        name: "origin".into(),
        url: parsed.url_stripped,
        display: parsed.display,
        host_kind: parsed.host_kind,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingWorktreeDto {
    pub path: String,
    pub branch: String,
    pub is_primary: bool,
    pub is_base: bool,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub unpushed: u32,
    pub has_upstream: bool,
    pub detached: bool,
    /// ISO 时间；空仓或读失败为 None
    pub last_commit_at: Option<String>,
    pub dirty_count: u32,
    pub upstream_behind: u32,
    /// worktree HEAD；打开改动时前端冻结，合并时作 expect_reviewed_sha
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    pub ledger_pending: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingBranchDto {
    pub name: String,
    pub worktree_path: Option<String>,
    pub is_primary: bool,
    pub is_base: bool,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub unpushed: u32,
    pub has_upstream: bool,
    pub upstream_behind: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingRemoteDto {
    pub name: String,
    pub url: String,
    pub display: String,
    pub host_kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingRemoteBranchDto {
    pub remote: String,
    pub name: String,
    pub has_local: bool,
    pub occupied_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingOverviewDto {
    pub repo_path: String,
    pub base_branch: String,
    pub is_repo: bool,
    pub worktrees: Vec<CodingWorktreeDto>,
    pub branches: Vec<CodingBranchDto>,
    /// 浏览 overview 不再自动提交；恒 false。空仓提示看 create 的 createdInitialCommit。
    pub created_initial_commit: bool,
    pub merging: bool,
    pub merging_cwd: Option<String>,
    pub origin: Option<CodingRemoteDto>,
    pub remote_branches: Vec<CodingRemoteBranchDto>,
    /// 车道覆盖层（app.db）；有树无行时前端按分支名现算
    #[serde(default)]
    pub lanes: Vec<CodingLaneDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingLaneDto {
    pub id: String,
    pub repo_path: String,
    pub name: String,
    pub theme: Option<String>,
    pub branch: String,
    pub worktree_path: String,
    pub current_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingMergeDto {
    pub merged: bool,
    pub conflict: bool,
    pub cwd: String,
    pub message: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewed_sha: Option<String>,
    pub ledger_written: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingOpDto {
    pub ok: bool,
    pub code: String,
    pub failed_phase: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_upstream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_initial_commit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tried: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<CodingWorktreeDto>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CreateWorktreeSource {
    #[default]
    FromBase,
    Local,
    Remote {
        #[serde(default = "default_origin")]
        remote: String,
    },
}

fn default_origin() -> String {
    "origin".into()
}

fn op_ok(message: impl Into<String>) -> CodingOpDto {
    CodingOpDto {
        ok: true,
        code: "ok".into(),
        failed_phase: None,
        message: message.into(),
        set_upstream: None,
        created_initial_commit: None,
        method: None,
        url: None,
        tried: None,
        worktree: None,
    }
}

fn op_err(code: &str, message: impl Into<String>) -> CodingOpDto {
    CodingOpDto {
        ok: false,
        code: code.into(),
        failed_phase: None,
        message: crate::sessions::redact_sensitive_text(&message.into()),
        set_upstream: None,
        created_initial_commit: None,
        method: None,
        url: None,
        tried: None,
        worktree: None,
    }
}

struct WorktreeRow {
    path: PathBuf,
    branch: String,
    detached: bool,
    head: String,
}

fn parse_worktree_list(text: &str) -> Vec<WorktreeRow> {
    let mut rows = Vec::new();
    let mut path: Option<PathBuf> = None;
    let mut branch = String::new();
    let mut detached = false;
    let mut head = String::new();
    let flush = |path: &mut Option<PathBuf>,
                 branch: &mut String,
                 detached: &mut bool,
                 head: &mut String,
                 rows: &mut Vec<WorktreeRow>| {
        if let Some(p) = path.take() {
            rows.push(WorktreeRow {
                path: p,
                branch: std::mem::take(branch),
                detached: *detached,
                head: std::mem::take(head),
            });
            *detached = false;
        }
    };
    for line in text.lines() {
        if line.is_empty() {
            flush(&mut path, &mut branch, &mut detached, &mut head, &mut rows);
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut branch, &mut detached, &mut head, &mut rows);
            path = Some(PathBuf::from(rest));
        } else if let Some(rest) = line.strip_prefix("branch ") {
            branch = strip_heads(rest);
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            head = rest.trim().to_string();
        } else if line == "detached" {
            detached = true;
        }
    }
    flush(&mut path, &mut branch, &mut detached, &mut head, &mut rows);
    rows
}

fn ahead_behind(repo: &Path, left: &str, right: &str) -> (u32, u32) {
    let spec = format!("{left}...{right}");
    let Ok(s) = git(repo, &["rev-list", "--left-right", "--count", &spec]) else {
        return (0, 0);
    };
    let mut parts = s.trim().split_whitespace();
    let behind = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

fn dirty_facts(path: &Path) -> (bool, u32) {
    let Ok(s) = git(path, &["status", "--porcelain=v1", "--untracked-files=all"]) else {
        return (false, 0);
    };
    let n = s
        .lines()
        .filter(|l| !l.trim().is_empty() && !crate::review_contract::is_untracked_ledger_file(l))
        .count() as u32;
    (n > 0, n)
}

fn last_commit_at(path: &Path) -> Option<String> {
    git(path, &["log", "-1", "--format=%cI"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn upstream_unpushed(path: &Path) -> (bool, u32, u32) {
    if git(path, &["rev-parse", "--abbrev-ref", "@{u}"]).is_err() {
        return (false, 0, 0);
    }
    let Ok(s) = git(
        path,
        &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
    ) else {
        return (true, 0, 0);
    };
    let mut parts = s.trim().split_whitespace();
    let behind = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    (true, ahead, behind)
}

fn overview_at(repo: &Path) -> Result<CodingOverviewDto, String> {
    let repo = PathBuf::from(crate::projects::canonical_key(repo));
    if !is_git_repo(&repo) {
        return Ok(CodingOverviewDto {
            repo_path: repo.to_string_lossy().into_owned(),
            base_branch: String::new(),
            is_repo: false,
            worktrees: Vec::new(),
            branches: Vec::new(),
            created_initial_commit: false,
            merging: false,
            merging_cwd: None,
            origin: None,
            remote_branches: Vec::new(),
            lanes: Vec::new(),
        });
    }
    let base = crate::workspaces::detect_base_branch(&repo);
    let list = git(&repo, &["worktree", "list", "--porcelain"]).unwrap_or_default();
    let wt_rows = parse_worktree_list(&list);
    let repo_key = crate::paths::path_key(&repo.to_string_lossy());

    struct TreeFacts {
        dirty: bool,
        dirty_count: u32,
        ahead: u32,
        behind: u32,
        has_upstream: bool,
        unpushed: u32,
        upstream_behind: u32,
        merging: bool,
        last_commit_at: Option<String>,
    }
    let tree_facts: Vec<TreeFacts> = std::thread::scope(|scope| {
        let handles: Vec<_> = wt_rows
            .iter()
            .map(|row| {
                let base = base.as_str();
                scope.spawn(move || {
                    let (dirty, dirty_count) = dirty_facts(&row.path);
                    let (ahead, behind) = if row.detached || row.branch.is_empty() {
                        (0, 0)
                    } else {
                        ahead_behind(&row.path, base, "HEAD")
                    };
                    let (has_upstream, unpushed, upstream_behind) = upstream_unpushed(&row.path);
                    TreeFacts {
                        dirty,
                        dirty_count,
                        ahead,
                        behind,
                        has_upstream,
                        unpushed,
                        upstream_behind,
                        merging: merging_at(&row.path),
                        last_commit_at: last_commit_at(&row.path),
                    }
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join().unwrap_or(TreeFacts {
                    dirty: false,
                    dirty_count: 0,
                    ahead: 0,
                    behind: 0,
                    has_upstream: false,
                    unpushed: 0,
                    upstream_behind: 0,
                    merging: false,
                    last_commit_at: None,
                })
            })
            .collect()
    });

    let mut by_branch: HashMap<String, (PathBuf, bool, bool)> = HashMap::new();
    let mut worktrees = Vec::new();
    let mut merging_cwd = None;
    for (row, facts) in wt_rows.iter().zip(tree_facts) {
        let path_s = crate::paths::strip_verbatim(row.path.clone())
            .to_string_lossy()
            .into_owned();
        let is_primary = crate::paths::path_key(&path_s) == repo_key;
        let branch = if row.detached {
            String::new()
        } else {
            row.branch.clone()
        };
        let is_base = !branch.is_empty() && branch == base;
        if !branch.is_empty() {
            by_branch.insert(branch.clone(), (row.path.clone(), is_primary, facts.dirty));
        }
        if facts.merging && merging_cwd.is_none() {
            merging_cwd = Some(path_s.clone());
        }
        let ledger_pending = !branch.is_empty()
            && !is_base
            && crate::review_contract::pending_needs_attention(&format!(
                "coding-{}-{branch}",
                crate::projects::canonical_key(&repo)
            ));
        worktrees.push(CodingWorktreeDto {
            ledger_pending,
            path: path_s,
            branch,
            is_primary,
            is_base,
            dirty: facts.dirty,
            ahead: facts.ahead,
            behind: facts.behind,
            unpushed: facts.unpushed,
            has_upstream: facts.has_upstream,
            detached: row.detached,
            last_commit_at: facts.last_commit_at,
            dirty_count: facts.dirty_count,
            upstream_behind: facts.upstream_behind,
            head: if row.head.is_empty() {
                None
            } else {
                Some(row.head.clone())
            },
        });
    }

    let refs = git(
        &repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(upstream:short)",
            "refs/heads",
        ],
    )
    .unwrap_or_default();
    struct BranchLine {
        name: String,
        upstream: String,
        wt_path: Option<PathBuf>,
        is_primary: bool,
        dirty: bool,
    }
    let branch_lines: Vec<BranchLine> = refs
        .lines()
        .filter_map(|line| {
            if line.trim().is_empty() {
                return None;
            }
            let mut cols = line.split('\t');
            let name = cols.next().unwrap_or("").trim().to_string();
            if name.is_empty() {
                return None;
            }
            let upstream = cols.next().unwrap_or("").trim().to_string();
            let (wt_path, is_primary, dirty) = by_branch
                .get(&name)
                .map(|(p, prim, d)| (Some(p.clone()), *prim, *d))
                .unwrap_or((None, false, false));
            Some(BranchLine {
                name,
                upstream,
                wt_path,
                is_primary,
                dirty,
            })
        })
        .collect();

    struct BranchFacts {
        ahead: u32,
        behind: u32,
        has_upstream: bool,
        unpushed: u32,
        upstream_behind: u32,
    }
    let branch_facts: Vec<BranchFacts> = std::thread::scope(|scope| {
        let handles: Vec<_> = branch_lines
            .iter()
            .map(|line| {
                let repo = repo.as_path();
                let base = base.as_str();
                scope.spawn(move || {
                    let cwd = line.wt_path.as_deref().unwrap_or(repo);
                    let (ahead, behind) = ahead_behind(cwd, base, &line.name);
                    let (has_upstream, unpushed, upstream_behind) = if line.upstream.is_empty() {
                        (false, 0, 0)
                    } else if let Some(p) = line.wt_path.as_deref() {
                        upstream_unpushed(p)
                    } else {
                        let spec = format!("{}...{}", line.upstream, line.name);
                        let s = git(repo, &["rev-list", "--left-right", "--count", &spec])
                            .unwrap_or_default();
                        let mut parts = s.trim().split_whitespace();
                        let b = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
                        let a = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
                        (true, a, b)
                    };
                    BranchFacts {
                        ahead,
                        behind,
                        has_upstream,
                        unpushed,
                        upstream_behind,
                    }
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join().unwrap_or(BranchFacts {
                    ahead: 0,
                    behind: 0,
                    has_upstream: false,
                    unpushed: 0,
                    upstream_behind: 0,
                })
            })
            .collect()
    });

    let mut branches = Vec::new();
    for (line, facts) in branch_lines.into_iter().zip(branch_facts) {
        branches.push(CodingBranchDto {
            name: line.name.clone(),
            worktree_path: line.wt_path.map(|p| {
                crate::paths::strip_verbatim(p)
                    .to_string_lossy()
                    .into_owned()
            }),
            is_primary: line.is_primary,
            is_base: line.name == base,
            dirty: line.dirty,
            ahead: facts.ahead,
            behind: facts.behind,
            unpushed: facts.unpushed,
            has_upstream: facts.has_upstream,
            upstream_behind: facts.upstream_behind,
        });
    }
    let local_names: HashMap<String, Option<String>> = branches
        .iter()
        .map(|b| (b.name.clone(), b.worktree_path.clone()))
        .collect();
    let remote_refs = git(
        &repo,
        &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
    )
    .unwrap_or_default();
    let mut remote_branches = Vec::new();
    for line in remote_refs.lines() {
        let full = line.trim();
        if full.is_empty() || full.ends_with("/HEAD") {
            continue;
        }
        let Some((remote, name)) = full.split_once('/') else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let occupied = local_names.get(name).and_then(|p| p.clone());
        remote_branches.push(CodingRemoteBranchDto {
            remote: remote.to_string(),
            name: name.to_string(),
            has_local: local_names.contains_key(name),
            occupied_path: occupied,
        });
    }
    Ok(CodingOverviewDto {
        repo_path: repo.to_string_lossy().into_owned(),
        base_branch: base,
        is_repo: true,
        worktrees,
        branches,
        created_initial_commit: false,
        merging: merging_cwd.is_some(),
        merging_cwd,
        origin: origin_dto(&repo),
        remote_branches,
        lanes: list_lanes_for(&repo),
    })
}

fn ensure_lanes_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS coding_lanes (
          id TEXT PRIMARY KEY,
          repo_path TEXT NOT NULL,
          name TEXT NOT NULL,
          theme TEXT,
          branch TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          current_run_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_coding_lanes_repo ON coding_lanes(repo_path);",
    )
    .map_err(|e| format!("初始化 coding_lanes 表失败: {e}"))?;
    let _ = conn.execute_batch("ALTER TABLE coding_lanes ADD COLUMN project_id TEXT;");
    Ok(())
}

pub(crate) fn relocate_lane_repo_paths(
    project_id: &str,
    old_path: &str,
    new_path: &str,
) -> Result<(), String> {
    let conn = crate::sessions::open_db()?;
    ensure_lanes_schema(&conn)?;
    conn.execute(
        "UPDATE coding_lanes SET repo_path=?3, project_id=?1 WHERE project_id=?1 OR repo_path=?2",
        params![project_id, old_path, new_path],
    )
    .map_err(|e| format!("更新编程车道位置失败: {e}"))?;
    Ok(())
}

fn list_lanes_for(repo: &Path) -> Vec<CodingLaneDto> {
    let Ok(conn) = crate::sessions::open_db() else {
        return Vec::new();
    };
    if ensure_lanes_schema(&conn).is_err() {
        return Vec::new();
    }
    let key = crate::projects::canonical_key(repo);
    let mut stmt = match conn.prepare(
        "SELECT id, repo_path, name, theme, branch, worktree_path, current_run_id, project_id
         FROM coding_lanes WHERE repo_path = ?1 OR project_id = (SELECT id FROM projects WHERE path=?1) ORDER BY created_at",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![key], |r| {
        Ok(CodingLaneDto {
            id: r.get(0)?,
            repo_path: r.get(1)?,
            name: r.get(2)?,
            theme: r.get(3)?,
            branch: r.get(4)?,
            worktree_path: r.get(5)?,
            current_run_id: r.get(6)?,
            project_id: r.get(7).ok().flatten(),
        })
    });
    match rows {
        Ok(iter) => iter.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

/// lanes 表按最长前缀命中（覆盖层登记）：主仓 + 分支名一起回。
fn lanes_attribution(isolation: &str) -> Option<(String, String)> {
    let Ok(conn) = crate::sessions::open_db() else {
        return None;
    };
    if ensure_lanes_schema(&conn).is_err() {
        return None;
    }
    let mut stmt = conn
        .prepare("SELECT repo_path, worktree_path, branch FROM coding_lanes")
        .ok()?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .ok()?;
    let mut best: Option<(usize, String, String)> = None;
    for (repo, wt, branch) in rows.flatten() {
        if crate::paths::path_within(isolation, &wt) {
            let len = wt.len();
            if best.as_ref().map(|(l, _, _)| len > *l).unwrap_or(true) {
                best = Some((len, repo, branch));
            }
        }
    }
    best.map(|(_, p, b)| (p, b))
}

fn repo_path_for_worktree_lanes(isolation: &str) -> Option<String> {
    lanes_attribution(isolation).map(|(repo, _)| repo)
}

/// 工作树 → 主仓路径：lanes 覆盖层优先，miss 时走 git 事实源兜底（C1 修复）。
/// 「Lane 是覆盖层、git worktree 是事实源」（agent-workbench §5.1）落在解析层：
/// 建树不写 lane 行（分组是可选装饰）不再让 validate_policy 拦「无法确定所属项目」。
/// 注意不用 --show-toplevel（那是工作树自己的顶层），--git-common-dir 指向主仓 .git。
fn git_common_repo_path(isolation: &Path) -> Option<String> {
    let out = git(isolation, &[
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
    ])
    .ok()?;
    let common = PathBuf::from(out.trim());
    let repo = common.parent()?;
    if repo.as_os_str().is_empty() {
        return None;
    }
    Some(repo.to_string_lossy().into_owned())
}

/// git 兜底结果按路径记忆化：会话扫描/用量归并会对每棵树各解一次，
/// 子进程别重复跑（目录后来才建树的场景由 lanes 表命中覆盖，缓存不失效可接受）。
static REPO_PATH_GIT_CACHE: Mutex<Option<HashMap<String, Option<String>>>> =
    Mutex::new(None);

pub(crate) fn repo_path_for_worktree(isolation: &str) -> Option<String> {
    if let Some(hit) = repo_path_for_worktree_lanes(isolation) {
        return Some(hit);
    }
    let resolved = match REPO_PATH_GIT_CACHE.lock() {
        Ok(mut guard) => {
            let cache = guard.get_or_insert_with(HashMap::new);
            if let Some(cached) = cache.get(isolation) {
                return cached.clone();
            }
            let value = git_common_repo_path(Path::new(isolation));
            cache.insert(isolation.to_string(), value.clone());
            value
        }
        Err(_) => git_common_repo_path(Path::new(isolation)),
    };
    resolved
}

/// 工作树 → (主仓, 分支名)：lanes 覆盖层优先，miss 走 git 事实源
/// （C2：会话扫描把编程树会话归并回主仓行、workspace 填分支名）。记忆化同
/// repo_path_for_worktree——会话/用量每轮扫描都要解。
fn git_branch_for_worktree(isolation: &Path) -> Option<String> {
    let out = git(isolation, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    let branch = out.trim();
    if branch.is_empty() || branch == "HEAD" {
        return None; // detached
    }
    Some(branch.to_string())
}

static WT_BRANCH_GIT_CACHE: Mutex<Option<HashMap<String, Option<String>>>> =
    Mutex::new(None);

pub(crate) fn attribution_for_worktree(isolation: &str) -> Option<(String, String)> {
    if let Some((repo, branch)) = lanes_attribution(isolation) {
        return Some((repo, branch));
    }
    let repo = repo_path_for_worktree(isolation)?;
    let branch = match WT_BRANCH_GIT_CACHE.lock() {
        Ok(mut guard) => {
            let cache = guard.get_or_insert_with(HashMap::new);
            if let Some(cached) = cache.get(isolation) {
                cached.clone()
            } else {
                let value = git_branch_for_worktree(Path::new(isolation));
                cache.insert(isolation.to_string(), value.clone());
                value
            }
        }
        Err(_) => git_branch_for_worktree(Path::new(isolation)),
    };
    branch.map(|b| (repo, b))
}

pub(crate) fn touch_lane_current_run(worktree: &str, run_id: &str) {
    let Ok(conn) = crate::sessions::open_db() else {
        return;
    };
    if ensure_lanes_schema(&conn).is_err() {
        return;
    }
    let _ = conn.execute(
        "UPDATE coding_lanes SET current_run_id=?2 WHERE worktree_path=?1",
        params![worktree, run_id],
    );
    let key = crate::projects::canonical_key(Path::new(worktree));
    if key != worktree {
        let _ = conn.execute(
            "UPDATE coding_lanes SET current_run_id=?2 WHERE worktree_path=?1",
            params![key, run_id],
        );
    }
}

pub(crate) fn clear_lane_current_run(run_id: &str) {
    let Ok(conn) = crate::sessions::open_db() else {
        return;
    };
    if ensure_lanes_schema(&conn).is_err() {
        return;
    }
    let _ = conn.execute(
        "UPDATE coding_lanes SET current_run_id=NULL WHERE current_run_id=?1",
        params![run_id],
    );
}

#[tauri::command]
pub async fn coding_upsert_lane(
    repo_path: String,
    worktree_path: String,
    branch: String,
    name: Option<String>,
    theme: Option<String>,
    id: Option<String>,
) -> Result<CodingLaneDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = PathBuf::from(crate::projects::canonical_key(&expand(&repo_path)));
        let wt = expand(&worktree_path);
        let conn = crate::sessions::open_db()?;
        ensure_lanes_schema(&conn)?;
        let wt_key = crate::projects::canonical_key(&wt);
        let wt_stored = wt.to_string_lossy().into_owned();
        let existing_id: Option<String> = id
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                conn.query_row(
                    "SELECT id FROM coding_lanes
                     WHERE worktree_path = ?1 OR worktree_path = ?2
                     ORDER BY created_at LIMIT 1",
                    params![wt_stored.as_str(), wt_key.as_str()],
                    |r| r.get(0),
                )
                .ok()
            });
        let id = existing_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let name = name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| branch.clone());
        let theme = theme.and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        });
        let now = chrono::Local::now().to_rfc3339();
        let project_id = crate::projects::project_id_at(&repo);
        conn.execute(
            "INSERT INTO coding_lanes (id, repo_path, name, theme, branch, worktree_path, current_run_id, created_at, project_id)
             VALUES (?1,?2,?3,?4,?5,?6,NULL,?7,?8)
             ON CONFLICT(id) DO UPDATE SET name=?3, theme=?4, branch=?5, worktree_path=?6, project_id=COALESCE(?8, coding_lanes.project_id)",
            params![
                id,
                repo.to_string_lossy().as_ref(),
                name,
                theme,
                branch,
                wt.to_string_lossy().as_ref(),
                now,
                project_id,
            ],
        )
        .map_err(|e| format!("保存车道失败: {e}"))?;
        Ok(CodingLaneDto {
            id,
            repo_path: repo.to_string_lossy().into_owned(),
            name,
            theme,
            branch,
            worktree_path: wt.to_string_lossy().into_owned(),
            current_run_id: None,
            project_id,
        })
    })
    .await
    .map_err(|e| format!("保存车道失败: {e}"))?
}

fn local_branch_exists(repo: &Path, branch: &str) -> bool {
    git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok()
}

fn occupied_path(ov: &CodingOverviewDto, branch: &str) -> Option<String> {
    ov.worktrees
        .iter()
        .find(|w| w.branch == branch && !w.detached)
        .map(|w| w.path.clone())
}

fn finish_create(
    repo: &Path,
    branch: &str,
    dest: &Path,
    created_initial: bool,
) -> Result<CodingOpDto, String> {
    let ov = overview_at(repo)?;
    let base = ov.base_branch.clone();
    let Some(wt) = ov.worktrees.into_iter().find(|w| w.branch == branch) else {
        let _ = fs::remove_dir_all(dest);
        return Ok(op_err("git_failed", "工作树已创建，但列表里还看不到"));
    };
    write_lane_task_md(dest, branch, &base);
    let mut dto = op_ok(format!("已创建工作树 {branch}"));
    dto.created_initial_commit = Some(created_initial);
    dto.worktree = Some(wt);
    Ok(dto)
}

/// 编程树最短任务书：已有不覆盖；失败不阻断建树。TASK.md 进 .git/info/exclude。
fn write_lane_task_md(dest: &Path, branch: &str, base: &str) {
    crate::projects::exclude_task_md(dest);
    let path = dest.join("TASK.md");
    if path.exists() {
        return;
    }
    let body = format!(
        "# {branch}\n\n- 基准：{base}\n- 意图：{branch}\n\n先读本文件再改代码。只改这棵树，不要切回主仓文件夹。\n"
    );
    let _ = crate::profiles::atomic_write(&path, &body);
}

fn create_with_source(
    repo: &Path,
    branch: &str,
    source: CreateWorktreeSource,
) -> Result<CodingOpDto, String> {
    let repo = PathBuf::from(crate::projects::canonical_key(repo));
    if !is_git_repo(&repo) {
        return Ok(op_err("git_failed", "不是 git 仓库"));
    }
    let branch = strip_heads(branch);
    if branch.is_empty() {
        return Ok(op_err("git_failed", "分支名不能为空"));
    }
    if git(
        &repo,
        &[
            "check-ref-format",
            "--allow-onelevel",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_err()
    {
        return Ok(op_err("git_failed", format!("分支名不合法：{branch}")));
    }
    let created_initial = crate::workspaces::ensure_initial_commit(&repo)?;
    let ov = overview_at(&repo)?;
    let dest = default_worktree_path(&repo, &branch)?;
    match &source {
        CreateWorktreeSource::FromBase => {
            if local_branch_exists(&repo, &branch) {
                return Ok(op_err(
                    "branch_exists",
                    format!("本地已有 {branch}。改为给它建工作树？"),
                ));
            }
        }
        CreateWorktreeSource::Local => {
            if !local_branch_exists(&repo, &branch) {
                return Ok(op_err("git_failed", format!("本地没有分支 {branch}")));
            }
            if let Some(p) = occupied_path(&ov, &branch) {
                return Ok(op_err("worktree_busy", format!("已在 {p} 检出")));
            }
        }
        CreateWorktreeSource::Remote { remote } => {
            let remote = if remote.trim().is_empty() {
                "origin"
            } else {
                remote.trim()
            };
            if local_branch_exists(&repo, &branch) {
                return Ok(op_err(
                    "branch_exists",
                    format!("本地已有 {branch}，给它建工作树？（不会重置成 {remote}/{branch}）"),
                ));
            }
        }
    }
    if dest.exists() {
        return Ok(op_err(
            "git_failed",
            format!("工作树目录已存在：{}", dest.display()),
        ));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建工作树目录失败: {e}"))?;
    }
    let dest_s = dest.to_string_lossy().into_owned();
    let add = match &source {
        CreateWorktreeSource::FromBase => {
            let base = ov.base_branch.clone();
            git_long(
                &repo,
                &["worktree", "add", "-b", &branch, "--", &dest_s, &base],
            )
        }
        CreateWorktreeSource::Local => {
            git_long(&repo, &["worktree", "add", "--", &dest_s, &branch])
        }
        CreateWorktreeSource::Remote { remote } => {
            let remote = if remote.trim().is_empty() {
                "origin"
            } else {
                remote.trim()
            };
            let spec = format!("refs/heads/{branch}:refs/remotes/{remote}/{branch}");
            if let Err(e) = git_long(&repo, &["fetch", "--", remote, &spec]) {
                let mut dto = op_err("git_failed", e);
                dto.failed_phase = Some("fetch".into());
                let _ = fs::remove_dir_all(&dest);
                return Ok(dto);
            }
            let tracked = format!("{remote}/{branch}");
            git_long(
                &repo,
                &[
                    "worktree", "add", "--track", "-b", &branch, "--", &dest_s, &tracked,
                ],
            )
        }
    };
    if let Err(e) = add {
        let _ = fs::remove_dir_all(&dest);
        return Ok(op_err(
            "git_failed",
            crate::sessions::redact_sensitive_text(&format!("创建工作树失败: {e}")),
        ));
    }
    finish_create(&repo, &branch, &dest, created_initial)
}

#[cfg(test)]
fn create_at(repo: &Path, branch: &str) -> Result<CodingWorktreeDto, String> {
    let op = create_with_source(repo, branch, CreateWorktreeSource::FromBase)?;
    if !op.ok {
        return Err(op.message);
    }
    op.worktree
        .ok_or_else(|| "工作树已创建，但列表里还看不到".into())
}

fn remove_at(repo: &Path, worktree_path: &str, delete_branch: bool) -> Result<(), String> {
    let repo = PathBuf::from(crate::projects::canonical_key(repo));
    let wt = expand(worktree_path);
    let wt_key = crate::paths::path_key(&wt.to_string_lossy());
    if crate::paths::same_path(&wt.to_string_lossy(), &repo.to_string_lossy()) {
        return Err("主仓不能删除工作树".into());
    }
    let ov = overview_at(&repo)?;
    let row = ov
        .worktrees
        .iter()
        .find(|w| crate::paths::path_key(&w.path) == wt_key)
        .ok_or("找不到这棵工作树")?;
    if row.is_primary {
        return Err("主仓不能删除工作树".into());
    }
    if row.dirty {
        return Err("工作树有未提交改动。确认后再删，或先提交 / 丢弃改动。".into());
    }
    let branch = row.branch.clone();
    git_long(&repo, &["worktree", "remove", &row.path])
        .map_err(|e| format!("删除工作树失败: {e}"))?;
    if delete_branch && !branch.is_empty() && !row.is_base {
        git(&repo, &["branch", "-d", &branch]).map_err(|e| {
            format!("工作树已删除，但分支未删：还有未合入基准的提交。可在分支台强制删除。({e})")
        })?;
    }
    Ok(())
}

fn force_remove_at(repo: &Path, worktree_path: &str, delete_branch: bool) -> Result<(), String> {
    let repo = PathBuf::from(crate::projects::canonical_key(repo));
    let wt = expand(worktree_path);
    if crate::paths::same_path(&wt.to_string_lossy(), &repo.to_string_lossy()) {
        return Err("主仓不能删除工作树".into());
    }
    let path_s = wt.to_string_lossy().into_owned();
    let ov = overview_at(&repo)?;
    let branch = ov
        .worktrees
        .iter()
        .find(|w| crate::paths::same_path(&w.path, &path_s))
        .map(|w| w.branch.clone())
        .unwrap_or_default();
    git_long(&repo, &["worktree", "remove", "--force", &path_s])
        .map_err(|e| format!("删除工作树失败: {e}"))?;
    if delete_branch && !branch.is_empty() {
        git(&repo, &["branch", "-d", &branch]).map_err(|e| {
            format!("工作树已删除，但分支未删：还有未合入基准的提交。可在分支台强制删除。({e})")
        })?;
    }
    Ok(())
}

fn merge_at(
    repo: &Path,
    branch: &str,
    expect_reviewed_sha: Option<&str>,
) -> Result<CodingMergeDto, String> {
    let repo = PathBuf::from(crate::projects::canonical_key(repo));
    let _apply_lock = crate::review_contract::apply_lock(&repo)?;
    let branch = strip_heads(branch);
    let ov = overview_at(&repo)?;
    if !ov.is_repo {
        return Err("不是 git 仓库".into());
    }
    let base = ov.base_branch.clone();
    if branch == base {
        return Err("不能把基准分支合并进自己".into());
    }
    let Some(target) = ov.worktrees.iter().find(|w| w.is_base) else {
        return Ok(CodingMergeDto {
            merged: false,
            conflict: false,
            cwd: repo.to_string_lossy().into_owned(),
            message: format!("没有检出「{base}」的工作树。请先为基准建一棵工作树再合并。"),
            code: "base_not_checked_out".into(),
            version_id: None,
            reviewed_sha: None,
            ledger_written: false,
        });
    };
    let cwd = PathBuf::from(&target.path);
    let already = crate::workspaces::git_is_ancestor(&cwd, &branch, &base)?;
    let tip = git_long(&repo, &["rev-parse", &branch])?;
    let pending_key = format!("coding-{}-{branch}", crate::projects::canonical_key(&repo));
    if crate::review_contract::read_pending(&pending_key)?.is_some() || already {
        let entry = crate::review_contract::recover_fact(
            &repo,
            &pending_key,
            crate::review_contract::KIND_CODING_MERGE,
            &branch,
            &tip,
        )?;
        if !crate::workspaces::git_is_ancestor(&cwd, &entry.version_id, &base)? {
            return Err("恢复凭证中的版本不在基准历史中，未重新合并".into());
        }
        let recording = crate::review_contract::record_pending_fact(&repo, &pending_key, &entry);
        let ledger = recording.is_ok();
        return Ok(CodingMergeDto {
            merged: true,
            conflict: false,
            cwd: target.path.clone(),
            message: match recording {
                Ok(()) => format!(
                    "文件已进入项目 · {}",
                    entry.version_id.chars().take(8).collect::<String>()
                ),
                Err(e) => format!("文件已进主仓，但验收记录未完成：{e}。请点「再记录验收」"),
            },
            code: "ok".into(),
            version_id: Some(entry.version_id),
            reviewed_sha: entry.reviewed_sha,
            ledger_written: ledger,
        });
    }
    if target.dirty {
        return Err("基准工作树有未提交改动，先提交或丢弃再合并".into());
    }
    crate::review_contract::assert_reviewed_sha(expect_reviewed_sha.unwrap_or(""), &tip)?;
    let protected = crate::projects::protected_paths_at(&repo)?;
    let range = format!("{base}...{tip}");
    let touched = git_long(&repo, &["diff", "--name-only", &range])?;
    if !protected.is_empty() {
        let hits: Vec<&str> = touched
            .lines()
            .filter(|rel| crate::projects::path_is_protected(rel, &protected))
            .collect();
        if !hits.is_empty() {
            let names = hits.iter().take(5).copied().collect::<Vec<_>>().join("、");
            let suffix = if hits.len() > 5 {
                format!(" 等 {} 个文件", hits.len())
            } else {
                String::new()
            };
            return Err(format!(
                "分支改动了保护路径下的文件（{names}{suffix}），合并会覆盖主仓中「保持原样」的内容；\
                 请先在工作树撤掉这些改动，或在项目设置中调整保护路径后再合并"
            ));
        }
    }
    match git_long(
        &cwd,
        &["-c", "commit.gpgsign=false", "merge", "--no-edit", &tip],
    ) {
        Ok(text) => {
            let version_id = git_long(&cwd, &["rev-parse", "HEAD"])?;
            let paths: Vec<String> = touched
                .lines()
                .map(|l| l.to_string())
                .filter(|l| !l.is_empty())
                .collect();
            let entry = crate::projects::AcceptanceLogEntry {
                goal_id: String::new(),
                goal_name: format!("{branch} → {base}"),
                run_id: String::new(),
                paths,
                note: format!("已把 {branch} 合并进 {base}"),
                frozen: false,
                decided_at: crate::sessions::now_iso(),
                kind: crate::review_contract::KIND_CODING_MERGE.into(),
                version_id: version_id.clone(),
                reviewed_sha: if tip.is_empty() {
                    None
                } else {
                    Some(tip.clone())
                },
                project_id: crate::projects::project_id_at(&repo),
                scene_ref: Some(branch.clone()),
                content_fingerprints: Vec::new(),
            };
            let ledger =
                crate::review_contract::record_pending_fact(&repo, &pending_key, &entry).is_ok();
            Ok(CodingMergeDto {
                merged: true,
                conflict: false,
                cwd: target.path.clone(),
                message: if ledger {
                    if text.is_empty() {
                        format!(
                            "文件已进入项目 · {}",
                            &version_id.chars().take(8).collect::<String>()
                        )
                    } else {
                        text
                    }
                } else {
                    "已合并进基准，但验收记录未写下。请再点一次合并以补记".into()
                },
                code: "ok".into(),
                version_id: Some(version_id),
                reviewed_sha: if tip.is_empty() { None } else { Some(tip) },
                ledger_written: ledger,
            })
        }
        Err(e) => {
            if merging_at(&cwd) {
                Ok(CodingMergeDto {
                    merged: false,
                    conflict: true,
                    cwd: target.path.clone(),
                    message: "合并冲突，请到终端改动面板解决后提交，或点「取消合并」".into(),
                    code: "ok".into(),
                    version_id: None,
                    reviewed_sha: None,
                    ledger_written: false,
                })
            } else {
                Err(e)
            }
        }
    }
}

fn delete_branch_at(repo: &Path, branch: &str, force: bool) -> Result<(), String> {
    let repo = PathBuf::from(crate::projects::canonical_key(repo));
    let branch = strip_heads(branch);
    let ov = overview_at(&repo)?;
    if branch == ov.base_branch {
        return Err("不能删除基准分支".into());
    }
    if ov
        .worktrees
        .iter()
        .any(|w| w.branch == branch && !w.detached)
    {
        return Err("这个分支还挂着工作树，先删工作树".into());
    }
    if force {
        git(&repo, &["branch", "-D", &branch])?;
        return Ok(());
    }
    git(&repo, &["branch", "-d", &branch])
        .map_err(|e| format!("分支还有未合入基准的提交，强删会丢掉这些提交。{e}"))?;
    Ok(())
}

fn remote_op(cwd: &str, args: &[&str]) -> Result<String, String> {
    let path = expand(cwd);
    if !is_git_repo(&path) {
        return Err("不是 git 仓库".into());
    }
    git_long(&path, args)
}

fn run_tool(
    bin: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<(bool, String), String> {
    // 这里只打开 GitHub Desktop/浏览器，子孙窗口必须在启动器退出后继续运行。
    // 不纳入捕获任务的 kill-on-close Job；也不继承输出管道，避免等到窗口关闭才 EOF。
    let mut cmd = crate::process::background_command(bin);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("启动外部应用失败：{e}"))?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok((
                    status.success(),
                    if status.success() {
                        String::new()
                    } else {
                        format!("启动器退出码：{:?}", status.code())
                    },
                ))
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Ok(None) => {
                let _ = child.kill();
                return Err("外部应用启动超时".into());
            }
            Err(error) => {
                let _ = child.kill();
                return Err(format!("等待启动器失败：{error}"));
            }
        }
    }
}

const T_SHORT: Duration = Duration::from_secs(15);
/// `gh pr view --web` 只为已有 PR 开浏览器；超时立刻走 compare URL，避免点完像没反应。
const T_PR_WEB: Duration = Duration::from_secs(5);

fn add_origin_at(repo: &Path, url: &str) -> Result<CodingOpDto, String> {
    let repo = PathBuf::from(crate::projects::canonical_key(repo));
    if !is_git_repo(&repo) {
        return Ok(op_err("git_failed", "不是 git 仓库"));
    }
    if origin_dto(&repo).is_some() {
        return Ok(op_err("git_failed", "已经有 origin。改远程请到终端。"));
    }
    let Some(parsed) = parse_git_remote_url(url) else {
        return Ok(op_err("invalid_url", "远程地址不合法"));
    };
    if let Err(e) = git(&repo, &["remote", "add", "--", "origin", url.trim()]) {
        return Ok(op_err("git_failed", e));
    }
    match git_long(&repo, &["fetch", "--all", "--prune"]) {
        Ok(_) => {
            let mut dto = op_ok(format!("已连接 {}", parsed.display));
            dto.failed_phase = None;
            Ok(dto)
        }
        Err(e) => {
            let mut dto = op_err("git_failed", e);
            dto.failed_phase = Some("fetch".into());
            dto.message = crate::sessions::redact_sensitive_text(
                "远程已添加，但更新引用失败。可点「从远程更新」再试。",
            );
            Ok(dto)
        }
    }
}

/// Desktop 菜单「Install Command Line Tool」装到 PATH 的 `github`；
/// 没装时用 .app 里那份 `github.sh`（cli.js：`open -n <app> --args --cli-open=`）。
fn desktop_cli_bin() -> Option<PathBuf> {
    if let Some(bin) = crate::agents::resolve_binary("github") {
        return Some(bin);
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(app) = macos_desktop_app() {
            let sh = app
                .join("Contents")
                .join("Resources")
                .join("app")
                .join("static")
                .join("github.sh");
            if sh.is_file() {
                return Some(sh);
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn macos_desktop_app() -> Option<PathBuf> {
    const NAME: &str = "GitHub Desktop.app";
    let sys = PathBuf::from("/Applications").join(NAME);
    if sys.is_dir() {
        return Some(sys);
    }
    dirs::home_dir()
        .map(|h| h.join("Applications").join(NAME))
        .filter(|p| p.is_dir())
}

fn open_desktop_at(repo_path: &Path, path: &Path) -> Result<CodingOpDto, String> {
    let repo = PathBuf::from(crate::projects::canonical_key(repo_path));
    let path_c = crate::paths::canonicalize_plain(path).map_err(|e| format!("路径无效: {e}"))?;
    let path_s = crate::paths::strip_verbatim(path_c)
        .to_string_lossy()
        .into_owned();
    let ov = overview_at(&repo)?;
    if !ov
        .worktrees
        .iter()
        .any(|w| crate::paths::same_path(&w.path, &path_s))
    {
        return Ok(op_err("not_worktree", "只能打开本仓的工作树"));
    }
    let mut tried = Vec::new();
    if let Some(bin) = desktop_cli_bin() {
        tried.push("github-cli".into());
        match run_tool(&bin, &[&path_s], None, T_SHORT) {
            Ok((true, _)) => {
                let mut dto = op_ok("已用 GitHub Desktop 打开这一目录");
                dto.method = Some("github-cli".into());
                dto.tried = Some(tried);
                return Ok(dto);
            }
            Ok((false, msg)) => {
                tried.push(msg);
            }
            Err(e) => tried.push(e),
        }
    } else {
        tried.push("github-cli-missing".into());
    }
    #[cfg(target_os = "macos")]
    {
        // 官方 cli.js：`open -n <GitHub Desktop.app> --args --cli-open=<path>`。
        // 不要 `open -a` 且不加 `-n`：已在运行时只激活窗口，--args 会被丢掉。
        let Some(app) = macos_desktop_app() else {
            let mut dto = op_err(
                "desktop_missing",
                "没有 GitHub Desktop。安装后用命令行工具打开这一棵工作树，不要打开主仓文件夹。",
            );
            dto.tried = Some(tried);
            return Ok(dto);
        };
        let open =
            crate::agents::resolve_binary("open").unwrap_or_else(|| PathBuf::from("/usr/bin/open"));
        tried.push("macos-open".into());
        let app_s = app.to_string_lossy().into_owned();
        let flag = format!("--cli-open={path_s}");
        match run_tool(&open, &["-n", &app_s, "--args", &flag], None, T_SHORT) {
            Ok((true, _)) => {
                let mut dto = op_ok("已用 GitHub Desktop 打开这一目录");
                dto.method = Some("macos-open".into());
                dto.tried = Some(tried);
                return Ok(dto);
            }
            Ok((false, msg)) => tried.push(msg),
            Err(e) => tried.push(e),
        }
        let mut dto = op_err(
            "desktop_missing",
            "GitHub Desktop 没切到这一目录。请在 Desktop 菜单里安装命令行工具后再试。",
        );
        dto.tried = Some(tried);
        return Ok(dto);
    }
    #[cfg(target_os = "windows")]
    {
        let mut dto = op_err(
            "desktop_missing",
            "请在 GitHub Desktop 菜单里安装命令行工具，再打开这一棵工作树。",
        );
        dto.tried = Some(tried);
        return Ok(dto);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let mut dto = op_err(
            "desktop_missing",
            "Linux 没有官方 GitHub Desktop。请用「显示」打开这个目录，或继续用 Mesa 改动面板。",
        );
        dto.tried = Some(tried);
        return Ok(dto);
    }
}

fn open_pr_at(repo_path: &str, cwd: &str) -> Result<CodingOpDto, String> {
    let cwd_p = expand(cwd);
    let cwd_c = crate::paths::canonicalize_plain(&cwd_p).map_err(|e| format!("路径无效: {e}"))?;
    let cwd_s = crate::paths::strip_verbatim(cwd_c)
        .to_string_lossy()
        .into_owned();
    if !is_git_repo(&expand(&cwd_s)) {
        return Ok(op_err("not_worktree", "不是 git 工作树"));
    }
    let list = git(&expand(&cwd_s), &["worktree", "list", "--porcelain"]).unwrap_or_default();
    let rows = parse_worktree_list(&list);
    if !rows
        .iter()
        .any(|r| crate::paths::same_path(&r.path.to_string_lossy(), &cwd_s))
    {
        return Ok(op_err("not_worktree", "路径不是这个仓库的工作树"));
    }
    let _ = repo_path;
    let Some(origin) = origin_dto(&expand(&cwd_s)) else {
        return Ok(op_err("no_origin", "还没连上远程"));
    };
    if origin.host_kind != "github" {
        return Ok(op_err(
            "not_github",
            "只有 github.com 能在这里开 Pull Request",
        ));
    }
    let (has_up, _, _) = upstream_unpushed(&expand(&cwd_s));
    if !has_up {
        return Ok(op_err("no_upstream", "先推送才能开 PR"));
    }
    let branch = git(&expand(&cwd_s), &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|_| "HEAD".into());
    let branch = branch.trim();
    let base = crate::workspaces::detect_base_branch(&expand(&cwd_s));
    let parsed = parse_git_remote_url(&origin.url);
    let compare = parsed
        .as_ref()
        .map(|p| github_compare_url(&p.owner_repo, &base, branch));
    if let Some(gh) = crate::agents::resolve_binary("gh") {
        if run_tool(
            &gh,
            &["pr", "view", "--web"],
            Some(&expand(&cwd_s)),
            T_PR_WEB,
        )
        .map(|(ok, _)| ok)
        .unwrap_or(false)
        {
            let mut dto = op_ok("已打开 Pull Request");
            dto.method = Some("gh-view".into());
            return Ok(dto);
        }
    }
    if let Some(url) = compare {
        let mut dto = op_ok("已打开比较页");
        dto.method = Some("compare-url".into());
        dto.url = Some(url);
        return Ok(dto);
    }
    Ok(op_err("not_github", "无法构造比较链接"))
}

fn pull_at(cwd: &str) -> Result<CodingOpDto, String> {
    match remote_op(cwd, &["pull", "--ff-only"]) {
        Ok(msg) => Ok(op_ok(if msg.trim().is_empty() {
            "已拉取".into()
        } else {
            msg
        })),
        Err(e) => {
            let low = e.to_lowercase();
            if low.contains("not possible to fast-forward")
                || low.contains("diverged")
                || low.contains("cannot fast-forward")
                || low.contains("refusing to merge unrelated")
            {
                Ok(op_err(
                    "ff_only",
                    "无法快进拉取。进入终端，在改动面板处理后再试。",
                ))
            } else {
                Ok(op_err("git_failed", e))
            }
        }
    }
}

#[tauri::command]
pub async fn coding_overview(repo_path: String) -> Result<CodingOverviewDto, String> {
    tauri::async_runtime::spawn_blocking(move || overview_at(&expand(&repo_path)))
        .await
        .map_err(|e| format!("读取编程状态失败: {e}"))?
}

#[tauri::command]
pub async fn coding_create_worktree(
    repo_path: String,
    branch: String,
    source: Option<CreateWorktreeSource>,
) -> Result<CodingOpDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_with_source(
            &expand(&repo_path),
            &branch,
            source.unwrap_or(CreateWorktreeSource::FromBase),
        )
    })
    .await
    .map_err(|e| format!("创建工作树失败: {e}"))?
}

#[tauri::command]
pub async fn coding_remove_worktree(
    manager: tauri::State<'_, crate::pty::PtyManager>,
    repo_path: String,
    worktree_path: String,
    delete_branch: bool,
    force: bool,
) -> Result<(), String> {
    if !manager.active_workspace_tasks(&worktree_path).is_empty() {
        return Err("工作树中仍有任务运行，请先停止后再删除".into());
    }
    if crate::runs::has_active_run_in(&worktree_path)? {
        return Err("工作树中仍有活跃运行，请先停止后再删除".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let repo = expand(&repo_path);
        if force {
            force_remove_at(&repo, &worktree_path, delete_branch)
        } else {
            remove_at(&repo, &worktree_path, delete_branch)
        }
    })
    .await
    .map_err(|e| format!("删除工作树失败: {e}"))?
}

#[tauri::command]
pub async fn coding_fetch(cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || remote_op(&cwd, &["fetch", "--all", "--prune"]))
        .await
        .map_err(|e| format!("fetch 失败: {e}"))?
}

#[tauri::command]
pub async fn coding_pull(cwd: String) -> Result<CodingOpDto, String> {
    tauri::async_runtime::spawn_blocking(move || pull_at(&cwd))
        .await
        .map_err(|e| format!("拉取失败: {e}"))?
}

#[tauri::command]
pub async fn coding_push(cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = expand(&cwd);
        if !is_git_repo(&path) {
            return Err("不是 git 仓库".into());
        }
        match git_long(&path, &["push"]) {
            Ok(text) => Ok(text),
            Err(text) => {
                let lower = text.to_lowercase();
                if lower.contains("no upstream") || lower.contains("set-upstream") {
                    let branch = git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
                        .unwrap_or_else(|_| "HEAD".into());
                    git_long(&path, &["push", "-u", "origin", branch.trim()])
                } else {
                    Err(text)
                }
            }
        }
    })
    .await
    .map_err(|e| format!("推送失败: {e}"))?
}

#[tauri::command]
pub async fn coding_merge_into_base(
    repo_path: String,
    branch: String,
    expect_reviewed_sha: Option<String>,
) -> Result<CodingMergeDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        merge_at(&expand(&repo_path), &branch, expect_reviewed_sha.as_deref())
    })
    .await
    .map_err(|e| format!("合并失败: {e}"))?
}

#[tauri::command]
pub async fn coding_delete_branch(
    repo_path: String,
    branch: String,
    force: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        delete_branch_at(&expand(&repo_path), &branch, force)
    })
    .await
    .map_err(|e| format!("删除分支失败: {e}"))?
}

#[tauri::command]
pub async fn git_is_repo(path: String) -> Result<bool, String> {
    Ok(is_git_repo(&expand(&path)))
}

#[tauri::command]
pub async fn coding_add_origin(repo_path: String, url: String) -> Result<CodingOpDto, String> {
    tauri::async_runtime::spawn_blocking(move || add_origin_at(&expand(&repo_path), &url))
        .await
        .map_err(|e| format!("添加远程失败: {e}"))?
}

#[tauri::command]
pub async fn coding_open_desktop(repo_path: String, path: String) -> Result<CodingOpDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_desktop_at(&expand(&repo_path), &expand(&path))
    })
    .await
    .map_err(|e| format!("打开 GitHub Desktop 失败: {e}"))?
}

#[tauri::command]
pub async fn coding_open_pr(repo_path: String, cwd: String) -> Result<CodingOpDto, String> {
    tauri::async_runtime::spawn_blocking(move || open_pr_at(&repo_path, &cwd))
        .await
        .map_err(|e| format!("打开 Pull Request 失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git_bin() -> Option<PathBuf> {
        crate::agents::resolve_binary("git")
    }

    fn git_ok(dir: &Path, args: &[&str]) {
        let git = git_bin().expect("git");
        let st = Command::new(git)
            .current_dir(dir)
            .args(["-c", "user.email=t@t.dev", "-c", "user.name=t"])
            .args(args)
            .status()
            .unwrap();
        assert!(st.success(), "{args:?}");
    }

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ccode-coding-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn repo_path_resolves_without_lane_row_via_git() {
        // C1：建树不写 coding_lanes 行（分组是可选装饰），repo_path_for_worktree
        // 走 git --git-common-dir 事实源兜底能解出主仓——不再让 validate_policy 拦路。
        let Some(git) = git_bin() else { return };
        let root = tmp("repo-path-git");
        let repo = root.join("repo");
        let wt = root.join("wt");
        fs::create_dir_all(&repo).unwrap();
        git_ok(&repo, &["init", "-q", "-b", "main"]);
        fs::write(repo.join("a.txt"), "x").unwrap();
        git_ok(&repo, &["add", "."]);
        git_ok(&repo, &["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
        let st = Command::new(&git)
            .current_dir(&repo)
            .args(["worktree", "add", "-q", "-b", "feat/x", wt.to_str().unwrap()])
            .status()
            .unwrap();
        assert!(st.success(), "建工作树失败");
        let resolved = repo_path_for_worktree(wt.to_str().unwrap());
        let repo_canon = repo.canonicalize().unwrap().to_string_lossy().into_owned();
        let hit = resolved
            .as_deref()
            .and_then(|p| Path::new(p).canonicalize().ok())
            .map(|p| p.to_string_lossy().into_owned())
            .or_else(|| resolved.clone());
        assert!(
            crate::paths::same_path(hit.as_deref().unwrap_or(""), repo_canon.as_str()),
            "git 兜底应解出主仓：resolved={resolved:?} expect={repo_canon:?}"
        );
        // C2：attribution 连分支名一起回（会话归并的 workspace 列）
        let attr = attribution_for_worktree(wt.to_str().unwrap());
        assert_eq!(attr.as_ref().map(|(_, b)| b.as_str()), Some("feat/x"));
        // lanes 表行优先于 git 兜底（覆盖层语义）
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_git_remote_url_mirrors_ts_table() {
        let gh = parse_git_remote_url("https://github.com/org/repo.git").unwrap();
        assert_eq!(gh.host_kind, "github");
        assert_eq!(gh.display, "github.com/org/repo");
        assert!(!gh.has_userinfo);
        let scp = parse_git_remote_url("git@github.com:org/repo.git").unwrap();
        assert_eq!(scp.host_kind, "github");
        let ssh_alt = parse_git_remote_url("git@ssh.github.com:org/repo.git").unwrap();
        assert_eq!(ssh_alt.host_kind, "github");
        assert_eq!(ssh_alt.owner_repo, "org/repo");
        let gl = parse_git_remote_url("https://gitlab.com/group/sub/repo.git").unwrap();
        assert_eq!(gl.host_kind, "other");
        assert_eq!(gl.owner_repo, "group/sub/repo");
        let tok = parse_git_remote_url("https://user:token@github.com/org/repo.git").unwrap();
        assert!(tok.has_userinfo);
        assert_eq!(tok.url_stripped, "https://github.com/org/repo.git");
        assert!(parse_git_remote_url("file:///tmp/repo").is_none());
        assert!(parse_git_remote_url("git://github.com/org/repo").is_none());
        assert!(parse_git_remote_url("ssh://-oProxyCommand=evil/x").is_none());
        assert!(parse_git_remote_url("https://github.com/onlyone").is_none());
        let phish = parse_git_remote_url("https://github.com.evil.com/org/repo").unwrap();
        assert_eq!(phish.host_kind, "other");
        let www = parse_git_remote_url("https://www.github.com/org/repo").unwrap();
        assert_eq!(www.host_kind, "other");
        assert_eq!(
            github_compare_url("org/repo", "main", "feature/login"),
            "https://github.com/org/repo/compare/main...feature/login"
        );
        assert_eq!(
            github_compare_url("org/repo", "main", "a#b"),
            "https://github.com/org/repo/compare/main...a%23b"
        );
    }

    #[test]
    fn parse_worktree_list_primary_and_feature() {
        let text = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/login\nHEAD def\nbranch refs/heads/feature/login\n";
        let rows = parse_worktree_list(text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].branch, "main");
        assert_eq!(rows[0].head, "abc");
        assert_eq!(rows[1].branch, "feature/login");
        assert_eq!(rows[1].head, "def");
        assert!(!rows[1].detached);
    }

    #[test]
    fn branch_dir_rel_splits_and_sanitizes() {
        assert_eq!(
            branch_dir_rel("feature/login").unwrap(),
            PathBuf::from("feature").join("login")
        );
        assert!(branch_dir_rel("   ").is_err());
    }

    #[test]
    fn desktop_cli_in_app_bundle_is_github_sh() {
        let sh = PathBuf::from("/Applications/GitHub Desktop.app")
            .join("Contents")
            .join("Resources")
            .join("app")
            .join("static")
            .join("github.sh");
        assert!(sh.ends_with("github.sh"));
        #[cfg(target_os = "macos")]
        {
            if macos_desktop_app().is_some() {
                let bin = desktop_cli_bin().expect("bundled github.sh");
                assert!(bin.ends_with("github.sh") || bin.ends_with("github"));
            }
        }
    }

    #[test]
    fn overview_and_create_worktree() {
        let Some(_) = git_bin() else {
            return;
        };
        let dir = tmp("ov");
        let repo = dir.join("repo");
        fs::create_dir_all(&repo).unwrap();
        git_ok(&repo, &["init", "-b", "main"]);
        git_ok(&repo, &["config", "user.email", "t@t.dev"]);
        git_ok(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        git_ok(&repo, &["add", "."]);
        git_ok(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        TEST_WT_ROOT.with(|c| *c.borrow_mut() = Some(dir.join("wts")));
        let ov = overview_at(&repo).unwrap();
        assert!(ov.is_repo);
        assert_eq!(ov.base_branch, "main");
        assert_eq!(ov.worktrees.len(), 1);
        assert!(ov.worktrees[0].is_primary);
        assert!(ov.branches.iter().any(|b| b.name == "main" && b.is_base));

        let wt = create_at(&repo, "feature/login").unwrap();
        assert_eq!(wt.branch, "feature/login");
        assert!(!wt.is_primary);
        assert!(Path::new(&wt.path).is_dir());
        let task = Path::new(&wt.path).join("TASK.md");
        assert!(task.is_file());
        let task_text = fs::read_to_string(&task).unwrap();
        assert!(task_text.contains("feature/login"));
        assert!(task_text.contains("main"));
        let ov2 = overview_at(&repo).unwrap();
        assert!(ov2.worktrees.iter().any(|w| w.branch == "feature/login"));
        assert!(ov2.branches.iter().any(|b| b.name == "feature/login"));

        let again =
            create_with_source(&repo, "feature/login", CreateWorktreeSource::FromBase).unwrap();
        assert!(!again.ok, "{}", again.message);
        assert_eq!(again.code, "branch_exists");

        remove_at(&repo, &wt.path, false).unwrap();
        let again2 =
            create_with_source(&repo, "feature/login", CreateWorktreeSource::FromBase).unwrap();
        assert_eq!(again2.code, "branch_exists");

        let attached =
            create_with_source(&repo, "feature/login", CreateWorktreeSource::Local).unwrap();
        assert!(attached.ok, "{}", attached.message);
        let path = attached.worktree.as_ref().unwrap().path.clone();

        remove_at(&repo, &path, true).unwrap();
        let ov3 = overview_at(&repo).unwrap();
        assert!(!ov3.worktrees.iter().any(|w| w.branch == "feature/login"));
        TEST_WT_ROOT.with(|c| *c.borrow_mut() = None);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_branch_soft_refuses_unmerged_commits() {
        let Some(_) = git_bin() else {
            return;
        };
        let dir = tmp("delbr");
        let repo = dir.join("repo");
        fs::create_dir_all(&repo).unwrap();
        git_ok(&repo, &["init", "-b", "main"]);
        git_ok(&repo, &["config", "user.email", "t@t.dev"]);
        git_ok(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        git_ok(&repo, &["add", "."]);
        git_ok(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        git_ok(&repo, &["checkout", "-b", "feat"]);
        fs::write(repo.join("b.txt"), "b\n").unwrap();
        git_ok(&repo, &["add", "."]);
        git_ok(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "feat"],
        );
        git_ok(&repo, &["checkout", "main"]);
        let err = delete_branch_at(&repo, "feat", false).unwrap_err();
        assert!(err.contains("未合入"), "{err}");
        assert!(git(&repo, &["rev-parse", "--verify", "refs/heads/feat"]).is_ok());
        delete_branch_at(&repo, "feat", true).unwrap();
        assert!(git(&repo, &["rev-parse", "--verify", "refs/heads/feat"]).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn merge_bypasses_gpgsign() {
        let Some(_) = git_bin() else {
            return;
        };
        let dir = tmp("mgpg");
        let repo = dir.join("repo");
        fs::create_dir_all(&repo).unwrap();
        git_ok(&repo, &["init", "-b", "main"]);
        git_ok(&repo, &["config", "user.email", "t@t.dev"]);
        git_ok(&repo, &["config", "user.name", "t"]);
        git_ok(&repo, &["config", "commit.gpgsign", "true"]);
        git_ok(&repo, &["config", "gpg.program", "definitely-missing-gpg"]);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        git_ok(&repo, &["add", "."]);
        git_ok(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        git_ok(&repo, &["checkout", "-b", "feat"]);
        fs::write(repo.join("b.txt"), "b\n").unwrap();
        git_ok(&repo, &["add", "."]);
        git_ok(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "feat"],
        );
        git_ok(&repo, &["checkout", "main"]);
        let out = merge_at(
            &repo,
            "feat",
            Some(&git_long(&repo, &["rev-parse", "feat"]).unwrap()),
        )
        .unwrap();
        assert!(out.merged, "{}", out.message);
        assert!(!out.conflict);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn merge_records_the_base_worktree_head_not_the_project_checkout() {
        let Some(_) = git_bin() else { return };
        let dir = tmp("base-worktree");
        let repo = dir.join("repo");
        let base_tree = dir.join("base");
        fs::create_dir_all(&repo).unwrap();
        git_ok(&repo, &["init", "-b", "main"]);
        git_ok(&repo, &["config", "user.email", "t@t.dev"]);
        git_ok(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("a.txt"), "initial").unwrap();
        git_ok(&repo, &["add", "."]);
        git_ok(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        git_ok(&repo, &["checkout", "-b", "feat"]);
        fs::write(repo.join("feature.txt"), "feature").unwrap();
        git_ok(&repo, &["add", "."]);
        git_ok(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "feat"],
        );
        let tip = git_long(&repo, &["rev-parse", "HEAD"]).unwrap();
        git_ok(
            &repo,
            &["worktree", "add", base_tree.to_str().unwrap(), "main"],
        );
        fs::write(base_tree.join("base.txt"), "independent main work").unwrap();
        git_ok(&base_tree, &["add", "."]);
        git_ok(
            &base_tree,
            &["-c", "commit.gpgsign=false", "commit", "-m", "main work"],
        );
        let result = merge_at(&repo, "feat", Some(&tip)).unwrap();
        let accepted = git_long(&base_tree, &["rev-parse", "HEAD"]).unwrap();
        assert!(result.merged && result.ledger_written);
        assert_eq!(result.version_id.as_deref(), Some(accepted.as_str()));
        assert_ne!(accepted, tip);
        assert_eq!(
            git_long(&repo, &["rev-parse", "HEAD"]).unwrap(),
            tip,
            "不得移动项目根检出的分支"
        );
        fs::write(base_tree.join("later.txt"), "later").unwrap();
        git_ok(&base_tree, &["add", "."]);
        git_ok(
            &base_tree,
            &["-c", "commit.gpgsign=false", "commit", "-m", "later"],
        );
        let key = format!("coding-{}-feat", crate::projects::canonical_key(&repo));
        let fact = crate::projects::read_acceptance_log_at(&repo).remove(0);
        crate::review_contract::write_pending(&key, &fact).unwrap();
        assert!(overview_at(&repo)
            .unwrap()
            .worktrees
            .iter()
            .any(|w| w.branch == "feat" && w.ledger_pending));
        let replay = merge_at(&repo, "feat", None).unwrap();
        assert!(!overview_at(&repo)
            .unwrap()
            .worktrees
            .iter()
            .any(|w| w.ledger_pending));
        assert_eq!(replay.version_id, result.version_id);
        assert_eq!(crate::projects::read_acceptance_log_at(&repo).len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn merge_refuses_branch_touching_protected_paths() {
        let Some(_) = git_bin() else {
            return;
        };
        let dir = tmp("mprot");
        let repo = dir.join("repo");
        fs::create_dir_all(&repo).unwrap();
        git_ok(&repo, &["init", "-b", "main"]);
        git_ok(&repo, &["config", "user.email", "t@t.dev"]);
        git_ok(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        fs::create_dir_all(repo.join(".ccode")).unwrap();
        fs::write(
            repo.join(".ccode/project.toml"),
            "protected_paths = [\"data\"]\n",
        )
        .unwrap();
        git_ok(&repo, &["add", "."]);
        git_ok(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        git_ok(&repo, &["checkout", "-b", "feat"]);
        fs::create_dir_all(repo.join("data")).unwrap();
        fs::write(repo.join("data/x.csv"), "v2\n").unwrap();
        git_ok(&repo, &["add", "."]);
        git_ok(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "feat"],
        );
        git_ok(&repo, &["checkout", "main"]);
        // 分支动了保护路径：与科研验收合并同口径，拒绝并点名
        let err = merge_at(
            &repo,
            "feat",
            Some(&git_long(&repo, &["rev-parse", "feat"]).unwrap()),
        )
        .unwrap_err();
        assert!(err.contains("保护路径"), "{err}");
        assert!(err.contains("data/x.csv"), "{err}");
        assert!(!repo.join("data").exists(), "被拒绝的合并不得触碰主仓");
        // 撤掉保护设置后可合并（配置的改动本身先提交，否则基准工作树是脏的）
        fs::write(repo.join(".ccode/project.toml"), "protected_paths = []\n").unwrap();
        git_ok(&repo, &["add", "."]);
        git_ok(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "unprotect"],
        );
        let out = merge_at(
            &repo,
            "feat",
            Some(&git_long(&repo, &["rev-parse", "feat"]).unwrap()),
        )
        .unwrap();
        assert!(out.merged, "{}", out.message);
        fs::remove_dir_all(&dir).ok();
    }
}
