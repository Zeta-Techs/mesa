//! 二进制文件字节读取（§11.4 P2a PDF / RX4a docx）：供前端内嵌预览。
//! 防任意文件读取——只有白名单来源内的路径才放行：
//! 已注册项目的登记资源（project.toml resources）、已注册项目根内、
//! 工作区/仓库根内、终端标签 cwd 根内（前端 hint，风格同 read_file_preview 的 root 约束）、
//! Ccode 自管的剪贴板图片目录（<config>/ccode/tmp/paste-*，clipboard.rs 写入侧白名单），
//! 以及上述各根 artifacts.yaml 提货单中登记产物的精确路径（P4：登记产物可位于根之外），
//! 和用户本次运行里拖进窗口 / 在附件选择器里选的文件（attach_grants.rs，精确路径）。
//! 目标路径 canonicalize 后再判定，堵符号链接绕过。

use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// 单文件上限：超出直接报错（预览需要完整文件，截断无意义）
const PDF_CAP: u64 = 100 * 1024 * 1024;
/// docx 上限比 PDF 紧：mammoth 转 HTML 全在内存里做，超大文件提示不渲染
const DOCX_CAP: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfBytesDto {
    /// base64 编码的完整文件字节。
    /// 不走 raw bytes 响应：macOS/iOS 上 Tauri 会把 Raw 退化成 JSON 数字数组（逐字节展开），
    /// 大 PDF 下完全不可用；base64 字符串是全平台一致的传输方式。
    pub data: String,
    pub size: u64,
}

fn canon(p: &Path) -> Option<PathBuf> {
    p.canonicalize().ok()
}

/// 纯函数白名单判定（测试友好）：canonical 目标必须落在某白名单根内，
/// 或精确等于某登记资源路径（资源可以是项目根外的单个文件）。
fn path_allowed(target: &Path, roots: &[PathBuf], resources: &[PathBuf]) -> bool {
    roots.iter().any(|r| target.starts_with(r)) || resources.iter().any(|r| target == r)
}

/// 白名单 + 上限 + 完整读取的公共内核（PDF / docx / 阅读区图片通道共用；
/// 格式魔数校验与 base64 编码由调用方做）。cap_exceeded 为超限时的报错文案（按类型定制提示）。
pub(crate) fn read_whitelisted_sync(
    path: &str,
    cwd_hint: Option<&str>,
    cap: u64,
    cap_exceeded: impl Fn(f64) -> String,
) -> Result<(Vec<u8>, u64), String> {
    let target = canonical_file(path)?;
    let (roots, resources) = collect_whitelist(cwd_hint);
    read_whitelisted_in(&target, cap, cap_exceeded, &roots, &resources)
}

fn canonical_file(path: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(crate::sessions::expand_tilde(path))
        .canonicalize()
        .map_err(|e| format!("文件不存在或不可读: {e}"))?;
    if target.is_dir() {
        return Err("目录不支持预览".into());
    }
    Ok(target)
}

/// 白名单路径校验（不读内容）：给只需要路径的调用方（文件版本戳、媒体地址授权、转 PDF）。
/// 返回 canonical 路径
pub(crate) fn whitelisted_target(path: &str, cwd_hint: Option<&str>) -> Result<PathBuf, String> {
    let target = canonical_file(path)?;
    let (roots, resources) = collect_whitelist(cwd_hint);
    if !path_allowed(&target, &roots, &resources) {
        return Err("路径不在项目/登记资源/工作区/终端目录范围内，拒绝读取".into());
    }
    Ok(target)
}

/// 白名单收集：任一来源失败静默跳过（宁缺勿滥，绝不因 db 读不到而整体放行）
fn collect_whitelist(cwd_hint: Option<&str>) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut resources: Vec<PathBuf> = Vec::new();
    if let Some(hint) = cwd_hint {
        if let Some(c) = canon(&PathBuf::from(crate::sessions::expand_tilde(hint))) {
            roots.push(c);
        }
    }
    let (project_roots, project_resources) = crate::projects::project_roots_and_resources();
    roots.extend(project_roots.iter().filter_map(|p| canon(p)));
    resources.extend(project_resources.iter().filter_map(|p| canon(p)));
    // Ccode 自管的剪贴板图片目录（clipboard.rs paste-*：写入侧已有扩展名白名单 +
    // 50MB 上限 + 7 天清理）——终端/聊天里引用的粘贴图片要走同一读取通道
    if let Some(c) = dirs::config_dir()
        .map(|d| d.join("ccode").join("tmp"))
        .and_then(|p| canon(&p))
    {
        roots.push(c);
    }
    // 「从手机添加」暂存区（phone_drop.rs：只收不出的局域网服务写入，文件名清洗 + 上限 + 7 天清理）——
    // 附到对话的手机图片走同一读取通道出缩略图
    if let Some(c) = crate::phone_drop::stage_dir_path().and_then(|p| canon(&p)) {
        roots.push(c);
    }
    // 用户亲手交过来的文件（拖进窗口 / Rust 侧选择器选的，attach_grants.rs）：按精确路径放行
    resources.extend(crate::attach_grants::granted());
    roots.extend(
        crate::workspaces::worktree_rows()
            .into_iter()
            .flat_map(|w| [w.worktree_path, w.repo_path])
            .filter_map(|p| canon(Path::new(&p))),
    );
    // 提货单产物（P4）：白名单根内 artifacts.yaml 的登记产物可位于根之外（如产物目录），
    // 按条目精确路径放行（与登记资源同语义，兄弟文件不放行）
    for root in roots.clone() {
        resources.extend(
            crate::workspaces::artifact_paths_at(&root)
                .into_iter()
                .filter_map(|p| canon(&p)),
        );
    }
    (roots, resources)
}

/// 文件版本戳：大小 + 修改时间（毫秒）。预览缓存（PDF 字节、md 内嵌图）据此判断磁盘上是不是换了一版
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileStampDto {
    pub size: u64,
    pub modified_ms: u64,
}

pub(crate) fn stamp_of(path: &Path) -> Result<FileStampDto, String> {
    let md = fs::metadata(path).map_err(|e| format!("读取文件失败: {e}"))?;
    let modified_ms = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStampDto { size: md.len(), modified_ms })
}

#[tauri::command]
pub async fn file_stamp(path: String, cwd_hint: Option<String>) -> Result<FileStampDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = whitelisted_target(&path, cwd_hint.as_deref())?;
        stamp_of(&target)
    })
    .await
    .map_err(|e| format!("读取文件失败: {e}"))?
}

/// 核心读取：白名单由调用方注入。拆出来是为了让测试注入临时根——
/// 收集真实白名单会经 app.db 读每个注册项目的档案卡，档案卡在 iCloud 等
/// 慢文件系统上 open() 可能内核级阻塞（2026-09-13 实证），单测不得依赖。
fn read_whitelisted_in(
    target: &Path,
    cap: u64,
    cap_exceeded: impl Fn(f64) -> String,
    roots: &[PathBuf],
    resources: &[PathBuf],
) -> Result<(Vec<u8>, u64), String> {
    if !path_allowed(target, roots, resources) {
        return Err("路径不在项目/登记资源/工作区/终端目录范围内，拒绝读取".into());
    }
    let size = fs::metadata(target)
        .map_err(|e| format!("读取文件失败: {e}"))?
        .len();
    if size > cap {
        return Err(cap_exceeded(size as f64 / 1024.0 / 1024.0));
    }
    let bytes = fs::read(target).map_err(|e| format!("读取文件失败: {e}"))?;
    Ok((bytes, size))
}

/// 魔数校验通过后统一编码（先校验后编码，避免超限/坏文件也付一遍编码开销）
fn encode_dto(bytes: &[u8], size: u64) -> PdfBytesDto {
    PdfBytesDto {
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        size,
    }
}

fn read_pdf_sync(path: &str, cwd_hint: Option<&str>) -> Result<PdfBytesDto, String> {
    let (bytes, size) = read_whitelisted_sync(path, cwd_hint, PDF_CAP, |mb| {
        format!("PDF 超过 100 MB（{mb:.1} MB），暂不支持内嵌预览")
    })?;
    // PDF 头允许出现在前 1024 字节内（部分生成器会写前导字节），宽松校验给个明白的错误
    let head = &bytes[..bytes.len().min(1024)];
    if !head.windows(5).any(|w| w == b"%PDF-") {
        return Err("文件内容不是有效的 PDF".into());
    }
    Ok(encode_dto(&bytes, size))
}

fn read_docx_sync(path: &str, cwd_hint: Option<&str>) -> Result<PdfBytesDto, String> {
    let (bytes, size) = read_whitelisted_sync(path, cwd_hint, DOCX_CAP, |mb| {
        format!("docx 超过 50 MB（{mb:.1} MB），暂不支持内嵌预览")
    })?;
    // docx 是 ZIP 容器（PK 魔数开头；PK\x05\x06 为空压缩包）：宽松校验给个明白的错误。
    // 注意不能套 PDF 的前 1024 字节窗口校验——ZIP 魔数必须在文件开头
    if !bytes.starts_with(b"PK\x03\x04") && !bytes.starts_with(b"PK\x05\x06") {
        return Err("文件内容不是有效的 docx（ZIP 容器）".into());
    }
    Ok(encode_dto(&bytes, size))
}

#[tauri::command]
pub async fn read_pdf_bytes(path: String, cwd_hint: Option<String>) -> Result<PdfBytesDto, String> {
    tauri::async_runtime::spawn_blocking(move || read_pdf_sync(&path, cwd_hint.as_deref()))
        .await
        .map_err(|e| format!("读取 PDF 失败: {e}"))?
}

#[tauri::command]
pub async fn read_docx_bytes(
    path: String,
    cwd_hint: Option<String>,
) -> Result<PdfBytesDto, String> {
    tauri::async_runtime::spawn_blocking(move || read_docx_sync(&path, cwd_hint.as_deref()))
        .await
        .map_err(|e| format!("读取 docx 失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-pdf-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn whitelist_pure_rules() {
        let root = PathBuf::from("/proj/a");
        let roots = vec![root.clone()];
        let res = vec![PathBuf::from("/elsewhere/paper.pdf")];
        // 根内放行（含根本身前缀）
        assert!(path_allowed(Path::new("/proj/a/docs/x.pdf"), &roots, &res));
        assert!(path_allowed(Path::new("/proj/a"), &roots, &res));
        // 资源精确路径放行（项目根外单文件）
        assert!(path_allowed(
            Path::new("/elsewhere/paper.pdf"),
            &roots,
            &res
        ));
        // 资源同目录的兄弟文件不放行（资源是精确匹配，不是前缀）
        assert!(!path_allowed(
            Path::new("/elsewhere/other.pdf"),
            &roots,
            &res
        ));
        // 前缀混淆（/proj/ab 不是 /proj/a 内）
        assert!(!path_allowed(Path::new("/proj/ab/x.pdf"), &roots, &res));
        // 完全根外拒绝
        assert!(!path_allowed(Path::new("/etc/passwd"), &roots, &res));
    }

    #[test]
    fn read_within_cwd_hint_ok() {
        let dir = tmpdir("ok");
        let f = dir.join("paper.pdf");
        fs::write(&f, b"%PDF-1.7 fake body").unwrap();
        let dto = read_pdf_sync(f.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&dto.data)
            .unwrap();
        assert_eq!(decoded, b"%PDF-1.7 fake body");
        assert_eq!(dto.size, 18);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_outside_hint_rejected() {
        let root = tmpdir("root");
        let outside = tmpdir("outside");
        let f = outside.join("paper.pdf");
        fs::write(&f, b"%PDF-1.7 fake").unwrap();
        let err = read_pdf_sync(f.to_str().unwrap(), Some(root.to_str().unwrap())).unwrap_err();
        assert!(err.contains("拒绝读取"), "{err}");
        // 不给 hint 且不在任何注册来源内：同样拒绝
        let err2 = read_pdf_sync(f.to_str().unwrap(), None).unwrap_err();
        assert!(err2.contains("拒绝读取"), "{err2}");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn read_rejects_non_pdf_and_dir() {
        let dir = tmpdir("notpdf");
        let f = dir.join("notes.txt");
        fs::write(&f, "plain text").unwrap();
        let err = read_pdf_sync(f.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap_err();
        assert!(err.contains("不是有效的 PDF"), "{err}");
        let err2 = read_pdf_sync(dir.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap_err();
        assert!(err2.contains("目录"), "{err2}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_via_manifest_entry_ok() {
        // P4 白名单扩展：hint 根内 artifacts.yaml 登记的产物（在根之外）按精确路径放行
        let root = tmpdir("mroot");
        let outside = tmpdir("moutside");
        let f = outside.join("render.pdf");
        fs::write(&f, b"%PDF-1.7 fake body").unwrap();
        // 清单存的是 canonical 绝对路径（register_artifact 语义）；
        // 手写 YAML 需与 yaml_escape 同口径转义反斜杠（Windows 路径含 \，否则解析后前缀损坏）
        let canon_f = f.canonicalize().unwrap();
        fs::write(
            root.join("artifacts.yaml"),
            format!(
                "artifacts:\n  - name: \"render\"\n    path: \"{}\"\n    hash: \"abc\"\n    size: 18\n    produced_by: \"paper-draft\"\n    created_at: \"2026-08-01\"\n",
                canon_f.display().to_string().replace('\\', "\\\\")
            ),
        )
        .unwrap();
        let dto = read_pdf_sync(canon_f.to_str().unwrap(), Some(root.to_str().unwrap())).unwrap();
        assert_eq!(dto.size, 18);
        // 同目录未登记的兄弟文件仍拒绝（条目是精确匹配，不是前缀）
        let other = outside.join("other.pdf");
        fs::write(&other, b"%PDF-1.7 fake").unwrap();
        let err = read_pdf_sync(other.to_str().unwrap(), Some(root.to_str().unwrap())).unwrap_err();
        assert!(err.contains("拒绝读取"), "{err}");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn read_rejects_oversize() {
        let dir = tmpdir("cap");
        let f = dir.join("huge.pdf");
        // 稀疏文件置长度，避免真的写 100MB
        let file = fs::File::create(&f).unwrap();
        file.set_len(PDF_CAP + 1).unwrap();
        drop(file);
        let err = read_pdf_sync(f.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap_err();
        assert!(err.contains("100 MB"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[cfg(unix)] // 符号链接语义仅 unix；Windows 无权限创建
    fn symlink_escaping_hint_rejected() {
        let root = tmpdir("sroot");
        let outside = tmpdir("soutside");
        let real = outside.join("real.pdf");
        fs::write(&real, b"%PDF-1.7 fake").unwrap();
        std::os::unix::fs::symlink(&real, root.join("link.pdf")).unwrap();
        // 链接在 hint 根内但 canonicalize 后指向根外：拒绝
        let err = read_pdf_sync(
            root.join("link.pdf").to_str().unwrap(),
            Some(root.to_str().unwrap()),
        )
        .unwrap_err();
        assert!(err.contains("拒绝读取"), "{err}");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    // ===== RX4a：docx 读取（同白名单，ZIP 魔数校验，50MB 上限） =====

    #[test]
    fn docx_read_within_hint_ok() {
        let dir = tmpdir("docx-ok");
        let f = dir.join("draft.docx");
        fs::write(&f, b"PK\x03\x04 fake zip body").unwrap();
        let dto = read_docx_sync(f.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&dto.data)
            .unwrap();
        assert_eq!(decoded, b"PK\x03\x04 fake zip body");
        assert_eq!(dto.size, 18);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn docx_rejects_non_zip_content() {
        let dir = tmpdir("docx-notzip");
        // PDF 内容走 docx 通道：PDF 的宽松头校验不能套用到 docx
        let f = dir.join("paper.docx");
        fs::write(&f, b"%PDF-1.7 fake").unwrap();
        let err = read_docx_sync(f.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap_err();
        assert!(err.contains("不是有效的 docx"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn docx_rejects_outside_hint() {
        let root = tmpdir("docx-root");
        let outside = tmpdir("docx-outside");
        let f = outside.join("draft.docx");
        fs::write(&f, b"PK\x03\x04 fake").unwrap();
        let err = read_docx_sync(f.to_str().unwrap(), Some(root.to_str().unwrap())).unwrap_err();
        assert!(err.contains("拒绝读取"), "{err}");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn docx_rejects_oversize() {
        let dir = tmpdir("docx-cap");
        let f = dir.join("huge.docx");
        // 稀疏文件置长度，避免真的写 50MB
        let file = fs::File::create(&f).unwrap();
        file.set_len(DOCX_CAP + 1).unwrap();
        drop(file);
        let err = read_docx_sync(f.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap_err();
        assert!(err.contains("50 MB"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }
}
