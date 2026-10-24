//! Zotero 进料口（只读适配器）。
//!
//! 边界（架构 §10 v3.9「否决 Zotero 式文献库」）：**不做文献管理器**。这里只把用户已有的
//! Zotero 库当成一个**进料口**——读出来、转成流水线自己的产物格式（references.bib + papers/），
//! 之后一概走既有链路。Ccode 从不写 Zotero 的库，也不同步回去。
//!
//! 为什么读 sqlite 而不是调 Zotero 的本地 API：本地 API 要 Zotero 正在运行；
//! 用户多半是关着 Zotero 在写论文。读库文件则离线可用。
//! 使用 SQLite 在线备份读取一致的内存快照；超时失败，不落明文库副本。

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// 一条可导入的 Zotero 条目（已归一为流水线需要的字段）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroItemDto {
    /// Zotero item key（8 位大写字母数字），兼作 bib 键去重依据
    pub key: String,
    pub title: String,
    /// 作者姓氏列表（按 Zotero 顺序）
    pub creators: Vec<String>,
    /// 四位年份；解析不出为 None
    pub year: Option<String>,
    pub doi: Option<String>,
    pub publication: Option<String>,
    /// 已下载的 PDF 绝对路径（多个附件取第一个可读的）；无附件为 None
    pub pdf_path: Option<String>,
    /// Zotero 条目类型（journalArticle / thesis / book …）：决定 BibTeX 的条目类型
    pub item_type: String,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    #[serde(default)]
    pub library_id: i64,
}

/// 一个 Zotero 分类
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroCollectionDto {
    pub id: i64,
    pub name: String,
    /// 该分类下的条目数（含子条目，不含附件与笔记）
    pub count: i64,
}

/// 库探测结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroLibraryDto {
    /// zotero.sqlite 绝对路径
    pub db_path: String,
    /// storage 目录（附件按 <storage>/<itemKey>/<filename> 存放）
    pub storage_dir: String,
    pub collections: Vec<ZoteroCollectionDto>,
    /// 未分类在内的全部条目数
    pub total: i64,
}

/// 默认库位置（跨平台）：Zotero 7 默认 ~/Zotero
fn default_data_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        out.push(home.join("Zotero"));
        // Windows 旧版会放在 Documents 下
        out.push(home.join("Documents").join("Zotero"));
    }
    out
}

/// 找出可用的 Zotero 数据目录（含 zotero.sqlite）
fn locate_data_dir(explicit: Option<&str>) -> Result<PathBuf, String> {
    let candidates: Vec<PathBuf> = match explicit {
        Some(p) if !p.trim().is_empty() => {
            vec![PathBuf::from(crate::sessions::expand_tilde(p))]
        }
        _ => default_data_dirs(),
    };
    for dir in candidates {
        if dir.join("zotero.sqlite").is_file() {
            return Ok(dir);
        }
    }
    Err("没找到 Zotero 数据目录（默认 ~/Zotero）。可在导入时手动指定路径".into())
}

/// SQLite 在线备份得到一致的内存快照。只读源连接；忙/锁超时即失败，绝不退回裸复制。
fn open_snapshot(db_path: &Path) -> Result<Connection, String> {
    let source = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("只读打开 Zotero 库失败: {e}"))?;
    source
        .busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let mut snapshot = Connection::open_in_memory().map_err(|e| e.to_string())?;
    {
        let backup = rusqlite::backup::Backup::new(&source, &mut snapshot)
            .map_err(|e| format!("建立 Zotero 一致快照失败: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(30);
        // 「库大读得慢」（More，有进展）与「被占用锁死」（Busy，毫无进展）分开计时：
        // Zotero 开着时前者也要 30 秒，后者 5 秒就该放弃并说清怎么退出，不让用户白等
        let mut busy_since = Instant::now();
        loop {
            match backup
                .step(1024)
                .map_err(|e| format!("读取 Zotero 快照失败: {e}"))?
            {
                rusqlite::backup::StepResult::Done => break,
                rusqlite::backup::StepResult::More => {
                    busy_since = Instant::now();
                    if Instant::now() >= deadline {
                        return Err(
                            "Zotero 库较大，未在时限内读完。请完全退出 Zotero 后重试。".into()
                        );
                    }
                }
                _ => {
                    if Instant::now() >= busy_since + Duration::from_secs(5) {
                        return Err(
                            "Zotero 正在写入库（开着或正在同步），快照取不下来。请完全退出 Zotero 后再导入——macOS 点窗口红色 ✕ 只是关窗口，要用 ⌘Q 或 Dock 图标右键退出；Windows 退出后留意托盘里不再有 Zotero。".into(),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    snapshot
        .execute_batch("PRAGMA query_only = ON;")
        .map_err(|e| e.to_string())?;
    Ok(snapshot)
}

pub fn inspect_library(explicit_dir: Option<&str>) -> Result<ZoteroLibraryDto, String> {
    let dir = locate_data_dir(explicit_dir)?;
    let db_path = dir.join("zotero.sqlite");
    let conn = open_snapshot(&db_path)?;
    let result = (|| -> Result<ZoteroLibraryDto, String> {
        let mut stmt = conn
            .prepare(
                "SELECT c.collectionID, c.collectionName, \
                 (SELECT COUNT(*) FROM collectionItems ci \
                  JOIN items i ON i.itemID = ci.itemID \
                  JOIN itemTypes it ON it.itemTypeID = i.itemTypeID \
                  WHERE ci.collectionID = c.collectionID \
                    AND it.typeName NOT IN ('attachment','note') \
                    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)) \
                 FROM collections c ORDER BY c.collectionName",
            )
            .map_err(|e| format!("读取分类失败: {e}"))?;
        let collections = stmt
            .query_map([], |row| {
                Ok(ZoteroCollectionDto {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    count: row.get(2)?,
                })
            })
            .map_err(|e| format!("读取分类失败: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM items i JOIN itemTypes it ON it.itemTypeID = i.itemTypeID \
                 WHERE it.typeName NOT IN ('attachment','note') \
                   AND i.itemID NOT IN (SELECT itemID FROM deletedItems)",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        Ok(ZoteroLibraryDto {
            db_path: db_path.to_string_lossy().into_owned(),
            storage_dir: dir.join("storage").to_string_lossy().into_owned(),
            collections,
            total,
        })
    })();
    drop(conn);
    result
}

/// 从 Zotero 的 date 字段里抠四位年份。
/// 该字段是自由文本 + Zotero 自己的多段格式（如 "2025-12-00 12/2025"、"2024-00-00 2024"），
/// 不能当 ISO 日期解析，只取第一个四位数字。
fn extract_year(raw: &str) -> Option<String> {
    let bytes: Vec<char> = raw.chars().collect();
    for w in bytes.windows(4) {
        if w.iter().all(|c| c.is_ascii_digit()) {
            let y: String = w.iter().collect();
            // 合理年份区间，避免抓到卷号/页码
            if (1500..=2200).contains(&y.parse::<i32>().unwrap_or(0)) {
                return Some(y);
            }
        }
    }
    None
}

/// 读取条目（collection_id = None 表示整库）
pub fn read_items(
    explicit_dir: Option<&str>,
    collection_id: Option<i64>,
) -> Result<Vec<ZoteroItemDto>, String> {
    read_items_with_base(explicit_dir, collection_id, None)
}

fn read_items_with_base(
    explicit_dir: Option<&str>,
    collection_id: Option<i64>,
    linked_base: Option<&Path>,
) -> Result<Vec<ZoteroItemDto>, String> {
    let dir = locate_data_dir(explicit_dir)?;
    let conn = open_snapshot(&dir.join("zotero.sqlite"))?;
    let storage = dir.join("storage");
    let result = (|| -> Result<Vec<ZoteroItemDto>, String> {
        let base = "SELECT i.itemID, i.key, it.typeName, \
             MAX(CASE WHEN f.fieldName='title' THEN idv.value END), \
             MAX(CASE WHEN f.fieldName='date' THEN idv.value END), \
             MAX(CASE WHEN f.fieldName='DOI' THEN idv.value END), \
             MAX(CASE WHEN f.fieldName='publicationTitle' THEN idv.value END), i.libraryID \
             FROM items i \
             JOIN itemTypes it ON it.itemTypeID = i.itemTypeID \
             LEFT JOIN itemData id ON id.itemID = i.itemID \
             LEFT JOIN itemDataValues idv ON idv.valueID = id.valueID \
             LEFT JOIN fields f ON f.fieldID = id.fieldID \
             WHERE it.typeName NOT IN ('attachment','note') \
               AND i.itemID NOT IN (SELECT itemID FROM deletedItems)";
        let sql = match collection_id {
            Some(_) => format!(
                "{base} AND i.itemID IN (SELECT itemID FROM collectionItems WHERE collectionID = ?1) \
                 GROUP BY i.itemID"
            ),
            None => format!("{base} GROUP BY i.itemID"),
        };
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("读取条目失败: {e}"))?;
        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<(i64, ZoteroItemDto)> {
            let item_id: i64 = row.get(0)?;
            let date: Option<String> = row.get(4)?;
            Ok((
                item_id,
                ZoteroItemDto {
                    key: row.get(1)?,
                    item_type: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    title: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    creators: Vec::new(),
                    year: date.as_deref().and_then(extract_year),
                    doi: row.get(5)?,
                    publication: row.get(6)?,
                    pdf_path: None,
                    fields: BTreeMap::new(),
                    library_id: row.get(7)?,
                },
            ))
        };
        let rows: Vec<(i64, ZoteroItemDto)> = match collection_id {
            Some(cid) => stmt
                .query_map([cid], map_row)
                .map_err(|e| format!("读取条目失败: {e}"))?
                .collect::<Result<_, _>>()
                .map_err(|e| format!("读取条目失败: {e}"))?,
            None => stmt
                .query_map([], map_row)
                .map_err(|e| format!("读取条目失败: {e}"))?
                .collect::<Result<_, _>>()
                .map_err(|e| format!("读取条目失败: {e}"))?,
        };

        let mut out = Vec::with_capacity(rows.len());
        for (item_id, mut item) in rows {
            item.creators = read_creators(&conn, item_id);
            let mut fields = conn.prepare("SELECT f.fieldName, v.value FROM itemData d JOIN fields f ON f.fieldID=d.fieldID JOIN itemDataValues v ON v.valueID=d.valueID WHERE d.itemID=?1")
                .map_err(|e| e.to_string())?;
            item.fields = fields
                .query_map([item_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            item.pdf_path = find_pdf(&conn, &storage, item_id, linked_base);
            if !item.title.trim().is_empty() {
                out.push(item);
            }
        }
        out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        Ok(out)
    })();
    drop(conn);
    result
}

fn read_creators(conn: &Connection, item_id: i64) -> Vec<String> {
    let mut stmt = match conn.prepare(
        "SELECT cr.lastName, cr.firstName FROM itemCreators ic \
         JOIN creators cr ON cr.creatorID = ic.creatorID \
         WHERE ic.itemID = ?1 ORDER BY ic.orderIndex",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map([item_id], |row| {
        let last: String = row.get::<_, Option<String>>(0)?.unwrap_or_default();
        let first: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
        Ok(if first.trim().is_empty() {
            last
        } else {
            format!("{last}, {first}")
        })
    })
    .map(|rows| {
        rows.filter_map(|r| r.ok())
            .filter(|s| !s.trim().is_empty())
            .collect()
    })
    .unwrap_or_default()
}

/// 附件是补充材料（SI / ESI）而不是正文：附件标题、下载地址、文件名、Zotero 全文索引开头任一处说是就算。
/// 一个条目常挂正文 + SI 两份 PDF，库里谁先谁后不定（2026-10-23 HER 实证：Fan2022 正文、SI 都在，拿成了 26 页 SI）。
fn is_supplement(title: &str, url: &str, file_name: &str, text_head: &str) -> bool {
    let meta = format!("{title} {file_name}").to_lowercase();
    let url = url.to_lowercase();
    // 全文索引只看第一行开头（SI 文件以「Electronic Supplementary Material (ESI) for…」「1 Supporting Information」起头）：
    // 正文首页脚注里也常有「Electronic supplementary information (ESI) available」，不能整页搜
    let head: String = text_head
        .trim_start_matches(|c: char| !c.is_alphabetic())
        .chars()
        .take(60)
        .collect::<String>()
        .to_lowercase();
    ["supplementary", "supporting information", "supplemental"]
        .iter()
        .any(|m| meta.contains(m))
        || ["suppdata", "/suppl", "supplementary", "supporting-information"]
            .iter()
            .any(|m| url.contains(m))
        || [
            "supplementary material",
            "supplementary information",
            "supporting information",
            "electronic supplementary",
            "supplementary data",
        ]
        .iter()
        .any(|m| head.contains(m))
}

/// 文件是完整的 PDF：开头有 %PDF、结尾有 %%EOF。没下完的（浏览器中断、镜像站截断）读出来只剩一两页
fn pdf_complete(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut head = [0u8; 1024];
    let n = file.read(&mut head).unwrap_or(0);
    if !head[..n].windows(4).any(|w| w == b"%PDF") {
        return false;
    }
    let tail_len = len.min(2048);
    if file.seek(SeekFrom::Start(len - tail_len)).is_err() {
        return false;
    }
    let mut tail = Vec::with_capacity(tail_len as usize);
    file.read_to_end(&mut tail).is_ok() && tail.windows(5).any(|w| w == b"%%EOF")
}

/// 找该条目已下载的正文 PDF。附件 path 有三种形态：
/// - `storage:<文件名>`（导入的副本）→ 实际落在 <storage>/<附件key>/<文件名>
/// - 绝对路径（linkMode=2 链接文件，ZotFile 等常见）→ 直接用
/// - `attachments:<相对路径>`：只在用户明确选择链接附件基目录后解析；拒绝越界。
///
/// 补充材料和没下完的文件不算全文：只剩这些时返回 None，交给待获取补正文（不然 Agent 拿 SI 当正文读）。
fn find_pdf(
    conn: &Connection,
    storage: &Path,
    item_id: i64,
    linked_base: Option<&Path>,
) -> Option<String> {
    let mut stmt = conn
        .prepare(
            "SELECT ai.key, a.path, \
               (SELECT v.value FROM itemData d JOIN fields f ON f.fieldID = d.fieldID \
                  JOIN itemDataValues v ON v.valueID = d.valueID \
                  WHERE d.itemID = a.itemID AND f.fieldName = 'title'), \
               (SELECT v.value FROM itemData d JOIN fields f ON f.fieldID = d.fieldID \
                  JOIN itemDataValues v ON v.valueID = d.valueID \
                  WHERE d.itemID = a.itemID AND f.fieldName = 'url') \
             FROM itemAttachments a \
             JOIN items ai ON ai.itemID = a.itemID \
             WHERE a.parentItemID = ?1 AND a.contentType = 'application/pdf' \
               AND a.itemID NOT IN (SELECT itemID FROM deletedItems) \
             ORDER BY ai.dateAdded, a.itemID",
        )
        .ok()?;
    let rows = stmt
        .query_map([item_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            ))
        })
        .ok()?;
    for (key, path, title, url) in rows.filter_map(|r| r.ok()) {
        if path.is_empty() {
            continue;
        }
        let candidate = if let Some(relative) = path.strip_prefix("attachments:") {
            let Some(base) = linked_base else {
                continue;
            };
            if Path::new(relative).is_absolute()
                || relative.replace('\\', "/").split('/').any(|p| p == "..")
            {
                continue;
            }
            let Ok(base) = crate::paths::canonicalize_plain(base) else {
                continue;
            };
            let Ok(candidate) = crate::paths::canonicalize_plain(&base.join(relative)) else {
                continue;
            };
            if !crate::paths::path_within_path(&candidate, &base) {
                continue;
            }
            candidate
        } else {
            match path.strip_prefix("storage:") {
                Some(name) if !name.is_empty() => storage.join(&key).join(name),
                Some(_) => continue,
                // 链接文件：库里存的就是绝对路径
                None => PathBuf::from(&path),
            }
        };
        if !candidate.is_file() {
            continue;
        }
        // Zotero 的全文索引（.zotero-ft-cache）在附件自己的 storage 目录里，链接文件也是
        let text_head = fs::File::open(storage.join(&key).join(".zotero-ft-cache"))
            .ok()
            .and_then(|f| {
                use std::io::Read;
                let mut buf = Vec::new();
                f.take(1024).read_to_end(&mut buf).ok()?;
                Some(String::from_utf8_lossy(&buf).into_owned())
            })
            .unwrap_or_default();
        let file_name = candidate
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if is_supplement(&title, &url, &file_name, &text_head) || !pdf_complete(&candidate) {
            continue;
        }
        return Some(candidate.to_string_lossy().into_owned());
    }
    None
}

/// Zotero 条目类型 → BibTeX 条目类型。全按 @article 会把学位论文/书籍标错，
/// 投稿时参考文献格式直接出错。未知类型回落 misc（诚实的「不知道」，不冒充期刊论文）
fn bib_entry_type(item_type: &str) -> &'static str {
    match item_type {
        "journalArticle" | "magazineArticle" | "newspaperArticle" => "article",
        "book" => "book",
        "bookSection" => "incollection",
        "conferencePaper" => "inproceedings",
        "thesis" => "phdthesis",
        "report" | "manuscript" | "preprint" => "techreport",
        "webpage" | "blogPost" => "online",
        "patent" => "patent",
        _ => "misc",
    }
}

/// 导出键采用稳定 Zotero 身份；主引用库已有键只由人工对账保留。
/// 去掉题名前人手加的编号（【77】、[12]、19~.），只用于显示（项目资源名、任务书），引文库照原样。
/// 与导出脚本 bridge.py `strip_title_prefix` 同一口径。
fn strip_title_prefix(title: &str) -> &str {
    let s = title.trim_start();
    let digits_then = |rest: &str| -> Option<usize> {
        let rest_trim = rest.trim_start();
        let lead = rest.len() - rest_trim.len();
        let n = rest_trim.bytes().take_while(u8::is_ascii_digit).count();
        (n > 0).then_some(lead + n)
    };
    let after = if let Some(rest) = s.strip_prefix('【') {
        digits_then(rest).and_then(|n| rest[n..].trim_start().strip_prefix('】'))
    } else if let Some(rest) = s.strip_prefix('[') {
        digits_then(rest).and_then(|n| rest[n..].trim_start().strip_prefix(']'))
    } else {
        digits_then(s).and_then(|n| {
            let r = s[n..].trim_start().strip_prefix('~')?.trim_start();
            Some(r.strip_prefix('.').unwrap_or(r))
        })
    };
    match after.map(str::trim_start) {
        Some(rest) if !rest.is_empty() => rest,
        _ => title,
    }
}

fn bib_key(item: &ZoteroItemDto) -> String {
    // Zotero library + item key 是稳定身份，不随标题修订、排序或同姓条目增减漂移。
    format!("zotero{}{}", item.library_id, item.key.to_ascii_lowercase())
}

/// 生成 BibTeX 全文。缺字段一律标「待补」而不是编造——与 lit-notes 技能同一口径。
fn bib_escape(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\textbackslash{}"),
            '&' | '%' | '_' | '#' | '{' | '}' | '$' => {
                out.push('\\');
                out.push(ch);
            }
            '\r' | '\n' => out.push(' '),
            _ => out.push(ch),
        }
    }
    out
}

pub fn render_bibtex(items: &[ZoteroItemDto]) -> String {
    let mut used: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut out = String::from("% 由 Mesa 从 Zotero 导入生成；缺失字段标「待补」，未编造\n\n");
    for item in items {
        let base = bib_key(item);
        let n = used.entry(base.clone()).or_insert(0);
        *n += 1;
        let key = if *n == 1 {
            base
        } else {
            format!("{base}-{}", *n)
        };
        out.push_str(&format!("@{}{{{key},\n", bib_entry_type(&item.item_type)));
        out.push_str(&format!("  title = {{{}}},\n", bib_escape(&item.title)));
        let authors = if item.creators.is_empty() {
            "待补".to_string()
        } else {
            item.creators
                .iter()
                .map(|c| bib_escape(c))
                .collect::<Vec<_>>()
                .join(" and ")
        };
        out.push_str(&format!("  author = {{{authors}}},\n"));
        out.push_str(&format!(
            "  year = {{{}}},\n",
            item.year.clone().unwrap_or_else(|| "待补".into())
        ));
        // journal 只对期刊类有意义：学位论文/书籍写个「待补 journal」是噪音
        if bib_entry_type(&item.item_type) == "article" {
            out.push_str(&format!(
                "  journal = {{{}}},\n",
                bib_escape(item.publication.as_deref().unwrap_or("待补"))
            ));
        } else if !item.fields.contains_key("bookTitle")
            && !item.fields.contains_key("conferenceName")
        {
            if let Some(p) = &item.publication {
                if !p.trim().is_empty() {
                    out.push_str(&format!("  booktitle = {{{}}},\n", bib_escape(p)));
                }
            }
        }
        if let Some(doi) = &item.doi {
            if !doi.trim().is_empty() {
                out.push_str(&format!("  doi = {{{}}},\n", bib_escape(doi)));
            }
        }
        for (source, target) in [
            ("volume", "volume"),
            ("issue", "number"),
            ("pages", "pages"),
            ("url", "url"),
            ("ISBN", "isbn"),
            ("publisher", "publisher"),
            ("university", "school"),
            ("bookTitle", "booktitle"),
            ("conferenceName", "booktitle"),
        ] {
            if let Some(value) = item.fields.get(source).filter(|s| !s.trim().is_empty()) {
                out.push_str(&format!("  {target} = {{{}}},\n", bib_escape(value)));
            }
        }
        out.push_str("}\n\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Zotero 6 导不进 RIS / BibTeX：按 application.ini 的版本号先拦下
    #[test]
    fn zotero_six_is_too_old() {
        let ini = "[App]\r\nVendor=Zotero\r\nName=Zotero\r\nVersion=6.0.36\r\nBuildID=20240313202508\r\n\r\n[Gecko]\r\nMinVersion=60.0\r\n";
        assert_eq!(ini_version(ini).as_deref(), Some("6.0.36"));
        assert!(zotero_too_old("6.0.36"));
        assert!(!zotero_too_old("7.0.11"));
        assert!(!zotero_too_old("8.0"));
        assert!(!zotero_too_old("unknown"), "认不出版本不拦");
        assert!(zotero_too_old_message("6.0.36", "papers/zotero-library.ris").contains("Zotero 7"));
    }

    /// 交给 Zotero 的 file URL 全是 ASCII：中文目录、空格都编码，盘符冒号与分隔符留着
    #[test]
    fn file_url_is_ascii_with_drive_kept() {
        assert_eq!(
            file_url(Path::new(r"D:\HER综述\HER\papers\zotero-library.ris")),
            "file:///D:/HER%E7%BB%BC%E8%BF%B0/HER/papers/zotero-library.ris"
        );
        assert_eq!(
            file_url(Path::new("/Users/me/My Papers/a.ris")),
            "file:///Users/me/My%20Papers/a.ris"
        );
    }

    #[test]
    fn ris_parser_builds_doi_map_with_full_metadata() {
        let ris = "TY  - JOUR\r\nAU  - Wang, Lei\r\nAU  - Chen, Xiaoming\r\nPY  - 2023-05-01\r\nTI  - Deep Learning for Materials\r\nT2  - Advanced Materials\r\nDO  - 10.1002/adma.202304268\r\nER  - \r\n\r\nTY  - JOUR\r\nAU  - 单作者无逗号\r\nPY  - 2024\r\nDO  - 10.1109/ICRA.1.\r\nER  - \r\n";
        let map = parse_ris_by_doi(ris);
        assert_eq!(map.len(), 2);
        let r1 = &map["10.1002/adma.202304268"];
        assert_eq!(r1.authors, vec!["Wang, Lei", "Chen, Xiaoming"]);
        assert_eq!(r1.year.as_deref(), Some("2023"));
        assert_eq!(r1.publication.as_deref(), Some("Advanced Materials"));
        // DOI 尾部句点被归一剥掉；裸名作者保留
        let r2 = &map["10.1109/icra.1"];
        assert_eq!(r2.authors, vec!["单作者无逗号"]);
        assert!(r2.publication.is_none());
        // creators JSON：逗号名拆 first/last，裸名走 name
        let c = ris_creators_json(&r1.authors);
        assert_eq!(c[0]["lastName"], "Wang");
        assert_eq!(c[0]["firstName"], "Lei");
        let c2 = ris_creators_json(&r2.authors);
        assert_eq!(c2[0]["name"], "单作者无逗号");
        // 无 DO 的记录丢弃
        assert!(parse_ris_by_doi("TY  - JOUR\nTI  - no doi\nER  - \n").is_empty());
    }

    #[test]
    fn doi_norm_strips_prefixes_and_punctuation() {
        assert_eq!(doi_norm("10.1002/adma.202304268"), "10.1002/adma.202304268");
        assert_eq!(doi_norm("doi: 10.1038/x."), "10.1038/x");
        assert_eq!(
            doi_norm("https://doi.org/10.1016/j.nano.1,"),
            "10.1016/j.nano.1"
        );
        assert!(is_doish("10.1002/adma.202304268"));
        assert!(!is_doish("https://example.com/article"));
        assert!(!is_doish("10.x/y"));
    }

    #[test]
    fn zotero_write_error_maps_readonly_plaintext() {
        assert!(zotero_local_write_unsupported(
            "Endpoint does not support method"
        ));
        assert!(zotero_local_write_unsupported(
            "Write access is not yet supported."
        ));
        assert!(!zotero_local_write_unsupported(r#"{"failed":{}}"#));
        let msg = zotero_write_error_message(400, "Endpoint does not support method");
        assert!(msg.contains("只读"), "{msg}");
        assert!(msg.contains("拖"), "{msg}");
        let other = zotero_write_error_message(500, "internal boom");
        assert!(other.contains("HTTP 500"), "{other}");
        assert!(other.contains("internal boom"), "{other}");
        let empty = zotero_write_error_message(201, "  ");
        assert!(empty.contains("空响应"), "{empty}");
    }

    #[test]
    fn parse_bbt_xpi_download_url_picks_versioned_asset() {
        let body = r#"{
          "tag_name":"v9.0.64",
          "assets":[
            {"name":"notes.md","browser_download_url":"https://github.com/retorquere/zotero-better-bibtex/releases/download/v9.0.64/notes.md"},
            {"name":"zotero-better-bibtex-9.0.64.xpi","browser_download_url":"https://github.com/retorquere/zotero-better-bibtex/releases/download/v9.0.64/zotero-better-bibtex-9.0.64.xpi"}
          ]
        }"#;
        assert_eq!(
            parse_bbt_xpi_download_url(body).unwrap(),
            "https://github.com/retorquere/zotero-better-bibtex/releases/download/v9.0.64/zotero-better-bibtex-9.0.64.xpi"
        );
        assert!(parse_bbt_xpi_download_url(r#"{"assets":[]}"#).is_err());
        assert!(parse_bbt_xpi_download_url(
            r#"{"assets":[{"name":"zotero-better-bibtex.xpi","browser_download_url":"https://evil.example/x.xpi"}]}"#
        )
        .is_err());
    }

    #[test]
    fn zotero_native_import_ext_allows_ris_bib_json() {
        assert!(zotero_native_import_ext("ris"));
        assert!(zotero_native_import_ext("bib"));
        assert!(zotero_native_import_ext("json"));
        assert!(!zotero_native_import_ext("pdf"));
        assert!(!zotero_native_import_ext("xpi"));
    }

    #[test]
    fn parse_profiles_ini_picks_default_relative_path() {
        let ini = "[Profile0]\nName=old\nIsRelative=1\nPath=Profiles/aaaa.default\n\n[Profile1]\nName=default\nIsRelative=1\nPath=Profiles/bbbb.default\nDefault=1\n";
        let dir = PathBuf::from("/tmp/Zotero");
        let got = parse_profiles_ini(ini, &dir).unwrap();
        assert_eq!(got, dir.join("Profiles/bbbb.default"));
    }

    #[test]
    fn parse_profiles_ini_absolute_path() {
        let ini = "[Profile0]\nIsRelative=0\nPath=/opt/zotero-profile\nDefault=1\n";
        let got = parse_profiles_ini(ini, Path::new("/unused")).unwrap();
        assert_eq!(got, PathBuf::from("/opt/zotero-profile"));
    }

    #[test]
    fn bbt_id_from_manifest_accepts_official_only() {
        let ok = r#"{"applications":{"zotero":{"id":"better-bibtex@iris-advies.com"}}}"#;
        assert_eq!(bbt_id_from_manifest(ok).unwrap(), BBT_ADDON_ID);
        let gecko =
            r#"{"browser_specific_settings":{"gecko":{"id":"better-bibtex@iris-advies.com"}}}"#;
        assert_eq!(bbt_id_from_manifest(gecko).unwrap(), BBT_ADDON_ID);
        assert!(
            bbt_id_from_manifest(r#"{"applications":{"zotero":{"id":"evil@example.com"}}}"#)
                .is_err()
        );
        assert!(bbt_id_from_manifest("not json").is_err());
    }

    fn item(title: &str, creators: &[&str], year: Option<&str>) -> ZoteroItemDto {
        ZoteroItemDto {
            key: "ABCD1234".into(),
            fields: BTreeMap::new(),
            library_id: 1,
            title: title.into(),
            creators: creators.iter().map(|s| (*s).to_string()).collect(),
            year: year.map(|s| s.to_string()),
            doi: None,
            publication: None,
            pdf_path: None,
            item_type: "journalArticle".into(),
        }
    }

    #[test]
    fn extract_year_handles_zotero_date_formats() {
        // Zotero 的 date 是自由文本 + 多段格式，不能当 ISO 解析
        assert_eq!(extract_year("2025-12-00 12/2025").as_deref(), Some("2025"));
        assert_eq!(extract_year("2024-00-00 2024").as_deref(), Some("2024"));
        assert_eq!(
            extract_year("2026-05-05 2026-05-05").as_deref(),
            Some("2026")
        );
        assert_eq!(extract_year("in press").as_deref(), None);
        // 不该把卷号/页码当年份
        assert_eq!(extract_year("vol. 12, pp. 3345").as_deref(), None);
    }

    #[test]
    fn bib_key_is_stable_and_ascii() {
        let i = item(
            "Transition Metal Borides for HER",
            &["Hong, Tongzhou"],
            Some("2025"),
        );
        assert_eq!(bib_key(&i), "zotero1abcd1234");
        // 无作者/无年份也要出得来键，不 panic
        let bare = item("某中文标题", &[], None);
        assert!(!bib_key(&bare).is_empty());
    }

    #[test]
    fn render_bibtex_dedupes_keys_and_marks_missing() {
        let items = vec![
            item("Alpha Study", &["Li, Wei"], Some("2024")),
            item("Alpha Study", &["Li, Wei"], Some("2024")),
            item("无作者的条目", &[], None),
        ];
        let bib = render_bibtex(&items);
        assert!(bib.contains("@article{zotero1abcd1234,"), "{bib}");
        // 同键第二条加后缀，不产生重复键
        assert!(bib.contains("@article{zotero1abcd1234-2,"), "{bib}");
        // 缺字段标「待补」，不编造
        assert!(bib.contains("author = {待补}"), "{bib}");
        assert!(bib.contains("year = {待补}"), "{bib}");
        assert!(!bib.contains("doi = {}"), "空 DOI 不该写出来: {bib}");
    }

    #[test]
    fn bib_entry_type_maps_beyond_articles() {
        // 全按 @article 会把学位论文/书籍标错，投稿时参考文献格式直接出错
        assert_eq!(bib_entry_type("journalArticle"), "article");
        assert_eq!(bib_entry_type("thesis"), "phdthesis");
        assert_eq!(bib_entry_type("book"), "book");
        assert_eq!(bib_entry_type("conferencePaper"), "inproceedings");
        assert_eq!(bib_entry_type("preprint"), "techreport");
        // 未知类型回落 misc，不冒充期刊论文
        assert_eq!(bib_entry_type("podcast"), "misc");
        assert_eq!(bib_entry_type(""), "misc");
    }

    #[test]
    fn render_bibtex_respects_item_type() {
        let mut thesis = item("某某方向研究", &["Hong, T"], Some("2026"));
        thesis.item_type = "thesis".into();
        thesis.publication = Some("某大学".into());
        let bib = render_bibtex(&[thesis]);
        assert!(bib.contains("@phdthesis{"), "{bib}");
        // 非期刊类不写 journal 字段（写个「待补 journal」是噪音）
        assert!(!bib.contains("journal ="), "{bib}");
        assert!(bib.contains("booktitle = {某大学}"), "{bib}");
    }

    #[test]
    fn locate_data_dir_rejects_missing() {
        assert!(locate_data_dir(Some("/definitely/not/here")).is_err());
    }

    #[test]
    fn online_snapshot_is_consistent_and_query_only() {
        let root =
            std::env::temp_dir().join(format!("mesa-zotero-snapshot-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("zotero.sqlite");
        let mut source = Connection::open(&path).unwrap();
        source.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE example(value TEXT); INSERT INTO example VALUES ('committed');").unwrap();
        let tx = source.transaction().unwrap();
        tx.execute("UPDATE example SET value='uncommitted'", [])
            .unwrap();
        let snapshot = open_snapshot(&path).unwrap();
        assert_eq!(
            snapshot
                .query_row("SELECT value FROM example", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "committed"
        );
        assert!(snapshot.execute("DELETE FROM example", []).is_err());
        tx.rollback().unwrap();
        drop(snapshot);
        drop(source);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn strip_title_prefix_drops_hand_numbering_only() {
        assert_eq!(strip_title_prefix("【20】Integrating trace ruthenium"), "Integrating trace ruthenium");
        assert_eq!(strip_title_prefix(" [12] MoS2 edges"), "MoS2 edges");
        assert_eq!(strip_title_prefix("19~.Construction of efficient"), "Construction of efficient");
        assert_eq!(strip_title_prefix("51~ Boron-based"), "Boron-based");
        // 不是人手编号的不动
        assert_eq!(strip_title_prefix("2D materials for HER"), "2D materials for HER");
        assert_eq!(strip_title_prefix("3D well-ordered wood"), "3D well-ordered wood");
        assert_eq!(strip_title_prefix("【20】"), "【20】");
    }

    #[test]
    fn find_pdf_prefers_main_text_over_supplement_and_truncated() {
        let root = std::env::temp_dir().join(format!("mesa-zotero-pdf-{}", uuid::Uuid::new_v4()));
        let storage = root.join("storage");
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE items(itemID INTEGER PRIMARY KEY, key TEXT, dateAdded TEXT);
             CREATE TABLE itemAttachments(itemID INTEGER, parentItemID INTEGER, contentType TEXT, path TEXT);
             CREATE TABLE deletedItems(itemID INTEGER);
             CREATE TABLE fields(fieldID INTEGER, fieldName TEXT);
             CREATE TABLE itemDataValues(valueID INTEGER, value TEXT);
             CREATE TABLE itemData(itemID INTEGER, fieldID INTEGER, valueID INTEGER);
             INSERT INTO fields VALUES (1, 'title'), (2, 'url');",
        )
        .unwrap();
        let full = b"%PDF-1.6\n1 0 obj\nendobj\ntrailer\nstartxref\n9\n%%EOF\n".to_vec();
        // (附件 key, 加入时间, 文件内容, 附件标题, 下载地址, 全文索引开头)
        let attach = |parent: i64, id: i64, key: &str, added: &str, body: &[u8], title: &str, url: &str, ft: &str| {
            fs::create_dir_all(storage.join(key)).unwrap();
            fs::write(storage.join(key).join("paper.pdf"), body).unwrap();
            if !ft.is_empty() {
                fs::write(storage.join(key).join(".zotero-ft-cache"), ft).unwrap();
            }
            conn.execute("INSERT INTO items VALUES (?1, ?2, ?3)", rusqlite::params![id, key, added]).unwrap();
            conn.execute(
                "INSERT INTO itemAttachments VALUES (?1, ?2, 'application/pdf', 'storage:paper.pdf')",
                rusqlite::params![id, parent],
            )
            .unwrap();
            for (field, value) in [(1, title), (2, url)] {
                let vid = id * 10 + field;
                conn.execute("INSERT INTO itemDataValues VALUES (?1, ?2)", rusqlite::params![vid, value]).unwrap();
                conn.execute("INSERT INTO itemData VALUES (?1, ?2, ?3)", rusqlite::params![id, field, vid]).unwrap();
            }
        };
        // 条目 1：先加的是 SI（地址带 suppdata、全文开头 ESI），后加的才是正文
        attach(1, 11, "SIFIRST1", "2023-06-16", &full, "Fan et al_2022.pdf", "https://www.rsc.org/suppdata/d1/ta/x1.pdf", "Electronic Supplementary Material (ESI) for Journal of Materials Chemistry A");
        attach(1, 12, "MAINTEXT", "2023-07-06", &full, "Construction.pdf", "", "Journal of Materials Chemistry A Published on 10 December 2021. Electronic supplementary information (ESI) available");
        // 条目 2：正文没下完（无 %%EOF），另一份是 SI——都不算全文
        attach(2, 21, "TRUNCATE", "2023-09-18", b"%PDF-1.6\n9 0 obj<</Subtype/Link>>", "Bak et al_2011.pdf", "", "");
        attach(2, 22, "BAKSUPPL", "2023-09-18", &full, "Supplementary Information PDF", "", "");
        let got = find_pdf(&conn, &storage, 1, None).unwrap();
        assert!(Path::new(&got).starts_with(storage.join("MAINTEXT")), "{got}");
        assert_eq!(find_pdf(&conn, &storage, 2, None), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imports_keep_resources_and_every_candidate_without_overwriting_main_bib() {
        let root =
            std::env::temp_dir().join(format!("mesa-zotero-import-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".ccode")).unwrap();
        fs::write(
            root.join(".ccode/project.toml"),
            "settings = [\"保留原始数据\"]\n",
        )
        .unwrap();
        let pdf = root.join("paper.pdf");
        fs::write(&pdf, "PDF fixture").unwrap();
        let mut paper = item("Example", &["Doe, Jane"], Some("2026"));
        paper.pdf_path = Some(pdf.to_string_lossy().into_owned());
        let first = import_items_at(&root, &[paper.clone()]).unwrap();
        assert_eq!(first.config.lit_source, "zotero");
        assert_eq!(first.pdf_count, 1);
        assert_eq!(
            first
                .config
                .resources
                .iter()
                .filter(|r| r.kind == "paper")
                .count(),
            1
        );
        let original = fs::read(root.join("references.bib")).unwrap();
        let second = import_items_at(&root, &[paper.clone()]).unwrap();
        let third = import_items_at(&root, &[paper]).unwrap();
        assert_ne!(second.bib_rel, third.bib_rel);
        assert!(root.join(&second.bib_rel).is_file());
        assert_eq!(fs::read(root.join("references.bib")).unwrap(), original);
        assert_eq!(
            third
                .config
                .resources
                .iter()
                .filter(|r| r.kind == "paper")
                .count(),
            1
        );
        assert!(third
            .config
            .resources
            .iter()
            .any(|r| r.path == second.bib_rel && r.kind == "reference"));
        assert!(third.config.settings.contains(&"保留原始数据".into()));
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(third.manifest_rel)).unwrap()).unwrap();
        assert_eq!(manifest[0]["id"], "1:ABCD1234");
        assert_eq!(manifest[0]["bibKey"], "zotero1abcd1234");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn title_changes_do_not_change_keys_and_export_preserves_metadata() {
        let mut paper = item("A & B_{test}", &["Doe, Jane"], Some("2026"));
        paper.fields.insert("volume".into(), "12".into());
        paper.fields.insert("pages".into(), "1--4".into());
        let key = bib_key(&paper);
        paper.title = "Corrected title".into();
        assert_eq!(bib_key(&paper), key);
        assert!(render_bibtex(&[paper]).contains("volume = {12}"));
        assert_eq!(bib_escape("A&B_{x}"), "A\\&B\\_\\{x\\}");
    }

    /// 实机验证（默认不跑：依赖本机真实 Zotero 库，CI 与他人机器上没有）。
    /// 手动跑：cargo test zotero -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_library_end_to_end() {
        let lib = match inspect_library(None) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("跳过：{e}");
                return;
            }
        };
        eprintln!("库：{} 条，分类 {} 个", lib.total, lib.collections.len());
        for c in &lib.collections {
            eprintln!("  [{}] {} — {} 条", c.id, c.name, c.count);
        }
        let items = read_items(None, lib.collections.first().map(|c| c.id)).unwrap();
        eprintln!("首个分类读出 {} 条", items.len());
        let with_pdf = items.iter().filter(|i| i.pdf_path.is_some()).count();
        let with_doi = items.iter().filter(|i| i.doi.is_some()).count();
        let with_year = items.iter().filter(|i| i.year.is_some()).count();
        eprintln!("  有 PDF {with_pdf} / 有 DOI {with_doi} / 有年份 {with_year}");
        for i in items.iter().take(3) {
            eprintln!(
                "  · {} | {} | {} | pdf={}",
                i.year.clone().unwrap_or_else(|| "?".into()),
                i.creators.first().cloned().unwrap_or_else(|| "?".into()),
                i.title.chars().take(50).collect::<String>(),
                i.pdf_path.is_some()
            );
        }
        let bib = render_bibtex(&items);
        eprintln!(
            "--- bib 前 400 字 ---\n{}",
            bib.chars().take(400).collect::<String>()
        );
        // 硬断言：键唯一（重复键会让 bib-check 全线误报）
        let keys: Vec<&str> = bib
            .lines()
            .filter_map(|l| l.strip_prefix("@article{"))
            .filter_map(|l| l.strip_suffix(','))
            .collect();
        let uniq: std::collections::HashSet<&&str> = keys.iter().collect();
        assert_eq!(keys.len(), uniq.len(), "bib 键必须唯一");
        assert!(!items.is_empty(), "首个分类不该是空的");

        // 整库路径单独验一遍：PDF 多半挂在未分类条目上，
        // 只测某个分类会漏掉 find_pdf 这条链路（实测 references 分类下 0 个 PDF，
        // 而库里有 4 个——附件的父条目不在任何分类里）
        let all = read_items(None, None).unwrap();
        let all_pdf = all.iter().filter(|i| i.pdf_path.is_some()).count();
        eprintln!("整库 {} 条，其中带 PDF {} 条", all.len(), all_pdf);
        for i in all.iter().filter(|i| i.pdf_path.is_some()).take(3) {
            let p = i.pdf_path.as_deref().unwrap();
            eprintln!("  pdf: {p}");
            assert!(
                std::path::Path::new(p).is_file(),
                "find_pdf 返回的路径必须真实存在: {p}"
            );
        }
        assert!(all.len() >= items.len(), "整库不该少于单个分类");
    }
}

// ===== Tauri commands =====

/// 导入结果：写了哪些文件、多少条、多少 PDF
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroImportDto {
    /// references.bib 相对项目根路径
    pub bib_rel: String,
    pub item_count: usize,
    /// 已登记为项目资源的 PDF 数
    pub pdf_count: usize,
    /// 无 PDF 附件的条目数（这些进 papers/to-fetch.md 的候选，由 agent 后续处理）
    pub missing_pdf: usize,
    pub config: crate::projects::ProjectConfigDto,
    pub manifest_rel: String,
}

// ===== 把 papers/ 已补全文挂进 Zotero（to-fetch 清单「同步到 Zotero」按钮，2026-09-16）=====
// 免 agent 会话：Rust 直连 Zotero 本地 API（127.0.0.1:23119），按 DOI 找条目、
// linked_file 附件挂 papers/ 的 PDF 绝对路径——不复制进 Zotero 存储（与「外部 PDF
// 只读引用」同口径，避免双份文件）。条目不存在时按题录最小字段新建再挂。
// 规则放宽记录：原「Zotero 写库只走技能」扩展为「技能或 UI 显式动作（按钮点击即
// 用户意图）」，见 AGENTS.md / conventions/pipeline.md

const ZOTERO_API: &str = "http://127.0.0.1:23119/api";
const BBT_RPC: &str = "http://127.0.0.1:23119/better-bibtex/json-rpc";
/// 官方 latest 的资产名带版本号（`zotero-better-bibtex-9.0.64.xpi`），
/// `/releases/latest/download/better-bibtex.xpi` 会 404。先查 GitHub API 再下 xpi。
const BBT_RELEASES_API: &str =
    "https://api.github.com/repos/retorquere/zotero-better-bibtex/releases/latest";
const BBT_ADDON_ID: &str = "better-bibtex@iris-advies.com";
const BBT_XPI_MAX: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToFetchEntryIn {
    pub title: String,
    /// DOI 或链接（链接暂不参与 Zotero 匹配，缺 DOI 的条目计入 unmatched）
    pub url: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroAttachResultDto {
    /// 已挂附件的条目标题
    pub attached: Vec<String>,
    /// 条目原先不存在、新建后挂上的
    pub created: Vec<String>,
    /// 条目已有同路径/同名附件，跳过
    pub skipped: Vec<String>,
    /// papers/ 还没拿到 PDF 的条目（不同步，仅汇报）
    pub missing: Vec<String>,
    /// 有 PDF 但既无 DOI 可查、也建不了条目的
    pub unmatched: Vec<String>,
    /// 单条同步失败（Zotero API 抖动等）——其余条目不受影响，失败的标原因可重试
    #[serde(default)]
    pub failed: Vec<String>,
}

fn zotero_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .user_agent("Mesa zotero-attach (https://github.com/hongtongzhou-design/ccode)")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

/// 本地 API 可用性。注意探**真实路由** `/api/users/0/items`：`/api` 根路径在 Zotero 的
/// 本地服务上无尾斜杠时 404（2026-09-16 实测：`/api`→404、`/api/`→200——不能用根路径探活）。
/// 2xx = 通；403 = 未开「允许其他应用与本机通信」；404 = 版本无本地 API；连不上 = 没开
async fn zotero_api_ready() -> Result<(), String> {
    let client = zotero_client(5)?;
    let resp = client
        .get(format!("{ZOTERO_API}/users/0/items"))
        .query(&[("limit", "1")])
        .send()
        .await
        .map_err(|_| {
            "连不上 Zotero 本地接口（127.0.0.1:23119）——同步需要 Zotero 正在运行".to_string()
        })?;
    match resp.status().as_u16() {
        200..=299 => Ok(()),
        403 => Err("Zotero 未开启本机通信：Zotero 设置 → 高级 → 常规 里勾选「允许其他应用与本机 Zotero 通信」后重试".into()),
        404 => Err("Zotero 在运行但本地接口不可用（HTTP 404）——同步需要 Zotero 7.1 及以上版本；旧版本可手动拖 to-fetch.ris 兜底".into()),
        code => Err(format!("Zotero 本地接口返回 HTTP {code}")),
    }
}

/// Zotero 9（及 7.x 起的 local API）源码写明「Write access is not yet supported」：
/// GET `/api/users/0/items` 通，POST 回纯文本 `Endpoint does not support method`。
/// 旧实现对着正文 `.json()`，reqwest 就报 "error decoding response body"，像随机失败。
const ZOTERO_WRITE_UNSUPPORTED: &str =
    "当前 Zotero 本地接口只读，不能往库里挂 PDF。请把 papers/ 里的文件拖到 Zotero 对应条目上；还没有条目就先把 papers/to-fetch.ris 拖进 Zotero。";

fn zotero_local_write_unsupported(body: &str) -> bool {
    let t = body.trim();
    t.contains("Endpoint does not support method")
        || t.contains("Write access is not yet supported")
}

fn zotero_write_error_message(status: u16, body: &str) -> String {
    if zotero_local_write_unsupported(body) {
        return ZOTERO_WRITE_UNSUPPORTED.to_string();
    }
    if status == 401 || status == 403 {
        return "Zotero 拒绝写入（可能需要授权）：Zotero 会弹出「允许应用写入」确认窗，点允许后重试；老版本可在设置里开本机通信".into();
    }
    let preview: String = body.trim().chars().take(160).collect();
    if preview.is_empty() {
        format!("Zotero 写入返回 HTTP {status}（空响应）")
    } else {
        format!("Zotero 写入返回 HTTP {status}：{preview}")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroBbtStatusDto {
    /// `/better-bibtex/json-rpc` 探活：200 = 已装。Zotero 没开或没装插件都是 false。
    pub installed: bool,
    pub xpi_url: String,
}

async fn bbt_rpc_installed() -> bool {
    let Ok(client) = zotero_client(2) else {
        return false;
    };
    let resp = client
        .post(BBT_RPC)
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "user.groups",
            "params": [],
            "id": 1
        }))
        .send()
        .await;
    matches!(resp, Ok(r) if r.status().is_success())
}

#[tauri::command]
pub async fn zotero_bbt_status() -> ZoteroBbtStatusDto {
    ZoteroBbtStatusDto {
        installed: bbt_rpc_installed().await,
        xpi_url: BBT_RELEASES_API.to_string(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroBbtInstallDto {
    pub staged: bool,
    pub message: String,
}

/// 解析 profiles.ini，取 Default=1，否则第一段有 Path 的。
fn parse_profiles_ini(text: &str, ini_dir: &Path) -> Option<PathBuf> {
    let mut default_path: Option<(bool, String)> = None;
    let mut first_path: Option<(bool, String)> = None;
    let mut rel = true;
    let mut path: Option<String> = None;
    let mut is_default = false;
    let flush = |rel: bool,
                 path: Option<String>,
                 is_default: bool,
                 default_path: &mut Option<(bool, String)>,
                 first_path: &mut Option<(bool, String)>| {
        let Some(p) = path else { return };
        if first_path.is_none() {
            *first_path = Some((rel, p.clone()));
        }
        if is_default {
            *default_path = Some((rel, p));
        }
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') && line.ends_with(']') {
            flush(
                rel,
                path.take(),
                is_default,
                &mut default_path,
                &mut first_path,
            );
            rel = true;
            is_default = false;
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                "IsRelative" => rel = v.trim() != "0",
                "Path" => path = Some(v.trim().to_string()),
                "Default" => is_default = v.trim() == "1",
                _ => {}
            }
        }
    }
    flush(
        rel,
        path.take(),
        is_default,
        &mut default_path,
        &mut first_path,
    );
    let (rel, p) = default_path.or(first_path)?;
    if rel {
        Some(ini_dir.join(p))
    } else {
        Some(PathBuf::from(p))
    }
}

fn parse_bbt_xpi_download_url(body: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "GitHub 最新版信息无法解析")?;
    let assets = v
        .get("assets")
        .and_then(|a| a.as_array())
        .ok_or("GitHub 最新版没有附件列表")?;
    let url = assets
        .iter()
        .find_map(|a| {
            let name = a.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let url = a
                .get("browser_download_url")
                .and_then(|n| n.as_str())
                .unwrap_or("");
            if name.ends_with(".xpi") && name.contains("better-bibtex") && !name.contains("debug") {
                Some(url)
            } else {
                None
            }
        })
        .ok_or("GitHub 最新版里没有 Better BibTeX 的 .xpi")?;
    if url.starts_with("https://github.com/retorquere/zotero-better-bibtex/releases/download/")
        && url.ends_with(".xpi")
    {
        Ok(url.to_string())
    } else {
        Err("GitHub 给出的下载地址不是官方仓库".into())
    }
}

fn bbt_id_from_manifest(text: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "Better BibTeX 安装包 manifest 无法解析")?;
    let id = v
        .pointer("/applications/zotero/id")
        .or_else(|| v.pointer("/browser_specific_settings/gecko/id"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    if id == BBT_ADDON_ID {
        Ok(id.to_string())
    } else {
        Err(format!(
            "安装包身份不是官方 Better BibTeX（得到 {id}），未写入 Zotero 目录"
        ))
    }
}

fn bbt_id_from_xpi(bytes: &[u8]) -> Result<String, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("Better BibTeX 安装包不是有效 zip: {e}"))?;
    let mut file = zip
        .by_name("manifest.json")
        .map_err(|_| "安装包里没有 manifest.json")?;
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|e| format!("读 manifest.json 失败: {e}"))?;
    bbt_id_from_manifest(&text)
}

async fn download_bbt_xpi() -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .user_agent("Mesa zotero-bbt (https://github.com/hongtongzhou-design/ccode)")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let meta = client
        .get(BBT_RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("查询 Better BibTeX 最新版失败（GitHub 可能较慢，请重试）: {e}"))?;
    if !meta.status().is_success() {
        return Err(format!(
            "查询 Better BibTeX 最新版失败：HTTP {}",
            meta.status()
        ));
    }
    let meta_text = meta
        .text()
        .await
        .map_err(|e| format!("读取 GitHub 最新版信息失败: {e}"))?;
    let xpi_url = parse_bbt_xpi_download_url(&meta_text)?;
    let resp = client
        .get(&xpi_url)
        .send()
        .await
        .map_err(|e| format!("下载 Better BibTeX 失败（GitHub 可能较慢，请重试）: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载 Better BibTeX 失败：HTTP {}", resp.status()));
    }
    if resp
        .content_length()
        .is_some_and(|n| n as usize > BBT_XPI_MAX)
    {
        return Err("Better BibTeX 安装包超过 64MB，已中止".into());
    }
    let bytes = crate::storage::response_bytes(resp, BBT_XPI_MAX)
        .await
        .map_err(|e| format!("下载 Better BibTeX 失败: {e}"))?;
    if bytes.len() < 64 {
        return Err("下载到的 Better BibTeX 安装包过小，已中止".into());
    }
    Ok(bytes)
}

/// 下载官方 xpi，校验身份后交给 Zotero 自己安装（弹出确认窗）。
/// Zotero 9 不会自动认丢进 extensions/ 的文件，所以不走静默拷贝。
#[tauri::command]
pub async fn zotero_install_bbt() -> Result<ZoteroBbtInstallDto, String> {
    if bbt_rpc_installed().await {
        return Ok(ZoteroBbtInstallDto {
            staged: true,
            message: "Better BibTeX 已经在运行，不用再装".into(),
        });
    }
    let bytes = download_bbt_xpi().await?;
    let _id = bbt_id_from_xpi(&bytes)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = dirs::config_dir()
            .ok_or("无法定位配置目录")?
            .join("ccode")
            .join("tmp");
        fs::create_dir_all(&dir).map_err(|e| format!("无法创建临时目录: {e}"))?;
        let dest = dir.join("better-bibtex.xpi");
        crate::storage::atomic_write(&dest, &bytes, true)?;
        // Windows 上 Zotero 的命令行不装插件（裸参数不理，-file 是导入题录），只能人在插件管理里从文件装
        #[cfg(windows)]
        {
            if let Some(exe) = zotero_exe() {
                let _ = crate::process::background_command(&exe).spawn();
            }
            Ok(ZoteroBbtInstallDto {
                staged: true,
                message: format!(
                    "安装包已下载：{}\nWindows 上 Zotero 不能从外部直接装插件：在 Zotero「工具 → 插件」（Zotero 6 叫「附加组件」）右上角齿轮里选「从文件安装」，选上面这份文件。装好后完全退出 Zotero 再打开。拖 RIS 不需要这个插件。",
                    dest.display()
                ),
            })
        }
        #[cfg(not(windows))]
        {
            tauri_plugin_opener::open_path(&dest, Some("Zotero"))
                .or_else(|_| tauri_plugin_opener::open_path(&dest, None::<&str>))
                .map_err(|e| {
                    format!(
                        "已下载安装包，但没法交给 Zotero 打开：{e}。请在 Zotero「工具 → 插件 → 从文件安装」里选这份文件：{}",
                        dest.display()
                    )
                })?;
            Ok(ZoteroBbtInstallDto {
                staged: true,
                message: "已交给 Zotero，请在弹出的窗口里点安装。装好后完全退出再打开（macOS 用 ⌘Q）。拖 RIS 不需要这个插件。".into(),
            })
        }
    })
    .await
    .map_err(|e| format!("打开 Zotero 安装窗口失败: {e}"))?
}

fn zotero_native_import_ext(ext: &str) -> bool {
    matches!(ext, "ris" | "bib" | "json")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroMatchDto {
    /// 本地 GET 通。不通时 present=0，界面不拦导入（Zotero 可能随后被 opener 拉起）
    pub reachable: bool,
    pub present: usize,
    pub missing: usize,
    pub total: usize,
}

async fn library_doi_set(client: &reqwest::Client) -> Result<HashSet<String>, String> {
    let mut out = HashSet::new();
    let mut start = 0usize;
    loop {
        let resp = client
            .get(format!("{ZOTERO_API}/users/0/items"))
            .query(&[("limit", "100"), ("start", &start.to_string())])
            .send()
            .await
            .map_err(|e| format!("查询 Zotero 条目失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("查询 Zotero 条目失败：HTTP {}", resp.status()));
        }
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("解析 Zotero 响应失败: {e}"))?;
        let items = items_of(&v);
        if items.is_empty() {
            break;
        }
        for it in &items {
            if let Some(d) = it
                .get("data")
                .and_then(|d| d.get("DOI"))
                .and_then(|d| d.as_str())
            {
                let n = doi_norm(d);
                if n.starts_with("10.") {
                    out.insert(n);
                }
            }
        }
        start += items.len();
        if items.len() < 100 || start >= 2000 {
            break;
        }
    }
    Ok(out)
}

/// 清单 DOI 与库内条目对照。Zotero 没开时 reachable=false，不报错。
#[tauri::command]
pub async fn zotero_match_dois(dois: Vec<String>) -> Result<ZoteroMatchDto, String> {
    let unique: HashSet<String> = dois
        .iter()
        .map(|d| doi_norm(d))
        .filter(|d| d.starts_with("10."))
        .collect();
    let total = unique.len();
    if total == 0 {
        return Ok(ZoteroMatchDto {
            reachable: true,
            present: 0,
            missing: 0,
            total: 0,
        });
    }
    if zotero_api_ready().await.is_err() {
        return Ok(ZoteroMatchDto {
            reachable: false,
            present: 0,
            missing: total,
            total,
        });
    }
    let client = zotero_client(8)?;
    let lib = match library_doi_set(&client).await {
        Ok(s) => s,
        Err(_) => {
            return Ok(ZoteroMatchDto {
                reachable: false,
                present: 0,
                missing: total,
                total,
            });
        }
    };
    let present = unique.iter().filter(|d| lib.contains(*d)).count();
    Ok(ZoteroMatchDto {
        reachable: true,
        present,
        missing: total.saturating_sub(present),
        total,
    })
}

/// 打开项目 papers/，方便把 PDF 拖进 Zotero。
#[tauri::command]
pub async fn zotero_open_papers(project_root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::projects::ensure_task_project_root(Path::new(
            &crate::sessions::expand_tilde(&project_root),
        ))?;
        let papers = root.join("papers");
        if !papers.is_dir() {
            fs::create_dir_all(&papers).map_err(|e| format!("无法创建 papers/: {e}"))?;
        }
        let papers_c =
            crate::paths::canonicalize_plain(&papers).map_err(|e| format!("papers/ 无效: {e}"))?;
        if !crate::paths::path_within_path(&papers_c, &root) {
            return Err("papers/ 不在项目目录内".into());
        }
        tauri_plugin_opener::open_path(&papers_c, None::<&str>)
            .map_err(|e| format!("没法打开 papers/: {e}"))
    })
    .await
    .map_err(|e| format!("{e}"))?
}

/// 按 references.bib 重写 papers/zotero-library.ris。不改 papers/to-fetch.ris。
/// 库里已有同一 DOI 的照样交（2026-10-23 用户拍板：Mesa 的题录字段全，导入后人在 Zotero「重复条目」里挑着合并），
/// 检索时排除的不交。返回 (RIS 路径, 条数+库体检提示)：都由 zotero_rtf --library-ris 打到 stdout。
/// 一条都没有时返回 None——零记录的 RIS 不是合法导入文件（Zotero 报「不支持所选文件的格式」），
/// 调用方直接把提示当反馈，不拉起 Zotero。
pub fn refresh_library_ris(project_root: &Path) -> Result<(Option<PathBuf>, String), String> {
    let root =
        crate::paths::canonicalize_plain(project_root).map_err(|e| format!("项目目录无效: {e}"))?;
    let bib = root.join("references.bib");
    if !bib.is_file() {
        return Err("还没有 references.bib。精读保存进项目后才能同步。".into());
    }
    let papers = root.join("papers");
    std::fs::create_dir_all(&papers).map_err(|e| format!("无法创建 papers/: {e}"))?;
    let ris = papers.join("zotero-library.ris");
    let stamp = uuid::Uuid::new_v4();
    let script = std::env::temp_dir().join(format!("ccode-zotero-ris-{stamp}.py"));
    crate::storage::atomic_write(
        &script,
        include_str!("../resources/skills/zotero-sync/scripts/zotero_rtf.py").as_bytes(),
        true,
    )?;
    let bridge = script.with_file_name("bridge.py");
    crate::storage::atomic_write(
        &bridge,
        include_str!("../resources/skills/endnote-bridge/scripts/bridge.py").as_bytes(),
        true,
    )?;
    // 库体检用的只读匹配器与 bridge 同目录随包（zotero_rtf --library-ris 会加载它）
    let matcher = script.with_file_name("library_match.py");
    crate::storage::atomic_write(
        &matcher,
        include_str!("../resources/skills/endnote-bridge/scripts/library_match.py").as_bytes(),
        true,
    )?;
    let abbr = script.with_file_name("journal-abbreviations.csv");
    crate::storage::atomic_write(
        &abbr,
        include_bytes!("../resources/journal-abbreviations.csv"),
        true,
    )?;
    // 找真能跑的 Python（dep_check::usable_python，Windows 上 python3 是应用商店占位）
    let py = crate::dep_check::usable_python().ok_or_else(|| {
        "本机找不到 python 3，无法生成 Zotero 导入文件（设置 → 诊断可一键安装 Python）".to_string()
    })?;
    // 从 Zotero / EndNote 导进引文库的老条目常缺摘要、ISSN、日期：有 DOI 的先按 Crossref / OpenAlex 补到
    // 临时副本里再导（同 EndNote 那份；引文库不动，字段已齐的不联网，补不成照原样导）
    let enriched = papers.join(format!(".ccode-zotero-{stamp}.bib"));
    let mut enrich = crate::process::background_command(&py);
    enrich
        .arg(&bridge)
        .arg("--enrich")
        .arg("--input")
        .arg(&bib)
        .arg("--output")
        .arg(&enriched)
        .current_dir(&root);
    // 排除的篇本来就不导，也就不用替它们联网补字段
    if papers.join("included.json").is_file() {
        enrich.arg("--skip-excluded").arg(papers.join("included.json"));
    }
    let mut filled = String::new();
    let source = match crate::process::capture_command(&mut enrich, Duration::from_secs(600), 1024 * 1024) {
        Ok(out) if !out.timed_out && out.status.is_some_and(|s| s.success()) && enriched.is_file() => {
            filled = String::from_utf8_lossy(&out.stdout).trim().to_string();
            enriched.clone()
        }
        _ => {
            let _ = std::fs::remove_file(&enriched);
            bib.clone()
        }
    };
    let mut cmd = crate::process::background_command(&py);
    cmd.arg(&script)
        .arg("--library-ris")
        .arg("--bib")
        .arg(&source)
        .arg("--ris")
        .arg(&ris)
        .current_dir(&root);
    // 检索时人排除的篇不导（引文库里还留着检索前从 Zotero 导进来、后来排除的条目）
    let included = papers.join("included.json");
    if included.is_file() {
        cmd.arg("--skip-excluded").arg(&included);
    }
    let out = cmd.output().map_err(|e| format!("无法生成 Zotero RIS: {e}"));
    if source != bib {
        let _ = std::fs::remove_file(&source);
    }
    let out = out?;
    let _ = std::fs::remove_file(&script);
    let _ = std::fs::remove_file(script.with_file_name("bridge.py"));
    let _ = std::fs::remove_file(script.with_file_name("library_match.py"));
    let _ = std::fs::remove_file(&abbr);
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(if err.trim().is_empty() {
            "生成 Zotero RIS 失败".into()
        } else {
            err.trim().to_string()
        });
    }
    if !ris.is_file() {
        return Err("转换结束但没有 papers/zotero-library.ris".into());
    }
    let health = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if health.contains("交给 Zotero 0 条") {
        return Ok((None, health));
    }
    let health = if filled.is_empty() { health } else { format!("{filled}\n{health}") };
    Ok((Some(ris), health))
}

/// 本机装的 Zotero 版本（application.ini 的 Version=）。找不到返回 None，调用方照常交文件。
/// Windows 跟 zotero_exe 同一处找；macOS 看「应用程序」里的 Zotero.app。Zotero 6 的 ini 在安装根目录，
/// Zotero 7 起挪进 app/ 子目录，两处都看。
fn installed_zotero_version() -> Option<String> {
    #[allow(unused_mut)]
    let mut roots: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    if let Some(dir) = zotero_exe().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        roots.push(dir);
    }
    #[cfg(target_os = "macos")]
    {
        roots.push(PathBuf::from("/Applications/Zotero.app/Contents/Resources"));
        if let Some(home) = dirs::home_dir() {
            roots.push(home.join("Applications/Zotero.app/Contents/Resources"));
        }
    }
    roots.into_iter().find_map(|root| {
        [root.join("application.ini"), root.join("app").join("application.ini")]
            .iter()
            .find_map(|ini| fs::read_to_string(ini).ok().and_then(|t| ini_version(&t)))
    })
}

/// application.ini 里 [App] 段的 Version=（Gecko 段也有 MinVersion=，不认它）
fn ini_version(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("Version="))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Zotero 6 及更早：2026 年起它自动更新下来的格式转换器（RIS.js 字符串里有 U+2028、BibTeX.js 用了新正则写法）
/// 在它的 Firefox 60 内核上解析失败，导入 RIS / BibTeX 一律报「不支持所选文件的格式」（2026-10-23 用户调试日志实证：
/// 「Detect using RIS failed: SyntaxError: "" string literal contains an unescaped line break」）。
fn zotero_too_old(version: &str) -> bool {
    version
        .split('.')
        .next()
        .and_then(|major| major.trim().parse::<u32>().ok())
        .is_some_and(|major| major < 7)
}

fn zotero_too_old_message(version: &str, file: &str) -> String {
    format!(
        "没有交给 Zotero：你装的是 Zotero {version}。Zotero 6 已停止更新，它自动下载的新版格式转换器它自己读不了，\
         导入 RIS、BibTeX 都会报「不支持所选文件的格式」。请升级到 Zotero 7 或更新版本（zotero.org/download；\
         原有文献、分类和附件在第一次打开时自动迁移），再点一次「同步到 Zotero」。导入文件已经生成：{file}。"
    )
}

/// 把导入文件交给 Zotero，让它弹「导入」确认。
/// macOS 的「用 Zotero 打开」走 Apple 事件，Zotero 收到的是 `-url file:///…`，会导入。
/// Windows 上「用 Zotero 打开」= 拿路径当裸参数起 zotero.exe，而 Zotero 的命令行只认 `-file <路径>`
/// 和 `-url file:///…`，裸参数不理——Zotero 打开了、没有导入（2026-10-23 用户实测，Zotero 6.0.36；
/// 见安装目录 components/zotero-service.js 的命令行处理）。Zotero 已经开着时，新起的 zotero.exe 把参数转给它后退出。
/// 用 `-url` 交百分号编码的 file URL，不用 `-file <路径>`：路径里有中文（D:\HER综述\…）时，`-file` 经「转给已开着的
/// Zotero」那一程变了样，Zotero 弹了导入确认、随后报「不支持所选文件的格式」（同日实测）；URL 全是 ASCII，不经编码转换。
/// Zotero 自己登记的 zotero:// 打开命令、macOS 的 Apple 事件走的也是 `-url`。
fn hand_file_to_zotero(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let exe = zotero_exe().ok_or_else(|| {
            format!(
                "没找到 Zotero（zotero.exe）。打开 Zotero 后用「文件 → 导入」选这份文件：{}",
                path.display()
            )
        })?;
        crate::process::background_command(&exe)
            .arg("-url")
            .arg(file_url(path))
            .spawn()
            .map_err(|e| format!("没法交给 Zotero 打开: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        tauri_plugin_opener::open_path(path, Some("Zotero"))
            .or_else(|_| tauri_plugin_opener::open_path(path, None::<&str>))
            .map_err(|e| format!("没法交给 Zotero 打开: {e}"))
    }
}

/// 本地路径 → 百分号编码的 file URL（`file:///D:/HER%E7%BB%BC%E8%BF%B0/…`）。盘符的冒号与目录分隔留着，其余非 unreserved 字节编码
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let segments: Vec<String> = text
        .split('/')
        .enumerate()
        .map(|(i, seg)| {
            let drive = i == 0 && seg.len() == 2 && seg.ends_with(':') && seg.as_bytes()[0].is_ascii_alphabetic();
            if drive {
                seg.to_string()
            } else {
                crate::client_open::percent_encode(seg)
            }
        })
        .collect();
    let joined = segments.join("/");
    if joined.starts_with('/') {
        format!("file://{joined}")
    } else {
        format!("file:///{joined}")
    }
}

/// Windows 上的 zotero.exe：安装包写的注册表 App Paths → 常见安装目录。找不到返回 None。
#[cfg(windows)]
fn zotero_exe() -> Option<PathBuf> {
    for hive in ["HKLM", "HKCU"] {
        let key = format!(r"{hive}\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\zotero.exe");
        if let Some(value) = crate::process::reg_string(&key, None) {
            let exe = PathBuf::from(value.trim_matches('"'));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    let mut dirs: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(|var| std::env::var_os(var))
        .map(|dir| PathBuf::from(dir).join("Zotero"))
        .collect();
    if let Some(local) = dirs::data_local_dir() {
        dirs.push(local.join("Zotero"));
        dirs.push(local.join("Programs").join("Zotero"));
    }
    dirs.into_iter()
        .map(|dir| dir.join("zotero.exe"))
        .find(|exe| exe.is_file())
}

/// 用 Zotero 打开 RIS/BibTeX/CSL JSON（原生导入，不需要 Better BibTeX）。
#[tauri::command]
pub async fn zotero_open_import(path: String, root: String) -> Result<String, String> {
    // 重写 RIS 和打开 Zotero 都在后台线程。按钮立刻显示「正在按引文库生成」。
    tauri::async_runtime::spawn_blocking(move || {
        let root_exp = crate::sessions::expand_tilde(&root);
        let path_exp = crate::sessions::expand_tilde(&path);
        let root_c = crate::paths::canonicalize_plain(std::path::Path::new(&root_exp))
            .map_err(|e| format!("目录无效: {e}"))?;
        let (open_path, health) = if root_c.join("references.bib").is_file() {
            refresh_library_ris(&root_c)?
        } else {
            (Some(std::path::PathBuf::from(&path_exp)), String::new())
        };
        // 一条要导的都没有：不拉起 Zotero，提示就是反馈
        let open_path = match open_path {
            Some(path) => path,
            None => return Ok(health),
        };
        let path_c = crate::paths::canonicalize_plain(&open_path)
            .map_err(|_| "找不到 papers/zotero-library.ris（精读保存后会按引文库生成）".to_string())?;
        if !crate::paths::path_within_path(&path_c, &root_c) {
            return Err("导入文件不在项目目录内".into());
        }
        let ext = path_c
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !zotero_native_import_ext(&ext) {
            return Err("只打开 RIS / BibTeX / CSL JSON 给 Zotero 导入".into());
        }
        // Zotero 6 导不进：先说清楚，不拉起一个注定报「不支持所选文件的格式」的导入
        if let Some(version) = installed_zotero_version() {
            if zotero_too_old(&version) {
                let shown = path_c
                    .strip_prefix(&root_c)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| path_c.display().to_string());
                let mut message = zotero_too_old_message(&version, &shown);
                if !health.is_empty() {
                    message.push_str("\n\n");
                    message.push_str(&health);
                }
                return Ok(message);
            }
        }
        hand_file_to_zotero(&path_c)?;
        let mut message =
            "已交给 Zotero。确认导入后，点「打开 papers」，把 PDF 拖到对应条目上。".to_string();
        if !health.is_empty() {
            message.push_str("\n\n");
            message.push_str(&health);
        }
        Ok(message)
    })
    .await
    .map_err(|e| format!("{e}"))?
}

/// 探一次 POST：只读接口立刻停，避免 20 篇各报一遍解码失败。
async fn ensure_zotero_writable(client: &reqwest::Client) -> Result<(), String> {
    let resp = client
        .post(format!("{ZOTERO_API}/users/0/items"))
        .json(&serde_json::json!([]))
        .send()
        .await
        .map_err(|e| format!("写入 Zotero 失败: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if zotero_local_write_unsupported(&body) {
        return Err(ZOTERO_WRITE_UNSUPPORTED.to_string());
    }
    // 空数组本身可能 400（非法条目），只要不是「方法不支持」就当写入通道在
    let _ = status;
    Ok(())
}

/// DOI 归一比较：剥 doi:/https://doi.org/ 前缀、小写、去尾句读
fn doi_norm(raw: &str) -> String {
    let t = raw.trim();
    let t = t
        .strip_prefix("doi:")
        .or_else(|| t.strip_prefix("DOI:"))
        .map(str::trim)
        .unwrap_or(t);
    let t = t
        .strip_prefix("https://doi.org/")
        .or_else(|| t.strip_prefix("http://doi.org/"))
        .unwrap_or(t);
    t.trim_end_matches(['.', ',', ';', ')'])
        .to_ascii_lowercase()
}

fn is_doish(s: &str) -> bool {
    let mut parts = s.splitn(2, '/');
    let prefix = parts.next().unwrap_or("");
    let suffix = parts.next().unwrap_or("");
    !suffix.is_empty()
        && prefix.len() > 3
        && prefix.starts_with("10.")
        && prefix[3..].bytes().all(|b| b.is_ascii_digit())
}

/// 从本地 API 响应（数组或 {items:[...]}）里抽条目列表
fn items_of(v: &serde_json::Value) -> Vec<&serde_json::Value> {
    if let Some(arr) = v.as_array() {
        return arr.iter().collect();
    }
    v.get("items")
        .and_then(|i| i.as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}

/// 按 DOI 找条目 key；miss 返回 None
async fn find_key_by_doi(client: &reqwest::Client, doi: &str) -> Result<Option<String>, String> {
    let resp: serde_json::Value = client
        .get(format!("{ZOTERO_API}/users/0/items"))
        .query(&[("q", doi), ("limit", "10")])
        .send()
        .await
        .map_err(|e| format!("查询 Zotero 条目失败: {e}"))?
        .json()
        .await
        .map_err(|e| format!("解析 Zotero 响应失败: {e}"))?;
    Ok(items_of(&resp).into_iter().find_map(|it| {
        let hit = it
            .get("data")
            .and_then(|d| d.get("DOI"))
            .and_then(|d| d.as_str())
            .is_some_and(|d| doi_norm(d) == doi);
        if !hit {
            return None;
        }
        it.get("key")?.as_str().map(str::to_string)
    }))
}

/// POST /users/0/items 的统一出口：解析 successful/failed 信封
async fn post_items(
    client: &reqwest::Client,
    body: serde_json::Value,
) -> Result<Vec<(String, String)>, String> {
    let resp = client
        .post(format!("{ZOTERO_API}/users/0/items"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("写入 Zotero 失败: {e}"))?;
    let status = resp.status();
    // 先读文本再解析：Zotero 9 POST 回 text/plain「Endpoint does not support method」，
    // 对着 `.json()` 只会得到 reqwest 的 "error decoding response body"
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取 Zotero 写入响应失败: {e}"))?;
    if !status.is_success() {
        return Err(zotero_write_error_message(status.as_u16(), &text));
    }
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        format!(
            "解析 Zotero 写入响应失败: {e}；响应开头: {}",
            text.chars().take(120).collect::<String>()
        )
    })?;
    let mut out = Vec::new();
    if let Some(failed) = v.get("failed").and_then(|f| f.as_object()) {
        if !failed.is_empty() {
            return Err(format!(
                "Zotero 拒绝了部分写入（{} 条）：{:?}",
                failed.len(),
                failed.keys().collect::<Vec<_>>()
            ));
        }
    }
    // successful 信封或裸数组都认
    if let Some(ok) = v.get("successful").and_then(|s| s.as_object()) {
        for (_, item) in ok {
            let key = item
                .get("key")
                .and_then(|k| k.as_str())
                .or_else(|| {
                    item.get("data")
                        .and_then(|d| d.get("key"))
                        .and_then(|k| k.as_str())
                })
                .unwrap_or("")
                .to_string();
            let title = item
                .get("data")
                .and_then(|d| d.get("title"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            out.push((key, title));
        }
        return Ok(out);
    }
    for item in items_of(&v) {
        let key = item
            .get("key")
            .and_then(|k| k.as_str())
            .unwrap_or("")
            .to_string();
        let title = item
            .get("data")
            .and_then(|d| d.get("title"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        out.push((key, title));
    }
    Ok(out)
}

/// 条目已挂的附件里是否已有同路径/同名 PDF（幂等跳过）
async fn already_attached(
    client: &reqwest::Client,
    key: &str,
    pdf_name: &str,
    pdf_path: &str,
) -> Result<bool, String> {
    let resp: serde_json::Value = client
        .get(format!("{ZOTERO_API}/users/0/items/{key}/children"))
        .send()
        .await
        .map_err(|e| format!("读取条目附件失败: {e}"))?
        .json()
        .await
        .map_err(|e| format!("解析附件列表失败: {e}"))?;
    Ok(items_of(&resp).iter().any(|c| {
        let data = c.get("data").unwrap_or(&serde_json::Value::Null);
        let path_hit = data
            .get("path")
            .and_then(|p| p.as_str())
            .is_some_and(|p| p == pdf_path);
        let name_hit = data
            .get("title")
            .and_then(|t| t.as_str())
            .is_some_and(|t| t.eq_ignore_ascii_case(pdf_name));
        path_hit || name_hit
    }))
}

/// to-fetch.ris 的单条题录（RIS 2004；字段缺则 None，不编造）
#[derive(Debug, Clone, Default, PartialEq)]
struct RisRecord {
    authors: Vec<String>,
    year: Option<String>,
    publication: Option<String>,
}

/// 解析 RIS 文本成 DOI → 题录映射（按 DO 字段归一匹配；无 DO 的记录丢弃）。
/// 行格式 `XX  - 值`，宽容 CRLF/多余空白；TY 开新记录、ER 收尾
fn parse_ris_by_doi(text: &str) -> std::collections::HashMap<String, RisRecord> {
    let mut out = std::collections::HashMap::new();
    let mut cur_doi: Option<String> = None;
    let mut rec = RisRecord::default();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        let trimmed = line.trim();
        // 按.Tag  - 切分不要求值侧空格（空值行 trim 后是 `ER  -`，带尾空格会切不开）
        let Some((tag, value)) = trimmed.split_once("  -") else {
            if let Some((t, v)) = trimmed.split_once("\t-") {
                handle_ris_line(t.trim(), v.trim(), &mut rec, &mut cur_doi, &mut out);
            }
            continue;
        };
        handle_ris_line(tag.trim(), value, &mut rec, &mut cur_doi, &mut out);
    }
    // 没有 ER 收尾的尾巴记录也收
    if let Some(doi) = cur_doi.take() {
        if !doi.is_empty() {
            out.entry(doi).or_insert(rec);
        }
    }
    out
}

fn handle_ris_line(
    tag: &str,
    value: &str,
    rec: &mut RisRecord,
    cur_doi: &mut Option<String>,
    out: &mut std::collections::HashMap<String, RisRecord>,
) {
    let tag = tag.to_ascii_uppercase();
    let value = value.trim();
    match tag.as_str() {
        "TY" => {
            *rec = RisRecord::default();
            *cur_doi = None;
        }
        "AU" => {
            if !value.is_empty() {
                rec.authors.push(value.to_string());
            }
        }
        "PY" | "DA" => {
            // PY 常见 `2023` 或 `2023-05-01`：只取前 4 位年
            let y: String = value
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .take(4)
                .collect();
            if y.len() == 4 {
                rec.year = Some(y);
            }
        }
        "T2" | "JO" | "JF" => {
            if !value.is_empty() && rec.publication.is_none() {
                rec.publication = Some(value.to_string());
            }
        }
        "DO" => {
            let d = doi_norm(value);
            if !d.is_empty() {
                *cur_doi = Some(d);
            }
        }
        "ER" => {
            if let Some(doi) = cur_doi.take() {
                out.entry(doi).or_insert(std::mem::take(rec));
            }
        }
        _ => {}
    }
}

/// RIS AU（`姓, 名` / 裸名）→ Zotero creators JSON
fn ris_creators_json(authors: &[String]) -> serde_json::Value {
    serde_json::Value::Array(
        authors
            .iter()
            .map(|a| {
                if let Some((last, first)) = a.split_once(',') {
                    serde_json::json!({
                        "creatorType": "author",
                        "firstName": first.trim(),
                        "lastName": last.trim(),
                    })
                } else {
                    serde_json::json!({
                        "creatorType": "author",
                        "name": a.trim(),
                    })
                }
            })
            .collect(),
    )
}

/// 主流程：papers/ PDF × to-fetch 条目本地配对 → Zotero 本地 API 找/建条目 → 挂
/// linked_file 附件（绝对路径，不复制进 Zotero 存储）
async fn attach_fulltexts_inner(
    project_root: &Path,
    entries: &[ToFetchEntryIn],
    ris_text: Option<&str>,
) -> Result<ZoteroAttachResultDto, String> {
    zotero_api_ready().await?;
    let client = zotero_client(20)?;
    ensure_zotero_writable(&client).await?;
    let ris = ris_text.map(parse_ris_by_doi).unwrap_or_default();
    let papers = project_root.join("papers");
    let mut pdfs: Vec<PathBuf> = std::fs::read_dir(&papers)
        .map_err(|_| "项目根没有 papers/ 目录".to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("pdf")))
        .collect();
    pdfs.sort();

    let mut dto = ZoteroAttachResultDto::default();
    let mut taken = std::collections::HashSet::new();
    for entry in entries {
        let want = crate::lit_watch::normalize_title(&entry.title);
        if want.is_empty() {
            continue;
        }
        // 短边 ≥8 护栏（与 lit_watch.to_fetch_progress_inner 同款纪律）：
        // 无护栏时 1 字符的 norm 会包含命中任何含它的文件名，短标题条目可能
        // 错挂到别人的 PDF（2026-09-17 审计）
        let hit = pdfs.iter().position(|p| {
            let key = p.to_string_lossy().into_owned();
            if taken.contains(&key) {
                return false;
            }
            let stem = p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let have = crate::lit_watch::normalize_title(&stem);
            let short = have.len().min(want.len());
            !have.is_empty() && short >= 8 && (have.contains(&want) || want.contains(&have))
        });
        let Some(pos) = hit else {
            dto.missing.push(entry.title.clone());
            continue;
        };
        let pdf = pdfs[pos].clone();
        taken.insert(pdf.to_string_lossy().into_owned());
        let pdf_path = pdf.to_string_lossy().into_owned();
        let pdf_name = pdf
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        // 单条失败只记账不冒泡（2026-09-17 审计：第 15 篇时 Zotero 本地 API 抖
        // 一下，旧 `?` 把整个函数弹 Err，前 14 篇已挂上/已新建的结果全部丢失，
        // 用户只见「同步失败」不知哪些已进 Zotero）
        if let Err(e) = attach_entry(&client, &mut dto, entry, &ris, &pdf_name, &pdf_path).await {
            dto.failed.push(format!("{}：{e}", entry.title));
            continue;
        }
    }
    Ok(dto)
}

/// 单条挂附件（查/建条目 → 查重 → linked_file 附件）；dto 的 created/attached/
/// skipped/unmatched 就地计入，Err 只代表这一条失败
async fn attach_entry(
    client: &reqwest::Client,
    dto: &mut ZoteroAttachResultDto,
    entry: &ToFetchEntryIn,
    ris: &std::collections::HashMap<String, RisRecord>,
    pdf_name: &str,
    pdf_path: &str,
) -> Result<(), String> {
    let doi = doi_norm(&entry.url);
    let key = if is_doish(&doi) {
        match find_key_by_doi(client, &doi).await? {
            Some(k) => k,
            // 条目不存在：按题录最小字段新建（journalArticle + DOI）
            None => {
                // 有 RIS 题录（作者/年份/来源）就建全条目；没有回落最小条目（标题+DOI）
                let ris_rec = ris.get(&doi);
                let mut item = serde_json::json!({
                    "itemType": "journalArticle",
                    "title": entry.title,
                    "DOI": doi,
                });
                if let Some(r) = ris_rec {
                    if !r.authors.is_empty() {
                        item["creators"] = ris_creators_json(&r.authors);
                    }
                    if let Some(y) = &r.year {
                        item["date"] = serde_json::json!(y);
                    }
                    if let Some(p) = &r.publication {
                        item["publicationTitle"] = serde_json::json!(p);
                    }
                }
                let body = serde_json::json!([item]);
                let created = post_items(client, body).await?;
                let Some((k, _)) = created.first() else {
                    dto.unmatched.push(entry.title.clone());
                    return Ok(());
                };
                dto.created.push(entry.title.clone());
                k.clone()
            }
        }
    } else {
        // 没 DOI：无从可靠查重，不建重复条目（会话里 agent 可带全题录补建）
        dto.unmatched.push(entry.title.clone());
        return Ok(());
    };

    if already_attached(client, &key, pdf_name, pdf_path).await? {
        dto.skipped.push(entry.title.clone());
        return Ok(());
    }
    let body = serde_json::json!([{
        "itemType": "attachment",
        "parentItem": key,
        "linkMode": "linked_file",
        "title": pdf_name,
        "path": pdf_path,
        "contentType": "application/pdf",
    }]);
    post_items(client, body).await?;
    dto.attached.push(entry.title.clone());
    Ok(())
}

#[tauri::command]
pub async fn zotero_attach_fulltexts(
    project_root: String,
    entries: Vec<ToFetchEntryIn>,
    // to-fetch.ris 全文（前端从步骤工作区/项目根读好传入——RIS 与 to-fetch.md 同源）
    ris_text: Option<String>,
) -> Result<ZoteroAttachResultDto, String> {
    let root = tauri::async_runtime::spawn_blocking(move || {
        crate::projects::ensure_task_project_root(Path::new(&project_root))
    })
    .await
    .map_err(|e| format!("校验项目目录失败: {e}"))??;
    attach_fulltexts_inner(&root, &entries, ris_text.as_deref()).await
}

#[tauri::command]
pub async fn zotero_inspect(data_dir: Option<String>) -> Result<ZoteroLibraryDto, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_library(data_dir.as_deref()))
        .await
        .map_err(|e| format!("读取 Zotero 库失败: {e}"))?
}

#[tauri::command]
pub async fn zotero_items(
    data_dir: Option<String>,
    collection_id: Option<i64>,
) -> Result<Vec<ZoteroItemDto>, String> {
    tauri::async_runtime::spawn_blocking(move || read_items(data_dir.as_deref(), collection_id))
        .await
        .map_err(|e| format!("读取 Zotero 条目失败: {e}"))?
}

/// 导入选定分类到项目：生成 references.bib，并把已下载的 PDF 按**绝对路径**登记为项目资源。
///
/// PDF 只登记不复制（机制一「资料只记位置不复制」）：Zotero 的 storage 才是权威副本，
/// 复制一份进项目只会产生两份会各自漂移的文件。TASK.md 的「项目资源」段给绝对路径，
/// agent 直读即可。
#[tauri::command]
pub async fn zotero_import(
    project_root: String,
    data_dir: Option<String>,
    collection_id: Option<i64>,
    linked_attachment_base: Option<String>,
) -> Result<ZoteroImportDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::projects::ensure_task_project_root(Path::new(
            &crate::sessions::expand_tilde(&project_root),
        ))?;
        let linked = linked_attachment_base
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(Path::new);
        if linked.is_some_and(|p| !p.is_dir()) {
            return Err("链接附件基目录不存在".into());
        }
        let items = read_items_with_base(data_dir.as_deref(), collection_id, linked)?;
        if items.is_empty() {
            return Err("这个分类下没有可导入的条目".into());
        }
        import_items_at(&root, &items)
    })
    .await
    .map_err(|e| format!("导入 Zotero 失败: {e}"))?
}

fn import_items_at(root: &Path, items: &[ZoteroItemDto]) -> Result<ZoteroImportDto, String> {
    let _guard = crate::projects::project_config_lock(root)?;
    let read = crate::projects::read_config_at(root);
    // validate_step 的「步骤…」是输入/交付提示，导入本来就是为补齐输入；解析错误才拒写。
    let parse_warnings: Vec<_> = read
        .warnings
        .iter()
        .filter(|w| !w.starts_with("步骤「"))
        .collect();
    if !parse_warnings.is_empty() {
        return Err(format!(
            "项目配置需先修复：{}",
            parse_warnings
                .into_iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("；")
        ));
    }
    let mut cfg = read.config;
    let batch = uuid::Uuid::new_v4().to_string();
    let bib_rel = if root.join("references.bib").exists() {
        format!("papers/imports/zotero-{batch}.bib")
    } else {
        "references.bib".to_string()
    };
    let manifest_rel = format!("papers/imports/zotero-{batch}.json");
    for relative in [&bib_rel, &manifest_rel] {
        let mut path = root.to_path_buf();
        for part in Path::new(relative).components() {
            path.push(part);
            if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err("导入路径经过符号链接，未写入".into());
            }
        }
    }
    crate::profiles::atomic_write(&root.join(&bib_rel), &render_bibtex(items))?;
    let rows: Vec<_> = items
        .iter()
        .map(|item| {
            serde_json::json!({
                "id": format!("{}:{}", item.library_id, item.key), "title": item.title,
                "bibKey": bib_key(item), "doi": item.doi, "pdfPath": item.pdf_path,
                "status": if bib_rel == "references.bib" { "imported" } else { "pending-merge" }
            })
        })
        .collect();
    crate::profiles::atomic_write(
        &root.join(&manifest_rel),
        &serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())?,
    )?;
    let mut known: std::collections::HashSet<String> = cfg
        .resources
        .iter()
        .map(|r| r.path.replace('\\', "/"))
        .collect();
    let mut pdf_count = 0;
    for item in items {
        if let Some(path) = item
            .pdf_path
            .as_ref()
            .filter(|p| known.insert(p.replace('\\', "/")))
        {
            cfg.resources.push(crate::projects::ResourceDto {
                name: strip_title_prefix(&item.title).to_string(),
                path: path.clone(),
                kind: "paper".into(),
                readonly: true,
                note: format!("Zotero {}:{}", item.library_id, item.key),
            });
            pdf_count += 1;
        }
    }
    if known.insert(bib_rel.clone()) {
        cfg.resources.push(crate::projects::ResourceDto {
            name: "Zotero 题录（保留已有引用键，先对账再合并）".into(),
            path: bib_rel.clone(),
            kind: "reference".into(),
            readonly: true,
            note: format!("条目/PDF 映射：{manifest_rel}；重复导入不自动改主引用库"),
        });
    }
    cfg.lit_source = "zotero".into();
    crate::projects::write_config_at(root, &cfg)?;
    Ok(ZoteroImportDto {
        bib_rel,
        item_count: items.len(),
        pdf_count,
        missing_pdf: items.iter().filter(|i| i.pdf_path.is_none()).count(),
        config: cfg,
        manifest_rel,
    })
}
