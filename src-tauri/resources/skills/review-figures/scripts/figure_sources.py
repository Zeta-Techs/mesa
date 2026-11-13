#!/usr/bin/env python3
"""Write figures/sources.md: where every panel of every composite came from.

The composites are cropped from PDFs, good enough for a draft. Before submission the
author replaces each panel with the publisher's original figure and asks for reuse
permission, so each panel needs: paper (authors, year, journal, DOI), figure and panel
in the original, PDF page, and how it was cropped.

Reads figures/figN.json (written by assemble_panels.py: letter -> panel file) and
<panel>.json next to each panel (written by extract_figure.py), plus references.bib.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

TITLE_PREFIX = re.compile(r"^\s*(?:【\s*\d+\s*】|\[\s*\d+\s*\]|\d+\s*~\s*\.?)\s*")
PLACEHOLDERS = {"待补", "待核", "无期号"}


def bib_entries(text: str) -> dict[str, dict[str, str]]:
    """BibTeX 条目：键 -> 字段（小写名）。值的花括号可嵌套。"""
    out: dict[str, dict[str, str]] = {}
    for m in re.finditer(r"@\w+\s*\{\s*([^,\s]+)\s*,", text):
        key = m.group(1)
        pos = m.end()
        fields: dict[str, str] = {}
        while True:
            f = re.compile(r"\s*([A-Za-z][\w-]*)\s*=\s*").match(text, pos)
            if not f:
                break
            name, pos = f.group(1).lower(), f.end()
            if pos < len(text) and text[pos] == "{":
                depth, i = 0, pos
                while i < len(text):
                    depth += (text[i] == "{") - (text[i] == "}")
                    if depth == 0:
                        break
                    i += 1
                value, pos = text[pos + 1:i], i + 1
            elif pos < len(text) and text[pos] == '"':
                end = text.index('"', pos + 1)
                value, pos = text[pos + 1:end], end + 1
            else:
                v = re.compile(r"[^,}\s]+").match(text, pos)
                value, pos = (v.group(0), v.end()) if v else ("", pos)
            fields[name] = re.sub(r"\s+", " ", value.replace("{", "").replace("}", "")).strip()
            comma = re.compile(r"\s*,").match(text, pos)
            if not comma:
                break
            pos = comma.end()
        out[key] = fields
    return out


def cite(fields: dict[str, str]) -> str:
    """Zhang et al., 2020, *ChemCatChem* 12, 3068–3075 — 题名"""
    def val(name: str) -> str:
        v = fields.get(name, "")
        return "" if v in PLACEHOLDERS else v
    authors = [a.strip() for a in re.split(r"\s+and\s+", val("author")) if a.strip()]
    first = authors[0].split(",")[0].strip() if authors else "（作者待补）"
    who = first + (" et al." if len(authors) > 2 else (f" & {authors[1].split(',')[0].strip()}" if len(authors) == 2 else ""))
    parts = [who, val("year")]
    venue = val("journal") or val("booktitle")
    if venue:
        pages = re.sub(r"(?<=\w)-{1,2}(?=\w)", "–", val("pages"))
        tail = ", ".join(x for x in (val("volume"), pages) if x)
        parts.append(f"*{venue}*" + (f" {tail}" if tail else ""))
    title = TITLE_PREFIX.sub("", val("title"), count=1)
    return ", ".join(p for p in parts if p) + (f" — {title}" if title else "")


def resolve_panel_path(figures: Path, source: str, composite_png: Path | None = None) -> Path:
    """拼板记的通常是工作区根相对路径（如 figures/src/x.png 或 figures/fig3/fig3.png）；
    从工作区外跑时先拼 figures.parent，避免 figures/fig3/fig3.png 按文件名落回整张拼板 figures/fig3.png。"""
    given = Path(source)
    comp = composite_png.resolve() if composite_png else None
    candidates: list[Path] = []
    if not given.is_absolute():
        candidates.append(figures.parent / given)
    candidates.extend([given, figures / "src" / given.name, figures / given.name])
    for cand in candidates:
        if comp and cand.resolve() == comp:
            continue
        if cand.is_file():
            return cand
    return (figures.parent / given) if not given.is_absolute() else given


def _resolve_manifest_rel(figures: Path, rel: str) -> Path:
    p = Path(rel)
    if p.is_absolute():
        return p.resolve()
    via_root = figures.parent / p
    if via_root.exists() or p.parts[:1] == (figures.name,):
        return via_root.resolve()
    return (figures / p).resolve()


def _display_rel(figures: Path, p: Path) -> str:
    try:
        return p.resolve().relative_to(figures.parent.resolve()).as_posix()
    except ValueError:
        return p.as_posix()


def manifest_panel_info(figures: Path, path: Path) -> dict | None:
    """识别拼板中的本综述自绘示意图（schematic-forge）或重绘数据图（figure-forge）：
    优先查 figures/manifest.json（精确路径、outputs 或子目录同 stem 的 .svg/.pdf），
    其次查子目录同级的 figure.json 图纸。命中则无需编造假文献 .json，也不进转载许可待申请。"""
    target = path.resolve()
    fig_root = figures.resolve()
    manifest_file = figures / "manifest.json"
    if manifest_file.is_file():
        try:
            raw = json.loads(manifest_file.read_text(encoding="utf-8"))
        except ValueError:
            raw = {}
        items = raw.get("figures", []) if isinstance(raw, dict) else (raw if isinstance(raw, list) else [])
        for item in items:
            if not isinstance(item, dict):
                continue
            declared = [str(x) for x in [item.get("file"), *(item.get("outputs") or [])] if x]
            resolved_files = [_resolve_manifest_rel(figures, x) for x in declared]
            matched = target in resolved_files
            if not matched and item.get("file"):
                primary = _resolve_manifest_rel(figures, str(item["file"]))
                if primary.stem == target.stem and (
                    (primary.parent == target.parent and target.parent != fig_root)
                    or primary in (target.with_suffix(".svg"), target.with_suffix(".pdf"))
                ):
                    matched = True
            if matched:
                if item.get("kind") == "schematic" or item.get("spec"):
                    artifact = str(item.get("spec") or item.get("file") or "")
                    return {"self_drawn": "schematic", "artifact": artifact, "entry": item}
                script = str(item.get("script") or item.get("file") or "")
                args = [str(a) for a in (item.get("args") or []) if str(a)]
                artifact = f"{script} {' '.join(args)}".strip() if args else script
                return {"self_drawn": "plot", "artifact": artifact, "entry": item}
    if target.parent != fig_root and (target.parent / "figure.json").is_file():
        return {
            "self_drawn": "schematic",
            "artifact": _display_rel(figures, target.parent / "figure.json"),
        }
    return None


def panel_source(path: Path, figures: Path | None = None) -> dict:
    side = path.with_suffix(".json")
    side_data: dict | None = None
    if side.is_file():
        try:
            loaded = json.loads(side.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                side_data = loaded
        except ValueError:
            pass
    # 真从 PDF/原图裁出的块带 pdf 字段；无 pdf 字段时先看 manifest.json / figure.json 是否登记为本综述自绘/重绘
    if side_data and side_data.get("pdf"):
        return side_data
    if figures is not None:
        own = manifest_panel_info(figures, path)
        if own is not None:
            return own
    if side_data is not None:
        if side_data.get("self_drawn"):
            kind = "schematic" if side_data["self_drawn"] == "schematic" else "plot"
            return {"self_drawn": kind, "artifact": str(side_data.get("artifact") or side_data.get("spec") or side_data.get("script") or "")}
        return side_data
    # 没有来源记录（脚本外裁的）：按文件名 <键>-fig3b.png 猜，页码记不上
    m = re.match(r"(.+?)-(fig|scheme|table)(\d+)([a-z]?)$", path.stem, re.I)
    if not m:
        return {"key": path.stem}
    kind = {"fig": "Fig.", "scheme": "Scheme", "table": "Table"}[m.group(2).lower()]
    return {"key": m.group(1), "label": f"{kind} {m.group(3)}" + (f"({m.group(4)})" if m.group(4) else ""), "guessed": True}


def where(src: dict) -> str:
    label = src.get("label") or "（原图编号未记录）"
    bits = [label]
    if src.get("page"):
        bits.append(f"PDF 第 {src['page']} 页")
    if src.get("box"):
        x0, y0, x1, y1 = src["box"]
        bits.append(f"裁框 {x0:.2f}–{x1:.2f} × {y0:.2f}–{y1:.2f}")
    if src.get("guessed"):
        bits.append("按文件名推断，未留裁图记录")
    return "，".join(bits)


def claim(md: Path) -> str:
    """figN.md 图注的第一句（论点），去掉开头的 **Figure N.**"""
    if not md.is_file():
        return ""
    text = re.sub(r"^\*\*Figure \d+\.\*\*\s*", "", md.read_text(encoding="utf-8").strip())
    m = re.match(r"(.+?[.。])(\s|$)", text)
    return m.group(1) if m else text[:200]


def build(figures: Path, bib: Path) -> str:
    entries = bib_entries(bib.read_text(encoding="utf-8")) if bib.is_file() else {}
    lines = [
        "# 拼图来源清单",
        "",
        "这些拼图是从论文 PDF 里裁出来的，供初稿审阅。投稿前要换成出版社的原图：按 DOI 打开文章页，在图表（Figures）里找到下表写的那张图，"
        "下载高清原图后取同一块子图重新拼。转载或改编别人的图要向出版社申请许可（多数期刊走 RightsLink；开放获取文章看它的许可协议），"
        "图注写成 “Adapted from … with permission from …”。",
        "",
        "由 review-figures 技能的 `figure_sources.py` 按每块的裁图记录生成，重裁后重跑即更新。",
    ]
    layouts = sorted(figures.glob("fig*.json"), key=lambda p: int(re.sub(r"\D", "", p.stem) or 0))
    has_layout = False
    for layout in layouts:
        try:
            data = json.loads(layout.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if not isinstance(data, dict) or not isinstance(data.get("panels"), list):
            continue
        has_layout = True
        n = re.sub(r"\D", "", layout.stem)
        lines += ["", f"## Figure {n}"]
        point = claim(layout.with_suffix(".md"))
        if point:
            lines += ["", f"论点：{point}"]
        lines += ["", "| 新编号 | 原文 | 原图里的位置 | DOI | 本地 PDF |", "|---|---|---|---|---|"]
        for panel in data.get("panels", []):
            path = resolve_panel_path(figures, str(panel["source"]), layout.with_suffix(".png"))
            src = panel_source(path, figures)
            if src.get("self_drawn"):
                is_schem = src["self_drawn"] == "schematic"
                paper_col = (
                    "本综述自绘示意图（schematic-forge，无需转载许可）"
                    if is_schem
                    else "本综述重绘数据图（figure-forge，无需转载许可）"
                )
                artifact = src.get("artifact", "")
                where_col = (
                    (f"图纸 `{artifact}`" if is_schem else f"脚本 `{artifact}`")
                    if artifact
                    else ("本综述自绘图纸" if is_schem else "本综述重绘脚本")
                )
                lines.append(f"| ({panel['letter']}) | {paper_col} | {where_col} | — | — |")
                continue
            fields = entries.get(src.get("key", ""), {})
            doi = fields.get("doi", "")
            doi_cell = f"[{doi}](https://doi.org/{doi})" if doi and doi not in PLACEHOLDERS else "（无 DOI）"
            paper = cite(fields) if fields else f"（引文库里没有键 {src.get('key', '?')}）"
            pdf = f"`{src['pdf']}`" if src.get("pdf") else "—"
            lines.append(f"| ({panel['letter']}) | {paper} [@{src.get('key', '?')}] | {where(src)} | {doi_cell} | {pdf} |")
    if not has_layout:
        lines += ["", "（没有找到拼板记录 figN.json：先用 assemble_panels.py 拼板。）"]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--figures", type=Path, default=Path("figures"))
    p.add_argument("--bib", type=Path, default=Path("references.bib"))
    p.add_argument("--out", type=Path, default=None, help="默认 figures/sources.md")
    a = p.parse_args(argv)
    out = a.out or a.figures / "sources.md"
    out.write_text(build(a.figures, a.bib), encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
