#!/usr/bin/env python3
"""引用核验固定脚本（bib-check 技能随包，2026-11-02）。只读稿件与引文库，结果写成 Mesa 核验项。

两个子命令：
  refs    引用键能否在 references.bib 里找到、库里有没有重复键；联网时再查 DOI 是否指向这篇、有没有撤稿 / 更正
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
SKIP_MANUSCRIPT = re.compile(
    r"(citation-check|citation-style|review-report|verification-decisions|declarations|checklist|evidence|"
    r"section-status|changelog|numbers)", re.I
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


def manuscript_files(root, explicit):
    if explicit:
        return [Path(root) / p for p in explicit]
    base = Path(root) / "manuscript"
    if not base.is_dir():
        return []
    files = []
    for ext in ("*.md", "*.qmd", "*.tex"):
        files += [p for p in base.glob(ext) if not SKIP_MANUSCRIPT.search(p.name)]
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
        for key, rel, no in citations(root, manuscript_files(root, None)):
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
    refs.add_argument("--manuscript", nargs="*", help="要查的稿件（相对 --root）；默认 manuscript/ 下的 md/qmd/tex")
    refs.add_argument("--offline", action="store_true", help="不联网，只做本地检查")
    quotes = sub.add_parser("quotes", help="原文摘录逐字核对")
    quotes.add_argument("--root", default=".", help="工作目录（稿件与 evidence.json 所在）")
    quotes.add_argument("--project", help="项目根绝对路径（papers/ 下的 PDF 在这里）")
    quotes.add_argument("--evidence", default="manuscript/evidence.json")
    quotes.add_argument("--coverage", action="store_true", help="另列出稿件里没给摘录的引用")
    args = ap.parse_args()
    sys.exit(cmd_refs(args) if args.cmd == "refs" else cmd_quotes(args))


if __name__ == "__main__":
    main()
