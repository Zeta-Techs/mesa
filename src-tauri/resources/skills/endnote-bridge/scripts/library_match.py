#!/usr/bin/env python3
"""Read-only DOI lookup against one EndNote library and one Zotero database.

Binding is fail-closed. A field gets a library record number or item URI only
when the citation DOI and exactly one live library DOI are the same string
after normalization. Anything else keeps the embedded record.
"""
from __future__ import annotations

import configparser
import os
import re
import shutil
import sqlite3
import struct
import sys
import tempfile
from pathlib import Path
from xml.etree import ElementTree as ET


# 上下标/全角数字折回 ASCII：库里有 DOI 被化学美化成 D₂EE₀₄₁₂₁A 的记录，折叠后仍能整段相等。
_DIGIT_FOLD = {}
for _i, _c in enumerate("₀₁₂₃₄₅₆₇₈₉"):
    _DIGIT_FOLD[ord(_c)] = str(_i)
for _i, _c in enumerate("⁰¹²³⁴⁵⁶⁷⁸⁹"):
    _DIGIT_FOLD[ord(_c)] = str(_i)
for _i, _c in enumerate("０１２３４５６７８９"):
    _DIGIT_FOLD[ord(_c)] = str(_i)


def norm_doi(raw: str) -> str:
    """同一 DOI 的写法收成一段。收完仍必须整段相等，不按前缀或标题猜测。"""
    text = (raw or "").strip().strip("{}")
    text = re.sub(r"(?i)^https?://(dx\.)?doi\.org/", "", text)
    text = re.sub(r"(?i)^doi:\s*", "", text)
    text = text.replace("－", "-").replace("–", "-").replace("—", "-")
    text = text.translate(_DIGIT_FOLD)
    text = re.sub(r"\s+", "", text)
    return text.strip().rstrip(".,;)").lower()


def doi_ok(value: str) -> bool:
    return bool(re.fullmatch(r"10\.\d{4,9}/.+", value))


def _ro(path: Path) -> sqlite3.Connection:
    uri = path.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.execute("PRAGMA query_only = ON")
    return conn


class _LibraryCopy:
    """先把库文件复制出来再读。原文件被 EndNote / Zotero 锁着时，副本仍能只读。"""

    def __init__(self, source: Path):
        self.tmp = tempfile.TemporaryDirectory(prefix="mesa-lib-")
        self.path = Path(self.tmp.name) / source.name
        shutil.copy2(source, self.path)
        for suffix in ("-wal", "-shm"):
            side = Path(str(source) + suffix)
            if side.is_file():
                shutil.copy2(side, Path(str(self.path) + suffix))

    def close(self) -> None:
        self.tmp.cleanup()


def open_library_copy(path: Path) -> tuple[sqlite3.Connection, _LibraryCopy]:
    copied = _LibraryCopy(path)
    try:
        return _ro(copied.path), copied
    except sqlite3.Error:
        copied.close()
        raise


def endnote_pointer(project_root: Path | None) -> Path | None:
    """项目里人写的唯一库路径。不扫磁盘挑库。"""
    if project_root is None:
        return None
    path = project_root / "papers" / "endnote-library.path"
    if not path.is_file():
        return None
    lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip() and not line.strip().startswith("#")]
    if len(lines) != 1:
        return None
    return Path(lines[0]).expanduser()


def _legacy_note(path: Path) -> str:
    """EndNote X9 及更早：.enl 只是个壳，记录在同名 .Data/rdb（内嵌 MySQL 表），脚本直接读不了。"""
    data = path.with_suffix(".Data")
    if (data / "rdb").is_dir():
        return (
            "这是 EndNote X9 及更早版本的库（记录在 .Data/rdb 里），脚本直接读不了。"
            "在 EndNote 里打开这个库，File → Export，「保存类型」选 XML，存成项目里的 papers/my-endnote-library.xml，"
            "再在 Mesa 初稿步「同步到文献库」或定稿步那一行「选这个 EndNote 库」里选这份 XML，重出 EndNote 版 Word。"
        )
    return ""


def _xml_text(node) -> str:
    return "".join(node.itertext()).strip() if node is not None else ""


def endnote_xml_records(path: Path) -> tuple[list[tuple[int, str, str, int]], str, str]:
    """EndNote 导出的 XML：每条 (记录号, DOI, 题名, 入库时间戳)、库编号（db-id）、说明。
    X9 等老库脚本读不了库文件本身，人从 EndNote 导出一份 XML，记录号和库编号都在里面。"""
    import xml.etree.ElementTree as ET

    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as exc:
        return [], "", f"EndNote 导出的 XML 读不了：{exc}"
    rows: list[tuple[int, str, str, int]] = []
    db_ids: set[str] = set()
    for rec in root.iter("record"):
        num = _xml_text(rec.find("rec-number"))
        key = next((k for k in rec.iter("key") if k.get("app") == "EN"), None)
        if key is not None and key.get("db-id"):
            db_ids.add(key.get("db-id", "").strip())
        if not num.isdigit():
            continue
        stamp = key.get("timestamp", "") if key is not None else ""
        rows.append((
            int(num),
            _xml_text(rec.find("electronic-resource-num")),
            _xml_text(rec.find("titles/title")),
            int(stamp) if stamp.isdigit() else 0,
        ))
    if not rows:
        return [], "", "EndNote 导出的 XML 里没有带记录号的条目（导出时选 XML 格式、导出全部文献）"
    if len(db_ids) != 1:
        return rows, "", "EndNote 导出的 XML 里库编号缺失或不止一个，记录号不写入域。"
    return rows, db_ids.pop(), ""


def endnote_index(path: Path) -> tuple[dict[str, list[int]], dict[int, int], str, str]:
    """DOI → live record ids, record id → added_to_library 时间戳, library db-id, and a note."""
    if not path.is_file():
        return {}, {}, "", f"EndNote 库不存在：{path}"
    if path.suffix.lower() == ".xml":
        xml_rows, db_id, note = endnote_xml_records(path)
        if note and not db_id:
            return {}, {}, "", note
        rows = [(rec_id, 0, doi, added) for rec_id, doi, _title, added in xml_rows]
    else:
        rows, db_id, error = _endnote_sqlite_rows(path)
        if error:
            return {}, {}, "", (_legacy_note(path) or error)
    index: dict[str, list[int]] = {}
    stamps: dict[int, int] = {}
    for rec_id, trash, doi, added in rows:
        if trash:
            continue
        # 外键上的 timestamp 用库里的入库时间，与 EndNote 自己插引文时写的一致（无 DOI 按题名绑定的条目也复用）。
        if isinstance(added, int) and added > 0:
            stamps[int(rec_id)] = added
        key = norm_doi(str(doi))
        if doi_ok(key):
            index.setdefault(key, []).append(int(rec_id))
    if not db_id:
        return index, stamps, "", "EndNote 库读不到库编号，记录号不写入域。"
    return index, stamps, db_id, ""


def _endnote_sqlite_path(path: Path) -> Path:
    """EndNote 20/21/2025 开库期间实时改写同名 .Data/sdb/sdb.eni，关库才拷回 .enl；有更新的 sdb.eni 时读它。"""
    if path.suffix.lower() == ".enl":
        sdb = path.with_suffix(".Data") / "sdb" / "sdb.eni"
        try:
            if sdb.is_file() and (not path.is_file() or sdb.stat().st_mtime >= path.stat().st_mtime):
                return sdb
        except OSError:
            pass
    return path


def _endnote_sqlite_rows(path: Path) -> tuple[list, str, str]:
    """EndNote 20 起的库：.enl / .Data/sdb/sdb.eni 是 SQLite。返回 (行, 库编号, 错误)。"""
    try:
        conn, copied = open_library_copy(_endnote_sqlite_path(path))
    except (OSError, sqlite3.Error) as exc:
        return [], "", f"EndNote 库打不开（只读副本）：{exc}"
    error = ""
    try:
        raw = conn.execute("SELECT value FROM misc WHERE code = 14 AND subcode = 0").fetchone()
        db_id = ""
        if raw and raw[0]:
            blob = raw[0]
            db_id = blob.decode("utf-8", "replace").strip() if isinstance(blob, bytes) else str(blob).strip()
        try:
            # 不在 SQL 里写 electronic_resource_number != ''：EndNote 2025 给该列挂自定义排序规则 ENCI_Base，
            # 一旦走索引比较，标准 sqlite3 会报 no such collation sequence: ENCI_Base；空串留在 Python 侧过滤。
            rows = conn.execute(
                "SELECT id, trash_state, electronic_resource_number, added_to_library FROM refs"
            ).fetchall()
        except sqlite3.Error:
            # 老库没有 added_to_library 列：外键 timestamp 退回生成时刻。
            rows = [
                (rec_id, trash, doi, 0)
                for rec_id, trash, doi in conn.execute(
                    "SELECT id, trash_state, electronic_resource_number FROM refs"
                ).fetchall()
            ]
    except sqlite3.Error as exc:
        error = f"EndNote 库读不到记录：{exc}"
        rows = []
        db_id = ""
    finally:
        conn.close()
        copied.close()
    return rows, db_id, error


_TITLE_FOLD = dict(_DIGIT_FOLD)
for _src, _dst in zip("₊₋ₓᵧₙ⁺⁻ⁿ", "+-xyn+-n"):
    _TITLE_FOLD[ord(_src)] = _dst


_INLINE_TAG_RE = re.compile(r"</?(?:sub|sup|i|b|sc|span)(?:\s+[^>]*)?>", re.I)


def norm_title(raw: str) -> str:
    """题名比对口径：大小写、空白、标点、HTML/TeX 上下标写法都不算，中文原样。只用于没有 DOI 的条目，仍要整段相等。"""
    cleaned = _INLINE_TAG_RE.sub("", raw or "").replace("$", "")
    return re.sub(r"[\W_]+", "", cleaned.translate(_TITLE_FOLD).casefold())


def endnote_title_index(path: Path) -> dict[tuple[str, str], list[int]]:
    """(题名, 年份) → 活记录号。只给没有 DOI 的条目用（中文期刊常没有 DOI，2026-10-24 HER：梁珂明 2020 这一条
    两边都没有 DOI，EndNote 自己 Update 也没对上）。读不了就返回空，不影响按 DOI 绑定。"""
    rows: list[tuple[int, str, str]] = []
    if path.suffix.lower() == ".xml":
        import xml.etree.ElementTree as ET

        try:
            root = ET.parse(path).getroot()
        except (OSError, ET.ParseError):
            return {}
        for rec in root.iter("record"):
            num = _xml_text(rec.find("rec-number"))
            if num.isdigit():
                rows.append((int(num), _xml_text(rec.find("titles/title")), _xml_text(rec.find("dates/year"))))
    else:
        try:
            conn, copied = open_library_copy(_endnote_sqlite_path(path))
        except (OSError, sqlite3.Error):
            return {}
        try:
            rows = [
                (int(rec_id), str(title or ""), str(year or ""))
                for rec_id, trash, title, year in conn.execute(
                    "SELECT id, trash_state, title, year FROM refs"
                ).fetchall()
                if not trash
            ]
        except sqlite3.Error:
            rows = []
        finally:
            conn.close()
            copied.close()
    index: dict[tuple[str, str], list[int]] = {}
    for rec_id, title, year in rows:
        key = norm_title(title)
        if key:
            index.setdefault((key, year.strip()[:4]), []).append(rec_id)
    return index


_FS_ILLEGAL_RE = re.compile(r'[\x00-\x1f<>:"/\\|?*]')
_FS_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}


def _sanitize_group_name(raw: str) -> str:
    """与后端 endnote_project_group_name / paths::sanitize_fs_name 同口径，匹配 Mesa 建出的课题群组名。"""
    cleaned = _FS_ILLEGAL_RE.sub("-", (raw or "").strip()).strip(". \t\r\n")
    if not cleaned:
        return ""
    stem = cleaned.split(".", 1)[0].lower()
    return f"{cleaned}-" if stem in _FS_RESERVED else cleaned


def endnote_project_group_members(path: Path, project_root: Path | None) -> tuple[str, set[int] | None]:
    """EndNote 20/21/2025 SQLite `groups` 表里与当前课题同名的唯一自定义群组（TYPE;3）成员记录号集合。
    多课题共用一个个人图书馆时，跨课题重复文献靠本课题群组做确定性消歧；群组不存在、同名不止一个或格式不符时返回 None（不猜）。"""
    if project_root is None or path.suffix.lower() == ".xml" or not path.is_file():
        return "", None
    raw_name = project_root.name.strip()
    targets = {n for n in (raw_name, _sanitize_group_name(raw_name)) if n}
    if not targets:
        return "", None
    try:
        conn, copied = open_library_copy(_endnote_sqlite_path(path))
    except (OSError, sqlite3.Error):
        return "", None
    try:
        rows = conn.execute("SELECT spec, members FROM groups").fetchall()
    except sqlite3.Error:
        return "", None
    finally:
        conn.close()
        copied.close()
    matched: list[tuple[str, set[int]]] = []
    for spec, members in rows:
        if not spec or not isinstance(members, (bytes, bytearray, memoryview)):
            continue
        blob = bytes(members)
        if len(blob) < 8:
            continue
        spec_text = spec.decode("utf-8", "replace") if isinstance(spec, bytes) else str(spec)
        try:
            root = ET.fromstring(spec_text)
        except ET.ParseError:
            continue
        rule = (root.findtext(".//rule") or "").strip()
        if rule != "TYPE;3":
            continue
        name = (root.findtext(".//name") or "").strip()
        if name not in targets:
            continue
        cnt = struct.unpack("<I", blob[4:8])[0]
        if len(blob) != 8 + 4 * cnt:
            continue
        ids = set(struct.unpack(f"<{cnt}I", blob[8:])) if cnt else set()
        matched.append((name, ids))
    if len(matched) != 1:
        return "", None
    return matched[0]


def bind_endnote(records: dict[str, dict], cited: list[str], library: Path | None, project_root: Path | None = None) -> list[str]:
    if library is None:
        library = endnote_pointer(project_root)
    if library is None:
        return ["未指定 EndNote 库，记录号未绑定。把库的绝对路径写进 papers/endnote-library.path（一行），或运行时加 --endnote-library。"]
    if library.suffix.lower() not in (".enl", ".xml") or not library.is_file():
        return [f"EndNote 库路径不是已有的 .enl 或 EndNote 导出的 .xml：{library}"]
    index, stamps, db_id, note = endnote_index(library)
    lines = [f"EndNote 库：{library}"]
    if note:
        lines.append(note)
        return lines
    titles: dict[tuple[str, str], list[int]] | None = None
    group_loaded = False
    group_name = ""
    group_members: set[int] | None = None

    def narrow_by_group(hits: list[int]) -> int | None:
        nonlocal group_loaded, group_name, group_members
        if not group_loaded:
            group_name, group_members = endnote_project_group_members(library, project_root)
            group_loaded = True
        if not group_members:
            return None
        in_group = [h for h in hits if h in group_members]
        return in_group[0] if len(in_group) == 1 else None

    bound = 0
    group_bound = 0
    dup_unbound = 0
    for key in cited:
        rec = records.get(key)
        if not rec:
            continue
        doi = norm_doi(rec.get("doi") or "")
        if not doi_ok(doi):
            # 没有 DOI：题名（去标点大小写）+ 年份在库里恰好一条才绑；库里多条时尝试按本课题群组唯一消歧，否则照旧不猜
            if titles is None:
                titles = endnote_title_index(library)
            hits = titles.get((norm_title(rec.get("title") or ""), str(rec.get("year") or "").strip()[:4])) or []
            if len(hits) == 1:
                rec["_en_rec"] = hits[0]
                rec["_en_db"] = db_id
                if hits[0] in stamps:
                    rec["_en_ts"] = stamps[hits[0]]
                bound += 1
                lines.append(f"- `{key}` 没有 DOI，按题名与年份对上记录 {hits[0]}")
            elif len(hits) > 1:
                picked = narrow_by_group(hits)
                if picked is not None:
                    rec["_en_rec"] = picked
                    rec["_en_db"] = db_id
                    if picked in stamps:
                        rec["_en_ts"] = stamps[picked]
                    bound += 1
                    group_bound += 1
                    lines.append(f"- `{key}` 没有 DOI，按题名与课题群组「{group_name}」对上记录 {picked}")
                else:
                    dup_unbound += 1
                    lines.append(f"- `{key}` 没有 DOI，同题名同年份在库里有 {len(hits)} 条，未绑定")
            else:
                lines.append(f"- `{key}` 没有可用 DOI，库里也没有同题名同年份的记录，未绑定")
            continue
        hits = index.get(doi) or []
        if len(hits) == 1:
            rec["_en_rec"] = hits[0]
            rec["_en_db"] = db_id
            if hits[0] in stamps:
                rec["_en_ts"] = stamps[hits[0]]
            bound += 1
        elif len(hits) > 1:
            picked = narrow_by_group(hits)
            if picked is not None:
                rec["_en_rec"] = picked
                rec["_en_db"] = db_id
                if picked in stamps:
                    rec["_en_ts"] = stamps[picked]
                bound += 1
                group_bound += 1
            else:
                dup_unbound += 1
                lines.append(f"- `{key}` DOI `{doi}` 在库里有 {len(hits)} 条，未绑定")
        else:
            lines.append(f"- `{key}` DOI `{doi}` 库里没有，未绑定")
    lines.insert(1, f"已绑定 {bound} 条")
    if group_bound:
        lines.insert(2, f"其中 {group_bound} 条在库里有多个副本，已按课题群组「{group_name}」精确对应。")
    if dup_unbound:
        lines.append(
            f"提示：有 {dup_unbound} 篇在 EndNote 库里存在多条重复记录且无法按课题群组唯一区分，为防绑错未写记录号（Update 时会落进「漫游个人图书馆」）。"
            "可在 EndNote 点「参考文献 → 查找重复项」（References → Find Duplicates）去重，或归入与课题同名的群组后重开 `output/endnote.docx` 自动重绑。"
        )
    return lines


def zotero_app_dir() -> Path | None:
    """Zotero 配置目录。环境变量优先；否则按系统默认。找不到就不猜数据目录。"""
    override = os.environ.get("ZOTERO_CONFIG_DIR", "").strip()
    if override:
        path = Path(override).expanduser()
        return path if path.is_dir() else None
    home = Path.home()
    if sys.platform == "darwin":
        path = home / "Library" / "Application Support" / "Zotero"
    elif sys.platform == "win32":
        root = os.environ.get("APPDATA", "").strip()
        path = Path(root) / "Zotero" / "Zotero" if root else None
    else:
        candidates = [
            p
            for p in (
                home / ".zotero" / "zotero",
                home / ".var" / "app" / "org.zotero.Zotero" / ".zotero" / "zotero",
            )
            if p.is_dir()
        ]
        path = candidates[0] if len(candidates) == 1 else None
    return path if path is not None and path.is_dir() else None


def zotero_profile_dirs() -> list[Path]:
    """当前默认配置的目录。多个配置或没有默认时返回空，避免读到另一个库。"""
    app = zotero_app_dir()
    if app is None:
        return []
    ini = app / "profiles.ini"
    if not ini.is_file():
        return []
    parser = configparser.ConfigParser()
    try:
        parser.read(ini, encoding="utf-8")
    except configparser.Error:
        return []
    profiles = [name for name in parser.sections() if name.lower().startswith("profile")]
    if len(profiles) != 1:
        return []
    section = profiles[0]
    if parser.get(section, "Default", fallback="0") not in {"1", "true", "True"}:
        return []
    raw = parser.get(section, "Path", fallback="").strip()
    if not raw or parser.get(section, "IsRelative", fallback="1") != "1":
        return []
    profile = (app / raw).resolve()
    return [profile] if profile.is_dir() else []


def zotero_db_path() -> Path | None:
    """只认当前默认配置写明的数据目录。没有这份配置就不猜 ~/Zotero。"""
    found: list[Path] = []
    for profile in zotero_profile_dirs():
        prefs = profile / "prefs.js"
        if not prefs.is_file():
            continue
        text = prefs.read_text(encoding="utf-8", errors="replace")
        match = re.search(r'user_pref\("extensions\.zotero\.dataDir",\s*"([^"]+)"\)', text)
        if not match:
            continue
        directory = Path(match.group(1).replace("\\\\", "\\")).expanduser()
        database = directory / "zotero.sqlite"
        if database.is_file():
            found.append(database.resolve())
    unique = list(dict.fromkeys(found))
    return unique[0] if len(unique) == 1 else None


def zotero_index(path: Path) -> tuple[dict[str, list[str]], str, str]:
    """DOI → item URIs, plus a note when the database cannot be used."""
    if not path.is_file():
        return {}, "", f"Zotero 库不存在：{path}"
    try:
        conn, copied = open_library_copy(path)
    except (OSError, sqlite3.Error) as exc:
        return {}, "", f"Zotero 库打不开（只读副本）：{exc}"
    error = ""
    try:
        user = conn.execute(
            "SELECT value FROM settings WHERE setting = 'account' AND key = 'localUserKey'"
        ).fetchone()
        local_key = str(user[0]).strip() if user and user[0] else ""
        account = conn.execute(
            "SELECT value FROM settings WHERE setting = 'account' AND key = 'userID'"
        ).fetchone()
        user_id = str(account[0]).strip() if account and account[0] else ""
        # 只取用户库（libraries.type = user）。群组库的地址不是 users/local，混进来会指错。
        rows = conn.execute(
            "SELECT i.libraryID, i.key, v.value FROM items i "
            "JOIN libraries lib ON lib.libraryID = i.libraryID AND lib.type = 'user' "
            "JOIN itemData d ON d.itemID = i.itemID "
            "JOIN fields f ON f.fieldID = d.fieldID AND f.fieldName = 'DOI' "
            "JOIN itemDataValues v ON v.valueID = d.valueID "
            "WHERE i.itemID NOT IN (SELECT itemID FROM deletedItems)"
        ).fetchall()
    except sqlite3.Error as exc:
        error = f"Zotero 库读不到条目：{exc}"
        rows = []
        local_key = ""
        user_id = ""
    finally:
        conn.close()
        copied.close()
    if error:
        return {}, "", error
    # 已登录用账号编号。未登录才用 users/local，和 Zotero 自己写进 Word 的地址一致。
    if re.fullmatch(r"\d+", user_id) and user_id != "0":
        owner = f"users/{user_id}"
    elif re.fullmatch(r"[A-Za-z0-9]+", local_key):
        owner = f"users/local/{local_key}"
    else:
        return {}, "", "Zotero 库没有可用的账号编号或本机用户键，条目地址不写入域。"
    libraries = {int(row[0]) for row in rows}
    if libraries and len(libraries) != 1:
        return {}, "", "Zotero 用户库不是唯一的一个，条目地址不写入域。"
    index: dict[str, list[str]] = {}
    for _library_id, item_key, doi in rows:
        key = norm_doi(str(doi))
        if not doi_ok(key) or not re.fullmatch(r"[A-Z0-9]{8}", str(item_key)):
            continue
        uri = f"http://zotero.org/{owner}/items/{item_key}"
        index.setdefault(key, []).append(uri)
    return index, owner, ""


def _zotero_year(raw: str) -> str:
    text = (raw or "").strip()
    m = re.match(r"(\d{4})-", text)
    if m and m.group(1) != "0000":
        return m.group(1)
    m2 = re.search(r"(?:1[89]|20)\d{2}", text)
    return m2.group(0) if m2 else ""


def zotero_title_index(path: Path, owner: str) -> dict[tuple[str, str], list[str]]:
    """(题名, 年份) → Zotero 条目 URI。只给没有 DOI 的书/学位论文/标准等用，命中恰好一条才绑。"""
    if not path.is_file() or not owner:
        return {}
    try:
        conn, copied = open_library_copy(path)
    except (OSError, sqlite3.Error):
        return {}
    try:
        rows = conn.execute(
            "SELECT i.libraryID, i.itemID, i.key, f.fieldName, v.value FROM items i "
            "JOIN libraries lib ON lib.libraryID = i.libraryID AND lib.type = 'user' "
            "JOIN itemTypes t ON t.itemTypeID = i.itemTypeID "
            "JOIN itemData d ON d.itemID = i.itemID "
            "JOIN fields f ON f.fieldID = d.fieldID AND f.fieldName IN ('title', 'date') "
            "JOIN itemDataValues v ON v.valueID = d.valueID "
            "WHERE i.itemID NOT IN (SELECT itemID FROM deletedItems) "
            "AND t.typeName NOT IN ('attachment', 'note', 'annotation')"
        ).fetchall()
    except sqlite3.Error:
        return {}
    finally:
        conn.close()
        copied.close()
    if len({int(r[0]) for r in rows}) > 1:
        return {}
    per_item: dict[int, dict[str, str]] = {}
    for _lib_id, item_id, item_key, field, value in rows:
        key_str = str(item_key)
        if not re.fullmatch(r"[A-Z0-9]{8}", key_str):
            continue
        entry = per_item.setdefault(int(item_id), {"key": key_str})
        entry[str(field).lower()] = str(value or "")
    index: dict[tuple[str, str], list[str]] = {}
    for entry in per_item.values():
        tkey = norm_title(entry.get("title", ""))
        if not tkey:
            continue
        year = _zotero_year(entry.get("date", ""))
        uri = f"http://zotero.org/{owner}/items/{entry['key']}"
        index.setdefault((tkey, year), []).append(uri)
    return index


_ZOTERO_TS_SUFFIX_RE = re.compile(
    r"^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$"
)


def zotero_project_collection_uris(
    path: Path, owner: str, project_root: Path | None
) -> tuple[str, set[str] | None]:
    """Zotero 用户库里与当前课题同名（或 Zotero 重导时自动追加时间戳后缀如 `<课题名> 2026/11/23 14:10:15`）
    的最新非空分类条目 URI 集合。多课题共用同一 Zotero 库时用于确定性消歧；分类内仍重复或无匹配分类时仍不猜。"""
    if project_root is None or not owner or not path.is_file():
        return "", None
    raw_name = project_root.name.strip()
    targets = {n for n in (raw_name, _sanitize_group_name(raw_name)) if n}
    if not targets:
        return "", None
    try:
        conn, copied = open_library_copy(path)
    except (OSError, sqlite3.Error):
        return "", None
    try:
        cols = conn.execute(
            "SELECT c.collectionID, c.collectionName FROM collections c "
            "JOIN libraries lib ON lib.libraryID = c.libraryID AND lib.type = 'user'"
        ).fetchall()
        matched: list[tuple[int, str]] = []
        for cid, cname in cols:
            name = str(cname or "").strip()
            if not name:
                continue
            hit = name in targets
            if not hit:
                for target in targets:
                    prefix = target + " "
                    if name.startswith(prefix) and _ZOTERO_TS_SUFFIX_RE.fullmatch(name[len(prefix) :].strip()):
                        hit = True
                        break
            if hit:
                matched.append((int(cid), name))
        if not matched:
            return "", None
        # 按 collectionID 降序取最新导入且非空的那个分类（Zotero 每次导入建新分类，ID 单调递增）
        matched.sort(key=lambda item: item[0], reverse=True)
        for cid, cname in matched:
            rows = conn.execute(
                "SELECT i.key FROM collectionItems ci "
                "JOIN items i ON i.itemID = ci.itemID "
                "WHERE ci.collectionID = ? AND i.itemID NOT IN (SELECT itemID FROM deletedItems)",
                (cid,),
            ).fetchall()
            uris = {
                f"http://zotero.org/{owner}/items/{k}"
                for (k,) in rows
                if re.fullmatch(r"[A-Z0-9]{8}", str(k))
            }
            if uris:
                return cname, uris
        return "", None
    except sqlite3.Error:
        return "", None
    finally:
        conn.close()
        copied.close()


def bind_zotero(
    records: dict[str, dict],
    cited: list[str],
    database: Path | None,
    project_root: Path | None = None,
) -> list[str]:
    if database is None:
        database = zotero_db_path()
        if database is None:
            return ["未找到当前 Zotero 配置写明的数据目录，条目地址未绑定。"]
    index, owner, note = zotero_index(database)
    lines = [f"Zotero 库：{database}"]
    if note:
        lines.append(note)
        lines.append("条目地址未写入域，没有编造占位 URI。")
        return lines
    titles: dict[tuple[str, str], list[str]] | None = None
    col_loaded = False
    col_name = ""
    col_uris: set[str] | None = None

    def narrow_by_collection(hits: list[str]) -> str | None:
        nonlocal col_loaded, col_name, col_uris
        if not col_loaded:
            col_name, col_uris = zotero_project_collection_uris(database, owner, project_root)
            col_loaded = True
        if not col_uris:
            return None
        in_col = [u for u in hits if u in col_uris]
        return in_col[0] if len(in_col) == 1 else None

    bound = 0
    col_bound = 0
    dup_count = 0
    for key in cited:
        rec = records.get(key)
        if not rec:
            continue
        doi = norm_doi(rec.get("doi") or "")
        if not doi_ok(doi):
            if titles is None:
                titles = zotero_title_index(database, owner)
            hits = titles.get((norm_title(rec.get("title") or ""), str(rec.get("year") or "").strip()[:4])) or []
            if len(hits) == 1:
                rec["_zotero_uri"] = hits[0]
                bound += 1
                lines.append(f"- `{key}` 没有 DOI，按题名与年份对上条目 `{hits[0]}`")
            elif len(hits) > 1:
                picked = narrow_by_collection(hits)
                if picked is not None:
                    rec["_zotero_uri"] = picked
                    bound += 1
                    col_bound += 1
                    lines.append(f"- `{key}` 没有 DOI，按题名与课题分类「{col_name}」对上条目 `{picked}`")
                else:
                    dup_count += 1
                    lines.append(f"- `{key}` 没有 DOI，同题名同年份在库里有 {len(hits)} 条，未绑定")
            else:
                lines.append(f"- `{key}` 没有可用 DOI，库里也没有同题名同年份的条目，未绑定")
            continue
        hits = index.get(doi) or []
        if len(hits) == 1:
            rec["_zotero_uri"] = hits[0]
            bound += 1
        elif len(hits) > 1:
            picked = narrow_by_collection(hits)
            if picked is not None:
                rec["_zotero_uri"] = picked
                bound += 1
                col_bound += 1
            else:
                dup_count += 1
                lines.append(f"- `{key}` DOI `{doi}` 在库里有 {len(hits)} 条，未绑定")
        else:
            lines.append(f"- `{key}` DOI `{doi}` 库里没有，未绑定")
    lines.insert(1, f"已绑定 {bound} 条")
    if col_bound:
        lines.insert(2, f"其中 {col_bound} 条在库里有多个副本，已按课题分类「{col_name}」精确对应。")
    if dup_count:
        lines.append(
            f"提示：有 {dup_count} 篇在 Zotero 库里存在重复条目（多次导入常见），为防绑错未写条目 URI；"
            "`output/zotero.docx` 已内嵌完整题录，可直接打开点 Refresh 使用。若想绑上本机库条目，可在 Zotero 左侧「重复条目（Duplicate Items）」合并重复项后重新生成。"
        )
    return lines


# ---------------------------------------------------------------------------
# 库体检：检出「旧版 Mesa 导出」污染的存量记录，同步/域稿流程据此提示先清后导。
# 判定特征（只命中旧版产物，正常人工录入不会长这样）：
#   1. DOI 字段含上下标数字（10.1039/D₂EE₀₄₁₂₁A）——标识符永远不会合法含这些字符
#   2. 标题里「字母/数字/右括号 + 空格 + 下标」（MgCl ₂）——旧版空格损伤
#   3. 标题里「字母+数字+-」（Mg2+-Conducting）——旧版未转换的电荷
_POISON_DIGITS = set("₀₁₂₃₄₅₆₇₈₉⁰¹²³⁴⁵⁶⁷⁸⁹")
_SPACE_BEFORE_SUB = re.compile(r"[A-Za-z0-9)\]] [₀₁₂₃₄₅₆₇₈₉]")
_UNCONVERTED_CHARGE = re.compile(r"[A-Za-z]\d\+-")


def _stale_flag(doi: str, title: str) -> str:
    if any(c in _POISON_DIGITS for c in doi or ""):
        return "DOI 含上下标"
    if _SPACE_BEFORE_SUB.search(title or ""):
        return "标题空格损伤"
    if _UNCONVERTED_CHARGE.search(title or ""):
        return "标题电荷未转换"
    return ""


def endnote_stale_records(path: Path | None) -> tuple[list[str], str]:
    """EndNote 库活记录里的旧版污染清单。返回 (清单, 说明)：说明非空表示没查成。"""
    if path is None or not path.is_file():
        return [], f"EndNote 库不存在：{path}"
    if path.suffix.lower() == ".xml":
        xml_rows, _db, note = endnote_xml_records(path)
        if not xml_rows:
            return [], note
        hits = []
        for rec_id, doi, title, _added in xml_rows:
            which = _stale_flag(doi, title)
            if which:
                hits.append(f"记录 {rec_id}（{which}）｜{title[:44]}")
        return hits, ""
    try:
        conn, copied = open_library_copy(_endnote_sqlite_path(path))
    except (OSError, sqlite3.Error) as exc:
        return [], f"EndNote 库打不开（只读副本）：{exc}"
    try:
        rows = conn.execute(
            "SELECT id, electronic_resource_number, title FROM refs WHERE trash_state = 0"
        ).fetchall()
    except sqlite3.Error as exc:
        return [], (_legacy_note(path) or f"EndNote 库读不到记录：{exc}")
    finally:
        conn.close()
        copied.close()
    hits = []
    for rec_id, doi, title in rows:
        which = _stale_flag(str(doi or ""), str(title or ""))
        if which:
            hits.append(f"记录 {rec_id}（{which}）｜{(title or '')[:44]}")
    return hits, ""


_UNICODE_SUBSUP = frozenset("₀₁₂₃₄₅₆₇₈₉₊₋ₓᵧₙ⁰¹²³⁴⁵⁶₇⁸⁹⁺⁻ⁿ")


def endnote_unformatted_subscripts(path: Path | None, record_ids: set[int] | None = None) -> list[str]:
    """检出 EndNote 库里由纯文本 RIS 导入、题名带 Unicode 上下标字符（₂/⁻² 等）而非 EndNote 富文本上下标样式的活记录。
    EndNote 从 XML 导入 <style face="subscript|superscript"> 时，refs.title 存 ASCII 字符 + text_styles 样式表，不会命中这里。"""
    if path is None or not path.is_file() or path.suffix.lower() == ".xml":
        return []
    try:
        conn, copied = open_library_copy(_endnote_sqlite_path(path))
    except (OSError, sqlite3.Error):
        return []
    try:
        rows = conn.execute(
            "SELECT id, title FROM refs WHERE trash_state = 0"
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        conn.close()
        copied.close()
    out: list[str] = []
    for rec_id, title in rows:
        rid = int(rec_id)
        if record_ids is not None and rid not in record_ids:
            continue
        t = str(title or "")
        if any(c in _UNICODE_SUBSUP for c in t):
            out.append(f"记录 {rid}｜{t[:52]}")
    return out


def zotero_stale_items(db: Path | None) -> tuple[list[str], str]:
    """Zotero 用户库里的旧版污染清单。没配置数据目录时返回说明，不当错误。"""
    if db is None:
        db = zotero_db_path()
        if db is None:
            return [], "未找到 Zotero 数据目录，跳过库体检"
    if not db.is_file():
        return [], f"Zotero 库不存在：{db}"
    try:
        conn, copied = open_library_copy(db)
    except (OSError, sqlite3.Error) as exc:
        return [], f"Zotero 库打不开（只读副本）：{exc}"
    try:
        rows = conn.execute(
            "SELECT i.itemID, f.fieldName, v.value FROM items i "
            "JOIN libraries lib ON lib.libraryID = i.libraryID AND lib.type = 'user' "
            "JOIN itemData d ON d.itemID = i.itemID "
            "JOIN fields f ON f.fieldID = d.fieldID AND f.fieldName IN ('DOI', 'title') "
            "JOIN itemDataValues v ON v.valueID = d.valueID "
            "WHERE i.itemID NOT IN (SELECT itemID FROM deletedItems)"
        ).fetchall()
    except sqlite3.Error as exc:
        return [], f"Zotero 库读不到条目：{exc}"
    finally:
        conn.close()
        copied.close()
    per_item: dict[int, dict[str, str]] = {}
    for item_id, field, value in rows:
        per_item.setdefault(item_id, {})[field.lower()] = str(value)
    hits = []
    for item_id, fields in per_item.items():
        which = _stale_flag(fields.get("doi", ""), fields.get("title", ""))
        if which:
            hits.append(f"条目 {item_id}（{which}）｜{fields.get('title', '')[:44]}")
    return hits, ""
