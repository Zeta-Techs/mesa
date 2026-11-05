#!/usr/bin/env python3
"""在人改过的 PPTX 上做局部修改（schematic-forge 技能随包）。

「人改过的文件为准」：人在 PowerPoint / WPS / Keynote 里改过 figures/<图名>/<图名>.pptx 之后，AI 不再从图纸重新生成，
只用本脚本在这份文件上改需要改的那几处，其余（包括人的改动）原样保留。每次改之前在 figures/<图名>/.history/ 留一份备份。

用法（Windows 上把 python3 换成 python）：
  python3 pptx_edit.py list     figures/x/x.pptx
  python3 pptx_edit.py set-text figures/x/x.pptx --shape s1 --text "新文字\n第二段"     （沿用原来第一段第一段文字的格式）
  python3 pptx_edit.py move     figures/x/x.pptx --shape s1 [--x 10 --y 20] [--w 30 --h 15]   （毫米）
  python3 pptx_edit.py style    figures/x/x.pptx --shape s1 [--fill "#DDEBF7"] [--stroke "#1F4E79"] [--text-color "#222222"] [--pt 7]
  python3 pptx_edit.py image    figures/x/x.pptx --shape icon1 --src figures/x/assets/new.png   （位置大小不变，按比例放进原框）
  python3 pptx_edit.py delete   figures/x/x.pptx --shape old-note
  python3 pptx_edit.py add-text figures/x/x.pptx --name note2 --x 10 --y 50 --w 40 --h 8 --text "…" [--like s1-text 来源格式]
  python3 pptx_edit.py preview  figures/x/x.pptx   （转一张 PNG 预览：有 LibreOffice 才行，图名-preview.png）
形状按名字找（list 里的 name；Mesa 生成时名字就是图纸里的元素 id），找不到就报错，不猜。
还没被人改过的 PPTX（与 render.json 记的哈希一致）应改图纸重渲，本脚本拒绝，除非加 --anyway。
退出码：0 成功；2 参数错或找不到形状；3 文件打不开。
"""
import argparse
import datetime
import io
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import figlib as F  # noqa: E402

EMU_MM = 36000


def find(slide, name):
    hits = [s for s in slide.shapes if s.name == name]
    if not hits:
        raise KeyError(name)
    return hits[0]


def backup(path):
    hist = path.parent / ".history"
    hist.mkdir(exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    dst = hist / f"{path.stem}-{stamp}{path.suffix}"
    shutil.copy2(path, dst)
    return dst


def generator_version(path):
    """True = 这份还是渲染器生成的原样（没人改过）"""
    rec = path.parent / "render.json"
    if not rec.is_file():
        return False
    try:
        old = json.loads(rec.read_text(encoding="utf-8")).get("outputs", {}).get("pptx")
    except json.JSONDecodeError:
        return False
    return bool(old) and old == F.file_digest(path)


def rgb(v):
    from pptx.dml.color import RGBColor
    return RGBColor.from_string(v.lstrip("#").upper())


def set_text(shape, text):
    import copy
    from lxml import etree
    from pptx.oxml.ns import qn
    tf = shape.text_frame
    first_p = tf.paragraphs[0]._p
    first_r = first_p.find(qn("a:r"))
    rpr = copy.deepcopy(first_r.find(qn("a:rPr"))) if first_r is not None and first_r.find(qn("a:rPr")) is not None else None
    ppr = copy.deepcopy(first_p.find(qn("a:pPr"))) if first_p.find(qn("a:pPr")) is not None else None
    body = tf._txBody
    for p in list(body.findall(qn("a:p"))):
        body.remove(p)
    for line in text.split("\n"):
        p = etree.SubElement(body, qn("a:p"))
        if ppr is not None:
            p.append(copy.deepcopy(ppr))
        r = etree.SubElement(p, qn("a:r"))
        if rpr is not None:
            r.append(copy.deepcopy(rpr))
        t = etree.SubElement(r, qn("a:t"))
        t.text = line


def main():
    F.utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["list", "set-text", "move", "style", "image", "delete", "add-text", "preview"])
    ap.add_argument("pptx")
    ap.add_argument("--shape")
    ap.add_argument("--text")
    ap.add_argument("--x", type=float)
    ap.add_argument("--y", type=float)
    ap.add_argument("--w", type=float)
    ap.add_argument("--h", type=float)
    ap.add_argument("--fill")
    ap.add_argument("--stroke")
    ap.add_argument("--text-color")
    ap.add_argument("--pt", type=float)
    ap.add_argument("--src")
    ap.add_argument("--name")
    ap.add_argument("--like")
    ap.add_argument("--anyway", action="store_true")
    a = ap.parse_args()
    path = Path(a.pptx)
    try:
        from pptx import Presentation
        from pptx.util import Emu, Pt
        prs = Presentation(str(path))
    except Exception as e:
        print(f"✗ 打不开 {path}：{e}", file=sys.stderr)
        return 3
    slide = prs.slides[0]

    def mm(v):
        return round(v / EMU_MM, 1)

    if a.cmd == "list":
        for s in slide.shapes:
            text = s.text_frame.text.replace("\n", " / ")[:60] if s.has_text_frame else ""
            print(f"{s.name}\t{s.shape_type}\tx={mm(s.left)} y={mm(s.top)} w={mm(s.width)} h={mm(s.height)}\t{text}")
        return 0
    if a.cmd == "preview":
        soffice = shutil.which("soffice") or shutil.which("libreoffice") or (
            "/Applications/LibreOffice.app/Contents/MacOS/soffice" if Path("/Applications/LibreOffice.app/Contents/MacOS/soffice").is_file() else None)
        if not soffice:
            print("✗ 没有 LibreOffice，出不了预览；请用户在 PowerPoint / WPS 里打开看", file=sys.stderr)
            return 3
        d = Path(tempfile.mkdtemp(prefix="mesa-pptx-"))
        subprocess.run([soffice, "--headless", f"-env:UserInstallation=file://{d}/p", "--convert-to", "png", "--outdir", str(d), str(path)],
                       capture_output=True, timeout=180)
        made = d / (path.stem + ".png")
        if not made.is_file():
            print("✗ LibreOffice 没转出 PNG", file=sys.stderr)
            return 3
        out = path.with_name(path.stem + "-preview.png")
        shutil.move(str(made), out)
        print(f"saved: {out.resolve()}")
        print("note: 这是 LibreOffice 的渲染，字体可能与 PowerPoint 不同，只用来看位置")
        return 0
    if generator_version(path) and not a.anyway:
        print("✗ 这份 PPTX 还是渲染器生成的原样（没人改过）：改 figure.json 后重跑 render_figure.py，图纸与文件保持一致。\n"
              "  确实只想改这份文件时加 --anyway。", file=sys.stderr)
        return 2
    if a.cmd != "add-text" and not a.shape:
        print("✗ 要给 --shape（用 list 看名字）", file=sys.stderr)
        return 2
    try:
        shape = find(slide, a.shape) if a.shape else None
        like = find(slide, a.like) if a.like else None
    except KeyError as e:
        print(f"✗ 找不到名为 {e.args[0]} 的形状（先用 list 看名字）", file=sys.stderr)
        return 2
    bak = backup(path)
    if a.cmd == "set-text":
        if not shape.has_text_frame:
            print(f"✗ {a.shape} 不是能写字的形状", file=sys.stderr)
            return 2
        set_text(shape, (a.text or "").replace("\\n", "\n"))
    elif a.cmd == "move":
        if a.x is not None:
            shape.left = Emu(round(a.x * EMU_MM))
        if a.y is not None:
            shape.top = Emu(round(a.y * EMU_MM))
        if a.w is not None:
            shape.width = Emu(round(a.w * EMU_MM))
        if a.h is not None:
            shape.height = Emu(round(a.h * EMU_MM))
    elif a.cmd == "style":
        if a.fill:
            shape.fill.solid()
            shape.fill.fore_color.rgb = rgb(a.fill)
        if a.stroke:
            shape.line.color.rgb = rgb(a.stroke)
        if (a.text_color or a.pt) and shape.has_text_frame:
            for p in shape.text_frame.paragraphs:
                for r in p.runs:
                    if a.text_color:
                        r.font.color.rgb = rgb(a.text_color)
                    if a.pt:
                        r.font.size = Pt(a.pt)
    elif a.cmd == "image":
        from PIL import Image
        src = Path(a.src or "")
        if not src.is_file():
            print(f"✗ 找不到图片 {src}", file=sys.stderr)
            return 2
        x, y, w, h = shape.left, shape.top, shape.width, shape.height
        iw, ih = Image.open(src).size
        scale = min(w / iw, h / ih)
        pw, ph = round(iw * scale), round(ih * scale)
        pic = slide.shapes.add_picture(str(src), x + (w - pw) // 2, y + (h - ph) // 2, pw, ph)
        pic.name = shape.name
        shape._element.addprevious(pic._element)  # 放回原来的叠放层次
        shape._element.getparent().remove(shape._element)
    elif a.cmd == "delete":
        shape._element.getparent().remove(shape._element)
    elif a.cmd == "add-text":
        if None in (a.x, a.y, a.w, a.h) or not a.name or a.text is None:
            print("✗ add-text 要给 --name --x --y --w --h --text", file=sys.stderr)
            return 2
        tb = slide.shapes.add_textbox(Emu(round(a.x * EMU_MM)), Emu(round(a.y * EMU_MM)), Emu(round(a.w * EMU_MM)), Emu(round(a.h * EMU_MM)))
        tb.name = a.name
        if like is not None and like.has_text_frame:
            import copy
            tb.text_frame._txBody.getparent().replace(tb.text_frame._txBody, copy.deepcopy(like.text_frame._txBody))
            set_text(tb, a.text.replace("\\n", "\n"))
        else:
            tb.text_frame.word_wrap = True
            tb.text_frame.text = a.text.replace("\\n", "\n")
            for p in tb.text_frame.paragraphs:
                for r in p.runs:
                    r.font.size = Pt(a.pt or 7)
    prs.save(str(path))
    print(f"saved: {path.resolve()}")
    print(f"note: 改前备份在 {bak}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
