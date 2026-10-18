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
/// 只有从新开的终端重启 Mesa 才清掉。
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
        "Quarto 本身没问题，是 Mesa 进程里的环境变量 {first}{more}指向已删除的路径（多半是卸载 conda 版 quarto 后留下的）；从新开的终端重启 Mesa 即可"
    ))
}

fn probe_python_module(module: &str) -> DepItemDto {
    let python = agents::resolve_binary("python3").or_else(|| agents::resolve_binary("python"));
    let Some(path) = python else {
        return missing_item();
    };
    // 顺带打印版本（设置页原先一律显示「版本未知」）：PIL 与新版 PyMuPDF 有 __version__，
    // 旧版 PyMuPDF 只有 VersionBind；都没有就空行，照旧算已安装
    let script = format!(
        "import {module} as m; print(getattr(m, '__version__', '') or getattr(m, 'VersionBind', ''))"
    );
    let child = crate::process::background_command(&path)
        .args(["-c", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(_) => return missing_item(),
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let mut out = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    use std::io::Read;
                    let _ = stdout.read_to_string(&mut out);
                }
                let version = out.lines().next().map(str::trim).filter(|v| !v.is_empty());
                return DepItemDto {
                    status: "ok".into(),
                    version: version.map(String::from),
                    path: Some(path.to_string_lossy().into_owned()),
                    note: None,
                };
            }
            Ok(Some(_)) => return missing_item(),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return missing_item();
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => return missing_item(),
        }
    }
}

/// 一键安装渠道判定（纯函数，可用性注入以便测试）：
/// macOS = 有 brew 走 brew，否则 git 走 xcode（node 无自动渠道，安装时按此报错）；
/// Windows = 有 winget 走 winget 否则 none；Linux = none（提示发行版包管理器）
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
    let pymupdf = probe_python_module("fitz");
    let pillow = probe_python_module("PIL");
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
            winget: "TectonicTypesetting.Tectonic",
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
        "pymupdf" => probe_python_module("fitz").status == "ok",
        "pillow" => probe_python_module("PIL").status == "ok",
        other => probe_named(other).status == "ok",
    }
}

/// 装完成功：失效探测缓存后再探一次。Python 库和 TeX 没有单一二进制版本号。
fn finish_install(tool: &str, ok: bool, output: String, method: &str) -> UpdateResultDto {
    let version_after = if ok {
        agents::invalidate_detect_cache();
        updater::invalidate_check_cache();
        if installed_after(tool) {
            match tool {
                "pymupdf" | "pillow" | "tex" => Some("已安装".into()),
                other => agents::resolve_binary(other)
                    .and_then(|p| agents::version_with_timeout(&p, agents::VERSION_QUERY_TIMEOUT))
                    .or(Some("已安装".into())),
            }
        } else {
            None
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

fn python_for_install() -> Option<std::path::PathBuf> {
    agents::resolve_binary("python3").or_else(|| agents::resolve_binary("python"))
}

fn pip_module(tool: &str) -> &'static str {
    if tool == "pillow" { "pillow" } else { "pymupdf" }
}

/// 拼图库走当前 python 的 pip。先普通装；本机禁止装进系统 Python 时再加 --user。
fn install_with_pip(app: &AppHandle, tool: &str) -> Result<UpdateResultDto, String> {
    let python = python_for_install().ok_or_else(|| {
        "未找到 Python：先安装 Python 3，再点「一键安装」".to_string()
    })?;
    let module = pip_module(tool);
    let program = python.to_string_lossy().into_owned();
    let plain = vec![
        "-m".into(),
        "pip".into(),
        "install".into(),
        "--disable-pip-version-check".into(),
        "--no-input".into(),
        module.into(),
    ];
    let (ok, output) = updater::run_streaming(app, &dep_key(tool), &program, &plain);
    if ok {
        return Ok(finish_install(tool, true, output, "pip"));
    }
    if output.contains("externally-managed-environment") {
        let mut args = plain.clone();
        args.push("--user".into());
        let (ok2, output2) = updater::run_streaming(app, &dep_key(tool), &program, &args);
        return Ok(finish_install(tool, ok2, output2, "pip"));
    }
    Ok(finish_install(tool, false, output, "pip"))
}

fn install_with_winget(app: &AppHandle, tool: &str, winget_id: &str) -> UpdateResultDto {
    let args = updater::winget_args("install", winget_id);
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
    if !has_brew || spec.brew.is_empty() {
        return Err(no_brew_msg(tool));
    }
    Ok(install_with_brew(app, tool, spec.brew, spec.brew_cask))
}

fn install_windows(app: &AppHandle, tool: &str) -> Result<UpdateResultDto, String> {
    if matches!(tool, "pymupdf" | "pillow") {
        return install_with_pip(app, tool);
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
        assert_eq!(install_spec("tex").winget, "TectonicTypesetting.Tectonic");
        assert_eq!(pip_module("pymupdf"), "pymupdf");
        assert_eq!(pip_module("pillow"), "pillow");
        assert!(install_spec("pymupdf").brew.is_empty());
        assert!(install_spec("pillow").winget.is_empty());
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
