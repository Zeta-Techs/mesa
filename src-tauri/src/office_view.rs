//! Office 文档预览补强（2026-10-26 用户「文件预览的问题全部修」）：
//! - docx：前端 mammoth 转 HTML 会丢公式、修订、批注、页眉页脚，这里数出来让界面如实说「看不到什么」；
//! - pptx：原先完全预览不了，这里抽每页的标题 / 正文 / 第一张图 / 备注做大纲；
//! - 装了 LibreOffice 时把 Word / 幻灯转成 PDF「看原样」（输出在 <config>/ccode/tmp/office-pdf/，读取白名单内）。
//! 读取一律走 pdf.rs 白名单；只读，不改原文件。

use base64::Engine;
use serde::Serialize;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

const OFFICE_CAP: u64 = 100 * 1024 * 1024;
/// 大纲里内嵌的图：单张上限与总量上限（大纲是给人扫一眼的，不是幻灯播放器）
const SLIDE_IMAGE_CAP: u64 = 3 * 1024 * 1024;
const SLIDE_IMAGES_TOTAL: usize = 30 * 1024 * 1024;
const CONVERT_TIMEOUT_SECS: u64 = 180;

fn read_zip(path: &str, cwd_hint: Option<&str>) -> Result<zip::ZipArchive<Cursor<Vec<u8>>>, String> {
    let (bytes, _) = crate::pdf::read_whitelisted_sync(path, cwd_hint, OFFICE_CAP, |mb| {
        format!("文件超过 100 MB（{mb:.1} MB），不在 Mesa 里预览")
    })?;
    if !bytes.starts_with(b"PK") {
        return Err("文件内容不是 Office 文档（ZIP 容器）".into());
    }
    zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("打不开这份文档: {e}"))
}

fn zip_text(zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

fn zip_bytes(zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>, name: &str, cap: u64) -> Option<Vec<u8>> {
    let mut f = zip.by_name(name).ok()?;
    if f.size() > cap {
        return None;
    }
    let mut v = Vec::new();
    f.read_to_end(&mut v).ok()?;
    Some(v)
}

/// 开标签计数：`<w:ins ` / `<w:ins>` 都算，`<w:insideH` 这类前缀相同的别的标签不算
fn count_tag(xml: &str, tag: &str) -> usize {
    let open = format!("<{tag}");
    let mut n = 0;
    let mut at = 0;
    while let Some(i) = xml[at..].find(&open) {
        let after = at + i + open.len();
        match xml.as_bytes().get(after) {
            Some(b' ') | Some(b'>') | Some(b'/') | Some(b'\n') | Some(b'\r') | Some(b'\t') => n += 1,
            _ => {}
        }
        at = after;
    }
    n
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocxFeaturesDto {
    /// Word 公式（OMML）
    pub equations: usize,
    /// 修订：插入 / 删除
    pub insertions: usize,
    pub deletions: usize,
    pub comments: usize,
    /// 页眉页脚里有字
    pub headers_footers: bool,
    pub textboxes: usize,
    /// 文献管理器的引用域（EndNote / Zotero / Mendeley）
    pub citation_fields: usize,
}

pub(crate) fn docx_features_of(
    zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>,
) -> DocxFeaturesDto {
    let doc = zip_text(zip, "word/document.xml").unwrap_or_default();
    let comments = zip_text(zip, "word/comments.xml")
        .map(|x| count_tag(&x, "w:comment"))
        .unwrap_or(0);
    let names: Vec<String> = zip.file_names().map(str::to_string).collect();
    let headers_footers = names
        .iter()
        .filter(|n| {
            (n.starts_with("word/header") || n.starts_with("word/footer")) && n.ends_with(".xml")
        })
        .any(|n| zip_text(zip, n).map(|x| x.contains("<w:t")).unwrap_or(false));
    // 一个 m:oMathPara 里包着 m:oMath，只数 m:oMath
    let equations = count_tag(&doc, "m:oMath");
    let citation_fields = ["ADDIN EN.CITE", "ADDIN ZOTERO_ITEM", "CSL_CITATION", "ADDIN Mendeley"]
        .iter()
        .map(|k| doc.matches(k).count())
        .sum::<usize>();
    DocxFeaturesDto {
        equations,
        insertions: count_tag(&doc, "w:ins"),
        deletions: count_tag(&doc, "w:del"),
        comments,
        headers_footers,
        textboxes: count_tag(&doc, "w:txbxContent"),
        citation_fields,
    }
}

#[tauri::command]
pub async fn docx_features(path: String, cwd_hint: Option<String>) -> Result<DocxFeaturesDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut zip = read_zip(&path, cwd_hint.as_deref())?;
        Ok(docx_features_of(&mut zip))
    })
    .await
    .map_err(|e| format!("读取文档失败: {e}"))?
}

// ---------- 幻灯大纲 ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideDto {
    pub index: usize,
    /// 第一段（一般就是标题）
    pub title: String,
    /// 其余段落（每段一条）
    pub paragraphs: Vec<String>,
    pub notes: Vec<String>,
    /// 第一张图：data URL（超过单张 / 总量上限的不带）
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlidesOutlineDto {
    pub slides: Vec<SlideDto>,
    /// 文档自带的首页缩略图（docProps/thumbnail.jpeg）
    pub thumbnail: Option<String>,
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

/// DrawingML 段落：每个 `<a:p>` 里的 `<a:t>` 拼成一段，空段丢掉
pub(crate) fn drawing_paragraphs(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    for para in xml.split("</a:p>") {
        let mut text = String::new();
        let mut at = 0;
        while let Some(i) = para[at..].find("<a:t") {
            let start = at + i;
            let Some(gt) = para[start..].find('>') else { break };
            let body_start = start + gt + 1;
            // <a:t/> 空元素
            if para.as_bytes().get(start + gt - 1) == Some(&b'/') {
                at = body_start;
                continue;
            }
            let Some(close) = para[body_start..].find("</a:t>") else { break };
            text.push_str(&xml_unescape(&para[body_start..body_start + close]));
            at = body_start + close + 6;
        }
        let t = text.trim();
        if !t.is_empty() {
            out.push(t.to_string());
        }
    }
    out
}

/// slide 的 rels：rId → 目标路径（相对 ppt/slides/）
fn rels_targets(xml: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for rel in xml.split("<Relationship ").skip(1) {
        let attr = |name: &str| -> Option<String> {
            let key = format!("{name}=\"");
            let i = rel.find(&key)? + key.len();
            let j = rel[i..].find('"')?;
            Some(rel[i..i + j].to_string())
        };
        if let (Some(id), Some(ty), Some(target)) = (attr("Id"), attr("Type"), attr("Target")) {
            out.push((id, ty, target));
        }
    }
    out
}

fn resolve_part(base_dir: &str, target: &str) -> String {
    if let Some(abs) = target.strip_prefix('/') {
        return abs.to_string();
    }
    let mut parts: Vec<&str> = base_dir.split('/').filter(|p| !p.is_empty()).collect();
    for seg in target.split('/') {
        match seg {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            s => parts.push(s),
        }
    }
    parts.join("/")
}

fn image_mime(name: &str) -> Option<&'static str> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

pub(crate) fn slides_outline_of(zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>) -> SlidesOutlineDto {
    // 幻灯顺序以 presentation.xml 的 sldIdLst 为准（文件名序号不一定是放映顺序）
    let mut order: Vec<String> = Vec::new();
    if let (Some(pres), Some(rels)) = (
        zip_text(zip, "ppt/presentation.xml"),
        zip_text(zip, "ppt/_rels/presentation.xml.rels"),
    ) {
        let targets = rels_targets(&rels);
        if let Some(lst) = pres.split("<p:sldIdLst>").nth(1).and_then(|s| s.split("</p:sldIdLst>").next()) {
            for item in lst.split("<p:sldId ").skip(1) {
                let Some(i) = item.find("r:id=\"") else { continue };
                let rid = &item[i + 6..];
                let Some(j) = rid.find('"') else { continue };
                if let Some((_, _, t)) = targets.iter().find(|(id, _, _)| id == &rid[..j]) {
                    order.push(resolve_part("ppt", t));
                }
            }
        }
    }
    if order.is_empty() {
        let mut names: Vec<(usize, String)> = zip
            .file_names()
            .filter_map(|n| {
                let num = n.strip_prefix("ppt/slides/slide")?.strip_suffix(".xml")?;
                Some((num.parse().ok()?, n.to_string()))
            })
            .collect();
        names.sort();
        order = names.into_iter().map(|(_, n)| n).collect();
    }
    let mut budget = SLIDE_IMAGES_TOTAL;
    let mut slides = Vec::new();
    for (i, part) in order.iter().enumerate() {
        let xml = zip_text(zip, part).unwrap_or_default();
        let mut paras = drawing_paragraphs(&xml);
        let title = if paras.is_empty() { String::new() } else { paras.remove(0) };
        let (dir, file) = part.rsplit_once('/').unwrap_or(("", part));
        let rels = zip_text(zip, &format!("{dir}/_rels/{file}.rels"))
            .map(|x| rels_targets(&x))
            .unwrap_or_default();
        let mut notes = Vec::new();
        if let Some((_, _, t)) = rels.iter().find(|(_, ty, _)| ty.ends_with("/notesSlide")) {
            if let Some(nx) = zip_text(zip, &resolve_part(dir, t)) {
                // 备注页第一段常是幻灯编号占位，按纯数字过滤
                notes = drawing_paragraphs(&nx)
                    .into_iter()
                    .filter(|p| !p.chars().all(|c| c.is_ascii_digit()))
                    .collect();
            }
        }
        let mut image = None;
        // 按正文里出现的先后取第一张图
        let first_rid = xml
            .split("r:embed=\"")
            .skip(1)
            .filter_map(|s| s.split('"').next())
            .find(|rid| rels.iter().any(|(id, ty, _)| id == rid && ty.ends_with("/image")));
        if let Some(rid) = first_rid {
            if let Some((_, _, t)) = rels.iter().find(|(id, _, _)| id == rid) {
                let name = resolve_part(dir, t);
                if let Some(mime) = image_mime(&name) {
                    if let Some(bytes) = zip_bytes(zip, &name, SLIDE_IMAGE_CAP) {
                        if bytes.len() <= budget {
                            budget -= bytes.len();
                            image = Some(data_url(mime, &bytes));
                        }
                    }
                }
            }
        }
        slides.push(SlideDto { index: i + 1, title, paragraphs: paras, notes, image });
    }
    let thumbnail = ["docProps/thumbnail.jpeg", "docProps/thumbnail.jpg", "docProps/thumbnail.png"]
        .iter()
        .find_map(|n| {
            let bytes = zip_bytes(zip, n, SLIDE_IMAGE_CAP)?;
            Some(data_url(image_mime(n)?, &bytes))
        });
    SlidesOutlineDto { slides, thumbnail }
}

#[tauri::command]
pub async fn slides_outline(path: String, cwd_hint: Option<String>) -> Result<SlidesOutlineDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut zip = read_zip(&path, cwd_hint.as_deref())?;
        Ok(slides_outline_of(&mut zip))
    })
    .await
    .map_err(|e| format!("读取幻灯失败: {e}"))?
}

// ---------- 转 PDF（LibreOffice） ----------

/// 本机的 LibreOffice（soffice）：PATH 上的、各平台默认安装位置
fn find_soffice() -> Option<PathBuf> {
    for name in ["soffice", "libreoffice"] {
        if let Some(p) = crate::agents::resolve_binary(name) {
            return Some(p);
        }
    }
    let mut cands: Vec<PathBuf> = vec![
        PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
        PathBuf::from("/usr/bin/soffice"),
        PathBuf::from("/usr/lib/libreoffice/program/soffice"),
        PathBuf::from("/opt/libreoffice/program/soffice"),
    ];
    if let Some(home) = dirs::home_dir() {
        cands.push(home.join("Applications/LibreOffice.app/Contents/MacOS/soffice"));
    }
    for key in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(pf) = std::env::var_os(key) {
            cands.push(PathBuf::from(pf).join("LibreOffice").join("program").join("soffice.exe"));
        }
    }
    cands.into_iter().find(|p| p.is_file())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeConverterDto {
    pub available: bool,
    pub path: Option<String>,
}

#[tauri::command]
pub async fn office_converter() -> Result<OfficeConverterDto, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let p = find_soffice();
        Ok(OfficeConverterDto {
            available: p.is_some(),
            path: p.map(|p| p.to_string_lossy().into_owned()),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn convert_dir_for(src: &Path) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    let base = dirs::config_dir()
        .ok_or("找不到配置目录")?
        .join("ccode")
        .join("tmp")
        .join("office-pdf");
    let key = format!("{:x}", Sha256::digest(src.to_string_lossy().as_bytes()));
    Ok(base.join(&key[..16]))
}

fn office_to_pdf_sync(path: &str, cwd_hint: Option<&str>) -> Result<String, String> {
    let src = crate::pdf::whitelisted_target(path, cwd_hint)?;
    let soffice = find_soffice().ok_or("没找到 LibreOffice：装上它（免费）就能在 Mesa 里看 Word / 幻灯的原样")?;
    let out_dir = convert_dir_for(&src)?;
    let stem = src
        .file_stem()
        .ok_or("文件没有名字")?
        .to_string_lossy()
        .into_owned();
    let pdf = out_dir.join(format!("{stem}.pdf"));
    // 已转过且比原文件新：直接用
    let src_mtime = fs::metadata(&src).and_then(|m| m.modified()).ok();
    if let (Ok(m), Some(src_m)) = (fs::metadata(&pdf).and_then(|m| m.modified()), src_mtime) {
        if m >= src_m {
            return Ok(pdf.to_string_lossy().into_owned());
        }
    }
    fs::create_dir_all(&out_dir).map_err(|e| format!("建临时目录失败: {e}"))?;
    let _ = fs::remove_file(&pdf);
    // 独立的用户配置目录：用户自己开着 LibreOffice 时不抢它的锁、不弹它的窗口
    let profile = out_dir.join("lo-profile");
    let profile_url = format!(
        "file:///{}",
        profile.to_string_lossy().replace('\\', "/").trim_start_matches('/')
    );
    let mut cmd = crate::process::background_command(&soffice);
    cmd.arg(format!("-env:UserInstallation={profile_url}"))
        .args(["--headless", "--norestore", "--nolockcheck", "--convert-to", "pdf", "--outdir"])
        .arg(&out_dir)
        .arg(&src);
    let out = crate::process::capture_command(
        &mut cmd,
        std::time::Duration::from_secs(CONVERT_TIMEOUT_SECS),
        1024 * 1024,
    )?;
    if out.timed_out {
        return Err("LibreOffice 转换超过 3 分钟没完成，已停止".into());
    }
    if !pdf.is_file() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "LibreOffice 没转出 PDF{}",
            if err.trim().is_empty() { String::new() } else { format!("：{}", err.trim()) }
        ));
    }
    Ok(pdf.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn office_to_pdf(path: String, cwd_hint: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || office_to_pdf_sync(&path, cwd_hint.as_deref()))
        .await
        .map_err(|e| format!("转换失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(files: &[(&str, &[u8])]) -> zip::ZipArchive<Cursor<Vec<u8>>> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
            for (name, data) in files {
                w.start_file(*name, opts).unwrap();
                w.write_all(data).unwrap();
            }
            w.finish().unwrap();
        }
        zip::ZipArchive::new(Cursor::new(buf.into_inner())).unwrap()
    }

    #[test]
    fn docx_features_count_what_mammoth_drops() {
        let doc = r#"<w:document><w:body>
            <m:oMathPara><m:oMath><m:r/></m:oMath></m:oMathPara><m:oMath/>
            <w:ins w:id="1"><w:r/></w:ins><w:del w:id="2"/><w:insideH/>
            <w:instrText> ADDIN EN.CITE &lt;EndNote&gt;</w:instrText>
            <w:txbxContent/></w:body></w:document>"#;
        let mut zip = make_zip(&[
            ("word/document.xml", doc.as_bytes()),
            ("word/comments.xml", b"<w:comments><w:comment w:id=\"0\"/><w:comment w:id=\"1\"/></w:comments>"),
            ("word/header1.xml", b"<w:hdr><w:p><w:r><w:t>Running head</w:t></w:r></w:p></w:hdr>"),
        ]);
        let f = docx_features_of(&mut zip);
        assert_eq!(
            f,
            DocxFeaturesDto {
                equations: 2,
                insertions: 1,
                deletions: 1,
                comments: 2,
                headers_footers: true,
                textboxes: 1,
                citation_fields: 1,
            }
        );
    }

    #[test]
    fn slides_outline_follows_presentation_order_and_reads_notes_and_images() {
        let pres = r#"<p:presentation><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>"#;
        let pres_rels = r#"<Relationships><Relationship Id="rId2" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="x/slide" Target="slides/slide2.xml"/></Relationships>"#;
        let s1 = r#"<p:sld><a:p><a:r><a:t>第一页标题</a:t></a:r></a:p><a:p><a:r><a:t>要点 A &amp; B</a:t></a:r></a:p></p:sld>"#;
        let s2 = r#"<p:sld><a:p><a:r><a:t>Results</a:t></a:r></a:p><p:pic><a:blip r:embed="rId5"/></p:pic></p:sld>"#;
        let s2_rels = r#"<Relationships><Relationship Id="rId5" Type="http://x/image" Target="../media/image1.png"/><Relationship Id="rId9" Type="http://x/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>"#;
        let notes = r#"<p:notes><a:p><a:r><a:t>2</a:t></a:r></a:p><a:p><a:r><a:t>讲到这里停一下</a:t></a:r></a:p></p:notes>"#;
        let mut zip = make_zip(&[
            ("ppt/presentation.xml", pres.as_bytes()),
            ("ppt/_rels/presentation.xml.rels", pres_rels.as_bytes()),
            ("ppt/slides/slide1.xml", s1.as_bytes()),
            ("ppt/slides/slide2.xml", s2.as_bytes()),
            ("ppt/slides/_rels/slide2.xml.rels", s2_rels.as_bytes()),
            ("ppt/notesSlides/notesSlide1.xml", notes.as_bytes()),
            ("ppt/media/image1.png", b"\x89PNG fake"),
        ]);
        let o = slides_outline_of(&mut zip);
        assert_eq!(o.slides.len(), 2);
        // 放映顺序：slide2 在前
        assert_eq!(o.slides[0].title, "Results");
        assert!(o.slides[0].image.as_deref().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(o.slides[0].notes, vec!["讲到这里停一下".to_string()]);
        assert_eq!(o.slides[1].title, "第一页标题");
        assert_eq!(o.slides[1].paragraphs, vec!["要点 A & B".to_string()]);
        assert!(o.thumbnail.is_none());
    }

    #[test]
    fn part_paths_and_entities() {
        assert_eq!(resolve_part("ppt/slides", "../media/a.png"), "ppt/media/a.png");
        assert_eq!(resolve_part("ppt", "slides/slide1.xml"), "ppt/slides/slide1.xml");
        assert_eq!(xml_unescape("a &lt;b&gt; &#20013;&#x6587; &bogus;"), "a <b> 中文 &bogus;");
    }
}
