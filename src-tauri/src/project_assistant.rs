//! 项目助手（2026-11-04 用户拍板，docs/design-project-assistant.md）：项目里有不明白、出了错，问它。
//!
//! 这里只管三样落盘与一次调用，项目快照由前端用已有命令拼（project-snapshot.ts）：
//! - **Mesa 出错记录**：前端统一接住失败的后台调用（mesa-error-capture.ts），按参数里的路径归到项目，
//!   写进配置目录 `project-assistant/<项目键>/mesa-errors.jsonl`。不写进项目 `.ccode/`——那里每多一个文件
//!   都要同步忽略规则、合并判定与保存排除表；换来的代价是记录不跟着项目换机器。
//! - **问答记录**：同目录 `assistant.jsonl`，面板显示、可清空。
//! - **问一次**：出站前整段脱敏（快照里有路径、报错原文），按专属绑定的连接 / 模型无头调用一次，回答同样脱敏后落记录。
//!
//! 只读、只解释：这里没有任何改项目文件、派活、传话的口子。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const DIR: &str = "project-assistant";
const ERRORS_FILE: &str = "mesa-errors.jsonl";
const LOG_FILE: &str = "assistant.jsonl";
/// 出错记录只留 30 天、最多 500 条；同一处错 10 分钟内再犯只加次数
const ERRORS_KEEP_DAYS: i64 = 30;
const ERRORS_CAP: usize = 500;
const DEDUPE_MINUTES: i64 = 10;
/// 问答记录最多留 200 轮（面板全显示，喂给 AI 的只取最近几轮，由前端定）
const LOG_CAP: usize = 200;
const FIELD_CAP: usize = 4000;
const ANSWER_CAP: usize = 12000;
/// 一次最多附几张截图
const MAX_IMAGES: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MesaErrorDto {
    /// 最后一次发生的时间（RFC3339）
    pub at: String,
    /// 第一次发生的时间
    #[serde(default)]
    pub first_at: String,
    /// 10 分钟内同一处错的次数
    #[serde(default = "one")]
    pub count: u32,
    /// invoke（后台调用失败）| toast（只有界面提示）| crash（前端未处理的报错）
    pub source: String,
    /// 后台命令名；只有界面提示时为空
    #[serde(default)]
    pub command: String,
    pub message: String,
    /// 紧跟着弹出的红色提示原文（用户真正看到的那句）
    #[serde(default)]
    pub notice: Option<String>,
    #[serde(default)]
    pub version: String,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssistantTurnDto {
    pub at: String,
    pub question: String,
    pub answer: String,
    /// 用的哪个连接（给人看的一行，如「Codex · 公司中转 · gpt-5」）
    #[serde(default)]
    pub connection: String,
    /// 这一问依据了什么（「说明书 · 8.1 聊天 / 终端」「这个项目的记录」），回答下面一行小字
    #[serde(default)]
    pub basis: String,
    /// 这次调用花了多少（美元；只有不落盘的 Claude Code / Codex 算得出、且模型查得到价）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    /// 这一轮起草的派活单派出去了：派给谁、怎么派的、留话 id / 目标 id（项目助手据此跟进度，2026-11-04）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatched: Option<DispatchRecordDto>,
    /// 派活回音（2026-11-05）：这一条是项目助手为哪一轮派出去的活补的进展（那一轮的 at）；问题为空
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub echo_of: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRecordDto {
    pub at: String,
    /// step / goal
    pub target: String,
    #[serde(default)]
    pub step: Option<u32>,
    pub title: String,
    /// mail（留话给开着的 AI）/ resume（接回那段对话带单开跑）/ goal（记成目标开工）
    pub mode: String,
    #[serde(default)]
    pub mail_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub worktree_path: Option<String>,
    /// 派出去时给人看的那句
    #[serde(default)]
    pub note: String,
    /// 派活回音补到哪个阶段了（review / failed / stopped / accepted）；accepted 后不再跟
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub echoed: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub echoed_at: Option<String>,
}

fn truncate(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        return text.to_string();
    }
    let mut out: String = text.chars().take(cap).collect();
    out.push_str("…（已截断）");
    out
}

fn project_dir(project_root: &str) -> Result<PathBuf, String> {
    let root = crate::sessions::expand_tilde(project_root.trim());
    if root.is_empty() {
        return Err("缺少项目路径".into());
    }
    let key = crate::paths::path_key(&root);
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Ok(crate::storage::config_root()
        .ok_or("无法确定配置目录")?
        .join(DIR)
        .join(hex))
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Vec<T> {
    fs::read_to_string(path)
        .map(|text| {
            text.lines()
                .filter(|l| !l.trim().is_empty())
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn write_jsonl<T: Serialize>(path: &Path, rows: &[T]) -> Result<(), String> {
    let mut out = String::new();
    for row in rows {
        out.push_str(&serde_json::to_string(row).map_err(|e| e.to_string())?);
        out.push('\n');
    }
    crate::storage::atomic_write(path, out.as_bytes(), true)
}

fn with_lock<R>(dir: &Path, f: impl FnOnce() -> Result<R, String>) -> Result<R, String> {
    fs::create_dir_all(dir).map_err(|e| format!("建记录目录失败：{e}"))?;
    let _lock = crate::storage::lock_at(&dir.join("records.lock"))?;
    f()
}

fn parse_at(at: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(at).ok()
}

/// 合并进已有记录：同一处错（来源 + 命令 + 消息）10 分钟内再犯只加次数、更新时间；
/// 30 天前的丢掉，超过上限丢最旧的
pub(crate) fn merge_error(
    mut rows: Vec<MesaErrorDto>,
    entry: MesaErrorDto,
    now: chrono::DateTime<chrono::FixedOffset>,
) -> Vec<MesaErrorDto> {
    rows.retain(|r| {
        parse_at(&r.at).is_some_and(|t| (now - t).num_days() < ERRORS_KEEP_DAYS)
    });
    let same = rows.iter_mut().rev().find(|r| {
        r.source == entry.source
            && r.command == entry.command
            && r.message == entry.message
            && parse_at(&r.at).is_some_and(|t| (now - t).num_minutes() < DEDUPE_MINUTES)
    });
    match same {
        Some(row) => {
            row.count = row.count.saturating_add(1);
            row.at = entry.at;
            if entry.notice.is_some() {
                row.notice = entry.notice;
            }
        }
        None => rows.push(entry),
    }
    if rows.len() > ERRORS_CAP {
        let drop = rows.len() - ERRORS_CAP;
        rows.drain(..drop);
    }
    rows
}

/// 界面提示跟上来时补到最近一条还没配提示的同项目记录上（只看 5 秒内的）
pub(crate) fn attach_notice(
    rows: &mut [MesaErrorDto],
    notice: &str,
    now: chrono::DateTime<chrono::FixedOffset>,
) -> bool {
    let Some(row) = rows.iter_mut().rev().find(|r| {
        r.notice.is_none() && parse_at(&r.at).is_some_and(|t| (now - t).num_seconds().abs() <= 5)
    }) else {
        return false;
    };
    row.notice = Some(notice.to_string());
    true
}

/// 例行的「没找到」（界面探文件在不在，没有就算了）：没配上红色提示的不记、读出时也滤掉（前端 mesa-errors.ts isRoutineFailure 同口径）。
/// 2026-11-04 本机实证：一天记下的全是 read_file_preview / read_research_ledger / list_dir 的这一类，一条提示都没有
pub(crate) fn is_routine_failure(message: &str) -> bool {
    const ROUTINE: &[&str] = &[
        "(os error 2)",
        "(os error 20)",
        "No such file or directory",
        "Not a directory",
        "文件不存在或不可读",
        "路径不可读",
    ];
    let lower = message.to_lowercase();
    ROUTINE.iter().any(|p| lower.contains(&p.to_lowercase()))
}

fn now_fixed() -> chrono::DateTime<chrono::FixedOffset> {
    chrono::Local::now().fixed_offset()
}

fn record_error_sync(
    project_root: &str,
    source: &str,
    command: &str,
    message: &str,
    notice: Option<&str>,
) -> Result<(), String> {
    let source = match source {
        "invoke" | "toast" | "crash" => source,
        _ => return Err(format!("不认识的出错来源：{source}")),
    };
    let message = truncate(&crate::sessions::redact_sensitive_text(message.trim()), FIELD_CAP);
    let notice = notice
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| truncate(&crate::sessions::redact_sensitive_text(n), FIELD_CAP));
    if message.is_empty() && notice.is_none() {
        return Ok(());
    }
    if source == "invoke" && notice.is_none() && is_routine_failure(&message) {
        return Ok(());
    }
    let dir = project_dir(project_root)?;
    let path = dir.join(ERRORS_FILE);
    with_lock(&dir, || {
        let now = now_fixed();
        let mut rows: Vec<MesaErrorDto> = read_jsonl(&path);
        // 只有一句界面提示：先试着补到刚记下的那条后台失败上，补不上才单记一条
        if source == "toast" {
            if let Some(n) = notice.as_deref() {
                if attach_notice(&mut rows, n, now) {
                    return write_jsonl(&path, &rows);
                }
            }
        }
        let at = now.to_rfc3339();
        let entry = MesaErrorDto {
            at: at.clone(),
            first_at: at,
            count: 1,
            source: source.to_string(),
            command: command.trim().chars().take(120).collect(),
            message: if message.is_empty() { notice.clone().unwrap_or_default() } else { message },
            notice,
            version: env!("CARGO_PKG_VERSION").to_string(),
        };
        let rows = merge_error(rows, entry, now);
        write_jsonl(&path, &rows)
    })
}

#[tauri::command]
pub async fn mesa_error_record(
    project_root: String,
    source: String,
    command: Option<String>,
    message: String,
    notice: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        record_error_sync(
            &project_root,
            &source,
            command.as_deref().unwrap_or(""),
            &message,
            notice.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 最近的在后（与文件同序）
#[tauri::command]
pub async fn mesa_errors_read(project_root: String, limit: Option<usize>) -> Result<Vec<MesaErrorDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = project_dir(&project_root)?.join(ERRORS_FILE);
        let rows: Vec<MesaErrorDto> = read_jsonl::<MesaErrorDto>(&path)
            .into_iter()
            .filter(|r| r.notice.is_some() || !is_routine_failure(&r.message))
            .collect();
        let limit = limit.unwrap_or(ERRORS_CAP).min(ERRORS_CAP);
        Ok(rows[rows.len().saturating_sub(limit)..].to_vec())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn assistant_log_read(project_root: String) -> Result<Vec<AssistantTurnDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(read_jsonl(&project_dir(&project_root)?.join(LOG_FILE)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn assistant_log_clear(project_root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = project_dir(&project_root)?;
        let path = dir.join(LOG_FILE);
        with_lock(&dir, || match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("清空失败：{e}")),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 问答记录超过上限时丢最旧的普通问答；派过活的轮次与它的回音不丢（2026-11-05：派活单和后来的进度是审计线索，
/// 删了就对不上「哪一轮起草、派给谁、结果怎样」）
pub(crate) fn trim_log(rows: &mut Vec<AssistantTurnDto>, cap: usize) {
    while rows.len() > cap {
        match rows.iter().position(|r| r.dispatched.is_none() && r.echo_of.is_none()) {
            Some(i) => {
                rows.remove(i);
            }
            None => break,
        }
    }
}

fn append_turn(project_root: &str, turn: AssistantTurnDto) -> Result<(), String> {
    let dir = project_dir(project_root)?;
    let path = dir.join(LOG_FILE);
    with_lock(&dir, || {
        let mut rows: Vec<AssistantTurnDto> = read_jsonl(&path);
        rows.push(turn);
        trim_log(&mut rows, LOG_CAP);
        write_jsonl(&path, &rows)
    })
}

/// 不调 AI 的那几句（打招呼、道谢，前端 localReply 现答）也记进问答记录，续问时上下文接得上
#[tauri::command]
pub async fn assistant_log_append(project_root: String, question: String, answer: String) -> Result<AssistantTurnDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let turn = AssistantTurnDto {
            at: now_fixed().to_rfc3339(),
            question: truncate(&crate::sessions::redact_sensitive_text(question.trim()), FIELD_CAP),
            answer: truncate(answer.trim(), ANSWER_CAP),
            connection: "本地直接回答（没调 AI）".into(),
            basis: String::new(),
            cost_usd: None,
            dispatched: None,
            echo_of: None,
        };
        append_turn(&project_root, turn.clone())?;
        Ok(turn)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn mark_dispatched_sync(project_root: &str, turn_at: &str, record: DispatchRecordDto) -> Result<(), String> {
    let dir = project_dir(project_root)?;
    let path = dir.join(LOG_FILE);
    with_lock(&dir, || {
        let mut rows: Vec<AssistantTurnDto> = read_jsonl(&path);
        let row = rows.iter_mut().find(|r| r.at == turn_at).ok_or("找不到那一轮问答（可能已清空）")?;
        let mut record = record;
        record.title = truncate(&crate::sessions::redact_sensitive_text(&record.title), 200);
        record.note = truncate(&record.note, 300);
        row.dispatched = Some(record);
        // 记下这份记录是哪个项目的：派活回音要从配置目录反查项目（目录名是哈希）
        let _ = crate::storage::atomic_write(&dir.join(ROOT_FILE), project_root.trim().as_bytes(), true);
        write_jsonl(&path, &rows)
    })
}

const ROOT_FILE: &str = "root.txt";
/// 派出去超过这么多天还没收尾的不再跟（可能早被人处理掉了）
const ECHO_WATCH_DAYS: i64 = 14;
/// 到了这个阶段就不再跟
const ECHO_FINAL: &[&str] = &["accepted"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenDispatchDto {
    pub project_root: String,
    pub turn_at: String,
    pub record: DispatchRecordDto,
}

fn open_dispatches_sync(now: chrono::DateTime<chrono::FixedOffset>) -> Vec<OpenDispatchDto> {
    let Some(base) = crate::storage::config_root().map(|r| r.join(DIR)) else { return Vec::new() };
    let Ok(rd) = fs::read_dir(&base) else { return Vec::new() };
    let mut out = Vec::new();
    for dir in rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
        let Ok(root) = fs::read_to_string(dir.join(ROOT_FILE)) else { continue };
        let root = root.trim().to_string();
        if root.is_empty() {
            continue;
        }
        for row in read_jsonl::<AssistantTurnDto>(&dir.join(LOG_FILE)) {
            let Some(rec) = row.dispatched else { continue };
            if rec.echoed.as_deref().is_some_and(|e| ECHO_FINAL.contains(&e)) {
                continue;
            }
            if !parse_at(&rec.at).is_some_and(|t| (now - t).num_days() < ECHO_WATCH_DAYS) {
                continue;
            }
            out.push(OpenDispatchDto { project_root: root.clone(), turn_at: row.at, record: rec });
        }
    }
    out
}

/// 还在跟的派活（各项目）：应用里的巡视据此看进度、补回音
#[tauri::command]
pub async fn assistant_open_dispatches() -> Vec<OpenDispatchDto> {
    tauri::async_runtime::spawn_blocking(|| open_dispatches_sync(now_fixed())).await.unwrap_or_default()
}

fn echo_sync(project_root: &str, turn_at: &str, state: &str, text: &str) -> Result<Option<AssistantTurnDto>, String> {
    if !matches!(state, "review" | "failed" | "stopped" | "accepted") {
        return Err("未知的进展阶段".into());
    }
    let dir = project_dir(project_root)?;
    let path = dir.join(LOG_FILE);
    with_lock(&dir, || {
        let mut rows: Vec<AssistantTurnDto> = read_jsonl(&path);
        let row = rows.iter_mut().find(|r| r.at == turn_at).ok_or("找不到那一轮问答（可能已清空）")?;
        let rec = row.dispatched.as_mut().ok_or("那一轮没有派过活")?;
        // 同一阶段只补一次（巡视每分钟看一次，重启后也不重复）
        if rec.echoed.as_deref() == Some(state) {
            return Ok(None);
        }
        let now = now_fixed().to_rfc3339();
        rec.echoed = Some(state.to_string());
        rec.echoed_at = Some(now.clone());
        let text = text.trim();
        let echo = (!text.is_empty()).then(|| AssistantTurnDto {
            at: now,
            question: String::new(),
            answer: truncate(&crate::sessions::redact_sensitive_text(text), 2000),
            connection: "项目助手".into(),
            basis: String::new(),
            cost_usd: None,
            dispatched: None,
            echo_of: Some(turn_at.to_string()),
        });
        if let Some(e) = &echo {
            rows.push(e.clone());
            trim_log(&mut rows, LOG_CAP);
        }
        write_jsonl(&path, &rows)?;
        Ok(echo)
    })
}

/// 派活回音：派出去的活到了新阶段（做完等评审 / 验收、失败、停了），在那个项目的问答里补一条；
/// text 为空只记阶段不补话（如已验收：人自己点的，不用再说）。同一阶段只补一次
#[tauri::command]
pub async fn assistant_echo(project_root: String, turn_at: String, state: String, text: String) -> Result<Option<AssistantTurnDto>, String> {
    tauri::async_runtime::spawn_blocking(move || echo_sync(&project_root, &turn_at, &state, &text))
        .await
        .map_err(|e| e.to_string())?
}

/// 派活单派出去后记到那一轮上：卡片据此显示进度、不重复派，项目快照据此告诉项目助手派过什么
#[tauri::command]
pub async fn assistant_mark_dispatched(project_root: String, turn_at: String, record: DispatchRecordDto) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || mark_dispatched_sync(&project_root, &turn_at, record))
        .await
        .map_err(|e| e.to_string())?
}

/// 说明书某一节的原文（项目助手「依据」里点小节名，在应用里打开那一节，不跳 GitHub；随应用打包，版本对得上、离线也能看）：
/// 从这个标题起，到下一个同级或更高级的标题为止，最多 2 万字
pub(crate) fn guide_section(heading: &str) -> Option<String> {
    let want = heading.trim();
    if want.is_empty() {
        return None;
    }
    let mut out: Vec<&str> = Vec::new();
    let mut level = 0usize;
    for line in USER_GUIDE.lines() {
        let t = line.trim_start();
        let hashes = t.chars().take_while(|c| *c == '#').count();
        let is_heading = hashes > 0 && t[hashes..].starts_with(' ');
        if level == 0 {
            if is_heading && t[hashes..].trim() == want {
                level = hashes;
                out.push(line);
            }
            continue;
        }
        if is_heading && hashes <= level {
            break;
        }
        out.push(line);
    }
    if out.is_empty() {
        return None;
    }
    Some(truncate(out.join("\n").trim(), 20_000))
}

#[tauri::command]
pub fn assistant_guide_section(heading: String) -> Option<String> {
    guide_section(&heading)
}

/// 问一次：prompt 是前端拼好的（规矩 + 项目快照 + 最近几轮 + 这次的问题），这里整段脱敏后出站。
/// profile_id 为空 = 设置里「AI 功能」的连接（fn_key = project-assistant）；model 为空 = 连接里的第一个
#[tauri::command]
pub async fn project_assistant_ask(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    project_root: String,
    profile_id: Option<String>,
    model: Option<String>,
    connection: Option<String>,
    basis: Option<String>,
    question: String,
    prompt: String,
    inspect: Option<bool>,
    extra_dirs: Option<Vec<String>>,
    effort: Option<String>,
    stream_id: Option<String>,
    images: Option<Vec<String>>,
) -> Result<AssistantTurnDto, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let question = question.trim().to_string();
        if question.is_empty() {
            return Err("先写要问什么".into());
        }
        let prompt = crate::sessions::redact_sensitive_text(&prompt);
        let model = model.filter(|m| !m.trim().is_empty());
        // 只读查看项目文件（问出错时）：在项目根跑、只读、不落盘；这家不支持时报 INSPECT_UNSUPPORTED，前端退回只看记录
        // 思考档只接受固定几档；这里只会往低调（前端按问题类型给 low）
        let effort = effort.filter(|e| matches!(e.as_str(), "minimal" | "low" | "medium"));
        // 边生成边推到面板：事件名 assistant-stream-<id>，载荷是到此为止的整段（脱敏后）与正在做的一步
        let root_text = crate::sessions::expand_tilde(&project_root);
        let mut stream = stream_id
            .filter(|id| !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
            .map(|id| (format!("assistant-stream-{id}"), StreamState::new(root_text.clone())));
        let mut on_line = |line: &str| {
            use tauri::Emitter;
            if let Some((event, state)) = stream.as_mut() {
                if let Some(update) = state.handle_line(line) {
                    let _ = app.emit(event, update);
                }
            }
        };
        let mut cost: Option<f64> = None;
        // 附图（2026-11-05 用户：「有些问题需要截图去问」）：只收 Mesa 自己存下的粘贴图，最多 4 张；带图一律走只读查看那条路
        //（只有 Claude Code / Codex 能看图），别家明说换连接，不悄悄丢图
        let asked = images.unwrap_or_default();
        let images: Vec<String> = asked
            .iter()
            .filter(|p| crate::clipboard::is_pasted_image(std::path::Path::new(p.as_str())))
            .take(MAX_IMAGES)
            .cloned()
            .collect();
        if !asked.is_empty() && images.is_empty() {
            return Err("附的截图找不到了（粘贴的图存 7 天），重新粘贴一次再问".into());
        }
        let raw = if inspect.unwrap_or(false) || !images.is_empty() {
            let root = PathBuf::from(&root_text);
            crate::ai::ai_inspect_readonly(
                profiles,
                profile_id,
                model,
                &root,
                &extra_dirs.unwrap_or_default(),
                prompt,
                effort.as_deref(),
                Some(&mut on_line),
                Some(&mut cost),
                &images,
            )
            .map_err(|e| {
                if !images.is_empty() && e.starts_with(crate::ai::INSPECT_UNSUPPORTED) {
                    "看截图要项目助手用 Claude Code 或 Codex 的连接：到项目「Agent 分工 → 专属绑定 → 项目助手」换一条，或者把截图里的字打出来再问".to_string()
                } else {
                    e
                }
            })?
        } else {
            crate::ai::ai_prompt_impl_full(
                profiles,
                profile_id,
                model,
                Some("project-assistant"),
                prompt,
                effort.as_deref(),
                Some(&mut on_line),
                Some(&mut cost),
            )?
        };
        let answer = truncate(crate::sessions::redact_sensitive_text(raw.trim()).as_str(), ANSWER_CAP);
        if answer.is_empty() {
            return Err("AI 没有回答，换个说法再问一次".into());
        }
        let turn = AssistantTurnDto {
            at: now_fixed().to_rfc3339(),
            question: truncate(
                &crate::sessions::redact_sensitive_text(&if images.is_empty() {
                    question.clone()
                } else {
                    format!("{question}（附图 {} 张）", images.len())
                }),
                FIELD_CAP,
            ),
            answer,
            connection: connection.unwrap_or_default().chars().take(200).collect(),
            basis: basis.unwrap_or_default().chars().take(300).collect(),
            cost_usd: cost,
            dispatched: None,
            echo_of: None,
        };
        // 记不下不挡回答：这次照样给人看
        let _ = append_turn(&project_root, turn.clone());
        Ok(turn)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 推给面板的一次更新：到此为止的回答（整段、脱敏后）和 / 或正在做的一步（「读 scripts/clean.py」）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
}

/// 读 CLI 逐条吐出的 JSON 行，攒出「到此为止的回答」与「正在做的一步」。
/// Claude `stream-json`：`stream_event` 里的 text_delta 逐字攒，新一条消息开始（message_start）清空——中途读文件前的
/// 「我先看看」不留在最终显示里；`assistant` 消息里的 tool_use 变成一步。Codex `--json`：agent_message 整段、
/// command_execution / reasoning 变成一步。整段每次都整体脱敏再推（逐字片段单独脱敏会漏掉被拆开的密钥），
/// 文字更新最多 120ms 推一次，步骤立刻推；和上一步一模一样的不再推（Codex 一条命令开始、结束各报一次）
pub(crate) struct StreamState {
    root: String,
    text: String,
    secrets: Vec<String>,
    last_text_emit: Option<std::time::Instant>,
    last_step: Option<String>,
}

impl StreamState {
    pub(crate) fn new(root: String) -> Self {
        Self { root, text: String::new(), secrets: crate::profiles::stored_secrets(), last_text_emit: None, last_step: None }
    }

    fn short_path(&self, p: &str) -> String {
        let root = self.root.trim_end_matches(['/', '\\']);
        let rel = p.strip_prefix(root).map(|r| r.trim_start_matches(['/', '\\'])).unwrap_or(p);
        let rel: String = rel.chars().rev().take(60).collect::<Vec<_>>().into_iter().rev().collect();
        rel
    }

    fn tool_step(&self, name: &str, input: &serde_json::Value) -> String {
        let s = |k: &str| input.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let clip = |t: String| t.chars().take(60).collect::<String>();
        match name {
            "Read" => format!("读 {}", self.short_path(&s("file_path"))),
            "Grep" => format!("搜「{}」", clip(s("pattern"))),
            "Glob" => format!("找文件 {}", clip(s("pattern"))),
            "LS" => format!("看目录 {}", self.short_path(&s("path"))),
            "Bash" => self.command_step(&s("command")),
            other => format!("用 {other}"),
        }
    }

    /// 一条 shell 命令说成白话：读了哪几份文件 / 搜了什么 / 列了哪个目录；认不出的照原命令写「查看：…」。
    /// 只为显示，不做安全判断
    fn command_step(&self, cmd: &str) -> String {
        let clip = |t: &str| t.chars().take(60).collect::<String>();
        let inner = unwrap_shell(cmd);
        let mut reads: Vec<String> = Vec::new();
        let mut search: Option<String> = None;
        let mut list: Option<String> = None;
        for seg in command_segments(&inner) {
            match describe_segment(&seg) {
                Some(CmdKind::Read(files)) => {
                    for f in files {
                        let f = self.short_path(&f);
                        if !reads.contains(&f) {
                            reads.push(f);
                        }
                    }
                }
                Some(CmdKind::Search(p)) => {
                    search.get_or_insert(p);
                }
                Some(CmdKind::List(dir)) => {
                    list.get_or_insert_with(|| dir.map(|d| self.short_path(&d)).unwrap_or_default());
                }
                Some(CmdKind::Noise) => {}
                None => return format!("查看：{}", clip(&inner)),
            }
        }
        if !reads.is_empty() {
            let shown = reads.iter().take(3).cloned().collect::<Vec<_>>().join("、");
            return if reads.len() > 3 { format!("读 {shown} 等 {} 份", reads.len()) } else { format!("读 {shown}") };
        }
        if let Some(p) = search {
            return format!("搜「{}」", clip(&p));
        }
        match list {
            Some(d) if !d.is_empty() && d != "." && d != "./" => format!("看目录 {d}"),
            Some(_) => "列项目文件".to_string(),
            None => format!("查看：{}", clip(&inner)),
        }
    }

    fn redacted(&self, text: &str) -> String {
        crate::sessions::redact_sensitive_text_with(text, &self.secrets)
    }

    pub(crate) fn handle_line(&mut self, line: &str) -> Option<StreamUpdate> {
        let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let mut step: Option<String> = None;
        let mut text_changed = false;
        // 一条消息的第一片立刻推（「在想」换成出字要跟手），后面的按 120ms 攒
        let was_empty = self.text.is_empty();
        match kind {
            // Claude
            "stream_event" => {
                let ev = v.get("event")?;
                match ev.get("type").and_then(|t| t.as_str()) {
                    Some("message_start") => {
                        if !self.text.is_empty() {
                            self.text.clear();
                            text_changed = true;
                        }
                    }
                    Some("content_block_delta") => {
                        let d = ev.get("delta")?;
                        if d.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                            self.text.push_str(d.get("text").and_then(|t| t.as_str()).unwrap_or(""));
                            text_changed = true;
                        }
                    }
                    _ => {}
                }
            }
            "assistant" => {
                let content = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array())?;
                for item in content {
                    if item.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                        let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        step = Some(self.tool_step(name, item.get("input").unwrap_or(&serde_json::Value::Null)));
                    }
                }
            }
            // Codex
            "item.started" | "item.completed" => {
                let item = v.get("item")?;
                match item.get("type").and_then(|t| t.as_str()) {
                    Some("agent_message") if kind == "item.completed" => {
                        self.text = item.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
                        text_changed = true;
                    }
                    // 有的版本只发 item.completed：开始、结束都当一步（重复推同一步无妨）
                    Some("command_execution") => {
                        let cmd = item.get("command").and_then(|t| t.as_str()).unwrap_or("");
                        step = Some(self.command_step(cmd));
                    }
                    Some("reasoning") if kind == "item.completed" => {
                        let t = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        let first = t.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().trim_matches('*');
                        if !first.is_empty() {
                            step = Some(format!("在想：{}", first.chars().take(40).collect::<String>()));
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        if step.is_some() && step == self.last_step {
            step = None;
        } else if step.is_some() {
            self.last_step = step.clone();
        }
        let now = std::time::Instant::now();
        let text_due = text_changed
            && (step.is_some()
                || self.text.is_empty()
                || was_empty
                || self.last_text_emit.is_none_or(|t| now.duration_since(t) >= std::time::Duration::from_millis(120)));
        if !text_due && step.is_none() {
            return None;
        }
        if text_due {
            self.last_text_emit = Some(now);
        }
        Some(StreamUpdate {
            text: text_due.then(|| self.redacted(&self.text)),
            step: step.map(|s| self.redacted(&s)),
        })
    }
}

enum CmdKind {
    Read(Vec<String>),
    Search(String),
    List(Option<String>),
    /// echo / sort 这类只是拼接输出的，不算一步
    Noise,
}

/// 按 shell 规则切词：引号去掉、`| || && ; &` 单独成词、重定向（含 `2>/dev/null`、`2>&1`）连同目标一起丢掉
fn shell_words(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut skip_next = false;
    let mut chars = s.chars().peekable();
    let flush = |cur: &mut String, has: &mut bool, out: &mut Vec<String>, skip: &mut bool| {
        if *has {
            if *skip {
                *skip = false;
            } else {
                out.push(std::mem::take(cur));
            }
        }
        cur.clear();
        *has = false;
    };
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                has = true;
                for d in chars.by_ref() {
                    if d == '\'' {
                        break;
                    }
                    cur.push(d);
                }
            }
            '"' => {
                has = true;
                while let Some(d) = chars.next() {
                    match d {
                        '"' => break,
                        '\\' => {
                            if let Some(e) = chars.next() {
                                cur.push(e);
                            }
                        }
                        _ => cur.push(d),
                    }
                }
            }
            '\\' => {
                has = true;
                if let Some(e) = chars.next() {
                    cur.push(e);
                }
            }
            '>' | '<' => {
                // 紧贴在前面的纯数字是文件描述符（2>），一起丢
                if has && cur.chars().all(|d| d.is_ascii_digit()) {
                    cur.clear();
                    has = false;
                }
                flush(&mut cur, &mut has, &mut out, &mut skip_next);
                while matches!(chars.peek(), Some('>') | Some('&')) {
                    chars.next();
                }
                skip_next = true;
            }
            '|' | '&' | ';' => {
                flush(&mut cur, &mut has, &mut out, &mut skip_next);
                let mut op = c.to_string();
                if chars.peek() == Some(&c) && c != ';' {
                    op.push(c);
                    chars.next();
                }
                out.push(op);
            }
            c if c.is_whitespace() => flush(&mut cur, &mut has, &mut out, &mut skip_next),
            _ => {
                has = true;
                cur.push(c);
            }
        }
    }
    flush(&mut cur, &mut has, &mut out, &mut skip_next);
    out
}

/// 剥掉 `/bin/zsh -lc '…'`、`bash -c "…"` 这层外壳（Codex 与部分模型都这么包）
fn unwrap_shell(cmd: &str) -> String {
    let words = shell_words(cmd);
    let is_shell = words.first().is_some_and(|w| {
        let base = w.rsplit(['/', '\\']).next().unwrap_or(w);
        matches!(base, "sh" | "bash" | "zsh")
    });
    if is_shell {
        if let Some(i) = words.iter().position(|w| w.starts_with('-') && !w.starts_with("--") && w.contains('c')) {
            if let Some(body) = words.get(i + 1) {
                return body.trim().to_string();
            }
        }
    }
    cmd.trim().to_string()
}

fn command_segments(cmd: &str) -> Vec<Vec<String>> {
    let mut segs = vec![Vec::new()];
    for w in shell_words(cmd) {
        if matches!(w.as_str(), "|" | "||" | "&&" | ";" | "&") {
            segs.push(Vec::new());
        } else {
            segs.last_mut().unwrap().push(w);
        }
    }
    segs.retain(|s| !s.is_empty());
    segs
}

/// 一段命令是干什么的；认不出返回 None（整条照原样写）
fn describe_segment(seg: &[String]) -> Option<CmdKind> {
    let prog = seg.first()?;
    let prog = prog.rsplit(['/', '\\']).next().unwrap_or(prog);
    let args = &seg[1..];
    // 不带值的开关之外，下一词是开关值的那些（-n 20、-g '!.git'）
    let takes_value = |prog: &str, flag: &str| match prog {
        "head" | "tail" => matches!(flag, "-n" | "-c"),
        "rg" | "grep" => matches!(
            flag,
            "-g" | "--glob" | "-t" | "--type" | "-T" | "--type-not" | "-m" | "--max-count" | "-A" | "-B" | "-C" | "--context" | "--max-depth" | "-d"
        ),
        "nl" => matches!(flag, "-b" | "-w" | "-s"),
        _ => false,
    };
    let operands = |prog: &str| {
        let mut v = Vec::new();
        let mut skip = false;
        for a in args {
            if skip {
                skip = false;
                continue;
            }
            if a.starts_with('-') && a.len() > 1 {
                skip = takes_value(prog, a);
                continue;
            }
            v.push(a.clone());
        }
        v
    };
    match prog {
        "cat" | "head" | "tail" | "nl" | "less" | "more" | "bat" | "wc" => {
            let files = operands(prog);
            Some(if files.is_empty() { CmdKind::Noise } else { CmdKind::Read(files) })
        }
        "sed" | "awk" => {
            // 第一个非开关参数是脚本，后面才是文件；没文件就是在管道里加工别人的输出
            let mut ops = operands(prog);
            if !ops.is_empty() {
                ops.remove(0);
            }
            Some(if ops.is_empty() { CmdKind::Noise } else { CmdKind::Read(ops) })
        }
        "rg" | "grep" => {
            if args.iter().any(|a| a == "--files") {
                return Some(CmdKind::List(operands(prog).into_iter().next()));
            }
            if let Some(i) = args.iter().position(|a| a == "-e" || a == "--regexp") {
                return args.get(i + 1).map(|p| CmdKind::Search(p.clone()));
            }
            let ops = operands(prog);
            // 前面接着管道的 grep 也算在搜
            ops.first().map(|p| CmdKind::Search(p.clone())).or(Some(CmdKind::Noise))
        }
        "ls" | "tree" | "fd" => Some(CmdKind::List(operands(prog).into_iter().next())),
        "find" => {
            if let Some(i) = args.iter().position(|a| a == "-name" || a == "-iname") {
                if let Some(p) = args.get(i + 1) {
                    return Some(CmdKind::Search(p.clone()));
                }
            }
            Some(CmdKind::List(args.first().filter(|a| !a.starts_with('-')).cloned()))
        }
        "git" if args.first().is_some_and(|a| a == "ls-files") => Some(CmdKind::List(None)),
        "echo" | "printf" | "sort" | "uniq" | "true" | "cd" | "pwd" | "tr" | "cut" | "xargs" => Some(CmdKind::Noise),
        _ => None,
    }
}

/// 评审退回意见（工作副本里的 `.ccode/review-notes.md`）：快照用，只读、有上限、脱敏
#[tauri::command]
pub async fn assistant_review_notes(worktree_path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(crate::sessions::expand_tilde(&worktree_path)).join(".ccode/review-notes.md");
        let file = fs::File::open(path).ok()?;
        let mut text = String::new();
        std::io::Read::read_to_string(&mut std::io::Read::take(file, 16 * 1024), &mut text).ok()?;
        let text = text.trim();
        (!text.is_empty()).then(|| crate::sessions::redact_sensitive_text(text))
    })
    .await
    .ok()
    .flatten()
}

// ===== 项目地图（2026-11-05，docs/design-assistant-intake.md §3.2）=====
// 接活时项目助手要知道项目里有什么：数据、记录、文献、稿件各在哪、最近动了什么。纯机械列目录，不读任何文件内容。
// 只给文件（目录由前端按路径折叠），跳过隐藏项、依赖与缓存目录、符号链接；条数与深度有上限，超了标「没列完」。

const MAP_CAP: usize = 4000;
const MAP_DEPTH: usize = 8;
/// 依赖、缓存、构建目录：里面多是机器生成的文件，列出来只占篇幅
const MAP_SKIP_DIRS: &[&str] = &["node_modules", "__pycache__", "venv", "env", "target", "_freeze", "renv", "site-packages"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapEntryDto {
    /// 相对项目根，分隔符一律 `/`
    pub path: String,
    pub size: u64,
    /// 修改时间（毫秒）；读不到为 0
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMapDto {
    pub entries: Vec<MapEntryDto>,
    /// 到了条数上限没列完
    pub truncated: bool,
}

fn map_walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<MapEntryDto>, truncated: &mut bool) {
    if *truncated {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut items: Vec<_> = rd.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for e in items {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        // symlink_metadata：不跟符号链接（可能指到项目外或成环）
        let Ok(meta) = e.path().symlink_metadata() else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            if depth + 1 < MAP_DEPTH && !MAP_SKIP_DIRS.contains(&name.as_str()) {
                map_walk(root, &e.path(), depth + 1, out, truncated);
            }
            continue;
        }
        if out.len() >= MAP_CAP {
            *truncated = true;
            return;
        }
        let rel = e.path().strip_prefix(root).map(|p| p.to_path_buf()).unwrap_or_else(|_| PathBuf::from(&name));
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(MapEntryDto {
            path: rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/"),
            size: meta.len(),
            modified_ms,
        });
    }
}

fn project_map_sync(project_root: &str) -> Result<ProjectMapDto, String> {
    let root = PathBuf::from(crate::sessions::expand_tilde(project_root));
    if !root.is_dir() {
        return Err(format!("项目目录不存在：{}", crate::paths::strip_verbatim(root).display()));
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    map_walk(&root, &root, 0, &mut entries, &mut truncated);
    Ok(ProjectMapDto { entries, truncated })
}

/// 项目地图：项目根下的文件清单（路径、大小、修改时间），只列不读
#[tauri::command]
pub async fn project_file_map(project_root: String) -> Result<ProjectMapDto, String> {
    tauri::async_runtime::spawn_blocking(move || project_map_sync(&project_root))
        .await
        .map_err(|e| e.to_string())?
}

// ===== 说明书检索（2026-11-04 用户：「问怎么换模型也要看项目记录吗」）=====
// 「怎么用 Mesa」一类问题不拼项目快照，改翻说明书：说明书随应用打包（编译期读进来），按问题挑最相关的几段。
// 切分口径：按标题记下所在小节，按空行切段（列表紧跟在引导句后面不空行，会和引导句在同一段）；
// 打分用汉字两两相邻的字组与英文词，罕见的词分量重（idf），标题里出现的加倍。

const USER_GUIDE: &str = include_str!("../../docs/guide/user-guide.md");
const GUIDE_HIT_CAP: usize = 1400;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GuideHitDto {
    /// 所在小节标题（如「8.1 聊天 / 终端」）
    pub heading: String,
    pub text: String,
}

struct GuidePara {
    heading: String,
    /// 在本小节里是第几段（0 起）
    pos: usize,
    text: String,
    grams: std::collections::HashSet<String>,
    heading_grams: std::collections::HashSet<String>,
}

/// 字组：连续汉字两两相邻取一组；英文 / 数字按词（两个字符以上），一律小写
pub(crate) fn guide_grams(text: &str) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let mut han: Vec<char> = Vec::new();
    let mut word = String::new();
    let flush_han = |han: &mut Vec<char>, out: &mut std::collections::HashSet<String>| {
        for pair in han.windows(2) {
            out.insert(pair.iter().collect());
        }
        han.clear();
    };
    for ch in text.chars() {
        let is_han = ('\u{4e00}'..='\u{9fff}').contains(&ch);
        if is_han {
            if word.chars().count() >= 2 {
                out.insert(std::mem::take(&mut word));
            }
            word.clear();
            han.push(ch);
        } else {
            flush_han(&mut han, &mut out);
            if ch.is_ascii_alphanumeric() {
                word.push(ch.to_ascii_lowercase());
            } else {
                if word.chars().count() >= 2 {
                    out.insert(std::mem::take(&mut word));
                }
                word.clear();
            }
        }
    }
    flush_han(&mut han, &mut out);
    if word.chars().count() >= 2 {
        out.insert(word);
    }
    out
}

/// 问句里不带意思的词（问法、语气、人称），去掉再取字组，免得「怎么」「如何」把所有段都匹配上
const QUESTION_FILLERS: &[&str] = &[
    "怎么样", "怎么办", "怎么", "如何", "怎样", "在哪里", "在哪儿", "在哪", "哪里", "哪儿", "能不能", "可不可以", "可以", "是不是",
    "什么", "一下", "我想", "我要", "请问", "为什么", "这个", "那个", "应该", "需要", "吗", "呢", "吧", "啊", "的", "了", "我", "你",
];

fn guide_paras() -> &'static Vec<GuidePara> {
    static PARAS: std::sync::OnceLock<Vec<GuidePara>> = std::sync::OnceLock::new();
    PARAS.get_or_init(|| {
        let mut out = Vec::new();
        let mut heading = String::new();
        let mut buf: Vec<&str> = Vec::new();
        let mut in_comment = false;
        let push = |heading: &str, buf: &mut Vec<&str>, out: &mut Vec<GuidePara>| {
            let text = buf.join("\n").trim().to_string();
            buf.clear();
            // 目录那一节只是链接清单，不进检索
            if text.chars().count() < 12 || heading.is_empty() || heading == "目录" {
                return;
            }
            let pos = out.iter().rev().take_while(|p: &&GuidePara| p.heading == heading).count();
            out.push(GuidePara {
                heading: heading.to_string(),
                pos,
                grams: guide_grams(&text),
                heading_grams: guide_grams(heading),
                text,
            });
        };
        for line in USER_GUIDE.lines() {
            let t = line.trim();
            if in_comment {
                if t.contains("-->") {
                    in_comment = false;
                }
                continue;
            }
            if t.starts_with("<!--") {
                in_comment = !t.contains("-->");
                continue;
            }
            if t.starts_with('#') {
                push(&heading, &mut buf, &mut out);
                heading = t.trim_start_matches('#').trim().to_string();
                continue;
            }
            // 后补素材位不进检索
            if t.starts_with("【配图】") || t.starts_with("【配视频】") || t.starts_with("> 【配") {
                continue;
            }
            if t.is_empty() {
                push(&heading, &mut buf, &mut out);
            } else {
                buf.push(line);
            }
        }
        push(&heading, &mut buf, &mut out);
        out
    })
}

/// 常问的几类「怎么用」直接指到说明书对应处（光靠字面匹配，「换模型」会先翻到「雷达解读换模型」这种偏门段落）：
/// 问句里有左边任一词，就给右边这些小节（标题包含）或段落（以它开头）加重分
const GUIDE_TOPICS: &[(&[&str], &[&str])] = &[
    (&["模型", "思考档", "思考强度"], &["**换 Agent、模型和思考强度**", "9.7 思考档位"]),
    (&["连接", "中转", "密钥", "apikey", "网关"], &["9.2 加一条连接"]),
    (&["官方", "订阅", "登录"], &["9.3 官方订阅"]),
    (&["默认agent", "分工", "绑定", "专属"], &["**Agent 分工页签**"]),
    (&["全局"], &["9.6 两种「生效」别混"]),
    (&["技能", "skill"], &["10 技能页"]),
    (&["mcp"], &["11 MCP 页"]),
    (&["主题", "深色", "浅色", "外观", "字号", "字体"], &["13.1 外观"]),
    (&["快捷键"], &["13.4 快捷键"]),
    (&["更新", "升级", "新版"], &["检查更新"]),
    (&["反馈", "提需求", "bug"], &["反馈与提需求"]),
    (&["定时", "雷达"], &["5.2 新建定时任务", "5.1 文献雷达"]),
    (&["评审", "保存进项目", "采纳"], &["4.9 评审页"]),
    (&["用量", "花费", "余额", "费用"], &["12 用量页"]),
    (&["手机"], &["8.4.2 从手机添加"]),
    (&["添加项目", "新建项目", "加项目"], &["3.2 添加项目"]),
    (&["出图", "画图", "生成图片"], &["9.8 出图模型"]),
    (&["项目助手", "小桌"], &["**项目助手：看不懂、出错了，问它**"]),
];

fn topic_boost(question: &str, para: &GuidePara) -> f64 {
    let q: String = question.to_lowercase().chars().filter(|c| !c.is_whitespace()).collect();
    let mut boost = 0.0;
    for (words, anchors) in GUIDE_TOPICS {
        if !words.iter().any(|w| q.contains(w)) {
            continue;
        }
        for anchor in *anchors {
            if para.text.starts_with(anchor) {
                boost += 60.0;
            } else if para.heading.contains(anchor) {
                boost += (40.0 - para.pos as f64 * 6.0).max(8.0);
            }
        }
    }
    boost
}

pub(crate) fn guide_search(question: &str, limit: usize) -> Vec<GuideHitDto> {
    let mut q = question.to_string();
    for filler in QUESTION_FILLERS {
        q = q.replace(filler, " ");
    }
    let grams = guide_grams(&q);
    if grams.is_empty() && !GUIDE_TOPICS.iter().any(|(words, _)| words.iter().any(|w| question.to_lowercase().contains(w))) {
        return Vec::new();
    }
    let paras = guide_paras();
    let n = paras.len() as f64;
    let weights: Vec<(&String, f64)> = grams
        .iter()
        .map(|g| {
            let df = paras.iter().filter(|p| p.grams.contains(g) || p.heading_grams.contains(g)).count() as f64;
            (g, ((n + 1.0) / (df + 1.0)).ln())
        })
        .filter(|(_, w)| *w > 0.0)
        .collect();
    let mut scored: Vec<(usize, f64)> = paras
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let score: f64 = weights
                .iter()
                .map(|(g, w)| {
                    let mut s = 0.0;
                    if p.grams.contains(*g) {
                        s += 1.0;
                    }
                    if p.heading_grams.contains(*g) {
                        s += 2.0;
                    }
                    s * w
                })
                .sum::<f64>()
                + topic_boost(question, p);
            (i, score)
        })
        .filter(|(_, s)| *s > 0.0)
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut used = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (i, _) in scored {
        if out.len() >= limit {
            break;
        }
        if used.contains(&i) {
            continue;
        }
        // 带上同一小节里紧跟的两段（引导句后面常是分条说明）
        let mut text = String::new();
        for j in i..(i + 3).min(paras.len()) {
            if paras[j].heading != paras[i].heading || used.contains(&j) {
                break;
            }
            used.insert(j);
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(&paras[j].text);
            if text.chars().count() >= GUIDE_HIT_CAP {
                break;
            }
        }
        out.push(GuideHitDto { heading: paras[i].heading.clone(), text: truncate(&text, GUIDE_HIT_CAP) });
    }
    out
}

#[tauri::command]
pub async fn assistant_guide_search(question: String, limit: Option<usize>) -> Vec<GuideHitDto> {
    let limit = limit.unwrap_or(4).clamp(1, 8);
    tauri::async_runtime::spawn_blocking(move || guide_search(&question, limit))
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_map_lists_files_and_skips_hidden_deps_and_symlinks() {
        let dir = std::env::temp_dir().join(format!("mesa-map-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("data/raw")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("node_modules/x")).unwrap();
        fs::write(dir.join("data/raw/a.csv"), "1,2\n").unwrap();
        fs::write(dir.join("lab.md"), "记录").unwrap();
        fs::write(dir.join(".env"), "SECRET=1").unwrap();
        fs::write(dir.join(".git/HEAD"), "ref").unwrap();
        fs::write(dir.join("node_modules/x/i.js"), "").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&dir, dir.join("loop")).unwrap();
        let map = project_map_sync(&dir.to_string_lossy()).unwrap();
        let paths: Vec<_> = map.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["data/raw/a.csv", "lab.md"]);
        assert_eq!(map.entries[0].size, 4);
        assert!(!map.truncated);
        let _ = fs::remove_dir_all(&dir);
    }

    fn at(minutes_ago: i64) -> String {
        (now_fixed() - chrono::Duration::minutes(minutes_ago)).to_rfc3339()
    }

    fn row(command: &str, message: &str, minutes_ago: i64) -> MesaErrorDto {
        MesaErrorDto {
            at: at(minutes_ago),
            first_at: at(minutes_ago),
            count: 1,
            source: "invoke".into(),
            command: command.into(),
            message: message.into(),
            notice: None,
            version: "0".into(),
        }
    }

    #[test]
    fn guide_search_finds_the_model_switch_section() {
        let hits = guide_search("如何跟换模型", 4);
        assert!(!hits.is_empty());
        assert!(
            hits.iter().any(|h| h.text.contains("模型 · 思考")),
            "换模型应翻到「模型 · 思考档」那一段：{:?}",
            hits.iter().map(|h| &h.heading).collect::<Vec<_>>()
        );
        assert!(guide_search("怎么 如何 吗", 4).is_empty(), "只有问法没有内容时不乱翻");
        assert!(hits.iter().all(|h| h.text.chars().count() <= GUIDE_HIT_CAP + 10));
    }

    #[test]
    fn every_guide_topic_anchor_still_exists() {
        // 说明书改了标题 / 引导句，这里会红：同步改 GUIDE_TOPICS，免得「怎么换模型」又翻到偏门段落
        let paras = guide_paras();
        for (_, anchors) in GUIDE_TOPICS {
            for anchor in *anchors {
                assert!(
                    paras.iter().any(|p| p.text.starts_with(anchor) || p.heading.contains(anchor)),
                    "说明书里找不到 GUIDE_TOPICS 的锚点：{anchor}"
                );
            }
        }
    }

    #[test]
    fn guide_section_cuts_at_the_next_sibling_heading() {
        let sec = guide_section("9.7 思考档位").unwrap();
        assert!(sec.starts_with("### 9.7 思考档位"));
        assert!(!sec.contains("### 9.8"), "到下一节为止");
        assert!(guide_section("没有这一节").is_none());
    }

    #[test]
    fn guide_grams_pairs_han_and_keeps_words() {
        let g = guide_grams("换 Claude 模型");
        assert!(g.contains("claude"));
        assert!(g.contains("模型"));
        assert!(!g.contains("换"));
    }

    #[test]
    fn stream_state_collects_claude_text_and_steps() {
        let mut st = StreamState { root: "/p/x".into(), text: String::new(), secrets: vec![], last_text_emit: None, last_step: None };
        let start = r#"{"type":"stream_event","event":{"type":"message_start"}}"#;
        assert!(st.handle_line(start).is_none());
        let d1 = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"我先看看"}}}"#;
        assert_eq!(st.handle_line(d1).unwrap().text.as_deref(), Some("我先看看"));
        let tool = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/p/x/scripts/clean.py"}}]}}"#;
        assert_eq!(st.handle_line(tool).unwrap().step.as_deref(), Some("读 scripts/clean.py"));
        // 新一条消息：先前的「我先看看」清掉
        let up = st.handle_line(start).unwrap();
        assert_eq!(up.text.as_deref(), Some(""));
        let d2 = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"原因是"}}}"#;
        assert_eq!(st.handle_line(d2).unwrap().text.as_deref(), Some("原因是"));
        // 120ms 内的下一片先攒着不推
        let d3 = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"列名"}}}"#;
        assert!(st.handle_line(d3).is_none());
        assert_eq!(st.text, "原因是列名");
        assert!(st.handle_line("not json").is_none());
        assert!(st.handle_line(r#"{"type":"result","result":"x"}"#).is_none());
    }

    #[test]
    fn stream_state_reads_codex_events() {
        let mut st = StreamState { root: "/p/x".into(), text: String::new(), secrets: vec![], last_text_emit: None, last_step: None };
        let cmd = r#"{"type":"item.started","item":{"type":"command_execution","command":"/bin/zsh -lc 'cat -n scripts/clean.py'"}}"#;
        assert_eq!(st.handle_line(cmd).unwrap().step.as_deref(), Some("读 scripts/clean.py"));
        // 同一条命令结束时再报一次：不重复推
        let done = r#"{"type":"item.completed","item":{"type":"command_execution","command":"/bin/zsh -lc 'cat -n scripts/clean.py'"}}"#;
        assert!(st.handle_line(done).is_none());
        let msg = r#"{"type":"item.completed","item":{"type":"agent_message","text":"报错出在第 3 行"}}"#;
        assert_eq!(st.handle_line(msg).unwrap().text.as_deref(), Some("报错出在第 3 行"));
        let secret = StreamState { root: "/".into(), text: String::new(), secrets: vec!["sk-abcdefgh12345678".into()], last_text_emit: None, last_step: None };
        assert!(!secret.redacted("key sk-abcdefgh12345678 here").contains("abcdefgh12345678"));
    }

    #[test]
    fn shell_commands_read_as_plain_words() {
        let st = StreamState { root: "/p/x".into(), text: String::new(), secrets: vec![], last_text_emit: None, last_step: None };
        let say = |c: &str| st.command_step(c);
        assert_eq!(say(r#"/bin/zsh -lc "find . -maxdepth 3 -type f | sed 's|^\./||' | sort""#), "列项目文件");
        assert_eq!(say("/bin/zsh -lc \"rg --files --hidden -g '!.git'\""), "列项目文件");
        assert_eq!(
            say("/bin/zsh -lc 'cat .ccode/drafts/lit-search.md && cat .ccode/project.toml'"),
            "读 .ccode/drafts/lit-search.md、.ccode/project.toml"
        );
        assert_eq!(
            say("/bin/zsh -c 'cat .ccode/ai-usage.md; echo ---; cat .ccode/help-wanted.md'"),
            "读 .ccode/ai-usage.md、.ccode/help-wanted.md"
        );
        assert_eq!(say("/bin/zsh -c \"sed -n '1,120p' .ccode/drafts/lit-search.md\""), "读 .ccode/drafts/lit-search.md");
        assert_eq!(say("head -n 40 /p/x/notes/a.md 2>/dev/null"), "读 notes/a.md");
        assert_eq!(say("rg -n -g '*.md' \"Mg-S\" notes"), "搜「Mg-S」");
        assert_eq!(say("grep -rn -e 'polysulfide' papers"), "搜「polysulfide」");
        assert_eq!(say("find papers -name '*.pdf'"), "搜「*.pdf」");
        assert_eq!(say("ls -la notes"), "看目录 notes");
        assert_eq!(say("ls"), "列项目文件");
        assert_eq!(say("cat a.md b.md c.md d.md"), "读 a.md、b.md、c.md 等 4 份");
        // 认不出的照原样
        assert_eq!(say("/bin/zsh -lc 'python3 scripts/check.py'"), "查看：python3 scripts/check.py");
        assert_eq!(say("cat a.md | python3 x.py"), "查看：cat a.md | python3 x.py");
    }

    #[test]
    fn same_error_within_ten_minutes_only_counts_up() {
        let rows = vec![row("save_step", "nothing added", 3)];
        let merged = merge_error(rows, row("save_step", "nothing added", 0), now_fixed());
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].count, 2);
        let merged = merge_error(merged, row("save_step", "other", 0), now_fixed());
        assert_eq!(merged.len(), 2);
        let old = vec![row("save_step", "nothing added", 30)];
        assert_eq!(merge_error(old, row("save_step", "nothing added", 0), now_fixed()).len(), 2);
    }

    #[test]
    fn old_rows_expire_and_cap_holds() {
        let rows = vec![row("a", "x", 60 * 24 * 31)];
        let merged = merge_error(rows, row("b", "y", 0), now_fixed());
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].command, "b");
        let many: Vec<_> = (0..ERRORS_CAP).map(|i| row("c", &i.to_string(), 0)).collect();
        let merged = merge_error(many, row("c", "new", 0), now_fixed());
        assert_eq!(merged.len(), ERRORS_CAP);
        assert_eq!(merged.last().unwrap().message, "new");
        assert_eq!(merged[0].message, "1");
    }

    #[test]
    fn routine_not_found_is_only_kept_with_a_notice() {
        let tmp = std::env::temp_dir().join(format!("mesa-assistant-routine-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let _guard = crate::storage::redirect_config_root(&tmp);
        record_error_sync("/p/r", "invoke", "read_file_preview", "路径不可读: No such file or directory (os error 2)", None).unwrap();
        assert!(read_jsonl::<MesaErrorDto>(&project_dir("/p/r").unwrap().join(ERRORS_FILE)).is_empty());
        record_error_sync("/p/r", "invoke", "save_step", "路径不可读: No such file or directory (os error 2)", Some("保存失败")).unwrap();
        record_error_sync("/p/r", "invoke", "workspace_review", "评审基线写入失败", None).unwrap();
        let rows: Vec<MesaErrorDto> = read_jsonl(&project_dir("/p/r").unwrap().join(ERRORS_FILE));
        assert_eq!(rows.len(), 2, "配上提示的例行失败、真正的失败都记");
        assert!(is_routine_failure("读取目录失败: Not a directory (os error 20)"));
        assert!(!is_routine_failure("路径不在项目/登记资源/工作区/终端目录范围内，拒绝读取"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn notice_attaches_only_to_fresh_unmatched_row() {
        let mut rows = vec![row("a", "x", 0)];
        assert!(attach_notice(&mut rows, "保存失败：x", now_fixed()));
        assert_eq!(rows[0].notice.as_deref(), Some("保存失败：x"));
        assert!(!attach_notice(&mut rows, "又一句", now_fixed()), "已配过提示的不再配");
        let mut stale = vec![row("a", "x", 2)];
        assert!(!attach_notice(&mut stale, "晚到的提示", now_fixed()));
    }

    #[test]
    fn records_and_turns_live_per_project_in_config_dir() {
        let tmp = std::env::temp_dir().join(format!("mesa-assistant-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let _guard = crate::storage::redirect_config_root(&tmp);
        record_error_sync("/p/one", "invoke", "save_step", "boom", None).unwrap();
        record_error_sync("/p/one", "toast", "", "", Some("保存进项目失败：boom")).unwrap();
        record_error_sync("/p/two", "invoke", "x", "other", None).unwrap();
        let one: Vec<MesaErrorDto> = read_jsonl(&project_dir("/p/one").unwrap().join(ERRORS_FILE));
        assert_eq!(one.len(), 1, "提示补到了刚才那条后台失败上");
        assert_eq!(one[0].notice.as_deref(), Some("保存进项目失败：boom"));
        assert!(!project_dir("/p/one").unwrap().starts_with("/p/one"), "不写进项目目录");
        assert!(record_error_sync("/p/one", "weird", "", "x", None).is_err());
        append_turn("/p/one", AssistantTurnDto { at: at(0), question: "q".into(), answer: "a".into(), connection: String::new(), basis: String::new(), cost_usd: None, dispatched: None, echo_of: None }).unwrap();
        let rec = DispatchRecordDto {
            at: at(0),
            target: "step".into(),
            step: Some(2),
            title: "修列名".into(),
            mode: "mail".into(),
            mail_id: Some("m1".into()),
            task_id: None,
            worktree_path: Some("/w/s2".into()),
            note: "已留话".into(),
            echoed: None,
            echoed_at: None,
        };
        let at0 = read_jsonl::<AssistantTurnDto>(&project_dir("/p/one").unwrap().join(LOG_FILE))[0].at.clone();
        mark_dispatched_sync("/p/one", &at0, rec.clone()).unwrap();
        let turns: Vec<AssistantTurnDto> = read_jsonl(&project_dir("/p/one").unwrap().join(LOG_FILE));
        assert_eq!(turns[0].dispatched.as_ref(), Some(&rec));
        assert!(mark_dispatched_sync("/p/one", "nope", rec).is_err(), "找不到那一轮就报错，不乱记");
        let turns: Vec<AssistantTurnDto> = read_jsonl(&project_dir("/p/one").unwrap().join(LOG_FILE));
        assert_eq!(turns.len(), 1);
        let none: Vec<AssistantTurnDto> = read_jsonl(&project_dir("/p/two").unwrap().join(LOG_FILE));
        assert!(none.is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn dispatched_turns_survive_trim_and_echo_once_per_stage() {
        let tmp = std::env::temp_dir().join(format!("mesa-echo-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let _guard = crate::storage::redirect_config_root(&tmp);
        let turn = |i: usize| AssistantTurnDto {
            at: format!("2026-11-05T10:{:02}:{:02}+08:00", i / 60, i % 60),
            question: format!("q{i}"),
            answer: "a".into(),
            connection: String::new(),
            basis: String::new(),
            cost_usd: None,
            dispatched: None,
            echo_of: None,
        };
        // 上限裁剪：派过活的那一轮最旧也留着
        let mut rows: Vec<AssistantTurnDto> = (0..5).map(turn).collect();
        rows[0].dispatched = Some(DispatchRecordDto {
            at: now_fixed().to_rfc3339(),
            target: "goal".into(),
            step: None,
            title: "组会汇报".into(),
            mode: "goal".into(),
            mail_id: None,
            task_id: Some("t1".into()),
            worktree_path: None,
            note: String::new(),
            echoed: None,
            echoed_at: None,
        });
        trim_log(&mut rows, 3);
        assert_eq!(rows.iter().map(|r| r.question.as_str()).collect::<Vec<_>>(), vec!["q0", "q3", "q4"]);

        append_turn("/p/echo", turn(0)).unwrap();
        let at0 = turn(0).at;
        let mut rec = rows[0].dispatched.clone().unwrap();
        rec.note = "已记成目标".into();
        mark_dispatched_sync("/p/echo", &at0, rec).unwrap();
        let open = open_dispatches_sync(now_fixed());
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].project_root, "/p/echo", "从 root.txt 反查到项目");
        let echo = echo_sync("/p/echo", &at0, "review", "「组会汇报」做完了，等你验收。").unwrap().unwrap();
        assert_eq!(echo.echo_of.as_deref(), Some(at0.as_str()));
        assert!(echo.question.is_empty());
        assert!(echo_sync("/p/echo", &at0, "review", "再说一遍").unwrap().is_none(), "同一阶段只补一次");
        assert!(echo_sync("/p/echo", &at0, "accepted", "").unwrap().is_none(), "已验收只记阶段不补话");
        assert!(open_dispatches_sync(now_fixed()).is_empty(), "已验收不再跟");
        let log: Vec<AssistantTurnDto> = read_jsonl(&project_dir("/p/echo").unwrap().join(LOG_FILE));
        assert_eq!(log.len(), 2);
        assert!(echo_sync("/p/echo", &at0, "weird", "").is_err());
        let _ = fs::remove_dir_all(&tmp);
    }
}
