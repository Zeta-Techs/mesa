//! 研究档案（2026-11-02，`docs/design-research-moat.md` §3.3）：跨项目、跨年份的个人研究背景。
//!
//! - 条目沿用项目长期知识（project_memory）的格式与状态机：只收人确认过的内容，带依据，
//!   active / superseded / revoked 三态；`goal_name` 字段在这里当「分类」用。Agent 只能提议，不能直接写。
//! - 存在配置目录 `research-profile.md`（与网关、密钥同一个根，测试可重定向），改前留历史副本。
//! - 开对话时按设置附进「长期知识」段末尾（read_project_memory），标明是偏好与历史、不是事实依据，有长度上限。
//! - 跨项目文献总表只读各注册项目的 `papers/included.json` 与 `notes/index.json`，按 DOI / 题名去重，不写任何项目。
use crate::project_memory::{parse, render, revision, validate_text, MemoryDocument, MemoryEntry, MemoryMeta};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const LIMIT: u64 = 2 * 1024 * 1024;
const CONTEXT_CAP: usize = 1500;
pub const CATEGORIES: [&str; 7] = ["研究方向", "常用方法", "数据处理习惯", "写作偏好", "导师意见", "放弃的方向", "其他"];

fn base_dir() -> Result<PathBuf, String> {
    crate::storage::config_root().ok_or_else(|| "无法确定配置目录".to_string())
}

fn profile_path(dir: &Path) -> PathBuf {
    dir.join("research-profile.md")
}

fn settings_path(dir: &Path) -> PathBuf {
    dir.join("research-profile.json")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSettings {
    /// 开对话时把研究档案附进项目说明（默认开）
    #[serde(default = "yes")]
    pub inject: bool,
}

fn yes() -> bool {
    true
}

impl Default for ProfileSettings {
    fn default() -> Self {
        Self { inject: true }
    }
}

fn read_raw_at(dir: &Path) -> Result<String, String> {
    let mut file = match fs::File::open(profile_path(dir)) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(format!("读取研究档案失败：{e}")),
    };
    let mut bytes = Vec::new();
    (&mut file).take(LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("研究档案超过 2 MB，请先作废不用的条目".into());
    }
    String::from_utf8(bytes).map_err(|_| "研究档案不是 UTF-8 文本".into())
}

pub(crate) fn read_doc_at(dir: &Path) -> Result<MemoryDocument, String> {
    parse(&read_raw_at(dir)?)
}

fn read_settings_at(dir: &Path) -> ProfileSettings {
    fs::read_to_string(settings_path(dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_doc_at(dir: &Path, before: &str, doc: &MemoryDocument) -> Result<(), String> {
    let text = render(doc)?;
    if !before.is_empty() {
        let backup = dir.join("research-profile-history").join(format!("{}.md", revision(before)));
        if !backup.exists() {
            crate::storage::atomic_write(&backup, before.as_bytes(), true)?;
        }
    }
    if read_raw_at(dir)? != before {
        return Err("研究档案在保存期间被外部修改，未覆盖，请重新读取".into());
    }
    crate::storage::atomic_write(&profile_path(dir), text.as_bytes(), true)
}

fn check_category(category: &str) -> Result<(), String> {
    if CATEGORIES.contains(&category) {
        Ok(())
    } else {
        Err("未知的档案分类".into())
    }
}

/// add / replace / revoke；与项目知识同口径：依据必填、revision 乐观锁、替代与作废都留原条目
pub(crate) fn update_at(
    dir: &Path,
    expected: &str,
    id: Option<&str>,
    action: &str,
    category: &str,
    text: &str,
    reason: &str,
) -> Result<MemoryDocument, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let _lock = crate::storage::lock_at(&dir.join("research-profile.lock"))?;
    let before = read_raw_at(dir)?;
    if revision(&before) != expected {
        return Err("研究档案已被修改，请重新读取后再确认".into());
    }
    if !matches!(action, "add" | "replace" | "revoke") {
        return Err("未知档案操作".into());
    }
    validate_text(reason).map_err(|_| "请填写有效的依据（为什么记下 / 为什么作废）")?;
    let mut doc = parse(&before)?;
    if action != "revoke" {
        validate_text(text)?;
        check_category(category)?;
    }
    if action != "add" {
        let old = doc
            .entries
            .iter_mut()
            .find(|e| Some(e.meta.id.as_str()) == id && e.meta.state == "active")
            .ok_or("档案条目不存在或已失效")?;
        old.meta.state = if action == "revoke" { "revoked" } else { "superseded" }.into();
        old.meta.reason = reason.trim().into();
    }
    if action != "revoke" {
        doc.entries.push(MemoryEntry {
            meta: MemoryMeta {
                id: uuid::Uuid::new_v4().to_string(),
                created_at: crate::sessions::now_iso(),
                source_version: None,
                goal_name: category.into(),
                state: "active".into(),
                replaces: id.map(str::to_owned),
                reason: reason.trim().into(),
                files: Vec::new(),
            },
            text: text.trim().into(),
            stale_paths: Vec::new(),
        });
    }
    write_doc_at(dir, &before, &doc)?;
    read_doc_at(dir)
}

/// 附进项目说明的那一段：按分类聚合有效条目，超长截断并注明
pub(crate) fn context_text_at(dir: &Path) -> String {
    if !read_settings_at(dir).inject {
        return String::new();
    }
    let Ok(doc) = read_doc_at(dir) else {
        return String::new();
    };
    let mut lines = Vec::new();
    for category in CATEGORIES {
        let items: Vec<&str> = doc
            .entries
            .iter()
            .rev()
            .filter(|e| e.meta.state == "active" && e.meta.goal_name == category)
            .map(|e| e.text.as_str())
            .collect();
        if !items.is_empty() {
            lines.push(format!("- {category}：{}", items.join("；")));
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    let mut body = lines.join("\n");
    if body.chars().count() > CONTEXT_CAP {
        body = body.chars().take(CONTEXT_CAP).collect::<String>() + "…（研究档案较长，已截断）";
    }
    format!("研究者档案（跨项目，人工确认；是这位研究者的偏好与历史，不是本项目的事实依据）：\n{body}")
}

pub(crate) fn context_text() -> String {
    if cfg!(test) {
        return String::new();
    }
    base_dir().map(|d| context_text_at(&d)).unwrap_or_default()
}

// ---------------- 跨项目文献总表 ----------------

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePaper {
    pub title: String,
    pub doi: String,
    pub year: String,
    pub projects: Vec<String>,
    /// 至少在一个项目里有精读笔记
    pub has_note: bool,
}

fn read_json_capped(path: &Path) -> Option<serde_json::Value> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > 16 * 1024 * 1024 {
        return None;
    }
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn norm_title(t: &str) -> String {
    t.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

pub(crate) fn papers_from(projects: &[(String, PathBuf)]) -> Vec<ProfilePaper> {
    use std::collections::HashMap;
    let mut out: Vec<ProfilePaper> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for (name, root) in projects {
        let noted: std::collections::HashSet<String> = read_json_capped(&root.join("notes/index.json"))
            .and_then(|v| match v {
                serde_json::Value::Array(rows) => Some(rows),
                serde_json::Value::Object(mut o) => o.remove("papers").and_then(|p| p.as_array().cloned()),
                _ => None,
            })
            .unwrap_or_default()
            .iter()
            .filter(|r| r.get("notePath").and_then(|p| p.as_str()).is_some_and(|p| !p.is_empty()))
            .filter_map(|r| r.get("id").and_then(|i| i.as_str()).map(str::to_owned))
            .collect();
        let Some(serde_json::Value::Array(rows)) = read_json_capped(&root.join("papers/included.json")) else {
            continue;
        };
        for row in rows {
            if row.get("decision").and_then(|d| d.as_str()).is_some_and(|d| d != "included") {
                continue;
            }
            let s = |k: &str| row.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let title = s("title");
            if title.is_empty() {
                continue;
            }
            let doi = s("doi").to_lowercase().replace("待补", "");
            let key = if doi.is_empty() { format!("t:{}", norm_title(&title)) } else { format!("d:{doi}") };
            let has_note = noted.contains(&s("id"));
            match index.get(&key) {
                Some(&i) => {
                    let paper = &mut out[i];
                    if !paper.projects.contains(name) {
                        paper.projects.push(name.clone());
                    }
                    paper.has_note |= has_note;
                }
                None => {
                    index.insert(key, out.len());
                    out.push(ProfilePaper {
                        title,
                        doi,
                        year: s("year"),
                        projects: vec![name.clone()],
                        has_note,
                    });
                }
            }
            if out.len() >= 5000 {
                return out;
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchProfileDto {
    pub doc: MemoryDocument,
    pub settings: ProfileSettings,
    pub categories: Vec<String>,
}

#[tauri::command]
pub async fn research_profile_read() -> Result<ResearchProfileDto, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = base_dir()?;
        Ok(ResearchProfileDto {
            doc: read_doc_at(&dir)?,
            settings: read_settings_at(&dir),
            categories: CATEGORIES.iter().map(|c| c.to_string()).collect(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn research_profile_update(
    expected_revision: String,
    id: Option<String>,
    action: String,
    category: String,
    text: String,
    reason: String,
) -> Result<MemoryDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_at(&base_dir()?, &expected_revision, id.as_deref(), &action, &category, &text, &reason)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn research_profile_set_inject(inject: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = base_dir()?;
        let text = serde_json::to_string_pretty(&ProfileSettings { inject }).map_err(|e| e.to_string())?;
        crate::storage::atomic_write(&settings_path(&dir), text.as_bytes(), true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn research_profile_papers() -> Result<Vec<ProfilePaper>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(papers_from(&crate::projects::registered_project_roots())))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-profile-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn entries_need_reason_and_category_and_keep_history() {
        let dir = temp_dir("entries");
        let rev0 = revision("");
        assert!(update_at(&dir, &rev0, None, "add", "研究方向", "单原子催化", "").is_err());
        assert!(update_at(&dir, &rev0, None, "add", "随便", "单原子催化", "我的方向").is_err());
        let doc = update_at(&dir, &rev0, None, "add", "研究方向", "单原子催化析氢", "我的博士课题").unwrap();
        let id = doc.entries[0].meta.id.clone();
        // 旧版本号再写被拒：别处改过就不覆盖
        assert!(update_at(&dir, &rev0, None, "add", "其他", "x", "y").is_err());
        let doc = update_at(&dir, &doc.revision, Some(&id), "replace", "研究方向", "单原子催化析氢与析氧", "扩展到 OER").unwrap();
        assert_eq!(doc.entries.iter().filter(|e| e.meta.state == "active").count(), 1);
        assert_eq!(doc.entries[0].meta.state, "superseded");
        assert!(dir.join("research-profile-history").is_dir());
        let active = doc.entries.iter().find(|e| e.meta.state == "active").unwrap().meta.id.clone();
        let doc = update_at(&dir, &doc.revision, Some(&active), "revoke", "", "", "换方向了").unwrap();
        assert!(doc.entries.iter().all(|e| e.meta.state != "active"));
    }

    #[test]
    fn context_groups_by_category_and_respects_switch() {
        let dir = temp_dir("context");
        assert_eq!(context_text_at(&dir), "");
        let doc = update_at(&dir, &revision(""), None, "add", "写作偏好", "摘要不写 novel", "导师说过三次").unwrap();
        update_at(&dir, &doc.revision, None, "add", "研究方向", "钙钛矿稳定性", "课题").unwrap();
        let text = context_text_at(&dir);
        assert!(text.starts_with("研究者档案（跨项目，人工确认；是这位研究者的偏好与历史，不是本项目的事实依据）"));
        let a = text.find("研究方向").unwrap();
        let b = text.find("写作偏好").unwrap();
        assert!(a < b, "按固定分类顺序");
        fs::write(settings_path(&dir), r#"{"inject":false}"#).unwrap();
        assert_eq!(context_text_at(&dir), "");
    }

    #[test]
    fn papers_dedupe_across_projects_by_doi_then_title() {
        let a = temp_dir("pa");
        let b = temp_dir("pb");
        for (root, rows, notes) in [
            (
                &a,
                r#"[{"id":"W1","title":"Paper One","doi":"10.1/X","year":"2020","decision":"included"},
                    {"id":"W2","title":"Excluded","decision":"excluded"},
                    {"id":"W3","title":"No DOI Paper!","year":"2019"}]"#,
                r#"[{"id":"W1","bibKey":"one","notePath":"notes/one.md"}]"#,
            ),
            (&b, r#"[{"id":"Z","title":"paper one","doi":"10.1/x"},{"id":"Y","title":"no doi paper"}]"#, "[]"),
        ] {
            fs::create_dir_all(root.join("papers")).unwrap();
            fs::create_dir_all(root.join("notes")).unwrap();
            fs::write(root.join("papers/included.json"), rows).unwrap();
            fs::write(root.join("notes/index.json"), notes).unwrap();
        }
        let papers = papers_from(&[("甲".into(), a), ("乙".into(), b)]);
        assert_eq!(papers.len(), 2);
        assert_eq!(papers[0].projects, vec!["甲", "乙"]);
        assert!(papers[0].has_note);
        assert_eq!(papers[1].projects, vec!["甲", "乙"]);
        assert!(!papers[1].has_note);
    }
}
