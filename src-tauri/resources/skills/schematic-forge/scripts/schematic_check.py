#!/usr/bin/env python3
"""示意图检查（schematic-forge 技能随包）：按图纸算出的版面查机器能确定的问题，结果进 Mesa 评审页的核验清单。

用法（在项目 / 工作区根目录下运行；Windows 上把 python3 换成 python）：
  python3 schematic_check.py figures/<图名>/figure.json

查什么（三档：通过 / 拦下 / 待你判断，不打总分）：
  拦下：文字相交、文字超出所在框或画布、跨进别的框、字号低于该用途下限、缺字、元素出画布、
        facts.md 里写的「关系：A → B」没画或方向反、图上文字在 brief.md / facts.md 里找不到原文、
        位图在成品尺寸下分辨率不够、缺 brief.md / facts.md、图纸与 SVG 对不上（改了图纸没重渲）。
  待你判断：上下标过小、字体回落、字体族过多、非期刊栏宽、灰度下分不开的配色、文字压在图片上、连线穿过文字、
        标签像句子、出图模型元素是否透明底、AI 使用披露、冷读与事实核对（检查全过不等于图对）。
结果写进 <根目录>/.ccode/checks/schematic-<图名>.jsonl。退出码：0 没有拦下的；1 有拦下的；2 图纸读不了。
"""
import argparse
import hashlib
import importlib.util
import json
import re
import sys
import tempfile
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import figlib as F  # noqa: E402
import render_figure as R  # noqa: E402


def load_common():
    for path in (HERE / "mesa_checks.py", HERE.parents[2] / "mesa_checks.py" if len(HERE.parents) > 2 else None):
        if path and path.is_file():
            spec = importlib.util.spec_from_file_location("mesa_checks", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise FileNotFoundError("找不到 mesa_checks.py（应与本脚本同目录）。在技能页更新 schematic-forge 技能后再试")


C = load_common()
CHECKER = "script:schematic_check"
JOURNAL_WIDTHS = (85, 89, 90, 120, 136, 174, 180, 183, 190)
RELATION = re.compile(r"^\s*[-*]?\s*关系\s*[:：]\s*(.+?)\s*(?:→|->)\s*(.+?)\s*(?:[（(].*)?$")


def norm(s):
    s = unicodedata.normalize("NFKC", F.plain_text(s))
    return re.sub(r"[\s　*_^{}]+", "", s).lower()


def seg_hits_rect(p, q, r, shrink=0.3):
    """线段是否穿过矩形（矩形先内缩一点，避免擦边算穿过）"""
    x, y, w, h = r[0] + shrink, r[1] + shrink, r[2] - 2 * shrink, r[3] - 2 * shrink
    if w <= 0 or h <= 0:
        return False
    for i in range(41):
        t = i / 40
        px, py = p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t
        if x < px < x + w and y < py < y + h:
            return True
    return False


def main():
    F.utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec")
    ap.add_argument("--root", default=".")
    a = ap.parse_args()
    root = Path(a.root).resolve()
    spec_path = Path(a.spec)
    if not spec_path.is_absolute():
        spec_path = root / spec_path
    srel = R.rel(spec_path, root)
    items = []

    def add(iid, kind, status, title, file=srel, **ev):
        items.append(C.item(CHECKER, iid, kind, status, title, file, **ev))

    try:
        spec = F.load_spec(spec_path)
    except F.SpecError as e:
        add("SPEC", "schematic_spec", "blocked", f"图纸读不了：{e}")
        name = spec_path.parent.name
        path = C.write_items(root, f"schematic-{name}.jsonl", items)
        C.summary(items, path)
        return 2
    name = spec.get("name") or spec_path.parent.name
    fig_dir = spec_path.parent
    svg_path = fig_dir / f"{name}.svg"
    cv = spec["canvas"]
    canvas = (0, 0, cv["width_mm"], cv["height_mm"])
    book = F.FontBook()
    R.assets_book = book
    index = F.load_index(spec)
    try:
        layouts = R.compute_layouts(spec, book, index)
    except F.SpecError as e:
        add("SPEC", "schematic_spec", "blocked", f"图纸排不了版：{e}")
        return C.summary(items, C.write_items(root, f"schematic-{name}.jsonl", items))

    # 立意与事实
    brief, facts = fig_dir / "brief.md", fig_dir / "facts.md"
    source_text = ""
    for p in (brief, facts):
        if p.is_file():
            source_text += p.read_text(encoding="utf-8") + "\n"
        else:
            add(f"MISSING-{p.stem.upper()}", "schematic_plan", "blocked", f"缺 {p.name}：先写立意和事实记录再画", R.rel(p, root))
    src_norm = norm(source_text)

    # 元素出画布
    for el in spec["elements"]:
        if el["type"] in F.SHAPES and not F.inside(F.bbox(el), canvas):
            add(f"OUT-{el['id']}", "schematic_layout", "blocked", f"元素 {el['id']} 超出画布")

    # 文字块逐个查
    mp = F.min_pt(spec)
    inks = {}
    fams_latin, fams_cjk = set(), set()
    n_text = n_pieces = 0
    for lid, lay in layouts.items():
        owner = lid.split("#")[0]
        ink = lay["ink"]
        inks[lid] = ink
        text = " / ".join("".join(r[0] for r in l["runs"]) for l in lay["lines"])
        short = text[:40]
        if lay["overflow"]:
            add(f"OVERFLOW-{lid}", "schematic_text", "blocked",
                f"{owner} 的文字{'和'.join(lay['overflow'])}度装不下（「{short}」）：减字、换行、调字号或放大框")
        if not F.inside(ink, canvas):
            add(f"OFFCANVAS-{lid}", "schematic_text", "blocked", f"{owner} 的文字出了画布（「{short}」）")
        st = lay["style"]
        if st.pt < mp - 1e-6:
            add(f"MINPT-{lid}", "schematic_text", "blocked",
                f"{owner} 字号 {st.pt:g} pt 低于「{cv['purpose']}」的下限 {mp:g} pt（「{short}」）")
        elif any(r[1] != "n" for l in lay["lines"] for r in l["runs"]) and st.pt * F.SCRIPT_SCALE < mp * 0.75:
            add(f"SCRIPT-{lid}", "schematic_text", "needs_human", f"{owner} 的上下标只有 {st.pt * F.SCRIPT_SCALE:.1f} pt，印出来可能看不清")
        if lay["missing"]:
            add(f"GLYPH-{lid}", "schematic_text", "blocked", f"{owner} 有缺字：{''.join(lay['missing'])}（所选字体里没有这些字）")
        for l in lay["lines"]:
            for r in l["runs"]:
                if r[0]:
                    (fams_cjk if F.is_cjk(r[0][:1]) else fams_latin).add(r[3]["family"])
        if lay["orphans"]:
            add(f"ORPHAN-{lid}", "schematic_text", "needs_human",
                f"{owner} 自动换行后有一行只剩「{lay['orphans'][0]}」：加宽框、减字，或在合适的地方手动写 \\n")
        el_raw = index.get(owner, {})
        raw_text = str(el_raw.get("label", "") if lid.endswith("#label") else el_raw.get("text", ""))
        bad = F.leftover_markup(raw_text)
        if bad:
            add(f"MARKUP-{lid}", "schematic_text", "blocked",
                f"{owner} 的标记没认出来，会原样印在图上：「{bad[0][:30]}」（粗体 **…**、下标 _{{…}}、上标 ^{{…}} 要成对）")
        n_text += 1
        # 图上文字要有出处
        if source_text:
            el_src = index.get(owner, {})
            raw = str(el_src.get("label", "") if lid.endswith("#label") else el_src.get("text", ""))
            for piece in raw.split("\n"):
                n = norm(piece)
                if len(n) <= 2 or re.fullmatch(r"[\d.,%+\-−×()（）]+|\(?[a-z]\)?|\(?[ivx]+\)?", n):
                    continue
                n_pieces += 1
                if n not in src_norm:
                    add(f"SOURCE-{lid}-{hashlib.sha1(n.encode()).hexdigest()[:6]}", "schematic_source", "blocked",
                        f"{owner} 的文字在 brief.md / facts.md 里找不到原文：「{F.plain_text(piece).strip()[:50]}」——先把它写进事实记录（带出处），或改成记录里的说法",
                        quote=piece.strip()[:200])
        # 跨进别的框 / 压在图片上
        for el in spec["elements"]:
            if el["id"] == owner or el["type"] in F.LINES:
                continue
            r = F.bbox(el)
            if el["type"] in ("box", "ellipse") and F.rects_overlap(ink, r, 0.2) and not F.inside(ink, r) and not F.inside(r, ink):
                own = index.get(owner)
                if own and own["type"] == "text" and F.inside(F.bbox(own), r):
                    continue
                add(f"CROSS-{lid}-{el['id']}", "schematic_layout", "blocked", f"{owner} 的文字一半压在 {el['id']} 的边框上（「{short}」）")
            if el["type"] in ("image", "figure") and F.rects_overlap(ink, r, 0.2):
                add(f"ONIMG-{lid}-{el['id']}", "schematic_layout", "needs_human", f"{owner} 的文字压在图片 {el['id']} 上，背景杂时看不清")
        # 标签像句子（期刊示意图）
        if cv["purpose"] == "journal" and not lid.endswith("#label"):
            for l in lay["lines"]:
                line = "".join(r[0] for r in l["runs"])
                words = len(re.findall(r"[A-Za-z]+", line)) + len([c for c in line if F.is_cjk(c)]) / 2
                if words >= 6 and re.search(r"[:：]", line):
                    add(f"SENTENCE-{lid}", "schematic_text", "needs_human", f"{owner} 的标签像一句话（「{line[:30]}」）：期刊示意图标签用 2–4 词名词短语，解释进图注")
                    break

    if source_text and n_pieces and not any(i["id"].startswith("SOURCE-") for i in items):
        add("SOURCE", "schematic_source", "passed", f"图上 {n_pieces} 段文字都在 brief.md / facts.md 里找到了原文")
    # 文字两两相交
    keys = list(inks)
    for i, k1 in enumerate(keys):
        for k2 in keys[i + 1:]:
            if F.rects_overlap(inks[k1], inks[k2], 0.1):
                add(f"CLASH-{k1}-{k2}", "schematic_text", "blocked", f"{k1.split('#')[0]} 与 {k2.split('#')[0]} 的文字互相压住")

    if n_text and not any(i["id"].split("-")[0] in ("CLASH", "OVERFLOW", "OFFCANVAS", "CROSS", "MINPT", "GLYPH", "MARKUP") for i in items):
        add("TEXT", "schematic_text", "passed", f"{n_text} 个文字块都没有相交、出框、缺字，字号不低于 {mp:g} pt")
    # 连线
    drawn = set()
    for el in spec["elements"]:
        if el["type"] not in F.LINES:
            continue
        try:
            pts, (n1, _), (n2, _) = R.line_geometry(spec, el, index)
        except F.SpecError as e:
            add(f"LINE-{el['id']}", "schematic_layout", "blocked", str(e))
            continue
        if not all(F.inside((px, py, 0, 0), canvas) for px, py in pts):
            add(f"LINEOUT-{el['id']}", "schematic_layout", "blocked", f"连线 {el['id']} 出了画布")
        head = el.get("head", "end" if el["type"] == "arrow" else "none")
        if n1 and n2:
            if head in ("end", "both"):
                drawn.add((n1["id"], n2["id"]))
            if head in ("start", "both"):
                drawn.add((n2["id"], n1["id"]))
            if head == "none":
                drawn.add((n1["id"], n2["id"]))
                drawn.add((n2["id"], n1["id"]))
        ends = {x["id"] for x in (n1, n2) if x}
        for lid, ink in inks.items():
            if lid.split("#")[0] in ends or lid == el["id"] + "#label":
                continue
            if any(seg_hits_rect(p, q, ink) for p, q in zip(pts, pts[1:])):
                add(f"THROUGH-{el['id']}-{lid}", "schematic_layout", "needs_human", f"连线 {el['id']} 穿过 {lid.split('#')[0]} 的文字")

    # facts.md 里写明的关系
    if facts.is_file():
        def find(token):
            token = token.strip().strip("`")
            if token in index:
                return token
            t = norm(token)
            if not t:
                return None
            shapes = [e for e in spec["elements"] if e["type"] in ("box", "ellipse")]
            others = [e for e in spec["elements"] if e["type"] in F.SHAPES and e not in shapes]
            # 先认框里文字完全相同的，再认包含这段文字的；框优先于散落的文字
            for pool in (shapes, others):
                for exact in (True, False):
                    hits = [e["id"] for e in pool if (norm(e.get("text", "")) == t if exact else t in norm(e.get("text", "")))]
                    if len(hits) == 1:
                        return hits[0]
                    if len(hits) > 1:
                        return None
            return None
        for ln, line in enumerate(facts.read_text(encoding="utf-8").splitlines(), 1):
            m = RELATION.match(line)
            if not m:
                continue
            a_id, b_id = find(m.group(1)), find(m.group(2))
            frel = R.rel(facts, root)
            if not a_id or not b_id:
                add(f"REL-{ln}", "schematic_relation", "needs_human", f"facts.md 第 {ln} 行的关系对不上图上的元素（写元素 id 或框里的原文）", frel, line=ln)
            elif (a_id, b_id) in drawn:
                add(f"REL-{ln}", "schematic_relation", "passed", f"关系 {a_id} → {b_id} 已画", frel, line=ln)
            elif (b_id, a_id) in drawn:
                add(f"REL-{ln}", "schematic_relation", "blocked", f"关系 {a_id} → {b_id} 画反了方向", frel, line=ln)
            else:
                add(f"REL-{ln}", "schematic_relation", "blocked", f"facts.md 写了 {a_id} → {b_id}，图上没有这条连线", frel, line=ln)

    # 图片素材
    for el in spec["elements"]:
        if el["type"] not in ("image", "figure"):
            continue
        try:
            path, ext = R.Assets(fig_dir, R.Raster()).resolve(el)
        except F.SpecError as e:
            add(f"IMG-{el['id']}", "schematic_asset", "blocked", str(e))
            continue
        if ext in ("png", "jpg", "jpeg", "webp"):
            from PIL import Image
            im = Image.open(path)
            iw, ih = im.size
            scale = min(el["w"] / iw, el["h"] / ih)
            ppi = 25.4 / scale
            need = 150 if cv["purpose"] in ("slide", "poster") else 300
            if ppi < need:
                add(f"PPI-{el['id']}", "schematic_asset", "blocked",
                    f"{el['id']} 在成品尺寸下只有 {ppi:.0f} ppi（要 ≥ {need}）：换更大的图、缩小这个位，或用 --resolution 2k 重出", R.rel(path, root))
            src = el.get("source") or {}
            if src.get("kind") == "image-model" and el["type"] == "image":
                has_alpha = im.mode in ("RGBA", "LA") and im.getextrema()[-1][0] < 250
                if not has_alpha:
                    add(f"ALPHA-{el['id']}", "schematic_asset", "needs_human", f"出图模型画的 {el['id']} 不是透明底，放在色块上会有白底", R.rel(path, root))

    # 组图：每块缩放后的最小字号、同排面板字母是否对齐
    figs = [el for el in spec["elements"] if el["type"] == "figure"]
    for el in figs:
        try:
            path, ext = R.Assets(fig_dir, R.Raster()).resolve(el)
        except F.SpecError:
            continue
        if ext != "svg":
            continue
        try:
            w_mm, h_mm = R.svg_size_mm(path)
        except F.SpecError as e:
            add(f"PANEL-{el['id']}", "schematic_panel", "needs_human", str(e))
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        vb = re.search(r'viewBox="[\d.\-]+[ ,]+[\d.\-]+[ ,]+([\d.]+)[ ,]+([\d.]+)"', text[:4000])
        unit_mm = (w_mm / float(vb.group(1))) if vb else R.UNIT_MM["px"]
        sizes = [float(x) for x in re.findall(r'font-size(?:="|:\s*)([\d.]+)', text)]
        sizes += [float(x) for x in re.findall(r'font:\s*(?:[a-z]+\s+)*([\d.]+)px', text)]
        if not sizes:
            if "<text" not in text and re.search(r"<path", text):
                add(f"PANEL-{el['id']}", "schematic_panel", "needs_human",
                    f"{el['id']} 的 SVG 里文字是路径（转曲了）：改不了字、也量不了字号；数据图请用 svg.fonttype=none 重出")
            continue
        scale = min(el["w"] / w_mm, el["h"] / h_mm)
        eff = min(sizes) * unit_mm * scale / F.MM_PER_PT
        if eff < mp - 1e-6:
            add(f"PANELPT-{el['id']}", "schematic_panel", "blocked",
                f"{el['id']} 缩放到 {scale:.0%} 后最小字号只有 {eff:.1f} pt（下限 {mp:g} pt）：放大这一块或回原图加大字号", R.rel(path, root))
        else:
            add(f"PANELPT-{el['id']}", "schematic_panel", "passed", f"{el['id']} 缩放后最小字号 {eff:.1f} pt", R.rel(path, root))
    labeled = [el for el in figs if el.get("label")]
    rows = []
    for el in sorted(labeled, key=lambda e: e["y"]):
        if rows and abs(el["y"] - rows[-1][0]["y"]) < 4:
            rows[-1].append(el)
        else:
            rows.append([el])
    for row in rows:
        if len({round(e["y"], 1) for e in row}) > 1:
            add(f"LABELROW-{row[0]['id']}", "schematic_panel", "needs_human",
                f"同一排的 {'、'.join(e['id'] for e in row)} 上沿不齐，面板字母不在一条线上")

    # 字体、栏宽、配色
    if len(fams_latin) > 1 or len(fams_cjk) > 1:
        add("FONTS", "schematic_style", "needs_human", f"用了多种字体：{'、'.join(sorted(fams_latin | fams_cjk))}——一般西文、中文各一种")
    if cv["purpose"] == "journal" and not any(abs(cv["width_mm"] - w) < 1 for w in JOURNAL_WIDTHS):
        add("WIDTH", "schematic_style", "needs_human", f"画布宽 {cv['width_mm']:g} mm 不是常见栏宽（单栏 85–90、1.5 栏 120–136、双栏 174–190）：按目标期刊作者指南核对")
    fills = {}
    for el in spec["elements"]:
        if el["type"] in ("box", "ellipse"):
            c = F.color(spec, el.get("fill", "none"))
            if c and c[0] not in ("FFFFFF",):
                fills.setdefault(c[0], el["id"])
    import colorsys

    def hue_class(h6):
        r, g, b = (int(h6[i:i + 2], 16) / 255 for i in (0, 2, 4))
        h, l, s = colorsys.rgb_to_hls(r, g, b)
        if s < 0.25:
            return None
        h *= 360
        return "red" if h < 25 or h > 335 else "green" if 75 < h < 165 else None

    cols = [c for c in fills if F.luminance(c) < 230]  # 很浅的衬底色不算（黑白里都近白，靠边框区分）
    for i, c1 in enumerate(cols):
        for c2 in cols[i + 1:]:
            redgreen = {hue_class(c1), hue_class(c2)} == {"red", "green"}
            if abs(F.luminance(c1) - F.luminance(c2)) < 10 or redgreen:
                add(f"GRAY-{c1}-{c2}", "schematic_style", "needs_human",
                    f"{fills[c1]} 与 {fills[c2]} 的底色" + ("是红绿对比，色盲读者分不开" if redgreen else "灰度几乎一样，黑白打印分不开")
                    + "：加深其中一个，或加线型 / 文字区分")

    # 渲染记录：缺字回报、人改过、重建
    rec_path = fig_dir / "render.json"
    if not svg_path.is_file() or not rec_path.is_file():
        add("RENDER", "schematic_rebuild", "blocked", f"还没渲染：先跑 render_figure.py {srel}")
    else:
        rec = json.loads(rec_path.read_text(encoding="utf-8"))
        for n in rec.get("notes", []):
            if n.startswith("missing-glyph"):
                add(f"RGLYPH-{n}", "schematic_text", "blocked", f"渲染时缺字：{n[14:]}")
            elif n.startswith("font-fallback"):
                add(f"FALLBACK-{n}", "schematic_text", "needs_human", f"字体 {n[14:]} 本机没有，用了别的字体代替：换成本机有的字体，或确认代替的字体可以")
        edited = R.edited_outputs(rec_path, {"svg": svg_path, "pptx": fig_dir / f"{name}.pptx"})
        if edited:
            add("EDITED", "schematic_rebuild", "needs_human",
                f"{'、'.join(p.name for p in edited)} 在渲染后被人改过：以人改的为准，不再拿图纸重建核对", R.rel(edited[0], root))
        elif rec.get("spec_sha256") != F.spec_digest(spec_path):
            add("REBUILD", "schematic_rebuild", "blocked", f"图纸在上次渲染后改过，SVG / PPTX 还是旧的：重跑 render_figure.py {srel}")
        else:
            svg_now = R.build_svg(spec, layouts, R.Assets(fig_dir, R.Raster()), index)
            same = svg_now == svg_path.read_text(encoding="utf-8")
            add("REBUILD", "schematic_rebuild", "passed" if same else "blocked",
                "图纸重建出的 SVG 与现有文件一致" if same else "图纸重建出的 SVG 与现有文件不一致（本机字体或素材变了？）：重跑 render_figure.py",
                R.rel(svg_path, root))
        ai = rec.get("ai_elements") or []
        if ai:
            add("AI-USE", "schematic_disclosure", "needs_human",
                f"图里有 {len(ai)} 个出图模型画的元素（{'、'.join(x['id'] + '：' + x['model'] for x in ai)}）：图注或方法里注明 AI 生成，并查目标期刊对 AI 图像的政策")

    add("COLD-READ", "schematic_review", "needs_human",
        "冷读与事实核对：只看成品尺寸的 PNG，这张图说的是不是 brief.md 那一句？数量、方向、顺序、连接都对吗？（检查全过不等于图对）",
        R.rel(fig_dir / f"{name}.png", root))
    path = C.write_items(root, f"schematic-{name}.jsonl", items)
    return C.summary(items, path)


if __name__ == "__main__":
    sys.exit(main())
