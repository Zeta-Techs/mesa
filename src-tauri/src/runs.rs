//! 一次干活（Run）身份：关标签不删行。无头标 internal，不进工作台「正在进行」。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

pub(crate) mod goal_storage;

const MAX_TASK_INPUT_FILES: usize = 20_000;
const MAX_TASK_INPUT_BYTES: u64 = 512 * 1024 * 1024;

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

/// 入口幂等键闭集：旧 `wt:` 升格为 `lane:`；其余前缀原样保留。
pub(crate) fn canonicalize_reuse_key(key: &str) -> String {
    let key = key.trim();
    if let Some(rest) = key.strip_prefix("wt:") {
        return format!("lane:{rest}");
    }
    key.to_string()
}

pub(crate) fn infer_task_kind(reuse_key: &str, isolation: &str) -> &'static str {
    let key = canonicalize_reuse_key(reuse_key);
    if key.starts_with("login:") {
        return "login";
    }
    if key.starts_with("reader:") {
        return "reader";
    }
    if key.starts_with("watch:") {
        return "watch";
    }
    if key.starts_with("office:") {
        return "office_doc";
    }
    if key.starts_with("free:") || key.starts_with("research:") {
        return "free_research";
    }
    if key.starts_with("ws:") {
        return "pipeline_step";
    }
    if key.starts_with("lane:") || key.starts_with("coding:") {
        return "coding_lane";
    }
    if key.starts_with("headless:") {
        return "scratch";
    }
    let path = isolation.replace('\\', "/");
    if path.contains("/ccode/scratch") {
        return "scratch";
    }
    if path.contains("/ccode/workspaces/") {
        return "pipeline_step";
    }
    if path.contains("/ccode/worktrees/") {
        return "coding_lane";
    }
    "scratch"
}

pub(crate) fn is_internal_kind(task_kind: &str, reuse_key: &str) -> bool {
    task_kind == "watch" || reuse_key.starts_with("watch:") || reuse_key.starts_with("headless:")
}

fn basename_of(path: &str) -> Option<String> {
    let t = path.trim_end_matches(['/', '\\']);
    std::path::Path::new(t)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
}

fn infer_task_ref(reuse: &str, isolation: &str) -> Option<String> {
    if let Some(rest) = reuse.strip_prefix("watch:") {
        let id = rest.split(':').next().unwrap_or("");
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    if let Some(rest) = reuse.strip_prefix("office:") {
        if let Some((_, rel)) = rest.rsplit_once(':') {
            if rel != "project" && !rel.is_empty() {
                return Some(rel.to_string());
            }
        }
    }
    if let Some(rest) = reuse.strip_prefix("custom:") {
        let id = rest.split(':').next().unwrap_or("");
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    basename_of(isolation)
}

fn infer_project_root(reuse: &str, isolation: &str) -> Option<String> {
    if let Some(rest) = reuse.strip_prefix("reader:") {
        let t = rest.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Some(p) = crate::projects::project_root_containing(isolation) {
        return Some(p);
    }
    let mut best: Option<(usize, String)> = None;
    for w in crate::workspaces::worktree_rows() {
        if crate::paths::path_within(isolation, &w.worktree_path)
            || crate::paths::path_within(isolation, &w.repo_path)
        {
            let len = w.worktree_path.len().max(w.repo_path.len());
            if best.as_ref().map(|(l, _)| len > *l).unwrap_or(true) {
                best = Some((len, w.repo_path));
            }
        }
    }
    if let Some((_, p)) = best {
        return Some(p);
    }
    crate::coding::repo_path_for_worktree(isolation)
}

// Task 是持久意图；identity_key 只在入口解析，跨页面只传 taskId / runId。
fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE, project_root TEXT,
        kind TEXT NOT NULL, task_ref TEXT, name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
        input_paths TEXT NOT NULL DEFAULT '[]', output_paths TEXT NOT NULL DEFAULT '[]',
        review_required INTEGER NOT NULL DEFAULT 0, archived_at TEXT, agent TEXT,
        profile_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project_root TEXT, task_kind TEXT NOT NULL, task_ref TEXT,
        isolation_path TEXT NOT NULL, runtime TEXT NOT NULL, agent TEXT NOT NULL,
        profile_id TEXT, permission TEXT NOT NULL, reuse_key TEXT, session_id TEXT,
        internal INTEGER NOT NULL DEFAULT 0, sentinel INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, closed_at TEXT);
      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, event_type TEXT NOT NULL,
        payload TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_reuse ON runs(reuse_key);
      CREATE INDEX IF NOT EXISTS idx_runs_open ON runs(internal, closed_at);",
    )
    .map_err(|e| e.to_string())?;
    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(tasks)")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for (column, definition) in [
        ("description", "TEXT NOT NULL DEFAULT ''"),
        ("status", "TEXT NOT NULL DEFAULT 'pending'"),
        ("input_paths", "TEXT NOT NULL DEFAULT '[]'"),
        ("output_paths", "TEXT NOT NULL DEFAULT '[]'"),
        ("review_required", "INTEGER NOT NULL DEFAULT 0"),
        ("archived_at", "TEXT"),
        ("agent", "TEXT"),
        ("profile_id", "TEXT"),
        ("adopted_paths", "TEXT NOT NULL DEFAULT '[]'"),
        ("skills", "TEXT NOT NULL DEFAULT '[]'"),
        ("project_id", "TEXT"),
        // B2 目标级模型绑定：追加队尾（map_task 按位置索引读列，插中间会静默串列）
        ("model", "TEXT"),
    ] {
        if !columns.iter().any(|c| c == column) {
            conn.execute(
                &format!("ALTER TABLE tasks ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    let run_columns: Vec<String> = conn
        .prepare("PRAGMA table_info(runs)")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for (column, definition) in [
        ("status", "TEXT NOT NULL DEFAULT 'running'"),
        ("exit_code", "INTEGER"),
        ("close_reason", "TEXT"),
        ("task_id", "TEXT"),
        ("custom_runtime_id", "TEXT"),
        ("project_id", "TEXT"),
        ("workspace_cleared", "INTEGER NOT NULL DEFAULT 0"),
        ("review_cleared", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !run_columns.iter().any(|c| c == column) {
            conn.execute(
                &format!("ALTER TABLE runs ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    goal_storage::ensure_schema(conn)?;
    // 一次回填旧 Run；不重写任何 CLI 会话文件，也不合并两套 worktree 库。
    // 只回填有归属语义的 kind（§4.7 起 scratch/reader/office 闲聊的 task_id 落 NULL 是设计，不是遗留）
    let legacy = query_runs(
        conn,
        "WHERE task_id IS NULL AND task_kind IN ('pipeline_step','coding_lane','watch','free_research','office_doc')",
        [],
    )?;
    for run in legacy {
        let task = ensure_task_at(
            conn,
            run.project_root.as_deref(),
            &run.task_kind,
            run.task_ref.as_deref(),
            &run.isolation_path,
        )?;
        conn.execute("UPDATE runs SET task_id=?2, status=CASE WHEN closed_at IS NOT NULL AND status='running' THEN 'completed' ELSE status END WHERE id=?1",
            params![run.id, task.id]).map_err(|e| e.to_string())?;
    }
    backfill_project_ids(conn)?;
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, created_at);")
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// §4.6 二期地基：tasks/runs 双写 project_id，旧行按路径回填（projects 表在同一个 app.db）。
/// 读取侧仍按路径（迁移渐进）；纯净测试库没有 projects 表时跳过。
fn backfill_project_ids(conn: &Connection) -> Result<(), String> {
    let has_projects: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='projects'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?
        > 0;
    if !has_projects {
        return Ok(());
    }
    // UPDATE 哪怕命中 0 行也要申请写锁；db() 每次调用都过这里，先用只读 EXISTS 判断有没有可回填的行，
    // 否则主线程上的轮询命令会和后台写入抢锁、最多等 busy_timeout
    for table in ["tasks", "runs"] {
        let pending: bool = conn
            .query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM {table} WHERE project_id IS NULL AND project_root IS NOT NULL \
                     AND EXISTS(SELECT 1 FROM projects WHERE projects.path={table}.project_root))"
                ),
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("检查 {table}.project_id 回填失败: {e}"))?;
        if !pending {
            continue;
        }
        conn.execute(
            &format!(
                "UPDATE {table} SET project_id=(SELECT id FROM projects WHERE projects.path={table}.project_root) \
                 WHERE project_id IS NULL AND project_root IS NOT NULL"
            ),
            [],
        )
        .map_err(|e| format!("回填 {table}.project_id 失败: {e}"))?;
    }
    Ok(())
}

/// 按注册路径查项目稳定 id（查不到 = 未注册或旧行未分配，返回 None 不伪造）
fn project_id_for(conn: &Connection, root: Option<&str>) -> Option<String> {
    conn.query_row("SELECT id FROM projects WHERE path=?1", [root?], |r| {
        r.get::<_, Option<String>>(0)
    })
    .ok()
    .flatten()
}

/// 身份定位与历史路径分离：返回当前位置，不改写 Run 的历史来源和 CLI 文件。
fn current_project_root(
    conn: &Connection,
    project_id: Option<&str>,
    stored: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(id) = project_id else {
        return Ok(stored.map(str::to_owned));
    };
    let has_projects: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !has_projects {
        return Ok(stored.map(str::to_owned));
    }
    let mut stmt = conn
        .prepare("SELECT path FROM projects WHERE id=?1 LIMIT 2")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let paths = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if paths.len() > 1 {
        return Err("项目身份对应多个位置，请先解决项目副本冲突".into());
    }
    Ok(paths
        .into_iter()
        .next()
        .or_else(|| stored.map(str::to_owned)))
}

fn resolve_task_project(conn: &Connection, mut task: TaskDto) -> Result<TaskDto, String> {
    task.project_root = current_project_root(
        conn,
        task.project_id.as_deref(),
        task.project_root.as_deref(),
    )?;
    Ok(task)
}

fn resolve_run_project(conn: &Connection, mut run: RunDto) -> Result<RunDto, String> {
    let root = current_project_root(conn, run.project_id.as_deref(), run.project_root.as_deref())?;
    if let (Some(old), Some(new)) = (run.project_root.as_deref(), root.as_deref()) {
        if crate::paths::same_path(&run.isolation_path, old) {
            run.isolation_path = new.to_string();
        }
    }
    run.project_root = root;
    Ok(run)
}

fn db() -> Result<Connection, String> {
    let conn = crate::sessions::open_db()?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn record_event(
    conn: &Connection,
    id: &str,
    kind: &str,
    payload: Option<&str>,
) -> Result<(), String> {
    let payload = payload.map(crate::sessions::redact_sensitive_text);
    conn.execute(
        "INSERT INTO run_events(id,run_id,event_type,payload,created_at) VALUES (?1,?2,?3,?4,?5)",
        params![
            uuid::Uuid::new_v4().to_string(),
            id,
            kind,
            payload,
            now_rfc3339()
        ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDto {
    pub id: String,
    pub project_root: Option<String>,
    pub kind: String,
    pub task_ref: Option<String>,
    pub name: String,
    pub description: String,
    pub status: String,
    pub input_paths: Vec<String>,
    pub output_paths: Vec<String>,
    pub review_required: bool,
    pub archived_at: Option<String>,
    pub agent: Option<String>,
    pub profile_id: Option<String>,
    /// 目标绑定的模型 id（B2；agent/profile 同款「只在创建时写入」）。空 = 该连接名单第一
    pub model: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub declared: bool,
    pub adopted_paths: Vec<String>,
    /// 本目标点名的技能（新建目标时勾选；与项目级 skills 名单互补：项目=工具箱，目标=点名）
    #[serde(default)]
    pub skills: Vec<String>,
    /// 项目稳定 id（§4.6 二期双写；旧行可能未回填 = None）
    #[serde(default)]
    pub project_id: Option<String>,
    pub pending_apply_run_id: Option<String>,
    pub workspace_cleared: bool,
    pub review_cleared: bool,
    pub storage_cleanup_pending: bool,
}
fn map_task(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskDto> {
    let input_paths: String = r.get(7)?;
    let output_paths: String = r.get(8)?;
    let identity_key: String = r.get(15)?;
    Ok(TaskDto {
        id: r.get(0)?,
        project_root: r.get(1)?,
        kind: r.get(2)?,
        task_ref: r.get(3)?,
        name: r.get(4)?,
        description: r.get(5)?,
        status: r.get(6)?,
        input_paths: serde_json::from_str(&input_paths).unwrap_or_default(),
        output_paths: serde_json::from_str(&output_paths).unwrap_or_default(),
        review_required: r.get::<_, i64>(9)? != 0,
        archived_at: r.get(10)?,
        agent: r.get(11)?,
        profile_id: r.get(12)?,
        created_at: r.get(13)?,
        updated_at: r.get(14)?,
        declared: identity_key.starts_with("user:"),
        adopted_paths: serde_json::from_str(&r.get::<_, String>(16)?).unwrap_or_default(),
        skills: serde_json::from_str(&r.get::<_, String>(17)?).unwrap_or_default(),
        project_id: r.get(18)?,
        model: r.get(19)?,
        pending_apply_run_id: None,
        workspace_cleared: false,
        review_cleared: false,
        storage_cleanup_pending: false,
    })
}
const TASK_COLS: &str = "id,project_root,kind,task_ref,name,description,status,input_paths,output_paths,review_required,archived_at,agent,profile_id,created_at,updated_at,identity_key,adopted_paths,skills,project_id,model";
fn ensure_task_at(
    conn: &Connection,
    root: Option<&str>,
    kind: &str,
    task_ref: Option<&str>,
    isolation: &str,
) -> Result<TaskDto, String> {
    let key = serde_json::to_string(&(root, kind, task_ref.unwrap_or(isolation)))
        .map_err(|e| e.to_string())?;
    let now = now_rfc3339();
    let project_id = project_id_for(conn, root);
    conn.execute(
        "INSERT INTO tasks(id,identity_key,project_root,kind,task_ref,name,project_id,created_at,updated_at)
        VALUES(?1,?2,?3,?4,?5,?6,?8,?7,?7) ON CONFLICT(identity_key) DO NOTHING",
        params![
            uuid::Uuid::new_v4().to_string(),
            key,
            root,
            kind,
            task_ref,
            task_ref.unwrap_or(isolation),
            now,
            project_id
        ],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        &format!("SELECT {TASK_COLS} FROM tasks WHERE identity_key=?1"),
        [key],
        map_task,
    )
    .map_err(|e| e.to_string())
}

fn task_json_paths(value: &[String]) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("任务文件路径无法保存: {e}"))
}

/// 哪些执行需要在 tasks 表登记（§4.7）：声明目标显式带 task_id，不走这里；
/// 自动登记只留给有归属语义的对象（科研步骤/编程车道/定时巡检）。
/// 随手聊、阅读、办公文件闲聊是沟通记录不是目标——Run 直接落 NULL task_id。
fn run_needs_task(kind: &str) -> bool {
    matches!(
        kind,
        "pipeline_step" | "coding_lane" | "watch" | "free_research"
    )
}

fn prune_nested_rel_paths(paths: &[String]) -> Vec<String> {
    let mut items = paths.to_vec();
    items.sort_by(|a, b| a.len().cmp(&b.len()).then(a.cmp(b)));
    let mut kept = Vec::new();
    for path in items {
        if path == "." {
            return vec![".".into()];
        }
        let covered = kept.iter().any(|parent: &String| {
            parent == "." || path == *parent || path.starts_with(&format!("{parent}/"))
        });
        if !covered {
            kept.push(path);
        }
    }
    kept
}

fn task_rel_path(root: &Path, raw: &str, label: &str) -> Result<(String, PathBuf), String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(format!("{label}不能是空路径"));
    }
    let candidate = {
        let path = PathBuf::from(crate::sessions::expand_tilde(raw));
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
    };
    let canonical = crate::paths::canonicalize_plain(&candidate)
        .map_err(|e| format!("{label}无法解析：{e}"))?;
    if !crate::paths::path_within(&canonical.to_string_lossy(), &root.to_string_lossy()) {
        return Err(format!("{label}必须位于项目目录内"));
    }
    let relative = canonical
        .strip_prefix(root)
        .map_err(|_| format!("{label}无法计算项目相对路径"))?
        .to_string_lossy()
        .replace('\\', "/");
    if relative.is_empty() {
        return Err(format!("{label}不能是项目根目录本身"));
    }
    if relative
        .split('/')
        .any(|part| matches!(part, ".git" | ".ccode"))
    {
        return Err(format!("{label}不能指向 Mesa 或 Git 内部目录"));
    }
    Ok((relative, canonical))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInputEstimate {
    pub files: usize,
    pub bytes: u64,
    pub limit_bytes: u64,
    pub limit_files: usize,
    pub allowed: bool,
}

fn estimate_task_inputs(root: &Path, paths: &[String]) -> Result<TaskInputEstimate, String> {
    let files = crate::task_review::collect_scoped_files(root, paths)?;
    let mut bytes = 0u64;
    for relative in &files {
        bytes = bytes.saturating_add(
            fs::metadata(root.join(relative))
                .map_err(|e| e.to_string())?
                .len(),
        );
    }
    Ok(TaskInputEstimate {
        files: files.len(),
        bytes,
        limit_bytes: MAX_TASK_INPUT_BYTES,
        limit_files: MAX_TASK_INPUT_FILES,
        allowed: bytes <= MAX_TASK_INPUT_BYTES && files.len() <= MAX_TASK_INPUT_FILES,
    })
}

#[tauri::command]
pub async fn task_input_estimate(task_id: String) -> Result<TaskInputEstimate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let task = task_by_id(&db()?, &task_id)?;
        let root = validate_existing_dir(
            task.project_root.as_deref().ok_or("目标没有项目")?,
            "项目目录",
        )?;
        estimate_task_inputs(Path::new(&root), &task.input_paths)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Default)]
struct TaskCopyBudget {
    files: usize,
    bytes: u64,
}

fn copy_task_tree_with_budget(
    source: &Path,
    target: &Path,
    budget: &mut TaskCopyBudget,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|e| format!("读取输入文件失败：{e}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("输入文件不能是符号链接：{}", source.display()));
    }
    if metadata.is_dir() {
        if matches!(
            source.file_name().and_then(|name| name.to_str()),
            Some(".git" | ".ccode" | "node_modules" | "target")
        ) {
            return Ok(());
        }
        fs::create_dir_all(target).map_err(|e| format!("创建任务输入目录失败：{e}"))?;
        for entry in fs::read_dir(source).map_err(|e| format!("读取任务输入目录失败：{e}"))?
        {
            let entry = entry.map_err(|e| format!("读取任务输入目录失败：{e}"))?;
            let child = entry.path();
            let name = entry.file_name();
            copy_task_tree_with_budget(&child, &target.join(name), budget)?;
        }
    } else if metadata.is_file() {
        budget.files += 1;
        budget.bytes = budget.bytes.saturating_add(metadata.len());
        if budget.files > MAX_TASK_INPUT_FILES {
            return Err(format!("输入文件超过上限（{} 个）", MAX_TASK_INPUT_FILES));
        }
        if budget.bytes > MAX_TASK_INPUT_BYTES {
            return Err("输入文件总大小超过 512 MB 上限".into());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建任务输入目录失败：{e}"))?;
        }
        fs::copy(source, target).map_err(|e| format!("复制任务输入失败：{e}"))?;
    } else {
        return Err(format!("输入路径不是普通文件或目录：{}", source.display()));
    }
    Ok(())
}

fn copy_project_contents(
    source: &Path,
    target: &Path,
    budget: &mut TaskCopyBudget,
) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|e| format!("读取项目范围失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取项目范围失败：{e}"))?;
        let name = entry.file_name();
        if matches!(
            name.to_str(),
            Some(".git" | ".ccode" | "node_modules" | "target")
        ) {
            continue;
        }
        copy_task_tree_with_budget(&entry.path(), &target.join(name), budget)?;
    }
    Ok(())
}

fn task_entry_is_ignored(name: &std::ffi::OsStr) -> bool {
    matches!(
        name.to_str(),
        Some(".git" | ".ccode" | "node_modules" | "target")
    )
}

fn rel_posix(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|_| format!("变更路径不在任务目录内：{}", path.display()))
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

fn reject_symlink(path: &Path, label: &str) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("{label}失败：{e}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("{label}不能是符号链接：{}", path.display()));
    }
    Ok(metadata)
}

fn validate_output_rel(path: &str) -> Result<String, String> {
    let path = path.trim().replace('\\', "/");
    let path = path.trim_matches('/');
    if path.is_empty()
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("输出路径必须是项目内相对路径".into());
    }
    Ok(path.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutputChangeDto {
    pub path: String,
    pub kind: String,
    pub bytes: u64,
    pub too_large: bool,
}

fn push_file_change(
    source: &Path,
    target: &Path,
    source_root: &Path,
    changes: &mut Vec<TaskOutputChangeDto>,
) -> Result<(), String> {
    let metadata = reject_symlink(source, "读取任务输出")?;
    if !metadata.is_file() {
        return Err(format!("任务输出不是普通文件：{}", source.display()));
    }
    if target.exists() {
        let target_meta = reject_symlink(target, "读取项目文件")?;
        if target_meta.is_dir() {
            return Err(format!("输出目标是目录：{}", target.display()));
        }
        if files_equal(source, target)? {
            return Ok(());
        }
        changes.push(TaskOutputChangeDto {
            path: rel_posix(source_root, source)?,
            kind: "modified".into(),
            bytes: metadata.len(),
            too_large: false,
        });
        return Ok(());
    }
    changes.push(TaskOutputChangeDto {
        path: rel_posix(source_root, source)?,
        kind: "added".into(),
        bytes: metadata.len(),
        too_large: false,
    });
    Ok(())
}

fn collect_output_changes(
    source: &Path,
    target: &Path,
    source_root: &Path,
    changes: &mut Vec<TaskOutputChangeDto>,
) -> Result<(), String> {
    let metadata = reject_symlink(source, "读取任务输出")?;
    if metadata.is_dir() {
        if let Ok(target_meta) = fs::symlink_metadata(target) {
            if target_meta.file_type().is_symlink() {
                return Err(format!("输出目标不能是符号链接：{}", target.display()));
            }
            if !target_meta.is_dir() {
                return Err(format!("输出目标不是目录：{}", target.display()));
            }
        }
        for entry in fs::read_dir(source).map_err(|e| format!("读取任务输出目录失败：{e}"))?
        {
            let entry = entry.map_err(|e| format!("读取任务输出目录失败：{e}"))?;
            if task_entry_is_ignored(&entry.file_name()) {
                continue;
            }
            collect_output_changes(
                &entry.path(),
                &target.join(entry.file_name()),
                source_root,
                changes,
            )?;
        }
        return Ok(());
    }
    push_file_change(source, target, source_root, changes)
}

fn list_output_changes(
    run_root: &Path,
    project_root: &Path,
    output_paths: &[String],
) -> Result<Vec<TaskOutputChangeDto>, String> {
    let mut changes = Vec::new();
    if output_paths.iter().any(|path| path == ".") {
        collect_output_changes(run_root, project_root, run_root, &mut changes)?;
    } else {
        for raw in output_paths {
            let relative = validate_output_rel(raw)?;
            let source = run_root.join(&relative);
            if !source.exists() {
                continue;
            }
            collect_output_changes(
                &source,
                &project_root.join(&relative),
                run_root,
                &mut changes,
            )?;
        }
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    changes.dedup_by(|a, b| a.path == b.path);
    Ok(changes)
}

fn copy_adopt_file(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = reject_symlink(source, "读取任务输出")?;
    if !metadata.is_file() {
        return Err(format!("任务输出不是普通文件：{}", source.display()));
    }
    if target.exists() {
        let target_meta = reject_symlink(target, "读取项目文件")?;
        if target_meta.is_dir() {
            return Err(format!("输出目标是目录：{}", target.display()));
        }
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建输出目录失败：{e}"))?;
    }
    let temp = target.with_file_name(format!(".ccode-adopt-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut staged = options.open(&temp).map_err(|e| e.to_string())?;
        let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut staged).map_err(|e| e.to_string())?;
        staged
            .set_permissions(metadata.permissions())
            .map_err(|e| e.to_string())?;
        staged.sync_all().map_err(|e| e.to_string())?;
        drop(staged);
        crate::storage::replace(&temp, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result.map_err(|e| format!("接收任务输出失败：{e}"))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct AdoptBackupFile {
    path: String,
    existed: bool,
}

struct AdoptItem {
    relative: String,
    target: PathBuf,
    before: Option<String>,
    after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalApplyFile {
    path: String,
    before: Option<String>,
    after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalApplyJournal {
    id: String,
    project_root: String,
    source_root: String,
    backup_dir: String,
    files: Vec<GoalApplyFile>,
    fact: crate::projects::AcceptanceLogEntry,
    memorize: bool,
    phase: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalApplyPendingDto {
    pub id: String,
    pub version_id: String,
    pub paths: Vec<String>,
    pub phase: String,
    pub note: String,
    pub memorize: bool,
}

fn goal_journal_path(review_dir: &Path) -> PathBuf {
    review_dir.join("apply-pending.json")
}

fn read_goal_journal(review_dir: &Path) -> Result<Option<GoalApplyJournal>, String> {
    let path = goal_journal_path(review_dir);
    match fs::read(&path) {
        Ok(bytes) => {
            if bytes.len() > 8 * 1024 * 1024 {
                return Err("接受恢复单超过预算，未修改项目".into());
            }
            let journal: GoalApplyJournal = serde_json::from_slice(&bytes)
                .map_err(|e| format!("接受恢复单损坏，请保留备份并检查：{e}"))?;
            if !matches!(
                journal.phase.as_str(),
                "prepared" | "files_applied" | "recorded" | "rolling_back"
            ) {
                return Err("接受恢复单阶段无效".into());
            }
            uuid::Uuid::parse_str(&journal.id).map_err(|_| "接受恢复单身份无效")?;
            if journal.fact.kind != crate::review_contract::KIND_GOAL_ADOPT
                || journal.files.len() != journal.fact.paths.len()
            {
                return Err("接受恢复单的文件与决定不一致".into());
            }
            let base = crate::paths::canonicalize_plain(review_dir).map_err(|e| e.to_string())?;
            for location in [&journal.source_root, &journal.backup_dir] {
                let resolved = crate::paths::canonicalize_plain(Path::new(location))
                    .map_err(|e| format!("接受恢复材料缺失：{e}"))?;
                if !crate::paths::path_within_path(&resolved, &base) {
                    return Err("接受恢复材料不在本次评审目录内".into());
                }
            }
            let mut seen = std::collections::HashSet::new();
            for file in &journal.files {
                if Path::new(&file.path).is_absolute()
                    || validate_output_rel(&file.path)? != file.path
                    || !journal.fact.paths.contains(&file.path)
                    || !seen.insert(&file.path)
                {
                    return Err("接受恢复单包含无效相对路径".into());
                }
            }
            Ok(Some(journal))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取接受恢复单失败：{e}")),
    }
}

fn write_goal_journal(review_dir: &Path, journal: &GoalApplyJournal) -> Result<(), String> {
    crate::profiles::atomic_write(
        &goal_journal_path(review_dir),
        &serde_json::to_string_pretty(journal).map_err(|e| e.to_string())?,
    )
}

fn clear_goal_journal(review_dir: &Path) -> Result<(), String> {
    fs::remove_file(goal_journal_path(review_dir))
        .map_err(|e| format!("接受已处理，但恢复标记未清理，请重试：{e}"))
}

fn goal_apply_pending(journal: &GoalApplyJournal) -> GoalApplyPendingDto {
    GoalApplyPendingDto {
        id: journal.id.clone(),
        version_id: journal.fact.version_id.clone(),
        paths: journal.fact.paths.clone(),
        phase: journal.phase.clone(),
        note: crate::sessions::redact_sensitive_text(&journal.fact.note),
        memorize: journal.memorize,
    }
}

/// 恢复单先于第一处项目写入落盘；备份与原待接受内容都不靠下一轮目录现状重建。
fn prepare_goal_journal(
    review_dir: &Path,
    source: &Path,
    project: &Path,
    fact: crate::projects::AcceptanceLogEntry,
    memorize: bool,
) -> Result<GoalApplyJournal, String> {
    if read_goal_journal(review_dir)?.is_some() {
        return Err("还有未完成的接受操作，请先继续或恢复原文件".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let apply_dir = review_dir.join("applies").join(&id);
    let source_root = if fact.frozen {
        source.to_path_buf()
    } else {
        apply_dir.join("payload")
    };
    fs::create_dir_all(&source_root).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    let mut backups = Vec::new();
    for path in &fact.paths {
        let original = source.join(path);
        if !fact.frozen {
            copy_adopt_file(&original, &source_root.join(path))?;
        }
        let after = read_regular_optional(&source_root.join(path), "读取待接受内容")?
            .ok_or("待接受内容不存在")?;
        if let Some(expected) = fact
            .content_fingerprints
            .iter()
            .find(|f| &f.path == path)
            .and_then(|f| f.sha256.as_ref())
        {
            if &after != expected {
                return Err(format!("{path} 与所审内容不一致，未写入项目"));
            }
        }
        let target = project.join(path);
        let before = read_regular_optional(&target, "读取项目原文件")?;
        backups.push(AdoptItem {
            relative: path.clone(),
            target,
            before: before.clone(),
            after: after.clone(),
        });
        files.push(GoalApplyFile {
            path: path.clone(),
            before,
            after,
        });
    }
    let backup = persist_adopt_backup(&apply_dir.join("backup"), &backups)?;
    let journal = GoalApplyJournal {
        id,
        project_root: project.to_string_lossy().into_owned(),
        source_root: source_root.to_string_lossy().into_owned(),
        backup_dir: backup.to_string_lossy().into_owned(),
        files,
        fact,
        memorize,
        phase: "prepared".into(),
    };
    write_goal_journal(review_dir, &journal)?;
    Ok(journal)
}

fn check_goal_recovery_paths(journal: &GoalApplyJournal, project: &Path) -> Result<(), String> {
    let protected = crate::projects::protected_paths_at(project)?;
    for file in &journal.files {
        if crate::projects::path_is_protected(&file.path, &protected) {
            return Err(format!(
                "保护范围已包含 {}，未继续写入，请人工处理",
                file.path
            ));
        }
        let target = project.join(&file.path);
        let mut parent = target.parent().ok_or("接受目标路径无效")?;
        while !parent.exists() {
            parent = parent.parent().ok_or("接受目标路径无效")?;
        }
        let parent = crate::paths::canonicalize_plain(parent).map_err(|e| e.to_string())?;
        let root = crate::paths::canonicalize_plain(project).map_err(|e| e.to_string())?;
        if !crate::paths::path_within_path(&parent, &root) {
            return Err("接受目标越出项目目录".into());
        }
    }
    Ok(())
}

fn apply_goal_journal_with_writer(
    review_dir: &Path,
    project: &Path,
    journal: &mut GoalApplyJournal,
    mut write: impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    check_goal_recovery_paths(journal, project)?;
    // 全批预检，再逐文件复查；已写入内容跳过，外部改动不按新基线接纳。
    for file in &journal.files {
        let current = read_regular_optional(&project.join(&file.path), "核对恢复目标")?;
        if current != file.before && current.as_ref() != Some(&file.after) {
            return Err(format!(
                "{} 在接受期间又被修改，未覆盖；请保留恢复备份",
                file.path
            ));
        }
        if read_regular_optional(
            &Path::new(&journal.source_root).join(&file.path),
            "核对原版本",
        )?
        .as_ref()
            != Some(&file.after)
        {
            return Err(format!("{} 的原待接受版本损坏，未写入", file.path));
        }
    }
    for file in &journal.files {
        let target = project.join(&file.path);
        let current = read_regular_optional(&target, "核对接受目标")?;
        if current.as_ref() == Some(&file.after) {
            continue;
        }
        if current != file.before {
            return Err(format!("{} 在写入前变化，恢复单已保留", file.path));
        }
        write(&Path::new(&journal.source_root).join(&file.path), &target)?;
        if read_regular_optional(&target, "核对写入结果")?.as_ref() != Some(&file.after) {
            return Err(format!("{} 写入后内容不一致，恢复单已保留", file.path));
        }
    }
    journal.phase = "files_applied".into();
    write_goal_journal(review_dir, journal)
}

fn goal_fact_recorded(project: &Path, fact: &crate::projects::AcceptanceLogEntry) -> bool {
    crate::projects::read_acceptance_log_at(project)
        .iter()
        .any(|entry| {
            entry.kind == fact.kind
                && entry.run_id == fact.run_id
                && entry.goal_id == fact.goal_id
                && entry.version_id == fact.version_id
                && entry.paths == fact.paths
                && entry.note == fact.note
        })
}

fn rollback_goal_journal(
    review_dir: &Path,
    project: &Path,
    journal: &GoalApplyJournal,
) -> Result<(), String> {
    if journal.phase == "recorded" || goal_fact_recorded(project, &journal.fact) {
        return Err("这次接受已记入账本，不能用中断恢复撤销正式成果；请创建明确的修订".into());
    }
    check_goal_recovery_paths(journal, project)?;
    let mut restore = Vec::new();
    for file in &journal.files {
        let current = read_regular_optional(&project.join(&file.path), "检查回滚目标")?;
        if current != file.before && current.as_ref() != Some(&file.after) {
            return Err(format!("{} 又被外部修改，未强制回滚", file.path));
        }
        if let Some(before) = &file.before {
            if read_regular_optional(
                &Path::new(&journal.backup_dir)
                    .join("files")
                    .join(&file.path),
                "检查原文件备份",
            )?
            .as_ref()
                != Some(before)
            {
                return Err(format!("{} 的备份损坏，未恢复", file.path));
            }
        }
        restore.push(AdoptItem {
            relative: file.path.clone(),
            target: project.join(&file.path),
            before: file.before.clone(),
            after: file.after.clone(),
        });
    }
    // 恢复原文件本身也会中断；先记下用户选择的方向，重启后不可误继续接受。
    let mut rolling_back = journal.clone();
    rolling_back.phase = "rolling_back".into();
    write_goal_journal(review_dir, &rolling_back)?;
    let errors = rollback_adopt(&restore, Path::new(&journal.backup_dir));
    if !errors.is_empty() {
        return Err(format!("恢复未完成，恢复单仍保留：{}", errors.join("；")));
    }
    clear_goal_journal(review_dir)
}

fn finish_goal_journal(
    conn: &Connection,
    review_dir: &Path,
    project: &Path,
    journal: &mut GoalApplyJournal,
) -> Result<(), String> {
    if journal.phase == "rolling_back" {
        return Err("这次操作正在恢复原文件，请继续恢复，不能改成接受成果".into());
    }
    // 文件阶段已持久确认或账本已有原事实时，只补后续记录；不因用户后来编辑而重复写文件。
    if journal.phase == "prepared" && !goal_fact_recorded(project, &journal.fact) {
        apply_goal_journal_with_writer(review_dir, project, journal, copy_adopt_file)?;
    }
    crate::review_contract::commit_fact(project, &journal.fact)?;
    journal.phase = "recorded".into();
    write_goal_journal(review_dir, journal)?;
    if journal.memorize && !journal.fact.note.trim().is_empty() {
        crate::projects::append_project_memory_at(
            project,
            &journal.fact.goal_name,
            &journal.fact.note,
            Some(&journal.fact.version_id),
        )?;
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE tasks SET status='completed', adopted_paths=?2, updated_at=?3 WHERE id=?1",
        params![
            journal.fact.goal_id,
            task_json_paths(&journal.fact.paths)?,
            now_rfc3339()
        ],
    )
    .map_err(|e| e.to_string())?;
    let payload = serde_json::json!({"taskId":journal.fact.goal_id,"paths":journal.fact.paths,"frozen":journal.fact.frozen,"acceptanceId":journal.id}).to_string();
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM run_events WHERE run_id=?1 AND event_type='task.outputs_adopted' AND payload=?2)", params![journal.fact.run_id, crate::sessions::redact_sensitive_text(&payload)], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !exists {
        record_event(
            &tx,
            &journal.fact.run_id,
            "task.outputs_adopted",
            Some(&payload),
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    crate::projects::record_accepted_goal_at(
        project,
        &journal.fact.goal_name,
        &journal.fact.paths,
        &journal.fact.note,
    )?;
    clear_goal_journal(review_dir)
}

fn read_regular_optional(path: &Path, label: &str) -> Result<Option<String>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{label}失败：{e}")),
    };
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(format!("{label}不是普通文件：{}", path.display()));
    }
    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = sha2::Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(Some(format!("{:x}", hash.finalize())))
}

fn persist_adopt_backup(dir: &Path, items: &[AdoptItem]) -> Result<PathBuf, String> {
    let backup = dir.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(backup.join("files")).map_err(|e| format!("创建采纳备份失败：{e}"))?;
    let manifest: Vec<AdoptBackupFile> = items
        .iter()
        .map(|item| AdoptBackupFile {
            path: item.relative.clone(),
            existed: item.before.is_some(),
        })
        .collect();
    crate::profiles::atomic_write(
        &backup.join("before.json"),
        &serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
    )?;
    for item in items {
        if item.before.is_some() {
            let dest = backup.join("files").join(&item.relative);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建采纳备份失败：{e}"))?;
            }
            copy_adopt_file(&item.target, &dest)?;
            if read_regular_optional(&dest, "读取备份")? != item.before {
                return Err(format!("{} 在备份期间变化，未写回", item.relative));
            }
        }
    }
    Ok(backup)
}

fn rollback_adopt(written: &[AdoptItem], backup: &Path) -> Vec<String> {
    let mut errors = Vec::new();
    for item in written.iter().rev() {
        let rollback = (|| {
            let current = read_regular_optional(&item.target, "读取项目文件")?;
            if current == item.before {
                return Ok(());
            }
            if current.as_ref() != Some(&item.after) {
                return Err("文件再次被外部修改，未强制回滚".to_string());
            }
            match &item.before {
                Some(expected) => {
                    let saved = backup.join("files").join(&item.relative);
                    if read_regular_optional(&saved, "核对备份")?.as_ref() != Some(expected) {
                        return Err("备份内容变化，未强制回滚".into());
                    }
                    copy_adopt_file(&saved, &item.target)
                }
                None => fs::remove_file(&item.target).map_err(|e| e.to_string()),
            }
        })();
        if let Err(e) = rollback {
            errors.push(format!("{}: {e}", item.relative));
        }
    }
    if !errors.is_empty() {
        errors.push(format!("恢复备份：{}", backup.display()));
    }
    errors
}

#[cfg(test)]
thread_local! {
    static TEST_ADOPT_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn adopt_state_root(project: &Path) -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(root) = TEST_ADOPT_ROOT.with(|c| c.borrow().clone()) {
        return Ok(root);
    }
    Ok(task_runs_root()?.join("adopt").join(format!(
        "{:x}",
        md5::compute(project.to_string_lossy().as_bytes())
    )))
}

#[cfg(test)]
fn adopt_selected_with_writer(
    run_id: &str,
    run_root: &Path,
    project: &Path,
    selected: &[String],
    write: impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let _lock = crate::review_contract::apply_lock(project)?;
    adopt_selected_with_writer_locked(run_id, run_root, project, selected, write)
}

// 旧逐文件回滚的故障夹具；生产接受统一走持久恢复单。
#[cfg(test)]
fn adopt_selected_with_writer_locked(
    run_id: &str,
    run_root: &Path,
    project: &Path,
    selected: &[String],
    mut write: impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let lock_dir = adopt_state_root(project)?;
    let mut pending = Vec::new();
    for relative in selected {
        let source = run_root.join(relative);
        let target = project.join(relative);
        let after = read_regular_optional(&source, "读取任务输出")?.ok_or("任务输出不存在")?;
        let before = read_regular_optional(&target, "读取项目文件")?;
        if before.as_ref() == Some(&after) {
            continue;
        }
        pending.push(AdoptItem {
            relative: relative.clone(),
            target,
            before,
            after,
        });
    }
    if pending.is_empty() {
        return Ok(());
    }
    let backup = persist_adopt_backup(&lock_dir.join("backups").join(run_id), &pending)?;
    let mut written = Vec::new();
    for item in pending {
        let result = (|| {
            let current = read_regular_optional(&item.target, "读取项目文件")?;
            if current != item.before {
                return Err(format!("{} 在采纳期间变化，未覆盖", item.relative));
            }
            if read_regular_optional(&run_root.join(&item.relative), "核对冻结内容")?.as_ref()
                != Some(&item.after)
            {
                return Err("冻结内容在写入前变化，未写回".into());
            }
            write(&run_root.join(&item.relative), &item.target)
        })();
        if let Err(error) = result {
            // 写入可能已替换目标后才报错；本文件也要参与回滚，不能只回滚之前的文件。
            written.push(item);
            let rollback = rollback_adopt(&written, &backup);
            return Err(if rollback.is_empty() {
                format!("采纳失败：{error}。已回滚；备份：{}", backup.display())
            } else {
                format!(
                    "采纳失败：{error}。回滚未完全成功；备份：{}。{}",
                    backup.display(),
                    rollback.join("；")
                )
            });
        }
        written.push(item);
    }
    Ok(())
}

fn files_equal(source: &Path, target: &Path) -> Result<bool, String> {
    let source_meta = fs::metadata(source).map_err(|e| format!("读取任务输出失败：{e}"))?;
    let target_meta = match fs::metadata(target) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("读取项目文件失败：{error}")),
    };
    if !source_meta.is_file() || !target_meta.is_file() {
        return Ok(false);
    }
    if source_meta.len() != target_meta.len() {
        return Ok(false);
    }
    let mut source_file = fs::File::open(source).map_err(|e| format!("读取任务输出失败：{e}"))?;
    let mut target_file = fs::File::open(target).map_err(|e| format!("读取项目文件失败：{e}"))?;
    let mut source_buffer = [0_u8; 8192];
    let mut target_buffer = [0_u8; 8192];
    loop {
        let source_read = source_file
            .read(&mut source_buffer)
            .map_err(|e| format!("读取任务输出失败：{e}"))?;
        let target_read = target_file
            .read(&mut target_buffer)
            .map_err(|e| format!("读取项目文件失败：{e}"))?;
        if source_read != target_read
            || source_buffer[..source_read] != target_buffer[..target_read]
        {
            return Ok(false);
        }
        if source_read == 0 {
            return Ok(true);
        }
    }
}

fn task_runs_root() -> Result<PathBuf, String> {
    let root = goal_storage::root()?;
    fs::create_dir_all(&root).map_err(|e| format!("创建任务运行目录失败：{e}"))?;
    Ok(root)
}

fn task_by_id(conn: &Connection, id: &str) -> Result<TaskDto, String> {
    let task = conn
        .query_row(
            &format!("SELECT {TASK_COLS} FROM tasks WHERE id=?1"),
            [id],
            map_task,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Task 不存在".to_string())?;
    goal_storage::attach(conn, resolve_task_project(conn, task)?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskInput {
    pub project_root: String,
    pub kind: String,
    pub name: String,
    pub description: Option<String>,
    pub input_paths: Vec<String>,
    pub output_paths: Vec<String>,
    pub permission: Option<String>,
    pub agent: Option<String>,
    pub profile_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub skills: Vec<String>,
}

#[tauri::command]
/// 删除连接时清 tasks 表的显式绑定引用（W2a 级联，镜像 projects 侧
/// clear_project_default_profile 的写侧收口）：agent 恒随 profile——连接没了
/// agent 意图一并回落，目标启动按项目默认解析，不留在数据里当死引用。
pub(crate) fn clear_task_profile_refs(profile_id: &str) {
    let Ok(conn) = db() else {
        return;
    };
    let _ = conn.execute(
        "UPDATE tasks SET agent=NULL, profile_id=NULL, model=NULL, updated_at=?2 WHERE profile_id=?1",
        params![now_rfc3339(), profile_id],
    );
}

/// 目标绑定写侧三件套（W2a，与槽位写入同口径）：连接存在、agent 恒随 profile 所属 CLI、
/// 模型在名单。后端是唯一硬边界——UI 下拉自证不算防线，任何调用方都写不进脏值。
/// 三个都空 = 跟随项目默认（开工时按项目默认解析）。
fn normalize_goal_launch(
    agent: Option<String>,
    profile_id: Option<String>,
    model: Option<String>,
) -> Result<(Option<String>, Option<String>, Option<String>), String> {
    let agent = agent.unwrap_or_default();
    let agent = agent.trim();
    if !agent.is_empty() && crate::agent_specs::agent_spec(agent).is_none() {
        return Err(format!("未知 Agent：{agent}"));
    }
    let profile = profile_id.unwrap_or_default();
    let profile = profile.trim();
    let model = model.unwrap_or_default();
    let model = model.trim();
    let mut agent = agent.to_string();
    if !profile.is_empty() {
        let bindings = crate::gateway_store::load_bindings()?;
        let binding = bindings
            .iter()
            .find(|binding| binding.id == profile)
            .ok_or("连接不存在")?;
        if agent.is_empty() {
            agent = binding.agent.clone(); // agent 恒随 profile：缺省从连接推导，不信入参
        } else if agent != binding.agent {
            return Err(format!(
                "agent 与连接不一致：这条连接属于 {}，不单独绑工具",
                binding.agent
            ));
        }
        // 模型须在名单（空 = 名单第一，读侧回落）；名单外直接拒写
        crate::projects::accept_project_model(&binding.models, Some(model))?;
    }
    let non_empty = |value: &str| (!value.is_empty()).then(|| value.to_string());
    Ok((non_empty(&agent), non_empty(profile), non_empty(model)))
}

/// 目标的资料 / 产出范围与权限（新建与编辑同一套校验）。返回 (输入, 输出, 是否验收写回)。
fn normalize_goal_scope(
    root: &str,
    input_paths: &[String],
    output_paths: &[String],
    permission: Option<&str>,
) -> Result<(Vec<String>, Vec<String>, bool), String> {
    let permission = permission.unwrap_or("write_tree");
    if !matches!(permission, "discuss" | "write_tree") {
        return Err("不支持的权限政策".into());
    }
    let mut inputs = Vec::new();
    for path in input_paths {
        if path.trim() == "." {
            if !inputs.is_empty() {
                return Err("整个项目范围不能与指定路径同时使用".into());
            }
            if !inputs.contains(&".".to_string()) {
                inputs.push(".".into());
            }
            continue;
        }
        if inputs.iter().any(|item| item == ".") {
            return Err("整个项目范围不能与指定路径同时使用".into());
        }
        let (relative, _) = task_rel_path(Path::new(root), path, "资料路径")?;
        if !inputs.contains(&relative) {
            inputs.push(relative);
        }
    }
    if inputs.iter().any(|item| item == ".") {
        inputs = vec![".".into()];
    } else {
        inputs = prune_nested_rel_paths(&inputs);
    }
    let mut outputs = Vec::new();
    for path in output_paths {
        let path = path.trim().replace('\\', "/");
        let path = path.trim_matches('/');
        if path == "." {
            if !outputs.is_empty() {
                return Err("全部项目变更不能与指定输出路径同时使用".into());
            }
            outputs.push(".".to_string());
            continue;
        }
        if outputs.iter().any(|item| item == ".") {
            return Err("全部项目变更不能与指定输出路径同时使用".into());
        }
        if path.is_empty()
            || path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("输出路径必须是项目内相对路径".into());
        }
        if !outputs.contains(&path.to_string()) {
            outputs.push(path.to_string());
        }
    }
    let review_required = permission == "write_tree";
    if !review_required && !outputs.is_empty() {
        return Err("只讨论的目标不能指定输出路径；要生成文件请改为写入并验收".into());
    }
    if review_required && outputs.is_empty() {
        return Err("要写文件的目标必须指定输出范围".into());
    }
    Ok((inputs, outputs, review_required))
}

fn normalize_goal_skills(skills: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for skill in skills {
        let name = skill.trim();
        if !name.is_empty() && !out.iter().any(|item| item == name) {
            out.push(name.to_string());
        }
    }
    out
}

#[tauri::command]
pub async fn task_set_launch(
    id: String,
    agent: Option<String>,
    profile_id: Option<String>,
    model: Option<String>,
) -> Result<TaskDto, String> {
    tauri::async_runtime::spawn_blocking(move || task_set_launch_sync(id, agent, profile_id, model))
        .await
        .map_err(|e| e.to_string())?
}
fn task_set_launch_sync(
    id: String,
    agent: Option<String>,
    profile_id: Option<String>,
    model: Option<String>,
) -> Result<TaskDto, String> {
    let conn = db()?;
    let task = task_by_id(&conn, &id)?;
    if !task.declared {
        return Err("只能改你记下的目标".into());
    }
    if task.kind != "free_research" && task.kind != "office_doc" {
        return Err("只能改科研或工作目标".into());
    }
    if task.status == "running" {
        return Err("目标正在跑，先停掉再改连接".into());
    }
    let (agent_val, profile_val, model_val) = normalize_goal_launch(agent, profile_id, model)?;
    conn.execute(
        "UPDATE tasks SET agent=?2, profile_id=?3, model=?4, updated_at=?5 WHERE id=?1",
        params![id, agent_val, profile_val, model_val, now_rfc3339()],
    )
    .map_err(|err| format!("保存目标连接失败: {err}"))?;
    task_by_id(&conn, &id)
}

#[tauri::command]
pub async fn task_create(input: CreateTaskInput) -> Result<TaskDto, String> {
    tauri::async_runtime::spawn_blocking(move || task_create_sync(input))
        .await
        .map_err(|e| e.to_string())?
}
fn task_create_sync(input: CreateTaskInput) -> Result<TaskDto, String> {
    let root = validate_existing_dir(&input.project_root, "项目根目录")?;
    if !matches!(input.kind.as_str(), "free_research" | "office_doc") {
        return Err("这里只能创建科研或工作目标".into());
    }
    let name = input.name.trim();
    if name.is_empty() {
        return Err("目标不能为空".into());
    }
    let (inputs, outputs, review_required) = normalize_goal_scope(
        &root,
        &input.input_paths,
        &input.output_paths,
        input.permission.as_deref(),
    )?;
    let (agent, profile_id, model) =
        normalize_goal_launch(input.agent, input.profile_id, input.model)?;
    let conn = db()?;
    let project = crate::projects::canonical_key(Path::new(&root));
    let project_id = project_id_for(&conn, Some(&project));
    let registered = conn
        .query_row(
            "SELECT COUNT(*) FROM projects WHERE path=?1",
            [&project],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?;
    if registered == 0 {
        return Err("项目尚未注册，不能新建目标".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
    let identity = format!("user:{id}");
    let skills = normalize_goal_skills(&input.skills);
    conn.execute(
        "INSERT INTO tasks(id,identity_key,project_root,kind,task_ref,name,description,status,input_paths,output_paths,review_required,agent,profile_id,skills,project_id,created_at,updated_at,model)
         VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',?8,?9,?10,?11,?12,?13,?14,?15,?15,?16)",
        params![
            id,
            identity,
            project,
            input.kind,
            id,
            name,
            input.description.unwrap_or_default(),
            task_json_paths(&inputs)?,
            task_json_paths(&outputs)?,
            review_required as i64,
            agent,
            profile_id,
            task_json_paths(&skills)?,
            project_id,
            now,
            model
        ],
    )
    .map_err(|e| format!("新建目标失败: {e}"))?;
    task_by_id(&conn, &id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskInput {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub input_paths: Vec<String>,
    pub output_paths: Vec<String>,
    pub permission: Option<String>,
    pub agent: Option<String>,
    pub profile_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub skills: Vec<String>,
}

/// 已规范化的编辑内容（命令层做完路径 / 连接校验后交给 apply_task_update）。
struct GoalEdit {
    name: String,
    description: String,
    inputs: Vec<String>,
    outputs: Vec<String>,
    review_required: bool,
    agent: Option<String>,
    profile_id: Option<String>,
    model: Option<String>,
    skills: Vec<String>,
}

/// 只改「记下了还没开始」的目标：一旦跑过，资料已复制进副本、上下文已冻结，
/// 改要求或范围会让历程对不上——那时请「再来一版」写意见，或归档后重记。
fn apply_task_update(conn: &Connection, id: &str, edit: GoalEdit) -> Result<(), String> {
    let task = conn
        .query_row(
            "SELECT identity_key, kind, status, archived_at FROM tasks WHERE id=?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("目标不存在")?;
    let (identity, kind, status, archived_at) = task;
    if !identity.starts_with("user:") || !matches!(kind.as_str(), "free_research" | "office_doc") {
        return Err("只能编辑你记下的科研或工作目标".into());
    }
    if archived_at.is_some() {
        return Err("已归档的目标先恢复再编辑".into());
    }
    let runs: i64 = conn
        .query_row("SELECT COUNT(*) FROM runs WHERE task_id=?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if status != "pending" || runs > 0 {
        return Err("目标已经开始过，不能再改要求和资料；要调整请在验收时写意见再出一版".into());
    }
    let name = edit.name.trim();
    if name.is_empty() {
        return Err("目标不能为空".into());
    }
    conn.execute(
        "UPDATE tasks SET name=?2, description=?3, input_paths=?4, output_paths=?5, review_required=?6,
             agent=?7, profile_id=?8, model=?9, skills=?10, updated_at=?11
         WHERE id=?1 AND status='pending'",
        params![
            id,
            name,
            edit.description,
            task_json_paths(&edit.inputs)?,
            task_json_paths(&edit.outputs)?,
            edit.review_required as i64,
            edit.agent,
            edit.profile_id,
            edit.model,
            task_json_paths(&edit.skills)?,
            now_rfc3339(),
        ],
    )
    .map_err(|e| format!("保存目标失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn task_update(input: UpdateTaskInput) -> Result<TaskDto, String> {
    tauri::async_runtime::spawn_blocking(move || task_update_sync(input))
        .await
        .map_err(|e| e.to_string())?
}
fn task_update_sync(input: UpdateTaskInput) -> Result<TaskDto, String> {
    let conn = db()?;
    let task = task_by_id(&conn, &input.id)?;
    let root = task
        .project_root
        .clone()
        .ok_or("目标没有所属项目，不能编辑")?;
    let root = validate_existing_dir(&root, "项目根目录")?;
    let (inputs, outputs, review_required) = normalize_goal_scope(
        &root,
        &input.input_paths,
        &input.output_paths,
        input.permission.as_deref(),
    )?;
    let (agent, profile_id, model) =
        normalize_goal_launch(input.agent, input.profile_id, input.model)?;
    apply_task_update(
        &conn,
        &input.id,
        GoalEdit {
            name: input.name,
            description: input.description.unwrap_or_default(),
            inputs,
            outputs,
            review_required,
            agent,
            profile_id,
            model,
            skills: normalize_goal_skills(&input.skills),
        },
    )?;
    task_by_id(&conn, &input.id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareTaskRunInput {
    pub task_id: String,
    pub agent: String,
    pub profile_id: String,
    /// 同一目标再出一版：沿用上次隔离目录，不从项目重新复制。
    #[serde(default)]
    pub reuse_isolation: Option<bool>,
    /// 验收意见，记在上一版 Run 上，供时间线与下一版 Context Pack。
    #[serde(default)]
    pub feedback: Option<String>,
    /// 开工一刻实际下发给 Agent 的上下文全文（前端拼装的 Context Pack + 目标行）。
    /// 有就冻结成快照（审计 §4.8）；写失败 = 开工失败，不静默降级。
    #[serde(default)]
    pub context_text: Option<String>,
}

#[tauri::command]
pub async fn task_prepare_run(input: PrepareTaskRunInput) -> Result<RunDto, String> {
    tauri::async_runtime::spawn_blocking(move || task_prepare_run_impl(input))
        .await
        .map_err(|e| format!("准备任务失败：{e}"))?
}

/// 启动失败的收尾清理：只允许删除本次调用新建的 staging 目录；
/// reuse_isolation 复用的上一版目录里有旧成果，绝不能进清理分支。
fn cleanup_failed_prepare(created_here: bool, run_root: &Path) {
    if created_here {
        let _ = fs::remove_dir_all(run_root);
    }
}

/// 只有用户显式要求继续返修才重开目标；进程收尾没有这个权限。
fn continue_active_goal(
    conn: &Connection,
    task_id: &str,
    run_id: &str,
    feedback: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET status='running', updated_at=?2 WHERE id=?1",
        params![task_id, now_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    if let Some(note) = feedback.map(str::trim).filter(|s| !s.is_empty()) {
        record_event(
            conn,
            run_id,
            "task.review_notes",
            Some(&serde_json::json!({"feedback": note}).to_string()),
        )?;
    }
    Ok(())
}

fn task_prepare_run_impl(input: PrepareTaskRunInput) -> Result<RunDto, String> {
    let storage_lock = goal_storage::lock_task(&input.task_id)?;
    let conn = db()?;
    if goal_storage::has_pending(&conn, &input.task_id)? {
        return Err("目标有未完成的副本清理，请先继续清理".into());
    }
    let task = task_by_id(&conn, &input.task_id)?;
    if task.archived_at.is_some() {
        return Err("已归档的目标不能启动，请先恢复".into());
    }
    if task.kind != "free_research" && task.kind != "office_doc" {
        return Err("该 Task 类型由现有项目流程负责启动".into());
    }
    for prior in query_runs(
        &conn,
        "WHERE task_id=?1 ORDER BY created_at DESC",
        [&task.id],
    )? {
        if goal_journal_path(&task_review_dir(&task.id, &prior.id)?).exists() {
            return Err("目标还有未完成的接受操作，请先在评审中继续或恢复原文件，再返修".into());
        }
    }
    let skill_snapshots = crate::skills::snapshot_named_skills(&task.skills, &input.agent)?;
    if let Some(active) = query_runs(
        &conn,
        "WHERE task_id=?1 AND closed_at IS NULL AND internal=0 ORDER BY created_at DESC LIMIT 1",
        [&task.id],
    )?
    .into_iter()
    .next()
    {
        if active.agent != input.agent
            || active.profile_id.as_deref() != Some(input.profile_id.as_str())
        {
            return Err("此目标仍有运行中的 Agent，请先停止它再更换连接".into());
        }
        if let Some(text) = input
            .context_text
            .as_deref()
            .filter(|text| !text.trim().is_empty())
        {
            let root = validate_existing_dir(
                task.project_root.as_deref().ok_or("目标没有项目")?,
                "项目目录",
            )?;
            let dir = task_review_dir(&task.id, &active.id)?;
            let environment = crate::task_review::collect_environment(
                Path::new(&root),
                Path::new(&active.isolation_path),
                &active.agent,
                &active.permission,
                &task.input_paths,
                &task.output_paths,
                skill_snapshots,
                crate::task_review::load_baseline(&dir)?,
            )?;
            crate::task_review::write_context_continuation(
                &dir,
                &active.id,
                text,
                environment,
                &now_rfc3339(),
            )?;
        }
        if input.reuse_isolation.unwrap_or(false) {
            continue_active_goal(&conn, &task.id, &active.id, input.feedback.as_deref())?;
        }
        return Ok(active);
    }
    let root = validate_existing_dir(
        task.project_root.as_deref().ok_or("Task 没有关联项目")?,
        "项目根目录",
    )?;
    let reuse_isolation = input.reuse_isolation.unwrap_or(false);
    if !reuse_isolation {
        let estimate = estimate_task_inputs(Path::new(&root), &task.input_paths)?;
        if !estimate.allowed {
            return Err(format!("所选资料 {} 个文件、{:.1} MB，超过 512 MB 隔离输入预算。请选择较小资料范围；未创建副本、未启动 Agent。", estimate.files, estimate.bytes as f64 / 1024.0 / 1024.0));
        }
    }
    let previous = query_runs(
        &conn,
        "WHERE task_id=?1 AND internal=0 ORDER BY created_at DESC LIMIT 1",
        [&task.id],
    )?
    .into_iter()
    .next();
    let previous_id = previous.as_ref().map(|run| run.id.clone());
    let mut created_here = false;
    let run_root = if reuse_isolation {
        let previous = previous.ok_or("还没有上一版，不能在原副本上继续")?;
        goal_storage::ensure_available(&conn, &previous, false)?;
        goal_storage::ensure_available(&conn, &previous, true)?;
        let existing = PathBuf::from(&previous.isolation_path);
        if !existing.is_dir() {
            return Err("上一版工作目录已经不在，请重新开始这个目标".into());
        }
        existing
    } else {
        created_here = true;
        let staging_id = uuid::Uuid::new_v4().to_string();
        let run_root = task_runs_root()?.join(&task.id).join(&staging_id);
        fs::create_dir_all(&run_root).map_err(|e| format!("创建 Task 独立目录失败：{e}"))?;
        let mut copy_budget = TaskCopyBudget::default();
        for relative in &task.input_paths {
            let result = if relative == "." {
                copy_project_contents(Path::new(&root), &run_root, &mut copy_budget)
            } else {
                let source = Path::new(&root).join(relative);
                let target = run_root.join(relative);
                copy_task_tree_with_budget(&source, &target, &mut copy_budget)
            };
            if let Err(error) = result {
                let _ = fs::remove_dir_all(&run_root);
                return Err(error);
            }
        }
        run_root
    };
    let permission = if task.review_required {
        "write_tree"
    } else {
        "discuss"
    };
    let run = open_run_impl(OpenRunInput {
        id: None,
        task_id: Some(task.id.clone()),
        project_root: Some(root.clone()),
        task_kind: Some(task.kind.clone()),
        task_ref: Some(task.name.clone()),
        isolation_path: run_root.to_string_lossy().into_owned(),
        runtime: Some("local_cli".into()),
        agent: input.agent,
        profile_id: Some(input.profile_id),
        permission: Some(permission.into()),
        reuse_key: Some(format!("task:{}", task.id)),
        session_id: None,
        custom_runtime_id: None,
        internal: Some(false),
        sentinel: Some(false),
    });
    let run = match run {
        Ok(run) => run,
        Err(error) => {
            cleanup_failed_prepare(created_here, &run_root);
            return Err(error);
        }
    };
    conn.execute(
        "UPDATE tasks SET status='running', updated_at=?2 WHERE id=?1",
        params![task.id, now_rfc3339()],
    )
    .map_err(|e| format!("更新 Task 状态失败: {e}"))?;
    if let Some(note) = input
        .feedback
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        if let Some(previous_id) = previous_id.as_deref() {
            record_event(
                &conn,
                previous_id,
                "task.review_notes",
                Some(&serde_json::json!({ "feedback": note }).to_string()),
            )?;
        }
    }
    // 开工基线：需要人审的目标在 Run 登记后立即落哈希清单（评审三向判定的起点）。
    // 写失败 = 这版没法可信验收，按「开工合同失败即停」直接失败并把这 Run 记为 failed，
    // 不静默降级成无基线运行。
    if task.review_required {
        let dir = task_review_dir(&task.id, &run.id)?;
        let baseline = if reuse_isolation {
            let previous_dir =
                task_review_dir(&task.id, previous_id.as_deref().ok_or("缺少上一版运行")?)?;
            crate::task_review::continue_baseline(&dir, &run.id, &previous_dir)
        } else {
            crate::task_review::write_baseline(
                &dir,
                &run.id,
                &run_root,
                Path::new(&root),
                &now_rfc3339(),
            )
        };
        if let Err(error) = baseline {
            drop(storage_lock);
            let _ = close_run_with_result(&run.id, None, "failed", None, Some("评审基线写入失败"));
            return Err(format!("记录开工基线失败，未启动：{error}"));
        }
    }
    // 有效上下文快照：前端实际拼装的下发文本，有就冻结；写失败同样开工失败
    if let Some(text) = input
        .context_text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        let dir = task_review_dir(&task.id, &run.id)?;
        let frozen = (|| {
            let environment = crate::task_review::collect_environment(
                Path::new(&root),
                &run_root,
                &run.agent,
                &run.permission,
                &task.input_paths,
                &task.output_paths,
                skill_snapshots,
                crate::task_review::load_baseline(&dir)?,
            )?;
            crate::task_review::write_context_snapshot(
                &dir,
                &run.id,
                text,
                &now_rfc3339(),
                Some(environment),
            )
        })();
        if let Err(error) = frozen {
            drop(storage_lock);
            let _ =
                close_run_with_result(&run.id, None, "failed", None, Some("上下文快照写入失败"));
            return Err(format!("记录上下文快照失败，未启动：{error}"));
        }
    }
    Ok(run)
}

/// 评审证据目录：归档目标也不删，随 task-runs 树保留。
fn task_review_dir(task_id: &str, run_id: &str) -> Result<PathBuf, String> {
    Ok(task_runs_root()?.join(task_id).join("review").join(run_id))
}

pub(crate) fn result_version_for(run_id: &str) -> Result<Option<String>, String> {
    let run = run_get_sync(run_id.to_string())?.ok_or("Run 不存在")?;
    if run.task_id.is_empty() {
        return Ok(None);
    }
    let dir = task_review_dir(&run.task_id, &run.id)?;
    let Some(snapshot) = crate::task_review::load_snapshot(&dir)? else {
        return Ok(None);
    };
    for change in &snapshot.changes {
        let path = Path::new(&run.isolation_path).join(&change.path);
        if change.too_large {
            return Ok(None);
        }
        let hash = read_regular_optional(&path, "核对成果版本")?;
        if hash != change.sha256 {
            return Ok(None);
        }
    }
    Ok(Some(format!("{}:{}", run.id, snapshot.seq)))
}

/// 结果可审与进程成败解绑（§4.4）：失败/停止的 Run 若冻结到可审成果，
/// 目标同样进入待验收；没有可审成果则保持 failed/stopped 原状。
fn review_status_for(run_status: &str, has_adoptable_changes: bool) -> Option<&'static str> {
    if matches!(run_status, "failed" | "stopped") && has_adoptable_changes {
        Some("pending_review")
    } else {
        None
    }
}

/// Run 收尾时冻结评审证据：只有「需要人审的普通目标」参与；旧 Run 没有基线则跳过不伪造；
/// 冻结失败只记日志与事件，不反向影响收尾登记。
fn freeze_task_run_evidence(run_id: &str) {
    let result = (|| -> Result<bool, String> {
        let conn = db()?;
        let Some(run) = get_run_at(&conn, run_id)? else {
            return Ok(false);
        };
        if run.internal || !matches!(run.task_kind.as_str(), "free_research" | "office_doc") {
            return Ok(false);
        }
        if run.task_id.is_empty() {
            // 无目标 Run（办公文件闲聊等）：没有任务可审，直接跳过
            return Ok(false);
        }
        let _storage_lock = goal_storage::lock_task(&run.task_id)?;
        if goal_storage::ensure_available(&conn, &run, false).is_err()
            || goal_storage::ensure_available(&conn, &run, true).is_err()
        {
            return Ok(false);
        }
        let task = task_by_id(&conn, &run.task_id)?;
        if !task.review_required {
            return Ok(false);
        }
        let dir = task_review_dir(&task.id, &run.id)?;
        // 中断前可能在上一轮快照之后又产生部分成果；收尾再核对，内容未变不新造版本。
        let Some(snapshot) = crate::task_review::freeze_or_refresh(
            &dir,
            &run.id,
            Path::new(&run.isolation_path),
            &task.output_paths,
            &now_rfc3339(),
        )?
        else {
            return Ok(false);
        };
        record_event(
            &conn,
            &run.id,
            "task.snapshot_frozen",
            Some(&serde_json::json!({ "changes": snapshot.changes.len() }).to_string()),
        )?;
        let has_adoptable = snapshot
            .changes
            .iter()
            .any(|change| change.kind != "deleted");
        if let Some(status) = review_status_for(&run.status, has_adoptable) {
            conn.execute(
                "UPDATE tasks SET status=?2, updated_at=?3 WHERE id=?1 AND status IN ('failed','stopped')",
                params![task.id, status, now_rfc3339()],
            )
            .map_err(|e| format!("更新 Task 状态失败: {e}"))?;
        }
        Ok(true)
    })();
    match result {
        Ok(_) => {}
        Err(error) => {
            crate::logbuf::record(
                "error",
                "runs",
                &format!("Run {run_id} 冻结评审证据失败：{error}"),
            );
            if let Ok(conn) = db() {
                let _ = record_event(&conn, run_id, "task.snapshot_failed", Some(&error));
            }
        }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReviewDto {
    /// true = 变更来自收尾时的冻结副本；false = 旧 Run 或冻结失败，退回目录现算。
    pub frozen: bool,
    /// 冻结内容副本目录（预览/采纳的数据源）；未冻结时为 None。
    pub payload_dir: Option<String>,
    /// 冻结版本号（回合再冻结会递增）；采纳时回传绑定「看过的那版」。
    pub seq: Option<u32>,
    pub changes: Vec<TaskOutputChangeDto>,
    pub freeze_required: bool,
    pub readiness: crate::review_contract::ResultReadiness,
    pub pending_apply: Option<GoalApplyPendingDto>,
}

fn task_output_changes_impl(run_id: &str) -> Result<TaskReviewDto, String> {
    let conn = db()?;
    let run = get_run_at(&conn, run_id)?.ok_or("Run 不存在")?;
    let _storage_lock = goal_storage::lock_task(&run.task_id)?;
    goal_storage::ensure_available(&conn, &run, true)?;
    let task = task_by_id(&conn, &run.task_id)?;
    if !task.review_required {
        return Err("该任务不需要审核输出".into());
    }
    let root = validate_existing_dir(
        task.project_root.as_deref().ok_or("Task 没有关联项目")?,
        "项目根目录",
    )?;
    let dir = task_review_dir(&task.id, &run.id)?;
    if let Some(journal) = read_goal_journal(&dir)? {
        let changes = journal
            .files
            .iter()
            .map(|file| TaskOutputChangeDto {
                path: file.path.clone(),
                kind: if file.before.is_some() {
                    "modified"
                } else {
                    "added"
                }
                .into(),
                bytes: fs::metadata(Path::new(&journal.source_root).join(&file.path))
                    .map(|m| m.len())
                    .unwrap_or(0),
                too_large: false,
            })
            .collect();
        return Ok(TaskReviewDto {
            frozen: true,
            payload_dir: Some(journal.source_root.clone()),
            seq: None,
            changes,
            freeze_required: false,
            readiness: crate::review_contract::ResultReadiness::LedgerPending,
            pending_apply: Some(goal_apply_pending(&journal)),
        });
    }
    let snapshot = crate::task_review::load_snapshot(&dir)?;
    // 有冻结证据的 Run 不看进程退出状态（部分成果同样可审）；未冻结的旧 Run 维持 completed 门槛
    if run.status != "completed"
        && snapshot.is_none()
        && crate::task_review::load_baseline(&dir)?.is_none()
    {
        return Err("只有已完成的 Run 才能审核输出（这次运行没有冻结证据）".into());
    }
    if let Some(snapshot) = snapshot {
        let protected = crate::projects::protected_paths_at(Path::new(&root))?;
        let version = format!("{}:{}", run.id, snapshot.seq);
        let applied = crate::projects::read_acceptance_log_at(Path::new(&root))
            .iter()
            .any(|fact| {
                fact.kind == crate::review_contract::KIND_GOAL_ADOPT
                    && fact.goal_id == task.id
                    && fact.version_id == version
            });
        let writable = snapshot.changes.iter().any(|change| {
            change.kind != "deleted"
                && !change.too_large
                && !crate::projects::path_is_protected(&change.path, &protected)
        });
        let readiness =
            crate::review_contract::result_readiness(&crate::review_contract::ReadinessInput {
                kind: crate::review_contract::KIND_GOAL_ADOPT.into(),
                has_snapshot: true,
                has_adoptable: writable,
                protected_hit: !writable
                    && snapshot
                        .changes
                        .iter()
                        .any(|change| change.kind != "deleted"),
                ledger_has_fact: applied,
                ..Default::default()
            });
        let changes = snapshot
            .changes
            .iter()
            .map(|change| TaskOutputChangeDto {
                path: change.path.clone(),
                kind: change.kind.clone(),
                bytes: change.size,
                too_large: change.too_large,
            })
            .collect();
        return Ok(TaskReviewDto {
            frozen: true,
            pending_apply: None,
            readiness,
            freeze_required: false,
            payload_dir: Some(
                crate::task_review::snapshot_payload_dir(&dir, &snapshot)?
                    .to_string_lossy()
                    .into_owned(),
            ),
            seq: Some(snapshot.seq),
            changes,
        });
    }
    let freeze_required = crate::task_review::load_baseline(&dir)?.is_some();
    let mut changes = list_output_changes(
        Path::new(&run.isolation_path),
        Path::new(&root),
        &task.output_paths,
    )?;
    if freeze_required {
        for change in &mut changes {
            change.too_large = true;
        }
    }
    Ok(TaskReviewDto {
        frozen: false,
        pending_apply: None,
        freeze_required,
        payload_dir: None,
        seq: None,
        readiness: if freeze_required {
            crate::review_contract::ResultReadiness::Blocked
        } else {
            crate::review_contract::result_readiness(&crate::review_contract::ReadinessInput {
                kind: crate::review_contract::KIND_GOAL_ADOPT.into(),
                has_adoptable: !changes.is_empty(),
                run_completed: run.status == "completed",
                ..Default::default()
            })
        },
        changes,
    })
}

#[tauri::command]
pub async fn task_output_changes(run_id: String) -> Result<TaskReviewDto, String> {
    tauri::async_runtime::spawn_blocking(move || task_output_changes_impl(&run_id))
        .await
        .map_err(|e| format!("读取任务变更失败：{e}"))?
}

#[tauri::command]
pub async fn task_freeze_large_outputs(
    run_id: String,
    expect_seq: u32,
    confirmed: bool,
) -> Result<TaskReviewDto, String> {
    if !confirmed {
        return Err("需要明确确认大文件冻结预算".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let run = get_run_at(&conn, &run_id)?.ok_or("运行不存在")?;
        let storage_lock = goal_storage::lock_task(&run.task_id)?;
        goal_storage::ensure_available(&conn, &run, false)?;
        goal_storage::ensure_available(&conn, &run, true)?;
        let task = task_by_id(&conn, &run.task_id)?;
        if !task.review_required {
            return Err("这次运行不支持成果验收".into());
        }
        let dir = task_review_dir(&task.id, &run.id)?;
        crate::task_review::freeze_large(
            &dir,
            &run.id,
            Path::new(&run.isolation_path),
            &task.output_paths,
            expect_seq,
            &now_rfc3339(),
        )?;
        drop(storage_lock);
        task_output_changes_impl(&run_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 回合结束即冻结（§4.4 交互式形态）：Agent 答完一轮但 CLI 进程不退出——
/// 终端侦测到回合结束后调这里，把当前成果冻成「当前可审版本」并把目标提升待验收。
/// 返回 true = 本次调用让目标新进入待验收（前端据此发通知）。
#[tauri::command]
pub async fn task_freeze_turn(app: tauri::AppHandle, run_id: String) -> Result<bool, String> {
    use tauri::Emitter;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let Some(run) = get_run_at(&conn, &run_id)? else {
            return Ok(false);
        };
        // 已收尾的 Run 由收尾冻结接管；无目标/无头/非普通目标不审
        if run.closed_at.is_some()
            || run.internal
            || !matches!(run.task_kind.as_str(), "free_research" | "office_doc")
            || run.task_id.is_empty()
        {
            return Ok(false);
        }
        let _storage_lock = goal_storage::lock_task(&run.task_id)?;
        if goal_storage::ensure_available(&conn, &run, false).is_err()
            || goal_storage::ensure_available(&conn, &run, true).is_err() {
            return Ok(false);
        }
        let task = task_by_id(&conn, &run.task_id)?;
        if !task.review_required {
            return Ok(false);
        }
        let dir = task_review_dir(&task.id, &run.id)?;
        let Some(snapshot) = crate::task_review::freeze_or_refresh(
            &dir,
            &run.id,
            Path::new(&run.isolation_path),
            &task.output_paths,
            &now_rfc3339(),
        )?
        else {
            return Ok(false); // 无基线（旧 Run）不伪造
        };
        if !snapshot.changes.iter().any(|change| change.kind != "deleted") {
            return Ok(false); // 没有可审成果不打扰
        }
        record_event(
            &conn,
            &run.id,
            "task.review_ready",
            Some(&serde_json::json!({ "seq": snapshot.seq }).to_string()),
        )?;
        let promoted = conn
            .execute(
                "UPDATE tasks SET status='pending_review', updated_at=?2 WHERE id=?1 AND status='running'",
                params![task.id, now_rfc3339()],
            )
            .map_err(|e| format!("更新 Task 状态失败: {e}"))?
            > 0;
        if promoted {
            let root = task.project_root.clone().unwrap_or_default();
            let _ = app.emit(
                "goal-review-ready",
                serde_json::json!({
                    "taskId": task.id,
                    "runId": run.id,
                    "goalName": task.name,
                    "projectRoot": root,
                }),
            );
        }
        Ok(promoted)
    })
    .await
    .map_err(|e| format!("冻结回合成果失败：{e}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskContextDto {
    pub run_id: String,
    pub created_at: String,
    pub sha256: String,
    pub text: String,
    pub environment: Option<crate::task_review::ContextEnvironment>,
}

/// 开工时冻结的有效上下文快照（§4.8）；旧 Run / 未下发快照返回 None。
#[tauri::command]
pub async fn task_run_context(run_id: String) -> Result<Option<TaskContextDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let run = get_run_at(&conn, &run_id)?.ok_or("Run 不存在")?;
        if run.task_id.is_empty() {
            return Ok(None);
        }
        let _storage_lock = goal_storage::lock_task(&run.task_id)?;
        goal_storage::ensure_available(&conn, &run, true)?;
        let dir = task_review_dir(&run.task_id, &run.id)?;
        crate::task_review::load_current_context(&dir).map(|snapshot| {
            snapshot.map(|snapshot| TaskContextDto {
                run_id: snapshot.run_id,
                created_at: snapshot.created_at,
                sha256: snapshot.sha256,
                text: crate::sessions::redact_sensitive_text(&snapshot.text),
                environment: snapshot.environment.map(|mut environment| {
                    for (_, text) in &mut environment.rules {
                        *text = crate::sessions::redact_sensitive_text(text);
                    }
                    for skill in &mut environment.skills {
                        skill.entry_text =
                            crate::sessions::redact_sensitive_text(&skill.entry_text);
                    }
                    environment
                }),
            })
        })
    })
    .await
    .map_err(|e| format!("读取上下文快照失败：{e}"))?
}

fn task_adopt_outputs_impl(
    run_id: &str,
    paths: Option<Vec<String>>,
    note: Option<String>,
    expect_seq: Option<u32>,
    memorize: Option<bool>,
) -> Result<TaskDto, String> {
    let conn = db()?;
    let run = get_run_at(&conn, run_id)?.ok_or("Run 不存在")?;
    let _storage_lock = goal_storage::lock_task(&run.task_id)?;
    goal_storage::ensure_available(&conn, &run, true)?;
    let task = task_by_id(&conn, &run.task_id)?;
    let root = validate_existing_dir(
        task.project_root.as_deref().ok_or("Task 没有关联项目")?,
        "项目根目录",
    )?;
    let _adopt_lock = crate::review_contract::apply_lock(Path::new(&root))?;
    let dir = task_review_dir(&task.id, &run.id)?;
    if read_goal_journal(&dir)?.is_some() {
        return Err("有未完成的接受操作，请先继续原操作或恢复原文件；不会改为接受最新版本".into());
    }
    let snapshot = crate::task_review::load_snapshot(&dir)?;
    if snapshot.is_none() && crate::task_review::load_baseline(&dir)?.is_some() {
        return Err("这次运行冻结尚未成功，不能按实时目录采纳；请先冻结成果或缩小输出范围".into());
    }
    // 有冻结证据的 Run 不看进程退出状态（部分成果同样可采纳）；未冻结的旧 Run 维持 completed 门槛
    if run.status != "completed" && snapshot.is_none() {
        return Err("只有已完成的 Run 才能采纳输出（这次运行没有冻结证据）".into());
    }
    // 可采纳集合：已冻结 = 快照里 added/modified 且未超上限的；未冻结（旧 Run/冻结失败）退回目录现算。
    let available: Vec<String> = match &snapshot {
        Some(snapshot) => snapshot
            .changes
            .iter()
            .filter(|change| change.kind != "deleted" && !change.too_large)
            .map(|change| change.path.clone())
            .collect(),
        None => list_output_changes(
            Path::new(&run.isolation_path),
            Path::new(&root),
            &task.output_paths,
        )?
        .iter()
        .map(|change| change.path.clone())
        .collect(),
    };
    let selected = match paths {
        None => available.clone(),
        Some(list) if list.is_empty() => Vec::new(),
        Some(list) => {
            let allowed: std::collections::HashSet<_> = available.iter().cloned().collect();
            let mut selected = Vec::new();
            for raw in list {
                let relative = validate_output_rel(&raw)?;
                if !allowed.contains(&relative) {
                    return Err(format!("没有可采纳的变更：{relative}"));
                }
                if !selected.contains(&relative) {
                    selected.push(relative);
                }
            }
            selected
        }
    };
    // 保护路径读不出来 = 不可信，fail-closed 拒绝写回，不按「没有保护」继续复制
    let protected = crate::projects::protected_paths_at(Path::new(&root))?;
    for relative in &selected {
        if crate::projects::path_is_protected(relative, &protected) {
            return Err(format!("保护路径不可覆盖：{relative}"));
        }
        let target = Path::new(&root).join(relative);
        if let Some(mut probe) = target.parent() {
            while !probe.exists() {
                probe = probe.parent().ok_or("输出目标无法解析")?;
            }
            let parent = crate::paths::canonicalize_plain(probe)
                .map_err(|e| format!("输出目标无法解析：{e}"))?;
            if !crate::paths::path_within(&parent.to_string_lossy(), &root) {
                return Err("输出目标必须位于项目目录内".into());
            }
        }
    }
    let validate_frozen = || -> Result<(), String> {
        if let Some(snapshot) = &snapshot {
            // 版本绑定：人看过的 seq 与当前冻结不一致 = 看过之后又有新成果，拒绝并要求重看
            let expect = expect_seq.ok_or("请先查看这版冻结结果，再执行采纳")?;
            crate::review_contract::assert_seq(expect, snapshot.seq)?;
            // 冻结路径：三向判定（项目现读 vs 开工基线 vs 冻结内容），写入源只认 payload 副本；
            // 「看过的版本」与「写入的版本」由此逐字节绑定。
            let baseline = crate::task_review::load_baseline(&dir)?;
            let mut accepted = std::collections::HashMap::new();
            for fact in crate::projects::read_acceptance_log_at(Path::new(&root)) {
                if fact.kind == crate::review_contract::KIND_GOAL_ADOPT && fact.goal_id == task.id {
                    for file in fact.content_fingerprints {
                        if let Some(sha) = file.sha256 {
                            accepted.insert(file.path, sha);
                        }
                    }
                }
            }
            crate::task_review::check_adoption(
                &dir,
                snapshot,
                baseline.as_ref(),
                &selected,
                Path::new(&root),
                &accepted,
            )?;
        }
        Ok(())
    };
    validate_frozen()?;
    // 第一处项目写入之前持久化原版本、目标前态、备份和用户决定。
    let note = note.unwrap_or_default();
    let mut entry = crate::review_contract::fact_from_goal_adopt(
        Path::new(&root),
        &task.id,
        &task.name,
        run_id,
        snapshot.as_ref().map(|item| item.seq),
        selected.clone(),
        note.clone(),
        snapshot.is_some(),
        now_rfc3339(),
    );
    if let Some(snapshot) = &snapshot {
        entry.content_fingerprints = snapshot
            .changes
            .iter()
            .filter(|file| selected.contains(&file.path))
            .map(|file| crate::projects::ContentFingerprint {
                path: file.path.clone(),
                size: file.size,
                sha256: file.sha256.clone(),
            })
            .collect();
    }
    let source = match &snapshot {
        Some(snapshot) => crate::task_review::snapshot_payload_dir(&dir, snapshot)?,
        None => PathBuf::from(&run.isolation_path),
    };
    let mut journal = prepare_goal_journal(
        &dir,
        &source,
        Path::new(&root),
        entry,
        memorize.unwrap_or(false),
    )?;
    if let Err(error) = validate_frozen() {
        clear_goal_journal(&dir)?;
        return Err(error); // 备份期间项目漂移，尚未写入；不能把变化后的文件当作新基线。
    }
    finish_goal_journal(&conn, &dir, Path::new(&root), &mut journal).map_err(|e| {
        format!("接受尚未完成：{e}。恢复单和备份已保留，请在评审中继续原操作或恢复原文件。")
    })?;
    task_by_id(&conn, &run.task_id)
}

#[tauri::command]
pub async fn task_recover_outputs(
    run_id: String,
    operation_id: String,
    action: String,
) -> Result<TaskDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let run = get_run_at(&conn, &run_id)?.ok_or("运行不存在")?;
        let _storage_lock = goal_storage::lock_task(&run.task_id)?;
        goal_storage::ensure_available(&conn, &run, true)?;
        let task = task_by_id(&conn, &run.task_id)?;
        let root = validate_existing_dir(
            task.project_root.as_deref().ok_or("目标没有项目")?,
            "项目目录",
        )?;
        let _lock = crate::review_contract::apply_lock(Path::new(&root))?;
        let dir = task_review_dir(&task.id, &run.id)?;
        let mut journal = read_goal_journal(&dir)?.ok_or("此接受操作已处理，请刷新")?;
        if journal.id != operation_id
            || journal.fact.run_id != run.id
            || journal.fact.goal_id != task.id
        {
            return Err("恢复请求与原接受操作不一致".into());
        }
        if journal.fact.project_id.is_some() {
            if journal.fact.project_id != crate::projects::project_id_at(Path::new(&root)) {
                return Err("恢复单项目身份不一致".into());
            }
        } else if !crate::paths::same_path(&journal.project_root, &root) {
            return Err("旧恢复单项目位置不一致，未写入".into());
        }
        match action.as_str() {
            "continue" => finish_goal_journal(&conn, &dir, Path::new(&root), &mut journal)?,
            "rollback" => rollback_goal_journal(&dir, Path::new(&root), &journal)?,
            _ => return Err("不支持的恢复操作".into()),
        }
        task_by_id(&conn, &task.id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn task_adopt_outputs(
    run_id: String,
    paths: Option<Vec<String>>,
    note: Option<String>,
    expect_seq: Option<u32>,
    memorize: Option<bool>,
) -> Result<TaskDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        task_adopt_outputs_impl(&run_id, paths, note, expect_seq, memorize)
    })
    .await
    .map_err(|e| format!("采纳输出失败：{e}"))?
}
fn list_tasks_at(
    conn: &Connection,
    project_root: Option<&str>,
    include_archived: bool,
) -> Result<Vec<TaskDto>, String> {
    let include = if include_archived { 1i64 } else { 0 };
    match project_root {
        None => {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {TASK_COLS} FROM tasks WHERE (?1=1 OR archived_at IS NULL) ORDER BY updated_at DESC"
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![include], map_task)
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
        }
        Some(root) => match project_id_for(conn, Some(root))
            .or_else(|| crate::projects::project_id_at(Path::new(root)))
        {
            Some(id) => {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT {TASK_COLS} FROM tasks WHERE (project_id=?1 OR (project_id IS NULL AND project_root=?2)) AND (?3=1 OR archived_at IS NULL) ORDER BY updated_at DESC"
                    ))
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![id, root, include], map_task)
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
            }
            None => {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT {TASK_COLS} FROM tasks WHERE project_root=?1 AND (?2=1 OR archived_at IS NULL) ORDER BY updated_at DESC"
                    ))
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![root, include], map_task)
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
            }
        },
    }
}

fn attach_pending_goal_apply(conn: &Connection, task: TaskDto) -> Result<TaskDto, String> {
    let mut task = goal_storage::attach(conn, task)?;
    if !task.review_required {
        return Ok(task);
    }
    let mut stmt = conn
        .prepare("SELECT id FROM runs WHERE task_id=?1 ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([&task.id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for id in ids {
        let id = id.map_err(|e| e.to_string())?;
        if goal_journal_path(&task_review_dir(&task.id, &id)?)
            .try_exists()
            .map_err(|e| e.to_string())?
        {
            task.pending_apply_run_id = Some(id);
            break;
        }
    }
    Ok(task)
}

#[tauri::command]
pub async fn task_list(
    project_root: Option<String>,
    include_archived: Option<bool>,
) -> Result<Vec<TaskDto>, String> {
    tauri::async_runtime::spawn_blocking(move || task_list_sync(project_root, include_archived))
        .await
        .map_err(|e| e.to_string())?
}
fn task_list_sync(
    project_root: Option<String>,
    include_archived: Option<bool>,
) -> Result<Vec<TaskDto>, String> {
    let conn = db()?;
    let tasks = list_tasks_at(
        &conn,
        project_root.as_deref(),
        include_archived.unwrap_or(false),
    )?;
    tasks
        .into_iter()
        .map(|task| attach_pending_goal_apply(&conn, resolve_task_project(&conn, task)?))
        .collect()
}

fn archive_goal_at(conn: &Connection, id: &str) -> Result<(), String> {
    let task = attach_pending_goal_apply(conn, task_by_id(conn, id)?)?;
    if task.pending_apply_run_id.is_some() {
        return Err("目标有未完成的接受操作，请先处理后再归档".into());
    }
    if task.storage_cleanup_pending {
        return Err("目标有未完成的副本清理，请先继续清理".into());
    }
    if !task.declared {
        return Err("只能归档你记下的目标".into());
    }
    if task.kind != "free_research" && task.kind != "office_doc" {
        return Err("只能归档科研或工作目标".into());
    }
    if task.status == "running" {
        return Err("先停掉正在跑的 Agent，再归档这个目标".into());
    }
    let open = query_runs(
        conn,
        "WHERE task_id=?1 AND closed_at IS NULL AND internal=0 LIMIT 1",
        [id],
    )?;
    if !open.is_empty() {
        return Err("先停掉正在跑的 Agent，再归档这个目标".into());
    }
    if task.archived_at.is_some() {
        return Ok(());
    }
    conn.execute(
        "UPDATE tasks SET archived_at=?2, updated_at=?2 WHERE id=?1",
        params![id, now_rfc3339()],
    )
    .map_err(|e| format!("归档目标失败: {e}"))?;
    Ok(())
}

fn unarchive_goal_at(conn: &Connection, id: &str) -> Result<TaskDto, String> {
    let task = task_by_id(conn, id)?;
    if goal_storage::has_pending(conn, id)? {
        return Err("目标有未完成的副本清理，请先继续清理".into());
    }
    if !task.declared {
        return Err("只能恢复你记下的目标".into());
    }
    if task.kind != "free_research" && task.kind != "office_doc" {
        return Err("只能恢复科研或工作目标".into());
    }
    if task.archived_at.is_none() {
        return Ok(task);
    }
    conn.execute(
        "UPDATE tasks SET archived_at=NULL, updated_at=?2 WHERE id=?1",
        params![id, now_rfc3339()],
    )
    .map_err(|e| format!("恢复目标失败: {e}"))?;
    task_by_id(conn, id)
}

#[tauri::command]
pub async fn task_delete(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || task_delete_sync(id))
        .await
        .map_err(|e| e.to_string())?
}
fn task_delete_sync(id: String) -> Result<(), String> {
    let _lock = goal_storage::lock_task(&id)?;
    archive_goal_at(&db()?, &id)
}

#[tauri::command]
pub async fn task_unarchive(id: String) -> Result<TaskDto, String> {
    tauri::async_runtime::spawn_blocking(move || task_unarchive_sync(id))
        .await
        .map_err(|e| e.to_string())?
}
fn task_unarchive_sync(id: String) -> Result<TaskDto, String> {
    let _lock = goal_storage::lock_task(&id)?;
    unarchive_goal_at(&db()?, &id)
}

/// 从「已归档」里彻底去掉这条目标。不删项目里已接受的文件。
/// 内部副本还在时拒绝，避免删掉记录后副本没处清理。
/// 目录里除了 .DS_Store 还有别的东西，才算副本还在。
fn copy_dir_occupied(dir: &std::path::Path) -> Result<bool, String> {
    let entries = std::fs::read_dir(dir).map_err(|err| format!("检查副本目录失败: {err}"))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("检查副本目录失败: {err}"))?;
        if entry.file_name() == ".DS_Store" {
            continue;
        }
        return Ok(true);
    }
    Ok(false)
}

fn purge_archived_goal_at(conn: &Connection, id: &str) -> Result<(), String> {
    let task = attach_pending_goal_apply(conn, task_by_id(conn, id)?)?;
    if task.archived_at.is_none() {
        return Err("先归档，再删除这个目标".into());
    }
    if task.pending_apply_run_id.is_some() {
        return Err("目标有未完成的接受操作，请先处理后再删除".into());
    }
    if task.storage_cleanup_pending {
        return Err("还有未完成的副本清理，请先继续清理再删除".into());
    }
    if !task.declared {
        return Err("只能删除你记下的目标".into());
    }
    if task.kind != "free_research" && task.kind != "office_doc" {
        return Err("只能删除科研或工作目标".into());
    }
    let open = query_runs(
        conn,
        "WHERE task_id=?1 AND closed_at IS NULL AND internal=0 LIMIT 1",
        [id],
    )?;
    if !open.is_empty() {
        return Err("先停掉正在跑的 Agent，再删除这个目标".into());
    }
    // 释放副本后，目标目录本身常还留着空壳。空目录不算占用，删掉再继续。
    // 里面还有工作副本或评审目录时才拒绝。
    if let Ok(root) = goal_storage::root() {
        let dir = root.join(id);
        match std::fs::symlink_metadata(&dir) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("检查副本目录失败: {err}")),
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("副本目录不是普通目录，未删除。".into());
            }
            Ok(_) => {
                if copy_dir_occupied(&dir)? {
                    return Err("还有内部副本。请先释放副本空间，再删除这条归档。".into());
                }
                let _ = std::fs::remove_file(dir.join(".DS_Store"));
                std::fs::remove_dir(&dir).map_err(|err| format!("去掉空副本目录失败: {err}"))?;
            }
        }
    }
    let run_ids = query_runs(conn, "WHERE task_id=?1", [id])?
        .into_iter()
        .map(|run| run.id)
        .collect::<Vec<_>>();
    for run_id in &run_ids {
        conn.execute("DELETE FROM run_events WHERE run_id=?1", [run_id])
            .map_err(|err| format!("删除目标记录失败: {err}"))?;
    }
    conn.execute("DELETE FROM runs WHERE task_id=?1", [id])
        .map_err(|err| format!("删除目标记录失败: {err}"))?;
    conn.execute("DELETE FROM goal_storage_pending WHERE task_id=?1", [id])
        .map_err(|err| format!("删除目标记录失败: {err}"))?;
    conn.execute("DELETE FROM tasks WHERE id=?1", [id])
        .map_err(|err| format!("删除目标记录失败: {err}"))?;
    Ok(())
}

#[tauri::command]
pub async fn task_purge_archived(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || task_purge_archived_sync(id))
        .await
        .map_err(|e| e.to_string())?
}
fn task_purge_archived_sync(id: String) -> Result<(), String> {
    let _lock = goal_storage::lock_task(&id)?;
    purge_archived_goal_at(&db()?, &id)
}

#[tauri::command]
pub async fn task_get(id: String) -> Result<Option<TaskDto>, String> {
    tauri::async_runtime::spawn_blocking(move || task_get_sync(id))
        .await
        .map_err(|e| e.to_string())?
}
fn task_get_sync(id: String) -> Result<Option<TaskDto>, String> {
    let conn = db()?;
    let task = conn
        .query_row(
            &format!("SELECT {TASK_COLS} FROM tasks WHERE id=?1"),
            [id],
            map_task,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    task.map(|task| goal_storage::attach(&conn, resolve_task_project(&conn, task)?))
        .transpose()
}

pub fn runtime_capabilities(runtime: &str) -> crate::runtime::RuntimeCapabilities {
    crate::runtime::RuntimeKind::parse(runtime)
        .map(crate::runtime::capabilities)
        .unwrap_or_else(|| crate::runtime::capabilities(crate::runtime::RuntimeKind::Custom))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDto {
    pub id: String,
    pub project_root: Option<String>,
    pub task_kind: String,
    pub task_ref: Option<String>,
    pub isolation_path: String,
    pub runtime: String,
    pub agent: String,
    pub profile_id: Option<String>,
    pub permission: String,
    pub reuse_key: Option<String>,
    pub session_id: Option<String>,
    pub internal: bool,
    pub sentinel: bool,
    pub created_at: String,
    pub closed_at: Option<String>,
    pub status: String,
    pub exit_code: Option<i32>,
    pub close_reason: Option<String>,
    pub task_id: String,
    pub custom_runtime_id: Option<String>,
    /// 项目稳定 id（§4.6 二期双写；旧行可能未回填 = None）
    pub project_id: Option<String>,
    pub capabilities: crate::runtime::RuntimeCapabilities,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRunInput {
    pub id: Option<String>,
    pub task_id: Option<String>,
    pub project_root: Option<String>,
    pub task_kind: Option<String>,
    pub task_ref: Option<String>,
    pub isolation_path: String,
    pub runtime: Option<String>,
    pub agent: String,
    pub profile_id: Option<String>,
    pub permission: Option<String>,
    pub reuse_key: Option<String>,
    pub session_id: Option<String>,
    pub custom_runtime_id: Option<String>,
    pub internal: Option<bool>,
    pub sentinel: Option<bool>,
}
fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunDto> {
    let runtime: String = row.get(5)?;
    Ok(RunDto {
        id: row.get(0)?,
        project_root: row.get(1)?,
        task_kind: row.get(2)?,
        task_ref: row.get(3)?,
        isolation_path: row.get(4)?,
        capabilities: runtime_capabilities(&runtime),
        runtime,
        agent: row.get(6)?,
        profile_id: row.get(7)?,
        permission: row.get(8)?,
        reuse_key: row.get(9)?,
        session_id: row.get(10)?,
        internal: row.get::<_, i64>(11)? != 0,
        sentinel: row.get::<_, i64>(12)? != 0,
        created_at: row.get(13)?,
        closed_at: row.get(14)?,
        status: row.get(15)?,
        exit_code: row.get(16)?,
        close_reason: row.get(17)?,
        task_id: row.get::<_, Option<String>>(18)?.unwrap_or_default(),
        custom_runtime_id: row.get(19)?,
        project_id: row.get(20)?,
    })
}
const COLS: &str = "id,project_root,task_kind,task_ref,isolation_path,runtime,agent,profile_id,permission,reuse_key,session_id,internal,sentinel,created_at,closed_at,status,exit_code,close_reason,task_id,custom_runtime_id,project_id";
fn query_runs<P: rusqlite::Params>(
    conn: &Connection,
    clause: &str,
    p: P,
) -> Result<Vec<RunDto>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLS} FROM runs {clause}"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(p, map_row).map_err(|e| e.to_string())?;
    let runs: Vec<RunDto> = rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    runs.into_iter()
        .map(|run| resolve_run_project(conn, run))
        .collect()
}
fn get_run_at(conn: &Connection, id: &str) -> Result<Option<RunDto>, String> {
    let run = conn
        .query_row(
            &format!("SELECT {COLS} FROM runs WHERE id=?1"),
            [id],
            map_row,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    run.map(|run| resolve_run_project(conn, run)).transpose()
}
pub(crate) fn validate_existing_dir(path: &str, label: &str) -> Result<String, String> {
    let expanded = crate::sessions::expand_tilde(path);
    if !std::path::Path::new(&expanded).is_dir() {
        return Err(format!("{label} 必须是已存在的目录: {expanded}"));
    }
    crate::paths::canonicalize_plain(std::path::Path::new(&expanded))
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("{label} 无法解析: {e}"))
}
fn requires_isolated_write_tree(kind: &str, sentinel: bool) -> bool {
    !sentinel && matches!(kind, "pipeline_step" | "coding_lane" | "watch")
}

fn validate_policy(input: &OpenRunInput) -> Result<(), String> {
    let kind = input.task_kind.as_deref().unwrap_or("scratch");
    let runtime = input.runtime.as_deref().unwrap_or("local_cli");
    let permission = input.permission.as_deref().unwrap_or("write_tree");
    if !matches!(runtime, "local_cli" | "headless" | "custom") {
        return Err("不支持的 Runtime".into());
    }
    if runtime == "custom" {
        let id = input
            .custom_runtime_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .ok_or("Custom Runtime 必须绑定已保存的运行时配置")?;
        crate::custom_runtime::get_custom_runtime(id)?;
    } else if input.custom_runtime_id.is_some() {
        return Err("只有 Custom Runtime 可以绑定自定义运行时配置".into());
    }
    if !matches!(permission, "discuss" | "write_tree") {
        return Err("不支持的权限政策".into());
    }
    if runtime == "local_cli"
        && permission == "discuss"
        && crate::agents::readonly_launch_args(&input.agent, &[]).is_none()
    {
        return Err("此 Agent 不支持只讨论权限，请更换 Agent 或明确选择可写权限".into());
    }

    if !matches!(
        kind,
        "pipeline_step"
            | "coding_lane"
            | "office_doc"
            | "free_research"
            | "watch"
            | "reader"
            | "scratch"
    ) {
        return Err("不支持的 Task 类型".into());
    }
    if input.sentinel.unwrap_or(false) && (kind != "watch" || runtime != "headless") {
        return Err("只有定时无头任务可以声明主仓哨兵".into());
    }
    if permission == "write_tree"
        && requires_isolated_write_tree(kind, input.sentinel.unwrap_or(false))
    {
        let root = input
            .project_root
            .as_deref()
            .ok_or("无法确定这棵工作树属于哪个项目：从编程页进入一次（或给它分组）即可建立关联；拒绝启动写盘任务")?;
        if crate::paths::path_within(&input.isolation_path, root) {
            return Err("写盘任务必须进入主仓之外的隔离工作树，不得回落主仓".into());
        }
    }
    Ok(())
}
pub fn open_run_impl(mut input: OpenRunInput) -> Result<RunDto, String> {
    input.isolation_path = validate_existing_dir(&input.isolation_path, "隔离路径")?;
    if let Some(key) = input.reuse_key.take() {
        let key = canonicalize_reuse_key(&key);
        input.reuse_key = if key.is_empty() { None } else { Some(key) };
    }
    let reuse = input.reuse_key.as_deref().unwrap_or("");
    // 恢复已有 Run（带 id）时不重新猜测身份：按 reuseKey/路径推出的 kind/ref/root
    // 与已登记值稍有出入（声明目标是 free_research + 目标名，路径只能推出
    // scratch/目录名）就会被 open_at 的身份校验拒掉。推断只服务新建。
    if input.id.is_none() {
        input.project_root = input
            .project_root
            .or_else(|| infer_project_root(reuse, &input.isolation_path))
            .map(|p| validate_existing_dir(&p, "项目根目录"))
            .transpose()?;
        input.task_kind = Some(
            input
                .task_kind
                .unwrap_or_else(|| infer_task_kind(reuse, &input.isolation_path).into()),
        );
        // 无显式 taskRef 时以完整隔离路径命名，避免同项目下同名文件/车道串 Task。
        input.task_ref = input.task_ref.or_else(|| {
            if reuse.starts_with("watch:") {
                infer_task_ref(reuse, &input.isolation_path)
            } else if reuse.starts_with("office:") {
                Some(reuse.into())
            } else {
                Some(input.isolation_path.clone())
            }
        });
    }
    validate_policy(&input)?;
    let mut conn = db()?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    goal_storage::check_open(&tx, &input)?;
    let run = open_at(&tx, input)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(run)
}
fn open_at(conn: &Connection, input: OpenRunInput) -> Result<RunDto, String> {
    let runtime = input.runtime.as_deref().unwrap_or("local_cli");
    let kind = input.task_kind.as_deref().unwrap_or("scratch");
    let reuse = input.reuse_key.as_deref().filter(|s| !s.trim().is_empty());
    let internal = input.internal.unwrap_or(false)
        || runtime == "headless"
        || is_internal_kind(kind, reuse.unwrap_or(""));
    if let Some(id) = &input.id {
        if let Some(existing) = get_run_at(conn, id)? {
            if existing.runtime != runtime
                || existing.agent != input.agent
                || existing.isolation_path != input.isolation_path
                || existing.custom_runtime_id
                    != input
                        .custom_runtime_id
                        .as_deref()
                        .filter(|id| !id.trim().is_empty())
                        .map(str::to_owned)
                || input
                    .project_root
                    .as_deref()
                    .is_some_and(|root| existing.project_root.as_deref() != Some(root))
                || input
                    .task_kind
                    .as_deref()
                    .is_some_and(|kind| existing.task_kind != kind)
                || input
                    .task_ref
                    .as_deref()
                    .is_some_and(|task_ref| existing.task_ref.as_deref() != Some(task_ref))
                || input
                    .permission
                    .as_deref()
                    .is_some_and(|permission| existing.permission != permission)
                || input
                    .task_id
                    .as_deref()
                    .is_some_and(|task_id| existing.task_id != task_id)
            {
                return Err("Run 身份与启动目标不一致，不能改写已有 Run".into());
            }
            if existing.closed_at.is_none() {
                return Ok(existing);
            }
            if !existing.capabilities.can_resume || input.session_id.is_none() {
                return Err("此 Run 不支持恢复；请从任务入口再次运行".into());
            }
            if existing.session_id.is_none() {
                // 交互 Run 从没登记上会话（前端闭包读到旧 runId 漏登记，2026-10-21 Gemini / Kimi / OpenCode 存量）：
                // 首次恢复时认下这条会话，同 attach_session_impl「首次登记为准」
                conn.execute(
                    "UPDATE runs SET session_id=?2 WHERE id=?1 AND session_id IS NULL",
                    params![id, input.session_id],
                )
                .map_err(|e| e.to_string())?;
                record_event(conn, id, "run.session_attached", None)?;
            } else if existing.session_id.as_deref() != input.session_id.as_deref() {
                return Err("恢复会话与原 Run 不一致；请从原会话入口恢复".into());
            }
            conn.execute("UPDATE runs SET status='created',closed_at=NULL,exit_code=NULL,close_reason=NULL,profile_id=?2 WHERE id=?1", params![id,input.profile_id]).map_err(|e| e.to_string())?;
            // 恢复目标关联的 Run = 目标回到进行中（否则项目页一直显示「重试」，与事实相反）
            conn.execute(
                "UPDATE tasks SET status='running', updated_at=?1 WHERE id=(SELECT task_id FROM runs WHERE id=?2) AND status IN ('failed','stopped','pending_review')",
                params![now_rfc3339(), id],
            )
            .map_err(|e| e.to_string())?;
            record_event(conn, id, "run.resumed", None)?;
            return get_run_at(conn, id)?.ok_or("Run 不存在".into());
        }
        return Err("Run 不存在；不能用失效 id 创建另一条任务".into());
    }
    if !internal {
        if let Some(key) = reuse {
            if let Some(run) = query_runs(conn, "WHERE reuse_key=?1 AND closed_at IS NULL AND internal=0 ORDER BY created_at DESC LIMIT 1", [key])?.into_iter().next() {
                if run.agent != input.agent || run.runtime != runtime || run.isolation_path != input.isolation_path
                    || input.permission.as_deref().is_some_and(|p| run.permission != p) {
                    return Err("这条工作树已有活跃执行体（可能是没有终端标签的运行中会话）。到工作台「正在进行」或运行页找到它停止后再换；沿用原执行体进入不受影响".into());
                }
                return Ok(run);
            }
        }
    }
    let task = if let Some(task_id) = input.task_id.as_deref() {
        let task = task_by_id(conn, task_id)?;
        if input
            .project_root
            .as_deref()
            .is_some_and(|root| task.project_root.as_deref() != Some(root))
        {
            return Err("Task 与项目不匹配".into());
        }
        if task.kind != kind {
            return Err("Task 类型与 Run 不匹配".into());
        }
        Some(task)
    } else if run_needs_task(kind) {
        Some(ensure_task_at(
            conn,
            input.project_root.as_deref(),
            kind,
            input.task_ref.as_deref(),
            &input.isolation_path,
        )?)
    } else {
        // Run 可以没有 Goal（§4.7）：随手聊/阅读/办公文件闲聊不是目标，不再强制登记 Task 行
        None
    };
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
    // §4.6 二期双写：优先跟任务的 project_id，无任务时按 project_root 查注册表
    let project_id = task
        .as_ref()
        .and_then(|task| task.project_id.clone())
        .or_else(|| project_id_for(conn, input.project_root.as_deref()));
    conn.execute("INSERT INTO runs(id,project_root,task_kind,task_ref,isolation_path,runtime,agent,profile_id,permission,reuse_key,session_id,internal,sentinel,created_at,status,task_id,custom_runtime_id,project_id)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'created',?15,?16,?17)",
        params![id,input.project_root,kind,input.task_ref,input.isolation_path,runtime,input.agent,input.profile_id,
            input.permission.unwrap_or_else(|| "write_tree".into()),reuse,input.session_id,internal,input.sentinel.unwrap_or(false),now,task.as_ref().map(|task| task.id.clone()),input.custom_runtime_id,project_id])
        .map_err(|e| e.to_string())?;
    if let Some(task) = &task {
        conn.execute(
            "UPDATE tasks SET updated_at=?2 WHERE id=?1",
            params![task.id, now],
        )
        .map_err(|e| e.to_string())?;
    }
    record_event(conn, &id, "run.created", None)?;
    get_run_at(conn, &id)?.ok_or("Run 写入后读回失败".into())
}
fn claim_at(conn: &Connection, id: &str) -> Result<(), String> {
    if let Some(run) = get_run_at(conn, id)? {
        goal_storage::ensure_available(conn, &run, false)?;
    }
    let n = conn.execute("UPDATE runs SET status='starting' WHERE id=?1 AND status='created' AND closed_at IS NULL",[id]).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err("Run 已启动或已结束，拒绝重复创建进程".into());
    }
    record_event(conn, id, "run.start_requested", None)
}
fn leases() -> &'static std::sync::Mutex<std::collections::HashMap<String, fs::File>> {
    static LEASES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, fs::File>>,
    > = std::sync::OnceLock::new();
    LEASES.get_or_init(Default::default)
}

fn lease_dir() -> Result<PathBuf, String> {
    Ok(crate::dirs::config_dir()
        .ok_or("无法确定配置目录")?
        .join("ccode/run-leases"))
}

fn try_run_lease(dir: &Path, id: &str) -> Result<Option<fs::File>, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{:x}.lock", md5::compute(id.as_bytes())));
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("打开运行锁失败：{e}"))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(error) => Err(format!("取得运行锁失败：{error}")),
    }
}

pub fn claim_start(id: &str) -> Result<(), String> {
    let mut leases = leases().lock().unwrap_or_else(|e| e.into_inner());
    if leases.contains_key(id) {
        return Err("此运行已在启动或执行中".into());
    }
    let lease = try_run_lease(&lease_dir()?, id)?.ok_or("此运行正在另一个实例执行")?;
    let mut conn = db()?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    claim_at(&tx, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    leases.insert(id.to_string(), lease);
    Ok(())
}

/// 交互终端再启动：没有活 PTY 时回收上次没放掉的锁，并把 starting/running 拉回可 claim。
/// 无头路径仍走 `claim_start`，避免误回收还在跑的 capture。
pub fn claim_interactive_start(id: &str, pty_live: bool) -> Result<(), String> {
    if pty_live {
        return Err("此运行已在启动或执行中".into());
    }
    let mut leases = leases().lock().unwrap_or_else(|e| e.into_inner());
    leases.remove(id);
    let lease = try_run_lease(&lease_dir()?, id)?.ok_or("此运行正在另一个实例执行")?;
    let mut conn = db()?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    mark_starting_for_interactive(&tx, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    leases.insert(id.to_string(), lease);
    Ok(())
}

fn mark_starting_for_interactive(conn: &Connection, id: &str) -> Result<(), String> {
    if let Some(run) = get_run_at(conn, id)? {
        goal_storage::ensure_available(conn, &run, false)?;
    }
    let n = conn
        .execute(
            "UPDATE runs SET status='starting' WHERE id=?1 AND closed_at IS NULL AND status IN ('created','starting','running')",
            [id],
        )
        .map_err(|e| e.to_string())?;
    if n != 1 {
        return Err("Run 已启动或已结束，拒绝重复创建进程".into());
    }
    record_event(conn, id, "run.start_requested", None)
}
pub fn mark_started(id: &str) -> Result<(), String> {
    let mut conn = db()?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let changed = tx.execute("UPDATE runs SET status='running' WHERE id=?1 AND status='starting' AND closed_at IS NULL",[id]).map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("Run 未处于 starting 状态，不能标记为 running".into());
    }
    record_event(&tx, id, "run.started", None)?;
    tx.commit().map_err(|e| e.to_string())
}
fn close_at(
    conn: &Connection,
    id: &str,
    session: Option<&str>,
    status: &str,
    code: Option<i32>,
    reason: Option<&str>,
) -> Result<(), String> {
    if !matches!(status, "completed" | "failed" | "stopped") {
        return Err("无效的 Run 结束状态".into());
    }
    let reason = reason.map(crate::sessions::redact_sensitive_text);
    let task_meta: Option<(String, bool)> = conn
        .query_row(
            "SELECT t.id, t.review_required
             FROM runs r JOIN tasks t ON t.id=r.task_id
             WHERE r.id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let changed = conn.execute("UPDATE runs SET closed_at=?2,session_id=COALESCE(?3,session_id),status=?4,exit_code=?5,close_reason=?6 WHERE id=?1 AND closed_at IS NULL",
        params![id,now_rfc3339(),session,status,code,reason]).map_err(|e| e.to_string())?;
    if changed > 0 {
        if let Some((task_id, review_required)) = task_meta {
            let task_status = match status {
                "completed" if review_required => "pending_review",
                "completed" => "completed",
                "failed" => "failed",
                "stopped" => "stopped",
                _ => "pending",
            };
            conn.execute(
                "UPDATE tasks SET status=?2, updated_at=?3 WHERE id=?1 AND status NOT IN ('pending_review','completed')",
                params![task_id, task_status, now_rfc3339()],
            )
            .map_err(|e| e.to_string())?;
        }
        record_event(
            conn,
            id,
            &format!("run.{status}"),
            Some(&serde_json::json!({"exitCode":code,"reason":reason}).to_string()),
        )?;
    }
    Ok(())
}

pub fn close_run_with_result(
    id: &str,
    session: Option<&str>,
    status: &str,
    code: Option<i32>,
    reason: Option<&str>,
) -> Result<(), String> {
    let outcome = (|| {
        let mut conn = db()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        close_at(&tx, id, session, status, code, reason)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })();
    // 进程侧已经结束时必须放开存活锁，否则账本失败会把 Run 钉在「仍在运行」。
    leases()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id);
    crate::coding::clear_lane_current_run(id);
    freeze_task_run_evidence(id);
    if let Err(error) = &outcome {
        crate::logbuf::record(
            "error",
            "runs",
            &format!("Run {id} 已结束，但账本登记失败：{error}"),
        );
    }
    outcome
}
pub fn attach_session_impl(id: &str, session_id: &str) -> Result<(), String> {
    let conn = db()?;
    let existing: Option<Option<String>> = conn
        .query_row("SELECT session_id FROM runs WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(existing_session) = existing else {
        return Err("Run 不存在".into());
    };
    if let Some(existing_session) = existing_session {
        if existing_session != session_id {
            return Err("Run 已绑定另一会话，拒绝改写会话身份".into());
        }
        return Ok(());
    }
    if conn
        .execute(
            "UPDATE runs SET session_id=?2 WHERE id=?1 AND session_id IS NULL",
            params![id, session_id],
        )
        .map_err(|e| e.to_string())?
        > 0
    {
        record_event(&conn, id, "run.session_attached", None)?;
    }
    Ok(())
}
/// 预分配的会话 id 从没落盘（CLI 在第一条消息前就退出了）：恢复时换成新 id 开新会话。
/// Run 当前的会话是 `old`，或者同样从没落盘（上一次兜底换上的新 id 也没聊就退了，
/// 标签重启又拿最初那个 id 来恢复）才改——绑着一段真实对话的 Run 不碰
pub fn replace_unwritten_session(
    id: &str,
    old: &str,
    new: &str,
    is_unwritten: impl Fn(&str) -> bool,
) -> Result<(), String> {
    replace_unwritten_session_at(&db()?, id, old, new, is_unwritten)
}
fn replace_unwritten_session_at(
    conn: &Connection,
    id: &str,
    old: &str,
    new: &str,
    is_unwritten: impl Fn(&str) -> bool,
) -> Result<(), String> {
    let current: Option<Option<String>> = conn
        .query_row("SELECT session_id FROM runs WHERE id=?1", [id], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(Some(current)) = current else {
        return Ok(());
    };
    if current != old && !is_unwritten(&current) {
        return Ok(());
    }
    if conn
        .execute(
            "UPDATE runs SET session_id=?3 WHERE id=?1 AND session_id=?2",
            params![id, current, new],
        )
        .map_err(|e| e.to_string())?
        > 0
    {
        record_event(conn, id, "run.session_replaced", Some(&current))?;
    }
    Ok(())
}
const OUTPUT_EVENT_CAP: usize = 100;

fn output_tail(text: &str) -> String {
    // 末尾未完成 token 留到下一批；不把跨块密钥前半段当独立文本持久化。
    let end = text.rfind(char::is_whitespace).unwrap_or(0);
    let redacted = crate::sessions::redact_sensitive_text(&text[..end]);
    redacted
        .chars()
        .rev()
        .take(2000)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn persist_output(conn: &Connection, id: &str, text: &str) -> Result<(), String> {
    let tail = output_tail(text);
    if tail.is_empty() {
        return Ok(());
    }
    record_event(conn, id, "run.output", Some(&tail))?;
    conn.execute("DELETE FROM run_events WHERE event_type='run.output' AND run_id=?1 AND rowid NOT IN (SELECT rowid FROM run_events WHERE event_type='run.output' AND run_id=?1 ORDER BY rowid DESC LIMIT ?2)", params![id, OUTPUT_EVENT_CAP as i64]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM run_events WHERE event_type='run.output' AND rowid NOT IN (SELECT rowid FROM run_events WHERE event_type='run.output' ORDER BY rowid DESC LIMIT 10000)", []).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn record_output(id: &str, text: &str) -> Result<(), String> {
    use std::sync::{mpsc, OnceLock};
    static OUTPUT: OnceLock<mpsc::SyncSender<(String, String)>> = OnceLock::new();
    let send = OUTPUT.get_or_init(|| {
        let (send, receive) = mpsc::sync_channel::<(String, String)>(128);
        std::thread::spawn(move || {
            let mut conn = None;
            let mut pending: std::collections::HashMap<String, String> = Default::default();
            loop {
                let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
                while let Ok((id, text)) = receive
                    .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                {
                    if pending.len() >= 64 && !pending.contains_key(&id) {
                        continue;
                    }
                    let buffer = pending.entry(id).or_default();
                    buffer.push_str(&text);
                    if buffer.len() > 65536 {
                        let start = buffer.len() - 32768;
                        let start = buffer
                            .char_indices()
                            .find(|(i, c)| *i >= start && c.is_whitespace())
                            .map(|(i, c)| i + c.len_utf8())
                            .unwrap_or(buffer.len());
                        buffer.drain(..start);
                    }
                    if std::time::Instant::now() >= deadline {
                        break;
                    }
                }
                if pending.is_empty() {
                    continue;
                }
                if conn.is_none() {
                    conn = db().ok();
                }
                if let Some(db) = &conn {
                    let _ = db.busy_timeout(std::time::Duration::from_millis(250));
                    for (id, text) in &mut pending {
                        let _ = persist_output(db, id, text);
                        let end = text
                            .char_indices()
                            .rev()
                            .find(|(_, c)| c.is_whitespace())
                            .map(|(i, c)| i + c.len_utf8())
                            .unwrap_or(0);
                        text.drain(..end);
                    }
                    pending.retain(|_, text| !text.is_empty());
                } else {
                    pending.clear();
                }
            }
        });
        send
    });
    // 拥堵时只丢诊断副本，不阻塞/丢失实际终端输出。
    let _ = send.try_send((id.into(), text.into()));
    Ok(())
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventDto {
    id: String,
    run_id: String,
    event_type: String,
    payload: Option<String>,
    created_at: String,
}
fn map_run_event(r: &rusqlite::Row<'_>) -> rusqlite::Result<RunEventDto> {
    Ok(RunEventDto {
        id: r.get(0)?,
        run_id: r.get(1)?,
        event_type: r.get(2)?,
        payload: r.get(3)?,
        created_at: r.get(4)?,
    })
}

#[tauri::command]
pub async fn run_events(id: String) -> Result<Vec<RunEventDto>, String> {
    tauri::async_runtime::spawn_blocking(move || run_events_sync(id))
        .await
        .map_err(|e| e.to_string())?
}
fn run_events_sync(id: String) -> Result<Vec<RunEventDto>, String> {
    let conn = db()?;
    let mut stmt = conn.prepare("SELECT id,run_id,event_type,payload,created_at FROM run_events WHERE run_id=?1 ORDER BY rowid").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([id], map_run_event)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn task_goal_events(project_root: Option<String>) -> Result<Vec<RunEventDto>, String> {
    tauri::async_runtime::spawn_blocking(move || task_goal_events_sync(project_root))
        .await
        .map_err(|e| e.to_string())?
}
fn task_goal_events_sync(project_root: Option<String>) -> Result<Vec<RunEventDto>, String> {
    let conn = db()?;
    let sql_base = "SELECT e.id, e.run_id, e.event_type, e.payload, e.created_at
             FROM run_events e
             INNER JOIN runs r ON r.id = e.run_id
             WHERE e.event_type IN ('task.review_notes', 'task.outputs_adopted')";
    match project_root.as_deref() {
        None => {
            let mut stmt = conn
                .prepare(&format!("{sql_base} ORDER BY e.rowid"))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], map_run_event)
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
        }
        Some(root) => match project_id_for(&conn, Some(root))
            .or_else(|| crate::projects::project_id_at(Path::new(root)))
        {
            Some(id) => {
                let mut stmt = conn
                    .prepare(&format!(
                        "{sql_base} AND (r.project_id=?1 OR (r.project_id IS NULL AND r.project_root=?2)) ORDER BY e.rowid"
                    ))
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![id, root], map_run_event)
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
            }
            None => {
                let mut stmt = conn
                    .prepare(&format!(
                        "{sql_base} AND r.project_root=?1 ORDER BY e.rowid"
                    ))
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([root], map_run_event)
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
            }
        },
    }
}

/// 应用启动时收口上次崩溃留下的未闭合 Run；正常运行期间不调用，避免误伤活跃进程。
pub fn reconcile_stale_runs() -> Result<usize, String> {
    let mut conn = db()?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut stmt = tx
        .prepare("SELECT id FROM runs WHERE closed_at IS NULL AND status IN ('starting','running')")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    let closed = reconcile_ids(&tx, &lease_dir()?, &ids)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(closed)
}
fn reconcile_ids(conn: &Connection, dir: &Path, ids: &[String]) -> Result<usize, String> {
    let mut closed = 0;
    for id in ids {
        // 只有确实无人持有的 Run 才是陈旧运行；OS 锁随进程退出释放。
        let Some(_lease) = try_run_lease(dir, id)? else {
            continue;
        };
        close_at(
            conn,
            id,
            None,
            "failed",
            None,
            Some("应用上次异常退出，Run 未能正常收尾"),
        )?;
        closed += 1;
    }
    Ok(closed)
}

#[tauri::command]
pub async fn run_open(input: OpenRunInput) -> Result<RunDto, String> {
    tauri::async_runtime::spawn_blocking(move || run_open_sync(input))
        .await
        .map_err(|e| e.to_string())?
}
fn run_open_sync(input: OpenRunInput) -> Result<RunDto, String> {
    open_run_impl(input)
}
// 前端轮询 / 页面挂载时调：开库要等文件锁，放后台线程，不和终端输出抢主线程（Rust 内部调用走 *_sync）
#[tauri::command]
pub async fn run_get(id: String) -> Result<Option<RunDto>, String> {
    tauri::async_runtime::spawn_blocking(move || run_get_sync(id))
        .await
        .map_err(|e| e.to_string())?
}
pub fn run_get_sync(id: String) -> Result<Option<RunDto>, String> {
    get_run_at(&db()?, &id)
}

// ===== 定时历史删除（2026-10-13 用户拍板：历史运行记录支持删除）=====

/// 某条日程挂着的全部 watch Run id（含失败/取消的——历史行未必都记到）。
pub(crate) fn watch_run_ids_of_schedule(task_ref: &str) -> Vec<String> {
    let Ok(conn) = db() else {
        return Vec::new();
    };
    let Ok(mut stmt) =
        conn.prepare("SELECT id FROM runs WHERE task_kind='watch' AND task_ref=?1")
    else {
        return Vec::new();
    };
    stmt.query_map(params![task_ref], |r| r.get::<_, String>(0))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

/// 该日程还有没收尾的 Run 吗（删除日程前要先停掉，返回 run id）。
pub(crate) fn schedule_open_run(task_ref: &str) -> Option<String> {
    let conn = db().ok()?;
    conn.query_row(
        "SELECT id FROM runs WHERE task_kind='watch' AND task_ref=?1 AND closed_at IS NULL",
        params![task_ref],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

/// 人显式删除一条 Run：账行与事件一起删（与目标「删除即归档」口径不同，这里删就是删）。
pub(crate) fn delete_run_row(run_id: &str) -> Result<(), String> {
    let conn = db()?;
    conn.execute("DELETE FROM run_events WHERE run_id=?1", params![run_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM runs WHERE id=?1", params![run_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除日程对应的 watch 任务行（删日程时级联）。
pub(crate) fn delete_watch_task_row(task_ref: &str) -> Result<(), String> {
    let conn = db()?;
    conn.execute(
        "DELETE FROM tasks WHERE kind='watch' AND task_ref=?1",
        params![task_ref],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn run_list(project_root: Option<String>) -> Result<Vec<RunDto>, String> {
    tauri::async_runtime::spawn_blocking(move || run_list_sync(project_root))
        .await
        .map_err(|e| e.to_string())?
}
pub fn run_list_sync(project_root: Option<String>) -> Result<Vec<RunDto>, String> {
    let conn = db()?;
    match project_root.as_deref() {
        None => query_runs(&conn, "ORDER BY created_at DESC LIMIT 500", []),
        Some(root) => match project_id_for(&conn, Some(root))
            .or_else(|| crate::projects::project_id_at(Path::new(root)))
        {
            Some(id) => query_runs(
                &conn,
                "WHERE project_id=?1 OR (project_id IS NULL AND project_root=?2) ORDER BY created_at DESC LIMIT 500",
                params![id, root],
            ),
            None => query_runs(
                &conn,
                "WHERE project_root=?1 ORDER BY created_at DESC LIMIT 500",
                [root],
            ),
        },
    }
}
pub(crate) fn has_active_run_in(path: &str) -> Result<bool, String> {
    Ok(query_runs(
        &db()?,
        "WHERE closed_at IS NULL AND status IN ('starting','running')",
        [],
    )?
    .iter()
    .any(|r| crate::paths::path_within(&r.isolation_path, path)))
}
// 仅入口允许用旧键查身份，页面之间绝不传 tabId/reuseKey。
// 侧栏点开对话要先等它（quick-chat-launch.ts）：放后台线程，不和终端输出抢主线程
#[tauri::command]
pub async fn run_find(
    reuse_key: Option<String>,
    agent: Option<String>,
    session_id: Option<String>,
) -> Result<Option<RunDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(query_runs(&db()?,"WHERE (?1 IS NOT NULL AND reuse_key=?1 AND closed_at IS NULL) OR (?2 IS NOT NULL AND agent=?2 AND session_id=?3) ORDER BY created_at DESC LIMIT 1",
            params![reuse_key,agent,session_id])?.into_iter().next())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn active_background_runs() -> Result<Vec<RunDto>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let conn = db()?;
        let mut out = Vec::new();
        for id in crate::process::active_capture_ids() {
            if let Some(run) = get_run_at(&conn, &id)? {
                if run.runtime == "headless" {
                    out.push(run);
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn run_cancel(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_cancel_sync(id))
        .await
        .map_err(|e| e.to_string())?
}
fn run_cancel_sync(id: String) -> Result<(), String> {
    let run = run_get_sync(id.clone())?.ok_or("Run 不存在")?;
    if run.runtime != "headless" {
        return Err("交互终端请使用终端停止按钮".into());
    }
    crate::process::cancel_capture(&id)
}

/// 在后台线程收尾：要评审的目标会在这里冻结快照（逐个读产物文件），放主线程上终端会跟着停住
///（见 conventions/terminal.md「会等待的命令不占主线程」）
#[tauri::command]
pub async fn run_close(
    id: String,
    session_id: Option<String>,
    status: Option<String>,
    exit_code: Option<i32>,
    reason: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        close_run_with_result(
            &id,
            session_id.as_deref(),
            status.as_deref().unwrap_or("stopped"),
            exit_code,
            reason.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("结束运行失败: {e}"))?
}
#[tauri::command]
pub async fn run_attach_session(id: String, session_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_attach_session_sync(id, session_id))
        .await
        .map_err(|e| e.to_string())?
}
fn run_attach_session_sync(id: String, session_id: String) -> Result<(), String> {
    attach_session_impl(&id, &session_id)
}

pub fn open_for_interactive_spawn(
    agent: &str,
    profile: &str,
    cwd: &str,
    reuse: Option<&str>,
    session: Option<&str>,
    readonly: bool,
    existing_id: Option<&str>,
    task_id: Option<&str>,
) -> Result<Option<RunDto>, String> {
    if reuse.unwrap_or("").starts_with("login:") {
        return Ok(None);
    }
    let task_context = task_id.and_then(|id| db().ok().and_then(|conn| task_by_id(&conn, id).ok()));
    let dto = open_run_impl(OpenRunInput {
        id: existing_id.map(Into::into),
        task_id: task_id.map(Into::into),
        project_root: task_context
            .as_ref()
            .and_then(|task| task.project_root.clone()),
        task_kind: task_context.as_ref().map(|task| task.kind.clone()),
        task_ref: task_context.as_ref().map(|task| task.name.clone()),
        isolation_path: cwd.into(),
        runtime: Some("local_cli".into()),
        agent: agent.into(),
        profile_id: Some(profile.into()),
        permission: Some(if readonly { "discuss" } else { "write_tree" }.into()),
        reuse_key: reuse.map(Into::into),
        session_id: session.map(Into::into),
        custom_runtime_id: None,
        internal: Some(false),
        sentinel: Some(false),
    })?;
    if dto.task_kind == "coding_lane" {
        crate::coding::touch_lane_current_run(cwd, &dto.id);
    }
    Ok(Some(dto))
}
pub fn open_headless(
    agent: &str,
    profile: &str,
    cwd: &str,
    reuse: &str,
    sentinel: bool,
    permission: &str,
) -> Result<RunDto, String> {
    open_headless_with_root(None, agent, profile, cwd, reuse, sentinel, permission)
}
pub fn open_headless_with_root(
    project_root: Option<&str>,
    agent: &str,
    profile: &str,
    cwd: &str,
    reuse: &str,
    sentinel: bool,
    permission: &str,
) -> Result<RunDto, String> {
    open_run_impl(OpenRunInput {
        id: None,
        task_id: None,
        project_root: project_root.map(str::to_owned),
        task_kind: None,
        task_ref: None,
        isolation_path: cwd.into(),
        runtime: Some("headless".into()),
        agent: agent.into(),
        profile_id: Some(profile.into()),
        permission: Some(permission.into()),
        reuse_key: Some(reuse.into()),
        session_id: None,
        custom_runtime_id: None,
        internal: Some(true),
        sentinel: Some(sentinel),
    })
}
#[tauri::command]
pub async fn run_open_custom(
    cwd: String,
    reuse_key: String,
    run_id: Option<String>,
    custom_runtime_id: Option<String>,
) -> Result<RunDto, String> {
    tauri::async_runtime::spawn_blocking(move || run_open_custom_sync(cwd, reuse_key, run_id, custom_runtime_id))
        .await
        .map_err(|e| e.to_string())?
}
fn run_open_custom_sync(
    cwd: String,
    reuse_key: String,
    run_id: Option<String>,
    custom_runtime_id: Option<String>,
) -> Result<RunDto, String> {
    let runtime_id = custom_runtime_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .ok_or("Custom Runtime 必须绑定已保存的运行时配置")?;
    let runtime = crate::custom_runtime::get_custom_runtime(runtime_id)?;
    let cwd = crate::custom_runtime::resolve_custom_cwd(&cwd, runtime.cwd.as_deref())?;
    let dto = open_run_impl(OpenRunInput {
        id: run_id,
        task_id: None,
        project_root: None,
        task_kind: None,
        task_ref: Some(cwd.clone()),
        isolation_path: cwd.clone(),
        runtime: Some("custom".into()),
        agent: "custom".into(),
        profile_id: None,
        permission: Some("write_tree".into()),
        reuse_key: Some(reuse_key),
        session_id: None,
        custom_runtime_id,
        internal: Some(false),
        sentinel: Some(false),
    })?;
    if dto.task_kind == "coding_lane" {
        crate::coding::touch_lane_current_run(&cwd, &dto.id);
    }
    Ok(dto)
}
#[cfg(test)]
mod tests {
    use super::*;

    // ===== B2 目标级模型 =====

    /// map_task 按位置索引读列（TASK_COLS 的第 20 列）——model 追加队尾后，
    /// agent/profile_id/model 三列必须互不串位。内存库跑真实 SELECT {TASK_COLS}
    /// + map_task，列序错位会直接在这里炸（拿不到值或张冠李戴）
    #[test]
    fn task_model_round_trips_without_column_shift() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO tasks(id,identity_key,project_root,kind,task_ref,name,status,created_at,updated_at,agent,profile_id,model)
             VALUES('t1','user:t1','/p/proj','free_research','t1','试目标','pending','now','now','claude-code','pf-1','glm-4.7')",
            [],
        )
        .unwrap();
        // 旧行无 model（ALTER 前的存量）：NULL 回落不报错
        conn.execute(
            "INSERT INTO tasks(id,identity_key,project_root,kind,task_ref,name,status,created_at,updated_at,agent)
             VALUES('t2','user:t2','/p/proj','free_research','t2','旧目标','pending','now','now','codex')",
            [],
        )
        .unwrap();
        let t1: TaskDto = conn
            .query_row(
                &format!("SELECT {TASK_COLS} FROM tasks WHERE id='t1'"),
                [],
                map_task,
            )
            .unwrap();
        assert_eq!(t1.agent.as_deref(), Some("claude-code"));
        assert_eq!(t1.profile_id.as_deref(), Some("pf-1"));
        assert_eq!(t1.model.as_deref(), Some("glm-4.7"));
        let t2: TaskDto = conn
            .query_row(
                &format!("SELECT {TASK_COLS} FROM tasks WHERE id='t2'"),
                [],
                map_task,
            )
            .unwrap();
        assert_eq!(t2.agent.as_deref(), Some("codex"));
        assert_eq!(t2.profile_id, None);
        assert_eq!(t2.model, None);
    }

    fn goal_edit(name: &str) -> GoalEdit {
        GoalEdit {
            name: name.into(),
            description: format!("{name}，详细要求"),
            inputs: vec!["data".into()],
            outputs: vec![".".into()],
            review_required: true,
            agent: None,
            profile_id: None,
            model: None,
            skills: vec!["data-clean".into()],
        }
    }

    /// 记下未开始的目标可改要求、资料、技能与绑定；跑过 / 归档 / 非人声明的一律拒改
    #[test]
    fn goal_edit_only_before_first_run() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        for (id, identity, status, archived) in [
            ("fresh", "user:fresh", "pending", None),
            ("ran", "user:ran", "pending", None),
            ("stopped", "user:stopped", "stopped", None),
            ("archived", "user:archived", "pending", Some("now")),
            ("auto", "/p/proj", "pending", None),
        ] {
            conn.execute(
                "INSERT INTO tasks(id,identity_key,project_root,kind,task_ref,name,status,created_at,updated_at,agent,profile_id,archived_at)
                 VALUES(?1,?2,'/p/proj','office_doc',?1,'旧目标',?3,'now','now','codex','pf-1',?4)",
                params![id, identity, status, archived],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO runs(id,task_id,task_kind,project_root,isolation_path,runtime,agent,permission,status,created_at)
             VALUES('r1','ran','office_doc','/p/proj','/iso','local_cli','codex','write_tree','failed','now')",
            [],
        )
        .unwrap();

        apply_task_update(&conn, "fresh", goal_edit("整理周报")).unwrap();
        let (name, desc, inputs, skills, profile): (String, String, String, String, Option<String>) = conn
            .query_row(
                "SELECT name,description,input_paths,skills,profile_id FROM tasks WHERE id='fresh'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(name, "整理周报");
        assert_eq!(desc, "整理周报，详细要求");
        assert_eq!(inputs, r#"["data"]"#);
        assert_eq!(skills, r#"["data-clean"]"#);
        assert_eq!(profile, None, "清掉绑定 = 跟随项目默认");

        for id in ["ran", "stopped", "archived", "auto"] {
            assert!(apply_task_update(&conn, id, goal_edit("改")).is_err(), "{id} 不应可改");
        }
        assert!(apply_task_update(&conn, "fresh", goal_edit("  ")).is_err());
        assert!(apply_task_update(&conn, "missing", goal_edit("改")).is_err());
    }

    #[test]
    fn goal_scope_rejects_mixed_and_mismatched_permission() {
        let root = std::env::temp_dir().join(format!("mesa-goal-scope-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("data/raw")).unwrap();
        // 生产侧的根来自 validate_existing_dir（已规范化）；macOS 临时目录 /var → /private/var
        let root_s = validate_existing_dir(&root.to_string_lossy(), "项目根目录").unwrap();
        let (inputs, outputs, review) = normalize_goal_scope(
            &root_s,
            &["data".into(), "data/raw".into()],
            &[".".into()],
            None,
        )
        .unwrap();
        assert_eq!(inputs, vec!["data".to_string()]);
        assert_eq!(outputs, vec![".".to_string()]);
        assert!(review);
        assert!(normalize_goal_scope(&root_s, &[".".into(), "data".into()], &[".".into()], None).is_err());
        assert!(normalize_goal_scope(&root_s, &[], &[".".into()], Some("discuss")).is_err());
        assert!(normalize_goal_scope(&root_s, &[], &[], Some("write_tree")).is_err());
        assert!(normalize_goal_scope(&root_s, &["../x".into()], &[], Some("discuss")).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    fn journal_fixture() -> (PathBuf, PathBuf, PathBuf, Connection, GoalApplyJournal) {
        let base =
            std::env::temp_dir().join(format!("mesa-accept-recovery-{}", uuid::Uuid::new_v4()));
        let project = base.join("project");
        let review = base.join("review");
        let payload = review.join("payload");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&payload).unwrap();
        fs::write(project.join("a.md"), "old report").unwrap();
        fs::write(project.join("paper.md"), "protected paper").unwrap();
        fs::write(payload.join("a.md"), "reviewed report").unwrap();
        fs::write(payload.join("b.csv"), "reviewed data").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute("INSERT INTO tasks(id,identity_key,kind,name,review_required,status,created_at,updated_at) VALUES('goal','user:recovery','free_research','整理实验记录',1,'pending_review','now','now')", []).unwrap();
        let mut fact = crate::review_contract::fact_from_goal_adopt(
            &project,
            "goal",
            "整理实验记录",
            "run",
            Some(1),
            vec!["a.md".into(), "b.csv".into()],
            "仅接受已审版本".into(),
            true,
            "original-time".into(),
        );
        fact.content_fingerprints = fact
            .paths
            .iter()
            .map(|path| crate::projects::ContentFingerprint {
                path: path.clone(),
                size: fs::metadata(payload.join(path)).unwrap().len(),
                sha256: read_regular_optional(&payload.join(path), "test").unwrap(),
            })
            .collect();
        let journal = prepare_goal_journal(&review, &payload, &project, fact, false).unwrap();
        (base, project, review, conn, journal)
    }

    #[test]
    fn interrupted_acceptance_resumes_exact_original_version_after_reload() {
        let (base, project, review, conn, mut journal) = journal_fixture();
        let mut writes = 0;
        let result = apply_goal_journal_with_writer(&review, &project, &mut journal, |src, dst| {
            writes += 1;
            if writes == 2 {
                return Err("simulated crash".into());
            }
            copy_adopt_file(src, dst)
        });
        assert!(result.is_err());
        assert_eq!(fs::read(project.join("a.md")).unwrap(), b"reviewed report");
        assert!(!project.join("b.csv").exists());
        fs::write(review.join("snapshot.json"), r#"{"seq":99}"#).unwrap();
        let mut recovered = read_goal_journal(&review).unwrap().unwrap();
        finish_goal_journal(&conn, &review, &project, &mut recovered).unwrap();
        assert_eq!(fs::read(project.join("b.csv")).unwrap(), b"reviewed data");
        assert_eq!(
            fs::read(project.join("paper.md")).unwrap(),
            b"protected paper"
        );
        assert_eq!(task_by_id(&conn, "goal").unwrap().status, "completed");
        assert!(read_goal_journal(&review).unwrap().is_none());
        let facts = crate::projects::read_acceptance_log_at(&project);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].version_id, "run:1");
        assert_eq!(facts[0].decided_at, "original-time");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn journal_retries_ledger_and_state_without_overwriting_later_edits() {
        let (base, project, review, conn, mut journal) = journal_fixture();
        let blocked = project.join(".ccode/acceptance-log.jsonl");
        fs::create_dir_all(&blocked).unwrap();
        assert!(finish_goal_journal(&conn, &review, &project, &mut journal).is_err());
        let mut recovered = read_goal_journal(&review).unwrap().unwrap();
        assert_eq!(recovered.phase, "files_applied");
        fs::write(project.join("a.md"), "user edit after application").unwrap();
        fs::remove_dir(&blocked).unwrap();
        // 在账本之后模拟数据库失败；文件阶段不得重跑，目标更新与事件同事务。
        conn.execute("DROP TABLE run_events", []).unwrap();
        assert!(finish_goal_journal(&conn, &review, &project, &mut recovered).is_err());
        assert_eq!(task_by_id(&conn, "goal").unwrap().status, "pending_review");
        assert_eq!(crate::projects::read_acceptance_log_at(&project).len(), 1);
        ensure_schema(&conn).unwrap();
        let mut recovered = read_goal_journal(&review).unwrap().unwrap();
        assert_eq!(recovered.phase, "recorded");
        assert!(rollback_goal_journal(&review, &project, &recovered).is_err());
        finish_goal_journal(&conn, &review, &project, &mut recovered).unwrap();
        assert_eq!(
            fs::read(project.join("a.md")).unwrap(),
            b"user edit after application"
        );
        assert_eq!(crate::projects::read_acceptance_log_at(&project).len(), 1);
        assert!(read_goal_journal(&review).unwrap().is_none());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn journal_rollback_keeps_external_edits_and_can_restore_partial_apply() {
        let (base, project, review, _conn, mut journal) = journal_fixture();
        let mut count = 0;
        assert!(
            apply_goal_journal_with_writer(&review, &project, &mut journal, |src, dst| {
                count += 1;
                if count > 1 {
                    return Err("stop".into());
                }
                copy_adopt_file(src, dst)
            })
            .is_err()
        );
        fs::write(project.join("b.csv"), "other user's data").unwrap();
        let journal = read_goal_journal(&review).unwrap().unwrap();
        assert!(rollback_goal_journal(&review, &project, &journal)
            .unwrap_err()
            .contains("外部修改"));
        assert_eq!(fs::read(project.join("a.md")).unwrap(), b"reviewed report");
        fs::remove_file(project.join("b.csv")).unwrap();
        rollback_goal_journal(&review, &project, &journal).unwrap();
        assert_eq!(fs::read(project.join("a.md")).unwrap(), b"old report");
        assert!(!project.join("b.csv").exists());
        assert!(read_goal_journal(&review).unwrap().is_none());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn interrupted_rollback_cannot_be_mistaken_for_acceptance() {
        let (base, project, review, conn, mut journal) = journal_fixture();
        apply_goal_journal_with_writer(&review, &project, &mut journal, copy_adopt_file).unwrap();
        journal.phase = "rolling_back".into();
        write_goal_journal(&review, &journal).unwrap();
        copy_adopt_file(
            &Path::new(&journal.backup_dir).join("files/a.md"),
            &project.join("a.md"),
        )
        .unwrap();
        let mut recovered = read_goal_journal(&review).unwrap().unwrap();
        assert!(
            finish_goal_journal(&conn, &review, &project, &mut recovered)
                .unwrap_err()
                .contains("继续恢复")
        );
        rollback_goal_journal(&review, &project, &recovered).unwrap();
        assert_eq!(fs::read(project.join("a.md")).unwrap(), b"old report");
        assert!(!project.join("b.csv").exists());
        assert!(crate::projects::read_acceptance_log_at(&project).is_empty());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn input_preflight_rejects_over_budget_before_any_copy() {
        let root = std::env::temp_dir().join(format!("mesa-preflight-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::File::create(root.join(".git/noise"))
            .unwrap()
            .set_len(MAX_TASK_INPUT_BYTES * 2)
            .unwrap();
        fs::write(root.join("small.md"), "ok").unwrap();
        assert!(estimate_task_inputs(&root, &[".".into()]).unwrap().allowed);
        fs::File::create(root.join("large.dat"))
            .unwrap()
            .set_len(MAX_TASK_INPUT_BYTES + 1)
            .unwrap();
        let estimate = estimate_task_inputs(&root, &[".".into()]).unwrap();
        assert_eq!(estimate.files, 2);
        assert!(!estimate.allowed);
        assert!(
            estimate_task_inputs(&root, &["small.md".into()])
                .unwrap()
                .allowed
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn closing_a_run_never_reopens_an_accepted_goal() {
        for status in ["completed", "failed", "stopped"] {
            let conn = Connection::open_in_memory().unwrap();
            ensure_schema(&conn).unwrap();
            conn.execute("INSERT INTO tasks(id,identity_key,kind,name,review_required,status,created_at,updated_at) VALUES('task','user:accepted','free_research','已接受目标',1,'completed','now','now')", []).unwrap();
            conn.execute("INSERT INTO runs(id,task_id,task_kind,isolation_path,runtime,agent,permission,created_at,status) VALUES('run','task','free_research','/tmp','local_cli','test','write_tree','now','running')", []).unwrap();
            close_at(&conn, "run", None, status, None, None).unwrap();
            assert_eq!(
                task_by_id(&conn, "task").unwrap().status,
                "completed",
                "Run {status} 不得覆盖人的接受决定"
            );
            continue_active_goal(&conn, "task", "run", Some("请修改措辞")).unwrap();
            assert_eq!(
                task_by_id(&conn, "task").unwrap().status,
                "running",
                "用户显式返修应重开目标"
            );
        }
    }

    #[test]
    fn moved_project_resolves_goal_and_run_without_rewriting_history() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute_batch("CREATE TABLE projects(path TEXT PRIMARY KEY,id TEXT);
            INSERT INTO projects VALUES('/new-project','project-id');
            INSERT INTO tasks(id,identity_key,kind,name,project_id,project_root,created_at,updated_at)
            VALUES('task','user:moved','free_research','目标','project-id','/old-project','now','now');
            INSERT INTO runs(id,task_id,task_kind,project_id,project_root,isolation_path,runtime,agent,permission,created_at,status)
            VALUES('run','task','free_research','project-id','/old-project','/isolated-run','local_cli','test','write_tree','now','running');").unwrap();
        assert_eq!(
            task_by_id(&conn, "task").unwrap().project_root.as_deref(),
            Some("/new-project")
        );
        let run = get_run_at(&conn, "run").unwrap().unwrap();
        assert_eq!(run.project_root.as_deref(), Some("/new-project"));
        assert_eq!(run.isolation_path, "/isolated-run");
        conn.execute(
            "UPDATE runs SET isolation_path='/old-project' WHERE id='run'",
            [],
        )
        .unwrap();
        assert_eq!(
            query_runs(&conn, "WHERE id='run'", []).unwrap()[0].isolation_path,
            "/new-project"
        );
        let historical: String = conn
            .query_row("SELECT project_root FROM runs WHERE id='run'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(historical, "/old-project");
        conn.execute(
            "INSERT INTO projects VALUES('/another-copy','project-id')",
            [],
        )
        .unwrap();
        assert!(task_by_id(&conn, "task").unwrap_err().contains("多个位置"));
    }

    #[test]
    fn output_events_are_bounded_without_deleting_lifecycle_events() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        record_event(&conn, "r", "run.started", None).unwrap();
        for i in 0..OUTPUT_EVENT_CAP + 5 {
            persist_output(&conn, "r", &format!("line {i}\n")).unwrap();
        }
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM run_events WHERE run_id='r' AND event_type='run.output'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, OUTPUT_EVENT_CAP as i64);
        let lifecycle: i64 = conn
            .query_row(
                "SELECT count(*) FROM run_events WHERE event_type='run.started'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(lifecycle, 1);
        assert!(output_tail("sk-partial").is_empty());
        assert!(!output_tail("sk-supersecrettoken123456\n").contains("sk-supersecrettoken"));
    }

    #[test]
    fn interactive_start_reclaims_zombie_starting_or_running() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO tasks(id,identity_key,kind,name,created_at,updated_at) VALUES('task','task','scratch','task','now','now')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO runs(id,task_id,task_kind,isolation_path,runtime,agent,permission,created_at,status) VALUES('run','task','scratch','/tmp','local_cli','test','discuss','now','running')",
            [],
        )
        .unwrap();
        mark_starting_for_interactive(&conn, "run").unwrap();
        let status: String = conn
            .query_row("SELECT status FROM runs WHERE id='run'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "starting");
        conn.execute(
            "UPDATE runs SET status='completed', closed_at='now' WHERE id='run'",
            [],
        )
        .unwrap();
        let err = mark_starting_for_interactive(&conn, "run").unwrap_err();
        assert!(err.contains("已结束"), "{err}");
    }

    #[test]
    fn run_lease_distinguishes_live_from_stale_and_releases_on_drop() {
        let dir = std::env::temp_dir().join(format!("ccode-run-lease-{}", uuid::Uuid::new_v4()));
        let live = try_run_lease(&dir, "run1").unwrap().unwrap();
        assert!(try_run_lease(&dir, "run1").unwrap().is_none());
        assert!(try_run_lease(&dir, "run2").unwrap().is_some());
        drop(live);
        assert!(try_run_lease(&dir, "run1").unwrap().is_some());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn review_status_promotes_failed_run_only_with_adoptable_changes() {
        // 失败/停止 + 有可审成果 → 待验收；没有成果保持原状；completed 不走这条提升
        assert_eq!(review_status_for("failed", true), Some("pending_review"));
        assert_eq!(review_status_for("stopped", true), Some("pending_review"));
        assert_eq!(review_status_for("failed", false), None);
        assert_eq!(review_status_for("stopped", false), None);
        assert_eq!(review_status_for("completed", true), None);
        assert_eq!(review_status_for("running", true), None);
    }

    #[test]
    fn failed_prepare_cleanup_never_deletes_reused_isolation_dir() {
        let base =
            std::env::temp_dir().join(format!("ccode-prepare-cleanup-{}", uuid::Uuid::new_v4()));
        let reused = base.join("reused");
        let staging = base.join("staging");
        fs::create_dir_all(&reused).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(reused.join("draft.md"), "旧成果").unwrap();
        // 复用上一版目录（reuse_isolation=true）：启动失败不得删旧成果
        cleanup_failed_prepare(false, &reused);
        assert!(reused.join("draft.md").is_file());
        // 本次新建的 staging：失败时照常清理
        cleanup_failed_prepare(true, &staging);
        assert!(!staging.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn startup_reconciliation_skips_live_run_and_closes_stale_run() {
        let dir =
            std::env::temp_dir().join(format!("ccode-run-reconcile-{}", uuid::Uuid::new_v4()));
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute("INSERT INTO tasks(id,identity_key,kind,name,created_at,updated_at) VALUES('task','task','scratch','task','now','now')", []).unwrap();
        for id in ["live", "stale"] {
            conn.execute("INSERT INTO runs(id,task_id,task_kind,isolation_path,runtime,agent,permission,created_at,status) VALUES(?1,'task','scratch','/tmp','local_cli','test','discuss','now','running')", [id]).unwrap();
        }
        let live = try_run_lease(&dir, "live").unwrap().unwrap();
        assert_eq!(
            reconcile_ids(&conn, &dir, &["live".into(), "stale".into()]).unwrap(),
            1
        );
        let status = |id| {
            conn.query_row("SELECT status FROM runs WHERE id=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .unwrap()
        };
        assert_eq!(status("live"), "running");
        assert_eq!(status("stale"), "failed");
        drop(live);
        assert_eq!(reconcile_ids(&conn, &dir, &["live".into()]).unwrap(), 1);
        assert_eq!(status("live"), "failed");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn resume_by_id_tolerates_unspecified_identity_fields() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute("INSERT INTO tasks(id,identity_key,kind,name,created_at,updated_at) VALUES('task','user:目标','free_research','目标X','now','now')", []).unwrap();
        conn.execute("INSERT INTO runs(id,task_id,task_kind,task_ref,isolation_path,runtime,agent,permission,created_at,status,reuse_key) VALUES('run','task','free_research','目标X','/tmp/ccode-task-runs/task/x','local_cli','claude-code','write_tree','now','running','task:task')", []).unwrap();
        let input = |kind: Option<&str>, task_ref: Option<&str>| OpenRunInput {
            id: Some("run".into()),
            task_id: None,
            project_root: None,
            task_kind: kind.map(Into::into),
            task_ref: task_ref.map(Into::into),
            isolation_path: "/tmp/ccode-task-runs/task/x".into(),
            runtime: Some("local_cli".into()),
            agent: "claude-code".into(),
            profile_id: None,
            permission: Some("write_tree".into()),
            reuse_key: Some("task:task".into()),
            session_id: None,
            custom_runtime_id: None,
            internal: Some(false),
            sentinel: Some(false),
        };
        // 恢复带 id 且未显式给 kind/ref（open_run_impl 对 id 命中不再推断）：
        // 不与已登记值比较，直接复用同一 Run
        let resumed = open_at(&conn, input(None, None)).unwrap();
        assert_eq!(resumed.id, "run");
        assert_eq!(resumed.task_kind, "free_research");
        // 显式给了不一致身份（修复前推断结果就是 scratch/目录名）仍拒绝
        let err = open_at(&conn, input(Some("scratch"), Some("x"))).unwrap_err();
        assert!(err.contains("不一致"), "{err}");
    }

    #[test]
    fn custom_runtime_on_scratch_is_not_isolated_write() {
        assert!(!requires_isolated_write_tree("scratch", false));
        assert!(!requires_isolated_write_tree("office_doc", false));
        assert!(!requires_isolated_write_tree("free_research", false));
        assert!(requires_isolated_write_tree("coding_lane", false));
        assert!(requires_isolated_write_tree("pipeline_step", false));
        assert!(requires_isolated_write_tree("watch", false));
        assert!(!requires_isolated_write_tree("watch", true));
    }

    #[test]
    fn unwritten_session_is_replaced_so_the_run_reopens_fresh() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute("INSERT INTO runs(id,task_kind,isolation_path,runtime,agent,permission,created_at,status,closed_at,session_id) VALUES('run','chat','/tmp/ccode-x','local_cli','claude-code','write_tree','now','failed','later','s1')", []).unwrap();
        // 旧 id 对不上、Run 上的会话又是真实对话：不动
        replace_unwritten_session_at(&conn, "run", "other", "s2", |_| false).unwrap();
        let sid: String = conn.query_row("SELECT session_id FROM runs WHERE id='run'", [], |r| r.get(0)).unwrap();
        assert_eq!(sid, "s1");
        replace_unwritten_session_at(&conn, "run", "s1", "s2", |_| false).unwrap();
        // 标签重启又拿最初的 s1 来恢复，而 Run 上的 s2 同样没落盘：照样换掉
        replace_unwritten_session_at(&conn, "run", "s1", "s3", |sid| sid == "s2").unwrap();
        let sid: String = conn.query_row("SELECT session_id FROM runs WHERE id='run'", [], |r| r.get(0)).unwrap();
        assert_eq!(sid, "s3");
        let input = OpenRunInput {
            id: Some("run".into()),
            task_id: None,
            project_root: None,
            task_kind: None,
            task_ref: None,
            isolation_path: "/tmp/ccode-x".into(),
            runtime: Some("local_cli".into()),
            agent: "claude-code".into(),
            profile_id: None,
            permission: Some("write_tree".into()),
            reuse_key: None,
            session_id: Some("s3".into()),
            custom_runtime_id: None,
            internal: Some(false),
            sentinel: Some(false),
        };
        // 换过会话后同一条 Run 能以新会话重新打开，不再报「恢复会话与原 Run 不一致」
        let reopened = open_at(&conn, input).unwrap();
        assert_eq!(reopened.id, "run");
        assert_eq!(reopened.session_id.as_deref(), Some("s3"));
    }

    #[test]
    fn resume_adopts_session_when_run_never_attached() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        // 交互 Run 停下时还没登记会话（2026-10-21 Gemini 存量）
        conn.execute("INSERT INTO runs(id,task_kind,isolation_path,runtime,agent,permission,created_at,status,closed_at) VALUES('run','scratch','/tmp/ccode-x','local_cli','gemini','write_tree','now','stopped','later')", []).unwrap();
        let input = |sid: &str| OpenRunInput {
            id: Some("run".into()),
            task_id: None,
            project_root: None,
            task_kind: None,
            task_ref: None,
            isolation_path: "/tmp/ccode-x".into(),
            runtime: Some("local_cli".into()),
            agent: "gemini".into(),
            profile_id: None,
            permission: Some("write_tree".into()),
            reuse_key: None,
            session_id: Some(sid.into()),
            custom_runtime_id: None,
            internal: Some(false),
            sentinel: Some(false),
        };
        let reopened = open_at(&conn, input("g1")).unwrap();
        assert_eq!(reopened.session_id.as_deref(), Some("g1"));
        assert!(reopened.closed_at.is_none());
        // 认下之后照旧：别的会话来恢复仍拒绝
        conn.execute("UPDATE runs SET closed_at='later2',status='stopped' WHERE id='run'", []).unwrap();
        let err = open_at(&conn, input("g2")).unwrap_err();
        assert!(err.contains("不一致"), "{err}");
    }

    #[test]
    fn resume_returns_goal_task_to_running() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute("INSERT INTO tasks(id,identity_key,kind,name,status,created_at,updated_at) VALUES('task','user:目标','free_research','目标X','failed','now','now')", []).unwrap();
        conn.execute("INSERT INTO runs(id,task_id,task_kind,task_ref,isolation_path,runtime,agent,permission,created_at,status,closed_at,session_id,reuse_key) VALUES('run','task','free_research','目标X','/tmp/ccode-task-runs/task/x','local_cli','claude-code','write_tree','now','failed','later','s1','task:task')", []).unwrap();
        let input = OpenRunInput {
            id: Some("run".into()),
            task_id: None,
            project_root: None,
            task_kind: None,
            task_ref: None,
            isolation_path: "/tmp/ccode-task-runs/task/x".into(),
            runtime: Some("local_cli".into()),
            agent: "claude-code".into(),
            profile_id: None,
            permission: Some("write_tree".into()),
            reuse_key: Some("task:task".into()),
            session_id: Some("s1".into()),
            custom_runtime_id: None,
            internal: Some(false),
            sentinel: Some(false),
        };
        let resumed = open_at(&conn, input).unwrap();
        assert_eq!(resumed.id, "run");
        let status: String = conn
            .query_row("SELECT status FROM tasks WHERE id='task'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "running", "恢复 Run 后目标不能停在 failed/重试");
    }

    #[test]
    fn project_id_backfills_from_projects_by_path() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS projects(path TEXT PRIMARY KEY, name TEXT NOT NULL, id TEXT);").unwrap();
        conn.execute(
            "INSERT INTO projects(path,name,id) VALUES('/p','课题','pid-1')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO tasks(id,identity_key,kind,name,project_root,created_at,updated_at) VALUES('t','user:x','free_research','x','/p','n','n')", []).unwrap();
        conn.execute("INSERT INTO runs(id,task_id,task_kind,isolation_path,runtime,agent,permission,created_at,status,project_root) VALUES('r','t','free_research','/tmp/x','local_cli','a','write_tree','n','completed','/p')", []).unwrap();
        backfill_project_ids(&conn).unwrap();
        let tid: Option<String> = conn
            .query_row("SELECT project_id FROM tasks WHERE id='t'", [], |r| {
                r.get(0)
            })
            .unwrap();
        let rid: Option<String> = conn
            .query_row("SELECT project_id FROM runs WHERE id='r'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tid.as_deref(), Some("pid-1"));
        assert_eq!(rid.as_deref(), Some("pid-1"));
        // 无 projects 表的纯净库跳过不报错
        let bare = Connection::open_in_memory().unwrap();
        ensure_schema(&bare).unwrap();
    }

    /// db() 每次调用都过 ensure_schema；别的连接正持有写锁（后台落库）时，它不能再去申请写锁，
    /// 否则主线程上的轮询命令会等满 busy_timeout。回填 UPDATE 命中 0 行也要写锁，这里钉住「无事可做就不写」
    #[test]
    fn ensure_schema_needs_no_write_lock_when_nothing_to_backfill() {
        let path = std::env::temp_dir().join(format!("ccode-schema-lock-{}.db", uuid::Uuid::new_v4()));
        let writer = Connection::open(&path).unwrap();
        ensure_schema(&writer).unwrap();
        writer
            .execute_batch("CREATE TABLE projects(path TEXT PRIMARY KEY, name TEXT NOT NULL, id TEXT);")
            .unwrap();
        // 有项目表、有行但都已有归属 / 都没有匹配项目：都不该触发写
        writer.execute("INSERT INTO projects(path,name,id) VALUES('/p','课题','pid-1')", []).unwrap();
        writer.execute("INSERT INTO tasks(id,identity_key,kind,name,project_root,project_id,created_at,updated_at) VALUES('t1','user:a','free_research','a','/p','pid-1','n','n')", []).unwrap();
        writer.execute("INSERT INTO tasks(id,identity_key,kind,name,project_root,created_at,updated_at) VALUES('t2','user:b','free_research','b','/unregistered','n','n')", []).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let reader = Connection::open(&path).unwrap();
        reader.busy_timeout(std::time::Duration::from_millis(0)).unwrap();
        let result = ensure_schema(&reader);
        writer.execute_batch("ROLLBACK").unwrap();
        drop((writer, reader));
        let _ = std::fs::remove_file(&path);
        assert!(result.is_ok(), "写锁被占时 ensure_schema 不该失败：{result:?}");
    }

    /// 回填判断不能把真正需要回填的行漏掉
    #[test]
    fn backfill_still_runs_when_a_registered_project_matches() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute_batch("CREATE TABLE projects(path TEXT PRIMARY KEY, name TEXT NOT NULL, id TEXT);").unwrap();
        conn.execute("INSERT INTO tasks(id,identity_key,kind,name,project_root,created_at,updated_at) VALUES('t','user:x','free_research','x','/late','n','n')", []).unwrap();
        backfill_project_ids(&conn).unwrap();
        let none: Option<String> = conn.query_row("SELECT project_id FROM tasks WHERE id='t'", [], |r| r.get(0)).unwrap();
        assert_eq!(none, None, "项目还没登记，不该凭空分配");
        conn.execute("INSERT INTO projects(path,name,id) VALUES('/late','迟到','pid-late')", []).unwrap();
        backfill_project_ids(&conn).unwrap();
        let got: Option<String> = conn.query_row("SELECT project_id FROM tasks WHERE id='t'", [], |r| r.get(0)).unwrap();
        assert_eq!(got.as_deref(), Some("pid-late"));
    }

    #[test]
    fn task_list_hides_archived_unless_asked() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO tasks(id,identity_key,kind,name,project_root,created_at,updated_at) VALUES('live','user:活','free_research','活目标','/p','n','n')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks(id,identity_key,kind,name,project_root,archived_at,created_at,updated_at) VALUES('old','user:旧','free_research','旧目标','/p','2026-09-09T00:00:00Z','n','n')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks(id,identity_key,kind,name,project_root,created_at,updated_at) VALUES('other','user:旁','office_doc','旁项目','/q','n','n')",
            [],
        )
        .unwrap();
        let active = list_tasks_at(&conn, Some("/p"), false).unwrap();
        assert_eq!(
            active.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["live"]
        );
        let all = list_tasks_at(&conn, Some("/p"), true).unwrap();
        assert_eq!(all.len(), 2);
        archive_goal_at(&conn, "live").unwrap();
        assert_eq!(list_tasks_at(&conn, Some("/p"), false).unwrap().len(), 0);
        let restored = unarchive_goal_at(&conn, "old").unwrap();
        assert!(restored.archived_at.is_none());
        assert_eq!(list_tasks_at(&conn, Some("/p"), false).unwrap().len(), 1);
        unarchive_goal_at(&conn, "old").unwrap(); // 幂等
        purge_archived_goal_at(&conn, "other").unwrap_err();
        purge_archived_goal_at(&conn, "live").unwrap();
        assert!(list_tasks_at(&conn, Some("/p"), true)
            .unwrap()
            .iter()
            .all(|task| task.id != "live"));
    }

    #[test]
    fn archive_and_restore_wait_for_cleanup_pending_review_still_allowed() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO tasks(id,identity_key,kind,name,status,project_root,review_required,created_at,updated_at) VALUES('t','user:归档','free_research','归档目标','pending_review','/p',1,'n','n')",
            [],
        )
        .unwrap();
        archive_goal_at(&conn, "t").unwrap();
        let archived: Option<String> = conn
            .query_row("SELECT archived_at FROM tasks WHERE id='t'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(archived.is_some());
        conn.execute("UPDATE tasks SET archived_at=NULL, status='completed'", [])
            .unwrap();
        conn.execute(
            "INSERT INTO goal_storage_pending(task_id,payload) VALUES('t','{}')",
            [],
        )
        .unwrap();
        assert!(archive_goal_at(&conn, "t")
            .unwrap_err()
            .contains("副本清理"));
        conn.execute("UPDATE tasks SET archived_at='now'", [])
            .unwrap();
        assert!(unarchive_goal_at(&conn, "t")
            .unwrap_err()
            .contains("副本清理"));
        conn.execute("DELETE FROM goal_storage_pending", [])
            .unwrap();
        assert!(unarchive_goal_at(&conn, "t").unwrap().archived_at.is_none());
    }

    #[test]
    fn task_list_by_project_id_does_not_scan_whole_table() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS projects(path TEXT PRIMARY KEY, name TEXT NOT NULL, id TEXT);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projects(path,name,id) VALUES('/new','课题','pid-1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks(id,identity_key,kind,name,project_root,project_id,created_at,updated_at) VALUES('t1','user:a','free_research','旧路径目标','/old','pid-1','n','n')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks(id,identity_key,kind,name,project_root,created_at,updated_at) VALUES('t2','user:b','free_research','旁项目','/other','n','n')",
            [],
        )
        .unwrap();
        let moved = list_tasks_at(&conn, Some("/new"), true).unwrap();
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].id, "t1");
        let unknown = list_tasks_at(&conn, Some("/other"), true).unwrap();
        assert_eq!(unknown.len(), 1);
        assert_eq!(unknown[0].id, "t2");
        let all = list_tasks_at(&conn, None, true).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn scratch_and_reader_runs_have_no_goal_task() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        let input = |kind: &str, path: &str| OpenRunInput {
            id: None,
            task_id: None,
            project_root: None,
            task_kind: Some(kind.into()),
            task_ref: None,
            isolation_path: path.into(),
            runtime: Some("local_cli".into()),
            agent: "claude-code".into(),
            profile_id: None,
            permission: Some("write_tree".into()),
            reuse_key: None,
            session_id: None,
            custom_runtime_id: None,
            internal: Some(false),
            sentinel: Some(false),
        };
        // 随手聊/阅读/办公文件闲聊：Run 可以没有 Goal，不再自动登记 Task 行
        for (kind, path) in [
            ("scratch", "/tmp/ccode-scratch/a"),
            ("reader", "/tmp/ccode-reader/b"),
            ("office_doc", "/tmp/ccode-office/c"),
        ] {
            let run = open_at(&conn, input(kind, path)).unwrap();
            assert!(run.task_id.is_empty(), "{kind} 不应有 Task");
        }
        let count: i64 = conn
            .query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "无目标执行不得在 tasks 表留行");
        // 归属类执行（科研步骤/编程车道）仍登记 Task
        let lane = open_at(&conn, input("coding_lane", "/tmp/ccode-worktrees/r/feat")).unwrap();
        assert!(!lane.task_id.is_empty());
    }

    #[test]
    fn infer_task_kind_prefixes() {
        assert_eq!(infer_task_kind("login:claude-code", "/x"), "login");
        assert_eq!(infer_task_kind("reader:/p", "/p"), "reader");
        assert_eq!(infer_task_kind("watch:s1:/p", "/p"), "watch");
        assert_eq!(infer_task_kind("office:/p:file", "/p"), "office_doc");
        assert_eq!(infer_task_kind("free:/p:task", "/p"), "free_research");
        assert_eq!(infer_task_kind("ws:/wt", "/wt"), "pipeline_step");
        assert_eq!(canonicalize_reuse_key("wt:/t"), "lane:/t");
        assert_eq!(infer_task_kind("wt:/t", "/t"), "coding_lane");
        assert_eq!(infer_task_kind("lane:/t", "/t"), "coding_lane");
        assert_eq!(
            infer_task_kind(
                "custom:r1:/Users/me/ccode/worktrees/r/feat",
                "/Users/me/ccode/worktrees/r/feat"
            ),
            "coding_lane"
        );
        assert_eq!(
            infer_task_kind("coding:/repo:project", "/repo"),
            "coding_lane"
        );
        assert_eq!(infer_task_kind("headless:ai-prompt:x", "/tmp"), "scratch");
        assert_eq!(infer_task_kind("", "/Users/me/ccode/scratch/a"), "scratch");
        assert_eq!(
            infer_task_kind("", "/Users/me/ccode/workspaces/r/lit"),
            "pipeline_step"
        );
        assert_eq!(
            infer_task_kind("", "/Users/me/ccode/worktrees/r/feat"),
            "coding_lane"
        );
    }

    #[test]
    fn watch_is_internal() {
        assert!(is_internal_kind("watch", "watch:1:/p"));
        assert!(is_internal_kind("scratch", "headless:ai-prompt:x"));
        assert!(!is_internal_kind("pipeline_step", "ws:/x"));
    }

    #[test]
    fn prune_nested_rel_paths_keeps_parent() {
        assert_eq!(
            prune_nested_rel_paths(&["notes/a.md".into(), "notes".into(), "papers/a.pdf".into()]),
            vec!["notes".to_string(), "papers/a.pdf".to_string()]
        );
        assert_eq!(
            prune_nested_rel_paths(&[".".into(), "notes".into()]),
            vec![".".to_string()]
        );
    }

    #[test]
    fn project_scope_copy_skips_ccode_and_dependency_directories() {
        let root = std::env::temp_dir().join(format!("ccode-task-scope-{}", uuid::Uuid::new_v4()));
        let target = root.join("target");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join(".ccode")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join(".git/config"), "secret").unwrap();
        std::fs::write(root.join(".ccode/project.toml"), "secret").unwrap();
        std::fs::write(root.join("node_modules/pkg.js"), "dependency").unwrap();
        std::fs::write(root.join("src/main.ts"), "export {}").unwrap();
        copy_project_contents(&root, &target, &mut TaskCopyBudget::default()).unwrap();
        assert!(target.join("src/main.ts").is_file());
        assert!(!target.join(".git").exists());
        assert!(!target.join(".ccode").exists());
        assert!(!target.join("node_modules").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn list_output_changes_marks_added_and_modified() {
        let root = std::env::temp_dir().join(format!("ccode-task-review-{}", uuid::Uuid::new_v4()));
        let source = root.join("run");
        let target = root.join("project");
        std::fs::create_dir_all(source.join("notes")).unwrap();
        std::fs::create_dir_all(target.join("notes")).unwrap();
        std::fs::write(source.join("notes/changed.md"), "new").unwrap();
        std::fs::write(target.join("notes/changed.md"), "old").unwrap();
        std::fs::write(source.join("notes/new.md"), "added").unwrap();
        std::fs::write(source.join("notes/same.md"), "same").unwrap();
        std::fs::write(target.join("notes/same.md"), "same").unwrap();

        let changes = list_output_changes(&source, &target, &[".".to_string()]).unwrap();
        assert_eq!(
            changes
                .iter()
                .map(|item| (item.path.as_str(), item.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![("notes/changed.md", "modified"), ("notes/new.md", "added")]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn adopt_selected_files_overwrites_after_review() {
        let root = std::env::temp_dir().join(format!("ccode-task-adopt-{}", uuid::Uuid::new_v4()));
        let source = root.join("run");
        let target = root.join("project");
        std::fs::create_dir_all(source.join("notes")).unwrap();
        std::fs::create_dir_all(target.join("notes")).unwrap();
        std::fs::write(source.join("notes/keep.md"), "new-keep").unwrap();
        std::fs::write(target.join("notes/keep.md"), "old-keep").unwrap();
        std::fs::write(source.join("notes/skip.md"), "new-skip").unwrap();
        std::fs::write(target.join("notes/skip.md"), "old-skip").unwrap();
        std::fs::write(source.join("notes/extra.md"), "added").unwrap();

        copy_adopt_file(&source.join("notes/keep.md"), &target.join("notes/keep.md")).unwrap();
        copy_adopt_file(
            &source.join("notes/extra.md"),
            &target.join("notes/extra.md"),
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(target.join("notes/keep.md")).unwrap(),
            "new-keep"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("notes/skip.md")).unwrap(),
            "old-skip"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("notes/extra.md")).unwrap(),
            "added"
        );
        #[cfg(unix)]
        {
            let link = target.join("notes/link.md");
            std::os::unix::fs::symlink(target.join("notes/keep.md"), &link).unwrap();
            assert!(copy_adopt_file(&source.join("notes/keep.md"), &link).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn adopt_second_file_failure_rolls_back_first() {
        let root =
            std::env::temp_dir().join(format!("ccode-task-adopt-rb-{}", uuid::Uuid::new_v4()));
        let source = root.join("run");
        let target = root.join("project");
        let adopt = root.join("adopt-state");
        std::fs::create_dir_all(source.join("notes")).unwrap();
        std::fs::create_dir_all(target.join("notes")).unwrap();
        std::fs::write(source.join("notes/first.md"), "new-first").unwrap();
        std::fs::write(target.join("notes/first.md"), "old-first").unwrap();
        std::fs::write(source.join("notes/second.md"), "new-second").unwrap();
        std::fs::write(target.join("notes/second.md"), "old-second").unwrap();
        TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = Some(adopt));
        let mut remaining = 1;
        let result = adopt_selected_with_writer(
            "run-1",
            &source,
            &target,
            &["notes/first.md".into(), "notes/second.md".into()],
            |src, dst| {
                if remaining == 0 {
                    return Err("injected failure".into());
                }
                remaining -= 1;
                copy_adopt_file(src, dst)
            },
        );
        TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = None);
        assert!(result.unwrap_err().contains("injected failure"));
        assert_eq!(
            std::fs::read_to_string(target.join("notes/first.md")).unwrap(),
            "old-first"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("notes/second.md")).unwrap(),
            "old-second"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn adopt_detects_concurrent_change_and_rolls_back() {
        let root =
            std::env::temp_dir().join(format!("ccode-task-adopt-race-{}", uuid::Uuid::new_v4()));
        let source = root.join("run");
        let target = root.join("project");
        let adopt = root.join("adopt-state");
        std::fs::create_dir_all(source.join("notes")).unwrap();
        std::fs::create_dir_all(target.join("notes")).unwrap();
        std::fs::write(source.join("notes/first.md"), "new-first").unwrap();
        std::fs::write(target.join("notes/first.md"), "old-first").unwrap();
        std::fs::write(source.join("notes/second.md"), "new-second").unwrap();
        std::fs::write(target.join("notes/second.md"), "old-second").unwrap();
        TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = Some(adopt));
        let second = target.join("notes/second.md");
        let result = adopt_selected_with_writer(
            "run-2",
            &source,
            &target,
            &["notes/first.md".into(), "notes/second.md".into()],
            |src, dst| {
                copy_adopt_file(src, dst)?;
                if dst.ends_with("first.md") {
                    std::fs::write(&second, "external").unwrap();
                }
                Ok(())
            },
        );
        TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = None);
        assert!(result.unwrap_err().contains("采纳期间变化"));
        assert_eq!(
            std::fs::read_to_string(target.join("notes/first.md")).unwrap(),
            "old-first"
        );
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "external");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn specified_output_existing_file_is_modified_not_rejected() {
        let root =
            std::env::temp_dir().join(format!("ccode-task-specified-{}", uuid::Uuid::new_v4()));
        let source = root.join("run");
        let target = root.join("project");
        std::fs::create_dir_all(source.join("notes")).unwrap();
        std::fs::create_dir_all(target.join("notes")).unwrap();
        std::fs::write(source.join("notes/result.md"), "new").unwrap();
        std::fs::write(target.join("notes/result.md"), "old").unwrap();
        let changes =
            list_output_changes(&source, &target, &["notes/result.md".to_string()]).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "notes/result.md");
        assert_eq!(changes[0].kind, "modified");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn protected_paths_block_descendant_files() {
        let protected = vec!["数据/raw".to_string()];
        assert!(crate::projects::path_is_protected(
            "数据/raw/a.csv",
            &protected
        ));
        assert!(!crate::projects::path_is_protected(
            "论文/综述.md",
            &protected
        ));
    }

    #[test]
    fn adopt_rolls_back_a_file_even_if_writer_fails_after_replacing_it() {
        let root =
            std::env::temp_dir().join(format!("ccode-adopt-after-write-{}", uuid::Uuid::new_v4()));
        let source = root.join("run");
        let target = root.join("project");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("file.md"), "new").unwrap();
        fs::write(target.join("file.md"), "old").unwrap();
        TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = Some(root.join("adopt")));
        let result =
            adopt_selected_with_writer("run", &source, &target, &["file.md".into()], |src, dst| {
                copy_adopt_file(src, dst)?;
                Err("failure after replace".into())
            });
        TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = None);
        assert!(result.unwrap_err().contains("failure after replace"));
        assert_eq!(fs::read(target.join("file.md")).unwrap(), b"old");
        assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
