#!/usr/bin/env python3
"""数据图画后自检（figure-forge 技能随包）：按登记的脚本重跑一遍，在每次保存图的那一刻检查成图。

不用改你的出图脚本：本脚本给 matplotlib 的 savefig 挂一个检查，然后照常运行 figures/manifest.json 里登记的脚本。
查什么（三档，不打总分）：
  拦下：缺字（字体里没有这个字，印出来是方框）、文字超出画布（没用 bbox_inches="tight" 时）、文字互相压住
        （含刻度标签挤在一起）、成品尺寸下字号低于下限（默认 5 pt）、SVG 文字转成了路径（svg.fonttype 不是 none，
        到 Illustrator / PPT 里改不了字）、存成 JPEG。
  待你判断：PDF 用 Type 3 字体（部分期刊不收，pdf.fonttype 设 42）、同一排的子图字母上沿不齐、灰度预览（黑白打印分不分得开）。
示意图（登记里 kind 为 schematic 的）不归这里查，见 schematic-forge 技能的 schematic_check.py。

用法（在工作目录下运行；Windows 上把 python3 换成 python）：
  python3 fig_lint.py [--root .] [--manifest figures/manifest.json] [--min-pt 5] [--only figures/fig2.svg]
结果写进 <工作目录>/.ccode/checks/fig-lint.jsonl，灰度预览放 .ccode/checks/fig-lint/。退出码：0 没有拦下的；1 有拦下的；2 缺 manifest。
"""
import argparse
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_common():
    for path in (HERE / "mesa_checks.py", HERE.parents[2] / "mesa_checks.py" if len(HERE.parents) > 2 else None):
        if path and path.is_file():
            spec = importlib.util.spec_from_file_location("mesa_checks", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise FileNotFoundError("找不到 mesa_checks.py（应与本脚本同目录）。在技能页更新 figure-forge 技能后再试")


C = load_common()
CHECKER = "script:fig_lint"

# 在子进程里先于用户脚本运行：挂 savefig 钩子，收集警告与日志，逐次保存后量版面
BOOT = r'''
import json, logging, os, re, runpy, sys, warnings
import matplotlib
matplotlib.use("Agg")
from matplotlib.figure import Figure
from matplotlib.text import Text
OUT = os.environ["FIG_LINT_OUT"]
GRAY = os.environ["FIG_LINT_GRAY"]
results, captured = [], []
class _H(logging.Handler):
    def emit(self, rec):
        captured.append(rec.getMessage())
logging.getLogger("matplotlib").addHandler(_H())
logging.getLogger("matplotlib").setLevel(logging.WARNING)
_show = warnings.showwarning
def _sw(message, *a, **k):
    captured.append(str(message))
warnings.showwarning = _sw
warnings.simplefilter("always")
_orig = Figure.savefig
_gray_cache = {}
def _audit(fig, fname, kw, before):
    if isinstance(fname, (str, bytes, os.PathLike)):
        fname = os.fsdecode(os.fspath(fname))
    elif hasattr(fname, "name") and isinstance(fname.name, str):
        fname = fname.name
    else:
        return
    fig.canvas.draw()
    r = fig.canvas.get_renderer()
    fb = fig.bbox
    # 刻度标签只算真正画出来的（坐标范围外的刻度也留着标签对象，但不画）
    all_ticks, drawn, minor_ticks = set(), set(), set()
    for ax in fig.axes:
        for axis in (ax.xaxis, ax.yaxis):
            for tick in axis.get_major_ticks():
                all_ticks.update({id(tick.label1), id(tick.label2)})
            for tick in axis.get_minor_ticks():
                all_ticks.update({id(tick.label1), id(tick.label2)})
                minor_ticks.update({id(tick.label1), id(tick.label2)})
            for tick in axis._update_ticks():
                for lab in (tick.label1, tick.label2):
                    all_ticks.add(id(lab))
                    if tick.get_visible() and lab.get_visible():
                        drawn.add(id(lab))
            for tick in axis.get_minor_ticks():
                minor_ticks.update({id(tick.label1), id(tick.label2)})
    texts = []
    for t in fig.findobj(Text):
        if not t.get_visible() or not t.get_text().strip():
            continue
        if id(t) in all_ticks and id(t) not in drawn:
            continue
        try:
            bb = t.get_window_extent(r)
        except Exception:
            continue
        if bb.width <= 0 or bb.height <= 0:
            continue
        texts.append({"text": t.get_text()[:40], "pt": float(t.get_fontsize()), "bbox": [bb.x0, bb.y0, bb.x1, bb.y1],
                      "minor": id(t) in minor_ticks,
                      "bold": str(t.get_fontweight()) in ("bold", "heavy", "black", "700", "800", "900")})
    msgs = [m for m in captured[before:] if re.search(r"missing from|Glyph \d+|findfont: Font family", m)]
    w_in, h_in = fig.get_size_inches()
    size_mm = [round(w_in * 25.4, 1), round(h_in * 25.4, 1)]
    fig_sig = (id(fig), size_mm[0], size_mm[1], tuple((t["text"], round(t["pt"], 2)) for t in texts))
    gray = _gray_cache.get(fig_sig)
    if gray is None:
        try:
            rel_no_ext = os.path.splitext(os.path.relpath(os.path.abspath(fname)))[0]
            slug = re.sub(r"[^A-Za-z0-9._-]+", "_", rel_no_ext).strip("._-") or "fig"
            gray = os.path.join(GRAY, slug + "-gray.png")
            os.makedirs(GRAY, exist_ok=True)
            _orig(fig, gray, dpi=150)
            from PIL import Image
            Image.open(gray).convert("L").save(gray)
            _gray_cache[fig_sig] = gray
        except Exception:
            gray = None
    results.append({"file": os.path.abspath(fname), "texts": texts, "fig": [fb.x0, fb.y0, fb.x1, fb.y1], "dpi": fig.dpi,
                    "size_mm": size_mm, "fig_sig": str(hash(fig_sig)),
                    "tight": kw.get("bbox_inches") == "tight", "msgs": msgs, "gray": gray,
                    "svg_fonttype": matplotlib.rcParams.get("svg.fonttype"), "pdf_fonttype": matplotlib.rcParams.get("pdf.fonttype")})
def _savefig(self, fname, *a, **kw):
    before = len(captured)
    ret = _orig(self, fname, *a, **kw)
    try:
        _audit(self, fname, kw, before)
    except Exception as e:
        results.append({"file": str(fname), "error": repr(e)})
    return ret
Figure.savefig = _savefig
script = sys.argv[1]
sys.argv = sys.argv[1:]
sys.path.insert(0, os.path.dirname(os.path.abspath(script)))
try:
    runpy.run_path(script, run_name="__main__")
finally:
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False)
'''


def overlap(a, b, tol=0.5):
    return a[0] + tol < b[2] and b[0] + tol < a[2] and a[1] + tol < b[3] and b[1] + tol < a[3]


def main():
    C.utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=".")
    ap.add_argument("--manifest", default="figures/manifest.json")
    ap.add_argument("--min-pt", type=float, default=5)
    ap.add_argument("--only", nargs="*", help="只查这些登记的图（file 字段）")
    a = ap.parse_args()
    root = Path(a.root).resolve()
    items = []
    mpath = root / a.manifest
    if not mpath.is_file():
        items.append(C.item(CHECKER, "MANIFEST", "figure_lint", "blocked", f"没有图登记文件 {a.manifest}", a.manifest))
        C.summary(items, C.write_items(root, "fig-lint.jsonl", items))
        return 2
    figs = [f for f in json.loads(mpath.read_text(encoding="utf-8")).get("figures", [])
            if isinstance(f, dict) and f.get("script") and f.get("kind") != "schematic"]
    if a.only:
        figs = [f for f in figs if f.get("file") in a.only]
    gray_dir = root / ".ccode" / "checks" / "fig-lint"
    done = {}
    for fig in figs:
        key = (fig["script"], tuple(str(x) for x in fig.get("args", [])))
        if key in done:
            continue
        script = root / fig["script"]
        if script.suffix.lower() != ".py":
            items.append(C.item(CHECKER, f"LINT-{fig['file']}", "figure_lint", "needs_human",
                                f"{fig['file']} 不是 Python 出图，画后自检只查 matplotlib；请人目视", fig["file"]))
            done[key] = []
            continue
        out = Path(tempfile.mkstemp(suffix=".json")[1])
        env = dict(os.environ, FIG_LINT_OUT=str(out), FIG_LINT_GRAY=str(gray_dir), MPLBACKEND="Agg")
        try:
            r = subprocess.run([sys.executable, "-c", BOOT, str(script)] + [str(x) for x in fig.get("args", [])], cwd=root, env=env,
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
        except subprocess.TimeoutExpired:
            items.append(C.item(CHECKER, f"LINT-{fig['file']}", "figure_lint", "needs_human", f"{fig['script']} 跑了 5 分钟没跑完", fig["file"]))
            continue
        if "No module named 'matplotlib'" in (r.stderr or ""):
            items.append(C.item(CHECKER, "MPL", "figure_lint", "needs_human", "本机没有 matplotlib，画后自检没法做", fig["script"]))
            break
        try:
            done[key] = json.loads(out.read_text(encoding="utf-8") or "[]")
        except (OSError, json.JSONDecodeError):
            done[key] = []
        out.unlink(missing_ok=True)
        if r.returncode != 0 and not done[key]:
            items.append(C.item(CHECKER, f"LINT-{fig['file']}", "figure_lint", "blocked", f"{fig['script']} 运行失败", fig["script"],
                                detail=(r.stderr or "")[-600:]))
    reg_files = {str(f.get("file", "")).lstrip("./") for f in figs}
    for results in done.values():
        rels = []
        gray_owner = {}
        for res in results:
            fpath = Path(res.get("file", ""))
            try:
                frel = fpath.resolve().relative_to(root).as_posix()
            except ValueError:
                frel = fpath.as_posix()
            rels.append((frel, fpath, res))
            if a.only and frel not in a.only:
                continue
            gk = res.get("fig_sig") or res.get("gray")
            if gk and (gk not in gray_owner or (frel in reg_files and gray_owner[gk] not in reg_files)):
                gray_owner[gk] = frel
        for frel, fpath, res in rels:
            if a.only and frel not in a.only:
                continue
            if "error" in res:
                items.append(C.item(CHECKER, f"ERR-{frel}", "figure_lint", "needs_human", f"{frel} 检查时出错：{res['error'][:120]}", frel))
                continue
            n_before = len(items)
            ext = fpath.suffix.lower()
            if ext in (".jpg", ".jpeg"):
                items.append(C.item(CHECKER, f"JPEG-{frel}", "figure_lint", "blocked", f"{frel} 存成了 JPEG：数据图用 SVG / PDF / PNG", frel))
            if ext == ".svg" and res.get("svg_fonttype") != "none":
                items.append(C.item(CHECKER, f"SVGFONT-{frel}", "figure_lint", "blocked",
                                    f"{frel} 的文字转成了路径（svg.fonttype={res.get('svg_fonttype')}）：脚本里设 plt.rcParams['svg.fonttype'] = 'none'", frel))
            if ext == ".pdf" and res.get("pdf_fonttype") != 42:
                items.append(C.item(CHECKER, f"PDFFONT-{frel}", "figure_lint", "needs_human",
                                    f"{frel} 用 Type 3 字体：部分期刊不收，设 plt.rcParams['pdf.fonttype'] = 42", frel))
            if res.get("msgs"):
                items.append(C.item(CHECKER, f"GLYPH-{frel}", "figure_lint", "blocked",
                                    f"{frel} 有缺字或找不到字体：{res['msgs'][0][:120]}", frel, detail="\n".join(res["msgs"][:5])))
            texts, fb = res["texts"], res["fig"]
            if not res.get("tight"):
                # tight_layout 在小尺寸或高 DPI 下常让边缘轴标题字框贴边 0.5–2 px（< 2 pt 空白字框余量，并非真裁字）
                clip_tol = max(2.0, float(res.get("dpi") or 100) * 2.0 / 72.0)
                out_t = [t for t in texts if t["bbox"][0] < fb[0] - clip_tol or t["bbox"][1] < fb[1] - clip_tol
                         or t["bbox"][2] > fb[2] + clip_tol or t["bbox"][3] > fb[3] + clip_tol]
                if out_t:
                    items.append(C.item(CHECKER, f"CLIP-{frel}", "figure_lint", "blocked",
                                        f"{frel} 有文字出了画布（会被裁掉）：「{out_t[0]['text']}」等 {len(out_t)} 处（加 bbox_inches='tight' 或留边距）", frel))
            small = [t for t in texts if t["pt"] < a.min_pt - 1e-6]
            if small:
                items.append(C.item(CHECKER, f"MINPT-{frel}", "figure_lint", "blocked",
                                    f"{frel} 有 {len(small)} 处字号低于 {a.min_pt:g} pt（最小 {min(t['pt'] for t in small):g} pt，「{small[0]['text']}」）：按成品尺寸设 figsize 后加大字号", frel))
            clash = [(t1, t2) for i, t1 in enumerate(texts) for t2 in texts[i + 1:] if overlap(t1["bbox"], t2["bbox"])]
            if clash:
                t1, t2 = clash[0]
                minor_clash = any(x.get("minor") or y.get("minor") for x, y in clash)
                hint = ("对数轴默认次刻度标签挤在一起时加 ax.xaxis.set_minor_formatter(NullFormatter())（或 yaxis）"
                        if minor_clash else "刻度太密就减刻度或转角度")
                items.append(C.item(CHECKER, f"CLASH-{frel}", "figure_lint", "blocked",
                                    f"{frel} 有 {len(clash)} 对文字互相压住（如「{t1['text']}」与「{t2['text']}」）：{hint}", frel))
            labels = [t for t in texts if t["bold"] and len(t["text"].strip("() ")) == 1 and t["text"].strip("() ").isalpha()]
            if len(labels) > 1:
                rows = []
                for t in sorted(labels, key=lambda t: -t["bbox"][3]):
                    if rows and abs(t["bbox"][3] - rows[-1][0]["bbox"][3]) < 0.04 * (fb[3] - fb[1]):
                        rows[-1].append(t)
                    else:
                        rows.append([t])
                if any(max(t["bbox"][3] for t in row) - min(t["bbox"][3] for t in row) > 1.5 for row in rows):
                    items.append(C.item(CHECKER, f"LABELS-{frel}", "figure_lint", "needs_human",
                                        f"{frel} 同一排的子图字母上沿不齐：用同一个 figure 坐标放字母", frel))
            if len(items) == n_before:
                items.append(C.item(CHECKER, f"OK-{frel}", "figure_lint", "passed",
                                    f"{frel} 版面自检通过（{res['size_mm'][0]:g}×{res['size_mm'][1]:g} mm，{len(texts)} 段文字）", frel))
            gk = res.get("fig_sig") or res.get("gray")
            if res.get("gray") and gray_owner.get(gk) == frel:
                gray_owner.pop(gk, None)
                gray_rel = (Path(res["gray"]).relative_to(root).as_posix()
                            if Path(res["gray"]).is_relative_to(root) else res["gray"])
                items.append(C.item(CHECKER, f"GRAY-{frel}", "figure_lint", "needs_human",
                                    f"{frel} 黑白打印分得开吗？看灰度预览", frel,
                                    detail=f"灰度预览：{gray_rel}"))
    if not figs:
        items.append(C.item(CHECKER, "NONE", "figure_lint", "needs_human", "登记里没有用脚本生成的数据图", a.manifest))
    return C.summary(items, C.write_items(root, "fig-lint.jsonl", items))


if __name__ == "__main__":
    sys.exit(main())
