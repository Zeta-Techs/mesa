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
    /// 隔离 papers/ 顶层 PDF 文件名：开跑前与收尾时各记一次，采纳只拷本轮新出现的那几篇
    /// （2026-10-17 审查修复）。旧证据没有这两栏（None）时回落「主仓没有的都拷」。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdfs_initial: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdfs_after: Option<Vec<String>>,
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
    // 流程正典与 Mesa 内部路径永不进雷达采纳契约（技能目录模式展开出来的也剔掉）
    out.retain(|rel| !crate::scheduler::watch_path_denied(rel));
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
        pdfs_initial: Some(isolation_pdfs(isolation)),
        pdfs_after: None,
    })
}

/// 隔离 papers/ 顶层的 PDF 文件名（普通文件，不跟符号链接），排序后返回。
fn isolation_pdfs(isolation: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(isolation.join("papers")) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| {
            fs::symlink_metadata(entry.path())
                .map(|m| m.is_file())
                .unwrap_or(false)
        })
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|name| name.to_ascii_lowercase().ends_with(".pdf"))
        .collect();
    names.sort();
    names
}

/// 本轮新下的 PDF（收尾有、开跑前没有的文件名）。旧证据没记录返回 None。
pub(crate) fn new_pdfs_of(snapshot: &WatchSnapshot) -> Option<Vec<String>> {
    let (Some(initial), Some(after)) = (&snapshot.pdfs_initial, &snapshot.pdfs_after) else {
        return None;
    };
    let had: std::collections::HashSet<&String> = initial.iter().collect();
    Some(after.iter().filter(|name| !had.contains(name)).cloned().collect())
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

/// 冻结本次证据，返回这轮改了几处（契约内文本有变化的文件数 + 新下的 PDF 数）；
/// 0 = 没有可采纳的新内容（定时任务据此记「无新内容」，不弹通知不进待处理）
pub(crate) fn freeze_at(
    dir: &Path,
    mut snapshot: WatchSnapshot,
    isolation: &Path,
    patterns: &[String],
) -> Result<usize, String> {
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
    snapshot.pdfs_after = Some(isolation_pdfs(isolation));
    let _lock = adopt_lock(dir)?;
    let path = snapshot_path(dir, &snapshot.run_id)?;
    if path.exists() {
        return Err("本次运行已有冻结证据，拒绝改写".into());
    }
    let bytes = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > SNAPSHOT_CAP {
        return Err("产物证据超过安全容量上限".into());
    }
    replace_text(&path, &bytes)?;
    Ok(changed_count(&snapshot))
}

/// 这轮改了几处：after 与 initial 不同的契约文件 + 本轮新下的 PDF
fn changed_count(snapshot: &WatchSnapshot) -> usize {
    let files = snapshot
        .files
        .iter()
        .filter(|file| file.after != file.initial)
        .count();
    files + new_pdfs_of(snapshot).map_or(0, |pdfs| pdfs.len())
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
    // 短暂重试：同进程别处 fork 子进程时，子进程在 exec 前会短暂持有这份锁的描述符，
    // 前一次采纳刚释放就立刻再采纳（连着采纳两轮）会被这个窗口误判成「正在执行」
    for _ in 0..20 {
        if file.try_lock().is_ok() {
            return Ok(file);
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    file.try_lock()
        .map_err(|_| "另一个采纳操作正在执行，请稍后重试")?;
    Ok(file)
}

/// 采纳：把冻结证据写进主仓。`excluded` 是评审里「排除」的条目 id（只对本轮新命中生效）。
pub(crate) fn adopt_at(
    dir: &Path,
    snapshot: &WatchSnapshot,
    project: &Path,
    protected: &[String],
    patterns: &[String],
    excluded: &[String],
) -> Result<Vec<String>, String> {
    adopt_with_writer(dir, snapshot, project, protected, patterns, excluded, replace_text)
}

/// 主仓起始内容是否在隔离树起跑线里缺行（逐行子集，顺序无关，空行不算）。
/// 只用于台账以外的契约产出（自定义巡检技能声明的文件）：整文件写入会抹掉主仓领先的行，拦。
fn main_start_lost(before: &str, initial: &str) -> bool {
    let have: std::collections::HashSet<&str> = initial.lines().collect();
    before
        .lines()
        .filter(|l| !l.trim().is_empty())
        .any(|l| !have.contains(l))
}

/// 雷达台账：只增不改的积累文本。采纳按「主仓当前内容 + 本轮新增」追加合并，不整文件覆盖
/// （2026-10-17 审查修复）——主仓侧任何写入（另一条雷达的采纳、人手改删、补批次标记）都原样
/// 保留，隔离树只贡献本轮新写的条目；同一份证据重复采纳不会重复追加。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ledger {
    Inbox,
    Seen,
    Followup,
    Bib,
}

fn ledger_kind(path: &str) -> Option<Ledger> {
    match path {
        "notes/inbox.md" => Some(Ledger::Inbox),
        "papers/watch-seen.md" => Some(Ledger::Seen),
        "papers/watch-followup.md" => Some(Ledger::Followup),
        "notes/references.bib" => Some(Ledger::Bib),
        _ => None,
    }
}

/// 追加段接到主仓现有内容后面。blank = 段前空一行（条目类台账）；标识台账逐行紧接。
fn append_to(current: Option<&str>, delta: &str, blank: bool) -> String {
    let delta = delta.trim_matches('\n');
    match current {
        Some(cur) if !cur.trim().is_empty() => {
            let mut out = cur.to_string();
            if !out.ends_with('\n') {
                out.push('\n');
            }
            if blank && !out.ends_with("\n\n") {
                out.push('\n');
            }
            out.push_str(delta);
            out.push('\n');
            out
        }
        _ => format!("{delta}\n"),
    }
}

/// 已见台账：本轮新写、主仓与起跑线里都没有的标识行（逐行去重，空行不算）。
fn seen_delta(current: Option<&str>, initial: Option<&str>, after: &str) -> Option<String> {
    let mut have: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for text in [current, initial].into_iter().flatten() {
        have.extend(text.lines().map(str::trim));
    }
    let lines: Vec<&str> = after
        .lines()
        .filter(|l| !l.trim().is_empty() && have.insert(l.trim()))
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// BibTeX 条目切块：`@` 开头的行起一条，到下一条为止（文件头说明不算条目）。
fn bib_entries(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.trim_start().starts_with('@') {
            out.push(String::new());
        }
        if let Some(cur) = out.last_mut() {
            cur.push_str(line);
            cur.push('\n');
        }
    }
    out
}

fn bib_key(entry: &str) -> String {
    entry
        .split_once('{')
        .map(|(_, rest)| rest.split(',').next().unwrap_or("").trim().to_lowercase())
        .unwrap_or_default()
}

fn bib_title(entry: &str) -> String {
    for line in entry.lines() {
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("title") {
            return crate::lit_watch::normalize_title(value);
        }
    }
    String::new()
}

/// 引文：键不在主仓与起跑线里、标题也不是被排除条目的新条目。
fn bib_delta(
    current: Option<&str>,
    initial: Option<&str>,
    after: &str,
    drop_titles: &[String],
) -> Option<String> {
    let mut keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    for text in [current, initial].into_iter().flatten() {
        keys.extend(bib_entries(text).iter().map(|e| bib_key(e)));
    }
    let drop: std::collections::HashSet<String> = drop_titles
        .iter()
        .map(|t| crate::lit_watch::normalize_title(t))
        .filter(|t| !t.is_empty())
        .collect();
    let kept: Vec<String> = bib_entries(after)
        .into_iter()
        .filter(|entry| {
            let key = bib_key(entry);
            !key.is_empty() && !drop.contains(&bib_title(entry)) && keys.insert(key)
        })
        .collect();
    (!kept.is_empty()).then(|| kept.concat().trim_end().to_string())
}

/// 台账合并结果；None = 本轮没有可追加的新内容。
fn ledger_merge(
    kind: Ledger,
    current: Option<&str>,
    initial: Option<&str>,
    after: &str,
    drop_ids: &std::collections::HashSet<&str>,
    drop_titles: &[String],
) -> Option<String> {
    match kind {
        Ledger::Inbox => crate::lit_watch::inbox_append_delta(current, initial, after, drop_ids)
            .map(|delta| append_to(current, &delta, true)),
        Ledger::Seen => {
            seen_delta(current, initial, after).map(|delta| append_to(current, &delta, false))
        }
        Ledger::Followup => {
            crate::lit_watch::followup_append_delta(current, initial, after, drop_titles)
                .map(|delta| append_to(current, &delta, true))
        }
        Ledger::Bib => bib_delta(current, initial, after, drop_titles)
            .map(|delta| append_to(current, &delta, true)),
    }
}

/// 这次运行里被排除、且确实是本轮新命中的条目（id 集与标题）。决定文件是同一条雷达
/// 各轮共用的，旧轮的排除不得波及主仓里别处来的同 id 条目。
fn excluded_new_hits(
    snapshot: &WatchSnapshot,
    excluded: &[String],
) -> Vec<crate::lit_watch::WatchEntryDto> {
    if excluded.is_empty() {
        return Vec::new();
    }
    let wanted: std::collections::HashSet<&str> = excluded.iter().map(String::as_str).collect();
    new_hits_of(snapshot)
        .into_iter()
        .filter(|entry| wanted.contains(entry.id.as_str()))
        .collect()
}

/// 被排除新命中的标题：跟进清单、引文与免费全文按标题对上后同样不进项目。
pub(crate) fn excluded_titles_of(snapshot: &WatchSnapshot, excluded: &[String]) -> Vec<String> {
    excluded_new_hits(snapshot, excluded)
        .into_iter()
        .map(|entry| entry.title)
        .collect()
}

/// 一次写入：path 处应仍是 expect（读取时的主仓内容），写成 next。
#[derive(Serialize)]
struct PendingWrite {
    path: String,
    before: Option<String>,
    after: String,
}

fn adopt_with_writer(
    dir: &Path,
    snapshot: &WatchSnapshot,
    project: &Path,
    protected: &[String],
    patterns: &[String],
    excluded: &[String],
    mut write: impl FnMut(&Path, &[u8]) -> Result<(), String>,
) -> Result<Vec<String>, String> {
    let _lock = adopt_lock(dir)?;
    let drop_hits = excluded_new_hits(snapshot, excluded);
    let drop_ids: std::collections::HashSet<&str> =
        drop_hits.iter().map(|entry| entry.id.as_str()).collect();
    let drop_titles: Vec<String> = drop_hits.iter().map(|entry| entry.title.clone()).collect();
    let mut pending: Vec<PendingWrite> = Vec::new();
    for file in &snapshot.files {
        if file.initial == file.after {
            continue;
        }
        // 旧证据可能还带着整目录契约展开出的流程正典：永不采纳，跳过不报错
        if crate::scheduler::watch_path_denied(&file.path) {
            crate::logbuf::record(
                "warn",
                "watch_review",
                &format!("雷达改动了流程正典 {}，未采纳", file.path),
            );
            continue;
        }
        // 契约再校验：快照是写入时刻的清单，采纳时按当下契约再过一遍
        checked_path(project, &file.path, patterns)?;
        // 与 runs.rs 验收写回同一判定（含大小写折叠）：保护 NOTES/ 时 notes/ 下写回也要拦
        if crate::projects::path_is_protected(&file.path, protected) {
            return Err(format!("保护路径不可覆盖：{}", file.path));
        }
        let current = read_text(project, &file.path, patterns)?;
        let next = if let Some(kind) = ledger_kind(&file.path) {
            // 台账只追加：Agent 删掉台账不等于要删主仓的积累，本轮没有新内容就跳过
            let Some(after) = file.after.as_deref() else {
                continue;
            };
            match ledger_merge(
                kind,
                current.as_deref(),
                file.initial.as_deref(),
                after,
                &drop_ids,
                &drop_titles,
            ) {
                Some(next) => next,
                None => continue,
            }
        } else {
            if current == file.after {
                continue;
            }
            let Some(after) = file.after.as_deref() else {
                return Err(format!(
                    "{} 在任务中被删除；请手动确认删除，不自动采纳",
                    file.path
                ));
            };
            // 自定义巡检的契约产出仍整文件写入：主仓在运行/评审期间被改过，或主仓起始内容
            // 在隔离树起跑线里缺行（主仓领先），都会被整文件写入抹掉——拦。
            if current != file.before
                || main_start_lost(
                    file.before.as_deref().unwrap_or_default(),
                    file.initial.as_deref().unwrap_or_default(),
                )
            {
                return Err(format!(
                    "{} 与任务起始版本冲突，未写入任何文件；请对比冻结证据后手动合并",
                    file.path
                ));
            }
            after.to_string()
        };
        if current.as_deref() == Some(next.as_str()) {
            continue;
        }
        pending.push(PendingWrite {
            path: file.path.clone(),
            before: current,
            after: next,
        });
    }
    if pending.is_empty() {
        return Ok(Vec::new());
    }
    let backup = dir
        .join("backups")
        .join(&snapshot.run_id)
        .join(uuid::Uuid::new_v4().to_string());
    // 写任何项目文件前，持久化整批恢复材料（before 为 None 代表原文件不存在）。
    replace_text(
        &backup.join("before.json"),
        &serde_json::to_vec(&pending).map_err(|e| e.to_string())?,
    )?;
    let mut written: Vec<&PendingWrite> = Vec::new();
    for item in &pending {
        let result = (|| {
            if read_text(project, &item.path, patterns)? != item.before {
                return Err(format!("{} 在采纳期间变化", item.path));
            }
            let target = checked_path(project, &item.path, patterns)?;
            write(&target, item.after.as_bytes())
        })();
        if let Err(error) = result {
            let mut rollback_errors = Vec::new();
            for old in written.iter().rev() {
                let rollback = (|| {
                    if read_text(project, &old.path, patterns)?.as_deref()
                        != Some(old.after.as_str())
                    {
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
        written.push(item);
    }
    Ok(written.iter().map(|item| item.path.clone()).collect())
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

    /// 一条收件箱条目（批次标记另写）
    fn entry(title: &str, doi: &str) -> String {
        format!("## {title}\n- 来源：期刊 — 2026-10-12 — {doi}\n- 相关性：相关\n")
    }

    /// 主仓与隔离树的起始收件箱：一批旧命中
    fn base_inbox() -> String {
        format!("<!-- watch-run: 2026-10-12 -->\n\n{}", entry("旧条目", "10.1/old"))
    }

    /// 本轮在起始内容后追加一批新命中
    fn with_batch(start: &str, day: &str, entries: &[(&str, &str)]) -> String {
        let mut out = start.to_string();
        if !out.is_empty() && !out.ends_with("\n\n") {
            out.push('\n');
        }
        out.push_str(&format!("<!-- watch-run: {day} -->\n"));
        for (title, doi) in entries {
            out.push('\n');
            out.push_str(&entry(title, doi));
        }
        out
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
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
                fs::write(dir.join("notes/inbox.md"), base_inbox()).unwrap();
            }
            Self {
                root,
                project,
                isolation,
                reviews,
                id: uuid::Uuid::new_v4().to_string(),
            }
        }
        /// 跑一轮：开跑前取证据，隔离树写成 after，收尾冻结
        fn run_in(&self, isolation: &Path, id: &str, after: &str) -> WatchSnapshot {
            let evidence = prepare(id, &self.project, isolation, &base_patterns()).unwrap();
            fs::write(isolation.join("notes/inbox.md"), after).unwrap();
            freeze_at(&self.reviews, evidence, isolation, &base_patterns()).unwrap();
            load_at(&self.reviews, id).unwrap()
        }
        fn freeze(&self) -> WatchSnapshot {
            let after = with_batch(&base_inbox(), "2026-10-13", &[("新条目", "10.1/new")]);
            self.run_in(&self.isolation, &self.id, &after)
        }
        fn adopt(&self, snapshot: &WatchSnapshot) -> Result<Vec<String>, String> {
            adopt_at(&self.reviews, snapshot, &self.project, &[], &base_patterns(), &[])
        }
        fn main_inbox(&self) -> String {
            read(&self.project.join("notes/inbox.md"))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn titles(text: &str) -> Vec<String> {
        crate::lit_watch::watch_inbox_from_text(text)
            .into_iter()
            .map(|e| e.title)
            .collect()
    }

    #[test]
    fn new_hits_of_lists_only_entries_added_this_run() {
        // 评审只该列出这次新出现的，起跑线里的旧命中不再刷屏
        let f = Fixture::new();
        let snapshot = f.freeze();
        let hits = new_hits_of(&snapshot);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "新条目");
    }

    #[test]
    fn adopt_appends_new_batch_after_main_content() {
        let f = Fixture::new();
        let snapshot = f.freeze();
        assert_eq!(f.adopt(&snapshot).unwrap(), vec!["notes/inbox.md"]);
        // 主仓起始与隔离树一致时，追加结果与隔离树收尾内容逐字相同
        assert_eq!(
            f.main_inbox(),
            with_batch(&base_inbox(), "2026-10-13", &[("新条目", "10.1/new")])
        );
    }

    #[test]
    fn excluded_entries_are_left_out_on_adopt() {
        let f = Fixture::new();
        let after = with_batch(
            &base_inbox(),
            "2026-10-13",
            &[("新排除条目", "10.1/x"), ("新保留条目", "10.1/y")],
        );
        let snapshot = f.run_in(&f.isolation, &f.id, &after);
        let excluded_id = new_hits_of(&snapshot)
            .into_iter()
            .find(|entry| entry.title == "新排除条目")
            .unwrap()
            .id;
        adopt_at(
            &f.reviews,
            &snapshot,
            &f.project,
            &[],
            &base_patterns(),
            &[excluded_id],
        )
        .unwrap();
        let written = f.main_inbox();
        assert!(!written.contains("新排除条目"));
        assert!(written.contains("新保留条目"));
        assert_eq!(titles(&written), vec!["旧条目", "新保留条目"]);
    }

    #[test]
    fn exclusion_of_an_old_id_does_not_delete_main_entries() {
        // 决定文件按雷达各轮共用：旧轮排除过的 id 不得把主仓里（别处收进来的）条目删掉
        let f = Fixture::new();
        let snapshot = f.freeze();
        let old_id = crate::lit_watch::watch_inbox_from_text(&base_inbox())[0].id.clone();
        adopt_at(&f.reviews, &snapshot, &f.project, &[], &base_patterns(), &[old_id]).unwrap();
        assert_eq!(titles(&f.main_inbox()), vec!["旧条目", "新条目"]);
    }

    #[test]
    fn two_radars_in_one_project_keep_adopting() {
        // 2026-10-17 审查回归：同项目两条雷达，A、B 各采纳一次后 A 的隔离树缺 B 的行，
        // 旧口径整文件覆盖 + 缺行即冲突 → A 永久采纳不了
        let f = Fixture::new();
        let iso_b = f.root.join("isolation-b");
        fs::create_dir_all(iso_b.join("notes")).unwrap();
        fs::write(iso_b.join("notes/inbox.md"), base_inbox()).unwrap();
        // A 第一轮
        let a1 = f.run_in(
            &f.isolation,
            &f.id,
            &with_batch(&base_inbox(), "2026-10-13", &[("A一", "10.1/a1")]),
        );
        f.adopt(&a1).unwrap();
        // B 第一轮（隔离树起跑线没有 A 的命中）
        let b_id = uuid::Uuid::new_v4().to_string();
        let b1 = f.run_in(
            &iso_b,
            &b_id,
            &with_batch(&base_inbox(), "2026-10-13", &[("B一", "10.1/b1")]),
        );
        f.adopt(&b1).unwrap();
        // A 第二轮：隔离树停在自己的旧内容上（不含 B 一）
        let a_prev = read(&f.isolation.join("notes/inbox.md"));
        let a2_id = uuid::Uuid::new_v4().to_string();
        let a2 = f.run_in(
            &f.isolation,
            &a2_id,
            &with_batch(&a_prev, "2026-10-14", &[("A二", "10.1/a2")]),
        );
        f.adopt(&a2).unwrap();
        assert_eq!(titles(&f.main_inbox()), vec!["旧条目", "A一", "B一", "A二"]);
    }

    #[test]
    fn main_side_edits_survive_and_deleted_entries_stay_deleted() {
        let f = Fixture::new();
        let snapshot = f.freeze();
        // 运行/评审期间人在主仓删了旧条目、写了一段自己的摘录
        let edited = "# 我的收件箱\n\n## 摘录 · 第 3 页\n人写的段落\n";
        fs::write(f.project.join("notes/inbox.md"), edited).unwrap();
        f.adopt(&snapshot).unwrap();
        let written = f.main_inbox();
        assert!(written.starts_with(edited), "主仓内容一字不动");
        assert_eq!(titles(&written), vec!["新条目"], "删掉的旧条目不回灌");
    }

    #[test]
    fn same_paper_from_another_radar_is_not_added_twice() {
        let f = Fixture::new();
        let snapshot = f.freeze();
        // 另一条雷达已经把同一篇收进主仓（批次日期不同 → id 不同，按标题去重）
        let other = with_batch(&base_inbox(), "2026-10-14", &[("新条目", "10.1/new")]);
        fs::write(f.project.join("notes/inbox.md"), &other).unwrap();
        assert!(f.adopt(&snapshot).unwrap().is_empty());
        assert_eq!(f.main_inbox(), other);
    }

    #[test]
    fn older_run_is_still_adoptable_after_a_newer_one() {
        // 连着两轮没采纳：先采纳新的那轮，旧的那轮仍可采纳（旧口径必报冲突，留下「幽灵待采纳」）
        let f = Fixture::new();
        let first = f.freeze();
        let prev = read(&f.isolation.join("notes/inbox.md"));
        let second_id = uuid::Uuid::new_v4().to_string();
        let second = f.run_in(
            &f.isolation,
            &second_id,
            &with_batch(&prev, "2026-10-14", &[("第二轮", "10.1/second")]),
        );
        f.adopt(&second).unwrap();
        f.adopt(&first).unwrap();
        let got = titles(&f.main_inbox());
        assert!(got.contains(&"新条目".to_string()));
        assert!(got.contains(&"第二轮".to_string()));
        assert_eq!(got.len(), 3);
    }

    #[test]
    fn freeze_reports_how_many_contract_files_changed() {
        let f = Fixture::new();
        let evidence = prepare(&f.id, &f.project, &f.isolation, &base_patterns()).unwrap();
        // 什么都没改：0（定时任务据此记「无新内容」）
        assert_eq!(freeze_at(&f.reviews, evidence, &f.isolation, &base_patterns()).unwrap(), 0);
        let f = Fixture::new();
        let evidence = prepare(&f.id, &f.project, &f.isolation, &base_patterns()).unwrap();
        let inbox = f.isolation.join("notes/inbox.md");
        let mut text = fs::read_to_string(&inbox).unwrap();
        text.push_str("\n## 新的一条\n");
        fs::write(&inbox, text).unwrap();
        assert_eq!(freeze_at(&f.reviews, evidence, &f.isolation, &base_patterns()).unwrap(), 1);
    }

    #[test]
    fn ledger_deleted_in_task_adopts_nothing() {
        let f = Fixture::new();
        let evidence = prepare(&f.id, &f.project, &f.isolation, &base_patterns()).unwrap();
        fs::remove_file(f.isolation.join("notes/inbox.md")).unwrap();
        freeze_at(&f.reviews, evidence, &f.isolation, &base_patterns()).unwrap();
        let snapshot = load_at(&f.reviews, &f.id).unwrap();
        assert!(f.adopt(&snapshot).unwrap().is_empty());
        assert_eq!(f.main_inbox(), base_inbox());
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
        let frozen = loaded
            .files
            .iter()
            .find(|x| x.path == "notes/inbox.md")
            .unwrap()
            .after
            .clone()
            .unwrap();
        assert!(frozen.contains("新条目"));
        assert_eq!(f.adopt(&snapshot).unwrap(), vec!["notes/inbox.md"]);
        assert!(!f.main_inbox().contains("next run"));
        // 同一份证据再采纳：不重复追加
        assert!(f.adopt(&snapshot).unwrap().is_empty());
        assert!(freeze_at(&f.reviews, snapshot, &f.isolation, &base_patterns()).is_err());
        assert!(f.reviews.join("backups").join(&f.id).is_dir());
    }

    #[test]
    fn seen_followup_and_bib_merge_append_only_new_items() {
        let f = Fixture::new();
        fs::create_dir_all(f.project.join("papers")).unwrap();
        fs::create_dir_all(f.isolation.join("papers")).unwrap();
        fs::write(f.project.join("papers/watch-seen.md"), "10.1/old\n").unwrap();
        fs::write(f.isolation.join("papers/watch-seen.md"), "10.1/old\n").unwrap();
        fs::write(f.project.join("notes/references.bib"), "@article{old2026,\n  title = {Old},\n}\n").unwrap();
        fs::write(f.isolation.join("notes/references.bib"), "@article{old2026,\n  title = {Old},\n}\n").unwrap();
        let evidence = prepare(&f.id, &f.project, &f.isolation, &base_patterns()).unwrap();
        fs::write(
            f.isolation.join("notes/inbox.md"),
            with_batch(&base_inbox(), "2026-10-13", &[("留下的", "10.1/keep"), ("排除的", "10.1/drop")]),
        )
        .unwrap();
        fs::write(f.isolation.join("papers/watch-seen.md"), "10.1/old\n10.1/keep\n10.1/drop\n").unwrap();
        fs::write(
            f.isolation.join("papers/watch-followup.md"),
            "## 2026-10-13 批次\n1. 留下的\n   - 原因：付费墙\n2. 排除的\n   - 原因：付费墙\n",
        )
        .unwrap();
        fs::write(
            f.isolation.join("notes/references.bib"),
            "@article{old2026,\n  title = {Old},\n}\n@article{keep2026,\n  title = {留下的},\n}\n@article{drop2026,\n  title = {排除的},\n}\n",
        )
        .unwrap();
        freeze_at(&f.reviews, evidence, &f.isolation, &base_patterns()).unwrap();
        let snapshot = load_at(&f.reviews, &f.id).unwrap();
        // 主仓的已见台账在评审期间被别的雷达追加过
        fs::write(f.project.join("papers/watch-seen.md"), "10.1/old\n10.1/other\n").unwrap();
        let drop_id = new_hits_of(&snapshot)
            .into_iter()
            .find(|e| e.title == "排除的")
            .unwrap()
            .id;
        adopt_at(&f.reviews, &snapshot, &f.project, &[], &base_patterns(), &[drop_id]).unwrap();
        // 已见：并集（排除的也算见过，下轮不再当新命中）
        assert_eq!(
            read(&f.project.join("papers/watch-seen.md")),
            "10.1/old\n10.1/other\n10.1/keep\n10.1/drop\n"
        );
        let followup = read(&f.project.join("papers/watch-followup.md"));
        assert!(followup.contains("留下的") && !followup.contains("排除的"));
        assert!(followup.contains("## 2026-10-13 批次"));
        let bib = read(&f.project.join("notes/references.bib"));
        assert!(bib.starts_with("@article{old2026,"));
        assert!(bib.contains("keep2026") && !bib.contains("drop2026"));
        assert_eq!(bib.matches("old2026").count(), 1);
    }

    #[test]
    fn flow_canon_is_never_adopted_even_from_old_evidence() {
        // 旧证据带着整目录契约展开出的 papers/included.md：跳过不报错，主仓不动
        let f = Fixture::new();
        let mut snapshot = f.freeze();
        fs::create_dir_all(f.project.join("papers")).unwrap();
        fs::write(f.project.join("papers/included.md"), "canon\n").unwrap();
        snapshot.files.push(WatchFile {
            path: "papers/included.md".into(),
            before: Some("canon\n".into()),
            initial: Some("canon\n".into()),
            after: Some("canon\nradar wrote this\n".into()),
        });
        let mut patterns = base_patterns();
        patterns.push("papers/".into());
        let copied =
            adopt_at(&f.reviews, &snapshot, &f.project, &[], &patterns, &[]).unwrap();
        assert_eq!(copied, vec!["notes/inbox.md"]);
        assert_eq!(read(&f.project.join("papers/included.md")), "canon\n");
    }

    #[test]
    fn contract_expansion_drops_flow_canon() {
        let f = Fixture::new();
        fs::create_dir_all(f.project.join("papers")).unwrap();
        fs::write(f.project.join("papers/included.md"), "canon\n").unwrap();
        fs::write(f.project.join("papers/notes.md"), "x\n").unwrap();
        let mut patterns = base_patterns();
        patterns.push("papers/".into());
        let evidence = prepare(&f.id, &f.project, &f.isolation, &patterns).unwrap();
        let paths: Vec<&str> = evidence.files.iter().map(|x| x.path.as_str()).collect();
        assert!(paths.contains(&"papers/notes.md"));
        assert!(!paths.contains(&"papers/included.md"));
        // lit-watch 的基线契约不再含 papers/ 整目录
        assert!(!base_patterns().iter().any(|p| p == "papers/"));
    }

    #[test]
    fn pdf_lists_record_only_this_runs_downloads() {
        let f = Fixture::new();
        fs::create_dir_all(f.isolation.join("papers")).unwrap();
        fs::write(f.isolation.join("papers/Old Paper.pdf"), b"%PDF-1.4").unwrap();
        let evidence = prepare(&f.id, &f.project, &f.isolation, &base_patterns()).unwrap();
        fs::write(f.isolation.join("papers/New Paper.pdf"), b"%PDF-1.4").unwrap();
        freeze_at(&f.reviews, evidence, &f.isolation, &base_patterns()).unwrap();
        let snapshot = load_at(&f.reviews, &f.id).unwrap();
        assert_eq!(new_pdfs_of(&snapshot), Some(vec!["New Paper.pdf".to_string()]));
        // 旧证据没有记录：None（调用方回落旧口径）
        let mut legacy = snapshot.clone();
        legacy.pdfs_initial = None;
        assert_eq!(new_pdfs_of(&legacy), None);
    }

    #[test]
    fn custom_output_carries_new_text_and_conflicts_on_main_change() {
        let f = Fixture::new();
        // 契约 = 四类台账 + results/ 目录（技能声明的产出）
        let mut patterns = base_patterns();
        patterns.push("results/".to_string());
        let evidence = prepare(&f.id, &f.project, &f.isolation, &patterns).unwrap();
        fs::create_dir_all(f.isolation.join("results")).unwrap();
        fs::write(f.isolation.join("results/summary.md"), "r").unwrap();
        freeze_at(&f.reviews, evidence, &f.isolation, &patterns).unwrap();
        let snapshot = load_at(&f.reviews, &f.id).unwrap();
        // 主仓在评审期间出现了同名文件：整文件写入会抹掉它，拦
        fs::create_dir_all(f.project.join("results")).unwrap();
        fs::write(f.project.join("results/summary.md"), "human").unwrap();
        assert!(adopt_at(&f.reviews, &snapshot, &f.project, &[], &patterns, &[])
            .unwrap_err()
            .contains("冲突"));
        assert_eq!(read(&f.project.join("results/summary.md")), "human");
        fs::remove_file(f.project.join("results/summary.md")).unwrap();
        let copied = adopt_at(&f.reviews, &snapshot, &f.project, &[], &patterns, &[]).unwrap();
        assert!(copied.contains(&"results/summary.md".to_string()));
        assert_eq!(read(&f.project.join("results/summary.md")), "r");
        // 契约外路径仍拒绝（快照里混入契约外文件 = 采纳直接失败）
        let mut bad = load_at(&f.reviews, &f.id).unwrap();
        bad.files.push(WatchFile {
            path: "evil.md".into(),
            before: None,
            initial: None,
            after: Some("x".into()),
        });
        assert!(adopt_at(&f.reviews, &bad, &f.project, &[], &patterns, &[]).is_err());
    }

    #[test]
    fn custom_output_deleted_in_task_is_refused() {
        let f = Fixture::new();
        let mut patterns = base_patterns();
        patterns.push("results/".to_string());
        fs::create_dir_all(f.isolation.join("results")).unwrap();
        fs::write(f.isolation.join("results/summary.md"), "r").unwrap();
        let evidence = prepare(&f.id, &f.project, &f.isolation, &patterns).unwrap();
        fs::remove_file(f.isolation.join("results/summary.md")).unwrap();
        freeze_at(&f.reviews, evidence, &f.isolation, &patterns).unwrap();
        let snapshot = load_at(&f.reviews, &f.id).unwrap();
        fs::create_dir_all(f.project.join("results")).unwrap();
        fs::write(f.project.join("results/summary.md"), "r").unwrap();
        assert!(adopt_at(&f.reviews, &snapshot, &f.project, &[], &patterns, &[])
            .unwrap_err()
            .contains("删除"));
        assert!(load_at(&f.reviews, &uuid::Uuid::new_v4().to_string())
            .unwrap_err()
            .contains("没有冻结"));
        assert!(snapshot_path(&f.reviews, "../escape").is_err());
    }

    fn with_new_bib(snapshot: &mut WatchSnapshot) {
        snapshot
            .files
            .iter_mut()
            .find(|x| x.path == "notes/references.bib")
            .unwrap()
            .after = Some("@article{new2026,\n  title = {New},\n}\n".into());
    }

    #[test]
    fn validates_all_files_before_writing_and_honors_protected_paths() {
        let f = Fixture::new();
        let mut snapshot = f.freeze();
        with_new_bib(&mut snapshot);
        assert!(adopt_at(
            &f.reviews,
            &snapshot,
            &f.project,
            &["notes/references.bib".into()],
            &base_patterns(),
            &[],
        )
        .is_err());
        assert_eq!(f.main_inbox(), base_inbox());
        assert!(!f.project.join("notes/references.bib").exists());
    }

    #[test]
    fn protected_paths_match_case_insensitively_on_adopt() {
        // 保护「NOTES」时，APFS/NTFS 上 notes/ 是同一目录，写回必须拦
        //（与 projects::path_is_protected 的 path_key_folded 同一口径）
        let f = Fixture::new();
        let mut snapshot = f.freeze();
        with_new_bib(&mut snapshot);
        assert!(adopt_at(
            &f.reviews,
            &snapshot,
            &f.project,
            &["NOTES".into()],
            &base_patterns(),
            &[],
        )
        .is_err());
        assert!(!f.project.join("notes/references.bib").exists());
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
        assert!(f.adopt(&snapshot).is_err());
        assert_eq!(read(&outside.join("inbox.md")), base_inbox());
    }

    #[test]
    fn second_file_failure_rolls_back_first_and_keeps_backup() {
        let f = Fixture::new();
        let mut snapshot = f.freeze();
        with_new_bib(&mut snapshot);
        let mut writes = 0;
        let error = adopt_with_writer(
            &f.reviews,
            &snapshot,
            &f.project,
            &[],
            &base_patterns(),
            &[],
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
        assert_eq!(f.main_inbox(), base_inbox());
        assert!(!f.project.join("notes/references.bib").exists());
        assert!(f.reviews.join("backups").join(&f.id).is_dir());
    }

    #[test]
    fn rollback_does_not_erase_new_external_change() {
        let f = Fixture::new();
        let mut snapshot = f.freeze();
        with_new_bib(&mut snapshot);
        let mut writes = 0;
        let error = adopt_with_writer(
            &f.reviews,
            &snapshot,
            &f.project,
            &[],
            &base_patterns(),
            &[],
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
        assert_eq!(f.main_inbox(), "changed during adoption");
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

    #[test]
    fn seen_and_bib_deltas_skip_known_items() {
        assert_eq!(
            seen_delta(Some("a\nb\n"), Some("a\n"), "a\nc\nb\nc\n").as_deref(),
            Some("c")
        );
        assert_eq!(seen_delta(Some("a\n"), Some("a\n"), "a\n"), None);
        let bib = bib_delta(
            None,
            Some("@book{a,\n title={A},\n}\n"),
            "@book{a,\n title={A},\n}\n@Article{B,\n title = {Bee},\n}\n",
            &["bee".into()],
        );
        assert_eq!(bib, None, "排除条目的标题按规范化比对");
        let bib = bib_delta(None, None, "% 说明\n@article{k,\n title={T},\n}\n", &[]);
        assert_eq!(bib.as_deref(), Some("@article{k,\n title={T},\n}"));
    }
}
