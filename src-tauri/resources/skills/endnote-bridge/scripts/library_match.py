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
import sys
import tempfile
from pathlib import Path


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


def endnote_index(path: Path) -> tuple[dict[str, list[int]], dict[int, int], str, str]:
    """DOI → live record ids, record id → added_to_library 时间戳, library db-id, and a note."""
    if not path.is_file():
        return {}, {}, "", f"EndNote 库不存在：{path}"
    try:
        conn, copied = open_library_copy(path)
    except (OSError, sqlite3.Error) as exc:
        return {}, {}, "", f"EndNote 库打不开（只读副本）：{exc}"
    error = ""
    try:
        raw = conn.execute("SELECT value FROM misc WHERE code = 14 AND subcode = 0").fetchone()
        db_id = ""
        if raw and raw[0]:
            blob = raw[0]
            db_id = blob.decode("utf-8", "replace").strip() if isinstance(blob, bytes) else str(blob).strip()
        try:
            rows = conn.execute(
                "SELECT id, trash_state, electronic_resource_number, added_to_library FROM refs "
                "WHERE electronic_resource_number != ''"
            ).fetchall()
        except sqlite3.Error:
            # 老库没有 added_to_library 列：外键 timestamp 退回生成时刻。
            rows = [
                (rec_id, trash, doi, 0)
                for rec_id, trash, doi in conn.execute(
                    "SELECT id, trash_state, electronic_resource_number FROM refs "
                    "WHERE electronic_resource_number != ''"
                ).fetchall()
            ]
    except sqlite3.Error as exc:
        error = f"EndNote 库读不到记录：{exc}"
        rows = []
        db_id = ""
    finally:
        conn.close()
        copied.close()
    if error:
        return {}, {}, "", error
    index: dict[str, list[int]] = {}
    stamps: dict[int, int] = {}
    for rec_id, trash, doi, added in rows:
        if trash:
            continue
        key = norm_doi(str(doi))
        if doi_ok(key):
            index.setdefault(key, []).append(int(rec_id))
            # 外键上的 timestamp 用库里的入库时间，与 EndNote 自己插引文时写的一致。
            if isinstance(added, int) and added > 0:
                stamps[int(rec_id)] = added
    if not db_id:
        return index, stamps, "", "EndNote 库读不到库编号，记录号不写入域。"
    return index, stamps, db_id, ""


def bind_endnote(records: dict[str, dict], cited: list[str], library: Path | None, project_root: Path | None = None) -> list[str]:
    if library is None:
        library = endnote_pointer(project_root)
    if library is None:
        return ["未指定 EndNote 库，记录号未绑定。把库的绝对路径写进 papers/endnote-library.path（一行），或运行时加 --endnote-library。"]
    if library.suffix.lower() != ".enl" or not library.is_file():
        return [f"EndNote 库路径不是已有的 .enl：{library}"]
    index, stamps, db_id, note = endnote_index(library)
    lines = [f"EndNote 库：{library}"]
    if note:
        lines.append(note)
        return lines
    bound = 0
    for key in cited:
        rec = records.get(key)
        if not rec:
            continue
        doi = norm_doi(rec.get("doi") or "")
        if not doi_ok(doi):
            lines.append(f"- `{key}` 没有可用 DOI，未绑定")
            continue
        hits = index.get(doi) or []
        if len(hits) == 1:
            rec["_en_rec"] = hits[0]
            rec["_en_db"] = db_id
            if hits[0] in stamps:
                rec["_en_ts"] = stamps[hits[0]]
            bound += 1
        elif len(hits) > 1:
            lines.append(f"- `{key}` DOI `{doi}` 在库里有 {len(hits)} 条，未绑定")
        else:
            lines.append(f"- `{key}` DOI `{doi}` 库里没有，未绑定")
    lines.insert(1, f"已绑定 {bound} 条")
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
        path = home / ".zotero" / "zotero"
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


def bind_zotero(records: dict[str, dict], cited: list[str], database: Path | None) -> list[str]:
    if database is None:
        database = zotero_db_path()
        if database is None:
            return ["未找到当前 Zotero 配置写明的数据目录，条目地址未绑定。"]
    index, _user, note = zotero_index(database)
    lines = [f"Zotero 库：{database}"]
    if note:
        lines.append(note)
        lines.append("条目地址未写入域，没有编造占位 URI。")
        return lines
    bound = 0
    for key in cited:
        rec = records.get(key)
        if not rec:
            continue
        doi = norm_doi(rec.get("doi") or "")
        if not doi_ok(doi):
            lines.append(f"- `{key}` 没有可用 DOI，未绑定")
            continue
        hits = index.get(doi) or []
        if len(hits) == 1:
            rec["_zotero_uri"] = hits[0]
            bound += 1
        elif len(hits) > 1:
            lines.append(f"- `{key}` DOI `{doi}` 在库里有 {len(hits)} 条，未绑定")
        else:
            lines.append(f"- `{key}` DOI `{doi}` 库里没有，未绑定")
    lines.insert(1, f"已绑定 {bound} 条")
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
    try:
        conn, copied = open_library_copy(path)
    except (OSError, sqlite3.Error) as exc:
        return [], f"EndNote 库打不开（只读副本）：{exc}"
    try:
        rows = conn.execute(
            "SELECT id, electronic_resource_number, title FROM refs WHERE trash_state = 0"
        ).fetchall()
    except sqlite3.Error as exc:
        return [], f"EndNote 库读不到记录：{exc}"
    finally:
        conn.close()
        copied.close()
    hits = []
    for rec_id, doi, title in rows:
        which = _stale_flag(str(doi or ""), str(title or ""))
        if which:
            hits.append(f"记录 {rec_id}（{which}）｜{(title or '')[:44]}")
    return hits, ""


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
