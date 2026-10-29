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
    // 优先深化为 node 直启（--version 探测、npm view 等都走这里）或 shim 指向的原生 exe，失败回落 cmd 包装
    let path = Path::new(program.as_ref());
    let mut command = if let Some((node, entry)) = node_entry_from_cmd_shim(path) {
        let mut c = Command::new(node);
        c.arg(entry);
        c
    } else if let Some(exe) = exe_from_cmd_shim(path) {
        Command::new(exe)
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
    // 刚装的 Git / Node.js 等：子进程拿注册表里的新 PATH（见 child_path）
    if let Some(path) = child_path() {
        command.env("PATH", path);
    }
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

/// Windows 上 Agent 起的 Python：stdout/stderr 接管道时按系统代码页编码（中文系统是 GBK），
/// 打印 `²` `⁺` 这类字符直接 UnicodeEncodeError，Agent 读回的中文也成乱码（2026-10-21 实测）。
/// 只设 PYTHONIOENCODING（标准输入输出），不设 PYTHONUTF8：后者连 `open()` 的默认编码一起改，
/// 会让 Agent 写的、读 GBK 文件的脚本行为变掉。用户自己设过就尊重。
/// 控制台（ConPTY）里的 Python 输出本来就是 UTF-8，不受影响。
/// Agent 加 `-I` / `-E` 时本变量失效，靠任务书「本机 Python（Windows）」提示改加 `-X utf8`（task-md.ts）。
pub fn agent_python_io_env() -> Option<(&'static str, &'static str)> {
    python_io_env_for(cfg!(windows), std::env::var_os("PYTHONIOENCODING").as_deref())
}

fn python_io_env_for(windows: bool, existing: Option<&OsStr>) -> Option<(&'static str, &'static str)> {
    if windows && existing.is_none() {
        Some(("PYTHONIOENCODING", "utf-8"))
    } else {
        None
    }
}

/// 从访达 / 程序坞启动的 Mesa 没有 LANG（只有短 PATH 和 `__CF_USER_TEXT_ENCODING`），之后起的 shell、Agent、
/// ls / lsof 都跑在 C 语言环境里：中文文件名显示成 `????` 或 `\xe7…`，zsh 里打中文变 `<e7>`
/// （2026-10-27 本机：打包版 Codex 子进程无 LANG）。启动时照「终端」App 的做法补 `LANG=<系统地区>.UTF-8`，
/// 本机没有该地区的 UTF-8 locale 就用 en_US.UTF-8；LANG / LC_ALL / LC_CTYPE 已有任一个（从终端启动）不动。
/// 必须在起任何线程之前调（set_var 不是线程安全的，同 agents::extend_process_path）。
#[cfg(target_os = "macos")]
pub fn ensure_utf8_locale() {
    let has = |key: &str| std::env::var_os(key).is_some_and(|v| !v.is_empty());
    if has("LANG") || has("LC_ALL") || has("LC_CTYPE") {
        return;
    }
    let id = objc2_foundation::NSLocale::currentLocale()
        .localeIdentifier()
        .to_string();
    let lang = utf8_lang_for(&id, |name| Path::new("/usr/share/locale").join(name).is_dir());
    std::env::set_var("LANG", lang);
}

/// 系统地区标识（`zh_CN`、`zh-Hans_CN`、`en_US@rg=cnzzzz`）→ `zh_CN.UTF-8`；本机没有这个 locale 就 en_US.UTF-8
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn utf8_lang_for(identifier: &str, exists: impl Fn(&str) -> bool) -> String {
    let base = identifier.split('@').next().unwrap_or("");
    let lang = base.split(['-', '_']).next().unwrap_or("");
    let region = base.rsplit_once('_').map(|(_, r)| r).unwrap_or("");
    if !lang.is_empty() && !region.is_empty() {
        let name = format!("{lang}_{region}.UTF-8");
        if exists(&name) {
            return name;
        }
    }
    "en_US.UTF-8".into()
}

/// Windows 注册表里的字符串值：`reg query <键> /ve`（默认值）或 `/v <值名>`。读不到返回 None。
/// 用来找装在非默认目录的外部应用（EndNote 装在 D 盘、Zotero 的 App Paths），不写注册表。
#[cfg(windows)]
pub fn reg_string(key: &str, name: Option<&str>) -> Option<String> {
    let mut cmd = background_command("reg");
    cmd.args(["query", key]);
    match name {
        Some(name) => cmd.args(["/v", name]),
        None => cmd.arg("/ve"),
    };
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    reg_sz_value(&String::from_utf8_lossy(&out.stdout))
}

/// `reg query` 输出里第一个字符串值：取 REG_SZ / REG_EXPAND_SZ 之后那一段，原样（引号留给调用方按用途处理）
/// （值名列是本地化的「(默认)」/「(Default)」，不认它）
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub fn reg_sz_value(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (_, value) = line
            .split_once("REG_EXPAND_SZ")
            .or_else(|| line.split_once("REG_SZ"))?;
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// 子进程用的 PATH。Windows 进程的 PATH 只在启动那一刻从注册表拼一次：Mesa 开着时一键补齐装的
/// Git / Node.js / Python 已写进注册表 PATH，但 Mesa 起的 Agent、内置终端、MCP 服务器继承的还是旧那份，
/// Agent 里 `git` `node` `npx` 一律 not recognized，重启 Mesa 才好（新机器走上手向导必经这一步）。
/// 这里取「本进程 PATH + 注册表（系统、用户）PATH 里新出现的目录（追加在末尾）」，原有顺序不动。
/// None = 没有新目录，照常继承。macOS / Linux 启动时已补（agents::extend_process_path），不走这里。
#[cfg(windows)]
pub fn child_path() -> Option<std::ffi::OsString> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    let current = std::env::var_os("PATH").unwrap_or_default();
    let current = current.to_str()?;
    let registry: Vec<String> = [
        (HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        (HKEY_CURRENT_USER, "Environment"),
    ]
    .into_iter()
    .filter_map(|(root, key)| registry_path_value(root, key))
    .collect();
    merged_windows_path(current, &registry).map(Into::into)
}

/// 注册表里的 `Path` 值（REG_EXPAND_SZ 由 RegGetValueW 展开 `%SystemRoot%` 一类变量；按 UTF-16 读，中文目录不乱码）
#[cfg(windows)]
fn registry_path_value(root: windows_sys::Win32::System::Registry::HKEY, subkey: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ};
    const ERROR_MORE_DATA: u32 = 234;
    let key: Vec<u16> = subkey.encode_utf16().chain([0]).collect();
    let name: Vec<u16> = "Path".encode_utf16().chain([0]).collect();
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
    let mut size: u32 = 0;
    let rc = unsafe {
        RegGetValueW(root, key.as_ptr(), name.as_ptr(), flags, std::ptr::null_mut(), std::ptr::null_mut(), &mut size)
    };
    if rc != 0 || size < 2 {
        return None;
    }
    // 展开后可能比先问到的长度更长：按返回的新长度再取，最多三次
    for _ in 0..3 {
        let mut buf = vec![0u16; (size as usize).div_ceil(2)];
        let rc = unsafe {
            RegGetValueW(root, key.as_ptr(), name.as_ptr(), flags, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size)
        };
        match rc {
            0 => {
                let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                return String::from_utf16(&buf[..len]).ok();
            }
            ERROR_MORE_DATA => continue,
            _ => return None,
        }
    }
    None
}

/// child_path 的纯逻辑：注册表里有、当前 PATH 里没有的目录追加在末尾（按 Windows 语义比较：
/// 大小写、正反斜杠、末尾斜杠不计）；没有要补的返回 None
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn merged_windows_path(current: &str, registry: &[String]) -> Option<String> {
    let mut seen: std::collections::HashSet<String> = current
        .split(';')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(crate::paths::path_key_folded)
        .collect();
    let mut added: Vec<&str> = Vec::new();
    for entry in registry.iter().flat_map(|value| value.split(';')).map(str::trim) {
        if !entry.is_empty() && seen.insert(crate::paths::path_key_folded(entry)) {
            added.push(entry);
        }
    }
    if added.is_empty() {
        return None;
    }
    let mut out = current.trim_end_matches(';').to_string();
    for entry in added {
        if !out.is_empty() {
            out.push(';');
        }
        out.push_str(entry);
    }
    Some(out)
}

/// 注册表里登记的打开命令（`"D:\…\EndNote.EXE" "%1"`）里的可执行文件路径
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub fn command_line_exe(command: &str) -> Option<std::path::PathBuf> {
    let command = command.trim();
    let exe = if let Some(rest) = command.strip_prefix('"') {
        rest.split('"').next()?
    } else {
        command.split_whitespace().next()?
    };
    (!exe.is_empty()).then(|| std::path::PathBuf::from(exe))
}

/// 构建 PTY 命令。Windows 上 npm 系 CLI（npm 自己、npm 全局装的 codex 等）是
/// .cmd/.bat 批处理 shim，ConPTY/CreateProcess 无法直接执行批处理文件：
/// 优先解析 shim 文本里的 JS 入口改用 node 直启，或 shim 直接调用的原生 exe（npm 装的
/// Claude Code、OpenCode）改为直启——参数不再过 cmd 解析，含引号/百分号/& 的 prompt 与参数
/// 也不会被 cmd 吞掉或误展开（2026-10-20 实测：经 cmd 包装时多行首条消息只剩第一行、
/// `%PATH%` 被展开、引号里的 `|` 让 Claude 根本起不来）；shim 结构解析失败才回落 cmd /c call 包装。
pub fn pty_command(program: &Path, args: &[String]) -> CommandBuilder {
    let mut command = pty_command_base(program, args);
    if let Some((key, value)) = agent_python_io_env() {
        command.env(key, value);
    }
    #[cfg(windows)]
    if let Some(path) = child_path() {
        command.env("PATH", path);
    }
    command
}

fn pty_command_base(program: &Path, args: &[String]) -> CommandBuilder {
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
        if let Some(exe) = exe_from_cmd_shim(program) {
            let mut command = CommandBuilder::new(exe);
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

/// shim 文本里以 `%dp0%\` / `%~dp0\` 起头引用的相对路径，按出现顺序（分隔符统一成 `\`）
#[cfg(any(windows, test))]
fn dp0_targets(content: &str) -> Vec<String> {
    content
        .split(|c: char| c == '"' || c.is_whitespace())
        .filter_map(|t| {
            ["%~dp0\\", "%~dp0/", "%dp0%\\", "%dp0%/"]
                .iter()
                .find_map(|p| t.strip_prefix(p))
        })
        .filter(|rest| !rest.is_empty())
        .map(|rest| rest.replace('/', "\\"))
        .collect()
}

#[cfg(any(windows, test))]
fn is_node_exe(rel: &str) -> bool {
    rel.eq_ignore_ascii_case("node.exe")
}

/// 直接调用原生 exe 的 shim（npm 装的 Claude Code、OpenCode：`"%dp0%\…\bin\claude.exe"   %*`）→ exe 相对路径。
/// 引用了 node.exe 的是 Node 系 shim（走 js 入口），不算
#[cfg(any(windows, test))]
fn exe_entry_from_shim(content: &str) -> Option<String> {
    let targets = dp0_targets(content);
    if targets.iter().any(|t| is_node_exe(t)) {
        return None;
    }
    let last = targets.last()?;
    last.to_ascii_lowercase().ends_with(".exe").then(|| last.clone())
}

/// Node 系 shim 的无扩展名入口（CodeBuddy：`"%_prog%"  "%dp0%\…\bin\codebuddy" %*`）。
/// 是不是 node 脚本由调用方读文件首行（`#!/usr/bin/env node`）确认
#[cfg(any(windows, test))]
fn bare_script_entry_from_shim(content: &str) -> Option<String> {
    let targets = dp0_targets(content);
    if !targets.iter().any(|t| is_node_exe(t)) {
        return None;
    }
    let last = targets.iter().rev().find(|t| !is_node_exe(t))?;
    let name = last.rsplit('\\').next()?;
    (!name.contains('.')).then(|| last.clone())
}

/// 文件首行是不是 node 的 shebang
#[cfg(windows)]
fn is_node_script(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 128];
    let Ok(n) = std::fs::File::open(path).and_then(|mut f| f.read(&mut head)) else {
        return false;
    };
    let first = String::from_utf8_lossy(&head[..n]);
    let line = first.lines().next().unwrap_or("");
    line.starts_with("#!") && line.contains("node")
}

/// 直接调用原生 exe 的 .cmd shim → exe 绝对路径（文件必须真实存在）；起进程时用它直启，参数不过 cmd
#[cfg(windows)]
pub(crate) fn exe_from_cmd_shim(program: &Path) -> Option<std::path::PathBuf> {
    if !is_cmd_batch_shim(program) {
        return None;
    }
    let content = std::fs::read_to_string(program).ok()?;
    let exe = program.parent()?.join(exe_entry_from_shim(&content)?);
    exe.is_file().then_some(exe)
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
            // .js 入口优先；CodeBuddy 这类无扩展名的 node 脚本入口要先确认 shebang
            let rel = js_entry_from_shim(&content).or_else(|| {
                let rel = bare_script_entry_from_shim(&content)?;
                is_node_script(&dir.join(&rel)).then_some(rel)
            })?;
            dir.join(rel)
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

    /// 起一个与 Mesa 同生共死的长驻后台进程（聊天层 Codex 私有 app-server）：挂进一个「句柄关闭即全杀」的
    /// 进程任务组，Mesa 崩溃、被强杀、或退出流程没来得及收尾时，它和它派生的孙进程（node → codex.exe）
    /// 一并由系统回收，不留占端口、占会话写锁的孤儿。先挂起、入组、再恢复，免得入组前就派生出孙进程逃出去；
    /// 入组失败照常运行（只是少了这层兜底），不挡启动。
    pub fn spawn_tied_to_app(&mut self) -> io::Result<TrackedChild> {
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::process::CommandExt;
        self.inner.creation_flags(
            CREATE_NO_WINDOW | windows_sys::Win32::System::Threading::CREATE_SUSPENDED,
        );
        let spawned = self.spawn();
        configure_background(&mut self.inner);
        let mut child = spawned?;
        let tied = match app_lifetime_job() {
            Some(job) => unsafe {
                windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(
                    job,
                    child.inner.as_raw_handle() as _,
                ) != 0
            }
            .then_some(())
            .ok_or_else(io::Error::last_os_error),
            None => Err(io::Error::other("任务组没建起来")),
        };
        if let Err(error) = CaptureJob::resume(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other(error));
        }
        if let Err(error) = tied {
            crate::logbuf::record(
                "warn",
                "process",
                &format!("后台进程未能挂进退出即回收的任务组: {error}"),
            );
        }
        Ok(child)
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

/// 整个 Mesa 进程共用的「句柄关闭即全杀」任务组（见 spawn_tied_to_app）：句柄只在本进程里、从不关闭，
/// 进程一结束（不论怎么结束）系统关掉句柄，组里的进程随之终止
#[cfg(windows)]
fn app_lifetime_job() -> Option<windows_sys::Win32::Foundation::HANDLE> {
    use windows_sys::Win32::System::JobObjects::*;
    static JOB: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let raw = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
        {
            windows_sys::Win32::Foundation::CloseHandle(job);
            return 0;
        }
        job as usize
    });
    (raw != 0).then_some(raw as windows_sys::Win32::Foundation::HANDLE)
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

    /// reg query 的值名列随系统语言变（「(默认)」/「(Default)」），按 REG_SZ 列取；引号原样留给调用方
    #[test]
    fn reg_values_and_command_exe() {
        let zh = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\EndNote.exe\r\n    (默认)    REG_SZ    \"D:\\applications\\Endnote\\EndNote.EXE\"\r\n\r\n";
        assert_eq!(
            reg_sz_value(zh).as_deref(),
            Some(r#""D:\applications\Endnote\EndNote.EXE""#)
        );
        let en = "    (Default)    REG_SZ    C:\\Program Files (x86)\\Zotero\\zotero.exe\r\n";
        assert_eq!(
            reg_sz_value(en).as_deref(),
            Some(r"C:\Program Files (x86)\Zotero\zotero.exe")
        );
        assert_eq!(reg_sz_value("    CFDIR    REG_EXPAND_SZ    %ProgramFiles%\\EndNote\\").as_deref(), Some(r"%ProgramFiles%\EndNote\"));
        assert_eq!(reg_sz_value("    (默认)    REG_SZ    \r\n"), None);
        assert_eq!(
            command_line_exe(r#""D:\applications\Endnote\EndNote.EXE" "%1""#),
            Some(std::path::PathBuf::from(r"D:\applications\Endnote\EndNote.EXE"))
        );
        assert_eq!(
            command_line_exe(r"C:\EN\EndNote.exe %1"),
            Some(std::path::PathBuf::from(r"C:\EN\EndNote.exe"))
        );
    }

    /// Mesa 开着时装的 Git / Node.js：注册表 PATH 里新出现的目录补在末尾，已有的（大小写、末尾斜杠不同也算）不重复
    #[test]
    fn registry_path_entries_are_appended_once() {
        let current = r"C:\WINDOWS\system32;C:\Users\me\AppData\Roaming\npm";
        let machine = r"C:\Windows\System32;C:\Program Files\Git\cmd;C:\Program Files\nodejs\".to_string();
        let user = r"C:\Users\me\AppData\Roaming\npm\;;C:\Program Files\Git\cmd".to_string();
        assert_eq!(
            merged_windows_path(current, &[machine.clone(), user]).as_deref(),
            Some(r"C:\WINDOWS\system32;C:\Users\me\AppData\Roaming\npm;C:\Program Files\Git\cmd;C:\Program Files\nodejs\")
        );
        // 都已在 PATH 上：不改
        let full = merged_windows_path(current, &[machine]).unwrap();
        assert_eq!(merged_windows_path(&full, &[r"c:\program files\git\CMD".into()]), None);
        // 读不到注册表、原来没有 PATH
        assert_eq!(merged_windows_path(current, &[]), None);
        assert_eq!(merged_windows_path("", &[r"C:\Git\cmd".into()]).as_deref(), Some(r"C:\Git\cmd"));
        // 原 PATH 末尾带分号不产生空段
        assert_eq!(merged_windows_path(r"C:\a;", &[r"C:\b".into()]).as_deref(), Some(r"C:\a;C:\b"));
    }

    /// 本机注册表：child_path 补出来的结果里原 PATH 原样在最前；REG_EXPAND_SZ 已展开
    #[cfg(windows)]
    #[test]
    fn child_path_keeps_process_path_first() {
        let current = std::env::var("PATH").unwrap();
        if let Some(next) = child_path() {
            assert!(next.to_str().unwrap().starts_with(current.trim_end_matches(';')));
        }
        use windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE;
        let machine =
            registry_path_value(HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")
                .expect("系统 PATH 应读得到");
        assert!(!machine.to_lowercase().contains("%systemroot%"), "REG_EXPAND_SZ 应已展开: {machine}");
        // 后台子进程真拿到了：系统 PATH 的每一段都在子进程的 PATH 里（Mesa 启动时 PATH 再旧也一样）
        let out = background_command("cmd.exe").args(["/d", "/c", "echo %PATH%"]).output().unwrap();
        let seen: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .trim()
            .split(';')
            .map(crate::paths::path_key_folded)
            .collect();
        for entry in machine.split(';').map(str::trim).filter(|e| !e.is_empty()) {
            assert!(seen.contains(&crate::paths::path_key_folded(entry)), "子进程 PATH 缺 {entry}");
        }
    }

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
        let Some(local) = crate::dirs::data_local_dir() else { return };
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

    // npm 装的 Claude Code / OpenCode：shim 直接调原生 exe（2026-10-20 本机采样，claude-code 2.1.304）
    const EXE_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\
\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n";

    // CodeBuddy：Node 系 shim，入口是无扩展名的 node 脚本（codebuddy-code 2.170.0）
    const BARE_NODE_SHIM: &str = r#"@ECHO off
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

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy" %*
"#;

    #[test]
    fn shim_exe_and_bare_node_entries() {
        assert_eq!(
            exe_entry_from_shim(EXE_SHIM).as_deref(),
            Some(r"node_modules\@anthropic-ai\claude-code\bin\claude.exe")
        );
        assert_eq!(js_entry_from_shim(EXE_SHIM), None);
        assert_eq!(bare_script_entry_from_shim(EXE_SHIM), None, "没调 node 的不算 node 脚本");
        assert_eq!(
            bare_script_entry_from_shim(BARE_NODE_SHIM).as_deref(),
            Some(r"node_modules\@tencent-ai\codebuddy-code\bin\codebuddy")
        );
        assert_eq!(exe_entry_from_shim(BARE_NODE_SHIM), None, "Node 系 shim 的 node.exe 不是入口");
        // Node 系 .js shim 两种都不认（走 js_entry_from_shim）
        assert_eq!(exe_entry_from_shim(MODERN_SHIM), None);
        assert_eq!(bare_script_entry_from_shim(MODERN_SHIM), None);
        assert_eq!(exe_entry_from_shim(LEGACY_SHIM), None);
        assert_eq!(exe_entry_from_shim("echo hello"), None);
        assert_eq!(exe_entry_from_shim(""), None);
    }

    /// Agent 的 Python 输出编码：只在 Windows 补 PYTHONIOENCODING，用户自己设过的不覆盖
    #[test]
    fn agent_python_io_env_only_on_windows_and_respects_user_value() {
        assert_eq!(python_io_env_for(true, None), Some(("PYTHONIOENCODING", "utf-8")));
        assert_eq!(python_io_env_for(true, Some(OsStr::new("gbk"))), None);
        assert_eq!(python_io_env_for(false, None), None);
        // 不设 PYTHONUTF8：它会连 open() 的默认编码一起改
        assert_ne!(python_io_env_for(true, None).map(|(k, _)| k), Some("PYTHONUTF8"));
    }

    #[test]
    fn utf8_lang_follows_system_region_with_fallback() {
        let installed = |name: &str| ["zh_CN.UTF-8", "en_US.UTF-8", "ja_JP.UTF-8"].contains(&name);
        assert_eq!(utf8_lang_for("zh_CN", installed), "zh_CN.UTF-8");
        assert_eq!(utf8_lang_for("zh-Hans_CN", installed), "zh_CN.UTF-8");
        assert_eq!(utf8_lang_for("ja_JP@calendar=japanese", installed), "ja_JP.UTF-8");
        // 本机没有的组合、只有语言没有地区、读不到 → en_US.UTF-8
        assert_eq!(utf8_lang_for("en_CN", installed), "en_US.UTF-8");
        assert_eq!(utf8_lang_for("zh-Hans", installed), "en_US.UTF-8");
        assert_eq!(utf8_lang_for("", installed), "en_US.UTF-8");
    }

    /// 直调 exe 的 shim 起进程时绕开 cmd：PTY 命令的程序就是那个 exe，参数原样（含换行、%、引号、|）
    #[cfg(windows)]
    #[test]
    fn exe_shim_launches_exe_directly_with_args_intact() {
        let dir = std::env::temp_dir().join(format!("ccode-shim-{}", uuid::Uuid::new_v4()));
        let bin = dir.join("node_modules").join("@anthropic-ai").join("claude-code").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("claude.exe"), b"MZ").unwrap();
        let shim = dir.join("claude.cmd");
        std::fs::write(&shim, EXE_SHIM).unwrap();
        let prompt = "第一行\n第二行 \"a|b\" 100%PATH% x^2".to_string();
        let cmd = pty_command(&shim, &["--model".into(), "x".into(), prompt.clone()]);
        let argv = cmd.get_argv();
        assert_eq!(std::path::Path::new(&argv[0]), bin.join("claude.exe"));
        assert_eq!(argv[1..].iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>(), ["--model", "x", prompt.as_str()]);
        // CodeBuddy 式无扩展名 node 脚本：node 直启
        let cb = dir.join("node_modules").join("@tencent-ai").join("codebuddy-code").join("bin");
        std::fs::create_dir_all(&cb).unwrap();
        std::fs::write(cb.join("codebuddy"), "#!/usr/bin/env node\nconsole.log(1)\n").unwrap();
        let shim = dir.join("codebuddy.cmd");
        std::fs::write(&shim, BARE_NODE_SHIM).unwrap();
        if let Some((_, entry)) = node_entry_from_cmd_shim(&shim) {
            assert_eq!(entry, cb.join("codebuddy"));
        } else {
            assert!(crate::agents::resolve_binary("node").is_none(), "装了 node 就该深化成 node 直启");
        }
        // 无扩展名但不是 node 脚本：不深化
        std::fs::write(cb.join("codebuddy"), "echo hi\n").unwrap();
        assert!(node_entry_from_cmd_shim(&shim).is_none());
        std::fs::remove_dir_all(&dir).ok();
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
