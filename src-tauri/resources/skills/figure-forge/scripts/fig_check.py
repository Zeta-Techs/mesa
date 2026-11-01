#!/usr/bin/env python3
"""图重建核验（figure-forge 技能随包，2026-11-02）：每张图用登记的脚本重跑一遍，确认还原得出来。

图登记在 figures/manifest.json：
  {"figures": [{"file": "figures/fig2-ablation.pdf", "script": "figures/make_figures.py", "args": ["fig2"]}]}
  - script 按扩展名运行：.py 用当前 Python，.R 用 Rscript，.jl 用 julia；在工作目录下运行，单张最多 5 分钟；
  - 同一脚本出多张图时各登记一行（args 可空，重复的脚本 + 参数只跑一次）。
结论：脚本失败或没生成该文件 → 拦下；重跑后与原文件逐字节一致 → 通过；生成了但字节不同（PDF/PNG 常带时间戳）→ 待你判断，
请人目视对比。重跑会用新结果覆盖原图——这本来就是脚本该出的版本。
--coverage 另列出稿件里引用了、但没登记脚本的图（交人看）。

结果写进 <工作目录>/.ccode/checks/fig-check.jsonl。退出码：0 没有拦下的；1 有拦下的；2 缺 manifest。
Windows 上把 python3 换成 python。
"""
import argparse
import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


def load_common():
    here = Path(__file__).resolve()
    for path in (here.parent / "mesa_checks.py", here.parents[3] / "mesa_checks.py"):
        if path.is_file():
            spec = importlib.util.spec_from_file_location("mesa_checks", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise FileNotFoundError("找不到 mesa_checks.py（应与本脚本同目录）。在技能页更新 figure-forge 技能后再试")


C = load_common()
CHECKER = "script:fig_check"
TIMEOUT = 300
IMAGE_REF = re.compile(r"!\[[^\]]*\]\(\s*<?([^)\s>]+)>?|\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def runner(script):
    ext = script.suffix.lower()
    if ext == ".py":
        return [sys.executable]
    if ext == ".r":
        exe = shutil.which("Rscript")
        return [exe] if exe else None
    if ext == ".jl":
        exe = shutil.which("julia")
        return [exe] if exe else None
    return None


def run_script(root, script, args):
    cmd = runner(script)
    if cmd is None:
        return None, f"不认识或本机没装 {script.suffix} 脚本的运行程序"
    try:
        done = subprocess.run(cmd + [str(script)] + [str(a) for a in args], cwd=root, capture_output=True,
                              text=True, encoding="utf-8", errors="replace", timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return False, f"运行超过 {TIMEOUT // 60} 分钟，已停"
    except OSError as err:
        return False, str(err)
    tail = (done.stderr or done.stdout or "").strip().splitlines()[-3:]
    return done.returncode == 0, "；".join(tail)


def main():
    C.utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=".", help="工作目录（figures/ 与出图脚本所在）")
    ap.add_argument("--manifest", default="figures/manifest.json")
    ap.add_argument("--coverage", action="store_true", help="另列出稿件引用了但没登记脚本的图")
    ap.add_argument("--files", nargs="*", help="--coverage 查哪些稿件（相对 --root，可带通配）；默认递归 manuscript/")
    args = ap.parse_args()
    root = Path(args.root).resolve()
    items = []
    mpath = root / args.manifest
    if not mpath.is_file():
        items.append(C.item(CHECKER, "MANIFEST", "figure_rebuild", "blocked", f"没有图登记文件 {args.manifest}", args.manifest,
                            detail="每张图登记生成它的脚本，见 figure-forge 技能「图登记」"))
        out = C.write_items(root, "fig-check.jsonl", items)
        C.summary(items, out)
        raise SystemExit(2)
    try:
        data = json.loads(mpath.read_text(encoding="utf-8"))
        figures = [f for f in (data.get("figures", []) if isinstance(data, dict) else data) if isinstance(f, dict)]
    except (ValueError, OSError) as err:
        items.append(C.item(CHECKER, "MANIFEST", "figure_rebuild", "blocked", f"图登记文件读不了：{err}", args.manifest))
        out = C.write_items(root, "fig-check.jsonl", items)
        C.summary(items, out)
        raise SystemExit(2)
    before = {}
    for fig in figures:
        f = root / str(fig.get("file", ""))
        before[fig.get("file")] = sha256(f) if f.is_file() else None
    ran = {}
    for n, fig in enumerate(figures, 1):
        file = str(fig.get("file", ""))
        script_rel = str(fig.get("script", ""))
        iid = f"FIG-{file or n}"
        if not file or not script_rel:
            items.append(C.item(CHECKER, iid, "figure_rebuild", "needs_human", f"第 {n} 条图登记缺文件或脚本", args.manifest))
            continue
        script = root / script_rel
        if not script.is_file():
            items.append(C.item(CHECKER, iid, "figure_rebuild", "blocked", f"{file} 登记的脚本不存在", file, source=script_rel))
            continue
        key = (script_rel, tuple(str(a) for a in fig.get("args", [])))
        if key not in ran:
            ran[key] = run_script(root, script, fig.get("args", []))
        ok, log = ran[key]
        if ok is None:
            items.append(C.item(CHECKER, iid, "figure_rebuild", "needs_human", f"{file} 没法重跑", file, source=script_rel, detail=log))
            continue
        if not ok:
            items.append(C.item(CHECKER, iid, "figure_rebuild", "blocked", f"{file} 的脚本重跑失败", file, source=script_rel, detail=log))
            continue
        target = root / file
        if not target.is_file():
            items.append(C.item(CHECKER, iid, "figure_rebuild", "blocked", f"脚本跑完了，但没有生成 {file}", file, source=script_rel,
                                detail="输出文件名与登记对不上"))
            continue
        old = before.get(fig.get("file"))
        if old == sha256(target):
            items.append(C.item(CHECKER, iid, "figure_rebuild", "passed", f"{file} 重跑后逐字节一致", file, source=script_rel))
        elif old is None:
            items.append(C.item(CHECKER, iid, "figure_rebuild", "passed", f"{file} 由脚本重新生成（原来没有这个文件）", file,
                                source=script_rel))
        else:
            items.append(C.item(CHECKER, iid, "figure_rebuild", "needs_human", f"{file} 重跑出了图，但与原文件字节不同", file,
                                source=script_rel, detail="PDF / PNG 常带生成时间；请目视对比，确认数据与画面一致"))
    if args.coverage:
        registered = {str(f.get("file", "")).lstrip("./") for f in figures}
        for path in C.manuscript_files(root, None, args.files):
            rel = path.relative_to(root).as_posix()
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except (OSError, UnicodeDecodeError):
                continue
            for no, text in enumerate(lines, 1):
                for a, b in IMAGE_REF.findall(text):
                    ref = (a or b).strip()
                    if ref.startswith(("http://", "https://")):
                        continue
                    norm = (path.parent / ref).resolve()
                    try:
                        ref_rel = norm.relative_to(root).as_posix()
                    except ValueError:
                        ref_rel = ref
                    if ref_rel not in registered and ref.lstrip("./") not in registered:
                        items.append(C.item(CHECKER, f"COV-{ref_rel}", "figure_rebuild", "needs_human",
                                            f"稿件引用的 {ref_rel} 没登记生成脚本", rel, no,
                                            detail="数据图要登记脚本；示意图、转载图写明来源即可"))
    out = C.write_items(root, "fig-check.jsonl", items)
    raise SystemExit(C.summary(items, out))


if __name__ == "__main__":
    main()
