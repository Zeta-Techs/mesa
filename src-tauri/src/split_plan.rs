//! 拆分方案（2026-11-03 项目内协作三期，docs/design-project-coordination.md）：方案在项目根 `.ccode/split-plan.md`
//! （固定字段，前端 split-plan.ts 解析），工作台卡片给人看、勾选、批准一次开齐；批准或不开后移进 `.ccode/split-plans/` 留底。
//! 同日用户拍板去掉协调对话：人在工作台写一句要做什么，前端带上 `split_plan_context` 给的项目概况无头调用一次 AI，
//! 拿回的方案经 `split_plan_write` 落盘（AI 在隔离的临时目录里跑，不进项目、不碰文件）。
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

/// 概况里略去的目录：版本库、Mesa 记录、依赖与缓存
const SKIP_DIRS: &[&str] = &[".git", ".ccode", "node_modules", "__pycache__", ".venv", "venv", ".quarto", "target"];
const CONTEXT_MAX_LINES: usize = 160;
const CHILDREN_SHOWN: usize = 12;

fn listable(name: &str) -> bool {
    !SKIP_DIRS.contains(&name) && !name.starts_with('.')
}

fn sorted_entries(dir: &Path) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = fs::read_dir(dir)
        .map(|it| {
            it.filter_map(Result::ok)
                .map(|e| (e.file_name().to_string_lossy().into_owned(), e.file_type().map(|t| t.is_dir()).unwrap_or(false)))
                .filter(|(n, _)| listable(n))
                .collect()
        })
        .unwrap_or_default();
    // 目录在前，同类按名字
    out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    out
}

/// 给起草方案的 AI 看的项目概况：目录前两层（每个目录最多列 CHILDREN_SHOWN 个）+ 现在开着的工作。
/// AI 在临时目录里跑、看不到项目，拆法要靠这个判断
pub(crate) fn context_at(root: &Path, runs: &[crate::runs::RunDto]) -> String {
    let mut lines = vec!["项目目录（前两层；略去 .git、.ccode、依赖与缓存）：".to_string()];
    for (name, is_dir) in sorted_entries(root) {
        if lines.len() >= CONTEXT_MAX_LINES {
            lines.push("……（更多没列）".into());
            break;
        }
        if !is_dir {
            lines.push(format!("- {name}"));
            continue;
        }
        let children = sorted_entries(&root.join(&name));
        lines.push(format!("- {name}/（{} 项）", children.len()));
        for (child, child_dir) in children.iter().take(CHILDREN_SHOWN) {
            lines.push(format!("  - {child}{}", if *child_dir { "/" } else { "" }));
        }
        if children.len() > CHILDREN_SHOWN {
            lines.push(format!("  - ……另有 {} 项", children.len() - CHILDREN_SHOWN));
        }
    }
    let open: Vec<String> = runs
        .iter()
        .filter(|r| r.closed_at.is_none() && !r.internal && r.task_kind != "login")
        .map(|r| {
            let agent = crate::agent_specs::agent_spec(&r.agent).map(|s| s.display_name.to_string()).unwrap_or_else(|| r.agent.clone());
            format!("- {}（{agent}）", crate::peek::label_of(r, root))
        })
        .collect();
    lines.push(String::new());
    lines.push(if open.is_empty() { "现在开着的工作：没有".into() } else { "现在开着的工作：".into() });
    lines.extend(open);
    crate::sessions::redact_sensitive_text(&lines.join("\n"))
}

pub(crate) fn write_at(root: &Path, text: &str) -> Result<(), String> {
    let text = text.trim();
    if !text.starts_with("# 拆分方案") {
        return Err("方案没按格式写（要以「# 拆分方案」开头）".into());
    }
    if text.len() as u64 > PLAN_CAP {
        return Err("方案太长了，让它写短些".into());
    }
    let path = root.join(PLAN_REL);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("建 .ccode 目录失败：{e}"))?;
    }
    crate::profiles::atomic_write(&path, &format!("{text}\n"))
}

#[tauri::command]
pub async fn split_plan_context(project_root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&project_root);
        let runs = crate::runs::run_list_sync(Some(project_root.clone())).unwrap_or_default();
        Ok(context_at(&root, &runs))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 无头 AI 写好的方案落盘（覆盖旧的；「让它改」也走这里）
#[tauri::command]
pub async fn split_plan_write(project_root: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&project_root);
        write_at(&root, &text)?;
        crate::projects::exclude_in_git(&root, PLAN_REL);
        crate::projects::exclude_in_git(&root, &format!("{ARCHIVE_REL}/"));
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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

    #[test]
    fn context_lists_two_levels_skips_noise_and_write_checks_format() {
        let root = std::env::temp_dir().join(format!("mesa-plan-ctx-{}", uuid::Uuid::new_v4()));
        for d in ["data/batch1", "data/batch2", ".git/objects", "node_modules/x", ".ccode"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        for i in 0..15 {
            fs::write(root.join(format!("data/f{i:02}.csv")), "").unwrap();
        }
        fs::write(root.join("README.md"), "").unwrap();
        let ctx = context_at(&root, &[]);
        assert!(ctx.contains("- data/（17 项）"), "{ctx}");
        assert!(ctx.contains("  - batch1/") && ctx.contains("  - ……另有 5 项"), "{ctx}");
        assert!(ctx.contains("- README.md") && ctx.contains("现在开着的工作：没有"), "{ctx}");
        assert!(!ctx.contains(".git") || ctx.contains("略去 .git"), "{ctx}");
        assert!(!ctx.contains("node_modules/") && !ctx.contains("objects"), "{ctx}");
        assert!(write_at(&root, "随便写写").is_err());
        write_at(&root, "  # 拆分方案：质控\n\n## 批次一\n要做：x\n").unwrap();
        assert!(read_at(&root).unwrap().text.starts_with("# 拆分方案：质控"));
        fs::remove_dir_all(&root).ok();
    }
}
