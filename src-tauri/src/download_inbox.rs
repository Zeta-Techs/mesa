//! 下载收货通道（通道 A，2026-09-16 深夜定稿）：**让真实浏览器干浏览器的事**。
//!
//! 出版商反爬（Akamai TLS 指纹、SD 对下载式请求回 HTML、blob Finished 挂起）针对
//! 的是「非浏览器客户端」——内嵌窗里伪装浏览器的整条漏斗注定逐家踩坑。本通道把
//! 「窗口打开」改为调起系统默认浏览器（用户在真浏览器里登录机构、点站方下载），
//! Mesa 只干收货的事：监听系统「下载」夹，并读 Chrome / Edge / Chromium / Brave
//! 偏好里改过的默认下载目录。按时间窗 + 归属匹配把新落的 PDF 收进
//! 对应项目 papers/（复用既有 stage_relayed_pdf → inst-pdf-relayed 入库链，收货端
//! 零改动），收完把原文件挪回收站（可反悔）。
//!
//! 事件过滤链（全过才收，防误捞用户无关下载）：
//! ① .pdf 扩展名；② 监听启动快照里的既有文件不收（只记不处理）；③ 改名稳定
//! 检测（1.2s 后大小不变才算写完，Chrome 大文件分片写）；④ 同一文件 5s 去重
//! （macOS 一次落盘连发 Create+Modify+隔离属性+Spotlight，远不止两条——去重
//! 静默，不把每次跳过印到热更新终端）；⑤ %PDF- 魔数 + ≤60MB；
//! ⑥ 归属匹配：与「浏览器打开」登记的 PendingCatch（时间窗 ±90s + 文件名与标题
//! normalize_title 互相包含 / 文件名含 DOI / MDPI 编号归一）命中才自动收。
//! 名字对不上时：**窗内只有一篇**才按这篇收（Fallback）；**开了多篇就不猜**，
//! 文件留在下载夹并发 ambiguous 横幅让人点挂到哪篇。命中即消费（登记出队落盘）。
//!
//! 登记持久化（download-pending.json，opened_at 用 SystemTime 跨进程判窗）：
//! dev 热重启/应用重启不丢——2026-09-17 实测重启把内存登记洗掉、用户下完无人收。
//! 关窗即停：无 pending 且 10 分钟无事件自动 drop watcher，不常驻。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;

/// 与「窗口打开」联动的时间窗：用户在浏览器里点下载通常在打开后几十秒内
const CATCH_WINDOW: Duration = Duration::from_secs(90);
/// 同一文件的去重窗（macOS 一次落盘会连发 Create+写入+隔离属性+Spotlight）
const DEDUP_WINDOW: Duration = Duration::from_secs(5);
/// 大小稳定检测间隔（Chrome 分片写大文件）
const SETTLE_DELAY: Duration = Duration::from_millis(1200);
/// 无 pending 且无事件的自动停watcher时限
const IDLE_STOP: Duration = Duration::from_secs(600);
/// pending 滞留上限（用户打开后始终没下载 → 清掉）
const PENDING_TTL: Duration = Duration::from_secs(1800);

/// 一次「在浏览器打开」的收货登记。opened_at 用 SystemTime（进程无关）——
/// 登记落盘持久化，dev 热重启/应用重启不丢
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PendingCatch {
    project_root: String,
    title_norm: String,
    title: String,
    #[serde(default)]
    doi: String,
    open_url: String,
    opened_at: std::time::SystemTime,
}

static PENDING: Mutex<Vec<PendingCatch>> = Mutex::new(Vec::new());
/// 监听启动时的 ~/Downloads 既有 PDF 快照（全路径 → 大小），只记不处理——
/// 防把用户的历史下载全收走。键用全路径（终检二轮：按文件名键会误杀扩展上报
/// 的跨目录下载——自定义下载位置重下同名同大小文件被当快照旧物跳过）
static DL_FINGERPRINT: Mutex<Option<HashMap<PathBuf, u64>>> = Mutex::new(None);
/// 同一文件最近一次处理时间（5s 去重）
static LAST_SEEN: std::sync::LazyLock<Mutex<HashMap<PathBuf, std::time::Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
/// watcher 是否在跑（单实例）
static WATCHER_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 下载目录变了时，让正在跑的监听退出，下一轮按新目录启动。
static WATCHER_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static WATCHED_DIRS: std::sync::LazyLock<Mutex<Vec<PathBuf>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

/// 收货决策：终端只印启动 / 失败 / 收货结果。去重、快照、无 pending 的无关 PDF
/// 不刷热更新窗口（2026-09-17 排障期每个跳过都 eprintln，一次下载看起来像点了
/// 七八次）。logbuf 另收首次归属判定，漏收仍有痕迹。
fn dinbox_log(msg: &str) {
    eprintln!("[download-inbox] {msg}");
    crate::logbuf::record("info", "download-inbox", msg);
}

fn dinbox_logbuf(msg: &str) {
    crate::logbuf::record("info", "download-inbox", msg);
}

/// Access / 纯元数据（隔离属性、Spotlight）不是新落盘，不必进过滤链。
/// macOS FSEvents 分不清时会给 Any / Modify(Any)，那些仍放行。
fn event_worth_considering(kind: &notify::EventKind) -> bool {
    use notify::event::ModifyKind;
    use notify::EventKind;
    match kind {
        EventKind::Access(_) | EventKind::Remove(_) => false,
        EventKind::Modify(ModifyKind::Metadata(_)) => false,
        _ => true,
    }
}

/// 收货需要人知道的事（不依赖 OS 通知权限的应用内反馈通道）：文件名没对上号的
/// 兜底关联（说明归属依据，原件留在下载夹）、下载晚了错过 90 秒窗（给「关联本地
/// PDF」补救指引）。App 层监听后以横幅展示并可一键收进
fn emit_attention(
    app: &tauri::AppHandle,
    reason: &str,
    path: &Path,
    project_root: &str,
    title: &str,
) {
    emit_attention_with(app, reason, path, project_root, title, &[]);
}

fn emit_attention_with(
    app: &tauri::AppHandle,
    reason: &str,
    path: &Path,
    project_root: &str,
    title: &str,
    candidates: &[PendingCatch],
) {
    #[derive(serde::Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Candidate {
        title: String,
        project_root: String,
    }
    #[derive(serde::Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Payload {
        reason: String,
        path: String,
        project_root: String,
        title: String,
        file_name: String,
        candidates: Vec<Candidate>,
    }
    let _ = app.emit(
        "inst-pdf-attention",
        Payload {
            reason: reason.to_string(),
            path: path.to_string_lossy().into_owned(),
            project_root: project_root.to_string(),
            title: title.to_string(),
            file_name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            candidates: candidates
                .iter()
                .map(|p| Candidate {
                    title: p.title.clone(),
                    project_root: p.project_root.clone(),
                })
                .collect(),
        },
    );
}

fn downloads_dir() -> Result<PathBuf, String> {
    crate::dirs::download_dir().ok_or_else(|| "无法确定系统下载目录".to_string())
}

/// 没装扩展时要盯的目录：系统「下载」加上各浏览器设过的默认下载文件夹。
/// 每次另选、又没设成默认的位置不在这里，收不到就用「关联」。
fn watch_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(dir) = downloads_dir() {
        push_watch_dir(&mut out, dir);
    }
    for dir in browser_download_dirs() {
        push_watch_dir(&mut out, dir);
    }
    out
}

fn push_watch_dir(into: &mut Vec<PathBuf>, dir: PathBuf) {
    if !dir.is_dir() {
        return;
    }
    let key = crate::paths::canonicalize_plain(&dir).unwrap_or(dir);
    // 家目录、磁盘根目录不盯：一次事件就会扫到无关文件
    let key_text = key.to_string_lossy();
    if key.parent().is_none()
        || crate::dirs::home_dir().is_some_and(|home| crate::paths::same_path(&key_text, &home.to_string_lossy()))
    {
        return;
    }
    if into.iter().any(|have| crate::paths::same_path(&have.to_string_lossy(), &key_text)) {
        return;
    }
    into.push(key);
}

fn browser_user_data_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    if let Some(home) = crate::dirs::home_dir() {
        let app = home.join("Library/Application Support");
        for rel in [
            "Google/Chrome",
            "Microsoft Edge",
            "Chromium",
            "BraveSoftware/Brave-Browser",
            "Vivaldi",
        ] {
            out.push(app.join(rel));
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(local) = crate::dirs::data_local_dir() {
        for rel in ["Google/Chrome/User Data", "Microsoft/Edge/User Data", "Chromium/User Data", "BraveSoftware/Brave-Browser/User Data"] {
            out.push(local.join(rel));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(cfg) = crate::dirs::config_dir() {
        for rel in ["google-chrome", "microsoft-edge", "chromium", "BraveSoftware/Brave-Browser"] {
            out.push(cfg.join(rel));
        }
    }
    out
}

/// Chromium 偏好里两个落盘位置：默认下载目录，和「另存为」对话框上次停的目录
/// （PDF 阅读器里点保存走的是后者——2026-10-22 用户实测：PDF 在浏览器里直接打开、
/// 点保存，存的地方不是下载夹，收不到）
fn chrome_default_directories(preferences: &str) -> Vec<PathBuf> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(preferences) else {
        return Vec::new();
    };
    ["/download/default_directory", "/savefile/default_directory"]
        .iter()
        .filter_map(|key| value.pointer(key)?.as_str())
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn firefox_custom_directory(prefs: &str) -> Option<PathBuf> {
    let mut folder_list: Option<i64> = None;
    let mut dir: Option<String> = None;
    for line in prefs.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("user_pref(\"browser.download.folderList\",") {
            folder_list = rest.trim().trim_end_matches(");").trim().parse().ok();
        }
        if let Some(rest) = line.strip_prefix("user_pref(\"browser.download.dir\",") {
            let raw = rest.trim().trim_end_matches(");").trim().trim_matches('"');
            if !raw.is_empty() {
                dir = Some(raw.replace("\\\\", "\\"));
            }
        }
    }
    // 0 桌面、1 系统下载、2 自定义。前两种已经在系统目录里。
    if folder_list == Some(2) {
        dir.map(PathBuf::from)
    } else {
        None
    }
}

fn browser_download_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in browser_user_data_dirs() {
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        for entry in rd.flatten().take(12) {
            let prefs = entry.path().join("Preferences");
            if !prefs.is_file() {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&prefs) {
                out.extend(chrome_default_directories(&text));
            }
        }
    }
    if let Some(home) = crate::dirs::home_dir() {
        let profiles = home.join(if cfg!(target_os = "macos") {
            "Library/Application Support/Firefox/Profiles"
        } else if cfg!(target_os = "windows") {
            "AppData/Roaming/Mozilla/Firefox/Profiles"
        } else {
            ".mozilla/firefox"
        });
        if let Ok(rd) = std::fs::read_dir(profiles) {
            for entry in rd.flatten().take(8) {
                let prefs = entry.path().join("prefs.js");
                if let Ok(text) = std::fs::read_to_string(prefs) {
                    if let Some(dir) = firefox_custom_directory(&text) {
                        out.push(dir);
                    }
                }
            }
        }
    }
    out
}

/// 收货登记落盘（dev 热重启/应用重启后自动恢复；TTL 清理/命中消费同样同步落盘）
fn pending_store_path() -> Result<PathBuf, String> {
    crate::dirs::config_dir()
        .map(|d| d.join("ccode").join("download-pending.json"))
        .ok_or_else(|| "无法确定配置目录".to_string())
}

fn save_pendings(q: &[PendingCatch]) {
    let Ok(path) = pending_store_path() else {
        return;
    };
    if let Ok(body) = serde_json::to_vec(q) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = crate::storage::atomic_write(&path, &body, false);
    }
}

fn load_pendings() -> Vec<PendingCatch> {
    let Ok(path) = pending_store_path() else {
        return Vec::new();
    };
    std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// 待获取清单认「已存」用：最近打开的那篇（pending + helper-context），
/// 文件名是 paper-5 时仍能挂到对应行
#[derive(Debug, Clone)]
pub(crate) struct CatchIdent {
    pub project_root: String,
    pub title: String,
    pub doi: String,
    pub opened_at: std::time::SystemTime,
}

pub(crate) fn catch_idents() -> Vec<CatchIdent> {
    let mut out: Vec<CatchIdent> = Vec::new();
    let mut push = |p: CatchIdent| {
        if out.iter().any(|x| {
            crate::paths::same_path(&x.project_root, &p.project_root)
                && x.title == p.title
                && x.doi == p.doi
        }) {
            return;
        }
        out.push(p);
    };
    if let Ok(q) = PENDING.lock() {
        for p in q.iter() {
            push(CatchIdent {
                project_root: p.project_root.clone(),
                title: p.title.clone(),
                doi: p.doi.clone(),
                opened_at: p.opened_at,
            });
        }
    }
    for p in load_pendings() {
        push(CatchIdent {
            project_root: p.project_root,
            title: p.title,
            doi: p.doi,
            opened_at: p.opened_at,
        });
    }
    if let Some(ctx) = helper_context_ident() {
        push(ctx);
    }
    out
}

/// 扩展「存到 Mesa」：页上 DOI 对上 pending 时用那篇的标题/项目，不拿最后一次打开的
pub(crate) struct PendingIdent {
    pub title: String,
    pub doi: String,
    pub project_root: String,
}

pub(crate) fn pending_for_doi(doi: &str) -> Option<PendingIdent> {
    let doi_n = crate::inst_access::doi_from_url(doi)?.to_ascii_lowercase();
    if doi_n.len() < 8 {
        return None;
    }
    let now = std::time::SystemTime::now();
    load_pendings()
        .into_iter()
        .filter(|p| {
            now.duration_since(p.opened_at)
                .map(|d| d <= PENDING_TTL)
                .unwrap_or(false)
        })
        .find(|p| {
            crate::inst_access::doi_from_url(&p.doi)
                .map(|d| d.eq_ignore_ascii_case(&doi_n))
                .unwrap_or(false)
        })
        .map(|p| PendingIdent {
            title: p.title,
            doi: p.doi,
            project_root: p.project_root,
        })
}

fn helper_context_ident() -> Option<CatchIdent> {
    let path = crate::dirs::config_dir()?
        .join("ccode")
        .join("helper-context.json");
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let project_root = v.get("projectRoot")?.as_str()?.trim().to_string();
    if project_root.is_empty() {
        return None;
    }
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let doi = v
        .get("doi")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if title.is_empty() && doi.is_empty() {
        return None;
    }
    let opened_at = v
        .get("updatedAt")
        .and_then(|x| x.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| {
            std::time::SystemTime::UNIX_EPOCH
                + std::time::Duration::from_secs(t.timestamp().max(0) as u64)
        })
        .unwrap_or_else(std::time::SystemTime::now);
    Some(CatchIdent {
        project_root,
        title,
        doi,
        opened_at,
    })
}

/// 归属匹配结果：Hit = 高置信（标题/DOI/MDPI 编号对上，自动收并挪走原件）；
/// Fallback = 窗内只开了一篇且文件名对不上（收，原件留在下载夹）；
/// None + 窗内多篇 = 不猜，横幅让人点
#[derive(Debug, Clone, Copy, PartialEq)]
enum PendingMatch {
    Hit(usize),
    Fallback(usize),
}

/// 归属匹配（纯逻辑供单测）：按时间窗 + 标题互相包含挑出 PDF 属于哪条 pending；
/// MDPI 编号归一（文件名 reactions-07-00016 ↔ DOI 10.3390/reactions7010016）；
/// 名字对不上时：**窗内只有一篇**才 Fallback；多篇返回 None（调用方弹横幅让人点）。
/// 包含匹配带「短边 ≥8 字符」护栏（与 lit_watch.to_fetch_progress_inner 同款纪律）。
///
/// 过了 90 秒窗、仍在登记有效期内的，只认**确凿凭据**：文件名或 PDF 元数据段（`content_dois`，
/// XMP / 文档信息里的 DOI）带这篇的 DOI、MDPI 编号、或 ≥24 字符的标题包含（2026-10-22：
/// 浏览器先在 PDF 阅读器里打开、人看完再点保存，学校登录也要几分钟——ACS 存下来叫
/// cs2c00851.pdf，过了窗就只剩「下载晚了」横幅，用户以为收不到）。
fn match_pending(
    pendings: &[PendingCatch],
    file_stem: &str,
    content_dois: &[String],
    now: std::time::SystemTime,
) -> Option<PendingMatch> {
    let file_norm = crate::lit_watch::normalize_title(file_stem);
    let age = |p: &PendingCatch| now.duration_since(p.opened_at).ok();
    // 时钟偏移 fail-closed（2026-09-17 修正）：opened_at 在未来（重启回拨/跨进程
    // 落盘时间戳漂移）时 duration_since 报 Err——旧 unwrap_or(ZERO) 把它当
    // 「刚打开」永久留在窗内；一律按出窗处理
    let within = |limit: Duration| -> Vec<usize> {
        pendings
            .iter()
            .enumerate()
            .filter(|(_, p)| age(p).is_some_and(|d| d <= limit))
            .map(|(i, _)| i)
            .collect()
    };
    let in_window = within(CATCH_WINDOW);
    let in_ttl = within(PENDING_TTL);
    if in_ttl.is_empty() {
        return None;
    }
    // 标题互相包含（多条命中取最近打开的——旧口径取队首第一条，短 norm 先入队者截胡）；
    // 窗外要求短边 ≥24，短标题只在窗内算
    let title_hit = in_ttl
        .iter()
        .copied()
        .filter(|&i| {
            let t = &pendings[i].title_norm;
            let short = t.len().min(file_norm.len());
            let need = if in_window.contains(&i) { 8 } else { 24 };
            !t.is_empty()
                && !file_norm.is_empty()
                && short >= need
                && (t.contains(&file_norm) || file_norm.contains(t))
        })
        .max_by_key(|&i| pendings[i].opened_at);
    if let Some(i) = title_hit {
        return Some(PendingMatch::Hit(i));
    }
    // MDPI 编号归一（2026-09-17 实测漏收场景）：文件名 reactions-07-00016 与标题
    // 永远对不上，但与 DOI 10.3390/reactions7010016 是同一组数——DOI 后缀 =
    // 刊名+卷+期(2位)+编号(末4位)，文件名 = 刊名-卷(2位)-编号(5位)。两边都归一
    // 成「刊名+卷整数+编号整数」比较；仅 10.3390 前缀启用（分型纪律：最窄分支）
    if let Some(fkey) = mdpi_file_key(file_stem) {
        let mdpi_hit = in_ttl
            .iter()
            .copied()
            .find(|&i| mdpi_doi_key(&pendings[i].doi).as_deref() == Some(fkey.as_str()));
        if let Some(i) = mdpi_hit {
            return Some(PendingMatch::Hit(i));
        }
    }
    // 文件名里带 DOI（10.1002_adma.xxx / 斜杠改成 -_）
    let doi_hit = in_ttl
        .iter()
        .copied()
        .find(|&i| doi_in_stem(&pendings[i].doi, file_stem));
    if let Some(i) = doi_hit {
        return Some(PendingMatch::Hit(i));
    }
    // PDF 元数据段带完整 DOI（`lit_watch::pdf_meta_dois`：XMP / 文档信息，ACS 在开头、
    // Elsevier 在结尾）。只认与登记完全相等的 DOI：后缀片段撞上别篇的面太大
    let content_hit = in_ttl
        .iter()
        .copied()
        .filter(|&i| {
            let doi = pendings[i].doi.trim().to_ascii_lowercase();
            doi.len() >= 8 && content_dois.iter().any(|t| *t == doi)
        })
        .max_by_key(|&i| pendings[i].opened_at);
    if let Some(i) = content_hit {
        return Some(PendingMatch::Hit(i));
    }
    // 窗内只开了一篇：文件名对不上也按这篇收。开了多篇不猜。
    if in_window.len() == 1 {
        return Some(PendingMatch::Fallback(in_window[0]));
    }
    None
}

fn doi_in_stem(doi: &str, stem: &str) -> bool {
    let doi = doi.trim().to_ascii_lowercase();
    if doi.len() < 8 {
        return false;
    }
    let lower = stem.to_ascii_lowercase();
    let suffix = doi.split_once('/').map(|(_, s)| s).unwrap_or("");
    lower.contains(&doi)
        || lower.contains(&doi.replace('/', "-"))
        || lower.contains(&doi.replace('/', "_"))
        || (suffix.len() >= 8 && lower.contains(suffix))
}

/// MDPI DOI → 刊名+卷+编号 整数键（10.3390/reactions7010016 → "reactions7a16"）
fn mdpi_doi_key(doi: &str) -> Option<String> {
    let suffix = doi.trim().strip_prefix("10.3390/")?;
    let letters_len = suffix
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .count();
    let letters = &suffix[..letters_len];
    let digits = &suffix[letters_len..];
    if letters.is_empty() || digits.len() < 7 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let vol: u32 = digits[..digits.len() - 6].parse().ok()?;
    let art: u32 = digits[digits.len() - 4..].parse().ok()?;
    Some(format!("{letters}{vol}a{art}"))
}

/// MDPI 下载文件名 → 同款键（reactions-07-00016 → "reactions7a16"）
fn mdpi_file_key(stem: &str) -> Option<String> {
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() != 3 || !parts[0].chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let vol: u32 = parts[1].parse().ok()?;
    let art: u32 = parts[2].parse().ok()?;
    Some(format!("{}{vol}a{art}", parts[0]))
}

/// 扩展「存到 Mesa」成功后消费对应 pending：通道 C 不经下载夹，90 秒窗里
/// 这条登记还占着，后续无关 PDF 会被兜底挂上。纯逻辑供单测。
fn consume_pending_index(
    pendings: &[PendingCatch],
    project_root: &str,
    doi: &str,
    title: &str,
    now: std::time::SystemTime,
) -> Option<usize> {
    if project_root.trim().is_empty() {
        return None;
    }
    let in_proj: Vec<usize> = pendings
        .iter()
        .enumerate()
        .filter(|(_, p)| {
            crate::paths::same_path(&p.project_root, project_root)
                && now
                    .duration_since(p.opened_at)
                    .map(|d| d <= PENDING_TTL)
                    .unwrap_or(false)
        })
        .map(|(i, _)| i)
        .collect();
    if in_proj.is_empty() {
        return None;
    }
    let doi_n = crate::inst_access::doi_from_url(doi)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let title_n = crate::lit_watch::normalize_title(title);
    let doi_hit = in_proj.iter().copied().find(|&i| {
        if doi_n.is_empty() || pendings[i].doi.is_empty() {
            return false;
        }
        let pdoi = pendings[i].doi.to_ascii_lowercase();
        pdoi == doi_n || pdoi.contains(&doi_n) || doi_n.contains(&pdoi)
    });
    if doi_hit.is_some() {
        return doi_hit;
    }
    let title_hit = in_proj.iter().copied().find(|&i| {
        let t = &pendings[i].title_norm;
        let short = t.len().min(title_n.len());
        !t.is_empty()
            && !title_n.is_empty()
            && short >= 8
            && (t.contains(&title_n) || title_n.contains(t))
    });
    if title_hit.is_some() {
        return title_hit;
    }
    // 该项目 90 秒窗内只有一条：就是刚打开的这篇
    let in_window: Vec<usize> = in_proj
        .into_iter()
        .filter(|&i| {
            now.duration_since(pendings[i].opened_at)
                .map(|d| d <= CATCH_WINDOW)
                .unwrap_or(false)
        })
        .collect();
    if in_window.len() == 1 {
        Some(in_window[0])
    } else {
        None
    }
}

/// 通道 C 入库成功：主程序回执监听调用，出队落盘（helper 是另一进程，动不了
/// 本进程 PENDING 内存）
pub(crate) fn consume_pending_after_helper(project_root: &str, doi: &str, title: &str) {
    let Ok(mut q) = PENDING.lock() else {
        return;
    };
    let disk = load_pendings();
    for p in disk {
        if !q.iter().any(|x| {
            x.open_url == p.open_url && x.title == p.title && x.project_root == p.project_root
        }) {
            q.push(p);
        }
    }
    let now = std::time::SystemTime::now();
    if let Some(i) = consume_pending_index(&q, project_root, doi, title, now) {
        q.remove(i);
        save_pendings(&q);
    }
}

/// 打开后不想下了：把这篇从收货登记里拿掉。之后别的 PDF 不会再兜底挂到它上面。
#[tauri::command]
pub async fn inst_browser_cancel(
    project_root: String,
    title: String,
    doi: String,
) -> Result<(), String> {
    let Ok(mut q) = PENDING.lock() else {
        return Err("收货登记暂时不可用".into());
    };
    let now = std::time::SystemTime::now();
    if let Some(i) = consume_pending_index(&q, &project_root, &doi, &title, now) {
        q.remove(i);
        save_pendings(&q);
    }
    Ok(())
}

/// 「在浏览器打开」：登记收货语境（有项目根时）→ 确保监听在跑 → 调起系统浏览器。
/// EZproxy/OpenAthens 前缀在打开前改写（浏览器里完成代理登录，同一 profile 持续有效）
#[tauri::command]
pub async fn inst_browser_open(
    app: tauri::AppHandle,
    url: String,
    project_root: Option<String>,
    title: Option<String>,
    doi: Option<String>,
) -> Result<(), String> {
    let target = url.trim().to_string();
    if !crate::inst_access::valid_http_url_pub(&target) {
        return Err("地址须是 http(s):// 开头的完整 URL".into());
    }
    // 前缀改写与内嵌窗同一口径（fetch_via_channel 的 proxy_wrap + 已代理判定）
    let settings = crate::settings::read_current();
    let open_target = settings
        .institutional_prefix
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .filter(|v| crate::inst_access::valid_http_url_pub(v))
        .map(|p| {
            if crate::inst_access::target_already_proxied(&target, p) {
                target.clone()
            } else {
                crate::inst_access::proxy_wrap_pub(p, &target)
            }
        })
        .unwrap_or(target.clone());
    let root = project_root
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|r| {
            crate::projects::ensure_task_project_root(Path::new(r))
                .map(|p| p.to_string_lossy().into_owned())
        })
        .transpose()?;
    // 「当前项目」语境：浏览器桥 helper（扩展「存到 Mesa」）落盘用。
    // 带上这篇的标题/DOI：PDF 阅读器页没有 citation_title 时 helper 用它起文件名，
    // 待获取清单才能对上「已存」（空标题会落成 paper.pdf / paper-5.pdf）
    let ctx_title = title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let ctx_doi = doi.as_deref().and_then(crate::inst_access::doi_from_url);
    if let Some(root) = root.as_ref() {
        if let Some(cfg) = crate::dirs::config_dir() {
            let mut ctx = serde_json::json!({
                "projectRoot": root,
                "updatedAt": chrono::Utc::now().to_rfc3339(),
            });
            if let Some(t) = ctx_title.as_deref() {
                ctx["title"] = serde_json::Value::String(t.to_string());
            }
            if let Some(d) = ctx_doi.as_deref() {
                ctx["doi"] = serde_json::Value::String(d.to_string());
            }
            let path = cfg.join("ccode").join("helper-context.json");
            let _ = std::fs::create_dir_all(path.parent().expect("has parent"));
            let _ = crate::storage::atomic_write(&path, ctx.to_string().as_bytes(), false);
        }
    }
    if let (Some(root), Some(title)) = (root.as_ref(), title.as_deref()) {
        let title = title.trim();
        if !title.is_empty() {
            if let Ok(mut q) = PENDING.lock() {
                // 并入上次进程留下的登记（SystemTime 可跨进程判定窗口）
                let disk = load_pendings();
                for p in disk {
                    if !q.iter().any(|x| {
                        x.open_url == p.open_url
                            && x.title == p.title
                            && x.project_root == p.project_root
                    }) {
                        q.push(p);
                    }
                }
                q.retain(|p| {
                    std::time::SystemTime::now()
                        .duration_since(p.opened_at)
                        .map(|d| d < PENDING_TTL)
                        .unwrap_or(false)
                });
                // 同一项目里同一篇重复「浏览器打开」：刷新时间戳，不追加（防窗口内
                // 出现同 URL 多条、白占多条名额）；**同篇不同项目并存两条**——
                // 旧键不含 project_root 时后打开的项目被吞，下载收进先打开的项目，
                // 用户在后一个项目里永远等不到（2026-09-17 审计）
                let now = std::time::SystemTime::now();
                if let Some(existing) = q
                    .iter_mut()
                    .find(|p| p.open_url == target && p.title == title && p.project_root == *root)
                {
                    existing.opened_at = now;
                } else {
                    q.push(PendingCatch {
                        project_root: root.clone(),
                        title_norm: crate::lit_watch::normalize_title(title),
                        title: title.to_string(),
                        // 前端给到的可能是 doi.org 链接 / doi: 前缀 / 带句读——归一成
                        // 裸 DOI 再存（MDPI 编号归一按 10.3390/ 前缀剥，喂 URL 永不命中）
                        doi: ctx_doi.clone().unwrap_or_default(),
                        open_url: target.clone(),
                        opened_at: now,
                    });
                }
                if q.len() > 16 {
                    let drop_n = q.len() - 16;
                    q.drain(0..drop_n);
                }
                save_pendings(&q);
            }
        }
    }
    ensure_watcher(&app)?;
    tauri_plugin_opener::open_url(open_target.clone(), None::<&str>)
        .map_err(|e| format!("调起系统浏览器失败: {e}"))
}

/// 应用启动即恢复监听：重启前留下的登记（盘上）也要有人接——此前监听只在
/// 下一次「浏览器打开」才启动，重启后到那之前的下载全漏（2026-09-17 实测）
pub fn ensure_watcher_at_startup(app: &tauri::AppHandle) {
    if let Err(e) = ensure_watcher(app) {
        dinbox_log(&format!("启动恢复监听失败: {e}"));
    }
}

/// 确保收货监听在跑。浏览器后来改了默认下载位置时，拆掉旧监听再按新目录启动。
fn ensure_watcher(app: &tauri::AppHandle) -> Result<(), String> {
    let dirs = watch_roots();
    if dirs.is_empty() {
        return Err("找不到可监听的下载目录".into());
    }
    if WATCHER_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        let same = WATCHED_DIRS
            .lock()
            .ok()
            .is_some_and(|have| same_watch_dirs(&have, &dirs));
        // 心跳停了：监听线程已经不在（或卡死），标记还亮着——照样重起
        if same && !watcher_stalled() {
            return Ok(());
        }
        if !same {
            dinbox_log("下载目录变了，按新目录重启监听");
        } else {
            dinbox_log("监听心跳停了，重启监听");
        }
        WATCHER_STOP.store(true, std::sync::atomic::Ordering::Release);
        let restart = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            WATCHER_BEAT.store(0, std::sync::atomic::Ordering::Release);
            WATCHER_RUNNING.store(false, std::sync::atomic::Ordering::Release);
            WATCHER_STOP.store(false, std::sync::atomic::Ordering::Release);
            let _ = ensure_watcher(&restart);
        });
        return Ok(());
    }
    // 闩锁纪律（2026-09-17 修正）：swap 置 true 之后任何提前返回都必须复位，
    // 否则一次瞬时失败（如定位不到下载目录）会把「单实例」永久占死——
    // 后续「在浏览器打开」全被 Ok(()) 假成功吞掉，再无人监听
    if let Ok(mut watched) = WATCHED_DIRS.lock() {
        *watched = dirs.clone();
    }
    // 快照既有 PDF：后续事件里命中快照的一律跳过
    let mut snap: HashMap<PathBuf, u64> = HashMap::new();
    for dir in &dirs {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if is_pdf_path(&p) {
                if let Ok(m) = e.metadata() {
                    snap.insert(p.clone(), m.len());
                }
            }
        }
    }
    if let Ok(mut g) = DL_FINGERPRINT.lock() {
        *g = Some(snap);
    }
    if let Ok(mut seen) = LAST_SEEN.lock() {
        seen.clear();
    }
    // 恢复上次进程留下的收货登记（重启场景）
    if let Ok(mut q) = PENDING.lock() {
        if q.is_empty() {
            *q = load_pendings();
        }
    }
    let app = app.clone();
    let dir_disp = dirs
        .iter()
        .map(|d| d.display().to_string())
        .collect::<Vec<_>>()
        .join("，");
    if let Err(e) = std::thread::Builder::new()
        .name("download-inbox".into())
        .spawn(move || watcher_loop(app, dirs))
    {
        WATCHER_RUNNING.store(false, std::sync::atomic::Ordering::Release);
        return Err(format!("启动收货监听失败: {e}"));
    }
    dinbox_log(&format!("监听已启动: {dir_disp}"));
    Ok(())
}

fn same_watch_dirs(left: &[PathBuf], right: &[PathBuf]) -> bool {
    left.len() == right.len()
        && left.iter().zip(right).all(|(a, b)| crate::paths::same_path(&a.to_string_lossy(), &b.to_string_lossy()))
}

fn is_pdf_path(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// 这一轮看到的文件还没写完（空文件 / 大小还在变 / 尾部没 %%EOF）：撤掉 5 秒去重记录，
/// 后续写入事件照常进来。2026-10-22 实测：Edge 另存为先建空 main.pdf、4.5 秒后才写完，
/// 首个事件读到空文件返回，之后的写入事件全落在 5 秒去重窗里被丢，这篇再没人看
fn release_seen(path: &Path) {
    if let Ok(mut seen) = LAST_SEEN.lock() {
        seen.remove(path);
    }
}

/// dl-reports 游标（持久化到 dl-reports.cursor——进程内偏移重启归零会把全部
/// 历史上报行当「新下载」重放，旧 PDF 被兜底归属误收进刚打开的篇目，终检二轮
/// 高危）。helper 截尾（文件变短）时跳到当前末尾：截尾保留的都是旧行。
static DL_REPORT_OFFSET: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static DL_CURSOR_LOADED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 只消费「进程启动之后」写入的上报行：cursor 缺失/损坏时兜底，避免全量重放
static PROCESS_STARTED_AT: std::sync::LazyLock<std::time::SystemTime> =
    std::sync::LazyLock::new(std::time::SystemTime::now);

fn dl_report_paths() -> Option<(PathBuf, PathBuf)> {
    crate::dirs::config_dir().map(|d| (d.join("dl-reports.jsonl"), d.join("dl-reports.cursor")))
}

/// 近期已处理过的文件（notify 与 dl-report 双通道去重 + 同文件重复上报去重）
static RECENT_CONSIDERED: std::sync::LazyLock<
    Mutex<std::collections::HashMap<PathBuf, std::time::Instant>>,
> = std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

fn already_considered(path: &Path) -> bool {
    RECENT_CONSIDERED
        .lock()
        .ok()
        .and_then(|m| {
            m.get(path)
                .map(|at| at.elapsed() < Duration::from_secs(600))
        })
        .unwrap_or(false)
}

fn mark_considered(path: &Path) {
    if let Ok(mut m) = RECENT_CONSIDERED.lock() {
        if m.len() > 64 {
            m.retain(|_, at| at.elapsed() < Duration::from_secs(600));
        }
        m.insert(path.to_path_buf(), std::time::Instant::now());
    }
}

/// 消费扩展上报的下载路径（helper 写 `<config>/ccode/dl-reports.jsonl`，每行
/// {at, path}）：新行里的 PDF 直接送 consider_file——绕过「监听目录 == 系统
/// Downloads」的假定（Chrome 改过下载位置/每下载询问时，notify 侧零事件）
fn drain_dl_reports(app: &tauri::AppHandle) {
    let Some((file, cursor_file)) = dl_report_paths() else {
        return;
    };
    if !DL_CURSOR_LOADED.swap(true, std::sync::atomic::Ordering::AcqRel) {
        let saved = std::fs::read_to_string(&cursor_file)
            .ok()
            .and_then(|t| t.trim().parse::<u64>().ok());
        // cursor 缺失/损坏：从文件当前末尾起步（历史行不再重放——丢失的只是
        // Mesa 关闭期间的上报，那段时间本也没有 pending 在等）
        let start =
            saved.unwrap_or_else(|| std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0) as u64);
        DL_REPORT_OFFSET.store(start, std::sync::atomic::Ordering::Relaxed);
    }
    let Ok(text) = std::fs::read_to_string(&file) else {
        return;
    };
    let mut offset = DL_REPORT_OFFSET.load(std::sync::atomic::Ordering::Relaxed) as usize;
    if text.len() < offset {
        // helper 截尾过：跳到末尾（保留行是旧记录）
        offset = text.len();
    }
    if text.len() <= offset {
        return;
    }
    // 只处理完整行（末尾残行等下一次）；对齐字符边界（截尾重写瞬间可能切在
    // 多字节字符中间——String 切片越界会 panic，终检二轮高危）
    let end = fresh_end(text.as_bytes(), offset);
    if end <= offset {
        return;
    }
    let complete = &text[offset..end];
    for line in complete.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        // 行时间戳早于进程启动的旧记录不消费（截尾重放兜底）
        let started_secs = PROCESS_STARTED_AT
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let fresh_line = v
            .get("at")
            .and_then(|a| a.as_str())
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.timestamp() > started_secs as i64)
            .unwrap_or(false);
        if !fresh_line {
            continue;
        }
        let Some(path) = v.get("path").and_then(|p| p.as_str()).map(str::to_string) else {
            continue;
        };
        let p = PathBuf::from(&path);
        if !p.is_absolute() || !is_pdf_path(&p) || !p.exists() || already_considered(&p) {
            continue;
        }
        dinbox_log(&format!("扩展上报下载: {path}"));
        consider_file_guarded(app, &p);
    }
    DL_REPORT_OFFSET.store(end as u64, std::sync::atomic::Ordering::Relaxed);
    let _ = std::fs::write(&cursor_file, end.to_string());
}

/// 从 offset 起取末尾为完整行的长度（对齐 UTF-8 字符边界与最后一个换行）
fn fresh_end(bytes: &[u8], offset: usize) -> usize {
    let mut end = bytes.len();
    if bytes.last() != Some(&b'\n') {
        end = bytes[..end]
            .iter()
            .rposition(|&b| b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(offset);
    }
    // 回退到字符边界（offset 起点的边界由「offset 总在 \n 后或文件尾」保证，
    // 截尾竞态下仍可能落在多字节中间——保守回退）
    while end > offset && end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    end
}

fn watcher_loop(app: tauri::AppHandle, dirs: Vec<PathBuf>) {
    use notify::{RecursiveMode, Watcher};
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(_) => {
            WATCHER_RUNNING.store(false, std::sync::atomic::Ordering::Release);
            return;
        }
    };
    let mut watching = 0;
    for dir in &dirs {
        match watcher.watch(dir, RecursiveMode::NonRecursive) {
            Ok(()) => watching += 1,
            Err(e) => dinbox_log(&format!("watch 失败 {}: {e:?}", dir.display())),
        }
    }
    if watching == 0 {
        WATCHER_RUNNING.store(false, std::sync::atomic::Ordering::Release);
        return;
    }
    let mut last_event = std::time::Instant::now();
    beat();
    loop {
        // 扩展上报的下载（浏览器下载位置不在系统 Downloads 时目录监听看不见，
        // 2026-09-17 审计 #17）：helper 落 dl-reports.jsonl，这里增量消费——
        // 路径直接走 consider_file，不受监听目录限定
        drain_dl_reports(&app);
        // 无 pending 且静默满 IDLE_STOP → 退出（watcher 随之 drop）
        let pending_empty = PENDING
            .lock()
            .map(|mut q| {
                let before = q.len();
                q.retain(|p| {
                    std::time::SystemTime::now()
                        .duration_since(p.opened_at)
                        .map(|d| d < PENDING_TTL)
                        .unwrap_or(false)
                });
                if q.len() != before {
                    save_pendings(&q);
                }
                q.is_empty()
            })
            .unwrap_or(true);
        if WATCHER_STOP.load(std::sync::atomic::Ordering::Relaxed)
            || (pending_empty && last_event.elapsed() > IDLE_STOP)
        {
            break;
        }
        beat();
        // 浏览器自己的下载记录：下到哪个文件夹都在里面（目录监听只看得见下载夹）
        if !pending_empty {
            drain_browser_history(&app);
        }
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(event)) => {
                last_event = std::time::Instant::now();
                if !event_worth_considering(&event.kind) {
                    continue;
                }
                let touched: Vec<PathBuf> = event
                    .paths
                    .iter()
                    .filter(|p| is_pdf_path(p))
                    .cloned()
                    .collect();
                if touched.is_empty() {
                    continue;
                }
                for p in touched {
                    consider_file_guarded(&app, &p);
                }
            }
            Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    WATCHER_RUNNING.store(false, std::sync::atomic::Ordering::Release);
}

/// 事件过滤链主体：去重 → 既有快照排除 → 稳定检测（写不完就放手等 Modify）→
/// 魔数/尾部完整性 → 归属（Hit 自动收+挪走；Fallback 收但原件留在下载夹）→ 入库
///
/// 监听线程只经这一层调：单个文件出错（panic）只丢这一个，线程不死。线程一死
/// WATCHER_RUNNING 仍是 true，之后每次「官网」都以为在监听、谁也收不到（2026-10-22 实测
/// 漏收、查不出原因时补的保险）
fn consider_file_guarded(app: &tauri::AppHandle, path: &Path) {
    let run = std::panic::AssertUnwindSafe(|| consider_file(app, path));
    if std::panic::catch_unwind(run).is_err() {
        dinbox_log(&format!("处理出错，跳过这个文件: {}", path.display()));
    }
}

/// 监听循环心跳（UNIX 秒）。循环每 5 秒至少走一圈；ensure_watcher 见心跳停了超过
/// 60 秒就当线程已死、重新起一个
static WATCHER_BEAT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn beat() {
    WATCHER_BEAT.store(now_secs(), std::sync::atomic::Ordering::Release);
}

fn watcher_stalled() -> bool {
    let last = WATCHER_BEAT.load(std::sync::atomic::Ordering::Acquire);
    // 稳定检测最多占 30 秒，留足余量
    last != 0 && now_secs().saturating_sub(last) > 60
}

// ===== 浏览器下载记录（2026-10-22，用户：不论下到哪里都该收到） =====
//
// Chromium 系（Edge / Chrome / Brave / Chromium）把每次下载记在 profile 的 History
// 库 downloads 表：保存路径、完成时间、类型。目录监听只看得见下载夹和默认目录，
// 另存到别处的看不见；这里补上。只在有收货登记时读；History 没变就不读；
// 浏览器开着时库被占用，复制一份到临时目录只读查询、读完即删；只取登记之后完成的
// PDF 下载行，不读浏览历史。

/// 每份 History 上次看过的修改时间与大小（没变就跳过）
static HISTORY_STAMP: std::sync::LazyLock<Mutex<HashMap<PathBuf, (std::time::SystemTime, u64)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
/// 已经送去判定过的下载（guid）
static HISTORY_DONE: std::sync::LazyLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

/// Chromium 时间戳（1601-01-01 起的微秒）
fn chromium_micros(t: std::time::SystemTime) -> i64 {
    const EPOCH_GAP_US: i64 = 11_644_473_600_000_000;
    t.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64 + EPOCH_GAP_US)
        .unwrap_or(0)
}

fn browser_history_files() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in browser_user_data_dirs() {
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        for entry in rd.flatten().take(12) {
            let history = entry.path().join("History");
            if history.is_file() {
                out.push(history);
            }
        }
    }
    out
}

/// 从 History 库（副本）读 `since` 之后完成的 PDF 下载：(guid, 保存路径)
fn completed_pdf_downloads(db: &Path, since: std::time::SystemTime) -> Vec<(String, PathBuf)> {
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT guid, target_path, mime_type FROM downloads \
         WHERE state = 1 AND end_time > ?1 ORDER BY end_time",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([chromium_micros(since)], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?.unwrap_or_default(),
        ))
    });
    let Ok(rows) = rows else {
        return Vec::new();
    };
    rows.flatten()
        .filter(|(_, path, mime)| {
            !path.is_empty() && (mime.eq_ignore_ascii_case("application/pdf") || is_pdf_path(Path::new(path)))
        })
        .map(|(guid, path, _)| (guid, PathBuf::from(path)))
        .collect()
}

fn drain_browser_history(app: &tauri::AppHandle) {
    // 最早一条有效登记之前的下载与这次收货无关
    let Some(since) = PENDING.lock().ok().and_then(|q| q.iter().map(|p| p.opened_at).min()) else {
        return;
    };
    let since = since.checked_sub(Duration::from_secs(10)).unwrap_or(since);
    for history in browser_history_files() {
        let Ok(meta) = std::fs::metadata(&history) else { continue };
        let stamp = (meta.modified().unwrap_or(std::time::UNIX_EPOCH), meta.len());
        let changed = HISTORY_STAMP
            .lock()
            .map(|mut m| m.insert(history.clone(), stamp) != Some(stamp))
            .unwrap_or(false);
        if !changed {
            continue;
        }
        let copy = std::env::temp_dir().join(format!(
            "mesa-history-{}-{}.sqlite",
            std::process::id(),
            now_secs()
        ));
        if std::fs::copy(&history, &copy).is_err() {
            continue;
        }
        let rows = completed_pdf_downloads(&copy, since);
        let _ = std::fs::remove_file(&copy);
        for (guid, path) in rows {
            let fresh = HISTORY_DONE.lock().map(|mut s| s.insert(guid)).unwrap_or(false);
            if !fresh || !path.is_file() || already_considered(&path) {
                continue;
            }
            dinbox_log(&format!("浏览器下载记录: {}", path.display()));
            consider_file_guarded(app, &path);
        }
    }
}

/// 事件过滤链主体：去重 → 既有快照排除 → 稳定检测（写不完就放手等 Modify）→
/// 魔数/尾部完整性 → 归属（Hit 自动收+挪走；Fallback 收但原件留在下载夹）→ 入库
fn consider_file(app: &tauri::AppHandle, path: &Path) {
    let Some(name) = path.file_name().map(|n| n.to_os_string()) else {
        return;
    };
    if already_considered(path) {
        return;
    }
    // 窗口从**文件出现那刻**算（2026-09-17 审计：稳定检测最多耗 30s，用判定时刻
    // 对窗会把「排队在上一篇 settle 后面」的下载推出 90 秒窗白白漏收）
    let first_seen = std::time::SystemTime::now();
    let now = std::time::Instant::now();
    // ④ 5s 去重（一次落盘连发多条事件）——静默，不刷终端
    if let Ok(mut seen) = LAST_SEEN.lock() {
        if seen
            .get(path)
            .is_some_and(|at| now.duration_since(*at) < DEDUP_WINDOW)
        {
            return;
        }
        seen.insert(path.to_path_buf(), now);
    }
    // ② 监听启动快照里的既有文件（大小也没变）不收
    if let Ok(g) = DL_FINGERPRINT.lock() {
        if let Some(old_len) = g.as_ref().and_then(|m| m.get(path)) {
            if let Ok(m) = std::fs::metadata(path) {
                if m.len() == *old_len {
                    return;
                }
            }
        }
    }
    // ③ 稳定检测：等 1.2s，大小不再变才算写完（最多再等 25 轮 ≈30s——
    // Safari 等边下边写的浏览器，慢速大文件 6s 不够，提前读会截到半截）
    let mut len = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    let mut settled = false;
    for _ in 0..25 {
        std::thread::sleep(SETTLE_DELAY);
        let cur = match std::fs::metadata(path) {
            Ok(m) => m.len(),
            Err(_) => return, // 写到一半被挪走/删除
        };
        if cur == len {
            settled = true;
            break;
        }
        len = cur;
    }
    // 25 轮耗尽仍不稳定：放弃本轮（2026-09-17 审计：旧口径无论稳不稳定都往下
    // 读——Safari 慢速大 PDF 30 秒读半截，头部魔数照样过，截断文件被收编且原件
    // 进回收站，完整版永远收不进）；后续 Modify 事件会重走稳定检测
    if !settled {
        dinbox_log(&format!("仍在写入，放手等下一次事件: {}", path.display()));
        release_seen(path);
        return;
    }
    // ⑤ 魔数 + 上限（下载内容可能是「另存网页」的 HTML）。超 60MB 不再静默
    // （终检二轮：>40MB 改道已承诺自动收，超限静默丢弃变成无痕丢失归属）——
    // TTL 内有 pending 时发 oversize 提示，没有 pending 的无关大文件保持安静
    if len == 0 {
        release_seen(path);
        return;
    }
    if len > crate::lit_watch::DOWNLOAD_CAP as u64 {
        let near = PENDING.lock().ok().and_then(|q| {
            q.iter()
                .filter(|p| {
                    first_seen
                        .duration_since(p.opened_at)
                        .map(|d| d <= PENDING_TTL)
                        .unwrap_or(false)
                })
                .max_by_key(|p| p.opened_at)
                .cloned()
        });
        if let Some(p) = near {
            emit_attention(app, "oversize", path, &p.project_root, &p.title);
            mark_considered(path);
        }
        return;
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => {
            release_seen(path);
            return;
        }
    };
    if !crate::lit_watch::looks_like_pdf(&bytes) {
        dinbox_logbuf(&format!("非 PDF 跳过：{}", name.to_string_lossy()));
        return;
    }
    // 尾部 %%EOF：魔数只看头 1024 字节，截断文件照样过（2026-09-17 审计；
    // 标准写法末尾必有 %%EOF，追加空白也在 2KB 窗口内）
    if !crate::inst_access::pdf_tail_complete(&bytes) {
        dinbox_log(&format!(
            "尾部无 %%EOF（可能仍在写入），等下一次事件: {}",
            path.display()
        ));
        release_seen(path);
        return;
    }
    // ⑥ 归属匹配；Hit 即消费（出队落盘，同一登记不占后续下载的窗口名额），
    // Fallback 只收不消费（窗口名额留着，归属依据交代给用户）
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    // PDF 元数据段的 DOI：文件名是出版商编号（cs2c00851 / main）时靠它认
    let head = crate::lit_watch::pdf_meta_dois(&bytes);
    let matched = PENDING.lock().ok().and_then(|mut q| {
        dinbox_logbuf(&format!(
            "归属判定: stem={stem:?} 窗内登记 {} 条",
            q.iter()
                .filter(|p| {
                    first_seen
                        .duration_since(p.opened_at)
                        .map(|d| d <= CATCH_WINDOW)
                        .unwrap_or(false)
                })
                .count()
        ));
        match match_pending(&q, &stem, &head, first_seen) {
            Some(PendingMatch::Hit(i)) => {
                let p = q.get(i).cloned();
                if let Some(kept) = q.get(i) {
                    let url = kept.open_url.clone();
                    let title = kept.title.clone();
                    let root = kept.project_root.clone();
                    q.retain(|x| {
                        !(x.open_url == url && x.title == title && x.project_root == root)
                    });
                }
                save_pendings(&q);
                p.map(|p| (p, true))
            }
            Some(PendingMatch::Fallback(i)) => {
                // Fallback 同样消费（终检二轮：不消费时 90 秒窗内每个无关 PDF
                // 都各走一遍兜底入库、误收面放大；消费后最多错一次，原件保留
                // 在下载夹 + 横幅交代归属依据，可用「关联本地 PDF」改正）
                let p = q.get(i).cloned();
                if let Some(kept) = q.get(i) {
                    let url = kept.open_url.clone();
                    let title = kept.title.clone();
                    let root = kept.project_root.clone();
                    q.retain(|x| {
                        !(x.open_url == url && x.title == title && x.project_root == root)
                    });
                }
                save_pendings(&q);
                p.map(|p| (p, false))
            }
            None => {
                let mut in_window: Vec<PendingCatch> = q
                    .iter()
                    .filter(|p| {
                        first_seen
                            .duration_since(p.opened_at)
                            .map(|d| d <= CATCH_WINDOW)
                            .unwrap_or(false)
                    })
                    .cloned()
                    .collect();
                if in_window.len() >= 2 {
                    // 开了多篇、文件名对不上：不猜，横幅让人点挂到哪篇
                    in_window.sort_by_key(|p| std::cmp::Reverse(p.opened_at));
                    let first = in_window[0].clone();
                    emit_attention_with(
                        app,
                        "ambiguous",
                        path,
                        &first.project_root,
                        &first.title,
                        &in_window,
                    );
                    mark_considered(path);
                } else {
                    // 窗内没登记但 TTL 内有旧的（下载晚了错过 90 秒窗）→ 提示补救
                    let late = q
                        .iter()
                        .filter(|p| {
                            first_seen
                                .duration_since(p.opened_at)
                                .map(|d| d <= PENDING_TTL)
                                .unwrap_or(false)
                        })
                        .max_by_key(|p| p.opened_at)
                        .cloned();
                    if let Some(p) = late {
                        emit_attention(app, "late", path, &p.project_root, &p.title);
                        mark_considered(path);
                    }
                }
                None
            }
        }
    });
    let Some((p, confident)) = matched else {
        // 窗内 0 条登记：下载夹里无关/旧 PDF 被 Spotlight 摸了一下，不刷终端
        return;
    };
    mark_considered(path);
    // 语境跟实际命中的那篇走（多项目并行打开时不得沿用最后一次打开的）
    crate::inst_access::set_relay_context(&p.project_root, &p.title, &p.open_url);
    match crate::inst_access::stage_relayed_pdf(&bytes) {
        Ok(staged) => {
            crate::inst_access::emit_relayed_pdf(app, &staged, bytes.len());
            if confident {
                // 高置信（文件名与标题/MDPI 编号对上）：收完挪回收站（可反悔）；
                // 入库链读内存槽，不依赖原文件
                let _ = trash::delete(path);
            } else {
                // 窗内只开了一篇、文件名对不上：原文件留在下载夹
                emit_attention(app, "fallback", path, &p.project_root, &p.title);
            }
            dinbox_log(&format!(
                "已收进 {}{}：{}{}",
                p.project_root,
                if confident {
                    ""
                } else {
                    "（窗内只开了一篇，原件留在下载夹）"
                },
                p.title,
                if p.doi.is_empty() {
                    String::new()
                } else {
                    format!("（{}）", p.doi)
                }
            ));
        }
        Err(e) => {
            dinbox_log(&format!("收货入库失败: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(title: &str, ago: Duration) -> PendingCatch {
        PendingCatch {
            project_root: "/proj".into(),
            title_norm: crate::lit_watch::normalize_title(title),
            title: title.into(),
            doi: String::new(),
            open_url: "https://doi.org/10.1/x".into(),
            opened_at: std::time::SystemTime::now() - ago,
        }
    }

    #[test]
    fn browser_history_lists_completed_pdfs_after_since() {
        // 结构按 Edge 实测 downloads 表的相关列（2026-10-22）
        let dir = std::env::temp_dir().join(format!("mesa-hist-{}-{}", std::process::id(), now_secs()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("History");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE downloads (id INTEGER PRIMARY KEY, guid TEXT, target_path TEXT, \
             end_time INTEGER, state INTEGER, mime_type TEXT);",
        )
        .unwrap();
        let since = std::time::SystemTime::now() - Duration::from_secs(60);
        let before = chromium_micros(since) - 5_000_000;
        let after = chromium_micros(since) + 5_000_000;
        for (guid, path, end, state, mime) in [
            ("old", "D:\\x\\old.pdf", before, 1, "application/pdf"),
            ("mx", "D:\\papers\\1-s2.0-S2666935821001245-main.pdf", after, 1, "application/pdf"),
            ("ext", "D:\\x\\noext", after, 1, "application/pdf"),
            ("half", "D:\\x\\half.pdf", after, 0, "application/pdf"),
            ("zip", "D:\\x\\data.zip", after, 1, "application/zip"),
        ] {
            conn.execute(
                "INSERT INTO downloads (guid, target_path, end_time, state, mime_type) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![guid, path, end, state, mime],
            )
            .unwrap();
        }
        drop(conn);
        let got: Vec<String> = completed_pdf_downloads(&db, since).into_iter().map(|(g, _)| g).collect();
        // 登记之前的、没下完的、不是 PDF 的都不要；按类型认，不挑扩展名
        assert_eq!(got, vec!["mx", "ext"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chromium_time_matches_edge_rows() {
        // Edge 实测（MXene 那次下载）：start_time 13437145524762633 = 2026-10-22 12:25:24 UTC
        let t = std::time::UNIX_EPOCH + Duration::from_secs(1_792_671_924);
        assert_eq!(chromium_micros(t) / 1_000_000, 13_437_145_524);
    }

    #[test]
    fn browser_download_dirs_read_custom_defaults_only() {
        let chrome = r#"{"download":{"default_directory":"/Users/me/Literature"},"other":1}"#;
        assert_eq!(
            chrome_default_directories(chrome),
            vec![PathBuf::from("/Users/me/Literature")]
        );
        // PDF 阅读器里点保存落在「另存为」上次停的目录
        let both = r#"{"download":{"default_directory":"/Users/me/Literature"},"savefile":{"default_directory":"/Users/me/Desktop"}}"#;
        assert_eq!(
            chrome_default_directories(both),
            vec![PathBuf::from("/Users/me/Literature"), PathBuf::from("/Users/me/Desktop")]
        );
        assert!(chrome_default_directories(r#"{"download":{"default_directory":""}}"#).is_empty());
        assert!(chrome_default_directories("not json").is_empty());

        let firefox = [
            r#"user_pref("browser.download.folderList", 2);"#,
            r#"user_pref("browser.download.dir", "/Users/me/Papers");"#,
        ]
        .join("\n");
        assert_eq!(
            firefox_custom_directory(&firefox).unwrap(),
            PathBuf::from("/Users/me/Papers")
        );
        // 1 是系统下载，不再另加一个目录
        assert!(firefox_custom_directory(
            "user_pref(\"browser.download.folderList\", 1);\nuser_pref(\"browser.download.dir\", \"/Users/me/Papers\");"
        )
        .is_none());
        assert!(firefox_custom_directory("user_pref(\"browser.download.folderList\", 2);").is_none());
    }

    #[test]
    fn match_by_title_containment() {
        let q = vec![pending(
            "Development of a chloride-free dual-salt electrolyte",
            Duration::from_secs(10),
        )];
        let stem =
            "Development of a chloride-free dual-salt electrolyte for magnesium-sulfur batteries";
        assert_eq!(
            match_pending(&q, stem, &[], std::time::SystemTime::now()),
            Some(PendingMatch::Hit(0))
        );
    }

    #[test]
    fn match_single_pending_relaxed_without_title_hit() {
        // 窗内只有一条 pending：文件名对不上也收（放宽防漏），但走 Fallback 语义
        // ——原件留在下载夹、应用内横幅交代归属依据（2026-09-17 审计改口径）
        let q = vec![pending("Some Paper", Duration::from_secs(30))];
        assert_eq!(
            match_pending(&q, "unrelated download", &[], std::time::SystemTime::now()),
            Some(PendingMatch::Fallback(0))
        );
    }

    #[test]
    fn multiple_pendings_unmatched_does_not_guess() {
        // 开了两篇、文件名对不上：不猜最近打开的
        let q = vec![
            pending("Paper A long enough title here", Duration::from_secs(10)),
            pending("Paper B another distinct title", Duration::from_secs(20)),
        ];
        assert_eq!(
            match_pending(&q, "unrelated", &[], std::time::SystemTime::now()),
            None
        );
    }

    #[test]
    fn filename_doi_is_high_confidence_hit() {
        let mut a = pending("Paper A long enough title here", Duration::from_secs(10));
        a.doi = "10.1002/adma.202304268".into();
        let mut b = pending("Paper B another distinct title", Duration::from_secs(20));
        b.doi = "10.1016/j.jallcom.2026.190140".into();
        let q = vec![a, b];
        assert_eq!(
            match_pending(&q, "10.1002_adma.202304268", &[], std::time::SystemTime::now()),
            Some(PendingMatch::Hit(0))
        );
    }

    #[test]
    fn short_title_norm_does_not_hijack_other_pending() {
        // 短边 ≥8 护栏（2026-09-17 审计）：「Magnetic materials」（norm 17 字符有效）
        // 与更长的 B 篇——下载 B 的 PDF（文件名含 B 全题，也包含 A 的 norm）时
        // 不得被先入队的 A 截胡；A 的 norm 不足 8 字符时直接不算命中
        let mut a = pending("Magnetic", Duration::from_secs(30));
        a.title = "Magnetic".into();
        a.title_norm = crate::lit_watch::normalize_title("Magnetic");
        let b = pending(
            "Magnetic materials based sensors for battery systems",
            Duration::from_secs(10),
        );
        let q = vec![a, b];
        let stem = "Magnetic materials based sensors for battery systems";
        // A 的 norm（8 字符）虽达护栏，但多条包含命中取最近打开 → B
        assert_eq!(
            match_pending(&q, stem, &[], std::time::SystemTime::now()),
            Some(PendingMatch::Hit(1))
        );
        // 超短 norm（2 字符）永不构成命中：只剩 Fallback
        let mut tiny = pending("Mg", Duration::from_secs(30));
        tiny.title = "Mg".into();
        tiny.title_norm = crate::lit_watch::normalize_title("Mg");
        assert_eq!(
            match_pending(
                &[tiny],
                "Magnetic materials based sensors",
                &[],
                std::time::SystemTime::now()
            ),
            Some(PendingMatch::Fallback(0))
        );
    }

    #[test]
    fn out_of_window_not_matched() {
        let q = vec![pending("Old Paper", CATCH_WINDOW + Duration::from_secs(5))];
        assert_eq!(
            match_pending(&q, "Old Paper", &[], std::time::SystemTime::now()),
            None
        );
    }

    #[test]
    fn past_window_needs_firm_evidence() {
        // 浏览器先在 PDF 阅读器里打开、几分钟后才点保存（2026-10-22 实测 ACS：
        // 存下来叫 cs2c00851.pdf）：过了 90 秒窗，PDF 元数据里带本篇 DOI 照收
        let mut acs = pending(
            "Pt–Ru Dimer Electrocatalyst with Electron Redistribution for Hydrogen Evolution Reaction",
            Duration::from_secs(300),
        );
        acs.doi = "10.1021/acscatal.2c00851".into();
        let xmp = crate::lit_watch::pdf_meta_dois(
            b"%PDF-1.7\n<dc:identifier>10.1021/acscatal.2c00851</dc:identifier>\n",
        );
        let now = std::time::SystemTime::now();
        assert_eq!(
            match_pending(std::slice::from_ref(&acs), "cs2c00851", &xmp, now),
            Some(PendingMatch::Hit(0))
        );
        // 长标题包含也算；名字对不上又没 DOI 的，窗外不猜
        assert_eq!(
            match_pending(
                std::slice::from_ref(&acs),
                "Pt-Ru Dimer Electrocatalyst with Electron Redistribution",
                &[],
                now
            ),
            Some(PendingMatch::Hit(0))
        );
        assert_eq!(match_pending(std::slice::from_ref(&acs), "main (1)", &[], now), None);
        // 只认完整 DOI：别篇的 DOI 不算
        assert_eq!(
            match_pending(
                std::slice::from_ref(&acs),
                "main (1)",
                &["10.1021/acscatal.2c00852".to_string()],
                now
            ),
            None
        );
        // Elsevier：文件名 main.pdf，DOI 带括号、在文档信息里转义
        let mut els = pending(
            "An efficient and stable high-entropy alloy electrocatalyst for hydrogen evolution reaction",
            Duration::from_secs(400),
        );
        els.doi = "10.1016/s1872-2067(24)60067-7".into();
        let info = crate::lit_watch::pdf_meta_dois(
            b"%PDF-1.7\n/doi (10.1016/S1872-2067\\(24\\)60067-7)\n",
        );
        assert_eq!(match_pending(std::slice::from_ref(&els), "main", &info, now), Some(PendingMatch::Hit(0)));
        // 过了登记有效期一律不收
        acs.opened_at = now - PENDING_TTL - Duration::from_secs(5);
        assert_eq!(match_pending(&[acs], "cs2c00851", &xmp, now), None);
    }

    #[test]
    fn future_opened_at_is_out_of_window() {
        // 时钟偏移/跨进程落盘时间戳漂移导致 opened_at 在未来：fail-closed 出窗，
        // 不当「刚打开」永久留在窗内（2026-09-17 修正的回归钉）
        let q = vec![PendingCatch {
            project_root: "/proj".into(),
            title_norm: crate::lit_watch::normalize_title("Future Paper"),
            title: "Future Paper".into(),
            doi: String::new(),
            open_url: "https://doi.org/10.1/x".into(),
            opened_at: std::time::SystemTime::now() + Duration::from_secs(300),
        }];
        assert_eq!(
            match_pending(&q, "Future Paper", &[], std::time::SystemTime::now()),
            None
        );
    }

    #[test]
    fn mdpi_filename_matches_by_number_key() {
        // MDPI 下载文件名与标题永远对不上，靠 DOI 编号归一命中
        // （2026-09-17 实测漏收：窗口内两条 pending、文件名 reactions-07-00016）
        assert_eq!(
            mdpi_doi_key("10.3390/reactions7010016").as_deref(),
            Some("reactions7a16")
        );
        assert_eq!(
            mdpi_doi_key("10.3390/solids7010007").as_deref(),
            Some("solids7a7")
        );
        assert_eq!(
            mdpi_file_key("reactions-07-00016").as_deref(),
            Some("reactions7a16")
        );
        assert_eq!(
            mdpi_file_key("solids-07-00007").as_deref(),
            Some("solids7a7")
        );
        assert_eq!(mdpi_doi_key("10.1016/j.checat.2026.101758"), None);

        let mut a = pending("Some Other Paper", Duration::from_secs(30));
        a.doi = "10.1016/j.checat.2026.101758".into();
        let mut b = pending(
            "Polyaniline-Pyrrole as a Potential Cathode Modifier",
            Duration::from_secs(20),
        );
        b.doi = "10.3390/reactions7010016".into();
        let q = vec![a, b];
        assert_eq!(
            match_pending(&q, "reactions-07-00016", &[], std::time::SystemTime::now()),
            Some(PendingMatch::Hit(1))
        );
        // 非 MDPI 文件名、窗内两篇：不猜
        assert_eq!(
            match_pending(&q, "main (1)", &[], std::time::SystemTime::now()),
            None
        );
    }

    #[test]
    fn consume_pending_matches_doi_or_lone_window() {
        let mut a = pending("Paper A long enough title", Duration::from_secs(10));
        a.doi = "10.1016/j.jallcom.2026.190140".into();
        let mut b = pending("Paper B another distinct title", Duration::from_secs(20));
        b.doi = "10.1002/adma.202304268".into();
        let q = vec![a.clone(), b];
        let now = std::time::SystemTime::now();
        assert_eq!(
            consume_pending_index(
                &q,
                "/proj",
                "10.1016/j.jallcom.2026.190140",
                "unrelated",
                now
            ),
            Some(0)
        );
        assert_eq!(
            consume_pending_index(&q, "/proj", "", "Paper B another distinct title here", now),
            Some(1)
        );
        // 别的项目不动
        assert_eq!(
            consume_pending_index(&q, "/other", "10.1016/j.jallcom.2026.190140", "", now),
            None
        );
        // 窗内只一条、没 DOI/标题：仍消费（通道 C 刚打开就存）
        assert_eq!(
            consume_pending_index(&[a], "/proj", "", "paper-5", now),
            Some(0)
        );
    }

    #[test]
    fn metadata_and_access_events_are_ignored() {
        use notify::event::{
            AccessKind, CreateKind, DataChange, EventKind, MetadataKind, ModifyKind, RemoveKind,
        };
        assert!(!event_worth_considering(&EventKind::Access(
            AccessKind::Any
        )));
        assert!(!event_worth_considering(&EventKind::Modify(
            ModifyKind::Metadata(MetadataKind::Any)
        )));
        assert!(!event_worth_considering(&EventKind::Remove(
            RemoveKind::Any
        )));
        assert!(event_worth_considering(&EventKind::Create(
            CreateKind::File
        )));
        assert!(event_worth_considering(&EventKind::Modify(
            ModifyKind::Data(DataChange::Content)
        )));
        assert!(event_worth_considering(&EventKind::Any));
        assert!(event_worth_considering(&EventKind::Modify(ModifyKind::Any)));
    }
}
