#!/usr/bin/env python3
"""把几张裁好的块（或拼好的图）缩小拼成一张 JPEG 联系表，给 Agent 一次看完。

用法：
  python3 contact_sheet.py --out /tmp/view/check-fig3.jpg figures/src/a.png figures/src/b.png ...

每张缩到 --tile 像素见方以内、下方写文件名；整张长边不超过 --max-side，JPEG 质量 80。
只用来看：裁切、拼板、成品一律用原图，不要拿联系表当素材。
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path


def build(inputs: list[Path], out: Path, tile: int, max_side: int, cols: int) -> None:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("需要 Pillow：pip install pillow", file=sys.stderr)
        sys.exit(2)
    missing = [p for p in inputs if not p.is_file()]
    if missing:
        print("找不到：" + "、".join(str(p) for p in missing), file=sys.stderr)
        sys.exit(1)
    n = len(inputs)
    cols = cols or min(n, 3)
    rows = math.ceil(n / cols)
    label_h = max(14, tile // 16)
    gap = 8
    try:
        font = ImageFont.truetype("arial.ttf", label_h - 2)
    except OSError:
        font = ImageFont.load_default()
    cell_w, cell_h = tile + gap, tile + label_h + gap
    sheet = Image.new("RGB", (cols * cell_w + gap, rows * cell_h + gap), "white")
    draw = ImageDraw.Draw(sheet)
    for i, path in enumerate(inputs):
        with Image.open(path) as src:
            im = src.convert("RGB")
        im.thumbnail((tile, tile))
        x = gap + (i % cols) * cell_w
        y = gap + (i // cols) * cell_h
        # 细灰框标出每块的边，白底的块也看得清边缘有没有带进邻块的东西
        draw.rectangle([x - 1, y - 1, x + im.width, y + im.height], outline=(170, 170, 170))
        sheet.paste(im, (x, y))
        draw.text((x, y + im.height + 2), path.name, fill=(0, 0, 0), font=font)
    sheet.thumbnail((max_side, max_side))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, "JPEG", quality=80)
    print(out)


def main() -> None:
    p = argparse.ArgumentParser(description="缩小拼成联系表，只给 Agent 看图用")
    p.add_argument("inputs", nargs="+", type=Path)
    p.add_argument("--out", type=Path, required=True, help="输出 .jpg（放 /tmp 或 artifacts/，不放 figures/）")
    p.add_argument("--tile", type=int, default=480, help="每张缩到的最大边长（像素）")
    p.add_argument("--max-side", type=int, default=1600, help="整张联系表的最大边长（像素）")
    p.add_argument("--cols", type=int, default=0, help="每行几张，默认最多 3")
    a = p.parse_args()
    if a.out.suffix.lower() not in (".jpg", ".jpeg"):
        p.error("--out 写 .jpg：联系表只用来看，存 JPEG 才小")
    build(a.inputs, a.out, a.tile, a.max_side, a.cols)


if __name__ == "__main__":
    main()
