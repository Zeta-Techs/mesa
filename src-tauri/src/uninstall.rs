//! 一键卸载：把 Mesa 自己的数据移进系统回收站，并卸掉浏览器收货桥。
//!
//! 只动 Mesa 自己建的目录：配置目录 `ccode/`、主目录 `~/ccode/`（含用户自定义的家目录，工作区、工作树、
//! 快速开聊、复现记录）、本机数据目录 `ccode/task-runs`，以及这个应用身份留下的
//! 网页数据（界面记住的最近项目和偏好）。课题文件夹、各家 CLI 的配置与会话一律不动。
//! 应用本体由系统卸载（Mac 把 Mesa.app 拖进废纸篓）。

use std::path::{Path, PathBuf};

use serde::Serialize;

/// 打包身份。网页数据目录用它，不用展示名 Mesa。
const APP_ID: &str = "com.ccode.dev";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallResultDto {
    /// 已移入回收站的目录（绝对路径）
    pub trashed: Vec<String>,
    /// 本来就不存在，跳过
    pub missing: Vec<String>,
    /// 浏览器桥清单已删
    pub bridge_removed: Vec<String>,
    /// 某一步失败，其余继续
    pub errors: Vec<String>,
}

/// Mesa 独占的数据根。课题路径不在这里。
fn owned_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(cfg) = dirs::config_dir() {
        out.push(cfg.join("ccode"));
    }
    // 默认 ~/ccode 与用户自定义过的家目录（<所选目录>/ccode，名字恒为 ccode）
    for root in crate::ccode_home::all_roots() {
        if !out.iter().any(|p| p == &root) {
            out.push(root);
        }
    }
    if let Some(local) = dirs::data_local_dir() {
        out.push(local.join("ccode"));
    }
    if let Some(data) = dirs::data_dir() {
        let path = data.join("ccode");
        if !out.iter().any(|p| p == &path) {
            out.push(path);
        }
    }
    // 网页数据：界面记住的最近项目、页签和偏好。密钥不在这里。
    // macOS 实测落在 ~/Library/WebKit/<身份>；Windows 的 WebView2 用户数据
    // 落在本机数据目录的 <身份>/EBWebView。进程还开着时移走，退出前的最后一次
    // 写入有可能再建出来，所以说明里不承诺「一个字节都不留」。
    for path in webview_data_dirs() {
        if !out.iter().any(|p| p == &path) {
            out.push(path);
        }
    }
    out
}

/// 这个应用身份的网页数据目录。开发窗口是另一个身份，不在这里。
fn webview_data_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        if cfg!(target_os = "macos") {
            out.push(home.join("Library/WebKit").join(APP_ID));
            out.push(home.join("Library/Caches").join(APP_ID));
            out.push(
                home.join("Library/Saved Application State")
                    .join(format!("{APP_ID}.savedState")),
            );
        }
    }
    if cfg!(windows) {
        if let Some(local) = dirs::data_local_dir() {
            out.push(local.join(APP_ID).join("EBWebView"));
        }
    }
    out
}

fn bridge_manifests() -> Vec<PathBuf> {
    crate::browser_bridge::native_host_dirs()
        .into_iter()
        .map(|(_browser, dir)| dir.join(format!("{}.json", crate::browser_bridge::HOST_NAME)))
        .collect()
}

fn remove_windows_bridge_keys() -> Vec<String> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let mut errors = Vec::new();
    for (browser, _dir) in crate::browser_bridge::native_host_dirs() {
        let Some(key) = crate::browser_bridge::windows_bridge_reg_key(browser) else {
            continue;
        };
        let output = crate::process::background_command("reg")
            .args(["delete", &key, "/f"])
            .output();
        match output {
            Ok(out) if out.status.success() => {}
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                // 键本来就没有：不算失败
                if !stderr.to_lowercase().contains("unable to find")
                    && !stderr.contains("找不到")
                {
                    errors.push(format!("浏览器桥注册表未删除（{key}）"));
                }
            }
            Err(e) => errors.push(format!("浏览器桥注册表未删除（{key}）：{e}")),
        }
    }
    errors
}

fn trash_dir(path: &Path, result: &mut UninstallResultDto) {
    if !path.exists() {
        result.missing.push(path.to_string_lossy().into_owned());
        return;
    }
    match trash::delete(path) {
        Ok(()) => result.trashed.push(path.to_string_lossy().into_owned()),
        Err(e) => result
            .errors
            .push(format!("{} 没能移入回收站：{e}", path.display())),
    }
}

fn remove_file(path: &Path, result: &mut UninstallResultDto) {
    if !path.exists() {
        return;
    }
    match std::fs::remove_file(path) {
        Ok(()) => result
            .bridge_removed
            .push(path.to_string_lossy().into_owned()),
        Err(e) => result
            .errors
            .push(format!("{} 没能删除：{e}", path.display())),
    }
}

/// 卸载 Mesa 本机数据。调用方必须已经让用户确认过两次。
/// 成功后进程应退出：配置目录已经不在，继续跑会写出半套新数据。
#[tauri::command]
pub async fn uninstall_mesa() -> Result<UninstallResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = UninstallResultDto {
            trashed: Vec::new(),
            missing: Vec::new(),
            bridge_removed: Vec::new(),
            errors: Vec::new(),
        };
        for path in bridge_manifests() {
            remove_file(&path, &mut result);
        }
        result.errors.extend(remove_windows_bridge_keys());
        for root in owned_roots() {
            trash_dir(&root, &mut result);
        }
        crate::logbuf::record(
            "info",
            "uninstall",
            &format!(
                "卸载：回收站 {} 项，桥清单 {} 项，失败 {} 项",
                result.trashed.len(),
                result.bridge_removed.len(),
                result.errors.len()
            ),
        );
        Ok(result)
    })
    .await
    .map_err(|e| format!("卸载失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_roots_are_mesa_owned() {
        for path in owned_roots() {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let owned = name == "ccode"
                || name == APP_ID
                || name == "EBWebView"
                || name == format!("{APP_ID}.savedState");
            assert!(owned, "卸载碰到了不该动的目录：{}", path.display());
        }
    }

    #[test]
    fn bridge_manifests_match_install_side() {
        let expected: Vec<PathBuf> = crate::browser_bridge::native_host_dirs()
            .into_iter()
            .map(|(_browser, dir)| {
                dir.join(format!("{}.json", crate::browser_bridge::HOST_NAME))
            })
            .collect();
        assert_eq!(bridge_manifests(), expected);
        assert!(
            !expected.is_empty(),
            "安装侧没有清单目录时，卸载侧也不该另写一份"
        );
    }
}
