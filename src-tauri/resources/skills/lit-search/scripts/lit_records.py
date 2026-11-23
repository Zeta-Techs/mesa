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
  python3 lit_records.py angles-facts --json papers/included.json --index notes/index.json
  python3 lit_records.py extract-text --json papers/included.json --root <项目根> --keys Key1,Key2 [--out-dir .ccode/local/pdf-texts]
  python3 lit_records.py validate --json papers/included.json --root <项目根> [--index notes/index.json] [--bib references.bib]
  python3 lit_records.py table --file notes/skim.md --get Key1,Key2 | --upsert patch.json

接口缓存在系统临时目录 mesa-lit-cache/（--cache 可改），重跑不重复联网；--refresh 忽略缓存，--offline 只读缓存。
"""
import argparse
import concurrent.futures
import csv
import functools
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
# 文献类型（检索时判，人在 Mesa 里可改）：综述 / 研究论文 / 其他。只在 json 里，不进任何 RIS 与引文库
KINDS = ("review", "research", "other")
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
            short = B.tidy_abbreviation(row[1])
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
    cur = B.tidy_abbreviation(as_text(current)) if meaningful(current) else ""
    if cur and "." in cur and cur.casefold() != venue.casefold():
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


def _git_common_root(cwd):
    """若当前目录在 git worktree 里，通过 git-common-dir 推导出主项目根（三平台通用，不依赖符号链接）。"""
    import subprocess
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=5,
        )
        if proc.returncode != 0:
            return None
        common = Path(proc.stdout.strip())
        if not common.is_absolute():
            common = (Path(cwd) / common).resolve()
        else:
            common = common.resolve()
        if common.name == ".git" and common.parent.is_dir():
            return common.parent
    except Exception:
        return None
    return None


def project_root(arg):
    """项目根定位顺序：--root > MESA_PROJECT_ROOT 环境变量 > 当前目录 TASK.md「项目根：`…`」> git worktree 主仓根 > 当前目录。"""
    if arg:
        return Path(arg)
    env_root = os.environ.get("MESA_PROJECT_ROOT", "").strip()
    if env_root and Path(env_root).is_dir():
        return Path(env_root)
    task = Path("TASK.md")
    if task.is_file():
        m = re.search(r"项目根：`([^`]+)`", task.read_text(encoding="utf-8", errors="replace"))
        if m:
            return Path(m.group(1))
    git_root = _git_common_root(Path.cwd())
    if git_root is not None:
        return git_root
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


@functools.lru_cache(maxsize=None)
def zotero_imports(root):
    """Mesa「从 Zotero 导入」的清单（papers/imports/zotero-*.json）：[(bibKey, DOI, 正文 PDF 绝对路径或空)]。
    PDF 留在 Zotero 库里不复制，清单里的 pdfPath 就是全文（Mesa 只登记正文，补充材料和没下完的不登记）。"""
    rows = []
    for manifest in sorted((Path(root) / "papers" / "imports").glob("zotero-*.json")):
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for row in data if isinstance(data, list) else []:
            if isinstance(row, dict) and as_text(row.get("bibKey")):
                rows.append((as_text(row.get("bibKey")), bare_doi(row.get("doi")), as_text(row.get("pdfPath"))))
    return tuple(rows)


def imported_from(rec, root):
    """这条是不是用户从 Zotero 导入的（id 是导入时的引用键，或 DOI 对上）：返回导入清单那一行，不是返回 None"""
    rid, doi = as_text(rec.get("id")), record_doi(rec)
    for row in zotero_imports(str(root)):
        if rid == row[0] or (doi and doi == row[1]):
            return row
    return None


_SI_NAME_RE = re.compile(
    r"(?:supporting[-_ ]?information|supplementary|supplemental|supinfo"
    r"|[_-]si(?:[_-]?0\d+)?$"
    r"|[_-]mmc\d+$|[_-]moesm\d+(?:[_-]esm)?$"
    r"|[_-]sup[_-]\d+(?:[_-].*)?$|[_-]esi(?:[_-]?\d+)?$)",
    re.I,
)
_SI_HEAD_RE = re.compile(
    r"^(?:electronic\s+)?(?:supporting|supplementary|supplemental)\s+"
    r"(?:information|material|materials|data|files?)(?:\s+for\b.*)?[:：]?$",
    re.I,
)
_ABS_HEAD_RE = re.compile(r"^\s*abstract\b", re.I | re.M)


@functools.lru_cache(maxsize=None)
def is_supporting_info(pdf):
    """判断一份 PDF 是不是 Supporting Information / Supplementary Material（不是正文全文）。
    文件名只认明确 SI 词样（绝不把化学元素 Si 当 SI）；有 PyMuPDF 时核首页前 12 行独立标题且无 Abstract 节。"""
    p = Path(pdf)
    if _SI_NAME_RE.search(p.stem):
        return True
    try:
        import pymupdf
    except ImportError:
        try:
            import fitz as pymupdf
        except ImportError:
            return False
    try:
        with pymupdf.open(str(p)) as doc:
            if doc.page_count < 1:
                return False
            p0 = doc[0].get_text() or ""
    except Exception:
        return False
    top_lines = [line.strip() for line in p0.splitlines() if line.strip()][:12]
    has_si_heading = any(_SI_HEAD_RE.match(line) for line in top_lines)
    has_abs = bool(_ABS_HEAD_RE.search(p0))
    return has_si_heading and not has_abs


def _match_project_paper(rec, root, *, skip_si=True):
    papers = root / "papers"
    name = pdf_name(rec)
    direct = papers / name
    if direct.is_file() and (not skip_si or not is_supporting_info(direct)):
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
    candidates = [pdf for pdf in sorted(papers.glob("*.pdf")) if (not skip_si or not is_supporting_info(pdf))]
    for pdf in candidates:
        stem = pdf.stem.lower()
        if doi and (doi in stem or doi.replace("/", "_") in stem or doi.replace("/", "-") in stem):
            return f"papers/{pdf.name}"
        words = _words(re.sub(r"^[A-Za-z]+\d{4}[a-z]?-", "", pdf.stem))
        if len(words) >= 3 and sum(len(w) for w in words) >= 12:
            if all(w in title for w in words):
                return f"papers/{pdf.name}"
            # 文件名被浏览器 / Zotero 截断到 ~100 字符时，最后一个词常残缺（如 Acidic → Acidi）
            if len(pdf.stem) >= 80 and len(words) >= 5 and all(w in title for w in words[:-1]) and any(t.startswith(words[-1]) for t in title):
                return f"papers/{pdf.name}"
    # 文件名对不上（Ru-based 这类元素缩写、出版商编号名）：PDF 开头的元数据里多半写着 DOI
    if doi:
        needle = doi.encode("ascii", "ignore")
        for pdf in candidates:
            try:
                with pdf.open("rb") as handle:
                    head = handle.read(256 * 1024).lower()
            except OSError:
                continue
            if needle and needle in head:
                return f"papers/{pdf.name}"
        # 元数据压在对象流里时原始字节里搜不到：有 PyMuPDF 就抽前两页文字再找（首页页眉多半印着 DOI）。
        # 2026-10-23 HER 实证：Zhao2024-HEA-HER、Liang2022-TiCN-MXene-HER、Chen2022-Pt-defect-anchoring-HER 三个名字都认不出
        target = doi.lower()
        for pdf in candidates:
            if target in _pdf_head_text(pdf):
                return f"papers/{pdf.name}"
    return ""


def existing_pdf(rec, root):
    """这篇已有的正文全文：json 的 pdf 字段 → Zotero 导入登记的 PDF（留在 Zotero 库里，绝对路径）→ 项目根 papers/ 里
    本脚本的命名 → 文件名带 DOI → 文件名去掉「作者年份-」后每个词都出现在标题里（人或上一轮按「作者年份-短标题」起的名字）。
    Supporting Information（SI）不算正文全文，自动跳过。都对不上返回空。"""
    rel = as_text(rec.get("pdf"))
    if rel:
        p = root / rel
        if p.is_file() and not is_supporting_info(p):
            return rel.replace("\\", "/")
    row = imported_from(rec, root)
    if row and row[2] and Path(row[2]).is_file() and not is_supporting_info(row[2]):
        return row[2].replace("\\", "/")
    return _match_project_paper(rec, root, skip_si=True)


@functools.lru_cache(maxsize=None)
def _pdf_head_text(pdf):
    """PDF 元数据与前两页文字（小写、去空白）；没装 PyMuPDF 或读不了返回空串。"""
    try:
        import pymupdf
    except ImportError:
        try:
            import fitz as pymupdf
        except ImportError:
            return ""
    try:
        with pymupdf.open(str(pdf)) as doc:
            parts = [" ".join(str(v) for v in (doc.metadata or {}).values() if v)]
            parts += [doc[i].get_text() for i in range(min(2, doc.page_count))]
    except Exception:
        return ""
    return re.sub(r"\s+", "", " ".join(parts)).lower()


def cmd_fetch(args):
    path = Path(args.json)
    root = project_root(args.root)
    records = read_records(path)
    taken = {p.name.lower() for p in (root / "papers").glob("*.pdf")} if (root / "papers").is_dir() else set()
    report, forbidden = [], 0
    stopped = False
    downloaded = no_url = failed = skipped_stopped = no_doi = 0
    for rec in records:
        if decision_of(rec) != "included":
            continue  # 待确认的不下全文，等人拍板
        have = existing_pdf(rec, root)
        if have:
            rec["pdf"] = have
            continue
        rec.pop("pdf", None)
        doi = record_doi(rec)
        if stopped:
            skipped_stopped += 1
            report.append(f"- 停止后未尝试：{as_text(rec.get('title'))[:60]}（连续 3 次 403 已停）")
            continue
        if not doi:
            no_doi += 1
            report.append(f"- 无 DOI 未尝试：{as_text(rec.get('title'))[:60]}")
            continue
        try:
            urls = oa_candidates(doi, args.allow_preprint)
        except Exception as err:
            failed += 1
            report.append(f"- 下载失败：{doi}（OpenAlex 没取到：{type(err).__name__}）")
            continue
        if not urls:
            no_url += 1
            report.append(f"- 无合规直链：{doi}（接口没给{'' if args.allow_preprint else '正式版或已录用稿的'} PDF 直链）")
            continue
        name = pdf_name(rec)
        base, n = name[:-4], 2
        while name.lower() in taken:
            name = f"{base}-{n}.pdf"
            n += 1
        dest = root / "papers" / name
        # 每篇只试第 1 条合规直链，失败不换链重试；连续 3 次实际 HTTP 403 即停
        url = urls[0]
        try:
            download_pdf(url, dest)
            forbidden = 0
            taken.add(name.lower())
            rec["pdf"] = f"papers/{name}"
            downloaded += 1
            report.append(f"- 已下：papers/{name}")
        except Forbidden:
            forbidden += 1
            failed += 1
            report.append(f"- 下载失败：{doi} ← {url}（HTTP 403）")
            if forbidden >= 3:
                stopped = True
        except Exception as err:
            forbidden = 0
            failed += 1
            report.append(f"- 下载失败：{doi} ← {url}（{err}）")
    write_json(path, records)
    got = sum(1 for r in records if decision_of(r) == "included" and as_text(r.get("pdf")))
    total = sum(1 for r in records if decision_of(r) == "included")
    parts = [f"本轮新下 {downloaded}", f"无合规直链 {no_url}", f"下载失败 {failed}"]
    if skipped_stopped:
        parts.append(f"停止后未尝试 {skipped_stopped}")
    if no_doi:
        parts.append(f"无 DOI {no_doi}")
    print(f"开放获取：已纳入 {total} 篇，有全文 {got} 篇（{'，'.join(parts)}），其余进 to-fetch。{'连续 3 次 403，已停止其余下载。' if stopped else ''}")
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


TO_FETCH_DONE_PREFIX = re.compile(r"^(?:\[|【)\s*已补[^\]】]*(?:\]|】)\s*")
TO_FETCH_SKIPPED_PREFIX = re.compile(r"^(?:\[|【)\s*(?:跳过|仅摘要)[^\]】]*(?:\]|】)\s*")


def read_previous_fetch(path):
    """已有 to-fetch.md 的编号与勾选：编号不重排，补到全文的保留「✓」；
    与前端 src/step-flow.ts parseToFetchItems 及后端 workspaces.rs to_fetch_entries_in 三端同口径：
    - 遇到分隔线（--- / *** / ___）即止（后面是线索段不算待获取）；
    - 兼容 N. / N、 / N) 编号与 [已补 …] / [跳过 …] / [仅摘要 …] 前缀。"""
    order = []
    if not path.is_file():
        return order
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if order and re.match(r"^(?:-{3,}|\*{3,}|_{3,})$", s):
            break
        m = re.match(r"\s*(\d+)[.、)]\s+(✓\s*)?(.*)$", line)
        if m:
            body = m.group(3).strip()
            done = bool(m.group(2))
            if TO_FETCH_DONE_PREFIX.match(body):
                done = True
                body = TO_FETCH_DONE_PREFIX.sub("", body).strip()
            body = TO_FETCH_SKIPPED_PREFIX.sub("", body).strip()
            if body:
                order.append((int(m.group(1)), done, body))
    return order


ADDED_NOTE = re.compile(r"^(\d{4}-\d{2}-\d{2}) 新加：第 (.+) 篇。$")


def number_ranges(numbers):
    """[50, 51, 52, 55] → 「50–52、55」（与 Mesa step-flow.ts parseAddedNotes 同一写法）"""
    out, nums = [], sorted(set(numbers))
    i = 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        out.append(str(nums[i]) if i == j else f"{nums[i]}–{nums[j]}")
        i = j + 1
    return "、".join(out)


def added_notes(path, previous, rows):
    """「某天新加：第 x–y 篇」：上一版已有的说明照留（带日期，过后也不会说错），这次新进待获取的篇另起一行。
    按 DOI / 标题身份识别新篇，不单看编号 > top（没人打 ✓ 时排除旧篇会从 1 重排，单看 n > top 会漏记新篇）；
    上一版没有编号（首次生成）时不写——全都是新的（2026-11-10 HER：退回修改后分不出哪些是意见新增的）。"""
    keep = []
    if path.is_file():
        keep = [l for l in path.read_text(encoding="utf-8", errors="replace").splitlines() if ADDED_NOTE.match(l.strip())]
    if previous:
        prev_dois = {bare_doi(text) for _, _, text in previous if bare_doi(text)}
        prev_titles = {re.sub(r"\W+", "", text.rsplit(" — ", 1)[0].casefold()) for _, _, text in previous}
        fresh = []
        for n, rec, _ in rows:
            doi = record_doi(rec)
            tkey = re.sub(r"\W+", "", ris_value(rec.get("title")).casefold())
            seen = (doi in prev_dois) if doi else (bool(tkey) and tkey in prev_titles)
            if not seen:
                fresh.append(n)
        if fresh:
            import datetime
            keep.append(f"{datetime.date.today().isoformat()} 新加：第 {number_ranges(fresh)} 篇。")
    return keep


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
        if not checked_any and not done and id(rec) in have_pdf:
            continue  # 还没开始手工勾选下载进度且本篇已有全文（如 Zotero 附件），不留在待获取里
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


def cmd_pdfs(args):
    """精读步只读认全文：每篇已纳入的在项目里有没有正文全文、是哪个文件（含统一 absPath、来源 zotero / project-papers，
    并把仅有 Supporting Information 的单独标进 supportingOnly 不误当正文）。不写任何文件——
    included.json、included.md、to-fetch.md 与两份 RIS 归检索那一步（2026-11-10：精读改它们，补文献时两步冲突，手改还贴错过记录）。"""
    root = project_root(args.root)
    included = [r for r in read_records(Path(args.json)) if decision_of(r) == "included"]
    found, missing, supporting_only = [], [], []
    for rec in included:
        have = existing_pdf(rec, root)
        item = {"id": as_text(rec.get("id")), "title": as_text(rec.get("title"))}
        bib_key = as_text(rec.get("bibKey"))
        if bib_key:
            item["bibKey"] = bib_key
        if have:
            abs_path = (root / have).resolve().as_posix()
            zrow = imported_from(rec, root)
            is_zotero = bool(
                (zrow and zrow[2] and Path(zrow[2]).resolve().as_posix() == abs_path)
                or Path(have).is_absolute()
            )
            found.append({
                **item,
                "pdf": have,
                "absPath": abs_path,
                "source": "zotero" if is_zotero else "project-papers",
            })
        else:
            si = _match_project_paper(rec, root, skip_si=False)
            if si and is_supporting_info(root / si):
                supporting_only.append({
                    **item,
                    "pdf": si,
                    "absPath": (root / si).resolve().as_posix(),
                    "isSupportingInfo": True,
                })
            missing.append(item)
    payload = {"found": found, "missing": missing}
    if supporting_only:
        payload["supportingOnly"] = supporting_only
    print(json.dumps(payload, ensure_ascii=False, indent=1))
    if not getattr(args, "json_only", False):
        si_note = f"，另有 {len(supporting_only)} 篇仅匹配到 Supporting Information（未算正文全文）" if supporting_only else ""
        print(
            f"已纳入 {len(included)} 篇：认出正文全文 {len(found)} 篇，没有正文全文 {len(missing)} 篇{si_note}（只读，没改任何文件）。",
            file=sys.stderr,
        )
    return 0


def _existing_bib_maps(*candidates):
    by_doi, by_title, taken = {}, {}, set()
    for p in candidates:
        if not p or not Path(p).is_file():
            continue
        text = Path(p).read_text(encoding="utf-8-sig", errors="replace")
        for key, start, end in entry_spans(text):
            taken.add(key.lower())
            fields = bib_fields_of(text[start:end])
            doi = bare_doi(fields.get("doi", ("",))[0])
            if doi and doi not in by_doi:
                by_doi[doi] = key
            title = re.sub(r"\W+", "", re.sub(r"[{}]", "", fields.get("title", ("",))[0]).casefold())
            if title and title not in by_title:
                by_title[title] = key
    return by_doi, by_title, taken


PREPRINT_DOI_RE = re.compile(r"^10\.(?:48550/arxiv\.|21203/rs\.|26434/chemrxiv|1101/|20944/preprints)", re.I)


def cmd_write(args):
    path = Path(args.json)
    root = project_root(args.root)
    out_dir = Path(args.out)
    records = read_records(path)
    included = [r for r in records if decision_of(r) == "included"]
    pending = [r for r in records if decision_of(r) == "pending"]
    excluded = [r for r in records if decision_of(r) == "excluded"]
    by_doi, by_title, taken = _existing_bib_maps(Path("references.bib"), root / "references.bib")
    # 先固定已有 bibKey 或引文库里的键，再给新条目起确定性 bibKey（精读分路、速读表与 bib 共用同一套键）
    matched_keys = {}
    for rec in included + pending:
        doi = record_doi(rec)
        tkey = re.sub(r"\W+", "", ris_value(rec.get("title")).casefold())
        existing = (by_doi.get(doi) if doi else None) or by_title.get(tkey)
        if existing:
            matched_keys[id(rec)] = existing
            taken.add(existing.lower())
            continue
        cur = as_text(rec.get("bibKey"))
        if cur and re.match(r"^[A-Za-z][\w:-]*$", cur) and cur.lower() not in taken:
            matched_keys[id(rec)] = cur
            taken.add(cur.lower())
    for rec in included + pending:
        rec["bibKey"] = matched_keys.get(id(rec)) or bib_key(rec, taken)
    for rec in included + pending:
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
    previous = read_previous_fetch(out_dir / "to-fetch.md")
    rows = fetch_list(records, root, previous)
    notes = added_notes(out_dir / "to-fetch.md", previous, rows)
    if rows:
        fetch = ["# 待获取全文", "",
                 f"已纳入、还没有全文的 {sum(1 for _, _, d in rows if not d)} 篇。顺序与 papers/to-fetch.ris、papers/endnote-import.ris 一致；补到全文后在编号后加 ✓，编号不重排。", ""]
        if notes:
            fetch += notes + [""]
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
    mesa = mesa_abbreviations()
    official_cache = {}

    def official_abbr(venue_name):
        key = B._journal_key(venue_name)
        if key not in official_cache:
            short = mesa.get(key) or ""
            if not short:
                try:
                    short = B.iso4_abbreviation(venue_name)
                except Exception:
                    short = ""
            official_cache[key] = short
        return official_cache[key]

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
        kind = as_text(rec.get("kind"))
        if kind and kind not in KINDS:
            errors.append(f"{tag} kind 应是 review / research / other，现在是「{kind}」")
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
            official = official_abbr(venue)
            if not (official and abbr.casefold() == official.casefold()):
                warnings.append(f"{tag} 期刊缩写「{abbr}」不像 ISO 4（等于全称或没有句点）")
        if d == "included" and as_text(rec.get("pdf")) and not (root / as_text(rec.get("pdf"))).is_file():
            errors.append(f"{tag} pdf 指向的 {rec.get('pdf')} 不存在")
        if d == "included" and not getattr(args, "allow_preprint", False):
            doi = record_doi(rec)
            atype = as_text(rec.get("articleType")).lower()
            if (doi and PREPRINT_DOI_RE.match(doi)) or atype == "preprint":
                warnings.append(f"{tag} 看起来是预印本（{doi or rec.get('articleType')}）：来源级别未允许预印本时请核对正式发表版或加 --allow-preprint")
    active = [r for r in records if decision_of(r) in ("included", "pending")]
    with_kind = sum(1 for r in active if as_text(r.get("kind")))
    if 0 < with_kind < len(active):
        warnings.append(f"纳入与待确认共 {len(active)} 篇，仅 {with_kind} 篇填了 kind（其余 {len(active) - with_kind} 篇漏填 review / research / other）")
    # 用户自己库里导进来的每条都要在 json 里，Agent 不替人排除（2026-10-23 HER：按检索年份窗口排掉 9 篇，
    # 只写在 screening.md，Mesa 文献清单里看不到也改不回）。人排除的理由以「排除：人工移出 / 评审确认」开头
    listed = [(as_text(r.get("id")), record_doi(r)) for r in records]
    for key, doi, _ in zotero_imports(str(root)):
        if not any(key == rid or (doi and doi == rdoi) for rid, rdoi in listed):
            errors.append(f"Zotero 导入的 {key} 不在 included.json：用户自己库里的每条都写进来，不合适的标 pending、理由写「建议排除：…」")
    for rec in records:
        if decision_of(rec) == "excluded" and imported_from(rec, root) and not re.match(r"排除[：:](人工移出|评审确认)", as_text(rec.get("reason"))):
            errors.append(f"{as_text(rec.get('id'))} 是用户从 Zotero 导入的，Agent 不排除：改成 pending，理由写「建议排除：…」，由人在文献清单里定")
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
    fetch_titles = {re.sub(r"\W+", "", text.rsplit(" — ", 1)[0].casefold()) for _, _, text in previous}
    fetch_tails = {text.rsplit(" — ", 1)[-1].strip() for _, _, text in previous}
    for rec in included:
        if existing_pdf(rec, root):
            continue
        doi = record_doi(rec)
        if doi:
            if doi not in fetch_dois:
                errors.append(f"已纳入且没有全文的 {doi} 不在 to-fetch.md")
        else:
            tkey = re.sub(r"\W+", "", ris_value(rec.get("title")).casefold())
            rid = as_text(rec.get("id"))
            if (not tkey or tkey not in fetch_titles) and (not rid or rid not in fetch_tails):
                errors.append(f"已纳入且没有全文的无 DOI 条目「{ris_value(rec.get('title'))[:40] or rid}」不在 to-fetch.md")
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
            if ch == "\\":
                i += 2
                continue
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
    text, removed = prune_excluded(text, records)
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
                    new_entry = f"{body}{sep}\n  {line},\n}}"
                changed.append(name)
                fields = bib_fields_of(new_entry)
            if changed:
                text = text[:span[1]] + new_entry + text[span[2]:]
                spans = entry_spans(text)
                filled[key] = changed
            keys[as_text(rec.get("id"))] = key
            continue
        preferred = as_text(rec.get("bibKey"))
        if preferred and re.match(r"^[A-Za-z][\w:-]*$", preferred) and preferred.lower() not in taken:
            key = preferred
            taken.add(key.lower())
        else:
            key = bib_key(rec, taken)
        lines = []
        for src, name in BIB_FIELDS:
            value = bib_value(rec, src)
            if not value:
                if name in BIB_REQUIRED and not (src == "issue" and as_text(rec.get("issue")) == NO_ISSUE):
                    value = PLACEHOLDER
                else:
                    continue
            if "\n@" in value:
                raise ValueError(f"{key} 的 {name} 含有换行 @，先改 included.json")
            lines.append(f"  {name} = {{{B.escape_bib(value)}}},")
        appended.append(f"@article{{{key},\n" + "\n".join(lines) + "\n}\n")
        added.append(key)
        keys[as_text(rec.get("id"))] = key
        if doi:
            by_doi[doi] = key
        by_title[title_key] = key
    if appended:
        text = (text.rstrip() + "\n\n" if text.strip() else "") + "\n".join(appended)
    if added or filled or removed:
        atomic_write(bib_path, text if text.endswith("\n") else text + "\n")
    out = {"keys": keys, "added": added, "filled": filled}
    if removed:
        out["removed"] = removed
        cited = cited_by(bib_path.resolve().parent, removed)
        if cited:
            out["citedBy"] = cited
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def prune_excluded(text, records):
    """检索那一步排除了的篇（decision=excluded）移出引文库：按 DOI 认，没有 DOI 的按标题认。
    排除是人在检索步拍板的，精读这边不留它的条目，免得下游照引（2026-11-10 用户拍板）。返回 (新文本, 移出的键)。"""
    dois, titles = set(), set()
    for rec in records:
        if decision_of(rec) != "excluded":
            continue
        doi = record_doi(rec)
        if doi:
            dois.add(doi)
        else:
            t = re.sub(r"\W+", "", ris_value(rec.get("title")).casefold())
            if len(t) >= 8:
                titles.add(t)
    if not dois and not titles:
        return text, []
    removed, cuts = [], []
    for key, start, end in entry_spans(text):
        fields = bib_fields_of(text[start:end])
        doi = bare_doi(fields.get("doi", ("",))[0])
        title = re.sub(r"\W+", "", re.sub(r"[{}]", "", fields.get("title", ("",))[0]).casefold())
        if (doi and doi in dois) or (not doi and title and title in titles):
            removed.append(key)
            cuts.append((start, end))
    for start, end in reversed(cuts):
        tail = end
        while tail < len(text) and text[tail] in "\r\n":
            tail += 1
        text = text[:start] + text[tail:]
    return text, removed


def cited_by(root, keys):
    """移出的键还有哪些稿件在引：大纲、manuscript/、chapters/ 下的 md / qmd / tex。只读，交人处理。"""
    files = [root / "outline.md"]
    for sub in ("manuscript", "chapters"):
        d = root / sub
        if d.is_dir():
            files += [f for f in d.rglob("*") if f.suffix.lower() in (".md", ".qmd", ".tex")]
    out = {}
    for f in files:
        if not f.is_file():
            continue
        body = f.read_text(encoding="utf-8", errors="replace")
        for key in keys:
            if re.search(r"(?<![\w@])@" + re.escape(key) + r"(?![\w:-])", body) or re.search(r"\\cite\w*\{[^}]*\b" + re.escape(key) + r"\b", body):
                out.setdefault(key, []).append(f.relative_to(root).as_posix())
    return out


def year_of(value):
    m = re.match(r"\s*(\d{4})", as_text(value))
    return int(m.group(1)) if m else None


def cmd_angles_facts(args):
    """可写点清单的时效对照：每篇纳入的综述发表于哪年、文献截至哪年、之后又纳入了几篇研究论文。
    「截至」取 notes/index.json 那篇的 cutoffYear（综述卡「覆盖范围与时效」读出来写的）；没写时按发表年算并注明。
    数字由脚本数，AI 只在 notes/angles.md 里引用、解释，不自己数（2026-11-05 综述回路三期）。"""
    records = [r for r in read_records(Path(args.json)) if decision_of(r) == "included"]
    index = {}
    index_path = Path(args.index)
    if index_path.is_file():
        data = json.loads(index_path.read_text(encoding="utf-8-sig"))
        rows = data if isinstance(data, list) else next((data[k] for k in ("records", "items", "papers", "entries", "notes") if isinstance(data, dict) and isinstance(data.get(k), list)), [])
        index = {as_text(r.get("id")): r for r in rows if isinstance(r, dict)}
    taken_keys = set()
    resolved_keys = {}
    for r in records:
        rid = as_text(r.get("id"))
        k = as_text(index.get(rid, {}).get("bibKey")) or as_text(r.get("bibKey"))
        if k:
            taken_keys.add(k.lower())
            resolved_keys[rid] = k
    for r in records:
        rid = as_text(r.get("id"))
        if rid not in resolved_keys:
            resolved_keys[rid] = bib_key(r, taken_keys)
    key_of = lambda rec: resolved_keys.get(as_text(rec.get("id")), as_text(rec.get("id")))
    reviews = [r for r in records if as_text(r.get("kind")) == "review"]
    research = [r for r in records if as_text(r.get("kind")) in ("research", "other")]
    untyped = [r for r in records if not as_text(r.get("kind"))]
    lines = [f"纳入综述 {len(reviews)} 篇、研究论文 {len(research)} 篇" + (f"、未标类型 {len(untyped)} 篇（不算进下表）" if untyped else "") + "。", ""]
    if not reviews:
        lines.append("纳入清单里没有标为综述（kind=review）的篇，没有可对照的时效。")
        print("\n".join(lines))
        return 0
    lines += ["| 综述 | 发表 | 文献截至 | 之后纳入的研究论文 |", "|---|---|---|---|"]
    for rev in sorted(reviews, key=lambda r: year_of(r.get("year")) or 0):
        pub = year_of(rev.get("year"))
        cutoff = year_of(index.get(as_text(rev.get("id")), {}).get("cutoffYear"))
        basis = cutoff or pub
        after = [r for r in research if basis and (year_of(r.get("year")) or 0) > basis]
        keys = "; ".join(f"@{key_of(r)}" for r in after[:12]) + ("; …" if len(after) > 12 else "")
        cut_text = str(cutoff) if cutoff else f"未写（按发表年 {pub or '待补'} 算）"
        later = f"{len(after)} 篇" + (f"：[{keys}]" if after else "")
        # 先截再转义：标题里的 | 会把 Markdown 表格拆成多列
        title = ris_value(rev.get("title"))[:40].replace("|", "\\|")
        lines.append(f"| [@{key_of(rev)}] {title} | {pub or '待补'} | {cut_text} | {later} |")
    print("\n".join(lines))
    return 0


NO_METRIC = "表中无此刊"


def merge_impact(records, found):
    """把 Mesa 期刊指标表的查询结果合进记录：impactFactor（JCR 原样字符串）、casQuartile（中科院大类 1-4）、casTop；
    查不到的写「表中无此刊」，不估、不留旧值。只在 json 里，不进 RIS 与引文库。返回 (查到篇数, 没查到篇数)。"""
    hit = miss = 0
    for rec in records:
        rid = rec.get("id")
        if not isinstance(rid, str) or rid not in found:
            continue
        m = found[rid]
        for k in ("impactFactor", "casQuartile", "casTop"):
            rec.pop(k, None)
        if not m or not m.get("impactFactor"):
            rec["impactFactor"] = NO_METRIC
            miss += 1
        else:
            rec["impactFactor"] = str(m["impactFactor"])
            hit += 1
        if m and m.get("casQuartile"):
            rec["casQuartile"] = int(m["casQuartile"])
        if m and m.get("top"):
            rec["casTop"] = True
    return hit, miss


def cmd_impact(args):
    """按 Mesa 的期刊指标表（JCR 2025 影响因子、中科院分区）给每条写 impactFactor / casQuartile / casTop。
    影响因子只从这里来：AI 不凭记忆估，表里没有的写「表中无此刊」（2026-11-10 HER：人按 IF ≥ 10 退回）。
    查表由 Mesa 的随包 helper 做（$MESA_JOURNAL_TOOL journal），与 Mesa 评审清单上的影响因子同一套匹配。"""
    import subprocess
    tool = os.environ.get("MESA_JOURNAL_TOOL", "").strip()
    if not tool:
        print("✗ 没有 MESA_JOURNAL_TOOL（不在 Mesa 里运行，或 Mesa 版本太旧）：查不了影响因子。不要凭记忆估，请人在 Mesa 的检索清单里看影响因子。", file=sys.stderr)
        return 2
    path = Path(args.json)
    proc = subprocess.run([tool, "journal", str(path)], capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        print(f"✗ {proc.stderr.strip() or '查影响因子失败'}", file=sys.stderr)
        return proc.returncode or 1
    found = json.loads(proc.stdout or "{}")
    records = read_records(path)
    hit, miss = merge_impact(records, found)
    write_json(path, records)
    print(f"已写影响因子：查到 {hit} 篇，表中无此刊 {miss} 篇（JCR 2025；分区为中科院大类）。")
    return 0


_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SI_PAGE_MARK_RE = re.compile(r"^\s*S\d{1,3}\s*$")
_SOURCE_PDF_RE = re.compile(r"^>\s*来源(?:\s*PDF)?[：:]\s*(.+?\.pdf)(?:\s*·.*)?$", re.I)


def strip_control_chars(text):
    """清除 PyMuPDF 抽取文本中可能出现的 NUL 与 ASCII 控制字符，避免编辑器/read_file 拒读。"""
    return _CONTROL_CHARS_RE.sub("", text)


def _load_index_rows(index_path):
    if not index_path.is_file():
        return []
    data = json.loads(index_path.read_text(encoding="utf-8-sig"))
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]
    if isinstance(data, dict):
        for key in ("records", "items", "papers", "entries", "notes"):
            if isinstance(data.get(key), list):
                return [r for r in data[key] if isinstance(r, dict)]
    return []


def _resolve_bib_key_map(records, index_rows, bib_path=None):
    by_id_index = {as_text(r.get("id")): as_text(r.get("bibKey")) for r in index_rows if as_text(r.get("id"))}
    by_doi_bib, by_title_bib, taken = _existing_bib_maps(bib_path) if bib_path else ({}, {}, set())
    resolved = {}
    for rec in records:
        rid = as_text(rec.get("id"))
        doi = record_doi(rec)
        tkey = re.sub(r"\W+", "", ris_value(rec.get("title")).casefold())
        k = (
            by_id_index.get(rid)
            or as_text(rec.get("bibKey"))
            or (by_doi_bib.get(doi) if doi else None)
            or by_title_bib.get(tkey)
        )
        if k:
            taken.add(k.lower())
            resolved[rid] = k
    for rec in records:
        rid = as_text(rec.get("id"))
        if rid and rid not in resolved:
            resolved[rid] = bib_key(rec, taken)
    return resolved


def _open_pymupdf():
    try:
        import pymupdf
        return pymupdf
    except ImportError:
        try:
            import fitz as pymupdf
            return pymupdf
        except ImportError:
            return None


def _detect_si_pages(doc):
    """扫描前两页：命中 Supporting Information 独立标题或 S1/S2 页码且无 Abstract 节，返回原因字符串，否则空串。"""
    if doc.page_count < 1:
        return ""
    pages_text = [doc[i].get_text() or "" for i in range(min(2, doc.page_count))]
    joined = "\n".join(pages_text)
    if _ABS_HEAD_RE.search(joined):
        return ""
    top_lines = [line.strip() for line in pages_text[0].splitlines() if line.strip()][:16]
    if any(_SI_HEAD_RE.match(line) for line in top_lines):
        return "首页含 Supporting Information / Supplementary Material 标题且无 Abstract"
    if doc.page_count >= 2:
        p0_lines = [line.strip() for line in pages_text[0].splitlines() if line.strip()][:6]
        p1_lines = [line.strip() for line in pages_text[1].splitlines() if line.strip()][:6]
        if any(_SI_PAGE_MARK_RE.match(l) for l in p0_lines) and any(_SI_PAGE_MARK_RE.match(l) for l in p1_lines):
            return "前两页页码均为 S1/S2 且无 Abstract（疑似 Supporting Information）"
    return ""


_SYMBOL_FONT_RE = re.compile(r"symbol|advps_?sym|cmsy|mtsy|mathpi|symb", re.I)
_SUSPECT_M_UNIT_RE = re.compile(
    r"\b\d+(?:\.\d+)?\s*(?:m[gGLlF]\b|mF\s*cm|mg\s*L\s*[-−]1|m\s*mol\s*L)",
)


def _detect_symbol_unit_pages(doc, max_p):
    """扫描 PyMuPDF span 字体元数据，识别 RSC/Elsevier 等 PDF 用 Adobe Symbol 字体把 μ 静默抽成 m 的页码。"""
    flagged = []
    for idx in range(max_p):
        page = doc[idx]
        try:
            d = page.get_text("dict") or {}
        except Exception:
            continue
        has_symbol_font = False
        has_symbol_m = False
        for blk in d.get("blocks") or []:
            if blk.get("type") != 0:
                continue
            for line in blk.get("lines") or []:
                spans = line.get("spans") or []
                line_text = "".join(s.get("text") or "" for s in spans)
                for s in spans:
                    font = str(s.get("font") or "")
                    txt = str(s.get("text") or "")
                    if _SYMBOL_FONT_RE.search(font):
                        has_symbol_font = True
                        if ("m" in txt or "\uf06d" in txt) and (
                            _SUSPECT_M_UNIT_RE.search(line_text)
                            or re.search(r"\bm(?:g|l|L|F|A|V|M|m|mol|s)\b", line_text)
                        ):
                            has_symbol_m = True
                            break
                if has_symbol_m:
                    break
            if has_symbol_m:
                break
        if has_symbol_m:
            flagged.append(idx + 1)
        elif has_symbol_font:
            # 兜底：整页含 Symbol 字体且抽取文本含极可疑的 40 mF cm-2 / mg L-1（伴 Symbol 字体）
            raw = page.get_text() or ""
            if re.search(r"\b\d+(?:\.\d+)?\s*(?:mF\s*cm|mg\s*L\s*[-−]1)", raw):
                flagged.append(idx + 1)
    return flagged


def _flatten_key_args(val):
    if not val:
        return []
    items = val if isinstance(val, (list, tuple)) else [val]
    out = []
    for item in items:
        for tok in re.split(r"[,，\s]+", str(item)):
            t = tok.strip()
            if t:
                out.append(t)
    return out


def cmd_extract_text(args):
    """从项目根 papers/ 或 Zotero 只读附件定位 PDF，用 PyMuPDF 抽文本并自动清除控制字符，
    同时自动扫描前两页检测 Supporting Information（报 SI_ONLY 警告），
    并扫描 Symbol 字体 μ→m 单位乱码（报 UNIT_FONT_WARNING 提示渲染页图核对）。"""
    pymupdf = _open_pymupdf()
    if pymupdf is None:
        print("✗ 未安装 PyMuPDF（pymupdf / fitz），无法抽取 PDF 文本。", file=sys.stderr)
        return 2
    root = project_root(args.root)
    records = [r for r in read_records(Path(args.json)) if decision_of(r) == "included"]
    index_rows = _load_index_rows(Path(args.index))
    bib_path = Path(args.bib)
    key_map = _resolve_bib_key_map(records, index_rows, bib_path if bib_path.is_file() else None)

    raw_keys = _flatten_key_args(args.keys) + _flatten_key_args(args.targets)
    wanted_norm = {k.lstrip("@").casefold() for k in raw_keys}

    if wanted_norm:
        selected = []
        matched_tokens = set()
        for rec in records:
            rid = as_text(rec.get("id"))
            bk = key_map.get(rid, "")
            doi = record_doi(rec)
            tokens = {t.casefold() for t in (rid, bk, doi) if t}
            hit = tokens & wanted_norm
            if hit:
                selected.append((rec, bk or rid))
                matched_tokens |= hit
        unmatched = [k for k in raw_keys if k.lstrip("@").casefold() not in matched_tokens]
    else:
        selected = [(rec, key_map.get(as_text(rec.get("id")), as_text(rec.get("id")))) for rec in records]
        unmatched = []

    out_dir = Path(args.out_dir) if args.out_dir else None
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)

    results = []
    for rec, bk in selected:
        rid = as_text(rec.get("id"))
        have = existing_pdf(rec, root)
        si_rel = ""
        if not have:
            cand = _match_project_paper(rec, root, skip_si=False)
            if cand and is_supporting_info(root / cand):
                si_rel = cand
        chosen = have or si_rel
        if not chosen:
            results.append({"bibKey": bk, "id": rid, "status": "MISSING", "pdf": "", "absPath": ""})
            continue
        p = Path(chosen) if Path(chosen).is_absolute() else (root / chosen)
        abs_path = p.resolve().as_posix()
        try:
            with pymupdf.open(str(p)) as doc:
                pages = doc.page_count
                si_reason = "文件名命中 Supporting Information" if _SI_NAME_RE.search(p.stem) else _detect_si_pages(doc)
                if si_rel and not si_reason:
                    si_reason = "is_supporting_info 判为 Supporting Information"
                max_p = min(pages, args.max_pages) if args.max_pages and args.max_pages > 0 else pages
                unit_font_pages = _detect_symbol_unit_pages(doc, max_p)
                chunks = []
                for idx in range(max_p):
                    page_text = strip_control_chars(doc[idx].get_text() or "")
                    chunks.append(f"=== Page {idx + 1}/{pages} ===\n{page_text.strip()}")
                clean_text = "\n\n".join(chunks).strip() + "\n"
        except Exception as err:
            results.append({
                "bibKey": bk, "id": rid, "status": "ERROR", "pdf": chosen, "absPath": abs_path,
                "warning": f"PDF 抽取失败：{err}",
            })
            continue

        status = "SI_ONLY" if si_reason else "OK"
        entry = {
            "bibKey": bk,
            "id": rid,
            "status": status,
            "pdf": chosen,
            "absPath": abs_path,
            "pages": pages,
            "chars": len(clean_text),
        }
        warn_parts = []
        if si_reason:
            warn_parts.append(f"SI-ONLY（非正文全文）：{si_reason}")
            entry["supportingInfoFile"] = p.name
        if unit_font_pages:
            pg_str = ", ".join(str(x) for x in unit_font_pages[:12])
            unit_warn = f"UNIT_FONT_WARNING：第 {pg_str} 页检测到 Symbol 字体疑似将 μ 抽成 m（μg/μL/μF/μm → mg/mL/mF/mm），请渲染对应页图像目视核对单位"
            warn_parts.append(unit_warn)
            entry["unitFontWarning"] = True
            entry["unitFontPages"] = unit_font_pages
            clean_text = f"# [{unit_warn}]\n\n" + clean_text
        if warn_parts:
            entry["warning"] = "；".join(warn_parts)
        if out_dir:
            safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", bk or rid)
            dest = out_dir / f"{safe_name}.txt"
            atomic_write(dest, clean_text)
            entry["outPath"] = dest.as_posix()
        elif args.stdout:
            entry["text"] = clean_text
        results.append(entry)

    payload = {"root": root.as_posix(), "items": results}
    if unmatched:
        payload["unmatchedKeys"] = unmatched
    ok_n = sum(1 for r in results if r["status"] == "OK")
    si_n = sum(1 for r in results if r["status"] == "SI_ONLY")
    miss_n = sum(1 for r in results if r["status"] == "MISSING")
    uf_keys = [r["bibKey"] for r in results if r.get("unitFontWarning")]
    manifest_arg = getattr(args, "manifest", "") or ""
    if manifest_arg:
        mpath = Path(manifest_arg)
        mpath.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(mpath, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        compact = {
            "root": root.as_posix(),
            "manifest": mpath.as_posix(),
            "total": len(results),
            "ok": ok_n,
            "siOnly": si_n,
            "missing": miss_n,
            "unitFontWarnings": uf_keys,
        }
        if unmatched:
            compact["unmatchedKeys"] = unmatched
        print(json.dumps(compact, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    uf_note = f"，Symbol 字体单位告警 {len(uf_keys)} 篇（{', '.join(uf_keys[:6])}）" if uf_keys else ""
    print(
        f"抽取完成：正文 {ok_n} 篇，SI-ONLY 警告 {si_n} 篇，缺全文 {miss_n} 篇{uf_note}（已自动清洗控制字符）。",
        file=sys.stderr,
    )
    return 0


def _split_md_row(line):
    """按未转义的 | 拆 Markdown 表格行，返回去掉首尾空槽后的单元格列表。"""
    s = line.strip()
    if not s.startswith("|"):
        return None
    cells = []
    cur = []
    escaped = False
    for ch in s[1:]:
        if escaped:
            cur.append(ch)
            escaped = False
            continue
        if ch == "\\":
            cur.append(ch)
            escaped = True
            continue
        if ch == "|":
            cells.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    tail = "".join(cur).strip()
    if tail:
        cells.append(tail)
    return cells


def _escape_md_cell(value):
    text = re.sub(r"\s*\r?\n\s*", " ", str(value if value is not None else "")).strip()
    # 只转义尚未转义的 |（避免把已有的 \| 误变成 \\| 反而在 Markdown 里拆列）
    return re.sub(r"(?<!\\)\|", r"\|", text)


def _parse_md_table(text):
    """定位文件里第一张 Markdown 表格：返回 (lines, header_idx, sep_idx, end_idx, headers, rows)。
    rows 每项为 (line_idx, cells)。找不到表格返回 None。"""
    lines = text.splitlines()
    for i in range(len(lines) - 1):
        if not lines[i].lstrip().startswith("|"):
            continue
        sep = lines[i + 1].strip()
        if not sep.startswith("|") or not re.match(r"^\|[\s:|-]+\|?$", sep):
            continue
        headers = _split_md_row(lines[i]) or []
        if not headers:
            continue
        rows = []
        j = i + 2
        while j < len(lines) and lines[j].lstrip().startswith("|"):
            cells = _split_md_row(lines[j])
            if cells is not None:
                rows.append((j, cells))
            j += 1
        return lines, i, i + 1, j, headers, rows
    return None


def _key_col_index(headers):
    """定位宽表里存放 @bibKey 的列号：notes/skim.md 在第 0 列（键），notes/extraction.md 在「来源 [@键]」列。"""
    for idx, h in enumerate(headers):
        norm = h.strip().lower()
        if norm in ("键", "key", "bibkey", "citekey", "来源", "来源 [@键]", "来源[@键]"):
            return idx
        if "@键" in h or "bibkey" in norm or "citekey" in norm:
            return idx
    for idx, h in enumerate(headers):
        if "来源" in h:
            return idx
    return 0


def _format_key_cell(bk, header):
    bk = bk.lstrip("@").strip()
    if "[" in header:
        return f"[@{bk}]"
    return f"@{bk}"


def _row_bib_key(cells, key_col=0):
    if not cells:
        return ""
    if 0 <= key_col < len(cells):
        m = re.search(r"@([A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+)*)", cells[key_col])
        if m:
            return m.group(1)
        raw = cells[key_col].strip().strip("`[]").lstrip("@")
        if key_col == 0 and re.match(r"^[A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+)*$", raw):
            return raw
    # 兜底：若该行被未转义 | 拆歪，反查 [@Key]
    for c in reversed(cells):
        m = re.search(r"\[@([A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+)*)\]", c)
        if m:
            return m.group(1)
    return ""


def cmd_table(args):
    """按 @bibKey 读取、原地更新或移出 Markdown 宽表（自动识别 notes/skim.md 首列「键」与 notes/extraction.md「来源 [@键]」列，
    支持同一篇多行抽取表），避免大文件（>46 KB）分页读取与脆弱的整行文本替换。"""
    path = Path(args.file)
    if not path.is_file():
        print(f"✗ 找不到表格文件：{path}", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    parsed = _parse_md_table(text)
    if not parsed:
        print(f"✗ {path} 里没有找到 Markdown 表格", file=sys.stderr)
        return 1
    lines, header_idx, sep_idx, end_idx, headers, rows = parsed
    key_col_idx = _key_col_index(headers)
    key_col = headers[key_col_idx]

    if args.get:
        targets = [k.lstrip("@") for k in _flatten_key_args(args.get)]
        by_key = {}
        for line_idx, cells in rows:
            bk = _row_bib_key(cells, key_col_idx)
            if bk:
                padded = cells + [""] * max(0, len(headers) - len(cells))
                by_key.setdefault(bk.casefold(), []).append(
                    (line_idx + 1, {headers[i]: padded[i] for i in range(len(headers))})
                )
        hit_rows = []
        missing = []
        for k in targets:
            recs = by_key.get(k.casefold())
            if recs:
                for line_no, cols in recs:
                    hit_rows.append({"bibKey": k, "line": line_no, "columns": cols})
            else:
                missing.append(k)
        print(json.dumps({
            "file": path.as_posix(),
            "keyColumn": key_col,
            "headers": headers,
            "totalRows": len(rows),
            "rows": hit_rows,
            "missing": missing,
        }, ensure_ascii=False, indent=2))
        return 0

    if args.upsert:
        raw_patch = sys.stdin.read() if args.upsert == "-" else Path(args.upsert).read_text(encoding="utf-8-sig")
        patch_data = json.loads(raw_patch)
        if isinstance(patch_data, dict):
            patch_items = [patch_data]
        elif isinstance(patch_data, list):
            patch_items = patch_data
        else:
            raise ValueError("upsert JSON 应是对象或对象数组")
        row_positions_by_key = {}
        row_pos_by_line = {}
        for idx_in_rows, (line_idx, cells) in enumerate(rows):
            row_pos_by_line[line_idx + 1] = idx_in_rows
            bk = _row_bib_key(cells, key_col_idx)
            if bk:
                row_positions_by_key.setdefault(bk.casefold(), []).append(idx_in_rows)
        updated, appended = [], []
        new_lines = list(lines)
        appended_lines = []
        for item in patch_items:
            if not isinstance(item, dict):
                continue
            cols = item.get("columns") if isinstance(item.get("columns"), dict) else item
            raw_bk = as_text(item.get("bibKey") or cols.get(key_col) or cols.get("键") or cols.get("key"))
            m_bk = re.search(r"@([A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+)*)", raw_bk)
            bk = m_bk.group(1) if m_bk else raw_bk.strip().strip("`[]").lstrip("@")
            if not bk:
                raise ValueError("upsert 项缺少 bibKey（或键列）")
            existing_pos = None
            if item.get("append") is True:
                existing_pos = None
            elif isinstance(item.get("line"), int) and item["line"] in row_pos_by_line:
                existing_pos = row_pos_by_line[item["line"]]
            else:
                cands = row_positions_by_key.get(bk.casefold(), [])
                if len(cands) == 1:
                    existing_pos = cands[0]
                elif len(cands) > 1:
                    match_spec = item.get("match") if isinstance(item.get("match"), dict) else None
                    if match_spec:
                        matched = []
                        for pos in cands:
                            _, cur_cells = rows[pos]
                            padded_cur = cur_cells + [""] * max(0, len(headers) - len(cur_cells))
                            row_map = {headers[i]: padded_cur[i] for i in range(len(headers))}
                            if all(str(needle) in row_map.get(col_name, "") for col_name, needle in match_spec.items()):
                                matched.append(pos)
                        if len(matched) == 1:
                            existing_pos = matched[0]
                        else:
                            raise ValueError(f"@{bk} 在 {path} 有多行且 match 命中 {len(matched)} 行，请改用 line 指定行号")
                    else:
                        line_nums = [rows[p][0] + 1 for p in cands]
                        raise ValueError(f"@{bk} 在 {path} 有多行（L{', L'.join(map(str, line_nums))}），请用 line / match 指定要改哪一行，或传 append: true 追加新行")
            if existing_pos is not None:
                line_idx, cur_cells = rows[existing_pos]
                padded = list(cur_cells) + [""] * max(0, len(headers) - len(cur_cells))
                for col_i, h in enumerate(headers):
                    if h in cols and cols[h] is not None:
                        val = cols[h]
                        if col_i == key_col_idx and "@" not in str(val):
                            val = _format_key_cell(str(val), key_col)
                        padded[col_i] = _escape_md_cell(val)
                if "@" not in padded[key_col_idx]:
                    padded[key_col_idx] = _format_key_cell(bk, key_col)
                rendered = "| " + " | ".join(padded[:len(headers)]) + " |"
                new_lines[line_idx] = rendered
                rows[existing_pos] = (line_idx, padded[:len(headers)])
                updated.append(bk)
            else:
                padded = []
                for col_i, h in enumerate(headers):
                    if col_i == key_col_idx:
                        raw_key_val = cols.get(h) if h in cols and cols[h] is not None else None
                        val = raw_key_val if (raw_key_val and "@" in str(raw_key_val)) else _format_key_cell(bk, key_col)
                        padded.append(_escape_md_cell(val))
                    elif h in cols and cols[h] is not None:
                        padded.append(_escape_md_cell(cols[h]))
                    else:
                        padded.append("—")
                rendered = "| " + " | ".join(padded) + " |"
                appended_lines.append(rendered)
                appended.append(bk)
        if appended_lines:
            new_lines = new_lines[:end_idx] + appended_lines + new_lines[end_idx:]
        atomic_write(path, "\n".join(new_lines) + "\n")
        print(json.dumps({"file": path.as_posix(), "keyColumn": key_col, "updated": updated, "appended": appended}, ensure_ascii=False, indent=2))
        return 0

    if getattr(args, "remove", None):
        targets = [k.lstrip("@") for k in _flatten_key_args(args.remove)]
        want = {k.casefold() for k in targets}
        drop_indices = set()
        found_keys = set()
        for line_idx, cells in rows:
            bk = _row_bib_key(cells, key_col_idx)
            if bk and bk.casefold() in want:
                drop_indices.add(line_idx)
                found_keys.add(bk.casefold())
        removed = [k for k in targets if k.casefold() in found_keys]
        not_found = [k for k in targets if k.casefold() not in found_keys]
        if drop_indices:
            new_lines = [line for idx, line in enumerate(lines) if idx not in drop_indices]
            atomic_write(path, "\n".join(new_lines) + "\n")
        print(json.dumps({"file": path.as_posix(), "keyColumn": key_col, "removed": removed, "notFound": not_found}, ensure_ascii=False, indent=2))
        return 0

    if getattr(args, "to_csv", ""):
        csv_path = Path(args.to_csv)
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([h.replace("\\|", "|") for h in headers])
        for _, cells in rows:
            padded = list(cells) + [""] * max(0, len(headers) - len(cells))
            writer.writerow([c.replace("\\|", "|") for c in padded[:len(headers)]])
        atomic_write(csv_path, buf.getvalue())
        print(json.dumps({
            "file": path.as_posix(),
            "csv": csv_path.as_posix(),
            "headers": headers,
            "totalRows": len(rows),
        }, ensure_ascii=False, indent=2))
        return 0

    print(json.dumps({"file": path.as_posix(), "keyColumn": key_col, "headers": headers, "totalRows": len(rows)}, ensure_ascii=False, indent=2))
    return 0


def cmd_index_update(args):
    """按 JSON 补丁批量更新 notes/index.json（按 bibKey 或 id 匹配）：
    支持更新 reviewStatus / notePath / fulltextStatus / forSections / pdfPath / cutoffYear / supportingInfoOnly / supportingInfoFile，
    当 reviewStatus 变为 reviewed 时默认移除 skimmed，免手写一次性更新脚本。"""
    idx_path = Path(args.index)
    if not idx_path.is_file():
        raise ValueError(f"找不到索引文件：{idx_path}")
    raw_idx = json.loads(idx_path.read_text(encoding="utf-8-sig"))
    container_key = None
    if isinstance(raw_idx, list):
        rows = raw_idx
    elif isinstance(raw_idx, dict):
        for k in ("notes", "records", "items", "papers", "entries"):
            if isinstance(raw_idx.get(k), list):
                container_key = k
                rows = raw_idx[k]
                break
        else:
            raise ValueError(f"{idx_path} 结构不含已知列表键")
    else:
        raise ValueError(f"{idx_path} 应是 JSON 数组或对象")

    raw_patch = sys.stdin.read() if args.patch == "-" else Path(args.patch).read_text(encoding="utf-8-sig")
    patch_data = json.loads(raw_patch)
    patch_items = [patch_data] if isinstance(patch_data, dict) else (patch_data if isinstance(patch_data, list) else None)
    if patch_items is None:
        raise ValueError("patch JSON 应是对象或对象数组")

    by_key = {}
    by_id = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        bk = as_text(row.get("bibKey") or row.get("key")).casefold()
        rid = as_text(row.get("id")).casefold()
        if bk:
            by_key[bk] = row
        if rid:
            by_id[rid] = row

    updated, not_found = [], []
    for item in patch_items:
        if not isinstance(item, dict):
            continue
        bk_raw = as_text(item.get("bibKey") or item.get("key")).lstrip("@")
        rid_raw = as_text(item.get("id"))
        target = (by_key.get(bk_raw.casefold()) if bk_raw else None) or (by_id.get(rid_raw.casefold()) if rid_raw else None)
        if target is None:
            not_found.append(bk_raw or rid_raw or "<unknown>")
            continue
        for field in ("reviewStatus", "notePath", "fulltextStatus", "pdfPath", "cutoffYear", "supportingInfoOnly", "supportingInfoFile", "kind"):
            if field in item and item[field] is not None:
                target[field] = item[field]
        if "forSections" in item and item["forSections"] is not None:
            incoming = [str(s).strip() for s in (item["forSections"] if isinstance(item["forSections"], list) else [item["forSections"]]) if str(s).strip()]
            if item.get("replaceForSections"):
                merged = list(dict.fromkeys(incoming))
            else:
                prev = [str(s).strip() for s in (target.get("forSections") if isinstance(target.get("forSections"), list) else []) if str(s).strip()]
                merged = list(dict.fromkeys(prev + incoming))
            target["forSections"] = merged
        if as_text(target.get("reviewStatus")).casefold() == "reviewed" and not item.get("keepSkimmed"):
            target.pop("skimmed", None)
        elif "skimmed" in item:
            if item["skimmed"]:
                target["skimmed"] = True
            else:
                target.pop("skimmed", None)
        updated.append(as_text(target.get("bibKey") or target.get("id")))

    out_obj = raw_idx if container_key is None else {**raw_idx, container_key: rows}
    atomic_write(idx_path, json.dumps(out_obj, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"file": idx_path.as_posix(), "updated": updated, "notFound": not_found}, ensure_ascii=False, indent=2))
    return 0


_MD_FENCE_RE = re.compile(r"```[\s\S]*?```|~~~[\s\S]*?~~~")
_MD_INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
# 前导不能是字母/数字/下划线/点/加减号/上下标/右括号（跳过 WB₂@WS₂、CoB@NC、Ni(OH)₂@C、a@b.com 等化学负载与邮箱写法）；
# 键名仅取 ASCII 字符（Python \w 默认吞中文，不能用 \w），且不吃掉尾部冒号/连字符
_MD_CITE_RE = re.compile(
    r"(?<![A-Za-z0-9_.+\-\u00b2\u00b3\u00b9\u2070-\u209f\)\]])@([A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+)*)"
)
_META_CITE_PLACEHOLDERS = {"bibkey", "key", "citekey", "example", "author2024"}


def _extract_md_citekeys(text):
    """抽取 Markdown 正文中的 @citekey（跳过围栏代码块、化学负载 A@B 与邮箱；
    保留行内反引号里的 `@Key` 写法，因为 notes/handoff.md 与 notes/angles.md 常用反引号包裹引用键）。"""
    stripped = _MD_FENCE_RE.sub(" ", text)
    out = []
    for m in _MD_CITE_RE.finditer(stripped):
        key = m.group(1)
        if key.casefold() in _META_CITE_PLACEHOLDERS:
            continue
        out.append(key)
    return out


def _check_bib_syntax(text):
    """检查 references.bib 基本语法：条目花括号是否成对闭合、字段之间是否缺逗号。"""
    errs = []
    pos = 0
    n = len(text)
    for m in re.finditer(r"@(\w+)\s*\{\s*([^,\s}]*)\s*,", text):
        if m.start() < pos:
            continue
        between = text[pos:m.start()]
        if "}" in between:
            line_no = text.count("\n", 0, pos + between.index("}")) + 1
            errs.append(f"references.bib L{line_no} 存在多余的闭合花括号 `}}`")
        etype = m.group(1).lower()
        key = m.group(2) or "<无键>"
        depth, i = 1, m.end()
        while i < n and depth:
            ch = text[i]
            if ch == "\\":
                i += 2
                continue
            depth += (ch == "{") - (ch == "}")
            i += 1
        if depth != 0:
            line_no = text.count("\n", 0, m.start()) + 1
            errs.append(f"references.bib [@{key}]（L{line_no}）花括号未闭合")
            return errs
        pos = i
        if etype in ("comment", "string", "preamble"):
            continue
        # 在条目体内顺序扫描字段，检查字段值之后是否缺少逗号
        body_start = m.end()
        body_end = i - 1
        j = body_start
        while j < body_end:
            while j < body_end and text[j] in " \t\r\n,":
                j += 1
            if j >= body_end:
                break
            fm = re.match(r"([A-Za-z][\w-]*)\s*=\s*", text[j:body_end])
            if not fm:
                break
            fname = fm.group(1)
            j += fm.end()
            # 支持 `#` 拼接的 BibTeX 值段
            while j < body_end:
                while j < body_end and text[j] in " \t\r\n":
                    j += 1
                if j >= body_end:
                    break
                ch = text[j]
                if ch == "{":
                    d = 1
                    j += 1
                    while j < body_end and d:
                        if text[j] == "\\":
                            j += 2
                            continue
                        d += (text[j] == "{") - (text[j] == "}")
                        j += 1
                elif ch == '"':
                    j += 1
                    while j < body_end:
                        if text[j] == "\\":
                            j += 2
                            continue
                        if text[j] == '"':
                            j += 1
                            break
                        j += 1
                else:
                    bm = re.match(r"[^\s,}#]+", text[j:body_end])
                    if not bm:
                        break
                    j += bm.end()
                while j < body_end and text[j] in " \t\r\n":
                    j += 1
                if j < body_end and text[j] == "#":
                    j += 1
                    continue
                break
            while j < body_end and text[j] in " \t\r\n":
                j += 1
            if j < body_end and text[j] != ",":
                line_no = text.count("\n", 0, j) + 1
                errs.append(f"references.bib [@{key}] 字段 `{fname}` 后缺少逗号（L{line_no}）")
                # 跳到下一行继续查，避免同一条目死循环
                nl = text.find("\n", j, body_end)
                j = body_end if nl < 0 else nl + 1
    if "}" in text[pos:]:
        line_no = text.count("\n", 0, pos + text[pos:].index("}")) + 1
        errs.append(f"references.bib L{line_no} 存在多余的闭合花括号 `}}`")
    return errs


def cmd_validate(args):
    """精读步一键只读验收脚本：
    1. papers/included.json vs notes/index.json 对齐（兼容 year 为 str/int）；
    2. 已写笔记 notePath 存在性 + 「> 来源 PDF：」按项目根 papers/ 与 Zotero 路径校验（含 SI-only 告警）；
    3. notes/skim.md 与 notes/extraction.md 表列数一致与 @bibKey 覆盖核查；
    4. references.bib 覆盖全部纳入篇、无重复键、无 excluded 残留、题录缺摘要告警。"""
    root = project_root(args.root)
    json_path = Path(args.json)
    index_path = Path(args.index)
    bib_path = Path(args.bib)
    skim_path = Path(args.skim)
    extraction_path = Path(args.extraction)
    errors, warnings = [], []

    records = read_records(json_path)
    included = [r for r in records if decision_of(r) == "included"]
    excluded_records = [r for r in records if decision_of(r) == "excluded"]
    excluded_ids = {as_text(r.get("id")) for r in excluded_records if as_text(r.get("id"))}
    included_by_id = {as_text(r.get("id")): r for r in included if as_text(r.get("id"))}
    excluded_dois = {record_doi(r) for r in excluded_records if record_doi(r)}
    excluded_titles = {
        re.sub(r"\W+", "", ris_value(r.get("title")).casefold())
        for r in excluded_records
        if not record_doi(r) and len(re.sub(r"\W+", "", ris_value(r.get("title")).casefold())) >= 8
    }
    excluded_keys_lower = set()
    for r in excluded_records:
        bk = as_text(r.get("bibKey"))
        if bk:
            excluded_keys_lower.add(bk.casefold())
        else:
            excluded_keys_lower.add(bib_key(r, set()).casefold())

    # 统计 year 类型混用（只提示，脚本内部统一走 year_of 不炸）
    non_num_years = [as_text(r.get("id")) for r in included if r.get("year") is not None and year_of(r.get("year")) is None and meaningful(r.get("year"))]
    if non_num_years:
        warnings.append(f"included.json 有 {len(non_num_years)} 条 year 无法解析为 4 位年份：{', '.join(non_num_years[:5])}")

    index_rows = _load_index_rows(index_path)
    if not index_path.is_file():
        errors.append(f"缺少 {index_path}")
    index_by_id = {}
    for i, row in enumerate(index_rows, 1):
        rid = as_text(row.get("id"))
        if not rid:
            errors.append(f"notes/index.json 第 {i} 行缺少 id")
            continue
        if rid in index_by_id:
            errors.append(f"notes/index.json 存在重复 id：{rid}")
        index_by_id[rid] = row
        if rid in excluded_ids:
            errors.append(f"notes/index.json 残留已排除篇目：{rid}")

    for rid in included_by_id:
        if rid not in index_by_id:
            errors.append(f"included.json 纳入篇目 {rid} 未写入 notes/index.json")

    valid_ft = {"fulltext", "abstract-only", "unavailable"}
    valid_rs = {"pending", "blocked", "reviewed"}
    key_map = _resolve_bib_key_map(included, index_rows, bib_path if bib_path.is_file() else None)
    skimmed_keys = set()

    for rid, row in index_by_id.items():
        if rid not in included_by_id:
            continue
        ft = as_text(row.get("fulltextStatus"))
        rs = as_text(row.get("reviewStatus"))
        bk = as_text(row.get("bibKey")) or key_map.get(rid, "")
        note_path_str = as_text(row.get("notePath"))
        if ft not in valid_ft:
            errors.append(f"notes/index.json [{bk or rid}] fulltextStatus 非法：「{ft}」")
        if rs not in valid_rs:
            errors.append(f"notes/index.json [{bk or rid}] reviewStatus 非法：「{rs}」")
        if row.get("skimmed") is True and bk:
            skimmed_keys.add(bk.casefold())
        if rs == "reviewed" and not note_path_str:
            errors.append(f"notes/index.json [{bk or rid}] reviewStatus=reviewed 但 notePath 为空")
        if note_path_str:
            ws_base = index_path.resolve().parent.parent if index_path.resolve().parent.name == "notes" else Path.cwd()
            np = Path(note_path_str) if Path(note_path_str).is_absolute() else (ws_base / note_path_str)
            if not np.is_file():
                errors.append(f"notes/index.json [{bk or rid}] 指向的笔记不存在：{note_path_str}")
            else:
                body = np.read_text(encoding="utf-8", errors="replace")
                if len(body.strip()) < 20:
                    errors.append(f"笔记内容过短（疑似空占位）：{note_path_str}")
                for line in body.splitlines()[:10]:
                    m = _SOURCE_PDF_RE.match(line.strip())
                    if m:
                        ref_pdf = m.group(1).strip()
                        pdf_path = Path(ref_pdf) if Path(ref_pdf).is_absolute() else (root / ref_pdf)
                        if not pdf_path.is_file():
                            errors.append(f"笔记 {note_path_str} 的来源 PDF 不存在（已对照项目根 {root}）：{ref_pdf}")
                        elif is_supporting_info(pdf_path):
                            warnings.append(f"笔记 {note_path_str} 的来源 PDF 为 Supporting Information（非正文）：{ref_pdf}")
                        break

    # 校验宽表：notes/skim.md 与 notes/extraction.md
    for label, tpath, check_skimmed in (("skim.md", skim_path, True), ("extraction.md", extraction_path, False)):
        if not tpath.is_file():
            continue
        parsed = _parse_md_table(tpath.read_text(encoding="utf-8-sig", errors="replace"))
        if not parsed:
            warnings.append(f"{tpath} 存在但未识别到 Markdown 表格")
            continue
        _, _, _, _, headers, rows = parsed
        bad_cols = [line_idx + 1 for line_idx, cells in rows if len(cells) != len(headers)]
        if bad_cols:
            errors.append(
                f"{tpath} 有 {len(bad_cols)} 行列数与表头（{len(headers)} 列）不一致（首行 L{bad_cols[0]}；"
                f"若单元格含绝对值如 |ΔG| 请转义为 \\| 或改用 `lit_records.py table --upsert` 写入）"
            )
        key_col_idx = _key_col_index(headers)
        table_keys = {_row_bib_key(cells, key_col_idx).casefold() for _, cells in rows if _row_bib_key(cells, key_col_idx)}
        if check_skimmed and skimmed_keys:
            missing_skim = sorted(k for k in skimmed_keys if k not in table_keys)
            if missing_skim:
                errors.append(f"{tpath} 缺少 {len(missing_skim)} 篇 index.json 标为 skimmed 的条目：{', '.join(missing_skim[:8])}")
        # 已排除篇目不得残留在宽表（仅排除不在纳入键集合里的，避免同名作者年份误伤）
        included_keys_lower = {
            (as_text(index_by_id.get(rid, {}).get("bibKey")) or key_map.get(rid, "")).casefold()
            for rid in included_by_id
        }
        pure_excluded_keys = excluded_keys_lower - included_keys_lower
        stale_in_table = sorted(k for k in table_keys if k in pure_excluded_keys)
        if stale_in_table:
            errors.append(
                f"{tpath} 仍残留 {len(stale_in_table)} 条已排除篇目：{', '.join(stale_in_table[:8])}"
                f"（可用 `lit_records.py table --file {tpath} --remove ...` 移出）"
            )

    # 校验 references.bib
    bib_keys = set()
    if not bib_path.is_file():
        errors.append(f"缺少 {bib_path}")
    else:
        bib_text = bib_path.read_text(encoding="utf-8-sig", errors="replace")
        errors.extend(_check_bib_syntax(bib_text))
        spans = entry_spans(bib_text)
        seen_keys, dup_keys = set(), []
        no_abs = []
        excluded_in_bib = []
        for k, start, end in spans:
            kl = k.lower()
            if kl in seen_keys:
                dup_keys.append(k)
            seen_keys.add(kl)
            bib_keys.add(kl)
            fields = bib_fields_of(bib_text[start:end])
            doi = bare_doi(fields.get("doi", ("",))[0])
            title_norm = re.sub(r"\W+", "", re.sub(r"[{}]", "", fields.get("title", ("",))[0]).casefold())
            if (doi and doi in excluded_dois) or (not doi and title_norm and title_norm in excluded_titles):
                excluded_in_bib.append(k)
                excluded_keys_lower.add(kl)
            ab = fields.get("abstract", ("",))[0]
            if not meaningful(ab):
                no_abs.append(k)
        if dup_keys:
            errors.append(f"references.bib 存在重复键：{', '.join(dup_keys[:8])}")
        if excluded_in_bib:
            errors.append(f"references.bib 仍残留 {len(excluded_in_bib)} 条已排除条目：{', '.join(excluded_in_bib[:8])}（跑 `lit_records.py bib` 移出）")
        missing_bib = []
        for rid in included_by_id:
            bk = as_text(index_by_id.get(rid, {}).get("bibKey")) or key_map.get(rid, "")
            if bk and bk.lower() not in bib_keys:
                missing_bib.append(bk)
        if missing_bib:
            errors.append(f"references.bib 缺少 {len(missing_bib)} 篇纳入条目：{', '.join(missing_bib[:10])}")
        if no_abs:
            warnings.append(f"references.bib 有 {len(no_abs)} 条缺少 abstract（可核对正文 PDF 补全）：{', '.join(no_abs[:8])}")

    # 校验 notes/handoff.md 与 notes/angles.md：不含已排除键，且 @citekey 均在 references.bib 中可解析（忽略 A@B 化学式）
    if bib_keys:
        included_keys_lower = {
            (as_text(index_by_id.get(rid, {}).get("bibKey")) or key_map.get(rid, "")).casefold()
            for rid in included_by_id
        }
        pure_excluded_keys = excluded_keys_lower - included_keys_lower
        for doc_path in (Path(args.handoff), Path(args.angles)):
            if not doc_path.is_file():
                continue
            cited = _extract_md_citekeys(doc_path.read_text(encoding="utf-8-sig", errors="replace"))
            seen_bad, seen_excl = [], []
            for ck in cited:
                cl = ck.casefold()
                if cl in pure_excluded_keys and ck not in seen_excl:
                    seen_excl.append(ck)
                elif cl not in bib_keys and ck not in seen_bad:
                    seen_bad.append(ck)
            if seen_excl:
                errors.append(f"{doc_path} 仍引用已排除键：{', '.join('@' + k for k in seen_excl[:8])}")
            if seen_bad:
                errors.append(f"{doc_path} 存在 references.bib 中找不到的引用键：{', '.join('@' + k for k in seen_bad[:8])}")

    if args.json_out:
        summary = {
            "root": root.as_posix(),
            "included": len(included),
            "indexed": len(index_rows),
            "errors": errors,
            "warnings": warnings,
            "ok": len(errors) == 0,
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        for w in warnings:
            print(f"! {w}")
        for e in errors:
            print(f"✗ {e}")
        if errors:
            print(f"精读校验未通过：{len(errors)} 处错误，{len(warnings)} 处告警。")
        else:
            print(f"精读校验通过：纳入 {len(included)} 篇、索引 {len(index_rows)} 条、0 处错误（{len(warnings)} 处告警；项目根 {root}）。")
    return 1 if errors else 0


_OUTLINE_CROSSREF_PREFIXES = ("fig-", "tbl-", "sec-", "eq-", "lst-", "thm-", "lem-", "def-")
_OUTLINE_LOG_HEADING_RE = re.compile(r"改了什么|修改记录|变更记录|改动记录")
_OUTLINE_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_OUTLINE_BOLD_HEADING_RE = re.compile(r"^\*\*([^*]+)\*\*$")
_OUTLINE_TIER_MARK_RE = re.compile(r"(可写正文|可写|仅线索|线索)[^：:\n]{0,24}[：:]")
_OUTLINE_CITE_RE = re.compile(
    r"(?<![A-Za-z0-9_.+\-\u00b2\u00b3\u00b9\u2070-\u209f\\])@([A-Za-z_][A-Za-z0-9_]*(?:[:.\-][A-Za-z0-9_]+)*)"
)
_OUTLINE_YEAR_RE = re.compile(r"(?:18|19|20)\d{2}")


def _mask_outline_inline(line):
    line = re.sub(r"`[^`]*`", lambda m: " " * len(m.group(0)), line)
    line = re.sub(r"<!--.*?-->", lambda m: " " * len(m.group(0)), line)
    line = re.sub(r"\]\([^)\n]*\)", lambda m: "]" + " " * (len(m.group(0)) - 1), line)
    return line


def _outline_cited_keys_line(line):
    clean = _mask_outline_inline(line)
    out = []
    for m in _OUTLINE_CITE_RE.finditer(clean):
        key = m.group(1)
        if key.isdigit() or key.casefold().startswith(_OUTLINE_CROSSREF_PREFIXES):
            continue
        if key.casefold() in _META_CITE_PLACEHOLDERS:
            continue
        before = clean[: m.start()].rstrip()
        bracketed = bool(before) and before[-1] in "[;-"
        if not bracketed and not _OUTLINE_YEAR_RE.search(key):
            continue
        out.append(key)
    return out


def _outline_lead_number(text):
    t = re.sub(r"^[\s§第]+", "", text or "")
    m = re.match(r"(\d+(?:\.\d+)*)", t)
    return m.group(1) if m else ""


def _outline_row_numbers(label):
    out = []
    for part in re.split(r"[/／、+＋]", label or ""):
        num = _outline_lead_number(part)
        if num and num not in out:
            out.append(num)
    return out


def _outline_count_cell(cell):
    m = re.match(r"^\s*(\d+)", cell or "")
    if m:
        return int(m.group(1))
    if re.match(r"^\s*(?:无|—|-)?\s*$", cell or ""):
        return 0
    return None


def _outline_section_table_rows(text, heading_keyword):
    lines = text.splitlines()
    in_sec = False
    sec_level = 0
    rows = []
    header_seen = False
    sep_seen = False
    for raw in lines:
        hm = _OUTLINE_HEADING_RE.match(raw)
        if hm:
            lvl, title = len(hm.group(1)), hm.group(2).strip()
            if in_sec and lvl <= sec_level:
                break
            if not in_sec and heading_keyword in title:
                in_sec = True
                sec_level = lvl
            continue
        if not in_sec:
            continue
        s = raw.strip()
        if not s.startswith("|"):
            if sep_seen:
                break
            continue
        cells = [c.strip() for c in _split_md_row(s)]
        if not header_seen:
            header_seen = True
            continue
        if not sep_seen:
            if all(re.match(r"^:?-{2,}:?$", c.replace(" ", "")) for c in cells if c):
                sep_seen = True
                continue
        rows.append(cells)
    return rows


def _outline_figure_panels(spec):
    """与 src/outline-check.ts figurePanels 同口径：「1b/f」「5d–e」「7–8」「19」→ 小写子图列表。"""
    out = []
    num = ""
    for token in re.split(r"[/,，、]", spec or ""):
        parts = [s.strip() for s in re.split(r"\s*[–—~-]\s*", token)]
        left = parts[0] if parts else ""
        right = parts[1] if len(parts) > 1 else ""
        lm = re.match(r"^(S?\d+)?([a-zA-Z]?)$", left)
        if not lm:
            continue
        if lm.group(1):
            num = lm.group(1).upper()
        if not num:
            continue
        letter = lm.group(2).lower()
        if not right:
            out.append(num + letter)
            continue
        rm = re.match(r"^(S?\d+)?([a-zA-Z]?)$", right)
        if not rm:
            out.append(num + letter)
            continue
        if rm.group(1) and not letter and not rm.group(2):
            start_n = int(num.lstrip("S"))
            end_n = int(rm.group(1).lstrip("S"))
            pref = "S" if num.startswith("S") else ""
            for n in range(start_n, end_n + 1):
                if len(out) >= 60:
                    break
                out.append(f"{pref}{n}")
            continue
        if letter and rm.group(2) and not rm.group(1):
            for c in range(ord(letter), ord(rm.group(2).lower()) + 1):
                out.append(num + chr(c))
            continue
        out.append(num + letter)
        if rm.group(1):
            num = rm.group(1).upper()
        out.append(num + rm.group(2).lower())
    return list(dict.fromkeys(out))


_OUTLINE_COMPOSITE_HEAD_RE = re.compile(r"拼\s*图\s*(\d+)")
_OUTLINE_PANEL_REF_RE = re.compile(
    r"\[@([^\]\s;,]+)\]\s*Figs?\.?\s*(S?\d+[a-zA-Z]?(?:\s*[–—~\-/,、]\s*S?\d*[a-zA-Z]?)*)"
)
_OUTLINE_CLAIM_ID_RE = re.compile(r"(?<![A-Za-z0-9_])C(\d+)(?![A-Za-z0-9_])")
_OUTLINE_COLOR_EMOJI_RE = re.compile(
    r"[\U0001F300-\U0001FAFF\u2705\u274C\u274E\u2757\u2753\u2B50\u2728\u26A1]|\u26A0\uFE0F"
)
_OUTLINE_NON_BODY_CHAP_RE = re.compile(
    r"(?:引言|绪论|前言|导言|introduction|结论|总结|展望|结语|conclusion|conclusions|summary|outlook|参考文献|references|覆盖检查|框架推演|证据综合|定框架记录|验收摘要|本轮改了什么)",
    re.I,
)


def _outline_composite_panels(lines):
    out = []
    in_fence = False
    for lineno, raw in enumerate(lines, 1):
        if re.match(r"^\s*(```|~~~)", raw):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        heads = list(_OUTLINE_COMPOSITE_HEAD_RE.finditer(raw))
        for idx_h, h in enumerate(heads):
            end = heads[idx_h + 1].start() if idx_h + 1 < len(heads) else len(raw)
            seg = raw[h.end() : end]
            eq = re.search(r"[=＝]", seg)
            if not eq:
                continue
            for m in _OUTLINE_PANEL_REF_RE.finditer(seg[eq.start() :]):
                panels = _outline_figure_panels(m.group(2))
                if panels:
                    out.append({
                        "composite": h.group(1),
                        "key": m.group(1),
                        "fig": m.group(2).strip(),
                        "panels": panels,
                        "line": lineno,
                    })
    return out


def _outline_section_lines(lines, heading_keywords):
    """提取匹配 heading_keywords 的首个标题小节内容行（含子标题，跳过代码块）。"""
    in_sec = False
    sec_level = 0
    in_fence = False
    out = []
    for lineno, raw in enumerate(lines, 1):
        if re.match(r"^\s*(```|~~~)", raw):
            in_fence = not in_fence
            if in_sec:
                out.append((lineno, raw))
            continue
        if in_fence:
            if in_sec:
                out.append((lineno, raw))
            continue
        hm = _OUTLINE_HEADING_RE.match(raw)
        if hm:
            lvl, title = len(hm.group(1)), hm.group(2).strip()
            if in_sec and lvl <= sec_level:
                break
            if not in_sec and any(kw in title for kw in heading_keywords):
                in_sec = True
                sec_level = lvl
                continue
        if in_sec:
            out.append((lineno, raw))
    return out


def cmd_outline_check(args):
    """大纲步一键只读核验（与 Mesa src/outline-check.ts 同口径）：
    校验 outline.md 引用键（严避 A@B 化学式误报）、排除键、各节「- 拟引用（可写）/（线索）」分档、
    「## 覆盖检查」表篇数与最新年份（并拆分一手研究 vs 综述卡）、「补读」全文资格、
    拼图子图去重/禁综述/至少 2 篇研究、证据综合表覆盖与 C1..Cn 论断闭集、sections.json 对齐及禁止彩色 emoji。"""
    outline_path = Path(args.outline)
    if not outline_path.is_file():
        raise ValueError(f"找不到大纲文件：{outline_path}")
    outline_text = outline_path.read_text(encoding="utf-8-sig", errors="replace")

    errors = []
    warnings = []

    # 1. 读取 references.bib（键与年份）
    bib_path = Path(args.bib)
    bib_years = {}
    bib_keys_lower = {}
    if not bib_path.is_file():
        errors.append(f"缺少 {bib_path}")
    else:
        bib_text = bib_path.read_text(encoding="utf-8-sig", errors="replace")
        for k, start, end in entry_spans(bib_text):
            kl = k.casefold()
            bib_keys_lower[kl] = k
            fields = bib_fields_of(bib_text[start:end])
            ym = re.search(r"(\d{4})", fields.get("year", ("",))[0])
            if ym and (kl not in bib_years or bib_years[kl] is None):
                bib_years[kl] = int(ym.group(1))
            elif kl not in bib_years:
                bib_years[kl] = None

    # 2. 读取 papers/included.json（已排除 id / kind=review）
    included_path = Path(args.json)
    excluded_ids = set()
    review_ids = set()
    if included_path.is_file():
        inc_data = json.loads(included_path.read_text(encoding="utf-8-sig"))
        inc_rows = inc_data if isinstance(inc_data, list) else inc_data.get("papers") or inc_data.get("records") or inc_data.get("items") or []
        for r in inc_rows:
            if not isinstance(r, dict):
                continue
            rid = as_text(r.get("id")).casefold()
            doi = bare_doi(as_text(r.get("doi"))).casefold()
            dec = as_text(r.get("decision")).casefold()
            if dec in ("excluded", "exclude"):
                if rid:
                    excluded_ids.add(rid)
                if doi:
                    excluded_ids.add(doi)
            elif as_text(r.get("kind")).casefold() == "review":
                if rid:
                    review_ids.add(rid)
                if doi:
                    review_ids.add(doi)

    # 3. 读取 notes/index.json（按 bibKey 建笔记状态 + 区分综述卡）
    index_path = Path(args.index)
    note_state = {}
    excluded_keys_lower = set()
    review_keys_lower = set()
    if index_path.is_file():
        idx_data = json.loads(index_path.read_text(encoding="utf-8-sig"))
        idx_rows = idx_data if isinstance(idx_data, list) else idx_data.get("notes") or idx_data.get("records") or idx_data.get("items") or []
        for r in idx_rows:
            if not isinstance(r, dict):
                continue
            rid = as_text(r.get("id")).casefold()
            bk = as_text(r.get("bibKey") or r.get("key"))
            if not bk:
                continue
            bkl = bk.casefold()
            if rid in excluded_ids:
                excluded_keys_lower.add(bkl)
            if rid in review_ids or as_text(r.get("kind")).casefold() == "review":
                review_keys_lower.add(bkl)
            rev = as_text(r.get("reviewStatus")).casefold()
            ft = as_text(r.get("fulltextStatus")).casefold()
            reviewed = rev in ("reviewed", "done", "completed") or (not rev and bool(as_text(r.get("notePath"))))
            if reviewed and ft == "fulltext":
                tier = "fulltext"
            elif reviewed:
                tier = "abstract"
            elif r.get("skimmed") is True:
                tier = "skim"
            else:
                tier = "pending"
            note_state[bkl] = {
                "tier": tier,
                "noFulltext": ft in ("abstract-only", "unavailable"),
                "fulltextStatus": ft,
                "isReview": bkl in review_keys_lower,
            }

    # 4. 扫描 outline.md 章节、拟引用行与全篇引用键
    lines = outline_text.splitlines()
    current_sec = None
    in_fence = False
    log_level = 0
    cites = []
    missing_in_bib = []
    excluded_cited = []

    for lineno, raw in enumerate(lines, 1):
        if re.match(r"^\s*(```|~~~)", raw):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        hm = _OUTLINE_HEADING_RE.match(raw)
        bm = None if hm else _OUTLINE_BOLD_HEADING_RE.match(raw.strip())
        if hm:
            lvl, title = len(hm.group(1)), hm.group(2).strip()
            if log_level and lvl <= log_level:
                log_level = 0
            if _OUTLINE_LOG_HEADING_RE.search(title) and not log_level:
                log_level = lvl
            current_sec = {"number": _outline_lead_number(title), "title": title, "line": lineno}
            continue
        if bm and re.match(r"^\s*§?\d", bm.group(1)):
            title = bm.group(1).strip()
            current_sec = {"number": _outline_lead_number(title), "title": title, "line": lineno}
            continue

        if not log_level:
            for k in _outline_cited_keys_line(raw):
                kl = k.casefold()
                if kl in excluded_keys_lower:
                    if k not in excluded_cited:
                        excluded_cited.append(k)
                elif bib_keys_lower and kl not in bib_keys_lower:
                    if k not in missing_in_bib:
                        missing_in_bib.append(k)

        if re.match(r"^\s*[-*+•]\s", raw) and "拟引用" in raw:
            seg = raw[raw.index("拟引用") :]
            marks = list(_OUTLINE_TIER_MARK_RE.finditer(seg))
            if marks:
                w_keys, h_keys = [], []
                for idx_m, m in enumerate(marks):
                    end = marks[idx_m + 1].start() if idx_m + 1 < len(marks) else len(seg)
                    ks = _outline_cited_keys_line(seg[m.end() : end])
                    if "可写" in m.group(1):
                        w_keys.extend(ks)
                    else:
                        h_keys.extend(ks)
                cites.append({"section": current_sec, "line": lineno, "writable": w_keys, "hint": h_keys})

    if excluded_cited:
        errors.append(f"大纲引用了已排除文献（请改写为纯文本 Author (Year) 或移除）：{', '.join('@' + k for k in excluded_cited[:10])}")
    if missing_in_bib:
        errors.append(f"大纲存在 references.bib 找不到的引用键：{', '.join('@' + k for k in missing_in_bib[:10])}")

    # 校验拟引用可写行里是否混入非 fulltext 精读篇，以及同节重复键
    by_sec_num = {}
    for c in cites:
        sec_num = (c["section"] or {}).get("number") or ""
        for k in c["writable"]:
            st = note_state.get(k.casefold())
            if st and st["tier"] != "fulltext":
                errors.append(f"L{c['line']} 拟引用（可写）中的 @{k} 笔记状态为 {st['tier']}（非全文精读），应归入「仅线索」")
        if sec_num:
            by_sec_num.setdefault(sec_num, []).extend(c["writable"] + c["hint"])
    for sec_num, ks in by_sec_num.items():
        seen, dups = set(), []
        for k in ks:
            kl = k.casefold()
            if kl in seen and k not in dups:
                dups.append(k)
            seen.add(kl)
        if dups:
            warnings.append(f"第 {sec_num} 节拟引用重复列了：{', '.join('@' + k for k in dups)}")

    # 5. 复算「## 覆盖检查」表（与 src/outline-check.ts 同口径）
    cov_rows = _outline_section_table_rows(outline_text, "覆盖检查")
    coverage_report = []
    for row in cov_rows:
        row = row + [""] * max(0, 6 - len(row))
        label, w_cell, h_cell, latest_cell, verdict, advice = row[:6]
        ai_w = _outline_count_cell(w_cell)
        ai_h = _outline_count_cell(h_cell)
        nums = _outline_row_numbers(label)
        if "补读" in advice and "不补" not in verdict:
            no_pdf = []
            for k in dict.fromkeys(_outline_cited_keys_line(advice)):
                st = note_state.get(k.casefold())
                if st and st["noFulltext"]:
                    no_pdf.append(k)
            if no_pdf:
                errors.append(f"覆盖检查「{label}」建议补读的 {', '.join('@' + k for k in no_pdf)} 缺少全文 PDF（不能补读，请先补 PDF 或改补检）")

        mine = [
            c for c in cites
            if c["section"] and any(
                c["section"]["number"] == n or c["section"]["number"].startswith(f"{n}.")
                for n in nums
            )
        ]
        if not nums or not mine:
            coverage_report.append({
                "section": label,
                "ai": {"writable": ai_w, "hint": ai_h, "latest": latest_cell, "verdict": verdict},
                "computed": None,
                "mismatch": False,
            })
            if nums:
                warnings.append(f"覆盖检查「{label}」在正文中未找到对应的「- 拟引用（可写）/（线索）」行，无法复算")
            continue

        all_keys = []
        seen_k = set()
        for c in mine:
            for k in c["writable"] + c["hint"]:
                kl = k.casefold()
                if kl not in seen_k and kl not in excluded_keys_lower:
                    seen_k.add(kl)
                    all_keys.append(k)
        comp_w = [k for k in all_keys if (note_state.get(k.casefold()) or {}).get("tier") == "fulltext"]
        comp_h = [k for k in all_keys if (note_state.get(k.casefold()) or {}).get("tier") != "fulltext"]
        comp_w_review = [k for k in comp_w if k.casefold() in review_keys_lower]
        comp_w_research = [k for k in comp_w if k.casefold() not in review_keys_lower]
        years = [bib_years[k.casefold()] for k in all_keys if bib_years.get(k.casefold())]
        comp_latest = max(years) if years else None
        mismatch = (ai_w is not None and ai_w != len(comp_w)) or (ai_h is not None and ai_h != len(comp_h))
        if mismatch:
            errors.append(
                f"覆盖检查「{label}」篇数对不上：表写 {ai_w}/{ai_h}，复算 {len(comp_w)}/{len(comp_h)}"
                f"（可写含研究 {len(comp_w_research)} + 综述卡 {len(comp_w_review)}）"
            )
        coverage_report.append({
            "section": label,
            "ai": {"writable": ai_w, "hint": ai_h, "latest": latest_cell, "verdict": verdict},
            "computed": {
                "writable": len(comp_w),
                "writableResearch": len(comp_w_research),
                "writableReview": len(comp_w_review),
                "hint": len(comp_h),
                "latest": comp_latest,
            },
            "mismatch": mismatch,
        })

    # 6. 拼图计划校验：跨图重复子图 / 混入综述（kind=review） / 每张拼图至少来自 2 篇研究论文
    panels = _outline_composite_panels(lines)
    by_composite = {}
    for p in panels:
        by_composite.setdefault(p["composite"], []).append(p)
    seen_panel_pairs = set()
    for i, a in enumerate(panels):
        for b in panels[i + 1 :]:
            if a["key"].casefold() != b["key"].casefold():
                continue
            shared = [x for x in a["panels"] if x in b["panels"]]
            if not shared:
                continue
            pair_id = (a["key"].casefold(), tuple(shared), a["composite"], b["composite"])
            if pair_id in seen_panel_pairs:
                continue
            seen_panel_pairs.add(pair_id)
            if a["composite"] != b["composite"]:
                errors.append(
                    f"同一块子图进了两张拼图：@{a['key']} Fig.{ '、'.join(shared) } 同时出现在拼图 {a['composite']}（L{a['line']}）与拼图 {b['composite']}（L{b['line']}）"
                )
            else:
                warnings.append(
                    f"拼图 {a['composite']} 内重复列了子图：@{a['key']} Fig.{ '、'.join(shared) }（L{a['line']}/L{b['line']}）"
                )
    for comp, items in by_composite.items():
        rev_hits = []
        research_keys = set()
        for it in items:
            kl = it["key"].casefold()
            if kl in review_keys_lower:
                rev_hits.append(f"@{it['key']} Fig.{it['fig']}")
            else:
                research_keys.add(kl)
        if rev_hits:
            errors.append(f"拼图 {comp} 混入了综述图（拼图只取研究论文子图，综述请改写「自绘」）：{'、'.join(rev_hits)}")
        if len(research_keys) < 2:
            errors.append(f"拼图 {comp} 仅来自 {len(research_keys)} 篇研究论文（至少需来自 2 篇不同研究论文）")

    # 7. 「## 证据综合表」覆盖全部拟引用（可写）键 + 论断编号 C1..Cn 闭集核对
    ev_lines = _outline_section_lines(lines, ["证据综合表", "证据表", "证据综合"])
    ev_table_keys = set()
    ev_table_claims = []
    ev_defined_claims = []
    if ev_lines:
        in_table = False
        table_idx = 0
        row_in_table = 0
        for _, raw in ev_lines:
            s = raw.strip()
            if s.startswith("|"):
                if not in_table:
                    in_table = True
                    table_idx += 1
                    row_in_table = 0
                cells = [c.strip() for c in _split_md_row(s)]
                if all(re.match(r"^:?-{2,}:?$", c.replace(" ", "")) for c in cells if c):
                    continue
                row_in_table += 1
                if row_in_table == 1:
                    continue
                first_clean = re.sub(r"[*_`]", "", cells[0]).strip() if cells else ""
                m_def_tbl = re.match(r"^C(\d+)$", first_clean)
                if table_idx > 1 and m_def_tbl:
                    cid = f"C{m_def_tbl.group(1)}"
                    if cid not in ev_defined_claims:
                        ev_defined_claims.append(cid)
                else:
                    for k in _outline_cited_keys_line(s):
                        ev_table_keys.add(k.casefold())
                    for m in _OUTLINE_CLAIM_ID_RE.finditer(s):
                        cid = f"C{m.group(1)}"
                        if cid not in ev_table_claims:
                            ev_table_claims.append(cid)
            else:
                in_table = False
                m_def = re.match(r"^\s*(?:[-*+•]|\d+\.)?\s*\*{0,2}`?C(\d+)`?\*{0,2}\s*[：:（(—–-]", s)
                if m_def:
                    cid = f"C{m_def.group(1)}"
                    if cid not in ev_defined_claims:
                        ev_defined_claims.append(cid)
        # 兼容论断定义另起独立小节「## 核心论断定义 / ## 论断定义」
        claim_sec = _outline_section_lines(lines, ["论断定义", "核心论断"])
        for _, raw in claim_sec:
            s = raw.strip()
            m_def = re.match(r"^\s*(?:[-*+•]|\d+\.)?\s*\*{0,2}`?C(\d+)`?\*{0,2}\s*[：:（(—–-]", s)
            if m_def:
                cid = f"C{m_def.group(1)}"
                if cid not in ev_defined_claims:
                    ev_defined_claims.append(cid)
            elif s.startswith("|"):
                cells = [c.strip() for c in _split_md_row(s)]
                first_clean = re.sub(r"[*_`]", "", cells[0]).strip() if cells else ""
                m_def_tbl = re.match(r"^C(\d+)$", first_clean)
                if m_def_tbl:
                    cid = f"C{m_def_tbl.group(1)}"
                    if cid not in ev_defined_claims:
                        ev_defined_claims.append(cid)

        all_writable = []
        seen_w = set()
        for c in cites:
            for k in c["writable"]:
                kl = k.casefold()
                if kl not in seen_w and kl not in excluded_keys_lower:
                    seen_w.add(kl)
                    all_writable.append(k)
        missing_ev_research = [k for k in all_writable if k.casefold() not in ev_table_keys and k.casefold() not in review_keys_lower]
        missing_ev_review = [k for k in all_writable if k.casefold() not in ev_table_keys and k.casefold() in review_keys_lower]
        if missing_ev_research:
            errors.append(
                f"证据综合表遗漏了 {len(missing_ev_research)} 篇「拟引用（可写）」一手研究：{', '.join('@' + k for k in missing_ev_research[:12])}"
            )
        if missing_ev_review:
            warnings.append(
                f"有 {len(missing_ev_review)} 篇「拟引用（可写）」综述卡未列在证据综合表（若要可写键 100% 闭环可附于表尾综述分组）：{', '.join('@' + k for k in missing_ev_review[:8])}"
            )
        if ev_table_claims:
            undef_claims = [c for c in ev_table_claims if c not in ev_defined_claims]
            unused_claims = [c for c in ev_defined_claims if c not in ev_table_claims]
            if undef_claims:
                errors.append(f"证据综合表引用了未定义的论断编号：{', '.join(undef_claims)}")
            if unused_claims:
                warnings.append(f"论断定义中存在未被证据综合表引用的编号：{', '.join(unused_claims)}")

    # 8. manuscript/sections.json 校验（存在时自动核对格式与正文一级章数）
    sections_path = Path(getattr(args, "sections", "manuscript/sections.json"))
    sections_summary = None
    if sections_path.is_file():
        try:
            sec_data = json.loads(sections_path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError as e:
            errors.append(f"{sections_path} 不是合法 JSON：{e}")
            sec_data = None
        if sec_data is not None:
            if not isinstance(sec_data, list) or not sec_data:
                errors.append(f"{sections_path} 应为非空 JSON 数组")
            else:
                seen_ids = set()
                sec_titles = []
                for idx_s, item in enumerate(sec_data):
                    if not isinstance(item, dict):
                        errors.append(f"{sections_path} 第 {idx_s + 1} 项不是对象")
                        continue
                    sid = as_text(item.get("id"))
                    stitle = as_text(item.get("title"))
                    if not sid or not stitle:
                        errors.append(f"{sections_path} 第 {idx_s + 1} 项缺少 id 或 title")
                    elif sid in seen_ids:
                        errors.append(f"{sections_path} 存在重复 id：{sid}")
                    else:
                        seen_ids.add(sid)
                        sec_titles.append(stitle)
                body_chaps = []
                in_fence_s = False
                for raw in lines:
                    if re.match(r"^\s*(```|~~~)", raw):
                        in_fence_s = not in_fence_s
                        continue
                    if in_fence_s:
                        continue
                    m_h2 = re.match(r"^##\s+(.+?)\s*$", raw)
                    if not m_h2:
                        continue
                    t = m_h2.group(1).strip()
                    if _outline_lead_number(t) and not _OUTLINE_NON_BODY_CHAP_RE.search(t):
                        body_chaps.append(t)
                sections_summary = {"count": len(sec_titles), "outlineBodyChapters": len(body_chaps)}
                if body_chaps and len(sec_titles) != len(body_chaps):
                    errors.append(
                        f"{sections_path} 定义了 {len(sec_titles)} 节，与大纲正文一级大章数（{len(body_chaps)} 章，不含引言与结论）不一致"
                    )

    # 9. 禁止彩色 emoji（跳过代码块；保留单色 ⚠︎ 与科研符号）
    emoji_hits = []
    in_fence_e = False
    for lineno, raw in enumerate(lines, 1):
        if re.match(r"^\s*(```|~~~)", raw):
            in_fence_e = not in_fence_e
            continue
        if in_fence_e:
            continue
        found_e = _OUTLINE_COLOR_EMOJI_RE.findall(raw)
        if found_e:
            emoji_hits.append(f"L{lineno}:{''.join(dict.fromkeys(found_e))}")
    if emoji_hits:
        errors.append(f"大纲包含禁止使用的彩色 emoji（请改用「注意：」或单色 ⚠︎）：{', '.join(emoji_hits[:10])}")

    if args.json_out:
        print(json.dumps({
            "outline": outline_path.as_posix(),
            "coverage": coverage_report,
            "composites": len(by_composite),
            "evidenceKeys": len(ev_table_keys),
            "claims": {"referenced": ev_table_claims, "defined": ev_defined_claims},
            "sections": sections_summary,
            "errors": errors,
            "warnings": warnings,
            "ok": len(errors) == 0,
        }, ensure_ascii=False, indent=2))
    else:
        for row in coverage_report:
            c = row["computed"]
            if c:
                mark = "✗" if row["mismatch"] else "✓"
                print(
                    f"{mark} {row['section']}：表写 {row['ai']['writable']}/{row['ai']['hint']} ｜ "
                    f"复算 {c['writable']}/{c['hint']}（可写=研究 {c['writableResearch']} + 综述卡 {c['writableReview']}，最新 {c['latest'] or '?'}）"
                )
        for w in warnings:
            print(f"! {w}")
        for e in errors:
            print(f"✗ {e}")
        extras = [f"拼图 {len(by_composite)} 张"]
        if ev_lines:
            extras.append(f"证据表 {len(ev_table_keys)} 篇")
        if ev_table_claims or ev_defined_claims:
            extras.append(f"论断引用/定义 {len(ev_table_claims)}/{len(ev_defined_claims)}")
        if sections_summary:
            extras.append(f"sections.json {sections_summary['count']}/{sections_summary['outlineBodyChapters']}")
        if errors:
            print(f"大纲核验未通过：{len(errors)} 处错误，{len(warnings)} 处告警（{'｜'.join(extras)}）。")
        else:
            print(f"大纲核验通过：共核对 {len(coverage_report)} 节、0 处错误（{len(warnings)} 处告警；{'｜'.join(extras)}）。")
    return 1 if errors else 0


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
            sp.add_argument("--root", default=None, help="项目根（默认取 MESA_PROJECT_ROOT / TASK.md / git worktree 主仓根）")
            sp.add_argument("--out", default="papers", help="清单与 RIS 的目录（默认本工作区 papers/）")

    sp = sub.add_parser("enrich", help="按 DOI 补齐纳入与待确认的题录字段")
    common(sp, root=False)
    sp.add_argument("--workers", type=int, default=6)
    sp = sub.add_parser("fetch", help="开放获取：只下已纳入篇目的正式版或已录用稿到项目根 papers/")
    common(sp)
    sp.add_argument("--allow-preprint", action="store_true", help="来源级别允许预印本时才加")
    sp = sub.add_parser("write", help="从 included.json 生成 included.md、to-fetch.md 与两份 RIS")
    common(sp)
    sp = sub.add_parser("pdfs", help="精读步/拼图步：只读列出每篇已纳入的全文文件（stdout 直接输出含 absPath / bibKey / source 的 JSON，不写文件）")
    common(sp)
    sp.add_argument("--json-only", action="store_true", help="静默 stderr 中文摘要，仅在 stdout 输出纯 JSON")
    sp = sub.add_parser("check", help="校验 json、清单与两份 RIS 是否一致")
    common(sp)
    sp.add_argument("--allow-preprint", action="store_true", help="来源级别允许预印本时不提示预印本告警")
    sp = sub.add_parser("bib", help="精读步：把 included.json 的题录写进 references.bib（已有条目只补空字段；检索排除了的篇移出）")
    common(sp, root=False)
    sp.add_argument("--bib", default="references.bib")
    sp.add_argument("--ids", default="", help="只写这些 id（逗号分隔）")
    sp.add_argument("--with-pending", action="store_true")
    sp = sub.add_parser("impact", help="按 Mesa 的期刊指标表给每条写影响因子与中科院分区（不估，查不到写「表中无此刊」）")
    common(sp, root=False)
    sp = sub.add_parser("angles-facts", help="精读步：纳入综述的时效对照表（截至年份、之后纳入的研究论文），贴进 notes/angles.md")
    common(sp, root=False)
    sp.add_argument("--index", default="notes/index.json")
    sp = sub.add_parser("extract-text", help="精读步：定位项目根/Zotero PDF、PyMuPDF 抽文本并自动清除控制字符、自动报 SI-ONLY 与 Symbol 字体 μ→m 单位告警")
    common(sp)
    sp.add_argument("--keys", nargs="+", default=[], help="要抽取的 bibKey / id / DOI（支持空格或逗号分隔多个）")
    sp.add_argument("--index", default="notes/index.json")
    sp.add_argument("--bib", default="references.bib")
    sp.add_argument("--out-dir", default="", help="把清洗后的纯文本写入该目录（推荐 .ccode/local/pdf-texts）")
    sp.add_argument("--manifest", default="", help="将完整抽取清单 JSON 写入该文件（如 .ccode/local/manifest.json），避免大批量 stdout 截断")
    sp.add_argument("--stdout", action="store_true", help="无 --out-dir 时把抽取正文内联进 JSON 输出")
    sp.add_argument("--max-pages", type=int, default=0, help="最多抽取前 N 页（0 = 全部）")
    sp.add_argument("targets", nargs="*", help="位置参数形式传 bibKey / id / DOI")
    sp = sub.add_parser("validate", help="精读步一键只读验收：对齐 included.json / index.json / 来源 PDF（按项目根）/ 宽表 / references.bib / handoff / angles")
    common(sp)
    sp.add_argument("--index", default="notes/index.json")
    sp.add_argument("--bib", default="references.bib")
    sp.add_argument("--skim", default="notes/skim.md")
    sp.add_argument("--extraction", default="notes/extraction.md")
    sp.add_argument("--handoff", default="notes/handoff.md")
    sp.add_argument("--angles", default="notes/angles.md")
    sp.add_argument("--json-out", action="store_true", help="输出机器可读 JSON 摘要")
    sp = sub.add_parser("table", help="按 @bibKey 读取、原地更新、删除或导出 CSV（notes/skim.md / notes/extraction.md）")
    sp.add_argument("--file", required=True, help="目标 Markdown 表格文件")
    sp.add_argument("--get", nargs="+", default=[], help="只读查询指定 @bibKey（支持空格或逗号分隔多个）")
    sp.add_argument("--upsert", default="", help="按 JSON 文件（或 - 从 stdin）原地更新或追加行")
    sp.add_argument("--remove", nargs="+", default=[], help="按 @bibKey 移出指定行（支持空格或逗号分隔多个）")
    sp.add_argument("--to-csv", default="", help="将当前 Markdown 宽表确定性导出为 UTF-8 CSV 副件（如 notes/extraction.csv）")
    sp = sub.add_parser("index-update", help="按 JSON 补丁批量更新 notes/index.json（reviewStatus / notePath / forSections / pdfPath，reviewed 自动清 skimmed）")
    sp.add_argument("--index", default="notes/index.json", help="目标索引文件")
    sp.add_argument("--patch", required=True, help="JSON 补丁文件（或 - 从 stdin 读取）")
    sp = sub.add_parser("outline-check", help="大纲步一键只读核验：覆盖检查/引用键/排除键/补读资格/拼图去重禁综述/证据表与 C1..Cn 闭集/sections.json/禁彩色 emoji")
    common(sp, root=False)
    sp.add_argument("--outline", default="outline.md")
    sp.add_argument("--index", default="notes/index.json")
    sp.add_argument("--bib", default="references.bib")
    sp.add_argument("--sections", default="manuscript/sections.json")
    sp.add_argument("--json-out", action="store_true", help="输出机器可读 JSON 摘要")
    a = p.parse_args()
    if getattr(a, "cache", None):
        Net.cache = Path(a.cache)
    Net.refresh = getattr(a, "refresh", False)
    Net.offline = getattr(a, "offline", False)
    try:
        return {
            "enrich": cmd_enrich,
            "fetch": cmd_fetch,
            "write": cmd_write,
            "pdfs": cmd_pdfs,
            "check": cmd_check,
            "bib": cmd_bib,
            "impact": cmd_impact,
            "angles-facts": cmd_angles_facts,
            "extract-text": cmd_extract_text,
            "validate": cmd_validate,
            "table": cmd_table,
            "index-update": cmd_index_update,
            "outline-check": cmd_outline_check,
        }[a.cmd](a)
    except (OSError, ValueError, json.JSONDecodeError) as err:
        print(f"✗ {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
