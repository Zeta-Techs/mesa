"""生成打包版自动点验用的样例项目：各种常见文件类型各一份（文件树里逐个打开看会不会崩）。

用法：python -I -X utf8 scripts/win-package-smoke/make_samples.py <目标目录>
目标目录已存在就覆盖同名文件。只用标准库 + PyMuPDF（fitz）+ Pillow（Mesa 依赖体检里的两项）；
docx / xlsx 用 zipfile 手拼最小 OOXML，不依赖 python-docx / openpyxl。
"""
import json
import struct
import sys
import wave
import zipfile
from pathlib import Path


def write(p: Path, text: str, encoding: str = "utf-8") -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding=encoding, newline="\n")


def make_docx(p: Path) -> None:
    ct = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    doc = ('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
           '<w:p><w:r><w:t>点验用 Word 文档：第一段。</w:t></w:r></w:p>'
           '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>加粗的第二段 Bold paragraph.</w:t></w:r></w:p></w:body></w:document>')
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", doc)


def make_xlsx(p: Path) -> None:
    ct = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    wb = ('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>')
    wb_rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
    rows = [("样本", "温度", "产率"), ("A", 25, 0.81), ("B", 40, 0.77), ("C", 60, 0.69)]
    cells = []
    for r, row in enumerate(rows, 1):
        cs = []
        for c, v in enumerate(row):
            ref = f"{chr(65 + c)}{r}"
            if isinstance(v, str):
                cs.append(f'<c r="{ref}" t="inlineStr"><is><t>{v}</t></is></c>')
            else:
                cs.append(f'<c r="{ref}"><v>{v}</v></c>')
        cells.append(f'<row r="{r}">{"".join(cs)}</row>')
    sheet = ('<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             f'<sheetData>{"".join(cells)}</sheetData></worksheet>')
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels)
        z.writestr("xl/workbook.xml", wb)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        z.writestr("xl/worksheets/sheet1.xml", sheet)


def make_wav(p: Path) -> None:
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"".join(struct.pack("<h", int(8000 * ((i // 20) % 2 * 2 - 1))) for i in range(8000)))


def main() -> None:
    root = Path(sys.argv[1])
    root.mkdir(parents=True, exist_ok=True)
    write(root / "README.md", "# 点验项目\n\n正文 **加粗**、`行内代码`、公式 $E=mc^2$。\n\n$$\\int_0^1 x^2\\,dx = \\frac13$$\n\n"
          "| 列 | 值 |\n|---|---|\n| a | 1 |\n\n```python\nprint('hi')\n```\n\n```mermaid\ngraph LR\n  A[开始] --> B[结束]\n```\n\n"
          "![图](figures/plot.png)\n\n引用 [@smith2020]。\n")
    write(root / "notes" / "中文 文件名.md", "# 中文文件名\n\n路径里有空格和中文。\n")
    write(root / "src" / "main.ts", "export function add(a: number, b: number): number {\n  return a + b;\n}\n")
    write(root / "src" / "analysis.py", "import math\n\n\ndef area(r: float) -> float:\n    return math.pi * r * r\n")
    write(root / "src" / "run.ps1", "Write-Host '你好'\n")
    write(root / "src" / "run.sh", "#!/bin/sh\necho hi\n")
    write(root / "src" / "style.css", "body { color: #111; background: #fff; }\n")
    write(root / "src" / "data.json", json.dumps({"name": "点验", "n": [1, 2, 3]}, ensure_ascii=False, indent=2))
    write(root / "config.yaml", "name: 点验\nitems:\n  - a\n  - b\n")
    write(root / "config.toml", "[project]\nname = \"点验\"\n")
    write(root / "data" / "results.csv", "样本,温度,产率\nA,25,0.81\nB,40,0.77\n")
    write(root / "data" / "excel-gbk.csv", "姓名,年龄\n张三,30\n李四,28\n", encoding="gbk")
    write(root / "data" / "table.tsv", "a\tb\n1\t2\n")
    write(root / "data" / "big.log", "".join(f"{i:06d} 第 {i} 行日志 lorem ipsum dolor sit amet\n" for i in range(20000)))
    write(root / "paper" / "main.tex", "\\documentclass{article}\n\\begin{document}\nHello $x^2$ 你好\n\\end{document}\n")
    write(root / "paper" / "references.bib", "@article{smith2020,\n  title={A Study},\n  author={Smith, J.},\n  year={2020}\n}\n")
    write(root / "page.html", "<!doctype html><html><head><style>h1{color:#c33}</style></head><body><h1>HTML 预览</h1><p>正文</p></body></html>")
    write(root / "figures" / "diagram.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#3a7"/><text x="10" y="35">SVG</text></svg>')
    write(root / "notebook.ipynb", json.dumps({
        "cells": [
            {"cell_type": "markdown", "metadata": {}, "source": ["# 笔记本\n", "说明"]},
            {"cell_type": "code", "execution_count": 1, "metadata": {}, "source": ["1 + 1"],
             "outputs": [{"output_type": "execute_result", "execution_count": 1, "data": {"text/plain": ["2"]}, "metadata": {}}]},
        ],
        "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}},
        "nbformat": 4, "nbformat_minor": 5}, ensure_ascii=False))
    write(root / "empty.txt", "")
    (root / "binary.bin").write_bytes(bytes(range(256)) * 4)

    from PIL import Image, ImageDraw
    img = Image.new("RGB", (320, 200), "#f4f1ea")
    d = ImageDraw.Draw(img)
    for i in range(10):
        d.rectangle([20 + i * 28, 180 - i * 15, 40 + i * 28, 180], fill="#3a6ea5")
    (root / "figures").mkdir(exist_ok=True)
    img.save(root / "figures" / "plot.png")
    img.save(root / "figures" / "photo.jpg", quality=85)

    try:
        import pymupdf as fitz
    except ImportError:  # 老版本只有 fitz 这个名字
        import fitz
    for sub in ("papers", "docs", "media"):
        (root / sub).mkdir(exist_ok=True)
    pdf = fitz.open()
    for n in range(3):
        page = pdf.new_page()
        page.insert_text((72, 72), f"Smoke test PDF page {n + 1}", fontsize=18)
    pdf.save(root / "papers" / "sample.pdf")

    make_docx(root / "docs" / "report.docx")
    make_xlsx(root / "data" / "results.xlsx")
    make_wav(root / "media" / "beep.wav")
    print(f"已生成样例项目：{root}")


if __name__ == "__main__":
    main()
