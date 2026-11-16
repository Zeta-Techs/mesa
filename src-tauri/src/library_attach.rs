//! 「同步到文献库」的三档（2026-11-10 用户拍板）：只导条目 / 带 PDF / 带 PDF 和笔记，由人选。
//!
//! 这里按引文库每条的键找它在项目里的全文 PDF 与精读笔记，写成一份临时 JSON（键 → 绝对路径），
//! 交给 zotero_rtf.py / bridge.py 写进导入文件的 L1（全文）与 N1（笔记）。只读项目文件，不改名、不登记。
//! - PDF：先认 papers/included.json 那篇的 `pdf` 字段，没有再按待获取清单同一口径（标题 / DOI / PDF 开头的 DOI）在 papers/ 里找
//! - 笔记：notes/index.json 里 bibKey（或经 included.json 的 id）对上、notePath 有文件的那份 md
//! - 检索时排除的篇（decision=excluded）不找，脚本那边也整条不导

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachMode {
    /// 只导条目（默认，与以前一样）
    Items,
    /// 条目带全文 PDF
    Pdf,
    /// 条目带全文 PDF 和精读笔记
    PdfNotes,
}

impl AttachMode {
    /// 前端传 "items" / "pdf" / "notes"；没传或不认得的一律按只导条目
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("pdf") => AttachMode::Pdf,
            Some("notes") => AttachMode::PdfNotes,
            _ => AttachMode::Items,
        }
    }
}

#[derive(Debug, Serialize, PartialEq)]
struct Attach {
    #[serde(skip_serializing_if = "Option::is_none")]
    pdf: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(skip)]
    from_skim: bool,
}

/// 写好的临时文件与计数（反馈里说「带上 N 篇全文、M 篇笔记」）
#[derive(Debug)]
pub struct AttachPlan {
    pub file: PathBuf,
    pub pdfs: usize,
    pub notes: usize,
    pub skim_notes: usize,
}

impl AttachPlan {
    pub fn summary(&self, mode: AttachMode) -> String {
        match mode {
            AttachMode::Items => String::new(),
            AttachMode::Pdf => format!("带上 {} 篇全文 PDF。", self.pdfs),
            AttachMode::PdfNotes => {
                if self.skim_notes > 0 {
                    format!(
                        "带上 {} 篇全文 PDF、{} 篇精读笔记、{} 篇速读笔记。",
                        self.pdfs, self.notes, self.skim_notes
                    )
                } else {
                    format!("带上 {} 篇全文 PDF、{} 篇精读笔记。", self.pdfs, self.notes)
                }
            }
        }
    }
}

fn doi_key(raw: &str) -> String {
    let mut s = raw.trim().to_ascii_lowercase();
    for p in [
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
        "doi:",
    ] {
        if let Some(rest) = s.strip_prefix(p) {
            s = rest.trim().to_string();
            break;
        }
    }
    s.trim_end_matches(['.', ',', ';']).to_string()
}

fn title_key(raw: &str) -> String {
    raw.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

fn read_rows(path: &Path, list_key: &str) -> Vec<serde_json::Value> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(serde_json::Value::Array(rows)) => rows,
        Ok(serde_json::Value::Object(mut o)) => o
            .remove(list_key)
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn s<'a>(row: &'a serde_json::Value, key: &str) -> &'a str {
    row.get(key).and_then(|v| v.as_str()).unwrap_or("").trim()
}

/// 项目里的相对路径 → 根内、真实存在的文件（绝对路径）。越出项目根的不认
fn project_file(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty() {
        return None;
    }
    let path = if Path::new(&rel).is_absolute() {
        PathBuf::from(&rel)
    } else {
        root.join(&rel)
    };
    let real = crate::paths::canonicalize_plain(&path).ok()?;
    (real.is_file() && crate::paths::path_within_path(&real, root)).then_some(real)
}

/// 按引文库算出每条要挂的 PDF / 笔记，写到 dest。只导条目时不写，返回 None
pub fn write_plan(
    root: &Path,
    bib: &Path,
    mode: AttachMode,
    dest: &Path,
) -> Result<Option<AttachPlan>, String> {
    write_plan_inner(root, bib, mode, dest, false)
}

/// EndNote 专用：RefMan RIS 过滤器会把 L1 里的连续空格折成单空格导致找文件失败并污染 Notes，
/// 含双空格的 PDF 先在系统临时目录建单空格硬链再写进计划
pub fn write_endnote_plan(
    root: &Path,
    bib: &Path,
    mode: AttachMode,
    dest: &Path,
) -> Result<Option<AttachPlan>, String> {
    write_plan_inner(root, bib, mode, dest, true)
}

fn write_plan_inner(
    root: &Path,
    bib: &Path,
    mode: AttachMode,
    dest: &Path,
    endnote_single_space_pdf: bool,
) -> Result<Option<AttachPlan>, String> {
    if mode == AttachMode::Items {
        return Ok(None);
    }
    let root = crate::paths::canonicalize_plain(root).map_err(|e| format!("项目目录无效: {e}"))?;
    let text = std::fs::read_to_string(bib).map_err(|e| format!("读不了引文库: {e}"))?;
    let mut map = plan_map(&root, &text, mode, |items| {
        crate::lit_watch::match_papers_pdfs_readonly(&root, items)
    });
    if endnote_single_space_pdf {
        for attach in map.values_mut() {
            if let Some(pdf) = attach.pdf.as_deref() {
                attach.pdf = Some(stage_endnote_pdf_if_needed(pdf));
            }
        }
    }
    let pdfs = map.values().filter(|a| a.pdf.is_some()).count();
    let notes = map
        .values()
        .filter(|a| a.note.is_some() && !a.from_skim)
        .count();
    let skim_notes = map
        .values()
        .filter(|a| a.note.is_some() && a.from_skim)
        .count();
    let json = serde_json::to_string(&map).map_err(|e| e.to_string())?;
    crate::storage::atomic_write(dest, json.as_bytes(), true)?;
    Ok(Some(AttachPlan {
        file: dest.to_path_buf(),
        pdfs,
        notes,
        skim_notes,
    }))
}

fn collapse_spaces(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_space = false;
    for ch in raw.chars() {
        if ch == ' ' {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            prev_space = false;
            out.push(ch);
        }
    }
    out
}

fn prune_stale_stage_dirs(base: &Path) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    let Some(cutoff) = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(24 * 3600))
    else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|mtime| mtime < cutoff);
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// EndNote 2025 的 RefMan RIS 过滤器开启 Delete Multiple Spaces：L1 路径含连续空格（如标题冒号清洗出的
/// `MoB₂  Extraordinary.pdf`）时按单空格找文件失败，既漏挂 PDF 又把残路径写进 Notes（2026-11-14 HER 实证）。
/// 这里只对含连续空格的路径在系统临时目录建单空格硬链（跨盘退回复制），不碰项目工作树。
fn stage_endnote_pdf_if_needed(raw_path: &str) -> String {
    if !raw_path.contains("  ") {
        return raw_path.to_string();
    }
    let src = Path::new(raw_path);
    let Some(name) = src.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return raw_path.to_string();
    };
    let clean_name = collapse_spaces(&name).trim().to_string();
    if clean_name.is_empty() {
        return raw_path.to_string();
    }
    let base = std::env::temp_dir().join("ccode-endnote-attach");
    prune_stale_stage_dirs(&base);
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(raw_path.as_bytes());
    let digest = hasher.finalize();
    let short: String = digest[..6].iter().map(|b| format!("{b:02x}")).collect();
    let dir = base.join(short);
    if std::fs::create_dir_all(&dir).is_err() {
        return raw_path.to_string();
    }
    let staged = dir.join(clean_name);
    if staged.to_string_lossy().contains("  ") {
        return raw_path.to_string();
    }
    let _ = std::fs::remove_file(&staged);
    if std::fs::hard_link(src, &staged)
        .or_else(|_| std::fs::copy(src, &staged).map(|_| ()))
        .is_ok()
    {
        staged.to_string_lossy().into_owned()
    } else {
        raw_path.to_string()
    }
}

fn split_md_table_row(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    let inner = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let inner = if inner.ends_with('|') && !inner.ends_with(r"\|") {
        &inner[..inner.len() - 1]
    } else {
        inner
    };
    let mut cells = Vec::new();
    let mut cur = String::new();
    let mut chars = inner.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' && chars.peek() == Some(&'|') {
            cur.push('|');
            chars.next();
        } else if ch == '|' {
            cells.push(cur.trim().to_string());
            cur.clear();
        } else {
            cur.push(ch);
        }
    }
    cells.push(cur.trim().to_string());
    cells
}

fn is_md_separator_row(cells: &[String]) -> bool {
    !cells.is_empty()
        && cells.iter().all(|c| {
            let s = c.trim().trim_matches(':');
            s.is_empty() || (s.len() >= 2 && s.chars().all(|ch| ch == '-'))
        })
}

fn norm_skim_bib_key(raw: &str) -> String {
    let mut s = raw.trim();
    s = s.trim_matches('`').trim();
    if let Some(inner) = s.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        s = inner.trim();
    }
    s.trim_start_matches('@').trim().to_string()
}

/// 解析 `notes/skim.md`（及分路 `skim-*.md`）里的速读表行：返回 bibKey → Markdown 正文小节串。
/// 综述回路第一轮研究论文只速读不建单篇 `notes/*.md`（`notePath: null, skimmed: true`），
/// 同步「带 PDF 和笔记」时给这些未展开为单篇笔记的文献补挂速读记录（写临时文件，不写进项目 `notes/`）。
fn parse_skim_notes(root: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(text) = std::fs::read_to_string(root.join("notes/skim.md")) else {
        return out;
    };
    let mut fenced = false;
    let mut headers: Option<Vec<String>> = None;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
            headers = None;
            continue;
        }
        if fenced {
            continue;
        }
        if !t.starts_with('|') {
            headers = None;
            continue;
        }
        let cells = split_md_table_row(t);
        if is_md_separator_row(&cells) {
            continue;
        }
        let Some(cols) = headers.as_ref() else {
            headers = Some(cells);
            continue;
        };
        let Some(first) = cells.first() else {
            continue;
        };
        let key = norm_skim_bib_key(first);
        if key.is_empty() {
            continue;
        }
        let mut sections = Vec::new();
        for (idx, val) in cells.iter().enumerate().skip(1) {
            let v = val.trim();
            if v.is_empty() || v == "-" || v == "—" {
                continue;
            }
            let head = cols.get(idx).map(|h| h.trim()).unwrap_or("");
            if head.is_empty() || head == "年份" || head.eq_ignore_ascii_case("year") {
                continue;
            }
            if head == "全文" || head.eq_ignore_ascii_case("fulltext") {
                if v == "有" || v.eq_ignore_ascii_case("yes") || v.eq_ignore_ascii_case("fulltext") {
                    continue;
                }
                sections.push(format!("## 全文状态\n\n{v}"));
                continue;
            }
            sections.push(format!("## {head}\n\n{v}"));
        }
        if !sections.is_empty() {
            out.entry(key).or_insert_with(|| sections.join("\n\n"));
        }
    }
    out
}

fn is_reader_empty_skeleton(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    let mut has_h2 = false;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("> 来源") || t.starts_with(">#") {
            continue;
        }
        if t.starts_with("## ") || t.starts_with("### ") {
            has_h2 = true;
            continue;
        }
        if t.starts_with("# ") {
            continue;
        }
        return false;
    }
    has_h2
}

fn stage_skim_note(root: &Path, key: &str, title: &str, body_sections: &str) -> Option<String> {
    let base = std::env::temp_dir().join("ccode-skim-notes");
    prune_stale_stage_dirs(&base);
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(root.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let short: String = digest[..6].iter().map(|b| format!("{b:02x}")).collect();
    let dir = base.join(short);
    std::fs::create_dir_all(&dir).ok()?;
    let safe_key: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let dest = dir.join(format!(
        "{}.md",
        if safe_key.is_empty() { "note" } else { &safe_key }
    ));
    let clean_title = title.replace(['{', '}'], "");
    let clean_title = clean_title.trim();
    let head = if clean_title.is_empty() { key } else { clean_title };
    let content = format!("# {head}\n\n> 来源：notes/skim.md（速读记录）\n\n{body_sections}\n");
    crate::storage::atomic_write(&dest, content.as_bytes(), true).ok()?;
    Some(dest.to_string_lossy().into_owned())
}

/// 纯计算：键 → 要挂的东西。找 PDF 的那一步由调用方给（测试里不扫下载登记）
fn plan_map(
    root: &Path,
    bib_text: &str,
    mode: AttachMode,
    find_pdfs: impl Fn(&[crate::lit_watch::ToFetchProbe]) -> Vec<Option<String>>,
) -> std::collections::BTreeMap<String, Attach> {
    let entries = crate::citation::bib_key_doi_title(bib_text);
    let rows = read_rows(&root.join("papers/included.json"), "papers");
    // included.json：DOI / 标题 → 行
    let mut by_doi: HashMap<String, &serde_json::Value> = HashMap::new();
    let mut by_title: HashMap<String, &serde_json::Value> = HashMap::new();
    for row in &rows {
        let doi = doi_key(if s(row, "doi").is_empty() { s(row, "id") } else { s(row, "doi") });
        if doi.starts_with("10.") {
            by_doi.entry(doi).or_insert(row);
        }
        let t = title_key(s(row, "title"));
        if t.len() >= 8 {
            by_title.entry(t).or_insert(row);
        }
    }
    let row_of = |doi: &Option<String>, title: &Option<String>| -> Option<&serde_json::Value> {
        doi.as_deref()
            .map(doi_key)
            .and_then(|d| by_doi.get(&d).copied())
            .or_else(|| title.as_deref().map(title_key).and_then(|t| by_title.get(&t).copied()))
    };
    // notes/index.json：bibKey → notePath；没写 bibKey 的经 id 回到 included.json 那篇
    let note_rows = if mode == AttachMode::PdfNotes {
        read_rows(&root.join("notes/index.json"), "papers")
    } else {
        Vec::new()
    };
    let skim_by_key = if mode == AttachMode::PdfNotes {
        parse_skim_notes(root)
    } else {
        HashMap::new()
    };
    let mut note_by_key: HashMap<String, String> = HashMap::new();
    let mut note_by_id: HashMap<String, String> = HashMap::new();
    for row in &note_rows {
        let path = s(row, "notePath");
        if path.is_empty() {
            continue;
        }
        if !s(row, "bibKey").is_empty() {
            note_by_key.entry(s(row, "bibKey").to_string()).or_insert_with(|| path.to_string());
        }
        if !s(row, "id").is_empty() {
            note_by_id.entry(s(row, "id").to_string()).or_insert_with(|| path.to_string());
        }
    }

    let mut out = std::collections::BTreeMap::new();
    let mut used_pdfs: HashSet<PathBuf> = HashSet::new();
    let mut probes: Vec<(String, crate::lit_watch::ToFetchProbe)> = Vec::new();
    for (key, doi, title) in &entries {
        let row = row_of(doi, title);
        if row.is_some_and(|r| s(r, "decision") == "excluded") {
            continue;
        }
        let mut attach = Attach {
            pdf: None,
            note: None,
            from_skim: false,
        };
        if let Some(pdf) = row.and_then(|r| project_file(root, s(r, "pdf"))) {
            if used_pdfs.insert(pdf.clone()) {
                attach.pdf = Some(pdf.to_string_lossy().into_owned());
            }
        }
        if attach.pdf.is_none() {
            probes.push((
                key.clone(),
                crate::lit_watch::ToFetchProbe {
                    title: title.clone().unwrap_or_default(),
                    url: doi.clone().unwrap_or_default(),
                },
            ));
        }
        if mode == AttachMode::PdfNotes {
            let single_note = note_by_key
                .get(key)
                .or_else(|| row.and_then(|r| note_by_id.get(s(r, "id"))))
                .and_then(|p| project_file(root, p))
                .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")));
            let skim_body = skim_by_key.get(key).or_else(|| {
                skim_by_key
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(key))
                    .map(|(_, v)| v)
            });
            let use_single = single_note
                .as_ref()
                .filter(|p| skim_body.is_none() || !is_reader_empty_skeleton(p));
            if let Some(p) = use_single {
                attach.note = Some(p.to_string_lossy().into_owned());
            } else if let Some(body) = skim_body {
                let display_title = title
                    .as_deref()
                    .filter(|t| !t.trim().is_empty())
                    .or_else(|| row.map(|r| s(r, "title")).filter(|t| !t.is_empty()))
                    .unwrap_or(key);
                if let Some(staged) = stage_skim_note(root, key, display_title, body) {
                    attach.note = Some(staged);
                    attach.from_skim = true;
                }
            }
        }
        out.insert(key.clone(), attach);
    }
    if !probes.is_empty() {
        let items: Vec<crate::lit_watch::ToFetchProbe> = probes
            .iter()
            .map(|(_, p)| crate::lit_watch::ToFetchProbe { title: p.title.clone(), url: p.url.clone() })
            .collect();
        for ((key, _), hit) in probes.iter().zip(find_pdfs(&items)) {
            let Some(name) = hit else { continue };
            let Some(pdf) = project_file(root, &format!("papers/{name}")) else { continue };
            if !used_pdfs.insert(pdf.clone()) {
                continue;
            }
            if let Some(a) = out.get_mut(key) {
                a.pdf = Some(pdf.to_string_lossy().into_owned());
            }
        }
    }
    out.retain(|_, a| a.pdf.is_some() || a.note.is_some());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-attach-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("papers")).unwrap();
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        crate::paths::canonicalize_plain(&dir).unwrap()
    }

    const BIB: &str = "@article{wang2021,\n  title = {Boride-derived oxygen evolution catalysts},\n  doi = {10.1038/s41467-021-26307-6},\n}\n\
@article{li2019,\n  title = {Ternary {Mo}2NiB2 as a superior bifunctional electrocatalyst},\n  doi = {10.1021/acsaem.9b00001},\n}\n\
@article{gone2020,\n  title = {Electrocatalysts based on transition metal borides and borates},\n  doi = {10.1002/chem.202000880},\n}\n";

    fn setup() -> PathBuf {
        let dir = tmp("plan");
        std::fs::write(dir.join("papers/Wang2021.pdf"), b"%PDF-1.4").unwrap();
        std::fs::write(dir.join("papers/borates.pdf"), b"%PDF-1.4").unwrap();
        std::fs::write(
            dir.join("papers/included.json"),
            r#"[{"id":"10.1038/s41467-021-26307-6","doi":"10.1038/s41467-021-26307-6","title":"Boride-derived oxygen evolution catalysts","decision":"included","pdf":"papers/Wang2021.pdf"},
                {"id":"W2","doi":"10.1021/acsaem.9b00001","title":"Ternary Mo2NiB2 as a superior bifunctional electrocatalyst","decision":"included"},
                {"id":"10.1002/chem.202000880","doi":"10.1002/chem.202000880","title":"Electrocatalysts based on transition metal borides and borates","decision":"excluded","pdf":"papers/borates.pdf"}]"#,
        )
        .unwrap();
        std::fs::write(dir.join("notes/wang.md"), "# Wang\n\n## 一句话总结\n\n好。\n").unwrap();
        std::fs::write(dir.join("notes/li.md"), "# Li\n").unwrap();
        std::fs::write(
            dir.join("notes/index.json"),
            r#"[{"id":"10.1038/s41467-021-26307-6","bibKey":"wang2021","notePath":"notes/wang.md"},
                {"id":"W2","notePath":"notes/li.md"},
                {"id":"10.1002/chem.202000880","bibKey":"gone2020","notePath":"notes/wang.md"}]"#,
        )
        .unwrap();
        dir
    }

    #[test]
    fn pdf_mode_uses_included_pdf_then_matcher_and_skips_excluded() {
        let dir = setup();
        std::fs::write(dir.join("papers/ternary.pdf"), b"%PDF-1.4").unwrap();
        let map = plan_map(&dir, BIB, AttachMode::Pdf, |items| {
            // 只有没写 pdf 字段的那篇交给清单口径去找；排除的那篇不找
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].url, "10.1021/acsaem.9b00001");
            vec![Some("ternary.pdf".into())]
        });
        assert_eq!(map.len(), 2);
        assert!(map["wang2021"].pdf.as_deref().unwrap().ends_with("Wang2021.pdf"));
        assert!(map["li2019"].pdf.as_deref().unwrap().ends_with("ternary.pdf"));
        assert!(map.values().all(|a| a.note.is_none()));
        assert!(!map.contains_key("gone2020"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn notes_mode_pairs_by_bib_key_or_included_id() {
        let dir = setup();
        let map = plan_map(&dir, BIB, AttachMode::PdfNotes, |items| vec![None; items.len()]);
        assert!(map["wang2021"].note.as_deref().unwrap().ends_with("wang.md"));
        // 没写 bibKey：经 id → included.json 那篇的 DOI 对回 li2019
        assert!(map["li2019"].note.as_deref().unwrap().ends_with("li.md"));
        assert!(map["li2019"].pdf.is_none());
        assert!(!map.contains_key("gone2020"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn files_outside_project_or_missing_are_not_attached() {
        let dir = setup();
        std::fs::write(
            dir.join("papers/included.json"),
            r#"[{"id":"a","doi":"10.1038/s41467-021-26307-6","title":"x","decision":"included","pdf":"../outside.pdf"},
                {"id":"b","doi":"10.1021/acsaem.9b00001","title":"y","decision":"included","pdf":"papers/missing.pdf"}]"#,
        )
        .unwrap();
        let map = plan_map(&dir, BIB, AttachMode::Pdf, |items| vec![None; items.len()]);
        assert!(map.is_empty(), "{map:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 两条通道写出的导入文件：挂上的全文路径原样、笔记 Zotero 进 N1（HTML）、EndNote 进 RN（一行）；排除的篇整条不在
    #[test]
    fn both_channels_write_pdf_and_note_lines() {
        let dir = tmp("ris");
        std::fs::write(
            dir.join("references.bib"),
            "@article{keep,\n  title = {Amorphous cobalt boride as a nonprecious catalyst},\n  author = {Gupta, S.},\n  year = {2016},\n}\n\
             @article{gone,\n  title = {Removed borate review for the oxygen evolution reaction},\n  author = {Cui, L.},\n  year = {2020},\n}\n",
        )
        .unwrap();
        std::fs::write(dir.join("papers/Co  B.pdf"), b"%PDF-1.4").unwrap();
        std::fs::write(
            dir.join("papers/included.json"),
            r#"[{"id":"k","title":"Amorphous cobalt boride as a nonprecious catalyst","decision":"included","pdf":"papers/Co  B.pdf"},
                {"id":"g","title":"Removed borate review for the oxygen evolution reaction","decision":"excluded"}]"#,
        )
        .unwrap();
        std::fs::write(dir.join("notes/keep.md"), "# Co2B\n\n## 一句话总结\n\n- **非晶** Co2B 很好\n").unwrap();
        std::fs::write(dir.join("notes/index.json"), r#"[{"id":"k","bibKey":"keep","notePath":"notes/keep.md"}]"#).unwrap();

        let zotero = crate::zotero::refresh_library_ris(&dir, AttachMode::PdfNotes);
        if zotero.as_ref().is_err_and(|e| e.contains("找不到 python")) {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let (ris, note) = zotero.expect("zotero ris");
        let text = std::fs::read_to_string(ris.unwrap()).unwrap();
        assert!(note.contains("带上 1 篇全文 PDF、1 篇精读笔记"), "{note}");
        // 分段 join：Windows 上写出的是 `papers\Co  B.pdf`，整段 "papers/…" 拼出混合分隔符对不上
        assert!(text.contains(&format!("L1  - {}", dir.join("papers").join("Co  B.pdf").display())), "{text}");
        assert!(text.contains("N1  - <h1>Co2B</h1><h2>一句话总结</h2><ul><li><strong>非晶</strong> Co2B 很好</li></ul>"), "{text}");
        assert!(!text.contains("Removed borate"), "{text}");

        let (ris, note) = crate::endnote::export_ris_only(&dir, AttachMode::PdfNotes).expect("endnote ris");
        let text = std::fs::read_to_string(ris).unwrap();
        assert!(note.contains("带上 1 篇全文 PDF、1 篇精读笔记"), "{note}");
        // EndNote RefMan RIS 会把 L1 里的连续空格折成单空格：含双空格的 Co  B.pdf 须经单空格硬链路径写出且文件可读
        let l1 = text
            .lines()
            .find_map(|l| l.trim_end_matches('\r').strip_prefix("L1  - "))
            .expect("endnote L1 line");
        assert!(!l1.contains("  "), "EndNote L1 still has double space: {l1}");
        assert!(l1.ends_with("Co B.pdf"), "{l1}");
        assert_eq!(std::fs::read(l1).unwrap(), b"%PDF-1.4");
        assert!(text.contains("LB  - keep\r\n"), "{text}");
        assert!(text.contains("RN  - Co2B 【一句话总结】 · 非晶 Co2B 很好\r\n"), "{text}");
        assert!(!text.contains("Removed borate"), "{text}");

        // 只导条目：两份都没有 L1 / N1 / RN
        let (ris, _) = crate::zotero::refresh_library_ris(&dir, AttachMode::Items).unwrap();
        let text = std::fs::read_to_string(ris.unwrap()).unwrap();
        assert!(!text.contains("L1  -") && !text.contains("N1  -"), "{text}");
        let (ris, _) = crate::endnote::export_ris_only(&dir, AttachMode::Pdf).unwrap();
        let text = std::fs::read_to_string(ris).unwrap();
        assert!(text.contains("L1  -") && !text.contains("RN  -"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 干跑用（不进常规基线）：MESA_ATTACH_DRYRUN=<项目目录> 时按三档各写一份导入文件到 papers/dryrun-*.ris
    #[test]
    #[ignore]
    fn dryrun_write_import_files() {
        let Ok(root) = std::env::var("MESA_ATTACH_DRYRUN") else { return };
        let root = PathBuf::from(root);
        for (mode, name) in [
            (AttachMode::Items, "items"),
            (AttachMode::Pdf, "pdf"),
            (AttachMode::PdfNotes, "notes"),
        ] {
            let (ris, note) = crate::zotero::refresh_library_ris(&root, mode).unwrap();
            std::fs::copy(ris.unwrap(), root.join(format!("papers/dryrun-zotero-{name}.ris"))).unwrap();
            println!("zotero {name}: {note}");
            let (ris, note) = crate::endnote::export_ris_only(&root, mode).unwrap();
            std::fs::copy(ris, root.join(format!("papers/dryrun-endnote-{name}.ris"))).unwrap();
            println!("endnote {name}: {note}");
        }
    }

    #[test]
    fn skim_table_fallback_attaches_notes_for_skimmed_papers() {
        let dir = setup();
        // li2019 改为未精读（notePath: null, skimmed: true），但 notes/skim.md 有速读行
        std::fs::write(
            dir.join("notes/index.json"),
            r#"[{"id":"10.1038/s41467-021-26307-6","bibKey":"wang2021","notePath":"notes/wang.md"},
                {"id":"W2","bibKey":"li2019","notePath":null,"skimmed":true}]"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("notes/skim.md"),
            "# 速读表\n\n| 键 | 年份 | 主题 | 研究问题 | 方法 | 主要结论 | 新在哪 | 全文 |\n|---|---|---|---|---|---|---|---|\n| @li2019 | 2019 | 三元硼化物 | Mo2NiB2 是否兼具 HER/OER 活性 | 电弧熔炼 \\| LSV | η10 显著降低 | 首个三元 MAB 硼化物双功能体系 | 有 |\n",
        )
        .unwrap();
        std::fs::write(dir.join("references.bib"), BIB).unwrap();
        let dest = dir.join("plan.json");
        let plan = write_plan(&dir, &dir.join("references.bib"), AttachMode::PdfNotes, &dest)
            .unwrap()
            .unwrap();
        assert_eq!(plan.notes, 1);
        assert_eq!(plan.skim_notes, 1);
        assert!(plan.summary(AttachMode::PdfNotes).contains("1 篇精读笔记、1 篇速读笔记"));
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&dest).unwrap()).unwrap();
        let skim_path = raw["li2019"]["note"].as_str().expect("li2019 skim note path");
        assert!(
            !Path::new(skim_path).starts_with(&dir),
            "速读临时文件不得写进项目 notes/ 目录: {skim_path}"
        );
        let skim_md = std::fs::read_to_string(skim_path).unwrap();
        assert!(skim_md.contains("# Ternary Mo2NiB2 as a superior bifunctional electrocatalyst"));
        assert!(skim_md.contains("## 研究问题\n\nMo2NiB2 是否兼具 HER/OER 活性"));
        assert!(skim_md.contains("## 方法\n\n电弧熔炼 | LSV"));
        assert!(!skim_md.contains("## 年份"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn items_mode_writes_nothing() {
        let dir = setup();
        let dest = dir.join("plan.json");
        assert!(write_plan(&dir, &dir.join("references.bib"), AttachMode::Items, &dest)
            .unwrap()
            .is_none());
        assert!(!dest.exists());
        assert_eq!(AttachMode::parse(Some("notes")), AttachMode::PdfNotes);
        assert_eq!(AttachMode::parse(Some("whatever")), AttachMode::Items);
        assert_eq!(AttachMode::parse(None), AttachMode::Items);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
