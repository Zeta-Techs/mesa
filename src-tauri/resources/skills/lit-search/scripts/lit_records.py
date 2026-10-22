#!/usr/bin/env python3
"""检索步与精读步的题录固定脚本：补字段、开放获取、出清单与两份 RIS、校验、写引文库。

papers/included.json 是唯一的题录来源。补字段（enrich）把 Crossref / OpenAlex / ISO 4 缩写一次写进 json；
清单与 RIS（write）只从 json 生成，不再联网；引文库（bib）也从 json 取，精读步不再另查一遍。
同一份 json 进 to-fetch.ris、endnote-import.ris、references.bib，再经 Mesa 同步进 Zotero / EndNote——
这几处拼法与 Mesa 界面「纳入」时追加 RIS 的那一份（src/screening-review.ts risBody）逐条一致。

用法（Windows 上把 python3 换成 python）：
  python3 lit_records.py enrich --json papers/included.json
  python3 lit_records.py fetch  --json papers/included.json --root <项目根> [--allow-preprint]
  python3 lit_records.py write  --json papers/included.json --root <项目根>
  python3 lit_records.py check  --json papers/included.json --root <项目根>
  python3 lit_records.py bib    --json papers/included.json --bib references.bib

接口缓存在系统临时目录 mesa-lit-cache/（--cache 可改），重跑不重复联网；--refresh 忽略缓存，--offline 只读缓存。
"""
import argparse
import concurrent.futures
import csv
import hashlib
import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PLACEHOLDER = "待补"
# Crossref 有这篇的正式记录、但它没有期号（Appl. Catal. B、Chin. J. Catal. 等只按卷编排）：
# 不是缺口，标「无期号」免得人去补一个不存在的值；和「待补」「待核」一样不进 RIS / 引文库
NO_ISSUE = "无期号"
NOT_VALUES = (PLACEHOLDER, "待核", NO_ISSUE)
# included.json 每条的题录字段（顺序即写回顺序）。查不到的写「待补」，不留空、不猜
FIELDS = (
    "authors", "year", "venue", "volume", "issue", "pages", "date", "epubDate", "articleType",
    "issn", "journalAbbreviation", "abstract", "keywords", "language", "doi", "url",
)
HEAD = ("id", "title", "decision", "reason")
DECISIONS = ("included", "pending", "excluded")
# 预印本服务器：托管处是它们的版本一律算预印本（OpenAlex 会把 Research Square 标成 acceptedVersion）
PREPRINT_HOSTS = (
    "arxiv.org", "researchsquare.com", "biorxiv.org", "medrxiv.org", "chemrxiv.org", "ssrn.com",
    "preprints.org", "authorea.com", "techrxiv.org", "osf.io", "engrxiv.org", "eartharxiv.org",
    "essoar.org", "scielo.org/preprints", "jxiv.jst.go.jp", "chinaxiv.org", "sciencecast.org",
)
PREPRINT_NAMES = (
    "arxiv", "research square", "biorxiv", "medrxiv", "chemrxiv", "ssrn", "preprints.org", "authorea",
    "techrxiv", "osf preprints", "engrxiv", "eartharxiv", "essoar", "scielo preprints", "jxiv", "chinaxiv",
)
CRLF = "\r\n"
TTL_SECONDS = 30 * 24 * 3600


def utf8_stdio():
    # Windows 管道默认按系统代码页（中文系统 GBK）编码，打印 Č、² 直接 UnicodeEncodeError
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def load_bridge():
    """endnote-bridge 的 bridge.py：清洗化学式、Crossref/OpenAlex 取字段、ISO 4 缩写、BibTeX 解析与渲染。
    随包时 Mesa 把它放在本脚本旁边；在仓库里直接跑时取 endnote-bridge 那一份（同一个文件）。"""
    here = Path(__file__).resolve()
    for path in (here.parent / "bridge.py", here.parents[2] / "endnote-bridge" / "scripts" / "bridge.py"):
        if path.is_file():
            spec = importlib.util.spec_from_file_location("mesa_bridge", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise FileNotFoundError("找不到 bridge.py（应与本脚本同目录）。在技能页更新 lit-search 技能后再试")


B = load_bridge()


def mesa_abbreviations():
    """Mesa 兜底缩写表：随包在本脚本旁边；仓库里在 src-tauri/resources/。"""
    here = Path(__file__).resolve()
    table = {}
    for path in (here.parent / "journal-abbreviations.csv", here.parents[3] / "journal-abbreviations.csv"):
        if not path.is_file():
            continue
        for row in csv.reader(path.read_text(encoding="utf-8").splitlines()):
            if not row or row[0].strip().startswith("#") or len(row) < 2:
                continue
            key = B._journal_key(row[0])
            short = B.clean(row[1])
            if key and short:
                table[key] = short
        break
    return table


# ---------- 带缓存的网络层（替换 bridge 的 http_json / http_text，字段映射照用 bridge 的） ----------

class Net:
    cache = Path(tempfile.gettempdir()) / "mesa-lit-cache"
    refresh = False
    offline = False
    lock = threading.Lock()
    calls = 0
    hits = 0


def _cache_path(url):
    return Net.cache / (hashlib.sha1(url.encode("utf-8")).hexdigest() + ".body")


def _fetch(url, accept, timeout=40, attempts=3):
    path = _cache_path(url)
    if not Net.refresh and path.is_file() and time.time() - path.stat().st_mtime < TTL_SECONDS:
        with Net.lock:
            Net.hits += 1
        return path.read_bytes()
    if Net.offline:
        raise urllib.error.URLError("offline: 缓存里没有 " + url)
    last = None
    for i in range(attempts):
        req = urllib.request.Request(url, headers={
            "User-Agent": "MesaLitRecords/1.0 (literature review; mailto:local)",
            "Accept": accept,
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
            with Net.lock:
                Net.calls += 1
            Net.cache.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp%d" % threading.get_ident())
            tmp.write_bytes(body)
            os.replace(tmp, path)
            return body
        except urllib.error.HTTPError as err:
            last = err
            # 404 是「没这条」，缓存成空省得重跑再问
            if err.code == 404:
                Net.cache.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"")
                return b""
            if err.code in (429, 500, 502, 503, 504) and i + 1 < attempts:
                time.sleep(1.5 * (i + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as err:
            last = err
            if i + 1 < attempts:
                time.sleep(1.5 * (i + 1))
    raise last


def http_json(url, timeout=40, attempts=3):
    body = _fetch(url, "application/json", timeout, attempts)
    if not body:
        return {}
    return json.loads(body.decode("utf-8"))


_dead_hosts = set()


def http_text(url, timeout=40, attempts=3):
    # JabRef 缩写表在 GitHub Pages 上，国内常连不上：一张表连不上就不再试其余几张（缓存 30 天，下次直接用）
    host = urllib.parse.urlparse(url).netloc
    if host in _dead_hosts:
        raise urllib.error.URLError("上一张表已连不上，跳过 " + host)
    try:
        return _fetch(url, "text/plain, text/csv, application/xml", min(timeout, 20), 1).decode("utf-8", "replace")
    except Exception:
        _dead_hosts.add(host)
        raise


B.http_json = http_json
B.http_text = http_text


# ---------- 字段工具 ----------

def meaningful(value):
    if value is None:
        return False
    if isinstance(value, list):
        return any(meaningful(v) for v in value)
    text = str(value).strip()
    return bool(text) and text.casefold() not in ("none", "null", "nan", "n/a", *NOT_VALUES)


def as_text(value):
    if value is None:
        return ""
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return "; ".join(as_text(v) for v in value if meaningful(v))
    return str(value).strip()


def bare_doi(value):
    text = B.plain_id(value or "")
    m = re.search(r"10\.\d{4,9}/[^\s\"<>]+", text)
    return m.group(0).rstrip(".,;)").lower() if m else ""


def record_doi(rec):
    for key in ("doi", "url", "id"):
        doi = bare_doi(as_text(rec.get(key)))
        if doi:
            return doi
    return ""


def author_list(value):
    """作者统一成数组，每人「姓, 名」。字符串按「;」或 and 拆；无逗号的「名 姓」翻成「姓, 名」。"""
    if isinstance(value, list):
        names = [as_text(v) for v in value]
    else:
        text = as_text(value)
        if not meaningful(text):
            return []
        names = re.split(r"\s*;\s*|\s+and\s+", text)
    out, seen = [], set()
    for name in names:
        name = " ".join(B.clean(name).split())
        if not meaningful(name):
            continue
        name = B.family_comma(name)
        key = re.sub(r"\W+", "", name.casefold())
        if key and key not in seen:  # 同一人写两次只留一次
            seen.add(key)
            out.append(name)
    return out


def keyword_list(value):
    if isinstance(value, list):
        items = [as_text(v) for v in value]
    else:
        items = re.split(r"[;；]", as_text(value))
    out, seen = [], set()
    for item in items:
        # 关键词不做化学式美化：DFT-D3、2H-MoS2 这类是方法名 / 写法本身
        item = " ".join(item.split())
        if meaningful(item) and item.casefold() not in seen:
            seen.add(item.casefold())
            out.append(item)
    return out


def tidy_abstract(text):
    """Crossref 的 JATS 摘要常带开头的「Abstract」小标题、结尾的图形摘要残字「image」。"""
    text = B.clean(text)
    # ACS 的图形摘要残字在开头；JATS 的「Abstract」小标题剥掉标签后会和正文粘在一起（AbstractThe …）
    text = re.sub(r"^High Resolution Image Download MS PowerPoint Slide\s*", "", text)
    text = re.sub(r"^(?:Abstract|ABSTRACT|Summary|SUMMARY|Graphical [Aa]bstract)(?:\s*[:.]\s*|\s+|(?=[A-Z]))", "", text)
    text = re.sub(r"\s+(?:image|Image|graphic|Graphical abstract)\s*$", "", text)
    return text.strip()


def unabbreviable(venue):
    """一词刊名（Nature、Small）与全是缩略词 / 短词的刊名（JACS Au）在 ISO 4 里不缩，缩写就是全称"""
    words = venue.split()
    return len(words) == 1 or all(w.isupper() or len(w) <= 3 for w in words)


def journal_abbreviation(venue, current, mesa):
    """ISO 4 缩写：JabRef 公开表 → Mesa 兜底表；一词刊名就写全称；原有值带句点且不等于全称才保留。都没有写待补。"""
    if not meaningful(venue):
        return PLACEHOLDER
    key = B._journal_key(venue)
    short = mesa.get(key) or ""
    if not short:
        try:
            short = B.iso4_abbreviation(venue)
        except Exception:
            short = ""
    if short:
        return short
    if unabbreviable(venue):
        return venue
    cur = as_text(current)
    if meaningful(cur) and "." in cur and cur.casefold() != venue.casefold():
        return cur
    return PLACEHOLDER


def is_preprint_location(loc):
    url = (loc.get("pdf_url") or loc.get("landing_page_url") or "").lower()
    source = loc.get("source") or {}
    name = (source.get("display_name") or "").lower()
    host = (source.get("host_organization_name") or "").lower()
    if any(h in url for h in PREPRINT_HOSTS):
        return True
    return any(n in name or n in host for n in PREPRINT_NAMES)


# ---------- json 读写 ----------

def read_records(path):
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if isinstance(data, dict):
        for key in ("items", "records", "rows"):
            if isinstance(data.get(key), list):
                return data[key]
        raise ValueError("included.json 应是数组")
    if not isinstance(data, list):
        raise ValueError("included.json 应是数组")
    return data


def write_json(path, records):
    ordered = []
    for rec in records:
        row = {k: rec[k] for k in HEAD if k in rec}
        for k in FIELDS:
            if k in rec:
                row[k] = rec[k]
        for k, v in rec.items():
            if k not in row:
                row[k] = v
        ordered.append(row)
    atomic_write(Path(path), json.dumps(ordered, ensure_ascii=False, indent=2) + "\n")


def atomic_write(path, text, newline="\n"):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8", newline=newline) as handle:
        handle.write(text)
    os.replace(tmp, path)


def decision_of(rec):
    d = as_text(rec.get("decision")).lower()
    return {"include": "included", "exclude": "excluded"}.get(d, d)


def project_root(arg):
    """--root 优先；没给就读当前目录 TASK.md 里的「项目根：`…`」。都没有用当前目录。"""
    if arg:
        return Path(arg)
    task = Path("TASK.md")
    if task.is_file():
        m = re.search(r"项目根：`([^`]+)`", task.read_text(encoding="utf-8", errors="replace"))
        if m:
            return Path(m.group(1))
    return Path.cwd()


# ---------- enrich ----------

def enrich_one(rec, mesa):
    """一条记录补齐。返回 (记录, 说明列表)。有 DOI：Crossref 为准，OpenAlex 补摘要/关键词/语言。"""
    notes = []
    out = dict(rec)
    doi = record_doi(rec)
    cr, oa = {}, {}
    if doi:
        try:
            cr = B.crossref_fill(doi)
        except Exception as err:
            notes.append(f"Crossref 没取到（{type(err).__name__}）")
        # 关键词只用 OpenAlex 的论文关键词（Crossref 的 subject 是期刊分类，不是这篇的关键词），所以每条都问一次
        try:
            oa = B.openalex_fill(doi)
        except Exception as err:
            notes.append(f"OpenAlex 没取到（{type(err).__name__}）")
        if cr.get("articleType") == "Preprint":
            notes.append("Crossref 登记为预印本（posted-content）")

    def pick(*values):
        for v in values:
            if meaningful(v):
                return v
        return None

    title = pick(cr.get("title"), rec.get("title"))
    out["title"] = B.clean(as_text(title)) if title else as_text(rec.get("title"))
    authors = author_list(cr.get("authors") or [])
    oa_authors = author_list(oa.get("authors") or [])
    if len(authors) < 2 and len(oa_authors) > len(authors):
        authors = oa_authors
    if not authors:
        authors = author_list(rec.get("authors"))
    out["authors"] = authors or [PLACEHOLDER]
    out["year"] = as_text(pick(cr.get("year"), oa.get("year"), rec.get("year"))) or PLACEHOLDER
    venue = pick(cr.get("journal"), rec.get("venue"), rec.get("source"), rec.get("journal"), oa.get("journal"))
    out["venue"] = B.clean(as_text(venue)) if venue else PLACEHOLDER
    out["volume"] = B.plain_id(as_text(pick(cr.get("volume"), oa.get("volume"), rec.get("volume")))) or PLACEHOLDER
    issue = B.plain_id(as_text(pick(cr.get("number"), oa.get("number"), rec.get("issue"))))
    # 正式记录有卷没期：这本刊不分期，不是查不到
    no_issue = (bool(cr) and cr.get("articleType") != "Preprint" and meaningful(out["volume"])) or as_text(rec.get("issue")) == NO_ISSUE
    out["issue"] = issue or (NO_ISSUE if no_issue else PLACEHOLDER)
    pages = as_text(pick(cr.get("pages"), oa.get("pages"), rec.get("pages")))
    out["pages"] = B.plain_id(pages.replace("–", "-").replace("—", "-")) or PLACEHOLDER
    if cr:
        out["date"] = as_text(cr.get("date")) or as_text(pick(rec.get("date"))) or PLACEHOLDER
        out["epubDate"] = as_text(cr.get("epubDate")) or PLACEHOLDER
        out["articleType"] = as_text(cr.get("articleType")) or as_text(pick(rec.get("articleType"))) or PLACEHOLDER
    else:
        out["date"] = as_text(pick(rec.get("date"))) or PLACEHOLDER
        out["epubDate"] = as_text(pick(rec.get("epubDate"))) or PLACEHOLDER
        out["articleType"] = as_text(pick(rec.get("articleType"))) or PLACEHOLDER
    out["issn"] = B.plain_id(as_text(pick(cr.get("issn"), oa.get("issn"), rec.get("issn")))) or PLACEHOLDER
    abstract = pick(cr.get("abstract"), oa.get("abstract"), rec.get("abstract"))
    out["abstract"] = tidy_abstract(as_text(abstract)) if abstract else PLACEHOLDER
    keywords = keyword_list(oa.get("keywords") or []) or keyword_list(rec.get("keywords"))
    out["keywords"] = keywords or PLACEHOLDER
    out["language"] = as_text(pick(cr.get("language"), oa.get("language"), rec.get("language"))) or PLACEHOLDER
    final_doi = bare_doi(cr.get("doi")) or doi
    out["doi"] = final_doi or PLACEHOLDER
    out["url"] = f"https://doi.org/{final_doi}" if final_doi else (as_text(pick(rec.get("url"))) or PLACEHOLDER)
    out["journalAbbreviation"] = journal_abbreviation(out["venue"] if out["venue"] != PLACEHOLDER else "", rec.get("journalAbbreviation"), mesa)
    if not doi:
        notes.append("没有 DOI，题录只按原记录整理")
    missing = [k for k in FIELDS if not meaningful(out.get(k)) and k != "epubDate" and out.get(k) != NO_ISSUE]
    if missing:
        notes.append("待补：" + "、".join(missing))
    return out, notes


def cmd_enrich(args):
    path = Path(args.json)
    records = read_records(path)
    mesa = mesa_abbreviations()
    # 先把 ISO 4 表拉齐（bridge 的索引是进程级单例，并发里第一次建会互相覆盖）
    try:
        B.iso4_index()
    except Exception:
        pass
    targets = [i for i, r in enumerate(records) if decision_of(r) in ("included", "pending")]
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(enrich_one, records[i], mesa): i for i in targets}
        for fut in concurrent.futures.as_completed(futures):
            results[futures[fut]] = fut.result()
    lines = []
    for i in targets:
        rec, notes = results[i]
        records[i] = rec
        if notes:
            lines.append(f"- {rec.get('id') or i + 1}｜{as_text(rec.get('title'))[:60]}：{'；'.join(notes)}")
    for i, rec in enumerate(records):
        if decision_of(rec) == "excluded":
            continue
        if not as_text(rec.get("id")):
            doi = record_doi(rec)
            rec["id"] = f"doi:{doi}" if doi else "rec-" + hashlib.sha1(as_text(rec.get("title")).casefold().encode()).hexdigest()[:10]
            lines.append(f"- 第 {i + 1} 条没有 id，已按 DOI/标题补成 {rec['id']}")
    write_json(path, records)
    abbr_missing = sorted({as_text(records[i].get("venue")) for i in targets if records[i].get("journalAbbreviation") == PLACEHOLDER and meaningful(records[i].get("venue"))})
    print(f"补字段：纳入与待确认 {len(targets)} 条；联网 {Net.calls} 次，缓存命中 {Net.hits} 次。排除的不补。")
    if abbr_missing:
        print("期刊缩写待补（JabRef 表与 Mesa 兜底表都没有，按期刊官网或 ISO 4 补进 journalAbbreviation，每个缩写词后加句点）：")
        for name in abbr_missing:
            print(f"  - {name}")
    if lines:
        print("逐条说明：")
        print("\n".join(lines))
    return 0


# ---------- fetch（开放获取） ----------

def ascii_fold(text):
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")


STOP = {"a", "an", "the", "of", "for", "and", "in", "on", "with", "to", "by", "via", "toward", "towards", "from", "at", "as"}


def pdf_name(rec):
    """作者年份-短标题.pdf：第一作者的姓 + 年份 + 标题前几个实词。只用 ASCII，跨平台都能落盘。"""
    authors = rec.get("authors") if isinstance(rec.get("authors"), list) else author_list(rec.get("authors"))
    family = ""
    if authors and meaningful(authors[0]):
        family = re.sub(r"[^A-Za-z]", "", ascii_fold(authors[0].split(",")[0]))
    year = as_text(rec.get("year")) if meaningful(rec.get("year")) else ""
    words = [w for w in re.split(r"[^A-Za-z0-9]+", ascii_fold(as_text(rec.get("title")))) if w]
    picked = [w for w in words if w.lower() not in STOP][:6] or words[:6]
    stem = f"{family or 'Anon'}{year}-" + "-".join(picked)
    return stem[:80].rstrip("-") + ".pdf"


def oa_candidates(doi, allow_preprint):
    work = B.http_json("https://api.openalex.org/works/doi:" + urllib.parse.quote(doi))
    if not isinstance(work, dict) or not work:
        return []
    locs = []
    seen = set()
    for loc in [work.get("best_oa_location") or {}] + (work.get("locations") or []):
        url = loc.get("pdf_url")
        if not url or url in seen:
            continue
        seen.add(url)
        version = loc.get("version") or ""
        preprint = is_preprint_location(loc) or version == "submittedVersion"
        if preprint and not allow_preprint:
            continue
        rank = {"publishedVersion": 0, "acceptedVersion": 1}.get(version, 2)
        locs.append((rank, url))
    locs.sort(key=lambda x: x[0])
    return [u for _, u in locs]


class Forbidden(Exception):
    pass


def _curl_body(url, tmp):
    """优先 curl：Nature、Springer 对 Python urllib 的连接回「Client Challenge」页，同样的请求 curl 拿得到 PDF
    （2026-10-22 实测）。系统没有 curl 返回 None，交给 urllib。"""
    import shutil
    import subprocess
    curl = shutil.which("curl")
    if not curl:
        return None
    try:
        out = subprocess.run(
            [curl, "-sL", "--max-time", "180", "-A", "Mozilla/5.0", "-H", "Accept: application/pdf,*/*;q=0.8",
             "-o", str(tmp), "-w", "%{http_code}", url],
            capture_output=True, text=True, timeout=200,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    code = out.stdout.strip()[-3:]
    if code == "403":
        raise Forbidden()
    if out.returncode != 0 or not tmp.is_file():
        return None
    return tmp.read_bytes()


def download_pdf(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    try:
        body = _curl_body(url, tmp)
        if body is None or b"%PDF-" not in body[:1024]:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/pdf,*/*;q=0.8"})
            try:
                with urllib.request.urlopen(req, timeout=90) as resp:
                    alt = resp.read(200 * 1024 * 1024 + 1)
            except urllib.error.HTTPError as err:
                if err.code == 403:
                    raise Forbidden() from err
                raise
            if b"%PDF-" in alt[:1024]:
                body = alt
        if body is None or b"%PDF-" not in body[:1024]:
            raise ValueError("拿到的不是 PDF（多半是登录页或验证页）")
        tmp.write_bytes(body)
        os.replace(tmp, dest)
    finally:
        if tmp.exists():
            tmp.unlink()


def _words(text):
    return [w for w in re.split(r"[^a-z0-9]+", ascii_fold(text).lower()) if w]


def existing_pdf(rec, root):
    """这篇在项目根 papers/ 里已有的 PDF：json 的 pdf 字段 → 本脚本的命名 → 文件名带 DOI →
    文件名去掉「作者年份-」后每个词都出现在标题里（人或上一轮按「作者年份-短标题」起的名字）。都对不上返回空。"""
    rel = as_text(rec.get("pdf"))
    if rel and (root / rel).is_file():
        return rel.replace("\\", "/")
    papers = root / "papers"
    name = pdf_name(rec)
    if (papers / name).is_file():
        return f"papers/{name}"
    if not papers.is_dir():
        return ""
    doi = record_doi(rec)
    title_words = _words(as_text(rec.get("title")))
    title = set(title_words)
    # 文件名里的缩写（HER = hydrogen evolution reaction）按标题里连着几个词的首字母认
    for i in range(len(title_words)):
        for n in range(2, 6):
            if i + n <= len(title_words):
                title.add("".join(w[0] for w in title_words[i:i + n]))
    for pdf in sorted(papers.glob("*.pdf")):
        stem = pdf.stem.lower()
        if doi and (doi in stem or doi.replace("/", "_") in stem or doi.replace("/", "-") in stem):
            return f"papers/{pdf.name}"
        words = _words(re.sub(r"^[A-Za-z]+\d{4}[a-z]?-", "", pdf.stem))
        if len(words) >= 3 and sum(len(w) for w in words) >= 12 and all(w in title for w in words):
            return f"papers/{pdf.name}"
    # 文件名对不上（Ru-based 这类元素缩写、出版商编号名）：PDF 开头的元数据里多半写着 DOI
    if doi:
        needle = doi.encode("ascii", "ignore")
        for pdf in sorted(papers.glob("*.pdf")):
            try:
                with pdf.open("rb") as handle:
                    head = handle.read(256 * 1024).lower()
            except OSError:
                continue
            if needle and needle in head:
                return f"papers/{pdf.name}"
    return ""


def cmd_fetch(args):
    path = Path(args.json)
    root = project_root(args.root)
    records = read_records(path)
    taken = {p.name.lower() for p in (root / "papers").glob("*.pdf")} if (root / "papers").is_dir() else set()
    report, forbidden = [], 0
    stopped = False
    for rec in records:
        if decision_of(rec) != "included":
            continue  # 待确认的不下全文，等人拍板
        have = existing_pdf(rec, root)
        if have:
            rec["pdf"] = have
            continue
        rec.pop("pdf", None)
        doi = record_doi(rec)
        if stopped or not doi:
            report.append(f"- 未下：{as_text(rec.get('title'))[:60]}（{'连续 403 已停' if stopped else '没有 DOI'}）")
            continue
        try:
            urls = oa_candidates(doi, args.allow_preprint)
        except Exception as err:
            report.append(f"- 未下：{doi}（OpenAlex 没取到：{type(err).__name__}）")
            continue
        if not urls:
            report.append(f"- 付费墙：{doi}（接口没给{'' if args.allow_preprint else '正式版或已录用稿的'} PDF 直链）")
            continue
        name = pdf_name(rec)
        base, n = name[:-4], 2
        while name.lower() in taken:
            name = f"{base}-{n}.pdf"
            n += 1
        dest = root / "papers" / name
        ok, refused = False, False
        for url in urls[:2]:
            try:
                download_pdf(url, dest)
                ok = True
                break
            except Forbidden:
                refused = True
                report.append(f"- 下载失败：{doi} ← {url}（HTTP 403）")
            except Exception as err:
                report.append(f"- 下载失败：{doi} ← {url}（{err}）")
        # 「连续 3 次 403」按篇数：这篇两条链都被拒才算一次，有一篇成功或别的原因失败就重新数
        forbidden = forbidden + 1 if (refused and not ok) else 0
        if forbidden >= 3:
            stopped = True
        if ok:
            taken.add(name.lower())
            rec["pdf"] = f"papers/{name}"
            report.append(f"- 已下：papers/{name}")
    write_json(path, records)
    got = sum(1 for r in records if decision_of(r) == "included" and as_text(r.get("pdf")))
    total = sum(1 for r in records if decision_of(r) == "included")
    print(f"开放获取：已纳入 {total} 篇，有全文 {got} 篇，其余进 to-fetch。{'连续 3 次 403，已停止其余下载。' if stopped else ''}")
    print("\n".join(report))
    return 0


# ---------- write（清单与两份 RIS；与 src/screening-review.ts 的 risBody / includedMdLine 同一拼法） ----------

def ris_value(value):
    return re.sub(r"\s+", " ", as_text(value).replace("\r", " ").replace("\n", " ")).strip()


def ris_text(value):
    # json 里的标题、摘要在补字段时已经按 bridge.clean 收好上下标；这里不再美化，同一份 json 出几次 RIS 都一样
    return ris_value(value)


def push(lines, tag, value):
    text = ris_value(value)
    if text and text not in NOT_VALUES:
        lines.append(f"{tag}  - {text}")


def ris_block(rec, target):
    lines = ["TY  - JOUR"]
    for author in author_list(rec.get("authors")):
        lines.append(f"AU  - {ris_value(author)}")
    push(lines, "TI", ris_text(rec.get("title")))
    journal = ris_value(rec.get("venue") or rec.get("source") or rec.get("journal"))
    if journal and journal not in NOT_VALUES:
        lines.append(f"T2  - {journal}")
    short = ris_value(rec.get("journalAbbreviation"))
    if short and short not in NOT_VALUES and short.lower() != journal.lower():
        lines.append(f"J2  - {short}")
    push(lines, "PY", rec.get("year"))
    if target == "endnote":
        push(lines, "DA", rec.get("date"))
        push(lines, "ET", rec.get("epubDate"))
    push(lines, "VL", rec.get("volume"))
    push(lines, "IS", rec.get("issue"))
    pages = ris_value(rec.get("pages"))
    if pages not in NOT_VALUES:
        parts = [p.strip() for p in re.split(r"-+", re.sub(r"[–—−]", "-", pages), maxsplit=1)] if pages else []
        if parts and parts[0]:
            lines.append(f"SP  - {parts[0]}")
            if target == "endnote":
                lines.append(f"M2  - {parts[0]}")
        if len(parts) > 1 and parts[1] and parts[1] != parts[0]:
            lines.append(f"EP  - {parts[1]}")
    if target == "endnote":
        kind = ris_value(rec.get("articleType"))
        push(lines, "M3", kind if meaningful(kind) else "Journal Article")
    push(lines, "SN", rec.get("issn"))
    doi = record_doi(rec)
    if doi:
        lines.append(f"DO  - {doi}")
    for word in keyword_list(rec.get("keywords")):
        lines.append(f"KW  - {word}")
    push(lines, "AB", ris_text(rec.get("abstract")))
    if target == "endnote":
        push(lines, "LA", rec.get("language"))
    url = ris_value(rec.get("url"))
    if not meaningful(url):
        url = f"https://doi.org/{doi}" if doi else ""
    if url:
        lines.append(f"UR  - {url}")
    lines.append("ER  - ")
    return CRLF.join(lines)


def ris_file(records, target):
    blocks = [ris_block(r, target) for r in records]
    return (CRLF + CRLF).join(blocks) + CRLF if blocks else ""


def short_authors(authors, keep=3):
    names = author_list(authors)
    if not names:
        return ""
    if len(names) <= keep:
        return "; ".join(names)
    return f"{'; '.join(names[:keep])} 等 {len(names)} 人"


def md_line(rec):
    who = ", ".join(x for x in (short_authors(rec.get("authors")), as_text(rec.get("year")) if meaningful(rec.get("year")) else "") if x)
    venue = as_text(rec.get("venue")) if meaningful(rec.get("venue")) else ""
    doi = record_doi(rec)
    tail = as_text(rec.get("url")) if meaningful(rec.get("url")) else (f"https://doi.org/{doi}" if doi else as_text(rec.get("id")))
    return " — ".join(x for x in (ris_value(rec.get("title")), who, venue, tail) if x)


def read_previous_fetch(path):
    """已有 to-fetch.md 的编号与勾选：编号不重排，补到全文的保留「✓」。"""
    order = []
    if not path.is_file():
        return order
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"\s*(\d+)\.\s+(✓\s*)?(.*)$", line)
        if m:
            order.append((int(m.group(1)), bool(m.group(2)), m.group(3)))
    return order


def fetch_list(records, root, previous):
    """待获取：已纳入且没有全文的。上一版里有的按原编号排前面；新进的接在后面。"""
    want = [r for r in records if decision_of(r) == "included" and not existing_pdf(r, root)]
    # 首次生成时有全文的不进待获取；上一版里已列的保留原编号（补到全文的打 ✓）
    have_pdf = {id(r) for r in records if decision_of(r) == "included" and existing_pdf(r, root)}
    by_doi = {record_doi(r): r for r in records if decision_of(r) == "included" and record_doi(r)}
    by_title = {re.sub(r"\W+", "", ris_value(r.get("title")).casefold()): r for r in records if decision_of(r) == "included"}
    rows, used = [], set()
    checked_any = any(done for _, done, _ in previous)
    for number, done, text in previous:
        doi = bare_doi(text)
        rec = by_doi.get(doi) if doi else None
        if rec is None:
            rec = by_title.get(re.sub(r"\W+", "", text.rsplit(" — ", 1)[0].casefold()))
        if rec is None or id(rec) in used:
            continue  # 已不在纳入名单：去掉这一行（人在 Mesa 里移出的）
        used.add(id(rec))
        # 人或精读步勾过的保留（他们放进来的 PDF 名字不一定是这里的命名）
        rows.append((number, rec, done or id(rec) in have_pdf))
    for rec in want:
        if id(rec) not in used:
            used.add(id(rec))
            rows.append((None, rec, False))
    if not checked_any:
        # 还没人开始补全文：重新从 1 连续编号
        return [(i + 1, rec, done) for i, (_, rec, done) in enumerate(rows)]
    top = max([n for n, _, _ in rows if n is not None] or [0])
    out = []
    for n, rec, done in rows:
        if n is None:
            top += 1
            n = top
        out.append((n, rec, done))
    return out


def cmd_write(args):
    path = Path(args.json)
    root = project_root(args.root)
    out_dir = Path(args.out)
    records = read_records(path)
    included = [r for r in records if decision_of(r) == "included"]
    pending = [r for r in records if decision_of(r) == "pending"]
    excluded = [r for r in records if decision_of(r) == "excluded"]
    for rec in included:
        have = existing_pdf(rec, root)
        if have:
            rec["pdf"] = have
        else:
            rec.pop("pdf", None)
    write_json(path, records)
    summary = f"终判纳入 {len(included)} 篇，另有待确认 {len(pending)} 篇"
    if excluded:
        summary += f"，人工排除 {len(excluded)} 篇"
    md = ["# 检索结果清单", "", summary + "。本清单由 papers/included.json 生成，两边一一对应。", "", "## 纳入清单", ""]
    md += [md_line(r) for r in included] or ["（无）"]
    md += ["", "## 待确认清单", ""]
    md += [md_line(r) for r in pending] or ["（无）"]
    atomic_write(out_dir / "included.md", "\n".join(md) + "\n")
    rows = fetch_list(records, root, read_previous_fetch(out_dir / "to-fetch.md"))
    if rows:
        fetch = ["# 待获取全文", "",
                 f"已纳入、还没有全文的 {sum(1 for _, _, d in rows if not d)} 篇。顺序与 papers/to-fetch.ris、papers/endnote-import.ris 一致；补到全文后在编号后加 ✓，编号不重排。", ""]
        for n, rec, done in rows:
            doi = record_doi(rec)
            ident = doi or (as_text(rec.get("url")) if meaningful(rec.get("url")) else as_text(rec.get("id")))
            fetch.append(f"{n}. {'✓ ' if done else ''}{ris_value(rec.get('title'))} — {ident}")
    else:
        fetch = ["# 待获取全文", "", "无待获取：已纳入的篇目都有全文。"]
    atomic_write(out_dir / "to-fetch.md", "\n".join(fetch) + "\n")
    listed = [rec for _, rec, _ in rows]
    atomic_write(out_dir / "to-fetch.ris", ris_file(listed, "zotero"), newline="")
    atomic_write(out_dir / "endnote-import.ris", ris_file(listed, "endnote"), newline="")
    print(f"已写 included.md（纳入 {len(included)}、待确认 {len(pending)}）、to-fetch.md 与两份 RIS（{len(listed)} 条，同序）。")
    return 0


# ---------- check ----------

def cmd_check(args):
    path = Path(args.json)
    root = project_root(args.root)
    out_dir = Path(args.out)
    errors, warnings = [], []
    try:
        records = read_records(path)
    except Exception as err:
        print(f"✗ 读不了 {path}：{err}")
        return 1
    ids = {}
    for i, rec in enumerate(records, 1):
        tag = f"第 {i} 条（{as_text(rec.get('id')) or '无 id'}）"
        for key in HEAD:
            if not as_text(rec.get(key)):
                errors.append(f"{tag} 缺 {key}")
        rid = as_text(rec.get("id"))
        if rid:
            if rid in ids:
                errors.append(f"{tag} id 与第 {ids[rid]} 条重复")
            ids[rid] = i
        d = decision_of(rec)
        if d not in DECISIONS:
            errors.append(f"{tag} decision 应是 included / pending / excluded，现在是「{rec.get('decision')}」")
        if d == "excluded":
            continue
        for key in FIELDS:
            value = rec.get(key)
            if value is None or (isinstance(value, str) and not value.strip()) or value == []:
                errors.append(f"{tag} {key} 留空（查不到要写「待补」）")
        if record_doi(rec):
            for key in ("venue", "doi", "url"):
                if not meaningful(rec.get(key)) and as_text(rec.get("articleType")) != "Book Section":
                    errors.append(f"{tag} 有 DOI 但 {key} 是待补：重跑 enrich")
        abbr = as_text(rec.get("journalAbbreviation"))
        venue = as_text(rec.get("venue"))
        if meaningful(abbr) and meaningful(venue) and not unabbreviable(venue) and (abbr.casefold() == venue.casefold() or "." not in abbr):
            warnings.append(f"{tag} 期刊缩写「{abbr}」不像 ISO 4（等于全称或没有句点）")
        if d == "included" and as_text(rec.get("pdf")) and not (root / as_text(rec.get("pdf"))).is_file():
            errors.append(f"{tag} pdf 指向的 {rec.get('pdf')} 不存在")
    included = [r for r in records if decision_of(r) == "included"]
    pending = [r for r in records if decision_of(r) == "pending"]
    md_path = out_dir / "included.md"
    if md_path.is_file():
        md = md_path.read_text(encoding="utf-8", errors="replace")
        for rec in included + pending:
            if ris_value(rec.get("title")) not in md:
                errors.append(f"included.md 缺「{ris_value(rec.get('title'))[:50]}」：重跑 write")
        m = re.search(r"纳入\s*(\d+)\s*篇", md)
        if m and int(m.group(1)) != len(included):
            errors.append(f"included.md 写纳入 {m.group(1)} 篇，json 里是 {len(included)} 篇")
        m = re.search(r"待确认\s*(\d+)\s*篇", md)
        if m and int(m.group(1)) != len(pending):
            errors.append(f"included.md 写待确认 {m.group(1)} 篇，json 里是 {len(pending)} 篇")
    else:
        errors.append("没有 papers/included.md")
    fetch_path = out_dir / "to-fetch.md"
    previous = read_previous_fetch(fetch_path) if fetch_path.is_file() else []
    if not fetch_path.is_file():
        errors.append("没有 papers/to-fetch.md")
    pending_dois = {record_doi(r) for r in pending if record_doi(r)}
    fetch_dois = [bare_doi(text) for _, _, text in previous]
    for doi in fetch_dois:
        if doi and doi in pending_dois:
            errors.append(f"to-fetch.md 里有待确认篇目 {doi}：待确认的不进待获取")
    numbers = [n for n, _, _ in previous]
    if len(set(numbers)) != len(numbers):
        errors.append("to-fetch.md 编号有重复")
    for rec in included:
        if not existing_pdf(rec, root) and record_doi(rec) and record_doi(rec) not in fetch_dois:
            errors.append(f"已纳入且没有全文的 {record_doi(rec)} 不在 to-fetch.md")
    for name, forbid in (("to-fetch.ris", ("JO", "JF", "JA", "N1", "N2", "M1", "M2", "M3", "DA", "ET", "LA")),
                         ("endnote-import.ris", ("JO", "JF", "JA", "N1", "N2", "M1"))):
        ris_path = out_dir / name
        if not ris_path.is_file():
            errors.append(f"没有 papers/{name}（没有待获取时保留零字节空文件）")
            continue
        raw = ris_path.read_bytes()
        if raw.startswith(b"\xef\xbb\xbf"):
            errors.append(f"{name} 带 BOM：EndNote 会静默导入 0 条")
        text = raw.decode("utf-8", errors="replace")
        if text and "\r\n" not in text:
            errors.append(f"{name} 不是 CRLF 换行")
        blocks = [b for b in re.split(r"\r?\nER  - ?\r?\n?", text) if b.strip()]
        dois = re.findall(r"^DO  - (.+?)\r?$", text, flags=re.M)
        if [d.lower() for d in dois] != [d for d in fetch_dois if d]:
            errors.append(f"{name} 的条目与 to-fetch.md 不同序或条数不同（RIS {len(blocks)} 条 / 清单 {len(previous)} 行）")
        for tag in forbid:
            if re.search(rf"^{tag}  - ", text, flags=re.M):
                errors.append(f"{name} 不该有 {tag} 标签")
        if re.search(r"^[A-Z0-9]{2}  - 待补\s*$", text, flags=re.M):
            errors.append(f"{name} 里写了「待补」：查不到的标签不写")
    for line in warnings:
        print(f"! {line}")
    for line in errors:
        print(f"✗ {line}")
    if errors:
        print(f"校验没过：{len(errors)} 处。按提示重跑 enrich / write 再查。")
        return 1
    print(f"校验通过：纳入 {len(included)}、待确认 {len(pending)}、待获取 {len(previous)}；两份 RIS 与 to-fetch.md 同序。")
    return 0


# ---------- bib（精读步：从 included.json 写 references.bib，不另查） ----------

BIB_FIELDS = (
    ("title", "title"), ("authors", "author"), ("year", "year"), ("venue", "journal"), ("volume", "volume"),
    ("issue", "number"), ("pages", "pages"), ("date", "date"), ("epubDate", "epubdate"),
    ("journalAbbreviation", "journalabbreviation"), ("issn", "issn"), ("doi", "doi"), ("url", "url"),
    ("abstract", "abstract"), ("keywords", "keywords"), ("language", "language"), ("articleType", "articletype"),
)
# 查不到也要写「待补」的字段（人一眼看到缺口）；其余查不到就不写。期号是「无期号」的不写 number
BIB_REQUIRED = {"title", "author", "year", "journal", "volume", "number", "pages", "doi"}


def bib_value(rec, src):
    value = rec.get(src)
    if src == "authors":
        names = author_list(value)
        return " and ".join(names) if names else ""
    if src == "keywords":
        return "; ".join(keyword_list(value))
    if src == "pages":
        text = as_text(value)
        if not meaningful(text):
            return ""
        a, b = B.split_pages(text)
        return f"{a}--{b}" if b else a
    if src == "doi":
        return record_doi(rec)
    text = as_text(value)
    if not meaningful(text):
        return ""
    if src in ("title", "abstract", "venue"):
        return B.clean(text)
    return text


def bib_key(rec, taken):
    authors = author_list(rec.get("authors"))
    family = re.sub(r"[^A-Za-z]", "", ascii_fold(authors[0].split(",")[0])) if authors else ""
    if not family:
        words = re.findall(r"[A-Za-z]+", ascii_fold(as_text(rec.get("title"))))
        family = words[0] if words else "Ref"
    year = as_text(rec.get("year")) if meaningful(rec.get("year")) else ""
    base = family[:1].upper() + family[1:] + year
    key, n = base, 0
    while key.lower() in taken:
        key = base + "abcdefghijklmnopqrstuvwxyz"[n % 26] + ("" if n < 26 else str(n // 26))
        n += 1
    taken.add(key.lower())
    return key


def entry_spans(text):
    """references.bib 里每条的 (key, 起, 止)。止 = 收尾花括号之后。"""
    spans = []
    for m in re.finditer(r"@(\w+)\s*\{\s*([^,\s]+)\s*,", text):
        if m.group(1).lower() in ("comment", "string", "preamble"):
            continue
        depth, i = 1, m.end()
        while i < len(text) and depth:
            ch = text[i]
            if ch == "\\":
                i += 2
                continue
            depth += (ch == "{") - (ch == "}")
            i += 1
        spans.append((m.group(2), m.start(), i))
    return spans


def bib_fields_of(entry):
    names = {}
    for m in re.finditer(r"(?:^|[,{\n])\s*([A-Za-z][\w-]*)\s*=\s*([{\"]|\w)", entry):
        opening = m.group(2)
        if opening not in '{"':
            # 不带括号的值（year = 2020、宏名）：取到逗号或收尾括号前
            bare = re.match(r"[\w.:-]+", entry[m.start(2):])
            end = m.start(2) + (bare.end() if bare else 0)
            names[m.group(1).lower()] = (entry[m.start(2):end], m.start(1), end)
            continue
        start = m.end()
        depth, i = 1, start
        while i < len(entry) and depth:
            ch = entry[i]
            if opening == "{":
                depth += (ch == "{") - (ch == "}")
            elif ch == '"':
                depth = 0
            i += 1
        names[m.group(1).lower()] = (entry[start:i - 1].strip(), m.start(1), i)
    return names


def cmd_bib(args):
    records = read_records(Path(args.json))
    bib_path = Path(args.bib)
    text = bib_path.read_text(encoding="utf-8-sig") if bib_path.is_file() else ""
    wanted = [r for r in records if decision_of(r) == "included" or (args.with_pending and decision_of(r) == "pending")]
    if args.ids:
        keep = {x.strip() for x in args.ids.split(",") if x.strip()}
        wanted = [r for r in wanted if as_text(r.get("id")) in keep]
    spans = entry_spans(text)
    taken = {k.lower() for k, _, _ in spans}
    by_doi, by_title = {}, {}
    for key, start, end in spans:
        fields = bib_fields_of(text[start:end])
        doi = bare_doi(fields.get("doi", ("",))[0])
        if doi:
            by_doi[doi] = key
        title = re.sub(r"\W+", "", re.sub(r"[{}]", "", fields.get("title", ("",))[0]).casefold())
        if title:
            by_title[title] = key
    keys, added, filled = {}, [], {}
    appended = []
    for rec in wanted:
        doi = record_doi(rec)
        title_key = re.sub(r"\W+", "", ris_value(rec.get("title")).casefold())
        key = (by_doi.get(doi) if doi else None) or by_title.get(title_key)
        if key:
            # 已有条目：只补空着的或写着「待补」的字段，不改键、不覆盖已有值
            span = next(s for s in spans if s[0] == key)
            entry = text[span[1]:span[2]]
            fields = bib_fields_of(entry)
            new_entry = entry
            changed = []
            for src, name in BIB_FIELDS:
                value = bib_value(rec, src)
                current = fields.get(name)
                if not value:
                    # 早先写成 number = {待补}、其实这本刊不分期：拿掉这一行，免得渲染出「(待补)」
                    if src == "issue" and as_text(rec.get("issue")) == NO_ISSUE and current and current[0] == PLACEHOLDER:
                        new_entry = re.sub(r"\n[ \t]*number\s*=\s*\{待补\},?", "", new_entry, count=1)
                        changed.append("-number")
                        fields = bib_fields_of(new_entry)
                    continue
                if current and meaningful(current[0]):
                    continue
                line = f"{name} = {{{B.escape_bib(value)}}}"
                if current:
                    new_entry = new_entry.replace(new_entry[current[1]:current[2]], line, 1)
                else:
                    body = new_entry.rstrip()[:-1].rstrip()
                    sep = "" if body.endswith(",") else ","
                    new_entry = f"{body}{sep}\n  {line}\n}}"
                changed.append(name)
                fields = bib_fields_of(new_entry)
            if changed:
                text = text[:span[1]] + new_entry + text[span[2]:]
                spans = entry_spans(text)
                filled[key] = changed
            keys[as_text(rec.get("id"))] = key
            continue
        key = bib_key(rec, taken)
        lines = []
        for src, name in BIB_FIELDS:
            value = bib_value(rec, src)
            if not value:
                if name in BIB_REQUIRED and not (src == "issue" and as_text(rec.get("issue")) == NO_ISSUE):
                    value = PLACEHOLDER
                else:
                    continue
            if "\n@" in value or value.count("{") != value.count("}"):
                raise ValueError(f"{key} 的 {name} 花括号不配对，先改 included.json")
            lines.append(f"  {name} = {{{B.escape_bib(value)}}},")
        appended.append(f"@article{{{key},\n" + "\n".join(lines) + "\n}\n")
        added.append(key)
        keys[as_text(rec.get("id"))] = key
        if doi:
            by_doi[doi] = key
        by_title[title_key] = key
    if appended:
        text = (text.rstrip() + "\n\n" if text.strip() else "") + "\n".join(appended)
    if added or filled:
        atomic_write(bib_path, text if text.endswith("\n") else text + "\n")
    print(json.dumps({"keys": keys, "added": added, "filled": filled}, ensure_ascii=False, indent=2))
    return 0


def main():
    utf8_stdio()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp, root=True):
        sp.add_argument("--json", default="papers/included.json")
        sp.add_argument("--cache", default=None, help="接口缓存目录（默认系统临时目录下 mesa-lit-cache）")
        sp.add_argument("--refresh", action="store_true", help="不读缓存，重新联网")
        sp.add_argument("--offline", action="store_true", help="只读缓存，不联网")
        if root:
            sp.add_argument("--root", default=None, help="项目根（默认读 TASK.md 的「项目根」）")
            sp.add_argument("--out", default="papers", help="清单与 RIS 的目录（默认本工作区 papers/）")

    sp = sub.add_parser("enrich", help="按 DOI 补齐纳入与待确认的题录字段")
    common(sp, root=False)
    sp.add_argument("--workers", type=int, default=6)
    sp = sub.add_parser("fetch", help="开放获取：只下已纳入篇目的正式版或已录用稿到项目根 papers/")
    common(sp)
    sp.add_argument("--allow-preprint", action="store_true", help="来源级别允许预印本时才加")
    sp = sub.add_parser("write", help="从 included.json 生成 included.md、to-fetch.md 与两份 RIS")
    common(sp)
    sp = sub.add_parser("check", help="校验 json、清单与两份 RIS 是否一致")
    common(sp)
    sp = sub.add_parser("bib", help="精读步：把 included.json 的题录写进 references.bib（已有条目只补空字段）")
    common(sp, root=False)
    sp.add_argument("--bib", default="references.bib")
    sp.add_argument("--ids", default="", help="只写这些 id（逗号分隔）")
    sp.add_argument("--with-pending", action="store_true")
    a = p.parse_args()
    if a.cache:
        Net.cache = Path(a.cache)
    Net.refresh = a.refresh
    Net.offline = a.offline
    try:
        return {"enrich": cmd_enrich, "fetch": cmd_fetch, "write": cmd_write, "check": cmd_check, "bib": cmd_bib}[a.cmd](a)
    except (OSError, ValueError, json.JSONDecodeError) as err:
        print(f"✗ {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
