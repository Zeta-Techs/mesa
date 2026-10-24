//! macOS 全屏切换的「开始」时刻：系统一开始放大 / 缩回动画就通知前端。
//!
//! 为什么要原生侧报：tao 的全屏状态（`is_fullscreen`）进全屏时在 willEnter 就翻、退全屏要等
//! didExit 动画放完才翻，前端只靠 onResized 轮询，退全屏时壳的实心底会撑完整段缩回动画，
//! 落地后再「啪」一下变回磨砂。这里订阅 NSWindow 的 will 两个通知，前端在动画开头就开始淡变，
//! 与系统动画同步走完（App.css `.ccode-app-shell[data-fullscreen-anim]`）。
//!
//! 只报不改：不碰窗口状态，失败只记日志——前端仍有 onResized 兜底，最多退回原来的硬切。

use tauri::Emitter;

/// 前端 `src/mac-titlebar.ts` 监听同名事件；载荷 true = 将进入全屏，false = 将退出。
pub const FULLSCREEN_WILL_CHANGE_EVENT: &str = "window:fullscreen-will-change";

pub fn observe(window: &tauri::WebviewWindow) {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSString};
    use std::ptr::NonNull;

    let ns_window = match window.ns_window() {
        Ok(p) if !p.is_null() => p as *mut AnyObject,
        _ => {
            crate::logbuf::record("warn", "window", "全屏过渡：拿不到 NSWindow，不订阅");
            return;
        }
    };
    let center = NSNotificationCenter::defaultCenter();
    // 通知名的字符串值就是常量名本身（AppKit 公开常量）
    for (name, entering) in [
        ("NSWindowWillEnterFullScreenNotification", true),
        ("NSWindowWillExitFullScreenNotification", false),
    ] {
        let win = window.clone();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            let _ = win.emit(FULLSCREEN_WILL_CHANGE_EVENT, entering);
        });
        // 主窗与应用同生命周期，不注销；令牌故意泄漏，不让它的释放牵动订阅
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(&NSString::from_str(name)),
                Some(&*ns_window),
                None,
                &block,
            )
        };
        std::mem::forget(token);
    }
}
