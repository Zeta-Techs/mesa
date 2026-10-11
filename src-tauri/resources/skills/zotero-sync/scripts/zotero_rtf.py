#!/usr/bin/env python3
"""Markdown [@key] → Zotero RTF Scan file plus a RIS of just those items."""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

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


def write_library_ris(bib_text: str, dest: Path) -> tuple[int, int]:
    """整份 bib 写成 Zotero RIS。用 bridge 解析，避免花括号和括号把作者、标题截断。

    Zotero 的文件导入不会对已有条目去重——整份重复导入会逐条建重复项（2026-10-11 实证：
    72 条全量重导后库里 144 条）。所以按 DOI 做差量：库里已有的跳过，只交缺的。
    返回 (写入条数, 跳过条数)。
    """
    bridge = load_bridge()
    match = load_library_match()
    records = bridge.parse_bibtex(bib_text)
    known_dois: set[str] = set()
    db = match.zotero_db_path()
    if db is not None:
        index, _owner, _note = match.zotero_index(db)
        known_dois = set(index)
    lines = []
    skipped = 0
    written = []
    for rec in records:
        doi = match.norm_doi(rec.get("doi") or "")
        if doi and doi in known_dois:
            skipped += 1
            continue
        written.append(rec)
        kind = {"article": "JOUR", "book": "BOOK", "incollection": "CHAP", "inproceedings": "CONF", "phdthesis": "THES"}.get(rec.get("type"), "JOUR")
        lines.append(f"TY  - {kind}")
        # Zotero 份字段口径（2026-10-11 与 zotero-sync/lit-search SKILL、screening-review.ts 的
        # recordToZoteroRis 对齐）：期刊全称只写 T2、缩写只写 J2；不写 ID（Zotero 导入不读，
        # 键的回流职责在 EndNote 份）、不写 N1（会进笔记）、不写 JO/JF/JA（JO 会进期刊缩写格）、
        # 不写 DA/ET/M2/M3/LA/N2（EndNote 格子或重复）。
        if rec.get("title"):
            lines.append(f"TI  - {bridge.clean(rec['title'])}")
        for author in rec.get("authors") or []:
            lines.append(f"AU  - {bridge.family_comma(author)}")
        if rec.get("year"):
            lines.append(f"PY  - {rec['year']}")
        journal = rec.get("journal") or ""
        if journal:
            lines.append(f"T2  - {bridge.clean(journal)}")
        short = journal_short(journal, rec.get("journalAbbreviation") or "")
        if short and short.lower() != journal.lower():
            lines.append(f"J2  - {short}")
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
        lines.append("ER  - ")
        lines.append("")
    dest.parent.mkdir(parents=True, exist_ok=True)
    header = (
        f"# 整份引文库，共 {len(records)} 条。不是 papers/to-fetch.md 的待获取名单。\r\n"
        f"# 本次写入 {len(written)} 条，库里已有同一 DOI 跳过 {skipped} 条"
        "（Zotero 的文件导入不去重，全量重导会建重复条目）。\r\n"
    )
    dest.write_bytes((header + "\r\n".join(lines)).encode("utf-8"))
    return len(written), skipped


def main(argv: list[str] | None = None) -> int:
    # Windows 控制台/管道默认 cp1252：差量与库体检提示含中文，print 会 UnicodeEncodeError
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Write a Zotero RTF Scan manuscript")
    parser.add_argument("--library-ris", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--bib", required=True)
    parser.add_argument("--rtf")
    parser.add_argument("--ris", required=True)
    parser.add_argument("--report")
    args = parser.parse_args(argv)
    if args.library_ris:
        written, skipped = write_library_ris(Path(args.bib).read_text(encoding="utf-8"), Path(args.ris))
        print(
            f"差量导入：本次新增 {written} 条"
            + (f"，库里已有跳过 {skipped} 条（重复条目请在 Zotero「重复项」里合并）" if skipped else "")
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
            ris_lines.append(f"TI  - {load_bridge().clean(rec['title'])}")
        for author in [part.strip() for part in rec["author"].split(" and ") if part.strip()]:
            ris_lines.append(f"AU  - {author}")
        if rec["year"] and rec["year"] != "n.d.":
            ris_lines.append(f"PY  - {rec['year']}")
        if rec["journal"]:
            ris_lines.append(f"T2  - {rec['journal']}")
        short = journal_short(rec["journal"], rec["journalabbreviation"])
        if short:
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
