//! 引用健康检查（评审可信度证据）：扫描目录下 .md 文件中的 Quarto/Pandoc 引用键
//!（`[@key]` / `[@k1; @k2]` / `[-@key]`），对照 references.bib 的条目键给出可解析统计。
//! 纯只读扫描，不走 AI；路径口径同 pdf.rs——canonicalize 后必须落在注册项目根或
//! 工作区工作树/主仓内。

use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// 扫描上限：防巨型目录拖慢评审打开（超出部分不计入统计，宁缺勿滥）
const MAX_MD_FILES: usize = 200;
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CitationHealthDto {
    /// 文中出现的去重引用键总数
    pub total_refs: usize,
    /// 在 bib 中找到条目的键数
    pub resolved: usize,
    /// bib 中缺失的键（排序去重）
    pub missing: Vec<String>,
    /// 是否找到 references.bib（根目录或 manuscript/ 下）
    pub bib_found: bool,
}

/// 提取一段 markdown 文本里的引用键（去重排序）：
/// 只认方括号引用段，段内按分号拆多键，键名允许字母数字与 `_- . :`
pub(crate) fn extract_cite_keys(text: &str) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let Some(close) = after.find(']') else { break };
        let seg = &after[..close];
        // 引用段不含嵌套 '['：含了说明前面的 '[' 是未闭合的普通括号，越过它继续找
        if seg.contains('[') {
            rest = after;
            continue;
        }
        if seg.contains('@') {
            for part in seg.split(';') {
                let part = part.trim();
                // 抑制引用 [-@key]：剥前导减号后与正常引用同口径
                let part = part.strip_prefix('-').unwrap_or(part);
                let Some(rest_key) = part.strip_prefix('@') else {
                    continue;
                };
                let key: String = rest_key
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
                    .collect();
                if !key.is_empty() {
                    keys.insert(key);
                }
            }
        }
        rest = &after[close + 1..];
    }
    keys
}

/// 提取 bib 文本的条目键：`@类型{键,`（@comment/@preamble 等非条目行的伪键无害——
/// 只有被正文引用的键才参与比对）
pub(crate) fn extract_bib_keys(text: &str) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    for line in text.lines() {
        let t = line.trim_start();
        if !t.starts_with('@') {
            continue;
        }
        let Some(open) = t.find('{') else { continue };
        let key: String = t[open + 1..].chars().take_while(|c| *c != ',').collect();
        let key = key.trim();
        if !key.is_empty() {
            keys.insert(key.to_string());
        }
    }
    keys
}

/// 任务书/人工请求里的「[@bib键]」是写法说明，不是正文引用。
fn skip_citation_md(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "task.md" || n == "help-wanted.md" || n == "review-notes.md"
}

/// 递归收集 .md 文件：跳过隐藏目录（.git 等）与 node_modules，数量/单文件大小有界
fn collect_md_files(dir: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_MD_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_MD_FILES {
            return;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            collect_md_files(&path, out);
        } else if name.to_lowercase().ends_with(".md")
            && meta.len() <= MAX_FILE_BYTES
            && !skip_citation_md(&name)
        {
            out.push(path);
        }
    }
}

/// references.bib 定位：根目录优先，其次 manuscript/ 下
fn find_bib(root: &Path) -> Option<PathBuf> {
    for candidate in [
        root.join("references.bib"),
        root.join("manuscript").join("references.bib"),
    ] {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn check_citation_health_sync(path: &str) -> Result<CitationHealthDto, String> {
    let root = PathBuf::from(crate::sessions::expand_tilde(path))
        .canonicalize()
        .map_err(|e| format!("目录不存在或不可读: {e}"))?;
    if !root.is_dir() {
        return Err("引用健康检查的目标必须是目录".into());
    }
    // 白名单（同 pdf.rs 口径）：注册项目根 / 工作区工作树 / 工作区主仓；来源失败静默跳过（宁缺勿滥）
    let canon = |p: &PathBuf| p.canonicalize().ok();
    let mut roots: Vec<PathBuf> = crate::projects::project_roots_and_resources()
        .0
        .iter()
        .filter_map(canon)
        .collect();
    roots.extend(
        crate::workspaces::worktree_rows()
            .into_iter()
            .flat_map(|w| [w.worktree_path, w.repo_path])
            .filter_map(|p| canon(&PathBuf::from(p))),
    );
    check_citation_health_in(&root, &roots)
}

/// 核心扫描：白名单根由调用方注入。拆出来是为了让测试注入临时目录——
/// 单测若经本机真实 app.db 取白名单，会随用户注册的项目读其档案卡；
/// 档案卡在 iCloud 等慢文件系统上 open() 可能内核级阻塞，整条测试线挂死（2026-09-13 实证）。
fn check_citation_health_in(root: &Path, roots: &[PathBuf]) -> Result<CitationHealthDto, String> {
    if !roots
        .iter()
        .any(|r| crate::paths::path_within_path(root, r))
    {
        return Err("路径不在项目/工作区范围内，拒绝扫描".into());
    }

    let mut md_files = Vec::new();
    collect_md_files(root, &mut md_files);
    let mut cited = BTreeSet::new();
    for f in &md_files {
        if let Ok(text) = fs::read_to_string(f) {
            cited.extend(extract_cite_keys(&text));
        }
    }

    let bib = find_bib(root);
    let bib_keys = bib
        .as_ref()
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|text| extract_bib_keys(&text))
        .unwrap_or_default();
    let missing: Vec<String> = cited
        .iter()
        .filter(|k| !bib_keys.contains(*k))
        .cloned()
        .collect();
    Ok(CitationHealthDto {
        total_refs: cited.len(),
        resolved: cited.len() - missing.len(),
        missing,
        bib_found: bib.is_some(),
    })
}

#[tauri::command]
pub async fn check_citation_health(path: String) -> Result<CitationHealthDto, String> {
    tauri::async_runtime::spawn_blocking(move || check_citation_health_sync(&path))
        .await
        .map_err(|e| format!("引用健康检查失败: {e}"))?
}

/// 聊天回复里的引用键 → 条目信息（2026-10-21，聊天层引用胶囊）。只读 bib，不改。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CiteEntryDto {
    pub key: String,
    /// 作者姓（家族名）按顺序；机构作者整名
    pub authors: Vec<String>,
    pub year: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CiteLookupDto {
    pub bib_found: bool,
    pub entries: Vec<CiteEntryDto>,
}

const CITE_LOOKUP_MAX_KEYS: usize = 100;
const BIB_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// BibTeX 字段值：`name = {…}`（花括号可嵌套）/ `"…"` / 裸值（数字、宏名）。字段名大小写不敏感。
fn bib_field(entry: &str, name: &str) -> Option<String> {
    let lower = entry.to_ascii_lowercase();
    let bytes = entry.as_bytes();
    let mut from = 0;
    while let Some(pos) = lower[from..].find(name) {
        let at = from + pos;
        from = at + name.len();
        let before_ok = at == 0 || matches!(bytes[at - 1], b' ' | b'\t' | b'\n' | b'\r' | b',' | b'{');
        let rest = entry[from..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }
        let value = rest[1..].trim_start();
        let mut chars = value.char_indices();
        return match chars.next() {
            Some((_, '{')) => {
                let mut depth = 1;
                for (i, c) in chars {
                    match c {
                        '{' => depth += 1,
                        '}' => {
                            depth -= 1;
                            if depth == 0 {
                                return Some(value[1..i].to_string());
                            }
                        }
                        _ => {}
                    }
                }
                None
            }
            Some((_, '"')) => {
                let mut depth = 0;
                for (i, c) in chars {
                    match c {
                        '{' => depth += 1,
                        '}' => depth -= 1,
                        '"' if depth <= 0 => return Some(value[1..i].to_string()),
                        _ => {}
                    }
                }
                None
            }
            Some(_) => {
                let end = value.find([',', '\n', '}']).unwrap_or(value.len());
                Some(value[..end].trim().to_string())
            }
            None => None,
        };
    }
    None
}

/// 去掉 BibTeX 的保护花括号与简单 LaTeX 命令（\textit、\"o 这类），合并空白
fn bib_plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '{' | '}' => {}
            '\\' => match chars.peek().copied() {
                Some(n) if n.is_ascii_alphabetic() => {
                    while chars.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
                        chars.next();
                    }
                }
                Some('&') | Some('%') | Some('$') | Some('_') | Some('#') => {
                    out.push(chars.next().unwrap_or(' '));
                }
                Some(_) => {
                    // 重音记号 \" \' \^ 等：去掉记号，留后面的字母
                    chars.next();
                }
                None => {}
            },
            '~' => out.push(' '),
            c => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// author 字段 → 各作者的姓：「Smith, John」取逗号前；「John Smith」取最后一个词；
/// 整个包在花括号里的是机构名，整名保留；中文名（无空格）整名
fn bib_authors(raw: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    // 按顶层（花括号外）的「 and 」切
    for w in raw.split_inclusive(char::is_whitespace) {
        let trimmed = w.trim();
        if depth == 0 && trimmed.eq_ignore_ascii_case("and") && !cur.trim().is_empty() {
            parts.push(std::mem::take(&mut cur));
            continue;
        }
        depth += w.matches('{').count() as i32 - w.matches('}').count() as i32;
        cur.push_str(w);
    }
    if !cur.trim().is_empty() {
        parts.push(cur);
    }
    parts
        .iter()
        .map(|p| {
            let t = p.trim();
            if t.starts_with('{') && t.ends_with('}') {
                return bib_plain(t);
            }
            let plain = bib_plain(t);
            if let Some((family, _)) = plain.split_once(',') {
                return family.trim().to_string();
            }
            plain.split_whitespace().last().unwrap_or("").to_string()
        })
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("others"))
        .collect()
}

fn bib_entry_dto(entry: &str) -> Option<CiteEntryDto> {
    let head = entry.trim_start();
    if !head.starts_with('@') {
        return None;
    }
    let kind = head[1..].split('{').next().unwrap_or("").trim().to_ascii_lowercase();
    if matches!(kind.as_str(), "comment" | "preamble" | "string") {
        return None;
    }
    let key = head.split_once('{')?.1.split(',').next()?.trim().to_string();
    if key.is_empty() {
        return None;
    }
    let year = bib_field(entry, "year")
        .map(|y| bib_plain(&y))
        .or_else(|| bib_field(entry, "date").map(|d| d.chars().take(4).collect()))
        .filter(|y| !y.is_empty());
    let title = bib_field(entry, "title")
        .map(|t| bib_plain(&t).chars().take(240).collect::<String>())
        .filter(|t| !t.is_empty());
    let authors = bib_field(entry, "author")
        .or_else(|| bib_field(entry, "editor"))
        .map(|a| bib_authors(&a))
        .unwrap_or_default();
    Some(CiteEntryDto { key, authors, year, title })
}

/// 在会话目录及其上级（到白名单根为止）找 references.bib，取所问各键的条目。
/// 目录不在注册项目 / 工作区内时不读，bib_found=false（与引用健康检查同一白名单）
fn cite_lookup_in(dir: &Path, roots: &[PathBuf], keys: &[String]) -> CiteLookupDto {
    let empty = CiteLookupDto { bib_found: false, entries: Vec::new() };
    let Some(root) = roots
        .iter()
        .filter(|r| crate::paths::path_within_path(dir, r))
        .max_by_key(|r| r.as_os_str().len())
    else {
        return empty;
    };
    let Some(bib) = dir
        .ancestors()
        .take_while(|a| crate::paths::path_within_path(a, root))
        .find_map(find_bib)
    else {
        return empty;
    };
    let text = match fs::metadata(&bib) {
        Ok(meta) if meta.len() <= BIB_MAX_BYTES => fs::read_to_string(&bib).unwrap_or_default(),
        _ => String::new(),
    };
    let wanted: BTreeSet<&str> = keys
        .iter()
        .take(CITE_LOOKUP_MAX_KEYS)
        .map(|k| k.as_str())
        .collect();
    let mut entries = Vec::new();
    let mut current = String::new();
    let mut flush = |chunk: &str| {
        if let Some(e) = bib_entry_dto(chunk) {
            if wanted.contains(e.key.as_str()) && !entries.iter().any(|x: &CiteEntryDto| x.key == e.key) {
                entries.push(e);
            }
        }
    };
    for line in text.lines() {
        if line.trim_start().starts_with('@') && !current.is_empty() {
            flush(&current);
            current.clear();
        }
        current.push_str(line);
        current.push('\n');
    }
    flush(&current);
    CiteLookupDto { bib_found: true, entries }
}

#[tauri::command]
pub async fn cite_lookup(cwd: String, keys: Vec<String>) -> Result<CiteLookupDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(dir) = PathBuf::from(crate::sessions::expand_tilde(&cwd)).canonicalize() else {
            return CiteLookupDto { bib_found: false, entries: Vec::new() };
        };
        let canon = |p: &PathBuf| p.canonicalize().ok();
        let mut roots: Vec<PathBuf> = crate::projects::project_roots_and_resources()
            .0
            .iter()
            .filter_map(canon)
            .collect();
        roots.extend(
            crate::workspaces::worktree_rows()
                .into_iter()
                .flat_map(|w| [w.worktree_path, w.repo_path])
                .filter_map(|p| canon(&PathBuf::from(p))),
        );
        cite_lookup_in(&dir, &roots, &keys)
    })
    .await
    .map_err(|e| format!("读取引文失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_supports_multi_key_and_suppressed() {
        let text = "参见 [@doe2020] 与 [@smith21; @lee2022]，以及抑制引用 [-@hidden9]。\n\
                    普通链接 [text](https://x) 与脚注 [^1] 不算；行尾定位 [@key2, p. 33] 只取键。";
        let keys = extract_cite_keys(text);
        assert_eq!(
            keys.into_iter().collect::<Vec<_>>(),
            vec!["doe2020", "hidden9", "key2", "lee2022", "smith21"]
        );
    }

    #[test]
    fn extract_ignores_malformed_segments() {
        // 口径保守：项必须以 [-]@key 起头，带前缀的 [cf. @a1] 与空键 [@]/[@;] 都不收
        assert!(extract_cite_keys("[cf. @a1] [@] [@;]").is_empty());
        // 未闭合的方括号段不吞掉后面的正常引用
        let keys = extract_cite_keys("[@open 后面没有闭合\n正常 [@closed1]");
        assert_eq!(keys.into_iter().collect::<Vec<_>>(), vec!["closed1"]);
    }

    #[test]
    fn bib_keys_parse_entry_heads() {
        let bib = "@article{doe2020,\n  title={X}\n}\n\n@book{lee2022, title={Y}}\n% @comment 行\n";
        let keys = extract_bib_keys(bib);
        assert!(keys.contains("doe2020"));
        assert!(keys.contains("lee2022"));
        assert_eq!(keys.len(), 2);
    }

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-cite-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 白名单外直接拒绝。走注入白名单的核心函数，不碰本机真实 app.db——
    /// 档案卡可能落在 iCloud 等慢文件系统上 open() 阻塞（2026-09-13 挂死实证）。
    #[test]
    fn rejects_path_outside_whitelist() {
        let dir = tmpdir("outside");
        fs::write(dir.join("a.md"), "[@x]").unwrap();
        let err = check_citation_health_in(&dir, &[]).unwrap_err();
        assert!(err.contains("拒绝扫描"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 白名单内正常统计：注入临时白名单根，覆盖「文中键 vs bib 键」对账主路径
    #[test]
    fn scans_within_injected_whitelist() {
        let dir = tmpdir("inside");
        fs::write(dir.join("a.md"), "[@doe2020] 与 [@missing1]").unwrap();
        fs::write(dir.join("references.bib"), "@article{doe2020, title={X}}\n").unwrap();
        let dto = check_citation_health_in(&dir, std::slice::from_ref(&dir)).unwrap();
        assert_eq!(dto.total_refs, 2);
        assert_eq!(dto.resolved, 1);
        assert_eq!(dto.missing, vec!["missing1".to_string()]);
        assert!(dto.bib_found);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn task_md_placeholder_cite_is_not_a_missing_key() {
        let dir = tmpdir("task-md");
        fs::create_dir_all(dir.join("manuscript")).unwrap();
        fs::write(
            dir.join("TASK.md"),
            "引用一律用 [@bib键] 形式，且只能引用 references.bib。\n",
        )
        .unwrap();
        fs::write(dir.join("manuscript").join("draft.md"), "[@doe2020]\n").unwrap();
        fs::write(dir.join("references.bib"), "@article{doe2020, title={X}}\n").unwrap();
        let dto = check_citation_health_in(&dir, std::slice::from_ref(&dir)).unwrap();
        assert_eq!(dto.missing, Vec::<String>::new());
        assert_eq!(dto.total_refs, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn walk_skips_hidden_and_node_modules() {
        let dir = tmpdir("walk");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::create_dir_all(dir.join("manuscript")).unwrap();
        fs::write(dir.join("a.md"), "").unwrap();
        fs::write(dir.join(".git").join("b.md"), "").unwrap();
        fs::write(dir.join("node_modules").join("c.md"), "").unwrap();
        fs::write(dir.join("manuscript").join("d.md"), "").unwrap();
        let mut out = Vec::new();
        collect_md_files(&dir, &mut out);
        let mut names: Vec<String> = out
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.md", "d.md"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bib_lookup_prefers_root_then_manuscript() {
        let dir = tmpdir("bibloc");
        assert!(find_bib(&dir).is_none());
        fs::create_dir_all(dir.join("manuscript")).unwrap();
        fs::write(dir.join("manuscript").join("references.bib"), "").unwrap();
        assert!(find_bib(&dir)
            .unwrap()
            .ends_with("manuscript/references.bib"));
        fs::write(dir.join("references.bib"), "").unwrap();
        assert_eq!(find_bib(&dir).unwrap(), dir.join("references.bib"));
        let _ = fs::remove_dir_all(&dir);
    }

    const BIB: &str = r#"% 文件头说明不算条目
@article{smith2020,
  title = {A {Bayesian} view of \textit{everything}},
  author = {Smith, John and Lee, Kim and others},
  year = 2020,
  booktitle = {不该被当成 title}
}
@book{who2019, author = {{World Health Organization}}, title = "Global report", date = {2019-05-01}}
@misc{zhang21,
  author = {张三 and 李四},
  year = {2021},
  title = {中文题名}
}
@comment{ignored, title = {x}}
"#;

    #[test]
    fn bib_entries_parse_authors_year_title() {
        let dir = tmpdir("lookup");
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::write(dir.join("references.bib"), BIB).unwrap();
        let root = dir.canonicalize().unwrap();
        let keys = ["smith2020", "who2019", "zhang21", "nope"].map(String::from);
        let got = cite_lookup_in(&root.join("notes"), std::slice::from_ref(&root), &keys);
        assert!(got.bib_found);
        assert_eq!(got.entries.len(), 3);
        assert_eq!(got.entries[0].key, "smith2020");
        assert_eq!(got.entries[0].authors, vec!["Smith", "Lee"]);
        assert_eq!(got.entries[0].year.as_deref(), Some("2020"));
        assert_eq!(got.entries[0].title.as_deref(), Some("A Bayesian view of everything"));
        assert_eq!(got.entries[1].authors, vec!["World Health Organization"]);
        assert_eq!(got.entries[1].year.as_deref(), Some("2019"));
        assert_eq!(got.entries[1].title.as_deref(), Some("Global report"));
        assert_eq!(got.entries[2].authors, vec!["张三", "李四"]);
        // 不在白名单里的目录不读 bib
        let other = tmpdir("lookup-out").canonicalize().unwrap();
        assert!(!cite_lookup_in(&root, std::slice::from_ref(&other), &keys).bib_found);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&other);
    }
}
