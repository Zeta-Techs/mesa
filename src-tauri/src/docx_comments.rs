//! 导师 / 合作者意见回流（2026-11-07 科研流程补全 §4，design-research-completion.md）：从人选的 .docx 里抽批注，
//! 写成意见清单表放进这一步的工作副本——只读源文件，不经 AI。每条：批注人、时间、批注文字、被批注的原文片段。
//! 类别 / 去向 / 处理三列留空，由这一步处理意见的那一轮 AI 填。没有 XML 解析库：按 Word 固定的标签做窄口径扫描
//! （与 office_view 同一做法），认不出的结构宁可少抽一段原文，不猜。
use serde::Serialize;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

const DOCX_CAP: u64 = 80 * 1024 * 1024;
const XML_CAP: u64 = 40 * 1024 * 1024;
const ANCHOR_CAP: usize = 160;
const TEXT_CAP: usize = 800;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DocxComment {
    pub id: String,
    pub author: String,
    pub date: String,
    pub text: String,
    pub anchor: String,
}

fn xml_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(end) = tail.find(';') else {
            out.push_str(tail);
            return out;
        };
        let ent = &tail[1..end];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if ent.starts_with("#x") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
            _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => out.push(c),
            None => out.push_str(&tail[..=end]),
        }
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    out
}

/// 标签里某个属性的值（`w:author="张三"`）；没有返回空串
fn attr(tag: &str, name: &str) -> String {
    for quote in ['"', '\''] {
        let key = format!("{name}={quote}");
        if let Some(i) = tag.find(&key) {
            let rest = &tag[i + key.len()..];
            if let Some(end) = rest.find(quote) {
                return xml_unescape(&rest[..end]);
            }
        }
    }
    String::new()
}

/// 一段 XML 里所有 `<w:t>` 的文字，段落之间（`</w:p>`）用空格隔开；制表 / 换行标签当空格
fn runs_text(xml: &str) -> String {
    let mut out = String::new();
    let mut at = 0;
    while at < xml.len() {
        let Some(i) = xml[at..].find('<') else { break };
        let start = at + i;
        let Some(close) = xml[start..].find('>') else { break };
        let tag = &xml[start..start + close + 1];
        at = start + close + 1;
        let is_text = (tag.starts_with("<w:t>") || tag.starts_with("<w:t ")) && !tag.ends_with("/>");
        if is_text {
            if let Some(end) = xml[at..].find("</w:t>") {
                out.push_str(&xml_unescape(&xml[at..at + end]));
                at += end + "</w:t>".len();
            }
        } else if tag == "</w:p>" || tag.starts_with("<w:tab") || tag.starts_with("<w:br") {
            if !out.ends_with(' ') && !out.is_empty() {
                out.push(' ');
            }
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    let mut out: String = s.chars().take(cap).collect();
    out.push('…');
    out
}

/// 被批注的原文：commentRangeStart 到 commentRangeEnd 之间的文字；没有范围、或范围里没有字（点在空处的批注，
/// 2026-11-07 真稿实测）取 commentReference 所在的那一段
fn anchor_of(doc: &str, id: &str) -> String {
    let start_tag = format!("<w:commentRangeStart w:id=\"{id}\"");
    let end_tag = format!("<w:commentRangeEnd w:id=\"{id}\"");
    if let (Some(s), Some(e)) = (doc.find(&start_tag), doc.find(&end_tag)) {
        if e > s {
            let text = runs_text(&doc[s..e]);
            if !text.is_empty() {
                return clip(&text, ANCHOR_CAP);
            }
        }
    }
    let ref_tag = format!("<w:commentReference w:id=\"{id}\"");
    let Some(r) = doc.find(&ref_tag) else { return String::new() };
    let para_start = doc[..r].rfind("<w:p>").into_iter().chain(doc[..r].rfind("<w:p ")).max().unwrap_or(0);
    let para_end = doc[r..].find("</w:p>").map(|e| r + e).unwrap_or(doc.len());
    clip(&runs_text(&doc[para_start..para_end]), ANCHOR_CAP)
}

/// 抽出全部批注（按批注文件里的先后）
pub(crate) fn comments_of(comments_xml: &str, document_xml: &str) -> Vec<DocxComment> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(i) = comments_xml[at..].find("<w:comment ") {
        let start = at + i;
        let Some(close) = comments_xml[start..].find('>') else { break };
        let tag = &comments_xml[start..start + close + 1];
        let body_start = start + close + 1;
        let body_end = comments_xml[body_start..]
            .find("</w:comment>")
            .map(|e| body_start + e)
            .unwrap_or(comments_xml.len());
        let id = attr(tag, "w:id");
        let text = clip(&runs_text(&comments_xml[body_start..body_end]), TEXT_CAP);
        if !text.is_empty() {
            out.push(DocxComment {
                anchor: if id.is_empty() { String::new() } else { anchor_of(document_xml, &id) },
                author: attr(tag, "w:author"),
                date: attr(tag, "w:date"),
                id,
                text,
            });
        }
        at = body_end;
    }
    out
}

fn cell(s: &str) -> String {
    s.replace('|', "｜").replace(['\n', '\r'], " ")
}

/// 意见清单的 Markdown：表头列是处理那一轮与退回预填（step-loop.ts commentReworkDrafts）的契约，改表头两边一起改
pub(crate) fn render_sheet(source: &str, imported_at: &str, comments: &[DocxComment]) -> String {
    let mut out = format!(
        "# 意见清单：{source}\n\n> 从 {source} 导入（{imported_at}），共 {} 条。Mesa 只抽批注，不改原文件。\n\
         > 「类别」「去向」「处理」三列由处理这一轮的 AI 填，人可以改：类别 = 改文字 / 补分析 / 补文献 / 改结构 / 要讨论；\
         去向 = 本步，或「退回：步骤名」；处理 = 改在哪，或要补 / 改什么、不采纳的理由。\n\n\
         | 编号 | 批注人 | 原文 | 意见 | 类别 | 去向 | 处理 |\n|---|---|---|---|---|---|---|\n",
        comments.len()
    );
    for (i, c) in comments.iter().enumerate() {
        let who = if c.date.len() >= 10 { format!("{}（{}）", c.author, &c.date[..10]) } else { c.author.clone() };
        out.push_str(&format!(
            "| C{:03} | {} | {} | {} |  |  |  |\n",
            i + 1,
            cell(&who),
            cell(&c.anchor),
            cell(&c.text)
        ));
    }
    out
}

fn read_docx(path: &Path) -> Result<(String, String), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读不到这个文件：{e}"))?;
    if meta.len() > DOCX_CAP {
        return Err("这个 Word 文件太大（超过 80 MB），先另存一份不含大图的再导入".into());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("读不到这个文件：{e}"))?;
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "这不是 .docx（Word 2007 以后的格式）文件；.doc 请先在 Word 里另存为 .docx".to_string())?;
    let mut text = |name: &str| -> Result<Option<String>, String> {
        let Ok(mut f) = zip.by_name(name) else { return Ok(None) };
        if f.size() > XML_CAP {
            return Err(format!("{name} 太大，读不了"));
        }
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| e.to_string())?;
        Ok(Some(s))
    };
    let comments = text("word/comments.xml")?.ok_or("这个 Word 文件里没有批注")?;
    let document = text("word/document.xml")?.unwrap_or_default();
    Ok((comments, document))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentsImportDto {
    /// 工作副本内的相对路径（manuscript/comments/<日期>-<文件名>.md）
    pub rel_path: String,
    pub count: usize,
}

fn import_at(worktree: &Path, docx: &Path, now_iso: &str) -> Result<CommentsImportDto, String> {
    if !worktree.join(".git").exists() {
        return Err("这一步的工作副本不在了，先恢复它再导入".into());
    }
    let (comments_xml, document_xml) = read_docx(docx)?;
    let comments = comments_of(&comments_xml, &document_xml);
    if comments.is_empty() {
        return Err("这个 Word 文件里没有带文字的批注".into());
    }
    let source = docx.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "批注稿.docx".into());
    let stem = docx.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = crate::paths::sanitize_fs_name(&stem).unwrap_or_else(|_| "comments".into());
    let day: String = now_iso.chars().filter(|c| c.is_ascii_digit()).take(8).collect();
    let dir = worktree.join("manuscript").join("comments");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建意见清单目录失败：{e}"))?;
    let text = render_sheet(&source, &now_iso.replace('T', " ").chars().take(16).collect::<String>(), &comments);
    // 同一天同名再导一次：后缀递增，不覆盖上一份（上一份可能已经处理过一半）
    let mut name = format!("{day}-{stem}.md");
    let mut n = 2;
    loop {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join(&name)) {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && n < 100 => {
                name = format!("{day}-{stem}-{n}.md");
                n += 1;
            }
            Err(e) => return Err(format!("写意见清单失败：{e}")),
        }
    }
    crate::profiles::atomic_write(&dir.join(&name), &text)?;
    Ok(CommentsImportDto { rel_path: format!("manuscript/comments/{name}"), count: comments.len() })
}

#[tauri::command]
pub async fn docx_comments_import(worktree: String, docx_path: String) -> Result<CommentsImportDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let wt = PathBuf::from(crate::sessions::expand_tilde(&worktree));
        let docx = PathBuf::from(crate::sessions::expand_tilde(&docx_path));
        import_at(&wt, &docx, &crate::sessions::now_iso())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const COMMENTS: &str = r#"<w:comments xmlns:w="x"><w:comment w:id="0" w:author="王老师" w:date="2026-11-01T09:00:00Z" w:initials="W"><w:p><w:r><w:t>这里要补近三年的原位表征</w:t></w:r></w:p></w:comment><w:comment w:id="1" w:author="Li &amp; Co" w:date="2026-11-02T10:00:00Z"><w:p><w:r><w:t xml:space="preserve">数字 | 对不上 </w:t></w:r></w:p><w:p><w:r><w:t>请核对</w:t></w:r></w:p></w:comment><w:comment w:id="2" w:author="空"><w:p/></w:comment></w:comments>"#;
    const DOCUMENT: &str = r#"<w:document><w:body><w:p><w:r><w:t>Intro.</w:t></w:r></w:p><w:p><w:commentRangeStart w:id="0"/><w:r><w:t>MoS</w:t></w:r><w:r><w:t>2 edges are active</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p><w:p><w:r><w:t>η10 = 120 mV</w:t></w:r><w:r><w:commentReference w:id="1"/></w:r></w:p></w:body></w:document>"#;

    #[test]
    fn extracts_comments_with_anchor_text() {
        let list = comments_of(COMMENTS, DOCUMENT);
        assert_eq!(list.len(), 2, "没有文字的批注不要");
        assert_eq!(list[0].author, "王老师");
        assert_eq!(list[0].text, "这里要补近三年的原位表征");
        assert_eq!(list[0].anchor, "MoS2 edges are active", "范围批注取范围里的原文");
        assert_eq!(list[1].author, "Li & Co");
        assert_eq!(list[1].text, "数字 | 对不上 请核对");
        assert_eq!(list[1].anchor, "η10 = 120 mV", "点批注取所在那一段");
        let empty_range = r#"<w:p><w:r><w:t>Fig. 2 shows XRD</w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t/></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>"#;
        assert_eq!(comments_of(COMMENTS, empty_range)[0].anchor, "Fig. 2 shows XRD", "范围里没字退回取所在那一段");
        let sheet = render_sheet("稿.docx", "2026-11-07 10:00", &list);
        assert!(sheet.contains("| 编号 | 批注人 | 原文 | 意见 | 类别 | 去向 | 处理 |"));
        assert!(sheet.contains("| C001 | 王老师（2026-11-01） | MoS2 edges are active | 这里要补近三年的原位表征 |  |  |  |"));
        assert!(sheet.contains("数字 ｜ 对不上 请核对"), "表格里的竖线换成全角");
    }

    #[test]
    fn import_writes_sheet_without_overwriting() {
        let dir = std::env::temp_dir().join(format!("mesa-comments-{}", uuid::Uuid::new_v4()));
        let wt = dir.join("wt");
        std::fs::create_dir_all(wt.join(".git")).unwrap();
        let docx = dir.join("导师意见 v2.docx");
        {
            let f = std::fs::File::create(&docx).unwrap();
            let mut z = zip::ZipWriter::new(f);
            let opt = zip::write::SimpleFileOptions::default();
            z.start_file("word/comments.xml", opt).unwrap();
            z.write_all(COMMENTS.as_bytes()).unwrap();
            z.start_file("word/document.xml", opt).unwrap();
            z.write_all(DOCUMENT.as_bytes()).unwrap();
            z.finish().unwrap();
        }
        let a = import_at(&wt, &docx, "2026-11-07T10:00:00Z").unwrap();
        assert_eq!(a.count, 2);
        assert!(a.rel_path.starts_with("manuscript/comments/20261107-"));
        let b = import_at(&wt, &docx, "2026-11-07T11:00:00Z").unwrap();
        assert_ne!(a.rel_path, b.rel_path, "再导一次不覆盖");
        assert!(import_at(&wt, &dir.join("nope.docx"), "2026-11-07T10:00:00Z").is_err());
        assert!(import_at(&dir.join("no-wt"), &docx, "2026-11-07T10:00:00Z").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
