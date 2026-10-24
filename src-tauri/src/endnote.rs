//! EndNote 出库：把项目 `references.bib` 转成 `papers/endnote-import.xml`。
//! 不写 EndNote 个人库，不触发 Word 插件。未选择 EndNote 交差则不生成。

use std::path::{Path, PathBuf};

const BRIDGE_PY: &str = include_str!("../resources/skills/endnote-bridge/scripts/bridge.py");

/// 按 references.bib 生成、交给 EndNote 的整库 RIS（gitignored）。检索清单那份 `endnote-import.ris` 另有人维护，不改写
const LIBRARY_RIS: &str = "endnote-library.ris";

/// 同步时顺手写的 EndNote 期刊术语表（全称、缩写 1/2/3，gitignored）：RIS 只有一格缩写，另一种写法放这里
const JOURNAL_TERMS: &str = "endnote-journals.txt";

/// 找真能跑的 Python（dep_check::usable_python）：Windows 上 `python3` 永远先命中应用商店
/// 占位程序，python.org 安装包又只提供 python.exe，按名字先找 python3 必然拿到占位
fn python_bin() -> Result<PathBuf, String> {
    crate::dep_check::usable_python().ok_or_else(|| {
        "本机找不到 python 3，无法生成 EndNote 导入文件（设置 → 诊断可一键安装 Python）".to_string()
    })
}

/// Python 子进程统一强制 UTF-8：中文 Windows 上 stdout 与 open() 默认编码是 cp936，
/// 读含中文的 UTF-8 bib 会 UnicodeDecodeError、输出成乱码。UTF-8 系统上是空操作
fn python_command(py: &Path) -> crate::process::BackgroundCommand {
    let mut cmd = crate::process::background_command(py);
    cmd.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8");
    cmd
}

/// 转换脚本的有界执行：离线转换给 2 分钟；--enrich 要逐条查 Crossref，给 10 分钟
fn bridge_timeout(enrich: bool) -> std::time::Duration {
    std::time::Duration::from_secs(if enrich { 600 } else { 120 })
}

fn wants_endnote_export(project_root: &Path) -> bool {
    let text =
        std::fs::read_to_string(project_root.join(".ccode/project.toml")).unwrap_or_default();
    text.contains("科研工具/libraryExport：endnote")
}

/// 离线转换，不访问 Crossref。定稿交差用它，避免收尾时被网络拖住。
pub fn export_if_configured(project_root: &Path) -> Result<Option<PathBuf>, String> {
    if !wants_endnote_export(project_root) {
        return Ok(None);
    }
    if !project_root.join("references.bib").is_file() {
        return Ok(None);
    }
    Ok(Some(export_xml(project_root)?))
}

fn run_bridge(
    py: &Path,
    script: &Path,
    bib: &Path,
    papers: &Path,
    stamp: &uuid::Uuid,
    kind: &str,
    dest: &Path,
    report: &Path,
    root: &Path,
) -> Result<String, String> {
    run_bridge_args(py, script, bib, papers, stamp, kind, dest, report, root, false)
}

fn run_bridge_args(
    py: &Path,
    script: &Path,
    bib: &Path,
    papers: &Path,
    stamp: &uuid::Uuid,
    kind: &str,
    dest: &Path,
    report: &Path,
    root: &Path,
    enrich: bool,
) -> Result<String, String> {
    run_bridge_terms(py, script, bib, papers, stamp, kind, dest, report, root, enrich, None)
}

/// 同 run_bridge_args，另可让 bridge 顺手写一份 EndNote 期刊术语表（`--journal-terms`）
fn run_bridge_terms(
    py: &Path,
    script: &Path,
    bib: &Path,
    papers: &Path,
    stamp: &uuid::Uuid,
    kind: &str,
    dest: &Path,
    report: &Path,
    root: &Path,
    enrich: bool,
    terms: Option<&Path>,
) -> Result<String, String> {
    let out_tmp = papers.join(format!(".ccode-endnote-{stamp}.{kind}"));
    let report_tmp = papers.join(format!(".ccode-endnote-{stamp}-{kind}.json"));
    let mut cmd = python_command(py);
    cmd.arg(script);
    if enrich {
        cmd.arg("--enrich");
    }
    cmd.arg("--input")
        .arg(bib)
        .arg("--output")
        .arg(&out_tmp)
        .arg("--report")
        .arg(&report_tmp)
        .current_dir(root);
    // 检索时人排除的篇不进导入文件（引文库里还留着检索前导进来、后来排除的条目；2026-10-23 HER）
    let included = papers.join("included.json");
    if let Some(terms) = terms {
        cmd.arg("--journal-terms").arg(terms);
    }
    if included.is_file() {
        cmd.arg("--skip-excluded").arg(&included);
    }
    let out = crate::process::capture_command(&mut cmd, bridge_timeout(enrich), 1024 * 1024)
        .map_err(|e| format!("无法启动转换: {e}"))?;
    let success = !out.timed_out && out.status.is_some_and(|s| s.success());
    if !success {
        let _ = std::fs::remove_file(&out_tmp);
        let _ = std::fs::remove_file(&report_tmp);
        if out.timed_out {
            return Err("生成 EndNote 导入文件超时，已中止".into());
        }
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        return Err(if err.is_empty() {
            "生成 EndNote 导入文件失败".into()
        } else {
            err.to_string()
        });
    }
    crate::storage::replace(&out_tmp, dest)?;
    if kind == "xml" {
        crate::storage::replace(&report_tmp, report)?;
    } else {
        let _ = std::fs::remove_file(&report_tmp);
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 人指定的 EndNote 库路径（papers/endnote-library.path，一行）。没有或不止一行就 None。
fn endnote_library_pointer(root: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(root.join("papers/endnote-library.path")).ok()?;
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect();
    if lines.len() != 1 {
        return None;
    }
    Some(PathBuf::from(crate::sessions::expand_tilde(&lines[0].to_string())))
}

/// 同步按钮只需要 RIS。不再连写 XML 和 ENW，也不等 EndNote 把文件导完。
/// 写 `papers/endnote-library.ris`（gitignored），不碰检索清单那份 `endnote-import.ris`——
/// 那份是 lit_records.py / Mesa 纳入时维护的纳入篇题录，进 git；同步整份改写它，主仓就带着
/// 一个改了没提交的清单文件，开下一步时被开工确认拦下（2026-10-23 HER 实证）。
/// 返回 (RIS 路径, 提示)：排除不导的篇数、库体检（检出旧版导出的脏记录时提示先删再导）。
pub fn export_ris_only(project_root: &Path) -> Result<(PathBuf, String), String> {
    let root =
        crate::paths::canonicalize_plain(project_root).map_err(|e| format!("项目目录无效: {e}"))?;
    let bib = root.join("references.bib");
    if !bib.is_file() {
        return Err("还没有 references.bib，没法生成 EndNote 导入文件".into());
    }
    let papers = root.join("papers");
    std::fs::create_dir_all(&papers).map_err(|e| format!("无法创建 papers/: {e}"))?;
    let ris = papers.join(LIBRARY_RIS);
    let report = papers.join("endnote-report.json");
    let stamp = uuid::Uuid::new_v4();
    let script = std::env::temp_dir().join(format!("ccode-endnote-bridge-{stamp}.py"));
    crate::storage::atomic_write(&script, BRIDGE_PY.as_bytes(), true)?;
    let abbr = script.with_file_name("journal-abbreviations.csv");
    crate::storage::atomic_write(
        &abbr,
        include_bytes!("../resources/journal-abbreviations.csv"),
        true,
    )?;
    let py = python_bin()?;
    // 从 Zotero / EndNote 导进引文库的老条目常缺摘要、ISSN、日期：有 DOI 的先按 Crossref / OpenAlex 补到
    // 这次导出的临时副本里（引文库不动；字段已齐的不联网；补不成照原样导，不挡同步）
    let enriched = papers.join(format!(".ccode-endnote-{stamp}.bib"));
    let (source, filled) = match run_bridge_args(
        &py, &script, &bib, &papers, &stamp, "bib", &enriched, &report, &root, true,
    ) {
        Ok(note) if enriched.is_file() => (enriched.clone(), note),
        _ => {
            let _ = std::fs::remove_file(&enriched);
            (bib.clone(), String::new())
        }
    };
    let terms = papers.join(JOURNAL_TERMS);
    let dropped = run_bridge_terms(
        &py, &script, &source, &papers, &stamp, "ris", &ris, &report, &root, false, Some(&terms),
    );
    if source != bib {
        let _ = std::fs::remove_file(&source);
    }
    let dropped = dropped?;
    // 库体检（只读）：人指定了库就顺手查一遍旧版导出的脏记录，并进按钮反馈
    let mut health = String::new();
    if let Some(enl) = endnote_library_pointer(&root) {
        let matcher = script.with_file_name("library_match.py");
        if crate::storage::atomic_write(
            &matcher,
            include_str!("../resources/skills/endnote-bridge/scripts/library_match.py").as_bytes(),
            true,
        )
        .is_ok()
        {
            let mut check = python_command(&py);
            check
                .arg(&script)
                .arg("--check-endnote-library")
                .arg(&enl);
            if let Ok(out) = crate::process::capture_command(
                &mut check,
                std::time::Duration::from_secs(60),
                1024 * 1024,
            ) {
                if !out.timed_out && out.status.is_some_and(|s| s.success()) {
                    health = String::from_utf8_lossy(&out.stdout).trim().to_string();
                }
            }
            let _ = std::fs::remove_file(&matcher);
        }
    }
    let _ = std::fs::remove_file(&script);
    let _ = std::fs::remove_file(&abbr);
    if !ris.is_file() {
        return Err(format!("转换结束但没有 papers/{LIBRARY_RIS}"));
    }
    // 有刊给了两种缩写才提一句（术语表每次都写，平常不打扰）
    let has_alt = std::fs::read_to_string(&terms).is_ok_and(|text| {
        text.lines().any(|line| {
            let cols: Vec<&str> = line.split('\t').collect();
            cols.len() >= 3 && cols[1] != cols[2]
        })
    });
    let terms_note = if has_alt {
        format!(
            "期刊两种缩写（如 Appl. Catal., B 与 ISO 4 的 Appl. Catal. B Environ.）在 papers/{JOURNAL_TERMS}：\
             EndNote「工具 → 打开术语表 → 期刊术语表 → 列表 → 导入列表」导入一次，样式里选缩写 1 / 缩写 2 就能切换。"
        )
    } else {
        String::new()
    };
    let note = [filled, dropped, terms_note, health]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Ok((ris, note))
}

pub fn export_xml(project_root: &Path) -> Result<PathBuf, String> {
    export_xml_with(project_root, false)
}

/// 按 DOI 向 Crossref 补全后再生成。只在人点「同步到 EndNote」时用。
pub fn export_xml_enriched(project_root: &Path) -> Result<PathBuf, String> {
    export_xml_with(project_root, true)
}

fn export_xml_with(project_root: &Path, enrich: bool) -> Result<PathBuf, String> {
    let root =
        crate::paths::canonicalize_plain(project_root).map_err(|e| format!("项目目录无效: {e}"))?;
    let bib = root.join("references.bib");
    if !bib.is_file() {
        return Err("还没有 references.bib，没法生成 EndNote 导入文件".into());
    }
    let papers = root.join("papers");
    std::fs::create_dir_all(&papers).map_err(|e| format!("无法创建 papers/: {e}"))?;
    let xml = papers.join("endnote-import.xml");
    let ris = papers.join(LIBRARY_RIS);
    let report = papers.join("endnote-report.json");
    let stamp = uuid::Uuid::new_v4();
    let script = std::env::temp_dir().join(format!("ccode-endnote-bridge-{stamp}.py"));
    crate::storage::atomic_write(&script, BRIDGE_PY.as_bytes(), true)?;
    let abbr = script.with_file_name("journal-abbreviations.csv");
    crate::storage::atomic_write(
        &abbr,
        include_bytes!("../resources/journal-abbreviations.csv"),
        true,
    )?;
    let py = python_bin()?;
    let enw = papers.join("endnote-import.enw");
    // 有 DOI 的条目先按 Crossref 补作者全名、期刊、卷期页、ISSN、摘要。
    // 补全失败则用原 bib，不挡住导入。
    let enriched = papers.join(format!(".ccode-endnote-{stamp}.bib"));
    let source = if !enrich {
        bib.clone()
    } else {
        match run_bridge_args(
        &py, &script, &bib, &papers, &stamp, "bib", &enriched, &report, &root, true,
    ) {
        Ok(_) if enriched.is_file() => enriched.clone(),
        _ => {
            let _ = std::fs::remove_file(&enriched);
            bib.clone()
        }
    }
    };
    run_bridge(
        &py, &script, &source, &papers, &stamp, "xml", &xml, &report, &root,
    )?;
    run_bridge(
        &py, &script, &source, &papers, &stamp, "ris", &ris, &report, &root,
    )?;
    run_bridge(
        &py, &script, &source, &papers, &stamp, "enw", &enw, &report, &root,
    )?;
    let _ = std::fs::remove_file(&script);
    let _ = std::fs::remove_file(script.with_file_name("journal-abbreviations.csv"));
    if source != bib {
        let _ = std::fs::remove_file(&source);
    }
    if !xml.is_file() {
        return Err("转换结束但没有 papers/endnote-import.xml".into());
    }
    Ok(xml)
}

/// 不写死版本号或本机路径。macOS 先问 Launch Services（刚装完拖进「应用程序」就会登记），
/// 再扫常见安装目录；Windows 先问注册表（装在 D 盘这类非默认目录时只有它知道），再扫 Program Files 下名字带 EndNote 的文件夹。
fn find_endnote_app() -> Option<PathBuf> {
    let mut apps = Vec::new();
    #[cfg(target_os = "macos")]
    apps.extend(mdfind_endnote_apps());
    #[cfg(windows)]
    apps.extend(registry_endnote_apps());
    apps.extend(scan_endnote_install_dirs());
    apps.sort_by(|a, b| {
        b.file_name()
            .unwrap_or_default()
            .cmp(a.file_name().unwrap_or_default())
    });
    apps.into_iter().find(|p| is_endnote_bundle(p))
}

#[cfg(target_os = "macos")]
fn mdfind_endnote_apps() -> Vec<PathBuf> {
    let queries = [
        r#"kMDItemCFBundleIdentifier == "com.ThomsonResearchSoft.EndNote""#,
        r#"kMDItemCFBundleIdentifier == "*endnote*"c"#,
    ];
    let mut out = Vec::new();
    for query in queries {
        let Ok(result) = crate::process::background_command("mdfind")
            .arg(query)
            .output()
        else {
            continue;
        };
        if !result.status.success() {
            continue;
        }
        for line in String::from_utf8_lossy(&result.stdout).lines() {
            let path = PathBuf::from(line.trim());
            if is_plausible_endnote_app(&path) {
                out.push(path);
            }
        }
        if !out.is_empty() {
            break;
        }
    }
    out
}

/// Windows 注册表里登记的 EndNote：安装包写的 App Paths、「.enw 用 EndNote 打开」的命令、
/// ISI ResearchSoft 下各版本的安装目录（CFDIR）。2026-10-23 用户实测：EndNote 装在 D:\applications\Endnote，
/// 只扫 Program Files 找不到，「同步到 EndNote」就只剩一句「拖到图标上」。只读注册表。
#[cfg(windows)]
fn registry_endnote_apps() -> Vec<PathBuf> {
    use crate::process::{command_line_exe, reg_string, reg_sz_value};
    let mut out = Vec::new();
    for hive in ["HKLM", "HKCU"] {
        let key = format!(r"{hive}\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\EndNote.exe");
        if let Some(value) = reg_string(&key, None) {
            out.push(PathBuf::from(value.trim_matches('"')));
        }
    }
    if let Some(command) = reg_string(r"HKCR\EndNotePlus.ENW\shell\open\command", None) {
        out.extend(command_line_exe(&command));
    }
    for key in [
        r"HKLM\SOFTWARE\WOW6432Node\ISI ResearchSoft\EndNote",
        r"HKLM\SOFTWARE\ISI ResearchSoft\EndNote",
    ] {
        let Ok(result) = crate::process::background_command("reg")
            .args(["query", key, "/s", "/v", "CFDIR"])
            .output()
        else {
            continue;
        };
        for line in String::from_utf8_lossy(&result.stdout).lines() {
            if !line.trim_start().starts_with("CFDIR") {
                continue;
            }
            if let Some(dir) = reg_sz_value(line) {
                out.push(PathBuf::from(dir.trim_matches('"')).join("EndNote.exe"));
            }
        }
    }
    out.retain(|path| path.is_file());
    out
}

fn scan_endnote_install_dirs() -> Vec<PathBuf> {
    let mut apps = Vec::new();
    // 显式标注：push 都在 macos/windows 的 cfg 块里，Linux 上两块都不编译、推断不出元素类型
    let mut roots: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        roots.push(PathBuf::from("/Applications"));
        if let Some(home) = dirs::home_dir() {
            roots.push(home.join("Applications"));
        }
    }
    #[cfg(windows)]
    {
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(pf) = std::env::var_os(key) {
                roots.push(PathBuf::from(pf));
            }
        }
    }
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !name_has_endnote(&path) {
                continue;
            }
            if is_endnote_bundle(&path) {
                apps.push(path);
                continue;
            }
            if !path.is_dir() {
                continue;
            }
            let Ok(inner) = std::fs::read_dir(&path) else {
                continue;
            };
            for child in inner.flatten() {
                let child_path = child.path();
                if name_has_endnote(&child_path) && is_endnote_bundle(&child_path) {
                    apps.push(child_path);
                }
            }
        }
    }
    apps
}

fn name_has_endnote(path: &Path) -> bool {
    path.file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase().contains("endnote"))
        .unwrap_or(false)
}

fn is_plausible_endnote_app(path: &Path) -> bool {
    if !path.exists() || !name_has_endnote(path) || !is_endnote_bundle(path) {
        return false;
    }
    let skip = ["downloads", "logs", "library/logs"];
    let lowered = path.to_string_lossy().to_ascii_lowercase();
    !skip.iter().any(|s| lowered.contains(s))
}

fn is_endnote_bundle(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        path.extension().is_some_and(|e| e == "app")
    }
    #[cfg(windows)]
    {
        path.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = path;
        false
    }
}

fn copy_to_downloads(src: &Path, name: &str) -> Option<PathBuf> {
    let dest = dirs::download_dir()?.join(name);
    std::fs::copy(src, &dest).ok()?;
    Some(dest)
}

fn copy_path_to_clipboard(path: &Path) {
    let text = path.to_string_lossy().into_owned();
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        use std::process::Stdio;
        if let Ok(mut child) = crate::process::background_command("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        }
    }
    #[cfg(windows)]
    {
        use std::io::Write;
        use std::process::Stdio;
        if let Ok(mut child) = crate::process::background_command("clip")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(&clip_utf16_payload(&text));
            }
            // clip 读到 EOF 即退；有界等待，卡住就杀，不钉死调用线程
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) | Err(_) => break,
                    Ok(None) if std::time::Instant::now() >= deadline => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
                }
            }
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (path, text);
    }
}

/// clip.exe 按 ANSI 代码页（中文系统 GBK）解读 stdin，直接喂 UTF-8 会把中文路径变乱码；
/// 带 BOM 的 UTF-16LE 它按 Unicode 收
#[cfg(any(windows, test))]
fn clip_utf16_payload(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

fn launch_endnote_with_file(file: &Path) -> Result<(), String> {
    let app = find_endnote_app().ok_or_else(|| {
        "找不到 EndNote。".to_string()
    })?;
    #[cfg(target_os = "macos")]
    {
        // `open -a App file` 等于把文件拖到应用程序图标上。
        crate::process::background_command("open")
            .arg("-a")
            .arg(&app)
            .arg(file)
            .spawn()
            .map_err(|e| format!("没法打开 EndNote: {e}"))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        // 只拉起不等待：EndNote 原本没开时，等它的退出码要等到用户关掉 EndNote，
        // 且关闭时的非零退出码会被误报成同步失败。句柄丢弃即脱离，进程照常运行
        crate::process::background_command(&app)
            .arg(file)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("没法打开 EndNote: {e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, file);
        Err("这个系统上没有 EndNote 桌面版可交。".into())
    }
}

/// 项目根或当前步骤工作区里已经写好的导入文件。同步不重新检索。
fn find_import_ris(project_root: &Path) -> Option<PathBuf> {
    let direct = project_root.join("papers/endnote-import.ris");
    if direct.is_file() {
        return Some(direct);
    }
    let conn = crate::workspaces::db().ok()?;
    let rows = crate::workspaces::query_workspaces(&conn).ok()?;
    let root_key = crate::paths::path_key(&project_root.to_string_lossy());
    let mut found = Vec::new();
    for row in rows {
        if crate::paths::path_key(&row.repo_path) != root_key {
            continue;
        }
        if row.status == "archived" {
            continue;
        }
        let ris = Path::new(&row.worktree_path).join("papers/endnote-import.ris");
        if ris.is_file() {
            found.push((row.created_at, ris));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().next().map(|(_, path)| path)
}

/// 「选这个 EndNote 库」的候选：EndNote 最近打开过的库（Windows 读它自己的
/// `HKCU\Software\ISI ResearchSoft\EndNote\Recent Libraries\File1…`，File1 最近），再补上文稿 / 桌面
/// 顶层与「文稿/EndNote」里的 .enl。只列给人点，不替人挑；不深扫磁盘（2026-10-24 用户：点了是打开文件夹，
/// 不知道选哪个——文件对话框里 .enl 旁边还有同名的 .Data 文件夹，很容易点错）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndnoteLibraryChoice {
    pub path: String,
    pub name: String,
    /// 来自 EndNote 最近打开的库
    pub recent: bool,
    /// EndNote X9 及更早的库：记录在同名 .Data/rdb，脚本读不了，要人先导出 XML
    pub legacy: bool,
}

/// .enl 是不是 X9 及更早的格式（同名 .Data 下有 rdb）。这种库脚本读不到记录（2026-10-24 HER：「file is not a database」）
fn is_legacy_library(path: &Path) -> bool {
    path.with_extension("Data").join("rdb").is_dir()
}

/// 指定的库是不是 X9 老格式：界面据此提示「先在 EndNote 里导出 XML」
#[tauri::command]
pub async fn endnote_library_legacy(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(crate::sessions::expand_tilde(&path));
        Ok(p.extension().is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("enl")) && is_legacy_library(&p))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn endnote_library_choices() -> Result<Vec<EndnoteLibraryChoice>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut dirs_to_look = Vec::new();
        for base in [dirs::document_dir(), dirs::desktop_dir()].into_iter().flatten() {
            dirs_to_look.push(base.join("EndNote"));
            dirs_to_look.push(base);
        }
        Ok(library_choices(recent_library_paths(), &dirs_to_look))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn library_choices(recent: Vec<String>, dirs_to_look: &[PathBuf]) -> Vec<EndnoteLibraryChoice> {
    let mut out: Vec<EndnoteLibraryChoice> = Vec::new();
    let mut push = |path: PathBuf, recent: bool| {
        if !path.is_file()
            || !path
                .extension()
                .is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("enl"))
        {
            return;
        }
        let shown = crate::paths::strip_verbatim(path.clone())
            .to_string_lossy()
            .into_owned();
        if out.iter().any(|c| crate::paths::same_path(&c.path, &shown)) {
            return;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let legacy = is_legacy_library(&path);
        out.push(EndnoteLibraryChoice { path: shown, name, recent, legacy });
    };
    for raw in recent {
        push(PathBuf::from(raw.trim()), true);
    }
    for dir in dirs_to_look {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        let mut found: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        found.sort();
        for path in found {
            push(path, false);
        }
    }
    out
}

#[cfg(windows)]
fn recent_library_paths() -> Vec<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let key: Vec<u16> = "Software\\ISI ResearchSoft\\EndNote\\Recent Libraries"
        .encode_utf16()
        .chain([0])
        .collect();
    (1..=20)
        .filter_map(|i| {
            let name: Vec<u16> = format!("File{i}").encode_utf16().chain([0]).collect();
            let mut size: u32 = 0;
            // 先问长度再取值；REG_SZ 按 UTF-16 读，中文路径不走控制台代码页（reg query 会出乱码）
            let rc = unsafe {
                RegGetValueW(
                    HKEY_CURRENT_USER,
                    key.as_ptr(),
                    name.as_ptr(),
                    RRF_RT_REG_SZ,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut size,
                )
            };
            if rc != 0 || size < 2 {
                return None;
            }
            let mut buf = vec![0u16; (size as usize).div_ceil(2)];
            let rc = unsafe {
                RegGetValueW(
                    HKEY_CURRENT_USER,
                    key.as_ptr(),
                    name.as_ptr(),
                    RRF_RT_REG_SZ,
                    std::ptr::null_mut(),
                    buf.as_mut_ptr().cast(),
                    &mut size,
                )
            };
            if rc != 0 {
                return None;
            }
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..len]))
        })
        .collect()
}

/// macOS / Linux 没有登记表可读：只靠文稿 / 桌面里的 .enl，读不到就让人在对话框里选
#[cfg(not(windows))]
fn recent_library_paths() -> Vec<String> {
    Vec::new()
}

#[tauri::command]
pub async fn endnote_export_xml(project_root: String) -> Result<String, String> {
    // 转换和打开 EndNote 都在后台线程，不占界面。
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::sessions::expand_tilde(&project_root);
        let root_path = Path::new(&root);
        // 精读之后同步：有引文库就按它生成整库 RIS（endnote-library.ris）；还没有引文库（检索步）才交检索清单那份。
        let (ris, health) = if root_path.join("references.bib").is_file() {
            export_ris_only(root_path)?
        } else {
            let Some(ris) = find_import_ris(root_path) else {
                return Err(
                    "还没有 papers/endnote-import.ris。检索保存进项目后才会有这一份，同步只打开它，不再重新检索。"
                        .into(),
                );
            };
            (ris, String::new())
        };
        let shown = ris
            .file_name()
            .map(|n| format!("papers/{}", n.to_string_lossy()))
            .unwrap_or_else(|| ris.display().to_string());
        copy_path_to_clipboard(&ris);
        let health_note = if health.is_empty() {
            String::new()
        } else {
            format!("\n\n{health}")
        };
        match launch_endnote_with_file(&ris) {
            // 每次同步都是整份导入：同一个库点两次就是两份（2026-10-24 HER：27 篇里 18 篇在库里有 3 条，
            // Word 里 Update 后只有 8 条挂上库）。导完提醒去重，并引向「选这个 EndNote 库」
            Ok(()) => Ok(format!(
                "已交给 EndNote，导入当前打开的库。PDF 用「打开 papers」拖到对应条目。\
                 每次同步都会把全部文献再导一遍：同一个库以前导过的，导完在 EndNote 用 References → Find Duplicates 去重，\
                 不然定稿的 EndNote 版 Word 对不上这些条目。导完点下面「选这个 EndNote 库」指一下用的是哪个库。{health_note}"
            )),
            Err(e) => Ok(format!(
                "文件在 {shown}。把它拖到 EndNote 图标上（不要拖进窗口）。{e}{health_note}"
            )),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_choices_list_recent_first_then_folders_without_duplicates_or_data_dirs() {
        let dir = std::env::temp_dir().join(format!("ccode-enl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("我的EndNote库.Data")).unwrap();
        std::fs::write(dir.join("我的EndNote库.enl"), b"x").unwrap();
        std::fs::write(dir.join("旧库.enl"), b"x").unwrap();
        std::fs::write(dir.join("说明.txt"), b"x").unwrap();
        let gone = dir.join("已删除.enl");
        let recent = vec![
            dir.join("我的EndNote库.enl").to_string_lossy().into_owned(),
            gone.to_string_lossy().into_owned(),
        ];
        let got = library_choices(recent, &[dir.clone()]);
        let names: Vec<(&str, bool)> = got.iter().map(|c| (c.name.as_str(), c.recent)).collect();
        // 最近打开的排前、只出一次；不存在的不列；.Data 文件夹和别的文件不列
        assert_eq!(names, vec![("我的EndNote库.enl", true), ("旧库.enl", false)]);
        // 同名 .Data 下有 rdb = X9 老格式
        std::fs::create_dir_all(dir.join("我的EndNote库.Data").join("rdb")).unwrap();
        let again = library_choices(vec![], &[dir.clone()]);
        assert!(again.iter().find(|c| c.name == "我的EndNote库.enl").unwrap().legacy);
        assert!(!again.iter().find(|c| c.name == "旧库.enl").unwrap().legacy);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// clip.exe 吃带 BOM 的 UTF-16LE；中文路径逐码元小端写入
    #[test]
    fn clip_payload_is_utf16le_with_bom() {
        assert_eq!(
            clip_utf16_payload(r"C:\文献\a.ris"),
            [
                0xFF, 0xFE, b'C', 0, b':', 0, b'\\', 0, 0x87, 0x65, 0x2E, 0x73, b'\\', 0, b'a', 0,
                b'.', 0, b'r', 0, b'i', 0, b's', 0
            ]
        );
    }

    /// 中文条目必须原样进 RIS：中文 Windows 上 Python 默认 cp936，靠 PYTHONUTF8 兜住
    #[test]
    fn chinese_entries_survive_conversion() {
        let dir = std::env::temp_dir().join(format!("ccode-endnote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("papers")).unwrap();
        std::fs::write(
            dir.join("references.bib"),
            "@article{c,\n  title = {镁电池穿梭效应研究},\n  author = {张, 三},\n  year = {2025},\n  journal = {化学学报},\n}\n",
        )
        .unwrap();
        let ris = export_ris_only(&dir);
        let text = std::fs::read_to_string(dir.join("papers/endnote-library.ris")).ok();
        let _ = std::fs::remove_dir_all(&dir);
        if ris.as_ref().is_err_and(|e| e.contains("找不到 python")) {
            return;
        }
        ris.expect("ris export");
        let text = text.expect("ris");
        assert!(text.contains("镁电池穿梭效应研究"), "{text}");
        assert!(text.contains("化学学报"), "{text}");
    }

    /// 同步写整库 RIS（endnote-library.ris），不改写检索清单那份 endnote-import.ris；检索时排除的篇不导
    #[test]
    fn sync_writes_library_ris_and_skips_excluded() {
        let dir = std::env::temp_dir().join(format!("ccode-endnote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("papers")).unwrap();
        std::fs::write(
            dir.join("references.bib"),
            "@article{keep,\n  title = {【7】Kept paper on MoS2},\n  author = {Doe, Jane},\n  year = {2024},\n  journal = {Applied Catalysis B: Environmental},\n  journalabbreviation = {Appl. Catal., B},\n}\n\n@article{gone,\n  title = {Excluded boride paper},\n  author = {Roe, John},\n  year = {2020},\n}\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("papers/included.json"),
            r#"[{"id":"A","title":"Kept paper on MoS2","decision":"included","reason":""},{"id":"B","title":"Excluded boride paper","decision":"excluded","reason":""}]"#,
        )
        .unwrap();
        std::fs::write(dir.join("papers/endnote-import.ris"), "TY  - JOUR\r\nTI  - Kept paper\r\nER  - \r\n").unwrap();
        let out = export_ris_only(&dir);
        let library = std::fs::read_to_string(dir.join("papers/endnote-library.ris")).ok();
        let terms = std::fs::read_to_string(dir.join("papers/endnote-journals.txt")).ok();
        let canonical = std::fs::read_to_string(dir.join("papers/endnote-import.ris")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        if out.as_ref().is_err_and(|e| e.contains("找不到 python")) {
            return;
        }
        let (path, note) = out.expect("ris export");
        assert!(path.ends_with("papers/endnote-library.ris"));
        let library = library.expect("library ris");
        // 题名编号前缀去掉、式子收成下标；排除的不导
        assert!(library.contains("TI  - Kept paper on MoS₂\r\n"), "{library}");
        assert!(library.contains("J2  - Appl. Catal., B\r\n"), "{library}");
        assert!(!library.contains("Excluded boride paper"), "{library}");
        assert!(note.contains("排除的 1 篇不导"), "{note}");
        // 两种缩写进期刊术语表（缩写 1 = J2，缩写 2 = ISO 4），反馈里提一句怎么导入
        let terms = terms.expect("journal terms");
        assert!(
            terms.contains("Applied Catalysis B: Environmental\tAppl. Catal., B\tAppl. Catal. B Environ.\t"),
            "{terms}"
        );
        assert!(note.contains("endnote-journals.txt"), "{note}");
        assert_eq!(canonical, "TY  - JOUR\r\nTI  - Kept paper\r\nER  - \r\n", "检索清单那份不动");
    }

    #[test]
    fn quoted_shuttle_is_not_tex_accent() {
        let dir = std::env::temp_dir().join(format!("ccode-endnote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".ccode")).unwrap();
        std::fs::write(
            dir.join("references.bib"),
            r#"@article{a,
  title = "solving the \"shuttle effect\" in magnesium",
  author = {Doe, Jane},
  year = {2024},
  journal = {J},
}
"#,
        )
        .unwrap();
        let xml = export_xml(&dir);
        let text = xml
            .as_ref()
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok());
        let _ = std::fs::remove_dir_all(&dir);
        if xml.is_err() && xml.as_ref().unwrap_err().contains("找不到 python") {
            return;
        }
        let text = text.expect("xml");
        assert!(text.contains("shuttle effect"), "{text}");
    }

    #[test]
    fn flips_given_family_authors_in_ris() {
        let dir = std::env::temp_dir().join(format!("ccode-endnote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("papers")).unwrap();
        std::fs::write(
            dir.join("references.bib"),
            r#"@article{b,
  title = {Given family names must flip},
  author = {Jinlong Hu and R. Jurgan Behm and Doe, Jane and Smith JM},
  year = {2026},
  journal = {J},
}
"#,
        )
        .unwrap();
        let xml = export_xml(&dir);
        let ris = std::fs::read_to_string(dir.join("papers/endnote-library.ris")).ok();
        let _ = std::fs::remove_dir_all(&dir);
        if xml.is_err() && xml.as_ref().unwrap_err().contains("找不到 python") {
            return;
        }
        let ris = ris.expect("ris");
        assert!(ris.contains("AU  - Hu, Jinlong"), "{ris}");
        assert!(ris.contains("AU  - Behm, R. Jurgan"), "{ris}");
        assert!(ris.contains("AU  - Doe, Jane"), "{ris}");
        assert!(ris.contains("AU  - Smith, JM"), "{ris}");
        assert!(
            !ris.lines().any(|line| line.starts_with("AU  - ") && line.matches(',').count() > 1),
            "{ris}"
        );
    }

    #[test]
    fn ris_carries_journal_issue_pages_abstract_and_abbreviation() {
        let dir = std::env::temp_dir().join(format!("ccode-endnote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("papers")).unwrap();
        std::fs::write(
            dir.join("references.bib"),
            r#"@article{c,
  title = {Full record},
  author = {Zhang, Caicai and Xu, Ao},
  year = {2024},
  date = {October 30, 2024},
  journal = {Journal of Alloys and Compounds},
  journalabbreviation = {J Alloy Compd},
  articletype = {Journal Article},
  volume = {1010},
  pages = {177309},
  issn = {0925-8388},
  doi = {10.1016/j.jallcom.2024.177309},
  abstract = {Sulfur rich spheres.},
  keywords = {Magnesium; Sulfur},
  epubdate = {October 30, 2024},
  url = {https://doi.org/10.1016/j.jallcom.2024.177309},
}
"#,
        )
        .unwrap();
        let xml = export_xml(&dir);
        let ris = std::fs::read_to_string(dir.join("papers/endnote-library.ris")).ok();
        let xml_text = std::fs::read_to_string(dir.join("papers/endnote-import.xml")).ok();
        let _ = std::fs::remove_dir_all(&dir);
        if xml.is_err() && xml.as_ref().unwrap_err().contains("找不到 python") {
            return;
        }
        let ris = ris.expect("ris");
        for line in [
            "AU  - Zhang, Caicai",
            "AU  - Xu, Ao",
            "T2  - Journal of Alloys and Compounds",
            "J2  - J Alloy Compd",
            "VL  - 1010",
            "SP  - 177309",
            "M2  - 177309",
            "M3  - Journal Article",
            "DA  - October 30, 2024",
            "ET  - October 30, 2024",
            "SN  - 0925-8388",
            "AB  - Sulfur rich spheres.",
            "KW  - Magnesium",
            "KW  - Sulfur",
        ] {
            assert!(ris.contains(line), "{line} missing in {ris}");
        }
        assert!(!ris.contains("IS  -"), "{ris}");
        let xml_text = xml_text.expect("xml");
        assert!(xml_text.contains("<abbr-1>J Alloy Compd</abbr-1>"), "{xml_text}");
        assert!(xml_text.contains("<alt-title>J Alloy Compd</alt-title>"), "{xml_text}");
        assert!(xml_text.contains("<volume>1010</volume>"), "{xml_text}");
        assert!(xml_text.contains("Sulfur rich spheres."), "{xml_text}");
    }

    #[test]
    fn finds_endnote_app_if_installed() {
        let Some(app) = find_endnote_app() else {
            return;
        };
        assert!(
            app.to_string_lossy()
                .to_ascii_lowercase()
                .contains("endnote"),
            "{}",
            app.display()
        );
        assert!(is_endnote_bundle(&app));
    }
}
