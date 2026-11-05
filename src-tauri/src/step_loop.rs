//! 综述回路（docs/design-review-loop.md 二期，2026-11-05 拍板）：补料单、轮次起因、跟进增量、这一步的几轮。
//!
//! 写的只有项目根 `.ccode/rework/<id>.json`（补料单）与 `.ccode/step-rounds.jsonl`（开轮起因），都不进 git、
//! 合并闸门按台账豁免（`review_contract::is_accumulation_ledger`）。其余全是只读：
//! 「这一步的几轮」读验收账本（每次保存进项目一条，`scene_ref` = 工作区 id），看某一版 / 两轮之间的比较走 `git show` / `git diff`。
//! 恢复工作区、并入项目最新内容、开对话都复用已有命令，这里不碰 git 写操作。

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 预览 / 比较输出上限：大纲、笔记、清单都远小于它；超了截断并如实说
const SHOW_CAP: usize = 512 * 1024;

fn project_root(root: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(crate::sessions::expand_tilde(root));
    // 只认 Mesa 项目（有 .ccode/project.toml），不往任意目录写
    if !dir.join(".ccode").join("project.toml").is_file() {
        return Err(format!("不是 Mesa 项目目录：{}", dir.display()));
    }
    Ok(dir)
}

fn rework_dir(root: &Path) -> PathBuf {
    root.join(".ccode").join("rework")
}

fn rounds_path(root: &Path) -> PathBuf {
    root.join(".ccode").join("step-rounds.jsonl")
}

// ===== 补料单 =====

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReworkDraft {
    /// 发起补料的步骤（下游）
    pub from_step: String,
    /// 退回到的步骤（上游）与它的工作区 id / 名
    pub to_step: String,
    pub to_workspace_id: String,
    pub to_workspace_name: String,
    /// 要补的主题 / 章节，一条一项
    pub topics: Vec<String>,
    pub reason: String,
    #[serde(default)]
    pub clues: String,
    /// 大致篇数上限；不填为 None
    #[serde(default)]
    pub scale: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReworkDto {
    pub id: String,
    #[serde(flatten)]
    pub draft: ReworkDraft,
    pub sent_at: String,
    /// 项目内相对路径（`.ccode/rework/<id>.json`）
    pub rel_path: String,
}

fn compact_stamp(iso: &str) -> String {
    iso.chars().filter(|c| c.is_ascii_digit()).collect()
}

fn create_rework_at(root: &Path, mut draft: ReworkDraft) -> Result<ReworkDto, String> {
    draft.topics = draft
        .topics
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    draft.reason = draft.reason.trim().to_string();
    draft.clues = draft.clues.trim().to_string();
    if draft.topics.is_empty() {
        return Err("补料单至少写一条要补的主题或章节".into());
    }
    if draft.reason.is_empty() {
        return Err("补料单要写一句为什么要补".into());
    }
    if draft.to_step.trim().is_empty() || draft.to_workspace_id.trim().is_empty() {
        return Err("补料单没有退回到的步骤".into());
    }
    let sent_at = crate::sessions::now_iso();
    let name = crate::paths::sanitize_fs_name(&draft.to_workspace_name).unwrap_or_else(|_| "step".into());
    let dir = rework_dir(root);
    fs::create_dir_all(&dir).map_err(|e| format!("建补料单目录失败：{e}"))?;
    // 同一秒发两张：后缀递增，不覆盖；create_new 占位，两路同时发也不会撞同一个名
    let base = format!("{}-{}", compact_stamp(&sent_at), name);
    let mut id = base.clone();
    let mut n = 2;
    loop {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join(format!("{id}.json")))
        {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && n < 1000 => {
                id = format!("{base}-{n}");
                n += 1;
            }
            Err(e) => return Err(format!("写补料单失败：{e}")),
        }
    }
    let dto = ReworkDto {
        rel_path: format!(".ccode/rework/{id}.json"),
        id,
        draft,
        sent_at,
    };
    let text = serde_json::to_string_pretty(&dto).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(&dir.join(format!("{}.json", dto.id)), &text)?;
    Ok(dto)
}

fn list_reworks_at(root: &Path) -> Vec<ReworkDto> {
    let Ok(entries) = fs::read_dir(rework_dir(root)) else {
        return Vec::new();
    };
    let mut out: Vec<ReworkDto> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| fs::read_to_string(e.path()).ok())
        .filter_map(|text| serde_json::from_str::<ReworkDto>(&text).ok())
        .collect();
    out.sort_by(|a, b| b.sent_at.cmp(&a.sent_at));
    out
}

#[tauri::command]
pub async fn rework_create(root: String, draft: ReworkDraft) -> Result<ReworkDto, String> {
    tauri::async_runtime::spawn_blocking(move || create_rework_at(&project_root(&root)?, draft))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rework_list(root: String) -> Result<Vec<ReworkDto>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(list_reworks_at(&project_root(&root)?)))
        .await
        .map_err(|e| e.to_string())?
}

// ===== 开轮起因 =====

/// 开一轮时记一行：补料轮 / 跟进轮 / 人点的新开一轮。首轮不记（第一次保存之前没有记录就是首轮）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoundStart {
    pub workspace_id: String,
    pub step: String,
    /// rework | followup | fresh；ack = 点了「跟进上游的新增」但没有要跟进的（只用来清「待跟进」，不算一轮）
    pub kind: String,
    #[serde(default)]
    pub rework_id: Option<String>,
    #[serde(default)]
    pub at: String,
}

fn record_round_at(root: &Path, mut entry: RoundStart) -> Result<(), String> {
    if !matches!(entry.kind.as_str(), "rework" | "followup" | "fresh" | "ack") {
        return Err(format!("不认识的轮次类型：{}", entry.kind));
    }
    entry.at = crate::sessions::now_iso();
    let line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    let path = rounds_path(root);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("记轮次失败：{e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("记轮次失败：{e}"))
}

fn read_rounds_at(root: &Path) -> Vec<RoundStart> {
    let Ok(text) = fs::read_to_string(rounds_path(root)) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|l| serde_json::from_str::<RoundStart>(l.trim()).ok())
        .collect()
}

/// 每个工作区最近一次「跟进过」的时间（followup 或 ack 记录）：上游漂移判断用，见 workspaces::stale_upstream_for
pub(crate) fn followed_at(root: &Path) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::<String, String>::new();
    for s in read_rounds_at(root) {
        if s.kind != "followup" && s.kind != "ack" {
            continue;
        }
        let newer = out.get(&s.workspace_id).is_none_or(|at| s.at > *at);
        if newer {
            out.insert(s.workspace_id, s.at);
        }
    }
    out
}

#[tauri::command]
pub async fn step_round_record(root: String, entry: RoundStart) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || record_round_at(&project_root(&root)?, entry))
        .await
        .map_err(|e| e.to_string())?
}

// ===== 这一步的几轮 =====

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepRoundDto {
    /// 第几轮（1 起）
    pub index: usize,
    /// 保存进项目的时间
    pub saved_at: String,
    /// first | rework | followup | fresh | manual（没记起因、人在原对话里接着改的）
    pub cause: String,
    /// 补料轮的补料单（主题与原因给界面写一句）
    pub rework: Option<ReworkDto>,
    /// 这一轮所审的版本（工作区分支提交）；看这一版 / 和上一轮比都按它
    pub sha: String,
    /// 这一轮带回项目的文件
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepRoundsDto {
    pub rounds: Vec<StepRoundDto>,
    /// 最后一次保存之后又开了一轮、还没保存：起因（同 cause）
    pub open_cause: Option<String>,
    pub open_rework: Option<ReworkDto>,
}

/// 窗口 (after, until] 内最后一条开轮记录
fn cause_in<'a>(starts: &'a [RoundStart], after: &str, until: Option<&str>) -> Option<&'a RoundStart> {
    starts
        .iter()
        .filter(|s| s.at.as_str() > after && until.is_none_or(|u| s.at.as_str() <= u))
        .max_by(|a, b| a.at.cmp(&b.at))
}

fn step_rounds_at(root: &Path, workspace_id: &str) -> StepRoundsDto {
    let mut saves: Vec<_> = crate::projects::read_acceptance_log_at(root)
        .into_iter()
        .filter(|e| {
            e.kind == crate::review_contract::KIND_PIPELINE_MERGE
                && e.scene_ref.as_deref() == Some(workspace_id)
        })
        .collect();
    saves.sort_by(|a, b| a.decided_at.cmp(&b.decided_at));
    let starts: Vec<RoundStart> = read_rounds_at(root)
        .into_iter()
        .filter(|s| s.workspace_id == workspace_id && s.kind != "ack")
        .collect();
    let reworks = list_reworks_at(root);
    let rework_of = |s: &RoundStart| {
        s.rework_id
            .as_ref()
            .and_then(|id| reworks.iter().find(|r| &r.id == id).cloned())
    };
    let mut rounds = Vec::new();
    let mut prev = String::new();
    for (i, save) in saves.iter().enumerate() {
        let start = cause_in(&starts, &prev, Some(&save.decided_at));
        let cause = match start {
            Some(s) => s.kind.clone(),
            None if i == 0 => "first".into(),
            None => "manual".into(),
        };
        rounds.push(StepRoundDto {
            index: i + 1,
            saved_at: save.decided_at.clone(),
            cause,
            rework: start.and_then(rework_of),
            sha: save.reviewed_sha.clone().unwrap_or_default(),
            paths: save.paths.clone(),
        });
        prev = save.decided_at.clone();
    }
    let open = cause_in(&starts, &prev, None);
    StepRoundsDto {
        rounds,
        open_cause: open.map(|s| s.kind.clone()),
        open_rework: open.and_then(rework_of),
    }
}

#[tauri::command]
pub async fn step_rounds(root: String, workspace_id: String) -> Result<StepRoundsDto, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(step_rounds_at(&project_root(&root)?, &workspace_id)))
        .await
        .map_err(|e| e.to_string())?
}

// ===== 看某一版 / 两轮之间比 =====

fn valid_sha(sha: &str) -> bool {
    (7..=64).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

/// 只认项目内相对路径：不准绝对路径、不准 ..、不准以 - 开头（防被 git 当参数）
fn valid_rel(path: &str) -> bool {
    let p = path.replace('\\', "/");
    !p.is_empty()
        && !p.starts_with('/')
        && !p.starts_with('-')
        && !p.contains(':')
        && p.split('/').all(|seg| !seg.is_empty() && seg != "..")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundTextDto {
    pub text: String,
    pub truncated: bool,
}

fn capped(text: String) -> Result<RoundTextDto, String> {
    if text.contains('\0') {
        return Err("这是二进制文件，不能按文字看".into());
    }
    if text.len() <= SHOW_CAP {
        return Ok(RoundTextDto { text, truncated: false });
    }
    let mut end = SHOW_CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok(RoundTextDto { text: text[..end].to_string(), truncated: true })
}

/// 早期保存记录可能没记所审版本（reviewed_sha 为空）：如实说看不了，不报「版本不对」
const NO_SHA: &str = "这一轮保存时没记下版本，看不了这一版";

fn round_file_at(root: &Path, sha: &str, path: &str) -> Result<RoundTextDto, String> {
    if sha.trim().is_empty() {
        return Err(NO_SHA.into());
    }
    if !valid_sha(sha) || !valid_rel(path) {
        return Err("版本或文件路径不对".into());
    }
    let spec = format!("{sha}:{}", path.replace('\\', "/"));
    let text = crate::workspaces::run_git_raw(root, &["show", &spec])
        .map_err(|e| format!("这一版里没有 {path}：{e}"))?;
    capped(text)
}

fn round_diff_at(root: &Path, from: &str, to: &str, path: &str) -> Result<RoundTextDto, String> {
    if from.trim().is_empty() || to.trim().is_empty() {
        return Err(NO_SHA.into());
    }
    if !valid_sha(from) || !valid_sha(to) || !valid_rel(path) {
        return Err("版本或文件路径不对".into());
    }
    let rel = path.replace('\\', "/");
    let text = crate::workspaces::run_git_raw(
        root,
        &["diff", "--no-color", "--no-ext-diff", from, to, "--", &rel],
    )?;
    capped(text)
}

#[tauri::command]
pub async fn step_round_file(root: String, sha: String, path: String) -> Result<RoundTextDto, String> {
    tauri::async_runtime::spawn_blocking(move || round_file_at(&project_root(&root)?, &sha, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn step_round_diff(
    root: String,
    from: String,
    to: String,
    path: String,
) -> Result<RoundTextDto, String> {
    tauri::async_runtime::spawn_blocking(move || round_diff_at(&project_root(&root)?, &from, &to, &path))
        .await
        .map_err(|e| e.to_string())?
}

// ===== 跟进上游的新增：只读算出项目里有、这一步还没有的改动 =====

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FollowupScopeDto {
    /// 基准分支在本工作区之后新增的保存点数
    pub behind: u32,
    /// 这些保存点改过的文件（项目内相对路径）
    pub files: Vec<String>,
}

/// 上游步骤带回项目、这一步还没有的文件：验收账本里上游步骤的保存（`goal_name` 首段 = 工作区名），
/// 所审版本（`reviewed_sha`）还不在本工作区 HEAD 里的，取它们带回的文件。
/// 基准分支的三点差异还含下游 / 并列步骤后来保存的产物，跟进不该把它们当成上游新增（2026-11-05）。
/// 返回 None = 档案卡里找不到这一步，不过滤。
fn upstream_new_paths(
    root: &Path,
    worktree: &Path,
    workspace_name: &str,
) -> Option<std::collections::HashSet<String>> {
    let cfg = crate::projects::read_config_at(root).config;
    let idx = cfg.steps.iter().position(|s| s.workspace_name == workspace_name)?;
    let upstream: std::collections::HashSet<&str> = cfg.steps[..idx]
        .iter()
        .map(|s| s.workspace_name.as_str())
        .filter(|n| !n.is_empty())
        .collect();
    let mut out = std::collections::HashSet::new();
    for e in crate::projects::read_acceptance_log_at(root) {
        if e.kind != crate::review_contract::KIND_PIPELINE_MERGE {
            continue;
        }
        let name = e.goal_name.split(" / ").next().unwrap_or("");
        if !upstream.contains(name) {
            continue;
        }
        // 查不了（版本已被清理等）按「还没有」算：最终还要与三点差异取交集，多算不会越界
        let have = e
            .reviewed_sha
            .as_deref()
            .filter(|sha| !sha.is_empty())
            .is_some_and(|sha| {
                crate::workspaces::git_is_ancestor(worktree, sha, "HEAD").unwrap_or(false)
            });
        if !have {
            out.extend(e.paths.into_iter().map(|p| p.replace('\\', "/")));
        }
    }
    Some(out)
}

fn followup_scope_at(
    worktree: &Path,
    base_branch: &str,
    only: Option<&std::collections::HashSet<String>>,
) -> Result<FollowupScopeDto, String> {
    let t = Duration::from_secs(30);
    let range = format!("HEAD..{base_branch}");
    let behind = crate::workspaces::run_git(worktree, &["rev-list", "--count", &range], t)?
        .trim()
        .parse::<u32>()
        .unwrap_or(0);
    if behind == 0 {
        return Ok(FollowupScopeDto { behind, files: Vec::new() });
    }
    // 三点：基准分支自分叉点以来的改动（不含本工作区自己的）
    let three = format!("HEAD...{base_branch}");
    let files = crate::workspaces::run_git_raw(worktree, &["diff", "--name-only", "--no-renames", &three])?
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .filter(|l| only.is_none_or(|set| set.contains(l)))
        .collect();
    Ok(FollowupScopeDto { behind, files })
}

#[tauri::command]
pub async fn step_followup_scope(workspace_id: String) -> Result<FollowupScopeDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::workspaces::db()?;
        let w = crate::workspaces::get_workspace(&conn, &workspace_id)?;
        if w.status != "active" {
            return Err("这一步的工作区已收起，先恢复再跟进".into());
        }
        let wt = Path::new(&w.worktree_path);
        let only = upstream_new_paths(Path::new(&w.repo_path), wt, &w.name);
        followup_scope_at(wt, &w.base_branch, only.as_ref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 带 .ccode/project.toml 的临时项目；Drop 时删掉
    struct Proj(PathBuf);
    impl Proj {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Proj {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn temp(tag: &str) -> Proj {
        let dir = std::env::temp_dir().join(format!("ccode-step-loop-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        Proj(dir)
    }
    fn project() -> Proj {
        let dir = temp("proj");
        fs::create_dir_all(dir.path().join(".ccode")).unwrap();
        fs::write(dir.path().join(".ccode/project.toml"), "").unwrap();
        dir
    }

    fn draft() -> ReworkDraft {
        ReworkDraft {
            from_step: "综述大纲".into(),
            to_step: "文献检索与筛选".into(),
            to_workspace_id: "ws-1".into(),
            to_workspace_name: "lit-search".into(),
            topics: vec![" §3.2 失活机理 ".into(), "  ".into()],
            reason: "可写正文只有 2 篇".into(),
            clues: String::new(),
            scale: Some(10),
        }
    }

    #[test]
    fn rework_requires_topic_and_reason_and_never_overwrites() {
        let dir = project();
        let mut empty = draft();
        empty.topics = vec!["  ".into()];
        assert!(create_rework_at(dir.path(), empty).is_err());
        let mut no_reason = draft();
        no_reason.reason = " ".into();
        assert!(create_rework_at(dir.path(), no_reason).is_err());
        let a = create_rework_at(dir.path(), draft()).unwrap();
        let b = create_rework_at(dir.path(), draft()).unwrap();
        assert_ne!(a.id, b.id, "同一秒两张不能互相覆盖");
        assert_eq!(a.draft.topics, vec!["§3.2 失活机理".to_string()]);
        assert!(a.rel_path.starts_with(".ccode/rework/"));
        assert_eq!(list_reworks_at(dir.path()).len(), 2);
    }

    #[test]
    fn project_root_refuses_non_project_dirs() {
        let dir = temp("bare");
        assert!(project_root(&dir.path().to_string_lossy()).is_err());
    }

    #[test]
    fn rounds_take_cause_from_last_start_before_each_save() {
        let dir = project();
        let log = |at: &str, sha: &str| crate::projects::AcceptanceLogEntry {
            kind: crate::review_contract::KIND_PIPELINE_MERGE.into(),
            scene_ref: Some("ws-1".into()),
            decided_at: at.into(),
            reviewed_sha: Some(sha.into()),
            paths: vec!["outline.md".into()],
            ..Default::default()
        };
        let other = crate::projects::AcceptanceLogEntry {
            kind: crate::review_contract::KIND_PIPELINE_MERGE.into(),
            scene_ref: Some("ws-2".into()),
            decided_at: "2026-11-05T01:00:00Z".into(),
            ..Default::default()
        };
        let lines: Vec<String> = [log("2026-11-05T02:00:00Z", "aaaaaaa"), other, log("2026-11-05T04:00:00Z", "bbbbbbb"), log("2026-11-05T06:00:00Z", "ccccccc")]
            .iter()
            .map(|e| serde_json::to_string(e).unwrap())
            .collect();
        fs::write(dir.path().join(".ccode/acceptance-log.jsonl"), lines.join("\n")).unwrap();
        let rework = create_rework_at(dir.path(), draft()).unwrap();
        let starts = [
            RoundStart { workspace_id: "ws-1".into(), step: "s".into(), kind: "fresh".into(), rework_id: None, at: "2026-11-05T03:00:00Z".into() },
            RoundStart { workspace_id: "ws-1".into(), step: "s".into(), kind: "rework".into(), rework_id: Some(rework.id.clone()), at: "2026-11-05T03:30:00Z".into() },
            RoundStart { workspace_id: "ws-9".into(), step: "s".into(), kind: "followup".into(), rework_id: None, at: "2026-11-05T05:00:00Z".into() },
            RoundStart { workspace_id: "ws-1".into(), step: "s".into(), kind: "followup".into(), rework_id: None, at: "2026-11-05T07:00:00Z".into() },
        ];
        let text: Vec<String> = starts.iter().map(|s| serde_json::to_string(s).unwrap()).collect();
        fs::write(rounds_path(dir.path()), text.join("\n")).unwrap();
        let got = step_rounds_at(dir.path(), "ws-1");
        let causes: Vec<_> = got.rounds.iter().map(|r| r.cause.as_str()).collect();
        assert_eq!(causes, ["first", "rework", "manual"]);
        assert_eq!(got.rounds[1].rework.as_ref().map(|r| r.id.clone()), Some(rework.id));
        assert_eq!(got.rounds[2].sha, "ccccccc");
        assert_eq!(got.open_cause.as_deref(), Some("followup"));
    }

    #[test]
    fn record_round_rejects_unknown_kind() {
        let dir = project();
        let bad = RoundStart { workspace_id: "w".into(), step: "s".into(), kind: "x".into(), rework_id: None, at: String::new() };
        assert!(record_round_at(dir.path(), bad).is_err());
        let ok = RoundStart { workspace_id: "w".into(), step: "s".into(), kind: "fresh".into(), rework_id: None, at: String::new() };
        record_round_at(dir.path(), ok).unwrap();
        let read = read_rounds_at(dir.path());
        assert_eq!(read.len(), 1);
        assert!(!read[0].at.is_empty(), "时间由后端写，不信前端");
    }

    #[test]
    fn ack_clears_stale_but_is_not_a_round() {
        let dir = project();
        let start = |kind: &str, at: &str| RoundStart { workspace_id: "w".into(), step: "s".into(), kind: kind.into(), rework_id: None, at: at.into() };
        let lines: Vec<String> = [start("followup", "2026-11-05T01:00:00Z"), start("ack", "2026-11-05T03:00:00Z"), start("fresh", "2026-11-05T05:00:00Z")]
            .iter()
            .map(|s| serde_json::to_string(s).unwrap())
            .collect();
        fs::write(rounds_path(dir.path()), lines.join("\n")).unwrap();
        assert_eq!(followed_at(dir.path()).get("w").map(String::as_str), Some("2026-11-05T03:00:00Z"));
        // ack 不进轮次起因：最后一条是 fresh
        assert_eq!(step_rounds_at(dir.path(), "w").open_cause.as_deref(), Some("fresh"));
    }

    #[test]
    fn rel_and_sha_guards() {
        assert!(valid_rel("notes/a.md"));
        assert!(!valid_rel("../x"));
        assert!(!valid_rel("/etc/passwd"));
        assert!(!valid_rel("-p"));
        assert!(!valid_rel("C:/x"));
        assert!(!valid_rel("a//b"));
        assert!(valid_sha("abc1234"));
        assert!(!valid_sha("HEAD"));
        assert!(!valid_sha("abc"));
        assert_eq!(round_file_at(Path::new("."), "", "a.md").unwrap_err(), NO_SHA);
        assert_eq!(round_diff_at(Path::new("."), "abc1234", " ", "a.md").unwrap_err(), NO_SHA);
    }

    #[cfg(unix)]
    #[test]
    fn followup_scope_and_round_views_against_real_git() {
        let git = |dir: &Path, args: &[&str]| {
            let bin = crate::agents::resolve_binary("git").expect("测试环境找不到 git");
            let out = std::process::Command::new(bin)
                .arg("-C")
                .arg(dir)
                .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "{:?}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let dir = project();
        let repo = dir.path();
        git(repo, &["init", "-q", "-b", "main"]);
        fs::write(repo.join("outline.md"), "v1\n").unwrap();
        git(repo, &["add", "outline.md"]);
        git(repo, &["commit", "-qm", "one"]);
        let v1 = git(repo, &["rev-parse", "HEAD"]);
        let wt_holder = temp("wt");
        let wt = wt_holder.path().join("wt");
        git(repo, &["worktree", "add", "-q", "-b", "step", wt.to_str().unwrap()]);
        assert_eq!(followup_scope_at(&wt, "main", None).unwrap(), FollowupScopeDto { behind: 0, files: vec![] });
        fs::create_dir_all(repo.join("notes")).unwrap();
        fs::write(repo.join("notes/new.md"), "n\n").unwrap();
        fs::write(repo.join("outline.md"), "v2\n").unwrap();
        git(repo, &["add", "notes/new.md", "outline.md"]);
        git(repo, &["commit", "-qm", "two"]);
        let v2 = git(repo, &["rev-parse", "HEAD"]);
        let scope = followup_scope_at(&wt, "main", None).unwrap();
        assert_eq!(scope.behind, 1);
        assert_eq!(scope.files, vec!["notes/new.md".to_string(), "outline.md".to_string()]);
        assert_eq!(round_file_at(repo, &v1, "outline.md").unwrap().text, "v1\n");
        let diff = round_diff_at(repo, &v1, &v2, "outline.md").unwrap().text;
        assert!(diff.contains("-v1") && diff.contains("+v2"), "{diff}");
        assert!(round_file_at(repo, &v1, "../outline.md").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn followup_lists_only_upstream_saves_not_downstream_outputs() {
        let git = |dir: &Path, args: &[&str]| {
            let bin = crate::agents::resolve_binary("git").expect("测试环境找不到 git");
            let out = std::process::Command::new(bin)
                .arg("-C")
                .arg(dir)
                .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "{:?}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let dir = project();
        let repo = dir.path();
        fs::write(
            repo.join(".ccode/project.toml"),
            "[[steps]]\nname = \"检索\"\nworkspace_name = \"lit\"\n\n[[steps]]\nname = \"大纲\"\nworkspace_name = \"outline\"\n\n[[steps]]\nname = \"写作\"\nworkspace_name = \"write\"\n",
        )
        .unwrap();
        git(repo, &["init", "-q", "-b", "main"]);
        fs::create_dir_all(repo.join("papers")).unwrap();
        fs::write(repo.join("papers/included.md"), "v1\n").unwrap();
        git(repo, &["add", "papers/included.md"]);
        git(repo, &["commit", "-qm", "lit round 1"]);
        let lit1 = git(repo, &["rev-parse", "HEAD"]);
        let wt_holder = temp("wt");
        let wt = wt_holder.path().join("wt");
        git(repo, &["worktree", "add", "-q", "-b", "ccode/outline", wt.to_str().unwrap()]);
        // 之后：上游检索又保存一轮，下游写作也保存了一轮
        fs::write(repo.join("papers/included.md"), "v2\n").unwrap();
        git(repo, &["add", "papers/included.md"]);
        git(repo, &["commit", "-qm", "lit round 2"]);
        let lit2 = git(repo, &["rev-parse", "HEAD"]);
        fs::create_dir_all(repo.join("manuscript")).unwrap();
        fs::write(repo.join("manuscript/draft.md"), "d\n").unwrap();
        git(repo, &["add", "manuscript/draft.md"]);
        git(repo, &["commit", "-qm", "write round"]);
        let write1 = git(repo, &["rev-parse", "HEAD"]);
        let entry = |name: &str, sha: &str, path: &str| crate::projects::AcceptanceLogEntry {
            kind: crate::review_contract::KIND_PIPELINE_MERGE.into(),
            goal_name: format!("{name} / ccode/{name}"),
            reviewed_sha: Some(sha.into()),
            paths: vec![path.into()],
            ..Default::default()
        };
        let lines: Vec<String> = [
            entry("lit", &lit1, "papers/old.md"),
            entry("lit", &lit2, "papers/included.md"),
            entry("write", &write1, "manuscript/draft.md"),
        ]
        .iter()
        .map(|e| serde_json::to_string(e).unwrap())
        .collect();
        fs::write(repo.join(".ccode/acceptance-log.jsonl"), lines.join("\n")).unwrap();
        let only = upstream_new_paths(repo, &wt, "outline").unwrap();
        assert_eq!(only.len(), 1, "已在本工作区里的上游旧轮不算：{only:?}");
        let scope = followup_scope_at(&wt, "main", Some(&only)).unwrap();
        assert_eq!(scope.behind, 2);
        assert_eq!(scope.files, vec!["papers/included.md".to_string()], "下游写作的产物不算上游新增");
        assert!(upstream_new_paths(repo, &wt, "nope").is_none());
    }
}
