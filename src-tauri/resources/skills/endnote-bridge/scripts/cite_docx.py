#!/usr/bin/env python3
"""Markdown [@key] → Word docx with real EndNote ADDIN EN.CITE fields.

Does not launch EndNote or Word. Unmatched keys fail closed (no docx).
Visible text never contains {Author, Year} temporary citations.
"""
from __future__ import annotations

import argparse
import base64
import importlib.util
import re
import struct
import sys
import time
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape as sax_escape

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
ET.register_namespace("w", W_NS)
ET.register_namespace("wp", WP_NS)
ET.register_namespace("a", A_NS)
ET.register_namespace("pic", PIC_NS)
ET.register_namespace("r", R_NS)
W = "{%s}" % W_NS
# 正文栏大约 6.25 英寸。按像素比例缩进这一宽度，不按 96 dpi 原寸铺开。
MAX_CX = 5_715_000
MAX_CY = 7_315_200

REF_TYPE = {
    "article": ("Journal Article", "17"),
    "book": ("Book", "6"),
    "incollection": ("Book Section", "5"),
    "inproceedings": ("Conference Proceedings", "10"),
    "phdthesis": ("Thesis", "32"),
    "mastersthesis": ("Thesis", "32"),
    "techreport": ("Report", "27"),
    "misc": ("Generic", "13"),
}

CITE_RE = re.compile(
    r"\[((?:-?@[A-Za-z0-9_.:-]+(?:\s*,[^\];]*)?)(?:\s*;\s*-?@[A-Za-z0-9_.:-]+(?:\s*,[^\];]*)?)*)\]"
)
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
CURLY_TEMP = re.compile(r"\{[^{}]{1,80},\s*[^{}]{1,20}\}")
# Quarto / 交叉引用花括号。EndNote 会把 {#键} 当成临时引文去库里搜。
CURLY_KEY = re.compile(r"\{#(?!fig-|tbl-)([A-Za-z0-9_.:-]+)\}")


def load_library_match():
    path = Path(__file__).with_name("library_match.py")
    spec = importlib.util.spec_from_file_location("library_match", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_bridge():
    path = Path(__file__).with_name("bridge.py")
    spec = importlib.util.spec_from_file_location("endnote_bridge", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def xml_escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def surname(author: str) -> str:
    name = (author or "").strip()
    if not name:
        return "Anon"
    if "," in name:
        return name.split(",", 1)[0].strip() or "Anon"
    return name.split()[-1]


def display_for(records: list[dict]) -> str:
    parts = []
    for rec in records:
        authors = rec.get("authors") or []
        year = rec.get("year") or "n.d."
        disp = rec.get("_disp") or {}
        if not authors:
            parts.append(year + disp.get("suffix", ""))
            continue
        family = disp.get("family") or surname(authors[0])
        lead = f"{disp['initial']}. " if disp.get("initial") else ""
        suffix = disp.get("suffix", "")
        if len(authors) > 1:
            parts.append(f"{lead}{family} et al., {year}{suffix}")
        else:
            parts.append(f"{lead}{family}, {year}{suffix}")
    return "(" + "; ".join(parts) + ")"


def decorate_disambiguation(records: dict[str, dict]) -> None:
    """同年同姓消歧（只作用于 Update 前的可见文字；EndNote/Zotero 刷新后按样式重排）：
    第一作者同姓不同人 → 加名首字母（R. Zhang et al., 2026 / X. Zhang et al., 2026）；
    同一第一作者同年多篇 → 年份加 a/b（按 bib 出现顺序）。不撞车不加任何东西。
    2026-10-11 定稿审计实证：(Zhang et al., 2026; Zhang et al., 2026) 两篇不同文献同组出现。
    """
    groups: dict[tuple[str, str], list[dict]] = {}
    for rec in records.values():
        authors = rec.get("authors") or [""]
        first = authors[0]
        family = surname(first)
        given = first.split(",", 1)[1].strip() if "," in first else first
        rec["_disp"] = {
            "family": family,
            "ini": (given[:1] or "").upper(),
            "given": given.casefold(),
            "year": rec.get("year") or "n.d.",
        }
        groups.setdefault((family.casefold(), rec["_disp"]["year"]), []).append(rec)
    for recs in groups.values():
        if len(recs) < 2:
            continue
        initials = [r["_disp"]["ini"] for r in recs]
        for r in recs:
            # 同姓不同人且首字母能区分 → 加首字母；首字母也撞 → 退回 a/b
            r["_disp"]["initial"] = r["_disp"]["ini"] if initials.count(r["_disp"]["ini"]) == 1 else None
        keys = [(r["_disp"]["given"], r["_disp"].get("initial")) for r in recs]
        seen: dict[tuple, int] = {}
        for r, k in zip(recs, keys):
            if keys.count(k) > 1:
                seen[k] = seen.get(k, 0) + 1
                r["_disp"]["suffix"] = chr(ord("a") + seen[k] - 1)


def record_xml(rec: dict, rec_num: int) -> str:
    """真 EndNote 域里的 record 顺序（2026-10-10 与两份 EndNote 2025 实稿逐域核对）：
    rec-number 在前、foreign-keys 紧随其后，urls 在 electronic-resource-num 之前。
    顺序错了 CWYW 不认外键，Update 后引文会落在漫游个人图书馆而不是打开的库。
    """
    kind, code = REF_TYPE.get(rec.get("type", ""), ("Generic", "13"))
    authors = "".join(
        f"<author>{xml_escape(a)}</author>" for a in (rec.get("authors") or [])
    )
    title = xml_escape(rec.get("title") or "")
    journal = xml_escape(rec.get("journal") or "")
    year = xml_escape(rec.get("year") or "")
    pages = xml_escape(rec.get("pages") or "")
    volume = xml_escape(rec.get("volume") or "")
    number = xml_escape(rec.get("number") or "")
    doi = xml_escape(rec.get("doi") or "")
    url = xml_escape(rec.get("url") or "")
    label = xml_escape(rec.get("id") or "")
    # 只有库里 DOI 唯一时才写记录号和外键。没指定库、库锁住、或同一 DOI 多条时不写，
    # 不编 db-id="mesa" 和 1…n 的顺序号，刷新只靠域里的题录。
    library_num = rec.get("_en_rec")
    db_id = rec.get("_en_db") if isinstance(library_num, int) else ""
    # 未绑定库时用文内编号。绑定后只用库里的真实 id，写 0 会被 EndNote 收进漫游库。
    shown_num = library_num if isinstance(library_num, int) else rec_num
    foreign = ""
    if isinstance(library_num, int) and isinstance(db_id, str) and db_id and db_id != "mesa":
        stamp = rec.get("_en_ts")
        stamp = stamp if isinstance(stamp, int) and stamp > 0 else int(time.time())
        # ENWeb 空键与 timestamp 属性都是实稿里的原生形态，一并写上。
        foreign = (
            f'<foreign-keys><key app="EN" db-id="{xml_escape(db_id)}" timestamp="{stamp}">'
            f'{library_num}</key><key app="ENWeb" db-id="">0</key></foreign-keys>'
        )
    urls = f"<urls><related-urls><url>{url}</url></related-urls></urls>" if url else "<urls></urls>"
    return (
        f"<record><rec-number>{shown_num}</rec-number>{foreign}"
        f'<ref-type name="{kind}">{code}</ref-type>'
        f"<contributors><authors>{authors}</authors></contributors>"
        f"<titles><title>{title}</title><secondary-title>{journal}</secondary-title></titles>"
        f"<periodical><full-title>{journal}</full-title></periodical>"
        f"<pages>{pages}</pages><volume>{volume}</volume><number>{number}</number>"
        f"<dates><year>{year}</year></dates>"
        f"{urls}<electronic-resource-num>{doi}</electronic-resource-num>"
        f"<label>{label}</label></record>"
    )


CITE_INSTRUCTION = " ADDIN EN.CITE "


def cite_payload(group: list[dict], rec_nums: dict[str, int], display: str) -> str:
    """域数据（fldData）里的 XML。组引文 = 多个 <Cite>，只有第一个带 DisplayText，
    与 EndNote 2025 实稿一致。instrText 只留短指令，XML 全部走 fldData。
    """
    cites = []
    for i, rec in enumerate(group):
        # 绑定用库里的真实记录号；未绑定的用文内编号，不写 0（0 会被收进漫游库）。
        num = rec.get("_en_rec") if isinstance(rec.get("_en_rec"), int) else rec_nums[rec["id"]]
        author = xml_escape(surname((rec.get("authors") or ["Anon"])[0]))
        year = xml_escape(rec.get("year") or "n.d.")
        disp = f"<DisplayText>{xml_escape(display)}</DisplayText>" if i == 0 else ""
        cites.append(
            f"<Cite><Author>{author}</Author><Year>{year}</Year>"
            f"<RecNum>{num}</RecNum>{disp}{record_xml(rec, num)}</Cite>"
        )
    return "<EndNote>" + "".join(cites) + "</EndNote>"


def cite_field(group: list[dict], rec_nums: dict[str, int], display: str) -> tuple[str, str]:
    """一条引用域 = (instrText 指令, fldData 载荷)。Zotero 线（zotero_docx.py）
    覆写这一层换成 ZOTERO_ITEM 的 JSON 指令、不写 fldData。
    """
    return CITE_INSTRUCTION, cite_payload(group, rec_nums, display)


def w_el(tag: str, text: str | None = None, **attrs) -> ET.Element:
    el = ET.Element(W + tag)
    for key, value in attrs.items():
        el.set(W + key, value)
    if text is not None:
        el.text = text
    return el


def run_text(text: str, vertical: str | None = None, bold: bool = False, italic: bool = False) -> ET.Element:
    r = w_el("r")
    if vertical or bold or italic:
        props = w_el("rPr")
        if bold:
            props.append(w_el("b"))
        if italic:
            props.append(w_el("i"))
        if vertical in {"superscript", "subscript"}:
            props.append(w_el("vertAlign", **{"val": vertical}))
        r.append(props)
    t = w_el("t", text)
    if text[:1] in " \t" or text[-1:] in " \t":
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    r.append(t)
    return r


# Pandoc 单位：cm^−3^、kg^−1^。两端的 ^ 收成上标或下标，不再把记号留在正文里。
# 上下标内容不得含空白（Pandoc 规则）：放宽会让「约义 ~」（~79–81%、~2 µm）与化学式
# 下标号错位配对，把整段正文排成下标、化学式拆碎（2026-10-11 定稿审计实证，4 段 + 1 图注）。
MARK_RE = re.compile(r"(\*\*[^*]+\*\*|\*[^*]+\*|\^[^\s^]+\^|~[^\s~]+~)")

# Pandoc 反斜杠转义（\@、\~、\^ 等）：剥离出来当字面量，不参与标记配对（a-MgCl~2~\@polymer
# 的 \@ 若不剥，正文会残留字面反斜杠；\~ 若不剥会被当标记参与配对）。
ESCAPE_RE = re.compile(r"\\([!\"#$%&'()*+,./:;<=>?@\[\\\]^_`{|}~-])")


def append_marked(p: ET.Element, text: str) -> None:
    pos = 0
    for esc in ESCAPE_RE.finditer(text):
        _emit_marked(p, text[pos:esc.start()])
        p.append(run_text(esc.group(1)))
        pos = esc.end()
    _emit_marked(p, text[pos:])


def _emit_marked(p: ET.Element, text: str) -> None:
    pos = 0
    for match in MARK_RE.finditer(text):
        if match.start() > pos:
            p.append(run_text(text[pos:match.start()]))
        token = match.group(0)
        if token.startswith("**"):
            p.append(run_text(token[2:-2], bold=True))
        elif token.startswith("*"):
            p.append(run_text(token[1:-1], italic=True))
        elif token.startswith("^"):
            p.append(run_text(token[1:-1], vertical="superscript"))
        else:
            p.append(run_text(token[1:-1], vertical="subscript"))
        pos = match.end()
    if pos < len(text):
        p.append(run_text(text[pos:]))


def split_lead_sentence(text: str) -> tuple[str, str]:
    """图注第一句。小数点不当成句号。"""
    match = re.search(r"(?<!\d)[.!?](?=\s|$)", text)
    if match is None:
        return text, ""
    cut = match.end()
    return text[:cut], text[cut:]


def bold_paragraph(p: ET.Element) -> None:
    """整段加粗。图注里的说明句和引用显示文字都要粗体。"""
    for run in p.iter(W + "r"):
        props = run.find(W + "rPr")
        if props is None:
            props = w_el("rPr")
            run.insert(0, props)
        if props.find(W + "b") is None:
            props.append(w_el("b"))


def heading_paragraph(text: str, level: int = 1) -> ET.Element:
    """文末文献标题。Heading 样式才会进 Word 导航窗格。"""
    p = w_el("p")
    props = w_el("pPr")
    props.append(w_el("pStyle", **{"val": f"Heading{level}"}))
    p.append(props)
    p.append(run_text(text, bold=True))
    return p


CITE_DATA_INSTRUCTION = " ADDIN EN.CITE.DATA "


def fld_data_element(payload: str) -> ET.Element:
    """域数据（fldData）：UTF-8 XML + 末尾 NUL，base64 后 76 列换行，行尾 CRLF、
    末行也带 CRLF——与 EndNote 2025 实稿逐字节一致。
    """
    encoded = base64.b64encode(payload.encode("utf-8") + b"\x00").decode("ascii")
    lines = [encoded[i : i + 76] for i in range(0, len(encoded), 76)]
    data = w_el("fldData", "\r\n".join(lines) + "\r\n")
    data.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return data


def field_begin(payload: str | None = None, with_data: bool = False) -> ET.Element:
    run = w_el("r")
    char = w_el("fldChar", **{"fldCharType": "begin"})
    if payload or with_data:
        char.append(fld_data_element(payload or ""))
    run.append(char)
    return run


def field_instr(instruction: str) -> ET.Element:
    run = w_el("r")
    it = w_el("instrText", instruction)
    it.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    run.append(it)
    return run


def field_marker(kind: str) -> ET.Element:
    run = w_el("r")
    run.append(w_el("fldChar", **{"fldCharType": kind}))
    return run


def field_runs(instruction: str, display: str, payload: str = "", with_data: bool = False) -> list[ET.Element]:
    """单层域（REFLIST、Zotero 线）。EndNote 引文域用 cite_runs 的嵌套形态。"""
    begin = field_begin(payload, with_data)
    shown = w_el("r")
    shown.append(w_el("t", display))
    return [begin, field_instr(instruction), field_marker("separate"), shown, field_marker("end")]


def cite_runs(group: list[dict], rec_nums: dict[str, int], display: str) -> list[ET.Element]:
    """EndNote 2025 引文域（2026-10-10 与实稿逐 run 核对修复）：
    外层 ADDIN EN.CITE 的 fldData 装引文 XML，begin 与 separate 之间还嵌一个
    ADDIN EN.CITE.DATA 子域（fldData 同一份 XML，无结果区）。少了这个子域，
    CWYW 找不到域数据，Update 会把整条引文报成 INVALID CITATION。
    Zotero 线覆写 cite_field 返回空载荷时，走单层 field_runs。
    """
    instruction, payload = cite_field(group, rec_nums, display)
    if not payload:
        return field_runs(instruction, display)
    shown = w_el("r")
    shown.append(w_el("t", display))
    return [
        field_begin(payload),
        field_instr(instruction),
        field_begin(payload),
        field_instr(CITE_DATA_INSTRUCTION),
        field_marker("end"),
        field_marker("separate"),
        shown,
        field_marker("end"),
    ]


def parse_cite_keys(span: str) -> list[str]:
    keys = []
    for part in span.split(";"):
        part = part.strip().lstrip("-").lstrip()
        if not part.startswith("@"):
            continue
        key = "".join(
            ch
            for ch in part[1:]
            if ch.isalnum() or ch in "_-.:"
        )
        if key:
            keys.append(key)
    return keys


def front_matter(text: str) -> tuple[dict[str, str], str]:
    """稿头的标题、摘要、关键词。以前整段丢掉，Word 里就没有这三项。"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    raw = text[3:end]
    rest = text[end + 4 :]
    if rest.startswith("\n"):
        rest = rest[1:]
    fields: dict[str, str] = {}
    current = ""
    mode = ""
    for line in raw.splitlines():
        if mode == "block":
            if line.startswith("  ") or line.startswith("\t"):
                fields[current] = (fields.get(current, "") + " " + line.strip()).strip()
                continue
            mode = ""
        if mode == "list":
            item = re.match(r"^\s*-\s+(.*)$", line)
            if item:
                fields[current] = (fields.get(current, "") + "; " + item.group(1).strip()).strip("; ")
                continue
            mode = ""
        head = re.match(r"^([A-Za-z][\w-]*):\s*(.*)$", line)
        if not head:
            continue
        current = head.group(1)
        value = head.group(2).strip().strip('"')
        if value in {"|", ">", "|-"}:
            mode = "block"
            fields[current] = ""
        elif value == "":
            mode = "list"
            fields[current] = ""
        else:
            fields[current] = value
    return fields, rest


def strip_frontmatter(text: str) -> str:
    return front_matter(text)[1]


def split_blocks(text: str) -> list[tuple[str, str]]:
    fields, body = front_matter(text)
    lines = body.splitlines()
    blocks: list[tuple[str, str]] = []
    buf: list[str] = []
    fence = None
    i = 0
    while i < len(lines):
        line = lines[i]
        open_fence = FENCE_RE.match(line)
        if fence:
            buf.append(line)
            if open_fence and line.strip().startswith(fence):
                blocks.append(("code", "\n".join(buf)))
                buf = []
                fence = None
            i += 1
            continue
        if open_fence:
            if buf:
                blocks.append(("p", "\n".join(buf)))
                buf = []
            fence = open_fence.group(1)[0] * 3
            buf = [line]
            i += 1
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            if buf:
                blocks.append(("p", "\n".join(buf)))
                buf = []
            blocks.append(("h" + str(len(heading.group(1))), heading.group(2).strip()))
            i += 1
            continue
        if re.match(r"^---\s*$|^-\s*-\s*-\s*$|^\*\*\*\s*$", line):
            if buf:
                blocks.append(("p", "\n".join(buf)))
                buf = []
            blocks.append(("hr", ""))
            i += 1
            continue
        if line.lstrip().startswith("|") and "|" in line[1:]:
            if buf:
                blocks.append(("p", "\n".join(buf)))
                buf = []
            rows = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                rows.append(lines[i])
                i += 1
            blocks.append(("table", "\n".join(rows)))
            if i < len(lines) and not lines[i].strip():
                i += 1
            if i < len(lines) and re.match(r"^:\s", lines[i]):
                blocks.append(("tablecap", re.sub(r"^:\s+", "", lines[i]).strip()))
                i += 1
            continue
        if not line.strip():
            if buf:
                blocks.append(("p", "\n".join(buf)))
                buf = []
            i += 1
            continue
        buf.append(line)
        i += 1
    if fence:
        blocks.append(("code", "\n".join(buf)))
    elif buf:
        blocks.append(("p", "\n".join(buf)))
    sample = " ".join([fields.get("title", ""), fields.get("abstract", ""), body[:2000]])
    chinese = len(re.findall(r"[\u4e00-\u9fff]", sample)) > len(re.findall(r"[A-Za-z]", sample)) * 0.2
    labels = ("摘要", "关键词", "图", "表") if chinese else ("Abstract", "Keywords", "Figure", "Table")
    head: list[tuple[str, str]] = []
    if fields.get("title"):
        head.append(("title", fields["title"]))
    if fields.get("abstract"):
        head.append(("label", labels[0]))
        head.append(("p", fields["abstract"]))
    if fields.get("keywords"):
        head.append(("label", labels[1]))
        head.append(("p", fields["keywords"]))
    return [("lang", f"{labels[2]}\t{labels[3]}")] + head + blocks


def crossref_maps(blocks: list[tuple[str, str]]) -> tuple[dict[str, int], dict[str, int]]:
    figures: dict[str, int] = {}
    tables: dict[str, int] = {}
    figure_no = 0
    table_no = 0
    for index, (kind, content) in enumerate(blocks):
        if kind == "p":
            for ident in re.findall(r"\{#(fig-[A-Za-z0-9_-]+)", content):
                figure_no += 1
                figures.setdefault(ident, figure_no)
        elif kind == "table":
            table_no += 1
            caption = next((text for name, text in blocks[index + 1 :] if name == "tablecap"), "")
            for ident in re.findall(r"\{#(tbl-[A-Za-z0-9_-]+)", caption):
                tables.setdefault(ident, table_no)
    return figures, tables


def resolve_crossrefs(text: str, figures: dict[str, int], tables: dict[str, int], figure_word: str, table_word: str) -> str:
    """Figure @fig-1、Table @tbl-1 换成编号。对不上编号的只留名字，不留 @ 和花括号。"""

    def fig(ident: str) -> str:
        return f"{figure_word} {figures[ident]}" if ident in figures else ident

    def tbl(ident: str) -> str:
        return f"{table_word} {tables[ident]}" if ident in tables else ident

    ident = r"[A-Za-z0-9_-]+"
    # 图片/链接后面的 {#fig-1} 是 image_spans 判定编号与写图注的锚点，先摘出来，
    # 免得被下面的交叉引用替换吃掉，图注就没了。
    anchors: list[str] = []

    def stash(m: re.Match) -> str:
        anchors.append(m.group(0))
        return f"\x00ANCHOR{len(anchors) - 1}\x00"

    text = re.sub(r"\]\([^)]*\)\s*\{#[A-Za-z0-9_-]+\}", stash, text)
    # 表题末尾的 {#tbl-1} 是锚点：只在确属本文表题（在编号表里）时删除；对不上的键保留给正文。
    text = re.sub(r"\s*\{#(tbl-[^}]+)\}", lambda m: "" if m.group(1) in tables else m.group(0), text)
    text = re.sub(rf"\bFigure\s*@(fig-{ident})", lambda m: fig(m.group(1)), text)
    text = re.sub(rf"\bTable\s*@(tbl-{ident})", lambda m: tbl(m.group(1)), text)
    text = re.sub(rf"Fig\.\s*@(fig-{ident})", lambda m: fig(m.group(1)), text)
    text = re.sub(rf"(?<=图)\s*@(fig-{ident})", lambda m: f" {figures[m.group(1)]}" if m.group(1) in figures else m.group(1), text)
    text = re.sub(rf"(?<=表)\s*@(tbl-{ident})", lambda m: f" {tables[m.group(1)]}" if m.group(1) in tables else m.group(1), text)
    text = re.sub(rf"@(fig-{ident})", lambda m: fig(m.group(1)), text)
    text = re.sub(rf"@(tbl-{ident})", lambda m: tbl(m.group(1)), text)
    # 独立成对的 {#fig-x}/{#tbl-x}（不在图片后）：对上编号就收成编号，对不上只留键名。
    text = re.sub(rf"\{{#(fig-{ident})\}}", lambda m: fig(m.group(1)), text)
    text = re.sub(rf"\{{#(tbl-{ident})\}}", lambda m: tbl(m.group(1)), text)
    text = re.sub(r"\x00ANCHOR(\d+)\x00", lambda m: anchors[int(m.group(1))], text)
    return text.strip()


def brace_keys(text: str) -> list[tuple[int, int, str]]:
    """{#键} 里能在 bib 对上的，换成引用域。对不上的只去掉花括号，不留给 EndNote 搜索。"""
    out = []
    for match in CURLY_KEY.finditer(text):
        out.append((match.start(), match.end(), match.group(1)))
    return out


def plain_citations(text: str, bib: dict[str, dict]) -> str:
    """图注和表题里的引用只留作者-年。Zotero 刷新时，图注里的引用域会整篇报错。"""

    def replace(match: re.Match) -> str:
        group = []
        for key in parse_cite_keys(match.group(1)):
            rec = bib.get(key)
            if rec is not None:
                group.append(rec)
        return display_for(group) if group else match.group(0)

    return CITE_RE.sub(replace, text)


def caption_only_keys(rec_nums: dict[str, int], cited: list[str]) -> list[str]:
    """源稿引了、却一个引用域都没写成的键。图注/表题只写作者-年，
    只在那里出现的文献点 Update/Refresh 后进不了参考文献表。"""
    written = set(cited)
    return [key for key in rec_nums if key not in written]


def append_inline(
    p: ET.Element,
    text: str,
    bib: dict[str, dict],
    rec_nums: dict[str, int],
    cited: list[str],
    missing: list[str],
    in_code: bool,
):
    if in_code:
        p.append(run_text(text))
        return
    pos = 0
    spans = [(m.start(), m.end(), "cite", m.group(1)) for m in CITE_RE.finditer(text)]
    spans.extend((start, end, "brace", key) for start, end, key in brace_keys(text))
    spans.sort(key=lambda item: item[0])
    for start, end, kind, payload in spans:
        if start < pos:
            continue
        if start > pos:
            append_marked(p, text[pos:start])
        if kind == "brace":
            rec = bib.get(payload)
            if rec is None:
                append_marked(p, payload)
            else:
                cited.append(payload)
                display = display_for([rec])
                p.extend(cite_runs([rec], rec_nums, display))
            pos = end
            continue
        match_keys = payload
        keys = parse_cite_keys(match_keys)
        group = []
        for key in keys:
            cited.append(key)
            rec = bib.get(key)
            if rec is None:
                missing.append(key)
            else:
                group.append(rec)
        if group and not any(k not in bib for k in keys):
            display = display_for(group)
            p.extend(cite_runs(group, rec_nums, display))
        else:
            append_marked(p, text[start:end])
        pos = end
    if pos < len(text):
        append_marked(p, text[pos:])


def visible_text(root: ET.Element) -> str:
    return "".join(el.text or "" for el in root.iter(W + "t"))


def image_spans(text: str) -> list[tuple[int, int, str, str, bool]]:
    """Markdown 图片。说明里的 `[@键]` 含 `]`，只把 `](` 当作图片结束。

    第五项为真时，这张图带 `{#fig-}`，要单独写图注。行内小图为假。
    """
    found = []
    i = 0
    while True:
        start = text.find("![", i)
        if start < 0:
            break
        close = text.find("](", start + 2)
        end_paren = text.find(")", close + 2) if close >= 0 else -1
        if close < 0 or end_paren < 0:
            break
        alt = text[start + 2 : close]
        target = text[close + 2 : end_paren].strip().split()[0].strip("<>")
        end = end_paren + 1
        numbered = False
        if end < len(text) and text[end] == "{":
            attr = text.find("}", end)
            if attr >= 0:
                numbered = bool(re.search(r"#fig-[A-Za-z0-9_-]+", text[end : attr + 1]))
                end = attr + 1
        found.append((start, end, alt, target, numbered))
        i = end
    return found


def image_size(path: Path, data: bytes) -> tuple[int, int] | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
        return (width, height) if width and height else None
    if data.startswith(b"\xff\xd8"):
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2):
                height, width = struct.unpack(">HH", data[i + 5 : i + 9])
                return (width, height) if width and height else None
            if marker == 0xD8 or marker == 0xD9:
                i += 2
                continue
            if i + 4 > len(data):
                break
            i += 2 + struct.unpack(">H", data[i + 2 : i + 4])[0]
    if data.startswith((b"GIF87a", b"GIF89a")) and len(data) >= 10:
        width, height = struct.unpack("<HH", data[6:10])
        return (width, height) if width and height else None
    return None


def fit_emu(width: int, height: int) -> tuple[int, int]:
    cx = MAX_CX
    cy = max(1, int(cx * height / width))
    if cy > MAX_CY:
        cy = MAX_CY
        cx = max(1, int(cy * width / height))
    return cx, cy


def drawing_run(rel_id: str, name: str, doc_id: int, cx: int, cy: int) -> ET.Element:
    run = w_el("r")
    drawing = ET.SubElement(run, W + "drawing")
    inline = ET.SubElement(drawing, f"{{{WP_NS}}}inline")
    inline.set("distT", "0")
    inline.set("distB", "0")
    inline.set("distL", "0")
    inline.set("distR", "0")
    ET.SubElement(inline, f"{{{WP_NS}}}extent", {"cx": str(cx), "cy": str(cy)})
    ET.SubElement(inline, f"{{{WP_NS}}}effectExtent", {"l": "0", "t": "0", "r": "0", "b": "0"})
    ET.SubElement(inline, f"{{{WP_NS}}}docPr", {"id": str(doc_id), "name": name})
    graphic = ET.SubElement(
        ET.SubElement(inline, f"{{{A_NS}}}graphic"),
        f"{{{A_NS}}}graphicData",
        {"uri": PIC_NS},
    )
    pic = ET.SubElement(graphic, f"{{{PIC_NS}}}pic")
    nv = ET.SubElement(pic, f"{{{PIC_NS}}}nvPicPr")
    ET.SubElement(nv, f"{{{PIC_NS}}}cNvPr", {"id": str(doc_id), "name": name})
    ET.SubElement(nv, f"{{{PIC_NS}}}cNvPicPr")
    blip_fill = ET.SubElement(pic, f"{{{PIC_NS}}}blipFill")
    ET.SubElement(blip_fill, f"{{{A_NS}}}blip").set(f"{{{R_NS}}}embed", rel_id)
    ET.SubElement(ET.SubElement(blip_fill, f"{{{A_NS}}}stretch"), f"{{{A_NS}}}fillRect")
    sp = ET.SubElement(pic, f"{{{PIC_NS}}}spPr")
    xfrm = ET.SubElement(sp, f"{{{A_NS}}}xfrm")
    ET.SubElement(xfrm, f"{{{A_NS}}}off", {"x": "0", "y": "0"})
    ET.SubElement(xfrm, f"{{{A_NS}}}ext", {"cx": str(cx), "cy": str(cy)})
    ET.SubElement(ET.SubElement(sp, f"{{{A_NS}}}prstGeom", {"prst": "rect"}), f"{{{A_NS}}}avLst")
    return run


def resolve_image(source_dir: Path, target: str) -> Path | None:
    if not target or "://" in target:
        return None
    path = Path(target)
    if not path.is_absolute():
        path = source_dir / path
    try:
        path = path.resolve()
    except OSError:
        return None
    return path if path.is_file() else None


def table_rows(text: str) -> list[list[str]]:
    rows = []
    for line in text.splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
            continue
        rows.append(cells)
    return rows


def append_table(
    body: ET.Element,
    text: str,
    bib: dict[str, dict],
    rec_nums: dict[str, int],
    cited: list[str],
    missing: list[str],
) -> None:
    rows = table_rows(text)
    if not rows:
        return
    width = 9360
    cols = max(len(row) for row in rows)
    table = w_el("tbl")
    props = w_el("tblPr")
    props.append(w_el("tblW", **{"w": str(width), "type": "dxa"}))
    props.append(w_el("tblBorders"))
    borders = props[-1]
    borders.append(w_el("top", **{"val": "single", "sz": "12", "space": "0", "color": "000000"}))
    borders.append(w_el("bottom", **{"val": "single", "sz": "12", "space": "0", "color": "000000"}))
    for edge in ("left", "right", "insideH", "insideV"):
        borders.append(w_el(edge, **{"val": "nil"}))
    table.append(props)
    grid = w_el("tblGrid")
    col_w = str(width // cols)
    for _ in range(cols):
        grid.append(w_el("gridCol", **{"w": col_w}))
    table.append(grid)
    for index, row in enumerate(rows):
        tr = w_el("tr")
        if index == 0:
            tr.append(w_el("trPr"))
            tr[0].append(w_el("tblHeader"))
        for cell in row:
            tc = w_el("tc")
            tc_props = w_el("tcPr")
            tc_props.append(w_el("tcW", **{"w": col_w, "type": "dxa"}))
            if index == 0:
                cell_borders = w_el("tcBorders")
                cell_borders.append(w_el("bottom", **{"val": "single", "sz": "6", "space": "0", "color": "000000"}))
                tc_props.append(cell_borders)
            tc.append(tc_props)
            p = w_el("p")
            append_inline(p, cell, bib, rec_nums, cited, missing, False)
            if index == 0:
                for run in list(p):
                    if run.find(W + "t") is None:
                        continue
                    props = run.find(W + "rPr")
                    if props is None:
                        props = w_el("rPr")
                        run.insert(0, props)
                    props.append(w_el("b"))
            tc.append(p)
            tr.append(tc)
        table.append(tr)
    body.append(table)


def append_content(
    body: ET.Element,
    text: str,
    source_dir: Path,
    bib: dict[str, dict],
    rec_nums: dict[str, int],
    cited: list[str],
    missing: list[str],
    images: list[dict],
    missing_images: list[str],
    captions: list[str],
    figure_state: list[int],
    figure_word: str,
):
    spans = image_spans(text)
    if not spans:
        p = w_el("p")
        append_inline(p, text.replace("\n", " "), bib, rec_nums, cited, missing, False)
        body.append(p)
        return
    cursor = 0
    numbered_left = sum(1 for span in spans if span[4])
    for start, end, alt, target, numbered in spans:
        before = text[cursor:start].strip()
        if before:
            p = w_el("p")
            append_inline(p, before.replace("\n", " "), bib, rec_nums, cited, missing, False)
            body.append(p)
        path = resolve_image(source_dir, target)
        data = path.read_bytes() if path else b""
        size = image_size(path, data) if path else None
        if path is None or size is None:
            missing_images.append(target)
            p = w_el("p")
            p.append(run_text(f"[缺图 {target}]"))
            body.append(p)
        else:
            rel_id = f"rIdImg{len(images) + 1}"
            suffix = path.suffix.lower() or ".png"
            name = f"image{len(images) + 1}{suffix}"
            cx, cy = fit_emu(*size)
            images.append(
                {
                    "id": rel_id,
                    "name": name,
                    "data": data,
                    "suffix": suffix.lstrip("."),
                }
            )
            p = w_el("p")
            p.append(drawing_run(rel_id, name, len(images), cx, cy))
            body.append(p)
            caption_text = alt.replace("**", "").strip()
            # 一段里既有行内小图又有 {#fig-} 时，只给最后一张带锚点的图写图注。
            if numbered and numbered_left == 1:
                figure_state[0] += 1
                cap = w_el("p")
                cap_props = w_el("pPr")
                cap_props.append(w_el("jc", **{"val": "both"}))
                cap_props.append(w_el("ind", **{"firstLine": "0", "firstLineChars": "0"}))
                cap.append(cap_props)
                cap.append(run_text(f"{figure_word} {figure_state[0]}. ", bold=True))
                lead, rest = split_lead_sentence(plain_citations(caption_text, bib))
                before_runs = len(list(cap))
                append_inline(cap, lead, bib, rec_nums, cited, missing, False)
                for run in list(cap)[before_runs:]:
                    props = run.find(W + "rPr")
                    if props is None:
                        props = w_el("rPr")
                        run.insert(0, props)
                    if props.find(W + "b") is None:
                        props.append(w_el("b"))
                if rest:
                    append_inline(cap, rest, bib, rec_nums, cited, missing, False)
                body.append(cap)
                captions.append(caption_text)
            if numbered:
                numbered_left -= 1
        cursor = end
        # 图注已经单独成段。后面的正文不能再写进这一段。
    after = text[cursor:].strip()
    if after:
        p = w_el("p")
        append_inline(p, after.replace("\n", " "), bib, rec_nums, cited, missing, False)
        body.append(p)


def build_body(
    blocks: list[tuple[str, str]],
    source_dir: Path,
    bib: dict[str, dict],
    rec_nums: dict[str, int],
    cited: list[str],
    missing: list[str],
) -> tuple[ET.Element, list[dict], list[str]]:
    body = w_el("body")
    images: list[dict] = []
    captions: list[str] = []
    missing_images: list[str] = []
    numbers = [0, 0, 0, 0, 0, 0]
    figure_no = 0
    figure_count = [0]
    table_no = 0
    figure_word = "Figure"
    table_word = "Table"
    figures, tables = crossref_maps(blocks)
    for kind, content in blocks:
        if kind == "lang":
            words = (content or "").split("\t")
            figure_word = words[0] or figure_word
            table_word = words[1] if len(words) > 1 and words[1] else table_word
            continue
        content = resolve_crossrefs(content, figures, tables, figure_word, table_word)
        if kind == "code":
            p = w_el("p")
            p.append(run_text(content))
            body.append(p)
            continue
        if kind == "hr":
            p = w_el("p")
            props = w_el("pPr")
            border = w_el("pBdr")
            border.append(w_el("bottom", **{"val": "single", "sz": "6", "space": "1", "color": "888888"}))
            props.append(border)
            p.append(props)
            body.append(p)
            continue
        if kind == "table":
            table_no += 1
            append_table(body, content, bib, rec_nums, cited, missing)
            continue
        if kind == "tablecap":
            cap = w_el("p")
            props = w_el("pPr")
            props.append(w_el("jc", **{"val": "both"}))
            props.append(w_el("ind", **{"firstLine": "0", "firstLineChars": "0"}))
            cap.append(props)
            append_inline(cap, f"{table_word} {table_no}. {plain_citations(content, bib)}", bib, rec_nums, cited, missing, False)
            body.append(cap)
            continue
        if kind == "title":
            p = w_el("p")
            props = w_el("pPr")
            props.append(w_el("pStyle", **{"val": "Title"}))
            props.append(w_el("jc", **{"val": "center"}))
            p.append(props)
            append_inline(p, content, bib, rec_nums, cited, missing, True)
            body.append(p)
            continue
        if kind == "label":
            p = w_el("p")
            props = w_el("pPr")
            props.append(w_el("pStyle", **{"val": "Heading1"}))
            p.append(props)
            append_inline(p, content, bib, rec_nums, cited, missing, True)
            body.append(p)
            continue
        if kind.startswith("h") and kind[1:].isdigit():
            level = int(kind[1:])
            numbers[level - 1] += 1
            for deeper in range(level, 6):
                numbers[deeper] = 0
            prefix = ".".join(str(n) for n in numbers[:level] if n)
            p = w_el("p")
            props = w_el("pPr")
            props.append(w_el("pStyle", **{"val": f"Heading{level}"}))
            p.append(props)
            append_inline(p, f"{prefix} {content}", bib, rec_nums, cited, missing, True)
            body.append(p)
            continue
        append_content(
            body,
            content,
            source_dir,
            bib,
            rec_nums,
            cited,
            missing,
            images,
            missing_images,
            captions,
            figure_count,
            figure_word,
        )
    section = w_el("sectPr")
    section.append(w_el("pgSz", **{"w": "11906", "h": "16838"}))
    section.append(w_el("pgMar", **{
        "top": "1440", "right": "1440", "bottom": "1440", "left": "1440",
        "header": "720", "footer": "720", "gutter": "0",
    }))
    footer_ref = w_el("footerReference", **{"type": "default"})
    footer_ref.set(f"{{{R_NS}}}id", "rIdFooter")
    section.append(footer_ref)
    body.append(section)
    return body, images, missing_images


def default_cjk_font() -> str:
    # macOS 的 Word 认 Songti SC；Windows / Linux 上这个名字不存在，Word 会悄悄换成别的字体
    return "Songti SC" if sys.platform == "darwin" else "宋体"


def read_typeface(source: Path, project_root: str = "") -> tuple[str, str]:
    """读初稿字体脚本留下的 manuscript/typeface.md（两行：英文：… / 中文：…），域稿与阅读稿同一套字体。

    找法：稿件同目录 → 与稿件同级的 manuscript/（期刊格式适配的稿在 submission/）→ 指定的项目根。
    都没有就用默认：英文 Times New Roman、中文按平台。
    """
    latin, cjk = "Times New Roman", default_cjk_font()
    candidates = [source.parent / "typeface.md", source.parent.parent / "manuscript" / "typeface.md"]
    if project_root:
        candidates.append(Path(project_root) / "manuscript" / "typeface.md")
    for path in candidates:
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            head, sep, value = line.replace(":", "：", 1).partition("：")
            value = value.strip()
            if not sep or not value:
                continue
            if head.strip() == "英文":
                latin = value
            elif head.strip() == "中文":
                cjk = value
        break
    return latin, cjk


def write_docx(
    path: Path,
    body: ET.Element,
    images: list[dict] | None = None,
    fonts: tuple[str, str] | None = None,
):
    images = images or []
    document = ET.Element(W + "document")
    document.append(body)
    xml = ET.tostring(document, encoding="utf-8", xml_declaration=True)
    image_types = {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
    }
    defaults = [
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
    ]
    for suffix in sorted({img["suffix"] for img in images}):
        kind = image_types.get(suffix)
        if kind:
            defaults.append(f'<Default Extension="{suffix}" ContentType="{kind}"/>')
    ctypes = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        + "\n".join(defaults)
        + '\n<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '\n<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        + '\n<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>\n</Types>\n'
    )
    rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
"""
    styles = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>
<w:rPr><w:rFonts w:ascii="@@LATIN@@" w:hAnsi="@@LATIN@@" w:eastAsia="@@CJK@@"/>
<w:sz w:val="24"/></w:rPr><w:pPr><w:jc w:val="both"/><w:ind w:firstLineChars="200" w:firstLine="480"/>
<w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0" w:firstLineChars="0"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="0"/><w:jc w:val="left"/><w:ind w:firstLine="0" w:firstLineChars="0"/><w:spacing w:before="360" w:after="120"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="1"/><w:spacing w:before="280" w:after="80"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="2"/><w:spacing w:before="200" w:after="60"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="4"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="5"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
</w:styles>
"""
    latin_font, cjk_font = fonts or ("Times New Roman", default_cjk_font())
    styles = styles.replace("@@LATIN@@", sax_escape(latin_font, {'"': "&quot;"})).replace(
        "@@CJK@@", sax_escape(cjk_font, {'"': "&quot;"})
    )
    image_rels = "".join(
        f'<Relationship Id="{img["id"]}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/{img["name"]}"/>'
        for img in images
    )
    doc_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        + '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
        + image_rels
        + "</Relationships>\n"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", ctypes)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("word/_rels/document.xml.rels", doc_rels)
        footer = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
            '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>'
        )
        zf.writestr("word/footer1.xml", footer)
        zf.writestr("word/styles.xml", styles)
        zf.writestr("word/document.xml", xml)
        for img in images:
            zf.writestr(f"word/media/{img['name']}", img["data"])
    tmp.replace(path)


def write_report(path: Path, payload: dict):
    lines = [
        "# EndNote 域稿报告",
        "",
        f"- 源稿：`{payload['source']}`",
        f"- 引用处：{payload['spans']}",
        f"- 唯一键：{payload['unique']}",
        f"- 未匹配：{len(payload['missing'])}",
        f"- 插图：{payload.get('images', 0)}",
        f"- 缺图：{len(payload.get('missing_images') or [])}",
    ]
    if payload["missing"]:
        lines.append("")
        lines.append("未匹配键（未写 docx）：")
        for key in payload["missing"]:
            lines.append(f"- `{key}`")
        lines.append("")
        lines.append("补齐 references.bib 后重跑，不要把这份稿当 EndNote 可换样式。")
    if payload.get("missing_images"):
        lines.append("")
        lines.append("正文插图找不到或读不出尺寸（未写 docx）：")
        for target in payload["missing_images"]:
            lines.append(f"- `{target}`")
    else:
        lines.append("")
        if payload.get("caption_only"):
            lines.append("⚠ 下面这些文献只在图注或表题里引用。图注只写作者-年、不写引用域，点 Update 后它们进不了参考文献表。在正文里至少引用一次再重新生成：")
            lines.extend(f"- `{key}`" for key in payload["caption_only"])
            lines.append("")
        lines.append("打开 `output/endnote.docx`，在 EndNote 工具栏点 Update Citations and Bibliography，再换 Output Style。**先确认 EndNote 应用已在运行再开文档**：首次打开若插件无响应（按钮灰/无反应），是宿主还没就绪——等 EndNote 加载完库，或关掉文档重开一次即可，文档本身没坏。不要改源稿里的 `[@键]`。")
        lines.append("合意后另存为 `manuscript/source.docx`。不要覆盖这份报告或源稿。")
    binding = payload.get("binding") or []
    if binding:
        lines.append("")
        lines.append("## 库绑定")
        lines.extend(binding)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build EndNote-field docx from Markdown citations")
    parser.add_argument("--input", required=True)
    parser.add_argument("--bib", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--endnote-library", default="")
    parser.add_argument("--project-root", default="")
    args = parser.parse_args(argv)
    source = Path(args.input)
    bib_path = Path(args.bib)
    out = Path(args.output)
    report = Path(args.report)
    if out.resolve() == source.resolve() or out.suffix.lower() != ".docx":
        print("output must be a new .docx path", file=sys.stderr)
        return 1
    if not source.is_file() or not bib_path.is_file():
        print("source markdown or bib missing", file=sys.stderr)
        return 1
    bridge = load_bridge()
    records = {rec["id"]: rec for rec in bridge.load(bib_path) if rec.get("id")}
    # traveling library 里的题名/刊名与导入文件同一套化学上下标口径（<sup>0</sup> 收成 ⁰），
    # 否则没绑上库的记录刷新后会把字面 <sup> 文本带进参考文献表。标识符字段保持原样。
    for rec in records.values():
        rec["title"] = bridge.clean(rec.get("title") or "")
        rec["journal"] = bridge.clean(rec.get("journal") or "")
    # Update 前的可见文字做同年同姓消歧（(R. Zhang et al., 2026) / 2026a/b）
    decorate_disambiguation(records)
    text = source.read_text(encoding="utf-8-sig")
    blocks = split_blocks(text)
    cited: list[str] = []
    missing: list[str] = []
    # RecNum = first-appearance order among keys that exist in bib
    rec_nums: dict[str, int] = {}
    preview_keys: list[str] = []
    for kind, body in blocks:
        if kind == "code":
            continue
        for match in CITE_RE.finditer(body):
            for key in parse_cite_keys(match.group(1)):
                if key not in preview_keys:
                    preview_keys.append(key)
        for _start, _end, key in brace_keys(body):
            if key in records and key not in preview_keys:
                preview_keys.append(key)
    for key in preview_keys:
        if key in records:
            rec_nums[key] = len(rec_nums) + 1
    match = load_library_match()
    chosen = Path(args.endnote_library) if args.endnote_library else None
    root = Path(args.project_root) if args.project_root else None
    binding = match.bind_endnote(records, list(rec_nums), chosen, root)
    # 人看的防呆提示：域稿绑定的是记录号，库动过手术记录号就作废（2026-10-11 实证：
    # 生成前一分钟重建库，Update 整篇落漫游个人图书馆）。把绑定范围和这条规矩写进报告。
    bound_ids = sorted(
        rec["_en_rec"] for rec in records.values() if isinstance(rec.get("_en_rec"), int)
    )
    if bound_ids:
        binding.append(
            f"绑定记录号范围 {bound_ids[0]}–{bound_ids[-1]}。"
            "生成之后不要再对库做删除/重新导入——动了就要重新生成域稿，"
            "否则 Update 会把整篇落进「漫游个人图书馆」。"
        )
    # 库体检：旧版 Mesa 导出的脏记录会让新导入的去重认不出、旧数据残留。
    # 只读检查；检出就给出「先删再导」的处方，库干净时零输出。
    lib_for_check = chosen or match.endnote_pointer(root)
    if lib_for_check:
        stale, stale_note = match.endnote_stale_records(lib_for_check)
        if stale_note:
            binding.append(f"库体检未完成：{stale_note}")
        elif stale:
            binding.append(
                f"库体检：检出 {len(stale)} 条旧版导出的脏记录。不先删掉，"
                "重新导入时去重认不出，旧数据会残留："
            )
            binding.extend(f"- {h}" for h in stale)
            binding.append("处方：在 EndNote 按上面清单的标题搜索并删除这些记录，再导入新的 endnote-library.ris。")
    body_el, images, missing_images = build_body(
        blocks, source.parent, records, rec_nums, cited, missing
    )
    children = list(body_el)
    insert_at = next((i for i, child in enumerate(children) if child.tag == W + "sectPr"), len(children))
    body_el.insert(insert_at, heading_paragraph("References"))
    reflist = w_el("p")
    # 实稿的 REFLIST 带一个空 fldData；Update 往这里填参考文献表
    reflist.extend(
        field_runs(" ADDIN EN.REFLIST ", " ", with_data=True)
    )
    body_el.insert(insert_at + 1, reflist)
    uniq_missing = sorted(set(missing))
    payload = {
        "source": str(source),
        "spans": len(cited),
        "unique": len(set(cited)),
        "missing": uniq_missing,
        "images": len(images),
        "missing_images": missing_images,
        "caption_only": caption_only_keys(rec_nums, cited),
        "binding": binding,
    }
    write_report(report, payload)
    if payload["caption_only"]:
        print("cited only in captions (not in bibliography after Update): " + ", ".join(payload["caption_only"]), file=sys.stderr)
    if uniq_missing:
        print("unmatched citation keys: " + ", ".join(uniq_missing), file=sys.stderr)
        return 1
    if missing_images:
        print("missing figures: " + ", ".join(missing_images), file=sys.stderr)
        return 1
    visible = visible_text(body_el)
    if CURLY_KEY.search(visible) or CURLY_TEMP.search(visible):
        print("visible text contains {Author, Year} or an unmatched brace key; refusing to write docx", file=sys.stderr)
        return 1
    write_docx(out, body_el, images, read_typeface(source, args.project_root))
    return 0


if __name__ == "__main__":
    sys.exit(main())
