#!/usr/bin/env python3
"""PDF 文本层码位抽检（只读）：渲染成功不等于文本层可信。

查三类问题：U+037E（分号被映射成希腊问号，复制/检索/查重即坏）、U+FFFD / U+FFFF（缺字）、
私有区字符。退出码 0 = 干净，1 = 有问题（逐项给页码、计数和前后文），2 = 缺 PyMuPDF 或打不开。
依赖 PyMuPDF（Mesa 诊断页「一键补齐」会装），不依赖 pdftotext（Windows 上通常没有）。
"""
from __future__ import annotations

import argparse
import sys

SUSPECTS = {
    0x037E: "U+037E 希腊问号（本应是分号 ;）——xelatex 的 header 缺 ActualText 开关，见技能「码位抽检」",
    0xFFFD: "U+FFFD 替换字符",
    0xFFFF: "U+FFFF 缺字",
}


def label(cp: int) -> str | None:
    if cp in SUSPECTS:
        return SUSPECTS[cp]
    if 0xE000 <= cp <= 0xF8FF:
        return f"U+{cp:04X} 私有区字符（字体没有对应的标准码位）"
    return None


def main(argv: list[str] | None = None) -> int:
    # 中文 Windows 的 stdout 默认 GBK，打印 ² 这类字符会直接崩
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    parser = argparse.ArgumentParser(description="Check PDF text layer for code point drift")
    parser.add_argument("pdf")
    parser.add_argument("--samples", type=int, default=3, help="每类问题最多列几处前后文")
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
    for number, page in enumerate(doc, start=1):
        text = page.get_text()
        for index, char in enumerate(text):
            cp = ord(char)
            if label(cp) is None:
                continue
            context = text[max(0, index - 20) : index + 10].replace("\n", " ")
            found.setdefault(cp, []).append((number, context))
    if not found:
        print(f"文本层干净：{len(doc)} 页，无 U+037E / 缺字 / 私有区字符")
        return 0
    for cp, hits in sorted(found.items()):
        print(f"{label(cp)}：{len(hits)} 处")
        for number, context in hits[: args.samples]:
            print(f"  第 {number} 页：…{context}…")
    return 1


if __name__ == "__main__":
    sys.exit(main())
