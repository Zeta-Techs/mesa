//! 系统托盘：按 Agent 列出绑定，一点「设为全局」。不改启动栏默认。

use crate::agent_specs;
use crate::global_config;
use crate::profiles::{AccountType, ProfileStore};
use crate::settings;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

pub(crate) const TRAY_ID: &str = "ccode-tray";

static COST_CACHE: Mutex<Option<(Instant, HashMap<String, Option<f64>>)>> = Mutex::new(None);

fn month_costs() -> HashMap<String, Option<f64>> {
    if let Ok(g) = COST_CACHE.lock() {
        if let Some((at, map)) = g.as_ref() {
            if at.elapsed() < Duration::from_secs(60) {
                return map.clone();
            }
        }
    }
    let map = crate::usage::month_cost_usd_by_gateway();
    if let Ok(mut g) = COST_CACHE.lock() {
        *g = Some((Instant::now(), map.clone()));
    }
    map
}

pub fn setup(app: &AppHandle) -> Result<(), String> {
    rebuild(app)
}

#[tauri::command]
pub async fn rebuild_tray(app: AppHandle) -> Result<(), String> {
    rebuild_and_wait(app).await
}

pub async fn rebuild_and_wait(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rebuild(&app))
        .await
        .map_err(|e| format!("托盘刷新失败: {e}"))?
}

pub fn rebuild(app: &AppHandle) -> Result<(), String> {
    let menu = build_menu(app)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("无窗口图标，无法建托盘")?;
    let app2 = app.clone();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Mesa")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |_tray, event| {
            let id = event.id.0;
            handle_menu(&app2, &id);
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn build_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let store = app.state::<ProfileStore>();
    let profiles = store.list().unwrap_or_default();
    let settings = settings::read_current();
    let active = settings.active_global_profiles.unwrap_or_default();

    let show = MenuItem::with_id(app, "show", "打开 Mesa", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit =
        MenuItem::with_id(app, "quit", "退出", true, None::<&str>).map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = vec![Box::new(show)];
    let costs = month_costs();
    let rate = settings.rate_usd_cny.filter(|r| *r > 0.0).unwrap_or(7.2);

    for spec in agent_specs::all_agent_specs() {
        let agent = spec.id;
        let list: Vec<_> = profiles
            .iter()
            .filter(|p| p.agent == agent)
            .cloned()
            .collect();
        if list.is_empty() {
            continue;
        }
        let set_global_ok = matches!(spec.set_global, crate::agent_specs::SetGlobalCap::Supported);
        let recorded = active.get(agent).cloned();
        let drift = global_config::drift_status(&store, agent);
        let drifted = drift.status == "drifted";
        let mut dry_any_ok = false;
        let mut dry_failed = false;
        let mut checks = Vec::new();
        for p in &list {
            let matched = if set_global_ok && p.account_type != AccountType::Official {
                global_config::dry_run_matches(&store, p)
            } else {
                None
            };
            match matched {
                Some(true) => dry_any_ok = true,
                Some(false) => dry_failed = true,
                None => {}
            }
            let checked = matched == Some(true)
                || (matched.is_none() && recorded.as_deref() == Some(p.id.as_str()));
            let mut label = if p.slot_missing && p.account_type != AccountType::Official {
                format!("{}（缺槽）", p.name)
            } else {
                p.name.clone()
            };
            if drifted && recorded.as_deref() == Some(p.id.as_str()) {
                label.push_str("（已被外部修改）");
            }
            let enabled = set_global_ok && !p.slot_missing;
            let item = CheckMenuItem::with_id(
                app,
                format!("bind:{}", p.id),
                label,
                enabled,
                checked,
                None::<&str>,
            )
            .map_err(|e| e.to_string())?;
            checks.push(item);
        }
        let mut sub_items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
        if let Some(pid) = recorded.as_deref() {
            if let Some(p) = list.iter().find(|x| x.id == pid) {
                let cost_txt = p
                    .gateway_id
                    .as_deref()
                    .and_then(|gid| costs.get(gid).copied().flatten())
                    .map(|usd| format!(" · 网关近 30 天 ¥{:.1}", usd * rate))
                    .unwrap_or_default();
                let status = MenuItem::with_id(
                    app,
                    format!("cur:{agent}"),
                    format!("当前：{}{cost_txt}", p.name),
                    false,
                    None::<&str>,
                )
                .map_err(|e| e.to_string())?;
                sub_items.push(Box::new(status));
            }
        }
        if !set_global_ok {
            if let crate::agent_specs::SetGlobalCap::Unsupported(reason) = spec.set_global {
                let hint =
                    MenuItem::with_id(app, format!("hint:{agent}"), reason, false, None::<&str>)
                        .map_err(|e| e.to_string())?;
                sub_items.push(Box::new(hint));
            }
        } else if !dry_any_ok && dry_failed {
            let hint = MenuItem::with_id(
                app,
                format!("stale:{agent}"),
                "全局文件已在 Mesa 外改过",
                false,
                None::<&str>,
            )
            .map_err(|e| e.to_string())?;
            sub_items.push(Box::new(hint));
        }
        for c in checks {
            sub_items.push(Box::new(c));
        }
        let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
            sub_items.iter().map(|b| b.as_ref()).collect();
        let sub =
            Submenu::with_id_and_items(app, format!("ag:{agent}"), spec.display_name, true, &refs)
                .map_err(|e| e.to_string())?;
        items.push(Box::new(sub));
    }

    items.push(Box::new(sep));
    items.push(Box::new(quit));
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        items.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs).map_err(|e| e.to_string())
}

fn handle_menu(app: &AppHandle, id: &str) {
    if id == "show" {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
        }
        return;
    }
    if id == "quit" {
        // 走窗口关闭，让前端关窗守卫有机会确认「还有 agent 在跑」
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.close();
        } else {
            app.exit(0);
        }
        return;
    }
    let Some(bind_id) = id.strip_prefix("bind:") else {
        return;
    };
    let bind_id = bind_id.to_string();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let store = app.state::<ProfileStore>();
        if let Ok(p) = store.get(&bind_id) {
            if p.account_type != AccountType::Official
                && global_config::set_global_conflict_message(&p.agent).is_some()
            {
                let _ = crate::tray::rebuild_and_wait(app.clone()).await;
                let _ = app
                    .notification()
                    .builder()
                    .title("未设为全局")
                    .body("检测到 cc-switch。托盘不会直接接管默认渠道，请到连接页确认。")
                    .show();
                return;
            }
        }
        let result = global_config::apply_profile_global(app.clone(), store, bind_id).await;
        // 成功或失败都重绘：失败时勾选态不能停在错误项上
        let _ = crate::tray::rebuild_and_wait(app.clone()).await;
        if let Err(e) = result {
            crate::logbuf::record("error", "tray", &e);
            let _ = app
                .notification()
                .builder()
                .title("Mesa 设为全局失败")
                .body(e)
                .show();
        }
    });
}

/// 托盘提示行：有文件被外改（Some(false)）且没有仍匹配的绑定才显示。
/// None（官方 / dry-run 失败）不算「外改」。
#[cfg(test)]
fn show_stale_hint(matches: &[Option<bool>]) -> bool {
    let any_live = matches.iter().any(|m| *m == Some(true));
    let any_diverged = matches.iter().any(|m| *m == Some(false));
    !any_live && any_diverged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_hint_only_when_files_diverged() {
        assert!(!show_stale_hint(&[Some(true), Some(false)]));
        assert!(show_stale_hint(&[Some(false), None]));
        assert!(!show_stale_hint(&[None, None]));
        assert!(!show_stale_hint(&[Some(true)]));
    }
}
