//! 定时雷达：按「每日/每周 + 时分」周期，无头拉起 agent CLI 在隔离 worktree 跑一次技能
//! （默认文献监控 lit-watch，可选技能库里的其他技能），跑完记录历史并发 `scheduler-run-done` 事件给前端。
//! 隔离树先从主仓播种订阅/台账，产物经只读评审后由用户「采纳进主仓」，不自动合并。
//!
//! 存储：应用配置目录 ccode/schedules.json（snake_case）；给前端的 DTO 用 camelCase。
//! due 判定按本地时间算「最近一次应跑时刻」，last_run_at 早于它即 due——应用关闭错过
//! 的时间点在启动后第一个 tick 自动补跑一次（多次漏跑只补一次，coalesce）。

use chrono::{Datelike, Duration as ChronoDuration, Local, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::Emitter;

/// 单条任务执行超时：无头 CLI 巡检 10 分钟足够
/// 定时任务单次预算。v3.75 定 600s；2026-10-03 提高到 30 分钟——实测 GLM 跑 lit-watch
/// （三路检索 + 去重 + 写文件）超 10 分钟，600s 在掐死健康任务；定时任务是后台哨兵、
/// 无人等它，超时只担防僵尸职责，放宽代价小（用户拍板方案 A，不做每任务可配）。
const RUN_TIMEOUT: Duration = Duration::from_secs(1800);
/// 调度 tick 间隔
const TICK_INTERVAL: Duration = Duration::from_secs(60);
/// 历史只留最近 20 条（新的在前）
const HISTORY_CAP: usize = 20;
/// 简报脱敏后截 2000 字符
const SUMMARY_CAP: usize = 2000;

/// 任务 prompt 模板按技能分派：lit-watch 用文献巡检专用文案（一字不动），
/// 其他技能用通用模板（技能自有规范为准，调度器不复制关键词/路径口径）
const TASK_PROMPT_LIT_WATCH: &str = "请使用 {skill} 技能执行一次文献巡检：按 papers/watchlist.md 的订阅清单检索新文献，去重、精选后把命中追加到 notes/inbox.md。追加本次条目前必须先单独写一行 <!-- watch-run: YYYY-MM-DD -->（本次巡检的本地日期，上海时区），已有批次标记的旧条目不要改。能免费直接下载的 PDF（arXiv /pdf/ 直链或以 .pdf 结尾）在结束前用 curl 下到项目根 papers/，文件名用标题，并确认以 %PDF- 开头；出版商页、DOI 落地页和付费墙不要下，题录留在 papers/watch-followup.md。不要写 papers/included.md、notes/index.json 或 references.bib——雷达文献是项目的日常积累，精读与引文库由人发起检索/科研流程后才动。结束时输出三行以内的简报（检索了几条关键词/来源、新命中几篇、其中推荐几篇、哪些来源未达、免费全文下了几篇）。本任务由 Mesa 定时雷达自动触发。";
const TASK_PROMPT_GENERIC: &str = "请使用 {skill} 技能在项目内执行一次定时巡检，按该技能的既定规范产出结果，结束时输出三行以内简报。本任务由 Mesa 定时雷达自动触发。";

// ===== 数据模型 =====

/// 单次运行记录（存储/前端共用）。整体 camelCase 序列化（随 ScheduleDto 直出前端）；
/// 多词字段带蛇形 alias 兼容读旧 schedules.json（历史上 started_at/run_id/isolation_path
/// 以蛇形落盘，2026-10-03 修「isolationPath 从未到达前端」时统一驼峰并保留 alias）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub at: String,
    /// "ok" | "error"
    pub status: String,
    /// 脱敏后截 2000 字符的简报/错误信息
    pub summary: String,
    /// 本次运行新增的收件箱条目数（仅 lit-watch 类任务、仅成功时记；超时/失败为 None）
    #[serde(default, alias = "new_entries")]
    pub new_entries: Option<u32>,
    /// 本次运行的时间窗与直接产物，供历史追踪；老记录缺省兼容。
    #[serde(default, alias = "started_at")]
    pub started_at: Option<String>,
    #[serde(default, alias = "finished_at")]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<String>,
    /// 本次运行的 Run 身份与实际隔离目录；旧记录缺省兼容。
    #[serde(default, alias = "run_id")]
    pub run_id: Option<String>,
    #[serde(default, alias = "isolation_path")]
    pub isolation_path: Option<String>,
    /// 隔离树产物是否已采纳进主仓；旧记录缺省 false。
    #[serde(default)]
    pub adopted: bool,
}

/// 存储形态（schedules.json，snake_case）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Schedule {
    pub id: String,
    pub name: String,
    /// 项目根绝对路径（任务 cwd）
    pub project_root: String,
    /// 技能名，默认 "lit-watch"
    pub skill: String,
    /// None = 每次运行现解析（设置页 AI 专用 profile → 最近使用）
    pub profile_id: Option<String>,
    /// 任务钉住的模型 id（B3）：在所选 profile 名单内生效；不在名单回落名单第一并在
    /// 运行历史披露一句（同连接换档不换认证，不算换家）。None = 名单第一。
    /// serde default 兼容老 schedules.json
    #[serde(default)]
    pub model: Option<String>,
    /// 关联的流水线步骤名（步骤 name；未关联为 None）。serde default 兼容老 schedules.json
    #[serde(default)]
    pub linked_step: Option<String>,
    /// "daily" | "weekly"
    pub frequency: String,
    /// weekly 时 1-7（周一=1）；daily 忽略
    pub weekday: Option<u8>,
    pub hour: u8,
    pub minute: u8,
    pub enabled: bool,
    pub last_run_at: Option<String>,
    pub last_status: Option<String>,
    pub history: Vec<RunRecord>,
}

/// 前端 DTO（camelCase）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDto {
    pub id: String,
    pub running_run_id: Option<String>,
    pub name: String,
    pub project_root: String,
    pub skill: String,
    pub profile_id: Option<String>,
    pub model: Option<String>,
    pub linked_step: Option<String>,
    pub frequency: String,
    pub weekday: Option<u8>,
    pub hour: u8,
    pub minute: u8,
    pub enabled: bool,
    pub last_run_at: Option<String>,
    pub last_status: Option<String>,
    pub history: Vec<RunRecord>,
}

impl From<Schedule> for ScheduleDto {
    fn from(s: Schedule) -> Self {
        Self {
            running_run_id: None,
            id: s.id,
            name: s.name,
            project_root: s.project_root,
            skill: s.skill,
            profile_id: s.profile_id,
            model: s.model,
            linked_step: s.linked_step,
            frequency: s.frequency,
            weekday: s.weekday,
            hour: s.hour,
            minute: s.minute,
            enabled: s.enabled,
            last_run_at: s.last_run_at,
            last_status: s.last_status,
            history: s.history,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateScheduleInput {
    pub name: Option<String>,
    pub project_root: String,
    pub skill: Option<String>,
    pub profile_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// 关联的流水线步骤名（可选；老前端不传为 None）
    pub linked_step: Option<String>,
    pub frequency: String,
    pub weekday: Option<u8>,
    pub hour: u8,
    pub minute: u8,
}

/// 更新补丁：字段全 Option（None = 不改）；profile_id/linked_step 用 Option<Option<String>>，
/// 传空字符串（空白归一为 None）表示清掉指定值、回到每次运行现解析/未关联
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSchedulePatch {
    pub name: Option<String>,
    pub skill: Option<String>,
    #[serde(default)]
    pub profile_id: Option<Option<String>>,
    // 模型补丁：与 profile_id 同口径——Some(空串) 清掉指定模型回名单第一
    #[serde(default)]
    pub model: Option<Option<String>>,
    // 关联步骤补丁。注意 serde 对 Option<Option<T>> 不区分「缺失」与显式 null（都按 None = 不改），
    // 清除关联走 Some("")：空白在下方归一为 None（与 profile_id 的空串过滤口径一致）
    #[serde(default)]
    pub linked_step: Option<Option<String>>,
    pub frequency: Option<String>,
    pub weekday: Option<u8>,
    pub hour: Option<u8>,
    pub minute: Option<u8>,
    pub enabled: Option<bool>,
}

/// `scheduler-run-done` 事件载荷
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunDonePayload {
    schedule_id: String,
    project_root: String,
    schedule_name: String,
    skill: String,
    new_entries: Option<u32>,
    status: String,
    summary: String,
    artifacts: Vec<String>,
}

// ===== 存储 =====

fn schedules_path() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("schedules.json"))
}

fn read_schedules_at(path: &Path) -> Result<Vec<Schedule>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|e| format!("解析 schedules.json 失败: {e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("读取 schedules.json 失败: {e}")),
    }
}

fn write_schedules_at(path: &Path, list: &[Schedule]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(path, &text)
}

/// 项目被移除/删除时清掉挂在该根上的全部定时任务（含文献雷达）。
/// 路径比较走 `paths::same_path`，避免斜杠/大小写把孤儿留下。
/// 2026-10-13 起级联清理运行账行/冻结证据/watch 任务行/worktree（与 delete_schedule 同口径）。
pub(crate) fn delete_schedules_for_project(project_root: &Path) -> Result<usize, String> {
    let removed = {
        let _g = sched_lock()?;
        let store = schedules_path()?;
        let list = read_schedules_at(&store)?;
        let root = project_root.to_string_lossy();
        let removed: Vec<Schedule> = list
            .iter()
            .filter(|t| crate::paths::same_path(&t.project_root, root.as_ref()))
            .cloned()
            .collect();
        let n = removed.len();
        if n > 0 {
            let kept: Vec<Schedule> = list
                .into_iter()
                .filter(|t| !crate::paths::same_path(&t.project_root, root.as_ref()))
                .collect();
            write_schedules_at(&store, &kept)?;
        }
        removed
    };
    for task in &removed {
        if task.skill == "lit-watch" {
            crate::lit_watch::delete_schedule_subscriptions(&task.project_root, &task.id);
        }
        purge_schedule_side_effects(task);
    }
    Ok(removed.len())
}

#[cfg_attr(not(test), allow(dead_code))]
fn delete_schedules_for_project_at(store: &Path, project_root: &Path) -> Result<usize, String> {
    let mut list = read_schedules_at(store)?;
    let before = list.len();
    let root = project_root.to_string_lossy();
    list.retain(|t| !crate::paths::same_path(&t.project_root, root.as_ref()));
    let n = before.saturating_sub(list.len());
    if n > 0 {
        write_schedules_at(store, &list)?;
    }
    Ok(n)
}

/// 丢掉项目已经不在注册表里的定时任务。`registered` 读失败时不要调用——空表会清光全部任务。
fn prune_unregistered(list: Vec<Schedule>, registered: &[String]) -> (Vec<Schedule>, usize) {
    let before = list.len();
    let kept: Vec<Schedule> = list
        .into_iter()
        .filter(|t| {
            registered
                .iter()
                .any(|k| crate::paths::same_path(k, &t.project_root))
        })
        .collect();
    let n = before.saturating_sub(kept.len());
    (kept, n)
}

pub(crate) fn rewrite_profile_ids(rewrites: &[(String, String)]) -> Result<(), String> {
    let path = schedules_path()?;
    let _g = sched_lock()?;
    let mut list = read_schedules_at(&path)?;
    let mut touched = false;
    for s in &mut list {
        if let Some(id) = &mut s.profile_id {
            if let Some((_, to)) = rewrites.iter().find(|(from, _)| from == id) {
                *id = to.clone();
                touched = true;
            }
        }
    }
    if touched {
        write_schedules_at(&path, &list)?;
    }
    Ok(())
}

/// schedules.json 读-改-写进程内锁（同 profiles.rs 的 store_lock 模式）
static SCHED_MUTEX: Mutex<()> = Mutex::new(());

struct ScheduleGuard {
    _file: fs::File,
    _process: MutexGuard<'static, ()>,
}
fn sched_lock() -> Result<ScheduleGuard, String> {
    let process = SCHED_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let file = crate::storage::config_lock("schedules")?;
    Ok(ScheduleGuard {
        _process: process,
        _file: file,
    })
}

/// 正在运行的任务 id（防重入）：tick 内与 run_schedule_now 共用
static RUNNING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn with_running<R>(f: impl FnOnce(&mut HashSet<String>) -> R) -> R {
    let mut g = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashSet::new))
}

/// 成功登记返回 true；已在跑返回 false
fn mark_running(id: &str) -> bool {
    with_running(|s| s.insert(id.to_string()))
}

fn unmark_running(id: &str) {
    with_running(|s| {
        s.remove(id);
    });
}

/// 文件锁在进程退出时由 OS 释放，防双实例同时改同一巡检工作目录。
fn execution_lock_at(dir: &Path, id: &str) -> Result<fs::File, String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建任务锁目录失败：{e}"))?;
    let name = format!("{:x}.lock", md5::compute(id.as_bytes()));
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(name))
        .map_err(|e| format!("打开任务锁失败：{e}"))?;
    file.try_lock()
        .map_err(|_| "该任务正在另一个实例运行，未重复启动")?;
    Ok(file)
}

fn execution_lock(id: &str) -> Result<fs::File, String> {
    execution_lock_at(&schedules_path()?.with_file_name("schedule-locks"), id)
}

fn resolve_git_common_dir(repo: &Path, value: &str) -> String {
    crate::projects::canonical_key(&repo.join(value.trim()))
}

// ===== due 判定（纯函数，时间全部注入，可测） =====

fn at_hms(date: NaiveDate, hour: u8, minute: u8) -> Option<NaiveDateTime> {
    date.and_hms_opt(hour as u32, minute as u32, 0)
}

/// 「最近一次应跑时刻」（本地时间）：daily = 今天 hour:minute（还没到则昨天）；
/// weekly = 本周 weekday+hour:minute（还没到则上周）
fn latest_due_moment(
    frequency: &str,
    weekday: Option<u8>,
    hour: u8,
    minute: u8,
    now: NaiveDateTime,
) -> Option<NaiveDateTime> {
    let today = now.date();
    let mut date = today;
    if frequency == "weekly" {
        // weekday 1-7（周一=1）→ chrono num_days_from_monday 0-6
        let target = (weekday.unwrap_or(1) as i64 - 1).clamp(0, 6);
        let cur = today.weekday().num_days_from_monday() as i64;
        date = today + ChronoDuration::days(target - cur);
    }
    let moment = at_hms(date, hour, minute)?;
    if moment > now {
        date = date - ChronoDuration::days(if frequency == "weekly" { 7 } else { 1 });
    }
    at_hms(date, hour, minute)
}

/// last_run_at（ISO UTC 字符串）→ 本地 NaiveDateTime；解析失败按「没跑过」处理（更安全的方向：补跑）
fn parse_last_run_local(last_run_at: Option<&str>) -> Option<NaiveDateTime> {
    last_run_at.and_then(|s| {
        chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|dt| dt.with_timezone(&Local).naive_local())
    })
}

/// last_run 早于最近一次应跑时刻即 due；None（从没跑过）恒 due。
/// 漏跑多天只算一次 due：跑一次后 last_run 落到最新时刻之后，自然不再 due（coalesce）
fn is_due(
    frequency: &str,
    weekday: Option<u8>,
    hour: u8,
    minute: u8,
    last_run_local: Option<NaiveDateTime>,
    now: NaiveDateTime,
) -> bool {
    let Some(moment) = latest_due_moment(frequency, weekday, hour, minute, now) else {
        return false;
    };
    match last_run_local {
        Some(last) => last < moment,
        None => true,
    }
}

// ===== 校验与构造 =====

fn validate_fields(
    project_root: &str,
    frequency: &str,
    weekday: Option<u8>,
    hour: u8,
    minute: u8,
) -> Result<String, String> {
    let root = crate::sessions::expand_tilde(project_root);
    if !Path::new(&root).is_dir() {
        return Err(format!("项目目录不存在: {root}"));
    }
    if frequency != "daily" && frequency != "weekly" {
        return Err(format!("frequency 必须是 daily 或 weekly: {frequency}"));
    }
    if frequency == "weekly" {
        match weekday {
            Some(d) if (1..=7).contains(&d) => {}
            _ => return Err("weekly 任务必须指定 weekday（1-7，周一=1）".into()),
        }
    }
    if hour >= 24 {
        return Err(format!("hour 必须在 0-23: {hour}"));
    }
    if minute >= 60 {
        return Err(format!("minute 必须在 0-59: {minute}"));
    }
    Ok(root)
}

fn build_task_prompt(skill: &str) -> String {
    let template = if skill == "lit-watch" {
        TASK_PROMPT_LIT_WATCH
    } else {
        TASK_PROMPT_GENERIC
    };
    template.replace("{skill}", skill)
}

fn cap_summary(text: &str) -> String {
    text.chars().take(SUMMARY_CAP).collect()
}

fn create_schedule_at(path: &Path, input: CreateScheduleInput) -> Result<Schedule, String> {
    let _g = sched_lock()?;
    let root = validate_fields(
        &input.project_root,
        &input.frequency,
        input.weekday,
        input.hour,
        input.minute,
    )?;
    let name = input
        .name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "文献雷达".into());
    let skill = input
        .skill
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "lit-watch".into());
    let task = Schedule {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        project_root: root,
        skill,
        profile_id: input.profile_id.filter(|v| !v.trim().is_empty()),
        model: input.model.filter(|v| !v.trim().is_empty()),
        linked_step: input
            .linked_step
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        frequency: input.frequency,
        weekday: input.weekday,
        hour: input.hour,
        minute: input.minute,
        enabled: true,
        last_run_at: None,
        last_status: None,
        history: Vec::new(),
    };
    let mut list = read_schedules_at(path)?;
    list.push(task.clone());
    write_schedules_at(path, &list)?;
    Ok(task)
}

fn update_schedule_at(
    path: &Path,
    id: &str,
    patch: UpdateSchedulePatch,
) -> Result<Schedule, String> {
    let _g = sched_lock()?;
    let mut list = read_schedules_at(path)?;
    let task = list
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("定时任务不存在: {id}"))?;
    if let Some(name) = patch.name {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("名称不能为空".into());
        }
        task.name = name;
    }
    if let Some(skill) = patch.skill {
        let skill = skill.trim().to_string();
        if skill.is_empty() {
            return Err("技能不能为空".into());
        }
        task.skill = skill;
    }
    // W2a 写侧校验（与槽位/目标写入同口径）：钉的连接须存在、模型须在名单。
    // 日程是无人值守长住户，脏值只能等下一次到点才炸——写时就拦。
    let effective_profile = patch
        .profile_id
        .as_ref()
        .and_then(|p| p.as_deref())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .or_else(|| task.profile_id.clone());
    if let Some(pid) = effective_profile.as_deref() {
        let bindings = crate::gateway_store::load_bindings()?;
        let binding = bindings
            .iter()
            .find(|binding| binding.id == pid)
            .ok_or("连接不存在")?;
        let model_patch = patch
            .model
            .as_ref()
            .and_then(|m| m.as_deref())
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(|m| m.to_string())
            .or_else(|| task.model.clone());
        crate::projects::accept_project_model(
            &binding.models,
            model_patch.as_deref(),
        )?;
    }
    if let Some(profile_id) = patch.profile_id {
        task.profile_id = profile_id.filter(|v| !v.trim().is_empty());
    }
    if let Some(model) = patch.model {
        task.model = model.filter(|v| !v.trim().is_empty());
    }
    if let Some(linked_step) = patch.linked_step {
        task.linked_step = linked_step
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
    }
    if let Some(frequency) = patch.frequency {
        task.frequency = frequency;
    }
    if let Some(weekday) = patch.weekday {
        task.weekday = Some(weekday);
    }
    if let Some(hour) = patch.hour {
        task.hour = hour;
    }
    if let Some(minute) = patch.minute {
        task.minute = minute;
    }
    if let Some(enabled) = patch.enabled {
        task.enabled = enabled;
    }
    // 校验合并后的整体（如 daily→weekly 时必须已有合法 weekday）
    let root = validate_fields(
        &task.project_root,
        &task.frequency,
        task.weekday,
        task.hour,
        task.minute,
    )?;
    task.project_root = root;
    let task = task.clone();
    write_schedules_at(path, &list)?;
    Ok(task)
}

/// 跑一次后回填 last_run_at/last_status/history（新的在前，只留 20 条）并原子写。
/// new_entries 仅 lit-watch 类任务成功时才有值（超时/失败由调用方传 None）
fn record_run(
    id: &str,
    status: &str,
    summary: &str,
    new_entries: Option<u32>,
    started_at: String,
    finished_at: String,
    artifacts: Vec<String>,
    run_id: Option<String>,
    isolation_path: Option<String>,
) -> Result<(), String> {
    let _g = sched_lock()?;
    let path = schedules_path()?;
    let mut list = read_schedules_at(&path)?;
    let task = list
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("定时任务不存在: {id}"))?;
    let at = crate::sessions::now_iso();
    task.last_run_at = Some(at.clone());
    task.last_status = Some(status.to_string());
    task.history.insert(
        0,
        RunRecord {
            at: at.clone(),
            status: status.to_string(),
            summary: summary.to_string(),
            new_entries,
            started_at: Some(started_at),
            finished_at: Some(finished_at),
            artifacts,
            run_id,
            isolation_path,
            adopted: false,
        },
    );
    task.history.truncate(HISTORY_CAP);
    write_schedules_at(&path, &list)
}

/// 追踪任务时间窗内写入的项目产物。只返回项目根内的文件，避免把密钥/绝对路径
/// 写进历史；数量上限防止一次任务生成大量缓存拖垮 schedules.json。
fn changed_artifacts(root: &Path, started: std::time::SystemTime) -> Vec<String> {
    fn visit(root: &Path, dir: &Path, started: std::time::SystemTime, out: &mut Vec<String>) {
        if out.len() >= 50 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if out.len() >= 50 {
                return;
            }
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if entry.file_name() != ".git" && entry.file_name() != "node_modules" {
                    visit(root, &path, started, out);
                }
            } else if meta.is_file() && meta.modified().map(|t| t >= started).unwrap_or(false) {
                if let Ok(rel) = path.strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    let mut out = Vec::new();
    visit(root, root, started, &mut out);
    out.sort();
    out
}

// 定时任务默认只能在独立 worktree 执行；非 Git 项目不静默回落主仓。
fn schedule_isolation(task: &Schedule) -> Result<PathBuf, String> {
    let root = PathBuf::from(crate::projects::canonical_key(Path::new(
        &task.project_root,
    )));
    if !root.is_dir() {
        return Err(format!("项目目录不存在: {}", root.display()));
    }
    crate::workspaces::run_git(&root, &["rev-parse", "--git-dir"], Duration::from_secs(10))
        .map_err(|e| format!("定时任务必须在 Git 项目中运行，无法创建隔离 worktree：{e}"))?;
    let repo_name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");
    let path = dirs::home_dir()
        .ok_or("无法确定用户主目录")?
        .join("ccode/watch-worktrees")
        .join(repo_name)
        .join(&task.id);
    if path.exists() {
        let canonical = crate::paths::canonicalize_plain(&path)
            .map_err(|e| format!("定时隔离目录无法解析：{e}"))?;
        if !canonical.is_dir() || canonical == root {
            return Err("定时隔离路径不是独立目录".into());
        }
        let wt_root = crate::workspaces::run_git(
            &canonical,
            &["rev-parse", "--show-toplevel"],
            Duration::from_secs(10),
        )
        .map_err(|e| format!("定时隔离目录不是有效 worktree：{e}"))?;
        if crate::projects::canonical_key(Path::new(wt_root.trim()))
            != crate::projects::canonical_key(&canonical)
        {
            return Err("定时隔离目录未登记为该 worktree，拒绝使用".into());
        }
        let common = crate::workspaces::run_git(
            &canonical,
            &["rev-parse", "--git-common-dir"],
            Duration::from_secs(10),
        )
        .map_err(|e| format!("无法校验定时 worktree 所属仓库：{e}"))?;
        let root_common = crate::workspaces::run_git(
            &root,
            &["rev-parse", "--git-common-dir"],
            Duration::from_secs(10),
        )
        .map_err(|e| format!("无法校验项目仓库：{e}"))?;
        if !crate::paths::same_path(
            &resolve_git_common_dir(&canonical, &common),
            &resolve_git_common_dir(&root, &root_common),
        ) {
            return Err("定时隔离目录属于其他仓库，拒绝使用".into());
        }
        return Ok(canonical);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建定时隔离目录失败：{e}"))?;
    }
    crate::workspaces::run_git(
        &root,
        &[
            "worktree",
            "add",
            "--detach",
            &path.to_string_lossy(),
            "HEAD",
        ],
        Duration::from_secs(60),
    )
    .map_err(|e| format!("创建定时隔离 worktree 失败：{e}"))?;
    crate::paths::canonicalize_plain(&path).map_err(|e| format!("定时隔离目录无法解析：{e}"))
}

/// 旧口径曾每次从主仓刷新 papers/watchlist.md。2026-10-13 起订阅按任务一份
/// （.ccode/watch/<id>/watchlist.md），播种时由 seed_watch_isolation 单独写入。
/// 隔离树没有才拷：台账/收件箱/跟进/引文，避免冲掉本日程已处理记录。
pub(crate) const WATCH_SEED_IF_ABSENT: &[&str] = &[
    "papers/watch-seen.md",
    "papers/watch-followup.md",
    "notes/inbox.md",
    "notes/references.bib",
];
/// 采纳进主仓的产出文件。订阅在 .ccode/watch/<id>/，不从隔离树回写。
pub(crate) const WATCH_ADOPT_FILES: &[&str] = &[
    "notes/inbox.md",
    "papers/watch-seen.md",
    "papers/watch-followup.md",
    "notes/references.bib",
    // 巡检结束时收下的免费全文。目录模式：采纳时按隔离树里新增的 PDF 拷进主仓。
    "papers/",
];

/// 某次巡检的可采纳契约（§4.9 后半）：四类文献台账是基线；非 lit-watch 技能并上其
/// SKILL.md frontmatter 声明的产出（outputs；目录带尾斜杠）。契约外路径永不自动采纳。
pub(crate) fn watch_adopt_patterns_for(skill: &str) -> Vec<String> {
    let mut patterns: Vec<String> = WATCH_ADOPT_FILES.iter().map(|s| s.to_string()).collect();
    if skill != "lit-watch" {
        for out in crate::skills::skill_declared_outputs(skill) {
            let rel = out.trim().replace('\\', "/");
            if watch_rel_ok(&rel) && !patterns.contains(&rel) {
                patterns.push(rel);
            }
        }
    }
    patterns
}

/// 契约命中：字面路径相等，或目录模式（尾 /）的前缀命中。
pub(crate) fn watch_pattern_allows(patterns: &[String], rel: &str) -> bool {
    patterns.iter().any(|pattern| {
        if let Some(dir) = pattern.strip_suffix('/') {
            rel.starts_with(&format!("{dir}/"))
        } else {
            pattern == rel
        }
    })
}

pub(crate) fn watch_rel_ok(rel: &str) -> bool {
    let t = rel.trim();
    !t.is_empty()
        && !t.starts_with('/')
        && !t.starts_with('\\')
        && !t
            .split(['/', '\\'])
            .any(|p| p.is_empty() || p == "." || p == "..")
}

/// 在两个已存在的目录之间拷贝白名单相对路径。源缺失返回 Ok(false)；符号链接拒绝。
pub(crate) fn copy_watch_rel(
    from: &Path,
    to: &Path,
    rel: &str,
    overwrite: bool,
) -> Result<bool, String> {
    if !watch_rel_ok(rel) {
        return Err(format!("不允许的相对路径: {rel}"));
    }
    let src = from.join(rel);
    let dest = to.join(rel);
    let src_meta = match std::fs::symlink_metadata(&src) {
        Ok(m) => m,
        Err(_) => return Ok(false),
    };
    if src_meta.file_type().is_symlink() || !src_meta.is_file() {
        return Ok(false);
    }
    if dest
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!("拒绝写入符号链接: {rel}"));
    }
    if dest.exists() && !overwrite {
        return Ok(false);
    }
    let from_c =
        crate::paths::canonicalize_plain(from).map_err(|e| format!("源目录无法解析: {e}"))?;
    let to_c =
        crate::paths::canonicalize_plain(to).map_err(|e| format!("目标目录无法解析: {e}"))?;
    let src_c =
        crate::paths::canonicalize_plain(&src).map_err(|e| format!("源文件无法解析: {e}"))?;
    if !crate::paths::path_within_path(&src_c, &from_c) {
        return Err(format!("源文件不在允许目录内: {rel}"));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {e}"))?;
        let parent_c = crate::paths::canonicalize_plain(parent)
            .map_err(|e| format!("目标目录无法解析: {e}"))?;
        if !crate::paths::path_within_path(&parent_c, &to_c) {
            return Err(format!("目标路径逃出允许目录: {rel}"));
        }
    }
    fs::copy(&src, &dest).map_err(|e| format!("复制 {rel} 失败: {e}"))?;
    Ok(true)
}

pub(crate) fn seed_watch_isolation(project_root: &Path, isolation: &Path) -> Result<(), String> {
    for rel in WATCH_SEED_IF_ABSENT {
        copy_watch_rel(project_root, isolation, rel, false)?;
    }
    Ok(())
}

/// 文献雷达这次跑只看这一份订阅。空清单也写入，巡检据此停下来，
/// 不回退去读项目根那份已废弃的共享 watchlist。
pub(crate) fn seed_schedule_watchlist(
    isolation: &Path,
    subs: &[crate::lit_watch::WatchSubscriptionDto],
) -> Result<(), String> {
    let text = crate::lit_watch::render_watchlist_new(subs);
    let dest = isolation.join("papers/watchlist.md");
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建订阅目录失败：{e}"))?;
    }
    crate::profiles::atomic_write(&dest, &text).map_err(|e| format!("写入本次订阅失败：{e}"))
}

fn mark_run_adopted(run_id: &str) -> Result<(), String> {
    let _g = sched_lock()?;
    let path = schedules_path()?;
    let mut list = read_schedules_at(&path)?;
    let mut found = false;
    for task in &mut list {
        for rec in &mut task.history {
            if rec.run_id.as_deref() == Some(run_id) {
                rec.adopted = true;
                found = true;
            }
        }
    }
    if !found {
        return Err("找不到对应的定时运行记录".into());
    }
    write_schedules_at(&path, &list)
}

/// 在任务历史里找 run_id 对应的成功记录；返回所属任务与该记录是否已采纳。
/// 采纳入口与评审决定闸门共用同一判定。
fn find_run_record<'a>(records: &'a [Schedule], run_id: &str) -> Option<(&'a Schedule, bool)> {
    records.iter().find_map(|task| {
        task.history
            .iter()
            .find(|record| record.run_id.as_deref() == Some(run_id) && record.status == "ok")
            .map(|record| (task, record.adopted))
    })
}

/// 评审决定的后端闸门：已采纳的运行决定已定稿，留下/排除不能再改。
/// 前端 locked 只是隐藏按钮，这里挡住绕过前端的调用。
pub(crate) fn run_marked_adopted(run_id: &str) -> bool {
    let Ok(path) = schedules_path() else {
        return false;
    };
    let Ok(list) = read_schedules_at(&path) else {
        return false;
    };
    find_run_record(&list, run_id).is_some_and(|(_, adopted)| adopted)
}

/// 把隔离树里的巡检产物拷进主仓。不走 git merge，不自动发生。
#[tauri::command]
pub fn adopt_watch_run(app: tauri::AppHandle, run_id: String) -> Result<Vec<String>, String> {
    let run = crate::runs::run_get(run_id.clone())?.ok_or("Run 不存在")?;
    if run.task_kind != "watch" {
        return Err("只有定时巡检 Run 可以采纳进主仓".into());
    }
    if run.status != "completed" || run.closed_at.is_none() {
        return Err("只有成功完成的定时任务可以采纳".into());
    }
    let records = {
        let _guard = sched_lock()?;
        read_schedules_at(&schedules_path()?)?
    };
    let matched = find_run_record(&records, &run_id);
    let Some((schedule, already_adopted)) = matched else {
        return Err("没有成功的运行历史，不能自动采纳；请手动对比冻结证据后合并".into());
    };
    // 已采纳的运行证据没变，再点只会得到一次内容相同的空拷贝；明确拒绝并指回查看入口
    if already_adopted {
        return Err("这次运行已经采纳过；定时任务历史里点「查看」可回看当时的命中与决定".into());
    }
    let patterns = watch_adopt_patterns_for(&schedule.skill);
    let project = run.project_root.as_deref().ok_or("Run 没有所属项目")?;
    let project = gated_project_root(project)?;
    let _apply_lock = crate::review_contract::apply_lock(&project)?;
    let isolation = PathBuf::from(crate::sessions::expand_tilde(&run.isolation_path));
    if !isolation.is_dir() {
        return Err("隔离目录不存在".into());
    }
    if crate::paths::path_within_path(&isolation, &project) {
        return Err("隔离路径落在主仓内，拒绝采纳".into());
    }
    let mut snapshot = crate::watch_review::load_at(&crate::watch_review::review_dir()?, &run_id)?;
    if !crate::paths::same_path(&snapshot.project_root, &project.to_string_lossy()) {
        return Err("冻结证据所属项目与运行记录不一致".into());
    }
    // 评审里被「排除」的条目不进项目：采纳前从冻结的收件箱文本里整段剔除。
    // 雷达文献只是项目内的日常积累，纳入/排除不写科研流程的精读清单与引用库，
    // 这里只决定这批积累里哪些留在项目的收件箱（2026-10-13 用户拍板口径）。
    if schedule.skill == "lit-watch" {
        let excluded = crate::watch_review::excluded_entry_ids(&isolation);
        crate::watch_review::drop_excluded_from_snapshot(&mut snapshot, &excluded);
    }
    // 保护清单读不出来 = 不可信，fail-closed 拒绝采纳（与 runs.rs 验收写回同一口径）
    let protected = crate::projects::protected_paths_at(&project)?;
    let copied = crate::watch_review::adopt_at(
        &crate::watch_review::review_dir()?,
        &snapshot,
        &project,
        &protected,
        &patterns,
    )?;
    // 免费全文是二进制，文本冻结带不走。隔离树 papers/ 里主仓还没有的 PDF 直接拷过来并登记。
    let mut copied = copied;
    if schedule.skill == "lit-watch" {
        match crate::lit_watch::adopt_watch_pdfs(&isolation, &project) {
            Ok(pdfs) => copied.extend(pdfs),
            Err(e) => {
                return Err(format!(
                    "文本已采纳，但免费全文没拷进 papers/：{e}。可再执行一次采纳补拷"
                ));
            }
        }
    }
    let fact = crate::projects::AcceptanceLogEntry {
        goal_id: String::new(),
        goal_name: schedule.skill.clone(),
        run_id: run_id.clone(),
        paths: copied.clone(),
        note: "定时巡检采纳".into(),
        frozen: true,
        decided_at: crate::sessions::now_iso(),
        kind: crate::review_contract::KIND_WATCH_ADOPT.into(),
        version_id: run_id.clone(),
        reviewed_sha: None,
        project_id: crate::projects::project_id_at(&project),
        scene_ref: Some(schedule.id.clone()),
        content_fingerprints: Vec::new(),
    };
    crate::review_contract::commit_fact(&project, &fact)
        .map_err(|e| format!("文件已采纳，但验收记录落盘失败：{e}。请再执行一次采纳以补记"))?;
    mark_run_adopted(&run_id)
        .map_err(|e| format!("文件已采纳，但更新历史标记失败：{e}；重试不会重复覆盖相同内容"))?;
    let _ = app.emit("watch-run-adopted", &run_id);
    Ok(copied)
}

fn is_timeout_error(err: &str) -> bool {
    err.contains("AI 调用超时")
}

/// 无头/定时写盘能力闸（数据单一出处 = agent_specs 能力表，不另抄名单）：
/// 最终解析出的 agent supported=false（如 qwen 未验证）返回用户可见原因；
/// 支持（含「按该工具默认权限写文件 / 会批准全部操作」警示档）与表外 agent 放行。
fn headless_write_block_reason(agent: &str) -> Option<String> {
    let caps = crate::agent_specs::agent_capabilities();
    let cap = caps.iter().find(|c| c.agent == agent)?;
    if cap.headless_write.supported {
        None
    } else {
        Some(format!(
            "{agent}：{}",
            cap.headless_write.reason.unwrap_or("不能用于定时任务")
        ))
    }
}

// ===== 执行 =====

/// 执行一条任务并回填历史，返回事件载荷。失败（进程错误/超时/解析不到 profile/
/// 找不到二进制/项目目录不存在）同样记 history（status="error"）。
/// 绝不真的在测试里调用（会拉起 CLI）。
fn execute_one(id: &str) -> RunDonePayload {
    let started = std::time::SystemTime::now();
    let started_at = crate::sessions::now_iso();
    let path = match schedules_path() {
        Ok(p) => p,
        Err(e) => {
            return RunDonePayload {
                schedule_id: id.to_string(),
                project_root: String::new(),
                schedule_name: "定时任务".into(),
                skill: String::new(),
                new_entries: None,
                status: "error".into(),
                summary: e,
                artifacts: Vec::new(),
            }
        }
    };
    let task = {
        let _g = match sched_lock() {
            Ok(g) => g,
            Err(error) => {
                return RunDonePayload {
                    schedule_id: id.into(),
                    project_root: String::new(),
                    schedule_name: "定时任务".into(),
                    skill: String::new(),
                    new_entries: None,
                    status: "error".into(),
                    summary: error,
                    artifacts: Vec::new(),
                }
            }
        };
        match read_schedules_at(&path) {
            Ok(list) => list.into_iter().find(|t| t.id == id),
            Err(e) => {
                crate::logbuf::record(
                    "error",
                    "scheduler",
                    &format!("读取 schedules.json 失败: {e}"),
                );
                None
            }
        }
    };
    let Some(task) = task else {
        return RunDonePayload {
            schedule_id: id.to_string(),
            project_root: String::new(),
            schedule_name: "定时任务".into(),
            skill: String::new(),
            new_entries: None,
            status: "error".into(),
            summary: format!("定时任务不存在: {id}"),
            artifacts: Vec::new(),
        };
    };
    // 新增条目计数仅对 lit-watch 类任务有意义（只有它往 notes/inbox.md 追加条目）
    let is_lit_watch = task.skill == "lit-watch";
    let scheduled_isolation = schedule_isolation(&task).and_then(|path| {
        seed_watch_isolation(Path::new(&task.project_root), &path)?;
        if task.skill == "lit-watch" {
            let subs = crate::lit_watch::read_schedule_subscriptions(
                Path::new(&task.project_root),
                &task.id,
            )?;
            seed_schedule_watchlist(&path, &subs)?;
        }
        Ok(path)
    });
    // 项目配了雷达筛选时，新增计数只算通过筛选的条目（推送口径 = 用户要看的口径）
    let lit_filter = if is_lit_watch {
        crate::projects::lit_watch_filter_for(Path::new(&task.project_root))
    } else {
        None
    };
    let before_entries = if is_lit_watch {
        Some(crate::lit_watch::count_inbox_entries_matching(
            scheduled_isolation
                .as_ref()
                .map(|p| p.as_path())
                .unwrap_or(Path::new(&task.project_root)),
            lit_filter.as_ref(),
        ))
    } else {
        None
    };
    // 绑定 profile 被删导致回落时，在运行历史里留一句说明（成功/失败都带）
    let mut actual_isolation: Option<String> = None;
    let mut run_id: Option<String> = None;
    // B3 模型换档披露：执行闭包写、成功简报读（无人值守不静默换档）
    let mut model_note = String::new();
    let result: Result<String, String> = (|| {
        let root = scheduled_isolation.as_ref().map_err(Clone::clone)?;
        actual_isolation = Some(root.to_string_lossy().into_owned());
        let root = root.as_path();
        let profiles = crate::profiles::ProfileStore::new()?.list()?;
        // 日程的显式连接失效必须停止，不得在无人确认时换供应商/认证出站。
        let cur_settings = crate::settings::read_current_checked()?;
        let dedicated_model = cur_settings.ai_model.clone();
        let dedicated = cur_settings.ai_profile_id.clone();
        let hidden: std::collections::HashSet<String> = cur_settings
            .hidden_profiles
            .unwrap_or_default()
            .into_iter()
            .collect();
        let pinned = task.profile_id.clone().filter(|v| !v.trim().is_empty());
        let profile = match crate::ai::resolve_profile_from(
            profiles,
            pinned.clone(),
            None,
            dedicated.clone(),
            &hidden,
        ) {
            Ok(profile) => profile,
            Err(error) => {
                // Profile resolution is part of the Run lifecycle too: keep a durable
                // failed Run even though no agent process can be started.
                let failed = crate::runs::open_headless_with_root(
                    Some(&task.project_root),
                    "scheduler",
                    "",
                    &root.to_string_lossy(),
                    &format!("watch:{}:{}", task.id, task.project_root),
                    false,
                    "write_tree",
                )?;
                run_id = Some(failed.id.clone());
                return Err(error);
            }
        };
        // 无头写盘 fail-loud：手动列表的禁选只在 UI 层，选「自动」时回落解析可能落到
        // 未验证无头写盘的 agent（如 qwen）；执行链对最终 agent 按能力表再拦一次——
        // 不静默换别家，也不带未验证权限照跑。与解析失败同口径：留失败 Run，原因进运行历史。
        if let Some(reason) = headless_write_block_reason(&profile.agent) {
            let failed = crate::runs::open_headless_with_root(
                Some(&task.project_root),
                &profile.agent,
                &profile.id,
                &root.to_string_lossy(),
                &format!("watch:{}:{}", task.id, task.project_root),
                false,
                "write_tree",
            )?;
            run_id = Some(failed.id.clone());
            return Err(reason);
        }
        // 先登记这次定时执行的 Run，再做技能分发和 CLI 启动检查。
        // 这样“技能未分发/启动前失败”也能和定时历史通过同一个 runId 对上。
        let reuse = format!("watch:{}:{}", task.id, task.project_root);
        let run = crate::runs::open_headless_with_root(
            Some(&task.project_root),
            &profile.agent,
            &profile.id,
            &root.to_string_lossy(),
            &reuse,
            false,
            "write_tree",
        )?;
        run_id = Some(run.id.clone());
        // 可采纳契约 = 四类文献台账 + 该技能声明的产出（§4.9 后半）
        let patterns = watch_adopt_patterns_for(&task.skill);
        let evidence =
            crate::watch_review::prepare(&run.id, Path::new(&task.project_root), root, &patterns)?;
        // 自定义巡检靠技能目录里的 SKILL.md；未分发则无头跑找不到规范。
        // lit-watch 的 prompt 自带完整口径，不拦存量任务。
        if task.skill != "lit-watch" {
            crate::skills::require_skill_distributed(&task.skill, &profile.agent)?;
        }
        // 模型解析（B3）：任务钉住的模型在名单内直接用；不在名单回落名单第一并记
        // 一句披露（无人值守场景不能静默换档；同连接换档不换认证，不算换家）。
        // 未钉走既有档位链（dedicated 命中取 settings.ai_model，否则名单第一）。
        // model_note 是 &mut String 借用——闭包写、闭包外 summary 读
        // 模型与配置独立生效（设计拍板）：自动解析出的连接也校验任务模型，在名单即用
        let pinned_model = task
            .model
            .clone()
            .filter(|m| !m.trim().is_empty());
        let model = if let Some(want) = pinned_model.as_deref() {
            let models = &profile.models;
            if models.iter().any(|m| m == want) {
                Some(want.to_string())
            } else {
                // 名单空：不传模型（CLI 默认档），披露写实话；不拼「本次用 」的空名句
                match models.first() {
                    Some(fallback) => {
                        model_note =
                            format!("绑定模型 {want} 已不在名单，本次用 {fallback}；");
                        Some(fallback.clone())
                    }
                    None => {
                        model_note = format!(
                            "绑定模型 {want} 已不在名单，连接名单为空，本次未指定模型；"
                        );
                        None
                    }
                }
            }
        } else {
            crate::ai::preferred_ai_model(
                &profile.id,
                pinned.as_deref().filter(|id| !id.trim().is_empty()),
                None,
                None,
                dedicated.as_deref(),
                dedicated_model.as_deref(),
            )
            .map(str::to_string)
        };
        crate::ai::run_agent_task(
            &profile,
            model.as_deref(),
            &build_task_prompt(&task.skill),
            root,
            RUN_TIMEOUT,
            Some(&reuse),
            false,
            Some(Path::new(&task.project_root)),
            run_id.as_deref(),
        )
        .and_then(|(output, id)| {
            run_id = Some(id);
            // 模型漏写 <!-- watch-run --> 时，在冻结前用本次完成日（上海）补上。
            // 只补还没有批次的条目；已有标记不动（忽略 id 按标题+原注释日期算）。
            // 补不上不挡冻结：趋势仍可在打开雷达时再补。
            if is_lit_watch {
                if let Some(day) = crate::lit_watch::shanghai_calendar_day(&crate::sessions::now_iso())
                {
                    if let Err(e) = crate::lit_watch::stamp_undated_inbox(root, &day) {
                        crate::logbuf::record(
                            "warn",
                            "scheduler",
                            &format!("补巡检批次日期失败: {e}"),
                        );
                    }
                }
            }
            crate::watch_review::freeze_at(
                &crate::watch_review::review_dir()?,
                evidence,
                root,
                &patterns,
            )
            .map_err(|e| format!("任务执行完成，但冻结产物证据失败，未开放自动采纳：{e}"))?;
            Ok(output)
        })
    })();
    // Run 已创建但在 CLI 进入 ai.rs 前失败（例如技能未分发）时，补齐失败终态。
    if result.is_err() {
        if let Some(id) = run_id.as_deref() {
            if let Ok(Some(run)) = crate::runs::run_get(id.to_string()) {
                if run.closed_at.is_none() {
                    let _ = crate::runs::close_run_with_result(
                        id,
                        None,
                        "failed",
                        None,
                        Some("定时任务在启动前失败"),
                    );
                }
            }
        }
    }
    // 超时/失败不记新增数：只有成功跑完才数第二次取差值（saturating_sub 防文件被外部截断）
    let new_entries = match (&result, before_entries) {
        (Ok(_), Some(before)) => Some(
            crate::lit_watch::count_inbox_entries_matching(
                scheduled_isolation
                    .as_ref()
                    .map(|p| p.as_path())
                    .unwrap_or(Path::new(&task.project_root)),
                lit_filter.as_ref(),
            )
            .saturating_sub(before),
        ),
        _ => None,
    };
    let (status, summary) = match result {
        // 简报/错误文本落存储与发事件前必须脱敏；模型换档披露前缀（scheduler.rs:1081 先例）
        Ok(out) => (
            "ok",
            cap_summary(&format!(
                "{model_note}{}",
                crate::sessions::redact_sensitive_text(&out)
            )),
        ),
        Err(e) if e.contains("任务已取消") => (
            "cancelled",
            cap_summary(&crate::sessions::redact_sensitive_text(&e)),
        ),
        Err(e) if is_timeout_error(&e) => (
            "timeout",
            cap_summary(&crate::sessions::redact_sensitive_text(&e)),
        ),
        Err(e) => (
            "error",
            cap_summary(&crate::sessions::redact_sensitive_text(&e)),
        ),
    };
    let finished_at = crate::sessions::now_iso();
    let artifacts = if status == "ok" {
        changed_artifacts(
            actual_isolation
                .as_deref()
                .map(Path::new)
                .unwrap_or_else(|| Path::new(&task.project_root)),
            started,
        )
    } else {
        Vec::new()
    };
    let summary = if status == "ok" && is_lit_watch {
        match crate::lit_watch::output_note(
            actual_isolation
                .as_deref()
                .map(Path::new)
                .unwrap_or_else(|| Path::new(&task.project_root)),
        ) {
            Some(note) => format!("{summary}；产物检查：{note}"),
            None => summary,
        }
    } else {
        summary
    };
    if let Err(e) = record_run(
        id,
        status,
        &summary,
        new_entries,
        started_at,
        finished_at,
        artifacts.clone(),
        run_id,
        actual_isolation,
    ) {
        crate::logbuf::record("error", "scheduler", &format!("回填运行历史失败: {e}"));
    }
    RunDonePayload {
        schedule_id: id.to_string(),
        project_root: task.project_root,
        schedule_name: task.name,
        skill: task.skill,
        new_entries,
        status: status.to_string(),
        summary,
        artifacts,
    }
}

fn emit_done(app: &tauri::AppHandle, payload: RunDonePayload) {
    if let Err(e) = app.emit("scheduler-run-done", &payload) {
        crate::logbuf::record(
            "warn",
            "scheduler",
            &format!("发送 scheduler-run-done 事件失败: {e}"),
        );
    }
}

/// 收集本轮 due 的任务 id（enabled 且未在跑）
fn collect_due_ids() -> Vec<String> {
    // 到点的文献雷达还没有自己的关键词时不跑。共享 watchlist 已不再是真源。
    if let Err(error) = crate::lit_watch::adopt_shared_watchlists() {
        crate::logbuf::record("warn", "scheduler", &error);
    }
    let path = match schedules_path() {
        Ok(p) => p,
        Err(e) => {
            crate::logbuf::record("error", "scheduler", &e);
            return Vec::new();
        }
    };
    let list = {
        let _g = match sched_lock() {
            Ok(g) => g,
            Err(e) => {
                crate::logbuf::record("error", "scheduler", &e);
                return Vec::new();
            }
        };
        match read_schedules_at(&path) {
            Ok(l) => l,
            Err(e) => {
                crate::logbuf::record("error", "scheduler", &e);
                return Vec::new();
            }
        }
    };
    let now = Local::now().naive_local();
    let registered = crate::projects::registered_path_keys().ok();
    list.into_iter()
        .filter(|t| t.enabled)
        .filter(|t| {
            registered
                .as_ref()
                .map(|keys| {
                    keys.iter()
                        .any(|k| crate::paths::same_path(k, &t.project_root))
                })
                .unwrap_or(true)
        })
        .filter(|t| t.skill != "lit-watch" || schedule_has_keywords(t))
        .filter(|t| {
            is_due(
                &t.frequency,
                t.weekday,
                t.hour,
                t.minute,
                parse_last_run_local(t.last_run_at.as_deref()),
                now,
            )
        })
        .filter(|t| with_running(|s| !s.contains(&t.id)))
        .map(|t| t.id)
        .collect()
}

fn claim_due_after_lock(id: &str, due: &[String]) -> bool {
    due.iter().any(|candidate| candidate == id) && mark_running(id)
}

/// 启动调度引擎（lib.rs setup 里调用一次）：后台线程每 60s 一个 tick，
/// 启动即先跑一轮——天然补跑应用关闭期间错过的任务；多条 due 任务串行执行，
/// 避免并发拉起一堆 CLI。用 spawn_blocking + thread::sleep（参照 diagnostics 后台循环），
/// 不为一个 sleep 引入 tokio 依赖。
pub fn start_scheduler(app: tauri::AppHandle) {
    tauri::async_runtime::spawn_blocking(move || loop {
        if crate::process::shutting_down() {
            break;
        }
        for id in collect_due_ids() {
            let lease = match execution_lock(&id) {
                Ok(lease) => lease,
                Err(error) => {
                    crate::logbuf::record("warn", "scheduler", &error);
                    continue;
                }
            };
            // 到期集合排除 RUNNING：必须在本进程登记前重查，否则会把自己过滤掉。
            if !claim_due_after_lock(&id, &collect_due_ids()) {
                continue;
            }
            let payload = execute_one(&id);
            drop(lease);
            unmark_running(&id);
            emit_done(&app, payload);
        }
        std::thread::sleep(TICK_INTERVAL);
    });
}

// ===== Tauri commands =====

#[tauri::command]
pub fn list_schedules() -> Result<Vec<ScheduleDto>, String> {
    // 已删项目留下的 schedules 会继续把「N 条新命中」送进收件箱；列表出口顺手清孤儿。
    // 注册表读失败则不动盘（空清单会误删全部任务）。
    let registered = match crate::projects::registered_path_keys() {
        Ok(v) => Some(v),
        Err(e) => {
            crate::logbuf::record(
                "warn",
                "scheduler",
                &format!("读注册项目失败，跳过定时任务孤儿清理: {e}"),
            );
            None
        }
    };
    let _g = sched_lock()?;
    let path = schedules_path()?;
    let mut list = read_schedules_at(&path)?;
    if let Some(registered) = registered.as_deref() {
        let n;
        (list, n) = prune_unregistered(list, registered);
        if n > 0 {
            write_schedules_at(&path, &list)?;
        }
    }
    drop(_g);
    let runs = crate::runs::run_list(None)?;
    Ok(list
        .into_iter()
        .map(|schedule| {
            let mut dto = ScheduleDto::from(schedule);
            dto.running_run_id = runs
                .iter()
                .find(|r| {
                    r.task_ref.as_deref() == Some(&dto.id)
                        && r.task_kind == "watch"
                        && crate::process::capture_active(&r.id)
                })
                .map(|r| r.id.clone());
            dto
        })
        .collect())
}

#[tauri::command]
pub fn create_schedule(input: CreateScheduleInput) -> Result<ScheduleDto, String> {
    create_schedule_at(&schedules_path()?, input).map(ScheduleDto::from)
}

#[tauri::command]
pub fn update_schedule(id: String, patch: UpdateSchedulePatch) -> Result<ScheduleDto, String> {
    update_schedule_at(&schedules_path()?, &id, patch).map(ScheduleDto::from)
}

#[tauri::command]
pub fn delete_schedule(id: String) -> Result<(), String> {
    // 还有没收尾的运行先拒删：跑着的巡检牵着头程互斥与产物冻结，强删会留半截状态
    if let Some(run_id) = crate::runs::schedule_open_run(&id) {
        return Err(format!("这条任务还有没结束的运行（{run_id}），先停止再删除"));
    }
    let removed = {
        let _g = sched_lock()?;
        let path = schedules_path()?;
        let mut list = read_schedules_at(&path)?;
        let Some(pos) = list.iter().position(|t| t.id == id) else {
            return Err(format!("定时任务不存在: {id}"));
        };
        let removed = list.remove(pos);
        write_schedules_at(&path, &list)?;
        removed
    };
    // 关键词跟着任务走：日程删了，这一份订阅目录也删
    if removed.skill == "lit-watch" {
        crate::lit_watch::delete_schedule_subscriptions(&removed.project_root, &removed.id);
    }
    purge_schedule_side_effects(&removed);
    Ok(())
}

/// 日程删除后的级联清理：Run 账行与事件、冻结证据、watch 任务行、隔离 worktree。
/// 2026-10-13 前只删日程与订阅，运行/快照/任务行/worktree 全留着，攒成「哪都到不了」的孤儿。
/// worktree 走回收站可反悔；各项独立尽力删，失败记日志不挡日程删除。
fn purge_schedule_side_effects(task: &Schedule) {
    let reviews = match crate::watch_review::review_dir() {
        Ok(dir) => dir,
        Err(e) => {
            crate::logbuf::record("warn", "scheduler", &format!("级联清理拿不到评审目录：{e}"));
            return;
        }
    };
    for run_id in crate::runs::watch_run_ids_of_schedule(&task.id) {
        if let Err(e) = crate::runs::delete_run_row(&run_id) {
            crate::logbuf::record("warn", "scheduler", &format!("删除运行账行失败 {run_id}: {e}"));
        }
        if let Err(e) = crate::watch_review::delete_snapshot_at(&reviews, &run_id) {
            crate::logbuf::record("warn", "scheduler", &format!("删除冻结证据失败 {run_id}: {e}"));
        }
    }
    if let Err(e) = crate::runs::delete_watch_task_row(&task.id) {
        crate::logbuf::record("warn", "scheduler", &format!("删除 watch 任务行失败 {}: {e}", task.id));
    }
    // 项目目录可能已不存在：按同一拼接规则定位 worktree，存在才进回收站
    let repo_name = Path::new(&task.project_root)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");
    if let Some(home) = dirs::home_dir() {
        let worktree = home
            .join("ccode/watch-worktrees")
            .join(repo_name)
            .join(&task.id);
        if worktree.is_dir() {
            if let Err(e) = crate::projects::trash_delete_retry(&worktree, "定时隔离目录") {
                crate::logbuf::record("warn", "scheduler", &e);
            }
        }
    }
}

/// 从存储里摘掉某条 run 的历史行（单条历史删除用）。找不到返回 Err。
fn remove_run_record_at(store: &Path, run_id: &str) -> Result<(), String> {
    let _g = sched_lock()?;
    let mut list = read_schedules_at(store)?;
    let mut found = false;
    for task in &mut list {
        let before = task.history.len();
        task.history
            .retain(|rec| rec.run_id.as_deref() != Some(run_id));
        if task.history.len() != before {
            found = true;
        }
    }
    if !found {
        return Err("这条运行记录不在任何定时任务的历史里".into());
    }
    write_schedules_at(store, &list)
}

/// 摘掉一条**没有 Run id** 的历史行（启动就失败的记录：worktree 建失败等，
/// run_id 为 None，按 runId 删永远匹配不到）。按 (日程 id, 记录时间) 定位。
fn remove_failed_record_at(
    store: &Path,
    schedule_id: &str,
    at: &str,
) -> Result<(), String> {
    let _g = sched_lock()?;
    let mut list = read_schedules_at(store)?;
    let task = list
        .iter_mut()
        .find(|t| t.id == schedule_id)
        .ok_or("定时任务不存在")?;
    let before = task.history.len();
    task.history
        .retain(|rec| !(rec.run_id.is_none() && rec.at == at));
    if task.history.len() == before {
        return Err("这条失败记录不在该定时任务的历史里".into());
    }
    write_schedules_at(store, &list)
}

/// 删除一条定时运行历史（人显式操作）：Run 账行与事件、历史行、冻结证据一起删。
/// 隔离 worktree 按日程共享、后续运行还要用，不随单条历史删；已采纳进项目的产物不受影响。
/// runId 为空时按 (scheduleId, at) 删启动即失败的记录（没有 Run 行与快照可清）。
#[tauri::command]
pub fn schedule_run_delete(
    run_id: Option<String>,
    schedule_id: Option<String>,
    at: Option<String>,
) -> Result<(), String> {
    let run_id = run_id.unwrap_or_default();
    if !run_id.is_empty() {
        if uuid::Uuid::parse_str(&run_id).is_err() {
            return Err("运行编号不合法".into());
        }
        crate::runs::delete_run_row(&run_id)?;
        remove_run_record_at(&schedules_path()?, &run_id)?;
        let _ = crate::watch_review::delete_snapshot_at(&crate::watch_review::review_dir()?, &run_id);
        return Ok(());
    }
    let (Some(schedule_id), Some(at)) = (schedule_id, at) else {
        return Err("缺少运行编号或（任务、时间）定位".into());
    };
    remove_failed_record_at(&schedules_path()?, &schedule_id, &at)
}

#[tauri::command]
pub fn cancel_schedule_run(id: String) -> Result<(), String> {
    for run_id in crate::process::active_capture_ids() {
        if let Some(run) = crate::runs::run_get(run_id.clone())? {
            if run.task_ref.as_deref() == Some(&id) && run.task_kind == "watch" {
                return crate::process::cancel_capture(&run_id);
            }
        }
    }
    Err("没有在此实例运行的任务".into())
}

fn schedule_has_keywords(task: &Schedule) -> bool {
    crate::lit_watch::read_schedule_subscriptions(Path::new(&task.project_root), &task.id)
        .map(|subs| !subs.is_empty())
        .unwrap_or(false)
}

/// 立即触发一次（不等结果）：走同一执行路径与防重入集合，结果经 scheduler-run-done 事件回前端
#[tauri::command]
pub fn run_schedule_now(app: tauri::AppHandle, id: String) -> Result<(), String> {
    {
        let _g = sched_lock()?;
        let list = read_schedules_at(&schedules_path()?)?;
        let task = list
            .iter()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("定时任务不存在: {id}"))?;
        if task.skill == "lit-watch" && !schedule_has_keywords(task) {
            return Err("先给这个巡检添加关键词，再立即运行".into());
        }
    }
    if !mark_running(&id) {
        return Err("该任务正在运行中".into());
    }
    let lease = match execution_lock(&id) {
        Ok(lease) => lease,
        Err(error) => {
            unmark_running(&id);
            return Err(error);
        }
    };
    tauri::async_runtime::spawn(async move {
        let id2 = id.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            let _lease = lease;
            execute_one(&id2)
        })
        .await;
        unmark_running(&id);
        match outcome {
            Ok(payload) => emit_done(&app, payload),
            Err(e) => {
                crate::logbuf::record("error", "scheduler", &format!("任务执行线程异常: {e}"))
            }
        }
    });
    Ok(())
}

// ===== 新建巡检技能草稿（确认落盘前只写 .ccode/drafts/，不进技能库） =====

const WATCH_SKILL_CATEGORY: &str = "巡检";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchSkillPending {
    id: String,
    name: String,
    skill_name: String,
    intent: String,
    frequency: String,
    weekday: Option<u8>,
    hour: u8,
    minute: u8,
    profile_id: Option<String>,
    linked_step: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSkillDraftDto {
    pub id: String,
    pub name: String,
    pub skill_name: String,
    pub intent: String,
    pub frequency: String,
    pub weekday: Option<u8>,
    pub hour: u8,
    pub minute: u8,
    pub profile_id: Option<String>,
    pub linked_step: Option<String>,
    pub draft_rel_path: String,
    pub has_draft: bool,
    pub draft_text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWatchSkillInput {
    pub project_root: String,
    pub name: String,
    pub intent: String,
    pub frequency: String,
    pub weekday: Option<u8>,
    pub hour: u8,
    pub minute: u8,
    pub profile_id: Option<String>,
    pub linked_step: Option<String>,
}

pub(crate) fn schedule_id_ok(id: &str) -> bool {
    watch_id_ok(id)
}

fn watch_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn watch_draft_rel(id: &str) -> String {
    format!(".ccode/drafts/watch-{id}.md")
}

fn watch_meta_rel(id: &str) -> String {
    format!(".ccode/drafts/watch-{id}.meta.json")
}

fn gated_project_root(project_root: &str) -> Result<PathBuf, String> {
    crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(
        project_root,
    )))
}

fn drafts_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains("..") || Path::new(rel).is_absolute() {
        return Err("非法草稿路径".into());
    }
    let p = root.join(rel);
    if let Ok(c) = crate::paths::canonicalize_plain(&p) {
        if !crate::paths::path_within_path(&c, root) {
            return Err("草稿指向项目目录之外".into());
        }
        return Ok(c);
    }
    Ok(p)
}

fn sanitize_watch_skill_name(raw: &str) -> String {
    let mut narrowed = String::new();
    let mut dash = false;
    for c in raw.trim().chars() {
        if c.is_alphanumeric() || c == '_' {
            narrowed.push(c);
            dash = false;
        } else if !dash {
            narrowed.push('-');
            dash = true;
        }
    }
    let narrowed = narrowed.trim_matches('-');
    crate::paths::sanitize_fs_name(narrowed).unwrap_or_else(|_| "watch-skill".into())
}

fn schedule_run_profile(pinned: Option<String>) -> Result<crate::profiles::Profile, String> {
    let profiles = crate::profiles::ProfileStore::new()?.list()?;
    let cur_settings = crate::settings::read_current_checked()?;
    let dedicated = cur_settings.ai_profile_id;
    let hidden: HashSet<String> = cur_settings
        .hidden_profiles
        .unwrap_or_default()
        .into_iter()
        .collect();
    crate::ai::resolve_profile_from(profiles.clone(), None, pinned.clone(), dedicated, &hidden)
        .or_else(|_| crate::ai::resolve_profile_from(profiles, None, pinned, None, &hidden))
}

fn pending_to_dto(root: &Path, p: WatchSkillPending) -> WatchSkillDraftDto {
    let rel = watch_draft_rel(&p.id);
    let text = drafts_path(root, &rel)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .filter(|t| !t.trim().is_empty());
    WatchSkillDraftDto {
        id: p.id,
        name: p.name,
        skill_name: p.skill_name,
        intent: p.intent,
        frequency: p.frequency,
        weekday: p.weekday,
        hour: p.hour,
        minute: p.minute,
        profile_id: p.profile_id,
        linked_step: p.linked_step,
        draft_rel_path: rel,
        has_draft: text.is_some(),
        draft_text: text,
    }
}

#[tauri::command]
pub fn start_watch_skill_draft(input: StartWatchSkillInput) -> Result<WatchSkillDraftDto, String> {
    let root = gated_project_root(&input.project_root)?;
    validate_fields(
        &root.to_string_lossy(),
        &input.frequency,
        input.weekday,
        input.hour,
        input.minute,
    )?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err("请填写任务名".into());
    }
    let intent = input.intent.trim();
    if intent.is_empty() {
        return Err("请写一句这份巡检要做什么".into());
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let pending = WatchSkillPending {
        id: id.clone(),
        name: name.to_string(),
        skill_name: sanitize_watch_skill_name(name),
        intent: intent.to_string(),
        frequency: input.frequency,
        weekday: input.weekday,
        hour: input.hour,
        minute: input.minute,
        profile_id: input.profile_id.filter(|v| !v.trim().is_empty()),
        linked_step: input
            .linked_step
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    };
    let meta_rel = watch_meta_rel(&id);
    let meta_path = drafts_path(&root, &meta_rel)?;
    if let Some(parent) = meta_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建草稿目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(&pending).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(&meta_path, &text)?;
    Ok(pending_to_dto(&root, pending))
}

#[tauri::command]
pub fn list_watch_skill_drafts(project_root: String) -> Result<Vec<WatchSkillDraftDto>, String> {
    let root = gated_project_root(&project_root)?;
    let dir = root.join(".ccode").join("drafts");
    let rd = match fs::read_dir(&dir) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("读取草稿目录失败: {e}")),
    };
    let mut out = Vec::new();
    for ent in rd.flatten() {
        let name = ent.file_name();
        let name = name.to_string_lossy();
        let Some(stem) = name
            .strip_prefix("watch-")
            .and_then(|s| s.strip_suffix(".meta.json"))
        else {
            continue;
        };
        if !watch_id_ok(stem) {
            continue;
        }
        let Ok(text) = fs::read_to_string(ent.path()) else {
            continue;
        };
        let Ok(pending) = serde_json::from_str::<WatchSkillPending>(&text) else {
            continue;
        };
        out.push(pending_to_dto(&root, pending));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub fn read_watch_skill_draft(
    project_root: String,
    id: String,
) -> Result<WatchSkillDraftDto, String> {
    let root = gated_project_root(&project_root)?;
    if !watch_id_ok(&id) {
        return Err("无效草稿 id".into());
    }
    let meta_path = drafts_path(&root, &watch_meta_rel(&id))?;
    let text = fs::read_to_string(&meta_path).map_err(|e| format!("没有这份草稿: {e}"))?;
    let pending: WatchSkillPending =
        serde_json::from_str(&text).map_err(|e| format!("草稿元数据损坏: {e}"))?;
    Ok(pending_to_dto(&root, pending))
}

#[tauri::command]
pub fn write_watch_skill_draft(
    project_root: String,
    id: String,
    text: String,
) -> Result<(), String> {
    let root = gated_project_root(&project_root)?;
    if !watch_id_ok(&id) {
        return Err("无效草稿 id".into());
    }
    let _ = drafts_path(&root, &watch_meta_rel(&id))?;
    if !root
        .join(".ccode")
        .join("drafts")
        .join(format!("watch-{id}.meta.json"))
        .is_file()
    {
        return Err("没有这份草稿".into());
    }
    let md_path = drafts_path(&root, &watch_draft_rel(&id))?;
    if let Some(parent) = md_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建草稿目录失败: {e}"))?;
    }
    crate::profiles::atomic_write(&md_path, &text)
}

#[tauri::command]
pub fn discard_watch_skill_draft(project_root: String, id: String) -> Result<(), String> {
    let root = gated_project_root(&project_root)?;
    if !watch_id_ok(&id) {
        return Err("无效草稿 id".into());
    }
    let meta = drafts_path(&root, &watch_meta_rel(&id))?;
    let md = drafts_path(&root, &watch_draft_rel(&id))?;
    let _ = fs::remove_file(md);
    fs::remove_file(&meta).map_err(|e| format!("删除草稿失败: {e}"))
}

#[tauri::command]
pub fn commit_watch_skill_draft(
    project_root: String,
    id: String,
    draft_text: Option<String>,
) -> Result<ScheduleDto, String> {
    let root = gated_project_root(&project_root)?;
    if !watch_id_ok(&id) {
        return Err("无效草稿 id".into());
    }
    let meta_path = drafts_path(&root, &watch_meta_rel(&id))?;
    let meta_text = fs::read_to_string(&meta_path).map_err(|e| format!("没有这份草稿: {e}"))?;
    let pending: WatchSkillPending =
        serde_json::from_str(&meta_text).map_err(|e| format!("草稿元数据损坏: {e}"))?;
    let md = match draft_text.filter(|t| !t.trim().is_empty()) {
        Some(t) => t,
        None => {
            let p = drafts_path(&root, &watch_draft_rel(&id))?;
            fs::read_to_string(&p)
                .map_err(|_| "还没有 SKILL.md 草稿，先跟 AI 写完再落盘".to_string())?
        }
    };
    if md.trim().is_empty() {
        return Err("SKILL.md 草稿是空的".into());
    }
    let skill = crate::skills::create_skill_from_full_md(
        &md,
        &pending.skill_name,
        Some(WATCH_SKILL_CATEGORY),
        None,
    )?;
    let profile = schedule_run_profile(pending.profile_id.clone())?;
    if let Err(e) = crate::skills::apply_skill_by_id(&skill.id, &profile.agent, true) {
        crate::logbuf::record(
            "warn",
            "scheduler",
            &format!("巡检技能已入库，分发到 {} 失败: {e}", profile.agent),
        );
        return Err(format!(
            "技能已保存，但没能分发到 {}：{e}。去技能页打开开关后再挂定时任务。",
            profile.agent
        ));
    }
    let created = create_schedule_at(
        &schedules_path()?,
        CreateScheduleInput {
            name: Some(pending.name.clone()),
            project_root: crate::sessions::expand_tilde(&project_root),
            skill: Some(skill.name.clone()),
            profile_id: pending.profile_id.clone(),
            // 直建链路不透传 model（设计拍板）：落 None=名单第一，要绑去编辑弹层
            model: None,
            linked_step: pending.linked_step.clone(),
            frequency: pending.frequency.clone(),
            weekday: pending.weekday,
            hour: pending.hour,
            minute: pending.minute,
        },
    )?;
    if let Ok(p) = drafts_path(&root, &watch_draft_rel(&id)) {
        let _ = fs::remove_file(p);
    }
    let _ = fs::remove_file(meta_path);
    Ok(ScheduleDto::from(created))
}

/// 给已有巡检技能补分发（创建任务或改连接时）。lit-watch 不处理。
#[tauri::command]
pub fn ensure_schedule_skill_distributed(
    skill: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    let skill = skill.trim();
    if skill.is_empty() || skill == "lit-watch" {
        return Ok(String::new());
    }
    let profile = schedule_run_profile(profile_id.filter(|v| !v.trim().is_empty()))?;
    let id = crate::skills::skill_id_by_name(skill)?;
    crate::skills::apply_skill_by_id(&id, &profile.agent, true)?;
    Ok(profile.agent)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ===== B3 模型字段 =====

    /// 老 schedules.json 没有 model 键：serde default 兼容（None），新旧互读不炸
    #[test]
    fn schedule_model_defaults_for_old_json() {
        let old = r#"{"id":"s1","name":"雷达","project_root":"/p","skill":"lit-watch",
            "profile_id":"pf-1","frequency":"daily","hour":8,"minute":0,"enabled":true,
            "last_run_at":null,"last_status":null,"history":[]}"#;
        let list: Vec<Schedule> = serde_json::from_str(&format!("[{old}]")).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].profile_id.as_deref(), Some("pf-1"));
        assert_eq!(list[0].model, None);
        // 新档带 model 往返
        let with_model = serde_json::to_string(&Schedule {
            model: Some("glm-4.7".into()),
            ..list.into_iter().next().unwrap()
        })
        .unwrap();
        assert!(with_model.contains(r#""model":"glm-4.7""#));
        let back: Vec<Schedule> = serde_json::from_str(&format!("[{with_model}]")).unwrap();
        assert_eq!(back[0].model.as_deref(), Some("glm-4.7"));
    }

    fn dt(date: NaiveDate, h: u8, m: u8) -> NaiveDateTime {
        date.and_hms_opt(h as u32, m as u32, 0).unwrap()
    }

    fn ymd(y: i32, mo: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, mo, d).unwrap()
    }

    fn tmp_schedules_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "ccode-scheduler-test-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ))
    }

    fn sample_task(id: &str, root: &str) -> Schedule {
        Schedule {
            id: id.into(),
            model: None,
            name: "文献雷达".into(),
            project_root: root.into(),
            skill: "lit-watch".into(),
            profile_id: None,
            linked_step: None,
            frequency: "daily".into(),
            weekday: None,
            hour: 8,
            minute: 0,
            enabled: true,
            last_run_at: None,
            last_status: None,
            history: vec![],
        }
    }

    #[test]
    fn delete_schedules_for_project_matches_across_slash_dialect() {
        let path = tmp_schedules_path("delete-for-project");
        write_schedules_at(
            &path,
            &[
                sample_task("keep", "/Users/me/other"),
                sample_task("gone", "/Users/me/综述文献"),
            ],
        )
        .unwrap();
        let n = delete_schedules_for_project_at(&path, Path::new("/Users/me/综述文献/")).unwrap();
        assert_eq!(n, 1);
        let left = read_schedules_at(&path).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, "keep");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn prune_unregistered_drops_orphan_roots() {
        let list = vec![
            sample_task("alive", "/repo/a"),
            sample_task("ghost", "/repo/deleted"),
        ];
        let (kept, n) = prune_unregistered(list, &["/repo/a".into()]);
        assert_eq!(n, 1);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, "alive");
    }

    #[test]
    fn due_daily_not_yet_today_is_not_due() {
        // 今天 09:00，任务定在 10:00：最近应跑时刻是昨天 10:00，昨天已跑 → 不 due
        let now = dt(ymd(2026, 8, 13), 9, 0);
        let last = dt(ymd(2026, 8, 12), 10, 30);
        assert!(!is_due("daily", None, 10, 0, Some(last), now));
        // 昨天没跑 → due
        let last = dt(ymd(2026, 8, 11), 10, 30);
        assert!(is_due("daily", None, 10, 0, Some(last), now));
    }

    #[test]
    fn due_daily_past_time_not_run_is_due() {
        // 今天 09:00，任务定在 08:00：应跑时刻是今天 08:00，上次跑是昨天 → due
        let now = dt(ymd(2026, 8, 13), 9, 0);
        let last = dt(ymd(2026, 8, 12), 8, 30);
        assert!(is_due("daily", None, 8, 0, Some(last), now));
        // 今天已跑 → 不 due
        let last = dt(ymd(2026, 8, 13), 8, 30);
        assert!(!is_due("daily", None, 8, 0, Some(last), now));
    }

    #[test]
    fn due_weekly_across_weeks() {
        // now 取周四 09:00（动态算 weekday，测试不依赖具体日期）
        let now_date = ymd(2026, 8, 13);
        let today_idx = now_date.weekday().num_days_from_monday() as u8; // 0-6
        let now = dt(now_date, 9, 0);
        // 定在今天 08:00：应跑时刻是今天 08:00
        let wd = today_idx + 1;
        assert!(is_due(
            "weekly",
            Some(wd),
            8,
            0,
            Some(dt(now_date - ChronoDuration::days(6), 8, 0)),
            now
        ));
        assert!(!is_due(
            "weekly",
            Some(wd),
            8,
            0,
            Some(dt(now_date, 8, 30)),
            now
        ));
        // 定在今天 10:00（还没到）：应跑时刻是上周今天 10:00
        assert!(is_due(
            "weekly",
            Some(wd),
            10,
            0,
            Some(dt(now_date - ChronoDuration::days(8), 10, 0)),
            now
        ));
        assert!(!is_due(
            "weekly",
            Some(wd),
            10,
            0,
            Some(dt(now_date - ChronoDuration::days(6), 10, 0)),
            now
        ));
        // 定在昨天 08:00：应跑时刻是昨天 08:00，6 天前跑过 → due；昨天跑过 → 不 due
        let yesterday_idx = (today_idx + 6) % 7;
        let wd = yesterday_idx + 1;
        assert!(is_due(
            "weekly",
            Some(wd),
            8,
            0,
            Some(dt(now_date - ChronoDuration::days(6), 8, 0)),
            now
        ));
        assert!(!is_due(
            "weekly",
            Some(wd),
            8,
            0,
            Some(dt(now_date - ChronoDuration::days(1), 8, 30)),
            now
        ));
    }

    #[test]
    fn due_last_run_none_is_always_due() {
        let now = dt(ymd(2026, 8, 13), 9, 0);
        assert!(is_due("daily", None, 8, 0, None, now));
        assert!(is_due("weekly", Some(1), 8, 0, None, now));
    }

    #[test]
    fn due_missed_days_coalesce_to_single_run() {
        // 漏跑 5 天 → due；跑一次后 last_run 落到现在 → 不再 due（不会连补多次）
        let now = dt(ymd(2026, 8, 13), 9, 0);
        let last = dt(ymd(2026, 8, 8), 8, 0);
        assert!(is_due("daily", None, 8, 0, Some(last), now));
        assert!(!is_due("daily", None, 8, 0, Some(now), now));
    }

    #[test]
    fn schedules_json_roundtrip_via_atomic_write() {
        let path = tmp_schedules_path("roundtrip");
        let task = Schedule {
            id: "t1".into(),
            model: None,
            name: "文献雷达".into(),
            project_root: "/tmp/p".into(),
            skill: "lit-watch".into(),
            profile_id: None,
            linked_step: Some("文献监控".into()),
            frequency: "daily".into(),
            weekday: None,
            hour: 8,
            minute: 30,
            enabled: true,
            last_run_at: Some("2026-08-13T01:00:00Z".into()),
            last_status: Some("ok".into()),
            history: vec![RunRecord {
                at: "2026-08-13T01:00:00Z".into(),
                status: "ok".into(),
                summary: "新命中 2 篇".into(),
                new_entries: Some(2),
                started_at: None,
                finished_at: None,
                artifacts: Vec::new(),
                run_id: None,
                isolation_path: None,
                adopted: false,
            }],
        };
        write_schedules_at(&path, &[task.clone()]).unwrap();
        // 原子写不留 tmp 残影
        assert!(!path.with_extension("tmp").exists());
        let back = read_schedules_at(&path).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].id, "t1");
        assert_eq!(back[0].linked_step.as_deref(), Some("文献监控"));
        assert_eq!(back[0].history.len(), 1);
        assert_eq!(back[0].history[0].summary, "新命中 2 篇");
        assert_eq!(back[0].history[0].new_entries, Some(2));
        // 缺文件 → 空列表
        let missing = tmp_schedules_path("missing");
        assert!(read_schedules_at(&missing).unwrap().is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn legacy_json_without_linked_step_and_new_entries_deserializes() {
        // 老版本 schedules.json：无 linked_step、history 无 newEntries —— 两个字段都要 default 兼容
        let text = r#"[{
            "id": "t1", "name": "文献雷达", "project_root": "/tmp/p", "skill": "lit-watch",
            "profile_id": null, "frequency": "daily", "weekday": null, "hour": 8, "minute": 30,
            "enabled": true, "last_run_at": null, "last_status": null,
            "history": [{"at": "2026-08-13T01:00:00Z", "status": "ok", "summary": "新命中 2 篇"}]
        }]"#;
        let list: Vec<Schedule> = serde_json::from_str(text).unwrap();
        assert_eq!(list[0].linked_step, None);
        assert_eq!(list[0].history[0].new_entries, None);
        // 老前端发来的 create/update 报文（无 linkedStep）也要能解析
        let create: CreateScheduleInput = serde_json::from_str(
            r#"{"projectRoot": "/tmp/p", "frequency": "daily", "hour": 8, "minute": 0}"#,
        )
        .unwrap();
        assert_eq!(create.linked_step, None);
        let patch: UpdateSchedulePatch = serde_json::from_str(r#"{"hour": 9}"#).unwrap();
        assert_eq!(patch.linked_step, None);
        // 显式 null 与缺失等价：serde 对 Option<Option<T>> 不区分二者（既有 profile_id 同款口径），
        // 清除关联由 update 时空白字符串归一为 None 承担
        let patch: UpdateSchedulePatch = serde_json::from_str(r#"{"linkedStep": null}"#).unwrap();
        assert_eq!(patch.linked_step, None);
        let patch: UpdateSchedulePatch =
            serde_json::from_str(r#"{"linkedStep": " 检索筛选 "}"#).unwrap();
        assert_eq!(patch.linked_step, Some(Some(" 检索筛选 ".into())));
    }

    #[test]
    fn run_record_camelcase_over_the_wire_and_snake_alias_on_disk() {
        // 2026-10-03 修：RunRecord 嵌在 camelCase 的 ScheduleDto 里直出前端，此前以蛇形
        // isolation_path/run_id/started_at 出线，前端 isolationPath 恒 undefined——
        // 雷达「隔离树有 N 条新命中 · 去评审」从未出现过。老盘（蛇形）必须还能读。
        let old_disk = r#"[{
            "id": "t1", "name": "文献雷达", "project_root": "/tmp/p", "skill": "lit-watch",
            "profile_id": null, "frequency": "daily", "weekday": null, "hour": 9, "minute": 0,
            "enabled": true, "last_run_at": "2026-10-03T05:36:19Z", "last_status": "ok",
            "history": [{
                "at": "2026-10-03T05:36:19Z", "status": "ok", "summary": "巡检完成",
                "newEntries": 6, "started_at": "2026-10-03T05:24:37Z",
                "finished_at": "2026-10-03T05:36:19Z", "artifacts": [],
                "run_id": "53da57e5-0000-0000-0000-000000000000",
                "isolation_path": "/Users/x/watch-worktrees/p/t1", "adopted": false
            }]
        }]"#;
        let list: Vec<Schedule> = serde_json::from_str(old_disk).unwrap();
        let rec = &list[0].history[0];
        assert_eq!(rec.new_entries, Some(6));
        assert_eq!(
            rec.isolation_path.as_deref(),
            Some("/Users/x/watch-worktrees/p/t1")
        );
        assert_eq!(
            rec.run_id.as_deref(),
            Some("53da57e5-0000-0000-0000-000000000000")
        );
        assert_eq!(rec.started_at.as_deref(), Some("2026-10-03T05:24:37Z"));
        assert!(!rec.adopted);
        // 出线契约：前端 types.ts RunRecordDto 读驼峰键
        let dto = serde_json::to_value(ScheduleDto::from(list.into_iter().next().unwrap())).unwrap();
        let hist = &dto["history"][0];
        assert_eq!(hist["isolationPath"], "/Users/x/watch-worktrees/p/t1");
        assert_eq!(hist["runId"], "53da57e5-0000-0000-0000-000000000000");
        assert_eq!(hist["startedAt"], "2026-10-03T05:24:37Z");
        assert_eq!(hist["newEntries"], 6);
        assert!(hist.get("isolation_path").is_none(), "蛇形键不得再出线");
    }

    #[test]
    fn create_validation_rejects_bad_fields() {
        let dir =
            std::env::temp_dir().join(format!("ccode-scheduler-test-dir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().into_owned();
        let input = |frequency: &str, weekday: Option<u8>, hour: u8, minute: u8, root: &str| {
            CreateScheduleInput {
                name: None,
                model: None,
                project_root: root.to_string(),
                skill: None,
                profile_id: None,
                linked_step: None,
                frequency: frequency.into(),
                weekday,
                hour,
                minute,
            }
        };
        // 不存在的目录
        assert!(validate_fields("/definitely/not/exist-cccode", "daily", None, 8, 0).is_err());
        // 坏 hour / minute / frequency / weekday
        assert!(validate_fields(&root, "daily", None, 24, 0).is_err());
        assert!(validate_fields(&root, "daily", None, 8, 60).is_err());
        assert!(validate_fields(&root, "monthly", None, 8, 0).is_err());
        assert!(validate_fields(&root, "weekly", None, 8, 0).is_err());
        assert!(validate_fields(&root, "weekly", Some(8), 8, 0).is_err());
        assert!(validate_fields(&root, "weekly", Some(3), 8, 0).is_ok());
        assert!(validate_fields(&root, "daily", None, 8, 0).is_ok());
        // create 走同一校验（落到独立临时文件，不碰真实配置目录）
        let path = tmp_schedules_path("create");
        assert!(create_schedule_at(&path, input("daily", None, 25, 0, &root)).is_err());
        assert!(create_schedule_at(
            &path,
            input("daily", None, 8, 0, "/definitely/not/exist-cccode")
        )
        .is_err());
        let t = create_schedule_at(&path, input("weekly", Some(2), 8, 30, &root)).unwrap();
        // 默认值：名称/技能/enabled/空历史/uuid
        assert_eq!(t.name, "文献雷达");
        assert_eq!(t.skill, "lit-watch");
        assert!(t.enabled);
        assert!(t.history.is_empty());
        assert!(!t.id.is_empty());
        assert_eq!(read_schedules_at(&path).unwrap().len(), 1);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prompt_template_uses_skill_and_mentions_trigger() {
        let p = build_task_prompt("lit-watch");
        assert!(p.contains("lit-watch"));
        assert!(p.contains("papers/watchlist.md"));
        assert!(p.contains("notes/inbox.md"));
        assert!(p.contains("定时雷达自动触发"));
        let p = build_task_prompt("other-skill");
        assert!(p.contains("other-skill"));
        assert!(!p.contains("{skill}"));
    }

    #[test]
    fn prompt_template_dispatches_by_skill() {
        // lit-watch 专用文案一字不动（回归钉死）
        assert_eq!(
            build_task_prompt("lit-watch"),
            "请使用 lit-watch 技能执行一次文献巡检：按 papers/watchlist.md 的订阅清单检索新文献，去重、精选后把命中追加到 notes/inbox.md。追加本次条目前必须先单独写一行 <!-- watch-run: YYYY-MM-DD -->（本次巡检的本地日期，上海时区），已有批次标记的旧条目不要改。能免费直接下载的 PDF（arXiv /pdf/ 直链或以 .pdf 结尾）在结束前用 curl 下到项目根 papers/，文件名用标题，并确认以 %PDF- 开头；出版商页、DOI 落地页和付费墙不要下，题录留在 papers/watch-followup.md。不要写 papers/included.md、notes/index.json 或 references.bib——雷达文献是项目的日常积累，精读与引文库由人发起检索/科研流程后才动。结束时输出三行以内的简报（检索了几条关键词/来源、新命中几篇、其中推荐几篇、哪些来源未达、免费全文下了几篇）。本任务由 Mesa 定时雷达自动触发。"
        );
        // 其他技能走通用模板：替换技能名、不带文献巡检的路径口径
        let p = build_task_prompt("data-clean");
        assert!(p.contains("data-clean"));
        assert!(p.contains("定时巡检"));
        assert!(p.contains("定时雷达自动触发"));
        assert!(!p.contains("watchlist.md"));
        assert!(!p.contains("{skill}"));
    }

    #[test]
    fn watch_skill_name_and_draft_paths() {
        assert_eq!(sanitize_watch_skill_name("查模型更新"), "查模型更新");
        assert_eq!(
            sanitize_watch_skill_name("OpenAI / Anthropic"),
            "OpenAI-Anthropic"
        );
        assert!(watch_id_ok("aabbccddeeff00112233445566778899"));
        assert!(!watch_id_ok("../evil"));
        assert_eq!(watch_draft_rel("abc"), ".ccode/drafts/watch-abc.md");
        let json = serde_json::to_string(&WatchSkillPending {
            id: "abc".into(),
            name: "查模型".into(),
            skill_name: "查模型".into(),
            intent: "每天查".into(),
            frequency: "daily".into(),
            weekday: None,
            hour: 9,
            minute: 0,
            profile_id: None,
            linked_step: None,
        })
        .unwrap();
        assert!(json.contains("skillName"));
        let back: WatchSkillPending = serde_json::from_str(&json).unwrap();
        assert_eq!(back.intent, "每天查");
    }

    #[test]
    fn copy_watch_rel_seeds_and_skips_existing() {
        let root = std::env::temp_dir().join(format!("ccode-watch-copy-{}", uuid::Uuid::new_v4()));
        let from = root.join("from");
        let to = root.join("to");
        std::fs::create_dir_all(from.join("papers")).unwrap();
        std::fs::create_dir_all(to.join("papers")).unwrap();
        std::fs::write(from.join("papers/watchlist.md"), "kw — arxiv\n").unwrap();
        std::fs::write(from.join("papers/watch-seen.md"), "seen\n").unwrap();
        std::fs::write(to.join("papers/watch-seen.md"), "old\n").unwrap();
        assert!(copy_watch_rel(&from, &to, "papers/watchlist.md", true).unwrap());
        assert_eq!(
            std::fs::read_to_string(to.join("papers/watchlist.md")).unwrap(),
            "kw — arxiv\n"
        );
        assert!(!copy_watch_rel(&from, &to, "papers/watch-seen.md", false).unwrap());
        assert_eq!(
            std::fs::read_to_string(to.join("papers/watch-seen.md")).unwrap(),
            "old\n"
        );
        assert!(copy_watch_rel(&from, &to, "papers/watch-seen.md", true).unwrap());
        assert_eq!(
            std::fs::read_to_string(to.join("papers/watch-seen.md")).unwrap(),
            "seen\n"
        );
        assert!(!copy_watch_rel(&from, &to, "notes/inbox.md", true).unwrap());
        assert!(copy_watch_rel(&from, &to, "../escape.md", true).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn seed_then_adopt_roundtrip() {
        let root = std::env::temp_dir().join(format!("ccode-watch-seed-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        let isolation = root.join("iso");
        std::fs::create_dir_all(project.join("papers")).unwrap();
        std::fs::create_dir_all(project.join("notes")).unwrap();
        std::fs::create_dir_all(&isolation).unwrap();
        std::fs::write(project.join("papers/watchlist.md"), "kw\n").unwrap();
        std::fs::write(project.join("notes/inbox.md"), "## old\n").unwrap();
        seed_watch_isolation(&project, &isolation).unwrap();
        // 订阅不再从主仓播种：隔离树的 watchlist 由 seed_schedule_watchlist 按任务写入
        assert!(!isolation.join("papers/watchlist.md").is_file());
        assert!(isolation.join("notes/inbox.md").is_file());
        let id = uuid::Uuid::new_v4().to_string();
        let evidence = crate::watch_review::prepare(
            &id,
            &project,
            &isolation,
            &watch_adopt_patterns_for("lit-watch"),
        )
        .unwrap();
        std::fs::write(isolation.join("notes/inbox.md"), "## old\n## new\n").unwrap();
        let reviews = root.join("reviews");
        crate::watch_review::freeze_at(
            &reviews,
            evidence,
            &isolation,
            &watch_adopt_patterns_for("lit-watch"),
        )
        .unwrap();
        let snapshot = crate::watch_review::load_at(&reviews, &id).unwrap();
        let copied = crate::watch_review::adopt_at(
            &reviews,
            &snapshot,
            &project,
            &[],
            &watch_adopt_patterns_for("lit-watch"),
        )
        .unwrap();
        assert!(copied.iter().any(|p| p == "notes/inbox.md"));
        assert_eq!(
            std::fs::read_to_string(project.join("notes/inbox.md")).unwrap(),
            "## old\n## new\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scheduler_rechecks_due_before_marking_itself_running() {
        let id = uuid::Uuid::new_v4().to_string();
        assert!(!claim_due_after_lock(&id, &[]));
        assert!(claim_due_after_lock(&id, &[id.clone()]));
        assert!(!claim_due_after_lock(&id, &[id.clone()]));
        unmark_running(&id);
    }

    #[test]
    fn common_dir_is_resolved_against_command_repository() {
        let base = tmp_schedules_path("common-dir");
        let repo = base.join("repo");
        let other = base.join("other");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(other.join(".git")).unwrap();
        assert_eq!(
            resolve_git_common_dir(&repo, ".git"),
            crate::projects::canonical_key(&repo.join(".git"))
        );
        assert_ne!(
            resolve_git_common_dir(&repo, ".git"),
            resolve_git_common_dir(&other, ".git")
        );
        assert_eq!(
            resolve_git_common_dir(&other, &repo.join(".git").to_string_lossy()),
            resolve_git_common_dir(&repo, ".git")
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn schedule_execution_lock_excludes_second_instance_and_releases() {
        let dir = tmp_schedules_path("execution-lock");
        let first = execution_lock_at(&dir, "same schedule").unwrap();
        assert!(execution_lock_at(&dir, "same schedule").is_err());
        assert!(execution_lock_at(&dir, "different schedule").is_ok());
        drop(first);
        assert!(execution_lock_at(&dir, "same schedule").is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn timeout_error_is_classified() {
        assert!(is_timeout_error("AI 调用超时（600s）。无输出"));
        assert!(!is_timeout_error("技能未分发"));
    }

    #[test]
    fn remove_run_record_only_drops_matching_history_row() {
        let dir = tmp_schedules_path("run-record-del");
        fs::create_dir_all(&dir).unwrap();
        let store = dir.join("schedules.json");
        let mut task = sample_task("sched-del", "/tmp/x");
        task.history = vec![
            RunRecord {
                at: "2026-10-13T09:00:00+08:00".into(),
                status: "ok".into(),
                summary: String::new(),
                new_entries: None,
                started_at: None,
                finished_at: None,
                artifacts: Vec::new(),
                run_id: Some("run-keep".into()),
                isolation_path: None,
                adopted: true,
            },
            RunRecord {
                at: "2026-10-13T10:00:00+08:00".into(),
                status: "ok".into(),
                summary: String::new(),
                new_entries: None,
                started_at: None,
                finished_at: None,
                artifacts: Vec::new(),
                run_id: Some("run-drop".into()),
                isolation_path: None,
                adopted: false,
            },
        ];
        write_schedules_at(&store, &[task]).unwrap();
        remove_run_record_at(&store, "run-drop").unwrap();
        let list = read_schedules_at(&store).unwrap();
        assert_eq!(list[0].history.len(), 1);
        assert_eq!(list[0].history[0].run_id.as_deref(), Some("run-keep"));
        assert!(list[0].history[0].adopted, "别的行原样保留");
        // 重复删同一条：历史里已经没有，明确报错而不是装成功
        assert!(remove_run_record_at(&store, "run-drop").is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remove_failed_record_without_run_id() {
        let dir = tmp_schedules_path("failed-del");
        fs::create_dir_all(&dir).unwrap();
        let store = dir.join("schedules.json");
        let mut task = sample_task("sched-f", "/tmp/x");
        task.history = vec![
            RunRecord {
                at: "2026-10-14T09:00:00+08:00".into(),
                status: "error".into(),
                summary: "创建定时隔离 worktree 失败".into(),
                new_entries: None,
                started_at: None,
                finished_at: None,
                artifacts: Vec::new(),
                run_id: None,
                isolation_path: None,
                adopted: false,
            },
        ];
        write_schedules_at(&store, &[task]).unwrap();
        remove_failed_record_at(&store, "sched-f", "2026-10-14T09:00:00+08:00").unwrap();
        assert!(read_schedules_at(&store).unwrap()[0].history.is_empty(), "失败行应被删掉");
        // 时间对不上：明确报错，不误删别的行
        let mut task = sample_task("sched-f2", "/tmp/x");
        task.history = vec![RunRecord {
            at: "2026-10-14T09:00:00+08:00".into(),
            status: "error".into(),
            summary: String::new(),
            new_entries: None,
            started_at: None,
            finished_at: None,
            artifacts: Vec::new(),
            run_id: None,
            isolation_path: None,
            adopted: false,
        }];
        write_schedules_at(&store, &[task]).unwrap();
        assert!(remove_failed_record_at(&store, "sched-f2", "别的时间").is_err());
        assert_eq!(read_schedules_at(&store).unwrap()[0].history.len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn find_run_record_only_matches_ok_history_and_reports_adopted() {
        let mut task = sample_task("sched-adopt", "/tmp/does-not-matter");
        task.history = vec![
            RunRecord {
                at: "2026-10-13T09:00:00+08:00".into(),
                status: "error".into(),
                summary: String::new(),
                new_entries: None,
                started_at: None,
                finished_at: None,
                artifacts: Vec::new(),
                run_id: Some("run-a".into()),
                isolation_path: None,
                adopted: false,
            },
            RunRecord {
                at: "2026-10-13T10:00:00+08:00".into(),
                status: "ok".into(),
                summary: String::new(),
                new_entries: None,
                started_at: None,
                finished_at: None,
                artifacts: Vec::new(),
                run_id: Some("run-b".into()),
                isolation_path: None,
                adopted: true,
            },
        ];
        // 失败记录不构成可采纳历史
        assert!(find_run_record(&[task.clone()], "run-a").is_none());
        // 成功且已采纳：采纳入口要据此拒绝，决定闸门要据此锁定
        let (_, adopted) = find_run_record(&[task.clone()], "run-b").unwrap();
        assert!(adopted);
        task.history[1].adopted = false;
        let (_, adopted) = find_run_record(&[task], "run-b").unwrap();
        assert!(!adopted);
        // 没有任何匹配：明确查不到，不默认放行
        assert!(find_run_record(&[], "run-none").is_none());
    }

    #[test]
    fn headless_write_gate_blocks_unverified_agent() {
        // qwen 无头写盘未验证（能力表 supported=false）：执行链必须 fail-loud 并给出用户可见原因
        let reason = headless_write_block_reason("qwen").expect("qwen 应被能力闸拦截");
        assert!(reason.contains("qwen"));
        assert!(reason.contains("未验证"));
        // codex 已验证：放行
        assert!(headless_write_block_reason("codex").is_none());
        // grok 支持但带「会批准全部操作」：只警示不拦截（与能力表口径一致）
        assert!(headless_write_block_reason("grok").is_none());
        // 表外 agent 与能力表 `_` 兜底同口径：放行
        assert!(headless_write_block_reason("no-such-agent").is_none());
    }
}
