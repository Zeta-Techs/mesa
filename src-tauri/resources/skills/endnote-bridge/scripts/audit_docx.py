#!/usr/bin/env python3
"""已有 Word + EndNote 稿件的只读体检（endnote-bridge 技能随包，2026-11-08）。

两个子命令，都只读 docx，绝不改写引文域：
  marks  列出标黄、修订、批注与文档属性里的作者名——审改前读出人标过的地方，交付前确认没留下修订 / 批注 / 别人的名字
  cites  逐条体检 EndNote 引文域：域数据能不能解析、有没有被截断、换行是不是 CRLF；句中点名的作者和所引记录对不对得上；
         混用了几个库、库里有没有重复记录、编号是否按首次出现排序、参考文献表条数；图注等处手写的 Ref. N
         结果写进 <根目录>/.ccode/checks/cite-docx.jsonl（Mesa 核验项三档），并写一份「在 EndNote 里怎么改」清单

为什么只读：已有稿件的引文域是 EndNote 自己的数据，改错一个字节 Word 存盘就会截断或绑错文献（2026-11-08 实证：
fldData 换行写成 LF，Word 一存 35 条引文全坏）。增删引文、换文献、重新编号一律交给人在 EndNote 里做，再点 Update。

退出码：0 没有拦下的；1 有拦下的；2 文件打不开等环境问题。Windows 上把 python3 换成 python。
"""
from __future__ import annotations

import argparse
import base64
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
    raise FileNotFoundError("找不到 mesa_checks.py（应与本脚本同目录）。在技能页更新 endnote-bridge 技能后再试")


C = load_common()
CHECKER = "script:audit_docx"
CHECK_FILE = "cite-docx.jsonl"

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
# 段内要往下走的容器；图形、文本框不进（文本框在 AlternateContent 里还有一份备份，进去会算两遍）
INLINE_CONTAINERS = {W + t for t in ("r", "hyperlink", "ins", "del", "moveFrom", "moveTo", "smartTag", "sdt",
                                     "sdtContent", "customXml", "fldSimple", "dir", "bdo")}
BLOCK_CONTAINERS = {W + t for t in ("tbl", "tr", "tc", "sdt", "sdtContent", "customXml")}
DELETED = {W + "del", W + "moveFrom"}
REVISIONS = {W + "ins": "插入", W + "del": "删除", W + "moveFrom": "移出", W + "moveTo": "移入"}

# 句中点名：「Smith et al.」「Smith and co-workers」「Smith, Lee and colleagues」
NAMED = re.compile(
    r"((?:[A-Z][\w'’\-–]+)(?:\s*,\s*[A-Z][\w'’\-–]+)*(?:\s+[A-Z][\w'’\-–]+)?)\s+"
    r"(?:and co-workers|and coworkers|and colleagues|et al\.)"
)
# 句末判断时不当句号的缩写
ABBR = {"al", "fig", "figs", "e.g", "i.e", "ref", "refs", "eq", "eqs", "vs", "ca", "approx", "no", "cf", "etc", "ch", "sec"}
HANDREF = re.compile(r"\b(?:[Rr]efs?\.|[Rr]eferences?)\s*\[?\s*\d+")
NUMERIC_RESULT = re.compile(r"^[\[(]?\s*\d+(?:\s*[-–—,]\s*\d+)*\s*[\])]?$")


# ---------- 读 docx ----------

class Field:
    def __init__(self, para, start, fld_index, parent):
        self.instr = ""
        self.phase = "instr"
        self.result = ""
        self.para = para
        self.start = start
        self.end = None
        self.end_para = None
        self.fld_index = fld_index
        self.children = []
        self.paras = []
        if parent is not None:
            parent.children.append(self)

    @property
    def kind(self):
        s = self.instr.lstrip()
        if s.startswith("ADDIN EN.CITE.DATA"):
            return "data"
        if s.startswith("ADDIN EN.CITE"):
            return "cite"
        if s.startswith("ADDIN EN.REFLIST"):
            return "reflist"
        return "other"


class Para:
    def __init__(self, index, style):
        self.index = index
        self.style = style
        self.text = ""       # 可见文字（含域结果，不含删除的）
        self.plain = ""      # 不在任何域里的文字
        self.highlights = []  # [start, end, color]


class Doc:
    def __init__(self, path: Path):
        self.path = path
        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())
            raw = zf.read("word/document.xml")
            self.comments_xml = zf.read("word/comments.xml") if "word/comments.xml" in names else None
            self.core_xml = zf.read("docProps/core.xml") if "docProps/core.xml" in names else None
            self.people_xml = zf.read("word/people.xml") if "word/people.xml" in names else None
            self.settings_xml = zf.read("word/settings.xml") if "word/settings.xml" in names else None
        # XML 解析会把 \r\n 折成 \n，换行格式只能看原始字节；第 n 个 fldData 与解析树里第 n 个一一对应
        self.fld_raw = re.findall(rb"<w:fldData[^>]*>(.*?)</w:fldData>", raw, re.S)
        root = ET.fromstring(raw)
        self.fld_order = {id(el): i for i, el in enumerate(root.iter(W + "fldData"))}
        self.paras: list[Para] = []
        self.fields: list[Field] = []
        self.stack: list[Field] = []
        self.revisions = []
        self.format_changes = 0
        self.anchors: dict[str, str] = {}
        self.anchor_para: dict[str, int] = {}
        self.active_comments: set[str] = set()
        body = root.find(W + "body")
        for p in self._block_paras(body if body is not None else root):
            self._para(p)

    def _block_paras(self, el):
        for child in el:
            if child.tag == W + "p":
                yield child
            elif child.tag in BLOCK_CONTAINERS:
                yield from self._block_paras(child)

    def _para(self, p):
        ppr = p.find(W + "pPr")
        style = ""
        if ppr is not None:
            ps = ppr.find(W + "pStyle")
            style = ps.get(W + "val", "") if ps is not None else ""
            if ppr.find(W + "pPrChange") is not None:
                self.format_changes += 1
        para = Para(len(self.paras) + 1, style)
        self.paras.append(para)
        self._inline(p, para, deleted=False)

    def _inline(self, el, para, deleted, highlight=None):
        for child in el:
            tag = child.tag
            if tag in REVISIONS:
                text = "".join(t.text or "" for t in child.iter() if t.tag in (W + "t", W + "delText"))
                self.revisions.append({
                    "type": REVISIONS[tag], "author": child.get(W + "author", ""),
                    "date": child.get(W + "date", ""), "text": text, "para": para.index,
                })
                self._inline(child, para, deleted or tag in DELETED)
            elif tag == W + "r":
                self._run(child, para, deleted)
            elif tag == W + "fldSimple":
                f = Field(para.index, len(para.text), None, self.stack[-1] if self.stack else None)
                f.instr = child.get(W + "instr", "")
                f.phase = "result"
                self.stack.append(f)
                self._inline(child, para, deleted)
                self._close(para)
            elif tag == W + "commentRangeStart":
                cid = child.get(W + "id", "")
                self.active_comments.add(cid)
                self.anchors.setdefault(cid, "")
                self.anchor_para.setdefault(cid, para.index)
            elif tag == W + "commentRangeEnd":
                self.active_comments.discard(child.get(W + "id", ""))
            elif tag in INLINE_CONTAINERS:
                self._inline(child, para, deleted)

    def _run(self, r, para, deleted):
        rpr = r.find(W + "rPr")
        color = None
        if rpr is not None:
            hl = rpr.find(W + "highlight")
            if hl is not None and hl.get(W + "val", "none") != "none":
                color = hl.get(W + "val")
            if rpr.find(W + "rPrChange") is not None:
                self.format_changes += 1
        for child in r:
            tag = child.tag
            if tag == W + "fldChar":
                kind = child.get(W + "fldCharType")
                if kind == "begin":
                    fd = child.find(W + "fldData")
                    idx = self.fld_order.get(id(fd)) if fd is not None else None
                    self.stack.append(Field(para.index, len(para.text), idx, self.stack[-1] if self.stack else None))
                elif kind == "separate" and self.stack:
                    self.stack[-1].phase = "result"
                elif kind == "end" and self.stack:
                    self._close(para)
            elif tag == W + "instrText":
                if self.stack and not deleted:
                    self.stack[-1].instr += child.text or ""
            elif tag == W + "t":
                if not deleted:
                    self._text(child.text or "", para, color)
            elif tag in (W + "tab",):
                if not deleted:
                    self._text("\t", para, None)
            elif tag in (W + "br", W + "cr"):
                if not deleted:
                    self._text(" ", para, None)
            elif tag == W + "noBreakHyphen" and not deleted:
                self._text("-", para, None)
            elif tag == W + "sym" and not deleted:
                self._text("?", para, None)

    def _text(self, s, para, color):
        if not s:
            return
        start = len(para.text)
        para.text += s
        if not self.stack:
            para.plain += s
        for f in self.stack:
            if f.phase == "result":
                f.result += s
                if not f.paras or f.paras[-1] != para.index:
                    f.paras.append(para.index)
        if color:
            last = para.highlights[-1] if para.highlights else None
            if last and last[1] == start and last[2] == color:
                last[1] = len(para.text)
            else:
                para.highlights.append([start, len(para.text), color])
        for cid in self.active_comments:
            self.anchors[cid] = self.anchors.get(cid, "") + s

    def _close(self, para):
        f = self.stack.pop()
        f.end = len(para.text)
        f.end_para = para.index
        self.fields.append(f)


# ---------- 引文载荷 ----------

def text_of(el):
    return re.sub(r"\s+", " ", "".join(el.itertext())).strip() if el is not None else ""


def decode_payload(raw: bytes):
    """fldData 原始字节 → (EndNote XML 文本或 None, 问题说明或 None)。"""
    body = b"".join(raw.replace(b"&#xD;", b"").replace(b"&#13;", b"").split())
    if not body:
        return None, "域数据是空的"
    try:
        data = base64.b64decode(body, validate=True)
    except Exception:
        return None, "域数据不是有效的 base64，已损坏"
    text = data.decode("utf-8", "replace").rstrip("\x00")
    if not text.rstrip().endswith("</EndNote>"):
        return None, f"域数据被截断（解出 {len(text)} 个字符，没有以 </EndNote> 结尾）"
    return text, None


def line_ending_problem(raw: bytes):
    """EndNote / Word 写的 fldData 每 76 列一行、行尾 CRLF；只有 LF 时 Word 存盘会把数据截断。"""
    has_cr = b"\r" in raw or b"&#xD;" in raw or b"&#13;" in raw
    if b"\n" in raw and not has_cr:
        return "域数据换行是 LF（EndNote 与 Word 写的是 CRLF）：这份文件一旦在 Word 里保存，引文数据会被截断"
    return None


def parse_cites(xml_text):
    root = ET.fromstring(xml_text)
    cites = []
    for c in root.iter("Cite"):
        rec = c.find("record")
        authors, title, journal, year, doi, db_id, recnum = [], "", "", "", "", "", ""
        if rec is not None:
            authors = [text_of(a) for a in rec.iter("author") if text_of(a)]
            t = rec.find("titles/title")
            title = text_of(t)
            journal = text_of(rec.find("titles/secondary-title")) or text_of(rec.find("periodical/full-title"))
            year = text_of(rec.find("dates/year"))
            doi = text_of(rec.find("electronic-resource-num"))
            recnum = text_of(rec.find("rec-number"))
            for k in rec.iter("key"):
                if k.get("app") == "EN":
                    db_id = k.get("db-id", "")
                    recnum = (k.text or "").strip() or recnum
                    break
        cites.append({
            "author": text_of(c.find("Author")), "year": text_of(c.find("Year")) or year,
            "recnum": recnum or text_of(c.find("RecNum")), "db_id": db_id, "authors": authors,
            "title": title, "journal": journal, "doi": doi,
        })
    return cites


def identity(cite):
    if cite["recnum"]:
        return (cite["db_id"], cite["recnum"])
    return ("", norm_title(cite["title"]) or cite["author"] + cite["year"])


def norm(s):
    s = unicodedata.normalize("NFKD", s)
    return "".join(ch for ch in s.lower() if "a" <= ch <= "z")


def norm_title(s):
    return norm(s)[:120]


def surname_tokens(author):
    """'García Lastra, J. M.' → {'garcialastra','garcia','lastra'}；没有逗号时取最后一个词。"""
    fam = author.split(",")[0] if "," in author else (author.split() or [""])[-1]
    toks = {norm(fam)} | {norm(t) for t in re.split(r"[\s\-–’']+", fam)}
    return {t for t in toks if len(t) > 1}


def short(cite):
    first = cite["authors"][0].split(",")[0] if cite["authors"] else cite["author"]
    t = cite["title"]
    t = t[:70] + "…" if len(t) > 70 else t
    return f"{first} {cite['year']}《{t}》" + (f" {cite['journal']}" if cite["journal"] else "")


def numbers_in(result):
    nums = []
    for a, b in re.findall(r"(\d+)\s*(?:[-–—]\s*(\d+))?", result):
        a = int(a)
        nums += list(range(a, int(b) + 1)) if b and int(b) >= a and int(b) - a < 200 else [a]
    return nums


def sentence_start(text):
    """text 里最后一个句子的起点（跳过 et al. / Fig. 一类缩写后的句点）。"""
    start = 0
    for m in re.finditer(r"[.!?]\s+(?=[A-Z(\[])", text):
        word = re.search(r"([A-Za-z.]+)$", text[: m.start()])
        if m.group(0)[0] == "." and word and word.group(1).lower().rstrip(".") in ABBR:
            continue
        start = m.end()
    return start


def snippet(text, start, end=None, width=60):
    end = start if end is None else end
    left = text[max(0, start - width): start]
    return ("…" if start > width else "") + re.sub(r"\s+", " ", left + text[start:end]).strip()


# ---------- cites ----------

def audit_cites(doc: Doc, rel: str):
    items, fixes = [], {"cite": [], "field": [], "library": [], "update": []}
    paras = {p.index: p for p in doc.paras}
    cites_fields = [f for f in doc.fields if f.kind == "cite"]
    # doc.fields 按「结束」先后排；按开始位置排回文中顺序
    cites_fields.sort(key=lambda f: (f.para, f.start))
    entries = []
    bad_fields = 0
    for n, f in enumerate(cites_fields, 1):
        para = paras[f.para]
        where = f"第 {f.para} 段「{snippet(para.text, f.start, f.end if f.end_para == f.para else None)}」"
        payload, problem = None, None
        inline = f.instr.split("ADDIN EN.CITE", 1)[1].strip() if "ADDIN EN.CITE" in f.instr else ""
        raws = []
        if inline.startswith("<EndNote"):
            payload = inline
            if not payload.endswith("</EndNote>"):
                payload, problem = None, "域指令里的引文数据不完整"
        else:
            for g in [f] + [c for c in f.children if c.kind == "data"]:
                if g.fld_index is not None and g.fld_index < len(doc.fld_raw):
                    raws.append(doc.fld_raw[g.fld_index])
            if not raws:
                problem = "没有找到引文数据（域指令和域数据里都没有）"
            else:
                payload, problem = decode_payload(raws[0])
                for other in raws[1:]:
                    p2, pr2 = decode_payload(other)
                    if pr2 and not problem:
                        problem = "内层 EN.CITE.DATA " + pr2
        if payload and not problem:
            try:
                cites = parse_cites(payload)
                if not cites:
                    problem = "引文数据里没有 <Cite>"
            except ET.ParseError as e:
                problem, cites = f"引文数据不是完整的 XML（{e}）", []
        else:
            cites = []
        line_issue = next((x for x in (line_ending_problem(r) for r in raws) if x), None)
        if problem or line_issue:
            bad_fields += 1
            detail = "；".join(x for x in (problem, line_issue) if x)
            items.append(item(f"FIELD-{n}", "field-data", "blocked", f"引文域数据有问题：{where}", rel,
                              detail=detail + "。不要再在 Word 里保存这份文件；从更早的备份里找这条引文完好的版本，"
                                                "或在 EndNote 里删掉这条引文重新插入。"))
            fixes["field"].append(f"{where}（显示为「{f.result.strip()}」）：{detail}")
        entries.append({"n": n, "field": f, "para": para, "where": where, "cites": cites})

    if cites_fields and not bad_fields:
        items.append(item("FIELD-ALL", "field-data", "passed", f"{len(cites_fields)} 条引文域数据完好（能解析、未截断、CRLF 换行）", rel))

    # 句中点名的作者 ↔ 所引记录。同一句里点名后常先插一条佐证引文、点名那篇在句子后面，
    # 所以从点名处往后看到句末：句内任何一条引文里有这位作者就算对上
    by_para = {}
    for e in entries:
        by_para.setdefault(e["field"].para, []).append(e)
    for plist in by_para.values():
        prev_end = 0
        for i, e in enumerate(plist):
            f, para = e["field"], e["para"]
            seg_from = prev_end
            prev_end = f.end if f.end_para == f.para else len(para.text)
            before = para.text[seg_from: f.start]
            before = before[sentence_start(before):]
            names = list(NAMED.finditer(before))
            if not names:
                continue
            m = names[-1]
            tokens = {norm(t) for t in re.split(r"[\s,]+", m.group(1)) if norm(t) and norm(t) != "and"}
            same_sentence = [e]
            for nxt in plist[i + 1:]:
                cur = same_sentence[-1]["field"]
                # 上标式编号常紧跟句号（「…materials.5-8」）：这条引文已经收了句
                if para.text[:cur.start].rstrip().endswith((".", "!", "?")) or cur.end_para != cur.para:
                    break
                if sentence_start(para.text[cur.end: nxt["field"].start]):
                    break
                same_sentence.append(nxt)
            label = f"{e['where']} 点名 {m.group(1)}"
            hit = None
            for cand in same_sentence:
                for c in cand["cites"]:
                    if any(tokens & surname_tokens(a) for a in c["authors"]):
                        hit = cand
                        break
                if hit:
                    break
            cited = "；".join(short(c) for cand in same_sentence for c in cand["cites"])
            if hit:
                items.append(item(f"NAME-{hit['n']}", "named-author", "passed",
                                  f"{hit['where']} 点名 {m.group(1)}，与所引记录作者一致", rel))
            elif not any(c["authors"] for cand in same_sentence for c in cand["cites"]):
                items.append(item(f"NAME-{e['n']}", "named-author", "needs_human",
                                  f"{label}，所引记录没有作者信息，核对不了", rel, detail=f"所引：{cited}"))
            else:
                items.append(item(f"NAME-{e['n']}", "named-author", "blocked",
                                  f"{label}，但这句里的引文都没有这位作者", rel, detail=f"这句所引：{cited}"))
                fixes["cite"].append(f"{e['where']}：句中点名 {m.group(1)}，这句引的是 {cited}。"
                                     f"在 Word 里选中引文 → EndNote 工具栏 Edit & Manage Citation(s) → 换成或加上 {m.group(1)} 的那篇")

    # 库：混用、重复、未绑定
    all_cites = [(e, c) for e in entries for c in e["cites"]]
    by_db = {}
    for e, c in all_cites:
        by_db.setdefault(c["db_id"], []).append((e, c))
    bound = {k: v for k, v in by_db.items() if k}
    if len(bound) > 1:
        main_db = max(bound, key=lambda k: len(bound[k]))
        for db, lst in bound.items():
            if db == main_db:
                continue
            where = "；".join(f"{e['where']} → {short(c)}" for e, c in lst[:8]) + ("……" if len(lst) > 8 else "")
            items.append(item(f"DBID-{db[:12]}", "library", "needs_human",
                              f"{len(lst)} 处引文来自另一个 EndNote 库（{db}），稿里主要用的是 {main_db}", rel,
                              detail="Update 时不在当前打开的库里的记录会进「漫游库」，同一记录号在两个库里可能是两篇不同的文献。"
                                     f"涉及：{where}"))
            for e, c in lst:
                fixes["cite"].append(f"{e['where']}：{short(c)} 来自另一个库（{db}）。在当前库里找到同一篇，"
                                     "用 Edit & Manage Citation(s) 删掉这条再从当前库插入")
    unbound = by_db.get("", [])
    if unbound and bound:
        items.append(item("UNBOUND", "library", "needs_human", f"{len(unbound)} 处引文没有绑定库记录号（只有随文题录）", rel,
                          detail="；".join(f"{e['where']} → {short(c)}" for e, c in unbound[:8])))
    for db, lst in bound.items():
        groups = {}
        for e, c in lst:
            key = norm_title(c["title"]) or (c["doi"] or "").lower()
            if key:
                groups.setdefault(key, {})[c["recnum"]] = c
        for key, recs in groups.items():
            if len(recs) > 1:
                nums = sorted(recs, key=lambda x: int(x) if x.isdigit() else 0)
                c = next(iter(recs.values()))
                items.append(item(f"DUP-{db[:8]}-{'-'.join(nums)}", "library", "needs_human",
                                  f"库里疑似重复记录：{short(c)}（记录号 {', '.join(nums)}）", rel,
                                  detail="同一篇文献在稿里用了不同的记录号，Update 后参考文献表会出现两条。"))
                fixes["library"].append(f"{short(c)}：库里记录号 {', '.join(nums)} 是同一篇。保留一条，"
                                        "在稿里把引用另一条的位置用 Edit & Manage Citation(s) 换成保留的那条，再删多余记录")

    # 编号顺序与参考文献表
    numeric = [e for e in entries if e["cites"]]
    if numeric and all(NUMERIC_RESULT.match(e["field"].result.strip() or "x") for e in numeric):
        rank, wrong = {}, []
        for e in numeric:
            for c in e["cites"]:
                rank.setdefault(identity(c), len(rank) + 1)
            shown = numbers_in(e["field"].result)
            k = len({identity(c) for c in e["cites"]})
            if len(shown) != k:
                listed = "；".join(short(c) for c in e["cites"])
                items.append(item(f"COUNT-{e['n']}", "numbering", "needs_human",
                                  f"{e['where']}：这条引文域里有 {k} 篇文献，只显示 {len(shown)} 个编号", rel,
                                  detail=f"域里的文献：{listed}。多出来的会在 Update 后冒出来，后面的编号全部顺延。"))
                fixes["cite"].append(f"{e['where']}：域里有 {k} 篇（{listed}），正文只显示 {len(shown)} 个编号。"
                                     "选中这条引文 → Edit & Manage Citation(s)，删掉不该在这里的")
        for e in numeric:
            expect = sorted({rank[identity(c)] for c in e["cites"]})
            shown = sorted(set(numbers_in(e["field"].result)))
            if expect != shown:
                wrong.append(f"{e['where']} 显示 {e['field'].result.strip()}，按首次出现应为 {expect}")
        if wrong:
            items.append(item("NUM-ORDER", "numbering", "needs_human",
                              f"{len(wrong)} 处引文编号与首次出现顺序对不上，可能改过引用后没点 Update", rel,
                              detail="从第一处往后看，后面的多半是它带着顺延的："
                                     + "；".join(wrong[:10]) + ("……" if len(wrong) > 10 else "")))
            fixes["update"].append("引文编号与首次出现顺序对不上：在 Word 里点 EndNote 工具栏 Update Citations and Bibliography")
        else:
            items.append(item("NUM-ORDER", "numbering", "passed", f"{len(rank)} 篇文献的编号与首次出现顺序一致", rel))
        reflists = [f for f in doc.fields if f.kind == "reflist"]
        if reflists:
            entries_n = sum(1 for i in reflists[0].paras if paras[i].text.strip())
            if entries_n != len(rank):
                items.append(item("BIB-COUNT", "numbering", "needs_human",
                                  f"参考文献表 {entries_n} 条，正文引用了 {len(rank)} 篇", rel,
                                  detail="多出的条目没被正文引用，或表还没随最新引用刷新。点一次 Update 后再看。"))
                fixes["update"].append(f"参考文献表 {entries_n} 条、正文引了 {len(rank)} 篇：点 Update 后核对")

    # 手写的参考文献编号（图注、表注里常见），Update 不会跟着改
    for p in doc.paras:
        for m in HANDREF.finditer(p.plain):
            items.append(item(f"HANDREF-{p.index}-{m.start()}", "handwritten-ref", "needs_human",
                              f"第 {p.index} 段手写了「{m.group(0)}」，Update 改编号后它不会跟着变", rel,
                              detail=snippet(p.plain, m.start(), m.end())))
            fixes["update"].append(f"第 {p.index} 段「{snippet(p.plain, m.start(), m.end())}」：Update 之后人工核对这个编号")
            break
    return items, fixes, len(cites_fields)


def item(*args, **kwargs):
    return C.item(CHECKER, *args, **kwargs)


def fix_report(rel, fixes, total):
    lines = [f"# 在 EndNote 里怎么改：{rel}", "",
             f"共 {total} 条引文域。本清单由只读体检生成，脚本没有改动这份 Word。下面每一项都在 Word / EndNote 里由你来改，"
             "改完点一次 Update Citations and Bibliography。", ""]
    sections = [("field", "引文域数据损坏（先处理，别再保存）"), ("cite", "正文引文要换的"),
                ("library", "EndNote 库记录"), ("update", "点 Update 之后核对")]
    empty = True
    for key, title in sections:
        if fixes[key]:
            empty = False
            lines += [f"## {title}", ""] + [f"- {x}" for x in fixes[key]] + [""]
    if empty:
        lines.append("没有需要在 EndNote 里改的地方。")
    return "\n".join(lines) + "\n"


# ---------- marks ----------

def core_props(doc: Doc):
    out = {}
    if doc.core_xml:
        root = ET.fromstring(doc.core_xml)
        for el in root:
            name = el.tag.split("}")[-1]
            if name in ("creator", "lastModifiedBy") and (el.text or "").strip():
                out[name] = el.text.strip()
    people = []
    if doc.people_xml:
        people = [el.get("{http://schemas.microsoft.com/office/word/2012/wordml}author", "")
                  for el in ET.fromstring(doc.people_xml)]
        people = [p for p in people if p]
    tracking = bool(doc.settings_xml and b"<w:trackRevisions" in doc.settings_xml)
    return out, people, tracking


def comments(doc: Doc):
    out = []
    if not doc.comments_xml:
        return out
    for c in ET.fromstring(doc.comments_xml).iter(W + "comment"):
        cid = c.get(W + "id", "")
        out.append({"id": cid, "author": c.get(W + "author", ""), "date": c.get(W + "date", ""),
                    "text": " ".join(text_of(p) for p in c.iter(W + "p")).strip(),
                    "anchor": doc.anchors.get(cid, "").strip(), "para": doc.anchor_para.get(cid)})
    return out


def lock_file(path: Path):
    """Word 打开文件时在同目录留 ~$ 开头的锁文件（长文件名去掉前两个字符）。"""
    name = path.name
    for cand in path.parent.glob("~$*"):
        tail = cand.name[2:]
        if tail and (name.endswith(tail) or name == tail):
            return cand
    return None


def marks_report(doc: Doc, rel: str):
    lines = [f"# 稿件标记：{rel}", ""]
    lock = lock_file(doc.path)
    if lock:
        lines += [f"注意：同目录有 Word 锁文件 {lock.name}，这份稿件正在 Word 里打开。改动另存成新文件名，不要覆盖它。", ""]
    hl = [(p, s, e, c) for p in doc.paras for s, e, c in p.highlights if p.text[s:e].strip()]
    lines += [f"## 标黄 / 高亮（{len(hl)} 处）", ""]
    for p, s, e, c in hl:
        color = "" if c == "yellow" else f"〔{c}〕"
        lines.append(f"- 第 {p.index} 段{color}：{p.text[s:e].strip()}")
    revs = [r for r in doc.revisions if r["text"].strip()]
    lines += ["", f"## 修订（{len(revs)} 处文字修订，{doc.format_changes} 处格式修订）", ""]
    for r in revs:
        who = f"{r['author']} " if r["author"] else ""
        lines.append(f"- 第 {r['para']} 段 {who}{r['type']}：{r['text'].strip()}")
    cms = comments(doc)
    lines += ["", f"## 批注（{len(cms)} 条）", ""]
    for c in cms:
        at = f"第 {c['para']} 段" if c["para"] else "未锚定"
        anchor = f"「{c['anchor']}」" if c["anchor"] else ""
        lines.append(f"- {at}{anchor} {c['author']}：{c['text']}")
    props, people, tracking = core_props(doc)
    authors = sorted({r["author"] for r in doc.revisions if r["author"]} | {c["author"] for c in cms if c["author"]})
    lines += ["", "## 文档里留下的名字与状态", "",
              f"- 作者（creator）：{props.get('creator', '无')}",
              f"- 最后修改者（lastModifiedBy）：{props.get('lastModifiedBy', '无')}",
              f"- 修订 / 批注署名：{'、'.join(authors) if authors else '无'}",
              f"- 审阅人列表（people.xml）：{'、'.join(people) if people else '无'}",
              f"- 修订模式：{'开着' if tracking else '关着'}"]
    counts = {"highlights": len(hl), "revisions": len(revs) + doc.format_changes, "comments": len(cms)}
    return "\n".join(lines) + "\n", counts


# ---------- 入口 ----------

def open_doc(path):
    try:
        return Doc(path), None
    except FileNotFoundError:
        return None, f"找不到文件：{path}"
    except (zipfile.BadZipFile, KeyError):
        return None, f"不是有效的 docx（.doc 先在 Word 里另存为 .docx）：{path}"
    except ET.ParseError as e:
        return None, f"docx 正文解析失败：{e}"


def rel_to(path: Path, root: Path):
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.name


def write_text(path: Path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def cmd_marks(args):
    root = Path(args.root)
    path = Path(args.docx)
    doc, err = open_doc(path)
    if err:
        print(err, file=sys.stderr)
        return 2
    report, counts = marks_report(doc, rel_to(path, root))
    out = Path(args.report) if args.report else root / "output" / "docx-marks.md"
    write_text(out, report)
    print(f"标黄 {counts['highlights']} 处，修订 {counts['revisions']} 处，批注 {counts['comments']} 条；清单写入 {out}")
    if lock_file(path):
        print("注意：这份稿件正在 Word 里打开（有 ~$ 锁文件），改动另存新文件名")
    return 0


def cmd_cites(args):
    root = Path(args.root)
    path = Path(args.docx)
    doc, err = open_doc(path)
    rel = rel_to(path, root)
    if err:
        print(err, file=sys.stderr)
        items = [item("DOCX", "field-data", "needs_human", f"打不开稿件，没做体检：{err}", rel)]
        C.write_items(root, CHECK_FILE, items)
        return 2
    items, fixes, total = audit_cites(doc, rel)
    if not total:
        items.append(item("NO-CITES", "field-data", "needs_human", "稿里没有 EndNote 引文域（ADDIN EN.CITE）", rel,
                          detail="可能是 Zotero 稿、已转成纯文本的稿，或引文还没插入。"))
    out = Path(args.report) if args.report else root / "output" / "endnote-audit.md"
    write_text(out, fix_report(rel, fixes, total))
    path_written = C.write_items(root, CHECK_FILE, items)
    code = C.summary(items, path_written)
    print(f"在 EndNote 里怎么改：{out}")
    return code


def main():
    C.utf8_stdio()
    ap = argparse.ArgumentParser(description="已有 Word + EndNote 稿件的只读体检（不改写引文域）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, helptext in (("marks", "列出标黄、修订、批注和留下的作者名"), ("cites", "体检 EndNote 引文域并出 EndNote 修改清单")):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("docx", help="要体检的 .docx")
        p.add_argument("--root", default=".", help="项目根（核验项写到 <根>/.ccode/checks/，清单默认写到 <根>/output/）")
        p.add_argument("--report", help="清单输出路径（Markdown）")
    args = ap.parse_args()
    return cmd_marks(args) if args.cmd == "marks" else cmd_cites(args)


if __name__ == "__main__":
    sys.exit(main())
