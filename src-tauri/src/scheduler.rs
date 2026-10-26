//! 定时雷达：按「每日/每周 + 时分」周期，无头拉起 agent CLI 在隔离 worktree 跑一次技能
//! （默认文献监控 lit-watch，可选技能库里的其他技能），跑完记录历史并发 `scheduler-run-done` 事件给前端。
//! 隔离树先从主仓播种订阅/台账，产物经只读评审后由用户「采纳进主仓」，不自动合并。
//!
//! 存储：应用配置目录 ccode/schedules.json（snake_case）；给前端的 DTO 用 camelCase。
//! due 判定按本地时间算「最近一次应跑时刻」，last_run_at / last_slot_at 都早于它即 due——应用关闭错过
//! 的时间点在启动后第一个 tick 自动补跑一次（多次漏跑只补一次，coalesce），更早错过的几次记一条「已跳过」。
//!
//! 2026-10-23「定时任务全部完善」：周期加工作日 / 每 N 小时 / 仅手动；跳过也记账（应用没开、电脑睡着、
//! 上一轮还没评审、没有关键词）；补跑告诉 Agent 原定时刻；历史行记会话 id 可看过程；无新内容不打扰；
//! 积压闸门；连续失败或连接被删自动暂停；跑的时候不让电脑睡；通用巡检的跨轮记忆；立即跑可带附言；
//! 单次上限可调；AI 草稿顺带建议周期。

use chrono::{Datelike, Duration as ChronoDuration, Local, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::Emitter;

/// 定时任务单次预算默认值。v3.75 定 600s；2026-10-03 提高到 30 分钟——实测 GLM 跑 lit-watch
/// （三路检索 + 去重 + 写文件）超 10 分钟，600s 在掐死健康任务。2026-10-23 起每任务可调
/// （timeout_minutes，5–180 分钟），不填仍是 30 分钟。
const DEFAULT_TIMEOUT_MINUTES: u32 = 30;
const TIMEOUT_MINUTES_RANGE: std::ops::RangeInclusive<u32> = 5..=180;
/// 「每 N 小时」只收 24 的因数：每天的时刻表一样，界面能说清「每 N 小时，在 :MM」
const INTERVAL_HOURS_ALLOWED: &[u8] = &[1, 2, 3, 4, 6, 8, 12];
/// 连续这么多次没跑成（失败 / 超时）就自动暂停，原因写在任务上
const AUTO_PAUSE_AFTER_FAILURES: u32 = 3;
/// 错过的次数只往回数这么多天（与 Claude 桌面版同口径：一周以前的不再提）
const MISSED_LOOKBACK_DAYS: i64 = 7;
/// 两次 tick 相隔超过这么久 = 电脑睡过（tick 间隔 60s）
const SLEEP_GAP_MINUTES: i64 = 3;
/// 立即跑附言的长度上限（字符）
const NOTE_CAP: usize = 500;
/// 调度 tick 间隔
const TICK_INTERVAL: Duration = Duration::from_secs(60);
/// tick 同时拉起的运行上限（2026-10-16 跨项目并行拍板）：不同项目的雷达并行跑、
/// 同一项目仍互斥（见 project_lock）。上限防启动补跑把所有 daily 任务在同一瞬间
/// 拉起一堆 CLI（token 尖峰 + 外部检索源限流）。只管 tick 拉起的运行；
/// 手动「立即运行」是显式用户意图，不占额度（同项目互斥仍然生效）。
const MAX_CONCURRENT_TICK_RUNS: usize = 2;
/// 历史只留最近 20 条（新的在前）
const HISTORY_CAP: usize = 20;
/// 简报脱敏后截 2000 字符
const SUMMARY_CAP: usize = 2000;

/// 任务 prompt 模板按技能分派：lit-watch 用文献巡检专用文案（一字不动），
/// 其他技能用通用模板（技能自有规范为准，调度器不复制关键词/路径口径）
const TASK_PROMPT_LIT_WATCH: &str = "请使用 {skill} 技能执行一次文献巡检：按 papers/watchlist.md 的订阅清单检索新文献，并按规范跑关联推荐通道，去重、精选后把命中追加到 notes/inbox.md。追加本次条目前必须先单独写一行 <!-- watch-run: YYYY-MM-DD -->（本次巡检的本地日期，上海时区），已有批次标记的旧条目不要改。免费全文按规范以 OpenAlex 的 best_oa_location.pdf_url、arXiv /pdf/ 直链或 .pdf 结尾直链为准，在结束前用 curl 下到项目根 papers/，文件名用标题，并确认以 %PDF- 开头；下载带硬时间盒：每篇 curl 加 --max-time 60，全部下载合计不超过 5 分钟，到点放弃、残文件删掉、题录留在 papers/watch-followup.md，同一链接不重试；出版商页、DOI 落地页和付费墙不要下。不要写 papers/included.md、notes/index.json 或 references.bib——雷达文献是项目的日常积累，精读与引文库由人发起检索/科研流程后才动。结束时输出三行以内的简报（检索了几条关键词/来源、关联推荐是否跑/命中几篇、新命中几篇、其中推荐几篇、哪些来源未达、免费全文下了几篇）。本任务由 Mesa 定时雷达自动触发。";
const TASK_PROMPT_GENERIC: &str = "请使用 {skill} 技能在项目内执行一次定时巡检，按该技能的既定规范产出结果；这一轮没有新内容时不要改任何文件（Mesa 据此判断「无新内容」，不打扰用户）。结束时输出三行以内简报。本任务由 Mesa 定时雷达自动触发。";

// ===== 数据模型 =====

/// 单次运行记录（存储/前端共用）。整体 camelCase 序列化（随 ScheduleDto 直出前端）；
/// 多词字段带蛇形 alias 兼容读旧 schedules.json（历史上 started_at/run_id/isolation_path
/// 以蛇形落盘，2026-10-03 修「isolationPath 从未到达前端」时统一驼峰并保留 alias）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub at: String,
    /// "ok" | "error" | "timeout" | "cancelled" | "skipped"（跳过也记账，2026-10-23）
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
    /// 这次运行的后台对话（agent + 会话 id）：历史行「看过程」据此打开只读回放；
    /// 被历史引用的对话不进内部对话保留期清理（internal_sessions.rs）。
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default, alias = "session_id")]
    pub session_id: Option<String>,
    /// 跑完了但没有新内容（雷达 0 条新命中 / 其他巡检没有可采纳的改动）：不弹通知、不进待处理
    #[serde(default)]
    pub noop: bool,
    /// 这次对应的应跑时刻（本地时间 ISO，无时区）；手动跑为 None
    #[serde(default, alias = "scheduled_for")]
    pub scheduled_for: Option<String>,
    /// "schedule" 准点 | "catchup" 补跑 | "manual" 立即跑；旧记录 None
    #[serde(default)]
    pub trigger: Option<String>,
    /// 立即跑时用户附的一句话
    #[serde(default)]
    pub note: Option<String>,
    /// 跳过原因代码（status=skipped）：missed_closed / missed_asleep / unreviewed / no_keywords
    #[serde(default, alias = "skip_reason")]
    pub skip_reason: Option<String>,
    /// 同一原因连着跳过的次数（合并成一行，防历史被刷屏）
    #[serde(default, alias = "skip_count")]
    pub skip_count: Option<u32>,
}

/// 存储形态（schedules.json，snake_case）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// "daily" | "weekly" | "weekdays"（周一到周五）| "hourly"（每 interval_hours 小时）| "manual"（只手动跑）
    pub frequency: String,
    /// weekly 时 1-7（周一=1）；daily 忽略
    pub weekday: Option<u8>,
    /// hourly 时有效：每天 0 点起每 N 小时一次，在 minute 分（N 取 24 的因数）；hour 忽略
    #[serde(default)]
    pub interval_hours: Option<u8>,
    pub hour: u8,
    pub minute: u8,
    pub enabled: bool,
    pub last_run_at: Option<String>,
    pub last_status: Option<String>,
    pub history: Vec<RunRecord>,
    /// 最近一次已处理（跑过或记了跳过）的应跑时刻，本地时间 ISO（无时区）。
    /// due 判定取它与 last_run_at 较晚者——跳过的时刻不再反复到点
    #[serde(default)]
    pub last_slot_at: Option<String>,
    /// 上一轮还没评审时这一轮跳过。None = 按技能默认：文献雷达不跳（采纳可以乱序），其他巡检跳
    #[serde(default)]
    pub skip_if_unreviewed: Option<bool>,
    /// 单次上限（分钟）；None = 30
    #[serde(default)]
    pub timeout_minutes: Option<u32>,
    /// 自动暂停的原因（连续失败 / 连接已删）；人重新打开开关时清掉
    #[serde(default)]
    pub paused_reason: Option<String>,
    /// 连续没跑成的次数（失败 / 超时；取消不算，成功清零）
    #[serde(default)]
    pub consecutive_failures: u32,
}

/// 前端 DTO（camelCase）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDto {
    pub id: String,
    pub running_run_id: Option<String>,
    /// 到点该跑但还没跑起来（并发上限或同项目互斥在等）——前端「排队中」标记的数据源。
    /// 关键词/注册表闸门不在这层：无关键词的雷达由前端 needsKeywords 单独呈现。
    #[serde(default)]
    pub queued: bool,
    pub name: String,
    pub project_root: String,
    pub skill: String,
    pub profile_id: Option<String>,
    pub model: Option<String>,
    pub linked_step: Option<String>,
    pub frequency: String,
    pub weekday: Option<u8>,
    pub interval_hours: Option<u8>,
    pub hour: u8,
    pub minute: u8,
    pub enabled: bool,
    pub last_run_at: Option<String>,
    pub last_status: Option<String>,
    pub history: Vec<RunRecord>,
    /// 生效值（None 已按技能默认展开）
    pub skip_if_unreviewed: bool,
    /// 生效值（None 已展开为 30）
    pub timeout_minutes: u32,
    pub paused_reason: Option<String>,
    pub consecutive_failures: u32,
    /// 下一次应跑时刻（本地时间 ISO，无时区）；停用 / 仅手动为 None。list_schedules 现算
    pub next_run_at: Option<String>,
}

impl From<Schedule> for ScheduleDto {
    fn from(s: Schedule) -> Self {
        Self {
            running_run_id: None,
            queued: false,
            skip_if_unreviewed: effective_skip_if_unreviewed(&s),
            timeout_minutes: effective_timeout_minutes(&s),
            next_run_at: None,
            id: s.id,
            name: s.name,
            project_root: s.project_root,
            skill: s.skill,
            profile_id: s.profile_id,
            model: s.model,
            linked_step: s.linked_step,
            frequency: s.frequency,
            weekday: s.weekday,
            interval_hours: s.interval_hours,
            hour: s.hour,
            minute: s.minute,
            enabled: s.enabled,
            last_run_at: s.last_run_at,
            last_status: s.last_status,
            history: s.history,
            paused_reason: s.paused_reason,
            consecutive_failures: s.consecutive_failures,
        }
    }
}

fn effective_skip_if_unreviewed(s: &Schedule) -> bool {
    s.skip_if_unreviewed.unwrap_or(s.skill != "lit-watch")
}

fn effective_timeout_minutes(s: &Schedule) -> u32 {
    s.timeout_minutes
        .filter(|m| TIMEOUT_MINUTES_RANGE.contains(m))
        .unwrap_or(DEFAULT_TIMEOUT_MINUTES)
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
    #[serde(default)]
    pub interval_hours: Option<u8>,
    pub hour: u8,
    pub minute: u8,
    #[serde(default)]
    pub skip_if_unreviewed: Option<bool>,
    #[serde(default)]
    pub timeout_minutes: Option<u32>,
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
    #[serde(default)]
    pub interval_hours: Option<u8>,
    pub hour: Option<u8>,
    pub minute: Option<u8>,
    pub enabled: Option<bool>,
    #[serde(default)]
    pub skip_if_unreviewed: Option<bool>,
    #[serde(default)]
    pub timeout_minutes: Option<u32>,
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
    /// 跑完但没有新内容：前端不弹通知
    noop: bool,
    /// 这次之后任务被自动暂停的原因（连续失败 / 连接已删）
    auto_paused: Option<String>,
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
        crate::lit_watch::delete_schedule_subscriptions(&task.project_root, &task.id);
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

/// 定时历史还引用着的后台对话（agent, 会话 id）：内部对话保留期清理跳过它们，「看过程」才打得开。
/// 读不到 schedules.json 时返回空集（清理照旧按保留期走，不因此卡住）
pub(crate) fn referenced_sessions() -> HashSet<(String, String)> {
    let Ok(path) = schedules_path() else {
        return HashSet::new();
    };
    let Ok(_g) = sched_lock() else {
        return HashSet::new();
    };
    read_schedules_at(&path)
        .map(|list| referenced_sessions_of(&list))
        .unwrap_or_default()
}

fn referenced_sessions_of(list: &[Schedule]) -> HashSet<(String, String)> {
    list.iter()
        .flat_map(|t| t.history.iter())
        .filter_map(|r| Some((r.agent.clone()?, r.session_id.clone()?)))
        .collect()
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

/// tick 已拉起、还在跑的运行数（并发上限计数）；spawn 线程结束时递减，所有出口都走
/// spawn_blocking 的 await 收尾，不会泄漏
static TICK_INFLIGHT: AtomicUsize = AtomicUsize::new(0);

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

/// 同项目互斥锁（2026-10-16 跨项目并行拍板）：同一项目根上多条雷达并行会抢同一个
/// 主仓的 git 操作、采纳时写同一份追加式台账（无并发控制；2026-10-15 实测并行写坏
/// watch-seen）。锁键走 canonical_key 归一大小写/斜杠差异；与任务锁同目录、
/// 文件名加 project- 前缀区分。锁顺序恒为 任务锁 → 项目锁，sched_lock 永远是叶子。
fn project_lock_at(dir: &Path, project_root: &str) -> Result<fs::File, String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建任务锁目录失败：{e}"))?;
    let key = crate::projects::canonical_key(Path::new(project_root));
    let name = format!("project-{:x}.lock", md5::compute(key.as_bytes()));
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(name))
        .map_err(|e| format!("打开项目锁失败：{e}"))?;
    file.try_lock()
        .map_err(|_| "该项目已有雷达在运行".to_string())?;
    Ok(file)
}

fn project_lock(project_root: &str) -> Result<fs::File, String> {
    project_lock_at(&schedules_path()?.with_file_name("schedule-locks"), project_root)
}

fn resolve_git_common_dir(repo: &Path, value: &str) -> String {
    crate::projects::canonical_key(&repo.join(value.trim()))
}

// ===== due 判定（纯函数，时间全部注入，可测） =====

fn at_hms(date: NaiveDate, hour: u8, minute: u8) -> Option<NaiveDateTime> {
    date.and_hms_opt(hour as u32, minute as u32, 0)
}

/// 周期：due 判定的全部输入（纯数据，测试直接构造）
#[derive(Debug, Clone, Copy)]
struct Cadence<'a> {
    frequency: &'a str,
    weekday: Option<u8>,
    interval_hours: Option<u8>,
    hour: u8,
    minute: u8,
}

impl<'a> Cadence<'a> {
    fn of(s: &'a Schedule) -> Self {
        Self {
            frequency: &s.frequency,
            weekday: s.weekday,
            interval_hours: s.interval_hours,
            hour: s.hour,
            minute: s.minute,
        }
    }

    #[cfg(test)]
    fn simple(frequency: &'a str, weekday: Option<u8>, hour: u8, minute: u8) -> Self {
        Self {
            frequency,
            weekday,
            interval_hours: None,
            hour,
            minute,
        }
    }
}

fn is_workday(date: NaiveDate) -> bool {
    date.weekday().num_days_from_monday() < 5
}

/// 不晚于 now 的最近一个应跑时刻（本地时间）：daily = 今天 hour:minute（还没到则昨天）；
/// weekly = 本周 weekday+hour:minute（还没到则上周）；weekdays = 最近一个周一到周五；
/// hourly = 今天 0 点起每 N 小时的 :minute（还没到第一个则昨天最后一个）；manual 永远没有
fn latest_slot(c: Cadence, now: NaiveDateTime) -> Option<NaiveDateTime> {
    let today = now.date();
    match c.frequency {
        "manual" => None,
        "hourly" => {
            let n = c
                .interval_hours
                .filter(|n| INTERVAL_HOURS_ALLOWED.contains(n))
                .unwrap_or(1);
            let mut best = None;
            for h in (0..24u8).step_by(n as usize) {
                let moment = at_hms(today, h, c.minute)?;
                if moment <= now {
                    best = Some(moment);
                }
            }
            best.or_else(|| at_hms(today - ChronoDuration::days(1), 24 - n, c.minute))
        }
        "weekdays" => (0..8).find_map(|back| {
            let date = today - ChronoDuration::days(back);
            let moment = at_hms(date, c.hour, c.minute)?;
            (is_workday(date) && moment <= now).then_some(moment)
        }),
        "weekly" => {
            // weekday 1-7（周一=1）→ chrono num_days_from_monday 0-6
            let target = (c.weekday.unwrap_or(1) as i64 - 1).clamp(0, 6);
            let cur = today.weekday().num_days_from_monday() as i64;
            let date = today + ChronoDuration::days(target - cur);
            let moment = at_hms(date, c.hour, c.minute)?;
            if moment > now {
                at_hms(date - ChronoDuration::days(7), c.hour, c.minute)
            } else {
                Some(moment)
            }
        }
        _ => {
            let moment = at_hms(today, c.hour, c.minute)?;
            if moment > now {
                at_hms(today - ChronoDuration::days(1), c.hour, c.minute)
            } else {
                Some(moment)
            }
        }
    }
}

/// 严格早于 slot 的上一个应跑时刻
fn prev_slot(c: Cadence, slot: NaiveDateTime) -> Option<NaiveDateTime> {
    latest_slot(c, slot - ChronoDuration::seconds(1))
}

/// 严格晚于 now 的下一个应跑时刻（列表「下次」显示用）：从一周多以后往回走
fn next_slot(c: Cadence, now: NaiveDateTime) -> Option<NaiveDateTime> {
    let mut slot = latest_slot(c, now + ChronoDuration::days(8))?;
    if slot <= now {
        return None;
    }
    while let Some(prev) = prev_slot(c, slot) {
        if prev <= now {
            break;
        }
        slot = prev;
    }
    Some(slot)
}

/// last_run_at（ISO UTC 字符串）→ 本地 NaiveDateTime；解析失败按「没跑过」处理（更安全的方向：补跑）
fn parse_last_run_local(last_run_at: Option<&str>) -> Option<NaiveDateTime> {
    last_run_at.and_then(|s| {
        chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|dt| dt.with_timezone(&Local).naive_local())
    })
}

const SLOT_FORMAT: &str = "%Y-%m-%dT%H:%M:%S";

fn format_slot(slot: NaiveDateTime) -> String {
    slot.format(SLOT_FORMAT).to_string()
}

fn parse_slot(text: Option<&str>) -> Option<NaiveDateTime> {
    text.and_then(|t| NaiveDateTime::parse_from_str(t, SLOT_FORMAT).ok())
}

/// 已处理到哪个时刻：最近一次运行结束与最近一次记账（跑过或跳过）的应跑时刻取较晚者
fn last_handled(s: &Schedule) -> Option<NaiveDateTime> {
    let ran = parse_last_run_local(s.last_run_at.as_deref());
    let slot = parse_slot(s.last_slot_at.as_deref());
    match (ran, slot) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

/// 到点了就返回这次的应跑时刻。last_handled 早于最近一次应跑时刻即 due；None（从没跑过）恒 due。
/// 漏跑多次只算一次 due：跑一次后已处理时刻落到最新时刻之后，自然不再 due（coalesce）
fn due_slot(
    c: Cadence,
    last_handled: Option<NaiveDateTime>,
    now: NaiveDateTime,
) -> Option<NaiveDateTime> {
    let moment = latest_slot(c, now)?;
    match last_handled {
        Some(last) if last >= moment => None,
        _ => Some(moment),
    }
}

/// daily / weekly 的旧入口（测试沿用）
#[cfg(test)]
fn is_due(
    frequency: &str,
    weekday: Option<u8>,
    hour: u8,
    minute: u8,
    last_run_local: Option<NaiveDateTime>,
    now: NaiveDateTime,
) -> bool {
    due_slot(Cadence::simple(frequency, weekday, hour, minute), last_run_local, now).is_some()
}

/// 这次补跑之前还错过了几次（只往回数一周；从没跑过的任务不算错过）
fn missed_before(
    c: Cadence,
    slot: NaiveDateTime,
    last_handled: Option<NaiveDateTime>,
    now: NaiveDateTime,
) -> u32 {
    let Some(last) = last_handled else {
        return 0;
    };
    let floor = now - ChronoDuration::days(MISSED_LOOKBACK_DAYS);
    let mut count = 0;
    let mut cur = slot;
    while let Some(prev) = prev_slot(c, cur) {
        if prev <= last || prev < floor || count >= 500 {
            break;
        }
        count += 1;
        cur = prev;
    }
    count
}

/// 这次到点是准点还是补跑：应跑时刻早于本次启动 = 应用没开；落在上一个 tick 之后、而两次 tick
/// 隔了好几分钟 = 电脑睡过。排队等出来的晚到仍算准点。返回（触发方式, 错过原因）
fn classify_trigger(
    slot: NaiveDateTime,
    app_started: NaiveDateTime,
    prev_tick: Option<NaiveDateTime>,
    now: NaiveDateTime,
) -> (&'static str, Option<&'static str>) {
    if slot < app_started {
        return ("catchup", Some("missed_closed"));
    }
    if let Some(prev) = prev_tick {
        if now - prev > ChronoDuration::minutes(SLEEP_GAP_MINUTES) && slot > prev {
            return ("catchup", Some("missed_asleep"));
        }
    }
    ("schedule", None)
}

fn skip_reason_text(code: &str) -> &'static str {
    match code {
        "missed_closed" => "应用没开",
        "missed_asleep" => "电脑在睡眠",
        "unreviewed" => "上一轮还没评审",
        "no_keywords" => "还没有关键词",
        _ => "没赶上",
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
    if !matches!(frequency, "daily" | "weekly" | "weekdays" | "hourly" | "manual") {
        return Err(format!(
            "frequency 必须是 daily / weekly / weekdays / hourly / manual: {frequency}"
        ));
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

/// 周期之外的两项：每 N 小时只收 24 的因数；单次上限 5–180 分钟
fn validate_extras(
    frequency: &str,
    interval_hours: Option<u8>,
    timeout_minutes: Option<u32>,
) -> Result<(), String> {
    if frequency == "hourly" {
        match interval_hours {
            Some(n) if INTERVAL_HOURS_ALLOWED.contains(&n) => {}
            _ => return Err("每 N 小时只能选 1、2、3、4、6、8、12".into()),
        }
    }
    if let Some(m) = timeout_minutes {
        if !TIMEOUT_MINUTES_RANGE.contains(&m) {
            return Err("单次上限要在 5 到 180 分钟之间".into());
        }
    }
    Ok(())
}

fn build_task_prompt(skill: &str) -> String {
    let template = if skill == "lit-watch" {
        TASK_PROMPT_LIT_WATCH
    } else {
        TASK_PROMPT_GENERIC
    };
    template.replace("{skill}", skill)
}

/// Windows 上 Codex 用非提权沙箱时追加的一句：Codex 0.163 在这种模式下 shell 起在自己的安装目录，命令里的相对路径
/// 会落到那里被拒（2026-10-20 实测，绝对路径正常），所以要求它写文件用绝对路径（agent_specs::codex_windows_headless_cap）
fn codex_win_unelevated_note(agent: &str, root: &Path) -> Option<String> {
    if !cfg!(windows) || agent != "codex" {
        return None;
    }
    let consent = crate::settings::read_current().codex_win_sandbox_consent.unwrap_or(false);
    let user_mode = crate::agent_specs::codex_windows_sandbox_mode();
    (crate::agent_specs::codex_win_effective_sandbox(user_mode.as_deref(), consent) == Some("unelevated"))
        .then(|| codex_unelevated_prompt_line(root))
}

fn codex_unelevated_prompt_line(root: &Path) -> String {
    format!(
        "\n\n（Windows 沙箱）在命令里读写文件一律用绝对路径，工作目录是 {}——这里的命令不会从工作目录启动，相对路径会落到别处被拒绝。",
        crate::paths::strip_verbatim(root.to_path_buf()).display()
    )
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
    validate_extras(&input.frequency, input.interval_hours, input.timeout_minutes)?;
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
        interval_hours: (input.frequency == "hourly").then_some(input.interval_hours).flatten(),
        frequency: input.frequency,
        weekday: input.weekday,
        hour: input.hour,
        minute: input.minute,
        enabled: true,
        skip_if_unreviewed: input.skip_if_unreviewed,
        timeout_minutes: input.timeout_minutes,
        ..Default::default()
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
    if let Some(n) = patch.interval_hours {
        task.interval_hours = Some(n);
    }
    if task.frequency != "hourly" {
        task.interval_hours = None;
    }
    if let Some(hour) = patch.hour {
        task.hour = hour;
    }
    if let Some(minute) = patch.minute {
        task.minute = minute;
    }
    if let Some(skip) = patch.skip_if_unreviewed {
        task.skip_if_unreviewed = Some(skip);
    }
    if let Some(minutes) = patch.timeout_minutes {
        // 0 = 回到默认 30 分钟
        task.timeout_minutes = (minutes != 0).then_some(minutes);
    }
    if let Some(enabled) = patch.enabled {
        if enabled && !task.enabled {
            reenable(task, Local::now().naive_local());
        }
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
    validate_extras(&task.frequency, task.interval_hours, task.timeout_minutes)?;
    task.project_root = root;
    let task = task.clone();
    write_schedules_at(path, &list)?;
    Ok(task)
}

/// 人重新打开开关：清掉自动暂停的原因与失败计数；停用期间错过的时刻算处理过——
/// 打开后从下一次到点开始跑，不补跑也不记「错过」（想马上跑点立即跑）
fn reenable(task: &mut Schedule, now: NaiveDateTime) {
    task.paused_reason = None;
    task.consecutive_failures = 0;
    if let Some(slot) = latest_slot(Cadence::of(task), now) {
        task.last_slot_at = Some(format_slot(slot));
    }
}

/// 跑一次后回填 last_run_at/last_status/history（新的在前，只留 20 条）并原子写。
/// 返回这次新触发的自动暂停原因（前端据此弹通知、收件箱据 paused_reason 出条目）
fn record_run(
    id: &str,
    rec: RunRecord,
    slot: Option<NaiveDateTime>,
    force_pause: Option<String>,
) -> Result<Option<String>, String> {
    let _g = sched_lock()?;
    let path = schedules_path()?;
    let mut list = read_schedules_at(&path)?;
    let task = list
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("定时任务不存在: {id}"))?;
    let paused = apply_run_record(task, rec, slot, force_pause);
    write_schedules_at(&path, &list)?;
    Ok(paused)
}

/// 已处理时刻只往后推
fn bump_slot(task: &mut Schedule, slot: NaiveDateTime) {
    if parse_slot(task.last_slot_at.as_deref()).is_none_or(|cur| cur < slot) {
        task.last_slot_at = Some(format_slot(slot));
    }
}

fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let mut out: String = line.chars().take(max).collect();
    if line.chars().count() > max {
        out.push('…');
    }
    out
}

/// record_run 的纯逻辑（单测钉住）：回填、失败计数、自动暂停。
/// 手动「立即跑」不进失败计数（人在场调试，不该把任务停掉），成功一律清零。
fn apply_run_record(
    task: &mut Schedule,
    rec: RunRecord,
    slot: Option<NaiveDateTime>,
    force_pause: Option<String>,
) -> Option<String> {
    task.last_run_at = Some(rec.at.clone());
    task.last_status = Some(rec.status.clone());
    if let Some(slot) = slot {
        bump_slot(task, slot);
    }
    let counted = rec.trigger.as_deref() != Some("manual");
    match rec.status.as_str() {
        "ok" => task.consecutive_failures = 0,
        "error" | "timeout" if counted => task.consecutive_failures += 1,
        _ => {}
    }
    let reason = force_pause.or_else(|| {
        (task.consecutive_failures >= AUTO_PAUSE_AFTER_FAILURES).then(|| {
            format!(
                "连续 {} 次没跑成，已自动暂停。最后一次：{}",
                task.consecutive_failures,
                first_line(&rec.summary, 80)
            )
        })
    });
    let paused = match reason {
        Some(reason) if task.enabled => {
            task.enabled = false;
            task.paused_reason = Some(reason.clone());
            Some(reason)
        }
        _ => None,
    };
    task.history.insert(0, rec);
    task.history.truncate(HISTORY_CAP);
    paused
}

/// 记一次跳过（到点没跑）。handled = 这个时刻算处理过（不再反复到点）；
/// 没有关键词的雷达不算处理过——订上关键词后下一个 tick 就接着跑。
fn record_skip(
    id: &str,
    code: &str,
    slot: NaiveDateTime,
    count: u32,
    handled: bool,
) -> Result<(), String> {
    let _g = sched_lock()?;
    let path = schedules_path()?;
    let mut list = read_schedules_at(&path)?;
    let Some(task) = list.iter_mut().find(|t| t.id == id) else {
        return Ok(());
    };
    if apply_skip(task, code, slot, count, handled, &crate::sessions::now_iso()) {
        write_schedules_at(&path, &list)?;
    }
    Ok(())
}

/// record_skip 的纯逻辑：同一原因连着跳过合并成一行（次数累加），同一时刻重复记账不变。
/// 返回是否改了任务。
fn apply_skip(
    task: &mut Schedule,
    code: &str,
    slot: NaiveDateTime,
    count: u32,
    handled: bool,
    now_iso: &str,
) -> bool {
    let before = task.last_slot_at.clone();
    if handled {
        bump_slot(task, slot);
    }
    let slot_text = format_slot(slot);
    if let Some(top) = task.history.first_mut() {
        if top.status == "skipped" && top.skip_reason.as_deref() == Some(code) {
            if top.scheduled_for.as_deref() == Some(slot_text.as_str()) {
                return task.last_slot_at != before;
            }
            top.skip_count = Some(top.skip_count.unwrap_or(1) + count.max(1));
            top.at = now_iso.to_string();
            top.scheduled_for = Some(slot_text);
            return true;
        }
    }
    task.history.insert(
        0,
        RunRecord {
            at: now_iso.to_string(),
            status: "skipped".into(),
            summary: format!("已跳过：{}", skip_reason_text(code)),
            scheduled_for: Some(slot_text),
            skip_reason: Some(code.to_string()),
            skip_count: Some(count.max(1)),
            ..Default::default()
        },
    );
    task.history.truncate(HISTORY_CAP);
    true
}

/// 上一轮还有没评审的产物：最近一次成功运行有隔离产物、没采纳、也不是「无新内容」。
/// 只认 2026-10-23 之后记的运行（带 trigger）：之前的记录没算过「无新内容」，升级后不拿它们拦人
fn has_unreviewed(task: &Schedule) -> bool {
    task.history
        .iter()
        .find(|r| r.status == "ok")
        .is_some_and(|r| {
            r.trigger.is_some()
                && r.isolation_path.is_some()
                && r.run_id.is_some()
                && !r.adopted
                && !r.noop
        })
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
    let path = crate::workspaces::watch_worktrees_root()?
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
/// （.ccode/watch/<id>/watchlist.md），播种时由 seed_schedule_watchlist 单独写入。
///
/// 台账每轮开跑前以主仓为真源重新播种（2026-10-17 审查修复）：旧口径「隔离树没有才拷」让
/// 隔离树一旦与主仓分叉（同项目第二条雷达的采纳、人手改删、补批次标记）就永远对不上，
/// 整文件采纳从此被冲突拦死。收件箱/跟进/引文照主仓镜像（主仓没有就删隔离副本）；
/// 已见台账见 WATCH_SEEN_FILE。
pub(crate) const WATCH_MIRROR_FILES: &[&str] = &[
    "notes/inbox.md",
    "papers/watch-followup.md",
    "notes/references.bib",
];
/// 已见台账取主仓 ∪ 隔离树：隔离树里还没采纳的运行见过的标识要留着，否则下一轮把同一批
/// 又当新命中；主仓里别的雷达见过的也并进来，同项目多条雷达不再互相重复入箱。
pub(crate) const WATCH_SEEN_FILE: &str = "papers/watch-seen.md";
/// 流程正典的只读副本：关联推荐通道（技能 §2b）的种子。隔离 worktree 停在建任务那一刻的
/// HEAD，积累账又不进 git——不每轮镜像就只能读到旧种子或读不到。只读输入，永不采纳（WATCH_DENY_FILES）。
pub(crate) const WATCH_SEED_INPUTS: &[&str] = &[
    "papers/included.json",
    "papers/included.md",
    "papers/reading-list.md",
];
/// 采纳进主仓的产出文件：四类台账，按条目追加合并（watch_review::adopt_at）。订阅在
/// .ccode/watch/<id>/，不从隔离树回写。免费全文 PDF 是二进制，由 lit_watch::adopt_watch_pdfs
/// 只拷本轮新下的那几篇——旧口径的 `papers/` 整目录把流程正典也放进了可采纳范围。
pub(crate) const WATCH_ADOPT_FILES: &[&str] = &[
    "notes/inbox.md",
    "papers/watch-seen.md",
    "papers/watch-followup.md",
    "notes/references.bib",
];
/// 雷达永不采纳的流程正典与 Mesa 内部路径（2026-10-17 审查修复）：「雷达不写 included.md /
/// notes/index.json / references.bib」原先只靠 prompt 守，自定义巡检技能还能在 outputs 里
/// 声明这些路径。契约展开与采纳两处都过这道闸。
const WATCH_DENY_FILES: &[&str] = &[
    "papers/included.md",
    "papers/included.json",
    "papers/screening.md",
    "papers/to-fetch.md",
    "papers/to-fetch.ris",
    "papers/endnote-import.ris",
    "papers/zotero-sync.md",
    "papers/reading-list.md",
    "notes/index.json",
    "notes/handoff.md",
    "references.bib",
    "outline.md",
    "task.md",
];
const WATCH_DENY_DIRS: &[&str] = &["manuscript/", ".ccode/", ".git/"];

/// 流程正典/内部路径判定（大小写折叠：APFS/NTFS 上 Papers/ 与 papers/ 是同一目录）
pub(crate) fn watch_path_denied(rel: &str) -> bool {
    let p = rel.trim().replace('\\', "/");
    let p = p.trim_start_matches("./").to_lowercase();
    WATCH_DENY_FILES.iter().any(|d| p == *d)
        || WATCH_DENY_DIRS
            .iter()
            .any(|d| p.starts_with(d) || p == d.trim_end_matches('/'))
}

/// 某次巡检的可采纳契约（§4.9 后半）：四类文献台账是基线；非 lit-watch 技能并上其
/// SKILL.md frontmatter 声明的产出（outputs；目录带尾斜杠）。契约外路径永不自动采纳。
pub(crate) fn watch_adopt_patterns_for(skill: &str) -> Vec<String> {
    let mut patterns: Vec<String> = WATCH_ADOPT_FILES.iter().map(|s| s.to_string()).collect();
    if skill != "lit-watch" {
        for out in crate::skills::skill_declared_outputs(skill) {
            let rel = out.trim().replace('\\', "/");
            if watch_rel_ok(&rel) && !watch_path_denied(&rel) && !patterns.contains(&rel) {
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
    let src_meta = match std::fs::symlink_metadata(&src) {
        Ok(m) => m,
        Err(_) => return Ok(false),
    };
    if src_meta.file_type().is_symlink() || !src_meta.is_file() {
        return Ok(false);
    }
    let dest = watch_dest_checked(to, rel)?;
    if dest.exists() && !overwrite {
        return Ok(false);
    }
    let from_c =
        crate::paths::canonicalize_plain(from).map_err(|e| format!("源目录无法解析: {e}"))?;
    let src_c =
        crate::paths::canonicalize_plain(&src).map_err(|e| format!("源文件无法解析: {e}"))?;
    if !crate::paths::path_within_path(&src_c, &from_c) {
        return Err(format!("源文件不在允许目录内: {rel}"));
    }
    fs::copy(&src, &dest).map_err(|e| format!("复制 {rel} 失败: {e}"))?;
    Ok(true)
}

/// 隔离树里的写入目标：拒绝符号链接、建好父目录并确认父目录仍在隔离树内。
fn watch_dest_checked(to: &Path, rel: &str) -> Result<PathBuf, String> {
    if !watch_rel_ok(rel) {
        return Err(format!("不允许的相对路径: {rel}"));
    }
    let dest = to.join(rel);
    if dest
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!("拒绝写入符号链接: {rel}"));
    }
    let to_c =
        crate::paths::canonicalize_plain(to).map_err(|e| format!("目标目录无法解析: {e}"))?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {e}"))?;
        let parent_c = crate::paths::canonicalize_plain(parent)
            .map_err(|e| format!("目标目录无法解析: {e}"))?;
        if !crate::paths::path_within_path(&parent_c, &to_c) {
            return Err(format!("目标路径逃出允许目录: {rel}"));
        }
    }
    Ok(dest)
}

/// 主仓有就覆盖拷进隔离树；主仓没有就删掉隔离树里的旧副本（只删普通文件）。
fn mirror_watch_rel(from: &Path, to: &Path, rel: &str) -> Result<(), String> {
    if copy_watch_rel(from, to, rel, true)? {
        return Ok(());
    }
    let dest = watch_dest_checked(to, rel)?;
    match fs::symlink_metadata(&dest) {
        Ok(meta) if meta.is_file() => {
            fs::remove_file(&dest).map_err(|e| format!("清理隔离副本 {rel} 失败: {e}"))
        }
        _ => Ok(()),
    }
}

/// 已见台账：主仓全文在前，隔离树独有的标识行续在后面（逐行去重，空行不算）。
fn merge_seen_into_isolation(from: &Path, to: &Path) -> Result<(), String> {
    let read = |root: &Path| -> Result<Option<String>, String> {
        let path = root.join(WATCH_SEEN_FILE);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                Err(format!("拒绝读取符号链接: {WATCH_SEEN_FILE}"))
            }
            Ok(meta) if meta.is_file() => fs::read_to_string(&path)
                .map(Some)
                .map_err(|e| format!("读取 {WATCH_SEEN_FILE} 失败: {e}")),
            _ => Ok(None),
        }
    };
    let main = read(from)?;
    let iso = read(to)?;
    let merged = merge_seen_text(main.as_deref(), iso.as_deref());
    if merged.as_deref() == iso.as_deref() {
        return Ok(());
    }
    let Some(text) = merged else {
        return Ok(());
    };
    let dest = watch_dest_checked(to, WATCH_SEEN_FILE)?;
    crate::profiles::atomic_write(&dest, &text)
        .map_err(|e| format!("写入隔离 {WATCH_SEEN_FILE} 失败: {e}"))
}

/// merge_seen_into_isolation 的纯文本部分（单测钉住）。两边都没有返回 None。
fn merge_seen_text(main: Option<&str>, iso: Option<&str>) -> Option<String> {
    let (main, iso) = match (main, iso) {
        (None, None) => return None,
        (Some(m), None) => return Some(m.to_string()),
        (None, Some(i)) => return Some(i.to_string()),
        (Some(m), Some(i)) => (m, i),
    };
    let mut have: HashSet<&str> = main.lines().map(str::trim).collect();
    let extra: Vec<&str> = iso
        .lines()
        .filter(|l| !l.trim().is_empty() && have.insert(l.trim()))
        .collect();
    if extra.is_empty() {
        return Some(main.to_string());
    }
    let mut out = main.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&extra.join("\n"));
    out.push('\n');
    Some(out)
}

pub(crate) fn seed_watch_isolation(project_root: &Path, isolation: &Path) -> Result<(), String> {
    for rel in WATCH_MIRROR_FILES.iter().chain(WATCH_SEED_INPUTS) {
        mirror_watch_rel(project_root, isolation, rel)?;
    }
    merge_seen_into_isolation(project_root, isolation)
}

// ===== 跨轮记忆（通用巡检技能；2026-10-23） =====
//
// 每条任务一份 `.ccode/watch/<任务id>/memory.md`（与雷达订阅同目录，gitignored）。隔离树里那份是
// 活的：每轮在它上面接着记，没采纳也不丢；项目里那份在人「采纳进项目」时更新，人在界面改的写项目
// 那份。播种：项目那份比隔离那份新（人改过 / 隔离目录重建）才拷进去。

fn memory_rel(id: &str) -> Result<String, String> {
    if !schedule_id_ok(id) {
        return Err("无效的任务编号".into());
    }
    Ok(format!(".ccode/watch/{id}/memory.md"))
}

fn modified(path: &Path) -> Option<std::time::SystemTime> {
    fs::symlink_metadata(path)
        .ok()
        .filter(|m| m.is_file())
        .and_then(|m| m.modified().ok())
}

/// 项目那份比隔离那份新（或隔离没有）才拷进隔离树
fn seed_memory(project_root: &Path, isolation: &Path, id: &str) -> Result<(), String> {
    let rel = memory_rel(id)?;
    let main = modified(&project_root.join(&rel));
    let iso = modified(&isolation.join(&rel));
    match (main, iso) {
        (Some(m), Some(i)) if m <= i => Ok(()),
        (Some(_), _) => copy_watch_rel(project_root, isolation, &rel, true).map(|_| ()),
        (None, _) => Ok(()),
    }
}

/// 采纳时把隔离那份带回项目（内容相同不写）
fn adopt_memory(isolation: &Path, project_root: &Path, id: &str) -> Result<bool, String> {
    let rel = memory_rel(id)?;
    let Ok(text) = fs::read_to_string(isolation.join(&rel)) else {
        return Ok(false);
    };
    if fs::read_to_string(project_root.join(&rel)).ok().as_deref() == Some(text.as_str()) {
        return Ok(false);
    }
    let dest = watch_dest_checked(project_root, &rel)?;
    crate::profiles::atomic_write(&dest, &text)?;
    Ok(true)
}

/// 给通用巡检的任务说明追加：记忆文件在哪、记什么
fn memory_prompt_line(isolation: &Path, id: &str) -> Option<String> {
    let rel = memory_rel(id).ok()?;
    let path = crate::paths::strip_verbatim(isolation.join(rel));
    Some(format!(
        "\n\n跨轮记忆：{}。开始前先读它（没有就是第一次跑）；结束前把以后各轮还用得上的内容更新进去——已经处理过的条目标识、对比用的基线数字、还要跟进的事。只记这些，控制在 200 行以内，不写这一轮的流水账。",
        path.display()
    ))
}

/// 任务的隔离目录（与 schedule_isolation / purge 同一拼接规则）；不建
fn isolation_dir_of(task: &Schedule) -> Option<PathBuf> {
    let repo_name = Path::new(&task.project_root)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");
    let path = crate::workspaces::watch_worktrees_root()
        .ok()?
        .join(repo_name)
        .join(&task.id);
    path.is_dir().then_some(path)
}

fn find_schedule(id: &str) -> Result<Schedule, String> {
    let _g = sched_lock()?;
    read_schedules_at(&schedules_path()?)?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("定时任务不存在: {id}"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleMemoryDto {
    pub text: String,
    /// 读的是哪一份：isolation = 最近一轮巡检自己记的（还没采纳），project = 项目里那份
    pub source: String,
    pub exists: bool,
}

/// 读跨轮记忆：两份里较新的那份
#[tauri::command]
pub fn schedule_memory_read(id: String) -> Result<ScheduleMemoryDto, String> {
    let task = find_schedule(&id)?;
    let rel = memory_rel(&id)?;
    let root = gated_project_root(&task.project_root)?;
    let main = root.join(&rel);
    let iso = isolation_dir_of(&task).map(|d| d.join(&rel));
    let use_iso = match (&iso, modified(&main)) {
        (Some(p), Some(m)) => modified(p).is_some_and(|i| i > m),
        (Some(p), None) => modified(p).is_some(),
        _ => false,
    };
    let (path, source) = if use_iso {
        (iso.unwrap_or(main), "isolation")
    } else {
        (main, "project")
    };
    match fs::read_to_string(&path) {
        Ok(text) => Ok(ScheduleMemoryDto {
            text,
            source: source.into(),
            exists: true,
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ScheduleMemoryDto {
            text: String::new(),
            source: "project".into(),
            exists: false,
        }),
        Err(e) => Err(format!("读取跨轮记忆失败：{e}")),
    }
}

/// 人改跨轮记忆：写项目那份，隔离目录在就一并写（下一轮从人改过的接着记）
#[tauri::command]
pub fn schedule_memory_write(id: String, text: String) -> Result<(), String> {
    if text.len() > 256 * 1024 {
        return Err("跨轮记忆超过 256 KB，先删掉些旧内容".into());
    }
    let task = find_schedule(&id)?;
    let rel = memory_rel(&id)?;
    let root = gated_project_root(&task.project_root)?;
    let dest = watch_dest_checked(&root, &rel)?;
    crate::profiles::atomic_write(&dest, &text)?;
    if let Some(iso) = isolation_dir_of(&task) {
        let dest = watch_dest_checked(&iso, &rel)?;
        crate::profiles::atomic_write(&dest, &text)?;
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
/// 要拷 PDF、改台账，在后台线程做（见 conventions/terminal.md「会等待的命令不占主线程」）
#[tauri::command]
pub async fn adopt_watch_run(app: tauri::AppHandle, run_id: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || adopt_watch_run_sync(app, run_id))
        .await
        .map_err(|e| format!("采纳失败: {e}"))?
}

fn adopt_watch_run_sync(app: tauri::AppHandle, run_id: String) -> Result<Vec<String>, String> {
    let run = crate::runs::run_get_sync(run_id.clone())?.ok_or("Run 不存在")?;
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
    let snapshot = crate::watch_review::load_at(&crate::watch_review::review_dir()?, &run_id)?;
    if !crate::paths::same_path(&snapshot.project_root, &project.to_string_lossy()) {
        return Err("冻结证据所属项目与运行记录不一致".into());
    }
    // 评审里被「排除」的条目不进项目：收件箱/跟进/引文的追加段剔掉，PDF 也不拷。
    // 雷达文献只是项目内的日常积累，纳入/排除不写科研流程的精读清单与引用库，
    // 这里只决定这批积累里哪些留在项目里（2026-10-13 用户拍板口径）。
    let excluded = if schedule.skill == "lit-watch" {
        crate::watch_review::excluded_entry_ids(&isolation)
    } else {
        Vec::new()
    };
    // 保护清单读不出来 = 不可信，fail-closed 拒绝采纳（与 runs.rs 验收写回同一口径）
    let protected = crate::projects::protected_paths_at(&project)?;
    let copied = crate::watch_review::adopt_at(
        &crate::watch_review::review_dir()?,
        &snapshot,
        &project,
        &protected,
        &patterns,
        &excluded,
    )?;
    // 免费全文是二进制，文本冻结带不走：只拷本轮新下、且没被排除的 PDF 并登记。
    // 隔离树里以前各轮的 PDF 不再拷——主仓里被精读步改名或被人删掉的，不会再被拷回来。
    let mut copied = copied;
    if schedule.skill == "lit-watch" {
        let new_pdfs = crate::watch_review::new_pdfs_of(&snapshot);
        let excluded_titles = crate::watch_review::excluded_titles_of(&snapshot, &excluded);
        match crate::lit_watch::adopt_watch_pdfs(
            &isolation,
            &project,
            new_pdfs.as_deref(),
            &excluded_titles,
        ) {
            Ok(pdfs) => copied.extend(pdfs),
            Err(e) => {
                return Err(format!(
                    "文本已采纳，但免费全文没拷进 papers/：{e}。可再执行一次采纳补拷"
                ));
            }
        }
    }
    // 通用巡检的跨轮记忆跟着采纳回到项目（不进验收清单：它是 Mesa 的内部台账，不是交付物）
    if schedule.skill != "lit-watch" {
        if let Err(e) = adopt_memory(&isolation, &project, &schedule.id) {
            crate::logbuf::record("warn", "scheduler", &format!("跨轮记忆没带回项目：{e}"));
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

/// 未钉连接的定时任务按项目默认取连接（2026-10-17 审查修复）。旧口径直接跳到设置页
/// AI 专用配置 / 最近用过的连接，Agents 页又只写「自动」——无人值守的雷达用哪家供应商，
/// 取决于你最近在别处点了什么。与前端 projectAgentLaunch 同口径：项目默认 Agent 的绑定
/// 连接还在就用它，否则该 Agent 的第一条。
enum ProjectDefaultPick {
    /// 项目没设默认 Agent（或任务已钉连接）：走既有自动链
    Unset,
    /// 用项目默认：连接 + 名册里点选的模型（可能为空）
    Use(crate::profiles::Profile, Option<String>),
    /// 设了默认但用不上：回落自动链，原因写进运行历史
    Skip(String),
}

fn pick_project_default(
    profiles: &[crate::profiles::Profile],
    prefs: Option<&crate::projects::ProjectDefaultPrefs>,
    blocked: impl Fn(&str) -> Option<String>,
) -> ProjectDefaultPick {
    let Some(prefs) = prefs else {
        return ProjectDefaultPick::Unset;
    };
    let for_agent: Vec<&crate::profiles::Profile> =
        profiles.iter().filter(|p| p.agent == prefs.agent).collect();
    let picked = prefs
        .profile
        .as_deref()
        .and_then(|id| for_agent.iter().find(|p| p.id == id).copied())
        .or_else(|| for_agent.first().copied());
    let Some(profile) = picked else {
        return ProjectDefaultPick::Skip(format!(
            "项目默认 Agent（{}）没有可用连接，本次按自动规则选连接；",
            prefs.agent
        ));
    };
    if let Some(reason) = blocked(&profile.agent) {
        return ProjectDefaultPick::Skip(format!(
            "项目默认连接不能用于定时任务（{reason}），本次按自动规则选连接；"
        ));
    }
    ProjectDefaultPick::Use(profile.clone(), prefs.model.clone())
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

/// 一次运行的来由：准点 / 补跑 / 手动，以及应跑时刻、之前错过几次、附言
#[derive(Debug, Clone, Default)]
struct RunContext {
    /// "schedule" | "catchup" | "manual"
    trigger: String,
    slot: Option<NaiveDateTime>,
    missed: u32,
    missed_reason: Option<&'static str>,
    note: Option<String>,
}

impl RunContext {
    fn manual(note: Option<String>) -> Self {
        Self {
            trigger: "manual".into(),
            note,
            ..Default::default()
        }
    }
}

fn human_time(t: NaiveDateTime) -> String {
    t.format("%m月%d日 %H:%M").to_string()
}

/// 最近一次成功运行的结束时刻（本地）
fn last_ok_local(task: &Schedule) -> Option<NaiveDateTime> {
    task.history
        .iter()
        .find(|r| r.status == "ok")
        .and_then(|r| parse_last_run_local(r.finished_at.as_deref().or(Some(r.at.as_str()))))
}

/// 追加在任务说明后的「本轮时间」与附言（补跑时告诉 Agent 原定时刻；Claude 桌面版只建议用户
/// 自己在提示词里写护栏，这里由 Mesa 直接写进去）
fn run_context_prompt(
    ctx: &RunContext,
    now: NaiveDateTime,
    last_ok: Option<NaiveDateTime>,
) -> String {
    let mut out = String::from("\n\n【本轮时间】");
    match (ctx.trigger.as_str(), ctx.slot) {
        ("catchup", Some(slot)) => out.push_str(&format!(
            "这是补跑：原定 {}，实际 {} 才开始（{}）。",
            human_time(slot),
            human_time(now),
            skip_reason_text(ctx.missed_reason.unwrap_or("missed"))
        )),
        ("schedule", Some(slot)) => out.push_str(&format!(
            "原定 {}，实际 {} 开始。",
            human_time(slot),
            human_time(now)
        )),
        _ => out.push_str(&format!("这是用户手动立即跑，开始于 {}。", human_time(now))),
    }
    match last_ok {
        Some(t) => out.push_str(&format!(
            "上一次成功运行在 {}；技能规范没另定时间窗时，以它为起点取新内容。",
            human_time(t)
        )),
        None => out.push_str("这是第一次成功运行。"),
    }
    if let Some(note) = ctx.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        out.push_str("\n\n【这次的附加说明（用户写的）】");
        out.push_str(note);
    }
    out
}

// ===== 跑的时候不让电脑睡（2026-10-23） =====

/// 只在一次定时运行期间阻止系统空闲睡眠：macOS 起 caffeinate（-w 绑 Mesa 进程，Mesa 退了它也退），
/// Windows 用 SetThreadExecutionState（只对调用线程生效——execute_one 整轮在同一个阻塞线程上）。
/// 合盖、手动睡眠照样会睡；也不会把睡着的电脑叫醒。
struct AwakeGuard {
    #[cfg(target_os = "macos")]
    child: Option<std::process::Child>,
}

impl AwakeGuard {
    #[cfg(target_os = "macos")]
    fn hold() -> Self {
        let mut cmd = crate::process::background_command("/usr/bin/caffeinate");
        cmd.args(["-i", "-w", &std::process::id().to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        Self {
            child: cmd.spawn().ok(),
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn hold() -> Self {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::Power::{
                SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
            };
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
        }
        Self {}
    }
}

impl Drop for AwakeGuard {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}

fn error_payload(id: &str, summary: String) -> RunDonePayload {
    RunDonePayload {
        schedule_id: id.to_string(),
        project_root: String::new(),
        schedule_name: "定时任务".into(),
        skill: String::new(),
        new_entries: None,
        status: "error".into(),
        summary,
        artifacts: Vec::new(),
        noop: false,
        auto_paused: None,
    }
}

/// 执行一条任务并回填历史，返回事件载荷。失败（进程错误/超时/解析不到 profile/
/// 找不到二进制/项目目录不存在）同样记 history（status="error"）。
/// 绝不真的在测试里调用（会拉起 CLI）。
fn execute_one(id: &str, ctx: RunContext) -> RunDonePayload {
    let _awake = AwakeGuard::hold();
    let started_at = crate::sessions::now_iso();
    let path = match schedules_path() {
        Ok(p) => p,
        Err(e) => return error_payload(id, e),
    };
    let task = {
        let _g = match sched_lock() {
            Ok(g) => g,
            Err(error) => return error_payload(id, error),
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
        return error_payload(id, format!("定时任务不存在: {id}"));
    };
    // 补跑之前还错过的几次记一行「已跳过」（合并成一行，悬停看原因）
    if ctx.missed > 0 {
        if let Some(prev) = ctx.slot.and_then(|s| prev_slot(Cadence::of(&task), s)) {
            if let Err(e) = record_skip(
                id,
                ctx.missed_reason.unwrap_or("missed"),
                prev,
                ctx.missed,
                false,
            ) {
                crate::logbuf::record("warn", "scheduler", &format!("记错过次数失败: {e}"));
            }
        }
    }
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
        } else {
            seed_memory(Path::new(&task.project_root), &path, &task.id)?;
        }
        Ok(path)
    });
    // 「本次改了哪些文件」从播种之后算起：每轮播种都会改写台账与只读种子，不能算成巡检产物
    let artifacts_since = std::time::SystemTime::now();
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
    // 钉住的连接已被删：这次照常记失败，并把任务自动暂停（不在无人确认时换一家出站）
    let mut connection_missing = false;
    // 冻结证据里这轮改了几个可采纳文件（通用巡检据此判「无新内容」）
    let mut changed_files: Option<usize> = None;
    let timeout = Duration::from_secs(u64::from(effective_timeout_minutes(&task)) * 60);
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
        if let Some(pid) = pinned.as_deref() {
            connection_missing = !profiles.iter().any(|p| p.id == pid);
        }
        // 未钉连接先按项目默认（解析塔 L4 未钉 → L2）；项目没设默认、或默认那家不能无头写盘，
        // 才回落既有自动链（设置页 AI 专用配置 → 最近用过的连接），并在运行历史里说一句
        let project_pick = if pinned.is_none() {
            pick_project_default(
                &profiles,
                crate::projects::project_default_prefs(Path::new(&task.project_root)).as_ref(),
                headless_write_block_reason,
            )
        } else {
            ProjectDefaultPick::Unset
        };
        let (profile, project_model) = match project_pick {
            ProjectDefaultPick::Use(profile, model) => (profile, Some(model)),
            other => {
                if let ProjectDefaultPick::Skip(note) = other {
                    model_note.push_str(&note);
                }
                let resolved = crate::ai::resolve_profile_from(
                    profiles,
                    pinned.clone(),
                    None,
                    dedicated.clone(),
                    &hidden,
                );
                match resolved {
                    Ok(profile) => (profile, None),
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
                }
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
        } else if let Some(project_model) = project_model {
            // 走项目默认：用名册里给这家点选的模型（还在名单里），否则名单第一——与前端 projectAgentLaunch 同口径
            crate::ai::pick_listed_model(&profile.models, project_model.as_deref())
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
        let mut task_prompt = build_task_prompt(&task.skill);
        if !is_lit_watch {
            if let Some(line) = memory_prompt_line(root, &task.id) {
                task_prompt.push_str(&line);
            }
        }
        task_prompt.push_str(&run_context_prompt(
            &ctx,
            Local::now().naive_local(),
            last_ok_local(&task),
        ));
        if let Some(note) = codex_win_unelevated_note(&profile.agent, root) {
            task_prompt.push_str(&note);
        }
        crate::ai::run_agent_task(
            &profile,
            model.as_deref(),
            &task_prompt,
            root,
            timeout,
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
            let changed = crate::watch_review::freeze_at(
                &crate::watch_review::review_dir()?,
                evidence,
                root,
                &patterns,
            )
            .map_err(|e| format!("任务执行完成，但冻结产物证据失败，未开放自动采纳：{e}"))?;
            changed_files = Some(changed);
            Ok(output)
        })
    })();
    // Run 已创建但在 CLI 进入 ai.rs 前失败（例如技能未分发）时，补齐失败终态。
    if result.is_err() {
        if let Some(id) = run_id.as_deref() {
            if let Ok(Some(run)) = crate::runs::run_get_sync(id.to_string()) {
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
            artifacts_since,
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
    let noop = status == "ok" && is_noop(is_lit_watch, new_entries, changed_files);
    // 这次的后台对话（看过程用）：Run 收尾时由 ai.rs 记下会话 id
    let (agent, session_id) = run_id
        .as_deref()
        .and_then(|id| crate::runs::run_get_sync(id.to_string()).ok().flatten())
        .map(|run| (Some(run.agent).filter(|a| a != "scheduler"), run.session_id))
        .unwrap_or((None, None));
    let record = RunRecord {
        at: crate::sessions::now_iso(),
        status: status.to_string(),
        summary: summary.clone(),
        new_entries,
        started_at: Some(started_at),
        finished_at: Some(finished_at),
        artifacts: artifacts.clone(),
        run_id,
        isolation_path: actual_isolation,
        agent: session_id.as_ref().and(agent),
        session_id,
        noop,
        scheduled_for: ctx.slot.map(format_slot),
        trigger: Some(ctx.trigger.clone()),
        note: ctx.note.clone(),
        ..Default::default()
    };
    let force_pause = (connection_missing && status == "error").then(|| {
        "绑定的连接已删除，已自动暂停。换一条连接后重新打开开关".to_string()
    });
    let auto_paused = match record_run(id, record, ctx.slot, force_pause) {
        Ok(paused) => paused,
        Err(e) => {
            crate::logbuf::record("error", "scheduler", &format!("回填运行历史失败: {e}"));
            None
        }
    };
    RunDonePayload {
        schedule_id: id.to_string(),
        project_root: task.project_root,
        schedule_name: task.name,
        skill: task.skill,
        new_entries,
        status: status.to_string(),
        summary,
        artifacts,
        noop,
        auto_paused,
    }
}

/// 跑完了但没有新内容：雷达看新命中数；其他巡检看冻结证据里有没有可采纳的改动
fn is_noop(is_lit_watch: bool, new_entries: Option<u32>, changed_files: Option<usize>) -> bool {
    if is_lit_watch {
        new_entries == Some(0)
    } else {
        changed_files == Some(0)
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

/// `scheduler-run-started` 事件载荷：tick/手动拉起即发，前端据此刷新「排队中/运行中」；
/// 补跑（trigger=catchup）时前端另弹一条通知说明原定时刻
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStartedPayload {
    schedule_id: String,
    schedule_name: String,
    project_root: String,
    trigger: String,
    scheduled_for: Option<String>,
    missed: u32,
}

fn emit_started(app: &tauri::AppHandle, payload: RunStartedPayload) {
    if let Err(e) = app.emit("scheduler-run-started", &payload) {
        crate::logbuf::record(
            "warn",
            "scheduler",
            &format!("发送 scheduler-run-started 事件失败: {e}"),
        );
    }
}

/// claim 后读任务（同项目互斥锁的键 + 事件里的名字）。任务在 claim 与执行之间被删则 None。
fn schedule_brief(id: &str) -> Option<(String, String)> {
    let _g = sched_lock().ok()?;
    read_schedules_at(&schedules_path().ok()?)
        .ok()?
        .into_iter()
        .find(|t| t.id == id)
        .map(|t| (t.project_root, t.name))
}

/// 排队中 = 到点该跑（enabled 且 due）但当前没有在跑的 Run。等的是并发上限或同项目
/// 互斥，闸门一过下一 tick 自动接上。list_schedules 出口用，纯函数可测。
fn queued_for_list(s: &Schedule, now: NaiveDateTime, running: bool) -> bool {
    s.enabled && !running && due_slot(Cadence::of(s), last_handled(s), now).is_some()
}

/// 本轮该跑的一条：应跑时刻 + 之前还错过几次
#[derive(Debug, Clone)]
struct DuePlan {
    id: String,
    slot: NaiveDateTime,
    missed: u32,
}

/// 闸门判定（纯函数）：到点了但不跑的原因。no_keywords 不算处理过（订上关键词下一 tick 就跑），
/// unreviewed 算处理过（这个时刻跳过，下一次到点再看）
fn gate_reason(task: &Schedule, has_keywords: impl FnOnce() -> bool) -> Option<(&'static str, bool)> {
    if task.skill == "lit-watch" && !has_keywords() {
        return Some(("no_keywords", false));
    }
    if effective_skip_if_unreviewed(task) && has_unreviewed(task) {
        return Some(("unreviewed", true));
    }
    None
}

/// 收集本轮 due 的任务（enabled、项目还在、未在跑、过了闸门）；没过闸门的记一条「已跳过」
fn collect_due() -> Vec<DuePlan> {
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
    let mut out = Vec::new();
    for t in list.iter().filter(|t| t.enabled) {
        let alive = registered
            .as_ref()
            .map(|keys| keys.iter().any(|k| crate::paths::same_path(k, &t.project_root)))
            .unwrap_or(true);
        if !alive || with_running(|s| s.contains(&t.id)) {
            continue;
        }
        let handled = last_handled(t);
        let Some(slot) = due_slot(Cadence::of(t), handled, now) else {
            continue;
        };
        if let Some((code, mark_handled)) = gate_reason(t, || schedule_has_keywords(t)) {
            if let Err(e) = record_skip(&t.id, code, slot, 1, mark_handled) {
                crate::logbuf::record("warn", "scheduler", &format!("记跳过失败: {e}"));
            }
            continue;
        }
        out.push(DuePlan {
            id: t.id.clone(),
            slot,
            missed: missed_before(Cadence::of(t), slot, handled, now),
        });
    }
    out
}

fn claim_due_after_lock(id: &str, due: &[DuePlan]) -> bool {
    due.iter().any(|candidate| candidate.id == id) && mark_running(id)
}

/// 启动调度引擎（lib.rs setup 里调用一次）：后台线程每 60s 一个 tick，
/// 启动即先跑一轮——天然补跑应用关闭期间错过的任务。due 任务**跨项目并行**执行
/// （2026-10-16 拍板，取代 v3.75 的全串行）：每条任务自己 spawn，同一项目用
/// project_lock 互斥，tick 同时在跑的运行数封顶 MAX_CONCURRENT_TICK_RUNS——
/// 两个闸门没过的任务保持 due，下一 tick 自动重试（界面呈「排队中」）。
/// 用 spawn_blocking + thread::sleep（参照 diagnostics 后台循环），不为一个 sleep 引入 tokio 依赖。
/// 记住本次启动时刻与上一个 tick：应跑时刻早于启动 = 应用没开；两次 tick 隔太久 = 电脑睡过。
pub fn start_scheduler(app: tauri::AppHandle) {
    let app_started = Local::now().naive_local();
    tauri::async_runtime::spawn_blocking(move || {
        let mut prev_tick: Option<NaiveDateTime> = None;
        loop {
            if crate::process::shutting_down() {
                break;
            }
            let now = Local::now().naive_local();
            for plan in collect_due() {
                // 并发上限：满了本轮不再接新任务（break 而非 continue——后面的也一样接不上）
                if TICK_INFLIGHT.load(Ordering::SeqCst) >= MAX_CONCURRENT_TICK_RUNS {
                    break;
                }
                let id = plan.id.clone();
                let lease = match execution_lock(&id) {
                    Ok(lease) => lease,
                    Err(error) => {
                        crate::logbuf::record("warn", "scheduler", &error);
                        continue;
                    }
                };
                // 到期集合排除 RUNNING：必须在本进程登记前重查，否则会把自己过滤掉。
                if !claim_due_after_lock(&id, &collect_due()) {
                    continue;
                }
                let Some((project, name)) = schedule_brief(&id) else {
                    // claim 与执行之间任务被删：不执行也不报事件（任务已不存在）
                    unmark_running(&id);
                    continue;
                };
                // 同项目互斥：锁被占说明这个项目另一条雷达在跑，本轮让位、保持 due
                let project_lease = match project_lock(&project) {
                    Ok(lock) => lock,
                    Err(_) => {
                        unmark_running(&id);
                        continue;
                    }
                };
                let (trigger, reason) = classify_trigger(plan.slot, app_started, prev_tick, now);
                let ctx = RunContext {
                    trigger: trigger.into(),
                    slot: Some(plan.slot),
                    missed: plan.missed,
                    missed_reason: reason.or((plan.missed > 0).then_some("missed")),
                    note: None,
                };
                let started = RunStartedPayload {
                    schedule_id: id.clone(),
                    schedule_name: name,
                    project_root: project,
                    trigger: trigger.into(),
                    scheduled_for: Some(format_slot(plan.slot)),
                    missed: plan.missed,
                };
                TICK_INFLIGHT.fetch_add(1, Ordering::SeqCst);
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    emit_started(&app2, started);
                    let id2 = id.clone();
                    let outcome = tauri::async_runtime::spawn_blocking(move || {
                        let _lease = lease;
                        let _project_lease = project_lease;
                        execute_one(&id2, ctx)
                    })
                    .await;
                    TICK_INFLIGHT.fetch_sub(1, Ordering::SeqCst);
                    unmark_running(&id);
                    match outcome {
                        Ok(payload) => emit_done(&app2, payload),
                        Err(e) => {
                            crate::logbuf::record(
                                "error",
                                "scheduler",
                                &format!("任务执行线程异常: {e}"),
                            );
                        }
                    }
                });
            }
            prev_tick = Some(now);
            std::thread::sleep(TICK_INTERVAL);
        }
    });
}

// ===== Tauri commands =====

#[tauri::command]
pub async fn list_schedules() -> Result<Vec<ScheduleDto>, String> {
    tauri::async_runtime::spawn_blocking(list_schedules_sync)
        .await
        .map_err(|e| e.to_string())?
}
fn list_schedules_sync() -> Result<Vec<ScheduleDto>, String> {
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
    let runs = crate::runs::run_list_sync(None)?;
    let now = Local::now().naive_local();
    Ok(list
        .into_iter()
        .map(|schedule| {
            let running = runs.iter().any(|r| {
                r.task_ref.as_deref() == Some(&schedule.id)
                    && r.task_kind == "watch"
                    && crate::process::capture_active(&r.id)
            });
            let queued = queued_for_list(&schedule, now, running);
            let next = schedule
                .enabled
                .then(|| next_slot(Cadence::of(&schedule), now))
                .flatten()
                .map(format_slot);
            let mut dto = ScheduleDto::from(schedule);
            dto.next_run_at = next;
            if running {
                dto.running_run_id = runs
                    .iter()
                    .find(|r| {
                        r.task_ref.as_deref() == Some(&dto.id)
                            && r.task_kind == "watch"
                            && crate::process::capture_active(&r.id)
                    })
                    .map(|r| r.id.clone());
            }
            dto.queued = queued;
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

/// 在后台线程删：隔离 worktree 走系统回收站（macOS 经 Finder，几秒）还带重试，
/// 放主线程上终端会跟着停住（见 conventions/terminal.md「会等待的命令不占主线程」）
#[tauri::command]
pub async fn delete_schedule(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_schedule_sync(id))
        .await
        .map_err(|e| format!("删除定时任务失败: {e}"))?
}

fn delete_schedule_sync(id: String) -> Result<(), String> {
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
    // 关键词 / 跨轮记忆跟着任务走：日程删了，`.ccode/watch/<id>/` 整个目录也删
    crate::lit_watch::delete_schedule_subscriptions(&removed.project_root, &removed.id);
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
    // 家目录可换位置：任务的隔离树可能留在旧位置，各根都找
    for watch_root in crate::ccode_home::all_sub("watch-worktrees") {
        let worktree = watch_root.join(repo_name).join(&task.id);
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
/// 冻结证据是整个目录，在后台线程删（见 conventions/terminal.md「会等待的命令不占主线程」）
#[tauri::command]
pub async fn schedule_run_delete(
    run_id: Option<String>,
    schedule_id: Option<String>,
    at: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || schedule_run_delete_sync(run_id, schedule_id, at))
        .await
        .map_err(|e| format!("删除运行记录失败: {e}"))?
}

fn schedule_run_delete_sync(
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
pub async fn cancel_schedule_run(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cancel_schedule_run_sync(id))
        .await
        .map_err(|e| e.to_string())?
}
fn cancel_schedule_run_sync(id: String) -> Result<(), String> {
    for run_id in crate::process::active_capture_ids() {
        if let Some(run) = crate::runs::run_get_sync(run_id.clone())? {
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

/// 立即触发一次（不等结果）：走同一执行路径与防重入集合，结果经 scheduler-run-done 事件回前端。
/// note = 这次的附言（只进这一轮的任务说明，不改任务本身；最长 500 字）
#[tauri::command]
pub fn run_schedule_now(
    app: tauri::AppHandle,
    id: String,
    note: Option<String>,
) -> Result<(), String> {
    let note = note
        .map(|n| n.trim().chars().take(NOTE_CAP).collect::<String>())
        .filter(|n| !n.is_empty());
    let (project, name) = {
        let _g = sched_lock()?;
        let list = read_schedules_at(&schedules_path()?)?;
        let task = list
            .iter()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("定时任务不存在: {id}"))?;
        if task.skill == "lit-watch" && !schedule_has_keywords(task) {
            return Err("先给这个巡检添加关键词，再立即运行".into());
        }
        (task.project_root.clone(), task.name.clone())
    };
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
    // 手动运行不占 tick 并发上限，但同项目互斥同样生效（并行写同一份台账会坏账）
    let project_lease = match project_lock(&project) {
        Ok(lock) => lock,
        Err(_) => {
            unmark_running(&id);
            return Err("这个项目已有雷达在跑，等它结束或先停止它".into());
        }
    };
    let started = RunStartedPayload {
        schedule_id: id.clone(),
        schedule_name: name,
        project_root: project,
        trigger: "manual".into(),
        scheduled_for: None,
        missed: 0,
    };
    tauri::async_runtime::spawn(async move {
        emit_started(&app, started);
        let id2 = id.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            let _lease = lease;
            let _project_lease = project_lease;
            execute_one(&id2, RunContext::manual(note))
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
    #[serde(default)]
    interval_hours: Option<u8>,
    hour: u8,
    minute: u8,
    profile_id: Option<String>,
    linked_step: Option<String>,
}

/// AI 写技能时顺带建议的周期（`.ccode/drafts/watch-<id>.schedule.json`）。落盘弹层用它预填，人可改
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSuggestion {
    pub frequency: String,
    #[serde(default)]
    pub weekday: Option<u8>,
    #[serde(default)]
    pub interval_hours: Option<u8>,
    #[serde(default)]
    pub hour: u8,
    #[serde(default)]
    pub minute: u8,
    #[serde(default)]
    pub reason: Option<String>,
}

/// 读 AI 写的周期建议；格式不对、值不合法都当没有（落盘弹层回落到建草稿时的默认）
fn read_schedule_suggestion(text: &str) -> Option<ScheduleSuggestion> {
    let s: ScheduleSuggestion = serde_json::from_str(text.trim()).ok()?;
    let freq_ok = matches!(s.frequency.as_str(), "daily" | "weekly" | "weekdays" | "hourly" | "manual");
    let weekday_ok = s.frequency != "weekly" || s.weekday.is_some_and(|d| (1..=7).contains(&d));
    (freq_ok
        && weekday_ok
        && s.hour < 24
        && s.minute < 60
        && validate_extras(&s.frequency, s.interval_hours, None).is_ok())
    .then(|| ScheduleSuggestion {
        reason: s.reason.map(|r| r.trim().chars().take(120).collect()).filter(|r: &String| !r.is_empty()),
        ..s
    })
}

/// 落盘时人确认过的周期（覆盖草稿里的默认）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftScheduleInput {
    pub frequency: String,
    pub weekday: Option<u8>,
    #[serde(default)]
    pub interval_hours: Option<u8>,
    pub hour: u8,
    pub minute: u8,
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
    pub interval_hours: Option<u8>,
    pub hour: u8,
    pub minute: u8,
    pub profile_id: Option<String>,
    pub linked_step: Option<String>,
    pub draft_rel_path: String,
    /// AI 写周期建议的位置（种子 prompt 里给出）
    pub schedule_rel_path: String,
    pub has_draft: bool,
    pub draft_text: Option<String>,
    pub suggestion: Option<ScheduleSuggestion>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWatchSkillInput {
    pub project_root: String,
    pub name: String,
    pub intent: String,
    pub frequency: String,
    pub weekday: Option<u8>,
    #[serde(default)]
    pub interval_hours: Option<u8>,
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

fn watch_schedule_rel(id: &str) -> String {
    format!(".ccode/drafts/watch-{id}.schedule.json")
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
    let schedule_rel = watch_schedule_rel(&p.id);
    let suggestion = drafts_path(root, &schedule_rel)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|t| read_schedule_suggestion(&t));
    WatchSkillDraftDto {
        id: p.id,
        name: p.name,
        skill_name: p.skill_name,
        intent: p.intent,
        frequency: p.frequency,
        weekday: p.weekday,
        interval_hours: p.interval_hours,
        hour: p.hour,
        minute: p.minute,
        profile_id: p.profile_id,
        linked_step: p.linked_step,
        draft_rel_path: rel,
        schedule_rel_path: schedule_rel,
        has_draft: text.is_some(),
        draft_text: text,
        suggestion,
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
    validate_extras(&input.frequency, input.interval_hours, None)?;
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
        interval_hours: (input.frequency == "hourly").then_some(input.interval_hours).flatten(),
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
pub async fn list_watch_skill_drafts(project_root: String) -> Result<Vec<WatchSkillDraftDto>, String> {
    tauri::async_runtime::spawn_blocking(move || list_watch_skill_drafts_sync(project_root))
        .await
        .map_err(|e| e.to_string())?
}
fn list_watch_skill_drafts_sync(project_root: String) -> Result<Vec<WatchSkillDraftDto>, String> {
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
    if let Ok(p) = drafts_path(&root, &watch_schedule_rel(&id)) {
        let _ = fs::remove_file(p);
    }
    fs::remove_file(&meta).map_err(|e| format!("删除草稿失败: {e}"))
}

#[tauri::command]
pub async fn commit_watch_skill_draft(
    project_root: String,
    id: String,
    draft_text: Option<String>,
    schedule: Option<DraftScheduleInput>,
) -> Result<ScheduleDto, String> {
    tauri::async_runtime::spawn_blocking(move || commit_watch_skill_draft_sync(project_root, id, draft_text, schedule))
        .await
        .map_err(|e| e.to_string())?
}
fn commit_watch_skill_draft_sync(
    project_root: String,
    id: String,
    draft_text: Option<String>,
    schedule: Option<DraftScheduleInput>,
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
    // 周期：人在落盘弹层确认的 > 建草稿时的默认。先校验再入库，周期不合法不留半截技能
    let cadence = match schedule {
        Some(s) => s,
        None => DraftScheduleInput {
            frequency: pending.frequency.clone(),
            weekday: pending.weekday,
            interval_hours: pending.interval_hours,
            hour: pending.hour,
            minute: pending.minute,
        },
    };
    validate_fields(
        &root.to_string_lossy(),
        &cadence.frequency,
        cadence.weekday,
        cadence.hour,
        cadence.minute,
    )?;
    validate_extras(&cadence.frequency, cadence.interval_hours, None)?;
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
            frequency: cadence.frequency,
            weekday: cadence.weekday,
            interval_hours: cadence.interval_hours,
            hour: cadence.hour,
            minute: cadence.minute,
            skip_if_unreviewed: None,
            timeout_minutes: None,
        },
    )?;
    for rel in [watch_draft_rel(&id), watch_schedule_rel(&id)] {
        if let Ok(p) = drafts_path(&root, &rel) {
            let _ = fs::remove_file(p);
        }
    }
    let _ = fs::remove_file(meta_path);
    Ok(ScheduleDto::from(created))
}

/// 给已有巡检技能补分发（创建任务或改连接时）。lit-watch 不处理。
#[tauri::command]
pub async fn ensure_schedule_skill_distributed(
    skill: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_schedule_skill_distributed_sync(skill, profile_id))
        .await
        .map_err(|e| e.to_string())?
}
fn ensure_schedule_skill_distributed_sync(
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

    /// flock 属于打开文件描述，别的测试线程此刻 fork 出的子进程在 exec 前还抱着一份副本，
    /// drop 后锁最多晚几毫秒才真正放开（CI 上偶发）。有界重试，不断言具体耗时
    fn lock_released(mut try_acquire: impl FnMut() -> bool) -> bool {
        for _ in 0..100 {
            if try_acquire() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        false
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
            ..Default::default()
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
                ..Default::default()
            }],
            ..Default::default()
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
                interval_hours: None,
                skip_if_unreviewed: None,
                timeout_minutes: None,
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
        // lit-watch 专用文案一字不动（回归钉死；2026-10-16 拍板两批修订：下载硬时间盒 + 关联推荐/OA 直链）
        assert_eq!(
            build_task_prompt("lit-watch"),
            "请使用 lit-watch 技能执行一次文献巡检：按 papers/watchlist.md 的订阅清单检索新文献，并按规范跑关联推荐通道，去重、精选后把命中追加到 notes/inbox.md。追加本次条目前必须先单独写一行 <!-- watch-run: YYYY-MM-DD -->（本次巡检的本地日期，上海时区），已有批次标记的旧条目不要改。免费全文按规范以 OpenAlex 的 best_oa_location.pdf_url、arXiv /pdf/ 直链或 .pdf 结尾直链为准，在结束前用 curl 下到项目根 papers/，文件名用标题，并确认以 %PDF- 开头；下载带硬时间盒：每篇 curl 加 --max-time 60，全部下载合计不超过 5 分钟，到点放弃、残文件删掉、题录留在 papers/watch-followup.md，同一链接不重试；出版商页、DOI 落地页和付费墙不要下。不要写 papers/included.md、notes/index.json 或 references.bib——雷达文献是项目的日常积累，精读与引文库由人发起检索/科研流程后才动。结束时输出三行以内的简报（检索了几条关键词/来源、关联推荐是否跑/命中几篇、新命中几篇、其中推荐几篇、哪些来源未达、免费全文下了几篇）。本任务由 Mesa 定时雷达自动触发。"
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
            interval_hours: None,
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
        let old = "<!-- watch-run: 2026-10-12 -->\n\n## old\n- 来源：期刊 — 2026-10-11 — 10.1/old\n";
        std::fs::write(project.join("papers/watchlist.md"), "kw\n").unwrap();
        std::fs::write(project.join("notes/inbox.md"), old).unwrap();
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
        let after = format!(
            "{old}\n<!-- watch-run: 2026-10-13 -->\n\n## new\n- 来源：期刊 — 2026-10-12 — 10.1/new\n"
        );
        std::fs::write(isolation.join("notes/inbox.md"), &after).unwrap();
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
            &[],
        )
        .unwrap();
        assert!(copied.iter().any(|p| p == "notes/inbox.md"));
        assert_eq!(std::fs::read_to_string(project.join("notes/inbox.md")).unwrap(), after);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn seeding_mirrors_main_every_run_and_unions_seen() {
        // 2026-10-17 审查修复：每轮以主仓为真源重播种（旧口径「隔离树没有才拷」一旦分叉永不再对齐）
        let root = std::env::temp_dir().join(format!("ccode-watch-mirror-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        let isolation = root.join("iso");
        for dir in [&project, &isolation] {
            std::fs::create_dir_all(dir.join("papers")).unwrap();
            std::fs::create_dir_all(dir.join("notes")).unwrap();
        }
        std::fs::write(project.join("notes/inbox.md"), "main inbox\n").unwrap();
        std::fs::write(isolation.join("notes/inbox.md"), "stale inbox\n").unwrap();
        // 主仓没有跟进清单：隔离树旧副本删掉
        std::fs::write(isolation.join("papers/watch-followup.md"), "stale\n").unwrap();
        std::fs::write(project.join("papers/watch-seen.md"), "10.1/a\n10.1/b\n").unwrap();
        std::fs::write(isolation.join("papers/watch-seen.md"), "10.1/a\n10.1/unadopted\n").unwrap();
        // 关联推荐的种子：流程正典与积累账的只读副本
        std::fs::write(project.join("papers/included.json"), "[1]").unwrap();
        std::fs::write(project.join("papers/reading-list.md"), "积累\n").unwrap();
        std::fs::write(isolation.join("papers/included.json"), "[old]").unwrap();
        seed_watch_isolation(&project, &isolation).unwrap();
        let read = |rel: &str| std::fs::read_to_string(isolation.join(rel)).unwrap();
        assert_eq!(read("notes/inbox.md"), "main inbox\n");
        assert!(!isolation.join("papers/watch-followup.md").exists());
        assert_eq!(read("papers/watch-seen.md"), "10.1/a\n10.1/b\n10.1/unadopted\n");
        assert_eq!(read("papers/included.json"), "[1]");
        assert_eq!(read("papers/reading-list.md"), "积累\n");
        // 再播一次幂等
        seed_watch_isolation(&project, &isolation).unwrap();
        assert_eq!(read("papers/watch-seen.md"), "10.1/a\n10.1/b\n10.1/unadopted\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_seen_text_keeps_main_then_isolation_only_lines() {
        assert_eq!(merge_seen_text(None, None), None);
        assert_eq!(merge_seen_text(Some("a"), None).as_deref(), Some("a"));
        assert_eq!(merge_seen_text(None, Some("b\n")).as_deref(), Some("b\n"));
        assert_eq!(merge_seen_text(Some("a"), Some("a\n\nb\nb\n")).as_deref(), Some("a\nb\n"));
    }

    fn test_profile(id: &str, agent: &str, models: &[&str]) -> crate::profiles::Profile {
        serde_json::from_value(serde_json::json!({
            "id": id, "agent": agent, "name": id, "models": models, "hasKey": true,
        }))
        .unwrap()
    }

    #[test]
    fn unpinned_schedule_follows_project_default() {
        let profiles = vec![
            test_profile("c1", "claude-code", &["opus", "sonnet"]),
            test_profile("c2", "claude-code", &["sonnet"]),
            test_profile("q1", "qwen-code", &[]),
        ];
        let never = |_: &str| None;
        assert!(matches!(
            pick_project_default(&profiles, None, never),
            ProjectDefaultPick::Unset
        ));
        // 绑定连接还在：用它，带名册点选的模型
        let prefs = crate::projects::ProjectDefaultPrefs {
            agent: "claude-code".into(),
            profile: Some("c2".into()),
            model: Some("sonnet".into()),
        };
        match pick_project_default(&profiles, Some(&prefs), never) {
            ProjectDefaultPick::Use(p, model) => {
                assert_eq!(p.id, "c2");
                assert_eq!(model.as_deref(), Some("sonnet"));
            }
            _ => panic!("应按项目默认"),
        }
        // 绑定连接被删：该 Agent 第一条（与前端 projectAgentLaunch 同口径）
        let gone = crate::projects::ProjectDefaultPrefs {
            profile: Some("deleted".into()),
            ..prefs
        };
        assert!(matches!(
            pick_project_default(&profiles, Some(&gone), never),
            ProjectDefaultPick::Use(p, _) if p.id == "c1"
        ));
        // 默认那家不能无头写盘 / 没有连接：回落自动链并说明
        let qwen = crate::projects::ProjectDefaultPrefs {
            agent: "qwen-code".into(),
            profile: None,
            model: None,
        };
        let block = |agent: &str| (agent == "qwen-code").then(|| "未验证".to_string());
        assert!(matches!(
            pick_project_default(&profiles, Some(&qwen), block),
            ProjectDefaultPick::Skip(note) if note.contains("未验证")
        ));
        let none = crate::projects::ProjectDefaultPrefs {
            agent: "codex".into(),
            profile: None,
            model: None,
        };
        assert!(matches!(
            pick_project_default(&profiles, Some(&none), never),
            ProjectDefaultPick::Skip(note) if note.contains("codex")
        ));
    }

    #[test]
    fn flow_canon_and_internal_paths_are_denied_for_radar_adoption() {
        for rel in [
            "papers/included.md",
            "Papers/Included.json",
            "notes/index.json",
            "references.bib",
            "manuscript/draft.md",
            ".ccode/project.toml",
            "./outline.md",
        ] {
            assert!(watch_path_denied(rel), "{rel}");
        }
        for rel in [
            "notes/inbox.md",
            "papers/watch-seen.md",
            "notes/references.bib",
            "results/summary.md",
        ] {
            assert!(!watch_path_denied(rel), "{rel}");
        }
    }

    fn plan(id: &str) -> DuePlan {
        DuePlan {
            id: id.to_string(),
            slot: dt(ymd(2026, 10, 23), 9, 0),
            missed: 0,
        }
    }

    #[test]
    fn scheduler_rechecks_due_before_marking_itself_running() {
        let id = uuid::Uuid::new_v4().to_string();
        assert!(!claim_due_after_lock(&id, &[]));
        assert!(claim_due_after_lock(&id, &[plan(&id)]));
        assert!(!claim_due_after_lock(&id, &[plan(&id)]));
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
        assert!(lock_released(|| execution_lock_at(&dir, "same schedule").is_ok()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn project_lock_excludes_same_project_not_others() {
        let dir = tmp_schedules_path("project-lock");
        fs::create_dir_all(&dir).unwrap();
        let first = project_lock_at(&dir, "/tmp/proj-a").unwrap();
        // 同一项目第二条雷达：互斥；不同项目：各自可入
        assert!(project_lock_at(&dir, "/tmp/proj-a").is_err());
        assert!(project_lock_at(&dir, "/tmp/proj-b").is_ok());
        drop(first);
        assert!(lock_released(|| project_lock_at(&dir, "/tmp/proj-a").is_ok()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn queued_marks_due_enabled_idle_tasks_only() {
        use chrono::TimeZone;
        // last_run_at 经 parse_last_run_local 落到本地时区——用 Local 构造时间戳，
        // 断言才不随 runner 时区漂移（sample_task 应跑时刻 = 每天 08:00 本地）
        let now = NaiveDate::from_ymd_opt(2026, 10, 16)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap();
        // 从没跑过、已过应跑时刻 → 排队中
        let due = sample_task("q-due", "/tmp/x");
        assert!(queued_for_list(&due, now, false));
        // 今天 09:30 已跑（晚于 08:00 应跑时刻）→ 不排
        let mut ran_today = due.clone();
        ran_today.last_run_at =
            Some(Local.with_ymd_and_hms(2026, 10, 16, 9, 30, 0).unwrap().to_rfc3339());
        assert!(!queued_for_list(&ran_today, now, false));
        // 到点但在跑 → 不排（运行中另有标记）
        assert!(!queued_for_list(&due, now, true));
        // 停用的任务到点也不排
        let mut disabled = due.clone();
        disabled.enabled = false;
        assert!(!queued_for_list(&disabled, now, false));
        // 还没到今天的应跑时刻（07:59，今天 07:00 跑过）→ 不排
        let before_now = NaiveDate::from_ymd_opt(2026, 10, 16)
            .unwrap()
            .and_hms_opt(7, 59, 0)
            .unwrap();
        let mut ran_earlier_today = due.clone();
        ran_earlier_today.last_run_at =
            Some(Local.with_ymd_and_hms(2026, 10, 16, 7, 0, 0).unwrap().to_rfc3339());
        assert!(!queued_for_list(&ran_earlier_today, before_now, false));
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
                ..Default::default()
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
                ..Default::default()
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
                ..Default::default()
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
            ..Default::default()
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
                ..Default::default()
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
                ..Default::default()
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
    fn codex_unelevated_note_names_worktree_and_absolute_paths() {
        let line = codex_unelevated_prompt_line(Path::new("/x/watch-worktrees/abc"));
        assert!(line.contains("绝对路径") && line.contains("watch-worktrees"), "{line}");
        // 不是 Windows 或不是 Codex：不加
        assert_eq!(codex_win_unelevated_note("claude-code", Path::new("/x")), None);
        #[cfg(not(windows))]
        assert_eq!(codex_win_unelevated_note("codex", Path::new("/x")), None);
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

    // ===== 2026-10-23 定时任务完善 =====

    fn cad<'a>(frequency: &'a str, weekday: Option<u8>, n: Option<u8>, h: u8, m: u8) -> Cadence<'a> {
        Cadence {
            frequency,
            weekday,
            interval_hours: n,
            hour: h,
            minute: m,
        }
    }

    #[test]
    fn weekdays_skip_saturday_and_sunday() {
        let c = cad("weekdays", None, None, 9, 0);
        // 周一 08:00：最近一个是上周五 09:00
        assert_eq!(
            latest_slot(c, dt(ymd(2026, 10, 26), 8, 0)),
            Some(dt(ymd(2026, 10, 23), 9, 0))
        );
        // 周日整天：仍是周五
        assert_eq!(
            latest_slot(c, dt(ymd(2026, 10, 25), 22, 0)),
            Some(dt(ymd(2026, 10, 23), 9, 0))
        );
        // 周三 10:00：当天
        assert_eq!(
            latest_slot(c, dt(ymd(2026, 10, 21), 10, 0)),
            Some(dt(ymd(2026, 10, 21), 9, 0))
        );
        // 周五 10:00 之后下一次是下周一
        assert_eq!(
            next_slot(c, dt(ymd(2026, 10, 23), 10, 0)),
            Some(dt(ymd(2026, 10, 26), 9, 0))
        );
    }

    #[test]
    fn hourly_slots_and_day_boundary() {
        let c = cad("hourly", None, Some(6), 0, 15);
        // 6 小时一次，在 :15 → 00:15 06:15 12:15 18:15
        assert_eq!(
            latest_slot(c, dt(ymd(2026, 10, 23), 13, 0)),
            Some(dt(ymd(2026, 10, 23), 12, 15))
        );
        // 00:10 还没到当天第一个：昨天 18:15
        assert_eq!(
            latest_slot(c, dt(ymd(2026, 10, 23), 0, 10)),
            Some(dt(ymd(2026, 10, 22), 18, 15))
        );
        assert_eq!(
            next_slot(c, dt(ymd(2026, 10, 23), 18, 20)),
            Some(dt(ymd(2026, 10, 24), 0, 15))
        );
        // 每小时
        let every = cad("hourly", None, Some(1), 0, 0);
        assert_eq!(
            prev_slot(every, dt(ymd(2026, 10, 23), 0, 0)),
            Some(dt(ymd(2026, 10, 22), 23, 0))
        );
    }

    #[test]
    fn manual_is_never_due() {
        let c = cad("manual", None, None, 9, 0);
        let now = dt(ymd(2026, 10, 23), 12, 0);
        assert_eq!(latest_slot(c, now), None);
        assert_eq!(next_slot(c, now), None);
        assert_eq!(due_slot(c, None, now), None);
    }

    #[test]
    fn skipped_slot_counts_as_handled() {
        // last_slot_at 晚于最近应跑时刻：不再 due（跳过的时刻不反复到点）
        let mut task = sample_task("t", "/p");
        task.hour = 9;
        let now = dt(ymd(2026, 10, 23), 10, 0);
        assert!(due_slot(Cadence::of(&task), last_handled(&task), now).is_some());
        task.last_slot_at = Some(format_slot(dt(ymd(2026, 10, 23), 9, 0)));
        assert!(due_slot(Cadence::of(&task), last_handled(&task), now).is_none());
        // 存储格式往返
        assert_eq!(
            parse_slot(task.last_slot_at.as_deref()),
            Some(dt(ymd(2026, 10, 23), 9, 0))
        );
    }

    #[test]
    fn missed_counts_only_slots_between_last_and_now_within_a_week() {
        let c = cad("daily", None, None, 9, 0);
        let now = dt(ymd(2026, 10, 23), 11, 0);
        let slot = dt(ymd(2026, 10, 23), 9, 0);
        // 上次跑在 10-20 09:05：错过 21、22 两天，今天这次去补跑
        assert_eq!(
            missed_before(c, slot, Some(dt(ymd(2026, 10, 20), 9, 5)), now),
            2
        );
        // 从没跑过：不算错过
        assert_eq!(missed_before(c, slot, None, now), 0);
        // 一个月没开：只往回数一周
        assert_eq!(
            missed_before(c, slot, Some(dt(ymd(2026, 9, 1), 9, 5)), now),
            6
        );
    }

    #[test]
    fn trigger_classifies_closed_asleep_and_on_time() {
        let started = dt(ymd(2026, 10, 23), 10, 0);
        // 应跑时刻早于启动：应用没开
        assert_eq!(
            classify_trigger(dt(ymd(2026, 10, 23), 9, 0), started, None, started),
            ("catchup", Some("missed_closed"))
        );
        // 两次 tick 隔了两小时、时刻落在中间：电脑睡过
        let prev = dt(ymd(2026, 10, 23), 12, 0);
        let now = dt(ymd(2026, 10, 23), 14, 0);
        assert_eq!(
            classify_trigger(dt(ymd(2026, 10, 23), 13, 0), started, Some(prev), now),
            ("catchup", Some("missed_asleep"))
        );
        // 正常 tick：准点
        let prev = dt(ymd(2026, 10, 23), 12, 59);
        let now = dt(ymd(2026, 10, 23), 13, 0);
        assert_eq!(
            classify_trigger(dt(ymd(2026, 10, 23), 13, 0), started, Some(prev), now),
            ("schedule", None)
        );
    }

    #[test]
    fn skips_merge_by_reason_and_same_slot_is_idempotent() {
        let mut task = sample_task("t", "/p");
        let s1 = dt(ymd(2026, 10, 22), 9, 0);
        let s2 = dt(ymd(2026, 10, 23), 9, 0);
        assert!(apply_skip(&mut task, "unreviewed", s1, 1, true, "a"));
        // 同一时刻再记一次：不变
        assert!(!apply_skip(&mut task, "unreviewed", s1, 1, true, "b"));
        assert!(apply_skip(&mut task, "unreviewed", s2, 1, true, "c"));
        assert_eq!(task.history.len(), 1);
        assert_eq!(task.history[0].skip_count, Some(2));
        assert_eq!(task.history[0].status, "skipped");
        assert_eq!(task.last_slot_at.as_deref(), Some("2026-10-23T09:00:00"));
        // 原因不同另起一行；没有关键词不算处理过
        let before = task.last_slot_at.clone();
        assert!(apply_skip(&mut task, "no_keywords", dt(ymd(2026, 10, 24), 9, 0), 1, false, "d"));
        assert_eq!(task.history.len(), 2);
        assert_eq!(task.last_slot_at, before);
        assert!(task.history[0].summary.contains("还没有关键词"));
    }

    fn rec(status: &str, trigger: &str) -> RunRecord {
        RunRecord {
            at: "2026-10-23T01:00:00Z".into(),
            status: status.into(),
            summary: "AI 调用超时（1800s）\n第二行".into(),
            trigger: Some(trigger.into()),
            ..Default::default()
        }
    }

    #[test]
    fn three_scheduled_failures_auto_pause_and_manual_runs_do_not_count() {
        let mut task = sample_task("t", "/p");
        assert_eq!(apply_run_record(&mut task, rec("error", "schedule"), None, None), None);
        // 手动立即跑失败不计数
        assert_eq!(apply_run_record(&mut task, rec("error", "manual"), None, None), None);
        assert_eq!(task.consecutive_failures, 1);
        assert_eq!(apply_run_record(&mut task, rec("timeout", "catchup"), None, None), None);
        let paused = apply_run_record(&mut task, rec("error", "schedule"), None, None);
        assert!(paused.as_deref().is_some_and(|r| r.contains("连续 3 次")), "{paused:?}");
        assert!(!task.enabled);
        assert!(task.paused_reason.as_deref().unwrap().contains("AI 调用超时（1800s）"));
        assert!(!task.paused_reason.as_deref().unwrap().contains("第二行"));
        // 重新打开：清原因与计数，停用期间的时刻算处理过
        let now = dt(ymd(2026, 10, 23), 10, 0);
        reenable(&mut task, now);
        assert_eq!(task.paused_reason, None);
        assert_eq!(task.consecutive_failures, 0);
        assert!(due_slot(Cadence::of(&task), last_handled(&task), now).is_none());
        // 成功清零
        let mut t2 = sample_task("t2", "/p");
        apply_run_record(&mut t2, rec("error", "schedule"), None, None);
        apply_run_record(&mut t2, rec("ok", "schedule"), None, None);
        assert_eq!(t2.consecutive_failures, 0);
    }

    #[test]
    fn deleted_connection_pauses_at_once() {
        let mut task = sample_task("t", "/p");
        let paused = apply_run_record(
            &mut task,
            rec("error", "schedule"),
            Some(dt(ymd(2026, 10, 23), 9, 0)),
            Some("绑定的连接已删除".into()),
        );
        assert_eq!(paused.as_deref(), Some("绑定的连接已删除"));
        assert!(!task.enabled);
        assert_eq!(task.last_slot_at.as_deref(), Some("2026-10-23T09:00:00"));
        // 已停用的任务（手动跑）不再重复报暂停
        let again = apply_run_record(&mut task, rec("error", "manual"), None, Some("x".into()));
        assert_eq!(again, None);
    }

    #[test]
    fn unreviewed_gate_defaults_by_skill() {
        let mut generic = sample_task("g", "/p");
        generic.skill = "model-check".into();
        assert!(gate_reason(&generic, || true).is_none());
        generic.history.insert(
            0,
            RunRecord {
                status: "ok".into(),
                run_id: Some("r".into()),
                isolation_path: Some("/iso".into()),
                ..Default::default()
            },
        );
        // 升级前的旧记录（没有 trigger）不拦
        assert!(gate_reason(&generic, || true).is_none());
        generic.history[0].trigger = Some("schedule".into());
        assert_eq!(gate_reason(&generic, || true), Some(("unreviewed", true)));
        // 跳过记录不挡判断：看的是最近一次成功运行
        generic.history.insert(
            0,
            RunRecord {
                status: "skipped".into(),
                ..Default::default()
            },
        );
        assert_eq!(gate_reason(&generic, || true), Some(("unreviewed", true)));
        // 无新内容 / 已采纳的不算待评审
        generic.history[1].noop = true;
        assert!(gate_reason(&generic, || true).is_none());
        // 关掉开关就不拦
        generic.history[1].noop = false;
        generic.skip_if_unreviewed = Some(false);
        assert!(gate_reason(&generic, || true).is_none());
        // 雷达默认不拦，没关键词照旧拦（不算处理过）
        let mut radar = sample_task("r", "/p");
        radar.history = generic.history.clone();
        assert!(gate_reason(&radar, || true).is_none());
        assert_eq!(gate_reason(&radar, || false), Some(("no_keywords", false)));
        assert!(effective_skip_if_unreviewed(&sample_task("x", "/p")) == false);
    }

    #[test]
    fn noop_by_skill() {
        assert!(is_noop(true, Some(0), Some(3)));
        assert!(!is_noop(true, Some(2), Some(0)));
        assert!(is_noop(false, None, Some(0)));
        assert!(!is_noop(false, None, Some(1)));
        assert!(!is_noop(false, None, None));
    }

    #[test]
    fn context_prompt_tells_catchup_time_last_ok_and_note() {
        let ctx = RunContext {
            trigger: "catchup".into(),
            slot: Some(dt(ymd(2026, 10, 23), 9, 0)),
            missed: 2,
            missed_reason: Some("missed_asleep"),
            note: Some("  这次重点看 MoE 路由  ".into()),
        };
        let text = run_context_prompt(
            &ctx,
            dt(ymd(2026, 10, 23), 23, 10),
            Some(dt(ymd(2026, 10, 20), 9, 2)),
        );
        assert!(text.contains("这是补跑：原定 10月23日 09:00，实际 10月23日 23:10 才开始（电脑在睡眠）"), "{text}");
        assert!(text.contains("上一次成功运行在 10月20日 09:02"), "{text}");
        assert!(text.contains("【这次的附加说明（用户写的）】这次重点看 MoE 路由"), "{text}");
        let manual = run_context_prompt(&RunContext::manual(None), dt(ymd(2026, 10, 23), 8, 0), None);
        assert!(manual.contains("手动立即跑"));
        assert!(manual.contains("第一次成功运行"));
        assert!(!manual.contains("附加说明"));
    }

    #[test]
    fn extras_validation() {
        assert!(validate_extras("hourly", Some(6), None).is_ok());
        assert!(validate_extras("hourly", Some(5), None).is_err());
        assert!(validate_extras("hourly", None, None).is_err());
        assert!(validate_extras("daily", None, Some(60)).is_ok());
        assert!(validate_extras("daily", None, Some(4)).is_err());
        assert!(validate_extras("daily", None, Some(181)).is_err());
        let dir = std::env::temp_dir();
        let root = dir.to_string_lossy();
        for f in ["weekdays", "hourly", "manual"] {
            assert!(validate_fields(&root, f, None, 9, 0).is_ok(), "{f}");
        }
        let task = Schedule {
            timeout_minutes: Some(60),
            ..sample_task("t", "/p")
        };
        assert_eq!(effective_timeout_minutes(&task), 60);
        assert_eq!(effective_timeout_minutes(&sample_task("t", "/p")), 30);
    }

    #[test]
    fn schedule_suggestion_is_validated() {
        let ok = read_schedule_suggestion(
            r#"{"frequency":"weekdays","hour":8,"minute":30,"reason":"工作日早上看"}"#,
        )
        .unwrap();
        assert_eq!(ok.frequency, "weekdays");
        assert_eq!(ok.reason.as_deref(), Some("工作日早上看"));
        assert!(read_schedule_suggestion(r#"{"frequency":"hourly","intervalHours":6,"minute":0}"#).is_some());
        assert!(read_schedule_suggestion(r#"{"frequency":"hourly","intervalHours":5}"#).is_none());
        assert!(read_schedule_suggestion(r#"{"frequency":"weekly","hour":9}"#).is_none());
        assert!(read_schedule_suggestion(r#"{"frequency":"monthly"}"#).is_none());
        assert!(read_schedule_suggestion("不是 JSON").is_none());
    }

    #[test]
    fn referenced_sessions_come_from_history() {
        let mut task = sample_task("t", "/p");
        task.history = vec![
            RunRecord {
                agent: Some("codex".into()),
                session_id: Some("s1".into()),
                ..Default::default()
            },
            RunRecord {
                session_id: Some("s2".into()),
                ..Default::default()
            },
        ];
        let set = referenced_sessions_of(&[task]);
        assert!(set.contains(&("codex".to_string(), "s1".to_string())));
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn memory_seeds_when_project_copy_is_newer_and_adopts_back() {
        let base = std::env::temp_dir().join(format!("ccode-sched-mem-{}", uuid::Uuid::new_v4()));
        let project = base.join("project");
        let iso = base.join("iso");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&iso).unwrap();
        let id = "0123abcd-0000-0000-0000-000000000000";
        let rel = memory_rel(id).unwrap();
        // 项目没有：不动隔离树
        seed_memory(&project, &iso, id).unwrap();
        assert!(!iso.join(&rel).exists());
        // 项目有、隔离没有：拷进去
        std::fs::create_dir_all(project.join(&rel).parent().unwrap()).unwrap();
        std::fs::write(project.join(&rel), "基线 3\n").unwrap();
        seed_memory(&project, &iso, id).unwrap();
        assert_eq!(std::fs::read_to_string(iso.join(&rel)).unwrap(), "基线 3\n");
        // 隔离那份被巡检更新（更新）：再播种不覆盖
        std::fs::write(iso.join(&rel), "基线 4\n").unwrap();
        // 不靠墙钟：把隔离那份的修改时间显式拨到项目那份之后
        let later = std::fs::metadata(project.join(&rel)).unwrap().modified().unwrap()
            + std::time::Duration::from_secs(10);
        std::fs::File::options().write(true).open(iso.join(&rel)).unwrap().set_modified(later).unwrap();
        seed_memory(&project, &iso, id).unwrap();
        assert_eq!(std::fs::read_to_string(iso.join(&rel)).unwrap(), "基线 4\n");
        // 采纳带回项目；内容相同再采纳不写
        assert!(adopt_memory(&iso, &project, id).unwrap());
        assert_eq!(std::fs::read_to_string(project.join(&rel)).unwrap(), "基线 4\n");
        assert!(!adopt_memory(&iso, &project, id).unwrap());
        // 非法 id 拒绝
        assert!(memory_rel("../x").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}

