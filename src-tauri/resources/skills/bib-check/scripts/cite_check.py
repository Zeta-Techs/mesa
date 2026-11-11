#!/usr/bin/env python3
"""引用核验固定脚本（bib-check 技能随包，2026-11-02）。只读稿件与引文库，结果写成 Mesa 核验项。

两个子命令：
  refs    引用键能否在 references.bib 里找到、库里有没有重复键；句中点名的作者（Smith et al.）与所引文献的作者对不对得上（离线也做）；
          联网时再查 DOI 是否指向这篇、有没有撤稿 / 更正
  quotes  逐条核对 manuscript/evidence.json 里 Agent 给出的原文摘录：到该文献 PDF 全文里逐字找这段话

结果写进 <工作目录>/.ccode/checks/cite-refs.jsonl、cite-quotes.jsonl（每次整份重写），一行一条：
  {id, kind, status, title, target{file,line}, evidence{source,quote,page,detail}, checker, at}
status 只有 passed（机器能确定的事实）/ blocked（机器确定有问题）/ needs_human（要人看）。
脚本只证明「原文里确实有这段话」「DOI 指向的是不是这篇」这类事实；这段话是否支持论断，永远交给人判断。

退出码：0 没有拦下的；1 有拦下的；2 环境问题（缺文件、本机没装 PyMuPDF 等），已尽量写出能写的核验项。
Windows 上把 python3 换成 python。
"""
import argparse
import datetime
import difflib
import importlib.util
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

CHECKER = "script:cite_check"
# 过程文件不是正文：检查报告、审查 / 裁决清单、状态与修改记录（2026-11-02 真实项目干跑：section-status.md 里的「@500 mA」被当成引用）
# 写作配套文件不当稿件扫。本脚本单独分发、不带 mesa_checks.py，名单在这里另放一份，
# 与 mesa_checks.MANUSCRIPT_HELPERS、Mesa 的 manuscript-files.ts 以 tests/fixtures/manuscript-helpers.json 为准逐条比对
MANUSCRIPT_HELPERS = (
    "citation-check", "citation-style", "review-report", "verification-decisions", "declarations",
    "checklist", "evidence", "section-status", "changelog", "numbers",
    "revision-notes", "outline", "typeface", "readme", "style-sheet",
)
SKIP_MANUSCRIPT = re.compile(
    "(" + "|".join(MANUSCRIPT_HELPERS) + ")", re.I
)
CROSSREF_PREFIXES = ("fig-", "tbl-", "sec-", "eq-", "lst-", "thm-", "lem-", "def-")
RETRACT_TYPES = {"retraction", "withdrawal", "removal"}
NOTICE_TYPES = {"correction", "erratum", "corrigendum", "expression_of_concern", "addendum", "clarification"}


def utf8_stdio():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def load_bridge():
    """endnote-bridge 的 bridge.py（BibTeX 解析、带缓存的 Crossref 请求）。随包在本脚本旁边。"""
    here = Path(__file__).resolve()
    for path in (here.parent / "bridge.py", here.parents[2] / "endnote-bridge" / "scripts" / "bridge.py"):
        if path.is_file():
            spec = importlib.util.spec_from_file_location("mesa_bridge", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise FileNotFoundError("找不到 bridge.py（应与本脚本同目录）。在技能页更新 bib-check 技能后再试")


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def item(id_, kind, status, title, file=None, line=None, **evidence):
    out = {"id": id_, "kind": kind, "status": status, "title": title, "checker": CHECKER, "at": now()}
    if file:
        out["target"] = {"file": file, **({"line": line} if line else {})}
    ev = {k: v for k, v in evidence.items() if v not in (None, "")}
    if ev:
        out["evidence"] = ev
    return out


def write_items(root, name, items):
    path = Path(root) / ".ccode" / "checks" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp%d" % os.getpid())
    tmp.write_text("".join(json.dumps(i, ensure_ascii=False) + "\n" for i in items), encoding="utf-8")
    os.replace(tmp, path)
    return path


def summary(items, path):
    n = {"passed": 0, "blocked": 0, "needs_human": 0}
    for i in items:
        n[i["status"]] += 1
    print(f"核验 {len(items)} 项：通过 {n['passed']}，拦下 {n['blocked']}，待你判断 {n['needs_human']}；结果写入 {path}")
    for i in items:
        if i["status"] != "passed":
            mark = "✗" if i["status"] == "blocked" else "?"
            where = i.get("target", {})
            loc = f"{where.get('file', '')}:{where.get('line', '')}".rstrip(":")
            print(f"{mark} {i['title']}" + (f"（{loc}）" if loc else ""))
    return 1 if n["blocked"] else 0


# ---------------- 稿件里的引用 ----------------

PANDOC_KEY = re.compile(r"(?<![\w@.\\])-?@([A-Za-z0-9_][\w:.#$%&\-+?<>~/]*)")
LATEX_CITE = re.compile(r"\\[A-Za-z]*cite[A-Za-z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}")


SKIP_DIRS = {"template", "templates", "_extensions", "_freeze", ".quarto", "output", "figures", "assets"}


def manuscript_files(root, explicit):
    """explicit 给了就按它（可带通配：manuscript/chapters/*.tex、submission/formatted.md）；没给就递归 manuscript/
    下的 md / qmd / tex，跳过模板、输出等目录与过程文件（LaTeX 章节在 chapters/ 里，2026-11-02 起才扫得到）。"""
    root = Path(root)
    if explicit:
        files = []
        for pattern in explicit:
            hits = sorted(root.glob(pattern)) if any(ch in pattern for ch in "*?[") else [root / pattern]
            files += [p for p in hits if p.is_file()]
        return files
    base = root / "manuscript"
    if not base.is_dir():
        return []
    files = []
    for p in base.rglob("*"):
        rel = p.relative_to(base).parts
        if not p.is_file() or p.suffix.lower() not in (".md", ".qmd", ".tex") or any(x in SKIP_DIRS for x in rel[:-1]):
            continue
        if not SKIP_MANUSCRIPT.search(p.name):
            files.append(p)
    return sorted(files)


def citations(root, files):
    """[(key, 相对路径, 行号)]，按出现顺序；代码块与 Quarto 交叉引用（@fig- 等）不算。"""
    out = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        rel = path.relative_to(root).as_posix() if path.is_relative_to(root) else str(path)
        fenced = False
        for no, line in enumerate(text.splitlines(), 1):
            if line.lstrip().startswith(("```", "~~~")):
                fenced = not fenced
                continue
            if fenced:
                continue
            if path.suffix == ".tex":
                for group in LATEX_CITE.findall(line):
                    out += [(k.strip(), rel, no) for k in group.split(",") if k.strip()]
                continue
            for key in PANDOC_KEY.findall(line):
                key = key.rstrip(".:;,?")
                # 纯数字（「@500 mA」「@50 °C」）不是引用键
                if key and not key.isdigit() and not key.lower().startswith(CROSSREF_PREFIXES):
                    out.append((key, rel, no))
    return out


def bib_ids(text):
    return re.findall(r"@(?!comment|string|preamble)[\w-]+\s*\{\s*([^,\s]+)\s*,", text, re.I)


def norm_title(text):
    text = unicodedata.normalize("NFKC", re.sub(r"<[^>]+>|[{}\\$]", "", text or "")).lower()
    return re.sub(r"[^\w]+", " ", text).strip()


# ---------------- 点名作者对号 ----------------

# 句中点名：「Smith et al.」「Smith and co-workers」「Smith, Lee and colleagues」
NAMED = re.compile(
    r"((?:[A-Z][\w'’\-–]+)(?:\s*,\s*[A-Z][\w'’\-–]+)*(?:\s+[A-Z][\w'’\-–]+)?)\s+"
    r"(?:and co-workers|and coworkers|and colleagues|et al\.)"
)
ABBR = {"al", "fig", "figs", "e.g", "i.e", "ref", "refs", "eq", "eqs", "vs", "ca", "approx", "no", "cf", "etc", "ch", "sec"}
BRACKET_GROUP = re.compile(r"\[([^\[\]]*@[^\[\]]*)\]")


def bib_authors(text):
    """{键: [作者原串]}。自己解析 author 字段（bridge.parse_bibtex 遇到 TeX 重音会整库报错），只为比姓。"""
    out = {}
    for m in re.finditer(r"@(?!comment|string|preamble)[\w-]+\s*\{\s*([^,\s]+)\s*,", text, re.I):
        nxt = re.search(r"\n\s*@\w", text[m.end():])
        body = text[m.end(): m.end() + nxt.start()] if nxt else text[m.end():]
        f = re.search(r"\bauthor\s*=\s*([{\"])", body, re.I)
        if not f:
            continue
        i, depth, buf = f.end(), 1 if f.group(1) == "{" else 0, []
        while i < len(body):
            ch = body[i]
            if f.group(1) == "{":
                depth += ch == "{"
                depth -= ch == "}"
                if depth == 0:
                    break
            elif ch == '"' and body[i - 1] != "\\":
                break
            buf.append(ch)
            i += 1
        raw = re.sub(r"\\i\b", "i", "".join(buf))
        raw = re.sub(r"\\[A-Za-z]+\s*|\\.", "", raw)
        out[m.group(1)] = [a.strip() for a in re.split(r"\s+and\s+", raw.replace("{", "").replace("}", "")) if a.strip()]
    return out


def name_norm(s):
    s = unicodedata.normalize("NFKD", s)
    return "".join(ch for ch in s.lower() if "a" <= ch <= "z")


def surname_tokens(author):
    """'García Lastra, J. M.' → {'garcialastra','garcia','lastra'}；没有逗号时取最后一个词。"""
    fam = author.split(",")[0] if "," in author else (author.split() or [""])[-1]
    toks = {name_norm(fam)} | {name_norm(t) for t in re.split(r"[\s\-–’']+", fam)}
    return {t for t in toks if len(t) > 1}


def sentence_start(text):
    """text 里最后一个句子的起点（跳过 et al. / Fig. 一类缩写后的句点）。"""
    start = 0
    for m in re.finditer(r"[.!?]\s+(?=[A-Z(\[])", text):
        word = re.search(r"([A-Za-z.]+)$", text[: m.start()])
        if m.group(0)[0] == "." and word and word.group(1).lower().rstrip(".") in ABBR:
            continue
        start = m.end()
    return start


def paragraphs(path):
    """[(段落文字, [(该行在段内的起点, 行号)])]；代码块跳过，空行分段，行之间用空格接上。"""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    out, buf, lines, fenced = [], [], [], False
    def flush():
        if buf:
            offsets, pos = [], 0
            for seg, no in zip(buf, lines):
                offsets.append((pos, no))
                pos += len(seg) + 1
            out.append((" ".join(buf), offsets))
        buf.clear()
        lines.clear()
    for no, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
            flush()
            continue
        if fenced or not line.strip():
            flush()
            continue
        buf.append(line.strip())
        lines.append(no)
    flush()
    return out


def cite_groups(para, latex):
    """段内引用组 [(起, 止, [键])]：Markdown 只认方括号组（叙述式 @key 本身就是点名），LaTeX 认 \\cite 族。"""
    groups = []
    if latex:
        for m in LATEX_CITE.finditer(para):
            groups.append((m.start(), m.end(), [k.strip() for k in m.group(1).split(",") if k.strip()]))
    else:
        for m in BRACKET_GROUP.finditer(para):
            keys = [k.rstrip(".:;,?") for k in PANDOC_KEY.findall(m.group(1))]
            keys = [k for k in keys if k and not k.isdigit() and not k.lower().startswith(CROSSREF_PREFIXES)]
            if keys:
                groups.append((m.start(), m.end(), keys))
    return groups


def named_author_checks(root, files, authors):
    """句中点名的作者在这句的引文里找不到 → 拦下。点名后先插佐证引文、点名那篇在同一句后面的算对上；
    所引键在库里没有作者的交人看。只比姓的字符串，所引文献是否支持这句话不判断。"""
    items = []
    for path in files:
        rel = path.relative_to(root).as_posix() if path.is_relative_to(root) else str(path)
        for para, offsets in paragraphs(path):
            groups = cite_groups(para, path.suffix == ".tex")
            prev_end = 0
            for i, (start, end, keys) in enumerate(groups):
                before = para[prev_end:start]
                prev_end = end
                before = before[sentence_start(before):]
                names = list(NAMED.finditer(before))
                if not names:
                    continue
                m = names[-1]
                tokens = {name_norm(t) for t in re.split(r"[\s,]+", m.group(1)) if name_norm(t) not in ("", "and")}
                same = [(start, end, keys)]
                for nxt in groups[i + 1:]:
                    if sentence_start(para[same[-1][1]: nxt[0]]):
                        break
                    same.append(nxt)
                line = max(no for pos, no in offsets if pos <= start)
                hit = next((k for g in same for k in g[2] if any(tokens & surname_tokens(a) for a in authors.get(k, []))), None)
                sentence_keys = [k for g in same for k in g[2]]
                iid = f"NAME-{rel}:{line}:{start}"
                if hit:
                    items.append(item(iid, "citation_named_author", "passed",
                                      f"点名 {m.group(1)}，与 [@{hit}] 的作者一致", rel, line, source=hit))
                elif not any(authors.get(k) for k in sentence_keys):
                    items.append(item(iid, "citation_named_author", "needs_human",
                                      f"点名 {m.group(1)}，所引条目在引文库里没有作者，核对不了", rel, line,
                                      source="; ".join(sentence_keys)))
                else:
                    cited = "；".join(f"[@{k}] {', '.join(authors.get(k, [])[:3]) or '无作者'}" for k in sentence_keys)
                    items.append(item(iid, "citation_named_author", "blocked",
                                      f"点名 {m.group(1)}，但这句引的文献里没有这位作者", rel, line,
                                      source="; ".join(sentence_keys), quote=snippet(before, m.start()),
                                      detail=f"这句所引：{cited}。多半是引错了键，或点名写错了人"))
    return items


def snippet(text, start, width=80):
    return re.sub(r"\s+", " ", text[start: start + width]).strip()


def crossref_checks(B, key, record, where):
    """一条引用的 DOI 与撤稿核验；连不上网返回 None（由调用方统一说一句没核）。"""
    import urllib.error
    import urllib.parse
    doi = B.bare_doi(record.get("doi", "")) if record.get("doi") else ""
    file, line = where
    if not doi:
        return [item(f"DOI-{key}", "citation_doi", "needs_human", f"[@{key}] 没有 DOI，机器无法核实这篇是否存在",
                     file, line, source=key, detail="书、学位论文、会议论文常见；请人核对出处")]
    out = []
    try:
        msg = B.http_json("https://api.crossref.org/works/" + urllib.parse.quote(doi))["message"]
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return [item(f"DOI-{key}", "citation_doi", "needs_human", f"[@{key}] 的 DOI 在 Crossref 查不到",
                         file, line, source=f"doi:{doi}",
                         detail="单次查不到不等于编造（DataCite、中文 DOI 不在 Crossref）；请人到出版方页面核对")]
        return None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError):
        return None
    got = (msg.get("title") or [""])[0]
    ratio = difflib.SequenceMatcher(None, norm_title(got), norm_title(record.get("title", ""))).ratio()
    if not record.get("title"):
        out.append(item(f"DOI-{key}", "citation_doi", "needs_human", f"[@{key}] 引文库里没有题名，无法比对 DOI 指向",
                        file, line, source=f"doi:{doi}", detail=f"Crossref 题名：{got}"))
    elif ratio < 0.6:
        out.append(item(f"DOI-{key}", "citation_doi", "blocked", f"[@{key}] 的 DOI 指向另一篇文献",
                        file, line, source=f"doi:{doi}",
                        detail=f"引文库题名：{record.get('title')}；Crossref 题名：{got}"))
    else:
        out.append(item(f"DOI-{key}", "citation_doi", "passed", f"[@{key}] 的 DOI 存在且指向这篇",
                        file, line, source=f"doi:{doi}", detail=f"Crossref 题名：{got}"))
    try:
        notices = B.http_json("https://api.crossref.org/works?rows=20&filter=updates:" + urllib.parse.quote(doi))
        rows = notices["message"]["items"]
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError):
        return out + [item(f"RET-{key}", "citation_retraction", "needs_human",
                           f"[@{key}] 撤稿 / 更正状态没查成（联网失败）", file, line, source=f"doi:{doi}")]
    kinds = set()
    for row in rows:
        for upd in row.get("update-to") or []:
            if B.bare_doi(upd.get("DOI", "")).lower() == doi.lower():
                kinds.add((upd.get("type") or "").lower())
    if kinds & RETRACT_TYPES:
        out.append(item(f"RET-{key}", "citation_retraction", "blocked", f"[@{key}] 已被撤稿",
                        file, line, source=f"doi:{doi}", detail="Crossref 登记了撤稿通知：" + "、".join(sorted(kinds))))
    elif kinds:
        out.append(item(f"RET-{key}", "citation_retraction", "needs_human", f"[@{key}] 有更正或关注声明",
                        file, line, source=f"doi:{doi}", detail="Crossref 登记：" + "、".join(sorted(kinds))))
    else:
        out.append(item(f"RET-{key}", "citation_retraction", "passed", f"[@{key}] 没有撤稿 / 更正登记",
                        file, line, source=f"doi:{doi}"))
    return out


def cmd_refs(args):
    root = Path(args.root).resolve()
    bib = root / args.bib
    files = manuscript_files(root, args.manuscript)
    cites = citations(root, files)
    items = []
    if not bib.is_file():
        items.append(item("BIB", "citation_resolve", "blocked", f"找不到引文库 {args.bib}", args.bib))
        path = write_items(root, "cite-refs.jsonl", items)
        summary(items, path)
        return 2
    text = bib.read_text(encoding="utf-8-sig")
    ids = bib_ids(text)
    seen = set()
    for key in ids:
        if key in seen:
            items.append(item(f"DUP-{key}", "citation_duplicate", "blocked", f"引文库里 {key} 重复出现",
                              args.bib, detail="同一个键对应多条记录，渲染时只会取其中一条"))
        seen.add(key)
    first = {}
    for key, rel, no in cites:
        first.setdefault(key, (rel, no))
    for key, (rel, no) in first.items():
        if key in seen:
            items.append(item(f"REF-{key}", "citation_resolve", "passed", f"[@{key}] 在引文库里", rel, no, source=key))
        else:
            items.append(item(f"REF-{key}", "citation_resolve", "blocked", f"[@{key}] 在引文库里找不到",
                              rel, no, source=key, detail="渲染后会变成问号；补进 references.bib 或改正键名"))
    items += named_author_checks(root, files, bib_authors(text))
    offline = args.offline or os.environ.get("MESA_LIT_OFFLINE")
    if first and not offline:
        try:
            B = load_bridge()
            records = {r["id"]: r for r in B.parse_bibtex(text)}
        except (FileNotFoundError, ValueError) as err:
            records, B = None, None
            items.append(item("ONLINE", "citation_doi", "needs_human", f"DOI 与撤稿没核：{err}", args.bib))
        if records is not None:
            failed = 0
            for key, where in first.items():
                if key not in records:
                    continue
                got = crossref_checks(B, key, records[key], where)
                if got is None:
                    failed += 1
                else:
                    items += got
            if failed:
                items.append(item("ONLINE", "citation_doi", "needs_human",
                                  f"有 {failed} 条引用联网核验没做成（Crossref 连不上）", args.bib,
                                  detail="网络恢复后重跑本脚本"))
    elif first:
        items.append(item("ONLINE", "citation_doi", "needs_human", "没有联网，DOI 与撤稿状态没核", args.bib,
                          detail="联网后重跑 refs"))
    if not files:
        items.append(item("MS", "citation_resolve", "needs_human", "没找到稿件文件，没有核对正文里的引用", "manuscript/"))
    path = write_items(root, "cite-refs.jsonl", items)
    return summary(items, path)


# ---------------- 原文摘录 ----------------

FOLD = {
    "\u2018": "'", "\u2019": "'", "\u2032": "'", "\u201c": '"', "\u201d": '"', "\u2033": '"',
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2212": "-",
    "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi", "\ufb04": "ffl",
}
INVISIBLE = set("\u200b\u200c\u200d\u2060\ufeff\u00ad")


def normalize(text):
    """与 src/pdf-search.ts 同口径：大小写不敏感、弯引号与各式短横线归键盘字符、连字展开、
    空白折叠，行尾「字母-」断词去掉连字符接下一行（en/em dash 不算断词）。"""
    text = re.sub(r"(?<=[^\W\d_])[-\u2010][ \t]*\r?\n[ \t]*", "", text)
    out, space = [], True
    for ch in text:
        if ch in INVISIBLE:
            continue
        if ch.isspace():
            if not space:
                out.append(" ")
            space = True
            continue
        out.append(FOLD.get(ch, ch.lower() if len(ch.lower()) == 1 else ch))
        space = False
    return "".join(out).strip()


def segments(quote):
    """摘录里的省略号（… 或 ...）把一段话拆成几截，按顺序逐截找。"""
    parts = re.split(r"\s*(?:\u2026|\.\.\.|\[\s*\.\.\.\s*\])\s*", quote)
    return [p for p in (normalize(x) for x in parts) if len(p) >= 3]


def open_pdf_lib():
    try:
        import pymupdf
        return pymupdf
    except ImportError:
        try:
            import fitz
            return fitz
        except ImportError:
            return None


def pdf_pages(lib, path):
    with lib.open(str(path)) as doc:
        return [normalize(page.get_text()) for page in doc]


def find_in_pages(pages, segs):
    """在整篇（页与页之间补一个空格）里按顺序找每一截；全找到返回第一截所在页码（从 1 起），否则 None。"""
    starts, joined, pos = [], "", 0
    for text in pages:
        starts.append(len(joined))
        joined += text + " "
    first = None
    for seg in segs:
        at = joined.find(seg, pos)
        if at < 0:
            return None
        if first is None:
            first = at
        pos = at + len(seg)
    page = 0
    for i, start in enumerate(starts):
        if start <= first:
            page = i
    return page + 1


def title_key(text):
    return "".join(ch for ch in unicodedata.normalize("NFKC", text or "").lower() if ch.isalnum())


def pdf_by_title(roots):
    """项目根与 papers/ 下的 PDF，按文件名（去扩展名）归一：早期项目 included.json 没记 pdf、文件用题名命名
    （2026-11-02 真实项目干跑：72 篇全在项目根、一篇也没登记路径）。"""
    out = {}
    for root in roots:
        for folder in (root, root / "papers"):
            if folder.is_dir():
                for pdf in folder.glob("*.pdf"):
                    out.setdefault(title_key(pdf.stem), pdf)
    return out


def match_title(title, by_title):
    """题名与文件名互为前缀（至少 20 个字母数字）即认；文件名里被替换成 _ 的标点在归一时都去掉了。"""
    key = title_key(title)
    if len(key) < 20:
        return None
    for stem, pdf in by_title.items():
        if len(stem) >= 20 and (key.startswith(stem) or stem.startswith(key)):
            return pdf
    return None


def source_map(roots):
    """bibKey → (PDF 路径 | None, 全文状态)：notes/index.json 认 bibKey → id，papers/included.json 认 id → pdf；
    没登记 pdf 的按题名认项目里的 PDF 文件。"""
    status, pdf_of_id, key_to_id = {}, {}, {}
    title_of_id = {}
    for root in roots:
        index = root / "notes" / "index.json"
        if index.is_file():
            try:
                rows = json.loads(index.read_text(encoding="utf-8"))
                rows = rows.get("papers", rows) if isinstance(rows, dict) else rows
                for row in rows:
                    key = row.get("bibKey")
                    if key:
                        key_to_id.setdefault(key, row.get("id"))
                        status.setdefault(key, row.get("fulltextStatus", ""))
            except (ValueError, AttributeError):
                pass
        included = root / "papers" / "included.json"
        if included.is_file():
            try:
                for row in json.loads(included.read_text(encoding="utf-8")):
                    if row.get("pdf"):
                        pdf_of_id.setdefault(row.get("id"), row["pdf"])
                    if row.get("title"):
                        title_of_id.setdefault(row.get("id"), row["title"])
            except (ValueError, AttributeError):
                pass
    missing = [i for i in title_of_id if i not in pdf_of_id]
    if missing:
        by_title = pdf_by_title(roots)
        for i in missing:
            hit = match_title(title_of_id[i], by_title)
            if hit is not None:
                pdf_of_id[i] = str(hit)
    return key_to_id, pdf_of_id, status


def resolve_pdf(roots, raw):
    if not raw:
        return None
    p = Path(raw)
    if p.is_absolute():
        return p if p.is_file() else None
    for root in roots:
        if (root / p).is_file():
            return root / p
    return None


def load_evidence(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data.get("quotes", []) if isinstance(data, dict) else data
    return [r for r in rows if isinstance(r, dict)]


def cmd_quotes(args):
    root = Path(args.root).resolve()
    roots = [root] + ([Path(args.project).resolve()] if args.project else [])
    ev_path = root / args.evidence
    items = []
    if not ev_path.is_file():
        items.append(item("EVIDENCE", "quote_missing", "blocked", f"没有原文摘录文件 {args.evidence}", args.evidence,
                          detail="每处引用要给出支撑它的原文摘录和页码，见 bib-check 技能「原文摘录」"))
        path = write_items(root, "cite-quotes.jsonl", items)
        summary(items, path)
        return 2
    try:
        rows = load_evidence(ev_path)
    except (ValueError, OSError) as err:
        items.append(item("EVIDENCE", "quote_missing", "blocked", f"原文摘录文件读不了：{err}", args.evidence))
        path = write_items(root, "cite-quotes.jsonl", items)
        summary(items, path)
        return 2
    lib = open_pdf_lib()
    key_to_id, pdf_of_id, status = source_map(roots)
    cache, env_problem = {}, False
    for n, row in enumerate(rows, 1):
        qid = str(row.get("id") or f"Q{n:03d}")
        key = str(row.get("key", "")).lstrip("@")
        quote = str(row.get("quote", "")).strip()
        loc = str(row.get("location", ""))
        file, _, line = loc.rpartition(":")
        file, line = (file, int(line)) if line.isdigit() else (loc, None)
        claimed = row.get("page")
        base = dict(source=key, quote=quote or None, page=claimed if isinstance(claimed, int) else None)
        if not quote or not key:
            items.append(item(f"Q-{qid}", "quote_missing", "needs_human", f"{qid} 没有给出{'原文摘录' if key else '引用键'}",
                              file, line, **base))
            continue
        fulltext = status.get(key, "")
        if fulltext in ("abstract-only", "unavailable"):
            items.append(item(f"Q-{qid}", "quote_in_source", "needs_human",
                              f"[@{key}] 只有{'摘要' if fulltext == 'abstract-only' else '题录'}，原文没法逐字核对",
                              file, line, detail="仅凭摘要不能支持摘要里没有的细节", **base))
            continue
        pdf = resolve_pdf(roots, row.get("source") or pdf_of_id.get(key_to_id.get(key)))
        if pdf is None:
            items.append(item(f"Q-{qid}", "quote_in_source", "needs_human", f"[@{key}] 找不到 PDF，原文没核",
                              file, line, detail="included.json 里没有登记这篇的 PDF，或文件不在", **base))
            continue
        if lib is None:
            env_problem = True
            items.append(item(f"Q-{qid}", "quote_in_source", "needs_human", f"[@{key}] 本机没装 PyMuPDF，原文没核",
                              file, line, **base))
            continue
        if pdf not in cache:
            try:
                cache[pdf] = pdf_pages(lib, pdf)
            except Exception as err:  # PDF 损坏 / 加密
                cache[pdf] = err
        pages = cache[pdf]
        if isinstance(pages, Exception) or not any(pages):
            items.append(item(f"Q-{qid}", "quote_in_source", "needs_human", f"[@{key}] 的 PDF 抽不出文字（扫描件或加密）",
                              file, line, detail=str(pages) if isinstance(pages, Exception) else "需要人对照原文", **base))
            continue
        segs = segments(quote)
        found = find_in_pages(pages, segs) if segs else None
        rel_pdf = pdf.name
        if found is None:
            items.append(item(f"Q-{qid}", "quote_in_source", "blocked", f"[@{key}] 原文里找不到这段摘录",
                              file, line, detail=f"在 {rel_pdf} 全文里逐字没找到；可能是转述或编造，请改成原文原句或删去",
                              **base))
            continue
        note = f"在 {rel_pdf} 的 PDF 第 {found} 页找到"
        if isinstance(claimed, int) and claimed != found:
            note += f"（标注 p.{claimed}，可能是期刊页码）"
        items.append(item(f"Q-{qid}", "quote_in_source", "passed", f"[@{key}] 原文里有这段话", file, line,
                          detail=note + "；是否支持论断由人判断", **base))
    if args.coverage:
        quoted = {str(r.get("key", "")).lstrip("@") for r in rows}
        first = {}
        for key, rel, no in citations(root, manuscript_files(root, args.manuscript)):
            first.setdefault(key, (rel, no))
        for key, (rel, no) in first.items():
            if key not in quoted:
                items.append(item(f"COV-{key}", "quote_missing", "needs_human", f"[@{key}] 没有给原文摘录",
                                  rel, no, source=key, detail="这处引用是否被来源支持只能人看"))
    path = write_items(root, "cite-quotes.jsonl", items)
    code = summary(items, path)
    return 2 if env_problem and code == 0 else code


def main():
    utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    refs = sub.add_parser("refs", help="引用键、重复键、DOI 指向与撤稿")
    refs.add_argument("--root", default=".", help="工作目录（稿件与 references.bib 所在）")
    refs.add_argument("--bib", default="references.bib")
    refs.add_argument("--manuscript", nargs="*", help="要查的稿件（相对 --root，可带通配，如 manuscript/chapters/*.tex）；默认递归 manuscript/ 下的 md/qmd/tex")
    refs.add_argument("--offline", action="store_true", help="不联网，只做本地检查")
    quotes = sub.add_parser("quotes", help="原文摘录逐字核对")
    quotes.add_argument("--root", default=".", help="工作目录（稿件与 evidence.json 所在）")
    quotes.add_argument("--project", help="项目根绝对路径（papers/ 下的 PDF 在这里）")
    quotes.add_argument("--evidence", default="manuscript/evidence.json")
    quotes.add_argument("--coverage", action="store_true", help="另列出稿件里没给摘录的引用")
    quotes.add_argument("--manuscript", nargs="*", help="--coverage 查哪些稿件（相对 --root，可带通配）；默认递归 manuscript/")
    args = ap.parse_args()
    sys.exit(cmd_refs(args) if args.cmd == "refs" else cmd_quotes(args))


if __name__ == "__main__":
    main()
