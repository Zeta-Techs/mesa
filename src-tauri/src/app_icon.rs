//! 应用图标外观（设置 → 外观 → 应用图标）：跟随系统 / 深色 / 浅色。
//!
//! Finder、启动台、开始菜单、安装包里的图标由打包资源决定（macOS 26+ 由 Assets.car 随系统外观
//! 切深浅，见 design-system「应用图标」），这里只换**运行中**的那一份：macOS 程序坞、
//! Windows/Linux 主窗（任务栏）与托盘。system = 不干预——macOS 打包运行时交还打包资源，
//! 其余情况（Windows/Linux、macOS 开发态裸二进制）用墨底版，与打包默认一致。

use tauri::image::Image;
use tauri::AppHandle;
#[cfg(not(target_os = "macos"))]
use tauri::Manager;

// include_image! 存原始像素进二进制，所以主窗/托盘只放 256 的撑满版
const WINDOW_DARK: Image<'static> = tauri::include_image!("icons/runtime/window-dark.png");
const WINDOW_LIGHT: Image<'static> = tauri::include_image!("icons/runtime/window-light.png");

#[cfg(target_os = "macos")]
const DOCK_DARK: &[u8] = include_bytes!("../icons/runtime/dock-dark.png");
#[cfg(target_os = "macos")]
const DOCK_LIGHT: &[u8] = include_bytes!("../icons/runtime/dock-light.png");

pub fn apply(app: &AppHandle, style: &str) {
    let window_icon = if style == "light" {
        WINDOW_LIGHT
    } else {
        WINDOW_DARK
    };
    if let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) {
        let _ = tray.set_icon(Some(window_icon.clone()));
    }
    // macOS 窗口没有自己的图标（程序坞才是），set_icon 在那边是空操作
    #[cfg(not(target_os = "macos"))]
    for window in app.webview_windows().values() {
        let _ = window.set_icon(window_icon.clone());
    }
    #[cfg(target_os = "macos")]
    set_dock_icon(app, style);
}

/// 启动时按设置挂一次。macOS 开发态 tauri 会在 RunEvent::Ready 自己设一次程序坞图标，
/// 所以 lib.rs 在 Ready 里再调一遍，压过它
pub fn apply_saved(app: &AppHandle) {
    let style = crate::settings::current_with_defaults()
        .app_icon_style
        .unwrap_or_else(|| "system".into());
    apply(app, &style);
}

#[cfg(target_os = "macos")]
fn running_from_bundle() -> bool {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn set_dock_icon(app: &AppHandle, style: &str) {
    // 打包运行时 system 交还 nil：系统按 CFBundleIconName 取 Assets.car，随外观切换。
    // 开发态是裸二进制，交还 nil 会变成通用可执行文件图标，改用墨底版
    let bytes: Option<&'static [u8]> = match style {
        "light" => Some(DOCK_LIGHT),
        "dark" => Some(DOCK_DARK),
        _ if running_from_bundle() => None,
        _ => Some(DOCK_DARK),
    };
    let _ = app.run_on_main_thread(move || unsafe {
        use objc2::runtime::AnyObject;
        let ns_app: *mut AnyObject =
            objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
        let image: *mut AnyObject = match bytes {
            Some(b) => {
                let data: *mut AnyObject = objc2::msg_send![
                    objc2::class!(NSData),
                    dataWithBytes: b.as_ptr() as *const std::ffi::c_void,
                    length: b.len()
                ];
                let alloc: *mut AnyObject = objc2::msg_send![objc2::class!(NSImage), alloc];
                objc2::msg_send![alloc, initWithData: data]
            }
            None => std::ptr::null_mut(),
        };
        let _: () = objc2::msg_send![ns_app, setApplicationIconImage: image];
        if !image.is_null() {
            // initWithData 返回 +1 引用，NSApp 已自行持有
            let _: () = objc2::msg_send![image, release];
        }
    });
}

#[tauri::command]
pub fn apply_app_icon(app: AppHandle, style: String) -> Result<(), String> {
    if !crate::settings::KNOWN_APP_ICON_STYLES.contains(&style.as_str()) {
        return Err(format!("未知的图标外观：{style}"));
    }
    apply(&app, &style);
    Ok(())
}
