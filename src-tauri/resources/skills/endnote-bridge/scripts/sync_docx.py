#!/usr/bin/env python3
"""Read an EndNote field docx and report cite changes. Apply only accepted lines."""
from __future__ import annotations

import argparse
import base64
import html
import re
import sys
import zipfile
from pathlib import Path

CITE_RE = re.compile(
    r"\[((?:-?@[A-Za-z0-9_.:-]+(?:\s*,[^\];]*)?)(?:\s*;\s*-?@[A-Za-z0-9_.:-]+(?:\s*,[^\];]*)?)*)\]"
)
LABEL_RE = re.compile(r"<label>(.*?)</label>", re.I | re.S)
DOI_RE = re.compile(r"<electronic-resource-num>(.*?)</electronic-resource-num>", re.I | re.S)
TITLE_RE = re.compile(r"<titles>\s*<title>(.*?)</title>", re.I | re.S)
YEAR_RE = re.compile(r"<year>(.*?)</year>", re.I | re.S)
ITEM_RE = re.compile(
    r"^- (S\d+) \| ([^|]+?) \| (删除|文献库没有) \| 决定：(接受|拒绝|待定)(.*)$",
    re.M,
)


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


def markdown_keys(text: str) -> list[str]:
    keys: list[str] = []
    for match in CITE_RE.finditer(text):
        for key in parse_keys(match.group(1)):
            if key not in keys:
                keys.append(key)
    return keys


def docx_records(path: Path) -> list[dict]:
    with zipfile.ZipFile(path) as zf:
        xml = zf.read("word/document.xml").decode("utf-8", "ignore")
    # EndNote 把引文 XML 放在域数据（fldData，base64）里；instrText 只剩短指令。
    # 生成稿没点过 Update 时两者都可能有，合在一起读。
    parts = re.findall(r"<w:instrText[^>]*>(.*?)</w:instrText>", xml, re.S)
    for raw in re.findall(r"<w:fldData[^>]*>(.*?)</w:fldData>", xml, re.S):
        try:
            parts.append(base64.b64decode("".join(raw.split())).decode("utf-8", "ignore").rstrip("\x00"))
        except Exception:
            continue
    blob = html.unescape("".join(parts))
    found = []
    seen = set()
    for match in re.finditer(r"<Cite>(.*?)</Cite>", blob, re.S):
        body = match.group(1)
        label = LABEL_RE.search(body)
        doi = DOI_RE.search(body)
        title = TITLE_RE.search(body)
        year = YEAR_RE.search(body)
        key = (label.group(1).strip() if label else "")
        rec = {
            "key": key,
            "doi": doi.group(1).strip() if doi else "",
            "title": re.sub(r"\s+", " ", title.group(1)).strip() if title else "",
            "year": year.group(1).strip() if year else "",
        }
        token = key or rec["doi"] or rec["title"]
        if token and token not in seen:
            seen.add(token)
            found.append(rec)
    return found


def pick_docx(root: Path) -> Path | None:
    source = root / "manuscript" / "source.docx"
    generated = root / "output" / "endnote.docx"
    if source.is_file():
        return source
    if generated.is_file():
        return generated
    return None


def bib_keys(text: str) -> set[str]:
    return set(re.findall(r"@\w+\s*\{\s*([^,\s]+)", text))


def write_report(path: Path, docx: Path, md_path: Path, removed: list[str], added: list[dict], bib_ids: set[str]) -> None:
    lines = [
        "# EndNote 同步报告",
        "",
        f"- Word：`{docx}`",
        f"- 源稿：`{md_path}`",
        "",
        "先改决定。只有「接受」会写回。Export Traveling Library 在 Word 的 EndNote 菜单里，把文献抄进你自己的库；这里不代做。",
        "",
        "## 删除",
    ]
    if removed:
        for i, key in enumerate(removed, 1):
            lines.append(f"- S{i:03d} | {key} | 删除 | 决定：待定")
    else:
        lines.append("无")
    lines += ["", "## 源稿没有"]
    if added:
        base = len(removed)
        for n, rec in enumerate(added, 1):
            key = rec["key"] or "新键待补"
            lines.append(f"- S{base + n:03d} | {key} | 在 Word 里、源稿没有。等人指出位置再写，这里不自动插入。")
    else:
        lines.append("无")
    lines += ["", "## 文献库没有"]
    library_missing = [rec for rec in added if rec["key"] and rec["key"] not in bib_ids]
    if library_missing:
        start = len(removed) + len(added)
        for n, rec in enumerate(library_missing, 1):
            lines.append(
                f"- S{start + n:03d} | {rec['key']} | 文献库没有 | 决定：待定 | title={rec['title']} | year={rec['year']} | doi={rec['doi']}"
            )
    else:
        lines.append("无")
    lines.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def drop_key(text: str, key: str) -> str:
    def repl(match: re.Match) -> str:
        kept = [item for item in parse_keys(match.group(1)) if item != key]
        if not kept:
            return ""
        return "[@" + "; @".join(kept) + "]"
    return CITE_RE.sub(repl, text)


def field(extra: str, name: str) -> str:
    match = re.search(rf"{name}=([^|]*)", extra)
    return match.group(1).strip() if match else ""


def apply_report(root: Path, report: str, md_path: Path, bib_path: Path) -> None:
    text = md_path.read_text(encoding="utf-8")
    bib = bib_path.read_text(encoding="utf-8") if bib_path.is_file() else ""
    changed = False
    for _sid, key, kind, decision, extra in ITEM_RE.findall(report):
        if decision != "接受":
            continue
        if kind == "删除" and key:
            updated = drop_key(text, key)
            if updated != text:
                text = updated
                changed = True
        elif kind == "文献库没有":
            cite = key if key and key != "新键待补" else ""
            title, year, doi = field(extra, "title"), field(extra, "year"), field(extra, "doi")
            if not cite or cite in bib_keys(bib) or not (title or doi):
                continue
            bib += (
                f"\n@article{{{cite},\n"
                f"  title = {{{title}}},\n"
                f"  year = {{{year}}},\n"
                f"  doi = {{{doi}}},\n"
                "  note = {待补}\n}\n"
            )
            changed = True
    if not changed:
        return
    md_path.write_text(text, encoding="utf-8")
    bib_path.write_text(bib, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Report EndNote docx citation changes")
    parser.add_argument("--root", required=True)
    parser.add_argument("--markdown", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    root = Path(args.root)
    md_path = root / args.markdown
    report_path = root / "papers" / "endnote-sync-report.md"
    if args.apply:
        if not report_path.is_file() or not md_path.is_file():
            print("report or markdown missing", file=sys.stderr)
            return 1
        apply_report(root, report_path.read_text(encoding="utf-8"), md_path, root / "references.bib")
        return 0
    docx = pick_docx(root)
    if docx is None or not md_path.is_file():
        print("endnote docx or markdown missing", file=sys.stderr)
        return 1
    word = docx_records(docx)
    source = markdown_keys(md_path.read_text(encoding="utf-8"))
    word_keys = [rec["key"] for rec in word if rec["key"]]
    removed = [key for key in source if key not in word_keys]
    known = set(source)
    added = [rec for rec in word if rec["key"] not in known]
    bib_path = root / "references.bib"
    bib_ids = bib_keys(bib_path.read_text(encoding="utf-8")) if bib_path.is_file() else set()
    write_report(report_path, docx, md_path, removed, added, bib_ids)
    return 0


if __name__ == "__main__":
    sys.exit(main())
