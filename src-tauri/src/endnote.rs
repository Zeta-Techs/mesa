//! EndNote 出库：把项目 `references.bib` 转成 `papers/endnote-import.xml`。
//! 不写 EndNote 个人库，不触发 Word 插件。未选择 EndNote 交差则不生成。

use std::path::{Path, PathBuf};

const BRIDGE_PY: &str = include_str!("../resources/skills/endnote-bridge/scripts/bridge.py");
const CITE_DOCX_PY: &str = include_str!("../resources/skills/endnote-bridge/scripts/cite_docx.py");
const ZOTERO_DOCX_PY: &str = include_str!("../resources/skills/zotero-sync/scripts/zotero_docx.py");
const LIBRARY_MATCH_PY: &str =
    include_str!("../resources/skills/endnote-bridge/scripts/library_match.py");

/// 按 references.bib 生成、交给 EndNote 的整库 RIS / XML（均 gitignored）。检索清单那份 `endnote-import.ris` 另有人维护，不改写
const LIBRARY_RIS: &str = "endnote-library.ris";
const LIBRARY_XML: &str = "endnote-library.xml";

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
    run_bridge_terms(py, script, bib, papers, stamp, kind, dest, report, root, enrich, None, None)
}

/// 同 run_bridge_args，另可让 bridge 顺手写一份 EndNote 期刊术语表（`--journal-terms`），
/// 并按 library_attach 写的那份 JSON 给条目挂全文与笔记（`--attach`，「同步到文献库」三档）
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
    attach: Option<&Path>,
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
    if let Some(attach) = attach {
        cmd.arg("--attach").arg(attach);
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
pub fn export_ris_only(
    project_root: &Path,
    mode: crate::library_attach::AttachMode,
) -> Result<(PathBuf, String), String> {
    let root =
        crate::paths::canonicalize_plain(project_root).map_err(|e| format!("项目目录无效: {e}"))?;
    let bib = root.join("references.bib");
    if !bib.is_file() {
        return Err("还没有 references.bib，没法生成 EndNote 导入文件".into());
    }
    let papers = root.join("papers");
    std::fs::create_dir_all(&papers).map_err(|e| format!("无法创建 papers/: {e}"))?;
    crate::projects::exclude_in_git(&root, "/papers/endnote-library.ris");
    crate::projects::exclude_in_git(&root, "/papers/endnote-library.xml");
    crate::projects::exclude_in_git(&root, "/papers/endnote-journals.txt");
    let ris = papers.join(LIBRARY_RIS);
    let xml = papers.join(LIBRARY_XML);
    let report = std::env::temp_dir().join(format!("ccode-endnote-lib-report-{}.json", uuid::Uuid::new_v4()));
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
    // 带 PDF / 笔记：按引文库算出每条挂什么（只读），写临时 JSON 交给 bridge；双空格 PDF 走单空格硬链防 EndNote 漏挂
    let attach_file = std::env::temp_dir().join(format!("ccode-endnote-attach-{stamp}.json"));
    let attach = match crate::library_attach::write_endnote_plan(&root, &bib, mode, &attach_file) {
        Ok(plan) => plan,
        Err(e) => {
            let _ = std::fs::remove_file(&script);
            let _ = std::fs::remove_file(&abbr);
            if source != bib {
                let _ = std::fs::remove_file(&source);
            }
            return Err(e);
        }
    };
    let dropped = run_bridge_terms(
        &py,
        &script,
        &source,
        &papers,
        &stamp,
        "ris",
        &ris,
        &report,
        &root,
        false,
        Some(&terms),
        attach.as_ref().map(|p| p.file.as_path()),
    );
    // 同步写出保留 <style face="subscript|superscript"> 真上下标格式的 EndNote XML：
    // XML 走真实 papers/ 路径（不走 RIS 专用的临时单空格硬链目录，避免直接挂接绝对路径时指向临时目录）
    if dropped.is_ok() {
        let xml_attach_file =
            std::env::temp_dir().join(format!("ccode-endnote-xml-attach-{stamp}.json"));
        let xml_attach = crate::library_attach::write_plan(&root, &bib, mode, &xml_attach_file)
            .ok()
            .flatten();
        let _ = run_bridge_terms(
            &py,
            &script,
            &source,
            &papers,
            &stamp,
            "xml",
            &xml,
            &report,
            &root,
            false,
            None,
            xml_attach.as_ref().map(|p| p.file.as_path()),
        );
        let _ = std::fs::remove_file(&xml_attach_file);
    }
    let _ = std::fs::remove_file(&report);
    let _ = std::fs::remove_file(&attach_file);
    if source != bib {
        let _ = std::fs::remove_file(&source);
    }
    let dropped = dropped?;
    let attached = attach.as_ref().map(|p| p.summary(mode)).unwrap_or_default();
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
            "双缩写表已生成在 papers/{JOURNAL_TERMS}（EndNote「工具 → 打开术语表 → 期刊术语表」导入一次即可切换）。"
        )
    } else {
        String::new()
    };
    let mut lines: Vec<String> = Vec::new();
    for block in [filled, dropped, attached, terms_note, health] {
        for line in block.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed == "库体检：库里没有旧版导出的脏记录。" {
                continue;
            }
            let owned = trimmed.to_string();
            if !lines.contains(&owned) {
                lines.push(owned);
            }
        }
    }
    Ok((ris, lines.join("\n")))
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
        if let Some(home) = crate::dirs::home_dir() {
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

fn copy_into_dir_fresh(src: &Path, dir: &Path, name: &str) -> Option<PathBuf> {
    let dest = dir.join(name);
    // 先删旧文件再复制，保证 macOS「下载」按添加时间排在第一位（原地覆盖会沿用旧添加时间沉在底下）
    let _ = std::fs::remove_file(&dest);
    std::fs::copy(src, &dest).ok()?;
    Some(dest)
}

fn copy_to_downloads(src: &Path, name: &str) -> Option<PathBuf> {
    let dir = crate::dirs::download_dir()?;
    copy_into_dir_fresh(src, &dir, name)
}

fn endnote_project_group_name(project_root: &Path) -> String {
    let raw = project_root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    crate::paths::sanitize_fs_name(raw).unwrap_or_default()
}

fn endnote_download_xml_name(project_root: &Path) -> String {
    let base = endnote_project_group_name(project_root);
    let base = if base.is_empty() { "文献" } else { base.as_str() };
    format!("{base}-EndNote导入.xml")
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

fn launch_endnote_app(enl: Option<&Path>) -> Result<(), String> {
    let app = find_endnote_app().ok_or_else(|| "找不到 EndNote。".to_string())?;
    let valid_enl = enl.filter(|p| {
        p.is_file()
            && p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("enl"))
    });
    #[cfg(target_os = "macos")]
    {
        let mut cmd = crate::process::background_command("open");
        cmd.arg("-a").arg(&app);
        if let Some(lib) = valid_enl {
            cmd.arg(lib);
        }
        cmd.spawn().map_err(|e| format!("没法打开 EndNote: {e}"))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        let mut cmd = crate::process::background_command(&app);
        if let Some(lib) = valid_enl {
            cmd.arg(lib);
        }
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("没法打开 EndNote: {e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, valid_enl);
        Err("这个系统上没有 EndNote 桌面版可交。".into())
    }
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
        for base in [crate::dirs::document_dir(), crate::dirs::desktop_dir()].into_iter().flatten() {
            dirs_to_look.push(base.join("EndNote"));
            dirs_to_look.push(base);
        }
        let (recent, elsewhere) = recent_library_paths();
        Ok(library_choices(recent, elsewhere, &dirs_to_look))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// recent = EndNote 最近打开的（排最前、标「最近打开」）；elsewhere = 别处搜到的（macOS Spotlight），排在文稿 / 桌面之后
fn library_choices(
    recent: Vec<String>,
    elsewhere: Vec<String>,
    dirs_to_look: &[PathBuf],
) -> Vec<EndnoteLibraryChoice> {
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
    for raw in elsewhere {
        push(PathBuf::from(raw.trim()), false);
    }
    out
}

#[cfg(windows)]
fn recent_library_paths() -> (Vec<String>, Vec<String>) {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let key: Vec<u16> = "Software\\ISI ResearchSoft\\EndNote\\Recent Libraries"
        .encode_utf16()
        .chain([0])
        .collect();
    let recent = (1..=20)
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
        .collect::<Vec<_>>();
    (recent, Vec::new())
}

/// macOS 没有那张登记表：问 Spotlight 家目录里的 .enl（.Data 文件夹旁边的那份，对话框里容易点错的就是它）。
/// 打开过的带 kMDItemLastUsedDate，按它新到旧排在最前、算「最近打开」；其余排在文稿 / 桌面之后。
/// 废纸篓和 ~/Library 里的不列；Spotlight 关着或超时就只剩文稿 / 桌面
#[cfg(target_os = "macos")]
fn recent_library_paths() -> (Vec<String>, Vec<String>) {
    let Some(home) = crate::dirs::home_dir() else {
        return (Vec::new(), Vec::new());
    };
    let mut cmd = crate::process::background_command("mdfind");
    cmd.arg("-onlyin")
        .arg(&home)
        .arg("-attr")
        .arg("kMDItemLastUsedDate")
        .arg("kMDItemFSName == '*.enl'c");
    match crate::process::capture_command(&mut cmd, std::time::Duration::from_secs(5), 256 * 1024) {
        Ok(out) if !out.timed_out && out.status.is_some_and(|s| s.success()) => {
            spotlight_libraries(&String::from_utf8_lossy(&out.stdout), &home)
        }
        _ => (Vec::new(), Vec::new()),
    }
}

/// Linux 没有可问的登记：只靠文稿 / 桌面里的 .enl，读不到就让人在对话框里选
#[cfg(not(any(windows, target_os = "macos")))]
fn recent_library_paths() -> (Vec<String>, Vec<String>) {
    (Vec::new(), Vec::new())
}

/// `mdfind -attr kMDItemLastUsedDate` 的输出：每行「路径   kMDItemLastUsedDate = 2026-10-24 08:00:00 +0000」，
/// 没打开过的是「= (null)」。日期同为 UTC 定宽格式，按字符串比就是按时间比
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn spotlight_libraries(text: &str, home: &Path) -> (Vec<String>, Vec<String>) {
    let skip = [home.join(".Trash"), home.join("Library")];
    let mut used: Vec<(String, String)> = Vec::new();
    let mut other: Vec<String> = Vec::new();
    for line in text.lines() {
        let Some((path, date)) = line.rsplit_once(" kMDItemLastUsedDate = ") else {
            continue;
        };
        let path = path.trim_end().to_string();
        if path.is_empty() || skip.iter().any(|dir| Path::new(&path).starts_with(dir)) {
            continue;
        }
        let date = date.trim();
        if date.is_empty() || date == "(null)" {
            other.push(path);
        } else {
            used.push((date.to_string(), path));
        }
    }
    used.sort_by(|a, b| b.0.cmp(&a.0));
    other.sort();
    (
        used.into_iter().take(20).map(|(_, path)| path).collect(),
        other.into_iter().take(30).collect(),
    )
}

/// 仅当条目 `<titles>` 含 `<style face="subscript|superscript">` 富文本上下标时才需要走 EndNote XML 手动导入；
/// 普通课题标题不含化学式/上下标时直接把 `endnote-library.ris` 交给 EndNote 即可一键静默导入（含 PDF 与笔记）。
fn xml_titles_have_rich_style(xml_text: &str) -> bool {
    let mut rest = xml_text;
    while let Some(start) = rest.find("<titles>") {
        let after = &rest[start + "<titles>".len()..];
        let Some(end) = after.find("</titles>") else {
            break;
        };
        if after[..end].contains("<style face=") {
            return true;
        }
        rest = &after[end + "</titles>".len()..];
    }
    false
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DirectEndnoteImport {
    count: usize,
    library_name: String,
    grouped: bool,
    library_path: Option<String>,
}

fn parse_direct_endnote_import_output(stdout: &str) -> Option<DirectEndnoteImport> {
    let line = stdout.lines().rev().find(|l| !l.trim().is_empty())?.trim();
    let mut parts = line.split('\t');
    let count: usize = parts.next()?.trim().parse().ok()?;
    if count == 0 {
        return None;
    }
    let library_name = parts.next()?.trim().to_string();
    let grouped = parts.next().is_some_and(|s| s.trim() == "1");
    let library_path = parts
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    Some(DirectEndnoteImport {
        count,
        library_name,
        grouped,
        library_path,
    })
}

/// macOS 一键直导 EndNote 库成功后，自动把刚导入的 `.enl` 路径写进 `papers/endnote-library.path`（gitignored）：
/// 避免人已经点过「同步到 EndNote」并看到「已直接导入」提示，定稿生成 `output/endnote.docx` 时却因没另点「选这个 EndNote 库」而整篇落进漫游个人图书馆。
/// 若指针已指向同一路径则不重复改写。返回是否新写入/更新了指针。
fn persist_endnote_library_pointer(project_root: &Path, lib_path: &Path) -> bool {
    if !lib_path.is_file()
        || !lib_path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("enl"))
        || is_legacy_library(lib_path)
    {
        return false;
    }
    let target_str = crate::paths::strip_verbatim(lib_path.to_path_buf())
        .to_string_lossy()
        .into_owned();
    if let Some(existing) = endnote_library_pointer(project_root) {
        if crate::paths::same_path(&existing.to_string_lossy(), &target_str) {
            return false;
        }
    }
    let papers = project_root.join("papers");
    if std::fs::create_dir_all(&papers).is_err() {
        return false;
    }
    let pointer = papers.join("endnote-library.path");
    let payload = format!("{target_str}\n");
    if crate::storage::atomic_write(&pointer, payload.as_bytes(), true).is_err() {
        return false;
    }
    crate::projects::exclude_in_git(project_root, "/papers/endnote-library.path");
    true
}

/// macOS 上直接经 EndNote 原生 AppleScript `import`（`ENImportCommand`，接收 RSXML）把整份 XML 静默导入目标库：
/// 一次点按同时保留 `<style face="subscript|superscript">` 真上下标、PDF 附件链接与多行研究笔记，并自动归入课题名群组，
/// 彻底绕开 macOS 导入文件框默认把「导入选项」藏在折叠「显示选项」里设为「PDF 文件或文件夹」导致点导入无反应的坑。
#[cfg(target_os = "macos")]
fn import_xml_into_endnote_macos(
    xml: &Path,
    enl: Option<&Path>,
    group_name: &str,
) -> Result<DirectEndnoteImport, String> {
    if !xml.is_file() {
        return Err("XML 文件不存在".into());
    }
    if find_endnote_app().is_none() {
        return Err("未检测到已安装的 EndNote".into());
    }
    let enl_arg = enl
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("enl"))
                && !is_legacy_library(p)
        })
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    const SCRIPT: &str = r#"
on run argv
    set xmlPath to item 1 of argv
    set enlPath to item 2 of argv
    set groupName to item 3 of argv
    set xmlData to read (POSIX file xmlPath) as «class utf8»
    set targetName to my baseName(enlPath)
    tell application id "com.ThomsonResearchSoft.EndNote"
        activate
        set openedOnce to false
        set targetDoc to missing value
        repeat 30 times
            if (count of documents) > 0 then
                if targetName is "" then
                    set targetDoc to document 1
                    exit repeat
                else
                    repeat with d in documents
                        try
                            if (name of d as text) is equal to targetName then
                                set targetDoc to contents of d
                                exit repeat
                            end if
                        end try
                    end repeat
                    if targetDoc is not missing value then exit repeat
                end if
            end if
            if (not openedOnce) and (enlPath is not "") then
                open (POSIX file enlPath)
                set openedOnce to true
            end if
            delay 0.25
        end repeat
        if targetDoc is missing value then error "NO_OPEN_LIBRARY"
        set docName to name of targetDoc as text
        set beforeIds to retrieve "all" records in targetDoc
        import xmlData into targetDoc
        set afterIds to retrieve "all" records in targetDoc
        if (count of beforeIds) is 0 then
            set newIds to afterIds
        else
            set AppleScript's text item delimiters to "|"
            set beforeBlob to "|" & (beforeIds as text) & "|"
            set AppleScript's text item delimiters to ""
            set newIds to {}
            repeat with recId in afterIds
                set s to recId as text
                if beforeBlob does not contain ("|" & s & "|") then
                    set end of newIds to s
                end if
            end repeat
        end if
        set grouped to "0"
        if (count of newIds) > 0 then
            try
                set targetWin to window docName
                if groupName is not "" then
                    set existingGroups to get groups of type "CUSTOM" in targetWin
                    if existingGroups does not contain groupName then
                        post records in newIds in targetWin as groupName of type "CUSTOM"
                        set grouped to "1"
                    end if
                end if
                show records in newIds in targetWin
            end try
        end if
        set docPath to ""
        try
            set docPath to POSIX path of (file of targetDoc as alias)
        end try
        return ((count of newIds) as text) & "\t" & docName & "\t" & grouped & "\t" & docPath
    end tell
end run

on baseName(posixPath)
    if posixPath is "" then return ""
    set AppleScript's text item delimiters to "/"
    set lastPart to last text item of posixPath
    set AppleScript's text item delimiters to ""
    return lastPart
end baseName
"#;

    let mut cmd = crate::process::background_command("osascript");
    cmd.arg("-e")
        .arg(SCRIPT)
        .arg(xml)
        .arg(&enl_arg)
        .arg(group_name);
    let out =
        crate::process::capture_command(&mut cmd, std::time::Duration::from_secs(25), 256 * 1024)
            .map_err(|e| format!("调用 osascript 失败: {e}"))?;
    if out.timed_out || !out.status.is_some_and(|s| s.success()) {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "EndNote 未响应自动导入".into()
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    parse_direct_endnote_import_output(&stdout)
        .ok_or_else(|| "EndNote 返回的导入条数为 0".to_string())
}

#[cfg(not(target_os = "macos"))]
fn import_xml_into_endnote_macos(
    _xml: &Path,
    _enl: Option<&Path>,
    _group_name: &str,
) -> Result<DirectEndnoteImport, String> {
    Err("non-macos".into())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndnoteSyncDto {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xml_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library_path: Option<String>,
}

#[tauri::command]
pub async fn endnote_export_xml(
    project_root: String,
    attach: Option<String>,
) -> Result<EndnoteSyncDto, String> {
    let mode = crate::library_attach::AttachMode::parse(attach.as_deref());
    // 转换和打开 EndNote 都在后台线程，不占界面。
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::sessions::expand_tilde(&project_root);
        let root_path = Path::new(&root);
        // 有引文库就按它生成整库 endnote-library.xml + endnote-library.ris（初稿/定稿同步时）；
        // macOS 优先经 EndNote 原生 RSXML AppleScript 一键直导（同时保留真上下标、PDF、多行笔记并自动建课题群组）；
        // 未能直导（如 Windows 或未打开任何库）时：标题含上下标走 XML 手动导入指引，普通标题走 RIS 一键导入。
        if root_path.join("references.bib").is_file() {
            let (ris, health) = export_ris_only(root_path, mode)?;
            let xml = ris.with_file_name(LIBRARY_XML);
            let enl = endnote_library_pointer(root_path);
            let group_name = endnote_project_group_name(root_path);
            if xml.is_file() {
                if let Ok(imported) =
                    import_xml_into_endnote_macos(&xml, enl.as_deref(), &group_name)
                {
                    let linked_path = imported
                        .library_path
                        .as_deref()
                        .map(PathBuf::from)
                        .filter(|p| {
                            p.is_file()
                                && p.extension()
                                    .and_then(|e| e.to_str())
                                    .is_some_and(|e| e.eq_ignore_ascii_case("enl"))
                                && !is_legacy_library(p)
                        });
                    let auto_linked = linked_path
                        .as_deref()
                        .is_some_and(|p| persist_endnote_library_pointer(root_path, p));
                    // 新记录刚进 .enl 库（并已自动写好库指针）：若主仓或活动工作区里的 output/endnote.docx 尚未在 Word 里保存改过，顺手按最新记录号静默重绑
                    refresh_project_endnote_docs(root_path);
                    let group_note = if imported.grouped && !group_name.is_empty() {
                        format!("，已归入「{group_name}」群组")
                    } else {
                        String::new()
                    };
                    let link_note = if auto_linked {
                        "，已自动关联该库（定稿 Word 点 Update 可直连个人图书馆）"
                    } else {
                        ""
                    };
                    let mut lines = vec![format!(
                        "已直接导入 EndNote 库「{}」（共 {} 条{}，保留上下标格式{}）。{}",
                        imported.library_name,
                        imported.count,
                        group_note,
                        link_note,
                        if mode == crate::library_attach::AttachMode::Items {
                            "全文可点「打开 papers」拖入条目。"
                        } else {
                            ""
                        }
                    )];
                    lines.push(
                        "若此前已导过同批文献，可在 EndNote 点「参考文献 → 查找重复项」（References → Find Duplicates）去重。"
                            .to_string(),
                    );
                    if !health.is_empty() {
                        lines.push(health);
                    }
                    return Ok(EndnoteSyncDto {
                        message: lines.join("\n"),
                        xml_path: None,
                        library_path: linked_path.map(|p| p.to_string_lossy().into_owned()),
                    });
                }
            }
            let needs_rich_xml = xml.is_file()
                && std::fs::read_to_string(&xml)
                    .is_ok_and(|text| xml_titles_have_rich_style(&text));
            if needs_rich_xml {
                let dl_name = endnote_download_xml_name(root_path);
                let downloaded = copy_to_downloads(&xml, &dl_name);
                let target = downloaded.as_deref().unwrap_or(&xml);
                copy_path_to_clipboard(target);
                let xml_path = Some(target.to_string_lossy().into_owned());
                let health_note = if health.is_empty() {
                    String::new()
                } else {
                    format!("\n{health}")
                };
                let reveal_label = if cfg!(target_os = "macos") {
                    "在访达中定位"
                } else {
                    "在文件夹中定位"
                };
                let (where_note, import_steps) = if downloaded.is_some() {
                    if cfg!(target_os = "macos") {
                        (
                            format!("已放入「下载/{dl_name}」"),
                            format!("先在 EndNote 打开你的个人图书馆（.enl），点「文件 → 导入...」（File → Import…），在左侧「下载」里选最上面这份文件（或点下方「{reveal_label}」拖进导入窗口），务必先点窗口底部「显示选项」（Options）把「导入选项」从默认的「PDF 文件或文件夹」改为「EndNote 生成的 XML」（EndNote generated XML，不改直接点导入会完全没反应），之后 EndNote 会记住目录和选项"),
                        )
                    } else {
                        (
                            format!("已放入「下载\\{dl_name}」"),
                            format!("点「文件 → 导入 → 文件...」（File → Import → File…），在左侧「下载」里选这份文件（或点下方「{reveal_label}」拖进导入窗口），并把「导入选项」（Import Option）改为「EndNote 生成的 XML」（EndNote generated XML，默认是 PDF 或 EndNote Import，不改点导入会没反应），之后 EndNote 会记住目录和选项"),
                        )
                    }
                } else if cfg!(target_os = "macos") {
                    (
                        format!("已生成保留上下标格式的 papers/{LIBRARY_XML}（路径已复制）"),
                        format!("先在 EndNote 打开你的个人图书馆（.enl），点「文件 → 导入...」（File → Import…），点下方「{reveal_label}」把高亮文件拖进导入窗口，务必先点窗口底部「显示选项」（Options）把「导入选项」从默认的「PDF 文件或文件夹」改为「EndNote 生成的 XML」（不改点导入会没反应），之后 EndNote 会记住该选项"),
                    )
                } else {
                    (
                        format!("已生成保留上下标格式的 papers/{LIBRARY_XML}（路径已复制）"),
                        format!("点「文件 → 导入 → 文件...」（File → Import → File…），点下方「{reveal_label}」把高亮文件拖进导入窗口，并把「导入选项」（Import Option）改为「EndNote 生成的 XML」（不改点导入会没反应），之后 EndNote 会记住该选项"),
                    )
                };
                return match launch_endnote_app(enl.as_deref()) {
                    Ok(()) => {
                        let mut lines = vec![format!(
                            "{where_note}并打开 EndNote：{import_steps}。{}",
                            if mode == crate::library_attach::AttachMode::Items {
                                "全文可点「打开 papers」拖入条目。"
                            } else {
                                ""
                            }
                        )];
                        lines.push(
                            "若此前已用 RIS 或旧版导过同批文献，请先删掉旧条目再导入（避免重复或沿用假下标）。"
                                .to_string(),
                        );
                        if !health.is_empty() {
                            lines.push(health);
                        }
                        Ok(EndnoteSyncDto {
                            message: lines.join("\n"),
                            xml_path,
                            library_path: None,
                        })
                    }
                    Err(e) => Ok(EndnoteSyncDto {
                        message: format!(
                            "{where_note}。打开 EndNote 后{import_steps}。{e}{health_note}"
                        ),
                        xml_path,
                        library_path: None,
                    }),
                };
            }
            let shown = ris
                .file_name()
                .map(|n| format!("papers/{}", n.to_string_lossy()))
                .unwrap_or_else(|| ris.display().to_string());
            copy_path_to_clipboard(&ris);
            let health_note = if health.is_empty() {
                String::new()
            } else {
                format!("\n{health}")
            };
            return match launch_endnote_with_file(&ris) {
                Ok(()) => {
                    let mut lines = vec![format!(
                        "已交给 EndNote（导进当前库的 Imported References，可整批拖入分组）。{}",
                        if mode == crate::library_attach::AttachMode::Items {
                            "全文可点「打开 papers」拖入条目。"
                        } else {
                            ""
                        }
                    )];
                    lines.push("若此前已导过，请用 References → Find Duplicates 去重。".to_string());
                    if !health.is_empty() {
                        lines.push(health);
                    }
                    Ok(EndnoteSyncDto {
                        message: lines.join("\n"),
                        xml_path: None,
                        library_path: None,
                    })
                }
                Err(e) => Ok(EndnoteSyncDto {
                    message: format!(
                        "文件在 {shown}。把它拖到 EndNote 图标上（不要拖进窗口）。{e}{health_note}"
                    ),
                    xml_path: None,
                    library_path: None,
                }),
            };
        }
        let Some(ris) = find_import_ris(root_path) else {
            return Err(
                "还没有 papers/endnote-import.ris。检索保存进项目后才会有这一份，同步只打开它，不再重新检索。"
                    .into(),
            );
        };
        let shown = ris
            .file_name()
            .map(|n| format!("papers/{}", n.to_string_lossy()))
            .unwrap_or_else(|| ris.display().to_string());
        copy_path_to_clipboard(&ris);
        match launch_endnote_with_file(&ris) {
            Ok(()) => Ok(EndnoteSyncDto {
                message: "已交给 EndNote（导进当前库的 Imported References，可整批拖入分组）。\n若此前已导过，请用 References → Find Duplicates 去重。"
                    .to_string(),
                xml_path: None,
                library_path: None,
            }),
            Err(e) => Ok(EndnoteSyncDto {
                message: format!(
                    "文件在 {shown}。把它拖到 EndNote 图标上（不要拖进窗口）。{e}"
                ),
                xml_path: None,
                library_path: None,
            }),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn file_mtime(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

/// 仅当 docx 仍是 cite_docx.py / zotero_docx.py 写出的原装域稿（未被 Word / WPS / LibreOffice / CWYW / Zotero 保存改写）时，
/// 返回其中的 `word/document.xml` 文本；一旦检出人在字处理软件里保存过的痕迹就返回 None，绝不覆盖。
fn inspect_untouched_field_docx(docx_path: &Path) -> Option<String> {
    use std::io::Read;
    if !docx_path.is_file() {
        return None;
    }
    let file = std::fs::File::open(docx_path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let entry = zip.by_name("word/document.xml").ok()?;
    let mut xml = String::new();
    entry.take(16 * 1024 * 1024).read_to_string(&mut xml).ok()?;
    if xml.contains("w:rsid")
        || xml.contains("mc:Ignorable")
        || xml.contains("_ENREF_")
        || xml.contains("EndNoteBibliography")
        || xml.contains("ZOTERO_BIBL")
    {
        return None;
    }
    if !xml.contains("ADDIN EN.CITE") && !xml.contains("ADDIN ZOTERO_ITEM") {
        return None;
    }
    Some(xml)
}

fn endnote_docx_has_foreign_keys(doc_xml: &str) -> bool {
    use base64::Engine as _;
    let mut rest = doc_xml;
    while let Some(start) = rest.find("<w:fldData") {
        let after = &rest[start..];
        let Some(gt) = after.find('>') else { break };
        let body = &after[gt + 1..];
        let Some(end) = body.find("</w:fldData>") else { break };
        let b64: String = body[..end].chars().filter(|c| !c.is_ascii_whitespace()).collect();
        rest = &body[end + "</w:fldData>".len()..];
        if b64.is_empty() {
            continue;
        }
        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(&b64) {
            let text = String::from_utf8_lossy(&decoded);
            if text.contains("<EndNote>") {
                return text.contains("<foreign-keys>");
            }
        }
    }
    false
}

fn is_git_tracked(doc_root: &Path, path: &Path) -> bool {
    if !doc_root.join(".git").exists() {
        return false;
    }
    let Ok(rel) = path.strip_prefix(doc_root) else {
        return false;
    };
    crate::process::background_command("git")
        .arg("-C")
        .arg(doc_root)
        .arg("ls-files")
        .arg("--error-unmatch")
        .arg("--")
        .arg(rel)
        .output()
        .is_ok_and(|o| o.status.success())
}

fn find_final_markdown(doc_root: &Path) -> Option<PathBuf> {
    const CANDIDATES: [&str; 4] = [
        "submission/formatted.md",
        "manuscript/review-final.md",
        "manuscript/paper-final.md",
        "manuscript/thesis-final.md",
    ];
    let mut best: Option<(Option<std::time::SystemTime>, usize, PathBuf)> = None;
    for (idx, rel) in CANDIDATES.iter().enumerate() {
        let candidate = doc_root.join(rel);
        if !candidate.is_file() {
            continue;
        }
        let mtime = file_mtime(&candidate);
        let take = match &best {
            None => true,
            Some((bm, bi, _)) => match (mtime, *bm) {
                (Some(m), Some(b)) if m != b => m > b,
                _ => idx < *bi,
            },
        };
        if take {
            best = Some((mtime, idx, candidate));
        }
    }
    best.map(|(_, _, p)| p)
}

fn resolve_project_root_for_doc_root(doc_root: &Path, context_root: &Path) -> PathBuf {
    if !crate::paths::same_path(
        &doc_root.to_string_lossy(),
        &context_root.to_string_lossy(),
    ) && (context_root.join("papers/endnote-library.path").is_file()
        || context_root.join(".ccode/project.toml").is_file())
    {
        return context_root.to_path_buf();
    }
    let dot_git = doc_root.join(".git");
    if dot_git.is_file() {
        if let Ok(text) = std::fs::read_to_string(&dot_git) {
            if let Some(raw) = text.lines().find_map(|l| l.trim().strip_prefix("gitdir:")) {
                let raw_path = PathBuf::from(raw.trim());
                let gitdir = if raw_path.is_absolute() {
                    raw_path
                } else {
                    doc_root.join(raw_path)
                };
                if let Some(worktrees) = gitdir.parent() {
                    if worktrees.file_name().and_then(|n| n.to_str()) == Some("worktrees") {
                        if let Some(repo_git) = worktrees.parent() {
                            if repo_git.file_name().and_then(|n| n.to_str()) == Some(".git") {
                                if let Some(repo_root) = repo_git.parent() {
                                    return repo_root.to_path_buf();
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if let Ok(conn) = crate::workspaces::db() {
        if let Ok(rows) = crate::workspaces::query_workspaces(&conn) {
            let doc_str = doc_root.to_string_lossy();
            if let Some(row) = rows
                .into_iter()
                .find(|r| r.status != "archived" && crate::paths::same_path(&r.worktree_path, &doc_str))
            {
                return PathBuf::from(row.repo_path);
            }
        }
    }
    doc_root.to_path_buf()
}

fn rebuild_field_docx(
    kind: &str,
    doc_root: &Path,
    project_root: &Path,
    md_path: &Path,
    bib_path: &Path,
    docx_path: &Path,
    report_path: &Path,
) -> Result<(), String> {
    let py = python_bin()?;
    let tmp_dir = std::env::temp_dir().join(format!("ccode-field-docx-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("无法创建临时目录: {e}"))?;
    let write_res = (|| -> Result<(), String> {
        crate::storage::atomic_write(&tmp_dir.join("bridge.py"), BRIDGE_PY.as_bytes(), true)?;
        crate::storage::atomic_write(
            &tmp_dir.join("library_match.py"),
            LIBRARY_MATCH_PY.as_bytes(),
            true,
        )?;
        crate::storage::atomic_write(
            &tmp_dir.join("cite_docx.py"),
            CITE_DOCX_PY.as_bytes(),
            true,
        )?;
        if kind == "zotero" {
            crate::storage::atomic_write(
                &tmp_dir.join("zotero_docx.py"),
                ZOTERO_DOCX_PY.as_bytes(),
                true,
            )?;
        }
        crate::storage::atomic_write(
            &tmp_dir.join("journal-abbreviations.csv"),
            include_bytes!("../resources/journal-abbreviations.csv"),
            true,
        )?;
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(e);
    }
    let stamp = uuid::Uuid::new_v4();
    let docx_tmp = docx_path.with_file_name(format!(".ccode-{kind}-{stamp}.docx"));
    let report_tmp = if let Some(parent) = report_path.parent() {
        let _ = std::fs::create_dir_all(parent);
        parent.join(format!(".ccode-{kind}-{stamp}.md"))
    } else {
        tmp_dir.join(format!("report-{stamp}.md"))
    };
    let script = tmp_dir.join(if kind == "zotero" {
        "zotero_docx.py"
    } else {
        "cite_docx.py"
    });
    let mut cmd = python_command(&py);
    cmd.arg(&script)
        .arg("--input")
        .arg(md_path)
        .arg("--bib")
        .arg(bib_path)
        .arg("--output")
        .arg(&docx_tmp)
        .arg("--report")
        .arg(&report_tmp)
        .current_dir(doc_root);
    if kind == "endnote" {
        cmd.arg("--project-root").arg(project_root);
    }
    let out = crate::process::capture_command(&mut cmd, std::time::Duration::from_secs(120), 1024 * 1024);
    let _ = std::fs::remove_dir_all(&tmp_dir);
    let Ok(out) = out else {
        let _ = std::fs::remove_file(&docx_tmp);
        let _ = std::fs::remove_file(&report_tmp);
        return Err("运行域稿脚本失败".into());
    };
    if out.timed_out || !out.status.is_some_and(|s| s.success()) || !docx_tmp.is_file() {
        let _ = std::fs::remove_file(&docx_tmp);
        let _ = std::fs::remove_file(&report_tmp);
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    crate::storage::replace(&docx_tmp, docx_path)?;
    // 已纳入 Git 跟踪的报告（如可评审工作区或已合并主仓）不在后台打开 docx 时偷偷改脏，避免拦住合并
    if report_tmp.is_file() && report_path.parent().is_some() && !is_git_tracked(doc_root, report_path) {
        let _ = crate::storage::replace(&report_tmp, report_path);
    } else {
        let _ = std::fs::remove_file(&report_tmp);
    }
    Ok(())
}

/// 打开 `output/endnote.docx` 或 `output/zotero.docx` 前（或刚选完 EndNote 库后），若该域稿还没被人在 Word 里保存改过，
/// 且后来新指了 `papers/endnote-library.path`、更新了库记录、或旧版 `zotero.docx` 含空 `citationItems: []`，自动静默重绑。
pub fn refresh_field_docx_if_stale(docx_path: &Path, context_root: &Path) {
    let Some(name) = docx_path.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    let kind = if name.eq_ignore_ascii_case("endnote.docx") {
        "endnote"
    } else if name.eq_ignore_ascii_case("zotero.docx") {
        "zotero"
    } else {
        return;
    };
    let Some(output_dir) = docx_path.parent() else {
        return;
    };
    if !output_dir
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("output"))
    {
        return;
    }
    let Some(doc_root) = output_dir.parent() else {
        return;
    };
    let bib_path = doc_root.join("references.bib");
    if !bib_path.is_file() {
        return;
    }
    let Some(md_path) = find_final_markdown(doc_root) else {
        return;
    };
    let report_path = doc_root.join(if kind == "endnote" {
        "papers/endnote-cite-report.md"
    } else {
        "papers/zotero-cite-report.md"
    });
    let Some(doc_xml) = inspect_untouched_field_docx(docx_path) else {
        return;
    };
    let project_root = resolve_project_root_for_doc_root(doc_root, context_root);
    let docx_mtime = file_mtime(docx_path);
    let newer = |p: &Path| matches!((file_mtime(p), docx_mtime), (Some(pm), Some(dm)) if pm > dm);
    let report_text = std::fs::read_to_string(&report_path).unwrap_or_default();
    let has_literal_refs_div =
        doc_xml.contains("::: </w:t>") && doc_xml.contains(">refs</w:t>");
    let stale = if kind == "endnote" {
        let enl = endnote_library_pointer(&project_root).or_else(|| endnote_library_pointer(doc_root));
        let sdb = enl.as_ref().map(|p| p.with_extension("Data").join("sdb").join("sdb.eni"));
        let sdb_wal = enl
            .as_ref()
            .map(|p| p.with_extension("Data").join("sdb").join("sdb.eni-wal"));
        has_literal_refs_div
            || newer(&project_root.join("papers/endnote-library.path"))
            || newer(&doc_root.join("papers/endnote-library.path"))
            || enl.as_deref().is_some_and(newer)
            || sdb.as_deref().is_some_and(newer)
            || sdb_wal.as_deref().is_some_and(newer)
            || newer(&bib_path)
            || newer(&md_path)
            || (enl.as_deref().is_some_and(|p| p.exists())
                && !endnote_docx_has_foreign_keys(&doc_xml))
    } else {
        let empty_cites = doc_xml.contains("\"citationItems\":[]")
            || doc_xml.contains("\"citationItems\": []");
        let zotero_db = crate::dirs::home_dir().map(|h| h.join("Zotero").join("zotero.sqlite"));
        let db_updated_with_unbound = (report_text.contains("已绑定：0")
            || report_text.contains("未写入条目地址"))
            && zotero_db.as_deref().is_some_and(newer);
        has_literal_refs_div
            || empty_cites
            || newer(&bib_path)
            || newer(&md_path)
            || db_updated_with_unbound
    };
    if stale {
        let _ = rebuild_field_docx(
            kind,
            doc_root,
            &project_root,
            &md_path,
            &bib_path,
            docx_path,
            &report_path,
        );
    }
}

/// 人在界面上保存 `papers/endnote-library.path` 后，顺手把主仓和活动工作区里尚未用 Word 编辑过的 `output/endnote.docx` 重绑到新选的库。
pub fn refresh_project_endnote_docs(project_root: &Path) {
    let direct = project_root.join("output").join("endnote.docx");
    if direct.is_file() {
        refresh_field_docx_if_stale(&direct, project_root);
    }
    let Ok(conn) = crate::workspaces::db() else {
        return;
    };
    let Ok(rows) = crate::workspaces::query_workspaces(&conn) else {
        return;
    };
    let root_str = project_root.to_string_lossy();
    for row in rows {
        if row.status == "archived" || !crate::paths::same_path(&row.repo_path, &root_str) {
            continue;
        }
        let wt_docx = Path::new(&row.worktree_path).join("output").join("endnote.docx");
        if wt_docx.is_file() {
            refresh_field_docx_if_stale(&wt_docx, project_root);
        }
    }
}

fn unescape_docx_xml_text(raw: &str) -> String {
    raw.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn collect_docx_prose_braces(doc_xml: &str) -> Vec<String> {
    let mut hits: Vec<String> = Vec::new();
    let mut rest = doc_xml;
    while let Some(p_idx) = rest.find("<w:p") {
        let after_p = &rest[p_idx + 4..];
        let is_p_tag = after_p
            .chars()
            .next()
            .is_some_and(|c| c == '>' || c == '/' || c.is_ascii_whitespace());
        if !is_p_tag {
            rest = after_p;
            continue;
        }
        let Some(p_end) = after_p.find("</w:p>") else {
            break;
        };
        let p_body = &after_p[..p_end];
        rest = &after_p[p_end + "</w:p>".len()..];

        let mut para = String::new();
        let mut scan = p_body;
        while let Some(t_idx) = scan.find("<w:t") {
            let after_t = &scan[t_idx + 4..];
            let is_t_tag = after_t
                .chars()
                .next()
                .is_some_and(|c| c == '>' || c.is_ascii_whitespace());
            if !is_t_tag {
                scan = after_t;
                continue;
            }
            let Some(gt) = after_t.find('>') else {
                break;
            };
            if after_t[..gt].ends_with('/') {
                scan = &after_t[gt + 1..];
                continue;
            }
            let inner = &after_t[gt + 1..];
            let Some(t_end) = inner.find("</w:t>") else {
                break;
            };
            para.push_str(&unescape_docx_xml_text(&inner[..t_end]));
            scan = &inner[t_end + "</w:t>".len()..];
        }

        let bytes = para.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'{' {
                if let Some(rel_close) = para[i + 1..].find('}') {
                    let content = &para[i + 1..i + 1 + rel_close];
                    let char_len = content.chars().count();
                    if (1..=40).contains(&char_len)
                        && !content.contains('{')
                        && !content.contains('\r')
                        && !content.contains('\n')
                    {
                        let token = format!("{{{content}}}");
                        if !hits.contains(&token) {
                            hits.push(token);
                        }
                        i += 1 + rel_close + 1;
                        continue;
                    }
                }
            }
            let step = para[i..].chars().next().map_or(1, char::len_utf8);
            i += step;
        }
    }
    hits
}

/// 打开 `endnote.docx` 时，若正文可见文字含 `{110}`、`{001}` 等花括号符号且文档尚未自定义 CWYW 临时引文分隔符，
/// 返回行内防呆提示（避免人在 EndNote 弹窗里误点「插入」把晶面或集合记号替换成引文）。
pub fn endnote_docx_prose_brace_hint(docx_path: &Path) -> Option<String> {
    use std::io::Read;
    if !docx_path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("endnote.docx"))
        || !docx_path.is_file()
    {
        return None;
    }
    let file = std::fs::File::open(docx_path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    if let Ok(settings_entry) = zip.by_name("word/settings.xml") {
        let mut settings_xml = String::new();
        if settings_entry
            .take(2 * 1024 * 1024)
            .read_to_string(&mut settings_xml)
            .is_ok()
        {
            let unescaped = unescape_docx_xml_text(&settings_xml);
            if let Some(ld) = unescaped.find("<LeftDelim>") {
                let after = &unescaped[ld + "<LeftDelim>".len()..];
                if let Some(end) = after.find("</LeftDelim>") {
                    if after[..end].trim() != "{" {
                        return None;
                    }
                }
            }
        }
    }
    let doc_entry = zip.by_name("word/document.xml").ok()?;
    let mut doc_xml = String::new();
    doc_entry
        .take(16 * 1024 * 1024)
        .read_to_string(&mut doc_xml)
        .ok()?;
    let hits = collect_docx_prose_braces(&doc_xml);
    if hits.is_empty() {
        return None;
    }
    let sample = hits.iter().take(5).cloned().collect::<Vec<_>>().join("、");
    let more = if hits.len() > 5 {
        format!(" 等 {} 种", hits.len())
    } else {
        String::new()
    };
    Some(format!(
        "正文含花括号符号（{sample}{more}），点 Update 若弹出「选择匹配参考文献」请直接点「全部忽略」（切勿点「插入」）。若需反复刷新不再弹出，可在 Word 的 EndNote 栏点 Configure Bibliography 把临时引文分隔符改为 {{{{ }}}}。"
    ))
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
        let got = library_choices(recent, vec![], &[dir.clone()]);
        let names: Vec<(&str, bool)> = got.iter().map(|c| (c.name.as_str(), c.recent)).collect();
        // 最近打开的排前、只出一次；不存在的不列；.Data 文件夹和别的文件不列
        assert_eq!(names, vec![("我的EndNote库.enl", true), ("旧库.enl", false)]);
        // 同名 .Data 下有 rdb = X9 老格式
        std::fs::create_dir_all(dir.join("我的EndNote库.Data").join("rdb")).unwrap();
        let again = library_choices(vec![], vec![], &[dir.clone()]);
        assert!(again.iter().find(|c| c.name == "我的EndNote库.enl").unwrap().legacy);
        assert!(!again.iter().find(|c| c.name == "旧库.enl").unwrap().legacy);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn spotlight_libraries_put_opened_first_and_skip_trash_and_library() {
        let home = Path::new("/Users/me");
        let text = "/Users/me/Documents/旧库.enl   kMDItemLastUsedDate = (null)\n\
                    /Users/me/Library/Caches/x.enl   kMDItemLastUsedDate = 2026-10-20 08:00:00 +0000\n\
                    /Users/me/.Trash/扔了.enl   kMDItemLastUsedDate = 2026-10-23 08:00:00 +0000\n\
                    /Users/me/iCloud/课题 A.enl   kMDItemLastUsedDate = 2026-10-01 08:00:00 +0000\n\
                    /Users/me/Work/HER.enl   kMDItemLastUsedDate = 2026-10-24 08:00:00 +0000\n";
        let (recent, other) = spotlight_libraries(text, home);
        assert_eq!(recent, vec!["/Users/me/Work/HER.enl", "/Users/me/iCloud/课题 A.enl"]);
        assert_eq!(other, vec!["/Users/me/Documents/旧库.enl"]);
    }

    #[test]
    fn library_choices_list_spotlight_hits_after_folders() {
        let dir = std::env::temp_dir().join(format!("ccode-enl-sp-{}", uuid::Uuid::new_v4()));
        let far = dir.join("别处");
        std::fs::create_dir_all(&far).unwrap();
        std::fs::write(dir.join("文稿里.enl"), b"x").unwrap();
        std::fs::write(far.join("别处的.enl"), b"x").unwrap();
        let elsewhere = vec![
            far.join("别处的.enl").to_string_lossy().into_owned(),
            dir.join("文稿里.enl").to_string_lossy().into_owned(),
        ];
        let got = library_choices(vec![], elsewhere, &[dir.clone()]);
        let names: Vec<&str> = got.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["文稿里.enl", "别处的.enl"]);
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
        let ris = export_ris_only(&dir, crate::library_attach::AttachMode::Items);
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
        let out = export_ris_only(&dir, crate::library_attach::AttachMode::Items);
        let library = std::fs::read_to_string(dir.join("papers/endnote-library.ris")).ok();
        let library_xml = std::fs::read_to_string(dir.join("papers/endnote-library.xml")).ok();
        let terms = std::fs::read_to_string(dir.join("papers/endnote-journals.txt")).ok();
        let has_leak_report = dir.join("papers/endnote-report.json").exists();
        let canonical = std::fs::read_to_string(dir.join("papers/endnote-import.ris")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        if out.as_ref().is_err_and(|e| e.contains("找不到 python")) {
            return;
        }
        let (path, note) = out.expect("ris export");
        assert!(path.ends_with("papers/endnote-library.ris"));
        assert!(!has_leak_report, "export_ris_only 不得留下未忽略的 endnote-report.json");
        let library = library.expect("library ris");
        let library_xml = library_xml.expect("library xml");
        assert!(
            library_xml.contains(r#"<style face="subscript" font="default" size="100%">2</style>"#),
            "{library_xml}"
        );
        assert!(!library_xml.contains("Excluded boride paper"), "{library_xml}");
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
    fn refresh_field_docx_rebinds_untouched_doc_and_preserves_word_saved_doc() {
        let Ok(_) = python_bin() else {
            return;
        };
        let dir = std::env::temp_dir().join(format!("ccode-rebind-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("manuscript")).unwrap();
        std::fs::create_dir_all(dir.join("papers")).unwrap();
        std::fs::create_dir_all(dir.join("output")).unwrap();
        let md = dir.join("manuscript/review-final.md");
        let bib = dir.join("references.bib");
        let docx = dir.join("output/endnote.docx");
        let report = dir.join("papers/endnote-cite-report.md");
        std::fs::write(&md, "Boride catalyst [@Masa2016].\n").unwrap();
        std::fs::write(
            &bib,
            "@article{Masa2016,\n  title = {Amorphous Co2B for HER},\n  author = {Masa, Justus},\n  year = {2016},\n  journal = {Adv. Energy Mater.},\n  doi = {10.1002/aenm.201502313},\n}\n",
        )
        .unwrap();
        // 先生成未指定库时的原装 endnote.docx（走漫游库）
        rebuild_field_docx("endnote", &dir, &dir, &md, &bib, &docx, &report).expect("initial docx");
        let initial_report = std::fs::read_to_string(&report).unwrap();
        assert!(initial_report.contains("未指定 EndNote 库"), "{initial_report}");

        // 随后人补选了 EndNote 导出的 XML 库：打开前自动重绑到 rec-number=42
        let lib_xml = dir.join("papers/my-lib.xml");
        std::fs::write(
            &lib_xml,
            r#"<?xml version="1.0" encoding="utf-8"?><xml><records><record><rec-number>42</rec-number><foreign-keys><key app="EN" db-id="dbid0001" timestamp="1700000000">42</key></foreign-keys><ref-type name="Journal Article">17</ref-type><titles><title>Amorphous Co2B for HER</title></titles><electronic-resource-num>10.1002/aenm.201502313</electronic-resource-num></record></records></xml>"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("papers/endnote-library.path"),
            format!("{}\n", lib_xml.display()),
        )
        .unwrap();
        refresh_field_docx_if_stale(&docx, &dir);
        let rebound_report = std::fs::read_to_string(&report).unwrap();
        assert!(rebound_report.contains("已绑定 1 条"), "{rebound_report}");

        // 模拟人在 Word 里保存过该 docx（带 w:rsidR）：即使库又变了，也绝不能覆盖
        let saved_bytes = {
            use std::io::{Read, Write};
            let f = std::fs::File::open(&docx).unwrap();
            let mut zin = zip::ZipArchive::new(f).unwrap();
            let mut cursor = std::io::Cursor::new(Vec::new());
            {
                let mut zout = zip::ZipWriter::new(&mut cursor);
                let opts = zip::write::SimpleFileOptions::default();
                for i in 0..zin.len() {
                    let mut entry = zin.by_index(i).unwrap();
                    let name = entry.name().to_string();
                    let mut buf = Vec::new();
                    entry.read_to_end(&mut buf).unwrap();
                    if name == "word/document.xml" {
                        let s = String::from_utf8(buf)
                            .unwrap()
                            .replace("<w:p>", r#"<w:p w:rsidR="00A1B2C3">USER_EDIT_MARKER"#);
                        buf = s.into_bytes();
                    }
                    zout.start_file(name, opts).unwrap();
                    zout.write_all(&buf).unwrap();
                }
                zout.finish().unwrap();
            }
            cursor.into_inner()
        };
        std::fs::write(&docx, &saved_bytes).unwrap();
        std::fs::write(
            &lib_xml,
            r#"<?xml version="1.0" encoding="utf-8"?><xml><records><record><database name="MyLib.enl">MyLib.enl</database><rec-number>99</rec-number><titles><title>Amorphous Co2B for HER</title></titles><electronic-resource-num>10.1002/aenm.201502313</electronic-resource-num></record></records></xml>"#,
        )
        .unwrap();
        refresh_field_docx_if_stale(&docx, &dir);
        let after_xml = {
            use std::io::Read;
            let f = std::fs::File::open(&docx).unwrap();
            let mut zin = zip::ZipArchive::new(f).unwrap();
            let mut s = String::new();
            zin.by_name("word/document.xml").unwrap().read_to_string(&mut s).unwrap();
            s
        };
        assert!(after_xml.contains("USER_EDIT_MARKER"), "Word 保存过的 docx 绝不能被覆盖");

        // 旧版未编辑域稿残留字面 `::: refs :::` 与双 References 时，打开前自动重绑自愈
        std::fs::write(&md, "Boride catalyst [@Masa2016].\n\n## References {.unnumbered}\n\n::: {#refs}\n:::\n").unwrap();
        let legacy_docx = dir.join("output/endnote.docx");
        {
            use std::io::Write;
            let f = std::fs::File::create(&legacy_docx).unwrap();
            let mut zout = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            zout.start_file("word/document.xml", opts).unwrap();
            zout.write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:instrText> ADDIN EN.CITE </w:instrText></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>References</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">::: </w:t></w:r><w:r><w:t>refs</w:t></w:r><w:r><w:t xml:space="preserve"> :::</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>References</w:t></w:r></w:p></w:body></w:document>"#,
            )
            .unwrap();
            zout.finish().unwrap();
        }
        refresh_field_docx_if_stale(&legacy_docx, &dir);
        let healed_xml = {
            use std::io::Read;
            let f = std::fs::File::open(&legacy_docx).unwrap();
            let mut zin = zip::ZipArchive::new(f).unwrap();
            let mut s = String::new();
            zin.by_name("word/document.xml").unwrap().read_to_string(&mut s).unwrap();
            s
        };
        assert!(!healed_xml.contains(":::"), "自愈后不得残留 ::: refs :::");
        assert_eq!(healed_xml.matches(">References</w:t>").count(), 1, "自愈后只能有一个 References 标题");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn xml_titles_rich_style_detection_distinguishes_plain_and_formula_titles() {
        let plain_xml = r#"<?xml version="1.0" encoding="utf-8"?><xml><records><record><titles><title>Deep Learning for Protein Folding</title><secondary-title>Nature</secondary-title></titles><abstract><style face="subscript">2</style></abstract></record></records></xml>"#;
        assert!(
            !xml_titles_have_rich_style(plain_xml),
            "标题不含上下标时应直走 RIS 一键导入"
        );
        let formula_xml = r#"<?xml version="1.0" encoding="utf-8"?><xml><records><record><titles><title>Amorphous Co<style face="subscript">2</style>B for HER</title></titles></record></records></xml>"#;
        assert!(
            xml_titles_have_rich_style(formula_xml),
            "标题含化学上下标时必须走 XML 保留真上下标"
        );
    }

    #[test]
    fn endnote_download_xml_helper_replaces_existing_file_cleanly() {
        let dir = std::env::temp_dir().join(format!("ccode-endnote-dl-test-{}", uuid::Uuid::new_v4()));
        let proj = dir.join("HER催化综述");
        let dl = dir.join("Downloads");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::create_dir_all(&dl).unwrap();
        let name = endnote_download_xml_name(&proj);
        assert_eq!(name, "HER催化综述-EndNote导入.xml");

        let src = proj.join("endnote-library.xml");
        std::fs::write(&src, "<xml>v1</xml>").unwrap();
        let first = copy_into_dir_fresh(&src, &dl, &name).unwrap();
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "<xml>v1</xml>");

        // 覆盖写新内容应先 unlink 再拷，得到最新内容（macOS 上同时刷新 inode 添加时间排到下载顶部）
        std::fs::write(&src, "<xml>v2</xml>").unwrap();
        let second = copy_into_dir_fresh(&src, &dl, &name).unwrap();
        assert_eq!(second, first);
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "<xml>v2</xml>");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_direct_endnote_import_output() {
        assert_eq!(
            parse_direct_endnote_import_output(
                "33\t我的 EndNote 个人图书馆.enl\t1\t/Users/me/Documents/我的 EndNote 个人图书馆.enl\n"
            ),
            Some(DirectEndnoteImport {
                count: 33,
                library_name: "我的 EndNote 个人图书馆.enl".to_string(),
                grouped: true,
                library_path: Some("/Users/me/Documents/我的 EndNote 个人图书馆.enl".to_string()),
            })
        );
        assert_eq!(
            parse_direct_endnote_import_output("33\t我的 EndNote 个人图书馆.enl\t1\n"),
            Some(DirectEndnoteImport {
                count: 33,
                library_name: "我的 EndNote 个人图书馆.enl".to_string(),
                grouped: true,
                library_path: None,
            })
        );
        assert_eq!(parse_direct_endnote_import_output("0\tTest.enl\t0"), None);
    }

    #[test]
    fn persist_endnote_library_pointer_writes_once_and_skips_legacy() {
        let dir = std::env::temp_dir().join(format!("ccode-enl-ptr-{}", uuid::Uuid::new_v4()));
        let proj = dir.join("硼化物析氢");
        std::fs::create_dir_all(&proj).unwrap();
        let enl = dir.join("我的 EndNote 个人图书馆.enl");
        std::fs::write(&enl, b"sqlite").unwrap();

        assert!(persist_endnote_library_pointer(&proj, &enl));
        assert_eq!(
            std::fs::read_to_string(proj.join("papers/endnote-library.path")).unwrap().trim(),
            enl.to_string_lossy()
        );
        // 已指向同一库时不重复写
        assert!(!persist_endnote_library_pointer(&proj, &enl));

        // X9 老库（含 .Data/rdb）不写入指针
        let legacy = dir.join("x9.enl");
        std::fs::write(&legacy, b"shell").unwrap();
        std::fs::create_dir_all(dir.join("x9.Data").join("rdb")).unwrap();
        assert!(!persist_endnote_library_pointer(&proj, &legacy));
        assert_eq!(
            std::fs::read_to_string(proj.join("papers/endnote-library.path")).unwrap().trim(),
            enl.to_string_lossy()
        );
        let _ = std::fs::remove_dir_all(&dir);
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

    #[test]
    fn detects_prose_braces_in_endnote_docx_without_matching_para_or_tab_tags() {
        let xml = r#"<w:document><w:body><w:pPr><w:jc w:val="left"/></w:pPr><w:p><w:r><w:tab/><w:t xml:space="preserve">on {110} and </w:t></w:r><w:r><w:t>{001} facets </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/><w:instrText> ADDIN EN.CITE </w:instrText><w:fldData>e30=</w:fldData><w:fldChar w:fldCharType="separate"/><w:t>(Chen et al., 2016)</w:t><w:fldChar w:fldCharType="end"/></w:r></w:p></w:body></w:document>"#;
        assert_eq!(
            collect_docx_prose_braces(xml),
            vec!["{110}".to_string(), "{001}".to_string()]
        );
    }
}
