"""示意图图纸（figure.json）的公共逻辑：读图纸、顶刊配色、找字体、量字、排版、连线与科研原语几何。

渲染器（render_figure.py）和检查脚本（schematic_check.py）都用这一份排版与几何结果——检查查的就是渲染出来的那个版面。
坐标一律毫米（左上角为原点），字号与线宽用磅（pt）。只依赖标准库与 Pillow。
"""
import hashlib
import json
import math
import os
import random
import re
import sys
import tempfile
from pathlib import Path

MM_PER_PT = 25.4 / 72
LINE_GAP = 1.2  # 行高 = 字号 × 1.2，SVG 与 PPTX 都按这个写死，换软件不变

PURPOSE_MIN_PT = {"journal": 5, "graphical-abstract": 6, "roadmap": 6, "poster": 12, "slide": 14}
DEFAULT_LATIN = ["Arial", "Helvetica", "Liberation Sans", "DejaVu Sans"]
DEFAULT_CJK = ["Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "SimHei", "Arial Unicode MS"]

# 经过验证的 5 套顶刊配色方案（theme.palette 可直接选用，theme.colors 里的同名键可覆盖）
PALETTES = {
    "nature-reviews": {
        "text_color": "#1C2833",
        "colors": {
            "primary": "#1B4F72",
            "accent": "#D35400",
            "secondary": "#2E8B57",
            "tertiary": "#2874A6",
            "highlight": "#B7950B",
            "muted": "#5D6D7E",
            "panel_bg": "#F7F9FA",
            "border": "#D6EAF8",
        },
    },
    "chem-rev-mineral": {
        "text_color": "#1F2A36",
        "colors": {
            "primary": "#2C3E50",
            "accent": "#D4AC0D",
            "secondary": "#7D3C98",
            "tertiary": "#148F77",
            "highlight": "#CA6F1E",
            "muted": "#7F8C8D",
            "panel_bg": "#F8F9F9",
            "border": "#D5D8DC",
        },
    },
    "jacs-vibrant": {
        "text_color": "#17202A",
        "colors": {
            "primary": "#1A5276",
            "accent": "#CB4335",
            "secondary": "#117864",
            "tertiary": "#2E86C1",
            "highlight": "#D68910",
            "muted": "#566573",
            "panel_bg": "#F4F7FA",
            "border": "#D4E6F1",
        },
    },
    "cell-pastel": {
        "text_color": "#24292E",
        "colors": {
            "primary": "#3B5998",
            "accent": "#D96B52",
            "secondary": "#459373",
            "tertiary": "#7E6BC4",
            "highlight": "#C99A2E",
            "muted": "#7A7A7A",
            "panel_bg": "#FAF8F5",
            "border": "#E8E2D9",
        },
    },
    "science-clean": {
        "text_color": "#1B2631",
        "colors": {
            "primary": "#0F3D5E",
            "accent": "#B03A2E",
            "secondary": "#2874A6",
            "tertiary": "#1E8449",
            "highlight": "#9A7D0A",
            "muted": "#616A6B",
            "panel_bg": "#F6F8FA",
            "border": "#D6DBDF",
        },
    },
}

SCI_CURVE_KINDS = {"energy_steps", "volcano_curve", "dos_lobe"}
SHAPES = {
    "box", "header_card", "ellipse", "sphere", "chevron", "polygon", "path",
    "text", "image", "hero_panel", "figure",
    "lattice", "sci_curve", "energy_steps", "volcano_curve", "dos_lobe",
    "callout",
}
LINES = {"arrow", "coupled_arrow", "line", "polyline", "curve", "bezier"}

CLOSING = set("，。、；：？！）》」』】〕…%,.;:?!)]}")


def utf8_stdio():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


class SpecError(Exception):
    pass


# ---------- 图纸 ----------

def load_spec(path):
    path = Path(path)
    try:
        spec = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SpecError(f"找不到图纸：{path}")
    except json.JSONDecodeError as e:
        raise SpecError(f"图纸不是合法 JSON：{path} 第 {e.lineno} 行：{e.msg}")
    canvas = spec.get("canvas") or {}
    for k in ("width_mm", "height_mm"):
        if not isinstance(canvas.get(k), (int, float)) or canvas[k] <= 0:
            raise SpecError(f"canvas.{k} 必须是正数（毫米）")
    canvas.setdefault("purpose", "journal")
    canvas.setdefault("background", "#FFFFFF")
    spec["canvas"] = canvas
    theme = spec.setdefault("theme", {})
    pal_name = theme.get("palette")
    if pal_name:
        if pal_name not in PALETTES:
            raise SpecError(f"theme.palette={pal_name!r} 不认识（可用：{', '.join(PALETTES)}）")
        pal = PALETTES[pal_name]
        theme.setdefault("text_color", pal["text_color"])
        merged = dict(pal["colors"])
        merged.update(theme.get("colors") or {})
        theme["colors"] = merged
    theme.setdefault("font", DEFAULT_LATIN)
    theme.setdefault("font_cjk", DEFAULT_CJK)
    if isinstance(theme["font"], str):
        theme["font"] = [theme["font"]]
    if isinstance(theme["font_cjk"], str):
        theme["font_cjk"] = [theme["font_cjk"]]
    theme.setdefault("base_pt", 7)
    theme.setdefault("line_pt", 0.75)
    theme.setdefault("text_color", "#222222")
    theme.setdefault("colors", {})
    els = spec.get("elements")
    if not isinstance(els, list) or not els:
        raise SpecError("elements 必须是非空列表")
    seen = set()
    for i, el in enumerate(els):
        t = el.get("type")
        if t not in SHAPES | LINES:
            raise SpecError(f"第 {i + 1} 个元素 type={t!r} 不认识（可用：{', '.join(sorted(SHAPES | LINES))}）")
        eid = el.get("id")
        if not eid or not isinstance(eid, str):
            raise SpecError(f"第 {i + 1} 个元素缺 id")
        if eid in seen:
            raise SpecError(f"元素 id 重复：{eid}")
        seen.add(eid)
        if t == "polygon":
            pts = el.get("points")
            if not isinstance(pts, list) or len(pts) < 3 or not all(
                isinstance(p, (list, tuple)) and len(p) == 2 and all(isinstance(v, (int, float)) for v in p)
                for p in pts
            ):
                raise SpecError(f"多边形 {eid} 至少要 3 个 [x, y] 顶点坐标（points）")
            xs = [float(p[0]) for p in pts]
            ys = [float(p[1]) for p in pts]
            el.setdefault("x", min(xs))
            el.setdefault("y", min(ys))
            el.setdefault("w", max(max(xs) - min(xs), 0.2))
            el.setdefault("h", max(max(ys) - min(ys), 0.2))
        elif t == "path":
            d_str = el.get("d")
            if not isinstance(d_str, str) or not d_str.strip():
                raise SpecError(f"路径 {eid} 缺 SVG path d 属性")
            cmds = parse_svg_path_d(d_str, eid)
            spts = path_points(cmds)
            if not spts:
                raise SpecError(f"路径 {eid} 的 d 没有可绘制的坐标")
            xs = [p[0] for p in spts]
            ys = [p[1] for p in spts]
            el.setdefault("x", min(xs))
            el.setdefault("y", min(ys))
            el.setdefault("w", max(max(xs) - min(xs), 0.2))
            el.setdefault("h", max(max(ys) - min(ys), 0.2))
        if t in SHAPES:
            for k in ("x", "y", "w", "h"):
                if not isinstance(el.get(k), (int, float)):
                    raise SpecError(f"元素 {eid} 缺 {k}（毫米）")
            if el["w"] <= 0 or el["h"] <= 0:
                raise SpecError(f"元素 {eid} 的宽高必须是正数")
        if t == "polyline" and len(el.get("points") or []) < 2:
            raise SpecError(f"折线 {eid} 至少要两个 points")
        if t in ("arrow", "coupled_arrow", "line") and ("from" not in el or "to" not in el):
            raise SpecError(f"连线 {eid} 要有 from 和 to")
        if t in ("curve", "bezier"):
            has_ends = "from" in el and "to" in el
            has_pts = isinstance(el.get("points"), list) and len(el["points"]) >= 2
            if not has_ends and not has_pts:
                raise SpecError(f"曲线 {eid} 要有 from/to（配 curve 弧度或 via 控制点）或至少 2 个 points")
        if t == "callout" and "target" not in el:
            raise SpecError(f"引出标注 {eid} 要有 target（目标点 [x, y] 或 hero@锚点名 / [hero_id, nx, ny]）")
        if t == "hero_panel" and not el.get("src"):
            raise SpecError(f"hero_panel {eid} 要有 src（无字主视觉底图路径）")
        if t == "sci_curve" and el.get("kind", "energy_steps") not in SCI_CURVE_KINDS:
            raise SpecError(f"sci_curve {eid} 的 kind={el.get('kind')!r} 不认识（可用：{', '.join(sorted(SCI_CURVE_KINDS))}）")
    return spec


def spec_digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def file_digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def min_pt(spec):
    c = spec["canvas"]
    return c.get("min_pt") or PURPOSE_MIN_PT.get(c["purpose"], 5)


# ---------- 颜色、渐变与对比度 ----------

def _hex(s):
    s = s.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if not re.fullmatch(r"[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", s):
        raise SpecError(f"颜色写法不认识：#{s}")
    return s.upper()


def color(spec, value):
    """'#1F4E79' / 'primary' / 'primary@20'（20% 主色 + 80% 白）/ 'none' → ('1F4E79', alpha) 或 None"""
    if value in (None, "", "none", "transparent"):
        return None
    tint = None
    if isinstance(value, str) and "@" in value and not value.startswith("#"):
        value, pct = value.split("@", 1)
        tint = float(pct) / 100
    elif isinstance(value, str) and "@" in value and value.startswith("#"):
        value, pct = value.split("@", 1)
        tint = float(pct) / 100
    named = spec["theme"]["colors"].get(value) if isinstance(value, str) else None
    if named:
        value = named
    if not isinstance(value, str) or not value.startswith("#"):
        raise SpecError(f"颜色 {value!r} 既不是 #RRGGBB 也不在 theme.colors 里")
    h = _hex(value)
    alpha = int(h[6:], 16) / 255 if len(h) == 8 else 1.0
    rgb = [int(h[i:i + 2], 16) for i in (0, 2, 4)]
    if tint is not None:
        rgb = [round(c * tint + 255 * (1 - tint)) for c in rgb]
    return ("%02X%02X%02X" % tuple(rgb), alpha)


def mix_hex(hex6, target_hex6, ratio):
    """在线性通道上按 ratio (0..1) 把 hex6 混向 target_hex6"""
    a = [int(hex6[i:i + 2], 16) for i in (0, 2, 4)]
    b = [int(target_hex6[i:i + 2], 16) for i in (0, 2, 4)]
    out = [max(0, min(255, round(a[k] * (1 - ratio) + b[k] * ratio))) for k in range(3)]
    return "%02X%02X%02X" % tuple(out)


def radial_stops(hex6):
    """3D 球体径向高光三色阶：(左上高光, 本体色, 右下暗部)"""
    return (mix_hex(hex6, "FFFFFF", 0.76), hex6, mix_hex(hex6, "0B1320", 0.36))


def gradient_spec(spec, el):
    """解析线性渐变：gradient: ['primary@14', '#FFFFFF'] 或 {'from': ..., 'to': ..., 'angle': 90}"""
    g = el.get("gradient")
    if not g:
        return None
    if isinstance(g, (list, tuple)) and len(g) >= 2:
        c1, c2 = color(spec, g[0]), color(spec, g[1])
        angle = 90.0
    elif isinstance(g, dict):
        c1, c2 = color(spec, g.get("from")), color(spec, g.get("to"))
        angle = float(g.get("angle", 90.0))
    else:
        raise SpecError(f"元素 {el.get('id')} 的 gradient 写成 [起色, 止色] 或 {{from, to, angle}}")
    if not c1 or not c2:
        return None
    return (c1, c2, angle)


def shadow_spec(el):
    """解析柔和投影：shadow: true / 'soft' / {dx, dy, blur, opacity, color}"""
    sh = el.get("shadow")
    if not sh and el.get("type") == "header_card":
        sh = "soft"
    if not sh or sh == "none":
        return None
    if isinstance(sh, dict):
        return {
            "dx": float(sh.get("dx", 0.35)),
            "dy": float(sh.get("dy", 0.65)),
            "blur": float(sh.get("blur", 0.95)),
            "opacity": float(sh.get("opacity", 0.12)),
            "color": _hex(sh.get("color", "#0F172A"))[:6],
        }
    return {"dx": 0.35, "dy": 0.65, "blur": 0.95, "opacity": 0.12, "color": "0F172A"}


def header_spec(spec, el):
    """解析胶囊卡片顶部色带：header: {'text': 'Stage I', 'fill': 'primary', 'color': '#FFFFFF', 'h': 6.0}"""
    hd = el.get("header")
    if not hd:
        return None
    if isinstance(hd, str):
        hd = {"text": hd}
    fill = color(spec, hd.get("fill", el.get("stroke") or "primary"))
    txt_col = hd.get("color") or hd.get("text_color")
    if not txt_col:
        txt_col = "#FFFFFF" if (fill and luminance(fill[0]) < 155) else spec["theme"]["text_color"]
    h = float(hd.get("h", max(5.2, float(hd.get("pt", spec["theme"]["base_pt"])) * MM_PER_PT * 1.95)))
    return {
        "text": hd.get("text", ""),
        "fill": fill,
        "gradient": gradient_spec(spec, hd),
        "color": txt_col,
        "h": min(h, el["h"] * 0.6),
        "pt": float(hd.get("pt", spec["theme"]["base_pt"])),
        "bold": bool(hd.get("bold", True)),
        "align": hd.get("align", "center"),
        "pad_mm": float(hd.get("pad_mm", 1.2)),
    }


def luminance(hex6):
    r, g, b = (int(hex6[i:i + 2], 16) for i in (0, 2, 4))
    return 0.299 * r + 0.587 * g + 0.114 * b


def rel_luminance(hex6):
    """WCAG 2.1 相对亮度 (0..1)"""
    vals = []
    for i in (0, 2, 4):
        v = int(hex6[i:i + 2], 16) / 255.0
        vals.append(v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * vals[0] + 0.7152 * vals[1] + 0.0722 * vals[2]


def wcag_contrast(hex_a, hex_b):
    l1, l2 = rel_luminance(hex_a), rel_luminance(hex_b)
    if l1 < l2:
        l1, l2 = l2, l1
    return (l1 + 0.05) / (l2 + 0.05)


def michelson_contrast(lum_a, lum_b):
    """Michelson 对比度 |Imax - Imin| / (Imax + Imin)，输入 0..255 亮度"""
    s = lum_a + lum_b
    return abs(lum_a - lum_b) / s if s > 1e-6 else 0.0


# ---------- 字体 ----------

FONT_DIRS = {
    "darwin": ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", "~/Library/Fonts",
               "/System/Library/AssetsV2"],
    "win32": [os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"),
              os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts")],
    "linux": ["/usr/share/fonts", "/usr/local/share/fonts", "~/.fonts", "~/.local/share/fonts"],
}


class FontBook:
    """系统字体按族名索引（缓存在临时目录），给量字和找粗体用。"""

    def __init__(self, extra_dirs=()):
        from PIL import ImageFont  # noqa: F401  缺 Pillow 早报
        self.extra = [str(Path(d).expanduser()) for d in extra_dirs]
        self.families = self._scan()
        self._fonts = {}
        self._glyph = {}

    def _dirs(self):
        key = "darwin" if sys.platform == "darwin" else "win32" if sys.platform == "win32" else "linux"
        return [str(Path(d).expanduser()) for d in FONT_DIRS[key]] + self.extra

    def _scan(self):
        from PIL import ImageFont
        dirs = [d for d in self._dirs() if os.path.isdir(d)]
        stamp = "|".join(f"{d}:{int(os.path.getmtime(d))}" for d in dirs)
        cache = Path(tempfile.gettempdir()) / "mesa-fontbook-v1.json"
        try:
            data = json.loads(cache.read_text(encoding="utf-8"))
            if data.get("stamp") == stamp:
                return data["families"]
        except Exception:
            pass
        fams = {}
        for d in dirs:
            for root, _, files in os.walk(d):
                for fn in files:
                    if not fn.lower().endswith((".ttf", ".otf", ".ttc", ".otc")):
                        continue
                    p = os.path.join(root, fn)
                    for idx in range(64):
                        try:
                            f = ImageFont.truetype(p, 12, index=idx)
                        except Exception:
                            break
                        fam, style = f.getname()
                        if fam:
                            fams.setdefault(fam.lower(), []).append([p, idx, style or "Regular", fam])
                        if not fn.lower().endswith((".ttc", ".otc")):
                            break
        try:
            cache.write_text(json.dumps({"stamp": stamp, "families": fams}), encoding="utf-8")
        except OSError:
            pass
        return fams

    def find(self, family, bold=False, italic=False):
        faces = self.families.get(family.lower())
        if not faces:
            return None

        def weight(s):
            # 粗细档：0 常规，越大越粗；Hiragino 的 W6 / W8 也算粗体
            for word, w in (("black", 4), ("heavy", 4), ("w8", 4), ("bold", 3), ("w7", 3), ("w6", 3), ("semibold", 2.5), ("medium", 1.5)):
                if word in s:
                    return 3 if word == "bold" and "semibold" not in s and "extra" not in s else w
            return 0

        def score(face):
            s = face[2].lower()
            it = "italic" in s or "oblique" in s
            w = weight(s)
            return abs(w - (3 if bold else 0)) + (0 if it == italic else 1) + (0.2 if "light" in s or "thin" in s else 0)
        p, idx, style, fam = sorted(faces, key=score)[0]
        return {"path": p, "index": idx, "style": style, "family": fam}

    def pick(self, families, bold=False, italic=False):
        for fam in families:
            f = self.find(fam, bold, italic)
            if f:
                return f
        return None

    def pil(self, face):
        from PIL import ImageFont
        key = (face["path"], face["index"])
        if key not in self._fonts:
            self._fonts[key] = ImageFont.truetype(face["path"], 100, index=face["index"])
        return self._fonts[key]

    def width_mm(self, face, text, pt):
        if not text:
            return 0.0
        return self.pil(face).getlength(text) / 100 * pt * MM_PER_PT

    def has_glyph(self, face, ch):
        """缺字检测：与一个必定缺失的码位渲出的 .notdef 方框比，一样就是缺字。"""
        if ch.isspace():
            return True
        key = (face["path"], face["index"], ch)
        if key not in self._glyph:
            f = self.pil(face)
            try:
                a = f.getmask(ch)
                b = f.getmask("\U0010FFFD")
                same = a.size == b.size and bytes(a) == bytes(b)
            except Exception:
                same = False
            self._glyph[key] = not same
        return self._glyph[key]


# ---------- 富文本与排版 ----------

def is_cjk(ch):
    o = ord(ch)
    return (0x2E80 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF or 0x3000 <= o <= 0x303F or 0xFF00 <= o <= 0xFFEF
            or 0x3040 <= o <= 0x30FF or 0xAC00 <= o <= 0xD7AF or 0x20000 <= o <= 0x2FFFF)


BOLD = re.compile(r"\*\*(.+?)\*\*", re.S)
SCRIPT = re.compile(r"_\{(.+?)\}|\^\{(.+?)\}")
OPENING = set("（《「『【〔([{")


def _scripts(s, bold, out):
    pos = 0
    for m in SCRIPT.finditer(s):
        if m.start() > pos:
            out.append((s[pos:m.start()], "n", bold))
        out.append((m.group(1), "sub", bold) if m.group(1) is not None else (m.group(2), "sup", bold))
        pos = m.end()
    if pos < len(s):
        out.append((s[pos:], "n", bold))


def parse_rich(text):
    """'**NiFeB_{0.33}** Al_{2}O_{3}' → 段落列表，每段是 [(文字, 'n'|'sub'|'sup', 粗体)]；粗体里可以套上下标。"""
    paras = []
    for para in str(text).split("\n"):
        runs, pos = [], 0
        for m in BOLD.finditer(para):
            _scripts(para[pos:m.start()], False, runs)
            _scripts(m.group(1), True, runs)
            pos = m.end()
        _scripts(para[pos:], False, runs)
        paras.append([r for r in runs if r[0]])
    return paras


def leftover_markup(text):
    """解析后还留着的标记（写错了的 **、_{、^{），会原样印在图上"""
    return [r[0] for p in parse_rich(text) for r in p if re.search(r"\*\*|_\{|\^\{", r[0])]


def plain_text(text):
    return "".join(r[0] for p in parse_rich(text) for r in p)


SCRIPT_SCALE = 0.65


class TextStyle:
    def __init__(self, spec, el, shape):
        th = spec["theme"]
        self.pt = float(el.get("pt", th["base_pt"]))
        self.bold = bool(el.get("bold", False))
        self.italic = bool(el.get("italic", False))
        self.color = color(spec, el.get("color", th["text_color"]))
        self.align = el.get("align", "center" if shape else "left")
        self.valign = el.get("valign", "middle" if shape else "top")
        self.pad = float(el.get("pad_mm", 1.2 if shape else 0.0))
        latin = el.get("font")
        cjk = el.get("font_cjk")
        self.latin = ([latin] if isinstance(latin, str) else latin or []) + th["font"]
        self.cjk = ([cjk] if isinstance(cjk, str) else cjk or []) + th["font_cjk"]


def _segments(runs, style, book, notes):
    """按字定字体：中日韩字、以及西文字体里没有的字（℃、①、→ 等）用中文字体，其余用西文字体。
    返回 [(文字, kind, 粗体, face, 字号pt)]"""
    res = []
    faces = {}

    def face_for(cjk, b):
        key = (cjk, b)
        if key not in faces:
            fams = style.cjk if cjk else style.latin
            face = book.pick(fams, b, style.italic)
            if face is None:
                face = book.pick(DEFAULT_CJK if cjk else DEFAULT_LATIN, b, style.italic) or book.pick(DEFAULT_CJK + DEFAULT_LATIN)
                notes.add(f"font-fallback {fams[0]}")
            if face is None:
                raise SpecError("本机找不到任何可用字体")
            faces[key] = face
        return faces[key]

    for text, kind, bold in runs:
        b = bold or style.bold
        size = style.pt * (SCRIPT_SCALE if kind != "n" else 1)
        latin, cjk = face_for(False, b), face_for(True, b)
        buf, cur = "", None
        for ch in text:
            if ch.isspace() and cur is not None:
                c = cur
            else:
                c = is_cjk(ch) or (not book.has_glyph(latin, ch) and book.has_glyph(cjk, ch))
            if cur is not None and c != cur:
                res.append((buf, kind, b, cjk if cur else latin, size))
                buf = ""
            buf += ch
            cur = c
        if buf:
            res.append((buf, kind, b, cjk if cur else latin, size))
    return res


PIECE = re.compile(r"[^\s\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF\u3040-\u30FF]+\s*|\s+|.")


def _units(segs):
    """切成不可再分的断行单位（每个单位是几个片段）：中文按字、西文按词；上下标、收尾标点粘前面，开头标点粘后面，
    跨格式的同一个西文词（**NiFeB**_{0.33}**-700**）不拆开。"""
    units = []
    for text, kind, b, face, size in segs:
        for m in PIECE.finditer(text):
            piece = m.group(0)
            seg = [piece, kind, b, face, size]
            if units:
                last = units[-1][-1][0]
                lc, fc = last[-1:], piece[:1]
                glue = (
                    (kind != "n" and not lc.isspace())
                    or fc in CLOSING
                    or lc in OPENING
                    or (lc and not lc.isspace() and not fc.isspace() and not is_cjk(lc) and not is_cjk(fc))
                )
                if glue:
                    units[-1].append(seg)
                    continue
            units.append([seg])
    return units


def layout_text(spec, el, box, book, shape):
    """排一个文字块：返回 {lines:[{runs:[...], width}], line_h, x0, y0, w, h, style, notes, overflow}，单位毫米。"""
    style = TextStyle(spec, el, shape)
    notes = set()
    avail = max(box[2] - 2 * style.pad, 0.1)
    target = avail * 0.96  # 给 PowerPoint / WPS 量字差留 4% 余量
    lines = []
    for runs in parse_rich(el.get("text", "")):
        segs = _segments(runs, style, book, notes)
        cur, cur_w = [], 0.0
        for unit in _units(segs):
            width = sum(book.width_mm(s[3], s[0], s[4]) for s in unit)
            tail = unit[-1]
            trimmed = width - book.width_mm(tail[3], tail[0], tail[4]) + book.width_mm(tail[3], tail[0].rstrip(), tail[4])
            if cur and cur_w + trimmed > target:
                lines.append((cur, False))
                cur, cur_w = [], 0.0
                unit = [list(s) for s in unit]
                unit[0][0] = unit[0][0].lstrip()
                width = sum(book.width_mm(s[3], s[0], s[4]) for s in unit)
            for s in unit:
                if s[0]:
                    cur.append([s[0], s[1], s[2], s[3], s[4], book.width_mm(s[3], s[0], s[4])])
            cur_w += width
        lines.append((cur, True))
    out = []
    for runs, hard in lines:
        # 合并同格式相邻片段，量宽时去掉行尾空格
        merged = []
        for r in runs:
            if merged and all(merged[-1][i] == r[i] for i in (1, 2, 3, 4)):
                merged[-1][0] += r[0]
            else:
                merged.append(list(r))
        if merged:
            merged[-1][0] = merged[-1][0].rstrip()
        for r in merged:
            r[5] = book.width_mm(r[3], r[0], r[4])
        merged = [r for r in merged if r[0]]
        out.append({"runs": merged, "width": sum(r[5] for r in merged), "hard": hard})
    line_h = style.pt * MM_PER_PT * LINE_GAP
    h = line_h * len(out)
    widest = max((l["width"] for l in out), default=0)
    x, y, bw, bh = box
    inner_h = bh - 2 * style.pad
    if style.valign == "middle":
        y0 = y + style.pad + (inner_h - h) / 2
    elif style.valign == "bottom":
        y0 = y + bh - style.pad - h
    else:
        y0 = y + style.pad
    for l in out:
        if style.align == "center":
            l["x"] = x + style.pad + (avail - l["width"]) / 2
        elif style.align == "right":
            l["x"] = x + bw - style.pad - l["width"]
        else:
            l["x"] = x + style.pad
    ink = (min((l["x"] for l in out), default=x), y0, widest, h)
    overflow = []
    if widest > avail + 0.05:
        overflow.append("宽")
    if h > inner_h + 0.05:
        overflow.append("高")
    missing = set()
    for l in out:
        for text, kind, b, face, size, w in l["runs"]:
            for ch in text:
                if not book.has_glyph(face, ch):
                    missing.add(ch)
    # 自动换行换出来的孤行：只剩一个字或只有标点（第一行不算，硬换行的段落不算）
    orphans = []
    for i, l in enumerate(out):
        if i and not out[i - 1]["hard"]:
            s = "".join(r[0] for r in l["runs"]).strip()
            if len(s) <= 1 or all(not ch.isalnum() for ch in s):
                orphans.append(s)
    return {"lines": out, "line_h": line_h, "y0": y0, "ink": ink, "style": style, "notes": notes,
            "overflow": overflow, "missing": sorted(missing), "avail": avail, "orphans": orphans,
            "raw_text": str(el.get("text", ""))}


def baseline(lay, i):
    """第 i 行基线的 y（毫米）：行框顶 + (行高 − 字号)/2 + 0.8 × 字号，与 PPTX 固定行距的视觉位置对齐"""
    pt_mm = lay["style"].pt * MM_PER_PT
    return lay["y0"] + i * lay["line_h"] + (lay["line_h"] - pt_mm) / 2 + 0.8 * pt_mm


# ---------- 几何、Hero 锚点与贝塞尔连线 ----------

def bbox(el):
    return (el["x"], el["y"], el["w"], el["h"])


def rects_overlap(a, b, tol=0.0):
    return a[0] + a[2] - tol > b[0] and b[0] + b[2] - tol > a[0] and a[1] + a[3] - tol > b[1] and b[1] + b[3] - tol > a[1]


def inside(inner, outer, tol=0.05):
    return (inner[0] >= outer[0] - tol and inner[1] >= outer[1] - tol and inner[0] + inner[2] <= outer[0] + outer[2] + tol
            and inner[1] + inner[3] <= outer[1] + outer[3] + tol)


SIDE_IDX = {"rect": {"top": 0, "left": 1, "bottom": 2, "right": 3},
            "ellipse": {"top": 0, "left": 2, "bottom": 4, "right": 6}}


def side_point(el, side):
    x, y, w, h = bbox(el)
    return {"top": (x + w / 2, y), "bottom": (x + w / 2, y + h), "left": (x, y + h / 2), "right": (x + w, y + h / 2)}[side]


def auto_sides(a, b):
    ax, ay, aw, ah = bbox(a)
    bx, by, bw, bh = bbox(b)
    dx = (bx + bw / 2) - (ax + aw / 2)
    dy = (by + bh / 2) - (ay + ah / 2)
    if abs(dx) * (ah + bh) >= abs(dy) * (aw + bw):
        return ("right", "left") if dx >= 0 else ("left", "right")
    return ("bottom", "top") if dy >= 0 else ("top", "bottom")


def hero_slot(spec, el):
    """hero_panel 内主视觉底图的可用槽位 (x, y, w, h)（毫米）"""
    x, y, w, h = bbox(el)
    if el["type"] != "hero_panel":
        return (x, y, w, h)
    hd = header_spec(spec, el)
    top_off = hd["h"] if hd else 0.0
    hb = el.get("hero_box")
    if hb and isinstance(hb, (list, tuple)) and len(hb) == 4:
        if el.get("hero_rel"):
            return (x + hb[0] * w, y + top_off + hb[1] * (h - top_off), hb[2] * w, hb[3] * (h - top_off))
        return tuple(float(v) for v in hb)
    mg = el.get("hero_margin_mm", el.get("hero_pad_mm", 2.0))
    if isinstance(mg, (int, float)):
        ml = mt = mr = mb = float(mg)
    elif isinstance(mg, (list, tuple)) and len(mg) == 4:
        ml, mt, mr, mb = (float(v) for v in mg)
    else:
        ml = mt = mr = mb = 2.0
    return (x + ml, y + top_off + mt, max(1.0, w - ml - mr), max(1.0, h - top_off - mt - mb))


def fitted_rect(slot, img_size=None):
    """按 preserveAspectRatio='xMidYMid meet' 算出图片实际落下的毫米矩形 (fx, fy, fw, fh)"""
    sx, sy, sw, sh = slot
    if not img_size or img_size[0] <= 0 or img_size[1] <= 0:
        return (sx, sy, sw, sh)
    iw, ih = img_size
    scale = min(sw / iw, sh / ih)
    fw, fh = iw * scale, ih * scale
    return (sx + (sw - fw) / 2, sy + (sh - fh) / 2, fw, fh)


def resolve_anchor(ref, index, image_rects=None, label_owner=""):
    """解析坐标或锚点引用：
      - [x, y] → 直接毫米坐标
      - ['hero1', nx, ny] → hero1 图像实际矩形上的归一化坐标 (0..1)
      - 'hero1@mo_site' → hero1.anchors.mo_site 定义的归一化坐标
      - 'box1' → 返回 (None, node, None) 供边连接决定
    """
    image_rects = image_rects or {}
    if isinstance(ref, (list, tuple)):
        if len(ref) == 2 and all(isinstance(v, (int, float)) for v in ref):
            return ((float(ref[0]), float(ref[1])), None, None)
        if len(ref) == 3 and isinstance(ref[0], str) and all(isinstance(v, (int, float)) for v in ref[1:]):
            hid, nx, ny = ref[0], float(ref[1]), float(ref[2])
            if hid not in index:
                raise SpecError(f"{label_owner} 引用的图像元素 {hid!r} 不存在")
            fx, fy, fw, fh = image_rects.get(hid) or bbox(index[hid])
            return ((fx + nx * fw, fy + ny * fh), index[hid], None)
        raise SpecError(f"{label_owner} 的坐标写法不认识：{ref!r}（用 [x, y] 或 [hero_id, nx, ny]）")
    if isinstance(ref, str):
        if "@" in ref:
            hid, aname = ref.split("@", 1)
            if hid not in index:
                raise SpecError(f"{label_owner} 引用的元素 {hid!r} 不存在")
            anchors = index[hid].get("anchors") or {}
            if aname not in anchors:
                raise SpecError(f"{label_owner} 引用的锚点 {ref!r} 未在 {hid}.anchors 中定义")
            nx, ny = anchors[aname]
            fx, fy, fw, fh = image_rects.get(hid) or bbox(index[hid])
            return ((fx + float(nx) * fw, fy + float(ny) * fh), index[hid], None)
        if ref not in index:
            raise SpecError(f"{label_owner} 的引用 {ref!r} 不是任何元素的 id")
        return (None, index[ref], None)
    raise SpecError(f"{label_owner} 的端点 {ref!r} 要么是元素 id / hero@锚点，要么是 [x, y] / [hero_id, nx, ny]")


def endpoints(el, index, image_rects=None):
    """连线两端：[(x,y), 连到的元素或 None, 边名或 None] × 2"""
    eid = f"连线 {el['id']}"
    p_a, a, _ = resolve_anchor(el["from"], index, image_rects, f"{eid} 的 from")
    p_b, b, _ = resolve_anchor(el["to"], index, image_rects, f"{eid} 的 to")
    sa, sb = (el.get("from_side"), el.get("to_side"))
    # 若任一端已是锚点精确坐标，另一端按朝向该坐标选边
    if p_a is None and p_b is None and a and b and (not sa or not sb):
        auto = auto_sides(a, b)
        sa, sb = sa or auto[0], sb or auto[1]
    ends = []
    for key, pt, node, side, other_pt, other_node in (
        ("from", p_a, a, sa, p_b, b),
        ("to", p_b, b, sb, p_a, a),
    ):
        if pt is not None:
            ends.append((pt, node, None))
        else:
            if not side:
                if other_pt is not None:
                    fake = {"x": other_pt[0], "y": other_pt[1], "w": 0.01, "h": 0.01}
                    side = auto_sides(node, fake)[0]
                elif other_node is not None:
                    side = auto_sides(node, other_node)[0]
                else:
                    side = "right"
            ends.append((side_point(node, side), node, side))
    return ends


def elbow_points(p1, p2, s1, s2):
    """直角折线（左右边进出走横—竖—横；上下边进出走竖—横—竖）"""
    if s1 in ("left", "right") and s2 in ("left", "right"):
        xm = (p1[0] + p2[0]) / 2
        return [p1, (xm, p1[1]), (xm, p2[1]), p2]
    if s1 in ("top", "bottom") and s2 in ("top", "bottom"):
        ym = (p1[1] + p2[1]) / 2
        return [p1, (p1[0], ym), (p2[0], ym), p2]
    return None


def quad_ctrl(p1, p2, bend=0.0, via=None):
    """二次贝塞尔控制点：bend 正数向上/左拱起，负数向下/右弯曲；via 可直接指定控制点 [cx, cy]"""
    if via and isinstance(via, (list, tuple)) and len(via) == 2:
        return (float(via[0]), float(via[1]))
    bend = float(bend or 0.0)
    if abs(bend) < 1e-6:
        return None
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    L = math.hypot(dx, dy)
    if L < 1e-6:
        return None
    ux, uy = dy / L, -dx / L
    # 屏幕坐标系（+x 向右，+y 向下）下固定正号朝上 (uy < 0) 或纯竖线朝左 (ux < 0)
    if uy > 1e-6 or (abs(uy) <= 1e-6 and ux > 0):
        ux, uy = -ux, -uy
    mx, my = (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2
    return (mx + ux * bend * L * 1.6, my + uy * bend * L * 1.6)


def quad_eval(p1, ctrl, p2, t):
    """二次贝塞尔曲线在 t (0..1) 处的 (点, 单位切向量, 朝上/左的单位法向量)"""
    u = 1.0 - t
    x = u * u * p1[0] + 2 * u * t * ctrl[0] + t * t * p2[0]
    y = u * u * p1[1] + 2 * u * t * ctrl[1] + t * t * p2[1]
    tx = 2 * u * (ctrl[0] - p1[0]) + 2 * t * (p2[0] - ctrl[0])
    ty = 2 * u * (ctrl[1] - p1[1]) + 2 * t * (p2[1] - ctrl[1])
    tl = math.hypot(tx, ty) or 1.0
    tx, ty = tx / tl, ty / tl
    nx, ny = ty, -tx
    if ny > 1e-6 or (abs(ny) <= 1e-6 and nx > 0):
        nx, ny = -nx, -ny
    return (x, y), (tx, ty), (nx, ny)


def quad_points(p1, ctrl, p2, steps=24):
    return [quad_eval(p1, ctrl, p2, i / steps)[0] for i in range(steps + 1)]


def coupled_branches(spec, el, p1, ctrl, p2):
    """反应耦合分叉箭头：主箭头上顺滑汇入反应物（coupled_in）或分叉流出副产物（coupled_out）"""
    c_mid = ctrl if ctrl is not None else ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
    branches = []
    for kind, key, t_def in (("in", "coupled_in", 0.36), ("out", "coupled_out", 0.64)):
        raw_list = el.get(key) or []
        if isinstance(raw_list, (str, dict)):
            raw_list = [raw_list]
        for idx, item in enumerate(raw_list):
            if isinstance(item, str):
                item = {"label": item}
            t = float(item.get("t", t_def))
            anchor, (tx, ty), (nx, ny) = quad_eval(p1, c_mid, p2, t)
            side = item.get("side", "top" if kind == "in" else "bottom")
            sign = -1.0 if side in ("bottom", "right", -1, "-1") else 1.0
            sx_n, sy_n = nx * sign, ny * sign
            span = float(item.get("span_mm", 7.5))
            off = float(item.get("offset_mm", 6.8))
            if kind == "in":
                p_start = (anchor[0] - tx * span + sx_n * off, anchor[1] - ty * span + sy_n * off)
                b_ctrl = (anchor[0] - tx * span * 0.42, anchor[1] - ty * span * 0.42)
                p_end = anchor
                tip = p_start
            else:
                p_start = anchor
                b_ctrl = (anchor[0] + tx * span * 0.42, anchor[1] + ty * span * 0.42)
                p_end = (anchor[0] + tx * span + sx_n * off, anchor[1] + ty * span + sy_n * off)
                tip = p_end
            lw = float(item.get("label_w", 22.0))
            lh = float(item.get("label_h", 5.2))
            # 标签贴在分叉外端外侧
            lx = tip[0] - lw / 2 + (0 if abs(sx_n) < 0.35 else sx_n * (lw * 0.36))
            ly = tip[1] - lh - 0.6 if sy_n < -0.2 else (tip[1] + 0.6 if sy_n > 0.2 else tip[1] - lh / 2)
            branches.append({
                "sub_id": f"{key}_{idx}",
                "kind": kind,
                "p1": p_start,
                "ctrl": b_ctrl,
                "p2": p_end,
                "pts": quad_points(p_start, b_ctrl, p_end, 14),
                "head": item.get("head", "none" if kind == "in" else "end"),
                "stroke": color(spec, item.get("stroke", el.get("stroke", spec["theme"]["text_color"]))),
                "stroke_pt": float(item.get("stroke_pt", float(el.get("stroke_pt", spec["theme"]["line_pt"])) * 0.9)),
                "dash": item.get("dash"),
                "label": item.get("label", ""),
                "label_pt": float(item.get("pt", float(el.get("label_pt", spec["theme"]["base_pt"])) * 0.92)),
                "label_color": item.get("color", el.get("label_color", spec["theme"]["text_color"])),
                "label_box": (lx, ly, lw, lh),
            })
    return branches


# ---------- 样条与科学函数曲线（sci_curve） ----------

def catmull_rom_beziers(pts, tension=0.5):
    """点列 → 三次贝塞尔路径指令 [('M', x, y), ('C', c1x, c1y, c2x, c2y, x2, y2), ...]"""
    if len(pts) < 2:
        return []
    if len(pts) == 2:
        return [("M", pts[0][0], pts[0][1]), ("L", pts[1][0], pts[1][1])]
    ext = [pts[0]] + list(pts) + [pts[-1]]
    cmds = [("M", pts[0][0], pts[0][1])]
    alpha = tension / 3.0
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        c1 = (p1[0] + (p2[0] - p0[0]) * alpha, p1[1] + (p2[1] - p0[1]) * alpha)
        c2 = (p2[0] - (p3[0] - p1[0]) * alpha, p2[1] - (p3[1] - p1[1]) * alpha)
        cmds.append(("C", c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]))
    return cmds


def _arc_to_cubics(x1, y1, rx, ry, phi_deg, fa, fs, x2, y2):
    """标准 SVG 椭圆弧 (A/a) → 1..4 段三次贝塞尔 ('C', c1x, c1y, c2x, c2y, px, py)，供 PPTX Freeform 精确编辑"""
    if abs(x1 - x2) < 1e-7 and abs(y1 - y2) < 1e-7:
        return []
    rx, ry = abs(float(rx)), abs(float(ry))
    if rx < 1e-7 or ry < 1e-7:
        return [("L", x2, y2)]
    phi = math.radians(float(phi_deg) % 360.0)
    cos_p, sin_p = math.cos(phi), math.sin(phi)
    dx2, dy2 = (x1 - x2) / 2.0, (y1 - y2) / 2.0
    x1p = cos_p * dx2 + sin_p * dy2
    y1p = -sin_p * dx2 + cos_p * dy2
    lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lam > 1.0:
        s = math.sqrt(lam)
        rx *= s
        ry *= s
    num = max(0.0, rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p)
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    coef = math.sqrt(num / den) if den > 1e-12 else 0.0
    if bool(fa) == bool(fs):
        coef = -coef
    cxp = coef * (rx * y1p / ry)
    cyp = coef * (-ry * x1p / rx)
    cx = cos_p * cxp - sin_p * cyp + (x1 + x2) / 2.0
    cy = sin_p * cxp + cos_p * cyp + (y1 + y2) / 2.0

    def vec_ang(ux, uy, vx, vy):
        n = math.hypot(ux, uy) * math.hypot(vx, vy)
        ang = math.acos(max(-1.0, min(1.0, (ux * vx + uy * vy) / max(n, 1e-12))))
        return -ang if (ux * vy - uy * vx) < 0 else ang

    theta1 = vec_ang(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dtheta = vec_ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not fs and dtheta > 0:
        dtheta -= 2 * math.pi
    elif fs and dtheta < 0:
        dtheta += 2 * math.pi

    segs = max(1, int(math.ceil(abs(dtheta) / (math.pi / 2.0))))
    delta = dtheta / segs
    alpha = (4.0 / 3.0) * math.tan(delta / 4.0)

    def map_pt(ux, uy):
        return (cx + rx * cos_p * ux - ry * sin_p * uy, cy + rx * sin_p * ux + ry * cos_p * uy)

    out = []
    for k in range(segs):
        t1 = theta1 + k * delta
        t2 = t1 + delta
        c1 = map_pt(math.cos(t1) - alpha * math.sin(t1), math.sin(t1) + alpha * math.cos(t1))
        c2 = map_pt(math.cos(t2) + alpha * math.sin(t2), math.sin(t2) - alpha * math.cos(t2))
        p2 = map_pt(math.cos(t2), math.sin(t2))
        out.append(("C", c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]))
    return out


_SVG_NUM_RE = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
_SVG_ARITY = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7, "Z": 0}


def parse_svg_path_d(d_str, eid=""):
    """解析标准 SVG path d 字符串（M/L/H/V/C/S/Q/T/A/Z 大小写绝对/相对坐标，毫米）为规范指令列表"""
    s = str(d_str or "").strip()
    if not s:
        raise SpecError(f"路径 {eid} 的 d 不能为空")
    n = len(s)
    pos = 0
    cmds = []
    cx = cy = sx = sy = 0.0
    last_op = ""
    last_ctrl = None

    def skip_sep(i):
        while i < n and (s[i].isspace() or s[i] == ","):
            i += 1
        return i

    def read_num(i):
        i = skip_sep(i)
        m = _SVG_NUM_RE.match(s, i)
        if not m:
            raise SpecError(f"路径 {eid} 的 d 在位置 {i} 处缺少数字：{s[max(0, i - 6):i + 12]!r}")
        return float(m.group(0)), m.end()

    def read_flag(i):
        i = skip_sep(i)
        if i >= n or s[i] not in "01":
            raise SpecError(f"路径 {eid} 的圆弧 A 参数在位置 {i} 处缺少 0/1 标志位")
        return int(s[i]), i + 1

    pos = skip_sep(pos)
    cur_cmd = None
    while pos < n:
        if s[pos].isalpha():
            cur_cmd = s[pos]
            if cur_cmd.upper() not in _SVG_ARITY:
                raise SpecError(f"路径 {eid} 的 d 含不支持的指令 {cur_cmd!r}")
            pos = skip_sep(pos + 1)
            if cur_cmd in ("Z", "z"):
                cmds.append(("Z",))
                cx, cy = sx, sy
                last_op, last_ctrl = cur_cmd, None
                continue
        elif cur_cmd is None:
            raise SpecError(f"路径 {eid} 的 d 必须以 M/m 开头")

        up = cur_cmd.upper()
        rel = cur_cmd.islower()
        arity = _SVG_ARITY[up]
        if up == "A":
            rx, pos = read_num(pos)
            ry, pos = read_num(pos)
            rot, pos = read_num(pos)
            fa, pos = read_flag(pos)
            fs, pos = read_flag(pos)
            x, pos = read_num(pos)
            y, pos = read_num(pos)
            nx, ny = (cx + x, cy + y) if rel else (x, y)
            cmds.extend(_arc_to_cubics(cx, cy, rx, ry, rot, fa, fs, nx, ny))
            cx, cy = nx, ny
            last_op, last_ctrl = cur_cmd, None
        else:
            vals = []
            for _ in range(arity):
                v, pos = read_num(pos)
                vals.append(v)
            if up == "M":
                nx, ny = (cx + vals[0], cy + vals[1]) if rel else (vals[0], vals[1])
                cmds.append(("M", nx, ny))
                cx, cy = sx, sy = nx, ny
                last_op, last_ctrl = cur_cmd, None
                cur_cmd = "l" if rel else "L"
            elif up == "L":
                nx, ny = (cx + vals[0], cy + vals[1]) if rel else (vals[0], vals[1])
                cmds.append(("L", nx, ny))
                cx, cy = nx, ny
                last_op, last_ctrl = cur_cmd, None
            elif up == "H":
                nx = cx + vals[0] if rel else vals[0]
                cmds.append(("L", nx, cy))
                cx = nx
                last_op, last_ctrl = cur_cmd, None
            elif up == "V":
                ny = cy + vals[0] if rel else vals[0]
                cmds.append(("L", cx, ny))
                cy = ny
                last_op, last_ctrl = cur_cmd, None
            elif up == "C":
                c1x = cx + vals[0] if rel else vals[0]
                c1y = cy + vals[1] if rel else vals[1]
                c2x = cx + vals[2] if rel else vals[2]
                c2y = cy + vals[3] if rel else vals[3]
                nx = cx + vals[4] if rel else vals[4]
                ny = cy + vals[5] if rel else vals[5]
                cmds.append(("C", c1x, c1y, c2x, c2y, nx, ny))
                cx, cy = nx, ny
                last_op, last_ctrl = cur_cmd, (c2x, c2y)
            elif up == "S":
                if last_op in ("C", "c", "S", "s") and last_ctrl is not None:
                    c1x, c1y = 2 * cx - last_ctrl[0], 2 * cy - last_ctrl[1]
                else:
                    c1x, c1y = cx, cy
                c2x = cx + vals[0] if rel else vals[0]
                c2y = cy + vals[1] if rel else vals[1]
                nx = cx + vals[2] if rel else vals[2]
                ny = cy + vals[3] if rel else vals[3]
                cmds.append(("C", c1x, c1y, c2x, c2y, nx, ny))
                cx, cy = nx, ny
                last_op, last_ctrl = cur_cmd, (c2x, c2y)
            elif up == "Q":
                qx = cx + vals[0] if rel else vals[0]
                qy = cy + vals[1] if rel else vals[1]
                nx = cx + vals[2] if rel else vals[2]
                ny = cy + vals[3] if rel else vals[3]
                cmds.append(("Q", qx, qy, nx, ny))
                cx, cy = nx, ny
                last_op, last_ctrl = cur_cmd, (qx, qy)
            elif up == "T":
                if last_op in ("Q", "q", "T", "t") and last_ctrl is not None:
                    qx, qy = 2 * cx - last_ctrl[0], 2 * cy - last_ctrl[1]
                else:
                    qx, qy = cx, cy
                nx = cx + vals[0] if rel else vals[0]
                ny = cy + vals[1] if rel else vals[1]
                cmds.append(("Q", qx, qy, nx, ny))
                cx, cy = nx, ny
                last_op, last_ctrl = cur_cmd, (qx, qy)
        pos = skip_sep(pos)
    return cmds


def path_points(cmds, steps=12):
    """把 M/L/Q/C/Z 路径采样成折线点列（供边界与碰撞核查）"""
    pts = []
    cur = (0.0, 0.0)
    sub_start = (0.0, 0.0)
    for c in cmds:
        op = c[0]
        if op == "M":
            cur = sub_start = (c[1], c[2])
            pts.append(cur)
        elif op == "L":
            cur = (c[1], c[2])
            pts.append(cur)
        elif op == "Q":
            p1, ctrl, p2 = cur, (c[1], c[2]), (c[3], c[4])
            pts.extend(quad_points(p1, ctrl, p2, steps)[1:])
            cur = p2
        elif op == "C":
            p0, c1, c2, p3 = cur, (c[1], c[2]), (c[3], c[4]), (c[5], c[6])
            for k in range(1, steps + 1):
                t = k / steps
                u = 1 - t
                px = u**3 * p0[0] + 3 * u**2 * t * c1[0] + 3 * u * t**2 * c2[0] + t**3 * p3[0]
                py = u**3 * p0[1] + 3 * u**2 * t * c1[1] + 3 * u * t**2 * c2[1] + t**3 * p3[1]
                pts.append((px, py))
            cur = p3
        elif op == "Z":
            if cur != sub_start:
                pts.append(sub_start)
            cur = sub_start
    return pts


def sci_curve_geometry(spec, el):
    """生成参数化科学曲线（energy_steps / volcano_curve / dos_lobe）的矢量路径、圆点与真文字框"""
    kind = el["type"] if el["type"] in SCI_CURVE_KINDS else el.get("kind", "energy_steps")
    th = spec["theme"]
    x, y, w, h = bbox(el)
    axes = el.get("axes")
    show_axes = axes is not False
    axes = dict(axes) if isinstance(axes, dict) else {}
    if not axes.get("xlabel") and el.get("xlabel"):
        axes["xlabel"] = el["xlabel"]
    if not axes.get("ylabel") and el.get("ylabel"):
        axes["ylabel"] = el["ylabel"]
    pad_l = float(el.get("pad_left_mm", 4.5 if show_axes else 2.0))
    pad_r = float(el.get("pad_right_mm", 3.0))
    pad_t = float(el.get("pad_top_mm", 4.8 if (el.get("title") or axes.get("ylabel")) else 2.8))
    both_bottom = bool(axes.get("xlabel")) and bool(el.get("step_labels"))
    pad_b = float(el.get("pad_bottom_mm", 9.6 if both_bottom else (5.8 if (axes.get("xlabel") or el.get("step_labels")) else (3.5 if show_axes else 2.0))))
    px, py = x + pad_l, y + pad_t
    pw, ph = max(4.0, w - pad_l - pad_r), max(4.0, h - pad_t - pad_b)

    fills, strokes, dots, labels = [], [], [], []
    axis_col = color(spec, axes.get("color", "muted" if "muted" in th["colors"] else "#666666")) or ("666666", 1.0)
    axis_pt = float(axes.get("stroke_pt", max(0.55, th["line_pt"] * 0.85)))
    sci_pt_floor = max(min_pt(spec), round(min_pt(spec) * 0.75 / SCRIPT_SCALE + 0.05, 1))
    base_pt = float(el.get("pt", max(sci_pt_floor, th["base_pt"] * 0.96)))

    if el.get("title"):
        labels.append(("title", {"text": el["title"], "pt": float(el.get("title_pt", base_pt + 0.5)), "bold": True,
                                 "align": "center", "valign": "top", "color": el.get("title_color", th["text_color"])},
                       (x + 1, y + 0.4, w - 2, pad_t + 1.5)))
    if show_axes:
        # 坐标轴 L 形框（带微小箭头）
        strokes.append(([("M", px, py + ph), ("L", px, py)], axis_col, axis_pt, None, "end"))
        strokes.append(([("M", px, py + ph), ("L", px + pw, py + ph)], axis_col, axis_pt, None, "end"))
        if axes.get("xlabel"):
            labels.append(("xlabel", {"text": axes["xlabel"], "pt": base_pt, "align": "center", "valign": "bottom",
                                      "color": axes.get("label_color", th["text_color"])},
                           (px, y + h - 4.3, pw, 4.2)))
        if axes.get("ylabel"):
            labels.append(("ylabel", {"text": axes["ylabel"], "pt": base_pt, "align": "left", "valign": "top",
                                      "color": axes.get("label_color", th["text_color"])},
                           (x + 1.2, y + 0.2, min(28.0, w * 0.55), 4.2)))

    if kind == "energy_steps":
        series = el.get("series")
        if not series:
            series = [{
                "name": el.get("legend", ""),
                "levels": el.get("levels") or [0.0, 0.25, -0.15, 0.0],
                "stroke": el.get("stroke", "primary"),
                "dash": el.get("dash"),
                "style": el.get("style", "step"),
                "ts": el.get("ts"),
            }]
        all_vals = []
        for s in series:
            lv = [float(v) for v in (s.get("levels") or [])]
            if len(lv) < 2:
                raise SpecError(f"energy_steps {el['id']} 每条曲线至少要 2 个能级 levels")
            all_vals.extend(lv)
            ts_d = s.get("ts") if s.get("ts") is not None else s.get("ts_peaks")
            for tv in (ts_d or {}).values() if isinstance(ts_d, dict) else (ts_d or []):
                if tv is not None:
                    all_vals.append(float(tv))
        vmin, vmax = min(all_vals), max(all_vals)
        span = max(vmax - vmin, 0.2)
        vmin -= span * 0.18
        vmax += span * 0.24

        def y_of(val):
            return py + ph - (val - vmin) / (vmax - vmin) * ph

        if el.get("zero_line", vmin < 0 < vmax):
            yz = y_of(0.0)
            strokes.append(([("M", px, yz), ("L", px + pw, yz)], (axis_col[0], 0.35), axis_pt * 0.75, "dot", "none"))

        n_steps = max(len(s.get("levels") or []) for s in series)
        slot_w = pw / n_steps
        plat_ratio = float(el.get("plateau_ratio", 0.56))
        plat_w = slot_w * plat_ratio

        # 可选阴影能垒高亮带 barrier: {"series": 0, "step": 0, "label"/"text": "ΔG = 0.13 eV", "fill": "accent@16"}
        barrier = el.get("barrier")
        if isinstance(barrier, dict):
            si = int(barrier.get("series", 0))
            st_i = int(barrier.get("step", 0))
            if 0 <= si < len(series):
                lv = [float(v) for v in series[si]["levels"]]
                ts_map = series[si].get("ts") or series[si].get("ts_peaks") or {}
                has_mid_ts = isinstance(ts_map, dict) and (str(st_i) in ts_map or st_i in ts_map)
                if st_i >= len(lv) - 1 and st_i > 0:
                    v0, v1 = lv[st_i - 1], lv[st_i]
                    peak_idx = st_i if v1 >= v0 else st_i - 1
                else:
                    v0 = lv[min(st_i, len(lv) - 1)]
                    v1 = float(ts_map.get(str(st_i), ts_map.get(st_i))) if has_mid_ts else lv[min(st_i + 1, len(lv) - 1)]
                    peak_idx = min(st_i + 1, len(lv) - 1) if v1 >= v0 else st_i
                if has_mid_ts:
                    bx0 = px + st_i * slot_w + (slot_w + plat_w) / 2
                    bx1 = px + (st_i + 1) * slot_w + (slot_w - plat_w) / 2
                else:
                    bx0 = px + peak_idx * slot_w + (slot_w - plat_w) / 2
                    bx1 = bx0 + plat_w
                by0, by1 = min(y_of(v0), y_of(v1)), max(y_of(v0), y_of(v1))
                bfill = color(spec, barrier.get("fill", "accent@16"))
                if bfill and by1 - by0 > 0.4:
                    fills.append(([("M", bx0, by0), ("L", bx1, by0), ("L", bx1, by1), ("L", bx0, by1), ("Z",)], bfill, None))
                b_txt = barrier.get("label") or barrier.get("text")
                if b_txt:
                    bw_lbl = float(barrier.get("label_w", 26.0))
                    s_col_name = series[si].get("stroke") or series[si].get("color") or "accent"
                    cx_lbl = (bx0 + bx1) / 2
                    labels.append(("barrier", {"text": b_txt, "pt": max(sci_pt_floor, base_pt - 0.1), "bold": True,
                                               "align": "center", "valign": "bottom",
                                               "color": barrier.get("color", s_col_name)},
                                   (cx_lbl - bw_lbl / 2, max(y + 0.5, by0 - 4.3), bw_lbl, 4.2)))

        for si, s in enumerate(series):
            lv = [float(v) for v in s["levels"]]
            s_stroke = s.get("stroke") or s.get("color") or "primary"
            scol = color(spec, s_stroke) or ("1B4F72", 1.0)
            spt = float(s.get("stroke_pt", th["line_pt"] * 1.35))
            ts_raw = s.get("ts") if s.get("ts") is not None else s.get("ts_peaks")
            smooth_mode = s.get("style") == "ts" or bool(el.get("smooth_ts")) or bool(s.get("smooth_ts"))
            use_ts = smooth_mode or bool(ts_raw)
            seg_pts = []
            for i, val in enumerate(lv):
                sx0 = px + i * slot_w + (slot_w - plat_w) / 2
                sx1 = sx0 + plat_w
                sy = y_of(val)
                seg_pts.append((sx0, sx1, sy, val))
                strokes.append(([("M", sx0, sy), ("L", sx1, sy)], scol, spt * 1.25, None, "none"))
            for i in range(len(seg_pts) - 1):
                _, x0_end, y0_v, v0 = seg_pts[i]
                x1_start, _, y1_v, v1 = seg_pts[i + 1]
                ts_val = None
                if isinstance(ts_raw, dict):
                    ts_val = ts_raw.get(str(i), ts_raw.get(i))
                elif isinstance(ts_raw, (list, tuple)) and i < len(ts_raw):
                    ts_val = ts_raw[i]
                if use_ts and ts_val is not None:
                    xm = (x0_end + x1_start) / 2
                    ym = y_of(float(ts_val))
                    dx_h = (x1_start - x0_end) * 0.36
                    bell = [
                        ("M", x0_end, y0_v),
                        ("C", x0_end + dx_h, y0_v, xm - dx_h * 0.65, ym, xm, ym),
                        ("C", xm + dx_h * 0.65, ym, x1_start - dx_h, y1_v, x1_start, y1_v),
                    ]
                    strokes.append((bell, scol, spt, s.get("dash"), "none"))
                elif smooth_mode:
                    dx_h = (x1_start - x0_end) * 0.44
                    scurve = [("M", x0_end, y0_v), ("C", x0_end + dx_h, y0_v, x1_start - dx_h, y1_v, x1_start, y1_v)]
                    strokes.append((scurve, scol, spt * 0.9, s.get("dash"), "none"))
                else:
                    strokes.append(([("M", x0_end, y0_v), ("L", x1_start, y1_v)], scol, spt * 0.8, s.get("dash", "dash"), "none"))
            s_name = s.get("name") or s.get("label")
            if s_name:
                lw_leg = float(s.get("legend_w", 30.0))
                lx = px + pw - lw_leg
                ly = py + 0.4 + si * 4.4
                labels.append((f"leg{si}", {"text": s_name, "pt": max(sci_pt_floor, base_pt - 0.1), "bold": True,
                                            "align": "right", "valign": "top", "color": s_stroke},
                               (lx, ly, lw_leg, 4.2)))

        for i, sl in enumerate(el.get("step_labels") or []):
            if not sl or i >= n_steps:
                continue
            cx_s = px + (i + 0.5) * slot_w
            labels.append((f"step{i}", {"text": sl, "pt": max(sci_pt_floor, base_pt - 0.15), "align": "center", "valign": "top",
                                        "color": th["text_color"]},
                           (cx_s - slot_w * 0.52, py + ph + 0.3, slot_w * 1.04, 4.4)))

    elif kind == "volcano_curve":
        raw_pts = el.get("points")
        pk = el.get("peak") or [0.52, 0.84]
        pu, pv = float(pk[0]), float(pk[1])
        if not raw_pts:
            raw_pts = [
                [0.04, 0.14],
                [pu * 0.55, 0.14 + (pv - 0.14) * 0.56],
                [pu, pv],
                [pu + (0.96 - pu) * 0.45, 0.16 + (pv - 0.16) * 0.56],
                [0.96, 0.16],
            ]
        pts = [(px + float(u) * pw, py + ph - float(v) * ph) for u, v in raw_pts]
        curve_cmds = catmull_rom_beziers(pts, float(el.get("tension", 0.45))) if el.get("smooth", True) else (
            [("M", pts[0][0], pts[0][1])] + [("L", p[0], p[1]) for p in pts[1:]]
        )
        if el.get("opt_band"):
            pk_x = px + pu * pw
            bw_opt = pw * 0.13
            opt_col = color(spec, el.get("opt_fill", "secondary@12" if "secondary" in th["colors"] else "#2E8B57@12"))
            if opt_col:
                fills.append(([("M", pk_x - bw_opt / 2, py + 1), ("L", pk_x + bw_opt / 2, py + 1),
                               ("L", pk_x + bw_opt / 2, py + ph), ("L", pk_x - bw_opt / 2, py + ph), ("Z",)], opt_col, None))
        if el.get("fill_under"):
            fc = color(spec, el["fill_under"])
            if fc:
                area_cmds = list(curve_cmds) + [("L", pts[-1][0], py + ph), ("L", pts[0][0], py + ph), ("Z",)]
                fills.append((area_cmds, fc, (fc, (fc[0], 0.03), 90.0)))
        scol = color(spec, el.get("stroke", "primary")) or ("1B4F72", 1.0)
        spt = float(el.get("stroke_pt", th["line_pt"] * 1.45))
        strokes.append((curve_cmds, scol, spt, el.get("dash"), "none"))
        xlim = el.get("xlim") or [-0.6, 0.6]
        ylim = el.get("ylim") or [-1.6, 0.1]
        for mi, mk in enumerate(el.get("markers") or []):
            if "pos" in mk:
                mu, mv = float(mk["pos"][0]), float(mk["pos"][1])
            elif "u" in mk and "v" in mk:
                mu, mv = float(mk["u"]), float(mk["v"])
            else:
                rx = float(mk.get("x", pu))
                mu = rx if (0.0 <= rx <= 1.0 and "xlim" not in el and mk.get("y", 0) >= 0) else max(0.05, min(0.95, (rx - xlim[0]) / max(1e-6, xlim[1] - xlim[0])))
                if "y" in mk:
                    ry = float(mk["y"])
                    mv = ry if (0.0 <= ry <= 1.0 and "ylim" not in el and rx >= 0) else max(0.08, min(0.94, (ry - ylim[0]) / max(1e-6, ylim[1] - ylim[0])))
                else:
                    # 没给 y 时自动贴在火山曲线上
                    mv = pv - abs(mu - pu) / max(pu, 1 - pu) * (pv - 0.16)
            mx, my = px + float(mu) * pw, py + ph - float(mv) * ph
            mr = float(mk.get("r_mm", 1.35))
            mc = color(spec, mk.get("color", "accent")) or ("D35400", 1.0)
            dots.append((mx, my, mr, mc, mk.get("shading", "radial")))
            if mk.get("label"):
                lw = float(mk.get("label_w", 22.0))
                side = mk.get("place", "top" if mv > 0.76 else ("left" if mu < pu else "right"))
                if side == "top":
                    lbox = (mx - lw / 2, max(y + 0.4, my - mr - 4.4), lw, 4.2)
                    al = "center"
                elif side == "left":
                    dy_off = -3.2 if mu <= pu else -1.2
                    lbox = (mx - mr - lw - 0.9, my + dy_off, lw, 4.2)
                    al = "right"
                else:
                    dy_off = -3.2 if mu >= pu else -1.2
                    lbox = (mx + mr + 0.9, my + dy_off, lw, 4.2)
                    al = "left"
                labels.append((f"mk{mi}", {"text": mk["label"], "pt": max(sci_pt_floor, base_pt - 0.1),
                                           "bold": bool(mk.get("bold", True)), "align": al, "valign": "middle",
                                           "color": mk.get("text_color", mk.get("color", th["text_color"]))}, lbox))

    elif kind == "dos_lobe":
        lobes = el.get("lobes") or [{"center": 0.46, "width": 0.14, "amp": 0.72, "fill": "primary@25", "stroke": "primary", "d_center": 0.46}]
        # 若 center 用的是物理能量（如 -1.4 eV）或有 sigma，默认横向能带图并按 elim 归一化到 0..1
        phys_e = any(float(lb.get("center", 0.5)) < 0 or float(lb.get("center", 0.5)) > 1.0 or "sigma" in lb for lb in lobes) or ("ef_x" in el)
        elim = el.get("elim") or [-4.0, 2.0]

        def norm_e(val):
            v = float(val)
            if phys_e:
                return max(0.02, min(0.98, (v - elim[0]) / max(1e-6, elim[1] - elim[0])))
            return v

        default_orient = "horizontal" if phys_e else "vertical"
        vertical = el.get("orientation", default_orient) == "vertical"
        fermi = el.get("fermi", norm_e(el.get("ef_x", 0.0)) if phys_e else 0.66)
        if fermi is not None:
            fv = float(fermi)
            if vertical:
                fy = py + ph - fv * ph
                strokes.append(([("M", px, fy), ("L", px + pw, fy)], axis_col, axis_pt * 0.9, "dash", "none"))
                labels.append(("fermi", {"text": el.get("fermi_label", "E_{F}"), "pt": max(sci_pt_floor, base_pt - 0.15),
                                         "italic": True, "align": "right", "valign": "bottom", "color": th["text_color"]},
                               (px + pw - 12, fy - 4.0, 11.5, 3.8)))
            else:
                fx = px + fv * pw
                strokes.append(([("M", fx, py), ("L", fx, py + ph)], axis_col, axis_pt * 0.9, "dash", "none"))
                labels.append(("fermi", {"text": el.get("fermi_label", "E_{F}"), "pt": max(sci_pt_floor, base_pt - 0.15),
                                         "italic": True, "align": "left", "valign": "top", "color": th["text_color"]},
                               (fx + 0.6, py + 0.4, 12.0, 4.0)))
        for li, lb in enumerate(lobes):
            c0 = norm_e(lb.get("center", 0.48))
            raw_w = float(lb.get("width", lb.get("sigma", 0.13 if not phys_e else 0.7)))
            sig = max(0.04, raw_w / max(1e-6, elim[1] - elim[0]) if (phys_e and "width" not in lb) else raw_w)
            amp = float(lb.get("amp", 0.72))
            samples = []
            for k in range(25):
                u = k / 24.0
                g = amp * math.exp(-0.5 * ((u - c0) / sig) ** 2)
                if vertical:
                    samples.append((px + g * pw, py + ph - u * ph))
                else:
                    samples.append((px + u * pw, py + ph - g * ph))
            c_cmds = catmull_rom_beziers(samples, 0.45)
            lb_stroke = lb.get("stroke") or lb.get("color") or "primary"
            lb_fill = lb.get("fill") or (f"{lb_stroke}@24" if "@" not in str(lb_stroke) else lb_stroke)
            fcol = color(spec, lb_fill)
            scol = color(spec, lb_stroke) or ("1B4F72", 1.0)
            if fcol:
                if vertical:
                    area = list(c_cmds) + [("L", px, samples[-1][1]), ("L", px, samples[0][1]), ("Z",)]
                else:
                    area = list(c_cmds) + [("L", samples[-1][0], py + ph), ("L", samples[0][0], py + ph), ("Z",)]
                fills.append((area, fcol, (fcol, (fcol[0], 0.05), 0.0 if vertical else 90.0)))
            strokes.append((c_cmds, scol, float(lb.get("stroke_pt", th["line_pt"] * 1.25)), lb.get("dash"), "none"))
            dc = lb.get("d_center")
            if dc is not None:
                dcv = norm_e(dc)
                if vertical:
                    dy_c = py + ph - dcv * ph
                    strokes.append(([("M", px, dy_c), ("L", px + amp * pw * 0.85, dy_c)], scol, axis_pt * 1.1, "dot", "none"))
                    if lb.get("d_label"):
                        labels.append((f"dc{li}", {"text": lb["d_label"], "pt": max(sci_pt_floor, base_pt - 0.15), "bold": True,
                                                   "align": "left", "valign": "middle", "color": lb_stroke},
                                       (px + amp * pw * 0.86, dy_c - 2.0, 16.0, 4.0)))
                else:
                    dx_c = px + dcv * pw
                    strokes.append(([("M", dx_c, py + ph * (1 - amp * 0.85)), ("L", dx_c, py + ph)], scol, axis_pt * 1.1, "dot", "none"))
            if lb.get("label"):
                if vertical:
                    labels.append((f"lb{li}", {"text": lb["label"], "pt": max(sci_pt_floor, base_pt - 0.15), "bold": True,
                                               "align": "left", "valign": "top", "color": lb_stroke},
                                   (px + 1.2 + li * 16.0, py + 0.5, 16.0, 4.0)))
                else:
                    labels.append((f"lb{li}", {"text": lb["label"], "pt": max(sci_pt_floor, base_pt - 0.15), "bold": True,
                                               "align": "center", "valign": "bottom", "color": lb_stroke},
                                   (px + c0 * pw - 10, max(y + 0.3, py + ph - amp * ph - 4.2), 20.0, 4.0)))
        for di, dcm in enumerate(el.get("d_centers") or []):
            dcv = norm_e(dcm.get("x", dcm.get("pos", 0.5)))
            dcol_name = dcm.get("color", "accent")
            dcol = color(spec, dcol_name) or ("D35400", 1.0)
            if vertical:
                dy_c = py + ph - dcv * ph
                strokes.append(([("M", px, dy_c), ("L", px + pw * 0.72, dy_c)], dcol, axis_pt * 1.15, "dot", "none"))
                if dcm.get("label"):
                    labels.append((f"dcm{di}", {"text": dcm["label"], "pt": max(sci_pt_floor, base_pt - 0.15), "bold": True,
                                                "align": "left", "valign": "middle", "color": dcol_name},
                                   (px + pw * 0.74, dy_c - 2.0, 14.0, 4.0)))
            else:
                dx_c = px + dcv * pw
                strokes.append(([("M", dx_c, py + ph * 0.22), ("L", dx_c, py + ph)], dcol, axis_pt * 1.15, "dot", "none"))
                if dcm.get("label"):
                    place_left = dcm.get("place", "left" if dcv > 0.45 else "right") == "left"
                    lw_dc = float(dcm.get("label_w", 16.0))
                    lx_dc = (dx_c - lw_dc - 0.8) if place_left else (dx_c + 0.8)
                    ly_dc = py + ph * float(dcm.get("y_frac", 0.52))
                    labels.append((f"dcm{di}", {"text": dcm["label"], "pt": max(sci_pt_floor, base_pt - 0.15), "bold": True,
                                                "align": "right" if place_left else "left", "valign": "middle", "color": dcol_name},
                                   (lx_dc, ly_dc, lw_dc, 4.2)))

    return {"fills": fills, "strokes": strokes, "dots": dots, "labels": labels}


# ---------- 3D 晶格 / 团簇阵列（lattice）与引出线（callout） ----------

def lattice_geometry(spec, el):
    """生成晶格基底（mode='grid'）或非晶团簇（mode='cluster'）的键连线、3D 原子球和空位环"""
    th = spec["theme"]
    x, y, w, h = bbox(el)
    mode = el.get("mode", "cluster" if el.get("atoms") or el.get("count") else "grid")
    bonds, spheres, rings = [], [], []
    stroke_col = color(spec, el.get("stroke", "none"))
    stroke_pt = float(el.get("stroke_pt", 0.35))

    if mode == "cluster":
        atoms = el.get("atoms")
        if atoms:
            for a in atoms:
                cx = x + float(a["u"]) * w
                cy = y + float(a["v"]) * h
                r = float(a.get("r_mm", min(w, h) * 0.14))
                fc = color(spec, a.get("fill", el.get("fill", "accent"))) or ("D35400", 1.0)
                spheres.append((cx, cy, r, fc, stroke_col, stroke_pt))
        else:
            cnt = int(el.get("count", 11))
            seed = int(el.get("seed", 42))
            rng = random.Random(seed)
            r_base = float(el.get("radius_mm", min(w, h) / max(3.6, math.sqrt(cnt) * 1.45)))
            palette_cycle = [color(spec, c) for c in (el.get("species") or [el.get("fill", "accent")])]
            palette_cycle = [c for c in palette_cycle if c] or [("D35400", 1.0)]
            pts = []
            for i in range(cnt):
                ang = i * 2.39996 + rng.uniform(-0.18, 0.18)  # 黄金角密堆 + 微扰 = 自然非晶团簇
                rad = math.sqrt((i + 0.45) / cnt)
                cx = x + w * 0.5 + math.cos(ang) * (w * 0.42 - r_base) * rad
                cy = y + h * 0.54 + math.sin(ang) * (h * 0.40 - r_base) * rad
                fc = palette_cycle[i % len(palette_cycle)]
                pts.append((cy, cx, r_base * rng.uniform(0.92, 1.06), fc))
            for cy, cx, r, fc in sorted(pts, key=lambda t: t[0]):
                spheres.append((cx, cy, r, fc, stroke_col, stroke_pt))
        return {"bonds": bonds, "spheres": spheres, "rings": rings}

    nx = max(1, int(el.get("nx", 6)))
    ny = max(1, int(el.get("ny", 3)))
    skew = float(el.get("skew_mm", 1.6 if ny > 1 else 0.0))
    total_skew = abs(skew) * (ny - 1)
    r_auto = min((w - total_skew) / (2 * nx + 0.6), h / (2 * ny + 0.4)) * 0.82
    r = float(el.get("radius_mm", max(0.8, r_auto)))
    dx = (w - total_skew - 2 * r) / max(1, nx - 1) if nx > 1 else 0.0
    dy = (h - 2 * r) / max(1, ny - 1) if ny > 1 else 0.0
    x0 = x + r + (total_skew if skew < 0 else 0.0)
    y0 = y + r

    species = [color(spec, c) for c in (el.get("species") or [el.get("fill", "primary")])]
    species = [c for c in species if c] or [("1B4F72", 1.0)]
    vacancies = {(int(v[0]), int(v[1])) for v in (el.get("vacancies") or [])}
    dopants = {str(k): color(spec, v) for k, v in (el.get("dopants") or {}).items()}
    grid_pos = {}
    for row in range(ny):
        # 2.5D 后排略深一点增强层次感
        depth_shade = (ny - 1 - row) * 0.08 if el.get("depth_tint", True) and ny > 1 else 0.0
        for col in range(nx):
            cx = x0 + col * dx + row * skew
            cy = y0 + row * dy
            grid_pos[(col, row)] = (cx, cy)
            if (col, row) in vacancies:
                vcol = color(spec, el.get("vacancy_color", "accent")) or ("D35400", 1.0)
                rings.append((cx, cy, r * 0.92, vcol, "dash"))
                continue
            base_c = dopants.get(f"{col},{row}") or species[(col + row) % len(species)]
            hex_c = mix_hex(base_c[0], "0B1320", depth_shade) if depth_shade > 0 else base_c[0]
            r_atom = r * (0.76 if len(species) > 1 and (col + row) % 2 == 1 and el.get("oxide_ratio", True) else 1.0)
            spheres.append((cx, cy, r_atom, (hex_c, base_c[1]), stroke_col, stroke_pt))

    if el.get("bonds", False):
        bcol = color(spec, el.get("bond_color", "muted" if "muted" in th["colors"] else "#8899A6")) or ("8899A6", 0.75)
        bpt = float(el.get("bond_pt", max(0.5, r * 0.45)))
        for (c, rw), p1 in grid_pos.items():
            if (c, rw) in vacancies:
                continue
            for nc, nr in ((c + 1, rw), (c, rw + 1)):
                if (nc, nr) in grid_pos and (nc, nr) not in vacancies:
                    bonds.append((p1, grid_pos[(nc, nr)], bcol, bpt))
    return {"bonds": bonds, "spheres": spheres, "rings": rings}


def callout_geometry(spec, el, index, image_rects=None):
    """引出指示线（●───╱─── Label）：给定目标锚点 target 和文字框 [x, y, w, h]，生成圆点锚头 + 45°/水平折线"""
    pt_target, _, _ = resolve_anchor(el["target"], index, image_rects, f"callout {el['id']} 的 target")
    if pt_target is None:
        node = index[el["target"]]
        bx, by, bw, bh = bbox(node)
        pt_target = (bx + bw / 2, by + bh / 2)
    tx, ty = pt_target
    x, y, w, h = bbox(el)
    cx_box, cy_box = x + w / 2, y + h / 2
    # 连接到文字框朝向目标点最近的一侧中点（左侧或右侧水平托架）
    if cx_box >= tx:
        sx, sy = x - 0.6, cy_box
        shelf = min(3.2, max(1.4, abs(sx - tx) * 0.28))
        kx_shelf = sx - shelf
        diag = min(abs(kx_shelf - tx), abs(sy - ty))
        kx = tx + diag if kx_shelf >= tx else sx
        pts = [(tx, ty), (kx, sy), (sx, sy)] if abs(sy - ty) > 0.6 and abs(sx - tx) > 2.0 else [(tx, ty), (sx, sy)]
    else:
        sx, sy = x + w + 0.6, cy_box
        shelf = min(3.2, max(1.4, abs(tx - sx) * 0.28))
        kx_shelf = sx + shelf
        diag = min(abs(tx - kx_shelf), abs(sy - ty))
        kx = tx - diag if tx >= kx_shelf else sx
        pts = [(tx, ty), (kx, sy), (sx, sy)] if abs(sy - ty) > 0.6 and abs(tx - sx) > 2.0 else [(tx, ty), (sx, sy)]
    # 去重极近点
    clean = [pts[0]]
    for p in pts[1:]:
        if math.hypot(p[0] - clean[-1][0], p[1] - clean[-1][1]) > 0.25:
            clean.append(p)
    if len(clean) == 1:
        clean.append((sx, sy))
    th = spec["theme"]
    scol = color(spec, el.get("stroke", "muted" if "muted" in th["colors"] else th["text_color"])) or ("5D6D7E", 1.0)
    dcol = color(spec, el.get("dot_color", el.get("stroke", "primary" if "primary" in th["colors"] else th["text_color"]))) or scol
    return {
        "target": (tx, ty),
        "pts": clean,
        "stroke": scol,
        "stroke_pt": float(el.get("stroke_pt", max(0.55, th["line_pt"] * 0.85))),
        "dot_r_mm": float(el.get("dot_r_mm", 0.85)),
        "dot_color": dcol,
        "halo": bool(el.get("halo", True)),
    }


def chevron_points(el):
    """色带箭头（chevron / banner_arrow）顶点列表：首段可 indent=false / lead_in=false 平左缘，后续段内凹咬合"""
    x, y, w, h = bbox(el)
    tip = float(el.get("tip_mm", min(4.6, h * 0.42, w * 0.22)))
    has_indent = el.get("indent", el.get("lead_in", True))
    indent = float(el.get("notch_mm", tip if has_indent else 0.0))
    pts = [(x, y), (x + w - tip, y), (x + w, y + h / 2), (x + w - tip, y + h), (x, y + h)]
    if indent > 0.05:
        pts.append((x + indent, y + h / 2))
    return pts, indent, tip


def load_index(spec):
    return {el["id"]: el for el in spec["elements"]}
