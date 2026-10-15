//! 定时产物证据：工作目录可复用，但评审和采纳只读每次执行冻结的副本。
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const FILE_CAP: u64 = 2 * 1024 * 1024;
const SNAPSHOT_CAP: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchFile {
    pub path: String,
    pub before: Option<String>,
    pub initial: Option<String>,
    pub after: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchSnapshot {
    pub run_id: String,
    pub project_root: String,
    pub files: Vec<WatchFile>,
}

pub(crate) fn review_dir() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定配置目录")?
        .join("ccode/watch-reviews"))
}

fn snapshot_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "无效的运行编号")?;
    Ok(dir.join(format!("{id}.json")))
}

// 只允许契约内的路径；即使父目录是 symlink 也不能越出给定根。
fn checked_path(root: &Path, rel: &str, patterns: &[String]) -> Result<PathBuf, String> {
    if !crate::scheduler::watch_pattern_allows(patterns, rel) {
        return Err(format!("不允许采纳此路径：{rel}"));
    }
    let root = crate::paths::canonicalize_plain(root).map_err(|e| format!("目录不可用：{e}"))?;
    let target = root.join(rel);
    let mut probe = target.as_path();
    loop {
        match fs::symlink_metadata(probe) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(format!("产物路径不允许符号链接：{rel}"));
                }
                let actual = crate::paths::canonicalize_plain(probe).map_err(|e| e.to_string())?;
                if !crate::paths::path_within_path(&actual, &root) {
                    return Err(format!("产物路径超出项目：{rel}"));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("检查产物路径失败：{e}")),
        }
        if probe == root {
            break;
        }
        probe = probe.parent().ok_or("产物路径无效")?;
    }
    Ok(target)
}

fn read_text(root: &Path, rel: &str, patterns: &[String]) -> Result<Option<String>, String> {
    let path = checked_path(root, rel, patterns)?;
    match fs::metadata(&path) {
        Ok(meta) if !meta.is_file() => return Err(format!("产物不是普通文件：{rel}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读取 {rel} 失败：{e}")),
        _ => {}
    }
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读取 {rel} 失败：{e}")),
    };
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err(format!("产物不是普通文件：{rel}"));
    }
    let mut bytes = Vec::new();
    file.take(FILE_CAP + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > FILE_CAP {
        return Err(format!("{rel} 超过 2 MB，不能自动采纳"));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| format!("{rel} 不是 UTF-8 文本"))
}

/// 把采纳契约展开成具体文件清单：字面路径 + 目录模式（尾 /）下两侧根的现有文本文件。
/// 只收 ≤2MB 的 UTF-8 文本（冻结证据是文本比对模型；二进制产物不自动采纳）；
/// 最多 200 个，防技能把契约写成巨目录。
fn expand_contract(
    project: &Path,
    isolation: &Path,
    patterns: &[String],
) -> Result<Vec<String>, String> {
    const EXPAND_CAP: usize = 200;
    let mut out: Vec<String> = Vec::new();
    for pattern in patterns {
        if !pattern.ends_with('/') {
            out.push(pattern.clone());
        }
    }
    for pattern in patterns.iter().filter(|p| p.ends_with('/')) {
        let prefix = pattern.trim_end_matches('/');
        for root in [project, isolation] {
            let base = root.join(prefix);
            if !base.is_dir() {
                continue;
            }
            let mut stack = vec![base];
            while let Some(dir) = stack.pop() {
                let entries = fs::read_dir(&dir)
                    .map_err(|e| format!("读取契约目录失败：{e}"))?
                    .flatten();
                for entry in entries {
                    let path = entry.path();
                    let Ok(meta) = fs::symlink_metadata(&path) else {
                        continue;
                    };
                    if meta.file_type().is_symlink() {
                        continue;
                    }
                    if meta.is_dir() {
                        stack.push(path);
                        continue;
                    }
                    if !meta.is_file() || meta.len() > FILE_CAP {
                        continue;
                    }
                    // 只收 UTF-8 文本；二进制产物留在隔离目录，不进自动采纳
                    let Ok(bytes) = fs::read(&path) else {
                        continue;
                    };
                    if std::str::from_utf8(&bytes).is_err() {
                        continue;
                    }
                    let Ok(rel) = path.strip_prefix(root) else {
                        continue;
                    };
                    let rel = rel.to_string_lossy().replace('\\', "/");
                    if !rel.is_empty() && !rel.contains("..") {
                        out.push(rel);
                    }
                }
            }
        }
    }
    out.sort();
    out.dedup();
    if out.len() > EXPAND_CAP {
        return Err(format!(
            "产物契约展开超过 {EXPAND_CAP} 个文件，不能自动采纳"
        ));
    }
    Ok(out)
}

pub(crate) fn prepare(
    run_id: &str,
    project: &Path,
    isolation: &Path,
    patterns: &[String],
) -> Result<WatchSnapshot, String> {
    let mut files = Vec::new();
    for rel in expand_contract(project, isolation, patterns)? {
        files.push(WatchFile {
            path: rel.clone(),
            before: read_text(project, &rel, patterns)?,
            initial: read_text(isolation, &rel, patterns)?,
            after: None,
        });
    }
    Ok(WatchSnapshot {
        run_id: run_id.into(),
        project_root: project.to_string_lossy().into_owned(),
        files,
    })
}

// 失败不先删目标；新文件从创建起即 0600。只在同目录 rename，保留已有权限。
fn replace_text(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("目标没有父目录")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".ccode-review-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        if let Ok(meta) = fs::metadata(path) {
            fs::set_permissions(&tmp, meta.permissions()).map_err(|e| e.to_string())?;
        }
        drop(file);
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub(crate) fn freeze_at(
    dir: &Path,
    mut snapshot: WatchSnapshot,
    isolation: &Path,
    patterns: &[String],
) -> Result<(), String> {
    // 收尾时再展开一次契约：运行期间新出现的契约文件（新产出）并入证据，before/initial 记 None
    let wanted = expand_contract(Path::new(&snapshot.project_root), isolation, patterns)?;
    for rel in wanted {
        if !snapshot.files.iter().any(|file| file.path == rel) {
            snapshot.files.push(WatchFile {
                path: rel,
                before: None,
                initial: None,
                after: None,
            });
        }
    }
    for file in &mut snapshot.files {
        file.after = read_text(isolation, &file.path, patterns)?;
    }
    let _lock = adopt_lock(dir)?;
    let path = snapshot_path(dir, &snapshot.run_id)?;
    if path.exists() {
        return Err("本次运行已有冻结证据，拒绝改写".into());
    }
    let bytes = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > SNAPSHOT_CAP {
        return Err("产物证据超过安全容量上限".into());
    }
    replace_text(&path, &bytes)
}

pub(crate) fn load_at(dir: &Path, id: &str) -> Result<WatchSnapshot, String> {
    let path = snapshot_path(dir, id)?;
    let file = fs::File::open(path).map_err(|_| "本次运行没有冻结产物证据（旧记录或运行未成功完成），不能自动采纳；请检查工作目录并手动合并".to_string())?;
    let mut bytes = Vec::new();
    file.take(SNAPSHOT_CAP + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > SNAPSHOT_CAP {
        return Err("产物证据过大".into());
    }
    let snapshot: WatchSnapshot =
        serde_json::from_slice(&bytes).map_err(|e| format!("产物证据损坏：{e}"))?;
    if snapshot.run_id != id {
        return Err("产物证据与运行编号不一致".into());
    }
    // 结构校验：路径非空、形态合法、不重复（契约清单本身随技能变化，不作固定数量校验）
    if snapshot.files.is_empty() {
        return Err("产物证据清单为空".into());
    }
    let mut seen = std::collections::HashSet::new();
    for file in &snapshot.files {
        if !crate::scheduler::watch_rel_ok(&file.path) {
            return Err(format!("产物证据路径不合法：{}", file.path));
        }
        if !seen.insert(&file.path) {
            return Err(format!("产物证据路径重复：{}", file.path));
        }
    }
    Ok(snapshot)
}

/// 对 Mesa 采纳操作跨进程互斥；外部编辑器仍使用内容基线乐观检查。
/// 删除某次运行的冻结证据（历史删除用）。run_id 先过 uuid 校验；文件不存在视为已删。
pub(crate) fn delete_snapshot_at(dir: &Path, run_id: &str) -> Result<(), String> {
    let path = snapshot_path(dir, run_id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除冻结证据失败：{e}"))?;
    }
    Ok(())
}

fn adopt_lock(dir: &Path) -> Result<fs::File, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("adopt.lock"))
        .map_err(|e| e.to_string())?;
    file.try_lock()
        .map_err(|_| "另一个采纳操作正在执行，请稍后重试")?;
    Ok(file)
}

pub(crate) fn adopt_at(
    dir: &Path,
    snapshot: &WatchSnapshot,
    project: &Path,
    protected: &[String],
    patterns: &[String],
) -> Result<Vec<String>, String> {
    adopt_with_writer(dir, snapshot, project, protected, patterns, replace_text)
}

fn adopt_with_writer(
    dir: &Path,
    snapshot: &WatchSnapshot,
    project: &Path,
    protected: &[String],
    patterns: &[String],
    mut write: impl FnMut(&Path, &[u8]) -> Result<(), String>,
) -> Result<Vec<String>, String> {
    let _lock = adopt_lock(dir)?;
    let mut pending = Vec::new();
    for file in &snapshot.files {
        if file.initial == file.after {
            continue;
        }
        // 契约再校验：快照是写入时刻的清单，采纳时按当下契约再过一遍
        checked_path(project, &file.path, patterns)?;
        // 与 runs.rs 验收写回同一判定（含大小写折叠）：保护 NOTES/ 时 notes/ 下写回也要拦
        if crate::projects::path_is_protected(&file.path, protected) {
            return Err(format!("保护路径不可覆盖：{}", file.path));
        }
        let current = read_text(project, &file.path, patterns)?;
        if current == file.after {
            continue;
        }
        if file.after.is_none() {
            return Err(format!(
                "{} 在任务中被删除；请手动确认删除，不自动采纳",
                file.path
            ));
        }
        if current != file.before || file.initial != file.before {
            return Err(format!(
                "{} 与任务起始版本冲突，未写入任何文件；请对比冻结证据后手动合并",
                file.path
            ));
        }
        pending.push(file);
    }
    if pending.is_empty() {
        return Ok(Vec::new());
    }
    let backup = dir
        .join("backups")
        .join(&snapshot.run_id)
        .join(uuid::Uuid::new_v4().to_string());
    // 写任何项目文件前，持久化整批恢复材料（None 代表原文件不存在）。
    replace_text(
        &backup.join("before.json"),
        &serde_json::to_vec(&pending).map_err(|e| e.to_string())?,
    )?;
    let mut written: Vec<&WatchFile> = Vec::new();
    for file in pending {
        let result = (|| {
            if read_text(project, &file.path, patterns)? != file.before {
                return Err(format!("{} 在采纳期间变化", file.path));
            }
            let target = checked_path(project, &file.path, patterns)?;
            write(&target, file.after.as_deref().unwrap().as_bytes())
        })();
        if let Err(error) = result {
            let mut rollback_errors = Vec::new();
            for old in written.iter().rev() {
                let rollback = (|| {
                    if read_text(project, &old.path, patterns)? != old.after {
                        return Err("文件再次被外部修改，未强制回滚".to_string());
                    }
                    let target = checked_path(project, &old.path, patterns)?;
                    match &old.before {
                        Some(text) => replace_text(&target, text.as_bytes()),
                        None => fs::remove_file(target).map_err(|e| e.to_string()),
                    }
                })();
                if let Err(e) = rollback {
                    rollback_errors.push(format!("{}: {e}", old.path));
                }
            }
            return Err(format!(
                "采纳失败：{error}。已尝试回滚；恢复备份：{}。{}",
                backup.display(),
                rollback_errors.join("；")
            ));
        }
        written.push(file);
    }
    Ok(written.iter().map(|f| f.path.clone()).collect())
}

/// 这次巡检的命中，带期刊指标。评审按篇纳入或排除，不看原文对照。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchReviewEntry {
    pub id: String,
    pub title: String,
    pub authors: String,
    pub journal: String,
    /// 发表日期（来源行第二段）；旧条目缺段为 None
    pub pub_date: Option<String>,
    pub url: String,
    pub relevance: String,
    pub zh_summary: String,
    pub impact_factor: Option<String>,
    pub cas_quartile: Option<u8>,
    pub top: bool,
    /// included / excluded / ""（还没定）
    pub decision: String,
}

fn watch_decision_path(root: &Path) -> PathBuf {
    root.join(".ccode").join("watch-review.json")
}

fn read_watch_decisions(root: &Path) -> std::collections::HashMap<String, String> {
    let Ok(text) = fs::read_to_string(watch_decision_path(root)) else {
        return std::collections::HashMap::new();
    };
    parse_watch_decisions(&text).unwrap_or_default()
}

/// 决定文件解析失败要与「文件还不存在」区分：展示可以容错当空，
/// 但写入前必须发现损坏，否则一次写入就把其余决定全部抹掉。
fn parse_watch_decisions(text: &str) -> Option<std::collections::HashMap<String, String>> {
    if text.trim().is_empty() {
        return Some(std::collections::HashMap::new());
    }
    serde_json::from_str(text).ok()
}

/// 采纳用：这次巡检评审里被「排除」的条目 id 集。
pub(crate) fn excluded_entry_ids(root: &Path) -> Vec<String> {
    read_watch_decisions(root)
        .into_iter()
        .filter(|(_, decision)| decision == "excluded")
        .map(|(id, _)| id)
        .collect()
}

/// 采纳前把被「排除」的条目从冻结的 notes/inbox.md 结果文本里整段剔除。
/// initial/before 基线不动：冲突判定仍以整文件基线为准，只是写进主仓的内容少了被排除的行。
pub(crate) fn drop_excluded_from_snapshot(snapshot: &mut WatchSnapshot, excluded: &[String]) {
    if excluded.is_empty() {
        return;
    }
    let ids: std::collections::HashSet<&str> = excluded.iter().map(String::as_str).collect();
    for file in &mut snapshot.files {
        if file.path != "notes/inbox.md" {
            continue;
        }
        let Some(text) = file.after.as_deref() else {
            continue;
        };
        file.after = Some(crate::lit_watch::drop_inbox_entries(text, &ids));
    }
}

fn write_watch_decision(root: &Path, id: &str, decision: &str) -> Result<(), String> {
    let path = watch_decision_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建评审目录失败：{e}"))?;
    }
    if let Ok(text) = fs::read_to_string(&path) {
        if parse_watch_decisions(&text).is_none() {
            return Err(format!(
                "决定文件 .ccode/watch-review.json 已损坏，为避免覆盖其余决定未写入；请手动修复或删除该文件后重试"
            ));
        }
    }
    let mut map = read_watch_decisions(root);
    if decision.is_empty() {
        map.remove(id);
    } else {
        map.insert(id.to_string(), decision.to_string());
    }
    let text = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(&path, &text)
}

fn watch_isolation_of(run_id: &str) -> Result<(crate::runs::RunDto, PathBuf), String> {
    let run = crate::runs::run_get(run_id.to_string())?.ok_or("运行记录不存在")?;
    if run.task_kind != "watch" {
        return Err("不是定时任务".into());
    }
    let path = PathBuf::from(&run.isolation_path);
    if !path.is_dir() {
        return Err("这次巡检的隔离目录已经不在了".into());
    }
    Ok((run, path))
}

/// 这次运行的新命中 = 冻结结果里减去运行开始前隔离目录里已有的条目。
/// 收件箱在按日程复用的隔离目录里只增不改，不扣旧条目的话每次评审
/// 都会把以前各次巡检留下的命中再从头列一遍。
pub(crate) fn new_hits_of(snapshot: &WatchSnapshot) -> Vec<crate::lit_watch::WatchEntryDto> {
    let file = snapshot
        .files
        .iter()
        .find(|file| file.path == "notes/inbox.md");
    let after = file.and_then(|file| file.after.as_deref()).unwrap_or("");
    let initial = file.and_then(|file| file.initial.as_deref()).unwrap_or("");
    let seen: std::collections::HashSet<String> = crate::lit_watch::watch_inbox_from_text(initial)
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    crate::lit_watch::watch_inbox_from_text(after)
        .into_iter()
        .filter(|entry| !seen.contains(&entry.id))
        .collect()
}

#[tauri::command]
pub async fn watch_run_entries(run_id: String) -> Result<Vec<WatchReviewEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_run, root) = watch_isolation_of(&run_id)?;
        // 命中只来自这次运行冻结的证据，且只列这次新出现的；隔离目录是任务共用的，
        // 没跑成的记录不能把以前留下的 29 篇再列出来。
        let snapshot = load_at(&review_dir()?, &run_id)?;
        let decisions = read_watch_decisions(&root);
        let entries = new_hits_of(&snapshot);
        Ok(entries
            .into_iter()
            .map(|entry| WatchReviewEntry {
                pub_date: entry.pub_date,
                decision: decisions.get(&entry.id).cloned().unwrap_or_default(),
                impact_factor: entry.metrics.as_ref().and_then(|m| m.impact_factor.clone()),
                cas_quartile: entry.metrics.as_ref().and_then(|m| m.cas_quartile),
                top: entry.metrics.as_ref().is_some_and(|m| m.top),
                journal: entry.journal.unwrap_or(entry.source),
                id: entry.id,
                title: entry.title,
                authors: entry.authors,
                url: entry.url,
                relevance: entry.relevance,
                zh_summary: entry.zh_summary,
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 留下或排除只记在这次巡检的 `.ccode/watch-review.json`。
/// 不写 included.json / included.md，也不进检索和精读那一套 RIS；
/// 采纳时被「排除」的条目不会写进主仓收件箱（见 adopt_watch_run 的过滤）。
#[tauri::command]
pub async fn watch_run_decide(
    run_id: String,
    entry_id: String,
    decision: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if decision != "included" && decision != "excluded" && !decision.is_empty() {
            return Err("决定只能是纳入、排除或撤销".into());
        }
        let (_run, root) = watch_isolation_of(&run_id)?;
        // 后端闸门：已采纳的运行决定已定稿，前端 locked 只是隐藏按钮
        if crate::scheduler::run_marked_adopted(&run_id) {
            return Err("这次运行已经采纳，当时的留下/排除不能再改".into());
        }
        // 校验对冻结证据做，不对隔离目录的实时收件箱做：工作目录重建或后续
        // 运行改写后，实时文件对不上不代表这次巡检里没有这篇。
        let snapshot = load_at(&review_dir()?, &run_id)?;
        let entries = new_hits_of(&snapshot);
        if !entries.iter().any(|item| item.id == entry_id) {
            return Err("这篇不在这次巡检的新命中里".into());
        }
        write_watch_decision(&root, &entry_id, &decision)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn watch_run_snapshot(run_id: String) -> Result<WatchSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let run = crate::runs::run_get(run_id.clone())?.ok_or("运行记录不存在")?;
        if run.task_kind != "watch" {
            return Err("不是定时任务".into());
        }
        let mut snapshot = load_at(&review_dir()?, &run_id)?;
        for file in &mut snapshot.files {
            file.before = file
                .before
                .take()
                .map(|s| crate::sessions::redact_sensitive_text(&s));
            file.initial = file
                .initial
                .take()
                .map(|s| crate::sessions::redact_sensitive_text(&s));
            file.after = file
                .after
                .take()
                .map(|s| crate::sessions::redact_sensitive_text(&s));
        }
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_patterns() -> Vec<String> {
        crate::scheduler::watch_adopt_patterns_for("lit-watch")
    }
    struct Fixture {
        root: PathBuf,
        project: PathBuf,
        isolation: PathBuf,
        reviews: PathBuf,
        id: String,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("ccode-watch-review-{}", uuid::Uuid::new_v4()));
            let project = root.join("project");
            let isolation = root.join("isolation");
            let reviews = root.join("reviews");
            for dir in [&project, &isolation] {
                fs::create_dir_all(dir.join("notes")).unwrap();
                fs::write(dir.join("notes/inbox.md"), "original").unwrap();
            }
            Self {
                root,
                project,
                isolation,
                reviews,
                id: uuid::Uuid::new_v4().to_string(),
            }
        }
        fn freeze(&self) -> WatchSnapshot {
            let evidence =
                prepare(&self.id, &self.project, &self.isolation, &base_patterns()).unwrap();
            fs::write(self.isolation.join("notes/inbox.md"), "result").unwrap();
            freeze_at(&self.reviews, evidence, &self.isolation, &base_patterns()).unwrap();
            load_at(&self.reviews, &self.id).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn new_hits_of_lists_only_entries_added_this_run() {
        // 隔离收件箱按日程累积复用：评审只该列出这次新出现的，旧命中不再刷屏
        let f = Fixture::new();
        let old_text = "<!-- watch-run: 2026-10-12 -->\n\n## 旧命中\n- 来源：arxiv — 2026-10-11 — https://arxiv.org/abs/2610.00001\n- 相关性：相关\n";
        fs::write(f.isolation.join("notes/inbox.md"), old_text).unwrap();
        let evidence = prepare(&f.id, &f.project, &f.isolation, &base_patterns()).unwrap();
        let new_text = format!(
            "{old_text}\n<!-- watch-run: 2026-10-13 -->\n\n## 新命中\n- 来源：期刊 — 2026-10-12 — 10.1/new\n- 相关性：推荐\n"
        );
        fs::write(f.isolation.join("notes/inbox.md"), new_text).unwrap();
        freeze_at(&f.reviews, evidence, &f.isolation, &base_patterns()).unwrap();
        let snapshot = load_at(&f.reviews, &f.id).unwrap();
        let hits = new_hits_of(&snapshot);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "新命中");
    }

    #[test]
    fn excluded_entries_are_dropped_before_adopt_writes_project() {
        let f = Fixture::new();
        let initial = "<!-- watch-run: 2026-10-12 -->\n\n## 保留旧条目\n- 来源：期刊 — 2026-10-11 — 10.1/old\n- 相关性：相关\n";
        // 隔离目录从主仓播种：两边起始一致，才满足采纳的 initial==before 基线
        fs::write(f.project.join("notes/inbox.md"), initial).unwrap();
        fs::write(f.isolation.join("notes/inbox.md"), initial).unwrap();
        let evidence = prepare(&f.id, &f.project, &f.isolation, &base_patterns()).unwrap();
        let after = format!(
            "{initial}\n<!-- watch-run: 2026-10-13 -->\n\n## 新排除条目\n- 来源：期刊 — 2026-10-12 — 10.1/x\n- 相关性：推荐\n\n## 新保留条目\n- 来源：期刊 — 2026-10-12 — 10.1/y\n- 相关性：相关\n"
        );
        fs::write(f.isolation.join("notes/inbox.md"), &after).unwrap();
        freeze_at(&f.reviews, evidence, &f.isolation, &base_patterns()).unwrap();
        // 评审里把「新排除条目」排除掉
        let excluded_id = crate::lit_watch::watch_inbox_from_text(&after)
            .into_iter()
            .find(|entry| entry.title == "新排除条目")
            .unwrap()
            .id;
        let mut snapshot = load_at(&f.reviews, &f.id).unwrap();
        drop_excluded_from_snapshot(&mut snapshot, &[excluded_id]);
        let filtered = snapshot
            .files
            .iter()
            .find(|file| file.path == "notes/inbox.md")
            .unwrap()
            .after
            .clone()
            .unwrap();
        assert!(!filtered.contains("新排除条目"));
        assert!(filtered.contains("新保留条目"));
        // 采纳写进主仓的就是过滤后的文本：排除的条目不进项目
        adopt_at(&f.reviews, &snapshot, &f.project, &[], &base_patterns()).unwrap();
        let written = fs::read_to_string(f.project.join("notes/inbox.md")).unwrap();
        assert_eq!(written, filtered);
        assert!(!written.contains("新排除条目"));
    }

    #[test]
    fn delete_snapshot_removes_only_named_evidence() {
        let f = Fixture::new();
        let reviews = f.reviews.clone();
        let id = f.id.clone();
        // 没有冻结证据：视为已删，不报错
        assert!(delete_snapshot_at(&reviews, &id).is_ok());
        f.freeze();
        assert!(reviews.join(format!("{id}.json")).exists());
        assert!(delete_snapshot_at(&reviews, &id).is_ok());
        assert!(!reviews.join(format!("{id}.json")).exists());
        // 非 uuid 的运行编号拒绝（防路径拼接注入）
        assert!(delete_snapshot_at(&reviews, "../evil").is_err());
    }

    #[test]
    fn write_watch_decision_refuses_to_overwrite_corrupt_file() {
        let f = Fixture::new();
        let path = f.isolation.join(".ccode/watch-review.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{broken").unwrap();
        assert!(write_watch_decision(&f.isolation, "w-1", "excluded").is_err());
        // 损坏文件原样保留，不能被一次写入顺手表掉其余决定
        assert_eq!(fs::read_to_string(&path).unwrap(), "{broken");
    }

    #[test]
    fn frozen_evidence_does_not_follow_reused_directory() {
        let f = Fixture::new();
        let snapshot = f.freeze();
        fs::write(f.isolation.join("notes/inbox.md"), "next run").unwrap();
        let loaded = load_at(&f.reviews, &f.id).unwrap();
        assert_eq!(
            loaded
                .files
                .iter()
                .find(|x| x.path == "notes/inbox.md")
                .unwrap()
                .after
                .as_deref(),
            Some("result")
        );
        let paths = adopt_at(&f.reviews, &snapshot, &f.project, &[], &base_patterns()).unwrap();
        assert_eq!(paths, vec!["notes/inbox.md"]);
        assert_eq!(
            fs::read_to_string(f.project.join("notes/inbox.md")).unwrap(),
            "result"
        );
        assert!(
            adopt_at(&f.reviews, &snapshot, &f.project, &[], &base_patterns())
                .unwrap()
                .is_empty()
        );
        assert!(freeze_at(&f.reviews, snapshot, &f.isolation, &base_patterns()).is_err());
        assert!(f.reviews.join("backups").join(&f.id).is_dir());
    }

    #[test]
    fn project_change_conflicts_without_overwrite() {
        let f = Fixture::new();
        let snapshot = f.freeze();
        fs::write(f.project.join("notes/inbox.md"), "human edits").unwrap();
        assert!(
            adopt_at(&f.reviews, &snapshot, &f.project, &[], &base_patterns())
                .unwrap_err()
                .contains("冲突")
        );
        assert_eq!(
            fs::read_to_string(f.project.join("notes/inbox.md")).unwrap(),
            "human edits"
        );
    }

    #[test]
    fn stale_isolation_cannot_erase_changes_already_present_at_start() {
        let f = Fixture::new();
        fs::write(f.project.join("notes/inbox.md"), "main newer").unwrap();
        let snapshot = f.freeze();
        assert!(
            adopt_at(&f.reviews, &snapshot, &f.project, &[], &base_patterns())
                .unwrap_err()
                .contains("冲突")
        );
        assert_eq!(
            fs::read_to_string(f.project.join("notes/inbox.md")).unwrap(),
            "main newer"
        );
    }

    #[test]
    fn contract_dir_pattern_carries_new_text_outputs() {
        let f = Fixture::new();
        // 契约 = 四类台账 + results/ 目录（技能声明的产出）
        let mut patterns = base_patterns();
        patterns.push("results/".to_string());
        let evidence = prepare(&f.id, &f.project, &f.isolation, &patterns).unwrap();
        fs::create_dir_all(f.isolation.join("results")).unwrap();
        fs::write(f.isolation.join("results/summary.md"), "r").unwrap();
        freeze_at(&f.reviews, evidence, &f.isolation, &patterns).unwrap();
        let snapshot = load_at(&f.reviews, &f.id).unwrap();
        assert!(snapshot
            .files
            .iter()
            .any(|file| file.path == "results/summary.md"));
        let copied = adopt_at(&f.reviews, &snapshot, &f.project, &[], &patterns).unwrap();
        assert!(copied.contains(&"results/summary.md".to_string()));
        assert_eq!(
            fs::read_to_string(f.project.join("results/summary.md")).unwrap(),
            "r"
        );
        // 契约外路径仍拒绝（快照里混入契约外文件 = 采纳直接失败）
        let mut bad = load_at(&f.reviews, &f.id).unwrap();
        bad.files.push(WatchFile {
            path: "evil.md".into(),
            before: None,
            initial: None,
            after: Some("x".into()),
        });
        assert!(adopt_at(&f.reviews, &bad, &f.project, &[], &patterns).is_err());
    }

    #[test]
    fn validates_all_files_before_writing_and_honors_protected_paths() {
        let f = Fixture::new();
        let mut snapshot = f.freeze();
        snapshot
            .files
            .iter_mut()
            .find(|x| x.path == "notes/references.bib")
            .unwrap()
            .after = Some("refs".into());
        assert!(adopt_at(
            &f.reviews,
            &snapshot,
            &f.project,
            &["notes/references.bib".into()],
            &base_patterns()
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(f.project.join("notes/inbox.md")).unwrap(),
            "original"
        );
        assert!(!f.project.join("notes/references.bib").exists());
    }

    #[test]
    fn protected_paths_match_case_insensitively_on_adopt() {
        // 保护「NOTES」时，APFS/NTFS 上 notes/ 是同一目录，写回必须拦
        //（与 projects::path_is_protected 的 path_key_folded 同一口径）
        let f = Fixture::new();
        let mut snapshot = f.freeze();
        snapshot
            .files
            .iter_mut()
            .find(|x| x.path == "notes/references.bib")
            .unwrap()
            .after = Some("refs".into());
        assert!(adopt_at(
            &f.reviews,
            &snapshot,
            &f.project,
            &["NOTES".into()],
            &base_patterns()
        )
        .is_err());
        assert!(!f.project.join("notes/references.bib").exists());
    }

    #[test]
    fn refuses_deleted_outputs_and_missing_snapshot() {
        let f = Fixture::new();
        assert!(load_at(&f.reviews, &f.id).unwrap_err().contains("没有冻结"));
        let evidence = prepare(&f.id, &f.project, &f.isolation, &base_patterns()).unwrap();
        fs::remove_file(f.isolation.join("notes/inbox.md")).unwrap();
        freeze_at(&f.reviews, evidence, &f.isolation, &base_patterns()).unwrap();
        assert!(adopt_at(
            &f.reviews,
            &load_at(&f.reviews, &f.id).unwrap(),
            &f.project,
            &[],
            &base_patterns()
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(f.project.join("notes/inbox.md")).unwrap(),
            "original"
        );
        assert!(snapshot_path(&f.reviews, "../escape").is_err());
    }

    #[test]
    fn adoption_lock_excludes_second_writer_and_releases_on_drop() {
        let f = Fixture::new();
        let lock = adopt_lock(&f.reviews).unwrap();
        assert!(adopt_lock(&f.reviews).is_err());
        drop(lock);
        assert!(adopt_lock(&f.reviews).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn parent_symlink_cannot_escape_or_create_external_directories() {
        let f = Fixture::new();
        let snapshot = f.freeze();
        let outside = f.root.join("outside");
        fs::rename(f.project.join("notes"), &outside).unwrap();
        std::os::unix::fs::symlink(&outside, f.project.join("notes")).unwrap();
        assert!(adopt_at(&f.reviews, &snapshot, &f.project, &[], &base_patterns()).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("inbox.md")).unwrap(),
            "original"
        );
    }

    #[test]
    fn second_file_failure_rolls_back_first_and_keeps_backup() {
        let f = Fixture::new();
        let mut snapshot = f.freeze();
        snapshot
            .files
            .iter_mut()
            .find(|x| x.path == "notes/references.bib")
            .unwrap()
            .after = Some("refs".into());
        let mut writes = 0;
        let error = adopt_with_writer(
            &f.reviews,
            &snapshot,
            &f.project,
            &[],
            &base_patterns(),
            |path, bytes| {
                writes += 1;
                if writes == 2 {
                    return Err("模拟第二个文件写入失败".into());
                }
                replace_text(path, bytes)
            },
        )
        .unwrap_err();
        assert!(error.contains("已尝试回滚"));
        assert_eq!(
            fs::read_to_string(f.project.join("notes/inbox.md")).unwrap(),
            "original"
        );
        assert!(!f.project.join("notes/references.bib").exists());
        assert!(f.reviews.join("backups").join(&f.id).is_dir());
    }

    #[test]
    fn rollback_does_not_erase_new_external_change() {
        let f = Fixture::new();
        let mut snapshot = f.freeze();
        snapshot
            .files
            .iter_mut()
            .find(|x| x.path == "notes/references.bib")
            .unwrap()
            .after = Some("refs".into());
        let mut writes = 0;
        let error = adopt_with_writer(
            &f.reviews,
            &snapshot,
            &f.project,
            &[],
            &base_patterns(),
            |path, bytes| {
                writes += 1;
                if writes == 2 {
                    fs::write(f.project.join("notes/inbox.md"), "changed during adoption").unwrap();
                    return Err("模拟写入失败".into());
                }
                replace_text(path, bytes)
            },
        )
        .unwrap_err();
        assert!(error.contains("未强制回滚"));
        assert_eq!(
            fs::read_to_string(f.project.join("notes/inbox.md")).unwrap(),
            "changed during adoption"
        );
    }

    #[test]
    fn rejects_oversize_and_non_utf8_artifacts() {
        let f = Fixture::new();
        let path = f.project.join("notes/inbox.md");
        fs::write(&path, vec![b'x'; FILE_CAP as usize + 1]).unwrap();
        assert!(prepare(&f.id, &f.project, &f.isolation, &base_patterns())
            .unwrap_err()
            .contains("2 MB"));
        fs::write(&path, [0xff]).unwrap();
        assert!(prepare(&f.id, &f.project, &f.isolation, &base_patterns())
            .unwrap_err()
            .contains("UTF-8"));
    }
}
