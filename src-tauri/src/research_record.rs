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

/// 一行 → 核验项；状态不在三档内的不收（不猜它算哪档）。
fn parse_check_line(line: &str) -> Option<CheckItem> {
    let mut item: CheckItem = serde_json::from_str(line).ok()?;
    if !matches!(item.status.as_str(), "passed" | "blocked" | "needs_human") {
        return None;
    }
    if item.id.trim().is_empty() || item.kind.trim().is_empty() || item.title.trim().is_empty() {
        return None;
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

fn parse_check_text(text: &str, out: &mut ChecksDto) {
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if out.items.len() >= CHECK_ITEM_CAP {
            out.skipped += 1;
            continue;
        }
        match parse_check_line(line) {
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
            parse_check_text(&text, &mut out);
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

fn purpose_of(run: &crate::runs::RunDto, root: &Path) -> String {
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

fn build_record(run: &crate::runs::RunDto, root: &Path, checks: &[CheckItem]) -> RunRecord {
    let mut models = Vec::new();
    if let Some(session) = run.session_id.as_deref() {
        models = crate::usage::session_models(&run.agent, session);
        if models.is_empty() {
            if let Some(model) = crate::sessions::launch_model_of(&run.agent, session) {
                models.push(model);
            }
        }
    }
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
    }
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
        fs::write(dir.join("a.jsonl"), item("C1", "passed")).unwrap();
        fs::write(dir.join("runs").join("old.jsonl"), item("X", "passed")).unwrap();
        fs::write(dir.join("notes.txt"), item("Y", "passed")).unwrap();
        let dto = read_checks_at(&root);
        let ids: Vec<&str> = dto.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["C1", "C2"]);
        assert_eq!(dto.files, vec!["a.jsonl", "b.jsonl"]);
        assert_eq!(dto.skipped, 2);
        assert_eq!(
            count_checks(&dto.items),
            CheckCounts {
                passed: 1,
                blocked: 1,
                needs_human: 0
            }
        );
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
        let item = parse_check_line(&line).unwrap();
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
    fn archived_checks_are_not_read_as_live_checks() {
        let root = temp_root("archive");
        let items = vec![parse_check_line(&item("C1", "blocked")).unwrap()];
        archive_checks(&root, "run-1", &items).unwrap();
        assert!(checks_dir(&root).join("runs").join("run-1.jsonl").is_file());
        assert!(read_checks_at(&root).items.is_empty());
    }
}
