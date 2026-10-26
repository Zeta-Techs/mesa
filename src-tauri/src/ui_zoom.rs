//! 界面缩放与最小窗口尺寸（设置 → 外观「界面大小」、⌘= / ⌘-）。
//!
//! 缩放走 webview 原生 zoom（WKWebView pageZoom / WebView2 ZoomFactor）：会同步改网页里的
//! devicePixelRatio，终端与 PDF 画布按新像素比重画（前端 device-pixel-ratio.ts），字是清楚的。
//! 最小窗口尺寸跟着缩放走：网页看到的宽高 = 窗口 ÷ 缩放，按「网页至少 720×480」反推，
//! 前端最窄一档断点（App.css max-width: 720px）以下就不会再出现。
//! 档位以前端 ui-zoom.ts 为准，这里只夹范围。

use tauri::{LogicalSize, Manager, WebviewWindow};

pub const MIN_ZOOM: f64 = 0.8;
pub const MAX_ZOOM: f64 = 1.5;
pub const DEFAULT_ZOOM: f64 = 1.0;

/// 网页内容至少要有的宽高（CSS px）
const CONTENT_MIN_W: f64 = 720.0;
const CONTENT_MIN_H: f64 = 480.0;
/// 最小尺寸不超过最小那块屏可用区域的这个比例：1280×720 @150% 这类小屏放大后也还拖得动
const WORK_AREA_CAP: f64 = 0.9;

/// 非有限数回落 100%；夹到 [MIN, MAX]，留两位小数（1.25 这档要原样保住）
pub fn clamp_zoom(z: f64) -> f64 {
    if !z.is_finite() || z <= 0.0 {
        return DEFAULT_ZOOM;
    }
    (z.clamp(MIN_ZOOM, MAX_ZOOM) * 100.0).round() / 100.0
}

/// 给定缩放下的最小窗口逻辑尺寸；`work_area` = 各屏可用区域里最小的那块（逻辑尺寸）
pub fn min_window_size(zoom: f64, work_area: Option<(f64, f64)>) -> (f64, f64) {
    let z = clamp_zoom(zoom);
    let (mut w, mut h) = (CONTENT_MIN_W * z, CONTENT_MIN_H * z);
    if let Some((aw, ah)) = work_area {
        if aw > 0.0 && ah > 0.0 {
            w = w.min(aw * WORK_AREA_CAP);
            h = h.min(ah * WORK_AREA_CAP);
        }
    }
    (w.round(), h.round())
}

/// 所有屏里最小的可用区域：窗口可能拖去任一块屏，按最小的算才不会在小屏上拖不进去
fn smallest_work_area(window: &WebviewWindow) -> Option<(f64, f64)> {
    let monitors = window.available_monitors().ok()?;
    monitors
        .iter()
        .map(|m| {
            let size = m.work_area().size.to_logical::<f64>(m.scale_factor());
            (size.width, size.height)
        })
        .filter(|(w, h)| *w > 0.0 && *h > 0.0)
        .reduce(|a, b| (a.0.min(b.0), a.1.min(b.1)))
}

/// 套缩放并按它更新最小窗口尺寸；失败只记日志（缩放不上不该挡住设置保存）
pub fn apply(window: &WebviewWindow, zoom: f64) {
    let z = clamp_zoom(zoom);
    if let Err(e) = window.set_zoom(z) {
        crate::logbuf::record("warn", "window", &format!("界面缩放未生效: {e}"));
    }
    let (w, h) = min_window_size(z, smallest_work_area(window));
    if let Err(e) = window.set_min_size(Some(LogicalSize::new(w, h))) {
        crate::logbuf::record("warn", "window", &format!("最小窗口尺寸未设上: {e}"));
    }
}

/// 设置页 / 快捷键改了缩放后由 update_settings 调
pub fn apply_to_main(app: &tauri::AppHandle, zoom: f64) {
    if let Some(window) = app.get_webview_window("main") {
        apply(&window, zoom);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_keeps_steps_and_bounds() {
        assert_eq!(clamp_zoom(1.25), 1.25);
        assert_eq!(clamp_zoom(0.5), MIN_ZOOM);
        assert_eq!(clamp_zoom(3.0), MAX_ZOOM);
        assert_eq!(clamp_zoom(f64::NAN), DEFAULT_ZOOM);
        assert_eq!(clamp_zoom(-1.0), DEFAULT_ZOOM);
    }

    #[test]
    fn min_size_scales_with_zoom() {
        assert_eq!(min_window_size(1.0, None), (720.0, 480.0));
        assert_eq!(min_window_size(1.5, None), (1080.0, 720.0));
        assert_eq!(min_window_size(0.8, None), (576.0, 384.0));
    }

    #[test]
    fn min_size_capped_by_small_screen() {
        // 1280×720 @150% → 逻辑 853×480，再减任务栏
        let (w, h) = min_window_size(1.5, Some((853.0, 440.0)));
        assert_eq!((w, h), ((853.0f64 * 0.9).round(), (440.0f64 * 0.9).round()));
        // 大屏不限
        assert_eq!(min_window_size(1.0, Some((2560.0, 1400.0))), (720.0, 480.0));
    }
}
