//! 科研做图：图纸 SVG → PNG（预览、冷读）与 PDF（投稿副本），即 `mesa_helper svg-render`。
//! Agent 经 `MESA_FIGURE_TOOL` 找到随包 helper 调用（docs/design-research-figures.md §4.3.1）。
//! resvg 光栅化；svg2pdf 出 PDF，文字嵌子集字体、保留成可选中的真文字（不转曲）。
//! 不联网、不读密钥；只读输入 SVG 与它引用的本地图片，只写 `--out` 给的文件。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use resvg::tiny_skia;
use resvg::usvg::{self, fontdb};

/// 注入 Agent 进程的变量名：值是 helper 路径，做图技能按它调 `svg-render`
pub const TOOL_ENV: &str = "MESA_FIGURE_TOOL";

/// 认得 `svg-render` 的随包 helper（试跑 `svg-render --probe`）。不能沿用出图的 `image --probe`：
/// 开发态 target/debug 里常躺着认 image、不认 svg-render 的旧 helper，调它会掉进浏览器桥模式、退出 0 却什么也不写
pub fn helper_exe() -> Option<PathBuf> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHE.get_or_init(|| crate::image_gen::find_bundled_helper("svg-render")).clone()
}

const USAGE: &str = "用法：mesa_helper svg-render --in 图纸.svg --out 图.png [--out 图.pdf]\n\
     \x20                [--dpi 300 | --width-px 宽度] [--font-dir 目录]… [--background white|transparent]\n\
     \x20     --out 可给多次，按扩展名出 PNG / PDF；--dpi 只管 PNG（默认 300），--width-px 直接定 PNG 宽度像素\n\
     \x20     --font-dir 额外字体目录（可多次，先于系统字体加载）；--background 只管 PNG（默认 white）\n\
     \x20     输出：每个文件一行 saved: 绝对路径，PNG 另一行 size: 宽x高；\n\
     \x20           字体族一个都找不到时 note: font-fallback 族名；有字哪套字体都没有时 note: missing-glyph 字符 U+码位\n\
     \x20     退出码：0 成功、2 参数错、3 读取 / 解析 / 渲染 / 写入失败";

/// 单边像素上限与总像素上限：防手滑 `--dpi 30000` 把内存吃光
const MAX_SIDE_PX: u32 = 30_000;
const MAX_TOTAL_PX: u64 = 250_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutKind {
    Png,
    Pdf,
}

#[derive(Debug)]
struct Args {
    input: PathBuf,
    outs: Vec<(PathBuf, OutKind)>,
    dpi: f32,
    width_px: Option<u32>,
    font_dirs: Vec<PathBuf>,
    transparent: bool,
}

fn out_kind(path: &Path) -> Option<OutKind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some(OutKind::Png),
        "pdf" => Some(OutKind::Pdf),
        _ => None,
    }
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut input = None;
    let mut outs: Vec<(PathBuf, OutKind)> = Vec::new();
    let mut dpi = None;
    let mut width_px = None;
    let mut font_dirs = Vec::new();
    let mut transparent = false;
    let mut i = 0;
    while i < args.len() {
        // 兼容 `--dpi=300` 写法
        let (flag, inline) = match args[i].split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (args[i].clone(), None),
        };
        let mut value = || -> Result<String, String> {
            if let Some(v) = inline.clone() {
                return Ok(v);
            }
            i += 1;
            args.get(i).cloned().ok_or_else(|| format!("{flag} 后面缺少值"))
        };
        match flag.as_str() {
            "--in" => input = Some(PathBuf::from(value()?)),
            "--out" => {
                let p = PathBuf::from(value()?);
                let kind = out_kind(&p).ok_or_else(|| format!("--out {} 的扩展名只能是 .png 或 .pdf", p.display()))?;
                if outs.iter().any(|(q, _)| q == &p) {
                    return Err(format!("--out {} 给了两次", p.display()));
                }
                outs.push((p, kind));
            }
            "--dpi" => {
                let v = value()?;
                let n: f32 = v.parse().map_err(|_| format!("--dpi 要一个数字，收到 {v}"))?;
                if !(1.0..=2400.0).contains(&n) {
                    return Err(format!("--dpi 要在 1 到 2400 之间，收到 {v}"));
                }
                dpi = Some(n);
            }
            "--width-px" => {
                let v = value()?;
                let n: u32 = v.parse().map_err(|_| format!("--width-px 要一个正整数，收到 {v}"))?;
                if n == 0 || n > MAX_SIDE_PX {
                    return Err(format!("--width-px 要在 1 到 {MAX_SIDE_PX} 之间，收到 {v}"));
                }
                width_px = Some(n);
            }
            "--font-dir" => {
                let d = PathBuf::from(value()?);
                if !d.is_dir() {
                    return Err(format!("--font-dir {} 不是目录", d.display()));
                }
                font_dirs.push(d);
            }
            "--background" => {
                let v = value()?;
                transparent = match v.as_str() {
                    "white" => false,
                    "transparent" => true,
                    _ => return Err(format!("--background 只能是 white 或 transparent，收到 {v}")),
                };
            }
            other => return Err(format!("不认识的参数：{other}")),
        }
        i += 1;
    }
    let input = input.ok_or("缺少 --in 图纸.svg")?;
    if outs.is_empty() {
        return Err("缺少 --out（.png 或 .pdf，可给多次）".into());
    }
    if dpi.is_some() && width_px.is_some() {
        return Err("--dpi 与 --width-px 只给一个".into());
    }
    Ok(Args {
        input,
        outs,
        dpi: dpi.unwrap_or(300.0),
        width_px,
        font_dirs,
        transparent,
    })
}

// ===== 字体 =====

fn has_family(db: &fontdb::Database, name: &str) -> bool {
    db.faces().any(|f| f.families.iter().any(|(n, _)| n == name))
}

/// 通用族（serif / sans-serif / monospace）按平台挑一个装了的；fontdb 默认是 Windows 名，
/// Linux 上常常没有，那样 `font-family="sans-serif"` 也会落空
fn fix_generic_families(db: &mut fontdb::Database) {
    const SERIF: &[&str] = &["Times New Roman", "Times", "Liberation Serif", "DejaVu Serif", "Noto Serif"];
    const SANS: &[&str] = &["Arial", "Helvetica", "Liberation Sans", "DejaVu Sans", "Noto Sans"];
    const MONO: &[&str] = &["Courier New", "Menlo", "Consolas", "Liberation Mono", "DejaVu Sans Mono"];
    if let Some(n) = SERIF.iter().find(|n| has_family(db, n)) {
        db.set_serif_family(*n);
    }
    if let Some(n) = SANS.iter().find(|n| has_family(db, n)) {
        db.set_sans_serif_family(*n);
    }
    if let Some(n) = MONO.iter().find(|n| has_family(db, n)) {
        db.set_monospace_family(*n);
    }
}

fn build_fontdb(font_dirs: &[PathBuf]) -> fontdb::Database {
    let mut db = fontdb::Database::new();
    // 先装用户给的目录：同名族时 query 先命中它们，缺字回落也先试它们
    for d in font_dirs {
        db.load_fonts_dir(d);
    }
    db.load_system_fonts();
    // macOS 的 LastResort 什么码位都「有」，画出来是带问号的方框：回落挑中它时 usvg 会把整行换成它的字形，
    // 缺字也查不出来。拿掉后缺的字照常记成缺字（missing-glyph）
    let last_resort: Vec<fontdb::ID> = db
        .faces()
        .filter(|f| f.families.iter().any(|(n, _)| n.to_ascii_lowercase().contains("lastresort")))
        .map(|f| f.id)
        .collect();
    for id in last_resort {
        db.remove_face(id);
    }
    fix_generic_families(&mut db);
    db
}

/// 中文回落优先这些（无衬线在前）；不指定时 usvg 按字体库顺序拿第一个有这个字的，常落到日文或繁体字形
const CJK_FALLBACK: &[&str] = &[
    "PingFang SC",
    "Hiragino Sans GB",
    "Microsoft YaHei",
    "Noto Sans CJK SC",
    "Noto Sans SC",
    "Source Han Sans SC",
    "Source Han Sans CN",
    "WenQuanYi Micro Hei",
    "Heiti SC",
    "SimHei",
    "Songti SC",
    "SimSun",
];

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x2E80..=0x2FDF | 0x3000..=0x303F | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
        | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFFEF | 0x20000..=0x3134F)
}

fn face_has_char(db: &fontdb::Database, id: fontdb::ID, c: char) -> bool {
    db.with_face_data(id, |data, index| {
        ttf_parser::Face::parse(data, index).ok().and_then(|f| f.glyph_index(c)).is_some()
    })
    .unwrap_or(false)
}

fn font_resolver() -> usvg::FontResolver<'static> {
    let default_fallback = usvg::FontResolver::default_fallback_selector();
    usvg::FontResolver {
        select_font: usvg::FontResolver::default_font_selector(),
        select_fallback: Box::new(move |c, used, db| {
            if is_cjk(c) {
                // 粗细、斜体跟着原字体走：粗体标题里的中文也要粗
                let base = used.first().and_then(|id| db.face(*id));
                for name in CJK_FALLBACK {
                    let query = fontdb::Query {
                        families: &[fontdb::Family::Name(name)],
                        weight: base.map(|f| f.weight).unwrap_or_default(),
                        style: base.map(|f| f.style).unwrap_or_default(),
                        ..Default::default()
                    };
                    if let Some(id) = db.query(&query) {
                        if !used.contains(&id) && face_has_char(db, id, c) {
                            return Some(id);
                        }
                    }
                }
            }
            default_fallback(c, used, db)
        }),
    }
}

// ===== 诊断：字体族落空、缺字 =====

fn family_resolves(db: &fontdb::Database, f: &usvg::FontFamily) -> bool {
    let family = match f {
        usvg::FontFamily::Serif => fontdb::Family::Serif,
        usvg::FontFamily::SansSerif => fontdb::Family::SansSerif,
        usvg::FontFamily::Cursive => fontdb::Family::Cursive,
        usvg::FontFamily::Fantasy => fontdb::Family::Fantasy,
        usvg::FontFamily::Monospace => fontdb::Family::Monospace,
        usvg::FontFamily::Named(s) => fontdb::Family::Name(s),
    };
    has_family(db, db.family_name(&family))
}

fn family_label(f: &usvg::FontFamily) -> String {
    match f {
        usvg::FontFamily::Named(s) => s.clone(),
        other => other.to_string(),
    }
}

/// 零宽、方向控制、变体选择符这类字符本来就可能没有字形，不报缺字
fn is_invisible(c: char) -> bool {
    c.is_whitespace()
        || c.is_control()
        || matches!(c as u32, 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x206F | 0xFE00..=0xFE0F | 0xFEFF)
}

fn push_unique(notes: &mut Vec<String>, note: String) {
    if !notes.contains(&note) {
        notes.push(note);
    }
}

fn check_text(text: &usvg::Text, db: &fontdb::Database, notes: &mut Vec<String>) {
    for chunk in text.chunks() {
        for span in chunk.spans() {
            let families = span.font().families();
            if !families.iter().any(|f| family_resolves(db, f)) {
                for f in families {
                    push_unique(notes, format!("font-fallback {}", family_label(f)));
                }
            }
        }
    }
    // 排版结果里字形号 0（.notdef）= 主字体和回落都没有这个字，画出来是方框或空白
    for span in text.layouted() {
        for g in &span.positioned_glyphs {
            if g.id.0 == 0 {
                for c in g.text.chars().filter(|c| !is_invisible(*c)) {
                    // 带上码位：缺的常是私用区、组合符这类看不见的字
                    push_unique(notes, format!("missing-glyph {c} U+{:04X}", c as u32));
                }
            }
        }
    }
}

fn walk(group: &usvg::Group, db: &fontdb::Database, notes: &mut Vec<String>) {
    for node in group.children() {
        match node {
            usvg::Node::Group(g) => walk(g, db, notes),
            usvg::Node::Text(t) => check_text(t, db, notes),
            _ => {}
        }
        // 剪切、蒙版、图案、滤镜里的子树
        node.subroots(|g| walk(g, db, notes));
    }
}

fn collect_notes(tree: &usvg::Tree) -> Vec<String> {
    let mut notes = Vec::new();
    walk(tree.root(), tree.fontdb(), &mut notes);
    notes
}

// ===== 渲染 =====

#[derive(Debug)]
struct Saved {
    path: PathBuf,
    size: Option<(u32, u32)>,
}

#[derive(Debug)]
struct Report {
    saved: Vec<Saved>,
    notes: Vec<String>,
}

fn load_tree(a: &Args) -> Result<usvg::Tree, String> {
    let data = std::fs::read(&a.input).map_err(|e| format!("读取 {} 失败: {e}", a.input.display()))?;
    let input_abs = std::fs::canonicalize(&a.input).unwrap_or_else(|_| a.input.clone());
    let db = build_fontdb(&a.font_dirs);
    let opt = usvg::Options {
        // 相对路径的 <image href="icon.png"> 按图纸所在目录找
        resources_dir: input_abs.parent().map(Path::to_path_buf),
        // 没写 font-family 的文字用本机的衬线族（usvg 默认写死 Times New Roman，Linux 上没有会被误报成落空）
        font_family: db.family_name(&fontdb::Family::Serif).to_string(),
        font_resolver: font_resolver(),
        fontdb: Arc::new(db),
        ..Default::default()
    };
    usvg::Tree::from_data(&data, &opt).map_err(|e| format!("解析 {} 失败: {e}", a.input.display()))
}

/// 像素尺寸与等效 dpi。usvg 的 tree 尺寸是 96 px/in 的 CSS 像素（mm / in / pt 已按物理尺寸换算过）
fn png_geometry(tree: &usvg::Tree, a: &Args) -> Result<(u32, u32, f32), String> {
    let size = tree.size();
    let scale = match a.width_px {
        Some(w) => w as f32 / size.width(),
        None => a.dpi / 96.0,
    };
    let w = (size.width() * scale).round().max(1.0);
    let h = (size.height() * scale).round().max(1.0);
    if w > MAX_SIDE_PX as f32 || h > MAX_SIDE_PX as f32 || (w as u64) * (h as u64) > MAX_TOTAL_PX {
        return Err(format!("输出 {w}x{h} 像素太大（单边上限 {MAX_SIDE_PX}），调低 --dpi 或改用 --width-px"));
    }
    Ok((w as u32, h as u32, scale * 96.0))
}

fn encode_png(pixmap: &tiny_skia::Pixmap, opaque: bool, dpi: f32) -> Result<Vec<u8>, String> {
    let mut data = Vec::with_capacity(pixmap.data().len());
    for px in pixmap.pixels() {
        let c = px.demultiply();
        data.extend_from_slice(&[c.red(), c.green(), c.blue()]);
        if !opaque {
            data.push(c.alpha());
        }
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, pixmap.width(), pixmap.height());
        enc.set_color(if opaque { png::ColorType::Rgb } else { png::ColorType::Rgba });
        enc.set_depth(png::BitDepth::Eight);
        // 写进 pHYs：Word / 投稿系统按它认出物理尺寸与 dpi
        let ppm = (dpi / 0.0254).round() as u32;
        enc.set_pixel_dims(Some(png::PixelDimensions {
            xppu: ppm,
            yppu: ppm,
            unit: png::Unit::Meter,
        }));
        let mut w = enc.write_header().map_err(|e| format!("编码 PNG 失败: {e}"))?;
        w.write_image_data(&data).map_err(|e| format!("编码 PNG 失败: {e}"))?;
    }
    Ok(out)
}

fn render_png(tree: &usvg::Tree, a: &Args) -> Result<(Vec<u8>, (u32, u32)), String> {
    let (w, h, dpi) = png_geometry(tree, a)?;
    let mut pixmap = tiny_skia::Pixmap::new(w, h).ok_or_else(|| format!("开不出 {w}x{h} 的画布"))?;
    if !a.transparent {
        pixmap.fill(tiny_skia::Color::WHITE);
    }
    let size = tree.size();
    let ts = tiny_skia::Transform::from_scale(w as f32 / size.width(), h as f32 / size.height());
    resvg::render(tree, ts, &mut pixmap.as_mut());
    Ok((encode_png(&pixmap, !a.transparent, dpi)?, (w, h)))
}

fn render_pdf(tree: &usvg::Tree) -> Result<Vec<u8>, String> {
    // 页面 dpi 取 96 与 usvg 的 CSS 像素一致：mm 尺寸的图纸出来的 PDF 页面就是那个物理尺寸
    svg2pdf::to_pdf(
        tree,
        svg2pdf::ConversionOptions::default(),
        svg2pdf::PageOptions { dpi: 96.0 },
    )
    .map_err(|e| format!("生成 PDF 失败: {e:?}"))
}

fn write_out(path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录 {} 失败: {e}", dir.display()))?;
    }
    std::fs::write(path, bytes).map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
    let abs = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    Ok(crate::paths::strip_verbatim(abs))
}

fn render(a: &Args) -> Result<Report, String> {
    let tree = load_tree(a)?;
    let notes = collect_notes(&tree);
    let mut saved = Vec::new();
    for (path, kind) in &a.outs {
        let (bytes, size) = match kind {
            OutKind::Png => {
                let (b, s) = render_png(&tree, a)?;
                (b, Some(s))
            }
            OutKind::Pdf => (render_pdf(&tree)?, None),
        };
        saved.push(Saved {
            path: write_out(path, &bytes)?,
            size,
        });
    }
    Ok(Report { saved, notes })
}

/// `mesa_helper svg-render …` 的实现；返回进程退出码（0 成功、2 参数错、3 读取 / 解析 / 渲染 / 写入失败）
pub fn helper_svg_render_cli(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("--probe") => {
            println!("ok");
            return 0;
        }
        Some("--help" | "-h") => {
            println!("{USAGE}");
            return 0;
        }
        _ => {}
    }
    let a = match parse_args(args) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}\n{USAGE}");
            return 2;
        }
    };
    match render(&a) {
        Ok(r) => {
            for s in &r.saved {
                println!("saved: {}", s.path.display());
                if let Some((w, h)) = s.size {
                    println!("size: {w}x{h}");
                }
            }
            for n in &r.notes {
                println!("note: {n}");
            }
            0
        }
        Err(e) => {
            eprintln!("{e}");
            3
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mesa-svg-render-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 单色 1x1 PNG
    fn png_1x1(rgba: [u8; 4]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, 1, 1);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.write_header().unwrap().write_image_data(&rgba).unwrap();
        }
        out
    }

    fn decode(path: &Path) -> (u32, u32, Option<png::PixelDimensions>, Vec<u8>, png::ColorType) {
        let dec = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).unwrap()));
        let mut reader = dec.read_info().unwrap();
        let dims = reader.info().pixel_dims;
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        buf.truncate(info.buffer_size());
        (info.width, info.height, dims, buf, info.color_type)
    }

    fn pixel(buf: &[u8], width: u32, ct: png::ColorType, x: u32, y: u32) -> [u8; 3] {
        let n = if ct == png::ColorType::Rgba { 4 } else { 3 };
        let i = ((y * width + x) as usize) * n;
        [buf[i], buf[i + 1], buf[i + 2]]
    }

    /// 50.8mm × 25.4mm（2in × 1in）；左半边一张内嵌红色 1x1 PNG 撑满 20mm 见方，右边一段英文
    fn sample_svg(dir: &Path, family: &str) -> PathBuf {
        let red = base64::engine::general_purpose::STANDARD.encode(png_1x1([255, 0, 0, 255]));
        std::fs::write(dir.join("icon.png"), png_1x1([0, 0, 255, 255])).unwrap();
        let svg = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="50.8mm" height="25.4mm" viewBox="0 0 50.8 25.4">
  <rect x="0" y="0" width="50.8" height="25.4" fill="#eeeeee"/>
  <image x="2" y="2" width="20" height="20" preserveAspectRatio="none" image-rendering="optimizeSpeed" href="data:image/png;base64,{red}"/>
  <image x="40" y="15" width="8" height="8" preserveAspectRatio="none" image-rendering="optimizeSpeed" xlink:href="icon.png"/>
  <text x="25" y="8" font-family="{family}" font-size="4">Adsorbent</text>
</svg>"##
        );
        let p = dir.join("fig.svg");
        std::fs::write(&p, svg).unwrap();
        p
    }

    #[test]
    fn parse_args_rules() {
        let a = parse_args(&s(&["--in", "a.svg", "--out", "b.png", "--out=b.PDF", "--background", "transparent"])).unwrap();
        assert_eq!(a.input, PathBuf::from("a.svg"));
        assert_eq!(a.outs.len(), 2);
        assert_eq!(a.outs[0].1, OutKind::Png);
        assert_eq!(a.outs[1].1, OutKind::Pdf);
        assert_eq!(a.dpi, 300.0);
        assert!(a.transparent);
        assert_eq!(parse_args(&s(&["--in", "a.svg", "--out", "b.png", "--width-px", "400"])).unwrap().width_px, Some(400));

        for bad in [
            &["--out", "b.png"][..],
            &["--in", "a.svg"],
            &["--in", "a.svg", "--out", "b.jpg"],
            &["--in", "a.svg", "--out", "b.png", "--out", "b.png"],
            &["--in", "a.svg", "--out", "b.png", "--dpi", "0"],
            &["--in", "a.svg", "--out", "b.png", "--dpi", "abc"],
            &["--in", "a.svg", "--out", "b.png", "--dpi", "300", "--width-px", "100"],
            &["--in", "a.svg", "--out", "b.png", "--background", "black"],
            &["--in", "a.svg", "--out", "b.png", "--font-dir", "/definitely/not/here/mesa"],
            &["--in", "a.svg", "--out", "b.png", "--bogus"],
            &["--in"],
        ] {
            assert!(parse_args(&s(bad)).is_err(), "应拒绝 {bad:?}");
        }
        assert_eq!(helper_svg_render_cli(&s(&["--probe"])), 0);
        assert_eq!(helper_svg_render_cli(&s(&["--in", "a.svg"])), 2);
    }

    #[test]
    fn renders_png_at_dpi_with_embedded_and_linked_images() {
        let dir = tmpdir("png");
        let svg = sample_svg(&dir, "sans-serif");
        let png_out = dir.join("out/fig.png");
        let a = parse_args(&s(&["--in", svg.to_str().unwrap(), "--out", png_out.to_str().unwrap()])).unwrap();
        let r = render(&a).unwrap();
        assert_eq!(r.saved[0].size, Some((600, 300)));
        assert!(r.saved[0].path.is_absolute());
        let (w, h, dims, buf, ct) = decode(&png_out);
        assert_eq!((w, h), (600, 300));
        assert_eq!(ct, png::ColorType::Rgb);
        let ppm = dims.unwrap().xppu as f32;
        assert!((ppm * 0.0254 - 300.0).abs() < 1.0);
        // 内嵌红图中心（12mm, 12mm）与外链蓝图中心（44mm, 19mm）
        let mm = |v: f32| (v / 25.4 * 300.0) as u32;
        assert_eq!(pixel(&buf, w, ct, mm(12.0), mm(12.0)), [255, 0, 0]);
        assert_eq!(pixel(&buf, w, ct, mm(44.0), mm(19.0)), [0, 0, 255]);

        let thumb = dir.join("thumb.png");
        let a = parse_args(&s(&["--in", svg.to_str().unwrap(), "--out", thumb.to_str().unwrap(), "--width-px", "120"])).unwrap();
        assert_eq!(render(&a).unwrap().saved[0].size, Some((120, 60)));

        let clear = dir.join("clear.png");
        let a = parse_args(&s(&[
            "--in",
            svg.to_str().unwrap(),
            "--out",
            clear.to_str().unwrap(),
            "--background",
            "transparent",
        ]))
        .unwrap();
        render(&a).unwrap();
        assert_eq!(decode(&clear).4, png::ColorType::Rgba);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn renders_pdf_and_png_in_one_go() {
        let dir = tmpdir("pdf");
        let svg = sample_svg(&dir, "sans-serif");
        let pdf = dir.join("fig.pdf");
        let png_out = dir.join("fig.png");
        let a = parse_args(&s(&[
            "--in",
            svg.to_str().unwrap(),
            "--out",
            pdf.to_str().unwrap(),
            "--out",
            png_out.to_str().unwrap(),
        ]))
        .unwrap();
        let r = render(&a).unwrap();
        assert_eq!(r.saved.len(), 2);
        assert_eq!(r.saved[0].size, None);
        let bytes = std::fs::read(&pdf).unwrap();
        assert!(bytes.starts_with(b"%PDF"));
        // 页面是图纸的物理尺寸：2in × 1in = 144pt × 72pt
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("/MediaBox [0 0 144 72]"), "MediaBox 不对");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reports_unknown_font_family() {
        let dir = tmpdir("font");
        let svg = sample_svg(&dir, "MesaNoSuchFont Zz9");
        let a = parse_args(&s(&["--in", svg.to_str().unwrap(), "--out", dir.join("f.png").to_str().unwrap()])).unwrap();
        let r = render(&a).unwrap();
        assert!(r.notes.contains(&"font-fallback MesaNoSuchFont Zz9".to_string()), "{:?}", r.notes);
        // 列出的族里有一个装了就不算落空；serif 在 CI 机器上不一定装着，这里只在确有时断言
        let svg = sample_svg(&dir, "MesaNoSuchFont Zz9, serif");
        let a = parse_args(&s(&["--in", svg.to_str().unwrap(), "--out", dir.join("g.png").to_str().unwrap()])).unwrap();
        let tree = load_tree(&a).unwrap();
        if family_resolves(tree.fontdb(), &usvg::FontFamily::Serif) {
            assert!(collect_notes(&tree).iter().all(|n| !n.starts_with("font-fallback")));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reports_missing_glyph() {
        let dir = tmpdir("glyph");
        let p = dir.join("g.svg");
        std::fs::write(
            &p,
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="10mm" viewBox="0 0 40 10"><text x="1" y="8" font-size="5">A&#x10FFFD;B</text></svg>"#,
        )
        .unwrap();
        let a = parse_args(&s(&["--in", p.to_str().unwrap(), "--out", dir.join("g.png").to_str().unwrap()])).unwrap();
        let tree = load_tree(&a).unwrap();
        // 私用区最后一个码位没有正经字体收；机器上一套字体都没有时整段文字不排版，也就无从报缺字
        if tree.fontdb().len() > 0 {
            let notes = collect_notes(&tree);
            assert!(notes.contains(&"missing-glyph \u{10FFFD} U+10FFFD".to_string()), "{notes:?}");
            assert!(notes.iter().all(|n| !n.contains("U+0041")), "{notes:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_svg_is_render_failure() {
        let dir = tmpdir("bad");
        let p = dir.join("bad.svg");
        std::fs::write(&p, "<svg><rect").unwrap();
        let out = dir.join("x.png");
        assert_eq!(helper_svg_render_cli(&s(&["--in", p.to_str().unwrap(), "--out", out.to_str().unwrap()])), 3);
        assert_eq!(
            helper_svg_render_cli(&s(&["--in", dir.join("none.svg").to_str().unwrap(), "--out", out.to_str().unwrap()])),
            3
        );
        assert!(is_cjk('吸') && !is_cjk('A'));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
