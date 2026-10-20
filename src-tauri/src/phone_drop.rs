//! 从手机添加（2026-10-20；设计 docs/design-phone-drop.md，安全口径 safety.md 同名条）。
//!
//! 人在 Mesa 里点了「从手机添加」才在局域网上开一个只收不出的小服务：手机扫码打开网页，
//! 传照片 / 文件 / 一句话；收到的先进 Mesa 自己的暂存区（`<配置根>/phone-inbox/`），
//! 人点了才进项目（项目根多出未跟踪文件会挡工作区合并，见 review_contract）。
//! 点停止 / 30 分钟没收到新东西 / Mesa 退出即关；令牌每次新开，错令牌与未知路径同一个 404。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_SESSION_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 20_000;
const MAX_TEXT_BYTES: u64 = 128 * 1024;
const MAX_ACTIVE_UPLOADS: usize = 3;
/// 上传这么久没有新字节就不算「进行中」：手机息屏或离开网络时连接可能永远不断，
/// 不能让卡死的连接把名额占满、之后一律 503
const STALL_AFTER: Duration = Duration::from_secs(120);
const IDLE_STOP: Duration = Duration::from_secs(30 * 60);
const STAGE_TTL_SECS: i64 = 7 * 24 * 3600;
const PART_TTL_SECS: i64 = 3600;
const MAX_NAME_CHARS: usize = 80;

const PAGE_HTML: &str = include_str!("../resources/phone-drop/index.html");
const PAGE_JS: &str = include_str!("../resources/phone-drop/app.js");
const PAGE_CSS: &str = include_str!("../resources/phone-drop/app.css");
/// 手机页三个静态文件同源加载，不写内联脚本 / 样式（与 Mesa 生产 CSP 同一纪律）
const PAGE_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// ===== 暂存区与索引 =====

/// 暂存目录（不保证存在）：读取白名单用（pdf::read_whitelisted_sync）
pub(crate) fn stage_dir_path() -> Option<PathBuf> {
    crate::storage::config_root().map(|r| r.join("phone-inbox"))
}

fn ensure_stage_dir() -> Result<PathBuf, String> {
    let dir = stage_dir_path().ok_or("无法确定 Mesa 数据目录")?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建暂存目录失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredItem {
    id: String,
    /// image / pdf / file / text
    kind: String,
    /// 原名（清洗过，只当显示用）；文字条目是第一行摘要
    name: String,
    /// 暂存区里的文件名；文字条目没有
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    text: Option<String>,
    size: u64,
    received_at: String,
    received_secs: i64,
    /// new（还没处理）/ attached（附到了对话）/ placed（放进了项目）/ saved（另存了）
    status: String,
    #[serde(default)]
    placed_to: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StageIndex {
    #[serde(default)]
    items: Vec<StoredItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneItemDto {
    pub id: String,
    pub kind: String,
    pub name: String,
    /// 暂存文件绝对路径（附到对话时按路径随消息发出）；文字条目为 None
    pub path: Option<String>,
    pub text: Option<String>,
    pub size: u64,
    pub received_at: String,
    pub status: String,
    pub placed_to: Option<String>,
}

fn to_dto(dir: &Path, it: &StoredItem) -> PhoneItemDto {
    PhoneItemDto {
        id: it.id.clone(),
        kind: it.kind.clone(),
        name: it.name.clone(),
        path: it
            .file
            .as_ref()
            .map(|f| dir.join(f).to_string_lossy().into_owned()),
        text: it.text.clone(),
        size: it.size,
        received_at: it.received_at.clone(),
        status: it.status.clone(),
        placed_to: it.placed_to.clone(),
    }
}

static INDEX_LOCK: Mutex<()> = Mutex::new(());

/// 索引读改写：进程锁 + OS 文件锁 + 原子写（同配置读改写口径）。
/// 索引损坏时原件改名留证、从空表继续——这是暂存区不是配置，不能因此收不了东西；
/// 没登记的文件 7 天后照样被清理
fn with_index<T>(dir: &Path, f: impl FnOnce(&mut StageIndex) -> Result<T, String>) -> Result<T, String> {
    let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _flock = crate::storage::lock_at(&dir.join(".items.lock"))?;
    let path = dir.join("items.json");
    let mut index = match fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<StageIndex>(&bytes) {
            Ok(v) => v,
            Err(_) => {
                let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
                let _ = fs::rename(&path, dir.join(format!("items.corrupt-{stamp}.json")));
                StageIndex::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => StageIndex::default(),
        Err(e) => return Err(format!("读取暂存索引失败: {e}")),
    };
    let out = f(&mut index)?;
    let bytes = serde_json::to_vec_pretty(&index).map_err(|e| e.to_string())?;
    crate::storage::atomic_write(&path, &bytes, true)?;
    Ok(out)
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

fn mtime_secs(path: &Path) -> Option<i64> {
    let m = fs::metadata(path).ok()?.modified().ok()?;
    m.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

/// 7 天清理：过期条目连文件删；没登记的文件过期也删；`.part` 半截文件 1 小时就删
fn sweep(dir: &Path, now: i64) -> Result<(), String> {
    let keep: Vec<String> = with_index(dir, |idx| {
        let (expired, kept): (Vec<StoredItem>, Vec<StoredItem>) = idx
            .items
            .drain(..)
            .partition(|it| it.received_secs < now - STAGE_TTL_SECS);
        for it in expired {
            if let Some(f) = it.file {
                let _ = fs::remove_file(dir.join(f));
            }
        }
        idx.items = kept;
        Ok(idx.items.iter().filter_map(|it| it.file.clone()).collect())
    })?;
    let Ok(rd) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if !path.is_file() || name == "items.json" || name == ".items.lock" {
            continue;
        }
        let Some(m) = mtime_secs(&path) else { continue };
        let stale = if name.ends_with(".part") {
            m < now - PART_TTL_SECS
        } else {
            !keep.contains(&name) && m < now - STAGE_TTL_SECS
        };
        if stale {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}

// ===== 文件名与种类 =====

/// 手机报上来的原名 → 显示名：只取最后一段、清洗非法字符、限长（保留扩展名），清洗不出来用「文件」
fn display_name(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let clean = crate::paths::sanitize_fs_name(last).unwrap_or_else(|_| "文件".into());
    if clean.chars().count() <= MAX_NAME_CHARS {
        return clean;
    }
    let (stem, ext) = match clean.rfind('.') {
        Some(i) if clean.len() - i <= 10 && i > 0 => (&clean[..i], &clean[i..]),
        _ => (clean.as_str(), ""),
    };
    let keep = MAX_NAME_CHARS.saturating_sub(ext.chars().count());
    format!("{}{}", stem.chars().take(keep).collect::<String>(), ext)
}

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_heic(head: &[u8]) -> bool {
    head.len() >= 12
        && &head[4..8] == b"ftyp"
        && matches!(&head[8..12], b"heic" | b"heix" | b"hevc" | b"heim" | b"heis" | b"mif1" | b"msf1")
}

/// 内容魔数认出的图片扩展名（没扩展名的文件补上，好让 agent 认得）
fn sniff_image_ext(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG") {
        Some("png")
    } else if head.len() >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF {
        Some("jpg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("gif")
    } else if head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WEBP" {
        Some("webp")
    } else if is_heic(head) {
        Some("heic")
    } else {
        None
    }
}

/// 种类判定：扩展名与内容都对上才算图片 / PDF，否则当普通文件
fn classify(name: &str, head: &[u8]) -> &'static str {
    let ext = ext_of(name);
    if ext == "pdf" && crate::lit_watch::looks_like_pdf(head) {
        return "pdf";
    }
    let image_ext = matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "heif"
    );
    if image_ext && sniff_image_ext(head).is_some() {
        return "image";
    }
    "file"
}

/// 没扩展名但内容认得出：补扩展名
fn with_sniffed_ext(name: String, head: &[u8]) -> String {
    if !ext_of(&name).is_empty() {
        return name;
    }
    if crate::lit_watch::looks_like_pdf(head) {
        return format!("{name}.pdf");
    }
    match sniff_image_ext(head) {
        Some(ext) => format!("{name}.{ext}"),
        None => name,
    }
}

fn unique_stage_name(dir: &Path, display: &str) -> String {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let base = format!("{stamp}-{display}");
    if !dir.join(&base).exists() {
        return base;
    }
    let (stem, ext) = match base.rfind('.') {
        Some(i) if i > stamp.len() + 1 => (&base[..i], &base[i..]),
        _ => (base.as_str(), ""),
    };
    let mut n = 2;
    loop {
        let name = format!("{stem}-{n}{ext}");
        if !dir.join(&name).exists() {
            return name;
        }
        n += 1;
    }
}

fn text_title(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let short: String = line.chars().take(40).collect();
    if short.chars().count() < line.chars().count() {
        format!("{short}…")
    } else {
        short
    }
}

fn percent_decode(raw: &str) -> String {
    fn hex(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ===== 局域网地址 =====

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhoneAddrDto {
    pub ip: String,
    pub label: String,
}

/// 虚拟网卡（代理 TUN、虚拟机、容器、组网工具）不拿来收手机：手机连不到它们
fn virtual_iface(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    const PREFIX: [&str; 14] = [
        "utun", "tun", "tap", "docker", "br-", "veth", "vmnet", "vboxnet", "virbr", "bridge",
        "awdl", "llw", "zt", "wg",
    ];
    const CONTAINS: [&str; 12] = [
        "vmware", "virtualbox", "vethernet", "hyper-v", "wsl", "tailscale", "zerotier", "clash",
        "mihomo", "wintun", "wireguard", "openvpn",
    ];
    PREFIX.iter().any(|p| n.starts_with(p)) || CONTAINS.iter().any(|c| n.contains(c))
}

/// 排序：无线优先、有线其次、其他最后
fn iface_rank(name: &str) -> u8 {
    let n = name.to_ascii_lowercase();
    if n == "en0" || n.starts_with("wl") || n.contains("wi-fi") || n.contains("wlan") || name.contains("无线") {
        0
    } else if n.starts_with("en") || n.starts_with("eth") || n.contains("ethernet") || name.contains("以太网") {
        1
    } else {
        2
    }
}

/// 手机能连的私网 IPv4。代理 TUN 的 198.18/15、组网工具的 100.64/10 都不是私网段，天然排除
fn lan_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_private() && !ip.is_loopback() && !ip.is_link_local()
}

fn lan_candidates() -> Vec<(Ipv4Addr, String)> {
    let Ok(list) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let mut out: Vec<(u8, Ipv4Addr, String)> = Vec::new();
    for iface in list {
        if iface.is_loopback() || !iface.is_oper_up() || iface.is_p2p() || virtual_iface(&iface.name) {
            continue;
        }
        let IpAddr::V4(ip) = iface.ip() else { continue };
        if !lan_ipv4(ip) || out.iter().any(|(_, x, _)| *x == ip) {
            continue;
        }
        out.push((iface_rank(&iface.name), ip, iface.name));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    out.into_iter().map(|(_, ip, name)| (ip, name)).collect()
}

// ===== 接收会话 =====

struct Session {
    token: String,
    /// Host 头必须恰好是它（防 DNS 重绑定）
    host: String,
    url: String,
    address: Ipv4Addr,
    stage: PathBuf,
    stop: AtomicBool,
    connected: AtomicBool,
    last_item: Mutex<Instant>,
    bytes_total: AtomicU64,
    received: AtomicU32,
    uploads: Mutex<HashMap<u64, Instant>>,
    next_upload: AtomicU64,
    app: Option<tauri::AppHandle>,
}

impl Session {
    fn emit<P: Serialize + Clone>(&self, event: &str, payload: P) {
        if let Some(app) = &self.app {
            let _ = app.emit(event, payload);
        }
    }

    fn emit_state(&self, receiving: bool, reason: Option<&str>) {
        self.emit(
            "phone-drop-state",
            serde_json::json!({
                "receiving": receiving,
                "connected": self.connected.load(Ordering::Acquire),
                "received": self.received.load(Ordering::Acquire),
                "reason": reason,
            }),
        );
    }

    fn idle_for(&self) -> Duration {
        self.last_item
            .lock()
            .map(|t| t.elapsed())
            .unwrap_or_default()
    }

    /// 占一个上传名额；只数最近还有进展的上传
    fn claim_upload(&self) -> Option<UploadSlot<'_>> {
        let mut map = self.uploads.lock().unwrap_or_else(|e| e.into_inner());
        let active = map.values().filter(|t| t.elapsed() < STALL_AFTER).count();
        if active >= MAX_ACTIVE_UPLOADS {
            return None;
        }
        let id = self.next_upload.fetch_add(1, Ordering::AcqRel);
        map.insert(id, Instant::now());
        Some(UploadSlot { session: self, id })
    }
}

struct UploadSlot<'a> {
    session: &'a Session,
    id: u64,
}

impl UploadSlot<'_> {
    fn touch(&self) {
        if let Ok(mut map) = self.session.uploads.lock() {
            map.insert(self.id, Instant::now());
        }
    }
}

impl Drop for UploadSlot<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.session.uploads.lock() {
            map.remove(&self.id);
        }
    }
}

struct Running {
    session: Arc<Session>,
    worker: Option<std::thread::JoinHandle<()>>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
/// start / stop 串行：替换会话时先停旧的再装新的
static LIFECYCLE: Mutex<()> = Mutex::new(());

fn launch(
    ip: Ipv4Addr,
    stage: PathBuf,
    app: Option<tauri::AppHandle>,
) -> Result<Running, String> {
    let server = tiny_http::Server::http(SocketAddr::new(IpAddr::V4(ip), 0))
        .map_err(|e| format!("开始接收失败（{ip}）：{e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("开始接收失败：拿不到端口")?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let host = format!("{ip}:{port}");
    let session = Arc::new(Session {
        url: format!("http://{host}/{token}/"),
        token,
        host,
        address: ip,
        stage,
        stop: AtomicBool::new(false),
        connected: AtomicBool::new(false),
        last_item: Mutex::new(Instant::now()),
        bytes_total: AtomicU64::new(0),
        received: AtomicU32::new(0),
        uploads: Mutex::new(HashMap::new()),
        next_upload: AtomicU64::new(0),
        app,
    });
    let s = session.clone();
    let worker = std::thread::Builder::new()
        .name("phone-drop".into())
        .spawn(move || serve(server, s))
        .map_err(|e| format!("开始接收失败：{e}"))?;
    Ok(Running {
        session,
        worker: Some(worker),
    })
}

fn serve(server: tiny_http::Server, s: Arc<Session>) {
    let mut reason = "stopped";
    loop {
        if s.stop.load(Ordering::Acquire) {
            break;
        }
        if s.idle_for() >= IDLE_STOP {
            reason = "idle";
            break;
        }
        match server.recv_timeout(Duration::from_millis(300)) {
            Ok(Some(rq)) => {
                let s = s.clone();
                let _ = std::thread::Builder::new()
                    .name("phone-drop-rq".into())
                    .spawn(move || {
                        let mut rq = rq;
                        let resp = route(&s, &mut rq);
                        let _ = rq.respond(resp);
                    });
            }
            Ok(None) => {}
            Err(_) => {
                reason = "error";
                break;
            }
        }
    }
    // 先关监听（drop 即释放端口），再报状态
    drop(server);
    s.stop.store(true, Ordering::Release);
    if let Ok(mut g) = RUNNING.lock() {
        if g.as_ref().is_some_and(|r| Arc::ptr_eq(&r.session, &s)) {
            *g = None;
        }
    }
    if reason != "stopped" {
        crate::logbuf::record("info", "phone-drop", &format!("接收已停止（{reason}）"));
    }
    s.emit_state(false, Some(reason));
}

fn stop_running(r: Running) {
    r.session.stop.store(true, Ordering::Release);
    if let Some(h) = r.worker {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !h.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        if h.is_finished() {
            let _ = h.join();
        }
    }
}

/// 应用退出时停掉（lib.rs ExitRequested）
pub fn shutdown() {
    let taken = RUNNING.lock().ok().and_then(|mut g| g.take());
    if let Some(r) = taken {
        stop_running(r);
    }
}

// ===== HTTP 路由 =====

fn header(k: &str, v: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("静态响应头合法")
}

fn response(status: u16, content_type: &str, body: Vec<u8>) -> tiny_http::Response<Cursor<Vec<u8>>> {
    tiny_http::Response::from_data(body)
        .with_status_code(status)
        .with_header(header("Content-Type", content_type))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("Referrer-Policy", "no-referrer"))
        .with_header(header("X-Content-Type-Options", "nosniff"))
        .with_header(header("Content-Security-Policy", PAGE_CSP))
}

/// 错令牌、未知路径、方法不对、Host 不符：一律同一个 404
fn not_found() -> tiny_http::Response<Cursor<Vec<u8>>> {
    response(404, "text/plain; charset=utf-8", b"Not Found".to_vec())
}

fn json_reply(status: u16, value: serde_json::Value) -> tiny_http::Response<Cursor<Vec<u8>>> {
    response(status, "application/json; charset=utf-8", value.to_string().into_bytes())
}

fn err_json(status: u16, code: &str) -> tiny_http::Response<Cursor<Vec<u8>>> {
    json_reply(status, serde_json::json!({ "ok": false, "error": code }))
}

/// 定长比较：不按第一个不同字节提前返回
fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn header_value(rq: &tiny_http::Request, name: &'static str) -> Option<String> {
    rq.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_string())
}

fn route(s: &Session, rq: &mut tiny_http::Request) -> tiny_http::Response<Cursor<Vec<u8>>> {
    let url = rq.url().to_string();
    let path = url.split(['?', '#']).next().unwrap_or("");
    let rest = path.strip_prefix('/').unwrap_or("");
    let (tok, sub) = match rest.split_once('/') {
        Some((t, sub)) => (t, Some(sub)),
        None => (rest, None),
    };
    let host_ok = header_value(rq, "Host").is_some_and(|h| h.eq_ignore_ascii_case(&s.host));
    if !host_ok || !token_eq(tok, &s.token) {
        return not_found();
    }
    let method = rq.method().clone();
    match (&method, sub) {
        (tiny_http::Method::Get, None) => tiny_http::Response::from_data(Vec::new())
            .with_status_code(302)
            .with_header(header("Location", &format!("/{}/", s.token)))
            .with_header(header("Cache-Control", "no-store"))
            .with_header(header("Referrer-Policy", "no-referrer")),
        (tiny_http::Method::Get, Some("")) => {
            if !s.connected.swap(true, Ordering::AcqRel) {
                s.emit_state(true, None);
            }
            response(200, "text/html; charset=utf-8", PAGE_HTML.as_bytes().to_vec())
        }
        (tiny_http::Method::Get, Some("app.js")) => response(
            200,
            "text/javascript; charset=utf-8",
            PAGE_JS.as_bytes().to_vec(),
        ),
        (tiny_http::Method::Get, Some("app.css")) => {
            response(200, "text/css; charset=utf-8", PAGE_CSS.as_bytes().to_vec())
        }
        (tiny_http::Method::Get, Some("state")) => json_reply(
            200,
            serde_json::json!({
                "receiving": !s.stop.load(Ordering::Acquire),
                "maxFileBytes": MAX_FILE_BYTES,
                "maxTextChars": MAX_TEXT_CHARS,
            }),
        ),
        (tiny_http::Method::Post, Some("file")) => receive_file(s, rq),
        (tiny_http::Method::Post, Some("text")) => receive_text(s, rq),
        _ => not_found(),
    }
}

fn record_item(s: &Session, item: StoredItem) -> Result<(), String> {
    let dto = to_dto(&s.stage, &item);
    with_index(&s.stage, |idx| {
        idx.items.push(item);
        Ok(())
    })?;
    if let Ok(mut t) = s.last_item.lock() {
        *t = Instant::now();
    }
    s.received.fetch_add(1, Ordering::AcqRel);
    s.emit("phone-drop-item", dto);
    s.emit_state(true, None);
    Ok(())
}

fn new_item(kind: &str, name: String, size: u64) -> StoredItem {
    StoredItem {
        id: uuid::Uuid::new_v4().simple().to_string(),
        kind: kind.into(),
        name,
        file: None,
        text: None,
        size,
        received_at: chrono::Local::now().to_rfc3339(),
        received_secs: now_secs(),
        status: "new".into(),
        placed_to: None,
    }
}

fn open_private(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn receive_file(s: &Session, rq: &mut tiny_http::Request) -> tiny_http::Response<Cursor<Vec<u8>>> {
    let Some(len) = rq.body_length().map(|n| n as u64) else {
        return err_json(411, "length_required");
    };
    if len == 0 {
        return err_json(400, "empty");
    }
    if len > MAX_FILE_BYTES {
        return err_json(413, "too_large");
    }
    if s.bytes_total.load(Ordering::Acquire) + len > MAX_SESSION_BYTES {
        return err_json(413, "session_full");
    }
    let Some(slot) = s.claim_upload() else {
        return err_json(503, "busy");
    };
    let raw = header_value(rq, "X-Mesa-Name").map(|v| percent_decode(&v)).unwrap_or_default();
    let display = display_name(&raw);
    s.emit("phone-drop-incoming", serde_json::json!({ "name": display }));
    let part = s.stage.join(format!(".{}.part", uuid::Uuid::new_v4().simple()));
    let result = (|| -> Result<(u64, Vec<u8>), String> {
        let mut file = open_private(&part).map_err(|e| format!("写入暂存区失败: {e}"))?;
        let reader = rq.as_reader();
        let mut buf = vec![0u8; 64 * 1024];
        let mut head: Vec<u8> = Vec::with_capacity(16);
        let mut total: u64 = 0;
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("接收中断: {e}"))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > len {
                return Err("长度不符".into());
            }
            if head.len() < 16 {
                let take = (16 - head.len()).min(n);
                head.extend_from_slice(&buf[..take]);
            }
            file.write_all(&buf[..n]).map_err(|e| format!("写入暂存区失败: {e}"))?;
            slot.touch();
        }
        Ok((total, head))
    })();
    let (total, head) = match result {
        Ok(v) => v,
        Err(_) => {
            let _ = fs::remove_file(&part);
            return err_json(400, "incomplete");
        }
    };
    if total != len {
        let _ = fs::remove_file(&part);
        return err_json(400, "incomplete");
    }
    let display = with_sniffed_ext(display, &head);
    let kind = classify(&display, &head);
    let file_name = unique_stage_name(&s.stage, &display);
    if fs::rename(&part, s.stage.join(&file_name)).is_err() {
        let _ = fs::remove_file(&part);
        return err_json(500, "store_failed");
    }
    s.bytes_total.fetch_add(len, Ordering::AcqRel);
    let mut item = new_item(kind, display, len);
    item.file = Some(file_name.clone());
    if record_item(s, item).is_err() {
        let _ = fs::remove_file(s.stage.join(&file_name));
        return err_json(500, "store_failed");
    }
    json_reply(200, serde_json::json!({ "ok": true }))
}

fn receive_text(s: &Session, rq: &mut tiny_http::Request) -> tiny_http::Response<Cursor<Vec<u8>>> {
    if rq.body_length().is_some_and(|n| n as u64 > MAX_TEXT_BYTES) {
        return err_json(413, "too_long");
    }
    let mut bytes = Vec::new();
    if rq
        .as_reader()
        .take(MAX_TEXT_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return err_json(400, "incomplete");
    }
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return err_json(413, "too_long");
    }
    let Ok(text) = String::from_utf8(bytes) else {
        return err_json(400, "bad_text");
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        return err_json(400, "empty");
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return err_json(413, "too_long");
    }
    let mut item = new_item("text", text_title(&text), text.len() as u64);
    item.text = Some(text);
    if record_item(s, item).is_err() {
        return err_json(500, "store_failed");
    }
    json_reply(200, serde_json::json!({ "ok": true }))
}

// ===== 命令层 =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneDropStatusDto {
    pub receiving: bool,
    pub connected: bool,
    pub url: Option<String>,
    /// 二维码 SVG（黑码白底，深色主题下也好扫）
    pub qr_svg: Option<String>,
    pub address: Option<String>,
    /// 开始接收时可选的局域网地址（多张网卡时给「换一个地址」）
    pub addresses: Vec<PhoneAddrDto>,
    pub received: u32,
}

fn idle_status() -> PhoneDropStatusDto {
    PhoneDropStatusDto {
        receiving: false,
        connected: false,
        url: None,
        qr_svg: None,
        address: None,
        addresses: Vec::new(),
        received: 0,
    }
}

fn qr_svg(url: &str) -> Option<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::with_error_correction_level(url.as_bytes(), qrcode::EcLevel::M).ok()?;
    Some(
        code.render::<svg::Color>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
    )
}

fn addr_options(candidates: &[(Ipv4Addr, String)]) -> Vec<PhoneAddrDto> {
    candidates
        .iter()
        .map(|(ip, name)| PhoneAddrDto {
            ip: ip.to_string(),
            label: format!("{ip}（{name}）"),
        })
        .collect()
}

fn status_of(s: &Session, candidates: &[(Ipv4Addr, String)]) -> PhoneDropStatusDto {
    PhoneDropStatusDto {
        receiving: !s.stop.load(Ordering::Acquire),
        connected: s.connected.load(Ordering::Acquire),
        url: Some(s.url.clone()),
        qr_svg: qr_svg(&s.url),
        address: Some(s.address.to_string()),
        addresses: addr_options(candidates),
        received: s.received.load(Ordering::Acquire),
    }
}

fn start_impl(app: Option<tauri::AppHandle>, bind: Option<String>) -> Result<PhoneDropStatusDto, String> {
    let _life = LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
    let candidates = lan_candidates();
    let wanted: Option<Ipv4Addr> = match bind.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => Some(b.parse().map_err(|_| "地址无效".to_string())?),
        None => None,
    };
    {
        let g = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = g.as_ref() {
            let same = wanted.is_none_or(|w| w == r.session.address);
            if same && !r.session.stop.load(Ordering::Acquire) {
                return Ok(status_of(&r.session, &candidates));
            }
        }
    }
    let ip = match wanted {
        Some(w) if candidates.iter().any(|(ip, _)| *ip == w) => w,
        Some(_) => return Err("这个地址现在不可用，换一个再试".into()),
        None => candidates.first().map(|(ip, _)| *ip).ok_or(
            "没找到可用的局域网地址：电脑要先连上 Wi-Fi 或网线（连手机热点也行）",
        )?,
    };
    let old = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(old) = old {
        stop_running(old);
    }
    let stage = ensure_stage_dir()?;
    let _ = sweep(&stage, now_secs());
    let running = launch(ip, stage, app)?;
    let status = status_of(&running.session, &candidates);
    *RUNNING.lock().unwrap_or_else(|e| e.into_inner()) = Some(running);
    crate::logbuf::record("info", "phone-drop", "开始接收");
    Ok(status)
}

#[tauri::command]
pub async fn phone_drop_start(
    app: tauri::AppHandle,
    bind: Option<String>,
) -> Result<PhoneDropStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || start_impl(Some(app), bind))
        .await
        .map_err(|e| format!("开始接收失败: {e}"))?
}

#[tauri::command]
pub async fn phone_drop_stop() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _life = LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
        shutdown();
    })
    .await
    .map_err(|e| format!("停止接收失败: {e}"))
}

#[tauri::command]
pub fn phone_drop_status() -> PhoneDropStatusDto {
    let g = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    match g.as_ref() {
        Some(r) if !r.session.stop.load(Ordering::Acquire) => status_of(&r.session, &[]),
        _ => idle_status(),
    }
}

fn list_at(dir: &Path) -> Result<Vec<PhoneItemDto>, String> {
    let mut items = with_index(dir, |idx| Ok(idx.items.clone()))?;
    items.sort_by(|a, b| b.received_secs.cmp(&a.received_secs));
    Ok(items.iter().map(|it| to_dto(dir, it)).collect())
}

/// 手机收到的（新的在前）；顺手做 7 天清理
#[tauri::command]
pub async fn phone_drop_list() -> Result<Vec<PhoneItemDto>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = ensure_stage_dir()?;
        let _ = sweep(&dir, now_secs());
        list_at(&dir)
    })
    .await
    .map_err(|e| format!("读取手机收到的失败: {e}"))?
}

fn update_item(
    dir: &Path,
    id: &str,
    f: impl FnOnce(&mut StoredItem),
) -> Result<PhoneItemDto, String> {
    with_index(dir, |idx| {
        let it = idx
            .items
            .iter_mut()
            .find(|it| it.id == id)
            .ok_or("这条已经不在了（可能超过 7 天被清理）")?;
        f(it);
        Ok(to_dto(dir, it))
    })
}

fn find_item(dir: &Path, id: &str) -> Result<StoredItem, String> {
    with_index(dir, |idx| {
        idx.items
            .iter()
            .find(|it| it.id == id)
            .cloned()
            .ok_or_else(|| "这条已经不在了（可能超过 7 天被清理）".to_string())
    })
}

/// 附到对话 / 从输入框移除：只认 new 与 attached 两态（放进项目、另存走各自命令）
#[tauri::command]
pub async fn phone_drop_set_status(id: String, status: String) -> Result<PhoneItemDto, String> {
    if status != "new" && status != "attached" {
        return Err("状态无效".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = ensure_stage_dir()?;
        update_item(&dir, &id, |it| it.status = status)
    })
    .await
    .map_err(|e| format!("更新失败: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhonePlaceResultDto {
    /// 项目根相对路径（papers/x.pdf、notes/assets/phone-….jpg、notes/clips.md）
    pub rel_path: String,
    /// PDF 命中项目里已有同一份（字节级相同），没有重复写入
    pub dedup: bool,
    pub item: PhoneItemDto,
}

fn rel_to(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

/// notes/clips.md 一条：与终端「存进笔记」同一格式，来源标「手机」
fn clip_entry(text: &str, when: chrono::DateTime<chrono::Local>) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in text.chars() {
        run = if c == '`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    let fence = "`".repeat(longest.max(2) + 1);
    let stamp = when.format("%Y-%m-%d %H:%M");
    format!("\n## {stamp} · 手机\n\n{fence}text\n{text}\n{fence}\n")
}

/// 放进项目的内核（root 须已过项目根门槛且已 canonical）。编程项目不放（同「存进笔记」口径）
fn place_into(root: &Path, dir: &Path, id: &str) -> Result<PhonePlaceResultDto, String> {
    let mode = crate::projects::normalize_work_mode(&crate::projects::read_config_at(root).config.work_mode);
    if mode == "coding" {
        return Err("编程项目不往项目里放手机发来的东西；可以用「另存为」放到你要的位置".into());
    }
    let item = find_item(dir, id)?;
    let read_staged = || -> Result<Vec<u8>, String> {
        let f = item.file.as_ref().ok_or("这条没有文件")?;
        fs::read(dir.join(f)).map_err(|e| format!("读取暂存文件失败: {e}"))
    };
    let (rel, dedup) = match item.kind.as_str() {
        "pdf" => {
            let bytes = read_staged()?;
            if bytes.len() > crate::lit_watch::DOWNLOAD_CAP {
                return Err("PDF 超过 60 MB，放不进 papers/；可以用「另存为」".into());
            }
            if !crate::lit_watch::looks_like_pdf(&bytes) {
                return Err("这个文件不是有效的 PDF".into());
            }
            let hint = item
                .name
                .strip_suffix(".pdf")
                .or_else(|| item.name.strip_suffix(".PDF"))
                .unwrap_or(&item.name);
            let saved = crate::lit_watch::save_paper_bytes(root, hint, &bytes)?;
            (rel_to(root, Path::new(&saved.path)), saved.dedup)
        }
        "image" => {
            let bytes = read_staged()?;
            let ext = ext_of(item.file.as_deref().unwrap_or(&item.name));
            let ext = if ext.is_empty() { "jpg".to_string() } else { ext };
            let saved = crate::reader::write_notes_asset(root, "phone", &ext, &bytes)?;
            (saved.rel_path, false)
        }
        "text" => {
            let text = item.text.as_deref().unwrap_or("").trim();
            if text.is_empty() {
                return Err("这条文字是空的".into());
            }
            crate::projects::append_clip_at(root, &clip_entry(text, chrono::Local::now()))?;
            ("notes/clips.md".to_string(), false)
        }
        _ => return Err("这类文件不放进项目；可以用「另存为」放到你要的位置".into()),
    };
    let placed = rel.clone();
    let dto = update_item(dir, id, |it| {
        it.status = "placed".into();
        it.placed_to = Some(placed);
    })?;
    Ok(PhonePlaceResultDto {
        rel_path: rel,
        dedup,
        item: dto,
    })
}

/// 放进项目：PDF → papers/（与浏览器扩展同一条入库链），图片 → notes/assets/，文字 → notes/clips.md
#[tauri::command]
pub async fn phone_drop_place(id: String, project_root: String) -> Result<PhonePlaceResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::projects::ensure_task_project_root(Path::new(
            &crate::sessions::expand_tilde(&project_root),
        ))?;
        let dir = ensure_stage_dir()?;
        place_into(&root, &dir, &id)
    })
    .await
    .map_err(|e| format!("放进项目失败: {e}"))?
}

fn save_as_at(dir: &Path, id: &str, dest: &Path) -> Result<PhoneItemDto, String> {
    let item = find_item(dir, id)?;
    match (&item.file, &item.text) {
        (Some(f), _) => {
            fs::copy(dir.join(f), dest).map_err(|e| format!("另存失败: {e}"))?;
        }
        (None, Some(text)) => {
            fs::write(dest, text).map_err(|e| format!("另存失败: {e}"))?;
        }
        _ => return Err("这条没有内容".into()),
    }
    update_item(dir, id, |it| {
        if it.status == "new" {
            it.status = "saved".into();
        }
    })
}

/// 另存为：目标路径来自系统存储对话框（人自己选的位置）
#[tauri::command]
pub async fn phone_drop_save_as(id: String, dest: String) -> Result<PhoneItemDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = ensure_stage_dir()?;
        save_as_at(&dir, &id, Path::new(&dest))
    })
    .await
    .map_err(|e| format!("另存失败: {e}"))?
}

fn delete_at(dir: &Path, id: &str) -> Result<(), String> {
    with_index(dir, |idx| {
        if let Some(pos) = idx.items.iter().position(|it| it.id == id) {
            let it = idx.items.remove(pos);
            if let Some(f) = it.file {
                let _ = fs::remove_file(dir.join(f));
            }
        }
        Ok(())
    })
}

/// 删除：暂存区是 Mesa 自己的临时目录，直接删不进回收站
#[tauri::command]
pub async fn phone_drop_delete(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = ensure_stage_dir()?;
        delete_at(&dir, &id)
    })
    .await
    .map_err(|e| format!("删除失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Shutdown, TcpStream};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ccode-phone-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        crate::paths::canonicalize_plain(&dir).unwrap()
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n0000IHDR fake png body";
    const PDF: &[u8] = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n";

    #[test]
    fn display_name_strips_paths_and_cleans() {
        assert_eq!(display_name("../../etc/passwd"), "passwd");
        assert_eq!(display_name("a/b\\c.jpg"), "c.jpg");
        assert_eq!(display_name("bad:name?.pdf"), "bad-name-.pdf");
        assert_eq!(display_name("CON.txt"), "CON.txt-");
        assert_eq!(display_name(""), "文件");
        assert_eq!(display_name(".."), "文件");
        let long = format!("{}.jpeg", "长".repeat(200));
        let cut = display_name(&long);
        assert_eq!(cut.chars().count(), MAX_NAME_CHARS);
        assert!(cut.ends_with(".jpeg"), "{cut}");
    }

    #[test]
    fn classify_needs_both_extension_and_content() {
        assert_eq!(classify("a.pdf", PDF), "pdf");
        assert_eq!(classify("a.pdf", b"not a pdf at all"), "file");
        assert_eq!(classify("a.png", PNG), "image");
        assert_eq!(classify("a.jpg", &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), "image");
        assert_eq!(classify("a.heic", b"\0\0\0\x18ftypheic\0\0\0\0"), "image");
        assert_eq!(classify("a.txt", PNG), "file");
        assert_eq!(classify("a.png", b"plain text"), "file");
        assert_eq!(with_sniffed_ext("scan".into(), PDF), "scan.pdf");
        assert_eq!(with_sniffed_ext("photo".into(), PNG), "photo.png");
        assert_eq!(with_sniffed_ext("notes".into(), b"hello"), "notes");
        assert_eq!(with_sniffed_ext("a.bin".into(), PNG), "a.bin");
    }

    #[test]
    fn percent_decode_handles_utf8_and_junk() {
        assert_eq!(percent_decode("%E5%9B%BE.jpg"), "图.jpg");
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
        assert_eq!(percent_decode("50%"), "50%");
        assert_eq!(percent_decode("%4"), "%4");
    }

    #[test]
    fn token_compare_is_exact() {
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abc", "abd"));
        assert!(!token_eq("abc", "abcd"));
        assert!(!token_eq("", "a"));
    }

    #[test]
    fn lan_address_filter() {
        assert!(lan_ipv4("192.168.1.23".parse().unwrap()));
        assert!(lan_ipv4("10.0.0.5".parse().unwrap()));
        assert!(lan_ipv4("172.20.10.2".parse().unwrap()), "iPhone 热点");
        assert!(!lan_ipv4("198.18.0.1".parse().unwrap()), "代理 TUN");
        assert!(!lan_ipv4("100.64.0.7".parse().unwrap()), "组网工具");
        assert!(!lan_ipv4("169.254.3.4".parse().unwrap()));
        assert!(!lan_ipv4("127.0.0.1".parse().unwrap()));
        assert!(virtual_iface("utun4"));
        assert!(virtual_iface("vEthernet (WSL)"));
        assert!(virtual_iface("Clash"));
        assert!(virtual_iface("bridge100"));
        assert!(!virtual_iface("en0"));
        assert!(!virtual_iface("WLAN"));
        assert!(!virtual_iface("以太网"));
        assert!(iface_rank("en0") < iface_rank("en5"));
        assert!(iface_rank("WLAN") < iface_rank("以太网"));
    }

    /// 测试用最小 HTTP 客户端：按 Content-Length 读完就停（服务端不读完的正文不等 EOF）
    fn http(addr: &str, head: &str, body: &[u8], close_write: bool) -> (u16, String) {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(head.as_bytes()).unwrap();
        s.write_all(body).unwrap();
        if close_write {
            let _ = s.shutdown(Shutdown::Write);
        }
        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        loop {
            let n = s.read(&mut tmp).unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&buf[..pos]).to_ascii_lowercase();
                let len = headers
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if buf.len() >= pos + 4 + len {
                    break;
                }
            }
        }
        let text = String::from_utf8_lossy(&buf).into_owned();
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|c| c.parse().ok())
            .unwrap_or(0);
        let body = text.split_once("\r\n\r\n").map(|x| x.1.to_string()).unwrap_or_default();
        (status, body)
    }

    fn get(r: &Running, path: &str, host: &str) -> (u16, String) {
        http(
            &r.session.host,
            &format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"),
            b"",
            false,
        )
    }

    fn post(r: &Running, sub: &str, name: Option<&str>, len: usize, body: &[u8], close: bool) -> (u16, String) {
        let name_header = name.map(|n| format!("X-Mesa-Name: {n}\r\n")).unwrap_or_default();
        http(
            &r.session.host,
            &format!(
                "POST /{}/{sub} HTTP/1.1\r\nHost: {}\r\n{name_header}Content-Length: {len}\r\nConnection: close\r\n\r\n",
                r.session.token, r.session.host
            ),
            body,
            close,
        )
    }

    #[test]
    fn server_serves_page_and_hides_everything_else() {
        let stage = temp_dir("serve");
        let r = launch(Ipv4Addr::LOCALHOST, stage.clone(), None).unwrap();
        let host = r.session.host.clone();
        let token = r.session.token.clone();
        let (code, body) = get(&r, &format!("/{token}/"), &host);
        assert_eq!(code, 200);
        assert!(body.contains("发到 Mesa"));
        assert!(r.session.connected.load(Ordering::Acquire));
        assert_eq!(get(&r, &format!("/{token}/app.js"), &host).0, 200);
        assert_eq!(get(&r, &format!("/{token}/state"), &host).0, 200);
        assert_eq!(get(&r, &format!("/{token}"), &host).0, 302);
        let not_found = get(&r, "/nope/", &host);
        assert_eq!(not_found, (404, "Not Found".to_string()));
        assert_eq!(get(&r, &format!("/{token}x/"), &host), not_found, "错令牌与未知路径一样");
        assert_eq!(get(&r, &format!("/{token}/items.json"), &host), not_found, "没有读暂存区的路由");
        assert_eq!(get(&r, &format!("/{token}/"), "evil.example:80"), not_found, "Host 不符");
        let addr = r.session.host.clone();
        stop_running(r);
        assert!(TcpStream::connect(&addr).is_err(), "停止后端口释放");
        fs::remove_dir_all(&stage).ok();
    }

    #[test]
    fn server_receives_file_and_text() {
        let stage = temp_dir("recv");
        let r = launch(Ipv4Addr::LOCALHOST, stage.clone(), None).unwrap();
        let (code, _) = post(&r, "file", Some("%E7%85%A7%E7%89%87.png"), PNG.len(), PNG, false);
        assert_eq!(code, 200);
        let (code, _) = post(&r, "text", None, "  记一下：样品 3 号偏黄  ".len(), "  记一下：样品 3 号偏黄  ".as_bytes(), false);
        assert_eq!(code, 200);
        let items = list_at(&stage).unwrap();
        assert_eq!(items.len(), 2);
        let img = items.iter().find(|i| i.kind == "image").unwrap();
        assert_eq!(img.name, "照片.png");
        assert_eq!(img.status, "new");
        let path = PathBuf::from(img.path.as_ref().unwrap());
        assert!(path.starts_with(&stage));
        assert_eq!(fs::read(&path).unwrap(), PNG);
        let text = items.iter().find(|i| i.kind == "text").unwrap();
        assert_eq!(text.text.as_deref(), Some("记一下：样品 3 号偏黄"));
        assert_eq!(r.session.received.load(Ordering::Acquire), 2);
        // 空文字、超长声明、断在半截
        assert_eq!(post(&r, "text", None, 3, b"   ", false).0, 400);
        let big = (MAX_FILE_BYTES + 1) as usize;
        assert_eq!(post(&r, "file", Some("big.bin"), big, b"", false).0, 413);
        // 断在半截：≤1KB 的正文 tiny_http 先整段读，读不满直接断连（手机侧报「没送到」）；
        // 更大的正文流进来，由我们判长度不符、删半截文件
        let small = post(&r, "file", Some("cut.pdf"), 100, b"%PDF-1.7", true).0;
        assert!(small == 0 || small == 400, "{small}");
        let mut chunk = b"%PDF-1.7\n".to_vec();
        chunk.resize(8 * 1024, b'x');
        assert_eq!(post(&r, "file", Some("cut.pdf"), 64 * 1024, &chunk, true).0, 400);
        let parts = fs::read_dir(&stage)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
            .count();
        assert_eq!(parts, 0, "半截文件删掉");
        assert_eq!(list_at(&stage).unwrap().len(), 2);
        stop_running(r);
        fs::remove_dir_all(&stage).ok();
    }

    #[test]
    fn upload_slots_ignore_stalled_connections() {
        let stage = temp_dir("slots");
        let r = launch(Ipv4Addr::LOCALHOST, stage.clone(), None).unwrap();
        let s = r.session.clone();
        {
            let a = s.claim_upload().unwrap();
            let _b = s.claim_upload().unwrap();
            let _c = s.claim_upload().unwrap();
            assert!(s.claim_upload().is_none(), "同时最多 3 个");
            drop(a);
            let _d = s.claim_upload().expect("放掉一个就能再占");
            // 卡住的上传：最后进展在 STALL_AFTER 之前，不占名额
            let long_ago = Instant::now()
                .checked_sub(STALL_AFTER + Duration::from_secs(1))
                .unwrap();
            for v in s.uploads.lock().unwrap().values_mut() {
                *v = long_ago;
            }
            assert!(s.claim_upload().is_some());
        }
        stop_running(r);
        fs::remove_dir_all(&stage).ok();
    }

    fn stage_with(dir: &Path, items: Vec<StoredItem>) {
        with_index(dir, |idx| {
            idx.items = items;
            Ok(())
        })
        .unwrap();
    }

    fn file_item(dir: &Path, kind: &str, name: &str, bytes: &[u8]) -> StoredItem {
        let mut it = new_item(kind, name.into(), bytes.len() as u64);
        let file = unique_stage_name(dir, name);
        fs::write(dir.join(&file), bytes).unwrap();
        it.file = Some(file);
        it
    }

    #[test]
    fn sweep_removes_expired_items_orphans_and_parts() {
        let dir = temp_dir("sweep");
        let fresh = file_item(&dir, "image", "a.png", PNG);
        let mut old = file_item(&dir, "pdf", "b.pdf", PDF);
        old.received_secs = now_secs() - STAGE_TTL_SECS - 10;
        let old_file = old.file.clone().unwrap();
        stage_with(&dir, vec![fresh.clone(), old]);
        fs::write(dir.join("orphan.bin"), b"x").unwrap();
        fs::write(dir.join(".x.part"), b"x").unwrap();
        sweep(&dir, now_secs()).unwrap();
        let items = list_at(&dir).unwrap();
        assert_eq!(items.len(), 1);
        assert!(!dir.join(old_file).exists());
        assert!(dir.join("orphan.bin").exists(), "未过期的不动");
        assert!(dir.join(".x.part").exists());
        // 一天后：半截文件过期；再过 8 天：没登记的文件过期，登记的按条目时间
        sweep(&dir, now_secs() + 2 * 3600).unwrap();
        assert!(!dir.join(".x.part").exists());
        sweep(&dir, now_secs() + STAGE_TTL_SECS + 3600).unwrap();
        assert!(!dir.join("orphan.bin").exists());
        assert!(list_at(&dir).unwrap().is_empty());
        assert!(!dir.join(fresh.file.unwrap()).exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_index_is_kept_aside_and_receiving_continues() {
        let dir = temp_dir("corrupt");
        fs::write(dir.join("items.json"), b"{not json").unwrap();
        assert!(list_at(&dir).unwrap().is_empty());
        let kept = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with("items.corrupt-"));
        assert!(kept, "原件留证");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn place_into_project_by_kind() {
        let stage = temp_dir("place-stage");
        let root = temp_dir("place-root");
        let pdf = file_item(&stage, "pdf", "Some Paper Title.pdf", PDF);
        let img = file_item(&stage, "image", "IMG_0012.jpg", &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]);
        let mut text = new_item("text", "想法".into(), 6);
        text.text = Some("样品 `3` 号偏黄".into());
        let other = file_item(&stage, "file", "data.xlsx", b"PK\x03\x04");
        stage_with(&stage, vec![pdf.clone(), img.clone(), text.clone(), other.clone()]);

        let r = place_into(&root, &stage, &pdf.id).unwrap();
        assert!(r.rel_path.starts_with("papers/"), "{}", r.rel_path);
        assert!(root.join(&r.rel_path).is_file());
        assert_eq!(r.item.status, "placed");
        assert_eq!(r.item.placed_to.as_deref(), Some(r.rel_path.as_str()));
        let again = place_into(&root, &stage, &pdf.id).unwrap();
        assert!(again.dedup, "同一份不重复写");

        let r = place_into(&root, &stage, &img.id).unwrap();
        assert!(r.rel_path.starts_with("notes/assets/phone-"), "{}", r.rel_path);
        assert!(r.rel_path.ends_with(".jpg"));

        let r = place_into(&root, &stage, &text.id).unwrap();
        assert_eq!(r.rel_path, "notes/clips.md");
        let clips = fs::read_to_string(root.join("notes/clips.md")).unwrap();
        assert!(clips.starts_with("# 摘记"));
        assert!(clips.contains("· 手机"));
        assert!(clips.contains("样品 `3` 号偏黄"));

        assert!(place_into(&root, &stage, &other.id).is_err(), "其他文件不放进项目");
        assert!(place_into(&root, &stage, "missing").is_err());

        let coding = temp_dir("place-coding");
        fs::create_dir_all(coding.join(".ccode")).unwrap();
        fs::write(coding.join(".ccode/project.toml"), "work_mode = \"coding\"\n").unwrap();
        let err = place_into(&coding, &stage, &img.id).unwrap_err();
        assert!(err.contains("编程项目"), "{err}");
        for d in [stage, root, coding] {
            fs::remove_dir_all(d).ok();
        }
    }

    #[test]
    fn save_as_and_delete() {
        let stage = temp_dir("saveas");
        let out = temp_dir("saveas-out");
        let img = file_item(&stage, "image", "a.png", PNG);
        let mut text = new_item("text", "t".into(), 2);
        text.text = Some("hi".into());
        stage_with(&stage, vec![img.clone(), text.clone()]);
        let dto = save_as_at(&stage, &img.id, &out.join("x.png")).unwrap();
        assert_eq!(dto.status, "saved");
        assert_eq!(fs::read(out.join("x.png")).unwrap(), PNG);
        save_as_at(&stage, &text.id, &out.join("t.txt")).unwrap();
        assert_eq!(fs::read_to_string(out.join("t.txt")).unwrap(), "hi");
        let staged = stage.join(img.file.clone().unwrap());
        delete_at(&stage, &img.id).unwrap();
        assert!(!staged.exists());
        assert_eq!(list_at(&stage).unwrap().len(), 1);
        for d in [stage, out] {
            fs::remove_dir_all(d).ok();
        }
    }

    #[test]
    fn clip_entry_fences_around_backticks() {
        let when = chrono::Local::now();
        let e = clip_entry("a ``` b", when);
        assert!(e.contains("````text\na ``` b\n````"), "{e}");
        assert!(e.contains("· 手机"));
    }

    #[test]
    fn qr_renders_svg() {
        let svg = qr_svg("http://192.168.1.23:52817/0123456789abcdef0123456789abcdef/").unwrap();
        assert!(svg.contains("<svg"));
    }

    /// 真机核对用：在本机局域网地址上开一个接收会话，打印地址后挂着（默认 300 秒，
    /// PHONE_DROP_LIVE_SECS 可改）；暂存区重定向到临时目录，不碰真实数据目录。
    /// `cargo test --lib phone_drop::tests::live_lan_session -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_lan_session() {
        let tmp = temp_dir("live");
        let _root = crate::storage::redirect_config_root(&tmp);
        let status = start_impl(None, None).expect("开始接收");
        println!("PHONE_DROP_URL={}", status.url.unwrap_or_default());
        println!("PHONE_DROP_STAGE={}", tmp.join("phone-inbox").display());
        println!("PHONE_DROP_ADDRS={:?}", status.addresses);
        let secs: u64 = std::env::var("PHONE_DROP_LIVE_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(300);
        std::thread::sleep(Duration::from_secs(secs));
        shutdown();
    }
}
