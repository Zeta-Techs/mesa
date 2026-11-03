//! 协调对话的拆分方案（2026-11-03 项目内协作三期，docs/design-project-coordination.md）：协调对话把方案写进项目根 `.ccode/split-plan.md`
//! （固定字段，前端 split-plan.ts 解析），工作台卡片给人看、勾选、批准一次开齐；批准或不开后移进 `.ccode/split-plans/` 留底。
//! 方案只是草稿：Mesa 不按它自动开工，开不开、开哪几路由人点（并行三层第二层）。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub const PLAN_REL: &str = ".ccode/split-plan.md";
const ARCHIVE_REL: &str = ".ccode/split-plans";
const PLAN_CAP: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SplitPlanFileDto {
    pub text: String,
    pub updated_at: String,
}

fn root_of(project_root: &str) -> PathBuf {
    PathBuf::from(crate::sessions::expand_tilde(project_root))
}

pub(crate) fn read_at(root: &Path) -> Option<SplitPlanFileDto> {
    let path = root.join(PLAN_REL);
    let file = fs::File::open(&path).ok()?;
    let mut text = String::new();
    std::io::Read::read_to_string(&mut std::io::Read::take(file, PLAN_CAP), &mut text).ok()?;
    if text.trim().is_empty() {
        return None;
    }
    let updated_at = fs::metadata(&path)
        .and_then(|m| m.modified())
        .map(|t| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339())
        .unwrap_or_default();
    Some(SplitPlanFileDto { text: crate::sessions::redact_sensitive_text(&text), updated_at })
}

/// 批准（approved）或不开（declined）之后移进留底目录，文件名带时间与结果
pub(crate) fn close_at(root: &Path, outcome: &str) -> Result<PathBuf, String> {
    if !matches!(outcome, "approved" | "declined") {
        return Err(format!("不认识的结果：{outcome}"));
    }
    let from = root.join(PLAN_REL);
    if !from.is_file() {
        return Err("方案已经不在了（可能已处理过）".into());
    }
    let dir = root.join(ARCHIVE_REL);
    fs::create_dir_all(&dir).map_err(|e| format!("建留底目录失败：{e}"))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let to = dir.join(format!("{stamp}-{outcome}.md"));
    fs::rename(&from, &to).map_err(|e| format!("移走方案失败：{e}"))?;
    Ok(to)
}

#[tauri::command]
pub async fn split_plan_read(project_root: String) -> Result<Option<SplitPlanFileDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&project_root);
        let plan = read_at(&root);
        if plan.is_some() {
            // 方案与留底是过程文件，不进 git（与 help-wanted 同口径，只写本机 info/exclude）
            crate::projects::exclude_in_git(&root, PLAN_REL);
            crate::projects::exclude_in_git(&root, &format!("{ARCHIVE_REL}/"));
        }
        Ok(plan)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn split_plan_close(project_root: String, outcome: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || close_at(&root_of(&project_root), &outcome).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_and_close_moves_plan_into_archive() {
        let root = std::env::temp_dir().join(format!("mesa-plan-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".ccode")).unwrap();
        assert!(read_at(&root).is_none());
        fs::write(root.join(PLAN_REL), "  \n").unwrap();
        assert!(read_at(&root).is_none(), "空文件不算方案");
        fs::write(root.join(PLAN_REL), "# 拆分方案：x\n\n## A\n要做：y\n").unwrap();
        assert!(read_at(&root).unwrap().text.contains("## A"));
        assert!(close_at(&root, "maybe").is_err());
        let to = close_at(&root, "approved").unwrap();
        assert!(to.to_string_lossy().ends_with("-approved.md"));
        assert!(!root.join(PLAN_REL).exists() && to.is_file());
        assert!(close_at(&root, "declined").unwrap_err().contains("不在了"));
        fs::remove_dir_all(&root).ok();
    }
}
