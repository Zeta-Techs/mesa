//! 独立文件查看窗口（2026-11-14 用户反馈笔记本窄屏抽屉遮挡、询问能否在新窗口打开文件）：
//! 从项目右侧文件栏、审查意见 `对照文件` 或「文件」页签一键拆出原生独立窗口对照查看原稿；
//! 窗口开着期间，主窗口里点审查意见的 `文件:行号` 直接同步到该窗口定位，不再在主窗口叠抽屉。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub(crate) const LABEL: &str = "file-viewer";

const MIN_W: f64 = 480.0;
const MIN_H: f64 = 360.0;

static OPEN_LOCK: Mutex<()> = Mutex::new(());
static STATE: Mutex<Option<FileViewerStateDto>> = Mutex::new(None);
static NEXT_NONCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileViewerItemDto {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default)]
    pub rel: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileViewerStateDto {
    pub project_root: String,
    pub root: String,
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub rel: Option<String>,
    #[serde(default)]
    pub list: Option<Vec<FileViewerItemDto>>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub show_list: Option<bool>,
    #[serde(default)]
    pub from: Option<String>,
    /// 打开时直接停在「文件版本」（从右侧文件栏的版本视图拆出来）
    #[serde(default)]
    pub versions: Option<bool>,
    #[serde(default)]
    pub nonce: u64,
}

pub fn apply_zoom(window: &WebviewWindow, zoom: f64) {
    let z = crate::ui_zoom::clamp_zoom(zoom);
    let _ = window.set_zoom(z);
    let _ = window.set_min_size(Some(LogicalSize::new((MIN_W * z).round(), (MIN_H * z).round())));
}

pub fn apply_zoom_if_open(app: &AppHandle, zoom: f64) {
    if let Some(win) = app.get_webview_window(LABEL) {
        apply_zoom(&win, zoom);
    }
}

pub fn on_destroyed() {
    *STATE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

fn open_sync(app: &AppHandle, mut state: FileViewerStateDto) -> Result<(), String> {
    let _guard = OPEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    state.nonce = NEXT_NONCE.fetch_add(1, Ordering::Relaxed);
    let title = format!("{} — Mesa", state.name);
    *STATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(state.clone());

    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_title(&title);
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("file-viewer:state", &state);
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("src/file-viewer/index.html".into()))
        .title(&title)
        .inner_size(940.0, 740.0)
        .min_inner_size(MIN_W, MIN_H)
        .resizable(true)
        .build()
        .map_err(|e| format!("打开独立文件窗口失败: {e}"))?;
    let s = crate::settings::current_with_defaults();
    apply_zoom(&win, s.ui_zoom.unwrap_or(crate::ui_zoom::DEFAULT_ZOOM));
    Ok(())
}

// 建窗命令必须 async（Windows 主线程建窗会死锁，同 desk_pet.rs）
#[tauri::command]
pub async fn file_viewer_open(app: AppHandle, state: FileViewerStateDto) -> Result<(), String> {
    open_sync(&app, state)
}

#[tauri::command]
pub fn file_viewer_state() -> Option<FileViewerStateDto> {
    STATE.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
pub fn file_viewer_is_open(app: AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dto_uses_camel_case_on_wire() {
        let dto = FileViewerStateDto {
            project_root: "/p".into(),
            root: "/w".into(),
            path: "/w/manuscript/draft.md".into(),
            name: "draft.md".into(),
            rel: Some("manuscript/draft.md".into()),
            list: Some(vec![FileViewerItemDto {
                path: "/w/manuscript/draft.md".into(),
                name: "draft.md".into(),
                root: Some("/w".into()),
                rel: Some("manuscript/draft.md".into()),
            }]),
            line: Some(166),
            show_list: Some(true),
            from: Some("逐条决定审查报告".into()),
            versions: Some(true),
            nonce: 3,
        };
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["projectRoot"], "/p");
        assert_eq!(json["showList"], true);
        assert_eq!(json["line"], 166);
        assert_eq!(json["versions"], true);
        let back: FileViewerStateDto = serde_json::from_value(json).unwrap();
        assert_eq!(back, dto);
    }
}
