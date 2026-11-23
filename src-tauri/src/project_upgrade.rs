//! 项目结构版本与逐级升级（docs/design-project-doctor.md 第二件）。
//! 档案卡顶层 `layout = N` 记项目停在哪一代结构（缺省 0 = 这套机制之前建的老项目）。Mesa 改项目结构时：
//! 在 UPGRADES 末尾加一级（只追加或改 Mesa 自己的东西，能重复跑），把 CURRENT_LAYOUT 加一，
//! 并在 tests/fixtures/projects/ 放一份上一代老项目样本——`upgrade_from_every_fixture_reaches_current` 守着。
//! 模板内容（步骤说明、验收条件）不在这里：那些走「Mesa 提出、人勾了才换」（pipeline-upgrade.ts）。
use std::fs;
use std::path::Path;

pub(crate) const CURRENT_LAYOUT: i64 = 2;

struct Upgrade {
    to: i64,
    what: &'static str,
    run: fn(&Path) -> Result<(), String>,
}

const UPGRADES: &[Upgrade] = &[
    Upgrade {
        to: 1,
        what: "补齐 .gitignore 里 Mesa 自己的忽略行",
        run: layout1_mesa_ignores,
    },
    Upgrade {
        to: 2,
        what: "同步新版过程文件忽略规则（.ccode/local/、next-actions、step-next）并解除历史过程文件误跟踪",
        run: layout2_sync_mesa_git_exemptions,
    },
];

/// 第 1 级：老科研项目的 .gitignore 缺后来进模板的 Mesa 记录 / 台账忽略行（2026-11-18）
fn layout1_mesa_ignores(root: &Path) -> Result<(), String> {
    if crate::projects::project_work_mode_at(root) == "research" {
        crate::projects::upgrade_mesa_ignores_at(root)?;
    }
    Ok(())
}

/// 第 2 级（2026-11-21）：补齐 .gitignore 新过程文件忽略行、同步仓库共享 .git/info/exclude，
/// 并把历史版本误提交成 tracked 的工作区过程文件（如 .ccode/review-notes.md）移出索引（本地保留）。
/// 若本次改动了 .gitignore，定向静默提交 .gitignore（不夹带用户别的文件），绝不留脏主仓在评审保存时拦用户。
fn layout2_sync_mesa_git_exemptions(root: &Path) -> Result<(), String> {
    let mut touched_gitignore = false;
    if crate::projects::project_work_mode_at(root) == "research" {
        touched_gitignore = crate::projects::upgrade_mesa_ignores_at(root)?;
    }
    crate::git_exemptions::sync_git_exclude(root);
    crate::git_exemptions::untrack_committed_transients(root);
    if touched_gitignore {
        let _ = commit_gitignore_only(root);
    }
    Ok(())
}

/// 仅当仓库已存在且 .gitignore 有改动时，定向把 .gitignore 自己提交成一笔（绝不夹带用户其他文件）。
fn commit_gitignore_only(root: &Path) -> Result<(), String> {
    if !root.join(".git").exists() {
        return Ok(());
    }
    let status = crate::process::background_command("git")
        .args(["status", "--porcelain", "--", ".gitignore"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("检查 .gitignore 状态失败: {e}"))?;
    if !status.status.success() || String::from_utf8_lossy(&status.stdout).trim().is_empty() {
        return Ok(());
    }
    let add = crate::process::background_command("git")
        .args(["add", "--", ".gitignore"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("暂存 .gitignore 失败: {e}"))?;
    if !add.status.success() {
        return Ok(());
    }
    let _ = crate::process::background_command("git")
        .args([
            "-c",
            "user.name=Mesa",
            "-c",
            "user.email=mesa@local",
            "commit",
            "-m",
            "Mesa: 自动补齐 .gitignore 忽略规则",
            "--only",
            "--",
            ".gitignore",
        ])
        .current_dir(root)
        .output();
    Ok(())
}

fn card_path(root: &Path) -> std::path::PathBuf {
    root.join(".ccode").join("project.toml")
}

/// 项目停在哪一代结构；没有档案卡返回 None（不是 Mesa 项目，不升级）
pub(crate) fn layout_at(root: &Path) -> Option<i64> {
    let text = fs::read_to_string(card_path(root)).ok()?;
    let value = text.parse::<toml::Value>().ok()?;
    Some(value.get("layout").and_then(|v| v.as_integer()).unwrap_or(0))
}

/// 新建档案卡时直接记成最新一代（新项目用的就是最新模板，不需要升级）
pub(crate) fn stamp_current(doc: &mut toml_edit::DocumentMut) {
    doc["layout"] = toml_edit::value(CURRENT_LAYOUT);
}

/// 从项目所在那一代逐级升到最新；返回这次做了哪几件（白话）。升级都能重复跑，中途失败下次接着来
pub(crate) fn upgrade_at(root: &Path) -> Result<Vec<&'static str>, String> {
    let Some(from) = layout_at(root) else {
        return Ok(Vec::new());
    };
    if from >= CURRENT_LAYOUT {
        return Ok(Vec::new());
    }
    let mut done = Vec::new();
    for step in UPGRADES.iter().filter(|u| u.to > from) {
        (step.run)(root).map_err(|e| format!("老项目升级「{}」失败：{e}", step.what))?;
        done.push(step.what);
    }
    let path = card_path(root);
    let text = fs::read_to_string(&path).map_err(|e| format!("读取档案卡失败：{e}"))?;
    let mut doc = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("档案卡解析失败，没有记升级版本：{e}"))?;
    doc["layout"] = toml_edit::value(CURRENT_LAYOUT);
    crate::profiles::atomic_write(&path, &doc.to_string())?;
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn copy_dir(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let dest = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_dir(&entry.path(), &dest);
            } else {
                fs::copy(entry.path(), dest).unwrap();
            }
        }
    }

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/projects")
    }

    /// 每一代老项目样本都能升到最新，升完 layout = 最新、再跑一次什么都不做。
    /// 样本目录名 `layout-<N>-<说明>`；样本里的 `gitignore`（不带点，免得被仓库自己的 git 认成规则）升级前改名成 .gitignore
    #[test]
    fn upgrade_from_every_fixture_reaches_current() {
        let mut seen = 0;
        for entry in fs::read_dir(fixtures()).unwrap() {
            let sample = entry.unwrap().path();
            if !sample.is_dir() {
                continue;
            }
            let dir = std::env::temp_dir().join(format!("ccode-upgrade-{}", uuid::Uuid::new_v4()));
            copy_dir(&sample, &dir);
            if dir.join("gitignore").exists() {
                fs::rename(dir.join("gitignore"), dir.join(".gitignore")).unwrap();
            }
            if dir.join("ccode").exists() {
                fs::rename(dir.join("ccode"), dir.join(".ccode")).unwrap();
            }
            let from = layout_at(&dir).unwrap();
            assert!(from < CURRENT_LAYOUT, "{} 不是老样本", sample.display());
            upgrade_at(&dir).unwrap();
            assert_eq!(layout_at(&dir), Some(CURRENT_LAYOUT), "{}", sample.display());
            assert!(upgrade_at(&dir).unwrap().is_empty(), "第二次不该再做事");
            let ignore = fs::read_to_string(dir.join(".gitignore")).unwrap_or_default();
            for line in [
                "/.ccode/record.jsonl",
                "/.ccode/step-rounds.jsonl",
                "/.ccode/versions/",
                "/.ccode/next-actions.json",
                "/.ccode/step-next/",
                "/.ccode/local/",
            ] {
                assert!(ignore.lines().any(|l| l.trim_start_matches('/') == line.trim_start_matches('/')), "{} 缺 {line}", sample.display());
            }
            fs::remove_dir_all(&dir).ok();
            seen += 1;
        }
        assert!(seen > 0, "没有老项目样本");
    }

    /// 新建的档案卡直接是最新一代，不跑升级；老档案卡补 id 时不顺手标成最新（否则升级永远不跑）
    #[test]
    fn new_card_is_current_old_card_keeps_its_layout() {
        let dir = std::env::temp_dir().join(format!("ccode-upgrade-new-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        crate::projects::ensure_project_id_at(&dir).unwrap();
        assert_eq!(layout_at(&dir), Some(CURRENT_LAYOUT));
        // Mesa 之后改写档案卡（存设置、改步骤）不能把 layout 丢掉，否则升级每次重跑
        let config = crate::projects::read_config_at(&dir).config;
        crate::projects::write_config_at(&dir, &config).unwrap();
        assert_eq!(layout_at(&dir), Some(CURRENT_LAYOUT));
        let old = dir.join("old");
        fs::create_dir_all(old.join(".ccode")).unwrap();
        fs::write(card_path(&old), "work_mode = \"research\"\n").unwrap();
        crate::projects::ensure_project_id_at(&old).unwrap();
        assert_eq!(layout_at(&old), Some(0));
        fs::remove_dir_all(&dir).ok();
    }
}
