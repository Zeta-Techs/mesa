use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static VERSION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    pub id: String,
    pub path: String,
    pub saved_at: String,
    pub note: String,
    pub source: String,
    pub workspace_id: Option<String>,
    pub sha256: String,
    pub size: u64,
    pub git_blob: Option<String>,
    pub save_id: Option<String>,
    pub round: Option<usize>,
    pub cause: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionIndex {
    tracked: Vec<String>,
    versions: Vec<FileVersion>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionFile {
    path: String,
    tracked: bool,
    exists: bool,
    versions: Vec<FileVersion>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersionsDto {
    root: String,
    files: Vec<VersionFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionComparison {
    before: Option<String>,
    after: Option<String>,
    before_path: Option<String>,
    after_path: Option<String>,
}

fn valid_hash(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn relative(path: &str) -> Result<String, String> {
    let path = path.replace('\\', "/");
    if path.is_empty()
        || path.contains(':')
        || path.starts_with('/')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == ".." || part.starts_with('-'))
        || path.starts_with(".ccode/")
        || path.starts_with(".git/")
        || path == ".git"
    {
        return Err("只能留存项目中的普通文件".into());
    }
    Ok(path)
}

fn safe_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut cursor = root.to_path_buf();
    for part in Path::new(rel).components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return Err("文件路径无效".into());
        }
        cursor.push(part);
        match fs::symlink_metadata(&cursor) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("文件路径经过符号链接，未操作".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(cursor)
}

fn location(
    root: &str,
    path: Option<&str>,
) -> Result<(PathBuf, Option<PathBuf>, Option<String>), String> {
    let scope = crate::paths::canonicalize_plain(Path::new(&crate::sessions::expand_tilde(root)))
        .map_err(|error| error.to_string())?;
    let project = if scope.join(".git").is_file() {
        let common = crate::workspaces::run_git_raw(
            &scope,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?;
        PathBuf::from(common.trim())
            .parent()
            .ok_or("找不到项目目录")?
            .to_path_buf()
    } else {
        scope.clone()
    };
    let project = crate::paths::canonicalize_plain(&project).map_err(|error| error.to_string())?;
    if !safe_path(&project, ".ccode/project.toml")?.is_file() {
        return Err("这个目录不是 Mesa 项目".into());
    }
    let rel = path
        .map(|value| {
            let target = PathBuf::from(value);
            let value = if target.is_absolute() {
                target
                    .strip_prefix(&scope)
                    .map_err(|_| "文件不在当前项目中")?
                    .to_string_lossy()
                    .into_owned()
            } else {
                value.to_string()
            };
            relative(&value)
        })
        .transpose()?;
    let source = rel
        .as_ref()
        .map(|value| safe_path(&scope, value))
        .transpose()?;
    Ok((project, source, rel))
}

fn load(root: &Path) -> Result<VersionIndex, String> {
    let path = safe_path(root, ".ccode/versions/index.json")?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(VersionIndex::default())
        }
        Err(error) => return Err(error.to_string()),
    };
    let index: VersionIndex = serde_json::from_slice(&bytes)
        .map_err(|error| format!("文件版本记录损坏，未改写：{error}"))?;
    for path in &index.tracked {
        relative(path)?;
    }
    for version in &index.versions {
        relative(&version.path)?;
        uuid::Uuid::parse_str(&version.id).map_err(|_| "文件版本标识无效")?;
        if !valid_hash(&version.sha256)
            || version
                .git_blob
                .as_ref()
                .is_some_and(|blob| !valid_hash(blob))
        {
            return Err("文件版本指纹无效".into());
        }
    }
    Ok(index)
}

fn persist(root: &Path, index: &VersionIndex) -> Result<(), String> {
    let path = safe_path(root, ".ccode/versions/index.json")?;
    crate::storage::atomic_write(
        &path,
        &serde_json::to_vec_pretty(index).map_err(|error| error.to_string())?,
        true,
    )
}

fn git_content(root: &Path, blob: &str) -> Result<Vec<u8>, String> {
    if !valid_hash(blob) {
        return Err("Git 文件版本无效".into());
    }
    let size = crate::workspaces::run_git_raw(root, &["cat-file", "-s", blob])?
        .trim()
        .parse::<u64>()
        .map_err(|_| "读不到文件大小")?;
    if size > 1024 * 1024 * 1024 {
        return Err("文件超过 1 GB，请拆分后留存".into());
    }
    crate::workspaces::run_git_bytes(root, &["cat-file", "blob", blob])
}

fn blob_at(root: &Path, commit: &str, path: &str) -> Option<String> {
    if !valid_hash(commit) {
        return None;
    }
    let blob = crate::workspaces::run_git_raw(
        root,
        &["rev-parse", "--verify", &format!("{commit}:{path}")],
    )
    .ok()?;
    let blob = blob.trim().to_string();
    valid_hash(&blob).then_some(blob)
}

fn content(root: &Path, version: &FileVersion) -> Result<Vec<u8>, String> {
    if version.size > 1024 * 1024 * 1024 {
        return Err("留存文件超过读取预算".into());
    }
    let bytes = match &version.git_blob {
        Some(blob) => git_content(root, blob)?,
        None => {
            let path = safe_path(root, &format!(".ccode/versions/objects/{}", version.sha256))?;
            if fs::metadata(&path)
                .map_err(|error| format!("这一版的文件内容不可用：{error}"))?
                .len()
                != version.size
            {
                return Err("这一版的文件大小与记录不一致".into());
            }
            fs::read(path).map_err(|error| format!("这一版的文件内容不可用：{error}"))?
        }
    };
    if bytes.len() as u64 != version.size
        || (!version.id.starts_with("git:")
            && format!("{:x}", Sha256::digest(&bytes)) != version.sha256)
    {
        return Err("这一版的内容与留存指纹不一致，未使用".into());
    }
    Ok(bytes)
}

fn snapshot(root: &Path, source: &Path, mut version: FileVersion) -> Result<FileVersion, String> {
    let staged = safe_path(root, &format!(".ccode/versions/staging-{}", version.id))?;
    let result = (|| {
        let (size, sha) = crate::workspaces::copy_delivery_snapshot(source, &staged)?;
        if crate::workspaces::delivery_hash(source)? != (size, sha.clone()) {
            return Err("文件在留存期间发生变化，请保存文件后重试".into());
        }
        version.size = size;
        version.sha256 = sha;
        let head = crate::workspaces::run_git_raw(root, &["rev-parse", "HEAD"]).ok();
        let blob = head
            .as_deref()
            .and_then(|head| blob_at(root, head.trim(), &version.path));
        if let Some(blob) = blob {
            if git_content(root, &blob)
                .ok()
                .is_some_and(|bytes| format!("{:x}", Sha256::digest(&bytes)) == version.sha256)
            {
                version.git_blob = Some(blob);
            }
        }
        if version.git_blob.is_none() {
            let dest = safe_path(root, &format!(".ccode/versions/objects/{}", version.sha256))?;
            fs::create_dir_all(dest.parent().ok_or("留存目录无效")?)
                .map_err(|error| error.to_string())?;
            if dest.exists() {
                if crate::workspaces::delivery_hash(&dest)?.1 != version.sha256 {
                    return Err("已有留存内容损坏，未覆盖".into());
                }
            } else {
                fs::rename(&staged, &dest).map_err(|error| error.to_string())?;
            }
        }
        Ok(version)
    })();
    let _ = fs::remove_file(staged);
    result
}

fn new_version(path: &str, note: &str, source: &str) -> FileVersion {
    FileVersion {
        id: uuid::Uuid::new_v4().to_string(),
        path: path.into(),
        saved_at: crate::sessions::now_iso(),
        note: note.trim().into(),
        source: source.into(),
        workspace_id: None,
        sha256: String::new(),
        size: 0,
        git_blob: None,
        save_id: None,
        round: None,
        cause: None,
    }
}

fn historical_version(
    root: &Path,
    save: &crate::projects::AcceptanceLogEntry,
    path: &str,
) -> Option<FileVersion> {
    relative(path).ok()?;
    let blob = blob_at(root, &save.version_id, path)?;
    let size = crate::workspaces::run_git_raw(root, &["cat-file", "-s", &blob])
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    if size > 1024 * 1024 * 1024 {
        return None;
    }
    let name = save.goal_name.split(" / ").next().unwrap_or("保存进项目");
    let config = crate::projects::read_config_at(root).config;
    let step = config
        .steps
        .iter()
        .find(|step| step.workspace_name == name)
        .map(|step| step.name.as_str())
        .unwrap_or(name);
    let mut version = new_version(path, "", step);
    version.id = format!("git:{}:{path}", save.version_id);
    version.saved_at = save.decided_at.clone();
    version.workspace_id = save.scene_ref.clone();
    version.save_id = Some(save.version_id.clone());
    version.git_blob = Some(blob);
    version.size = size;
    if let Some(id) = save.scene_ref.as_deref() {
        let (round, cause) = crate::step_loop::saved_round_origin(root, id, &save.decided_at);
        version.round = Some(round);
        version.cause = Some(cause);
    }
    Some(version)
}

fn historical_versions(root: &Path, path: &str) -> Vec<FileVersion> {
    let mut saves: Vec<_> = crate::projects::read_acceptance_log_at(root)
        .into_iter()
        .filter(|save| {
            save.kind == crate::review_contract::KIND_PIPELINE_MERGE
                && save.paths.iter().any(|saved| saved == path)
        })
        .collect();
    saves.sort_by_key(|save| save.decided_at.clone());
    let mut versions = Vec::new();
    let mut previous = None;
    for save in saves {
        let Some(version) = historical_version(root, &save, path) else {
            continue;
        };
        if version.git_blob == previous {
            continue;
        }
        previous = version.git_blob.clone();
        versions.push(version);
    }
    versions
}

fn view(
    root: &Path,
    index: VersionIndex,
    path: Option<&str>,
    workspace: Option<&str>,
) -> Result<FileVersionsDto, String> {
    let path_filter = path;
    let mut candidates = if workspace.is_none() {
        index.tracked.clone()
    } else {
        Vec::new()
    };
    candidates.extend(
        index
            .versions
            .iter()
            .filter(|version| {
                workspace.is_none_or(|id| version.workspace_id.as_deref() == Some(id))
            })
            .map(|version| version.path.clone()),
    );
    if let Some(path) = path {
        candidates.push(relative(path)?);
    }
    if let Some(id) = workspace {
        candidates.extend(
            crate::projects::read_acceptance_log_at(root)
                .into_iter()
                .filter(|save| {
                    save.kind == crate::review_contract::KIND_PIPELINE_MERGE
                        && save.scene_ref.as_deref() == Some(id)
                })
                .flat_map(|save| save.paths)
                .filter(|path| relative(path).is_ok()),
        );
    }
    candidates.sort();
    candidates.dedup();
    let files = candidates
        .into_iter()
        .filter(|candidate| path.is_none_or(|path| candidate == path))
        .map(|path| {
            let mut versions: Vec<_> = index
                .versions
                .iter()
                .filter(|version| version.path == path)
                .cloned()
                .rev()
                .collect();
            if path.as_str() == path_filter.unwrap_or("") {
                for old in historical_versions(root, &path) {
                    if !versions
                        .iter()
                        .any(|saved| saved.git_blob == old.git_blob && saved.save_id == old.save_id)
                    {
                        versions.push(old);
                    }
                }
                versions.sort_by_key(|version| {
                    std::cmp::Reverse(
                        chrono::DateTime::parse_from_rfc3339(&version.saved_at)
                            .map(|time| time.timestamp_millis())
                            .unwrap_or(0),
                    )
                });
            }
            Ok(VersionFile {
                tracked: index.tracked.contains(&path),
                exists: safe_path(root, &path)?.is_file(),
                path,
                versions,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(FileVersionsDto {
        root: root.to_string_lossy().into_owned(),
        files,
    })
}

fn with_lock<T>(root: &Path, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _process = VERSION_LOCK.lock().map_err(|_| "文件版本锁失效")?;
    let key = format!(
        "file-versions-{:x}",
        md5::compute(crate::paths::path_key(&root.to_string_lossy()))
    );
    let _file = crate::storage::config_lock(&key)?;
    work()
}

pub(crate) fn capture_accepted(
    root: &Path,
    save: &crate::projects::AcceptanceLogEntry,
    review: &crate::workspaces::DeliverableReviewDto,
) -> Result<(), String> {
    match fs::symlink_metadata(root.join(".ccode/versions/index.json")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    with_lock(root, || {
        let mut index = load(root)?;
        let tracked = index.tracked.clone();
        for path in tracked.iter().filter(|path| save.paths.contains(path)) {
            if index.versions.iter().any(|version| {
                version.path == *path && version.save_id.as_deref() == Some(&save.version_id)
            }) {
                continue;
            }
            let name = save.goal_name.split(" / ").next().unwrap_or("保存进项目");
            let cfg = crate::projects::read_config_at(root).config;
            let step = cfg
                .steps
                .iter()
                .find(|step| step.workspace_name == name)
                .map(|step| step.name.as_str())
                .unwrap_or(name);
            let mut version = new_version(path, "", step);
            version.saved_at = save.decided_at.clone();
            version.workspace_id = save.scene_ref.clone();
            version.save_id = Some(save.version_id.clone());
            if let Some(id) = save.scene_ref.as_deref() {
                let (round, cause) =
                    crate::step_loop::saved_round_origin(root, id, &save.decided_at);
                version.round = Some(round);
                version.cause = Some(cause);
            }
            if let Some(file) = review
                .files
                .iter()
                .find(|file| file.path == *path && file.disposition == "copy")
            {
                version = snapshot(
                    root,
                    &safe_path(Path::new(&review.payload_dir), path)?,
                    version,
                )?;
                if file.sha256.as_deref() != Some(&version.sha256) || file.size != version.size {
                    return Err(format!("{path} 的冻结内容与已采纳指纹不一致，未登记留存"));
                }
            } else if let Some(blob) = blob_at(root, &save.version_id, path) {
                let bytes = git_content(root, &blob)?;
                version.size = bytes.len() as u64;
                version.sha256 = format!("{:x}", Sha256::digest(&bytes));
                version.git_blob = Some(blob);
            } else {
                continue;
            }
            if index
                .versions
                .iter()
                .rev()
                .find(|old| old.path == *path)
                .is_some_and(|old| old.sha256 == version.sha256)
            {
                continue;
            }
            index.versions.push(version);
            persist(root, &index)?;
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn file_versions(
    root: String,
    path: Option<String>,
    workspace_id: Option<String>,
) -> Result<FileVersionsDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, source, path) = location(&root, path.as_deref())?;
        with_lock(&root, || {
            let mut result = view(
                &root,
                load(&root)?,
                path.as_deref(),
                workspace_id.as_deref(),
            )?;
            if let Some(source) = source {
                if let Some(file) = result.files.first_mut() {
                    file.exists = source.is_file();
                }
            }
            Ok(result)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn file_version_update(
    root: String,
    path: String,
    action: String,
    version_id: Option<String>,
    note: String,
    workspace_id: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let scope = crate::sessions::expand_tilde(&root);
        let (root, source, path) = location(&root, Some(&path))?;
        let path = path.ok_or("未选择文件")?;
        let workspace_id = workspace_id.or_else(|| {
            crate::workspaces::db()
                .and_then(|connection| crate::workspaces::query_workspaces(&connection))
                .ok()?
                .into_iter()
                .find(|workspace| crate::paths::same_path(&scope, &workspace.worktree_path))
                .map(|workspace| workspace.id)
        });
        if note.chars().count() > 200 {
            return Err("备注请控制在 200 字内".into());
        }
        with_lock(&root, || {
            update_at(
                &root,
                &source.ok_or("找不到当前文件路径")?,
                &path,
                &action,
                version_id.as_deref(),
                &note,
                workspace_id.as_deref(),
            )
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn update_at(
    root: &Path,
    source: &Path,
    path: &str,
    action: &str,
    version_id: Option<&str>,
    note: &str,
    workspace_id: Option<&str>,
) -> Result<(), String> {
    let path = relative(path)?;
    let mut index = load(root)?;
    if matches!(action, "track" | "snapshot") && root.join(".git").exists() {
        crate::projects::exclude_in_git(&root, "/.ccode/versions/");
        crate::workspaces::run_git_raw(
            &root,
            &["check-ignore", "--", ".ccode/versions/index.json"],
        )
        .map_err(|_| "无法保证文件版本目录不进 Git，未留存")?;
    }
    match action {
        "track" | "snapshot" => {
            if action == "track" && !index.tracked.contains(&path) {
                let mut previous_blob = None;
                for save in crate::projects::read_acceptance_log_at(root)
                    .into_iter()
                    .filter(|save| {
                        save.kind == crate::review_contract::KIND_PIPELINE_MERGE
                            && save.paths.contains(&path)
                    })
                {
                    let Some(blob) = blob_at(root, &save.version_id, &path) else {
                        continue;
                    };
                    if previous_blob.as_deref() == Some(blob.as_str()) {
                        continue;
                    }
                    previous_blob = Some(blob.clone());
                    if index.versions.iter().any(|version| {
                        version.path == path && version.save_id.as_deref() == Some(&save.version_id)
                    }) {
                        continue;
                    }
                    let Ok(bytes) = git_content(root, &blob) else {
                        continue;
                    };
                    let sha = format!("{:x}", Sha256::digest(&bytes));
                    let mut version = new_version(
                        &path,
                        "",
                        save.goal_name.split(" / ").next().unwrap_or("保存进项目"),
                    );
                    version.saved_at = save.decided_at.clone();
                    version.workspace_id = save.scene_ref.clone();
                    version.save_id = Some(save.version_id);
                    version.size = bytes.len() as u64;
                    version.sha256 = sha;
                    version.git_blob = Some(blob);
                    if let Some(id) = save.scene_ref.as_deref() {
                        let (round, cause) =
                            crate::step_loop::saved_round_origin(root, id, &save.decided_at);
                        version.round = Some(round);
                        version.cause = Some(cause);
                    }
                    index.versions.push(version);
                }
                index.versions.sort_by_key(|version| {
                    chrono::DateTime::parse_from_rfc3339(&version.saved_at)
                        .map(|time| time.timestamp_millis())
                        .unwrap_or(0)
                });
            }
            let mut version = snapshot(root, source, new_version(&path, note, "手动留存"))?;
            version.workspace_id = workspace_id.map(str::to_string).or_else(|| {
                crate::projects::read_acceptance_log_at(root)
                    .into_iter()
                    .rev()
                    .find(|save| save.paths.contains(&path))
                    .and_then(|save| save.scene_ref)
            });
            let same = index
                .versions
                .iter()
                .rev()
                .find(|old| old.path == path)
                .is_some_and(|old| old.sha256 == version.sha256);
            if action == "snapshot" || !same {
                index.versions.push(version);
            }
            if action == "track" && !index.tracked.contains(&path) {
                index.tracked.push(path.clone());
            }
        }
        "untrack" => index.tracked.retain(|tracked| tracked != &path),
        "rename" | "delete" => {
            let position = index
                .versions
                .iter()
                .position(|version| version.path == path && Some(version.id.as_str()) == version_id)
                .ok_or("找不到这一版")?;
            if action == "rename" {
                index.versions[position].note = note.trim().to_string();
            } else {
                let removed = index.versions.remove(position);
                persist(&root, &index)?;
                if removed.git_blob.is_none()
                    && !index.versions.iter().any(|version| {
                        version.git_blob.is_none() && version.sha256 == removed.sha256
                    })
                {
                    fs::remove_file(safe_path(
                        &root,
                        &format!(".ccode/versions/objects/{}", removed.sha256),
                    )?)
                    .map_err(|error| error.to_string())?;
                }
                return Ok(());
            }
        }
        _ => return Err("不支持的文件版本操作".into()),
    }
    index.versions.sort_by_key(|version| {
        chrono::DateTime::parse_from_rfc3339(&version.saved_at)
            .map(|time| time.timestamp_millis())
            .unwrap_or(0)
    });
    persist(&root, &index)
}

fn selected(root: &Path, id: &str) -> Result<FileVersion, String> {
    if let Some(spec) = id.strip_prefix("git:") {
        let (sha, path) = spec.split_once(':').ok_or("历史版本标识无效")?;
        relative(path)?;
        if !valid_hash(sha) {
            return Err("历史版本标识无效".into());
        }
        let save = crate::projects::read_acceptance_log_at(root)
            .into_iter()
            .find(|save| {
                save.kind == crate::review_contract::KIND_PIPELINE_MERGE
                    && save.version_id == sha
                    && save.paths.iter().any(|saved| saved == path)
            })
            .ok_or("找不到已保存的历史版本")?;
        return historical_version(root, &save, path)
            .ok_or_else(|| "这个文件的历史内容已不可用".into());
    }
    load(root)?
        .versions
        .into_iter()
        .find(|version| version.id == id)
        .ok_or_else(|| "找不到这一版".into())
}

fn publish_copy(
    root: &Path,
    version: &FileVersion,
    dest: &Path,
    replace: bool,
) -> Result<(), String> {
    let parent = dest.parent().ok_or("目标目录无效")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let staged = parent.join(format!(".ccode-version-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        if version.git_blob.is_some() {
            crate::storage::atomic_write(&staged, &content(root, version)?, true)?;
        } else {
            let source = safe_path(root, &format!(".ccode/versions/objects/{}", version.sha256))?;
            let (size, sha) = crate::workspaces::copy_delivery_snapshot(&source, &staged)?;
            if size != version.size || sha != version.sha256 {
                return Err("这一版的内容与留存指纹不一致，未使用".into());
            }
        }
        if replace {
            crate::storage::replace(&staged, dest)
        } else {
            fs::hard_link(&staged, dest)
                .map_err(|error| format!("另存失败，未覆盖已有文件：{error}"))
        }
    })();
    let _ = fs::remove_file(staged);
    result
}

#[tauri::command]
pub async fn file_version_preview(root: String, version_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, _, _) = location(&root, None)?;
        with_lock(&root, || {
            let version = selected(&root, &version_id)?;
            let name = Path::new(&version.path)
                .file_name()
                .ok_or("文件名无效")?
                .to_string_lossy();
            let config = crate::storage::config_root().ok_or("找不到预览目录")?;
            let path = safe_path(
                &config,
                &format!("tmp/file-versions/{}/{}", version.id, name),
            )?;
            publish_copy(&root, &version, &path, true)?;
            Ok(path.to_string_lossy().into_owned())
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn comparison_at(
    root: &Path,
    current_root: &Path,
    from: &str,
    to: Option<&str>,
    image: bool,
) -> Result<VersionComparison, String> {
    let before = selected(root, from)?;
    let after = to.map(|id| selected(root, id)).transpose()?;
    if after
        .as_ref()
        .is_some_and(|after| after.path != before.path)
    {
        return Err("请选择同一个文件的两版".into());
    }
    let cap = if image { 32 * 1024 * 1024 } else { 512 * 1024 };
    if before.size > cap || after.as_ref().is_some_and(|after| after.size > cap) {
        return Err("文件超过比较预算，请另存后用系统应用比较".into());
    }
    let before_bytes = content(root, &before)?;
    let after_bytes = if let Some(after) = &after {
        content(root, after)?
    } else {
        let current = safe_path(current_root, &before.path)?;
        let metadata =
            fs::symlink_metadata(&current).map_err(|_| "当前文件已不存在，请选择另一份历史版本")?;
        if !metadata.is_file() || metadata.len() > cap {
            return Err("当前文件不是普通文件或超过比较预算".into());
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        fs::File::open(&current)
            .map_err(|error| error.to_string())?
            .take(cap + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > cap {
            return Err("当前文件在读取中超过比较预算".into());
        }
        if crate::workspaces::delivery_hash(&current)?
            != (bytes.len() as u64, format!("{:x}", Sha256::digest(&bytes)))
        {
            return Err("当前文件在读取中发生变化，请刷新对照".into());
        }
        bytes
    };
    if image {
        let ext = Path::new(&before.path)
            .extension()
            .map(|ext| ext.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !matches!(
            ext.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp"
        ) {
            return Err("这类文件不支持图片比较".into());
        }
        let mut digest = Sha256::new();
        digest.update((before_bytes.len() as u64).to_le_bytes());
        digest.update(&before_bytes);
        digest.update(&after_bytes);
        let fingerprint = format!("{:x}", digest.finalize());
        let folder = safe_path(
            &crate::storage::config_root().ok_or("找不到比较目录")?,
            &format!("tmp/file-versions/compare/{fingerprint}"),
        )?;
        let before_path = folder.join(format!("before.{ext}"));
        let after_path = folder.join(format!("after.{ext}"));
        let result = (|| {
            crate::storage::atomic_write(&before_path, &before_bytes, true)?;
            crate::storage::atomic_write(&after_path, &after_bytes, true)?;
            Ok(VersionComparison {
                before: None,
                after: None,
                before_path: Some(before_path.to_string_lossy().into_owned()),
                after_path: Some(after_path.to_string_lossy().into_owned()),
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(folder);
        }
        result
    } else {
        let decode = |bytes: Vec<u8>| -> Result<String, String> {
            if bytes.contains(&0) {
                return Err("二进制文件请另存后用系统应用比较".into());
            }
            let text =
                String::from_utf8(bytes).map_err(|_| "非 UTF-8 文件请另存后用系统应用比较")?;
            Ok(crate::sessions::redact_sensitive_text(&text))
        };
        Ok(VersionComparison {
            before: Some(decode(before_bytes)?),
            after: Some(decode(after_bytes)?),
            before_path: None,
            after_path: None,
        })
    }
}

#[tauri::command]
pub async fn file_version_compare(
    root: String,
    from: String,
    to: Option<String>,
    image: bool,
) -> Result<VersionComparison, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let scope =
            crate::paths::canonicalize_plain(Path::new(&crate::sessions::expand_tilde(&root)))
                .map_err(|error| error.to_string())?;
        let (project, _, _) = location(&root, None)?;
        with_lock(&project, || {
            comparison_at(&project, &scope, &from, to.as_deref(), image)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn file_version_export(
    window: tauri::Window,
    root: String,
    version_id: String,
) -> Result<Option<String>, String> {
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let (root, _, _) = location(&root, None)?;
        let version = with_lock(&root, || selected(&root, &version_id))?;
        let (directory, name) = export_default(&root, &version.path)?;
        let picked = window
            .app_handle()
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("另存为副本（不覆盖已有文件）")
            .set_directory(directory)
            .set_file_name(name)
            .blocking_save_file();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let target = picked.into_path().map_err(|error| error.to_string())?;
        with_lock(&root, || {
            export_to_path(&root, &version_id, &target).map(Some)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn export_default(root: &Path, path: &str) -> Result<(PathBuf, String), String> {
    let original = root.join(relative(path)?);
    let stem = original.file_stem().ok_or("文件名无效")?.to_string_lossy();
    let extension = original
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default();
    let name = format!("{stem}-副本{extension}");
    crate::paths::validate_fs_name(&name)?;
    let mut directory = original.parent().ok_or("文件目录无效")?.to_path_buf();
    while !directory.is_dir() {
        directory = directory.parent().ok_or("找不到保存目录")?.to_path_buf();
    }
    Ok((directory, name))
}

fn export_to_path(root: &Path, version_id: &str, target: &Path) -> Result<String, String> {
    let canonical_root =
        crate::paths::canonicalize_plain(root).map_err(|error| error.to_string())?;
    if !target.is_absolute() {
        return Err("保存位置必须由系统窗口选择".into());
    }
    let name = target.file_name().ok_or("文件名无效")?.to_string_lossy();
    crate::paths::validate_fs_name(&name)?;
    let parent = crate::paths::canonicalize_plain(target.parent().ok_or("目标目录无效")?)
        .map_err(|error| format!("保存目录不可用：{error}"))?;
    let dest = parent.join(name.as_ref());
    if dest.components().any(|component| matches!(component, std::path::Component::Normal(name) if name.to_string_lossy().eq_ignore_ascii_case(".ccode") || name.to_string_lossy().eq_ignore_ascii_case(".git"))) {
        return Err("不能把副本写进项目内部记录或 Git 目录".into());
    }
    match fs::symlink_metadata(&dest) {
        Ok(_) => return Err("这个文件名已存在，请换一个名字；现稿未覆盖".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    if crate::paths::path_within_path(&dest, &canonical_root) {
        let rel = dest
            .strip_prefix(&canonical_root)
            .map_err(|_| "目标路径无效")?
            .to_string_lossy()
            .replace('\\', "/");
        if crate::projects::path_is_protected(&rel, &crate::projects::protected_paths_at(root)?) {
            return Err("目标在项目保护范围内，未写入".into());
        }
    }
    let version = selected(root, version_id)?;
    publish_copy(root, &version, &dest, false)?;
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
fn export_at(root: &Path, version_id: &str, target: &str) -> Result<String, String> {
    let target = relative(target)?;
    for name in target.split('/') {
        crate::paths::validate_fs_name(name)?;
    }
    let dest = safe_path(&root, &target)?;
    if dest.exists() {
        return Err("这个文件名已存在，请换一个名字；现稿未覆盖".into());
    }
    fs::create_dir_all(dest.parent().ok_or("目标目录无效")?).map_err(|error| error.to_string())?;
    export_to_path(root, version_id, &dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        _config: crate::storage::ConfigRootGuard,
    }

    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("mesa-file-versions-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join(".ccode")).unwrap();
            fs::write(root.join(".ccode/project.toml"), "name = '版本测试'\n").unwrap();
            let config = crate::storage::redirect_config_root(&root.join("config"));
            crate::workspaces::run_git_raw(&root, &["init", "-q"]).unwrap();
            Self {
                root,
                _config: config,
            }
        }

        fn write(&self, path: &str, bytes: &[u8]) {
            let target = self.root.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, bytes).unwrap();
        }

        fn commit(&self, path: &str) -> String {
            crate::workspaces::run_git_raw(&self.root, &["--literal-pathspecs", "add", "--", path])
                .unwrap();
            let hooks = format!("core.hooksPath={}", self.root.join("empty-hooks").display());
            crate::workspaces::run_git_raw(
                &self.root,
                &[
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    &hooks,
                    "-c",
                    "user.name=test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "-qm",
                    "version",
                ],
            )
            .unwrap();
            crate::workspaces::run_git_raw(&self.root, &["rev-parse", "HEAD"])
                .unwrap()
                .trim()
                .into()
        }

        fn update(
            &self,
            path: &str,
            action: &str,
            id: Option<&str>,
            note: &str,
        ) -> Result<(), String> {
            with_lock(&self.root, || {
                update_at(
                    &self.root,
                    &self.root.join(path),
                    path,
                    action,
                    id,
                    note,
                    None,
                )
            })
        }

        fn review(&self, path: &str, bytes: &[u8]) -> crate::workspaces::DeliverableReviewDto {
            self.write(&format!("frozen/{path}"), bytes);
            crate::workspaces::DeliverableReviewDto {
                token: uuid::Uuid::new_v4().to_string(),
                workspace_id: "step".into(),
                project_root: self.root.to_string_lossy().into_owned(),
                payload_dir: self.root.join("frozen").to_string_lossy().into_owned(),
                files: vec![crate::workspaces::FrozenDeliverable {
                    path: path.into(),
                    size: bytes.len() as u64,
                    sha256: Some(format!("{:x}", Sha256::digest(bytes))),
                    disposition: "copy".into(),
                    required: false,
                }],
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn save(path: &str, id: &str) -> crate::projects::AcceptanceLogEntry {
        crate::projects::AcceptanceLogEntry {
            goal_id: String::new(),
            goal_name: "step / branch".into(),
            run_id: String::new(),
            paths: vec![path.into()],
            note: String::new(),
            frozen: true,
            decided_at: "2026-11-12T14:00:00+08:00".into(),
            kind: crate::review_contract::KIND_PIPELINE_MERGE.into(),
            version_id: id.into(),
            reviewed_sha: None,
            project_id: None,
            scene_ref: Some("step".into()),
            content_fingerprints: Vec::new(),
        }
    }

    #[test]
    fn committed_text_uses_git_but_unsaved_text_is_kept_exactly() {
        let fixture = Fixture::new();
        fixture.write("outline.md", b"accepted\n");
        fixture.commit("outline.md");
        fixture
            .update("outline.md", "track", None, "导师看过")
            .unwrap();
        let index = load(&fixture.root).unwrap();
        assert!(index.versions[0].git_blob.is_some());
        assert_eq!(
            content(&fixture.root, &index.versions[0]).unwrap(),
            b"accepted\n"
        );
        fixture.write("outline.md", b"uncommitted\n");
        fixture
            .update("outline.md", "snapshot", None, "尝试另一写法")
            .unwrap();
        let index = load(&fixture.root).unwrap();
        assert!(index.versions[1].git_blob.is_none());
        assert_eq!(
            content(&fixture.root, &index.versions[1]).unwrap(),
            b"uncommitted\n"
        );
        assert_eq!(
            content(&fixture.root, &index.versions[0]).unwrap(),
            b"accepted\n"
        );
        assert!(crate::workspaces::run_git_raw(
            &fixture.root,
            &["check-ignore", ".ccode/versions/index.json"]
        )
        .is_ok());
    }

    #[test]
    fn only_selected_changed_accepted_files_are_captured_from_frozen_content() {
        let fixture = Fixture::new();
        fixture.write("figure.png", b"old\0image");
        fixture.update("figure.png", "track", None, "").unwrap();
        let review = fixture.review("figure.png", b"new\0image");
        fixture.write("figure.png", b"edited after acceptance");
        capture_accepted(&fixture.root, &save("figure.png", "save-1"), &review).unwrap();
        capture_accepted(&fixture.root, &save("figure.png", "save-1"), &review).unwrap();
        capture_accepted(&fixture.root, &save("figure.png", "save-2"), &review).unwrap();
        let index = load(&fixture.root).unwrap();
        assert_eq!(index.versions.len(), 2);
        assert_eq!(
            content(&fixture.root, &index.versions[1]).unwrap(),
            b"new\0image"
        );
        assert_eq!(
            fs::read(fixture.root.join("figure.png")).unwrap(),
            b"edited after acceptance"
        );
        let other = fixture.review("other.png", b"not selected");
        capture_accepted(&fixture.root, &save("other.png", "save-3"), &other).unwrap();
        assert_eq!(load(&fixture.root).unwrap().versions.len(), 2);
        fixture.update("figure.png", "untrack", None, "").unwrap();
        let newer = fixture.review("figure.png", b"another image");
        capture_accepted(&fixture.root, &save("figure.png", "save-4"), &newer).unwrap();
        assert_eq!(load(&fixture.root).unwrap().versions.len(), 2);
    }

    #[test]
    fn mismatched_frozen_content_is_not_registered() {
        let fixture = Fixture::new();
        fixture.write("figure.png", b"old");
        fixture.update("figure.png", "track", None, "").unwrap();
        let review = fixture.review("figure.png", b"reviewed");
        fixture.write("frozen/figure.png", b"tampered");
        assert!(capture_accepted(&fixture.root, &save("figure.png", "save-1"), &review).is_err());
        assert_eq!(load(&fixture.root).unwrap().versions.len(), 1);
    }

    #[test]
    fn copies_share_content_and_deleting_one_never_removes_another() {
        let fixture = Fixture::new();
        fixture.write("file.docx", b"docx\0bytes");
        fixture
            .update("file.docx", "snapshot", None, "one")
            .unwrap();
        fixture
            .update("file.docx", "snapshot", None, "two")
            .unwrap();
        let index = load(&fixture.root).unwrap();
        assert_eq!(
            fs::read_dir(fixture.root.join(".ccode/versions/objects"))
                .unwrap()
                .count(),
            1
        );
        fixture
            .update("file.docx", "delete", Some(&index.versions[0].id), "")
            .unwrap();
        assert_eq!(
            content(&fixture.root, &index.versions[1]).unwrap(),
            b"docx\0bytes"
        );
        fixture
            .update("file.docx", "delete", Some(&index.versions[1].id), "")
            .unwrap();
        assert_eq!(
            fs::read_dir(fixture.root.join(".ccode/versions/objects"))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(
            fs::read(fixture.root.join("file.docx")).unwrap(),
            b"docx\0bytes"
        );
    }

    #[test]
    fn deleted_files_remain_available_and_export_cannot_overwrite_or_escape() {
        let fixture = Fixture::new();
        fixture.write("draft.md", b"my draft");
        fixture
            .update("draft.md", "snapshot", None, "before deleting")
            .unwrap();
        let index = load(&fixture.root).unwrap();
        let id = &index.versions[0].id;
        fs::remove_file(fixture.root.join("draft.md")).unwrap();
        let listed = view(&fixture.root, load(&fixture.root).unwrap(), None, None).unwrap();
        assert!(!listed.files[0].exists);
        assert_eq!(listed.files[0].versions.len(), 1);
        let exported = export_at(&fixture.root, id, "draft-copy.md").unwrap();
        assert_eq!(fs::read(exported).unwrap(), b"my draft");
        assert!(export_at(&fixture.root, id, "draft-copy.md").is_err());
        for target in [
            "../escaped.md",
            "/tmp/escaped.md",
            ".ccode/versions/new.md",
            "C:\\escaped.md",
        ] {
            assert!(export_at(&fixture.root, id, target).is_err(), "{target}");
        }
    }

    #[test]
    fn corrupt_index_is_not_silently_replaced() {
        let fixture = Fixture::new();
        fixture.write("draft.md", b"my draft");
        fixture.write(".ccode/versions/index.json", b"broken");
        assert!(fixture.update("draft.md", "track", None, "").is_err());
        assert_eq!(
            fs::read(fixture.root.join(".ccode/versions/index.json")).unwrap(),
            b"broken"
        );
    }

    #[test]
    fn comparison_reads_current_disk_without_saving_or_replacing_history() {
        let fixture = Fixture::new();
        fixture.write("draft.md", b"old paragraph");
        fixture.update("draft.md", "snapshot", None, "old").unwrap();
        let version = load(&fixture.root).unwrap().versions[0].clone();
        let original_index = fs::read(fixture.root.join(".ccode/versions/index.json")).unwrap();
        fixture.write("draft.md", b"current paragraph");
        let comparison =
            comparison_at(&fixture.root, &fixture.root, &version.id, None, false).unwrap();
        assert_eq!(comparison.before.as_deref(), Some("old paragraph"));
        assert_eq!(comparison.after.as_deref(), Some("current paragraph"));
        assert_eq!(
            fs::read(fixture.root.join(".ccode/versions/index.json")).unwrap(),
            original_index
        );
        fixture.update("draft.md", "snapshot", None, "new").unwrap();
        let second = load(&fixture.root).unwrap().versions[1].id.clone();
        let comparison = comparison_at(
            &fixture.root,
            &fixture.root,
            &version.id,
            Some(&second),
            false,
        )
        .unwrap();
        assert_eq!(comparison.after.as_deref(), Some("current paragraph"));
        assert_eq!(content(&fixture.root, &version).unwrap(), b"old paragraph");
        assert_eq!(
            fs::read(fixture.root.join("draft.md")).unwrap(),
            b"current paragraph"
        );
        assert_ne!(
            fs::read(fixture.root.join(".ccode/versions/index.json")).unwrap(),
            original_index
        );
        fs::remove_file(fixture.root.join("draft.md")).unwrap();
        assert!(comparison_at(&fixture.root, &fixture.root, &version.id, None, false).is_err());
        assert!(comparison_at(
            &fixture.root,
            &fixture.root,
            &version.id,
            Some(&second),
            false
        )
        .is_ok());
    }

    #[test]
    fn comparison_limits_size_rejects_other_files_and_redacts_text() {
        let fixture = Fixture::new();
        fixture.write("draft.md", b"original");
        fixture.update("draft.md", "snapshot", None, "").unwrap();
        let id = load(&fixture.root).unwrap().versions[0].id.clone();
        fixture.write("other.md", b"other");
        fixture.update("other.md", "snapshot", None, "").unwrap();
        let other = load(&fixture.root).unwrap().versions[1].id.clone();
        assert!(comparison_at(&fixture.root, &fixture.root, &id, Some(&other), false).is_err());
        fixture.write("draft.md", &vec![b'a'; 512 * 1024 + 1]);
        assert!(comparison_at(&fixture.root, &fixture.root, &id, None, false).is_err());
        fixture.write("draft.md", b"binary\0content");
        assert!(comparison_at(&fixture.root, &fixture.root, &id, None, false).is_err());
        fixture.write("draft.md", b"sk-abcdefghijklmnopqrstuvwxyz0123456789");
        let comparison = comparison_at(&fixture.root, &fixture.root, &id, None, false).unwrap();
        assert!(!comparison
            .after
            .unwrap()
            .contains("sk-abcdefghijklmnopqrstuvwxyz"));
    }

    #[test]
    fn image_comparison_freezes_both_sides_and_reuses_unchanged_pair() {
        let fixture = Fixture::new();
        fixture.write("figure.png", b"old\0png");
        fixture.update("figure.png", "snapshot", None, "").unwrap();
        let id = load(&fixture.root).unwrap().versions[0].id.clone();
        fixture.write("figure.png", b"new\0png");
        let first = comparison_at(&fixture.root, &fixture.root, &id, None, true).unwrap();
        let next = comparison_at(&fixture.root, &fixture.root, &id, None, true).unwrap();
        assert_eq!(first.before_path, next.before_path);
        assert_eq!(first.after_path, next.after_path);
        assert_eq!(fs::read(first.before_path.unwrap()).unwrap(), b"old\0png");
        assert_eq!(fs::read(first.after_path.unwrap()).unwrap(), b"new\0png");
        assert_eq!(
            fs::read(fixture.root.join("figure.png")).unwrap(),
            b"new\0png"
        );
        assert_eq!(load(&fixture.root).unwrap().versions.len(), 1);
    }

    #[test]
    fn system_save_defaults_next_to_original_and_allows_selected_external_directory() {
        let fixture = Fixture::new();
        fixture.write("manuscript/draft.docx", b"draft\0bytes");
        fixture
            .update("manuscript/draft.docx", "snapshot", None, "")
            .unwrap();
        let version = load(&fixture.root).unwrap().versions.remove(0);
        let (directory, name) = export_default(&fixture.root, &version.path).unwrap();
        assert_eq!(directory, fixture.root.join("manuscript"));
        assert_eq!(name, "draft-副本.docx");
        let outside = fixture
            .root
            .parent()
            .unwrap()
            .join(format!("mesa-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&outside).unwrap();
        let dest = outside.join("chosen.docx");
        let exported = export_to_path(&fixture.root, &version.id, &dest).unwrap();
        assert_eq!(fs::read(&exported).unwrap(), b"draft\0bytes");
        assert_eq!(
            fs::read(fixture.root.join("manuscript/draft.docx")).unwrap(),
            b"draft\0bytes"
        );
        assert!(export_to_path(&fixture.root, &version.id, &dest).is_err());
        assert!(export_to_path(
            &fixture.root,
            &version.id,
            &fixture.root.join("manuscript/draft.docx")
        )
        .is_err());
        assert!(export_to_path(&fixture.root, &version.id, Path::new("relative.docx")).is_err());
        assert!(export_to_path(
            &fixture.root,
            &version.id,
            &fixture.root.join(".ccode/secret.docx")
        )
        .is_err());
        fixture.write(
            ".ccode/project.toml",
            b"name = 'project'\nprotected_paths = ['manuscript']\n",
        );
        assert!(export_to_path(
            &fixture.root,
            &version.id,
            &fixture.root.join("manuscript/protected.docx")
        )
        .is_err());
        assert!(!fixture.root.join("manuscript/protected.docx").exists());
        assert_eq!(load(&fixture.root).unwrap().versions.len(), 1);
        fs::remove_file(fixture.root.join("manuscript/draft.docx")).unwrap();
        fs::remove_dir(fixture.root.join("manuscript")).unwrap();
        assert_eq!(
            export_default(&fixture.root, &version.path).unwrap().0,
            fixture.root
        );
        fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn native_selected_dest_cannot_replace_a_dangling_link_or_enter_internal_metadata() {
        let fixture = Fixture::new();
        fixture.write("draft.md", b"draft");
        fixture.update("draft.md", "snapshot", None, "").unwrap();
        let id = load(&fixture.root).unwrap().versions[0].id.clone();
        let link = fixture.root.join("dangling.md");
        std::os::unix::fs::symlink(fixture.root.join("missing.md"), &link).unwrap();
        assert!(export_to_path(&fixture.root, &id, &link).is_err());
        std::os::unix::fs::symlink(
            fixture.root.join(".ccode"),
            fixture.root.join("metadata-link"),
        )
        .unwrap();
        assert!(export_to_path(
            &fixture.root,
            &id,
            &fixture.root.join("metadata-link/copy.md")
        )
        .is_err());
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!fixture.root.join(".ccode/copy.md").exists());
    }

    #[test]
    fn manually_kept_drafts_remain_in_the_step_before_any_acceptance() {
        let fixture = Fixture::new();
        fixture.write("draft.md", b"unaccepted draft");
        update_at(
            &fixture.root,
            &fixture.root.join("draft.md"),
            "draft.md",
            "snapshot",
            None,
            "保留的尝试",
            Some("step"),
        )
        .unwrap();
        fs::remove_file(fixture.root.join("draft.md")).unwrap();
        let result = view(
            &fixture.root,
            load(&fixture.root).unwrap(),
            None,
            Some("step"),
        )
        .unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].versions.len(), 1);
        assert!(!result.files[0].exists);
    }

    #[test]
    fn selecting_a_file_can_read_existing_git_save_versions() {
        let fixture = Fixture::new();
        fixture.write("outline.md", b"first version");
        let first = fixture.commit("outline.md");
        crate::projects::append_acceptance_log_at(&fixture.root, &save("outline.md", &first))
            .unwrap();
        fixture.write("outline.md", b"second version");
        fixture.commit("outline.md");
        fixture.update("outline.md", "track", None, "").unwrap();
        let index = load(&fixture.root).unwrap();
        assert_eq!(index.versions.len(), 2);
        assert_eq!(
            content(&fixture.root, &index.versions[0]).unwrap(),
            b"first version"
        );
        assert_eq!(
            content(&fixture.root, &index.versions[1]).unwrap(),
            b"second version"
        );
    }

    #[test]
    fn git_history_is_readable_without_tracking_even_after_the_current_file_is_removed() {
        let fixture = Fixture::new();
        fixture.write("outline.md", b"first accepted version");
        let first = fixture.commit("outline.md");
        let mut first_save = save("outline.md", &first);
        first_save.decided_at = "2026-11-11T14:00:00+08:00".into();
        crate::projects::append_acceptance_log_at(&fixture.root, &first_save).unwrap();
        fixture.write("outline.md", b"second accepted version");
        let second = fixture.commit("outline.md");
        crate::projects::append_acceptance_log_at(&fixture.root, &save("outline.md", &second))
            .unwrap();
        fs::remove_file(fixture.root.join("outline.md")).unwrap();
        let result = view(
            &fixture.root,
            load(&fixture.root).unwrap(),
            Some("outline.md"),
            Some("step"),
        )
        .unwrap();
        assert!(!result.files[0].exists);
        assert!(!result.files[0].tracked);
        assert_eq!(result.files[0].versions.len(), 2);
        assert!(!fixture.root.join(".ccode/versions/index.json").exists());
        let newest = selected(&fixture.root, &result.files[0].versions[0].id).unwrap();
        assert_eq!(
            content(&fixture.root, &newest).unwrap(),
            b"second accepted version"
        );
        let exported = export_at(&fixture.root, &newest.id, "outline-copy.md").unwrap();
        assert_eq!(fs::read(exported).unwrap(), b"second accepted version");
        assert!(!fixture.root.join(".ccode/versions/index.json").exists());
        assert!(selected(&fixture.root, &format!("git:{second}:other.md")).is_err());
        assert!(selected(&fixture.root, &format!("git:{second}:../outside.md")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_sources_and_destinations_are_refused() {
        let fixture = Fixture::new();
        fixture.write("draft.md", b"my draft");
        std::os::unix::fs::symlink(fixture.root.join("draft.md"), fixture.root.join("link.md"))
            .unwrap();
        assert!(location(fixture.root.to_str().unwrap(), Some("link.md")).is_err());
        std::os::unix::fs::symlink(
            fixture.root.join("draft.md"),
            fixture.root.join(".ccode/versions"),
        )
        .unwrap();
        assert!(load(&fixture.root).is_err());
    }
}
