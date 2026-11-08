//! 全文代下队列（2026-11-08 拍板，`docs/design-autonomy-roadmap.md` §6）。
//!
//! AI（对话、目标、定时）经 `mesa_helper paper fetch <DOI>` 把要下的文献交进来，Mesa 逐篇去取；人也可以在待获取清单里整批交。
//! 取的顺序：① 开放获取（Unpaywall / OpenAlex 合法副本，不用学校身份）→ ② 学校通道直取（`inst_access::fetch_via_channel`，
//! 按 TLS 指纹拦非浏览器的出版商直接跳过）→ ③ 浏览器扩展在用户自己的浏览器后台标签里取（扩展每分钟来领一篇）。
//!
//! 硬边界（Mesa 执行，不靠 AI 自觉）：
//! - 全局一条队列：后台线程单线程推进，扩展一次只领一篇；跨进程（helper / 主程序）共用 `<config>/paper-fetch/queue.json`，读改写持文件锁。
//! - 经学校身份（②③）的请求按出版商限速：间隔随机、每出版商每天上限、总量每天上限；人可调低，调高有上限（`CEILING`）。
//! - 遇限流 / 验证码 / 真浏览器也被拒：该出版商熔断 24 小时；连续 3 篇失败整条队列暂停，人点「继续」才恢复。
//! - AI 只能下项目清单里有的 DOI（`project_dois`），清单外的等人放行；学校会话不进 Agent 环境，Agent 只拿到落盘文件名。
//! - 每次出门记一行日志（`log.jsonl`，0600），带 runId，Run 事实按它写「这次经哪一级取得了哪些文献」。
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Agent 环境里 helper 的路径（与 MESA_PEEK_TOOL 指向同一个 helper）
pub const TOOL_ENV: &str = "MESA_PAPER_TOOL";

const BLOCK_SECS: i64 = 24 * 3600;
const MAX_FAILS_IN_ROW: u32 = 3;
/// 扩展领走后多久没回话就当它没做完，放回去让下一次来领
const BROWSER_CLAIM_SECS: i64 = 4 * 60;
/// 进了浏览器一级、扩展一直没来领：放弃，交给人
const BROWSER_GIVEUP_SECS: i64 = 30 * 60;
/// 扩展多久内来领过一次算「在」
const EXTENSION_ALIVE_SECS: i64 = 5 * 60;
const KEEP_FINISHED: usize = 400;
const LOG_CAP: u64 = 2 * 1024 * 1024;
const TICK_SECS: u64 = 5;

pub const STATUS_NEEDS_APPROVAL: &str = "needs_approval";
pub const STATUS_QUEUED: &str = "queued";
pub const STATUS_BROWSER: &str = "browser";
pub const STATUS_NEEDS_PICK: &str = "needs_pick";
pub const STATUS_DONE: &str = "done";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_CANCELLED: &str = "cancelled";

const STAGE_OA: &str = "oa";
const STAGE_PUBLISHER: &str = "publisher";
const STAGE_BROWSER: &str = "browser";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub per_publisher_daily: u32,
    pub total_daily: u32,
    pub min_gap_secs: u32,
    pub max_gap_secs: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { per_publisher_daily: 30, total_daily: 80, min_gap_secs: 30, max_gap_secs: 90 }
    }
}

/// 人能调到的最宽：每天的篇数不能再高、间隔不能再短
pub const CEILING: Limits = Limits { per_publisher_daily: 60, total_daily: 150, min_gap_secs: 20, max_gap_secs: 20 };

pub(crate) fn clamp_limits(l: Limits) -> Limits {
    let min_gap = l.min_gap_secs.clamp(CEILING.min_gap_secs, 600);
    Limits {
        per_publisher_daily: l.per_publisher_daily.clamp(1, CEILING.per_publisher_daily),
        total_daily: l.total_daily.clamp(1, CEILING.total_daily),
        min_gap_secs: min_gap,
        max_gap_secs: l.max_gap_secs.clamp(min_gap, 1800),
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub url: String,
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub doi: String,
    pub project_root: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub run_id: Option<String>,
    /// agent / human
    pub requester: String,
    pub status: String,
    #[serde(default)]
    pub stage: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub stage_at: i64,
    /// 落进 papers/ 的文件名
    #[serde(default)]
    pub saved: Option<String>,
    /// oa / institutional / browser
    #[serde(default)]
    pub via: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub candidates: Vec<Candidate>,
    #[serde(default)]
    pub pick: Option<String>,
    #[serde(default)]
    pub claimed_at: Option<i64>,
    /// 还在排队时为什么没动（等间隔 / 到上限 / 熔断 / 暂停），给人和 AI 看
    #[serde(default)]
    pub waiting: Option<String>,
}

impl Job {
    fn finished(&self) -> bool {
        matches!(self.status.as_str(), STATUS_DONE | STATUS_FAILED | STATUS_CANCELLED)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PubState {
    #[serde(default)]
    pub count: u32,
    #[serde(default)]
    pub last_at: i64,
    #[serde(default)]
    pub next_gap: u32,
    #[serde(default)]
    pub blocked_until: i64,
    #[serde(default)]
    pub blocked_reason: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(default)]
    pub day: String,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub publishers: BTreeMap<String, PubState>,
    #[serde(default)]
    pub fails_in_row: u32,
    #[serde(default)]
    pub paused: Option<String>,
    #[serde(default)]
    pub session_expired: bool,
    #[serde(default)]
    pub limits: Option<Limits>,
    #[serde(default)]
    pub extension_seen_at: i64,
}

impl State {
    pub fn limits(&self) -> Limits {
        clamp_limits(self.limits.unwrap_or_default())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default)]
    pub jobs: Vec<Job>,
    #[serde(default)]
    pub state: State,
}

// ===== 出版商 =====

const PUBLISHERS: &[(&str, &str, &str)] = &[
    ("10.1002", "wiley", "Wiley"),
    ("10.1111", "wiley", "Wiley"),
    ("10.1016", "elsevier", "Elsevier"),
    ("10.1021", "acs", "ACS"),
    ("10.1038", "nature", "Nature"),
    ("10.1007", "springer", "Springer"),
    ("10.1186", "springer", "Springer"),
    ("10.1039", "rsc", "RSC"),
    ("10.1126", "science", "Science"),
    ("10.1073", "pnas", "PNAS"),
    ("10.1103", "aps", "APS"),
    ("10.1063", "aip", "AIP"),
    ("10.1088", "iop", "IOP"),
    ("10.1149", "ecs", "ECS"),
    ("10.3390", "mdpi", "MDPI"),
    ("10.1080", "tandf", "Taylor & Francis"),
    ("10.1109", "ieee", "IEEE"),
    ("10.1145", "acm", "ACM"),
    ("10.1093", "oup", "Oxford"),
    ("10.1017", "cup", "Cambridge"),
    ("10.1177", "sage", "SAGE"),
    ("10.1371", "plos", "PLOS"),
    ("10.1146", "annualreviews", "Annual Reviews"),
];

/// 非浏览器客户端一律 403（按 TLS 指纹判，带完整会话也一样，pipeline.md 机构访问通道条）——学校通道直取白白耗配额，直接交浏览器
const BROWSER_ONLY: &[&str] = &["wiley", "elsevier"];

/// 出版商键：已知前缀归到同一家（Wiley 有两个前缀），其余按 DOI 前缀
pub fn publisher_key(doi: &str) -> String {
    let prefix = doi.split('/').next().unwrap_or("").to_ascii_lowercase();
    PUBLISHERS
        .iter()
        .find(|(p, _, _)| *p == prefix)
        .map(|(_, k, _)| k.to_string())
        .unwrap_or(prefix)
}

pub fn publisher_name(key: &str) -> String {
    PUBLISHERS
        .iter()
        .find(|(_, k, _)| *k == key)
        .map(|(_, _, n)| n.to_string())
        .unwrap_or_else(|| key.to_string())
}

fn browser_only(key: &str) -> bool {
    BROWSER_ONLY.contains(&key)
}

// ===== DOI =====

/// 规整成小写裸 DOI；不像 DOI 返回 None
pub fn normalize_doi(raw: &str) -> Option<String> {
    let mut t = raw.trim().trim_matches(|c| c == '<' || c == '>' || c == '"' || c == '\'').to_string();
    for p in ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi.org/", "doi:", "DOI:"] {
        if t.to_ascii_lowercase().starts_with(&p.to_ascii_lowercase()) {
            t = t[p.len()..].trim().to_string();
            break;
        }
    }
    let t = t.trim_end_matches(['.', ',', ';', ')', ']', '}']).to_ascii_lowercase();
    let (prefix, suffix) = t.split_once('/')?;
    let reg = prefix.strip_prefix("10.")?;
    if reg.len() < 4 || reg.len() > 9 || !reg.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    if suffix.is_empty() || suffix.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    Some(t)
}

/// 从一段文字里抠出全部 DOI（小写、去尾标点）
pub fn extract_dois(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(pos) = text[i..].find("10.") {
        let start = i + pos;
        i = start + 3;
        if start > 0 {
            let prev = bytes[start - 1];
            if prev.is_ascii_alphanumeric() || prev == b'.' {
                continue;
            }
        }
        let end = text[start..]
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '|' | '`' | ',' | '，' | '）' | '】' | '。' | '；' | '、'))
            .map(|e| start + e)
            .unwrap_or(text.len());
        if let Some(d) = normalize_doi(&text[start..end]) {
            out.push(d);
        }
        i = end.max(i);
    }
    out
}

/// AI 可以请求代下的范围：项目自己的文献清单里出现过的 DOI（筛选表 screening.md 有排除的，不算）
pub fn project_dois(root: &Path) -> HashSet<String> {
    const FILES: &[&str] = &[
        "papers/included.json",
        "papers/included.md",
        "papers/to-fetch.md",
        "papers/to-fetch.ris",
        "papers/endnote-import.ris",
        "papers/reading-list.md",
        "notes/watch-followup.md",
        "notes/inbox.md",
    ];
    let mut set = HashSet::new();
    for f in FILES {
        let path = root.join(f);
        let Ok(meta) = fs::metadata(&path) else { continue };
        if meta.len() > 8 * 1024 * 1024 {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&path) {
            set.extend(extract_dois(&text));
        }
    }
    set
}

// ===== 存取 =====

fn dir() -> Result<PathBuf, String> {
    crate::storage::config_root()
        .map(|d| d.join("paper-fetch"))
        .ok_or_else(|| "无法确定配置目录".to_string())
}

fn queue_path(d: &Path) -> PathBuf {
    d.join("queue.json")
}

pub(crate) fn log_path() -> Option<PathBuf> {
    dir().ok().map(|d| d.join("log.jsonl"))
}

fn read_store(d: &Path) -> Store {
    match fs::read(queue_path(d)) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(s) => s,
            Err(_) => {
                // 读不懂就留一份原件再从空开始：队列只是待办，丢了最多让人重交，别让一个坏文件把代下整个卡死
                let _ = fs::copy(queue_path(d), d.join("queue.corrupt.json"));
                Store::default()
            }
        },
        Err(_) => Store::default(),
    }
}

/// 持文件锁读改写整份队列；闭包返回 (结果, 是否写回)
pub(crate) fn with_store<R>(f: impl FnOnce(&mut Store) -> (R, bool)) -> Result<R, String> {
    let d = dir()?;
    fs::create_dir_all(&d).map_err(|e| format!("建代下目录失败: {e}"))?;
    let _lock = crate::storage::lock_at(&d.join("queue.lock"))?;
    let mut store = read_store(&d);
    let (out, dirty) = f(&mut store);
    if dirty {
        prune(&mut store);
        let bytes = serde_json::to_vec_pretty(&store).map_err(|e| e.to_string())?;
        crate::storage::atomic_write(&queue_path(&d), &bytes, true)?;
    }
    Ok(out)
}

fn prune(store: &mut Store) {
    let finished = store.jobs.iter().filter(|j| j.finished()).count();
    if finished <= KEEP_FINISHED {
        return;
    }
    let mut drop = finished - KEEP_FINISHED;
    // jobs 按加入顺序存，先删最早结束的
    store.jobs.retain(|j| {
        if drop > 0 && j.finished() {
            drop -= 1;
            false
        } else {
            true
        }
    });
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub at: i64,
    pub doi: String,
    pub publisher: String,
    /// oa / institutional / browser
    pub level: String,
    pub result: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub project: String,
}

fn append_log(entry: &LogEntry) {
    let Some(path) = log_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::metadata(&path).map(|m| m.len() > LOG_CAP).unwrap_or(false) {
        let _ = fs::rename(&path, path.with_extension("jsonl.1"));
    }
    let mut line = serde_json::to_string(entry).unwrap_or_default();
    line.push('\n');
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
}

pub(crate) fn read_log(limit: usize) -> Vec<LogEntry> {
    let Some(path) = log_path() else { return Vec::new() };
    let Ok(text) = fs::read_to_string(&path) else { return Vec::new() };
    let mut out: Vec<LogEntry> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    if out.len() > limit {
        out.drain(..out.len() - limit);
    }
    out
}

/// 这次 Run 经代下取得的文献（Run 事实「出过的门」）：每条「DOI（经 开放获取 / 学校通道 / 浏览器）」
pub(crate) fn fetched_for_run(run_id: &str) -> Vec<String> {
    read_log(5000)
        .into_iter()
        .filter(|e| e.run_id.as_deref() == Some(run_id) && e.result == "ok")
        .map(|e| format!("{}（经{}）", e.doi, level_label(&e.level)))
        .collect()
}

pub fn level_label(level: &str) -> &'static str {
    match level {
        "oa" => "开放获取",
        "institutional" => "学校账号",
        "browser" => "浏览器",
        _ => "其他",
    }
}

fn project_name(root: &str) -> String {
    Path::new(root).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn jitter(min: u32, max: u32) -> u32 {
    if max <= min {
        return min;
    }
    let r = u32::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..4].try_into().unwrap_or([0; 4]));
    min + r % (max - min + 1)
}

// ===== 纯规则（单测直测）=====

/// 跨天清零当天计数（熔断与暂停不随日子清）
pub(crate) fn roll_day(state: &mut State, day: &str) {
    if state.day != day {
        state.day = day.to_string();
        state.total = 0;
        for p in state.publishers.values_mut() {
            p.count = 0;
        }
    }
}

/// 经学校身份去这家出版商要等什么；None = 现在就能去
pub(crate) fn publisher_wait(state: &State, key: &str, now: i64) -> Option<String> {
    if let Some(why) = &state.paused {
        return Some(format!("代下已暂停：{why}"));
    }
    let limits = state.limits();
    if state.total >= limits.total_daily {
        return Some(format!("今天用学校账号已下 {} 篇，到了上限，明天继续", state.total));
    }
    if let Some(p) = state.publishers.get(key) {
        if p.blocked_until > now {
            return Some(format!("{} 暂停到 {}（{}）", publisher_name(key), fmt_time(p.blocked_until), p.blocked_reason));
        }
        if p.count >= limits.per_publisher_daily {
            return Some(format!("{} 今天已下 {} 篇，到了上限，明天继续", publisher_name(key), p.count));
        }
        let ready_at = p.last_at + p.next_gap as i64;
        if p.last_at > 0 && ready_at > now {
            return Some(format!("{} 下一篇约 {} 秒后开始", publisher_name(key), ready_at - now));
        }
    }
    None
}

pub(crate) fn note_request(state: &mut State, key: &str, now: i64) {
    let limits = state.limits();
    state.total += 1;
    let p = state.publishers.entry(key.to_string()).or_default();
    p.count += 1;
    p.last_at = now;
    p.next_gap = jitter(limits.min_gap_secs, limits.max_gap_secs);
}

pub(crate) fn trip(state: &mut State, key: &str, now: i64, reason: &str) {
    let p = state.publishers.entry(key.to_string()).or_default();
    p.blocked_until = now + BLOCK_SECS;
    p.blocked_reason = reason.to_string();
}

/// 记一篇的结局：成功清零；失败累计，到 3 篇整条暂停
pub(crate) fn note_outcome(state: &mut State, ok: bool) {
    if ok {
        state.fails_in_row = 0;
        return;
    }
    state.fails_in_row += 1;
    if state.fails_in_row >= MAX_FAILS_IN_ROW && state.paused.is_none() {
        state.paused = Some(format!("连续 {MAX_FAILS_IN_ROW} 篇没下到"));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChannelFail {
    /// 出版商限流（429）：熔断这家
    Throttled,
    /// 停在学校登录 / SAML 页：会话过期
    SessionExpired,
    /// 其他（含 TLS 指纹 403、找不到 PDF 链接）：交给浏览器一级
    Other,
}

pub(crate) fn classify_channel_error(err: &str) -> ChannelFail {
    let lower = err.to_ascii_lowercase();
    if lower.contains("429") || lower.contains("too many") {
        ChannelFail::Throttled
    } else if err.contains("登录页") || err.contains("SAML") || err.contains("会话可能已过期") {
        ChannelFail::SessionExpired
    } else {
        ChannelFail::Other
    }
}

fn fmt_time(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|t| t.with_timezone(&chrono::Local).format("%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

fn new_job(root: &str, doi: &str, title: &str, run_id: Option<String>, requester: &str, now: i64) -> Job {
    Job {
        id: uuid::Uuid::new_v4().simple().to_string()[..12].to_string(),
        doi: doi.to_string(),
        project_root: root.to_string(),
        title: title.to_string(),
        run_id,
        requester: requester.to_string(),
        status: STATUS_QUEUED.into(),
        stage: STAGE_OA.into(),
        created_at: now,
        updated_at: now,
        stage_at: now,
        ..Default::default()
    }
}

fn requeue(job: &mut Job, now: i64) {
    job.status = STATUS_QUEUED.into();
    job.stage = STAGE_OA.into();
    job.stage_at = now;
    job.updated_at = now;
    job.error = None;
    job.saved = None;
    job.via = None;
    job.candidates.clear();
    job.pick = None;
    job.claimed_at = None;
    job.waiting = None;
}

/// 交进一篇。`allowed` = AI 可请求的范围（人交的不查）。同一项目同一 DOI 已有没结束的，原样返回那条；
/// AI 交的失败过的不重排（让人去处理，别反复敲出版商的门），人交的失败 / 取消过的重新排上
pub(crate) fn enqueue_in(
    store: &mut Store,
    root: &str,
    doi: &str,
    title: &str,
    run_id: Option<String>,
    requester: &str,
    allowed: Option<&HashSet<String>>,
    now: i64,
) -> Job {
    if let Some(job) = store
        .jobs
        .iter_mut()
        .rev()
        .find(|j| j.doi == doi && crate::paths::same_path(&j.project_root, root))
    {
        let saved_gone = job.status == STATUS_DONE
            && job
                .saved
                .as_deref()
                .map(|n| !Path::new(root).join("papers").join(n).exists())
                .unwrap_or(true);
        let human_retry = requester == "human" && matches!(job.status.as_str(), STATUS_FAILED | STATUS_CANCELLED);
        if saved_gone || human_retry {
            requeue(job, now);
            if requester == "human" {
                job.requester = "human".into();
            }
            if job.title.is_empty() {
                job.title = title.to_string();
            }
        }
        return job.clone();
    }
    let mut job = new_job(root, doi, title, run_id, requester, now);
    if requester != "human" && allowed.map(|a| !a.contains(doi)).unwrap_or(true) {
        job.status = STATUS_NEEDS_APPROVAL.into();
    }
    store.jobs.push(job.clone());
    job
}

/// 下一件能推进的活：先开放获取（不占学校配额），再学校通道（这家现在能去的）。返回 (下标, 要不要计一次学校请求)
pub(crate) fn pick_next(store: &mut Store, now: i64, channel_active: bool) -> Option<(usize, bool)> {
    if let Some(i) = store.jobs.iter().position(|j| j.status == STATUS_QUEUED && j.stage == STAGE_OA) {
        return Some((i, false));
    }
    for i in 0..store.jobs.len() {
        if !(store.jobs[i].status == STATUS_QUEUED && store.jobs[i].stage == STAGE_PUBLISHER) {
            continue;
        }
        let key = publisher_key(&store.jobs[i].doi);
        if !channel_active || browser_only(&key) || store.state.session_expired {
            // 学校通道用不上：直接交浏览器，不计数（扩展来领时才计）
            let job = &mut store.jobs[i];
            job.status = STATUS_BROWSER.into();
            job.stage = STAGE_BROWSER.into();
            job.stage_at = now;
            job.updated_at = now;
            job.waiting = None;
            continue;
        }
        match publisher_wait(&store.state, &key, now) {
            Some(why) => store.jobs[i].waiting = Some(why),
            None => {
                store.jobs[i].waiting = None;
                return Some((i, true));
            }
        }
    }
    None
}

/// 扩展领一篇：这家能去才给，并计一次学校请求
pub(crate) fn claim_in(store: &mut Store, now: i64) -> Option<Job> {
    store.state.extension_seen_at = now;
    for i in 0..store.jobs.len() {
        let j = &store.jobs[i];
        if j.status != STATUS_BROWSER {
            continue;
        }
        if j.claimed_at.map(|c| now - c < BROWSER_CLAIM_SECS).unwrap_or(false) {
            continue;
        }
        let key = publisher_key(&j.doi);
        if let Some(why) = publisher_wait(&store.state, &key, now) {
            store.jobs[i].waiting = Some(why);
            continue;
        }
        note_request(&mut store.state, &key, now);
        let job = &mut store.jobs[i];
        job.claimed_at = Some(now);
        job.waiting = None;
        job.updated_at = now;
        return Some(job.clone());
    }
    None
}

/// 浏览器一级的回话（扩展取不到时）
pub(crate) fn report_in(store: &mut Store, id: &str, kind: &str, detail: &str, candidates: Vec<Candidate>, now: i64) -> Option<Job> {
    let i = store.jobs.iter().position(|j| j.id == id && j.status == STATUS_BROWSER)?;
    let key = publisher_key(&store.jobs[i].doi);
    let mut ok_outcome = None;
    {
        let job = &mut store.jobs[i];
        job.claimed_at = None;
        job.updated_at = now;
        match kind {
            "captcha" | "blocked" => {
                job.status = STATUS_FAILED.into();
                job.error = Some(if kind == "captcha" {
                    "出版商要人机验证，这篇请你自己下；这家停 24 小时".into()
                } else {
                    format!("出版商拒绝了下载（{detail}），这篇请你自己下；这家停 24 小时")
                });
                ok_outcome = Some(false);
            }
            "login" => {
                job.status = STATUS_FAILED.into();
                job.error = Some("浏览器里没登录学校账号，登录后点「重试」".into());
                ok_outcome = Some(false);
            }
            "no_pdf" if !candidates.is_empty() && job.pick.is_none() => {
                job.status = STATUS_NEEDS_PICK.into();
                job.candidates = candidates.into_iter().take(8).collect();
                job.error = Some("页面上没认出 PDF，已把几个候选链接交给 AI 选".into());
            }
            "no_pdf" => {
                job.status = STATUS_FAILED.into();
                job.error = Some("页面上没找到 PDF，可能不在学校订阅范围，这篇请你自己下".into());
                ok_outcome = Some(false);
            }
            _ => {
                job.status = STATUS_FAILED.into();
                job.error = Some(if detail.is_empty() { "浏览器里没下到".into() } else { format!("浏览器里没下到：{detail}") });
                ok_outcome = Some(false);
            }
        }
    }
    if matches!(kind, "captcha" | "blocked") {
        trip(&mut store.state, &key, now, if kind == "captcha" { "要人机验证" } else { "下载被拒" });
    }
    if let Some(ok) = ok_outcome {
        note_outcome(&mut store.state, ok);
    }
    Some(store.jobs[i].clone())
}

/// 扩展取到并入库后记成完成
pub(crate) fn complete_in(store: &mut Store, id: &str, saved: &str, now: i64) -> Option<Job> {
    let job = store.jobs.iter_mut().find(|j| j.id == id && !j.finished())?;
    job.status = STATUS_DONE.into();
    job.saved = Some(saved.to_string());
    job.via = Some("browser".into());
    job.error = None;
    job.claimed_at = None;
    job.updated_at = now;
    let out = job.clone();
    note_outcome(&mut store.state, true);
    Some(out)
}

/// 浏览器一级等太久：放弃交给人（扩展没装、浏览器没开）
pub(crate) fn expire_browser(store: &mut Store, now: i64) -> bool {
    let alive = now - store.state.extension_seen_at < EXTENSION_ALIVE_SECS;
    let mut changed = false;
    for job in store.jobs.iter_mut() {
        if job.status == STATUS_BROWSER && job.claimed_at.is_none() && now - job.stage_at > BROWSER_GIVEUP_SECS && !alive {
            job.status = STATUS_FAILED.into();
            job.error = Some("要在浏览器里下，但 30 分钟里浏览器扩展都没连上（浏览器没开，或扩展没装好）。装好后点「重试」，或自己下这篇".into());
            job.updated_at = now;
            changed = true;
        }
    }
    changed
}

// ===== 后台推进（主程序）=====

pub fn start_worker(app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("paper-fetch".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(TICK_SECS));
            if crate::process::shutting_down() {
                break;
            }
            match tauri::async_runtime::block_on(tick()) {
                Ok(true) => {
                    use tauri::Emitter;
                    let _ = app.emit("paper-fetch-changed", ());
                    // 后台直接存下的（开放获取 / 学校通道）与扩展存下的同一个广播：待获取清单就地翻「已存」
                    for job in take_saved() {
                        let _ = app.emit(
                            "inst-papers-changed",
                            serde_json::json!({
                                "projectRoot": job.project_root,
                                "title": job.title,
                                "doi": job.doi,
                                "saved": job.saved.unwrap_or_default(),
                            }),
                        );
                    }
                }
                Ok(false) => {}
                Err(e) => crate::logbuf::record("warn", "paper-fetch", &e),
            }
        })
        .ok();
}

static SAVED: std::sync::Mutex<Vec<Job>> = std::sync::Mutex::new(Vec::new());

fn take_saved() -> Vec<Job> {
    SAVED.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default()
}

/// 推进一步；返回有没有变化（有就广播给界面）
pub(crate) async fn tick() -> Result<bool, String> {
    let channel = crate::inst_access::InstitutionalChannel::load();
    let channel_active = channel.active();
    let t = now();
    let picked = with_store(|s| {
        let before = s.clone();
        roll_day(&mut s.state, &today());
        let expired = expire_browser(s, t);
        let next = pick_next(s, t, channel_active);
        if let Some((i, count)) = next {
            if count {
                let key = publisher_key(&s.jobs[i].doi);
                note_request(&mut s.state, &key, t);
            }
        }
        let job = next.map(|(i, _)| s.jobs[i].clone());
        let dirty = *s != before;
        ((job, expired || dirty), dirty)
    })?;
    let (job, changed) = picked;
    let Some(job) = job else { return Ok(changed) };
    let key = publisher_key(&job.doi);
    let log = |level: &str, result: &str| {
        append_log(&LogEntry {
            at: now(),
            doi: job.doi.clone(),
            publisher: key.clone(),
            level: level.into(),
            result: result.into(),
            run_id: job.run_id.clone(),
            project: project_name(&job.project_root),
        })
    };
    if job.stage == STAGE_OA {
        let got = match crate::inst_access::oa_pdf_url_for(&job.doi).await {
            Some((url, _)) => crate::lit_watch::fetch_pdf_bytes(&url).await.ok(),
            None => None,
        };
        let saved = got.as_ref().map(|bytes| ingest(&job, bytes));
        match saved {
            Some(Ok(name)) => {
                log("oa", "ok");
                finish(&job.id, Ok((name, "oa")))?;
            }
            Some(Err(e)) => {
                log("oa", "save_failed");
                finish(&job.id, Err(format!("下到了开放获取版本，但存进项目失败：{e}")))?;
            }
            None => {
                with_store(|s| {
                    if let Some(j) = s.jobs.iter_mut().find(|j| j.id == job.id && j.status == STATUS_QUEUED) {
                        j.stage = STAGE_PUBLISHER.into();
                        j.stage_at = now();
                        j.updated_at = now();
                    }
                    ((), true)
                })?;
            }
        }
        return Ok(true);
    }
    // 学校通道直取
    let target = format!("https://doi.org/{}", job.doi);
    match crate::inst_access::fetch_via_channel(&target, &channel).await {
        Ok(bytes) => match ingest(&job, &bytes) {
            Ok(name) => {
                log("institutional", "ok");
                finish(&job.id, Ok((name, "institutional")))?;
            }
            Err(e) => {
                log("institutional", "save_failed");
                finish(&job.id, Err(format!("下到了全文，但存进项目失败：{e}")))?;
            }
        },
        Err(e) => {
            let kind = classify_channel_error(&e);
            log(
                "institutional",
                match kind {
                    ChannelFail::Throttled => "throttled",
                    ChannelFail::SessionExpired => "session_expired",
                    ChannelFail::Other => "fallback",
                },
            );
            with_store(|s| {
                let t = now();
                match kind {
                    ChannelFail::Throttled => trip(&mut s.state, &key, t, "出版商限流"),
                    ChannelFail::SessionExpired => s.state.session_expired = true,
                    ChannelFail::Other => {}
                }
                if let Some(j) = s.jobs.iter_mut().find(|j| j.id == job.id && j.status == STATUS_QUEUED) {
                    if kind == ChannelFail::Throttled {
                        // 限流：这家已熔断，这篇留在队里等明天，不再往浏览器推（同一家同一个 IP）
                        j.waiting = Some(format!("{} 限流，暂停 24 小时", publisher_name(&key)));
                    } else {
                        j.status = STATUS_BROWSER.into();
                        j.stage = STAGE_BROWSER.into();
                        j.stage_at = t;
                    }
                    j.updated_at = t;
                }
                ((), true)
            })?;
        }
    }
    Ok(true)
}

/// 入那件任务自己的项目（与扩展「存到 Mesa」同一套落盘与登记）；返回 papers/ 里的真实文件名（不是条目显示名）与是否重复
fn save_for_job(job: &Job, bytes: &[u8]) -> Result<(String, bool), String> {
    let hint = if job.title.trim().is_empty() { job.doi.clone() } else { job.title.clone() };
    let root = crate::projects::ensure_task_project_root(Path::new(&job.project_root))?;
    let dto = crate::lit_watch::save_paper_bytes_ident(&root, &hint, &hint, &job.doi, bytes)?;
    let file = Path::new(&dto.path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or(dto.name);
    Ok((file, dto.dedup))
}

fn ingest(job: &Job, bytes: &[u8]) -> Result<String, String> {
    save_for_job(job, bytes).map(|(name, _)| name)
}

fn finish(id: &str, result: Result<(String, &str), String>) -> Result<(), String> {
    with_store(|s| {
        let t = now();
        let ok = result.is_ok();
        if let Some(j) = s.jobs.iter_mut().find(|j| j.id == id) {
            match &result {
                Ok((name, via)) => {
                    j.status = STATUS_DONE.into();
                    j.saved = Some(name.clone());
                    j.via = Some(via.to_string());
                    j.error = None;
                }
                Err(e) => {
                    j.status = STATUS_FAILED.into();
                    j.error = Some(e.clone());
                }
            }
            j.updated_at = t;
            if ok {
                if let Ok(mut v) = SAVED.lock() {
                    v.push(j.clone());
                }
            }
        }
        note_outcome(&mut s.state, ok);
        ((), true)
    })
}

// ===== 扩展（经 helper 的 native messaging）=====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTask {
    pub id: String,
    pub doi: String,
    pub url: String,
    /// 只认这个来源下的链接（AI 指定候选时校验同源）
    pub pick: Option<String>,
}

/// 扩展每分钟来领一次
pub fn helper_claim_browser_task() -> Option<BrowserTask> {
    let t = now();
    let job = with_store(|s| {
        roll_day(&mut s.state, &today());
        let j = claim_in(s, t);
        (j, true)
    })
    .ok()??;
    let target = format!("https://doi.org/{}", job.doi);
    let ch = crate::inst_access::InstitutionalChannel::load();
    let url = match ch.prefix.as_deref() {
        Some(p) if !p.trim().is_empty() => crate::inst_access::proxy_wrap_pub(p, &target),
        _ => target,
    };
    Some(BrowserTask { id: job.id, doi: job.doi, url, pick: job.pick })
}

/// 扩展取到 PDF：按任务入它自己的项目（不看 helper-context）。返回 (文件名, 是否重复, 项目根)
pub fn helper_save_for_task(id: &str, bytes: &[u8]) -> Result<(String, bool, String), String> {
    let job = with_store(|s| (s.jobs.iter().find(|j| j.id == id && !j.finished()).cloned(), false))?
        .ok_or("这件代下任务已经结束或不存在")?;
    let (name, dedup) = save_for_job(&job, bytes)?;
    append_log(&LogEntry {
        at: now(),
        doi: job.doi.clone(),
        publisher: publisher_key(&job.doi),
        level: "browser".into(),
        result: "ok".into(),
        run_id: job.run_id.clone(),
        project: project_name(&job.project_root),
    });
    with_store(|s| (complete_in(s, id, &name, now()), true))?;
    Ok((name, dedup, job.project_root))
}

/// 扩展取不到时回话：kind = no_pdf / captcha / login / blocked / error
pub fn helper_report_task(id: &str, kind: &str, detail: &str, candidates: Vec<(String, String)>) -> Result<(), String> {
    let cands: Vec<Candidate> = candidates.into_iter().map(|(url, text)| Candidate { url, text }).collect();
    let job = with_store(|s| {
        let j = report_in(s, id, kind, detail, cands, now());
        (j, true)
    })?;
    if let Some(job) = job {
        append_log(&LogEntry {
            at: now(),
            doi: job.doi.clone(),
            publisher: publisher_key(&job.doi),
            level: "browser".into(),
            result: kind.into(),
            run_id: job.run_id.clone(),
            project: project_name(&job.project_root),
        });
    }
    Ok(())
}

// ===== Agent 用的命令行（mesa_helper paper …）=====

const USAGE: &str = "用法（Windows PowerShell 把 \"$MESA_PAPER_TOOL\" 写成 & $env:MESA_PAPER_TOOL）：
  \"$MESA_PAPER_TOOL\" paper fetch <DOI> [<DOI> …] [--wait 秒]   交给 Mesa 代下全文（默认最多等 60 秒）
  \"$MESA_PAPER_TOOL\" paper status [<DOI>]                       看这个项目代下到哪了
  \"$MESA_PAPER_TOOL\" paper pick <DOI> <编号>                    落地页上没认出 PDF 时，从列出的候选里指一个";

fn resolve_project() -> Result<(String, Option<String>), String> {
    let run_id = std::env::var(crate::peek::RUN_ENV).ok().filter(|s| !s.trim().is_empty());
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let (me, _) = crate::runs::peek_context(run_id.as_deref(), &cwd)?;
    let root = me.project_root.ok_or("这次对话不属于任何项目：代下全文要在项目里用")?;
    Ok((root, Some(me.id)))
}

fn describe(job: &Job) -> String {
    match job.status.as_str() {
        STATUS_DONE => format!(
            "{}：已存 papers/{}（经{}）",
            job.doi,
            job.saved.as_deref().unwrap_or(""),
            level_label(job.via.as_deref().unwrap_or(""))
        ),
        STATUS_NEEDS_APPROVAL => format!("{}：不在项目文献清单里，已交给人放行；先做别的，别自己去出版商网站下", job.doi),
        STATUS_NEEDS_PICK => {
            let mut s = format!("{}：落地页上没认出 PDF，候选链接如下，用 paper pick {} <编号> 指一个（只选正文 PDF，不选补充材料）：", job.doi, job.doi);
            for (i, c) in job.candidates.iter().enumerate() {
                s.push_str(&format!("\n  {}. {}  {}", i + 1, c.text.trim(), c.url));
            }
            s
        }
        STATUS_FAILED => format!("{}：没取到——{}。这篇交给人获取，不要重试、不要换别的办法去下", job.doi, job.error.as_deref().unwrap_or("原因不明")),
        STATUS_CANCELLED => format!("{}：人取消了这篇的代下", job.doi),
        STATUS_BROWSER => format!("{}：排队等浏览器取（Mesa 文献下载扩展每分钟来领一篇）{}", job.doi, job.waiting.as_deref().map(|w| format!("；{w}")).unwrap_or_default()),
        _ => format!(
            "{}：排队中{}",
            job.doi,
            job.waiting.as_deref().map(|w| format!("（{w}）")).unwrap_or_default()
        ),
    }
}

pub fn helper_paper_cli(args: &[String]) -> i32 {
    let sub = args.first().map(String::as_str).unwrap_or("");
    let (root, run_id) = match resolve_project() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    match sub {
        "fetch" => {
            let mut wait = 60u64;
            let mut dois = Vec::new();
            let mut it = args[1..].iter();
            while let Some(a) = it.next() {
                if a == "--wait" {
                    wait = it.next().and_then(|v| v.parse().ok()).unwrap_or(60).min(600);
                } else if let Some(d) = normalize_doi(a) {
                    dois.push(d);
                } else {
                    eprintln!("不像 DOI：{a}");
                }
            }
            if dois.is_empty() {
                eprintln!("{USAGE}");
                return 2;
            }
            let allowed = project_dois(Path::new(&root));
            let t = now();
            let ids = match with_store(|s| {
                let ids: Vec<String> = dois
                    .iter()
                    .map(|d| enqueue_in(s, &root, d, "", run_id.clone(), "agent", Some(&allowed), t).id)
                    .collect();
                (ids, true)
            }) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("交给 Mesa 失败：{e}");
                    return 1;
                }
            };
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(wait);
            let jobs = loop {
                let jobs: Vec<Job> = with_store(|s| (s.jobs.iter().filter(|j| ids.contains(&j.id)).cloned().collect(), false)).unwrap_or_default();
                let settled = jobs.iter().all(|j| j.finished() || matches!(j.status.as_str(), STATUS_NEEDS_APPROVAL | STATUS_NEEDS_PICK));
                if settled || std::time::Instant::now() >= deadline {
                    break jobs;
                }
                std::thread::sleep(std::time::Duration::from_secs(2));
            };
            for j in &jobs {
                println!("{}", describe(j));
            }
            if jobs.iter().any(|j| !j.finished()) {
                println!("还没结束的不用守着：Mesa 会按出版商限速逐篇取，稍后用 paper status 查；不要重复提交，也不要自己去出版商网站下（会连累学校的访问）。");
            }
            0
        }
        "status" => {
            let only = args.get(1).and_then(|d| normalize_doi(d));
            let jobs: Vec<Job> = with_store(|s| {
                (
                    s.jobs
                        .iter()
                        .filter(|j| crate::paths::same_path(&j.project_root, &root))
                        .filter(|j| only.as_ref().map(|d| &j.doi == d).unwrap_or(true))
                        .cloned()
                        .collect(),
                    false,
                )
            })
            .unwrap_or_default();
            if jobs.is_empty() {
                println!("这个项目还没有代下记录");
            }
            for j in jobs.iter().rev().take(40) {
                println!("{}", describe(j));
            }
            0
        }
        "pick" => {
            let (Some(doi), Some(n)) = (args.get(1).and_then(|d| normalize_doi(d)), args.get(2).and_then(|n| n.parse::<usize>().ok())) else {
                eprintln!("{USAGE}");
                return 2;
            };
            let res = with_store(|s| {
                let Some(job) = s
                    .jobs
                    .iter_mut()
                    .rev()
                    .find(|j| j.doi == doi && crate::paths::same_path(&j.project_root, &root) && j.status == STATUS_NEEDS_PICK)
                else {
                    return (Err("这篇现在不需要指候选".to_string()), false);
                };
                let Some(c) = n.checked_sub(1).and_then(|i| job.candidates.get(i)).cloned() else {
                    return (Err(format!("没有第 {n} 个候选")), false);
                };
                job.pick = Some(c.url.clone());
                job.status = STATUS_BROWSER.into();
                job.stage = STAGE_BROWSER.into();
                job.stage_at = now();
                job.updated_at = now();
                job.error = None;
                (Ok(c.url), true)
            });
            match res {
                Ok(Ok(url)) => {
                    println!("已指定 {url}，浏览器下次来领时取这一个；稍后用 paper status {doi} 查");
                    0
                }
                Ok(Err(e)) | Err(e) => {
                    eprintln!("{e}");
                    1
                }
            }
        }
        _ => {
            eprintln!("{USAGE}");
            2
        }
    }
}

// ===== 界面命令 =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublisherDto {
    pub key: String,
    pub name: String,
    pub count: u32,
    pub blocked_until: Option<i64>,
    pub blocked_reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewDto {
    pub limits: Limits,
    pub ceiling: Limits,
    pub total_today: u32,
    pub publishers: Vec<PublisherDto>,
    pub paused: Option<String>,
    pub session_expired: bool,
    pub extension_alive: bool,
    pub jobs: Vec<Job>,
}

fn overview_of(store: &Store, root: Option<&str>, t: i64) -> OverviewDto {
    let mut state = store.state.clone();
    roll_day(&mut state, &today());
    let publishers = state
        .publishers
        .iter()
        .filter(|(_, p)| p.count > 0 || p.blocked_until > t)
        .map(|(k, p)| PublisherDto {
            key: k.clone(),
            name: publisher_name(k),
            count: p.count,
            blocked_until: (p.blocked_until > t).then_some(p.blocked_until),
            blocked_reason: p.blocked_reason.clone(),
        })
        .collect();
    let mut jobs: Vec<Job> = store
        .jobs
        .iter()
        .filter(|j| root.map(|r| crate::paths::same_path(&j.project_root, r)).unwrap_or(true))
        .cloned()
        .collect();
    jobs.reverse();
    jobs.truncate(200);
    OverviewDto {
        limits: state.limits(),
        ceiling: CEILING,
        total_today: state.total,
        publishers,
        paused: state.paused.clone(),
        session_expired: state.session_expired,
        extension_alive: t - state.extension_seen_at < EXTENSION_ALIVE_SECS,
        jobs,
    }
}

async fn blocking<R: Send + 'static>(f: impl FnOnce() -> Result<R, String> + Send + 'static) -> Result<R, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn paper_fetch_overview(project_root: Option<String>) -> Result<OverviewDto, String> {
    blocking(move || with_store(|s| (overview_of(s, project_root.as_deref(), now()), false))).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueItem {
    pub doi: String,
    #[serde(default)]
    pub title: String,
}

/// 人整批交（待获取清单「让 Mesa 代下这批」）：人点的就是放行，不查清单范围
#[tauri::command]
pub async fn paper_fetch_enqueue(project_root: String, items: Vec<EnqueueItem>) -> Result<usize, String> {
    blocking(move || {
        let root = crate::projects::ensure_task_project_root(Path::new(&project_root))?;
        let root = root.to_string_lossy().into_owned();
        let t = now();
        with_store(|s| {
            let mut n = 0;
            for it in &items {
                if let Some(d) = normalize_doi(&it.doi) {
                    enqueue_in(s, &root, &d, &it.title, None, "human", None, t);
                    n += 1;
                }
            }
            (n, true)
        })
    })
    .await
}

fn update_job(id: String, f: impl FnOnce(&mut Job, i64) -> Result<(), String> + Send + 'static) -> Result<(), String> {
    with_store(move |s| {
        let t = now();
        match s.jobs.iter_mut().find(|j| j.id == id) {
            Some(j) => (f(j, t), true),
            None => (Err("找不到这件代下任务".into()), false),
        }
    })?
}

#[tauri::command]
pub async fn paper_fetch_approve(id: String) -> Result<(), String> {
    blocking(move || {
        update_job(id, |j, t| {
            if j.status != STATUS_NEEDS_APPROVAL {
                return Err("这篇不在等放行".into());
            }
            requeue(j, t);
            j.requester = "human".into();
            Ok(())
        })
    })
    .await
}

#[tauri::command]
pub async fn paper_fetch_retry(id: String) -> Result<(), String> {
    blocking(move || {
        update_job(id, |j, t| {
            if !matches!(j.status.as_str(), STATUS_FAILED | STATUS_CANCELLED | STATUS_NEEDS_PICK) {
                return Err("这篇还在进行中".into());
            }
            requeue(j, t);
            j.requester = "human".into();
            Ok(())
        })
    })
    .await
}

#[tauri::command]
pub async fn paper_fetch_cancel(id: String) -> Result<(), String> {
    blocking(move || {
        update_job(id, |j, t| {
            if j.finished() {
                return Err("这篇已经结束".into());
            }
            j.status = STATUS_CANCELLED.into();
            j.claimed_at = None;
            j.updated_at = t;
            Ok(())
        })
    })
    .await
}

/// 「继续」：解除整条暂停、清连续失败、当作已重新登录
#[tauri::command]
pub async fn paper_fetch_resume() -> Result<(), String> {
    blocking(|| {
        with_store(|s| {
            s.state.paused = None;
            s.state.fails_in_row = 0;
            s.state.session_expired = false;
            ((), true)
        })
    })
    .await
}

#[tauri::command]
pub async fn paper_fetch_unblock(publisher: String) -> Result<(), String> {
    blocking(move || {
        with_store(|s| {
            if let Some(p) = s.state.publishers.get_mut(&publisher) {
                p.blocked_until = 0;
                p.blocked_reason.clear();
            }
            ((), true)
        })
    })
    .await
}

#[tauri::command]
pub async fn paper_fetch_set_limits(limits: Limits) -> Result<Limits, String> {
    blocking(move || {
        with_store(|s| {
            let l = clamp_limits(limits);
            s.state.limits = Some(l);
            (l, true)
        })
    })
    .await
}

#[tauri::command]
pub async fn paper_fetch_log(limit: Option<usize>) -> Result<Vec<LogEntry>, String> {
    blocking(move || {
        let mut v = read_log(limit.unwrap_or(200).min(2000));
        v.reverse();
        Ok(v)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(d: &[&str]) -> HashSet<String> {
        d.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn normalize_and_extract_dois() {
        assert_eq!(normalize_doi("https://doi.org/10.1002/ADMA.2023.1).").as_deref(), Some("10.1002/adma.2023.1"));
        assert_eq!(normalize_doi("doi:10.1016/j.cell.2020.01.001").as_deref(), Some("10.1016/j.cell.2020.01.001"));
        assert_eq!(normalize_doi("10.12/x"), None);
        assert_eq!(normalize_doi("hello"), None);
        let text = "见 https://doi.org/10.1021/jacs.3c01234, 另一篇 DOI: 10.1038/s41586-020-2649-2。还有 a10.1000/xyz 不算";
        assert_eq!(extract_dois(text), vec!["10.1021/jacs.3c01234".to_string(), "10.1038/s41586-020-2649-2".to_string()]);
    }

    #[test]
    fn publisher_keys_group_prefixes() {
        assert_eq!(publisher_key("10.1111/abc"), "wiley");
        assert_eq!(publisher_key("10.1002/abc"), "wiley");
        assert_eq!(publisher_key("10.9999/abc"), "10.9999");
        assert!(browser_only("elsevier"));
    }

    #[test]
    fn limits_cannot_exceed_ceiling() {
        let l = clamp_limits(Limits { per_publisher_daily: 999, total_daily: 999, min_gap_secs: 1, max_gap_secs: 0 });
        assert_eq!(l.per_publisher_daily, CEILING.per_publisher_daily);
        assert_eq!(l.total_daily, CEILING.total_daily);
        assert_eq!(l.min_gap_secs, CEILING.min_gap_secs);
        assert!(l.max_gap_secs >= l.min_gap_secs);
    }

    #[test]
    fn caps_gap_and_breaker() {
        let mut st = State::default();
        st.limits = Some(Limits { per_publisher_daily: 2, total_daily: 3, min_gap_secs: 30, max_gap_secs: 30 });
        assert!(publisher_wait(&st, "acs", 1000).is_none());
        note_request(&mut st, "acs", 1000);
        assert!(publisher_wait(&st, "acs", 1010).unwrap().contains("秒后开始"));
        assert!(publisher_wait(&st, "acs", 1031).is_none());
        note_request(&mut st, "acs", 1031);
        assert!(publisher_wait(&st, "acs", 2000).unwrap().contains("到了上限"));
        // 别家还能去，到总量上限才都停
        assert!(publisher_wait(&st, "rsc", 2000).is_none());
        note_request(&mut st, "rsc", 2000);
        assert!(publisher_wait(&st, "nature", 3000).unwrap().contains("到了上限"));
        // 跨天清零计数，熔断不清
        trip(&mut st, "rsc", 3000, "要人机验证");
        roll_day(&mut st, "2099-01-01");
        assert!(publisher_wait(&st, "acs", 4000).is_none());
        assert!(publisher_wait(&st, "rsc", 4000).unwrap().contains("暂停到"));
        assert!(publisher_wait(&st, "rsc", 3000 + BLOCK_SECS + 1).is_none());
    }

    #[test]
    fn three_failures_pause_everything() {
        let mut st = State::default();
        note_outcome(&mut st, false);
        note_outcome(&mut st, true);
        note_outcome(&mut st, false);
        note_outcome(&mut st, false);
        assert!(st.paused.is_none());
        note_outcome(&mut st, false);
        assert!(st.paused.is_some());
        assert!(publisher_wait(&st, "acs", 0).unwrap().contains("暂停"));
    }

    #[test]
    fn channel_errors_classified() {
        assert_eq!(classify_channel_error("下载失败：HTTP 429 Too Many Requests"), ChannelFail::Throttled);
        assert_eq!(classify_channel_error("停在机构登录页——会话可能已过期"), ChannelFail::SessionExpired);
        assert_eq!(classify_channel_error("HTTP 403"), ChannelFail::Other);
    }

    #[test]
    fn agent_outside_list_needs_approval_human_does_not() {
        let mut s = Store::default();
        let a = enqueue_in(&mut s, "/p", "10.1021/a", "", None, "agent", Some(&allowed(&["10.1021/b"])), 1);
        assert_eq!(a.status, STATUS_NEEDS_APPROVAL);
        let b = enqueue_in(&mut s, "/p", "10.1021/b", "", None, "agent", Some(&allowed(&["10.1021/b"])), 1);
        assert_eq!(b.status, STATUS_QUEUED);
        let c = enqueue_in(&mut s, "/p", "10.1021/c", "", None, "human", None, 1);
        assert_eq!(c.status, STATUS_QUEUED);
        // 同一篇再交原样返回，不重复排
        let b2 = enqueue_in(&mut s, "/p", "10.1021/b", "", None, "agent", Some(&allowed(&["10.1021/b"])), 2);
        assert_eq!(b2.id, b.id);
        assert_eq!(s.jobs.len(), 3);
        // AI 交的失败过不重排；人交的重排
        s.jobs[1].status = STATUS_FAILED.into();
        let b3 = enqueue_in(&mut s, "/p", "10.1021/b", "", None, "agent", Some(&allowed(&["10.1021/b"])), 3);
        assert_eq!(b3.status, STATUS_FAILED);
        let b4 = enqueue_in(&mut s, "/p", "10.1021/b", "", None, "human", None, 3);
        assert_eq!(b4.status, STATUS_QUEUED);
    }

    #[test]
    fn pick_next_prefers_oa_then_ready_publishers_and_routes_browser_only() {
        let mut s = Store::default();
        let mut w = new_job("/p", "10.1002/w", "", None, "agent", 1);
        w.stage = STAGE_PUBLISHER.into();
        let mut a = new_job("/p", "10.1021/a", "", None, "agent", 1);
        a.stage = STAGE_PUBLISHER.into();
        let o = new_job("/p", "10.1038/o", "", None, "agent", 1);
        s.jobs = vec![w, a, o];
        assert_eq!(pick_next(&mut s, 10, true), Some((2, false)));
        s.jobs[2].status = STATUS_DONE.into();
        // Wiley 只能浏览器：转浏览器不计数；ACS 能直取
        assert_eq!(pick_next(&mut s, 10, true), Some((1, true)));
        assert_eq!(s.jobs[0].status, STATUS_BROWSER);
        // 学校通道没配：都走浏览器
        s.jobs[1].status = STATUS_QUEUED.into();
        assert_eq!(pick_next(&mut s, 10, false), None);
        assert_eq!(s.jobs[1].status, STATUS_BROWSER);
    }

    #[test]
    fn browser_claim_respects_limits_and_reports() {
        let mut s = Store::default();
        s.state.limits = Some(Limits { per_publisher_daily: 1, total_daily: 10, min_gap_secs: 30, max_gap_secs: 30 });
        for d in ["10.1002/x", "10.1002/y"] {
            let mut j = new_job("/p", d, "", None, "agent", 1);
            j.status = STATUS_BROWSER.into();
            j.stage = STAGE_BROWSER.into();
            s.jobs.push(j);
        }
        let first = claim_in(&mut s, 100).unwrap();
        assert_eq!(first.doi, "10.1002/x");
        // 同一家到上限，第二篇不给
        assert!(claim_in(&mut s, 200).is_none());
        assert!(s.jobs[1].waiting.as_deref().unwrap().contains("到了上限"));
        // 验证码：熔断这家、这篇交还给人
        let j = report_in(&mut s, &first.id, "captcha", "", vec![], 150).unwrap();
        assert_eq!(j.status, STATUS_FAILED);
        assert!(s.state.publishers["wiley"].blocked_until > 150);
        // 没认出 PDF 但有候选 → 等 AI 指一个
        s.jobs[1].claimed_at = Some(1);
        let second = s.jobs[1].id.clone();
        let r = report_in(&mut s, &second, "no_pdf", "", vec![Candidate { url: "https://x/pdf".into(), text: "PDF".into() }], 300).unwrap();
        assert_eq!(r.status, STATUS_NEEDS_PICK);
    }

    #[test]
    fn browser_jobs_expire_when_extension_absent() {
        let mut s = Store::default();
        let mut j = new_job("/p", "10.1002/x", "", None, "agent", 0);
        j.status = STATUS_BROWSER.into();
        j.stage_at = 0;
        s.jobs.push(j);
        assert!(!expire_browser(&mut s, 60));
        assert!(expire_browser(&mut s, BROWSER_GIVEUP_SECS + 1));
        assert_eq!(s.jobs[0].status, STATUS_FAILED);
    }

    /// 联网干跑（默认不跑）：临时项目 + 重定向配置目录，交一篇开放获取论文，队列真的去取、存进 papers/、记日志与 Run 事实口径。
    /// `cargo test real_network_oa_dry_run -- --ignored --nocapture`（国内网络带 HTTPS_PROXY）
    #[test]
    #[ignore]
    fn real_network_oa_dry_run() {
        let base = std::env::temp_dir().join(format!("ccode-paper-dry-{}", uuid::Uuid::new_v4()));
        let cfg = base.join("config");
        let proj = base.join("proj");
        fs::create_dir_all(proj.join(".ccode")).unwrap();
        fs::create_dir_all(proj.join("papers")).unwrap();
        fs::create_dir_all(&cfg).unwrap();
        fs::write(proj.join(".ccode/project.toml"), "name = \"dry\"\n").unwrap();
        let doi = "10.1371/journal.pcbi.1003285";
        fs::write(proj.join("papers/to-fetch.md"), format!("1. Ten Simple Rules for Reproducible Computational Research — {doi}\n")).unwrap();
        let _guard = crate::storage::redirect_config_root(&cfg);
        let root = crate::paths::canonicalize_plain(&proj).unwrap().to_string_lossy().into_owned();
        let allowed = project_dois(Path::new(&root));
        assert!(allowed.contains(doi));
        with_store(|s| (enqueue_in(s, &root, doi, "Ten Simple Rules", Some("run-dry".into()), "agent", Some(&allowed), now()), true)).unwrap();
        for _ in 0..4 {
            tauri::async_runtime::block_on(tick()).unwrap();
            let done = with_store(|s| (s.jobs[0].finished(), false)).unwrap();
            if done {
                break;
            }
        }
        let job = with_store(|s| (s.jobs[0].clone(), false)).unwrap();
        eprintln!("job = {job:?}");
        assert_eq!(job.status, STATUS_DONE, "{:?}", job.error);
        assert_eq!(job.via.as_deref(), Some("oa"));
        let saved = proj.join("papers").join(job.saved.unwrap());
        assert!(fs::read(&saved).unwrap().starts_with(b"%PDF-"));
        assert_eq!(fetched_for_run("run-dry"), vec![format!("{doi}（经开放获取）")]);
        // 开放获取不占学校配额
        let st = with_store(|s| (s.state.clone(), false)).unwrap();
        assert_eq!(st.total, 0);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn project_dois_reads_lists_not_screening() {
        let tmp = std::env::temp_dir().join(format!("ccode-paper-fetch-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(tmp.join("papers")).unwrap();
        fs::write(tmp.join("papers/to-fetch.md"), "- Title A https://doi.org/10.1021/acs.a1\n").unwrap();
        fs::write(tmp.join("papers/screening.md"), "排除 10.1021/acs.excluded\n").unwrap();
        let set = project_dois(&tmp);
        let _ = fs::remove_dir_all(&tmp);
        assert!(set.contains("10.1021/acs.a1"));
        assert!(!set.contains("10.1021/acs.excluded"));
    }
}
