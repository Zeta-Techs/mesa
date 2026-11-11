#!/usr/bin/env python3
"""数字追溯核验（research-writing 技能随包，2026-11-02）：正文里的每个数字都要能追到分析输出。

写正文时把要核的数字登记进 manuscript/numbers.json：
  {"numbers": [{"id": "N001", "location": "manuscript/<稿件>.md:<行号>", "value": "0.42",
                "source": "results/metrics.json", "path": "model.auc"}]}
  - JSON 结果用 path（点号分层，列表用 [0]）；CSV 结果用 row（第几行数据，从 1 起）或 match（{"列名": "值"}）加 column；
  - 正文写成百分数而结果是小数时加 "scale": 100。
脚本逐条到结果文件里取值，按正文显示的小数位算舍入误差比对；再看登记的那一行正文里确实写着这个数。
--coverage 另列出稿件里带小数或百分号、却没登记的数字（交人看，不拦）。

结果写进 <工作目录>/.ccode/checks/num-check.jsonl。退出码：0 没有拦下的；1 有拦下的；2 缺 numbers.json。
Windows 上把 python3 换成 python。
"""
import argparse
import csv
import importlib.util
import json
import re
from pathlib import Path


def load_common():
    here = Path(__file__).resolve()
    for path in (here.parent / "mesa_checks.py", here.parents[3] / "mesa_checks.py"):
        if path.is_file():
            spec = importlib.util.spec_from_file_location("mesa_checks", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise FileNotFoundError("找不到 mesa_checks.py（应与本脚本同目录）。在技能页更新 research-writing 技能后再试")


C = load_common()
CHECKER = "script:num_check"
# 写作配套文件不当稿件扫（章节状态里记着「用到的关键数」，原先会被当成没登记的数字）：名单只在 mesa_checks.py
SKIP = C.MANUSCRIPT_HELPER_RE
NUMBER = re.compile(r"(?<![\w.])[-−]?\d[\d,]*\.\d+%?|(?<![\w.])[-−]?\d[\d,]*%")


def item(*args, **kwargs):
    return C.item(CHECKER, *args, **kwargs)


def parse_shown(text):
    """正文显示的数 → (数值, 小数位, 是否百分数)；认不出返回 None。"""
    raw = str(text).strip().replace("−", "-").replace(",", "")
    percent = raw.endswith("%")
    raw = raw.rstrip("%").strip()
    if not re.fullmatch(r"-?\d+(\.\d+)?", raw):
        return None
    decimals = len(raw.split(".")[1]) if "." in raw else 0
    return float(raw), decimals, percent


def json_lookup(data, path):
    cur = data
    for part in re.findall(r"[^.\[\]]+|\[\d+\]", path):
        if part.startswith("["):
            cur = cur[int(part[1:-1])]
        else:
            cur = cur[part]
    return cur


def csv_lookup(path, row, match, column):
    with path.open(encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    if match:
        hits = [r for r in rows if all(str(r.get(k, "")).strip() == str(v) for k, v in match.items())]
        if len(hits) != 1:
            raise LookupError(f"按 {match} 找到 {len(hits)} 行，应恰好一行")
        return hits[0][column]
    return rows[int(row) - 1][column]


def source_value(root, entry):
    src = Path(root) / entry["source"]
    if not src.is_file():
        raise FileNotFoundError(f"结果文件 {entry['source']} 不存在")
    if src.suffix.lower() == ".csv":
        return float(csv_lookup(src, entry.get("row"), entry.get("match"), entry["column"]))
    data = json.loads(src.read_text(encoding="utf-8"))
    return float(json_lookup(data, entry.get("path", "")))


def line_text(root, file, line):
    try:
        lines = (Path(root) / file).read_text(encoding="utf-8").splitlines()
        return lines[line - 1] if line and 0 < line <= len(lines) else None
    except (OSError, UnicodeDecodeError):
        return None


def check_entry(root, n, entry):
    nid = str(entry.get("id") or f"N{n:03d}")
    file, line = C.split_location(entry.get("location"))
    shown_text = str(entry.get("value", "")).strip()
    shown = parse_shown(shown_text)
    base = dict(source=f"{entry.get('source', '')}" + (f"#{entry['path']}" if entry.get("path") else ""))
    if shown is None or not entry.get("source"):
        return item(f"N-{nid}", "number_trace", "needs_human", f"{nid} 登记不完整（缺数值或结果文件）", file, line, **base)
    try:
        actual = source_value(root, entry)
    except (FileNotFoundError, KeyError, IndexError, LookupError, ValueError, TypeError) as err:
        return item(f"N-{nid}", "number_trace", "blocked", f"正文的 {shown_text} 在结果文件里取不到", file, line,
                    detail=str(err), **base)
    value, decimals, _ = shown
    scaled = actual * float(entry.get("scale", 1))
    tolerance = 0.5 * 10 ** (-decimals) + 1e-9 * max(1.0, abs(scaled))
    expect = f"{scaled:.{decimals}f}"
    if abs(scaled - value) > tolerance:
        return item(f"N-{nid}", "number_trace", "blocked", f"正文写 {shown_text}，结果文件是 {expect}", file, line,
                    detail=f"结果文件原值 {actual!r}" + (f"（×{entry['scale']}）" if entry.get("scale") else ""), **base)
    text = line_text(root, file, line)
    if text is not None and shown_text not in text.replace("−", "-"):
        return item(f"N-{nid}", "number_trace", "needs_human", f"{shown_text} 与结果一致，但登记的那一行正文里没有这个数",
                    file, line, detail="行号可能变了；请人核对正文位置", **base)
    return item(f"N-{nid}", "number_trace", "passed", f"{shown_text} 与结果文件一致", file, line,
                detail=f"结果文件 {expect}", **base)


def coverage(root, entries, files=None):
    registered = {(C.split_location(e.get("location"))[0], str(e.get("value", "")).strip()) for e in entries}
    registered_values = {v for _, v in registered}
    out = []
    for path in C.manuscript_files(root, SKIP, files):
        rel = path.relative_to(root).as_posix()
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        fenced = False
        for no, text in enumerate(lines, 1):
            if text.lstrip().startswith(("```", "~~~")):
                fenced = not fenced
                continue
            if fenced or text.lstrip().startswith(("![", "|---", "<!--")):
                continue
            for hit in NUMBER.findall(text):
                hit = hit.replace("−", "-")
                if hit not in registered_values:
                    out.append((rel, no, hit))
    return out


def main():
    C.utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=".", help="工作目录（稿件、numbers.json 与结果文件所在）")
    ap.add_argument("--numbers", default="manuscript/numbers.json")
    ap.add_argument("--coverage", action="store_true", help="另列出没登记的小数 / 百分数")
    ap.add_argument("--files", nargs="*", help="--coverage 查哪些文件（相对 --root，可带通配）；默认递归 manuscript/")
    args = ap.parse_args()
    root = Path(args.root).resolve()
    items = []
    path = root / args.numbers
    if not path.is_file():
        items.append(item("NUMBERS", "number_trace", "blocked", f"没有数字登记文件 {args.numbers}", args.numbers,
                          detail="正文里要核的数字登记进这份文件，见 research-writing 技能「数字追溯」"))
        out = C.write_items(root, "num-check.jsonl", items)
        C.summary(items, out)
        raise SystemExit(2)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        entries = [e for e in (data.get("numbers", []) if isinstance(data, dict) else data) if isinstance(e, dict)]
    except (ValueError, OSError) as err:
        items.append(item("NUMBERS", "number_trace", "blocked", f"数字登记文件读不了：{err}", args.numbers))
        out = C.write_items(root, "num-check.jsonl", items)
        C.summary(items, out)
        raise SystemExit(2)
    items += [check_entry(root, n, e) for n, e in enumerate(entries, 1)]
    if args.coverage:
        missing = coverage(root, entries, args.files)
        if missing:
            sample = "；".join(f"{f}:{l} {v}" for f, l, v in missing[:30])
            more = f"（另有 {len(missing) - 30} 处）" if len(missing) > 30 else ""
            items.append(item("COV", "number_trace", "needs_human", f"稿件里有 {len(missing)} 个小数 / 百分数没登记出处",
                              missing[0][0], missing[0][1], detail=sample + more))
    out = C.write_items(root, "num-check.jsonl", items)
    raise SystemExit(C.summary(items, out))


if __name__ == "__main__":
    main()
