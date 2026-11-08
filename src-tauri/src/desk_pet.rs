//! 桌宠「小桌」（2026-11-09 用户拍板「按推荐全部做」）：桌面上一个透明、无边框、置顶的小窗，
//! 跨项目报信——有活在跑、有事等你、哪一步跑完等评审、哪里出错，点一下能就地答人工请求，
//! 其余「去看看」打开 Mesa 跳过去。默认关，设置 → 通用「桌宠」与托盘里开。
//!
//! 规则（设计稿 docs/design-desk-pet.md）：
//! - 桌宠是第三个出口，动作分级沿用 `src/assistant-ops.ts`（auto / tap / desktop），desktop 档只给「去看看」；
//! - 说的话由 Mesa 按记录生成，不经 AI；
//! - 清单由主窗口拼（desk-pet-host.ts，与项目助手「等你的事」、手机通道同一份取数，不在这里另判），
//!   发给小窗；小窗点的事经主窗口原路办。主窗口关着只是藏到后台，照常供数；
//! - 小窗只是外壳：关掉 / 退出 Mesa 时一起走，不单独常驻。

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const LABEL: &str = "desk-pet";

/// 小窗的「只有小桌」尺寸（逻辑像素）：小桌本身 + 四周一点余量，数字角标与拖动时的晃动不出界
fn compact_size(pet: f64) -> (f64, f64) {
    (pet + 24.0, pet + 24.0)
}

pub(crate) fn pet_px(size: &str) -> f64 {
    match size {
        "small" => 80.0,
        "large" => 144.0,
        _ => 112.0,
    }
}

/// 按设置建 / 显示 / 关掉小窗。开机、改设置、托盘点开关时都走这里
pub fn sync(app: &AppHandle) {
    let s = crate::settings::current_with_defaults();
    let on = s.desk_pet_enabled.unwrap_or(false);
    let existing = app.get_webview_window(LABEL);
    if !on {
        if let Some(w) = existing {
            let _ = w.close();
        }
        return;
    }
    let pet = pet_px(s.desk_pet_size.as_deref().unwrap_or("normal"));
    let (w, h) = compact_size(pet);
    if let Some(win) = existing {
        // 改了大小：小窗回到「只有小桌」的尺寸，前端按新尺寸重排
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
        let _ = win.emit("desk-pet:settings", ());
        let _ = win.show();
        return;
    }
    let (x, y) = initial_position(app, &s, w, h);
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("pet.html".into()))
        .title("小桌")
        .inner_size(w, h)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .visible_on_all_workspaces(true)
        .focused(false)
        .build();
    if let Err(e) = built {
        crate::logbuf::record("warn", "desk-pet", &format!("桌宠小窗没建起来: {e}"));
    }
}

/// 上次放的位置（小窗左上角，逻辑像素）；没放过 = 主屏右下角、离边 24px。
/// 存下的位置已经不在任何一块屏上（拔了外接屏）时也回到主屏右下角
fn initial_position(app: &AppHandle, s: &crate::settings::AppSettingsDto, w: f64, h: f64) -> (f64, f64) {
    let monitors = app.available_monitors().unwrap_or_default();
    if let (Some(x), Some(y)) = (s.desk_pet_x, s.desk_pet_y) {
        let inside = monitors.iter().any(|m| {
            let sf = m.scale_factor();
            let p = m.position().to_logical::<f64>(sf);
            let sz = m.size().to_logical::<f64>(sf);
            x + w / 2.0 >= p.x && x + w / 2.0 <= p.x + sz.width && y + h / 2.0 >= p.y && y + h / 2.0 <= p.y + sz.height
        });
        if inside {
            return (x, y);
        }
    }
    let primary = app.primary_monitor().ok().flatten().or_else(|| monitors.into_iter().next());
    match primary {
        Some(m) => {
            let sf = m.scale_factor();
            let area = m.work_area();
            let p = area.position.to_logical::<f64>(sf);
            let sz = area.size.to_logical::<f64>(sf);
            (p.x + sz.width - w - 24.0, p.y + sz.height - h - 24.0)
        }
        None => (100.0, 100.0),
    }
}

/// 开机：设置里开着就建小窗
pub fn setup(app: &AppHandle) {
    sync(app);
}

// 建窗的命令一律 async：同步命令跑在主线程，Windows 上在里面建窗会卡死
#[tauri::command]
pub async fn desk_pet_sync(app: AppHandle) {
    sync(&app);
}

/// 拖完记下位置（小窗左上角，逻辑像素）。小窗展开 / 收起时位置会变，前端只在「只有小桌」的状态下报
#[tauri::command]
pub async fn desk_pet_save_position(x: f64, y: f64) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("位置不对".into());
    }
    crate::settings::set_desk_pet_position(x, y)
}

/// 右键「隐藏桌宠」：关掉开关、关小窗；设置页与托盘随之显示为关
#[tauri::command]
pub async fn desk_pet_hide(app: AppHandle) -> Result<(), String> {
    crate::settings::set_desk_pet_enabled(false)?;
    sync(&app);
    let _ = app.emit_to("main", "desk-pet:hidden", ());
    let _ = crate::tray::rebuild(&app);
    Ok(())
}

/// 「去看看」/「打开 Mesa」：把主窗口叫回来，交给主窗口按 target 跳到那个地方（desk-pet-host.ts openTarget）。
/// target 原样转交：{kind:"assistant"|"action"|"tab"|"settings", …}；null = 只打开 Mesa
#[tauri::command]
pub async fn desk_pet_open(app: AppHandle, target: Option<serde_json::Value>) {
    crate::window_close::show_main(&app);
    let _ = app.emit_to("main", "desk-pet:open", target);
}

/// 鼠标在屏幕上的位置（逻辑像素，按桌宠小窗所在屏的缩放换算）：小桌朝鼠标那边微微倾身用（第二期）。
/// 取不到（小窗没开、系统不给）返回 None，小桌就站正
#[tauri::command]
pub async fn desk_pet_cursor(app: AppHandle) -> Option<(f64, f64)> {
    let win = app.get_webview_window(LABEL)?;
    let p = app.cursor_position().ok()?;
    let sf = win.scale_factor().ok()?;
    Some((p.x / sf, p.y / sf))
}
