//! ◈ 优化「原地改」的留底与验收：开终端让 Agent 直改库文件之前，先把这份技能整目录留一份底稿；
//! Agent 改过之后技能页能看改前改后对照，人点「保留」（顺带同步副本）或「撤回」（退回底稿，
//! 改后的版本照常进 skill-backups）。底稿在 `<config>/ccode/skill-optimize/<技能名>/`，
//! 一个技能只留一份：上一轮还没验收又开一轮时沿用最早那份，对照覆盖全部没验收的改动。

use super::*;

const SNAPSHOT_DIR: &str = "skill-optimize";
const SNAPSHOT_FILES: &str = "files";
const SNAPSHOT_META: &str = "meta.json";
/// 对照只画文本：超过这个大小或不是 UTF-8 的文件只报「改了」，不进前端
const DIFF_TEXT_LIMIT: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotMeta {
    /// 技能 id：同名技能删了再建时 id 不同，旧底稿作废
    id: String,
    digest: Option<String>,
    started_at: String,
}

/// 技能列表上的「优化待验收」状态（list 时现算，不入库文件）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeReviewState {
    pub started_at: String,
    /// 库里这份已和底稿不同（Agent 改过了）；false = 终端开了但还没改
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeFileDiff {
    path: String,
    before: String,
    after: String,
    /// 二进制或过大的文件：只说改了，不给全文
    opaque: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeReviewDto {
    started_at: String,
    files: Vec<OptimizeFileDiff>,
}

fn snapshot_root(store: &SkillStore) -> Result<PathBuf, String> {
    Ok(store
        .json_path
        .parent()
        .ok_or("无法确定技能留底目录")?
        .join(SNAPSHOT_DIR))
}

fn read_meta(snap: &Path) -> Option<SnapshotMeta> {
    let text = fs::read_to_string(snap.join(SNAPSHOT_META)).ok()?;
    serde_json::from_str(&text).ok()
}

/// 属于这个技能（id 对得上、底稿目录在）的留底；不属于的当没有
fn own_snapshot(store: &SkillStore, skill: &SkillDto) -> Option<(PathBuf, SnapshotMeta)> {
    let snap = snapshot_root(store).ok()?.join(&skill.name);
    let meta = read_meta(&snap)?;
    (meta.id == skill.id && snap.join(SNAPSHOT_FILES).is_dir()).then_some((snap, meta))
}

pub(super) fn review_state(
    store: &SkillStore,
    skill: &SkillDto,
    current_digest: Option<&str>,
) -> Option<OptimizeReviewState> {
    let (_, meta) = own_snapshot(store, skill)?;
    Some(OptimizeReviewState {
        started_at: meta.started_at,
        changed: meta.digest.as_deref() != current_digest,
    })
}

/// 删除技能时顺手清掉它的留底（best-effort）
pub(super) fn discard_snapshot(store: &SkillStore, name: &str) {
    if let Ok(root) = snapshot_root(store) {
        let _ = fs::remove_dir_all(root.join(name));
    }
}

fn find_skill(skills: &[SkillDto], id: &str) -> Result<SkillDto, String> {
    skills
        .iter()
        .find(|s| s.id == id)
        .cloned()
        .ok_or_else(|| format!("技能不存在: {id}"))
}

/// 开终端前留底，返回库目录与 SKILL.md 路径（终端 cwd 与预填指令用）
pub(super) fn begin_impl(store: &SkillStore, id: &str) -> Result<SkillPathDto, String> {
    let _lock = store.lock()?;
    let skill = find_skill(&store.read(), id)?;
    let dir = store.skill_dir(&skill.name);
    if !dir.is_dir() {
        return Err(format!("库目录缺失: {}", dir.display()));
    }
    if own_snapshot(store, &skill).is_none() {
        let snap = snapshot_root(store)?.join(&skill.name);
        let _ = fs::remove_dir_all(&snap);
        let staging = snap.with_extension(format!("tmp-{}", &uuid::Uuid::new_v4().to_string()[..8]));
        let built = (|| {
            copy_dir_recursive(&dir, &staging.join(SNAPSHOT_FILES))?;
            let meta = SnapshotMeta {
                id: skill.id.clone(),
                digest: dir_manifest_hash(&dir),
                started_at: crate::sessions::now_iso(),
            };
            let text = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
            fs::write(staging.join(SNAPSHOT_META), text).map_err(|e| format!("写留底说明失败: {e}"))?;
            fs::rename(&staging, &snap).map_err(|e| format!("留底落位失败: {e}"))
        })();
        if let Err(e) = built {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("改前留底失败，没有打开终端：{e}"));
        }
    }
    Ok(SkillPathDto {
        md_path: dir.join("SKILL.md").to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(),
    })
}

/// 目录下全部文件的相对路径（`/` 分隔，跳过分发标记）
fn list_files(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_WALK_DEPTH {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push((p, depth + 1));
            } else if p.is_file() {
                if let Ok(rel) = p.strip_prefix(root) {
                    let rel = rel.to_string_lossy().replace('\\', "/");
                    if rel != MARKER_FILE {
                        out.push(rel);
                    }
                }
            }
        }
    }
    out
}

/// 读成可对照的文本；None = 不存在，Some(Err) = 过大或不是文本
fn read_text(path: &Path) -> Option<Result<String, ()>> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > DIFF_TEXT_LIMIT {
        return Some(Err(()));
    }
    let bytes = fs::read(path).ok()?;
    Some(String::from_utf8(bytes).map_err(|_| ()))
}

pub(super) fn review_impl(store: &SkillStore, id: &str) -> Result<OptimizeReviewDto, String> {
    let skill = find_skill(&store.read(), id)?;
    let (snap, meta) = own_snapshot(store, &skill).ok_or("这个技能没有待看的优化改动")?;
    let before_root = snap.join(SNAPSHOT_FILES);
    let after_root = store.skill_dir(&skill.name);
    let mut paths = list_files(&before_root);
    paths.extend(list_files(&after_root));
    paths.sort();
    paths.dedup();
    // SKILL.md 排最前，人最先看正文
    paths.sort_by_key(|p| p != "SKILL.md");
    let mut files = Vec::new();
    for rel in paths {
        let before_path = before_root.join(&rel);
        let after_path = after_root.join(&rel);
        let before_bytes = fs::read(&before_path).ok();
        let after_bytes = fs::read(&after_path).ok();
        let same = match (&before_bytes, &after_bytes) {
            (Some(a), Some(b)) => bytes_eq_ignore_crlf(a, b),
            (None, None) => true,
            _ => false,
        };
        if same {
            continue;
        }
        let before = read_text(&before_path);
        let after = read_text(&after_path);
        let opaque = matches!(before, Some(Err(()))) || matches!(after, Some(Err(())));
        let text = |t: Option<Result<String, ()>>| match t {
            Some(Ok(s)) if !opaque => s,
            _ => String::new(),
        };
        files.push(OptimizeFileDiff {
            path: rel,
            before: text(before),
            after: text(after),
            opaque,
        });
    }
    Ok(OptimizeReviewDto {
        started_at: meta.started_at,
        files,
    })
}

/// 验收：keep=true 保留改后的版本；false 撤回到底稿（改后的版本先进 skill-backups）。
/// 两种都把 skills.json 里的简介按 SKILL.md 刷新、把复制件跟上，返回同步过的 Agent
pub(super) fn finish_impl(
    store: &SkillStore,
    dirs: &HashMap<String, PathBuf>,
    id: &str,
    keep: bool,
) -> Result<Vec<String>, String> {
    let _lock = store.lock()?;
    let mut skills = store.read();
    let skill = find_skill(&skills, id)?;
    let (snap, _) = own_snapshot(store, &skill).ok_or("这个技能没有待验收的优化（可能已经处理过）")?;
    let dst = store.skill_dir(&skill.name);
    if !keep {
        let backup = backup_library_dir(store, &skill.name)?;
        if let Err(e) = copy_dir_recursive(&snap.join(SNAPSHOT_FILES), &dst) {
            return Err(restore_library_backup(
                backup.as_deref(),
                &dst,
                format!("撤回失败：{e}"),
            ));
        }
    }
    let _ = fs::remove_dir_all(&snap);
    if let Some(pos) = skills.iter().position(|s| s.id == id) {
        let description = parse_skill_md(&dst.join("SKILL.md")).description.unwrap_or_default();
        if skills[pos].description != description {
            skills[pos].description = description;
            store.write(&skills)?;
        }
    }
    resync_impl(store, dirs, id)
}

#[tauri::command]
pub async fn begin_skill_optimize(id: String) -> Result<SkillPathDto, String> {
    tauri::async_runtime::spawn_blocking(move || begin_impl(&SkillStore::default_paths()?, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn skill_optimize_review(id: String) -> Result<OptimizeReviewDto, String> {
    tauri::async_runtime::spawn_blocking(move || review_impl(&SkillStore::default_paths()?, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn finish_skill_optimize(id: String, keep: bool) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        finish_impl(&SkillStore::default_paths()?, &agent_dirs(), &id, keep)
    })
    .await
    .map_err(|e| e.to_string())?
}
