//! 项目助手唯一真源（2026-11-24「真 Agent 化」立项重构）：
//! - 统一从 Rust 侧读取 `app.db`（workspaces / tasks / runs / human_task_checks）、`project.toml`、
//!   核验文件、人工请求、项目知识、定时任务、研讨与内置说明书，彻底取代前端 17 路拼装快照。
//! - 同时服务两端：
//!   1. `mesa_helper assistant-mcp`（stdio MCP Server）按需给只读 Agent 供数；
//!   2. `assistant_project_brief`（Tauri 命令）给前端顶部状态条、飞书与桌宠供数，以及给第二档 CLI 生成精简真源上下文。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::paths::{path_within, same_path};
use crate::project_assistant::{
    assistant_log_read_sync, mesa_errors_read_sync, project_map_sync, review_notes_sync,
    MesaErrorDto,
};
use crate::projects::{read_config_at, ProjectDto, StepDto};
use crate::research_record::{read_checks_at, CheckItem};
use crate::runs::{run_list_sync, task_list_sync, RunDto, TaskDto};
use crate::sessions::{expand_tilde, redact_sensitive_text};
use crate::workspaces::{db, health_impl, list_human_task_states_at, list_workspaces_sync, WorkspaceDto};

const BUILTIN_TASK_NAMES: &[&str] = &[
    "组会汇报",
    "进展周报",
    "实验规划",
    "审改已有稿件",
    "审稿意见回复",
    "换刊适配与投稿材料",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewStepDto {
    pub index: usize,
    pub n: u32,
    pub name: String,
    pub workspace_name: String,
    pub state: String,
    /// idle | working | confirm | failed | review | saved | open
    pub brief_state: String,
    pub saved: bool,
    pub archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_upstream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    pub checks_blocked: usize,
    pub checks_needs_human: usize,
    pub human_done: usize,
    pub human_total: usize,
    pub pending_next_actions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewGoalDto {
    pub id: String,
    pub name: String,
    pub status: String,
    pub status_label: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isolation_path: Option<String>,
    pub output_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewHelpDto {
    pub where_label: String,
    pub question: String,
    pub options: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommend: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewScheduleDto {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger: String,
    pub skill: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub followup_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseoutSummaryDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_journal: Option<String>,
    pub final_files: Vec<String>,
    pub check_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewDispatchDto {
    pub at: String,
    pub title: String,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<u32>,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub echoed: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverviewDto {
    pub now: String,
    pub name: String,
    pub path: String,
    pub work_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    pub settings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_agent: Option<String>,
    pub has_pipeline: bool,
    pub saved_steps: usize,
    pub total_steps: usize,
    pub progress_summary: String,
    pub steps: Vec<OverviewStepDto>,
    pub goals: Vec<OverviewGoalDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closeout: Option<CloseoutSummaryDto>,
    pub help_items: Vec<OverviewHelpDto>,
    pub schedules: Vec<OverviewScheduleDto>,
    pub dispatches: Vec<OverviewDispatchDto>,
    pub installed_skills: Vec<String>,
    pub user_task_packs: Vec<String>,
    pub builtin_tasks: Vec<String>,
    pub knowledge_empty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepCheckOutDto {
    pub status: String,
    pub source: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRunOutDto {
    pub created_at: String,
    pub agent: String,
    pub status: String,
    pub before_saved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepDetailDto {
    pub n: u32,
    pub name: String,
    pub workspace_name: String,
    pub state: String,
    pub saved: bool,
    pub archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    pub brief: String,
    pub expected_artifacts: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    pub checks: Vec<StepCheckOutDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_notes: Option<String>,
    pub human_done: usize,
    pub human_total: usize,
    pub human_pending: Vec<String>,
    pub human_optional_pending: Vec<String>,
    pub pending_next_actions: Vec<String>,
    pub recent_runs: Vec<StepRunOutDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntryOutDto {
    pub path: String,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListResultDto {
    pub total_matched: usize,
    pub truncated: bool,
    pub entries: Vec<FileEntryOutDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentErrorsResultDto {
    pub days: i64,
    pub run_failures: Vec<String>,
    pub mesa_errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectKnowledgeOutDto {
    pub included: usize,
    pub omitted: usize,
    pub stale: usize,
    pub lines: Vec<String>,
    pub research_profile: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsultSummaryOutDto {
    pub title: String,
    pub updated_at: String,
    pub summary: String,
}

fn clip(text: &str, max_chars: usize) -> String {
    let t = text.trim();
    if t.chars().count() <= max_chars {
        return t.to_string();
    }
    let mut s: String = t.chars().take(max_chars).collect();
    s.push('…');
    s
}

fn is_declared_task_name(name: &str) -> bool {
    let t = name.trim();
    if t.is_empty() || t.starts_with('/') || t.starts_with('~') || t.starts_with("\\\\") {
        return false;
    }
    let bytes = t.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    true
}

/// 唯一真源目标判定：与前端 `visibleDeclaredTasks(tasks, declaredTaskKindsForMode(workMode))` 严格同口径。
/// 自动登记的 `pipeline_step` / 绝对路径名称任务绝不进入目标列表。
pub(crate) fn is_declared_goal(task: &TaskDto, work_mode: &str) -> bool {
    if task.archived_at.is_some() {
        return false;
    }
    if task.kind == "step" || task.kind == "pipeline_step" {
        return false;
    }
    let kind_ok = match work_mode {
        "office" => task.kind == "office_doc",
        "research" => task.kind == "free_research",
        "coding" => false,
        _ => true,
    };
    kind_ok && (task.declared || is_declared_task_name(&task.name))
}

fn goal_status_label(status: &str) -> &'static str {
    match status {
        "pending_review" => "做完了，等你验收",
        "running" => "正在做",
        "failed" => "上次失败",
        "stopped" => "上次停了",
        "completed" => "已验收完成",
        _ => "未开始",
    }
}

fn is_app_crash_close(run: &RunDto) -> bool {
    let reason = run.close_reason.as_deref().unwrap_or("");
    reason == "app_exit"
        || reason == "app_crash"
        || reason.contains("应用上次异常退出")
        || reason.contains("Run 未能正常收尾")
        || (run.status == "failed" && run.exit_code.is_none() && reason.is_empty())
}

fn run_failure_text(run: &RunDto) -> String {
    if is_app_crash_close(run) {
        return "Mesa 上次异常退出导致运行中断".into();
    }
    if let Some(reason) = run.close_reason.as_deref().filter(|s| !s.trim().is_empty()) {
        return reason.to_string();
    }
    if let Some(code) = run.exit_code {
        return format!("退出码 {code}");
    }
    "运行失败".into()
}

fn timestamp_before_or_eq(a: &str, b: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(a).ok(),
        chrono::DateTime::parse_from_rfc3339(b).ok(),
    ) {
        (Some(ta), Some(tb)) => ta <= tb,
        _ => a <= b,
    }
}

fn parse_target_journal(text: &str) -> Option<String> {
    for raw in text.lines() {
        let line = raw.trim().trim_start_matches(['#', '-', '*', ' ']).trim();
        if line.is_empty() || line.starts_with("<!--") {
            continue;
        }
        if let Some(rest) = line
            .strip_prefix("目标期刊：")
            .or_else(|| line.strip_prefix("目标期刊:"))
            .or_else(|| line.strip_prefix("Target journal:"))
            .or_else(|| line.strip_prefix("Journal:"))
        {
            let v = rest.trim();
            if !v.is_empty() {
                return Some(clip(&redact_sensitive_text(v), 120));
            }
        }
        if !line.starts_with("```") && line.chars().count() >= 3 && line.chars().count() <= 120 {
            return Some(clip(&redact_sensitive_text(line), 120));
        }
    }
    None
}

fn read_pending_next_actions(project_root: &Path, step: &StepDto, worktree: Option<&Path>) -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(wt) = worktree {
        candidates.push(wt.join(".ccode/step-next").join(format!("{}.json", step.workspace_name)));
    }
    candidates.push(project_root.join(".ccode/step-next").join(format!("{}.json", step.workspace_name)));
    for path in candidates {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let mut out = Vec::new();
        for key in ["required", "optional", "actions", "items"] {
            if let Some(arr) = v.get(key).and_then(|x| x.as_array()) {
                for item in arr {
                    let done = item.get("done").and_then(|x| x.as_bool()).unwrap_or(false);
                    if done {
                        continue;
                    }
                    if let Some(label) = item
                        .get("label")
                        .or_else(|| item.get("title"))
                        .and_then(|x| x.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        if !out.iter().any(|x| x == label) {
                            out.push(clip(label, 100));
                        }
                    }
                }
            }
        }
        if !out.is_empty() {
            return out.into_iter().take(6).collect();
        }
    }
    Vec::new()
}

fn has_knowledge_sources(project_root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(project_root) else {
        return false;
    };
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if matches!(
            name.as_str(),
            "readme.md" | "readme.txt" | "claude.md" | "agents.md" | "style-guide.md" | "writing-guide.md"
        ) || name.contains("规范")
            || name.contains("约定")
            || name.contains("指南")
        {
            return true;
        }
    }
    false
}

fn collect_closeout(project_root: &Path) -> Option<CloseoutSummaryDto> {
    let final_candidates = [
        ("定稿 PDF", "output/review-final.pdf"),
        ("普通 Word", "output/review-final.docx"),
        ("EndNote 域稿", "output/endnote.docx"),
        ("Zotero 域稿", "output/zotero.docx"),
        ("论文 PDF", "output/manuscript.pdf"),
        ("论文 Word", "output/manuscript.docx"),
        ("初稿 PDF", "output/draft.pdf"),
        ("初稿 Word", "output/draft.docx"),
    ];
    let mut final_files = Vec::new();
    for (label, rel) in final_candidates {
        if project_root.join(rel).is_file() {
            final_files.push(format!("{label}（{rel}）"));
        }
    }
    let check_candidates = [
        ("审查报告", "manuscript/review-report.md"),
        ("转载许可清单", "submission/figure-permissions.md"),
        ("投稿声明与作者信息", "submission/declarations.md"),
        ("审稿回复信", "submission/response-letter.md"),
        ("图表清单", "figures/README.md"),
    ];
    let mut check_files = Vec::new();
    for (label, rel) in check_candidates {
        if project_root.join(rel).is_file() {
            check_files.push(format!("{label}（{rel}）"));
        }
    }
    let target_journal = fs::read_to_string(project_root.join("submission/target-journal.md"))
        .ok()
        .and_then(|t| parse_target_journal(&t));
    if final_files.is_empty() && check_files.is_empty() && target_journal.is_none() {
        return None;
    }
    Some(CloseoutSummaryDto {
        target_journal,
        final_files,
        check_files,
    })
}

fn schedule_trigger_label(s: &crate::scheduler::ScheduleDto) -> String {
    if let Some(ev) = &s.event {
        return format!("事件触发（{:?}）", ev);
    }
    match s.frequency.as_str() {
        "daily" => format!("每天 {:02}:{:02}", s.hour, s.minute),
        "weekly" => format!("每周{} {:02}:{:02}", s.weekday.unwrap_or(1), s.hour, s.minute),
        "interval" => format!("每 {} 小时", s.interval_hours.unwrap_or(6)),
        "manual" => "仅手动".into(),
        other => other.to_string(),
    }
}

fn resolve_project_meta(root_str: &str) -> (Option<ProjectDto>, crate::projects::ProjectConfigDto) {
    let project = db()
        .ok()
        .and_then(|conn| crate::projects::list_projects_in(&conn).ok())
        .and_then(|list| list.into_iter().find(|p| same_path(&p.path, root_str)));
    let cfg = read_config_at(Path::new(root_str)).config;
    (project, cfg)
}

fn latest_unresolved_step_failure(runs: &[RunDto], worktree_path: &str, merged_at: Option<&str>) -> Option<String> {
    let hit = runs
        .iter()
        .filter(|r| !r.internal && path_within(&r.isolation_path, worktree_path))
        .max_by(|a, b| a.created_at.cmp(&b.created_at))?;
    if hit.status != "failed" || is_app_crash_close(hit) {
        return None;
    }
    if let Some(saved) = merged_at {
        if timestamp_before_or_eq(&hit.created_at, saved) {
            return None;
        }
    }
    Some(run_failure_text(hit))
}

fn build_step_overview(
    project_root: &Path,
    steps: &[StepDto],
    mine_ws: &[WorkspaceDto],
    runs: &[RunDto],
    human_states: &[crate::workspaces::HumanTaskStateDto],
) -> Vec<OverviewStepDto> {
    let conn = db().ok();
    steps
        .iter()
        .enumerate()
        .map(|(index, s)| {
            let n = (index + 1) as u32;
            let active = mine_ws
                .iter()
                .find(|w| w.name == s.workspace_name && w.status != "archived");
            let archived_merged = if active.is_none() {
                mine_ws
                    .iter()
                    .find(|w| w.name == s.workspace_name && w.status == "archived" && w.merged_at.is_some())
            } else {
                None
            };
            let h_items: Vec<_> = human_states
                .iter()
                .filter(|h| h.step == s.name && !h.optional)
                .collect();
            let human_total = h_items.len();
            let human_done = h_items.iter().filter(|h| h.done).count();

            if let Some(ws) = active {
                let health = conn.as_ref().and_then(|c| health_impl(c, &ws.id).ok());
                let failure = latest_unresolved_step_failure(runs, &ws.worktree_path, ws.merged_at.as_deref());
                let conflict = health.as_ref().and_then(|h| h.conflict).unwrap_or(false);
                let ahead = health.as_ref().map(|h| h.ahead).unwrap_or(0);
                let uncommitted = health.as_ref().map(|h| h.uncommitted).unwrap_or(false);
                let is_saved = ws.merged_at.is_some() && ahead == 0 && !conflict;
                let checks = if is_saved {
                    Vec::new()
                } else {
                    read_checks_at(Path::new(&ws.worktree_path)).items
                };
                let checks_blocked = checks.iter().filter(|c| c.status == "blocked").count();
                let checks_needs_human = checks.iter().filter(|c| c.status == "needs_human").count();
                let (mut state_text, brief_state) = if conflict {
                    ("有冲突，等你在评审里处理".to_string(), "review")
                } else if is_saved {
                    ("已保存进项目".to_string(), "saved")
                } else if failure.is_some() {
                    ("出错了".to_string(), "failed")
                } else if ahead > 0 {
                    ("做完了，等你评审、保存进项目".to_string(), "review")
                } else if uncommitted {
                    ("进行中，工作副本里有未提交改动".to_string(), "open")
                } else {
                    ("进行中".to_string(), "open")
                };
                if let Some(up) = ws.stale_upstream.as_deref() {
                    if !conflict && brief_state != "failed" {
                        state_text.push_str(&format!("（上游「{up}」有新保存的内容待跟进）"));
                    }
                }
                let pending_next_actions = read_pending_next_actions(
                    project_root,
                    s,
                    if is_saved { None } else { Some(Path::new(&ws.worktree_path)) },
                );
                OverviewStepDto {
                    index,
                    n,
                    name: s.name.clone(),
                    workspace_name: s.workspace_name.clone(),
                    state: state_text,
                    brief_state: brief_state.into(),
                    saved: is_saved,
                    archived: false,
                    merged_at: ws.merged_at.clone(),
                    stale_upstream: ws.stale_upstream.clone(),
                    worktree_path: Some(ws.worktree_path.clone()),
                    checks_blocked,
                    checks_needs_human,
                    human_done,
                    human_total,
                    pending_next_actions,
                    failure,
                }
            } else if let Some(arch) = archived_merged {
                let pending_next_actions = read_pending_next_actions(project_root, s, None);
                OverviewStepDto {
                    index,
                    n,
                    name: s.name.clone(),
                    workspace_name: s.workspace_name.clone(),
                    state: "已保存进项目（已收起临时副本，最终产物均已保留在项目主文件夹）".into(),
                    brief_state: "saved".into(),
                    saved: true,
                    archived: true,
                    merged_at: arch.merged_at.clone(),
                    stale_upstream: None,
                    worktree_path: None,
                    checks_blocked: 0,
                    checks_needs_human: 0,
                    human_done,
                    human_total,
                    pending_next_actions,
                    failure: None,
                }
            } else {
                let saved = s.seed_complete;
                OverviewStepDto {
                    index,
                    n,
                    name: s.name.clone(),
                    workspace_name: s.workspace_name.clone(),
                    state: if saved { "已完成（示例预置）" } else { "还没开始" }.into(),
                    brief_state: if saved { "saved" } else { "idle" }.into(),
                    saved,
                    archived: false,
                    merged_at: None,
                    stale_upstream: None,
                    worktree_path: None,
                    checks_blocked: 0,
                    checks_needs_human: 0,
                    human_done,
                    human_total,
                    pending_next_actions: Vec::new(),
                    failure: None,
                }
            }
        })
        .collect()
}

/// 1. 项目总览（唯一真源）：总进度、步骤简要、显式声明目标、完结产物、人工请求、定时任务、能力清单
pub(crate) fn project_overview(project_root: &str) -> Result<ProjectOverviewDto, String> {
    let root_str = expand_tilde(project_root.trim());
    let root = PathBuf::from(&root_str);
    if !root.is_dir() {
        return Err("项目文件夹不存在".into());
    }
    let (project, cfg) = resolve_project_meta(&root_str);
    let work_mode = project
        .as_ref()
        .map(|p| p.work_mode.clone())
        .unwrap_or_else(|| "research".into());
    let all_ws = list_workspaces_sync().unwrap_or_default();
    let mine_ws: Vec<WorkspaceDto> = all_ws
        .into_iter()
        .filter(|w| same_path(&w.repo_path, &root_str))
        .collect();
    let runs = run_list_sync(Some(root_str.clone())).unwrap_or_default();
    let tasks = task_list_sync(Some(root_str.clone()), Some(false)).unwrap_or_default();
    let human_states = list_human_task_states_at(&root);

    let steps = build_step_overview(&root, &cfg.steps, &mine_ws, &runs, &human_states);
    let total_steps = steps.len();
    let saved_steps = steps.iter().filter(|s| s.saved).count();
    let progress_summary = if total_steps == 0 {
        "该项目未套用研究流程，按独立目标或对话开展工作。".into()
    } else if saved_steps == total_steps {
        format!(
            "当前总进度：{saved_steps}/{total_steps} 步已全部保存进项目（主流程已完成；已收起临时副本属于正常归档，最终产物均已保留在项目主文件夹）。"
        )
    } else {
        format!("当前总进度：{saved_steps}/{total_steps} 步已保存进项目。")
    };

    let mut goals: Vec<OverviewGoalDto> = tasks
        .iter()
        .filter(|t| is_declared_goal(t, &work_mode))
        .map(|t| {
            let isolation_path = runs
                .iter()
                .filter(|r| {
                    !r.internal
                        && r.task_id == t.id
                        && !r.isolation_path.is_empty()
                        && !same_path(&r.isolation_path, &root_str)
                })
                .max_by(|a, b| a.created_at.cmp(&b.created_at))
                .map(|r| r.isolation_path.clone())
                .filter(|p| Path::new(p).is_dir());
            OverviewGoalDto {
                id: t.id.clone(),
                name: t.name.clone(),
                status: t.status.clone(),
                status_label: goal_status_label(&t.status).into(),
                updated_at: t.updated_at.clone(),
                isolation_path,
                output_paths: t.output_paths.clone(),
            }
        })
        .collect();
    goals.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    goals.truncate(12);

    let help_items: Vec<OverviewHelpDto> = crate::help_requests::list_help_requests_sync()
        .into_iter()
        .filter(|h| same_path(&h.repo_path, &root_str))
        .flat_map(|h| {
            let where_label = h
                .workspace_name
                .map(|w| format!("工作副本「{w}」"))
                .unwrap_or_else(|| "项目根".into());
            h.items.into_iter().filter(|i| i.answer.is_none()).map(move |i| OverviewHelpDto {
                where_label: where_label.clone(),
                question: clip(&i.question, 200),
                options: i
                    .options
                    .into_iter()
                    .take(5)
                    .map(|o| format!("{}：{}", o.key, o.label))
                    .collect(),
                recommend: i.recommend,
            })
        })
        .take(12)
        .collect();

    let schedules: Vec<OverviewScheduleDto> = crate::scheduler::list_schedules_readonly_for(&root_str)
        .into_iter()
        .take(10)
        .map(|s| {
            let trigger = schedule_trigger_label(&s);
            let status = s
                .paused_reason
                .clone()
                .or_else(|| s.last_status.clone())
                .unwrap_or_else(|| if s.enabled { "等待触发" } else { "已暂停" }.into());
            OverviewScheduleDto {
                id: s.id,
                name: s.name,
                enabled: s.enabled,
                trigger,
                skill: s.skill,
                status: clip(&status, 120),
                followup_state: s.followup_state,
            }
        })
        .collect();

    let dispatches: Vec<OverviewDispatchDto> = assistant_log_read_sync(&root_str)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|t| {
            let d = t.dispatched?;
            Some(OverviewDispatchDto {
                at: d.at,
                title: d.title,
                target: d.target,
                step: d.step,
                mode: d.mode,
                echoed: d.echoed,
            })
        })
        .rev()
        .take(6)
        .collect();

    let installed_skills: Vec<String> = crate::skills::list_skills_sync()
        .into_iter()
        .map(|s| s.name)
        .take(40)
        .collect();
    let user_task_packs: Vec<String> = crate::task_packs::packs_root()
        .ok()
        .map(|dir| crate::task_packs::list_at(&dir).into_iter().map(|p| p.name).take(20).collect())
        .unwrap_or_default();

    let knowledge_empty = crate::project_memory::read_at(&root)
        .ok()
        .map(|doc| {
            let k = crate::project_memory::knowledge_for_ai(&doc, crate::project_memory::AI_KNOWLEDGE_CHAR_CAP);
            k.lines.is_empty() && k.stale == 0 && has_knowledge_sources(&root)
        })
        .unwrap_or(false);

    let name = project
        .as_ref()
        .map(|p| p.name.clone())
        .unwrap_or_else(|| {
            root.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| root_str.clone())
        });

    Ok(ProjectOverviewDto {
        now: chrono::Utc::now().to_rfc3339(),
        name,
        path: root_str,
        work_mode,
        topic: cfg.topic.filter(|s| !s.trim().is_empty()),
        settings: cfg.settings.into_iter().take(12).map(|s| clip(&s, 200)).collect(),
        default_agent: project.and_then(|p| p.default_agent),
        has_pipeline: total_steps > 0,
        saved_steps,
        total_steps,
        progress_summary,
        steps,
        goals,
        closeout: collect_closeout(&root),
        help_items,
        schedules,
        dispatches,
        installed_skills,
        user_task_packs,
        builtin_tasks: BUILTIN_TASK_NAMES.iter().map(|s| (*s).to_string()).collect(),
        knowledge_empty,
    })
}

/// 2. 单步详情（按需查询，不把 5 个步骤的全文一次性塞进每轮提示词）
pub(crate) fn step_detail(project_root: &str, step_n: u32) -> Result<StepDetailDto, String> {
    let root_str = expand_tilde(project_root.trim());
    let root = PathBuf::from(&root_str);
    let (_, cfg) = resolve_project_meta(&root_str);
    let idx = step_n.checked_sub(1).ok_or("步骤编号从 1 开始")? as usize;
    let step = cfg
        .steps
        .get(idx)
        .ok_or_else(|| format!("项目只有 {} 个步骤，没有第 {step_n} 步", cfg.steps.len()))?;

    let all_ws = list_workspaces_sync().unwrap_or_default();
    let mine_ws: Vec<WorkspaceDto> = all_ws
        .into_iter()
        .filter(|w| same_path(&w.repo_path, &root_str))
        .collect();
    let runs = run_list_sync(Some(root_str.clone())).unwrap_or_default();
    let human_states = list_human_task_states_at(&root);
    let overviews = build_step_overview(&root, &cfg.steps, &mine_ws, &runs, &human_states);
    let ov = &overviews[idx];

    let active_ws = mine_ws
        .iter()
        .find(|w| w.name == step.workspace_name && w.status != "archived");
    let any_ws = active_ws.or_else(|| mine_ws.iter().find(|w| w.name == step.workspace_name));

    let checks: Vec<StepCheckOutDto> = if let Some(ws) = active_ws {
        let mut items: Vec<CheckItem> = read_checks_at(Path::new(&ws.worktree_path))
            .items
            .into_iter()
            .filter(|c| c.status != "passed")
            .collect();
        items.sort_by_key(|c| if c.status == "blocked" { 0 } else { 1 });
        items
            .into_iter()
            .take(20)
            .map(|c| {
                let location = c.target.map(|t| match t.line {
                    Some(l) => format!("{}:{l}", t.file),
                    None => t.file,
                });
                let detail = c.evidence.and_then(|e| {
                    let raw = e.detail?;
                    let d = raw.trim();
                    (!d.is_empty()).then(|| clip(&redact_sensitive_text(d), 200))
                });
                StepCheckOutDto {
                    status: c.status,
                    source: c.checker,
                    title: clip(&redact_sensitive_text(&c.title), 140),
                    location,
                    detail,
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    let review_notes = active_ws.and_then(|ws| review_notes_sync(&ws.worktree_path));

    let mandatory: Vec<_> = human_states
        .iter()
        .filter(|h| h.step == step.name && !h.optional)
        .collect();
    let optional: Vec<_> = human_states
        .iter()
        .filter(|h| h.step == step.name && h.optional)
        .collect();

    let recent_runs: Vec<StepRunOutDto> = if let Some(ws) = any_ws {
        let mut matched: Vec<&RunDto> = runs
            .iter()
            .filter(|r| !r.internal && path_within(&r.isolation_path, &ws.worktree_path))
            .collect();
        matched.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        matched
            .into_iter()
            .take(6)
            .map(|r| {
                let before_saved = ws
                    .merged_at
                    .as_deref()
                    .is_some_and(|m| timestamp_before_or_eq(&r.created_at, m));
                let note = if r.status == "failed" {
                    Some(run_failure_text(r))
                } else {
                    r.close_reason.clone()
                };
                StepRunOutDto {
                    created_at: r.created_at.clone(),
                    agent: r.agent.clone(),
                    status: r.status.clone(),
                    before_saved,
                    note,
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    Ok(StepDetailDto {
        n: step_n,
        name: step.name.clone(),
        workspace_name: step.workspace_name.clone(),
        state: ov.state.clone(),
        saved: ov.saved,
        archived: ov.archived,
        merged_at: ov.merged_at.clone(),
        worktree_path: ov.worktree_path.clone(),
        brief: clip(&redact_sensitive_text(&step.brief), 1200),
        expected_artifacts: step.expected_artifacts.clone(),
        acceptance_criteria: step.acceptance_criteria.clone(),
        checks,
        review_notes,
        human_done: mandatory.iter().filter(|h| h.done).count(),
        human_total: mandatory.len(),
        human_pending: mandatory.iter().filter(|h| !h.done).map(|h| h.title.clone()).collect(),
        human_optional_pending: optional.iter().filter(|h| !h.done).map(|h| h.title.clone()).collect(),
        pending_next_actions: ov.pending_next_actions.clone(),
        recent_runs,
    })
}

/// 3. 项目文件清单（按前缀或子串过滤，按最近修改时间排序）
pub(crate) fn list_files(
    project_root: &str,
    prefix: Option<&str>,
    query: Option<&str>,
    limit: usize,
) -> Result<FileListResultDto, String> {
    let map = project_map_sync(project_root)?;
    let norm_prefix = prefix.map(|p| p.trim().trim_start_matches("./").replace('\\', "/").to_lowercase());
    let norm_query = query.map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty());
    let mut matched: Vec<FileEntryOutDto> = map
        .entries
        .into_iter()
        .filter(|e| {
            let low = e.path.to_lowercase();
            if let Some(ref pre) = norm_prefix {
                if !pre.is_empty() && !low.starts_with(pre) {
                    return false;
                }
            }
            if let Some(ref q) = norm_query {
                if !low.contains(q) {
                    return false;
                }
            }
            true
        })
        .map(|e| FileEntryOutDto {
            path: e.path,
            size: e.size,
            modified_ms: e.modified_ms,
        })
        .collect();
    matched.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.path.cmp(&b.path)));
    let total_matched = matched.len();
    let cap = limit.clamp(1, 200);
    let truncated = map.truncated || matched.len() > cap;
    matched.truncate(cap);
    Ok(FileListResultDto {
        total_matched,
        truncated,
        entries: matched,
    })
}

/// 过滤过时和已正常归档的 Mesa 报错噪点
pub(crate) fn filter_recent_mesa_errors(
    errors: Vec<MesaErrorDto>,
    archived_ws_names: &HashSet<String>,
    now: chrono::DateTime<chrono::FixedOffset>,
    days: i64,
) -> Vec<String> {
    let cutoff = now - chrono::Duration::days(days.clamp(1, 30));
    errors
        .into_iter()
        .filter(|e| {
            chrono::DateTime::parse_from_rfc3339(&e.at)
                .map(|t| t >= cutoff)
                .unwrap_or(false)
        })
        .filter(|e| {
            // 已正常归档收起的工作区，不再把「目录不存在 / No path was found」报成异常
            let missing_archived = e.message.contains("可能已被归档")
                || e.message.contains("目录不存在")
                || e.message.contains("No path was found")
                || e.message.contains("No such file");
            if missing_archived && archived_ws_names.iter().any(|w| e.message.contains(w)) {
                return false;
            }
            true
        })
        .rev()
        .take(12)
        .map(|e| {
            let count = if e.count > 1 { format!("（共 {} 次）", e.count) } else { String::new() };
            let cmd = if e.command.is_empty() { "界面提示" } else { e.command.as_str() };
            format!(
                "{} [{}]{}：{}",
                e.at,
                cmd,
                count,
                clip(&redact_sensitive_text(&e.message), 220)
            )
        })
        .collect()
}

/// 4. 近期真实错误（默认近 3 天，自动排除已保存步骤的历史失败与已归档副本的正常目录消失）
pub(crate) fn recent_errors(project_root: &str, days: i64) -> Result<RecentErrorsResultDto, String> {
    let root_str = expand_tilde(project_root.trim());
    let days = days.clamp(1, 30);
    let now = chrono::Local::now().fixed_offset();
    let cutoff = now - chrono::Duration::days(days);
    let all_ws = list_workspaces_sync().unwrap_or_default();
    let mine_ws: Vec<WorkspaceDto> = all_ws
        .into_iter()
        .filter(|w| same_path(&w.repo_path, &root_str))
        .collect();
    let archived_names: HashSet<String> = mine_ws
        .iter()
        .filter(|w| w.status == "archived")
        .map(|w| w.name.clone())
        .collect();

    let runs = run_list_sync(Some(root_str.clone())).unwrap_or_default();
    let mut run_failures = Vec::new();
    for r in runs.iter().filter(|r| !r.internal && r.status == "failed" && !is_app_crash_close(r)) {
        if let Ok(t) = chrono::DateTime::parse_from_rfc3339(&r.created_at) {
            if t < cutoff {
                continue;
            }
        }
        // 属于已保存步骤且发生在保存之前的旧失败，不作为当前故障
        if let Some(ws) = mine_ws.iter().find(|w| path_within(&r.isolation_path, &w.worktree_path)) {
            if let Some(saved) = ws.merged_at.as_deref() {
                if timestamp_before_or_eq(&r.created_at, saved) {
                    continue;
                }
            }
        }
        run_failures.push(format!(
            "{} {}（{}）：{}",
            r.created_at,
            r.agent,
            r.task_kind,
            run_failure_text(r)
        ));
        if run_failures.len() >= 10 {
            break;
        }
    }

    let raw_errors = mesa_errors_read_sync(&root_str, 50).unwrap_or_default();
    let mesa_errors = filter_recent_mesa_errors(raw_errors, &archived_names, now, days);
    Ok(RecentErrorsResultDto {
        days,
        run_failures,
        mesa_errors,
    })
}

/// 5. 项目长期知识 + 研究档案
pub(crate) fn project_knowledge(project_root: &str) -> Result<ProjectKnowledgeOutDto, String> {
    let root = PathBuf::from(expand_tilde(project_root.trim()));
    let k = crate::project_memory::read_at(&root)
        .map(|doc| crate::project_memory::knowledge_for_ai(&doc, crate::project_memory::AI_KNOWLEDGE_CHAR_CAP))
        .unwrap_or(crate::project_memory::KnowledgeForAi {
            lines: Vec::new(),
            included: 0,
            omitted: 0,
            omitted_ids: Vec::new(),
            stale: 0,
        });
    let profile = clip(&redact_sensitive_text(&crate::research_profile::context_text()), 1800);
    Ok(ProjectKnowledgeOutDto {
        included: k.included,
        omitted: k.omitted,
        stale: k.stale,
        lines: k.lines,
        research_profile: profile,
    })
}

/// 6. 最近多模型研讨摘要
pub(crate) fn recent_consults(project_root: &str, limit: usize) -> Result<Vec<ConsultSummaryOutDto>, String> {
    let root = PathBuf::from(expand_tilde(project_root.trim()));
    let mut list = crate::consult::list_at(&root);
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let mut out = Vec::new();
    for item in list.into_iter().take(limit.clamp(1, 5)) {
        let Ok(detail) = crate::consult::read_at(&root, &item.id) else {
            continue;
        };
        let last_user = detail
            .messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .map(|m| clip(&m.text, 100));
        let replies: Vec<String> = detail
            .messages
            .iter()
            .rev()
            .filter(|m| m.role == "member" && !m.text.trim().is_empty())
            .take(3)
            .map(|m| {
                let who = m.member.as_deref().unwrap_or("成员");
                let body = m.conclusion.as_deref().unwrap_or(&m.text);
                format!("{who}：{}", clip(body, 140))
            })
            .collect();
        let summary = redact_sensitive_text(&format!(
            "{}{}",
            last_user.map(|q| format!("问题「{q}」→ ")).unwrap_or_default(),
            if replies.is_empty() {
                "尚无回复".into()
            } else {
                replies.join("；")
            }
        ));
        out.push(ConsultSummaryOutDto {
            title: item.title,
            updated_at: item.updated_at,
            summary: clip(&summary, 420),
        });
    }
    Ok(out)
}

/// 精简真源文本：供第二档（暂不支持临时 MCP 注入的 CLI）直接作上下文，与第一档 MCP 共享 100% 同一真源。
pub(crate) fn render_compact_context(project_root: &str) -> Result<String, String> {
    let ov = project_overview(project_root)?;
    let errs = recent_errors(project_root, 3).ok();
    let kn = project_knowledge(project_root).ok();
    let mut out = vec![
        format!("# 项目现状（{}）", ov.now),
        format!("项目：{}（{}，工作方式：{}）", ov.name, ov.path, ov.work_mode),
        ov.progress_summary.clone(),
    ];
    if let Some(topic) = &ov.topic {
        out.push(format!("课题：{topic}"));
    }
    if !ov.settings.is_empty() {
        out.push(format!("项目规则：{}", ov.settings.join("；")));
    }
    if !ov.steps.is_empty() {
        out.push("## 流程步骤".into());
        for s in &ov.steps {
            let mut line = format!("- 第 {} 步「{}」：{}", s.n, s.name, s.state);
            if s.checks_blocked > 0 || s.checks_needs_human > 0 {
                line.push_str(&format!(
                    "（核验拦下 {}，待判断 {}）",
                    s.checks_blocked, s.checks_needs_human
                ));
            }
            if s.human_total > 0 {
                line.push_str(&format!("（人工事项 {}/{}）", s.human_done, s.human_total));
            }
            if !s.pending_next_actions.is_empty() {
                line.push_str(&format!("（后续建议：{}）", s.pending_next_actions.join("、")));
            }
            if let Some(f) = &s.failure {
                line.push_str(&format!("（出错：{f}）"));
            }
            out.push(line);
        }
    }
    if let Some(c) = &ov.closeout {
        out.push("## 完结产物与收尾".into());
        if let Some(j) = &c.target_journal {
            out.push(format!("- 目标期刊：{j}"));
        }
        if !c.final_files.is_empty() {
            out.push(format!("- 最终稿：{}", c.final_files.join("、")));
        }
        if !c.check_files.is_empty() {
            out.push(format!("- 收尾与核对文件：{}", c.check_files.join("、")));
        }
    }
    if !ov.goals.is_empty() {
        out.push("## 流程外目标".into());
        for g in &ov.goals {
            out.push(format!("- {}：{}", g.name, g.status_label));
        }
    }
    if !ov.help_items.is_empty() {
        out.push("## 待你回答的人工请求".into());
        for h in &ov.help_items {
            out.push(format!("- {}：{}", h.where_label, h.question));
        }
    }
    if !ov.schedules.is_empty() {
        out.push("## 定时任务".into());
        for s in &ov.schedules {
            out.push(format!(
                "- {}（{} · {}）：{}",
                s.name,
                if s.enabled { "已启用" } else { "已暂停" },
                s.trigger,
                s.status
            ));
        }
    }
    if let Some(e) = errs {
        if !e.run_failures.is_empty() || !e.mesa_errors.is_empty() {
            out.push(format!("## 近 {} 天未解决错误", e.days));
            for l in e.run_failures.iter().chain(e.mesa_errors.iter()) {
                out.push(format!("- {l}"));
            }
        }
    }
    if let Some(k) = kn {
        if !k.lines.is_empty() {
            out.push("## 项目知识（已定 / 不做）".into());
            for l in &k.lines {
                out.push(format!("- {l}"));
            }
        }
    }
    Ok(redact_sensitive_text(&out.join("\n")))
}

/// 顶部状态条 / 飞书状态卡 / 桌宠共用结构（直接对齐前端 `BriefInput`）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantBriefStepDto {
    pub n: u32,
    pub name: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_at: Option<String>,
    pub needs_human: usize,
    pub pending_upstream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantBriefGoalDto {
    pub id: String,
    pub name: String,
    pub status: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isolation_path: Option<String>,
    pub output_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UncertainScheduleDto {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantBriefDto {
    pub has_flow: bool,
    pub steps: Vec<AssistantBriefStepDto>,
    pub goals: Vec<AssistantBriefGoalDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    pub knowledge_empty: bool,
    pub uncertain_schedules: Vec<UncertainScheduleDto>,
}

/// 供前端状态条、飞书与桌宠直接拉取唯一真源（单次调用替代 8 路前端 IPC 拼装）
#[tauri::command]
pub async fn assistant_project_brief(
    project_root: String,
    since: Option<String>,
) -> Result<AssistantBriefDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ov = project_overview(&project_root)?;
        let steps = ov
            .steps
            .into_iter()
            .map(|s| AssistantBriefStepDto {
                n: s.n,
                name: s.name,
                state: s.brief_state,
                worktree_path: s.worktree_path,
                failure: s.failure,
                merged_at: s.merged_at,
                needs_human: s.checks_needs_human,
                pending_upstream: s.stale_upstream.is_some(),
                stale_upstream: s.stale_upstream,
            })
            .collect();
        let goals = ov
            .goals
            .into_iter()
            .map(|g| AssistantBriefGoalDto {
                id: g.id,
                name: g.name,
                status: g.status,
                updated_at: g.updated_at,
                isolation_path: g.isolation_path,
                output_paths: g.output_paths,
            })
            .collect();
        let uncertain_schedules = ov
            .schedules
            .into_iter()
            .filter(|s| s.followup_state.as_deref() == Some("uncertain"))
            .map(|s| UncertainScheduleDto { id: s.id, name: s.name })
            .collect();
        Ok(AssistantBriefDto {
            has_flow: ov.has_pipeline,
            steps,
            goals,
            since,
            knowledge_empty: ov.knowledge_empty,
            uncertain_schedules,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_task(kind: &str, name: &str, declared: bool) -> TaskDto {
        TaskDto {
            id: "t1".into(),
            project_root: Some("/p".into()),
            kind: kind.into(),
            task_ref: None,
            name: name.into(),
            description: String::new(),
            status: "failed".into(),
            input_paths: Vec::new(),
            output_paths: Vec::new(),
            review_required: true,
            archived_at: None,
            agent: None,
            profile_id: None,
            model: None,
            created_at: "2026-11-24T00:00:00Z".into(),
            updated_at: "2026-11-24T00:00:00Z".into(),
            declared,
            adopted_paths: Vec::new(),
            skills: Vec::new(),
            project_id: None,
            pending_apply_run_id: None,
            workspace_cleared: false,
            storage_cleanup_pending: false,
            review_cleared: false,
        }
    }

    #[test]
    fn declared_goal_filter_rejects_pipeline_steps_and_absolute_paths() {
        let pipe = sample_task("pipeline_step", "/Users/me/ccode/workspaces/p/polish", false);
        assert!(!is_declared_goal(&pipe, "research"));
        let undeclared_abs = sample_task("free_research", "/Users/me/ccode/workspaces/p/x", false);
        assert!(!is_declared_goal(&undeclared_abs, "research"));
        let real_goal = sample_task("free_research", "审稿意见回复", true);
        assert!(is_declared_goal(&real_goal, "research"));
        assert!(!is_declared_goal(&real_goal, "coding"));
        let office_goal = sample_task("office_doc", "季度总结", true);
        assert!(is_declared_goal(&office_goal, "office"));
        assert!(!is_declared_goal(&office_goal, "research"));
    }

    #[test]
    fn recent_mesa_errors_drops_old_and_archived_missing_dir_noise() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-24T14:00:00+08:00").unwrap();
        let archived: HashSet<String> = ["polish".to_string()].into_iter().collect();
        let rows = vec![
            MesaErrorDto {
                at: "2026-11-10T10:00:00+08:00".into(),
                first_at: "2026-11-10T10:00:00+08:00".into(),
                count: 1,
                source: "invoke".into(),
                command: "workspace_health".into(),
                message: "太旧的错误".into(),
                notice: None,
                version: "0.2.3".into(),
            },
            MesaErrorDto {
                at: "2026-11-24T13:00:00+08:00".into(),
                first_at: "2026-11-24T13:00:00+08:00".into(),
                count: 1,
                source: "invoke".into(),
                command: "workspace_health".into(),
                message: "polish 副本目录不存在（可能已被归档或删除）".into(),
                notice: None,
                version: "0.2.3".into(),
            },
            MesaErrorDto {
                at: "2026-11-24T13:55:00+08:00".into(),
                first_at: "2026-11-24T13:55:00+08:00".into(),
                count: 2,
                source: "invoke".into(),
                command: "set_project_agent_binding".into(),
                message: "这个模型不在所选连接里".into(),
                notice: None,
                version: "0.2.3".into(),
            },
        ];
        let kept = filter_recent_mesa_errors(rows, &archived, now, 3);
        assert_eq!(kept.len(), 1);
        assert!(kept[0].contains("这个模型不在所选连接里"));
        assert!(kept[0].contains("共 2 次"));
    }
}
