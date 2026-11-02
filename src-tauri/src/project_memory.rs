//! 项目知识仍是 Markdown；结构化块只记录人工确认、来源与替代关系，不自动采纳 Agent 结论。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

const OPEN: &str = "<!-- mesa-memory:";
const CLOSE: &str = "<!-- /mesa-memory -->";
const LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMeta {
    pub id: String,
    pub created_at: String,
    pub source_version: Option<String>,
    pub goal_name: String,
    pub state: String,
    pub replaces: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub files: Vec<crate::projects::ContentFingerprint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub meta: MemoryMeta,
    pub text: String,
    pub stale_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDocument {
    pub revision: String,
    pub legacy_text: String,
    pub entries: Vec<MemoryEntry>,
}

pub(crate) fn revision(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub(crate) fn read_raw(root: &Path) -> Result<String, String> {
    let path = crate::projects::memory_path(root);
    if path.exists() {
        let actual = crate::paths::canonicalize_plain(&path).map_err(|e| e.to_string())?;
        let canonical_root = crate::paths::canonicalize_plain(root).map_err(|e| e.to_string())?;
        if !crate::paths::path_within_path(&actual, &canonical_root) {
            return Err("项目知识不能指向项目外".into());
        }
    }
    let mut file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(format!("读取项目知识失败：{e}")),
    };
    let mut bytes = Vec::new();
    (&mut file)
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("项目知识超过 2 MB，请先拆分归档，不会按空知识继续".into());
    }
    String::from_utf8(bytes).map_err(|_| "项目知识不是 UTF-8 文本".into())
}

pub(crate) fn parse(text: &str) -> Result<MemoryDocument, String> {
    let mut entries = Vec::new();
    let mut legacy = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        legacy.push_str(&rest[..start]);
        let block = &rest[start + OPEN.len()..];
        let end_meta = block.find(" -->").ok_or("项目知识条目头损坏")?;
        let meta: MemoryMeta = serde_json::from_str(&block[..end_meta])
            .map_err(|e| format!("项目知识条目损坏：{e}"))?;
        let body = &block[end_meta + 4..];
        let end = body.find(CLOSE).ok_or("项目知识条目未闭合")?;
        if !matches!(meta.state.as_str(), "active" | "superseded" | "revoked") {
            return Err("未知项目知识状态".into());
        }
        if entries
            .iter()
            .any(|entry: &MemoryEntry| entry.meta.id == meta.id)
        {
            return Err("项目知识存在重复身份".into());
        }
        entries.push(MemoryEntry {
            meta,
            text: body[..end].trim().into(),
            stale_paths: Vec::new(),
        });
        rest = &body[end + CLOSE.len()..];
    }
    legacy.push_str(rest);
    Ok(MemoryDocument {
        revision: revision(text),
        legacy_text: legacy.trim().into(),
        entries,
    })
}

pub(crate) fn render(doc: &MemoryDocument) -> Result<String, String> {
    let mut text = doc.legacy_text.trim().to_string();
    for entry in &doc.entries {
        text.push_str(&format!(
            "\n\n{OPEN}{} -->\n{}\n{CLOSE}",
            serde_json::to_string(&entry.meta)
                .map_err(|e| e.to_string())?
                .replace("-->", "\\u002d\\u002d\\u003e"),
            entry.text
        ));
    }
    text.push('\n');
    if text.len() as u64 > LIMIT {
        return Err("项目知识超过 2 MB，未写入".into());
    }
    Ok(text)
}

pub(crate) fn validate_text(text: &str) -> Result<&str, String> {
    let text = text.trim();
    if text.is_empty() || text.len() > 32 * 1024 {
        return Err("知识内容不能为空且不得超过 32 KB".into());
    }
    if text.contains(OPEN) || text.contains(CLOSE) || text.contains("-->") {
        return Err("知识正文不能包含内部记录标记".into());
    }
    Ok(text)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn read_at(root: &Path) -> Result<MemoryDocument, String> {
    let canonical =
        crate::paths::canonicalize_plain(root).map_err(|e| format!("项目知识目录无效：{e}"))?;
    let root = canonical.as_path();
    let mut doc = parse(&read_raw(root)?)?;
    let mut cached = std::collections::HashMap::<String, Option<String>>::new();
    let mut remaining = 64 * 1024 * 1024u64;
    for entry in doc.entries.iter_mut().rev() {
        if entry.meta.state != "active" {
            continue;
        }
        for file in &entry.meta.files {
            let valid = !Path::new(&file.path).is_absolute()
                && !file
                    .path
                    .split(['/', '\\'])
                    .any(|p| matches!(p, ".." | "." | ""));
            let path = root.join(&file.path);
            let within = valid
                && crate::paths::canonicalize_plain(&path)
                    .ok()
                    .is_some_and(|p| crate::paths::path_within_path(&p, root));
            let actual = cached.entry(file.path.clone()).or_insert_with(|| {
                let size = fs::metadata(&path).ok()?.len();
                if !within || size > 8 * 1024 * 1024 || size > remaining {
                    return None;
                }
                remaining -= size;
                hash_file(&path).ok()
            });
            let matches = file.sha256.is_some() && actual.as_ref() == file.sha256.as_ref();
            if !matches {
                entry.stale_paths.push(file.path.clone());
            }
        }
    }
    Ok(doc)
}

pub(crate) fn context_at(root: &Path) -> Result<String, String> {
    let doc = read_at(root)?;
    let mut parts = Vec::new();
    for entry in doc
        .entries
        .iter()
        .rev()
        .filter(|entry| entry.meta.state == "active")
    {
        if entry.stale_paths.is_empty() {
            parts.push(format!(
                "- {}（人工确认；来源 {}）",
                entry.text,
                entry.meta.source_version.as_deref().unwrap_or("手工确认")
            ));
        } else {
            parts.push(format!("- 待重新确认的知识 {}：来源文件已变化或无法在小文件校验预算内确认（{}）；不得沿用为当前结论。", entry.meta.id, entry.stale_paths.join("、")));
        }
    }
    if !doc.legacy_text.is_empty() {
        parts.push(format!(
            "旧知识原文（未逐条绑定证据，冲突时以最新人工确认内容为准）：\n{}",
            doc.legacy_text
        ));
    }
    Ok(parts.join("\n"))
}

fn write_at(root: &Path, before: &str, doc: &MemoryDocument) -> Result<(), String> {
    let text = render(doc)?;
    if !before.is_empty() {
        let backup = root
            .join(".ccode/memory-history")
            .join(format!("{}.md", revision(before)));
        if !backup.exists() {
            crate::profiles::atomic_write(&backup, before)?;
        }
    }
    if read_raw(root)? != before {
        return Err("项目知识在保存期间被外部修改，未覆盖，请重新读取".into());
    }
    crate::profiles::atomic_write(&crate::projects::memory_path(root), &text)
}

pub(crate) fn append_confirmed(
    root: &Path,
    goal: &str,
    text: &str,
    version: Option<&str>,
) -> Result<(), String> {
    append_entry(root, goal, text, version, "验收时人工确认")
}

/// 人在人工请求卡片上勾「以后同类照此办」：分类「已定」或「不做」（goal_name 当分类，同研究档案），
/// 依据是那条问题与人的回答。仍是人确认的条目，Agent 不能写。
pub(crate) fn append_human_decision(root: &Path, kind: &str, text: &str) -> Result<(), String> {
    if !matches!(kind, "已定" | "不做") {
        return Err("只能记为「已定」或「不做」".into());
    }
    append_entry(root, kind, text, None, "人工请求里由人选定")
}

fn append_entry(
    root: &Path,
    goal: &str,
    text: &str,
    version: Option<&str>,
    reason: &str,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let text = validate_text(text)?;
    if goal.contains("-->") || version.is_some_and(|v| v.contains("-->")) {
        return Err("知识来源包含内部结束标记".into());
    }
    fs::create_dir_all(root.join(".ccode")).map_err(|e| e.to_string())?;
    let _lock = crate::storage::lock_at(&root.join(".ccode/memory.lock"))?;
    let before = read_raw(root)?;
    let mut doc = parse(&before)?;
    if let Some(version) = version {
        if doc
            .entries
            .iter()
            .any(|e| e.meta.source_version.as_deref() == Some(version) && e.text == text)
            || before.contains(&format!("<!-- mesa-run:{version} -->"))
        {
            return Ok(());
        }
    }
    let files = crate::projects::read_acceptance_log_at(root)
        .into_iter()
        .rev()
        .find(|e| Some(e.version_id.as_str()) == version && e.note.trim() == text)
        .map(|e| e.content_fingerprints)
        .unwrap_or_default();
    doc.entries.push(MemoryEntry {
        meta: MemoryMeta {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: crate::sessions::now_iso(),
            source_version: version.map(str::to_owned),
            goal_name: goal.into(),
            state: "active".into(),
            replaces: None,
            reason: reason.into(),
            files,
        },
        text: text.into(),
        stale_paths: Vec::new(),
    });
    write_at(root, &before, &doc)
}

fn update_at(
    root: &Path,
    expected: &str,
    id: Option<&str>,
    action: &str,
    text: &str,
    reason: &str,
) -> Result<MemoryDocument, String> {
    fs::create_dir_all(root.join(".ccode")).map_err(|e| e.to_string())?;
    let _lock = crate::storage::lock_at(&root.join(".ccode/memory.lock"))?;
    let before = read_raw(root)?;
    if revision(&before) != expected {
        return Err("项目知识已被修改，请重新读取后再确认".into());
    }
    let mut doc = parse(&before)?;
    if !matches!(action, "add" | "replace" | "revoke" | "archive_legacy") {
        return Err("未知知识操作".into());
    }
    validate_text(reason).map_err(|_| "请填写有效的确认或作废依据（不含内部标记）")?;
    if action == "archive_legacy" {
        if doc.legacy_text.is_empty() {
            return Err("没有旧知识需要停用".into());
        }
        let legacy = std::mem::take(&mut doc.legacy_text);
        doc.entries.push(MemoryEntry {
            meta: MemoryMeta {
                id: uuid::Uuid::new_v4().to_string(),
                created_at: crate::sessions::now_iso(),
                source_version: None,
                goal_name: "旧知识归档".into(),
                state: "revoked".into(),
                replaces: None,
                reason: reason.trim().into(),
                files: Vec::new(),
            },
            text: legacy,
            stale_paths: Vec::new(),
        });
        write_at(root, &before, &doc)?;
        return read_at(root);
    }
    if action != "revoke" {
        validate_text(text)?;
    }
    let mut rebound_files = Vec::new();
    if action == "replace" {
        let old = doc
            .entries
            .iter()
            .find(|e| Some(e.meta.id.as_str()) == id && e.meta.state == "active")
            .ok_or("知识条目不存在或已失效")?;
        let root_canon = crate::paths::canonicalize_plain(root).map_err(|e| e.to_string())?;
        for file in &old.meta.files {
            let path = crate::paths::canonicalize_plain(&root.join(&file.path))
                .map_err(|e| format!("来源 {} 无法确认：{e}", file.path))?;
            let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
            if !crate::paths::path_within_path(&path, &root_canon) || size > 8 * 1024 * 1024 {
                return Err(format!(
                    "来源 {} 不在项目内或超过确认预算，请另建明确注明依据的人工知识",
                    file.path
                ));
            }
            rebound_files.push(crate::projects::ContentFingerprint {
                path: file.path.clone(),
                size,
                sha256: Some(hash_file(&path)?),
            });
        }
    }
    if action != "add" {
        let old = doc
            .entries
            .iter_mut()
            .find(|e| Some(e.meta.id.as_str()) == id && e.meta.state == "active")
            .ok_or("知识条目不存在或已失效")?;
        old.meta.state = if action == "revoke" {
            "revoked"
        } else {
            "superseded"
        }
        .into();
        old.meta.reason = reason.trim().into();
    }
    if action != "revoke" {
        doc.entries.push(MemoryEntry {
            meta: MemoryMeta {
                id: uuid::Uuid::new_v4().to_string(),
                created_at: crate::sessions::now_iso(),
                source_version: None,
                goal_name: "人工维护".into(),
                state: "active".into(),
                replaces: id.map(str::to_owned),
                reason: reason.trim().into(),
                files: rebound_files,
            },
            text: text.trim().into(),
            stale_paths: Vec::new(),
        });
    }
    write_at(root, &before, &doc)?;
    read_at(root)
}

#[tauri::command]
pub async fn project_memory_read(path: String) -> Result<MemoryDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::projects::ensure_task_project_root(Path::new(
            &crate::sessions::expand_tilde(&path),
        ))?;
        read_at(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn project_memory_update(
    path: String,
    expected_revision: String,
    id: Option<String>,
    action: String,
    text: String,
    reason: String,
) -> Result<MemoryDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::projects::ensure_task_project_root(Path::new(
            &crate::sessions::expand_tilde(&path),
        ))?;
        update_at(
            &root,
            &expected_revision,
            id.as_deref(),
            &action,
            &text,
            &reason,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_evidence_excludes_a_previously_confirmed_conclusion() {
        let root =
            std::env::temp_dir().join(format!("mesa-memory-evidence-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("report.md"), "v1").unwrap();
        let fact = crate::projects::AcceptanceLogEntry {
            goal_id: "goal".into(),
            run_id: "run".into(),
            version_id: "run:1".into(),
            note: "结论甲".into(),
            content_fingerprints: vec![crate::projects::ContentFingerprint {
                path: "report.md".into(),
                size: 2,
                sha256: Some(hash_file(&root.join("report.md")).unwrap()),
            }],
            ..Default::default()
        };
        crate::review_contract::commit_fact(&root, &fact).unwrap();
        append_confirmed(&root, "目标", "结论甲", Some("run:1")).unwrap();
        assert!(context_at(&root).unwrap().contains("结论甲"));
        fs::write(root.join("report.md"), "v2").unwrap();
        let context = context_at(&root).unwrap();
        assert!(!context.contains("结论甲"));
        assert!(context.contains("待重新确认"));
        assert_eq!(
            read_at(&root).unwrap().entries[0].stale_paths,
            vec!["report.md"]
        );
        let stale = read_at(&root).unwrap();
        let fresh = update_at(
            &root,
            &stale.revision,
            Some(&stale.entries[0].meta.id),
            "replace",
            "结论乙",
            "依据 v2 重新确认",
        )
        .unwrap();
        assert!(fresh.entries.last().unwrap().stale_paths.is_empty());
        assert!(context_at(&root).unwrap().contains("结论乙"));
        fs::write(root.join("report.md"), "v3").unwrap();
        assert!(
            !context_at(&root).unwrap().contains("结论乙"),
            "重新确认仍须跟踪来源，不能丢掉依据链接"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn confirmed_memory_is_versioned_and_never_silently_revived() {
        let root = std::env::temp_dir().join(format!("mesa-memory-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".ccode")).unwrap();
        fs::write(crate::projects::memory_path(&root), "旧的手工笔记\n").unwrap();
        append_confirmed(&root, "目标", "旧结论", Some("run:1")).unwrap();
        append_confirmed(&root, "目标", "旧结论", Some("run:1")).unwrap();
        let doc = read_at(&root).unwrap();
        assert_eq!(doc.entries.len(), 1);
        let next = update_at(
            &root,
            &doc.revision,
            Some(&doc.entries[0].meta.id),
            "replace",
            "修正结论",
            "发现新证据",
        )
        .unwrap();
        assert!(update_at(&root, &doc.revision, None, "add", "失配", "旧窗口").is_err());
        let context = context_at(&root).unwrap();
        assert!(
            context.contains("修正结论")
                && !context.contains("旧结论")
                && context.contains("旧的手工笔记")
        );
        let newest = next.entries.last().unwrap();
        update_at(
            &root,
            &next.revision,
            Some(&newest.meta.id),
            "revoke",
            "",
            "不再成立",
        )
        .unwrap();
        assert!(!context_at(&root).unwrap().contains("修正结论"));
        let doc = read_at(&root).unwrap();
        update_at(
            &root,
            &doc.revision,
            None,
            "archive_legacy",
            "",
            "停用旧笔记",
        )
        .unwrap();
        assert!(!context_at(&root).unwrap().contains("旧的手工笔记"));
        assert!(
            read_raw(&root).unwrap().contains("旧的手工笔记"),
            "停用不是删除旧内容"
        );
        assert!(root.join(".ccode/memory-history").is_dir());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn damaged_memory_is_not_treated_as_empty() {
        let root = std::env::temp_dir().join(format!("mesa-memory-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(crate::projects::memory_path(&root)).unwrap();
        assert!(append_confirmed(&root, "目标", "结论", None).is_err());
        assert!(parse("<!-- mesa-memory:broken --> x").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
