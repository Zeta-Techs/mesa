#!/usr/bin/env python3
"""复刻用：量出一张图里每行文字的位置和字号（schematic-forge 技能随包）。

文字内容由能看图的模型读出；位置和字号不靠模型估，由本脚本按墨迹量：
局部背景估计 → 找出比背景深（或浅）的墨迹 → 横向投影切出文字行 → 行内按大空隙切成几段 → 量墨迹高度换算字号，
同一级的字号聚成一组（组内统一用一个字号）。中日韩字按墨迹高 ≈ 0.93 em、西文按 ≈ 0.72 em（含升部）换算。

用法（Windows 上把 python3 换成 python）：
  python3 measure_text.py 原图.png --width-mm 183 [--out figures/<图名>/measure.json] [--debug figures/<图名>/measure.png]
输出每段：box_mm [x, y, w, h]、墨迹高、字号估计（pt_cjk / pt_latin）、字号组；很高或很方的块标 maybe-graphic（多半是图形不是字）。
只依赖 Pillow；有 numpy 时更快。
"""
import argparse
import json
import sys
from pathlib import Path

MM_PER_PT = 25.4 / 72


def utf8_stdio():
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")


def ink_mask(im, delta):
    """比局部背景深 delta 以上（深字浅底）或浅 delta 以上（浅字深底）的像素"""
    from PIL import ImageChops, ImageFilter
    g = im.convert("L")
    radius = max(8, min(g.size) // 40)
    bg = g.filter(ImageFilter.MedianFilter(5)).filter(ImageFilter.BoxBlur(radius))
    dark = ImageChops.subtract(bg, g).point(lambda v: 255 if v > delta else 0)
    light = ImageChops.subtract(g, bg).point(lambda v: 255 if v > delta else 0)
    return ImageChops.lighter(dark, light)


def strip_rules(a, frac=0.04):
    """去掉框线、坐标轴一类长直线：一行（列）里连续墨迹长于图宽（高）的 frac 就抹掉那一段"""
    import numpy as np
    out = a.copy()
    h, w = a.shape
    floor = max(12, int(0.15 * min(h, w)))  # 再短的线可能是大号字的笔画，不抹
    for arr, length, transpose in ((out, max(floor, int(w * frac)), False), (out.T, max(floor, int(h * frac)), True)):
        for i in range(arr.shape[0]):
            row = arr[i]
            if row.sum() < length:
                continue
            d = np.diff(np.concatenate(([0], row.astype(np.int8), [0])))
            starts, ends = np.where(d == 1)[0], np.where(d == -1)[0]
            for s0, e0 in zip(starts, ends):
                if e0 - s0 >= length:
                    row[s0:e0] = False
    # 线抹掉后转角、线头会剩小块：紧挨着被抹掉的线（6 像素内）的残留也去掉
    gone = a & ~out
    near = gone.copy()
    for dy in range(-6, 7):
        for dx in range(-6, 7):
            near |= np.roll(np.roll(gone, dy, axis=0), dx, axis=1)
    return out & ~near


def runs(flags, min_gap):
    """连续为真的区间，间隔不超过 min_gap 的合并"""
    out, start, last = [], None, None
    for i, f in enumerate(flags):
        if f:
            if start is None:
                start = i
            elif i - last > min_gap:
                out.append((start, last + 1))
                start = i
            last = i
    if start is not None:
        out.append((start, last + 1))
    return out


def glyph_height(a, y0, y1, x0, x1):
    """段内估「一个整字」的墨迹高：先按 1 像素空隙切出笔画块，再把相邻块合并到宽度不超过段高（汉字近似方块，
    偏旁会合回整字），取合并后各块高度的中位数。整段高度会被括号、斜杠撑大，不直接用。"""
    sub = a[y0:y1, x0:x1]
    seg_h = y1 - y0
    clusters = runs(list(sub.any(axis=0)), 0)
    merged = []
    for c0, c1 in clusters:
        if merged and c1 - merged[-1][0] <= seg_h * 1.05:
            merged[-1] = (merged[-1][0], c1)
        else:
            merged.append((c0, c1))
    hs = []
    for c0, c1 in merged:
        ys = sub[:, c0:c1].any(axis=1).nonzero()[0]
        if len(ys):
            hs.append(int(ys[-1] - ys[0] + 1))
    hs.sort()
    return hs[len(hs) // 2] if hs else seg_h


def group_sizes(vals, tol=0.08):
    order = sorted(set(vals))
    groups, cur = [], []
    for v in order:
        if cur and v > cur[0] * (1 + tol):
            groups.append(cur)
            cur = []
        cur.append(v)
    if cur:
        groups.append(cur)
    mapping = {}
    for gi, g in enumerate(groups):
        mean = round(sum(g) / len(g) * 2) / 2
        for v in g:
            mapping[v] = (gi + 1, mean)
    return mapping


def main():
    utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("--width-mm", type=float, required=True, help="复刻成品的宽度（毫米）")
    ap.add_argument("--delta", type=int, default=45, help="墨迹与背景的灰度差阈值")
    ap.add_argument("--out")
    ap.add_argument("--debug")
    a = ap.parse_args()
    from PIL import Image, ImageDraw
    im = Image.open(a.image).convert("RGB")
    mm_per_px = a.width_mm / im.width
    try:
        import numpy as np
    except ImportError:
        print("✗ 需要 numpy：python3 -m pip install numpy", file=sys.stderr)
        return 2
    a_ = strip_rules(np.asarray(ink_mask(im, a.delta)) > 0)
    h, w = a_.shape
    min_h = max(3, round(h / 400))
    bands = [b for b in runs(list(a_.any(axis=1)), 1) if b[1] - b[0] >= 1]
    lines = []
    for b in bands:
        # g、y 的下伸部有时和字身断开，矮且挨得近的一条并回上一行
        if lines and b[0] - lines[-1][1] <= 0.3 * (lines[-1][1] - lines[-1][0]) and b[1] - b[0] < 0.5 * (lines[-1][1] - lines[-1][0]):
            lines[-1] = (lines[-1][0], b[1])
        else:
            lines.append(b)
    lines = [b for b in lines if b[1] - b[0] >= min_h]
    segs = []
    for y0, y1 in lines:
        lh = y1 - y0
        for x0, x1 in runs(list(a_[y0:y1].any(axis=0)), max(4, round(lh * 1.2))):
            ys = a_[y0:y1, x0:x1].any(axis=1).nonzero()[0]
            if not len(ys):
                continue
            sy0, sy1 = y0 + int(ys[0]), y0 + int(ys[-1]) + 1
            segs.append((x0, sy0, x1, sy1, glyph_height(a_, sy0, sy1, x0, x1)))
    if segs:
        # 去掉零星小点（框角残留、噪点）：长宽都不到最高一段的 1/5
        tallest = max(s[3] - s[1] for s in segs)
        segs = [s for s in segs if (s[2] - s[0]) >= 0.2 * tallest or (s[3] - s[1]) >= 0.2 * tallest]
    heights = sorted(s[3] - s[1] for s in segs)
    med = heights[len(heights) // 2] if heights else 0
    items = []
    for i, (x0, y0, x1, y1, gh) in enumerate(segs):
        hh, ww = y1 - y0, x1 - x0
        ink_mm = gh * mm_per_px
        graphic = bool(med) and (hh > 3 * med or (ww < 1.3 * hh and hh > 1.8 * med))
        items.append({"id": f"t{i + 1}", "box_mm": [round(x0 * mm_per_px, 2), round(y0 * mm_per_px, 2), round(ww * mm_per_px, 2), round(hh * mm_per_px, 2)],
                      "box_px": [x0, y0, ww, hh], "ink_h_mm": round(ink_mm, 2),
                      "pt_cjk": round(ink_mm / 0.93 / MM_PER_PT, 1), "pt_latin": round(ink_mm / 0.72 / MM_PER_PT, 1),
                      "kind": "maybe-graphic" if graphic else "text"})
    mapping = group_sizes([it["pt_cjk"] for it in items if it["kind"] == "text"])
    for it in items:
        if it["kind"] == "text":
            it["group"], it["group_pt_cjk"] = mapping[it["pt_cjk"]]
    out = {"image": str(Path(a.image).as_posix()), "width_mm": a.width_mm, "mm_per_px": mm_per_px, "segments": items,
           "groups": sorted({(v[0], v[1]) for v in mapping.values()})}
    text = json.dumps(out, ensure_ascii=False, indent=2) + "\n"
    if a.out:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(text, encoding="utf-8")
        print(f"saved: {Path(a.out).resolve()}")
    else:
        print(text)
    if a.debug:
        dbg = im.copy()
        d = ImageDraw.Draw(dbg)
        for it in items:
            x, y, ww, hh = it["box_px"]
            d.rectangle([x, y, x + ww, y + hh], outline=(255, 0, 0) if it["kind"] == "text" else (0, 160, 255), width=2)
        dbg.save(a.debug)
        print(f"saved: {Path(a.debug).resolve()}")
    n_text = sum(1 for it in items if it["kind"] == "text")
    print(f"note: {n_text} 段文字、{len(items) - n_text} 块像图形；字号组 " +
          "、".join(f"G{g}≈{pt:g}pt" for g, pt in out["groups"]) + "（按中日韩字估；纯西文行看 pt_latin）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
