#!/usr/bin/env python3
"""图标素材板与无字 2.5D 主视觉底图助手（schematic-forge 技能随包）。

支持两条无字生图工作流（只依赖 Pillow，有 numpy 时去溢色更干净）：

一、三明治图层架构（顶刊机制图推荐：hero_panel 主视觉底图 + 矢量真文字/弯曲箭头叠层）
  1) 写主视觉描述：
     python3 asset_sheet.py hero --subject "2.5D cross-section of amorphous Ni nanocluster anchored on terraced crystalline MoO2 slab..." \
       [--palette nature-reviews] [--bg white] > figures/<图名>/assets/hero.prompt.txt
  2) 调生图工具出无字底图：
     "$MESA_IMAGE_TOOL" image --prompt-file figures/<图名>/assets/hero.prompt.txt --size 1536x1024 --resolution 2k \
       --out figures/<图名>/assets/hero.png
  3) 叠归一化坐标网格供多模态看图读位点 (nx, ny)：
     python3 asset_sheet.py grid figures/<图名>/assets/hero.png --out figures/<图名>/assets/hero-grid.jpg
     （用 read_file 看 hero-grid.jpg 读出活性位点/分子/气泡的 0.00..1.00 归一化坐标，写进 figure.json 的 hero_panel.anchors）

二、局部小图标素材板（多枚独立小图标画在一张纯品红底格子板上，再抠底按格切开）
  1) 写描述：python3 asset_sheet.py prompt --names "zno-support,ni-particle,h2s" --subjects "ZnO 载体颗粒,Ni 纳米颗粒,H2S 分子" \
               [--style "flat vector scientific illustration, soft shading"] > figures/<图名>/assets/sheet.prompt.txt
  2) 出图：  "$MESA_IMAGE_TOOL" image --prompt-file figures/<图名>/assets/sheet.prompt.txt --size 1536x1024 --resolution 2k \
               --out figures/<图名>/assets/sheet.png
  3) 切开：  python3 asset_sheet.py split figures/<图名>/assets/sheet.png --grid 3x1 --names "zno-support,ni-particle,h2s" \
               --out-dir figures/<图名>/assets [--model gpt-image-1.5] [--key auto]
     格子对不上时改用 --boxes boxes.json（[{"name":"a","box":[x,y,w,h]}...]，像素）。
  单张去底：python3 asset_sheet.py key in.png out.png [--key auto]

切开是 fail-closed：某格空着、图形碰到格边（可能跨格）、框互相重叠，都直接报错退出 3，不猜——改描述重出或手写 --boxes。
退出码：0 成功；2 参数错；3 切不干净。
"""
import argparse
import json
import sys
from pathlib import Path

KEY_DEFAULT = (255, 0, 255)  # 品红：科研图标里最少见的颜色

PALETTE_HINTS = {
    "nature-reviews": "deep navy (#1B4F72), warm coral-amber (#D35400), sage emerald (#2E8B57), and soft gold highlights (#B7950B)",
    "chem-rev-mineral": "mineral slate (#2C3E50), amber gold (#D4AC0D), royal plum (#7D3C98), and celadon teal (#148F77)",
    "jacs-vibrant": "cobalt blue (#1A5276), vermilion red (#CB4335), emerald green (#117864), and warm ochre (#D68910)",
    "cell-pastel": "muted indigo (#3B5998), terracotta coral (#D96B52), soft jade (#459373), and lavender (#7E6BC4)",
    "science-clean": "prussian blue (#0F3D5E), crimson (#B03A2E), steel cyan (#2874A6), and antique gold (#9A7D0A)",
}


def utf8_stdio():
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")


def grid_shape(n):
    cols = {1: 1, 2: 2, 3: 3, 4: 2, 5: 3, 6: 3, 7: 4, 8: 4, 9: 3}.get(n, 4)
    rows = -(-n // cols)
    return cols, rows


def cmd_prompt(a):
    names = [x.strip() for x in a.names.split(",") if x.strip()]
    subjects = [x.strip() for x in (a.subjects or a.names).split(",") if x.strip()]
    if len(subjects) != len(names):
        print("✗ --subjects 的个数要和 --names 一样", file=sys.stderr)
        return 2
    cols, rows = grid_shape(len(names))
    if a.grid:
        cols, rows = (int(v) for v in a.grid.lower().split("x"))
    hexkey = "#%02X%02X%02X" % KEY_DEFAULT
    lines = [
        f"# 素材板 · 网格 {cols}x{rows} · 底色 {hexkey} · 切开：asset_sheet.py split --grid {cols}x{rows} --names \"{','.join(names)}\"",
        f"An icon sheet: {len(names)} separate scientific illustration icons arranged in a strict {cols} by {rows} grid, "
        f"one icon centered in each cell, each icon occupying about 60% of its cell, with wide empty margins between icons so no icon touches another or the cell edges.",
        f"The entire background is one flat solid pure magenta color {hexkey} (RGB 255,0,255), no gradient, no texture, no shadow on the background, no grid lines.",
        f"Style: {a.style}. Consistent style, line weight and lighting across all icons. Do not use magenta or pink inside the icons.",
        "Each icon is a solid closed shape: no holes, gaps or see-through parts where the magenta background shows through the icon.",
        "No text, no letters, no numbers, no labels, no watermark.",
        "Icons in reading order (left to right, top to bottom):",
    ]
    for i, s in enumerate(subjects, 1):
        lines.append(f"{i}. {s}")
    if len(names) < cols * rows:
        lines.append("Leave the remaining cells empty (solid magenta).")
    print("\n".join(lines))
    return 0


def cmd_hero(a):
    """生成用于 hero_panel 的无字 2.5D 科研主视觉底图提示词。"""
    bg_mode = (a.bg or "white").lower()
    if bg_mode not in ("white", "magenta"):
        print("✗ --bg 只能是 white 或 magenta", file=sys.stderr)
        return 2
    bg_desc = (
        "one seamless, completely flat, pure solid white background (#FFFFFF, RGB 255,255,255) all the way to all four edges, "
        "with NO background gradient, NO gray studio backdrop, NO box border, NO floor grid, and NO cast shadow reaching the image edges"
        if bg_mode == "white" else
        "one flat solid pure magenta background (#FF00FF, RGB 255,0,255) with NO gradient, NO texture, NO shadow on the background, "
        "and NO magenta/pink hues used inside the subject"
    )
    pal_hint = PALETTE_HINTS.get(a.palette or "", "")
    pal_line = f"Color harmony: {pal_hint}, with realistic specular highlights and translucent volumetric glow where physically appropriate." if pal_hint else (
        "Color harmony: refined Nature Energy / Chemical Reviews scientific palette (deep mineral blues, warm amber/coral highlights, teal/emerald accents), "
        "avoiding oversaturated neon colors."
    )
    lines = [
        f"# 无字 2.5D 主视觉底图（Hero Illustration）· 底色 {bg_mode} · 叠坐标网格：asset_sheet.py grid <hero.png> --out <hero-grid.jpg>",
        "A high-precision 2.5D isometric scientific mechanism hero illustration in the style of Nature Energy, Nature Catalysis, and Chemical Reviews.",
        f"Visual subject (occupying 62%–72% of the central canvas): {a.subject.strip()}",
        f"Style & rendering: {a.style}. Crisp atomic/molecular geometry, subtle ambient occlusion, soft studio global illumination, clear spatial depth between foreground active sites and background support.",
        pal_line,
        f"Background & layout margin: {bg_desc}. Keep clean empty pure-{bg_mode} margins (at least 14% breathing room on top, bottom, left, and right) around the central structure so external vector leader lines and formulas can be overlaid cleanly.",
        "STRICT NEGATIVE CONSTRAINTS — ABSOLUTELY WORDLESS:",
        "- NO text, NO letters, NO numbers, NO chemical formulas, NO element symbols, NO +/- signs.",
        "- NO arrows, NO leader lines, NO callout boxes, NO axes, NO legends, NO watermarks, NO panel letters.",
        "(All text labels, chemical equations, and reaction arrows will be overlaid later as vector SVG/PPTX layers.)",
    ]
    print("\n".join(lines))
    return 0


def cmd_grid(a):
    """在主视觉底图上叠加 0.00..1.00 归一化坐标网格，方便多模态模型读出精确锚点 (nx, ny)。"""
    from PIL import Image, ImageDraw, ImageFont
    src = Path(a.image)
    if not src.is_file():
        print(f"✗ 找不到图片：{src}", file=sys.stderr)
        return 2
    im = Image.open(src)
    orig_w, orig_h = im.size
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, rgba).convert("RGB")
    else:
        im = im.convert("RGB")
    max_px = max(400, int(a.max_px))
    scale = min(1.0, max_px / max(orig_w, orig_h))
    if scale < 1.0:
        im = im.resize((max(1, round(orig_w * scale)), max(1, round(orig_h * scale))), Image.Resampling.LANCZOS)
    W, H = im.size
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    # 0.05 次网格线 + 0.10 主网格线（白晕底 + 深青线，深浅背景都清楚）
    for step in range(1, 20):
        frac = step * 0.05
        x = round(frac * W)
        y = round(frac * H)
        major = (step % 2 == 0)
        if major:
            d.line([(x, 0), (x, H)], fill=(255, 255, 255, 150), width=3)
            d.line([(0, y), (W, y)], fill=(255, 255, 255, 150), width=3)
            d.line([(x, 0), (x, H)], fill=(18, 92, 150, 185), width=1)
            d.line([(0, y), (W, y)], fill=(18, 92, 150, 185), width=1)
        else:
            d.line([(x, 0), (x, H)], fill=(40, 110, 165, 78), width=1)
            d.line([(0, y), (W, y)], fill=(40, 110, 165, 78), width=1)
    try:
        font = ImageFont.load_default(size=max(12, round(min(W, H) * 0.018)))
    except TypeError:
        font = ImageFont.load_default()
    for step in range(1, 10):
        lbl = f"0.{step}"
        x = round(step * 0.1 * W)
        y = round(step * 0.1 * H)
        for lx, ly in ((x - 11, 4), (x - 11, max(4, H - 20)), (4, y - 8), (max(4, W - 28), y - 8)):
            bb = d.textbbox((lx, ly), lbl, font=font)
            d.rounded_rectangle((bb[0] - 2, bb[1] - 1, bb[2] + 2, bb[3] + 1), radius=3, fill=(255, 255, 255, 225), outline=(18, 92, 150, 180))
            d.text((lx, ly), lbl, fill=(12, 60, 105, 255), font=font)
    out_im = Image.alpha_composite(im.convert("RGBA"), overlay).convert("RGB")
    out_path = Path(a.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.suffix.lower() in (".jpg", ".jpeg"):
        out_im.save(out_path, "JPEG", quality=88)
    else:
        out_im.save(out_path, "PNG")
    print(f"saved: {out_path.resolve()} (orig {orig_w}x{orig_h}, grid {W}x{H})")
    print("note: 用 read_file 查看网格图读出位点归一化坐标 (nx, ny)，在 figure.json 的 hero_panel.anchors 或 callout.target 写 [\"hero_id\", nx, ny]")
    return 0


def detect_key(im, given):
    if given and given != "auto":
        h = given.lstrip("#")
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    w, h = im.size
    pts = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3), (w // 2, 2), (w // 2, h - 3), (2, h // 2), (w - 3, h // 2)]
    px = [im.getpixel(p)[:3] for p in pts]
    return tuple(sorted(c[i] for c in px)[len(px) // 2] for i in range(3))


def remove_key(im, key, tol=40, soft=40):
    """按与底色的切比雪夫距离给软 alpha：< tol 全透明，tol..tol+soft 渐变，再往外不透明。"""
    from PIL import Image, ImageChops
    rgb = im.convert("RGB")
    solid = Image.new("RGB", rgb.size, key)
    diff = ImageChops.difference(rgb, solid)
    r, g, b = diff.split()
    dist = ImageChops.lighter(ImageChops.lighter(r, g), b)
    lut = [0 if d <= tol else 255 if d >= tol + soft else round((d - tol) / soft * 255) for d in range(256)]
    alpha = dist.point(lut)
    out = rgb.copy()
    try:
        import numpy as np
        arr = np.asarray(rgb).astype(np.float32)
        a = np.asarray(alpha).astype(np.float32)[..., None] / 255
        k = np.array(key, dtype=np.float32)
        safe = np.maximum(a, 0.05)
        un = (arr - (1 - a) * k) / safe  # 去溢色：把半透明边上混进来的底色减掉
        arr = np.where(a < 1, np.clip(un, 0, 255), arr)
        out = Image.fromarray(arr.astype("uint8"), "RGB")
    except ImportError:
        pass
    out.putalpha(alpha)
    return out


def trim(im, margin):
    bbox = im.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
    if not bbox:
        return None, None
    x0, y0, x1, y1 = bbox
    w, h = im.size
    box = (max(0, x0 - margin), max(0, y0 - margin), min(w, x1 + margin), min(h, y1 + margin))
    return im.crop(box), bbox


def _same_hue(r, g, b, key):
    import colorsys
    h1, l1, s1 = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    h2, _, _ = colorsys.rgb_to_hls(*(v / 255 for v in key))
    return s1 > 0.25 and min(abs(h1 - h2), 1 - abs(h1 - h2)) < 0.06


def prompt_file_for(sheet):
    """素材板描述文件：与素材板同目录的 sheet.prompt.txt；写成相对图纸目录（含 figure.json 的那一层）的路径"""
    sheet = Path(sheet).resolve()
    prompt = sheet.with_name(sheet.stem + ".prompt.txt")
    for d in sheet.parents:
        if (d / "figure.json").is_file():
            return prompt.relative_to(d).as_posix()
    return prompt.name


def cmd_key(a):
    from PIL import Image
    im = Image.open(a.input)
    key = detect_key(im.convert("RGB"), a.key)
    out = remove_key(im, key, a.tolerance)
    out, _ = trim(out, 4)
    if out is None:
        print("✗ 去底后什么都没剩（底色认错了？用 --key 指定）", file=sys.stderr)
        return 3
    out.save(a.output)
    print(f"saved: {Path(a.output).resolve()}")
    return 0


def cmd_split(a):
    from PIL import Image
    names = [x.strip() for x in a.names.split(",") if x.strip()]
    im = Image.open(a.sheet)
    W, H = im.size
    key = detect_key(im.convert("RGB"), a.key)
    cut = remove_key(im, key, a.tolerance)
    regions = []
    if a.boxes:
        data = json.loads(Path(a.boxes).read_text(encoding="utf-8"))
        for d in data:
            x, y, w, h = (int(v) for v in d["box"])
            regions.append((d["name"], (x, y, x + w, y + h)))
        names = [r[0] for r in regions]
        for i, (n1, b1) in enumerate(regions):
            if b1[0] < 0 or b1[1] < 0 or b1[2] > W or b1[3] > H:
                print(f"✗ {n1} 的框出了图（图 {W}x{H}）", file=sys.stderr)
                return 3
            for n2, b2 in regions[i + 1:]:
                if b1[0] < b2[2] and b2[0] < b1[2] and b1[1] < b2[3] and b2[1] < b1[3]:
                    print(f"✗ {n1} 与 {n2} 的框重叠", file=sys.stderr)
                    return 3
    else:
        if not a.grid:
            print("✗ 要给 --grid 列x行，或 --boxes", file=sys.stderr)
            return 2
        cols, rows = (int(v) for v in a.grid.lower().split("x"))
        if len(names) > cols * rows:
            print(f"✗ {len(names)} 个名字放不进 {cols}x{rows} 的格子", file=sys.stderr)
            return 2
        cw, ch = W / cols, H / rows
        for i, n in enumerate(names):
            c, r = i % cols, i // cols
            regions.append((n, (round(c * cw), round(r * ch), round((c + 1) * cw), round((r + 1) * ch))))
    out_dir = Path(a.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    problems, saved = [], []
    for n, box in regions:
        cell = cut.crop(box)
        icon, bb = trim(cell, a.margin)
        if icon is None:
            problems.append(f"{n}：这一格是空的（模型没画，或画在别的格里）")
            continue
        cw, ch = box[2] - box[0], box[3] - box[1]
        edge = 2
        if bb[0] <= edge or bb[1] <= edge or bb[2] >= cw - edge or bb[3] >= ch - edge:
            problems.append(f"{n}：图形碰到格子边缘（可能跨到邻格或被切掉一块）")
            continue
        # 抠底不干净：不透明像素里还有接近底色的（穿透孔、发粉的边），宁可拒绝
        rgb = icon.convert("RGB")
        alpha = icon.getchannel("A")
        total = spill = 0
        for (r_, g_, b_), al in zip(rgb.getdata(), alpha.getdata()):
            if al < 200:
                continue
            total += 1
            if max(abs(r_ - key[0]), abs(g_ - key[1]), abs(b_ - key[2])) < a.tolerance * 3 and _same_hue(r_, g_, b_, key):
                spill += 1
        if total and spill > max(30, total * 0.004):
            problems.append(f"{n}：去底后还有 {spill} 个像素带底色（图里有穿透孔或边缘发粉）——描述里强调实心、不透底后重出，或调 --tolerance")
            continue
        p = out_dir / f"{n}.png"
        icon.save(p)
        saved.append(p)
    if problems:
        for p in saved:
            p.unlink(missing_ok=True)
        print("✗ 切不干净，什么都没留：\n  " + "\n  ".join(problems)
              + "\n  改描述重出（强调 wide empty margins、one icon per cell），或量好像素写 --boxes", file=sys.stderr)
        return 3
    meta = {"sheet": str(Path(a.sheet).as_posix()), "key": "#%02X%02X%02X" % key, "model": a.model or "",
            "icons": [p.name for p in saved]}
    (out_dir / "sheet.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for p in saved:
        print(f"saved: {p.resolve()}")
    print(f"note: 底色 {meta['key']}；图纸里这些元素写 \"source\": {{\"kind\": \"image-model\", \"model\": \"{a.model or '实际模型'}\", "
          f"\"prompt_file\": \"{prompt_file_for(a.sheet)}\"}}")
    return 0


def main():
    utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prompt")
    p.add_argument("--names", required=True)
    p.add_argument("--subjects")
    p.add_argument("--grid")
    p.add_argument("--style", default="clean flat vector scientific illustration, subtle soft shading, Nature-style graphical abstract icon")
    h = sub.add_parser("hero")
    h.add_argument("--subject", required=True, help="无字 2.5D 核心视觉场景的英文描述（结构、界面、活性位点、分子吸附、光晕等）")
    h.add_argument("--palette", default="nature-reviews", help="配色方案名（如 nature-reviews / chem-rev-mineral / jacs-vibrant）")
    h.add_argument("--bg", default="white", choices=["white", "magenta"], help="底色：white 纯白底直接铺进 hero_panel，magenta 品红底供抠透明")
    h.add_argument("--style", default="2.5D isometric scientific rendering, smooth tactile materials, subtle volumetric electron-cloud glow, studio global illumination")
    g = sub.add_parser("grid")
    g.add_argument("image", help="生成的无字主视觉底图 PNG/JPG")
    g.add_argument("--out", required=True, help="输出带 0.0..1.0 归一化网格的辅助读数图路径")
    g.add_argument("--max-px", type=int, default=1400, help="辅助读数图最长边像素上限（默认 1400）")
    s = sub.add_parser("split")
    s.add_argument("sheet")
    s.add_argument("--names", default="")
    s.add_argument("--grid")
    s.add_argument("--boxes")
    s.add_argument("--out-dir", required=True)
    s.add_argument("--key", default="auto")
    s.add_argument("--tolerance", type=int, default=40)
    s.add_argument("--margin", type=int, default=6)
    s.add_argument("--model")
    k = sub.add_parser("key")
    k.add_argument("input")
    k.add_argument("output")
    k.add_argument("--key", default="auto")
    k.add_argument("--tolerance", type=int, default=40)
    a = ap.parse_args()
    if a.cmd == "split" and not a.names and not a.boxes:
        print("✗ 要给 --names（按阅读顺序）", file=sys.stderr)
        return 2
    return {
        "prompt": cmd_prompt,
        "hero": cmd_hero,
        "grid": cmd_grid,
        "split": cmd_split,
        "key": cmd_key,
    }[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
