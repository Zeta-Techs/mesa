#!/usr/bin/env python3
"""Crop one paper figure by its image objects. Fail-closed: no caption, no guess.

The crop is the union of embedded images beside the caption line, on the
nearer side and in the same column, until the next caption. Page text
outside those image rectangles is not rendered. A vector-only figure has
no image object: exit 5 and cite Fig.n instead of clipping the page.

Panel-level crops (a review figure takes the one panel that carries the point):
  --panel c          split along white gutters, take the c-th cell (row-major)
  --grid             write a preview with a 0-1 coordinate grid over the figure
  --box x0,y0,x1,y1  crop that fraction of the figure (read off the grid); each
                     edge snaps to a nearby blank line, an edge still cutting
                     through ink exits 7 (the box missed the panel)
  --page N           with --grid / --box only: work on page N when the caption
                     cannot be located (vector or scanned figures)
  --erase x0,y0,x1,y1  white out the source panel letter in a corner of the crop,
                     so the composite carries only its own (a)(b)(c)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def _need_fitz() -> object:
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print("需要 PyMuPDF：pip install pymupdf", file=sys.stderr)
        sys.exit(2)
    return fitz


def _caption_line_pat(n: int) -> re.Pattern[str]:
    # 题注常和上一行正文粘在同一个文本块里，不能要求整块以 Figure 开头。
    # 只认单独成行、并且以题注开头的那一行；行内「Figure N shows」不算。
    return re.compile(
        rf"^(?:figure|fig\.?|图)\s*{n}(?!\d)",
        re.IGNORECASE,
    )


def _line_text(line: dict) -> str:
    # PDF 常把 "Fig." 和 "2" 拆进相邻 span，中间还留一个空格 span。
    # 直接拼接会变成 "Fig. 2" 或 "Fig.2"，两种都要能认。
    parts = [span.get("text", "") for span in line.get("spans", [])]
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def _caption_line(block: dict, pat: re.Pattern[str]):
    """返回题注行的矩形和原文。正文里顺带提到 Figure N 的行不收。"""
    if block.get("type") != 0:
        return None
    for line in block.get("lines", []):
        text = _line_text(line)
        if pat.match(text):
            box = line.get("bbox")
            if box:
                return box, text
    return None


def _image_rects(page):
    """页面上每个嵌入图的显示矩形。矢量绘制的图没有这项，不另造矩形。"""
    seen: set[tuple[int, int, int, int]] = set()
    rects = []
    for info in page.get_images():
        xref = info[0]
        for rect in page.get_image_rects(xref):
            if rect.width < 8 or rect.height < 8:
                continue
            key = (round(rect.x0), round(rect.y0), round(rect.x1), round(rect.y1))
            if key in seen:
                continue
            seen.add(key)
            rects.append(rect)
    return rects


def _neighbor_captions(page, caption, fig: int):
    """同一栏里、这条题注上下两侧最近的其他题注边界。"""
    pat = re.compile(r"^(?:figure|fig\.?|图)\s*(\d+)(?!\d)", re.IGNORECASE)
    above = page.rect.y0
    below = page.rect.y1
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            match = pat.match(_line_text(line))
            if not match or int(match.group(1)) == fig:
                continue
            box = line.get("bbox") or block["bbox"]
            same_column = box[2] > caption.x0 and box[0] < caption.x1
            if not same_column:
                continue
            if box[3] <= caption.y0 + 2:
                above = max(above, box[3])
            elif box[1] >= caption.y1 - 2:
                below = min(below, box[1])
    return above, below


def _ink_fraction(samples, w, h, n, box):
    x0, y0, x1, y1 = box
    ink = 0
    total = 0
    for y in range(y0, y1):
        row = samples[y * w * n : (y + 1) * w * n]
        for x in range(x0, x1):
            i = x * n
            total += 1
            if min(row[i], row[i + 1], row[i + 2]) < 248:
                ink += 1
    return ink / total if total else 1


def _split_cells(pix):
    """沿够宽的白槽切开。切出来的块必须自己有内容，并且不贴着被切断的线。"""
    samples = pix.samples
    w, h, n = pix.width, pix.height, pix.n
    if w < 80 or h < 80 or n < 3:
        return []
    ink_row = [0] * h
    ink_col = [0] * w
    for y in range(h):
        row = samples[y * w * n : (y + 1) * w * n]
        for x in range(w):
            i = x * n
            if min(row[i], row[i + 1], row[i + 2]) < 248:
                ink_row[y] += 1
                ink_col[x] += 1
    def gaps(counts, limit, total):
        found = []
        start = None
        thresh = total * 0.012
        for i, count in enumerate(counts):
            empty = count <= thresh
            if empty and start is None:
                start = i
            elif not empty and start is not None:
                if i - start >= limit:
                    found.append((start, i))
                start = None
        return found
    row_gaps = [g for g in gaps(ink_row, max(14, h // 40), w) if g[0] > h * 0.08 and g[1] < h * 0.92]
    col_gaps = [g for g in gaps(ink_col, max(14, w // 40), h) if g[0] > w * 0.08 and g[1] < w * 0.92]
    if not row_gaps and not col_gaps:
        return []
    def bands(length, gutters):
        cuts = [0]
        for start, end in gutters:
            cuts.extend((start, end))
        cuts.append(length)
        out = []
        for i in range(0, len(cuts) - 1, 2):
            a, b = cuts[i], cuts[i + 1]
            if b - a > length * 0.12:
                out.append((a, b))
        return out
    rb, cb = bands(h, row_gaps), bands(w, col_gaps)
    if len(rb) * len(cb) < 2:
        return []
    cells = []
    for y0, y1 in rb:
        for x0, x1 in cb:
            box = (x0, y0, x1, y1)
            if _ink_fraction(samples, w, h, n, box) < 0.02:
                return []
            cells.append(box)
    return cells


def locate(doc, fig: int):
    """题注旁的图：返回 (页, 裁切矩形, 题注那一行)。找不到按退出码说明原因。"""
    fitz = _need_fitz()
    pat = _caption_line_pat(fig)
    found_caption = False
    for page in doc:
        captions = []
        for block in page.get_text("dict").get("blocks", []):
            hit = _caption_line(block, pat)
            if hit:
                box, text = hit
                captions.append((fitz.Rect(box), text))
        if not captions:
            continue
        # 「Fig. 4 …」「Figure 4.」是题注；「Figure 4 further」是正文叙述。
        def caption_rank(item: tuple) -> tuple[int, float]:
            rect, text = item
            titled = bool(re.match(r"^(?:fig\.|图|figure\s+\d+\s*[.:：])", text, re.I))
            return (0 if titled else 1, rect.y0)
        captions.sort(key=caption_rank)
        cap = None
        cap_text = ""
        for candidate, text in captions:
            if candidate.y0 < 36:
                continue
            cap = candidate
            cap_text = text
            break
        if cap is None:
            continue
        if cap.y0 < 36:
            # 页眉刊名。题注本身可以很短（只有 “Fig. 2”），不能按宽度滤掉。
            continue
        found_caption = True
        above, below = _neighbor_captions(page, cap, fig)
        above_rects = []
        below_rects = []
        for rect in _image_rects(page):
            # 短题注（“Fig. 2”）比图窄，用中心是否落在对方范围内判断同栏。
            center_in_caption = cap.x0 - 8 <= (rect.x0 + rect.x1) / 2 <= cap.x1 + 8
            caption_in_image = rect.x0 - 8 <= (cap.x0 + cap.x1) / 2 <= rect.x1 + 8
            if not (center_in_caption or caption_in_image):
                continue
            if rect.width < 40 or rect.height < 40:
                continue
            if rect.y1 <= cap.y0 + 6 and rect.y0 >= above - 2:
                above_rects.append(rect)
            elif rect.y0 >= cap.y1 - 6 and rect.y1 <= below + 2:
                below_rects.append(rect)
        # 图在题注上或题注下都常见。取离题注更近的那一侧，不把另一张图并进来。
        def nearest(rects, edge):
            return min(rects, key=lambda r: abs((r.y0 + r.y1) / 2 - edge)) if rects else None
        up = nearest(above_rects, cap.y0)
        down = nearest(below_rects, cap.y1)
        if up and down:
            chosen = above_rects if abs(up.y1 - cap.y0) <= abs(down.y0 - cap.y1) else below_rects
        else:
            chosen = above_rects or below_rects
        if not chosen:
            continue
        clip = chosen[0]
        for rect in chosen[1:]:
            clip |= rect
        # 只留图像矩形。向四周扩 2 pt 吃进抗锯齿，不扩到旁边的正文行。
        clip = fitz.Rect(clip.x0 - 2, clip.y0 - 2, clip.x1 + 2, clip.y1 + 2) & page.rect
        area = clip.width * clip.height
        page_area = page.rect.width * page.rect.height
        if area <= 0 or area / page_area > 0.85:
            print("图像对象接近整页，拒绝当作单图", file=sys.stderr)
            sys.exit(4)
        return page, clip, cap_text
    if found_caption:
        print(f"Fig. {fig} 题注旁没有可分离的图像对象：用 --page <页码> --grid 看整页坐标、--box 框出那一块；框不准就改为引用 Fig.{fig}", file=sys.stderr)
        sys.exit(5)
    print(f"未找到 Fig./Figure/图 {fig} 题注", file=sys.stderr)
    sys.exit(3)


def parse_box(text: str) -> tuple[float, float, float, float]:
    """「x0,y0,x1,y1」，都是 0–1 的比例（左上角为原点），读自 --grid 预览上的刻度。"""
    try:
        x0, y0, x1, y1 = (float(v) for v in text.replace("，", ",").split(","))
    except ValueError:
        raise SystemExit("--box 写成 x0,y0,x1,y1，四个 0–1 之间的数")
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise SystemExit("--box 要求 0 ≤ x0 < x1 ≤ 1、0 ≤ y0 < y1 ≤ 1")
    if (x1 - x0) * (y1 - y0) < 0.005:
        raise SystemExit("--box 框得太小，不像一块子图")
    return x0, y0, x1, y1


# 裁框的边必须落在空白里。看不了图的模型读坐标格会偏得很远（2026-10-23 HER 初稿实证：
# 子图在 0.505–1.0，读成 0.30–0.60），裁出来是半块曲线加邻块的轴；模型自己的「核验」也看不出来。
# 好框的四条边墨迹比例 ≤ 0.12（微偏的自动挪到附近空白缝就成 0），切进曲线 / 文字的错框至少一条边 ≥ 0.17。
INK = 200            # 任一通道低于它算墨
SNAP = 0.03          # 每条边在 ±3% 范围内找墨最少的那条线
EDGE_LIMIT = 0.08    # 挪完以后某条边墨迹还超过这个比例 = 切进了内容


def _line_ink(samples, w, n, fixed: int, lo: int, hi: int, vertical: bool) -> float:
    """竖线 x=fixed（y 从 lo 到 hi）或横线 y=fixed（x 从 lo 到 hi）上墨的比例"""
    if hi <= lo:
        return 0.0
    ink = 0
    for k in range(lo, hi):
        i = (k * w + fixed) * n if vertical else (fixed * w + k) * n
        if min(samples[i], samples[i + 1], samples[i + 2]) < INK:
            ink += 1
    return ink / (hi - lo)


def snap_box(pix, box: tuple[float, float, float, float], snap: bool = True):
    """把比例框换成像素框，四条边各自挪到附近墨最少的线上（snap=False 不挪，只查）。返回 (像素框, 各边墨迹比例)。"""
    w, h, n, s = pix.width, pix.height, pix.n, pix.samples
    x0, y0, x1, y1 = (int(round(box[0] * w)), int(round(box[1] * h)),
                      min(w - 1, int(round(box[2] * w))), min(h - 1, int(round(box[3] * h))))
    rx, ry = max(4, int(w * SNAP)), max(4, int(h * SNAP))

    def best(cur: int, outward: int, span: tuple[int, int], vertical: bool, limit: int) -> int:
        """已在全白线上就不动。否则先往框外找墨最少的线（不截掉自己的轴标题、字母下沿），
        够干净（≤1%）就用；再往里找；都不够干净取整个范围里墨最少的线，交给边检查判。"""
        ink = lambda c: _line_ink(s, w, n, c, span[0], span[1], vertical)
        # 贴着整张图外沿的边不挪：外面没有邻块，往里挪只会截掉这一块自己的字
        if ink(cur) == 0 or cur <= 0 or cur >= limit:
            return cur
        reach = rx if vertical else ry
        sides = []
        for direction in (outward, -outward):
            cands = [cur + direction * k for k in range(1, reach + 1) if 0 <= cur + direction * k <= limit]
            if cands:
                sides.append(min(cands, key=lambda c: (ink(c), abs(c - cur))))
        for c in sides:
            if ink(c) <= 0.01:
                return c
        return min(sides + [cur], key=lambda c: (ink(c), abs(c - cur)))

    # 先定左右（用原来的上下范围），再定上下（用定好的左右范围）
    if not snap:
        best = lambda cur, outward, span, vertical, limit: cur  # noqa: E731
    x0 = best(x0, -1, (y0, y1), True, w - 1)
    x1 = best(x1, 1, (y0, y1), True, w - 1)
    y0 = best(y0, -1, (x0, x1), False, h - 1)
    y1 = best(y1, 1, (x0, x1), False, h - 1)
    if x1 - x0 < 20 or y1 - y0 < 20:
        return (x0, y0, x1, y1), {"框太小": 1.0}
    edges = {
        "左": _line_ink(s, w, n, x0, y0, y1, True) if x0 > 0 else 0.0,
        "右": _line_ink(s, w, n, x1, y0, y1, True) if x1 < w - 1 else 0.0,
        "上": _line_ink(s, w, n, y0, x0, x1, False) if y0 > 0 else 0.0,
        "下": _line_ink(s, w, n, y1, x0, x1, False) if y1 < h - 1 else 0.0,
    }
    return (x0, y0, x1, y1), edges


def check_erase(box: tuple[float, float, float, float]) -> None:
    """只许抹掉原图角上的子图字母：框小、贴着左上 / 右上角。别的地方是数据，不许动。"""
    x0, y0, x1, y1 = box
    if (x1 - x0) * (y1 - y0) > 0.02:
        raise SystemExit("--erase 只用来抹掉原图的子图字母，框不能超过这块面积的 2%")
    if y0 > 0.15 or not (x0 < 0.15 or x1 > 0.85):
        raise SystemExit("--erase 只能在左上或右上角（原图子图字母的位置）")


def sub_rect(clip, box):
    fitz = _need_fitz()
    x0, y0, x1, y1 = box
    return fitz.Rect(
        clip.x0 + clip.width * x0,
        clip.y0 + clip.height * y0,
        clip.x0 + clip.width * x1,
        clip.y0 + clip.height * y1,
    )


def grid_preview(pix, out: Path) -> None:
    """在图上叠 0–1 坐标格（每 0.1 一条线，0.05 一条虚一点的线），给 Agent 读出子图的框。"""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("需要 Pillow：pip install pillow", file=sys.stderr)
        sys.exit(2)
    im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    draw = ImageDraw.Draw(im, "RGBA")
    size = max(12, min(im.width, im.height) // 45)
    try:
        font = ImageFont.truetype("arial.ttf", size)
    except OSError:
        font = ImageFont.load_default()
    for i in range(21):
        frac = i / 20
        major = i % 2 == 0
        color = (220, 0, 0, 170) if major else (220, 0, 0, 70)
        x = min(im.width - 1, int(frac * im.width))
        y = min(im.height - 1, int(frac * im.height))
        draw.line([(x, 0), (x, im.height)], fill=color, width=2 if major else 1)
        draw.line([(0, y), (im.width, y)], fill=color, width=2 if major else 1)
        if major:
            label = f"{frac:.1f}"
            draw.text((min(x + 2, im.width - size * 2), 2), label, fill=(200, 0, 0, 255), font=font)
            draw.text((2, min(y + 2, im.height - size - 2)), label, fill=(200, 0, 0, 255), font=font)
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out)
    print(out)


def extract(pdf: Path, fig: int, out: Path, dpi: int, panel: str | None,
            box: tuple[float, float, float, float] | None = None, grid: bool = False, page_no: int = 0,
            erase: list[tuple[float, float, float, float]] | None = None, snap: bool = True, key: str = "",
            label: str = "") -> None:
    fitz = _need_fitz()
    doc = fitz.open(pdf)
    try:
        if page_no:
            if page_no > doc.page_count:
                print(f"PDF 只有 {doc.page_count} 页", file=sys.stderr)
                sys.exit(1)
            page = doc[page_no - 1]
            clip = page.rect
            caption = ""
        else:
            page, clip, caption = locate(doc, fig)
        used_box = box
        if box and page_no:
            # 按整页框时同样不许把大半页当成一块子图
            area = sub_rect(clip, box)
            if area.width * area.height / (page.rect.width * page.rect.height) > 0.85:
                print("框住了接近整页，拒绝当作子图", file=sys.stderr)
                sys.exit(4)
        scale = (150 if grid else dpi) / 72
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=clip, alpha=False)
        if grid:
            grid_preview(pix, out)
            return
        if box:
            (bx0, by0, bx1, by1), edges = snap_box(pix, box, snap)
            cut = {k: v for k, v in edges.items() if v > EDGE_LIMIT}
            if cut:
                detail = "、".join(f"{k}边 {v:.2f}" for k, v in cut.items())
                print(
                    f"裁框切进了内容（{detail}，墨迹比例超过 {EDGE_LIMIT}）：框没对准这一块。"
                    "回 --grid 预览重读坐标；读不准就去掉这一块，不要硬裁",
                    file=sys.stderr,
                )
                sys.exit(7)
            w, h = pix.width, pix.height
            used_box = (round(bx0 / w, 3), round(by0 / h, 3), round(bx1 / w, 3), round(by1 / h, 3))
            print(f"实际裁框{'（已挪到空白缝）' if snap else '（未挪）'}：{used_box[0]:.3f},{used_box[1]:.3f},{used_box[2]:.3f},{used_box[3]:.3f}")
            ox, oy = pix.x, pix.y
            rect = fitz.IRect(ox + bx0, oy + by0, ox + bx1 + 1, oy + by1 + 1)
            clipped = fitz.Pixmap(pix.colorspace, rect, pix.alpha)
            clipped.copy(pix, rect)
            pix = clipped
        if panel:
            cells = _split_cells(pix)
            index = ord(panel.lower()) - ord("a")
            if index < 0 or index >= len(cells):
                print(
                    f"Fig. {fig} 按白缝切不出 ({panel})。先 --grid 出坐标预览，看图读出这一块的框，再用 --box 裁；"
                    f"读不准就改为引用 Fig.{fig}({panel})，不要把整张放进拼板",
                    file=sys.stderr,
                )
                sys.exit(6)
            # 带 clip 渲出的 pixmap 原点不在 (0,0)，在页面像素坐标里：格子坐标要加上它的偏移
            ox, oy = pix.x, pix.y
            x0, y0, x1, y1 = cells[index]
            cell = fitz.IRect(ox + x0, oy + y0, ox + x1, oy + y1)
            clipped = fitz.Pixmap(pix.colorspace, cell, pix.alpha)
            clipped.copy(pix, cell)
            pix = clipped
        for ex0, ey0, ex1, ey1 in erase or []:
            w, h, ox, oy = pix.width, pix.height, pix.x, pix.y
            pix.set_rect(
                fitz.IRect(ox + int(ex0 * w), oy + int(ey0 * h), ox + int(ex1 * w + 0.999), oy + int(ey1 * h + 0.999)),
                (255, 255, 255),
            )
        out.parent.mkdir(parents=True, exist_ok=True)
        pix.save(str(out))
        write_source(out, pdf, page.number + 1, fig, caption, panel, used_box, erase or [], key, label)
        print(out)
    finally:
        doc.close()


def key_from_name(out: Path) -> str:
    """按技能约定的文件名 <bib键>-fig3b.png / <bib键>-scheme1.png 取 bib 键"""
    m = re.match(r"(.+?)-(?:fig|scheme|table|tab)\d", out.stem, re.I)
    return m.group(1) if m else out.stem


def write_source(out: Path, pdf: Path, page: int, fig: int, caption: str, panel, box, erase, key: str, label: str = "") -> None:
    """每块旁边落一份来源记录 <块>.json：用户投稿前要去期刊换高清原图、申请转载许可，
    得知道这一块出自哪篇（bib 键）、原图几号哪一块、PDF 第几页、怎么裁的。figure_sources.py 汇总成 sources.md。"""
    record = {
        "key": key or key_from_name(out),
        # 原文里这一块叫什么（Fig. 2(b)、Scheme 1）：--label 给的为准，没给按图号和 --panel 拼
        "label": label or (f"Fig. {fig}" + (f"({panel})" if panel else "") if fig else ""),
        "pdf": str(Path(pdf).resolve()),
        "page": page,
        "figure": fig or None,
        "caption": caption[:200],
        "panel": panel,
        "box": list(box) if box else None,
        "erase": [list(e) for e in erase],
    }
    out.with_suffix(".json").write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--pdf", type=Path, required=True)
    p.add_argument("--fig", type=int, default=0, help="题注上的图号；用 --page 时可不给")
    p.add_argument("--panel", default="", help="只用多联图里的一块，如 f：按白缝切格子、行优先数第几块。切不出就失败，不回退整张")
    p.add_argument("--grid", action="store_true", help="不裁，输出叠了 0–1 坐标格的整张图预览，用来读 --box")
    p.add_argument("--box", default="", help="按比例裁一块：x0,y0,x1,y1（0–1，左上为原点），数值读自 --grid 预览")
    p.add_argument("--page", type=int, default=0, help="题注认不出（矢量图、扫描版）时按整页出 --grid / 裁 --box；页码从 1 数")
    p.add_argument("--erase", action="append", default=[], help="抹白原图的子图字母：x0,y0,x1,y1（0–1，相对裁出的这一块），只许在左上 / 右上角的小框；邻块字母被带进来时可再给一个")
    p.add_argument("--no-snap", action="store_true", help="--box 的边不自动挪（挪到的空白缝外面带进了邻块的字母时用），仍查边")
    p.add_argument("--label", default="", help="原文里这一块的名字，如 \"Fig. 2(b)\"、\"Scheme 1\"：记进来源清单，用户去期刊换原图时按它找")
    p.add_argument("--key", default="", help="这块出自哪篇（references.bib 的键）；不给就按文件名 <键>-fig3b.png 取")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--dpi", type=int, default=300)
    a = p.parse_args()
    if a.page < 0:
        p.error("--page 从 1 数")
    if a.page and not (a.grid or a.box):
        p.error("--page 只配 --grid 或 --box 用：整页不能当图")
    if not a.page and a.fig < 1:
        p.error("--fig 必须 ≥ 1")
    panel = a.panel.strip().lower()[:1]
    if panel and panel not in "abcdefgh":
        p.error("--panel 用 a–h")
    if sum(bool(x) for x in (panel, a.grid, a.box)) > 1:
        p.error("--panel、--grid、--box 一次只用一个")
    if not a.pdf.is_file():
        print(f"找不到 PDF：{a.pdf}", file=sys.stderr)
        sys.exit(1)
    box = parse_box(a.box) if a.box else None
    erase = []
    if a.erase and a.grid:
        p.error("--erase 配 --panel / --box 用，预览图不抹")
    for spec in a.erase:
        x0, y0, x1, y1 = (float(v) for v in spec.replace("，", ",").split(","))
        if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
            p.error("--erase 要求 0 ≤ x0 < x1 ≤ 1、0 ≤ y0 < y1 ≤ 1")
        check_erase((x0, y0, x1, y1))
        erase.append((x0, y0, x1, y1))
    extract(a.pdf, a.fig, a.out, a.dpi, panel or None, box=box, grid=a.grid, page_no=a.page, erase=erase, snap=not a.no_snap, key=a.key, label=a.label)


if __name__ == "__main__":
    main()
