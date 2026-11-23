#!/usr/bin/env python3
"""PDF 文本层码位与页脚碰撞抽检（只读）：渲染成功不等于文本层和版面可信。

查两类问题：
1. 码位漂移：U+037E（分号被映射成希腊问号，复制/检索/查重即坏）、U+FFFD / U+FFFF（缺字）、私有区字符。
2. 页脚碰撞（可用 --skip-layout 关闭）：图注或正文底边侵入底部页码区或紧贴物理底边（常见于超高拼图把图注顶撞页码）。

退出码 0 = 干净，1 = 有问题（逐项给页码、计数和前后文），2 = 缺 PyMuPDF 或打不开。
依赖 PyMuPDF（Mesa 诊断页「一键补齐」会装），不依赖 pdftotext（Windows 上通常没有）。
"""
from __future__ import annotations

import argparse
import re
import sys

SUSPECTS = {
    0x037E: "U+037E 希腊问号（本应是分号 ;）——xelatex 的 header 缺 ActualText 开关，见技能「码位抽检」",
    0xFFFD: "U+FFFD 替换字符",
    0xFFFF: "U+FFFF 缺字",
}

_PAGE_NUM_RE = re.compile(r"^(?:[-–—]?\s*(?:\d{1,4}|[ivxlcdm]{1,6})\s*[-–—]?|page\s+\d{1,4}(?:\s+of\s+\d{1,4})?)$", re.I)
_CAPTION_START_RE = re.compile(r"^(?:Figure|Fig\.|Table|Scheme|图|表)\s*S?\d+", re.I)


def label(cp: int) -> str | None:
    if cp in SUSPECTS:
        return SUSPECTS[cp]
    if 0xE000 <= cp <= 0xF8FF:
        return f"U+{cp:04X} 私有区字符（字体没有对应的标准码位）"
    return None


def check_page_footer_collision(page, page_number: int) -> list[tuple[int, str]]:
    """检查单页是否存在正文/图注侵入页脚页码区或紧贴页面底边（按行级 bbox，避免撞击时被合并进同一 block 漏检）。"""
    hits: list[tuple[int, str]] = []
    h = float(page.rect.height)
    if h <= 0:
        return hits

    footer_lines: list[tuple[float, float, float, float, str]] = []
    content_lines: list[tuple[float, float, float, float, str]] = []

    raw_dict = page.get_text("dict")
    for blk in raw_dict.get("blocks", []):
        if blk.get("type") != 0:
            continue
        for ln in blk.get("lines", []):
            spans = ln.get("spans", [])
            txt = re.sub(r"\s+", " ", "".join(s.get("text", "") for s in spans)).strip()
            if not txt:
                continue
            x0, y0, x1, y1 = ln.get("bbox", (0.0, 0.0, 0.0, 0.0))
            if y0 >= h * 0.88 and len(txt) <= 18 and _PAGE_NUM_RE.match(txt):
                footer_lines.append((x0, y0, x1, y1, txt))
            else:
                content_lines.append((x0, y0, x1, y1, txt))

    footer_top = min((b[1] for b in footer_lines), default=None)
    # 同一页按块去重（只报侵入最深的代表行，避免整段每行刷屏）
    reported = False
    for x0, y0, x1, y1, txt in sorted(content_lines, key=lambda b: b[3], reverse=True):
        kind = "图注/表题" if _CAPTION_START_RE.match(txt) else "正文"
        if footer_top is not None and y1 > footer_top - 2.0:
            hits.append((
                page_number,
                f"{kind}底边 y={y1:.1f}pt 侵入页脚页码顶边 y={footer_top:.1f}pt：「{txt[:50]}」",
            ))
            reported = True
        elif footer_top is None and y1 > h - 14.0:
            hits.append((
                page_number,
                f"{kind}底边 y={y1:.1f}pt 紧贴页面底边（页高 {h:.1f}pt）：「{txt[:50]}」",
            ))
            reported = True
        if reported:
            break
    return hits


def main(argv: list[str] | None = None) -> int:
    # 中文 Windows 的 stdout 默认 GBK，打印 ² 这类字符会直接崩
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    parser = argparse.ArgumentParser(description="Check PDF text layer for code point drift and footer collisions")
    parser.add_argument("pdf")
    parser.add_argument("--samples", type=int, default=3, help="每类问题最多列几处前后文")
    parser.add_argument("--skip-layout", action="store_true", help="只查码位，跳过页脚/底边碰撞检查")
    args = parser.parse_args(argv)
    try:
        import pymupdf  # type: ignore
    except ImportError:
        try:
            import fitz as pymupdf  # type: ignore
        except ImportError:
            print("PyMuPDF missing: python -m pip install pymupdf", file=sys.stderr)
            return 2
    try:
        doc = pymupdf.open(args.pdf)
    except Exception as exc:  # noqa: BLE001
        print(f"cannot open PDF: {exc}", file=sys.stderr)
        return 2
    found: dict[int, list[tuple[int, str]]] = {}
    footer_hits: list[tuple[int, str]] = []
    for number, page in enumerate(doc, start=1):
        text = page.get_text()
        for index, char in enumerate(text):
            cp = ord(char)
            if label(cp) is None:
                continue
            context = text[max(0, index - 20) : index + 10].replace("\n", " ")
            found.setdefault(cp, []).append((number, context))
        if not args.skip_layout:
            footer_hits.extend(check_page_footer_collision(page, number))

    if not found and not footer_hits:
        tail = "、无页脚碰撞" if not args.skip_layout else ""
        print(f"文本层干净：{len(doc)} 页，无 U+037E / 缺字 / 私有区字符{tail}")
        return 0
    for cp, hits in sorted(found.items()):
        print(f"{label(cp)}：{len(hits)} 处")
        for number, context in hits[: args.samples]:
            print(f"  第 {number} 页：…{context}…")
    if footer_hits:
        print(f"页脚/底边碰撞：{len(footer_hits)} 处（高图图注撞页码时请在 Markdown 设较小 width=\"XX%\" 或拆图重渲）")
        for number, detail in footer_hits[: max(args.samples, 6)]:
            print(f"  第 {number} 页：{detail}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
