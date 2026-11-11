"""Mesa 核验项公共写法（2026-11-02）：核验脚本共用，随包复制到各技能的 scripts/ 下。

核验项一行一条写进 <工作目录>/.ccode/checks/<文件名>.jsonl（每次整份重写）：
  {id, kind, status, title, target{file,line}, evidence{source,quote,page,detail}, checker, at}
status 只有 passed（机器能确定的事实）/ blocked（机器确定有问题）/ needs_human（要人看）。
要读懂内容才能定的，最多 needs_human，永不判通过。
"""
import datetime
import json
import re
import os
import sys
from pathlib import Path

STATUSES = ("passed", "blocked", "needs_human")


def utf8_stdio():
    # Windows 管道默认按系统代码页编码，中文与 ✗ 直接 UnicodeEncodeError
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def item(checker, id_, kind, status, title, file=None, line=None, **evidence):
    assert status in STATUSES, status
    out = {"id": id_, "kind": kind, "status": status, "title": title, "checker": checker, "at": now()}
    if file:
        out["target"] = {"file": file, **({"line": line} if line else {})}
    ev = {k: v for k, v in evidence.items() if v not in (None, "")}
    if ev:
        out["evidence"] = ev
    return out


def write_items(root, name, items):
    path = Path(root) / ".ccode" / "checks" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp%d" % os.getpid())
    tmp.write_text("".join(json.dumps(i, ensure_ascii=False) + "\n" for i in items), encoding="utf-8")
    os.replace(tmp, path)
    return path


def summary(items, path):
    """打印一行总数 + 每条非通过项；有拦下的返回 1，否则 0。"""
    n = {s: 0 for s in STATUSES}
    for i in items:
        n[i["status"]] += 1
    print(f"核验 {len(items)} 项：通过 {n['passed']}，拦下 {n['blocked']}，待你判断 {n['needs_human']}；结果写入 {path}")
    for i in items:
        if i["status"] != "passed":
            mark = "✗" if i["status"] == "blocked" else "?"
            where = i.get("target", {})
            loc = f"{where.get('file', '')}:{where.get('line', '')}".rstrip(":")
            print(f"{mark} {i['title']}" + (f"（{loc}）" if loc else ""))
    return 1 if n["blocked"] else 0


def split_location(loc):
    """'manuscript/x.md:12' → ('manuscript/x.md', 12)；没有行号时行号为 None。"""
    loc = str(loc or "")
    file, _, line = loc.rpartition(":")
    return (file, int(line)) if line.isdigit() and file else (loc, None)


# manuscript/ 下这些子目录不是正文：学校 / 期刊模板、Quarto 扩展与缓存、渲染输出、图
SKIP_DIRS = {"template", "templates", "_extensions", "_freeze", ".quarto", "output", "figures", "assets"}
TEXT_EXT = (".md", ".qmd", ".tex")
# 写作配套文件（文件名含这些词的不是正文稿件，默认扫 manuscript/ 时跳过）。三处各一份——这里、
# Mesa 的 src/manuscript-files.ts、bib-check 的 cite_check.py——内容以 tests/fixtures/manuscript-helpers.json 为准，测试逐条比对
MANUSCRIPT_HELPERS = (
    "citation-check", "citation-style", "review-report", "verification-decisions", "declarations",
    "checklist", "evidence", "section-status", "changelog", "numbers",
    "revision-notes", "outline", "typeface", "readme", "style-sheet",
)
MANUSCRIPT_HELPER_RE = re.compile("(" + "|".join(MANUSCRIPT_HELPERS) + ")", re.I)


def manuscript_files(root, skip_pattern=None, explicit=None):
    """要扫的稿件：explicit 给了就按它（相对 --root，可带通配，如 manuscript/chapters/*.tex、submission/formatted.md）；
    没给就递归 manuscript/ 下的 md / qmd / tex（LaTeX 的 chapters/ 也在内），跳过模板、输出等目录与 skip_pattern 命中的过程文件。"""
    root = Path(root)
    if explicit:
        files = []
        for pattern in explicit:
            hits = sorted(root.glob(pattern)) if any(c in pattern for c in "*?[") else [root / pattern]
            files += [p for p in hits if p.is_file()]
        return files
    base = root / "manuscript"
    if not base.is_dir():
        return []
    files = []
    for p in base.rglob("*"):
        rel = p.relative_to(base).parts
        if not p.is_file() or p.suffix.lower() not in TEXT_EXT or any(part in SKIP_DIRS for part in rel[:-1]):
            continue
        if skip_pattern and skip_pattern.search(p.name):
            continue
        files.append(p)
    return sorted(files)
