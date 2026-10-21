//! 从手机添加（2026-10-20；设计 docs/design-phone-drop.md，安全口径 safety.md 同名条）。
//!
//! 人在 Mesa 里点了「从手机添加」才在局域网上开一个只收不出的小服务：手机扫码打开网页，
//! 传照片 / 文件 / 一句话；收到的先进 Mesa 自己的暂存区（`<配置根>/phone-inbox/`），
//! 人点了才进项目（项目根多出未跟踪文件会挡工作区合并，见 review_contract）。
//! 点停止 / 30 分钟没收到新东西 / Mesa 退出即关；错令牌与未知路径同一个 404。
//! 记住这台手机（2026-10-21）：扫码地址 `/p/<本次配对令牌>/` 打开即配对，发长期设备令牌（只存哈希，可移除），
//! 手机跳到 `/d/<设备令牌>/` 加到主屏；固定端口 + 电脑名（mDNS `.local`）让主屏网页下次直接连上。

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
/// 合计上限按 24 小时窗口算（常驻等候一开就是几天，不能一直累加）
const BYTES_WINDOW: Duration = Duration::from_secs(24 * 3600);
/// 多久看一次网卡变了没有（换了 Wi-Fi 要换绑新地址，配对的手机才连得上）
const NET_CHECK: Duration = Duration::from_secs(20);
const STAGE_TTL_SECS: i64 = 7 * 24 * 3600;
const PART_TTL_SECS: i64 = 3600;
const MAX_NAME_CHARS: usize = 80;

const PAGE_HTML: &str = include_str!("../resources/phone-drop/index.html");
const PAGE_JS: &str = include_str!("../resources/phone-drop/app.js");
const PAGE_CSS: &str = include_str!("../resources/phone-drop/app.css");
/// 手机页三个静态文件同源加载，不写内联脚本 / 样式（与 Mesa 生产 CSP 同一纪律）
const PAGE_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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
    /// 二维码里用的主机：电脑名（xxx.local）或 IP
    pub host: String,
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

/// 电脑的局域网名字（mDNS，`<名字>.local`）：主屏网页记的是它，换了 Wi-Fi、IP 变了也不用重扫。
/// macOS 由 Bonjour 常驻广播 LocalHostName；Windows / Linux 手机能否解析待实测，只作可选项
fn mdns_hostname() -> Option<String> {
    clean_hostname(&local_host_name()?)
}

fn clean_hostname(raw: &str) -> Option<String> {
    let name = raw.trim().trim_end_matches(".local").to_ascii_lowercase();
    let ok = !name.is_empty()
        && name.len() <= 63
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then(|| format!("{name}.local"))
}

#[cfg(target_os = "macos")]
fn local_host_name() -> Option<String> {
    let mut cmd = crate::process::background_command("scutil");
    cmd.args(["--get", "LocalHostName"]);
    let out = crate::process::capture_command(&mut cmd, Duration::from_secs(3), 4096).ok()?;
    if !out.status.is_some_and(|s| s.success()) {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(windows)]
fn local_host_name() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn local_host_name() -> Option<String> {
    fs::read_to_string("/etc/hostname").ok()
}

/// 二维码默认用哪个主机：人改选过就照人的（name / ip）；没选过时 macOS 用电脑名，其余用第一个 IP
fn default_host(
    hostname: Option<&str>,
    candidates: &[(Ipv4Addr, String)],
    pref: Option<&str>,
    is_mac: bool,
) -> Option<String> {
    let name_first = match pref {
        Some("ip") => false,
        Some("name") => true,
        _ => is_mac,
    };
    if name_first {
        if let Some(h) = hostname {
            return Some(h.to_string());
        }
    }
    candidates.first().map(|(ip, _)| ip.to_string())
}

fn addr_options(hostname: Option<&str>, candidates: &[(Ipv4Addr, String)]) -> Vec<PhoneAddrDto> {
    let mut out = Vec::new();
    if let Some(h) = hostname {
        out.push(PhoneAddrDto {
            host: h.to_string(),
            label: "电脑名（换了 Wi-Fi 也能连）".to_string(),
        });
    }
    out.extend(candidates.iter().map(|(ip, name)| PhoneAddrDto {
        host: ip.to_string(),
        label: format!("{ip}（{name}）"),
    }));
    out
}

// ===== 已配对的手机 =====

/// 最多记住几台：防止二维码被别人拍走后无限配对
const MAX_DEVICES: usize = 8;
/// 「上次使用」写盘节流
const SEEN_THROTTLE_SECS: i64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairedDevice {
    id: String,
    name: String,
    /// 设备令牌的 SHA-256；原文只在手机网页的地址里，Mesa 不存、界面不显示
    token_sha256: String,
    paired_at: String,
    #[serde(default)]
    last_seen_at: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceBook {
    /// 固定端口：第一次开始接收时由系统挑定，之后每次都用它（主屏网页记着「主机:端口」）
    #[serde(default)]
    port: Option<u16>,
    /// 二维码用电脑名还是 IP：人在「换一个地址」里改选过才记（name / ip）
    #[serde(default)]
    host_pref: Option<String>,
    /// Mesa 开着就随时接收已配对的手机（2026-10-21 用户拍板，缺省开）；关了回到「人点了才收」
    #[serde(default)]
    standby: Option<bool>,
    #[serde(default)]
    devices: Vec<PairedDevice>,
}

impl DeviceBook {
    fn standby_enabled(&self) -> bool {
        self.standby.unwrap_or(true)
    }

    /// 要不要常驻等候：开着且至少配对了一台
    fn standby_wanted(&self) -> bool {
        self.standby_enabled() && !self.devices.is_empty()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneDeviceDto {
    pub id: String,
    pub name: String,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
}

fn device_dto(d: &PairedDevice) -> PhoneDeviceDto {
    PhoneDeviceDto {
        id: d.id.clone(),
        name: d.name.clone(),
        paired_at: d.paired_at.clone(),
        last_seen_at: d.last_seen_at.clone(),
    }
}

fn devices_path() -> Option<PathBuf> {
    crate::storage::config_root().map(|r| r.join("phone-devices.json"))
}

static BOOK_LOCK: Mutex<()> = Mutex::new(());

/// 配对簿读改写：进程锁 + OS 文件锁 + 原子写（0600）；f 返回 (结果, 是否改了)，没改不写盘。
/// 损坏时原件改名留证、按空簿继续——空簿只会让手机都要重扫（失败即收紧），不会放进任何人
fn with_book<T>(path: &Path, f: impl FnOnce(&mut DeviceBook) -> (T, bool)) -> Result<T, String> {
    let _guard = BOOK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {e}"))?;
    }
    let _flock = crate::storage::lock_at(&path.with_extension("lock"))?;
    let mut book = match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<DeviceBook>(&bytes) {
            Ok(b) => b,
            Err(_) => {
                let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
                let _ = fs::rename(path, path.with_extension(format!("corrupt-{stamp}.json")));
                crate::logbuf::record("warn", "phone-drop", "已配对手机名单损坏，原件已改名保留，手机需重新扫码");
                DeviceBook::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => DeviceBook::default(),
        Err(e) => return Err(format!("读取已配对手机失败: {e}")),
    };
    let (out, changed) = f(&mut book);
    if changed {
        let bytes = serde_json::to_vec_pretty(&book).map_err(|e| e.to_string())?;
        crate::storage::atomic_write(path, &bytes, true)?;
    }
    Ok(out)
}

fn sha256_hex(text: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 设备令牌：两段 uuid v4（约 244 位随机），长期有效所以比扫码令牌长
fn new_device_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn device_by_token(path: &Path, token: &str) -> Option<PairedDevice> {
    if token.is_empty() {
        return None;
    }
    let hash = sha256_hex(token);
    with_book(path, |book| {
        let hit = book
            .devices
            .iter()
            .find(|d| token_eq(&d.token_sha256, &hash))
            .cloned();
        (hit, false)
    })
    .ok()
    .flatten()
}

fn touch_device(path: &Path, id: &str) {
    let now = chrono::Local::now();
    let _ = with_book(path, |book| {
        let Some(d) = book.devices.iter_mut().find(|d| d.id == id) else {
            return ((), false);
        };
        let fresh = d
            .last_seen_at
            .as_deref()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .is_some_and(|t| now.timestamp() - t.timestamp() < SEEN_THROTTLE_SECS);
        if fresh {
            return ((), false);
        }
        d.last_seen_at = Some(now.to_rfc3339());
        ((), true)
    });
}

/// 按浏览器标识起个认得出的名字；重名加序号
fn device_name(user_agent: &str, taken: &[String]) -> String {
    let base = if user_agent.contains("iPhone") {
        "iPhone"
    } else if user_agent.contains("iPad") {
        "iPad"
    } else if user_agent.contains("Android") {
        "安卓手机"
    } else {
        "手机"
    };
    if !taken.iter().any(|t| t == base) {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base} {n}"))
        .find(|name| !taken.contains(name))
        .unwrap_or_else(|| base.to_string())
}

// ===== 接收会话 =====

struct Session {
    /// 扫码配对令牌：每次开始接收新开，只在本次接收期间有效；常驻等候没有（扫码配对要人点开始）
    pair_token: Option<String>,
    /// 常驻等候：只认已配对手机的设备地址，不出二维码、不因空闲停止
    standby: bool,
    /// 本次绑定的网卡地址（看网卡变没变）；测试里不跟网络
    bound: Vec<Ipv4Addr>,
    follow_network: bool,
    /// 允许的 Host 头：每个绑定 IP:端口 + 电脑名:端口（防 DNS 重绑定）
    hosts: Vec<String>,
    /// 二维码用的主机（电脑名或 IP）
    host: String,
    url: Option<String>,
    port: u16,
    /// 固定端口被占时的提醒（这次临时换了端口）
    port_note: Option<String>,
    addresses: Vec<PhoneAddrDto>,
    stage: PathBuf,
    book: PathBuf,
    stop: AtomicBool,
    connected: AtomicBool,
    last_device: Mutex<Option<String>>,
    last_item: Mutex<Instant>,
    /// 24 小时窗口内收到的字节（窗口起点, 累计）
    bytes_window: Mutex<(Instant, u64)>,
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

    fn last_device(&self) -> Option<String> {
        self.last_device.lock().ok().and_then(|g| g.clone())
    }

    /// running = 服务开着（主动接收或常驻等候）；standby_next = 这次停下后会转常驻等候
    fn emit_state(&self, running: bool, reason: Option<&str>, standby_next: bool) {
        self.emit(
            "phone-drop-state",
            serde_json::json!({
                "receiving": running && !self.standby,
                "standby": running && self.standby,
                "standbyNext": standby_next,
                "connected": self.connected.load(Ordering::Acquire),
                "received": self.received.load(Ordering::Acquire),
                "lastDevice": self.last_device(),
                "reason": reason,
            }),
        );
    }

    /// 24 小时窗口内再收 len 字节会不会超上限；不超就记上
    fn reserve_bytes(&self, len: u64) -> bool {
        let mut w = self.bytes_window.lock().unwrap_or_else(|e| e.into_inner());
        if w.0.elapsed() >= BYTES_WINDOW {
            *w = (Instant::now(), 0);
        }
        if w.1 + len > MAX_SESSION_BYTES {
            return false;
        }
        w.1 += len;
        true
    }

    fn release_bytes(&self, len: u64) {
        let mut w = self.bytes_window.lock().unwrap_or_else(|e| e.into_inner());
        w.1 = w.1.saturating_sub(len);
    }

    /// 手机打开了页面：记下是哪台，第一次连上或换了手机才报状态
    fn mark_connected(&self, device: Option<&str>) {
        let changed_device = match device {
            Some(name) => {
                let mut g = self.last_device.lock().unwrap_or_else(|e| e.into_inner());
                let changed = g.as_deref() != Some(name);
                *g = Some(name.to_string());
                changed
            }
            None => false,
        };
        let first = !self.connected.swap(true, Ordering::AcqRel);
        if first || changed_device {
            self.emit_state(true, None, false);
        }
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

/// 在每张局域网网卡上用同一个端口监听：第一张决定端口（0 = 系统挑），其余同端口，绑不上的跳过。
/// 电脑名解析到哪张网卡的地址都接得住
fn bind_all(ips: &[Ipv4Addr], port: u16) -> Result<(Vec<tiny_http::Server>, Vec<Ipv4Addr>, u16), String> {
    let first = *ips.first().ok_or("没有可用的局域网地址")?;
    let server = tiny_http::Server::http(SocketAddr::new(IpAddr::V4(first), port))
        .map_err(|e| e.to_string())?;
    let real = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("拿不到端口")?;
    let mut servers = vec![server];
    let mut bound = vec![first];
    for ip in &ips[1..] {
        if let Ok(s) = tiny_http::Server::http(SocketAddr::new(IpAddr::V4(*ip), real)) {
            servers.push(s);
            bound.push(*ip);
        }
    }
    Ok((servers, bound, real))
}

struct LaunchSpec {
    /// 要监听的网卡地址，第一个是二维码用的那张（主机是 IP 时）
    ips: Vec<Ipv4Addr>,
    host: String,
    hostname: Option<String>,
    port: Option<u16>,
    addresses: Vec<PhoneAddrDto>,
    stage: PathBuf,
    book: PathBuf,
    standby: bool,
    follow_network: bool,
}

fn launch(spec: LaunchSpec, app: Option<tauri::AppHandle>) -> Result<Running, String> {
    let (servers, bound, port, port_note) = match spec.port {
        Some(p) => match bind_all(&spec.ips, p) {
            Ok((s, b, real)) => (s, b, real, None),
            Err(_) => {
                let (s, b, real) =
                    bind_all(&spec.ips, 0).map_err(|e| format!("开始接收失败：{e}"))?;
                let note = format!(
                    "平常用的端口 {p} 被别的程序占着，这次临时换了端口：已配对的手机这次连不上，要用就重新扫码"
                );
                (s, b, real, Some(note))
            }
        },
        None => {
            let (s, b, real) = bind_all(&spec.ips, 0).map_err(|e| format!("开始接收失败：{e}"))?;
            (s, b, real, None)
        }
    };
    let mut hosts: Vec<String> = bound.iter().map(|ip| format!("{ip}:{port}")).collect();
    let bound: Vec<Ipv4Addr> = bound;
    if let Some(h) = &spec.hostname {
        hosts.push(format!("{h}:{port}"));
    }
    let pair_token = (!spec.standby).then(|| uuid::Uuid::new_v4().simple().to_string());
    let session = Arc::new(Session {
        url: pair_token
            .as_ref()
            .map(|t| format!("http://{}:{port}/p/{t}/", spec.host)),
        pair_token,
        standby: spec.standby,
        bound,
        follow_network: spec.follow_network,
        hosts,
        host: spec.host,
        port,
        port_note,
        addresses: spec.addresses,
        stage: spec.stage,
        book: spec.book,
        stop: AtomicBool::new(false),
        connected: AtomicBool::new(false),
        last_device: Mutex::new(None),
        last_item: Mutex::new(Instant::now()),
        bytes_window: Mutex::new((Instant::now(), 0)),
        received: AtomicU32::new(0),
        uploads: Mutex::new(HashMap::new()),
        next_upload: AtomicU64::new(0),
        app,
    });
    let s = session.clone();
    let worker = std::thread::Builder::new()
        .name("phone-drop".into())
        .spawn(move || serve(servers, s))
        .map_err(|e| format!("开始接收失败：{e}"))?;
    Ok(Running {
        session,
        worker: Some(worker),
    })
}

fn network_changed(s: &Session) -> bool {
    let mut now: Vec<Ipv4Addr> = lan_candidates().into_iter().map(|(ip, _)| ip).collect();
    let mut was = s.bound.clone();
    now.sort();
    was.sort();
    now != was
}

fn serve(servers: Vec<tiny_http::Server>, s: Arc<Session>) {
    let mut reason = "stopped";
    let mut last_net_check = Instant::now();
    'outer: loop {
        if s.stop.load(Ordering::Acquire) {
            break;
        }
        // 常驻等候不因空闲停；主动接收 30 分钟没新东西就停（有配对的手机就转回常驻等候）
        if !s.standby && s.idle_for() >= IDLE_STOP {
            reason = "idle";
            break;
        }
        if s.follow_network && last_net_check.elapsed() >= NET_CHECK {
            last_net_check = Instant::now();
            if network_changed(&s) {
                reason = "network";
                break;
            }
        }
        for server in &servers {
            match server.recv_timeout(Duration::from_millis(80)) {
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
                    break 'outer;
                }
            }
        }
    }
    // 先关监听（drop 即释放端口），再报状态
    drop(servers);
    s.stop.store(true, Ordering::Release);
    if let Ok(mut g) = RUNNING.lock() {
        if g.as_ref().is_some_and(|r| Arc::ptr_eq(&r.session, &s)) {
            *g = None;
        }
    }
    if reason != "stopped" {
        crate::logbuf::record("info", "phone-drop", &format!("接收已停止（{reason}）"));
    }
    let standby_next = !crate::process::shutting_down()
        && with_book(&s.book, |b| (b.standby_wanted(), false)).unwrap_or(false);
    s.emit_state(false, Some(reason), standby_next);
    // 自己停下的（空闲 / 网络变了 / 出错）：有配对的手机就接着常驻等候。人点的停止由 stop 命令自己接
    if reason != "stopped" && standby_next {
        let app = s.app.clone();
        let (stage, book, follow) = (s.stage.clone(), s.book.clone(), s.follow_network);
        let _ = std::thread::Builder::new()
            .name("phone-drop-standby".into())
            .spawn(move || {
                // 网络刚变时网卡可能还没拿到地址，稍等再绑
                std::thread::sleep(Duration::from_millis(if reason == "network" { 1500 } else { 50 }));
                let _ = ensure_standby_with(app, lan_candidates(), mdns_hostname(), stage, book, follow);
            });
    }
}

/// 常驻等候：没在接收、配对簿说要等（开着且有配对的手机）就在固定端口上开一个只认设备地址的服务；
/// 不想要了（关了开关 / 手机全移除）就把正在等候的停掉。主动接收中不动它
fn ensure_standby_with(
    app: Option<tauri::AppHandle>,
    candidates: Vec<(Ipv4Addr, String)>,
    hostname: Option<String>,
    stage: PathBuf,
    book: PathBuf,
    follow_network: bool,
) -> Result<(), String> {
    let _life = LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
    let (wanted, port) = with_book(&book, |b| ((b.standby_wanted(), b.port), false))?;
    let current = {
        let g = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        g.as_ref()
            .filter(|r| !r.session.stop.load(Ordering::Acquire))
            .map(|r| r.session.standby)
    };
    match (current, wanted) {
        // 主动接收中：等它结束再说
        (Some(false), _) | (Some(true), true) | (None, false) => return Ok(()),
        (Some(true), false) => {
            let old = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(old) = old {
                stop_running(old);
            }
            return Ok(());
        }
        (None, true) => {}
    }
    if candidates.is_empty() {
        return Ok(());
    }
    let spec = LaunchSpec {
        ips: candidates.iter().map(|(ip, _)| *ip).collect(),
        host: candidates[0].0.to_string(),
        addresses: Vec::new(),
        hostname,
        port,
        stage,
        book,
        standby: true,
        follow_network,
    };
    let running = launch(spec, app)?;
    running.session.emit_state(true, None, false);
    *RUNNING.lock().unwrap_or_else(|e| e.into_inner()) = Some(running);
    crate::logbuf::record("info", "phone-drop", "开始等配对的手机");
    Ok(())
}

fn ensure_standby(app: Option<tauri::AppHandle>) -> Result<(), String> {
    let book = devices_path().ok_or("无法确定 Mesa 数据目录")?;
    ensure_standby_with(app, lan_candidates(), mdns_hostname(), ensure_stage_dir()?, book, true)
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

const MANIFEST: &str = r##"{"name":"发到 Mesa","short_name":"发到 Mesa","start_url":"./","scope":"./","display":"standalone","background_color":"#161615","theme_color":"#161615","icons":[{"src":"icon.png","sizes":"256x256","type":"image/png"}]}"##;
const ICON_PNG: &[u8] = include_bytes!("../icons/128x128@2x.png");

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

/// 谁在访问：扫码配对页（本次接收的配对令牌）或已配对的手机（设备令牌）
enum Access {
    Pairing,
    Device(PairedDevice),
}

/// 路径两种：`/p/<配对令牌>/…`（扫码打开、可配对）与 `/d/<设备令牌>/…`（已配对手机，主屏网页记的就是它）
fn route(s: &Session, rq: &mut tiny_http::Request) -> tiny_http::Response<Cursor<Vec<u8>>> {
    let url = rq.url().to_string();
    let path = url.split(['?', '#']).next().unwrap_or("");
    let mut parts = path.trim_start_matches('/').splitn(3, '/');
    let kind = parts.next().unwrap_or("");
    let tok = parts.next().unwrap_or("");
    let sub = parts.next();
    let host_ok = header_value(rq, "Host")
        .is_some_and(|h| s.hosts.iter().any(|x| x.eq_ignore_ascii_case(&h)));
    if !host_ok {
        return not_found();
    }
    let access = match kind {
        "p" if s.pair_token.as_deref().is_some_and(|t| token_eq(tok, t)) => Access::Pairing,
        "d" => match device_by_token(&s.book, tok) {
            Some(d) => Access::Device(d),
            None => return not_found(),
        },
        _ => return not_found(),
    };
    let device_id = match &access {
        Access::Device(d) => Some(d.id.clone()),
        Access::Pairing => None,
    };
    let method = rq.method().clone();
    match (&method, sub) {
        (tiny_http::Method::Get, None) => tiny_http::Response::from_data(Vec::new())
            .with_status_code(302)
            .with_header(header("Location", &format!("/{kind}/{tok}/")))
            .with_header(header("Cache-Control", "no-store"))
            .with_header(header("Referrer-Policy", "no-referrer")),
        (tiny_http::Method::Get, Some("")) => {
            if let Access::Device(d) = &access {
                touch_device(&s.book, &d.id);
                s.mark_connected(Some(&d.name));
            } else {
                s.mark_connected(None);
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
        (tiny_http::Method::Get, Some("manifest.webmanifest")) => response(
            200,
            "application/manifest+json; charset=utf-8",
            MANIFEST.as_bytes().to_vec(),
        ),
        (tiny_http::Method::Get, Some("icon.png")) => response(200, "image/png", ICON_PNG.to_vec()),
        (tiny_http::Method::Get, Some("state")) => json_reply(
            200,
            serde_json::json!({
                "receiving": !s.stop.load(Ordering::Acquire),
                "paired": device_id.is_some(),
                "maxFileBytes": MAX_FILE_BYTES,
                "maxTextChars": MAX_TEXT_CHARS,
            }),
        ),
        (tiny_http::Method::Post, Some("pair")) if matches!(access, Access::Pairing) => pair(s, rq),
        (tiny_http::Method::Post, Some("file")) => receive_file(s, rq, device_id.as_deref()),
        (tiny_http::Method::Post, Some("text")) => receive_text(s, rq, device_id.as_deref()),
        _ => not_found(),
    }
}

/// 扫码配对：发一个长期设备令牌，手机网页跳到 `/d/<令牌>/`（加到主屏的就是这个地址）
fn pair(s: &Session, rq: &tiny_http::Request) -> tiny_http::Response<Cursor<Vec<u8>>> {
    let ua = header_value(rq, "User-Agent").unwrap_or_default();
    let token = new_device_token();
    let hash = sha256_hex(&token);
    let made = with_book(&s.book, |book| {
        if book.devices.len() >= MAX_DEVICES {
            return (None, false);
        }
        let taken: Vec<String> = book.devices.iter().map(|d| d.name.clone()).collect();
        let now = chrono::Local::now().to_rfc3339();
        let device = PairedDevice {
            id: uuid::Uuid::new_v4().simple().to_string(),
            name: device_name(&ua, &taken),
            token_sha256: hash,
            paired_at: now.clone(),
            last_seen_at: Some(now),
        };
        book.devices.push(device.clone());
        (Some(device), true)
    });
    match made {
        Ok(Some(device)) => {
            s.mark_connected(Some(&device.name));
            s.emit("phone-drop-paired", device_dto(&device));
            crate::logbuf::record("info", "phone-drop", "配对了一台手机");
            json_reply(200, serde_json::json!({ "ok": true, "path": format!("/d/{token}/") }))
        }
        Ok(None) => err_json(409, "too_many_devices"),
        Err(_) => err_json(500, "store_failed"),
    }
}

fn record_item(s: &Session, item: StoredItem, device: Option<&str>) -> Result<(), String> {
    let dto = to_dto(&s.stage, &item);
    with_index(&s.stage, |idx| {
        idx.items.push(item);
        Ok(())
    })?;
    if let Some(id) = device {
        touch_device(&s.book, id);
    }
    if let Ok(mut t) = s.last_item.lock() {
        *t = Instant::now();
    }
    s.received.fetch_add(1, Ordering::AcqRel);
    s.emit("phone-drop-item", dto);
    s.emit_state(true, None, false);
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

fn receive_file(
    s: &Session,
    rq: &mut tiny_http::Request,
    device: Option<&str>,
) -> tiny_http::Response<Cursor<Vec<u8>>> {
    let Some(len) = rq.body_length().map(|n| n as u64) else {
        return err_json(411, "length_required");
    };
    if len == 0 {
        return err_json(400, "empty");
    }
    if len > MAX_FILE_BYTES {
        return err_json(413, "too_large");
    }
    let Some(slot) = s.claim_upload() else {
        return err_json(503, "busy");
    };
    if !s.reserve_bytes(len) {
        return err_json(413, "session_full");
    }
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
            s.release_bytes(len);
            return err_json(400, "incomplete");
        }
    };
    if total != len {
        let _ = fs::remove_file(&part);
        s.release_bytes(len);
        return err_json(400, "incomplete");
    }
    let display = with_sniffed_ext(display, &head);
    let kind = classify(&display, &head);
    let file_name = unique_stage_name(&s.stage, &display);
    if fs::rename(&part, s.stage.join(&file_name)).is_err() {
        let _ = fs::remove_file(&part);
        s.release_bytes(len);
        return err_json(500, "store_failed");
    }
    let mut item = new_item(kind, display, len);
    item.file = Some(file_name.clone());
    if record_item(s, item, device).is_err() {
        let _ = fs::remove_file(s.stage.join(&file_name));
        s.release_bytes(len);
        return err_json(500, "store_failed");
    }
    json_reply(200, serde_json::json!({ "ok": true }))
}

fn receive_text(
    s: &Session,
    rq: &mut tiny_http::Request,
    device: Option<&str>,
) -> tiny_http::Response<Cursor<Vec<u8>>> {
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
    if record_item(s, item, device).is_err() {
        return err_json(500, "store_failed");
    }
    json_reply(200, serde_json::json!({ "ok": true }))
}

// ===== 命令层 =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneDropStatusDto {
    /// 主动接收中（有二维码、可配新手机）
    pub receiving: bool,
    /// 常驻等候中：没在主动接收，但已配对的手机随时能发
    pub standby: bool,
    /// 「Mesa 开着就随时接收已配对的手机」开关
    pub standby_enabled: bool,
    pub connected: bool,
    /// 扫码配对地址（二维码内容）
    pub url: Option<String>,
    /// 二维码 SVG（黑码白底，深色主题下也好扫）
    pub qr_svg: Option<String>,
    /// 二维码用的主机（电脑名或 IP）
    pub host: Option<String>,
    /// 可选的主机：电脑名 + 各张网卡的 IP（多于一个时给「换一个地址」）
    pub addresses: Vec<PhoneAddrDto>,
    pub received: u32,
    /// 最近连上的已配对手机
    pub last_device: Option<String>,
    /// 固定端口被占、这次临时换了端口
    pub port_note: Option<String>,
}

fn idle_status(standby_enabled: bool) -> PhoneDropStatusDto {
    PhoneDropStatusDto {
        receiving: false,
        standby: false,
        standby_enabled,
        connected: false,
        url: None,
        qr_svg: None,
        host: None,
        addresses: Vec::new(),
        received: 0,
        last_device: None,
        port_note: None,
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

fn status_of(s: &Session) -> PhoneDropStatusDto {
    let running = !s.stop.load(Ordering::Acquire);
    PhoneDropStatusDto {
        receiving: running && !s.standby,
        standby: running && s.standby,
        standby_enabled: with_book(&s.book, |b| (b.standby_enabled(), false)).unwrap_or(true),
        connected: s.connected.load(Ordering::Acquire),
        url: s.url.clone(),
        qr_svg: s.url.as_deref().and_then(qr_svg),
        host: Some(s.host.clone()),
        addresses: s.addresses.clone(),
        received: s.received.load(Ordering::Acquire),
        last_device: s.last_device(),
        port_note: s.port_note.clone(),
    }
}

/// 开始接收（已在接收且没换主机就原样返回）。网卡、电脑名、暂存区、配对簿都由调用方给，测试可注入
fn start_with(
    app: Option<tauri::AppHandle>,
    bind: Option<String>,
    candidates: Vec<(Ipv4Addr, String)>,
    hostname: Option<String>,
    stage: PathBuf,
    book: PathBuf,
    is_mac: bool,
    follow_network: bool,
) -> Result<PhoneDropStatusDto, String> {
    let _life = LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
    let wanted = bind
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string);
    if let Some(w) = &wanted {
        let known = hostname.as_deref() == Some(w.as_str())
            || candidates.iter().any(|(ip, _)| ip.to_string() == *w);
        if !known {
            return Err("这个地址现在不可用，换一个再试".into());
        }
    }
    {
        let g = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = g.as_ref() {
            let same = wanted.as_deref().is_none_or(|w| w == r.session.host);
            // 常驻等候中点开始：换成主动接收（同一固定端口，重开一次）
            if same && !r.session.standby && !r.session.stop.load(Ordering::Acquire) {
                return Ok(status_of(&r.session));
            }
        }
    }
    if candidates.is_empty() {
        return Err("没找到可用的局域网地址：电脑要先连上 Wi-Fi 或网线（连手机热点也行）".into());
    }
    let (saved_port, pref) = with_book(&book, |b| ((b.port, b.host_pref.clone()), false))?;
    let host = match &wanted {
        Some(w) => w.clone(),
        None => default_host(hostname.as_deref(), &candidates, pref.as_deref(), is_mac)
            .ok_or("没找到可用的局域网地址")?,
    };
    let mut ips: Vec<Ipv4Addr> = candidates.iter().map(|(ip, _)| *ip).collect();
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        ips.retain(|x| *x != ip);
        ips.insert(0, ip);
    }
    let old = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(old) = old {
        stop_running(old);
    }
    let _ = sweep(&stage, now_secs());
    let spec = LaunchSpec {
        ips,
        host,
        addresses: addr_options(hostname.as_deref(), &candidates),
        hostname,
        port: saved_port,
        stage,
        book: book.clone(),
        standby: false,
        follow_network,
    };
    let running = launch(spec, app)?;
    // 记住固定端口（第一次；临时换端口那次不改）与人改选过的主机类型
    let port = running.session.port;
    let first_port = saved_port.is_none() && running.session.port_note.is_none();
    let new_pref = wanted
        .as_ref()
        .map(|w| if w.parse::<Ipv4Addr>().is_ok() { "ip" } else { "name" });
    with_book(&book, |b| {
        let mut changed = false;
        if first_port {
            b.port = Some(port);
            changed = true;
        }
        if let Some(p) = new_pref {
            if b.host_pref.as_deref() != Some(p) {
                b.host_pref = Some(p.to_string());
                changed = true;
            }
        }
        ((), changed)
    })?;
    let status = status_of(&running.session);
    *RUNNING.lock().unwrap_or_else(|e| e.into_inner()) = Some(running);
    crate::logbuf::record("info", "phone-drop", "开始接收");
    Ok(status)
}

fn start_impl(app: Option<tauri::AppHandle>, bind: Option<String>) -> Result<PhoneDropStatusDto, String> {
    let book = devices_path().ok_or("无法确定 Mesa 数据目录")?;
    start_with(
        app,
        bind,
        lan_candidates(),
        mdns_hostname(),
        ensure_stage_dir()?,
        book,
        cfg!(target_os = "macos"),
        true,
    )
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

fn current_status() -> PhoneDropStatusDto {
    let g = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    match g.as_ref() {
        Some(r) if !r.session.stop.load(Ordering::Acquire) => status_of(&r.session),
        _ => {
            let enabled = devices_path()
                .and_then(|p| with_book(&p, |b| (b.standby_enabled(), false)).ok())
                .unwrap_or(true);
            idle_status(enabled)
        }
    }
}

/// 停止主动接收：二维码作废；有配对的手机且开着「随时接收」就转回常驻等候
#[tauri::command]
pub async fn phone_drop_stop(app: tauri::AppHandle) -> Result<PhoneDropStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        {
            let _life = LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
            shutdown();
        }
        ensure_standby(Some(app))?;
        Ok(current_status())
    })
    .await
    .map_err(|e| format!("停止接收失败: {e}"))?
}

#[tauri::command]
pub fn phone_drop_status() -> PhoneDropStatusDto {
    current_status()
}

/// 启动时与配对名单变了之后对一次：该常驻等候就开，不该就停
#[tauri::command]
pub async fn phone_drop_sync(app: tauri::AppHandle) -> Result<PhoneDropStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_standby(Some(app))?;
        Ok(current_status())
    })
    .await
    .map_err(|e| format!("同步接收状态失败: {e}"))?
}

/// 「Mesa 开着就随时接收已配对的手机」开关
#[tauri::command]
pub async fn phone_drop_set_standby(app: tauri::AppHandle, enabled: bool) -> Result<PhoneDropStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let book = devices_path().ok_or("无法确定 Mesa 数据目录")?;
        with_book(&book, |b| {
            let changed = b.standby != Some(enabled);
            b.standby = Some(enabled);
            ((), changed)
        })?;
        ensure_standby(Some(app))?;
        Ok(current_status())
    })
    .await
    .map_err(|e| format!("设置失败: {e}"))?
}

fn devices_at(book: &Path) -> Result<Vec<PhoneDeviceDto>, String> {
    with_book(book, |b| (b.devices.iter().map(device_dto).collect(), false))
}

/// 已配对的手机（不含令牌）
#[tauri::command]
pub async fn phone_drop_devices() -> Result<Vec<PhoneDeviceDto>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let book = devices_path().ok_or("无法确定 Mesa 数据目录")?;
        devices_at(&book)
    })
    .await
    .map_err(|e| format!("读取已配对手机失败: {e}"))?
}

fn remove_device_at(book: &Path, id: &str) -> Result<(), String> {
    with_book(book, |b| {
        let before = b.devices.len();
        b.devices.retain(|d| d.id != id);
        ((), b.devices.len() != before)
    })
}

/// 移除一台手机：它主屏上的网页立刻失效，要再用得重新扫码；一台都不剩就不再常驻等候
#[tauri::command]
pub async fn phone_drop_remove_device(app: tauri::AppHandle, id: String) -> Result<PhoneDropStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let book = devices_path().ok_or("无法确定 Mesa 数据目录")?;
        remove_device_at(&book, &id)?;
        ensure_standby(Some(app))?;
        Ok(current_status())
    })
    .await
    .map_err(|e| format!("移除失败: {e}"))?
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

    fn book_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "ccode-phone-book-{name}-{}.json",
            uuid::Uuid::new_v4().simple()
        ))
    }

    fn test_launch(stage: &Path, book: &Path, port: Option<u16>) -> Running {
        test_launch_mode(stage, book, port, false)
    }

    fn test_launch_mode(stage: &Path, book: &Path, port: Option<u16>, standby: bool) -> Running {
        launch(
            LaunchSpec {
                ips: vec![Ipv4Addr::LOCALHOST],
                host: "127.0.0.1".into(),
                hostname: Some("testmac.local".into()),
                port,
                addresses: Vec::new(),
                stage: stage.to_path_buf(),
                book: book.to_path_buf(),
                standby,
                follow_network: false,
            },
            None,
        )
        .unwrap()
    }

    fn addr(r: &Running) -> String {
        format!("127.0.0.1:{}", r.session.port)
    }

    fn get(r: &Running, path: &str, host: &str) -> (u16, String) {
        http(
            &addr(r),
            &format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"),
            b"",
            false,
        )
    }

    fn post_at(
        r: &Running,
        path: &str,
        headers: &str,
        len: usize,
        body: &[u8],
        close: bool,
    ) -> (u16, String) {
        http(
            &addr(r),
            &format!(
                "POST {path} HTTP/1.1\r\nHost: {}\r\n{headers}Content-Length: {len}\r\nConnection: close\r\n\r\n",
                addr(r)
            ),
            body,
            close,
        )
    }

    fn post(r: &Running, sub: &str, name: Option<&str>, len: usize, body: &[u8], close: bool) -> (u16, String) {
        let name_header = name.map(|n| format!("X-Mesa-Name: {n}\r\n")).unwrap_or_default();
        let path = format!("/p/{}/{sub}", r.session.pair_token.as_deref().unwrap_or("-"));
        post_at(r, &path, &name_header, len, body, close)
    }

    /// 配对一台手机，返回设备地址前缀 /d/<令牌>/
    fn pair_phone(r: &Running, ua: &str) -> (u16, String) {
        let path = format!("/p/{}/pair", r.session.pair_token.as_deref().unwrap_or("-"));
        let (code, body) = post_at(r, &path, &format!("User-Agent: {ua}\r\n"), 0, b"", false);
        let dev = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["path"].as_str().map(str::to_string))
            .unwrap_or_default();
        (code, dev)
    }

    #[test]
    fn server_serves_page_and_hides_everything_else() {
        let stage = temp_dir("serve");
        let book = book_path("serve");
        let r = test_launch(&stage, &book, None);
        let host = addr(&r);
        let token = r.session.pair_token.clone().unwrap();
        let (code, body) = get(&r, &format!("/p/{token}/"), &host);
        assert_eq!(code, 200);
        assert!(body.contains("发到 Mesa"));
        assert!(r.session.connected.load(Ordering::Acquire));
        for sub in ["app.js", "app.css", "state", "manifest.webmanifest", "icon.png"] {
            assert_eq!(get(&r, &format!("/p/{token}/{sub}"), &host).0, 200, "{sub}");
        }
        assert_eq!(get(&r, &format!("/p/{token}"), &host).0, 302);
        let port = r.session.port;
        assert_eq!(get(&r, &format!("/p/{token}/"), &format!("TestMac.local:{port}")).0, 200, "电脑名也认");
        let not_found = get(&r, "/nope/", &host);
        assert_eq!(not_found, (404, "Not Found".to_string()));
        assert_eq!(get(&r, &format!("/p/{token}x/"), &host), not_found, "错令牌与未知路径一样");
        assert_eq!(get(&r, &format!("/{token}/"), &host), not_found, "旧式路径不认");
        assert_eq!(get(&r, "/d/0123456789abcdef/state", &host), not_found, "没配对的设备令牌");
        assert_eq!(get(&r, &format!("/p/{token}/items.json"), &host), not_found, "没有读暂存区的路由");
        assert_eq!(get(&r, &format!("/p/{token}/"), "evil.example:80"), not_found, "Host 不符");
        let a = addr(&r);
        stop_running(r);
        assert!(TcpStream::connect(&a).is_err(), "停止后端口释放");
        fs::remove_dir_all(&stage).ok();
        fs::remove_file(&book).ok();
    }

    #[test]
    fn server_receives_file_and_text() {
        let stage = temp_dir("recv");
        let book = book_path("recv");
        let r = test_launch(&stage, &book, None);
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
        fs::remove_file(&book).ok();
    }

    #[test]
    fn pairing_gives_a_lasting_device_address_and_removal_revokes_it() {
        let stage = temp_dir("pair");
        let book = book_path("pair");
        let r = test_launch(&stage, &book, None);
        let host = addr(&r);
        let iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1";
        let (code, dev) = pair_phone(&r, iphone);
        assert_eq!(code, 200);
        assert!(dev.starts_with("/d/") && dev.ends_with('/'), "{dev}");
        let token = dev.trim_start_matches("/d/").trim_end_matches('/').to_string();
        // 配对簿只存哈希
        let raw = fs::read_to_string(&book).unwrap();
        assert!(!raw.contains(&token), "令牌原文不落盘");
        assert!(raw.contains(&sha256_hex(&token)));
        let (code, body) = get(&r, &format!("{dev}state"), &host);
        assert_eq!(code, 200);
        assert!(body.contains("\"paired\":true"), "{body}");
        let text = "设备地址发来的";
        assert_eq!(post_at(&r, &format!("{dev}text"), "", text.len(), text.as_bytes(), false).0, 200);
        assert_eq!(r.session.last_device().as_deref(), Some("iPhone"));
        assert_eq!(post_at(&r, &format!("{dev}pair"), "", 0, b"", false).0, 404, "配对只走扫码地址");
        let (_, second) = pair_phone(&r, iphone);
        let devices = devices_at(&book).unwrap();
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[1].name, "iPhone 2");

        // 重开接收：扫码令牌换新、端口照旧（固定端口由调用方传入），设备地址照样能用
        let port = r.session.port;
        let old_pair = r.session.pair_token.clone().unwrap();
        stop_running(r);
        let r = test_launch(&stage, &book, Some(port));
        assert_eq!(r.session.port, port);
        assert_eq!(get(&r, &format!("{dev}state"), &host).0, 200, "换一次接收，主屏网页照样连上");
        assert_eq!(get(&r, &format!("/p/{old_pair}/"), &host).0, 404, "旧扫码令牌作废");

        // 移除即失效
        remove_device_at(&book, &devices[0].id).unwrap();
        assert_eq!(get(&r, &format!("{dev}state"), &host).0, 404);
        assert_eq!(get(&r, &format!("{second}state"), &host).0, 200, "只移除那一台");

        // 满 8 台不再配对
        with_book(&book, |b| {
            while b.devices.len() < MAX_DEVICES {
                b.devices.push(PairedDevice {
                    id: uuid::Uuid::new_v4().simple().to_string(),
                    name: "手机".into(),
                    token_sha256: sha256_hex(&new_device_token()),
                    paired_at: String::new(),
                    last_seen_at: None,
                });
            }
            ((), true)
        })
        .unwrap();
        assert_eq!(pair_phone(&r, iphone).0, 409);
        stop_running(r);
        fs::remove_dir_all(&stage).ok();
        fs::remove_file(&book).ok();
    }

    /// 用到全局 RUNNING 的测试串行跑
    static START_TESTS: Mutex<()> = Mutex::new(());

    #[test]
    fn start_remembers_port_and_address_choice() {
        let _serial = START_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let stage = temp_dir("start");
        let book = book_path("start");
        let lo = vec![(Ipv4Addr::LOCALHOST, "lo0".to_string())];
        let name = Some("testmac.local".to_string());
        let start = |bind: Option<&str>| {
            start_with(None, bind.map(str::to_string), lo.clone(), name.clone(), stage.clone(), book.clone(), true, false)
        };
        let first = start(None).unwrap();
        assert_eq!(first.host.as_deref(), Some("testmac.local"), "macOS 默认用电脑名");
        assert_eq!(first.addresses.len(), 2);
        let url = first.url.clone().unwrap();
        assert!(url.starts_with("http://testmac.local:"), "{url}");
        let port: u16 = with_book(&book, |b| (b.port, false)).unwrap().expect("记下固定端口");
        assert!(url.contains(&format!(":{port}/p/")));
        assert_eq!(start(None).unwrap().url.unwrap(), url, "已在接收：原样返回");
        assert!(start(Some("10.9.9.9")).is_err(), "不在候选里的地址拒绝");

        // 改选 IP：重开、记住偏好、端口不变
        let by_ip = start(Some("127.0.0.1")).unwrap();
        assert_eq!(by_ip.url.as_deref().unwrap(), format!("http://127.0.0.1:{port}/p/{}/", by_ip.url.as_deref().unwrap().rsplit("/p/").next().unwrap().trim_end_matches('/')));
        assert_eq!(with_book(&book, |b| (b.host_pref.clone(), false)).unwrap().as_deref(), Some("ip"));
        shutdown();
        let again = start(None).unwrap();
        assert!(again.url.unwrap().starts_with(&format!("http://127.0.0.1:{port}/")), "偏好 IP 后默认就是 IP");
        shutdown();

        // 固定端口被占：这次临时换端口并提醒，记下的端口不改
        let blocker = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        let moved = start(None).unwrap();
        assert!(moved.port_note.is_some());
        assert!(!moved.url.unwrap().contains(&format!(":{port}/")));
        assert_eq!(with_book(&book, |b| (b.port, false)).unwrap(), Some(port));
        shutdown();
        drop(blocker);
        fs::remove_dir_all(&stage).ok();
        fs::remove_file(&book).ok();
    }

    #[test]
    fn device_names_hostnames_and_default_host() {
        assert_eq!(device_name("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", &[]), "iPhone");
        assert_eq!(
            device_name("Mozilla/5.0 (iPhone)", &["iPhone".into(), "iPhone 2".into()]),
            "iPhone 3"
        );
        assert_eq!(device_name("Mozilla/5.0 (Linux; Android 14)", &[]), "安卓手机");
        assert_eq!(device_name("curl/8", &[]), "手机");
        assert_eq!(clean_hostname("TongzhouHongdeMacBook-Air\n").as_deref(), Some("tongzhouhongdemacbook-air.local"));
        assert_eq!(clean_hostname("DESKTOP-AB12").as_deref(), Some("desktop-ab12.local"));
        assert_eq!(clean_hostname("my mac"), None);
        assert_eq!(clean_hostname("张三的电脑"), None);
        assert_eq!(clean_hostname(""), None);
        let c = vec![(Ipv4Addr::new(192, 168, 1, 5), "en0".to_string())];
        assert_eq!(default_host(Some("a.local"), &c, None, true).as_deref(), Some("a.local"));
        assert_eq!(default_host(Some("a.local"), &c, None, false).as_deref(), Some("192.168.1.5"), "非 macOS 默认 IP");
        assert_eq!(default_host(Some("a.local"), &c, Some("ip"), true).as_deref(), Some("192.168.1.5"));
        assert_eq!(default_host(Some("a.local"), &c, Some("name"), false).as_deref(), Some("a.local"));
        assert_eq!(default_host(None, &c, Some("name"), true).as_deref(), Some("192.168.1.5"));
        let opts = addr_options(Some("a.local"), &c);
        assert_eq!(opts[0].host, "a.local");
        assert_eq!(opts[1].host, "192.168.1.5");
    }

    #[test]
    fn corrupt_device_book_fails_closed() {
        let book = book_path("corrupt");
        fs::write(&book, b"{oops").unwrap();
        assert!(devices_at(&book).unwrap().is_empty());
        assert!(device_by_token(&book, "anything").is_none());
        let kept = fs::read_dir(book.parent().unwrap())
            .unwrap()
            .flatten()
            .any(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                n.starts_with(book.file_stem().unwrap().to_string_lossy().as_ref()) && n.contains("corrupt-")
            });
        assert!(kept, "原件留证");
    }

    #[test]
    fn standby_only_lets_paired_phones_in() {
        let stage = temp_dir("standby");
        let book = book_path("standby");
        // 先主动接收配对一台，记下设备地址
        let r = test_launch(&stage, &book, None);
        let (_, dev) = pair_phone(&r, "Mozilla/5.0 (iPhone)");
        let port = r.session.port;
        stop_running(r);
        // 常驻等候：设备地址能发，扫码配对不开放
        let r = test_launch_mode(&stage, &book, Some(port), true);
        assert!(r.session.pair_token.is_none() && r.session.url.is_none());
        let host = addr(&r);
        assert_eq!(get(&r, &format!("{dev}state"), &host).0, 200);
        let text = "常驻时发来的";
        assert_eq!(post_at(&r, &format!("{dev}text"), "", text.len(), text.as_bytes(), false).0, 200);
        assert_eq!(post_at(&r, "/p/anything/pair", "", 0, b"", false).0, 404, "常驻等候不能配对");
        let st = status_of(&r.session);
        assert!(st.standby && !st.receiving && st.url.is_none() && st.qr_svg.is_none());
        stop_running(r);
        fs::remove_dir_all(&stage).ok();
        fs::remove_file(&book).ok();
    }

    #[test]
    fn standby_follows_switch_devices_and_active_sessions() {
        let _serial = START_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let stage = temp_dir("ensure");
        let book = book_path("ensure");
        let lo = vec![(Ipv4Addr::LOCALHOST, "lo0".to_string())];
        let name = Some("testmac.local".to_string());
        let ensure = || ensure_standby_with(None, lo.clone(), name.clone(), stage.clone(), book.clone(), false);
        let running_mode = || {
            RUNNING
                .lock()
                .unwrap()
                .as_ref()
                .map(|r| r.session.standby)
        };
        ensure().unwrap();
        assert_eq!(running_mode(), None, "没配对的手机不等候");
        with_book(&book, |b| {
            b.devices.push(PairedDevice {
                id: "d1".into(),
                name: "iPhone".into(),
                token_sha256: sha256_hex("tok"),
                paired_at: String::new(),
                last_seen_at: None,
            });
            ((), true)
        })
        .unwrap();
        ensure().unwrap();
        assert_eq!(running_mode(), Some(true), "有配对的手机：Mesa 开着就等");
        // 点开始：换成主动接收（有二维码）；停止后再对一次：回到常驻等候
        let st = start_with(None, None, lo.clone(), name.clone(), stage.clone(), book.clone(), true, false).unwrap();
        assert!(st.receiving && st.url.is_some());
        assert_eq!(running_mode(), Some(false));
        ensure().unwrap();
        assert_eq!(running_mode(), Some(false), "主动接收中不被常驻等候顶掉");
        shutdown();
        ensure().unwrap();
        assert_eq!(running_mode(), Some(true));
        // 关掉开关：停
        with_book(&book, |b| {
            b.standby = Some(false);
            ((), true)
        })
        .unwrap();
        ensure().unwrap();
        assert_eq!(running_mode(), None);
        shutdown();
        fs::remove_dir_all(&stage).ok();
        fs::remove_file(&book).ok();
    }

    #[test]
    fn byte_window_reserves_and_releases() {
        let stage = temp_dir("bytes");
        let book = book_path("bytes");
        let r = test_launch(&stage, &book, None);
        assert!(r.session.reserve_bytes(MAX_SESSION_BYTES - 10));
        assert!(!r.session.reserve_bytes(11), "超窗口上限");
        r.session.release_bytes(100);
        assert!(r.session.reserve_bytes(11), "没收完的退回去");
        stop_running(r);
        fs::remove_dir_all(&stage).ok();
        fs::remove_file(&book).ok();
    }

    #[test]
    fn upload_slots_ignore_stalled_connections() {
        let stage = temp_dir("slots");
        let book = book_path("slots");
        let r = test_launch(&stage, &book, None);
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
        fs::remove_file(&book).ok();
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

    /// 真机核对用：在本机局域网地址上开一个接收会话，打印地址后挂着（主动接收 PHONE_DROP_LIVE_ACTIVE_SECS，
    /// 之后转常驻等候 PHONE_DROP_LIVE_SECS，默认各 300 秒）；暂存区与配对簿重定向到临时目录，不碰真实数据目录。
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
        let secs = |key: &str, default: u64| -> u64 {
            std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
        };
        // 先主动接收（可扫码配对）；PHONE_DROP_LIVE_ACTIVE_SECS 后像关掉弹窗一样停下，有配对的手机就转常驻等候
        std::thread::sleep(Duration::from_secs(secs("PHONE_DROP_LIVE_ACTIVE_SECS", 300)));
        shutdown();
        ensure_standby(None).expect("常驻等候");
        println!("PHONE_DROP_STANDBY={:?}", current_status().standby);
        std::thread::sleep(Duration::from_secs(secs("PHONE_DROP_LIVE_SECS", 300)));
        shutdown();
    }
}
