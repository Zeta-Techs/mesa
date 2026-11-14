#!/usr/bin/env python3
"""统计自洽核验（stats-check 技能随包，2026-11-02）：只拦算术上的不一致，不评判方法选得好不好。

照 statcheck 的思路扫稿件：
  - 从正文抽出 t(df)、F(df1, df2)、χ²(df)、r(df)、z 及紧跟的 p 值，按统计量显示的位数算舍入区间重算双侧 p，
    与正文 p 比对；对不上的拦下（单侧检验没写明也会对不上，正文写明「单侧」的跳过）；
  - 估计值和它自己的置信区间：估计值不在区间内、或下限大于上限的拦下。
纯标准库实现（不依赖 scipy），结果写进 <工作目录>/.ccode/checks/stat-check.jsonl。
退出码：0 没有拦下的；1 有拦下的。Windows 上把 python3 换成 python。
"""
import argparse
import importlib.util
import math
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
    raise FileNotFoundError("找不到 mesa_checks.py（应与本脚本同目录）。在技能页更新 stats-check 技能后再试")


C = load_common()
CHECKER = "script:stat_check"
SKIP = re.compile(C.MANUSCRIPT_HELPER_RE.pattern + "|stats-check", re.I)


# ---------------- 分布函数（Numerical Recipes 口径） ----------------

def _betacf(a, b, x):
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c, d = 1.0, 1.0 - qab * x / qap
    d = 1.0 / (d if abs(d) > 1e-300 else 1e-300)
    h = d
    for m in range(1, 300):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        d = 1.0 / (d if abs(d) > 1e-300 else 1e-300)
        c = 1.0 + aa / c if abs(1.0 + aa / c) > 1e-300 else 1e-300
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        d = 1.0 / (d if abs(d) > 1e-300 else 1e-300)
        c = 1.0 + aa / c if abs(1.0 + aa / c) > 1e-300 else 1e-300
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 3e-14:
            break
    return h


def betai(a, b, x):
    """正则化不完全 Beta 函数 I_x(a, b)。"""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    lbt = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x)
    if x < (a + 1) / (a + b + 2):
        return math.exp(lbt) * _betacf(a, b, x) / a
    return 1.0 - math.exp(lbt) * _betacf(b, a, 1 - x) / b


def gammq(a, x):
    """正则化上不完全 Gamma 函数 Q(a, x)。"""
    if x <= 0:
        return 1.0
    gln = math.lgamma(a)
    if x < a + 1:
        ap, s, d = a, 1.0 / a, 1.0 / a
        for _ in range(500):
            ap += 1
            d *= x / ap
            s += d
            if abs(d) < abs(s) * 3e-14:
                break
        return 1.0 - s * math.exp(-x + a * math.log(x) - gln)
    b = x + 1 - a
    c, d = 1e300, 1.0 / b
    h = d
    for i in range(1, 500):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        d = 1.0 / (d if abs(d) > 1e-300 else 1e-300)
        c = b + an / c if abs(b + an / c) > 1e-300 else 1e-300
        delta = d * c
        h *= delta
        if abs(delta - 1) < 3e-14:
            break
    return math.exp(-x + a * math.log(x) - gln) * h


def p_value(kind, stat, df1, df2=None):
    """双侧 p（F、χ² 本身单尾）。"""
    stat = abs(stat)
    if kind == "t":
        return betai(df1 / 2, 0.5, df1 / (df1 + stat * stat))
    if kind == "r":
        if stat >= 1:
            return 0.0
        t = stat * math.sqrt(df1 / (1 - stat * stat))
        return betai(df1 / 2, 0.5, df1 / (df1 + t * t))
    if kind == "F":
        return betai(df2 / 2, df1 / 2, df2 / (df2 + df1 * stat))
    if kind == "chi2":
        return gammq(df1 / 2, stat / 2)
    if kind == "z":
        return math.erfc(stat / math.sqrt(2))
    raise ValueError(kind)


# ---------------- 抽取 ----------------

NUM = r"[-−]?(?:\d+(?:\.\d+)?|\.\d+)"
P_PART = rf"[,;，；]\s*(?:\w+\s*=\s*{NUM}\s*[,;，；]\s*)?p\s*(=|<|>|≤|≥|<=|>=)\s*({NUM})"
PATTERNS = [
    ("t", re.compile(rf"\bt\s*\(\s*({NUM})\s*\)\s*=\s*({NUM})\s*{P_PART}", re.I)),
    ("F", re.compile(rf"\bF\s*\(\s*({NUM})\s*[,，]\s*({NUM})\s*\)\s*=\s*({NUM})\s*{P_PART}")),
    ("chi2", re.compile(rf"(?:χ\s*2|χ²|chi\s*-?\s*squared?|chi2|X2)\s*\(\s*({NUM})\s*(?:[,，]\s*N\s*=\s*\d+\s*)?\)\s*=\s*({NUM})\s*{P_PART}", re.I)),
    ("r", re.compile(rf"\br\s*\(\s*({NUM})\s*\)\s*=\s*({NUM})\s*{P_PART}")),
    ("z", re.compile(rf"\b[zZ]\s*=\s*({NUM})\s*{P_PART}")),
]
CI = re.compile(
    rf"(?P<est>\b(?:OR|RR|HR|β|b|B|d|g|M|Mdiff|MD|SMD|η²|r)\s*=\s*(?P<v>{NUM}))"
    rf"[^\[\]()]{{0,24}}?(?P<lvl>\d{{2}})\s*%\s*CI\s*[:：]?\s*[\[(]\s*(?P<lo>{NUM})\s*[,;，；]\s*(?P<hi>{NUM})\s*[\])]"
)


def fnum(text):
    return float(text.replace("−", "-"))


def decimals(text):
    text = text.replace("−", "").lstrip("-")
    return len(text.split(".")[1]) if "." in text else 0


def stat_range(kind, stat_text, df1, df2):
    """统计量按显示位数的舍入区间 → 对应的 p 区间（统计量越大 p 越小）。"""
    x = abs(fnum(stat_text))
    half = 0.5 * 10 ** (-decimals(stat_text))
    lo_stat, hi_stat = max(x - half, 0.0), x + half
    if kind == "r":
        hi_stat = min(hi_stat, 0.999999)
    return p_value(kind, hi_stat, df1, df2), p_value(kind, lo_stat, df1, df2)


def consistent(op, reported_text, p_lo, p_hi):
    rep = fnum(reported_text)
    half = 0.5 * 10 ** (-decimals(reported_text))
    if op == "=":
        return p_lo <= rep + half and p_hi >= rep - half
    if op in ("<", "≤", "<="):
        return p_lo < rep or (op != "<" and math.isclose(p_lo, rep))
    return p_hi > rep or (op != ">" and math.isclose(p_hi, rep))


def fmt_p(p):
    return "<.001" if p < 0.001 else f"{p:.3f}"


def scan(root, files=None):
    items = []
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
            if fenced or text.lstrip().startswith("<!--"):
                continue
            one_tailed = bool(re.search(r"one-?tailed|单侧", text, re.I))
            for kind, pat in PATTERNS:
                for m in pat.finditer(text):
                    g = m.groups()
                    if kind == "F":
                        df1, df2, stat, op, rep = fnum(g[0]), fnum(g[1]), g[2], g[3], g[4]
                    elif kind == "z":
                        df1, df2, stat, op, rep = None, None, g[0], g[1], g[2]
                    else:
                        df1, df2, stat, op, rep = fnum(g[0]), None, g[1], g[2], g[3]
                    quote = m.group(0).strip()
                    iid = f"STAT-{rel}-{no}-{m.start()}"
                    if (df1 is not None and df1 <= 0) or (df2 is not None and df2 <= 0):
                        items.append(C.item(CHECKER, iid, "stat_consistency", "blocked", f"自由度不合法：{quote}", rel, no, quote=quote))
                        continue
                    try:
                        p_lo, p_hi = stat_range(kind, stat, df1, df2)
                    except (ValueError, ZeroDivisionError, OverflowError):
                        items.append(C.item(CHECKER, iid, "stat_consistency", "needs_human", f"没能重算：{quote}", rel, no, quote=quote))
                        continue
                    detail = f"按统计量重算双侧 p 约 {fmt_p(p_lo)}–{fmt_p(p_hi)}"
                    if consistent(op, rep, p_lo, p_hi):
                        items.append(C.item(CHECKER, iid, "stat_consistency", "passed", f"p 值与统计量一致：{quote}", rel, no,
                                            quote=quote, detail=detail))
                    elif one_tailed and kind in ("t", "z", "r") and consistent(op, rep, p_lo / 2, p_hi / 2):
                        items.append(C.item(CHECKER, iid, "stat_consistency", "needs_human", f"按单侧检验才对得上：{quote}", rel, no,
                                            quote=quote, detail=detail + "；正文写了单侧，请确认是否预先设定"))
                    else:
                        flip = (fnum(rep) <= 0.05) != (p_lo <= 0.05)
                        items.append(C.item(CHECKER, iid, "stat_consistency", "blocked", f"p 值与统计量对不上：{quote}", rel, no,
                                            quote=quote, detail=detail + ("；显著性结论会因此改变" if flip else "") +
                                            "；若是单侧检验请在正文写明"))
            for m in CI.finditer(text):
                v, lo, hi = fnum(m["v"]), fnum(m["lo"]), fnum(m["hi"])
                quote = m.group(0).strip()
                iid = f"CI-{rel}-{no}-{m.start()}"
                if lo > hi:
                    items.append(C.item(CHECKER, iid, "ci_consistency", "blocked", f"置信区间下限大于上限：{quote}", rel, no, quote=quote))
                elif not (lo <= v <= hi):
                    items.append(C.item(CHECKER, iid, "ci_consistency", "blocked", f"估计值不在自己的置信区间里：{quote}", rel, no, quote=quote))
                else:
                    items.append(C.item(CHECKER, iid, "ci_consistency", "passed", f"估计值在置信区间内：{quote}", rel, no, quote=quote))
    return items


def main():
    C.utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=".", help="工作目录（manuscript/ 所在）")
    ap.add_argument("--files", nargs="*", help="要扫的文件（相对 --root，可带通配，如 analysis-report.md、chapters/*.md）；默认递归 manuscript/")
    args = ap.parse_args()
    root = Path(args.root).resolve()
    items = scan(root, args.files)
    if not items:
        items.append(C.item(CHECKER, "STAT-NONE", "stat_consistency", "needs_human",
                            "稿件里没认出 t / F / χ² / r / z 的完整报告（统计量、自由度、p 值）", (args.files or ["manuscript/"])[0],
                            detail="没有统计检验就忽略；有的话请按「t(28) = 2.20, p = .036」的完整格式报告"))
    out = C.write_items(root, "stat-check.jsonl", items)
    raise SystemExit(C.summary(items, out))


if __name__ == "__main__":
    main()
