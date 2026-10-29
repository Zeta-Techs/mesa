//! 普通目标副本的显式清理；归档、项目成果与接受账本不在删除范围内。
use super::*;
use std::collections::{BTreeMap, BTreeSet};

const MAX_ENTRIES: usize = 100_000;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub bytes: u64,
    pub files: u64,
    pub directories: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStorageReview {
    pub task_id: String,
    pub workspace: Usage,
    pub review: Usage,
    pub revision: String,
    pub blocked_reason: Option<String>,
    pub review_blocked_reason: Option<String>,
    pub pending: Option<PendingSummary>,
    pub workspace_paths: Vec<String>,
    pub review_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSummary {
    pub id: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CleanupEntry {
    source: String,
    staged: String,
    fingerprint: String,
    inventory: BTreeMap<String, String>,
    phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Cleanup {
    id: String,
    task_id: String,
    scope: String,
    runs: Vec<String>,
    entries: Vec<CleanupEntry>,
}

pub(super) fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS goal_storage_pending (
        task_id TEXT PRIMARY KEY, payload TEXT NOT NULL);",
    )
    .map_err(|e| e.to_string())
}

pub(crate) fn root() -> Result<PathBuf, String> {
    Ok(crate::dirs::data_local_dir()
        .or_else(crate::dirs::data_dir)
        .or_else(crate::dirs::config_dir)
        .ok_or("无法确定 Mesa 数据目录")?
        .join("ccode/task-runs"))
}

pub(super) fn lock_task(id: &str) -> Result<fs::File, String> {
    crate::storage::config_lock(&format!("goal-storage-{:x}", md5::compute(id.as_bytes())))
}

fn component(value: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(value).is_err() || value.contains(['/', '\\']) {
        return Err("副本路径身份无效，拒绝清理".into());
    }
    Ok(())
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn real_dir(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("读取副本目录失败：{}：{e}", path.display())),
        Ok(meta) if meta.is_dir() && !is_link(&meta) => Ok(true),
        Ok(_) => Err(format!(
            "副本目录不是普通目录（不允许链接）：{}",
            path.display()
        )),
    }
}

fn task_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    component(id)?;
    // 包括上级目录在内检查，不能让替换后的链接把清理导向项目或外部目录。
    for ancestor in root.ancestors().collect::<Vec<_>>().into_iter().rev() {
        if !ancestor.as_os_str().is_empty() {
            real_dir(ancestor)?;
        }
    }
    let dir = root.join(id);
    real_dir(&dir)?;
    Ok(dir)
}

struct Inventory {
    usage: Usage,
    fingerprint: String,
    entries: BTreeMap<String, String>,
}

fn scan(path: &Path) -> Result<Inventory, String> {
    fn walk(
        path: &Path,
        base: &Path,
        depth: usize,
        count: &mut usize,
        snapshot: &mut Inventory,
        hash: &mut sha2::Sha256,
    ) -> Result<(), String> {
        *count += 1;
        if depth > 64 || *count > MAX_ENTRIES {
            return Err("副本项目过多，无法完整核对；未执行清理".into());
        }
        let meta = fs::symlink_metadata(path)
            .map_err(|e| format!("统计副本失败：{}：{e}", path.display()))?;
        if is_link(&meta) {
            return Err(format!("副本中含链接，需先人工处理：{}", path.display()));
        }
        let rel = path
            .strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_str()
            .ok_or("副本包含无法识别的文件名，未执行清理")?
            .replace('\\', "/");
        let modified = meta
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let mut signature = sha2::Sha256::new();
        // 目录删除一部分后 mtime 会变，恢复时只比较目录身份；文件仍比较身份、长度和 mtime。
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            signature.update(meta.dev().to_le_bytes());
            signature.update(meta.ino().to_le_bytes());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            signature.update(meta.creation_time().to_le_bytes());
        }
        if meta.is_file() {
            snapshot.usage.files += 1;
            snapshot.usage.bytes = snapshot
                .usage
                .bytes
                .checked_add(meta.len())
                .ok_or("副本大小溢出")?;
            signature.update(b"file");
            signature.update(meta.len().to_le_bytes());
            signature.update(modified.to_le_bytes());
        } else if meta.is_dir() {
            snapshot.usage.directories += 1;
            signature.update(b"dir");
        } else {
            return Err("副本中含特殊文件，未执行清理".into());
        }
        let signature = format!("{:x}", signature.finalize());
        hash.update(rel.as_bytes());
        hash.update([0]);
        hash.update(signature.as_bytes());
        hash.update(modified.to_le_bytes());
        snapshot.entries.insert(rel, signature);
        if meta.is_dir() {
            let mut entries = Vec::new();
            for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
                if entries.len() >= MAX_ENTRIES.saturating_sub(*count) {
                    return Err("副本项目过多，无法完整核对；未执行清理".into());
                }
                entries.push(entry.map_err(|e| e.to_string())?);
            }
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                walk(&entry.path(), base, depth + 1, count, snapshot, hash)?;
            }
        }
        Ok(())
    }
    let mut snapshot = Inventory {
        usage: Usage::default(),
        fingerprint: String::new(),
        entries: BTreeMap::new(),
    };
    let mut hash = sha2::Sha256::new();
    if real_dir(path)? {
        walk(path, path, 0, &mut 0, &mut snapshot, &mut hash)?;
    }
    snapshot.fingerprint = format!("{:x}", hash.finalize());
    Ok(snapshot)
}

fn check_remaining(path: &Path, entry: &CleanupEntry, complete: bool) -> Result<(), String> {
    let current = scan(path)?;
    if (complete && current.entries.len() != entry.inventory.len())
        || current
            .entries
            .iter()
            .any(|(name, signature)| entry.inventory.get(name) != Some(signature))
    {
        return Err("待清理目录在确认后被修改或替换，未继续删除；原清理记录保留".into());
    }
    Ok(())
}

fn add_usage(total: &mut Usage, value: &Usage) {
    total.bytes = total.bytes.saturating_add(value.bytes);
    total.files = total.files.saturating_add(value.files);
    total.directories = total.directories.saturating_add(value.directories);
}

fn pending(conn: &Connection, id: &str) -> Result<Option<Cleanup>, String> {
    let text: Option<String> = conn
        .query_row(
            "SELECT payload FROM goal_storage_pending WHERE task_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    text.map(|text| {
        serde_json::from_str(&text).map_err(|e| format!("清理恢复单损坏，拒绝继续：{e}"))
    })
    .transpose()
}

pub(super) fn has_pending(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM goal_storage_pending WHERE task_id=?1)",
        [id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub(super) fn attach(conn: &Connection, mut task: TaskDto) -> Result<TaskDto, String> {
    task.storage_cleanup_pending = has_pending(conn, &task.id)?;
    let flags: Option<(bool, bool)> = conn.query_row(
        "SELECT workspace_cleared,review_cleared FROM runs WHERE task_id=?1 AND internal=0 ORDER BY created_at DESC LIMIT 1",
        [&task.id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
    (task.workspace_cleared, task.review_cleared) = flags.unwrap_or_default();
    Ok(task)
}

pub(super) fn ensure_available(
    conn: &Connection,
    run: &RunDto,
    review: bool,
) -> Result<(), String> {
    if has_pending(conn, &run.task_id)? {
        return Err("目标有未完成的副本清理，请先继续清理".into());
    }
    let column = if review {
        "review_cleared"
    } else {
        "workspace_cleared"
    };
    let cleared: bool = conn
        .query_row(
            &format!("SELECT {column} FROM runs WHERE id=?1"),
            [&run.id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if cleared {
        return Err(if review {
            "此运行的历史版本已清理，不能预览或采纳；接受记录仍保留"
        } else {
            "此运行的工作副本已清理，请从当前项目重新开始目标"
        }
        .into());
    }
    Ok(())
}

pub(super) fn check_open(conn: &Connection, input: &OpenRunInput) -> Result<(), String> {
    if let Some(id) = &input.task_id {
        if has_pending(conn, id)? {
            return Err("目标有未完成的副本清理，请先继续清理".into());
        }
    }
    if let Some(id) = &input.id {
        if let Some(run) = get_run_at(conn, id)? {
            ensure_available(conn, &run, false)?;
        }
    }
    // 不允许旧标签绕过 runId，以原路径重新登记已删除的工作副本。
    let cleared: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM runs WHERE isolation_path=?1 AND workspace_cleared=1)",
            [&input.isolation_path],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if cleared {
        return Err("此工作副本已清理，请从目标入口重新开始".into());
    }
    Ok(())
}

fn eligible(task: &TaskDto, runs: &[RunDto], dir: &Path) -> Result<Option<String>, String> {
    if !task.declared || !matches!(task.kind.as_str(), "free_research" | "office_doc") {
        return Err("只能清理普通科研或工作目标的副本".into());
    }
    if matches!(task.status.as_str(), "running" | "pending_review") {
        return Ok(Some(
            "运行中或待验收的目标不能清理；请先完成验收并关闭 Agent".into(),
        ));
    }
    if runs.iter().any(|r| r.closed_at.is_none()) {
        return Ok(Some("请先关闭这个目标所有 Agent 标签，再清理副本".into()));
    }
    if task.status != "completed" && task.archived_at.is_none() {
        return Ok(Some(
            "未完成的目标请先归档，确认放弃未采纳成果后再清理".into(),
        ));
    }
    let review = dir.join("review");
    if real_dir(&review)? {
        for entry in fs::read_dir(&review).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            component(&name)?;
            real_dir(&entry.path())?;
            if !runs.iter().any(|r| r.id == name) {
                return Err("发现不属于该目标的评审目录，拒绝清理".into());
            }
            match fs::symlink_metadata(entry.path().join("apply-pending.json")) {
                Ok(_) => {
                    return Ok(Some(
                        "目标有未完成的接受操作，请先继续接受或恢复原文件".into(),
                    ))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("无法核对接受恢复单，拒绝清理：{error}")),
            }
        }
    }
    Ok(None)
}

fn work_paths(dir: &Path, runs: &[RunDto]) -> Result<Vec<String>, String> {
    let mut names = BTreeSet::new();
    for run in runs {
        let path = Path::new(&run.isolation_path);
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("工作副本路径无效")?;
        component(name)?;
        let parent = path.parent().ok_or("工作副本路径无效")?;
        if !crate::paths::same_path(&parent.to_string_lossy(), &dir.to_string_lossy()) {
            return Err("工作目录不在此目标专属副本内，拒绝清理".into());
        }
        names.insert(name.to_owned());
    }
    Ok(names.into_iter().collect())
}

/// 只认「别人的运行 / 项目根 / 注册项目」落在待删目录内；本目标自己的运行除外。
fn referenced_elsewhere(
    conn: &Connection,
    own_run_ids: &BTreeSet<String>,
    dirs: &[PathBuf],
) -> Result<Option<String>, String> {
    if dirs.is_empty() {
        return Ok(None);
    }
    let mut stmt = conn
        .prepare("SELECT id, isolation_path FROM runs")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, isolation) = row.map_err(|e| e.to_string())?;
        if own_run_ids.contains(&id) || isolation.is_empty() {
            continue;
        }
        if dirs
            .iter()
            .any(|dir| crate::paths::path_within(&isolation, &dir.to_string_lossy()))
        {
            return Ok(Some("该副本仍被其他项目或运行引用，不能删除".into()));
        }
    }
    let mut stmt = conn
        .prepare(
            "SELECT project_root FROM tasks WHERE project_root IS NOT NULL AND project_root != ''",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let root = row.map_err(|e| e.to_string())?;
        if dirs
            .iter()
            .any(|dir| crate::paths::path_within(&root, &dir.to_string_lossy()))
        {
            return Ok(Some("该副本仍被其他项目或运行引用，不能删除".into()));
        }
    }
    let has_projects: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if has_projects {
        let mut stmt = conn
            .prepare("SELECT path FROM projects")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let path = row.map_err(|e| e.to_string())?;
            if dirs
                .iter()
                .any(|dir| crate::paths::path_within(&path, &dir.to_string_lossy()))
            {
                return Ok(Some("该副本仍被其他项目或运行引用，不能删除".into()));
            }
        }
    }
    Ok(None)
}

fn existing_named_dirs(dir: &Path, names: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    for name in names {
        let path = dir.join(name);
        if real_dir(&path)? {
            out.push(path);
        }
    }
    Ok(out)
}

fn inspect_at(conn: &Connection, root: &Path, id: &str) -> Result<TaskStorageReview, String> {
    let task = task_by_id(conn, id)?;
    let runs = query_runs(conn, "WHERE task_id=?1 ORDER BY id", [id])?;
    let dir = task_dir(root, id)?;
    let pending = pending(conn, id)?;
    let blocked = eligible(&task, &runs, &dir)?;
    let paths = work_paths(&dir, &runs)?;
    let mut workspace = Usage::default();
    let mut review = Usage::default();
    let mut workspace_paths = Vec::new();
    let mut review_paths = Vec::new();
    let mut hash = sha2::Sha256::new();
    hash.update(serde_json::to_vec(&task).map_err(|e| e.to_string())?);
    hash.update(serde_json::to_vec(&runs).map_err(|e| e.to_string())?);
    for name in &paths {
        let snapshot = scan(&dir.join(name))?;
        if snapshot.usage.directories > 0 {
            workspace_paths.push(dir.join(name).to_string_lossy().into_owned());
        }
        add_usage(&mut workspace, &snapshot.usage);
        hash.update(name);
        hash.update(snapshot.fingerprint);
    }
    let snapshot = scan(&dir.join("review"))?;
    if snapshot.usage.directories > 0 {
        review_paths.push(dir.join("review").to_string_lossy().into_owned());
    }
    add_usage(&mut review, &snapshot.usage);
    hash.update(snapshot.fingerprint);
    if let Some(pending) = &pending {
        for entry in &pending.entries {
            validate_entry(&pending.id, entry)?;
            let snapshot = scan(&dir.join(&entry.staged))?;
            if snapshot.usage.directories > 0 {
                let paths = if pending.scope == "workspace" {
                    &mut workspace_paths
                } else {
                    &mut review_paths
                };
                paths.push(dir.join(&entry.staged).to_string_lossy().into_owned());
            }
            add_usage(
                if pending.scope == "workspace" {
                    &mut workspace
                } else {
                    &mut review
                },
                &snapshot.usage,
            );
        }
    }
    let own_run_ids: BTreeSet<String> = runs.iter().map(|r| r.id.clone()).collect();
    let mut work_dirs = existing_named_dirs(&dir, &paths)?;
    let mut review_dirs = existing_named_dirs(&dir, &["review".into()])?;
    if let Some(pending) = &pending {
        for entry in &pending.entries {
            for path in [dir.join(&entry.source), dir.join(&entry.staged)] {
                if real_dir(&path)? {
                    if pending.scope == "workspace" {
                        work_dirs.push(path);
                    } else {
                        review_dirs.push(path);
                    }
                }
            }
        }
    }
    let blocked = blocked.or(referenced_elsewhere(conn, &own_run_ids, &work_dirs)?);
    Ok(TaskStorageReview {
        task_id: id.into(),
        review_blocked_reason: blocked
            .clone()
            .or_else(|| {
                (workspace.directories > 0)
                    .then(|| "请先清理工作副本，再单独删除历史版本与恢复备份".into())
            })
            .or(referenced_elsewhere(conn, &own_run_ids, &review_dirs)?),
        workspace,
        review,
        workspace_paths,
        review_paths,
        revision: format!("{:x}", hash.finalize()),
        blocked_reason: blocked,
        pending: pending.map(|p| PendingSummary {
            id: p.id,
            scope: p.scope,
        }),
    })
}

fn validate_entry(operation: &str, entry: &CleanupEntry) -> Result<(), String> {
    component(operation)?;
    if entry.source != "review" {
        component(&entry.source)?;
    }
    if entry.staged != format!(".cleanup-{operation}-{}", entry.source) {
        return Err("清理恢复路径无效".into());
    }
    if !matches!(entry.phase.as_str(), "planned" | "staged" | "removed") {
        return Err("清理阶段无效".into());
    }
    Ok(())
}

fn save_pending(conn: &Connection, value: &Cleanup) -> Result<(), String> {
    conn.execute(
        "INSERT INTO goal_storage_pending(task_id,payload) VALUES(?1,?2)
        ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload",
        params![
            value.task_id,
            serde_json::to_string(value).map_err(|e| e.to_string())?
        ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn finish_cleanup(
    conn: &mut Connection,
    root: &Path,
    cleanup: &mut Cleanup,
    mut remove: impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let dir = task_dir(root, &cleanup.task_id)?;
    for index in 0..cleanup.entries.len() {
        let entry = &cleanup.entries[index];
        validate_entry(&cleanup.id, entry)?;
        if entry.phase == "removed" {
            continue;
        }
        let source = dir.join(&entry.source);
        let staged = dir.join(&entry.staged);
        if entry.phase == "planned" {
            if !real_dir(&staged)? {
                if !real_dir(&source)? {
                    return Err("待清理副本已被外部移动，请检查；恢复单保留".into());
                }
                if scan(&source)?.fingerprint != entry.fingerprint {
                    return Err("副本在确认后被修改，未删除；请检查外部编辑".into());
                }
                fs::rename(&source, &staged).map_err(|e| format!("隔离待清理副本失败：{e}"))?;
            }
            check_remaining(&staged, &cleanup.entries[index], true)?;
            cleanup.entries[index].phase = "staged".into();
            save_pending(conn, cleanup)?;
        }
        // 先持久记 staged，再删除；重试只碰隔离目录，绝不删除后来重建的原路径。
        if real_dir(&staged)? {
            check_remaining(&staged, &cleanup.entries[index], false)?;
            remove(&staged)?;
        }
        cleanup.entries[index].phase = "removed".into();
        save_pending(conn, cleanup)?;
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for id in &cleanup.runs {
        record_event(
            &tx,
            id,
            "task.storage_cleared",
            Some(&serde_json::json!({"scope":cleanup.scope,"operationId":cleanup.id}).to_string()),
        )?;
    }
    tx.execute(
        "DELETE FROM goal_storage_pending WHERE task_id=?1",
        [&cleanup.task_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn cleanup_at(
    conn: &mut Connection,
    root: &Path,
    leases_root: &Path,
    id: &str,
    scope: &str,
    revision: &str,
    operation_id: Option<&str>,
    confirmed: bool,
    remove: impl FnMut(&Path) -> Result<(), String>,
) -> Result<TaskStorageReview, String> {
    if !confirmed {
        return Err("需要明确确认副本清理范围和影响".into());
    }
    if !matches!(scope, "workspace" | "review") {
        return Err("不支持的清理范围".into());
    }
    let dir = task_dir(root, id)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let task = task_by_id(&tx, id)?;
    let runs = query_runs(&tx, "WHERE task_id=?1 ORDER BY id", [id])?;
    if let Some(reason) = eligible(&task, &runs, &dir)? {
        return Err(reason);
    }
    let mut leases = Vec::new();
    for run in &runs {
        leases.push(try_run_lease(leases_root, &run.id)?.ok_or("目标 Agent 仍在运行，不能清理")?);
    }
    let mut cleanup = if let Some(value) = pending(&tx, id)? {
        if operation_id != Some(value.id.as_str()) || value.scope != scope || value.task_id != id {
            return Err("请继续原来的清理操作，不可改为新的删除范围".into());
        }
        value
    } else {
        if operation_id.is_some() {
            return Err("原清理已结束，请刷新占用".into());
        }
        let current = inspect_at(&tx, root, id)?;
        if current.revision != revision {
            return Err("副本或目标状态已变化，请刷新占用后重新确认".into());
        }
        if scope == "review" {
            if let Some(reason) = current.review_blocked_reason {
                return Err(reason);
            }
        }
        let sources = if scope == "workspace" {
            work_paths(&dir, &runs)?
        } else {
            vec!["review".into()]
        };
        let operation = uuid::Uuid::new_v4().to_string();
        let mut entries = Vec::new();
        for name in sources {
            if real_dir(&dir.join(&name))? {
                let snapshot = scan(&dir.join(&name))?;
                entries.push(CleanupEntry {
                    staged: format!(".cleanup-{operation}-{name}"),
                    source: name.clone(),
                    fingerprint: snapshot.fingerprint,
                    inventory: snapshot.entries,
                    phase: "planned".into(),
                });
            }
        }
        if entries.is_empty() {
            return Err("没有可清理的副本，请刷新占用".into());
        }
        Cleanup {
            id: operation,
            task_id: id.into(),
            scope: scope.into(),
            runs: runs.iter().map(|r| r.id.clone()).collect(),
            entries,
        }
    };
    let valid_sources = if scope == "workspace" {
        work_paths(&dir, &runs)?
    } else {
        vec!["review".into()]
    };
    if cleanup.runs != runs.iter().map(|r| r.id.clone()).collect::<Vec<_>>()
        || cleanup
            .entries
            .iter()
            .any(|entry| !valid_sources.contains(&entry.source))
    {
        return Err("清理恢复单与目标运行不匹配，拒绝删除".into());
    }
    let own_run_ids: BTreeSet<String> = cleanup.runs.iter().cloned().collect();
    let mut targets = Vec::new();
    for entry in &cleanup.entries {
        let staged = dir.join(&entry.staged);
        let source = dir.join(&entry.source);
        if real_dir(&staged)? {
            targets.push(staged);
        } else if real_dir(&source)? {
            targets.push(source);
        }
    }
    if let Some(reason) = referenced_elsewhere(&tx, &own_run_ids, &targets)? {
        return Err(reason);
    }
    save_pending(&tx, &cleanup)?;
    let field = if scope == "workspace" {
        "workspace_cleared"
    } else {
        "review_cleared"
    };
    for run in &cleanup.runs {
        tx.execute(
            &format!("UPDATE runs SET {field}=1 WHERE id=?1 AND task_id=?2"),
            params![run, id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    finish_cleanup(conn, root, &mut cleanup, remove)?;
    inspect_at(conn, root, id)
}

#[tauri::command]
pub async fn task_storage_review(task_id: String) -> Result<TaskStorageReview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = lock_task(&task_id)?;
        inspect_at(&db()?, &root()?, &task_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn task_cleanup(
    task_id: String,
    scope: String,
    revision: String,
    operation_id: Option<String>,
    confirmed: bool,
) -> Result<TaskStorageReview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = lock_task(&task_id)?;
        cleanup_at(
            &mut db()?,
            &root()?,
            &lease_dir()?,
            &task_id,
            &scope,
            &revision,
            operation_id.as_deref(),
            confirmed,
            |path| fs::remove_dir_all(path).map_err(|e| format!("清理未完成，请继续原操作：{e}")),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        id: String,
        run: String,
        work: PathBuf,
        review: PathBuf,
        project: PathBuf,
        conn: Connection,
    }
    impl Fixture {
        fn new() -> Self {
            let base =
                std::env::temp_dir().join(format!("mesa-storage-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&base).unwrap();
            let base = base.canonicalize().unwrap();
            let root = base.join("task-runs");
            let id = uuid::Uuid::new_v4().to_string();
            let run = uuid::Uuid::new_v4().to_string();
            let work = root.join(&id).join(uuid::Uuid::new_v4().to_string());
            let review = root.join(&id).join("review").join(&run);
            let project = base.join("project");
            fs::create_dir_all(work.join("input")).unwrap();
            fs::create_dir_all(review.join("versions/v1/payload")).unwrap();
            fs::create_dir_all(project.join(".ccode")).unwrap();
            fs::write(work.join("input/data.txt"), "material").unwrap();
            fs::write(work.join("result.md"), "result").unwrap();
            fs::write(review.join("versions/v1/payload/result.md"), "result").unwrap();
            fs::write(project.join("result.md"), "accepted result").unwrap();
            fs::write(
                project.join(".ccode/acceptance-log.jsonl"),
                "acceptance proof\n",
            )
            .unwrap();
            let conn = Connection::open_in_memory().unwrap();
            super::super::ensure_schema(&conn).unwrap();
            conn.execute("INSERT INTO tasks(id,identity_key,project_root,kind,name,status,review_required,created_at,updated_at)
                VALUES(?1,?2,?3,'free_research','目标','completed',1,'now','now')", params![id,format!("user:{id}"),project.to_string_lossy()]).unwrap();
            conn.execute("INSERT INTO runs(id,task_id,project_root,task_kind,isolation_path,runtime,agent,permission,status,closed_at,created_at)
                VALUES(?1,?2,?3,'free_research',?4,'local_cli','codex','write_tree','completed','done','now')",
                params![run,id,project.to_string_lossy(),work.to_string_lossy()]).unwrap();
            Self {
                base,
                root,
                id,
                run,
                work,
                review,
                project,
                conn,
            }
        }
        fn inspect(&self) -> TaskStorageReview {
            inspect_at(&self.conn, &self.root, &self.id).unwrap()
        }
        fn clean(&mut self, scope: &str) -> Result<TaskStorageReview, String> {
            let review = self.inspect();
            cleanup_at(
                &mut self.conn,
                &self.root,
                &self.base.join("leases"),
                &self.id,
                scope,
                &review.revision,
                review.pending.as_ref().map(|p| p.id.as_str()),
                true,
                |p| fs::remove_dir_all(p).map_err(|e| e.to_string()),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn cleans_work_then_history_preserving_project_task_and_ledger() {
        let mut f = Fixture::new();
        let initial = f.inspect();
        assert_eq!(initial.workspace.bytes, 14);
        assert_eq!(initial.review.bytes, 6);
        assert!(initial.review_blocked_reason.is_some());
        assert!(f.clean("review").unwrap_err().contains("先清理工作副本"));
        f.clean("workspace").unwrap();
        assert!(!f.work.exists());
        assert!(f.review.exists());
        let task = task_by_id(&f.conn, &f.id).unwrap();
        assert!(task.workspace_cleared);
        assert!(!task.review_cleared);
        f.clean("review").unwrap();
        assert!(!f.review.exists());
        let task = task_by_id(&f.conn, &f.id).unwrap();
        assert!(task.review_cleared);
        assert_eq!(task.status, "completed");
        assert_eq!(
            fs::read_to_string(f.project.join("result.md")).unwrap(),
            "accepted result"
        );
        assert_eq!(
            fs::read_to_string(f.project.join(".ccode/acceptance-log.jsonl")).unwrap(),
            "acceptance proof\n"
        );
        assert_eq!(
            f.conn
                .query_row(
                    "SELECT count(*) FROM run_events WHERE event_type='task.storage_cleared'",
                    [],
                    |r| r.get::<_, u32>(0)
                )
                .unwrap(),
            2
        );
        assert!(!has_pending(&f.conn, &f.id).unwrap());
        let run = get_run_at(&f.conn, &f.run).unwrap().unwrap();
        assert!(ensure_available(&f.conn, &run, false)
            .unwrap_err()
            .contains("已清理"));
        assert!(ensure_available(&f.conn, &run, true)
            .unwrap_err()
            .contains("已清理"));
    }

    #[test]
    fn active_review_pending_apply_and_unarchived_failure_are_blocked() {
        let mut f = Fixture::new();
        for state in ["running", "pending_review", "failed", "stopped", "pending"] {
            f.conn
                .execute("UPDATE tasks SET status=?1", [state])
                .unwrap();
            assert!(f.inspect().blocked_reason.is_some());
            assert!(f.clean("workspace").is_err());
            assert!(f.work.exists());
        }
        f.conn
            .execute("UPDATE tasks SET status='failed',archived_at='now'", [])
            .unwrap();
        assert!(f.inspect().blocked_reason.is_none());
        f.conn
            .execute("UPDATE tasks SET status='completed'", [])
            .unwrap();
        f.conn
            .execute("UPDATE runs SET closed_at=NULL", [])
            .unwrap();
        assert!(f.clean("workspace").is_err());
        f.conn
            .execute("UPDATE runs SET closed_at='done'", [])
            .unwrap();
        fs::write(
            f.review.join("apply-pending.json"),
            "partial invalid journal",
        )
        .unwrap();
        assert!(f.clean("workspace").unwrap_err().contains("接受操作"));
        assert!(f.work.exists());
    }

    #[test]
    fn confirmation_and_changed_revision_prevent_deletion() {
        let mut f = Fixture::new();
        let review = f.inspect();
        let no = cleanup_at(
            &mut f.conn,
            &f.root,
            &f.base.join("leases"),
            &f.id,
            "workspace",
            &review.revision,
            None,
            false,
            |_| panic!("must not delete"),
        );
        assert!(no.is_err());
        fs::write(f.work.join("later.txt"), "external edit").unwrap();
        let changed = cleanup_at(
            &mut f.conn,
            &f.root,
            &f.base.join("leases"),
            &f.id,
            "workspace",
            &review.revision,
            None,
            true,
            |_| panic!("must not delete"),
        );
        assert!(changed.unwrap_err().contains("重新确认"));
        assert!(!has_pending(&f.conn, &f.id).unwrap());
    }

    #[test]
    fn interrupted_deletion_resumes_exact_operation_without_touching_recreated_source() {
        let mut f = Fixture::new();
        let review = f.inspect();
        let failure = cleanup_at(
            &mut f.conn,
            &f.root,
            &f.base.join("leases"),
            &f.id,
            "workspace",
            &review.revision,
            None,
            true,
            |path| {
                fs::remove_file(path.join("result.md")).unwrap();
                Err("injected disk error".into())
            },
        );
        assert!(failure.is_err());
        assert!(!f.work.exists());
        let pending = pending(&f.conn, &f.id).unwrap().unwrap();
        assert_eq!(pending.entries[0].phase, "staged");
        assert!(task_by_id(&f.conn, &f.id).unwrap().storage_cleanup_pending);
        fs::create_dir_all(&f.work).unwrap();
        fs::write(f.work.join("new.txt"), "do not delete").unwrap();
        let wrong = cleanup_at(
            &mut f.conn,
            &f.root,
            &f.base.join("leases"),
            &f.id,
            "review",
            "",
            Some(&pending.id),
            true,
            |_| panic!("must not delete"),
        );
        assert!(wrong.is_err());
        f.clean("workspace").unwrap();
        assert_eq!(
            fs::read_to_string(f.work.join("new.txt")).unwrap(),
            "do not delete"
        );
        assert!(f.review.exists());
        assert!(!has_pending(&f.conn, &f.id).unwrap());
    }

    #[test]
    fn live_os_lease_blocks_cleanup_even_if_database_says_closed() {
        let mut f = Fixture::new();
        let _lease = try_run_lease(&f.base.join("leases"), &f.run)
            .unwrap()
            .unwrap();
        assert!(f.clean("workspace").unwrap_err().contains("仍在运行"));
        assert!(f.work.exists());
    }

    #[test]
    fn database_commit_failure_never_starts_deletion() {
        let mut f = Fixture::new();
        f.conn.execute_batch("CREATE TRIGGER deny_cleanup BEFORE INSERT ON goal_storage_pending BEGIN SELECT RAISE(ABORT,'read only'); END;").unwrap();
        assert!(f.clean("workspace").is_err());
        assert!(f.work.exists());
        assert!(!task_by_id(&f.conn, &f.id).unwrap().workspace_cleared);
    }

    #[test]
    fn outside_run_directory_and_traversal_ids_are_rejected() {
        let f = Fixture::new();
        assert!(inspect_at(&f.conn, &f.root, "../other").is_err());
        f.conn
            .execute(
                "UPDATE runs SET isolation_path=?1",
                [f.project.to_string_lossy()],
            )
            .unwrap();
        assert!(inspect_at(&f.conn, &f.root, &f.id).is_err());
        assert!(f.project.exists());
    }

    #[test]
    fn other_run_or_project_reference_blocks_cleanup() {
        let mut f = Fixture::new();
        let other_run = uuid::Uuid::new_v4().to_string();
        f.conn
            .execute(
                "INSERT INTO runs(id,task_id,project_root,task_kind,isolation_path,runtime,agent,permission,status,closed_at,created_at)
                VALUES(?1,?2,?3,'scratch',?4,'local_cli','codex','discuss','completed','done','now')",
                params![
                    other_run,
                    uuid::Uuid::new_v4().to_string(),
                    f.project.to_string_lossy(),
                    f.work.join("input").to_string_lossy()
                ],
            )
            .unwrap();
        assert!(f
            .inspect()
            .blocked_reason
            .unwrap()
            .contains("其他项目或运行引用"));
        assert!(f
            .clean("workspace")
            .unwrap_err()
            .contains("其他项目或运行引用"));
        assert!(f.work.exists());
        f.conn
            .execute("DELETE FROM runs WHERE id=?1", [other_run])
            .unwrap();
        assert!(f.inspect().blocked_reason.is_none());

        f.conn
            .execute_batch(
                "CREATE TABLE projects(path TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT, last_opened_at TEXT);",
            )
            .unwrap();
        f.conn
            .execute(
                "INSERT INTO projects(path, name) VALUES(?1,'占用')",
                [f.work.to_string_lossy()],
            )
            .unwrap();
        assert!(f
            .clean("workspace")
            .unwrap_err()
            .contains("其他项目或运行引用"));
        assert!(f.work.exists());
        f.conn.execute("DELETE FROM projects", []).unwrap();

        let other_task = uuid::Uuid::new_v4().to_string();
        f.conn
            .execute(
                "INSERT INTO tasks(id,identity_key,project_root,kind,name,status,review_required,created_at,updated_at)
                VALUES(?1,?2,?3,'office_doc','别的目标','completed',1,'now','now')",
                params![other_task, format!("user:{other_task}"), f.work.to_string_lossy()],
            )
            .unwrap();
        assert!(f
            .clean("workspace")
            .unwrap_err()
            .contains("其他项目或运行引用"));
        assert!(f.work.exists());
        f.conn
            .execute("DELETE FROM tasks WHERE id=?1", [other_task])
            .unwrap();
        f.clean("workspace").unwrap();
        let other_review = uuid::Uuid::new_v4().to_string();
        f.conn
            .execute(
                "INSERT INTO runs(id,task_id,project_root,task_kind,isolation_path,runtime,agent,permission,status,closed_at,created_at)
                VALUES(?1,?2,?3,'scratch',?4,'local_cli','codex','discuss','completed','done','now')",
                params![
                    other_review,
                    uuid::Uuid::new_v4().to_string(),
                    f.project.to_string_lossy(),
                    f.review.to_string_lossy()
                ],
            )
            .unwrap();
        assert!(f
            .inspect()
            .review_blocked_reason
            .unwrap()
            .contains("其他项目或运行引用"));
        assert!(f
            .clean("review")
            .unwrap_err()
            .contains("其他项目或运行引用"));
        assert!(f.review.exists());
    }

    #[test]
    fn interrupted_cleanup_refuses_if_staged_dir_changed() {
        let mut f = Fixture::new();
        let review = f.inspect();
        let failure = cleanup_at(
            &mut f.conn,
            &f.root,
            &f.base.join("leases"),
            &f.id,
            "workspace",
            &review.revision,
            None,
            true,
            |path| {
                fs::remove_file(path.join("result.md")).unwrap();
                Err("injected disk error".into())
            },
        );
        assert!(failure.is_err());
        let pending = pending(&f.conn, &f.id).unwrap().unwrap();
        let staged = f.root.join(&f.id).join(&pending.entries[0].staged);
        fs::write(staged.join("hijack.txt"), "external").unwrap();
        let err = f.clean("workspace").unwrap_err();
        assert!(err.contains("被修改或替换"));
        assert!(has_pending(&f.conn, &f.id).unwrap());
        assert_eq!(
            fs::read_to_string(staged.join("hijack.txt")).unwrap(),
            "external"
        );
        assert!(staged.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_in_task_root_work_and_history_never_followed() {
        let f = Fixture::new();
        std::os::unix::fs::symlink(&f.project, f.work.join("outside")).unwrap();
        assert!(inspect_at(&f.conn, &f.root, &f.id)
            .unwrap_err()
            .contains("链接"));
        fs::remove_file(f.work.join("outside")).unwrap();
        std::os::unix::fs::symlink(&f.project, f.review.join("outside")).unwrap();
        assert!(inspect_at(&f.conn, &f.root, &f.id).is_err());
    }
}
