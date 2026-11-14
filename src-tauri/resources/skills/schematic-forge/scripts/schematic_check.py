#!/usr/bin/env python3
"""示意图检查（schematic-forge 技能随包）：按图纸算出的版面查机器能确定的问题，结果进 Mesa 评审页的核验清单。

用法（在项目 / 工作区根目录下运行；Windows 上把 python3 换成 python）：
  python3 schematic_check.py figures/<图名>/figure.json

查什么（三档：通过 / 拦下 / 待你判断，不打总分）：
  拦下：文字相交、文字超出所在框或画布、无对比度压框边、字号低于该用途下限、缺字、元素出画布、
        facts.md 里写的「关系：A → B」没画或方向反、图上科学主张/核心术语在 brief.md / facts.md 里找不到原文
        （纯化学分子式/离子/反应式、标准坐标轴物理量、阶段序号自动放行）、
        位图在成品尺寸下分辨率不够、缺 brief.md / facts.md、图纸与 SVG 对不上（改了图纸没重渲）。
  待你判断：上下标过小、字体回落、字体族过多、非期刊栏宽、灰度/红绿不易区分的色块组（合并为单条 GRAY-PAIR）、
        文字压在图像复杂区域（局部对比度达标的浅色留白区放行）、连线穿过文字、
        标签像句子、出图模型元素是否透明底、AI 使用披露、多模态冷读与事实核对（检查全过不等于图对）。
结果写进 <根目录>/.ccode/checks/schematic-<图名>.jsonl。退出码：0 没有拦下的；1 有拦下的；2 图纸读不了。
"""
import argparse
import colorsys
import hashlib
import importlib.util
import json
import math
import re
import shutil
import sys
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

# 大小写敏感的 IUPAC 元素符号 + 催化常见位点符（M/X），严禁忽略大小写以免把英文单词当化学式
_ELEMENTS = (
    "He|Li|Be|Ne|Na|Mg|Al|Si|Cl|Ar|Ca|Sc|Ti|Cr|Mn|Fe|Co|Ni|Cu|Zn|Ga|Ge|As|Se|Br|Kr|"
    "Rb|Sr|Zr|Nb|Mo|Tc|Ru|Rh|Pd|Ag|Cd|In|Sn|Sb|Te|Xe|Cs|Ba|La|Ce|Pr|Nd|Pm|Sm|Eu|Gd|"
    "Tb|Dy|Ho|Er|Tm|Yb|Lu|Hf|Ta|W|Re|Os|Ir|Pt|Au|Hg|Tl|Pb|Bi|Po|At|Rn|Fr|Ra|Ac|Th|"
    "Pa|Np|Pu|Am|Cm|Bk|Cf|Es|Fm|Md|No|Lr|Rf|Db|Sg|Bh|Hs|Mt|Ds|Rg|Cn|Nh|Fl|Mc|Lv|Ts|Og|"
    "H|B|C|N|O|F|P|S|K|V|Y|I|U|M|X"
)
_EL_TOKEN = re.compile(rf"(?:{_ELEMENTS})(?![a-z])")
_SPECIES = re.compile(rf"^(?:[*□]|\(|\)|\[|\]|[0-9.xyδ]+|[-−+]|(?:{_ELEMENTS})(?![a-z]))+$")
_EQ_SPLIT = re.compile(r"(?:\s+\+\s+|\s*(?:→|->|⟶|⇌|↔|⇄|=)\s*)")
_PHASE_PREFIX = re.compile(r"^(?:[acαβγδ]-)(?=[A-Z])")
_COEFF_PREFIX = re.compile(r"^\d+(?:/\d+)?(?:\.\d+)?\s*")
_PHASE_SUFFIX = re.compile(r"(?:\s*\((?:s|l|g|aq|ads)\)|[↑↓])+$")
_THERMO_TOKEN = re.compile(
    r"^(?:[Δδ][GHEASΦφW](?:_[A-Za-z0-9*+-]+|\([A-Za-z0-9*+-]+\))?[0-9*+-]*|E_?[Fa]|ε_?[dp]|η\d*|θ_[A-Za-z0-9*+-]+|[Φφ]|j_?0?|R_?ct|pH|TS\d*|IS|FS|IM\d*)$"
)
_STOP_UNITS = {
    "the", "a", "an", "of", "in", "on", "at", "to", "for", "with", "by", "from", "via", "into",
    "over", "under", "and", "or", "vs", "as", "is", "are", "per",
    "ev", "mv", "kv", "ma", "ua", "cm", "mm", "nm", "um", "pm", "mol", "mmol", "mg", "kg",
    "hr", "hrs", "min", "sec", "dec", "au", "arb", "wt", "at", "vol", "rhe", "she", "sce",
}
_STAGE_ONLY = re.compile(
    r"^(?:(?:stage|step|phase|part|panel|route|pathway)\s*(?:[ivx]+|\d+|[a-z])"
    r"|第\s*[一二三四五六七八九十\d]+\s*[步阶段期节]|(?:阶段|步骤)\s*[一二三四五六七八九十\d]+|[ivx]+\.?|\(?[a-z]\))\.?$",
    re.I,
)
_STAGE_PREFIX = re.compile(
    r"^(?:(?:stage|step|phase|part)\s*(?:[ivx]+|\d+)\s*(?:[·|—–\-:：.]\s*)+"
    r"|(?:阶段|步骤)\s*[一二三四五六七八九十\d]+\s*(?:[·|—–\-:：.]\s*)+"
    r"|\([a-z]\)\s+|[a-z]\)\s+)",
    re.I,
)
_AXIS_EXEMPT = {
    "reactioncoordinate", "reactionpathway", "反应坐标", "反应路径", "反应历程",
    "freeenergy(ev)", "gibbsfreeenergy(ev)", "δg(ev)", "δgh(ev)", "自由能(ev)", "吉布斯自由能(ev)",
    "dos(a.u.)", "pdos(a.u.)", "tdos(a.u.)", "dos(states/ev)", "densityofstates", "态密度", "态密度(a.u.)",
    "e-ef(ev)", "energy(ev)", "能量(ev)", "bindingenergy(ev)",
    "potential(vvs.rhe)", "u(vvs.rhe)", "e(vvs.rhe)", "overpotential(mv)", "η(mv)", "过电位(mv)",
    "currentdensity(macm-2)", "j(macm-2)", "log|j|(macm-2)", "log|j0|(macm-2)", "log|j|", "log|j0|", "tafelslope(mvdec-1)",
}


def norm(s):
    s = unicodedata.normalize("NFKC", F.plain_text(s))
    return re.sub(r"[\s　*_^{}]+", "", s).lower()


def is_chem_formula_or_eq(raw_piece):
    """严格大小写敏感地识别纯化学分子式、离子、电子、吸附中间体或反应方程式（如 H_{2}O + e^{-} → H^{*} + OH^{-}、+e^{-}）。
    普通英文短语（如 'Unsourced claim here'）含小写词尾或空格散词，绝不会误判放行。"""
    plain = unicodedata.normalize("NFKC", F.plain_text(raw_piece)).strip()
    if not plain or any(F.is_cjk(ch) for ch in plain):
        return False
    terms = _EQ_SPLIT.split(plain)
    if not terms:
        return False
    multi_term = len(terms) > 1
    total_elements = 0
    has_chem_marker = multi_term
    for term in terms:
        t = term.strip()
        if not t:
            return False
        lead_sign = re.match(r"^[+−±-]\s*", t)
        if lead_sign:
            has_chem_marker = True
            t = t[lead_sign.end():]
        t = _COEFF_PREFIX.sub("", t)
        if _PHASE_SUFFIX.search(t):
            has_chem_marker = True
            t = _PHASE_SUFFIX.sub("", t).strip()
        if not t:
            return False
        if re.fullmatch(r"(?:e[-−]|h\+|V_?O\d*|hν|hv|□)", t):
            has_chem_marker = True
            total_elements += 1
            continue
        if _THERMO_TOKEN.fullmatch(t):
            has_chem_marker = True
            total_elements += 1
            continue
        parts = re.split(r"[/@·•]", t)
        if len(parts) > 1:
            has_chem_marker = True
        for part in parts:
            had_phase = bool(_PHASE_PREFIX.match(part))
            part = _PHASE_PREFIX.sub("", part)
            if not part or not _SPECIES.fullmatch(part):
                return False
            els = _EL_TOKEN.findall(part)
            if not els:
                return False
            total_elements += len(els)
            if had_phase or re.search(r"[0-9*□+−-]", part) or len(els) >= 2:
                has_chem_marker = True
    # 单个无数字无电荷的单元素词（如英文介词 In / As / No / Be）不放行，防止普通英文蒙混过关
    return total_elements >= 1 and has_chem_marker


def is_exempt_label(raw_piece):
    """判断是否为免核对原文的图内通用微标签：≤4 字符西文/符号编号、阶段序号、纯化学式/反应式、标准坐标轴物理量。"""
    plain = unicodedata.normalize("NFKC", F.plain_text(raw_piece)).strip()
    n = norm(raw_piece)
    if len(n) <= 2 or re.fullmatch(r"[\d.,%+\-−×/()（）↑↓]+|\(?[a-z]\)?|\(?[ivx]+\)?", n):
        return True
    if len(n) <= 4 and not any(F.is_cjk(ch) for ch in plain):
        return True
    if _STAGE_ONLY.fullmatch(plain):
        return True
    if n.replace("−", "-") in _AXIS_EXEMPT:
        return True
    if is_chem_formula_or_eq(raw_piece):
        return True
    return False


def _cjk_covered(chunk, src_norm):
    """检查一段中文短语是否可由 src_norm 中出现过的 ≥2 字实词完整覆盖。"""
    if chunk in src_norm:
        return True
    L = len(chunk)
    if L < 2:
        return chunk in src_norm
    dp = [False] * (L + 1)
    dp[0] = True
    for i in range(L):
        if not dp[i]:
            continue
        for j in range(i + 2, L + 1):
            if chunk[i:j] in src_norm:
                dp[j] = True
    return dp[L]


def _tokens_covered(text, src_norm, source_text):
    """关键词 / Token + 数值覆盖核查：允许精炼视觉表达（如 'ΔΦ = 0.06 eV' 对应 facts 里的 'ΔΦ 为 0.06 eV'），
    同时保证所有实词、物理量符号和每一个数字都在 brief.md / facts.md 中有据可查。"""
    if not source_text:
        return False
    plain = unicodedata.normalize("NFKC", F.plain_text(text)).strip()
    if not plain:
        return True
    src_plain = unicodedata.normalize("NFKC", F.plain_text(source_text)).lower()
    substantive = 0
    # 1) 图上出现的非化学式定量数字必须在原文中出现，杜绝编造数值
    non_chem = " ".join(
        tok for tok in plain.split()
        if not is_chem_formula_or_eq(tok.strip("(),;[]{}"))
    )
    for num in re.findall(r"\d+(?:\.\d+)?", non_chem):
        if num not in src_norm:
            return False
        substantive += 1
    # 2) 西文实词按词边界核对（跳过化学分子式与介词/单位）
    for raw_w in re.findall(r"[A-Za-z][A-Za-z0-9*+-]*", plain):
        if is_chem_formula_or_eq(raw_w):
            continue
        for w in re.findall(r"[A-Za-z]{2,}", raw_w):
            wl = w.lower()
            if wl in _STOP_UNITS:
                continue
            substantive += 1
            stem = wl[:-1] if (wl.endswith("s") and len(wl) >= 4) else wl
            if not re.search(rf"\b(?:{re.escape(wl)}|{re.escape(stem)}(?:s|es|ed|ing)?)\b", src_plain):
                return False
    # 3) 希腊字母物理量符号（如 ΔΦ、η、θ、ε）
    for g in re.findall(r"[Δδ]?[α-ωΑ-Ωℏ]+", plain):
        gn = norm(g)
        if gn:
            substantive += 1
            if gn not in src_norm:
                return False
    # 4) 中文实词块（剥除常见虚字后逐块覆盖）
    for run in re.findall(r"[\u4e00-\u9fff]+", plain):
        for ck in re.split(r"[的与及和在从向对为是于或把被将并而各其该本]", run):
            if not ck:
                continue
            substantive += 1
            if not _cjk_covered(ck, src_norm):
                return False
    return substantive >= 1


def source_matched(raw_piece, src_norm, source_text=""):
    """检查一段图内文字是否在 brief.md / facts.md 有依据（或属于免检化学式/坐标轴/阶段号/微标签）。"""
    if is_exempt_label(raw_piece):
        return True
    n = norm(raw_piece)
    if n in src_norm:
        return True
    # 剥离头部阶段号/面板字母（如 'Stage I · Interfacial Synthesis' → 核对 'Interfacial Synthesis'）
    plain = unicodedata.normalize("NFKC", F.plain_text(raw_piece)).strip()
    stripped = _STAGE_PREFIX.sub("", plain).strip()
    if stripped != plain:
        if is_exempt_label(stripped) or norm(stripped) in src_norm:
            return True
    # 复合标签按 · / | / — / ：切分子句逐段核对（如 'Volmer step: H2O + e- → H* + OH-'）
    clauses = [c.strip() for c in re.split(r"\s*(?:[·|—–]|[:：])\s*", stripped) if c.strip()]
    if len(clauses) > 1 and all(
        is_exempt_label(c) or norm(c) in src_norm or _tokens_covered(c, src_norm, source_text)
        for c in clauses
    ):
        return True
    return _tokens_covered(stripped, src_norm, source_text)


def blend_over_bg(col, bg_hex="FFFFFF"):
    if not col:
        return bg_hex
    hex6, alpha = col
    if alpha >= 0.999:
        return hex6
    return F.mix_hex(bg_hex, hex6, alpha)


def effective_fill_hex(spec, el, canvas_bg="FFFFFF"):
    th = spec["theme"]
    t = el["type"]
    grad = F.gradient_spec(spec, el)
    if grad:
        c1 = blend_over_bg(grad[0], canvas_bg)
        c2 = blend_over_bg(grad[1], canvas_bg)
        return F.mix_hex(c1, c2, 0.5)
    default_fill = "panel_bg" if (t in ("header_card", "hero_panel") and "panel_bg" in th["colors"]) else (
        "#FFFFFF" if t == "header_card" else "none"
    )
    col = F.color(spec, el.get("fill", default_fill))
    return blend_over_bg(col, canvas_bg)


def hits_border_edge(ink, rect, tol=0.55):
    """文字墨迹框是否压在矩形的四条边线上（而非完整落在内部或外部）。"""
    ix, iy, iw, ih = ink
    rx, ry, rw, rh = rect
    ix1, iy1 = ix + iw, iy + ih
    rx1, ry1 = rx + rw, ry + rh
    v_span = iy1 > ry + tol and iy < ry1 - tol
    h_span = ix1 > rx + tol and ix < rx1 - tol
    hit_left = v_span and (ix < rx + tol and ix1 > rx - tol)
    hit_right = v_span and (ix < rx1 + tol and ix1 > rx1 - tol)
    hit_top = h_span and (iy < ry + tol and iy1 > ry - tol)
    hit_bot = h_span and (iy < ry1 + tol and iy1 > ry1 - tol)
    return hit_left or hit_right or hit_top or hit_bot


def image_patch_clean_contrast(im, img_rect, ink, txt_hex, bg_hex="FFFFFF"):
    """采样图片在文字 ink 区域下的像素块：若背景均匀且 WCAG / Michelson 对比度达标，返回 True（允许叠字）。"""
    fx, fy, fw, fh = img_rect
    if fw <= 0 or fh <= 0:
        return False
    ox0 = max(fx, ink[0])
    oy0 = max(fy, ink[1])
    ox1 = min(fx + fw, ink[0] + ink[2])
    oy1 = min(fy + fh, ink[1] + ink[3])
    if ox1 <= ox0 or oy1 <= oy0:
        return True
    W, H = im.size
    px0 = max(0, min(W - 1, int((ox0 - fx) / fw * W)))
    py0 = max(0, min(H - 1, int((oy0 - fy) / fh * H)))
    px1 = max(px0 + 1, min(W, int(round((ox1 - fx) / fw * W)) + 1))
    py1 = max(py0 + 1, min(H, int(round((oy1 - fy) / fh * H)) + 1))
    patch = im.crop((px0, py0, px1, py1))
    if patch.mode != "RGB":
        from PIL import Image
        bg_rgb = tuple(int(bg_hex[i:i + 2], 16) for i in (0, 2, 4)) + (255,)
        base = Image.new("RGBA", patch.size, bg_rgb)
        patch = Image.alpha_composite(base, patch.convert("RGBA")).convert("RGB")
    pixels = list(patch.get_flattened_data() if hasattr(patch, "get_flattened_data") else patch.getdata())
    if not pixels:
        return True
    lums = sorted(0.299 * r + 0.587 * g + 0.114 * b for r, g, b in pixels)
    p10 = lums[int(len(lums) * 0.10)]
    p90 = lums[int(len(lums) * 0.90)]
    if (p90 - p10) > 32:
        return False  # 文字底下跨过了明暗变化大的图形边缘，不够干净
    h10 = ("%02X" % round(p10)) * 3
    h90 = ("%02X" % round(p90)) * 3
    txt_lum = F.luminance(txt_hex)
    wcag_ok = min(F.wcag_contrast(txt_hex, h10), F.wcag_contrast(txt_hex, h90)) >= 4.0
    mich_ok = min(F.michelson_contrast(txt_lum, p10), F.michelson_contrast(txt_lum, p90)) >= 0.55
    return wcag_ok or mich_ok


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
    canvas_bg = (F.color(spec, cv.get("background")) or ("FFFFFF", 1.0))[0]
    book = F.FontBook()
    R.assets_book = book
    index = F.load_index(spec)
    image_rects = R.compute_image_rects(spec, fig_dir)
    try:
        layouts = R.compute_layouts(spec, book, index, image_rects)
    except F.SpecError as e:
        add("SPEC", "schematic_spec", "blocked", f"图纸排不了版：{e}")
        return C.summary(items, C.write_items(root, f"schematic-{name}.jsonl", items))

    # 预加载位图缓存（供局部对比度采样与 PPI 检查共用）
    raster_cache = {}
    probe_assets = R.Assets(fig_dir, R.Raster(probe=False))
    try:
        from PIL import Image
        for el in spec["elements"]:
            if el["type"] in ("image", "figure", "hero_panel"):
                try:
                    p_img, ext_img = probe_assets.resolve(el)
                    if ext_img in ("png", "jpg", "jpeg", "webp"):
                        im = Image.open(p_img)
                        crop = el.get("crop")
                        if crop and len(crop) == 4:
                            x0, y0, cw, ch = (int(v) for v in crop)
                            im = im.crop((x0, y0, x0 + cw, y0 + ch))
                        raster_cache[el["id"]] = (im, p_img, ext_img)
                except Exception:
                    pass
    finally:
        shutil.rmtree(probe_assets.tmp, ignore_errors=True)

    # 立意与事实
    brief, facts = fig_dir / "brief.md", fig_dir / "facts.md"
    source_text = ""
    for p in (brief, facts):
        if p.is_file():
            source_text += p.read_text(encoding="utf-8") + "\n"
        else:
            add(f"MISSING-{p.stem.upper()}", "schematic_plan", "blocked", f"缺 {p.name}：先写立意和事实记录再画", R.rel(p, root))
    src_norm = norm(source_text)

    # 元素与科学原语出画布检查
    for el in spec["elements"]:
        t = el["type"]
        if t in F.SHAPES and not F.inside(F.bbox(el), canvas):
            add(f"OUT-{el['id']}", "schematic_layout", "blocked", f"元素 {el['id']} 超出画布")
        if t == "callout":
            try:
                cg = F.callout_geometry(spec, el, index, image_rects)
                if not all(F.inside((px, py, 0, 0), canvas) for px, py in cg["pts"]):
                    add(f"OUT-{el['id']}-target", "schematic_layout", "blocked", f"引出标注 {el['id']} 的锚点或引线出了画布")
            except F.SpecError as e:
                add(f"SPEC-{el['id']}", "schematic_spec", "blocked", str(e))
        elif t in {"sci_curve"} | F.SCI_CURVE_KINDS:
            try:
                F.sci_curve_geometry(spec, el)
            except F.SpecError as e:
                add(f"SPEC-{el['id']}", "schematic_spec", "blocked", str(e))
        elif t == "lattice":
            try:
                F.lattice_geometry(spec, el)
            except F.SpecError as e:
                add(f"SPEC-{el['id']}", "schematic_spec", "blocked", str(e))
        elif t == "path":
            try:
                p_cmds = F.parse_svg_path_d(el["d"], el["id"])
                if not all(F.inside((px, py, 0, 0), canvas) for px, py in F.path_points(p_cmds)):
                    if not any(i["id"] == f"OUT-{el['id']}" for i in items):
                        add(f"OUT-{el['id']}", "schematic_layout", "blocked", f"路径 {el['id']} 超出画布")
            except F.SpecError as e:
                add(f"SPEC-{el['id']}", "schematic_spec", "blocked", str(e))

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
        txt_hex = st.color[0] if st.color else "222222"
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
        raw_text = lay.get("raw_text", "")
        bad = F.leftover_markup(raw_text)
        if bad:
            add(f"MARKUP-{lid}", "schematic_text", "blocked",
                f"{owner} 的标记没认出来，会原样印在图上：「{bad[0][:30]}」（粗体 **…**、下标 _{{…}}、上标 ^{{…}} 要成对）")
        n_text += 1
        # 图上文字要有出处（放行 decorative 元素、≤4 字符微标签、纯化学式/离子/反应式、标准坐标轴物理量、阶段序号，并支持关键词+数值覆盖）
        own_el = index.get(owner)
        if source_text and not (own_el and own_el.get("decorative")):
            for piece in raw_text.split("\n"):
                if not piece.strip():
                    continue
                if is_exempt_label(piece):
                    continue
                n_pieces += 1
                if not source_matched(piece, src_norm, source_text):
                    n = norm(piece)
                    add(f"SOURCE-{lid}-{hashlib.sha1(n.encode()).hexdigest()[:6]}", "schematic_source", "blocked",
                        f"{owner} 的文字在 brief.md / facts.md 里找不到原文：「{F.plain_text(piece).strip()[:50]}」——先把它写进事实记录（带出处），或改成记录里的说法",
                        quote=piece.strip()[:200])
        # 跨进别的框 / 压在背板或主视觉底图上（局部对比度达标则放行）
        for el in spec["elements"]:
            if el["id"] == owner or el["type"] in F.LINES:
                continue
            r = F.bbox(el)
            if el["type"] in ("box", "header_card", "hero_panel", "ellipse", "sphere") and F.rects_overlap(ink, r, 0.2) and not F.inside(ink, r) and not F.inside(r, ink):
                own = index.get(owner)
                if own and own["type"] in ("text", "callout") and F.inside(F.bbox(own), r):
                    continue
                bg_hex = effective_fill_hex(spec, el, canvas_bg)
                stroke_col = F.color(spec, el.get("stroke", "none"))
                soft_backdrop = (
                    el.get("role") in ("backdrop", "panel", "zone")
                    or el["type"] in ("hero_panel", "header_card")
                    or (F.luminance(bg_hex) >= 220 and (stroke_col is None or F.luminance(stroke_col[0]) >= 185 or not hits_border_edge(ink, r)))
                )
                high_contrast = (
                    F.wcag_contrast(txt_hex, bg_hex) >= 3.5
                    or F.michelson_contrast(F.luminance(txt_hex), F.luminance(bg_hex)) >= 0.50
                )
                if soft_backdrop and high_contrast and not (stroke_col and F.luminance(stroke_col[0]) < 160 and hits_border_edge(ink, r)):
                    continue
                add(f"CROSS-{lid}-{el['id']}", "schematic_layout", "blocked", f"{owner} 的文字一半压在 {el['id']} 的边框上（「{short}」）")
            if el["type"] in ("image", "figure", "hero_panel"):
                img_r = image_rects.get(el["id"], r)
                if F.rects_overlap(ink, img_r, 0.2):
                    own = index.get(owner)
                    if own and own["type"] in ("box", "header_card", "callout", "chevron", "ellipse", "sphere"):
                        own_fill = F.color(spec, own.get("fill", "#FFFFFF" if own["type"] == "header_card" else "none"))
                        if own_fill and own_fill[1] >= 0.85 and F.wcag_contrast(txt_hex, own_fill[0]) >= 3.5:
                            continue
                    # 位图采样局部对比度：落在干净浅色留白区且对比度达标时不误报 ONIMG
                    if el["id"] in raster_cache:
                        im_cached = raster_cache[el["id"]][0]
                        bg_under = effective_fill_hex(spec, el, canvas_bg) if el["type"] == "hero_panel" else canvas_bg
                        if image_patch_clean_contrast(im_cached, img_r, ink, txt_hex, bg_under):
                            continue
                    add(f"ONIMG-{lid}-{el['id']}", "schematic_layout", "needs_human", f"{owner} 的文字压在图片 {el['id']} 上，背景杂时看不清")
        # 标签像句子（期刊示意图）
        if cv["purpose"] == "journal" and not lid.endswith("#label"):
            for l in lay["lines"]:
                line = "".join(r[0] for r in l["runs"])
                words = len(re.findall(r"[A-Za-z]+", line)) + len([c for c in line if F.is_cjk(c)]) / 2
                if words >= 6 and re.search(r"[:：]", line) and not is_chem_formula_or_eq(line.split(":", 1)[-1].split("：", 1)[-1]):
                    add(f"SENTENCE-{lid}", "schematic_text", "needs_human", f"{owner} 的标签像一句话（「{line[:30]}」）：期刊示意图标签用 2–4 词名词短语，解释进图注")
                    break

    if source_text and n_pieces and not any(i["id"].startswith("SOURCE-") for i in items):
        add("SOURCE", "schematic_source", "passed", f"图上 {n_pieces} 段核心文字都在 brief.md / facts.md 里找到了原文")
    # 文字两两相交
    keys = list(inks)
    for i, k1 in enumerate(keys):
        for k2 in keys[i + 1:]:
            if F.rects_overlap(inks[k1], inks[k2], 0.1):
                add(f"CLASH-{k1}-{k2}", "schematic_text", "blocked", f"{k1.split('#')[0]} 与 {k2.split('#')[0]} 的文字互相压住")

    if n_text and not any(i["id"].split("-")[0] in ("CLASH", "OVERFLOW", "OFFCANVAS", "CROSS", "MINPT", "GLYPH", "MARKUP") for i in items):
        add("TEXT", "schematic_text", "passed", f"{n_text} 个文字块都没有相交、出框、缺字，字号不低于 {mp:g} pt")

    # 连线与引出线穿过文字检查
    drawn = set()
    for el in spec["elements"]:
        if el["type"] == "callout":
            try:
                cg = F.callout_geometry(spec, el, index, image_rects)
                c_pts = cg["pts"]
                for lid, ink in inks.items():
                    if lid.split("#")[0] == el["id"]:
                        continue
                    if any(seg_hits_rect(p, q, ink) for p, q in zip(c_pts, c_pts[1:])):
                        add(f"THROUGH-{el['id']}-{lid}", "schematic_layout", "needs_human", f"引出线 {el['id']} 穿过 {lid.split('#')[0]} 的文字")
            except F.SpecError:
                pass
            continue
        if el["type"] not in F.LINES:
            continue
        try:
            pts, ctrl, (n1, _), (n2, _), branches = R.line_curve_info(spec, el, index, image_rects)
        except F.SpecError as e:
            add(f"LINE-{el['id']}", "schematic_layout", "blocked", str(e))
            continue
        if not all(F.inside((px, py, 0, 0), canvas) for px, py in pts):
            add(f"LINEOUT-{el['id']}", "schematic_layout", "blocked", f"连线 {el['id']} 出了画布")
        for br in branches:
            bpts = F.quad_points(br["p1"], br["ctrl"], br["p2"], 12)
            if not all(F.inside((px, py, 0, 0), canvas) for px, py in bpts):
                add(f"LINEOUT-{el['id']}-{br['sub_id']}", "schematic_layout", "blocked", f"耦合支路 {el['id']}#{br['sub_id']} 出了画布")
        head = el.get("head", "end" if el["type"] in ("arrow", "coupled_arrow") else "none")
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
            if lid.split("#")[0] in ends or lid.startswith(el["id"] + "#"):
                continue
            if any(seg_hits_rect(p, q, ink) for p, q in zip(pts, pts[1:])):
                add(f"THROUGH-{el['id']}-{lid}", "schematic_layout", "needs_human", f"连线 {el['id']} 穿过 {lid.split('#')[0]} 的文字")

    # facts.md 里写明的关系
    if facts.is_file():
        def elem_texts(e):
            out = [e.get("text", "")]
            hd = e.get("header")
            if isinstance(hd, dict) and hd.get("text"):
                out.append(hd["text"])
            elif isinstance(hd, str):
                out.append(hd)
            return [x for x in out if x]

        def find(token):
            token = token.strip().strip("`")
            if token in index:
                return token
            t = norm(token)
            if not t:
                return None
            shapes = [e for e in spec["elements"] if e["type"] in ("box", "header_card", "hero_panel", "ellipse", "sphere", "chevron")]
            others = [e for e in spec["elements"] if e["type"] in F.SHAPES and e not in shapes]
            for pool in (shapes, others):
                for exact in (True, False):
                    hits = [
                        e["id"] for e in pool
                        if any((norm(tx) == t if exact else t in norm(tx)) for tx in elem_texts(e))
                    ]
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

    # 图片与主视觉底图素材
    chk_assets = R.Assets(fig_dir, R.Raster(probe=False))
    try:
        for el in spec["elements"]:
            if el["type"] not in ("image", "figure", "hero_panel"):
                continue
            try:
                path, ext = chk_assets.resolve(el)
            except F.SpecError as e:
                add(f"IMG-{el['id']}", "schematic_asset", "blocked", str(e))
                continue
            if ext in ("png", "jpg", "jpeg", "webp") and el["id"] in raster_cache:
                im = raster_cache[el["id"]][0]
                iw, ih = im.size
                slot = F.hero_slot(spec, el) if el["type"] == "hero_panel" else (el["x"], el["y"], el["w"], el["h"])
                scale = min(slot[2] / iw, slot[3] / ih)
                ppi = 25.4 / scale if scale > 0 else 9999
                need = 150 if cv["purpose"] in ("slide", "poster") else 300
                if ppi < need:
                    add(f"PPI-{el['id']}", "schematic_asset", "blocked",
                        f"{el['id']} 在成品尺寸下只有 {ppi:.0f} ppi（要 ≥ {need}）：换更大的图、缩小这个位，或用 --resolution 2k 重出", R.rel(path, root))
                src = el.get("source") or {}
                if src.get("kind") == "image-model" and el["type"] == "image":
                    has_alpha = im.mode in ("RGBA", "LA") and im.getextrema()[-1][0] < 250
                    if not has_alpha:
                        add(f"ALPHA-{el['id']}", "schematic_asset", "needs_human", f"出图模型画的 {el['id']} 不是透明底，放在色块上会有白底", R.rel(path, root))
    finally:
        shutil.rmtree(chk_assets.tmp, ignore_errors=True)

    # 组图：每块缩放后的最小字号、同排面板字母是否对齐
    figs = [el for el in spec["elements"] if el["type"] == "figure"]
    fig_assets = R.Assets(fig_dir, R.Raster(probe=False))
    try:
        for el in figs:
            try:
                path, ext = fig_assets.resolve(el)
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
    finally:
        shutil.rmtree(fig_assets.tmp, ignore_errors=True)

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

    # 字体、栏宽、配色（合并灰度/红绿提醒为单条 GRAY-PAIR，避免刷屏）
    if len(fams_latin) > 1 or len(fams_cjk) > 1:
        add("FONTS", "schematic_style", "needs_human", f"用了多种字体：{'、'.join(sorted(fams_latin | fams_cjk))}——一般西文、中文各一种")
    if cv["purpose"] == "journal" and not any(abs(cv["width_mm"] - w) < 1 for w in JOURNAL_WIDTHS):
        add("WIDTH", "schematic_style", "needs_human", f"画布宽 {cv['width_mm']:g} mm 不是常见栏宽（单栏 85–90、1.5 栏 120–136、双栏 174–190）：按目标期刊作者指南核对")

    def rect_distance(a, b):
        dx = max(0.0, a[0] - (b[0] + b[2]), b[0] - (a[0] + a[2]))
        dy = max(0.0, a[1] - (b[1] + b[3]), b[1] - (a[1] + a[3]))
        return math.hypot(dx, dy)

    def rgb_distance(h1, h2):
        c1 = [int(h1[i:i + 2], 16) for i in (0, 2, 4)]
        c2 = [int(h2[i:i + 2], 16) for i in (0, 2, 4)]
        return math.sqrt(sum((a - b) ** 2 for a, b in zip(c1, c2)))

    fills = {}  # hex6 -> list of (label_id, bbox, stroke_hex_or_None)
    for el in spec["elements"]:
        if el["type"] in ("box", "header_card", "ellipse", "sphere", "chevron", "polygon", "path"):
            r_el = F.bbox(el)
            st_c = F.color(spec, el.get("stroke", "border" if (el["type"] == "header_card" and "border" in spec["theme"]["colors"]) else "none"))
            st_pt = float(el.get("stroke_pt", spec["theme"]["line_pt"]))
            st_hex = blend_over_bg(st_c, canvas_bg) if (st_c and st_pt >= 0.4 and st_c[1] >= 0.4) else None
            c = F.color(spec, el.get("fill", "none"))
            eff = blend_over_bg(c, canvas_bg) if c else None
            if c and eff and eff != canvas_bg and c[1] >= 0.35 and F.luminance(eff) < 208:
                fills.setdefault(eff, []).append((el["id"], r_el, st_hex))
            hd = F.header_spec(spec, el) if el["type"] in ("box", "header_card") else None
            if hd and hd.get("fill"):
                hc = hd["fill"]
                heff = blend_over_bg(hc, canvas_bg)
                if heff != canvas_bg and hc[1] >= 0.35 and F.luminance(heff) < 208:
                    fills.setdefault(heff, []).append((el["id"] + "#header", (r_el[0], r_el[1], r_el[2], hd["h"]), st_hex))

    def hue_class(h6):
        r, g, b = (int(h6[i:i + 2], 16) / 255 for i in (0, 2, 4))
        h, l, s = colorsys.rgb_to_hls(r, g, b)
        if s < 0.25:
            return None
        h *= 360
        return "red" if h < 25 or h > 335 else "green" if 75 < h < 165 else None

    cols = list(fills)
    gray_pairs = []
    for i, c1 in enumerate(cols):
        for c2 in cols[i + 1:]:
            redgreen = {hue_class(c1), hue_class(c2)} == {"red", "green"}
            if not (abs(F.luminance(c1) - F.luminance(c2)) < 9 or redgreen):
                continue
            # 仅对空间相邻/嵌套（间距 ≤ 20 mm）且未靠明显不同边框色（stroke）区分的色块提示
            hit_pair = None
            for id1, r1, st1 in fills[c1]:
                for id2, r2, st2 in fills[c2]:
                    if rect_distance(r1, r2) > 20.0:
                        continue
                    if st1 and st2 and rgb_distance(st1, st2) >= 42.0:
                        continue
                    hit_pair = (id1, id2)
                    break
                if hit_pair:
                    break
            if hit_pair:
                reason = "红绿对比" if redgreen else "灰度接近"
                gray_pairs.append(f"{hit_pair[0]}↔{hit_pair[1]}（{reason}）")
    if gray_pairs:
        preview = "、".join(gray_pairs[:3]) + (f" 等 {len(gray_pairs)} 组" if len(gray_pairs) > 3 else "")
        add("GRAY-PAIR", "schematic_style", "needs_human",
            f"色块 {preview} 在黑白打印或红绿色盲下不易单靠颜色区分：已配文字标签、图标或线型区分即可")

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
            rb_assets = R.Assets(fig_dir, R.Raster(probe=False))
            try:
                svg_now = R.build_svg(spec, layouts, rb_assets, index, image_rects)
            finally:
                shutil.rmtree(rb_assets.tmp, ignore_errors=True)
            same = svg_now == svg_path.read_text(encoding="utf-8")
            if same:
                add("REBUILD", "schematic_rebuild", "passed", "图纸重建出的 SVG 与现有文件一致", R.rel(svg_path, root))
            else:
                svg_recorded = (rec.get("outputs") or {}).get("svg")
                svg_intact = bool(svg_recorded) and svg_recorded == F.file_digest(svg_path)
                asset_changed = False
                svg_mtime = svg_path.stat().st_mtime
                for el in spec.get("elements", []):
                    src = el.get("src") or ""
                    if el.get("type") in ("hero_panel", "image", "figure", "icon") and src and not src.startswith("lib:"):
                        try:
                            ap, _ = rb_assets.resolve(el)
                            if ap.stat().st_mtime > svg_mtime + 1.0:
                                asset_changed = True
                                break
                        except Exception:
                            asset_changed = True
                            break
                if svg_intact and not asset_changed:
                    add("REBUILD", "schematic_rebuild", "needs_human",
                        f"图纸与上次渲染记录一致，但当前渲染器或本机字体算出的 SVG 有细微差异：现图满意可保留，想同步新版样式可重跑 render_figure.py {srel}",
                        R.rel(svg_path, root))
                else:
                    add("REBUILD", "schematic_rebuild", "blocked",
                        f"图纸重建出的 SVG 与现有文件不一致（引用素材改过或渲染未同步）：重跑 render_figure.py {srel}",
                        R.rel(svg_path, root))
        ai = rec.get("ai_elements") or []
        if ai:
            add("AI-USE", "schematic_disclosure", "needs_human",
                f"图里有 {len(ai)} 个出图模型画的元素（{'、'.join(x['id'] + '：' + x['model'] for x in ai)}）：图注或方法里注明 AI 生成，并查目标期刊对 AI 图像的政策")

    add("COLD-READ", "schematic_review", "needs_human",
        "多模态冷读与事实核对：用看图工具检查成品 PNG——视觉主体是否饱满（占面板 60%–75%）、四周留白是否均匀、引出线圆点是否指准对应结构位点、反应方向与数值是否忠于 brief.md / facts.md？（几何检查全过不等于图好看且准确）",
        R.rel(fig_dir / f"{name}.png", root))
    path = C.write_items(root, f"schematic-{name}.jsonl", items)
    return C.summary(items, path)


if __name__ == "__main__":
    sys.exit(main())
