#!/usr/bin/env python3
"""Compose cropped panels: equal height, no stretch, (a)(b) labels, white ground."""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path


def _need_pil():
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("需要 Pillow：pip install pillow", file=sys.stderr)
        sys.exit(2)
    return Image, ImageDraw, ImageFont


# Pillow 按文件名找字体时区分大小写：Windows 上只有 arial.ttf，写 Arial.ttf 找不到，
# 落到 10 px 的位图默认字体，子图字母小到看不见（2026-10-23 HER 初稿拼图实证）
FONT_NAMES = (
    "arial.ttf", "Arial.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf",
    "Helvetica.ttc", "/System/Library/Fonts/Helvetica.ttc", "DejaVuSans.ttf", "LiberationSans-Regular.ttf",
)


def _font(ImageFont, dpi: int):
    size = max(18, int(dpi * 8 / 72))
    for name in FONT_NAMES:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _fit_row(Image, images, width_px: int, gap: int, pad: int):
    """按各自比例分栏宽（同排等高）。不再先拉成一样高再整张缩小，宽图不会把邻居压扁。"""
    aspects = [im.width / im.height for im in images]
    inner = width_px - pad * 2 - gap * (len(images) - 1)
    total_aspect = sum(aspects)
    height = max(1, int(inner / total_aspect))
    fitted = []
    for im, aspect in zip(images, aspects):
        w = max(1, int(height * aspect))
        fitted.append(im.resize((w, height), Image.Resampling.LANCZOS))
    # 取整后可能差几个像素，补给最宽的一块，保持栏宽。
    drift = inner - sum(im.width for im in fitted)
    if fitted and drift:
        im = fitted[-1]
        fitted[-1] = im.resize((max(1, im.width + drift), height), Image.Resampling.LANCZOS)
    return fitted, height


def _fit_row_equal_width(Image, images, width_px: int, gap: int, pad: int):
    """按网格等列宽分配同一行宽度（不拉伸比例，高度不同时在行内垂直居中留白）。
    适合扁宽流程图（如 3:1）与近正方形数据图（如 1:1 XRD）同排，避免等高模式下近方图被挤窄。"""
    n = len(images)
    inner = max(n, width_px - pad * 2 - gap * (n - 1))
    base_w, rem = divmod(inner, n)
    fitted = []
    for i, im in enumerate(images):
        col_w = max(1, base_w + (1 if i < rem else 0))
        h = max(1, round(col_w * im.height / im.width))
        fitted.append(im.resize((col_w, h), Image.Resampling.LANCZOS))
    row_h = max(im.height for im in fitted)
    return fitted, row_h


# 块数不设死上限（系统综述一段论述拼 9 块、排 3×3 很常见），按印出来读不读得清卡：
# 每块印出宽度不到 MIN_PANEL_CM，块里的坐标轴数字就小到读不清；整张高过 MAX_HEIGHT_CM，
# 连图注放不进一页。两条都按 --width-cm（期刊栏宽）算，超了不出图，交给人按子论点拆成两张。
MIN_PANEL_CM = 3.5
MAX_HEIGHT_CM = 23.0
SAFE_CAPTION_HEIGHT_CM = 20.5
ALIGN_WIDTH_MAX_AR_RATIO = 1.5
ALIGN_WIDTH_MIN_FILL_RATIO = 0.75


def write_layout(
    out: Path,
    panels: list[Path],
    width_cm: float,
    align_width: bool = False,
    height_cm: float | None = None,
    warnings: list[str] | None = None,
) -> None:
    """拼板旁边落 <图>.json：新编号 (a)(b)… 各是哪个子图文件。figure_sources.py 顺着它找到每块的来源记录。"""
    record: dict[str, object] = {
        "width_cm": width_cm,
        "panels": [{"letter": chr(ord("a") + i), "source": str(p)} for i, p in enumerate(panels)],
    }
    if height_cm is not None:
        record["height_cm"] = round(height_cm, 2)
    if align_width:
        record["layout_mode"] = "align-width"
    if warnings:
        record["warnings"] = warnings
    out.with_suffix(".json").write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")


def _max_feasible_width_cm(
    width_cm: float,
    height_px: int,
    fixed_px: int,
    dpi: int,
    target_cm: float,
) -> float | None:
    content_h = height_px - fixed_px
    avail_h = target_cm / 2.54 * dpi - fixed_px
    if content_h <= 0 or avail_h <= 0:
        return None
    scale = avail_h / content_h
    if scale >= 1.0:
        return round(width_cm, 1)
    # 向下取整到 0.1 cm，留少量像素取整裕度
    return max(0.5, int(width_cm * scale * 10) / 10.0)


def check_align_width_rows(row_stats: list[tuple[int, float, float]]) -> list[str]:
    """检查 --align-width 每行的宽高比极值比与有效面积占比，过大留白时给出清晰告警。"""
    warnings: list[str] = []
    for row_idx, ar_ratio, fill_ratio in row_stats:
        if ar_ratio > ALIGN_WIDTH_MAX_AR_RATIO or fill_ratio < ALIGN_WIDTH_MIN_FILL_RATIO:
            msg = (
                f"第 {row_idx} 行开启 --align-width 后宽高比极值比达 {ar_ratio:.2f}×、"
                f"有效图像面积占比仅 {fill_ratio * 100:.0f}%（阈值 ≤ {ALIGN_WIDTH_MAX_AR_RATIO}× 且 ≥ {int(ALIGN_WIDTH_MIN_FILL_RATIO * 100)}%），"
                f"行内存在大片垂直留白：建议去掉 --align-width 改默认同排等高，或用 --rows 把高矮悬殊的子图拆到不同行"
            )
            warnings.append(msg)
            print(f"warning: {msg}", file=sys.stderr)
    return warnings


def check_readable(
    widths_px: list[int],
    height_px: int,
    dpi: int,
    align_width: bool = False,
    width_cm: float = 8.5,
    fixed_px: int = 0,
) -> None:
    narrow = [i for i, w in enumerate(widths_px) if w / dpi * 2.54 < MIN_PANEL_CM]
    height_cm = height_px / dpi * 2.54
    problems = []
    if narrow:
        letters = "、".join(f"({chr(ord('a') + i)}) {widths_px[i] / dpi * 2.54:.1f} cm" for i in narrow)
        hint = "这一行少放几块（--rows 多分一行）"
        if not align_width:
            hint += "，或扁宽图与近方图同排时加 --align-width 按等列宽分配"
        problems.append(f"{letters} 印出来不到 {MIN_PANEL_CM} cm 宽，字读不清：{hint}")
    if height_cm > MAX_HEIGHT_CM:
        max_w = _max_feasible_width_cm(width_cm, height_px, fixed_px, dpi, MAX_HEIGHT_CM)
        safe_w = _max_feasible_width_cm(width_cm, height_px, fixed_px, dpi, SAFE_CAPTION_HEIGHT_CM)
        min_w_cm = (min(widths_px) / dpi * 2.54) if widths_px else 0.0
        extra = ""
        if max_w is not None:
            scaled_min = min_w_cm * (max_w / width_cm) if width_cm > 0 else 0.0
            if scaled_min >= MIN_PANEL_CM:
                pct = max(45, min(95, round((safe_w or max_w) / max(width_cm, 17.0) * 100)))
                safe_part = f"（留图注安全高 {SAFE_CAPTION_HEIGHT_CM} cm 建议 --width-cm {safe_w:.1f} 或 Quarto width=\"{pct}%\"）" if safe_w else ""
                extra = f"；若不拆图，当前排版不超 {MAX_HEIGHT_CM} cm 的最大 --width-cm 约为 {max_w:.1f} cm{safe_part}"
            else:
                extra = f"；即使把整宽压到 {max_w:.1f} cm，最窄子图也会降到 {scaled_min:.1f} cm（< {MIN_PANEL_CM} cm），必须按子论点拆成两张图"
        problems.append(f"整张高 {height_cm:.1f} cm，超过一页能放的 {MAX_HEIGHT_CM} cm：按子论点拆成两张图{extra}")
    if problems:
        print("拼板读不清，没出图：" + "；".join(problems), file=sys.stderr)
        sys.exit(3)
    if height_cm > SAFE_CAPTION_HEIGHT_CM:
        safe_w = _max_feasible_width_cm(width_cm, height_px, fixed_px, dpi, SAFE_CAPTION_HEIGHT_CM)
        pct = max(50, min(95, round((safe_w or width_cm) / max(width_cm, 17.0) * 100)))
        print(
            f"note: 整张高 {height_cm:.1f} cm（接近一页上限 {MAX_HEIGHT_CM} cm），进 Quarto PDF 时图注可能逼近页脚页码；"
            f"建议在 Markdown 图片属性设 {{width=\"{pct}%\"}} 或把 --width-cm 调至约 {safe_w:.1f} cm",
            file=sys.stderr,
        )


# 自绘块旁边有同名 SVG 时查里面的字：块自己以 (a) 开头写了面板字母，拼板再加一个 (a) 就成了两个
# （2026-11-13 HER 初稿 Fig. 3 实证：自绘示意图顶上自带「(a) Boron substructures…」）。
# 只认带括号的：单独一个字母多半是元素符号（B、N）或坐标轴名，不算。
OWN_LETTER = re.compile(r"^(?:\([A-Za-z]\)|（[A-Za-z]）)(?:\s|[.:：\-—]|(?=[A-Z\u4e00-\u9fff])|$)")
SVG_TEXT_BLOCK = re.compile(r"<(?:[A-Za-z0-9_.-]+:)?text\b[^>]*?(?<!/)>(.*?)</(?:[A-Za-z0-9_.-]+:)?text>", re.S | re.I)
CLOSE_PAREN_TSPAN = re.compile(r"([)）])\s*</(?:[A-Za-z0-9_.-]+:)?tspan\s*>", re.I)
POSITIONED_TSPAN = re.compile(r"<(?:[A-Za-z0-9_.-]+:)?tspan\b[^>]*\b(?:x|y|dx|dy)\s*=[^>]*>", re.I)


def check_own_letters(paths: list[Path]) -> None:
    hits = []
    for path in paths:
        svg = path.with_suffix(".svg")
        if not svg.is_file():
            continue
        for raw in SVG_TEXT_BLOCK.findall(svg.read_text(encoding="utf-8", errors="replace")):
            spaced = POSITIONED_TSPAN.sub(" ", CLOSE_PAREN_TSPAN.sub(r"\1 ", raw))
            text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", spaced))).strip()
            if OWN_LETTER.match(text):
                hits.append(f"{svg} 里有「{text[:40]}」")
                break
    if hits:
        print(
            "拼进来的自绘块自带面板字母，拼板还要再加 (a)(b)，会重复，没出图："
            + "；".join(hits)
            + "。把块里的字母去掉、标题挪进图注后重渲这一块再拼",
            file=sys.stderr,
        )
        sys.exit(3)


def assemble(inputs: list[Path], out: Path, width_cm: float, dpi: int, gap_mm: float, align_width: bool = False) -> None:
    Image, ImageDraw, ImageFont = _need_pil()
    images = [Image.open(p).convert("RGB") for p in inputs]
    if not images:
        print("没有输入图", file=sys.stderr)
        sys.exit(1)
    gap = max(0, int(dpi * gap_mm / 25.4))
    pad = max(8, int(dpi * 1.6 / 25.4))
    label_h = max(18, int(dpi * 3.2 / 25.4))
    width_px = max(1, int(width_cm / 2.54 * dpi))
    fit = _fit_row_equal_width if align_width else _fit_row
    fitted, row_h = fit(Image, images, width_px, gap, pad)
    fixed_px = pad * 2 + label_h
    total_h = row_h + fixed_px
    check_readable([im.width for im in fitted], total_h, dpi, align_width, width_cm=width_cm, fixed_px=fixed_px)
    warnings: list[str] = []
    if align_width and len(images) >= 2:
        aspects = [im.width / max(1, im.height) for im in images]
        ar_ratio = max(aspects) / max(1e-6, min(aspects))
        fill_ratio = sum(im.width * im.height for im in fitted) / max(1, sum(im.width for im in fitted) * row_h)
        warnings = check_align_width_rows([(1, ar_ratio, fill_ratio)])
    font = _font(ImageFont, dpi)
    canvas = Image.new("RGB", (width_px, total_h), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    x = pad
    letters = "abcdefghijklmnopqrstuvwxyz"
    for i, im in enumerate(fitted):
        y_off = (row_h - im.height) // 2
        canvas.paste(im, (x, pad + label_h + y_off))
        draw.text((x, pad), f"({letters[i]})", fill=(0, 0, 0), font=font)
        x += im.width + gap
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, dpi=(dpi, dpi))
    write_layout(out, inputs, width_cm, align_width, height_cm=total_h / dpi * 2.54, warnings=warnings)
    print(out)


def assemble_rows(rows: list[list[Path]], out: Path, width_cm: float, dpi: int, gap_mm: float, align_width: bool = False) -> None:
    """多行拼板。一行超过 4 块时单行会矮到不可读，按行分组，字母跨行连续。"""
    Image, ImageDraw, ImageFont = _need_pil()
    if not rows or any(not row for row in rows):
        print("没有输入图", file=sys.stderr)
        sys.exit(1)
    gap = max(0, int(dpi * gap_mm / 25.4))
    pad = max(8, int(dpi * 1.6 / 25.4))
    label_h = max(18, int(dpi * 3.2 / 25.4))
    row_gap = max(gap, int(dpi * 2.0 / 25.4))
    width_px = max(1, int(width_cm / 2.54 * dpi))
    font = _font(ImageFont, dpi)
    letters = "abcdefghijklmnopqrstuvwxyz"
    letter = 0
    rendered = []
    widths = []
    row_stats: list[tuple[int, float, float]] = []
    fit = _fit_row_equal_width if align_width else _fit_row
    for r_idx, row in enumerate(rows, 1):
        images = [Image.open(p).convert("RGB") for p in row]
        fitted, row_h = fit(Image, images, width_px, gap, pad)
        if align_width and len(images) >= 2:
            aspects = [im.width / max(1, im.height) for im in images]
            ar_ratio = max(aspects) / max(1e-6, min(aspects))
            fill_ratio = sum(im.width * im.height for im in fitted) / max(1, sum(im.width for im in fitted) * row_h)
            row_stats.append((r_idx, ar_ratio, fill_ratio))
        widths += [im.width for im in fitted]
        canvas = Image.new("RGB", (width_px, row_h + label_h), (255, 255, 255))
        draw = ImageDraw.Draw(canvas)
        x = pad
        for im in fitted:
            y_off = (row_h - im.height) // 2
            canvas.paste(im, (x, label_h + y_off))
            draw.text((x, 0), f"({letters[letter]})", fill=(0, 0, 0), font=font)
            letter += 1
            x += im.width + gap
        rendered.append(canvas)
    fixed_px = pad * 2 + label_h * len(rendered) + row_gap * (len(rendered) - 1)
    sheet_h = sum(c.height for c in rendered) + row_gap * (len(rendered) - 1) + pad * 2
    check_readable(widths, sheet_h, dpi, align_width, width_cm=width_cm, fixed_px=fixed_px)
    warnings = check_align_width_rows(row_stats) if align_width else []
    sheet = Image.new("RGB", (width_px, sheet_h), (255, 255, 255))
    y = pad
    for canvas in rendered:
        sheet.paste(canvas, (0, y))
        y += canvas.height + row_gap
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, dpi=(dpi, dpi))
    write_layout(out, [p for row in rows for p in row], width_cm, align_width, height_cm=sheet_h / dpi * 2.54, warnings=warnings)
    print(out)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--inputs", nargs="+", type=Path)
    p.add_argument(
        "--rows",
        nargs="+",
        help="多于 4 块时按行分组，每行一个引号串，如 \"a.png b.png c.png\" \"d.png e.png\"",
    )
    p.add_argument("--width-cm", type=float, default=8.5)
    p.add_argument("--dpi", type=int, default=300)
    p.add_argument("--gap-mm", type=float, default=2.5)
    p.add_argument(
        "--align-width",
        "--grid-cells",
        dest="align_width",
        action="store_true",
        help="按网格等列宽分配同一行宽度（高度不同时垂直居中留白），适合扁宽图与近方图同排",
    )
    a = p.parse_args()
    if a.rows:
        groups = []
        for spec in a.rows:
            row = [Path(tok) for tok in spec.split() if tok]
            if not row:
                p.error("--rows 里有空行")
            groups.append(row)
        paths = [path for row in groups for path in row]
    elif a.inputs:
        if len(a.inputs) > 4:
            print("超过 4 块不要排成一行，改用 --rows", file=sys.stderr)
            sys.exit(1)
        groups = None
        paths = a.inputs
    else:
        p.error("需要 --inputs 或 --rows")
    missing = [str(path) for path in paths if not path.is_file()]
    if missing:
        print("缺少源图：" + "、".join(missing), file=sys.stderr)
        sys.exit(1)
    check_own_letters(paths)
    if groups:
        assemble_rows(groups, a.out, a.width_cm, a.dpi, a.gap_mm, a.align_width)
    else:
        assemble(paths, a.out, a.width_cm, a.dpi, a.gap_mm, a.align_width)


if __name__ == "__main__":
    main()
