//! 一键卸载：把 Mesa 自己的数据移进系统回收站，并卸掉浏览器收货桥。
//!
//! 只动 Mesa 自己建的目录：配置目录 `ccode/`、主目录 `~/ccode/`（含用户自定义的家目录，工作区、工作树、
//! 快速开聊、复现记录）、本机数据目录 `ccode/task-runs`，以及这个应用身份留下的
//! 网页数据（界面记住的最近项目和偏好）。课题文件夹、各家 CLI 的配置与会话一律不动，
//! 只收回 Mesa 自己放进去、又指向上面这些目录的东西：技能目录里指向技能库的软链、全局配置里的 hook 条目
//! （目录一移走它们就断了）。应用本体由系统卸载（Mac 把 Mesa.app 拖进废纸篓）。

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
    /// Mesa 运行期间被自身占用、只能退出后再删的目录（Windows 的 WebView2 网页数据）。
    /// 不算失败：调用方应在退出前把这些路径告诉用户
    pub deferred: Vec<String>,
}

/// Mesa 独占的数据根。课题路径不在这里。
fn owned_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(cfg) = crate::dirs::config_dir() {
        out.push(cfg.join("ccode"));
    }
    // 默认 ~/ccode 与用户自定义过的家目录（<所选目录>/ccode，名字恒为 ccode）
    for root in crate::ccode_home::all_roots() {
        if !out.iter().any(|p| p == &root) {
            out.push(root);
        }
    }
    if let Some(local) = crate::dirs::data_local_dir() {
        out.push(local.join("ccode"));
    }
    if let Some(data) = crate::dirs::data_dir() {
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
    if let Some(home) = crate::dirs::home_dir() {
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
        if let Some(local) = crate::dirs::data_local_dir() {
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

/// 注册表键是否存在：只看 `reg query` 退出码（0 在 / 1 不在）。不匹配 reg 的输出文本——
/// 中文 Windows 上那是 GBK，按 UTF-8 解出来是乱码，「找不到」永远匹配不上，
/// 曾把「键本来就没有」误报成「浏览器桥注册表未删除」。None = reg 本身跑不起来。
fn reg_key_exists(key: &str) -> Option<bool> {
    crate::process::background_command("reg")
        .args(["query", key])
        .output()
        .ok()
        .map(|out| out.status.success())
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
        match reg_key_exists(&key) {
            Some(false) => continue, // 键本来就没有：不算失败
            None => {
                errors.push(format!("浏览器桥注册表未删除（{key}）：无法运行 reg"));
                continue;
            }
            Some(true) => {}
        }
        let deleted = crate::process::background_command("reg")
            .args(["delete", &key, "/f"])
            .output();
        // 以删后复查为准：退出码之外不读任何本地化输出
        if reg_key_exists(&key) != Some(false) {
            let detail = match deleted {
                Err(e) => format!("：{e}"),
                Ok(_) => String::new(),
            };
            errors.push(format!("浏览器桥注册表未删除（{key}）{detail}"));
        }
    }
    errors
}

/// 某个数据根这次怎么处理（纯判定，便于测试）
#[derive(Debug, PartialEq, Eq)]
enum RootPlan {
    Trash,
    /// 运行中被 Mesa 自己占着，退出后才能删
    DeferUntilExit,
    /// 还有终端标签开在里面（Windows 删不掉进程所在目录），先关标签
    BlockedByTerminals(usize),
}

fn plan_root(is_windows: bool, is_webview_dir: bool, live_terminals_inside: usize) -> RootPlan {
    if !is_windows {
        return RootPlan::Trash; // macOS/Linux：打开着的目录照样能移走，行为不变
    }
    if is_webview_dir {
        RootPlan::DeferUntilExit
    } else if live_terminals_inside > 0 {
        RootPlan::BlockedByTerminals(live_terminals_inside)
    } else {
        RootPlan::Trash
    }
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
/// 移走过任何目录后进程都应退出，部分失败也一样：配置目录可能已经不在，继续跑会写出半套新数据。
#[tauri::command]
pub async fn uninstall_mesa() -> Result<UninstallResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let roots = owned_roots();
        let webview = webview_data_dirs();
        let plans: Vec<(PathBuf, RootPlan)> = roots
            .into_iter()
            .map(|root| {
                let plan = plan_root(
                    cfg!(windows),
                    webview.iter().any(|w| w == &root),
                    crate::pty::live_ptys_within(&root.to_string_lossy()),
                );
                (root, plan)
            })
            .collect();
        // 先整体预检再动手：配置目录一旦移走，应用不退出就会写出半套新数据，不能删一半停下
        let blocked: Vec<String> = plans
            .iter()
            .filter_map(|(root, plan)| match plan {
                RootPlan::BlockedByTerminals(n) => Some(format!("{}（{n} 个终端）", root.display())),
                _ => None,
            })
            .collect();
        if !blocked.is_empty() {
            return Err(format!(
                "还有终端标签开在 Mesa 的数据目录里，Windows 不能移走正在使用的目录：{}。\
                 请先在终端页关闭这些标签再卸载，这次什么都没动",
                blocked.join("、")
            ));
        }
        let mut result = UninstallResultDto {
            trashed: Vec::new(),
            missing: Vec::new(),
            bridge_removed: Vec::new(),
            errors: Vec::new(),
            deferred: Vec::new(),
        };
        for path in bridge_manifests() {
            remove_file(&path, &mut result);
        }
        result.errors.extend(remove_windows_bridge_keys());
        // 数据目录移走之前先收回指向它们的东西，否则各家 CLI 里留下断掉的技能链接与 hook 命令
        result.errors.extend(crate::skills::unlink_distributed_for_uninstall());
        result.errors.extend(crate::hooks::retract_all_for_uninstall());
        for (root, plan) in plans {
            match plan {
                RootPlan::DeferUntilExit if root.exists() => {
                    result.deferred.push(root.to_string_lossy().into_owned())
                }
                RootPlan::DeferUntilExit => {
                    result.missing.push(root.to_string_lossy().into_owned())
                }
                _ => trash_dir(&root, &mut result),
            }
        }
        crate::logbuf::record(
            "info",
            "uninstall",
            &format!(
                "卸载：回收站 {} 项，桥清单 {} 项，失败 {} 项，退出后待删 {} 项",
                result.trashed.len(),
                result.bridge_removed.len(),
                result.errors.len(),
                result.deferred.len()
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

    /// Windows：网页数据退出后再删、终端占着的目录整体拦下；其它平台一律照旧移入回收站
    #[test]
    fn plan_root_handles_windows_in_use_dirs() {
        assert_eq!(plan_root(false, true, 3), RootPlan::Trash);
        assert_eq!(plan_root(false, false, 2), RootPlan::Trash);
        assert_eq!(plan_root(true, true, 0), RootPlan::DeferUntilExit);
        assert_eq!(plan_root(true, false, 2), RootPlan::BlockedByTerminals(2));
        assert_eq!(plan_root(true, false, 0), RootPlan::Trash);
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
