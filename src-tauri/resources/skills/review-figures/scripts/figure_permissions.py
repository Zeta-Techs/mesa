#!/usr/bin/env python3
"""Write submission/figure-permissions.md: what the author must do before submission
for every panel cropped from someone else's paper.

Per panel: publisher, licence (looked up on Crossref by DOI), whether a reuse
permission request is needed, where to request it, a suggested credit line, and a
status column the author fills in. Also lists where to download the original figure
when the journal wants publisher originals.

Reads the same records as figure_sources.py (figures/figN.json + <panel>.json) and
references.bib. Network: one Crossref request per DOI; offline the licence is
written as unknown and the row defaults to "needs request".
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from figure_sources import PLACEHOLDERS, bib_entries, cite, panel_source, resolve_panel_path  # noqa: E402

UA = "Mesa/figure-permissions (mailto:support@mesa.local)"


def crossref(doi: str, timeout: float = 20.0) -> dict:
    """Crossref 记录里的出版社与许可。查不到返回空。"""
    url = "https://api.crossref.org/works/" + urllib.request.quote(doi, safe="/")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8")).get("message", {})
    except Exception:
        return {}


def licence(message: dict) -> tuple[str, str]:
    """(许可名, 链接)。只认正式版 / 未注明版本的许可；出版商的 TDM（文本挖掘）许可不是转载许可，不算。"""
    for item in message.get("license", []) or []:
        url = str(item.get("URL", ""))
        version = str(item.get("content-version", ""))
        if version == "tdm" or "tdm" in url.lower():
            continue
        m = re.search(r"creativecommons\.org/licenses/([a-z-]+)/(\d(?:\.\d)?)", url, re.I)
        if m:
            return f"CC {m.group(1).upper()} {m.group(2)}", url
        if "creativecommons.org/publicdomain" in url:
            return "CC0", url
    return "", ""


def decide(lic: str) -> tuple[str, str]:
    """(要不要申请, 状态默认值)"""
    if lic in ("CC0",) or re.fullmatch(r"CC BY \d(?:\.\d)?", lic):
        return "不用申请：按许可在图注写出处与许可名", "无需申请"
    if lic.startswith("CC BY"):
        return f"{lic} 带限制（非商业 / 禁止演绎）：改编或投商业期刊一般仍要申请，先看许可原文", "待申请"
    return "要申请：多数在文章页的 Request permissions / Rights and permissions（RightsLink）", "待申请"


def credit(lic: str, key: str, label: str, year: str, publisher: str) -> str:
    if lic and not lic.startswith("CC BY-N") and lic.startswith(("CC BY", "CC0")):
        return f"Adapted from {label} of [@{key}], licensed under {lic}."
    holder = f"Copyright {year} {publisher}." if publisher else "Copyright（年份与版权方按许可回执写）."
    return f"Adapted with permission from {label} of [@{key}]. {holder}"


def build(figures: Path, bib: Path, lookup=crossref) -> str:
    entries = bib_entries(bib.read_text(encoding="utf-8")) if bib.is_file() else {}
    cache: dict[str, dict] = {}
    rows = []
    for layout in sorted(figures.glob("fig*.json"), key=lambda p: int(re.sub(r"\D", "", p.stem) or 0)):
        try:
            data = json.loads(layout.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if not isinstance(data, dict) or not isinstance(data.get("panels"), list):
            continue
        n = re.sub(r"\D", "", layout.stem)
        for panel in data.get("panels", []):
            path = resolve_panel_path(figures, str(panel["source"]), layout.with_suffix(".png"))
            src = panel_source(path, figures)
            if src.get("self_drawn"):
                is_schem = src["self_drawn"] == "schematic"
                artifact = src.get("artifact", "")
                rows.append({
                    "figure": n,
                    "letter": panel["letter"],
                    "paper": "本综述自绘示意图（schematic-forge）" if is_schem else "本综述重绘数据图（figure-forge）",
                    "key": "",
                    "label": f"`{artifact}`" if artifact else "本综述自绘",
                    "doi": "",
                    "publisher": "—",
                    "licence": "作者自绘",
                    "need": (
                        "不用申请：本综述自绘示意图，图注注明 Summarized from [@键] 即可"
                        if is_schem
                        else "不用申请：基于公开文献数据重绘，图注注明 Data compiled from [@键] 即可"
                    ),
                    "credit": (
                        "Summarized from [@键].（无需 With permission）"
                        if is_schem
                        else "Data compiled from [@键1; @键2].（无需 With permission）"
                    ),
                    "status": "无需申请",
                    "self_drawn": True,
                })
                continue
            key = src.get("key", "")
            fields = entries.get(key, {})
            doi = fields.get("doi", "")
            doi = "" if doi in PLACEHOLDERS else doi
            if doi and doi not in cache:
                cache[doi] = lookup(doi)
            message = cache.get(doi, {})
            lic, lic_url = licence(message)
            need, status = decide(lic)
            publisher = str(message.get("publisher", "")) or "（未查到）"
            year = fields.get("year", "")
            label = src.get("label") or "（原图编号未记录）"
            rows.append({
                "figure": n, "letter": panel["letter"], "paper": cite(fields) if fields else f"（引文库里没有键 {key}）",
                "key": key, "label": label, "doi": doi, "publisher": publisher,
                "licence": f"[{lic}]({lic_url})" if lic else (
                    "非开放获取（Crossref 只登记了出版商自己的许可）" if message else ("没查到（联网失败）" if doi else "无 DOI，查不了")
                ),
                "need": need, "credit": credit(lic, key, label, year, publisher if message else ""), "status": status,
            })
    pending = sum(1 for r in rows if r["status"] == "待申请")
    own = sum(1 for r in rows if r.get("self_drawn"))
    oa = len(rows) - pending - own
    summary = (
        f"拼图共 {len(rows)} 块，其中 {pending} 块要向出版社申请转载许可，{oa} 块按开放获取许可注明出处即可"
        + (f"，{own} 块为本综述自绘/重绘（无需申请）。" if own else "。")
    )
    lines = [
        "# 换原图与转载许可",
        "",
        summary + "许可只能由作者本人申请；Mesa 和 AI 只做这张清单。",
        "",
        "**怎么用**：",
        "1. 要申请的块：点 DOI 打开文章页，找 Request permissions / Rights and permissions（多数出版社走 RightsLink；用途选在期刊综述里改编使用图片），逐篇提交；"
        "同一篇里的几块可以合在一次申请里写清图号。拿到许可后把「状态」改成「已获许可」，并按回执要求改「图注出处」。",
        "2. 期刊要求用出版社原图时：按「原图」一列在文章页下载高清原图，放进项目根 `papers/figure-originals/`，文件名用「来源键-原图编号」（如 `zotero1dggi6cje-fig2.jpg`，来源键见 figures/sources.md 每行末尾的 [@键]），"
        "然后回到这一步的对话说一声，AI 会按 figures/sources.md 记的同一块从原图重裁重拼。",
        "3. 「状态」可写：待申请 / 已申请 / 已获许可 / 无需申请。全部办完，在流程线上勾掉「换原图与申请转载许可」。",
        "",
        "许可由 Crossref 按 DOI 查得（出版商的文本挖掘许可不算转载许可）；查不到的按要申请处理，以文章页写的为准。",
        "",
        "| 图 | 原文 | 原图 | 出版社 | 许可 | 要不要申请 | 图注出处 | 状态 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        doi = f" [DOI](https://doi.org/{r['doi']})" if r["doi"] else ""
        lines.append(
            f"| {r['figure']}({r['letter']}) | {r['paper']}{doi} | {r['label']} | {r['publisher']} | {r['licence']} | {r['need']} | {r['credit']} | {r['status']} |"
        )
    if not rows:
        lines.append("| — | 没有拼图记录（figures/figN.json）：没有从别人论文里裁的图，或者拼板没跑。 | | | | | | 无需申请 |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--figures", type=Path, default=Path("figures"))
    p.add_argument("--bib", type=Path, default=Path("references.bib"))
    p.add_argument("--out", type=Path, default=Path("submission/figure-permissions.md"))
    p.add_argument("--offline", action="store_true", help="不联网查许可，全部按要申请写")
    a = p.parse_args(argv)
    text = build(a.figures, a.bib, (lambda doi: {}) if a.offline else crossref)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(text, encoding="utf-8")
    print(a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
