//! Run 的只读产物证据聚合；不引入第二套可编辑的评审状态机。

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_FILES: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDto {
    pub path: String,
    pub kind: String,
    pub producer_run_id: String,
    pub expected: bool,
    pub review_status: String,
}

fn kind(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "txt" | "tex" | "qmd" => "text",
        "pdf" => "pdf",
        "png" | "jpg" | "jpeg" | "svg" => "image",
        "csv" | "tsv" | "xlsx" | "xls" => "data",
        _ => "file",
    }
}

fn clean_pattern(value: &str) -> Option<(String, bool)> {
    let value = value.trim().replace('\\', "/");
    let directory = value.ends_with('/');
    let value = value.trim_end_matches('/');
    if value.is_empty()
        || value.starts_with('/')
        || value.split('/').any(|p| p == ".." || p.is_empty())
    {
        return None;
    }
    Some((value.to_string(), directory))
}

fn component_match(pattern: &str, value: &str) -> bool {
    fn matches(pattern: &[char], value: &[char]) -> bool {
        match pattern.first() {
            None => value.is_empty(),
            Some('*') => {
                matches(&pattern[1..], value)
                    || (!value.is_empty() && matches(pattern, &value[1..]))
            }
            Some('?') => !value.is_empty() && matches(&pattern[1..], &value[1..]),
            Some(c) => !value.is_empty() && *c == value[0] && matches(&pattern[1..], &value[1..]),
        }
    }
    matches(
        &pattern.chars().collect::<Vec<_>>(),
        &value.chars().collect::<Vec<_>>(),
    )
}

/// `dir/` 匹配其下任意文件；`*` 不跨目录，`**` 可跨目录。
pub(crate) fn expected_match(path: &str, expected: &str) -> bool {
    let Some((pattern, directory)) = clean_pattern(expected) else {
        return false;
    };
    let path = path.trim_matches('/').replace('\\', "/");
    if path.is_empty() {
        return false;
    }
    let pp: Vec<&str> = pattern.split('/').collect();
    let vp: Vec<&str> = path.split('/').collect();
    fn matches(pp: &[&str], vp: &[&str]) -> bool {
        match (pp.first(), vp.first()) {
            (None, None) => true,
            (Some(&"**"), _) => matches(&pp[1..], vp) || (!vp.is_empty() && matches(pp, &vp[1..])),
            (Some(p), Some(v)) => component_match(p, v) && matches(&pp[1..], &vp[1..]),
            _ => false,
        }
    }
    if matches(&pp, &vp) {
        return true;
    }
    // 目录声明没有文件系统类型传入，因此把它作为前缀规则处理。
    directory && path.starts_with(&(pattern + "/"))
}

fn is_safe_entry(path: &Path) -> Option<std::fs::FileType> {
    std::fs::symlink_metadata(path)
        .ok()
        .map(|m| m.file_type())
        .filter(|t| !t.is_symlink())
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<String>) {
    if out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            break;
        }
        let path = entry.path();
        let Some(file_type) = is_safe_entry(&path) else {
            continue;
        };
        if file_type.is_dir() {
            if !matches!(
                entry.file_name().to_str(),
                Some(".git" | "node_modules" | "target")
            ) {
                collect(root, &path, out);
            }
        } else if file_type.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

fn modified_after(path: &Path, created_at: &str) -> bool {
    let Ok(modified) = std::fs::symlink_metadata(path).and_then(|m| m.modified()) else {
        return false;
    };
    let Ok(created) = chrono::DateTime::parse_from_rfc3339(created_at) else {
        return false;
    };
    let Ok(seconds) = u64::try_from(created.timestamp()) else {
        return false;
    };
    let Some(created) = UNIX_EPOCH.checked_add(std::time::Duration::new(
        seconds,
        created.timestamp_subsec_nanos(),
    )) else {
        return false;
    };
    modified >= created
}

#[tauri::command]
pub fn run_artifacts(run_id: String) -> Result<Vec<ArtifactDto>, String> {
    let run = crate::runs::run_get_sync(run_id.clone())?.ok_or("Run 不存在")?;
    let raw_root = PathBuf::from(&run.isolation_path);
    let Some(root_type) = is_safe_entry(&raw_root) else {
        return Err("Run 隔离路径不存在或是符号链接".into());
    };
    if !root_type.is_dir() {
        return Err("Run 隔离路径不是目录".into());
    }
    let root =
        std::fs::canonicalize(&raw_root).map_err(|e| format!("Run 隔离路径无法解析: {e}"))?;

    let expected = run
        .project_root
        .as_deref()
        .map(|project| {
            let config = crate::projects::read_config_at(Path::new(project));
            let leaf = root.file_name().and_then(|s| s.to_str()).unwrap_or("");
            config
                .config
                .steps
                .into_iter()
                .filter(|step| {
                    step.workspace_name == leaf
                        || step.name == run.task_ref.as_deref().unwrap_or("")
                })
                .flat_map(|step| step.expected_artifacts)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut paths = Vec::new();
    collect(&root, &root, &mut paths);
    paths.sort();
    let mut out: Vec<ArtifactDto> = paths
        .into_iter()
        .map(|path| {
            let absolute = root.join(&path);
            let proven = modified_after(&absolute, &run.created_at);
            ArtifactDto {
                expected: expected.iter().any(|item| expected_match(&path, item)),
                kind: kind(Path::new(&path)).into(),
                path,
                // 只把时间上能归因于本次 Run 的文件交给评审；旧文件不是本次产物。
                producer_run_id: if proven {
                    run.id.clone()
                } else {
                    String::new()
                },
                // 这里是证据状态，不是 Run 的执行状态；真正的评审仍由现有评审流维护。
                review_status: if proven { "unreviewed" } else { "not_started" }.into(),
            }
        })
        .collect();

    for item in expected {
        let Some((cleaned, directory)) = clean_pattern(&item) else {
            continue;
        };
        if out.iter().any(|row| expected_match(&row.path, &item)) {
            continue;
        }
        out.push(ArtifactDto {
            // 对目录/glob保留声明本身，表示“尚未发现命中项”，不伪造文件路径。
            path: if directory {
                format!("{cleaned}/")
            } else {
                cleaned.clone()
            },
            kind: kind(Path::new(&cleaned)).into(),
            producer_run_id: String::new(),
            expected: true,
            review_status: "not_started".into(),
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn expected_patterns_cover_files_directories_and_globs() {
        assert!(expected_match("papers/a.pdf", "papers/"));
        assert!(expected_match("papers/a.pdf", "papers/*.pdf"));
        assert!(expected_match("papers/2026/a.pdf", "papers/**/*.pdf"));
        assert!(expected_match("notes.md", "*.md"));
        assert!(!expected_match("papers/a.txt", "papers/*.pdf"));
        assert!(!expected_match("../secret", "../"));
    }

    #[cfg(unix)]
    #[test]
    fn collect_does_not_follow_symlinks() {
        let base = std::env::temp_dir().join(format!("ccode-artifacts-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(base.join("inside")).unwrap();
        fs::write(base.join("inside/ok.md"), "ok").unwrap();
        std::os::unix::fs::symlink(base.join("inside"), base.join("escape")).unwrap();
        let mut files = Vec::new();
        collect(&base, &base, &mut files);
        assert_eq!(files, vec!["inside/ok.md"]);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn old_file_is_not_attributed_to_run() {
        let base = std::env::temp_dir().join(format!("ccode-artifacts-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let file = base.join("old.md");
        fs::write(&file, "old").unwrap();
        assert!(!modified_after(&file, &chrono::Utc::now().to_rfc3339()));
        fs::remove_dir_all(base).unwrap();
    }
}
