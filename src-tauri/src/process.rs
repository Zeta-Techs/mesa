//! 后台子进程的统一创建入口。
//!
//! Windows release 构建使用 `windows_subsystem = "windows"`，自身没有控制台；
//! 若直接启动 git/cmd 等 console 程序，系统会为每次调用创建可见控制台窗口，表现为
//! 终端页周期性闪黑窗。所有不需要独立可见窗口的命令必须经过这里。
//!
//! 这里同时在 spawn/wait 边界记录脱敏后的程序、参数、PID 与退出时间，供 Windows
//! 诊断包离线分析。环境变量不会进入记录。

use std::ffi::OsStr;
#[cfg(windows)]
use std::io;
#[cfg(windows)]
use std::ops::{Deref, DerefMut};
use std::path::Path;
use std::process::Command;
#[cfg(windows)]
use std::process::{Child, ExitStatus, Output, Stdio};

use portable_pty::CommandBuilder;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn configure_background(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(windows)]
pub struct BackgroundCommand {
    inner: Command,
}

#[cfg(not(windows))]
pub type BackgroundCommand = Command;

#[cfg(windows)]
pub struct TrackedChild {
    inner: Child,
    trace_id: Option<u64>,
}

#[cfg(windows)]
pub fn background_command<S: AsRef<OsStr>>(program: S) -> BackgroundCommand {
    // .cmd/.bat 批处理 shim 无法直接 CreateProcess（os error 193）：与 pty_command 同口径，
    // 优先深化为 node 直启（--version 探测、npm view 等都走这里），失败回落 cmd 包装
    let path = Path::new(program.as_ref());
    let mut command = if let Some((node, entry)) = node_entry_from_cmd_shim(path) {
        let mut c = Command::new(node);
        c.arg(entry);
        c
    } else if is_cmd_batch_shim(path) {
        let mut c = Command::new("cmd.exe");
        c.args(["/d", "/c", "call"]);
        c.arg(path);
        c
    } else {
        Command::new(program)
    };
    configure_background(&mut command);
    // 不把 Mesa 自己的 PWD 带给子进程（理由见非 Windows 版）
    command.env_remove("PWD");
    BackgroundCommand { inner: command }
}

/// 子进程不继承 Mesa 的 PWD：tauri dev / 从 shell 启动时 Mesa 带着启动它那个 shell 的 PWD，
/// 而 `opencode run` 取工作目录用 `process.env.PWD ?? cwd`——设了 current_dir 也照样跑到 Mesa 的启动目录去干活
/// （2026-10-20 实证：无头 opencode 把文件写进了 src-tauri/src）。删掉后 CLI 回落到真实工作目录，shell 会自己重算 PWD
#[cfg(not(windows))]
pub fn background_command<S: AsRef<OsStr>>(program: S) -> BackgroundCommand {
    let mut command = Command::new(program);
    command.env_remove("PWD");
    command
}

/// 构建 PTY 命令。Windows 上 npm 系 CLI（npm 自己、npm 全局装的 codex 等）是
/// .cmd/.bat 批处理 shim，ConPTY/CreateProcess 无法直接执行批处理文件：
/// 优先解析 shim 文本里的 JS 入口改用 node 直启——参数不再过 cmd 解析，
/// 含引号/百分号/& 的 prompt 与参数也不会被 cmd 吞掉或误展开；
/// shim 结构解析失败才回落 cmd /c call 包装。
pub fn pty_command(program: &Path, args: &[String]) -> CommandBuilder {
    #[cfg(windows)]
    {
        if let Some((node, entry)) = node_entry_from_cmd_shim(program) {
            let mut command = CommandBuilder::new(node);
            command.arg(entry);
            for arg in args {
                command.arg(arg);
            }
            return command;
        }
        if is_cmd_batch_shim(program) {
            let mut command = CommandBuilder::new("cmd.exe");
            command.args(["/d", "/c", "call"]);
            command.arg(program);
            for arg in args {
                command.arg(arg);
            }
            return command;
        }
    }

    let mut command = CommandBuilder::new(program);
    for arg in args {
        command.arg(arg);
    }
    command
}

/// 是否 .cmd/.bat 批处理 shim（Windows 的 CreateProcess 无法直接执行）
#[cfg(any(windows, test))]
fn is_cmd_batch_shim(program: &Path) -> bool {
    program
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

/// 从 npm 系 .cmd shim 文本提取相对 shim 目录的 JS 入口路径。
/// 兼容 cmd-shim 包的两代写法（`%~dp0\` 与 `%dp0%\`）；只认 .js 入口，
/// 跳过 shim 里对 node.exe 自身的引用。cfg(test) 下跨平台可测。
///
/// Node 官方安装器的 npm.cmd / npx.cmd 是变量化写法：`SET "NPX_CLI_JS=%~dp0\…\npx-cli.js"`，
/// 末行 `"%NODE_EXE%" "%NPX_CLI_JS%" %*` 才是真入口。同文件里 npm-prefix.js 也被
/// FOR /F 子命令以 `%NPM_PREFIX_JS%` 引用，所以取**最后一次**被引用的 .js 变量，不取第一个赋值。
#[cfg(any(windows, test))]
fn js_entry_from_shim(content: &str) -> Option<String> {
    fn rel_js(value: &str) -> Option<String> {
        for prefix in ["%~dp0\\", "%~dp0/", "%dp0%\\", "%dp0%/"] {
            if let Some(rest) = value.strip_prefix(prefix) {
                if rest.to_ascii_lowercase().ends_with(".js") {
                    return Some(rest.replace('/', "\\"));
                }
            }
        }
        None
    }
    let tokens: Vec<&str> = content
        .split(|c: char| c == '"' || c.is_whitespace())
        .filter(|t| !t.is_empty())
        .collect();
    let mut vars: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for token in &tokens {
        if let Some((name, value)) = token.split_once('=') {
            if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                if let Some(rel) = rel_js(value) {
                    vars.insert(name.to_ascii_uppercase(), rel);
                }
                continue;
            }
        }
        if let Some(rel) = rel_js(token) {
            return Some(rel);
        }
    }
    tokens.iter().rev().find_map(|token| {
        let name = token.strip_prefix('%')?.strip_suffix('%')?;
        vars.get(&name.to_ascii_uppercase()).cloned()
    })
}

/// Cursor CLI 的 Windows 启动器（官方 `irm https://cursor.com/install?win32=true | iex` 装到
/// %LOCALAPPDATA%\cursor-agent）：cursor-agent.cmd → PowerShell 跑 cursor-agent.ps1 → 在 versions\ 里挑最新版本目录，
/// 用其中自带的 node.exe 跑 index.js。这里照同一挑法直接拿到 (node.exe, index.js)：省掉 cmd 与 PowerShell
/// 两层转手（实测 --version 2.6 秒 → 0.9 秒），参数也不经 cmd / PowerShell 5.1 的引号规则
#[cfg(windows)]
fn cursor_entry_from_launcher(program: &Path) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let content = std::fs::read_to_string(program).ok()?;
    if !content.to_ascii_lowercase().contains("cursor-agent.ps1") {
        return None;
    }
    let versions = program.parent()?.join("versions");
    let names: Vec<String> = std::fs::read_dir(&versions)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    let dir = versions.join(pick_cursor_version(&names)?);
    let (node, entry) = (dir.join("node.exe"), dir.join("index.js"));
    (node.is_file() && entry.is_file()).then_some((node, entry))
}

/// 照 cursor-agent.ps1 的口径挑版本目录：名字形如 `YYYY.M.D-<提交>` 或 `YYYY.M.D-HH-MM-SS-<提交>`
/// （.staged / .previous 之类不算），按日期取最新，同日再按名字
#[cfg(any(windows, test))]
fn pick_cursor_version(names: &[String]) -> Option<String> {
    let key = |name: &str| -> Option<(u32, String)> {
        let (date, rest) = name.split_once('-')?;
        let parts: Vec<&str> = date.split('.').collect();
        if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
            return None;
        }
        let segs: Vec<&str> = rest.split('-').collect();
        let commit = segs.last()?;
        let stamp_ok = match segs.len() {
            1 => true,
            4 => segs[..3].iter().all(|s| s.len() == 2 && s.bytes().all(|b| b.is_ascii_digit())),
            _ => false,
        };
        if !stamp_ok || commit.is_empty() || !commit.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
            return None;
        }
        let num = format!("{}{:0>2}{:0>2}", parts[0], parts[1], parts[2]).parse().ok()?;
        Some((num, name.to_string()))
    };
    names.iter().filter_map(|n| key(n)).max().map(|(_, n)| n)
}

/// .cmd shim → (node 绝对路径, JS 入口绝对路径)：入口文件必须真实存在；
/// node 优先取 shim 同目录的 node.exe（官方 Node 布局），否则全局解析。
/// npm.cmd / npx.cmd 是 Node 安装器的变量化脚本，布局固定为
/// node_modules/npm/bin/{npm,npx}-cli.js，按文件名走特殊 case（文本解析兜底同样能认）；
/// 其余 shim（cmd-shim 包生成，如 codex.cmd）直接解析文本里的 %~dp0 入口。
///
/// MCP 分发也走这里：各 CLI 的 stdio server 必须落成 `node + js`，不能把 `.cmd`
/// 绝对路径写进 claude/codex 配置（CreateProcess 对 .cmd 是 os error 193）。
#[cfg(windows)]
pub(crate) fn node_entry_from_cmd_shim(
    program: &Path,
) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    if !is_cmd_batch_shim(program) {
        return None;
    }
    if let Some(found) = cursor_entry_from_launcher(program) {
        return Some(found);
    }
    let dir = program.parent()?;
    let name = program
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let entry = match name.as_str() {
        "npm.cmd" | "npx.cmd" => dir
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join(format!("{}-cli.js", &name[..3])),
        _ => {
            let content = std::fs::read_to_string(program).ok()?;
            dir.join(js_entry_from_shim(&content)?)
        }
    };
    if !entry.is_file() {
        return None;
    }
    let sibling = dir.join("node.exe");
    let node = if sibling.is_file() {
        sibling
    } else {
        crate::agents::resolve_binary("node")?
    };
    Some((node, entry))
}

#[cfg(windows)]
impl BackgroundCommand {
    pub fn arg<S: AsRef<OsStr>>(&mut self, arg: S) -> &mut Self {
        self.inner.arg(arg);
        self
    }

    pub fn args<I, S>(&mut self, args: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.inner.args(args);
        self
    }

    pub fn current_dir<P: AsRef<Path>>(&mut self, dir: P) -> &mut Self {
        self.inner.current_dir(dir);
        self
    }

    pub fn env<K: AsRef<OsStr>, V: AsRef<OsStr>>(&mut self, key: K, value: V) -> &mut Self {
        self.inner.env(key, value);
        self
    }

    pub fn envs<I, K, V>(&mut self, vars: I) -> &mut Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        self.inner.envs(vars);
        self
    }

    pub fn env_remove<K: AsRef<OsStr>>(&mut self, key: K) -> &mut Self {
        self.inner.env_remove(key);
        self
    }

    pub fn stdin<T: Into<Stdio>>(&mut self, cfg: T) -> &mut Self {
        self.inner.stdin(cfg);
        self
    }

    pub fn stdout<T: Into<Stdio>>(&mut self, cfg: T) -> &mut Self {
        self.inner.stdout(cfg);
        self
    }

    pub fn stderr<T: Into<Stdio>>(&mut self, cfg: T) -> &mut Self {
        self.inner.stderr(cfg);
        self
    }

    /// 透传 `CommandExt::raw_arg`：复合命令原文直投，绕过 Command::args 的引号加壳。
    /// 只供「cmd /C + start」这类 Windows 外部终端拉起调用点使用。
    pub fn raw_arg<S: AsRef<OsStr>>(&mut self, arg: S) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.inner.raw_arg(arg);
        self
    }

    pub fn spawn(&mut self) -> io::Result<TrackedChild> {
        let child = self.inner.spawn()?;
        let trace_id = crate::diagnostics::record_spawn(&self.inner, child.id());
        Ok(TrackedChild {
            inner: child,
            trace_id: Some(trace_id),
        })
    }

    pub fn output(&mut self) -> io::Result<Output> {
        self.stdout(Stdio::piped()).stderr(Stdio::piped());
        self.spawn()?.wait_with_output()
    }

    /// 等价 `Command::status()`：stdio 保持继承，起进程等退出；经 spawn() 保留进程追踪登记
    pub fn status(&mut self) -> io::Result<ExitStatus> {
        self.spawn()?.wait()
    }
}

#[cfg(windows)]
impl TrackedChild {
    fn record_exit(&mut self, status: &ExitStatus) {
        if let Some(trace_id) = self.trace_id.take() {
            crate::diagnostics::record_spawn_exit(trace_id, status.code());
        }
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.inner.try_wait()?;
        if let Some(ref status) = status {
            self.record_exit(status);
        }
        Ok(status)
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.inner.wait()?;
        self.record_exit(&status);
        Ok(status)
    }

    pub fn kill(&mut self) -> io::Result<()> {
        self.inner.kill()
    }

    pub fn wait_with_output(self) -> io::Result<Output> {
        let TrackedChild {
            inner,
            mut trace_id,
        } = self;
        let output = inner.wait_with_output();
        if let (Some(id), Ok(value)) = (trace_id.take(), output.as_ref()) {
            crate::diagnostics::record_spawn_exit(id, value.status.code());
        }
        output
    }
}

#[cfg(windows)]
impl Deref for TrackedChild {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

#[cfg(windows)]
impl DerefMut for TrackedChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.inner
    }
}

struct ActiveCapture {
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
fn captures() -> &'static std::sync::Mutex<std::collections::HashMap<String, ActiveCapture>> {
    static CAPTURES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, ActiveCapture>>,
    > = std::sync::OnceLock::new();
    CAPTURES.get_or_init(Default::default)
}
static SHUTTING_DOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub(crate) fn shutting_down() -> bool {
    SHUTTING_DOWN.load(std::sync::atomic::Ordering::Acquire)
}
pub(crate) fn capture_active(id: &str) -> bool {
    captures()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(id)
}
pub(crate) fn active_capture_ids() -> Vec<String> {
    captures()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .keys()
        .cloned()
        .collect()
}
pub(crate) fn capture_count() -> usize {
    captures().lock().unwrap_or_else(|e| e.into_inner()).len()
}
pub(crate) fn cancel_capture(id: &str) -> Result<(), String> {
    let registry = captures().lock().unwrap_or_else(|e| e.into_inner());
    let capture = registry.get(id).ok_or("任务未在此实例运行或已结束")?;
    capture
        .cancelled
        .store(true, std::sync::atomic::Ordering::Release);
    Ok(())
}
pub(crate) fn shutdown_captures() {
    SHUTTING_DOWN.store(true, std::sync::atomic::Ordering::Release);
    for capture in captures()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
    {
        capture
            .cancelled
            .store(true, std::sync::atomic::Ordering::Release);
    }
    // 每个捕获线程自行并发回收，不能在退出线程逐个等待 N 次 taskkill 超时。
}
struct CaptureRegistration(String);
impl Drop for CaptureRegistration {
    fn drop(&mut self) {
        captures()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

#[cfg(windows)]
struct CaptureJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl CaptureJob {
    fn assign(child: &TrackedChild) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(format!(
                    "创建进程任务组失败：{}",
                    std::io::Error::last_os_error()
                ));
            }
            let guard = Self(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job, child.inner.as_raw_handle() as _) == 0
            {
                return Err(format!(
                    "绑定进程任务组失败：{}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(guard)
        }
    }
    fn resume(child: &TrackedChild) -> Result<(), String> {
        use windows_sys::Win32::{
            Foundation::*,
            System::{Diagnostics::ToolHelp::*, Threading::*},
        };
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(format!(
                    "读取挂起线程失败：{}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            let mut more = Thread32First(snapshot, &mut entry);
            let mut resumed = false;
            while more != 0 {
                if entry.th32OwnerProcessID == child.id() {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !thread.is_null() {
                        resumed |= ResumeThread(thread) != u32::MAX;
                        CloseHandle(thread);
                    }
                }
                more = Thread32Next(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            if resumed {
                Ok(())
            } else {
                Err("无法恢复已加入任务组的进程".into())
            }
        }
    }
    fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}
#[cfg(windows)]
impl Drop for CaptureJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// 后台捕获的公共生命周期：父进程退出不是管道 EOF，deadline 覆盖两者。
/// 仅这些受管理的捕获命令建独立进程组，不改变打开外部应用等后台命令的语义。
#[derive(Debug)]
pub(crate) struct CapturedOutput {
    pub status: Option<std::process::ExitStatus>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub truncated: bool,
}

#[derive(Default)]
struct CaptureBuffer {
    bytes: Vec<u8>,
    truncated: bool,
    error: Option<String>,
}

fn capture_pipe<R: std::io::Read + Send + 'static>(
    mut pipe: R,
    cap: usize,
) -> (
    std::thread::JoinHandle<()>,
    std::sync::Arc<std::sync::Mutex<CaptureBuffer>>,
) {
    let buffer = std::sync::Arc::new(std::sync::Mutex::new(CaptureBuffer::default()));
    let shared = buffer.clone();
    let handle = std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let mut b = shared.lock().unwrap_or_else(|e| e.into_inner());
                    let keep = n.min(cap.saturating_sub(b.bytes.len()));
                    b.bytes.extend_from_slice(&chunk[..keep]);
                    b.truncated |= keep < n;
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    shared.lock().unwrap_or_else(|e| e.into_inner()).error = Some(e.to_string());
                    break;
                }
            }
        }
    });
    (handle, buffer)
}

pub(crate) fn capture_command(
    cmd: &mut BackgroundCommand,
    timeout: std::time::Duration,
    cap: usize,
) -> Result<CapturedOutput, String> {
    capture_command_for(cmd, timeout, cap, None)
}

pub(crate) fn capture_command_for(
    cmd: &mut BackgroundCommand,
    timeout: std::time::Duration,
    cap: usize,
    run_id: Option<&str>,
) -> Result<CapturedOutput, String> {
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    if shutting_down() {
        return Err("应用正在退出，拒绝启动新进程".into());
    }
    let id = run_id
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut registry = captures().lock().unwrap_or_else(|e| e.into_inner());
        if shutting_down() {
            return Err("应用正在退出，拒绝启动新进程".into());
        }
        if registry.contains_key(&id) {
            return Err("此任务已在执行".into());
        }
        registry.insert(
            id.clone(),
            ActiveCapture {
                cancelled: cancelled.clone(),
            },
        );
    }
    let _registration = CaptureRegistration(id.clone());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.inner.creation_flags(
            CREATE_NO_WINDOW | windows_sys::Win32::System::Threading::CREATE_SUSPENDED,
        );
    }
    let spawned = cmd.spawn();
    #[cfg(windows)]
    configure_background(&mut cmd.inner);
    let mut child = spawned.map_err(|e| format!("启动进程失败: {e}"))?;
    #[cfg(windows)]
    let job = match CaptureJob::assign(&child) {
        Ok(job) => {
            if let Err(error) = CaptureJob::resume(&child) {
                job.terminate();
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            job
        }
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let (out_thread, out) = capture_pipe(child.stdout.take().expect("piped stdout"), cap);
    let (err_thread, err) = capture_pipe(child.stderr.take().expect("piped stderr"), cap);
    let deadline = Instant::now() + timeout;
    let mut status = None;
    let mut failure = None;
    let mut timed_out = false;
    loop {
        if status.is_none() {
            match child.try_wait() {
                Ok(value) => status = value,
                Err(e) => {
                    failure = Some(format!("等待进程失败: {e}"));
                    break;
                }
            }
        }
        if status.is_some() && out_thread.is_finished() && err_thread.is_finished() {
            break;
        }
        if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            break;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let was_cancelled = cancelled.load(std::sync::atomic::Ordering::Acquire);
    if timed_out || was_cancelled || failure.is_some() {
        #[cfg(windows)]
        job.terminate();
        crate::pty::kill_process_tree(child.id());
        let _ = child.kill();
        let cleanup = Instant::now() + Duration::from_secs(2);
        while Instant::now() < cleanup {
            if status.is_none() {
                if let Ok(value) = child.try_wait() {
                    status = value;
                }
            }
            if status.is_some() && out_thread.is_finished() && err_thread.is_finished() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    // 未关闭的管道线程不阻塞返回；共享缓冲保留已收到的输出，且永不超过 cap。
    if out_thread.is_finished() {
        let _ = out_thread.join();
    }
    if err_thread.is_finished() {
        let _ = err_thread.join();
    }
    if let Some(error) = failure {
        return Err(error);
    }
    let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
    let mut err = err.lock().unwrap_or_else(|e| e.into_inner());
    if !timed_out {
        if let Some(error) = out.error.as_ref().or(err.error.as_ref()) {
            return Err(format!("读取进程输出失败: {error}"));
        }
    }
    Ok(CapturedOutput {
        status,
        stdout: std::mem::take(&mut out.bytes),
        stderr: std::mem::take(&mut err.bytes),
        timed_out,
        cancelled: was_cancelled,
        truncated: out.truncated || err.truncated,
    })
}

/// 带超时的读线程收尾：超时就放弃这个线程（它会在管道最终关闭时自行退出），
/// 不让漏网的子孙进程把调用方的工作线程永久钉死。
///
/// 超时路径必须用它而不是裸 `join()`：Windows 上包装层（`cmd /C`）之下的孙进程
/// 才是真正持有 stdout/stderr 管道写端的那个，只 kill 包装层的话读线程永远等不到 EOF。

/// 配合 `pty::kill_process_tree` 使用——先杀树消除根因，这里只是最后一道兜底。
pub(crate) fn join_with_timeout(
    handle: std::thread::JoinHandle<Vec<u8>>,
    timeout: std::time::Duration,
) -> Vec<u8> {
    let deadline = std::time::Instant::now() + timeout;
    while !handle.is_finished() {
        if std::time::Instant::now() > deadline {
            return Vec::new();
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    handle.join().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 子进程不继承 Mesa 的 PWD（opencode run 按 PWD 取目录）：环境里显式删掉，三平台同口径
    #[test]
    fn background_command_drops_inherited_pwd() {
        let c = background_command("definitely-not-a-real-program");
        #[cfg(windows)]
        let envs: Vec<_> = c.inner.get_envs().map(|(k, v)| (k.to_os_string(), v.map(|v| v.to_os_string()))).collect();
        #[cfg(not(windows))]
        let envs: Vec<_> = c.get_envs().map(|(k, v)| (k.to_os_string(), v.map(|v| v.to_os_string()))).collect();
        assert!(
            envs.iter().any(|(k, v)| k == "PWD" && v.is_none()),
            "PWD 应被删掉: {envs:?}"
        );
    }

    /// 真起一个子进程：设了工作目录、Mesa 自己又带着别的 PWD 时，子进程看不到那个 PWD
    #[test]
    fn child_does_not_see_parent_pwd() {
        let dir = std::env::temp_dir();
        #[cfg(windows)]
        let out = {
            let mut c = background_command("cmd.exe");
            c.args(["/d", "/c", "set PWD"]).current_dir(&dir).env("MESA_PROBE", "1");
            c.output().unwrap()
        };
        #[cfg(not(windows))]
        let out = {
            let mut c = background_command("/usr/bin/env");
            c.current_dir(&dir);
            c.output().unwrap()
        };
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(
            !text.lines().any(|l| l.starts_with("PWD=")),
            "子进程不该看到继承来的 PWD: {text}"
        );
    }

    #[test]
    fn cursor_version_pick_matches_launcher_rules() {
        let names: Vec<String> = [
            "2026.10.1-aaaa111",
            "2026.10.19-6bbf2c4",
            "2026.10.19-6bbf2c4.staged",
            "2026.10.19-12-30-00-ffff000",
            "2026.9.30-bbbb222",
            "notes",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        // 同日（10.19）两个都合规时按名字取大的；.staged 不算
        assert_eq!(pick_cursor_version(&names).as_deref(), Some("2026.10.19-6bbf2c4"));
        assert_eq!(
            pick_cursor_version(&["2026.9.30-bbbb222".into(), "2026.10.1-aaaa111".into()]).as_deref(),
            Some("2026.10.1-aaaa111"),
            "按日期数值比，不按字符串"
        );
        assert_eq!(pick_cursor_version(&["x".into()]), None);
    }

    /// 本机装了 Cursor CLI（官方 Windows 安装器）时：启动器解析到它自带的 node.exe + index.js
    #[cfg(windows)]
    #[test]
    fn cursor_launcher_resolves_to_bundled_node() {
        let Some(local) = dirs::data_local_dir() else { return };
        let launcher = local.join("cursor-agent").join("cursor-agent.cmd");
        if !launcher.is_file() {
            return;
        }
        let (node, entry) = node_entry_from_cmd_shim(&launcher).expect("应解析到版本目录");
        assert!(node.ends_with("node.exe") && entry.ends_with("index.js"), "{node:?} {entry:?}");
        let out = background_command(&launcher).arg("--version").output().unwrap();
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).trim().starts_with("20"), "{out:?}");
    }

    #[cfg(unix)]
    #[test]
    fn cancel_capture_stops_process_and_releases_registry() {
        let id = uuid::Uuid::new_v4().to_string();
        let thread_id = id.clone();
        let worker = std::thread::spawn(move || {
            capture_command_for(
                &mut shell("exec sleep 60"),
                std::time::Duration::from_secs(30),
                1024,
                Some(&thread_id),
            )
            .unwrap()
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !capture_active(&id) {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        cancel_capture(&id).unwrap();
        let output = worker.join().unwrap();
        assert!(output.cancelled);
        assert!(!capture_active(&id));
        assert!(cancel_capture(&id).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_capture_job_preserves_output_and_exit_code() {
        let mut command = background_command("cmd.exe");
        command.args(["/D", "/C", "echo out & echo err 1>&2 & exit /b 7"]);
        let output =
            capture_command(&mut command, std::time::Duration::from_secs(15), 1024).unwrap();
        assert_eq!(output.status.and_then(|s| s.code()), Some(7));
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "out");
        assert_eq!(String::from_utf8_lossy(&output.stderr).trim(), "err");
        assert!(!output.timed_out);
    }

    #[cfg(windows)]
    #[test]
    fn windows_capture_job_times_out_and_reaps_shell() {
        let mut command = background_command("cmd.exe");
        command.args(["/D", "/C", "echo started & ping -n 60 127.0.0.1 >nul"]);
        let output =
            capture_command(&mut command, std::time::Duration::from_secs(2), 1024).unwrap();
        assert!(output.timed_out);
        assert!(output.status.is_some());
        assert!(String::from_utf8_lossy(&output.stdout).contains("started"));
    }

    #[cfg(unix)]
    fn shell(script: &str) -> BackgroundCommand {
        let mut cmd = background_command("/bin/sh");
        cmd.args(["-c", script]);
        cmd
    }

    #[cfg(unix)]
    #[test]
    fn capture_keeps_stdout_stderr_and_exit_code() {
        let got = capture_command(
            &mut shell("printf out; printf err >&2; exit 7"),
            std::time::Duration::from_secs(10),
            1024,
        )
        .unwrap();
        assert_eq!(got.stdout, b"out");
        assert_eq!(got.stderr, b"err");
        assert_eq!(got.status.and_then(|s| s.code()), Some(7));
        assert!(!got.timed_out);
    }

    #[cfg(unix)]
    #[test]
    fn capture_deadline_applies_after_parent_exit_and_keeps_partial_output() {
        // 子进程继承管道但父进程退出；只检查状态/内容，不断言精确耗时。
        let got = capture_command(
            &mut shell("sleep 60 & printf partial; exit 0"),
            std::time::Duration::from_secs(2),
            1024,
        )
        .unwrap();
        assert!(got.timed_out);
        assert_eq!(got.stdout, b"partial");
    }

    #[cfg(unix)]
    #[test]
    fn capture_timeout_terminates_running_child() {
        let got = capture_command(
            &mut shell("printf started; exec sleep 60"),
            std::time::Duration::from_secs(2),
            1024,
        )
        .unwrap();
        assert!(got.timed_out);
        assert!(got.status.is_some(), "超时子进程必须被回收");
        assert_eq!(got.stdout, b"started");
    }

    #[test]
    fn capture_pipe_drains_after_cap_without_unbounded_memory() {
        let (thread, buffer) = capture_pipe(std::io::Cursor::new(vec![b'x'; 100_000]), 32);
        thread.join().unwrap();
        let buffer = buffer.lock().unwrap();
        assert_eq!(buffer.bytes, vec![b'x'; 32]);
        assert!(buffer.truncated);
        assert!(buffer.error.is_none());
    }

    #[test]
    fn capture_pipe_reports_read_error() {
        struct Broken;
        impl std::io::Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("broken"))
            }
        }
        let (thread, buffer) = capture_pipe(Broken, 32);
        thread.join().unwrap();
        assert_eq!(buffer.lock().unwrap().error.as_deref(), Some("broken"));
    }

    // cmd-shim 包现代格式（SET dp0 + "%dp0%\..."）
    const MODERN_SHIM: &str = r#"@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
"#;

    // cmd-shim 包旧格式（直接 "%~dp0\..."）
    const LEGACY_SHIM: &str = r#"@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\node_modules\npm\bin\npm-cli.js" %*
) ELSE (
  node  "%~dp0\node_modules\npm\bin\npm-cli.js" %*
)
"#;

    #[test]
    fn shim_parses_modern_dp0_format() {
        assert_eq!(
            js_entry_from_shim(MODERN_SHIM).as_deref(),
            Some(r"node_modules\@openai\codex\bin\codex.js")
        );
    }

    #[test]
    fn shim_parses_legacy_tilde_format() {
        assert_eq!(
            js_entry_from_shim(LEGACY_SHIM).as_deref(),
            Some(r"node_modules\npm\bin\npm-cli.js")
        );
    }

    #[test]
    fn shim_rejects_non_js_and_garbage() {
        // 只认 .js 入口：node.exe 引用、空 dp0、无关内容都不算
        assert_eq!(js_entry_from_shim("SET dp0=%~dp0"), None);
        assert_eq!(js_entry_from_shim("\"%~dp0\\node.exe\" %*"), None);
        assert_eq!(js_entry_from_shim("echo hello"), None);
        assert_eq!(js_entry_from_shim(""), None);
    }

    #[test]
    fn installer_style_shims_resolve_last_invoked_variable() {
        // Node 官方安装器的 npm.cmd / npx.cmd 用变量间接引用入口（实机采样）：
        // npm-prefix.js 先赋值也先被 FOR /F 引用，真入口是末行引用的 *_CLI_JS
        let installer = |var: &str, js: &str| {
            format!(
                ":: Created by npm, please don't edit manually.\r\n@ECHO OFF\r\n\r\nSETLOCAL\r\n\r\n\
                 SET \"NODE_EXE=%~dp0\\node.exe\"\r\nIF NOT EXIST \"%NODE_EXE%\" (\r\n  SET \"NODE_EXE=node\"\r\n)\r\n\r\n\
                 SET \"NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js\"\r\n\
                 SET \"{var}=%~dp0\\node_modules\\npm\\bin\\{js}\"\r\n\
                 FOR /F \"delims=\" %%F IN ('CALL \"%NODE_EXE%\" \"%NPM_PREFIX_JS%\"') DO (\r\n\
                 \x20 SET \"NPM_PREFIX_{var}=%%F\\node_modules\\npm\\bin\\{js}\"\r\n)\r\n\
                 IF EXIST \"%NPM_PREFIX_{var}%\" (\r\n  SET \"{var}=%NPM_PREFIX_{var}%\"\r\n)\r\n\r\n\
                 \"%NODE_EXE%\" \"%{var}%\" %*\r\n"
            )
        };
        assert_eq!(
            js_entry_from_shim(&installer("NPX_CLI_JS", "npx-cli.js")).as_deref(),
            Some(r"node_modules\npm\bin\npx-cli.js")
        );
        assert_eq!(
            js_entry_from_shim(&installer("NPM_CLI_JS", "npm-cli.js")).as_deref(),
            Some(r"node_modules\npm\bin\npm-cli.js")
        );
        // 只有赋值、没有被引用的变量不算入口
        assert_eq!(
            js_entry_from_shim("SET \"X_JS=%~dp0\\a.js\"\r\n\"%NODE_EXE%\" %*"),
            None
        );
    }

    /// 本机真实 Node 安装（C:\Program Files\nodejs）：npx.cmd 必须深化成 node + npx-cli.js，
    /// 不能把 .cmd 原样交回（MCP 分发写进 CLI 配置会 os error 193）
    #[cfg(windows)]
    #[test]
    fn real_npx_and_npm_cmd_resolve_to_node_entry() {
        for shim in ["npx.cmd", "npm.cmd"] {
            let Some(path) = crate::agents::resolve_binary(shim) else {
                continue;
            };
            if !path.is_file() {
                continue;
            }
            let (node, entry) = node_entry_from_cmd_shim(&path)
                .unwrap_or_else(|| panic!("{} 应解析出 node 入口", path.display()));
            assert!(node.is_file());
            let want = format!("{}-cli.js", &shim[..3]);
            assert!(entry.ends_with(std::path::Path::new(&want)), "{}", entry.display());
            // 文本解析兜底与按名 special case 一致
            let text = std::fs::read_to_string(&path).unwrap();
            if let Some(rel) = js_entry_from_shim(&text) {
                assert!(rel.ends_with(&want), "{rel}");
            }
        }
    }
}
