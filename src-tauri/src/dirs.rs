//! 系统目录的唯一入口：家目录、AppData、文稿、下载、桌面。全部代码一律用 `crate::dirs::…`，
//! 不直接用 `dirs` crate（Cargo.toml 里改名成 `os_dirs`，直接写 `dirs::` 编译不过）。
//!
//! 平时与 `dirs` crate 完全相同。设了 `MESA_SANDBOX_HOME` 时（Windows 新用户沙盒，见 scripts/win-sandbox.sh），
//! 这些目录全部换到它下面：Windows 上 `dirs` 走已知文件夹 API，不看 HOME / USERPROFILE / APPDATA，
//! 只改环境变量换不掉 Mesa 自己读写的目录（配置、密钥、各 CLI 的会话与配置、新建项目的默认位置）。
//! macOS / Linux 上 `dirs` 本来就认 HOME（scripts/dev-sandbox.sh 改 HOME 即可），这个变量在那边不起作用。
//! 生产构建同样认它：沙盒点验的就是打出来的安装包。

use std::path::{Path, PathBuf};

/// 沙盒家目录（只在 Windows 上生效，空值当没设）
fn sandbox_home() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    std::env::var_os("MESA_SANDBOX_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// 有沙盒家目录就取它下面按 Windows 布局的子目录，否则取系统的
fn pick(home: Option<&Path>, sub: &str, system: fn() -> Option<PathBuf>) -> Option<PathBuf> {
    match home {
        Some(home) if sub.is_empty() => Some(home.to_path_buf()),
        Some(home) => Some(sub.split('/').fold(home.to_path_buf(), |p, part| p.join(part))),
        None => system(),
    }
}

pub fn home_dir() -> Option<PathBuf> {
    pick(sandbox_home().as_deref(), "", os_dirs::home_dir)
}

/// Windows：%APPDATA%（Roaming）
pub fn config_dir() -> Option<PathBuf> {
    pick(sandbox_home().as_deref(), "AppData/Roaming", os_dirs::config_dir)
}

/// Windows：%APPDATA%（Roaming，与 config_dir 同一处）
pub fn data_dir() -> Option<PathBuf> {
    pick(sandbox_home().as_deref(), "AppData/Roaming", os_dirs::data_dir)
}

/// Windows：%LOCALAPPDATA%
pub fn data_local_dir() -> Option<PathBuf> {
    pick(sandbox_home().as_deref(), "AppData/Local", os_dirs::data_local_dir)
}

pub fn document_dir() -> Option<PathBuf> {
    pick(sandbox_home().as_deref(), "Documents", os_dirs::document_dir)
}

pub fn download_dir() -> Option<PathBuf> {
    pick(sandbox_home().as_deref(), "Downloads", os_dirs::download_dir)
}

pub fn desktop_dir() -> Option<PathBuf> {
    pick(sandbox_home().as_deref(), "Desktop", os_dirs::desktop_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_home_maps_to_windows_layout() {
        let home = Path::new("C:/sb/home");
        assert_eq!(pick(Some(home), "", || None), Some(home.to_path_buf()));
        assert_eq!(
            pick(Some(home), "AppData/Roaming", || None),
            Some(home.join("AppData").join("Roaming"))
        );
        assert_eq!(pick(Some(home), "Documents", || None), Some(home.join("Documents")));
        // 没设沙盒：原样用系统的
        assert_eq!(pick(None, "Documents", || Some(PathBuf::from("/sys/docs"))), Some(PathBuf::from("/sys/docs")));
    }
}
