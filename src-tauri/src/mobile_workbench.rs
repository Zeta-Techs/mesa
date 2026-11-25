//! Mesa 手机工作台（2026-11-24）：
//! - **物理隔离于 `phone_drop.rs`**：只监听本机回环 `127.0.0.1:<端口>`，永不绑 `0.0.0.0` 或普通局域网网卡（普通 Wi-Fi 继续守死「只收不出」）。
//! - **可插拔加密通道**：支持 Cloudflare Tunnel（一键自动拉起 `cloudflared`，手机免装 App、免账号、不与代理冲突）、`tailscale serve --bg --https=<port>`（默认 8443，只操作 Mesa 专属端口，永不 `reset`）或用户自定义 HTTPS 隧道 / 反代地址。
//! - **零重复直连 Rust 唯一真源**：项目概览 / 步骤详情 / 文件清单 / 人工请求 / 项目助手流式多轮会话全部直连 Rust 核心，
//!   跨网传资料复用 `phone_drop` 的 `phone-inbox/` 暂存区；仅派活执行经桌面事件桥校验后走既有 `dispatchWorkOrder`。
//! - **纵深安全**：0600 设备配对簿只存 SHA-256（最多 8 台，可随时移除）、5 分钟一次性配对码、
//!   `HttpOnly; SameSite=Strict`（HTTPS 下加 `Secure`）Cookie + `X-Mesa-CSRF` + `Origin` 校验、
//!   只读文件白名单防路径穿越与密钥文件拒读、全部出站文本经 `redact_sensitive_text` 脱敏、无内联脚本/样式严格 CSP。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Cursor, Read};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

const CONFIG_FILE: &str = "mobile-workbench.json";
const LOCK_NAME: &str = "mobile-workbench";
const MAX_DEVICES: usize = 8;
const PAIR_TTL_SECS: u64 = 5 * 60;
const DEFAULT_TS_HTTPS_PORT: u16 = 8443;
const MAX_TEXT_READ_BYTES: usize = 512 * 1024;
const MAX_RAW_READ_BYTES: u64 = 50 * 1024 * 1024;
const MAX_DIFF_CHARS: usize = 128 * 1024;
const MAX_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;
const MAX_JSON_BODY_BYTES: u64 = 256 * 1024;
const COOKIE_NAME: &str = "mesa_mw";

const PAGE_HTML: &str = include_str!("../resources/mobile-workbench/index.html");
const PAGE_JS: &str = include_str!("../resources/mobile-workbench/app.js");
const PAGE_CSS: &str = include_str!("../resources/mobile-workbench/app.css");
const PAGE_MANIFEST: &str = include_str!("../resources/mobile-workbench/manifest.webmanifest");
const PAGE_ICON: &str = include_str!("../resources/mobile-workbench/icon.svg");
const PAGE_APPLE_ICON_PNG: &[u8] = include_bytes!("../icons/ios/AppIcon-60x60@3x.png");
const PAGE_ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

const PAGE_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; frame-src 'self' blob:; object-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// ===== 持久化配置与设备簿 =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileDevice {
    id: String,
    name: String,
    token_hash: String,
    paired_at: String,
    last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    port: u16,
    /// "cloudflare" | "tailscale" | "custom"
    #[serde(default = "default_tunnel_mode")]
    tunnel_mode: String,
    #[serde(default = "default_ts_port")]
    tailscale_https_port: u16,
    /// 用户是否开启了 Tailscale Serve 通道：退出时清理端口，下次重启自动恢复映射
    #[serde(default)]
    tailscale_serve_wanted: bool,
    /// 用户是否开启了 Cloudflare Quick Tunnel：退出时杀子进程，下次重启自动恢复
    #[serde(default)]
    cloudflare_wanted: bool,
    #[serde(default)]
    custom_base_url: String,
    #[serde(default)]
    devices: Vec<MobileDevice>,
}

fn default_tunnel_mode() -> String {
    "cloudflare".to_string()
}

fn default_ts_port() -> u16 {
    DEFAULT_TS_HTTPS_PORT
}

impl Default for StoredConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 0,
            tunnel_mode: default_tunnel_mode(),
            tailscale_https_port: default_ts_port(),
            tailscale_serve_wanted: false,
            cloudflare_wanted: false,
            custom_base_url: String::new(),
            devices: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileDeviceDto {
    pub id: String,
    pub name: String,
    pub paired_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudflareInfoDto {
    pub installed: bool,
    pub binary_path: Option<String>,
    pub running: bool,
    pub tunnel_url: Option<String>,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleInfoDto {
    pub installed: bool,
    pub binary_path: Option<String>,
    pub backend_state: String,
    pub dns_name: Option<String>,
    pub tailscale_ips: Vec<String>,
    pub https_ready: bool,
    pub serve_active: bool,
    pub serve_url: Option<String>,
    pub mobile_peers_total: usize,
    pub mobile_peers_online: usize,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileWorkbenchStatusDto {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub local_url: Option<String>,
    pub tunnel_mode: String,
    pub tailscale_https_port: u16,
    pub custom_base_url: String,
    pub public_url: Option<String>,
    pub devices: Vec<MobileDeviceDto>,
    pub pairing_url: Option<String>,
    pub pairing_qr_svg: Option<String>,
    pub pairing_left_secs: u64,
    pub cloudflare: CloudflareInfoDto,
    pub tailscale: TailscaleInfoDto,
    pub last_error: Option<String>,
}

fn config_path() -> Result<PathBuf, String> {
    crate::storage::config_root()
        .map(|r| r.join(CONFIG_FILE))
        .ok_or_else(|| "无法确定 Mesa 配置目录".to_string())
}

fn load_config() -> StoredConfig {
    let Ok(path) = config_path() else {
        return StoredConfig::default();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return StoredConfig::default();
    };
    match serde_json::from_str::<StoredConfig>(&raw) {
        Ok(mut cfg) => {
            if !matches!(cfg.tunnel_mode.as_str(), "cloudflare" | "tailscale" | "custom") {
                cfg.tunnel_mode = default_tunnel_mode();
            }
            if cfg.tailscale_https_port == 0 {
                cfg.tailscale_https_port = DEFAULT_TS_HTTPS_PORT;
            }
            cfg
        }
        Err(_) => {
            // 损坏即改名留证、按空表继续（失败即收紧）
            let corrupt = path.with_extension(format!("corrupt-{}", chrono::Local::now().timestamp()));
            let _ = fs::rename(&path, corrupt);
            StoredConfig::default()
        }
    }
}

fn with_config_mut<T>(f: impl FnOnce(&mut StoredConfig) -> Result<T, String>) -> Result<T, String> {
    let _lock = crate::storage::config_lock(LOCK_NAME)?;
    let path = config_path()?;
    let mut cfg = load_config();
    let out = f(&mut cfg)?;
    let bytes = serde_json::to_vec_pretty(&cfg).map_err(|e| format!("序列化手机工作台配置失败: {e}"))?;
    crate::storage::atomic_write(&path, &bytes, true)?;
    Ok(out)
}

fn sha256_hex(input: &str) -> String {
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    format!("{:x}", h.finalize())
}

/// 常量时间字节比较（防时序侧信道）
fn ct_eq(a: &str, b: &str) -> bool {
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    if ab.len() != bb.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in ab.iter().zip(bb.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn csrf_for_token(token: &str) -> String {
    sha256_hex(&format!("mesa-mw-csrf:{token}"))[..32].to_string()
}

fn new_random_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// 5 分钟一次性配对码（128 位熵，降低二维码密度提升手机扫码识别率）
fn new_pairing_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn qr_svg(url: &str) -> Option<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::with_error_correction_level(url.as_bytes(), qrcode::EcLevel::L).ok()?;
    Some(
        code.render::<svg::Color>()
            .min_dimensions(240, 240)
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
    )
}

fn normalize_custom_url(raw: &str) -> Result<String, String> {
    let s = raw.trim().trim_end_matches('/');
    if s.is_empty() {
        return Ok(String::new());
    }
    let low = s.to_lowercase();
    let ok = low.starts_with("https://")
        || low.starts_with("http://127.0.0.1")
        || low.starts_with("http://localhost");
    if !ok {
        return Err("自定义地址必须使用 https://（仅本机调试允许 http://127.0.0.1 或 http://localhost）".into());
    }
    if s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("自定义地址不能包含空格或控制字符".into());
    }
    Ok(s.to_string())
}

fn extract_origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host_port = rest.split('/').next()?;
    if host_port.is_empty() {
        return None;
    }
    Some(format!("{}://{}", scheme.to_lowercase(), host_port.to_lowercase()))
}

// ===== Tailscale 探测与按端口托管 =====

fn resolve_tailscale_binary() -> Option<PathBuf> {
    if let Some(p) = crate::agents::resolve_binary("tailscale") {
        return Some(p);
    }
    let candidates: &[&str] = &[
        #[cfg(target_os = "macos")]
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        #[cfg(target_os = "macos")]
        "/opt/homebrew/bin/tailscale",
        #[cfg(target_os = "macos")]
        "/usr/local/bin/tailscale",
        #[cfg(target_os = "windows")]
        r"C:\Program Files\Tailscale\tailscale.exe",
        #[cfg(target_os = "linux")]
        "/usr/bin/tailscale",
        #[cfg(target_os = "linux")]
        "/usr/local/bin/tailscale",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn run_cmd_timeout(bin: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut cmd = crate::process::background_command(bin);
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("启动命令失败: {e}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                let mut err = String::new();
                if let Some(mut s) = child.stdout.take() {
                    let _ = s.read_to_string(&mut out);
                }
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_string(&mut err);
                }
                if status.success() {
                    return Ok(out);
                }
                let detail = if !err.trim().is_empty() {
                    err.trim().to_string()
                } else {
                    out.trim().to_string()
                };
                return Err(if detail.is_empty() {
                    format!("命令退出码 {}", status.code().unwrap_or(-1))
                } else {
                    detail
                });
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("命令执行超时".into());
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(e) => return Err(format!("等待命令失败: {e}")),
        }
    }
}

pub(crate) fn parse_tailscale_status_json(
    status_json: &str,
    serve_json: Option<&str>,
    https_port: u16,
    binary_path: Option<String>,
) -> TailscaleInfoDto {
    let parsed = serde_json::from_str::<serde_json::Value>(status_json).ok();
    let Some(v) = parsed else {
        return TailscaleInfoDto {
            installed: true,
            binary_path,
            backend_state: "Unknown".into(),
            dns_name: None,
            tailscale_ips: Vec::new(),
            https_ready: false,
            serve_active: false,
            serve_url: None,
            mobile_peers_total: 0,
            mobile_peers_online: 0,
            hint: "读取 Tailscale 状态失败，请确认本机 Tailscale 应用已打开".into(),
        };
    };
    let backend_state = v
        .get("BackendState")
        .and_then(|s| s.as_str())
        .unwrap_or("Unknown")
        .to_string();
    let dns_name = v
        .get("Self")
        .and_then(|s| s.get("DNSName"))
        .and_then(|s| s.as_str())
        .map(|s| s.trim().trim_end_matches('.').to_string())
        .filter(|s| !s.is_empty());
    let tailscale_ips: Vec<String> = v
        .get("TailscaleIPs")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let cert_domains: Vec<String> = v
        .get("CertDomains")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let mut mobile_peers_total = 0usize;
    let mut mobile_peers_online = 0usize;
    if let Some(peers) = v.get("Peer").and_then(|p| p.as_object()) {
        for peer in peers.values() {
            let os = peer
                .get("OS")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_lowercase();
            if os == "ios" || os == "android" {
                mobile_peers_total += 1;
                if peer.get("Online").and_then(|b| b.as_bool()).unwrap_or(false) {
                    mobile_peers_online += 1;
                }
            }
        }
    }
    let https_ready = !cert_domains.is_empty();
    let serve_active = serve_json
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|sv| sv.get("TCP").and_then(|t| t.as_object()).cloned())
        .is_some_and(|tcp| tcp.contains_key(&https_port.to_string()));
    let host_for_url = cert_domains.first().cloned().or_else(|| dns_name.clone());
    let serve_url = host_for_url.map(|h| {
        if https_port == 443 {
            format!("https://{h}")
        } else {
            format!("https://{h}:{https_port}")
        }
    });

    let hint = match backend_state.as_str() {
        "Running" => {
            if !https_ready {
                "Tailscale 已连接，但尚未开启 HTTPS 证书：请到 Tailscale 网页后台 DNS 页打开 MagicDNS 与 HTTPS Certificates 后点刷新".into()
            } else if serve_active {
                if mobile_peers_total == 0 {
                    "Tailscale 通道运行中，但账号下尚未检测到手机节点（请确认手机已登录并加入同一 Tailscale 账号）".into()
                } else if mobile_peers_online == 0 {
                    "Tailscale 通道运行中，但手机节点未在线（请在手机端开启 Tailscale 连接，或改用免装 App 的 Cloudflare 通道）".into()
                } else {
                    "Tailscale HTTPS 加密通道运行中，可在手机 4G/5G 或任意 Wi-Fi 访问".into()
                }
            } else {
                "Tailscale 已就绪，点击「开启通道」即可获得固定 HTTPS 地址".into()
            }
        }
        "Stopped" => "本机 Tailscale 已安装但未启动，请先打开 Tailscale 应用并连接".into(),
        "NeedsLogin" => "Tailscale 尚未登录，请先在 Tailscale 应用里完成登录".into(),
        _ => format!("Tailscale 当前状态：{backend_state}，请确认应用已登录并联网"),
    };

    TailscaleInfoDto {
        installed: true,
        binary_path,
        backend_state,
        dns_name,
        tailscale_ips,
        https_ready,
        serve_active,
        serve_url,
        mobile_peers_total,
        mobile_peers_online,
        hint,
    }
}

fn inspect_tailscale(https_port: u16) -> TailscaleInfoDto {
    let Some(bin) = resolve_tailscale_binary() else {
        return TailscaleInfoDto {
            installed: false,
            binary_path: None,
            backend_state: "NotInstalled".into(),
            dns_name: None,
            tailscale_ips: Vec::new(),
            https_ready: false,
            serve_active: false,
            serve_url: None,
            mobile_peers_total: 0,
            mobile_peers_online: 0,
            hint: "未检测到 Tailscale：可改用「Cloudflare（免装 App）」一键直连，或安装 Tailscale 获取固定主屏域名".into(),
        };
    };
    let bin_str = Some(bin.to_string_lossy().into_owned());
    let status_out = match run_cmd_timeout(&bin, &["status", "--json"], Duration::from_secs(5)) {
        Ok(o) => o,
        Err(e) => {
            return TailscaleInfoDto {
                installed: true,
                binary_path: bin_str,
                backend_state: "Unavailable".into(),
                dns_name: None,
                tailscale_ips: Vec::new(),
                https_ready: false,
                serve_active: false,
                serve_url: None,
                mobile_peers_total: 0,
                mobile_peers_online: 0,
                hint: format!("无法读取 Tailscale 状态（{e}），请确认 Tailscale 应用已启动"),
            };
        }
    };
    let serve_out = run_cmd_timeout(&bin, &["serve", "status", "--json"], Duration::from_secs(4)).ok();
    parse_tailscale_status_json(&status_out, serve_out.as_deref(), https_port, bin_str)
}

fn apply_tailscale_serve(enable: bool, https_port: u16, local_port: u16) -> Result<(), String> {
    let bin = resolve_tailscale_binary().ok_or("未找到 Tailscale CLI，请先安装并启动 Tailscale")?;
    let port_flag = format!("--https={https_port}");
    if enable {
        if local_port == 0 {
            return Err("手机工作台本地服务尚未启动，请先打开开关".into());
        }
        let target = format!("127.0.0.1:{local_port}");
        run_cmd_timeout(
            &bin,
            &["serve", "--bg", &port_flag, "--yes", &target],
            Duration::from_secs(12),
        )
        .map(|_| ())
        .map_err(|e| format!("开启 Tailscale Serve 失败：{e}"))
    } else {
        // 仅关闭 Mesa 专用端口，绝不执行 tailscale serve reset 误清用户其它规则
        run_cmd_timeout(&bin, &["serve", &port_flag, "off"], Duration::from_secs(6))
            .map(|_| ())
            .map_err(|e| format!("关闭 Tailscale Serve 失败：{e}"))
    }
}

// ===== Cloudflare Quick Tunnel（免装手机 App / 免账号 / 一键自动托管）=====

static CF_INSTALLING: AtomicBool = AtomicBool::new(false);

struct AtomicFlagReset(&'static AtomicBool);
impl Drop for AtomicFlagReset {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn managed_cloudflared_path() -> Result<PathBuf, String> {
    let root = crate::storage::config_root().ok_or_else(|| "无法确定 Mesa 配置目录".to_string())?;
    let bin_name = if cfg!(target_os = "windows") {
        "cloudflared.exe"
    } else {
        "cloudflared"
    };
    Ok(root.join("bin").join(bin_name))
}

fn resolve_cloudflared_binary() -> Option<PathBuf> {
    if let Ok(managed) = managed_cloudflared_path() {
        if managed.is_file() {
            return Some(managed);
        }
    }
    if let Some(p) = crate::agents::resolve_binary("cloudflared") {
        return Some(p);
    }
    let candidates: &[&str] = &[
        #[cfg(target_os = "macos")]
        "/opt/homebrew/bin/cloudflared",
        #[cfg(target_os = "macos")]
        "/usr/local/bin/cloudflared",
        #[cfg(target_os = "windows")]
        r"C:\Program Files\cloudflared\cloudflared.exe",
        #[cfg(target_os = "windows")]
        r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
        #[cfg(target_os = "linux")]
        "/usr/local/bin/cloudflared",
        #[cfg(target_os = "linux")]
        "/usr/bin/cloudflared",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn cloudflared_download_asset() -> Result<(&'static str, bool), String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok((
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz",
            true,
        )),
        ("macos", "x86_64") => Ok((
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz",
            true,
        )),
        ("windows", "x86_64" | "aarch64") => Ok((
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
            false,
        )),
        ("linux", "x86_64") => Ok((
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
            false,
        )),
        ("linux", "aarch64") => Ok((
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64",
            false,
        )),
        (os, arch) => Err(format!(
            "暂不支持为 {os}/{arch} 自动下载 cloudflared，请手动安装后点击刷新"
        )),
    }
}

fn outbound_proxy_for_mobile() -> Option<String> {
    if cfg!(test) {
        return None;
    }
    let s = crate::settings::read_current();
    s.outbound_proxy
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty() && crate::settings::validate_outbound_proxy(p).is_ok())
        .map(str::to_string)
}

/// 首次开启 Cloudflare 通道时自动从官方 GitHub Release 下载 `cloudflared` 到 Mesa 私有 bin 目录
async fn install_cloudflared_async() -> Result<PathBuf, String> {
    if let Some(existing) = resolve_cloudflared_binary() {
        return Ok(existing);
    }
    if CF_INSTALLING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("正在下载 cloudflared 组件，请稍候完成后重试".into());
    }
    let _reset = AtomicFlagReset(&CF_INSTALLING);

    let (url, is_tgz) = cloudflared_download_asset()?;
    let target = managed_cloudflared_path()?;

    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .user_agent("Mesa/1.0");
    if let Some(p) = outbound_proxy_for_mobile() {
        builder = builder.proxy(reqwest::Proxy::all(&p).map_err(|e| format!("出网代理不可用：{e}"))?);
    }
    let client = builder
        .build()
        .map_err(|e| format!("创建下载客户端失败：{e}"))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载 cloudflared 失败（可在设置页配置出网代理后重试）：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载 cloudflared 失败（HTTP {}）", resp.status().as_u16()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取 cloudflared 安装包失败：{e}"))?;
    if bytes.len() < 1_000_000 || bytes.len() > 150_000_000 {
        return Err(format!("下载的 cloudflared 文件大小异常（{} 字节）", bytes.len()));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let bin_dir = target
            .parent()
            .ok_or_else(|| "无法确定 cloudflared 安装目录".to_string())?;
        fs::create_dir_all(bin_dir).map_err(|e| format!("创建组件目录失败：{e}"))?;
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let tmp_dl = bin_dir.join(format!("cloudflared-dl-{tag}.tmp"));
        fs::write(&tmp_dl, &bytes).map_err(|e| format!("写入下载临时文件失败：{e}"))?;

        if is_tgz {
            let ext_dir = bin_dir.join(format!("cloudflared-ext-{tag}"));
            fs::create_dir_all(&ext_dir).map_err(|e| {
                let _ = fs::remove_file(&tmp_dl);
                format!("创建解压目录失败：{e}")
            })?;
            let tar_bin = if Path::new("/usr/bin/tar").is_file() {
                Path::new("/usr/bin/tar")
            } else {
                Path::new("tar")
            };
            let ext_res = run_cmd_timeout(
                tar_bin,
                &[
                    "-xzf",
                    &tmp_dl.to_string_lossy(),
                    "-C",
                    &ext_dir.to_string_lossy(),
                    "cloudflared",
                ],
                Duration::from_secs(20),
            );
            let _ = fs::remove_file(&tmp_dl);
            if let Err(e) = ext_res {
                let _ = fs::remove_dir_all(&ext_dir);
                return Err(format!("解压 cloudflared 失败：{e}"));
            }
            let extracted = ext_dir.join("cloudflared");
            if !extracted.is_file() {
                let _ = fs::remove_dir_all(&ext_dir);
                return Err("解压后未找到 cloudflared 可执行文件".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&extracted, fs::Permissions::from_mode(0o755));
            }
            let mv_res = fs::rename(&extracted, &target);
            let _ = fs::remove_dir_all(&ext_dir);
            mv_res.map_err(|e| format!("安装 cloudflared 失败：{e}"))?;
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&tmp_dl, fs::Permissions::from_mode(0o755));
            }
            #[cfg(target_os = "windows")]
            if target.exists() {
                let _ = fs::remove_file(&target);
            }
            fs::rename(&tmp_dl, &target).map_err(|e| {
                let _ = fs::remove_file(&tmp_dl);
                format!("安装 cloudflared 失败：{e}")
            })?;
        }
        Ok(target)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 从 `cloudflared` 输出行里严格提取 `https://<slug>.trycloudflare.com`
pub(crate) fn extract_trycloudflare_url(line: &str) -> Option<String> {
    const PREFIX: &str = "https://";
    const SUFFIX: &str = ".trycloudflare.com";
    let mut rest = line;
    while let Some(idx) = rest.find(PREFIX) {
        let after = &rest[idx + PREFIX.len()..];
        let host_end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '.'))
            .unwrap_or(after.len());
        let host_low = after[..host_end].to_lowercase();
        if host_low.ends_with(SUFFIX) {
            let sub = &host_low[..host_low.len() - SUFFIX.len()];
            if !sub.is_empty()
                && !sub.contains('.')
                && !sub.starts_with('-')
                && !sub.ends_with('-')
                && sub
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            {
                return Some(format!("https://{host_low}"));
            }
        }
        rest = after;
    }
    None
}

/// background_command().spawn() 在 Windows 上返回带诊断追踪的 TrackedChild，其他平台是 Child
#[cfg(windows)]
type TunnelChild = crate::process::TrackedChild;
#[cfg(not(windows))]
type TunnelChild = std::process::Child;

struct CloudflareTunnel {
    child: Arc<Mutex<TunnelChild>>,
    pid: u32,
    url: String,
    local_port: u16,
    stop: Arc<AtomicBool>,
}

enum CfLogEvent {
    Url(String),
    Connected,
}

fn start_cloudflare_tunnel_sync(
    bin: &Path,
    app: Option<tauri::AppHandle>,
    local_port: u16,
) -> Result<CloudflareTunnel, String> {
    if local_port == 0 {
        return Err("手机工作台本机服务尚未启动，请先打开开关".into());
    }
    let upstream = format!("http://127.0.0.1:{local_port}");
    let mut cmd = crate::process::background_command(bin);
    // 使用 http2（TCP）绕开校园网/国内运营商常见的 UDP 7844 QUIC 阻断，显著提升连通率
    cmd.args([
        "tunnel",
        "--no-autoupdate",
        "--protocol",
        "http2",
        "--url",
        &upstream,
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    for (k, v) in crate::settings::download_proxy_env(&["127.0.0.1", "localhost"]) {
        cmd.env(k, v);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 cloudflared 失败：{e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (ev_tx, ev_rx) = mpsc::channel::<CfLogEvent>();
    let recent_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let spawn_reader = |pipe: Option<Box<dyn Read + Send>>,
                        tx: mpsc::Sender<CfLogEvent>,
                        recent: Arc<Mutex<Vec<String>>>| {
        let Some(p) = pipe else { return };
        std::thread::spawn(move || {
            let reader = BufReader::new(p);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(u) = extract_trycloudflare_url(&line) {
                    let _ = tx.send(CfLogEvent::Url(u));
                }
                if line.to_lowercase().contains("registered tunnel connection") {
                    let _ = tx.send(CfLogEvent::Connected);
                }
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    if let Ok(mut buf) = recent.lock() {
                        if buf.len() >= 8 {
                            buf.remove(0);
                        }
                        buf.push(trimmed.chars().take(200).collect());
                    }
                }
            }
        });
    };
    spawn_reader(
        stdout.map(|s| Box::new(s) as Box<dyn Read + Send>),
        ev_tx.clone(),
        recent_lines.clone(),
    );
    spawn_reader(
        stderr.map(|s| Box::new(s) as Box<dyn Read + Send>),
        ev_tx,
        recent_lines.clone(),
    );

    let deadline = Instant::now() + Duration::from_secs(25);
    let mut found_url: Option<String> = None;
    let mut connected = false;
    let mut connect_deadline: Option<Instant> = None;

    loop {
        if let Some(cd) = connect_deadline {
            if connected || Instant::now() >= cd {
                break;
            }
        }
        match ev_rx.recv_timeout(Duration::from_millis(120)) {
            Ok(CfLogEvent::Url(u)) => {
                if found_url.is_none() {
                    found_url = Some(u);
                    // 拿到域名后再稍等边缘节点注册完成（最多 5 秒），避免扫码瞬间遇到冷启动 530
                    connect_deadline = Some(Instant::now() + Duration::from_secs(5));
                }
            }
            Ok(CfLogEvent::Connected) => {
                connected = true;
                if found_url.is_some() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if let Ok(Some(status)) = child.try_wait() {
            let tail = recent_lines
                .lock()
                .ok()
                .map(|b| b.join(" | "))
                .unwrap_or_default();
            let detail = if tail.is_empty() {
                format!("退出码 {}", status.code().unwrap_or(-1))
            } else {
                tail
            };
            return Err(format!("Cloudflare 通道提前退出：{detail}"));
        }
        if found_url.is_none() && Instant::now() >= deadline {
            crate::pty::kill_process_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
            return Err("Cloudflare 通道启动超时，请检查网络连接（或切换设置页出网代理后重试）".into());
        }
    }

    let Some(url) = found_url else {
        crate::pty::kill_process_tree(pid);
        let _ = child.kill();
        let _ = child.wait();
        let tail = recent_lines
            .lock()
            .ok()
            .map(|b| b.join(" | "))
            .unwrap_or_default();
        return Err(if tail.is_empty() {
            "未能从 cloudflared 获取临时 HTTPS 地址".into()
        } else {
            format!("未能获取 Cloudflare 通道地址：{tail}")
        });
    };

    let child_arc = Arc::new(Mutex::new(child));
    let stop = Arc::new(AtomicBool::new(false));
    let watch_child = child_arc.clone();
    let watch_stop = stop.clone();
    std::thread::spawn(move || {
        while !watch_stop.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(500));
            if watch_stop.load(Ordering::Acquire) {
                break;
            }
            let exited = watch_child
                .lock()
                .ok()
                .and_then(|mut c| c.try_wait().ok().flatten())
                .is_some();
            if exited {
                let mut cleared = false;
                if let Ok(mut rt) = runtime().lock() {
                    if rt.cloudflare.as_ref().is_some_and(|cf| cf.pid == pid) {
                        rt.cloudflare = None;
                        rt.last_error = Some("Cloudflare 加密通道已断开，请重新点击开启".into());
                        cleared = true;
                    }
                }
                if cleared {
                    if let Some(ref a) = app {
                        let _ = a.emit("mobile-workbench-status", ());
                    }
                }
                break;
            }
        }
    });

    Ok(CloudflareTunnel {
        child: child_arc,
        pid,
        url,
        local_port,
        stop,
    })
}

fn stop_cloudflare_tunnel_locked(rt: &mut Runtime) {
    if let Some(cf) = rt.cloudflare.take() {
        cf.stop.store(true, Ordering::Release);
        crate::pty::kill_process_tree(cf.pid);
        if let Ok(mut ch) = cf.child.lock() {
            let _ = ch.kill();
            let _ = ch.wait();
        }
    }
}

fn inspect_cloudflare(running_url: Option<String>) -> CloudflareInfoDto {
    let bin = resolve_cloudflared_binary();
    let installed = bin.is_some();
    let binary_path = bin.map(|p| p.to_string_lossy().into_owned());
    let running = running_url.is_some();
    let hint = if running {
        "Cloudflare 加密通道运行中，手机免装 App 扫码直连（支持 4G/5G，不与代理冲突）".into()
    } else if installed {
        "已就绪，点击「开启通道」即可生成加密 HTTPS 地址（免账号、手机免装 App）".into()
    } else {
        "首次点击「开启通道」将自动下载官方 cloudflared 组件并启动（免账号、手机免装 App）".into()
    };
    CloudflareInfoDto {
        installed,
        binary_path,
        running,
        tunnel_url: running_url,
        hint,
    }
}

// ===== 运行时会话与桌面派活桥 =====

struct PairingState {
    token: String,
    expires_at: Instant,
}

struct RunningServer {
    port: u16,
    stop: Arc<AtomicBool>,
    server: Arc<tiny_http::Server>,
    app: Option<tauri::AppHandle>,
    managed_ts_port: Mutex<Option<u16>>,
    /// 测试态把调用线程的重定向配置根传给 HTTP 工作线程，确保测试绝不触碰真实用户配置目录
    #[cfg(test)]
    test_config_root: Option<PathBuf>,
}

struct Runtime {
    running: Option<Arc<RunningServer>>,
    cloudflare: Option<CloudflareTunnel>,
    pairing: Option<PairingState>,
    last_error: Option<String>,
    /// 最近一次探测到的有效 Tailscale Serve 公网地址（供飞书通知零阻塞读取）
    last_serve_url: Option<String>,
}

impl Runtime {
    fn new() -> Self {
        Self {
            running: None,
            cloudflare: None,
            pairing: None,
            last_error: None,
            last_serve_url: None,
        }
    }
}

static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();
static PENDING_BRIDGE: OnceLock<Mutex<HashMap<String, mpsc::Sender<Result<String, String>>>>> =
    OnceLock::new();

fn runtime() -> &'static Mutex<Runtime> {
    RUNTIME.get_or_init(|| Mutex::new(Runtime::new()))
}

fn pending_bridge() -> &'static Mutex<HashMap<String, mpsc::Sender<Result<String, String>>>> {
    PENDING_BRIDGE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 流式 SSE Reader：后台线程通过 mpsc::Sender 实时推入字节块，`tiny_http` 按 chunked 立即刷出
struct ChannelReader {
    rx: mpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
    pos: usize,
}

impl ChannelReader {
    fn new(rx: mpsc::Receiver<Vec<u8>>) -> Self {
        Self {
            rx,
            buf: Vec::new(),
            pos: 0,
        }
    }
}

impl Read for ChannelReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.buf.len() {
            match self.rx.recv() {
                Ok(chunk) => {
                    self.buf = chunk;
                    self.pos = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let avail = self.buf.len() - self.pos;
        let n = avail.min(out.len());
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

fn sse_frame(event: &str, payload: &serde_json::Value) -> Vec<u8> {
    format!("event: {event}\ndata: {payload}\n\n").into_bytes()
}

// ===== HTTP 辅助与安全守卫 =====

fn header_val(rq: &tiny_http::Request, name: &str) -> Option<String> {
    rq.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn cookie_token(rq: &tiny_http::Request) -> Option<String> {
    let raw = header_val(rq, "Cookie")?;
    for part in raw.split(';') {
        let (k, v) = part.trim().split_once('=')?;
        if k.trim() == COOKIE_NAME {
            let val = v.trim();
            if !val.is_empty() && val.len() <= 128 && val.chars().all(|c| c.is_ascii_alphanumeric()) {
                return Some(val.to_string());
            }
        }
    }
    None
}

fn parse_url_parts(url: &str) -> (String, HashMap<String, String>) {
    let (path, qs) = url.split_once('?').unwrap_or((url, ""));
    let mut map = HashMap::new();
    for pair in qs.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        map.insert(percent_decode(k), percent_decode(v));
    }
    (path.to_string(), map)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn security_headers(content_type: &str, csp: Option<&str>) -> Vec<tiny_http::Header> {
    let mut hs = Vec::new();
    let mut push = |k: &str, v: &str| {
        if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            hs.push(h);
        }
    };
    push("Content-Type", content_type);
    push("Cache-Control", "no-store");
    push("Referrer-Policy", "no-referrer");
    push("X-Content-Type-Options", "nosniff");
    if let Some(c) = csp {
        push("Content-Security-Policy", c);
    }
    hs
}

fn reply_bytes(
    status: u16,
    content_type: &str,
    body: Vec<u8>,
    csp: Option<&str>,
    extra_headers: &[(&str, &str)],
) -> tiny_http::Response<Cursor<Vec<u8>>> {
    let mut hs = security_headers(content_type, csp);
    for (k, v) in extra_headers {
        if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            hs.push(h);
        }
    }
    let len = body.len();
    tiny_http::Response::new(tiny_http::StatusCode(status), hs, Cursor::new(body), Some(len), None)
}

fn reply_json(status: u16, v: serde_json::Value) -> tiny_http::Response<Cursor<Vec<u8>>> {
    let bytes = serde_json::to_vec(&v).unwrap_or_else(|_| b"{}".to_vec());
    reply_bytes(status, "application/json; charset=utf-8", bytes, None, &[])
}

fn reply_err(status: u16, msg: &str) -> tiny_http::Response<Cursor<Vec<u8>>> {
    reply_json(status, serde_json::json!({ "error": msg }))
}

fn read_json_body(rq: &mut tiny_http::Request) -> Result<serde_json::Value, String> {
    if rq.body_length().is_some_and(|n| n as u64 > MAX_JSON_BODY_BYTES) {
        return Err("请求体过大".into());
    }
    let mut bytes = Vec::new();
    rq.as_reader()
        .take(MAX_JSON_BODY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取请求失败: {e}"))?;
    if bytes.len() as u64 > MAX_JSON_BODY_BYTES {
        return Err("请求体过大".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "JSON 格式不正确".to_string())
}

fn authenticate(rq: &tiny_http::Request) -> Option<(MobileDevice, String)> {
    let token = cookie_token(rq)?;
    let hash = sha256_hex(&token);
    let cfg = load_config();
    let dev = cfg.devices.into_iter().find(|d| ct_eq(&d.token_hash, &hash))?;
    Some((dev, token))
}

fn check_csrf_and_origin(rq: &tiny_http::Request, token: &str, local_port: u16) -> Result<(), String> {
    let supplied = header_val(rq, "X-Mesa-CSRF").unwrap_or_default();
    let expected = csrf_for_token(token);
    if !ct_eq(supplied.trim(), &expected) {
        return Err("安全校验失败（CSRF 令牌不匹配），请刷新页面".into());
    }
    if let Some(origin) = header_val(rq, "Origin") {
        let orig = origin.trim().to_lowercase();
        let cfg = load_config();
        let mut allowed = vec![
            format!("http://127.0.0.1:{local_port}"),
            format!("http://localhost:{local_port}"),
        ];
        if let Some(o) = extract_origin(&cfg.custom_base_url) {
            allowed.push(o);
        }
        {
            let rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(ref cf) = rt.cloudflare {
                if let Some(o) = extract_origin(&cf.url) {
                    allowed.push(o);
                }
            }
            if let Some(ref ts_u) = rt.last_serve_url {
                if let Some(o) = extract_origin(ts_u) {
                    allowed.push(o);
                }
            }
        }
        if let Some(host) = header_val(rq, "Host") {
            let h = host.trim().to_lowercase();
            allowed.push(format!("https://{h}"));
            if h.starts_with("127.0.0.1") || h.starts_with("localhost") {
                allowed.push(format!("http://{h}"));
            }
        }
        // Tailscale Serve / Cloudflare Tunnel / 本地反代把 Host 改写为 127.0.0.1 时，外部真实主机在 X-Forwarded-Host 里；
        // 因本服务只监听 127.0.0.1，该头仅能由本机可信反代注入
        if let Some(xfh) = header_val(rq, "X-Forwarded-Host") {
            let first = xfh.split(',').next().unwrap_or("").trim().to_lowercase();
            if !first.is_empty() && !first.contains('/') && !first.chars().any(char::is_whitespace) {
                allowed.push(format!("https://{first}"));
                if !first.contains(':') && cfg.tailscale_https_port != 443 {
                    allowed.push(format!("https://{first}:{}", cfg.tailscale_https_port));
                }
            }
        }
        if !allowed.iter().any(|a| a == &orig) {
            return Err("来源域名不在允许名单内".into());
        }
    }
    Ok(())
}

fn touch_device_last_seen(device_id: &str) {
    let now = chrono::Local::now().to_rfc3339();
    let _ = with_config_mut(|cfg| {
        if let Some(d) = cfg.devices.iter_mut().find(|d| d.id == device_id) {
            d.last_seen_at = now;
        }
        Ok(())
    });
}

fn registered_projects() -> Vec<crate::projects::ProjectDto> {
    crate::workspaces::db()
        .ok()
        .and_then(|c| crate::projects::list_projects_in(&c).ok())
        .unwrap_or_default()
}

fn verify_registered_project(project_root: &str) -> Result<crate::projects::ProjectDto, String> {
    let norm = crate::sessions::expand_tilde(project_root.trim());
    registered_projects()
        .into_iter()
        .find(|p| crate::paths::same_path(&p.path, &norm))
        .ok_or_else(|| "该项目未在 Mesa 注册，拒绝访问".to_string())
}

/// 只读文件安全校验：严禁读项目外路径、隐藏密钥文件与私钥
fn resolve_safe_project_file(project_root: &str, rel_path: &str) -> Result<PathBuf, String> {
    let clean = rel_path.trim().trim_start_matches("./").replace('\\', "/");
    if clean.is_empty() || clean.starts_with('/') || clean.starts_with('~') {
        return Err("路径非法".into());
    }
    let b = clean.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return Err("路径非法".into());
    }
    let segs: Vec<&str> = clean.split('/').collect();
    if segs.iter().any(|s| *s == ".." || s.is_empty()) {
        return Err("路径不能越出项目目录".into());
    }
    let low = clean.to_lowercase();
    if low.starts_with(".git/") || low == ".git" {
        return Err("不允许读取 .git 目录".into());
    }
    let file_name = segs.last().copied().unwrap_or("").to_lowercase();
    let forbidden = file_name == ".env"
        || file_name.starts_with(".env.")
        || file_name.ends_with(".pem")
        || file_name.ends_with(".p12")
        || file_name.ends_with(".pfx")
        || file_name.ends_with(".key")
        || file_name == "keys.json"
        || file_name == "id_rsa"
        || file_name == "id_ed25519"
        || file_name.contains("credentials")
        || file_name.contains("secret");
    if forbidden {
        return Err("敏感密钥或凭据文件禁止通过手机读取".into());
    }
    let root_canon = fs::canonicalize(project_root).map_err(|_| "项目目录不存在".to_string())?;
    let target = root_canon.join(&clean);
    let target_canon = fs::canonicalize(&target).map_err(|_| "文件不存在".to_string())?;
    if !target_canon.is_file() {
        return Err("目标不是普通文件".into());
    }
    if !crate::paths::path_within(
        &target_canon.to_string_lossy(),
        &root_canon.to_string_lossy(),
    ) {
        return Err("路径越界，拒绝访问".into());
    }
    Ok(target_canon)
}

fn build_overview_payload(project_root: &str) -> Result<serde_json::Value, String> {
    let ov = crate::assistant_state::project_overview(project_root)?;
    let all_help = crate::help_requests::list_help_requests_sync();
    let mut help_items = Vec::new();
    for h in all_help {
        if !crate::paths::same_path(&h.repo_path, project_root) {
            continue;
        }
        let where_label = h
            .workspace_name
            .as_deref()
            .map(|w| format!("工作副本「{w}」"))
            .unwrap_or_else(|| "项目根".to_string());
        for item in h.items {
            if item.answer.is_some() {
                continue;
            }
            help_items.push(serde_json::json!({
                "root": h.root,
                "itemId": item.id,
                "whereLabel": where_label,
                "question": item.question,
                "recommend": item.recommend,
                "options": item.options,
            }));
        }
    }
    let grant_items: Vec<serde_json::Value> =
        crate::scheduler::list_grant_requests_sync(Some(project_root))
            .into_iter()
            .map(|g| {
                serde_json::json!({
                    "scheduleId": g.schedule_id,
                    "scheduleName": g.schedule_name,
                    "at": g.at,
                    "blocked": g.blocked,
                })
            })
            .collect();
    let mut val = serde_json::to_value(&ov).map_err(|e| e.to_string())?;
    if let Some(obj) = val.as_object_mut() {
        obj.insert("helpItems".to_string(), serde_json::Value::Array(help_items));
        obj.insert("grantItems".to_string(), serde_json::Value::Array(grant_items));
    }
    Ok(val)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffSourceDto {
    id: String,
    label: String,
    has_changes: bool,
}

fn git_diff_for_dir(git_bin: &Path, dir: &Path, fallback_last_commit: bool) -> (String, bool) {
    let mut cmd = crate::process::background_command(git_bin);
    cmd.current_dir(dir)
        .args(["diff", "--no-color", "--stat=80", "-p", "HEAD"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut text = cmd
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let has_uncommitted = !text.trim().is_empty();
    if !has_uncommitted && fallback_last_commit {
        let mut cmd2 = crate::process::background_command(git_bin);
        cmd2.current_dir(dir)
            .args(["show", "--no-color", "--stat=80", "-p", "HEAD"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Ok(o2) = cmd2.output() {
            if o2.status.success() {
                text = String::from_utf8_lossy(&o2.stdout).into_owned();
            }
        }
    }
    (text, has_uncommitted)
}

fn git_worktree_has_changes(git_bin: &Path, dir: &Path) -> bool {
    let mut cmd = crate::process::background_command(git_bin);
    cmd.current_dir(dir)
        .args(["status", "--porcelain", "-uno"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd.output()
        .ok()
        .is_some_and(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
}

/// 读取主仓或活跃步骤/目标工作副本的 Git Diff（脱敏后返回），默认优先落到有改动的活跃工作副本
fn read_project_git_diff(
    project_root: &str,
    scope: Option<&str>,
) -> Result<(String, Vec<DiffSourceDto>, String), String> {
    let git_bin = crate::agents::resolve_binary("git").unwrap_or_else(|| PathBuf::from("git"));
    let main_dir = PathBuf::from(project_root);
    let mut candidates: Vec<(String, String, PathBuf, bool)> = vec![(
        "main".into(),
        "主仓库".into(),
        main_dir.clone(),
        git_worktree_has_changes(&git_bin, &main_dir),
    )];

    if let Ok(ov) = crate::assistant_state::project_overview(project_root) {
        for step in ov.steps {
            if let Some(wt) = step.worktree_path {
                let p = PathBuf::from(&wt);
                if p.is_dir() && !crate::paths::same_path(&wt, project_root) {
                    let id = format!("step:{}", step.n);
                    let label = format!("第 {} 步 · {}", step.n, step.name);
                    let dirty = git_worktree_has_changes(&git_bin, &p);
                    candidates.push((id, label, p, dirty));
                }
            }
        }
        for goal in ov.goals {
            if let Some(iso) = goal.isolation_path {
                let p = PathBuf::from(&iso);
                if p.is_dir() && !crate::paths::same_path(&iso, project_root) {
                    let id = format!("goal:{}", goal.id);
                    let label = format!("目标 · {}", goal.name);
                    let dirty = git_worktree_has_changes(&git_bin, &p);
                    candidates.push((id, label, p, dirty));
                }
            }
        }
    }

    let picked_idx = if let Some(req_scope) = scope.map(str::trim).filter(|s| !s.is_empty()) {
        candidates
            .iter()
            .position(|(id, _, _, _)| id == req_scope)
            .unwrap_or(0)
    } else {
        // 默认优先挑有未提交改动的步骤/目标工作副本，其次主仓库
        candidates
            .iter()
            .skip(1)
            .position(|(_, _, _, dirty)| *dirty)
            .map(|i| i + 1)
            .unwrap_or(0)
    };

    let active_id = candidates[picked_idx].0.clone();
    let target_dir = candidates[picked_idx].2.clone();
    let (raw_text, _) = git_diff_for_dir(&git_bin, &target_dir, true);
    let clipped: String = raw_text.chars().take(MAX_DIFF_CHARS).collect();
    let redacted = crate::sessions::redact_sensitive_text(&clipped);
    let sources = candidates
        .into_iter()
        .map(|(id, label, _, has_changes)| DiffSourceDto {
            id,
            label,
            has_changes,
        })
        .collect();
    Ok((redacted, sources, active_id))
}

fn is_https_request(rq: &tiny_http::Request) -> bool {
    if header_val(rq, "X-Forwarded-Proto")
        .is_some_and(|p| p.trim().eq_ignore_ascii_case("https"))
    {
        return true;
    }
    if header_val(rq, "Cf-Visitor")
        .is_some_and(|v| v.to_lowercase().contains("https"))
    {
        return true;
    }
    let cfg = load_config();
    if matches!(cfg.tunnel_mode.as_str(), "cloudflare" | "tailscale") {
        if let Some(host) = header_val(rq, "Host") {
            let h = host.to_lowercase();
            if !h.starts_with("127.0.0.1") && !h.starts_with("localhost") {
                return true;
            }
        }
    }
    cfg.custom_base_url.to_lowercase().starts_with("https://")
        && header_val(rq, "Host").is_some_and(|h| !h.starts_with("127.0.0.1") && !h.starts_with("localhost"))
}

fn render_themed_index_html() -> Vec<u8> {
    let mode = if crate::settings::is_light_theme_sync() {
        "light"
    } else {
        "dark"
    };
    PAGE_HTML
        .replacen(
            "<html lang=\"zh-CN\">",
            &format!("<html lang=\"zh-CN\" data-theme=\"{mode}\">"),
            1,
        )
        .into_bytes()
}

// ===== HTTP 请求路由分发 =====

fn handle_request(sess: Arc<RunningServer>, mut rq: tiny_http::Request) {
    let method = rq.method().as_str().to_uppercase();
    let (path, query) = parse_url_parts(rq.url());

    // 1. 静态 PWA 资源与配对落地页（免登录）
    if method == "GET" {
        match path.as_str() {
            "/" | "/pair" => {
                let _ = rq.respond(reply_bytes(200, "text/html; charset=utf-8", render_themed_index_html(), Some(PAGE_CSP), &[]));
                return;
            }
            "/app.js" => {
                let _ = rq.respond(reply_bytes(200, "application/javascript; charset=utf-8", PAGE_JS.as_bytes().to_vec(), None, &[]));
                return;
            }
            "/app.css" => {
                let _ = rq.respond(reply_bytes(200, "text/css; charset=utf-8", PAGE_CSS.as_bytes().to_vec(), None, &[]));
                return;
            }
            "/manifest.webmanifest" => {
                let _ = rq.respond(reply_bytes(200, "application/manifest+json; charset=utf-8", PAGE_MANIFEST.as_bytes().to_vec(), None, &[]));
                return;
            }
            "/icon.svg" => {
                let _ = rq.respond(reply_bytes(200, "image/svg+xml", PAGE_ICON.as_bytes().to_vec(), Some("default-src 'none'"), &[]));
                return;
            }
            "/apple-touch-icon.png" => {
                let _ = rq.respond(reply_bytes(
                    200,
                    "image/png",
                    PAGE_APPLE_ICON_PNG.to_vec(),
                    None,
                    &[("Cache-Control", "public, max-age=86400")],
                ));
                return;
            }
            "/icon-512.png" => {
                let _ = rq.respond(reply_bytes(
                    200,
                    "image/png",
                    PAGE_ICON_PNG.to_vec(),
                    None,
                    &[("Cache-Control", "public, max-age=86400")],
                ));
                return;
            }
            _ => {}
        }
    }

    // 2. 一次性配对码换取 HttpOnly 设备 Cookie
    if method == "POST" && path == "/api/pair" {
        let body = match read_json_body(&mut rq) {
            Ok(b) => b,
            Err(e) => {
                let _ = rq.respond(reply_err(400, &e));
                return;
            }
        };
        let supplied = body.get("token").and_then(|v| v.as_str()).unwrap_or("").trim();
        let dev_name = body
            .get("deviceName")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("移动设备")
            .chars()
            .take(40)
            .collect::<String>();

        let valid = {
            let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            match rt.pairing.as_ref() {
                Some(p) if Instant::now() < p.expires_at && ct_eq(&p.token, supplied) => {
                    rt.pairing = None; // 一次性配对码用完即废
                    true
                }
                _ => false,
            }
        };
        if !valid {
            let _ = rq.respond(reply_err(403, "配对码已过期或无效，请在电脑端重新生成二维码"));
            return;
        }
        let dev_token = new_random_token();
        let csrf = csrf_for_token(&dev_token);
        let now = chrono::Local::now().to_rfc3339();
        let dev = MobileDevice {
            id: uuid::Uuid::new_v4().simple().to_string(),
            name: dev_name.clone(),
            token_hash: sha256_hex(&dev_token),
            paired_at: now.clone(),
            last_seen_at: now,
        };
        let saved = with_config_mut(|cfg| {
            if cfg.devices.len() >= MAX_DEVICES {
                return Err(format!("最多只能配对 {MAX_DEVICES} 台设备，请先在电脑端移除旧设备"));
            }
            cfg.devices.push(dev);
            Ok(())
        });
        if let Err(e) = saved {
            let _ = rq.respond(reply_err(409, &e));
            return;
        }
        if let Some(ref app) = sess.app {
            let _ = app.emit("mobile-workbench-status", ());
        }
        let secure = if is_https_request(&rq) { "; Secure" } else { "" };
        let cookie = format!("{COOKIE_NAME}={dev_token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000{secure}");
        let payload = serde_json::to_vec(&serde_json::json!({
            "ok": true,
            "csrfToken": csrf,
            "deviceName": dev_name,
        }))
        .unwrap_or_default();
        let _ = rq.respond(reply_bytes(
            200,
            "application/json; charset=utf-8",
            payload,
            None,
            &[("Set-Cookie", &cookie)],
        ));
        return;
    }

    // 3. 以下全部需要已配对设备 Cookie
    let Some((device, dev_token)) = authenticate(&rq) else {
        let _ = rq.respond(reply_err(401, "未配对或登录已失效"));
        return;
    };
    touch_device_last_seen(&device.id);

    // 全部 POST 写接口强制校验 CSRF + Origin
    if method == "POST" {
        if let Err(e) = check_csrf_and_origin(&rq, &dev_token, sess.port) {
            let _ = rq.respond(reply_err(403, &e));
            return;
        }
    }

    match (method.as_str(), path.as_str()) {
        ("GET", "/api/me") => {
            let mode = if crate::settings::is_light_theme_sync() { "light" } else { "dark" };
            let _ = rq.respond(reply_json(
                200,
                serde_json::json!({
                    "ok": true,
                    "deviceId": device.id,
                    "deviceName": device.name,
                    "csrfToken": csrf_for_token(&dev_token),
                    "theme": mode,
                }),
            ));
        }
        ("POST", "/api/logout") => {
            let _ = with_config_mut(|cfg| {
                cfg.devices.retain(|d| d.id != device.id);
                Ok(())
            });
            if let Some(ref app) = sess.app {
                let _ = app.emit("mobile-workbench-status", ());
            }
            let cookie = format!("{COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
            let _ = rq.respond(reply_bytes(
                200,
                "application/json; charset=utf-8",
                b"{\"ok\":true}".to_vec(),
                None,
                &[("Set-Cookie", &cookie)],
            ));
        }
        ("GET", "/api/projects") => {
            let mut list = registered_projects();
            list.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
            let all_help = crate::help_requests::list_help_requests_sync();
            let all_grants = crate::scheduler::list_grant_requests_sync(None);
            let projects: Vec<serde_json::Value> = list
                .into_iter()
                .map(|p| {
                    let help_count: usize = all_help
                        .iter()
                        .filter(|h| crate::paths::same_path(&h.repo_path, &p.path))
                        .flat_map(|h| h.items.iter())
                        .filter(|it| it.answer.is_none())
                        .count();
                    let grant_count: usize = all_grants
                        .iter()
                        .filter(|g| crate::paths::same_path(&g.project_root, &p.path))
                        .count();
                    serde_json::json!({
                        "path": p.path,
                        "name": p.name,
                        "workMode": p.work_mode,
                        "helpCount": help_count + grant_count,
                    })
                })
                .collect();
            let _ = rq.respond(reply_json(200, serde_json::json!({ "projects": projects })));
        }
        ("GET", "/api/project/overview") => {
            let Some(proj) = query.get("project") else {
                let _ = rq.respond(reply_err(400, "缺少 project 参数"));
                return;
            };
            let Ok(p) = verify_registered_project(proj) else {
                let _ = rq.respond(reply_err(403, "未登记的项目"));
                return;
            };
            match build_overview_payload(&p.path) {
                Ok(v) => {
                    let _ = rq.respond(reply_json(200, v));
                }
                Err(e) => {
                    let _ = rq.respond(reply_err(500, &e));
                }
            }
        }
        ("GET", "/api/project/step") => {
            let Some(proj) = query.get("project") else {
                let _ = rq.respond(reply_err(400, "缺少 project 参数"));
                return;
            };
            let step_n = query.get("step").and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            let Ok(p) = verify_registered_project(proj) else {
                let _ = rq.respond(reply_err(403, "未登记的项目"));
                return;
            };
            match crate::assistant_state::step_detail(&p.path, step_n) {
                Ok(d) => {
                    let _ = rq.respond(reply_json(200, serde_json::to_value(d).unwrap_or_default()));
                }
                Err(e) => {
                    let _ = rq.respond(reply_err(400, &e));
                }
            }
        }
        ("GET", "/api/assistant/history") => {
            let Some(proj) = query.get("project") else {
                let _ = rq.respond(reply_err(400, "缺少 project 参数"));
                return;
            };
            let Ok(p) = verify_registered_project(proj) else {
                let _ = rq.respond(reply_err(403, "未登记的项目"));
                return;
            };
            match crate::project_assistant::assistant_log_read_sync(&p.path) {
                Ok(turns) => {
                    let _ = rq.respond(reply_json(200, serde_json::json!({ "turns": turns })));
                }
                Err(e) => {
                    let _ = rq.respond(reply_err(500, &e));
                }
            }
        }
        ("POST", "/api/assistant/chat") => {
            let body = match read_json_body(&mut rq) {
                Ok(b) => b,
                Err(e) => {
                    let _ = rq.respond(reply_err(400, &e));
                    return;
                }
            };
            let proj = body.get("projectRoot").and_then(|v| v.as_str()).unwrap_or("");
            let question = body.get("question").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let stream_id = body
                .get("streamId")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let Ok(p) = verify_registered_project(proj) else {
                let _ = rq.respond(reply_err(403, "未登记的项目"));
                return;
            };
            if question.is_empty() {
                let _ = rq.respond(reply_err(400, "先写要问什么"));
                return;
            }
            let profiles = sess
                .app
                .as_ref()
                .and_then(|a| a.state::<crate::profiles::ProfileStore>().list().ok())
                .unwrap_or_default();
            let (profile_id, model, connection) =
                crate::project_assistant::resolve_project_assistant_binding(&profiles, &p.path);
            let (tx, rx) = mpsc::channel::<Vec<u8>>();
            let app_clone = sess.app.clone();
            let project_path = p.path.clone();
            std::thread::spawn(move || {
                let mut on_update = |u: crate::project_assistant::StreamUpdate| {
                    if let Some(step) = u.step {
                        let _ = tx.send(sse_frame("step", &serde_json::json!({ "step": step })));
                    }
                    if let Some(text) = u.text {
                        let _ = tx.send(sse_frame("text", &serde_json::json!({ "text": text })));
                    }
                };
                let req = crate::project_assistant::ChatSyncReq {
                    profiles,
                    project_root: project_path,
                    profile_id,
                    model,
                    connection: Some(connection),
                    question,
                    where_label: Some("手机工作台（PWA）".into()),
                    focus_title: None,
                    focus_detail: None,
                    stream_id: Some(stream_id),
                    images: Vec::new(),
                    force_readonly: false,
                };
                match crate::project_assistant::chat_sync(req, Some(&mut on_update)) {
                    Ok(turn) => {
                        let _ = tx.send(sse_frame("done", &serde_json::json!({ "turn": turn })));
                        if let Some(ref app) = app_clone {
                            let _ = app.emit("mobile-workbench-assistant-updated", ());
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(sse_frame("error", &serde_json::json!({ "error": e })));
                    }
                }
            });
            let mut hs = security_headers("text/event-stream; charset=utf-8", None);
            if let Ok(h) = tiny_http::Header::from_bytes(&b"X-Accel-Buffering"[..], &b"no"[..]) {
                hs.push(h);
            }
            let resp = tiny_http::Response::new(
                tiny_http::StatusCode(200),
                hs,
                Box::new(ChannelReader::new(rx)) as Box<dyn Read + Send>,
                None,
                None,
            );
            let _ = rq.respond(resp);
        }
        ("POST", "/api/assistant/cancel") => {
            let body = read_json_body(&mut rq).unwrap_or_default();
            let sid = body.get("streamId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let ok = crate::project_assistant::project_assistant_cancel(sid);
            let _ = rq.respond(reply_json(200, serde_json::json!({ "ok": ok })));
        }
        ("POST", "/api/help/answer") => {
            let body = match read_json_body(&mut rq) {
                Ok(b) => b,
                Err(e) => {
                    let _ = rq.respond(reply_err(400, &e));
                    return;
                }
            };
            let root = body.get("root").and_then(|v| v.as_str()).unwrap_or("");
            let item_id = body.get("itemId").and_then(|v| v.as_str()).unwrap_or("");
            let answer = body.get("answer").and_then(|v| v.as_str()).unwrap_or("");
            let remember = body
                .get("remember")
                .and_then(|v| v.as_str())
                .filter(|s| matches!(*s, "已定" | "不做"));
            match crate::help_requests::answer_known_help_sync(root, item_id, answer, remember) {
                Ok(item) => {
                    if let Some(ref app) = sess.app {
                        let _ = app.emit("mobile-workbench-help-updated", ());
                    }
                    let _ = rq.respond(reply_json(200, serde_json::json!({ "ok": true, "item": item })));
                }
                Err(e) => {
                    let _ = rq.respond(reply_err(400, &e));
                }
            }
        }
        ("POST", "/api/grant/resolve") => {
            let body = match read_json_body(&mut rq) {
                Ok(b) => b,
                Err(e) => {
                    let _ = rq.respond(reply_err(400, &e));
                    return;
                }
            };
            let proj = body.get("projectRoot").and_then(|v| v.as_str()).unwrap_or("");
            let schedule_id = body.get("scheduleId").and_then(|v| v.as_str()).unwrap_or("").trim();
            let allow_once = body.get("allowOnce").and_then(|v| v.as_bool()).unwrap_or(false);
            let Ok(p) = verify_registered_project(proj) else {
                let _ = rq.respond(reply_err(403, "未登记的项目"));
                return;
            };
            if schedule_id.is_empty() {
                let _ = rq.respond(reply_err(400, "缺少定时任务标识"));
                return;
            }
            let res = if allow_once {
                let Some(ref app) = sess.app else {
                    let _ = rq.respond(reply_err(503, "桌面主窗口未就绪，无法重跑定时任务"));
                    return;
                };
                crate::scheduler::resolve_grant_once_sync(app.clone(), schedule_id, Some(&p.path))
                    .map(|name| format!("已批准「{name}」本次放宽并开始重跑"))
            } else {
                crate::scheduler::dismiss_grant_sync(schedule_id, Some(&p.path))
                    .map(|name| format!("已忽略「{name}」本次授权请求"))
            };
            match res {
                Ok(message) => {
                    if let Some(ref app) = sess.app {
                        let _ = app.emit("mobile-workbench-help-updated", ());
                    }
                    let _ = rq.respond(reply_json(200, serde_json::json!({ "ok": true, "message": message })));
                }
                Err(e) => {
                    let _ = rq.respond(reply_err(400, &e));
                }
            }
        }
        ("POST", "/api/memory/add") => {
            let body = match read_json_body(&mut rq) {
                Ok(b) => b,
                Err(e) => {
                    let _ = rq.respond(reply_err(400, &e));
                    return;
                }
            };
            let proj = body.get("projectRoot").and_then(|v| v.as_str()).unwrap_or("");
            let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
            let Ok(p) = verify_registered_project(proj) else {
                let _ = rq.respond(reply_err(403, "未登记的项目"));
                return;
            };
            match crate::project_memory::add_project_rule(Path::new(&p.path), text, "手机工作台确认") {
                Ok(()) => {
                    if let Some(ref app) = sess.app {
                        let _ = app.emit("mobile-workbench-assistant-updated", ());
                    }
                    let _ = rq.respond(reply_json(200, serde_json::json!({ "ok": true })));
                }
                Err(e) => {
                    let _ = rq.respond(reply_err(400, &e));
                }
            }
        }
        ("POST", "/api/dispatch") => {
            let body = match read_json_body(&mut rq) {
                Ok(b) => b,
                Err(e) => {
                    let _ = rq.respond(reply_err(400, &e));
                    return;
                }
            };
            let proj = body.get("projectRoot").and_then(|v| v.as_str()).unwrap_or("");
            let turn_at = body.get("turnAt").and_then(|v| v.as_str()).unwrap_or("").trim();
            let Ok(p) = verify_registered_project(proj) else {
                let _ = rq.respond(reply_err(403, "未登记的项目"));
                return;
            };
            if turn_at.is_empty() {
                let _ = rq.respond(reply_err(400, "缺少派活单标识"));
                return;
            }
            let Some(ref app) = sess.app else {
                let _ = rq.respond(reply_err(503, "桌面主窗口未就绪，无法执行派活"));
                return;
            };
            let req_id = uuid::Uuid::new_v4().simple().to_string();
            let (tx, rx) = mpsc::channel();
            pending_bridge()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(req_id.clone(), tx);
            let _ = app.emit(
                "mobile-workbench-dispatch",
                serde_json::json!({
                    "reqId": req_id,
                    "projectRoot": p.path,
                    "turnAt": turn_at,
                }),
            );
            let res = rx.recv_timeout(Duration::from_secs(20));
            pending_bridge()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&req_id);
            match res {
                Ok(Ok(note)) => {
                    let _ = rq.respond(reply_json(200, serde_json::json!({ "ok": true, "note": note })));
                }
                Ok(Err(e)) => {
                    let _ = rq.respond(reply_err(400, &e));
                }
                Err(_) => {
                    let _ = rq.respond(reply_err(504, "等待桌面执行派活超时，请确认 Mesa 主窗口处于运行状态"));
                }
            }
        }
        ("POST", "/api/drop/file") => {
            let Some(len) = rq.body_length().map(|n| n as u64) else {
                let _ = rq.respond(reply_err(411, "缺少 Content-Length"));
                return;
            };
            if len == 0 || len > MAX_UPLOAD_BYTES {
                let _ = rq.respond(reply_err(413, "文件为空或超过 100 MB 上限"));
                return;
            }
            let raw_name = header_val(&rq, "X-Mesa-Name")
                .map(|v| percent_decode(&v))
                .unwrap_or_else(|| "upload.bin".into());
            let target_project = header_val(&rq, "X-Mesa-Project")
                .map(|v| percent_decode(&v))
                .and_then(|proj| verify_registered_project(&proj).ok())
                .map(|p| (p.name, p.path));
            let mut bytes = Vec::with_capacity((len as usize).min(1024 * 1024));
            if rq
                .as_reader()
                .take(MAX_UPLOAD_BYTES + 1)
                .read_to_end(&mut bytes)
                .is_err()
                || bytes.len() as u64 != len
            {
                let _ = rq.respond(reply_err(400, "上传中断或长度不符"));
                return;
            }
            match crate::phone_drop::stage_external_file(sess.app.as_ref(), &raw_name, &bytes, target_project) {
                Ok(dto) => {
                    let _ = rq.respond(reply_json(200, serde_json::json!({ "ok": true, "item": dto })));
                }
                Err(e) => {
                    let _ = rq.respond(reply_err(500, &e));
                }
            }
        }
        ("POST", "/api/drop/text") => {
            let body = match read_json_body(&mut rq) {
                Ok(b) => b,
                Err(e) => {
                    let _ = rq.respond(reply_err(400, &e));
                    return;
                }
            };
            let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let target_project = body
                .get("projectRoot")
                .and_then(|v| v.as_str())
                .and_then(|proj| verify_registered_project(proj).ok())
                .map(|p| (p.name, p.path));
            match crate::phone_drop::stage_external_text(sess.app.as_ref(), text, target_project) {
                Ok(dto) => {
                    let _ = rq.respond(reply_json(200, serde_json::json!({ "ok": true, "item": dto })));
                }
                Err(e) => {
                    let _ = rq.respond(reply_err(400, &e));
                }
            }
        }
        ("GET", "/api/files/list") => {
            let Some(proj) = query.get("project") else {
                let _ = rq.respond(reply_err(400, "缺少 project 参数"));
                return;
            };
            let Ok(p) = verify_registered_project(proj) else {
                let _ = rq.respond(reply_err(403, "未登记的项目"));
                return;
            };
            let prefix = query.get("prefix").map(String::as_str);
            let q = query.get("query").map(String::as_str);
            match crate::assistant_state::list_files(&p.path, prefix, q, 120) {
                Ok(res) => {
                    let _ = rq.respond(reply_json(200, serde_json::to_value(res).unwrap_or_default()));
                }
                Err(e) => {
                    let _ = rq.respond(reply_err(500, &e));
                }
            }
        }
        ("GET", "/api/files/read") => {
            let (Some(proj), Some(rel)) = (query.get("project"), query.get("path")) else {
                let _ = rq.respond(reply_err(400, "缺少参数"));
                return;
            };
            let Ok(p) = verify_registered_project(proj) else {
                let _ = rq.respond(reply_err(403, "未登记的项目"));
                return;
            };
            let file_path = match resolve_safe_project_file(&p.path, rel) {
                Ok(fp) => fp,
                Err(e) => {
                    let _ = rq.respond(reply_err(403, &e));
                    return;
                }
            };
            let mut f = match fs::File::open(&file_path) {
                Ok(f) => f,
                Err(_) => {
                    let _ = rq.respond(reply_err(404, "读取文件失败"));
                    return;
                }
            };
            let mut buf = Vec::new();
            let _ = f.by_ref().take((MAX_TEXT_READ_BYTES + 1) as u64).read_to_end(&mut buf);
            let truncated = buf.len() > MAX_TEXT_READ_BYTES;
            if truncated {
                buf.truncate(MAX_TEXT_READ_BYTES);
            }
            let raw = String::from_utf8_lossy(&buf);
            let text = crate::sessions::redact_sensitive_text(&raw);
            let _ = rq.respond(reply_json(
                200,
                serde_json::json!({ "text": text, "truncated": truncated }),
            ));
        }
        ("GET", "/api/files/raw") => {
            let (Some(proj), Some(rel)) = (query.get("project"), query.get("path")) else {
                let _ = rq.respond(reply_err(400, "缺少参数"));
                return;
            };
            let Ok(p) = verify_registered_project(proj) else {
                let _ = rq.respond(reply_err(403, "未登记的项目"));
                return;
            };
            let file_path = match resolve_safe_project_file(&p.path, rel) {
                Ok(fp) => fp,
                Err(e) => {
                    let _ = rq.respond(reply_err(403, &e));
                    return;
                }
            };
            let ext = file_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let (mime, csp, disp) = match ext.as_str() {
                "png" => ("image/png", None, "inline"),
                "jpg" | "jpeg" => ("image/jpeg", None, "inline"),
                "webp" => ("image/webp", None, "inline"),
                "gif" => ("image/gif", None, "inline"),
                "svg" => ("image/svg+xml", Some("default-src 'none'; style-src 'unsafe-inline'"), "inline"),
                "pdf" => ("application/pdf", None, "inline"),
                "docx" => (
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    None,
                    "attachment",
                ),
                "pptx" => (
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    None,
                    "attachment",
                ),
                "xlsx" => (
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    None,
                    "attachment",
                ),
                _ => {
                    let _ = rq.respond(reply_err(415, "此文件类型不支持原始预览"));
                    return;
                }
            };
            let Ok(meta) = fs::metadata(&file_path) else {
                let _ = rq.respond(reply_err(404, "文件不存在"));
                return;
            };
            if meta.len() > MAX_RAW_READ_BYTES {
                let _ = rq.respond(reply_err(413, "文件超过 50 MB 预览上限"));
                return;
            }
            match fs::read(&file_path) {
                Ok(bytes) => {
                    let _ = rq.respond(reply_bytes(
                        200,
                        mime,
                        bytes,
                        csp,
                        &[("Content-Disposition", disp)],
                    ));
                }
                Err(_) => {
                    let _ = rq.respond(reply_err(500, "读取文件失败"));
                }
            }
        }
        ("GET", "/api/files/diff") => {
            let Some(proj) = query.get("project") else {
                let _ = rq.respond(reply_err(400, "缺少 project 参数"));
                return;
            };
            let Ok(p) = verify_registered_project(proj) else {
                let _ = rq.respond(reply_err(403, "未登记的项目"));
                return;
            };
            let scope = query.get("scope").map(String::as_str);
            match read_project_git_diff(&p.path, scope) {
                Ok((diff, sources, active_source)) => {
                    let _ = rq.respond(reply_json(
                        200,
                        serde_json::json!({
                            "diff": diff,
                            "sources": sources,
                            "activeSource": active_source,
                        }),
                    ));
                }
                Err(e) => {
                    let _ = rq.respond(reply_err(500, &e));
                }
            }
        }
        ("GET", "/api/events") => {
            let Some(proj) = query.get("project") else {
                let _ = rq.respond(reply_err(400, "缺少 project 参数"));
                return;
            };
            let Ok(p) = verify_registered_project(proj) else {
                let _ = rq.respond(reply_err(403, "未登记的项目"));
                return;
            };
            let (tx, rx) = mpsc::channel::<Vec<u8>>();
            let stop = sess.stop.clone();
            let path_owned = p.path.clone();
            std::thread::spawn(move || {
                let mut last_hash = String::new();
                while !stop.load(Ordering::Acquire) {
                    if let Ok(ov) = build_overview_payload(&path_owned) {
                        let serialized = serde_json::to_string(&ov).unwrap_or_default();
                        let h = sha256_hex(&serialized);
                        if h != last_hash {
                            last_hash = h;
                            if tx.send(sse_frame("overview", &ov)).is_err() {
                                break;
                            }
                        } else if tx.send(b": ping\n\n".to_vec()).is_err() {
                            break;
                        }
                    }
                    for _ in 0..50 {
                        if stop.load(Ordering::Acquire) {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            });
            let mut hs = security_headers("text/event-stream; charset=utf-8", None);
            if let Ok(h) = tiny_http::Header::from_bytes(&b"X-Accel-Buffering"[..], &b"no"[..]) {
                hs.push(h);
            }
            let resp = tiny_http::Response::new(
                tiny_http::StatusCode(200),
                hs,
                Box::new(ChannelReader::new(rx)) as Box<dyn Read + Send>,
                None,
                None,
            );
            let _ = rq.respond(resp);
        }
        _ => {
            let _ = rq.respond(reply_err(404, "未找到接口"));
        }
    }
}

// ===== 服务器生命周期 =====

fn start_server_locked(rt: &mut Runtime, app: Option<tauri::AppHandle>, desired_port: u16) -> Result<u16, String> {
    if let Some(ref existing) = rt.running {
        return Ok(existing.port);
    }
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, desired_port));
    let server = tiny_http::Server::http(addr)
        .or_else(|_| tiny_http::Server::http(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))))
        .map_err(|e| format!("启动本机 127.0.0.1 服务失败: {e}"))?;
    let actual_port = match server.server_addr() {
        tiny_http::ListenAddr::IP(sa) => sa.port(),
        #[allow(unreachable_patterns)]
        _ => desired_port,
    };
    let server = Arc::new(server);
    let stop = Arc::new(AtomicBool::new(false));
    #[cfg(test)]
    let test_config_root = crate::storage::config_root();
    let running = Arc::new(RunningServer {
        port: actual_port,
        stop: stop.clone(),
        server: server.clone(),
        app,
        managed_ts_port: Mutex::new(None),
        #[cfg(test)]
        test_config_root,
    });
    let worker_sess = running.clone();
    std::thread::spawn(move || {
        #[cfg(test)]
        let _accept_guard = worker_sess
            .test_config_root
            .as_deref()
            .map(crate::storage::redirect_config_root);
        while !worker_sess.stop.load(Ordering::Acquire) {
            match worker_sess.server.recv_timeout(Duration::from_millis(400)) {
                Ok(Some(rq)) => {
                    let s = worker_sess.clone();
                    std::thread::spawn(move || {
                        #[cfg(test)]
                        let _req_guard = s
                            .test_config_root
                            .as_deref()
                            .map(crate::storage::redirect_config_root);
                        handle_request(s, rq);
                    });
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
    });
    rt.running = Some(running);
    rt.last_error = None;
    Ok(actual_port)
}

fn stop_server_locked(rt: &mut Runtime) {
    stop_cloudflare_tunnel_locked(rt);
    if let Some(sess) = rt.running.take() {
        sess.stop.store(true, Ordering::Release);
        sess.server.unblock();
        if let Ok(mut mg) = sess.managed_ts_port.lock() {
            if let Some(ts_port) = mg.take() {
                let _ = apply_tailscale_serve(false, ts_port, sess.port);
            }
        }
    }
    rt.pairing = None;
    rt.last_serve_url = None;
}

fn current_status_sync() -> MobileWorkbenchStatusDto {
    let cfg = load_config();
    let ts = inspect_tailscale(cfg.tailscale_https_port);
    let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
    let (running, actual_port) = match rt.running.as_ref() {
        Some(s) => (true, s.port),
        None => (false, cfg.port),
    };
    let cf_url = rt.cloudflare.as_ref().map(|c| c.url.clone());
    let cf = inspect_cloudflare(cf_url.clone());
    rt.last_serve_url = if ts.serve_active { ts.serve_url.clone() } else { None };
    let local_url = (running && actual_port > 0).then(|| format!("http://127.0.0.1:{actual_port}"));
    let public_url = match cfg.tunnel_mode.as_str() {
        "cloudflare" => cf_url,
        "custom" => (!cfg.custom_base_url.is_empty()).then(|| cfg.custom_base_url.clone()),
        _ => {
            if ts.serve_active {
                ts.serve_url.clone()
            } else {
                None
            }
        }
    };
    let pair_base = public_url.as_ref().or(local_url.as_ref());
    let (pairing_url, pairing_qr_svg, pairing_left_secs) = match rt.pairing.as_ref() {
        Some(p) if Instant::now() < p.expires_at => {
            let left = p.expires_at.saturating_duration_since(Instant::now()).as_secs();
            let url = pair_base.map(|b| format!("{b}/pair?t={}", p.token));
            // 严禁把 127.0.0.1 编进手机二维码（手机扫 127.0.0.1 指向手机自身，必然连不上）；
            // 仅在外网加密通道（public_url）就绪后才生成二维码，未就绪时 pairing_url 仅供电脑本机浏览器点击预览
            let svg = if public_url.is_some() {
                url.as_deref().and_then(qr_svg)
            } else {
                None
            };
            (url, svg, left)
        }
        _ => (None, None, 0),
    };
    let devices = cfg
        .devices
        .into_iter()
        .map(|d| MobileDeviceDto {
            id: d.id,
            name: d.name,
            paired_at: d.paired_at,
            last_seen_at: d.last_seen_at,
        })
        .collect();
    MobileWorkbenchStatusDto {
        enabled: cfg.enabled,
        running,
        port: actual_port,
        local_url,
        tunnel_mode: cfg.tunnel_mode,
        tailscale_https_port: cfg.tailscale_https_port,
        custom_base_url: cfg.custom_base_url,
        public_url,
        devices,
        pairing_url,
        pairing_qr_svg,
        pairing_left_secs,
        cloudflare: cf,
        tailscale: ts,
        last_error: rt.last_error.clone(),
    }
}

/// 若用户上次开启了 Tailscale Serve，则按当前本机端口自动恢复映射并刷新缓存的公网地址（不持 Runtime 锁跑子进程）
fn maybe_restore_tailscale_serve(
    sess: &Arc<RunningServer>,
    cfg: &StoredConfig,
    actual_port: u16,
) {
    if cfg.tunnel_mode != "tailscale" || !cfg.tailscale_serve_wanted || actual_port == 0 {
        return;
    }
    match apply_tailscale_serve(true, cfg.tailscale_https_port, actual_port) {
        Ok(()) => {
            if let Ok(mut mg) = sess.managed_ts_port.lock() {
                *mg = Some(cfg.tailscale_https_port);
            }
            let ts = inspect_tailscale(cfg.tailscale_https_port);
            let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            rt.last_serve_url = if ts.serve_active { ts.serve_url } else { None };
            rt.last_error = None;
        }
        Err(e) => {
            let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            rt.last_error = Some(e);
        }
    }
}

/// 若用户上次开启了 Cloudflare 通道且本机已有 `cloudflared`，则在后台自动恢复隧道（不持 Runtime 锁）
fn maybe_restore_cloudflare_tunnel(
    app: Option<tauri::AppHandle>,
    cfg: &StoredConfig,
    actual_port: u16,
) {
    if cfg.tunnel_mode != "cloudflare" || !cfg.cloudflare_wanted || actual_port == 0 {
        return;
    }
    {
        let rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
        if rt
            .cloudflare
            .as_ref()
            .is_some_and(|c| c.local_port == actual_port)
        {
            return;
        }
    }
    let Some(bin) = resolve_cloudflared_binary() else {
        return;
    };
    match start_cloudflare_tunnel_sync(&bin, app, actual_port) {
        Ok(tunnel) => {
            let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            if rt.running.as_ref().is_some_and(|s| s.port == actual_port) {
                stop_cloudflare_tunnel_locked(&mut rt);
                rt.cloudflare = Some(tunnel);
                rt.last_error = None;
            } else {
                tunnel.stop.store(true, Ordering::Release);
                crate::pty::kill_process_tree(tunnel.pid);
                if let Ok(mut ch) = tunnel.child.lock() {
                    let _ = ch.kill();
                    let _ = ch.wait();
                }
            }
        }
        Err(e) => {
            let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            rt.last_error = Some(e);
        }
    }
}

/// 零阻塞获取当前可用的加密公网地址（供飞书通知卡片一键附带「在手机工作台打开」按钮）
fn current_public_url_fast() -> Option<String> {
    let cfg = load_config();
    if !cfg.enabled {
        return None;
    }
    let rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
    rt.running.as_ref()?;
    match cfg.tunnel_mode.as_str() {
        "cloudflare" => rt.cloudflare.as_ref().map(|c| c.url.clone()),
        "custom" => (!cfg.custom_base_url.is_empty()).then_some(cfg.custom_base_url),
        _ => rt.last_serve_url.clone(),
    }
}

/// 应用启动时若用户开启了手机工作台，则在后台启动 `127.0.0.1` 本地监听，并自动恢复上次开启的加密通道
pub(crate) fn start_at_setup(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let cfg = load_config();
        if !cfg.enabled {
            return;
        }
        let started: Option<(Arc<RunningServer>, u16)> = {
            let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            match start_server_locked(&mut rt, Some(app.clone()), cfg.port) {
                Ok(port) => {
                    if cfg.port == 0 {
                        let _ = with_config_mut(|c| {
                            c.port = port;
                            Ok(())
                        });
                    }
                    rt.running.clone().map(|s| (s, port))
                }
                Err(e) => {
                    rt.last_error = Some(e);
                    None
                }
            }
        };
        if let Some((sess, port)) = started {
            if cfg.tunnel_mode == "cloudflare" && cfg.cloudflare_wanted {
                maybe_restore_cloudflare_tunnel(Some(app.clone()), &cfg, port);
                let _ = app.emit("mobile-workbench-status", ());
            } else if cfg.tunnel_mode == "tailscale" && cfg.tailscale_serve_wanted {
                maybe_restore_tailscale_serve(&sess, &cfg, port);
                let _ = app.emit("mobile-workbench-status", ());
            } else if cfg.tunnel_mode == "tailscale" {
                // 即使本次非 Mesa 托管，也顺带探测一次已有 serve 地址供飞书卡片直跳
                let ts = inspect_tailscale(cfg.tailscale_https_port);
                let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
                rt.last_serve_url = if ts.serve_active { ts.serve_url } else { None };
            }
        }
    });
}

/// 应用退出时停止本地监听并清理 Mesa 自己挂接的 Cloudflare / Tailscale 通道
pub(crate) fn shutdown() {
    let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
    stop_server_locked(&mut rt);
}

// ===== Tauri 命令 =====

#[tauri::command]
pub async fn mobile_workbench_status() -> Result<MobileWorkbenchStatusDto, String> {
    tauri::async_runtime::spawn_blocking(current_status_sync)
        .await
        .map_err(|e| e.to_string())
}

/// 零阻塞返回当前手机工作台加密访问地址（未开启或隧道未就绪时为 None）
#[tauri::command]
pub async fn mobile_workbench_public_url() -> Option<String> {
    tauri::async_runtime::spawn_blocking(current_public_url_fast)
        .await
        .ok()
        .flatten()
}

#[tauri::command]
pub async fn mobile_workbench_set_config(
    app: tauri::AppHandle,
    enabled: bool,
    tunnel_mode: Option<String>,
    tailscale_https_port: Option<u16>,
    custom_base_url: Option<String>,
) -> Result<MobileWorkbenchStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let norm_custom = match custom_base_url {
            Some(ref raw) => Some(normalize_custom_url(raw)?),
            None => None,
        };
        let cfg_after = with_config_mut(|cfg| {
            cfg.enabled = enabled;
            if let Some(ref mode) = tunnel_mode {
                let next_mode = match mode.as_str() {
                    "cloudflare" => "cloudflare",
                    "custom" => "custom",
                    _ => "tailscale",
                };
                if cfg.tunnel_mode == "cloudflare" && next_mode != "cloudflare" {
                    cfg.cloudflare_wanted = false;
                }
                cfg.tunnel_mode = next_mode.to_string();
            }
            if let Some(p) = tailscale_https_port {
                if p >= 443 {
                    cfg.tailscale_https_port = p;
                }
            }
            if let Some(ref u) = norm_custom {
                cfg.custom_base_url = u.clone();
            }
            Ok(cfg.clone())
        })?;
        let started: Option<(Arc<RunningServer>, u16)> = {
            let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            if enabled {
                if cfg_after.tunnel_mode != "cloudflare" {
                    stop_cloudflare_tunnel_locked(&mut rt);
                }
                let port = start_server_locked(&mut rt, Some(app.clone()), cfg_after.port)?;
                if cfg_after.port == 0 {
                    let _ = with_config_mut(|c| {
                        c.port = port;
                        Ok(())
                    });
                }
                rt.running.clone().map(|s| (s, port))
            } else {
                stop_server_locked(&mut rt);
                None
            }
        };
        if let Some((sess, port)) = started {
            if cfg_after.tunnel_mode == "cloudflare" {
                maybe_restore_cloudflare_tunnel(Some(app.clone()), &cfg_after, port);
            } else {
                maybe_restore_tailscale_serve(&sess, &cfg_after, port);
            }
        }
        let _ = app.emit("mobile-workbench-status", ());
        Ok(current_status_sync())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mobile_workbench_cloudflare_tunnel(
    app: tauri::AppHandle,
    enable: bool,
) -> Result<MobileWorkbenchStatusDto, String> {
    if !enable {
        return tauri::async_runtime::spawn_blocking(move || {
            {
                let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
                stop_cloudflare_tunnel_locked(&mut rt);
                rt.last_error = None;
            }
            let _ = with_config_mut(|c| {
                c.cloudflare_wanted = false;
                Ok(())
            });
            let _ = app.emit("mobile-workbench-status", ());
            Ok(current_status_sync())
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    let local_port = {
        let rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
        rt.running.as_ref().map(|s| s.port).unwrap_or(0)
    };
    if local_port == 0 {
        return Err("请先开启手机工作台本机服务，再开启 Cloudflare 通道".into());
    }

    let bin = match resolve_cloudflared_binary() {
        Some(b) => b,
        None => install_cloudflared_async().await?,
    };

    tauri::async_runtime::spawn_blocking(move || {
        let already_ok = {
            let rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            rt.cloudflare
                .as_ref()
                .is_some_and(|c| c.local_port == local_port)
        };
        if !already_ok {
            {
                let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
                stop_cloudflare_tunnel_locked(&mut rt);
            }
            let tunnel = start_cloudflare_tunnel_sync(&bin, Some(app.clone()), local_port)?;
            let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            if rt.running.as_ref().is_some_and(|s| s.port == local_port) {
                rt.cloudflare = Some(tunnel);
                rt.last_error = None;
            } else {
                tunnel.stop.store(true, Ordering::Release);
                crate::pty::kill_process_tree(tunnel.pid);
                if let Ok(mut ch) = tunnel.child.lock() {
                    let _ = ch.kill();
                    let _ = ch.wait();
                }
                return Err("手机工作台已关闭，取消启动 Cloudflare 通道".into());
            }
        }
        let _ = with_config_mut(|c| {
            c.tunnel_mode = "cloudflare".into();
            c.cloudflare_wanted = true;
            Ok(())
        });
        let _ = app.emit("mobile-workbench-status", ());
        Ok(current_status_sync())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mobile_workbench_tailscale_serve(
    app: tauri::AppHandle,
    enable: bool,
) -> Result<MobileWorkbenchStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = load_config();
        let (local_port, sess_opt) = {
            let rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            (
                rt.running.as_ref().map(|s| s.port).unwrap_or(0),
                rt.running.clone(),
            )
        };
        if enable && local_port == 0 {
            return Err("请先开启手机工作台本机服务，再开启 Tailscale 通道".into());
        }
        apply_tailscale_serve(enable, cfg.tailscale_https_port, local_port)?;
        let _ = with_config_mut(|c| {
            c.tailscale_serve_wanted = enable;
            Ok(())
        });
        if let Some(sess) = sess_opt {
            if let Ok(mut mg) = sess.managed_ts_port.lock() {
                *mg = enable.then_some(cfg.tailscale_https_port);
            }
        }
        let _ = app.emit("mobile-workbench-status", ());
        Ok(current_status_sync())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mobile_workbench_pair_start(app: tauri::AppHandle) -> Result<MobileWorkbenchStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = load_config();
        if !cfg.enabled {
            return Err("请先开启手机工作台".into());
        }
        {
            let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            if rt.running.is_none() {
                let port = start_server_locked(&mut rt, Some(app.clone()), cfg.port)?;
                if cfg.port == 0 {
                    let _ = with_config_mut(|c| {
                        c.port = port;
                        Ok(())
                    });
                }
            }
            rt.pairing = Some(PairingState {
                token: new_pairing_token(),
                expires_at: Instant::now() + Duration::from_secs(PAIR_TTL_SECS),
            });
        }
        let _ = app.emit("mobile-workbench-status", ());
        Ok(current_status_sync())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mobile_workbench_pair_cancel(app: tauri::AppHandle) -> Result<MobileWorkbenchStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        {
            let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            rt.pairing = None;
        }
        let _ = app.emit("mobile-workbench-status", ());
        Ok(current_status_sync())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mobile_workbench_remove_device(
    app: tauri::AppHandle,
    device_id: String,
) -> Result<MobileWorkbenchStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_config_mut(|cfg| {
            cfg.devices.retain(|d| d.id != device_id);
            Ok(())
        })?;
        let _ = app.emit("mobile-workbench-status", ());
        Ok(current_status_sync())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn mobile_workbench_bridge_reply(req_id: String, ok: bool, message: String) {
    if let Some(tx) = pending_bridge()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&req_id)
    {
        let _ = tx.send(if ok { Ok(message) } else { Err(message) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tailscale_status_parser_distinguishes_https_ready_stopped_and_serve_active() {
        let stopped = r#"{"BackendState":"Stopped","Self":{"DNSName":""},"TailscaleIPs":null,"CertDomains":null}"#;
        let info = parse_tailscale_status_json(stopped, None, 8443, Some("/usr/local/bin/tailscale".into()));
        assert_eq!(info.backend_state, "Stopped");
        assert!(!info.https_ready);
        assert!(!info.serve_active);

        let running_no_https = r#"{"BackendState":"Running","Self":{"DNSName":"mac.tail123.ts.net."},"TailscaleIPs":["100.64.1.2"],"CertDomains":[]}"#;
        let info2 = parse_tailscale_status_json(running_no_https, None, 8443, None);
        assert!(info2.installed);
        assert!(!info2.https_ready);
        assert!(info2.hint.contains("HTTPS Certificates"));

        let running_ok = r#"{"BackendState":"Running","Self":{"DNSName":"mac.tail123.ts.net."},"TailscaleIPs":["100.64.1.2"],"CertDomains":["mac.tail123.ts.net"],"Peer":{"k1":{"OS":"iOS","Online":true},"k2":{"OS":"android","Online":false},"k3":{"OS":"macOS","Online":true}}}"#;
        let serve_on = r#"{"TCP":{"8443":{"HTTPS":true}}}"#;
        let info3 = parse_tailscale_status_json(running_ok, Some(serve_on), 8443, None);
        assert!(info3.https_ready);
        assert!(info3.serve_active);
        assert_eq!(info3.mobile_peers_total, 2);
        assert_eq!(info3.mobile_peers_online, 1);
        assert_eq!(info3.serve_url.as_deref(), Some("https://mac.tail123.ts.net:8443"));

        let no_mobile = r#"{"BackendState":"Running","Self":{"DNSName":"mac.tail123.ts.net."},"TailscaleIPs":["100.64.1.2"],"CertDomains":["mac.tail123.ts.net"],"Peer":{"k1":{"OS":"macOS","Online":true}}}"#;
        let info4 = parse_tailscale_status_json(no_mobile, Some(serve_on), 8443, None);
        assert_eq!(info4.mobile_peers_total, 0);
        assert_eq!(info4.mobile_peers_online, 0);
        assert!(info4.hint.contains("手机节点"));
    }

    #[test]
    fn extract_trycloudflare_url_strictly_matches_valid_quick_tunnel_domains() {
        assert_eq!(
            extract_trycloudflare_url("INF |  https://calm-river-lake-tree.trycloudflare.com  |").as_deref(),
            Some("https://calm-river-lake-tree.trycloudflare.com")
        );
        assert_eq!(
            extract_trycloudflare_url("前缀中文 https://other.example.com 以及 https://Abc-123.trycloudflare.com/").as_deref(),
            Some("https://abc-123.trycloudflare.com")
        );
        assert_eq!(extract_trycloudflare_url("http://calm-river.trycloudflare.com"), None);
        assert_eq!(extract_trycloudflare_url("https://a.b.trycloudflare.com"), None);
        assert_eq!(extract_trycloudflare_url("https://-bad.trycloudflare.com"), None);
        assert_eq!(extract_trycloudflare_url("https://trycloudflare.com"), None);
        assert_eq!(extract_trycloudflare_url("https://evil-trycloudflare.com"), None);
    }

    #[test]
    fn custom_url_rejects_plaintext_lan_and_allows_https_or_loopback() {
        assert!(normalize_custom_url("https://mesa.example.com/").unwrap() == "https://mesa.example.com");
        assert!(normalize_custom_url("http://127.0.0.1:17680").is_ok());
        assert!(normalize_custom_url("http://192.168.1.10:8080").is_err());
        assert!(normalize_custom_url("http://example.com").is_err());
    }

    #[test]
    fn safe_project_file_blocks_traversal_git_and_secret_files() {
        let tmp = std::env::temp_dir().join(format!("mesa-mw-file-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(tmp.join("notes")).unwrap();
        fs::write(tmp.join("notes/a.md"), "ok").unwrap();
        fs::write(tmp.join(".env"), "KEY=123").unwrap();
        fs::write(tmp.join("keys.json"), "{}").unwrap();
        let root = tmp.to_string_lossy().into_owned();

        assert!(resolve_safe_project_file(&root, "notes/a.md").is_ok());
        assert!(resolve_safe_project_file(&root, "../etc/passwd").is_err());
        assert!(resolve_safe_project_file(&root, "/etc/passwd").is_err());
        assert!(resolve_safe_project_file(&root, ".env").is_err());
        assert!(resolve_safe_project_file(&root, "keys.json").is_err());
        assert!(resolve_safe_project_file(&root, ".git/config").is_err());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn loopback_pairing_cookie_csrf_and_revocation_end_to_end() {
        use std::io::Write;
        use std::net::TcpStream;

        let tmp = std::env::temp_dir().join(format!("mesa-mw-e2e-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let _guard = crate::storage::redirect_config_root(&tmp);

        let port = {
            let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            stop_server_locked(&mut rt);
            let p = start_server_locked(&mut rt, None, 0).unwrap();
            rt.pairing = Some(PairingState {
                token: "testpairtoken123456".into(),
                expires_at: Instant::now() + Duration::from_secs(60),
            });
            p
        };

        let send_raw = |req: &str| -> String {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            s.write_all(req.as_bytes()).unwrap();
            let mut resp = String::new();
            let _ = s.read_to_string(&mut resp);
            resp
        };

        // 1. 未配对访问 /api/me 返回 401
        let r_unauth = send_raw("GET /api/me HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        assert!(r_unauth.starts_with("HTTP/1.1 401"), "got: {r_unauth}");

        // 2. 用正确配对码换取 HttpOnly Cookie + CSRF Token
        let body = r#"{"token":"testpairtoken123456","deviceName":"测试手机"}"#;
        let r_pair = send_raw(&format!(
            "POST /api/pair HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ));
        assert!(r_pair.starts_with("HTTP/1.1 200"), "got: {r_pair}");
        assert!(r_pair.contains("HttpOnly") && r_pair.contains("SameSite=Strict"));

        // 3. 配对码一次性作废：再试必须 403
        let r_replay = send_raw(&format!(
            "POST /api/pair HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ));
        assert!(r_replay.starts_with("HTTP/1.1 403"), "replay must fail: {r_replay}");

        // 提取 Cookie 与 csrfToken
        let cookie_line = r_pair
            .lines()
            .find(|l| l.to_lowercase().starts_with("set-cookie:"))
            .unwrap();
        let cookie_kv = cookie_line.split_once(':').unwrap().1.split(';').next().unwrap().trim();
        let json_body = r_pair.split_once("\r\n\r\n").unwrap().1;
        let parsed: serde_json::Value = serde_json::from_str(json_body).unwrap();
        let csrf = parsed["csrfToken"].as_str().unwrap();

        // 4. 带 Cookie 访问 /api/me 成功
        let r_me = send_raw(&format!(
            "GET /api/me HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nCookie: {cookie_kv}\r\nConnection: close\r\n\r\n"
        ));
        assert!(r_me.starts_with("HTTP/1.1 200") && r_me.contains("测试手机"));

        // 5. POST 缺少 CSRF Header 被 403 拦截
        let drop_body = r#"{"text":"一条测试灵感"}"#;
        let r_nocsrf = send_raw(&format!(
            "POST /api/drop/text HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nCookie: {cookie_kv}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{drop_body}",
            drop_body.len()
        ));
        assert!(r_nocsrf.starts_with("HTTP/1.1 403"), "missing CSRF must fail: {r_nocsrf}");

        // 6. 带合法 Cookie + CSRF 提交文字成功落暂存区
        let r_drop = send_raw(&format!(
            "POST /api/drop/text HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nCookie: {cookie_kv}\r\nX-Mesa-CSRF: {csrf}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{drop_body}",
            drop_body.len()
        ));
        assert!(r_drop.starts_with("HTTP/1.1 200"), "drop should succeed: {r_drop}");

        // 6b. 模拟 Tailscale Serve 代理头（X-Forwarded-Host）允许对应 HTTPS Origin，跨站恶意外源拒绝（403）
        let r_ts_ok = send_raw(&format!(
            "POST /api/drop/text HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Forwarded-Proto: https\r\nX-Forwarded-Host: mac.tail123.ts.net:8443\r\nOrigin: https://mac.tail123.ts.net:8443\r\nCookie: {cookie_kv}\r\nX-Mesa-CSRF: {csrf}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{drop_body}",
            drop_body.len()
        ));
        assert!(r_ts_ok.starts_with("HTTP/1.1 200"), "tailscale proxied origin must pass: {r_ts_ok}");

        let r_evil = send_raw(&format!(
            "POST /api/drop/text HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Forwarded-Proto: https\r\nX-Forwarded-Host: mac.tail123.ts.net:8443\r\nOrigin: https://evil.example.com\r\nCookie: {cookie_kv}\r\nX-Mesa-CSRF: {csrf}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{drop_body}",
            drop_body.len()
        ));
        assert!(r_evil.starts_with("HTTP/1.1 403"), "cross-site origin must 403: {r_evil}");

        // 7. PNG 主屏图标正常返回（iOS apple-touch-icon 必须为真 PNG）
        let mut s_icon = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s_icon.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        s_icon
            .write_all(format!("GET /apple-touch-icon.png HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").as_bytes())
            .unwrap();
        let mut icon_bytes = Vec::new();
        let _ = s_icon.read_to_end(&mut icon_bytes);
        let split = icon_bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&icon_bytes[..split]);
        assert!(head.starts_with("HTTP/1.1 200") && head.to_lowercase().contains("image/png"), "got: {head}");
        assert_eq!(&icon_bytes[split + 4..split + 8], b"\x89PNG");

        // 8. current_public_url_fast 零阻塞读取已启用公网地址，停用后立即返回 None
        with_config_mut(|c| {
            c.enabled = true;
            c.tunnel_mode = "custom".into();
            c.custom_base_url = "https://mesa.example.com".into();
            Ok(())
        })
        .unwrap();
        assert_eq!(current_public_url_fast().as_deref(), Some("https://mesa.example.com"));

        // 9. 移除设备后旧 Cookie 立即失效（401）
        with_config_mut(|c| {
            c.devices.clear();
            Ok(())
        })
        .unwrap();
        let r_revoked = send_raw(&format!(
            "GET /api/me HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nCookie: {cookie_kv}\r\nConnection: close\r\n\r\n"
        ));
        assert!(r_revoked.starts_with("HTTP/1.1 401"), "revoked cookie must 401: {r_revoked}");

        {
            let mut rt = runtime().lock().unwrap_or_else(|e| e.into_inner());
            stop_server_locked(&mut rt);
        }
        assert_eq!(current_public_url_fast(), None);
        let _ = fs::remove_dir_all(&tmp);
    }
}
