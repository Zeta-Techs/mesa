//! 精确注意力标记（agent hooks 桥接）：用户按 agent 显式开启后，向各家 CLI 的 hooks 配置
//! 写入三个事件（工作中/已完成/待确认）的命令条目，CLI 每次触发事件时把原始事件 JSON
//! （带 unix 时间戳前缀）追加到 <config>/ccode/hooks-state/<tag>-hooks.jsonl。
//! sessions 的注意力分类对已开启的 agent 优先读该日志（双键匹配取最新事件），比尾部文本
//! 推断精确；日志缺失/过期（>10 分钟无更新）自动回落尾部推断。
//! 写各家配置遵守 global_config 同款约定：写前备份、原子写、只动 hooks 段、
//! 用户已有 hooks 合并而非覆盖、移除时只删含本日志路径（marker）的条目、配置损坏拒绝写入。
//! 每 agent 一张桥接规格（BRIDGE_SPECS），读写引擎共用；cursor/opencode 无可用形态，不在表内。

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 状态日志过期阈值：超过 10 分钟无事件视为失效，回落尾部推断
const HOOKS_TTL_SECS: i64 = 10 * 60;
/// 读取日志的尾部窗口（日志只增不删，分类只看尾部即可）
const LOG_TAIL_WINDOW: u64 = 256 * 1024;
/// 同前缀备份保留份数
const BACKUP_KEEP: usize = 10;
/// kimi [[hooks]] 的 timeout 字段（strict 四字段之一，多写字段会导致整个配置加载失败）
const KIMI_HOOK_TIMEOUT: i64 = 30;

/// 配置文件文档族：决定读-改-写的内核
#[derive(Clone, Copy, PartialEq)]
enum DocFamily {
    /// 含 hooks 键的设置文档；tolerant = JSONC 容错读（qwen/gemini 容忍注释与尾逗号）
    SettingsJson { tolerant: bool },
    /// 整文件归我们的 hooks 文件（grok）：开启=写文件，关闭=删文件，外来文件拒绝覆盖
    HooksFileJson,
    /// kimi config.toml 的 [[hooks]] 扁平表（toml_edit 保留其余键原样）
    KimiToml,
}

/// 每 agent 一张桥接规格（事件名/matcher 为 matrix 源码级调研结论）
struct BridgeSpec {
    /// agent id（同 agent_specs 注册表）
    agent: &'static str,
    /// 配置文件（相对 home）
    config_rel: &'static str,
    /// 状态日志/备份命名用短标签（claude 沿用既有 claude-hooks.jsonl 文件名与备份前缀）
    log_tag: &'static str,
    family: DocFamily,
    /// (事件名, matcher) × [working, done, confirm] 三槽
    events: [(&'static str, &'static str); 3],
    /// codex：handler 额外带 "async": true
    handler_async: bool,
}

impl BridgeSpec {
    /// 报错文案用的展示路径
    fn display(&self) -> String {
        format!("~/{}", self.config_rel)
    }
    /// 识别「我们的条目」的子串：命令里含状态日志路径，移除时只删含此子串的命令
    /// （恒为正斜杠形态，匹配前把候选命令的反斜杠归一化——Windows 命令内路径是反斜杠分隔）
    fn marker(&self) -> String {
        format!("hooks-state/{}-hooks.jsonl", self.log_tag)
    }
}

static BRIDGE_SPECS: &[BridgeSpec] = &[
    BridgeSpec {
        agent: "claude-code",
        config_rel: ".claude/settings.json",
        log_tag: "claude",
        family: DocFamily::SettingsJson { tolerant: false },
        events: [("UserPromptSubmit", ""), ("Stop", ""), ("Notification", "")],
        handler_async: false,
    },
    BridgeSpec {
        agent: "qwen",
        config_rel: ".qwen/settings.json",
        log_tag: "qwen",
        family: DocFamily::SettingsJson { tolerant: true },
        events: [
            ("UserPromptSubmit", ""),
            ("Stop", ""),
            ("Notification", "permission_prompt|idle_prompt"),
        ],
        handler_async: false,
    },
    BridgeSpec {
        agent: "codebuddy",
        config_rel: ".codebuddy/settings.json",
        log_tag: "codebuddy",
        family: DocFamily::SettingsJson { tolerant: false },
        events: [
            ("UserPromptSubmit", ""),
            ("Stop", ""),
            ("Notification", "permission_prompt|idle_prompt"),
        ],
        handler_async: false,
    },
    BridgeSpec {
        agent: "gemini",
        config_rel: ".gemini/settings.json",
        log_tag: "gemini",
        family: DocFamily::SettingsJson { tolerant: true },
        events: [
            ("BeforeAgent", ""),
            ("AfterAgent", ""),
            ("Notification", "*"),
        ],
        handler_async: false,
    },
    BridgeSpec {
        agent: "kimi",
        config_rel: ".kimi-code/config.toml",
        log_tag: "kimi",
        family: DocFamily::KimiToml,
        events: [
            ("UserPromptSubmit", ""),
            ("Stop", ""),
            ("PermissionRequest", ""),
        ],
        handler_async: false,
    },
    BridgeSpec {
        agent: "grok",
        config_rel: ".grok/hooks/ccode.json",
        log_tag: "grok",
        family: DocFamily::HooksFileJson,
        events: [
            ("UserPromptSubmit", ""),
            ("Stop", ""),
            ("Notification", "permission_prompt|idle_prompt"),
        ],
        handler_async: false,
    },
    BridgeSpec {
        agent: "codex",
        config_rel: ".codex/hooks.json",
        log_tag: "codex",
        family: DocFamily::SettingsJson { tolerant: false },
        events: [
            ("UserPromptSubmit", ""),
            ("Stop", ""),
            ("PermissionRequest", ""),
        ],
        handler_async: true,
    },
];

fn spec_for(agent: &str) -> Option<&'static BridgeSpec> {
    BRIDGE_SPECS.iter().find(|s| s.agent == agent)
}

// ===== 每次启动注入（不写用户配置）=====
//
// 2026-10-20 逐家核实（docs/design-chat-structured-channels.md 附录）：Mesa 里拉起时能不碰用户配置、
// 默认就拿到精确事件的五家——Claude Code / CodeBuddy 用 `--settings` 带 hooks（与用户自己的 hooks 合并、
// 都会触发）；Qwen 用 Dual Output、OpenCode 用自带服务、Codex 用私有 app-server（chat_channel.rs）。
// 其余三家只能写全局配置：Gemini 的系统设置文件必须属 root、Kimi 没有指定配置的参数、Grok 的
// GROK_CONFIG 覆盖层不收 hooks——它们仍走设置页开关（BRIDGE_SPECS 写全局）。

/// 用 `--settings` 注入 hooks 的两家与挂的事件（matcher 同 Claude 语义）。
/// Notification 只收权限确认（idle_prompt 是「空闲 60 秒提醒」，不是等批准）；
/// PostToolUse 的 payload 带整个工具结果，命令里截到 PAYLOAD_CAP_SMALL。
fn launch_hook_events(agent: &str) -> Option<&'static [(&'static str, &'static str)]> {
    match agent {
        "claude-code" => Some(&[
            ("SessionStart", ""),
            ("UserPromptSubmit", ""),
            ("PreToolUse", ""),
            ("PostToolUse", ""),
            ("Notification", "permission_prompt|elicitation_dialog"),
            ("Stop", ""),
            ("PreCompact", ""),
        ]),
        "codebuddy" => Some(&[
            ("SessionStart", ""),
            ("UserPromptSubmit", ""),
            ("PreToolUse", ""),
            ("PostToolUse", ""),
            ("Notification", "permission_prompt"),
            ("Stop", ""),
        ]),
        _ => None,
    }
}

/// Mesa 拉起时自带精确事件、设置页不再给开关的几家
pub(crate) fn launch_injected(agent: &str) -> bool {
    matches!(agent, "claude-code" | "codebuddy" | "qwen" | "opencode" | "codex")
}

/// 每次启动注入的 hooks 是否放到后台跑（hook 配置带 `"async": true`，CLI 不等它跑完）。
/// 只在 Windows、只给 Claude Code、且只在找不到原生 hook 程序时：那时 hook 命令要起一个 PowerShell，
/// 实测每次 0.9–1.2 秒（2026-10-20 本机：Stop hook durationMs 1241），同步挂着时每个工具调用前后各卡一秒、
/// 每轮结束再卡一秒；2.1.x 支持 async（「runs in background without blocking」）。代价是事件可能乱序，
/// 由旁路状态机兜（chat_channel Tracker::async_hooks）。有原生 hook 程序（随包的 mesa_helper，几十毫秒）
/// 就同步跑，事件有序。CodeBuddy 没核实认 async，一律同步。macOS / Linux 的 hook 是几毫秒的 sh 一行，不动。
pub(crate) fn launch_hooks_async(agent: &str) -> bool {
    cfg!(windows) && agent == "claude-code" && native_hook_exe().is_none()
}

/// Windows 上写 hook 日志的原生程序：随包的 mesa_helper（`hook` 模式，见 bin/mesa_helper.rs）。
/// 找主程序同目录（测试二进制在 deps/ 下，再往上找一层），跳过 0 字节占位，并试跑一次 `hook --probe`
/// 确认认这个模式（开发时留着的旧 helper 不认，会把事件吞掉）。一次运行只查一次；找不到退回 PowerShell 脚本。
/// 只用于每次启动注入的两家时写原路径（Claude Code 走 Git Bash、CodeBuddy 走 cmd 跑 hook，带双引号的程序路径两边都认）；
/// 写进全局配置的三家用拷到 hooks-state 的那份、不加引号（global_hook_command，Gemini 在 PowerShell 里跑 hook）
pub(crate) fn native_hook_exe() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use std::sync::OnceLock;
        static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
        CACHE.get_or_init(find_native_hook_exe).clone()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
fn find_native_hook_exe() -> Option<PathBuf> {
    if std::env::var_os("CCODE_HOOK_NO_NATIVE").is_some() {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let triple = env!("TAURI_ENV_TARGET_TRIPLE");
    let names = ["mesa_helper.exe".to_string(), format!("mesa_helper-{triple}.exe")];
    // 打包版：同目录带 triple 后缀的 sidecar。开发态：target/debug/mesa_helper.exe 会被 tauri-build
    // 用 0 字节占位反复覆盖，`cargo build --bin mesa_helper` 的真身留在 deps/；测试二进制本身就在 deps/
    let dirs = [Some(dir.to_path_buf()), Some(dir.join("deps")), dir.parent().map(Path::to_path_buf)];
    for d in dirs.into_iter().flatten() {
        for name in &names {
            let p = d.join(name);
            if !fs::metadata(&p).is_ok_and(|m| m.is_file() && m.len() > 0) {
                continue;
            }
            let probe = crate::process::background_command(&p)
                .args(["hook", "--probe"])
                .stdin(std::process::Stdio::null())
                .output();
            if probe.is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "ok") {
                return Some(p);
            }
        }
    }
    None
}

/// 每次启动注入用的 hook 命令：Windows 有原生 hook 程序就用它，否则同 hook_command_capped
fn launch_hook_command(log_path: &Path, cap: usize) -> String {
    match native_hook_exe() {
        Some(exe) => format!(
            "{} hook {} {cap}",
            win_cmdline_path(&exe),
            win_cmdline_path(log_path)
        ),
        None => hook_command_capped(log_path, cap),
    }
}

// ===== 写进全局配置的三家（Gemini / Kimi / Grok）：Windows 上也用原生 hook 程序 =====
//
// 2026-10-20 实测：Gemini 在 Windows 上每个事件同步起一个 PowerShell，屏上一直「Executing Hook」、审批菜单约 10 秒才出。
// 这几家的 hook 宿主各不相同（Gemini 是 PowerShell，其余经 cmd / bash），命令必须三种宿主都认：程序路径不加引号、
// 用正斜杠（cmd /s /c、powershell -Command、bash -c 都能直接跑，2026-10-20 实测）。不加引号就不能有空格与特殊字符，
// 所以把 helper 拷一份到 hooks-state/ccode-hook.exe——路径跟 .ps1 一样稳定（不随安装目录、开发 / 打包切换变），
// 路径里有空格（用户名带空格）等就退回 PowerShell 脚本。

/// 拷进 hooks-state 的 hook 程序文件名（与 ccode-hook.ps1 同目录）
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const WIN_HOOK_EXE: &str = "ccode-hook.exe";

/// 不加引号也能在 cmd / PowerShell / bash 里原样当程序路径用：只含字母数字（含中文等）与 `_-./:~`
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn shell_neutral_path(p: &Path) -> Option<String> {
    let s = crate::paths::strip_verbatim(p.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/");
    s.chars()
        .all(|c| c.is_alphanumeric() || "_-./:~".contains(c))
        .then_some(s)
}

/// 全局 hooks 用的原生程序：把随包 helper 拷到 hooks-state/ccode-hook.exe（内容不同才拷；正在被 hook 进程
/// 占用换不掉就先用旧的，下次启动再换），路径能不加引号用才返回
#[cfg(windows)]
fn stable_hook_exe(log_path: &Path) -> Option<String> {
    let src = native_hook_exe()?;
    let dst = log_path.parent()?.join(WIN_HOOK_EXE);
    let same = fs::read(&src).ok().zip(fs::read(&dst).ok()).is_some_and(|(a, b)| a == b);
    if !same {
        let tmp = dst.with_extension("exe.new");
        let copied = fs::create_dir_all(dst.parent()?).is_ok()
            && fs::copy(&src, &tmp).is_ok()
            && fs::rename(&tmp, &dst).is_ok();
        if !copied {
            let _ = fs::remove_file(&tmp);
            if !dst.is_file() {
                return None;
            }
        }
    }
    shell_neutral_path(&dst)
}

/// 写进全局配置的 hook 命令：Windows 有可用的原生程序就用它（三种宿主都认的写法），否则 PowerShell 脚本
fn global_hook_command(log_path: &Path) -> String {
    #[cfg(windows)]
    if let Some(exe) = stable_hook_exe(log_path) {
        return format!("{exe} hook {} {PAYLOAD_CAP}", win_cmdline_path(log_path));
    }
    hook_command(log_path)
}

/// 精确注意力是否可用：开关打开（写了全局配置），或这家由 Mesa 每次启动注入
fn precise_enabled(agent: &str) -> bool {
    launch_injected(agent)
        || crate::settings::hooks_attention_enabled(&crate::settings::read_current(), agent)
}

/// 这家注入用的 `{"hooks": {...}}`（并进 Claude Code / CodeBuddy 的 `--settings`）；不支持的家 None
pub(crate) fn launch_hooks_value(agent: &str) -> Option<Value> {
    let mut events = launch_hook_events(agent)?.to_vec();
    // 后台跑时「等批准」的 Notification 可能比它那个工具的 PreToolUse 先到，卡片拿不到内容：
    // 另挂 PermissionRequest（payload 自带工具名与参数），审批卡内容不依赖先后
    if launch_hooks_async(agent) {
        events.push(("PermissionRequest", ""));
    }
    let spec = spec_for(agent)?;
    let log = hooks_log_path(spec).ok()?;
    // 启动注入没有「开启开关」那一步写脚本：Windows 命令引用 ccode-hook.ps1，这里保证它在且是当前正文
    #[cfg(windows)]
    ensure_win_hook_script(&log).ok()?;
    let mut hooks = serde_json::Map::new();
    for &(event, matcher) in &events {
        let cap = if event == "PostToolUse" {
            PAYLOAD_CAP_SMALL
        } else {
            PAYLOAD_CAP
        };
        let mut handler = json!({ "type": "command", "command": launch_hook_command(&log, cap) });
        if launch_hooks_async(agent) {
            handler["async"] = json!(true);
        }
        hooks.insert(
            event.into(),
            json!([{ "matcher": matcher, "hooks": [handler] }]),
        );
    }
    Some(json!({ "hooks": hooks }))
}

/// 这家的状态日志（聊天层旁路按标签号过滤读同一份）
pub(crate) fn log_path_for(agent: &str) -> Option<PathBuf> {
    hooks_log_path(spec_for(agent)?).ok()
}

/// 状态日志超过 8MB 就只留最后 2MB（日志只增不删；读取只看尾部 256KB）
pub(crate) fn rotate_log_if_large(path: &Path) {
    const MAX: u64 = 8 * 1024 * 1024;
    const KEEP: u64 = 2 * 1024 * 1024;
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if meta.len() <= MAX {
        return;
    }
    let Ok(mut f) = fs::File::open(path) else {
        return;
    };
    if f.seek(SeekFrom::Start(meta.len() - KEEP)).is_err() {
        return;
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return;
    }
    // 从第一个完整行开始留
    let start = buf.iter().position(|b| *b == b'\n').map(|i| i + 1).unwrap_or(0);
    let _ = crate::profiles::atomic_write(path, &String::from_utf8_lossy(&buf[start..]));
}

/// 改为每次启动注入的几家，若以前在设置页开过开关（写了全局 hooks），启动时替用户移除 Mesa 写进去的条目
/// 并关掉开关——设置页已不再给这几家开关，不收回就再也没有入口关。只删含状态日志路径的条目，写前备份。
pub(crate) fn migrate_launch_injected() {
    let settings = crate::settings::read_current();
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let Ok(backups) = backups_dir() else {
        return;
    };
    for spec in BRIDGE_SPECS {
        if !launch_injected(spec.agent)
            || !crate::settings::hooks_attention_enabled(&settings, spec.agent)
        {
            continue;
        }
        let Ok(log) = hooks_log_path(spec) else {
            continue;
        };
        if apply_hooks_at(spec, &home, &log, &backups, false).is_ok() {
            let _ = crate::settings::set_hooks_attention_entry(spec.agent, false);
        }
    }
}

// 走 storage::config_root：测试（含聊天层端到端）重定向配置根时，状态日志与备份跟着进临时目录
fn hooks_state_dir() -> Result<PathBuf, String> {
    Ok(crate::storage::config_root()
        .ok_or("无法确定平台配置目录")?
        .join("hooks-state"))
}

fn hooks_log_path(spec: &BridgeSpec) -> Result<PathBuf, String> {
    Ok(hooks_state_dir()?.join(format!("{}-hooks.jsonl", spec.log_tag)))
}

fn backups_dir() -> Result<PathBuf, String> {
    Ok(crate::storage::config_root()
        .ok_or("无法确定平台配置目录")?
        .join("backups"))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ===== hook 命令构造 =====

#[cfg(not(windows))]
fn shell_quote(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\'', "'\\''"))
}

/// Windows hook 脚本文件名：与状态日志同目录（hooks-state/），七家共用一份，日志路径走参数
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const WIN_HOOK_SCRIPT: &str = "ccode-hook.ps1";

/// Windows hook 脚本正文：读 stdin 事件 JSON，前缀「unix 秒 + 标签号」后单行追加到参数给的日志，超过 Cap 截断（语义同 unix 命令）。
///
/// 读写都必须显式钉 UTF-8，不能用 [Console]::In / Add-Content：那两者按系统 ANSI
/// 代码页（中文机器 = GBK936）解码再编码，UTF-8 的中文字节被错位配对后会把紧跟的
/// ASCII 字符当 trail byte 吞掉。实测 {"message":"新项目"} 往返后闭合引号消失，
/// serde_json 解析失败 ⇒ 整条 hook 记录被丢弃（transcript_path 一旦中招，
/// grok 这类只能靠它归属会话的 agent 会永久丢失精确注意力标记）。
/// 用 UTF8Encoding::new($false) 而非 -Encoding utf8：PS 5.1 的后者会写 BOM，
/// 首行多出 U+FEFF 会让读取侧的 unix 秒 parse::<i64>() 失败。
/// 只删回车换行（同 unix 的 `tr -d '\r\n'`）保证一行一条记录：JSON 字符串里不会有裸换行，删掉的只是排版空白；
/// 2026-10-20 以前折叠的是 `\s+`，会把字符串里的连续空格也并成一个——审批卡上的命令、差异丢了缩进。
/// 追加撞上别的 hook 进程正在写（AppendAllText 独占写，多个工具并行、多个标签同时触发时实测 12 并发丢 1 条）
/// 就稍等重试，最多约 1.5 秒；丢了「回合结束」那条，聊天层会一直显示在回复。
/// 正文保持纯 ASCII：PS 5.1 按 ANSI 代码页读无 BOM 脚本，ASCII 在任何代码页下都无损。
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const WIN_HOOK_SCRIPT_BODY: &str = "param([string]$LogPath, [int]$Cap = 65536)\r\n\
$u = New-Object Text.UTF8Encoding $false\r\n\
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($LogPath))\r\n\
$t = $env:CCODE_TAB_ID\r\n\
if (-not $t) { $t = '-' }\r\n\
$l = (New-Object IO.StreamReader ([Console]::OpenStandardInput()), $u).ReadToEnd()\r\n\
if ($l.Length -gt $Cap) { $l = $l.Substring(0, $Cap) }\r\n\
$ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()\r\n\
$line = $ts.ToString() + ' ' + $t + ' ' + ($l -replace '[\\r\\n]+', '') + [Environment]::NewLine\r\n\
for ($i = 0; $i -lt 60; $i++) {\r\n\
  try { [IO.File]::AppendAllText($LogPath, $line, $u); break }\r\n\
  catch { [Threading.Thread]::Sleep(10 + ($i * 7) % 31) }\r\n\
}\r\n";

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn win_hook_script_path(log_path: &Path) -> PathBuf {
    log_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(WIN_HOOK_SCRIPT)
}

/// 命令行里的路径：正斜杠 + 双引号。正斜杠 PowerShell 照认，又不会被 bash 双引号当转义；
/// 不含 `$`/反引号/单引号，bash、cmd、PowerShell 三种宿主 shell 解析结果一致
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn win_cmdline_path(p: &Path) -> String {
    let plain = crate::paths::strip_verbatim(p.to_path_buf());
    format!(
        "\"{}\"",
        plain.to_string_lossy().replace('\\', "/").replace('"', "")
    )
}

/// 每次启动都会调：正文没变就不写，免得多个 CLI 同时拉起时改名撞上正在被 hook 进程读取的脚本
#[cfg(windows)]
fn ensure_win_hook_script(log_path: &Path) -> Result<(), String> {
    if fs::read_to_string(win_hook_script_path(log_path)).is_ok_and(|t| t == WIN_HOOK_SCRIPT_BODY) {
        return Ok(());
    }
    write_win_hook_script(log_path)
}

/// 写（覆盖）Windows hook 脚本；开启时调用，保证脚本与当前版本正文一致
#[cfg(windows)]
fn write_win_hook_script(log_path: &Path) -> Result<(), String> {
    let script = win_hook_script_path(log_path);
    if let Some(dir) = script.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建 {} 失败: {e}", dir.display()))?;
    }
    crate::profiles::atomic_write(&script, WIN_HOOK_SCRIPT_BODY)
}

/// 一条记录最多收多少字节的事件 JSON（PreToolUse 带完整工具参数，审批卡要看命令和差异）
const PAYLOAD_CAP: usize = 64 * 1024;
/// PostToolUse 带整个工具结果（读文件时是整份文件），只要事件名和会话 id，截短免得日志暴涨
const PAYLOAD_CAP_SMALL: usize = 2048;

/// hook 命令：读 stdin 事件 JSON，前缀「unix 秒 + 标签号」后单行追加到状态日志。
/// 标签号取 hook 子进程继承的 CCODE_TAB_ID（Mesa 拉起时注入；Mesa 外的终端没有，记 `-`），
/// 聊天层旁路据此认出是哪个标签的事件（docs/design-chat-structured-channels.md §6）。
/// 整行拼好后一次写入：同一份日志有多个 CLI 并发追加，分三次写会互相穿插。
/// payload 超过上限就截断（解析侧对截断的记录按字段名兜底取事件名和会话 id）。
/// unix 走 sh（各 CLI 以 sh -c 执行），命令内 mkdir -p 兜底目录不存在。
///
/// Windows 各家 CLI 用不同宿主 shell 跑 hook：Claude Code 走 Git Bash，Gemini 走
/// `powershell -Command`，Qwen 等经 Node 走 `cmd /d /s /c`。内联 `-Command "$d=…"` 的旧写法
/// 在 bash 里 `$变量` 被提前展开、在 cmd/PowerShell 里内层引号被拆，日志一行都写不出来。
/// 现在逻辑全放进 hooks-state/ccode-hook.ps1，命令行只剩双引号路径和一个截断字节数，三种宿主都原样传参。
/// 日志路径作为参数留在命令里——marker 识别（更新/移除我们的条目）照旧生效，新旧两种写法都认。
fn hook_command(log_path: &Path) -> String {
    hook_command_capped(log_path, PAYLOAD_CAP)
}

fn hook_command_capped(log_path: &Path, cap: usize) -> String {
    #[cfg(not(windows))]
    {
        let log = shell_quote(log_path);
        let dir = shell_quote(log_path.parent().unwrap_or_else(|| Path::new(".")));
        format!(
            "umask 077; mkdir -p {dir}; l=\"$(date +%s) ${{CCODE_TAB_ID:--}} $({{ head -c {cap}; cat >/dev/null; }} | tr -d '\\r\\n')\"; printf '%s\\n' \"$l\" >> {log}"
        )
    }
    #[cfg(windows)]
    {
        win_hook_command(log_path, cap)
    }
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn win_hook_command(log_path: &Path, cap: usize) -> String {
    format!(
        "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File {} {} {cap}",
        win_cmdline_path(&win_hook_script_path(log_path)),
        win_cmdline_path(log_path)
    )
}

// ===== JSON 文档族（settings.json / hooks.json）：hooks 段合并/移除（纯函数） =====

fn parse_json_doc(existing: Option<&str>, spec: &BridgeSpec) -> Result<Value, String> {
    let display = spec.display();
    let v: Value = match existing.map(crate::mcp::strip_bom) {
        Some(t) if !t.trim().is_empty() => {
            // qwen/gemini 的 settings.json 实为 JSONC：先去注释与尾逗号（mcp.rs 同款容错读）
            let text = match spec.family {
                DocFamily::SettingsJson { tolerant: true } => crate::mcp::strip_jsonc(t),
                _ => t.to_string(),
            };
            serde_json::from_str(&text)
                .map_err(|e| format!("{display} 不是合法 JSON，已停止写入以免破坏: {e}"))?
        }
        _ => json!({}),
    };
    if !v.is_object() {
        return Err(format!("{display} 根节点不是对象，已停止写入"));
    }
    Ok(v)
}

fn to_pretty(v: &Value) -> Result<String, String> {
    let mut s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    s.push('\n');
    Ok(s)
}

/// 事件组里我们追加的 handler；codex 额外带 "async": true
fn handler_json(spec: &BridgeSpec, command: &str) -> Value {
    let mut h = json!({ "type": "command", "command": command });
    if spec.handler_async {
        h.as_object_mut()
            .unwrap()
            .insert("async".into(), json!(true));
    }
    h
}

/// 从事件组数组中剔除我们的条目；组内 hooks 清空则整组删除
fn strip_marker_entries(arr: &mut Vec<Value>, marker: &str) {
    arr.retain_mut(|group| {
        if let Some(hooks) = group.get_mut("hooks").and_then(|h| h.as_array_mut()) {
            hooks.retain(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    // Windows 命令内路径是反斜杠分隔，归一化后再匹配 marker，否则关开关删不掉条目
                    .is_none_or(|c| !c.replace('\\', "/").contains(marker))
            });
            !hooks.is_empty()
        } else {
            true // 不是标准组结构的用户条目，原样保留
        }
    });
}

/// 合并：保留其他配置键与用户已有 hooks，三个事件各追加一条我们的命令；重复调用幂等
fn merge_json_doc(
    spec: &BridgeSpec,
    existing: Option<&str>,
    command: &str,
) -> Result<String, String> {
    let mut v = parse_json_doc(existing, spec)?;
    if let Some(h) = v.get("hooks") {
        if !h.is_object() {
            return Err(format!(
                "{} 的 hooks 字段不是对象，已停止写入",
                spec.display()
            ));
        }
    }
    let hooks = v
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().unwrap();
    let marker = spec.marker();
    for &(event, matcher) in spec.events.iter() {
        if let Some(e) = hooks.get(event) {
            if !e.is_array() {
                return Err(format!("hooks.{event} 不是数组，已停止写入"));
            }
        }
        let arr = hooks
            .entry(event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap();
        strip_marker_entries(arr, &marker); // 幂等：先清旧条目再追加
        arr.push(json!({
            "matcher": matcher,
            "hooks": [handler_json(spec, command)]
        }));
    }
    to_pretty(&v)
}

/// 移除：只删含 marker 的命令条目；事件数组/hooks 对象清空后回收空壳键，其余原样保留
fn remove_json_doc(spec: &BridgeSpec, existing: Option<&str>) -> Result<String, String> {
    let mut v = parse_json_doc(existing, spec)?;
    let Some(hooks) = v.get_mut("hooks") else {
        return to_pretty(&v); // 本来就没有 hooks 段
    };
    if !hooks.is_object() {
        return Err(format!(
            "{} 的 hooks 字段不是对象，已停止写入",
            spec.display()
        ));
    }
    let hooks = hooks.as_object_mut().unwrap();
    let marker = spec.marker();
    let events: Vec<String> = hooks.keys().cloned().collect();
    for event in events {
        if let Some(arr) = hooks.get_mut(&event).and_then(|e| e.as_array_mut()) {
            strip_marker_entries(arr, &marker);
            if arr.is_empty() {
                hooks.remove(&event);
            }
        }
    }
    if hooks.is_empty() {
        v.as_object_mut().unwrap().remove("hooks");
    }
    to_pretty(&v)
}

// ===== kimi TOML 文档族（[[hooks]] 扁平表，strict 四字段） =====

fn parse_toml_doc(existing: Option<&str>, display: &str) -> Result<toml_edit::DocumentMut, String> {
    crate::mcp::strip_bom(existing.unwrap_or(""))
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("{display} 解析失败，已停止写入以免破坏: {e}"))
}

/// 剔除 command 含 marker 的 [[hooks]] 条目
fn strip_toml_marker_entries(arr: &mut toml_edit::ArrayOfTables, marker: &str) {
    let drop: Vec<usize> = arr
        .iter()
        .enumerate()
        .filter(|(_, t)| {
            t.get("command")
                .and_then(|c| c.as_str())
                .is_some_and(|c| c.replace('\\', "/").contains(marker))
        })
        .map(|(i, _)| i)
        .collect();
    for i in drop.into_iter().rev() {
        arr.remove(i);
    }
}

/// kimi 合并：[[hooks]] 每事件一条 strict 四字段；其余键（providers/models 等）原样保留；幂等
fn merge_kimi_toml(
    spec: &BridgeSpec,
    existing: Option<&str>,
    command: &str,
) -> Result<String, String> {
    use toml_edit::value;
    let mut doc = parse_toml_doc(existing, &spec.display())?;
    if let Some(item) = doc.get("hooks") {
        if item.as_array_of_tables().is_none() {
            return Err(format!(
                "{} 的 hooks 字段不是数组表，已停止写入",
                spec.display()
            ));
        }
    }
    if doc.get("hooks").is_none() {
        doc["hooks"] = toml_edit::Item::ArrayOfTables(toml_edit::ArrayOfTables::new());
    }
    let arr = doc["hooks"].as_array_of_tables_mut().unwrap();
    strip_toml_marker_entries(arr, &spec.marker()); // 幂等：先清旧条目再追加
    for &(event, matcher) in spec.events.iter() {
        let mut t = toml_edit::Table::new();
        t["event"] = value(event);
        t["matcher"] = value(matcher);
        t["command"] = value(command);
        t["timeout"] = value(KIMI_HOOK_TIMEOUT);
        arr.push(t);
    }
    Ok(doc.to_string())
}

/// kimi 移除：只删含 marker 的 [[hooks]] 条目；清空后回收 hooks 键，其余原样保留
fn remove_kimi_toml(spec: &BridgeSpec, existing: Option<&str>) -> Result<String, String> {
    let mut doc = parse_toml_doc(existing, &spec.display())?;
    let Some(item) = doc.get_mut("hooks") else {
        return Ok(doc.to_string()); // 本来就没有 hooks 段
    };
    let Some(arr) = item.as_array_of_tables_mut() else {
        return Err(format!(
            "{} 的 hooks 字段不是数组表，已停止写入",
            spec.display()
        ));
    };
    strip_toml_marker_entries(arr, &spec.marker());
    if arr.is_empty() {
        doc.as_table_mut().remove("hooks");
    }
    Ok(doc.to_string())
}

// ===== grok 整文件族（~/.grok/hooks/ccode.json 归我们） =====

/// grok hooks 文件全文：与 claude 同款的「hooks 键 → 事件 → 组」结构，无其他键需要合并
fn whole_file_doc(spec: &BridgeSpec, command: &str) -> Result<String, String> {
    let mut hooks = serde_json::Map::new();
    for &(event, matcher) in spec.events.iter() {
        hooks.insert(
            event.into(),
            json!([{ "matcher": matcher, "hooks": [handler_json(spec, command)] }]),
        );
    }
    to_pretty(&json!({ "hooks": hooks }))
}

fn has_marker(text: &str, marker: &str) -> bool {
    // JSON 文本里 Windows 路径分隔符被转义成两个字符 \\：必须先按对归一，
    // 否则单字符替换会得到双斜杠（C://..//hooks-state//...）匹配不上 marker
    text.replace("\\\\", "/")
        .replace('\\', "/")
        .contains(marker)
}

// ===== 备份与事务写入 =====

/// 读现有配置：不存在/空白 = None；BOM 剥掉（写回不带 BOM，原字节由备份保留）。
/// 读失败（非 UTF-8、无权限等）必须报错停写——当成「不存在」会拿只含 hooks 的新文件
/// 覆盖掉用户整份配置，且因 existing=None 连备份都不做（global_config 同口径）。
fn read_existing(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(t) => {
            let t = crate::mcp::strip_bom(&t);
            Ok((!t.trim().is_empty()).then(|| t.to_string()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!(
            "读取 {} 失败，已停止写入以免覆盖: {e}",
            path.display()
        )),
    }
}

/// 写前备份到 <config>/ccode/backups/<tag>-hooks-settings-<纳秒>.<ext>，按前缀保留最近 N 份
/// （纳秒后缀保证同秒内连续开/关两次也各留一份，不会被同名覆盖；claude 沿用既有前缀，
/// 历史备份仍按同一前缀参与轮换）
fn backup_config(spec: &BridgeSpec, backups: &Path, config: &Path) -> Result<(), String> {
    fs::create_dir_all(backups).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let ext = if spec.family == DocFamily::KimiToml {
        "toml"
    } else {
        "json"
    };
    let prefix = format!("{}-hooks-settings-", spec.log_tag);
    let dst = backups.join(format!("{prefix}{nanos:020}.{ext}"));
    fs::copy(config, &dst).map_err(|e| format!("备份 {} 失败: {e}", spec.display()))?;
    let mut olds: Vec<PathBuf> = fs::read_dir(backups)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with(&prefix))
                })
                .collect()
        })
        .unwrap_or_default();
    olds.sort();
    for p in olds.iter().take(olds.len().saturating_sub(BACKUP_KEEP)) {
        fs::remove_file(p).ok();
    }
    Ok(())
}

/// 旧版 Windows 钩子特征：内联 `powershell -Command "$d=…"`（JSON / TOML 转义后子串仍在）
#[cfg(any(windows, test))]
fn is_legacy_win_hook(config_text: &str) -> bool {
    config_text.contains("-Command") && config_text.contains("$d=") && config_text.contains("hooks-state")
}

/// Windows 老用户迁移：旧版内联钩子在 bash / PowerShell 宿主下会被吞掉 `$变量`、从不生效。
/// 启动时对开关已开的 agent，配置里仍是旧写法才按新写法重写一次（apply_hooks_at 自带备份 +
/// 替换旧条目）；已是新写法不动，不会每次启动多出一份备份。失败只记日志，不挡启动
#[cfg(windows)]
pub(crate) fn migrate_legacy_windows_hooks() {
    // 共用脚本正文改过（2026-10-20：保留字符串里的空格、写日志撞车重试）：已经写过脚本的机器
    // （开过全局开关的 Gemini / Kimi / Grok 也引用它）启动时换成当前正文，正文没变不写
    if let Ok(dir) = hooks_state_dir() {
        let any_log = dir.join("claude-hooks.jsonl");
        if win_hook_script_path(&any_log).is_file() {
            let _ = ensure_win_hook_script(&any_log);
        }
    }
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let Ok(backups) = backups_dir() else {
        return;
    };
    let settings = crate::settings::read_current();
    for s in crate::agent_specs::all_agent_specs() {
        let Some(spec) = spec_for(s.id) else {
            continue;
        };
        if !crate::settings::hooks_attention_enabled(&settings, s.id) {
            continue;
        }
        let Ok(text) = fs::read_to_string(home.join(spec.config_rel)) else {
            continue;
        };
        let Ok(log) = hooks_log_path(spec) else {
            continue;
        };
        // 两种要重写：旧版内联写法；原生程序与 PowerShell 脚本之间该换了（装了新版有了 helper、或 helper 没了）
        let want_native = global_hook_command(&log).contains(WIN_HOOK_EXE);
        if !is_legacy_win_hook(&text) && !win_hook_form_stale(&text, want_native) {
            continue;
        }
        let result = apply_hooks_at(spec, &home, &log, &backups, true);
        if let Err(e) = result {
            crate::logbuf::record("warn", "hooks", &format!("{} 旧版钩子迁移失败: {e}", s.id));
        }
    }
}

/// 配置里我们的条目用的是不是该用的那种写法（ccode-hook.exe / ccode-hook.ps1）
#[cfg(any(windows, test))]
fn win_hook_form_stale(config_text: &str, want_native: bool) -> bool {
    if want_native {
        config_text.contains(WIN_HOOK_SCRIPT)
    } else {
        config_text.contains(WIN_HOOK_EXE)
    }
}

/// 应用开关：enabled=true 合并 hooks 配置，false 移除我们的条目；写前备份 + 原子写。
/// 关闭时顺带清理状态日志；未安装过（文件不存在）时关闭是无操作。
/// grok 整文件形态：开启=写文件（已存在且不含 marker 则报错拒绝覆盖），关闭=删文件。
fn apply_hooks_at(
    spec: &BridgeSpec,
    home: &Path,
    log_path: &Path,
    backups: &Path,
    enabled: bool,
) -> Result<(), String> {
    let config_path = home.join(spec.config_rel);
    let marker = spec.marker();
    #[cfg(windows)]
    if enabled {
        write_win_hook_script(log_path)?;
    }
    if spec.family == DocFamily::HooksFileJson {
        if enabled {
            let existing = read_existing(&config_path)?;
            if let Some(t) = &existing {
                if !has_marker(t, &marker) {
                    return Err(format!(
                        "{} 已存在且不是本应用写入的（不含标记），为避免误删他人配置已拒绝覆盖",
                        spec.display()
                    ));
                }
                backup_config(spec, backups, &config_path)?;
            }
            if let Some(parent) = config_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("创建 {} 失败: {e}", parent.display()))?;
            }
            crate::profiles::atomic_write(
                &config_path,
                &whole_file_doc(spec, &global_hook_command(log_path))?,
            )?;
            return Ok(());
        }
        // 关闭：读不了的文件（非 UTF-8 等）不可能是我们写的，按「不是我们的」处理
        return match read_existing(&config_path).unwrap_or(None) {
            None => Ok(()), // 未安装过：无操作
            Some(t) if has_marker(&t, &marker) => {
                backup_config(spec, backups, &config_path)?;
                fs::remove_file(&config_path)
                    .map_err(|e| format!("删除 {} 失败: {e}", spec.display()))?;
                fs::remove_file(log_path).ok(); // 关闭即清理状态日志，避免残留状态被误读
                Ok(())
            }
            // 文件不是我们的：不动它，只清状态日志
            Some(_) => {
                fs::remove_file(log_path).ok();
                Ok(())
            }
        };
    }
    let existing = read_existing(&config_path)?;
    if !enabled && existing.is_none() {
        return Ok(());
    }
    let content = if enabled {
        let command = global_hook_command(log_path);
        match spec.family {
            DocFamily::KimiToml => merge_kimi_toml(spec, existing.as_deref(), &command)?,
            _ => merge_json_doc(spec, existing.as_deref(), &command)?,
        }
    } else {
        match spec.family {
            DocFamily::KimiToml => remove_kimi_toml(spec, existing.as_deref())?,
            _ => remove_json_doc(spec, existing.as_deref())?,
        }
    };
    if existing.is_some() {
        backup_config(spec, backups, &config_path)?;
    }
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 {} 失败: {e}", parent.display()))?;
    }
    crate::profiles::atomic_write(&config_path, &content)?;
    if !enabled {
        fs::remove_file(log_path).ok(); // 关闭即清理状态日志，避免残留状态被误读
    }
    Ok(())
}

// ===== 状态日志读取（注意力分类数据源） =====

pub(crate) struct HookRecord {
    pub(crate) ts: i64,
    /// 拉起这个 CLI 的 Mesa 标签（hook 命令记下的 CCODE_TAB_ID）；旧格式记录与 Mesa 外的终端为 None
    pub(crate) tab: Option<String>,
    pub(crate) session_id: String,
    pub(crate) transcript_path: Option<String>,
    /// 归一化事件名（去下划线 + 全小写；grok 值是 snake_case，其余 PascalCase）
    pub(crate) event: String,
    reason: Option<String>,
    /// 「在等什么」的人类可读摘要（claude Notification 的 message、PermissionRequest 的工具名等）；
    /// 尽力提取，schema 各家不同且未文档化，取不到就 None
    detail: Option<String>,
    /// 整条事件 JSON（超过上限被截断的记录为 None，只剩上面几个按字段名兜底取到的值）
    pub(crate) payload: Option<Value>,
}

fn normalize_event(raw: &str) -> String {
    raw.chars()
        .filter(|c| *c != '_')
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 归一化事件 → 注意力状态；一张表覆盖七家桥接的全部事件名
fn event_state(normalized: &str) -> Option<&'static str> {
    match normalized {
        "userpromptsubmit" | "beforeagent" => Some("working"),
        // 工具开始 / 结束：批准之后工具还在跑，不能停在上一条「待确认」上
        "pretooluse" | "posttooluse" | "beforetool" | "aftertool" => Some("working"),
        // 回合确定结束：同会话文件里的 turn_duration / task_complete 判 settled，前端不再等 PTY 静下来
        // （2026-10-18 用户截图：Codex 开着精确注意力，回答落盘后聊天层仍「正在回复」）
        "stop" | "afteragent" => Some("settled"),
        "notification" | "permissionrequest" => Some("confirm"),
        _ => None,
    }
}

/// 截断的 JSON 里按字段名取字符串值（payload 超上限时 hook 命令截了尾，事件名和会话 id 在前面）
fn loose_str_field(body: &str, keys: &[&str]) -> Option<String> {
    for key in keys {
        let needle = format!("\"{key}\"");
        let Some(at) = body.find(&needle) else {
            continue;
        };
        let rest = body[at + needle.len()..].trim_start();
        let Some(rest) = rest.strip_prefix(':') else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('"') else {
            continue;
        };
        let mut out = String::new();
        let mut chars = rest.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => return Some(out),
                '\\' => {
                    if let Some(n) = chars.next() {
                        out.push(match n {
                            'n' => '\n',
                            't' => '\t',
                            other => other,
                        });
                    }
                }
                c => out.push(c),
            }
        }
    }
    None
}

/// 防御式解析日志：一行一条 `<unix秒> [<标签号>] <事件JSON>`；容忍坏行、末行截断与 pretty JSON 续行
/// （hook stdin 若非单行 JSON，续行拼回上一条记录再解析）。标签号段是 2026-10-20 起的新格式，
/// 旧记录没有这一段（第二段直接是 `{`）。
/// 信封兼容：claude/qwen/codebuddy/gemini/codex/kimi 用 snake_case 键，grok 用 camelCase 键。
pub(crate) fn parse_log_records(text: &str) -> Vec<HookRecord> {
    fn push(out: &mut Vec<HookRecord>, buf: &str) {
        let Some((ts_s, rest)) = buf.split_once(' ') else {
            return;
        };
        let Ok(ts) = ts_s.parse::<i64>() else { return };
        let rest = rest.trim_start();
        let (tab, body) = if rest.starts_with('{') {
            (None, rest)
        } else {
            let Some((tab, body)) = rest.split_once(' ') else {
                return;
            };
            ((tab != "-" && !tab.is_empty()).then(|| tab.to_string()), body)
        };
        let payload = serde_json::from_str::<Value>(body).ok();
        let get = |snake: &str, camel: &str| -> Option<String> {
            match &payload {
                Some(v) => v
                    .get(snake)
                    .or_else(|| v.get(camel))
                    .and_then(|x| x.as_str())
                    .map(String::from),
                None => loose_str_field(body, &[snake, camel]),
            }
        };
        let (Some(sid), Some(ev)) = (
            get("session_id", "sessionId"),
            get("hook_event_name", "hookEventName"),
        ) else {
            return;
        };
        out.push(HookRecord {
            ts,
            tab,
            session_id: sid,
            transcript_path: get("transcript_path", "transcriptPath"),
            event: normalize_event(&ev),
            reason: get("reason", "reason"),
            // 「在等什么」详情：各家 payload 字段未文档化，按已知形态尽力提取——
            // claude/qwen/codebuddy/gemini Notification 有 message；kimi/codex PermissionRequest
            // 可能带 tool_name/title；都取不到就 None（横幅退回通用文案）
            detail: ["message", "tool_name", "toolName", "title"]
                .iter()
                .find_map(|k| match &payload {
                    Some(v) => v.get(*k).and_then(|x| x.as_str()).map(String::from),
                    None => loose_str_field(body, &[k]),
                }),
            payload,
        });
    }
    let mut out = Vec::new();
    let mut buf = String::new();
    for line in text.lines() {
        let starts_record = line
            .split_once(' ')
            .is_some_and(|(head, _)| head.parse::<i64>().is_ok());
        if starts_record {
            if !buf.is_empty() {
                push(&mut out, &buf);
            }
            buf = line.to_string();
        } else if !buf.is_empty() {
            buf.push_str(line); // pretty JSON 续行
        }
    }
    if !buf.is_empty() {
        push(&mut out, &buf);
    }
    out
}

/// 取该会话最新事件映射的注意力状态与详情；无记录或最新事件已过期（>TTL）返回 None（回落尾部推断）。
/// 会话归属双键匹配：记录 session_id == 会话文件主名，或 transcript_path == 会话文件完整路径
/// （grok 会话文件主名恒为 updates，必须靠 transcript_path 命中；kimi 无 transcript_path 自然只用前者）。
/// grok 的 Stop 在会话 teardown 时会以 reason=shutdown/channel_closed 重复 fire：
/// stop 事件只认 reason 缺失或 "end_turn" 的记录，其余 reason 跳过不更新状态。
fn latest_from_text(
    text: &str,
    session_id: &str,
    file_path: &str,
    now: i64,
) -> Option<(&'static str, Option<String>)> {
    let mut best: Option<(i64, &'static str, Option<String>)> = None;
    for rec in parse_log_records(text) {
        if rec.session_id != session_id
            && !rec
                .transcript_path
                .as_deref()
                .is_some_and(|p| crate::paths::same_path(p, file_path))
        {
            continue;
        }
        if rec.event == "stop" && rec.reason.as_deref().is_some_and(|r| r != "end_turn") {
            continue;
        }
        let Some(state) = event_state(&rec.event) else {
            continue;
        };
        if best.as_ref().is_none_or(|(ts, _, _)| rec.ts >= *ts) {
            best = Some((rec.ts, state, rec.detail));
        }
    }
    let (ts, state, detail) = best?;
    if now - ts > HOOKS_TTL_SECS {
        return None;
    }
    Some((state, detail))
}

fn state_from_text(text: &str, session_id: &str, file_path: &str, now: i64) -> Option<String> {
    latest_from_text(text, session_id, file_path, now).map(|(state, _)| state.to_string())
}

fn read_log_tail(path: &Path) -> String {
    let Ok(mut f) = fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len > LOG_TAIL_WINDOW && f.seek(SeekFrom::Start(len - LOG_TAIL_WINDOW)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// sessions::tail_state_impl 的精确标记融合入口：
/// 仅当 agent 在桥接注册表内、设置开启、且日志内有该会话的未过期事件时返回精确状态，
/// 其余情况 None 回落尾部推断。
pub(crate) fn state_for_session_file(agent: &str, file_path: &str) -> Option<String> {
    let spec = spec_for(agent)?;
    if !precise_enabled(agent) {
        return None;
    }
    let session_id = Path::new(file_path)
        .file_stem()?
        .to_string_lossy()
        .into_owned();
    if session_id.is_empty() {
        return None;
    }
    let log = hooks_log_path(spec).ok()?;
    state_from_text(&read_log_tail(&log), &session_id, file_path, now_unix())
}

// ===== Tauri commands =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookSupportDto {
    pub agent: String,
    pub supported: bool,
    /// 支持但有注意事项 / 不支持的原因；None = 支持且无额外提示
    pub note: Option<String>,
    /// 支持的 agent 的配置文件展示路径（设置页提示用）
    pub config_path: Option<String>,
    /// Mesa 拉起时自动带精确事件（不写用户配置），设置页不给开关
    pub auto: bool,
}

/// 注意事项/不支持原因（None = 支持且无额外提示）
fn support_note(agent: &str) -> Option<&'static str> {
    match agent {
        "claude-code" | "codebuddy" => Some("在 Mesa 里启动时自动带上（启动参数注入，不改你的配置）"),
        "qwen" => Some("在 Mesa 里启动时自动带上（Qwen 自带的结构化输出通道）"),
        "opencode" => Some("在 Mesa 里启动时自动带上（OpenCode 自带的本机服务）"),
        "codex" => Some("在 Mesa 里启动时自动带上（Codex 自带的 app-server 通道）"),
        "cursor" => Some("无「等待确认」原生事件，暂不支持"),
        _ => None,
    }
}

/// 设置页「精确注意力标记」列表：九家全列出，支持与否 + 备注
#[tauri::command]
pub async fn hooks_attention_support() -> Vec<HookSupportDto> {
    crate::agent_specs::all_agent_specs()
        .iter()
        .map(|s| {
            let spec = spec_for(s.id);
            let auto = launch_injected(s.id);
            HookSupportDto {
                agent: s.id.to_string(),
                supported: auto || spec.is_some(),
                note: support_note(s.id).map(String::from),
                config_path: if auto { None } else { spec.map(|sp| sp.display()) },
                auto,
            }
        })
        .collect()
}

/// 聊天层审批卡片的数据源：当前「等待确认」事件的详情（如 claude 的
/// "Claude needs your permission to use Bash"，PermissionRequest 的工具名）。
/// 与 state_for_session_file 同一套门控（注册表/设置开关/归属匹配/TTL）；
/// 最新状态不是 confirm 或 payload 没带可读字段时返回 None（前端回落通用文案）。
#[tauri::command]
pub async fn session_confirm_detail(agent: String, file_path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let spec = spec_for(&agent)?;
        if !precise_enabled(&agent) {
            return None;
        }
        let session_id = Path::new(&file_path)
            .file_stem()?
            .to_string_lossy()
            .into_owned();
        if session_id.is_empty() {
            return None;
        }
        let log = hooks_log_path(spec).ok()?;
        let (state, detail) =
            latest_from_text(&read_log_tail(&log), &session_id, &file_path, now_unix())?;
        if state != "confirm" {
            return None;
        }
        detail
    })
    .await
    .ok()
    .flatten()
}

/// 设置页开关：先改该 agent 的 hooks 配置（备份+原子写），成功后记应用设置；
/// 应用设置写失败时回滚 hooks，避免开关显示与实际安装不一致。
#[tauri::command]
pub async fn set_hooks_attention(
    agent: String,
    enabled: bool,
) -> Result<crate::settings::AppSettingsDto, String> {
    let spec = spec_for(&agent).ok_or_else(|| format!("{agent} 暂不支持精确注意力标记"))?;
    if enabled && launch_injected(&agent) {
        return Err(format!("{agent} 在 Mesa 里启动时已自动带上，不需要写全局配置"));
    }
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    let log = hooks_log_path(spec)?;
    let backups = backups_dir()?;
    {
        let (h, l, b) = (home.clone(), log.clone(), backups.clone());
        tauri::async_runtime::spawn_blocking(move || apply_hooks_at(spec, &h, &l, &b, enabled))
            .await
            .map_err(|e| format!("切换精确注意力标记失败: {e}"))??;
    }
    match crate::settings::set_hooks_attention_entry(&agent, enabled) {
        Ok(full) => Ok(full),
        Err(e) => {
            tauri::async_runtime::spawn_blocking(move || {
                apply_hooks_at(spec, &home, &log, &backups, !enabled)
            })
            .await
            .ok();
            Err(format!("应用设置保存失败，已还原 {agent} hooks 配置: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-hooks-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn claude() -> &'static BridgeSpec {
        spec_for("claude-code").unwrap()
    }

    // ===== JSON 设置文档族（claude 为代表） =====

    #[test]
    fn merge_into_empty_creates_three_events_idempotent() {
        let spec = claude();
        let out = merge_json_doc(spec, None, "CMD hooks-state/claude-hooks.jsonl").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        for (event, _) in spec.events {
            let arr = v["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{event} 一条我们的条目");
            assert_eq!(
                arr[0]["hooks"][0]["command"],
                "CMD hooks-state/claude-hooks.jsonl"
            );
        }
        // 重复合并不叠加
        let out2 = merge_json_doc(spec, Some(&out), "CMD hooks-state/claude-hooks.jsonl").unwrap();
        let v2: Value = serde_json::from_str(&out2).unwrap();
        for (event, _) in spec.events {
            assert_eq!(
                v2["hooks"][event].as_array().unwrap().len(),
                1,
                "{event} 幂等"
            );
        }
    }

    #[test]
    fn merge_preserves_user_hooks_and_other_keys() {
        let existing = r#"{
            "env": {"FOO": "bar"},
            "hooks": {
                "Notification": [
                    {"matcher": "", "hooks": [{"type": "command", "command": "user-script"}]}
                ]
            }
        }"#;
        let out = merge_json_doc(
            claude(),
            Some(existing),
            "CMD hooks-state/claude-hooks.jsonl",
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["FOO"], "bar", "其他配置键保留");
        let notif = v["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 2, "用户条目保留 + 追加我们的");
        assert_eq!(notif[0]["hooks"][0]["command"], "user-script");
    }

    #[test]
    fn merge_and_remove_reject_broken_json() {
        assert!(merge_json_doc(claude(), Some("{broken"), "CMD").is_err());
        assert!(remove_json_doc(claude(), Some("{broken")).is_err());
        assert!(
            merge_json_doc(claude(), Some(r#"{"hooks": 42}"#), "CMD").is_err(),
            "hooks 非对象拒绝"
        );
        assert!(
            merge_json_doc(claude(), Some(r#"{"hooks": {"Stop": {"x": 1}}}"#), "CMD").is_err(),
            "事件非数组拒绝"
        );
    }

    #[test]
    fn remove_only_ours_and_cleans_empty_shells() {
        let existing = r#"{
            "env": {"FOO": "bar"},
            "hooks": {
                "Stop": [
                    {"matcher": "", "hooks": [{"type": "command", "command": "user-stop"}]},
                    {"matcher": "", "hooks": [
                        {"type": "command", "command": "x hooks-state/claude-hooks.jsonl y"},
                        {"type": "command", "command": "user-mixed"}
                    ]}
                ],
                "UserPromptSubmit": [
                    {"matcher": "", "hooks": [{"type": "command", "command": "x hooks-state/claude-hooks.jsonl"}]}
                ]
            }
        }"#;
        let out = remove_json_doc(claude(), Some(existing)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["FOO"], "bar");
        // Stop：我们的命令被剔除但同组的用户命令保留，组与用户组都在
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        let cmds: Vec<&str> = stop
            .iter()
            .flat_map(|g| g["hooks"].as_array().unwrap().iter())
            .map(|h| h["command"].as_str().unwrap())
            .collect();
        assert_eq!(cmds, ["user-stop", "user-mixed"], "只删我们的条目");
        // UserPromptSubmit 只剩我们的条目 → 事件键整体回收
        assert!(v["hooks"].get("UserPromptSubmit").is_none());
    }

    #[test]
    fn remove_drops_hooks_key_when_empty() {
        let existing = r#"{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "hooks-state/claude-hooks.jsonl"}]}]}}"#;
        let out = remove_json_doc(claude(), Some(existing)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("hooks").is_none(), "hooks 清空后回收键");
        // 本来就没有 hooks 段：原样（不报错）
        let out = remove_json_doc(claude(), Some(r#"{"env": {}}"#)).unwrap();
        assert!(serde_json::from_str::<Value>(&out)
            .unwrap()
            .get("hooks")
            .is_none());
    }

    /// qwen/gemini 容错读：带注释与尾逗号的 JSONC 可合并，其余键保留
    #[test]
    fn jsonc_tolerant_family_merges_comments_and_trailing_commas() {
        let existing = "{\n  // 用户注释\n  \"theme\": \"dark\",\n}\n";
        let out = merge_json_doc(
            spec_for("qwen").unwrap(),
            Some(existing),
            "CMD hooks-state/qwen-hooks.jsonl",
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["theme"], "dark", "JSONC 容错读且其他键保留");
        // qwen 的 Notification 带 matcher；其余事件空 matcher
        let notif = v["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif[0]["matcher"], "permission_prompt|idle_prompt");
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap()[0]["matcher"], "");
        // 容错族对真正的坏 JSON 同样拒绝
        assert!(merge_json_doc(spec_for("gemini").unwrap(), Some("{broken"), "CMD").is_err());
    }

    /// codex：handler 带 async:true，confirm 槽是 PermissionRequest
    #[test]
    fn codex_handlers_carry_async_and_permission_request() {
        let out = merge_json_doc(
            spec_for("codex").unwrap(),
            None,
            "CMD hooks-state/codex-hooks.jsonl",
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        for event in ["UserPromptSubmit", "Stop", "PermissionRequest"] {
            let arr = v["hooks"][event].as_array().unwrap();
            assert_eq!(
                arr[0]["hooks"][0]["async"], true,
                "{event} handler 带 async"
            );
        }
        assert!(
            v["hooks"].get("Notification").is_none(),
            "codex 不写 Notification"
        );
    }

    // ===== kimi TOML 文档族 =====

    #[test]
    fn kimi_toml_merge_strict_four_fields_preserves_other_keys() {
        let existing = "default_model = \"ccode\"\n\n[providers.ccode]\ntype = \"kimi\"\n";
        let out = merge_kimi_toml(
            spec_for("kimi").unwrap(),
            Some(existing),
            "sh hooks-state/kimi-hooks.jsonl",
        )
        .unwrap();
        let doc = out.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(
            doc["default_model"].as_str(),
            Some("ccode"),
            "其余键原样保留"
        );
        assert_eq!(doc["providers"]["ccode"]["type"].as_str(), Some("kimi"));
        let arr = doc["hooks"].as_array_of_tables().unwrap();
        assert_eq!(arr.len(), 3);
        let events: Vec<&str> = arr.iter().map(|t| t["event"].as_str().unwrap()).collect();
        assert_eq!(events, ["UserPromptSubmit", "Stop", "PermissionRequest"]);
        for t in arr.iter() {
            // strict 四字段，多写字段会导致 kimi 整个配置加载失败
            let keys: Vec<&str> = t.iter().map(|(k, _)| k).collect();
            assert_eq!(keys, ["event", "matcher", "command", "timeout"]);
            assert_eq!(t["timeout"].as_integer(), Some(30));
        }
        // 幂等：重复合并不叠加
        let out2 = merge_kimi_toml(
            spec_for("kimi").unwrap(),
            Some(&out),
            "sh hooks-state/kimi-hooks.jsonl",
        )
        .unwrap();
        let doc2 = out2.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(doc2["hooks"].as_array_of_tables().unwrap().len(), 3);
    }

    #[test]
    fn kimi_toml_remove_only_ours_and_rejects_misshaped() {
        let existing = "[x]\ny = 1\n\n[[hooks]]\nevent = \"Stop\"\nmatcher = \"\"\ncommand = \"user-cmd\"\ntimeout = 5\n\n[[hooks]]\nevent = \"Stop\"\nmatcher = \"\"\ncommand = \"sh hooks-state/kimi-hooks.jsonl\"\ntimeout = 30\n";
        let out = remove_kimi_toml(spec_for("kimi").unwrap(), Some(existing)).unwrap();
        let doc = out.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(doc["x"]["y"].as_integer(), Some(1), "其余键原样保留");
        let arr = doc["hooks"].as_array_of_tables().unwrap();
        assert_eq!(arr.len(), 1, "只删我们的条目");
        assert_eq!(arr.get(0).unwrap()["command"].as_str(), Some("user-cmd"));
        // 只剩我们的条目 → hooks 键整体回收
        let ours_only = "[[hooks]]\nevent = \"Stop\"\nmatcher = \"\"\ncommand = \"sh hooks-state/kimi-hooks.jsonl\"\ntimeout = 30\n";
        let out = remove_kimi_toml(spec_for("kimi").unwrap(), Some(ours_only)).unwrap();
        assert!(out
            .parse::<toml_edit::DocumentMut>()
            .unwrap()
            .get("hooks")
            .is_none());
        // hooks 不是数组表 → 拒绝
        assert!(
            merge_kimi_toml(spec_for("kimi").unwrap(), Some("[hooks]\nx = 1\n"), "CMD").is_err()
        );
        // 坏 TOML → 拒绝
        assert!(merge_kimi_toml(spec_for("kimi").unwrap(), Some("= broken"), "CMD").is_err());
    }

    // ===== grok 整文件族 =====

    #[test]
    fn grok_whole_file_create_delete_and_reject_foreign() {
        let dir = tmpdir("grok");
        let home = dir.join("home");
        let log = dir.join("hooks-state").join("grok-hooks.jsonl");
        let backups = dir.join("backups");
        let spec = spec_for("grok").unwrap();
        let config = home.join(spec.config_rel);

        // 开启：整文件创建，三事件组结构
        apply_hooks_at(spec, &home, &log, &backups, true).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
        for (event, _) in spec.events {
            assert!(v["hooks"][event].is_array(), "{event} 已写入");
        }
        assert_eq!(
            v["hooks"]["Notification"][0]["matcher"],
            "permission_prompt|idle_prompt"
        );

        // 重复开启：含 marker → 幂等重写 + 备份
        apply_hooks_at(spec, &home, &log, &backups, true).unwrap();
        assert_eq!(
            fs::read_dir(&backups).unwrap().count(),
            1,
            "覆盖我们的文件前备份"
        );

        // 外来文件（无 marker）：开启拒绝覆盖
        let foreign_home = dir.join("home2");
        let foreign = foreign_home.join(spec.config_rel);
        fs::create_dir_all(foreign.parent().unwrap()).unwrap();
        fs::write(&foreign, r#"{"hooks": {"Stop": []}}"#).unwrap();
        let err = apply_hooks_at(spec, &foreign_home, &log, &backups, true).unwrap_err();
        assert!(err.contains("拒绝覆盖"), "{err}");
        // 外来文件上关闭：不删文件
        apply_hooks_at(spec, &foreign_home, &log, &backups, false).ok();
        assert!(foreign.exists(), "外来文件不被删除");

        // 关闭：删文件 + 清状态日志 + 备份
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        fs::write(&log, "1 {}\n").unwrap();
        apply_hooks_at(spec, &home, &log, &backups, false).unwrap();
        assert!(!config.exists(), "关闭删整文件");
        assert!(!log.exists(), "关闭清理状态日志");
        fs::remove_dir_all(&dir).ok();
    }

    // ===== 日志解析 =====

    #[test]
    fn parse_log_records_tolerates_multiline_and_garbage() {
        let text = "not-a-record\n\
                    100 {\"session_id\": \"s1\", \"hook_event_name\": \"UserPromptSubmit\"}\n\
                    101 {\n  \"session_id\": \"s1\",\n  \"hook_event_name\": \"Stop\"\n}\n\
                    102 {broken json\n\
                    103 {\"hook_event_name\": \"Stop\"}\n";
        let recs = parse_log_records(text);
        assert_eq!(recs.len(), 2, "坏行与缺字段行跳过");
        assert_eq!(recs[0].ts, 100);
        assert_eq!(
            recs[1].event, "stop",
            "pretty JSON 续行拼回解析 + 事件名归一化"
        );
    }

    /// snake_case（claude 等）与 camelCase（grok）双信封都可解析
    #[test]
    fn parse_log_records_accepts_snake_and_camel_envelopes() {
        let text = "100 {\"session_id\": \"s1\", \"hook_event_name\": \"Notification\", \"transcript_path\": \"/t/a.jsonl\"}\n\
                    101 {\"sessionId\": \"s2\", \"hookEventName\": \"user_prompt_submit\", \"transcriptPath\": \"/t/b.jsonl\"}\n";
        let recs = parse_log_records(text);
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].session_id, "s1");
        assert_eq!(recs[0].transcript_path.as_deref(), Some("/t/a.jsonl"));
        assert_eq!(recs[1].session_id, "s2");
        assert_eq!(recs[1].event, "userpromptsubmit", "snake_case 事件值归一化");
        assert_eq!(recs[1].transcript_path.as_deref(), Some("/t/b.jsonl"));
    }

    /// 事件名归一化：七家全部事件名映射到三态
    #[test]
    fn event_state_covers_all_bridge_events() {
        for (raw, want) in [
            ("UserPromptSubmit", "working"),
            ("BeforeAgent", "working"),
            ("user_prompt_submit", "working"),
            ("Stop", "settled"),
            ("AfterAgent", "settled"),
            ("stop", "settled"),
            ("Notification", "confirm"),
            ("PermissionRequest", "confirm"),
            ("notification", "confirm"),
        ] {
            assert_eq!(event_state(&normalize_event(raw)), Some(want), "{raw}");
        }
        assert_eq!(event_state(&normalize_event("Whatever")), None);
    }

    #[test]
    fn state_from_text_latest_event_and_ttl() {
        let text = "100 {\"session_id\": \"s1\", \"hook_event_name\": \"UserPromptSubmit\"}\n\
                    200 {\"session_id\": \"s2\", \"hook_event_name\": \"Notification\"}\n\
                    300 {\"session_id\": \"s1\", \"hook_event_name\": \"Stop\"}\n";
        assert_eq!(
            state_from_text(text, "s1", "/x/s1.jsonl", 310).as_deref(),
            Some("settled"),
            "取最新事件"
        );
        assert_eq!(
            state_from_text(text, "s2", "/x/s2.jsonl", 310).as_deref(),
            Some("confirm")
        );
        assert_eq!(
            state_from_text(text, "s3", "/x/s3.jsonl", 310),
            None,
            "无记录 → None"
        );
        assert_eq!(
            state_from_text(text, "s1", "/x/s1.jsonl", 300 + HOOKS_TTL_SECS + 1),
            None,
            "过期 → None 回落尾部推断"
        );
        let working = "100 {\"session_id\": \"s1\", \"hook_event_name\": \"UserPromptSubmit\"}";
        assert_eq!(
            state_from_text(working, "s1", "/x/s1.jsonl", 120).as_deref(),
            Some("working")
        );
    }

    /// grok：Stop 只认 reason=end_turn（或无 reason）；shutdown/channel_closed 的 teardown 记录不更新状态
    #[test]
    fn grok_stop_reason_filter() {
        let text = "100 {\"sessionId\": \"s1\", \"hookEventName\": \"user_prompt_submit\"}\n\
                    200 {\"sessionId\": \"s1\", \"hookEventName\": \"stop\", \"reason\": \"end_turn\"}\n\
                    300 {\"sessionId\": \"s1\", \"hookEventName\": \"stop\", \"reason\": \"shutdown\"}\n";
        assert_eq!(
            state_from_text(text, "s1", "/x/updates.jsonl", 310).as_deref(),
            Some("settled"),
            "teardown 的 shutdown stop 跳过，取 end_turn"
        );
        // 只有 teardown 记录 → 最近有效事件仍是 working
        let torn = "100 {\"sessionId\": \"s1\", \"hookEventName\": \"user_prompt_submit\"}\n\
                    300 {\"sessionId\": \"s1\", \"hookEventName\": \"stop\", \"reason\": \"channel_closed\"}\n";
        assert_eq!(
            state_from_text(torn, "s1", "/x/updates.jsonl", 310).as_deref(),
            Some("working")
        );
        // 无 reason 的 stop（claude 等）照常认
        let plain = "100 {\"session_id\": \"s1\", \"hook_event_name\": \"Stop\"}";
        assert_eq!(
            state_from_text(plain, "s1", "/x/s1.jsonl", 110).as_deref(),
            Some("settled")
        );
    }

    /// 双键匹配：session_id 命中文件主名，或 transcript_path 命中完整路径
    /// （grok 会话文件主名恒为 updates，必须靠 transcriptPath 命中）
    #[test]
    fn dual_key_session_matching() {
        let text = "100 {\"sessionId\": \"grok-abc\", \"hookEventName\": \"notification\", \"transcriptPath\": \"/home/u/.grok/sessions/-proj/grok-abc/updates.jsonl\"}\n\
                    200 {\"session_id\": \"kimi-1\", \"hook_event_name\": \"PermissionRequest\"}\n";
        // grok：session_id 与主名 updates 不符，transcriptPath 完整路径命中
        assert_eq!(
            state_from_text(
                text,
                "updates",
                "/home/u/.grok/sessions/-proj/grok-abc/updates.jsonl",
                210
            )
            .as_deref(),
            Some("confirm"),
            "updates.jsonl 靠 transcriptPath 命中"
        );
        // 主名命中但 transcript 不符也算（其他会话的主名恰好叫 updates 时按前者口径）
        assert_eq!(
            state_from_text(
                text,
                "kimi-1",
                "/home/u/.kimi-code/sessions/kimi-1.jsonl",
                210
            )
            .as_deref(),
            Some("confirm"),
            "kimi 无 transcript_path，靠 session_id == 主名"
        );
        // 双键都不中 → None
        assert_eq!(
            state_from_text(text, "other", "/elsewhere/x.jsonl", 210),
            None
        );
        #[cfg(windows)]
        {
            let win = "100 {\"sessionId\": \"grok-abc\", \"hookEventName\": \"notification\", \"transcriptPath\": \"C:\\\\Users\\\\u\\\\.grok\\\\sessions\\\\proj\\\\updates.jsonl\"}\n";
            assert_eq!(
                state_from_text(
                    win,
                    "updates",
                    r"c:\users\u\.grok\sessions\proj\updates.jsonl",
                    110
                )
                .as_deref(),
                Some("confirm"),
                "Windows 下分隔符与盘符大小写差异仍应命中"
            );
        }
    }

    // ===== 事务写入（claude 为代表，覆盖备份/清理/无操作） =====

    #[test]
    fn apply_hooks_at_roundtrip_backup_and_cleanup() {
        let dir = tmpdir("roundtrip");
        let home = dir.join("home");
        let log = dir.join("hooks-state").join("claude-hooks.jsonl");
        let backups = dir.join("backups");
        let spec = claude();
        let settings = home.join(spec.config_rel);
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(&settings, r#"{"env": {"KEEP": "1"}}"#).unwrap();
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        fs::write(&log, "1 {}\n").unwrap();

        // 开启：hooks 写入、原文件被备份、其他键保留
        apply_hooks_at(spec, &home, &log, &backups, true).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["env"]["KEEP"], "1");
        assert!(v["hooks"]["Stop"].is_array());
        let baks: Vec<_> = fs::read_dir(&backups).unwrap().flatten().collect();
        assert_eq!(baks.len(), 1, "写前备份");
        assert!(
            baks[0]
                .file_name()
                .to_string_lossy()
                .starts_with("claude-hooks-settings-"),
            "备份前缀按 agent 区分（claude 沿用既有前缀）"
        );

        // 关闭：hooks 段移除、其他键保留、状态日志清理、再留一份备份
        apply_hooks_at(spec, &home, &log, &backups, false).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["env"]["KEEP"], "1");
        assert!(v.get("hooks").is_none());
        assert!(!log.exists(), "关闭清理状态日志");
        assert_eq!(fs::read_dir(&backups).unwrap().count(), 2);

        // 未安装过（文件不存在）时关闭 = 无操作
        let missing_home = dir.join("nope");
        apply_hooks_at(spec, &missing_home, &log, &backups, false).unwrap();
        assert!(!missing_home.join(spec.config_rel).exists());
        fs::remove_dir_all(&dir).ok();
    }

    /// kimi 端到端：config.toml 合并/移除走文件，备份用 .toml 扩展名
    #[test]
    fn apply_hooks_at_kimi_toml_roundtrip() {
        let dir = tmpdir("kimi");
        let home = dir.join("home");
        let log = dir.join("hooks-state").join("kimi-hooks.jsonl");
        let backups = dir.join("backups");
        let spec = spec_for("kimi").unwrap();
        let config = home.join(spec.config_rel);
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        fs::write(&config, "default_model = \"ccode\"\n").unwrap();

        apply_hooks_at(spec, &home, &log, &backups, true).unwrap();
        let text = fs::read_to_string(&config).unwrap();
        let doc = text.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(doc["default_model"].as_str(), Some("ccode"), "其余键保留");
        assert_eq!(doc["hooks"].as_array_of_tables().unwrap().len(), 3);
        let bak = fs::read_dir(&backups).unwrap().flatten().next().unwrap();
        assert!(
            bak.file_name()
                .to_string_lossy()
                .starts_with("kimi-hooks-settings-"),
            "备份前缀按 agent 区分"
        );
        assert!(bak.path().extension().is_some_and(|e| e == "toml"));

        apply_hooks_at(spec, &home, &log, &backups, false).unwrap();
        let doc = fs::read_to_string(&config)
            .unwrap()
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        assert!(doc.get("hooks").is_none(), "关闭后 hooks 键回收");
        assert_eq!(doc["default_model"].as_str(), Some("ccode"));
        fs::remove_dir_all(&dir).ok();
    }

    /// Windows 新命令形态：只有两个双引号路径，无 `$`/单引号；日志路径留在命令里，marker 照常命中；
    /// 旧版内联 `-Command "$d=…"` 条目在重新开启时被替换而不是叠加
    #[test]
    fn legacy_win_hook_detection_matches_old_form_only() {
        let old_json = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"powershell -NoProfile -Command \"$d='C:\\Users\\x\\AppData\\Roaming\\ccode\\hooks-state';\""}]}]}}"#;
        assert!(is_legacy_win_hook(old_json));
        let new_json = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"C:/x/hooks-state/ccode-hook.ps1\" \"C:/x/hooks-state/claude-hooks.jsonl\""}]}]}}"#;
        assert!(!is_legacy_win_hook(new_json));
        assert!(!is_legacy_win_hook("{}"));
    }

    /// 旧版内联 `-Command "$d=…"` 条目在重新开启时被替换而不是叠加
    #[test]
    fn win_hook_command_is_shell_neutral_and_replaces_old_form() {
        let (log, root) = if cfg!(windows) {
            (
                r"C:\Users\张 三\AppData\Roaming\ccode\hooks-state\claude-hooks.jsonl",
                "C:/Users/张 三/AppData/Roaming",
            )
        } else {
            (
                "/home/张 三/.config/ccode/hooks-state/claude-hooks.jsonl",
                "/home/张 三/.config",
            )
        };
        let cmd = win_hook_command(Path::new(log), PAYLOAD_CAP);
        assert_eq!(
            cmd,
            format!(
                "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \
                 \"{root}/ccode/hooks-state/ccode-hook.ps1\" \
                 \"{root}/ccode/hooks-state/claude-hooks.jsonl\" {PAYLOAD_CAP}"
            )
        );
        assert!(!cmd.contains('$') && !cmd.contains('\'') && !cmd.contains('\\'));
        let spec = claude();
        assert!(has_marker(&cmd, &spec.marker()));
        assert!(WIN_HOOK_SCRIPT_BODY.is_ascii(), "PS 5.1 按 ANSI 读无 BOM 脚本，正文必须纯 ASCII");
        assert!(
            WIN_HOOK_SCRIPT_BODY.contains("CCODE_TAB_ID") && WIN_HOOK_SCRIPT_BODY.contains("$Cap"),
            "脚本要带标签号并按 Cap 截断，语义同 unix 命令"
        );

        let old = r#"powershell -NoProfile -Command "$d='C:\Users\x\AppData\Roaming\ccode\hooks-state';New-Item -ItemType Directory -Force -Path $d|Out-Null;$u=New-Object Text.UTF8Encoding $false;$l=(New-Object IO.StreamReader ([Console]::OpenStandardInput()),$u).ReadToEnd();[IO.File]::AppendAllText('C:\Users\x\AppData\Roaming\ccode\hooks-state\claude-hooks.jsonl',(([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()).ToString()+' '+($l -replace '\s+',' ')+[Environment]::NewLine),$u)""#;
        let existing = merge_json_doc(spec, None, old).unwrap();
        let out = merge_json_doc(spec, Some(&existing), &cmd).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        for (event, _) in spec.events {
            let arr = v["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{event} 旧条目被替换");
            assert_eq!(arr[0]["hooks"][0]["command"], cmd.as_str());
        }
        // 旧形态也能被关闭移除
        let removed = remove_json_doc(spec, Some(&existing)).unwrap();
        assert!(serde_json::from_str::<Value>(&removed).unwrap().get("hooks").is_none());
        // kimi TOML 同理
        let kimi = spec_for("kimi").unwrap();
        let old_kimi = old.replace("claude-hooks", "kimi-hooks");
        let new_kimi = cmd.replace("claude-hooks", "kimi-hooks");
        let t = merge_kimi_toml(kimi, None, &old_kimi).unwrap();
        let t = merge_kimi_toml(kimi, Some(&t), &new_kimi).unwrap();
        let doc = t.parse::<toml_edit::DocumentMut>().unwrap();
        let arr = doc["hooks"].as_array_of_tables().unwrap();
        assert_eq!(arr.len(), 3);
        assert!(arr
            .iter()
            .all(|h| h["command"].as_str() == Some(new_kimi.as_str())));
    }

    /// BOM 开头的配置（PowerShell 5.1 / 旧记事本）照常合并，写回不带 BOM；读不了的配置拒写不覆盖
    #[test]
    fn bom_configs_merge_and_undecodable_config_is_refused() {
        let dir = tmpdir("bom");
        let home = dir.join("home");
        let log = dir.join("hooks-state").join("claude-hooks.jsonl");
        let backups = dir.join("backups");
        let spec = claude();
        let settings = home.join(spec.config_rel);
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(&settings, "\u{feff}{\"env\": {\"KEEP\": \"1\"}}").unwrap();
        apply_hooks_at(spec, &home, &log, &backups, true).unwrap();
        let text = fs::read_to_string(&settings).unwrap();
        assert!(!text.starts_with('\u{feff}'));
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["env"]["KEEP"], "1");
        assert!(v["hooks"]["Stop"].is_array());

        // JSONC 容错族与 kimi TOML 同样容忍 BOM
        let qwen = spec_for("qwen").unwrap();
        assert!(merge_json_doc(qwen, Some("\u{feff}{\"a\": 1,}"), "x").is_ok());
        let kimi = spec_for("kimi").unwrap();
        assert!(merge_kimi_toml(kimi, Some("\u{feff}default_model = \"m\"\n"), "x").is_ok());

        // 非 UTF-8：不能当成「不存在」拿只含 hooks 的新文件覆盖
        let bad = [0xff, 0xfe, b'{', 0xfd];
        fs::write(&settings, bad).unwrap();
        assert!(apply_hooks_at(spec, &home, &log, &backups, true).is_err());
        assert!(apply_hooks_at(spec, &home, &log, &backups, false).is_err());
        assert_eq!(fs::read(&settings).unwrap(), bad, "原文件原样保留");
        fs::remove_dir_all(&dir).ok();
    }

    /// 真机执行：生成的命令分别经 cmd /d /s /c（Qwen 等 Node 系）、powershell -Command（Gemini）、
    /// Git Bash -c（Claude Code）三种宿主跑一遍，日志都要写出可解析的记录（含中文不乱码）
    #[cfg(windows)]
    #[test]
    fn win_hook_command_runs_under_cmd_powershell_and_bash() {
        use std::io::Write;
        let dir = tmpdir("exec").join("带 空格 目录");
        let log = dir.join("hooks-state").join("claude-hooks.jsonl");
        write_win_hook_script(&log).unwrap();
        let cmd = win_hook_command(&log, PAYLOAD_CAP);

        let run = |host: &str, mut c: crate::process::BackgroundCommand| {
            c.env("CCODE_TAB_ID", "tab-w")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let mut child = c.spawn().unwrap_or_else(|e| panic!("{host} 起不来: {e}"));
            let payload = format!(
                "{{\n  \"session_id\": \"{host}\",\n  \"hook_event_name\": \"Notification\",\n  \"message\": \"新项目\"\n}}\n"
            );
            child
                .stdin
                .take()
                .unwrap()
                .write_all(payload.as_bytes())
                .unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(
                out.status.success(),
                "{host} 退出码 {:?}: {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr)
            );
        };

        let mut hosts = vec!["cmd", "powershell"];
        let mut c = crate::process::background_command("cmd.exe");
        c.raw_arg(format!("/d /s /c \"{cmd}\""));
        run("cmd", c);
        let mut c = crate::process::background_command("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-Command", &cmd]);
        run("powershell", c);
        if let Some(bash) = crate::agents::resolve_git_bash() {
            let mut c = crate::process::background_command(bash);
            c.args(["-c", &cmd]);
            run("bash", c);
            hosts.push("bash");
        }

        let records = parse_log_records(&fs::read_to_string(&log).unwrap());
        let ids: Vec<&str> = records.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, hosts, "每种宿主各写一条可解析记录");
        assert!(records
            .iter()
            .all(|r| r.detail.as_deref() == Some("新项目") && r.ts > 0));
        assert!(records.iter().all(|r| r.tab.as_deref() == Some("tab-w")), "标签号照记");
        fs::remove_dir_all(dir.parent().unwrap()).ok();
    }

    #[test]
    fn global_native_hook_path_must_be_shell_neutral() {
        assert_eq!(
            shell_neutral_path(Path::new(r"C:\Users\张三\AppData\Roaming\ccode\hooks-state\ccode-hook.exe")).as_deref(),
            Some("C:/Users/张三/AppData/Roaming/ccode/hooks-state/ccode-hook.exe")
        );
        for bad in [
            r"C:\Users\John Smith\AppData\ccode-hook.exe",
            r"C:\Program Files (x86)\x.exe",
            r"C:\a&b\x.exe",
            r"C:\100%\x.exe",
        ] {
            assert_eq!(shell_neutral_path(Path::new(bad)), None, "{bad}");
        }
        // 该用 exe 时配置里还是 .ps1 → 要重写；反之亦然；已对的不动
        let ps1 = r#"{"hooks":{"Stop":[{"hooks":[{"command":"powershell -File \"C:/x/hooks-state/ccode-hook.ps1\" \"C:/x/hooks-state/gemini-hooks.jsonl\""}]}]}}"#;
        let exe = r#"{"hooks":{"Stop":[{"hooks":[{"command":"C:/x/hooks-state/ccode-hook.exe hook \"C:/x/hooks-state/gemini-hooks.jsonl\" 65536"}]}]}}"#;
        assert!(win_hook_form_stale(ps1, true));
        assert!(!win_hook_form_stale(exe, true));
        assert!(win_hook_form_stale(exe, false));
        assert!(!win_hook_form_stale(ps1, false));
    }

    /// 全局 hooks 的原生写法（不加引号的正斜杠程序路径）在 cmd / PowerShell / bash 三种宿主里都能跑；
    /// 没先 `cargo build --bin mesa_helper` 时退回 PowerShell 脚本（另一条测试核对）
    #[cfg(windows)]
    #[test]
    fn global_native_hook_runs_under_cmd_powershell_and_bash() {
        use std::io::Write;
        let dir = tmpdir("global-native");
        let log = dir.join("hooks-state").join("gemini-hooks.jsonl");
        let cmd = global_hook_command(&log);
        if native_hook_exe().is_none() {
            assert!(cmd.contains(WIN_HOOK_SCRIPT), "{cmd}");
            return;
        }
        assert!(cmd.starts_with(&shell_neutral_path(&log.parent().unwrap().join(WIN_HOOK_EXE)).unwrap()), "{cmd}");
        let run = |host: &str, mut c: crate::process::BackgroundCommand| {
            c.env("CCODE_TAB_ID", "tab-g")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let mut child = c.spawn().unwrap_or_else(|e| panic!("{host} 起不来: {e}"));
            let payload = format!("{{\"session_id\": \"{host}\", \"hook_event_name\": \"Notification\", \"message\": \"新项目\"}}");
            child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success(), "{host}: {}", String::from_utf8_lossy(&out.stderr));
        };
        let mut c = crate::process::background_command("cmd.exe");
        c.raw_arg(format!("/d /s /c \"{cmd}\""));
        run("cmd", c);
        let mut c = crate::process::background_command("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-Command", &cmd]);
        run("powershell", c);
        let mut hosts = vec!["cmd", "powershell"];
        if let Some(bash) = crate::agents::resolve_git_bash() {
            let mut c = crate::process::background_command(bash);
            c.args(["-c", &cmd]);
            run("bash", c);
            hosts.push("bash");
        }
        let records = parse_log_records(&fs::read_to_string(&log).unwrap());
        let ids: Vec<&str> = records.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, hosts);
        assert!(records.iter().all(|r| r.tab.as_deref() == Some("tab-g")));
        fs::remove_dir_all(&dir).ok();
    }

    /// 原生 hook 程序（mesa_helper hook）：Claude Code 的 Git Bash、CodeBuddy 的 cmd 两种宿主都能跑，
    /// 记录与 PowerShell 脚本同形；有它时 Claude 不再走后台 hooks。没先 `cargo build --bin mesa_helper`
    /// 就找不到，只核对退回 PowerShell 的那半
    #[cfg(windows)]
    #[test]
    fn native_hook_command_runs_under_cmd_and_bash() {
        use std::io::Write;
        let Some(exe) = native_hook_exe() else {
            assert!(launch_hooks_async("claude-code"), "没有原生程序时 Claude 走后台 hooks");
            return;
        };
        assert!(!launch_hooks_async("claude-code"), "有原生程序就同步跑，事件有序");
        let dir = tmpdir("native").join("带 空格 目录");
        let log = dir.join("hooks-state").join("claude-hooks.jsonl");
        let cmd = launch_hook_command(&log, PAYLOAD_CAP);
        assert!(cmd.contains(&*exe.file_name().unwrap().to_string_lossy()), "{cmd}");
        let run = |host: &str, mut c: crate::process::BackgroundCommand| {
            c.env("CCODE_TAB_ID", "tab-n")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let mut child = c.spawn().unwrap_or_else(|e| panic!("{host} 起不来: {e}"));
            let payload = format!(
                "{{\n  \"session_id\": \"{host}\",\n  \"hook_event_name\": \"Notification\",\n  \"message\": \"新项目  两格\"\n}}\n"
            );
            child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success(), "{host}: {}", String::from_utf8_lossy(&out.stderr));
        };
        let mut hosts = vec!["cmd"];
        let mut c = crate::process::background_command("cmd.exe");
        c.raw_arg(format!("/d /s /c \"{cmd}\""));
        run("cmd", c);
        if let Some(bash) = crate::agents::resolve_git_bash() {
            let mut c = crate::process::background_command(bash);
            c.args(["-c", &cmd]);
            run("bash", c);
            hosts.push("bash");
        }
        let records = parse_log_records(&fs::read_to_string(&log).unwrap());
        let ids: Vec<&str> = records.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, hosts);
        assert!(records.iter().all(|r| r.detail.as_deref() == Some("新项目  两格")));
        assert!(records.iter().all(|r| r.tab.as_deref() == Some("tab-n")));
        // 注入的 Claude hooks 用这条命令，且不带 async
        let v = launch_hooks_value("claude-code").unwrap();
        let stop = &v["hooks"]["Stop"][0]["hooks"][0];
        assert!(stop["command"].as_str().unwrap().contains(" hook "), "{stop}");
        assert!(stop.get("async").is_none(), "{stop}");
        fs::remove_dir_all(dir.parent().unwrap()).ok();
    }

    /// 2026-10-20：字符串里的连续空格原样保留（审批卡的命令 / 差异要缩进），排版换行照删；
    /// 多个 hook 进程同时追加同一份日志（并行工具调用、多个标签）一条不丢
    #[cfg(windows)]
    #[test]
    fn win_hook_script_keeps_spaces_and_survives_concurrent_appends() {
        use std::io::Write;
        let dir = tmpdir("conc");
        let log = dir.join("hooks-state").join("claude-hooks.jsonl");
        write_win_hook_script(&log).unwrap();
        let script = win_hook_script_path(&log);
        let n = 12;
        let children: Vec<_> = (0..n)
            .map(|i| {
                let mut c = crate::process::background_command("powershell.exe");
                c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
                    .arg(&script)
                    .arg(&log)
                    .arg("65536")
                    .env("CCODE_TAB_ID", "tab-c")
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::piped());
                let mut child = c.spawn().unwrap();
                let payload = format!(
                    "{{\"session_id\":\"s{i}\",\"hook_event_name\":\"PreToolUse\",\r\n  \"tool_input\":{{\"old_string\":\"def f():\\n    return    {i}\"}}}}\r\n"
                );
                child
                    .stdin
                    .take()
                    .unwrap()
                    .write_all(payload.as_bytes())
                    .unwrap();
                child
            })
            .collect();
        for child in children {
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        }
        let text = fs::read_to_string(&log).unwrap();
        let records = parse_log_records(&text);
        assert_eq!(records.len(), n, "并发追加一条不丢：\n{text}");
        assert_eq!(text.lines().count(), n, "一行一条记录");
        assert!(
            text.contains(r#"{"session_id":"s3","hook_event_name":"PreToolUse",  "tool_input":{"old_string":"def f():\n    return    3"}}"#),
            "字符串里的空格原样保留、裸换行删掉：\n{text}"
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// 支持清单：七家在桥接注册表内，cursor/opencode 不支持且带备注
    #[test]
    fn support_list_covers_all_nine() {
        let list = crate::agent_specs::all_agent_specs();
        assert_eq!(list.len(), 9, "九家 agent");
        let supported: Vec<&str> = list
            .iter()
            .filter(|s| spec_for(s.id).is_some())
            .map(|s| s.id)
            .collect();
        assert_eq!(
            supported,
            [
                "claude-code",
                "codex",
                "gemini",
                "qwen",
                "kimi",
                "codebuddy",
                "grok"
            ]
        );
        for id in ["cursor", "opencode"] {
            assert!(spec_for(id).is_none());
            assert!(support_note(id).is_some(), "{id} 不支持须带备注");
        }
        assert!(support_note("codex").is_some() && support_note("codebuddy").is_some());
    }

    /// 每次启动注入：Claude / CodeBuddy 两家带 hooks；其余三家（Qwen / OpenCode / Codex）走各自通道；
    /// Gemini / Kimi / Grok 仍要全局开关（2026-10-20 逐家核实）
    #[test]
    fn launch_injection_covers_five_and_leaves_three_to_the_switch() {
        let v = launch_hooks_value("claude-code").expect("claude");
        let hooks = v["hooks"].as_object().unwrap();
        for ev in ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"] {
            assert!(hooks.contains_key(ev), "{ev}");
        }
        let post = hooks["PostToolUse"][0]["hooks"][0]["command"].as_str().unwrap();
        let pre = hooks["PreToolUse"][0]["hooks"][0]["command"].as_str().unwrap();
        #[cfg(not(windows))]
        {
            assert!(post.contains(&format!("head -c {PAYLOAD_CAP_SMALL}")));
            assert!(pre.contains(&format!("head -c {PAYLOAD_CAP}")));
        }
        #[cfg(windows)]
        {
            assert!(post.ends_with(&format!(" {PAYLOAD_CAP_SMALL}")));
            assert!(pre.ends_with(&format!(" {PAYLOAD_CAP}")));
            assert!(WIN_HOOK_SCRIPT_BODY.contains("CCODE_TAB_ID"));
        }
        #[cfg(not(windows))]
        assert!(pre.contains("CCODE_TAB_ID"));
        assert_eq!(hooks["Notification"][0]["matcher"], "permission_prompt|elicitation_dialog");
        assert!(launch_hooks_value("codebuddy").is_some());
        for id in ["gemini", "kimi", "grok", "qwen", "codex", "cursor", "opencode"] {
            assert!(launch_hooks_value(id).is_none(), "{id}");
        }
        for id in ["claude-code", "codebuddy", "qwen", "opencode", "codex"] {
            assert!(launch_injected(id), "{id}");
        }
        for id in ["gemini", "kimi", "grok", "cursor"] {
            assert!(!launch_injected(id), "{id}");
        }
    }

    #[test]
    fn parse_log_records_reads_tab_token_and_truncated_payload() {
        let text = concat!(
            "1700000000 tab-a {\"session_id\":\"s1\",\"hook_event_name\":\"Stop\"}\n",
            "1700000001 - {\"session_id\":\"s2\",\"hook_event_name\":\"Stop\"}\n",
            "1700000002 {\"session_id\":\"s3\",\"hook_event_name\":\"Stop\"}\n",
            // 超过上限被截断：JSON 不完整，事件名和会话 id 仍能按字段名取到
            "1700000003 tab-b {\"session_id\":\"s4\",\"transcript_path\":\"/p/s4.jsonl\",\"hook_event_name\":\"PostToolUse\",\"tool_response\":{\"content\":\"aaaa\n"
        );
        let recs = parse_log_records(text);
        assert_eq!(recs.len(), 4);
        assert_eq!(recs[0].tab.as_deref(), Some("tab-a"));
        assert_eq!(recs[1].tab, None, "Mesa 外的终端记 -");
        assert_eq!(recs[2].tab, None, "旧格式没有标签段");
        assert_eq!(recs[2].session_id, "s3");
        assert_eq!(recs[3].tab.as_deref(), Some("tab-b"));
        assert_eq!(recs[3].event, "posttooluse");
        assert_eq!(recs[3].transcript_path.as_deref(), Some("/p/s4.jsonl"));
        assert!(recs[3].payload.is_none());
    }

    /// 真跑一遍 hook 命令（sh）：整行一次写入、带标签号、超长截断后仍能认出事件
    #[cfg(unix)]
    #[test]
    fn hook_command_runs_and_records_tab() {
        use std::io::Write as _;
        let dir = tmpdir("hookcmd");
        let log = dir.join("hooks-state").join("x-hooks.jsonl");
        let run = |cmd: &str, tab: Option<&str>, stdin: &str| {
            let mut c = std::process::Command::new("sh");
            c.arg("-c").arg(cmd).stdin(std::process::Stdio::piped());
            match tab {
                Some(t) => c.env("CCODE_TAB_ID", t),
                None => c.env_remove("CCODE_TAB_ID"),
            };
            let mut child = c.spawn().unwrap();
            child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
            assert!(child.wait().unwrap().success());
        };
        run(
            &hook_command(&log),
            Some("tab-9"),
            "{\n  \"session_id\": \"s1\",\n  \"hook_event_name\": \"UserPromptSubmit\",\n  \"prompt\": \"你好\"\n}",
        );
        run(&hook_command(&log), None, r#"{"session_id":"s2","hook_event_name":"Stop"}"#);
        let big = format!(
            r#"{{"session_id":"s3","hook_event_name":"PostToolUse","tool_response":"{}"}}"#,
            "x".repeat(10_000)
        );
        run(&hook_command_capped(&log, PAYLOAD_CAP_SMALL), Some("tab-9"), &big);
        let text = std::fs::read_to_string(&log).unwrap();
        assert_eq!(text.lines().count(), 3, "每条一行");
        let recs = parse_log_records(&text);
        assert_eq!(recs.len(), 3);
        assert_eq!(recs[0].tab.as_deref(), Some("tab-9"));
        assert_eq!(recs[0].payload.as_ref().unwrap()["prompt"], "你好");
        assert_eq!(recs[1].tab, None);
        assert_eq!(recs[2].event, "posttooluse");
        assert!(text.lines().nth(2).unwrap().len() < PAYLOAD_CAP_SMALL + 64);
        std::fs::remove_dir_all(dir).ok();
    }

    /// 迁移收回的就是用户机器上那份 Codex hooks.json 的形状（2026-10-20 干跑：只剩 Mesa 三条 → 收成 {}）
    #[test]
    fn remove_codex_mesa_entries_from_real_shape() {
        let spec = spec_for("codex").unwrap();
        let cmd = "umask 077; mkdir -p '/Users/u/Library/Application Support/ccode/hooks-state'; { printf '%s ' \"$(date +%s)\"; cat; printf '\\n'; } >> '/Users/u/Library/Application Support/ccode/hooks-state/codex-hooks.jsonl'";
        let group = json!([{ "hooks": [{ "async": true, "command": cmd, "type": "command" }], "matcher": "" }]);
        let doc = json!({ "hooks": { "PermissionRequest": group, "Stop": group, "UserPromptSubmit": group } });
        let out = remove_json_doc(spec, Some(&doc.to_string())).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&out).unwrap(), json!({}));
        // 用户自己的 hook 留着
        let mut mixed = doc.clone();
        mixed["hooks"]["Stop"].as_array_mut().unwrap().push(json!({ "hooks": [{ "type": "command", "command": "say done" }] }));
        let out: Value = serde_json::from_str(&remove_json_doc(spec, Some(&mixed.to_string())).unwrap()).unwrap();
        assert_eq!(out["hooks"]["Stop"][0]["hooks"][0]["command"], "say done");
        assert!(out["hooks"].get("UserPromptSubmit").is_none());
    }

    /// 干跑：把本机真实的 ~/.codex/hooks.json 拷进临时 HOME，按启动迁移同一条路径收回 Mesa 的条目，
    /// 打印前后对照；不碰真实文件（`cargo test --lib real_data_dry_run_migrate -- --ignored --nocapture`）
    #[test]
    #[ignore]
    fn real_data_dry_run_migrate() {
        let home = dirs::home_dir().unwrap();
        let tmp = tmpdir("dryrun");
        for spec in BRIDGE_SPECS {
            if !launch_injected(spec.agent) {
                continue;
            }
            let real = home.join(spec.config_rel);
            let Ok(Some(before)) = read_existing(&real) else { continue };
            if !has_marker(&before, &spec.marker()) {
                println!("{}（{}）: 没有 Mesa 的条目，迁移不动它", spec.display(), real.display());
                continue;
            }
            let fake = tmp.join(spec.config_rel);
            std::fs::create_dir_all(fake.parent().unwrap()).unwrap();
            std::fs::write(&fake, &before).unwrap();
            let log = tmp.join("log.jsonl");
            apply_hooks_at(spec, &tmp, &log, &tmp.join("backups"), false).unwrap();
            let after = std::fs::read_to_string(&fake).unwrap();
            println!("== {}\n-- 迁移前\n{before}\n-- 迁移后\n{after}", spec.display());
            assert!(!has_marker(&after, &spec.marker()));
            assert_eq!(std::fs::read_to_string(&real).unwrap(), before, "真实文件不得被改");
        }
        std::fs::remove_dir_all(tmp).ok();
    }
}
