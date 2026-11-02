//! 事件规则的本机事件源：目录里落了新文件（2026-11-02，design-attention-dispatch.md §5）。
//!
//! 不挂常驻文件监听：定时任务每分钟一个 tick，顺手对规则目录拍快照比对。文件要连着两次 tick
//! 大小和修改时间都没变才算落稳（大文件还在写、一次拖进十个文件都只成一单），快照存在 Mesa 配置目录，
//! Mesa 关着期间落进来的文件下次启动的第一个 tick 补收。第一次拍快照只记底，不触发。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 一个目录最多看这么多文件、这么深：防误选项目根把整个仓库扫一遍
const MAX_FILES: usize = 5000;
const MAX_DEPTH: usize = 6;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct Snapshot {
    /// 已经算过的文件：相对项目根路径 → 「大小:修改时间毫秒」
    pub seen: BTreeMap<String, String>,
    /// 上一次 tick 才看到、还没确认落稳的
    pub candidate: BTreeMap<String, String>,
}

/// 规则目录写法校验：项目内、相对、不碰 .git / .ccode，目录得在。返回统一用「/」的相对路径
pub(crate) fn validate_folder(project_root: &Path, folder: &str) -> Result<String, String> {
    let rel = folder.trim().trim_matches(['/', '\\']).replace('\\', "/");
    if rel.is_empty() {
        return Err("要选项目里的一个目录（不能是项目根本身）".into());
    }
    if !crate::scheduler::watch_rel_ok(&rel) {
        return Err(format!("目录要写成项目内的相对路径：{folder}"));
    }
    let first = rel.split('/').next().unwrap_or_default();
    if matches!(first, ".git" | ".ccode") {
        return Err("不能盯 .git 或 .ccode 目录".into());
    }
    let dir = project_root.join(&rel);
    let meta = fs::symlink_metadata(&dir).map_err(|_| format!("项目里没有这个目录：{rel}"))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(format!("不是项目里的普通目录：{rel}"));
    }
    Ok(rel)
}

fn signature(meta: &fs::Metadata) -> String {
    let millis = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}:{millis}", meta.len())
}

/// 列出规则目录里的文件（跳过点开头的文件与目录、符号链接）；exts 为空 = 都认
pub(crate) fn list_files(
    project_root: &Path,
    folder: &str,
    exts: &[String],
) -> Result<BTreeMap<String, String>, String> {
    fn visit(
        root: &Path,
        dir: &Path,
        depth: usize,
        exts: &[String],
        out: &mut BTreeMap<String, String>,
    ) -> Result<(), String> {
        let entries = fs::read_dir(dir).map_err(|e| format!("读目录失败：{e}"))?;
        for entry in entries.flatten() {
            if out.len() >= MAX_FILES {
                return Ok(());
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if depth < MAX_DEPTH {
                    visit(root, &entry.path(), depth + 1, exts, out)?;
                }
                continue;
            }
            let ext = Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !exts.is_empty() && !exts.iter().any(|x| *x == ext) {
                continue;
            }
            let Ok(rel) = entry.path().strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")) else {
                continue;
            };
            out.insert(rel, signature(&meta));
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    visit(project_root, &project_root.join(folder), 0, exts, &mut out)?;
    Ok(out)
}

/// 快照比对（纯函数）：返回这次确认落稳的新增 / 改动文件。删掉的文件从快照里去掉，不算事件
pub(crate) fn diff(snapshot: &mut Snapshot, current: BTreeMap<String, String>) -> Vec<String> {
    snapshot.seen.retain(|rel, _| current.contains_key(rel));
    let mut out = Vec::new();
    let mut next = BTreeMap::new();
    for (rel, sig) in current {
        if snapshot.seen.get(&rel) == Some(&sig) {
            continue;
        }
        if snapshot.candidate.get(&rel) == Some(&sig) {
            snapshot.seen.insert(rel.clone(), sig);
            out.push(rel);
        } else {
            next.insert(rel, sig);
        }
    }
    snapshot.candidate = next;
    out
}

fn snapshot_path(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("定时任务 id 不合法".into());
    }
    Ok(crate::storage::config_root()
        .ok_or("无法确定配置目录")?
        .join("schedule-events")
        .join(format!("{id}.json")))
}

/// 拍一次快照并比对，返回落稳的新文件。还没有快照（新建规则 / 换了目录）时只记底、返回空
pub(crate) fn scan_folder(
    id: &str,
    project_root: &Path,
    folder: &str,
    exts: &[String],
) -> Result<Vec<String>, String> {
    let path = snapshot_path(id)?;
    let current = list_files(project_root, folder, exts)?;
    let (mut snapshot, fresh) = match fs::read_to_string(&path) {
        Ok(text) => (serde_json::from_str::<Snapshot>(&text).unwrap_or_default(), false),
        Err(_) => (Snapshot::default(), true),
    };
    let found = if fresh {
        snapshot.seen = current;
        Vec::new()
    } else {
        diff(&mut snapshot, current)
    };
    let text = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(&path, &text)?;
    Ok(found)
}

/// 删规则、换目录时丢掉快照（下一次扫描重新记底）
pub(crate) fn reset(id: &str) {
    if let Ok(path) = snapshot_path(id) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn file_counts_only_after_two_stable_ticks() {
        let mut snap = Snapshot { seen: map(&[("data/old.csv", "1:1")]), ..Default::default() };
        // 第一次看到：先当候选
        assert!(diff(&mut snap, map(&[("data/old.csv", "1:1"), ("data/new.csv", "5:2")])).is_empty());
        // 还在写（大小变了）：重新等
        assert!(diff(&mut snap, map(&[("data/old.csv", "1:1"), ("data/new.csv", "9:3")])).is_empty());
        // 连着两次不变：落稳
        assert_eq!(diff(&mut snap, map(&[("data/old.csv", "1:1"), ("data/new.csv", "9:3")])), ["data/new.csv"]);
        assert!(diff(&mut snap, map(&[("data/old.csv", "1:1"), ("data/new.csv", "9:3")])).is_empty());
        // 旧文件改了也算；删掉的从快照里去掉
        assert!(diff(&mut snap, map(&[("data/old.csv", "2:4")])).is_empty());
        assert_eq!(diff(&mut snap, map(&[("data/old.csv", "2:4")])), ["data/old.csv"]);
        assert!(!snap.seen.contains_key("data/new.csv"));
    }

    #[test]
    fn scan_baselines_first_then_reports_and_validates_folder() {
        let dir = std::env::temp_dir().join(format!("mesa-ev-{}", uuid::Uuid::new_v4()));
        let _config = crate::storage::redirect_config_root(&dir.join("config"));
        let root = dir.join("proj");
        fs::create_dir_all(root.join("data/raw/sub")).unwrap();
        fs::write(root.join("data/raw/a.csv"), "x").unwrap();
        fs::write(root.join("data/raw/.hidden.csv"), "x").unwrap();
        assert!(validate_folder(&root, "../x").is_err());
        assert!(validate_folder(&root, ".ccode").is_err());
        assert!(validate_folder(&root, "nope").is_err());
        assert_eq!(validate_folder(&root, "data\\raw/").unwrap(), "data/raw");
        let exts = vec!["csv".to_string()];
        // 记底：已有文件不触发
        assert!(scan_folder("r1", &root, "data/raw", &exts).unwrap().is_empty());
        fs::write(root.join("data/raw/sub/b.CSV"), "yy").unwrap();
        fs::write(root.join("data/raw/c.txt"), "zz").unwrap();
        assert!(scan_folder("r1", &root, "data/raw", &exts).unwrap().is_empty());
        assert_eq!(scan_folder("r1", &root, "data/raw", &exts).unwrap(), ["data/raw/sub/b.CSV"]);
        reset("r1");
        assert!(scan_folder("r1", &root, "data/raw", &exts).unwrap().is_empty());
        assert!(snapshot_path("../x").is_err());
        fs::remove_dir_all(&dir).ok();
    }
}
