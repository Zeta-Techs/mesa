//! Windows 11 贴靠布局：去掉原生标题栏后，自绘的最大化按钮悬停不会弹系统的布局菜单
//! （系统只认原生标题栏的命中测试）。悬停够久时由这里替用户按一次 Win+Z——系统给当前前台窗口
//! 弹同一个布局菜单。只在 Windows 11、且 Mesa 是前台窗口时按；其余平台与 Windows 10 什么都不做。

/// 悬停最大化按钮够久后前端调用：弹出了返回 true
#[tauri::command]
pub fn window_show_snap_layouts(window: tauri::WebviewWindow) -> bool {
    #[cfg(windows)]
    {
        if !is_windows_11() || !window.is_focused().unwrap_or(false) {
            return false;
        }
        send_win_z()
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        false
    }
}

/// 布局菜单是 Windows 11（build 22000 起）的功能；Windows 10 的 Win+Z 不是这个意思，不能按
#[cfg(windows)]
fn is_windows_11() -> bool {
    use std::sync::OnceLock;
    static BUILD: OnceLock<u32> = OnceLock::new();
    *BUILD.get_or_init(|| {
        crate::process::background_command("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
                "/v",
                "CurrentBuildNumber",
            ])
            .output()
            .ok()
            .and_then(|o| parse_build_number(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or(0)
    }) >= 22000
}

/// `reg query` 输出里取 CurrentBuildNumber 的值（REG_SZ）；按列取，不认本地化文案
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn parse_build_number(out: &str) -> Option<u32> {
    out.lines()
        .find(|l| l.trim_start().starts_with("CurrentBuildNumber"))
        .and_then(|l| l.split_whitespace().last())
        .and_then(|v| v.parse().ok())
}

#[cfg(windows)]
fn send_win_z() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_LWIN, VK_Z,
    };
    let key = |vk: u16, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    // Win 先按后放、Z 夹在中间：Win 单独按放会弹开始菜单
    let inputs = [key(VK_LWIN, false), key(VK_Z, false), key(VK_Z, true), key(VK_LWIN, true)];
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    sent == inputs.len() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_number_from_reg_output() {
        let out = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\r\n    CurrentBuildNumber    REG_SZ    26200\r\n\r\n";
        assert_eq!(parse_build_number(out), Some(26200));
        assert_eq!(parse_build_number("错误: 找不到"), None);
    }
}
