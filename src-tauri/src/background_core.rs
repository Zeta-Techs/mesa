use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

static CORE: AtomicBool = AtomicBool::new(false);

pub(crate) fn is_core() -> bool { CORE.load(Ordering::Acquire) }

fn path(name: &str) -> Result<PathBuf, String> {
    Ok(crate::storage::config_root().ok_or("无法确定后台配置目录")?.join("background-core").join(name))
}

pub(crate) fn enabled() -> bool {
    path("enabled").is_ok_and(|path| path.exists())
}

pub(crate) fn cancel_run(run_id: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(run_id).is_err() { return Err("运行编号无效".into()); }
    let file = path(&format!("cancel-{run_id}"))?;
    fs::create_dir_all(file.parent().ok_or("没有配置目录")?).map_err(|error| error.to_string())?;
    crate::storage::atomic_write(&file, b"cancel", true)
}

pub(crate) fn cancel_requested(run_id: &str) -> bool {
    path(&format!("cancel-{run_id}")).is_ok_and(|path| path.exists())
}

#[derive(Serialize, Deserialize)]
struct ManualRequest { id: String, note: Option<String> }

pub(crate) fn request_manual(id: &str, note: Option<String>) -> Result<(), String> {
    if !crate::scheduler::schedule_id_ok(id) { return Err("定时任务编号无效".into()); }
    start_if_enabled()?;
    let file = path(&format!("manual-{id}.json"))?;
    let _lock = crate::storage::config_lock("background-core-control")?;
    if file.exists() { return Err("这条任务已交给后台，等待启动".into()); }
    crate::storage::atomic_write(&file, &serde_json::to_vec(&ManualRequest { id: id.into(), note }).map_err(|error| error.to_string())?, true)
}

fn run_manual_requests() -> Result<(), String> {
    let dir = path("")?;
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("manual-") || !name.ends_with(".json") { continue; }
        let request: ManualRequest = serde_json::from_slice(&fs::read(entry.path()).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
        let claimed = entry.path().with_extension("claimed");
        fs::rename(entry.path(), &claimed).map_err(|error| error.to_string())?;
        match crate::scheduler::run_schedule_now_impl(None, request.id, request.note) {
            Ok(()) => fs::remove_file(&claimed).map_err(|error| error.to_string())?,
            Err(error) => {
                crate::logbuf::record("error", "background", &format!("后台任务没能启动：{error}"));
                fs::rename(&claimed, claimed.with_extension("failed")).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub enabled: bool,
    pub running: bool,
}

fn running() -> Result<bool, String> {
    let file = path("core.lock")?;
    fs::create_dir_all(file.parent().ok_or("没有配置目录")?).map_err(|error| error.to_string())?;
    let file = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(file).map_err(|error| error.to_string())?;
    match file.try_lock() {
        Ok(()) => Ok(false),
        Err(fs::TryLockError::WouldBlock) => Ok(true),
        Err(error) => Err(format!("不能确定后台状态：{error}")),
    }
}

pub(crate) fn start_if_enabled() -> Result<(), String> {
    if !enabled() || running()? { return Ok(()) }
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
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if !running()? { return Ok(()) }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("后台尚未停止，未继续更新或删除；请稍后重试".into())
}

#[tauri::command]
pub async fn background_core_status() -> Result<CoreStatus, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(CoreStatus { enabled: enabled(), running: running()? })).await.map_err(|error| error.to_string())?
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
        Ok(CoreStatus { enabled, running: running()? })
    }).await.map_err(|error| error.to_string())?
}

pub fn run() -> Result<(), String> {
    CORE.store(true, Ordering::Release);
    let file = path("core.lock")?;
    fs::create_dir_all(file.parent().ok_or("没有配置目录")?).map_err(|error| error.to_string())?;
    let _lock = crate::storage::lock_at(&file)?;
    if !enabled() { return Ok(()) }
    crate::scheduler::start_scheduler(None);
    while enabled() && !path("stop")?.exists() {
        if let Err(error) = run_manual_requests() { crate::logbuf::record("error", "background", &error); }
        for run_id in crate::process::active_capture_ids() {
            if cancel_requested(&run_id) { let _ = crate::process::cancel_capture(&run_id); }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    crate::process::shutdown_captures();
    let deadline = Instant::now() + Duration::from_secs(10);
    while (crate::process::capture_count() > 0 || crate::scheduler::active_schedule_count() > 0) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if crate::process::capture_count() > 0 || crate::scheduler::active_schedule_count() > 0 { return Err("后台收尾未完成，保留在途记录供下次核对".into()); }
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
}
