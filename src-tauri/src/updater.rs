//! 各 agent CLI 的升级：按安装方式（从二进制真实路径推断）选包管理器命令，
//! 否则用 CLI 自更新命令；命令在 PTY 里跑（brew/curl 对管道会块缓冲，接 PTY 才
//! 有实时输出），spawn_blocking + 参数数组（无 shell），900 秒超时。

use crate::agent_specs::{agent_spec, BrewPackage, UpdateChannel};
use crate::agents;
use portable_pty::{native_pty_system, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 进程内单调毫秒（闲置判超时的统一时间基准，跨线程可比）
fn mono_ms() -> u64 {
    static T0: OnceLock<std::time::Instant> = OnceLock::new();
    let t0 = T0.get_or_init(std::time::Instant::now);
    std::time::Instant::now().duration_since(*t0).as_millis() as u64
}

// 慢网络整包下载可能很久（tap/cask 走 GitHub Release，实测 73KB/s 下 46MB 要 13 分钟），
// 硬上限 30 分钟；真挂死靠闲置判定单独杀（见 IDLE_TIMEOUT）
const TIMEOUT: Duration = Duration::from_secs(1800);
/// 600 秒无任何输出才判挂死：下载活着时 curl 进度条每 5–10 秒一簇输出（PTY 实测），
/// 不会误伤慢下载；真挂起/网络断死的进程在 10 分钟内被终止
const IDLE_TIMEOUT: Duration = Duration::from_secs(600);

/// 超时触发种类：闲置（无输出）优先于硬上限判定
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PtyDeadline {
    Hard,
    Idle,
}

/// 纯判定函数：elapsed = 进程已运行时长，idle = 距最近一次收到输出的时长
pub(crate) fn pty_deadline_kind(elapsed: Duration, idle: Duration) -> Option<PtyDeadline> {
    if idle >= IDLE_TIMEOUT {
        Some(PtyDeadline::Idle)
    } else if elapsed >= TIMEOUT {
        Some(PtyDeadline::Hard)
    } else {
        None
    }
}
/// npm 默认重试/等待可能持续数分钟且几乎没有可见输出；安装和更新使用
/// 明确的网络参数，让失败在约 30 秒内反馈到界面，避免被误认为 Mesa 卡死。
const NPM_FETCH_ARGS: [&str; 5] = [
    "--no-audit",
    "--no-fund",
    "--fetch-retries=0",
    "--fetch-timeout=30000",
    "--loglevel=notice",
];

/// winget 安装/升级/查询的公共参数：精确匹配 ID、固定 winget 源、自动接受协议、
/// 禁用交互（PTY 里 winget 的交互提示无法被 updater_write 应答）
const WINGET_COMMON_ARGS: [&str; 6] = [
    "-e",
    "--source",
    "winget",
    "--accept-source-agreements",
    "--accept-package-agreements",
    "--disable-interactivity",
];

/// winget install/upgrade 的参数列表（action 为 "install" 或 "upgrade"）
pub(crate) fn winget_args(action: &str, id: &str) -> Vec<String> {
    let mut args: Vec<String> = [action, "--id", id].iter().map(|s| s.to_string()).collect();
    args.extend(WINGET_COMMON_ARGS.iter().map(|s| s.to_string()));
    args
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResultDto {
    pub ok: bool,
    pub output: String,
    pub method: String,
    pub version_before: Option<String>,
    pub version_after: Option<String>,
}

/// 安装方式：从二进制真实路径（已解符号链接）推断。
/// Caskroom/Cellar 是 brew 包的实体目录，优先判断——brew formula（如 gemini-cli）
/// 内部也带 node_modules，不能被 npm 规则抢走；homebrew prefix 下的 npm 全局包
/// （/opt/homebrew/lib/node_modules）仍命中 npm 规则
fn detect_method(resolved_path: &str) -> &'static str {
    // Windows 路径大小写不敏感、分隔符是 `\`：统一成小写 + 正斜杠再匹配
    let p = resolved_path.replace('\\', "/").to_lowercase();
    let has = |s: &str| p.contains(s);
    if resolved_path.contains("Caskroom") || resolved_path.contains("Cellar") {
        "brew"
    } else if has("node_modules") {
        "npm"
    } else if has("homebrew") {
        "brew"
    } else if has("uv/tools") || has(".local/share/uv") {
        // 含 Windows 的 %APPDATA%\uv\tools
        "uv"
    } else if resolved_path.contains('\\')
        && (has("/roaming/npm/")
            || has("/nvm4w/")
            || has("/nvm/")
            || has("/volta/")
            || has("/nodejs/")
            || has("/scoop/apps/nodejs")
            || has("/scoop/persist/nodejs"))
    {
        // Windows 的 npm 全局 prefix 下的 .cmd/.exe shim，路径不含 node_modules，须显式识别：
        // 默认 %APPDATA%\npm、nvm-windows（%APPDATA%\nvm\vX、C:\nvm4w\nodejs）、Volta、
        // Node 安装目录本身、scoop 的 nodejs（apps\…\current\bin / persist\…\bin）。
        // npm_for 优先取同目录的 npm，装回的正是这一份。scoop\shims 是 scoop 自管应用，不算 npm。
        // 只认反斜杠路径：unix 上同名目录（如 Debian /usr/share/nodejs）保持原判定
        "npm"
    } else if has("winget") {
        // winget portable：Links\codex.exe 及其 canonicalize 后的 Packages\ 实体路径
        "winget"
    } else {
        "self"
    }
}

struct UpdateCmd {
    method: &'static str,
    program: String,
    args: Vec<String>,
}

fn cmd(method: &'static str, program: String, args: &[&str]) -> UpdateCmd {
    UpdateCmd {
        method,
        program,
        args: args.iter().map(|s| s.to_string()).collect(),
    }
}

/// npm 全局包更新用的 npm：优先与目标二进制同目录的 npm（更新哪家的包装哪家的 npm——
/// 同机多份 node/npm 时，用错 npm 会把包装到另一个 prefix，目标副本纹丝不动），
/// 没有则回落全局解析
fn npm_for(binary_path: &str) -> String {
    if let Some(dir) = std::path::Path::new(binary_path).parent() {
        for name in ["npm", "npm.cmd", "npm.exe"] {
            let p = dir.join(name);
            if p.is_file() {
                return p.to_string_lossy().into_owned();
            }
        }
    }
    agents::resolve_binary("npm")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "npm".into())
}

/// 升级命令候选（按序尝试，首个成功即止）。
/// 渠道数据全部来自 AgentSpec.packaging：method 精确命中包管理器时优先包管理器，
/// 否则双变体 CLI 先看旧版变体渠道，最后按 update_fallback 顺序展开
fn update_commands(agent_id: &str, method: &str, binary_path: &str) -> Vec<UpdateCmd> {
    let npm_cmd = |pkg: &str| {
        let mut args: Vec<String> = ["install", "-g"].iter().map(|s| s.to_string()).collect();
        args.push(format!("{pkg}@latest"));
        args.extend(NPM_FETCH_ARGS.iter().map(|s| s.to_string()));
        UpdateCmd {
            method: "npm",
            program: npm_for(binary_path),
            args,
        }
    };
    let winget_upgrade = |id: &str| UpdateCmd {
        method: "winget",
        program: "winget".into(),
        args: winget_args("upgrade", id),
    };
    let bin = || binary_path.to_string();
    let Some(aspec) = agent_spec(agent_id) else {
        return vec![];
    };
    let p = &aspec.packaging;
    let brew_upgrade = |b: &BrewPackage| {
        if b.cask {
            cmd("brew", "brew".into(), &["upgrade", "--cask", b.name])
        } else {
            cmd("brew", "brew".into(), &["upgrade", b.name])
        }
    };
    let expand = |channel: UpdateChannel| -> Vec<UpdateCmd> {
        match channel {
            UpdateChannel::Brew => p
                .brew_upgrade
                .as_ref()
                .map(brew_upgrade)
                .into_iter()
                .collect(),
            UpdateChannel::Npm => p.npm_update.map(|pkg| npm_cmd(pkg)).into_iter().collect(),
            // winget 是 Windows 原生渠道：其他平台展开为空候选，不产生噪音报错
            UpdateChannel::Winget => {
                if cfg!(windows) {
                    p.winget.map(|id| winget_upgrade(id)).into_iter().collect()
                } else {
                    vec![]
                }
            }
            UpdateChannel::Uv => {
                p.uv.map(|pkg| cmd("uv", "uv".into(), &["tool", "upgrade", pkg]))
                    .into_iter()
                    .collect()
            }
            UpdateChannel::SelfUpdate => p
                .self_update
                .map(|args| cmd("self", bin(), args))
                .into_iter()
                .collect(),
        }
    };
    match method {
        "brew" if p.brew_upgrade.is_some() => {
            return vec![brew_upgrade(p.brew_upgrade.as_ref().unwrap())];
        }
        "npm" if p.npm_update.is_some() => return vec![npm_cmd(p.npm_update.unwrap())],
        "winget" if cfg!(windows) && p.winget.is_some() => {
            return vec![winget_upgrade(p.winget.unwrap())];
        }
        "uv" if p.uv.is_some() => {
            return vec![cmd("uv", "uv".into(), &["tool", "upgrade", p.uv.unwrap()])];
        }
        _ => {}
    }
    // 新旧双变体（kimi）：旧版变体走独立渠道（新版/探测不到按 update_fallback）
    if let Some(variant) = &p.legacy_variant {
        if crate::agent_specs::variant_of(aspec) == Some("legacy") {
            return expand(variant.legacy_channel);
        }
    }
    p.update_fallback.iter().flat_map(|c| expand(*c)).collect()
}

fn version_of(binary: &std::path::Path) -> Option<String> {
    agents::version_with_timeout(binary, agents::VERSION_QUERY_TIMEOUT)
}

/// 配置页「更新」是否应改路由到完整终端：实际将首先执行的更新命令是自更新渠道，
/// 且规格标记其为方向键选择的交互式 TUI（kimi upgrade；配置页行输入无法应答）。
/// 命中时返回预填进终端的自更新命令（裸名，由用户登录 shell 的 PATH 解析）
fn interactive_self_update(agent_id: &str, method: &str, binary_path: &str) -> Option<String> {
    let aspec = agent_spec(agent_id)?;
    if !aspec.packaging.interactive_tui {
        return None;
    }
    let cmds = update_commands(agent_id, method, binary_path);
    if cmds.first()?.method != "self" {
        return None;
    }
    let args = aspec.packaging.self_update?;
    Some(
        std::iter::once(aspec.binary)
            .chain(args.iter().copied())
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// stdout+stderr 合并取尾部 ~30 行
fn tail_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.trim_end().lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

fn utf8_len(first: u8) -> usize {
    if first < 0x80 {
        1
    } else if first < 0xe0 {
        2
    } else if first < 0xf0 {
        3
    } else {
        4
    }
}

/// 进行中的 run 的 PTY 写入端（每 agent 同时最多一个 run；前端经 updater_write 交互，
/// 例如回答 brew 的 [y/n] 确认；reader 线程也共享它应答终端查询）。run 结束
/// （成功/超时/出错）时务必移除。
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;
static UPDATER_WRITERS: OnceLock<Mutex<HashMap<String, SharedWriter>>> = OnceLock::new();

fn writers() -> &'static Mutex<HashMap<String, SharedWriter>> {
    UPDATER_WRITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 移除哨兵：无论 run_streaming_pty 从哪条路径返回，writer 都会从 map 里清掉
struct WriterGuard(String);

impl Drop for WriterGuard {
    fn drop(&mut self) {
        writers().lock().unwrap().remove(&self.0);
    }
}

/// 正在运行的 key 集合：writers 要等 spawn 成功才注册，覆盖不了「正在启动」窗口，
/// 故并发互斥单独维护——run_streaming_pty 入口抢占，同 key 并发直接拒绝
static RUNNING_KEYS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

fn running_keys() -> &'static Mutex<std::collections::HashSet<String>> {
    RUNNING_KEYS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// 与 WriterGuard 同模式：任何返回路径都释放 key
struct RunGuard(String);

impl Drop for RunGuard {
    fn drop(&mut self) {
        running_keys().lock().unwrap().remove(&self.0);
    }
}

#[tauri::command]
pub fn updater_write(agent_id: String, data: String) -> Result<(), String> {
    let w = {
        let map = writers().lock().unwrap();
        map.get(&agent_id)
            .cloned()
            .ok_or("该 agent 没有正在运行的安装/更新")?
    };
    let mut w = w.lock().unwrap();
    w.write_all(data.as_bytes())
        .and_then(|_| w.flush())
        .map_err(|e| format!("写入失败: {e}"))
}

/// 剥离 ANSI 转义序列并展开 \r 行重绘：
/// CSI（ESC [ … 最终字节 0x40-0x7E）、OSC（ESC ] … BEL 或 ESC \）、两字节序列；
/// \r 丢弃本行已写内容（\r\n 视为正常换行）。输入必须是合法 UTF-8。
pub(crate) fn strip_ansi(input: &str) -> String {
    collapse_cr(&strip_ansi_keep_cr(input))
}

/// 按终端语义展开 \r：每行只留最后一个 \r 之后的内容（行尾 \r 属于 \r\n，不算重绘）。
/// 流式输出必须对**拼接后**的全文做：进度条/转圈字符常把 \r 放在下一块开头，
/// 逐块展开时上一块已发出的半行撤不回，会一帧帧堆成一大片（winget 实证）。
pub(crate) fn collapse_cr(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            let line = line.trim_end_matches('\r');
            line.rsplit('\r').next().unwrap_or(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 只剥 ANSI 转义、保留 \r（交给 collapse_cr 在全文上展开）。
/// 「光标回到第 1 列」（CSI G 无参或参数 1）等价于 \r，换成 \r 保留重绘语义。
pub(crate) fn strip_ansi_keep_cr(input: &str) -> String {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            0x1b if i + 1 < b.len() => match b[i + 1] {
                b'[' => {
                    let params_start = i + 2;
                    i += 2;
                    while i < b.len() && !(0x40..=0x7e).contains(&b[i]) {
                        i += 1;
                    }
                    if i < b.len() && b[i] == b'G' {
                        let params = &input[params_start..i];
                        if params.is_empty() || params == "1" || params == "0" {
                            out.push('\r');
                        }
                    }
                    i += (i < b.len()) as usize; // 跳过最终字节
                }
                b']' => {
                    i += 2;
                    while i < b.len() {
                        if b[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if b[i] == 0x1b && i + 1 < b.len() && b[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                _ => i += 2, // 两字节序列（如 ESC ( B）
            },
            // 末尾孤立 ESC：半个序列无从解析，原样输出会污染展示文本，直接丢弃
            0x1b => i += 1,
            c => {
                let len = utf8_len(c).min(b.len() - i);
                out.push_str(&input[i..i + len]);
                i += len;
            }
        }
    }
    out
}

/// brew 的环境变量：跳过自动元数据更新；settings.brew_mirror 开启时（默认）注入
/// 国内加速（用户显式设置过的变量不动）。元数据走 TUNA API 镜像（仍有效）；
/// bottle 自 brew 4+ 起是 ghcr.io OCI 件，平铺镜像（TUNA/中科大等）已全部停供
/// （2026-09-19 实测 403/404，HOMEBREW_BOTTLE_DOMAIN 形同虚设——brew 7 只给
/// legacy 平铺镜像 manifest 首试机会，blob 仍回 ghcr）。南大 ghcr 代理按 OCI 语义
/// 改写 ghcr 域名（HOMEBREW_ARTIFACT_DOMAIN）：bottle 实测 6.7MB/s vs ghcr 直连
/// 73KB/s；非 ghcr URL（tap/cask 的 GitHub Release 等）代理 404 后 brew 自动
/// 交错回落原地址，无回归。抽成纯函数便于测试镜像开关。
pub(crate) fn brew_env_pairs(program: &str, mirror: bool) -> Vec<(String, String)> {
    // Homebrew 7 起 install 默认询问 [y/n]。诊断页和更新没有输入框，
    // 不设 HOMEBREW_NO_ASK 会停在「安装中」直到闲置超时。
    let mut env = vec![
        ("HOMEBREW_NO_AUTO_UPDATE".to_string(), "1".to_string()),
        ("HOMEBREW_NO_ASK".to_string(), "1".to_string()),
    ];
    if program == "brew" && mirror {
        // formulae.brew.sh 托管在 GitHub Pages，国内拉几十 MB 元数据要几分钟
        if std::env::var_os("HOMEBREW_API_DOMAIN").is_none() {
            env.push((
                "HOMEBREW_API_DOMAIN".to_string(),
                "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api".to_string(),
            ));
        }
        if std::env::var_os("HOMEBREW_ARTIFACT_DOMAIN").is_none() {
            env.push((
                "HOMEBREW_ARTIFACT_DOMAIN".to_string(),
                "https://ghcr.nju.edu.cn".to_string(),
            ));
        }
    }
    env
}

/// 在 PTY 里跑命令并流式转发输出（emit 收到剥离 ANSI 后的文本块）。
/// 为什么用 PTY 而不是管道：brew（Ruby）/curl 检测到 stdout 是管道会切到块缓冲，
/// 运行期间一个字节都到不了我们手里；接 PTY 后它们按 TTY 行缓冲，输出实时可见。
/// TERM=dumb 让 brew/npm 放弃彩色和花式重绘，但保留 TTY 行为。
/// 带 30 分钟硬上限 + 10 分钟无输出闲置判定（unix 下杀整个进程组）；reader 在子进程
/// 退出后最多等 1 秒 drain，
/// 其子孙（curl 等）可能持有 slave 导致永远无 EOF，绝不无限 join。
/// reader 同时客串最小终端应答：子进程（实测 npm on Windows ConPTY）会发 DSR 光标
/// 位置查询（ESC[6n）并读 stdin 等回答，无人应答就永久挂起——reader 代答
/// ESC[24;120R（与下方 PtySize 一致）。展示前 strip_ansi 会把查询序列剥掉。
/// brew 安装和诊断页依赖安装若仍打出 `[y/n]`，reader 再写一次 `y`。最多 5 次。
/// 诊断页和 brew 安装没有输入框。输出里仍出现确认问句时自动回答 y。
pub(crate) fn auto_confirm_prompt(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("[y/n]")
        || lower.contains("(y/n)")
        || lower.contains("proceed with the installation")
}

/// 把 dir 排到 PATH 最前（已在其中则原样返回，路径比较走方言层）
pub(crate) fn prepend_path(current: Option<&std::ffi::OsStr>, dir: &std::path::Path) -> std::ffi::OsString {
    let original = current.map(|c| c.to_os_string()).unwrap_or_default();
    let mut parts: Vec<std::path::PathBuf> = current
        .map(|c| std::env::split_paths(c).collect())
        .unwrap_or_default();
    let key = dir.to_string_lossy();
    if parts
        .iter()
        .any(|p| crate::paths::same_path(&p.to_string_lossy(), &key))
    {
        return original;
    }
    parts.insert(0, dir.to_path_buf());
    std::env::join_paths(parts).unwrap_or(original)
}

/// 同一 key 同时只允许一个 run：入口抢占，并发请求直接拒绝。
/// updater（key=agent_id）与 fonts（key="fonts"）共用本函数。
pub(crate) fn run_streaming_pty<F: Fn(&str) + Send + 'static>(
    key: &str,
    program: &str,
    args: &[String],
    emit: F,
) -> (bool, String) {
    {
        let mut set = running_keys().lock().unwrap();
        if !set.insert(key.to_string()) {
            return (false, "已有正在运行的安装/更新任务，请等待其完成".into());
        }
    }
    let _run_guard = RunGuard(key.to_string());
    // GUI 短 PATH 下 brew/npm 可能不在继承 PATH 里：先解析成绝对路径再 spawn
    // （找不到时保留裸名，沿用原来的「启动失败」报错路径）
    let program_path =
        agents::resolve_binary(program).unwrap_or_else(|| std::path::PathBuf::from(program));
    let pair = match native_pty_system().openpty(PtySize {
        rows: 24,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => return (false, format!("创建 PTY 失败: {e}")),
    };
    let mut cmd = crate::process::pty_command(&program_path, args);
    // 刚装好的工具（一键补齐的 Node.js / Python 等）不在已运行 Mesa 的 PATH 上：把程序所在
    // 目录排到子进程 PATH 最前，npm 安装后脚本里的 `node`（如 opencode-ai 的 postinstall）
    // 才找得到。裸名（没解析到）不动
    if let Some(dir) = program_path.parent().filter(|d| d.is_absolute()) {
        // 以补过新目录的 PATH 为底（pty_command 已设，见 process::child_path），再把程序目录排最前
        let base = crate::process::child_path().or_else(|| std::env::var_os("PATH"));
        cmd.env("PATH", prepend_path(base.as_deref(), dir));
    }
    let mirror = crate::settings::brew_mirror_enabled();
    let mut extra_no_proxy: Vec<&str> = Vec::new();
    for (k, v) in brew_env_pairs(program, mirror) {
        cmd.env(&k, &v);
    }
    // 出网代理（设置页「网络」）：下载优先走代理；镜像主机直连（见 download_proxy_env）
    if program == "brew" && mirror {
        extra_no_proxy.extend(["mirrors.tuna.tsinghua.edu.cn", "ghcr.nju.edu.cn"]);
    }
    for (k, v) in crate::settings::download_proxy_env(&extra_no_proxy) {
        cmd.env(&k, &v);
    }
    cmd.env("TERM", "dumb");
    cmd.env_remove("NO_COLOR");
    cmd.env_remove("TERM_PROGRAM_VERSION");
    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => return (false, format!("启动 {program} 失败: {e}")),
    };
    // spawn 已成功：后续任一步失败都必须先杀子进程，否则它脱离管理成为孤儿
    // writer 先取出供交互输入（updater_write），再配置读端
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return (false, format!("写入 PTY 失败: {e}"));
        }
    };
    let reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return (false, format!("读取 PTY 失败: {e}"));
        }
    };
    // slave 必须立刻 drop：子进程退出后 reader 才能看到 EOF
    drop(pair.slave);
    let writer = Arc::new(Mutex::new(writer));
    writers()
        .lock()
        .unwrap()
        .insert(key.to_string(), writer.clone());
    let _writer_guard = WriterGuard(key.to_string());

    let collected = Arc::new(Mutex::new(String::new()));
    let collected2 = collected.clone();
    // 最近一次收到子进程输出的时间戳（毫秒，单调时钟基准）：闲置判超时用。
    // 下载活着时 curl 进度条持续出字，该值会一直刷新
    let last_active_ms = Arc::new(std::sync::atomic::AtomicU64::new(mono_ms()));
    let last_active2 = last_active_ms.clone();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut pending: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        let mut confirms = 0u8;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    last_active2.store(mono_ms(), Ordering::Relaxed);
                    pending.extend_from_slice(&buf[..n]);
                    let (text, used) = crate::pty::split_utf8(&pending);
                    if used > 0 {
                        // DSR 光标位置查询（ESC[6n）：无人应答子进程会挂住 stdin 读取
                        // （实测 npm on Windows ConPTY），代答当前 PTY 尺寸
                        if text.contains("\u{1b}[6n") {
                            let mut w = writer.lock().unwrap();
                            let _ = w.write_all(b"\x1b[24;120R");
                            let _ = w.flush();
                        }
                        // \r 保留到拼接后再展开（见 collapse_cr）；前端同样按全文展开
                        let text = strip_ansi_keep_cr(&text);
                        // HOMEBREW_NO_ASK 没盖住时，诊断页仍会停在 [y/n]。代答 y，最多 5 次。
                        if confirms < 5 && auto_confirm_prompt(&collapse_cr(&text)) {
                            confirms += 1;
                            let mut w = writer.lock().unwrap();
                            let _ = w.write_all(b"y\n");
                            let _ = w.flush();
                        }
                        if !text.is_empty() {
                            emit(&text);
                            collected2.lock().unwrap().push_str(&text);
                        }
                        pending.drain(..used);
                    }
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            let text = strip_ansi_keep_cr(&String::from_utf8_lossy(&pending));
            if !text.is_empty() {
                emit(&text);
                collected2.lock().unwrap().push_str(&text);
            }
        }
        let _ = done_tx.send(());
    });

    let start = std::time::Instant::now();
    let mut deadline_hit: Option<PtyDeadline> = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                let idle = Duration::from_millis(
                    mono_ms().saturating_sub(last_active_ms.load(Ordering::Relaxed)),
                );
                deadline_hit = pty_deadline_kind(start.elapsed(), idle);
                if deadline_hit.is_some() {
                    // 连子孙一起杀：unix 杀进程组（brew/npm 拉起的 curl 等与父同组）；Windows 走
                    // taskkill /T——只杀 ConPTY 直接子进程时 npm/node/msiexec 孙进程照跑，继续锁着 npm 目录
                    if let Some(pid) = child.process_id() {
                        crate::pty::kill_process_tree(pid);
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return (false, format!("等待 {program} 失败: {e}")),
        }
    };
    // 给 reader 最多 1 秒收残余输出，之后放弃该线程（见函数文档）
    let _ = done_rx.recv_timeout(Duration::from_secs(1));
    let tail = tail_lines(&collapse_cr(&collected.lock().unwrap()), 30);
    if let Some(kind) = deadline_hit {
        let mut msg = match kind {
            PtyDeadline::Hard => format!("命令超时（{} 秒）", TIMEOUT.as_secs()),
            PtyDeadline::Idle => {
                format!(
                    "命令 {} 秒无任何输出（进程挂起或网络中断），已终止",
                    IDLE_TIMEOUT.as_secs()
                )
            }
        };
        if !tail.is_empty() {
            msg.push('\n');
            msg.push_str(&tail);
        }
        return (false, msg);
    }
    let success = status.as_ref().map(|s| s.success()).unwrap_or(false);
    // 失败却一个字没输出时（如 Windows 的 python 应用商店占位程序），界面只剩「安装失败」，
    // 至少把退出码交代清楚
    if !success && tail.trim().is_empty() {
        let code = status
            .map(|s| s.exit_code().to_string())
            .unwrap_or_else(|| "未知".into());
        return (false, format!("{program} 退出码 {code}，没有任何输出"));
    }
    (success, tail)
}

/// Tauri 事件封装：输出块经 `agent-update-output-<agent_id>` 实时推给前端，
/// writer 以 agent_id 为 key 入 UPDATER_WRITERS 供 updater_write 交互
/// （dep_check 的安装也复用本函数，key 形如 "dep-git"）
pub(crate) fn run_streaming(
    app: &AppHandle,
    agent_id: &str,
    program: &str,
    args: &[String],
) -> (bool, String) {
    let event = format!("agent-update-output-{agent_id}");
    let app = app.clone();
    // PTY 子进程（尤其是 Windows 下的 npm.cmd）可能在建立网络连接前暂时没有任何
    // stdout。先发一条明确的启动状态，避免前端只能显示「运行中，等待输出…」而被误认为
    // Mesa 没有执行命令。
    let _ = app.emit(
        &event,
        format!("已启动 {program}，正在连接安装源；若网络不可达，稍后会显示失败原因。\n"),
    );
    run_streaming_pty(agent_id, program, args, move |text| {
        let _ = app.emit(&event, text);
    })
}

fn update_agent_sync(app: &AppHandle, agent_id: &str) -> Result<UpdateResultDto, String> {
    let binary = agents::binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    let path = match agents::resolve_binary(binary) {
        Some(p) => p,
        None => {
            return Ok(UpdateResultDto {
                ok: false,
                output: format!("未找到 {binary}，无法更新（请先在「配置」页确认安装）"),
                method: "none".into(),
                version_before: None,
                version_after: None,
            });
        }
    };
    let version_before = version_of(&path);
    let resolved = path.canonicalize().unwrap_or_else(|_| path.clone());
    let method = detect_method(&resolved.to_string_lossy());
    let cmds = update_commands(agent_id, method, &path.to_string_lossy());
    if cmds.is_empty() {
        return Ok(UpdateResultDto {
            ok: false,
            output: format!("没有适用于 {agent_id}（{method} 安装）的更新方式"),
            method: method.into(),
            version_before,
            version_after: None,
        });
    }

    let mut ok = false;
    let mut output = String::new();
    let mut method_used = cmds[0].method;
    for c in &cmds {
        method_used = c.method;
        let (success, out) = run_streaming(app, agent_id, &c.program, &c.args);
        output = out;
        ok = success;
        if ok {
            break;
        }
        // 主命令失败：还有候选（fallback）则继续尝试
    }

    let version_after = if ok { version_of(&path) } else { None };
    if ok {
        agents::invalidate_detect_cache();
        invalidate_check_cache();
    }
    Ok(UpdateResultDto {
        ok,
        output,
        method: method_used.into(),
        version_before,
        version_after,
    })
}

/// 构建结果并经 `agent-update-done-<agent_id>` 推送（前端以事件为准，invoke 返回值兜底）
pub(crate) fn emit_done(
    app: &AppHandle,
    agent_id: &str,
    result: UpdateResultDto,
) -> UpdateResultDto {
    let _ = app.emit(&format!("agent-update-done-{agent_id}"), &result);
    result
}

#[tauri::command]
pub async fn update_agent(app: AppHandle, agent_id: String) -> Result<UpdateResultDto, String> {
    let app2 = app.clone();
    let agent_id2 = agent_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || update_agent_sync(&app2, &agent_id2))
        .await
        .map_err(|e| format!("更新失败: {e}"))??;
    Ok(emit_done(&app, &agent_id, result))
}

// ===== 安装（agent 未安装时） =====

/// 一个候选安装方式：tool 是执行它所需的 PATH 工具（"script" 需要 bash+curl）
struct InstallSpec {
    tool: &'static str,
    method: &'static str,
    program: String,
    args: Vec<String>,
}

fn spec(tool: &'static str, method: &'static str, program: &str, args: &[&str]) -> InstallSpec {
    InstallSpec {
        tool,
        method,
        program: program.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
    }
}

/// 全部候选，渠道来自 AgentSpec.packaging，固定按 brew > npm > winget > uv > 官方脚本
/// 优先级排序（winget 仅 Windows 出现；脚本兜底，仅无其他方式时用）
fn install_specs(agent_id: &str) -> Vec<InstallSpec> {
    let Some(aspec) = agent_spec(agent_id) else {
        return vec![];
    };
    let p = &aspec.packaging;
    let mut out = Vec::new();
    if let Some(b) = &p.brew_install {
        if b.cask {
            out.push(spec("brew", "brew", "brew", &["install", "--cask", b.name]));
        } else {
            out.push(spec("brew", "brew", "brew", &["install", b.name]));
        }
    }
    if let Some(pkg) = p.npm_install {
        let mut args: Vec<String> = ["install", "-g", pkg]
            .iter()
            .map(|s| s.to_string())
            .collect();
        args.extend(NPM_FETCH_ARGS.iter().map(|s| s.to_string()));
        out.push(InstallSpec {
            tool: "npm",
            method: "npm",
            program: "npm".into(),
            args,
        });
    }
    // winget 仅 Windows：无 Node.js 的机器也有原生渠道可装（如 codex 的 OpenAI.Codex）
    if cfg!(windows) {
        if let Some(id) = p.winget {
            out.push(InstallSpec {
                tool: "winget",
                method: "winget",
                program: "winget".into(),
                args: winget_args("install", id),
            });
        }
    }
    if let Some(pkg) = p.uv {
        // kimi 的 uv 包装的是旧版 kimi-cli（Python）
        out.push(spec("uv", "uv", "uv", &["tool", "install", pkg]));
    }
    // 脚本渠道：Windows 上有官方 PowerShell 安装器（如 Cursor）就只用它；没有的仍可在 Git Bash 里跑
    // bash 脚本（Claude Code 的 install.sh 在 MINGW 下装到 ~/.local/bin）
    match (cfg!(windows), p.install_script_win, p.install_script) {
        (true, Some(script), _) => out.push(spec(
            "script",
            "script",
            "powershell",
            &["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        )),
        (_, _, Some(script)) => out.push(spec("script", "script", "bash", &["-c", script])),
        _ => {}
    }
    out
}

/// 按工具可用性挑第一个候选；available 可注入以便测试
fn pick_install(agent_id: &str, available: &dyn Fn(&str) -> bool) -> Option<InstallSpec> {
    install_specs(agent_id).into_iter().find(|s| match s.tool {
        "script" if s.program == "powershell" => available("powershell"),
        "script" => available("bash") && available("curl"),
        tool => available(tool),
    })
}

/// 展示用：选中的安装方式描述（UI 在确认框里先亮出来）
fn install_method_for(agent_id: &str) -> Option<String> {
    let available = |tool: &str| agents::resolve_binary(tool).is_some();
    let s = pick_install(agent_id, &available)?;
    Some(format!("{}: {} {}", s.method, s.program, s.args.join(" ")))
}

#[tauri::command]
pub fn install_method_preview(agent_id: String) -> Option<String> {
    install_method_for(&agent_id)
}

fn install_agent_sync(app: &AppHandle, agent_id: &str) -> Result<UpdateResultDto, String> {
    let binary = agents::binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    if agents::resolve_binary(binary).is_some() {
        return Ok(UpdateResultDto {
            ok: false,
            output: format!("{binary} 已安装，无需重复安装（要升级请用「更新」）"),
            method: "none".into(),
            version_before: None,
            version_after: None,
        });
    }
    let available = |tool: &str| agents::resolve_binary(tool).is_some();
    let Some(s) = pick_install(agent_id, &available) else {
        let tools = if cfg!(windows) {
            "npm / winget / uv / curl"
        } else {
            "brew / npm / uv / curl"
        };
        return Ok(UpdateResultDto {
            ok: false,
            output: format!("未找到可用的安装工具（{tools} 均不可用）"),
            method: "none".into(),
            version_before: None,
            version_after: None,
        });
    };
    let (ok, output) = run_streaming(app, agent_id, &s.program, &s.args);
    let version_after = if ok {
        agents::resolve_binary(binary).and_then(|p| version_of(&p))
    } else {
        None
    };
    if ok {
        agents::invalidate_detect_cache();
        invalidate_check_cache();
    }
    Ok(UpdateResultDto {
        ok,
        output,
        method: s.method.into(),
        version_before: None,
        version_after,
    })
}

#[tauri::command]
pub async fn install_agent(app: AppHandle, agent_id: String) -> Result<UpdateResultDto, String> {
    let app2 = app.clone();
    let agent_id2 = agent_id.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || install_agent_sync(&app2, &agent_id2))
            .await
            .map_err(|e| format!("安装失败: {e}"))??;
    Ok(emit_done(&app, &agent_id, result))
}

// ===== 更新检查（配置页组头「新版/已更新」状态） =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdateInfoDto {
    pub id: String,
    pub installed: Option<String>,
    /// 查不到最新版（自更新渠道无轻量查询口 / 网络失败）→ None，UI 回退普通「更新」按钮
    pub latest: Option<String>,
    pub outdated: bool,
    /// brew 渠道滞后提示：上游 npm 已比 brew 最新版更新时的上游版本号；
    /// 仅 brew 安装且规格表有 npm 包名时查，查询失败静默为 None（UI 不显示）
    pub upstream_note: Option<String>,
    /// 上游 npm 包名（upstream_note 配套，供 UI 给出可复制的 npm 安装命令）
    pub upstream_package: Option<String>,
    /// 渠道切换一体命令（brew 卸载 + npm 安装），upstream_note 配套
    pub upstream_command: Option<String>,
    /// 本次更新将走交互式 TUI 自更新（kimi upgrade 方向键选择界面）：
    /// 配置页行输入无法应答，前端改在完整终端执行 interactive_update_command
    pub interactive_tui: bool,
    /// 交互式自更新的终端预填命令（interactive_tui 为 true 时必有值）
    pub interactive_update_command: Option<String>,
}

/// 提取首个 x.y.z 形式版本串用于相等比较（--version 输出常带产品名尾巴，如
/// "2.1.212 (Claude Code)"）
fn semver_token(s: &str) -> Option<String> {
    for tok in s.split(|c: char| !(c.is_ascii_digit() || c == '.')) {
        let t = tok.trim_matches('.');
        if t.contains('.') && t.split('.').all(|p| !p.is_empty()) {
            return Some(t.to_string());
        }
    }
    None
}

/// 纯版本号比较：a 是否严格比 b 新。按 . 分段数值比较，短侧缺段按 0；
/// 任一侧提取不到 x.y.z 形式版本串时判不新（失败静默，不拿垃圾数据吓用户）
fn semver_newer(a: &str, b: &str) -> bool {
    let (Some(a), Some(b)) = (semver_token(a), semver_token(b)) else {
        return false;
    };
    let parse = |v: &str| -> Option<Vec<u64>> { v.split('.').map(|p| p.parse().ok()).collect() };
    let (Some(pa), Some(pb)) = (parse(&a), parse(&b)) else {
        return false;
    };
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

fn npm_latest(pkg: &str) -> Option<String> {
    let npm = agents::resolve_binary("npm")?;
    let mut cmd = crate::process::background_command(npm);
    cmd.args([
        "view",
        pkg,
        "version",
        "--fetch-retries=0",
        "--fetch-timeout=8000",
    ]);
    for (k, v) in crate::settings::download_proxy_env(&[]) {
        cmd.env(k, v);
    }
    let out = capture_ok(&mut cmd, Duration::from_secs(20))?;
    let v = String::from_utf8_lossy(&out).trim().to_string();
    (!v.is_empty()).then_some(v)
}

/// 最新版查询的有界执行：超时杀树、非零退出或超时一律 None（查询失败只让 UI 回落普通「更新」按钮）
fn capture_ok(cmd: &mut crate::process::BackgroundCommand, timeout: Duration) -> Option<Vec<u8>> {
    let out = crate::process::capture_command(cmd, timeout, 1024 * 1024).ok()?;
    (!out.timed_out && out.status.is_some_and(|s| s.success())).then_some(out.stdout)
}

/// 从官方安装脚本正文提取当前版本。cursor 的脚本把版本烙在下载地址里
/// （downloads.cursor.com/lab/<年.月.日-哈希>/）；其他脚本渠道出现时按各家形态另写
/// 解析，不做通用猜测。取不到返回 None（UI 回退普通「更新」按钮，升级不受影响）。
fn install_script_version(body: &str) -> Option<String> {
    const ANCHOR: &str = "downloads.cursor.com/lab/";
    let start = body.find(ANCHOR)? + ANCHOR.len();
    let version: String = body[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
        .collect();
    // 年.月.日-哈希 形态：至少两个点、带一个连接号、数字开头，滤掉空串与残片
    (version.matches('.').count() >= 2
        && version.contains('-')
        && version.starts_with(|c: char| c.is_ascii_digit()))
    .then_some(version)
}

/// 安装脚本 URL 兼作最新版查询口：抓一次脚本正文提取版本，失败静默 None，
/// 与 npm_latest/brew_latest 同一口径（走下载代理设置，短超时，体积封顶）。
fn script_latest(url: &str) -> Option<String> {
    let curl = agents::resolve_binary("curl")?;
    let mut c = crate::process::background_command(curl);
    c.args(["-fsSL", "--max-time", "10", "--max-filesize", "262144", url]);
    for (k, v) in crate::settings::download_proxy_env(&[]) {
        c.env(k, v);
    }
    let out = c.output().ok()?;
    if !out.status.success() {
        return None;
    }
    install_script_version(&String::from_utf8_lossy(&out.stdout))
}

fn brew_latest(pkg: &str, cask: bool) -> Option<String> {
    let brew = agents::resolve_binary("brew")?;
    let mut c = crate::process::background_command(brew);
    c.args(["info", "--json=v2"]);
    if cask {
        c.arg("--cask");
    }
    c.arg(pkg);
    for (k, v) in brew_env_pairs("brew", crate::settings::brew_mirror_enabled()) {
        c.env(k, v);
    }
    for (k, v) in
        crate::settings::download_proxy_env(&["mirrors.tuna.tsinghua.edu.cn", "ghcr.nju.edu.cn"])
    {
        c.env(k, v);
    }
    let out = c.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let v = if cask {
        json["casks"][0]["version"].as_str()
    } else {
        json["formulae"][0]["versions"]["stable"].as_str()
    };
    v.map(|s| s.to_string())
}

/// winget show 输出是本地化的（中文「版本:」/英文「Version:」）：逐行找版本标签行取
/// x.y.z；解析不到不瞎猜（None → UI 回落普通「更新」按钮，升级本身不受影响）
fn winget_show_version(output: &str) -> Option<String> {
    output
        .lines()
        .filter(|l| {
            let lower = l.to_lowercase();
            lower.contains("version") || l.contains("版本")
        })
        .find_map(semver_token)
}

fn winget_latest(id: &str) -> Option<String> {
    let winget = agents::resolve_binary("winget")?;
    let mut c = crate::process::background_command(winget);
    c.args(winget_show_args(id));
    // 首次查询可能要先刷新源索引，给足余量但必须有界
    let out = capture_ok(&mut c, Duration::from_secs(45))?;
    winget_show_version(&String::from_utf8_lossy(&out))
}

/// `--accept-package-agreements` 只属于 install/upgrade，`show` 带上会被拒（最新版恒未知）
fn winget_show_args(id: &str) -> Vec<&str> {
    let mut args = vec!["show", "--id", id];
    args.extend(
        WINGET_COMMON_ARGS
            .iter()
            .copied()
            .filter(|a| *a != "--accept-package-agreements"),
    );
    args
}

/// 最新版查询口与 update_commands 同渠道（包管理器装的查包管理器）；
/// 自更新渠道（claude/kimi 自更新、opencode 非 npm）没有轻量查询口，返回 None。
/// brew 查询名单独声明（brew_latest）：opencode 升级用 tap 短名，brew info 会命中歧义，不查
fn latest_version(agent_id: &str, method: &str) -> Option<String> {
    let p = &agent_spec(agent_id)?.packaging;
    if method == "brew" {
        if let Some(b) = &p.brew_latest {
            return brew_latest(b.name, b.cask);
        }
    }
    if method == "npm" {
        if let Some(pkg) = p.npm_update {
            return npm_latest(pkg);
        }
    }
    if method == "winget" {
        if let Some(id) = p.winget {
            return winget_latest(id);
        }
    }
    // 有 npm 包名即可作为 latest 查询口：自更新渠道（kimi/opencode）本身没有轻量查询口，
    // 但 npm registry 与自更新渠道同版本发布，自装方式也据此得到 latest 提示
    if let Some(pkg) = p.npm_update {
        return npm_latest(pkg);
    }
    // 安装脚本渠道（cursor）：脚本正文烙着当前版本，URL 本身就是查询口。
    // 版本比较按 semver_token 收敛到「年.月.日」层级——同日重打包（哈希变、日期不变）
    // 不提示新版，跨日发布正常提示。
    if let Some(url) = p.script_latest {
        return script_latest(url);
    }
    None
}

fn check_one(agent_id: &str) -> AgentUpdateInfoDto {
    let mut upstream_note = None;
    let mut upstream_package = None;
    let mut upstream_command = None;
    let mut interactive_update_command = None;
    let (installed, latest) = match agents::binary_for(agent_id).and_then(agents::resolve_binary) {
        Some(path) => {
            let installed = version_of(&path);
            let resolved = path.canonicalize().unwrap_or_else(|_| path.clone());
            let method = detect_method(&resolved.to_string_lossy());
            let latest = latest_version(agent_id, method);
            // 与 update_agent 同一套渠道判定：首条命令是交互式 TUI 自更新时给前端改路由
            interactive_update_command =
                interactive_self_update(agent_id, method, &path.to_string_lossy());
            // brew 渠道常滞后于上游 npm（如 gemini-cli brew 0.46 vs npm 0.53）：
            // 已查到 brew 最新版时顺带比一次上游版本，提示复用同一次检查、不新增轮询；
            // npm view 失败 → None → 静默不带提示
            if method == "brew" {
                if let Some(brew_v) = latest.as_deref() {
                    if let Some(pkg) = agent_spec(agent_id).and_then(|s| s.packaging.npm_update) {
                        if let Some(npm_v) = npm_latest(pkg) {
                            if semver_newer(&npm_v, brew_v) {
                                upstream_note = Some(npm_v);
                                upstream_package = Some(pkg.to_string());
                                // 渠道切换一体命令：brew 卸载（cask 带 --cask）+ npm 安装
                                let brew = agent_spec(agent_id)
                                    .and_then(|s| {
                                        s.packaging
                                            .brew_upgrade
                                            .as_ref()
                                            .or(s.packaging.brew_install.as_ref())
                                    })
                                    .map(|b| {
                                        if b.cask {
                                            format!("brew uninstall --cask {}", b.name)
                                        } else {
                                            format!("brew uninstall {}", b.name)
                                        }
                                    })
                                    .unwrap_or_default();
                                if !brew.is_empty() {
                                    upstream_command =
                                        Some(format!("{brew} && npm i -g {pkg}@latest"));
                                }
                            }
                        }
                    }
                }
            }
            (installed, latest)
        }
        None => (None, None),
    };
    let outdated = match (&installed, &latest) {
        (Some(i), Some(l)) => match (semver_token(i), semver_token(l)) {
            (Some(a), Some(b)) => a != b,
            _ => false,
        },
        _ => false,
    };
    AgentUpdateInfoDto {
        id: agent_id.into(),
        installed,
        latest,
        outdated,
        upstream_note,
        upstream_package,
        upstream_command,
        interactive_tui: interactive_update_command.is_some(),
        interactive_update_command,
    }
}

/// 与 DETECT_CACHE 同模式：检查要起 6+ 组子进程，按进程缓存；更新/安装成功后失效。
/// 另外加 2 分钟 TTL：kimi 启动自动更新、终端里手动 brew upgrade 等外部变更绕过
/// update_agent 的失效链路，靠 TTL 自愈；「刚从终端跑完交互式自更新回来」由前端
/// 传 force 立即重查（同时失效 detect 缓存，列表版本号一并刷新）
const CHECK_CACHE_TTL: Duration = Duration::from_secs(120);
static CHECK_CACHE: std::sync::Mutex<Option<(std::time::Instant, Vec<AgentUpdateInfoDto>)>> =
    std::sync::Mutex::new(None);

pub(crate) fn invalidate_check_cache() {
    *CHECK_CACHE.lock().unwrap() = None;
}

/// 6+ 个 agent 并行查最新版（brew info 走本地元数据；npm view 限 8s fetch-timeout）
#[tauri::command]
pub async fn check_agent_updates(force: Option<bool>) -> Vec<AgentUpdateInfoDto> {
    if force == Some(true) {
        invalidate_check_cache();
        agents::invalidate_detect_cache();
    }
    {
        let cache = CHECK_CACHE.lock().unwrap();
        if let Some((ts, cached)) = &*cache {
            if ts.elapsed() < CHECK_CACHE_TTL {
                return cached.clone();
            }
        }
    }
    let out = tauri::async_runtime::spawn_blocking(|| {
        let handles: Vec<_> = crate::agent_specs::all_agent_specs()
            .iter()
            .map(|s| {
                let id = s.id;
                std::thread::spawn(move || check_one(id))
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    *CHECK_CACHE.lock().unwrap() = Some((std::time::Instant::now(), out.clone()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_token_extracts_first_version_like_token() {
        assert_eq!(
            semver_token("2.1.212 (Claude Code)"),
            Some("2.1.212".into())
        );
        assert_eq!(semver_token("0.31.1"), Some("0.31.1".into()));
        assert_eq!(semver_token("v0.46.0-beta"), Some("0.46.0".into()));
        // 没有 x.y 形式 → None
        assert_eq!(semver_token("unknown"), None);
        assert_eq!(semver_token(""), None);
    }

    #[test]
    fn semver_newer_compares_numeric_segments() {
        // 上游新于渠道 → true（gemini 案例：npm 0.53 vs brew 0.46）
        assert!(semver_newer("0.53.0", "0.46.0"));
        assert!(semver_newer("1.0.0", "0.99.9"));
        assert!(semver_newer("0.46.1", "0.46.0"));
        // 段数不同：短侧缺段按 0
        assert!(semver_newer("0.46.0.1", "0.46.0"));
        assert!(!semver_newer("0.46", "0.46.0.1"));
        // 同版 / 更旧 → false
        assert!(!semver_newer("0.46.0", "0.46.0"));
        assert!(!semver_newer("0.45.9", "0.46.0"));
        // 带噪音的 --version 输出先走 semver_token 提取
        assert!(semver_newer("0.53.0 (gemini-cli)", "v0.46.0-beta"));
        // 提取不到版本串 → 判不新（静默）
        assert!(!semver_newer("unknown", "0.46.0"));
        assert!(!semver_newer("0.53.0", ""));
    }

    #[test]
    fn npm_for_prefers_same_dir_as_target_binary() {
        // 与目标二进制同目录有 npm → 用它（更新哪家的包装哪家的 npm）
        let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let bin = base.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("npm"), "x").unwrap();
        let target = bin.join("codex").to_string_lossy().into_owned();
        let got = npm_for(&target);
        assert_eq!(got, bin.join("npm").to_string_lossy());
        // 同目录没有 npm → 回落全局解析（结果非空即可）
        std::fs::remove_file(bin.join("npm")).unwrap();
        assert!(!npm_for(&target).is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    /// 实机冒烟（需本机装有 Node，CI 跳过）：完整走 resolve_binary 找 npm.cmd →
    /// pty_command 深化为 node 直启 → ConPTY 拉起 → 收输出。手动跑：
    /// cargo test --lib -- --ignored npm_via_pty_smoke
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn npm_via_pty_smoke() {
        let (ok, out) =
            run_streaming_pty("test-npm-smoke", "npm", &["--version".to_string()], |_| {});
        assert!(ok, "npm --version 经 PTY 失败：{out}");
        assert!(
            out.trim()
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit()),
            "输出不像版本号：{out}"
        );
    }

    #[test]
    fn opencode_brew_method_uses_brew_upgrade_not_self_tui() {
        let cmds = update_commands("opencode", "brew", "/opt/homebrew/bin/opencode");
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].program, "brew");
        assert_eq!(cmds[0].args, vec!["upgrade", "opencode"]);
    }

    #[test]
    fn cursor_without_packaging_manager_falls_back_to_self_update() {
        // cursor 无 brew/npm 官方包：无论 method 探测成什么，更新都走非交互自更新 cursor-agent update
        for method in ["self", "unknown", "npm"] {
            let cmds = update_commands("cursor", method, "/Users/x/.local/bin/cursor-agent");
            assert_eq!(cmds.len(), 1, "method={method} 应只有自更新一个候选");
            assert_eq!(cmds[0].method, "self");
            assert_eq!(cmds[0].args, vec!["update"]);
        }
        // 非交互自更新不得路由到完整终端（interactive_tui=false）
        assert_eq!(
            interactive_self_update("cursor", "self", "/Users/x/.local/bin/cursor-agent"),
            None
        );
    }

    #[test]
    fn cursor_install_script_latest_extracts_version() {
        // 官方安装脚本正文（2026-10-10 实抓节选）：版本烙在 downloads.cursor.com/lab/<版本>/ 下载地址里
        let body = r#"FINAL_DIR="$HOME/.local/share/cursor-agent/versions/2026.10.01-e373342"
DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.10.01-e373342/${OS}/${ARCH}/agent-cli-package.tar.gz""#;
        assert_eq!(
            install_script_version(body).as_deref(),
            Some("2026.10.01-e373342")
        );
        // 无锚点 / 残片不猜
        assert_eq!(install_script_version("echo install"), None);
        assert_eq!(
            install_script_version("downloads.cursor.com/lab//agent-cli"),
            None
        );
        assert_eq!(
            install_script_version("downloads.cursor.com/lab/latest/agent-cli"),
            None
        );
        // 版本比较按 semver_token 收敛到「年.月.日」：同日重打包不提示，跨日提示
        assert_eq!(
            semver_token("2026.10.01-e373342").as_deref(),
            Some("2026.10.01")
        );
        assert_ne!(
            semver_token("2026.10.02-aaa111"),
            semver_token("2026.10.01-e373342")
        );
    }

    #[test]
    fn grok_update_channels_self_then_npm() {
        // grok 有 npm 官方包（@xai-official/grok）+ 非交互自更新（grok update）；
        // 自装/未知渠道时回落链是 self → npm
        let cmds = update_commands("grok", "self", "/Users/x/.grok/bin/grok");
        assert_eq!(cmds.len(), 2, "grok 自装渠道应给 self + npm 两个候选");
        assert_eq!(cmds[0].method, "self");
        assert_eq!(cmds[0].args, vec!["update"]);
        assert_eq!(cmds[1].method, "npm");
        // npm 安装命中时直接走 npm 更新
        let cmds = update_commands("grok", "npm", "/Users/x/.npm-global/bin/grok");
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].method, "npm");
        // 非交互自更新不得路由到完整终端（interactive_tui=false）
        assert_eq!(
            interactive_self_update("grok", "self", "/Users/x/.grok/bin/grok"),
            None
        );
    }

    #[test]
    fn interactive_self_update_routes_tui_self_update_only() {
        // kimi 自装（~/.kimi-code/bin）：唯一更新渠道是交互 TUI 自更新，给出终端预填命令
        assert_eq!(
            interactive_self_update("kimi", "self", "/Users/x/.kimi-code/bin/kimi"),
            Some("kimi upgrade".into())
        );
        // kimi 旧版 uv 变体走 uv tool upgrade（非交互），不路由
        assert_eq!(
            interactive_self_update(
                "kimi",
                "uv",
                "/Users/x/.local/share/uv/tools/kimi-cli/bin/kimi"
            ),
            None
        );
        // opencode 仅「非 brew/npm 安装」命中交互 TUI；brew/npm 渠道行为不变
        assert_eq!(
            interactive_self_update("opencode", "self", "/usr/local/bin/opencode"),
            Some("opencode upgrade".into())
        );
        assert_eq!(
            interactive_self_update("opencode", "brew", "/opt/homebrew/bin/opencode"),
            None
        );
        assert_eq!(
            interactive_self_update(
                "opencode",
                "npm",
                "/Users/x/.local/lib/node_modules/opencode-ai/bin/opencode"
            ),
            None
        );
        // claude update 是普通非交互命令，未标 interactive_tui，不路由
        assert_eq!(
            interactive_self_update("claude-code", "self", "/usr/local/bin/claude"),
            None
        );
        // 未知 agent → None
        assert_eq!(interactive_self_update("nope", "self", "/x"), None);
    }

    #[test]
    fn brew_mirror_toggle_controls_mirror_domains() {
        let on = brew_env_pairs("brew", true);
        assert!(on.iter().any(|(k, _)| k == "HOMEBREW_API_DOMAIN"));
        // bottle 走 ghcr 代理（HOMEBREW_ARTIFACT_DOMAIN），不再注入已停供的平铺镜像
        assert!(on.iter().any(|(k, _)| k == "HOMEBREW_ARTIFACT_DOMAIN"));
        assert!(!on.iter().any(|(k, _)| k == "HOMEBREW_BOTTLE_DOMAIN"));
        let off = brew_env_pairs("brew", false);
        assert!(
            !off.iter().any(|(k, _)| k == "HOMEBREW_API_DOMAIN"),
            "镜像关闭时不注入镜像域名"
        );
        assert!(!off.iter().any(|(k, _)| k == "HOMEBREW_ARTIFACT_DOMAIN"));
        // NO_AUTO_UPDATE 与 NO_ASK 无论开关都保留；非 brew 命令不注入镜像
        assert!(off.iter().any(|(k, _)| k == "HOMEBREW_NO_AUTO_UPDATE"));
        assert!(off.iter().any(|(k, _)| k == "HOMEBREW_NO_ASK"));
    }

    #[test]
    fn auto_confirm_answers_yes_no_prompts_only() {
        assert!(auto_confirm_prompt(
            "Do you want to proceed with the installation? [y/n]"
        ));
        assert!(auto_confirm_prompt("Proceed (Y/n)?"));
        assert!(!auto_confirm_prompt("Downloaded bottle manifests"));
        assert!(!auto_confirm_prompt("synonym"));
        assert!(!brew_env_pairs("npm", true)
            .iter()
            .any(|(k, _)| k == "HOMEBREW_API_DOMAIN"));
    }

    #[test]
    fn pty_deadline_idle_wins_and_slow_download_survives() {
        use std::time::Duration as D;
        // 慢下载：持续有输出（闲置远小于阈值）→ 即使逼近硬上限也不杀
        assert_eq!(
            pty_deadline_kind(D::from_secs(1750), D::from_secs(30)),
            None
        );
        // 闲置达标 → 优先判闲置（报「无输出」而非笼统超时）
        assert_eq!(
            pty_deadline_kind(D::from_secs(60), D::from_secs(600)),
            Some(PtyDeadline::Idle)
        );
        // 硬上限：一直有输出但跑满 30 分钟
        assert_eq!(
            pty_deadline_kind(D::from_secs(1800), D::from_secs(5)),
            Some(PtyDeadline::Hard)
        );
        // 双达标 → 闲置优先
        assert_eq!(
            pty_deadline_kind(D::from_secs(1800), D::from_secs(700)),
            Some(PtyDeadline::Idle)
        );
    }

    #[test]
    fn method_detection_from_resolved_path() {
        assert_eq!(
            detect_method("/opt/homebrew/Caskroom/claude-code/2.1.212/claude"),
            "brew"
        );
        // brew formula 内部也带 node_modules：Cellar 规则优先，正确判为 brew
        assert_eq!(
            detect_method("/opt/homebrew/Cellar/gemini-cli/0.46.0/libexec/lib/node_modules/@google/gemini-cli/bundle/gemini.js"),
            "brew"
        );
        assert_eq!(
            detect_method("/Users/x/.local/lib/node_modules/@openai/codex/bin/codex.js"),
            "npm"
        );
        // homebrew prefix 的 npm 全局包仍是 npm
        assert_eq!(
            detect_method("/opt/homebrew/lib/node_modules/qwen-code/bin/qwen"),
            "npm"
        );
        assert_eq!(
            detect_method("/opt/homebrew/Caskroom/codex/0.1.0/codex"),
            "brew"
        );
        assert_eq!(
            detect_method("/Users/x/.local/share/uv/tools/kimi-cli/bin/kimi"),
            "uv"
        );
        assert_eq!(
            detect_method("/Users/x/.local/uv/tools/kimi/bin/kimi"),
            "uv"
        );
        assert_eq!(detect_method("/Users/x/.kimi-code/bin/kimi"), "self");
        assert_eq!(detect_method("/usr/local/bin/opencode"), "self");
        // winget portable：Links shim 与 canonicalize 后的 Packages 实体路径
        assert_eq!(
            detect_method(r"C:\Users\x\AppData\Local\Microsoft\WinGet\Links\codex.exe"),
            "winget"
        );
        assert_eq!(
            detect_method(
                r"C:\Users\x\AppData\Local\Microsoft\WinGet\Packages\OpenAI.Codex_x\codex.exe"
            ),
            "winget"
        );
        // Windows npm 全局 prefix 下的 .cmd shim（路径不含 node_modules）
        assert_eq!(
            detect_method(r"C:\Users\x\AppData\Roaming\npm\codex.cmd"),
            "npm"
        );
    }

    /// Windows 的各家安装位置：分隔符/大小写归一后识别，scoop 自管应用与官方原生安装仍算 self
    #[test]
    fn detects_windows_install_locations() {
        let cases = [
            (r"C:\Users\x\AppData\Roaming\uv\tools\kimi-cli\Scripts\kimi.exe", "uv"),
            (r"\\?\C:\Users\x\APPDATA\ROAMING\NPM\codex.cmd", "npm"),
            (r"C:\Users\x\AppData\Roaming\nvm\v22.11.0\codex.cmd", "npm"),
            (r"C:\nvm4w\nodejs\gemini.cmd", "npm"),
            (r"C:\Users\x\AppData\Local\Volta\bin\qwen.exe", "npm"),
            (r"C:\Program Files\nodejs\opencode.cmd", "npm"),
            (r"C:\Users\x\scoop\apps\nodejs-lts\current\bin\codex.cmd", "npm"),
            (r"C:\Users\x\scoop\persist\nodejs\bin\codex.cmd", "npm"),
            (r"C:\Users\x\scoop\shims\gh.exe", "self"),
            (r"C:\Users\x\.local\bin\claude.exe", "self"),
        ];
        for (path, want) in cases {
            assert_eq!(detect_method(path), want, "{path}");
        }
        // unix 上同名目录不受 Windows 规则影响
        assert_eq!(detect_method("/usr/share/nodejs/foo/bin/foo"), "self");
    }

    #[test]
    fn install_selection_follows_brew_npm_uv_script_priority() {
        let all = |_: &str| true;
        assert_eq!(pick_install("codex", &all).unwrap().method, "brew");
        let no_brew = |t: &str| t != "brew";
        assert_eq!(pick_install("codex", &no_brew).unwrap().method, "npm");
        // 只剩脚本工具时 claude 走官方脚本
        let only_script = |t: &str| matches!(t, "bash" | "curl");
        let s = pick_install("claude-code", &only_script).unwrap();
        assert_eq!(s.method, "script");
        assert_eq!(s.program, "bash");
        // 脚本也需要 bash+curl，全无 → None
        let nothing = |_: &str| false;
        assert!(pick_install("claude-code", &nothing).is_none());
        // kimi 优先级 npm > uv > script（script 是新版官方安装，uv 是旧版 kimi-cli）
        assert_eq!(pick_install("kimi", &all).unwrap().method, "npm");
        let only_uv = |t: &str| t == "uv";
        let u = pick_install("kimi", &only_uv).unwrap();
        assert_eq!(
            (u.method, u.args.join(" ")),
            ("uv", "tool install kimi-cli".to_string())
        );
        assert_eq!(pick_install("kimi", &only_script).unwrap().method, "script");
        // 未知 agent → None
        assert!(pick_install("nope", &all).is_none());
        // winget 渠道仅 Windows 出现：无 brew/npm 时 codex 回落 winget，离开 Windows 不出现
        #[cfg(windows)]
        {
            let no_brew_npm = |t: &str| !matches!(t, "brew" | "npm");
            assert_eq!(
                pick_install("codex", &no_brew_npm).unwrap().method,
                "winget"
            );
        }
        #[cfg(not(windows))]
        {
            let no_brew_npm = |t: &str| !matches!(t, "brew" | "npm");
            assert!(pick_install("codex", &no_brew_npm).is_none());
        }
        #[cfg(windows)]
        {
            // Windows 上 Cursor 走官方 PowerShell 安装器；curl|bash 脚本不得出现在 Windows 上
            let all = |_: &str| true;
            let s = pick_install("cursor", &all).expect("Windows 上 Cursor 有官方安装器");
            assert_eq!(s.program, "powershell");
            assert!(s.args.iter().any(|a| a.contains("cursor.com/install?win32=true")), "{:?}", s.args);
            let no_ps = |t: &str| t != "powershell";
            assert!(pick_install("cursor", &no_ps).is_none(), "Cursor 的 bash 脚本不认 MINGW，不得回落");
        }
        #[cfg(not(windows))]
        {
            let s = pick_install("cursor", &|_: &str| true).unwrap();
            assert_eq!(s.program, "bash");
        }
    }

    #[test]
    fn winget_show_version_parses_localized_output() {
        // 中文输出（本机实测格式）
        let zh = "已找到 Codex CLI [OpenAI.Codex]\n版本: 0.146.1\n发布者: OpenAI, Inc.\n";
        assert_eq!(winget_show_version(zh).as_deref(), Some("0.146.1"));
        // 英文输出
        let en = "Found Codex CLI [OpenAI.Codex]\nVersion: 0.146.1\nPublisher: OpenAI, Inc.\n";
        assert_eq!(winget_show_version(en).as_deref(), Some("0.146.1"));
        // 无版本标签行 → None（不拿别的数字瞎猜）
        assert_eq!(
            winget_show_version("Found Codex CLI [OpenAI.Codex]\nPublisher: OpenAI"),
            None
        );
    }

    /// show 不得带 install 专属的协议参数；源协议与禁交互保留，install/upgrade 照旧全带
    #[test]
    fn winget_show_omits_package_agreements() {
        let show = winget_show_args("OpenAI.Codex");
        assert_eq!(&show[..3], ["show", "--id", "OpenAI.Codex"]);
        assert!(!show.contains(&"--accept-package-agreements"));
        assert!(show.contains(&"--accept-source-agreements"));
        assert!(show.contains(&"--disable-interactivity"));
        assert!(winget_args("upgrade", "OpenAI.Codex")
            .iter()
            .any(|a| a == "--accept-package-agreements"));
    }

    /// winget 渠道的安装/更新/fallback 全链路（仅 Windows 有这些候选）
    #[cfg(windows)]
    #[test]
    fn winget_channels_for_codex_on_windows() {
        // 安装候选：brew > npm > winget（codex 无 uv/script）
        let specs = install_specs("codex");
        let methods: Vec<&str> = specs.iter().map(|s| s.method).collect();
        assert_eq!(methods, vec!["brew", "npm", "winget"]);
        let w = &specs[2];
        assert_eq!(w.program, "winget");
        assert_eq!(w.args[0], "install");
        assert!(w.args.join(" ").contains("--id OpenAI.Codex"));
        // winget 装的走 winget upgrade 更新
        let cmds = update_commands(
            "codex",
            "winget",
            r"C:\Users\x\AppData\Local\Microsoft\WinGet\Links\codex.exe",
        );
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].method, "winget");
        assert_eq!(cmds[0].args[0], "upgrade");
        assert!(cmds[0].args.join(" ").contains("--id OpenAI.Codex"));
        // 自装/未知渠道：fallback 链 npm → winget
        let cmds = update_commands("codex", "self", r"C:\Tools\codex.exe");
        let ms: Vec<&str> = cmds.iter().map(|c| c.method).collect();
        assert_eq!(ms, vec!["npm", "winget"]);
    }

    /// 五家有官方 winget 包的 agent（2026-08-27 实机核实 winget 仓库），包 ID 防写错
    #[cfg(windows)]
    #[test]
    fn winget_channels_registered_for_five_agents() {
        for (id, pkg) in [
            ("claude-code", "Anthropic.ClaudeCode"),
            ("codex", "OpenAI.Codex"),
            ("opencode", "SST.opencode"),
            ("kimi", "MoonshotAI.KimiCodeCLI"),
            ("grok", "xAI.GrokBuild"),
        ] {
            let specs = install_specs(id);
            let w = specs
                .iter()
                .find(|s| s.method == "winget")
                .unwrap_or_else(|| panic!("{id} 缺 winget 渠道"));
            assert!(
                w.args.join(" ").contains(&format!("--id {pkg}")),
                "{id} winget 包 ID 不符"
            );
        }
        // gemini/qwen/codebuddy/cursor 无官方 winget 包，不出现废渠道
        for id in ["gemini", "qwen", "codebuddy", "cursor"] {
            assert!(
                install_specs(id).iter().all(|s| s.method != "winget"),
                "{id} 不应有 winget 渠道"
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn winget_channels_absent_off_windows() {
        // 非 Windows：安装候选无 winget，fallback 链里的 winget 展开为空（无噪音报错）
        assert!(install_specs("codex").iter().all(|s| s.method != "winget"));
        let cmds = update_commands("codex", "self", "/usr/local/bin/codex");
        let ms: Vec<&str> = cmds.iter().map(|c| c.method).collect();
        assert_eq!(ms, vec!["npm"]);
    }

    #[test]
    fn strip_ansi_handles_csi_osc_and_cr() {
        // CSI 颜色
        assert_eq!(strip_ansi("\x1b[1;31mred\x1b[0m"), "red");
        // CSI 带参数的光标移动
        assert_eq!(strip_ansi("a\x1b[2Kb"), "ab");
        // OSC（BEL 结尾）
        assert_eq!(strip_ansi("\x1b]8;;http://x\x07link\x1b]8;;\x07"), "link");
        // OSC（ESC \ 结尾）
        assert_eq!(strip_ansi("\x1b]0;title\x1b\\rest"), "rest");
        // \r 行重绘：只保留最后一段
        assert_eq!(strip_ansi("progress 10%\rprogress 20%\n"), "progress 20%\n");
        // \r\n 是正常换行，不截断
        assert_eq!(strip_ansi("a\r\nb"), "a\nb");
        // 多字节字符不受剥离影响
        assert_eq!(strip_ansi("中\x1b[1m文"), "中文");
        // 末尾孤立 ESC 丢弃（半个序列无从解析，原样输出会污染文本）
        assert_eq!(strip_ansi("abc\x1b"), "abc");
        assert_eq!(strip_ansi("abc\x1b["), "abc");
        // 纯文本原样
        assert_eq!(strip_ansi("plain text\n"), "plain text\n");
        // 光标回第 1 列等价于 \r
        assert_eq!(strip_ansi("old line\x1b[1Gnew"), "new");
        assert_eq!(strip_ansi("old\x1b[Gnew"), "new");
        // 其他列的 CHA 只剥离不重绘
        assert_eq!(strip_ansi("ab\x1b[5Gc"), "abc");
    }

    /// 刚装好的 Node.js 不在 Mesa 的 PATH 上：子进程 PATH 前插程序目录，且不重复
    #[test]
    fn prepend_path_puts_tool_dir_first_once() {
        let tool = std::env::temp_dir().join("ccode-prepend-test");
        let other = std::env::temp_dir().join("ccode-other");
        let current = std::env::join_paths([other.clone()]).unwrap();
        let out = prepend_path(Some(&current), &tool);
        let parts: Vec<_> = std::env::split_paths(&out).collect();
        assert_eq!(parts, vec![tool.clone(), other.clone()]);
        // 已在 PATH 里就不重复
        assert_eq!(prepend_path(Some(&out), &tool), out);
        // 原来没有 PATH 也能用
        let only: Vec<_> = std::env::split_paths(&prepend_path(None, &tool)).collect();
        assert_eq!(only, vec![tool]);
    }

    /// 进度条跨块重绘：逐块各自展开会把每一帧都堆下来（winget 实证），
    /// 必须保留 \r 拼完再展开
    #[test]
    fn carriage_returns_collapse_across_chunks() {
        let chunks = ["  -", "\r  \\", "\r  |", "\r 1024 KB / 3.62 MB", "\r 3.62 MB / 3.62 MB\r\n", "done\n"];
        let joined: String = chunks.iter().map(|c| strip_ansi_keep_cr(c)).collect();
        assert_eq!(collapse_cr(&joined), " 3.62 MB / 3.62 MB\ndone\n");
        // \r 与 \n 被拆在两块里也算正常换行
        let split: String = ["line\r", "\nnext"].iter().map(|c| strip_ansi_keep_cr(c)).collect();
        assert_eq!(collapse_cr(&split), "line\nnext");
        // 逐块展开（旧做法）确实会堆帧——钉住这条回归的成因
        let per_chunk: String = chunks.iter().map(|c| strip_ansi(c)).collect();
        assert!(per_chunk.contains("  -"), "{per_chunk}");
    }

    /// 冒烟测试：验证 PTY 流式输出——3 行各自间隔 1s 到达，而非退出时一次性到齐。
    /// 这正是修复前管道块缓冲的症状（"运行中，等待输出…" 卡住不动）。
    #[cfg(unix)]
    #[test]
    fn pty_streaming_delivers_lines_incrementally() {
        let chunks: Arc<Mutex<Vec<(std::time::Instant, String)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let c = chunks.clone();
        let (ok, _tail) = run_streaming_pty(
            "test-streaming",
            "bash",
            &[
                "-c".into(),
                "for i in 1 2 3; do echo line$i; sleep 1; done".into(),
            ],
            move |t| {
                c.lock()
                    .unwrap()
                    .push((std::time::Instant::now(), t.to_string()));
            },
        );
        assert!(ok);
        let chunks = chunks.lock().unwrap();
        let joined: String = chunks.iter().map(|(_, t)| t.as_str()).collect();
        for i in 1..=3 {
            assert!(joined.contains(&format!("line{i}")), "缺 line{i}: {joined}");
        }
        let at = |needle: &str| {
            chunks
                .iter()
                .find(|(_, t)| t.contains(needle))
                .map(|(t, _)| *t)
                .unwrap()
        };
        let gap = at("line3").duration_since(at("line1"));
        assert!(
            gap >= Duration::from_millis(1500),
            "line3 与 line1 到达间隔仅 {gap:?}，输出不是流式的"
        );
    }

    /// 交互测试：run 中途经 writers map 写入（模拟 brew [y/n] 确认），
    /// 子进程读到输入并把回显行吐出来；run 结束后 writer 已从 map 移除。
    #[cfg(unix)]
    #[test]
    fn pty_run_is_interactive_via_writers_map() {
        let chunks: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let c = chunks.clone();
        let key = "test-interactive".to_string();
        let key2 = key.clone();
        let handle = std::thread::spawn(move || {
            run_streaming_pty(
                &key2,
                "bash",
                &["-c".into(), "read x; echo got-$x".into()],
                move |t| {
                    c.lock().unwrap().push_str(t);
                },
            )
        });
        // 等 writer 就绪（最多 5s）
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if writers().lock().unwrap().contains_key(&key) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "writer 未注册进 map");
            std::thread::sleep(Duration::from_millis(50));
        }
        {
            let map = writers().lock().unwrap();
            let w = map.get(&key).unwrap();
            let mut g = w.lock().unwrap();
            g.write_all(b"hello\n").unwrap();
            g.flush().unwrap();
        }
        let (ok, _tail) = handle.join().unwrap();
        assert!(ok);
        let out = chunks.lock().unwrap().clone();
        assert!(out.contains("got-hello"), "子进程未读到输入，输出: {out}");
        assert!(
            !writers().lock().unwrap().contains_key(&key),
            "run 结束后 writer 应从 map 移除"
        );
    }

    /// 并发互斥：同 key 的第二个 run 入口即拒绝；第一个 run 结束后 key 释放可再跑
    #[cfg(unix)]
    #[test]
    fn concurrent_run_with_same_key_is_rejected() {
        let chunks: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let c = chunks.clone();
        let key = "test-concurrency".to_string();
        let key2 = key.clone();
        let handle = std::thread::spawn(move || {
            run_streaming_pty(
                &key2,
                "bash",
                &["-c".into(), "read x; echo done-$x".into()],
                move |t| {
                    c.lock().unwrap().push_str(t);
                },
            )
        });
        // 等第一个 run 跑起来（writer 注册说明已抢占 key；最多 5s 防挂死兜底）
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if writers().lock().unwrap().contains_key(&key) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "第一个 run 未启动");
            std::thread::sleep(Duration::from_millis(50));
        }
        // 同 key 并发：立即拒绝
        let (ok, msg) = run_streaming_pty(
            &key,
            "bash",
            &["-c".into(), "echo should-not-run".into()],
            |_| {},
        );
        assert!(!ok);
        assert!(msg.contains("正在运行"), "应提示已有运行中的任务: {msg}");
        // 放行第一个 run
        {
            let map = writers().lock().unwrap();
            let w = map.get(&key).unwrap();
            let mut g = w.lock().unwrap();
            g.write_all(b"go\n").unwrap();
            g.flush().unwrap();
        }
        let (ok1, _) = handle.join().unwrap();
        assert!(ok1);
        // 第一个 run 结束后 key 已释放：同 key 可再次运行
        let (ok2, _) = run_streaming_pty(&key, "bash", &["-c".into(), "true".into()], |_| {});
        assert!(ok2);
    }
}
