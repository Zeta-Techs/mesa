#!/usr/bin/env python3
"""Markdown [@key] → Word docx with real Zotero ADDIN ZOTERO_ITEM fields.

Does not launch Zotero or Word. Unmatched keys fail closed (no docx).
Visible text never contains {Author, Year} temporary citations.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import secrets
import sys
from pathlib import Path

SCHEMA = "https://github.com/citation-style-language/schema/raw/master/csl-citation.json"

CSL_TYPE = {
    "article": "article-journal",
    "book": "book",
    "incollection": "chapter",
    "inproceedings": "paper-conference",
    "phdthesis": "thesis",
    "mastersthesis": "thesis",
    "techreport": "report",
}


def _load_sibling_or_endnote(mod_name: str, filename: str):
    here = Path(__file__).resolve()
    candidates = [
        here.parent / filename,
        here.parents[2] / "endnote-bridge" / "scripts" / filename,
    ]
    path = next((item for item in candidates if item.is_file()), candidates[-1])
    spec = importlib.util.spec_from_file_location(mod_name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_library_match():
    return _load_sibling_or_endnote("library_match", "library_match.py")


def load_cite():
    return _load_sibling_or_endnote("endnote_cite_docx", "cite_docx.py")


def load_bridge():
    return _load_sibling_or_endnote("endnote_bridge", "bridge.py")


def split_name(author: str) -> tuple[str, str]:
    name = (author or "").strip()
    if not name:
        return "", "Anon"
    if "," in name:
        family, given = name.split(",", 1)
        return given.strip(), family.strip() or "Anon"
    parts = name.split()
    if len(parts) == 1:
        return "", parts[0]
    return " ".join(parts[:-1]), parts[-1]


def csl_item(rec: dict, item_id: str | int, bridge=None) -> dict:
    names = []
    for author in rec.get("authors") or []:
        given, family = split_name(author)
        item = {"family": family}
        if given:
            item["given"] = given
        names.append(item)
    if not names:
        names = [{"family": "Anon"}]
    raw_title = rec.get("title") or ""
    title = bridge.rich_html(bridge.title_text(raw_title)) if bridge else raw_title
    journal = bridge.clean(rec.get("journal") or "") if bridge else (rec.get("journal") or "")
    item = {
        "id": item_id,
        "type": CSL_TYPE.get(rec.get("type", ""), "article-journal"),
        "title": title,
        "author": names,
    }
    if rec.get("year"):
        item["issued"] = {"date-parts": [[str(rec["year"])]]}
    if journal:
        item["container-title"] = journal
        if bridge:
            short, _alt = bridge.journal_abbreviations(rec)
            if short and short.casefold() != journal.casefold():
                item["container-title-short"] = short
                item["journalAbbreviation"] = short
    if rec.get("volume"):
        item["volume"] = rec["volume"]
    if rec.get("number"):
        item["issue"] = rec["number"]
    if rec.get("pages"):
        item["page"] = rec["pages"]
    if rec.get("doi"):
        item["DOI"] = rec["doi"]
    if rec.get("url"):
        item["URL"] = rec["url"]
    return item


def cite_id() -> str:
    # Zotero.Utilities.randomString 默认 8 位。没有这个 id，刷新会把每条都当成新引用。
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    return "".join(secrets.choice(alphabet) for _ in range(8))


def _embedded_uri(bib_key: str) -> str:
    """未绑上本机库（库没开、库里没有、或同一 DOI 在库里有多条）时的确定性内嵌题录 URI。
    Zotero Word 插件（integration.js loadItemData）的铁律（2026-11-15 Zotero 10 源码实证）：
    1. citationItems 绝不能是 []——空数组的域在点 Refresh 时会触发 Zotero.Integration.DELETE 把整篇引注删光，
       紧接着点 Add/Edit Bibliography 就报「执行本操作前您需要插入引注。」；
    2. uris 不可省略（缺 uris 访问 citationItem.uris.length 会抛 TypeError）；
    3. uri 必须符合 users/local/<key>/items/<key> 语法且不撞真实 8 位大写条目键（embed000 + 12 位小写 hex），
       使 getURIItem 干净返回 false 并回退到 itemData，同时靠同一 uri 在 embeddedItemsByURI 里跨处去重。"""
    digest = hashlib.sha256((bib_key or "").encode("utf-8")).hexdigest()[:12]
    return f"http://zotero.org/users/local/00000000/items/embed000{digest}"


def cite_instruction(group: list[dict], rec_nums: dict[str, int], display: str, bridge=None) -> str:
    items = []
    for rec in group:
        index = rec_nums[rec["id"]]
        uri = rec.get("_zotero_uri")
        if isinstance(uri, str) and uri.startswith("http://zotero.org/"):
            item_id = str(index)
            target_uri = uri
        else:
            # 未绑定条目用字符串前缀 id，防止数字 id 误撞 Zotero.Items.get(itemID) 里的无关本地条目
            item_id = f"embed-{rec['id']}"
            target_uri = _embedded_uri(rec["id"])
        items.append({
            "id": item_id,
            "uris": [target_uri],
            "itemData": csl_item(rec, item_id, bridge),
        })
    payload = {
        "citationID": cite_id(),
        "citationItems": items,
        "properties": {
            "formattedCitation": display,
            "plainCitation": display,
            "noteIndex": 0,
        },
        "schema": SCHEMA,
    }
    return " ADDIN ZOTERO_ITEM CSL_CITATION " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + " "


def write_report(path: Path, payload: dict):
    lines = [
        "# Zotero 域稿报告",
        "",
        f"- 源稿：`{payload['source']}`",
        f"- 引用处：{payload['spans']}",
        f"- 唯一键：{payload['unique']}",
        f"- 未匹配：{len(payload['missing'])}",
        f"- 插图：{payload.get('images', 0)}",
        f"- 缺图：{len(payload.get('missing_images') or [])}",
    ]
    if payload["missing"]:
        lines.append("")
        lines.append("未匹配键（未写 docx）：")
        for key in payload["missing"]:
            lines.append(f"- `{key}`")
        lines.append("")
        lines.append("补齐 references.bib 后重跑。")
    if payload.get("missing_images"):
        lines.append("")
        lines.append("正文插图找不到或读不出尺寸（未写 docx）：")
        for target in payload["missing_images"]:
            lines.append(f"- `{target}`")
    if payload.get("unmatched_braces"):
        lines.append("")
        lines.append("正文残留未解析花括号键（未写 docx）：")
        for hit in payload["unmatched_braces"]:
            lines.append(f"- `{hit}`")
    if not payload["missing"] and not payload.get("missing_images") and not payload.get("unmatched_braces"):
        lines.append("")
        if payload.get("caption_only"):
            lines.append("⚠ 下面这些文献只在图注或表题里引用。图注只写作者-年、不写引用域，Refresh 后它们进不了参考文献表。在正文里至少引用一次再重新生成：")
            lines.extend(f"- `{key}`" for key in payload["caption_only"])
            lines.append("")
        lines.append("打开 `output/zotero.docx` → Zotero 工具栏点 **Refresh**（**先确认 Zotero 应用已在运行再开文档**：首次打开若插件无响应，是宿主未就绪——等 Zotero 加载完，或关掉文档重开一次，文档本身没坏。首次会弹引用样式选择框，属正常，选一次即可）→ **光标点进 References 标题下面那个空行**（⚠ 必须是空行本身：点在标题行上会把参考文献表插到标题上方、还继承标题的大字号）→ 点 **Add/Edit Bibliography** 插入参考文献表 → 换样式用 Document Preferences。插错位置就 Ctrl+Z 撤销，光标点对再点一次。不要改源稿里的 `[@键]`。")
    binding = payload.get("binding") or []
    if binding:
        lines.append("")
        lines.append("## 库绑定")
        lines.extend(binding)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build Zotero-field docx from Markdown citations")
    parser.add_argument("--input", required=True)
    parser.add_argument("--bib", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--zotero-db", default="")
    parser.add_argument("--project-root", default="")
    args = parser.parse_args(argv)
    cite = load_cite()
    bridge = load_bridge()
    source = Path(args.input)
    bib_path = Path(args.bib)
    out = Path(args.output)
    report = Path(args.report)
    if out.resolve() == source.resolve() or out.suffix.lower() != ".docx":
        print("output must be a new .docx path", file=sys.stderr)
        return 1
    if not source.is_file() or not bib_path.is_file():
        print("source markdown or bib missing", file=sys.stderr)
        return 1
    records = {rec["id"]: rec for rec in bridge.load(bib_path) if rec.get("id")}
    # Refresh 前的可见文字做同年同姓消歧（(R. Zhang et al., 2026) / 2026a/b），与 endnote 域稿同口径
    cite.decorate_disambiguation(records)
    text = source.read_text(encoding="utf-8-sig")
    blocks = cite.split_blocks(text)
    cited: list[str] = []
    missing: list[str] = []
    rec_nums: dict[str, int] = {}
    preview_keys: list[str] = []
    for kind, body in blocks:
        if kind == "code":
            continue
        for match in cite.CITE_RE.finditer(body):
            for key in cite.parse_cite_keys(match.group(1)):
                if key not in preview_keys:
                    preview_keys.append(key)
        for _start, _end, key in cite.brace_keys(body):
            if key in records and key not in preview_keys:
                preview_keys.append(key)
    for key in preview_keys:
        if key in records:
            rec_nums[key] = len(rec_nums) + 1
    match = load_library_match()
    chosen = Path(args.zotero_db) if args.zotero_db else None
    binding = match.bind_zotero(records, list(rec_nums), chosen)
    # 库体检：旧版 Mesa 导出的脏记录会让重新导入的去重认不出、旧数据残留，
    # 参考文献表就会继续显示旧格式。只读检查；检出就给「先删再导」的处方。
    stale, stale_note = match.zotero_stale_items(chosen)
    if stale_note:
        binding.append(f"库体检未完成：{stale_note}")
    elif stale:
        binding.append(
            f"库体检：检出 {len(stale)} 条旧版导出的脏记录。不先删掉，"
            "重新导入时 Zotero 去重认不出，旧数据会残留："
        )
        binding.extend(f"- {h}" for h in stale)
        binding.append(
            "处方：在 Zotero 里按上面清单的标题删除这些条目，再点「同步到 Zotero」，"
            "然后重新生成本域稿再 Refresh。"
        )

    def field(group, numbers, display):
        # Zotero 的引文 JSON 写在 instrText 里，不写 fldData。
        return cite_instruction(group, numbers, display, bridge), ""

    cite.cite_field = field
    body_el, images, missing_images = cite.build_body(
        blocks, source.parent, records, rec_nums, cited, missing
    )
    children = list(body_el)
    insert_at = next((i for i, child in enumerate(children) if child.tag == cite.W + "sectPr"), len(children))
    body_el.insert(insert_at, cite.heading_paragraph("References"))
    # 不预置空的 ZOTERO_BIBL 域：Refresh 会把它删掉（2026-10-10 集成日志实证 removeCode）。
    # 留一个空段做插入锚点，人 Refresh 后点 Add/Edit Bibliography 让 Zotero 自己插域。
    body_el.insert(insert_at + 1, cite.w_el("p"))
    uniq_missing = sorted(set(missing))
    visible = cite.visible_text(body_el)
    unmatched_braces = sorted({m.group(0) for m in cite.RAW_HASH_BRACE.finditer(visible)})
    payload = {
        "source": str(source),
        "spans": len(cited),
        "unique": len(set(cited)),
        "missing": uniq_missing,
        "images": len(images),
        "missing_images": missing_images,
        "unmatched_braces": unmatched_braces,
        "caption_only": cite.caption_only_keys(rec_nums, cited),
        "binding": binding,
    }
    write_report(report, payload)
    if payload["caption_only"]:
        print("cited only in captions (not in bibliography after Refresh): " + ", ".join(payload["caption_only"]), file=sys.stderr)
    if uniq_missing:
        print("unmatched citation keys: " + ", ".join(uniq_missing), file=sys.stderr)
        return 1
    if missing_images:
        print("missing figures: " + ", ".join(missing_images), file=sys.stderr)
        return 1
    if unmatched_braces:
        print("visible text contains an unmatched brace key; refusing to write docx", file=sys.stderr)
        return 1
    cite.write_docx(out, body_el, images, cite.read_typeface(source, args.project_root))
    return 0


if __name__ == "__main__":
    sys.exit(main())
