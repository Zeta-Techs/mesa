//! 沉浸式阅读区（批次 B1/B2/B3）：为项目内 PDF 建 notes/<slug>.md 精读笔记档案（B1），
//! 图片通道（B2）：白名单读图片字节（read_image_bytes）、圈选截图落 notes/assets/
//! （save_reader_capture）、截图链接追加进笔记「## 我的想法」小节（append_note_image）；
//! 生词本与译段（B3）：notes/glossary.md 表格的 list/append/remove（机管文件，表外内容保留），
//! 译段追加进笔记「## 译段」小节（append_note_translation）；高亮与批注一行一条记进「## 标注」小节
//! （append/remove_note_annotation，格式与 src/reader-note.ts 双端镜像）；顶栏真实题名（reader_paper_title）。
//! 门槛同 lit_watch（gated_root 口径：已注册项目或含 .ccode/project.toml，返回 canonical 根）；
//! pdf_path canonicalize 后必须在项目根内或精确匹配已登记只读 PDF 资源；已存在的笔记**永不覆盖**（created:false 原样返回）；
//! 新建/写回走 profiles::atomic_write（tmp+rename），symlink 会被整体替换而非穿透。

use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// ensure_paper_note 返回：笔记绝对路径 + 本次是否新建（false = 已存在，内容原样保留）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaperNoteDto {
    pub path: String,
    pub created: bool,
}

/// 笔记文件名安全化：去路径分隔与控制字符、连续空白折成单个 -（首尾/连续不出 -）、
/// 限长 80 字符；结果为空回落 "paper"。slug 只作文件名，笔记标题仍用原始 stem。
fn slugify_note_stem(stem: &str) -> String {
    let mut out = String::new();
    let mut len = 0usize;
    // 空白先记账，后面真来了有效字符才落 -（避免首尾/连续横线）
    let mut pending_dash = false;
    for c in stem.chars() {
        if c.is_whitespace() {
            pending_dash = !out.is_empty();
            continue;
        }
        if c.is_control() || c == '/' || c == '\\' {
            continue;
        }
        if len >= 80 {
            break;
        }
        if pending_dash {
            out.push('-');
            len += 1;
            pending_dash = false;
        }
        out.push(c);
        len += 1;
    }
    if out.is_empty() {
        "paper".into()
    } else {
        out
    }
}

/// 新笔记模板：标题 + 来源行 + 固定小节（精读八小节对齐 lit-notes 技能口径，尾部两节「译段」「我的想法」为阅读区机管小节）
fn note_template(title: &str, rel_pdf: &str, date: &str) -> String {
    format!(
        "# {title}\n\n> 来源：{rel_pdf} · 开始阅读 {date}\n\n## 一句话总结\n\n## 研究问题\n\n## 方法\n\n## 主要结果\n\n## 局限\n\n## 可引用点\n\n## 与本课题的关系\n\n## 疑问与待跟进\n\n## 译段\n\n## 我的想法\n"
    )
}

fn inside(child: &Path, root: &Path) -> bool {
    crate::paths::path_within_path(child, root)
}

fn readable_project_pdf(root: &Path, pdf: &Path) -> bool {
    if !pdf.is_file()
        || !pdf
            .extension()
            .is_some_and(|s| s.eq_ignore_ascii_case("pdf"))
    {
        return false;
    }
    if inside(pdf, root) {
        return true;
    }
    crate::projects::read_config_at(root)
        .config
        .resources
        .iter()
        .filter(|r| r.kind == "paper" && r.readonly)
        .filter_map(|r| crate::paths::canonicalize_plain(&root.join(&r.path)).ok())
        .any(|path| crate::paths::same_path(&path.to_string_lossy(), &pdf.to_string_lossy()))
}

fn ensure_paper_note_sync(project_root: &str, pdf_path: &str) -> Result<PaperNoteDto, String> {
    let root = gated_root(project_root)?;
    let pdf = crate::paths::canonicalize_plain(Path::new(&crate::sessions::expand_tilde(pdf_path)))
        .map_err(|e| format!("PDF 不存在或不可读: {e}"))?;
    if !readable_project_pdf(&root, &pdf) {
        return Err("PDF 不在项目目录内或未登记为只读资源，拒绝建立笔记".into());
    }
    let file_name = pdf
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or("PDF 文件名无效")?;
    let stem = Path::new(&file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_name.clone());
    let notes = root.join("notes");
    fs::create_dir_all(&notes).map_err(|e| format!("创建 notes 目录失败: {e}"))?;
    // notes 若是指向根外的 symlink 要拦下（同 lit_watch 落盘的双校验口径）
    let canon_notes =
        crate::paths::canonicalize_plain(&notes).map_err(|e| format!("notes 目录无效: {e}"))?;
    if !inside(&canon_notes, &root) {
        return Err("notes 指向项目目录之外，拒绝写入".into());
    }
    // slug 已去路径分隔符，join 不会逃逸 canon_notes
    let mut target = canon_notes.join(format!("{}.md", slugify_note_stem(&stem)));
    // 来源行写相对项目根的路径（统一正斜杠，同 discover_resources 口径）
    let rel_pdf = pdf
        .strip_prefix(&root)
        .map(|p| {
            p.components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_else(|_| pdf.to_string_lossy().replace('\\', "/"));
    // 配对优先：notes/ 里已有「来源行」指向本 PDF 的笔记（精读步骤产物）就直接打开它，
    // 不另建 slug 笔记——同一篇只有一份笔记。此前误建的 slug 笔记若仍是空模板（从未写过内容），
    // 顺带清进回收站（可反悔）；有内容的保留，不与精读笔记强行合并
    if let Some(existing) = find_note_by_source(&canon_notes, &root, &pdf) {
        if existing != target && target.exists() {
            if let Ok(content) = fs::read_to_string(&target) {
                if note_is_untouched(&content)
                    && note_source_pdf(&content)
                        .is_some_and(|source| anchor_is_pdf(&source, &root, &pdf))
                {
                    let _ = trash::delete(&target);
                }
            }
        }
        return Ok(PaperNoteDto {
            path: existing.to_string_lossy().into_owned(),
            created: false,
        });
    }
    if !inside(&pdf, &root) && target.exists() {
        // 不把另一篇同名附件的笔记认作本篇；原笔记保留，按来源派生稳定后缀。
        let suffix = format!(
            "{:x}",
            md5::compute(crate::paths::path_key(&pdf.to_string_lossy()))
        );
        target = canon_notes.join(format!("{}-{}.md", slugify_note_stem(&stem), &suffix[..8]));
    }
    if target.exists() {
        return Ok(PaperNoteDto {
            path: target.to_string_lossy().into_owned(),
            created: false,
        });
    }
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    // 标题用题录里的真实题名（文件名常被截断/改写），查不到才用文件名
    let title = paper_title_for(&root, &pdf).unwrap_or(stem);
    crate::profiles::atomic_write(&target, &note_template(&title, &rel_pdf, &date))?;
    Ok(PaperNoteDto {
        path: target.to_string_lossy().into_owned(),
        created: true,
    })
}

/// 来源行锚点解析成绝对候选（绝对路径原样、相对按项目根拼），canonical 后返回。
/// 简报口径让 agent 写「项目内相对路径」，但实测 agent 几乎总写成项目根绝对路径
/// （镁硫电池综述课题 156/156 全绝对）——配对判定两种都得认，解析失败（文件不存在）返回 None
fn anchor_pdf_candidate(source: &str, root: &Path) -> Option<PathBuf> {
    let s = source.replace('\\', "/");
    let p = Path::new(&s);
    let candidate = if p.is_absolute() {
        PathBuf::from(p)
    } else {
        root.join(p)
    };
    crate::paths::canonicalize_plain(&candidate).ok()
}

/// 锚点与目标 PDF（canonical）是否同一文件：双侧 canonical 后比较，
/// 不做字面比对——绝对锚点对相对 rel_pdf 字面永远不等，PDF 侧入口会因此误建平行笔记
fn anchor_is_pdf(source: &str, root: &Path, pdf_c: &Path) -> bool {
    anchor_pdf_candidate(source, root)
        .is_some_and(|c| crate::paths::same_path(&c.to_string_lossy(), &pdf_c.to_string_lossy()))
}

/// 笔记「来源行」声明的 PDF 相对路径（只认头部 10 行）。兼容两种格式：
/// 阅读区建档「> 来源：<path> · 开始阅读 …」与 lit-notes 精读笔记「> 来源 PDF：<path>」
/// （路径本身可能含空格，只按「 · 」分隔符截尾；path 形态可为项目内相对路径或绝对路径）
fn note_source_pdf(content: &str) -> Option<String> {
    for line in content.lines().take(10) {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("> 来源") else {
            continue;
        };
        let rest = rest.trim_start();
        let rest = rest.strip_prefix("PDF").unwrap_or(rest).trim_start();
        let rest = rest.trim_start_matches(['：', ':']).trim();
        let path = rest.split(" · ").next().unwrap_or(rest).trim();
        if path.to_ascii_lowercase().ends_with(".pdf") {
            return Some(path.replace('\\', "/"));
        }
    }
    None
}

/// 在 notes/ 里找「来源行」指向本 PDF 的笔记（lit-notes 配对锚点；锚点相对/绝对都认，
/// 判定走 anchor_is_pdf 的 canonical 比较）。只读各文件头部，返回绝对路径
fn find_note_by_source(notes: &Path, root: &Path, pdf_c: &Path) -> Option<PathBuf> {
    let mut entries: Vec<PathBuf> = fs::read_dir(notes)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
        .collect();
    entries.sort();
    entries.into_iter().find(|p| {
        fs::read_to_string(p)
            .ok()
            .and_then(|c| note_source_pdf(&c))
            .is_some_and(|src| anchor_is_pdf(&src, root, pdf_c))
    })
}

/// 整份只剩模板骨架（标题/来源行/小节标题/空行）= 建好后没写过内容，配对归并时可安全清掉
fn note_is_untouched(content: &str) -> bool {
    content.lines().all(|l| {
        let t = l.trim();
        t.is_empty() || t.starts_with("# ") || t.starts_with("## ") || t.starts_with("> 来源")
    })
}

/// 打开阅读区时建档：已存在原样返回（永不覆盖），不存在按模板原子写
#[tauri::command]
pub async fn ensure_paper_note(
    project_root: String,
    pdf_path: String,
) -> Result<PaperNoteDto, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_paper_note_sync(&project_root, &pdf_path))
        .await
        .map_err(|e| format!("建立文献笔记失败: {e}"))?
}

/// 门槛 + canonical 项目根（同 lit_watch.rs 的口径，不复制实现）
fn gated_root(project_root: &str) -> Result<PathBuf, String> {
    crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(
        project_root,
    )))
}

// ===== 笔记 ↔ PDF 配对（精读笔记产物进阅读区） =====

/// 配对内核（canonical 根 + canonical 笔记）：先认笔记头部「来源行」声明的 PDF 相对路径
/// （lit-notes 精读笔记的机读锚点）；无锚点回落到笔记 stem 与「project.toml 里 type="paper"
/// 资源 + papers/ 顶层 PDF」的文件名做规范化标题互相包含（口径与前端 lit-watch.ts
/// paperResourceFor 一致；序号前缀不影响包含判定）。多个命中取规范化标题最长者；
/// 无命中返回 None。返回 PDF 绝对路径。
fn pair_pdf_at(root: &Path, note_c: &Path) -> Result<Option<String>, String> {
    // 来源行锚点优先（lit-notes 精读笔记头部的「> 来源 PDF：<path>」，相对/绝对都认，
    // 解析走 anchor_pdf_candidate）——中文短标题与英文 PDF 名配不上时也能认回；
    // 锚点解析失败/不可读时落回落层，不硬报错
    if let Ok(content) = fs::read_to_string(note_c) {
        if let Some(rel) = note_source_pdf(&content) {
            if let Some(c) = anchor_pdf_candidate(&rel, root) {
                if readable_project_pdf(root, &c) {
                    return Ok(Some(c.to_string_lossy().replace('\\', "/")));
                }
            }
        }
    }
    let stem = note_c.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let want = crate::lit_watch::normalize_title(stem);
    if want.is_empty() {
        return Ok(None);
    }
    let cfg = crate::projects::read_config_at(root).config;
    let mut best: Option<(usize, PathBuf)> = None;
    for r in cfg.resources.iter().filter(|r| r.kind == "paper") {
        let pdf = root.join(&r.path);
        let pstem = pdf.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let title = crate::lit_watch::normalize_title(&r.name);
        let file_norm = crate::lit_watch::normalize_title(pstem);
        let norm = if !title.is_empty() && (want.contains(&title) || title.contains(&want)) {
            title
        } else {
            file_norm
        };
        if norm.is_empty() || !(want.contains(&norm) || norm.contains(&want)) {
            continue;
        }
        if !pdf.exists() {
            continue;
        }
        let c = crate::paths::canonicalize_plain(&pdf)
            .map_err(|e| format!("PDF 路径无效（{}）: {e}", r.path))?;
        if !readable_project_pdf(root, &c) {
            continue;
        }
        if best.as_ref().is_none_or(|(len, _)| norm.len() > *len) {
            best = Some((norm.len(), c));
        }
    }
    // 回退层第二来源：papers/ 顶层 PDF 直接扫文件系统。检索步 agent 直下的全文
    // 没走 Mesa 登记通道（lit_watch 下载/人工补投才有登记），只在 project.toml
    // 资源表里找会漏配；同一套 normalize_title 包含判定，与登记名合并取最长命中
    if let Ok(rd) = fs::read_dir(root.join("papers")) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.extension().is_some_and(|s| s.eq_ignore_ascii_case("pdf")) {
                continue;
            }
            let pstem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let norm = crate::lit_watch::normalize_title(pstem);
            if norm.is_empty() || !(want.contains(&norm) || norm.contains(&want)) {
                continue;
            }
            let Ok(c) = crate::paths::canonicalize_plain(&p) else {
                continue;
            };
            if !readable_project_pdf(root, &c) {
                continue;
            }
            if best.as_ref().is_none_or(|(len, _)| norm.len() > *len) {
                best = Some((norm.len(), c));
            }
        }
    }
    Ok(best.map(|(_, p)| p.to_string_lossy().replace('\\', "/")))
}

/// 笔记 → 配对 PDF（产物清单入口：根由调用方给定，笔记必须在根内）
fn pdf_for_note_sync(project_root: &str, note_path: &str) -> Result<Option<String>, String> {
    let root = gated_root(project_root)?;
    let note = PathBuf::from(crate::sessions::expand_tilde(note_path));
    let is_md = note
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"));
    if !is_md {
        return Err("只支持 Markdown 笔记（.md）".into());
    }
    let note_c =
        crate::paths::canonicalize_plain(&note).map_err(|e| format!("笔记不存在或不可读: {e}"))?;
    if !inside(&note_c, &root) {
        return Err("笔记在项目目录之外，拒绝访问".into());
    }
    pair_pdf_at(&root, &note_c)
}

/// 精读笔记产物「⛶ 沉浸阅读」入口：给笔记找配对 PDF（找不到返回 null，前端给提示）
#[tauri::command]
pub async fn pdf_for_note(
    project_root: String,
    note_path: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || pdf_for_note_sync(&project_root, &note_path))
        .await
        .map_err(|e| format!("查找配对 PDF 失败: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperNoteLinkDto {
    pub note_path: String,
    pub note_name: String,
    /// 笔记头部来源行里的 PDF 相对路径；没有来源行则为 None（仍可用文件名配对）
    pub pdf_rel: Option<String>,
}

fn list_paper_notes_sync(project_root: &str) -> Result<Vec<PaperNoteLinkDto>, String> {
    let root = gated_root(project_root)?;
    let notes = root.join("notes");
    if !notes.is_dir() {
        return Ok(Vec::new());
    }
    let Ok(rd) = fs::read_dir(&notes) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let path = e.path();
        let is_md = path
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| x.eq_ignore_ascii_case("md"));
        if !is_md {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        // 机管/流程文件不是某一篇的笔记：生词本、雷达收件箱、选段摘录、精读交棒
        if ["glossary.md", "inbox.md", "excerpts.md", "handoff.md"]
            .iter()
            .any(|n| name.eq_ignore_ascii_case(n))
        {
            continue;
        }
        let pdf_rel = fs::read_to_string(&path)
            .ok()
            .and_then(|c| note_source_pdf(&c));
        out.push(PaperNoteLinkDto {
            note_path: path.to_string_lossy().replace('\\', "/"),
            note_name: name,
            pdf_rel,
        });
    }
    out.sort_by(|a, b| a.note_name.cmp(&b.note_name));
    Ok(out)
}

/// 文献列表：notes/ 里每篇笔记及其来源 PDF（只读头部，不建档）
#[tauri::command]
pub async fn list_paper_notes(project_root: String) -> Result<Vec<PaperNoteLinkDto>, String> {
    tauri::async_runtime::spawn_blocking(move || list_paper_notes_sync(&project_root))
        .await
        .map_err(|e| format!("读取笔记配对失败: {e}"))?
}

/// reader_for_note 返回：归属项目根 + 配对 PDF + 实际编辑的笔记路径（工作区笔记映射回主仓副本）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderForNoteDto {
    pub project_root: String,
    pub pdf_path: String,
    pub note_path: String,
}

/// 笔记 → 阅读区三要素（终端页文件树/预览工具条入口：根未知，反查归属）：
/// 注册项目根直含 → 工作区 worktree 包含则映射主仓副本（主仓还没有 = 未合并，明确报错）→ 配对 PDF。
fn reader_for_note_sync(note_path: &str) -> Result<ReaderForNoteDto, String> {
    let note = PathBuf::from(crate::sessions::expand_tilde(note_path));
    let is_md = note
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"));
    if !is_md {
        return Err("只支持 Markdown 笔记（.md）".into());
    }
    let note_c =
        crate::paths::canonicalize_plain(&note).map_err(|e| format!("笔记不存在或不可读: {e}"))?;
    let conn = crate::workspaces::db()?;
    // 1. 注册项目根直含（剥 verbatim 后的分量判定，与 register_project 的 canonical_key 同口径）
    let mut root: Option<PathBuf> = None;
    let mut note_final = note_c.clone();
    for p in crate::projects::list_projects_in(&conn)? {
        let pr = PathBuf::from(crate::projects::canonical_key(Path::new(
            &crate::sessions::expand_tilde(&p.path),
        )));
        if inside(&note_c, &pr) {
            root = Some(pr);
            break;
        }
    }
    // 2. 工作区 worktree 包含 → 映射主仓副本（编辑主仓文件，读写约束不需要扩白名单）
    if root.is_none() {
        for w in crate::workspaces::query_workspaces(&conn)? {
            let wt = PathBuf::from(&w.worktree_path);
            let wt = crate::paths::canonicalize_plain(&wt).unwrap_or(wt);
            let Ok(rel) = note_c.strip_prefix(&wt) else {
                continue;
            };
            let repo = PathBuf::from(crate::sessions::expand_tilde(&w.repo_path));
            let main_note = repo.join(rel);
            if !main_note.exists() {
                return Err(
                    "这份笔记还在工作区里、尚未合并进主仓：评审合并后再进沉浸阅读（或先在主仓打开）"
                        .into(),
                );
            }
            note_final = crate::paths::canonicalize_plain(&main_note)
                .map_err(|e| format!("笔记不存在或不可读: {e}"))?;
            // 工作区所属仓库必须是任务项目（注册或含 .ccode/project.toml），顺带拿 canonical 根
            root = Some(crate::projects::ensure_task_project_root(&repo)?);
            break;
        }
    }
    let root = root.ok_or("这份笔记不在任何已登记项目或工作区内")?;
    let pdf = pair_pdf_at(&root, &note_final)?
        .ok_or("未找到与这份笔记配对的 PDF（papers/ 里需有已登记的本篇 PDF）")?;
    Ok(ReaderForNoteDto {
        project_root: root.to_string_lossy().replace('\\', "/"),
        pdf_path: pdf,
        note_path: note_final.to_string_lossy().replace('\\', "/"),
    })
}

/// 终端页 md 笔记「⛶ 沉浸阅读」入口：反查归属项目 + 配对 PDF 一次给齐（失败原因直接透出）
#[tauri::command]
pub async fn reader_for_note(note_path: String) -> Result<ReaderForNoteDto, String> {
    tauri::async_runtime::spawn_blocking(move || reader_for_note_sync(&note_path))
        .await
        .map_err(|e| format!("打开沉浸阅读失败: {e}"))?
}

// ===== 精读步「抽查 3 篇笔记」：保存进项目前就在阅读区对照原文看 =====

/// 抽查一篇的阅读区要素。笔记还在工作区里（待评审）时只读：人在这里改了，
/// 评审看到的就不是 AI 交付的那一版；有问题记进问题单交回这一步的 AI。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotCheckItemDto {
    pub note_path: String,
    /// 原文 PDF；仅摘要的篇通常没有
    pub pdf_path: Option<String>,
    pub read_only: bool,
    /// included.json 里的题名与摘要（仅摘要的篇拿摘要当原文对照；「待补」不算）
    pub title: Option<String>,
    pub abstract_text: Option<String>,
}

/// papers/included.json 里按 id 找一条（数组或 {records/items/papers/entries: []} 两种外形）
fn included_record(base: &Path, id: &str) -> Option<serde_json::Value> {
    let text = crate::lit_watch::read_text_inside(base, "papers/included.json")
        .ok()
        .flatten()?;
    let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
    let rows = parsed.as_array().cloned().or_else(|| {
        ["records", "items", "papers", "entries"]
            .iter()
            .find_map(|k| parsed.get(*k).and_then(|v| v.as_array()).cloned())
    })?;
    rows.into_iter()
        .find(|r| r.get("id").and_then(|v| v.as_str()) == Some(id))
}

fn record_text(record: Option<&serde_json::Value>, key: &str) -> Option<String> {
    let s = record?.get(key)?.as_str()?.trim();
    (!s.is_empty() && !s.starts_with("待补") && !s.starts_with("待核")).then(|| s.to_string())
}

/// 内核（根与 base 已 canonical、只读与否已判定）：笔记必须在 base/notes 里；
/// PDF 先按笔记来源行 / 文件名在项目根配对（全文原始资料直写项目根 papers/），
/// 配不上再看 included.json 的 pdf 字段（项目根优先，工作区里的只在只读档认）
fn spot_check_item_at(
    root: &Path,
    base: &Path,
    read_only: bool,
    note_path: &str,
    id: Option<&str>,
) -> Result<SpotCheckItemDto, String> {
    let rel = note_path.trim().replace('\\', "/");
    let raw = PathBuf::from(crate::sessions::expand_tilde(&rel));
    let note = if raw.is_absolute() {
        raw
    } else {
        base.join(rel.trim_start_matches("./"))
    };
    if !note
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"))
    {
        return Err("只支持 Markdown 笔记（.md）".into());
    }
    // 带 .. 的一律拒：Windows 的 canonicalize 按字面消掉 ..，macOS / Linux 要每级目录都在，
    // notes/ 还没建时 notes/../x.md 只报「不存在」，两边说法不一样
    if note.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("笔记不在 notes/ 里，拒绝打开".into());
    }
    let note_c =
        crate::paths::canonicalize_plain(&note).map_err(|e| format!("笔记不存在或不可读: {e}"))?;
    if !inside(&note_c, &base.join("notes")) {
        return Err("笔记不在 notes/ 里，拒绝打开".into());
    }
    let id = id.map(str::trim).filter(|s| !s.is_empty());
    let record = id.and_then(|id| included_record(base, id).or_else(|| included_record(root, id)));
    let mut pdf = pair_pdf_at(root, &note_c)?;
    if pdf.is_none() {
        if let Some(rel_pdf) = record_text(record.as_ref(), "pdf") {
            let in_root = anchor_pdf_candidate(&rel_pdf, root).filter(|c| readable_project_pdf(root, c));
            let in_base = || {
                anchor_pdf_candidate(&rel_pdf, base).filter(|c| {
                    read_only
                        && inside(c, base)
                        && c.is_file()
                        && c.extension().is_some_and(|s| s.eq_ignore_ascii_case("pdf"))
                })
            };
            pdf = in_root
                .or_else(in_base)
                .map(|c| c.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(SpotCheckItemDto {
        note_path: note_c.to_string_lossy().replace('\\', "/"),
        pdf_path: pdf,
        read_only,
        title: record_text(record.as_ref(), "title"),
        abstract_text: record_text(record.as_ref(), "abstract"),
    })
}

/// base = notes/index.json 所在根：项目根（已保存进项目，可改），或本项目某个工作区（只读）
fn spot_check_item_sync(
    project_root: &str,
    base: &str,
    note_path: &str,
    id: Option<&str>,
) -> Result<SpotCheckItemDto, String> {
    let root = gated_root(project_root)?;
    let base_c =
        crate::paths::canonicalize_plain(Path::new(&crate::sessions::expand_tilde(base)))
            .map_err(|e| format!("笔记所在目录不可读: {e}"))?;
    let read_only = !crate::paths::same_path(&base_c.to_string_lossy(), &root.to_string_lossy());
    if read_only {
        let conn = crate::workspaces::db()?;
        let owned = crate::workspaces::query_workspaces(&conn)?.into_iter().any(|w| {
            let wt = PathBuf::from(&w.worktree_path);
            let wt = crate::paths::canonicalize_plain(&wt).unwrap_or(wt);
            let repo = PathBuf::from(crate::sessions::expand_tilde(&w.repo_path));
            let repo = crate::paths::canonicalize_plain(&repo).unwrap_or(repo);
            crate::paths::same_path(&wt.to_string_lossy(), &base_c.to_string_lossy())
                && crate::paths::same_path(&repo.to_string_lossy(), &root.to_string_lossy())
        });
        if !owned {
            return Err("这份笔记不在本项目的工作区里".into());
        }
    }
    spot_check_item_at(&root, &base_c, read_only, note_path, id)
}

#[tauri::command]
pub async fn spot_check_item(
    project_root: String,
    base: String,
    note_path: String,
    id: Option<String>,
) -> Result<SpotCheckItemDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        spot_check_item_sync(&project_root, &base, &note_path, id.as_deref())
    })
    .await
    .map_err(|e| format!("打开抽查失败: {e}"))?
}

// ===== 批次 B2：图片通道 =====

/// 图片单文件上限 20MB（笔记内嵌图远超此值基本是误操作）
const IMAGE_CAP: u64 = 20 * 1024 * 1024;

/// read_image_bytes 返回：mime 按扩展名映射 + base64 完整字节（前端拼 data URL）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageBytesDto {
    pub mime: String,
    pub data: String,
}

/// 扩展名白名单 → mime；不在名单内返回 None（读取前就拒绝）
fn image_mime_for(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_string_lossy().to_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

fn image_magic_ok(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.starts_with(b"\x89PNG"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/jpeg" => {
            bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF
        }
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "image/svg+xml" => {
            let head = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]);
            head.to_ascii_lowercase().contains("<svg")
        }
        _ => false,
    }
}

fn read_image_sync(path: &str, cwd_hint: Option<&str>) -> Result<ImageBytesDto, String> {
    let expanded = crate::sessions::expand_tilde(path);
    let mime =
        image_mime_for(Path::new(&expanded)).ok_or("只支持 png/jpg/jpeg/gif/webp/svg 图片")?;
    // 白名单口径完全复用 pdf.rs 的四类来源判定（canonicalize 防逃逸在内核里做）
    let (bytes, _size) = crate::pdf::read_whitelisted_sync(path, cwd_hint, IMAGE_CAP, |mb| {
        format!("图片超过 20 MB（{mb:.1} MB），暂不支持内嵌显示")
    })?;
    if !image_magic_ok(mime, &bytes) {
        return Err("文件内容不是有效的图片（扩展名对但内容不是 png/gif/jpg/webp/svg）".into());
    }
    Ok(ImageBytesDto {
        mime: mime.into(),
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

/// 笔记阅读版式的图片渲染：白名单内图片字节 → data URL 素材
#[tauri::command]
pub async fn read_image_bytes(
    path: String,
    cwd_hint: Option<String>,
) -> Result<ImageBytesDto, String> {
    tauri::async_runtime::spawn_blocking(move || read_image_sync(&path, cwd_hint.as_deref()))
        .await
        .map_err(|e| format!("读取图片失败: {e}"))?
}

// ===== 聊天层音频通道（2026-10-19）=====
// AI 把朗读 / 生成的声音存成文件（say -o、TTS 脚本）后，聊天回复里提到它就给播放条——
// 终端只能显示文字、放不了声音，这是聊天层独有的。可读范围与图片同一套白名单。

/// 音频单文件上限 20MB（与图片同档；整段读进内存再交给网页播放）
const AUDIO_CAP: u64 = 20 * 1024 * 1024;

/// 扩展名白名单 → mime；不在名单内返回 None（读取前就拒绝）。
/// aiff 是 macOS `say -o` 的默认格式（WKWebView 能放；Windows 的 WebView2 放不了，前端如实提示）
fn audio_mime_for(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_string_lossy().to_lowercase().as_str() {
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "m4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "aif" | "aiff" | "aifc" => Some("audio/aiff"),
        "flac" => Some("audio/flac"),
        "ogg" | "oga" | "opus" => Some("audio/ogg"),
        _ => None,
    }
}

/// 文件头确实是这种音频：扩展名对、内容不对的（改了后缀的别的文件）不交给播放器
fn audio_magic_ok(mime: &str, bytes: &[u8]) -> bool {
    let at = |offset: usize, magic: &[u8]| bytes.get(offset..offset + magic.len()) == Some(magic);
    match mime {
        // ID3 标签开头，或直接是 MPEG 帧同步（0xFFEx / 0xFFFx）
        "audio/mpeg" => at(0, b"ID3") || (bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0),
        "audio/wav" => at(0, b"RIFF") && at(8, b"WAVE"),
        "audio/mp4" => at(4, b"ftyp"),
        "audio/aac" => at(0, b"ID3") || (bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] & 0xF6 == 0xF0),
        "audio/aiff" => at(0, b"FORM") && (at(8, b"AIFF") || at(8, b"AIFC")),
        "audio/flac" => at(0, b"fLaC"),
        "audio/ogg" => at(0, b"OggS"),
        _ => false,
    }
}

/// 未压缩的 AIFF / AIFC（NONE、twos 大端整数，sowt 小端整数，fl32 大端浮点）转 WAV；
/// 其余（压缩编码、结构坏了）返回 None。只做格式搬运，不重采样
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn aiff_to_wav(bytes: &[u8]) -> Option<Vec<u8>> {
    let be32 = |b: &[u8]| u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
    if bytes.len() < 12 || &bytes[0..4] != b"FORM" {
        return None;
    }
    let aifc = &bytes[8..12] == b"AIFC";
    if !aifc && &bytes[8..12] != b"AIFF" {
        return None;
    }
    let (mut channels, mut bits, mut rate, mut codec) = (0u16, 0u16, 0f64, *b"NONE");
    let mut sound: Option<&[u8]> = None;
    let mut pos = 12usize;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = be32(&bytes[pos + 4..pos + 8]) as usize;
        let body = bytes.get(pos + 8..pos + 8 + size).unwrap_or(&bytes[pos + 8..]);
        if id == b"COMM" && body.len() >= 18 {
            channels = u16::from_be_bytes([body[0], body[1]]);
            bits = u16::from_be_bytes([body[6], body[7]]);
            rate = extended_to_f64(&body[8..18]);
            if aifc && body.len() >= 22 {
                codec.copy_from_slice(&body[18..22]);
            }
        } else if id == b"SSND" && body.len() >= 8 {
            let offset = be32(&body[0..4]) as usize;
            sound = body.get(8 + offset..);
        }
        pos += 8 + size + (size & 1);
    }
    let sound = sound?;
    if channels == 0 || !(1.0..=768_000.0).contains(&rate) {
        return None;
    }
    let (format_tag, little_endian) = match &codec {
        b"NONE" | b"twos" => (1u16, false),
        b"sowt" => (1u16, true),
        b"fl32" | b"FL32" if bits == 32 => (3u16, false),
        _ => return None,
    };
    if !matches!(bits, 8 | 16 | 24 | 32) {
        return None;
    }
    let width = (bits / 8) as usize;
    let usable = sound.len() - sound.len() % (width * channels as usize);
    let mut data = Vec::with_capacity(usable);
    for sample in sound[..usable].chunks_exact(width) {
        if width == 1 {
            // AIFF 8 位有符号，WAV 8 位无符号
            data.push(sample[0].wrapping_add(128));
        } else if little_endian {
            data.extend_from_slice(sample);
        } else {
            data.extend(sample.iter().rev());
        }
    }
    let rate = rate.round() as u32;
    let block = width as u16 * channels;
    let mut wav = Vec::with_capacity(44 + data.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&format_tag.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&(rate * block as u32).to_le_bytes());
    wav.extend_from_slice(&block.to_le_bytes());
    wav.extend_from_slice(&bits.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
    wav.extend_from_slice(&data);
    Some(wav)
}

/// AIFF 的采样率是 80 位扩展精度浮点（1 位符号 + 15 位指数 + 64 位含显式整数位的尾数）
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn extended_to_f64(b: &[u8]) -> f64 {
    let exp = (((b[0] & 0x7F) as i32) << 8) | b[1] as i32;
    let mant = u64::from_be_bytes([b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9]]);
    if exp == 0 && mant == 0 {
        return 0.0;
    }
    let v = mant as f64 * 2f64.powi(exp - 16383 - 63);
    if b[0] & 0x80 != 0 {
        -v
    } else {
        v
    }
}

fn read_audio_sync(path: &str, cwd_hint: Option<&str>) -> Result<ImageBytesDto, String> {
    let expanded = crate::sessions::expand_tilde(path);
    let mime = audio_mime_for(Path::new(&expanded))
        .ok_or("只支持 mp3/wav/m4a/aac/aiff/flac/ogg 音频")?;
    let (bytes, _size) = crate::pdf::read_whitelisted_sync(path, cwd_hint, AUDIO_CAP, |mb| {
        format!("音频超过 20 MB（{mb:.1} MB），请用别的播放器打开")
    })?;
    if !audio_magic_ok(mime, &bytes) {
        return Err("文件内容不是有效的音频（扩展名对但内容对不上）".into());
    }
    // Windows 的 WebView2 放不了 aiff（Mac 上 `say -o` 的默认产物）：未压缩的就地转成 wav 交给播放器；
    // 压缩的 aifc（ima4 / ulaw 等）转不了，照原样交出去，前端如实提示放不了
    if cfg!(windows) && mime == "audio/aiff" {
        if let Some(wav) = aiff_to_wav(&bytes) {
            return Ok(ImageBytesDto {
                mime: "audio/wav".into(),
                data: base64::engine::general_purpose::STANDARD.encode(&wav),
            });
        }
    }
    Ok(ImageBytesDto {
        mime: mime.into(),
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

/// 聊天层播放条：白名单内音频字节（mime + base64，前端拼 Blob 播放）
#[tauri::command]
pub async fn read_audio_bytes(
    path: String,
    cwd_hint: Option<String>,
) -> Result<ImageBytesDto, String> {
    tauri::async_runtime::spawn_blocking(move || read_audio_sync(&path, cwd_hint.as_deref()))
        .await
        .map_err(|e| format!("读取音频失败: {e}"))?
}

/// save_reader_capture 返回：项目根相对路径（notes/assets/…）与绝对路径
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderCaptureDto {
    pub rel_path: String,
    pub abs_path: String,
}

/// 同秒连截的重名避让：<prefix>-<stamp>.<ext> 已存在则 -2/-3 递增
fn next_asset_name(dir: &Path, prefix: &str, stamp: &str, ext: &str) -> String {
    let mut name = format!("{prefix}-{stamp}.{ext}");
    let mut n = 2;
    while dir.join(&name).exists() {
        name = format!("{prefix}-{stamp}-{n}.{ext}");
        n += 1;
    }
    name
}

/// notes/assets/ 写入内核（圈选截图与「从手机添加」共用）：root 须已过 gated_root；
/// notes/assets 若是指向根外的 symlink 要拦下（同 ensure_paper_note 的双校验口径）
pub(crate) fn write_notes_asset(
    root: &Path,
    prefix: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<ReaderCaptureDto, String> {
    let assets = root.join("notes").join("assets");
    fs::create_dir_all(&assets).map_err(|e| format!("创建 notes/assets 目录失败: {e}"))?;
    let canon_assets = crate::paths::canonicalize_plain(&assets)
        .map_err(|e| format!("notes/assets 目录无效: {e}"))?;
    if !inside(&canon_assets, root) {
        return Err("notes/assets 指向项目目录之外，拒绝写入".into());
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let name = next_asset_name(&canon_assets, prefix, &stamp, ext);
    let target = canon_assets.join(&name);
    fs::write(&target, bytes).map_err(|e| format!("保存图片失败: {e}"))?;
    Ok(ReaderCaptureDto {
        rel_path: format!("notes/assets/{name}"),
        abs_path: target.to_string_lossy().into_owned(),
    })
}

fn save_reader_capture_sync(
    project_root: &str,
    image_base64: &str,
) -> Result<ReaderCaptureDto, String> {
    let root = gated_root(project_root)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64)
        .map_err(|e| format!("图片数据不是有效的 base64: {e}"))?;
    if bytes.is_empty() {
        return Err("图片数据为空".into());
    }
    if bytes.len() as u64 > IMAGE_CAP {
        return Err(format!(
            "截图超过 20 MB（{:.1} MB）",
            bytes.len() as f64 / 1024.0 / 1024.0
        ));
    }
    // 圈选产物来自 canvas.toBlob('image/png')，魔数不符即非预期来源
    if !bytes.starts_with(b"\x89PNG") {
        return Err("只接受 PNG 截图".into());
    }
    write_notes_asset(&root, "capture", "png", &bytes)
}

/// 圈选截图落盘：项目根门槛 + PNG 魔数 + 20MB 上限，返回相对/绝对路径
#[tauri::command]
pub async fn save_reader_capture(
    project_root: String,
    image_base64: String,
) -> Result<ReaderCaptureDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_reader_capture_sync(&project_root, &image_base64)
    })
    .await
    .map_err(|e| format!("保存截图失败: {e}"))?
}

/// 计算 target 相对 from_dir 的 md 链接路径（统一正斜杠；同目录时就是文件名）
fn rel_md_path(from_dir: &Path, target: &Path) -> Option<String> {
    let f: Vec<_> = from_dir.components().collect();
    let t: Vec<_> = target.components().collect();
    let mut i = 0;
    while i < f.len() && i < t.len() && f[i] == t[i] {
        i += 1;
    }
    let mut parts: Vec<String> = (0..f.len() - i).map(|_| "..".to_string()).collect();
    for c in &t[i..] {
        parts.push(c.as_os_str().to_string_lossy().into_owned());
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// 在指定二级小节末尾插入内容块（前后各一空行）；小节不存在则文件末尾补小节再插。
/// 纯函数（测试友好）：split('\n') 保留尾部空串，join 回原样不丢末尾换行。
fn append_block_to_section(text: &str, section: &str, block: &str) -> String {
    let header = format!("## {section}");
    let lines: Vec<&str> = text.split('\n').collect();
    if let Some(h) = lines.iter().position(|l| l.trim() == header) {
        // 小节结束 = 下一个二级标题或文件尾
        let mut end = lines.len();
        for (i, l) in lines.iter().enumerate().skip(h + 1) {
            if l.starts_with("## ") {
                end = i;
                break;
            }
        }
        // 小节内尾部空行先归一，再统一补「空行 + 内容块 + 空行」
        let mut tail = end;
        while tail > h + 1 && lines[tail - 1].trim().is_empty() {
            tail -= 1;
        }
        let mut out: Vec<&str> = lines[..tail].to_vec();
        out.push("");
        out.extend(block.split('\n'));
        out.push("");
        out.extend_from_slice(&lines[end..]);
        out.join("\n")
    } else {
        format!("{}\n\n## {section}\n\n{block}\n", text.trim_end())
    }
}

/// 在「## 我的想法」小节末尾插入图片行（append_block_to_section 的图片入口）
fn append_image_to_section(text: &str, image_md: &str) -> String {
    append_block_to_section(text, "我的想法", image_md)
}

fn append_note_image_sync(
    project_root: &str,
    note_path: &str,
    rel_image_path: &str,
) -> Result<(), String> {
    let root = gated_root(project_root)?;
    let note =
        crate::paths::canonicalize_plain(Path::new(&crate::sessions::expand_tilde(note_path)))
            .map_err(|e| format!("笔记不存在或不可读: {e}"))?;
    let canon_notes = crate::paths::canonicalize_plain(&root.join("notes"))
        .map_err(|e| format!("notes 目录无效: {e}"))?;
    if !inside(&note, &canon_notes) {
        return Err("笔记必须在项目 notes/ 目录内，拒绝写入".into());
    }
    // 图片按项目根相对路径解析，canonical 后同样必须在 notes/ 内（防 ../ 逃逸与绝对路径）
    let rel_img = rel_image_path.replace('\\', "/");
    let img = crate::paths::canonicalize_plain(&root.join(&rel_img))
        .map_err(|e| format!("图片不存在: {e}"))?;
    if !inside(&img, &canon_notes) {
        return Err("图片必须在项目 notes/ 目录内".into());
    }
    let note_dir = note.parent().ok_or("笔记路径无效")?;
    let rel = rel_md_path(note_dir, &img).ok_or("无法计算图片的相对路径")?;
    let text = fs::read_to_string(&note).map_err(|e| format!("读取笔记失败: {e}"))?;
    let new_text = append_image_to_section(&text, &format!("![截图]({rel})"));
    crate::profiles::atomic_write(&note, &new_text)
}

/// 把已落盘的截图链接追加进笔记「## 我的想法」小节（读-改-原子写）
#[tauri::command]
pub async fn append_note_image(
    project_root: String,
    note_path: String,
    rel_image_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        append_note_image_sync(&project_root, &note_path, &rel_image_path)
    })
    .await
    .map_err(|e| format!("写入笔记失败: {e}"))?
}

// ===== 批次 B3：生词本（notes/glossary.md）与译段保存 =====

/// 生词本条目 DTO（解析时已反转义，前端表格直接渲染）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryEntryDto {
    pub term: String,
    pub meaning: String,
    pub source: String,
}

/// 表头/分隔行（无文件或无表时按此建表；格式契约与 src/reader.ts 双端镜像，改动需同步）
const GLOSSARY_HEADER: &str = "| 术语 | 释义 | 出处 |";
const GLOSSARY_SEP: &str = "| --- | --- | --- |";

/// 单元格转义：| → \|、换行折成空格（表格单行约束）
fn escape_glossary_cell(s: &str) -> String {
    s.replace('|', "\\|").replace(['\r', '\n'], " ")
}

/// 按未转义的 | 切分行（\| 还原为 |），单元格 trim；非 | 起头的行返回空 Vec
fn split_glossary_row(line: &str) -> Vec<String> {
    let t = line.trim();
    if !t.starts_with('|') {
        return Vec::new();
    }
    let mut cells = Vec::new();
    let mut cur = String::new();
    let mut chars = t.chars().peekable();
    chars.next(); // 行首 | 只是起始符
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek() == Some(&'|') {
            cur.push('|');
            chars.next();
        } else if c == '|' {
            cells.push(cur.trim().to_string());
            cur.clear();
        } else {
            cur.push(c);
        }
    }
    cells.push(cur.trim().to_string());
    // 行尾 | 会多收一个空尾单元，去掉
    if cells.last().is_some_and(|c| c.is_empty()) {
        cells.pop();
    }
    cells
}

/// 分隔行判定：所有单元格只由 - : 空格组成且至少含一个 -
fn is_glossary_sep_row(cells: &[String]) -> bool {
    !cells.is_empty()
        && cells.iter().all(|c| {
            !c.is_empty() && c.contains('-') && c.chars().all(|ch| matches!(ch, '-' | ':' | ' '))
        })
}

/// 解析 glossary.md 的表格行（容错：非表行/表头/分隔行/不足 3 列/空术语一律跳过）
fn parse_glossary(text: &str) -> Vec<GlossaryEntryDto> {
    let mut out = Vec::new();
    for line in text.lines() {
        let cells = split_glossary_row(line);
        if cells.len() < 3 || cells[0].is_empty() {
            continue;
        }
        if cells[0] == "术语" || is_glossary_sep_row(&cells[..3]) {
            continue;
        }
        out.push(GlossaryEntryDto {
            term: cells[0].clone(),
            meaning: cells[1].clone(),
            source: cells[2].clone(),
        });
    }
    out
}

/// 整表渲染（表头 + 分隔 + 数据行，末尾换行收尾）
fn render_glossary(entries: &[GlossaryEntryDto]) -> String {
    let mut out = format!("{GLOSSARY_HEADER}\n{GLOSSARY_SEP}");
    for e in entries {
        out.push_str(&format!(
            "\n| {} | {} | {} |",
            escape_glossary_cell(&e.term),
            escape_glossary_cell(&e.meaning),
            escape_glossary_cell(&e.source)
        ));
    }
    out.push('\n');
    out
}

/// 写回口径：表外内容（标题/备注行）原样保留在前，表格整体重排在其后
/// （机管文件，与 lit_watch 的 watchlist 保留注释行同一思路）
fn splice_glossary(text: &str, entries: &[GlossaryEntryDto]) -> String {
    let kept: Vec<&str> = text
        .split('\n')
        .filter(|l| !l.trim().starts_with('|'))
        .collect();
    let head = kept.join("\n");
    let head = head.trim();
    if head.is_empty() {
        render_glossary(entries)
    } else {
        format!("{head}\n\n{}", render_glossary(entries))
    }
}

/// glossary.md 路径：notes/ 目录 canonical 双校验（symlink 指根外即拒）
fn glossary_path(root: &Path) -> Result<PathBuf, String> {
    let notes = root.join("notes");
    fs::create_dir_all(&notes).map_err(|e| format!("创建 notes 目录失败: {e}"))?;
    let canon_notes =
        crate::paths::canonicalize_plain(&notes).map_err(|e| format!("notes 目录无效: {e}"))?;
    if !inside(&canon_notes, root) {
        return Err("notes 指向项目目录之外，拒绝写入".into());
    }
    Ok(canon_notes.join("glossary.md"))
}

fn list_glossary_sync(project_root: &str) -> Result<Vec<GlossaryEntryDto>, String> {
    let root = gated_root(project_root)?;
    let path = glossary_path(&root)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取生词本失败: {e}"))?;
    Ok(parse_glossary(&text))
}

/// 生词本整表（无文件返回空表）
#[tauri::command]
pub async fn list_glossary(project_root: String) -> Result<Vec<GlossaryEntryDto>, String> {
    tauri::async_runtime::spawn_blocking(move || list_glossary_sync(&project_root))
        .await
        .map_err(|e| format!("读取生词本失败: {e}"))?
}

fn append_glossary_sync(
    project_root: &str,
    term: &str,
    meaning: &str,
    source: &str,
) -> Result<Vec<GlossaryEntryDto>, String> {
    let root = gated_root(project_root)?;
    let term = term.trim();
    if term.is_empty() {
        return Err("术语为空，未写入生词本".into());
    }
    let path = glossary_path(&root)?;
    let text = if path.exists() {
        fs::read_to_string(&path).map_err(|e| format!("读取生词本失败: {e}"))?
    } else {
        String::new()
    };
    let mut entries = parse_glossary(&text);
    // 按术语小写去重：重复 = 原位更新释义/出处（术语原写法与位置不动）
    let key = term.to_lowercase();
    if let Some(ex) = entries.iter_mut().find(|e| e.term.to_lowercase() == key) {
        ex.meaning = meaning.trim().to_string();
        ex.source = source.trim().to_string();
    } else {
        entries.push(GlossaryEntryDto {
            term: term.to_string(),
            meaning: meaning.trim().to_string(),
            source: source.trim().to_string(),
        });
    }
    crate::profiles::atomic_write(&path, &splice_glossary(&text, &entries))?;
    Ok(entries)
}

/// 加入/更新生词（按术语小写去重，重复 = 更新释义与出处），返回更新后整表
#[tauri::command]
pub async fn append_glossary(
    project_root: String,
    term: String,
    meaning: String,
    source: String,
) -> Result<Vec<GlossaryEntryDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        append_glossary_sync(&project_root, &term, &meaning, &source)
    })
    .await
    .map_err(|e| format!("写入生词本失败: {e}"))?
}

fn remove_glossary_entry_sync(
    project_root: &str,
    term: &str,
) -> Result<Vec<GlossaryEntryDto>, String> {
    let root = gated_root(project_root)?;
    let path = glossary_path(&root)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取生词本失败: {e}"))?;
    let target = term.trim();
    let entries: Vec<GlossaryEntryDto> = parse_glossary(&text)
        .into_iter()
        .filter(|e| e.term != target) // 精确匹配删行（大小写敏感，与前端 DTO 回传一致）
        .collect();
    crate::profiles::atomic_write(&path, &splice_glossary(&text, &entries))?;
    Ok(entries)
}

/// 删除生词（术语精确匹配），返回更新后整表
#[tauri::command]
pub async fn remove_glossary_entry(
    project_root: String,
    term: String,
) -> Result<Vec<GlossaryEntryDto>, String> {
    tauri::async_runtime::spawn_blocking(move || remove_glossary_entry_sync(&project_root, &term))
        .await
        .map_err(|e| format!("删除生词失败: {e}"))?
}

/// 译段块：`> 原文`（多行逐行引用，「（第 N 页）」挂末行）+ 空行 + 译文
fn translation_block(original: &str, translated: &str, page: u32) -> String {
    let quoted = original
        .lines()
        .map(|l| format!("> {l}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{quoted}（第 {page} 页）\n\n{translated}")
}

fn append_note_translation_sync(
    project_root: &str,
    note_path: &str,
    original: &str,
    translated: &str,
    page: u32,
) -> Result<(), String> {
    let root = gated_root(project_root)?;
    let note =
        crate::paths::canonicalize_plain(Path::new(&crate::sessions::expand_tilde(note_path)))
            .map_err(|e| format!("笔记不存在或不可读: {e}"))?;
    let canon_notes = crate::paths::canonicalize_plain(&root.join("notes"))
        .map_err(|e| format!("notes 目录无效: {e}"))?;
    if !inside(&note, &canon_notes) {
        return Err("笔记必须在项目 notes/ 目录内，拒绝写入".into());
    }
    let original = original.trim();
    let translated = translated.trim();
    if original.is_empty() || translated.is_empty() {
        return Err("译段内容为空，未写入笔记".into());
    }
    let text = fs::read_to_string(&note).map_err(|e| format!("读取笔记失败: {e}"))?;
    let new_text = append_block_to_section(
        &text,
        "译段",
        &translation_block(original, translated, page),
    );
    crate::profiles::atomic_write(&note, &new_text)
}

/// 保存译段到笔记「## 译段」小节末尾（无则补小节；读-改-原子写，笔记栏 watcher 自动刷新）
#[tauri::command]
pub async fn append_note_translation(
    project_root: String,
    note_path: String,
    original: String,
    translated: String,
    page: u32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        append_note_translation_sync(&project_root, &note_path, &original, &translated, page)
    })
    .await
    .map_err(|e| format!("写入笔记失败: {e}"))?
}

// ===== 标注：笔记「## 标注」小节（高亮与批注，一行一条；格式契约与 src/reader-note.ts 双端镜像） =====

const ANNOT_SECTION: &str = "标注";
/// 摘句上限（字符）：选一整页进来也只记开头，重定位靠前半段足够唯一
const ANNOT_QUOTE_MAX: usize = 500;

/// 笔记路径门槛：必须在项目 notes/ 内（canonical 双校验，同 append_note_translation 口径）
fn gated_note(project_root: &str, note_path: &str) -> Result<PathBuf, String> {
    let root = gated_root(project_root)?;
    let note =
        crate::paths::canonicalize_plain(Path::new(&crate::sessions::expand_tilde(note_path)))
            .map_err(|e| format!("笔记不存在或不可读: {e}"))?;
    let canon_notes = crate::paths::canonicalize_plain(&root.join("notes"))
        .map_err(|e| format!("notes 目录无效: {e}"))?;
    if !inside(&note, &canon_notes) {
        return Err("笔记必须在项目 notes/ 目录内，拒绝写入".into());
    }
    Ok(note)
}

/// 选段原文 → 落盘摘句：行尾「字母-换行」接回同一行（连字符保留：断词还是复合词分不清，留着照原样读；
/// 页内重定位时另试去掉连字符的写法）、空白折成单空格、「」换成“”（行格式靠「」定界）、截到上限
fn annotation_quote(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut joined = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '-' && i > 0 && chars[i - 1].is_alphabetic() {
            let mut j = i + 1;
            if j < chars.len() && chars[j] == '\r' {
                j += 1;
            }
            if j < chars.len() && chars[j] == '\n' {
                j += 1;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                joined.push('-');
                i = j;
                continue;
            }
        }
        joined.push(c);
        i += 1;
    }
    joined
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('「', "“")
        .replace('」', "”")
        .chars()
        .take(ANNOT_QUOTE_MAX)
        .collect()
}

/// `- p.3 「摘句」` 或 `- p.3 「摘句」 —— 批注`
fn annotation_line(page: u32, quote: &str, comment: &str) -> String {
    let comment = comment.split_whitespace().collect::<Vec<_>>().join(" ");
    if comment.is_empty() {
        format!("- p.{page} 「{quote}」")
    } else {
        format!("- p.{page} 「{quote}」 —— {comment}")
    }
}

/// 解析一行标注（页码 + 摘句）；不是标注行返回 None
fn parse_annotation_line(line: &str) -> Option<(u32, String)> {
    let t = line.trim_start();
    let t = t.strip_prefix("- ").or_else(|| t.strip_prefix("* "))?.trim_start();
    let t = t.strip_prefix('p')?;
    let t = t.strip_prefix('.').unwrap_or(t).trim_start();
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || digits.len() > 5 {
        return None;
    }
    let page: u32 = digits.parse().ok()?;
    let rest = t[digits.len()..].trim_start().strip_prefix('「')?;
    // 摘句止于第一个后面只跟空白再接「——」或行尾的 」（批注里出现 」 不截错）
    let mut from = 0;
    while let Some(pos) = rest[from..].find('」') {
        let end = from + pos;
        let after = rest[end + '」'.len_utf8()..].trim_start();
        if after.is_empty() || after.starts_with("——") {
            let quote = rest[..end].trim();
            return (page > 0 && !quote.is_empty()).then(|| (page, quote.to_string()));
        }
        from = end + '」'.len_utf8();
    }
    None
}

/// 二级小节的行区间：(标题行, 小节结束 = 下一个二级标题或文件尾)
fn section_bounds(lines: &[&str], section: &str) -> Option<(usize, usize)> {
    let header = format!("## {section}");
    let h = lines.iter().position(|l| l.trim() == header)?;
    let end = lines
        .iter()
        .enumerate()
        .skip(h + 1)
        .find(|(_, l)| l.starts_with("## "))
        .map(|(i, _)| i)
        .unwrap_or(lines.len());
    Some((h, end))
}

/// 追加一条标注：同页同摘句已在 → 有新批注就改写该行，否则原样不动（返回 None）。
/// 小节不存在时建在「## 译段」之前（机管两节保持收尾），没有译段就建在文件末尾。
/// 列表项之间不留空行（紧凑列表）
fn add_annotation_to_text(text: &str, page: u32, quote: &str, comment: &str) -> Option<String> {
    let new_line = annotation_line(page, quote, comment);
    let lines: Vec<&str> = text.split('\n').collect();
    if let Some((h, end)) = section_bounds(&lines, ANNOT_SECTION) {
        if let Some(i) = (h + 1..end)
            .find(|&i| parse_annotation_line(lines[i]).is_some_and(|(p, q)| p == page && q == quote))
        {
            if comment.trim().is_empty() || lines[i] == new_line {
                return None;
            }
            let mut out = lines.clone();
            out[i] = &new_line;
            return Some(out.join("\n"));
        }
        let mut tail = end;
        while tail > h + 1 && lines[tail - 1].trim().is_empty() {
            tail -= 1;
        }
        let mut out: Vec<&str> = lines[..tail].to_vec();
        if tail == h + 1 {
            out.push("");
        }
        out.push(&new_line);
        out.push("");
        out.extend_from_slice(&lines[end..]);
        return Some(out.join("\n"));
    }
    let block = format!("## {ANNOT_SECTION}\n\n{new_line}\n");
    if let Some(k) = lines.iter().position(|l| l.trim() == "## 译段") {
        let mut head = k;
        while head > 0 && lines[head - 1].trim().is_empty() {
            head -= 1;
        }
        let before = lines[..head].join("\n");
        let after = lines[k..].join("\n");
        return Some(if before.trim().is_empty() {
            format!("{block}\n{after}")
        } else {
            format!("{before}\n\n{block}\n{after}")
        });
    }
    Some(format!("{}\n\n{block}", text.trim_end()))
}

/// 删一条标注（同页同摘句的第一行）；删完小节空了连标题一起删。没找到返回 None
fn remove_annotation_from_text(text: &str, page: u32, quote: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let (h, end) = section_bounds(&lines, ANNOT_SECTION)?;
    let i = (h + 1..end)
        .find(|&i| parse_annotation_line(lines[i]).is_some_and(|(p, q)| p == page && q == quote))?;
    let rest_empty = (h + 1..end).all(|j| j == i || lines[j].trim().is_empty());
    if !rest_empty {
        let mut out = lines.clone();
        out.remove(i);
        return Some(out.join("\n"));
    }
    // 整节只剩这一条：连标题删掉，衔接处只留一个空行
    let mut head = h;
    while head > 0 && lines[head - 1].trim().is_empty() {
        head -= 1;
    }
    let before = lines[..head].join("\n");
    if end >= lines.len() {
        return Some(format!("{}\n", before.trim_end()));
    }
    let after = lines[end..].join("\n");
    Some(if before.trim().is_empty() {
        after
    } else {
        format!("{before}\n\n{after}")
    })
}

fn append_note_annotation_sync(
    project_root: &str,
    note_path: &str,
    page: u32,
    quote: &str,
    comment: &str,
) -> Result<(), String> {
    let note = gated_note(project_root, note_path)?;
    let quote = annotation_quote(quote);
    if quote.is_empty() || page == 0 {
        return Err("没有选中文字，未写入标注".into());
    }
    let text = fs::read_to_string(&note).map_err(|e| format!("读取笔记失败: {e}"))?;
    match add_annotation_to_text(&text, page, &quote, comment) {
        Some(next) => crate::profiles::atomic_write(&note, &next),
        None => Ok(()),
    }
}

/// 高亮/批注记进笔记「## 标注」小节（读-改-原子写；同一处再标只更新批注）
#[tauri::command]
pub async fn append_note_annotation(
    project_root: String,
    note_path: String,
    page: u32,
    quote: String,
    comment: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        append_note_annotation_sync(&project_root, &note_path, page, &quote, &comment)
    })
    .await
    .map_err(|e| format!("写入标注失败: {e}"))?
}

fn remove_note_annotation_sync(
    project_root: &str,
    note_path: &str,
    page: u32,
    quote: &str,
) -> Result<bool, String> {
    let note = gated_note(project_root, note_path)?;
    let quote = annotation_quote(quote);
    let text = fs::read_to_string(&note).map_err(|e| format!("读取笔记失败: {e}"))?;
    match remove_annotation_from_text(&text, page, &quote) {
        Some(next) => crate::profiles::atomic_write(&note, &next).map(|_| true),
        None => Ok(false),
    }
}

/// 从笔记「## 标注」删一条（返回 false = 笔记里已经没有这条，比如手动删过）
#[tauri::command]
pub async fn remove_note_annotation(
    project_root: String,
    note_path: String,
    page: u32,
    quote: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        remove_note_annotation_sync(&project_root, &note_path, page, &quote)
    })
    .await
    .map_err(|e| format!("删除标注失败: {e}"))?
}

// ===== 文献题名：顶栏《》与新笔记标题 =====

/// 截断文件名认题名的最短前缀（规范化后字符数）：太短的前缀会撞上别的篇
const TITLE_PREFIX_MIN: usize = 24;

/// 题名对得上 PDF 文件名：规范化后相等，或文件名够长且是题名前缀（雷达下载限长截断、`/` 改 `_` 都吃得下）
fn title_matches_stem(title: &str, stem_norm: &str) -> bool {
    let t = crate::lit_watch::normalize_title(title);
    !t.is_empty()
        && !stem_norm.is_empty()
        && (t == stem_norm
            || (stem_norm.chars().count() >= TITLE_PREFIX_MIN && t.starts_with(stem_norm)))
}

/// 笔记头部的一级标题
fn note_h1(content: &str) -> Option<String> {
    content
        .lines()
        .take(5)
        .find_map(|l| l.trim().strip_prefix("# ").map(|t| t.trim().to_string()))
        .filter(|t| !t.is_empty())
}

/// 清单行的题名去掉列表前缀
fn clean_list_title(t: &str) -> String {
    t.trim()
        .trim_start_matches(['-', '*'])
        .trim()
        .to_string()
}

/// 在项目题录里找这份 PDF 的真实题名：配对笔记的标题（不是文件名本身时）→ notes/index.json →
/// papers/included.json（fulltext 字段直接写着这个文件名的优先）→ included.md / reading-list.md →
/// 雷达收件箱。都对不上返回 None（调用方回落文件名）
fn paper_title_for(root: &Path, pdf: &Path) -> Option<String> {
    let file_name = pdf.file_name()?.to_string_lossy().into_owned();
    let stem = pdf.file_stem()?.to_string_lossy().into_owned();
    let stem_norm = crate::lit_watch::normalize_title(&stem);
    if let Some(note) = find_note_by_source(&root.join("notes"), root, pdf) {
        if let Some(h1) = fs::read_to_string(&note).ok().and_then(|c| note_h1(&c)) {
            let n = crate::lit_watch::normalize_title(&h1);
            // 阅读区建档的笔记标题就是文件名（可能已截断），那不算题名
            if !n.is_empty() && !stem_norm.starts_with(&n) {
                return Some(h1);
            }
        }
    }
    let read = |rel: &str| crate::lit_watch::read_text_inside(root, rel).ok().flatten();
    for rel in ["notes/index.json", "papers/included.json"] {
        let Some(list) = read(rel)
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.as_array().cloned())
        else {
            continue;
        };
        let titled = list.iter().filter_map(|e| {
            let title = e.get("title")?.as_str()?.trim();
            (!title.is_empty()).then(|| (title.to_string(), e))
        });
        let titled: Vec<_> = titled.collect();
        if let Some((t, _)) = titled.iter().find(|(_, e)| {
            ["fulltext", "pdf", "pdfPath"].iter().any(|k| {
                e.get(*k)
                    .and_then(|v| v.as_str())
                    .is_some_and(|s| s.contains(&file_name))
            })
        }) {
            return Some(t.clone());
        }
        if let Some((t, _)) = titled.iter().find(|(t, _)| title_matches_stem(t, &stem_norm)) {
            return Some(t.clone());
        }
    }
    for rel in ["papers/included.md", "papers/reading-list.md"] {
        if let Some(t) = read(rel).and_then(|text| {
            crate::lit_watch::parse_included(&text)
                .into_iter()
                .map(|e| clean_list_title(&e.title))
                .find(|t| title_matches_stem(t, &stem_norm))
        }) {
            return Some(t);
        }
    }
    read("notes/inbox.md").and_then(|text| {
        crate::lit_watch::watch_inbox_from_text(&text)
            .into_iter()
            .map(|e| e.title.trim().to_string())
            .find(|t| title_matches_stem(t, &stem_norm))
    })
}

fn reader_paper_title_sync(project_root: &str, pdf_path: &str) -> Result<Option<String>, String> {
    let root = gated_root(project_root)?;
    let pdf = crate::paths::canonicalize_plain(Path::new(&crate::sessions::expand_tilde(pdf_path)))
        .map_err(|e| format!("PDF 不存在或不可读: {e}"))?;
    if !readable_project_pdf(&root, &pdf) {
        return Ok(None);
    }
    Ok(paper_title_for(&root, &pdf))
}

/// 阅读区顶栏用的真实题名（文件名常被截断/改写）；查不到返回 None，前端回落文件名
#[tauri::command]
pub async fn reader_paper_title(
    project_root: String,
    pdf_path: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || reader_paper_title_sync(&project_root, &pdf_path))
        .await
        .map_err(|e| format!("读取文献题名失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拼一份 AIFF / AIFC：22050 Hz、16 位、单声道、三个采样
    fn aiff(form: &[u8; 4], codec: Option<&[u8; 4]>, samples: &[u8]) -> Vec<u8> {
        let mut comm = vec![0, 1, 0, 0, 0, 3, 0, 16];
        comm.extend_from_slice(&[0x40, 0x0D, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]);
        if let Some(c) = codec {
            comm.extend_from_slice(c);
            comm.extend_from_slice(&[0, 0]); // 空的 pascal 串（补齐到偶数）
        }
        let mut ssnd = vec![0u8; 8];
        ssnd.extend_from_slice(samples);
        let mut body = form.to_vec();
        for (id, chunk) in [(b"COMM", &comm), (b"SSND", &ssnd)] {
            body.extend_from_slice(id);
            body.extend_from_slice(&(chunk.len() as u32).to_be_bytes());
            body.extend_from_slice(chunk);
        }
        let mut out = b"FORM".to_vec();
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn aiff_converts_to_playable_wav() {
        let be = [0x12, 0x34, 0xFF, 0xFE, 0x00, 0x01];
        let wav = aiff_to_wav(&aiff(b"AIFF", None, &be)).unwrap();
        assert!(audio_magic_ok("audio/wav", &wav));
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1, "单声道");
        assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 22050);
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
        assert_eq!(&wav[44..], &[0x34, 0x12, 0xFE, 0xFF, 0x01, 0x00], "大端翻成小端");
        // AIFC：NONE 同 AIFF；sowt 已是小端照搬；压缩编码转不了
        let none = aiff_to_wav(&aiff(b"AIFC", Some(b"NONE"), &be)).unwrap();
        assert_eq!(&none[44..], &wav[44..]);
        let sowt = aiff_to_wav(&aiff(b"AIFC", Some(b"sowt"), &be)).unwrap();
        assert_eq!(&sowt[44..], &be);
        assert!(aiff_to_wav(&aiff(b"AIFC", Some(b"ima4"), &be)).is_none());
        assert!(aiff_to_wav(b"RIFF....WAVE").is_none());
    }

    #[test]
    fn extended_sample_rates() {
        assert_eq!(extended_to_f64(&[0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]), 44100.0);
        assert_eq!(extended_to_f64(&[0x40, 0x0E, 0xBB, 0x80, 0, 0, 0, 0, 0, 0]), 48000.0);
    }

    fn tmpdir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ccode-reader-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        // 生产路径下 root 恒为剥过 verbatim 的 canonical（ensure_task_project_root），测试同口径：
        // macOS 的 temp_dir 在 /var（软链到 /private/var），不 canonicalize 会让前缀判定误杀
        crate::paths::canonicalize_plain(&dir).unwrap()
    }

    /// 造一个「含 .ccode/project.toml + papers/一篇.pdf」的临时项目，返回 (canonical 根, pdf 路径)
    fn project_with_pdf(name: &str, pdf_name: &str) -> (PathBuf, PathBuf) {
        let root = tmpdir(name);
        let ccode = root.join(".ccode");
        fs::create_dir_all(&ccode).unwrap();
        fs::write(ccode.join("project.toml"), "name = \"t\"\n").unwrap();
        let papers = root.join("papers");
        fs::create_dir_all(&papers).unwrap();
        let pdf = papers.join(pdf_name);
        fs::write(&pdf, b"%PDF-fake").unwrap();
        (root, pdf)
    }

    // ===== 建档配对（来源行锚点） =====

    #[test]
    fn find_note_by_source_tolerates_backslash_anchor() {
        // 锚点按 Windows 反斜杠写法也认：anchor_pdf_candidate 统一解析成 canonical 再比。
        // 大小写敏感性随文件系统语义（canonicalize 按盘上真实文件解析），
        // 不再做字面大小写断言——旧断言在大小写不敏感盘上会误伤真实同一文件
        let (root, pdf) = project_with_pdf("src-case", "Foo.pdf");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join("a.md"), "> 来源 PDF：papers\\Foo.pdf\n").unwrap();
        let pdf_c = crate::paths::canonicalize_plain(&pdf).unwrap();
        assert_eq!(
            find_note_by_source(&notes, &root, &pdf_c),
            Some(notes.join("a.md"))
        );
    }

    #[test]
    fn ensure_pairs_note_with_absolute_anchor() {
        // agent 实测口径：锚点几乎总写成项目根绝对路径（镁硫电池综述 156/156）。
        // 从 PDF 侧进阅读区必须认回这份精读笔记，不得按 slug 另建平行模板
        let (root, pdf) = project_with_pdf("abs-anchor", "Some Paper.pdf");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let numbered = notes.join("01-中文短标题精读.md");
        fs::write(
            &numbered,
            format!(
                "# 中文短标题\n\n> 来源 PDF：{}/papers/Some Paper.pdf\n\n## 研究问题\n",
                root.to_string_lossy()
            ),
        )
        .unwrap();
        let dto = ensure_paper_note_sync(&root.to_string_lossy(), &pdf.to_string_lossy()).unwrap();
        assert!(!dto.created);
        assert_eq!(PathBuf::from(&dto.path), numbered);
        assert!(!notes.join("Some-Paper.md").exists(), "不得另建 slug 笔记");
    }

    #[test]
    fn pair_pdf_accepts_absolute_anchor() {
        let (root, pdf) = project_with_pdf("abs-pair", "Some Paper.pdf");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let note = notes.join("02-中文短标题.md");
        fs::write(
            &note,
            format!(
                "# 中文短标题\n\n> 来源 PDF：{}/papers/Some Paper.pdf\n",
                root.to_string_lossy()
            ),
        )
        .unwrap();
        let note_c = crate::paths::canonicalize_plain(&note).unwrap();
        let root_c = crate::paths::canonicalize_plain(&root).unwrap();
        let got = pair_pdf_at(&root_c, &note_c).unwrap();
        assert_eq!(
            got,
            Some(
                crate::paths::canonicalize_plain(&pdf)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            )
        );
    }

    #[test]
    fn source_pdf_parses_both_formats() {
        assert_eq!(
            note_source_pdf("# T\n\n> 来源 PDF：papers/a b.pdf\n\n## 研究问题"),
            Some("papers/a b.pdf".to_string())
        );
        assert_eq!(
            note_source_pdf("# T\n\n> 来源：papers/a b.pdf · 开始阅读 2026-08-20\n"),
            Some("papers/a b.pdf".to_string())
        );
        // 非来源行 / 非 pdf 结尾不认
        assert_eq!(note_source_pdf("# T\n\n## 研究问题\n"), None);
        assert_eq!(note_source_pdf("> 来源：notes/x.md\n"), None);
    }

    #[test]
    fn untouched_template_detection() {
        let tpl = note_template("T", "papers/a.pdf", "2026-08-20");
        assert!(note_is_untouched(&tpl));
        assert!(!note_is_untouched(
            &tpl.replace("## 研究问题", "## 研究问题\n\n写了内容")
        ));
    }

    #[test]
    fn ensure_returns_existing_sourced_note_without_creating_slug() {
        let (root, pdf) = project_with_pdf("pair", "Some Paper.pdf");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        // 精读步骤产物：序号-短标题命名 + 来源行锚点
        let numbered = notes.join("01-某某主题精读.md");
        fs::write(
            &numbered,
            "# 某某主题\n\n> 来源 PDF：papers/Some Paper.pdf\n\n## 研究问题\n",
        )
        .unwrap();
        let dto = ensure_paper_note_sync(&root.to_string_lossy(), &pdf.to_string_lossy()).unwrap();
        assert!(!dto.created);
        assert_eq!(PathBuf::from(&dto.path), numbered);
        // 没有另建 slug 笔记
        assert!(!notes.join("Some-Paper.md").exists());
    }

    #[test]
    fn ensure_prefers_sourced_note_and_cleans_untouched_slug() {
        let (root, pdf) = project_with_pdf("merge", "Some Paper.pdf");
        // 先建出 slug 模板笔记（模拟此前「开读」误建）
        let first =
            ensure_paper_note_sync(&root.to_string_lossy(), &pdf.to_string_lossy()).unwrap();
        assert!(first.created);
        // 之后精读步骤产出了带来源行的正式笔记
        let numbered = root.join("notes/01-正式精读.md");
        fs::write(
            &numbered,
            "# 正式\n\n> 来源 PDF：papers/Some Paper.pdf\n\n## 研究问题\n",
        )
        .unwrap();
        let dto = ensure_paper_note_sync(&root.to_string_lossy(), &pdf.to_string_lossy()).unwrap();
        assert!(!dto.created);
        assert_eq!(PathBuf::from(&dto.path), numbered);
        // 空模板 slug 笔记被清掉（回收站不可用的环境则保留，两种情况都不许再当主笔记返回）
        let slug = root.join("notes/Some-Paper.md");
        if slug.exists() {
            let content = fs::read_to_string(&slug).unwrap();
            assert!(note_is_untouched(&content));
        }
    }

    #[test]
    fn pair_fallback_scans_papers_dir_without_registration() {
        // 检索步 agent 直下的 PDF 没登记进 project.toml：无来源行的笔记靠 papers/ 扫描配对
        let (root, pdf) = project_with_pdf("papers-scan", "Some Paper.pdf");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let note = notes.join("04-Some Paper 精读.md");
        fs::write(&note, "# Some Paper\n\n## 研究问题\n").unwrap(); // 无来源行
        let note_c = crate::paths::canonicalize_plain(&note).unwrap();
        let root_c = crate::paths::canonicalize_plain(&root).unwrap();
        let got = pair_pdf_at(&root_c, &note_c).unwrap();
        assert_eq!(
            got,
            Some(
                crate::paths::canonicalize_plain(&pdf)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            )
        );
    }

    #[test]
    fn pair_fallback_ignores_mismatched_papers_dir_pdf() {
        // papers/ 里有别的 PDF 但标题互相包含不上：不误配，返回 None
        let (root, _pdf) = project_with_pdf("papers-miss", "Some Paper.pdf");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let note = notes.join("05-另一篇主题.md");
        fs::write(&note, "# 另一篇\n\n## 研究问题\n").unwrap();
        let note_c = crate::paths::canonicalize_plain(&note).unwrap();
        let root_c = crate::paths::canonicalize_plain(&root).unwrap();
        assert_eq!(pair_pdf_at(&root_c, &note_c).unwrap(), None);
    }

    #[test]
    fn pair_pdf_prefers_source_line_over_title_guess() {
        let (root, pdf) =
            project_with_pdf("anchor", "English Title That Chinese Note Cannot Match.pdf");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let note = notes.join("02-中文短标题.md");
        fs::write(
            &note,
            "# 中文短标题\n\n> 来源 PDF：papers/English Title That Chinese Note Cannot Match.pdf\n",
        )
        .unwrap();
        let note_c = crate::paths::canonicalize_plain(&note).unwrap();
        let root_c = crate::paths::canonicalize_plain(&root).unwrap();
        let got = pair_pdf_at(&root_c, &note_c).unwrap();
        assert_eq!(
            got,
            Some(
                crate::paths::canonicalize_plain(&pdf)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            )
        );
    }

    #[test]
    fn creates_note_from_template() {
        let (root, pdf) = project_with_pdf("create", "My Paper 2026.pdf");
        let dto = ensure_paper_note_sync(&root.to_string_lossy(), &pdf.to_string_lossy()).unwrap();
        assert!(dto.created);
        assert!(Path::new(&dto.path).ends_with("notes/My-Paper-2026.md"));
        let text = fs::read_to_string(&dto.path).unwrap();
        assert!(text.starts_with("# My Paper 2026\n"));
        assert!(text.contains("> 来源：papers/My Paper 2026.pdf · 开始阅读 "));
        for h in [
            "## 一句话总结",
            "## 研究问题",
            "## 方法",
            "## 主要结果",
            "## 局限",
            "## 可引用点",
            "## 与本课题的关系",
            "## 疑问与待跟进",
            "## 译段",
            "## 我的想法",
        ] {
            assert!(text.contains(h), "缺少小节 {h}");
        }
    }

    #[test]
    fn second_call_never_overwrites() {
        let (root, pdf) = project_with_pdf("keep", "a.pdf");
        let first =
            ensure_paper_note_sync(&root.to_string_lossy(), &pdf.to_string_lossy()).unwrap();
        fs::write(&first.path, "人手改过的内容").unwrap();
        let second =
            ensure_paper_note_sync(&root.to_string_lossy(), &pdf.to_string_lossy()).unwrap();
        assert!(!second.created);
        assert_eq!(second.path, first.path);
        assert_eq!(fs::read_to_string(&second.path).unwrap(), "人手改过的内容");
    }

    #[test]
    fn pdf_for_note_matches_numbered_note() {
        let root = tmpdir("pair");
        let ccode = root.join(".ccode");
        fs::create_dir_all(&ccode).unwrap();
        fs::write(
            ccode.join("project.toml"),
            "name = \"t\"\n\n[[resources]]\nname = \"转化型正极Mg电池透视\"\npath = \"papers/转化型正极Mg电池透视.pdf\"\ntype = \"paper\"\n",
        )
        .unwrap();
        let papers = root.join("papers");
        fs::create_dir_all(&papers).unwrap();
        fs::write(papers.join("转化型正极Mg电池透视.pdf"), b"%PDF-fake").unwrap();
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        // lit-notes 口径的序号前缀笔记：normalize 互相包含应命中
        let note = notes.join("124-转化型正极Mg电池透视与迷你综述.md");
        fs::write(&note, "# t").unwrap();
        let got = pdf_for_note_sync(&root.to_string_lossy(), &note.to_string_lossy())
            .unwrap()
            .expect("应命中配对 PDF");
        assert!(got.ends_with("papers/转化型正极Mg电池透视.pdf"), "{got}");
        fs::write(
            &note,
            "> 来源 PDF：papers/转化型正极Mg电池透视.pdf\n\n# t\n",
        )
        .unwrap();
        fs::write(notes.join("inbox.md"), "# 雷达收件箱").unwrap();
        let links = list_paper_notes_sync(&root.to_string_lossy()).unwrap();
        assert!(
            links
                .iter()
                .any(|l| l.pdf_rel.as_deref() == Some("papers/转化型正极Mg电池透视.pdf")),
            "{links:?}"
        );
        assert!(
            !links
                .iter()
                .any(|l| l.note_name.eq_ignore_ascii_case("inbox.md")),
            "{links:?}"
        );
    }

    #[test]
    fn external_registered_pdf_can_pair_but_sibling_cannot() {
        let (root, _) = project_with_pdf("external-pdf", "internal.pdf");
        let external = tmpdir("external-library");
        let pdf = external.join("paper.pdf");
        fs::write(&pdf, b"%PDF-fixture").unwrap();
        let sibling = external.join("private.pdf");
        fs::write(&sibling, b"%PDF-private").unwrap();
        let mut cfg = crate::projects::read_config_at(&root).config;
        cfg.resources.push(crate::projects::ResourceDto {
            name: "External Paper".into(),
            path: pdf.to_string_lossy().into(),
            kind: "paper".into(),
            readonly: true,
            ..Default::default()
        });
        crate::projects::write_config_at(&root, &cfg).unwrap();
        let note = ensure_paper_note_sync(&root.to_string_lossy(), &pdf.to_string_lossy()).unwrap();
        assert!(Path::new(&note.path).starts_with(&root));
        let paired = pdf_for_note_sync(&root.to_string_lossy(), &note.path).unwrap();
        assert!(
            crate::paths::same_path(paired.as_deref().unwrap_or(""), &pdf.to_string_lossy()),
            "{paired:?} vs {pdf:?}"
        );
        assert!(
            ensure_paper_note_sync(&root.to_string_lossy(), &sibling.to_string_lossy()).is_err()
        );
        assert_eq!(fs::read(&pdf).unwrap(), b"%PDF-fixture");
        fs::create_dir_all(external.join("other")).unwrap();
        let second = external.join("other/paper.pdf");
        fs::write(&second, b"%PDF-second").unwrap();
        cfg.resources.push(crate::projects::ResourceDto {
            name: "Other Paper".into(),
            path: second.to_string_lossy().into(),
            kind: "paper".into(),
            readonly: true,
            ..Default::default()
        });
        crate::projects::write_config_at(&root, &cfg).unwrap();
        let second_note =
            ensure_paper_note_sync(&root.to_string_lossy(), &second.to_string_lossy()).unwrap();
        assert_ne!(second_note.path, note.path);
        assert_eq!(
            ensure_paper_note_sync(&root.to_string_lossy(), &second.to_string_lossy())
                .unwrap()
                .path,
            second_note.path
        );
        assert!(Path::new(&note.path).exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(external).unwrap();
    }

    #[test]
    fn pdf_for_note_none_when_no_match() {
        let (root, _pdf) = project_with_pdf("pair-none", "My Paper 2026.pdf");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let note = notes.join("完全无关的笔记.md");
        fs::write(&note, "# t").unwrap();
        assert!(
            pdf_for_note_sync(&root.to_string_lossy(), &note.to_string_lossy())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn pdf_for_note_rejects_outside_root() {
        let (root, _pdf) = project_with_pdf("pair-out", "a.pdf");
        let outside = tmpdir("pair-out-note").join("x.md");
        fs::write(&outside, "# t").unwrap();
        let err =
            pdf_for_note_sync(&root.to_string_lossy(), &outside.to_string_lossy()).unwrap_err();
        assert!(err.contains("项目目录之外"), "{err}");
    }

    // ===== 抽查笔记：工作区里的笔记配项目根的原文 =====

    #[test]
    fn spot_check_pairs_worktree_note_with_root_pdf() {
        let (root, pdf) = project_with_pdf("spot-root", "Smith 2024 Mg cathode.pdf");
        let wt = tmpdir("spot-wt");
        fs::create_dir_all(wt.join("notes")).unwrap();
        fs::create_dir_all(wt.join("papers")).unwrap();
        fs::write(
            wt.join("notes/012-镁正极.md"),
            "> 来源 PDF：papers/Smith 2024 Mg cathode.pdf\n\n# 镁正极\n",
        )
        .unwrap();
        fs::write(
            wt.join("papers/included.json"),
            r#"[{"id":"p12","title":"Mg cathode","abstract":"We report a cathode."},
                {"id":"p13","title":"Other","abstract":"待补"}]"#,
        )
        .unwrap();
        let got = spot_check_item_at(&root, &wt, true, "notes/012-镁正极.md", Some("p12")).unwrap();
        assert!(got.read_only);
        assert!(
            crate::paths::same_path(got.pdf_path.as_deref().unwrap_or(""), &pdf.to_string_lossy()),
            "{got:?}"
        );
        assert!(Path::new(&got.note_path).starts_with(&wt), "{got:?}");
        assert_eq!(got.title.as_deref(), Some("Mg cathode"));
        assert_eq!(got.abstract_text.as_deref(), Some("We report a cathode."));

        // 仅摘要的篇：没有 PDF，「待补」摘要不当原文
        fs::write(wt.join("notes/013-其他.md"), "# 其他\n").unwrap();
        let brief = spot_check_item_at(&root, &wt, true, "notes/013-其他.md", Some("p13")).unwrap();
        assert!(brief.pdf_path.is_none(), "{brief:?}");
        assert!(brief.abstract_text.is_none(), "{brief:?}");
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(wt).unwrap();
    }

    #[test]
    fn spot_check_falls_back_to_included_pdf_field() {
        let (root, _) = project_with_pdf("spot-field", "unrelated.pdf");
        fs::write(root.join("papers/oa-download.pdf"), b"%PDF-oa").unwrap();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/001-短标题.md"), "# 短标题\n").unwrap();
        fs::write(
            root.join("papers/included.json"),
            r#"{"records":[{"id":"a1","pdf":"papers/oa-download.pdf"}]}"#,
        )
        .unwrap();
        let got = spot_check_item_at(&root, &root, false, "notes/001-短标题.md", Some("a1")).unwrap();
        assert!(!got.read_only);
        assert!(
            got.pdf_path.as_deref().is_some_and(|p| p.ends_with("papers/oa-download.pdf")),
            "{got:?}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn spot_check_rejects_note_outside_notes_dir() {
        let (root, _) = project_with_pdf("spot-out", "a.pdf");
        fs::write(root.join("secret.md"), "# x").unwrap();
        let err = spot_check_item_at(&root, &root, false, "secret.md", None).unwrap_err();
        assert!(err.contains("notes/"), "{err}");
        let err = spot_check_item_at(&root, &root, false, "notes/../secret.md", None).unwrap_err();
        assert!(err.contains("notes/"), "{err}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn slug_sanitizes_separators_controls_and_blanks() {
        assert_eq!(slugify_note_stem("a/b\\c"), "abc");
        assert_eq!(slugify_note_stem("hello  world\twide"), "hello-world-wide");
        assert_eq!(slugify_note_stem("  前后空白  "), "前后空白");
        assert_eq!(slugify_note_stem("a\u{0007}b"), "ab");
        assert_eq!(slugify_note_stem(" \t "), "paper");
        assert_eq!(slugify_note_stem(&"长".repeat(100)).chars().count(), 80);
    }

    #[test]
    fn rejects_pdf_outside_root() {
        let (root, _pdf) = project_with_pdf("outside", "a.pdf");
        let outside_root = tmpdir("outside-pdf");
        let outside = outside_root.join("x.pdf");
        fs::write(&outside, b"%PDF-fake").unwrap();
        let err = ensure_paper_note_sync(&root.to_string_lossy(), &outside.to_string_lossy())
            .unwrap_err();
        assert!(err.contains("项目目录"), "意外报错：{err}");
    }

    #[test]
    fn rejects_unregistered_root() {
        let (root, _pdf) = project_with_pdf("unregistered", "a.pdf");
        // 删掉档案卡后即不命中门槛（未注册且无 .ccode/project.toml）
        fs::remove_file(root.join(".ccode/project.toml")).unwrap();
        let pdf = root.join("papers/a.pdf");
        assert!(ensure_paper_note_sync(&root.to_string_lossy(), &pdf.to_string_lossy()).is_err());
    }

    // ===== 批次 B2：图片通道 =====

    /// 最小合法 PNG（8 字节魔数+长度即可，本模块只校验前 4 字节魔数）
    const FAKE_PNG: &[u8] = b"\x89PNG\r\n\x1a\n";

    fn project_with_note(name: &str) -> (PathBuf, PathBuf) {
        let (root, _pdf) = project_with_pdf(name, "a.pdf");
        let dto = ensure_paper_note_sync(
            &root.to_string_lossy(),
            &root.join("papers/a.pdf").to_string_lossy(),
        )
        .unwrap();
        (root, PathBuf::from(dto.path))
    }

    #[test]
    fn read_audio_checks_extension_and_header() {
        let dir = tmpdir("audio");
        let hint = Some(dir.to_str().unwrap());
        // say -o 的默认产物：FORM....AIFF
        let aiff = dir.join("mesa.aiff");
        fs::write(&aiff, b"FORM\x00\x00\x00\x10AIFFCOMM").unwrap();
        assert_eq!(read_audio_sync(aiff.to_str().unwrap(), hint).unwrap().mime, "audio/aiff");
        let wav = dir.join("a.wav");
        fs::write(&wav, b"RIFF\x00\x00\x00\x00WAVEfmt ").unwrap();
        assert_eq!(read_audio_sync(wav.to_str().unwrap(), hint).unwrap().mime, "audio/wav");
        let mp3 = dir.join("a.mp3");
        fs::write(&mp3, b"ID3\x04\x00").unwrap();
        assert_eq!(read_audio_sync(mp3.to_str().unwrap(), hint).unwrap().mime, "audio/mpeg");
        let m4a = dir.join("a.m4a");
        fs::write(&m4a, b"\x00\x00\x00\x20ftypM4A ").unwrap();
        assert_eq!(read_audio_sync(m4a.to_str().unwrap(), hint).unwrap().mime, "audio/mp4");
        // 改了后缀的文本文件、不在名单里的扩展名都拒绝
        let fake = dir.join("fake.mp3");
        fs::write(&fake, "not audio").unwrap();
        assert!(read_audio_sync(fake.to_str().unwrap(), hint).unwrap_err().contains("不是有效的音频"));
        let txt = dir.join("a.txt");
        fs::write(&txt, "x").unwrap();
        assert!(read_audio_sync(txt.to_str().unwrap(), hint).unwrap_err().contains("只支持"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_image_ok_and_mime_by_ext() {
        let dir = tmpdir("img-ok");
        let f = dir.join("fig.png");
        fs::write(&f, FAKE_PNG).unwrap();
        let dto = read_image_sync(f.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap();
        assert_eq!(dto.mime, "image/png");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&dto.data)
            .unwrap();
        assert_eq!(decoded, FAKE_PNG);
        // svg 走同一通道，mime 按扩展名
        let svg = dir.join("icon.svg");
        fs::write(&svg, "<svg/>").unwrap();
        let dto2 = read_image_sync(svg.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap();
        assert_eq!(dto2.mime, "image/svg+xml");
        let gif = dir.join("a.gif");
        fs::write(&gif, b"GIF89a\x01\x00\x01\x00").unwrap();
        let dto3 = read_image_sync(gif.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap();
        assert_eq!(dto3.mime, "image/gif");
        let fake = dir.join("lfs.gif");
        fs::write(&fake, "version https://git-lfs.github.com/spec/v1\n").unwrap();
        let err = read_image_sync(fake.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap_err();
        assert!(err.contains("不是有效的图片"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_image_rejects_ext_and_escape() {
        let root = tmpdir("img-root");
        let outside = tmpdir("img-outside");
        let txt = root.join("notes.txt");
        fs::write(&txt, "plain").unwrap();
        let err = read_image_sync(txt.to_str().unwrap(), Some(root.to_str().unwrap())).unwrap_err();
        assert!(err.contains("只支持"), "{err}");
        // hint 根外（且不在任何注册来源内）：白名单拒绝
        let f = outside.join("fig.png");
        fs::write(&f, FAKE_PNG).unwrap();
        let err2 = read_image_sync(f.to_str().unwrap(), Some(root.to_str().unwrap())).unwrap_err();
        assert!(err2.contains("拒绝读取"), "{err2}");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn read_image_rejects_oversize() {
        let dir = tmpdir("img-cap");
        let f = dir.join("huge.png");
        let file = fs::File::create(&f).unwrap();
        file.set_len(IMAGE_CAP + 1).unwrap(); // 稀疏文件置长度，不真写 20MB
        drop(file);
        let err = read_image_sync(f.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap_err();
        assert!(err.contains("20 MB"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_capture_checks_magic_and_writes() {
        let (root, _note) = project_with_note("capture");
        let b64 = base64::engine::general_purpose::STANDARD.encode(FAKE_PNG);
        let dto = save_reader_capture_sync(&root.to_string_lossy(), &b64).unwrap();
        assert!(
            dto.rel_path.starts_with("notes/assets/capture-"),
            "{}",
            dto.rel_path
        );
        assert!(dto.rel_path.ends_with(".png"));
        assert_eq!(fs::read(&dto.abs_path).unwrap(), FAKE_PNG);
        // 非 PNG 内容（魔数不符）拒绝
        let bad = base64::engine::general_purpose::STANDARD.encode(b"GIF89a fake");
        let err = save_reader_capture_sync(&root.to_string_lossy(), &bad).unwrap_err();
        assert!(err.contains("PNG"), "{err}");
        // 非法 base64 拒绝
        assert!(save_reader_capture_sync(&root.to_string_lossy(), "!!!not-b64!!!").is_err());
    }

    #[test]
    fn capture_name_collision_gets_suffix() {
        let dir = tmpdir("cap-name");
        fs::write(dir.join("capture-t.png"), b"x").unwrap();
        fs::write(dir.join("capture-t-2.png"), b"x").unwrap();
        assert_eq!(next_asset_name(&dir, "capture", "t", "png"), "capture-t-3.png");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn append_image_to_existing_section_end() {
        let (root, note) = project_with_note("append");
        // 笔记模板自带「## 我的想法」收尾小节；在其后再挂一节，验证插在小节末尾而非文件尾
        let mut text = fs::read_to_string(&note).unwrap();
        text.push_str("\n已有一条想法\n\n## 后续小节\n\n别的内容\n");
        fs::write(&note, &text).unwrap();
        fs::create_dir_all(root.join("notes/assets")).unwrap();
        fs::write(root.join("notes/assets/capture-x.png"), FAKE_PNG).unwrap();
        append_note_image_sync(
            &root.to_string_lossy(),
            &note.to_string_lossy(),
            "notes/assets/capture-x.png",
        )
        .unwrap();
        let out = fs::read_to_string(&note).unwrap();
        let expected = "已有一条想法\n\n![截图](assets/capture-x.png)\n\n## 后续小节";
        assert!(out.contains(expected), "实际内容：\n{out}");
    }

    #[test]
    fn append_image_creates_section_when_missing() {
        let (root, note) = project_with_note("append-new");
        fs::write(&note, "# 标题\n\n只有正文\n").unwrap();
        fs::create_dir_all(root.join("notes/assets")).unwrap();
        fs::write(root.join("notes/assets/c.png"), FAKE_PNG).unwrap();
        append_note_image_sync(
            &root.to_string_lossy(),
            &note.to_string_lossy(),
            "notes/assets/c.png",
        )
        .unwrap();
        let out = fs::read_to_string(&note).unwrap();
        assert_eq!(
            out,
            "# 标题\n\n只有正文\n\n## 我的想法\n\n![截图](assets/c.png)\n"
        );
    }

    #[test]
    fn append_image_rejects_outside_paths() {
        let (root, note) = project_with_note("append-out");
        // 根外笔记拒绝
        let outside = tmpdir("note-outside");
        let foreign = outside.join("x.md");
        fs::write(&foreign, "# x\n").unwrap();
        let err = append_note_image_sync(
            &root.to_string_lossy(),
            &foreign.to_string_lossy(),
            "notes/assets/c.png",
        )
        .unwrap_err();
        assert!(err.contains("notes"), "{err}");
        // 图片不在 notes/ 内（项目根下的兄弟文件）拒绝
        fs::write(root.join("c.png"), FAKE_PNG).unwrap();
        let err2 =
            append_note_image_sync(&root.to_string_lossy(), &note.to_string_lossy(), "c.png")
                .unwrap_err();
        assert!(err2.contains("notes"), "{err2}");
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn rel_md_path_computes_dotdot() {
        assert_eq!(
            rel_md_path(Path::new("/p/notes"), Path::new("/p/notes/assets/x.png")).as_deref(),
            Some("assets/x.png")
        );
        assert_eq!(
            rel_md_path(Path::new("/p/notes/sub"), Path::new("/p/notes/x.png")).as_deref(),
            Some("../x.png")
        );
        assert_eq!(
            rel_md_path(Path::new("/p/a"), Path::new("/p/b/x.png")).as_deref(),
            Some("../b/x.png")
        );
    }

    // ===== 批次 B3：生词本与译段 =====

    #[test]
    fn glossary_append_creates_table_and_dedups_by_lower() {
        let (root, _pdf) = project_with_pdf("gloss", "a.pdf");
        let root_s = root.to_string_lossy().into_owned();
        let list = append_glossary_sync(&root_s, "Solid Electrolyte", "固态电解质", "《a》第 1 页")
            .unwrap();
        assert_eq!(list.len(), 1);
        let text = fs::read_to_string(root.join("notes/glossary.md")).unwrap();
        assert!(
            text.starts_with("| 术语 | 释义 | 出处 |\n| --- | --- | --- |\n"),
            "{text}"
        );
        assert!(text.contains("| Solid Electrolyte | 固态电解质 | 《a》第 1 页 |"));
        // 大小写不同视为同一术语：原位更新释义/出处，不新增行
        let list2 = append_glossary_sync(
            &root_s,
            "solid electrolyte",
            "固态电解质（更新）",
            "《a》第 2 页",
        )
        .unwrap();
        assert_eq!(list2.len(), 1);
        assert_eq!(list2[0].term, "Solid Electrolyte"); // 原写法与位置保留
        assert_eq!(list2[0].meaning, "固态电解质（更新）");
        assert_eq!(list2[0].source, "《a》第 2 页");
        // 再追加一条不同术语
        let list3 = append_glossary_sync(
            &root_s,
            "界面阻抗",
            "interfacial resistance",
            "《a》第 3 页",
        )
        .unwrap();
        assert_eq!(list3.len(), 2);
        assert_eq!(list_glossary_sync(&root_s).unwrap(), list3);
    }

    #[test]
    fn glossary_parse_fault_tolerance_and_escape_roundtrip() {
        // 非表行/表头/分隔行/不足 3 列/空术语全部跳过；\| 还原
        let text = "# 生词本\n\n随手记一行\n\n| 术语 | 释义 | 出处 |\n| --- | --- | --- |\n\
                    | C\\|D 键 | 某个释义 | 《p》第 1 页 |\n| 只有两列 | x |\n| | 空术语 | x |\n\n尾部备注\n";
        let list = parse_glossary(text);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].term, "C|D 键");
        // 渲染 → 再解析往返稳定（转义互逆）
        let rendered = render_glossary(&list);
        assert!(
            rendered.contains("| C\\|D 键 | 某个释义 | 《p》第 1 页 |"),
            "{rendered}"
        );
        assert_eq!(parse_glossary(&rendered), list);
        // 单元格里的换行折成空格
        assert_eq!(escape_glossary_cell("a\nb|c"), "a b\\|c");
        // 缺尾竖线/紧凑表头也能解析
        let loose = parse_glossary("|术语|释义|出处|\n|---|---|---|\n|固态|solid|第 1 页");
        assert_eq!(loose.len(), 1);
        assert_eq!(loose[0].term, "固态");
    }

    #[test]
    fn glossary_remove_exact_match_and_keeps_preamble() {
        let (root, _pdf) = project_with_pdf("gloss-rm", "a.pdf");
        let root_s = root.to_string_lossy().into_owned();
        // 预置带标题的机管文件
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(
            root.join("notes/glossary.md"),
            "# 我的生词本\n\n| 术语 | 释义 | 出处 |\n| --- | --- | --- |\n| Alpha | 甲 | p1 |\n| Beta | 乙 | p2 |\n",
        )
        .unwrap();
        let list = remove_glossary_entry_sync(&root_s, "Alpha").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].term, "Beta");
        let text = fs::read_to_string(root.join("notes/glossary.md")).unwrap();
        assert!(
            text.starts_with("# 我的生词本\n\n"),
            "表外内容要保留：\n{text}"
        );
        assert!(!text.contains("Alpha"));
        // 大小写不同不算精确匹配，不删
        let list2 = remove_glossary_entry_sync(&root_s, "beta").unwrap();
        assert_eq!(list2.len(), 1);
        // 删除不存在的术语是 no-op
        let list3 = remove_glossary_entry_sync(&root_s, "Gamma").unwrap();
        assert_eq!(list3.len(), 1);
        // 文件不存在时删除返回空表（不报错）
        let (root2, _p2) = project_with_pdf("gloss-rm-empty", "a.pdf");
        assert!(remove_glossary_entry_sync(&root2.to_string_lossy(), "X")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn glossary_rejects_unregistered_root() {
        let (root, _pdf) = project_with_pdf("gloss-out", "a.pdf");
        fs::remove_file(root.join(".ccode/project.toml")).unwrap();
        let root_s = root.to_string_lossy().into_owned();
        assert!(list_glossary_sync(&root_s).is_err());
        assert!(append_glossary_sync(&root_s, "t", "m", "s").is_err());
        assert!(remove_glossary_entry_sync(&root_s, "t").is_err());
    }

    #[test]
    fn translation_appends_to_existing_section_before_next_header() {
        let (root, note) = project_with_note("trans");
        append_note_translation_sync(
            &root.to_string_lossy(),
            &note.to_string_lossy(),
            "The solid electrolyte interface",
            "固态电解质界面",
            2,
        )
        .unwrap();
        let out = fs::read_to_string(&note).unwrap();
        let expected = "## 译段\n\n> The solid electrolyte interface（第 2 页）\n\n固态电解质界面\n\n## 我的想法";
        assert!(out.contains(expected), "实际内容：\n{out}");
        // 再追加一条落在同小节末尾（仍在上一条之后、## 我的想法之前）
        append_note_translation_sync(
            &root.to_string_lossy(),
            &note.to_string_lossy(),
            "second",
            "第二段",
            5,
        )
        .unwrap();
        let out2 = fs::read_to_string(&note).unwrap();
        let expected2 = "固态电解质界面\n\n> second（第 5 页）\n\n第二段\n\n## 我的想法";
        assert!(out2.contains(expected2), "实际内容：\n{out2}");
    }

    #[test]
    fn translation_multiline_original_quoted_line_by_line() {
        let block = translation_block("line one\nline two", "译文", 3);
        assert_eq!(block, "> line one\n> line two（第 3 页）\n\n译文");
    }

    #[test]
    fn translation_creates_section_when_missing() {
        let (root, note) = project_with_note("trans-new");
        fs::write(&note, "# 标题\n\n只有正文\n").unwrap();
        append_note_translation_sync(
            &root.to_string_lossy(),
            &note.to_string_lossy(),
            "orig",
            "译文",
            1,
        )
        .unwrap();
        let out = fs::read_to_string(&note).unwrap();
        assert_eq!(
            out,
            "# 标题\n\n只有正文\n\n## 译段\n\n> orig（第 1 页）\n\n译文\n"
        );
    }

    #[test]
    fn translation_rejects_outside_note_and_empty_content() {
        let (root, note) = project_with_note("trans-out");
        // 根外笔记拒绝
        let outside = tmpdir("trans-note-outside");
        let foreign = outside.join("x.md");
        fs::write(&foreign, "# x\n").unwrap();
        let err = append_note_translation_sync(
            &root.to_string_lossy(),
            &foreign.to_string_lossy(),
            "o",
            "t",
            1,
        )
        .unwrap_err();
        assert!(err.contains("notes"), "{err}");
        // 空内容拒绝
        assert!(append_note_translation_sync(
            &root.to_string_lossy(),
            &note.to_string_lossy(),
            "  ",
            "t",
            1
        )
        .is_err());
        assert!(append_note_translation_sync(
            &root.to_string_lossy(),
            &note.to_string_lossy(),
            "o",
            "",
            1
        )
        .is_err());
        fs::remove_dir_all(&outside).ok();
    }

    // ===== 标注（## 标注 小节） =====

    #[test]
    fn annotation_quote_joins_broken_lines_collapses_and_escapes_brackets() {
        assert_eq!(
            annotation_quote("electro-\n  chemical  「window」\nopen"),
            "electro-chemical “window” open"
        );
        // 范围号与数字后的连字符不是断词
        assert_eq!(annotation_quote("pages 3-\n5"), "pages 3- 5");
        assert_eq!(annotation_quote(&"a".repeat(800)).chars().count(), ANNOT_QUOTE_MAX);
    }

    #[test]
    fn parse_annotation_line_handles_comment_and_brackets_in_comment() {
        assert_eq!(
            parse_annotation_line("- p.3 「the cell」"),
            Some((3, "the cell".into()))
        );
        assert_eq!(
            parse_annotation_line("- p.12 「Mg anode」 —— 这里「钝化」说法存疑"),
            Some((12, "Mg anode".into()))
        );
        assert_eq!(parse_annotation_line("- 普通列表"), None);
        assert_eq!(parse_annotation_line("- p.0 「x」"), None);
    }

    #[test]
    fn add_annotation_creates_section_before_translation_and_keeps_tight_list() {
        let text = "# T\n\n## 疑问与待跟进\n\n## 译段\n\n> a（第 1 页）\n\n甲\n\n## 我的想法\n";
        let once = add_annotation_to_text(text, 3, "first quote", "").unwrap();
        assert_eq!(
            once,
            "# T\n\n## 疑问与待跟进\n\n## 标注\n\n- p.3 「first quote」\n\n## 译段\n\n> a（第 1 页）\n\n甲\n\n## 我的想法\n"
        );
        let twice = add_annotation_to_text(&once, 5, "second", "要核对").unwrap();
        assert!(twice.contains("- p.3 「first quote」\n- p.5 「second」 —— 要核对\n\n## 译段"));
        // 同一处再标：无批注不动，有批注改写该行
        assert_eq!(add_annotation_to_text(&twice, 3, "first quote", ""), None);
        let updated = add_annotation_to_text(&twice, 3, "first quote", "补一句").unwrap();
        assert!(updated.contains("- p.3 「first quote」 —— 补一句\n- p.5"));
    }

    #[test]
    fn add_annotation_appends_section_at_end_without_translation() {
        assert_eq!(
            add_annotation_to_text("# T\n\n正文\n", 2, "q", "").unwrap(),
            "# T\n\n正文\n\n## 标注\n\n- p.2 「q」\n"
        );
    }

    #[test]
    fn remove_annotation_drops_line_then_empty_section() {
        let text = "# T\n\n## 标注\n\n- p.3 「a」\n- p.5 「b」 —— c\n\n## 译段\n";
        let one = remove_annotation_from_text(text, 3, "a").unwrap();
        assert_eq!(one, "# T\n\n## 标注\n\n- p.5 「b」 —— c\n\n## 译段\n");
        let none = remove_annotation_from_text(&one, 5, "b").unwrap();
        assert_eq!(none, "# T\n\n## 译段\n");
        assert_eq!(remove_annotation_from_text(&none, 5, "b"), None);
        // 小节在文件尾
        let tail = remove_annotation_from_text("# T\n\n## 标注\n\n- p.1 「x」\n", 1, "x").unwrap();
        assert_eq!(tail, "# T\n");
    }

    #[test]
    fn annotation_commands_write_note_and_reject_outside() {
        let (root, note) = project_with_note("annot");
        let r = root.to_string_lossy().into_owned();
        let n = note.to_string_lossy().into_owned();
        append_note_annotation_sync(&r, &n, 4, "solid-\nelectrolyte  interphase", "").unwrap();
        let text = fs::read_to_string(&note).unwrap();
        assert!(text.contains("## 标注\n\n- p.4 「solid-electrolyte interphase」\n\n## 译段"), "{text}");
        assert!(remove_note_annotation_sync(&r, &n, 4, "solid-electrolyte interphase").unwrap());
        assert!(!remove_note_annotation_sync(&r, &n, 4, "solid-electrolyte interphase").unwrap());
        assert!(append_note_annotation_sync(&r, &n, 4, "   ", "").is_err());
        let outside = tmpdir("annot-outside");
        let foreign = outside.join("x.md");
        fs::write(&foreign, "# x\n").unwrap();
        assert!(append_note_annotation_sync(&r, &foreign.to_string_lossy(), 1, "q", "").is_err());
        fs::remove_dir_all(&outside).ok();
    }

    // ===== 真实题名 =====

    #[test]
    fn paper_title_matches_truncated_file_name_from_reading_list() {
        let (root, pdf) = project_with_pdf(
            "title-trunc",
            "A Mg2+Li+ hybrid electrolyte with regulated interfacial chemistry for highly reversible and stable rechargeabl.pdf",
        );
        fs::write(
            root.join("papers/reading-list.md"),
            "A Mg2+/Li+ hybrid electrolyte with regulated interfacial chemistry for highly reversible and stable rechargeable magnesium batteries — Siyu Song et al., 2026 — 期刊 — DOI: 10.1016/x\n",
        )
        .unwrap();
        let pdf_c = crate::paths::canonicalize_plain(&pdf).unwrap();
        assert_eq!(
            paper_title_for(&root, &pdf_c).as_deref(),
            Some("A Mg2+/Li+ hybrid electrolyte with regulated interfacial chemistry for highly reversible and stable rechargeable magnesium batteries")
        );
        // 新建笔记的标题也用它
        let dto = ensure_paper_note_sync(&root.to_string_lossy(), &pdf.to_string_lossy()).unwrap();
        let text = fs::read_to_string(&dto.path).unwrap();
        assert!(text.starts_with("# A Mg2+/Li+ hybrid electrolyte"), "{text}");
    }

    #[test]
    fn paper_title_prefers_json_fulltext_and_ignores_short_prefix() {
        let (root, pdf) = project_with_pdf("title-json", "chu2017-clustering.pdf");
        fs::write(
            root.join("papers/included.json"),
            r#"[{"title":"Other","fulltext":"需自行获取"},{"title":"Clustering of Magnesium Surfaces","fulltext":"全文已在项目根（chu2017-clustering.pdf）"}]"#,
        )
        .unwrap();
        let pdf_c = crate::paths::canonicalize_plain(&pdf).unwrap();
        assert_eq!(
            paper_title_for(&root, &pdf_c).as_deref(),
            Some("Clustering of Magnesium Surfaces")
        );
        // 文件名太短不按前缀认题名
        let (root2, pdf2) = project_with_pdf("title-short", "Mg.pdf");
        fs::write(root2.join("papers/included.md"), "- Mg batteries review — A, 2020 — J — x\n").unwrap();
        let pdf2_c = crate::paths::canonicalize_plain(&pdf2).unwrap();
        assert_eq!(paper_title_for(&root2, &pdf2_c), None);
    }
}
