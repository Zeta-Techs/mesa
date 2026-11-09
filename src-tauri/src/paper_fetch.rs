//! 全文代下队列（2026-11-08 拍板，`docs/design-autonomy-roadmap.md` §6；2026-11-09 收窄为只找开放获取）。
//!
//! AI（对话、目标、定时）经 `mesa_helper paper fetch <DOI>` 把要下的文献交进来，人也可以在待获取清单里整批交；
//! Mesa 只去找合法的开放获取版本（Unpaywall / OpenAlex，不用学校身份），找到就存进项目 `papers/`，
//! 找不到的记成「交给人在官网下」（`STATUS_MANUAL`）。学校通道直取与浏览器扩展后台取已撤（HER 实测出版商按指纹 / IP 拦）。
//!
//! 硬边界（Mesa 执行，不靠 AI 自觉）：
//! - 全局一条队列：后台线程单线程推进；跨进程（helper / 主程序）共用 `<config>/paper-fetch/queue.json`，读改写持文件锁。
//! - AI 只能下项目清单里有的 DOI（`project_dois`），清单外的等人放行；保存进项目后清单里有了就自动放行。
//! - 每次出门记一行日志（`log.jsonl`，0600），带 runId，Run 事实按它写「这次取得了哪些文献」。
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Agent 环境里 helper 的路径（与 MESA_PEEK_TOOL 指向同一个 helper）
pub const TOOL_ENV: &str = "MESA_PAPER_TOOL";

/// 扩展多久内来打过招呼算「在」
const EXTENSION_ALIVE_SECS: i64 = 5 * 60;
const KEEP_FINISHED: usize = 400;
const LOG_CAP: u64 = 2 * 1024 * 1024;
const TICK_SECS: u64 = 5;

pub const STATUS_NEEDS_APPROVAL: &str = "needs_approval";
pub const STATUS_QUEUED: &str = "queued";
pub const STATUS_DONE: &str = "done";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_CANCELLED: &str = "cancelled";
/// 没有开放获取版本，交给人在官网下（2026-11-09 用户拍板：浏览器后台自动下被 Wiley / RSC 拒、Elsevier 封 IP，
/// 「根本不可行」——代下只找开放获取，付费墙一律人点「官网」自己下）
pub const STATUS_MANUAL: &str = "manual";

const STAGE_OA: &str = "oa";

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
    /// 出版商名（只在给界面的概览里填，队列文件里留空）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub publisher: String,
}

impl Job {
    fn finished(&self) -> bool {
        matches!(self.status.as_str(), STATUS_DONE | STATUS_FAILED | STATUS_CANCELLED | STATUS_MANUAL)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// 浏览器扩展最近一次打招呼（设置页「已连接」）；旧队列文件里的计数 / 熔断 / 暂停字段读时忽略
    #[serde(default)]
    pub extension_seen_at: i64,
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
        "institutional" => "学校订阅",
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
        // 人亲手交 = 放行：AI 先交的、还在等放行的也一起排上（2026-11-09 HER：检索步保存前点「让 Mesa 代下这批」原样跳过，46 篇没动）
        let human_retry = requester == "human" && matches!(job.status.as_str(), STATUS_FAILED | STATUS_CANCELLED | STATUS_NEEDS_APPROVAL);
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

/// AI 交的、还在等放行的篇：DOI 后来出现在项目文献清单里（人把这一步评审、保存进项目 = 认了这份清单）就自动放行。
/// 2026-11-09 HER 实测：检索步在工作区里交 46 篇时清单还没进项目，全部卡在「等你确认」，要人逐篇点
pub(crate) fn release_listed(store: &mut Store, listed: impl Fn(&str) -> HashSet<String>, now: i64) -> bool {
    let mut cache: std::collections::HashMap<String, HashSet<String>> = std::collections::HashMap::new();
    let mut changed = false;
    for job in store.jobs.iter_mut().filter(|j| j.status == STATUS_NEEDS_APPROVAL) {
        let set = cache.entry(job.project_root.clone()).or_insert_with(|| listed(&job.project_root));
        if set.contains(&job.doi) {
            requeue(job, now);
            changed = true;
        }
    }
    changed
}

/// 没有开放获取版本：交给人在官网下
fn to_manual(j: &mut Job, now: i64) {
    j.status = STATUS_MANUAL.into();
    j.stage = STAGE_OA.into();
    j.updated_at = now;
    j.error = None;
}

/// 这个项目没下到的一起重排：人点「全部重试」
pub(crate) fn retry_failed_in(store: &mut Store, root: &str, now: i64) -> usize {
    let mut n = 0;
    for job in store.jobs.iter_mut().filter(|j| {
        crate::paths::same_path(&j.project_root, root) && j.status == STATUS_FAILED
    }) {
        requeue(job, now);
        job.requester = "human".into();
        n += 1;
    }
    n
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
                    // 后台存下的与扩展「存到 Mesa」同一个广播：待获取清单就地翻「已存」
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
    let t = now();
    let picked = with_store(|s| {
        let released = s.jobs.iter().any(|j| j.status == STATUS_NEEDS_APPROVAL)
            && release_listed(s, |root| project_dois(Path::new(root)), t);
        let job = s.jobs.iter().find(|j| j.status == STATUS_QUEUED).cloned();
        ((job, released), released)
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
            log("oa", "no_oa");
            with_store(|s| {
                if let Some(j) = s.jobs.iter_mut().find(|j| j.id == job.id && j.status == STATUS_QUEUED) {
                    to_manual(j, now());
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
            if result.is_ok() {
                if let Ok(mut v) = SAVED.lock() {
                    v.push(j.clone());
                }
            }
        }
        ((), true)
    })
}

// ===== 扩展（经 helper 的 native messaging）=====

/// 扩展定时来打招呼（`mesa-poll-jobs`，2026-11-09 起不再发活）：只记「来过」，设置页据此显示「已连接」
pub fn helper_extension_ping() {
    let t = now();
    let _ = with_store(|s| {
        s.state.extension_seen_at = t;
        ((), true)
    });
}

// ===== Agent 用的命令行（mesa_helper paper …）=====

const USAGE: &str = "用法（Windows PowerShell 把 \"$MESA_PAPER_TOOL\" 写成 & $env:MESA_PAPER_TOOL）：
  \"$MESA_PAPER_TOOL\" paper fetch <DOI> [<DOI> …] [--wait 秒]   交给 Mesa 代下全文（默认最多等 60 秒）
  \"$MESA_PAPER_TOOL\" paper status [<DOI>]                       看这个项目代下到哪了";

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
        STATUS_NEEDS_APPROVAL => format!("{}：还不在项目文献清单里，等人放行；这一步保存进项目后会自动开始。先做别的，别自己去出版商网站下", job.doi),
        STATUS_FAILED => format!("{}：没取到——{}。这篇交给人获取，不要重试、不要换别的办法去下", job.doi, job.error.as_deref().unwrap_or("原因不明")),
        STATUS_MANUAL => format!("{}：没有开放获取版本，交给人在出版商官网下；留在 to-fetch 照常收尾，不要自己去出版商网站下", job.doi),
        STATUS_CANCELLED => format!("{}：人取消了这篇的代下", job.doi),
        _ => format!("{}：排队找开放获取版本", job.doi),
    }
}

pub fn helper_paper_cli(args: &[String]) -> i32 {
    let sub = args.first().map(String::as_str).unwrap_or("");
    // 主程序找 helper 时试跑：认得 paper 才算新版
    if sub == "--probe" {
        println!("ok");
        return 0;
    }
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
                let settled = jobs.iter().all(|j| j.finished() || j.status == STATUS_NEEDS_APPROVAL);
                if settled || std::time::Instant::now() >= deadline {
                    break jobs;
                }
                std::thread::sleep(std::time::Duration::from_secs(2));
            };
            for j in &jobs {
                println!("{}", describe(j));
            }
            if jobs.iter().any(|j| !j.finished()) {
                println!("还没结束的不用守着：Mesa 逐篇找开放获取版本，稍后用 paper status 查；不要重复提交，也不要自己去出版商网站下（会连累学校的访问）。");
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
        _ => {
            eprintln!("{USAGE}");
            2
        }
    }
}

// ===== 界面命令 =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewDto {
    pub extension_alive: bool,
    /// 扩展连上过（装好了）：没连上时界面说「浏览器没开着？」而不是再叫人安装
    pub extension_ever_seen: bool,
    pub jobs: Vec<Job>,
}

fn overview_of(store: &Store, root: Option<&str>, t: i64) -> OverviewDto {
    let state = &store.state;
    let mut jobs: Vec<Job> = store
        .jobs
        .iter()
        .filter(|j| root.map(|r| crate::paths::same_path(&j.project_root, r)).unwrap_or(true))
        .cloned()
        .collect();
    jobs.reverse();
    jobs.truncate(200);
    for j in &mut jobs {
        j.publisher = publisher_name(&publisher_key(&j.doi));
    }
    OverviewDto {
        extension_alive: t - state.extension_seen_at < EXTENSION_ALIVE_SECS,
        extension_ever_seen: state.extension_seen_at > 0,
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
            if !matches!(j.status.as_str(), STATUS_FAILED | STATUS_CANCELLED) {
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
pub async fn paper_fetch_retry_all(project_root: String) -> Result<usize, String> {
    blocking(move || with_store(|s| {
        let n = retry_failed_in(s, &project_root, now());
        (n, n > 0)
    }))
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
            j.updated_at = t;
            Ok(())
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
        // AI 交的清单外的篇在等放行，人再交一遍 = 放行
        let a2 = enqueue_in(&mut s, "/p", "10.1021/a", "", None, "human", None, 4);
        assert_eq!(a2.id, a.id);
        assert_eq!(a2.status, STATUS_QUEUED);
        assert_eq!(a2.requester, "human");
    }

    #[test]
    fn listed_after_save_releases_waiting_jobs() {
        let mut s = Store::default();
        enqueue_in(&mut s, "/p", "10.1021/a", "", None, "agent", Some(&allowed(&[])), 1);
        enqueue_in(&mut s, "/p", "10.1021/z", "", None, "agent", Some(&allowed(&[])), 1);
        enqueue_in(&mut s, "/q", "10.1021/a", "", None, "agent", Some(&allowed(&[])), 1);
        // 清单还没进项目：不动
        assert!(!release_listed(&mut s, |_| allowed(&[]), 2));
        // /p 保存进项目后清单里有 a：只放行 /p 的 a；z 不在清单、/q 是别的项目，照旧等
        assert!(release_listed(&mut s, |root| if root == "/p" { allowed(&["10.1021/a"]) } else { allowed(&[]) }, 3));
        let st: Vec<&str> = s.jobs.iter().map(|j| j.status.as_str()).collect();
        assert_eq!(st, vec![STATUS_QUEUED, STATUS_NEEDS_APPROVAL, STATUS_NEEDS_APPROVAL]);
        assert_eq!(s.jobs[0].requester, "agent");
    }

    #[test]
    fn retry_all_requeues_only_this_projects_failed() {
        let mut s = Store::default();
        for (root, doi, st) in [("/p", "10.1/a", STATUS_FAILED), ("/p", "10.1/b", STATUS_MANUAL), ("/p", "10.1/c", STATUS_DONE), ("/q", "10.1/d", STATUS_FAILED)] {
            let mut j = new_job(root, doi, "", None, "agent", 0);
            j.status = st.into();
            s.jobs.push(j);
        }
        assert_eq!(retry_failed_in(&mut s, "/p", 5), 1);
        let st: Vec<&str> = s.jobs.iter().map(|j| j.status.as_str()).collect();
        assert_eq!(st, vec![STATUS_QUEUED, STATUS_MANUAL, STATUS_DONE, STATUS_FAILED]);
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
