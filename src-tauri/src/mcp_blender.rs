//! Blender 官方 MCP 本机安装探测（MCP 预设弹层用）。
//! 只读：不装软件、不改 Blender 配置。查不到的项标 missing，不假装完成。
//!
//! 插件是否在 Blender 里启用无法从 userpref.blend 可靠读出，只能看默认 TCP
//! 9876 是否在听（用户改过端口会漏检，弹层会说明）。

use serde::Serialize;
use std::fs;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MIN_MAJOR: u32 = 5;
const MIN_MINOR: u32 = 1;
const DEFAULT_PORT: u16 = 9876;
const TCP_TIMEOUT: Duration = Duration::from_millis(200);
const VERSION_PROBE_CAP: usize = 2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderMcpProbeItem {
    /// ok | missing | too_old | unknown
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderMcpProbeDto {
    pub blender: BlenderMcpProbeItem,
    pub addon: BlenderMcpProbeItem,
    pub uv: BlenderMcpProbeItem,
    pub repo: BlenderMcpProbeItem,
    pub running: BlenderMcpProbeItem,
}

fn item(status: &str, detail: Option<String>) -> BlenderMcpProbeItem {
    BlenderMcpProbeItem {
        status: status.into(),
        detail,
    }
}

fn missing() -> BlenderMcpProbeItem {
    item("missing", None)
}

fn ok(detail: impl Into<String>) -> BlenderMcpProbeItem {
    item("ok", Some(detail.into()))
}

fn parse_major_minor(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.split('.');
    let major = parts
        .next()?
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>();
    let minor = parts
        .next()?
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>();
    if major.is_empty() || minor.is_empty() {
        return None;
    }
    Some((major.parse().ok()?, minor.parse().ok()?))
}

/// `Blender 5.1.0` / 首行杂讯里抽出主.次版本。
pub(crate) fn parse_blender_version(text: &str) -> Option<(u32, u32)> {
    let idx = text.find("Blender")?;
    parse_major_minor(text[idx + "Blender".len()..].trim_start())
}

pub(crate) fn blender_version_ok(major: u32, minor: u32) -> bool {
    major > MIN_MAJOR || (major == MIN_MAJOR && minor >= MIN_MINOR)
}

/// 路径里带 `Blender 5.1` 这类名字时不必起进程。`Blender.app` 不命中。
pub(crate) fn version_from_path(path: &Path) -> Option<(u32, u32)> {
    let s = path.to_string_lossy();
    let mut rest = s.as_ref();
    while let Some(idx) = rest.find("Blender") {
        rest = &rest[idx + "Blender".len()..];
        let Some(sep) = rest.chars().next() else {
            break;
        };
        if sep == ' ' || sep == '_' || sep == '-' {
            if let Some(v) = parse_major_minor(&rest[sep.len_utf8()..]) {
                return Some(v);
            }
        }
    }
    None
}

pub(crate) fn manifest_is_official_mcp(text: &str) -> bool {
    let id = text.lines().any(|l| {
        let t = l.trim();
        t == "id = \"mcp\"" || t == "id = 'mcp'"
    });
    if !id {
        return false;
    }
    text.contains("blender_version_min") || text.contains("name = \"MCP\"")
}

pub(crate) fn repo_ready(mcp_dir: &Path) -> bool {
    mcp_dir.join("pyproject.toml").is_file() && mcp_dir.join("blmcp").is_dir()
}

fn blender_config_root() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return Some(
            crate::dirs::home_dir()?
                .join("Library")
                .join("Application Support")
                .join("Blender"),
        );
    }
    #[cfg(target_os = "windows")]
    {
        return Some(crate::dirs::data_dir()?.join("Blender Foundation").join("Blender"));
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Some(crate::dirs::home_dir()?.join(".config").join("blender"))
    }
}

fn walk_for_manifest(dir: &Path, depth: u8) -> bool {
    if depth == 0 {
        return false;
    }
    let Ok(rd) = fs::read_dir(dir) else {
        return false;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_file() && p.file_name().is_some_and(|n| n == "blender_manifest.toml") {
            if let Ok(text) = fs::read_to_string(&p) {
                if manifest_is_official_mcp(&text) {
                    return true;
                }
            }
        } else if p.is_dir() && walk_for_manifest(&p, depth.saturating_sub(1)) {
            return true;
        }
    }
    false
}

pub(crate) fn addon_installed_in(config_root: &Path) -> bool {
    let Ok(rd) = fs::read_dir(config_root) else {
        return false;
    };
    for e in rd.flatten() {
        let ver = e.path();
        if !ver.is_dir() {
            continue;
        }
        if walk_for_manifest(&ver.join("extensions"), 4) {
            return true;
        }
        let addons = ver.join("scripts").join("addons");
        if addons.join("blender_mcp_addon").is_dir() {
            return true;
        }
        if addons.join("mcp").join("blender_manifest.toml").is_file() {
            if let Ok(text) = fs::read_to_string(addons.join("mcp").join("blender_manifest.toml")) {
                if manifest_is_official_mcp(&text) {
                    return true;
                }
            }
        }
    }
    false
}

fn collect_blender_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut push = |p: PathBuf| {
        if p.is_file() && !out.iter().any(|x| x == &p) {
            out.push(p);
        }
    };
    if let Some(p) = crate::agents::resolve_binary("blender") {
        push(p);
    }
    #[cfg(target_os = "macos")]
    {
        let mut roots = vec![PathBuf::from("/Applications")];
        if let Some(h) = crate::dirs::home_dir() {
            roots.push(h.join("Applications"));
        }
        for root in roots {
            let Ok(rd) = fs::read_dir(&root) else {
                continue;
            };
            for e in rd.flatten() {
                let p = e.path();
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.starts_with("Blender") && name.ends_with(".app") {
                    let bin = p.join("Contents").join("MacOS").join("Blender");
                    push(bin);
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        for key in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(key) {
                let dir = PathBuf::from(root).join("Blender Foundation");
                let Ok(rd) = fs::read_dir(&dir) else {
                    continue;
                };
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        push(p.join("blender.exe"));
                    }
                }
            }
        }
    }
    out
}

fn probe_blender() -> BlenderMcpProbeItem {
    let candidates = collect_blender_candidates();
    if candidates.is_empty() {
        return missing();
    }
    let mut best_old: Option<(u32, u32, PathBuf)> = None;
    let mut unknown: Option<PathBuf> = None;
    let mut to_probe: Vec<PathBuf> = Vec::new();
    for p in candidates {
        if let Some((maj, min)) = version_from_path(&p) {
            if blender_version_ok(maj, min) {
                return ok(format!("{maj}.{min} · {}", p.display()));
            }
            match &best_old {
                Some((om, on, _)) if (maj, min) <= (*om, *on) => {}
                _ => best_old = Some((maj, min, p)),
            }
        } else {
            to_probe.push(p);
        }
    }
    for p in to_probe.into_iter().take(VERSION_PROBE_CAP) {
        if let Some(line) =
            crate::agents::version_with_timeout(&p, crate::agents::VERSION_QUERY_TIMEOUT)
        {
            if let Some((maj, min)) = parse_blender_version(&line) {
                if blender_version_ok(maj, min) {
                    return ok(format!("{maj}.{min} · {}", p.display()));
                }
                match &best_old {
                    Some((om, on, _)) if (maj, min) <= (*om, *on) => {}
                    _ => best_old = Some((maj, min, p)),
                }
                continue;
            }
        }
        unknown = Some(p);
    }
    if let Some((maj, min, p)) = best_old {
        return item(
            "too_old",
            Some(format!(
                "找到 Blender {maj}.{min}，官方 MCP 需要 5.1+ · {}",
                p.display()
            )),
        );
    }
    if let Some(p) = unknown {
        return item(
            "unknown",
            Some(format!("找到 Blender，未能确认是否 5.1+ · {}", p.display())),
        );
    }
    missing()
}

fn probe_addon() -> BlenderMcpProbeItem {
    let Some(root) = blender_config_root() else {
        return missing();
    };
    if addon_installed_in(&root) {
        ok(format!("{}", root.display()))
    } else {
        missing()
    }
}

fn probe_uv() -> BlenderMcpProbeItem {
    match crate::agents::resolve_binary("uv") {
        Some(p) => ok(format!("{}", p.display())),
        None => missing(),
    }
}

fn probe_repo() -> BlenderMcpProbeItem {
    let Some(home) = crate::dirs::home_dir() else {
        return missing();
    };
    let mcp_dir = home.join("blender_mcp").join("mcp");
    if repo_ready(&mcp_dir) {
        ok(format!("{}", mcp_dir.display()))
    } else {
        missing()
    }
}

fn probe_running() -> BlenderMcpProbeItem {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, DEFAULT_PORT));
    match TcpStream::connect_timeout(&addr, TCP_TIMEOUT) {
        Ok(_) => ok(format!("127.0.0.1:{DEFAULT_PORT}")),
        Err(_) => item(
            "missing",
            Some(format!(
                "默认端口 {DEFAULT_PORT} 未在听。若你在插件里改过端口，只要 Blender 开着即可"
            )),
        ),
    }
}

fn probe_sync() -> BlenderMcpProbeDto {
    BlenderMcpProbeDto {
        blender: probe_blender(),
        addon: probe_addon(),
        uv: probe_uv(),
        repo: probe_repo(),
        running: probe_running(),
    }
}

#[tauri::command]
pub async fn probe_blender_mcp_setup() -> Result<BlenderMcpProbeDto, String> {
    tauri::async_runtime::spawn_blocking(probe_sync)
        .await
        .map_err(|e| format!("检测 Blender MCP 安装失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_blender_version_reads_major_minor() {
        assert_eq!(
            parse_blender_version("Blender 5.1.0\nbuild date"),
            Some((5, 1))
        );
        assert_eq!(parse_blender_version("Blender 4.5.3"), Some((4, 5)));
        assert_eq!(parse_blender_version("not blender"), None);
    }

    #[test]
    fn blender_51_is_minimum() {
        assert!(!blender_version_ok(4, 5));
        assert!(!blender_version_ok(5, 0));
        assert!(blender_version_ok(5, 1));
        assert!(blender_version_ok(6, 0));
    }

    #[test]
    fn version_from_path_needs_separator() {
        assert_eq!(
            version_from_path(Path::new(
                "/Applications/Blender 5.1.app/Contents/MacOS/Blender"
            )),
            Some((5, 1))
        );
        assert_eq!(
            version_from_path(Path::new(
                r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
            )),
            Some((5, 2))
        );
        assert_eq!(
            version_from_path(Path::new(
                "/Applications/Blender.app/Contents/MacOS/Blender"
            )),
            None
        );
    }

    #[test]
    fn official_mcp_manifest_id() {
        let ok = "schema_version = \"1.0.0\"\nid = \"mcp\"\nname = \"MCP\"\nblender_version_min = \"5.1.0\"\n";
        assert!(manifest_is_official_mcp(ok));
        assert!(!manifest_is_official_mcp(
            "id = \"something\"\nname = \"MCP\"\n"
        ));
        assert!(!manifest_is_official_mcp("id = \"mcp-other\"\n"));
    }

    #[test]
    fn repo_ready_needs_pyproject_and_package() {
        let root = std::env::temp_dir().join(format!("ccode-blender-mcp-{}", uuid::Uuid::new_v4()));
        let mcp = root.join("mcp");
        fs::create_dir_all(mcp.join("blmcp")).unwrap();
        assert!(!repo_ready(&mcp));
        fs::write(
            mcp.join("pyproject.toml"),
            "[project]\nname = \"blender-mcp\"\n",
        )
        .unwrap();
        assert!(repo_ready(&mcp));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn addon_scan_finds_extension_manifest() {
        let root = std::env::temp_dir().join(format!("ccode-blender-cfg-{}", uuid::Uuid::new_v4()));
        let ext = root
            .join("5.1")
            .join("extensions")
            .join("blender_lab")
            .join("mcp");
        fs::create_dir_all(&ext).unwrap();
        fs::write(
            ext.join("blender_manifest.toml"),
            "id = \"mcp\"\nname = \"MCP\"\nblender_version_min = \"5.1.0\"\n",
        )
        .unwrap();
        assert!(addon_installed_in(&root));
        let _ = fs::remove_dir_all(&root);
    }
}
