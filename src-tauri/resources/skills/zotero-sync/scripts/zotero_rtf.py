#!/usr/bin/env python3
"""Markdown [@key] → Zotero RTF Scan file plus a RIS of just those items."""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path, PureWindowsPath

CITE_RE = re.compile(
    r"\[((?:-?@[A-Za-z0-9_.:-]+(?:\s*,[^\];]*)?)(?:\s*;\s*-?@[A-Za-z0-9_.:-]+(?:\s*,[^\];]*)?)*)\]"
)
BRACE_KEY = re.compile(r"\{#([A-Za-z0-9_.:-]+)\}")
ENTRY_RE = re.compile(r"@\w+\s*\{\s*([^,\s]+)\s*,", re.S)

def load_mesa_iso4() -> dict[str, str]:
    """与脚本同目录的 journal-abbreviations.csv。"""
    import csv
    path = Path(__file__).with_name("journal-abbreviations.csv")
    table: dict[str, str] = {}
    if not path.is_file():
        return table
    for row in csv.reader(path.read_text(encoding="utf-8").splitlines()):
        if not row or row[0].strip().startswith("#") or len(row) < 2:
            continue
        key = " ".join(row[0].replace("&", " and ").casefold().split())
        short = row[1].strip()
        if key and short:
            table[key] = short
    return table


_MESA_ISO4 = load_mesa_iso4()


def journal_short(journal: str, stored: str) -> str:
    if stored.strip():
        return stored.strip()
    key = " ".join(journal.replace("&", " and ").casefold().split())
    return _MESA_ISO4.get(key, journal.strip())


def parse_keys(span: str) -> list[str]:
    keys = []
    for part in span.split(";"):
        part = part.strip().lstrip("-").strip()
        if not part.startswith("@"):
            continue
        key = "".join(ch for ch in part[1:] if ch.isalnum() or ch in "_-.:")
        if key:
            keys.append(key)
    return keys


def bib_records(text: str) -> dict[str, dict]:
    records = {}
    for match in ENTRY_RE.finditer(text):
        key = match.group(1)
        body = text[match.end():]
        depth = 1
        end = 0
        for i, ch in enumerate(body):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i
                    break
        fields = {}
        for name, value in re.findall(r"(\w+)\s*=\s*[{\"](.*?)[}\"]\s*,?", body[:end], re.S):
            fields[name.lower()] = re.sub(r"\s+", " ", value).strip()
        author = fields.get("author", "")
        family = author.split(" and ")[0].split(",")[0].strip() if author else "Anon"
        records[key] = {
            "family": family or "Anon",
            "year": fields.get("year", "n.d."),
            "title": fields.get("title", ""),
            "author": author,
            "doi": fields.get("doi", ""),
            "journal": fields.get("journal") or fields.get("booktitle", ""),
            "journalabbreviation": fields.get("journalabbreviation", ""),
            "volume": fields.get("volume", ""),
            "number": fields.get("number", ""),
            "pages": fields.get("pages", ""),
            "issn": fields.get("issn", ""),
            "abstract": fields.get("abstract", ""),
            "keywords": fields.get("keywords", ""),
            "date": fields.get("date", ""),
            "url": fields.get("url", ""),
        }
    return records


def load_bridge():
    from pathlib import Path
    import importlib.util
    here = Path(__file__).resolve()
    candidates = [
        here.parent / "bridge.py",
        here.parents[2] / "endnote-bridge" / "scripts" / "bridge.py",
    ]
    path = next((item for item in candidates if item.is_file()), None)
    if path is None:
        raise FileNotFoundError("找不到 endnote-bridge/scripts/bridge.py")
    spec = importlib.util.spec_from_file_location("endnote_bridge", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_library_match():
    from pathlib import Path
    import importlib.util
    here = Path(__file__).resolve()
    candidates = [
        here.parent / "library_match.py",
        here.parents[2] / "endnote-bridge" / "scripts" / "library_match.py",
    ]
    path = next((item for item in candidates if item.is_file()), None)
    if path is None:
        raise FileNotFoundError("找不到 endnote-bridge/scripts/library_match.py")
    spec = importlib.util.spec_from_file_location("library_match", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def markup_title(text: str) -> str:
    """标题、期刊、摘要里的上下标和化学式空格收成 Unicode。"""
    return load_bridge().clean(text)


def rtf_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def write_library_ris(
    bib_text: str, dest: Path, skip_excluded: Path | None = None, attach: Path | None = None
) -> tuple[int, int, int]:
    """整份 bib 写成 Zotero RIS。用 bridge 解析，避免花括号和括号把作者、标题截断。

    库里已有同一 DOI 的照样交（2026-10-23 用户拍板，改 2026-10-11 的「按 DOI 差量」）：Mesa 出的题录字段是全的，
    导进去后人在 Zotero「重复条目」里自己挑着合并，比跳过、留着库里那条旧的缺字段记录好。这里只数一下有几条重复，进反馈。
    检索时人排除的篇（included.json 的 decision=excluded）不交。
    attach（「同步到文献库」带 PDF / 笔记，2026-11-10）：Mesa 写的 {键: {pdf, note}}，全文进 L1、笔记转 HTML 进 N1
    （Zotero 导入成条目下的附件和子笔记，全文复制进 Zotero 的 storage，不问复制还是链接；2026-11-10 Zotero 10 实测）。
    文件里不写注释行：RIS 没有注释语法，各家导入器认不认没保证。
    返回 (写入条数, 其中库里已有同一 DOI 的条数, 排除不导条数)。
    """
    bridge = load_bridge()
    match = load_library_match()
    records, dropped = bridge.drop_excluded(bridge.parse_bibtex(bib_text), skip_excluded)
    if attach is not None:
        bridge.attach_records(records, bridge.load_attach_plan(attach), html_notes=True)
    known_dois: set[str] = set()
    db = match.zotero_db_path()
    if db is not None:
        index, _owner, _note = match.zotero_index(db)
        known_dois = set(index)
    lines = []
    duplicated = 0
    written = []
    for rec in records:
        doi = match.norm_doi(rec.get("doi") or "")
        if doi and doi in known_dois:
            duplicated += 1
        written.append(rec)
        kind = {"article": "JOUR", "book": "BOOK", "incollection": "CHAP", "inproceedings": "CONF", "phdthesis": "THES"}.get(rec.get("type"), "JOUR")
        lines.append(f"TY  - {kind}")
        # Zotero 份字段口径（2026-10-11 与 zotero-sync/lit-search SKILL、screening-review.ts 的
        # recordToZoteroRis 对齐）：期刊全称只写 T2、缩写只写 J2；不写 ID（Zotero 导入不读，
        # 键的回流职责在 EndNote 份）、不写 N1（会进笔记）、不写 JO/JF/JA（JO 会进期刊缩写格）、
        # 不写 DA/ET/M3/LA/N2（EndNote 格子或重复）。M2 只放期刊的另一种缩写，Zotero 收进「其他」。
        # 题名去掉人手加的编号前缀（【77】、19~.），与 EndNote 份同一个 bridge.title_text。
        if rec.get("title"):
            lines.append(f"TI  - {bridge.title_text(rec['title'])}")
        for author in rec.get("authors") or []:
            lines.append(f"AU  - {bridge.family_comma(author)}")
        if rec.get("year"):
            lines.append(f"PY  - {rec['year']}")
        journal = bridge.clean(rec.get("journal") or "")
        if journal:
            lines.append(f"T2  - {journal}")
        # 缩写与 EndNote 份同一套：引文库里有就用，没有查 JabRef 表 + Mesa 兜底（原先只查 Mesa 兜底，
        # 从 Zotero 导进来的条目在 Zotero 这份里全没有缩写，EndNote 那份却有）
        short, alt = bridge.journal_abbreviations(rec)
        if short and short.casefold() != journal.casefold():
            lines.append(f"J2  - {short}")
        if alt:
            lines.append(f"M2  - ISO 4 abbreviation: {alt}")
        if rec.get("volume"):
            lines.append(f"VL  - {rec['volume']}")
        if rec.get("number"):
            lines.append(f"IS  - {rec['number']}")
        start, end = bridge.split_pages(rec.get("pages") or "")
        if start:
            lines.append(f"SP  - {start}")
        if end and end != start:
            lines.append(f"EP  - {end}")
        if rec.get("issn"):
            lines.append(f"SN  - {rec['issn']}")
        doi = bridge.bare_doi(rec.get("doi") or "")
        if doi:
            lines.append(f"DO  - {doi}")
        url = rec.get("url") or (f"https://doi.org/{doi}" if doi else "")
        if url:
            lines.append(f"UR  - {url}")
        for word in rec.get("keywords") or []:
            lines.append(f"KW  - {word}")
        if rec.get("abstract"):
            lines.append(f"AB  - {bridge.clean(rec['abstract'])}")
        # 只在人选了带全文 / 笔记时才有：路径原样写，笔记已是一行 HTML（上面「不写 N1」说的是题录里的 note 字段）
        if rec.get("attachPdf"):
            lines.append(f"L1  - {rec['attachPdf']}")
        if rec.get("attachNote"):
            lines.append(f"N1  - {rec['attachNote']}")
        lines.append("ER  - ")
        lines.append("")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes("\r\n".join(lines).encode("utf-8"))
    return len(written), duplicated, dropped


def _zotero_pdf_url(raw: str) -> str:
    """Zotero EndNote XML.js 按 `/` 截取文件名作附件标题，且 Windows 下 translate_item.js
    不能处理正斜杠裸盘符路径（`replace('/', '\\\\', 'g')` 只替第一个 `/`）：
    Windows 盘符/UNC 路径统一转成 `file:///D:/...`，POSIX 绝对路径保持原样。"""
    text = (raw or "").strip()
    if re.match(r"^(?:[A-Za-z]:[\\/]|\\\\)", text):
        return PureWindowsPath(text).as_uri()
    return text


def write_library_xml(
    bib_text: str, dest: Path, skip_excluded: Path | None = None, attach: Path | None = None
) -> int:
    """另写一份供 Zotero 原生导入的 EndNote XML（Zotero EndNote XML.js 翻译器）：
    RIS 纯文本装不下富文本角标，Zotero 导入 RIS 只存 Unicode ₂，Word 刷新后不是真下标；
    而导入 EndNote XML 时，Zotero 自动把 <style face="subscript|superscript"> 转成 <sub>/<sup>，
    Word 刷新后即生成真正的 <w:vertAlign> 上下标格式，同时保留 PDF 附件、子笔记、缩写与 Citation Key，
    且只写 EndNote XML.js 已映射字段，不触发 _EndnoteXML import 杂项笔记。"""
    import xml.etree.ElementTree as ET

    bridge = load_bridge()
    records, _dropped = bridge.drop_excluded(bridge.parse_bibtex(bib_text), skip_excluded)
    plan = bridge.load_attach_plan(attach) if attach is not None else {}
    if plan:
        bridge.attach_records(records, plan, html_notes=False, multiline_notes=True)
    type_code = {"article": 17, "book": 6, "incollection": 5, "inproceedings": 47, "phdthesis": 32}
    type_name = {
        17: "Journal Article",
        6: "Book",
        5: "Book Section",
        47: "Conference Paper",
        32: "Thesis",
    }
    root = ET.Element("xml")
    rows = ET.SubElement(root, "records")
    for i, rec in enumerate(records, 1):
        item = ET.SubElement(rows, "record")

        def make_el(path: str, attrs: dict | None = None):
            parent = item
            parts = path.split("/")
            for part in parts[:-1]:
                child = parent.find(part)
                if child is None:
                    child = ET.SubElement(parent, part)
                parent = child
            return ET.SubElement(parent, parts[-1], attrs or {})

        def put(path: str, value, attrs: dict | None = None):
            el = make_el(path, attrs)
            el.text = str(value)

        code = type_code.get(rec.get("type"), 17)
        put("rec-number", i)
        put("ref-type", code, {"name": type_name[code]})
        for author in rec.get("authors") or []:
            put("contributors/authors/author", bridge.family_comma(author))
        if rec.get("title"):
            bridge.put_styled_xml(make_el("titles/title"), bridge.title_text(rec["title"]))
        journal = bridge.clean(rec.get("journal") or "")
        if journal and code in (17, 5, 6, 47):
            put("titles/secondary-title", journal)
        short, alt = bridge.journal_abbreviations(rec)
        if code == 17 and short and short.casefold() != journal.casefold():
            put("periodical/abbr-1", short)
        start, end = bridge.split_pages(rec.get("pages") or "")
        if start and code in (17, 5, 6, 47):
            put("pages", f"{start}-{end}" if end and end != start else start)
        if rec.get("volume") and code in (17, 5, 6, 47):
            put("volume", rec["volume"])
        if rec.get("number") and code in (17, 5, 6):
            put("number", rec["number"])
        for word in rec.get("keywords") or []:
            put("keywords/keyword", word)
        if rec.get("year") or rec.get("date"):
            dates = ET.SubElement(item, "dates")
            if rec.get("year"):
                bridge.xml_date(dates, "year", rec["year"])
            if rec.get("date"):
                bridge.xml_date(ET.SubElement(dates, "pub-dates"), "date", rec["date"])
        if (rec.get("issn") or rec.get("isbn")) and code in (17, 5, 6, 47):
            put("isbn", rec.get("issn") or rec.get("isbn"))
        if rec.get("abstract"):
            bridge.put_styled_xml(make_el("abstract"), bridge.clean(rec["abstract"]))
        doi = bridge.bare_doi(rec.get("doi") or "")
        label_lines = [rec["id"]] if rec.get("id") else []
        if alt:
            label_lines.append(f"ISO 4 abbreviation: {alt}")
        if doi and code == 32:
            label_lines.append(f"DOI: {doi}")
        if label_lines:
            put("label", "\n".join(label_lines))
        url = rec.get("url") or (f"https://doi.org/{doi}" if doi else "")
        if url or rec.get("attachPdf"):
            urls = ET.SubElement(item, "urls")
            if url:
                ET.SubElement(ET.SubElement(urls, "web-urls"), "url").text = bridge.plain_id(url)
            if rec.get("attachPdf"):
                ET.SubElement(ET.SubElement(urls, "pdf-urls"), "url").text = _zotero_pdf_url(rec["attachPdf"])
        if doi and code != 32:
            put("electronic-resource-num", doi)
        if rec.get("attachNote"):
            put("research-notes", rec["attachNote"])
        if rec.get("language"):
            put("language", rec["language"])
    dest.parent.mkdir(parents=True, exist_ok=True)
    xml_str = ET.tostring(root, encoding="unicode", xml_declaration=True) + "\n"
    dest.write_text(xml_str, encoding="utf-8", newline="\n")
    return len(records)


def main(argv: list[str] | None = None) -> int:
    # Windows 控制台/管道默认 cp1252：差量与库体检提示含中文，print 会 UnicodeEncodeError
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Write a Zotero RTF Scan manuscript")
    parser.add_argument("--library-ris", action="store_true")
    parser.add_argument("--library-xml", help="另写一份保留真上下标格式的 EndNote XML 供 Zotero 导入")
    parser.add_argument("--input")
    parser.add_argument("--bib", required=True)
    parser.add_argument("--rtf")
    parser.add_argument("--ris", required=True)
    parser.add_argument("--report")
    parser.add_argument("--skip-excluded", help="papers/included.json：其中排除的篇不导")
    parser.add_argument("--attach", help="Mesa 写的 {键: {pdf, note}}：给条目挂全文（L1）与笔记（N1）")
    args = parser.parse_args(argv)
    if args.library_ris:
        bib_content = Path(args.bib).read_text(encoding="utf-8")
        skip_path = Path(args.skip_excluded) if args.skip_excluded else None
        attach_path = Path(args.attach) if args.attach else None
        written, duplicated, dropped = write_library_ris(
            bib_content,
            Path(args.ris),
            skip_path,
            attach_path,
        )
        if args.library_xml and written > 0:
            write_library_xml(bib_content, Path(args.library_xml), skip_path, attach_path)
        # 「交给 Zotero 0 条」是调用方的判据：零记录的 RIS 不是合法导入文件，不拉起 Zotero
        print(
            f"本次交给 Zotero {written} 条"
            + (f"（其中 {duplicated} 条库里已有同一 DOI，导入后在 Zotero「重复条目」里挑着合并）" if duplicated else "")
            + (f"，检索时排除的 {dropped} 条不导" if dropped else "")
            + "。"
        )
        # 库体检（同步按钮反馈）：旧版导出的脏记录会让本次导入的去重认不出、旧数据残留。
        # 只读检查，打到 stdout 交给调用方显示；查不成或干净时也说明一句。
        match = load_library_match()
        stale, note = match.zotero_stale_items(None)
        if note:
            print(f"库体检：{note}")
        elif stale:
            print(f"库体检：检出 {len(stale)} 条旧版导出的脏记录，不先删掉，这次导入的去重认不出、旧数据会残留：")
            for h in stale:
                print(f"- {h}")
            print("处方：在 Zotero 里按上面的标题删除这些条目，再点一次「同步到 Zotero」。")
        else:
            print("库体检：库里没有旧版导出的脏记录。")
        return 0
    if not args.input:
        print("缺 --input", file=sys.stderr)
        return 2
    markdown = Path(args.input).read_text(encoding="utf-8")
    parsed = {rec["id"]: rec for rec in load_bridge().parse_bibtex(Path(args.bib).read_text(encoding="utf-8"))}
    records = {}
    for key, rec in parsed.items():
        author = " and ".join(rec.get("authors") or [])
        family = (rec.get("authors") or ["Anon"])[0].split(",")[0].strip()
        records[key] = {
            "family": family or "Anon",
            "year": rec.get("year") or "n.d.",
            "title": rec.get("title") or "",
            "author": author,
            "doi": rec.get("doi") or "",
            "journal": rec.get("journal") or "",
            "journalabbreviation": rec.get("journalAbbreviation") or "",
            "volume": rec.get("volume") or "",
            "number": rec.get("number") or "",
            "pages": rec.get("pages") or "",
            "issn": rec.get("issn") or "",
            "abstract": rec.get("abstract") or "",
            "keywords": "; ".join(rec.get("keywords") or []),
            "date": rec.get("date") or "",
            "url": rec.get("url") or "",
        }
    missing = []
    pieces = []
    cursor = 0
    used = []
    spans = [("cite", m.start(), m.end(), m.group(1)) for m in CITE_RE.finditer(markdown)]
    spans.extend(("brace", m.start(), m.end(), m.group(1)) for m in BRACE_KEY.finditer(markdown))
    spans.sort(key=lambda item: item[1])
    for kind, start, end, payload in spans:
        if start < cursor:
            continue
        pieces.append(rtf_escape(markdown[cursor:start]))
        if kind == "brace":
            rec = records.get(payload)
            if rec:
                if payload not in used:
                    used.append(payload)
                pieces.append("\\{" + f"{rec['family']}, {rec['year']}" + "\\}")
            else:
                pieces.append(rtf_escape(payload))
            cursor = end
            continue
        keys = parse_keys(payload)
        cites = []
        for key in keys:
            rec = records.get(key)
            if not rec:
                missing.append(key)
                continue
            if key not in used:
                used.append(key)
            cites.append(f"{rec['family']}, {rec['year']}")
        if cites:
            pieces.append("\\{" + "; ".join(cites) + "\\}")
        cursor = end
    pieces.append(rtf_escape(markdown[cursor:]))
    report = Path(args.report)
    report.parent.mkdir(parents=True, exist_ok=True)
    if missing:
        report.write_text("未匹配，未写 Zotero 稿：\n" + "\n".join(missing) + "\n", encoding="utf-8")
        print("unmatched citation keys", file=sys.stderr)
        return 1
    rtf = Path(args.rtf)
    rtf.parent.mkdir(parents=True, exist_ok=True)
    body = "".join(pieces).replace("\n", "\\par\n")
    rtf.write_text("{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}\\f0\\fs24 " + body + "}", encoding="utf-8")
    ris_lines = []
    for key in used:
        rec = records[key]
        ris_lines.append("TY  - JOUR")
        ris_lines.append(f"ID  - {key}")
        if rec["title"]:
            ris_lines.append(f"TI  - {load_bridge().title_text(rec['title'])}")
        for author in [part.strip() for part in rec["author"].split(" and ") if part.strip()]:
            ris_lines.append(f"AU  - {author}")
        if rec["year"] and rec["year"] != "n.d.":
            ris_lines.append(f"PY  - {rec['year']}")
        if rec["journal"]:
            ris_lines.append(f"T2  - {rec['journal']}")
        short = journal_short(rec["journal"], rec["journalabbreviation"])
        if short and short.casefold() != rec["journal"].strip().casefold():
            ris_lines.append(f"J2  - {short}")
        if rec["volume"]:
            ris_lines.append(f"VL  - {rec['volume']}")
        if rec["number"]:
            ris_lines.append(f"IS  - {rec['number']}")
        pages = rec["pages"].replace("–", "-").replace("—", "-")
        parts = [part.strip() for part in pages.split("--" if "--" in pages else "-", 1)] if pages else []
        if parts and parts[0]:
            ris_lines.append(f"SP  - {parts[0]}")
        if len(parts) == 2 and parts[1] and parts[1] != parts[0]:
            ris_lines.append(f"EP  - {parts[1]}")
        if rec["date"]:
            ris_lines.append(f"DA  - {rec['date']}")
        if rec["issn"]:
            ris_lines.append(f"SN  - {rec['issn']}")
        if rec["doi"]:
            ris_lines.append(f"DO  - {rec['doi']}")
        url = rec["url"] or (f"https://doi.org/{rec['doi']}" if rec["doi"] else "")
        if url:
            ris_lines.append(f"UR  - {url}")
        for word in [part.strip() for part in rec["keywords"].split(";") if part.strip()]:
            ris_lines.append(f"KW  - {word}")
        if rec["abstract"]:
            ris_lines.append(f"AB  - {rec['abstract']}")
        ris_lines.append("ER  - ")
        ris_lines.append("")
    Path(args.ris).parent.mkdir(parents=True, exist_ok=True)
    Path(args.ris).write_text("\n".join(ris_lines), encoding="utf-8")
    report.write_text(f"已写 {rtf.name}，文献 {len(used)} 条。先导入 RIS，再对 RTF 做一次 RTF Scan。\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
