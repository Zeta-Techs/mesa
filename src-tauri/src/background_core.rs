//! 可选独立定时核心（2026-11-13，pipeline.md「分轮跟进与独立后台」）：同一可执行文件带 `--mesa-core` 起一个无窗口进程跑定时任务。
//! 与桌面之间只经配置目录下 `background-core/` 的文件往来：开关、停止、手动开跑请求与结果、取消、日志、事件信箱。
//! 桌面开着时负责看门（后台不在就拉起，拉不起就自己接着跑定时），并把后台的事件与日志转进界面与诊断页。
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

static CORE: AtomicBool = AtomicBool::new(false);
/// 桌面为更新 / 卸载停了后台：看门不再拉起，桌面也不接手定时（进程马上要退）
static HELD_FOR_EXIT: AtomicBool = AtomicBool::new(false);

/// 后台停下的最长等待：后台先停掉在跑的任务再等它们收尾（10 秒），这里留足余量
const STOP_WAIT: Duration = Duration::from_secs(30);
/// 手动开跑交给后台后，最多等它这么久给出「启动成功 / 没启动成」
const MANUAL_WAIT: Duration = Duration::from_secs(8);
/// 后台日志文件超过这个大小就轮换一份
const LOG_CAP_BYTES: u64 = 512 * 1024;
/// 桌面没开期间攒下的事件，超过这么久就不再弹（只删）
const OUTBOX_STALE: Duration = Duration::from_secs(24 * 3600);

pub(crate) fn is_core() -> bool { CORE.load(Ordering::Acquire) }

fn path(name: &str) -> Result<PathBuf, String> {
    Ok(crate::storage::config_root().ok_or("无法确定后台配置目录")?.join("background-core").join(name))
}

fn ensure_dir(name: &str) -> Result<PathBuf, String> {
    let dir = path(name)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

pub(crate) fn enabled() -> bool {
    path("enabled").is_ok_and(|path| path.exists())
}

/// 后台开着且确实在跑：这时定时任务归后台执行，桌面只转交请求
pub(crate) fn owns_runs() -> bool {
    !is_core() && enabled() && running().unwrap_or(false)
}

pub(crate) fn cancel_run(run_id: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(run_id).is_err() { return Err("运行编号无效".into()); }
    if !running()? {
        return Err("独立后台没在运行，这次运行已不在执行；重新打开 Mesa 会自动收口它".into());
    }
    let file = ensure_dir("")?.join(format!("cancel-{run_id}"));
    crate::storage::atomic_write(&file, b"cancel", true)
}

fn cancel_requested(run_id: &str) -> bool {
    path(&format!("cancel-{run_id}")).is_ok_and(|path| path.exists())
}

/// 取消请求用完即删；对应运行已不在跑（结束或从未在后台）且请求超过一天的也删，免得越攒越多
fn sweep_cancels() {
    let Ok(dir) = path("") else { return };
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(run_id) = name.strip_prefix("cancel-") else { continue };
        if crate::process::capture_active(run_id) { continue }
        let closed = crate::runs::run_get_sync(run_id.to_string()).ok().flatten().is_none_or(|run| run.closed_at.is_some());
        let old = entry.metadata().and_then(|meta| meta.modified()).ok()
            .and_then(|time| SystemTime::now().duration_since(time).ok())
            .is_some_and(|age| age > Duration::from_secs(24 * 3600));
        if closed || old { let _ = fs::remove_file(entry.path()); }
    }
}

#[derive(Serialize, Deserialize)]
struct ManualRequest { id: String, note: Option<String> }

/// 手动「立即跑」交给后台：写请求、等后台接手，后台没启动成的原因原样带回（不再只落一个 .failed 文件）
pub(crate) fn request_manual(id: &str, note: Option<String>) -> Result<(), String> {
    if !crate::scheduler::schedule_id_ok(id) { return Err("定时任务编号无效".into()); }
    let dir = ensure_dir("")?;
    let file = dir.join(format!("manual-{id}.json"));
    let claimed = dir.join(format!("manual-{id}.claimed"));
    let failed = dir.join(format!("manual-{id}.failed"));
    {
        let _lock = crate::storage::config_lock("background-core-control")?;
        if file.exists() || claimed.exists() { return Err("这条任务已交给后台，等待启动".into()); }
        let _ = fs::remove_file(&failed);
        crate::storage::atomic_write(&file, &serde_json::to_vec(&ManualRequest { id: id.into(), note }).map_err(|error| error.to_string())?, true)?;
    }
    let deadline = Instant::now() + MANUAL_WAIT;
    while Instant::now() < deadline {
        if let Ok(reason) = fs::read_to_string(&failed) {
            let _ = fs::remove_file(&failed);
            return Err(reason);
        }
        if !file.exists() && !claimed.exists() { return Ok(()) }
        std::thread::sleep(Duration::from_millis(100));
    }
    // 后台一直没接手：撤回请求，免得它以后某个时刻突然开跑
    let _lock = crate::storage::config_lock("background-core-control")?;
    match fs::remove_file(&file) {
        Ok(()) => Err("独立后台没有接手这次运行，已撤回；请在设置→诊断查看后台日志".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()), // 刚被接手
        Err(error) => Err(error.to_string()),
    }
}

fn run_manual_requests() -> Result<(), String> {
    let dir = path("")?;
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("manual-") || !name.ends_with(".json") { continue; }
        let claimed = entry.path().with_extension("claimed");
        let failed = entry.path().with_extension("failed");
        // 一份坏请求只废它自己：改名成 .failed 带上原因，接着处理后面的
        if let Err(error) = fs::rename(entry.path(), &claimed) {
            crate::logbuf::record("error", "background", &format!("后台没能接手请求 {name}：{error}"));
            continue;
        }
        let outcome = fs::read(&claimed).map_err(|error| error.to_string())
            .and_then(|bytes| serde_json::from_slice::<ManualRequest>(&bytes).map_err(|error| format!("请求内容损坏：{error}")))
            .and_then(|request| crate::scheduler::run_schedule_now_impl(None, request.id, request.note));
        match outcome {
            Ok(()) => { let _ = fs::remove_file(&claimed); }
            Err(error) => {
                crate::logbuf::record("error", "background", &format!("后台任务没能启动：{error}"));
                let _ = crate::storage::atomic_write(&failed, error.as_bytes(), true);
                let _ = fs::remove_file(&claimed);
            }
        }
    }
    Ok(())
}

// ===== 事件信箱与日志：后台没有窗口，事件与日志落文件，由桌面转进界面 =====

#[derive(Serialize, Deserialize)]
struct OutboxEvent { event: String, payload: serde_json::Value }

/// 后台进程里发事件（scheduler-run-started / scheduler-run-done 等）：写进信箱，桌面开着时转发给界面
pub(crate) fn post_event<T: Serialize>(event: &str, payload: &T) {
    let write = || -> Result<(), String> {
        let dir = ensure_dir("outbox")?;
        let name = format!("{}-{}.json", chrono::Utc::now().format("%Y%m%dT%H%M%S%.6f"), uuid::Uuid::new_v4());
        let body = OutboxEvent { event: event.into(), payload: serde_json::to_value(payload).map_err(|error| error.to_string())? };
        crate::storage::atomic_write(&dir.join(name), &serde_json::to_vec(&body).map_err(|error| error.to_string())?, true)
    };
    if let Err(error) = write() { crate::logbuf::record("warn", "background", &format!("后台事件没写进信箱：{error}")); }
}

static LOG_FILE: Mutex<()> = Mutex::new(());

/// 后台进程的诊断日志落文件（logbuf::record 在后台进程里调用）；超过上限轮换一份
pub(crate) fn append_log<T: Serialize>(entry: &T) {
    let Ok(_guard) = LOG_FILE.lock() else { return };
    let Ok(file) = path("core.log") else { return };
    if fs::create_dir_all(file.parent().unwrap_or(&file)).is_err() { return }
    if fs::metadata(&file).is_ok_and(|meta| meta.len() > LOG_CAP_BYTES) {
        let _ = fs::rename(&file, file.with_extension("log.1"));
    }
    let Ok(line) = serde_json::to_string(entry) else { return };
    if let Ok(mut out) = fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(out, "{line}");
    }
}

/// 桌面已读到后台日志的哪个位置（进程内记，桌面重启从头读一次，日志文件有上限）
static LOG_OFFSET: Mutex<u64> = Mutex::new(0);

fn forward_logs() {
    let Ok(file) = path("core.log") else { return };
    let Ok(text) = fs::read(&file) else { return };
    let Ok(mut offset) = LOG_OFFSET.lock() else { return };
    if (text.len() as u64) < *offset { *offset = 0; } // 轮换过
    let fresh = &text[*offset as usize..];
    let Some(end) = fresh.iter().rposition(|byte| *byte == b'\n') else { return };
    for line in String::from_utf8_lossy(&fresh[..=end]).lines() {
        if let Ok(entry) = serde_json::from_str::<crate::logbuf::LogEntryDto>(line) {
            crate::logbuf::ingest_background(entry);
        }
    }
    *offset += end as u64 + 1;
}

fn forward_events(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let Ok(dir) = path("outbox") else { return };
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<_> = entries.flatten().map(|entry| entry.path()).filter(|path| path.extension().is_some_and(|ext| ext == "json")).collect();
    files.sort();
    for file in files.into_iter().take(50) {
        let stale = fs::metadata(&file).and_then(|meta| meta.modified()).ok()
            .and_then(|time| SystemTime::now().duration_since(time).ok())
            .is_some_and(|age| age > OUTBOX_STALE);
        if !stale {
            if let Some(event) = fs::read(&file).ok().and_then(|bytes| serde_json::from_slice::<OutboxEvent>(&bytes).ok()) {
                if let Err(error) = app.emit(&event.event, event.payload) {
                    crate::logbuf::record("warn", "background", &format!("转发后台事件失败：{error}"));
                }
            }
        }
        let _ = fs::remove_file(file);
    }
}

/// 桌面调度线程每轮调用：转发后台事件与日志
pub(crate) fn forward_to_desktop(app: Option<&tauri::AppHandle>) {
    forward_logs();
    if let Some(app) = app { forward_events(app); }
}

static LAST_START_ATTEMPT: Mutex<Option<Instant>> = Mutex::new(None);
static DOWN_REPORTED: AtomicBool = AtomicBool::new(false);

/// 桌面看门：独立后台开着却没在运行（崩溃、注销后、被系统杀掉）时至多每 30 秒拉一次。
/// 返回 true = 后台在跑，桌面不接手定时；false = 后台起不来，桌面这一轮自己跑定时。
pub(crate) fn desktop_watchdog() -> bool {
    if HELD_FOR_EXIT.load(Ordering::Acquire) { return true }
    if running().unwrap_or(false) {
        DOWN_REPORTED.store(false, Ordering::Release);
        return true;
    }
    let due = LAST_START_ATTEMPT.lock().map(|mut last| {
        let due = last.is_none_or(|time| time.elapsed() >= Duration::from_secs(30));
        if due { *last = Some(Instant::now()); }
        due
    }).unwrap_or(false);
    if due {
        if let Err(error) = start_if_enabled() {
            crate::logbuf::record("error", "background", &format!("独立后台没在运行，重新拉起失败：{error}"));
        }
    }
    let up = running().unwrap_or(false);
    if !up && !DOWN_REPORTED.swap(true, Ordering::AcqRel) {
        crate::logbuf::record("warn", "background", "独立后台没在运行，桌面开着期间由桌面接着跑定时任务");
        // 后台崩溃留下的在跑记录：只收无人持有租约的，不误伤活着的进程
        if let Err(error) = crate::runs::reconcile_stale_runs() {
            crate::logbuf::record("warn", "background", &format!("收口后台遗留运行失败：{error}"));
        }
    }
    up
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub enabled: bool,
    pub running: bool,
    /// 后台正在跑的运行数（关闭后台会停掉它们）
    pub active: usize,
}

pub(crate) fn running() -> Result<bool, String> {
    let file = path("core.lock")?;
    fs::create_dir_all(file.parent().ok_or("没有配置目录")?).map_err(|error| error.to_string())?;
    let file = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(file).map_err(|error| error.to_string())?;
    match file.try_lock() {
        Ok(()) => Ok(false),
        Err(fs::TryLockError::WouldBlock) => Ok(true),
        Err(error) => Err(format!("不能确定后台状态：{error}")),
    }
}

fn status() -> Result<CoreStatus, String> {
    let running = running()?;
    let active = if running { crate::runs::open_background_watch_runs().map(|runs| runs.len()).unwrap_or(0) } else { 0 };
    Ok(CoreStatus { enabled: enabled(), running, active })
}

pub(crate) fn start_if_enabled() -> Result<(), String> {
    if !enabled() || HELD_FOR_EXIT.load(Ordering::Acquire) || running()? { return Ok(()) }
    let stop = path("stop")?;
    match fs::remove_file(stop) { Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}, Err(error) => return Err(error.to_string()) }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = crate::process::background_command(executable);
    command.arg("--mesa-core").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; command.process_group(0); }
    command.spawn().map_err(|error| format!("后台没能启动：{error}"))?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if running()? { return Ok(()) }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("后台启动未确认，未假装运行；请查看诊断后重试".into())
}

pub(crate) fn stop() -> Result<(), String> {
    if !running()? { return Ok(()) }
    let file = path("stop")?;
    crate::storage::atomic_write(&file, b"stop", true)?;
    let deadline = Instant::now() + STOP_WAIT;
    while Instant::now() < deadline {
        if !running()? { return Ok(()) }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("后台尚未停止，未继续更新或删除；请稍后重试".into())
}

/// 更新 / 卸载前停后台：停成后本进程不再拉起它（新版本启动时会按开关重新拉起）
pub(crate) fn stop_for_exit() -> Result<(), String> {
    HELD_FOR_EXIT.store(true, Ordering::Release);
    let result = stop();
    if result.is_err() { HELD_FOR_EXIT.store(false, Ordering::Release); }
    result
}

/// 后台正在跑的定时 Run id（关后台前给人确认用）
#[tauri::command]
pub async fn background_core_active_runs() -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        if !running().unwrap_or(false) {
            return Ok(Vec::new());
        }
        Ok(crate::runs::open_background_watch_runs()?
            .into_iter()
            .map(|id| serde_json::json!({ "id": id }))
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn background_core_status() -> Result<CoreStatus, String> {
    tauri::async_runtime::spawn_blocking(status).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn background_core_set(enabled: bool) -> Result<CoreStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = crate::storage::config_lock("background-core-control")?;
        let file = path("enabled")?;
        fs::create_dir_all(file.parent().ok_or("没有配置目录")?).map_err(|error| error.to_string())?;
        if enabled {
            crate::storage::atomic_write(&file, b"enabled", true)?;
            if let Err(error) = start_if_enabled() {
                let _ = fs::remove_file(file);
                return Err(error);
            }
        } else {
            stop()?;
            match fs::remove_file(file) { Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}, Err(error) => return Err(error.to_string()) }
        }
        status()
    }).await.map_err(|error| error.to_string())?
}

pub fn run() -> Result<(), String> {
    CORE.store(true, Ordering::Release);
    let file = path("core.lock")?;
    fs::create_dir_all(file.parent().ok_or("没有配置目录")?).map_err(|error| error.to_string())?;
    let _lock = crate::storage::lock_at(&file)?;
    if !enabled() { return Ok(()) }
    crate::logbuf::record("info", "background", "独立后台已启动");
    if let Err(error) = crate::runs::reconcile_stale_runs() {
        crate::logbuf::record("warn", "background", &format!("收口上次未完成的运行失败：{error}"));
    }
    crate::scheduler::start_scheduler(None);
    let mut ticks: u32 = 0;
    while enabled() && !path("stop")?.exists() {
        if let Err(error) = run_manual_requests() { crate::logbuf::record("error", "background", &error); }
        for run_id in crate::process::active_capture_ids() {
            if cancel_requested(&run_id) {
                let _ = crate::process::cancel_capture(&run_id);
                let _ = fs::remove_file(path(&format!("cancel-{run_id}"))?);
            }
        }
        ticks = ticks.wrapping_add(1);
        if ticks % 240 == 0 { sweep_cancels(); } // 约每分钟
        std::thread::sleep(Duration::from_millis(250));
    }
    crate::logbuf::record("info", "background", "独立后台收到停止，正在停掉在跑的任务");
    crate::process::shutdown_captures();
    let deadline = Instant::now() + Duration::from_secs(10);
    while (crate::process::capture_count() > 0 || crate::scheduler::active_schedule_count() > 0) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if crate::process::capture_count() > 0 || crate::scheduler::active_schedule_count() > 0 {
        let error = "后台收尾未完成，保留在途记录供下次核对".to_string();
        crate::logbuf::record("error", "background", &error);
        return Err(error);
    }
    crate::logbuf::record("info", "background", "独立后台已停止");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn background_defaults_off_and_lock_is_identity_not_pid() {
        let dir = std::env::temp_dir().join(format!("mesa-core-test-{}", uuid::Uuid::new_v4()));
        let _root = crate::storage::redirect_config_root(&dir);
        assert!(!enabled());
        assert!(!running().unwrap());
        let lock = crate::storage::lock_at(&path("core.lock").unwrap()).unwrap();
        assert!(running().unwrap());
        drop(lock);
        assert!(!running().unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cancel_refuses_when_core_is_down_and_outbox_roundtrips() {
        let dir = std::env::temp_dir().join(format!("mesa-core-outbox-{}", uuid::Uuid::new_v4()));
        let _root = crate::storage::redirect_config_root(&dir);
        let run_id = uuid::Uuid::new_v4().to_string();
        assert!(cancel_run(&run_id).unwrap_err().contains("没在运行"));
        assert!(!cancel_requested(&run_id));
        post_event("scheduler-run-done", &serde_json::json!({ "scheduleId": "a" }));
        let files: Vec<_> = fs::read_dir(path("outbox").unwrap()).unwrap().flatten().collect();
        assert_eq!(files.len(), 1);
        let event: OutboxEvent = serde_json::from_slice(&fs::read(files[0].path()).unwrap()).unwrap();
        assert_eq!(event.event, "scheduler-run-done");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn broken_manual_request_fails_alone_and_logs_flow_to_desktop() {
        let dir = std::env::temp_dir().join(format!("mesa-core-manual-{}", uuid::Uuid::new_v4()));
        let _root = crate::storage::redirect_config_root(&dir);
        let base = ensure_dir("").unwrap();
        fs::write(base.join("manual-bad.json"), b"{not json").unwrap();
        run_manual_requests().unwrap();
        assert!(fs::read_to_string(base.join("manual-bad.failed")).unwrap().contains("损坏"));
        assert!(!base.join("manual-bad.json").exists() && !base.join("manual-bad.claimed").exists());
        append_log(&serde_json::json!({ "ts": "2026-11-13T00:00:00Z", "level": "error", "source": "scheduler", "message": "后台出错样例" }));
        forward_logs();
        assert!(crate::logbuf::get_app_log(500).iter().any(|entry| entry.message == "后台出错样例" && entry.source.starts_with("后台")));
        fs::remove_dir_all(dir).unwrap();
    }
}
