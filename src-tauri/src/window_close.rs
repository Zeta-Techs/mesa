//! 关窗与退出（2026-10-31 用户拍板）：关主窗口默认只把窗口藏起来，Mesa 留在后台
//! （Mac 程序坞图标还在、点它回来；Windows 收进托盘）；真正退出只走「退出 Mesa」
//! （Mac ⌘Q / 应用菜单、托盘菜单）。设置「关闭窗口时」可改回直接退出。
//!
//! 退出确认在前端做（它知道哪些对话的 AI 在跑）：这里发 `mesa:quit-requested`，前端立刻
//! `quit_ack`，问过人后 `confirm_quit`。前端没应（页面卡死 / 还没起来）就由这里兜底：
//! 只看后台任务，弹原生确认框。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// 前端接到这一轮退出请求的回执
static QUIT_ACK: AtomicBool = AtomicBool::new(false);
/// 兜底原生确认框开着时不再叠一个
static NATIVE_DIALOG_OPEN: AtomicBool = AtomicBool::new(false);
/// 前端多久不应就兜底
const ACK_TIMEOUT: Duration = Duration::from_millis(1500);

/// 主窗口的 CloseRequested（红绿灯、⇧⌘W、Windows 自绘 ×、Alt+F4）。别的窗口不经过这里
pub fn on_main_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    api.prevent_close();
    if crate::settings::close_to_background() {
        hide_main(window);
    } else {
        request_quit(window.app_handle());
    }
}

fn hide_main(window: &tauri::Window) {
    // Mac 全屏窗口直接 hide 会留下一整块黑屏空间：先退全屏，等系统动画走完再藏
    #[cfg(target_os = "macos")]
    if window.is_fullscreen().unwrap_or(false) {
        let _ = window.set_fullscreen(false);
        let window = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(800));
            let _ = window.hide();
        });
        return;
    }
    let _ = window.hide();
    #[cfg(windows)]
    first_hide_hint(window.app_handle());
}

/// Windows：第一次收进托盘时告诉人 Mesa 还在、去哪找（只提醒一次）
#[cfg(windows)]
fn first_hide_hint(app: &AppHandle) {
    if crate::settings::close_hint_shown() {
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("Mesa 仍在后台运行")
        .body("可从任务栏右下角的 Mesa 图标重新打开或退出")
        .show();
    if let Err(e) = crate::settings::mark_close_hint_shown() {
        crate::logbuf::record("warn", "window", &format!("收进托盘提示未记下: {e}"));
    }
}

/// 程序坞点图标 / 托盘「打开 Mesa」/ Windows 上再次打开 Mesa（单实例回调）：把主窗口叫回来
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 「退出 Mesa」的唯一入口：交前端确认，前端不应时兜底
pub fn request_quit(app: &AppHandle) {
    if app.get_webview_window("main").is_none() {
        app.exit(0);
        return;
    }
    QUIT_ACK.store(false, Ordering::Release);
    let _ = app.emit_to("main", "mesa:quit-requested", ());
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(ACK_TIMEOUT);
        if !QUIT_ACK.load(Ordering::Acquire) {
            native_quit_confirm(&app);
        }
    });
}

fn native_quit_confirm(app: &AppHandle) {
    let busy = crate::process::capture_count();
    if busy == 0 {
        app.exit(0);
        return;
    }
    if NATIVE_DIALOG_OPEN.swap(true, Ordering::AcqRel) {
        return;
    }
    use tauri_plugin_dialog::DialogExt;
    let app2 = app.clone();
    app.dialog()
        .message(format!("还有 {busy} 个后台任务在运行，退出会终止它们。确认退出？"))
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
        .show(move |ok| {
            NATIVE_DIALOG_OPEN.store(false, Ordering::Release);
            if ok {
                app2.exit(0);
            }
        });
}

#[tauri::command]
pub fn quit_ack() {
    QUIT_ACK.store(true, Ordering::Release);
}

/// 前端确认框要列的后台任务数（定时 / 无头运行等后台捕获）
#[tauri::command]
pub fn quit_background_count() -> usize {
    crate::process::capture_count()
}

/// 有东西在跑、要问人之前先把窗口叫出来（藏在后台时确认框没人看得见）
#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    show_main(&app);
}

/// 更新后重启前放掉单实例锁：relaunch 先起新进程再退旧进程，锁还在时新进程会把自己交给
/// 正在退出的旧进程然后退出，结果一个都不剩（Windows 装包后由安装包拉起、不走这里，Linux 走）
#[tauri::command]
pub fn release_single_instance(app: AppHandle) {
    #[cfg(any(windows, target_os = "linux"))]
    tauri_plugin_single_instance::destroy(&app);
    #[cfg(not(any(windows, target_os = "linux")))]
    let _ = app;
}

#[tauri::command]
pub fn confirm_quit(app: AppHandle) {
    app.exit(0);
}
