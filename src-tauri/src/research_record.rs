//! 核验记录与研究记录（2026-11-02，`docs/design-research-moat.md` §3.1 / §3.2）。
//!
//! - 核验脚本把结果写进 `<工作目录>/.ccode/checks/*.jsonl`（一行一条核验项）；评审页只读这里。
//! - Run 结束时把运行事实追加进项目 `.ccode/record.jsonl`（只追加、按 runId 去重），这次的核验项
//!   存档到 `.ccode/checks/runs/<runId>.jsonl`，再按记录整份重写 `.ccode/ai-usage.md`
//!   （AI 使用声明的事实依据，由 Mesa 统计，不靠 Agent 回忆）。
//! - 这些文件与 `acceptance-log.jsonl` 同口径：不进 git、合并闸门台账豁免（review_contract）。
//!
//! 核验项状态只有三档：passed（机器能确定的事实）/ blocked（机器确定有问题）/ needs_human；
//! 要读懂内容的检查最多到 needs_human，本模块不做任何「判通过」的推断。
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const CHECK_FILE_CAP: u64 = 4 * 1024 * 1024;
const CHECK_ITEM_CAP: usize = 5000;
const FIELD_CAP: usize = 2000;
const RECORD_CAP: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct CheckTarget {
    #[serde(default)]
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct CheckEvidence {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// 一条核验项。键名全是单词，Python 脚本与前端照写，不涉及大小写转换。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct CheckItem {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<CheckTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<CheckEvidence>,
    #[serde(default)]
    pub checker: String,
    #[serde(default)]
    pub at: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChecksDto {
    pub items: Vec<CheckItem>,
    /// 读到的核验文件（相对 `.ccode/checks/`）
    pub files: Vec<String>,
    /// 解析不了或状态不认识而跳过的行数（界面如实说「有 N 行读不懂」）
    pub skipped: usize,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckCounts {
    pub passed: usize,
    pub blocked: usize,
    pub needs_human: usize,
}

fn checks_dir(root: &Path) -> PathBuf {
    root.join(".ccode").join("checks")
}

pub(crate) fn record_path(root: &Path) -> PathBuf {
    root.join(".ccode").join("record.jsonl")
}

fn record_lock_path(root: &Path) -> PathBuf {
    root.join(".ccode").join("record.lock")
}

fn ai_usage_path(root: &Path) -> PathBuf {
    root.join(".ccode").join("ai-usage.md")
}

fn cap(text: &mut String) {
    if text.chars().count() > FIELD_CAP {
        *text = text.chars().take(FIELD_CAP).collect::<String>() + "…";
    }
}

fn cap_opt(text: &mut Option<String>) {
    if let Some(t) = text {
        cap(t);
    }
}

/// 核验脚本自己产出的文件（mesa_checks / cite_check 写的固定名）。只有这些文件里允许出现「通过」
const SCRIPT_CHECK_FILES: [&str; 7] = [
    "cite-refs.jsonl",
    "cite-quotes.jsonl",
    "num-check.jsonl",
    "stat-check.jsonl",
    "fig-check.jsonl",
    "cite-docx.jsonl",
    "ms-check.jsonl",
];

/// 核验文件出自谁：内置核验脚本的固定文件 / 任务包里的脚本（`pack-<包>-<名>.jsonl`，2026-11-03）/ 其余都算 Agent 的判断
#[derive(Debug, Clone, Copy, PartialEq)]
enum CheckSource {
    Script,
    Pack,
    Agent,
}

fn check_source(file_name: &str) -> CheckSource {
    if SCRIPT_CHECK_FILES.contains(&file_name) {
        CheckSource::Script
    } else if file_name.starts_with("pack-") {
        CheckSource::Pack
    } else {
        CheckSource::Agent
    }
}

/// 一行 → 核验项；状态不在三档内的不收（不猜它算哪档）。
/// 只有内置脚本的固定文件里允许「通过」：任务包脚本是用户写的，判「通过」同 Agent 一样降为待你判断（2026-11-03 拍板）
fn parse_check_line(line: &str, source: CheckSource, pack_file: &str) -> Option<CheckItem> {
    let mut item: CheckItem = serde_json::from_str(line).ok()?;
    if !matches!(item.status.as_str(), "passed" | "blocked" | "needs_human") {
        return None;
    }
    if item.id.trim().is_empty() || item.kind.trim().is_empty() || item.title.trim().is_empty() {
        return None;
    }
    match source {
        // 内置脚本文件里自称 Agent 的条目同样不准判通过
        CheckSource::Script => {
            if item.checker.starts_with("agent") && item.status == "passed" {
                item.status = "needs_human".into();
            }
        }
        // 检查器一律记成文件名，不认脚本自报的（防冒用内置脚本名）
        CheckSource::Pack => {
            item.checker = format!("pack:{}", pack_file.trim_end_matches(".jsonl").trim_start_matches("pack-"));
            if item.status == "passed" {
                item.status = "needs_human".into();
            }
        }
        // 脚本文件之外的（跨厂商复核等）一律是 Agent 的判断：没写或冒写检查器的记成 agent（2026-11-02 Kimi 真跑漏写 checker）
        CheckSource::Agent => {
            if !item.checker.starts_with("agent:") {
                item.checker = "agent".into();
            }
            // Agent 写的检查要读懂内容才能定，永不判通过：写成 passed 的一律按待你判断收
            if item.status == "passed" {
                item.status = "needs_human".into();
            }
        }
    }
    cap(&mut item.title);
    if let Some(ev) = item.evidence.as_mut() {
        cap_opt(&mut ev.source);
        cap_opt(&mut ev.quote);
        cap_opt(&mut ev.detail);
    }
    Some(item)
}

fn read_capped(path: &Path, limit: u64) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn parse_check_text(text: &str, out: &mut ChecksDto, file_name: &str) {
    let source = check_source(file_name);
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if out.items.len() >= CHECK_ITEM_CAP {
            out.skipped += 1;
            continue;
        }
        match parse_check_line(line, source, file_name) {
            Some(item) => out.items.push(item),
            None => out.skipped += 1,
        }
    }
}

/// 读 `<root>/.ccode/checks/` 顶层的 *.jsonl（不读子目录：`runs/` 是存档）；链接文件不跟。
pub(crate) fn read_checks_at(root: &Path) -> ChecksDto {
    let mut out = ChecksDto::default();
    let dir = checks_dir(root);
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() => {}
        _ => return out,
    }
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    let mut files: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let meta = fs::symlink_metadata(entry.path()).ok()?;
            (meta.is_file() && name.ends_with(".jsonl")).then(|| (name, entry.path()))
        })
        .collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, path) in files {
        if let Some(text) = read_capped(&path, CHECK_FILE_CAP) {
            parse_check_text(&text, &mut out, &name);
            out.files.push(name);
        }
    }
    out
}

pub(crate) fn count_checks(items: &[CheckItem]) -> CheckCounts {
    let mut counts = CheckCounts::default();
    for item in items {
        match item.status.as_str() {
            "passed" => counts.passed += 1,
            "blocked" => counts.blocked += 1,
            _ => counts.needs_human += 1,
        }
    }
    counts
}

#[tauri::command]
pub async fn research_checks_read(path: String) -> Result<ChecksDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        if !root.is_dir() {
            return Err("工作目录不存在".to_string());
        }
        Ok(read_checks_at(&root))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 往 JSONL 追加一行：上次进程可能写到一半退出，原字节保留，但新行必须另起一行；
/// 私有文件 0600、落盘后返回。调用方负责持锁与去重。
pub(crate) fn append_jsonl_line(path: &Path, value: &str) -> Result<(), String> {
    use std::io::Write;
    let previous = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("读取原记录失败，未追加：{e}")),
    };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let mut line = value.trim_end_matches('\n').to_string();
    line.push('\n');
    if !previous.is_empty() && !previous.ends_with(b"\n") {
        line.insert(0, '\n');
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("打开记录失败: {e}"))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("写入记录失败: {e}"))?;
    file.sync_all().map_err(|e| format!("落盘记录失败: {e}"))?;
    Ok(())
}

/// 研究记录里的一条运行事实。
/// 「问了什么」：这次交给 Agent 的任务书（流程步骤的 TASK.md / 目标的上下文快照）的指纹与项目内存档位置
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRef {
    /// 原文出处：TASK.md / context.json
    pub source: String,
    pub sha256: String,
    /// 项目内存档（相对项目根，已脱敏）
    pub archived: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub v: u32,
    pub kind: String,
    pub run_id: String,
    pub task_kind: String,
    /// 这次做的是什么（流程步骤名 / 目标 / 对话 …），给 AI 使用声明当「用途」
    pub purpose: String,
    pub agent: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    pub created_at: String,
    #[serde(default)]
    pub closed_at: Option<String>,
    pub status: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub checks: Option<CheckCounts>,
    #[serde(default)]
    pub task: Option<TaskRef>,
    /// 这次运行对应的会话（过程报告附对话原文时按它找）
    #[serde(default)]
    pub session_id: Option<String>,
    /// 这次按什么授权跑的、这家实际落实了什么（grant.rs，run.grant 事件）；没设授权为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<String>,
}

pub(crate) fn read_records_at(root: &Path) -> Vec<RunRecord> {
    let Some(text) = read_capped(&record_path(root), RECORD_CAP) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| serde_json::from_str::<RunRecord>(line.trim()).ok())
        .filter(|r| r.kind == "run")
        .collect()
}

pub(crate) fn purpose_of(run: &crate::runs::RunDto, root: &Path) -> String {
    match run.task_kind.as_str() {
        "pipeline_step" => {
            let steps = crate::projects::step_names_at(root);
            let base = Path::new(run.isolation_path.trim_end_matches(['/', '\\']))
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            run.task_ref
                .as_deref()
                .and_then(|r| steps.get(r))
                .or_else(|| steps.get(&base))
                .map(|name| format!("研究流程：{name}"))
                .unwrap_or_else(|| "研究流程".into())
        }
        "free_research" => "目标".into(),
        "reader" => "阅读文献".into(),
        "office_doc" => "办公文档".into(),
        "coding_lane" => "编程".into(),
        _ => "对话".into(),
    }
}

fn agent_label(agent: &str) -> String {
    crate::agent_specs::agent_spec(agent)
        .map(|s| s.display_name.to_string())
        .unwrap_or_else(|| agent.to_string())
}

/// 按记录生成 AI 使用声明的事实底稿：只列 Mesa 里实际跑过的，按「用途 × Agent」聚合模型与次数。
pub(crate) fn render_ai_usage(records: &[RunRecord]) -> String {
    use std::collections::BTreeMap;
    #[derive(Default)]
    struct Row {
        models: std::collections::BTreeSet<String>,
        runs: usize,
        first: String,
        last: String,
    }
    let mut rows: BTreeMap<(String, String), Row> = BTreeMap::new();
    for record in records {
        let row = rows
            .entry((record.purpose.clone(), agent_label(&record.agent)))
            .or_default();
        row.runs += 1;
        row.models.extend(record.models.iter().cloned());
        let day: String = record.created_at.chars().take(10).collect();
        if row.first.is_empty() || day < row.first {
            row.first = day.clone();
        }
        if day > row.last {
            row.last = day;
        }
    }
    let mut text = String::from(
        "# AI 使用记录（Mesa 自动统计）\n\n\
         由 Mesa 按本项目 `.ccode/record.jsonl` 统计：只含在 Mesa 里运行过的 AI，不含在 Mesa 之外用过的工具。\n\
         写 AI 使用声明时以此为事实依据；用途描述与是否需要补充，以作者核对为准。\n\n\
         | 用途 | AI 工具 | 模型 | 运行次数 | 日期 |\n|---|---|---|---:|---|\n",
    );
    for ((purpose, agent), row) in &rows {
        let models = if row.models.is_empty() {
            "（未记录）".to_string()
        } else {
            row.models.iter().cloned().collect::<Vec<_>>().join("、")
        };
        let days = if row.first == row.last {
            row.first.clone()
        } else {
            format!("{} 至 {}", row.first, row.last)
        };
        let cell = |s: &str| s.replace('|', "／");
        text.push_str(&format!(
            "| {} | {} | {} | {} | {} |\n",
            cell(purpose),
            cell(agent),
            cell(&models),
            row.runs,
            days
        ));
    }
    if rows.is_empty() {
        text.push_str("| （还没有记录） | | | 0 | |\n");
    }
    text
}

/// 把这次 Run 的核验项存档到项目 `.ccode/checks/runs/<runId>.jsonl`（同一 Run 再结束一次就覆盖）。
fn archive_checks(root: &Path, run_id: &str, items: &[CheckItem]) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    let mut text = String::new();
    for item in items {
        text.push_str(&serde_json::to_string(item).map_err(|e| e.to_string())?);
        text.push('\n');
    }
    let dir = checks_dir(root).join("runs");
    fs::create_dir_all(&dir).map_err(|e| format!("创建核验存档目录失败: {e}"))?;
    crate::storage::atomic_write(&dir.join(format!("{run_id}.jsonl")), text.as_bytes(), true)
}

/// 记一条运行事实（调用方已持 record.lock）。已记过同一 runId 的不再记。返回是否新写入。
pub(crate) fn append_run_record_at(root: &Path, record: &RunRecord) -> Result<bool, String> {
    if read_records_at(root).iter().any(|r| r.run_id == record.run_id) {
        return Ok(false);
    }
    let line = serde_json::to_string(record).map_err(|e| e.to_string())?;
    append_jsonl_line(&record_path(root), &line)?;
    let records = read_records_at(root);
    crate::storage::atomic_write(
        &ai_usage_path(root),
        render_ai_usage(&records).as_bytes(),
        false,
    )?;
    Ok(true)
}

/// 研讨结论被人采用（提升到研究档案）时记进研究记录（2026-11-11 研讨三期）：参与这场研讨、答成过的每一位一条，
/// task_kind = consult、用途「研讨：标题」，写明哪家 CLI、哪条连接、哪个模型——AI 使用声明与过程报告据此列出这条判断经过了谁。
/// run_id 用 `consult-<研讨 id>-<成员 id>`，同一场再提升不重复记。返回新写入几条
pub(crate) fn record_consult_members(root: &Path, consult: &crate::consult::Consult) -> Result<usize, String> {
    let _lock = crate::storage::lock_at(&record_lock_path(root))?;
    let closed = chrono::Local::now().to_rfc3339();
    let mut written = 0;
    for m in &consult.meta.members {
        let answered = consult
            .messages
            .iter()
            .any(|x| x.member.as_deref() == Some(m.id.as_str()) && x.status == "ok" && !x.pass);
        if !answered {
            continue;
        }
        let record = RunRecord {
            v: 1,
            kind: "run".into(),
            run_id: format!("consult-{}-{}", consult.meta.id, m.id),
            task_kind: "consult".into(),
            purpose: format!("研讨：{}", consult.meta.title),
            agent: m.agent.clone(),
            profile_id: Some(m.profile_id.clone()),
            models: if m.model.trim().is_empty() { Vec::new() } else { vec![m.model.clone()] },
            created_at: consult.meta.created_at.clone(),
            closed_at: Some(closed.clone()),
            status: "completed".into(),
            exit_code: None,
            checks: None,
            task: None,
            session_id: None,
            grant: None,
        };
        if append_run_record_at(root, &record)? {
            written += 1;
        }
    }
    Ok(written)
}

const TASK_ARCHIVE_CAP: usize = 512 * 1024;

/// 存这次的任务书：流程步骤读工作目录的 TASK.md，目标读冻结的上下文快照；指纹按原文算，存档脱敏、超长截断
pub(crate) fn archive_task(root: &Path, run_id: &str, source: &str, text: &str) -> Result<TaskRef, String> {
    use sha2::{Digest, Sha256};
    let sha256 = format!("{:x}", Sha256::digest(text.as_bytes()));
    let mut body = crate::sessions::redact_sensitive_text(text);
    if body.len() > TASK_ARCHIVE_CAP {
        let mut cut = TASK_ARCHIVE_CAP;
        while !body.is_char_boundary(cut) {
            cut -= 1;
        }
        body.truncate(cut);
        body.push_str("\n…（超长截断）\n");
    }
    let rel = format!(".ccode/record/tasks/{run_id}.md");
    crate::storage::atomic_write(&root.join(&rel), body.as_bytes(), true)?;
    Ok(TaskRef { source: source.into(), sha256, archived: rel })
}

fn task_text_of(run: &crate::runs::RunDto) -> Option<(&'static str, String)> {
    let task_md = Path::new(&run.isolation_path).join("TASK.md");
    if let Some(text) = read_capped(&task_md, 4 * 1024 * 1024).filter(|t| !t.trim().is_empty()) {
        return Some(("TASK.md", text));
    }
    crate::runs::run_context_text(&run.task_id, &run.id)
        .filter(|t| !t.trim().is_empty())
        .map(|t| ("context.json", t))
        // 只讨论的目标：没有快照也没有 TASK.md，记目标原文（只有人写的那段，不含 Mesa 附的项目说明）
        .or_else(|| crate::runs::goal_text(&run.task_id).map(|t| ("goal", t)))
}

/// 这次 Run 用过的模型：会话里已索引的用量优先，取不到用 Mesa 启动时记下的；都没有给空
fn run_models(run: &crate::runs::RunDto) -> Vec<String> {
    let Some(session) = run.session_id.as_deref() else {
        return Vec::new();
    };
    let models = crate::usage::session_models(&run.agent, session);
    if !models.is_empty() {
        return models;
    }
    crate::sessions::launch_model_of(&run.agent, session).into_iter().collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProducerDto {
    pub agent: String,
    pub profile_id: Option<String>,
    pub models: Vec<String>,
}

/// 跨厂商复核用：这一步是谁写的（Agent、连接、用过的模型），按模型族挑「另一家」
#[tauri::command]
pub async fn research_run_producer(run_id: String) -> Result<Option<RunProducerDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(crate::runs::run_get_sync(run_id)?.map(|run| RunProducerDto {
            models: run_models(&run),
            agent: run.agent,
            profile_id: run.profile_id,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn build_record(run: &crate::runs::RunDto, root: &Path, checks: &[CheckItem]) -> RunRecord {
    let models = run_models(run);
    RunRecord {
        v: 1,
        kind: "run".into(),
        run_id: run.id.clone(),
        task_kind: run.task_kind.clone(),
        purpose: purpose_of(run, root),
        agent: run.agent.clone(),
        profile_id: run.profile_id.clone(),
        models,
        created_at: run.created_at.clone(),
        closed_at: run.closed_at.clone(),
        status: run.status.clone(),
        exit_code: run.exit_code,
        checks: (!checks.is_empty()).then(|| count_checks(checks)),
        task: task_text_of(run).and_then(|(source, text)| archive_task(root, &run.id, source, &text).ok()),
        session_id: run.session_id.clone(),
        grant: crate::runs::run_grant_summary(&run.id),
    }
}

/// 开工弹层「这条连接上次做这一步」的花费（2026-11-08，design-autonomy-roadmap.md §8）：陈述历史、不预测。
/// 只认同一项目、同一步骤、同一连接、已结束且能计价的那一次；没有就是 None，界面不写。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastStepCostDto {
    pub usd: f64,
    /// 那一次开始的时间（ISO）
    pub at: String,
}

pub(crate) fn last_step_cost_in(
    runs: &[crate::runs::RunDto],
    step_name: &str,
    profile_id: &str,
    purpose: impl Fn(&crate::runs::RunDto) -> String,
    cost_of: impl Fn(&crate::runs::RunDto) -> Option<f64>,
) -> Option<LastStepCostDto> {
    let want = format!("研究流程：{}", step_name.trim());
    let mut list: Vec<&crate::runs::RunDto> = runs
        .iter()
        .filter(|r| {
            r.task_kind == "pipeline_step"
                && !r.internal
                && r.closed_at.is_some()
                && r.session_id.is_some()
                && r.profile_id.as_deref() == Some(profile_id)
        })
        .collect();
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    list.into_iter()
        .filter(|r| purpose(r) == want)
        .find_map(|r| cost_of(r).map(|usd| LastStepCostDto { usd, at: r.created_at.clone() }))
}

#[tauri::command]
pub async fn last_step_run_cost(
    project_root: String,
    step_name: String,
    profile_id: String,
) -> Result<Option<LastStepCostDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if profile_id.trim().is_empty() || step_name.trim().is_empty() {
            return Ok(None);
        }
        let runs = crate::runs::run_list_sync(Some(project_root.clone()))?;
        let root = Path::new(&project_root);
        Ok(last_step_cost_in(
            &runs,
            &step_name,
            &profile_id,
            |r| purpose_of(r, root),
            |r| r.session_id.as_deref().and_then(|sid| crate::usage::session_cost_priced(&r.agent, sid)),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run 结束后调用（best-effort，失败只记日志）：写运行事实、存档核验项、重写 ai-usage.md。
/// 登录、Mesa 内部的后台调用、没有项目的 Run 不记。
pub(crate) fn record_run_closed(run_id: &str) {
    let outcome = (|| -> Result<(), String> {
        let Some(run) = crate::runs::run_get_sync(run_id.to_string())? else {
            return Ok(());
        };
        if run.closed_at.is_none() || run.internal || run.task_kind == "login" {
            return Ok(());
        }
        let Some(root) = run.project_root.as_deref().map(PathBuf::from) else {
            return Ok(());
        };
        if !root.join(".ccode").is_dir() {
            return Ok(());
        }
        let checks = read_checks_at(Path::new(&run.isolation_path)).items;
        let _lock = crate::storage::lock_at(&record_lock_path(&root))?;
        archive_checks(&root, &run.id, &checks)?;
        let record = build_record(&run, &root, &checks);
        if append_run_record_at(&root, &record)? {
            crate::local_stats::record_run(record.checks);
        }
        Ok(())
    })();
    if let Err(error) = outcome {
        crate::logbuf::record(
            "warn",
            "research_record",
            &format!("Run {run_id} 的研究记录未写入：{error}"),
        );
    }
}

#[cfg(test)]
mod tests {
    /// 开工弹层「上次花费」：只认同一步骤、同一连接、已结束的；最新一次没计价就往前找能计价的；都没有给 None
    #[test]
    fn last_step_cost_picks_latest_priced_same_step_and_profile() {
        let mk = |id: &str, at: &str, profile: &str, closed: bool| crate::runs::RunDto {
            id: id.into(),
            project_root: Some("/p".into()),
            task_kind: "pipeline_step".into(),
            task_ref: Some(if id.starts_with("w") { "write".into() } else { "search".into() }),
            isolation_path: "/iso".into(),
            runtime: "local_cli".into(),
            agent: "codex".into(),
            profile_id: Some(profile.into()),
            permission: "write_tree".into(),
            reuse_key: None,
            session_id: Some(format!("s-{id}")),
            internal: false,
            sentinel: false,
            created_at: at.into(),
            closed_at: closed.then(|| at.to_string()),
            status: "done".into(),
            exit_code: None,
            close_reason: None,
            task_id: String::new(),
            custom_runtime_id: None,
            project_id: None,
            capabilities: crate::runtime::capabilities(crate::runtime::RuntimeKind::LocalCli),
        };
        let runs = vec![
            mk("s1", "2026-11-01T10:00:00Z", "p1", true),
            mk("s2", "2026-11-03T10:00:00Z", "p1", true),
            mk("s3", "2026-11-04T10:00:00Z", "p1", true),
            mk("s4", "2026-11-05T10:00:00Z", "p1", false),
            mk("s5", "2026-11-06T10:00:00Z", "p2", true),
            mk("w1", "2026-11-07T10:00:00Z", "p1", true),
        ];
        let purpose = |r: &crate::runs::RunDto| {
            if r.task_ref.as_deref() == Some("search") { "研究流程：文献检索".to_string() } else { "研究流程：写作".to_string() }
        };
        // s3 没计价（None）→ 用 s2；没结束的 s4、别的连接 s5、别的步骤 w1 都不算
        let cost = |r: &crate::runs::RunDto| match r.id.as_str() {
            "s1" => Some(0.1),
            "s2" => Some(0.42),
            "s4" | "s5" | "w1" => Some(9.0),
            _ => None,
        };
        let got = last_step_cost_in(&runs, "文献检索", "p1", purpose, cost).unwrap();
        assert_eq!((got.usd, got.at.as_str()), (0.42, "2026-11-03T10:00:00Z"));
        assert!(last_step_cost_in(&runs, "文献检索", "p3", purpose, cost).is_none());
    }

    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-record-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join(".ccode")).unwrap();
        dir
    }

    fn item(id: &str, status: &str) -> String {
        format!(
            r#"{{"id":"{id}","kind":"citation_resolve","status":"{status}","title":"t","target":{{"file":"manuscript/draft.md","line":3}},"checker":"script:cite_check"}}"#
        )
    }

    #[test]
    fn reads_top_level_check_files_and_skips_bad_lines() {
        let root = temp_root("checks");
        let dir = checks_dir(&root);
        fs::create_dir_all(dir.join("runs")).unwrap();
        fs::write(
            dir.join("b.jsonl"),
            format!("{}\nnot json\n{}\n", item("C2", "blocked"), item("C3", "weird")),
        )
        .unwrap();
        fs::write(dir.join("cite-refs.jsonl"), item("C1", "passed")).unwrap();
        // 脚本文件之外写成「通过」的，按 Agent 判断收成待你判断
        fs::write(dir.join("cross-review.jsonl"), item("X1", "passed")).unwrap();
        fs::write(dir.join("runs").join("old.jsonl"), item("X", "passed")).unwrap();
        fs::write(dir.join("notes.txt"), item("Y", "passed")).unwrap();
        let dto = read_checks_at(&root);
        let ids: Vec<&str> = dto.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["C2", "C1", "X1"]);
        assert_eq!(dto.files, vec!["b.jsonl", "cite-refs.jsonl", "cross-review.jsonl"]);
        assert_eq!(dto.skipped, 2);
        assert_eq!(
            count_checks(&dto.items),
            CheckCounts {
                passed: 1,
                blocked: 1,
                needs_human: 1
            }
        );
    }

    #[test]
    fn agent_checks_never_pass() {
        let line = r#"{"id":"X1","kind":"claim_support","status":"passed","title":"t","checker":"agent:codex"}"#;
        assert_eq!(parse_check_line(line, CheckSource::Script, "num-check.jsonl").unwrap().status, "needs_human");
        let script = r#"{"id":"C1","kind":"citation_resolve","status":"passed","title":"t","checker":"script:cite_check"}"#;
        assert_eq!(parse_check_line(script, CheckSource::Script, "num-check.jsonl").unwrap().status, "passed");
        // 脚本文件之外（复核记录）：漏写或冒写 script: 检查器也按 Agent 收，不能通过
        let missing = r#"{"id":"X2","kind":"claim_support","status":"passed","title":"t"}"#;
        let got = parse_check_line(missing, CheckSource::Agent, "x.jsonl").unwrap();
        assert_eq!((got.status.as_str(), got.checker.as_str()), ("needs_human", "agent"));
        let faked = parse_check_line(script, CheckSource::Agent, "x.jsonl").unwrap();
        assert_eq!((faked.status.as_str(), faked.checker.as_str()), ("needs_human", "agent"));
        // 任务包脚本：检查器记成文件名、「通过」降为待你判断；拦下照收
        assert_eq!(check_source("pack-pk-1-qc.jsonl"), CheckSource::Pack);
        assert_eq!(check_source("num-check.jsonl"), CheckSource::Script);
        assert_eq!(check_source("cross-review.jsonl"), CheckSource::Agent);
        let pack = parse_check_line(script, CheckSource::Pack, "pack-pk-1-qc.jsonl").unwrap();
        assert_eq!((pack.status.as_str(), pack.checker.as_str()), ("needs_human", "pack:pk-1-qc"));
        let blocked = r#"{"id":"Q1","kind":"qc","status":"blocked","title":"线粒体比例超阈值的细胞没剔除","checker":"script:cite_check"}"#;
        let got = parse_check_line(blocked, CheckSource::Pack, "pack-pk-1-qc.jsonl").unwrap();
        assert_eq!((got.status.as_str(), got.checker.as_str()), ("blocked", "pack:pk-1-qc"));
    }

    #[test]
    fn missing_checks_dir_is_empty_not_error() {
        let root = temp_root("none");
        assert_eq!(read_checks_at(&root), ChecksDto::default());
    }

    #[test]
    fn long_fields_are_capped() {
        let long = "字".repeat(FIELD_CAP + 50);
        let line = format!(
            r#"{{"id":"C1","kind":"quote_in_source","status":"needs_human","title":"t","evidence":{{"quote":"{long}"}}}}"#
        );
        let item = parse_check_line(&line, CheckSource::Script, "num-check.jsonl").unwrap();
        let quote = item.evidence.unwrap().quote.unwrap();
        assert_eq!(quote.chars().count(), FIELD_CAP + 1);
    }

    #[test]
    fn append_jsonl_separates_torn_last_line() {
        let root = temp_root("torn");
        let path = record_path(&root);
        fs::write(&path, "{\"half\":").unwrap();
        append_jsonl_line(&path, "{\"ok\":1}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"half\":\n{\"ok\":1}\n");
    }

    fn record(run_id: &str, purpose: &str, agent: &str, models: &[&str], day: &str) -> RunRecord {
        RunRecord {
            v: 1,
            kind: "run".into(),
            run_id: run_id.into(),
            task_kind: "pipeline_step".into(),
            purpose: purpose.into(),
            agent: agent.into(),
            models: models.iter().map(|m| m.to_string()).collect(),
            created_at: format!("{day}T08:00:00Z"),
            status: "completed".into(),
            ..RunRecord::default()
        }
    }

    #[test]
    fn run_records_dedupe_by_run_and_rewrite_ai_usage() {
        let root = temp_root("record");
        let a = record("r1", "研究流程：文献检索与筛选", "claude-code", &["claude-opus"], "2026-11-01");
        assert!(append_run_record_at(&root, &a).unwrap());
        assert!(!append_run_record_at(&root, &a).unwrap());
        let b = record("r2", "研究流程：文献检索与筛选", "claude-code", &["claude-sonnet"], "2026-11-03");
        assert!(append_run_record_at(&root, &b).unwrap());
        assert_eq!(read_records_at(&root).len(), 2);
        let usage = fs::read_to_string(ai_usage_path(&root)).unwrap();
        assert!(usage.contains(
            "| 研究流程：文献检索与筛选 | Claude Code | claude-opus、claude-sonnet | 2 | 2026-11-01 至 2026-11-03 |"
        ));
    }

    #[test]
    fn ai_usage_marks_unknown_models_and_escapes_pipes() {
        let text = render_ai_usage(&[record("r1", "目标|一", "codex", &[], "2026-11-02")]);
        assert!(text.contains("| 目标／一 | Codex | （未记录） | 1 | 2026-11-02 |"));
        assert!(render_ai_usage(&[]).contains("（还没有记录）"));
    }

    #[test]
    fn task_archive_keeps_fingerprint_of_original_and_redacts_copy() {
        let root = temp_root("task");
        let text = "# 任务书\n用 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 调接口\n";
        let task = archive_task(&root, "r1", "TASK.md", text).unwrap();
        assert_eq!(task.archived, ".ccode/record/tasks/r1.md");
        assert_eq!(task.sha256.len(), 64);
        let copy = fs::read_to_string(root.join(&task.archived)).unwrap();
        assert!(copy.contains("# 任务书"));
        assert!(!copy.contains("abcdefghijklmnopqrstuvwxyz0123456789"), "存档要脱敏");
    }

    /// 真实项目干跑（AGENTS.md「动真实数据先干跑」）：MESA_DRYRUN_ROOT 指向**真实项目的副本**，
    /// 按 Run 结束的同一套函数写记录、存任务书与核验，再跑三个导出与研究档案的总表 / 提议。默认不跑。
    #[test]
    #[ignore]
    fn real_project_dry_run() {
        let Ok(root) = std::env::var("MESA_DRYRUN_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let checks = read_checks_at(&root).items;
        let drafts: Vec<PathBuf> = fs::read_dir(root.join(".ccode/drafts"))
            .map(|it| it.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        for (i, (purpose, agent, model)) in [
            ("研究流程：文献检索与筛选", "claude-code", "claude-opus-4"),
            ("研究流程：综述初稿", "codex", "gpt-5"),
            ("研究流程：润色与定稿", "claude-code", "claude-sonnet-4"),
        ]
        .iter()
        .enumerate()
        {
            let run_id = format!("dryrun-{i}");
            let text = drafts.get(i).and_then(|p| fs::read_to_string(p).ok()).unwrap_or_else(|| format!("# {purpose}\n"));
            let task = archive_task(&root, &run_id, "TASK.md", &text).unwrap();
            if i == 2 {
                archive_checks(&root, &run_id, &checks).unwrap();
            }
            let mut record = RunRecord {
                v: 1,
                kind: "run".into(),
                run_id,
                task_kind: "pipeline_step".into(),
                purpose: purpose.to_string(),
                agent: agent.to_string(),
                models: vec![model.to_string()],
                created_at: format!("2026-10-1{i}T08:00:00Z"),
                status: "completed".into(),
                task: Some(task),
                ..RunRecord::default()
            };
            if i == 2 {
                record.checks = Some(count_checks(&checks));
            }
            append_run_record_at(&root, &record).unwrap();
        }
        let out = root.join("dryrun-out");
        fs::create_dir_all(&out).unwrap();
        let records = read_records_at(&root);
        fs::write(out.join("ai-statement.md"), crate::research_export::render_ai_statement("综述流程测试", &records)).unwrap();
        let (packed, data) = crate::research_export::write_repro_pack(&root, &out.join("repro.zip")).unwrap();
        fs::write(out.join("report.html"), crate::research_export::render_process_report(&root, true)).unwrap();
        let papers = crate::research_profile::papers_from(&[("综述流程测试".into(), root.clone())]);
        let empty = crate::project_memory::parse("").unwrap();
        let suggestions = crate::research_profile::suggestions_from(&[("综述流程测试".into(), root.clone())], &empty, &[]);
        eprintln!(
            "records={} checks={:?} packed={packed} data={data} papers={} suggestions={}",
            records.len(),
            count_checks(&checks),
            papers.len(),
            suggestions.len()
        );
        for s in suggestions.iter().take(5) {
            eprintln!("  建议：{}（{} 次）", s.text, s.count);
        }
        assert_eq!(records.len(), 3);
    }

    #[test]
    fn archived_checks_are_not_read_as_live_checks() {
        let root = temp_root("archive");
        let items = vec![parse_check_line(&item("C1", "blocked"), CheckSource::Script, "num-check.jsonl").unwrap()];
        archive_checks(&root, "run-1", &items).unwrap();
        assert!(checks_dir(&root).join("runs").join("run-1.jsonl").is_file());
        assert!(read_checks_at(&root).items.is_empty());
    }
}
