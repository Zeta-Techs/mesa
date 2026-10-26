#!/usr/bin/env python3
"""Offline bibliography exchange. Writes a proposal, never the existing library."""
import argparse
import hashlib
import html
import json
import os
import re
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path


def identity(record):
    doi = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", record.get("doi", "").strip(), flags=re.I).lower()
    return "doi:" + doi if doi else "title:" + re.sub(r"\W+", "", record.get("title", "").casefold())


def excluded_identities(included_json):
    """papers/included.json 里人排除的篇（decision=excluded）：DOI 身份与标题身份都收。读不到返回空集。"""
    try:
        data = json.loads(Path(included_json).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return set()
    rows = data if isinstance(data, list) else (data.get('records') or data.get('items') or []) if isinstance(data, dict) else []
    out = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        if str(row.get('decision', '')).strip().lower() not in ('excluded', 'exclude'):
            continue
        doi = str(row.get('doi') or '').strip()
        if not doi:
            for field in ('url', 'id'):
                value = str(row.get(field) or '')
                hit = re.search(r'(10\.\d{4,9}/\S+)', value)
                if hit:
                    doi = hit.group(1)
                    break
        if doi:
            out.add(identity({'doi': doi}))
        title = str(row.get('title') or '')
        if re.sub(r"\W+", "", title):
            out.add(identity({'title': title}))
    return out


def drop_excluded(records, included_json):
    """「同步到文献库」只交没被排除的：引文库里还留着检索时导进来、后来人排除的篇（2026-10-23 HER：
    18 条 Zotero 硼化物批全排除，同步到 EndNote 仍整份 27 条导了进去）。返回 (留下的, 去掉几条)。"""
    gone = excluded_identities(included_json) if included_json else set()
    if not gone:
        return records, 0
    kept = [r for r in records if identity(r) not in gone and identity({'title': r.get('title', '')}) not in gone]
    return kept, len(records) - len(kept)


def decode_bib_text(value):
    # Preserve escaped literals; strip only TeX grouping, reject macros requiring a real TeX parser.
    out = []
    i = 0
    while i < len(value):
        char = value[i]
        if char == chr(92):
            if i + 1 >= len(value):
                raise ValueError('TeX macro/accent requires an explicit Unicode export before exchange')
            nxt = value[i + 1]
            if nxt in '&%_#{}$':
                out.append(nxt); i += 2; continue
            # BibTeX 引号转义 \"word，不是 TeX 变音 \"o / \"{o}
            if nxt == '"':
                rest = value[i + 2:]
                if rest.startswith('{') or (rest[:1].isalpha() and not rest[1:2].isalpha()):
                    raise ValueError('TeX macro/accent requires an explicit Unicode export before exchange')
                out.append('"'); i += 2; continue
            raise ValueError('TeX macro/accent requires an explicit Unicode export before exchange')
        if char not in '{}': out.append(char)
        i += 1
    return ''.join(out)


def bib_records(text):
    records = []
    pos = 0
    while pos < len(text):
        match = re.search(r"@([\w-]+)\s*\{", text[pos:])
        if not match:
            if text[pos:].strip() and not all(not x.strip() or x.lstrip().startswith('%') for x in text[pos:].splitlines()):
                raise ValueError("Unparsed BibTeX content; refusing lossy conversion")
            break
        kind = match[1].lower()
        if kind in ("string", "preamble"):
            raise ValueError("BibTeX macros/preamble require expansion before conversion")
        start = pos + match.end()
        depth, quote, escaped, end = 1, False, False, start
        while end < len(text) and depth:
            ch = text[end]
            if escaped:
                escaped = False
            elif ch == '\\':
                escaped = True
            elif ch == '"' and depth == 1:
                quote = not quote
            elif not quote:
                depth += (ch == '{') - (ch == '}')
            end += 1
        if depth:
            raise ValueError("Unclosed BibTeX record")
        body = text[start:end - 1]
        pos = end
        if kind == 'comment':
            continue
        key, sep, body = body.partition(',')
        if not sep or not key.strip():
            raise ValueError("Missing BibTeX citation key")
        record = {'id': key.strip(), 'type': kind}
        while body.strip(' ,\r\n\t'):
            body = body.lstrip(' ,\r\n\t')
            field = re.match(r'([\w-]+)\s*=\s*', body)
            if not field:
                raise ValueError("Unsupported BibTeX field expression")
            name = field[1].lower()
            body = body[field.end():]
            if not body:
                raise ValueError("Missing field value")
            opening = body[0]
            if opening in '{"':
                depth, escaped, i = 1, False, 1
                while i < len(body) and depth:
                    ch = body[i]
                    if escaped:
                        escaped = False
                    elif ch == '\\':
                        escaped = True
                    elif opening == '{':
                        depth += (ch == '{') - (ch == '}')
                    elif ch == '"':
                        depth = 0
                    i += 1
                if depth:
                    raise ValueError("Unclosed BibTeX value")
                value, body = body[1:i-1], body[i:]
            else:
                value, comma, body = body.partition(',')
                if not value.strip().isdigit():
                    raise ValueError("Unexpanded BibTeX macro")
            record[name] = value.strip()
        record['authors'] = re.split(r'\s+and\s+', record.pop('author', '')) if record.get('author') else []
        record['journal'] = record.get('journal') or record.get('booktitle', '')
        record['authors'] = [decode_bib_text(a) for a in record['authors']]
        keywords = record.pop('keywords', '')
        if keywords:
            record['keywords'] = [part.strip() for part in re.split(r'\s*;\s*|\s+and\s+', keywords) if part.strip()]
        # BibTeX 字段名全小写；EndNote 侧用这几个内部名。
        for src, dest in (
            ('journalabbreviation', 'journalAbbreviation'),
            ('shortjournal', 'journalAbbreviation'),
            ('epubdate', 'epubDate'),
            ('articletype', 'articleType'),
        ):
            if record.get(src) and not record.get(dest):
                record[dest] = record.pop(src)
        for key, value in list(record.items()):
            if key not in ('authors', 'keywords', 'id', 'type') and isinstance(value, str):
                record[key] = decode_bib_text(value)
        records.append(record)
    return records


def parse_bibtex(text):
    # 先关句柄再交给解析。Windows 上没关的临时文件删不掉（WinError 32）。
    fd, name = tempfile.mkstemp(suffix=".bib")
    stamp = Path(name)
    try:
        with open(fd, "w", encoding="utf-8", closefd=True) as handle:
            handle.write(text)
        return load(stamp)
    finally:
        stamp.unlink(missing_ok=True)


def _placeholder(value):
    # 「无期号」= 这本刊不分期（lit_records.py 补字段时按 Crossref 判定），同样不是值
    return str(value).strip() in ('待补', '待核', '无期号')


def load(path):
    records = _load(path)
    # 输入侧统一愈合标识符：老文件里被美化成上下标的数字折回 ASCII，回程对账才对得上。
    # 页码/卷/期/ISSN 同病（A₂₅₇ 这类文章号页码），一并折叠（2026-10-11 对抗审查实证）。
    for record in records:
        # 引文库里「待补」「待核」是给人看的缺口标记，不是值：进了 RIS / XML 就成了 Zotero、EndNote
        # 里一格「待补」（2026-10-22 检索步复查）。读进来就当没有这个字段
        for field in list(record):
            value = record[field]
            if isinstance(value, list):
                kept = [v for v in value if not _placeholder(v)]
                if kept != value:
                    record[field] = kept
            elif isinstance(value, str) and _placeholder(value) and field not in ('id', 'type'):
                del record[field]
        for field in ('doi', 'url', 'pages', 'volume', 'number', 'issn'):
            if record.get(field):
                record[field] = plain_id(record[field])
    return records


def _load(path):
    with path.open('rb') as source:
        data = source.read(32 * 1024 * 1024 + 1)
    if len(data) > 32 * 1024 * 1024:
        raise ValueError('Bibliography exceeds 32 MiB')
    text = data.decode('utf-8-sig')
    if path.suffix.lower() == '.bib':
        return bib_records(text)
    if path.suffix.lower() == '.xml':
        if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
            raise ValueError('DTD/entities are not allowed')
        root = ET.fromstring(text)
        result = []
        for item in root.findall('.//record'):
            def value(name):
                el = item.find(name)
                return ''.join(el.itertext()).strip() if el is not None else ''
            pages = value('pages')
            start = (item.find('pages').get('start') or '').strip() if item.find('pages') is not None else ''
            end = (item.find('pages').get('end') or '').strip() if item.find('pages') is not None else ''
            if start and end and '--' not in pages and '-' in pages:
                pages = start + '--' + end
            keywords = [''.join(k.itertext()).strip() for k in item.findall('keywords/keyword')]
            keywords = [k for k in keywords if k]
            result.append({'id': value('label'), 'sourceRecordNumber': value('rec-number'), 'type': {'17': 'article', '6': 'book', '5': 'incollection', '47': 'inproceedings', '32': 'phdthesis'}.get(value('ref-type'), 'misc'),
                'title': value('titles/title'), 'journal': value('titles/secondary-title'),
                'journalAbbreviation': value('periodical/abbr-1') or value('titles/alt-title'),
                'authors': [''.join(a.itertext()).strip() for a in item.findall('contributors/authors/author')],
                'year': value('dates/year'), 'date': value('dates/pub-dates/date'),
                'epubDate': value('edition'), 'doi': value('electronic-resource-num'),
                'volume': value('volume'), 'number': value('number'), 'pages': pages,
                'articleType': value('work-type'), 'abstract': value('abstract'), 'notes': value('notes'),
                'language': value('language'), 'keywords': keywords,
                'url': value('urls/web-urls/url'), 'issn': value('isbn'),
                'attachments': [''.join(a.itertext()).strip() for a in item.findall('urls/pdf-urls/url')], 'sourceXml': ET.tostring(item,encoding='unicode')})
        if not result and root.tag != 'xml':
            raise ValueError('Not EndNote XML')
        return result
    if path.suffix.lower() == '.ris':
        result, current, last = [], None, None
        fields = {
            'TI':'title', 'T1':'title', 'JO':'journal', 'JF':'journal', 'T2':'journal',
            'JA':'journalAbbreviation', 'J2':'journalAbbreviation', 'J1':'journalAbbreviation',
            'PY':'year', 'Y1':'year', 'DA':'date', 'DO':'doi', 'VL':'volume', 'IS':'number',
            'SP':'pages', 'UR':'url', 'ID':'id', 'SN':'issn', 'AB':'abstract', 'N2':'abstract',
            'N1':'notes', 'M3':'articleType', 'LA':'language', 'ET':'epubDate',
        }
        for line in text.splitlines():
            if not line.strip():
                continue
            m = re.match(r'^([A-Z0-9]{2})\s{2}-\s?(.*)$', line)
            if not m:
                if current is not None and last:
                    current[last] = str(current.get(last, '')) + ' ' + line.strip()
                    continue
                raise ValueError('Invalid RIS line')
            tag, value = m.groups()
            if tag == 'TY':
                if current is not None:
                    raise ValueError('RIS record missing ER')
                current = {'type': {'JOUR':'article','BOOK':'book','CHAP':'incollection','CONF':'inproceedings','THES':'phdthesis'}.get(value,'misc'), 'authors': [], 'attachments': []}
            elif tag == 'ER':
                if current is None:
                    raise ValueError('RIS ER without record')
                result.append(current); current = None
            elif current is None:
                raise ValueError('RIS record missing TY')
            elif tag in ('AU', 'A1'):
                current['authors'].append(value); last = None
            elif tag == 'KW':
                current.setdefault('keywords', []).append(value); last = None
            elif tag == 'L1':
                current['attachments'].append(value); last = None
            elif tag == 'EP':
                current['pages'] = current.get('pages', '') + '--' + value
            elif tag in fields:
                last = fields[tag]; current[last] = value
            else:
                current.setdefault('risFields', {}).setdefault(tag, []).append(value)
                last = None
        if current is not None:
            raise ValueError('RIS record missing ER')
        return result
    raise ValueError('Input must be UTF-8 .bib, .xml or .ris')


def escape_bib(value):
    return ''.join('\\'+c if c in '&%_#{}$' else c for c in str(value))


_SUB = str.maketrans('0123456789+-xy−', '₀₁₂₃₄₅₆₇₈₉₊₋ₓᵧ₋')
_SUP = str.maketrans('0123456789+-−', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻')

# DOI/URL/附件路径是标识符：不做化学上下标美化，只折空白；输入侧再把上下标/全角
# 数字折叠回 ASCII（老导入文件里的 10.1039/D₂EE₀₄₁₂₁A 这类愈合回 D2EE04121A）。
_DIGIT_FOLD = {}
for _i, _c in enumerate('₀₁₂₃₄₅₆₇₈₉'):
    _DIGIT_FOLD[ord(_c)] = str(_i)
for _i, _c in enumerate('⁰¹²³⁴⁵⁶⁷⁸⁹'):
    _DIGIT_FOLD[ord(_c)] = str(_i)
for _i, _c in enumerate('０１２３４５６７８９'):
    _DIGIT_FOLD[ord(_c)] = str(_i)


def plain_id(value):
    return ' '.join(str(value or '').translate(_DIGIT_FOLD).split())


def ascii_doi(value):
    return plain_id(value)


def _shift_marks(text, table):
    return text.translate(table)


# IUPAC 元素符号（与 src/screening-review.ts 的 ELEMENT_SYMBOLS 同一份）
_ELEMENTS = frozenset(
    'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr '
    'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu '
    'Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg '
    'Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split())
# 这些词后面的 S1、S2、2 是补充材料 / 图表编号，不是硫、不是下标
_REF_WORD = re.compile(
    r'(?:Fig|Figs|Figure|Figures|Table|Tables|Scheme|Schemes|Eq|Eqs|Equation|Equations|Note|Notes|'
    r'Movie|Movies|Video|Videos|Section|Appendix|Supplementary|Text|Data)\.?\s*$', re.I)
_FORMULA_WORD = re.compile(r'[A-Za-z0-9()]+(?:\.\d+[A-Za-z0-9()]*)*')


def _element_len(word, i):
    """word[i:] 开头的元素符号长度；后面还在拼单词（Cobalt）就不算。单独的计量 x 除外。"""
    def continues(j):
        if j >= len(word) or not word[j].islower():
            return False
        # 计量 x 后面是下一个元素（MgxMo3S4）或词尾，就不是在拼单词
        return not (word[j] == 'x' and (j + 1 >= len(word) or not word[j + 1].islower()))
    two = word[i:i + 2]
    if len(two) == 2 and two[0].isupper() and two[1].islower() and two in _ELEMENTS and not continues(i + 2):
        return 2
    if word[i].isupper() and word[i] in _ELEMENTS and not continues(i + 1):
        return 1
    return 0


def _formula_parts(word):
    """整词拆成元素 / 括号 / 计量数 / 计量 x，拆不完返回 None。MXene 的端基 Tx 也认。"""
    parts = []
    i = 0
    while i < len(word):
        ch = word[i]
        if ch in '()':
            parts.append(('paren', ch))
            i += 1
            continue
        if ch == 'x' and parts and parts[-1][0] in ('el', 'paren', 'num') and (i + 1 >= len(word) or not word[i + 1].islower()):
            parts.append(('x', ch))
            i += 1
            continue
        num = re.match(r'\d{1,2}(?:\.\d+)?(?!\d)', word[i:])
        if num and parts and parts[-1][0] in ('el', 'paren'):
            parts.append(('num', num.group(0)))
            i += len(num.group(0))
            continue
        # 合金式里的 TM（过渡金属占位，Y(TM1TM2)B4、Zr1-xTMxB2）按一个元素算
        if word[i:i + 2] == 'TM' and word[i + 2:i + 3] in ('', 'x') or word[i:i + 2] == 'TM' and not word[i + 2:i + 3].islower():
            parts.append(('el', 'TM'))
            i += 2
            continue
        if word[i:] in ('Tx', 'Tz') and parts:
            parts.append(('el', 'T'))
            parts.append(('x', word[i + 1]))
            i += 2
            continue
        n = _element_len(word, i)
        if n:
            parts.append(('el', word[i:i + n]))
            i += n
            continue
        return None
    return parts


def _is_formula(word):
    """MoS2、TiO2、Ni(OH)2、MoSx、Ti3C2Tx 是式子；B3LYP、Lux、H1N1、单个 V 不是。"""
    if not word or not (word[0].isupper() or word[0] == '('):
        return False
    if re.fullmatch(r'H\d+N\d+', word):
        return False
    parts = _formula_parts(word)
    if not parts:
        return False
    elements = sum(1 for kind, _ in parts if kind == 'el')
    has_num = any(kind == 'num' for kind, _ in parts)
    has_x = any(kind == 'x' for kind, _ in parts)
    # 有计量数就算；只有计量 x 的（MoSx、NiOx）要两个以上元素，Lux、Nox 这类单元素加 x 的是普通词
    return has_num or (has_x and elements >= 2)


def _subscript_formulas(text):
    """整句里逐个词判：是化学式才把元素 / 括号后的计量数和计量 x 收成下标。
    图表编号（Figure S2、Table S1）跳过。已经是下标的不再动。"""
    out = []
    last = 0
    for m in _FORMULA_WORD.finditer(text):
        word = m.group(0)
        start = m.start()
        out.append(text[last:start])
        last = m.end()
        if _REF_WORD.search(text[max(0, start - 16):start]) or not _is_formula(word):
            out.append(word)
            continue
        parts = _formula_parts(word)
        piece = []
        for kind, value in parts:
            if kind in ('num', 'x'):
                piece.append(value.translate(_SUB))
            else:
                piece.append(value)
        out.append(''.join(piece))
    out.append(text[last:])
    return ''.join(out)


_SPLIT_FORMULA = re.compile(r'([₀₁₂₃₄₅₆₇₈₉ₓᵧ])[ \t]+([A-Z][A-Za-z0-9₀₁₂₃₄₅₆₇₈₉ₓᵧ]*)')
_UNSUB = str.maketrans('₀₁₂₃₄₅₆₇₈₉ₓᵧ', '0123456789xy')


def _join_formula_word(m):
    """下标后隔空格的下一个词：能拆成元素 + 计量、且带数字（SO₃）或只是单个元素字母（B），才是同一个式子。
    标题里首字母大写的 As、In、At 不接。"""
    word = m.group(2)
    plain = word.translate(_UNSUB)
    if (len(plain) == 1 or re.search(r'\d', plain)) and _formula_parts(plain):
        return m.group(1) + word
    return m.group(0)


_TITLE_PREFIX = re.compile(r'^\s*(?:【\s*\d+\s*】|\[\s*\d+\s*\]|\d+\s*~\s*\.?)\s*')


def strip_title_prefix(title):
    """去掉题名前人手加的编号（【77】、[12]、19~.）。只给导出文件用，不改引文库。"""
    return _TITLE_PREFIX.sub('', str(title or ''), count=1)


def title_text(value):
    return strip_title_prefix(clean(value))



def clean(value):
    if value is None:
        return ''
    # NUL 与私用区 E000-E3FF 是标识符占位符的哨兵字符；源文本里混进来的先剥掉，防占位符错位。
    # 哨兵不能用数字编码：占位符若落在 <sup>/<sub> 标签内，索引数字会被 _shift_marks
    # 转成上/下标数字，恢复正则失配 → URL 静默丢失 + 哨兵字符泄漏（2026-10-11 对抗审查实证）。
    text = re.sub('[\x00-]', '', str(value)).replace('\r', ' ').replace('\n', ' ')
    # 标识符整段豁免：摘要里引用的 DOI/URL 同样不做化学美化（\)(\d+) 等规则会命中
    # 10.1016/s0022-0728(99)00146-1 一类后缀）。先摘出去占位，收尾折空白放回。
    # 匹配不跨 < >：URL 紧跟 </sup> 时不能把闭标签一起吞掉。
    parked = []

    def _park(match):
        parked.append(match.group(0))
        return chr(0xE000 + len(parked) - 1)

    text = re.sub(r'https?://[^<>\s]+|(?<![\w.])10\.\d{4,9}/[^<>\s]+', _park, text, flags=re.I)
    # 先去掉斜体粗体标签，再把上下标收成 Unicode。两个库都按字符显示，不再留 <sup> 或变成 S0。
    text = re.sub(r'</?(?:i|b|em|strong)>', '', text, flags=re.I)
    # 标签里的排版空格（<sub> x </sub>）先收掉，下一条才认得出这是化学附件
    text = re.sub(r'<(sub|sup)>\s*(.*?)\s*</\1>', lambda m: f'<{m.group(1)}>{m.group(2)}</{m.group(1)}>', text, flags=re.I)
    # Crossref 在标签前留的排版空格：MgCl <sub>2</sub>、cm <sup>−2</sup>、) <sub>2</sub>。
    # 前一字符是字母数字/右括号/右中括号、标签内容以数字或正负号/x/y 开头才算化学附件，吃掉这个空格；
    # 纯文字（"…in <sub>…"）不带这些标签，不受影响。标签名允许大小写混写，内容类保持大小写敏感
    # （大写 <sub>X</sub> 是染色体/变量记法，X 不在翻译表里，粘连成 maximumX 更糟）。
    text = re.sub(
        r'(?<=[A-Za-z0-9)\]])[ \t ]+(?=<[sS][uU][bB]>[+\-−0-9xy]|<[sS][uU][pP]>[+\-−0-9xy])',
        '', text)
    text = re.sub(r'<sup>(.*?)</sup>', lambda m: _shift_marks(m.group(1), _SUP), text, flags=re.I)
    text = re.sub(r'<sub>(.*?)</sub>', lambda m: _shift_marks(m.group(1), _SUB), text, flags=re.I)
    text = re.sub(r'<[^>]+>', '', text)
    # Crossref 把下标写成空格：CF 3、) 2、MgCl 2。只收元素符号或右括号后面的数字，不动 Figure 2。
    def sub_num(token):
        return _shift_marks(token, _SUB)

    def sup_num(token):
        return _shift_marks(token, _SUP)

    previous = None
    while previous != text:
        previous = text
        # 复合物末位是「化学计量数+电荷」而不是高价电荷：Mg2Cl3+ 是 [Mg₂(μ-Cl)₃]⁺（2026-10-11
        # 全量巡查实证：被读成 Mg₂Cl³⁺，化学含义翻转）。两个以上「元素+数字」组再跟 + 时，
        # 只把 + 上标，数字留给下标规则。单个 Mg2+ 仍是 Mg²⁺。
        text = re.sub(r'((?:[A-Z][a-z]?\d{1,2}){2,})\+', lambda m: m.group(1) + '⁺', text)
        # 电荷上标常以连字符形容词收尾：Mg2+-Conducting、Li+-based。'-' 不在豁免之列，
        # 豁免它就整串不动（2026-10-11 实证：Mg2+-Conducting 原样进了参考文献表）。
        text = re.sub(r'([A-Za-z])[ \t]*(\d{1,2}\+)(?![A-Za-z0-9])', lambda m: m.group(1) + sup_num(m.group(2)), text)
        text = re.sub(r'([A-Z][a-z]?)(\d+)-x(?![a-z])', lambda m: m.group(1) + sub_num(m.group(2)) + '₋ₓ', text)
        # 元素后的计量数与计量 x：按「整词能拆成元素 + 计量」认（_subscript_formulas）。原先逐字符认，
        # MoS2、TiO2、NiFe2O4 这类多元素式子中间那几位漏掉，Figure S2、B3LYP、Lux 反被下标
        # （2026-10-23 HER 导出核查：界面显示 MoS₂，导出仍是 MoS2）
        text = _subscript_formulas(text)
        # 存量已损坏形态的愈合：老产物里「字母+空格+上下标字」（MgCl ₂、cm ⁻²）把空格吃掉。
        # 正常散文里不会出现 Unicode 上下标字符，此规则只命中被旧版污染过的题录。
        text = re.sub(r'(?<=[A-Za-z0-9)\]])[ \t ]+(?=[₀₁₂₃₄₅₆₇₈₉⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻])', '', text)
        # 位数收到 1–2 位：化学计量鲜有 3 位以上，而「In 2020,」「At 300 K」这类散文高频句式
        # 会被 3+ 位整段下标（2026-10-11 对抗审查实证）。页码 A257 也靠「1–2 位+后视断言」自然豁免。
        text = re.sub(r'([A-Z][a-z]?|\))[ \t]+(\d{1,2}(?:\.\d+)?)(?![0-9+])', lambda m: m.group(1) + sub_num(m.group(2)) if m.group(1) == ')' or m.group(1) in _ELEMENTS else m.group(0), text)
        # 下标后隔空格的式子后半截接上（Crossref 的 Co₂ B、CF₃ SO₃）；下一个是普通词就不接（Ti₃C₂Tₓ MXene）
        text = _SPLIT_FORMULA.sub(_join_formula_word, text)
        text = re.sub(r'([₀₁₂₃₄₅₆₇₈₉ₓᵧ])[ \t]+\)', r'\1)', text)
    # 界面显示规则已经收住的写法。这里只补导入，不把两套合成一个函数。
    text = text.replace('\uf8ff', '–').replace('\u2500', '–').replace('\u2010', '-')
    text = re.sub(r'([A-Z][a-z]?)(\d+)-([A-Z]{2,4})B(\d+)', lambda m: m.group(1) + sub_num(m.group(2)) + '₋ₓ' + m.group(3) + 'ₓB' + sub_num(m.group(4)), text)
    text = re.sub(r'([A-Z][a-z]?)x([A-Z][a-z]?)yB', lambda m: m.group(1) + 'ₓ' + m.group(2) + 'ᵧB', text)
    # CO2RR 这类缩略词里的式子；字母拆不成元素的（PM2.5、MOF5 里的 MOF）不动
    text = re.sub(r'([A-Z]{2,3})(\d+)', lambda m: m.group(1) + sub_num(m.group(2)) if _formula_parts(m.group(1)) else m.group(0), text)
    text = re.sub(r'([A-Z][a-z]?) (\d+)(?= -\d)', lambda m: m.group(1) + sub_num(m.group(2)), text)
    text = re.sub(r'([₀₁₂₃₄₅₆₇₈₉])[ \t]*[A-Z][ \t]+(\d+(?:\.\d+)?)', lambda m: m.group(1) + 'T' + sub_num(m.group(2)), text)
    text = re.sub(r'([₀₁₂₃₄₅₆₇₈₉])[–−-]ₓ', r'\1₋ₓ', text)
    text = re.sub(r'([₀₁₂₃₄₅₆₇₈₉])[–−-]x(?![A-Za-z])', r'\1₋ₓ', text)
    text = re.sub(r'[ \t]+x(?![A-Za-z])', 'ₓ', text)
    text = re.sub(r'([A-Z][a-z]?) n[ \t]*\+[ \t]*1', r'\1ₙ₊₁', text)
    text = re.sub(r'([A-Z][a-z]?) n(?![A-Za-z])', r'\1ₙ', text)
    text = re.sub(r'TMB (\d+)', lambda m: 'TMB' + sub_num(m.group(1)), text)
    text = re.sub(r'\)(\d+)', lambda m: ')' + sub_num(m.group(1)), text)
    # 单位上标：µA cm −2、mA cm–2、mA cm−2 都收成 cm⁻²。旧规则只认数字紧邻 A 的写法，
    # µA（µ 不进 \d）和不带空格的 cm−2 全部漏掉。后面不能再跟字母数字（cm-2D 是二维材料）。
    text = re.sub(r'cm ?[−–-]2(?![0-9A-Za-z])', 'cm⁻²', text)
    text = re.sub(r'(?<=\bh) -(?=[A-Z])', '-', text)
    text = re.sub(r'([₀₁₂₃₄₅₆₇₈₉])\.(\d)', lambda m: m.group(1) + '\u2024' + sub_num(m.group(2)), text)
    text = re.sub(r'([₀₁₂₃₄₅₆₇₈₉])/(\d+)', lambda m: m.group(1) + '/' + sub_num(m.group(2)), text)
    text = _SPLIT_FORMULA.sub(_join_formula_word, text)
    text = re.sub(r'T[ \t]+z(?![A-Za-z])', 'Tz', text)
    text = re.sub(r'([₀₁₂₃₄₅₆₇₈₉ₓᵧⁿ])[ \t]+([-–])(?=[A-Za-z0-9])', r'\1\2', text)
    text = re.sub(r'([ₙ₊₁])[ \t]+(?=[A-Z])', r'\1', text)
    # 放回标识符原文（只折空白与上下标数字）
    text = re.sub('[-]', lambda m: plain_id(parked[ord(m.group(0)) - 0xE000]), text)
    # Crossref 的刊名、标题常带 &amp;（Journal of Materials Science &amp; Technology）。标签已经剥完再还原，
    # 免得 &lt;5 nm 还原成 < 后被当成标签吃掉
    text = html.unescape(text)
    return re.sub(r'\s+', ' ', text).strip()


def split_pages(pages):
    text = str(pages).replace('–', '-').replace('—', '-').replace('−', '-')
    # 区间分隔符按「横线串」切：BibTeX 页码是 1--8（双横线），按单 - 切会把
    # -8 当页尾，回程 EP 再拼 -- 变 1---8
    parts = re.split(r'-+', text, maxsplit=1)
    if len(parts) == 2 and parts[0].strip() and parts[1].strip():
        return parts[0].strip(), parts[1].strip()
    return text.strip(), ''


def xml_date(parent, tag, value):
    text = clean(value)
    match = re.match(r'(?:([A-Za-z]+)\s+)?(?:(\d{1,2}),\s+)?(\d{4})$', text)
    months = {
        'january': '1', 'february': '2', 'march': '3', 'april': '4', 'may': '5', 'june': '6',
        'july': '7', 'august': '8', 'september': '9', 'october': '10', 'november': '11', 'december': '12',
    }
    el = ET.SubElement(parent, tag)
    el.text = text
    if match and match.group(3):
        el.set('year', match.group(3))
        month = months.get((match.group(1) or '').lower())
        if month:
            el.set('month', month)
        if match.group(2):
            el.set('day', str(int(match.group(2))))
    return el


def bare_doi(value):
    # 标识符不走 clean()：化学美化会把 D2EE04121A 转成 D₂EE₀₄₁₂₁A，DOI 就废了。
    return re.sub(r'^https?://(?:dx\.)?doi\.org/', '', plain_id(value), flags=re.I)


def family_comma(author):
    # EndNote/RIS 作者按「姓, 名」解析；OpenAlex 等「名 姃」无逗号串会整串进姓字段，
    # 引用就成 (Jinlong et al., 2026)。无逗号多词名翻转为末词作姓；末词本身是
    # 缩写（PubMed 风格 Smith JM）时首词才是姓。已带逗号或单词名原样保留。
    name = str(author).strip()
    if not name or ',' in name:
        return author
    tokens = name.split()
    if len(tokens) < 2:
        return author
    last = tokens[-1].replace('.', '')
    if last.isalpha() and last.isupper() and len(last) <= 3:
        return tokens[0] + ', ' + ' '.join(tokens[1:])
    return tokens[-1] + ', ' + ' '.join(tokens[:-1])


def render(records, suffix):
    if suffix == '.xml':
        # EndNote.dtd：ref-type/@name 必填，record 子元顺序固定。缺 name 或顺序错会静默导入 0 条。
        type_code = {'article':17,'book':6,'incollection':5,'inproceedings':47,'phdthesis':32}
        type_name = {17:'Journal Article',6:'Book',5:'Book Section',47:'Conference Paper',32:'Thesis',13:'Generic'}
        root = ET.Element('xml'); rows = ET.SubElement(root, 'records')
        for i, r in enumerate(records, 1):
            item = ET.SubElement(rows, 'record')
            def put(path, value, attrs=None):
                parent = item
                parts = path.split('/')
                for part in parts[:-1]:
                    child = parent.find(part)
                    if child is None:
                        child = ET.SubElement(parent, part)
                    parent = child
                el = ET.SubElement(parent, parts[-1], attrs or {})
                el.text = str(value)
            code = type_code.get(r.get('type'), 13)
            ET.SubElement(item, 'source-app', {'name':'EndNote','version':'21.0'}).text = 'EndNote'
            put('rec-number', i)
            put('ref-type', code, {'name': type_name.get(code, 'Generic')})
            for author in r.get('authors', []): put('contributors/authors/author', family_comma(author))
            if r.get('title'): put('titles/title', title_text(r['title']))
            if r.get('journal'): put('titles/secondary-title', clean(r['journal']))
            short, alt = journal_abbreviations(r)
            if short:
                # EndNote.dtd 里期刊缩写在 periodical/abbr-1。EndNote 2025 期刊类型的
                # 「其他形式的期刊名」是 Field 29（Generic 的 Alternate Title = titles/alt-title）。
                # 两处都写：XML 导入认 abbr-1，界面字段认 alt-title。另一种写法进 abbr-2。
                put('periodical/abbr-1', short)
                if alt:
                    put('periodical/abbr-2', alt)
                put('titles/alt-title', short)
            # EndNote.dtd 的 record 子元素顺序：pages → volume → number → keywords → dates
            # → isbn → abstract → notes → work-type → urls → electronic-resource-num → language。
            # 插错顺序时 EndNote 会整份拒绝。
            if r.get('pages'):
                start, end = split_pages(r['pages'])
                put('pages', f'{start}-{end}' if end else start, {'start': start, **({'end': end} if end else {})})
            if r.get('volume'): put('volume', r['volume'])
            if r.get('number'): put('number', r['number'])
            # 期刊类型里 Field 14 从 Edition 改名为「网络出版日期」，元素仍是 edition。
            if r.get('epubDate'): put('edition', r['epubDate'])
            for word in r.get('keywords') or []:
                put('keywords/keyword', word)
            if r.get('year') or r.get('date'):
                dates = ET.SubElement(item, 'dates')
                if r.get('year'):
                    xml_date(dates, 'year', r['year'])
                if r.get('date'):
                    xml_date(ET.SubElement(dates, 'pub-dates'), 'date', r['date'])
            if r.get('issn') or r.get('isbn'): put('isbn', r.get('issn') or r.get('isbn'))
            if r.get('abstract'): put('abstract', clean(r['abstract']))
            # label 在 DTD 里位于 abstract 与 notes 之间
            put('label', r['id'])
            if r.get('notes'): put('notes', r['notes'])
            if r.get('articleType'): put('work-type', r['articleType'])
            if r.get('url') or r.get('attachments'):
                urls = ET.SubElement(item, 'urls')
                if r.get('url'):
                    web = ET.SubElement(urls, 'web-urls')
                    ET.SubElement(web, 'url').text = plain_id(r['url'])
                if r.get('attachments'):
                    pdfs = ET.SubElement(urls, 'pdf-urls')
                    for attachment in r['attachments']:
                        ET.SubElement(pdfs, 'url').text = plain_id(attachment)
            if r.get('doi'):
                put('electronic-resource-num', bare_doi(r['doi']))
            if r.get('language'): put('language', r['language'])
        return ET.tostring(root, encoding='unicode', xml_declaration=True) + '\n'
    if suffix == '.ris':
        def line(tag, value):
            return f'{tag}  - {clean(value)}'
        result = []
        for r in records:
            result.append(line('TY', {'article':'JOUR','book':'BOOK','incollection':'CHAP','inproceedings':'CONF','phdthesis':'THES'}.get(r.get('type'), 'JOUR')))
            # RIS Reference ID 载 citation key（XML 走 <label>、.enw 走 %F 的同一职责）：
            # 不写这条，键出了 RIS 就丢，回程只能重生成 ref<hash>，--existing 也接不上。
            # 键是标识符，不过 clean()
            result.append(f'ID  - {r["id"]}')
            # 一位作者一行。逗号串进同一条 AU 会被 EndNote 当成一个人。
            for author in r.get('authors', []):
                result.append(line('AU', family_comma(author)))
            if r.get('title'):
                result.append(line('TI', strip_title_prefix(r['title'])))
            # EndNote 2025 RefMan RIS：期刊全称 T2，缩写 J2。
            # 不再写 JO/JF/JA。Zotero 会把 JO 放进期刊缩写；这份只给 EndNote。
            if r.get('journal'):
                result.append(line('T2', r['journal']))
            # 另一种写法 RIS 没有地方放（EndNote 的期刊只有一格缩写），进期刊术语表（--journal-terms）
            short, _alt = journal_abbreviations(r)
            if short:
                result.append(line('J2', short))
            if r.get('year'):
                result.append(line('PY', r['year']))
                result.append(line('Y1', r['year']))
            if r.get('date'):
                result.append(line('DA', r['date']))
            if r.get('epubDate'):
                # ET 对应 edition；期刊文献里这一格显示为网络出版日期。
                result.append(line('ET', r['epubDate']))
            if r.get('volume'):
                result.append(f'VL  - {plain_id(r["volume"])}')
            if r.get('number'):
                result.append(f'IS  - {plain_id(r["number"])}')
            if r.get('pages'):
                start, end = split_pages(r['pages'])
                if start:
                    # EndNote 2025 RefMan RIS：SP 进「页」，M2 才进「起始页码」。
                    result.append(f'SP  - {plain_id(start)}')
                    result.append(f'M2  - {plain_id(start)}')
                if end:
                    result.append(f'EP  - {plain_id(end)}')
            if r.get('articleType'):
                # M3 进「文章类型」。M1 在这套过滤器里不进任何格子。
                result.append(line('M3', r['articleType']))
            if r.get('issn') or r.get('isbn'):
                result.append(f'SN  - {plain_id(r.get("issn") or r.get("isbn"))}')
            if r.get('doi'):
                result.append(f'DO  - {bare_doi(r["doi"])}')
            for word in r.get('keywords') or []:
                result.append(line('KW', word))
            if r.get('abstract'):
                result.append(line('AB', r['abstract']))
                result.append(line('N2', r['abstract']))
            if r.get('notes'):
                result.append(line('N1', r['notes']))
            if r.get('language'):
                result.append(line('LA', r['language']))
            if r.get('url'):
                result.append(f'UR  - {plain_id(r["url"])}')
            for attachment in r.get('attachments', []):
                result.append(f'L1  - {plain_id(attachment)}')
            result.append('ER  - ')
            result.append('')
        # EndNote 认 CRLF。不要加 BOM：带 BOM 时不认 TY 行，会跳过格式选择、静默导入 0 条。
        return '\r\n'.join(result) + '\r\n'
    if suffix == '.enw':
        type_name = {'article':'Journal Article','book':'Book','incollection':'Book Section','inproceedings':'Conference Paper','phdthesis':'Thesis'}
        result = []
        for r in records:
            result.append('%0 ' + type_name.get(r.get('type'), 'Journal Article'))
            for author in r.get('authors', []):
                result.append('%A ' + family_comma(author))
            if r.get('year'):
                result.append('%D ' + clean(r['year']))
            if r.get('date'):
                result.append('%8 ' + clean(r['date']))
            if r.get('title'):
                result.append('%T ' + title_text(r['title']))
            if r.get('journal'):
                result.append('%J ' + clean(r['journal']))
            short, _alt = journal_abbreviations(r)
            if short:
                result.append('%B ' + clean(short))
            if r.get('volume'):
                result.append('%V ' + plain_id(r['volume']))
            if r.get('number'):
                result.append('%N ' + plain_id(r['number']))
            if r.get('pages'):
                start, end = split_pages(r['pages'])
                result.append('%P ' + (f'{start}-{end}' if end else start))
            if r.get('issn') or r.get('isbn'):
                result.append('%@ ' + plain_id(r.get('issn') or r.get('isbn')))
            if r.get('abstract'):
                result.append('%X ' + clean(r['abstract']))
            for word in r.get('keywords') or []:
                result.append('%K ' + clean(word))
            if r.get('notes'):
                result.append('%Z ' + clean(r['notes']))
            if r.get('doi'):
                result.append('%R ' + bare_doi(r['doi']))
            if r.get('url'):
                result.append('%U ' + plain_id(r['url']))
            result.append('%F ' + r['id'])
            result.append('')
        return '\r\n'.join(result) + '\r\n'
    if suffix == '.bib':
        result = []
        for r in records:
            fields = {k:r[k] for k in ('title','journal','year','doi','volume','number','pages','url','isbn','issn','abstract','date','language','notes') if r.get(k)}
            if r.get('journalAbbreviation'): fields['journalabbreviation'] = r['journalAbbreviation']
            if r.get('epubDate'): fields['epubdate'] = r['epubDate']
            if r.get('articleType'): fields['articletype'] = r['articleType']
            if r.get('keywords'): fields['keywords'] = '; '.join(r['keywords'])
            if r.get('authors'): fields['author'] = ' and '.join(r['authors'])
            if any('\n@' in str(v) or str(v).count('{') != str(v).count('}') for v in fields.values()):
                raise ValueError('Unsafe/unbalanced BibTeX value; inspect proposal JSON')
            result.append('@'+r.get('type','misc')+'{'+r['id']+',\n'+''.join(f'  {k} = {{{escape_bib(v)}}},\n' for k,v in fields.items())+'}\n')
        return '\n'.join(result)
    if suffix == '.json': return json.dumps(records,ensure_ascii=False,indent=2)+'\n'
    raise ValueError('Output must be .xml, .ris, .bib or .json')


def main():
    # Windows 控制台/管道默认 cp1252：库体检提示含中文，print 会 UnicodeEncodeError
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input',type=Path);p.add_argument('--output',type=Path)
    p.add_argument('--report',type=Path);p.add_argument('--existing',type=Path)
    p.add_argument('--check-endnote-library',type=Path,dest='check_endnote_library')
    p.add_argument('--skip-excluded',type=Path,dest='skip_excluded',help='papers/included.json：其中排除的篇不进输出')
    p.add_argument('--journal-terms',type=Path,dest='journal_terms',help='另写一份 EndNote 期刊术语表（全称、缩写 1/2/3）')
    a=p.parse_args()
    if a.check_endnote_library is not None:
        # 库体检（同步按钮用）：只读列出旧版导出的污染记录，永远成功退出
        import importlib.util
        spec=importlib.util.spec_from_file_location('library_match',Path(__file__).with_name('library_match.py'))
        match=importlib.util.module_from_spec(spec);spec.loader.exec_module(match)
        hits,note=match.endnote_stale_records(a.check_endnote_library)
        if note: print(note)
        elif hits:
            print(f'库体检：检出 {len(hits)} 条旧版导出的脏记录，不删掉它们，新导入的去重认不出、旧数据会残留：')
            for h in hits: print(f'- {h}')
            print('处方：在 EndNote 里按上面的标题搜到这些记录删除（进废纸篓即可），再导入本次生成的 RIS。')
        else: print('库体检：库里没有旧版导出的脏记录。')
        return 0
    if a.input is None or a.output is None or a.report is None:
        print('--input/--output/--report are required',file=sys.stderr);return 1
    try:
        records=load(a.input); existing=load(a.existing) if a.existing else []
        if a.skip_excluded:
            records,dropped=drop_excluded(records,a.skip_excluded)
            if dropped: print(f'检索时排除的 {dropped} 篇不导。')
        if a.journal_terms:
            a.journal_terms.write_text(journal_terms(records), encoding='utf-8', newline='')
        for dest in (a.output,a.report):
            if dest.exists() or dest.is_symlink(): raise ValueError('Output exists; choose a new proposal path')
        if a.output.resolve()==a.report.resolve(): raise ValueError('Report and proposal paths must differ')
        old={}
        for record in existing:
            key=identity(record)
            if key in old:raise ValueError('Ambiguous existing duplicate DOI/title; resolve before matching citation keys')
            old[key]=record
        seen=set();unique=[];changes=[];warnings=[];keys=set()
        for r in records:
            if not r.get('title','').strip(): raise ValueError('Missing title; refusing silent record loss')
            key=identity(r)
            if key in seen: warnings.append({'duplicate':key});continue
            seen.add(key)
            prior=old.get(key)
            raw=(prior or r).get('id') or 'ref'+hashlib.sha256(key.encode()).hexdigest()[:12]
            if not re.fullmatch(r'[\w:.-]+',raw): raw='ref'+hashlib.sha256(key.encode()).hexdigest()[:12]
            if raw in keys: raw+='-'+hashlib.sha256(key.encode()).hexdigest()[:8]
            r['id']=raw;keys.add(raw)
            delta={k:{'before':(prior or {}).get(k),'after':v} for k,v in r.items() if k!='id' and v!=(prior or {}).get(k)}
            changes.append({'id':raw,'identity':key,'status':'changed' if prior and delta else 'unchanged' if prior else 'new','fields':delta})
            for field in ('year','authors','doi'):
                if not r.get(field):warnings.append({'id':raw,'missing':field})
            supported={'id','type','title','authors','journal','journalAbbreviation','booktitle','year','date','epubDate','doi','volume','number','pages','url','isbn','issn','abstract','keywords','notes','articleType','language','attachments','sourceRecordNumber','risFields'}
            extras={k:v for k,v in r.items() if k not in supported}
            if extras: warnings.append({'id':raw,'notMappedFields':extras})
            if a.output.suffix.lower()=='.bib' and r.get('attachments'):warnings.append({'id':raw,'attachmentsInReportOnly':r['attachments']})
            unique.append(r)
        output=render(unique,a.output.suffix.lower())
        report={'inputCount':len(records),'outputCount':len(unique),'inputSha256':hashlib.sha256(a.input.read_bytes()).hexdigest(),'existingUnchanged':True,'proposalOnly':True,'changes':changes,'warnings':warnings,'normalizedRecords':unique,
            'manualChecks':['Confirm diff before merging the main bibliography','Import XML using EndNote XML / RIS using Reference Manager (RIS); verify in your EndNote version','Author names flipped to "Family, Given" (heuristic for given-first sources); spot-check hyphenated or Chinese-order names','Check attachment resolution and Word plugin citations manually']}
        for path,text in [(a.output,output),(a.report,json.dumps(report,ensure_ascii=False,indent=2)+'\n')]:
            path.parent.mkdir(parents=True,exist_ok=True)
            with path.open('x',encoding='utf-8',newline='\n') as f:f.write(text)
        return 0
    except (OSError, ValueError, ET.ParseError) as e:
        print(str(e),file=sys.stderr);return 1

MONTHS = {
    1: 'January', 2: 'February', 3: 'March', 4: 'April', 5: 'May', 6: 'June',
    7: 'July', 8: 'August', 9: 'September', 10: 'October', 11: 'November', 12: 'December',
}
TYPE_LABEL = {
    'journal-article': 'Journal Article',
    'proceedings-article': 'Conference Paper',
    'posted-content': 'Preprint',
    'book-chapter': 'Book Section',
    'book': 'Book',
    'dissertation': 'Thesis',
    'report': 'Report',
}


# 接口缓存：与 lit_records.py 同一个目录、同一种文件名（sha1(url).body），检索步查过的同步时直接用；
# 30 天过期。同步按钮每次都要拉 JabRef 缩写表、补缺字段时要问 Crossref，不缓存每次都等。
_CACHE_DIR = Path(tempfile.gettempdir()) / 'mesa-lit-cache'
_CACHE_TTL = 30 * 24 * 3600


def _cache_file(url):
    return _CACHE_DIR / (hashlib.sha1(url.encode('utf-8')).hexdigest() + '.body')


def _cache_get(url):
    path = _cache_file(url)
    try:
        if path.is_file() and time.time() - path.stat().st_mtime < _CACHE_TTL and path.stat().st_size > 0:
            return path.read_bytes()
    except OSError:
        pass
    return None


def _cache_put(url, body):
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = _cache_file(url).with_suffix('.tmp%d' % os.getpid())
        tmp.write_bytes(body)
        os.replace(tmp, _cache_file(url))
    except OSError:
        pass


def _offline(url):
    """MESA_LIT_OFFLINE=1：不联网也不读缓存，当场按连不上处理（测试用，免得结果随网络和本机缓存变）。"""
    if os.environ.get('MESA_LIT_OFFLINE'):
        import urllib.error
        raise urllib.error.URLError('offline (MESA_LIT_OFFLINE): ' + url)


def http_json(url, timeout=40, attempts=4):
    import urllib.error
    import urllib.request
    _offline(url)
    cached = _cache_get(url)
    if cached is not None:
        try:
            return json.loads(cached.decode('utf-8'))
        except ValueError:
            pass
    last = None
    for i in range(attempts):
        req = urllib.request.Request(url, headers={
            'User-Agent': 'MesaEndnote/1.0 (bibliography; mailto:local)',
            'Accept': 'application/json',
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
            data = json.loads(body.decode('utf-8'))
            _cache_put(url, body)
            return data
        except urllib.error.HTTPError as err:
            last = err
            if err.code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (i + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as err:
            last = err
            time.sleep(1.2 * (i + 1))
    raise last


def date_parts(node):
    if not isinstance(node, dict):
        return None
    parts = (node.get('date-parts') or [None])[0]
    return parts or None


def fmt_date(parts):
    if not parts:
        return ''
    year = str(parts[0])
    if len(parts) == 1:
        return year
    month = MONTHS.get(parts[1], '')
    if len(parts) == 2 or not month:
        return f'{month} {year}'.strip()
    return f'{month} {int(parts[2])}, {year}'.strip()


def pick_issn(message):
    printed = ''
    for item in message.get('issn-type') or []:
        value = plain_id(item.get('value'))
        if item.get('type') == 'print' and value:
            printed = value
    if printed:
        return printed
    for value in message.get('ISSN') or []:
        if plain_id(value):
            return plain_id(value)
    return ''


def crossref_fill(doi):
    import urllib.parse
    message = http_json('https://api.crossref.org/works/' + urllib.parse.quote(doi))['message']
    issued = date_parts(message.get('issued')) or date_parts(message.get('published'))
    online = date_parts(message.get('published-online'))
    printed = date_parts(message.get('published-print'))
    container = message.get('container-title') or []
    short = message.get('short-container-title') or []
    # 页码/卷期/DOI/URL/ISSN 都是定位标识符：取值不过 clean()，化学美化会把
    # 文章号页码 A257 变成 A₂₅₇、DOI 后缀 D2EE04121A 变成 D₂EE₀₄₁₂₁A。
    page = plain_id(message.get('page')) or plain_id(message.get('article-number'))
    if not meaningful(page):
        page = ''
    authors = []
    for author in message.get('author') or []:
        family = clean(author.get('family'))
        given = clean(author.get('given'))
        name = clean(author.get('name'))
        if family and given:
            authors.append(f'{family}, {given}')
        elif family or name:
            authors.append(family or name)
    journal = clean(container[0]) if container else ''
    abbrev = clean(short[0]) if short else ''
    if abbrev.casefold() == journal.casefold():
        abbrev = ''
    abstract = clean(message.get('abstract'))
    keywords = [clean(s) for s in (message.get('subject') or []) if clean(s)]
    return {
        'title': clean((message.get('title') or [''])[0]),
        'authors': authors,
        'year': str(issued[0]) if issued else (str(online[0]) if online else ''),
        # 出版日期取纸本（期）的日期，网络出版日另记。Crossref 的 issued 是两者里早的那个，
        # 拿它比 online 永远相等，网络出版日就丢了（2026-10-22 检索步实证）
        'date': fmt_date(printed or issued or online),
        'epubDate': fmt_date(online) if online and online != (printed or issued) else '',
        'journal': journal,
        'journalAbbreviation': abbrev,
        'volume': plain_id(message.get('volume')) if meaningful(message.get('volume')) else '',
        'number': plain_id(message.get('issue')) if meaningful(message.get('issue')) else '',
        'pages': page,
        'issn': pick_issn(message),
        'doi': bare_doi(message.get('DOI') or doi),
        'url': plain_id(message.get('URL') or f'https://doi.org/{doi}'),
        'abstract': abstract if meaningful(abstract) else '',
        'keywords': keywords,
        'articleType': TYPE_LABEL.get(message.get('type') or '', ''),
        'language': clean(message.get('language')),
        'publisher': clean(message.get('publisher')),
    }


_nlm_cache = {}


def http_text(url, timeout=40, attempts=4):
    import urllib.error
    import urllib.request
    _offline(url)
    cached = _cache_get(url)
    if cached is not None:
        return cached.decode('utf-8', 'replace')
    last = None
    for i in range(attempts):
        req = urllib.request.Request(url, headers={
            'User-Agent': 'MesaEndnote/1.0 (bibliography; mailto:local)',
            'Accept': 'application/xml, application/json, text/plain',
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
            _cache_put(url, body)
            return body.decode('utf-8', 'replace')
        except urllib.error.HTTPError as err:
            last = err
            if err.code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (i + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as err:
            last = err
            time.sleep(1.2 * (i + 1))
    raise last


# ISO 4 带句点。按期刊全称查，不用 ISSN：NLM 的 ISSN 会把 Advanced Materials 对成 Adv Eng Mater。
# 顺序靠后的表只补前面没有的刊名，不覆盖已有缩写。
_ISO4_LISTS = (
    'journal_abbreviations_acs.csv',
    'journal_abbreviations_mechanical.csv',
    'journal_abbreviations_geology_physics.csv',
    'journal_abbreviations_general.csv',
    'journal_abbreviations_lifescience.csv',
)
_iso4_index = None


def _journal_key(name):
    text = clean(name).casefold().replace('&', ' and ')
    return ' '.join(text.split())


def tidy_abbreviation(value):
    """缩写写法收拾：句点后直接跟大写补空格（JabRef 表里的 J. Mater. Chem.A），句点后的冒号去掉
    （ISO 4 不留冒号：Mater. Rep.: Energy → Mater. Rep. Energy）。"""
    text = clean(value)
    # 只补「句点 + 大写开头的词 / 末尾单个大写」：U.S.A. 这类缩略不拆
    text = re.sub(r'\.(?=[A-Z](?:[a-z]|$))', '. ', text)
    text = re.sub(r'\.:\s*', '. ', text)
    return ' '.join(text.split())


def _mesa_rows():
    import csv
    path = Path(__file__).with_name('journal-abbreviations.csv')
    if not path.is_file():
        return []
    rows = []
    for row in csv.reader(path.read_text(encoding='utf-8').splitlines()):
        if not row or row[0].strip().startswith('#') or len(row) < 2:
            continue
        rows.append(row)
    return rows


def load_mesa_iso4():
    """resources/journal-abbreviations.csv 的「全称,缩写」。同步时由调用方放到脚本旁边。"""
    table = {}
    for row in _mesa_rows():
        key = _journal_key(row[0])
        short = tidy_abbreviation(row[1])
        if key and short:
            table[key] = short
    return table


def load_mesa_alt():
    """第三列：同一本刊的另一种通行缩写（ACS/CASSI 与 ISO 4 不一样时两种都给：Appl. Catal., B 与 Appl. Catal. B Environ.）"""
    table = {}
    for row in _mesa_rows():
        if len(row) < 3:
            continue
        key = _journal_key(row[0])
        alt = tidy_abbreviation(row[2])
        if key and alt:
            table[key] = alt
    return table


_MESA_ISO4 = load_mesa_iso4()
_MESA_ALT = load_mesa_alt()


def iso4_index():
    """JabRef 公开缩写表，再叠 Mesa 兜底。一次拉下，同一进程复用。失败的表跳过。"""
    global _iso4_index
    if _iso4_index is not None:
        for key, short in _MESA_ISO4.items():
            _iso4_index.setdefault(key, short)
        return _iso4_index
    import csv
    import io
    index = dict(_MESA_ISO4)
    for name in _ISO4_LISTS:
        try:
            text = http_text(f'https://abbrv.jabref.org/journals/{name}', timeout=40, attempts=2)
        except Exception:
            continue
        # JabRef 表是「"全称", "缩写"」：逗号后有空格，不跳过的话缩写会带上引号（"npj 2D Mater. Appl."）
        for row in csv.reader(io.StringIO(text), skipinitialspace=True):
            if len(row) < 2:
                continue
            key = _journal_key(row[0])
            short = tidy_abbreviation(row[1].strip().strip('"'))
            if key and short and key not in index:
                index[key] = short
    index.update(_MESA_ISO4)
    _iso4_index = index
    return index



# ---------- ISO 4：按 LTWA（ISSN 国际中心的期刊标题词缩写表）给任意刊名算缩写 ----------
# 同步到文献库时作「另一种写法」（EndNote 缩写 2、Zotero「其他」）：主缩写多是 ACS / CASSI 写法，
# 选「缩写 2」的样式就要整份都是 ISO 4，所以每本刊都算一份，和主缩写不同才给（2026-10-23 用户拍板「所有刊都做」）。
# LTWA 不随包：第一次用时从 ISSN 下载，进接口缓存（与 JabRef 缩写表同一处）；脚本旁边有 ltwa.csv 时用它（测试、离线）。
# 规则取 ISSN Manual 7.1 的常用部分：单词刊名不缩；冠词、连词、介词去掉；分册字母、全大写缩略词、
# 内含大写的词（ChemCatChem）照写；连字符词逐段缩；括号里的地名限定逐词缩；复数按单数查；
# 源词不带重音时缩写也不带（LTWA 把 medical 缩成 méd.）；缩写词首字母大写。
_LTWA_URL = 'https://www.issn.org/wp-content/uploads/2021/07/ltwa_20210702.csv'
_LTWA_RANK = ('eng', 'mul', 'lat', 'und')
_ISO4_STOP = frozenset((
    'a an the of and for in on at to by with from into via & + '
    'und der die das des dem den für fur fuer zur zum im '
    'de la le les du et en y e del della dei di da do dos das na no och og i ve'
).split())
_ltwa = None


def _plain(text):
    import unicodedata
    return ''.join(c for c in unicodedata.normalize('NFKD', text) if not unicodedata.combining(c))


def _ltwa_key(text):
    return _plain(text).casefold()


def _ltwa_table():
    """(整词表, 前缀表, 词组表)。下载或读不到时三张空表，调用方不给另一种写法。"""
    global _ltwa
    if _ltwa is not None:
        return _ltwa
    import csv
    import io
    local = Path(__file__).with_name('ltwa.csv')
    try:
        text = local.read_text(encoding='utf-8-sig') if local.is_file() else http_text(_LTWA_URL, timeout=60, attempts=2)
    except Exception:
        text = ''
    exact, prefix, phrases = {}, [], []
    for row in csv.reader(io.StringIO(text.lstrip('﻿')), delimiter=';'):
        if len(row) < 3 or row[0] == 'WORDS':
            continue
        word, abbr, langs = row[0].strip(), row[1].strip(), {x.strip() for x in row[2].split(',')}
        rank = min((_LTWA_RANK.index(x) for x in langs if x in _LTWA_RANK), default=len(_LTWA_RANK))
        if not word or word.startswith('-'):
            continue  # 后缀、词中片段：复合词，不处理
        if ' ' in word:
            phrases.append((_ltwa_key(word.rstrip('-')).split(), word.endswith('-'), abbr, rank))
        elif word.endswith('-'):
            prefix.append((_ltwa_key(word[:-1]), abbr, rank))
        else:
            key = _ltwa_key(word)
            if key not in exact or rank < exact[key][1]:
                exact[key] = (abbr, rank)
    prefix.sort(key=lambda x: (-len(x[0]), x[2]))
    phrases.sort(key=lambda x: -len(x[0]))
    _ltwa = (exact, prefix, phrases)
    return _ltwa


def _ltwa_word(word):
    exact, prefix, _ = _ltwa_table()
    key = _ltwa_key(word)
    found = []
    for k in (key, key[:-1] if key.endswith('s') else '', key[:-2] if key.endswith('es') else ''):
        if k and k in exact:
            found.append((exact[k][1], 0, exact[k][0]))
            break
    for stem, abbr, rank in prefix:
        if key.startswith(stem):
            found.append((rank, 1, abbr))
            break
    if not found:
        return None
    found.sort()
    return found[0][2]


def _iso4_shape(abbr, source):
    """n.a. = 不缩；源词不带重音时去掉缩写里的重音；首字母大写"""
    if abbr == 'n.a.':
        return source
    if _plain(source) == source:
        abbr = _plain(abbr)
    return abbr[:1].upper() + abbr[1:]


def _iso4_word(word):
    if len(word) == 1 or (word.isupper() and len(word) <= 5) or re.search(r'[a-z][A-Z]', word) or not re.match(r'[^\W\d_]', word):
        return word
    parts = []
    for part in word.split('-'):
        if not part or len(part) == 1 or (part.isupper() and len(part) <= 5) or re.search(r'[a-z][A-Z]', part):
            parts.append(part)
            continue
        abbr = _ltwa_word(part)
        parts.append(_iso4_shape(abbr, part) if abbr else part)
    return '-'.join(parts)


def _iso4_phrase(tokens, i):
    """tokens[i:] 开头能对上 LTWA 词组（United States of America → U. S. A.）就返回 (缩写, 用掉几个词)"""
    _, _, phrases = _ltwa_table()
    for seq, is_prefix, abbr, _rank in phrases:
        span = tokens[i:i + len(seq)]
        if len(span) != len(seq) or any(s.startswith('(') for s in span):
            continue
        keys = [_ltwa_key(s) for s in span]
        if keys[:-1] == seq[:-1] and (keys[-1] == seq[-1] or (is_prefix and keys[-1].startswith(seq[-1]))):
            return _iso4_shape(abbr, ' '.join(span)), len(seq)
    return None, 0


def _iso4_qualifier(text):
    """括号里的地名限定（Amsterdam, Netherlands）：逐段缩，词组优先（United Kingdom → U. K.），不去停用词"""
    segs = []
    for seg in text.split(','):
        words = seg.split()
        out = []
        i = 0
        while i < len(words):
            abbr, used = _iso4_phrase(words, i)
            if used:
                out.append(abbr)
                i += used
                continue
            out.append(_iso4_word(words[i]))
            i += 1
        segs.append(' '.join(out))
    return ', '.join(s for s in segs if s)


def iso4_compute(journal):
    """按 LTWA 算 ISO 4 缩写。LTWA 拿不到或刊名为空返回空。"""
    # 刊名按原样分词（不先做化学美化：CO2 要当一个词），结果再按导出口径收一遍
    title = ' '.join(html.unescape(re.sub(r'<[^>]+>', '', str(journal or ''))).replace('&', ' & ').split())
    # 「: an official journal of …」这类说明性副标题不算刊名（ISSN Manual 7.1 不缩副标题里的机构说明）
    title = re.sub(r'\s*:\s*(?:an?|the)?\s*official\s+(?:journal|publication)\b.*$', '', title, flags=re.I)
    if not title or not _ltwa_table()[0]:
        return ''
    spans = [(m.group(0), m.end()) for m in re.finditer(r"\([^)]*\)|[^\W\d_][\w'’]*(?:-[\w'’]+)*|\d+[^\W\d_][\w'’]*|\d+", title)]
    tokens = [tok for tok, _ in spans]
    words = [tok for tok in tokens if not tok.startswith('(') and not tok.isdigit()]
    content = [w for w in words if _ltwa_key(w) not in _ISO4_STOP or (len(w) == 1 and w.isupper())]
    if len(content) <= 1:
        # 单词刊名不缩，只缩括号里的限定
        return clean(re.sub(r'\(([^)]*)\)', lambda m: '(' + _iso4_qualifier(m.group(1)) + ')', title))
    out = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok.startswith('('):
            out.append('(' + _iso4_qualifier(tok[1:-1]) + ')')
            i += 1
            continue
        if tok.isdigit():
            out.append(tok)
            i += 1
            continue
        # 拉丁短语整段照写（7.1.7：in vitro、in vivo 里的介词不去）
        pair = ' '.join(tokens[i:i + 2]).casefold()
        if pair in ('in vitro', 'in vivo', 'in situ', 'in silico'):
            out.append(' '.join(tokens[i:i + 2]))
            i += 2
            continue
        abbr, used = _iso4_phrase(tokens, i)
        if used:
            out.append(abbr)
            i += used
            continue
        if len(tok) == 1 and tok.isupper() and i > 0:
            # 分册字母（Chem. A、Catal. B）照写；后面紧跟别的词的 A 是冠词（Chemistry - A European Journal）
            after = title[spans[i][1]:].lstrip()
            if not (tok == 'A' and after and after[0].isalpha()):
                out.append(tok)
        elif _ltwa_key(tok) not in _ISO4_STOP:
            out.append(_iso4_word(tok))
        i += 1
    return clean(' '.join(out))


def _abbr_key(text):
    return re.sub(r'[\s.,:;\-]+', ' ', clean(text)).strip().casefold()


def journal_abbreviations(record):
    """(主缩写, ISO 4 写法)。主缩写：引文库里有就用，没有查 JabRef 表 + Mesa 兜底，再没有用全称。
    ISO 4 写法：Mesa 表第三列有就用（人核过的），没有按 LTWA 算；和主缩写只差标点、大小写的不给。"""
    journal = record.get('journal') or ''
    primary = tidy_abbreviation(record.get('journalAbbreviation') or iso4_abbreviation(journal) or journal)
    alt = _MESA_ALT.get(_journal_key(journal), '')
    # 只给拉丁字母刊名算（中文刊名 LTWA 管不着，也省得为它下载词表）
    if not alt and re.search(r'[A-Za-z]{2}', journal):
        try:
            alt = iso4_compute(journal)
        except Exception:
            alt = ''
    if not alt or _abbr_key(alt) == _abbr_key(primary) or _abbr_key(alt) == _abbr_key(journal):
        alt = ''
    return primary, alt


def journal_terms(records):
    """EndNote 期刊术语表（工具 → 打开术语表 → 期刊术语表 → 列表 → 导入列表）：全称、缩写 1、缩写 2、缩写 3，制表符分隔。
    缩写 1 = 主缩写（与 RIS 的 J2 一致）；缩写 2 = 另一种写法，没有就同缩写 1；缩写 3 = 缩写 1 去掉句点。
    EndNote 的输出样式按「缩写 1 / 2 / 3」挑，两种写法都能用上。"""
    seen = {}
    for r in records:
        journal = clean(r.get('journal') or '')
        if not journal or journal.casefold() in seen:
            continue
        primary, alt = journal_abbreviations(r)
        seen[journal.casefold()] = '\t'.join([journal, primary, alt or primary, primary.replace('.', '')])
    return '\r\n'.join(seen.values()) + ('\r\n' if seen else '')


def iso4_abbreviation(journal):
    """按全称取 ISO 4 缩写。一词刊名（Nature、Small）表里就是全称，原样返回。对不上返回空。"""
    key = _journal_key(journal)
    if not key:
        return ''
    return iso4_index().get(key, '')


def nlm_abbreviation(issn):
    """NLM Catalog 的 MedlineTA。按 ISSN 查，同一期刊只查一次。没有记录就返回空。
    不带句点，且 ISSN 可能对到另一本刊。期刊缩写改走 iso4_abbreviation。"""
    key = clean(issn)
    if not key:
        return ''
    if key in _nlm_cache:
        return _nlm_cache[key]
    import urllib.parse
    term = urllib.parse.quote(f'{key}[ISSN]')
    found = http_json(
        'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'
        f'?db=nlmcatalog&term={term}&retmode=json'
    )
    ids = ((found.get('esearchresult') or {}).get('idlist') or [])
    abbr = ''
    if ids:
        xml = http_text(
            'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'
            f'?db=nlmcatalog&id={urllib.parse.quote(ids[0])}&retmode=xml'
        )
        root = ET.fromstring(xml)
        node = root.find('.//MedlineTA')
        abbr = clean(node.text if node is not None else '')
    _nlm_cache[key] = abbr
    time.sleep(0.34)
    return abbr


def s2_abbreviation(doi):
    """Semantic Scholar 的 alternate_names 里才有 ISO 式短名；Crossref 常把全称再写一遍。"""
    import urllib.parse
    url = (
        'https://api.semanticscholar.org/graph/v1/paper/DOI:'
        + urllib.parse.quote(doi)
        + '?fields=publicationVenue'
    )
    row = http_json(url)
    venue = row.get('publicationVenue') or {}
    full = clean(venue.get('name')).casefold()
    for name in venue.get('alternate_names') or []:
        text = clean(name)
        if text and text.casefold() != full and len(text) <= 28:
            return text
    return ''


def openalex_fill(doi):
    import urllib.parse
    work = http_json('https://api.openalex.org/works/doi:' + urllib.parse.quote(doi))
    if not isinstance(work, dict) or work.get('error'):
        return {}
    source = ((work.get('primary_location') or {}).get('source') or {})
    biblio = work.get('biblio') or {}
    index = work.get('abstract_inverted_index') or {}
    slots = {}
    for word, positions in index.items():
        for pos in positions:
            slots[pos] = word
    abstract = ' '.join(slots[i] for i in sorted(slots)) if slots else ''
    first = clean(biblio.get('first_page'))
    last = clean(biblio.get('last_page'))
    pages = f'{first}-{last}' if first and last and first != last else (first or last)
    keywords = []
    for item in work.get('keywords') or []:
        name = clean(item.get('display_name'))
        if name and (item.get('score') or 0) >= 0.4:
            keywords.append(name)
    abbrev = clean(source.get('abbreviated_title'))
    journal = clean(source.get('display_name'))
    if abbrev.casefold() == journal.casefold():
        abbrev = ''
    authors = []
    seen = set()
    for item in work.get('authorships') or []:
        raw = clean(item.get('raw_author_name')) or clean((item.get('author') or {}).get('display_name'))
        if raw and raw.casefold() not in seen:
            seen.add(raw.casefold())
            authors.append(family_comma(raw))
    return {
        'authors': authors,
        'journal': journal,
        'journalAbbreviation': abbrev,
        'volume': clean(biblio.get('volume')),
        'number': clean(biblio.get('issue')),
        'pages': pages,
        'issn': clean((source.get('issn') or [''])[0]) if source.get('issn') else '',
        'abstract': clean(abstract),
        'keywords': keywords[:12],
        'year': str(work.get('publication_year') or ''),
        'language': clean(work.get('language')),
    }


def meaningful(value):
    if value is None:
        return False
    if isinstance(value, list):
        return any(meaningful(item) for item in value)
    text = clean(value)
    return bool(text) and text.casefold() not in ('none', 'null', '待补', '待核', '无期号')


def blank(record, field):
    return not meaningful(record.get(field))


# 这几格都有就算齐，补字段时不再联网（检索步 lit_records.py 补过的纳入篇都是齐的；
# 从 Zotero / EndNote 导进引文库的老条目常缺摘要、ISSN、日期，同步前要补）
_COMPLETE_FIELDS = ('abstract', 'issn', 'date', 'journalAbbreviation')


def enrich_records(records):
    """按 DOI 补 Crossref 上实际有的字段（Crossref 没摘要再问 OpenAlex）。查不到的保持原记录；字段已齐的跳过。"""
    for record in records:
        doi = re.sub(r'^https?://(?:dx\.)?doi\.org/', '', clean(record.get('doi')), flags=re.I)
        if not doi:
            continue
        if all(not blank(record, field) for field in _COMPLETE_FIELDS):
            continue
        try:
            filled = crossref_fill(doi)
        except Exception:
            filled = {}
        if not filled.get('abstract') or not filled.get('journalAbbreviation'):
            try:
                extra = openalex_fill(doi)
            except Exception:
                extra = {}
            for field in ('abstract', 'journalAbbreviation', 'keywords', 'issn', 'number', 'volume', 'pages', 'journal', 'year', 'language'):
                if blank(filled, field) and not blank(extra, field):
                    filled[field] = extra[field]

            if len(filled.get('authors') or []) < 2 and len(extra.get('authors') or []) > len(filled.get('authors') or []):
                filled['authors'] = extra['authors']
        journal_name = clean(filled.get('journal') or record.get('journal'))
        try:
            iso4 = iso4_abbreviation(journal_name)
        except Exception:
            iso4 = ''
        # 查到 ISO 4 就用。查不到保留引文库里已有的缩写，不把空值写回去。
        if iso4:
            filled['journalAbbreviation'] = iso4
        if not filled:
            continue
        # 作者以出版商登记为准：原名单经常被截成前三人或同一人写两次。
        # 作者按出版商名单替换：原文件常把多人挤在一行，或把同一人写两次。
        # 其余字段只补空位，不改已有年份和标题。
        if filled.get('authors'):
            record['authors'] = filled['authors']
        for field in (
            'title', 'year', 'date', 'epubDate', 'journal', 'journalAbbreviation', 'volume', 'number',
            'pages', 'issn', 'doi', 'url', 'abstract', 'keywords', 'articleType', 'language',
        ):
            if blank(record, field) and not blank(filled, field):
                record[field] = filled[field]
        time.sleep(0.15)
    return records


def enrich_main():
    p = argparse.ArgumentParser(description='Fill a BibTeX file from Crossref by DOI. Writes a new file.')
    p.add_argument('--input', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--report', type=Path)
    p.add_argument('--skip-excluded', type=Path, dest='skip_excluded', help='papers/included.json：其中排除的篇不补也不输出')
    a = p.parse_args()
    # Windows 管道默认按系统代码页编码，补字段提示含中文与连接号
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    try:
        if a.output.exists() or a.output.is_symlink():
            raise ValueError('Output exists; choose a new path')
        records = load(a.input)
        if a.skip_excluded:
            records, dropped = drop_excluded(records, a.skip_excluded)
            if dropped:
                print(f'检索时排除的 {dropped} 篇不导。')
        before = [json.dumps(r, sort_keys=True, ensure_ascii=False) for r in records]
        enrich_records(records)
        changed = sum(1 for old, r in zip(before, records) if json.dumps(r, sort_keys=True, ensure_ascii=False) != old)
        if changed:
            print(f'按 DOI 补全了 {changed} 条缺字段的题录（摘要、ISSN、日期等；只改这次导出的副本，引文库不动）。')
        text = render(records, '.bib')
        a.output.parent.mkdir(parents=True, exist_ok=True)
        with a.output.open('x', encoding='utf-8', newline='\n') as handle:
            handle.write(text)
        return 0
    except (OSError, ValueError, ET.ParseError) as err:
        print(str(err), file=sys.stderr)
        return 1


if __name__ == '__main__':
    if '--enrich' in sys.argv:
        sys.argv.remove('--enrich')
        sys.exit(enrich_main())
    sys.exit(main())
