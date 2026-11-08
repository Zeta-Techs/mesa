#!/usr/bin/env python3
"""投稿前检查（research-writing / review-writing 技能随包，2026-11-08）：只读稿件，查投稿前最容易漏的几类硬伤。

  python3 ms_check.py [稿件 ...] [--root <工作目录>]
稿件可以是 .md / .qmd / .tex / .docx；不给就扫 manuscript/ 下的 md / qmd / tex（docx 要点名）。

查这几样：
  作者名 ↔ 邮箱      邮箱用户名和作者名拼写差一两个字母（以邮箱为准，多半是名字打错）→ 待你判断
  标题编号          Markdown 开了 number-sections 又手写「## 1.」→ 拦下（会编两次号）；Word 里自动编号和手打编号混用 → 待你判断
  图表编号          图注 / 表题编号重复或跳号 → 拦下
  图注出处          「Adapted / Reproduced from」后面没有引文或 Ref. → 待你判断
  重复词与固定语病   the the、terms of with 一类 → 待你判断
  符号与单位写法     同一单位几种写法并存（mAh g−1 / mA h g-1 / mAh/g；°C / oC；连字符当负号）→ 待你判断
  连接号            同一对符号一会儿 en dash 一会儿连字符（Mg–S / Mg-S）→ 待你判断
  英美拼写          behavior / behaviour 一类混用 → 待你判断
  结论节            没有 Conclusion(s) / Summary / Outlook / 结论 一节 → 待你判断
结果写进 <工作目录>/.ccode/checks/ms-check.jsonl（三档）。只读，不改稿件。
退出码：0 没有拦下的；1 有拦下的；2 一份稿件都没读到。Windows 上把 python3 换成 python。
"""
from __future__ import annotations

import argparse
import difflib
import importlib.util
import re
import sys
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


def load_common():
    here = Path(__file__).resolve()
    for path in (here.parent / "mesa_checks.py", here.parents[3] / "mesa_checks.py"):
        if path.is_file():
            spec = importlib.util.spec_from_file_location("mesa_checks", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise FileNotFoundError("找不到 mesa_checks.py（应与本脚本同目录）。在技能页更新技能后再试")


C = load_common()
CHECKER = "script:ms_check"
CHECK_FILE = "ms-check.jsonl"
SKIP = re.compile(r"(citation-check|review-report|verification-decisions|declarations|checklist|evidence|numbers|"
                  r"section-status|changelog|revision-notes|outline)", re.I)
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
# 「Figure 1.」「Figure 1 |」「Figure 2 Schematic…」「Figure 1 (a)…」是图注；「Figure 4a shows…」「Figure 4 shows…」是正文
CAPTION = re.compile(r"^\s*(?:\*\*)?(Figure|Fig\.|Table|Scheme)\s+(S?\d+)(?:\*\*)?(?:[.:|]|\s+(?=[A-Z(]))")
SOURCE_PHRASE = re.compile(r"\b(?:Adapted|Reproduced|Reprinted|Modified|Redrawn)\s+(?:with permission\s+)?from\b[^.;]*", re.I)
CITE_MARK = re.compile(r"\[@|\\cite|\bRef(?:s)?\.\s*\d|\[\d|\(\w[^()]*\d{4}[a-z]?\)|\bref\.\s*\d|\d+\s*$|[¹²³⁴⁵⁶⁷⁸⁹⁰]")
DOUBLED = re.compile(r"\b([A-Za-z]{2,})\s+\1\b", re.I)
DOUBLED_OK = {"that", "had", "is", "very", "bye"}
LATIN_AFTER_IN = re.compile(r"\s*(?:situ|vivo|vitro|silico|operando)\b", re.I)
FIXED_SLIPS = [r"\bterms of with\b", r"\bin order to to\b", r"\bdue to the fact of\b", r"\bcompared to with\b",
               r"\bbased in on\b", r"\ba the\b", r"\bthe a\b", r"\bof of\b"]
CONCLUSION = re.compile(r"\b(?:conclusions?|summary|outlook|concluding remarks|perspectives?)\b|结论|总结|展望", re.I)
HAND_NUMBER = re.compile(r"^\s*(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+\S")

# 同一单位的几种写法：键是单位，值是 [(写法说明, 正则)]
UNIT_FAMILIES = {
    "比容量 mA h g⁻¹": [
        ("mAh g-1（连在一起）", r"\bmAh\s*g\s*[-−–]\s*1\b"),
        ("mA h g-1（分开写）", r"\bmA\s+h\s*g\s*[-−–]\s*1\b"),
        ("mAh/g", r"\bmA\s?h\s*/\s*g\b"),
    ],
    "能量密度 Wh kg⁻¹": [
        ("Wh kg-1", r"\bWh\s*kg\s*[-−–]\s*1\b"),
        ("W h kg-1", r"\bW\s+h\s*kg\s*[-−–]\s*1\b"),
        ("Wh/kg", r"\bW\s?h\s*/\s*kg\b"),
    ],
    "电流密度 mA cm⁻²": [
        ("mA cm-2", r"\bmA\s*cm\s*[-−–]\s*2\b"),
        ("mA/cm2", r"\bmA\s*/\s*cm\s*2\b|\bmA\s*/\s*cm²"),
    ],
    "摄氏度": [("°C", r"°\s?C\b"), ("℃", r"℃"), ("oC / 0C", r"(?<=\d)\s?[o0]C\b")],
    "约等于": [("≈", r"≈\s?\d"), ("~（波浪号）", r"(?<![\w~])~\s?\d"), ("ca.", r"\bca\.\s?\d"), ("approx.", r"\bapprox\.\s?\d")],
}
NEG_EXPONENT = {"负号（−）": r"[A-Za-z]\s?−\s?[123]\b", "连字符（-）": r"\b(?:g|kg|cm|mol|L|s|h)\s?-\s?[123]\b(?!\s*[A-Za-z]{2})"}

US_UK = [
    ("behavior", "behaviour"), ("color", "colour"), ("center", "centre"), ("fiber", "fibre"), ("analyze", "analyse"),
    ("analyzed", "analysed"), ("characterization", "characterisation"), ("optimization", "optimisation"),
    ("stabilization", "stabilisation"), ("utilization", "utilisation"), ("polarization", "polarisation"),
    ("crystallization", "crystallisation"), ("organization", "organisation"), ("modeling", "modelling"),
    ("labeled", "labelled"), ("sulfur", "sulphur"), ("aluminum", "aluminium"), ("favorable", "favourable"),
    ("catalyze", "catalyse"), ("catalyzed", "catalysed"), ("gray", "grey"), ("liter", "litre"), ("meter", "metre"),
]


def item(*args, **kwargs):
    return C.item(CHECKER, *args, **kwargs)


def norm(s):
    s = unicodedata.normalize("NFKD", s)
    return "".join(ch for ch in s.lower() if "a" <= ch <= "z")


# ---------- 读稿 ----------

class Para:
    def __init__(self, text, line, heading=False, auto_number=False, level=0):
        self.text, self.line, self.heading, self.auto_number, self.level = text, line, heading, auto_number, level


def read_text_doc(path: Path):
    text = path.read_text(encoding="utf-8")
    front, body_start = "", 0
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end > 0:
            front = text[3:end]
            body_start = text[: end + 4].count("\n")
    paras, fenced = [], False
    lines = text.splitlines()
    for no, line in enumerate(lines[body_start:], body_start + 1):
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
            continue
        if fenced or not line.strip():
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line) if path.suffix != ".tex" else None
        t = re.match(r"\\(?:sub)*section\*?\{(.*)\}", line.strip()) if path.suffix == ".tex" else None
        if m:
            paras.append(Para(m.group(2).strip(), no, heading=True, level=len(m.group(1))))
        elif t:
            paras.append(Para(t.group(1).strip(), no, heading=True, auto_number=True))
        else:
            paras.append(Para(line.strip(), no))
    return front, paras


def read_docx(path: Path):
    with zipfile.ZipFile(path) as zf:
        root = ET.fromstring(zf.read("word/document.xml"))
        styles = ET.fromstring(zf.read("word/styles.xml")) if "word/styles.xml" in zf.namelist() else None
    numbered_styles, heading_styles = set(), set()
    if styles is not None:
        for st in styles.iter(W + "style"):
            sid = st.get(W + "styleId", "")
            name = st.find(W + "name")
            label = (name.get(W + "val", "") if name is not None else "") + " " + sid
            ppr = st.find(W + "pPr")
            if re.search(r"heading|标题", label, re.I) or (ppr is not None and ppr.find(W + "outlineLvl") is not None):
                heading_styles.add(sid)
            if ppr is not None and ppr.find(W + "numPr") is not None:
                numbered_styles.add(sid)
    paras = []
    for i, p in enumerate(root.iter(W + "p"), 1):
        text = "".join(t.text or "" for t in p.iter(W + "t"))
        if not text.strip():
            continue
        ppr = p.find(W + "pPr")
        sid = ""
        has_num = False
        if ppr is not None:
            ps = ppr.find(W + "pStyle")
            sid = ps.get(W + "val", "") if ps is not None else ""
            num = ppr.find(W + "numPr")
            has_num = num is not None and (num.find(W + "numId") is None or num.find(W + "numId").get(W + "val") != "0")
        heading = sid in heading_styles or bool(re.match(r"(?i)heading|标题", sid))
        runs = [r for r in p.iter(W + "r") if "".join(t.text or "" for t in r.iter(W + "t")).strip()]
        bold = bool(runs) and all(bold_run(r) for r in runs)
        paras.append(Para(text.strip(), i, heading=heading, auto_number=has_num or sid in numbered_styles))
        paras[-1].bold_short = bold and len(text.strip()) < 150 and not text.strip().endswith(".")
    # 很多稿件不用标题样式、标题只是加粗的短段：一个标题样式都没有时按这个认
    if not any(p.heading for p in paras):
        for p in paras[1:]:
            p.heading = getattr(p, "bold_short", False)
    return "", paras


def bold_run(r):
    rpr = r.find(W + "rPr")
    b = rpr.find(W + "b") if rpr is not None else None
    return b is not None and b.get(W + "val", "true") not in ("0", "false")


# ---------- 各项检查 ----------

def front_authors(front):
    names = [m.strip().strip("\"'") for m in re.findall(r"^\s*-?\s*name:\s*(.+)$", front, re.M)]
    if not names:
        m = re.search(r"^author:\s*(.+)$", front, re.M)
        if m and m.group(1).strip() not in ("", "|", ">"):
            names = [a.strip().strip("\"'") for a in re.split(r",|\band\b", m.group(1)) if a.strip()]
        else:
            names = [a.strip().strip("\"'") for a in re.findall(r"^\s*-\s*[\"']?([A-Z][^:\n]+?)[\"']?\s*$", front, re.M)]
    return [n for n in names if 1 < len(n.split()) <= 5]


def docx_authors(paras):
    """标题之后、Abstract 之前的段落里像人名的片段（大写开头的 2–4 个词）。"""
    out = []
    for p in paras[1:15]:
        if re.match(r"(?i)abstract|摘要|keywords", p.text):
            break
        if EMAIL.search(p.text) or len(p.text) > 300:
            continue
        for seg in re.split(r",|;|\band\b|\d|\*|†|‡|§", p.text):
            seg = re.sub(r"^(?:[a-z]\s+)+", "", seg.strip())  # 「a Tianbao Ma」前面的单位上标字母
            if re.fullmatch(r"(?:[A-Z][\w'’\-]*\.?\s+){1,3}[A-Z][\w'’\-]+", seg):
                out.append(seg)
    return out


def is_subseq(short, long):
    it = iter(long)
    return all(ch in it for ch in short)


def initials_match(letters, ps):
    """拼音名常用「姓 + 名的各字首字母」：haozx ↔ Zhangxiang Hao、zxhao。名的部分要以名的首字母开头、按顺序出现在名里。"""
    if len(ps) < 2:
        return False
    family, given = ps[-1], "".join(ps[:-1])
    for rest in (letters[len(family):] if letters.startswith(family) else None,
                 letters[: -len(family)] if letters.endswith(family) else None):
        # 「lin」对「ling」是名字前几个字母、少了一个——这是拼写差一点，不算首字母缩写
        if rest and len(rest) <= 4 and rest[0] == given[0] and is_subseq(rest, given) and not given.startswith(rest):
            return True
    return False


def check_authors(rel, front, paras, items):
    text = "\n".join([front] + [p.text for p in paras])
    emails = sorted(set(EMAIL.findall(text)))
    authors = front_authors(front) if front else docx_authors(paras)
    if not emails or not authors:
        return
    parts = {a: [norm(x) for x in re.split(r"[\s\-]+", a) if norm(x)] for a in authors}
    for email in emails:
        local = email.split("@")[0]
        tokens = [norm(t) for t in re.split(r"[._\-\d]+", local) if len(norm(t)) >= 3]
        letters = norm(local)
        exact = False
        near = []
        for a, ps in parts.items():
            combos = {"".join(ps), "".join(reversed(ps))}
            if len(ps) >= 2:
                combos |= {ps[0][0] + ps[-1], ps[-1] + ps[0][0], "".join(x[0] for x in ps[:-1]) + ps[-1]}
            if letters in combos or any(t in ps for t in tokens) or initials_match(letters, ps):
                exact = True
                break
            for t in tokens + [letters]:
                for x in list(ps) + list(combos):
                    r = difflib.SequenceMatcher(None, t, x).ratio()
                    if len(x) >= 4 and 0.75 <= r < 1:
                        near.append((r, a, t, x))
        if exact:
            continue
        if near:
            r, a, t, x = max(near)
            items.append(item(f"AUTHOR-{local}", "author-email", "needs_human",
                              f"作者名「{a}」与邮箱 {email} 拼写差一点（{x} / {t}）", rel,
                              detail="一般以邮箱为准，核对作者名是不是打错了"))


def check_heading_numbers(rel, front, paras, items, is_docx):
    heads = [p for p in paras if p.heading]
    if not heads:
        return
    hand = [p for p in heads if HAND_NUMBER.match(p.text)]
    if is_docx:
        auto = [p for p in heads if p.auto_number]
        if hand and auto:
            items.append(item("HEAD-NUM", "headings", "needs_human",
                              f"标题编号混用：{len(auto)} 个是 Word 自动编号，{len(hand)} 个是手打的编号", rel,
                              detail="手打的：" + "；".join(p.text[:40] for p in hand[:6])
                                     + "。改编号或删节时手打的不会跟着变，统一成一种"))
        return
    numbered = bool(re.search(r"^\s*number-sections:\s*true", front, re.M))
    if numbered and hand:
        p = hand[0]
        items.append(item("HEAD-NUM", "headings", "blocked",
                          f"开了 number-sections 又手写了标题编号（{len(hand)} 处），渲染后会编两次号", rel, p.line,
                          detail="；".join(h.text[:40] for h in hand[:6]) + "。删掉手写的编号"))


def check_captions(rel, paras, items):
    seen = {}
    for p in paras:
        m = CAPTION.match(p.text)
        if not m:
            continue
        kind = "Table" if m.group(1).lower().startswith("tab") else ("Scheme" if m.group(1).lower() == "scheme" else "Figure")
        num = m.group(2).upper()
        seen.setdefault(kind, []).append((num, p))
        src = SOURCE_PHRASE.search(p.text)
        if src and not CITE_MARK.search(p.text[src.start():]):
            items.append(item(f"CAP-SRC-{kind}{num}-{p.line}", "caption-source", "needs_human",
                              f"{kind} {num} 的图注写了「{src.group(0)[:40]}」，后面没有引文或 Ref. 编号", rel, p.line,
                              detail="借用的图要在图注里写清出处，并按出版社要求写许可说明"))
    for kind, lst in seen.items():
        main = [n for n, _ in lst if not n.startswith("S")]
        nums = [int(n) for n in main]
        dup = sorted({n for n in nums if nums.count(n) > 1})
        missing = sorted(set(range(1, max(nums) + 1)) - set(nums)) if nums else []
        if dup or missing:
            detail = []
            if dup:
                detail.append("重复：" + "、".join(map(str, dup)))
            if missing:
                detail.append("缺：" + "、".join(map(str, missing)))
            items.append(item(f"CAP-NUM-{kind}", "caption-number", "blocked",
                              f"{kind} 的编号{'重复' if dup else ''}{'、' if dup and missing else ''}{'跳号' if missing else ''}", rel,
                              detail="；".join(detail) + "（按图注 / 表题里的编号数）"))
        elif nums:
            items.append(item(f"CAP-NUM-{kind}", "caption-number", "passed", f"{kind} 1–{max(nums)} 编号连续、不重复", rel))


def check_slips(rel, paras, items):
    for p in paras:
        for m in DOUBLED.finditer(p.text):
            if m.group(1).lower() in DOUBLED_OK:
                continue
            # 「in in situ XRD」不是重复
            if m.group(1).lower() == "in" and LATIN_AFTER_IN.match(p.text[m.end():]):
                continue
            items.append(item(f"SLIP-{p.line}-{m.start()}", "language-slip", "needs_human",
                              f"重复词「{m.group(0)}」", rel, p.line, quote=p.text[max(0, m.start() - 40): m.end() + 40]))
        for pat in FIXED_SLIPS:
            for m in re.finditer(pat, p.text, re.I):
                items.append(item(f"SLIP-{p.line}-{m.start()}", "language-slip", "needs_human",
                                  f"疑似语病「{m.group(0)}」", rel, p.line, quote=p.text[max(0, m.start() - 40): m.end() + 40]))


def check_units(rel, paras, items):
    body = "\n".join(p.text for p in paras)
    for unit, variants in UNIT_FAMILIES.items():
        counts = [(label, len(re.findall(pat, body))) for label, pat in variants]
        used = [(l, n) for l, n in counts if n]
        if len(used) > 1:
            items.append(item(f"UNIT-{unit}", "units", "needs_human", f"{unit} 有 {len(used)} 种写法", rel,
                              detail="；".join(f"{l} {n} 处" for l, n in used) + "。按目标期刊的写法统一成一种"))
    neg = [(l, len(re.findall(p, body))) for l, p in NEG_EXPONENT.items()]
    if all(n for _, n in neg):
        items.append(item("UNIT-NEG", "units", "needs_human", "单位指数里的负号与连字符混用", rel,
                          detail="；".join(f"{l} {n} 处" for l, n in neg) + "。上标负号统一用 −（U+2212）或期刊模板的写法"))


def check_dashes(rel, paras, items):
    body = "\n".join(p.text for p in paras)
    pairs = {}
    for m in re.finditer(r"\b([A-Z][a-z]?)([-–—/])([A-Z][a-z]?)\b(?![-–])", body):
        pairs.setdefault((m.group(1), m.group(3)), {}).setdefault(m.group(2), 0)
        pairs[(m.group(1), m.group(3))][m.group(2)] += 1
    names = {"-": "连字符 -", "–": "en dash –", "—": "em dash —", "/": "斜杠 /"}
    for (a, b), marks in pairs.items():
        if len([k for k in marks if k in "-–—"]) > 1:
            items.append(item(f"DASH-{a}{b}", "dashes", "needs_human", f"{a}–{b} 的连接号写法不一", rel,
                              detail="；".join(f"{names[k]} {n} 处" for k, n in marks.items()) + "。电池体系、化学键一类通常用 en dash"))


def check_spelling(rel, paras, items):
    body = " ".join(p.text for p in paras).lower()
    us = {a: len(re.findall(rf"\b{a}s?\b", body)) for a, _ in US_UK}
    uk = {b: len(re.findall(rf"\b{b}s?\b", body)) for _, b in US_UK}
    us_n, uk_n = sum(us.values()), sum(uk.values())
    if us_n and uk_n:
        main, other = ("美式", "英式") if us_n >= uk_n else ("英式", "美式")
        minority = [f"{b}（{uk[b]}）" for _, b in US_UK if uk[b]] if us_n >= uk_n else [f"{a}（{us[a]}）" for a, _ in US_UK if us[a]]
        items.append(item("SPELL-MIX", "spelling", "needs_human", f"英美拼写混用：{main} {max(us_n, uk_n)} 处、{other} {min(us_n, uk_n)} 处", rel,
                          detail=f"少数一方：{'、'.join(minority[:10])}。按目标期刊统一"))
    elif us_n or uk_n:
        items.append(item("SPELL-MIX", "spelling", "passed", f"拼写统一用{'美式' if us_n else '英式'}（查了 {len(US_UK)} 组常见词）", rel))


def check_conclusion(rel, paras, items):
    heads = [p for p in paras if p.heading]
    if not heads:
        return
    hit = next((p for p in heads if CONCLUSION.search(p.text)), None)
    if hit:
        items.append(item("CONCLUSION", "structure", "passed", f"有结论 / 展望节「{hit.text[:40]}」", rel, hit.line))
    else:
        items.append(item("CONCLUSION", "structure", "needs_human", "没有找到结论节（Conclusion / Summary / Outlook / 结论）", rel,
                          detail="综述和研究论文一般都要有；期刊不要求时可忽略"))


def check_file(path: Path, root: Path):
    try:
        rel = path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        rel = path.name
    try:
        front, paras = read_docx(path) if path.suffix.lower() == ".docx" else read_text_doc(path)
    except (OSError, UnicodeDecodeError, zipfile.BadZipFile, KeyError, ET.ParseError) as e:
        return [item(f"READ-{rel}", "structure", "needs_human", f"读不了 {rel}：{e}", rel)], False
    items = []
    is_docx = path.suffix.lower() == ".docx"
    check_authors(rel, front, paras, items)
    check_heading_numbers(rel, front, paras, items, is_docx)
    check_captions(rel, paras, items)
    check_slips(rel, paras, items)
    check_units(rel, paras, items)
    check_dashes(rel, paras, items)
    check_spelling(rel, paras, items)
    check_conclusion(rel, paras, items)
    # 多份稿件同名检查项不撞车
    for i in items:
        i["id"] = f"{i['id']}@{rel}"
    return items, True


def main():
    C.utf8_stdio()
    ap = argparse.ArgumentParser(description="投稿前检查（只读）")
    ap.add_argument("files", nargs="*", help="稿件（md / qmd / tex / docx）；不给就扫 manuscript/ 下的 md / qmd / tex")
    ap.add_argument("--root", default=".", help="工作目录（核验项写到 <根>/.ccode/checks/ms-check.jsonl）")
    args = ap.parse_args()
    root = Path(args.root)
    files = [Path(f) if Path(f).is_absolute() else root / f for f in args.files] if args.files \
        else C.manuscript_files(root, SKIP)
    items, read = [], 0
    for f in files:
        got, ok = check_file(f, root)
        items += got
        read += ok
    if not read:
        items.append(item("MS", "structure", "needs_human", "没读到稿件，投稿前检查没做", "manuscript/"))
        C.summary(items, C.write_items(root, CHECK_FILE, items))
        return 2
    return C.summary(items, C.write_items(root, CHECK_FILE, items))


if __name__ == "__main__":
    sys.exit(main())
