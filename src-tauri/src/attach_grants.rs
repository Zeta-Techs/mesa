//! 用户亲手交给 Mesa 的文件（2026-10-23）：拖进窗口的、在「+ → 文件或图片」选择器里选的。
//! 进程内登记，`pdf::read_whitelisted_sync` 按精确路径放行——聊天输入框的附件卡才能给项目外的
//! PDF / 图片出缩略图。只认原生拖放事件和 Rust 侧弹出的选择器；前端传来的路径一律不登记，
//! 否则读取白名单形同虚设。不落盘，重启即清（之后退回文件名卡）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 登记上限：只为本次运行里交过来的附件服务，超出丢最早的
const MAX_GRANTS: usize = 512;

static GRANTED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// 登记一批路径：canonicalize 后只收文件（文件夹不放行其下内容）
pub(crate) fn grant<P: AsRef<Path>>(paths: impl IntoIterator<Item = P>) {
    let mut granted = GRANTED.lock().unwrap_or_else(|e| e.into_inner());
    for p in paths {
        let Ok(c) = p.as_ref().canonicalize() else {
            continue;
        };
        if !c.is_file() {
            continue;
        }
        granted.retain(|x| x != &c);
        granted.push(c);
    }
    let over = granted.len().saturating_sub(MAX_GRANTS);
    if over > 0 {
        granted.drain(..over);
    }
}

/// 已登记的精确路径（canonical）
pub(crate) fn granted() -> Vec<PathBuf> {
    GRANTED.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// 原生拖放落下：窗口事件与 webview 事件两条路都可能送来，重复登记无害
pub(crate) fn grant_drop(event: &tauri::DragDropEvent) {
    if let tauri::DragDropEvent::Drop { paths, .. } = event {
        grant(paths);
    }
}

/// 「+ → 文件或图片」：系统选择器在 Rust 侧弹，选中的文件登记后把路径交给前端
#[tauri::command]
pub async fn pick_attachment_files(
    app: tauri::AppHandle,
    default_dir: Option<String>,
) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        if let Some(dir) = default_dir.filter(|d| !d.trim().is_empty()) {
            dialog = dialog.set_directory(dir);
        }
        dialog.blocking_pick_files()
    })
    .await
    .map_err(|e| format!("选文件失败: {e}"))?;
    let paths: Vec<PathBuf> = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .collect();
    grant(&paths);
    Ok(paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_files_only_and_dedups() {
        let dir = std::env::temp_dir().join(format!("ccode-grant-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("论文.pdf");
        std::fs::write(&file, b"%PDF-1.7").unwrap();
        grant([&file, &file, &dir, &dir.join("不存在.pdf")]);
        let canon = file.canonicalize().unwrap();
        let hits = granted().into_iter().filter(|p| p == &canon).count();
        assert_eq!(hits, 1, "同一文件只登记一次");
        let dir_canon = dir.canonicalize().unwrap();
        assert!(!granted().contains(&dir_canon), "文件夹不登记");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
