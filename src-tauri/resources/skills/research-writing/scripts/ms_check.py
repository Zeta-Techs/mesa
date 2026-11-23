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
  Pandoc 语法雷区   Markdown 中孤立/成对误配约等号 `~数字`、表格未转义 `|` 错列、列表前缺空行、漏方括号 `(@bibKey)` → 拦下 / 待你判断
  读者顺序与可读性   图表没按正文首次引用顺序编号或没被引用、摘要超过 250 词（中文 400 字）、缩写没在首次出现处给全称、长句过密 → 待你判断
  投稿体例与路径卫生 正文段落零散加粗、长破折号过密、粗体导语清单偏多、内部策划/审计/判官腔用语、高频模板化修辞、未查 SI 时的绝对全称否定（待你判断），以及正文或 `figures/README.md` 残留本机工作区绝对路径（拦下）
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
# 写作配套文件不当稿件扫：名单只在 mesa_checks.py（与 Mesa、cite_check 同一份）
SKIP = C.MANUSCRIPT_HELPER_RE
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
               r"\bbased in on\b", r"\ba the\b", r"\bthe\s+a(?![-–—/])\b", r"\bof of\b"]
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
    ("analyzed", "analysed"), ("analyzing", "analysing"), ("characterization", "characterisation"), ("optimization", "optimisation"),
    ("stabilization", "stabilisation"), ("utilization", "utilisation"), ("polarization", "polarisation"),
    ("crystallization", "crystallisation"), ("organization", "organisation"), ("modeling", "modelling"),
    ("labeled", "labelled"), ("sulfur", "sulphur"), ("aluminum", "aluminium"), ("favorable", "favourable"),
    ("catalyze", "catalyse"), ("catalyzed", "catalysed"), ("catalyzing", "catalysing"), ("gray", "grey"), ("liter", "litre"), ("meter", "metre"),
]
# analyses / catalyses 是名词 analysis / catalysis 的复数（美式英式同形），不按 +s 算英式动词
NO_PLURAL_S = {"analyse", "catalyse"}


def item(*args, **kwargs):
    return C.item(CHECKER, *args, **kwargs)


def norm(s):
    s = unicodedata.normalize("NFKD", s)
    return "".join(ch for ch in s.lower() if "a" <= ch <= "z")


# ---------- 读稿 ----------

class Para:
    def __init__(self, text, line, heading=False, auto_number=False, level=0, is_bib=False):
        self.text, self.line, self.heading, self.auto_number, self.level, self.is_bib = (
            text, line, heading, auto_number, level, is_bib
        )


REF_HEADING = re.compile(
    r"^(?:\d+(?:\.\d+)*\.?\s+)?(?:references|bibliography|literature\s+cited|works\s+cited|参考文献|引用文献)\s*$",
    re.I,
)


def exclude_bibliography(paras):
    """参考文献表里是所引论文的原标题，连接号、英美拼写、单位写法受原刊约束，不计入本文正文体例混用。"""
    out = []
    in_ref = False
    ref_level = 0
    for p in paras:
        if p.heading:
            if REF_HEADING.match(p.text):
                in_ref = True
                ref_level = p.level
                continue
            if in_ref and (ref_level == 0 or p.level == 0 or p.level <= ref_level):
                in_ref = False
        if in_ref or p.is_bib:
            continue
        out.append(p)
    return out


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
            head_text = re.sub(r"\s*\{[#.][^}]*\}\s*$", "", m.group(2)).strip()
            paras.append(Para(head_text, no, heading=True, level=len(m.group(1))))
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
    heading_levels = {}
    if styles is not None:
        for st in styles.iter(W + "style"):
            sid = st.get(W + "styleId", "")
            name = st.find(W + "name")
            label = (name.get(W + "val", "") if name is not None else "") + " " + sid
            ppr = st.find(W + "pPr")
            ol = ppr.find(W + "outlineLvl") if ppr is not None else None
            if re.search(r"heading|标题", label, re.I) or ol is not None:
                heading_styles.add(sid)
                m_lvl = re.search(r"(?:heading|标题)\s*(\d+)", label, re.I)
                if m_lvl:
                    heading_levels[sid] = int(m_lvl.group(1))
                elif ol is not None and (ol.get(W + "val") or "").isdigit():
                    heading_levels[sid] = int(ol.get(W + "val")) + 1
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
        m_sid_lvl = re.search(r"(?:heading|标题)\s*(\d+)", sid, re.I)
        level = heading_levels.get(sid, int(m_sid_lvl.group(1)) if m_sid_lvl else 0)
        is_bib = bool(re.search(r"bibliograph|参考文献", sid, re.I))
        runs = [r for r in p.iter(W + "r") if "".join(t.text or "" for t in r.iter(W + "t")).strip()]
        bold = bool(runs) and all(bold_run(r) for r in runs)
        paras.append(Para(text.strip(), i, heading=heading, auto_number=has_num or sid in numbered_styles, level=level, is_bib=is_bib))
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
    uk = {b: len(re.findall(rf"\b{b}\b" if b in NO_PLURAL_S else rf"\b{b}s?\b", body)) for _, b in US_UK}
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


_INLINE_CODE_OR_MATH = re.compile(r"`[^`\n]+`|\$\$[^$\n]+\$\$|\$(?!\s)[^$\n]+?(?<!\s)\$")
_VALID_SUB_OR_STRIKE = re.compile(r"~~[^~\n]+~~|(?<![~\\])~[^\s~\n]{1,16}(?<!\\)~")
_PAREN_CITE = re.compile(
    r"(?<!\[)\(\s*@(?:zotero[A-Za-z0-9]+|[A-Za-z][A-Za-z0-9_:-]*\d{4}[a-z]?)(?:\s*;\s*@[A-Za-z0-9_:-]+)*\s*\)"
)
_TABLE_SEP_ROW = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$")
_LIST_ITEM_RE = re.compile(r"^\s*(?:[-*+]\s+\S|\d+[.)]\s+\S)")
_UNESCAPED_PIPE = re.compile(r"(?<!\\)\|")


def _mask_code_math(line: str) -> str:
    return _INLINE_CODE_OR_MATH.sub(lambda m: " " * len(m.group(0)), line)


def _table_col_count(line: str) -> int:
    masked = _mask_code_math(line).strip()
    if masked.startswith("|"):
        masked = masked[1:]
    if masked.endswith("|") and not masked.endswith("\\|"):
        masked = masked[:-1]
    return len(_UNESCAPED_PIPE.split(masked))


def check_pandoc_markdown(rel: str, path: Path, items: list) -> None:
    """检查 Markdown / Quarto 稿件中容易被 Pandoc 静默破坏的 4 类确定性语法雷区。"""
    if path.suffix.lower() not in (".md", ".qmd"):
        return
    try:
        raw_text = path.read_text(encoding="utf-8")
    except OSError:
        return

    body_start = 0
    if raw_text.startswith("---"):
        end = raw_text.find("\n---", 3)
        if end > 0:
            body_start = raw_text[: end + 4].count("\n") + 1

    lines = raw_text.splitlines()
    fenced = False
    in_ref = False
    ref_level = 0
    tilde_blocked = []
    tilde_warn = []
    pipe_hits = []
    list_hits = []
    paren_cite_hits = []

    # 1) 逐行扫描：跳过代码块与参考文献节
    prev_raw = ""
    prev_is_list_or_cont = False
    active_table_cols: int | None = None

    for idx in range(body_start, len(lines)):
        ln = idx + 1
        raw = lines[idx]
        stripped = raw.strip()

        if raw.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
            active_table_cols = None
            prev_raw = ""
            prev_is_list_or_cont = False
            continue
        if fenced:
            continue

        hm = re.match(r"^(#{1,6})\s+(.*)$", raw)
        if hm:
            head_t = re.sub(r"\s*\{[#.][^}]*\}\s*$", "", hm.group(2)).strip()
            lvl = len(hm.group(1))
            if REF_HEADING.match(head_t):
                in_ref = True
                ref_level = lvl
            elif in_ref and (ref_level == 0 or lvl <= ref_level):
                in_ref = False
            active_table_cols = None
            prev_raw = raw
            prev_is_list_or_cont = False
            continue
        if in_ref:
            continue

        # 表格列数一致性（检测单元格里未转义的 `|e|` / `|j|` 导致整行错列）
        if active_table_cols is not None:
            if not stripped or not _UNESCAPED_PIPE.search(_mask_code_math(raw)):
                active_table_cols = None
            else:
                cols = _table_col_count(raw)
                if cols != active_table_cols:
                    pipe_hits.append((ln, active_table_cols, cols, stripped[:80]))
        elif idx + 1 < len(lines) and _TABLE_SEP_ROW.match(lines[idx + 1]) and _UNESCAPED_PIPE.search(_mask_code_math(raw)):
            active_table_cols = _table_col_count(raw)

        # 跳过表格分隔行本身进入下面检查
        if _TABLE_SEP_ROW.match(raw):
            prev_raw = raw
            prev_is_list_or_cont = False
            continue

        # 列表前缺空行检测
        is_list = bool(_LIST_ITEM_RE.match(raw))
        if is_list and prev_raw.strip():
            ps = prev_raw.strip()
            prev_exempt = (
                prev_is_list_or_cont
                or ps.startswith(("#", ">", "|", "<!--", "-->", "---", ":", "{"))
                or ps.endswith("-->")
                or bool(re.match(r"^(?:Table|Figure|Fig\.|Scheme)\s+", ps))
            )
            if not prev_exempt:
                list_hits.append((ln, stripped[:60]))
        if not stripped:
            prev_is_list_or_cont = False
        elif is_list:
            prev_is_list_or_cont = True
        elif raw.startswith(("  ", "\t")) and prev_is_list_or_cont:
            prev_is_list_or_cont = True
        else:
            prev_is_list_or_cont = False

        if not stripped:
            prev_raw = ""
            continue

        masked = _mask_code_math(raw)

        # 孤立约等号 `~数字` 或未闭合下标 `~`
        without_valid = _VALID_SUB_OR_STRIKE.sub(" ", masked)
        stray_tildes = list(re.finditer(r"(?<!\\)~", without_valid))
        if stray_tildes:
            approx_hits = re.findall(r"(?<!\\)~\s*\d", without_valid)
            if len(stray_tildes) >= 2:
                tilde_blocked.append((ln, stripped[:80]))
            elif approx_hits or len(stray_tildes) == 1:
                # 仅对含 `~数字` 或像化学/物理残缺下标的孤立 `~` 告警，避免误伤普通标点
                if approx_hits or re.search(r"[A-Za-z0-9]~[A-Za-z0-9*]", without_valid):
                    tilde_warn.append((ln, stripped[:80]))

        # 疑似漏方括号引用 `(@Key2024)`（排除行首 Pandoc 示例编号列表）
        if not re.match(r"^\s*\(@[A-Za-z0-9_-]+\)\s", raw):
            for pm in _PAREN_CITE.finditer(masked):
                paren_cite_hits.append((ln, pm.group(0), stripped[:80]))

        prev_raw = raw

    if tilde_blocked:
        ln0 = tilde_blocked[0][0]
        samples = "；".join(f"L{ln}: {txt[:45]}" for ln, txt in tilde_blocked[:4])
        items.append(item(
            "MD-TILDE-BLOCK", "pandoc-syntax", "blocked",
            f"有 {len(tilde_blocked)} 行含 2 个以上未配对/约等号 `~`（Pandoc 会把两处 `~` 之间整段吞成下标）",
            rel, ln0, detail=f"{samples}。约等于统一改 `≈` 或转义 `\\~`，下标确保成对 `~...~`",
        ))
    if tilde_warn:
        ln0 = tilde_warn[0][0]
        samples = "；".join(f"L{ln}: {txt[:45]}" for ln, txt in tilde_warn[:4])
        items.append(item(
            "MD-TILDE-WARN", "pandoc-syntax", "needs_human",
            f"有 {len(tilde_warn)} 行含孤立约等号 `~` 或疑似残缺下标",
            rel, ln0, detail=f"{samples}。约等于建议统一用 `≈`（或 `\\~`），残缺下标补齐配对 `~`",
        ))
    if pipe_hits:
        ln0 = pipe_hits[0][0]
        samples = "；".join(f"L{ln}（表头 {hc} 列、本行 {rc} 列）: {txt[:36]}" for ln, hc, rc, txt in pipe_hits[:4])
        items.append(item(
            "MD-TABLE-PIPE", "pandoc-syntax", "blocked",
            f"Markdown 表格有 {len(pipe_hits)} 行列数与表头不符（常见原因：单元格内 `|e|` / `|j|` 未转义为 `\\|` 导致整行错列）",
            rel, ln0, detail=samples,
        ))
    if list_hits:
        ln0 = list_hits[0][0]
        samples = "；".join(f"L{ln}: {txt[:40]}" for ln, txt in list_hits[:4])
        items.append(item(
            "MD-LIST-BLANK", "pandoc-syntax", "needs_human",
            f"有 {len(list_hits)} 处列表项前缺空行（Pandoc 会把列表并成一行纯文本）",
            rel, ln0, detail=f"{samples}。在列表第一项前补一行空行",
        ))
    if paren_cite_hits:
        ln0 = paren_cite_hits[0][0]
        samples = "；".join(f"L{ln} `{tok}`" for ln, tok, _ in paren_cite_hits[:6])
        items.append(item(
            "MD-PAREN-CITE", "pandoc-syntax", "blocked",
            f"有 {len(paren_cite_hits)} 处疑似引用漏写方括号 `(@bibKey)`（Pandoc 不解析会原样印出）",
            rel, ln0, detail=f"{samples}。改为 `[@bibKey]`",
        ))


_INLINE_BOLD = re.compile(r"\*\*(?!\s)([^*\n]{2,80}?)(?<!\s)\*\*")
_BOLD_LEAD_LIST = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\*\*[^*\n]{2,80}\*\*")
_EN_WORD = re.compile(r"\b[A-Za-z]{2,}\b")
_ABS_LOCAL_PATH = re.compile(
    r"file:///(?:Users|home|[A-Za-z]:)/[^\s)\"'>]+|"
    r"(?:/Users/|/home/)[^\s)\"'>]*/ccode/workspaces/[^\s)\"'>]+|"
    r"[A-Za-z]:\\Users\\[^\s)\"'>]*\\ccode\\workspaces\\[^\s)\"'>]+"
)

# 内部策划代号、语料审计词与审稿挑错判官词（不应直接直译进正式投稿正文）
_INTERNAL_AUDIT_TERMS = [
    ("sandwich architecture", re.compile(r"\bsandwich\s+architecture\b", re.I)),
    ("reviewed corpus", re.compile(r"\breviewed\s+corpus\b", re.I)),
    ("full-text reviewed studies", re.compile(r"\bfull-text\s+reviewed\s+(?:studies|papers|articles)\b", re.I)),
    ("abstract-level reporting", re.compile(r"\b(?:based\s+on\s+)?abstract-level\s+reporting\b", re.I)),
    ("forensic verdict", re.compile(r"\bforensic\s+verdict\b", re.I)),
    ("physical-logic conflict", re.compile(r"\bphysical-logic\s+conflict\b", re.I)),
    ("attribution crisis", re.compile(r"\battribution\s+crisis\b", re.I)),
    ("Methodological Red Lines", re.compile(r"\bmethodological\s+red\s+lines?\b", re.I)),
    ("Pillar I/II", re.compile(r"\bPillar\s+(?:I|II|III)\b")),
    ("Track A/B", re.compile(r"\bTrack\s+[AB]\b")),
    ("along three uniform axes", re.compile(r"\balong\s+three\s+uniform\s+axes\b", re.I)),
    ("RDS/RE errors / PEM/AEM mislabel", re.compile(r"\b(?:RDS/RE\s+errors?|PEM/AEM\s+mislabel|wording\s+contradiction|misattributed\s+author\s+names?)\b", re.I)),
]

# 高频模板化修辞（单处不拦，累积 >= 4 处提示核对改写）
_FORMULAIC_CLICHES = [
    ("Rather than X, …", re.compile(r"\brather\s+than\s+[^.,;\n]{2,45},\s*(?:we|this|the)\b", re.I)),
    ("stark contrast", re.compile(r"\bstark\s+contrast\b", re.I)),
    ("indispensable", re.compile(r"\bindispensable\b", re.I)),
    ("unmistakably", re.compile(r"\bunmistakably\b", re.I)),
    ("delve into", re.compile(r"\bdelve(?:s|d|ing)?\s+into\b", re.I)),
    ("pave the way for", re.compile(r"\bpaves?\s+the\s+way\s+for\b", re.I)),
    ("underscore the importance", re.compile(r"\bunderscores?\s+the\s+importance\s+of\b", re.I)),
    ("multifaceted landscape", re.compile(r"\bmultifaceted\s+landscape\b", re.I)),
    ("intricate interplay", re.compile(r"\bintricate\s+interplay\b", re.I)),
]

# 未下载核验 SI 时的全称绝对否定风险表达
_ABSOLUTE_NEGATIVES = [
    re.compile(r"\bacross\s+the\s+entire\s+(?:peer-reviewed\s+)?literature\b", re.I),
    re.compile(r"\bnot\s+(?:a\s+single|one)\s+(?:study|report|paper|article)\s+reports?\b", re.I),
    re.compile(r"\bzero\s+reports?\s*\(\s*0\s*/\s*\d+\s*\)", re.I),
]


def _is_table_or_caption(text: str) -> bool:
    s = text.strip()
    if not s:
        return True
    if s.startswith(("|", ":", "<!--", "![", "{", ">")):
        return True
    if CAPTION.match(s):
        return True
    if _TABLE_SEP_ROW.match(s):
        return True
    return False


def check_editorial_hygiene(rel: str, path: Path, body_paras: list[Para], items: list) -> None:
    """检查顶刊投稿常见的正文体例卫生、内部策划/审计腔泄露、全称否定边界与本机绝对路径残留。"""
    is_md = path.suffix.lower() in (".md", ".qmd")
    prose_paras = [p for p in body_paras if not p.heading and not _is_table_or_caption(p.text)]
    if not prose_paras:
        return

    # 1) 本机工作区绝对路径泄露（全文扫描，含链接与图注）
    abs_hits = []
    for p in body_paras:
        for m in _ABS_LOCAL_PATH.finditer(p.text):
            abs_hits.append((p.line, m.group(0)[:70]))
    if abs_hits:
        samples = "；".join(f"L{ln}: {tok}" for ln, tok in abs_hits[:4])
        items.append(item(
            "PATH-ABS-LEAK", "artifact-hygiene", "blocked",
            f"稿件中残留 {len(abs_hits)} 处本机工作区绝对路径",
            rel, abs_hits[0][0],
            detail=f"{samples}。投稿稿件严禁带本机 file:// 或 ccode/workspaces 绝对路径，请改为相对路径",
        ))

    # 2) Markdown 正文段落内零散 **加粗** 与「粗体导语 + 清单」占比
    if is_md:
        bold_hits = []
        bold_list_lines = []
        prose_block_count = 0
        for p in prose_paras:
            if _LIST_ITEM_RE.match(p.text):
                if _BOLD_LEAD_LIST.match(p.text):
                    bold_list_lines.append((p.line, p.text[:50]))
                continue
            prose_block_count += 1
            masked = _mask_code_math(p.text)
            # 跳过整段都是加粗的段首标签行（如 **Keywords:** / **Highlights**）
            if re.match(r"^\*\*(?:Keywords?|Abstract|Highlights?|Note)\b", masked, re.I):
                continue
            for m in _INLINE_BOLD.finditer(masked):
                bold_hits.append((p.line, m.group(1)[:36]))
        if bold_hits:
            samples = "；".join(f"L{ln}「{txt}」" for ln, txt in bold_hits[:6])
            items.append(item(
                "PROSE-BOLD", "style-hygiene", "needs_human",
                f"正文段落内有 {len(bold_hits)} 处零散加粗（**…**）",
                rel, bold_hits[0][0],
                detail=f"{samples}。学术期刊正文自然段一般不用粗体强调词组或数字，建议改为正常字重并靠句式强调",
            ))
        total_units = prose_block_count + len(bold_list_lines)
        if len(bold_list_lines) >= 8 or (len(bold_list_lines) >= 6 and total_units > 0 and len(bold_list_lines) / total_units > 0.25):
            pct = int(round(100 * len(bold_list_lines) / max(1, total_units)))
            samples = "；".join(f"L{ln}: {txt[:38]}" for ln, txt in bold_list_lines[:4])
            items.append(item(
                "PROSE-BOLD-LIST", "style-hygiene", "needs_human",
                f"正文含 {len(bold_list_lines)} 条「粗体导语 + 清单」（约占段落与条目总数的 {pct}%）",
                rel, bold_list_lines[0][0],
                detail=f"{samples}。高水平期刊综述主体宜以连贯自然段论证，可将清单小点融回段落，仅保留必要枚举",
            ))

    # 3) 正文长破折号（—）千词密度
    total_words = sum(len(_EN_WORD.findall(_mask_code_math(p.text))) for p in prose_paras)
    em_lines = [(p.line, p.text.count("—")) for p in prose_paras if "—" in p.text]
    em_total = sum(c for _, c in em_lines)
    if total_words >= 500 and em_total > 0:
        per_k = em_total * 1000.0 / total_words
        if per_k > 4.5:
            items.append(item(
                "PROSE-EMDASH", "style-hygiene", "needs_human",
                f"正文长破折号（—）偏密：共 {em_total} 处（约 {per_k:.1f} 次/千词，正文约 {total_words} 词）",
                rel, em_lines[0][0],
                detail="高频长破折号易显生硬，建议将部分插语改为逗号、括号或拆成自然长短句",
            ))

    # 4) 内部策划代号 / 语料审计腔 / 审稿挑错判官词
    internal_hits = []
    for p in prose_paras:
        masked = _mask_code_math(p.text)
        for label, pat in _INTERNAL_AUDIT_TERMS:
            m = pat.search(masked)
            if m:
                internal_hits.append((p.line, label, m.group(0)))
    if internal_hits:
        uniq = list(dict.fromkeys(f"L{ln} `{tok}`" for ln, _, tok in internal_hits))
        items.append(item(
            "PROSE-INTERNAL-TERMS", "style-hygiene", "needs_human",
            f"正文含 {len(internal_hits)} 处疑似内部策划代号、语料审计词或编校挑错用语",
            rel, internal_hits[0][0],
            detail="；".join(uniq[:8]) + "。大纲代号、语料统计与编校笔误备忘应转译为自然学科表达或移入内部记录",
        ))

    # 5) 高频模板化修辞（累计 >= 4 处才提示，避免偶发误报）
    cliche_hits = []
    for p in prose_paras:
        masked = _mask_code_math(p.text)
        for label, pat in _FORMULAIC_CLICHES:
            for m in pat.finditer(masked):
                cliche_hits.append((p.line, label, m.group(0)[:40]))
    if len(cliche_hits) >= 4:
        samples = "；".join(f"L{ln} `{tok}`" for ln, _, tok in cliche_hits[:6])
        items.append(item(
            "PROSE-CLICHE", "style-hygiene", "needs_human",
            f"正文出现 {len(cliche_hits)} 处高频模板化修辞短语",
            rel, cliche_hits[0][0],
            detail=f"{samples}。建议替换为具体的物理/实验机理或定量差异描述",
        ))

    # 6) 未核验 SI 时的全称绝对否定风险表达
    abs_neg_hits = []
    for p in prose_paras:
        masked = _mask_code_math(p.text)
        for pat in _ABSOLUTE_NEGATIVES:
            m = pat.search(masked)
            if m:
                abs_neg_hits.append((p.line, m.group(0)[:50]))
    if abs_neg_hits:
        samples = "；".join(f"L{ln} `{tok}`" for ln, tok in abs_neg_hits[:5])
        items.append(item(
            "PROSE-ABS-NEG", "evidence-scope", "needs_human",
            f"正文含 {len(abs_neg_hits)} 处全称绝对否定表述，若核心文献有未核验 SI 易被审稿人质疑",
            rel, abs_neg_hits[0][0],
            detail=f"{samples}。如相关文献的 Supporting Information 未逐篇核对，建议限定为 within the primary main texts examined",
        ))


# ---------- 读者顺序与可读性（2026-11-23 硼化物定稿复盘：图 12 先于图 11 被引、摘要 406 词、
# 几十个缩写没定义、平均句长 36 词，旧检查一条都没报）----------
_XREF_DEF = re.compile(r"\{#((fig|tbl)-[\w-]+)[^}]*\}")
_XREF_USE = re.compile(r"(?<![\w{#])@((fig|tbl)-[\w-]+)")
_TEXT_REF = re.compile(r"\b(Fig(?:ure)?s?\.?|Tables?)\s+(\d+)\b")
_CITE_GROUP = re.compile(r"\[[^\[\]]*@[^\[\]]*\]")
_ACRONYM = re.compile(r"(?<![\w~^\\/-])([A-Z]{3,6})s?(?![\w~^])")
# 全大写且每个字母都是单字母元素的多半是化学式（KOH、KSCN），不当缩写
_ONE_LETTER_ELEMENTS = set("HBCNOFPSKVYIWU")
_ACRONYM_COMMON = {"DOI", "URL", "PDF", "DNA", "RNA", "USA", "ORCID", "ISBN", "ISSN"}
_ABBREV_DOT = re.compile(r"\b(?:et al|e\.g|i\.e|Figs?|Eqs?|Refs?|vs|ca|approx|No|Vol|cf)\.", re.I)
ABSTRACT_WORD_LIMIT = 250


def _sentences(text: str) -> list[str]:
    text = _ABBREV_DOT.sub(lambda m: m.group(0).replace(".", ""), text)
    return [s for s in re.split(r"(?<=[.?!])\s+(?=[A-Z(\[])", text) if s.strip()]


def _order_findings(first_refs: list[int], total: int) -> tuple[list[str], list[int]]:
    """首次引用顺序里比前面已引的号小的（先引了后面的图），以及从没被引用的号。"""
    late, peak = [], 0
    for n in first_refs:
        if n < peak:
            late.append(f"{n} 在 {peak} 之后才首次被引")
        peak = max(peak, n)
    return late, [n for n in range(1, total + 1) if n not in first_refs]


def check_reader_order(rel: str, path: Path, front: str, body_paras: list[Para], items: list) -> None:
    """图表按首次引用顺序编号、摘要字数、缩写首次出现处定义、长句密度。"""
    is_md = path.suffix.lower() in (".md", ".qmd")
    label = {"fig": "Figure", "tbl": "Table"}

    # 1) 图表首次引用顺序：Quarto 交叉引用按图块出现的先后编号；没用交叉引用的按正文里的「Figure N」
    defs: dict[str, list[str]] = {"fig": [], "tbl": []}
    uses: dict[str, list[str]] = {"fig": [], "tbl": []}
    for p in body_paras:
        own = {m.group(1) for m in _XREF_DEF.finditer(p.text)}
        for m in _XREF_DEF.finditer(p.text):
            if m.group(1) not in defs[m.group(2)]:
                defs[m.group(2)].append(m.group(1))
        for m in _XREF_USE.finditer(p.text):
            if m.group(1) not in own and m.group(1) not in uses[m.group(2)]:
                uses[m.group(2)].append(m.group(1))
    for kind in ("fig", "tbl"):
        if defs[kind]:
            num = {lab: i + 1 for i, lab in enumerate(defs[kind])}
            first = [num[u] for u in uses[kind] if u in num]
            total = len(defs[kind])
        elif not is_md or not any(defs.values()):
            first, seen = [], set()
            for p in body_paras:
                if p.heading or CAPTION.match(p.text):
                    continue
                for m in _TEXT_REF.finditer(p.text):
                    if m.group(1).lower().startswith("tab") != (kind == "tbl"):
                        continue
                    n = int(m.group(2))
                    if n not in seen:
                        seen.add(n)
                        first.append(n)
            total = max(first, default=0)
        else:
            continue
        if not total:
            continue
        late, never = _order_findings(first, total)
        if late or never:
            detail = []
            if late:
                detail.append("首次引用顺序：" + "；".join(f"{label[kind]} {x}" for x in late[:4]))
            if never:
                detail.append("正文没引用：" + "、".join(f"{label[kind]} {n}" for n in never))
            items.append(item(f"ORDER-{label[kind]}", "reader-order", "needs_human",
                              f"{label[kind]} 没有按正文首次引用的顺序编号" if late else f"有 {label[kind]} 正文没有引用", rel,
                              detail="；".join(detail) + "。期刊要求图表按正文首次引用的先后编号、每张都在正文引到，调图块位置或引用处"))
        else:
            items.append(item(f"ORDER-{label[kind]}", "reader-order", "passed",
                              f"{label[kind]} 1–{total} 按首次引用顺序编号且都在正文引到", rel))

    # 2) 摘要字数：Markdown 的 ## Abstract 一节或 YAML abstract
    abstract, line = "", None
    for i, p in enumerate(body_paras):
        if p.heading and re.match(r"^(?:abstract|摘\s*要)$", p.text.strip(), re.I):
            line = p.line
            for q in body_paras[i + 1:]:
                if q.heading:
                    break
                if re.match(r"^\W*(?:key\s*words?|关键词)", q.text, re.I):
                    continue
                abstract += " " + q.text
            break
    if not abstract:
        m = re.search(r"^abstract:\s*[|>]?-?\s*\n?((?:[ \t]+.*\n?)+|.+)", front, re.M)
        abstract = m.group(1) if m else ""
    if abstract.strip():
        plain = _CITE_GROUP.sub("", abstract)
        n_en = len(re.findall(r"[A-Za-z0-9][\w'’.-]*", plain))
        n_cjk = len(re.findall(r"[\u4e00-\u9fff]", plain))
        over = n_en > ABSTRACT_WORD_LIMIT if n_cjk < 50 else n_cjk > 400
        size = f"{n_cjk} 字" if n_cjk >= 50 else f"{n_en} 词"
        items.append(item("ABSTRACT-LEN", "reader-order", "needs_human" if over else "passed",
                          f"摘要 {size}" + ("，超过多数期刊上限" if over else ""), rel, line,
                          detail="英文期刊摘要多为 150–250 词、中文 200–400 字；按目标期刊作者须知核对，超出就压缩" if over else ""))

    prose = [p for p in body_paras if not p.heading and not _is_table_or_caption(p.text) and not _LIST_ITEM_RE.match(p.text)]
    if not prose:
        return

    # 3) 缩写：正文用了两次以上、全文找不到「(ABC)」式定义，或先用后定义
    clean = [(p.line, _CITE_GROUP.sub("", _mask_code_math(p.text))) for p in prose]
    full = "\n".join(_CITE_GROUP.sub("", p.text) for p in body_paras)
    first_use: dict[str, int] = {}
    counts: dict[str, int] = {}
    for ln, text in clean:
        for m in _ACRONYM.finditer(text):
            a = m.group(1)
            if a in _ACRONYM_COMMON or set(a) <= _ONE_LETTER_ELEMENTS or re.fullmatch(r"[IVXLC]+", a):
                continue
            counts[a] = counts.get(a, 0) + 1
            first_use.setdefault(a, ln)
    undefined, late = [], []
    for a, ln in first_use.items():
        if counts[a] < 2:
            continue
        # 「(LOM)」「[LOM]」「(LOM, supported by …)」「LOM (lattice oxygen …)」都算定义
        defined = re.compile(rf"[(\[]{a}s?[)\],;]|\b{a}\s+\([a-z]")
        if not defined.search(full):
            undefined.append(a)
        else:
            def_line = next((p.line for p in body_paras if defined.search(_CITE_GROUP.sub("", p.text))), ln)
            if def_line > ln:
                late.append(f"{a}（L{ln} 先用，L{def_line} 才定义）")
    if undefined or late:
        detail = []
        if undefined:
            detail.append(f"没找到定义（{len(undefined)} 个）：" + "、".join(undefined[:20]))
        if late:
            detail.append("先用后定义：" + "；".join(late[:8]))
        items.append(item("ACRONYM-DEF", "reader-order", "needs_human",
                          f"{len(undefined) + len(late)} 个缩写没在首次出现处给全称", rel,
                          min(first_use[a] for a in undefined) if undefined else None,
                          detail="；".join(detail) + "。缩写在正文首次出现处写全称加括号，通用的（如 XRD、DFT）也按目标期刊要求核一遍"))
    else:
        items.append(item("ACRONYM-DEF", "reader-order", "passed", "正文缩写都在首次出现处给了全称", rel))

    # 4) 长句密度
    sents = [(ln, s) for ln, text in clean for s in _sentences(text)]
    if len(sents) >= 30:
        lens = [len(s.split()) for _, s in sents]
        mean = sum(lens) / len(lens)
        long_ = sorted(((n, ln, s) for (ln, s), n in zip(sents, lens) if n > 45), reverse=True)
        if mean > 30 or len(long_) / len(sents) > 0.2:
            samples = "；".join(f"L{ln}（{n} 词）「{s[:50]}…」" for n, ln, s in long_[:3])
            items.append(item("PROSE-LONG-SENT", "style-hygiene", "needs_human",
                              f"句子偏长：平均 {mean:.0f} 词，{len(long_)}/{len(sents)} 句超过 45 词", rel, long_[0][1] if long_ else None,
                              detail=f"{samples}。英文学术正文平均 20–25 词较易读；把并列的条件、数值与限定拆成两三句"))


def check_companion_paths(root: Path, items: list) -> None:
    """检查 figures/README.md 等配套交付清单是否残留本机工作区绝对路径。"""
    fig_readme = root / "figures" / "README.md"
    if not fig_readme.is_file():
        return
    try:
        lines = fig_readme.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    hits = []
    for ln, raw in enumerate(lines, 1):
        for m in _ABS_LOCAL_PATH.finditer(raw):
            hits.append((ln, m.group(0)[:70]))
    if hits:
        samples = "；".join(f"L{ln}: {tok}" for ln, tok in hits[:4])
        items.append(item(
            "PATH-ABS-LEAK@figures/README.md", "artifact-hygiene", "blocked",
            f"figures/README.md 残留 {len(hits)} 处本机工作区绝对路径",
            "figures/README.md", hits[0][0],
            detail=f"{samples}。交付清单应一律使用相对路径（如 `analysis/...`）",
        ))


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
    body_paras = exclude_bibliography(paras)
    check_authors(rel, front, body_paras, items)
    check_heading_numbers(rel, front, paras, items, is_docx)
    check_captions(rel, body_paras, items)
    check_slips(rel, body_paras, items)
    check_units(rel, body_paras, items)
    check_dashes(rel, body_paras, items)
    check_spelling(rel, body_paras, items)
    check_conclusion(rel, paras, items)
    check_pandoc_markdown(rel, path, items)
    check_editorial_hygiene(rel, path, body_paras, items)
    check_reader_order(rel, path, front, body_paras, items)
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
    check_companion_paths(root, items)
    if not read:
        items.append(item("MS", "structure", "needs_human", "没读到稿件，投稿前检查没做", "manuscript/"))
        C.summary(items, C.write_items(root, CHECK_FILE, items))
        return 2
    return C.summary(items, C.write_items(root, CHECK_FILE, items))


if __name__ == "__main__":
    sys.exit(main())
