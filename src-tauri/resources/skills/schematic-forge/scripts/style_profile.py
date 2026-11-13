#!/usr/bin/env python3
"""课题组风格与顶刊配色库：从项目已有的图归纳常用配色、字体、字号、线宽，或直接导出内置顶刊配色（schematic-forge 技能随包）。

用法（Windows 上把 python3 换成 python）：
  python3 style_profile.py figures/ [更多目录或文件…] --out figures/style-profile.json
  python3 style_profile.py --list-palettes
  python3 style_profile.py --preset nature-reviews [--out figures/style-profile.json]
读 SVG 里的 fill / stroke 颜色、font-family、font-size、stroke-width（按 SVG 物理尺寸换算成 pt），
PNG / JPG 取占面积最大的几种彩色（忽略近白、近黑、灰）。Mesa 自己渲染出的输出（同目录有 render.json 的）不算，免得自己学自己。
输出一块能直接放进图纸 theme 的 JSON，外加依据（来自哪些文件、各值出现几次）。只是归纳，用不用由人定。
"""
import argparse
import colorsys
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import figlib as F  # noqa: E402

MM_PER_PT = 25.4 / 72
UNIT_MM = {"mm": 1, "cm": 10, "in": 25.4, "pt": 25.4 / 72, "px": 25.4 / 96, "": 25.4 / 96}
GENERIC = {"sans-serif", "serif", "monospace", "dejavu sans", "inherit"}


def utf8_stdio():
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")


def chromatic(hex6):
    r, g, b = (int(hex6[i:i + 2], 16) / 255 for i in (0, 2, 4))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    return s > 0.2 and 0.12 < l < 0.93


def svg_unit_pt(text):
    tag = re.search(r"<svg\b[^>]*>", text[:4000], re.S)
    if not tag:
        return None
    t = tag.group(0)
    w = re.search(r'\bwidth="([\d.]+)\s*([a-z]*)"', t)
    vb = re.search(r'viewBox="[\d.\-]+[ ,]+[\d.\-]+[ ,]+([\d.]+)', t)
    if w and vb:
        return float(w.group(1)) * UNIT_MM.get(w.group(2), UNIT_MM["px"]) / float(vb.group(1)) / MM_PER_PT
    return UNIT_MM["px"] / MM_PER_PT


def norm_color(v):
    v = v.strip()
    m = re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", v)
    if m:
        h = m.group(1)
        return (h if len(h) == 6 else "".join(c * 2 for c in h)).upper()
    m = re.fullmatch(r"rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)", v)
    if m:
        return "%02X%02X%02X" % tuple(int(x) for x in m.groups())
    return None


def main():
    utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--out")
    ap.add_argument("--max-colors", type=int, default=6)
    ap.add_argument("--list-palettes", action="store_true", help="列出内置的 5 套顶刊配色方案")
    ap.add_argument("--preset", help="直接选用内置顶刊配色（如 nature-reviews / chem-rev-mineral / jacs-vibrant / cell-pastel / science-clean）")
    a = ap.parse_args()
    if a.list_palettes:
        for name, pal in F.PALETTES.items():
            cols = " ".join(f"{k}={v}" for k, v in pal["colors"].items())
            print(f"{name}\ttext={pal['text_color']}\t{cols}")
        return 0
    if a.preset:
        if a.preset not in F.PALETTES:
            print(f"✗ 不认识的预设配色 {a.preset!r}（可用：{', '.join(F.PALETTES)}）", file=sys.stderr)
            return 2
        pal = F.PALETTES[a.preset]
        theme = {"palette": a.preset, "base_pt": 7, "line_pt": 0.75, "text_color": pal["text_color"], "colors": dict(pal["colors"])}
        out = {"theme": theme, "preset": a.preset, "note": f"内置顶刊配色 {a.preset}；可在 figure.json 的 theme 里直接写 \"palette\": \"{a.preset}\""}
        text = json.dumps(out, ensure_ascii=False, indent=2) + "\n"
        if a.out:
            Path(a.out).parent.mkdir(parents=True, exist_ok=True)
            Path(a.out).write_text(text, encoding="utf-8")
            print(f"saved: {Path(a.out).resolve()}")
        print(json.dumps(theme, ensure_ascii=False, indent=2))
        return 0
    if not a.paths:
        print("✗ 要给参考图目录/文件，或用 --preset <配色名> / --list-palettes", file=sys.stderr)
        return 2
    files = []
    for p in a.paths:
        p = Path(p)
        if p.is_dir():
            files += [f for f in p.rglob("*") if f.suffix.lower() in (".svg", ".png", ".jpg", ".jpeg")]
        elif p.is_file():
            files.append(p)
    files = [f for f in files if not (f.parent / "render.json").is_file() and ".history" not in f.parts and "concepts" not in f.parts]
    colors, fonts, sizes, widths, used = Counter(), Counter(), Counter(), Counter(), []
    for f in sorted(files):
        if f.suffix.lower() == ".svg":
            text = f.read_text(encoding="utf-8", errors="replace")
            unit = svg_unit_pt(text) or 1
            for v in re.findall(r'(?:fill|stroke)(?:="|:\s*)([^";)]+\)?)', text):
                c = norm_color(v)
                if c and chromatic(c):
                    colors[c] += 1
            for v in re.findall(r"font-family(?:=\"|:\s*)([^\";]+)", text) + re.findall(r"font:\s*(?:[a-z]+\s+)*[\d.]+px\s+([^;\"]+)", text):
                for fam in v.split(","):
                    fam = fam.strip().strip("'\"")
                    if fam and fam.lower() not in GENERIC:
                        fonts[fam] += 1
                        break
            for v in re.findall(r'font-size(?:="|:\s*)([\d.]+)', text) + re.findall(r"font:\s*(?:[a-z]+\s+)*([\d.]+)px", text):
                sizes[round(float(v) * unit * 2) / 2] += 1
            for v in re.findall(r'stroke-width(?:="|:\s*)([\d.]+)', text):
                w = round(float(v) * unit, 2)
                if w > 0:
                    widths[w] += 1
            used.append(str(f.as_posix()))
        else:
            from PIL import Image
            im = Image.open(f).convert("RGB")
            im.thumbnail((300, 300))
            q = im.quantize(colors=16)
            pal = q.getpalette()
            for count, idx in sorted(q.getcolors(), reverse=True):
                c = "%02X%02X%02X" % tuple(pal[idx * 3: idx * 3 + 3])
                if chromatic(c) and count > im.width * im.height * 0.004:
                    colors[c] += max(1, count // 200)
            used.append(str(f.as_posix()))
    if not used:
        print("✗ 没找到可以归纳的图（SVG / PNG / JPG；Mesa 自己渲染的不算）", file=sys.stderr)
        return 2
    # 相近颜色合并（每通道差 < 24 算一种）
    picked = []
    for c, n in colors.most_common():
        rgb = [int(c[i:i + 2], 16) for i in (0, 2, 4)]
        if all(max(abs(rgb[i] - int(p[i * 2:i * 2 + 2], 16)) for i in range(3)) >= 24 for p, _ in picked):
            picked.append((c, n))
        if len(picked) >= a.max_colors:
            break
    cjk = [f for f, _ in fonts.most_common() if re.search(r"[一-鿿]|hei|song|kai|han|yahei|pingfang|noto sans cjk|source han", f, re.I)]
    latin = [f for f, _ in fonts.most_common() if f not in cjk]
    theme = {"colors": {f"c{i + 1}": "#" + c for i, (c, _) in enumerate(picked)}}
    if latin:
        theme["font"] = latin[:2]
    if cjk:
        theme["font_cjk"] = cjk[:2]
    if sizes:
        theme["base_pt"] = sorted(sizes.elements())[len(list(sizes.elements())) // 2]
    if widths:
        theme["line_pt"] = sorted(widths.elements())[len(list(widths.elements())) // 2]
    out = {"theme": theme, "evidence": {"files": used, "colors": {("#" + c): n for c, n in picked},
                                        "fonts": dict(fonts.most_common(6)), "font_sizes_pt": dict(sorted(sizes.items())),
                                        "line_widths_pt": dict(sorted(widths.items())[:12])},
           "note": "从已有图归纳，只是建议；给用户确认后再用。用户认可的可在 Mesa 里记进项目知识「已定」"}
    text = json.dumps(out, ensure_ascii=False, indent=2) + "\n"
    if a.out:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(text, encoding="utf-8")
        print(f"saved: {Path(a.out).resolve()}")
    print(json.dumps(theme, ensure_ascii=False, indent=2))
    print(f"note: 依据 {len(used)} 个文件；颜色名 c1… 按出现多少排，请按含义改名（如 primary / accent）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
