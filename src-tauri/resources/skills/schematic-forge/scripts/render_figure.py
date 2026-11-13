#!/usr/bin/env python3
"""示意图渲染器（schematic-forge 技能随包）：一份图纸 figure.json → SVG + PPTX + PNG（+ 可选 PDF）。

用法（在项目 / 工作区根目录下运行；Windows 上把 python3 换成 python）：
  python3 render_figure.py figures/<图名>/figure.json [--pdf output/figures/<图名>.pdf] [--formats svg,pptx,png]
                           [--dpi 300] [--force]

- 输出与图纸同目录、同名：figures/<图名>/<图名>.svg / .pptx / .png；渲染记录 render.json；登记进 figures/manifest.json。
- 支持顶刊三明治图层架构（hero_panel 无字 2.5D 主视觉底图 + 归一化锚点矢量叠层）与科研矢量原语：
  弯曲贝塞尔与反应耦合箭头（bend / coupled_in / coupled_out）、科学函数曲线（energy_steps / volcano_curve / dos_lobe）、
  3D 径向高光球体与晶格/团簇阵列（shading="radial" / sphere / lattice）、胶囊标题卡片与色带横幅（header / gradient / shadow / chevron）、
  45° 圆点引出线（callout）。
- 文字是真文字：SVG 用 <text>，PPTX 用文本框（中文字体写进东亚字体位），换行按本机字体量好后显式写入。
- PNG / PDF 由 Mesa 随包工具（环境变量 MESA_FIGURE_TOOL，mesa_helper svg-render）从 SVG 转；没有它时退用 LibreOffice，
  都没有就只出 SVG / PPTX 并说明。
- 人改过的文件为准：render.json 记着上次输出的哈希，PPTX / SVG 被人改过时拒绝覆盖（退出码 4），
  只能在人改过的那份上局部改（pptx_edit.py）；用户明说「推倒重来」才加 --force。
退出码：0 成功；2 图纸有错；4 有人改过的输出，拒绝覆盖。
"""
import argparse
import base64
import datetime
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

sys.path.insert(0, str(Path(__file__).resolve().parent))
import figlib as F  # noqa: E402

HERE = Path(__file__).resolve().parent
ICON_DIR = HERE / "icons"
EMU_MM = 36000
EMU_PT = 12700
SVG_EXT_URI = "{96DAC541-7B7A-43D3-8B79-37D633B846F1}"
NS_ASVG = "http://schemas.microsoft.com/office/drawing/2016/SVG/main"


def fmt(v):
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return s if s not in ("-0", "") else "0"


def safe_id(s):
    return re.sub(r"[^A-Za-z0-9_-]", "_", str(s))


# ---------- 素材 ----------

class Assets:
    """图片 / 图标素材：解析路径、库图标改色与内部 ID 隔离、给 PPTX 准备 PNG 后备。"""

    def __init__(self, spec_dir, raster):
        self.spec_dir = spec_dir
        self.raster = raster
        self.tmp = Path(tempfile.mkdtemp(prefix="mesa-fig-"))
        self.notes = []

    def resolve(self, el):
        src = el.get("src", "")
        if src.startswith("lib:"):
            name = src[4:]
            p = ICON_DIR / f"{name}.svg"
            if not p.is_file():
                raise F.SpecError(f"元素 {el['id']}：图元库里没有 {name}（可用：{', '.join(list_icons())}）")
            return p, "svg"
        p = (self.spec_dir / src) if not os.path.isabs(src) else Path(src)
        if not p.is_file():
            alt = Path(src)
            if alt.is_file():
                p = alt
            else:
                raise F.SpecError(f"元素 {el['id']}：找不到图片 {src}")
        ext = p.suffix.lower().lstrip(".")
        if ext not in ("png", "jpg", "jpeg", "svg", "webp"):
            raise F.SpecError(f"元素 {el['id']}：不支持的图片格式 .{ext}（用 png / jpg / svg）")
        return p, ext

    def svg_text(self, el, path, namespace_ids=False):
        text = path.read_text(encoding="utf-8")
        colors = el.get("colors") or {}
        for key, val in colors.items():
            text = text.replace(f"@{key.upper()}@", val)
        head = re.search(r"<!--\s*default\b([^>]*)-->", text)
        for key, val in re.findall(r"(C\d)=(#[0-9A-Fa-f]{6})", head.group(1) if head else ""):
            text = text.replace(f"@{key}@", val)
        if re.search(r"@C\d@", text):
            raise F.SpecError(f"元素 {el['id']}：图标里有没给颜色的占位 {sorted(set(re.findall(r'@C\d@', text)))}")
        if namespace_ids:
            # 同一张 SVG 里多次内联同一个多层渐变图元时，隔离其内部 gradient/clip id，防改色互相覆盖
            pfx = f"ico-{safe_id(el['id'])}-"
            ids = set(re.findall(r'\bid="([^"]+)"', text))
            for gid in ids:
                text = text.replace(f'id="{gid}"', f'id="{pfx}{gid}"')
                text = text.replace(f"url(#{gid})", f"url(#{pfx}{gid})")
                text = text.replace(f'href="#{gid}"', f'href="#{pfx}{gid}"')
        return text

    def image_pixel_size(self, el):
        path, ext = self.resolve(el)
        if ext == "svg":
            w, h = svg_size_mm(path)
            return (max(1.0, w), max(1.0, h))
        from PIL import Image
        im = Image.open(path)
        crop = el.get("crop")
        if crop and len(crop) == 4:
            return (max(1, int(crop[2])), max(1, int(crop[3])))
        return im.size

    def raster_bytes(self, el, path, ext):
        """位图原样；带 crop（像素 [x, y, w, h]）时整体裁切，不改像素；webp 转 png"""
        crop = el.get("crop")
        if not crop and ext in ("png", "jpg", "jpeg"):
            return path.read_bytes(), ext
        from PIL import Image
        im = Image.open(path)
        if crop:
            x, y, w, h = (int(v) for v in crop)
            if x < 0 or y < 0 or x + w > im.width or y + h > im.height or w <= 0 or h <= 0:
                raise F.SpecError(f"元素 {el['id']}：crop 超出原图（原图 {im.width}x{im.height}）")
            im = im.crop((x, y, x + w, y + h))
        buf = io.BytesIO()
        im.save(buf, "PNG")
        return buf.getvalue(), "png"

    def png_for(self, el, path, ext, w_mm, h_mm):
        """PPTX 用的位图：位图原样用（可裁切）；SVG 按成品尺寸 600 dpi 转 PNG。"""
        if ext in ("png", "jpg", "jpeg", "webp"):
            return self.raster_bytes(el, path, ext)[0]
        svg = self.tmp / f"{safe_id(el['id'])}.svg"
        svg.write_text(self.svg_text(el, path), encoding="utf-8")
        out = self.tmp / f"{safe_id(el['id'])}.png"
        width_px = max(64, round(w_mm / 25.4 * 600))
        if self.raster.to_png(svg, out, width_px=width_px):
            return out.read_bytes()
        self.notes.append(f"{el['id']}：没有 SVG 转图工具，PPTX 里这个图标用灰色占位，SVG 里正常")
        return None


def list_icons():
    return sorted(p.stem for p in ICON_DIR.glob("*.svg")) if ICON_DIR.is_dir() else []


def compute_image_rects(spec, spec_dir=None):
    """计算每个 hero_panel / image / figure 元素内部图像的实际拟合毫米矩形 (fx, fy, fw, fh)，供归一化锚点用"""
    rects = {}
    if spec_dir is None:
        for el in spec["elements"]:
            if el["type"] in ("hero_panel", "image", "figure"):
                rects[el["id"]] = F.hero_slot(spec, el)
        return rects
    dummy = Assets(Path(spec_dir), Raster(probe=False))
    try:
        for el in spec["elements"]:
            if el["type"] in ("hero_panel", "image", "figure"):
                slot = F.hero_slot(spec, el)
                try:
                    sz = dummy.image_pixel_size(el)
                except Exception:
                    sz = None
                rects[el["id"]] = F.fitted_rect(slot, sz)
    finally:
        shutil.rmtree(dummy.tmp, ignore_errors=True)
    return rects


# ---------- SVG → PNG / PDF ----------

class Raster:
    def __init__(self, probe=True):
        self.tool = (os.environ.get("MESA_FIGURE_TOOL") or "") if probe else ""
        self.notes = set()
        if self.tool and not self._probe():
            self.notes.add("MESA_FIGURE_TOOL 指向的工具不认 svg-render（Mesa 版本旧？），改用 LibreOffice")
            self.tool = ""
        self.soffice = (shutil.which("soffice") or shutil.which("libreoffice")) if probe else None
        if probe and not self.soffice and sys.platform == "darwin" and Path("/Applications/LibreOffice.app/Contents/MacOS/soffice").is_file():
            self.soffice = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
        self.used = None

    def _probe(self):
        if not Path(self.tool).is_file():
            return False
        try:
            r = subprocess.run([self.tool, "svg-render", "--probe"], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.TimeoutExpired):
            return False
        return r.returncode == 0 and r.stdout.strip() == "ok"

    def _helper(self, svg, outs, extra):
        cmd = [self.tool, "svg-render", "--in", str(svg)]
        for o in outs:
            cmd += ["--out", str(o)]
        r = subprocess.run(cmd + extra, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
        for line in (r.stdout or "").splitlines():
            if line.startswith("note:"):
                self.notes.add(line[5:].strip())
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or "").strip()[:400] or f"svg-render 退出码 {r.returncode}")
        missing = [str(o) for o in outs if not Path(o).is_file()]
        if missing or "saved:" not in (r.stdout or ""):
            raise RuntimeError(f"svg-render 说成功了，但没有生成 {', '.join(missing) or '文件'}")
        self.used = "mesa_helper svg-render"
        return True

    def to_png(self, svg, out, dpi=300, width_px=None):
        if self.tool:
            extra = ["--width-px", str(width_px)] if width_px else ["--dpi", str(dpi)]
            return self._helper(svg, [out], extra)
        if self.soffice:
            return self._soffice(svg, out, "png")
        return False

    def to_pdf(self, svg, out):
        if self.tool:
            return self._helper(svg, [out], [])
        if self.soffice:
            return self._soffice(svg, out, "pdf")
        return False

    def _soffice(self, svg, out, fmt_):
        d = Path(tempfile.mkdtemp(prefix="mesa-fig-lo-"))
        r = subprocess.run([self.soffice, "--headless", f"-env:UserInstallation=file://{d}/profile", "--convert-to", fmt_,
                            "--outdir", str(d), str(svg)], capture_output=True, text=True, timeout=180)
        made = d / (Path(svg).stem + "." + fmt_)
        if r.returncode != 0 or not made.is_file():
            return False
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(made), out)
        self.used = "LibreOffice（版面可能与 Mesa 渲染略有出入）"
        return True


# ---------- 连线与排版几何 ----------

def line_curve_info(spec, el, index, image_rects=None):
    """返回 (pts, ctrl, (n1, s1), (n2, s2), branches)"""
    if el["type"] == "polyline":
        pts = [tuple(p) for p in el["points"]]
        return pts, None, (None, None), (None, None), []
    (p1, n1, s1), (p2, n2, s2) = F.endpoints(el, index, image_rects)
    ctrl = F.quad_ctrl(p1, p2, el.get("bend", 0.0), el.get("via"))
    if ctrl is not None:
        pts = F.quad_points(p1, ctrl, p2, 24)
    elif el.get("route") == "elbow":
        pts = F.elbow_points(p1, p2, s1, s2) or [p1, p2]
    else:
        pts = [p1, p2]
    branches = F.coupled_branches(spec, el, p1, ctrl, p2) if (el.get("coupled_in") or el.get("coupled_out")) else []
    return pts, ctrl, (n1, s1), (n2, s2), branches


def line_geometry(spec, el, index, image_rects=None):
    pts, _, end1, end2, _ = line_curve_info(spec, el, index, image_rects)
    return pts, end1, end2


def label_box(el, pts, ctrl=None):
    """连线标签放在中段或弧顶外侧；图块的面板字母放左上角外沿"""
    if el["type"] == "figure":
        return (el["x"], el["y"], 8, 5)
    w = float(el.get("label_w", 30))
    h = float(el.get("label_h", 5.5))
    if ctrl is not None and len(pts) >= 3:
        apex = pts[len(pts) // 2]
        chord_y = (pts[0][1] + pts[-1][1]) / 2
        off = float(el.get("label_offset_mm", 0.9))
        if apex[1] <= chord_y + 0.1:
            return (apex[0] - w / 2, apex[1] - h - off, w, h)
        return (apex[0] - w / 2, apex[1] + off, w, h)
    (x1, y1), (x2, y2) = pts[len(pts) // 2 - 1], pts[len(pts) // 2]
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    return (mx - w / 2, my - h - 0.5, w, h)


def compute_layouts(spec, book, index, image_rects=None):
    if image_rects is None:
        image_rects = compute_image_rects(spec, None)
    layouts = {}
    for el in spec["elements"]:
        t = el["type"]
        eid = el["id"]
        if t in ("box", "header_card", "hero_panel"):
            hd = F.header_spec(spec, el)
            if hd and hd.get("text"):
                h_el = {"id": eid + "#header", "text": hd["text"], "pt": hd["pt"], "bold": hd["bold"],
                        "color": hd["color"], "align": hd["align"], "valign": "middle", "pad_mm": hd["pad_mm"]}
                layouts[h_el["id"]] = F.layout_text(spec, h_el, (el["x"], el["y"], el["w"], hd["h"]), book, shape=True)
            if el.get("text"):
                top_off = hd["h"] if hd else 0.0
                box = (el["x"], el["y"] + top_off, el["w"], max(1.0, el["h"] - top_off))
                layouts[eid] = F.layout_text(spec, el, box, book, shape=True)
        elif t in ("ellipse", "sphere") and el.get("text"):
            k = 0.7071
            box = (el["x"] + el["w"] * (1 - k) / 2, el["y"] + el["h"] * (1 - k) / 2, el["w"] * k, el["h"] * k)
            layouts[eid] = F.layout_text(spec, el, box, book, shape=True)
        elif t == "chevron" and el.get("text"):
            _, indent, tip = F.chevron_points(el)
            box = (el["x"] + indent * 0.75, el["y"], max(2.0, el["w"] - indent * 0.75 - tip * 0.65), el["h"])
            layouts[eid] = F.layout_text(spec, el, box, book, shape=True)
        elif t == "text":
            layouts[eid] = F.layout_text(spec, el, F.bbox(el), book, shape=False)
        elif t == "callout" and el.get("text"):
            cg = F.callout_geometry(spec, el, index, image_rects)
            has_bg = bool(el.get("fill") and el.get("fill") not in ("none", "transparent"))
            default_align = "left" if (el["x"] + el["w"] / 2) >= cg["target"][0] else "right"
            c_el = dict(el)
            c_el.setdefault("align", "center" if has_bg else default_align)
            c_el.setdefault("valign", "middle")
            c_el.setdefault("pad_mm", 0.8 if has_bg else 0.2)
            layouts[eid] = F.layout_text(spec, c_el, F.bbox(el), book, shape=has_bg)
        elif t == "figure" and el.get("label"):
            pl = spec.get("panel_labels") or {}
            lab = {"id": eid + "#label", "text": el["label"], "pt": pl.get("pt", 8), "bold": pl.get("bold", True),
                   "align": "left", "valign": "top"}
            layouts[lab["id"]] = F.layout_text(spec, lab, label_box(el, None), book, shape=False)
        elif t in F.LINES:
            pts, ctrl, _, _, branches = line_curve_info(spec, el, index, image_rects)
            if el.get("label"):
                apex = pts[len(pts) // 2] if ctrl else None
                chord_y = (pts[0][1] + pts[-1][1]) / 2 if ctrl else 0
                valign = ("top" if apex[1] > chord_y + 0.1 else "bottom") if ctrl else "bottom"
                lab = {"id": eid + "#label", "text": el["label"], "pt": el.get("label_pt", spec["theme"]["base_pt"]),
                       "align": "center", "valign": valign, "color": el.get("label_color", spec["theme"]["text_color"]),
                       "bold": el.get("label_bold", False)}
                layouts[lab["id"]] = F.layout_text(spec, lab, label_box(el, pts, ctrl), book, shape=False)
            for br in branches:
                if br["label"]:
                    blab = {"id": f"{eid}#{br['sub_id']}", "text": br["label"], "pt": br["label_pt"],
                            "align": "center", "valign": "middle", "color": br["label_color"]}
                    layouts[blab["id"]] = F.layout_text(spec, blab, br["label_box"], book, shape=False)
        elif t in {"sci_curve"} | F.SCI_CURVE_KINDS:
            geom = F.sci_curve_geometry(spec, el)
            for sub_id, ldict, lbox in geom["labels"]:
                lid = f"{eid}#{sub_id}"
                sub_el = dict(ldict, id=lid)
                layouts[lid] = F.layout_text(spec, sub_el, lbox, book, shape=False)
    return layouts


# ---------- SVG ----------

def svg_fill(c):
    if c is None:
        return 'fill="none"'
    hexv, a = c
    return f'fill="#{hexv}"' + (f' fill-opacity="{fmt(a)}"' if a < 1 else "")


def svg_stroke(c, pt, dash):
    if c is None or pt <= 0:
        return 'stroke="none"'
    hexv, a = c
    w = pt * F.MM_PER_PT
    s = f'stroke="#{hexv}" stroke-width="{fmt(w)}"' + (f' stroke-opacity="{fmt(a)}"' if a < 1 else "")
    if dash == "dash":
        s += f' stroke-dasharray="{fmt(w * 4)} {fmt(w * 3)}"'
    elif dash == "dot":
        s += f' stroke-dasharray="{fmt(w)} {fmt(w * 2.2)}" stroke-linecap="round"'
    return s


def svg_cmds_d(cmds):
    parts = []
    for c in cmds:
        op = c[0]
        if op in ("M", "L"):
            parts.append(f"{op}{fmt(c[1])},{fmt(c[2])}")
        elif op == "Q":
            parts.append(f"Q{fmt(c[1])},{fmt(c[2])} {fmt(c[3])},{fmt(c[4])}")
        elif op == "C":
            parts.append(f"C{fmt(c[1])},{fmt(c[2])} {fmt(c[3])},{fmt(c[4])} {fmt(c[5])},{fmt(c[6])}")
        elif op == "Z":
            parts.append("Z")
    return " ".join(parts)


def svg_text_block(lay, el_id):
    st = lay["style"]
    out = [f'<g id={quoteattr(el_id + "-text")}>']
    for i, line in enumerate(lay["lines"]):
        if not line["runs"]:
            continue
        y = F.baseline(lay, i)
        x = line["x"]
        parts = []
        for text, kind, bold, face, size, w in line["runs"]:
            dy = {"n": 0, "sub": 0.25 * st.pt * F.MM_PER_PT, "sup": -0.35 * st.pt * F.MM_PER_PT}[kind]
            attrs = (f'x="{fmt(x)}" y="{fmt(y + dy)}" font-family={quoteattr(face["family"])} '
                     f'font-size="{fmt(size * F.MM_PER_PT)}"')
            if bold:
                attrs += ' font-weight="bold"'
            if st.italic:
                attrs += ' font-style="italic"'
            parts.append(f"<tspan {attrs}>{escape(text)}</tspan>")
            x += w
        hexv, a = st.color
        op = f' fill-opacity="{fmt(a)}"' if a < 1 else ""
        out.append(f'<text xml:space="preserve" fill="#{hexv}"{op}>{"".join(parts)}</text>')
    out.append("</g>")
    return "\n".join(out)


def svg_marker(defs, c, pt):
    key = f"ah-{c[0]}-{fmt(pt)}"
    if key not in defs:
        defs[key] = (f'<marker id="{key}" viewBox="0 0 10 10" refX="8.8" refY="5" markerWidth="3.8" markerHeight="3.8" '
                     f'markerUnits="strokeWidth" orient="auto-start-reverse"><path d="M0,0.8 L10,5 L0,9.2 L2.2,5 z" fill="#{c[0]}"/></marker>')
    return key


def svg_radial_def(defs, c):
    if c is None:
        return 'fill="none"'
    hexv, a = c
    key = f"rg-{hexv}-{fmt(a)}"
    if key not in defs:
        hi, mid, lo = F.radial_stops(hexv)
        op = f' stop-opacity="{fmt(a)}"' if a < 1 else ""
        defs[key] = (f'<radialGradient id="{key}" cx="50%" cy="50%" r="52%" fx="34%" fy="32%">'
                     f'<stop offset="0%" stop-color="#{hi}"{op}/>'
                     f'<stop offset="48%" stop-color="#{mid}"{op}/>'
                     f'<stop offset="100%" stop-color="#{lo}"{op}/></radialGradient>')
    return f'fill="url(#{key})"'


def svg_linear_def(defs, grad):
    c1, c2, angle = grad
    rad = math.radians(angle)
    x1, y1 = 50 - 50 * math.cos(rad), 50 - 50 * math.sin(rad)
    x2, y2 = 50 + 50 * math.cos(rad), 50 + 50 * math.sin(rad)
    key = f"lg-{c1[0]}-{fmt(c1[1])}-{c2[0]}-{fmt(c2[1])}-{fmt(angle)}"
    if key not in defs:
        op1 = f' stop-opacity="{fmt(c1[1])}"' if c1[1] < 1 else ""
        op2 = f' stop-opacity="{fmt(c2[1])}"' if c2[1] < 1 else ""
        defs[key] = (f'<linearGradient id="{key}" x1="{fmt(x1)}%" y1="{fmt(y1)}%" x2="{fmt(x2)}%" y2="{fmt(y2)}%">'
                     f'<stop offset="0%" stop-color="#{c1[0]}"{op1}/>'
                     f'<stop offset="100%" stop-color="#{c2[0]}"{op2}/></linearGradient>')
    return f'fill="url(#{key})"'


def svg_shadow_def(defs, sh):
    if not sh:
        return ""
    key = f"ds-{fmt(sh['dx'])}-{fmt(sh['dy'])}-{fmt(sh['blur'])}-{fmt(sh['opacity'])}-{sh['color']}"
    if key not in defs:
        defs[key] = (f'<filter id="{key}" x="-18%" y="-18%" width="140%" height="145%">'
                     f'<feDropShadow dx="{fmt(sh["dx"])}" dy="{fmt(sh["dy"])}" stdDeviation="{fmt(sh["blur"])}" '
                     f'flood-color="#{sh["color"]}" flood-opacity="{fmt(sh["opacity"])}"/></filter>')
    return f' filter="url(#{key})"'


def svg_embed_asset(el, eid, slot, assets):
    x, y, w, h = slot
    path, ext = assets.resolve(el)
    if ext == "svg" and el["type"] == "figure":
        data = base64.b64encode(path.read_bytes()).decode()
        return (f'<image id={quoteattr(eid)} x="{fmt(x)}" y="{fmt(y)}" width="{fmt(w)}" height="{fmt(h)}" '
                f'preserveAspectRatio="xMidYMid meet" href="data:image/svg+xml;base64,{data}"/>')
    if ext == "svg":
        inner = assets.svg_text(el, path, namespace_ids=True)
        m = re.search(r"<svg\b[^>]*>", inner)
        vb = re.search(r'viewBox="([^"]+)"', m.group(0)) if m else None
        if not vb:
            raise F.SpecError(f"元素 {eid}：SVG 素材缺 viewBox，放不进版面")
        content = inner[m.end():inner.rfind("</svg>")]
        return (f'<svg id={quoteattr(eid)} x="{fmt(x)}" y="{fmt(y)}" width="{fmt(w)}" height="{fmt(h)}" '
                f'viewBox="{vb.group(1)}" preserveAspectRatio="xMidYMid meet" overflow="hidden">{content}</svg>')
    raw, ext2 = assets.raster_bytes(el, path, ext)
    mime = "image/png" if ext2 == "png" else "image/jpeg"
    data = base64.b64encode(raw).decode()
    return (f'<image id={quoteattr(eid)} x="{fmt(x)}" y="{fmt(y)}" width="{fmt(w)}" height="{fmt(h)}" '
            f'preserveAspectRatio="xMidYMid meet" href="data:{mime};base64,{data}"/>')


def build_svg(spec, layouts, assets, index, image_rects=None):
    if image_rects is None:
        image_rects = compute_image_rects(spec, assets.spec_dir)
    cv = spec["canvas"]
    W, H = cv["width_mm"], cv["height_mm"]
    body, defs = [], {}
    bg = F.color(spec, cv.get("background"))
    if bg:
        body.append(f'<rect x="0" y="0" width="{fmt(W)}" height="{fmt(H)}" {svg_fill(bg)}/>')
    th = spec["theme"]

    for el in spec["elements"]:
        t = el["type"]
        eid = el["id"]
        if t in ("box", "header_card", "hero_panel"):
            x, y, w, h = F.bbox(el)
            default_fill = "panel_bg" if (t in ("header_card", "hero_panel") and "panel_bg" in th["colors"]) else ("#FFFFFF" if t == "header_card" else "none")
            fill = F.color(spec, el.get("fill", default_fill))
            grad = F.gradient_spec(spec, el)
            shading = el.get("shading")
            fill_attr = svg_linear_def(defs, grad) if grad else (svg_radial_def(defs, fill) if shading == "radial" and fill else svg_fill(fill))
            stroke = F.color(spec, el.get("stroke", "border" if (t == "header_card" and "border" in th["colors"]) else "none"))
            sk = svg_stroke(stroke, float(el.get("stroke_pt", th["line_pt"])), el.get("dash"))
            r = float(el.get("radius_mm", 2.2 if t in ("header_card", "hero_panel") else 0))
            rr = f' rx="{fmt(r)}"' if r else ""
            flt = svg_shadow_def(defs, F.shadow_spec(el))
            if fill is not None or grad is not None or stroke is not None:
                body.append(f'<rect id={quoteattr(eid + ("-card" if t == "hero_panel" else ""))} x="{fmt(x)}" y="{fmt(y)}" width="{fmt(w)}" height="{fmt(h)}"{rr} {fill_attr} {sk}{flt}/>')
            hd = F.header_spec(spec, el)
            if hd:
                hh = hd["h"]
                hfill = svg_linear_def(defs, hd["gradient"]) if hd["gradient"] else svg_fill(hd["fill"])
                if r > 0:
                    cid = f"clip-hd-{safe_id(eid)}"
                    defs[cid] = f'<clipPath id="{cid}"><rect x="{fmt(x)}" y="{fmt(y)}" width="{fmt(w)}" height="{fmt(h)}" rx="{fmt(r)}"/></clipPath>'
                    body.append(f'<rect id={quoteattr(eid + "-header-bar")} x="{fmt(x)}" y="{fmt(y)}" width="{fmt(w)}" height="{fmt(hh)}" {hfill} clip-path="url(#{cid})"/>')
                else:
                    body.append(f'<rect id={quoteattr(eid + "-header-bar")} x="{fmt(x)}" y="{fmt(y)}" width="{fmt(w)}" height="{fmt(hh)}" {hfill}/>')
                if eid + "#header" in layouts:
                    body.append(svg_text_block(layouts[eid + "#header"], eid + "-header"))
            if t == "hero_panel":
                slot = F.hero_slot(spec, el)
                body.append(svg_embed_asset(el, eid, slot, assets))
            if eid in layouts:
                body.append(svg_text_block(layouts[eid], eid))

        elif t in ("ellipse", "sphere"):
            x, y, w, h = F.bbox(el)
            fill = F.color(spec, el.get("fill", "primary" if t == "sphere" else "none"))
            grad = F.gradient_spec(spec, el)
            shading = el.get("shading", "radial" if t == "sphere" else None)
            fill_attr = svg_linear_def(defs, grad) if grad else (svg_radial_def(defs, fill) if shading == "radial" and fill else svg_fill(fill))
            stroke = F.color(spec, el.get("stroke", "none"))
            sk = svg_stroke(stroke, float(el.get("stroke_pt", th["line_pt"])), el.get("dash"))
            flt = svg_shadow_def(defs, F.shadow_spec(el))
            body.append(f'<ellipse id={quoteattr(eid)} cx="{fmt(x + w / 2)}" cy="{fmt(y + h / 2)}" rx="{fmt(w / 2)}" ry="{fmt(h / 2)}" {fill_attr} {sk}{flt}/>')
            if eid in layouts:
                body.append(svg_text_block(layouts[eid], eid))

        elif t == "chevron":
            pts_c, _, _ = F.chevron_points(el)
            fill = F.color(spec, el.get("fill", "primary"))
            grad = F.gradient_spec(spec, el)
            fill_attr = svg_linear_def(defs, grad) if grad else svg_fill(fill)
            stroke = F.color(spec, el.get("stroke", "none"))
            sk = svg_stroke(stroke, float(el.get("stroke_pt", th["line_pt"])), el.get("dash"))
            flt = svg_shadow_def(defs, F.shadow_spec(el))
            d = "M" + " L".join(f"{fmt(px)},{fmt(py)}" for px, py in pts_c) + " Z"
            body.append(f'<path id={quoteattr(eid)} d="{d}" {fill_attr} {sk} stroke-linejoin="round"{flt}/>')
            if eid in layouts:
                body.append(svg_text_block(layouts[eid], eid))

        elif t == "lattice":
            lg = F.lattice_geometry(spec, el)
            g_parts = [f'<g id={quoteattr(eid)}>']
            for p1, p2, bcol, bpt in lg["bonds"]:
                g_parts.append(f'<line x1="{fmt(p1[0])}" y1="{fmt(p1[1])}" x2="{fmt(p2[0])}" y2="{fmt(p2[1])}" {svg_stroke(bcol, bpt, None)} stroke-linecap="round"/>')
            for cx, cy, r_a, fc, scol, spt in lg["spheres"]:
                f_attr = svg_radial_def(defs, fc) if el.get("shading", "radial") == "radial" else svg_fill(fc)
                g_parts.append(f'<circle cx="{fmt(cx)}" cy="{fmt(cy)}" r="{fmt(r_a)}" {f_attr} {svg_stroke(scol, spt, None)}/>')
            for cx, cy, r_v, vcol, vdash in lg["rings"]:
                g_parts.append(f'<circle cx="{fmt(cx)}" cy="{fmt(cy)}" r="{fmt(r_v)}" fill="#{vcol[0]}" fill-opacity="0.12" {svg_stroke(vcol, 0.75, vdash)}/>')
            g_parts.append("</g>")
            body.append("\n".join(g_parts))

        elif t in {"sci_curve"} | F.SCI_CURVE_KINDS:
            sg = F.sci_curve_geometry(spec, el)
            g_parts = [f'<g id={quoteattr(eid)}>']
            if el.get("fill") and el.get("fill") not in ("none", "transparent"):
                bx, by, bw, bh = F.bbox(el)
                bf = F.color(spec, el["fill"])
                bs = F.color(spec, el.get("box_stroke", "none"))
                rr = f' rx="{fmt(float(el.get("radius_mm", 1.8)))}"' if el.get("radius_mm", 1.8) else ""
                g_parts.append(f'<rect x="{fmt(bx)}" y="{fmt(by)}" width="{fmt(bw)}" height="{fmt(bh)}"{rr} {svg_fill(bf)} {svg_stroke(bs, float(el.get("box_stroke_pt", 0.5)), None)}/>')
            for cmds, fcol, fgrad in sg["fills"]:
                fa = svg_linear_def(defs, fgrad) if fgrad else svg_fill(fcol)
                g_parts.append(f'<path d="{svg_cmds_d(cmds)}" {fa} stroke="none"/>')
            for cmds, scol, spt, sdash, shead in sg["strokes"]:
                mk = ""
                if shead != "none":
                    mid = svg_marker(defs, scol, spt)
                    mk = f' marker-end="url(#{mid})"'
                g_parts.append(f'<path d="{svg_cmds_d(cmds)}" fill="none" {svg_stroke(scol, spt, sdash)} stroke-linejoin="round" stroke-linecap="round"{mk}/>')
            for mx, my, mr, mc, msh in sg["dots"]:
                fa = svg_radial_def(defs, mc) if msh == "radial" else svg_fill(mc)
                g_parts.append(f'<circle cx="{fmt(mx)}" cy="{fmt(my)}" r="{fmt(mr)}" {fa} stroke="#FFFFFF" stroke-width="0.22"/>')
            for sub_id, _, _ in sg["labels"]:
                lid = f"{eid}#{sub_id}"
                if lid in layouts:
                    g_parts.append(svg_text_block(layouts[lid], f"{eid}-{sub_id}"))
            g_parts.append("</g>")
            body.append("\n".join(g_parts))

        elif t == "callout":
            cg = F.callout_geometry(spec, el, index, image_rects)
            g_parts = [f'<g id={quoteattr(eid)}>']
            d_line = "M" + " L".join(f"{fmt(px)},{fmt(py)}" for px, py in cg["pts"])
            g_parts.append(f'<path d="{d_line}" fill="none" {svg_stroke(cg["stroke"], cg["stroke_pt"], el.get("dash"))} stroke-linejoin="round" stroke-linecap="round"/>')
            tx, ty = cg["target"]
            dr = cg["dot_r_mm"]
            if cg["halo"]:
                g_parts.append(f'<circle cx="{fmt(tx)}" cy="{fmt(ty)}" r="{fmt(dr * 1.45)}" fill="#FFFFFF" fill-opacity="0.88"/>')
            g_parts.append(f'<circle cx="{fmt(tx)}" cy="{fmt(ty)}" r="{fmt(dr)}" {svg_fill(cg["dot_color"])}/>')
            if el.get("fill") and el.get("fill") not in ("none", "transparent"):
                bx, by, bw, bh = F.bbox(el)
                bf = F.color(spec, el["fill"])
                bs = F.color(spec, el.get("box_stroke", "none"))
                rr = f' rx="{fmt(float(el.get("radius_mm", 1.2)))}"'
                g_parts.append(f'<rect x="{fmt(bx)}" y="{fmt(by)}" width="{fmt(bw)}" height="{fmt(bh)}"{rr} {svg_fill(bf)} {svg_stroke(bs, 0.45, None)}/>')
            if eid in layouts:
                g_parts.append(svg_text_block(layouts[eid], eid))
            g_parts.append("</g>")
            body.append("\n".join(g_parts))

        elif t == "text":
            body.append(svg_text_block(layouts[eid], eid))

        elif t in ("image", "figure"):
            body.append(svg_embed_asset(el, eid, F.bbox(el), assets))
            if t == "figure" and el.get("label"):
                body.append(svg_text_block(layouts[eid + "#label"], eid + "-label"))

        elif t in F.LINES:
            pts, ctrl, _, _, branches = line_curve_info(spec, el, index, image_rects)
            stroke = F.color(spec, el.get("stroke", th["text_color"]))
            pt = float(el.get("stroke_pt", th["line_pt"]))
            head = el.get("head", "end" if t in ("arrow", "coupled_arrow") else "none")
            # 先画汇入/流出的耦合支路，再画主干箭头
            for br in branches:
                bmk = ""
                if br["head"] != "none":
                    bmid = svg_marker(defs, br["stroke"], br["stroke_pt"])
                    if br["head"] in ("end", "both"):
                        bmk += f' marker-end="url(#{bmid})"'
                bd = f"M{fmt(br['p1'][0])},{fmt(br['p1'][1])} Q{fmt(br['ctrl'][0])},{fmt(br['ctrl'][1])} {fmt(br['p2'][0])},{fmt(br['p2'][1])}"
                body.append(f'<path id={quoteattr(eid + "-" + br["sub_id"])} d="{bd}" fill="none" {svg_stroke(br["stroke"], br["stroke_pt"], br["dash"])} stroke-linecap="round"{bmk}/>')
                blid = f"{eid}#{br['sub_id']}"
                if blid in layouts:
                    body.append(svg_text_block(layouts[blid], f"{eid}-{br['sub_id']}"))
            mk = ""
            if head != "none":
                mid = svg_marker(defs, stroke, pt)
                if head in ("end", "both"):
                    mk += f' marker-end="url(#{mid})"'
                if head in ("start", "both"):
                    mk += f' marker-start="url(#{mid})"'
            if ctrl is not None:
                d = f"M{fmt(pts[0][0])},{fmt(pts[0][1])} Q{fmt(ctrl[0])},{fmt(ctrl[1])} {fmt(pts[-1][0])},{fmt(pts[-1][1])}"
            else:
                d = "M" + " L".join(f"{fmt(px)},{fmt(py)}" for px, py in pts)
            body.append(f'<path id={quoteattr(eid)} d="{d}" fill="none" {svg_stroke(stroke, pt, el.get("dash"))} stroke-linejoin="round" stroke-linecap="round"{mk}/>')
            if eid + "#label" in layouts:
                body.append(svg_text_block(layouts[eid + "#label"], eid + "-label"))

    defs_block = f"<defs>{''.join(defs.values())}</defs>" if defs else ""
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'width="{fmt(W)}mm" height="{fmt(H)}mm" viewBox="0 0 {fmt(W)} {fmt(H)}">\n'
            f'<!-- 由 Mesa schematic-forge 从 figure.json 生成；人改过以后以改过的文件为准 -->\n'
            f"{defs_block}\n" + "\n".join(body) + "\n</svg>\n")


# ---------- PPTX ----------

def build_pptx(spec, layouts, assets, index, out_path, image_rects=None):
    from lxml import etree
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
    from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
    from pptx.oxml.ns import qn
    from pptx.util import Emu, Pt

    if image_rects is None:
        image_rects = compute_image_rects(spec, assets.spec_dir)
    cv, th = spec["canvas"], spec["theme"]
    prs = Presentation()
    prs.slide_width = Emu(round(cv["width_mm"] * EMU_MM))
    prs.slide_height = Emu(round(cv["height_mm"] * EMU_MM))
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    cp = prs.core_properties
    cp.title = spec.get("name", "figure")
    cp.author = cp.last_modified_by = "Mesa schematic-forge"
    fixed = datetime.datetime(2026, 1, 1)
    cp.created = cp.modified = fixed
    cp.revision = 1

    def emu(mm):
        return Emu(round(mm * EMU_MM))

    def _clear_fills(spPr):
        for tag in ("a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill"):
            for node in spPr.findall(qn(tag)):
                spPr.remove(node)

    def _insert_fill(spPr, fill_el):
        _clear_fills(spPr)
        after_tags = {qn("a:ln"), qn("a:effectLst"), qn("a:effectDag"), qn("a:scene3d"), qn("a:sp3d"), qn("a:extLst")}
        for child in spPr:
            if child.tag in after_tags:
                child.addprevious(fill_el)
                return
        spPr.append(fill_el)

    def set_fill(shape, c):
        if c is None:
            shape.fill.background()
            return
        shape.fill.solid()
        shape.fill.fore_color.rgb = RGBColor.from_string(c[0])
        if c[1] < 1:
            clr = shape.fill._xPr.find(qn("a:solidFill"))[0]
            etree.SubElement(clr, qn("a:alpha")).set("val", str(round(c[1] * 100000)))

    def set_grad_linear(shape, grad):
        c1, c2, angle = grad
        gf = etree.Element(qn("a:gradFill"))
        gf.set("rotWithShape", "1")
        gsl = etree.SubElement(gf, qn("a:gsLst"))
        for pos, col in (("0", c1), ("100000", c2)):
            gs = etree.SubElement(gsl, qn("a:gs"))
            gs.set("pos", pos)
            sc = etree.SubElement(gs, qn("a:srgbClr"))
            sc.set("val", col[0])
            if col[1] < 1:
                etree.SubElement(sc, qn("a:alpha")).set("val", str(round(col[1] * 100000)))
        lin = etree.SubElement(gf, qn("a:lin"))
        lin.set("ang", str(round((angle % 360) * 60000)))
        lin.set("scaled", "1")
        _insert_fill(shape._element.spPr, gf)

    def set_grad_radial(shape, c):
        if c is None:
            shape.fill.background()
            return
        hi, mid, lo = F.radial_stops(c[0])
        gf = etree.Element(qn("a:gradFill"))
        gf.set("rotWithShape", "1")
        gsl = etree.SubElement(gf, qn("a:gsLst"))
        for pos, hexv in (("0", hi), ("48000", mid), ("100000", lo)):
            gs = etree.SubElement(gsl, qn("a:gs"))
            gs.set("pos", pos)
            sc = etree.SubElement(gs, qn("a:srgbClr"))
            sc.set("val", hexv)
            if c[1] < 1:
                etree.SubElement(sc, qn("a:alpha")).set("val", str(round(c[1] * 100000)))
        pth = etree.SubElement(gf, qn("a:path"))
        pth.set("path", "circle")
        rect = etree.SubElement(pth, qn("a:fillToRect"))
        for k, v in (("l", "34000"), ("t", "32000"), ("r", "66000"), ("b", "68000")):
            rect.set(k, v)
        _insert_fill(shape._element.spPr, gf)

    def set_shadow(shape, sh):
        shape.shadow.inherit = False
        if not sh:
            return
        spPr = shape._element.spPr
        for old in spPr.findall(qn("a:effectLst")):
            spPr.remove(old)
        eff = etree.Element(qn("a:effectLst"))
        os_el = etree.SubElement(eff, qn("a:outerShdw"))
        dist = math.hypot(sh["dx"], sh["dy"])
        ang = math.degrees(math.atan2(sh["dy"], sh["dx"])) % 360
        os_el.set("blurRad", str(round(sh["blur"] * EMU_MM)))
        os_el.set("dist", str(round(dist * EMU_MM)))
        os_el.set("dir", str(round(ang * 60000)))
        os_el.set("algn", "tl")
        os_el.set("rotWithShape", "0")
        sc = etree.SubElement(os_el, qn("a:srgbClr"))
        sc.set("val", sh["color"])
        etree.SubElement(sc, qn("a:alpha")).set("val", str(round(sh["opacity"] * 100000)))
        ln = spPr.find(qn("a:ln"))
        if ln is not None:
            ln.addnext(eff)
        else:
            spPr.append(eff)

    def set_line(line, c, pt, dash):
        if c is None or pt <= 0:
            line.fill.background()
            return
        line.color.rgb = RGBColor.from_string(c[0])
        line.width = Pt(pt)
        if c[1] < 1:
            ln = line._get_or_add_ln()
            sf = ln.find(qn("a:solidFill"))
            if sf is not None and len(sf):
                etree.SubElement(sf[0], qn("a:alpha")).set("val", str(round(c[1] * 100000)))
        if dash in ("dash", "dot"):
            ln = line._get_or_add_ln()
            pd = etree.SubElement(ln, qn("a:prstDash"))
            pd.set("val", "dash" if dash == "dash" else "sysDot")

    def set_arrow_heads(ln, head):
        for tag, on in (("a:headEnd", head in ("start", "both")), ("a:tailEnd", head in ("end", "both"))):
            if on:
                e = etree.SubElement(ln, qn(tag))
                e.set("type", "triangle")
                e.set("w", "med")
                e.set("len", "med")

    def add_pptx_path(name, cmds, stroke, pt, dash=None, fill=None, grad=None, head="none"):
        coords = []
        for c in cmds:
            for k in range(1, len(c), 2):
                coords.append((c[k], c[k + 1]))
        xs, ys = [p[0] for p in coords], [p[1] for p in coords]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        w_mm = max(max_x - min_x, 0.2)
        h_mm = max(max_y - min_y, 0.2)
        fb = slide.shapes.build_freeform(emu(min_x), emu(min_y), scale=1.0)
        fb.add_line_segments([(emu(min_x + w_mm), emu(min_y + h_mm))], close=False)
        sp = fb.convert_to_shape()
        sp.name = name
        w_emu, h_emu = max(1, round(w_mm * EMU_MM)), max(1, round(h_mm * EMU_MM))
        sp.left, sp.top, sp.width, sp.height = emu(min_x), emu(min_y), Emu(w_emu), Emu(h_emu)
        path_el = sp._element.find(".//" + qn("a:path"))
        for ch in list(path_el):
            path_el.remove(ch)
        path_el.set("w", str(w_emu))
        path_el.set("h", str(h_emu))

        def rel_pt(parent, px, py):
            pt_el = etree.SubElement(parent, qn("a:pt"))
            pt_el.set("x", str(max(0, round((px - min_x) * EMU_MM))))
            pt_el.set("y", str(max(0, round((py - min_y) * EMU_MM))))

        for c in cmds:
            op = c[0]
            if op == "M":
                rel_pt(etree.SubElement(path_el, qn("a:moveTo")), c[1], c[2])
            elif op == "L":
                rel_pt(etree.SubElement(path_el, qn("a:lnTo")), c[1], c[2])
            elif op == "Q":
                qb = etree.SubElement(path_el, qn("a:quadBezTo"))
                rel_pt(qb, c[1], c[2])
                rel_pt(qb, c[3], c[4])
            elif op == "C":
                cb = etree.SubElement(path_el, qn("a:cubicBezTo"))
                rel_pt(cb, c[1], c[2])
                rel_pt(cb, c[3], c[4])
                rel_pt(cb, c[5], c[6])
            elif op == "Z":
                etree.SubElement(path_el, qn("a:close"))

        if grad:
            set_grad_linear(sp, grad)
        else:
            set_fill(sp, fill)
        set_line(sp.line, stroke, pt, dash)
        if head != "none" and stroke is not None and pt > 0:
            set_arrow_heads(sp.line._get_or_add_ln(), head)
        return sp

    def add_asset_picture(el, eid, slot):
        x, y, w, h = slot
        path, ext = assets.resolve(el)
        png = assets.png_for(el, path, ext, w, h)
        if png is None:
            shp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, emu(x), emu(y), emu(w), emu(h))
            set_fill(shp, ("DDDDDD", 1.0))
            shp.line.fill.background()
            shp.name = eid
            return shp
        from PIL import Image
        iw, ih = Image.open(io.BytesIO(png)).size
        scale = min(w / iw, h / ih)
        pw, ph = iw * scale, ih * scale
        pic = slide.shapes.add_picture(io.BytesIO(png), emu(x + (w - pw) / 2), emu(y + (h - ph) / 2), emu(pw), emu(ph))
        pic.name = eid
        if ext == "svg":
            attach_svg(slide, pic, assets.svg_text(el, path).encode("utf-8"))
        return pic

    bg = F.color(spec, cv.get("background"))
    if bg and bg[0] != "FFFFFF":
        rect = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
        set_fill(rect, bg)
        rect.line.fill.background()
        rect.name = "background"

    def fill_text(tf, lay, extra_top_mm=0.0):
        st = lay["style"]
        tf.word_wrap = True
        tf.auto_size = MSO_AUTO_SIZE.NONE
        tf.margin_left = tf.margin_right = tf.margin_bottom = emu(st.pad)
        tf.margin_top = emu(st.pad + extra_top_mm)
        tf.vertical_anchor = {"top": MSO_ANCHOR.TOP, "middle": MSO_ANCHOR.MIDDLE, "bottom": MSO_ANCHOR.BOTTOM}[st.valign]
        align = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}[st.align]
        para = tf.paragraphs[0]
        first = True
        for li, line in enumerate(lay["lines"]):
            if not first and lay["lines"][li - 1]["hard"]:
                para = tf.add_paragraph()
            elif not first:
                para._p.append(etree.SubElement(para._p, qn("a:br")))
            first = False
            para.alignment = align
            para.line_spacing = Pt(st.pt * F.LINE_GAP)
            para.space_before = para.space_after = Pt(0)
            runs = line["runs"] or [["", "n", st.bold, None, st.pt, 0]]
            for text, kind, bold, face, size, w in runs:
                r = para.add_run()
                r.text = text
                f = r.font
                f.size = Pt(st.pt)
                f.bold = bold
                f.italic = st.italic
                f.color.rgb = RGBColor.from_string(st.color[0])
                rpr = r._r.get_or_add_rPr()
                if kind != "n":
                    rpr.set("baseline", "-25000" if kind == "sub" else "30000")
                if face:
                    fam = face["family"]
                    latin = next((x for x in st.latin if not F.is_cjk(x[:1]) and assets_book.find(x)), fam)
                    cjk = next((x for x in st.cjk if assets_book.find(x)), fam)
                    for tag, val in (("a:latin", latin), ("a:ea", cjk), ("a:cs", latin)):
                        node = rpr.find(qn(tag))
                        if node is None:
                            node = etree.SubElement(rpr, qn(tag))
                        node.set("typeface", val)
        for p in tf.paragraphs:
            end = p._p.get_or_add_endParaRPr()
            end.set("sz", str(round(st.pt * 100)))

    shape_ids = {}
    for el in spec["elements"]:
        t, eid = el["type"], el["id"]
        if t in ("box", "header_card", "hero_panel"):
            x, y, w, h = F.bbox(el)
            default_fill = "panel_bg" if (t in ("header_card", "hero_panel") and "panel_bg" in th["colors"]) else ("#FFFFFF" if t == "header_card" else "none")
            fill = F.color(spec, el.get("fill", default_fill))
            grad = F.gradient_spec(spec, el)
            stroke = F.color(spec, el.get("stroke", "border" if (t == "header_card" and "border" in th["colors"]) else "none"))
            r_mm = float(el.get("radius_mm", 2.2 if t in ("header_card", "hero_panel") else 0))
            kind = MSO_SHAPE.ROUNDED_RECTANGLE if r_mm > 0 else MSO_SHAPE.RECTANGLE
            card = slide.shapes.add_shape(kind, emu(x), emu(y), emu(w), emu(h))
            if grad:
                set_grad_linear(card, grad)
            elif el.get("shading") == "radial" and fill:
                set_grad_radial(card, fill)
            else:
                set_fill(card, fill)
            set_line(card.line, stroke, float(el.get("stroke_pt", th["line_pt"])), el.get("dash"))
            if r_mm > 0:
                card.adjustments[0] = min(0.5, r_mm / min(w, h))
            set_shadow(card, F.shadow_spec(el))
            card.name = eid if t != "hero_panel" else eid + "-card"
            hd = F.header_spec(spec, el)
            top_off = hd["h"] if hd else 0.0
            if eid in layouts:
                fill_text(card.text_frame, layouts[eid], extra_top_mm=top_off)
            else:
                card.text_frame.text = ""
            if hd:
                h_kind = MSO_SHAPE.ROUND_2_SAME_RECTANGLE if r_mm > 0 else MSO_SHAPE.RECTANGLE
                hbar = slide.shapes.add_shape(h_kind, emu(x), emu(y), emu(w), emu(hd["h"]))
                if hd["gradient"]:
                    set_grad_linear(hbar, hd["gradient"])
                else:
                    set_fill(hbar, hd["fill"])
                hbar.line.fill.background()
                if r_mm > 0:
                    hbar.adjustments[0] = min(0.5, r_mm / min(w, hd["h"]))
                hbar.shadow.inherit = False
                hbar.name = eid + "-header"
                if eid + "#header" in layouts:
                    fill_text(hbar.text_frame, layouts[eid + "#header"])
            if t == "hero_panel":
                pic = add_asset_picture(el, eid, F.hero_slot(spec, el))
                shape_ids[eid] = card
            else:
                shape_ids[eid] = card

        elif t in ("ellipse", "sphere"):
            x, y, w, h = F.bbox(el)
            shp = slide.shapes.add_shape(MSO_SHAPE.OVAL, emu(x), emu(y), emu(w), emu(h))
            fill = F.color(spec, el.get("fill", "primary" if t == "sphere" else "none"))
            grad = F.gradient_spec(spec, el)
            shading = el.get("shading", "radial" if t == "sphere" else None)
            if grad:
                set_grad_linear(shp, grad)
            elif shading == "radial" and fill:
                set_grad_radial(shp, fill)
            else:
                set_fill(shp, fill)
            set_line(shp.line, F.color(spec, el.get("stroke", "none")), float(el.get("stroke_pt", th["line_pt"])), el.get("dash"))
            set_shadow(shp, F.shadow_spec(el))
            shp.name = eid
            if eid in layouts:
                fill_text(shp.text_frame, layouts[eid])
            else:
                shp.text_frame.text = ""
            shape_ids[eid] = shp

        elif t == "chevron":
            x, y, w, h = F.bbox(el)
            _, indent, tip = F.chevron_points(el)
            kind = MSO_SHAPE.CHEVRON if indent > 0.05 else MSO_SHAPE.PENTAGON
            shp = slide.shapes.add_shape(kind, emu(x), emu(y), emu(w), emu(h))
            grad = F.gradient_spec(spec, el)
            if grad:
                set_grad_linear(shp, grad)
            else:
                set_fill(shp, F.color(spec, el.get("fill", "primary")))
            set_line(shp.line, F.color(spec, el.get("stroke", "none")), float(el.get("stroke_pt", th["line_pt"])), el.get("dash"))
            set_shadow(shp, F.shadow_spec(el))
            shp.name = eid
            if eid in layouts:
                fill_text(shp.text_frame, layouts[eid])
            shape_ids[eid] = shp

        elif t == "lattice":
            lg = F.lattice_geometry(spec, el)
            for bi, (p1, p2, bcol, bpt) in enumerate(lg["bonds"]):
                add_pptx_path(f"{eid}-bond-{bi}", [("M", p1[0], p1[1]), ("L", p2[0], p2[1])], bcol, bpt)
            for si, (cx, cy, r_a, fc, scol, spt) in enumerate(lg["spheres"]):
                sp = slide.shapes.add_shape(MSO_SHAPE.OVAL, emu(cx - r_a), emu(cy - r_a), emu(2 * r_a), emu(2 * r_a))
                if el.get("shading", "radial") == "radial":
                    set_grad_radial(sp, fc)
                else:
                    set_fill(sp, fc)
                set_line(sp.line, scol, spt, None)
                sp.shadow.inherit = False
                sp.name = f"{eid}-atom-{si}"
            for vi, (cx, cy, r_v, vcol, vdash) in enumerate(lg["rings"]):
                vp = slide.shapes.add_shape(MSO_SHAPE.OVAL, emu(cx - r_v), emu(cy - r_v), emu(2 * r_v), emu(2 * r_v))
                set_fill(vp, (vcol[0], 0.12))
                set_line(vp.line, vcol, 0.75, vdash)
                vp.shadow.inherit = False
                vp.name = f"{eid}-vac-{vi}"

        elif t in {"sci_curve"} | F.SCI_CURVE_KINDS:
            sg = F.sci_curve_geometry(spec, el)
            if el.get("fill") and el.get("fill") not in ("none", "transparent"):
                bx, by, bw, bh = F.bbox(el)
                bg_sp = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, emu(bx), emu(by), emu(bw), emu(bh))
                set_fill(bg_sp, F.color(spec, el["fill"]))
                set_line(bg_sp.line, F.color(spec, el.get("box_stroke", "none")), float(el.get("box_stroke_pt", 0.5)), None)
                bg_sp.shadow.inherit = False
                bg_sp.name = f"{eid}-bg"
            for fi, (cmds, fcol, fgrad) in enumerate(sg["fills"]):
                add_pptx_path(f"{eid}-fill-{fi}", cmds, None, 0, fill=fcol, grad=fgrad)
            for si, (cmds, scol, spt, sdash, shead) in enumerate(sg["strokes"]):
                add_pptx_path(f"{eid}-line-{si}", cmds, scol, spt, dash=sdash, head=shead)
            for di, (mx, my, mr, mc, msh) in enumerate(sg["dots"]):
                dp = slide.shapes.add_shape(MSO_SHAPE.OVAL, emu(mx - mr), emu(my - mr), emu(2 * mr), emu(2 * mr))
                if msh == "radial":
                    set_grad_radial(dp, mc)
                else:
                    set_fill(dp, mc)
                set_line(dp.line, ("FFFFFF", 1.0), 0.4, None)
                dp.shadow.inherit = False
                dp.name = f"{eid}-dot-{di}"
            for sub_id, _, lbox in sg["labels"]:
                lid = f"{eid}#{sub_id}"
                if lid in layouts:
                    lx, ly, lw, lh = lbox
                    tb = slide.shapes.add_textbox(emu(lx), emu(ly), emu(lw), emu(lh))
                    tb.name = f"{eid}-{sub_id}"
                    fill_text(tb.text_frame, layouts[lid])

        elif t == "callout":
            cg = F.callout_geometry(spec, el, index, image_rects)
            lcmds = [("M", cg["pts"][0][0], cg["pts"][0][1])] + [("L", px, py) for px, py in cg["pts"][1:]]
            add_pptx_path(f"{eid}-leader", lcmds, cg["stroke"], cg["stroke_pt"], dash=el.get("dash"))
            tx, ty = cg["target"]
            dr = cg["dot_r_mm"]
            dot = slide.shapes.add_shape(MSO_SHAPE.OVAL, emu(tx - dr), emu(ty - dr), emu(2 * dr), emu(2 * dr))
            set_fill(dot, cg["dot_color"])
            set_line(dot.line, ("FFFFFF", 0.9) if cg["halo"] else None, 0.45 if cg["halo"] else 0, None)
            dot.shadow.inherit = False
            dot.name = f"{eid}-dot"
            bx, by, bw, bh = F.bbox(el)
            if el.get("fill") and el.get("fill") not in ("none", "transparent"):
                tb = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, emu(bx), emu(by), emu(bw), emu(bh))
                set_fill(tb, F.color(spec, el["fill"]))
                set_line(tb.line, F.color(spec, el.get("box_stroke", "none")), 0.45, None)
                tb.shadow.inherit = False
            else:
                tb = slide.shapes.add_textbox(emu(bx), emu(by), emu(bw), emu(bh))
            tb.name = eid
            if eid in layouts:
                fill_text(tb.text_frame, layouts[eid])
            shape_ids[eid] = tb

        elif t == "text":
            x, y, w, h = F.bbox(el)
            shp = slide.shapes.add_textbox(emu(x), emu(y), emu(w), emu(h))
            shp.name = eid
            if eid in layouts:
                fill_text(shp.text_frame, layouts[eid])
            shape_ids[eid] = shp

        elif t in ("image", "figure"):
            pic = add_asset_picture(el, eid, F.bbox(el))
            shape_ids[eid] = pic
            if t == "figure" and el.get("label"):
                lay = layouts[eid + "#label"]
                lx, ly, lw, lh = label_box(el, None)
                tb = slide.shapes.add_textbox(emu(lx), emu(ly), emu(lw), emu(lh))
                tb.name = eid + "-label"
                fill_text(tb.text_frame, lay)

        elif t in F.LINES:
            pts, ctrl, (n1, s1), (n2, s2), branches = line_curve_info(spec, el, index, image_rects)
            stroke = F.color(spec, el.get("stroke", th["text_color"]))
            pt = float(el.get("stroke_pt", th["line_pt"]))
            head = el.get("head", "end" if t in ("arrow", "coupled_arrow") else "none")
            for br in branches:
                bcmds = [("M", br["p1"][0], br["p1"][1]), ("Q", br["ctrl"][0], br["ctrl"][1], br["p2"][0], br["p2"][1])]
                add_pptx_path(f"{eid}-{br['sub_id']}", bcmds, br["stroke"], br["stroke_pt"], dash=br["dash"], head=br["head"])
                blid = f"{eid}#{br['sub_id']}"
                if blid in layouts:
                    lx, ly, lw, lh = br["label_box"]
                    tb = slide.shapes.add_textbox(emu(lx), emu(ly), emu(lw), emu(lh))
                    tb.name = f"{eid}-{br['sub_id']}-label"
                    fill_text(tb.text_frame, layouts[blid])
            if ctrl is not None:
                acmds = [("M", pts[0][0], pts[0][1]), ("Q", ctrl[0], ctrl[1], pts[-1][0], pts[-1][1])]
                add_pptx_path(eid, acmds, stroke, pt, dash=el.get("dash"), head=head)
            elif len(pts) == 2 or (el.get("route") == "elbow" and len(pts) == 4):
                (x1, y1), (x2, y2) = pts[0], pts[-1]
                kind = MSO_CONNECTOR.ELBOW if len(pts) == 4 else MSO_CONNECTOR.STRAIGHT
                cxn = slide.shapes.add_connector(kind, emu(x1), emu(y1), emu(x2), emu(y2))
                cxn.name = eid
                set_line(cxn.line, stroke, pt, el.get("dash"))
                for node, side, tag in ((n1, s1, "a:stCxn"), (n2, s2, "a:endCxn")):
                    target = shape_ids.get(node["id"]) if (node and side) else None
                    if target is None or node["type"] not in ("box", "header_card", "ellipse", "sphere", "text"):
                        continue
                    idx = F.SIDE_IDX["ellipse" if node["type"] in ("ellipse", "sphere") else "rect"][side]
                    cnv = cxn._element.find(qn("p:nvCxnSpPr")).find(qn("p:cNvCxnSpPr"))
                    c = etree.SubElement(cnv, qn(tag))
                    c.set("id", str(target.shape_id))
                    c.set("idx", str(idx))
                set_arrow_heads(cxn.line._get_or_add_ln(), head)
            else:
                fb = slide.shapes.build_freeform(emu(pts[0][0]), emu(pts[0][1]), scale=1.0)
                fb.add_line_segments([(emu(px), emu(py)) for px, py in pts[1:]], close=False)
                cxn = fb.convert_to_shape()
                cxn.name = eid
                cxn.fill.background()
                set_line(cxn.line, stroke, pt, el.get("dash"))
                set_arrow_heads(cxn.line._get_or_add_ln(), head)
            if eid + "#label" in layouts:
                lx, ly, lw, lh = label_box(el, pts, ctrl)
                tb = slide.shapes.add_textbox(emu(lx), emu(ly), emu(lw), emu(lh))
                tb.name = eid + "-label"
                fill_text(tb.text_frame, layouts[eid + "#label"])
    prs.save(out_path)


def attach_svg(slide, pic, svg_bytes):
    """给图片挂 SVG 原件（PowerPoint 2016+ 显示矢量、可「转换为形状」再改；不认的软件用 PNG 后备）"""
    from lxml import etree
    from pptx.opc.constants import RELATIONSHIP_TYPE as RT
    from pptx.opc.package import Part
    from pptx.opc.packuri import PackURI
    from pptx.oxml.ns import qn
    package = slide.part.package
    n = 1
    existing = {str(p.partname) for p in package.iter_parts()}
    while f"/ppt/media/mesa-svg{n}.svg" in existing:
        n += 1
    part = Part(PackURI(f"/ppt/media/mesa-svg{n}.svg"), "image/svg+xml", package, svg_bytes)
    rid = slide.part.relate_to(part, RT.IMAGE)
    blip = pic._element.find(qn("p:blipFill")).find(qn("a:blip"))
    ext_lst = etree.SubElement(blip, qn("a:extLst"))
    ext = etree.SubElement(ext_lst, qn("a:ext"))
    ext.set("uri", SVG_EXT_URI)
    svg_blip = etree.SubElement(ext, "{%s}svgBlip" % NS_ASVG, nsmap={"asvg": NS_ASVG})
    svg_blip.set(qn("r:embed"), rid)


assets_book = None  # PPTX 写字体名时查本机有没有（fill_text 用）


# ---------- 记录与登记 ----------

def rel(p, root):
    try:
        return Path(os.path.relpath(p, root)).as_posix()
    except ValueError:
        return Path(p).as_posix()


def ai_elements(spec):
    out = []
    for el in spec["elements"]:
        src = el.get("source") or {}
        if src.get("kind") == "image-model":
            out.append({"id": el["id"], "model": src.get("model", "?"), "prompt_file": src.get("prompt_file", "")})
    return out


def update_manifest(root, entry):
    path = root / "figures" / "manifest.json"
    data = {"figures": []}
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            raise F.SpecError(f"{path} 不是合法 JSON，先修好再渲染")
    figs = [f for f in data.get("figures", []) if f.get("file") != entry["file"]]
    figs.append(entry)
    data["figures"] = figs
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def edited_outputs(record_path, outputs):
    """上次渲染后被人改过的输出（哈希对不上）"""
    if not record_path.is_file():
        return []
    try:
        rec = json.loads(record_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    old = rec.get("outputs", {})
    edited = []
    for name, p in outputs.items():
        if name in ("svg", "pptx") and p.is_file() and old.get(name) and F.file_digest(p) != old[name]:
            edited.append(p)
    return edited


def render(spec_path, root, formats=("svg", "pptx", "png"), pdf=None, dpi=300, force=False, record=True, quiet=False):
    global assets_book
    spec_path = Path(spec_path)
    spec = F.load_spec(spec_path)
    stem = spec.get("name") or spec_path.parent.name
    if not re.fullmatch(r"[A-Za-z0-9._-]+", stem):
        raise F.SpecError(f"图名 {stem!r} 只能用英文、数字、点、横线、下划线（写在 name 字段）")
    out_dir = spec_path.parent
    outputs = {fmt_: out_dir / f"{stem}.{fmt_}" for fmt_ in formats}
    record_path = out_dir / "render.json"
    if record:
        edited = edited_outputs(record_path, outputs)
        if edited and not force:
            names = "、".join(rel(p, root) for p in edited)
            print(f"✗ {names} 在上次渲染后被人改过。按「人改过的文件为准」，不从图纸重新生成覆盖它。\n"
                  f"  要改这张图：在人改过的那份上局部改（python3 pptx_edit.py …）；用户明说推倒重来才加 --force。", file=sys.stderr)
            return 4, None
    book = F.FontBook()
    assets_book = book
    index = F.load_index(spec)
    raster = Raster()
    assets = Assets(out_dir, raster)
    image_rects = compute_image_rects(spec, out_dir)
    layouts = compute_layouts(spec, book, index, image_rects)
    svg = build_svg(spec, layouts, assets, index, image_rects)
    svg_path = out_dir / f"{stem}.svg"
    tmp_svg = None
    if "svg" in formats:
        svg_path.write_text(svg, encoding="utf-8")
    else:
        tmp_svg = Path(tempfile.mkdtemp(prefix="mesa-fig-")) / f"{stem}.svg"
        tmp_svg.write_text(svg, encoding="utf-8")
    src_svg = tmp_svg or svg_path
    notes = set()
    if "pptx" in formats:
        build_pptx(spec, layouts, assets, index, outputs["pptx"], image_rects)
    made_png = made_pdf = False
    if "png" in formats:
        try:
            made_png = raster.to_png(src_svg, outputs["png"], dpi=dpi)
        except RuntimeError as e:
            notes.add(f"PNG 没出成：{e}")
        if not made_png and not notes:
            notes.add("PNG 没出：没有 MESA_FIGURE_TOOL，也没有 LibreOffice")
    if pdf:
        try:
            made_pdf = raster.to_pdf(src_svg, Path(pdf))
        except RuntimeError as e:
            notes.add(f"PDF 没出成：{e}")
    for lid, lay in layouts.items():
        notes |= lay["notes"]
        if lay["overflow"]:
            notes.add(f"{lid.split('#')[0]} 的文字{'和'.join(lay['overflow'])}度装不下：减字、调字号或放大框（检查脚本会拦下）")
        if lay["missing"]:
            notes.add(f"{lid.split('#')[0]} 有字体里没有的字：{''.join(lay['missing'])}")
    notes |= raster.notes
    notes |= set(assets.notes)
    if record:
        rec = {
            "spec": rel(spec_path, root),
            "spec_sha256": F.spec_digest(spec_path),
            "outputs": {k: F.file_digest(p) for k, p in outputs.items() if p.is_file() and (k != "png" or made_png)},
            "pdf": rel(pdf, root) if made_pdf else None,
            "raster": raster.used,
            "fonts": sorted({f"{r[3]['family']} {r[3]['style']}" for lay in layouts.values() for l in lay["lines"] for r in l["runs"]}),
            "notes": sorted(notes),
            "ai_elements": ai_elements(spec),
            "rendered_at": datetime.datetime.now().isoformat(timespec="seconds"),
        }
        record_path.write_text(json.dumps(rec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        update_manifest(root, {"file": rel(svg_path, root), "spec": rel(spec_path, root), "kind": "schematic",
                               "outputs": [rel(p, root) for k, p in outputs.items() if k != "svg" and p.is_file()]})
    if not quiet:
        for k, p in outputs.items():
            if p.is_file() and (k != "png" or made_png):
                print(f"saved: {p.resolve()}")
        if made_pdf:
            print(f"saved: {Path(pdf).resolve()}")
        for n in sorted(notes):
            print(f"note: {n}")
        ai = ai_elements(spec)
        if ai:
            print(f"note: 含出图模型生成的元素 {len(ai)} 个（{'、'.join(a['id'] for a in ai)}），交付时要写 AI 使用说明")
    shutil.rmtree(assets.tmp, ignore_errors=True)
    return 0, {"svg": svg, "layouts": layouts, "spec": spec, "book": book, "notes": notes}


UNIT_MM = {"mm": 1, "cm": 10, "in": 25.4, "pt": 25.4 / 72, "px": 25.4 / 96, "": 25.4 / 96}


def svg_size_mm(path):
    head = Path(path).read_text(encoding="utf-8", errors="replace")[:4000]
    m = re.search(r"<svg\b[^>]*>", head, re.S)
    if not m:
        raise F.SpecError(f"{path} 不是 SVG")
    tag = m.group(0)
    dims = []
    for k in ("width", "height"):
        v = re.search(rf'\b{k}="([\d.]+)\s*([a-z]*)"', tag)
        if not v:
            vb = re.search(r'viewBox="[\d.\-]+[ ,]+[\d.\-]+[ ,]+([\d.]+)[ ,]+([\d.]+)"', tag)
            if not vb:
                raise F.SpecError(f"{path} 没写宽高也没有 viewBox")
            dims.append(float(vb.group(1 if k == "width" else 2)) * UNIT_MM["px"])
            continue
        dims.append(float(v.group(1)) * UNIT_MM.get(v.group(2), UNIT_MM["px"]))
    return dims


def wrap(svg, root, caption=None):
    """单张图（数据图 SVG / PNG）包成一页：出 figures/<名>-slide/figure.json 并渲染，PPTX 里图挂 SVG 原件、图注是文本框"""
    svg = Path(svg)
    if svg.suffix.lower() == ".svg":
        w, h = svg_size_mm(svg)
    else:
        from PIL import Image
        im = Image.open(svg)
        dpi = (im.info.get("dpi") or (300, 300))[0] or 300
        w, h = im.width / dpi * 25.4, im.height / dpi * 25.4
    m = 3
    out_dir = svg.parent / f"{svg.stem}-slide"
    out_dir.mkdir(parents=True, exist_ok=True)
    els = [{"id": "figure", "type": "figure", "x": m, "y": m, "w": round(w, 2), "h": round(h, 2),
            "src": os.path.relpath(svg, out_dir).replace(os.sep, "/")}]
    H = h + 2 * m
    if caption:
        els.append({"id": "caption", "type": "text", "x": m, "y": h + 2 * m, "w": round(w, 2), "h": 10, "text": caption, "pt": 7})
        H += 11
    spec = {"name": f"{svg.stem}-slide", "canvas": {"width_mm": round(w + 2 * m, 2), "height_mm": round(H, 2), "purpose": "figure-slide", "min_pt": 5},
            "elements": els}
    path = out_dir / "figure.json"
    path.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def main():
    F.utf8_stdio()
    ap = argparse.ArgumentParser(description="示意图图纸 → SVG / PPTX / PNG / PDF")
    ap.add_argument("spec", nargs="?", help="figures/<图名>/figure.json")
    ap.add_argument("--wrap", help="把一张现成的图（SVG / PNG）包成可放进 PPT 的一页")
    ap.add_argument("--caption", help="--wrap 时图下的图注")
    ap.add_argument("--root", default=".", help="项目或工作区根目录（默认当前目录）")
    ap.add_argument("--formats", default="svg,pptx,png")
    ap.add_argument("--pdf", help="投稿副本 PDF 路径（一般 output/figures/<图名>.pdf）")
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--force", action="store_true", help="覆盖人改过的输出（只在用户明说推倒重来时用）")
    ap.add_argument("--no-record", action="store_true", help="构思草案用：不写 render.json、不登记 manifest")
    ap.add_argument("--list-icons", action="store_true", help="列出内置图元")
    a = ap.parse_args()
    if a.list_icons:
        print("\n".join(list_icons()))
        return 0
    if a.wrap:
        try:
            a.spec = str(wrap(a.wrap, Path(a.root).resolve(), a.caption))
        except F.SpecError as e:
            print(f"✗ {e}", file=sys.stderr)
            return 2
        print(f"note: 已写 {a.spec}；图注、尺寸要改就改这份再重跑")
    if not a.spec:
        print("✗ 要给图纸路径（或 --wrap 图片）", file=sys.stderr)
        return 2
    formats = tuple(x.strip() for x in a.formats.split(",") if x.strip())
    bad = [x for x in formats if x not in ("svg", "pptx", "png")]
    if bad:
        print(f"✗ 不认识的格式：{bad}（可用 svg,pptx,png；PDF 用 --pdf）", file=sys.stderr)
        return 2
    try:
        code, _ = render(a.spec, Path(a.root).resolve(), formats, a.pdf, a.dpi, a.force, record=not a.no_record)
        return code
    except F.SpecError as e:
        print(f"✗ 图纸有错：{e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
