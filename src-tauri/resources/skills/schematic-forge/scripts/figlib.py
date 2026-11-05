"""示意图图纸（figure.json）的公共逻辑：读图纸、配色、找字体、量字、排版、连线几何。

渲染器（render_figure.py）和检查脚本（schematic_check.py）都用这一份排版结果——检查查的就是渲染出来的那个版面。
坐标一律毫米（左上角为原点），字号与线宽用磅（pt）。只依赖 Pillow。
"""
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

MM_PER_PT = 25.4 / 72
LINE_GAP = 1.2  # 行高 = 字号 × 1.2，SVG 与 PPTX 都按这个写死，换软件不变

PURPOSE_MIN_PT = {"journal": 5, "graphical-abstract": 6, "roadmap": 6, "poster": 12, "slide": 14}
DEFAULT_LATIN = ["Arial", "Helvetica", "Liberation Sans", "DejaVu Sans"]
DEFAULT_CJK = ["Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "SimHei", "Arial Unicode MS"]
SHAPES = {"box", "ellipse", "text", "image", "figure"}
LINES = {"arrow", "line", "polyline"}

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
        if t in SHAPES:
            for k in ("x", "y", "w", "h"):
                if not isinstance(el.get(k), (int, float)):
                    raise SpecError(f"元素 {eid} 缺 {k}（毫米）")
            if el["w"] <= 0 or el["h"] <= 0:
                raise SpecError(f"元素 {eid} 的宽高必须是正数")
        if t == "polyline" and len(el.get("points") or []) < 2:
            raise SpecError(f"折线 {eid} 至少要两个 points")
        if t in ("arrow", "line") and ("from" not in el or "to" not in el):
            raise SpecError(f"连线 {eid} 要有 from 和 to")
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


# ---------- 颜色 ----------

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


def luminance(hex6):
    r, g, b = (int(hex6[i:i + 2], 16) for i in (0, 2, 4))
    return 0.299 * r + 0.587 * g + 0.114 * b


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
            "overflow": overflow, "missing": sorted(missing), "avail": avail, "orphans": orphans}


def baseline(lay, i):
    """第 i 行基线的 y（毫米）：行框顶 + (行高 − 字号)/2 + 0.8 × 字号，与 PPTX 固定行距的视觉位置对齐"""
    pt_mm = lay["style"].pt * MM_PER_PT
    return lay["y0"] + i * lay["line_h"] + (lay["line_h"] - pt_mm) / 2 + 0.8 * pt_mm


# ---------- 几何 ----------

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


def endpoints(el, index):
    """连线两端：[(x,y), 连到的元素或 None, 边名或 None] × 2"""
    ends = []
    a = index.get(el["from"]) if isinstance(el["from"], str) else None
    b = index.get(el["to"]) if isinstance(el["to"], str) else None
    for key, other in (("from", a), ("to", b)):
        if isinstance(el[key], str) and el[key] not in index:
            raise SpecError(f"连线 {el['id']} 的 {key}={el[key]!r} 不是任何元素的 id")
    sa, sb = (el.get("from_side"), el.get("to_side"))
    if a and b and (not sa or not sb):
        auto = auto_sides(a, b)
        sa, sb = sa or auto[0], sb or auto[1]
    for key, node, side in (("from", a, sa), ("to", b, sb)):
        if node is None:
            pt = el[key]
            if not (isinstance(pt, list) and len(pt) == 2):
                raise SpecError(f"连线 {el['id']} 的 {key} 要么是元素 id，要么是 [x, y]")
            ends.append((tuple(pt), None, None))
        else:
            if not side:
                other = b if key == "from" else a
                side = "right" if other is None else auto_sides(node, other)[0]
            ends.append((side_point(node, side), node, side))
    return ends


def elbow_points(p1, p2, s1, s2):
    """直角折线（只做左右边进出：横—竖—横，中点处拐弯；PPTX 用 bentConnector3 对应同一条路）"""
    if s1 in ("left", "right") and s2 in ("left", "right"):
        xm = (p1[0] + p2[0]) / 2
        return [p1, (xm, p1[1]), (xm, p2[1]), p2]
    return None


def load_index(spec):
    return {el["id"]: el for el in spec["elements"]}
