//! 一键诊断包：系统/WebView/GPU/输入法、应用日志、功能开关与进程生命周期。
//!
//! 进程监控只保留 Mesa 子孙进程，以及系统输入法进程（ctfmon/TextInputHost）；
//! 不读取子进程环境变量。命令参数在进入环形缓冲前即做密钥脱敏。

#[cfg(windows)]
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::Path;
#[cfg(windows)]
use std::process::Command;
#[cfg(windows)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
#[cfg(windows)]
use sysinfo::{Pid, ProcessesToUpdate, System};

use crate::sessions::{now_iso, redact_sensitive_text};

const PROCESS_HISTORY_CAP: usize = 2_000;
const PROCESS_POLL_MS: u64 = 250;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendDiagnosticsDto {
    pub user_agent: String,
    pub language: String,
    pub languages: Vec<String>,
    pub platform: String,
    pub device_pixel_ratio: f64,
    pub screen: Value,
    pub webgl: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessRecord {
    pid: u32,
    parent_pid: Option<u32>,
    program: String,
    executable: Option<String>,
    args: Vec<String>,
    scope: String,
    category: Option<String>,
    started_at: String,
    last_seen_at: String,
    ended_at: Option<String>,
    cpu_usage: f32,
    memory_bytes: u64,
    status: String,
    capture_method: String,
    start_time_estimated: bool,
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
struct ProcessKey {
    pid: u32,
    started: u64,
}

#[derive(Default)]
struct ProcessStore {
    active: HashMap<ProcessKey, ProcessRecord>,
    history: VecDeque<ProcessRecord>,
}

#[derive(Default)]
struct SpawnTraceStore {
    active: HashMap<u64, ProcessRecord>,
    history: VecDeque<ProcessRecord>,
}

fn process_store() -> &'static Mutex<ProcessStore> {
    static STORE: OnceLock<Mutex<ProcessStore>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(ProcessStore::default()))
}

fn spawn_trace_store() -> &'static Mutex<SpawnTraceStore> {
    static STORE: OnceLock<Mutex<SpawnTraceStore>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(SpawnTraceStore::default()))
}

// ===== Windows 专属：spawn-hook 与进程扫描 =====
// 非 Windows 平台不启动监控线程、不经 BackgroundCommand 包装（见 process.rs），
// 以下函数仅 Windows 与测试引用；诊断导出在非 Windows 平台只产出空的进程列表。

#[cfg(windows)]
pub(crate) fn record_spawn(command: &Command, pid: u32) -> u64 {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let program_path = command.get_program().to_string_lossy().into_owned();
    let program = Path::new(&program_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| program_path.clone());
    let args = command
        .get_args()
        .map(|value| redact_arg(&value.to_string_lossy()))
        .collect();
    let now = now_iso();
    let record = ProcessRecord {
        pid,
        parent_pid: Some(std::process::id()),
        program: program.clone(),
        executable: Some(program_path),
        args,
        scope: "ccode-child".into(),
        category: watched_category(&program).map(str::to_string),
        started_at: now.clone(),
        last_seen_at: now,
        ended_at: None,
        cpu_usage: 0.0,
        memory_bytes: 0,
        status: "running".into(),
        capture_method: "spawn-hook".into(),
        start_time_estimated: false,
    };
    if let Ok(mut store) = spawn_trace_store().lock() {
        store.active.insert(id, record);
    }
    id
}

#[cfg(windows)]
pub(crate) fn record_spawn_exit(id: u64, exit_code: Option<i32>) {
    let Ok(mut store) = spawn_trace_store().lock() else {
        return;
    };
    let Some(mut record) = store.active.remove(&id) else {
        return;
    };
    let now = now_iso();
    record.last_seen_at = now.clone();
    record.ended_at = Some(now);
    record.status = exit_code
        .map(|code| format!("exit:{code}"))
        .unwrap_or_else(|| "exited".into());
    if store.history.len() >= PROCESS_HISTORY_CAP {
        store.history.pop_front();
    }
    store.history.push_back(record);
}

#[cfg(windows)]
fn iso_from_unix(seconds: u64) -> String {
    DateTime::<Utc>::from_timestamp(seconds as i64, 0)
        .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(now_iso)
}

#[cfg(windows)]
fn watched_category(name: &str) -> Option<&'static str> {
    let normalized = name.to_ascii_lowercase();
    match normalized.trim_end_matches(".exe") {
        "git" => Some("git"),
        "cmd" | "powershell" | "pwsh" => Some("shell"),
        "conhost" => Some("console-host"),
        "ctfmon" | "textinputhost" => Some("input-method"),
        "msedgewebview2" => Some("webview2"),
        _ => None,
    }
}

#[cfg(windows)]
fn is_input_process(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    matches!(
        normalized.trim_end_matches(".exe"),
        "ctfmon" | "textinputhost"
    )
}

#[cfg(windows)]
fn is_descendant(pid: Pid, root: Pid, processes: &HashMap<Pid, sysinfo::Process>) -> bool {
    let mut current = pid;
    let mut seen = HashSet::new();
    for _ in 0..64 {
        if !seen.insert(current) {
            return false;
        }
        let Some(parent) = processes.get(&current).and_then(|p| p.parent()) else {
            return false;
        };
        if parent == root {
            return true;
        }
        current = parent;
    }
    false
}

#[cfg(windows)]
fn redact_arg(value: &str) -> String {
    redact_sensitive_text(value).chars().take(4_000).collect()
}

#[cfg(windows)]
fn sample_processes(system: &System, root: Pid) -> HashMap<ProcessKey, ProcessRecord> {
    let now = now_iso();
    let mut result = HashMap::new();
    for (pid, process) in system.processes() {
        if *pid == root {
            continue;
        }
        let name = process.name().to_string_lossy().to_ascii_lowercase();
        let child = is_descendant(*pid, root, system.processes());
        let input = is_input_process(&name);
        if !child && !input {
            continue;
        }
        let started = process.start_time();
        let start_time_estimated = started == 0;
        let key = ProcessKey {
            pid: pid.as_u32(),
            started,
        };
        let args = if child {
            process
                .cmd()
                .iter()
                .map(|v| redact_arg(&v.to_string_lossy()))
                .collect()
        } else {
            Vec::new()
        };
        result.insert(
            key,
            ProcessRecord {
                pid: pid.as_u32(),
                parent_pid: process.parent().map(Pid::as_u32),
                program: process.name().to_string_lossy().into_owned(),
                executable: process.exe().map(|p| p.to_string_lossy().into_owned()),
                args,
                scope: if child {
                    "ccode-child".into()
                } else {
                    "system-input".into()
                },
                category: watched_category(&name).map(str::to_string),
                started_at: if start_time_estimated {
                    now.clone()
                } else {
                    iso_from_unix(started)
                },
                last_seen_at: now.clone(),
                ended_at: None,
                cpu_usage: process.cpu_usage(),
                memory_bytes: process.memory(),
                status: format!("{:?}", process.status()).to_ascii_lowercase(),
                capture_method: "process-scan".into(),
                start_time_estimated,
            },
        );
    }
    result
}

#[cfg(windows)]
fn apply_sample(sample: HashMap<ProcessKey, ProcessRecord>) {
    let Ok(mut store) = process_store().lock() else {
        return;
    };
    let now = now_iso();
    let current: HashSet<_> = sample.keys().copied().collect();
    let ended: Vec<_> = store
        .active
        .keys()
        .filter(|key| !current.contains(key))
        .copied()
        .collect();
    for key in ended {
        if let Some(mut record) = store.active.remove(&key) {
            record.ended_at = Some(now.clone());
            if store.history.len() >= PROCESS_HISTORY_CAP {
                store.history.pop_front();
            }
            store.history.push_back(record);
        }
    }
    for (key, next) in sample {
        if let Some(current) = store.active.get_mut(&key) {
            current.last_seen_at = next.last_seen_at;
            current.cpu_usage = next.cpu_usage;
            current.memory_bytes = next.memory_bytes;
            current.status = next.status;
            if current.args.is_empty() && !next.args.is_empty() {
                current.args = next.args;
            }
            if current.executable.is_none() {
                current.executable = next.executable;
            }
        } else {
            store.active.insert(key, next);
        }
    }
}

#[cfg(windows)]
pub fn start_process_monitor() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("ccode-process-monitor".into())
        .spawn(|| {
            let root = Pid::from_u32(std::process::id());
            let mut system = System::new();
            loop {
                system.refresh_processes(ProcessesToUpdate::All, true);
                apply_sample(sample_processes(&system, root));
                std::thread::sleep(Duration::from_millis(PROCESS_POLL_MS));
            }
        });
}

#[cfg(not(windows))]
pub fn start_process_monitor() {}

fn process_snapshots() -> (Vec<ProcessRecord>, Vec<ProcessRecord>) {
    let Ok(store) = process_store().lock() else {
        return (Vec::new(), Vec::new());
    };
    let mut all: Vec<_> = store.history.iter().cloned().collect();
    let mut active: Vec<_> = store.active.values().cloned().collect();
    drop(store);
    let mut traced_pids = HashSet::new();
    if let Ok(traces) = spawn_trace_store().lock() {
        traced_pids.extend(traces.history.iter().map(|record| record.pid));
        traced_pids.extend(traces.active.values().map(|record| record.pid));
        all.retain(|record| {
            record.capture_method != "process-scan"
                || record.scope != "ccode-child"
                || !traced_pids.contains(&record.pid)
        });
        active.retain(|record| {
            record.capture_method != "process-scan"
                || record.scope != "ccode-child"
                || !traced_pids.contains(&record.pid)
        });
        all.extend(traces.history.iter().cloned());
        all.extend(traces.active.values().cloned());
        active.extend(traces.active.values().cloned());
    }
    all.extend(active.iter().cloned());
    all.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.pid.cmp(&b.pid)));
    active.sort_by(|a, b| a.category.cmp(&b.category).then(a.pid.cmp(&b.pid)));
    (all, active)
}

#[cfg(windows)]
fn collect_platform_info() -> Value {
    let script = r#"
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$cv=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$wvPath=(Get-Process msedgewebview2 | Select-Object -First 1 -ExpandProperty Path)
$wvVersion=if($wvPath){(Get-Item $wvPath).VersionInfo.ProductVersion}else{$null}
$gpu=@(Get-CimInstance Win32_VideoController | ForEach-Object {[pscustomobject]@{name=$_.Name;driverVersion=$_.DriverVersion;videoProcessor=$_.VideoProcessor;adapterRam=$_.AdapterRAM;status=$_.Status;pnpDeviceId=$_.PNPDeviceID}})
$langs=@(Get-WinUserLanguageList | ForEach-Object {[pscustomobject]@{languageTag=$_.LanguageTag;autonym=$_.Autonym;englishName=$_.EnglishName;inputMethodTips=@($_.InputMethodTips)}})
$defaultIme=Get-WinDefaultInputMethodOverride
$active=$null
try {
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MesaInputLayout {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint threadId);
}
'@
$thread=[MesaInputLayout]::GetWindowThreadProcessId([MesaInputLayout]::GetForegroundWindow(),[IntPtr]::Zero)
$hkl=[MesaInputLayout]::GetKeyboardLayout($thread).ToInt64()
$langId=[int]($hkl -band 0xffff)
$culture=try{[System.Globalization.CultureInfo]::GetCultureInfo($langId).Name}catch{$null}
$active=[pscustomobject]@{threadId=$thread;keyboardLayout=('0x{0:X8}' -f ($hkl -band 0xffffffffL));culture=$culture}
} catch {}
[pscustomobject]@{
  windows=[pscustomobject]@{productName=$cv.ProductName;displayVersion=$cv.DisplayVersion;releaseId=$cv.ReleaseId;currentBuild=$cv.CurrentBuild;ubr=$cv.UBR;editionId=$cv.EditionID;installationType=$cv.InstallationType}
  webView2=[pscustomobject]@{version=$wvVersion;executable=$wvPath}
  gpu=$gpu
  language=[pscustomobject]@{culture=(Get-Culture).Name;uiCulture=(Get-UICulture).Name;systemLocale=(Get-WinSystemLocale).Name;defaultInputMethod=$defaultIme;activeInputMethod=$active;userLanguages=$langs}
} | ConvertTo-Json -Depth 7 -Compress
"#;
    let mut cmd = crate::process::background_command("powershell");
    let output = cmd
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output();
    match output {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            serde_json::from_str(text.trim()).unwrap_or_else(|e| {
                json!({"error": format!("解析 Windows 诊断信息失败: {e}"), "raw": redact_arg(&text)})
            })
        }
        Ok(out) => json!({
            "error": "采集 Windows 诊断信息失败",
            "stderr": redact_arg(&String::from_utf8_lossy(&out.stderr))
        }),
        Err(e) => json!({"error": format!("启动 PowerShell 采集失败: {e}")}),
    }
}

#[cfg(not(windows))]
fn collect_platform_info() -> Value {
    json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "family": std::env::consts::FAMILY,
        "note": "Windows 专属的 WebView2/GPU/输入法系统采集在当前平台不适用"
    })
}

fn feature_flags() -> Value {
    let settings = crate::settings::current_with_defaults();
    let ai_functions: Vec<String> = settings
        .ai_profiles
        .unwrap_or_default()
        .into_keys()
        .collect();
    json!({
        "theme": settings.theme,
        "terminalPalette": settings.terminal_palette,
        "terminalFontFamily": settings.terminal_font_family,
        "terminalFontSize": settings.terminal_font_size,
        "scrollback": settings.scrollback,
        "brewMirror": settings.brew_mirror,
        "notificationsEnabled": settings.notifications_enabled,
        "hooksAttention": settings.hooks_attention,
        "externalTerminal": settings.external_terminal,
        "hotkeyPaletteEnabled": settings.hotkey_palette.as_deref().is_some_and(|v| !v.is_empty()),
        "hotkeyHideChromeEnabled": settings.hotkey_hide_chrome.as_deref().is_some_and(|v| !v.is_empty()),
        "hotkeyPageSwitch": settings.hotkey_page_switch,
        "aiDefaultProfileConfigured": settings.ai_profile_id.is_some(),
        "aiFunctionProfilesConfigured": ai_functions,
        "debugBuild": cfg!(debug_assertions),
    })
}

fn add_json<T: Serialize>(
    writer: &mut zip::ZipWriter<fs::File>,
    name: &str,
    value: &T,
) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    add_text(writer, name, &text)
}

fn add_text(writer: &mut zip::ZipWriter<fs::File>, name: &str, text: &str) -> Result<(), String> {
    writer
        .start_file(name, zip::write::SimpleFileOptions::default())
        .map_err(|e| format!("写入诊断包失败: {e}"))?;
    writer
        .write_all(text.as_bytes())
        .map_err(|e| format!("写入诊断包失败: {e}"))
}

/// 诊断包 README（随包分发）。平台分支：Windows 有系统级采集清单；
/// 其余平台 system.json 只是简表，别让包自称 Windows 包（2026-10-12 口径统一）。
#[cfg(windows)]
const BUNDLE_README: &str = "Mesa 诊断包\n\n用途：遇到问题时导出，附到「反馈与提需求」发给维护者；也可以自己解压查看。全部文件为 UTF-8 JSON/TXT，无需安装任何工具。\n\nsystem.json：Windows、WebView2、显卡、语言与输入法\nfrontend.json：WebView 用户代理、语言、屏幕与 WebGL Renderer\nfeature-flags.json：当前功能开关（不含密钥与 profile id）\nprocess-lifecycle.json：Mesa 子孙进程及输入法进程的开始/结束记录；captureMethod=spawn-hook 表示由启动边界精确登记参数，process-scan 表示进程扫描补充，startTimeEstimated=true 表示开始时间为首次观察时间\nprocess-active.json：导出时仍活动的相关进程\napp-log.json / app-log.txt：应用诊断日志\n\n安全：不采集环境变量；参数与日志会脱敏，但路径和普通参数仍可能包含项目名称。发送给他人前可先解压检查。\n";

#[cfg(not(windows))]
const BUNDLE_README: &str = "Mesa 诊断包\n\n用途：遇到问题时导出，附到「反馈与提需求」发给维护者；也可以自己解压查看。全部文件为 UTF-8 JSON/TXT，无需安装任何工具。\n\nsystem.json：当前平台简表（Windows 专属的 WebView2 / 显卡 / 输入法系统采集在本平台不适用）\nfrontend.json：WebView 用户代理、语言、屏幕与 WebGL Renderer\nfeature-flags.json：当前功能开关（不含密钥与 profile id）\nprocess-lifecycle.json / process-active.json：Mesa 子孙进程的开始/结束与活动记录\napp-log.json / app-log.txt：应用诊断日志\n\n安全：不采集环境变量；参数与日志会脱敏，但路径和普通参数仍可能包含项目名称。发送给他人前可先解压检查。\n";

fn write_bundle(
    path: &Path,
    frontend: &FrontendDiagnosticsDto,
    platform: &Value,
    processes: &[ProcessRecord],
    active: &[ProcessRecord],
) -> Result<(), String> {
    let tmp = path.with_extension("zip.tmp");
    if tmp.exists() {
        fs::remove_file(&tmp).map_err(|e| format!("清理旧诊断包临时文件失败: {e}"))?;
    }
    let file = fs::File::create(&tmp).map_err(|e| format!("创建诊断包失败: {e}"))?;
    let mut writer = zip::ZipWriter::new(file);
    let exported_at = now_iso();
    add_json(
        &mut writer,
        "manifest.json",
        &json!({
            "formatVersion": 2,
            "exportedAt": exported_at,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "processPollMs": PROCESS_POLL_MS,
            "processHistoryCap": PROCESS_HISTORY_CAP,
            "offlineAnalysis": "UTF-8 JSON/TXT，可在 macOS/Linux/Windows 直接解压分析，无需 Mesa 或 Windows 专用工具",
            "privacy": "不包含子进程环境变量；命令参数与应用日志已按已保存密钥和常见密钥前缀脱敏。路径、项目名和非密钥参数仍会保留，请发送前按需检查。"
        }),
    )?;
    add_json(&mut writer, "system.json", platform)?;
    add_json(&mut writer, "frontend.json", frontend)?;
    add_json(&mut writer, "feature-flags.json", &feature_flags())?;
    add_json(
        &mut writer,
        "audit-evidence.json",
        &json!({
            "auditReport": "docs/audits/ccode-product-audit-2026-09-05.md",
            "evidencePolicy": "仅记录审查报告位置、可复核命令与本次导出时间；不打包原始会话、密钥或全文项目文件。",
            "verificationCommands": ["npm test", "npm run build", "cargo test", "git diff --check"],
            "crossPlatformMatrix": "docs/qa/ui-matrix.md",
            "generatedAt": now_iso()
        }),
    )?;
    add_json(&mut writer, "process-lifecycle.json", &processes)?;
    add_json(&mut writer, "process-active.json", &active)?;

    let mut logs = crate::logbuf::get_app_log(500);
    for entry in &mut logs {
        entry.source = redact_sensitive_text(&entry.source);
        entry.message = redact_sensitive_text(&entry.message);
    }
    add_json(&mut writer, "app-log.json", &logs)?;
    let log_text = logs
        .iter()
        .map(|l| format!("{} [{}] {}: {}", l.ts, l.level, l.source, l.message))
        .collect::<Vec<_>>()
        .join("\n");
    add_text(&mut writer, "app-log.txt", &log_text)?;
    add_text(&mut writer, "README.txt", BUNDLE_README)?;
    let file = writer
        .finish()
        .map_err(|e| format!("完成诊断包失败: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("同步诊断包失败: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("落盘诊断包失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn export_diagnostics_bundle(frontend: FrontendDiagnosticsDto) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let platform = collect_platform_info();
        // 让进程监控线程有机会记录本次 PowerShell 采集进程及其退出时间。
        std::thread::sleep(Duration::from_millis(PROCESS_POLL_MS + 100));
        let (processes, active) = process_snapshots();
        let dir = dirs::download_dir()
            .ok_or("无法确定下载目录")?
            .join("ccode-exports");
        fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败: {e}"))?;
        let path = dir.join(format!(
            "ccode-diagnostics-{}.zip",
            now_iso().replace([':', '.'], "-")
        ));
        write_bundle(&path, &frontend, &platform, &processes, &active)?;
        crate::logbuf::record(
            "info",
            "diagnostics",
            &format!("诊断包已导出: {}", path.display()),
        );
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("导出诊断包任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn watched_process_names_are_classified() {
        assert_eq!(watched_category("git.exe"), Some("git"));
        assert_eq!(watched_category("conhost.exe"), Some("console-host"));
        assert_eq!(watched_category("TextInputHost.exe"), Some("input-method"));
        assert_eq!(watched_category("random.exe"), None);
        assert!(is_input_process("ctfmon.exe"));
        assert!(!is_input_process("cmd.exe"));
    }

    #[cfg(windows)]
    #[test]
    fn spawn_hook_keeps_program_args_and_exit_time() {
        let pid = 4_000_001;
        let mut command = Command::new("git");
        command.args(["status", "--short"]);
        let id = record_spawn(&command, pid);
        record_spawn_exit(id, Some(0));
        let (records, _) = process_snapshots();
        let record = records
            .iter()
            .find(|record| record.pid == pid && record.capture_method == "spawn-hook")
            .expect("spawn-hook 记录缺失");
        assert_eq!(record.program, "git");
        assert_eq!(record.args, ["status", "--short"]);
        assert_eq!(record.parent_pid, Some(std::process::id()));
        assert!(record.ended_at.is_some());
        assert_eq!(record.status, "exit:0");
        assert!(!record.start_time_estimated);
    }

    #[test]
    fn bundle_contains_required_entries() {
        let dir = std::env::temp_dir().join(format!("ccode-diag-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("diag.zip");
        let frontend = FrontendDiagnosticsDto {
            user_agent: "test".into(),
            language: "zh-CN".into(),
            languages: vec!["zh-CN".into()],
            platform: "test".into(),
            device_pixel_ratio: 1.0,
            screen: json!({}),
            webgl: json!({"renderer": "test"}),
        };
        write_bundle(&path, &frontend, &json!({"windows": {}}), &[], &[]).unwrap();
        let file = fs::File::open(&path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        for name in [
            "manifest.json",
            "system.json",
            "frontend.json",
            "feature-flags.json",
            "process-lifecycle.json",
            "process-active.json",
            "app-log.json",
            "app-log.txt",
            "README.txt",
        ] {
            assert!(zip.by_name(name).is_ok(), "缺少 {name}");
        }
        fs::remove_dir_all(dir).ok();
    }
}
