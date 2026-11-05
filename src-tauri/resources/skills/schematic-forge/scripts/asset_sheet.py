#!/usr/bin/env python3
"""图标素材板（schematic-forge 技能随包）：让出图模型把一组图标画在一张纯色底的格子板上，再抠底、按格切开。

一张板出全部图标，风格一致、调一次模型；不支持透明底的模型（Gemini、豆包等）也能用。只依赖 Pillow（有 numpy 时去溢色更干净）。

用法（Windows 上把 python3 换成 python）：
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
    return {"prompt": cmd_prompt, "split": cmd_split, "key": cmd_key}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
