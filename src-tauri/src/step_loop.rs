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
    /// 补料链（2026-11-06 流程贯通 §6）：退回目标保存后接着自动跟进的下游步骤名，按顺序；空 = 只补这一步
    #[serde(default)]
    pub chain: Vec<String>,
    /// 同一张补文献单上「精读已有的」那几条（2026-11-11 按大纲的节转回路①）：退回检索时随单存，链上第一步精读跟进时一起做；
    /// 只退回精读时写在 topics 里、这里为空
    #[serde(default)]
    pub reads: Vec<String>,
}

/// 补料链上一步「开过」的记录：步骤名、开的时间；skipped = 算出来没有要跟进的（记了 ack，链直接往下走）
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChainStart {
    pub step: String,
    pub at: String,
    #[serde(default)]
    pub skipped: bool,
}

/// 补料链走到哪：存 `.ccode/rework/chain/<id>.json`（补料单本身只写一次不改；都不进 git）
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChainState {
    #[serde(default)]
    pub started: Vec<ChainStart>,
    /// 人点了「停掉这条链」：只停自动往下，补料单与已开的轮不动
    #[serde(default)]
    pub stopped: bool,
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
    /// 补料链走到哪（列出时从 chain/<id>.json 读上；补料单文件里不写）
    #[serde(default, skip_deserializing)]
    pub chain_state: ChainState,
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
    draft.reads = draft
        .reads
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if draft.topics.is_empty() {
        return Err("补料单至少写一条要补的主题或章节".into());
    }
    if draft.reason.is_empty() {
        return Err("补料单要写一句为什么要补".into());
    }
    if draft.to_step.trim().is_empty() || draft.to_workspace_id.trim().is_empty() {
        return Err("补料单没有退回到的步骤".into());
    }
    // 精读那几条靠链交到精读步：链是空的就没人做
    if !draft.reads.is_empty() && draft.chain.is_empty() {
        return Err("补文献单里有要精读的，但补完之后没有接着跟进的精读步骤".into());
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
        chain_state: ChainState::default(),
    };
    let mut stored = serde_json::to_value(&dto).map_err(|e| e.to_string())?;
    if let Some(map) = stored.as_object_mut() {
        map.remove("chainState");
    }
    let text = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
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
    for r in &mut out {
        r.chain_state = read_chain_at(root, &r.id);
    }
    out.sort_by(|a, b| b.sent_at.cmp(&a.sent_at));
    out
}

// ===== 补料链（2026-11-06 流程贯通 §6，design-flow-weave.md） =====

fn valid_rework_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && id.chars().all(|c| !matches!(c, '/' | '\\' | '.' | ':') && !c.is_control())
}

fn chain_path(root: &Path, id: &str) -> PathBuf {
    rework_dir(root).join("chain").join(format!("{id}.json"))
}

fn read_chain_at(root: &Path, id: &str) -> ChainState {
    if !valid_rework_id(id) {
        return ChainState::default();
    }
    fs::read_to_string(chain_path(root, id))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// 在锁里读改写一条链的状态；补料单不存在或 id 不合法报错
fn update_chain_at<R>(root: &Path, id: &str, f: impl FnOnce(&ReworkDto, &mut ChainState) -> R) -> Result<R, String> {
    if !valid_rework_id(id) {
        return Err("补料单 id 不对".into());
    }
    let rework = list_reworks_at(root)
        .into_iter()
        .find(|r| r.id == id)
        .ok_or("补料单不在了")?;
    let dir = rework_dir(root).join("chain");
    fs::create_dir_all(&dir).map_err(|e| format!("记补料链失败：{e}"))?;
    let _lock = crate::storage::lock_at(&dir.join(".lock"))?;
    let mut state = read_chain_at(root, id);
    let out = f(&rework, &mut state);
    let text = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(&chain_path(root, id), &text)?;
    Ok(out)
}

/// 链上这一步要开了：没停、在链上、还没开过才记下并返回 true——两处同时看到那次保存也只开一次
fn claim_chain_at(root: &Path, id: &str, step: &str) -> Result<bool, String> {
    update_chain_at(root, id, |rework, state| {
        if state.stopped || !rework.draft.chain.iter().any(|s| s == step) || state.started.iter().any(|s| s.step == step) {
            return false;
        }
        state.started.push(ChainStart {
            step: step.to_string(),
            at: crate::sessions::now_iso(),
            skipped: false,
        });
        true
    })
}

#[tauri::command]
pub async fn rework_chain_claim(root: String, rework_id: String, step: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || claim_chain_at(&project_root(&root)?, &rework_id, &step))
        .await
        .map_err(|e| e.to_string())?
}

/// 链上这一步算出来没有要跟进的（记了 ack）：标 skipped，链从它的上一步接着往下
#[tauri::command]
pub async fn rework_chain_skip(root: String, rework_id: String, step: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_chain_at(&project_root(&root)?, &rework_id, |_, state| {
            if let Some(s) = state.started.iter_mut().find(|s| s.step == step) {
                s.skipped = true;
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 停掉这条链：只停自动往下，补料单与已开的轮不动
#[tauri::command]
pub async fn rework_chain_stop(root: String, rework_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_chain_at(&project_root(&root)?, &rework_id, |_, state| {
            state.stopped = true;
        })
    })
    .await
    .map_err(|e| e.to_string())?
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
    /// rework | followup | fresh；ack = 点了「跟进更新」但没有要跟进的（只用来清「待跟进」，不算一轮）；
    /// sync = 把项目最新内容并进了这一步的工作副本（workspace_sync_base 成功时后端自己记，不算一轮）；
    /// comments = 导入 Word 批注后处理意见的一轮（2026-11-07）；catchup = 精读步补读原来只有摘要、后来补到全文的篇（2026-11-10）
    pub kind: String,
    #[serde(default)]
    pub rework_id: Option<String>,
    #[serde(default)]
    pub at: String,
}

fn record_round_at(root: &Path, mut entry: RoundStart) -> Result<(), String> {
    if !matches!(entry.kind.as_str(), "rework" | "followup" | "fresh" | "ack" | "sync" | "comments" | "catchup") {
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

/// 开了对话的那几种轮（工作区 id, 起因, 时间）：侧栏按它把流程对话写成「补料轮 / 跟进轮 …」（runs::apply_step_runs）。
/// sync / ack 不开对话，不在此列
pub(crate) fn round_starts(root: &Path) -> Vec<(String, String, String)> {
    read_rounds_at(root)
        .into_iter()
        .filter(|s| matches!(s.kind.as_str(), "rework" | "followup" | "fresh" | "comments" | "catchup"))
        .map(|s| (s.workspace_id, s.kind, s.at))
        .collect()
}

/// 每个工作区最近一次「并入过」的时间：上游漂移判断用，见 workspaces::stale_upstream_for。
/// 认 sync（并入成功，2026-11-06 起后端自己记）、ack（人点跟进而没有要跟进的）、followup / rework
/// （这两种轮开之前都先并入；早于 sync 记录的旧数据靠它们）
pub(crate) fn followed_at(root: &Path) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::<String, String>::new();
    for s in read_rounds_at(root) {
        if !matches!(s.kind.as_str(), "followup" | "ack" | "sync" | "rework") {
            continue;
        }
        let newer = out.get(&s.workspace_id).is_none_or(|at| s.at > *at);
        if newer {
            out.insert(s.workspace_id, s.at);
        }
    }
    out
}

/// 并入成功后记一行 sync（workspace_sync_base / 完成解冲突调用）。只记流程步骤的工作区——
/// 编程等别的工作区不往仓库 .ccode/ 里写；记不下不影响并入本身
pub(crate) fn record_sync(w: &crate::workspaces::WorkspaceDto) {
    let root = Path::new(&w.repo_path);
    let steps = crate::projects::read_config_at(root).config.steps;
    let Some(step) = steps.iter().find(|s| !s.workspace_name.is_empty() && s.workspace_name == w.name) else {
        return;
    };
    let _ = record_round_at(
        root,
        RoundStart {
            workspace_id: w.id.clone(),
            step: step.name.clone(),
            kind: "sync".into(),
            rework_id: None,
            at: String::new(),
        },
    );
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
    /// first | rework | followup | fresh | comments | catchup | manual（没记起因、人在原对话里接着改的）
    pub cause: String,
    /// 补料轮的补料单（主题与原因给界面写一句）
    pub rework: Option<ReworkDto>,
    /// 这一轮所审的版本（工作区分支提交）；看这一版 / 和上一轮比都按它
    pub sha: String,
    /// 这一轮带回项目的文件
    pub paths: Vec<String>,
    /// 与 paths 一一对应：added | modified | deleted；比不出（不在 Git 里的产物、老记录）为空串
    pub changes: Vec<String>,
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

pub(crate) fn saved_round_origin(root: &Path, workspace_id: &str, saved_at: &str) -> (usize, String) {
    let mut saves: Vec<_> = crate::projects::read_acceptance_log_at(root).into_iter()
        .filter(|save| save.kind == crate::review_contract::KIND_PIPELINE_MERGE && save.scene_ref.as_deref() == Some(workspace_id) && save.decided_at.as_str() <= saved_at).collect();
    saves.sort_by(|before, after| before.decided_at.cmp(&after.decided_at));
    let after = saves.iter().rev().nth(1).map(|save| save.decided_at.as_str()).unwrap_or("");
    let starts: Vec<_> = read_rounds_at(root).into_iter().filter(|start| start.workspace_id == workspace_id && start.kind != "ack" && start.kind != "sync").collect();
    let cause = cause_in(&starts, after, Some(saved_at)).map(|start| start.kind.clone())
        .unwrap_or_else(|| if saves.len() <= 1 { "first".into() } else { "manual".into() });
    (saves.len().max(1), cause)
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
        .filter(|s| s.workspace_id == workspace_id && s.kind != "ack" && s.kind != "sync")
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
            changes: round_changes(root, &save.version_id, save.reviewed_sha.as_deref(), &save.paths),
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

/// 这一轮每个文件相对保存前的项目是新加、改了还是删了：保存那次合并提交的第一父（保存前的项目）比所审版本。
/// 版本不全或 git 失败时全给空串（界面不标）
fn round_changes(root: &Path, version_id: &str, reviewed: Option<&str>, paths: &[String]) -> Vec<String> {
    let blank = vec![String::new(); paths.len()];
    let Some(reviewed) = reviewed.filter(|s| valid_sha(s)) else {
        return blank;
    };
    if !valid_sha(version_id) || paths.is_empty() {
        return blank;
    }
    let base = format!("{version_id}^1");
    let mut args = vec!["diff", "--no-color", "--no-renames", "--name-status", base.as_str(), reviewed, "--"];
    let rels: Vec<String> = paths.iter().filter(|p| valid_rel(p)).map(|p| p.replace('\\', "/")).collect();
    args.extend(rels.iter().map(String::as_str));
    let Ok(out) = crate::workspaces::run_git_raw(root, &args) else {
        return blank;
    };
    let mut kind = std::collections::HashMap::new();
    for line in out.lines() {
        let mut it = line.splitn(2, '\t');
        let (Some(code), Some(path)) = (it.next(), it.next()) else { continue };
        let k = match code.chars().next() {
            Some('A') => "added",
            Some('D') => "deleted",
            Some('M') | Some('T') => "modified",
            _ => continue,
        };
        kind.insert(path.trim().to_string(), k);
    }
    paths
        .iter()
        .map(|p| kind.get(&p.replace('\\', "/")).copied().unwrap_or("").to_string())
        .collect()
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

/// 「看这一轮」里文献清单类文件：两版纳入清单之间改了什么，一句白话（conflict_hint::ledger_change_summary）。
/// from 为空 = 第一轮。读不到 / 解析不了返回 None，界面退回逐行比
fn round_ledger_at(root: &Path, from: Option<&str>, to: &str) -> Result<Option<String>, String> {
    if !valid_sha(to) || from.is_some_and(|f| !valid_sha(f)) {
        return Err("版本不对".into());
    }
    let show = |sha: &str| crate::workspaces::run_git_raw(root, &["show", &format!("{sha}:papers/included.json")]).ok();
    let Some(new) = show(to) else { return Ok(None) };
    let old = match from {
        Some(f) => match show(f) {
            Some(text) => Some(text),
            None => return Ok(None),
        },
        None => None,
    };
    Ok(crate::conflict_hint::ledger_change_summary(old.as_deref(), &new))
}

#[tauri::command]
pub async fn step_round_ledger(root: String, from: Option<String>, to: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        round_ledger_at(&project_root(&root)?, from.as_deref().filter(|f| !f.is_empty()), &to)
    })
    .await
    .map_err(|e| e.to_string())?
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

// ===== 跟进更新：只读算出项目里有、这一步还没有的改动 =====

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
            chain: vec!["文献精读与笔记".into(), "综述大纲".into()],
            reads: Vec::new(),
        }
    }

    #[test]
    fn chain_claims_each_step_once_and_stop_halts_it() {
        let dir = project();
        let r = create_rework_at(dir.path(), draft()).unwrap();
        // 补料单文件里不写链状态
        let raw = fs::read_to_string(dir.path().join(&r.rel_path)).unwrap();
        assert!(!raw.contains("chainState"));
        assert!(claim_chain_at(dir.path(), &r.id, "文献精读与笔记").unwrap());
        assert!(!claim_chain_at(dir.path(), &r.id, "文献精读与笔记").unwrap(), "同一步只开一次");
        assert!(!claim_chain_at(dir.path(), &r.id, "综述初稿").unwrap(), "不在链上的不开");
        let listed = list_reworks_at(dir.path());
        assert_eq!(listed[0].draft.chain, vec!["文献精读与笔记".to_string(), "综述大纲".to_string()]);
        assert_eq!(listed[0].chain_state.started.len(), 1);
        update_chain_at(dir.path(), &r.id, |_, s| s.stopped = true).unwrap();
        assert!(!claim_chain_at(dir.path(), &r.id, "综述大纲").unwrap(), "停掉后不再往下");
        assert!(claim_chain_at(dir.path(), "../x", "综述大纲").is_err());
        // 链状态文件放在 rework/chain/ 下，列补料单时不会被当成补料单
        assert_eq!(list_reworks_at(dir.path()).len(), 1);
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
    fn rework_reads_ride_on_the_chain() {
        let dir = project();
        let mut d = draft();
        d.reads = vec![" 4.3：[@Su2025] ".into(), " ".into()];
        let r = create_rework_at(dir.path(), d.clone()).unwrap();
        assert_eq!(r.draft.reads, vec!["4.3：[@Su2025]".to_string()]);
        assert_eq!(list_reworks_at(dir.path())[0].draft.reads, r.draft.reads);
        d.chain.clear();
        assert!(create_rework_at(dir.path(), d).is_err(), "有要精读的却没有链，不发");
        // 旧单没有 reads 这一栏，按空读
        let old = r#"{"id":"x","fromStep":"a","toStep":"b","toWorkspaceId":"w","toWorkspaceName":"n","topics":["t"],"reason":"r","sentAt":"2026-11-05T00:00:00Z","relPath":".ccode/rework/x.json"}"#;
        let dto: ReworkDto = serde_json::from_str(old).unwrap();
        assert!(dto.draft.reads.is_empty());
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
        let catchup = RoundStart { workspace_id: "w".into(), step: "s".into(), kind: "catchup".into(), rework_id: None, at: String::new() };
        record_round_at(dir.path(), catchup).unwrap();
        assert_eq!(step_rounds_at(dir.path(), "w").open_cause.as_deref(), Some("catchup"));
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
    fn sync_counts_as_incorporation_but_not_as_a_round() {
        let dir = project();
        let start = |kind: &str, at: &str| RoundStart { workspace_id: "w".into(), step: "s".into(), kind: kind.into(), rework_id: None, at: at.into() };
        let lines: Vec<String> = [start("rework", "2026-11-06T01:00:00Z"), start("sync", "2026-11-06T04:00:00Z")]
            .iter()
            .map(|s| serde_json::to_string(s).unwrap())
            .collect();
        fs::write(rounds_path(dir.path()), lines.join("\n")).unwrap();
        // 并入是最后一次「跟上」的时间
        assert_eq!(followed_at(dir.path()).get("w").map(String::as_str), Some("2026-11-06T04:00:00Z"));
        // 但不是一轮：起因仍是补料轮
        assert_eq!(step_rounds_at(dir.path(), "w").open_cause.as_deref(), Some("rework"));
        assert!(record_round_at(dir.path(), start("sync", "")).is_ok());
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
