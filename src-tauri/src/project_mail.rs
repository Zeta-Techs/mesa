//! 项目内传话（2026-11-03 项目内协作二期，docs/design-project-coordination.md）：同一项目里一段工作给另一段留话。
//!
//! - **写**：Agent 跑 `mesa_helper tell --to 名字 "…"`，追加进**自己工作目录**的 `.ccode/outbox.jsonl`
//!   （Codex 等的沙箱只让写工作目录，与 help-wanted.md 同一个道理）。一行一条：id / at / from（发话的 Run）/ to（收话的 Run）/ text。
//! - **收**：Mesa 主进程扫同项目各 Run 工作目录的发件箱汇总（只认 from 的工作目录确实是这个发件箱所在处的）；
//!   收话方标签空闲、输入框里没你没发的字时，终端页经那个标签自己的发送链送进对话（TerminalPage）。
//! - **状态**：送达 / 撤回记在配置目录 `mail-state.json`（只有 Mesa 写）；工作台列出往来、能撤回。
//! - 只在同一项目内；跨项目不直连（拍板 §2 第 3 条）。文字限长、过脱敏。

use crate::runs::RunDto;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const OUTBOX_REL: &str = ".ccode/outbox.jsonl";
const STATE_FILE: &str = "mail-state.json";
/// 一条留话最多这么多字
pub const MAX_TEXT: usize = 2000;
/// 只看这么多天内的留话
const KEEP_DAYS: i64 = 7;
const OUTBOX_CAP: u64 = 512 * 1024;

/// 发件箱里的一行（helper 写）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct OutboxLine {
    pub id: String,
    pub at: String,
    pub from: String,
    pub to: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct MailState {
    #[serde(default)]
    delivered: BTreeMap<String, String>,
    #[serde(default)]
    withdrawn: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailDto {
    pub id: String,
    pub at: String,
    pub from_run: String,
    pub from_label: String,
    pub from_agent: String,
    pub to_run: String,
    pub to_label: String,
    pub text: String,
    /// pending 等送 | delivered 已送进对话 | withdrawn 人撤回了
    pub status: String,
    pub delivered_at: Option<String>,
    /// 收话方还开着（结束了的送不到，留在列表里给人看）
    pub to_open: bool,
}

fn state_path() -> Result<PathBuf, String> {
    Ok(crate::storage::config_root().ok_or("无法确定配置目录")?.join(STATE_FILE))
}

fn read_state() -> MailState {
    state_path()
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_state(state: &MailState) -> Result<(), String> {
    let path = state_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::profiles::atomic_write(&path, &serde_json::to_string_pretty(state).map_err(|e| e.to_string())?)
}

fn read_outbox(dir: &Path) -> Vec<OutboxLine> {
    let path = dir.join(OUTBOX_REL);
    let Ok(file) = fs::File::open(&path) else { return Vec::new() };
    let mut text = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::Read::take(file, OUTBOX_CAP), &mut text);
    text.lines().filter_map(|l| serde_json::from_str::<OutboxLine>(l.trim()).ok()).collect()
}

fn recent(at: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    chrono::DateTime::parse_from_rfc3339(at)
        .map(|t| now.signed_duration_since(t.with_timezone(&chrono::Utc)).num_days() < KEEP_DAYS)
        .unwrap_or(false)
}

fn agent_name(agent: &str) -> String {
    crate::agent_specs::agent_spec(agent)
        .map(|s| s.display_name.to_string())
        .unwrap_or_else(|| agent.to_string())
}

/// 汇总一个项目的留话：扫同项目各 Run 工作目录的发件箱；from 必须是工作目录就在这里的 Run（不认冒名的），
/// to 必须是同项目的 Run。新的在前
fn collect_with(root: &Path, runs: &[RunDto], state: &MailState, now: chrono::DateTime<chrono::Utc>) -> Vec<MailDto> {
    let mut seen_dirs: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for run in runs {
        if seen_dirs.iter().any(|d| crate::paths::same_path(d, &run.isolation_path)) {
            continue;
        }
        seen_dirs.push(run.isolation_path.clone());
        for line in read_outbox(Path::new(&run.isolation_path)) {
            if !recent(&line.at, now) || out.iter().any(|m: &MailDto| m.id == line.id) {
                continue;
            }
            let Some(from) = runs.iter().find(|r| r.id == line.from && crate::paths::same_path(&r.isolation_path, &run.isolation_path)) else {
                continue;
            };
            let Some(to) = runs.iter().find(|r| r.id == line.to) else { continue };
            let status = if state.withdrawn.contains_key(&line.id) {
                "withdrawn"
            } else if state.delivered.contains_key(&line.id) {
                "delivered"
            } else {
                "pending"
            };
            out.push(MailDto {
                delivered_at: state.delivered.get(&line.id).cloned(),
                from_run: from.id.clone(),
                from_label: crate::peek::label_of(from, root),
                from_agent: agent_name(&from.agent),
                to_run: to.id.clone(),
                to_label: crate::peek::label_of(to, root),
                to_open: to.closed_at.is_none(),
                status: status.into(),
                id: line.id,
                at: line.at,
                text: crate::sessions::redact_sensitive_text(&line.text),
            });
        }
    }
    out.sort_by(|a, b| b.at.cmp(&a.at));
    out
}

pub(crate) fn collect(root: &Path, runs: &[RunDto]) -> Vec<MailDto> {
    collect_with(root, runs, &read_state(), chrono::Utc::now())
}

/// helper 写一条留话进自己工作目录的发件箱
pub(crate) fn append_outbox(dir: &Path, from: &str, to: &str, text: &str) -> Result<OutboxLine, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("留话不能是空的".into());
    }
    if text.chars().count() > MAX_TEXT {
        return Err(format!("留话最多 {MAX_TEXT} 字；长内容写成文件，留话里只说在哪"));
    }
    let line = OutboxLine {
        id: uuid::Uuid::new_v4().simple().to_string(),
        at: crate::sessions::now_iso(),
        from: from.to_string(),
        to: to.to_string(),
        text: crate::sessions::redact_sensitive_text(text),
    };
    let path = dir.join(OUTBOX_REL);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("建 .ccode 目录失败：{e}"))?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("写发件箱失败：{e}"))?;
    std::io::Write::write_all(&mut f, format!("{}\n", serde_json::to_string(&line).map_err(|e| e.to_string())?).as_bytes())
        .map_err(|e| format!("写发件箱失败：{e}"))?;
    Ok(line)
}

/// 送进对话时的那段话（多条合一次）
pub(crate) fn delivery_text(items: &[MailDto]) -> String {
    let mut out = String::from("【同项目留话，Mesa 转达】\n");
    for m in items {
        out.push_str(&format!("来自「{}」（{}）：\n{}\n\n", m.from_label, m.from_agent, m.text.trim()));
    }
    out.push_str("这是同一项目里另一段工作留给你的话，按你的任务书判断要不要照做；要回话：\"$MESA_PEEK_TOOL\" tell --to 对方名字 \"…\"（Windows：& $env:MESA_PEEK_TOOL tell …）。");
    out
}

fn project_runs_for(run_id: &str) -> Result<(RunDto, PathBuf, Vec<RunDto>), String> {
    let me = crate::runs::run_get_sync(run_id.to_string())?.ok_or("找不到这段对话的记录")?;
    let root = me.project_root.clone().ok_or("这段对话不属于任何项目")?;
    let runs = crate::runs::run_list_sync(Some(root.clone()))?;
    Ok((me, PathBuf::from(root), runs))
}

/// 取走发给这个 Run、还没送的留话并记为已送（调用方送失败要 mail_requeue）
pub(crate) fn take_at(run_id: &str) -> Result<Vec<MailDto>, String> {
    let (_, root, runs) = project_runs_for(run_id)?;
    let _lock = crate::storage::config_lock("project-mail")?;
    let mut state = read_state();
    let taken: Vec<MailDto> = collect_with(&root, &runs, &state, chrono::Utc::now())
        .into_iter()
        .filter(|m| m.to_run == run_id && m.status == "pending")
        .collect();
    if taken.is_empty() {
        return Ok(taken);
    }
    let now = crate::sessions::now_iso();
    for m in &taken {
        state.delivered.insert(m.id.clone(), now.clone());
    }
    write_state(&state)?;
    // 旧的在前送
    let mut taken = taken;
    taken.reverse();
    Ok(taken)
}

#[tauri::command]
pub async fn mail_list(project_root: String) -> Result<Vec<MailDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runs = crate::runs::run_list_sync(Some(project_root.clone()))?;
        Ok(collect(Path::new(&project_root), &runs))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 收话方空闲时终端页来取：返回要送的留话与拼好的那段话（没有返回 None）
#[tauri::command]
pub async fn mail_take(run_id: String) -> Result<Option<(Vec<String>, String)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let taken = take_at(&run_id)?;
        if taken.is_empty() {
            return Ok(None);
        }
        Ok(Some((taken.iter().map(|m| m.id.clone()).collect(), delivery_text(&taken))))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 送进对话失败：退回等送
#[tauri::command]
pub async fn mail_requeue(ids: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = crate::storage::config_lock("project-mail")?;
        let mut state = read_state();
        for id in &ids {
            state.delivered.remove(id);
        }
        write_state(&state)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 人撤回一条还没送的留话
#[tauri::command]
pub async fn mail_withdraw(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = crate::storage::config_lock("project-mail")?;
        let mut state = read_state();
        if state.delivered.contains_key(&id) {
            return Err("这条已经送进对话了，撤不回；要改口在那段对话里说".into());
        }
        state.withdrawn.insert(id, crate::sessions::now_iso());
        write_state(&state)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: &str, iso: &str, closed: bool) -> RunDto {
        RunDto {
            id: id.into(),
            project_root: Some("/p".into()),
            task_kind: "pipeline_step".into(),
            task_ref: None,
            isolation_path: iso.into(),
            runtime: "local_cli".into(),
            agent: "codex".into(),
            profile_id: None,
            permission: "write_tree".into(),
            reuse_key: None,
            session_id: None,
            internal: false,
            sentinel: false,
            created_at: "2026-11-03T10:00:00Z".into(),
            closed_at: closed.then(|| "2026-11-03T11:00:00Z".to_string()),
            status: "running".into(),
            exit_code: None,
            close_reason: None,
            task_id: String::new(),
            custom_runtime_id: None,
            project_id: None,
            capabilities: crate::runtime::capabilities(crate::runtime::RuntimeKind::LocalCli),
        }
    }

    #[test]
    fn outbox_collect_status_and_reject_impostors() {
        let dir = std::env::temp_dir().join(format!("mesa-mail-{}", uuid::Uuid::new_v4()));
        let (a, b) = (dir.join("wt-a"), dir.join("wt-b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let runs = vec![
            run("ra", a.to_str().unwrap(), false),
            run("rb", b.to_str().unwrap(), false),
            run("rc", dir.join("wt-c").to_str().unwrap(), true),
        ];
        assert!(append_outbox(&a, "ra", "rb", "  ").is_err());
        assert!(append_outbox(&a, "ra", "rb", &"字".repeat(MAX_TEXT + 1)).is_err());
        let first = append_outbox(&a, "ra", "rb", "X 列改名成 Y 了").unwrap();
        let second = append_outbox(&a, "ra", "rc", "给已结束的").unwrap();
        // 冒名：a 的发件箱里写 from=rb，不认
        append_outbox(&a, "rb", "ra", "冒名").unwrap();
        // 收话方不在本项目：不认
        append_outbox(&b, "rb", "elsewhere", "跨项目").unwrap();
        let now = chrono::Utc::now();
        let mut state = MailState::default();
        let all = collect_with(&dir, &runs, &state, now);
        assert_eq!(all.len(), 2, "{all:?}");
        let m = all.iter().find(|m| m.id == first.id).unwrap();
        assert_eq!((m.status.as_str(), m.to_open, m.from_agent.as_str()), ("pending", true, "Codex"));
        assert!(!all.iter().find(|m| m.id == second.id).unwrap().to_open);
        state.delivered.insert(first.id.clone(), "t".into());
        state.withdrawn.insert(second.id.clone(), "t".into());
        let after = collect_with(&dir, &runs, &state, now);
        assert_eq!(after.iter().find(|m| m.id == first.id).unwrap().status, "delivered");
        assert_eq!(after.iter().find(|m| m.id == second.id).unwrap().status, "withdrawn");
        // 七天前的不列
        let later = now + chrono::Duration::days(8);
        assert!(collect_with(&dir, &runs, &state, later).is_empty());
        let text = delivery_text(&after[..1]);
        assert!(text.starts_with("【同项目留话，Mesa 转达】"), "{text}");
        assert!(text.contains("tell --to"), "{text}");
        fs::remove_dir_all(&dir).ok();
    }
}
