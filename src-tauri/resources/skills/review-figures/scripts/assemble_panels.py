#!/usr/bin/env python3
"""Compose cropped panels: equal height, no stretch, (a)(b) labels, white ground."""
from __future__ import annotations

import argparse
import json
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
    """按各自比例分栏宽。不再先拉成一样高再整张缩小，宽图不会把邻居压扁。"""
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


# 块数不设死上限（系统综述一段论述拼 9 块、排 3×3 很常见），按印出来读不读得清卡：
# 每块印出宽度不到 MIN_PANEL_CM，块里的坐标轴数字就小到读不清；整张高过 MAX_HEIGHT_CM，
# 连图注放不进一页。两条都按 --width-cm（期刊栏宽）算，超了不出图，交给人按子论点拆成两张。
MIN_PANEL_CM = 3.5
MAX_HEIGHT_CM = 23.0


def write_layout(out: Path, panels: list[Path], width_cm: float) -> None:
    """拼板旁边落 <图>.json：新编号 (a)(b)… 各是哪个子图文件。figure_sources.py 顺着它找到每块的来源记录。"""
    record = {
        "width_cm": width_cm,
        "panels": [{"letter": chr(ord("a") + i), "source": str(p)} for i, p in enumerate(panels)],
    }
    out.with_suffix(".json").write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")


def check_readable(widths_px: list[int], height_px: int, dpi: int) -> None:
    narrow = [i for i, w in enumerate(widths_px) if w / dpi * 2.54 < MIN_PANEL_CM]
    height_cm = height_px / dpi * 2.54
    problems = []
    if narrow:
        letters = "、".join(f"({chr(ord('a') + i)}) {widths_px[i] / dpi * 2.54:.1f} cm" for i in narrow)
        problems.append(f"{letters} 印出来不到 {MIN_PANEL_CM} cm 宽，字读不清：这一行少放几块（--rows 多分一行）")
    if height_cm > MAX_HEIGHT_CM:
        problems.append(f"整张高 {height_cm:.1f} cm，超过一页能放的 {MAX_HEIGHT_CM} cm：按子论点拆成两张图")
    if problems:
        print("拼板读不清，没出图：" + "；".join(problems), file=sys.stderr)
        sys.exit(3)


def assemble(inputs: list[Path], out: Path, width_cm: float, dpi: int, gap_mm: float) -> None:
    Image, ImageDraw, ImageFont = _need_pil()
    images = [Image.open(p).convert("RGB") for p in inputs]
    if not images:
        print("没有输入图", file=sys.stderr)
        sys.exit(1)
    gap = max(0, int(dpi * gap_mm / 25.4))
    pad = max(8, int(dpi * 1.6 / 25.4))
    label_h = max(18, int(dpi * 3.2 / 25.4))
    width_px = max(1, int(width_cm / 2.54 * dpi))
    fitted, row_h = _fit_row(Image, images, width_px, gap, pad)
    check_readable([im.width for im in fitted], row_h + pad * 2 + label_h, dpi)
    font = _font(ImageFont, dpi)
    canvas = Image.new("RGB", (width_px, row_h + pad * 2 + label_h), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    x = pad
    letters = "abcdefghijklmnopqrstuvwxyz"
    for i, im in enumerate(fitted):
        canvas.paste(im, (x, pad + label_h))
        draw.text((x, pad), f"({letters[i]})", fill=(0, 0, 0), font=font)
        x += im.width + gap
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, dpi=(dpi, dpi))
    write_layout(out, inputs, width_cm)
    print(out)


def assemble_rows(rows: list[list[Path]], out: Path, width_cm: float, dpi: int, gap_mm: float) -> None:
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
    for row in rows:
        images = [Image.open(p).convert("RGB") for p in row]
        fitted, row_h = _fit_row(Image, images, width_px, gap, pad)
        widths += [im.width for im in fitted]
        canvas = Image.new("RGB", (width_px, row_h + label_h), (255, 255, 255))
        draw = ImageDraw.Draw(canvas)
        x = pad
        for im in fitted:
            canvas.paste(im, (x, label_h))
            draw.text((x, 0), f"({letters[letter]})", fill=(0, 0, 0), font=font)
            letter += 1
            x += im.width + gap
        rendered.append(canvas)
    sheet_h = sum(c.height for c in rendered) + row_gap * (len(rendered) - 1) + pad * 2
    check_readable(widths, sheet_h, dpi)
    sheet = Image.new("RGB", (width_px, sheet_h), (255, 255, 255))
    y = pad
    for canvas in rendered:
        sheet.paste(canvas, (0, y))
        y += canvas.height + row_gap
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, dpi=(dpi, dpi))
    write_layout(out, [p for row in rows for p in row], width_cm)
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
    if groups:
        assemble_rows(groups, a.out, a.width_cm, a.dpi, a.gap_mm)
    else:
        assemble(paths, a.out, a.width_cm, a.dpi, a.gap_mm)


if __name__ == "__main__":
    main()
