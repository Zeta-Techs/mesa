//! EndNote 出库：把项目 `references.bib` 转成 `papers/endnote-import.xml`。
//! 不写 EndNote 个人库，不触发 Word 插件。未选择 EndNote 交差则不生成。

use std::path::{Path, PathBuf};

const BRIDGE_PY: &str = include_str!("../resources/skills/endnote-bridge/scripts/bridge.py");

fn python_bin() -> Result<PathBuf, String> {
    crate::agents::resolve_binary("python3")
        .or_else(|| crate::agents::resolve_binary("python"))
        .ok_or_else(|| "本机找不到 python3，无法生成 EndNote 导入文件".to_string())
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
) -> Result<(), String> {
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
) -> Result<(), String> {
    let out_tmp = papers.join(format!(".ccode-endnote-{stamp}.{kind}"));
    let report_tmp = papers.join(format!(".ccode-endnote-{stamp}-{kind}.json"));
    let mut cmd = crate::process::background_command(py);
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
    let out = cmd.output().map_err(|e| format!("无法启动转换: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&out_tmp);
        let _ = std::fs::remove_file(&report_tmp);
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
    Ok(())
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
/// 返回 (RIS 路径, 库体检提示)：检出旧版导出的脏记录时提示先删再导，干净时为空。
pub fn export_ris_only(project_root: &Path) -> Result<(PathBuf, String), String> {
    let root =
        crate::paths::canonicalize_plain(project_root).map_err(|e| format!("项目目录无效: {e}"))?;
    let bib = root.join("references.bib");
    if !bib.is_file() {
        return Err("还没有 references.bib，没法生成 EndNote 导入文件".into());
    }
    let papers = root.join("papers");
    std::fs::create_dir_all(&papers).map_err(|e| format!("无法创建 papers/: {e}"))?;
    let ris = papers.join("endnote-import.ris");
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
    run_bridge(&py, &script, &bib, &papers, &stamp, "ris", &ris, &report, &root)?;
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
            if let Ok(out) = crate::process::background_command(&py)
                .arg(&script)
                .arg("--check-endnote-library")
                .arg(&enl)
                .output()
            {
                if out.status.success() {
                    health = String::from_utf8_lossy(&out.stdout).trim().to_string();
                }
            }
            let _ = std::fs::remove_file(&matcher);
        }
    }
    let _ = std::fs::remove_file(&script);
    let _ = std::fs::remove_file(&abbr);
    if !ris.is_file() {
        return Err("转换结束但没有 papers/endnote-import.ris".into());
    }
    Ok((ris, health))
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
    let ris = papers.join("endnote-import.ris");
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
        Ok(()) if enriched.is_file() => enriched.clone(),
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
/// 再扫常见安装目录；Windows 扫 Program Files 下名字带 EndNote 的文件夹。
fn find_endnote_app() -> Option<PathBuf> {
    let mut apps = Vec::new();
    #[cfg(target_os = "macos")]
    apps.extend(mdfind_endnote_apps());
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
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (path, text);
    }
}

fn launch_endnote_with_file(file: &Path) -> Result<(), String> {
    let app = find_endnote_app().ok_or_else(|| {
        "找不到 EndNote。把产物里的 papers/endnote-import.ris 拖到 EndNote 图标上（不要拖进窗口）。".to_string()
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
        let status = crate::process::background_command(&app)
            .arg(file)
            .status()
            .map_err(|e| format!("没法打开 EndNote: {e}"))?;
        if !status.success() {
            return Err("请把产物里的 papers/endnote-import.ris 拖到 EndNote 图标上。".into());
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, file);
        Err("请把 papers/endnote-import.ris 拖到 EndNote 图标上。".into())
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

#[tauri::command]
pub async fn endnote_export_xml(project_root: String) -> Result<String, String> {
    // 转换和打开 EndNote 都在后台线程，不占界面。
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::sessions::expand_tilde(&project_root);
        let root_path = Path::new(&root);
        // 精读之后同步：有引文库就按它重写，不再打开检索时的旧文件。
        let mut health = String::new();
        if root_path.join("references.bib").is_file() {
            let (_, note) = export_ris_only(root_path)?;
            health = note;
        }
        let Some(ris) = find_import_ris(root_path) else {
            return Err(
                "还没有 papers/endnote-import.ris。检索保存进项目后才会有这一份，同步只打开它，不再重新检索。"
                    .into(),
            );
        };
        copy_path_to_clipboard(&ris);
        let health_note = if health.is_empty() {
            String::new()
        } else {
            format!("\n\n{health}")
        };
        match launch_endnote_with_file(&ris) {
            Ok(()) => Ok(format!(
                "已交给 EndNote。PDF 用「打开 papers」拖到对应条目。{health_note}"
            )),
            Err(e) => Ok(format!(
                "文件在 papers/endnote-import.ris。把它拖到 EndNote 图标上（不要拖进窗口）。{e}{health_note}"
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
        let ris = std::fs::read_to_string(dir.join("papers/endnote-import.ris")).ok();
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
        let ris = std::fs::read_to_string(dir.join("papers/endnote-import.ris")).ok();
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
