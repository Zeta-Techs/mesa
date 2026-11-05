#!/usr/bin/env python3
"""复刻用：把复刻渲染出的 PNG 叠到原图上，找出对不上的区域（schematic-forge 技能随包）。

用法（Windows 上把 python3 换成 python）：
  python3 overlay.py 原图.png figures/<图名>/<图名>.png --width-mm 183 [--out figures/<图名>/overlay.png] [--grid 12x8]
输出：叠图（原图偏红、复刻偏青，对齐处发灰）、差异最大的几个格子（毫米坐标），只修这些地方，不要整张重做。
"""
import argparse
import json
import sys
from pathlib import Path


def utf8_stdio():
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")


def main():
    utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("original")
    ap.add_argument("render")
    ap.add_argument("--width-mm", type=float, required=True)
    ap.add_argument("--out")
    ap.add_argument("--grid", default="12x8")
    ap.add_argument("--top", type=int, default=6)
    a = ap.parse_args()
    from PIL import Image, ImageChops, ImageDraw, ImageStat
    org = Image.open(a.original).convert("RGB")
    ren = Image.open(a.render).convert("RGB").resize(org.size, Image.LANCZOS)
    if abs(org.width / org.height - Image.open(a.render).width / Image.open(a.render).height) > 0.02:
        print("note: 两张图宽高比不同：先把画布尺寸改成和原图同比例再比", file=sys.stderr)
    go, gr = org.convert("L"), ren.convert("L")
    over = Image.merge("RGB", (go, gr, gr))
    diff = ImageChops.difference(go, gr)
    cols, rows = (int(v) for v in a.grid.lower().split("x"))
    cw, ch = org.width / cols, org.height / rows
    mm = a.width_mm / org.width
    cells = []
    for r in range(rows):
        for c in range(cols):
            box = (round(c * cw), round(r * ch), round((c + 1) * cw), round((r + 1) * ch))
            v = ImageStat.Stat(diff.crop(box)).mean[0]
            cells.append((v, box))
    cells.sort(reverse=True)
    overall = ImageStat.Stat(diff).mean[0]
    d = ImageDraw.Draw(over)
    worst = []
    for v, box in cells[:a.top]:
        if v < 4:
            break
        d.rectangle(box, outline=(255, 200, 0), width=3)
        worst.append({"box_mm": [round(box[0] * mm, 1), round(box[1] * mm, 1), round((box[2] - box[0]) * mm, 1), round((box[3] - box[1]) * mm, 1)],
                      "mean_diff": round(v, 1)})
    out = Path(a.out) if a.out else Path(a.render).with_name(Path(a.render).stem + "-overlay.png")
    over.save(out)
    print(f"saved: {out.resolve()}")
    print(json.dumps({"overall_mean_diff": round(overall, 1), "worst": worst}, ensure_ascii=False, indent=2))
    print("note: 黄框是差得最多的格子（毫米坐标），打开叠图看是位置偏了、字号不对还是缺东西，只改那几处")
    return 0


if __name__ == "__main__":
    sys.exit(main())
