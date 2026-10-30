//! 剪贴板图片落盘（终端粘贴图片 → 绝对路径写进 PTY，九家 CLI 通吃的输入方式）。
//! 前端 paste 事件拿到 image/* 字节后经本模块落盘到 <config>/ccode/tmp/paste-*，
//! 每次调用顺带清理 7 天前的残留文件。不引 arboard：读取剪贴板在前端完成，这里只存字节。

use std::path::PathBuf;

/// 单张图片上限 50MB（剪贴板截图通常 <5MB，防误传大对象拖垮 IPC/磁盘）
const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
/// 粘贴图片保留 7 天
const PASTE_TTL_SECS: i64 = 7 * 24 * 3600;

fn paste_dir() -> Result<PathBuf, String> {
    Ok(crate::dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("tmp"))
}

/// 扩展名白名单：前端按 MIME 映射后传入，这里再兜一层，非法一律 png
fn sanitize_ext(ext: &str) -> &str {
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" => ext,
        _ => "png",
    }
}

/// paste-* 且 mtime 早于截止时刻才算残留（其它文件绝不碰）
fn is_expired_paste(name: &str, mtime_secs: i64, now_secs: i64, ttl_secs: i64) -> bool {
    name.starts_with("paste-") && mtime_secs < now_secs - ttl_secs
}

/// 清理 dir 下的过期粘贴图片（失败静默：清理是顺带动作，不挡主流程）
fn cleanup_old(dir: &std::path::Path, ttl_secs: i64) {
    let now = chrono::Utc::now().timestamp();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        if let Some(m) = mtime {
            if is_expired_paste(&name.to_string_lossy(), m, now, ttl_secs) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// 扩展名放在这个请求头里（请求体是图片字节本身）
const EXT_HEADER: &str = "x-image-ext";

/// 保存剪贴板图片到临时目录，返回绝对路径（前端随后把路径写进 PTY）。
/// 字节按原样走 IPC（前端 `saveClipboardImage`）：按 JSON 数字数组传时，5MB 截图是 18.7MB 的 JSON，
/// 网页和 Rust 主线程各编解一遍，粘贴时界面整个卡住（2026-10-21）。落盘与顺带清理在后台线程
///（conventions/terminal.md「会等待的命令不占主线程」）
#[tauri::command]
pub async fn save_clipboard_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        // 自定义协议不通时 Tauri 退回 postMessage，请求体会变成 JSON 数字数组
        tauri::ipc::InvokeBody::Json(value) => serde_json::from_value(value.clone())
            .map_err(|_| "剪贴板图片数据格式不对".to_string())?,
    };
    let ext = request
        .headers()
        .get(EXT_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("png")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || save_image_bytes(&bytes, &ext))
        .await
        .map_err(|e| format!("保存剪贴板图片失败: {e}"))?
}

/// 文件名：paste-<yyyymmdd-hhmmss>-<短随机>.<ext>（同秒连贴防重名）
fn save_image_bytes(bytes: &[u8], ext: &str) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("剪贴板图片为空".into());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!("图片超过 50MB（{}MB）", bytes.len() / 1024 / 1024));
    }
    let dir = paste_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    cleanup_old(&dir, PASTE_TTL_SECS);
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    let name = format!(
        "paste-{}-{}.{}",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        &uuid[..8],
        sanitize_ext(ext),
    );
    let path = dir.join(&name);
    std::fs::write(&path, bytes).map_err(|e| format!("保存剪贴板图片失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_ext_whitelist() {
        assert_eq!(sanitize_ext("png"), "png");
        assert_eq!(sanitize_ext("jpg"), "jpg");
        assert_eq!(sanitize_ext("jpeg"), "jpeg");
        assert_eq!(sanitize_ext("gif"), "gif");
        assert_eq!(sanitize_ext("webp"), "webp");
        assert_eq!(sanitize_ext("bmp"), "png");
        assert_eq!(sanitize_ext("PNG"), "png");
        assert_eq!(sanitize_ext("../../etc/x"), "png");
    }

    #[test]
    fn expired_paste_judgement() {
        let now = 1_800_000_000;
        assert!(is_expired_paste(
            "paste-a.png",
            now - PASTE_TTL_SECS - 1,
            now,
            PASTE_TTL_SECS
        ));
        assert!(!is_expired_paste(
            "paste-a.png",
            now - PASTE_TTL_SECS + 1,
            now,
            PASTE_TTL_SECS
        ));
        assert!(!is_expired_paste("keep.txt", 1, now, PASTE_TTL_SECS));
    }

    #[test]
    fn cleanup_keeps_fresh_and_non_paste_files() {
        let dir = std::env::temp_dir().join(format!("ccode-clip-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fresh = dir.join("paste-new.png");
        let other = dir.join("keep.txt");
        std::fs::write(&fresh, b"x").unwrap();
        std::fs::write(&other, b"x").unwrap();

        cleanup_old(&dir, PASTE_TTL_SECS);

        assert!(fresh.exists());
        assert!(other.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 读系统剪贴板里的**文件**（Finder / 资源管理器复制后粘贴到终端 → 引号路径）。
/// WKWebView / WebView2 的 paste 事件都不给文件路径（安全限制），只能原生读：
/// - macOS：NSPasteboard 的 NSFilenamesPboardType（废弃但稳定，免引 objc2-foundation）
/// - Windows：CF_HDROP（OpenClipboard / GetClipboardData / DragQueryFileW）
/// - Linux：webkitgtk 无稳定通道，返回空（回落现状：粘贴无动作）
#[tauri::command]
pub fn read_clipboard_files() -> Result<Vec<String>, String> {
    Ok(native_clipboard_files())
}

#[cfg(target_os = "macos")]
fn native_clipboard_files() -> Vec<String> {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject};
    autoreleasepool(|_| unsafe {
        let cls = AnyClass::get(c"NSPasteboard").expect("NSPasteboard 应存在");
        let pb: *mut AnyObject = objc2::msg_send![cls, generalPasteboard];
        if pb.is_null() {
            return vec![];
        }
        let nsstring = AnyClass::get(c"NSString").expect("NSString 应存在");
        let ty: *mut AnyObject = objc2::msg_send![
            nsstring,
            stringWithUTF8String: c"NSFilenamesPboardType".as_ptr()
        ];
        let list: *mut AnyObject = objc2::msg_send![pb, propertyListForType: ty];
        if list.is_null() {
            return vec![];
        }
        let count: usize = objc2::msg_send![list, count];
        let mut out = Vec::new();
        for i in 0..count.min(64) {
            let item: *mut AnyObject = objc2::msg_send![list, objectAtIndex: i];
            if item.is_null() {
                continue;
            }
            let utf8: *const std::ffi::c_char = objc2::msg_send![item, UTF8String];
            if utf8.is_null() {
                continue;
            }
            if let Ok(path) = std::ffi::CStr::from_ptr(utf8).to_str() {
                if !path.is_empty() && !path.contains('\0') {
                    out.push(path.to_string());
                }
            }
        }
        out
    })
}

#[cfg(target_os = "windows")]
fn native_clipboard_files() -> Vec<String> {
    // CF_HDROP = 15（shellapi 常量，windows-sys 对应 feature 未导出该常量，字面量）
    const CF_HDROP: u32 = 15;
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows_sys::Win32::UI::Shell::DragQueryFileW;
    unsafe {
        // HWND 传空（0 的整数不能直接当 *mut c_void，类型不过——CI Windows 才编译这段）
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return vec![];
        }
        let mut out: Vec<String> = Vec::new();
        let handle = GetClipboardData(CF_HDROP);
        if !handle.is_null() {
            let count = DragQueryFileW(handle as *mut core::ffi::c_void, 0xFFFF_FFFF, std::ptr::null_mut(), 0);
            for i in 0..count.min(64) {
                let len = DragQueryFileW(handle as *mut core::ffi::c_void, i, std::ptr::null_mut(), 0);
                if len == 0 {
                    continue;
                }
                let mut buf = vec![0u16; len as usize + 1];
                let got = DragQueryFileW(handle as *mut core::ffi::c_void, i, buf.as_mut_ptr(), buf.len() as u32);
                if got > 0 {
                    if let Some(path) = String::from_utf16(&buf[..got as usize]).ok() {
                        if !path.is_empty() {
                            out.push(path);
                        }
                    }
                }
            }
        }
        CloseClipboard();
        out
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn native_clipboard_files() -> Vec<String> {
    vec![]
}
