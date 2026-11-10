use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::process::Command;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

// ===== DTO =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResultDto {
    pub ok: bool,
    pub output_tail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDto {
    pub id: String,
    pub repo_path: String,
    pub repo_name: String,
    pub name: String,
    pub branch: String,
    pub worktree_path: String,
    pub base_branch: String,
    pub port_base: i64,
    pub status: String, // creating | active | archived
    pub created_at: String,
    pub archived_at: Option<String>,
    /// 已合并进基准分支的时间（仅「合并（保留工作区）」后置位；继续提交后前端按 ahead>0 隐藏）
    pub merged_at: Option<String>,
    /// 上游漂移提醒（启发式，非硬状态）：序号更小的上游步骤晚于本步「最后推进时间」
    /// 发生合并时，回填该上游步骤名（见 stale_upstream_for）；仅 list_workspaces 计算
    pub stale_upstream: Option<String>,
    /// 仅创建时填充：setup 脚本的执行结果（W2）；查询路径一律 None
    pub setup_result: Option<SetupResultDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMergeResultDto {
    pub merged: bool,
    pub archived: bool,
    pub failed_phase: Option<String>,
    pub message: String,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewed_sha: Option<String>,
    pub ledger_written: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub salvage: Option<SalvageReport>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SalvageReport {
    pub copied: Vec<String>,
    pub conflicts: Vec<String>,
    pub skipped_protected: Vec<String>,
    pub failed: Vec<String>,
}

impl SalvageReport {
    fn note(&self) -> String {
        if self.copied.is_empty()
            && self.skipped_protected.is_empty()
            && self.conflicts.is_empty()
            && self.failed.is_empty()
        {
            return String::new();
        }
        let mut note = format!(
            "已把工作区未进 git 的文献/数据/渲染成品拷到主文件夹（{} 个文件",
            self.copied.len()
        );
        if !self.skipped_protected.is_empty() {
            note.push_str(&format!(
                "，保护路径保持原样 {} 个",
                self.skipped_protected.len()
            ));
        }
        note.push('）');
        if !self.conflicts.is_empty() {
            let names = self
                .conflicts
                .iter()
                .take(5)
                .cloned()
                .collect::<Vec<_>>()
                .join("、");
            let suffix = if self.conflicts.len() > 5 {
                format!(" 等 {} 个", self.conflicts.len())
            } else {
                String::new()
            };
            note.push_str(&format!(
                "。{names}{suffix}在主文件夹已存在同名文件，未覆盖——请对比后手动决定保留哪份"
            ));
        }
        if !self.failed.is_empty() {
            note.push_str(&format!(
                "；未接收：{}（工作区保留）",
                self.failed.join("、")
            ));
        }
        note
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePrResultDto {
    pub pushed: bool,
    pub pr_created: bool,
    pub pr_url: Option<String>,
    pub failed_phase: Option<String>,
    pub message: String,
}

/// 无任何设置层定义 files_to_copy 时的回落清单（W1 固定值）
pub(crate) const FILES_TO_COPY: [&str; 4] =
    [".env", ".env.local", ".env.development.local", ".envrc"];

const PORT_LOW: i64 = 4000;
const PORT_HIGH: i64 = 4300; // 块起点上限，每块 10 个端口

// ===== 路径与 DB =====

fn workspaces_root() -> Result<PathBuf, String> {
    Ok(crate::ccode_home::current()?.join("workspaces"))
}

/// 定时雷达隔离 worktree 根（~/ccode/watch-worktrees/<项目>/<任务id>）：Mesa 自管的
/// 派生目录，里面的会话一律是无头自动活动，不得冒充「仓库候选 / 最近项目」。
pub(crate) fn watch_worktrees_root() -> Result<PathBuf, String> {
    Ok(crate::ccode_home::current()?.join("watch-worktrees"))
}

fn app_db_path() -> Result<PathBuf, String> {
    Ok(crate::dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("app.db"))
}

fn db_at(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("打开 app.db 失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置 app.db 等待时间失败: {e}"))?;
    ensure_workspaces_table(&conn)?;
    Ok(conn)
}

// 幂等建表：delete_workspaces_for_repo 可能拿到只建过 projects 表的连接（同一 app.db）
fn ensure_workspaces_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspaces(
          id TEXT PRIMARY KEY, repo_path TEXT, name TEXT, branch TEXT,
          worktree_path TEXT, base_branch TEXT, port_base INTEGER,
          status TEXT NOT NULL DEFAULT 'active', created_at TEXT, archived_at TEXT);",
    )
    .map_err(|e| format!("初始化 workspaces 表失败: {e}"))?;
    // 轻量迁移：老库补 merged_at 列（已存在则忽略错误）
    let _ = conn.execute_batch("ALTER TABLE workspaces ADD COLUMN merged_at TEXT;");
    let _ = conn.execute_batch("ALTER TABLE workspaces ADD COLUMN project_id TEXT;");
    let _ = conn.execute_batch(
        "UPDATE workspaces SET project_id=(SELECT id FROM projects WHERE projects.path=workspaces.repo_path) WHERE project_id IS NULL AND repo_path IS NOT NULL",
    );
    Ok(())
}

pub(crate) fn db() -> Result<Connection, String> {
    db_at(&app_db_path()?)
}

fn row_to_dto(
    id: String,
    repo_path: String,
    name: String,
    branch: String,
    worktree_path: String,
    base_branch: String,
    port_base: i64,
    status: String,
    created_at: String,
    archived_at: Option<String>,
    merged_at: Option<String>,
) -> WorkspaceDto {
    let repo_name = Path::new(&repo_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo_path.clone());
    WorkspaceDto {
        id,
        repo_path,
        repo_name,
        name,
        branch,
        worktree_path,
        base_branch,
        port_base,
        status,
        created_at,
        archived_at,
        merged_at,
        stale_upstream: None,
        setup_result: None,
        project_id: None,
    }
}

/// 上游漂移（纯逻辑，启发式提醒非硬状态）：步骤 k 的任一上游步骤（序号更小）晚于本步
/// 「最后一次并入」发生合并 → 返回最晚合并的上游步骤名，否则 None。
/// 最后一次并入（2026-11-06 流程贯通改，design-flow-weave.md §3）：工作区建立时间与 `followed`（工作区 id → 时间，
/// step_loop::followed_at：并入项目最新内容、开补料 / 跟进轮、人点跟进而没有要跟进的）里较晚的那个。
/// **本步自己保存（merged_at）不算并入**：没并入就保存，保存时间会把上游的新内容盖掉、待跟进从此不亮——
/// 这原是「只许保存后退回」的理由，改判定后步骤做到一半也能退回。
/// 时间戳均为 now_iso 定宽 UTC 串，字典序即时间序。
/// workspaces 需先按同仓库过滤；步骤-工作区绑定 = steps[].workspace_name 匹配工作区名。
pub(crate) fn stale_upstream_for(
    steps: &[crate::projects::StepDto],
    workspaces: &[WorkspaceDto],
    step_index: usize,
    followed: &std::collections::HashMap<String, String>,
) -> Option<String> {
    let step = steps.get(step_index)?;
    let target_ws = workspaces.iter().find(|w| w.name == step.workspace_name)?;
    let created = target_ws.created_at.as_str();
    let last_progress = match followed.get(&target_ws.id) {
        Some(at) if at.as_str() > created => at.as_str(),
        _ => created,
    };
    let mut best: Option<(&str, &str)> = None; // (merged_at, 步骤名)
    for step in &steps[..step_index] {
        let Some(upstream_ws) = workspaces.iter().find(|w| w.name == step.workspace_name) else {
            continue;
        };
        let Some(merged_at) = upstream_ws.merged_at.as_deref() else {
            continue;
        };
        if merged_at > last_progress && best.map_or(true, |(b, _)| merged_at > b) {
            best = Some((merged_at, step.name.as_str()));
        }
    }
    best.map(|(_, name)| name.to_string())
}

pub(crate) fn query_workspaces(conn: &Connection) -> Result<Vec<WorkspaceDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, repo_path, name, branch, worktree_path, base_branch,
                    port_base, status, created_at, archived_at, merged_at, project_id FROM workspaces",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let mut dto = row_to_dto(
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
            );
            dto.project_id = r.get(11).ok().flatten();
            Ok(dto)
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

pub(crate) fn get_workspace(conn: &Connection, id: &str) -> Result<WorkspaceDto, String> {
    query_workspaces(conn)?
        .into_iter()
        .find(|w| w.id == id)
        .ok_or_else(|| format!("工作区不存在: {id}"))
}

// ===== 会话归并用：worktree 前缀 → (真实仓库, 工作区名) =====

#[derive(Debug, Clone)]
pub(crate) struct WorktreeRow {
    pub id: String,
    pub worktree_path: String,
    pub repo_path: String,
    pub name: String,
    pub branch: String,
    pub base_branch: String,
}

pub(crate) fn worktree_rows() -> Vec<WorktreeRow> {
    if cfg!(test) {
        // 同 project_roots_and_resources：单测不读本机真实注册表（测试用各自 conn fixture）
        return Vec::new();
    }
    let Ok(conn) = db() else {
        return Vec::new();
    };
    query_workspaces(&conn)
        .unwrap_or_default()
        .into_iter()
        .map(|w| WorktreeRow {
            id: w.id,
            worktree_path: w.worktree_path,
            repo_path: w.repo_path,
            name: w.name,
            branch: w.branch,
            base_branch: w.base_branch,
        })
        .collect()
}

// ===== git 调用（参数数组 + 超时；输出走管道防阻塞） =====

pub(crate) fn run_git(repo: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let git = crate::agents::resolve_binary("git").ok_or("找不到 git 可执行文件，请先安装 git")?;
    let mut cmd = crate::process::background_command(git);
    cmd.arg("-C")
        .arg(repo)
        .args(["-c", "core.quotepath=false"])
        .args(crate::git_info::PLATFORM_GIT_CONFIG)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_cmd(cmd, timeout)
}

/// `git merge-base --is-ancestor {branch} HEAD`：0=已合入，1=尚未。其它退出码当错误。
pub(crate) fn git_is_ancestor(repo: &Path, branch: &str, head: &str) -> Result<bool, String> {
    let git = crate::agents::resolve_binary("git").ok_or("找不到 git 可执行文件，请先安装 git")?;
    let mut cmd = crate::process::background_command(git);
    cmd.arg("-C")
        .arg(repo)
        .args(crate::git_info::PLATFORM_GIT_CONFIG)
        .args(["merge-base", "--is-ancestor", branch, head])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = run_cmd_full(cmd, Duration::from_secs(10))?;
    if out.timed_out {
        return Err("操作超时".into());
    }
    match out.code {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    }
}

pub(crate) fn relocate_repo_paths(
    project_id: &str,
    old_path: &str,
    new_path: &str,
) -> Result<(), String> {
    let conn = db()?;
    conn.execute(
        "UPDATE workspaces SET repo_path=?3, project_id=?1 WHERE project_id=?1 OR repo_path=?2",
        params![project_id, old_path, new_path],
    )
    .map_err(|e| format!("更新工作区位置失败: {e}"))?;
    Ok(())
}

/// 子进程原始结果：conflict_probe 需要区分退出码 0/1，run_git_raw 需要未 trim 的 stdout
struct CmdOutput {
    success: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
}

/// 子进程的 stdout/stderr 各放线程读空（管道容量有限，不读会死锁），主线程轮询退出，超时则 kill
fn run_cmd_full(
    mut cmd: crate::process::BackgroundCommand,
    timeout: Duration,
) -> Result<CmdOutput, String> {
    let captured = crate::process::capture_command(&mut cmd, timeout, 32 * 1024 * 1024)?;
    if captured.cancelled {
        return Err("操作已取消".into());
    }
    if captured.truncated {
        return Err("命令输出超过 32 MB 安全上限，请缩小操作范围".into());
    }
    Ok(CmdOutput {
        success: !captured.timed_out && captured.status.is_some_and(|s| s.success()),
        code: captured.status.and_then(|s| s.code()),
        stdout: captured.stdout,
        stderr: captured.stderr,
        timed_out: captured.timed_out,
    })
}

/// 成功返回 trim 后 stdout，失败返回 trim 后 stderr
fn run_cmd(cmd: crate::process::BackgroundCommand, timeout: Duration) -> Result<String, String> {
    let out = run_cmd_full(cmd, timeout)?;
    if out.timed_out {
        return Err("操作超时".into());
    }
    if out.success {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
}

// ===== 核心逻辑（命令的同步实现，参数化 db/根目录便于测试） =====

/// 任务名收敛为分支/目录安全字符集
fn sanitize_name(name: &str) -> Result<String, String> {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('-').to_string();
    if cleaned.is_empty() {
        return Err("任务名清洗后为空，请换一个名字".into());
    }
    // 白名单只留 [A-Za-z0-9-]，非法字符已被换成 `-`，唯独**保留设备名整个活下来**
    //（CON/AUX/NUL/COM1-9/LPT1-9 全是 ASCII 字母数字）。实测 git worktree add 建
    // `refs/heads/ccode/CON.lock` 会 `Invalid argument` 失败，用户只看到
    // 「创建 worktree 失败；已回滚」完全无法自解释；macOS 上 CON 是合法名字。
    crate::paths::validate_fs_name(&cleaned).map_err(|e| format!("任务名不可用：{e}"))?;
    Ok(cleaned)
}

/// 取 4000-4300 间最低的空闲 10 端口块起点；活跃工作区少时自然等于 4000+10*n
/// 基准分支探测：origin/HEAD → origin/main|master → 本地 main|master → 当前分支
pub(crate) fn detect_base_branch(repo: &std::path::Path) -> String {
    const T: Duration = Duration::from_secs(10);
    if let Ok(s) = run_git(
        repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        T,
    ) {
        if let Some(b) = s.strip_prefix("origin/") {
            return b.to_string();
        }
    }
    for cand in ["origin/main", "origin/master", "main", "master"] {
        if run_git(repo, &["rev-parse", "--verify", "--quiet", cand], T).is_ok() {
            return cand.trim_start_matches("origin/").to_string();
        }
    }
    run_git(repo, &["rev-parse", "--abbrev-ref", "HEAD"], T).unwrap_or_else(|_| "main".into())
}

/// 空仓库（HEAD 为 unborn，尚无任何提交）没有可引用的基准分支，worktree add 必失败：
/// 先在 HEAD symbolic-ref 指向的分支上补一个空初始提交（分支名由 init.defaultBranch 决定，
/// 可能是 master，禁止硬编码），提交后继续走正常创建流程。
/// 身份优先沿用仓库/全局已配置的 user.name/user.email；未配置时仅本次提交用 -c 注入临时身份，
/// 不写入用户 git config。
pub(crate) fn ensure_initial_commit(repo: &Path) -> Result<bool, String> {
    const T: Duration = Duration::from_secs(30);
    // 已有任一提交则不是 unborn，直接返回（非空仓库零行为变化）
    if run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"], T).is_ok() {
        return Ok(false);
    }
    let ident = crate::git_info::commit_identity_args(repo);
    // 与 merge/sync_base 一致：应用内自动提交必须绕过用户全局 commit.gpgsign
    let mut args: Vec<&str> = vec!["-c", "commit.gpgsign=false"];
    args.extend(ident.iter().map(String::as_str));
    args.extend([
        "commit",
        "--allow-empty",
        "-m",
        "初始化空仓库（Mesa 自动创建）",
    ]);
    run_git(repo, &args, T).map_err(|e| format!("空仓库初始化提交失败: {e}"))?;
    Ok(true)
}

fn alloc_port_base(conn: &Connection) -> Result<i64, String> {
    let used: Vec<i64> = query_workspaces(conn)?
        .into_iter()
        .filter(|w| w.status == "active" || w.status == "creating")
        .map(|w| w.port_base)
        .collect();
    let mut candidate = PORT_LOW;
    while candidate <= PORT_HIGH {
        if !used.contains(&candidate) {
            return Ok(candidate);
        }
        candidate += 10;
    }
    Err("活跃工作区过多，端口段（4000-4300）已用尽".into())
}

fn validate_copy_paths(files: &[String]) -> Result<(), String> {
    for file in files {
        let path = Path::new(file);
        if file.trim().is_empty()
            || path.is_absolute()
            || path.components().any(|part| {
                matches!(
                    part,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err(format!("files_to_copy 只能使用仓库内相对路径: {file}"));
        }
    }
    Ok(())
}

/// files_to_copy 写入 worktree 前的目标安全检查：rel 必须是树内相对路径，且父链上
/// 已存在的目录与目标自身都不得是符号链接。工作区可被 agent 任意写入，仓库也可能
/// 跟踪指向树外的符号链接——fs::copy/create_dir_all 跟随符号链接会把文件写到树外。
fn ensure_copy_dest_safe(worktree: &Path, rel: &str) -> Result<(), String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(format!("复制目标必须是工作区内相对路径: {rel}"));
    }
    let mut cursor = worktree.to_path_buf();
    if let Some(parent_rel) = rel_path.parent() {
        for comp in parent_rel.components() {
            cursor.push(comp.as_os_str());
            match fs::symlink_metadata(&cursor) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(format!(
                        "复制目标路径经过符号链接 {}，为避免写出工作区已拒绝: {rel}",
                        cursor.display()
                    ));
                }
                Ok(_) => {}
                // 缺失的分量由后面 create_dir_all 补建，更深层级无需再查
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(e) => return Err(format!("检查复制目标路径失败: {e}")),
            }
        }
    }
    let dest = worktree.join(rel);
    if let Ok(meta) = fs::symlink_metadata(&dest) {
        if meta.file_type().is_symlink() {
            return Err(format!("复制目标是符号链接，为避免写出工作区已拒绝: {rel}"));
        }
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("复制 {rel} 前创建目录失败: {e}"))?;
    }
    Ok(())
}

/// files_to_copy 落到 worktree 的统一入口：先过 ensure_copy_dest_safe 再复制
fn safe_copy_into_worktree(worktree: &Path, rel: &str, src: &Path) -> Result<(), String> {
    ensure_copy_dest_safe(worktree, rel)?;
    fs::copy(src, worktree.join(rel))
        .map(|_| ())
        .map_err(|e| format!("复制文件 {rel} 失败: {e}"))
}

#[allow(clippy::too_many_arguments)]
fn reserve_creating_workspace(
    conn: &Connection,
    id: &str,
    repo: &Path,
    name: &str,
    branch: &str,
    worktree_path: &Path,
    base_branch: &str,
    created_at: &str,
) -> Result<i64, String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("锁定工作区端口分配失败: {e}"))?;
    let result = (|| {
        let port_base = alloc_port_base(conn)?;
        let project_id = crate::projects::project_id_at(repo);
        conn.execute(
            "INSERT INTO workspaces(id, repo_path, name, branch, worktree_path, base_branch,
                                    port_base, status, created_at, project_id)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'creating', ?8, ?9)",
            params![
                id,
                repo.to_string_lossy().as_ref(),
                name,
                branch,
                worktree_path.to_string_lossy().as_ref(),
                base_branch,
                port_base,
                created_at,
                project_id,
            ],
        )
        .map_err(|e| format!("记录创建中工作区失败: {e}"))?;
        Ok(port_base)
    })();
    match result {
        Ok(port_base) => {
            if let Err(e) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                Err(format!("提交工作区端口预留失败: {e}"))
            } else {
                Ok(port_base)
            }
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

fn rollback_creating_workspace(
    conn: &Connection,
    repo: &Path,
    worktree_path: &Path,
    branch: &str,
    id: &str,
) -> Vec<String> {
    let mut issues = Vec::new();
    if worktree_path.exists() {
        // --force 例外理由（对照归档禁用 --force 的约定）：这个 worktree 是应用秒前自建的，
        // 里面只可能有 git 刚检出 + 本进程刚复制的未跟踪 files_to_copy 文件，不存在用户劳动成果
        if let Err(e) = run_git(
            repo,
            &[
                "worktree",
                "remove",
                "--force",
                &worktree_path.to_string_lossy(),
            ],
            Duration::from_secs(60),
        ) {
            if let Err(remove_error) = fs::remove_dir_all(worktree_path) {
                issues.push(format!(
                    "移除创建中的 worktree 失败: {e}；删除目录也失败: {remove_error}"
                ));
            }
        }
    }
    if let Err(e) = run_git(repo, &["worktree", "prune"], Duration::from_secs(30)) {
        issues.push(format!("清理 worktree 元数据失败: {e}"));
    }
    if run_git(
        repo,
        &["rev-parse", "--verify", "--quiet", branch],
        Duration::from_secs(10),
    )
    .is_ok()
    {
        if let Err(e) = run_git(repo, &["branch", "-D", branch], Duration::from_secs(30)) {
            issues.push(format!("删除创建中的分支 {branch} 失败: {e}"));
        }
    }
    if let Err(e) = conn.execute("DELETE FROM workspaces WHERE id=?1", params![id]) {
        issues.push(format!("释放创建中记录和端口失败: {e}"));
    }
    issues
}

fn create_impl(
    conn: &Connection,
    ws_root: &Path,
    repo_path: &str,
    name: &str,
) -> Result<WorkspaceDto, String> {
    create_impl_with_copy(conn, ws_root, repo_path, name, |src, dest| {
        fs::copy(src, dest).map(|_| ())
    })
}

/// 分支撞名不能拿「请换一个任务名」把人堵死：步骤工作区名是固定的，
/// 重跑同一步是常态。三种情况分开处置（2026-10-13）：
/// ① 活动工作区占着——指路：继续它，或删除后再开新轮；
/// ② 已归档且已合并、分支尖已进基准分支——旧轮产物已在主仓，分支只是恢复用的冗余，让位给新轮；
///    恢复后又有没保存的提交则拒绝（2026-11-05）；
/// ③ 没有任何行引用的悬空 ccode/* 分支——创建失败等半路留下的残留，清掉继续。
fn ensure_branch_free(
    conn: &Connection,
    repo: &Path,
    branch: &str,
    name: &str,
) -> Result<(), String> {
    if run_git(repo, &["rev-parse", "--verify", "--quiet", branch], Duration::from_secs(10))
        .is_err()
    {
        return Ok(());
    }
    let owner = query_workspaces(conn)
        .ok()
        .and_then(|all| {
            all.into_iter().find(|w| {
                w.branch == branch
                    && fs::canonicalize(&w.repo_path)
                        .unwrap_or_else(|_| PathBuf::from(&w.repo_path))
                        == fs::canonicalize(repo).unwrap_or_else(|_| repo.to_path_buf())
            })
        });
    match owner {
        Some(w) if w.status != "archived" => Err(format!(
            "工作区 {name} 已存在且未合并：在工作台继续它跑完，或不需要这一轮就删除工作区后再开"
        )),
        Some(w) if w.merged_at.is_some() => {
            // 恢复过的轮次保留 merged_at，恢复后又提交、没保存就归档的，分支上有主仓没有的提交：
            // 只有分支尖已进基准分支才让位，否则删分支会丢那一轮的活
            if !git_is_ancestor(repo, branch, &w.base_branch)? {
                return Err(format!(
                    "上一轮工作区 {name} 已归档，但那一轮有没保存进项目的提交：先在工作台恢复它、保存或删除后再开新一轮"
                ));
            }
            run_git(repo, &["branch", "-D", branch], Duration::from_secs(30))?;
            conn.execute("DELETE FROM workspaces WHERE id=?1", params![w.id])
                .map_err(|e| e.to_string())?;
            crate::logbuf::record(
                "info",
                "workspaces",
                &format!("{branch} 旧轮已合并归档，让位给新一轮（已清旧行与分支）"),
            );
            Ok(())
        }
        Some(_) => Err(format!(
            "工作区 {name} 已归档但那一轮没合并：恢复它继续，或删除工作区后再开"
        )),
        None => {
            run_git(repo, &["branch", "-D", branch], Duration::from_secs(30))?;
            crate::logbuf::record(
                "info",
                "workspaces",
                &format!("清理无工作区引用的残留分支 {branch}"),
            );
            Ok(())
        }
    }
}

fn create_impl_with_copy<F>(
    conn: &Connection,
    ws_root: &Path,
    repo_path: &str,
    name: &str,
    mut copy_file: F,
) -> Result<WorkspaceDto, String>
where
    F: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    let name = sanitize_name(name)?;
    let repo = PathBuf::from(crate::sessions::expand_tilde(repo_path));
    // 落库/分支检测/worktree 路径派生统一用 canonical 路径（与 register_project 的
    // canonical_key 同口径）：前端按 repoPath 字符串把工作组归进项目分组，symlink
    // 拼写不一致（macOS /var→/private/var 等）会让工作区掉出分组。canonicalize 失败
    // （目录不存在）保留原路径——后续 rev-parse 仍报「不是 git 仓库」，错误体验不变。
    let repo = PathBuf::from(crate::projects::canonical_key(&repo));
    run_git(&repo, &["rev-parse", "--git-dir"], Duration::from_secs(10))
        .map_err(|e| format!("不是 git 仓库: {repo_path} ({e})"))?;
    let branch = format!("ccode/{name}");
    ensure_branch_free(conn, &repo, &branch, &name)?;
    // 空仓库（unborn HEAD）先补初始提交：放在端口预留/事务之前，失败无需回滚，
    // 错误直接透出；成功后 detect_base_branch 才能解析到真实基准分支
    ensure_initial_commit(&repo)?;
    // 基准分支：origin/HEAD → main/master 候选 → 当前分支
    let base_branch = detect_base_branch(&repo);
    // 起点固定用本地基准分支：工作区应镜像「本地项目现状」，
    // 含未推送的提交——用 origin/<base> 会把本地未推送的工作丢掉（实测踩坑）
    let start_point = base_branch.clone();
    let repo_name = repo
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into());
    let worktree_path = ws_root.join(&repo_name).join(&name);
    if worktree_path.exists() {
        return Err(format!("worktree 路径已存在: {}", worktree_path.display()));
    }
    if let Some(parent) = worktree_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建工作区目录失败: {e}"))?;
    }
    // 项目级配置（三层合并）：files_to_copy 并集；没有设置层时用 W1 固定清单
    let settings = crate::ws_settings::merged_settings(&repo);
    let files = settings
        .files_to_copy
        .clone()
        .unwrap_or_else(|| FILES_TO_COPY.iter().map(|s| s.to_string()).collect());
    validate_copy_paths(&files)?;
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = crate::sessions::now_iso();
    let port_base = reserve_creating_workspace(
        conn,
        &id,
        &repo,
        &name,
        &branch,
        &worktree_path,
        &base_branch,
        &created_at,
    )?;
    let create_result: Result<WorkspaceDto, String> = (|| {
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                &worktree_path.to_string_lossy(),
                "-b",
                &branch,
                &start_point,
            ],
            Duration::from_secs(60),
        )
        .map_err(|e| format!("创建 worktree 失败: {e}"))?;
        for file in &files {
            let src = repo.join(file);
            if !src.is_file() {
                continue;
            }
            // 安全检查在注入的复制函数之外：防 dest/父链符号链接穿透对三处复制点统一生效
            ensure_copy_dest_safe(&worktree_path, file)?;
            copy_file(&src, &worktree_path.join(file))
                .map_err(|e| format!("复制配置文件 {file} 失败: {e}"))?;
        }
        // setup 脚本失败不阻断创建，结果记进 DTO 给 UI 展示
        let setup_result = settings.setup.as_ref().map(|script| {
            let (ok, output_tail) =
                run_hook(&worktree_path, script, port_base, Duration::from_secs(600));
            SetupResultDto { ok, output_tail }
        });
        let changed = conn
            .execute(
                "UPDATE workspaces SET status='active' WHERE id=?1 AND status='creating'",
                params![id],
            )
            .map_err(|e| format!("激活工作区记录失败: {e}"))?;
        if changed != 1 {
            return Err("激活工作区记录失败：创建中记录已丢失".into());
        }
        let mut dto = get_workspace(conn, &id)?;
        dto.setup_result = setup_result;
        Ok(dto)
    })();
    let dto = match create_result {
        Ok(dto) => dto,
        Err(e) => {
            let rollback_issues =
                rollback_creating_workspace(conn, &repo, &worktree_path, &branch, &id);
            if rollback_issues.is_empty() {
                return Err(format!("{e}；已回滚创建中的工作区"));
            }
            return Err(format!(
                "{e}；自动回滚未完全成功：{}",
                rollback_issues.join("；")
            ));
        }
    };
    // 新工作区会改变 list_repos 的聚合结果（worktree 路径需被排除），主动失效
    invalidate_repo_cache();
    Ok(dto)
}

// 生产路径一律走带 guard 的变体（归档前复查运行中任务）；本包装仅供测试免传 guard
#[cfg(test)]
fn archive_impl(conn: &Connection, id: &str) -> Result<(), String> {
    archive_impl_with_guard(conn, id, &|_| Ok(()))
}

/// ensure_no_active_tasks：紧邻 worktree remove 前复查工作区内是否仍有运行中的
/// agent/run 脚本（命令层的预检与移除之间隔着脚本钩子，TOCTOU 窗口必须在这里再关一次）
fn archive_impl_with_guard(
    conn: &Connection,
    id: &str,
    ensure_no_active_tasks: &dyn Fn(&str) -> Result<(), String>,
) -> Result<(), String> {
    if read_delivery_pending(id)?.is_some() || crate::review_contract::pending_needs_attention(id) {
        return Err("工作区还有未完成的产物接收或验收记录，请先继续原操作再归档".into());
    }
    let w = get_workspace(conn, id)?;
    let wt = PathBuf::from(&w.worktree_path);
    let settings = crate::ws_settings::merged_settings(Path::new(&w.repo_path));
    let copied_files = settings
        .files_to_copy
        .clone()
        .unwrap_or_else(|| FILES_TO_COPY.iter().map(|s| s.to_string()).collect());
    if wt.exists() {
        let merge_state = unmerged_impl(&wt)?;
        if merge_state.merging || !merge_state.files.is_empty() {
            return Err("工作区存在未完成的合并或冲突，请先完成或中止冲突处理后再归档".into());
        }
        let dirty = run_git(&wt, &["status", "--porcelain"], Duration::from_secs(30))?;
        let mut removable_copies = Vec::new();
        let unsafe_lines: Vec<&str> = dirty
            .lines()
            .filter(|line| {
                let path = line.get(3..).unwrap_or(line).trim();
                let is_unchanged_copy = copied_files.iter().any(|f| f == path)
                    && fs::read(Path::new(&w.repo_path).join(path)).ok()
                        == fs::read(wt.join(path)).ok();
                if is_unchanged_copy {
                    removable_copies.push(path.to_string());
                }
                !is_unchanged_copy
            })
            .collect();
        if !unsafe_lines.is_empty() {
            return Err("工作区有未提交改动，已拒绝归档；请使用“提交并归档”保留改动".into());
        }
        // archive 脚本在移除前跑（如 docker compose down）；失败则保留 worktree 并报错给 UI
        if let Some(script) = &settings.archive {
            let (ok, tail) = run_hook(&wt, script, w.port_base, Duration::from_secs(300));
            if !ok {
                return Err(format!("archive 脚本执行失败，worktree 未移除:\n{tail}"));
            }
        }
        // Git 会允许删除只含 ignored 文件的工作树，归档前还须确认这些成果已有项目副本。
        assert_deliverables_retained(&w, Path::new(&w.repo_path))?;
        // 钩子可能跑了很久，期间用户可能又在工作区启动了任务；移除前必须再确认无人占用
        ensure_no_active_tasks(&w.worktree_path)?;
        // files-to-copy 若与主仓库原件完全一致，可安全移除后用非 --force 归档；修改过的副本已被上面拦截。
        for path in &removable_copies {
            fs::remove_file(wt.join(path))
                .map_err(|e| format!("清理可恢复副本 {path} 失败: {e}"))?;
        }
        if let Err(e) = run_git(
            Path::new(&w.repo_path),
            &["worktree", "remove", &w.worktree_path],
            Duration::from_secs(60),
        ) {
            // 回写先前删除的可恢复副本；回写失败必须并入错误信息，不能静默吞掉
            let mut restore_errors = Vec::new();
            for path in &removable_copies {
                let src = Path::new(&w.repo_path).join(path);
                if let Err(re) = safe_copy_into_worktree(&wt, path, &src) {
                    restore_errors.push(re);
                }
            }
            return Err(if restore_errors.is_empty() {
                format!("移除 worktree 失败，工作区已保留: {e}")
            } else {
                format!(
                    "移除 worktree 失败，工作区已保留: {e}；回写副本失败: {}",
                    restore_errors.join("；")
                )
            });
        }
    }
    // worktree 目录已不存在时跳过 git 调用直接翻状态
    if let Err(e) = conn.execute(
        "UPDATE workspaces SET status='archived', archived_at=?2 WHERE id=?1",
        params![id, crate::sessions::now_iso()],
    ) {
        if !wt.exists() {
            let restored = run_git(
                Path::new(&w.repo_path),
                &["worktree", "add", &w.worktree_path, &w.branch],
                Duration::from_secs(60),
            );
            return Err(match restored {
                Ok(_) => {
                    let mut copy_errors = Vec::new();
                    for path in &copied_files {
                        let src = Path::new(&w.repo_path).join(path);
                        if src.is_file() && !wt.join(path).exists() {
                            if let Err(ce) = safe_copy_into_worktree(&wt, path, &src) {
                                copy_errors.push(ce);
                            }
                        }
                    }
                    if copy_errors.is_empty() {
                        format!("归档状态写入失败，已恢复工作树，未丢失内容: {e}")
                    } else {
                        format!(
                            "归档状态写入失败，已恢复工作树: {e}；回写副本失败: {}",
                            copy_errors.join("；")
                        )
                    }
                }
                Err(restore_err) => format!(
                    "工作树已移除，但归档状态写入失败；分支仍保留，请手动恢复工作树: {e}; {restore_err}"
                ),
            });
        }
        return Err(format!("更新 workspaces 失败: {e}"));
    }
    // 归档成功即流程收尾：回放期间暂缓的 PDF 资源登记（幂等 best-effort）
    crate::lit_watch::replay_pending_registrations(Path::new(&w.repo_path));
    Ok(())
}

fn restore_impl(conn: &Connection, id: &str) -> Result<(), String> {
    let w = get_workspace(conn, id)?;
    if !Path::new(&w.worktree_path).exists() {
        // 归档只移除 worktree 不删分支，恢复 = 从分支重新 worktree add
        run_git(
            Path::new(&w.repo_path),
            &["worktree", "add", &w.worktree_path, &w.branch],
            Duration::from_secs(60),
        )
        .map_err(|e| format!("恢复 worktree 失败: {e}"))?;
        let settings = crate::ws_settings::merged_settings(Path::new(&w.repo_path));
        let files = settings
            .files_to_copy
            .unwrap_or_else(|| FILES_TO_COPY.iter().map(|s| s.to_string()).collect());
        for path in files {
            let src = Path::new(&w.repo_path).join(&path);
            let dst = Path::new(&w.worktree_path).join(&path);
            if src.is_file() && !dst.exists() {
                safe_copy_into_worktree(Path::new(&w.worktree_path), &path, &src)
                    .map_err(|e| format!("恢复复制文件失败: {e}"))?;
            }
        }
    }
    // 不清 merged_at（2026-11-05）：恢复工作副本不等于撤销保存——原先清掉后，保存过的步骤一恢复就成了
    // 没有 AI 在跑的「进行中」、还冒出没东西可审的「去评审」；有没有新的待保存改动由 ahead / 未提交改动判断
    conn.execute(
        "UPDATE workspaces SET status='active', archived_at=NULL WHERE id=?1",
        params![id],
    )
    .map_err(|e| format!("更新 workspaces 失败: {e}"))?;
    Ok(())
}

fn delete_impl(conn: &Connection, id: &str) -> Result<(), String> {
    let w = get_workspace(conn, id)?;
    if Path::new(&w.worktree_path).exists() {
        // Windows：终端占着目录时 --force 也只能删掉一半，先拦（其它平台恒放行）
        crate::pty::ensure_workspace_free_global(&w.worktree_path, "删除")?;
        run_git(
            Path::new(&w.repo_path),
            &["worktree", "remove", "--force", &w.worktree_path],
            Duration::from_secs(60),
        )
        .map_err(|e| format!("移除 worktree 失败: {e}"))?;
    }
    // 分支可能已被用户手动删掉，不存在不算错误
    if run_git(
        Path::new(&w.repo_path),
        &["rev-parse", "--verify", "--quiet", &w.branch],
        Duration::from_secs(10),
    )
    .is_ok()
    {
        run_git(
            Path::new(&w.repo_path),
            &["branch", "-D", &w.branch],
            Duration::from_secs(30),
        )
        .map_err(|e| format!("删除分支失败: {e}"))?;
    }
    conn.execute("DELETE FROM workspaces WHERE id=?1", params![id])
        .map_err(|e| format!("删除 workspaces 行失败: {e}"))?;
    Ok(())
}

/// 该项目是否还有**未落地**的工作区（active/creating 且尚未合并——merged_at 为空）。
/// 雷达「登记暂缓」与「台账迁移」的相位判据：只有这种轮次还可能向基准合并，
/// 迁移动跟踪关系、project.toml 写入拦合并才需要避让。「已合并保留」（merged_at 置位）
/// 的轮次产物已进主仓，不算进行中——否则合并完没归档的旧项目永远迁不了（2026-10-13 实证）。
/// 不新增状态文件——workspaces 表的 status + merged_at 就是唯一事实。
/// 例外：恢复过的轮次保留 merged_at，恢复后又提交（分支领先基准）就又是进行中（2026-11-05）。
pub(crate) fn project_has_active_workspace(repo: &Path) -> bool {
    let Ok(conn) = db() else {
        return false;
    };
    has_unlanded_workspace(&conn, repo)
}

fn has_unlanded_workspace(conn: &Connection, repo: &Path) -> bool {
    workspaces_of_repo(conn, repo)
        .map(|list| {
            list.iter().any(|w| {
                (w.status == "active" || w.status == "creating")
                    && (w.merged_at.is_none()
                        // git 出错按已落地算，保持原口径，不让一条坏分支永远挡住迁移
                        || !git_is_ancestor(repo, &w.branch, &w.base_branch).unwrap_or(true))
            })
        })
        .unwrap_or(false)
}

/// 某仓库的全部工作区（active/archived 不分状态）。
/// repo_path 落库时可能非 canonical 写法，按 canonical 路径比对。
pub(crate) fn workspaces_of_repo(
    conn: &Connection,
    repo: &Path,
) -> Result<Vec<WorkspaceDto>, String> {
    ensure_workspaces_table(conn)?;
    let key = fs::canonicalize(repo).unwrap_or_else(|_| repo.to_path_buf());
    Ok(query_workspaces(conn)?
        .into_iter()
        .filter(|w| {
            fs::canonicalize(&w.repo_path).unwrap_or_else(|_| PathBuf::from(&w.repo_path)) == key
        })
        .collect())
}

/// 删除某仓库的全部工作区，返回已删工作区名清单。
/// 供 projects::delete_project_dir 彻底删除项目目录用：属删除语义，允许 force 移除
/// worktree；任一失败即中止（已删的不回滚），错误信息里说明已删哪些。
pub(crate) fn delete_workspaces_for_repo(
    conn: &Connection,
    repo: &Path,
) -> Result<Vec<String>, String> {
    let targets = workspaces_of_repo(conn, repo)?;
    let mut deleted: Vec<String> = Vec::new();
    for w in &targets {
        if let Err(e) = delete_impl(conn, &w.id) {
            let done = if deleted.is_empty() {
                "尚无工作区被删除".to_string()
            } else {
                format!("已删除的工作区：{}", deleted.join("、"))
            };
            return Err(format!("删除工作区「{}」失败: {e}；{done}", w.name));
        }
        deleted.push(w.name.clone());
    }
    Ok(deleted)
}

fn port_env(port_base: i64) -> Vec<(String, String)> {
    (0..10)
        .map(|i| {
            let key = if i == 0 {
                "CCODE_PORT".to_string()
            } else {
                format!("CCODE_PORT_{i}")
            };
            (key, (port_base + i).to_string())
        })
        .collect()
}

fn workspace_env_impl(conn: &Connection, worktree_path: &str) -> Vec<(String, String)> {
    // 只有 active 工作区占用端口段；creating/archived 不下发端口 env
    let Ok(w) = query_workspaces(conn).and_then(|rows| {
        rows.into_iter()
            .find(|w| {
                crate::paths::same_path(&w.worktree_path, &worktree_path) && w.status == "active"
            })
            .ok_or_else(|| "工作区不存在或未激活".to_string())
    }) else {
        return Vec::new();
    };
    port_env(w.port_base)
}

/// worktree 路径 → 主仓 papers/ 目录（codex 沙箱预授权用，2026-09-15）：
/// 口径 C 允许 Agent 把原始文献直写主仓 papers/，但 workspace-write 沙箱只放行
/// worktree——不预授权的话每写一篇 PDF 都要停下来等提权确认（用户实测「总是让我授权」）。
/// 只认 active 工作区；查不到（cwd 不是注册工作区，比如讨论会话在项目根本身）返回 None。
pub(crate) fn papers_dir_for_worktree(worktree: &str) -> Option<String> {
    let conn = db().ok()?;
    papers_dir_for_worktree_at(&conn, worktree)
}

pub(crate) fn papers_dir_for_worktree_at(conn: &Connection, worktree: &str) -> Option<String> {
    let w = query_workspaces(conn)
        .ok()?
        .into_iter()
        .find(|w| w.status == "active" && crate::paths::same_path(&w.worktree_path, worktree))?;
    Some(
        Path::new(&w.repo_path)
            .join("papers")
            .to_string_lossy()
            .into_owned(),
    )
}

// ===== 项目级脚本钩子（§6.10 阶段 B；脚本来自仓库自己的 .ccode 配置） =====

#[cfg(windows)]
fn shell_cmd(script: &str) -> Result<crate::process::BackgroundCommand, String> {
    // 仓库级 setup/archive 钩子是 bash 脚本；cmd /C 逐字执行必失败。
    // Git for Windows 的 bash 是唯一可靠解释器（装 git 做 worktree 时默认带上）。
    let bash = crate::agents::resolve_git_bash().ok_or(
        "找不到 Git Bash，无法运行项目 setup/archive 钩子（脚本是 bash）。请安装 Git for Windows 后重启 Mesa。",
    )?;
    let mut c = crate::process::background_command(bash);
    c.args(["-c", script]);
    Ok(c)
}

#[cfg(not(windows))]
fn shell_cmd(script: &str) -> Result<crate::process::BackgroundCommand, String> {
    let bash = crate::agents::resolve_binary("bash")
        .ok_or("找不到 bash 可执行文件，无法运行项目脚本钩子")?;
    let mut c = crate::process::background_command(bash);
    c.args(["-c", script]);
    Ok(c)
}

/// 输出尾部（按字符截取，保留换行），给失败提示用
fn output_tail(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        text.to_string()
    } else {
        chars[chars.len() - max..].iter().collect()
    }
}

/// cwd = worktree，注入端口段；成功返 stdout、失败返 stderr，统一截尾部 4000 字符
fn run_hook(dir: &Path, script: &str, port_base: i64, timeout: Duration) -> (bool, String) {
    let mut cmd = match shell_cmd(script) {
        Ok(cmd) => cmd,
        Err(e) => return (false, e),
    };
    cmd.current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in port_env(port_base) {
        cmd.env(k, v);
    }
    match run_cmd(cmd, timeout) {
        Ok(out) => (true, output_tail(&out, 4000)),
        Err(err) => (false, output_tail(&err, 4000)),
    }
}

// ===== 评审与合并（§6.10 阶段 C；merge_workspace 是 git 写操作，仅由用户显式触发） =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsHealthDto {
    pub uncommitted: bool,
    pub ahead: u32,
    pub behind: u32,
    /// Some(false)=可干净合并，Some(true)=有冲突，None=git 版本不支持探测
    pub conflict: Option<bool>,
    /// 冲突文件清单（conflict==Some(true) 时非空，评审面板展示用）
    pub conflict_files: Vec<String>,
    /// 主仓库未停在基准分支（本地合并前置条件之一；原为 merge 时才校验，前置到健康度）
    pub main_off_base: bool,
    /// 主仓库有未提交改动（本地合并会被拒）
    pub main_dirty: bool,
    /// 冲突现场已落后基准（MERGE_HEAD ≠ 基准分支 tip）：继续按旧两侧选边是解过期冲突，
    /// 收件箱据此提示「需重新同步」（评审层 unmerged_with_base 的同口径前置）
    pub stale_base: bool,
    pub ready_to_merge: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_head: Option<String>,
    pub gitdir_detached: bool,
    pub ledger_pending: bool,
}

/// 基准引用固定用本地分支：与 create_impl 的起点一致（工作区从本地基准拉出，
/// 评审 diff 也应相对本地基准——用 origin 会把基准分支上未推送的提交误算进任务改动）
pub(crate) fn base_ref(_repo: &Path, base: &str) -> String {
    base.to_string()
}

/// git ≥2.38 的 merge-tree --write-tree：退出码 0=干净 1=冲突；只写对象库，不碰工作区/索引/
/// 引用。--name-only 时 stdout 首行是树 OID，其后到第一个空行是冲突文件路径；空行之后是
/// 「Auto-merging / CONFLICT」说明——中文系统上 git 会把它们本地化（「自动合并 x」），
/// 按英文前缀过滤会把说明行当成文件名（2026-10-17 git 2.55 实测），所以用 --no-messages
/// 关掉说明并在第一个空行处截断，两道都不依赖语言。
fn conflict_probe(repo: &Path, base: &str, branch: &str) -> (Option<bool>, Vec<String>) {
    let Some(git) = crate::agents::resolve_binary("git") else {
        return (None, vec![]);
    };
    let mut cmd = crate::process::background_command(git);
    cmd.arg("-C")
        .arg(repo)
        .args([
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            base,
            branch,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let Ok(out) = run_cmd_full(cmd, Duration::from_secs(30)) else {
        return (None, vec![]);
    };
    let conflict = match (out.timed_out, out.code) {
        (false, Some(0)) => Some(false),
        (false, Some(1)) => Some(true),
        _ => None, // 旧版 git 没有该参数（退出码 129 等），或超时/启动失败
    };
    let files = if conflict == Some(true) {
        conflict_files_from_merge_tree(&String::from_utf8_lossy(&out.stdout))
    } else {
        vec![]
    };
    (conflict, files)
}

/// merge-tree --name-only 输出 → 冲突文件：跳过首行树 OID，读到第一个空行为止，去重保序。
fn conflict_files_from_merge_tree(stdout: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in stdout.lines().skip(1) {
        let path = line.trim();
        if path.is_empty() {
            break;
        }
        if !out.iter().any(|p| p == path) {
            out.push(path.to_string());
        }
    }
    out
}

fn health_impl(conn: &Connection, id: &str) -> Result<WsHealthDto, String> {
    let w = get_workspace(conn, id)?;
    let wt = PathBuf::from(&w.worktree_path);
    let base = base_ref(&wt, &w.base_branch);
    // 主仓库状态也是本地合并的前置条件：提前暴露，别等点了「合并」才报错
    let repo = live_repo_for(&w);
    // 八次 git 互不依赖，并行跑：Windows 上每起一个 git 要 100–150ms，串行近 1 秒，
    // 打开评审要等它（2026-10-24 HER 初稿实测：串行 ~950ms → 并行 ~320ms）
    fn joined<T>(r: std::thread::Result<T>) -> Result<T, String> {
        r.map_err(|_| "检查工作区状态时线程异常".to_string())
    }
    let (uncommitted, counts, probe, main_off_base, main_dirty, stale_base, worktree_head, gitdir_detached) =
        std::thread::scope(|s| {
            let uncommitted = s.spawn(|| run_git(&wt, &["status", "--porcelain"], Duration::from_secs(30)));
            // A...B 的左侧 = 只在 base（behind），右侧 = 只在 HEAD（ahead）
            let counts = s.spawn(|| {
                run_git(
                    &wt,
                    &["rev-list", "--left-right", "--count", &format!("{base}...HEAD")],
                    Duration::from_secs(30),
                )
            });
            let probe = s.spawn(|| conflict_probe(&wt, &base, "HEAD"));
            let main_off_base = s.spawn(|| {
                run_git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"], Duration::from_secs(10))
                    .map(|cur| cur != w.base_branch)
                    .unwrap_or(false)
            });
            let main_dirty = s.spawn(|| {
                run_git(
                    &repo,
                    &["status", "--porcelain", "--untracked-files=all"],
                    Duration::from_secs(30),
                )
                .map(|s| {
                    s.lines()
                        .any(|line| !crate::review_contract::is_untracked_ledger_file(line))
                })
                .unwrap_or(false)
            });
            // 冲突现场是否已落后基准：仅 merge 进行中才有 MERGE_HEAD，多一次 rev-parse 只发生在此时
            let stale_base = s.spawn(|| {
                run_git(&wt, &["rev-parse", "--verify", "-q", "MERGE_HEAD"], Duration::from_secs(10))
                    .ok()
                    .filter(|mh| !mh.is_empty())
                    .map(|mh| {
                        run_git(&wt, &["rev-parse", &base], Duration::from_secs(10))
                            .map(|tip| tip != mh)
                            .unwrap_or(false)
                    })
                    .unwrap_or(false)
            });
            let worktree_head =
                s.spawn(|| run_git(&wt, &["rev-parse", "HEAD"], Duration::from_secs(10)).ok());
            let gitdir_detached = s.spawn(|| gitdir_matches_repo(&wt, &repo).is_err());
            (
                joined(uncommitted.join()),
                joined(counts.join()),
                joined(probe.join()),
                joined(main_off_base.join()),
                joined(main_dirty.join()),
                joined(stale_base.join()),
                joined(worktree_head.join()),
                joined(gitdir_detached.join()),
            )
        });
    // 退回意见 .ccode/review-notes.md 按设计只留在工作区、不进提交（git_info 提交时撤掉），不算「没保存的改动」：
    // 算上它，提交完照样报「任务里还有没保存的改动」、保存不进项目（2026-11-10 HER 实测）
    let uncommitted = porcelain_has_changes(&uncommitted??);
    let counts = counts??;
    let mut parts = counts.split_whitespace();
    let behind = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let (conflict, conflict_files) = probe?;
    let (main_off_base, main_dirty, stale_base) = (main_off_base?, main_dirty?, stale_base?);
    let (worktree_head, gitdir_detached) = (worktree_head?, gitdir_detached?);
    Ok(WsHealthDto {
        uncommitted,
        ahead,
        behind,
        conflict,
        conflict_files,
        main_off_base,
        main_dirty,
        stale_base,
        ready_to_merge: ahead > 0
            && !uncommitted
            && conflict == Some(false)
            && !main_off_base
            && !main_dirty
            && !gitdir_detached,
        worktree_head,
        gitdir_detached,
        ledger_pending: crate::review_contract::pending_needs_attention(id)
            || !matches!(read_delivery_pending(id), Ok(None)),
    })
}

// 生产路径一律走带 guard 的变体（归档前复查运行中任务）；本包装仅供测试免传 guard
#[cfg(test)]
fn merge_impl(
    conn: &Connection,
    id: &str,
    archive: bool,
) -> Result<WorkspaceMergeResultDto, String> {
    let w = get_workspace(conn, id)?;
    let tip = run_git(
        Path::new(&w.repo_path),
        &["rev-parse", &w.branch],
        Duration::from_secs(10),
    )?;
    let review = freeze_deliverables(&w, &live_repo_for(&w))?;
    merge_impl_with_guard(
        conn,
        id,
        archive,
        &|_| Ok(()),
        Some(&tip),
        Some(&review.token),
    )
}

fn live_repo_for(w: &WorkspaceDto) -> PathBuf {
    if let Some(pid) = w.project_id.as_deref() {
        if let Ok(conn) = db() {
            if let Ok(path) = conn.query_row("SELECT path FROM projects WHERE id=?1", [pid], |r| {
                r.get::<_, String>(0)
            }) {
                return PathBuf::from(path);
            }
        }
    }
    PathBuf::from(&w.repo_path)
}

fn gitdir_matches_repo(worktree: &Path, repo: &Path) -> Result<(), String> {
    let common = run_git(
        worktree,
        &["rev-parse", "--git-common-dir"],
        Duration::from_secs(10),
    )?;
    let common_path = if Path::new(&common).is_absolute() {
        PathBuf::from(&common)
    } else {
        worktree.join(&common)
    };
    let Ok(common_canon) = crate::paths::canonicalize_plain(&common_path) else {
        return Ok(());
    };
    let Ok(repo_git) = crate::paths::canonicalize_plain(&repo.join(".git")) else {
        return Ok(());
    };
    if crate::paths::same_path(&common_canon.to_string_lossy(), &repo_git.to_string_lossy()) {
        return Ok(());
    }
    // git-common-dir 可能是 .git 本身或对象库父目录
    if crate::paths::path_within(&common_canon.to_string_lossy(), &repo.to_string_lossy()) {
        return Ok(());
    }
    Err("工作树与主仓脱节，请重新挂载".into())
}

/// ensure_no_active_tasks 透传给归档阶段：merge 成功后、worktree remove 前复查运行中任务
fn merge_impl_with_guard(
    conn: &Connection,
    id: &str,
    archive: bool,
    ensure_no_active_tasks: &dyn Fn(&str) -> Result<(), String>,
    expect_reviewed_sha: Option<&str>,
    expect_delivery_token: Option<&str>,
) -> Result<WorkspaceMergeResultDto, String> {
    let w = get_workspace(conn, id)?;
    let repo = live_repo_for(&w);
    let _apply_lock = crate::review_contract::apply_lock(&repo)?;
    if let Some(mut pending) = read_delivery_pending(&w.id)? {
        if pending.fact.scene_ref.as_deref() != Some(w.id.as_str())
            || pending.fact.kind != crate::review_contract::KIND_PIPELINE_MERGE
            || (pending.fact.project_id.is_some()
                && pending.fact.project_id != crate::projects::project_id_at(&repo))
        {
            return Err("科研产物恢复单与当前项目不匹配".into());
        }
        if pending.fact.version_id.is_empty() {
            let before = pending
                .before_sha
                .as_deref()
                .ok_or("缺少原合并基线，不能猜测恢复")?;
            let reviewed = pending
                .fact
                .reviewed_sha
                .as_deref()
                .ok_or("缺少原评审提交")?;
            if run_git(
                &repo,
                &["rev-parse", "--verify", "-q", "MERGE_HEAD"],
                Duration::from_secs(10),
            )
            .is_ok()
            {
                return Err("原合并仍处于冲突处理中，请先处理 Git 状态；未接收任何新产物".into());
            }
            if let Some(sha) = original_merge_commit(&repo, &w.base_branch, before, reviewed)? {
                pending.fact.version_id = sha;
                save_delivery_pending(&w.id, &pending)?;
            } else {
                let base_tip = run_git(
                    &repo,
                    &["rev-parse", &w.base_branch],
                    Duration::from_secs(10),
                )?;
                if base_tip == before {
                    fs::remove_file(delivery_pending_path(&w.id)?).map_err(|e| e.to_string())?;
                    return Err("原合并尚未发生，未接收产物。请刷新评审后重新合并".into());
                }
                return Err(
                    "无法定位原合并提交，恢复单已保留；请检查历史，不会按最新 HEAD 猜测".into(),
                );
            }
        }
        if !git_is_ancestor(&repo, &pending.fact.version_id, &w.base_branch)? {
            return Err("产物恢复版本不在基准历史中，未重新合并".into());
        }
        let mut review = load_delivery_review(&w.id, &pending.review_token)?;
        for file in &mut review.files {
            if pending.tracked_after_review.contains(&file.path) {
                file.disposition = "tracked".into();
            }
        }
        let recorded = crate::projects::read_acceptance_log_at(&repo)
            .iter()
            .any(|e| e.kind == pending.fact.kind && e.version_id == pending.fact.version_id);
        let report = if pending.files_applied || recorded {
            SalvageReport {
                copied: review
                    .files
                    .iter()
                    .filter(|f| f.disposition == "copy")
                    .map(|f| f.path.clone())
                    .collect(),
                conflicts: review
                    .files
                    .iter()
                    .filter(|f| f.disposition == "conflict")
                    .map(|f| f.path.clone())
                    .collect(),
                skipped_protected: review
                    .files
                    .iter()
                    .filter(|f| f.disposition == "protected")
                    .map(|f| f.path.clone())
                    .collect(),
                failed: Vec::new(),
            }
        } else {
            let protected = crate::projects::protected_paths_at(&repo)?;
            apply_delivery_review(&review, &repo, &protected)
        };
        if report.failed.is_empty() && !pending.files_applied {
            pending.files_applied = true;
            save_delivery_pending(&w.id, &pending)?;
        }
        let ledger = pending.files_applied
            && crate::review_contract::record_pending_fact(&repo, &w.id, &pending.fact).is_ok();
        let mut result = WorkspaceMergeResultDto {
            merged: true,
            archived: false,
            failed_phase: None,
            message: if ledger {
                "已完成原版本产物接收与验收记录".into()
            } else {
                format!(
                    "Git 已合并，原版本产物仍待接收或记账：{}；工作区保留，请继续原操作",
                    report.failed.join("；")
                )
            },
            output: report.note(),
            version_id: Some(pending.fact.version_id),
            reviewed_sha: pending.fact.reviewed_sha,
            ledger_written: ledger,
            salvage: Some(report.clone()),
        };
        if ledger {
            if let Err(e) = conn.execute(
                "UPDATE workspaces SET merged_at=?1 WHERE id=?2",
                params![pending.fact.decided_at, id],
            ) {
                result.failed_phase = Some("state".into());
                result.message = format!("文件已接收，但状态未完成：{e}，请继续原操作");
                return Ok(result);
            }
            fs::remove_file(delivery_pending_path(&w.id)?)
                .map_err(|e| format!("产物已接收，恢复标记未清理：{e}"))?;
            if archive && report.conflicts.is_empty() {
                match archive_impl_with_guard(conn, id, ensure_no_active_tasks) {
                    Ok(()) => result.archived = true,
                    Err(e) => {
                        result.failed_phase = Some("archive".into());
                        result.message = format!("文件已接收，但归档失败：{e}");
                    }
                }
            }
        }
        return Ok(result);
    }
    let already_merged = git_is_ancestor(&repo, &w.branch, &w.base_branch)?;
    let tip = run_git(&repo, &["rev-parse", &w.branch], Duration::from_secs(10))?;
    if crate::review_contract::read_pending(&w.id)?.is_some() || already_merged {
        let entry = crate::review_contract::recover_fact(
            &repo,
            &w.id,
            crate::review_contract::KIND_PIPELINE_MERGE,
            &w.id,
            &tip,
        )?;
        if !git_is_ancestor(&repo, &entry.version_id, &w.base_branch)? {
            return Err("恢复凭证中的版本不在基准历史中，未重新合并".into());
        }
        let recording = crate::review_contract::record_pending_fact(&repo, &w.id, &entry);
        let ledger = recording.is_ok();
        let mut result = WorkspaceMergeResultDto {
            merged: true,
            archived: false,
            failed_phase: None,
            message: match recording {
                Ok(()) => format!(
                    "文件已进入项目 · {}",
                    entry.version_id.chars().take(8).collect::<String>()
                ),
                Err(e) => format!("文件已进主仓，但验收记录未完成：{e}。请点「再记录验收」"),
            },
            output: String::new(),
            version_id: Some(entry.version_id),
            reviewed_sha: entry.reviewed_sha,
            ledger_written: ledger,
            salvage: None,
        };
        if !ledger {
            return Ok(result);
        }
        if let Err(e) = conn.execute(
            "UPDATE workspaces SET merged_at=?1 WHERE id=?2",
            params![entry.decided_at, id],
        ) {
            result.failed_phase = Some("state".into());
            result.message = format!("文件已合并，状态记录失败：{e}；不要重新合并");
            return Ok(result);
        }
        if archive {
            match archive_impl_with_guard(conn, id, ensure_no_active_tasks) {
                Ok(()) => {
                    result.archived = true;
                    result.output = "已合并并归档工作区".into();
                    result.message = "已合并并归档".into();
                }
                Err(e) => {
                    result.failed_phase = Some("archive".into());
                    result.message = format!("文件已合并，但归档失败：{e}；工作区仍保留");
                }
            }
        }
        return Ok(result);
    }
    gitdir_matches_repo(Path::new(&w.worktree_path), &repo)?;
    // 前置条件：主仓库必须停在基准分支且工作区干净，否则合并会搅乱用户手头的工作
    let cur = run_git(
        &repo,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        Duration::from_secs(10),
    )?;
    if cur != w.base_branch {
        return Err(format!(
            "主仓库当前分支是 {cur}，不在基准分支 {} 上；请先在主仓库切换分支，或改用 PR 流程",
            w.base_branch
        ));
    }
    let dirty = run_git(
        &repo,
        &["status", "--porcelain", "--untracked-files=all"],
        Duration::from_secs(30),
    )?;
    let dirty = dirty
        .lines()
        .filter(|line| !crate::review_contract::is_untracked_ledger_file(line))
        .collect::<Vec<_>>()
        .join("\n");
    if !dirty.is_empty() {
        // porcelain 前两列是状态码，第三列起是路径；列出前 5 个帮用户定位
        let lines: Vec<&str> = dirty.lines().collect();
        let names = lines
            .iter()
            .take(5)
            .map(|l| l.get(3..).unwrap_or(l))
            .collect::<Vec<_>>()
            .join("、");
        let suffix = if lines.len() > 5 {
            format!(" 等 {} 个文件", lines.len())
        } else {
            String::new()
        };
        return Err(format!(
            "主仓库有未提交改动（{names}{suffix}），请先提交或 stash 再合并（或改用 PR 流程）"
        ));
    }
    let uncommitted = run_git(
        Path::new(&w.worktree_path),
        &["diff", "--name-only", "HEAD", "--"],
        Duration::from_secs(30),
    )?;
    if !uncommitted.is_empty() {
        return Err("工作区仍有未提交的受 Git 管理改动，请先提交并重新评审；尚未合并".into());
    }
    crate::review_contract::assert_reviewed_sha(expect_reviewed_sha.unwrap_or(""), &tip)?;
    let review = check_delivery_review(
        &w,
        &repo,
        expect_delivery_token.ok_or("请先打开并核对非 Git 产物评审，再合并")?,
    )?;

    // 保护路径：验收合并必须让被保护路径保持主仓原样。git 无法只按路径部分合并，
    // 任务分支改动了被保护路径时拒绝合并并说明，由人先去工作区撤掉这些改动
    // （或调整保护设置）；配置读不出时 fail-closed，不按「没有保护」合并
    let protected = crate::projects::protected_paths_at(&repo)?;
    let range = format!("{}...{}", w.base_branch, tip);
    let touched_raw = run_git(
        &repo,
        &["diff", "--name-only", &range],
        Duration::from_secs(30),
    )?;
    let touched: Vec<String> = touched_raw
        .lines()
        .map(|l| l.to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if !protected.is_empty() {
        let hits: Vec<&str> = touched
            .iter()
            .map(|s| s.as_str())
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
                "任务分支改动了保护路径下的文件（{names}{suffix}），合并会覆盖主仓中「保持原样」的内容；\
                 请先在工作区撤掉这些改动，或在项目设置中调整保护路径后再合并"
            ));
        }
    }
    let mut paths = touched;
    paths.extend(
        review
            .files
            .iter()
            .filter(|f| f.disposition == "copy")
            .map(|f| f.path.clone()),
    );
    paths.sort();
    paths.dedup();
    let fact = crate::projects::AcceptanceLogEntry {
        goal_id: String::new(),
        goal_name: format!("{} / {}", w.name, w.branch),
        run_id: String::new(),
        paths,
        note: format!(
            "已合并进 {}；非 Git 产物版本 {}",
            w.base_branch, review.token
        ),
        frozen: true,
        decided_at: crate::sessions::now_iso(),
        kind: crate::review_contract::KIND_PIPELINE_MERGE.into(),
        version_id: String::new(),
        reviewed_sha: Some(tip.clone()),
        project_id: w
            .project_id
            .clone()
            .or_else(|| crate::projects::project_id_at(&repo)),
        scene_ref: Some(w.id.clone()),
        content_fingerprints: review
            .files
            .iter()
            .filter(|f| f.disposition == "copy")
            .map(|f| crate::projects::ContentFingerprint {
                path: f.path.clone(),
                size: f.size,
                sha256: f.sha256.clone(),
            })
            .collect(),
    };
    let mut pending = PipelineFilePending {
        review_token: review.token.clone(),
        fact,
        before_sha: Some(run_git(
            &repo,
            &["rev-parse", "HEAD"],
            Duration::from_secs(10),
        )?),
        files_applied: false,
        tracked_after_review: review
            .files
            .iter()
            .filter(|f| f.disposition == "tracked")
            .map(|f| f.path.clone())
            .collect(),
    };
    save_delivery_pending(&w.id, &pending)?;
    // 应用内自动 merge commit 必须绕过用户全局 commit.gpgsign：无头环境调 gpg 会卡住或失败
    let ident = crate::git_info::commit_identity_args(&repo);
    let mut merge_args: Vec<&str> = ident.iter().map(String::as_str).collect();
    merge_args.extend(["-c", "commit.gpgsign=false", "merge", "--no-ff", &tip]);
    let mut log = match run_git(&repo, &merge_args, Duration::from_secs(60)) {
        Ok(out) => out,
        Err(e) => {
            let files = run_git(
                &repo,
                &["diff", "--name-only", "--diff-filter=U"],
                Duration::from_secs(10),
            )
            .unwrap_or_default();
            let merge_in_progress = run_git(
                &repo,
                &["rev-parse", "--verify", "-q", "MERGE_HEAD"],
                Duration::from_secs(10),
            )
            .is_ok();
            let abort_note = if merge_in_progress {
                match run_git(&repo, &["merge", "--abort"], Duration::from_secs(30)) {
                    Ok(_) => "已自动回退，主仓库保持干净",
                    Err(_) => "自动回退失败，请立即在主仓库执行 git merge --abort",
                }
            } else {
                "未进入合并状态，主仓库未留下 merge 过程"
            };
            if run_git(
                &repo,
                &["rev-parse", "--verify", "-q", "MERGE_HEAD"],
                Duration::from_secs(10),
            )
            .is_err()
                && run_git(&repo, &["rev-parse", "HEAD"], Duration::from_secs(10))
                    .ok()
                    .as_deref()
                    == pending.before_sha.as_deref()
            {
                fs::remove_file(delivery_pending_path(&w.id)?)
                    .map_err(|err| format!("合并失败且恢复标记未清理：{err}"))?;
            }
            return Err(format!(
                "最终合并失败；{abort_note}。请回到隔离工作区重新处理冲突:\n{e}\n冲突文件:\n{files}"
            ));
        }
    };
    let version_id = run_git(&repo, &["rev-parse", "HEAD"], Duration::from_secs(10))?;
    pending.fact.version_id = version_id.clone();
    save_delivery_pending(&w.id, &pending)?;
    let salvage = apply_delivery_review(&review, &repo, &protected);
    let salvage_note = salvage.note();
    if !salvage_note.is_empty() {
        log.push('\n');
        log.push_str(&salvage_note);
    }
    let auto_manifest = register_expected_artifacts_at(&repo, &w.name);
    if !auto_manifest.is_empty() {
        log.push('\n');
        log.push_str(&auto_manifest);
    }
    pending.files_applied = salvage.failed.is_empty();
    save_delivery_pending(&w.id, &pending)?;
    let ledger = pending.files_applied
        && crate::review_contract::record_pending_fact(&repo, &w.id, &pending.fact).is_ok();
    let merged_at = crate::sessions::now_iso();
    if let Err(e) = conn.execute(
        "UPDATE workspaces SET merged_at=?1 WHERE id=?2",
        params![merged_at, id],
    ) {
        return Ok(WorkspaceMergeResultDto {
            merged: true,
            archived: false,
            failed_phase: Some("state".into()),
            message: format!(
                "代码已合并进 {}，但 Mesa 状态记录失败；不要重复合并：{e}",
                w.base_branch
            ),
            output: log,
            version_id: Some(version_id),
            reviewed_sha: Some(tip),
            ledger_written: ledger,
            salvage: Some(salvage),
        });
    }
    if ledger {
        fs::remove_file(delivery_pending_path(&w.id)?)
            .map_err(|e| format!("文件已进入项目，恢复标记未清理：{e}"))?;
    }
    if archive && ledger && salvage.conflicts.is_empty() && salvage.failed.is_empty() {
        if let Err(e) = archive_impl_with_guard(conn, id, ensure_no_active_tasks) {
            return Ok(WorkspaceMergeResultDto {
                merged: true,
                archived: false,
                failed_phase: Some("archive".into()),
                message: format!("代码已合并进 {}，但归档失败：{e}", w.base_branch),
                output: log,
                version_id: Some(version_id),
                reviewed_sha: Some(tip),
                ledger_written: ledger,
                salvage: Some(salvage),
            });
        }
        if !log.is_empty() {
            log.push('\n');
        }
        log.push_str("已合并并归档工作区");
        Ok(WorkspaceMergeResultDto {
            merged: true,
            archived: true,
            failed_phase: None,
            message: format!("已合并进 {} 并归档工作区", w.base_branch),
            output: log,
            version_id: Some(version_id),
            reviewed_sha: Some(tip),
            ledger_written: ledger,
            salvage: Some(salvage),
        })
    } else {
        if !log.is_empty() {
            log.push('\n');
        }
        log.push_str("已合并（工作区保留，可继续干活或之后归档）");
        let message = if ledger {
            format!(
                "文件已进入项目 · {}，工作区已保留",
                &version_id.chars().take(8).collect::<String>()
            )
        } else {
            format!(
                "已合并进 {}，工作区已保留。验收记录未写下，请点「再记录验收」",
                w.base_branch
            )
        };
        Ok(WorkspaceMergeResultDto {
            merged: true,
            archived: false,
            failed_phase: None,
            message,
            output: log,
            version_id: Some(version_id),
            reviewed_sha: Some(tip),
            ledger_written: ledger,
            salvage: Some(salvage),
        })
    }
}

fn pr_impl(
    conn: &Connection,
    id: &str,
    title: &str,
    body: Option<String>,
    skip_push: bool,
) -> Result<WorkspacePrResultDto, String> {
    // 复用机器上的 gh CLI 认证，不做应用内 GitHub 登录
    let gh = crate::agents::resolve_binary("gh").ok_or("需要安装 gh CLI")?;
    let gh_ok = crate::process::background_command(&gh)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !gh_ok {
        return Err("需要安装 gh CLI".into());
    }
    let w = get_workspace(conn, id)?;
    let wt = PathBuf::from(&w.worktree_path);
    if !skip_push {
        if let Err(e) = run_git(
            &wt,
            &["push", "-u", "origin", &w.branch],
            Duration::from_secs(120),
        ) {
            return Ok(WorkspacePrResultDto {
                pushed: false,
                pr_created: false,
                pr_url: None,
                failed_phase: Some("push".into()),
                message: format!("分支推送失败，PR 尚未创建：{e}"),
            });
        }
    }
    let body = match body.filter(|b| !b.trim().is_empty()) {
        Some(b) => b,
        // 自动 body = 任务分支上的提交清单（cap 50 行）
        None => {
            let base = base_ref(&wt, &w.base_branch);
            let log = run_git(
                &wt,
                &["log", "--oneline", &format!("{base}..{}", w.branch)],
                Duration::from_secs(30),
            )
            .unwrap_or_default();
            let lines: Vec<&str> = log.lines().take(50).collect();
            if lines.is_empty() {
                "由 Mesa 创建".to_string()
            } else {
                lines.join("\n")
            }
        }
    };
    let mut cmd = crate::process::background_command(&gh);
    cmd.current_dir(&wt)
        .args([
            "pr",
            "create",
            "--base",
            &w.base_branch,
            "--head",
            &w.branch,
            "--title",
            title,
            "--body",
            &body,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = match run_cmd(cmd, Duration::from_secs(120)) {
        Ok(out) => out,
        Err(e) => {
            return Ok(WorkspacePrResultDto {
                pushed: true,
                pr_created: false,
                pr_url: None,
                failed_phase: Some("pr".into()),
                message: format!("分支已推送，但 PR 创建失败；可直接重试创建 PR：{e}"),
            });
        }
    };
    // gh 成功输出的末行是 PR URL
    let url = out
        .lines()
        .rev()
        .find(|l| l.contains("http"))
        .unwrap_or(out.trim())
        .trim()
        .to_string();
    Ok(WorkspacePrResultDto {
        pushed: true,
        pr_created: true,
        pr_url: Some(url.clone()),
        failed_phase: None,
        message: "PR 已创建".into(),
    })
}

// ===== Tauri commands（全部 async + spawn_blocking，git/DB 不阻塞主线程） =====

#[tauri::command]
pub async fn create_workspace(repo_path: String, name: String) -> Result<WorkspaceDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 科研项目手动「新建工作区」也先自动初始化 Git（与开步、定时任务同口径，2026-11-05）
        crate::projects::ensure_research_git(&PathBuf::from(crate::sessions::expand_tilde(&repo_path)))?;
        let conn = db()?;
        create_impl(&conn, &workspaces_root()?, &repo_path, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_workspaces() -> Result<Vec<WorkspaceDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let mut rows = query_workspaces(&conn)?;
        // active 在前、archived 在后，组内按创建时间倒序
        rows.sort_by(|a, b| {
            (b.status != "active")
                .cmp(&(a.status != "active"))
                .then(b.created_at.cmp(&a.created_at))
        });
        // 上游漂移提醒：按仓库分组读一次 project.toml，逐步骤比对合并时间（启发式，读失败静默跳过）
        let mut repos: Vec<String> = rows.iter().map(|w| w.repo_path.clone()).collect();
        repos.sort_unstable();
        repos.dedup();
        for repo in repos {
            let steps = crate::projects::read_config_at(Path::new(&repo))
                .config
                .steps;
            if steps.is_empty() {
                continue;
            }
            let repo_ws: Vec<WorkspaceDto> = rows
                .iter()
                .filter(|w| w.repo_path == repo)
                .cloned()
                .collect();
            let followed = crate::step_loop::followed_at(Path::new(&repo));
            for index in 0..steps.len() {
                let Some(stale) = stale_upstream_for(&steps, &repo_ws, index, &followed) else {
                    continue;
                };
                if let Some(w) = rows
                    .iter_mut()
                    .find(|w| w.repo_path == repo && w.name == steps[index].workspace_name)
                {
                    w.stale_upstream = Some(stale);
                }
            }
        }
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 归档/删除/合并成功后广播（前端把还留在被移除工作树里的终端标签切回主仓库）
fn emit_ws_archived(app: &tauri::AppHandle, worktree_path: &str, repo_path: &str) {
    use tauri::Emitter;
    let _ = app.emit(
        "ws-archived",
        serde_json::json!({ "worktreePath": worktree_path, "repoPath": repo_path }),
    );
}

#[tauri::command]
pub async fn archive_workspace(
    app: tauri::AppHandle,
    manager: tauri::State<'_, crate::pty::PtyManager>,
    id: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    let paths =
        tauri::async_runtime::spawn_blocking(move || -> Result<(String, String), String> {
            let conn = db()?;
            let w = get_workspace(&conn, &id)?;
            let ensure_idle =
                |worktree_path: &str| manager.ensure_workspace_free(worktree_path, "归档");
            ensure_idle(&w.worktree_path)?; // 快速预检；归档内部在移除 worktree 前还会复查
            archive_impl_with_guard(&conn, &id, &ensure_idle)?;
            Ok((w.worktree_path, w.repo_path))
        })
        .await
        .map_err(|e| e.to_string())??;
    emit_ws_archived(&app, &paths.0, &paths.1);
    Ok(())
}

#[tauri::command]
pub async fn restore_workspace(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || restore_impl(&db()?, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_workspace(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let paths =
        tauri::async_runtime::spawn_blocking(move || -> Result<(String, String), String> {
            let conn = db()?;
            let w = get_workspace(&conn, &id)?;
            delete_impl(&conn, &id)?;
            Ok((w.worktree_path, w.repo_path))
        })
        .await
        .map_err(|e| e.to_string())??;
    emit_ws_archived(&app, &paths.0, &paths.1);
    Ok(())
}

#[tauri::command]
pub async fn workspace_env_for(worktree_path: String) -> Vec<(String, String)> {
    tauri::async_runtime::spawn_blocking(move || {
        db().map(|conn| workspace_env_impl(&conn, &worktree_path))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn workspace_health(id: String) -> Result<WsHealthDto, String> {
    tauri::async_runtime::spawn_blocking(move || health_impl(&db()?, &id))
        .await
        .map_err(|e| e.to_string())?
}

// ===== 产物待核验（收件箱；只读，不进轮询——由前端随健康度同频次拉取） =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingArtifactDto {
    pub workspace_id: String,
    pub workspace_name: String,
    pub repo_name: String,
}

/// 单个预期产物「已产出且够新」：目录条目（尾斜杠）要求至少一个直接子文件（与核验清单
/// 同口径），mtime 取目录与子项最大值；文件条目看自身。mtime 早于工作区创建时间的不算
/// （files-to-copy/模板带入的旧文件不是本任务产物）。
fn artifact_produced_since(root: &Path, entry: &str, since: SystemTime) -> bool {
    let is_dir_entry = entry.ends_with('/') || entry.ends_with('\\');
    let rel = entry.trim().trim_end_matches(['/', '\\']);
    // 只接受根的相对路径（核验清单的根约束同口径）；绝对路径/逃逸一律视为未产出
    if rel.is_empty() || rel.contains("..") || Path::new(rel).is_absolute() {
        return false;
    }
    let fresh = |m: &fs::Metadata| m.modified().map(|t| t >= since).unwrap_or(false);
    if rel.contains('*') {
        let Some(idx) = rel.rfind('/').or_else(|| rel.rfind('\\')) else {
            return false;
        };
        let (dir, pattern) = rel.split_at(idx);
        let pattern = &pattern[1..];
        if pattern.is_empty() || dir.contains('*') {
            return false;
        }
        let Some(dir_path) = rooted_existing_path(root, dir) else {
            return false;
        };
        let Ok(rd) = fs::read_dir(dir_path) else {
            return false;
        };
        return rd.flatten().any(|e| {
            let Ok(m) = e.metadata() else { return false };
            m.is_file()
                && m.len() > 0
                && wildcard_match(pattern, &e.file_name().to_string_lossy())
                && fresh(&m)
        });
    }
    let Some(path) = rooted_existing_path(root, rel) else {
        return false;
    };
    if is_dir_entry {
        let mut any_file = false;
        let mut any_fresh = fs::metadata(&path).map(|m| fresh(&m)).unwrap_or(false);
        let Ok(rd) = fs::read_dir(&path) else {
            return false;
        };
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            if m.is_file() && m.len() > 0 {
                any_file = true;
                if fresh(&m) {
                    any_fresh = true;
                }
            }
        }
        any_file && any_fresh
    } else {
        fs::metadata(&path)
            .map(|m| m.is_file() && m.len() > 0 && fresh(&m))
            .unwrap_or(false)
    }
}

/// 返回根目录内、且解析后没有穿过符号链接逃逸的已有路径。
/// 机器验收只读项目产物，但不能因为“相对路径”就读取项目根外的文件。
fn rooted_existing_path(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() || rel.contains("..") || Path::new(rel).is_absolute() || rel.contains('\0') {
        return None;
    }
    let root = fs::canonicalize(root).ok()?;
    let candidate = fs::canonicalize(root.join(rel)).ok()?;
    crate::paths::path_within_path(&candidate, &root).then_some(candidate)
}

/// Compare record coverage without pretending to validate the records' scientific meaning.
/// The reference may be inherited; the delivered file must belong to this workspace run.
fn acceptance_record_ids(
    root: &Path,
    path: &str,
    since: Option<SystemTime>,
) -> Option<std::collections::HashSet<String>> {
    let path = rooted_existing_path(root, path)?;
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file()
        || meta.len() == 0
        || meta.len() > 4 * 1024 * 1024
        || since.is_some_and(|start| meta.modified().ok().is_none_or(|t| t < start))
    {
        return None;
    }
    // Bound the read too: a file can grow between metadata and read.
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(file, 4 * 1024 * 1024 + 1),
        &mut bytes,
    )
    .ok()?;
    if bytes.len() > 4 * 1024 * 1024 {
        return None;
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let rows = value
        .as_array()
        .or_else(|| value.get("items").and_then(Value::as_array))
        .or_else(|| value.get("records").and_then(Value::as_array))
        .or_else(|| value.get("rows").and_then(Value::as_array))?;
    if rows.is_empty() || rows.len() > 5000 {
        return None;
    }
    let mut ids = std::collections::HashSet::new();
    for row in rows {
        // 人在评审里排除的篇目留在 included.json（decision=excluded）：不参与对账——
        // 否则精读步要么给排除篇建索引行（进度永远写不满），要么机器验收不过（2026-10-17）
        let excluded = row
            .get("decision")
            .and_then(Value::as_str)
            .is_some_and(|d| matches!(d.trim().to_ascii_lowercase().as_str(), "excluded" | "exclude"));
        if excluded {
            continue;
        }
        let id = row.get("id")?.as_str()?;
        if id.trim().is_empty() || !ids.insert(id.to_owned()) {
            return None;
        }
    }
    Some(ids)
}

/// 机器验收语法（仅处理显式 `machine:` 条目，普通自然语言条件仍展示给人）：
/// `machine:file:path`、`machine:glob:path/*.md`、`machine:contains:path::文本`、
/// `machine:not-contains:path::文本`（文件在且不含该文本）、
/// `machine:count:path/*.pdf>=N`（可带 `::except=a.md,b.md` 不计入的文件名）、
/// `machine:same-ids:reference.json::delivered.json`（decision=excluded 的行不参与对账）。
/// 路径始终限制在项目根内；same-ids 只核对非空唯一字符串 ID 集合，不验证研究结论。
fn machine_acceptance_satisfied(root: &Path, criteria: &[String], since: SystemTime) -> bool {
    criteria
        .iter()
        .filter_map(|raw| raw.strip_prefix("machine:"))
        .all(|rule| {
            if let Some(path) = rule.strip_prefix("optional-empty:") {
                return rooted_existing_path(root, path)
                    .and_then(|p| fs::metadata(p).ok())
                    .is_some_and(|m| m.is_file() && m.modified().is_ok_and(|t| t >= since));
            }
            if let Some(path) = rule.strip_prefix("file:") {
                return artifact_produced_since(root, path, since);
            }
            if let Some(path) = rule.strip_prefix("glob:") {
                return artifact_produced_since(root, path, since);
            }
            if let Some(rest) = rule.strip_prefix("not-contains:") {
                let Some((path, needle)) = rest.split_once("::") else {
                    return false;
                };
                if needle.is_empty() {
                    return false;
                }
                let Some(path) = rooted_existing_path(root, path) else {
                    return false;
                };
                return fs::read_to_string(path)
                    .map(|text| !text.contains(needle))
                    .unwrap_or(false);
            }
            if let Some(rest) = rule.strip_prefix("contains:") {
                let Some((path, needle)) = rest.split_once("::") else {
                    return false;
                };
                let Some(path) = rooted_existing_path(root, path) else {
                    return false;
                };
                return fs::read_to_string(path)
                    .map(|text| text.contains(needle))
                    .unwrap_or(false);
            }
            if let Some(rest) = rule.strip_prefix("count:") {
                // 可选尾巴 `::except=a.md,b.md`：不计入的文件名（如精读步的 handoff.md——
                // 它本身是必交产物，不剔掉「至少写了 1 篇笔记」就被它自己满足）
                let (rest, except) = match rest.split_once("::") {
                    Some((head, tail)) => match tail.strip_prefix("except=") {
                        Some(names) => (head, names),
                        None => return false,
                    },
                    None => (rest, ""),
                };
                let except: Vec<String> = except
                    .split(',')
                    .map(|n| n.trim().to_lowercase())
                    .filter(|n| !n.is_empty())
                    .collect();
                let Some((pattern, n)) = rest.rsplit_once(">=") else {
                    return false;
                };
                let Ok(expected) = n.trim().parse::<usize>() else {
                    return false;
                };
                let Some(idx) = pattern.rfind('/').or_else(|| pattern.rfind('\\')) else {
                    return false;
                };
                let dir = &pattern[..idx];
                let file_pattern = &pattern[idx + 1..];
                let Some(dir) = rooted_existing_path(root, dir) else {
                    return false;
                };
                let Ok(rd) = fs::read_dir(dir) else {
                    return false;
                };
                let actual = rd
                    .flatten()
                    .filter_map(|entry| {
                        let meta = entry.metadata().ok()?;
                        let name = entry.file_name().to_string_lossy().into_owned();
                        (meta.is_file()
                            && meta.len() > 0
                            && wildcard_match(file_pattern, &name)
                            && !except.contains(&name.to_lowercase())
                            && meta.modified().ok().map(|t| t >= since).unwrap_or(false))
                        .then_some(())
                    })
                    .count();
                return actual >= expected;
            }
            if let Some(rest) = rule.strip_prefix("same-ids:") {
                let Some((reference, delivered)) = rest.split_once("::") else {
                    return false;
                };
                return match (
                    acceptance_record_ids(root, reference, None),
                    acceptance_record_ids(root, delivered, Some(since)),
                ) {
                    (Some(expected), Some(actual)) => expected == actual,
                    _ => false,
                };
            }
            let allow_empty = rule.starts_with("records-allow-empty:");
            if let Some(rest) = rule
                .strip_prefix("records:")
                .or_else(|| rule.strip_prefix("records-allow-empty:"))
            {
                let Some((path, fields)) = rest.split_once("::") else {
                    return false;
                };
                let Some(path) = rooted_existing_path(root, path) else {
                    return false;
                };
                let Ok(meta) = fs::metadata(&path) else {
                    return false;
                };
                if !meta.is_file()
                    || meta.len() == 0
                    || meta.len() > 4 * 1024 * 1024
                    || meta.modified().ok().map(|t| t < since).unwrap_or(true)
                {
                    return false;
                }
                let Ok(file) = fs::File::open(path) else {
                    return false;
                };
                let Ok(value) = serde_json::from_reader::<_, Value>(file) else {
                    return false;
                };
                let rows = value
                    .as_array()
                    .or_else(|| value.get("items").and_then(Value::as_array))
                    .or_else(|| value.get("records").and_then(Value::as_array))
                    .or_else(|| value.get("rows").and_then(Value::as_array));
                let Some(rows) = rows else { return false };
                if (!allow_empty && rows.is_empty()) || rows.len() > 5000 {
                    return false;
                }
                let required: Vec<&str> = fields
                    .split(',')
                    .map(str::trim)
                    .filter(|f| !f.is_empty())
                    .collect();
                if required.is_empty() {
                    return false;
                }
                let mut ids = std::collections::HashSet::new();
                return rows.iter().all(|row| {
                    let Some(obj) = row.as_object() else {
                        return false;
                    };
                    required.iter().all(|field| {
                        obj.get(*field).is_some_and(|v| match v {
                            Value::Null => false,
                            Value::String(s) => !s.trim().is_empty(),
                            Value::Array(a) => !a.is_empty(),
                            Value::Object(o) => !o.is_empty(),
                            _ => true,
                        })
                    }) && obj
                        .get("id")
                        .and_then(Value::as_str)
                        .is_none_or(|id| !id.trim().is_empty() && ids.insert(id.to_string()))
                });
            }
            false
        })
}

pub(crate) fn pending_artifact_checks_impl(conn: &Connection) -> Vec<PendingArtifactDto> {
    let mut out = Vec::new();
    let Ok(rows) = query_workspaces(conn) else {
        return out;
    };
    // 每个 repo 只读一次 project.toml
    let mut configs: std::collections::HashMap<String, crate::projects::ProjectConfigDto> =
        std::collections::HashMap::new();
    for w in rows.into_iter().filter(|w| w.status == "active") {
        let cfg = configs
            .entry(w.repo_path.clone())
            .or_insert_with(|| crate::projects::read_config_at(Path::new(&w.repo_path)).config);
        let Some(step) = cfg
            .steps
            .iter()
            .find(|s| !s.workspace_name.is_empty() && s.workspace_name == w.name)
        else {
            continue;
        };
        if step.expected_artifacts.is_empty() {
            continue;
        }
        let Ok(created) = chrono::DateTime::parse_from_rfc3339(&w.created_at) else {
            continue; // 创建时间不可解析时不猜，宁缺勿报
        };
        let since: SystemTime = created.into();
        let root = PathBuf::from(&w.worktree_path);
        if step.expected_artifacts.iter().all(|a| {
            if step
                .acceptance_criteria
                .contains(&format!("machine:optional-empty:{a}"))
            {
                rooted_existing_path(&root, a)
                    .and_then(|p| fs::metadata(p).ok())
                    .is_some_and(|m| m.is_file() && m.modified().is_ok_and(|t| t >= since))
            } else {
                artifact_produced_since(&root, a, since)
            }
        }) && machine_acceptance_satisfied(&root, &step.acceptance_criteria, since)
        {
            out.push(PendingArtifactDto {
                workspace_id: w.id,
                workspace_name: w.name,
                repo_name: w.repo_name,
            });
        }
    }
    out
}

#[tauri::command]
pub async fn pending_artifact_checks() -> Vec<PendingArtifactDto> {
    tauri::async_runtime::spawn_blocking(|| {
        db().map(|c| pending_artifact_checks_impl(&c))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

// ===== 人工事项（步骤的人机分工清单）：声明在 project.toml steps[].human_tasks，
// 状态不进档案卡——手动勾选存 app.db human_task_checks 表（checked=1/0 分别表示显式完成/未完成），
// 落点检测按文件系统现算；没有显式状态时才回落检测结果 =====

/// 单个人工事项的派生状态（list_human_task_states 返回，按步骤顺序平铺）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanTaskStateDto {
    pub step: String,
    pub title: String,
    pub guidance: String,
    pub target: String,
    pub timing: String,
    /// 可选事项：不做也不影响这一步跑完；UI 标「可选」且不计入待做数
    pub optional: bool,
    /// 落点位置检测到文件（空 target 恒 false——纯脑力事项只能手勾）
    pub detected: bool,
    /// 落点命中的文件数（目录/通配形态现算，两侧检测根取 max 防合并后重复计数；
    /// 精确文件命中=1；空 target/未命中=None）——「已见到 N 个文件」的进度感
    pub hit_count: Option<usize>,
    /// 待获取清单总篇数（仅 papers/*.pdf 落点且同侧根存在 papers/to-fetch.md 时现算，
    /// 数条目行：非空、非 # 开头、非「为空」注明行；否则 None）
    pub expected_count: Option<usize>,
    /// 后端采用的完成判定口径
    pub completion: String,
    /// 人手动勾为完成
    pub manual: bool,
    /// 人手动取消（checked=0）。自动勾选必须跳过，避免取消后又被勾回来。
    pub explicit_cancel: bool,
    /// 最终完成态（显式勾选/取消优先；无显式状态时回落 detected，前端不再重算）
    pub done: bool,
}

fn ensure_human_task_checks_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS human_task_checks(
          project_path TEXT NOT NULL, step TEXT NOT NULL, title TEXT NOT NULL,
          updated_at TEXT, PRIMARY KEY(project_path, step, title));",
    )
    .map_err(|e| format!("初始化 human_task_checks 表失败: {e}"))?;
    // checked 列（v3.89）：0 = 用户**显式取消**。原表只能记「勾了」，
    // 取消就是删行、回落检测口径——落点里有文件时会立刻自动勾回来，表现为「取消不了」。
    // 已存在时报错，忽略即可（SQLite 无 IF NOT EXISTS COLUMN）
    let _ = conn.execute(
        "ALTER TABLE human_task_checks ADD COLUMN checked INTEGER NOT NULL DEFAULT 1",
        [],
    );
    Ok(())
}

/// 按项目读手动勾选。项目键跨方言比较（same_path）：存量库可能混有 verbatim / 大小写不同的
/// 写法，精确等值查询在 Windows 上会漏行。同一事项多行并存时，精确键优先，其次取最新一行。
fn manual_checks_at(
    conn: &Connection,
    project_path: &str,
) -> std::collections::HashMap<(String, String), bool> {
    let mut best: std::collections::HashMap<(String, String), (bool, String, bool)> =
        std::collections::HashMap::new();
    if ensure_human_task_checks_table(conn).is_err() {
        return std::collections::HashMap::new();
    }
    if let Ok(mut stmt) =
        conn.prepare("SELECT project_path, step, title, checked, updated_at FROM human_task_checks")
    {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (r.get::<_, String>(1)?, r.get::<_, String>(2)?),
                r.get::<_, i64>(3)? != 0,
                r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            ))
        }) {
            for (path, key, checked, updated) in rows.flatten() {
                if !crate::paths::same_path(&path, project_path) {
                    continue;
                }
                let exact = path == project_path;
                let better = match best.get(&key) {
                    None => true,
                    Some((e, u, _)) => (exact, &updated) > (*e, u),
                };
                if better {
                    best.insert(key, (exact, updated, checked));
                }
            }
        }
    }
    best.into_iter().map(|(k, (_, _, v))| (k, v)).collect()
}

/// 极简通配匹配：仅支持 `*`（任意字符序列），大小写敏感（两指针 + 星号回退点）
fn wildcard_match(pattern: &str, name: &str) -> bool {
    let pc: Vec<char> = pattern.chars().collect();
    let nc: Vec<char> = name.chars().collect();
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star_p, mut star_n) = (None, None);
    while ni < nc.len() {
        if pi < pc.len() && pc[pi] == nc[ni] {
            pi += 1;
            ni += 1;
        } else if pi < pc.len() && pc[pi] == '*' {
            star_p = Some(pi);
            star_n = Some(ni);
            pi += 1;
        } else if let (Some(sp), Some(sn)) = (star_p, star_n) {
            pi = sp + 1;
            ni = sn + 1;
            star_n = Some(ni);
        } else {
            return false;
        }
    }
    while pi < pc.len() && pc[pi] == '*' {
        pi += 1;
    }
    pi == pc.len()
}

/// 列出相对 `root`、匹配 pattern 的现有文件（空文件不计）。
/// `notes/*.md` = 该目录下一层；`notes/` = 该目录下所有非隐藏文件；精确路径 = 该文件。
/// 绝对路径 / `..` 一律空。供开步输入芯片与合并后自动提货共用。
pub(crate) fn glob_files_at(root: &Path, pattern: &str) -> Vec<PathBuf> {
    let pattern = pattern.trim().replace('\\', "/");
    if pattern.is_empty() || pattern.contains("..") {
        return Vec::new();
    }
    if Path::new(&pattern).is_absolute() {
        return Vec::new();
    }
    let is_file_ok = |p: &Path| {
        fs::metadata(p)
            .map(|m| m.is_file() && m.len() > 0)
            .unwrap_or(false)
    };
    if let Some(star) = pattern.rfind('*') {
        if pattern[..star].contains('*') {
            return Vec::new();
        }
        let (dir, file_pat) = match pattern.rfind('/') {
            Some(idx) => (&pattern[..idx], &pattern[idx + 1..]),
            None => ("", pattern.as_str()),
        };
        if file_pat.is_empty() {
            return Vec::new();
        }
        let dir_path = if dir.is_empty() {
            root.to_path_buf()
        } else {
            root.join(dir)
        };
        let Ok(rd) = fs::read_dir(&dir_path) else {
            return Vec::new();
        };
        let mut out: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                is_file_ok(p)
                    && wildcard_match(
                        file_pat,
                        &p.file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                    )
            })
            .collect();
        out.sort();
        return out;
    }
    if pattern.ends_with('/') {
        let dir_path = root.join(pattern.trim_end_matches('/'));
        let Ok(rd) = fs::read_dir(&dir_path) else {
            return Vec::new();
        };
        let mut out: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                is_file_ok(p)
                    && !p
                        .file_name()
                        .map(|n| n.to_string_lossy().starts_with('.'))
                        .unwrap_or(true)
            })
            .collect();
        out.sort();
        return out;
    }
    let path = root.join(&pattern);
    if is_file_ok(&path) {
        vec![path]
    } else {
        Vec::new()
    }
}

/// 合并后按本步 expected_artifacts 扫项目根，命中且未被 git 跟踪的文件自动登记提货单。
/// 已跟踪的（笔记、源稿）跳过——它们随分支走。失败单条跳过，不阻断合并。
fn register_expected_artifacts_at(repo: &Path, workspace_name: &str) -> String {
    let cfg = crate::projects::read_config_at(repo).config;
    let Some(step) = cfg
        .steps
        .iter()
        .find(|s| !s.workspace_name.is_empty() && s.workspace_name == workspace_name)
    else {
        return String::new();
    };
    if step.expected_artifacts.is_empty() {
        return String::new();
    }
    let mut n = 0usize;
    for pattern in &step.expected_artifacts {
        for file in glob_files_at(repo, pattern) {
            let name = file
                .file_name()
                .map(|x| x.to_string_lossy().into_owned())
                .unwrap_or_else(|| pattern.clone());
            if register_artifact_impl(repo, &name, &file, workspace_name).is_ok() {
                n += 1;
            }
        }
    }
    if n == 0 {
        String::new()
    } else {
        format!("已自动登记 {n} 个产物进提货单")
    }
}

/// 落点检测：root 下是否已有交付物。
/// 三种形态：目录（结尾 /）= 内有任意非隐藏文件；目录/通配 = 目录内有匹配文件（不递归）；
/// 精确文件 = 存在。只接受根的相对路径，绝对路径/.. 逃逸一律视为未交付（同产物核验口径）。
// 仅测试调用（运行侧走 human_target_count 计数口径）
#[cfg(test)]
pub(crate) fn human_target_hit(root: &Path, target: &str) -> bool {
    human_target_count(root, target).is_some_and(|n| n > 0)
}

/// 落点命中计数（v3.97）：与 human_target_hit 同口径，但返回命中文件数而非布尔——
/// 供「已见到 N 个文件」的进度展示。None = 未命中/异常（异常巨大目录同原口径不按交付计）。
pub(crate) fn human_target_count(root: &Path, target: &str) -> Option<usize> {
    let rel = target.trim();
    if rel.is_empty() {
        return None;
    }
    let is_dir_entry = rel.ends_with('/') || rel.ends_with('\\');
    let rel = rel.trim_end_matches(['/', '\\']);
    if rel.is_empty() || rel.contains("..") || Path::new(rel).is_absolute() {
        return None;
    }
    let visible_file = |e: &fs::DirEntry| {
        !e.file_name().to_string_lossy().starts_with('.')
            && e.metadata().map(|m| m.is_file()).unwrap_or(false)
    };
    if is_dir_entry {
        // 目录形态：递归数非隐藏文件（用户可能放进子目录），限量防暴走
        let mut stack = vec![root.join(rel)];
        let mut visited = 0usize;
        let mut count = 0usize;
        while let Some(dir) = stack.pop() {
            let Ok(rd) = fs::read_dir(dir) else { continue };
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                visited += 1;
                if visited > 2000 || stack.len() > 64 {
                    return None; // 异常巨大的目录不按交付计
                }
                let Ok(m) = e.metadata() else { continue };
                if m.is_file() {
                    count += 1;
                } else if m.is_dir() {
                    stack.push(e.path());
                }
            }
        }
        return (count > 0).then_some(count);
    }
    if rel.contains('*') {
        // 只允许通配在最后一段；目录部分仍须是纯相对路径
        let (dir, pattern) = match rel.rsplit_once('/') {
            Some((d, p)) => (d, p),
            None => ("", rel),
        };
        if pattern.is_empty() || dir.contains('*') {
            return None;
        }
        let dir_path = if dir.is_empty() {
            root.to_path_buf()
        } else {
            root.join(dir)
        };
        let Ok(rd) = fs::read_dir(dir_path) else {
            return None;
        };
        let count = rd
            .flatten()
            .filter(|e| {
                visible_file(e) && wildcard_match(pattern, &e.file_name().to_string_lossy())
            })
            .count();
        return (count > 0).then_some(count);
    }
    match fs::metadata(root.join(rel)) {
        Ok(m) if m.is_file() => Some(1),
        _ => None,
    }
}

/// 待获取清单总篇数（v3.97）：仅 papers/*.pdf 落点且根下存在 papers/to-fetch.md 时现算。
/// 条目口径与前端 src/step-flow.ts parseToFetchItems 双端镜像（改动需同步）：
/// 编号行（N. / N、 / N)）与列表行（- / * / +）都算条目（不必带链接，✓ 勾选标记剥掉）；
/// 裸行必须带「 — DOI/链接」尾巴才算——挡住顶部说明文字与「待补」占位行。
/// （2026-09-16 前的旧口径「非空非 # 行全算」会把说明行多数进去，
/// 与展开面板的条目数对不上，且导致补齐全量后 completion=all 永不满足）
fn to_fetch_entry_count(root: &Path, target: &str) -> Option<usize> {
    if target.trim().replace('\\', "/") != "papers/*.pdf" {
        return None;
    }
    let text = fs::read_to_string(root.join("papers").join("to-fetch.md")).ok()?;
    Some(to_fetch_entries_in(&text))
}

/// 条目数：条目开始后遇到分隔线（--- / *** / ___）即止——之后是别的内容（如精读汇总的
/// 「待跟进引用线索」），不是待获取（2026-10-18 实测 42 条被数成 108）。与前端同口径。
fn to_fetch_entries_in(text: &str) -> usize {
    let mut count = 0;
    for raw in text.lines() {
        let line = raw.trim();
        let rule = line.len() >= 3
            && (line.chars().all(|c| c == '-')
                || line.chars().all(|c| c == '*')
                || line.chars().all(|c| c == '_'));
        if count > 0 && rule {
            break;
        }
        if to_fetch_line_is_entry(line) {
            count += 1;
        }
    }
    count
}

/// to-fetch.md 单行是否算一条条目（to_fetch_entry_count 的口径内核）。
/// 前缀判定与正则 `^(\d+)[.、)]\s+(✓\s*)?(.+)$` / `^[-*+]\s+(✓\s*)?(.+)$` 对齐：
/// 前缀后必须有空白、剥 ✓ 后正文非空；两种前缀都不匹配时按裸行处理
fn to_fetch_line_is_entry(raw: &str) -> bool {
    let line = raw.trim();
    if line.is_empty() || line.starts_with('#') {
        return false;
    }
    match strip_to_fetch_marker(line) {
        Some(rest) => {
            let body = rest.strip_prefix('✓').unwrap_or(rest).trim_start();
            !body.is_empty()
        }
        None => to_fetch_bare_has_link_tail(line),
    }
}

/// 剥掉条目行的编号（N. / N、 / N)）或列表符号（- / * / +）前缀；
/// 前缀后必须紧跟空白（前端正则的 `\s+`），否则不算条目前缀，返回 None
fn strip_to_fetch_marker(line: &str) -> Option<&str> {
    let digits = line.len() - line.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let after_digits = &line[digits..];
    let marker_end = if digits > 0 {
        // 编号必须带 [.、)] 之一收尾
        match after_digits.chars().next() {
            Some(c @ ('.' | '、' | ')')) => digits + c.len_utf8(),
            _ => return None,
        }
    } else {
        match after_digits.chars().next() {
            Some(c @ ('-' | '*' | '+')) => c.len_utf8(),
            _ => return None,
        }
    };
    let rest = &line[marker_end..];
    let ws = rest.len() - rest.trim_start().len();
    (ws > 0).then(|| &rest[ws..])
}

/// 裸行条目判定：分隔符后面的某一段里含 DOI 或 http 链接。
/// 不要求链接占满最后一段——DOI 后面再挂刊名、〔OA〕仍是一条。
fn to_fetch_bare_has_link_tail(line: &str) -> bool {
    let mut i = 0;
    while i < line.len() {
        if let Some(after) = strip_to_fetch_separator(&line[i..]) {
            if to_fetch_looks_link(after) {
                return true;
            }
            i = line.len() - after.len();
        } else {
            i += line[i..].chars().next().map_or(1, char::len_utf8);
        }
    }
    false
}

/// rest 以「空白+（— 或 --）+空白」开头时返回分隔符之后的剩余串
fn strip_to_fetch_separator(rest: &str) -> Option<&str> {
    let ws = rest.len() - rest.trim_start().len();
    if ws == 0 {
        return None;
    }
    let after_ws = &rest[ws..];
    let dash = if after_ws.starts_with('—') {
        '—'.len_utf8()
    } else if after_ws.starts_with("--") {
        2
    } else {
        return None;
    };
    let after_dash = &after_ws[dash..];
    let ws2 = after_dash.len() - after_dash.trim_start().len();
    (ws2 > 0).then(|| &after_dash[ws2..])
}

/// 段内是否含能打开的 DOI 或 http 链接。整段就是 DOI 时算；DOI 后面再挂刊名、
/// 〔OA〕、缩写也算。与前端 linkTokenFromSegment 同一口径：链接可以嵌在段里，
/// 不必占满整段。
fn to_fetch_looks_link(seg: &str) -> bool {
    let s = seg.trim();
    let lower = s.to_ascii_lowercase();
    if lower.contains("http://") || lower.contains("https://") {
        return true;
    }
    let rest = lower.strip_prefix("doi:").unwrap_or(&lower).trim_start();
    let Some(at) = rest.find("10.") else {
        return false;
    };
    let after = &rest[at + 3..];
    let digits = after.len() - after.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    (4..=9).contains(&digits) && after[digits..].starts_with('/') && after.len() > digits + 1
}

/// 通用人工事项清单计数：每行一个目标，忽略空行、标题和注释。
fn manifest_entry_count(root: &Path, manifest_path: &str) -> Option<usize> {
    let rel = manifest_path.trim();
    if rel.is_empty() || rel.contains('*') || rel.contains("..") || Path::new(rel).is_absolute() {
        return None;
    }
    let text = fs::read_to_string(root.join(rel)).ok()?;
    Some(
        text.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .count(),
    )
}

fn is_text_target(target: &str) -> bool {
    let rel = target.trim().trim_end_matches(['/', '\\']);
    let Some(ext) = Path::new(rel).extension().and_then(|x| x.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "md" | "qmd"
            | "txt"
            | "tex"
            | "sty"
            | "cls"
            | "bib"
            | "json"
            | "jsonl"
            | "yaml"
            | "yml"
            | "toml"
            | "csv"
            | "tsv"
            | "rst"
    )
}

/// `no_placeholders` 完成判定：精确文件存在且不再包含常见待填标记。
fn no_placeholders_hit(root: &Path, target: &str) -> bool {
    let rel = target.trim().trim_end_matches(['/', '\\']);
    if rel.is_empty() || rel.contains('*') || rel.contains("..") || Path::new(rel).is_absolute() {
        return false;
    }
    if !is_text_target(rel) {
        return false;
    }
    let Ok(text) = fs::read_to_string(root.join(rel)) else {
        return false;
    };
    !["待填", "待确认", "[待补", "TODO"]
        .iter()
        .any(|mark| text.contains(mark))
}

/// 审查报告的「决定：」或待核实清单的「裁决：」是否已经是人的拍板。
/// 接受/拒绝/修改，以及确认/删除该论断/改正为…，算拍完。待定、待裁决、空着不算。
fn decision_value_cleared(value: &str) -> bool {
    let value = value.split(['|', '｜']).next().unwrap_or(value).trim();
    if value.is_empty() || value.starts_with('（') || value.starts_with('(') {
        return false;
    }
    if value == "接受" || value == "拒绝" || value == "确认" || value == "删除该论断" {
        return true;
    }
    if let Some(note) = value.strip_prefix("修改：").or_else(|| value.strip_prefix("修改:")) {
        return !note.trim().is_empty();
    }
    value.starts_with("改正为") && !value["改正为".len()..].trim().is_empty()
}

/// 审查条目编号：R001 / S001 / V001，可带标题符或列表符。
fn review_item_id(line: &str) -> Option<&str> {
    let line = line
        .trim()
        .trim_start_matches('#')
        .trim()
        .trim_start_matches(['-', '*'])
        .trim();
    let mut chars = line.chars();
    let prefix = chars.next()?;
    if prefix != 'R' && prefix != 'S' && prefix != 'V' {
        return None;
    }
    let digits = chars.clone().take_while(|ch| ch.is_ascii_digit()).count();
    if digits < 3 {
        return None;
    }
    let end = 1 + digits;
    if let Some(boundary) = line[end..].chars().next() {
        if boundary.is_ascii_alphanumeric() {
            return None;
        }
    }
    Some(&line[..end])
}

/// `decisions_cleared` 完成判定：文件里每一条都有拍板，且没有「待裁决」。
/// 审查报告认「决定：接受/拒绝/修改：…」；待核实清单认「裁决：确认/删除该论断/改正为…」。
/// 只点了一条、其余还空着，不算完成。
fn decisions_cleared_hit(root: &Path, target: &str) -> bool {
    let rel = target.trim().trim_end_matches(['/', '\\']);
    if rel.is_empty() || rel.contains('*') || rel.contains("..") || Path::new(rel).is_absolute() {
        return false;
    }
    if !is_text_target(rel) {
        return false;
    }
    let Ok(text) = fs::read_to_string(root.join(rel)) else {
        return false;
    };
    if text.contains("待裁决") {
        return false;
    }
    let mut ids = Vec::<String>::new();
    let mut decided = std::collections::HashSet::<String>::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        if let Some(id) = review_item_id(line) {
            let id = id.to_string();
            if !ids.contains(&id) {
                ids.push(id.clone());
            }
            current = Some(id);
        }
        let trimmed = line.trim().trim_start_matches(['-', '*']).trim();
        let value = trimmed
            .strip_prefix("决定：")
            .or_else(|| trimmed.strip_prefix("决定:"))
            .or_else(|| trimmed.rsplit_once("裁决：").map(|(_, value)| value))
            .or_else(|| trimmed.rsplit_once("裁决:").map(|(_, value)| value));
        let Some(value) = value else {
            continue;
        };
        if !decision_value_cleared(value) {
            return false;
        }
        let Some(id) = current.clone() else {
            return false;
        };
        decided.insert(id);
    }
    !ids.is_empty() && ids.iter().all(|id| decided.contains(id))
}

fn human_target_satisfied(
    root: &Path,
    target: &str,
    completion: &str,
    hit_count: Option<usize>,
    expected_count: Option<usize>,
    manifest_path: &str,
) -> bool {
    match completion {
        "manual" => false,
        "all" => match expected_count.or_else(|| manifest_entry_count(root, manifest_path)) {
            Some(expected) if expected == 0 => true,
            Some(expected) => hit_count.unwrap_or(0) >= expected,
            None => false,
        },
        "no_placeholders" => no_placeholders_hit(root, target),
        "decisions_cleared" => decisions_cleared_hit(root, target),
        _ => hit_count.is_some(),
    }
}

/// 步骤人工事项的检测根列表：项目根恒在；步骤绑定了活跃工作区时工作树根也算
/// （交付落在哪一侧都算数——开工前的事项多在主仓，执行中的事项多在工作树）
fn human_detection_roots(
    conn: Option<&Connection>,
    project_root: &Path,
    workspace_name: &str,
) -> Vec<PathBuf> {
    let mut roots = vec![project_root.to_path_buf()];
    if workspace_name.is_empty() {
        return roots;
    }
    if let Some(conn) = conn {
        let key = project_root.to_string_lossy().into_owned();
        if let Ok(rows) = query_workspaces(conn) {
            for w in rows {
                if w.status == "active"
                    && w.name == workspace_name
                    && crate::paths::same_path(
                        &crate::projects::canonical_key(Path::new(&w.repo_path)),
                        &key,
                    )
                {
                    roots.push(PathBuf::from(w.worktree_path));
                }
            }
        }
    }
    roots
}

/// 工作树对应的工作区已保存进项目：合并过（merged_at）且分支没有基准分支以外的新提交。
/// 恢复后又提交的轮次不算（2026-11-05）。查不到行或 git 出错按「没保存」处理。
fn saved_worktree(conn: Option<&Connection>, wt: &Path) -> bool {
    let Some(conn) = conn else { return false };
    let wt_key = wt.to_string_lossy();
    let Ok(rows) = query_workspaces(conn) else { return false };
    rows.iter()
        .find(|w| crate::paths::same_path(&w.worktree_path, &wt_key))
        .is_some_and(|w| {
            w.merged_at.is_some()
                && git_is_ancestor(wt, "HEAD", &w.base_branch).unwrap_or(false)
        })
}

pub(crate) fn list_human_task_states_at(root: &Path) -> Vec<HumanTaskStateDto> {
    let cfg = crate::projects::read_config_at(root).config;
    if cfg.steps.iter().all(|s| s.human_tasks.is_empty()) {
        return Vec::new();
    }
    let conn = db().ok();
    if let Some(c) = &conn {
        let _ = ensure_human_task_checks_table(c);
    }
    let key = root.to_string_lossy().into_owned();
    let manual = conn
        .as_ref()
        .map(|c| manual_checks_at(c, &key))
        .unwrap_or_default();
    let mut out = Vec::new();
    for step in &cfg.steps {
        for h in &step.human_tasks {
            let roots = human_detection_roots(conn.as_ref(), root, &step.workspace_name);
            // 计数取两侧根的 max：合并后同一文件在项目根与工作树各有一份，相加会重复计数
            let hit_count = roots
                .iter()
                .filter_map(|r| human_target_count(r, &h.target))
                .max();
            let expected_count = roots
                .iter()
                .filter_map(|r| {
                    h.expected_count.or_else(|| {
                        to_fetch_entry_count(r, &h.target)
                            .or_else(|| manifest_entry_count(r, &h.manifest_path))
                    })
                })
                .max();
            let completion = crate::projects::normalize_human_completion(&h.completion);
            // 逐条裁决这类「文件里条目都拍板了」的判定只看一份：工作区里有这份文件就看工作区的（这一轮 AI 新写的），
            // 否则看项目根。原先两边任一满足即算完成——项目根里上一轮全裁决完的旧报告，会把这一轮还没裁决的也判成完成，
            // 面板随之消失（2026-11-05 排查）
            // 已保存进项目的步骤（合并过、分支没再前进）界面把裁决写进项目根，工作区那份是旧的：看项目根
            let judged: Vec<&PathBuf> = if completion == "decisions_cleared" {
                roots
                    .iter()
                    .rev()
                    .filter(|r| *r == &roots[0] || !saved_worktree(conn.as_ref(), r))
                    .find(|r| r.join(&h.target).is_file())
                    .into_iter()
                    .collect()
            } else {
                roots.iter().collect()
            };
            let detected = judged.iter().any(|r| {
                human_target_satisfied(
                    r,
                    &h.target,
                    &completion,
                    human_target_count(r, &h.target),
                    h.expected_count
                        .or_else(|| to_fetch_entry_count(r, &h.target)),
                    &h.manifest_path,
                )
            });
            // 手动优先（v3.89）：显式取消（checked=0）时**检测命中也不算完成**——
            // 否则落点里有文件就会自动勾回来，用户取消不掉（实测 bug）
            let manual_state = manual.get(&(step.name.clone(), h.title.clone())).copied();
            out.push(HumanTaskStateDto {
                step: step.name.clone(),
                title: h.title.clone(),
                guidance: h.guidance.clone(),
                target: h.target.clone(),
                timing: h.timing.clone(),
                optional: h.optional,
                detected,
                hit_count,
                expected_count,
                completion,
                manual: manual_state == Some(true),
                explicit_cancel: manual_state == Some(false),
                done: match manual_state {
                    Some(v) => v,
                    None => detected,
                },
            });
        }
    }
    out
}

#[tauri::command]
pub async fn list_human_task_states(
    project_root: String,
) -> Result<Vec<HumanTaskStateDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(crate::sessions::expand_tilde(&project_root));
        // 与 set_human_task_check（ensure_task_project_root）同口径剥 verbatim：
        // Windows 上 `\\?\C:\…` 当键查不到普通形式写入的勾选行，勾完一刷新就丢
        let root =
            crate::paths::canonicalize_plain(&root).map_err(|e| format!("项目目录无效: {e}"))?;
        // list 口径同 list_task_cards：非项目（无档案卡）返回空表，不设门槛
        Ok(list_human_task_states_at(&root))
    })
    .await
    .map_err(|e| format!("读取人工事项状态失败: {e}"))?
}

#[tauri::command]
pub async fn set_human_task_check(
    project_root: String,
    step: String,
    title: String,
    checked: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(
                &project_root,
            )))?;
        let conn = db()?;
        ensure_human_task_checks_table(&conn)?;
        let key = root.to_string_lossy().into_owned();
        if checked {
            conn.execute(
                "INSERT OR REPLACE INTO human_task_checks(project_path, step, title, updated_at, checked)
                 VALUES(?1, ?2, ?3, ?4, 1)",
                params![key, step, title, crate::sessions::now_iso()],
            )
            .map_err(|e| format!("勾选人工事项失败: {e}"))?;
        } else {
            // 取消勾选 = 落 checked=0（显式取消），不再删行——删行会回落检测口径，
            // 落点里有文件时立刻自动勾回来，用户取消不掉（v3.89 修）
            conn.execute(
                "INSERT OR REPLACE INTO human_task_checks(project_path, step, title, updated_at, checked)
                 VALUES(?1, ?2, ?3, ?4, 0)",
                params![key, step, title, crate::sessions::now_iso()],
            )
            .map_err(|e| format!("取消勾选失败: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("更新人工事项勾选失败: {e}"))?
}

/// 开新一轮（退回补料、跟进、新开一轮）时清掉这一步手动打的勾，回到按落点检测（2026-11-05 排查）：
/// 手动勾优先于检测，原先勾过一次就永远算完成——新一轮写出新的待裁决条目、补了新的待获取篇目，面板也不再出现。
/// 只删 checked=1；人显式取消的（checked=0）留着。
#[tauri::command]
pub async fn clear_human_task_checks(project_root: String, step: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(
            &project_root,
        )))?;
        let conn = db()?;
        ensure_human_task_checks_table(&conn)?;
        conn.execute(
            "DELETE FROM human_task_checks WHERE project_path=?1 AND step=?2 AND checked=1",
            params![root.to_string_lossy().into_owned(), step],
        )
        .map_err(|e| format!("清人工事项勾选失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("清人工事项勾选失败: {e}"))?
}

// ===== 人工交付导入：选中的外部文件复制进落点目录 + 登记提货单 =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDeliverableDto {
    /// 复制后的绝对路径
    pub dest_path: String,
    /// 相对落点根（项目根或工作树根），正斜杠
    pub dest_rel: String,
    /// 落点根（文献 PDF 与 papers/ 强制项目根；其余工作树优先，无活跃工作区 = 项目根）
    pub dest_root: String,
    /// 提货单登记是否成功（文件已复制；失败原因在 register_error）
    pub registered: bool,
    pub register_error: Option<String>,
}

/// 文献 PDF 与 papers/ 下落点：强制项目根。这些文件不进 git，写在工作区会在合并后丢失。
fn project_root_deliverable_target(target: &str, source: &Path) -> bool {
    let t = target
        .replace('\\', "/")
        .trim()
        .trim_end_matches('/')
        .to_ascii_lowercase();
    if t == "papers" || t.starts_with("papers/") || t.ends_with(".pdf") {
        return true;
    }
    source
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrozenDeliverable {
    pub path: String,
    pub size: u64,
    pub sha256: Option<String>,
    pub disposition: String,
    /// 流程要用、不能勾掉（这一步声明的预期产物、papers/ 下的文献资料）。每次出评审现算，
    /// 不信盘上旧值
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverableReviewDto {
    pub token: String,
    pub workspace_id: String,
    pub project_root: String,
    pub payload_dir: String,
    pub files: Vec<FrozenDeliverable>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PipelineFilePending {
    review_token: String,
    fact: crate::projects::AcceptanceLogEntry,
    #[serde(default)]
    before_sha: Option<String>,
    #[serde(default)]
    files_applied: bool,
    #[serde(default)]
    tracked_after_review: Vec<String>,
}

fn save_delivery_pending(id: &str, pending: &PipelineFilePending) -> Result<(), String> {
    crate::profiles::atomic_write(
        &delivery_pending_path(id)?,
        &serde_json::to_string_pretty(pending).map_err(|e| e.to_string())?,
    )
}

fn original_merge_commit(
    repo: &Path,
    base: &str,
    before: &str,
    reviewed: &str,
) -> Result<Option<String>, String> {
    let history = run_git(
        repo,
        &[
            "log",
            "--first-parent",
            "-n",
            "1000",
            "--format=%H %P",
            base,
        ],
        Duration::from_secs(30),
    )?;
    Ok(history.lines().find_map(|line| {
        let parts: Vec<_> = line.split_whitespace().collect();
        (parts.len() == 3 && parts[1] == before && parts[2] == reviewed)
            .then(|| parts[0].to_string())
    }))
}

fn delivery_review_root(id: &str) -> Result<PathBuf, String> {
    crate::paths::validate_fs_name(id)?;
    Ok(crate::review_contract::pending_dir()?
        .join("delivery-reviews")
        .join(id))
}

fn delivery_pending_path(id: &str) -> Result<PathBuf, String> {
    Ok(delivery_review_root(id)?.join("apply-pending.json"))
}

/// 人在评审页勾掉、不带回项目的非 Git 产物（2026-10-22）：路径 → 勾掉时那一版的 SHA-256。
/// 按指纹记：文件之后变了就是没看过的新版，回到默认带回。重新冻结（刷新评审）时照这份恢复勾选。
fn delivery_skips_path(id: &str) -> Result<PathBuf, String> {
    Ok(delivery_review_root(id)?.join("skipped.json"))
}

/// 读不出（缺失 / 损坏）按「全部带回」处理：错的方向只是多带回文件，不会丢
fn read_delivery_skips(id: &str) -> std::collections::BTreeMap<String, String> {
    delivery_skips_path(id)
        .ok()
        .and_then(|p| fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_delivery_skips(id: &str, skips: &std::collections::BTreeMap<String, String>) -> Result<(), String> {
    crate::profiles::atomic_write(
        &delivery_skips_path(id)?,
        &serde_json::to_string_pretty(skips).map_err(|e| e.to_string())?,
    )
}

fn read_delivery_pending(id: &str) -> Result<Option<PipelineFilePending>, String> {
    match fs::read(delivery_pending_path(id)?) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("科研产物恢复记录损坏：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn delivery_hash(path: &Path) -> Result<(u64, String), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(format!("产物不是普通文件：{}", path.display()));
    }
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = sha2::Sha256::new();
    let mut size = 0u64;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > 1024 * 1024 * 1024 {
            return Err("产物超过 1 GB 冻结预算，请拆分后评审".into());
        }
        hash.update(&buf[..n]);
    }
    Ok((size, format!("{:x}", hash.finalize())))
}

/// 两份产物内容一样（都是普通文件、指纹相同）。读不了、是链接、超预算都当不一样，走原来的冲突口径
fn same_delivery_content(a: &Path, b: &Path) -> bool {
    match (delivery_hash(a), delivery_hash(b)) {
        (Ok((_, x)), Ok((_, y))) => x == y,
        _ => false,
    }
}

fn copy_delivery_snapshot(source: &Path, dest: &Path) -> Result<(u64, String), String> {
    let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
    fs::create_dir_all(dest.parent().ok_or("冻结目录无效")?).map_err(|e| e.to_string())?;
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(dest).map_err(|e| e.to_string())?;
    let mut hash = sha2::Sha256::new();
    let mut size = 0u64;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > 1024 * 1024 * 1024 {
            return Err("产物增长超过 1 GB，未发布快照".into());
        }
        hash.update(&buf[..n]);
        output.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    output.sync_all().map_err(|e| e.to_string())?;
    Ok((size, format!("{:x}", hash.finalize())))
}

fn tracked_delivery_paths(worktree: &Path) -> Result<std::collections::HashSet<String>, String> {
    let text = run_git(
        worktree,
        &["-c", "core.quotepath=false", "ls-files", "-z"],
        Duration::from_secs(30),
    )?;
    Ok(text
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect())
}

/// 检索过程留下的缓存和脚本。不进非 Git 产物评审，也不随保存带回项目。
fn is_delivery_process_file(path: &str) -> bool {
    let path = path.replace('\\', "/");
    let base = path.rsplit('/').next().unwrap_or(path.as_str());
    if matches!(
        base,
        "included.json"
            | "help-wanted.md"
            | "outbox.jsonl"
            | "zotero-sync.md"
            | ".gitignore"
            | ".gitattributes"
            // 积累账与开工冻结的进料快照：gitignored 台账，不参与交付
            | "reading-list.md"
            | "handoff-lit-intake.md"
    ) {
        return true;
    }
    if path.contains("/api-cache/") || path.ends_with("/api-cache") {
        return true;
    }
    // 产物目录里的检索过程：接口响应、候选池、判定草稿、日志。
    // 不限 search 这一个名字。图、表、成稿不在这里，papers/ 里的清单也不在这里。
    if is_artifact_process_file(&path) {
        return true;
    }
    if path == ".ccode" || path.starts_with(".ccode/") || path.contains("/.ccode/") {
        return true;
    }
    if path == "scripts" || path.starts_with("scripts/") || path.contains("/scripts/") {
        return true;
    }
    // Quarto 把正文已引用的 figures/ 再拷进 output/figures/。源图已在 Git 里，
    // 这份副本不是新产物，列出来只显示「同名存在，不覆盖」。
    if path == "output/figures" || path.starts_with("output/figures/") {
        return true;
    }
    base.ends_with(".py")
}

/// 项目产物目录下的检索过程文件。目录名不限 search，扩展名是接口和草稿常用的那些。
fn is_artifact_process_file(path: &str) -> bool {
    let rest = path
        .strip_prefix("artifacts/")
        .or_else(|| path.split_once("/artifacts/").map(|(_, tail)| tail));
    let Some(rest) = rest else { return false };
    if rest.is_empty() {
        return false;
    }
    let base = rest.rsplit('/').next().unwrap_or(rest).to_ascii_lowercase();
    matches!(
        base.rsplit_once('.').map(|(_, ext)| ext),
        Some("json" | "jsonl" | "xml" | "tsv" | "log" | "txt")
    )
}

fn delivery_paths(worktree: &Path, repo: &Path) -> Result<Vec<String>, String> {
    let read = crate::projects::read_config_at(repo);
    if !read.warnings.is_empty() {
        return Err(format!(
            "项目档案无法完整读取，未冻结产物：{}",
            read.warnings.join("；")
        ));
    }
    let dir = read.config.artifact_dir.trim().replace('\\', "/");
    let artifact = if dir.is_empty() {
        "artifacts"
    } else {
        dir.as_str()
    };
    if Path::new(artifact).is_absolute()
        || artifact.split('/').any(|p| matches!(p, "" | "." | ".."))
    {
        return Err("产物目录必须是项目内相对路径".into());
    }
    let paths = crate::task_review::collect_scoped_files(
        worktree,
        &["papers".into(), artifact.into(), "output".into()],
    )?;
    // 接口缓存、临时脚本和仓库配置不是要带回项目的产物。
    // 留在工作区，不进冻结清单，也不挡 2000 项预算。
    let paths: Vec<String> = paths
        .into_iter()
        .filter(|path| !is_delivery_process_file(path))
        .collect();
    if paths.len() > DELIVERABLE_COPY_CAP {
        return Err("科研产物超过 2000 项，请缩小范围后评审".into());
    }
    Ok(paths)
}

fn assert_deliverables_retained(w: &WorkspaceDto, repo: &Path) -> Result<(), String> {
    let worktree = Path::new(&w.worktree_path);
    let tracked = tracked_delivery_paths(worktree)?;
    let skips = read_delivery_skips(&w.id);
    for path in delivery_paths(worktree, repo)? {
        if tracked.contains(&path) {
            continue;
        }
        let source = delivery_hash(&worktree.join(&path))?;
        // 人明确勾掉、且还是勾掉时那一版：不要它，归档时随工作区一起清掉
        if skips.get(&path) == Some(&source.1) {
            continue;
        }
        if delivery_hash(&repo.join(&path)).ok().as_ref() != Some(&source) {
            return Err(format!("非 Git 产物 {path} 尚未完整接收或在验收后变化，工作区仍保留；请先重新评审，不会随归档删除"));
        }
    }
    Ok(())
}

fn freeze_deliverables(w: &WorkspaceDto, repo: &Path) -> Result<DeliverableReviewDto, String> {
    let mut review = freeze_deliverables_at(
        &w.id,
        Path::new(&w.worktree_path),
        repo,
        &crate::projects::protected_paths_at(repo)?,
    )?;
    mark_required_deliverables(&mut review, w, repo)?;
    Ok(review)
}

/// 流程要用的非 Git 产物（2026-10-22 用户：哪些文件是流程必要的，这个不能取消）：
/// 这一步在档案里声明的预期产物（下一步按它取料、「产物 N/N 已产出」也按它数），
/// 加上 papers/ 下的文献资料（全文 PDF、导入题录，精读要读）。
fn delivery_required_patterns(w: &WorkspaceDto, repo: &Path) -> Vec<String> {
    let cfg = crate::projects::read_config_at(repo).config;
    let mut patterns: Vec<String> = cfg
        .steps
        .iter()
        .filter(|s| s.workspace_name == w.name)
        .flat_map(|s| s.expected_artifacts.iter().cloned())
        .collect();
    patterns.push("papers/".into());
    patterns
}

/// 按当前档案标 required；档案改过、以前勾掉的文件现在成了必要的，改回带回并落盘
fn mark_required_deliverables(
    review: &mut DeliverableReviewDto,
    w: &WorkspaceDto,
    repo: &Path,
) -> Result<(), String> {
    let patterns = delivery_required_patterns(w, repo);
    let mut changed = false;
    for file in &mut review.files {
        file.required = patterns
            .iter()
            .any(|p| crate::artifacts::expected_match(&file.path, p));
        if file.required && file.disposition == "skipped" {
            file.disposition = "copy".into();
            changed = true;
        }
    }
    if changed {
        crate::profiles::atomic_write(
            &delivery_review_root(&w.id)?.join(&review.token).join("review.json"),
            &serde_json::to_string_pretty(review).map_err(|e| e.to_string())?,
        )?;
    }
    Ok(())
}

fn freeze_deliverables_at(
    id: &str,
    worktree: &Path,
    repo: &Path,
    protected: &[String],
) -> Result<DeliverableReviewDto, String> {
    let tracked = tracked_delivery_paths(worktree)?;
    let skips = read_delivery_skips(id);
    let token = uuid::Uuid::new_v4().to_string();
    let dir = delivery_review_root(id)?.join(&token);
    let result = (|| {
        let mut review = DeliverableReviewDto {
            token: token.clone(),
            workspace_id: id.to_string(),
            project_root: crate::projects::canonical_key(repo),
            payload_dir: dir.join("payload").to_string_lossy().into_owned(),
            files: Vec::new(),
        };
        let mut total = 0u64;
        for path in delivery_paths(worktree, repo)? {
            if tracked.contains(&path) {
                continue;
            }
            let source = worktree.join(&path);
            let size = fs::metadata(&source).map_err(|e| e.to_string())?.len();
            let mut file = FrozenDeliverable {
                path: path.clone(),
                size,
                sha256: None,
                disposition: "copy".into(),
                required: false,
            };
            if crate::projects::path_is_protected(&path, &protected) {
                file.disposition = "protected".into();
            } else if repo.join(&path).exists() && !same_delivery_content(&source, &repo.join(&path)) {
                // 项目里同名且内容一样的不算冲突：照常冻结，带回时 apply 见到同指纹直接认作已到
                // （2026-11-10 HER：检索第二轮保存，上一轮已带回、一字未改的 artifacts/worklist.md 报「同名文件未覆盖」，挡了归档）
                file.disposition = "conflict".into();
            } else if size > 1024 * 1024 * 1024
                || total.saturating_add(size) > 4 * 1024 * 1024 * 1024
            {
                file.disposition = "too_large".into();
            }
            if file.disposition == "copy" {
                let (actual_size, sha) =
                    copy_delivery_snapshot(&source, &Path::new(&review.payload_dir).join(&path))?;
                total += actual_size;
                if total > 4 * 1024 * 1024 * 1024 {
                    return Err("科研产物快照超过 4 GB，未发布新快照".into());
                }
                file.size = actual_size;
                // 人勾掉过的同一版：照旧不带回（副本照冻，改回带回不用重看）
                if skips.get(&path) == Some(&sha) {
                    file.disposition = "skipped".into();
                }
                file.sha256 = Some(sha);
            }
            review.files.push(file);
        }
        crate::profiles::atomic_write(
            &dir.join("review.json"),
            &serde_json::to_string_pretty(&review).map_err(|e| e.to_string())?,
        )?;
        Ok(review)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&dir);
    } else {
        prune_delivery_snapshots(id);
    }
    result
}

/// 每打开一次评审就冻一份新快照（初稿带 PDF 时一份十几 MB），以前从不清（2026-10-24 HER 初稿
/// 攒了 9 份 142 MB）。留最新 3 份——另一个标签页可能还开着同一工作区的评审、拿着上一份——
/// 加上收尾恢复单指着的那份；恢复单读不出时一份都不删。
fn prune_delivery_snapshots(id: &str) {
    const KEEP: usize = 3;
    let Ok(root) = delivery_review_root(id) else { return };
    let Ok(pending) = read_delivery_pending(id) else { return };
    let Ok(entries) = fs::read_dir(&root) else { return };
    let mut snapshots: Vec<(SystemTime, PathBuf, String)> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            uuid::Uuid::parse_str(&name).ok()?;
            let path = e.path();
            let at = fs::metadata(path.join("review.json"))
                .or_else(|_| e.metadata())
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            Some((at, path, name))
        })
        .collect();
    snapshots.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path, name) in snapshots.into_iter().skip(KEEP) {
        if pending.as_ref().is_some_and(|p| p.review_token == name) {
            continue;
        }
        let _ = fs::remove_dir_all(path);
    }
}

fn load_delivery_review(id: &str, token: &str) -> Result<DeliverableReviewDto, String> {
    uuid::Uuid::parse_str(token).map_err(|_| "请先重新查看非 Git 产物")?;
    let dir = delivery_review_root(id)?.join(token);
    let mut review: DeliverableReviewDto = serde_json::from_slice(
        &fs::read(dir.join("review.json")).map_err(|e| format!("评审快照不可用：{e}"))?,
    )
    .map_err(|e| e.to_string())?;
    if review.workspace_id != id || review.token != token {
        return Err("产物快照归属不一致".into());
    }
    review.payload_dir = dir.join("payload").to_string_lossy().into_owned();
    for file in &review.files {
        if Path::new(&file.path).is_absolute()
            || file.path.contains('\\')
            || file.path.split('/').any(|p| matches!(p, ".." | "." | ""))
        {
            return Err("产物快照包含无效路径".into());
        }
        if !matches!(
            file.disposition.as_str(),
            "copy" | "tracked" | "protected" | "conflict" | "too_large" | "skipped"
        ) {
            return Err("产物快照状态无效".into());
        }
    }
    Ok(review)
}

fn check_delivery_review(
    w: &WorkspaceDto,
    repo: &Path,
    token: &str,
) -> Result<DeliverableReviewDto, String> {
    let mut review = load_delivery_review(&w.id, token)?;
    if !crate::paths::same_path(&review.project_root, &crate::projects::canonical_key(repo)) {
        return Err("产物快照项目位置已变化，请重新评审".into());
    }
    let tracked = tracked_delivery_paths(Path::new(&w.worktree_path))?;
    let current: std::collections::HashSet<String> =
        delivery_paths(Path::new(&w.worktree_path), repo)?
            .into_iter()
            .filter(|path| !tracked.contains(path))
            .collect();
    if current
        .iter()
        .any(|path| !review.files.iter().any(|f| &f.path == path))
    {
        return Err("你看过之后又出现新产物，请刷新产物评审后再合并".into());
    }
    if review.files.iter().any(|f| f.disposition == "too_large") {
        return Err(
            "非 Git 产物超过冻结预算，请先拆分或移出本次交付范围后重新评审；尚未合并".into(),
        );
    }
    // 勾掉之后档案又把它列成了预期产物：流程要用的不能不带回
    let patterns = delivery_required_patterns(w, repo);
    if let Some(file) = review.files.iter().find(|f| {
        f.disposition == "skipped"
            && patterns.iter().any(|p| crate::artifacts::expected_match(&f.path, p))
    }) {
        return Err(format!(
            "{} 是流程要用的文件，不能不带回；请刷新评审后再保存",
            file.path
        ));
    }
    for file in &mut review.files {
        if file.disposition != "copy" {
            continue;
        }
        let (size, sha) = delivery_hash(&Path::new(&w.worktree_path).join(&file.path))
            .map_err(|_| format!("{} 在看过后已删除或变化，请重看", file.path))?;
        if size != file.size || file.sha256.as_deref() != Some(sha.as_str()) {
            return Err(format!(
                "{} 在你看过之后已变化，请重新查看这版产物再合并",
                file.path
            ));
        }
        if tracked.contains(&file.path) {
            file.disposition = "tracked".into();
            continue;
        }
        let (_, frozen_sha) = delivery_hash(&Path::new(&review.payload_dir).join(&file.path))?;
        if frozen_sha != sha {
            return Err(format!("{} 的冻结副本已损坏，未合并", file.path));
        }
    }
    Ok(review)
}

fn apply_delivery_review(
    review: &DeliverableReviewDto,
    repo: &Path,
    protected: &[String],
) -> SalvageReport {
    let mut report = SalvageReport::default();
    for file in &review.files {
        match file.disposition.as_str() {
            // 人在评审页勾掉了：留在工作区，不进项目、不进验收记录
            "tracked" | "skipped" => continue,
            "protected" => {
                report.skipped_protected.push(file.path.clone());
                continue;
            }
            "conflict" => {
                report.conflicts.push(file.path.clone());
                continue;
            }
            "too_large" => {
                report.failed.push(format!("{} 超过快照预算", file.path));
                continue;
            }
            _ => {}
        }
        let result = (|| {
            if crate::projects::path_is_protected(&file.path, protected) {
                return Err("保护范围已变化".to_string());
            }
            let source = Path::new(&review.payload_dir).join(&file.path);
            if delivery_hash(&source)?.1.as_str() != file.sha256.as_deref().ok_or("缺少产物指纹")?
            {
                return Err("冻结内容与所审版本不一致".into());
            }
            ensure_copy_dest_safe(repo, &file.path)?;
            let dest = repo.join(&file.path);
            if dest.exists() {
                if delivery_hash(&dest)?.1 == file.sha256.clone().unwrap_or_default() {
                    return Ok(());
                }
                return Err("项目同名文件已变化，不覆盖".into());
            }
            let parent = dest.parent().ok_or("产物目标无效")?;
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            let staged = parent.join(format!(".ccode-delivery-{}.tmp", uuid::Uuid::new_v4()));
            let copied = (|| {
                let (_, sha) = copy_delivery_snapshot(&source, &staged)?;
                if Some(&sha) != file.sha256.as_ref() {
                    return Err("产物副本在复制期间变化".into());
                }
                // 已存在目标不能被 rename 覆盖；同目录硬链接只用于原子发布本次私有暂存，不共享工作树输入。
                fs::hard_link(&staged, &dest)
                    .map_err(|e| format!("发布产物失败（目标可能已出现）：{e}"))
            })();
            let _ = fs::remove_file(&staged);
            copied
        })();
        match result {
            Ok(()) => report.copied.push(file.path.clone()),
            Err(e) => report.failed.push(format!("{}：{e}", file.path)),
        }
    }
    report
}

#[tauri::command]
pub async fn workspace_review_deliverables(id: String) -> Result<DeliverableReviewDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let w = get_workspace(&db()?, &id)?;
        if let Some(pending) = read_delivery_pending(&id)? {
            if let Ok(mut review) = load_delivery_review(&id, &pending.review_token) {
                let stale = review.files.iter().any(|file| is_delivery_process_file(&file.path));
                if !stale {
                    // 收尾中按当时的清单走：只标必要性给界面，不改带回范围
                    let patterns = delivery_required_patterns(&w, &live_repo_for(&w));
                    for file in &mut review.files {
                        file.required = patterns
                            .iter()
                            .any(|p| crate::artifacts::expected_match(&file.path, p));
                    }
                    return Ok(review);
                }
            }
        }
        freeze_deliverables(&w, &live_repo_for(&w))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 评审页逐个勾掉 / 勾回非 Git 产物（2026-10-22）：只在「带回 copy」与「不带回 skipped」之间切，
/// 同时改这次冻结的 review.json（保存进项目按它走）和工作区的勾掉记录（刷新评审后照样）。
/// 保存进项目进行到一半（有恢复单）时不让改：恢复按当时的清单接着走。
#[tauri::command]
pub async fn workspace_delivery_skip(
    id: String,
    token: String,
    path: String,
    skip: bool,
) -> Result<DeliverableReviewDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let w = get_workspace(&db()?, &id)?;
        set_delivery_skip(&w, &live_repo_for(&w), &token, &path, skip)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn set_delivery_skip(
    w: &WorkspaceDto,
    repo: &Path,
    token: &str,
    path: &str,
    skip: bool,
) -> Result<DeliverableReviewDto, String> {
    let id = w.id.as_str();
    if read_delivery_pending(id)?.is_some() {
        return Err("这次保存进项目还没收尾，暂时不能改带回哪些文件".into());
    }
    if skip
        && delivery_required_patterns(w, repo)
            .iter()
            .any(|p| crate::artifacts::expected_match(path, p))
    {
        return Err("这个文件是流程要用的（这一步的预期产物或文献资料），不能不带回".into());
    }
    let mut review = load_delivery_review(id, token)?;
    let file = review
        .files
        .iter_mut()
        .find(|f| f.path == path)
        .ok_or("这份产物清单里没有这个文件，请刷新评审")?;
    let next = match (file.disposition.as_str(), skip) {
        ("copy", true) | ("skipped", true) => "skipped",
        ("skipped", false) | ("copy", false) => "copy",
        _ => return Err("这个文件不在带回清单里，不能勾选".into()),
    };
    let sha = file.sha256.clone().ok_or("缺少产物指纹，请刷新评审")?;
    file.disposition = next.into();
    let mut skips = read_delivery_skips(id);
    if skip {
        skips.insert(path.to_string(), sha);
    } else {
        skips.remove(path);
    }
    write_delivery_skips(id, &skips)?;
    crate::profiles::atomic_write(
        &delivery_review_root(id)?.join(token).join("review.json"),
        &serde_json::to_string_pretty(&review).map_err(|e| e.to_string())?,
    )?;
    mark_required_deliverables(&mut review, w, repo)?;
    Ok(review)
}

const DELIVERABLE_COPY_CAP: usize = 2000;

/// target → 目标目录与文件名策略：目录/通配 = 目录取静态前缀、文件名用源文件 basename；
/// 精确文件 = 按 target 原样落（允许改名交付）
fn dest_for_target(root: &Path, target: &str, source: &Path) -> Result<PathBuf, String> {
    let rel = target.trim();
    if rel.is_empty() {
        return Err("该事项没有落点路径，无法登记交付".into());
    }
    let is_dir_entry = rel.ends_with('/') || rel.ends_with('\\');
    let rel = rel.trim_end_matches(['/', '\\']);
    if rel.is_empty() || rel.contains("..") || Path::new(rel).is_absolute() {
        return Err(format!("落点路径不安全: {target}"));
    }
    let base = source.file_name().ok_or("源文件没有文件名")?;
    if is_dir_entry {
        return Ok(root.join(rel).join(base));
    }
    if rel.contains('*') {
        let (dir, _) = rel.rsplit_once('/').unwrap_or(("", rel));
        if dir.contains('*') {
            return Err(format!("落点通配只允许出现在最后一段: {target}"));
        }
        return Ok(if dir.is_empty() {
            root.join(base)
        } else {
            root.join(dir).join(base)
        });
    }
    Ok(root.join(rel))
}

#[tauri::command]
pub async fn import_human_deliverable(
    project_root: String,
    step: Option<String>,
    title: Option<String>,
    source_path: String,
    // 落点覆盖（papers/imports/ 检索结果导入专用）：给定时不再取人工事项声明的落点
    target_override: Option<String>,
) -> Result<ImportDeliverableDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::projects::ensure_task_project_root(Path::new(
            &crate::sessions::expand_tilde(&project_root),
        ))?;
        let cfg = crate::projects::read_config_at(&root).config;
        let step_cfg = match &step {
            Some(name) => Some(
                cfg.steps
                    .iter()
                    .find(|s| &s.name == name)
                    .ok_or_else(|| format!("步骤不存在: {name}"))?,
            ),
            None => None,
        };
        let target = match &target_override {
            Some(t) => t.clone(),
            None => {
                let sc = step_cfg.ok_or("缺少步骤参数")?;
                let t = title.as_deref().ok_or("缺少人工事项参数")?;
                sc.human_tasks
                    .iter()
                    .find(|h| h.title == t)
                    .ok_or_else(|| format!("人工事项不存在: {t}"))?
                    .target
                    .clone()
            }
        };
        let source = PathBuf::from(crate::sessions::expand_tilde(&source_path));
        let source = fs::canonicalize(&source).map_err(|e| format!("源文件不存在或不可读: {e}"))?;
        if !source.is_file() {
            return Err("源路径不是文件".into());
        }
        // 落点根：文献 PDF / papers/ 强制项目根（不进 git，写工作区合并后会丢）；
        // 其余人工事项语境 = 活跃工作区优先；纯导入一律项目根
        let conn = db().ok();
        let dest_root = match step_cfg {
            Some(sc) if !project_root_deliverable_target(&target, &source) => {
                human_detection_roots(conn.as_ref(), &root, &sc.workspace_name)
                    .into_iter()
                    .last()
                    .unwrap_or_else(|| root.clone())
            }
            _ => root.clone(),
        };
        let dest = dest_for_target(&dest_root, &target, &source)?;
        if dest.exists() {
            return Err(format!("落点已存在同名文件: {}", dest.display()));
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建落点目录失败: {e}"))?;
        }
        fs::copy(&source, &dest).map_err(|e| format!("复制文件失败: {e}"))?;
        // 登记提货单（best-effort：文件已落位，检测口径已算完成；登记失败只回告不否决）；
        // 纯导入（无人工事项语境）不登记提货单
        let (registered, register_error) = match &title {
            Some(t) => match register_artifact_impl(&dest_root, t, &dest, "人工交付") {
                Ok(_) => (true, None),
                Err(e) => (false, Some(e)),
            },
            None => (false, None),
        };
        let dest_rel = dest
            .strip_prefix(&dest_root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        Ok(ImportDeliverableDto {
            dest_path: dest.to_string_lossy().into_owned(),
            dest_rel,
            dest_root: dest_root.to_string_lossy().into_owned(),
            registered,
            register_error,
        })
    })
    .await
    .map_err(|e| format!("导入人工交付失败: {e}"))?
}

pub(crate) const REVIEW_NOTES_FILE: &str = ".ccode/review-notes.md";

/// `git status --porcelain` 里除了退回意见文件还有没有别的改动
pub(crate) fn porcelain_has_changes(porcelain: &str) -> bool {
    porcelain.lines().any(|line| {
        let path = line.get(3..).unwrap_or("").trim().trim_matches('"');
        !line.trim().is_empty() && path != REVIEW_NOTES_FILE
    })
}

/// 人在评审里写下的退回意见。只写本工作树 `.ccode/review-notes.md`。
#[tauri::command]
pub async fn write_review_notes(
    worktree_path: String,
    content: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        const CAP: usize = 32 * 1024;
        if content.len() > CAP {
            return Err("评审意见超过 32 KB".into());
        }
        let root = std::fs::canonicalize(crate::sessions::expand_tilde(&worktree_path))
            .map_err(|e| format!("工作区目录无效: {e}"))?;
        let conn = db()?;
        let ok = query_workspaces(&conn)?.iter().any(|w| {
            w.status == "active"
                && crate::paths::same_path(&w.worktree_path, &root.to_string_lossy())
        });
        if !ok {
            return Err("不是已登记的活跃工作区，拒绝写入评审意见".into());
        }
        crate::profiles::atomic_write(&root.join(REVIEW_NOTES_FILE), &content)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 合并回基准分支（本地 merge，git 写操作）：前置条件不满足直接报错，不动任何东西。
/// archive=false 只合并（工作区保留，终端可继续用）；archive=true 合并并归档
#[tauri::command]
pub async fn merge_workspace(
    app: tauri::AppHandle,
    manager: tauri::State<'_, crate::pty::PtyManager>,
    id: String,
    archive: bool,
    expect_reviewed_sha: Option<String>,
    expect_delivery_token: Option<String>,
) -> Result<WorkspaceMergeResultDto, String> {
    let manager = manager.inner().clone();
    let (out, paths) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        let ensure_idle =
            |worktree_path: &str| manager.ensure_workspace_free(worktree_path, "合并并归档");
        if archive {
            ensure_idle(&w.worktree_path)?; // 快速预检；归档内部在移除 worktree 前还会复查
        }
        let out = merge_impl_with_guard(
            &conn,
            &id,
            archive,
            &ensure_idle,
            expect_reviewed_sha.as_deref(),
            expect_delivery_token.as_deref(),
        )?;
        Ok((out, (w.worktree_path, w.repo_path)))
    })
    .await
    .map_err(|e| e.to_string())??;
    // 只有归档了才广播（前端把留在被移除工作树里的终端标签切回主仓库）
    if out.archived {
        emit_ws_archived(&app, &paths.0, &paths.1);
    }
    if out.merged {
        if let Err(e) = crate::endnote::export_if_configured(std::path::Path::new(&paths.1)) {
            crate::logbuf::record(
                "warn",
                "endnote",
                &format!("保存进项目后生成 EndNote 导入文件失败: {e}"),
            );
        }
    }
    Ok(out)
}

// ===== 路径归属（预览编辑器标识「主仓库/工作区分支」用） =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchTargetDto {
    pub workspace_name: String,
    pub branch: String,
    pub worktree_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathContextDto {
    /// "worktree"（活跃工作区的工作树内）| "main"（活跃工作区的主仓库内）| "other"
    pub kind: String,
    pub workspace_name: Option<String>,
    pub branch: Option<String>,
    /// 命中工作区的工作树绝对路径（切换「分支」用）
    pub worktree_path: Option<String>,
    /// 命中工作区的主仓库绝对路径（切换「主项目」用）
    pub repo_path: Option<String>,
    /// 同仓库的其他活跃工作区（主项目⇄多分支的切换列表）
    pub siblings: Vec<SwitchTargetDto>,
}

/// 剥过 verbatim 的 canonicalize；目标还不存在（新建文件，父目录也可能还没建）时逐级上溯到最近的
/// 已存在祖先 canonicalize，再把没建出来的尾巴拼回去，都失败才原样返回。
/// 两侧同一口径，Windows 上才不会出现 `\\?\C:\…` 与 `C:\…` 永不相等，macOS 上 `/var` → `/private/var` 也对得上。
fn canonical_or_parent_plain(path: &Path) -> PathBuf {
    if let Ok(p) = crate::paths::canonicalize_plain(path) {
        return p;
    }
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut cur = path;
    while let (Some(parent), Some(name)) = (cur.parent(), cur.file_name()) {
        tail.push(name);
        if let Ok(mut p) = crate::paths::canonicalize_plain(parent) {
            for n in tail.iter().rev() {
                p.push(n);
            }
            return p;
        }
        cur = parent;
    }
    path.to_path_buf()
}

/// 判断路径落在哪个上下文，供预览编辑器提示「你在改主仓库还是分支」。
/// 双方都 canonicalize 再比前缀（防 symlink 误判）；工作树优先于主仓库命中
///（工作树在 ~/ccode/workspaces/ 下不在主仓库内，理论上不会重叠，取确定语义）
fn path_context_impl(conn: &Connection, path: &str) -> Result<PathContextDto, String> {
    let target = canonical_or_parent_plain(Path::new(path));
    let actives: Vec<WorkspaceDto> = query_workspaces(conn)?
        .into_iter()
        .filter(|w| w.status == "active")
        .collect();
    let canon = |p: &str| canonical_or_parent_plain(Path::new(p));
    let to_target = |o: &WorkspaceDto| SwitchTargetDto {
        workspace_name: o.name.clone(),
        branch: o.branch.clone(),
        worktree_path: o.worktree_path.clone(),
    };
    // 工作树命中（优先）：同仓库其他活跃工作区作为切换目标
    for w in &actives {
        if crate::paths::path_within_path(&target, &canon(&w.worktree_path)) {
            return Ok(PathContextDto {
                kind: "worktree".into(),
                workspace_name: Some(w.name.clone()),
                branch: Some(w.branch.clone()),
                worktree_path: Some(w.worktree_path.clone()),
                repo_path: Some(w.repo_path.clone()),
                siblings: actives
                    .iter()
                    .filter(|o| o.id != w.id && crate::paths::same_path(&o.repo_path, &w.repo_path))
                    .map(to_target)
                    .collect(),
            });
        }
    }
    // 主仓库命中：该仓库全部活跃工作区都是切换目标
    if let Some(w) = actives
        .iter()
        .find(|w| crate::paths::path_within_path(&target, &canon(&w.repo_path)))
    {
        return Ok(PathContextDto {
            kind: "main".into(),
            workspace_name: Some(w.name.clone()),
            branch: Some(w.base_branch.clone()),
            worktree_path: Some(w.worktree_path.clone()),
            repo_path: Some(w.repo_path.clone()),
            siblings: actives
                .iter()
                .filter(|o| crate::paths::same_path(&o.repo_path, &w.repo_path))
                .map(to_target)
                .collect(),
        });
    }
    Ok(PathContextDto {
        kind: "other".into(),
        workspace_name: None,
        branch: None,
        worktree_path: None,
        repo_path: None,
        siblings: vec![],
    })
}

#[tauri::command]
pub async fn path_context(path: String) -> Result<PathContextDto, String> {
    tauri::async_runtime::spawn_blocking(move || path_context_impl(&db()?, &path))
        .await
        .map_err(|e| e.to_string())?
}

// ===== 工作区状态漂移与修复 =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDriftIssueDto {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDriftDto {
    pub healthy: bool,
    pub issues: Vec<WorkspaceDriftIssueDto>,
    pub can_remount: bool,
    pub can_relocate: bool,
    pub can_mark_archived: bool,
    pub can_clean_record: bool,
    pub can_resolve_merge: bool,
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn registered_worktrees(repo: &Path) -> Result<Vec<(PathBuf, Option<String>)>, String> {
    let text = run_git(
        repo,
        &["worktree", "list", "--porcelain"],
        Duration::from_secs(30),
    )?;
    let mut rows = Vec::new();
    let mut path: Option<PathBuf> = None;
    let mut branch: Option<String> = None;
    for line in text.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if let Some(path) = path.take() {
                rows.push((path, branch.take()));
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("worktree ") {
            path = Some(PathBuf::from(value));
        } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
            branch = Some(value.to_string());
        }
    }
    Ok(rows)
}

fn drift_issue(code: &str, message: impl Into<String>) -> WorkspaceDriftIssueDto {
    WorkspaceDriftIssueDto {
        code: code.into(),
        message: message.into(),
    }
}

fn workspace_drift_impl(conn: &Connection, id: &str) -> Result<WorkspaceDriftDto, String> {
    let w = get_workspace(conn, id)?;
    let repo = PathBuf::from(&w.repo_path);
    let wt = PathBuf::from(&w.worktree_path);
    let repo_valid = repo.is_dir()
        && run_git(&repo, &["rev-parse", "--git-dir"], Duration::from_secs(10)).is_ok();
    let branch_exists = repo_valid
        && run_git(
            &repo,
            &["rev-parse", "--verify", "--quiet", &w.branch],
            Duration::from_secs(10),
        )
        .is_ok();
    let registrations = if repo_valid {
        registered_worktrees(&repo).unwrap_or_default()
    } else {
        Vec::new()
    };
    let registered = registrations.iter().find(|(path, _)| same_path(path, &wt));
    let mut issues = Vec::new();
    if w.status == "creating" {
        issues.push(drift_issue(
            "creating_incomplete",
            "上次创建没有完成，需要重新挂载或清理记录",
        ));
    }
    if !repo_valid {
        issues.push(drift_issue(
            "repo_missing",
            "仓库目录不存在、已移动或不再是 Git 仓库",
        ));
    } else if !branch_exists {
        issues.push(drift_issue(
            "branch_missing",
            format!("任务分支 {} 不存在", w.branch),
        ));
    }
    if w.status == "active" || w.status == "creating" {
        if !wt.is_dir() {
            issues.push(drift_issue("worktree_missing", "工作树目录不存在"));
        } else if repo_valid {
            match registered {
                None => issues.push(drift_issue(
                    "worktree_unregistered",
                    "工作树目录存在，但不在该仓库的 Git worktree 清单中",
                )),
                Some((_, actual_branch)) if actual_branch.as_deref() != Some(&w.branch) => {
                    issues.push(drift_issue(
                        "worktree_branch_mismatch",
                        format!(
                            "工作树登记分支为 {}，数据库记录为 {}",
                            actual_branch.as_deref().unwrap_or("detached HEAD"),
                            w.branch
                        ),
                    ));
                }
                _ => {}
            }
        }
    } else if w.status == "archived" && (wt.exists() || registered.is_some()) {
        issues.push(drift_issue(
            "archived_worktree_present",
            "数据库标记为已归档，但工作树仍存在或仍被 Git 登记",
        ));
    }
    let merging = wt.is_dir()
        && run_git(
            &wt,
            &["rev-parse", "--verify", "-q", "MERGE_HEAD"],
            Duration::from_secs(10),
        )
        .is_ok();
    if merging {
        issues.push(drift_issue(
            "merge_in_progress",
            "工作树存在未完成的合并，需要继续解决冲突或中止合并",
        ));
    }
    let can_remount = repo_valid
        && branch_exists
        && (w.status == "creating"
            || w.status == "archived"
            || !wt.is_dir()
            || registered.is_none());
    let can_mark_archived = matches!(w.status.as_str(), "active" | "creating") && !wt.exists();
    Ok(WorkspaceDriftDto {
        healthy: issues.is_empty(),
        can_remount,
        can_relocate: !repo_valid,
        can_mark_archived,
        can_clean_record: true,
        can_resolve_merge: merging,
        issues,
    })
}

fn copy_workspace_restore_files(w: &WorkspaceDto) -> Result<(), String> {
    let settings = crate::ws_settings::merged_settings(Path::new(&w.repo_path));
    let files = settings
        .files_to_copy
        .unwrap_or_else(|| FILES_TO_COPY.iter().map(|s| s.to_string()).collect());
    validate_copy_paths(&files)?;
    let worktree = Path::new(&w.worktree_path);
    for path in files {
        let src = Path::new(&w.repo_path).join(&path);
        if src.is_file() && !worktree.join(&path).exists() {
            safe_copy_into_worktree(worktree, &path, &src)
                .map_err(|e| format!("重新挂载时复制失败: {e}"))?;
        }
    }
    Ok(())
}

fn repair_remount_impl(conn: &Connection, id: &str) -> Result<WorkspaceDto, String> {
    let w = get_workspace(conn, id)?;
    let repo = PathBuf::from(&w.repo_path);
    let wt = PathBuf::from(&w.worktree_path);
    run_git(&repo, &["rev-parse", "--git-dir"], Duration::from_secs(10))
        .map_err(|e| format!("仓库不可用，请先重新定位: {e}"))?;
    run_git(
        &repo,
        &["rev-parse", "--verify", "--quiet", &w.branch],
        Duration::from_secs(10),
    )
    .map_err(|_| format!("任务分支 {} 不存在，无法重新挂载", w.branch))?;
    let mut added = false;
    if wt.exists() {
        let registered = registered_worktrees(&repo)?
            .into_iter()
            .any(|(path, branch)| same_path(&path, &wt) && branch.as_deref() == Some(&w.branch));
        if !registered {
            run_git(
                &repo,
                &["worktree", "repair", &w.worktree_path],
                Duration::from_secs(60),
            )
            .map_err(|e| format!("修复现有工作树登记失败，目录未改动: {e}"))?;
        }
    } else {
        if let Some(parent) = wt.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建工作树父目录失败: {e}"))?;
        }
        run_git(
            &repo,
            &["worktree", "add", &w.worktree_path, &w.branch],
            Duration::from_secs(60),
        )
        .map_err(|e| format!("重新挂载 worktree 失败: {e}"))?;
        added = true;
    }
    if let Err(e) = copy_workspace_restore_files(&w) {
        if added {
            let _ = run_git(
                &repo,
                &["worktree", "remove", "--force", &w.worktree_path],
                Duration::from_secs(60),
            );
        }
        return Err(e);
    }
    let actual_branch = run_git(
        &wt,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        Duration::from_secs(10),
    )?;
    if actual_branch != w.branch {
        return Err(format!(
            "重新挂载后分支不一致：实际 {actual_branch}，预期 {}",
            w.branch
        ));
    }
    conn.execute(
        "UPDATE workspaces SET status='active', archived_at=NULL WHERE id=?1",
        params![id],
    )
    .map_err(|e| format!("工作树已修复，但更新 Mesa 记录失败；可重试重新挂载: {e}"))?;
    invalidate_repo_cache();
    get_workspace(conn, id)
}

fn relocate_repo_impl(
    conn: &Connection,
    id: &str,
    new_repo_path: &str,
) -> Result<WorkspaceDto, String> {
    let w = get_workspace(conn, id)?;
    let repo = PathBuf::from(crate::sessions::expand_tilde(new_repo_path));
    run_git(&repo, &["rev-parse", "--git-dir"], Duration::from_secs(10))
        .map_err(|e| format!("所选目录不是可用的 Git 仓库: {e}"))?;
    run_git(
        &repo,
        &["rev-parse", "--verify", "--quiet", &w.branch],
        Duration::from_secs(10),
    )
    .map_err(|_| format!("所选仓库不包含任务分支 {}，已拒绝重新定位", w.branch))?;
    let wt = PathBuf::from(&w.worktree_path);
    if wt.exists() {
        let registered = registered_worktrees(&repo)?
            .into_iter()
            .any(|(path, branch)| same_path(&path, &wt) && branch.as_deref() == Some(&w.branch));
        if !registered {
            run_git(
                &repo,
                &["worktree", "repair", &w.worktree_path],
                Duration::from_secs(60),
            )
            .map_err(|e| format!("仓库可用，但修复工作树链接失败，记录未更新: {e}"))?;
        }
    }
    conn.execute(
        "UPDATE workspaces SET repo_path=?1 WHERE id=?2",
        params![repo.to_string_lossy().as_ref(), id],
    )
    .map_err(|e| format!("Git 链接已检查，但更新仓库位置失败，可重试重新定位: {e}"))?;
    invalidate_repo_cache();
    get_workspace(conn, id)
}

fn mark_archived_impl(conn: &Connection, id: &str) -> Result<(), String> {
    let w = get_workspace(conn, id)?;
    if Path::new(&w.worktree_path).exists() {
        return Err("工作树目录仍存在，不能只标记归档；请重新挂载后走正常归档或明确删除".into());
    }
    if Path::new(&w.repo_path).is_dir() {
        let _ = run_git(
            Path::new(&w.repo_path),
            &["worktree", "prune"],
            Duration::from_secs(30),
        );
    }
    conn.execute(
        "UPDATE workspaces SET status='archived', archived_at=?2 WHERE id=?1",
        params![id, crate::sessions::now_iso()],
    )
    .map_err(|e| format!("标记归档失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn workspace_drift(id: String) -> Result<WorkspaceDriftDto, String> {
    tauri::async_runtime::spawn_blocking(move || workspace_drift_impl(&db()?, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_repair_remount(id: String) -> Result<WorkspaceDto, String> {
    tauri::async_runtime::spawn_blocking(move || repair_remount_impl(&db()?, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_relocate_repo(
    id: String,
    new_repo_path: String,
) -> Result<WorkspaceDto, String> {
    tauri::async_runtime::spawn_blocking(move || relocate_repo_impl(&db()?, &id, &new_repo_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_mark_archived(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || mark_archived_impl(&db()?, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_clean_record(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        get_workspace(&conn, &id)?;
        conn.execute("DELETE FROM workspaces WHERE id=?1", params![id])
            .map_err(|e| format!("清理工作区记录失败: {e}"))?;
        invalidate_repo_cache();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把基准分支并入任务分支（`git merge <base>` 在工作树里执行）：冲突留在工作区就地解决，
/// 不碰主仓库——前端在解决后串联提交与最终合并
fn sync_base_impl(wt: &Path, base_branch: &str, restart: bool) -> Result<String, String> {
    let state = unmerged_with_base(wt, base_branch)?;
    if state.merging {
        if !restart {
            return Err(if state.stale_base {
                format!("当前冲突基于旧的 {base_branch}，请重新同步最新基准")
            } else {
                "当前已有进行中的冲突解决，请继续处理或明确重新同步".into()
            });
        }
        run_git(wt, &["merge", "--abort"], Duration::from_secs(30))
            .map_err(|e| format!("放弃旧冲突现场失败，请先手动执行 git merge --abort：{e}"))?;
    }
    // 工作树有未提交改动时 git 会拒绝合并，先说清楚。restart 已先 abort，避免把冲突状态误判为普通脏文件。
    // 评审退回意见只留在工作树、从不进提交，并入也碰不到它，不算未提交改动（2026-11-10 HER：补充文献时卡在这里）
    // 逐个列未跟踪文件：.ccode/ 整个没被跟踪时 git 只报 `?? .ccode/`，认不出里面只有退回意见
    let porcelain = run_git(wt, &["status", "--porcelain", "--untracked-files=all"], Duration::from_secs(30))?;
    if porcelain_has_changes(&porcelain) {
        return Err("工作区有未提交改动，请先在「改动」面板提交，再并入主分支".into());
    }
    // 干净并入会产生 merge commit，同样要绕过用户全局 commit.gpgsign
    let ident = crate::git_info::commit_identity_args(wt);
    let mut merge_args: Vec<&str> = ident.iter().map(String::as_str).collect();
    merge_args.extend(["-c", "commit.gpgsign=false", "merge", base_branch]);
    match run_git(wt, &merge_args, Duration::from_secs(60)) {
        Ok(out) => Ok(format!(
            "已把 {} 并入当前任务分支：\n{}",
            base_branch,
            if out.trim().is_empty() {
                "已是最新"
            } else {
                out.trim()
            }
        )),
        Err(e) => {
            // 只有真的进入 MERGING 才是冲突；其余失败（引用不存在、钩子失败等）如实透出，
            // 不能一律谎报「并入产生冲突」误导用户去解决不存在的冲突
            let merging = run_git(
                wt,
                &["rev-parse", "--verify", "-q", "MERGE_HEAD"],
                Duration::from_secs(10),
            )
            .is_ok();
            if !merging {
                return Err(format!(
                    "并入 {base_branch} 失败（非冲突），工作区未留下合并现场：\n{e}"
                ));
            }
            let files = run_git(
                wt,
                &["diff", "--name-only", "--diff-filter=U"],
                Duration::from_secs(10),
            )
            .unwrap_or_default();
            Err(format!(
                "并入产生冲突——冲突留在工作区，不影响主仓库：\n{e}\n冲突文件:\n{files}\n逐文件选择版本后可直接「完成解决并合并」"
            ))
        }
    }
}

#[tauri::command]
pub async fn workspace_sync_base(id: String, restart: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        let wt = PathBuf::from(&w.worktree_path);
        let out = sync_base_impl(&wt, &w.base_branch, restart.unwrap_or(false))?;
        crate::step_loop::record_sync(&w);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 项目最新（基准）比这一步工作副本多出来的改动文件：`git diff --name-only HEAD...基准`（合并基以来基准侧改过的）。
/// 开一轮前据此决定要不要并入、开场指令里告诉 AI 新并进来了什么（2026-11-06 流程贯通 §3）
fn incoming_impl(wt: &Path, base_branch: &str) -> Result<Vec<String>, String> {
    let range = format!("HEAD...{base_branch}");
    let out = run_git(wt, &["diff", "--name-only", &range], Duration::from_secs(30))?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect())
}

#[tauri::command]
pub async fn workspace_incoming(id: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        incoming_impl(&PathBuf::from(&w.worktree_path), &w.base_branch)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== 工作区内冲突解决（评审面板闭环：选边 → 提交，不用去终端） =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmergedDto {
    /// 工作树处于 MERGING 状态（有未完成的并入）
    pub merging: bool,
    /// 仍未解决的冲突文件（UU）
    pub files: Vec<String>,
    /// MERGE_HEAD 与当前基准分支 tip 不一致：冲突现场已落后，不能继续按旧的 theirs 选边。
    pub stale_base: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictContentDto {
    /// stage 2：当前任务分支（ours）；删除侧为 None
    pub ours: Option<String>,
    /// stage 3：并入的基准分支（theirs）；删除侧为 None
    pub theirs: Option<String>,
    /// ours → theirs 的全文件 unified diff，供双栏审阅复用
    pub diff: String,
    pub truncated: bool,
    /// 文献台账的机械比对建议（conflict_hint.rs）：哪边已包含另一边的全部改动；不是台账、比不出时为 None
    pub suggest: Option<crate::conflict_hint::ConflictHintDto>,
}

const CONFLICT_PREVIEW_CAP: usize = 512 * 1024;

fn cap_conflict_text(mut text: String) -> (String, bool) {
    if text.len() <= CONFLICT_PREVIEW_CAP {
        return (text, false);
    }
    let mut end = CONFLICT_PREVIEW_CAP;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n…（冲突预览已截断）\n");
    (text, true)
}

/// 冲突审阅必须保留文件首尾空白，不能复用会 trim 输出的 run_git。
pub(crate) fn run_git_raw(repo: &Path, args: &[&str]) -> Result<String, String> {
    let git = crate::agents::resolve_binary("git").ok_or("找不到 git 可执行文件，请先安装 git")?;
    let mut cmd = crate::process::background_command(git);
    cmd.arg("-C")
        .arg(repo)
        .args(["-c", "core.quotepath=false"])
        .args(crate::git_info::PLATFORM_GIT_CONFIG)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = run_cmd_full(cmd, Duration::from_secs(30))?;
    if out.timed_out {
        return Err("操作超时".into());
    }
    if out.success {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn unmerged_impl(wt: &Path) -> Result<UnmergedDto, String> {
    let merging = run_git(
        wt,
        &["rev-parse", "--verify", "-q", "MERGE_HEAD"],
        Duration::from_secs(10),
    )
    .is_ok();
    let out = run_git(
        wt,
        &["diff", "--name-only", "--diff-filter=U"],
        Duration::from_secs(10),
    )?;
    Ok(UnmergedDto {
        merging,
        files: out
            .lines()
            .map(|l| l.to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        stale_base: false,
    })
}

fn unmerged_with_base(wt: &Path, base_branch: &str) -> Result<UnmergedDto, String> {
    let mut state = unmerged_impl(wt)?;
    if !state.merging {
        return Ok(state);
    }
    let merge_head = run_git(
        wt,
        &["rev-parse", "--verify", "MERGE_HEAD"],
        Duration::from_secs(10),
    )?;
    let base_head = run_git(wt, &["rev-parse", base_branch], Duration::from_secs(10))?;
    state.stale_base = merge_head.trim() != base_head.trim();
    Ok(state)
}

fn conflict_content_impl(wt: &Path, path: &str) -> Result<ConflictContentDto, String> {
    let state = unmerged_impl(wt)?;
    if !state.files.iter().any(|file| file == path) {
        return Err(format!("文件不在当前冲突清单中: {path}"));
    }
    let ours_spec = format!(":2:{path}");
    let theirs_spec = format!(":3:{path}");
    let ours = run_git_raw(wt, &["show", &ours_spec]).ok();
    let theirs = run_git_raw(wt, &["show", &theirs_spec]).ok();
    if ours.is_none() && theirs.is_none() {
        return Err(format!("无法读取冲突两侧内容: {path}"));
    }
    let raw_diff = run_git_raw(
        wt,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--unified=999999",
            &ours_spec,
            &theirs_spec,
        ],
    )
    .unwrap_or_else(|_| match (&ours, &theirs) {
        (Some(left), None) => left.lines().fold(String::new(), |mut out, line| {
            out.push_str(&format!("-{line}\n"));
            out
        }),
        (None, Some(right)) => right.lines().fold(String::new(), |mut out, line| {
            out.push_str(&format!("+{line}\n"));
            out
        }),
        _ => String::new(),
    });
    let (ours, ours_cut) = match ours {
        Some(text) => {
            let (text, cut) = cap_conflict_text(text);
            (Some(text), cut)
        }
        None => (None, false),
    };
    let (theirs, theirs_cut) = match theirs {
        Some(text) => {
            let (text, cut) = cap_conflict_text(text);
            (Some(text), cut)
        }
        None => (None, false),
    };
    let (diff, diff_cut) = cap_conflict_text(raw_diff);
    // 比对读全文（不受预览截断影响）。included.json 自己没冲突时没有 stage 2/3，读不到就不给建议
    let suggest = crate::conflict_hint::ledger_hint(path, |stage, p| {
        run_git_raw(wt, &["show", &format!(":{stage}:{p}")]).ok()
    });
    Ok(ConflictContentDto {
        ours,
        theirs,
        diff,
        truncated: ours_cut || theirs_cut || diff_cut,
        suggest,
    })
}

#[tauri::command]
pub async fn workspace_unmerged_files(id: String) -> Result<UnmergedDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        unmerged_with_base(&PathBuf::from(&w.worktree_path), &w.base_branch)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_conflict_content(
    id: String,
    path: String,
) -> Result<ConflictContentDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        let wt = PathBuf::from(&w.worktree_path);
        if unmerged_with_base(&wt, &w.base_branch)?.stale_base {
            return Err(format!("{} 已更新，请先重新同步最新基准", w.base_branch));
        }
        conflict_content_impl(&wt, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 单边解决实现（worktree 直给，便于测试）
fn resolve_file_impl(wt: &Path, path: &str, side: &str) -> Result<UnmergedDto, String> {
    let state = unmerged_impl(wt)?;
    if !state.files.iter().any(|file| file == path) {
        return Err(format!("文件不在当前冲突清单中: {path}"));
    }
    let flag = match side {
        "ours" => "--ours",
        "theirs" => "--theirs",
        _ => return Err(format!("未知选边: {side}")),
    };
    if run_git(wt, &["checkout", flag, "--", path], Duration::from_secs(30)).is_ok() {
        run_git(wt, &["add", "--", path], Duration::from_secs(30))?;
    } else {
        // checkout 失败只在「选定侧已删除」的删/改冲突下才该落到 git rm；先用 ls-files -u
        // 确认该路径确为未合并、另一侧内容还在且选定侧 stage 缺失，避免其他原因
        //（索引损坏、路径异常等）导致 checkout 失败时把文件误删
        let chosen_stage = if side == "ours" { "2" } else { "3" };
        let other_stage = if side == "ours" { "3" } else { "2" };
        let unmerged = run_git(wt, &["ls-files", "-u", "--", path], Duration::from_secs(10))?;
        let stages: Vec<&str> = unmerged
            .lines()
            .filter_map(|line| line.split('\t').next())
            .filter_map(|meta| meta.split_whitespace().nth(2))
            .collect();
        let is_delete_side =
            !stages.is_empty() && !stages.contains(&chosen_stage) && stages.contains(&other_stage);
        if !is_delete_side {
            return Err(format!(
                "无法解决 {path}：该文件的冲突形态不是「选定侧已删除」，请检查冲突状态"
            ));
        }
        run_git(
            wt,
            &["rm", "-q", "--ignore-unmatch", "--", path],
            Duration::from_secs(30),
        )?;
    }
    unmerged_impl(wt)
}

/// 单边解决一个冲突文件：side = "ours"（分支版）| "theirs"（基准/main 版）。
/// 返回剩余未解决清单
#[tauri::command]
pub async fn workspace_resolve_file(
    id: String,
    path: String,
    side: String,
) -> Result<UnmergedDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        let wt = PathBuf::from(&w.worktree_path);
        if unmerged_with_base(&wt, &w.base_branch)?.stale_base {
            return Err(format!("{} 已更新，请先重新同步最新基准", w.base_branch));
        }
        resolve_file_impl(&wt, &path, &side)?;
        unmerged_with_base(&wt, &w.base_branch)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 完成并入提交的实现（worktree 直给，便于测试）
fn finish_merge_impl(wt: &Path) -> Result<String, String> {
    let st = unmerged_impl(wt)?;
    if !st.merging {
        return Err("当前没有进行中的并入".into());
    }
    if !st.files.is_empty() {
        return Err(format!("还有未解决的冲突文件：{}", st.files.join("、")));
    }
    // 与 merge 路径一致：应用内自动提交绕过用户全局 commit.gpgsign
    let ident = crate::git_info::commit_identity_args(wt);
    let mut args: Vec<&str> = ident.iter().map(String::as_str).collect();
    args.extend(["-c", "commit.gpgsign=false", "commit", "--no-edit"]);
    run_git(wt, &args, Duration::from_secs(60))?;
    Ok("冲突解决完成，已提交并入".to_string())
}

/// 全部冲突解决完后完成并入提交（--no-edit 用 git 生成的 merge 信息）
#[tauri::command]
pub async fn workspace_finish_merge(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        let wt = PathBuf::from(&w.worktree_path);
        if unmerged_with_base(&wt, &w.base_branch)?.stale_base {
            return Err(format!("{} 已更新，请先重新同步最新基准", w.base_branch));
        }
        let out = finish_merge_impl(&wt)?;
        // 解完冲突也是一次并入（评审页「完成解决并合并」）：记下，「待跟进」才按它判
        crate::step_loop::record_sync(&w);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 推送分支并用 gh CLI 创建 PR（复用机器上的 gh 认证）
#[tauri::command]
pub async fn create_pr(
    id: String,
    title: String,
    body: Option<String>,
    skip_push: Option<bool>,
) -> Result<WorkspacePrResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pr_impl(&db()?, &id, &title, body, skip_push.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDto {
    pub path: String,
    pub name: String,
    pub last_active: Option<String>,
}

// ===== list_repos 进程内缓存：全量扫描要逐目录跑 git，TTL 内直接复用 =====

const REPO_CACHE_TTL: Duration = Duration::from_secs(60);
static REPO_CACHE: OnceLock<Mutex<Option<(Instant, Vec<RepoDto>)>>> = OnceLock::new();

fn repo_cache() -> &'static Mutex<Option<(Instant, Vec<RepoDto>)>> {
    REPO_CACHE.get_or_init(|| Mutex::new(None))
}

/// 缓存命中判断（纯函数，注入 now 便于测试）；时钟回拨按过期处理
fn repo_cache_hit(
    cached: &Option<(Instant, Vec<RepoDto>)>,
    now: Instant,
    ttl: Duration,
) -> Option<Vec<RepoDto>> {
    cached.as_ref().and_then(|(ts, repos)| {
        now.checked_duration_since(*ts)
            .filter(|elapsed| *elapsed < ttl)
            .map(|_| repos.clone())
    })
}

/// 主动失效：新建工作区会改变聚合结果（新增 worktree 路径），成功后必须清掉
fn invalidate_repo_cache() {
    if let Ok(mut guard) = repo_cache().lock() {
        *guard = None;
    }
}

fn sort_recent_repos(repos: &mut [RepoDto]) {
    repos.sort_by(|a, b| {
        b.last_active
            .cmp(&a.last_active)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

/// 新建工作区的仓库候选：来自会话聚合目录，只保留真实存在的 git 仓库，
/// 排除 home 目录与 worktree 路径（非 git 仓库创建必失败，混杂会误导用户）
#[tauri::command]
pub async fn list_repos() -> Vec<RepoDto> {
    tauri::async_runtime::spawn_blocking(|| {
        if let Ok(guard) = repo_cache().lock() {
            if let Some(hit) = repo_cache_hit(&guard, Instant::now(), REPO_CACHE_TTL) {
                return hit;
            }
        }
        // 会话路径、home、工作区根三者来源不同（canonicalize / dirs / 配置拼接），
        // Windows 上 verbatim 与普通形式混杂且大小写不敏感 —— 全部走 paths::path_key
        // 折成同一口径再比。此前 home 用 canonicalize 对齐过，ws_root 漏了：
        // starts_with 恒假 ⇒ 每个 worktree 都会作为「仓库候选」冒出来。
        let home = crate::dirs::home_dir().map(|h| crate::paths::path_key(&h.to_string_lossy()));
        // 家目录可被用户换位置：旧位置里的工作副本/隔离树仍在，各根都要排除
        let ws_root_keys: Vec<String> = crate::ccode_home::all_sub("workspaces")
            .iter()
            .map(|p| crate::paths::path_key(&p.to_string_lossy()))
            .collect();
        // 定时隔离 worktree 同理排除：它们是真 git 仓库（rev-parse 必过），不排除就会
        // 以任务 UUID 当目录名冒充「最近项目」（2026-10-16 实证）
        let watch_root_keys: Vec<String> = crate::ccode_home::all_sub("watch-worktrees")
            .iter()
            .map(|p| crate::paths::path_key(&p.to_string_lossy()))
            .collect();
        let under_any = |key: &str, roots: &[String]| {
            roots
                .iter()
                .any(|r| key == r || key.starts_with(&format!("{r}/")))
        };
        let mut activity = std::collections::HashMap::<PathBuf, Option<String>>::new();
        for session in crate::sessions::cached_scan().sessions {
            let Ok(path) = std::fs::canonicalize(&session.project_path) else {
                continue;
            };
            let path_key = crate::paths::path_key(&path.to_string_lossy());
            let in_ws_root = under_any(&path_key, &ws_root_keys);
            let in_watch_root = under_any(&path_key, &watch_root_keys);
            if !path.is_dir() || Some(&path_key) == home.as_ref() || in_ws_root || in_watch_root
            {
                continue;
            }
            let updated = session.updated_at;
            // 剥掉 verbatim 前缀再入表：这张表的 key 会直接变成 RepoDto.path 交给前端，
            // 既要显示给用户看，也要和前端手里的普通形式路径比较
            activity
                .entry(crate::paths::strip_verbatim(path))
                .and_modify(|current| {
                    if updated.as_deref() > current.as_deref() {
                        current.clone_from(&updated);
                    }
                })
                .or_insert(updated);
        }
        let mut repos: Vec<RepoDto> = activity
            .into_iter()
            .filter(|(path, _)| {
                run_git(path, &["rev-parse", "--git-dir"], Duration::from_secs(5)).is_ok()
            })
            .map(|(path, last_active)| RepoDto {
                name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "repo".into()),
                path: path.to_string_lossy().into_owned(),
                last_active,
            })
            .collect();
        sort_recent_repos(&mut repos);
        // 时间戳取扫描完成后，TTL 从最新数据起算
        if let Ok(mut guard) = repo_cache().lock() {
            *guard = Some((Instant::now(), repos.clone()));
        }
        repos
    })
    .await
    .unwrap_or_default()
}

// ===== 提货单 artifacts.yaml（§11.3 机制五，P3 v1 务实版） =====
// 大产物（数据/图/PDF）不进 git，只有本清单随分支提交传递；下一步工作区凭清单按路径直读产物。
// Cargo.toml 未引入 serde_yaml（约定不加新依赖），清单采用手写简化 YAML 子集：
// 顶层一个 `artifacts:` 数组，每条目六行 `key: "value"`（双引号字符串，反斜杠转义），
// 解析/渲染只认该子集；其余顶层内容（注释、未知键）在读写往返中原样保留。

const ARTIFACTS_FILE: &str = "artifacts.yaml";
/// 清单头注释；解析时剔除本行，避免每次重写都再叠一份
const MANIFEST_HEADER: &str = "# Mesa 提货单：大产物不进 git，本清单随分支提交传递给下一步";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntryDto {
    pub name: String,
    /// 绝对路径（canonicalize 后）
    pub path: String,
    /// md5 hex
    pub hash: String,
    pub size: u64,
    /// 产出工作区名
    pub produced_by: String,
    pub created_at: String,
}

/// 简化 YAML 字符串转义：只处理引号/反斜杠，换行折叠为空格（路径与名称不应含换行）
fn yaml_escape(value: &str) -> String {
    value
        .replace(['\n', '\r'], " ")
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

/// 解析双引号字符串值；未加引号的值原样返回（防御式，容忍手写清单）
fn yaml_unescape(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        v[1..v.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        v.to_string()
    }
}

/// 拆分为（保留行， 条目）：`artifacts:` 块外的顶层内容原样保留（头注释行除外）；
/// 块内无法识别的行直接跳过（格式随版本漂移时不拖垮整个清单）。
fn parse_manifest(text: &str) -> (Vec<String>, Vec<ArtifactEntryDto>) {
    let mut preserved = Vec::new();
    let mut entries = Vec::new();
    let mut in_block = false;
    for line in text.lines() {
        if !in_block {
            if line.trim() == "artifacts:" {
                in_block = true;
            } else if line.trim_end() != MANIFEST_HEADER {
                preserved.push(line.to_string());
            }
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue; // 块内空行/注释不保留
        }
        // 无缩进的非块内容 = 块结束，回到顶层保留
        if !line.starts_with(char::is_whitespace) {
            in_block = false;
            preserved.push(line.to_string());
            continue;
        }
        let content = trimmed.strip_prefix("- ").unwrap_or_else(|| {
            // 纯 `-` 行视为新空条目
            if trimmed == "-" {
                ""
            } else {
                trimmed
            }
        });
        let is_new = trimmed.starts_with('-');
        if is_new {
            entries.push(ArtifactEntryDto {
                name: String::new(),
                path: String::new(),
                hash: String::new(),
                size: 0,
                produced_by: String::new(),
                created_at: String::new(),
            });
        }
        let Some(entry) = entries.last_mut() else {
            continue;
        };
        let Some((key, value)) = content.split_once(':') else {
            continue;
        };
        match key.trim() {
            "name" => entry.name = yaml_unescape(value),
            "path" => entry.path = yaml_unescape(value),
            "hash" => entry.hash = yaml_unescape(value),
            "size" => entry.size = value.trim().parse().unwrap_or(0),
            "produced_by" => entry.produced_by = yaml_unescape(value),
            "created_at" => entry.created_at = yaml_unescape(value),
            _ => {} // 未知字段跳过
        }
    }
    // 损坏文件的防御：缺路径或名字的条目没有意义，剔除
    entries.retain(|e| !e.path.is_empty() && !e.name.is_empty());
    (preserved, entries)
}

fn render_manifest(preserved: &[String], entries: &[ArtifactEntryDto]) -> String {
    let mut out = String::new();
    out.push_str(MANIFEST_HEADER);
    out.push_str("\nartifacts:\n");
    for e in entries {
        out.push_str(&format!("  - name: \"{}\"\n", yaml_escape(&e.name)));
        out.push_str(&format!("    path: \"{}\"\n", yaml_escape(&e.path)));
        out.push_str(&format!("    hash: \"{}\"\n", yaml_escape(&e.hash)));
        out.push_str(&format!("    size: {}\n", e.size));
        out.push_str(&format!(
            "    produced_by: \"{}\"\n",
            yaml_escape(&e.produced_by)
        ));
        out.push_str(&format!(
            "    created_at: \"{}\"\n",
            yaml_escape(&e.created_at)
        ));
    }
    for line in preserved {
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// 流式 md5 + 大小：产物可能很大（数据/图/PDF），不整文件读入内存
fn file_md5_and_size(path: &Path) -> Result<(String, u64), String> {
    use std::io::Read;
    let mut file =
        fs::File::open(path).map_err(|e| format!("读取产物失败 {}: {e}", path.display()))?;
    let mut ctx = md5::Context::new();
    let mut buf = [0u8; 1024 * 1024];
    let mut size = 0u64;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取产物失败 {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        ctx.consume(&buf[..n]);
        size += n as u64;
    }
    Ok((format!("{:x}", ctx.compute()), size))
}

/// 已被 git 跟踪的文件随分支走，不需要提货单；登记它会误导下一步，直接拒绝。
/// 工作区外的路径谈不上被本仓库跟踪，git 不可用/非仓库时放行（防御式，不阻断登记）。
fn ensure_artifact_not_tracked(worktree: &Path, artifact: &Path) -> Result<(), String> {
    // artifact 已 canonicalize，worktree 同步 canonicalize 再比前缀（/var→/private/var 这类符号链接）
    let worktree =
        crate::paths::canonicalize_plain(worktree).unwrap_or_else(|_| worktree.to_path_buf());
    let Ok(rel) = artifact.strip_prefix(&worktree) else {
        return Ok(());
    };
    if run_git(
        &worktree,
        &["ls-files", "--error-unmatch", "--", &rel.to_string_lossy()],
        Duration::from_secs(10),
    )
    .is_ok()
    {
        return Err(format!(
            "产物 {} 已被 git 跟踪，随分支提交即可，无需登记提货单",
            artifact.display()
        ));
    }
    Ok(())
}

fn register_artifact_impl(
    worktree: &Path,
    name: &str,
    artifact: &Path,
    produced_by: &str,
) -> Result<ArtifactEntryDto, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("产物名称不能为空".into());
    }
    // canonicalize 同时完成存在性校验与绝对路径化；剥 verbatim 再落清单（提货单给人和下一步 agent 看）
    let artifact = crate::paths::canonicalize_plain(artifact)
        .map_err(|e| format!("产物文件不存在或不可读 {}: {e}", artifact.display()))?;
    if !artifact.is_file() {
        return Err(format!("产物路径不是文件: {}", artifact.display()));
    }
    ensure_artifact_not_tracked(worktree, &artifact)?;
    let (hash, size) = file_md5_and_size(&artifact)?;
    let entry = ArtifactEntryDto {
        name: name.to_string(),
        path: artifact.to_string_lossy().into_owned(),
        hash,
        size,
        produced_by: produced_by.to_string(),
        created_at: chrono::Local::now().to_rfc3339(),
    };
    // 读-改-原子写：损坏文件按防御式解析后的结果继续，不清空用户手改的其他内容
    let manifest = worktree.join(ARTIFACTS_FILE);
    let existing = fs::read_to_string(&manifest).unwrap_or_default();
    let (preserved, mut entries) = parse_manifest(&existing);
    // 同路径重复登记 = 更新（内容/hash/时间都可能变），不产生重复条目
    // 跨方言比较：存量清单里可能是 verbatim / 大小写不同的同一文件，按字符串比会登记出重复条目
    match entries
        .iter_mut()
        .find(|e| crate::paths::same_path(&e.path, &entry.path))
    {
        Some(slot) => *slot = entry.clone(),
        None => entries.push(entry.clone()),
    }
    crate::profiles::atomic_write(&manifest, &render_manifest(&preserved, &entries))?;
    Ok(entry)
}

/// 读项目根（或工作区根）的清单；缺失返回空，解析全程防御式容错
/// （pub(crate)：PDF 白名单 artifact_paths_at 与清单命令共用这份解析）
pub(crate) fn read_artifacts_manifest_impl(root: &Path) -> Vec<ArtifactEntryDto> {
    let Ok(text) = fs::read_to_string(root.join(ARTIFACTS_FILE)) else {
        return Vec::new();
    };
    parse_manifest(&text).1
}

/// P4 PDF 白名单用（pdf.rs）：某根目录 artifacts.yaml 中登记产物的绝对路径。
/// 登记产物可位于根之外（如 quarto 渲染产物入产物目录），pdf.rs 按条目精确路径放行。
pub(crate) fn artifact_paths_at(root: &Path) -> Vec<PathBuf> {
    read_artifacts_manifest_impl(root)
        .into_iter()
        .map(|e| PathBuf::from(e.path))
        .collect()
}

#[tauri::command]
pub async fn register_artifact(
    worktree_path: String,
    name: String,
    artifact_path: String,
) -> Result<ArtifactEntryDto, String> {
    let worktree = PathBuf::from(&worktree_path);
    // produced_by 取注册工作区名；查不到（普通仓库面板）回落目录名
    let produced_by = db()
        .ok()
        .and_then(|conn| {
            conn.query_row(
                "SELECT name FROM workspaces WHERE worktree_path = ?1 AND status != 'archived'",
                params![&worktree_path],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .unwrap_or_else(|| {
            worktree
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| worktree_path.clone())
        });
    register_artifact_impl(&worktree, &name, Path::new(&artifact_path), &produced_by)
}

#[tauri::command]
pub async fn read_artifacts_manifest(repo_path: String) -> Result<Vec<ArtifactEntryDto>, String> {
    Ok(read_artifacts_manifest_impl(Path::new(&repo_path)))
}

#[cfg(test)]
mod tests;
