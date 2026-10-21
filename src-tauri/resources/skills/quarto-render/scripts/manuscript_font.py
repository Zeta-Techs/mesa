#!/usr/bin/env python3
"""把正文字体写进源稿 YAML，并做出 Word 用的 reference.docx。

英文默认 Times New Roman，中文默认宋体。PDF 读 YAML 的 mainfont / CJKmainfont；
Word 读 reference.docx 的主题字体——同时把 `reference-doc` 写进 YAML 的 format.docx，
任何渲染入口（流程线 run 脚本、Agent 手敲的命令）出 Word 都自动套用，不靠记得加参数。
找不到指定字体就退出，不改成另一套。
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

DEFAULT_LATIN = "Times New Roman"
DEFAULT_CJK = "宋体"
CJK_CANDIDATES = ("宋体", "SimSun", "Songti SC", "宋体-简", "Noto Serif CJK SC", "Source Han Serif SC")


def families() -> set[str]:
    try:
        out = subprocess.run(
            ["fc-list", ":family"],
            check=False,
            capture_output=True,
            text=True,
            # 中文 Windows 默认按 GBK 解码子进程输出，quarto / pandoc 吐的是 UTF-8
            encoding="utf-8",
            errors="replace",
        ).stdout
    except OSError:
        return set()
    found = set()
    for line in out.splitlines():
        # 每行「路径: 族名:style=…」。Windows 的路径带盘符（C:/WINDOWS/fonts/times.ttf），先去掉盘符，
        # 不然按冒号切到的是路径的后半截，一个族名都认不出来（2026-10-20 TinyTeX 自带的 fc-list 实测）
        if re.match(r"^[A-Za-z]:[\\/]", line):
            line = line[2:]
        parts = line.split(":")
        if len(parts) < 2:
            continue
        for name in parts[1].split(","):
            found.add(name.strip())
    return found


def resolve_cjk(requested: str, installed: set[str]) -> str:
    if requested != DEFAULT_CJK:
        return requested
    for name in CJK_CANDIDATES:
        if name in installed:
            return name
    return requested


def split_frontmatter(text: str) -> tuple[str, str]:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end >= 0:
            return text[4:end], text[end + 4 :]
    return "", text


def set_yaml_line(block: str, key: str, value: str) -> str:
    lines = block.splitlines()
    replaced = False
    out = []
    for line in lines:
        if line.startswith(f"{key}:"):
            out.append(f'{key}: "{value}"')
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.append(f'{key}: "{value}"')
    return "\n".join(out)


INDENT_LINES = ["\\usepackage{indentfirst}", "\\setlength{\\parindent}{2em}"]
# unicode-math 开文档后才把希腊字母改成 other 类，开头读 .aux 时还是 letter 类。图注里有 Ω、α 的
# 标签每轮都判「可能已变」，xelatex 跑满 9 轮还报警告（2026-10-21 综述稿实证）。标签改按字面比较。
STABLE_LABEL_LINES = [
    "% Mesa: compare labels as strings (unicode-math recatcodes Greek after the .aux is read)",
    "\\makeatletter",
    "\\def\\@testdef#1#2#3{\\expandafter\\let\\expandafter\\reserved@b\\csname #1@#2\\endcsname"
    "\\edef\\reserved@a{\\detokenize{#3}}\\ifx\\reserved@b\\relax\\@tempswatrue\\else"
    "\\edef\\reserved@b{\\detokenize\\expandafter{\\reserved@b}}"
    "\\ifx\\reserved@a\\reserved@b\\else\\@tempswatrue\\fi\\fi}",
    "\\makeatother",
]


def ensure_booktabs(block: str) -> str:
    """PDF 表格用 booktabs：顶线、表头线、底线。正文首行缩进两个字符。标签按字面比较。已有 pdf 段也补上。"""
    missing = []
    if "parindent" not in block:
        missing += INDENT_LINES
    if "\\@testdef" not in block:
        missing += STABLE_LABEL_LINES
    extra = "".join(f"        {line}\n" for line in missing)
    if "booktabs" in block:
        if not missing:
            return block
        return block.replace("\\usepackage{booktabs}\n", "\\usepackage{booktabs}\n" + extra, 1)
    needle = "  pdf:\n"
    insert = "  pdf:\n    include-in-header:\n      text: |\n        \\usepackage{booktabs}\n" + extra
    if needle in block:
        return block.replace(needle, insert, 1)
    return block


# xelatex + Times New Roman：字体里分号字形同时挂在 U+003B 和 U+037E 上，xdvipdfmx 生成文本层映射时
# 选了后者，PDF 里所有分号复制/检索/查重出来都是希腊问号。ActualText 让它按真实字符写回
# （2026-10-21 Windows 实测：3 个分号 U+037E → U+003B）。\ifdefined 包一层：换成 lualatex 也不报错
ACTUALTEXT_LINE = "\\ifdefined\\XeTeXgenerateactualtext\\XeTeXgenerateactualtext=1\\fi"


def ensure_actualtext(block: str) -> str:
    """在 PDF 的 include-in-header 里补 ActualText 开关；已有就不动。旧稿重跑脚本也能补上。"""
    if "XeTeXgenerateactualtext" in block:
        return block
    found = re.search(r"^([ \t]*)\\usepackage\{booktabs\}[ \t]*$", block, re.M)
    if not found:
        return block
    return block[: found.end()] + "\n" + found.group(1) + ACTUALTEXT_LINE + block[found.end() :]


def ensure_pdf(block: str) -> str:
    if "\n  pdf:" in f"\n{block}" or block.startswith("  pdf:"):
        return block
    if "format:" not in block:
        block = set_yaml_line(block, "format", "")
        block = block.replace("format: \"\"", "format:")
    return block + "\n  pdf:\n    pdf-engine: xelatex\n    documentclass: article\n"


def set_pdf_font(block: str, key: str, value: str) -> str:
    lines = block.splitlines()
    out = []
    in_pdf = False
    replaced = False
    for line in lines:
        if line.startswith("  pdf:"):
            in_pdf = True
        elif line.startswith("  ") and not line.startswith("    ") and line.strip().endswith(":"):
            if in_pdf and not replaced:
                out.append(f'    {key}: "{value}"')
                replaced = True
            in_pdf = False
        if in_pdf and line.startswith(f"    {key}:"):
            out.append(f'    {key}: "{value}"')
            replaced = True
            continue
        out.append(line)
    if in_pdf and not replaced:
        out.append(f'    {key}: "{value}"')
    return "\n".join(out)


def ensure_docx_reference(block: str, reference: str) -> str:
    """format.docx 写上 reference-doc（路径相对稿件所在目录）。已写了就不动人改过的值。"""
    lines = block.splitlines()
    out = []
    in_docx = False
    found_docx = False
    has_ref = False
    for line in lines:
        if line.startswith("  docx:"):
            found_docx = True
            in_docx = True
            if line.strip() != "docx:":
                # `docx: default` 这类标量写法改成映射，才能挂参数
                out.append("  docx:")
                continue
        elif line.startswith("  ") and not line.startswith("    "):
            in_docx = False
        elif not line.startswith(" "):
            in_docx = False
        if in_docx and line.strip().startswith("reference-doc:"):
            has_ref = True
        out.append(line)
    if has_ref:
        return "\n".join(out)
    if found_docx:
        result = []
        for line in out:
            result.append(line)
            if line == "  docx:":
                result.append(f"    reference-doc: {reference}")
        return "\n".join(result)
    return "\n".join(out) + f"\n  docx:\n    reference-doc: {reference}\n"


def write_markdown(path: Path, latin: str, cjk: str, reference: str = "reference.docx") -> None:
    text = path.read_text(encoding="utf-8")
    front, body = split_frontmatter(text)
    if not front:
        raise SystemExit(f"{path} 没有 YAML 头")
    front = ensure_pdf(front)
    front = set_pdf_font(front, "mainfont", latin)
    front = set_pdf_font(front, "CJKmainfont", cjk)
    front = ensure_booktabs(front)
    front = ensure_actualtext(front)
    front = ensure_docx_reference(front, reference)
    path.write_text(f"---\n{front.strip()}\n---{body if body.startswith(chr(10)) else chr(10) + body}", encoding="utf-8")


def theme_fonts(theme: str, latin: str, cjk: str) -> str:
    """把 Word 主题的标题/正文字体槽（majorFont/minorFont）换成指定字体。

    槽的范围到对应的闭合标签为止。旧写法从开标签后一位找结束位置，找到的是开标签自己，
    整段换字体从没生效过，Word 一直是默认的 Aptos / 等线（2026-10-18 用 Quarto 1.10 实测）。
    """
    latin_xml = escape(latin)
    cjk_xml = escape(cjk)
    for tag in ("majorFont", "minorFont"):
        opening = theme.find(f":{tag}>")
        start = theme.rfind("<", 0, opening) if opening >= 0 else -1
        end = theme.find(f":{tag}>", opening + len(tag) + 2) if opening >= 0 else -1
        if start < 0 or end < 0:
            raise SystemExit("Word 主题里没有字体槽")
        block = theme[start:end]
        block = replace_attr(block, "latin", latin_xml)
        block = replace_attr(block, "ea", cjk_xml)
        block = replace_script(block, "Hans", cjk_xml)
        block = replace_script(block, "Hant", cjk_xml)
        theme = theme[:start] + block + theme[end:]
    return theme


def reference_docx(dest: Path, latin: str, cjk: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        sample = Path(tmp) / "sample.md"
        sample.write_text("# 标题\n\n正文 Body.\n", encoding="utf-8")
        made = Path(tmp) / "reference.docx"
        try:
            run = subprocess.run(
                ["quarto", "pandoc", str(sample), "-o", str(made), "-t", "docx"],
                capture_output=True,
                text=True,
                # 中文 Windows 默认按 GBK 解码子进程输出，quarto / pandoc 吐的是 UTF-8
                encoding="utf-8",
                errors="replace",
            )
        except OSError:
            # 先打一行 ASCII。英文 Windows 的 stderr 是 cp1252，中文 SystemExit 会变成
            # 反斜杠转义，调用方认不出「没有 quarto」。
            print("quarto not found", file=sys.stderr)
            raise SystemExit(1)
        if run.returncode != 0 or not made.is_file():
            raise SystemExit(run.stderr.strip() or "做不出 Word 字体模板")
        theme = theme_fonts(
            zipfile.ZipFile(made).read("word/theme/theme1.xml").decode("utf-8"), latin, cjk
        )
        styles = zipfile.ZipFile(made).read("word/styles.xml").decode("utf-8")
        styles = style_spacing(styles, "Normal", after="160", line="360")
        for level, size, before, after, outline in (
            ("Heading1", "32", "360", "120", "0"),
            ("Heading2", "28", "280", "80", "1"),
            ("Heading3", "24", "200", "60", "2"),
            ("Heading4", "24", "200", "60", "3"),
            ("Heading5", "22", "160", "40", "4"),
            ("Heading6", "22", "160", "40", "5"),
        ):
            styles = style_heading(styles, level, size, before, after, outline)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp_out = dest.with_suffix(".docx.tmp")
        with zipfile.ZipFile(made) as src, zipfile.ZipFile(tmp_out, "w") as out:
            for info in src.infolist():
                if info.filename == "word/theme/theme1.xml":
                    data = theme.encode("utf-8")
                elif info.filename == "word/styles.xml":
                    data = styles.encode("utf-8")
                else:
                    data = src.read(info.filename)
                out.writestr(info, data)
        tmp_out.replace(dest)


def style_block(styles: str, style_id: str) -> tuple[int, int] | None:
    marker = f'w:styleId="{style_id}"'
    start = styles.find(marker)
    if start < 0:
        return None
    start = styles.rfind("<w:style ", 0, start)
    end = styles.find("</w:style>", start)
    if start < 0 or end < 0:
        return None
    return start, end + len("</w:style>")


def style_spacing(styles: str, style_id: str, after: str, line: str) -> str:
    span = style_block(styles, style_id)
    if span is None:
        return styles
    start, end = span
    block = styles[start:end]
    spacing = f'<w:spacing w:after="{after}" w:line="{line}" w:lineRule="auto"/>'
    indent = '<w:jc w:val="both"/><w:ind w:firstLineChars="200" w:firstLine="480"/>'
    if "<w:spacing " in block:
        block = re.sub(r"<w:spacing [^/]*/>", spacing, block, count=1)
    elif "<w:pPr>" in block:
        block = block.replace("<w:pPr>", "<w:pPr>" + spacing, 1)
    else:
        block = block.replace("</w:style>", f"<w:pPr>{spacing}</w:pPr></w:style>", 1)
    if style_id == "Normal" and "firstLineChars" not in block:
        if "<w:pPr>" in block:
            block = block.replace("<w:pPr>", "<w:pPr>" + indent, 1)
        else:
            block = block.replace("</w:style>", f"<w:pPr>{indent}</w:pPr></w:style>", 1)
    return styles[:start] + block + styles[end:]


def style_heading(styles: str, style_id: str, size: str, before: str, after: str, outline: str) -> str:
    span = style_block(styles, style_id)
    if span is None:
        return styles
    start, end = span
    block = styles[start:end]
    spacing = (
        f'<w:keepNext/><w:outlineLvl w:val="{outline}"/>'
        f'<w:spacing w:before="{before}" w:after="{after}" w:line="360" w:lineRule="auto"/>'
    )
    if "<w:spacing " in block:
        block = re.sub(r"<w:spacing [^/]*/>", spacing, block, count=1)
    elif "<w:pPr>" in block:
        block = block.replace("<w:pPr>", "<w:pPr>" + spacing, 1)
    size_tag = f'<w:sz w:val="{size}"/>'
    if "<w:sz " in block:
        block = re.sub(r"<w:sz [^/]*/>", size_tag, block, count=1)
    elif "<w:rPr>" in block:
        block = block.replace("<w:rPr>", "<w:rPr>" + size_tag, 1)
    return styles[:start] + block + styles[end:]


def replace_attr(block: str, tag: str, value: str) -> str:
    needle = f':{tag} '
    start = block.find(needle)
    start = block.rfind("<", 0, start) if start >= 0 else -1
    if start < 0:
        return block
    end = block.find("/>", start)
    return block[:start] + f'<a:{tag} typeface="{value}"/>' + block[end + 2 :]


def replace_script(block: str, script: str, value: str) -> str:
    marker = f'script="{script}"'
    start = block.find(marker)
    if start < 0:
        return block
    tag = block.rfind("<", 0, start)
    end = block.find("/>", start)
    return block[:tag] + f'<a:font script="{script}" typeface="{value}"/>' + block[end + 2 :]


def apply(root: Path, markdown: str, latin: str, cjk: str) -> int:
    source = root / markdown
    if not source.is_file():
        print("找不到源稿", file=sys.stderr)
        return 1
    installed = families()
    latin = latin.strip() or DEFAULT_LATIN
    cjk = resolve_cjk(cjk.strip() or DEFAULT_CJK, installed)
    if installed and latin not in installed:
        print(f"本机没有英文正文字体：{latin}", file=sys.stderr)
        return 1
    if installed and cjk not in installed:
        print(f"本机没有中文正文字体：{cjk}", file=sys.stderr)
        return 1
    reference = root / "manuscript" / "reference.docx"
    rel = Path(os.path.relpath(reference, source.parent)).as_posix()
    write_markdown(source, latin, cjk, rel)
    reference_docx(reference, latin, cjk)
    (root / "manuscript" / "typeface.md").write_text(
        f"英文：{latin}\n中文：{cjk}\n", encoding="utf-8"
    )
    print(f"英文 {latin}，中文 {cjk}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Set manuscript body fonts")
    parser.add_argument("--root", required=True)
    parser.add_argument("--markdown", required=True)
    parser.add_argument("--latin", default=DEFAULT_LATIN)
    parser.add_argument("--cjk", default=DEFAULT_CJK)
    args = parser.parse_args(argv)
    return apply(Path(args.root), args.markdown, args.latin, args.cjk)


if __name__ == "__main__":
    sys.exit(main())
