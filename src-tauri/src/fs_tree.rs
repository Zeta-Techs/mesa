//! 工作树（§6.9）：目录列举与只读文件预览。
//! 预览路径被限制在调用方给出的项目根内（canonicalize 后前缀校验，防 ../ 逃逸）。

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::PathBuf;

const LIST_CAP: usize = 2000;
const PREVIEW_CAP: usize = 256 * 1024;
const BINARY_SNIFF: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>, // ISO 时间
    /// 家目录直下的系统目录（macOS 的 Library 等）：前端置灰降噪，交互不受影响
    pub is_system: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreviewDto {
    pub text: String,
    pub truncated: bool,
    pub revision: Option<String>,
    #[serde(rename = "readOnlyReason")]
    pub read_only_reason: Option<String>,
}

fn expand_tilde(path: &str) -> String {
    crate::paths::expand_tilde(path)
}

/// 家目录直下的系统目录清单（按平台）：只用于置灰降噪，宁缺毋滥。
/// Linux 的系统配置目录多为 `.` 开头，已被隐藏过滤，无需清单。
#[cfg(target_os = "macos")]
const HOME_SYSTEM_DIRS: &[&str] = &["Library", "Applications"];
#[cfg(target_os = "windows")]
const HOME_SYSTEM_DIRS: &[&str] = &["AppData", "Application Data", "Local Settings"];
#[cfg(all(unix, not(target_os = "macos")))]
const HOME_SYSTEM_DIRS: &[&str] = &[];

/// 条目是否「家目录直下的系统目录」（纯函数，便于单测；parent 需已展开 ~）
fn is_home_system_dir(parent: &std::path::Path, is_dir: bool, name: &str) -> bool {
    if !is_dir || HOME_SYSTEM_DIRS.is_empty() {
        return false;
    }
    dirs::home_dir().is_some_and(|h| h == parent) && HOME_SYSTEM_DIRS.contains(&name)
}

/// unix 秒 → ISO UTC（civil from days，与 sessions.rs 同款算法）
fn iso_from_unix(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let tod = secs % 86400;
    let (h, m, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn list_dir_sync(path: &str, show_hidden: bool) -> Result<Vec<DirEntryDto>, String> {
    let dir = expand_tilde(path);
    let rd = fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))?;
    let mut entries = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        // .ccode 目录豁免：任务书草稿（drafts/）等是用户要找的内容，默认隐藏会让人找不到
        // （预览关掉后只能从这里重新打开）；其余点开头条目照旧隐藏
        if !show_hidden && name.starts_with('.') && name != ".ccode" {
            continue;
        }
        // 读不到元数据的条目（坏链接、权限不足）静默跳过
        let Ok(md) = e.metadata() else {
            continue;
        };
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| iso_from_unix(d.as_secs()));
        entries.push(DirEntryDto {
            is_system: is_home_system_dir(std::path::Path::new(&dir), md.is_dir(), &name),
            name,
            path: e.path().to_string_lossy().into_owned(),
            is_dir: md.is_dir(),
            size: if md.is_dir() { 0 } else { md.len() },
            modified,
        });
        if entries.len() >= LIST_CAP {
            break;
        }
    }
    // 目录在前，组内按名称（忽略大小写）排序
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries.truncate(LIST_CAP);
    Ok(entries)
}

/// Automatic report reads may not follow external symlinks, unlike explicit manual previews.
fn require_inside_root(path: &str, root: &str) -> Result<(), String> {
    let path = PathBuf::from(expand_tilde(path));
    let root = PathBuf::from(expand_tilde(root));
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("路径超出项目根目录，拒绝读取".into());
    }
    let path = crate::paths::canonicalize_plain(&path).map_err(|e| format!("路径不可读: {e}"))?;
    let root =
        crate::paths::canonicalize_plain(&root).map_err(|e| format!("项目根目录无效: {e}"))?;
    if !crate::paths::path_within_path(&path, &root) {
        return Err("符号链接或路径指向项目根目录之外，拒绝自动读取".into());
    }
    Ok(())
}

pub(crate) fn read_file_preview_sync(path: &str, root: &str) -> Result<FilePreviewDto, String> {
    read_capped_sync(path, root, PREVIEW_CAP)
}

fn read_capped_sync(path: &str, root: &str, cap: usize) -> Result<FilePreviewDto, String> {
    let root_exp = expand_tilde(root);
    let path_exp = expand_tilde(path);
    // 保留用户从树中预览外链 symlink 的能力，但不允许 ../ 绕过词法根边界。
    if std::path::Path::new(&path_exp)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
        || !(crate::paths::path_within(&path_exp, &root_exp) || root_exp == "/")
    {
        return Err("路径超出项目根目录，拒绝预览".into());
    }
    let root_c = crate::paths::canonicalize_plain(std::path::Path::new(&root_exp))
        .map_err(|e| format!("项目根目录无效: {e}"))?;
    let path_c = crate::paths::canonicalize_plain(std::path::Path::new(&path_exp))
        .map_err(|e| format!("文件不存在或不可读: {e}"))?;
    let md = fs::metadata(&path_c).map_err(|e| format!("读取文件失败: {e}"))?;
    if md.is_dir() {
        return Err("目录不支持预览".into());
    }
    if !md.is_file() {
        return Err("仅支持预览普通文件".into());
    }
    let f = fs::File::open(&path_c).map_err(|e| format!("打开文件失败: {e}"))?;
    let mut buf = Vec::new();
    f.take((cap + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取文件失败: {e}"))?;
    // 二进制检测：前 8KB 出现 NUL 即判二进制
    if buf.iter().take(BINARY_SNIFF).any(|b| *b == 0) {
        return Err("二进制文件不支持预览".into());
    }
    let truncated = buf.len() > cap;
    if truncated {
        buf.truncate(cap);
    }
    let read_only_reason = if truncated {
        Some(format!(
            "文件超过 {} KB，仅预览开头部分，不能保存",
            cap / 1024
        ))
    } else if !(crate::paths::path_within_path(&path_c, &root_c)
        || root_c == std::path::Path::new("/"))
    {
        Some("符号链接指向项目根目录之外，仅支持预览".into())
    } else if std::str::from_utf8(&buf).is_err() {
        Some("文件不是有效 UTF-8，仅支持预览，避免保存时改变编码".into())
    } else {
        None
    };
    Ok(FilePreviewDto {
        revision: read_only_reason.is_none().then(|| preview_revision(&buf)),
        text: String::from_utf8_lossy(&buf).into_owned(),
        truncated,
        read_only_reason,
    })
}

#[tauri::command]
pub async fn list_dir(
    path: String,
    show_hidden: bool,
    root: Option<String>,
) -> Result<Vec<DirEntryDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(root) = root {
            require_inside_root(&path, &root)?;
        }
        list_dir_sync(&path, show_hidden)
    })
    .await
    .map_err(|e| format!("读取目录失败: {e}"))?
}

#[tauri::command]
pub async fn read_file_preview(
    path: String,
    root: String,
    require_within_root: Option<bool>,
) -> Result<FilePreviewDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if require_within_root.unwrap_or(false) {
            require_inside_root(&path, &root)?;
        }
        read_file_preview_sync(&path, &root)
    })
    .await
    .map_err(|e| format!("读取文件失败: {e}"))?
}

fn preview_revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// 序列化 Mesa 内的“比较版本→替换”，避免两个预览用同一旧版本同时保存。
static PREVIEW_SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 保存必须携带读取时的版本；已截断、外链、编码不支持或磁盘已变更一律拒绝。
fn save_file_preview_sync(
    path: &str,
    root: &str,
    text: &str,
    expected_revision: &str,
) -> Result<String, String> {
    if text.len() > PREVIEW_CAP {
        return Err("文件超过 256 KB，暂不支持在预览里保存".into());
    }
    let _guard = PREVIEW_SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _file_guard = crate::storage::config_lock("preview-save")?;
    // 定稿选定的目标期刊。文件第一次还不存在，只允许新建这一份。
    let expanded = expand_tilde(path);
    let rel = expanded.replace('\\', "/");
    if !std::path::Path::new(&expanded).exists()
        && expected_revision == "new"
        && (rel.ends_with("/submission/target-journal.md") || rel.ends_with("submission/target-journal.md"))
        && !rel.contains("..")
    {
        let root_c = crate::paths::canonicalize_plain(std::path::Path::new(&expand_tilde(root)))
            .map_err(|e| format!("项目根目录无效: {e}"))?;
        let parent = std::path::Path::new(&expanded)
            .parent()
            .ok_or_else(|| "路径没有父目录".to_string())?;
        fs::create_dir_all(parent).map_err(|e| format!("建立投稿目录失败: {e}"))?;
        let parent_c = crate::paths::canonicalize_plain(parent)
            .map_err(|e| format!("父目录无效: {e}"))?;
        if !crate::paths::path_within_path(&parent_c, &root_c) {
            return Err("路径超出项目根目录，拒绝写入".into());
        }
        crate::profiles::atomic_write(std::path::Path::new(&expanded), text)?;
        return Ok(preview_revision(text.as_bytes()));
    }
    let current = read_file_preview_sync(path, root)?;
    if let Some(reason) = current.read_only_reason {
        return Err(reason);
    }
    if current.revision.as_deref() != Some(expected_revision) {
        return Err("文件已被 Agent 或其他程序修改，未覆盖磁盘内容。请先保留本次编辑，再重新打开文件对比合并。".into());
    }
    let root_c = crate::paths::canonicalize_plain(std::path::Path::new(&expand_tilde(root)))
        .map_err(|e| format!("项目根目录无效: {e}"))?;
    let path_c = crate::paths::canonicalize_plain(std::path::Path::new(&expand_tilde(path)))
        .map_err(|e| format!("文件不存在或不可读: {e}"))?;
    if !(crate::paths::path_within_path(&path_c, &root_c) || root_c == std::path::Path::new("/")) {
        return Err("路径超出项目根目录，拒绝写入".into());
    }
    crate::profiles::atomic_write(&path_c, text)?;
    Ok(preview_revision(text.as_bytes()))
}

/// 科研台账（纳入清单、待获取、两份 RIS、笔记索引、引文库）的整份读写上限。
/// 预览通道 256 KB 封顶，但检索一轮带摘要的 included.json 两百篇就到 300 KB：
/// 截断后待确认清单整块读不出来（界面误报「还没有 included.json」），纳入/排除也存不回去。
const LEDGER_CAP: usize = 16 * 1024 * 1024;

/// 只认这几份台账（项目根或工作区根下的相对路径）：别的文件照旧走 256 KB 预览通道。
const LEDGER_FILES: &[&str] = &[
    "papers/included.json",
    "papers/included.md",
    "papers/to-fetch.md",
    "papers/to-fetch.ris",
    "papers/endnote-import.ris",
    "papers/screening.md",
    "notes/index.json",
    "references.bib",
];

/// 校验路径落在根内且是白名单台账，返回规范化后的绝对路径。
fn ledger_target(path: &str, root: &str) -> Result<(PathBuf, PathBuf), String> {
    let root_c = crate::paths::canonicalize_plain(std::path::Path::new(&expand_tilde(root)))
        .map_err(|e| format!("项目根目录无效: {e}"))?;
    let path_exp = PathBuf::from(expand_tilde(path));
    if path_exp
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("路径超出项目根目录，拒绝读写".into());
    }
    let path_c = crate::paths::canonicalize_plain(&path_exp)
        .map_err(|e| format!("文件不存在或不可读: {e}"))?;
    if !crate::paths::path_within_path(&path_c, &root_c) {
        return Err("符号链接或路径指向项目根目录之外，拒绝读写".into());
    }
    let rel = path_c
        .strip_prefix(&root_c)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    if !LEDGER_FILES.iter().any(|name| *name == rel) {
        return Err(format!("不是科研台账文件：{rel}"));
    }
    Ok((path_c, root_c))
}

fn read_research_ledger_sync(path: &str, root: &str) -> Result<FilePreviewDto, String> {
    let (path_c, root_c) = ledger_target(path, root)?;
    read_capped_sync(
        &path_c.to_string_lossy(),
        &root_c.to_string_lossy(),
        LEDGER_CAP,
    )
}

fn save_research_ledger_sync(
    path: &str,
    root: &str,
    text: &str,
    expected_revision: &str,
) -> Result<String, String> {
    if text.len() > LEDGER_CAP {
        return Err("台账超过 16 MB，不能在 Mesa 里改".into());
    }
    let (path_c, root_c) = ledger_target(path, root)?;
    // 与预览保存同一把锁：两条通道改的可能是同一份文件
    let _guard = PREVIEW_SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _file_guard = crate::storage::config_lock("preview-save")?;
    let current = read_capped_sync(
        &path_c.to_string_lossy(),
        &root_c.to_string_lossy(),
        LEDGER_CAP,
    )?;
    if let Some(reason) = current.read_only_reason {
        return Err(reason);
    }
    if current.revision.as_deref() != Some(expected_revision) {
        return Err("文件已被 Agent 或其他程序修改，未覆盖磁盘内容。请重新打开清单再改。".into());
    }
    crate::profiles::atomic_write(&path_c, text)?;
    Ok(preview_revision(text.as_bytes()))
}

#[tauri::command]
pub async fn read_research_ledger(path: String, root: String) -> Result<FilePreviewDto, String> {
    tauri::async_runtime::spawn_blocking(move || read_research_ledger_sync(&path, &root))
        .await
        .map_err(|e| format!("读取文件失败: {e}"))?
}

#[tauri::command]
pub async fn save_research_ledger(
    path: String,
    root: String,
    text: String,
    expected_revision: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_research_ledger_sync(&path, &root, &text, &expected_revision)
    })
    .await
    .map_err(|e| format!("保存文件失败: {e}"))?
}

/// 从整份 RIS 里拿掉 DOI 或标题对得上的条目。预览通道只读 256 KB，
/// 检索清单的 RIS 经常更大，移出不能走那条路。文件不在项目根、或不是普通文件，拒绝。
fn drop_ris_record_sync(path: &str, root: &str, doi: &str, title: &str) -> Result<bool, String> {
    let root_c = crate::paths::canonicalize_plain(std::path::Path::new(&expand_tilde(root)))
        .map_err(|e| format!("项目根目录无效: {e}"))?;
    let path_c = crate::paths::canonicalize_plain(std::path::Path::new(&expand_tilde(path)))
        .map_err(|_| "文件不存在".to_string())?;
    if !crate::paths::path_within_path(&path_c, &root_c) {
        return Err("路径超出项目根目录，拒绝写入".into());
    }
    let name = path_c
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if name != "to-fetch.ris" && name != "endnote-import.ris" {
        return Err("只能改检索步的两份 RIS".into());
    }
    let original = fs::read_to_string(&path_c).map_err(|e| format!("读取 RIS 失败: {e}"))?;
    let doi_key = doi.trim().trim_start_matches("doi:").trim().to_ascii_lowercase();
    let title_key = title.trim().to_ascii_lowercase();
    if doi_key.is_empty() && title_key.is_empty() {
        return Ok(false);
    }
    let newline = if original.contains("\r\n") { "\r\n" } else { "\n" };
    let mut kept: Vec<String> = Vec::new();
    let mut removed = false;
    for block in original.split("\nER  -") {
        let body = block.trim();
        if body.is_empty() {
            continue;
        }
        let mut hit = false;
        for line in body.lines() {
            let line = line.trim().trim_start_matches('\u{feff}');
            let Some((tag, value)) = line.split_once("  - ") else { continue };
            let value = value.trim();
            if !doi_key.is_empty() && tag.trim() == "DO" && value.to_ascii_lowercase() == doi_key {
                hit = true;
            }
            if !title_key.is_empty() && tag.trim() == "TI" && value.to_ascii_lowercase() == title_key {
                hit = true;
            }
        }
        if hit {
            removed = true;
            continue;
        }
        kept.push(format!("{body}{newline}ER  - "));
    }
    if !removed {
        return Ok(false);
    }
    let next = if kept.is_empty() {
        String::new()
    } else {
        format!("{}{newline}", kept.join(&format!("{newline}{newline}")))
    };
    crate::profiles::atomic_write(&path_c, &next)?;
    Ok(true)
}

/// 从整份 to-fetch.md 拿掉含 DOI 或标题的行。编号不重排。超过预览上限的清单也能改。
fn drop_fetch_line_sync(path: &str, root: &str, doi: &str, title: &str) -> Result<bool, String> {
    let root_c = crate::paths::canonicalize_plain(std::path::Path::new(&expand_tilde(root)))
        .map_err(|e| format!("项目根目录无效: {e}"))?;
    let path_c = crate::paths::canonicalize_plain(std::path::Path::new(&expand_tilde(path)))
        .map_err(|_| "文件不存在".to_string())?;
    if !crate::paths::path_within_path(&path_c, &root_c) {
        return Err("路径超出项目根目录，拒绝写入".into());
    }
    if path_c.file_name().and_then(|n| n.to_str()) != Some("to-fetch.md") {
        return Err("只能改 papers/to-fetch.md".into());
    }
    let original = fs::read_to_string(&path_c).map_err(|e| format!("读取待获取失败: {e}"))?;
    let doi_key = doi.trim().trim_start_matches("doi:").trim().to_ascii_lowercase();
    let title_key = title.trim();
    if doi_key.is_empty() && title_key.is_empty() {
        return Ok(false);
    }
    let mut kept = Vec::new();
    let mut removed = false;
    for line in original.split_inclusive('\n') {
        let lower = line.to_ascii_lowercase();
        let hit = (!doi_key.is_empty() && lower.contains(&doi_key))
            || (!title_key.is_empty() && line.contains(title_key));
        if hit {
            removed = true;
            continue;
        }
        kept.push(line);
    }
    if !removed {
        return Ok(false);
    }
    crate::profiles::atomic_write(&path_c, &kept.concat())?;
    Ok(true)
}

#[tauri::command]
pub async fn drop_fetch_line(
    path: String,
    root: String,
    doi: String,
    title: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || drop_fetch_line_sync(&path, &root, &doi, &title))
        .await
        .map_err(|e| format!("改写待获取失败: {e}"))?
}

/// 移出时从整份 RIS 删除一条。返回是否真的删掉了。文件不存在时 removed=false，不报错。
#[tauri::command]
pub async fn drop_ris_record(
    path: String,
    root: String,
    doi: String,
    title: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || drop_ris_record_sync(&path, &root, &doi, &title))
        .await
        .map_err(|e| format!("改写 RIS 失败: {e}"))?
}

#[tauri::command]
pub async fn save_file_preview(
    path: String,
    root: String,
    text: String,
    expected_revision: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_file_preview_sync(&path, &root, &text, &expected_revision)
    })
    .await
    .map_err(|e| format!("保存文件失败: {e}"))?
}

// ===== 目录监听（P4）：notify 递归监听 + 500ms 防抖，事件 fs-changed-<id> =====

struct WatchEntry {
    _watcher: notify::RecommendedWatcher,
}

static WATCHERS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, WatchEntry>>,
> = std::sync::OnceLock::new();

fn watchers() -> &'static std::sync::Mutex<std::collections::HashMap<String, WatchEntry>> {
    WATCHERS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 监听噪声过滤：隐藏目录段（/.foo/）、.git、node_modules 下的事件不触发刷新。
/// agent 会话文件和应用 db 都写在隐藏目录，home 根监听时不过滤会形成刷新风暴
fn fs_noise_skip(path: &std::path::Path) -> bool {
    let s = norm_sep(&path.to_string_lossy());
    if s.contains("/.git/")
        || s.contains("/node_modules/")
        || s.contains("/target/")
        || s.contains("/dist/")
    {
        return true;
    }
    // .ccode 豁免：drafts（任务书草稿）/help-wanted 等是应用自己展示的内容，
    // AI 改稿必须能触发预览实时重载（「跟 AI 商量一下」的草稿就在 .ccode/drafts/ 下）
    if s.contains("/.ccode/") {
        return false;
    }
    let mut idx = 0;
    while let Some(pos) = s[idx..].find("/.") {
        let abs = idx + pos;
        // "/.foo/" 形式 = 隐藏目录段；路径末尾的隐藏文件（如 .env）放行
        if s[abs + 2..].contains('/') {
            return true;
        }
        idx = abs + 2;
        if idx >= s.len() {
            break;
        }
    }
    false
}

#[tauri::command]
pub fn watch_dir(app: tauri::AppHandle, path: String) -> Result<String, String> {
    use tauri::Emitter;
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| !fs_noise_skip(p)) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| format!("创建文件监听失败: {e}"))?;
    notify::Watcher::watch(
        &mut watcher,
        std::path::Path::new(&expand_tilde(&path)),
        notify::RecursiveMode::Recursive,
    )
    .map_err(|e| format!("监听目录失败: {e}"))?;

    // 防抖线程：事件涌入时等静默 500ms 再发一次
    let event = format!("fs-changed-{id}");
    std::thread::spawn(move || loop {
        match rx.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(_) => {
                while rx
                    .recv_timeout(std::time::Duration::from_millis(500))
                    .is_ok()
                {
                    // 持续有事件，继续等静默
                }
                let _ = app.emit(&event, ());
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break, // watcher 已 drop
        }
    });

    watchers()
        .lock()
        .unwrap()
        .insert(id.clone(), WatchEntry { _watcher: watcher });
    Ok(id)
}

#[tauri::command]
pub fn unwatch_dir(id: String) -> Result<(), String> {
    watchers().lock().unwrap().remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ccode-fstree-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn list_dir_dirs_first_case_insensitive() {
        let dir = tmpdir("sort");
        fs::create_dir_all(dir.join("zeta")).unwrap();
        fs::create_dir_all(dir.join("Alpha")).unwrap();
        fs::write(dir.join("beta.txt"), "x").unwrap();
        fs::write(dir.join("Gamma.txt"), "x").unwrap();
        fs::write(dir.join(".hidden"), "x").unwrap();
        fs::create_dir_all(dir.join(".ccode/drafts")).unwrap();
        let entries = list_dir_sync(dir.to_str().unwrap(), false).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, [".ccode", "Alpha", "zeta", "beta.txt", "Gamma.txt"]);
        assert!(entries[0].is_dir && entries[1].is_dir);
        assert!(!entries[3].is_dir);
        assert!(entries[3].modified.is_some());
        assert!(!names.contains(&".hidden"), "默认不显示隐藏文件");
        assert!(names.contains(&".ccode"), ".ccode 目录豁免默认隐藏");
        let with_hidden = list_dir_sync(dir.to_str().unwrap(), true).unwrap();
        assert!(with_hidden.iter().any(|e| e.name == ".hidden"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preview_refuses_path_escape() {
        let root = tmpdir("root");
        let outside = tmpdir("outside");
        let secret = outside.join("secret.txt");
        fs::write(&secret, "nope").unwrap();
        // 直接给根外绝对路径
        let err =
            read_file_preview_sync(secret.to_str().unwrap(), root.to_str().unwrap()).unwrap_err();
        assert!(err.contains("超出项目根目录"), "{err}");
        // ../ 逃逸
        let escape = format!("{}/../", root.display());
        let err2 = read_file_preview_sync(&escape, root.to_str().unwrap()).unwrap_err();
        assert!(
            err2.contains("超出项目根目录") || err2.contains("目录"),
            "{err2}"
        );
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn preview_detects_binary_via_nul() {
        let dir = tmpdir("bin");
        let f = dir.join("bin.dat");
        fs::write(&f, b"abc\0def").unwrap();
        let err = read_file_preview_sync(f.to_str().unwrap(), dir.to_str().unwrap()).unwrap_err();
        assert_eq!(err, "二进制文件不支持预览");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn drop_ris_record_removes_one_block_past_preview_cap() {
        let dir = tmpdir("ris");
        let papers = dir.join("papers");
        fs::create_dir_all(&papers).unwrap();
        let path = papers.join("to-fetch.ris");
        let filler = format!("TY  - JOUR\r\nTI  - Filler\r\nAB  - {}\r\nER  - \r\n", "x".repeat(300));
        let mut body = filler.repeat(1000);
        body.push_str("TY  - JOUR\r\nTI  - Keep Me\r\nDO  - 10.1000/keep\r\nER  - \r\n");
        body.push_str("TY  - JOUR\r\nTI  - Drop Me\r\nDO  - 10.1000/drop\r\nER  - \r\n");
        fs::write(&path, &body).unwrap();
        assert!(body.len() > PREVIEW_CAP);
        let removed = drop_ris_record_sync(
            path.to_str().unwrap(),
            dir.to_str().unwrap(),
            "10.1000/drop",
            "Drop Me",
        )
        .unwrap();
        assert!(removed);
        let next = fs::read_to_string(&path).unwrap();
        assert!(!next.contains("Drop Me"));
        assert!(next.contains("Keep Me"));
        assert!(next.contains("Filler"));
        // 对不上不改文件；别的文件名拒绝
        assert!(!drop_ris_record_sync(path.to_str().unwrap(), dir.to_str().unwrap(), "10.9/no", "Nope").unwrap());
        let other = papers.join("notes.ris");
        fs::write(&other, "TY  - JOUR\r\nER  - \r\n").unwrap();
        assert!(drop_ris_record_sync(other.to_str().unwrap(), dir.to_str().unwrap(), "10.1000/drop", "").is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preview_truncates_at_cap() {
        let dir = tmpdir("cap");
        let f = dir.join("big.txt");
        fs::write(&f, "a".repeat(PREVIEW_CAP + 1000)).unwrap();
        let p = read_file_preview_sync(f.to_str().unwrap(), dir.to_str().unwrap()).unwrap();
        assert!(p.truncated);
        assert_eq!(p.text.len(), PREVIEW_CAP);
        let small = dir.join("small.txt");
        fs::write(&small, "hello").unwrap();
        let p2 = read_file_preview_sync(small.to_str().unwrap(), dir.to_str().unwrap()).unwrap();
        assert!(!p2.truncated);
        assert_eq!(p2.text, "hello");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_within_root_writes_content() {
        let dir = tmpdir("save");
        let f = dir.join("edit.txt");
        fs::write(&f, "old").unwrap();
        save_file_preview_sync(
            f.to_str().unwrap(),
            dir.to_str().unwrap(),
            "new content\n",
            &preview_revision(b"old"),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "new content\n");
        // 超限拒绝且不改动文件
        let big = "x".repeat(PREVIEW_CAP + 1);
        assert!(save_file_preview_sync(
            f.to_str().unwrap(),
            dir.to_str().unwrap(),
            &big,
            &preview_revision(b"new content\n")
        )
        .is_err());
        assert_eq!(fs::read_to_string(&f).unwrap(), "new content\n");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn research_ledger_reads_and_saves_past_preview_cap() {
        let dir = tmpdir("ledger");
        fs::create_dir_all(dir.join("papers")).unwrap();
        let json = dir.join("papers").join("included.json");
        // 两百篇带摘要的纳入清单量级：超过预览上限
        let big = format!("[{}]", "\"x\",".repeat(PREVIEW_CAP / 4) + "\"y\"");
        fs::write(&json, &big).unwrap();
        let root = dir.to_str().unwrap();
        let path = json.to_str().unwrap();
        assert!(read_file_preview_sync(path, root).unwrap().truncated);
        let read = read_research_ledger_sync(path, root).unwrap();
        assert!(!read.truncated);
        assert_eq!(read.text, big);
        let revision = read.revision.unwrap();
        let next = format!("{big}\n");
        let saved = save_research_ledger_sync(path, root, &next, &revision).unwrap();
        assert_eq!(fs::read_to_string(&json).unwrap(), next);
        // 旧版本再存一次：拒绝，不覆盖
        assert!(save_research_ledger_sync(path, root, "[]", &revision)
            .unwrap_err()
            .contains("已被 Agent"));
        assert_eq!(saved, preview_revision(next.as_bytes()));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn research_ledger_rejects_files_outside_whitelist() {
        let dir = tmpdir("ledger-deny");
        fs::create_dir_all(dir.join("papers")).unwrap();
        fs::write(dir.join("papers").join("notes.txt"), "x").unwrap();
        fs::write(dir.join("included.json"), "[]").unwrap();
        let root = dir.to_str().unwrap();
        for rel in ["papers/notes.txt", "included.json"] {
            let path = dir.join(rel);
            assert!(read_research_ledger_sync(path.to_str().unwrap(), root)
                .unwrap_err()
                .contains("不是科研台账"));
        }
        let outside = tmpdir("ledger-outside");
        fs::create_dir_all(outside.join("papers")).unwrap();
        fs::write(outside.join("papers").join("included.json"), "[]").unwrap();
        let escaped = dir.join("..").join(outside.file_name().unwrap()).join("papers/included.json");
        assert!(read_research_ledger_sync(escaped.to_str().unwrap(), root).is_err());
        fs::remove_dir_all(dir).ok();
        fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn preview_rejects_parent_traversal_to_file() {
        let dir = tmpdir("parent-traversal");
        let root = dir.join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.join("secret.txt"), "secret").unwrap();
        let escaped = root.join("..").join("secret.txt");
        assert!(read_file_preview_sync(escaped.to_str().unwrap(), root.to_str().unwrap()).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preview_save_rejects_external_change_and_growth() {
        let dir = tmpdir("save-conflict");
        let path = dir.join("note.md");
        fs::write(&path, "before").unwrap();
        let read =
            || read_file_preview_sync(path.to_str().unwrap(), dir.to_str().unwrap()).unwrap();
        let revision = read().revision.unwrap();
        fs::write(&path, "agent changed it").unwrap();
        let save = || {
            save_file_preview_sync(
                path.to_str().unwrap(),
                dir.to_str().unwrap(),
                "user edits",
                &revision,
            )
        };
        assert!(save().unwrap_err().contains("已被 Agent"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "agent changed it");
        fs::write(&path, "x".repeat(PREVIEW_CAP + 100)).unwrap();
        assert!(save().unwrap_err().contains("256 KB"));
        assert_eq!(
            fs::metadata(&path).unwrap().len(),
            (PREVIEW_CAP + 100) as u64
        );
        assert!(read().truncated);
        assert!(read().revision.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preview_revision_changes_after_save_and_rejects_stale_second_save() {
        let dir = tmpdir("revision");
        let path = dir.join("note.md");
        fs::write(&path, "before").unwrap();
        let first = read_file_preview_sync(path.to_str().unwrap(), dir.to_str().unwrap())
            .unwrap()
            .revision
            .unwrap();
        let second = save_file_preview_sync(
            path.to_str().unwrap(),
            dir.to_str().unwrap(),
            "after",
            &first,
        )
        .unwrap();
        assert_ne!(first, second);
        assert_eq!(
            read_file_preview_sync(path.to_str().unwrap(), dir.to_str().unwrap())
                .unwrap()
                .revision,
            Some(second)
        );
        assert!(save_file_preview_sync(
            path.to_str().unwrap(),
            dir.to_str().unwrap(),
            "stale",
            &first
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "after");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preview_invalid_utf8_is_readonly() {
        let dir = tmpdir("invalid-utf8");
        let path = dir.join("note.txt");
        fs::write(&path, [b'x', 0xff]).unwrap();
        let snapshot =
            read_file_preview_sync(path.to_str().unwrap(), dir.to_str().unwrap()).unwrap();
        assert!(snapshot.revision.is_none());
        assert!(snapshot.read_only_reason.unwrap().contains("UTF-8"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn save_rejects_path_escape() {
        let root = tmpdir("save-root");
        let outside = tmpdir("save-outside");
        let secret = outside.join("s.txt");
        fs::write(&secret, "nope").unwrap();
        let err = save_file_preview_sync(
            secret.to_str().unwrap(),
            root.to_str().unwrap(),
            "x",
            &preview_revision(b"nope"),
        )
        .unwrap_err();
        assert!(err.contains("超出项目根目录"), "{err}");
        assert_eq!(fs::read_to_string(&secret).unwrap(), "nope");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }
}

#[cfg(test)]
mod fix_tests {
    use super::*;

    #[test]
    fn automatic_report_paths_are_rooted() {
        let dir = std::env::temp_dir().join(format!("ccode-report-root-{}", uuid::Uuid::new_v4()));
        let root = dir.join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("report.md"), "summary").unwrap();
        fs::write(dir.join("outside.md"), "secret").unwrap();
        assert!(require_inside_root(
            root.join("report.md").to_str().unwrap(),
            root.to_str().unwrap()
        )
        .is_ok());
        assert!(require_inside_root(
            dir.join("outside.md").to_str().unwrap(),
            root.to_str().unwrap()
        )
        .is_err());
        assert!(require_inside_root(
            root.join("../outside.md").to_str().unwrap(),
            root.to_str().unwrap()
        )
        .is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("outside.md"), root.join("linked.md")).unwrap();
            std::os::unix::fs::symlink(&dir, root.join("linked-dir")).unwrap();
            assert!(require_inside_root(
                root.join("linked.md").to_str().unwrap(),
                root.to_str().unwrap()
            )
            .is_err());
            assert!(require_inside_root(
                root.join("linked-dir").to_str().unwrap(),
                root.to_str().unwrap()
            )
            .is_err());
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[cfg(unix)] // 测的是 unix symlink 语义；Windows 上无法无权限创建符号链接
    fn preview_allows_symlink_escaping_root_lexically() {
        let dir = std::env::temp_dir().join(format!("ccode-fx-{}", uuid::Uuid::new_v4()));
        let outside = dir.join("outside");
        let root = dir.join("root");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&root).unwrap();
        fs::write(outside.join("real.txt"), "hello").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("real.txt"), root.join("link.txt")).unwrap();
        // 符号链接解析到根外：词法检查应放行
        let r = read_file_preview_sync(
            root.join("link.txt").to_str().unwrap(),
            root.to_str().unwrap(),
        );
        assert!(r.is_ok(), "{r:?}");
        let snapshot = r.unwrap();
        assert_eq!(snapshot.text, "hello");
        assert!(snapshot.revision.is_none());
        assert!(snapshot.read_only_reason.unwrap().contains("符号链接"));
        assert!(save_file_preview_sync(
            root.join("link.txt").to_str().unwrap(),
            root.to_str().unwrap(),
            "no",
            &preview_revision(b"hello")
        )
        .is_err());
        // 根外路径仍拒绝
        let r2 = read_file_preview_sync(
            outside.join("real.txt").to_str().unwrap(),
            root.to_str().unwrap(),
        );
        assert!(r2.is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn noise_skip_rules() {
        use std::path::Path;
        assert!(fs_noise_skip(Path::new("/home/u/.claude/projects/x.jsonl")));
        assert!(fs_noise_skip(Path::new("/home/u/proj/.git/index")));
        assert!(fs_noise_skip(Path::new(
            "/home/u/proj/node_modules/x/index.js"
        )));
        assert!(!fs_noise_skip(Path::new("/home/u/proj/src/main.rs")));
        assert!(fs_noise_skip(Path::new(
            "/home/u/proj/target/debug/build/x"
        )));
        assert!(fs_noise_skip(Path::new(
            "/home/u/proj/dist/assets/index.js"
        )));
        assert!(!fs_noise_skip(Path::new("/home/u/proj/.env")));
        // .ccode 豁免：任务书草稿 AI 改稿要触发预览实时重载
        assert!(!fs_noise_skip(Path::new(
            "/home/u/proj/.ccode/drafts/lit-search.md"
        )));
        // 其他隐藏目录照旧过滤
        assert!(fs_noise_skip(Path::new("/home/u/proj/.idea/workspace.xml")));
    }
}

// ===== 项目内文件搜索（P4 补充）：限定根目录内，跳过噪声目录 =====
///
/// 隐藏目录默认不进（与 list_dir 同口径），例外：
/// - `.ccode` 恒进（任务书草稿）
/// - `show_hidden=true`（工作树开了「显示隐藏文件」）
/// - 查询以 `.` 开头（用户在搜点文件）
/// - 隐藏目录名本身命中查询（搜 `kimi-code` 能找到 `.kimi-code` 并进入）
/// `.git` / `node_modules` / `target` / `dist` / `Library` 始终跳过。

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultDto {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    /// 相对搜索根的路径（前端展示用，避免前端按根长截断出错）
    pub rel: String,
    /// 最近修改时间（ISO）；读不到元数据时为 None
    pub modified: Option<String>,
}

fn search_skip_dir(name: &str, show_hidden: bool, query: &str) -> bool {
    if name == ".git" || matches!(name, "node_modules" | "target" | "dist" | "Library") {
        return true;
    }
    if name == ".ccode" || !name.starts_with('.') {
        return false;
    }
    if show_hidden || query.starts_with('.') {
        return false;
    }
    !name.to_lowercase().contains(query)
}

/// 文件名最后一个扩展名（小写、不含点）。`.env`、无扩展名 → None
fn file_ext(name: &str) -> Option<String> {
    let dot = name.rfind('.')?;
    if dot == 0 || dot + 1 == name.len() {
        return None;
    }
    Some(name[dot + 1..].to_ascii_lowercase())
}

fn is_simple_ext_token(s: &str) -> bool {
    let len = s.len();
    (1..=8).contains(&len) && s.chars().all(|c| c.is_ascii_alphanumeric())
}

/// `doc` 同时找 .doc/.docx；`pdf` / `.pdf` / `*.pdf` 都认成后缀。
fn expand_ext_aliases(ext: &str) -> Vec<String> {
    let group: &[&str] = match ext {
        "doc" | "docx" => &["doc", "docx"],
        "ppt" | "pptx" => &["ppt", "pptx"],
        "xls" | "xlsx" => &["xls", "xlsx"],
        "jpg" | "jpeg" => &["jpg", "jpeg"],
        "htm" | "html" => &["htm", "html"],
        "md" | "markdown" | "mdx" => &["md", "markdown", "mdx", "qmd"],
        "qmd" => &["qmd", "md"],
        _ => &[],
    };
    if group.is_empty() {
        vec![ext.to_string()]
    } else {
        group.iter().map(|s| (*s).to_string()).collect()
    }
}

struct SearchQuery {
    raw: String,
    exts: Vec<String>,
    /// `.pdf` / `*.pdf`：只按后缀，不拿文件名里偶然出现的 "pdf" 凑数
    ext_only: bool,
}

fn parse_search_query(raw: &str) -> Option<SearchQuery> {
    let raw = raw.trim().to_lowercase();
    if raw.is_empty() {
        return None;
    }
    let (token, ext_only) = if let Some(rest) = raw.strip_prefix("*.") {
        (rest, true)
    } else if raw.starts_with('.') && is_simple_ext_token(&raw[1..]) {
        (&raw[1..], true)
    } else if is_simple_ext_token(&raw) {
        (raw.as_str(), false)
    } else {
        return Some(SearchQuery {
            raw,
            exts: Vec::new(),
            ext_only: false,
        });
    };
    if !is_simple_ext_token(token) {
        return Some(SearchQuery {
            raw,
            exts: Vec::new(),
            ext_only: false,
        });
    }
    let token = token.to_string();
    let exts = expand_ext_aliases(&token);
    Some(SearchQuery {
        raw,
        exts,
        ext_only,
    })
}

fn is_ext_hit(name: &str, is_dir: bool, q: &SearchQuery) -> bool {
    if is_dir || q.exts.is_empty() {
        return false;
    }
    file_ext(name).is_some_and(|e| q.exts.iter().any(|x| x == &e))
}

fn search_entry_matches(name: &str, is_dir: bool, q: &SearchQuery) -> bool {
    if is_ext_hit(name, is_dir, q) {
        return true;
    }
    if q.ext_only {
        // `.env` / `.gitignore` 整名；`.kimi` 仍能命中目录 `.kimi-code`
        return name == q.raw || (is_dir && name.contains(&q.raw));
    }
    name.contains(&q.raw)
}

const SEARCH_MAX_DEPTH: usize = 10;
const SEARCH_MAX_VISITED: usize = 50000;
const SEARCH_MAX_RESULTS: usize = 50;

fn search_walk(
    root: &std::path::Path,
    dir: &std::path::Path,
    query: &SearchQuery,
    show_hidden: bool,
    depth: usize,
    visited: &mut usize,
    ext_out: &mut Vec<SearchResultDto>,
    name_out: &mut Vec<SearchResultDto>,
) {
    if depth > SEARCH_MAX_DEPTH
        || *visited >= SEARCH_MAX_VISITED
        || ext_out.len() >= SEARCH_MAX_RESULTS
    {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if *visited >= SEARCH_MAX_VISITED || ext_out.len() >= SEARCH_MAX_RESULTS {
            return;
        }
        *visited += 1;
        let name = e.file_name().to_string_lossy().into_owned();
        let path = e.path();
        let Ok(md) = e.metadata() else {
            continue;
        };
        let is_dir = md.is_dir();
        if is_dir && search_skip_dir(&name, show_hidden, &query.raw) {
            continue;
        }
        let name_l = name.to_lowercase();
        if search_entry_matches(&name_l, is_dir, query) {
            let modified = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| iso_from_unix(d.as_secs()));
            let dto = SearchResultDto {
                rel: path
                    .strip_prefix(root)
                    .map(|r| r.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| name.clone()),
                path: path.to_string_lossy().into_owned(),
                name: name.clone(),
                is_dir,
                modified,
            };
            if is_ext_hit(&name_l, is_dir, query) {
                ext_out.push(dto);
            } else if name_out.len() < SEARCH_MAX_RESULTS {
                name_out.push(dto);
            }
        }
        if is_dir {
            search_walk(
                root,
                &path,
                query,
                show_hidden,
                depth + 1,
                visited,
                ext_out,
                name_out,
            );
        }
    }
}

fn assemble_search_hits(
    mut ext_out: Vec<SearchResultDto>,
    name_out: Vec<SearchResultDto>,
) -> Vec<SearchResultDto> {
    if ext_out.len() >= SEARCH_MAX_RESULTS {
        ext_out.truncate(SEARCH_MAX_RESULTS);
        return ext_out;
    }
    let room = SEARCH_MAX_RESULTS - ext_out.len();
    ext_out.extend(name_out.into_iter().take(room));
    ext_out
}

const OFFICE_EXTS: &[&str] = &[
    "md", "markdown", "mdx", "qmd", "txt", "doc", "docx", "rtf", "xls", "xlsx", "xlsm", "ods",
    "csv", "tsv", "ppt", "pptx", "odp", "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg",
];
const OFFICE_MAX: usize = 400;
const OFFICE_DEPTH: usize = 8;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeDocDto {
    pub path: String,
    pub name: String,
    pub rel: String,
    pub size: u64,
    pub modified: Option<String>,
}

fn list_office_docs_sync(root: &str) -> Result<Vec<OfficeDocDto>, String> {
    let root_path = std::path::PathBuf::from(expand_tilde(root));
    if !root_path.is_dir() {
        return Err("目录不存在".into());
    }
    let mut out = Vec::new();
    let mut visited = 0;
    office_walk(&root_path, &root_path, 0, &mut visited, &mut out);
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.rel.cmp(&b.rel)));
    out.truncate(OFFICE_MAX);
    Ok(out)
}

fn office_walk(
    root: &std::path::Path,
    dir: &std::path::Path,
    depth: usize,
    visited: &mut usize,
    out: &mut Vec<OfficeDocDto>,
) {
    if depth > OFFICE_DEPTH || *visited >= SEARCH_MAX_VISITED || out.len() >= OFFICE_MAX {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        *visited += 1;
        if *visited >= SEARCH_MAX_VISITED || out.len() >= OFFICE_MAX {
            break;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let path = e.path();
        if fs_noise_skip(&path) {
            continue;
        }
        let Ok(md) = e.metadata() else {
            continue;
        };
        if md.is_dir() {
            if name.starts_with('.')
                || matches!(
                    name.as_str(),
                    "node_modules" | "target" | "dist" | "Library"
                )
            {
                continue;
            }
            office_walk(root, &path, depth + 1, visited, out);
            continue;
        }
        let Some(ext) = file_ext(&name) else {
            continue;
        };
        if !OFFICE_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| iso_from_unix(d.as_secs()));
        out.push(OfficeDocDto {
            path: path.to_string_lossy().into_owned(),
            name,
            rel,
            size: md.len(),
            modified,
        });
    }
}

#[tauri::command]
pub async fn list_office_docs(root: String) -> Result<Vec<OfficeDocDto>, String> {
    tauri::async_runtime::spawn_blocking(move || list_office_docs_sync(&root))
        .await
        .map_err(|e| format!("列出文档失败: {e}"))?
}

/// 系统打开前的门槛：项目根内（canonicalize + path_within）且扩展名在办公白名单。
/// 不把 `opener:allow-open-path` 交给 WebView——那会让前端打开任意可执行文件。
fn prepare_open_in_system(path: &str, root: &str) -> Result<PathBuf, String> {
    let root_exp = expand_tilde(root);
    let path_exp = expand_tilde(path);
    if !crate::paths::path_within(&path_exp, &root_exp) {
        return Err("路径超出项目根目录，拒绝打开".into());
    }
    let root_c = crate::paths::canonicalize_plain(std::path::Path::new(&root_exp))
        .map_err(|e| format!("项目根目录无效: {e}"))?;
    let path_c = crate::paths::canonicalize_plain(std::path::Path::new(&path_exp))
        .map_err(|e| format!("文件不存在或不可读: {e}"))?;
    if !crate::paths::path_within_path(&path_c, &root_c) {
        return Err("路径超出项目根目录，拒绝打开".into());
    }
    if path_c.is_dir() {
        return Err("目录请用「显示」在文件管理器里打开".into());
    }
    let name = path_c
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let Some(ext) = file_ext(&name) else {
        return Err("这种文件不能用系统应用打开".into());
    };
    if !OFFICE_EXTS.contains(&ext.as_str()) {
        return Err("这种文件不能用系统应用打开".into());
    }
    Ok(path_c)
}

fn open_in_system_sync(path: &str, root: &str) -> Result<(), String> {
    let target = prepare_open_in_system(path, root)?;
    tauri_plugin_opener::open_path(&target, None::<&str>)
        .map_err(|e| format!("无法用系统应用打开: {e}"))
}

/// 用系统默认应用打开项目内文档（Excel / Word / 幻灯等）。用户点「系统打开」才走这里。
#[tauri::command]
pub async fn open_in_system(path: String, root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_in_system_sync(&path, &root))
        .await
        .map_err(|e| format!("无法用系统应用打开: {e}"))?
}

#[tauri::command]
pub async fn search_files(
    root: String,
    query: String,
    show_hidden: bool,
) -> Result<Vec<SearchResultDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(q) = parse_search_query(&query) else {
            return Ok(Vec::new());
        };
        let mut ext_out = Vec::new();
        let mut name_out = Vec::new();
        let mut visited = 0;
        let root_path = std::path::PathBuf::from(expand_tilde(&root));
        search_walk(
            &root_path,
            &root_path,
            &q,
            show_hidden,
            0,
            &mut visited,
            &mut ext_out,
            &mut name_out,
        );
        Ok(assemble_search_hits(ext_out, name_out))
    })
    .await
    .map_err(|e| format!("搜索失败: {e}"))?
}

#[cfg(test)]
mod search_tests {
    use super::*;

    fn run_search(dir: &std::path::Path, query: &str, show_hidden: bool) -> Vec<SearchResultDto> {
        let q = parse_search_query(query).expect("query");
        let mut ext_out = Vec::new();
        let mut name_out = Vec::new();
        let mut visited = 0;
        search_walk(
            dir,
            dir,
            &q,
            show_hidden,
            0,
            &mut visited,
            &mut ext_out,
            &mut name_out,
        );
        assemble_search_hits(ext_out, name_out)
    }

    #[test]
    fn list_office_docs_skips_noise_and_keeps_md() {
        let dir = std::env::temp_dir().join(format!("ccode-office-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("notes/a.md"), "hi").unwrap();
        fs::write(dir.join("node_modules/x.md"), "no").unwrap();
        fs::write(dir.join("skip.rs"), "code").unwrap();
        let out = list_office_docs_sync(dir.to_str().unwrap()).unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].rel.replace('\\', "/").ends_with("notes/a.md"));
        fs::write(dir.join("REPORT.PDF"), "%PDF-").unwrap();
        let out2 = list_office_docs_sync(dir.to_str().unwrap()).unwrap();
        assert!(
            out2.iter()
                .any(|d| d.name.eq_ignore_ascii_case("REPORT.PDF")),
            "{:?}",
            out2.iter().map(|d| &d.name).collect::<Vec<_>>()
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prepare_open_in_system_allows_xlsx_inside_root() {
        let dir = std::env::temp_dir().join(format!("ccode-open-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("表.XLSX");
        fs::write(&f, b"PK").unwrap();
        let got = prepare_open_in_system(f.to_str().unwrap(), dir.to_str().unwrap()).unwrap();
        assert!(
            got.ends_with("表.XLSX") || got.ends_with("表.xlsx"),
            "{got:?}"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prepare_open_in_system_rejects_outside_and_scripts() {
        let root = std::env::temp_dir().join(format!("ccode-open-root-{}", uuid::Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("ccode-open-out-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("a.xlsx");
        fs::write(&secret, b"PK").unwrap();
        let err =
            prepare_open_in_system(secret.to_str().unwrap(), root.to_str().unwrap()).unwrap_err();
        assert!(err.contains("超出项目根目录"), "{err}");

        let sh = root.join("run.sh");
        fs::write(&sh, "echo hi").unwrap();
        let err = prepare_open_in_system(sh.to_str().unwrap(), root.to_str().unwrap()).unwrap_err();
        assert!(err.contains("这种文件"), "{err}");

        let err =
            prepare_open_in_system(root.to_str().unwrap(), root.to_str().unwrap()).unwrap_err();
        assert!(err.contains("目录"), "{err}");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn search_finds_nested_and_skips_noise() {
        let dir = std::env::temp_dir().join(format!("ccode-search-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("src/deep")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("src/deep/apple.rs"), "").unwrap();
        fs::write(dir.join("node_modules/pkg/apple.js"), "").unwrap();
        fs::write(dir.join("banana.md"), "").unwrap();
        let out = run_search(&dir, "apple", false);
        assert_eq!(out.len(), 1);
        assert!(std::path::Path::new(&out[0].path).ends_with("src/deep/apple.rs"));
        assert!(std::path::Path::new(&out[0].rel).ends_with("src/deep/apple.rs"));
        assert!(out[0].modified.is_some(), "搜索命中应带上最近修改时间");
        // 预览：root 传未展开的 "~" 也应通过词法检查
        let home_file = dirs::home_dir().unwrap().join("ccode-test-tilde.txt");
        fs::write(&home_file, "x").unwrap();
        let r = read_file_preview_sync(home_file.to_str().unwrap(), "~");
        assert!(r.is_ok(), "{r:?}");
        let _ = fs::remove_file(&home_file);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_skip_dir_rules() {
        assert!(search_skip_dir(".git", true, "git"));
        assert!(search_skip_dir("node_modules", true, "pkg"));
        assert!(!search_skip_dir(".ccode", false, "draft"));
        assert!(search_skip_dir(".kimi-code", false, "config"));
        assert!(!search_skip_dir(".kimi-code", false, "kimi-code"));
        assert!(!search_skip_dir(".kimi-code", false, ".kimi"));
        assert!(!search_skip_dir(".kimi-code", true, "config"));
        assert!(!search_skip_dir("src", false, "config"));
    }

    #[test]
    fn search_finds_hidden_config_dir() {
        let dir = std::env::temp_dir().join(format!("ccode-search-dot-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join(".kimi-code")).unwrap();
        fs::write(dir.join(".kimi-code/config.toml"), "").unwrap();
        fs::write(dir.join(".env"), "").unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git/config"), "").unwrap();

        let out = run_search(&dir, "kimi-code", false);
        assert!(
            out.iter().any(|e| e.name == ".kimi-code" && e.is_dir),
            "目录名命中时应找到 .kimi-code: {out:?}"
        );

        let out = run_search(&dir, "config", false);
        assert!(
            !out.iter().any(|e| e.path.contains(".kimi-code")),
            "未开隐藏、查询也不点开头时不进 .kimi-code: {out:?}"
        );

        let out = run_search(&dir, "config", true);
        assert!(
            out.iter().any(|e| e.name == "config.toml"),
            "开隐藏后应找到 .kimi-code/config.toml: {out:?}"
        );
        assert!(
            !out.iter().any(|e| e.path.contains(".git")),
            ".git 始终跳过: {out:?}"
        );

        let out = run_search(&dir, ".kimi", false);
        assert!(
            out.iter().any(|e| e.name == ".kimi-code"),
            "查询以 . 开头应走进隐藏目录: {out:?}"
        );

        let out = run_search(&dir, ".env", false);
        assert!(
            out.iter().any(|e| e.name == ".env"),
            "根下隐藏文件本就可搜: {out:?}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_by_extension_ranks_suffix_first() {
        let dir = std::env::temp_dir().join(format!("ccode-search-ext-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::create_dir_all(dir.join("papers")).unwrap();
        for i in 0..20 {
            fs::write(dir.join("notes").join(format!("pdf-notes-{i}.md")), "").unwrap();
        }
        fs::write(dir.join("papers/review.PDF"), "").unwrap();
        fs::write(dir.join("draft.docx"), "").unwrap();
        fs::write(dir.join("old.doc"), "").unwrap();
        fs::write(dir.join("document.md"), "").unwrap();

        let out = run_search(&dir, "pdf", false);
        assert!(
            out[0].name.to_lowercase().ends_with(".pdf"),
            "后缀命中排在文件名包含之前: {out:?}"
        );
        assert!(out.iter().any(|e| e.name.starts_with("pdf-notes-")));

        let out = run_search(&dir, ".pdf", false);
        assert!(
            out.iter().any(|e| e.name.to_lowercase().ends_with(".pdf")),
            ".pdf 只按后缀: {out:?}"
        );
        assert!(
            !out.iter().any(|e| e.name.ends_with(".md")),
            ".pdf 不应命中 pdf-notes.md: {out:?}"
        );

        let out = run_search(&dir, "*.PDF", false);
        assert!(out.iter().any(|e| e.name.to_lowercase().ends_with(".pdf")));
        assert!(!out.iter().any(|e| e.name.ends_with(".md")));

        let out = run_search(&dir, "doc", false);
        assert!(
            out.iter().any(|e| e.name == "draft.docx"),
            "doc 别名含 docx: {out:?}"
        );
        assert!(out.iter().any(|e| e.name == "old.doc"));
        let first_names: Vec<_> = out.iter().take(2).map(|e| e.name.as_str()).collect();
        assert!(
            first_names
                .iter()
                .all(|n| n.ends_with(".doc") || n.ends_with(".docx")),
            "doc/docx 应排在 document.md 前: {out:?}"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}

// ===== 文件树文件操作（P4 补充）：新建文件夹 / 删除，词法根目录约束 =====

/// Windows 反斜杠归一为正斜杠，再做前缀比较（跨平台路径语义一致）
fn norm_sep(s: &str) -> String {
    s.replace('\\', "/")
}

/// 保护名单比较用的归一化。Windows 上必须做三件事，否则整张名单拼不上实际路径：
/// ① 分隔符统一（home 是 `C:\Users\x`，与 `format!("{home}/Documents")` 拼出的混合分隔符对不上）；
/// ② 剥掉 `canonicalize` 带的 `\\?\` verbatim 前缀；③ 文件系统大小写不敏感，统一小写。
/// macOS 上只做 ①②（① 与同文件 lexical_in_root 既有口径一致），大小写语义保持不变。
fn protect_key(s: &str) -> String {
    let s = norm_sep(s);
    let s = s.strip_prefix("//?/").map(str::to_string).unwrap_or(s);
    let s = s.trim_end_matches('/').to_string();
    #[cfg(windows)]
    let s = s.to_lowercase();
    s
}

/// Windows 系统目录（按环境变量取，不假定盘符为 C:）
#[cfg(windows)]
fn windows_system_dirs() -> Vec<String> {
    [
        "SystemRoot",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
    ]
    .iter()
    .filter_map(|k| std::env::var(k).ok())
    .filter(|v| !v.is_empty())
    .map(|v| protect_key(&v))
    .collect()
}

fn lexical_in_root(path: &str, root: &str) -> bool {
    // 方言统一（verbatim 前缀/分隔符/Windows 大小写折叠）收敛到 paths::path_within；
    // 这里只负责先展开 ~（path_within 不认波浪号）
    crate::paths::path_within(&expand_tilde(path), &expand_tilde(root))
}

fn create_dir_sync(root: &str, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.contains('.') {
        return Err("文件夹名称无效（不能含 .）".into());
    }
    // 非法字符/保留名/路径逃逸统一走 paths::validate_fs_name：原先只挡 `/ \ .`，
    // `a?b` 之类到 Windows 上是 os error 123（用户看到「系统找不到指定的路径」这种
    // 对不上因果的提示），而 `C:evil` 因为不含这三个字符会通过校验，再被
    // PathBuf::join 整体替换掉 root —— 目录直接建到 C 盘去、脱离项目根。
    crate::paths::validate_fs_name(name).map_err(|e| format!("文件夹名称无效（{e}）"))?;
    let dir = PathBuf::from(expand_tilde(root)).join(name);
    // 落盘前再验一次词法归属：校验通过不代表拼出来的路径一定还在 root 内
    if !lexical_in_root(&dir.to_string_lossy(), root) {
        return Err("路径超出项目根目录，拒绝创建".into());
    }
    if dir.exists() {
        return Err("已存在同名文件或目录".into());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建文件夹失败: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 重要系统/用户路径保护：无论根目录范围如何都拒绝删除
/// （pub(crate)：projects::delete_project_dir 删项目目录前复用同一黑名单）
pub(crate) fn is_protected_path(path: &str) -> bool {
    // 词法形式与 canonicalize 后形式双重校验：堵住「项目内符号链接指向受保护目录」的绕过
    let lex = expand_tilde(path);
    let canon = std::path::PathBuf::from(&lex)
        .canonicalize()
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_else(|_| lex.clone());
    is_protected_str(&lex) || (canon != lex && is_protected_str(&canon))
}

fn is_protected_str(p: &str) -> bool {
    let home = protect_key(
        &dirs::home_dir()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_default(),
    );
    let mut exact: Vec<String> = [
        home.clone(),
        format!("{home}/Documents"),
        format!("{home}/Desktop"),
        format!("{home}/Downloads"),
        format!("{home}/.zshrc"),
        format!("{home}/.bashrc"),
        format!("{home}/.zprofile"),
        format!("{home}/.bash_profile"),
        format!("{home}/.gitconfig"),
    ]
    .into_iter()
    .map(|s| protect_key(&s))
    .collect();
    // 系统报告的「文档/桌面/下载」：Windows 上常被 OneDrive 或中文目录重定向，不一定是 ~/Documents
    exact.extend(
        [dirs::document_dir(), dirs::desktop_dir(), dirs::download_dir()]
            .into_iter()
            .flatten()
            .map(|d| protect_key(&d.to_string_lossy())),
    );
    let pn = protect_key(p);
    let pn = pn.as_str();
    // 精确匹配保护 home 与 shell 配置；关键目录（Library/ssh/CLI 配置/Mesa 数据）连同子路径一并保护
    let mut dir_prefixes: Vec<String> = [
        format!("{home}/Library"),
        format!("{home}/.ssh"),
        format!("{home}/.claude"),
        format!("{home}/.codex"),
        format!("{home}/.gemini"),
        format!("{home}/.qwen"),
        format!("{home}/.kimi"),
        format!("{home}/.kimi-code"),
        format!("{home}/.grok"),
        format!("{home}/.cursor"),
        format!("{home}/.codebuddy"),
        format!("{home}/.config"),
        format!("{home}/.local/share/opencode"),
        format!("{home}/Library/Application Support/ccode"),
    ]
    .into_iter()
    .map(|s| protect_key(&s))
    .collect();
    // Mesa 自己的数据目录按系统口径取（Windows = %APPDATA%\ccode、%LOCALAPPDATA%\ccode 与
    // 网页数据 %LOCALAPPDATA%\com.ccode.dev；macOS 上这些都已落在 ~/Library 之下，只是重复项）
    for base in [dirs::config_dir(), dirs::data_local_dir(), dirs::data_dir()]
        .into_iter()
        .flatten()
    {
        for name in ["ccode", "com.ccode.dev"] {
            dir_prefixes.push(protect_key(&base.join(name).to_string_lossy()));
        }
    }
    // Windows 的 AppData 相当于 macOS 的 ~/Library，连同子路径保护；但 %TEMP% 就在
    // AppData\Local\Temp 下，里面是临时工作区（内部对话目录、测试夹具等），放行其子路径
    // （临时目录本身仍受保护）。系统目录不在 POSIX PREFIXES 里，单独并入（macOS 不编译此段）
    #[cfg(windows)]
    {
        dir_prefixes.extend(windows_system_dirs());
        let appdata = protect_key(&format!("{home}/AppData"));
        let temp = protect_key(&std::env::temp_dir().to_string_lossy());
        let in_temp = pn.starts_with(&format!("{temp}/"));
        if !in_temp && (pn == appdata || pn.starts_with(&format!("{appdata}/"))) {
            return true;
        }
    }
    if exact.iter().any(|e| pn == e)
        || dir_prefixes
            .iter()
            .any(|e| pn == e || pn.starts_with(&format!("{e}/")))
    {
        return true;
    }
    const PREFIXES: [&str; 8] = [
        "/System",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/Library",
        "/Applications",
        "/opt",
    ];
    let home_lib = protect_key(&format!("{home}/Library"));
    // macOS 的 /etc、/tmp 等是 /private 下的符号链接，canonicalize 后会带 /private 前缀，剥掉再比
    let pn_depriv = pn
        .strip_prefix("/private/")
        .map(|r| format!("/{r}"))
        .unwrap_or_else(|| pn.to_string());
    if PREFIXES
        .iter()
        .any(|pre| pn.starts_with(pre) || pn_depriv.starts_with(pre))
        || pn.starts_with(&home_lib)
    {
        return true;
    }
    // 任何 .git 内部路径
    pn.contains("/.git")
}

/// 删除走系统回收站（可反悔），不用 remove_* 直删
fn delete_path_sync(path: &str, root: &str) -> Result<(), String> {
    if is_protected_path(path) {
        return Err("系统/重要目录受保护，拒绝删除".into());
    }
    if !lexical_in_root(path, root) {
        return Err("路径超出项目根目录，拒绝删除".into());
    }
    let root_norm = expand_tilde(root).trim_end_matches('/').to_string();
    let p = expand_tilde(path);
    if p == root_norm {
        return Err("不能删除项目根目录本身".into());
    }
    trash::delete(expand_tilde(path)).map_err(|e| format!("移入回收站失败: {e}"))
}

#[tauri::command]
pub async fn fs_create_dir(root: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || create_dir_sync(&root, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// 家目录绝对路径（前端项目路径缩略为 ~ 显示用）
#[tauri::command]
pub fn home_dir() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 新建项目的默认父目录：系统「文档」，取不到退回家目录（与示例课题同一落点）
#[tauri::command]
pub fn default_project_parent() -> String {
    dirs::document_dir()
        .or_else(dirs::home_dir)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn fs_delete_path(path: String, root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_path_sync(&path, &root))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod fsops_tests {
    use super::*;

    #[test]
    fn create_and_delete_ops() {
        let dir = std::env::temp_dir().join(format!("ccode-fsops-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap().to_string();
        let created = create_dir_sync(&root, "newfolder").unwrap();
        assert!(std::path::Path::new(&created).is_dir());
        assert!(create_dir_sync(&root, "a/b").is_err());
        assert!(create_dir_sync(&root, "newfolder").is_err()); // 重名
        fs::write(dir.join("f.txt"), "x").unwrap();
        // 删除行为本身已由 fs_delete_path 走回收站；测试在临时目录里用直删做清理，不污染回收站
        // （Linux CI 上 /tmp 常为 tmpfs，回收站移动可能失败）
        fs::remove_file(dir.join("f.txt")).unwrap();
        fs::remove_dir_all(&created).unwrap();
        assert!(!std::path::Path::new(&created).exists());
        assert!(delete_path_sync("/tmp", &root).is_err());
        assert!(delete_path_sync(&root, &root).is_err());
        // 保护路径：root 是 home 时系统/关键目录一律拒绝
        let home = dirs::home_dir().unwrap().to_string_lossy().into_owned();
        assert!(delete_path_sync(&format!("{home}/Library"), &home).is_err());
        assert!(delete_path_sync(&format!("{home}/.ssh"), &home).is_err());
        assert!(delete_path_sync(&format!("{home}/.claude/projects"), &home).is_err());
        assert!(delete_path_sync("/System", &home).is_err());
        assert!(delete_path_sync(&format!("{home}/proj/.git/index"), &home).is_err());
        // 符号链接绕过：项目内链接指向 ~/.ssh，按词法路径删除时也应被拦截
        #[cfg(unix)]
        {
            let proj = dir.join("projlink");
            fs::create_dir_all(&proj).unwrap();
            let link = proj.join("x");
            std::os::unix::fs::symlink("/etc", &link).unwrap();
            assert!(delete_path_sync(
                &link.to_string_lossy(),
                &proj.to_string_lossy().into_owned()
            )
            .is_err());
            let _ = fs::remove_file(&link);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod system_dir_tests {
    use super::*;

    #[test]
    fn home_system_dir_predicate() {
        let home = dirs::home_dir().unwrap();
        // macOS 清单内目录命中；普通目录/文件/非 home 父目录不命中
        #[cfg(target_os = "macos")]
        {
            assert!(is_home_system_dir(&home, true, "Library"));
            assert!(is_home_system_dir(&home, true, "Applications"));
        }
        #[cfg(target_os = "windows")]
        {
            assert!(is_home_system_dir(&home, true, "AppData"));
        }
        assert!(!is_home_system_dir(&home, true, "Documents"));
        assert!(!is_home_system_dir(&home, true, "nltk_data"));
        assert!(!is_home_system_dir(&home, false, "Library")); // 文件不命中
        assert!(!is_home_system_dir(
            &home.join("Documents"),
            true,
            "Library"
        )); // 父目录不是 home
    }

    // ===== 删除保护名单（跨平台路径方言） =====

    /// 用平台原生分隔符拼 home 下的路径——Windows 上得到 `C:\Users\x\Documents`，
    /// 正是文件树右键删除真正传进来的形式。
    fn under_home(rel: &str) -> String {
        dirs::home_dir()
            .unwrap()
            .join(rel)
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn protected_list_matches_native_separator_paths() {
        // 回归：曾经名单用 format!("{home}/Documents") 拼，而 Windows 的 home 是反斜杠，
        // 拼出 `C:\Users\x/Documents` 与实际输入永不相等 ⇒ 整张名单在 Windows 上失效。
        for rel in [
            "Documents",
            "Desktop",
            "Downloads",
            ".ssh",
            ".claude",
            ".codex",
            ".gitconfig",
        ] {
            assert!(
                is_protected_str(&under_home(rel)),
                "home 下的 {rel} 必须受保护（实际传入形式：{}）",
                under_home(rel)
            );
        }
        assert!(is_protected_str(&under_home("")), "家目录自身必须受保护");
        // 关键目录的子路径一并保护
        assert!(is_protected_str(&under_home(".ssh/id_rsa")));
        // 普通工作目录不该被误伤
        assert!(!is_protected_str(&under_home("code/myproject")));
    }

    #[test]
    fn protected_list_covers_git_internals_in_both_dialects() {
        assert!(is_protected_str("/repo/.git/config"));
        assert!(is_protected_str(r"C:\repo\.git\config"));
        assert!(!is_protected_str("/repo/src/main.rs"));
    }

    #[test]
    fn protected_list_survives_verbatim_and_trailing_sep() {
        // canonicalize 在 Windows 上返回 \\?\ 前缀；带尾分隔符的形式也要认
        assert!(is_protected_str(&format!(r"\\?\{}", under_home(".ssh"))));
        assert!(is_protected_str(&format!("{}/", under_home("Documents"))));
    }

    #[cfg(windows)]
    #[test]
    fn protected_list_covers_windows_system_dirs_case_insensitively() {
        let sysroot = std::env::var("SystemRoot").unwrap();
        assert!(is_protected_str(&sysroot));
        assert!(is_protected_str(&sysroot.to_uppercase()));
        assert!(is_protected_str(&sysroot.to_lowercase()));
        assert!(is_protected_str(&format!(r"{sysroot}\System32")));
        // 盘符大小写不同也要命中（Windows 文件系统大小写不敏感）
        assert!(is_protected_str(&under_home(".ssh").to_uppercase()));
    }

    /// 其余 CLI 家目录、系统报告的文档/桌面目录与 Mesa 数据目录（按系统口径取）都受保护
    #[test]
    fn protected_list_covers_cli_homes_and_platform_data_dirs() {
        for rel in [".grok", ".cursor/auth.json", ".codebuddy", ".config/opencode"] {
            assert!(is_protected_str(&under_home(rel)), "{rel} 必须受保护");
        }
        for d in [dirs::document_dir(), dirs::desktop_dir()].into_iter().flatten() {
            assert!(is_protected_str(&d.to_string_lossy()), "{}", d.display());
        }
        if let Some(cfg) = dirs::config_dir() {
            let mesa = cfg.join("ccode").join("app.db");
            assert!(is_protected_str(&mesa.to_string_lossy()), "{}", mesa.display());
        }
        if let Some(local) = dirs::data_local_dir() {
            let web = local.join("com.ccode.dev").join("EBWebView");
            assert!(is_protected_str(&web.to_string_lossy()), "{}", web.display());
        }
        // 文档目录本身受保护，但里面的普通项目不受影响（精确匹配，不是前缀）
        if let Some(doc) = dirs::document_dir() {
            assert!(!is_protected_str(&doc.join("my-research").to_string_lossy()));
        }
    }

    #[cfg(windows)]
    #[test]
    fn protected_list_covers_windows_appdata() {
        assert!(is_protected_str(&under_home(r"AppData\Roaming\Code")));
        assert!(is_protected_str(&under_home(r"AppData\Local")));
        // %TEMP% 在 AppData\Local\Temp 下：临时目录本身受保护，里面的临时工作区放行
        let temp = std::env::temp_dir();
        assert!(is_protected_str(&temp.to_string_lossy()));
        assert!(!is_protected_str(&temp.join("ccode-ai-1234").to_string_lossy()));
    }
}
