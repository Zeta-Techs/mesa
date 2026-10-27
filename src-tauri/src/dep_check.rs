//! 依赖体检 + 一键安装（git / node，agent CLI 之外的基础依赖）。
//! 检测走 agents::resolve_binary + version_with_timeout；安装复用 updater 的 PTY 流式
//! 机制（防块缓冲、国内镜像加速、key "dep-git"/"dep-node" 并发互斥、闲置/硬上限双超时），
//! 事件名沿用 updater 口径（agent-update-output-<key> / agent-update-done-<key>）。
//! macOS 的 /usr/bin/git 是 Xcode CLT 占位 stub：CLT 未装时跑它会弹系统安装窗，
//! 先用 `xcode-select -p` 判 CLT 已装与否，未装报 clt_stub、不做版本探测。

use crate::agents;
use crate::updater::{self, UpdateResultDto};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 平台显式传参（纯逻辑测试可注入），禁在判定函数里隐式读 cfg!
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostOs {
    Macos,
    Windows,
    Linux,
}

fn current_os() -> HostOs {
    if cfg!(target_os = "macos") {
        HostOs::Macos
    } else if cfg!(windows) {
        HostOs::Windows
    } else {
        HostOs::Linux
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepItemDto {
    /// ok | missing | clt_stub | broken（clt_stub 仅 macOS git：CLT 未装的系统占位；
    /// broken 仅 quarto：找到了但跑不起来，见 quarto_status）
    pub status: String,
    pub version: Option<String>,
    pub path: Option<String>,
    /// 未就绪的具体原因（目前只有 quarto 的残留环境变量），界面直接显示这一句
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// 还缺的前置依赖（目前只有 "python"：拼图库要先有 Python 3）。一键安装会先补上它
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prereq: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepCheckDto {
    pub git: DepItemDto,
    pub node: DepItemDto,
    /// 渲 PDF/Word 用。缺失只展示，诊断页不代装。
    pub quarto: DepItemDto,
    /// xelatex / tectonic / pdflatex 任一在即可。
    pub tex: DepItemDto,
    /// 综述拼图裁切。缺失只展示。
    pub pymupdf: DepItemDto,
    /// 综述拼图排版。缺失只展示。
    pub pillow: DepItemDto,
    /// 一键安装渠道：brew | winget | xcode | none
    pub channel: String,
    /// 本地时间可读串（YYYY-MM-DD HH:MM:SS）
    pub checked_at: String,
}

fn missing_item() -> DepItemDto {
    DepItemDto {
        status: "missing".into(),
        version: None,
        path: None,
        note: None,
        prereq: None,
    }
}

/// 二进制存在即 ok；版本探测失败（超时/异常输出）不降级状态，version 留 None
fn ok_item(path: PathBuf) -> DepItemDto {
    let version = agents::version_with_timeout(&path, agents::VERSION_QUERY_TIMEOUT);
    DepItemDto {
        status: "ok".into(),
        version,
        path: Some(path.to_string_lossy().into_owned()),
        note: None,
        prereq: None,
    }
}

/// 只有 macOS 系统占位路径 /usr/bin/git 才有 CLT stub 语义（brew/自装路径是真 git）
fn is_clt_stub_candidate(os: HostOs, path: &Path) -> bool {
    os == HostOs::Macos && path == Path::new("/usr/bin/git")
}

/// `xcode-select -p`：成功 = CLT（或 Xcode）已装；失败 = 未装。
/// 命令本身起不来时保守按已装处理（不拦后续版本探测）。
#[cfg(target_os = "macos")]
fn clt_missing() -> bool {
    match crate::process::background_command("xcode-select")
        .arg("-p")
        .output()
    {
        Ok(out) => !out.status.success(),
        Err(_) => false,
    }
}

#[cfg(not(target_os = "macos"))]
fn clt_missing() -> bool {
    false
}

/// git 探测结果三分（纯函数）：stub 候选路径 + CLT 未装 = clt_stub，其余按正常 git
fn git_status(os: HostOs, path: &Path, clt_missing: bool) -> &'static str {
    if is_clt_stub_candidate(os, path) && clt_missing {
        "clt_stub"
    } else {
        "ok"
    }
}

fn probe_git(os: HostOs) -> DepItemDto {
    let Some(path) = agents::resolve_binary("git") else {
        return missing_item();
    };
    // stub 状态不再跑 `git --version`：stub 会弹系统安装窗，且必被 5s 版本探测超时杀掉
    if git_status(os, &path, clt_missing()) == "clt_stub" {
        return DepItemDto {
            status: "clt_stub".into(),
            version: None,
            path: Some(path.to_string_lossy().into_owned()),
            note: None,
            prereq: None,
        };
    }
    ok_item(path)
}

fn probe_node() -> DepItemDto {
    match agents::resolve_binary("node") {
        Some(path) => ok_item(path),
        None => missing_item(),
    }
}

/// 只报在不在，不代装。Quarto / TeX 走二进制；拼图两个库问 python 能否导入。
fn probe_named(name: &str) -> DepItemDto {
    match agents::resolve_binary(name) {
        Some(path) => ok_item(path),
        None => missing_item(),
    }
}

/// Quarto 真能跑才算 ok：conda 等渠道会留下缺运行时（deno）的壳，`quarto --version`
/// 退出码 0 却不输出版本（2026-10-17 本机实证）。只看文件在不在会把它报成正常，
/// 综述/论文的渲染步骤要到最后才失败。
fn quarto_status(version: Option<&str>) -> &'static str {
    match version {
        Some(v) if v.chars().any(|c| c.is_ascii_digit()) => "ok",
        _ => "broken",
    }
}

pub(crate) fn probe_quarto() -> DepItemDto {
    let Some(path) = agents::resolve_binary("quarto") else {
        return missing_item();
    };
    let mut item = ok_item(path);
    item.status = quarto_status(item.version.as_deref()).into();
    if item.status == "broken" {
        let vars: Vec<(String, String)> = std::env::vars().collect();
        item.note = stale_quarto_env_note(&stale_quarto_env(&vars, |p| Path::new(p).exists()));
    }
    item
}

/// 指向已不存在路径的 QUARTO_* 环境变量（2026-10-18 本机实证）：conda 版 quarto 的激活脚本
/// 会导出 QUARTO_SHARE_PATH / QUARTO_DENO 等，卸载后已经在跑的进程（Mesa 自己、开着的终端）
/// 还带着它们；官方版 quarto 认这些变量，读不到版本、渲染也会失败——装得再对也没用，
/// 只有重启 Mesa 才清掉（从访达打开会重读登录 shell 环境，见 shell_env；从终端启动的要换个新开的终端）。
fn stale_quarto_env(vars: &[(String, String)], exists: impl Fn(&str) -> bool) -> Vec<String> {
    let mut out: Vec<String> = vars
        .iter()
        .filter(|(name, value)| {
            let v = value.trim();
            let looks_like_path = v.starts_with('/')
                || (v.len() > 2 && v.as_bytes()[1] == b':' && v.as_bytes()[0].is_ascii_alphabetic());
            name.starts_with("QUARTO_") && looks_like_path && !exists(v)
        })
        .map(|(name, _)| name.clone())
        .collect();
    out.sort();
    out
}

fn stale_quarto_env_note(names: &[String]) -> Option<String> {
    let first = names.first()?;
    let more = if names.len() > 1 {
        format!(" 等 {} 个变量", names.len())
    } else {
        String::new()
    };
    Some(format!(
        "Quarto 本身没问题，是 Mesa 进程里的环境变量 {first}{more}指向已删除的路径（多半是卸载 conda 版 quarto 后留下的）；重启 Mesa 即可（从终端启动的，先新开一个终端再启动）"
    ))
}

/// 跑一段 python 脚本，成功则回 stdout（5 秒超时）
fn run_python(path: &Path, script: &str) -> Option<String> {
    let mut child = crate::process::background_command(path)
        .args(["-c", script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let mut out = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    use std::io::Read;
                    let _ = stdout.read_to_string(&mut out);
                }
                return Some(out);
            }
            Ok(Some(_)) => return None,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
}

/// macOS 的 /usr/bin/python3 与 /usr/bin/git 同为 CLT 占位：CLT 没装时一运行就弹系统安装窗，
/// 不能拿它试跑
fn is_python_stub_candidate(os: HostOs, path: &Path) -> bool {
    os == HostOs::Macos && path == Path::new("/usr/bin/python3")
}

/// 真能跑的 Python。Windows 没装 Python 时 PATH 上的 python/python3 是应用商店占位程序
/// （WindowsApps 下的 AppInstallerPythonRedirector），一运行就以错误码退出、什么也不输出
/// ——只看文件在不在会拿它去跑 pip，界面只剩一句「安装失败」（2026-10-19 本机实证）。
/// 所以把 PATH 与候选目录里的同名程序全列出来逐个试跑：一键补齐刚装好的 Python 不在
/// 已运行 Mesa 的 PATH 上，也要靠候选目录找到。
pub(crate) fn usable_python() -> Option<PathBuf> {
    let os = current_os();
    let mut stub_blocked: Option<bool> = None;
    ["python3", "python"]
        .into_iter()
        .flat_map(agents::resolve_binary_all)
        .filter(|p| {
            !is_python_stub_candidate(os, p) || !*stub_blocked.get_or_insert_with(clt_missing)
        })
        .find(|p| run_python(p, "import sys").is_some())
}

/// 没有 Python 时一键补齐用哪条渠道装它（纯函数）：Windows 走 winget；macOS 有 Homebrew 走 brew，
/// 没有就用 python.org 的官方 .pkg（系统密码框提权）；Windows 没有 winget 只能请人去 python.org
fn python_install_channel(os: HostOs, has_brew: bool, has_winget: bool) -> Option<&'static str> {
    match os {
        HostOs::Windows if has_winget => Some("winget"),
        HostOs::Macos if has_brew => Some("brew"),
        HostOs::Macos => Some("pkg"),
        _ => None,
    }
}

fn no_python_msg(os: HostOs) -> String {
    match os {
        HostOs::Windows => "没有可用的 Python 3，也没有 winget 可以代装：请到 python.org 安装 Python 3（安装时勾选 Add python.exe to PATH），装完点「重新检测」".into(),
        HostOs::Macos => "没有可用的 Python 3，也没有 Homebrew 可以代装：请到 python.org 安装 Python 3，或先安装 Homebrew，装完点「重新检测」".into(),
        HostOs::Linux => "没有可用的 Python 3：请用发行版包管理器安装（如 sudo apt install python3 python3-pip），装完点「重新检测」".into(),
    }
}

/// PyMuPDF 的导入名：新名优先，旧版退回 fitz
const PYMUPDF_MODULES: &[&str] = &["pymupdf", "fitz"];

/// 按顺序试导入，第一个成功的打印版本。PyMuPDF 新名 `pymupdf`（1.24+），旧版只有 `fitz`——
/// 新版用 `fitz` 导入会先往 stdout 打一句弃用警告，设置页曾把它当成版本号显示（2026-10-19 实证）
fn module_version_script(modules: &[&str]) -> String {
    let names = modules
        .iter()
        .map(|m| format!("'{m}'"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "import importlib\nm = None\nfor n in [{names}]:\n    try:\n        m = importlib.import_module(n)\n        break\n    except ImportError:\n        pass\nif m is None:\n    raise SystemExit(1)\nprint(getattr(m, '__version__', '') or getattr(m, 'VersionBind', ''))"
    )
}

/// 版本号取最后一个非空行：导入时库自己打的提示都在它前面
fn last_line(out: &str) -> Option<String> {
    out.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .map(String::from)
}

fn probe_python_module(modules: &[&str]) -> DepItemDto {
    let Some(path) = usable_python() else {
        return DepItemDto {
            prereq: Some("python".into()),
            ..missing_item()
        };
    };
    // 顺带打印版本（设置页原先一律显示「版本未知」）：PIL 与新版 PyMuPDF 有 __version__，
    // 旧版 PyMuPDF 只有 VersionBind；都没有就空行，照旧算已安装
    match run_python(&path, &module_version_script(modules)) {
        Some(out) => DepItemDto {
            status: "ok".into(),
            version: last_line(&out),
            path: Some(path.to_string_lossy().into_owned()),
            note: None,
            prereq: None,
        },
        None => missing_item(),
    }
}

/// 一键安装渠道判定（纯函数，可用性注入以便测试）：
/// macOS = 有 brew 走 brew，否则「xcode」——git 弹系统安装窗、Node.js / Python / Quarto 走官方 .pkg、
/// TeX 由 Quarto 装 TinyTeX；Windows = 有 winget 走 winget 否则 none；Linux = none（提示发行版包管理器）
fn channel_for(os: HostOs, has_brew: bool, has_winget: bool) -> &'static str {
    match os {
        HostOs::Macos => {
            if has_brew {
                "brew"
            } else {
                "xcode"
            }
        }
        HostOs::Windows => {
            if has_winget {
                "winget"
            } else {
                "none"
            }
        }
        HostOs::Linux => "none",
    }
}

fn check_dependencies_sync() -> Result<DepCheckDto, String> {
    let os = current_os();
    let git = probe_git(os);
    let node = probe_node();
    let quarto = probe_quarto();
    let tex = ["xelatex", "tectonic", "pdflatex"]
        .into_iter()
        .find_map(|name| {
            let item = probe_named(name);
            (item.status == "ok").then_some(item)
        })
        .unwrap_or_else(missing_item);
    let pymupdf = probe_python_module(PYMUPDF_MODULES);
    let pillow = probe_python_module(&["PIL"]);
    let has_brew = os == HostOs::Macos && agents::resolve_binary("brew").is_some();
    let has_winget = os == HostOs::Windows && agents::resolve_binary("winget").is_some();
    Ok(DepCheckDto {
        git,
        node,
        quarto,
        tex,
        pymupdf,
        pillow,
        channel: channel_for(os, has_brew, has_winget).into(),
        checked_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    })
}

#[tauri::command]
pub async fn check_dependencies() -> Result<DepCheckDto, String> {
    tauri::async_runtime::spawn_blocking(check_dependencies_sync)
        .await
        .map_err(|e| format!("依赖检测失败: {e}"))?
}

// ===== 一键安装 =====

/// 流式事件与 updater_write 交互共用的 key
fn dep_key(tool: &str) -> String {
    format!("dep-{tool}")
}

fn validate_tool(tool: &str) -> Result<(), String> {
    if matches!(tool, "git" | "node" | "quarto" | "tex" | "pymupdf" | "pillow") {
        Ok(())
    } else {
        Err(format!(
            "不支持安装的依赖：{tool}（仅 git / node / quarto / tex / pymupdf / pillow）"
        ))
    }
}

struct InstallSpec {
    /// brew 包名。空 = 这一渠道不装。
    brew: &'static str,
    /// brew 要不要 --cask。
    brew_cask: bool,
    /// winget 包 id。空 = 不装。
    winget: &'static str,
    /// apt 包名，写进 Linux 指引。
    apt: &'static str,
    /// 没有自动渠道时指到哪里。
    site: &'static str,
}

fn install_spec(tool: &str) -> InstallSpec {
    match tool {
        "git" => InstallSpec {
            brew: "git",
            brew_cask: false,
            winget: "Git.Git",
            apt: "git",
            site: "git-scm.com",
        },
        "quarto" => InstallSpec {
            brew: "quarto",
            brew_cask: true,
            winget: "Posit.Quarto",
            apt: "",
            site: "quarto.org",
        },
        "tex" => InstallSpec {
            brew: "tectonic",
            brew_cask: false,
            // Windows 不走 winget（源里没有 Tectonic），见 install_tex_windows
            winget: "",
            apt: "tectonic",
            site: "tectonic-typesetting.github.io",
        },
        "pymupdf" => InstallSpec {
            brew: "",
            brew_cask: false,
            winget: "",
            apt: "python3-pymupdf",
            site: "pypi.org/project/pymupdf",
        },
        "pillow" => InstallSpec {
            brew: "",
            brew_cask: false,
            winget: "",
            apt: "python3-pil",
            site: "pypi.org/project/pillow",
        },
        _ => InstallSpec {
            brew: "node",
            brew_cask: false,
            winget: "OpenJS.NodeJS.LTS",
            apt: "nodejs",
            site: "nodejs.org",
        },
    }
}

fn no_brew_msg(tool: &str) -> String {
    let spec = install_spec(tool);
    if tool == "git" {
        return "未检测到 Homebrew：点「安装」触发系统安装窗口（Xcode 命令行工具），装完点「重新检测」"
            .into();
    }
    format!(
        "未检测到 Homebrew：请到 {} 下载安装包，或先安装 Homebrew，装完点「重新检测」",
        spec.site
    )
}

fn no_winget_msg(tool: &str) -> String {
    format!(
        "未检测到 winget：请到 {} 下载安装包，装完点「重新检测」",
        install_spec(tool).site
    )
}

fn linux_hint(tool: &str) -> String {
    let pkg = install_spec(tool).apt;
    if pkg.is_empty() {
        return format!(
            "请到 {} 下载安装包，装完点「重新检测」",
            install_spec(tool).site
        );
    }
    format!("请用发行版包管理器安装（如 sudo apt install {pkg}），装完点「重新检测」")
}

fn installed_after(tool: &str) -> bool {
    match tool {
        "tex" => ["xelatex", "tectonic", "pdflatex"]
            .into_iter()
            .any(|name| probe_named(name).status == "ok"),
        "pymupdf" => probe_python_module(PYMUPDF_MODULES).status == "ok",
        "pillow" => probe_python_module(&["PIL"]).status == "ok",
        other => probe_named(other).status == "ok",
    }
}

/// 装完成功：失效探测缓存后再探一次。Python 库和 TeX 没有单一二进制版本号。
fn finish_install(tool: &str, ok: bool, output: String, method: &str) -> UpdateResultDto {
    agents::invalidate_detect_cache();
    updater::invalidate_check_cache();
    let present = installed_after(tool);
    // 命令报错但东西其实已就位（winget「已安装 / 没有可用升级」、Mesa 先前因 PATH 没认出
    // 已装的程序等）也算装好——否则用户点了安装只看到「安装失败」，再点也一样
    let ok = ok || present;
    let version_after = if ok && present {
        match tool {
            "pymupdf" | "pillow" | "tex" => Some("已安装".into()),
            other => agents::resolve_binary(other)
                .and_then(|p| agents::version_with_timeout(&p, agents::VERSION_QUERY_TIMEOUT))
                .or(Some("已安装".into())),
        }
    } else {
        None
    };
    UpdateResultDto {
        ok,
        output,
        method: method.into(),
        version_before: None,
        version_after,
    }
}

fn install_with_brew(app: &AppHandle, tool: &str, package: &str, cask: bool) -> UpdateResultDto {
    let mut args = vec!["install".to_string()];
    if cask {
        args.push("--cask".into());
    }
    args.push(package.to_string());
    let (ok, output) = updater::run_streaming(app, &dep_key(tool), "brew", &args);
    finish_install(tool, ok, output, "brew")
}

/// 拼图两个库一起装：普通用户分不清 PyMuPDF / Pillow，点任一行的「一键安装」都补齐两个
const PIP_PACKAGES: [&str; 2] = ["pymupdf", "pillow"];

/// winget 上的 Python 包：3.12 已停出安装包，用 3.13
const WINGET_PYTHON_ID: &str = "Python.Python.3.13";

/// 没有可用 Python 时先装 Python（一键补齐的第一步）。Windows 走 winget 全机安装（会弹管理员确认）：
/// 装进 %ProgramFiles%，Codex 的 elevated 沙箱（以单独的本地账户跑命令，读不了用户目录）里也能用——
/// 2026-10-21 前只装当前用户，装出来的 Python 在 Codex 里 not recognized（environment.md 同日条）。
/// PrependPath=1 让它排在应用商店占位前面，新开的终端和 agent 直接用上；macOS 走 brew install python。
/// 没有渠道返回 Err（界面按原因提示）。
fn install_python(app: &AppHandle, tool: &str) -> Result<(bool, String, &'static str), String> {
    let os = current_os();
    let has_brew = os == HostOs::Macos && agents::resolve_binary("brew").is_some();
    let has_winget = os == HostOs::Windows && agents::resolve_binary("winget").is_some();
    let Some(channel) = python_install_channel(os, has_brew, has_winget) else {
        return Err(no_python_msg(os));
    };
    use tauri::Emitter;
    let _ = app.emit(
        &format!("agent-update-output-{}", dep_key(tool)),
        "还没有可用的 Python 3，先安装它（约 1–3 分钟），装好后接着装 PDF 处理库…\n",
    );
    if channel == "winget" {
        let _ = app.emit(
            &format!("agent-update-output-{}", dep_key(tool)),
            "安装过程中 Windows 可能弹出「你要允许此应用对你的设备进行更改吗？」，请点「是」。\n",
        );
    }
    if channel == "pkg" {
        let (ok, output) = run_mac_pkg(app, tool, "python")?;
        return Ok((ok, output, channel));
    }
    let (program, args) = python_install_command(channel);
    let (ok, output) = updater::run_streaming(app, &dep_key(tool), program, &args);
    Ok((ok, output, channel))
}

/// 装 Python 的命令行（纯函数，便于测试参数）
fn python_install_command(channel: &str) -> (&'static str, Vec<String>) {
    if channel == "winget" {
        let mut args = updater::winget_args("install", WINGET_PYTHON_ID);
        args.extend(["--scope", "machine", "--custom", "InstallAllUsers=1 PrependPath=1"].map(String::from));
        ("winget", args)
    } else {
        ("brew", vec!["install".into(), "python".into()])
    }
}

/// pip 参数：externally_managed（PEP 668，Homebrew / 部分 Linux 的 Python）时装进用户目录。
/// PEP 668 连 `--user` 也拦，必须同时带 --break-system-packages——只加 --user 的旧重试必然再失败
fn pip_args(externally_managed: bool) -> Vec<String> {
    let mut args: Vec<String> = ["-m", "pip", "install", "--disable-pip-version-check", "--no-input"]
        .map(String::from)
        .to_vec();
    if externally_managed {
        args.extend(["--user", "--break-system-packages"].map(String::from));
    }
    args.extend(PIP_PACKAGES.map(String::from));
    args
}

/// 拼图库一键补齐：没有可用 Python 先装 Python，再用它的 pip 把两个库一起装上。
fn install_with_pip(app: &AppHandle, tool: &str) -> Result<UpdateResultDto, String> {
    // 两行按钮装的是同一批东西（dep-pymupdf / dep-pillow 两个 key 各自不互斥），
    // 并发会装两遍 Python
    static FIGURE_LIBS_BUSY: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    struct BusyGuard;
    impl Drop for BusyGuard {
        fn drop(&mut self) {
            FIGURE_LIBS_BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    if FIGURE_LIBS_BUSY.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("PyMuPDF 和 Pillow 正在一起安装，等它装完".into());
    }
    let _busy = BusyGuard;
    let python = match usable_python() {
        Some(p) => p,
        None => {
            let (ok, output, method) = install_python(app, tool)?;
            if !ok {
                return Ok(finish_install(tool, false, output, method));
            }
            agents::invalidate_detect_cache();
            match usable_python() {
                Some(p) => p,
                None => {
                    return Ok(finish_install(
                        tool,
                        false,
                        format!("{output}\nPython 已装好，但 Mesa 这次还找不到它：重启 Mesa 后再点一次「一键安装」"),
                        method,
                    ))
                }
            }
        }
    };
    let program = python.to_string_lossy().into_owned();
    // Windows 全机安装的 Python：经管理员确认装进它自己的 site-packages，Codex 的 elevated 沙箱也看得到。
    // 用户点了「否」（或没起来）就照常用普通权限装——pip 会自己退到用户目录，Mesa 能用、Codex 沙箱里用不了
    #[cfg(windows)]
    if pip_needs_elevation(current_os(), &python, &program_files_roots()) {
        if let Some((ok, output)) = pip_elevated(app, tool, &python) {
            return Ok(finish_install(tool, ok, output, "pip"));
        }
        use tauri::Emitter;
        let _ = app.emit(
            &format!("agent-update-output-{}", dep_key(tool)),
            "没拿到管理员确认，改装到你自己的用户目录：Mesa 能用，但 Codex 的沙箱里用不了这两个库。\n",
        );
    }
    let (ok, output) = updater::run_streaming(app, &dep_key(tool), &program, &pip_args(false));
    if ok {
        return Ok(finish_install(tool, true, output, "pip"));
    }
    if output.contains("externally-managed-environment") {
        let (ok2, output2) =
            updater::run_streaming(app, &dep_key(tool), &program, &pip_args(true));
        return Ok(finish_install(tool, ok2, output2, "pip"));
    }
    Ok(finish_install(tool, false, output, "pip"))
}

/// Windows 上装在 %ProgramFiles% 下的 Python（一键补齐 2026-10-21 起就是这种）：普通权限的 pip 写不进
/// 它的 site-packages，会自动退到 %APPDATA%\Python——Codex 的 elevated 沙箱以单独的本地账户跑命令，
/// 读不了用户目录，AI 在 Codex 里 `import pymupdf` 就找不到（environment.md 同日条）。这种要经管理员确认再装
#[cfg_attr(not(windows), allow(dead_code))]
fn pip_needs_elevation(os: HostOs, python: &Path, program_roots: &[PathBuf]) -> bool {
    os == HostOs::Windows && program_roots.iter().any(|r| crate::paths::path_within_path(python, r))
}

#[cfg(windows)]
fn program_files_roots() -> Vec<PathBuf> {
    ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|k| std::env::var_os(k).map(PathBuf::from))
        .collect()
}

/// 以管理员身份跑的那段 Python：pip 的输出逐行写进日志（Mesa 边等边读给界面），退出码照传
#[cfg_attr(not(windows), allow(dead_code))]
fn elevated_pip_script(log: &Path) -> String {
    let log = serde_json::to_string(&log.to_string_lossy()).unwrap_or_default();
    let cmd = serde_json::to_string(&pip_args(false)).unwrap_or_default();
    format!(
        "import os, subprocess, sys\n\
         with open({log}, \"w\", encoding=\"utf-8\", buffering=1) as f:\n    \
         r = subprocess.run([sys.executable] + {cmd}, stdout=f, stderr=subprocess.STDOUT,\n                       \
         env=dict(os.environ, PYTHONUNBUFFERED=\"1\", PYTHONIOENCODING=\"utf-8\"))\n\
         sys.exit(r.returncode)\n"
    )
}

/// PowerShell 单引号字面量
#[cfg_attr(not(windows), allow(dead_code))]
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 经 UAC 以管理员身份跑 pip（Start-Process -Verb RunAs，输出拿不到管道，改写日志文件、边等边推给界面）。
/// None = 日志都没生成：用户点了「否」或没起来，调用方退回普通权限装
#[cfg(windows)]
fn pip_elevated(app: &AppHandle, tool: &str, python: &Path) -> Option<(bool, String)> {
    use tauri::Emitter;
    let event = format!("agent-update-output-{}", dep_key(tool));
    pip_elevated_with(python, |text| {
        let _ = app.emit(&event, text);
    })
}

#[cfg(windows)]
fn pip_elevated_with(python: &Path, emit: impl Fn(String)) -> Option<(bool, String)> {
    let powershell = agents::resolve_binary("powershell")?;
    let dir = crate::storage::config_root()?
        .join("tmp")
        .join(format!("pip-elevated-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).ok()?;
    let (log, script) = (dir.join("pip.log"), dir.join("pip_elevated.py"));
    if std::fs::write(&script, elevated_pip_script(&log)).is_err() {
        let _ = std::fs::remove_dir_all(&dir);
        return None;
    }
    emit("PDF 处理库要装进全机的 Python，Windows 会弹出「你要允许此应用对你的设备进行更改吗？」，请点「是」。\n".into());
    let command = format!(
        "$p = Start-Process -FilePath {} -ArgumentList {} -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode",
        ps_quote(&python.to_string_lossy()),
        ps_quote(&format!("\"{}\"", script.to_string_lossy())),
    );
    let mut child = crate::process::background_command(&powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", &command])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20 * 60);
    let mut sent = 0usize;
    let push = |sent: &mut usize| {
        if let Ok(bytes) = std::fs::read(&log) {
            if bytes.len() > *sent {
                emit(String::from_utf8_lossy(&bytes[*sent..]).into_owned());
                *sent = bytes.len();
            }
        }
    };
    let status = loop {
        if let Ok(Some(s)) = child.try_wait() {
            break Some(s);
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            break None;
        }
        push(&mut sent);
        std::thread::sleep(std::time::Duration::from_millis(400));
    };
    push(&mut sent);
    let text = std::fs::read(&log).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
    let _ = std::fs::remove_dir_all(&dir);
    match (status, text) {
        (_, None) => None,
        (Some(s), Some(t)) => Some((s.success(), t)),
        (None, Some(t)) => Some((false, format!("{t}\n等了 20 分钟还没装完，Mesa 不再等了：稍后点「重新检测」看是否已装好"))),
    }
}

/// winget 安装参数（纯函数）。Node.js 钉死系统级（MSI）：它的「仅当前用户」安装包是绿色
/// 解压版，只在 WinGet\Links 挂 node 快捷方式、没有 npm.cmd——winget 设置偏好用户范围时会被
/// 选中，装完 Agent CLI 照样装不了。
fn winget_install_args(tool: &str, winget_id: &str) -> Vec<String> {
    let mut args = updater::winget_args("install", winget_id);
    if tool == "node" {
        args.extend(["--scope", "machine"].map(String::from));
    }
    args
}

fn install_with_winget(app: &AppHandle, tool: &str, winget_id: &str) -> UpdateResultDto {
    // 系统级安装包（Git / Node.js / Quarto）会弹 UAC；普通用户不知道要点，先说一句
    use tauri::Emitter;
    let _ = app.emit(
        &format!("agent-update-output-{}", dep_key(tool)),
        "安装过程中 Windows 可能弹出「你要允许此应用对你的设备进行更改吗？」，请点「是」。\n",
    );
    let args = winget_install_args(tool, winget_id);
    let (ok, output) = updater::run_streaming(app, &dep_key(tool), "winget", &args);
    finish_install(tool, ok, output, "winget")
}

fn install_macos(app: &AppHandle, tool: &str) -> Result<UpdateResultDto, String> {
    if matches!(tool, "pymupdf" | "pillow") {
        return install_with_pip(app, tool);
    }
    let spec = install_spec(tool);
    let has_brew = agents::resolve_binary("brew").is_some();
    if tool == "git" && !has_brew {
        // xcode-select --install 弹系统 GUI 异步完成：spawn 后立即返回，不等待
        crate::process::background_command("xcode-select")
            .arg("--install")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("触发系统安装窗口失败: {e}"))?;
        return Ok(UpdateResultDto {
            ok: true,
            output: "已触发系统安装窗口，请在弹窗中完成安装，装完点「重新检测」".into(),
            method: "xcode".into(),
            version_before: None,
            version_after: None,
        });
    }
    if !has_brew {
        // 没有 Homebrew：Node.js / Quarto 走官方 .pkg，TeX 走 Quarto 自带的 TinyTeX（同 Windows）
        return match tool {
            "node" | "quarto" => install_mac_pkg(app, tool, tool),
            "tex" => install_tex_via_quarto(app, false),
            _ => Err(no_brew_msg(tool)),
        };
    }
    if spec.brew.is_empty() {
        return Err(no_brew_msg(tool));
    }
    Ok(install_with_brew(app, tool, spec.brew, spec.brew_cask))
}

// ===== macOS 没有 Homebrew：官方安装包（.pkg）=====
//
// 科研用户的 Mac 多半没装 Homebrew，原先 Node.js / Python / Quarto / TeX 都只能「去官网下」。
// 三家官网都发 macOS .pkg：先查出当前版本的下载地址（Node 读 dist/index.json 的最新 LTS、Python 读
// python.org/downloads/macos/ 页上最高的正式版、Quarto 读 GitHub 最新 Release 的 -macos.pkg），
// curl 下载（走设置里的出网代理），再用系统 installer 装——osascript「with administrator privileges」
// 弹系统密码框，Mesa 碰不到密码。TeX 用 Quarto 的 `install tinytex`（装在用户目录，不要密码）。

/// 每家官方包的版本索引地址与站点（报错时给人看）
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn mac_pkg_index(tool: &str) -> Option<&'static str> {
    match tool {
        "node" => Some("https://nodejs.org/dist/index.json"),
        "python" => Some("https://www.python.org/downloads/macos/"),
        "quarto" => Some("https://api.github.com/repos/quarto-dev/quarto-cli/releases/latest"),
        _ => None,
    }
}

/// 从索引正文挑出 .pkg 下载地址（纯函数，三家各一种格式）
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn mac_pkg_url(tool: &str, body: &str) -> Option<String> {
    match tool {
        "node" => {
            let list: Vec<serde_json::Value> = serde_json::from_str(body).ok()?;
            // 按发布时间倒序；lts 是代号字符串（"Jod"）或 false
            let ver = list
                .iter()
                .find(|v| v.get("lts").is_some_and(|l| l.is_string()))?
                .get("version")?
                .as_str()?;
            if !ver.starts_with('v') || !ver[1..].split('.').all(|p| p.parse::<u32>().is_ok()) {
                return None;
            }
            Some(format!("https://nodejs.org/dist/{ver}/node-{ver}.pkg"))
        }
        "python" => {
            // 页上同时列着预发布（3.15.0a1 这种），只认纯数字的 3.x.y 且文件名与目录版本一致
            const PREFIX: &str = "https://www.python.org/ftp/python/";
            body.match_indices(PREFIX)
                .filter_map(|(at, _)| {
                    let rest = &body[at + PREFIX.len()..];
                    let (ver, tail) = rest.split_once('/')?;
                    let parts: Vec<u32> = ver.split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
                    let file = format!("python-{ver}-macos11.pkg");
                    (parts.len() == 3 && parts[0] == 3 && tail.starts_with(&file))
                        .then(|| (parts, format!("{PREFIX}{ver}/{file}")))
                })
                .max_by(|a, b| a.0.cmp(&b.0))
                .map(|(_, url)| url)
        }
        "quarto" => {
            let rel: serde_json::Value = serde_json::from_str(body).ok()?;
            rel.get("assets")?
                .as_array()?
                .iter()
                .filter_map(|a| a.get("browser_download_url")?.as_str())
                .find(|u| u.starts_with("https://github.com/") && u.ends_with("-macos.pkg"))
                .map(str::to_string)
        }
        _ => None,
    }
}

/// 下载并安装：参数位传地址与落盘路径，脚本里不拼用户数据；installer 由 osascript 提权（系统密码框）
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
const MAC_PKG_SCRIPT: &str = "set -e\n\
echo \"下载 $1\"\n\
curl -fL --retry 2 --connect-timeout 20 -o \"$2\" \"$1\"\n\
echo \"下载完成，接下来系统会弹窗要开机密码（安装到 /usr/local 需要管理员权限）\"\n\
osascript -e 'on run argv' -e 'do shell script \"/usr/sbin/installer -pkg \" & quoted form of (item 1 of argv) & \" -target /\" with administrator privileges' -e 'end run' \"$2\"\n\
rm -f \"$2\"\n";

#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn mac_pkg_site(tool: &str) -> &'static str {
    match tool {
        "python" => "python.org",
        "quarto" => "quarto.org",
        _ => "nodejs.org",
    }
}

/// 查版本索引（有界、走出网代理）；失败给出可行动的话
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn fetch_mac_pkg_url(pkg: &str) -> Result<String, String> {
    let index = mac_pkg_index(pkg).ok_or("没有这一项的官方安装包")?;
    let site = mac_pkg_site(pkg);
    let mut cmd = crate::process::background_command("curl");
    cmd.args(["-fsSL", "--max-time", "30", index]);
    for (k, v) in crate::settings::download_proxy_env(&[]) {
        cmd.env(k, v);
    }
    let out = crate::process::capture_command(&mut cmd, std::time::Duration::from_secs(40), 8 * 1024 * 1024)
        .map_err(|e| format!("查 {site} 的版本信息失败：{e}"))?;
    if out.timed_out || !out.status.is_some_and(|s| s.success()) {
        return Err(format!(
            "连不上 {site} 查版本信息：检查网络或在设置 → 网络填出网代理，也可以自己到 {site} 下载安装包，装完点「重新检测」"
        ));
    }
    mac_pkg_url(pkg, &String::from_utf8_lossy(&out.stdout))
        .ok_or_else(|| format!("没从 {site} 读到 macOS 安装包地址，请自己到 {site} 下载安装，装完点「重新检测」"))
}

/// tool = 界面上的依赖（日志与完成事件的 key），pkg = 实际装哪家（拼图库一键补齐时是 python）
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn install_mac_pkg(app: &AppHandle, tool: &str, pkg: &str) -> Result<UpdateResultDto, String> {
    let (ok, output) = run_mac_pkg(app, tool, pkg)?;
    Ok(finish_install(tool, ok, output, "pkg"))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn run_mac_pkg(app: &AppHandle, tool: &str, pkg: &str) -> Result<(bool, String), String> {
    use tauri::Emitter;
    let _ = app.emit(
        &format!("agent-update-output-{}", dep_key(tool)),
        format!(
            "没有 Homebrew：改用 {} 的官方安装包。先查最新版本…\n",
            mac_pkg_site(pkg)
        ),
    );
    let url = fetch_mac_pkg_url(pkg)?;
    let file = std::env::temp_dir().join(format!("mesa-{pkg}-{}.pkg", std::process::id()));
    let args = vec![
        "-c".to_string(),
        MAC_PKG_SCRIPT.to_string(),
        "sh".to_string(),
        url,
        file.to_string_lossy().into_owned(),
    ];
    Ok(updater::run_streaming(app, &dep_key(tool), "/bin/sh", &args))
}

/// TeX 走 Quarto 自带的 TinyTeX（Windows 一直这样；macOS 没有 Homebrew 时也这样）。
/// update_path：Windows 写进用户 PATH；macOS 不写（要往 /usr/local/bin 建链接、需要管理员），
/// Quarto 渲染 PDF 自己认得 TinyTeX，Mesa 靠 binary_candidate_dirs 的 ~/Library/TinyTeX 找到
fn install_tex_via_quarto(app: &AppHandle, update_path: bool) -> Result<UpdateResultDto, String> {
    let quarto = probe_quarto();
    let Some(path) = quarto.path.filter(|_| quarto.status == "ok") else {
        return Err("TeX 由 Quarto 安装（TinyTeX）：先一键安装 Quarto，再装 TeX".into());
    };
    let mut args: Vec<String> = ["install", "tinytex", "--no-prompt"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if update_path {
        args.push("--update-path".into());
    }
    let (ok, output) = updater::run_streaming(app, &dep_key("tex"), &path, &args);
    Ok(finish_install("tex", ok, output, "quarto"))
}

fn install_windows(app: &AppHandle, tool: &str) -> Result<UpdateResultDto, String> {
    if matches!(tool, "pymupdf" | "pillow") {
        return install_with_pip(app, tool);
    }
    if tool == "tex" {
        // Windows 的 TeX：winget 源里没有 Tectonic（2026-10-19 实测 `winget search tectonic` 无结果），
        // 改用 Quarto 官方推荐的 TinyTeX，装到 %APPDATA%\TinyTeX，--update-path 写进用户 PATH
        return install_tex_via_quarto(app, true);
    }
    if agents::resolve_binary("winget").is_none() {
        return Err(no_winget_msg(tool));
    }
    let id = install_spec(tool).winget;
    if id.is_empty() {
        return Err(no_winget_msg(tool));
    }
    Ok(install_with_winget(app, tool, id))
}

fn install_dependency_sync(app: &AppHandle, tool: &str) -> Result<UpdateResultDto, String> {
    // 渠道在每个分支现场判定（resolve brew/winget），不依赖 check_dependencies 的缓存
    match current_os() {
        HostOs::Macos => install_macos(app, tool),
        HostOs::Windows => install_windows(app, tool),
        HostOs::Linux => Err(linux_hint(tool)),
    }
}

/// 结果经 `agent-update-done-dep-<tool>` 推送（前端以事件为准，invoke 返回值兜底）；
/// Err 分支（无渠道/未知 tool）不发 done 事件，由 invoke 的 reject 直接提示
#[tauri::command]
pub async fn install_dependency(app: AppHandle, tool: String) -> Result<UpdateResultDto, String> {
    validate_tool(&tool)?;
    let app2 = app.clone();
    let tool2 = tool.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || install_dependency_sync(&app2, &tool2))
            .await
            .map_err(|e| format!("安装失败: {e}"))??;
    Ok(updater::emit_done(&app, &dep_key(&tool), result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_matrix_covers_all_platforms() {
        // macOS：brew 优先，无 brew 走 xcode（git 用 xcode-select --install）
        assert_eq!(channel_for(HostOs::Macos, true, false), "brew");
        assert_eq!(channel_for(HostOs::Macos, false, false), "xcode");
        // Windows：winget 唯一自动渠道（brew 在 Windows 不算数）
        assert_eq!(channel_for(HostOs::Windows, false, true), "winget");
        assert_eq!(channel_for(HostOs::Windows, false, false), "none");
        assert_eq!(channel_for(HostOs::Windows, true, true), "winget");
        // Linux：无自动渠道
        assert_eq!(channel_for(HostOs::Linux, true, true), "none");
        assert_eq!(channel_for(HostOs::Linux, false, false), "none");
    }

    #[test]
    fn clt_stub_candidate_is_macos_usr_bin_git_only() {
        assert!(is_clt_stub_candidate(
            HostOs::Macos,
            Path::new("/usr/bin/git")
        ));
        // brew/自装的 git 不是 stub
        assert!(!is_clt_stub_candidate(
            HostOs::Macos,
            Path::new("/opt/homebrew/bin/git")
        ));
        assert!(!is_clt_stub_candidate(
            HostOs::Macos,
            Path::new("/usr/local/bin/git")
        ));
        // 其他平台无 stub 概念（同名字面路径也不算）
        assert!(!is_clt_stub_candidate(
            HostOs::Linux,
            Path::new("/usr/bin/git")
        ));
        assert!(!is_clt_stub_candidate(
            HostOs::Windows,
            Path::new("/usr/bin/git")
        ));
    }

    #[test]
    fn stale_quarto_env_names_vars_pointing_at_missing_paths() {
        let vars = vec![
            ("QUARTO_SHARE_PATH".to_string(), "/gone/share/quarto".to_string()),
            ("QUARTO_DENO".to_string(), "/gone/bin/deno".to_string()),
            ("QUARTO_PRINT_STACK".to_string(), "true".to_string()),
            ("QUARTO_ROOT_OK".to_string(), "/exists".to_string()),
            ("PATH".to_string(), "/gone".to_string()),
        ];
        let stale = stale_quarto_env(&vars, |p| p == "/exists");
        assert_eq!(stale, vec!["QUARTO_DENO", "QUARTO_SHARE_PATH"]);
        let note = stale_quarto_env_note(&stale).unwrap();
        assert!(note.contains("QUARTO_DENO 等 2 个变量"), "{note}");
        assert!(note.contains("重启 Mesa"));
        assert_eq!(stale_quarto_env_note(&[]), None);
    }

    #[test]
    fn quarto_without_version_output_is_broken() {
        assert_eq!(quarto_status(Some("1.6.40")), "ok");
        assert_eq!(quarto_status(None), "broken");
        assert_eq!(quarto_status(Some("cat: share/version: No such file")), "broken");
    }

    #[test]
    fn git_status_tri_state() {
        // stub 候选 + CLT 缺失 = clt_stub
        assert_eq!(
            git_status(HostOs::Macos, Path::new("/usr/bin/git"), true),
            "clt_stub"
        );
        // CLT 已装 = 正常 git
        assert_eq!(
            git_status(HostOs::Macos, Path::new("/usr/bin/git"), false),
            "ok"
        );
        // 非候选路径不看 CLT
        assert_eq!(
            git_status(HostOs::Macos, Path::new("/opt/homebrew/bin/git"), true),
            "ok"
        );
        assert_eq!(
            git_status(HostOs::Linux, Path::new("/usr/bin/git"), true),
            "ok"
        );
    }

    #[test]
    fn no_channel_error_messages_point_to_official_sites() {
        let node_mac = no_brew_msg("node");
        assert!(node_mac.contains("nodejs.org"));
        assert!(node_mac.contains("Homebrew"));
        let git_msg = no_winget_msg("git");
        assert!(git_msg.contains("git-scm.com"));
        assert!(!git_msg.contains("nodejs.org"));
        let node_msg = no_winget_msg("node");
        assert!(node_msg.contains("nodejs.org"));
        assert!(!node_msg.contains("git-scm.com"));
        assert!(no_winget_msg("quarto").contains("quarto.org"));
        assert!(no_brew_msg("tex").contains("tectonic-typesetting.github.io"));
        // Linux：git/node 包名分别写；Quarto 没有 apt 包，改指官网
        let git_hint = linux_hint("git");
        assert!(git_hint.contains("apt install git"));
        assert!(!git_hint.contains("nodejs"));
        assert!(linux_hint("node").contains("apt install nodejs"));
        assert!(linux_hint("tex").contains("apt install tectonic"));
        assert!(linux_hint("quarto").contains("quarto.org"));
        assert!(linux_hint("pymupdf").contains("python3-pymupdf"));
    }

    #[test]
    fn tool_whitelist_accepts_known_deps_only() {
        for tool in ["git", "node", "quarto", "tex", "pymupdf", "pillow"] {
            assert!(validate_tool(tool).is_ok(), "{tool}");
        }
        for bad in ["brew", "Git", "", "git;rm", "pip"] {
            assert!(validate_tool(bad).is_err(), "{bad} 应被拒绝");
        }
    }

    #[test]
    fn install_spec_maps_channels() {
        assert_eq!(install_spec("quarto").brew, "quarto");
        assert!(install_spec("quarto").brew_cask);
        assert_eq!(install_spec("quarto").winget, "Posit.Quarto");
        assert_eq!(install_spec("tex").brew, "tectonic");
        assert!(!install_spec("tex").brew_cask);
        // winget 源里没有 Tectonic：Windows 的 TeX 走 quarto install tinytex，不留 winget id
        assert!(install_spec("tex").winget.is_empty());
        assert!(install_spec("pymupdf").brew.is_empty());
        assert!(install_spec("pillow").winget.is_empty());
    }

    #[test]
    fn python_prereq_install_channels_and_commands() {
        // 没有 Python 时的代装渠道：Windows 只认 winget；macOS 有 brew 走 brew、没有走官方 .pkg；Linux 不代装
        assert_eq!(python_install_channel(HostOs::Windows, false, true), Some("winget"));
        assert_eq!(python_install_channel(HostOs::Windows, true, false), None);
        assert_eq!(python_install_channel(HostOs::Macos, true, false), Some("brew"));
        assert_eq!(python_install_channel(HostOs::Macos, false, true), Some("pkg"));
        assert_eq!(python_install_channel(HostOs::Linux, true, true), None);
        // winget：全机安装（Codex elevated 沙箱看得到）、写进 PATH（排在应用商店占位前面）
        let (prog, args) = python_install_command("winget");
        assert_eq!(prog, "winget");
        assert!(args.windows(2).any(|w| w == ["--id", WINGET_PYTHON_ID]));
        assert!(args.windows(2).any(|w| w == ["--scope", "machine"]));
        assert!(args.windows(2).any(|w| w == ["--custom", "InstallAllUsers=1 PrependPath=1"]));
        assert_eq!(python_install_command("brew"), ("brew", vec!["install".to_string(), "python".to_string()]));
        // 没有渠道时的提示都给出口
        assert!(no_python_msg(HostOs::Windows).contains("python.org"));
        assert!(no_python_msg(HostOs::Macos).contains("Homebrew"));
        assert!(no_python_msg(HostOs::Linux).contains("apt install python3"));
    }

    /// 三家官方 .pkg 的地址从各自的版本索引里挑（2026-10 实际格式的节选）
    #[test]
    fn mac_pkg_urls_from_official_indexes() {
        let node = r#"[{"version":"v25.1.0","lts":false},{"version":"v24.11.1","lts":"Krypton"},{"version":"v22.21.1","lts":"Jod"}]"#;
        assert_eq!(
            mac_pkg_url("node", node).as_deref(),
            Some("https://nodejs.org/dist/v24.11.1/node-v24.11.1.pkg"),
            "取最新的 LTS，跳过 Current"
        );
        assert_eq!(mac_pkg_url("node", r#"[{"version":"v25.1.0","lts":false}]"#), None);
        let page = r#"<a href="https://www.python.org/ftp/python/3.15.0/python-3.15.0a1-macos11.pkg">3.15.0a1</a>
<a href="https://www.python.org/ftp/python/3.14.0/python-3.14.0-macos11.pkg">macOS 64-bit universal2 installer</a>
<a href="https://www.python.org/ftp/python/3.13.9/python-3.13.9-macos11.pkg">macOS</a>
<a href="https://www.python.org/ftp/python/3.9.13/python-3.9.13-macosx10.9.pkg">old</a>"#;
        assert_eq!(
            mac_pkg_url("python", page).as_deref(),
            Some("https://www.python.org/ftp/python/3.14.0/python-3.14.0-macos11.pkg"),
            "最高的正式版，预发布和旧式包名不算"
        );
        let quarto = r#"{"tag_name":"v1.8.25","assets":[
{"browser_download_url":"https://github.com/quarto-dev/quarto-cli/releases/download/v1.8.25/quarto-1.8.25-win.msi"},
{"browser_download_url":"https://github.com/quarto-dev/quarto-cli/releases/download/v1.8.25/quarto-1.8.25-macos.pkg"}]}"#;
        assert_eq!(
            mac_pkg_url("quarto", quarto).as_deref(),
            Some("https://github.com/quarto-dev/quarto-cli/releases/download/v1.8.25/quarto-1.8.25-macos.pkg")
        );
        assert_eq!(mac_pkg_url("git", "{}"), None);
        // 安装脚本只用位置参数，地址与路径不拼进脚本正文；提权由系统密码框完成
        assert!(MAC_PKG_SCRIPT.contains("\"$1\"") && MAC_PKG_SCRIPT.contains("\"$2\""));
        assert!(MAC_PKG_SCRIPT.contains("with administrator privileges"));
        assert!(!MAC_PKG_SCRIPT.contains("sudo"));
    }

    #[test]
    fn pip_installs_both_figure_libs_and_handles_pep668() {
        let plain = pip_args(false);
        assert!(plain.ends_with(&["pymupdf".to_string(), "pillow".to_string()]));
        assert!(!plain.contains(&"--user".to_string()));
        // PEP 668 连 --user 也拦，必须带 --break-system-packages
        let managed = pip_args(true);
        assert!(managed.contains(&"--user".to_string()));
        assert!(managed.contains(&"--break-system-packages".to_string()));
        assert!(managed.ends_with(&["pymupdf".to_string(), "pillow".to_string()]));
    }

    /// 手动跑：真弹一次 UAC，以管理员身份对本机全机 Python 跑 pip（已装就是 Requirement already satisfied）。
    /// `cargo test --lib pip_elevated_real -- --ignored --nocapture`
    #[cfg(windows)]
    #[test]
    #[ignore = "会弹 UAC，手动跑"]
    fn pip_elevated_real() {
        let python = usable_python().expect("有 Python");
        assert!(pip_needs_elevation(HostOs::Windows, &python, &program_files_roots()), "{python:?} 不是全机安装");
        let r = pip_elevated_with(&python, |t| print!("{t}"));
        println!("\n结果 {r:?}");
        let (ok, text) = r.expect("点了「是」才有日志");
        assert!(ok, "{text}");
        assert!(text.contains("pymupdf") && text.contains("pillow"), "{text}");
    }

    #[cfg(windows)]
    #[test]
    fn pip_elevates_only_for_program_files_python_on_windows() {
        let roots = [PathBuf::from(r"C:\Program Files"), PathBuf::from(r"C:\Program Files (x86)")];
        let machine = Path::new(r"C:\Program Files\Python313\python.exe");
        let per_user = Path::new(r"C:\Users\me\AppData\Local\Programs\Python\Python313\python.exe");
        assert!(pip_needs_elevation(HostOs::Windows, machine, &roots));
        assert!(!pip_needs_elevation(HostOs::Windows, per_user, &roots), "只装当前用户的照常装");
        assert!(!pip_needs_elevation(HostOs::Macos, machine, &roots));
        // 不是 Program Files 下的同名前缀目录
        assert!(!pip_needs_elevation(HostOs::Windows, Path::new(r"C:\Program Files2\py\python.exe"), &roots));
    }

    #[test]
    fn elevated_pip_script_logs_and_passes_exit_code() {
        let s = elevated_pip_script(Path::new(r"C:\Users\me\AppData\Roaming\ccode\tmp\pip-elevated-x\pip.log"));
        // 路径按 JSON 字符串转义进 Python（反斜杠成对）
        assert!(s.contains(r#"open("C:\\Users\\me\\AppData\\Roaming\\ccode\\tmp\\pip-elevated-x\\pip.log""#), "{s}");
        assert!(s.contains(r#"["-m","pip","install","--disable-pip-version-check","--no-input","pymupdf","pillow"]"#), "{s}");
        assert!(s.contains("sys.exit(r.returncode)"));
        assert_eq!(ps_quote(r"C:\it's\python.exe"), r"'C:\it''s\python.exe'");
    }

    #[test]
    fn winget_pins_node_to_machine_scope_only() {
        let node = winget_install_args("node", "OpenJS.NodeJS.LTS");
        assert!(node.windows(2).any(|w| w == ["--id", "OpenJS.NodeJS.LTS"]));
        assert!(node.windows(2).any(|w| w == ["--scope", "machine"]));
        let git = winget_install_args("git", "Git.Git");
        assert!(!git.contains(&"--scope".to_string()));
    }

    #[test]
    fn pymupdf_probe_prefers_new_import_name_and_skips_import_warnings() {
        // 新名优先、旧名兜底；版本取最后一行，导入时打出的弃用警告不当版本号
        assert_eq!(PYMUPDF_MODULES, &["pymupdf", "fitz"]);
        let script = module_version_script(PYMUPDF_MODULES);
        assert!(script.contains("for n in ['pymupdf', 'fitz']:"), "{script}");
        assert!(script.contains("raise SystemExit(1)"));
        let out = "warning: The `fitz` API is deprecated and will be removed in future.\nUse `import pymupdf` instead.\n1.28.2\n";
        assert_eq!(last_line(out).as_deref(), Some("1.28.2"));
        assert_eq!(last_line("\n  \n"), None);
    }

    #[test]
    fn python_stub_candidate_is_macos_usr_bin_python3_only() {
        assert!(is_python_stub_candidate(HostOs::Macos, Path::new("/usr/bin/python3")));
        assert!(!is_python_stub_candidate(HostOs::Macos, Path::new("/opt/homebrew/bin/python3")));
        assert!(!is_python_stub_candidate(HostOs::Windows, Path::new("/usr/bin/python3")));
    }

    #[test]
    fn dep_key_matches_event_suffix() {
        // 前端按 agent-update-output-dep-git / agent-update-done-dep-node 订阅
        assert_eq!(dep_key("git"), "dep-git");
        assert_eq!(dep_key("node"), "dep-node");
    }

    /// 本机冒烟（unix CI 上 git/node 至少其一如在 PATH 即被探到）：探测必须返回合法形状。
    /// macOS 上会真实跑 xcode-select -p（毫秒级），无 stub 环境误伤风险。
    #[cfg(unix)]
    #[test]
    fn check_dependencies_returns_valid_shape() {
        let dto = check_dependencies_sync().unwrap();
        assert!(["ok", "missing", "clt_stub"].contains(&dto.git.status.as_str()));
        assert!(["ok", "missing"].contains(&dto.node.status.as_str()));
        assert!(["brew", "winget", "xcode", "none"].contains(&dto.channel.as_str()));
        assert!(!dto.checked_at.is_empty());
        // status=ok 必有 path；missing 时 version/path 均空
        if dto.git.status == "ok" {
            assert!(dto.git.path.is_some());
        }
        if dto.git.status == "missing" {
            assert!(dto.git.version.is_none() && dto.git.path.is_none());
        }
    }
}
