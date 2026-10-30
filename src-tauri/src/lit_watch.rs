//! 文献雷达（lit-watch）应用层消费：解析项目根下 lit-watch / lit-search 技能产出的
//! 四个文件为 DTO，并支持处置动作（订阅整表写回、精读清单增删、PDF 下载登记）。
//!
//! 文件约定（见 src-tauri/resources/skills/lit-watch/SKILL.md、lit-search/SKILL.md）：
//! - `notes/inbox.md`：巡检命中条目（`<!-- watch-run: YYYY-MM-DD -->` 批次标记 + `## 标题` + 字段行）
//! - `papers/watch-followup.md`：付费墙/无摘要待办（`- ` 开头一行一条，字段「 — 」分隔）
//! - `papers/watchlist.md`：订阅清单（`关键词 — 来源 — 备注`，来源逗号分隔多选）
//! - `papers/included.md`：精读清单（`标题 — 作者, 年份 — 来源 — 链接/DOI`，一行一篇）
//! - `.ccode/watch-explains.json`：雷达快筛解读缓存（按规范化标题去重，不进 inbox.md）
//!
//! 防护口径：一切文件操作限定在已注册项目根内（projects::ensure_task_project_root，
//! 同任务卡写入门檻）；目标文件已存在时先 canonicalize 双校验仍在根内，堵符号链接逃逸
//! （同 append_inbox_at）；写操作一律读-改-原子写（profiles::atomic_write）。
//! 解析全部容错：坏行跳过，不整体失败。
//! 返回前端的文本是用户自己的项目文件内容，原样返回即可（脱敏口径见 AGENTS.md：
//! 会话出站才必须脱敏，项目文件不在此列）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// inbox.md 条目上限：只取最新 500 条（收件箱只增不改，防超大文件拖垮前端）
const MAX_ENTRIES: usize = 500;
/// 下载 PDF 上限：60MB，流式读取超限即中止
pub(crate) const DOWNLOAD_CAP: usize = 60 * 1024 * 1024;
/// 下载总超时（含连接）：60MB 在慢速网络下给足余量
const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// 文件名 sanitize 后主干（不含扩展名）的字符上限
const FILE_STEM_CAP: usize = 110;
/// 快筛解读落盘：项目内 Ccode 痕迹，不进 inbox.md（巡检只增不改那份）
const EXPLAINS_REL: &str = ".ccode/watch-explains.json";
const EXPLAIN_TEXT_CAP: usize = 8 * 1024;
const EXPLAIN_ITEMS_CAP: usize = 500;

// ===== DTO（camelCase，风格同 models.rs） =====

/// inbox.md 中的一条文献命中
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchEntryDto {
    /// 标题 + 原注释批次日期的稳定哈希，`w-<hex>`；兼容前端已有忽略记录
    pub id: String,
    pub title: String,
    /// 来源行第一段（arxiv / 期刊 / 会议名）
    pub source: String,
    pub authors: String,
    pub abstract_first: String,
    pub keywords_hit: Vec<String>,
    /// "推荐" | "相关" | "待确认"；字段缺失时按「待确认」（技能口径：拿不准一律待确认）
    pub relevance: String,
    /// 期刊字段（新增可选行）；旧条目没有为 None
    pub journal: Option<String>,
    /// 中文一句话（新增可选行）；旧条目没有为空串
    pub zh_summary: String,
    /// 来源行里的链接/DOI 段；没有为空串
    pub url: String,
    /// 来源行第二段的发表日期（arXiv 发布日/期刊出版日）；旧条目缺段为 None。
    /// 与 `date`（巡检批次日，趋势图用）是两回事
    #[serde(default)]
    pub pub_date: Option<String>,
    /// 最近的巡检批次日期（标准注释或旧版巡检标题）；缺失/无效为 None
    pub date: Option<String>,
    /// 条目在 inbox.md 中的行范围（1 起，闭区间），供前端定位/高亮
    pub raw_line_range: [u32; 2],
    /// 期刊指标徽章（IF/中科院分区/Top）；期刊指标表未下载或查不到为 None
    pub metrics: Option<crate::journal_metrics::JournalMetricsDto>,
    /// 已落盘的快筛解读（`.ccode/watch-explains.json`）；未解读为 None
    #[serde(default)]
    pub explain: Option<String>,
}

/// watch-followup.md 中的一条待办（付费墙/无摘要，待人工获取全文）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchFollowupDto {
    pub title: String,
    pub url: String,
    /// 缺失原因/备注（题录中链接之外的其余段）
    pub note: String,
}

/// list_watch_entries 的返回：命中条目 + 跟进待办
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchInboxDto {
    pub entries: Vec<WatchEntryDto>,
    pub followups: Vec<WatchFollowupDto>,
}

/// watchlist.md 订阅行（整表读写的双向 DTO）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchSubscriptionDto {
    pub keyword: String,
    /// 来源多选（arxiv/openalex/crossref/web）；空 = 技能缺省口径
    pub sources: Vec<String>,
    pub note: String,
}

/// included.md 精读清单行
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IncludedEntryDto {
    /// 行内容哈希 id，`i-<hex>`；remove 时原样回传，按行内容精确匹配
    pub line_id: String,
    pub title: String,
    /// 「作者, 年份」整段（不拆开，格式由 lit-search 定义）
    pub authors_year: String,
    pub source: String,
    pub link: String,
    pub raw_line: String,
}

/// add_reading_list_entry 返回：added=false 表示规范化标题已存在（去重）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddIncludedResultDto {
    pub added: bool,
}

/// download_paper_pdf 返回：落盘绝对路径 + 资源登记名（文件 stem）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedPaperDto {
    pub path: String,
    pub name: String,
    /// 命中 papers/ 已有同一份（字节级相同）未重复写入——前端据此改说「已有同一份」
    #[serde(default)]
    pub dedup: bool,
}

// ===== 公共小件 =====

/// 内容哈希 id（DefaultHasher 固定种子）；条目忽略记录依赖其稳定性。
fn hash_id(prefix: &str, parts: &[&str]) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for p in parts {
        p.hash(&mut h);
    }
    format!("{prefix}-{:016x}", h.finish())
}

/// 门檻 + canonical 项目根（所有 command 的第一道工序）
fn gated_root(project_root: &str) -> Result<PathBuf, String> {
    crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(
        project_root,
    )))
}

/// 根内相对路径解析：文件已存在时 canonicalize 双校验仍在根内（堵 symlink 逃逸），
/// 不存在则原样返回拼接路径（供新建）；root 必须已是 canonical（gated_root 保证）
fn resolve_inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = root.join(rel);
    if p.exists() || p.is_symlink() {
        let c =
            crate::paths::canonicalize_plain(&p).map_err(|e| format!("路径无效（{rel}）: {e}"))?;
        // root 在测试里可能是未解析的 /var → /private/var；先对齐再比
        let root_c = crate::paths::canonicalize_plain(root).unwrap_or_else(|_| root.to_path_buf());
        if !crate::paths::path_within_path(&c, &root_c) {
            return Err(format!("{rel} 指向项目目录之外，拒绝访问"));
        }
    }
    Ok(p)
}

pub(crate) fn read_text_inside(root: &Path, rel: &str) -> Result<Option<String>, String> {
    let p = resolve_inside(root, rel)?;
    match fs::read_to_string(&p) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取 {rel} 失败: {e}")),
    }
}

/// 读-改-原子写公共尾：父目录不存在则建，写前对已存在文件做过 resolve_inside 校验
fn write_text_inside(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    let p = resolve_inside(root, rel)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败（{rel}）: {e}"))?;
    }
    crate::profiles::atomic_write(&p, text)
}

// ===== notes/inbox.md 解析 =====

/// 保留旧批次标记的宽松口径，仅用于稳定 ID；展示日期另作日历校验。
fn parse_batch_marker(line: &str) -> Option<String> {
    let inner = line
        .trim()
        .strip_prefix("<!-- watch-run:")?
        .strip_suffix("-->")?;
    let d = inner.trim();
    if d.len() == 10 && d.chars().all(|c| c.is_ascii_digit() || c == '-') {
        Some(d.to_string())
    } else {
        None
    }
}

/// 巡检完成时刻 → 上海日历日。批次标记用这个，不用论文发表日期，也不用 UTC 日。
pub(crate) fn shanghai_calendar_day(iso: &str) -> Option<String> {
    let raw = iso.trim();
    if raw.is_empty() {
        return None;
    }
    let east = chrono::FixedOffset::east_opt(8 * 3600)?;
    let dt = chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%SZ")
                .ok()
                .and_then(|n| n.and_utc().fixed_offset().into())
        })?;
    let day = dt.with_timezone(&east).format("%Y-%m-%d").to_string();
    validated_batch_date(&day)
}

/// 给还没有批次标记的收件箱补一行。已有标记的旧条目不动，避免改掉忽略记录用的 id。
/// 只插入标记行，其余字节保持原样。返回是否写了盘。
pub(crate) fn stamp_undated_inbox(root: &Path, day: &str) -> Result<bool, String> {
    let day = validated_batch_date(day).ok_or_else(|| format!("巡检日期无效: {day}"))?;
    let Some(text) = read_text_inside(root, "notes/inbox.md")? else {
        return Ok(false);
    };
    let entries = parse_inbox_entries_with_cap(&text, false);
    if entries.is_empty() || entries.iter().all(|e| e.date.is_some()) {
        return Ok(false);
    }
    let marker = format!("<!-- watch-run: {day} -->\n");
    let mut out = String::with_capacity(text.len() + marker.len() * 2);
    let mut line_start = 0usize;
    let mut covered = false;
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i <= bytes.len() {
        let at_end = i == bytes.len();
        let at_nl = !at_end && bytes[i] == b'\n';
        if at_end || at_nl {
            let line = &text[line_start..i];
            let trimmed = line.trim();
            let is_batch =
                trimmed.starts_with("<!-- watch-run:") || parse_batch_heading(line).is_some();
            if is_batch {
                covered = true;
            } else if line.starts_with("## ") && !covered {
                out.push_str(&marker);
                covered = true;
            }
            out.push_str(line);
            if at_nl {
                out.push('\n');
            }
            line_start = i + 1;
        }
        if at_end {
            break;
        }
        i += 1;
    }
    if out == text {
        return Ok(false);
    }
    write_text_inside(root, "notes/inbox.md", &out)?;
    Ok(true)
}

fn validated_batch_date(day: &str) -> Option<String> {
    if day.len() != 10
        || day.as_bytes().iter().enumerate().any(|(i, b)| {
            if i == 4 || i == 7 {
                *b != b'-'
            } else {
                !b.is_ascii_digit()
            }
        })
    {
        return None;
    }
    chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    Some(day.to_string())
}

/// 只认旧版明确的巡检标题，不把论文发表日期或普通日期标题当成发现日期。
fn parse_batch_heading(line: &str) -> Option<&str> {
    let heading = line
        .trim()
        .strip_prefix("### ")
        .or_else(|| line.trim().strip_prefix("## "))?;
    let (day, rest) = heading.split_once(char::is_whitespace)?;
    if day.len() != 10 || !day.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return None;
    }
    let suffix = rest.trim_start().strip_prefix("巡检")?;
    if suffix.is_empty() || suffix.starts_with(['（', '(', ' ', '\t']) {
        Some(day)
    } else {
        None
    }
}

/// 字段行：`- 标签：值`（全角/半角冒号都收），返回 (标签, 值)
fn parse_field_line(line: &str) -> Option<(&str, &str)> {
    let body = line.trim_start().strip_prefix("- ")?;
    let pos = body.find(['：', ':'])?;
    let (k, rest) = body.split_at(pos);
    // 全角「：」是 3 字节，按字符跳过不能按 1 字节切
    let v = &rest[rest.chars().next()?.len_utf8()..];
    Some((k.trim(), v.trim()))
}

/// 来源行值拆分：固定格式 `<来源> — <日期> — <链接或DOI>`，容错处理缺段。
/// 分隔符按 em/en 破折号且空格可有可无（agent 实测会写 `…）— 2026-10-07 — DOI…`），
/// 段内含日期的取**最靠前的完整日期**（`2026-10-06 线上（期号 2026-11）`取 2026-10-06）。
fn split_source_line(value: &str) -> (String, String, Option<String>) {
    let segs: Vec<&str> = value
        .split(['—', '–'])
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    let source = segs.first().copied().unwrap_or("").to_string();
    let mut date: Option<String> = None;
    let mut url = String::new();
    for seg in segs.iter().skip(1) {
        if url.is_empty() && looks_like_link(seg) {
            url = (*seg).to_string();
            continue;
        }
        if date.is_none() {
            if let Some(d) = leading_day(seg) {
                date = Some(d);
            }
        }
    }
    (source, url, date)
}

/// 从段里取最靠前的日期（YYYY-MM-DD / YYYY.M.D / YYYY/M/D，月日缺零也认）；
/// 整段就是日期时原样返回，带尾巴时只取日期部分。
fn leading_day(seg: &str) -> Option<String> {
    let t = seg.trim();
    if looks_like_day(t) {
        return Some(t.split(['T', ' ']).next().unwrap_or(t).trim().to_string());
    }
    // 扫描每个空格分隔的 token：命中第一个像日期的（“2026-10-06 线上（期号 2026-11）”取前者）
    for tok in t.split_whitespace() {
        let cleaned = tok.trim_matches(|c: char| !c.is_ascii_digit() && !matches!(c, '-' | '.' | '/'));
        if !cleaned.is_empty() && looks_like_day(cleaned) {
            return Some(cleaned.to_string());
        }
    }
    None
}

/// 来源行里的日期段：YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD（月日缺零也认）
fn looks_like_day(s: &str) -> bool {
    // 期刊接口可能带 ISO 时间后缀（2026-10-12T09:00:00Z）：日期判定只看 T 前面
    let t = s.trim().split(['T', ' ']).next().unwrap_or("").trim();
    let norm = t.replace(['.', '/'], "-");
    let mut parts = norm.splitn(3, '-');
    let (Some(y), Some(m), rest) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let y_ok = y.len() == 4 && y.chars().all(|c| c.is_ascii_digit());
    let m_ok = (1..=2).contains(&m.len()) && m.chars().all(|c| c.is_ascii_digit());
    let d_ok = match rest {
        Some(d) => (1..=2).contains(&d.len()) && d.chars().all(|c| c.is_ascii_digit()),
        None => true,
    };
    y_ok && m_ok && d_ok
}

fn looks_like_link(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    l.starts_with("http://")
        || l.starts_with("https://")
        || l.starts_with("doi:")
        || l.contains("doi.org")
        || l.contains("arxiv.org")
        || l.starts_with("10.")
}

fn split_keywords(value: &str) -> Vec<String> {
    value
        .split([',', '，', '、'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 解析中的条目（flush 时补 raw_line_range 末行与 id）
struct EntryBuilder {
    title: String,
    start_line: u32,
    last_line: u32,
    date: Option<String>,
    id_date: Option<String>,
    pub_date: Option<String>,
    source: String,
    authors: String,
    abstract_first: String,
    keywords_hit: Vec<String>,
    relevance: String,
    journal: Option<String>,
    zh_summary: String,
    url: String,
}

impl EntryBuilder {
    fn new(title: String, start_line: u32, date: Option<String>, id_date: Option<String>) -> Self {
        Self {
            title,
            start_line,
            last_line: start_line,
            date,
            id_date,
            pub_date: None,
            source: String::new(),
            authors: String::new(),
            abstract_first: String::new(),
            keywords_hit: Vec::new(),
            relevance: String::new(),
            journal: None,
            zh_summary: String::new(),
            url: String::new(),
        }
    }

    fn build(self) -> WatchEntryDto {
        let date = self.date;
        WatchEntryDto {
            id: hash_id("w", &[&self.title, self.id_date.as_deref().unwrap_or("")]),
            title: self.title,
            source: self.source,
            authors: self.authors,
            abstract_first: self.abstract_first,
            keywords_hit: self.keywords_hit,
            // 技能口径：拿不准一律「待确认」；字段缺失同方向回落
            relevance: if self.relevance.is_empty() {
                "待确认".into()
            } else {
                self.relevance
            },
            journal: self.journal,
            zh_summary: self.zh_summary,
            url: self.url,
            pub_date: self.pub_date,
            date,
            raw_line_range: [self.start_line, self.last_line],
            // 期刊指标在 list_watch_entries 列表出口统一 enrichment，解析器不管
            metrics: None,
            explain: None,
        }
    }

    /// 巡检摘要也可能使用二级标题，但不是文献条目。只有至少有一个文献字段时
    /// 才进入雷达；这样解析器与 scheduler 的新增计数保持同一口径。
    fn is_literature_entry(&self) -> bool {
        !self.source.is_empty()
            || !self.authors.is_empty()
            || !self.abstract_first.is_empty()
            || !self.url.is_empty()
            || !self.keywords_hit.is_empty()
            || !self.relevance.is_empty()
            || self.journal.is_some()
            || !self.zh_summary.is_empty()
    }
}

/// 解析 notes/inbox.md 全文为条目表（文件顺序，旧→新）。容错：坏行跳过；
/// 巡检标题/注释划分批次；只有含文献字段的 `## ` 块算条目，缺字段给缺省。
fn parse_inbox_entries_with_cap(text: &str, cap: bool) -> Vec<WatchEntryDto> {
    let mut out: Vec<WatchEntryDto> = Vec::new();
    let mut cur: Option<EntryBuilder> = None;
    let mut cur_batch: Option<String> = None;
    // 旧条目用「标题 + 注释日期」生成忽略 ID；补识别标题日期不能让忽略失效。
    let mut id_batch: Option<String> = None;
    for (idx, line) in text.lines().enumerate() {
        let ln = (idx + 1) as u32;
        let batch_day = line
            .trim()
            .strip_prefix("<!-- watch-run:")
            .and_then(|s| s.strip_suffix("-->"))
            .map(str::trim)
            .or_else(|| parse_batch_heading(line));
        if let Some(day) = batch_day {
            if let Some(b) = cur.take() {
                if b.is_literature_entry() {
                    out.push(b.build());
                }
            }
            cur_batch = validated_batch_date(day);
            if let Some(d) = parse_batch_marker(line) {
                id_batch = Some(d);
            }
            continue;
        }
        if let Some(title) = line.strip_prefix("## ") {
            if let Some(b) = cur.take() {
                if b.is_literature_entry() {
                    out.push(b.build());
                }
            }
            cur = Some(EntryBuilder::new(
                title.trim().to_string(),
                ln,
                cur_batch.clone(),
                id_batch.clone(),
            ));
            continue;
        }
        if let Some(b) = cur.as_mut() {
            if !line.trim().is_empty() {
                b.last_line = ln;
            }
            if let Some((k, v)) = parse_field_line(line) {
                match k {
                    "来源" => {
                        let (source, url, pub_date) = split_source_line(v);
                        b.source = source;
                        b.url = url;
                        if pub_date.is_some() {
                            b.pub_date = pub_date;
                        }
                    }
                    "作者" => b.authors = v.to_string(),
                    "摘要首句" => b.abstract_first = v.to_string(),
                    "命中关键词" => b.keywords_hit = split_keywords(v),
                    "相关性" => b.relevance = v.to_string(),
                    "期刊" => {
                        if !v.is_empty() {
                            b.journal = Some(v.to_string())
                        }
                    }
                    "中文一句话" => b.zh_summary = v.to_string(),
                    _ => {} // 未知字段忽略（前向兼容技能后续加行）
                }
            }
        }
    }
    if let Some(b) = cur.take() {
        if b.is_literature_entry() {
            out.push(b.build());
        }
    }
    // 收件箱只增不改，最新的在文件末尾：超上限砍前面
    if cap && out.len() > MAX_ENTRIES {
        out.drain(..out.len() - MAX_ENTRIES);
    }
    out
}

fn parse_inbox_entries(text: &str) -> Vec<WatchEntryDto> {
    parse_inbox_entries_with_cap(text, true)
}

/// 评审页用：一份收件箱文本里的全部命中，不截断，并带上期刊指标。
pub(crate) fn watch_inbox_from_text(text: &str) -> Vec<WatchEntryDto> {
    let mut entries = parse_inbox_entries_with_cap(text, false);
    for entry in &mut entries {
        let name = match &entry.journal {
            Some(journal) if !journal.trim().is_empty() => journal.as_str(),
            _ => entry.source.as_str(),
        };
        entry.metrics = crate::journal_metrics::lookup(name);
    }
    entries
}

/// 采纳时按评审「排除」决定剔除条目：按解析器同口径的行范围整段删掉被排除的条目，
/// 其余原文保留；条目删空后遗留的批次标记行（其后到下一标记间再无内容）一并清掉。
/// 传入 id 不在本文里的忽略；返回文本保持原结尾换行习惯。
pub(crate) fn drop_inbox_entries(text: &str, excluded_ids: &std::collections::HashSet<&str>) -> String {
    if excluded_ids.is_empty() {
        return text.to_string();
    }
    let mut drop_lines = std::collections::HashSet::new();
    for entry in parse_inbox_entries_with_cap(text, false) {
        if excluded_ids.contains(entry.id.as_str()) {
            for line in entry.raw_line_range[0]..=entry.raw_line_range[1] {
                drop_lines.insert(line);
            }
        }
    }
    if drop_lines.is_empty() {
        return text.to_string();
    }
    let kept: Vec<&str> = text
        .lines()
        .enumerate()
        .filter(|(idx, _)| !drop_lines.contains(&(*idx as u32 + 1)))
        .map(|(_, line)| line)
        .collect();
    // 清掉因此悬空的批次标记：标记行到下一标记行（或文末）之间只剩空行即删
    let mut pruned: Vec<&str> = Vec::with_capacity(kept.len());
    let mut marker_slots: Vec<usize> = Vec::new();
    for line in kept {
        let is_marker = line.trim().starts_with("<!-- watch-run:") || parse_batch_heading(line).is_some();
        if is_marker {
            // 回看已收下的行：上个标记之后若只有空行，标记作废
            if let Some(&slot) = marker_slots.last() {
                if pruned[slot + 1..].iter().all(|l| l.trim().is_empty()) {
                    pruned.drain(slot..);
                }
            }
            marker_slots.clear();
            marker_slots.push(pruned.len());
            pruned.push(line);
            continue;
        }
        pruned.push(line);
    }
    if let Some(&slot) = marker_slots.last() {
        if pruned[slot + 1..].iter().all(|l| l.trim().is_empty()) {
            pruned.drain(slot..);
        }
    }
    let mut result = pruned.join("\n");
    if text.ends_with('\n') {
        result.push('\n');
    }
    result
}

fn is_inbox_batch_line(line: &str) -> bool {
    line.trim().starts_with("<!-- watch-run:") || parse_batch_heading(line).is_some()
}

/// 雷达采纳的收件箱追加段（2026-10-17 审查修复，取代整文件覆盖）：只取本轮新写的文献条目——
/// id 不在起跑线里、没被排除、标题也不在主仓现有条目里（同项目另一条雷达已收进来的不重复）——
/// 连同各自所属的批次标记按原顺序拼起来。主仓现有内容由调用方原样保留；起跑线里的旧条目
/// 即使被改写也不回灌。主仓还没有收件箱时带上 Agent 写的文件头。没有新条目返回 None。
pub(crate) fn inbox_append_delta(
    current: Option<&str>,
    initial: Option<&str>,
    after: &str,
    drop_ids: &std::collections::HashSet<&str>,
) -> Option<String> {
    let old_ids: std::collections::HashSet<String> = initial
        .map(|text| {
            parse_inbox_entries_with_cap(text, false)
                .into_iter()
                .map(|entry| entry.id)
                .collect()
        })
        .unwrap_or_default();
    let mut have_titles: std::collections::HashSet<String> = current
        .map(|text| {
            parse_inbox_entries_with_cap(text, false)
                .into_iter()
                .map(|entry| normalize_title(&entry.title))
                .filter(|t| !t.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let lines: Vec<&str> = after.lines().collect();
    let mut out: Vec<&str> = Vec::new();
    let mut emitted_marker: Option<usize> = None;
    for entry in parse_inbox_entries_with_cap(after, false) {
        if old_ids.contains(&entry.id) || drop_ids.contains(entry.id.as_str()) {
            continue;
        }
        let norm = normalize_title(&entry.title);
        if !norm.is_empty() && !have_titles.insert(norm) {
            continue;
        }
        let start = entry.raw_line_range[0] as usize - 1;
        let end = (entry.raw_line_range[1] as usize - 1).min(lines.len().saturating_sub(1));
        if start > end {
            continue;
        }
        if let Some(marker) = (0..start).rev().find(|&i| is_inbox_batch_line(lines[i])) {
            if emitted_marker != Some(marker) {
                if !out.is_empty() {
                    out.push("");
                }
                out.push(lines[marker]);
                emitted_marker = Some(marker);
            }
        }
        if !out.is_empty() {
            out.push("");
        }
        out.extend_from_slice(&lines[start..=end]);
    }
    if out.is_empty() {
        return None;
    }
    let mut text = out.join("\n");
    if current.is_none_or(|c| c.trim().is_empty()) {
        let head_end = lines
            .iter()
            .position(|l| is_inbox_batch_line(l) || l.starts_with("## "))
            .unwrap_or(0);
        let head = lines[..head_end].join("\n");
        if !head.trim().is_empty() {
            text = format!("{}\n\n{text}", head.trim_end());
        }
    }
    Some(text)
}

/// 跟进清单的追加段：本轮新写的行（按出现次数与起跑线逐行抵消，旧条目先出现先抵）切成待办，
/// 丢掉被排除条目与主仓里已有同名待办的，悬空的批次分组标题一并去掉。没有新待办返回 None。
pub(crate) fn followup_append_delta(
    current: Option<&str>,
    initial: Option<&str>,
    after: &str,
    drop_titles: &[String],
) -> Option<String> {
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for line in initial.unwrap_or("").lines() {
        *counts.entry(line.trim_end()).or_default() += 1;
    }
    let fresh: Vec<&str> = after
        .lines()
        .filter(|line| match counts.get_mut(line.trim_end()) {
            Some(n) if *n > 0 => {
                *n -= 1;
                false
            }
            _ => true,
        })
        .collect();
    let drop: std::collections::HashSet<String> = drop_titles
        .iter()
        .map(|t| normalize_title(t))
        .filter(|t| !t.is_empty())
        .collect();
    let mut have: std::collections::HashSet<String> = current
        .map(|text| {
            parse_followups(text)
                .into_iter()
                .map(|item| normalize_title(&item.title))
                .filter(|t| !t.is_empty())
                .collect()
        })
        .unwrap_or_default();
    // (行, 是否批次分组标题)
    let mut out: Vec<(&str, bool)> = Vec::new();
    let mut item: Vec<&str> = Vec::new();
    let mut item_title = String::new();
    fn flush<'a>(
        out: &mut Vec<(&'a str, bool)>,
        item: &mut Vec<&'a str>,
        title: &mut String,
        drop: &std::collections::HashSet<String>,
        have: &mut std::collections::HashSet<String>,
    ) {
        if item.is_empty() {
            return;
        }
        let norm = normalize_title(title);
        let keep = norm.is_empty() || (!drop.contains(&norm) && have.insert(norm));
        if keep {
            out.extend(item.iter().map(|l| (*l, false)));
        }
        item.clear();
        title.clear();
    }
    for line in fresh {
        let t = line.trim();
        if let Some(heading) = t.strip_prefix("## ") {
            flush(&mut out, &mut item, &mut item_title, &drop, &mut have);
            let heading = heading.trim();
            if is_batch_heading(heading) {
                out.push((line, true));
            } else {
                item.push(line);
                item_title = heading.to_string();
            }
            continue;
        }
        if let Some(title) = numbered_followup_title(t) {
            flush(&mut out, &mut item, &mut item_title, &drop, &mut have);
            item.push(line);
            item_title = title;
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if let Some(body) = t.strip_prefix("- ") {
            let field = labeled_followup_field(body).is_some();
            if !(indented || field) || item.is_empty() {
                flush(&mut out, &mut item, &mut item_title, &drop, &mut have);
                item.push(line);
                item_title = body
                    .split(" — ")
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                continue;
            }
        }
        if item.is_empty() {
            out.push((line, false));
        } else {
            item.push(line);
        }
    }
    flush(&mut out, &mut item, &mut item_title, &drop, &mut have);
    // 分组标题后面（到下一个分组标题或文末）没有任何内容的，去掉
    let mut pruned: Vec<&str> = Vec::new();
    for (idx, (line, batch)) in out.iter().enumerate() {
        if *batch {
            let has_body = out[idx + 1..]
                .iter()
                .take_while(|(_, b)| !*b)
                .any(|(l, _)| !l.trim().is_empty());
            if !has_body {
                continue;
            }
        }
        pruned.push(line);
    }
    let text = pruned.join("\n");
    let text = text.trim_matches('\n');
    (!text.trim().is_empty()).then(|| text.to_string())
}

/// scheduler 用：lit-watch 运行前后各数一次条目数取差值（`## ` 标题计数，文件缺失按 0）
pub(crate) fn count_inbox_entries(root: &Path) -> u32 {
    let Ok(text) = fs::read_to_string(root.join("notes").join("inbox.md")) else {
        return 0;
    };
    parse_inbox_entries_with_cap(&text, false).len() as u32
}

// ===== 雷达筛选（project.toml 的 lit_watch_filter；前端 lit-watch.ts 同口径镜像） =====

/// 指标是否通过筛选。选了条件但查不到对应指标，就不算通过。
pub(crate) fn metrics_pass_filter(
    metrics: Option<&crate::journal_metrics::JournalMetricsDto>,
    filter: &crate::projects::LitWatchFilterDto,
) -> bool {
    if filter.is_inert() {
        return true;
    }
    let Some(m) = metrics else { return false };
    if let Some(min) = filter.min_if {
        let Some(v) = m
            .impact_factor
            .as_deref()
            .and_then(|s| s.parse::<f64>().ok())
        else {
            return false;
        };
        if v < min {
            return false;
        }
    }
    if let Some(max_q) = filter.max_cas_quartile {
        let Some(q) = m.cas_quartile else { return false };
        if q > max_q {
            return false;
        }
    }
    if filter.top_only && !m.top {
        return false;
    }
    true
}

/// 条目级判定：期刊名取 journal 优先、source 回落（与 list_watch_entries enrichment 同口径）
pub(crate) fn entry_passes_filter(
    e: &WatchEntryDto,
    filter: &crate::projects::LitWatchFilterDto,
) -> bool {
    if filter.is_inert() {
        return true;
    }
    let name = match &e.journal {
        Some(j) if !j.trim().is_empty() => j.as_str(),
        _ => e.source.as_str(),
    };
    let m = crate::journal_metrics::lookup(name);
    metrics_pass_filter(m.as_ref(), filter)
}

/// scheduler 用：数通过筛选的条目数（filter None/全空 = 全部条目，等价 count_inbox_entries）
pub(crate) fn count_inbox_entries_matching(
    root: &Path,
    filter: Option<&crate::projects::LitWatchFilterDto>,
) -> u32 {
    let Some(f) = filter.filter(|f| !f.is_inert()) else {
        return count_inbox_entries(root);
    };
    let Ok(text) = fs::read_to_string(root.join("notes").join("inbox.md")) else {
        return 0;
    };
    parse_inbox_entries_with_cap(&text, false)
        .iter()
        .filter(|e| entry_passes_filter(e, f))
        .count() as u32
}

/// 定时任务成功后给出轻量产物提示，不把可恢复的格式瑕疵伪装成完全正常。
/// 解析规则与 list/count 共用；这里只返回提示，不修改项目文件。
pub(crate) fn output_note(root: &Path) -> Option<String> {
    let text = fs::read_to_string(root.join("notes").join("inbox.md")).ok()?;
    let raw_headers = text.lines().filter(|l| l.starts_with("## ")).count();
    let valid = parse_inbox_entries_with_cap(&text, false).len();
    let ignored = raw_headers.saturating_sub(valid);
    if ignored > 0 {
        return Some(format!("已忽略 {ignored} 个没有文献字段的巡检摘要块"));
    }
    if valid > 0 && !root.join("papers").join("watch-seen.md").is_file() {
        return Some("已写入命中，但未找到 papers/watch-seen.md 去重台账".into());
    }
    None
}

// ===== papers/watch-followup.md 解析 =====

/// 待办三种写法都认（技能只约定「题录 + 缺失原因」，没有钉死排版）：
/// - 一行一条：`- 标题 — 作者 — 链接 — 原因`
/// - `## 标题` 下挂来源/作者/缺失原因（`## …批次` 只是分组，不当标题）
/// - 编号列表：`1. 标题` 下挂缩进的作者行和原因行
fn parse_followups(text: &str) -> Vec<WatchFollowupDto> {
    let mut out = Vec::new();
    let mut block_title: Option<String> = None;
    let mut block_url = String::new();
    let mut block_note: Vec<String> = Vec::new();
    let flush = |out: &mut Vec<WatchFollowupDto>,
                 title: &mut Option<String>,
                 url: &mut String,
                 note: &mut Vec<String>| {
        let Some(title) = title.take() else { return };
        if title.is_empty() {
            return;
        }
        out.push(WatchFollowupDto {
            title,
            url: std::mem::take(url),
            note: note.join(" · "),
        });
        note.clear();
    };
    for raw in text.lines() {
        let t = raw.trim();
        if let Some(heading) = t.strip_prefix("## ") {
            flush(&mut out, &mut block_title, &mut block_url, &mut block_note);
            let heading = heading.trim();
            // 「2026-10-13 批次」是分组，不是一篇论文
            if !heading.is_empty() && !is_batch_heading(heading) {
                block_title = Some(heading.to_string());
            }
            continue;
        }
        if let Some(title) = numbered_followup_title(t) {
            flush(&mut out, &mut block_title, &mut block_url, &mut block_note);
            block_title = Some(title);
            continue;
        }
        let Some(body) = t.strip_prefix("- ") else {
            continue;
        };
        let indented = raw.starts_with(' ') || raw.starts_with('\t');
        // 块内的字段行：有标签的（来源/作者/原因/DOI/期刊），或编号条目下缩进的作者行
        if block_title.is_some() && (indented || labeled_followup_field(body).is_some()) {
            let rest = labeled_followup_field(body).unwrap_or(body);
            let (url, note) = followup_field(rest);
            if block_url.is_empty() && !url.is_empty() {
                block_url = url;
            }
            if !note.is_empty() {
                block_note.push(note);
            }
            continue;
        }
        // 一行一条。若正开着一个还没写完的多行块，先收掉再开新条
        flush(&mut out, &mut block_title, &mut block_url, &mut block_note);
        let segs: Vec<&str> = body
            .split(" — ")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        let Some(title) = segs.first() else { continue };
        let url = segs[1..]
            .iter()
            .copied()
            .find(|s| looks_like_link(s))
            .unwrap_or("")
            .to_string();
        let note = segs[1..]
            .iter()
            .copied()
            .filter(|s| *s != url || url.is_empty())
            .collect::<Vec<_>>()
            .join(" — ");
        out.push(WatchFollowupDto {
            title: (*title).to_string(),
            url,
            note,
        });
    }
    flush(&mut out, &mut block_title, &mut block_url, &mut block_note);
    out
}

/// `## 2026-10-13 批次` / `## 2026-10-13` 是分组标题，不是论文。
fn is_batch_heading(heading: &str) -> bool {
    if heading.contains("批次") {
        return true;
    }
    let date = heading.split_whitespace().next().unwrap_or("");
    let b = date.as_bytes();
    b.len() == 10
        && b.get(4) == Some(&b'-')
        && b.get(7) == Some(&b'-')
        && heading.len() <= date.len() + 6
}

/// `1. 标题` / `12、标题`。点号后必须有空格，避免把 `10.1021/…` 当成编号。
fn numbered_followup_title(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 || i > 3 {
        return None;
    }
    let rest = line[i..].strip_prefix(['.', '、', ')', '）'])?;
    if !rest.starts_with(|c: char| c.is_whitespace()) {
        return None;
    }
    let title = rest.trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

/// `- 来源：…` / `- 缺失原因：…` / `- DOI：…` 的冒号后内容；不是这种字段行返回 None。
fn labeled_followup_field(body: &str) -> Option<&str> {
    const LABELS: [&str; 8] = ["缺失原因", "来源", "作者", "期刊", "原因", "链接", "DOI", "doi"];
    for label in LABELS {
        let Some(rest) = body.strip_prefix(label) else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix(['：', ':']) else {
            continue;
        };
        return Some(rest.trim());
    }
    None
}

/// 字段内容里抽出第一个链接（含 `DOI: 10.xxxx/…`），其余并成备注。
fn followup_field(text: &str) -> (String, String) {
    let url = find_followup_link(text);
    let note = text
        .split(" — ")
        .map(str::trim)
        .filter(|s| !s.is_empty() && !followup_segment_is_link(*s))
        .collect::<Vec<_>>()
        .join(" · ");
    (url, note)
}

fn followup_segment_is_link(seg: &str) -> bool {
    let mut t = seg.trim();
    for label in ["DOI", "doi", "链接", "URL", "url"] {
        if let Some(rest) = t.strip_prefix(label) {
            let rest = rest.trim_start().trim_start_matches([':', '：']).trim();
            if !rest.is_empty() {
                t = rest;
            }
            break;
        }
    }
    let link = find_followup_link(t);
    !link.is_empty() && t.trim_end_matches(['.', ',', ')', '）']).len() <= link.len() + 2
}

/// `https://…` 优先；否则认 `10.xxxx/…` 形式的 DOI，补成 doi.org 链接。
fn find_followup_link(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    for scheme in ["https://", "http://"] {
        if let Some(i) = lower.find(scheme) {
            let rest = &text[i..];
            let end = rest
                .find(|c: char| c.is_whitespace())
                .unwrap_or(rest.len());
            return rest[..end]
                .trim_end_matches(['.', ',', ')', '）', '。'])
                .to_string();
        }
    }
    find_doi(text)
        .map(|doi| format!("https://doi.org/{doi}"))
        .unwrap_or_default()
}

fn find_doi(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 8 <= bytes.len() {
        if text.is_char_boundary(i)
            && bytes[i] == b'1'
            && bytes.get(i + 1) == Some(&b'0')
            && bytes.get(i + 2) == Some(&b'.')
        {
            let mut j = i + 3;
            let mut digits = 0;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                digits += 1;
                j += 1;
            }
            if digits >= 4 && bytes.get(j) == Some(&b'/') {
                let mut k = j + 1;
                while k < bytes.len()
                    && !bytes[k].is_ascii_whitespace()
                    && bytes[k] != b')'
                    && !text[k..].starts_with('）')
                {
                    k += 1;
                }
                let doi = text[i..k].trim_end_matches(['.', ',', '。']);
                if doi.contains('/') {
                    return Some(doi);
                }
            }
        }
        i += 1;
    }
    None
}

// ===== papers/watchlist.md 读写 =====

/// 订阅行：`关键词 — 来源 — 备注`（splitn(3)：备注里再含 " — " 不砍）。
/// 跳过 `#` 注释行与空行；只有一段时只有关键词。
fn parse_subscriptions(text: &str) -> Vec<WatchSubscriptionDto> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let mut parts = t.splitn(3, " — ");
        let keyword = parts.next().unwrap_or("").trim().to_string();
        if keyword.is_empty() {
            continue;
        }
        let sources = parts
            .next()
            .map(|s| {
                s.split([',', '，'])
                    .map(|x| x.trim().to_string())
                    .filter(|x| !x.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let note = parts
            .next()
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        out.push(WatchSubscriptionDto {
            keyword,
            sources,
            note,
        });
    }
    out
}

/// 新建一份订阅（没有旧文件可保留注释）。调度器给隔离树写本次订阅时用。
pub(crate) fn render_watchlist_new(subs: &[WatchSubscriptionDto]) -> String {
    render_watchlist(None, subs)
}

/// 整表写回：保留既有文件里的 `#` 注释行（置前），空关键词条目丢弃；
/// 缺段不补尾巴（无备注写 `关键词 — 来源`，无来源只写 `关键词`）
fn render_watchlist(existing: Option<&str>, subs: &[WatchSubscriptionDto]) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(text) = existing {
        for line in text.lines() {
            let t = line.trim();
            if t.starts_with('#') {
                lines.push(line.to_string());
            }
        }
    } else {
        // 新建文件给格式模板注释，打开不是一片空白
        lines.push("# 文献雷达订阅：每行 关键词 — 来源 — 备注".to_string());
        lines.push("# 来源可省略（缺省 arxiv,openalex,crossref 三库全查）；限定库或加 web 才需要手写本文件。备注可写时间窗（缺省 7 天）与 +bib".to_string());
    }
    for s in subs {
        let keyword = s.keyword.trim();
        if keyword.is_empty() {
            continue;
        }
        let sources = s
            .sources
            .iter()
            .map(|x| x.trim())
            .filter(|x| !x.is_empty())
            .collect::<Vec<_>>()
            .join(",");
        let note = s.note.trim();
        let mut line = keyword.to_string();
        if !sources.is_empty() || !note.is_empty() {
            line.push_str(" — ");
            line.push_str(&sources);
        }
        if !note.is_empty() {
            line.push_str(" — ");
            line.push_str(note);
        }
        lines.push(line);
    }
    let mut text = lines.join("\n");
    text.push('\n');
    text
}

// ===== papers/included.md 读写 =====

fn included_line_id(raw: &str) -> String {
    hash_id("i", &[raw.trim()])
}

/// 精读清单：`标题 — 作者, 年份 — 来源 — 链接/DOI`（splitn(4)，链接段含 " — " 不砍）。
/// 跳过空行与 `#` 注释行；缺段容错为空串。
pub(crate) fn parse_included(text: &str) -> Vec<IncludedEntryDto> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let mut parts = t.splitn(4, " — ");
        let title = parts.next().unwrap_or("").trim().to_string();
        if title.is_empty() {
            continue;
        }
        let seg = |p: Option<&str>| p.unwrap_or("").trim().to_string();
        out.push(IncludedEntryDto {
            line_id: included_line_id(line),
            title,
            authors_year: seg(parts.next()),
            source: seg(parts.next()),
            link: seg(parts.next()),
            raw_line: line.to_string(),
        });
    }
    out
}

/// 规范化标题（去重口径同 lit-search：忽略大小写与标点；is_alphanumeric 天然保留中日韩字符）
pub(crate) fn normalize_title(t: &str) -> String {
    t.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

// ===== PDF 下载 =====

/// PDF 魔数宽松校验：前 1024 字节内含 %PDF- 即认（同 pdf.rs 口径，部分生成器写前导字节）
pub(crate) fn looks_like_pdf(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(1024)];
    head.windows(5).any(|w| w == b"%PDF-")
}

/// 页上标题是否能当文件名：空、纯站名、Chrome PDF 阅读器的 paper / paper-5
/// 都不算——否则入库成 paper-5.pdf，待获取清单短边 ≥8 对不上「已存」
pub(crate) fn is_usable_paper_title(title: &str) -> bool {
    let t = title.trim();
    if t.is_empty() {
        return false;
    }
    let stem = t
        .strip_suffix(".pdf")
        .or_else(|| t.strip_suffix(".PDF"))
        .unwrap_or(t)
        .trim();
    let lower = stem.to_ascii_lowercase();
    let trimmed = lower.trim_end_matches(|c: char| c.is_ascii_digit() || c == '-' || c == '_');
    const GENERIC: &[&str] = &[
        "paper",
        "fulltext",
        "full text",
        "download",
        "pdf",
        "untitled",
        "document",
        "article",
        "main",
        "file",
        "sciencedirect",
        "sciencedirect.com",
        "wiley online library",
        "springerlink",
        "ieee xplore",
        "about:blank",
    ];
    if GENERIC.iter().any(|g| trimmed == *g || lower == *g) {
        return false;
    }
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return false;
    }
    true
}

fn resolved_doi(doi: &str, url: &str) -> String {
    let d = doi.trim();
    if !d.is_empty() {
        if let Some(x) = crate::inst_access::doi_from_url(d) {
            return x;
        }
    }
    if !url.trim().is_empty() {
        if let Some(x) = crate::inst_access::doi_from_url(url) {
            return x;
        }
    }
    String::new()
}

/// 扩展落盘文件名挑选：页上正经标题 → Mesa「浏览器打开」记下的标题（同篇或
/// 页上匿名）→ 页/语境 DOI。空串由 sanitize 回落 paper.pdf。
pub(crate) fn pick_paper_name_hint(
    page_title: &str,
    page_doi: &str,
    page_url: &str,
    ctx_title: &str,
    ctx_doi: &str,
) -> String {
    let page_doi_norm = resolved_doi(page_doi, page_url);
    let ctx_doi_norm = resolved_doi(ctx_doi, "");
    if is_usable_paper_title(page_title) {
        return page_title.trim().to_string();
    }
    let same_paper = !page_doi_norm.is_empty()
        && !ctx_doi_norm.is_empty()
        && page_doi_norm.eq_ignore_ascii_case(&ctx_doi_norm);
    let page_anonymous = page_doi_norm.is_empty();
    if is_usable_paper_title(ctx_title) && (same_paper || page_anonymous) {
        return ctx_title.trim().to_string();
    }
    if !page_doi_norm.is_empty() {
        return page_doi_norm.replace(['/', ':'], "_");
    }
    if !ctx_doi_norm.is_empty() && page_anonymous {
        return ctx_doi_norm.replace(['/', ':'], "_");
    }
    String::new()
}

/// 文件名 sanitize：去路径分隔符/控制字符/Windows 非法字符（三平台口径），
/// 去首尾空白与点，主干限长，非 .pdf 结尾补 .pdf；清完为空回落 "paper.pdf"
fn sanitize_pdf_name(hint: &str) -> String {
    const ILLEGAL: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let cleaned: String = hint
        .chars()
        .filter(|c| !c.is_control() && !ILLEGAL.contains(c))
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c.is_whitespace() || c == '.');
    let stem = if cleaned.to_ascii_lowercase().ends_with(".pdf") {
        &cleaned[..cleaned.len() - 4]
    } else {
        cleaned
    };
    let stem: String = stem.chars().take(FILE_STEM_CAP).collect();
    let stem = stem.trim_end();
    if stem.is_empty() {
        "paper.pdf".to_string()
    } else {
        format!("{stem}.pdf")
    }
}

/// 采纳时把隔离树 papers/ 里主仓还没有的 PDF 拷进项目根并登记。
/// 只收文件头是 %PDF- 的；主仓已有同名文件则跳过，不覆盖人已有的全文。
/// 采纳免费全文：`only` = 本轮新下的文件名（冻结证据记录；旧证据没有记录时 None，回落
/// 「隔离 papers/ 里主仓没有的都拷」）。被排除条目的 PDF（文件名按标题对上）不拷——
/// 2026-10-17 审查修复：旧口径整目录比文件名，排除的照进，主仓里被精读步改名或被人删掉的
/// 每次采纳都会被拷回来。
pub(crate) fn adopt_watch_pdfs(
    isolation: &Path,
    project: &Path,
    only: Option<&[String]>,
    excluded_titles: &[String],
) -> Result<Vec<String>, String> {
    let src_dir = isolation.join("papers");
    if !src_dir.is_dir() {
        return Ok(Vec::new());
    }
    let dest_dir = papers_dir(project)?;
    let wanted: Option<std::collections::HashSet<&str>> =
        only.map(|names| names.iter().map(String::as_str).collect());
    let mut copied = Vec::new();
    let entries = fs::read_dir(&src_dir).map_err(|e| format!("读取隔离 papers/ 失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.to_ascii_lowercase().ends_with(".pdf") {
            continue;
        }
        if wanted.as_ref().is_some_and(|set| !set.contains(name)) {
            continue;
        }
        if meta.len() == 0 || meta.len() > DOWNLOAD_CAP as u64 {
            continue;
        }
        let stem = name.trim_end_matches(".pdf").trim_end_matches(".PDF");
        if excluded_titles
            .iter()
            .any(|title| pdf_name_matches_title(stem, title))
        {
            continue;
        }
        let dest = dest_dir.join(name);
        if dest.exists() {
            continue;
        }
        let bytes = fs::read(&path).map_err(|e| format!("读取 {name} 失败: {e}"))?;
        if !looks_like_pdf(&bytes) {
            continue;
        }
        fs::write(&dest, &bytes).map_err(|e| format!("写入 {name} 失败: {e}"))?;
        register_pdf(project, &dest, stem, "")?;
        copied.push(format!("papers/{name}"));
    }
    copied.sort();
    Ok(copied)
}

/// 雷达按标题给 PDF 起名（可能被截短、去掉标点）：规范化后相等，或一方是另一方的前缀
/// 且前缀够长（≥ 12 个字母数字，免得短名误伤）。
fn pdf_name_matches_title(stem: &str, title: &str) -> bool {
    let a = normalize_title(stem);
    let b = normalize_title(title);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b
        || (a.chars().count() >= 12 && b.starts_with(&a))
        || (b.chars().count() >= 12 && a.starts_with(&b))
}

/// 重名避让：x.pdf → x-2.pdf → x-3.pdf …
fn unique_pdf_path(dir: &Path, name: &str) -> PathBuf {
    let (stem, ext) = name.split_at(name.len() - 4); // 调用方保证以 .pdf 结尾
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    for n in 2..=999u32 {
        let c = dir.join(format!("{stem}-{n}{ext}"));
        if !c.exists() {
            return c;
        }
    }
    // 999 个重名还不行，退回 uuid 文件名（理论到不了）
    dir.join(format!("{stem}-{}{}", uuid::Uuid::new_v4().simple(), ext))
}

/// 网络段（async）：scheme 白名单 → 状态码 → content-length 预估 → 分块读取超限即中止 → 魔数校验
async fn fetch_pdf_bytes(url: &str) -> Result<Vec<u8>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("链接无效: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("仅支持 http/https 链接（收到 {s}）")),
    }
    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        // 部分出版商/预印本站拦无 UA 请求
        .user_agent("Mesa lit-watch (https://github.com/Zeta-Techs/mesa)")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let mut resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status()));
    }
    if let Some(len) = resp.content_length() {
        if len > DOWNLOAD_CAP as u64 {
            return Err(format!(
                "文件超过 60 MB（{:.1} MB），已中止下载",
                len as f64 / 1024.0 / 1024.0
            ));
        }
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载中断: {e}"))? {
        if buf.len() + chunk.len() > DOWNLOAD_CAP {
            return Err("文件超过 60 MB，已中止下载".into());
        }
        buf.extend_from_slice(&chunk);
    }
    if buf.is_empty() {
        return Err("下载内容为空".into());
    }
    if !looks_like_pdf(&buf) {
        return Err("下载内容不是有效的 PDF（可能是需登录的页面或付费墙）".into());
    }
    Ok(buf)
}

/// papers/ 目录：不存在则创建，canonical 双校验在根内（堵 symlink 逃逸）。
/// 必须剥 verbatim：root 来自 ensure_task_project_root（已 strip），裸 canonicalize
/// 的 `\\?\` 与普通根按分量永不相等，下载/登记会误拒。
fn papers_dir(root: &Path) -> Result<PathBuf, String> {
    let papers = root.join("papers");
    fs::create_dir_all(&papers).map_err(|e| format!("创建 papers 目录失败: {e}"))?;
    let canon =
        crate::paths::canonicalize_plain(&papers).map_err(|e| format!("papers 目录无效: {e}"))?;
    if !crate::paths::path_within_path(&canon, root) {
        return Err("papers 指向项目目录之外，拒绝写入".into());
    }
    Ok(canon)
}

fn doi_note(doi: &str) -> String {
    crate::inst_access::doi_from_url(doi)
        .map(|d| format!("doi:{d}"))
        .unwrap_or_default()
}

/// 资源行 upsert：同路径补名/补注（标题可用才覆盖），无则追加。返回是否变更。
fn upsert_paper_resource(
    cfg: &mut crate::projects::ProjectConfigDto,
    rel: &str,
    display: &str,
    note: &str,
    identity_usable: bool,
) -> bool {
    let mut changed = false;
    if let Some(r) = cfg.resources.iter_mut().find(|r| r.path == rel) {
        if identity_usable && !is_usable_paper_title(&r.name) {
            r.name = display.to_string();
            changed = true;
        }
        if r.note.is_empty() && !note.is_empty() {
            r.note = note.to_string();
            changed = true;
        }
    } else {
        cfg.resources.push(crate::projects::ResourceDto {
            name: display.to_string(),
            path: rel.to_string(),
            kind: "paper".into(),
            readonly: false,
            note: note.to_string(),
        });
        changed = true;
    }
    changed
}

// ===== PDF 资源登记的相位感知：流程期间暂缓，收尾回放 =====

const PENDING_REGISTRATIONS_REL: &str = ".ccode/pending-registrations.json";

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PendingRegistration {
    path: String,
    name: String,
    note: String,
}

fn read_pending_registrations(root: &Path) -> Vec<PendingRegistration> {
    read_text_inside(root, PENDING_REGISTRATIONS_REL)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// 暂缓登记（gitignored 台账，按 path 覆盖去重——stamp_paper_identity 后来的
/// 更好标题会顶掉先记的通用名）。
fn defer_pdf_registration(root: &Path, rel: &str, display: &str, note: &str) -> Result<(), String> {
    let mut rows = read_pending_registrations(root);
    let row = PendingRegistration {
        path: rel.to_string(),
        name: display.to_string(),
        note: note.to_string(),
    };
    if let Some(existing) = rows.iter_mut().find(|r| r.path == row.path) {
        *existing = row;
    } else {
        rows.push(row);
    }
    let text = serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())?;
    write_text_inside(root, PENDING_REGISTRATIONS_REL, &format!("{text}\n"))
}

/// 回放暂缓登记（项目打开 / 工作区归档时调用；best-effort，失败记日志不留半截状态）。
pub(crate) fn replay_pending_registrations(root: &Path) {
    let rows = read_pending_registrations(root);
    if rows.is_empty() {
        return;
    }
    let result = (|| -> Result<(), String> {
        let mut cfg = crate::projects::read_config_at(root).config;
        let mut changed = false;
        for row in &rows {
            changed |= upsert_paper_resource(&mut cfg, &row.path, &row.name, &row.note, true);
        }
        if changed {
            crate::projects::write_config_at(root, &cfg)?;
        }
        // 回放成功即清账（目标 PDF 已不在的行也一并清——upsert 只是无害的清单行）
        write_text_inside(root, PENDING_REGISTRATIONS_REL, "[]\n")?;
        Ok(())
    })();
    if let Err(e) = result {
        crate::logbuf::record("warn", "lit_watch", &format!("回放暂缓登记失败：{e}"));
    }
}

/// 把 papers/ 里已存在的 PDF 登记进 project.toml 的 [[resources]]（type="paper"；
/// path 存相对项目根。identity 是文献标题——文件名可以是 paper-5.pdf，清单靠
/// name/note 认「已存」，不靠文件名）
fn register_pdf(
    root: &Path,
    target: &Path,
    identity: &str,
    doi: &str,
) -> Result<DownloadedPaperDto, String> {
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or("PDF 文件名无效")?;
    let stem = Path::new(&file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_name.clone());
    let rel = format!("papers/{file_name}");
    let display = if is_usable_paper_title(identity) {
        identity.trim().to_string()
    } else {
        stem.clone()
    };
    let note = doi_note(doi);
    let mut cfg = crate::projects::read_config_at(root).config;
    let changed = upsert_paper_resource(&mut cfg, &rel, &display, &note, is_usable_paper_title(identity));
    if changed {
        // 相位感知（2026-10-13）：项目有 active/creating 工作区（流程进行中）时不写
        // project.toml——那会弄脏主仓拦住合并；改记 gitignored 待登记台账，收尾回放。
        if crate::workspaces::project_has_active_workspace(root) {
            defer_pdf_registration(root, &rel, &display, &note)?;
        } else {
            crate::projects::write_config_at(root, &cfg)?;
        }
    }
    Ok(DownloadedPaperDto {
        path: target.to_string_lossy().into_owned(),
        name: display,
        dedup: false,
    })
}

/// 扩展落盘后主程序回执监听调用：把打开那篇的标题/DOI 写到资源，通用文件名
/// （paper-5.pdf）改成标题。返回最终文件名供清单立刻显示。
pub(crate) fn stamp_paper_identity(
    root: &str,
    saved: &str,
    title: &str,
    doi: &str,
) -> Option<String> {
    if root.trim().is_empty() || saved.trim().is_empty() {
        return None;
    }
    let root = Path::new(root);
    let name = saved.trim();
    let fname = if name.to_ascii_lowercase().ends_with(".pdf") {
        name.to_string()
    } else {
        format!("{name}.pdf")
    };
    if !root.join("papers").join(&fname).is_file() {
        return None;
    }
    Some(apply_title_filename(root, &fname, title, doi))
}

/// 勘误/更正单页：Wiley 等把 CORRECTION 打在首页正文之前。
/// 只看第一个文本流开始前的字面量，正文里后部提到 correction 不算。
fn pdf_looks_like_correction(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(48 * 1024)];
    let upper: Vec<u8> = head.iter().map(|b| b.to_ascii_uppercase()).collect();
    let Some(at) = upper.windows(10).position(|w| w == b"CORRECTION") else {
        return false;
    };
    let stream = upper.windows(7).position(|w| w == b"STREAM\n" || w == b"STREAM\r");
    stream.is_none_or(|s| at < s)
}

/// 同一篇再下一份：已有的是勘误、新的是正文，用正文换掉勘误。两份都是勘误或都是正文则另存。
fn replace_correction_with_article(papers: &Path, bytes: &[u8]) -> Option<PathBuf> {
    if pdf_looks_like_correction(bytes) {
        return None;
    }
    let rd = fs::read_dir(papers).ok()?;
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.extension().is_some_and(|x| x.eq_ignore_ascii_case("pdf")) {
            continue;
        }
        let Ok(have) = fs::read(&path) else { continue };
        if !pdf_looks_like_correction(&have) {
            continue;
        }
        if fs::write(&path, bytes).is_ok() {
            return Some(path);
        }
    }
    None
}

/// 字节级查重：同尺寸 + md5 相同即认同一份（先比尺寸省哈希；papers/ 文件量
/// 级下全扫可接受）。命中返回已有文件路径——重复导入不落第二份副本
fn find_duplicate_pdf(papers: &Path, bytes: &[u8]) -> Option<PathBuf> {
    if bytes.is_empty() {
        return None;
    }
    let rd = fs::read_dir(papers).ok()?;
    for entry in rd.flatten() {
        let p = entry.path();
        let is_pdf = p.extension().is_some_and(|x| x.eq_ignore_ascii_case("pdf"));
        if !is_pdf {
            continue;
        }
        let Ok(meta) = fs::metadata(&p) else { continue };
        if meta.len() != bytes.len() as u64 {
            continue;
        }
        let Ok(have) = fs::read(&p) else { continue };
        if md5::compute(&have) == md5::compute(bytes) {
            return Some(p);
        }
    }
    None
}

fn paper_rel(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!("papers/{name}")
}

/// 已有副本是 paper / paper-5 这种空标题名、这次有正经标题：改名让清单能对上已存
fn rename_generic_duplicate(
    root: &Path,
    papers: &Path,
    dup: &Path,
    file_name_hint: &str,
) -> Result<Option<PathBuf>, String> {
    let dup_stem = dup
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if is_usable_paper_title(&dup_stem) || !is_usable_paper_title(file_name_hint) {
        return Ok(None);
    }
    let name = sanitize_pdf_name(file_name_hint);
    let target = unique_pdf_path(papers, &name);
    if target == dup {
        return Ok(None);
    }
    fs::rename(dup, &target).map_err(|e| format!("更正 PDF 文件名失败: {e}"))?;
    let old_rel = paper_rel(dup);
    let new_rel = paper_rel(&target);
    let new_stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut cfg = crate::projects::read_config_at(root).config;
    let mut changed = false;
    for r in cfg.resources.iter_mut() {
        if r.path == old_rel {
            r.path = new_rel.clone();
            r.name = new_stem.clone();
            changed = true;
        }
    }
    if changed {
        crate::projects::write_config_at(root, &cfg)?;
    }
    Ok(Some(target))
}

/// 通用文件名（paper / paper-5）有了文献标题就改名；返回最终文件名
fn apply_title_filename(root: &Path, filename: &str, title: &str, doi: &str) -> String {
    let Ok(papers) = papers_dir(root) else {
        return filename.to_string();
    };
    let path = papers.join(filename);
    if !path.is_file() {
        return filename.to_string();
    }
    let path = match rename_generic_duplicate(root, &papers, &path, title) {
        Ok(Some(p)) => p,
        _ => path,
    };
    let _ = register_pdf(root, &path, title, doi);
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| filename.to_string())
}

/// 落盘 + 资源登记（sync）：文件名清理 + 重名避让，写盘后登记；
/// 字节级重复（同一篇重复下载/导入）不写第二份，直接登记并回指已有文件
fn save_and_register_pdf(
    root: &Path,
    file_name_hint: &str,
    bytes: &[u8],
) -> Result<DownloadedPaperDto, String> {
    let papers = papers_dir(root)?;
    if let Some(dup) = find_duplicate_pdf(&papers, bytes) {
        let path = rename_generic_duplicate(root, &papers, &dup, file_name_hint)?.unwrap_or(dup);
        let mut existing = register_pdf(root, &path, file_name_hint, "")?;
        existing.dedup = true;
        return Ok(existing);
    }
    if let Some(path) = replace_correction_with_article(&papers, bytes) {
        return register_pdf(root, &path, file_name_hint, "");
    }
    let name = sanitize_pdf_name(file_name_hint);
    let target = unique_pdf_path(&papers, &name);
    fs::write(&target, bytes).map_err(|e| format!("写入 PDF 失败: {e}"))?;
    register_pdf(root, &target, file_name_hint, "")
}

// ===== 待获取清单进度（StepFlow 逐篇「已存 papers」状态）=====

/// 清单条目探针（title 必填；url 是 DOI/链接，供文件名 DOI 兜底匹配）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToFetchProbe {
    pub title: String,
    #[serde(default)]
    pub url: String,
}

/// 逐条对照 papers/ 已有 PDF，返回同序命中文件名（未命中 None）——
/// 「哪些下载了」不再靠人记。匹配口径：规范化标题互相包含（Zotero 挂附件同款，
/// 短边 ≥8 字符防误命中）为主，DOI 归一后按文件名包含兜底（自动下载常以 DOI 命名）
#[tauri::command]
pub async fn to_fetch_progress(
    project_root: String,
    items: Vec<ToFetchProbe>,
) -> Result<Vec<Option<String>>, String> {
    Ok(to_fetch_progress_inner(Path::new(&project_root), &items))
}

/// DOI 归一（口径同 zotero::doi_norm——那边有用户并行改动，此处小复制不碰它）
fn probe_doi_norm(raw: &str) -> String {
    let mut s = raw.trim().to_ascii_lowercase();
    for p in [
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
        "doi:",
    ] {
        if let Some(rest) = s.strip_prefix(p) {
            s = rest.to_string();
            break;
        }
    }
    s.trim_end_matches(['.', ',', ';']).to_string()
}

fn title_hits(want: &str, have: &str) -> bool {
    let a = normalize_title(want);
    let b = normalize_title(have);
    let short = a.len().min(b.len());
    !a.is_empty() && !b.is_empty() && short >= 8 && (a.contains(&b) || b.contains(&a))
}

/// 出版商下载名常是「期刊 - 年 - 作者 - 截断标题」。截断段够长且是清单标题的开头，算对上。
fn filename_title_hits(want: &str, have: &str) -> bool {
    if title_hits(want, have) {
        return true;
    }
    let want_n = normalize_title(want);
    if want_n.len() < 24 {
        return false;
    }
    let flat = have.replace(['\u{2010}', '\u{2011}', '\u{2013}', '\u{2014}', '\u{2212}', '\u{2010}'], "-");
    flat.split(" - ").any(|part| {
        let bare = part
            .trim()
            .trim_end_matches(".pdf")
            .trim_end_matches(".PDF");
        let bare = bare.trim_end_matches(|c: char| c.is_ascii_whitespace());
        let bare = if let Some(stem) = bare.strip_suffix(')') {
            if let Some((body, n)) = stem.rsplit_once(" (") {
                if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) {
                    body
                } else {
                    bare
                }
            } else {
                bare
            }
        } else {
            bare
        };
        let part_n = normalize_title(bare);
        part_n.len() >= 24 && (want_n.starts_with(&part_n) || part_n.starts_with(&want_n))
    })
}

/// PDF 正文里能抽出的标题线索。文件名是出版商编号时仍能对上清单。
/// 只读前 256KB 的可见文字，不渲染页面。
pub(crate) fn pdf_title_hints(bytes: &[u8]) -> Vec<String> {
    let cap = bytes.len().min(256 * 1024);
    let text = String::from_utf8_lossy(&bytes[..cap]);
    let mut hints = Vec::new();
    for key in ["/Title (", "/Title("] {
        if let Some(start) = text.find(key) {
            let rest = &text[start + key.len()..];
            if let Some(end) = rest.find(')') {
                let title = rest[..end].replace("\\(", "(").replace("\\)", ")");
                if normalize_title(&title).len() >= 8 {
                    hints.push(title);
                }
            }
        }
    }
    let mut visible = String::new();
    let raw = &bytes[..cap];
    let mut i = 0;
    while i < raw.len() {
        let b = raw[i];
        if b == b'(' {
            i += 1;
            let mut word = String::new();
            while i < raw.len() && raw[i] != b')' {
                if raw[i] == b'\\' && i + 1 < raw.len() {
                    i += 1;
                }
                let c = raw[i];
                if c.is_ascii_graphic() || c == b' ' {
                    word.push(c as char);
                }
                i += 1;
                if word.len() > 240 {
                    break;
                }
            }
            if word.len() >= 12 {
                visible.push_str(&word);
                visible.push(' ');
            }
        } else {
            i += 1;
        }
    }
    if normalize_title(&visible).len() >= 8 {
        hints.push(visible);
    }
    hints
}

fn doi_hits(doi: &str, haystack: &str) -> bool {
    if doi.len() < 8 {
        return false;
    }
    let lower = haystack.to_ascii_lowercase();
    let suffix = doi.split_once('/').map(|(_, s)| s).unwrap_or_default();
    lower.contains(doi)
        || lower.contains(&doi.replace('/', "-"))
        || lower.contains(&doi.replace('/', "_"))
        || (suffix.len() >= 8 && lower.contains(suffix))
}

struct PdfFact {
    filename: String,
    path: std::path::PathBuf,
    aliases: Vec<String>,
    /// PDF 正文里的标题。文件名对不上时才读。
    hints: Vec<String>,
    hints_loaded: bool,
    mtime: std::time::SystemTime,
}

fn load_pdf_hints(pdf: &mut PdfFact) {
    if pdf.hints_loaded {
        return;
    }
    pdf.hints_loaded = true;
    pdf.hints = std::fs::read(&pdf.path)
        .map(|bytes| pdf_title_hints(&bytes))
        .unwrap_or_default();
}

fn item_hits_pdf(it: &ToFetchProbe, pdf: &PdfFact) -> bool {
    let doi = probe_doi_norm(&it.url);
    pdf.aliases
        .iter()
        .any(|a| filename_title_hits(&it.title, a) || doi_hits(&doi, a))
        || pdf.hints.iter().any(|hint| title_hits(&it.title, hint))
}

/// PDF 元数据段：开头 256KB + 结尾 512KB。出版商把本篇 DOI / 标题写进 XMP 与文档信息，
/// 这部分不压缩——ACS 在开头，Elsevier（线性化 PDF）在结尾（2026-10-22 实测：3.4MB 的
/// 文件元数据在 3.03MB 处）。正文与参考文献在压缩流里，读不到别篇的 DOI。
const PDF_META_HEAD: usize = 256 * 1024;
const PDF_META_TAIL: usize = 512 * 1024;

fn pdf_meta_window(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() <= PDF_META_HEAD + PDF_META_TAIL {
        return bytes.to_vec();
    }
    let mut out = bytes[..PDF_META_HEAD].to_vec();
    out.extend_from_slice(&bytes[bytes.len() - PDF_META_TAIL..]);
    out
}

/// PDF 元数据段里**本篇自己的** DOI（小写、去尾标点）。只认元数据字段后面的 DOI：
/// XMP `dc:identifier` / `prism:doi` / `crossmark:DOI` / `pdfx:doi`、文档信息 `/doi`。
/// 2026-10-22 实测：ACS 全文把整份参考文献的 DOI 以链接注释（/URI）明文放着，
/// 「文件里出现的 DOI」会把引用了清单里别篇的论文认成那一篇。六份实测全文（ACS、
/// Elsevier×2、Nature、Wiley、Springer）的本篇 DOI 都在这些字段里。
/// 认 PDF 字符串里转义的括号（Elsevier `S1872-2067\(24\)60067-7`），括号按配对收。
pub(crate) fn pdf_meta_dois(bytes: &[u8]) -> Vec<String> {
    const MARKERS: [&str; 7] = [
        "<dc:identifier>",
        "<prism:doi>",
        "<crossmark:doi>",
        "<pdfx:doi>",
        "/doi (",
        "/doi(",
        "/wps-articledoi(",
    ];
    const PREFIXES: [&str; 5] = [
        "doi:",
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
    ];
    let window = pdf_meta_window(bytes);
    let text = String::from_utf8_lossy(&window)
        .to_ascii_lowercase()
        .replace("\\(", "(")
        .replace("\\)", ")");
    let mut out: Vec<String> = Vec::new();
    for marker in MARKERS {
        let mut from = 0;
        while let Some(off) = text[from..].find(marker) {
            let mut at = from + off + marker.len();
            from = at;
            while text.as_bytes().get(at).is_some_and(|c| c.is_ascii_whitespace()) {
                at += 1;
            }
            if let Some(p) = PREFIXES.iter().find(|p| text[at..].starts_with(*p)) {
                at += p.len();
            }
            if let Some(doi) = doi_token_at(&text, at) {
                if !out.contains(&doi) {
                    out.push(doi);
                }
            }
        }
    }
    out
}

/// 从 `at` 起读一个 DOI（须以 10.xxxx/ 开头）。括号按配对收，不配对的右括号是字符串收尾。
fn doi_token_at(text: &str, at: usize) -> Option<String> {
    if !text[at..].starts_with("10.") {
        return None;
    }
    let b = text.as_bytes();
    let mut end = at;
    let mut depth = 0usize;
    while end < b.len() {
        let c = b[end];
        if c == b'(' {
            depth += 1;
        } else if c == b')' {
            if depth == 0 {
                break;
            }
            depth -= 1;
        } else if !(c.is_ascii_alphanumeric() || b"._;/:-".contains(&c)) {
            break;
        }
        end += 1;
    }
    if depth != 0 {
        return None;
    }
    let tok = text[at..end].trim_end_matches(['.', ';', ':', '-']);
    let (prefix, suffix) = tok.split_once('/')?;
    let reg = &prefix[3..];
    ((4..=9).contains(&reg.len()) && reg.bytes().all(|c| c.is_ascii_digit()) && suffix.len() >= 4)
        .then(|| tok.to_string())
}

/// papers/ 里某份 PDF 元数据段的 DOI，按路径 + 修改时间 + 大小缓存：待获取清单开着时
/// 每 2 秒对一次进度，不能每次重读文件
fn pdf_meta_dois_cached(path: &Path) -> Vec<String> {
    use std::io::{Read as _, Seek as _, SeekFrom};
    type Entry = (std::time::SystemTime, u64, Vec<String>);
    static CACHE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<PathBuf, Entry>>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let Ok(meta) = fs::metadata(path) else {
        return Vec::new();
    };
    let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
    let len = meta.len();
    if let Ok(cache) = CACHE.lock() {
        if let Some((m, l, dois)) = cache.get(path) {
            if *m == mtime && *l == len {
                return dois.clone();
            }
        }
    }
    // 只读开头和结尾两段，不读整份
    let read = || -> std::io::Result<Vec<u8>> {
        let mut f = fs::File::open(path)?;
        let mut buf = Vec::new();
        (&mut f).take(PDF_META_HEAD as u64).read_to_end(&mut buf)?;
        if len > (PDF_META_HEAD + PDF_META_TAIL) as u64 {
            f.seek(SeekFrom::End(-(PDF_META_TAIL as i64)))?;
        }
        let mut tail = Vec::new();
        f.read_to_end(&mut tail)?;
        buf.extend_from_slice(&tail);
        Ok(buf)
    };
    let dois = read().map(|buf| pdf_meta_dois(&buf)).unwrap_or_default();
    if let Ok(mut cache) = CACHE.lock() {
        if cache.len() > 512 {
            cache.clear();
        }
        cache.insert(path.to_path_buf(), (mtime, len, dois.clone()));
    }
    dois
}

fn to_fetch_progress_inner(root: &Path, items: &[ToFetchProbe]) -> Vec<Option<String>> {
    to_fetch_progress_with(root, items, &crate::download_inbox::catch_idents())
}

fn to_fetch_progress_with(
    root: &Path,
    items: &[ToFetchProbe],
    catches: &[crate::download_inbox::CatchIdent],
) -> Vec<Option<String>> {
    let papers = root.join("papers");
    let cfg = crate::projects::read_config_at(root).config;
    let mut pdfs: Vec<PdfFact> = std::fs::read_dir(&papers)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().into_string().ok()?;
                    if !name.to_ascii_lowercase().ends_with(".pdf") {
                        return None;
                    }
                    let stem = name.trim_end_matches(".pdf").trim_end_matches(".PDF");
                    let rel = format!("papers/{name}");
                    let mut aliases = vec![name.clone(), stem.to_string()];
                    if let Some(r) = cfg.resources.iter().find(|r| r.path == rel) {
                        if !r.name.is_empty() {
                            aliases.push(r.name.clone());
                        }
                        if !r.note.is_empty() {
                            aliases.push(r.note.clone());
                        }
                    }
                    let mtime = e
                        .metadata()
                        .and_then(|m| m.modified())
                        .unwrap_or(std::time::UNIX_EPOCH);
                    Some(PdfFact {
                        filename: name,
                        path: e.path(),
                        aliases,
                        hints: Vec::new(),
                        hints_loaded: false,
                        mtime,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    pdfs.sort_by(|a, b| a.filename.cmp(&b.filename));
    let mut taken = std::collections::HashSet::new();
    let mut out: Vec<Option<String>> = items
        .iter()
        .map(|it| {
            let hit = pdfs.iter().position(|p| {
                !taken.contains(&p.filename)
                    && p.aliases.iter().any(|alias| {
                        filename_title_hits(&it.title, alias) || doi_hits(&probe_doi_norm(&it.url), alias)
                    })
            });
            match hit {
                Some(pos) => {
                    taken.insert(pdfs[pos].filename.clone());
                    Some(apply_title_filename(
                        root,
                        &pdfs[pos].filename,
                        &it.title,
                        &it.url,
                    ))
                }
                None => None,
            }
        })
        .collect();
    // 文件名对不上的：看 PDF 开头的 DOI（2026-10-22：ACS 存名 cs2c00851.pdf，人拖进 papers/ 后
    // 一直不亮「已存」）。只读开头 256KB、按文件缓存；正文标题仍只在拖进清单时读
    for (i, it) in items.iter().enumerate() {
        if out[i].is_some() {
            continue;
        }
        let doi = probe_doi_norm(&it.url);
        if doi.len() < 8 || !doi.starts_with("10.") {
            continue;
        }
        let hit = pdfs.iter().position(|p| {
            !taken.contains(&p.filename) && pdf_meta_dois_cached(&p.path).iter().any(|t| *t == doi)
        });
        if let Some(pos) = hit {
            taken.insert(pdfs[pos].filename.clone());
            out[i] = Some(apply_title_filename(root, &pdfs[pos].filename, &it.title, &it.url));
        }
    }
    // 清单刷新只对文件名和 DOI（含 PDF 开头的 DOI）。读 PDF 正文标题只发生在人把文件拖进清单时。
    // 文件名是 paper-5 这类对不上标题：用「浏览器打开」登记把最近落下的 PDF 挂到那一行
    let root_s = root.to_string_lossy();
    let mine: Vec<&crate::download_inbox::CatchIdent> = catches
        .iter()
        .filter(|c| crate::paths::same_path(&c.project_root, root_s.as_ref()))
        .collect();
    if mine.is_empty() {
        return out;
    }
    for (i, it) in items.iter().enumerate() {
        if out[i].is_some() {
            continue;
        }
        let doi = probe_doi_norm(&it.url);
        let catch = mine.iter().copied().find(|c| {
            title_hits(&it.title, &c.title)
                || (!doi.is_empty()
                    && !c.doi.is_empty()
                    && (doi.eq_ignore_ascii_case(&c.doi)
                        || doi.contains(&c.doi)
                        || c.doi.contains(&doi)))
        });
        let Some(c) = catch else {
            continue;
        };
        let floor = c
            .opened_at
            .checked_sub(std::time::Duration::from_secs(10))
            .unwrap_or(c.opened_at);
        let mut cands: Vec<&PdfFact> = pdfs
            .iter()
            .filter(|p| !taken.contains(&p.filename) && p.mtime >= floor)
            .collect();
        if cands.is_empty() {
            // 文件已经在 papers/、人回头再点「浏览器」时打开时间晚于 mtime：
            // 未对上的通用文件名只剩一份，挂到这篇
            let generics: Vec<&PdfFact> = pdfs
                .iter()
                .filter(|p| {
                    if taken.contains(&p.filename) {
                        return false;
                    }
                    let stem = p.filename.trim_end_matches(".pdf").trim_end_matches(".PDF");
                    !is_usable_paper_title(stem)
                })
                .collect();
            if generics.len() == 1 {
                cands = generics;
            } else {
                continue;
            }
        }
        cands.sort_by_key(|p| p.mtime);
        let pick = cands
            .iter()
            .rev()
            .find(|p| {
                let stem = p.filename.trim_end_matches(".pdf").trim_end_matches(".PDF");
                !is_usable_paper_title(stem)
            })
            .copied()
            .unwrap_or(*cands.last().unwrap());
        taken.insert(pick.filename.clone());
        out[i] = Some(apply_title_filename(
            root,
            &pick.filename,
            &it.title,
            &it.url,
        ));
    }
    out
}

/// inst_access（窗口中继 PDF）共用的落盘入口：同一 papers/ + 登记口径
pub(crate) fn save_paper_bytes(
    root: &Path,
    file_name_hint: &str,
    bytes: &[u8],
) -> Result<DownloadedPaperDto, String> {
    save_and_register_pdf(root, file_name_hint, bytes)
}

/// 扩展入库：文件名 hint 可空/通用，identity/doi 是清单认「已存」的依据
pub(crate) fn save_paper_bytes_ident(
    root: &Path,
    file_name_hint: &str,
    identity: &str,
    doi: &str,
    bytes: &[u8],
) -> Result<DownloadedPaperDto, String> {
    let hint = if is_usable_paper_title(identity) {
        identity
    } else {
        file_name_hint
    };
    let papers = papers_dir(root)?;
    if let Some(dup) = find_duplicate_pdf(&papers, bytes) {
        let path = rename_generic_duplicate(root, &papers, &dup, hint)?.unwrap_or(dup);
        let mut existing = register_pdf(root, &path, identity, doi)?;
        existing.dedup = true;
        return Ok(existing);
    }
    if let Some(path) = replace_correction_with_article(&papers, bytes) {
        return register_pdf(root, &path, identity, doi);
    }
    let name = sanitize_pdf_name(hint);
    let target = unique_pdf_path(&papers, &name);
    fs::write(&target, bytes).map_err(|e| format!("写入 PDF 失败: {e}"))?;
    register_pdf(root, &target, identity, doi)
}

/// 拖进待获取清单的 PDF：文件名、DOI、PDF 内标题都试。多篇命中时不猜。
pub fn match_dropped_pdf(root: &Path, source: &Path, items: &[ToFetchProbe]) -> Result<usize, String> {
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let stem = source
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let quick = PdfFact {
        filename: name.clone(),
        path: source.to_path_buf(),
        aliases: vec![name.clone(), stem.clone()],
        hints: Vec::new(),
        hints_loaded: true,
        mtime: std::time::SystemTime::UNIX_EPOCH,
    };
    let quick_hits: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, item)| item_hits_pdf(item, &quick))
        .map(|(i, _)| i)
        .collect();
    if !quick_hits.is_empty() {
        return match quick_hits.as_slice() {
            [one] => Ok(*one),
            _ => Err("这份 PDF 对上了多篇。点其中一行的「关联」指定。".into()),
        };
    }
    let bytes = fs::read(source).map_err(|e| format!("读取 PDF 失败: {e}"))?;
    // PDF 开头带的 DOI 先认：出版商编号文件名（ACS cs2c00851.pdf）的 /Title 常是插图的
    // （「cite_this_logo_trans.eps」），按标题对不上
    let head_dois = pdf_meta_dois(&bytes);
    let doi_hits_head: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            let doi = probe_doi_norm(&item.url);
            doi.len() >= 8 && head_dois.iter().any(|t| *t == doi)
        })
        .map(|(i, _)| i)
        .collect();
    if let [one] = doi_hits_head.as_slice() {
        return Ok(*one);
    }
    let fact = PdfFact {
        filename: name.clone(),
        path: source.to_path_buf(),
        aliases: vec![name, stem],
        // 结尾段也读：Elsevier 的文档信息 /Title 在文件末尾
        hints: {
            let mut hints = pdf_title_hints(&bytes);
            if bytes.len() > PDF_META_HEAD {
                hints.extend(pdf_title_hints(&bytes[bytes.len().saturating_sub(PDF_META_TAIL).max(PDF_META_HEAD)..]));
            }
            hints
        },
        hints_loaded: true,
        mtime: std::time::SystemTime::UNIX_EPOCH,
    };
    let hits: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, item)| item_hits_pdf(item, &fact))
        .map(|(i, _)| i)
        .collect();
    match hits.as_slice() {
        [one] => Ok(*one),
        [] => Err("没有对上待获取清单。点这一行的「关联」指定这篇。".into()),
        _ => Err("这份 PDF 对上了多篇。点其中一行的「关联」指定。".into()),
    }
}

#[tauri::command]
pub async fn match_dropped_paper(
    project_root: String,
    source_path: String,
    items: Vec<ToFetchProbe>,
) -> Result<DownloadedPaperDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        let src = PathBuf::from(crate::sessions::expand_tilde(&source_path));
        let index = match_dropped_pdf(&root, &src, &items)?;
        let title = items[index].title.clone();
        attach_pdf_at(&root, &source_path, &title)
    })
    .await
    .map_err(|e| format!("匹配 PDF 失败: {e}"))?
}

/// 关联本地 PDF（sync）：用户手动下载的 PDF 复制进 papers/ 并按标题登记。
/// 源文件校验同下载口径（.pdf 扩展名 + %PDF- 魔数 + 60MB 上限），复制而非移动。
fn attach_pdf_at(
    root: &Path,
    source_path: &str,
    title: &str,
) -> Result<DownloadedPaperDto, String> {
    let src = PathBuf::from(crate::sessions::expand_tilde(source_path));
    let meta = fs::metadata(&src).map_err(|e| format!("源文件不可读: {e}"))?;
    if !meta.is_file() {
        return Err("选择的不是文件".into());
    }
    if meta.len() > DOWNLOAD_CAP as u64 {
        return Err(format!(
            "文件超过 60 MB（{:.1} MB）",
            meta.len() as f64 / 1024.0 / 1024.0
        ));
    }
    let is_pdf_ext = src
        .extension()
        .is_some_and(|e| e.to_ascii_lowercase() == "pdf");
    if !is_pdf_ext {
        return Err("请选择 PDF 文件".into());
    }
    let mut head = [0u8; 1024];
    let n = {
        use std::io::Read as _;
        fs::File::open(&src)
            .and_then(|mut f| f.read(&mut head))
            .map_err(|e| format!("读取源文件失败: {e}"))?
    };
    if !looks_like_pdf(&head[..n]) {
        return Err("所选文件不是有效的 PDF".into());
    }
    let papers = papers_dir(root)?;
    let target = unique_pdf_path(&papers, &sanitize_pdf_name(title));
    fs::copy(&src, &target).map_err(|e| format!("复制 PDF 失败: {e}"))?;
    register_pdf(root, &target, title, "")
}

// ===== 快筛解读缓存（.ccode/watch-explains.json） =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchExplainItem {
    title: String,
    text: String,
    saved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WatchExplainsFile {
    #[serde(default)]
    items: BTreeMap<String, WatchExplainItem>,
}

fn read_explains_file(root: &Path) -> Result<WatchExplainsFile, String> {
    match read_text_inside(root, EXPLAINS_REL)? {
        None => Ok(WatchExplainsFile::default()),
        Some(text) if text.trim().is_empty() => Ok(WatchExplainsFile::default()),
        Some(text) => {
            serde_json::from_str(&text).map_err(|e| format!("解读缓存损坏（{EXPLAINS_REL}）: {e}"))
        }
    }
}

fn attach_explains(root: &Path, entries: &mut [WatchEntryDto]) {
    let Ok(file) = read_explains_file(root) else {
        return;
    };
    for e in entries {
        if let Some(item) = file.items.get(&normalize_title(&e.title)) {
            let t = item.text.trim();
            if !t.is_empty() {
                e.explain = Some(item.text.clone());
            }
        }
    }
}

fn clip_explain_text(text: &str) -> String {
    let t = text.trim();
    let chars: Vec<char> = t.chars().collect();
    if chars.len() <= EXPLAIN_TEXT_CAP {
        t.to_string()
    } else {
        chars[..EXPLAIN_TEXT_CAP].iter().collect()
    }
}

fn save_explain_at(root: &Path, title: &str, text: &str) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("标题不能为空".into());
    }
    let text = clip_explain_text(text);
    if text.is_empty() {
        return Err("解读内容为空".into());
    }
    let mut file = read_explains_file(root)?;
    let key = normalize_title(title);
    file.items.insert(
        key,
        WatchExplainItem {
            title: title.to_string(),
            text,
            saved_at: chrono::Utc::now().to_rfc3339(),
        },
    );
    if file.items.len() > EXPLAIN_ITEMS_CAP {
        let mut keys: Vec<(String, String)> = file
            .items
            .iter()
            .map(|(k, v)| (k.clone(), v.saved_at.clone()))
            .collect();
        keys.sort_by(|a, b| a.1.cmp(&b.1));
        let drop_n = file.items.len() - EXPLAIN_ITEMS_CAP;
        for (k, _) in keys.into_iter().take(drop_n) {
            file.items.remove(&k);
        }
    }
    let body =
        serde_json::to_string_pretty(&file).map_err(|e| format!("序列化解读缓存失败: {e}"))?;
    write_text_inside(root, EXPLAINS_REL, &body)
}

// ===== Tauri commands =====

/// 已采纳进主仓、但收件箱漏写批次标记时，打开雷达用那次成功巡检的完成日补上。
/// 只在全部条目都缺日期时写：混有已标记批次时不猜哪几条属于哪一次。
fn backfill_missing_batch(root: &Path) -> Result<(), String> {
    let Some(text) = read_text_inside(root, "notes/inbox.md")? else {
        return Ok(());
    };
    let entries = parse_inbox_entries_with_cap(&text, false);
    if entries.is_empty() || entries.iter().any(|e| e.date.is_some()) {
        return Ok(());
    }
    let Some(day) = latest_adopted_watch_day(root) else {
        return Ok(());
    };
    stamp_undated_inbox(root, &day)?;
    Ok(())
}

fn latest_adopted_watch_day(root: &Path) -> Option<String> {
    let path = crate::dirs::config_dir()?.join("ccode").join("schedules.json");
    let text = std::fs::read_to_string(path).ok()?;
    let list: Vec<crate::scheduler::Schedule> = serde_json::from_str(&text).ok()?;
    let root_s = root.to_string_lossy();
    let mut best: Option<(String, String)> = None;
    for task in list {
        if task.skill != "lit-watch" {
            continue;
        }
        if !crate::paths::same_path(&task.project_root, root_s.as_ref()) {
            continue;
        }
        for rec in task.history {
            if rec.status != "ok" || !rec.adopted || rec.new_entries.unwrap_or(0) == 0 {
                continue;
            }
            let when = rec.finished_at.clone().unwrap_or(rec.at);
            let Some(day) = shanghai_calendar_day(&when) else {
                continue;
            };
            if best.as_ref().map(|(w, _)| when > *w).unwrap_or(true) {
                best = Some((when, day));
            }
        }
    }
    best.map(|(_, day)| day)
}

/// 人手补记：全部条目都缺巡检日期时，按给出的巡检日写一行批次标记。
/// 已有任一条带日期则不写，避免把不同批次归到同一天。
#[tauri::command]
pub async fn repair_watch_batch_dates(project_root: String, day: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        let Some(text) = read_text_inside(&root, "notes/inbox.md")? else {
            return Ok(false);
        };
        let entries = parse_inbox_entries_with_cap(&text, false);
        if entries.is_empty() || entries.iter().any(|e| e.date.is_some()) {
            return Ok(false);
        }
        stamp_undated_inbox(&root, &day)
    })
    .await
    .map_err(|e| format!("补巡检日期失败: {e}"))?
}

#[tauri::command]
pub async fn list_watch_entries(project_root: String) -> Result<WatchInboxDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        // 漏写批次的已采纳巡检：打开时补一行，趋势才能归周。写失败仍按原文件展示。
        if let Err(e) = backfill_missing_batch(&root) {
            crate::logbuf::record("warn", "lit-watch", &format!("补巡检批次日期失败: {e}"));
        }
        let mut entries = match read_text_inside(&root, "notes/inbox.md")? {
            Some(text) => parse_inbox_entries(&text),
            None => Vec::new(),
        };
        // 期刊指标徽章 enrichment：期刊字段（Some 且非空）优先，否则来源行第一段
        // （arxiv 这类查不到自然 miss）；表未下载时 lookup 恒 None，静默无徽章
        for e in &mut entries {
            let name = match &e.journal {
                Some(j) if !j.trim().is_empty() => j.as_str(),
                _ => e.source.as_str(),
            };
            e.metrics = crate::journal_metrics::lookup(name);
        }
        attach_explains(&root, &mut entries);
        let followups = match read_text_inside(&root, "papers/watch-followup.md")? {
            Some(text) => parse_followups(&text),
            None => Vec::new(),
        };
        Ok(WatchInboxDto { entries, followups })
    })
    .await
    .map_err(|e| format!("读取文献收件箱失败: {e}"))?
}

#[tauri::command]
pub async fn save_watch_explain(
    project_root: String,
    title: String,
    text: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        save_explain_at(&root, &title, &text)
    })
    .await
    .map_err(|e| format!("保存解读失败: {e}"))?
}

/// 一个巡检任务自己的订阅：`.ccode/watch/<任务id>/watchlist.md`。
/// 不再读项目根 papers/watchlist.md——那份是旧的共享清单。
pub(crate) fn schedule_watchlist_rel(schedule_id: &str) -> Result<String, String> {
    if !crate::scheduler::schedule_id_ok(schedule_id) {
        return Err("非法的定时任务 id".into());
    }
    Ok(format!(".ccode/watch/{schedule_id}/watchlist.md"))
}

pub(crate) fn read_schedule_subscriptions(
    root: &Path,
    schedule_id: &str,
) -> Result<Vec<WatchSubscriptionDto>, String> {
    let rel = schedule_watchlist_rel(schedule_id)?;
    match read_text_inside(root, &rel)? {
        Some(text) => Ok(parse_subscriptions(&text)),
        None => Ok(Vec::new()),
    }
}

pub(crate) fn write_schedule_subscriptions(
    root: &Path,
    schedule_id: &str,
    subs: &[WatchSubscriptionDto],
) -> Result<(), String> {
    let rel = schedule_watchlist_rel(schedule_id)?;
    let existing = read_text_inside(root, &rel)?;
    let text = render_watchlist(existing.as_deref(), subs);
    write_text_inside(root, &rel, &text)
}

/// 删任务时清掉这一份。目录里只有 watchlist，整个目录一起去掉。
pub(crate) fn delete_schedule_subscriptions(project_root: &str, schedule_id: &str) {
    let Ok(root) = (if cfg!(test) {
        Ok(PathBuf::from(project_root))
    } else {
        gated_root(project_root)
    }) else {
        return;
    };
    let Ok(rel) = schedule_watchlist_rel(schedule_id) else {
        return;
    };
    if let Some(dir) = root.join(rel).parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// 旧的项目级 papers/watchlist.md 迁进还没有自己清单的文献雷达任务。
/// 只在第一次读到时搬一次；已经有自己清单的任务不动。搬完旧文件留在原地作备份，不再被读取。
pub(crate) fn adopt_shared_watchlists() -> Result<(), String> {
    let path = crate::dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("schedules.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("读取 schedules.json 失败: {e}")),
    };
    let list: Vec<crate::scheduler::Schedule> =
        serde_json::from_str(&text).map_err(|e| format!("解析 schedules.json 失败: {e}"))?;
    let mut roots: Vec<String> = Vec::new();
    for task in &list {
        if task.skill == "lit-watch" && !roots.iter().any(|r| crate::paths::same_path(r, &task.project_root))
        {
            roots.push(task.project_root.clone());
        }
    }
    for root_s in roots {
        let Ok(root) = gated_root(&root_s) else {
            continue;
        };
        let Some(shared) = read_text_inside(&root, "papers/watchlist.md")? else {
            continue;
        };
        let subs = parse_subscriptions(&shared);
        if subs.is_empty() {
            continue;
        }
        for task in list.iter().filter(|t| {
            t.skill == "lit-watch" && crate::paths::same_path(&t.project_root, &root_s)
        }) {
            if read_schedule_subscriptions(&root, &task.id)?.is_empty()
                && read_text_inside(&root, &schedule_watchlist_rel(&task.id)?)?.is_none()
            {
                write_schedule_subscriptions(&root, &task.id, &subs)?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn list_watch_subscriptions(
    project_root: String,
    schedule_id: String,
) -> Result<Vec<WatchSubscriptionDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        adopt_shared_watchlists()?;
        let root = gated_root(&project_root)?;
        read_schedule_subscriptions(&root, &schedule_id)
    })
    .await
    .map_err(|e| format!("读取订阅清单失败: {e}"))?
}

#[tauri::command]
pub async fn save_watch_subscriptions(
    project_root: String,
    schedule_id: String,
    subs: Vec<WatchSubscriptionDto>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        write_schedule_subscriptions(&root, &schedule_id, &subs)
    })
    .await
    .map_err(|e| format!("写入订阅清单失败: {e}"))?
}

/// 文件不存在才建一份空模板；已存在一个字节都不动。
/// 「编辑源文件」打开前用它保证文件在——曾用「把弹层初始订阅写回去」代替，
/// 从巡检行打开时初始订阅是空的（弹层异步自己读），一点就把已有关键词清光（2026-10-17 实证）。
pub(crate) fn ensure_schedule_watchlist(root: &Path, schedule_id: &str) -> Result<(), String> {
    let rel = schedule_watchlist_rel(schedule_id)?;
    if read_text_inside(root, &rel)?.is_some() {
        return Ok(());
    }
    write_text_inside(root, &rel, &render_watchlist(None, &[]))
}

#[tauri::command]
pub async fn ensure_watch_subscriptions_file(
    project_root: String,
    schedule_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        ensure_schedule_watchlist(&root, &schedule_id)
    })
    .await
    .map_err(|e| format!("准备订阅清单失败: {e}"))?
}

#[tauri::command]
pub async fn list_included_entries(project_root: String) -> Result<Vec<IncludedEntryDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        match read_text_inside(&root, "papers/included.md")? {
            Some(text) => Ok(parse_included(&text)),
            None => Ok(Vec::new()),
        }
    })
    .await
    .map_err(|e| format!("读取精读清单失败: {e}"))?
}

// ===== papers/reading-list.md（积累账，2026-10-13 双台账拍板）=====
// 雷达「加入积累」的唯一落点：gitignored，永不进工作区、永不参与合并；
// 行格式与 included.md 逐字同构（parse_included 直读）。新流程开工时由
// freeze_reading_list_intake 冻结成工作区进料快照，检索步统一去重当进料口。

const READING_LIST_REL: &str = "papers/reading-list.md";

fn reading_list_entries_at(root: &Path) -> Result<Vec<IncludedEntryDto>, String> {
    Ok(match read_text_inside(root, READING_LIST_REL)? {
        Some(text) => parse_included(&text),
        None => Vec::new(),
    })
}

fn add_reading_list_at(
    root: &Path,
    title: &str,
    authors_year: &str,
    source: &str,
    link: &str,
) -> Result<AddIncludedResultDto, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("标题不能为空".into());
    }
    // 去重域 = 积累账自身 + 正典 included.md 两表并集：已在任一账的不重复记
    let want = normalize_title(title);
    for entry in reading_list_entries_at(root)? {
        if normalize_title(&entry.title) == want {
            return Ok(AddIncludedResultDto { added: false });
        }
    }
    if let Some(text) = read_text_inside(root, "papers/included.md")? {
        if parse_included(&text)
            .iter()
            .any(|e| normalize_title(&e.title) == want)
        {
            return Ok(AddIncludedResultDto { added: false });
        }
    }
    fn fill_or_tbd(s: &str) -> &str {
        let s = s.trim();
        if s.is_empty() {
            "待补"
        } else {
            s
        }
    }
    let new_line = format!(
        "{} — {} — {} — {}",
        title,
        fill_or_tbd(authors_year),
        fill_or_tbd(source),
        fill_or_tbd(link)
    );
    let mut text = read_text_inside(root, READING_LIST_REL)?.unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&new_line);
    text.push('\n');
    write_text_inside(root, READING_LIST_REL, &text)?;
    Ok(AddIncludedResultDto { added: true })
}

fn remove_reading_list_at(root: &Path, line_id: &str) -> Result<(), String> {
    let text = read_text_inside(root, READING_LIST_REL)?.ok_or("积累清单不存在")?;
    let mut removed = false;
    let kept: Vec<&str> = text
        .lines()
        .filter(|line| {
            if !removed && included_line_id(line) == line_id {
                removed = true;
                false
            } else {
                true
            }
        })
        .collect();
    if !removed {
        return Err("该行已不存在（清单可能已变动，请刷新后重试）".into());
    }
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    write_text_inside(root, READING_LIST_REL, &out)
}

#[tauri::command]
pub async fn list_reading_list_entries(
    project_root: String,
) -> Result<Vec<IncludedEntryDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        reading_list_entries_at(&root)
    })
    .await
    .map_err(|e| format!("读取积累清单失败: {e}"))?
}

#[tauri::command]
pub async fn add_reading_list_entry(
    project_root: String,
    title: String,
    authors_year: String,
    source: String,
    link: String,
) -> Result<AddIncludedResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        add_reading_list_at(&root, &title, &authors_year, &source, &link)
    })
    .await
    .map_err(|e| format!("追加积累清单失败: {e}"))?
}

#[tauri::command]
pub async fn remove_reading_list_entry(
    project_root: String,
    line_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        remove_reading_list_at(&root, &line_id)
    })
    .await
    .map_err(|e| format!("删除积累清单行失败: {e}"))?
}

/// 开工冻结进料：把项目根积累账非空内容原样复制为工作区 `.ccode/handoff-lit-intake.md`
/// （被 `.ccode/handoff-*.md` 规则忽略，不进提交/合并/交付评审）。agent 读的是开工定格
/// 副本而非活文件——流程期间继续「加入积累」不影响本轮。返回是否生成了快照。
fn freeze_intake_at(root: &Path, worktree: &Path) -> Result<bool, String> {
    if !worktree.is_dir() {
        return Err("工作区目录不存在".into());
    }
    let Some(text) = read_text_inside(root, READING_LIST_REL)? else {
        return Ok(false);
    };
    if text.trim().is_empty() {
        return Ok(false);
    }
    let dest = worktree.join(".ccode").join("handoff-lit-intake.md");
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建工作区 .ccode 失败：{e}"))?;
    }
    crate::profiles::atomic_write(&dest, &text).map_err(|e| format!("写入进料快照失败：{e}"))?;
    Ok(true)
}

#[tauri::command]
pub async fn freeze_reading_list_intake(
    project_root: String,
    worktree_path: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        let worktree = PathBuf::from(crate::sessions::expand_tilde(&worktree_path));
        freeze_intake_at(&root, &worktree)
    })
    .await
    .map_err(|e| format!("冻结进料快照失败: {e}"))?
}

/// 下载文献全文 PDF：网络段 async、落盘与登记段 spawn_blocking（文件操作风格同 pdf.rs）
#[tauri::command]
pub async fn download_paper_pdf(
    project_root: String,
    url: String,
    file_name_hint: String,
) -> Result<DownloadedPaperDto, String> {
    let root = {
        let pr = project_root.clone();
        tauri::async_runtime::spawn_blocking(move || gated_root(&pr))
            .await
            .map_err(|e| format!("校验项目目录失败: {e}"))??
    };
    let bytes = fetch_pdf_bytes(&url).await?;
    tauri::async_runtime::spawn_blocking(move || {
        save_and_register_pdf(&root, &file_name_hint, &bytes)
    })
    .await
    .map_err(|e| format!("保存 PDF 失败: {e}"))?
}

/// fetch_paper_fulltext 返回：落盘信息 + 实际命中的渠道（前端 toast 区分「开放副本/机构通道」）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FetchedFulltextDto {
    pub path: String,
    pub name: String,
    /// direct（开放直链）| oa（合法开放副本）| institutional（机构通道）
    pub via: String,
    /// papers/ 已有同一份（字节级相同），未重复写入
    #[serde(default)]
    pub dedup: bool,
}

/// 全文阶梯的统一目标：裸 DOI（含 `doi:` 前缀）补成 doi.org 落地；http(s) 原样；其余拒绝
fn normalize_fetch_target(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if !t.contains("://") {
        if let Some(doi) = crate::inst_access::doi_from_url(t) {
            return Ok(format!("https://doi.org/{doi}"));
        }
        return Err(format!("仅支持 http(s) 链接或 DOI（收到 {t}）"));
    }
    let parsed = reqwest::Url::parse(t).map_err(|e| format!("链接无效: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(t.to_string()),
        s => Err(format!("仅支持 http/https 链接（收到 {s}）")),
    }
}

/// 全文获取阶梯（2026-09-16「机构访问」拍板形态：人登录一次、系统复用会话）：
/// 1. 开放直链（现有 fetch_pdf_bytes 口径，%PDF- 魔数校验）；
/// 2. DOI → 合法开放副本（Unpaywall/OpenAlex，绿 OA/预印本/仓储）；
/// 3. 机构通道（代理前缀改写 + 会话 Cookie + 落地页 citation_pdf_url 提取）。
/// 只服务 UI 逐篇人工触发（to-fetch 清单/雷达卡「获取全文」钮），scheduler/无头不调用。
async fn fetch_fulltext_bytes(raw_url: &str) -> Result<(Vec<u8>, &'static str), String> {
    let target = normalize_fetch_target(raw_url)?;
    let direct_err = match fetch_pdf_bytes(&target).await {
        Ok(bytes) => return Ok((bytes, "direct")),
        Err(e) => e,
    };
    if let Some(doi) = crate::inst_access::doi_from_url(&target) {
        if let Some((oa_url, _src)) = crate::inst_access::oa_pdf_url_for(&doi).await {
            if let Ok(bytes) = fetch_pdf_bytes(&oa_url).await {
                return Ok((bytes, "oa"));
            }
        }
    }
    let channel = crate::inst_access::InstitutionalChannel::load();
    if channel.active() {
        let via_error = match crate::inst_access::fetch_via_channel(&target, &channel).await {
            Ok(bytes) => return Ok((bytes, "institutional")),
            Err(e) => e,
        };
        return Err(crate::inst_access::institutional_failure_hint(&via_error));
    }
    Err(format!(
        "开放直链不可用（{direct_err}），且未配置机构访问：到设置 → 网络 → 学校图书馆 登录学校账号后重试，或手动下载后用「关联本地 PDF」导入"
    ))
}

/// 逐篇获取全文（付费墙清单/雷达卡「获取全文」）：阶梯见 fetch_fulltext_bytes，
/// 落盘与登记同 download_paper_pdf（papers/ + project.toml，口径 C 原始资料直写项目根）
#[tauri::command]
pub async fn fetch_paper_fulltext(
    project_root: String,
    url: String,
    file_name_hint: String,
) -> Result<FetchedFulltextDto, String> {
    let root = {
        let pr = project_root.clone();
        tauri::async_runtime::spawn_blocking(move || gated_root(&pr))
            .await
            .map_err(|e| format!("校验项目目录失败: {e}"))??
    };
    let (bytes, via) = fetch_fulltext_bytes(&url).await?;
    let saved = tauri::async_runtime::spawn_blocking(move || {
        save_and_register_pdf(&root, &file_name_hint, &bytes)
    })
    .await
    .map_err(|e| format!("保存 PDF 失败: {e}"))??;
    Ok(FetchedFulltextDto {
        path: saved.path,
        name: saved.name,
        via: via.to_string(),
        dedup: saved.dedup,
    })
}

/// 关联本地 PDF（精读清单/新命中的「关联本地 PDF…」）：付费墙等自动下载失败的场景，
/// 用户手动下载后选中文件，一步完成 复制进 papers/ + 登记 project.toml
#[tauri::command]
pub async fn attach_paper_pdf(
    project_root: String,
    source_path: String,
    title: String,
) -> Result<DownloadedPaperDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        attach_pdf_at(&root, &source_path, &title)
    })
    .await
    .map_err(|e| format!("关联 PDF 失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ccode-litwatch-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        // 生产路径下 root 恒为剥过 verbatim 的 canonical（ensure_task_project_root），测试同口径
        crate::paths::canonicalize_plain(&dir).unwrap()
    }

    #[test]
    fn save_paper_bytes_dedups_identical_content() {
        let dir = tmpdir("dedup");
        let bytes = b"%PDF-1.4 fake but identical";
        let a = super::save_paper_bytes(&dir, "First Title", bytes).unwrap();
        assert!(!a.dedup);
        // 同内容再导入：不写第二份，回指已有文件
        let b = super::save_paper_bytes(&dir, "Second Different Title", bytes).unwrap();
        assert!(b.dedup);
        assert_eq!(a.path, b.path);
        // 不同内容正常落新文件
        let c = super::save_paper_bytes(&dir, "Third Title", b"%PDF-1.5 other bytes").unwrap();
        assert!(!c.dedup);
        assert_ne!(a.path, c.path);
        let count = std::fs::read_dir(dir.join("papers"))
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "pdf"))
            .count();
        assert_eq!(count, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn article_replaces_saved_correction_instead_of_keeping_both() {
        let dir = tmpdir("correction");
        let correction = b"%PDF-1.4\n(CORRECTION) Tj\nstream\nThere is an error in the reference list";
        let article = b"%PDF-1.4\nstream\nAmorphous Cobalt Boride as a Highly Efficient Catalyst\n1 Introduction";
        assert!(pdf_looks_like_correction(correction));
        assert!(!pdf_looks_like_correction(article));
        // 正文流里后部出现 CORRECTION 不是勘误单页
        assert!(!pdf_looks_like_correction(
            b"%PDF-1.4\nstream\nAmorphous Cobalt Boride Introduction CORRECTION of a formula"
        ));
        let saved = super::save_paper_bytes(&dir, "Amorphous Cobalt Boride", correction).unwrap();
        assert!(!saved.dedup);
        let again = super::save_paper_bytes(&dir, "Amorphous Cobalt Boride", article).unwrap();
        assert!(!again.dedup);
        assert_eq!(saved.path, again.path);
        let on_disk = std::fs::read(&again.path).unwrap();
        assert!(
            on_disk.windows(16).any(|w| w == b"Cobalt Boride as"),
            "勘误应被正文换掉，实际 {}",
            String::from_utf8_lossy(&on_disk)
        );
        assert!(!on_disk.windows(10).any(|w| w == b"CORRECTION"));
        let count = std::fs::read_dir(dir.join("papers"))
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "pdf"))
            .count();
        assert_eq!(count, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_paper_bytes_renames_generic_duplicate() {
        let dir = tmpdir("rename-generic");
        let bytes = b"%PDF-1.4 same bytes for rename";
        let a = super::save_paper_bytes(&dir, "paper-5", bytes).unwrap();
        assert!(a.name.contains("paper"), "{}", a.name);
        let b = super::save_paper_bytes(
            &dir,
            "Development of a chloride-free dual-salt electrolyte",
            bytes,
        )
        .unwrap();
        assert!(b.dedup);
        assert!(
            b.name.contains("chloride-free"),
            "应改成正经标题，实际 {}",
            b.name
        );
        assert!(!dir.join("papers/paper-5.pdf").exists());
        assert!(dir.join(format!("papers/{}.pdf", b.name)).exists());
        let cfg = crate::projects::read_config_at(&dir).config;
        assert!(
            cfg.resources
                .iter()
                .any(|r| r.path.contains("chloride-free")),
            "{:?}",
            cfg.resources
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stamp_paper_identity_renames_generic_file() {
        let dir = tmpdir("stamp-rename");
        let papers = dir.join("papers");
        fs::create_dir_all(&papers).unwrap();
        fs::write(papers.join("paper-5.pdf"), b"%PDF-1.4 stub").unwrap();
        let got = super::stamp_paper_identity(
            dir.to_str().unwrap(),
            "paper-5",
            "Development of a chloride-free dual-salt electrolyte",
            "10.1016/j.jallcom.2026.190140",
        )
        .unwrap();
        assert!(got.contains("chloride-free"), "{got}");
        assert!(!papers.join("paper-5.pdf").exists());
        assert!(papers.join(&got).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn publisher_truncated_filename_matches_without_reading_pdf() {
        let dir = tmpdir("drop-trunc");
        let pdf = dir.join("Angew Chem Int Ed - 2017 - Park - Boron\u{2010}Dependency of Molybdenum Boride Electrocatalysts for the Hydrogen Evolution (1).pdf");
        std::fs::write(&pdf, b"%PDF-1.4 not read").unwrap();
        let items = vec![ToFetchProbe {
            title: "Boron-Dependency of Molybdenum Boride Electrocatalysts for the Hydrogen Evolution Reaction".into(),
            url: "10.1002/anie.2017".into(),
        }];
        assert_eq!(match_dropped_pdf(&dir, &pdf, &items).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dropped_pdf_matches_title_inside_file_not_filename() {
        let dir = tmpdir("drop-body");
        let pdf = dir.join("1-s2.0-S0000000000000000-main.pdf");
        let body = b"%PDF-1.4\n(Amorphous Cobalt Boride as a Highly Efficient Catalyst for Hydrogen)\n";
        std::fs::write(&pdf, body).unwrap();
        let items = vec![
            ToFetchProbe {
                title: "Unrelated nickel phosphide paper about seawater splitting".into(),
                url: "10.1000/other".into(),
            },
            ToFetchProbe {
                title: "Amorphous Cobalt Boride as a Highly Efficient Catalyst for Hydrogen".into(),
                url: "10.1000/cobalt".into(),
            },
        ];
        assert_eq!(match_dropped_pdf(&dir, &pdf, &items).unwrap(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 2026-10-22 实测 ACS：文件名 cs2c00851.pdf，/Title 是插图的，本篇 DOI 在 XMP 里；
    // 参考文献的 DOI 以链接注释明文放着（这里放一条清单里别篇的），不得认
    const ACS_HEAD: &[u8] = b"%PDF-1.7\n<</Creator(Adobe Illustrator)/Title(cite_this_logo_trans.eps)>>\n<dc:identifier>10.1021/acscatal.2c00851</dc:identifier>\n<</S/URI/URI(https://doi.org/10.1000/other)>>\n";

    #[test]
    fn pdf_meta_dois_reads_own_doi_fields_only() {
        assert_eq!(super::pdf_meta_dois(ACS_HEAD), vec!["10.1021/acscatal.2c00851"]);
        // Nature / Springer：文档信息 /doi 与 dc:identifier 带 doi: / https://doi.org/ 前缀
        let nature = b"%PDF-1.4\n<dc:identifier>doi:10.1038/s41467-023-40972-w</dc:identifier>\n/doi(10.1038/s41467-023-40972-w)\n<prism:doi>10.1007/x</prism:doi>\n";
        assert_eq!(super::pdf_meta_dois(nature), vec!["10.1038/s41467-023-40972-w"]);
        // 不在元数据字段后的 DOI、版本号、小数都不算
        assert!(super::pdf_meta_dois(b"%PDF-1.7 version 10.1 see 10.1021/acscatal.7b02225").is_empty());
        // Elsevier（2026-10-22 实测 main.pdf）：元数据在文件末尾，文档信息里括号转义
        let mut els = b"%PDF-1.7\n".to_vec();
        els.extend(std::iter::repeat_n(b'x', 2 * 1024 * 1024));
        els.extend_from_slice(b"<crossmark:DOI>10.1016/S1872-2067(24)60067-7</crossmark:DOI>\n/doi (10.1016/S1872-2067\\(24\\)60067-7)\n%%EOF\n");
        assert_eq!(super::pdf_meta_dois(&els), vec!["10.1016/s1872-2067(24)60067-7"]);
    }

    #[test]
    fn dropped_and_saved_pdf_match_by_head_doi() {
        let dir = tmpdir("drop-doi");
        let items = vec![
            ToFetchProbe {
                title: "Unrelated nickel phosphide paper about seawater splitting".into(),
                url: "10.1000/other".into(),
            },
            ToFetchProbe {
                title: "Pt–Ru Dimer Electrocatalyst with Electron Redistribution for Hydrogen Evolution Reaction".into(),
                url: "10.1021/acscatal.2c00851".into(),
            },
        ];
        let pdf = dir.join("cs2c00851.pdf");
        std::fs::write(&pdf, ACS_HEAD).unwrap();
        assert_eq!(match_dropped_pdf(&dir, &pdf, &items).unwrap(), 1);
        // 已经躺在 papers/ 里的同一份：清单进度按开头 DOI 亮「已存」
        let papers = dir.join("papers");
        std::fs::create_dir_all(&papers).unwrap();
        std::fs::write(papers.join("cs2c00851.pdf"), ACS_HEAD).unwrap();
        let got = super::to_fetch_progress_with(&dir, &items, &[]);
        assert!(got[0].is_none());
        assert_eq!(got[1].as_deref(), Some("cs2c00851.pdf"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn to_fetch_progress_matches_title_and_doi() {
        let dir = std::env::temp_dir().join(format!(
            "mesa-tofetch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let papers = dir.join("papers");
        std::fs::create_dir_all(&papers).unwrap();
        std::fs::write(
            papers.join("Reactivation of dissolved polysulfides with nitrogen doped graphene decorated carbon cloth as an effective int.pdf"),
            b"%PDF-1.4 stub",
        )
        .unwrap();
        std::fs::write(papers.join("10.1002-idm2.70075.pdf"), b"%PDF-1.4 stub").unwrap();
        std::fs::write(papers.join("mrc.2017.101.pdf"), b"%PDF-1.4 stub").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let r = super::to_fetch_progress_inner(
            Path::new(&root),
            &[
                super::ToFetchProbe {
                    title: "Reactivation of dissolved polysulfides with nitrogen-doped graphene decorated carbon cloth".into(),
                    url: "10.1002/aenm.202300000".into(),
                },
                super::ToFetchProbe {
                    title: "Bridging Fundamentals and Practice".into(),
                    url: "https://doi.org/10.1002/idm2.70075".into(),
                },
                super::ToFetchProbe {
                    title: "Magnesium-sulfur battery: its beginning and recent progress".into(),
                    url: "10.1557/mrc.2017.101".into(),
                },
                super::ToFetchProbe {
                    title: "Not In The List At All".into(),
                    url: "".into(),
                },
            ],
        );
        assert!(r[0].as_deref().unwrap().contains("Reactivation"));
        assert!(r[1].as_deref().unwrap().contains("idm2.70075"));
        assert!(r[2].as_deref().unwrap().contains("mrc.2017.101"));
        assert!(r[3].is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn to_fetch_progress_matches_resource_name_not_filename() {
        // 扩展常落成 paper-5.pdf：清单必须靠资源标题认，不靠文件名
        let dir = tmpdir("tofetch-ident");
        let papers = dir.join("papers");
        fs::create_dir_all(&papers).unwrap();
        let pdf = papers.join("paper-5.pdf");
        fs::write(&pdf, b"%PDF-1.4 stub").unwrap();
        super::register_pdf(
            &dir,
            &pdf,
            "Development of a chloride-free dual-salt electrolyte",
            "10.1016/j.jallcom.2026.190140",
        )
        .unwrap();
        let r = super::to_fetch_progress_inner(
            &dir,
            &[super::ToFetchProbe {
                title: "Development of a chloride-free dual-salt electrolyte for magnesium-sulfur batteries".into(),
                url: "https://doi.org/10.1016/j.jallcom.2026.190140".into(),
            }],
        );
        let got = r[0].as_deref().unwrap();
        assert!(got.contains("chloride-free"), "{got}");
        assert!(!dir.join("papers/paper-5.pdf").exists());
        assert!(dir.join(format!("papers/{got}")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn to_fetch_progress_pending_fallback_generic_filename() {
        let dir = tmpdir("tofetch-pending");
        let papers = dir.join("papers");
        fs::create_dir_all(&papers).unwrap();
        fs::write(papers.join("paper-5.pdf"), b"%PDF-1.4 stub").unwrap();
        let now = std::time::SystemTime::now();
        let catches = vec![crate::download_inbox::CatchIdent {
            project_root: dir.to_string_lossy().into_owned(),
            title: "Development of a chloride-free dual-salt electrolyte".into(),
            doi: "10.1016/j.jallcom.2026.190140".into(),
            opened_at: now - std::time::Duration::from_secs(20),
        }];
        let r = super::to_fetch_progress_with(
            &dir,
            &[super::ToFetchProbe {
                title: "Development of a chloride-free dual-salt electrolyte for magnesium".into(),
                url: "10.1016/j.jallcom.2026.190140".into(),
            }],
            &catches,
        );
        let got = r[0].as_deref().unwrap();
        assert!(got.contains("chloride-free"), "{got}");
        assert!(!dir.join("papers/paper-5.pdf").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn to_fetch_progress_generic_file_still_matches_after_reopen() {
        // 已落 paper-5、人回头再点浏览器：打开时间晚于文件 mtime，仍认这一份
        let dir = tmpdir("tofetch-reopen");
        let papers = dir.join("papers");
        fs::create_dir_all(&papers).unwrap();
        fs::write(papers.join("paper-5.pdf"), b"%PDF-1.4 stub").unwrap();
        let catches = vec![crate::download_inbox::CatchIdent {
            project_root: dir.to_string_lossy().into_owned(),
            title: "Development of a chloride-free dual-salt electrolyte".into(),
            doi: String::new(),
            opened_at: std::time::SystemTime::now() + std::time::Duration::from_secs(60),
        }];
        let r = super::to_fetch_progress_with(
            &dir,
            &[super::ToFetchProbe {
                title: "Development of a chloride-free dual-salt electrolyte for magnesium".into(),
                url: "".into(),
            }],
            &catches,
        );
        let got = r[0].as_deref().unwrap();
        assert!(got.contains("chloride-free"), "{got}");
        assert!(!dir.join("papers/paper-5.pdf").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn papers_dir_strips_verbatim_and_stays_inside() {
        let root = tmpdir("papers-verb");
        let papers = papers_dir(&root).unwrap();
        let text = papers.to_string_lossy();
        assert!(
            !text.starts_with(r"\\?\"),
            "papers_dir 不得返回 verbatim 前缀: {text}"
        );
        assert!(
            crate::paths::path_within_path(&papers, &root),
            "papers 必须落在项目根内: {papers:?} / {root:?}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    const SAMPLE_INBOX: &str = "\
# 文献收件箱

<!-- watch-run: 2026-08-11 -->

## 旧条目没有新增字段
- 来源：arxiv — 2026-08-10 — https://arxiv.org/abs/2608.00001
- 作者：Zhang S, Li M, Wang Q et al.
- 摘要首句：We present a method.
- 命中关键词：perovskite, stability
- 相关性：相关

<!-- watch-run: 2026-08-18 -->

## 完整字段条目
- 来源：期刊 — 2026-08-17 — 10.1000/xyz123
- 作者：Chen L et al.
- 摘要首句：Here we show.
- 命中关键词：solid electrolyte
- 相关性：推荐
- 期刊：Nature Energy
- 中文一句话：提出一种提升固态电解质界面稳定性的方法

坏行不属于任何字段，跳过
- 未知字段：随便什么

## 最小条目
";

    #[test]
    fn parses_full_and_legacy_entries_with_batch_dates() {
        let entries = parse_inbox_entries(SAMPLE_INBOX);
        assert_eq!(entries.len(), 2);
        let legacy = &entries[0];
        assert_eq!(legacy.title, "旧条目没有新增字段");
        assert_eq!(legacy.source, "arxiv");
        assert_eq!(legacy.url, "https://arxiv.org/abs/2608.00001");
        assert_eq!(legacy.authors, "Zhang S, Li M, Wang Q et al.");
        assert_eq!(legacy.abstract_first, "We present a method.");
        assert_eq!(legacy.keywords_hit, vec!["perovskite", "stability"]);
        assert_eq!(legacy.relevance, "相关");
        // 旧条目没有新增字段：journal=None、zh_summary 空串
        assert_eq!(legacy.journal, None);
        assert_eq!(legacy.zh_summary, "");
        // 批次日期归属：第一、二个批次标记
        assert_eq!(legacy.date.as_deref(), Some("2026-08-11"));
        let full = &entries[1];
        assert_eq!(full.journal.as_deref(), Some("Nature Energy"));
        assert_eq!(full.zh_summary, "提出一种提升固态电解质界面稳定性的方法");
        assert_eq!(full.url, "10.1000/xyz123");
        assert_eq!(full.pub_date.as_deref(), Some("2026-08-17"));
        assert_eq!(full.date.as_deref(), Some("2026-08-18"));
        // 旧条目来源行三段同样带发表日期
        assert_eq!(legacy.pub_date.as_deref(), Some("2026-08-10"));
        // 没有任何文献字段的标题块（如巡检摘要）不会进入雷达条目。
        // id 稳定且互不相同
        assert_ne!(legacy.id, full.id);
        assert!(legacy.id.starts_with("w-"));
        // 行范围：完整条目从 ## 行（14）起到块内最后一个非空行（24，含坏行/未知字段行）
        assert_eq!(full.raw_line_range, [14, 24]);
    }

    #[test]
    fn drop_inbox_entries_removes_excluded_and_dangling_markers() {
        let text = "# 文献收件箱\n\n<!-- watch-run: 2026-08-11 -->\n\n## 保留条目\n- 来源：arxiv — 2026-08-10 — https://arxiv.org/abs/2608.00001\n- 相关性：相关\n\n<!-- watch-run: 2026-08-18 -->\n\n## 排除条目\n- 来源：期刊 — 2026-08-17 — 10.1000/xyz123\n- 相关性：推荐\n";
        let entries = parse_inbox_entries(text);
        assert_eq!(entries.len(), 2);
        let ids = std::collections::HashSet::from([entries[1].id.as_str()]);
        let dropped = drop_inbox_entries(text, &ids);
        assert!(!dropped.contains("排除条目"), "被排除条目整段删除");
        assert!(dropped.contains("保留条目"), "其余条目原文保留");
        assert!(!dropped.contains("2026-08-18"), "被删空的批次标记一并清掉");
        assert!(dropped.contains("2026-08-11"), "仍有序列条目的批次标记保留");
        assert_eq!(parse_inbox_entries(&dropped).len(), 1);
        assert!(dropped.ends_with('\n'), "结尾换行保持");
    }

    #[test]
    fn drop_inbox_entries_ignores_unknown_ids() {
        let ids = std::collections::HashSet::from(["w-none"]);
        assert_eq!(drop_inbox_entries(SAMPLE_INBOX, &ids), SAMPLE_INBOX);
        // 混入未知 id 不影响命中 id 的剔除
        let entries = parse_inbox_entries(SAMPLE_INBOX);
        let ids = std::collections::HashSet::from(["w-none", entries[0].id.as_str()]);
        let dropped = drop_inbox_entries(SAMPLE_INBOX, &ids);
        assert!(!dropped.contains("旧条目没有新增字段"));
        assert!(dropped.contains("完整字段条目"));
    }

    #[test]
    fn stamp_undated_inbox_inserts_one_marker_and_leaves_dated_runs_alone() {
        let dir = tmpdir("stamp");
        let original = "## 论文 A\n- 来源：期刊 — 2026-10-01 — https://doi.org/10.1/a\n- 相关性：推荐\n\n## 论文 B\n- 相关性：相关\n";
        write(&dir, "notes/inbox.md", original);
        assert!(stamp_undated_inbox(&dir, "2026-10-03").unwrap());
        let stamped = fs::read_to_string(dir.join("notes/inbox.md")).unwrap();
        assert!(stamped.starts_with("<!-- watch-run: 2026-10-03 -->\n## 论文 A\n"));
        assert_eq!(stamped.matches("watch-run").count(), 1);
        let entries = parse_inbox_entries(&stamped);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.date.as_deref() == Some("2026-10-03")));
        // 再补一次是空操作
        assert!(!stamp_undated_inbox(&dir, "2026-10-04").unwrap());
        // 标记会覆盖后面所有条目，直到下一个标记。已全部有日期时不改文件。
        let dated = "<!-- watch-run: 2026-08-01 -->\n## 旧\n- 相关性：推荐\n\n## 同批\n- 相关性：相关\n";
        write(&dir, "notes/inbox.md", dated);
        assert!(!stamp_undated_inbox(&dir, "2026-10-03").unwrap());
        // 标记前面漏写的条目补一行；标记之后的旧批次保持原日期
        let leading = "## 漏写\n- 相关性：推荐\n\n<!-- watch-run: 2026-08-01 -->\n## 旧\n- 相关性：相关\n";
        write(&dir, "notes/inbox.md", leading);
        assert!(stamp_undated_inbox(&dir, "2026-10-03").unwrap());
        let text = fs::read_to_string(dir.join("notes/inbox.md")).unwrap();
        let entries = parse_inbox_entries(&text);
        assert_eq!(entries[0].date.as_deref(), Some("2026-10-03"));
        assert_eq!(entries[1].date.as_deref(), Some("2026-08-01"));
        assert_eq!(
            shanghai_calendar_day("2026-10-02T16:30:00Z").as_deref(),
            Some("2026-10-03")
        );
        assert_eq!(shanghai_calendar_day("2026-10-03T05:36:19Z").as_deref(), Some("2026-10-03"));
        assert_eq!(shanghai_calendar_day("not-a-date"), None);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn entries_before_any_marker_have_no_date_and_bad_lines_skipped() {
        let text = "## 无批次条目\n- 相关性：推荐\n这不是字段行\n- 摘要首句：x\n\n## 第二条\n";
        let entries = parse_inbox_entries(text);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, None);
        assert_eq!(entries[0].abstract_first, "x");
        assert_eq!(entries[0].relevance, "推荐");
    }

    #[test]
    fn legacy_batch_headings_supply_dates_without_changing_entry_ids() {
        let text = "### 2026-08-22 巡检（自动雷达）\n\n## Paper A\n- 来源：Journal — 2026-08-19 — https://example.com/a\n\n### 2026-08-25 巡检（自动雷达）\n- 来源：本次未达\n\n### 2026-08-24 巡检（自动雷达）\n\n## Paper B\n- 相关性：推荐\n";
        let entries = parse_inbox_entries(text);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].date.as_deref(), Some("2026-08-22"));
        assert_eq!(entries[1].date.as_deref(), Some("2026-08-24"));
        assert_eq!(entries[0].source, "Journal");
        assert_eq!(entries[0].raw_line_range, [3, 4]);
        for entry in &entries {
            assert_eq!(entry.id, hash_id("w", &[&entry.title, ""]));
        }
    }

    #[test]
    fn mixed_batch_formats_use_nearest_date_but_keep_marker_based_ids() {
        let text = "<!-- watch-run: 2026-08-10 -->\n### 2026-08-11 巡检 (自动雷达)\n## Paper A\n- 相关性：推荐\n<!-- watch-run: 2026-08-18 -->\n## Paper B\n- 相关性：相关\n## 2026-08-19 巡检\n- 来源：本次未达\n## Paper C\n- 相关性：推荐\n";
        let entries = parse_inbox_entries(text);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].date.as_deref(), Some("2026-08-11"));
        assert_eq!(entries[1].date.as_deref(), Some("2026-08-18"));
        assert_eq!(entries[2].date.as_deref(), Some("2026-08-19"));
        assert_eq!(entries[0].id, hash_id("w", &["Paper A", "2026-08-10"]));
        assert_eq!(entries[1].id, hash_id("w", &["Paper B", "2026-08-18"]));
        assert_eq!(entries[2].id, hash_id("w", &["Paper C", "2026-08-18"]));
        assert!(entries[1].source.is_empty());
    }

    #[test]
    fn invalid_batch_dates_stay_unknown_instead_of_inheriting_or_using_publication_date() {
        for boundary in [
            "### 2026-02-29 巡检（自动雷达）",
            "### 2026-13-01 巡检",
            "<!-- watch-run: 2026-02-30 -->",
        ] {
            let text = format!("<!-- watch-run: 2026-02-20 -->\n## Valid\n- 相关性：推荐\n{boundary}\n## Unknown\n- 来源：Journal — 2026-02-21 — https://example.com/a\n");
            let entries = parse_inbox_entries(&text);
            assert_eq!(entries.len(), 2);
            assert_eq!(entries[0].date.as_deref(), Some("2026-02-20"));
            assert_eq!(entries[1].date, None, "{boundary}");
        }
        assert_eq!(
            validated_batch_date("2024-02-29").as_deref(),
            Some("2024-02-29")
        );
        assert_eq!(validated_batch_date("2026-2-01"), None);
        assert_eq!(validated_batch_date("2026年02月01日"), None);
        assert_eq!(parse_batch_heading("### 2026-08-22 普通笔记"), None);
        assert_eq!(parse_batch_heading("### 2026-08-22 巡检方法研究"), None);
        assert_eq!(parse_batch_heading("- 2026-08-22 巡检"), None);
    }

    #[test]
    fn source_line_tolerates_missing_segments() {
        // 只有来源一段
        let (s, u, d) = split_source_line("arxiv");
        assert_eq!((s.as_str(), u.as_str(), d), ("arxiv", "", None));
        // 两段：第二段像链接才算链接，像日期归发表日期
        let (s, u, d) = split_source_line("arxiv — 2026-08-10");
        assert_eq!((s.as_str(), u.as_str()), ("arxiv", ""));
        assert_eq!(d.as_deref(), Some("2026-08-10"));
        let (s, u, d) = split_source_line("arxiv — https://x.org/1");
        assert_eq!((s.as_str(), u.as_str(), d), ("arxiv", "https://x.org/1", None));
        // 标准三段：第二段发表日期、第三段链接
        let (s, u, d) = split_source_line("Nature — 2026-08-01 — 10.1038/s41586");
        assert_eq!((s.as_str(), u.as_str()), ("Nature", "10.1038/s41586"));
        assert_eq!(d.as_deref(), Some("2026-08-01"));
        // 日期段点/斜杠分隔、月日缺零也认；非日期不误判
        let (_, _, d) = split_source_line("Nature — 2026.8.1 — 10.1/x");
        assert_eq!(d.as_deref(), Some("2026.8.1"));
        let (_, _, d) = split_source_line("Nature — 2026/8/1 — 10.1/x");
        assert_eq!(d.as_deref(), Some("2026/8/1"));
        let (_, _, d) = split_source_line("Nature — 卷 12 期 3 — 10.1/x");
        assert_eq!(d, None);
        // 期刊接口常见 ISO 时间后缀：日期判定只看 T 前面，同样只保留日期部分
        let (_, _, d) = split_source_line("Crossref — 2026-10-12T09:00:00Z — 10.1/x");
        assert_eq!(d.as_deref(), Some("2026-10-12"));
        // 实测 agent 变体：括号后破折号不带空格、日期带「线上（期号 …）」尾巴
        let (s, u, d) = split_source_line("期刊（ACS Applied Materials & Interfaces）— 2026-10-07 — DOI: 10.1021/acsami.6c16394");
        assert_eq!(s, "期刊（ACS Applied Materials & Interfaces）");
        assert_eq!(u, "DOI: 10.1021/acsami.6c16394");
        assert_eq!(d.as_deref(), Some("2026-10-07"));
        let (_, _, d) = split_source_line("期刊（Journal of Magnesium and Alloys）— 2026-10-06 线上（期号 2026-11）— DOI: 10.1016/j.jma.2026.102294");
        assert_eq!(d.as_deref(), Some("2026-10-06"));
    }

    #[test]
    fn entries_capped_at_500_keeping_latest() {
        let mut text = String::new();
        for i in 1..=600 {
            text.push_str(&format!("## 条目 {i}\n- 相关性：相关\n"));
        }
        let entries = parse_inbox_entries(&text);
        assert_eq!(entries.len(), 500);
        // 砍前面留最新：第一条是「条目 101」，最后一条是「条目 600」
        assert_eq!(entries.first().unwrap().title, "条目 101");
        assert_eq!(entries.last().unwrap().title, "条目 600");
    }

    #[test]
    fn count_inbox_entries_counts_valid_literature_entries_and_missing_file_is_zero() {
        let dir = tmpdir("count");
        assert_eq!(count_inbox_entries(&dir), 0);
        write(&dir, "notes/inbox.md", SAMPLE_INBOX);
        assert_eq!(count_inbox_entries(&dir), 2);
        fs::remove_dir_all(&dir).ok();
    }

    // ===== 雷达筛选（metrics_pass_filter 纯判定；指标未知放行不误伤） =====

    fn metrics(
        if_: Option<&str>,
        quartile: Option<u8>,
        top: bool,
    ) -> crate::journal_metrics::JournalMetricsDto {
        crate::journal_metrics::JournalMetricsDto {
            impact_factor: if_.map(|s| s.to_string()),
            cas_quartile: quartile,
            top,
        }
    }

    #[test]
    fn filter_inert_passes_everything() {
        let f = crate::projects::LitWatchFilterDto::default();
        assert!(f.is_inert());
        assert!(metrics_pass_filter(None, &f));
        assert!(metrics_pass_filter(
            Some(&metrics(Some("1.0"), Some(4), false)),
            &f
        ));
    }

    #[test]
    fn filter_min_if_compares_parsed_value() {
        let f = crate::projects::LitWatchFilterDto {
            min_if: Some(10.0),
            ..Default::default()
        };
        assert!(metrics_pass_filter(
            Some(&metrics(Some("29.1"), None, false)),
            &f
        ));
        assert!(!metrics_pass_filter(
            Some(&metrics(Some("3.9"), None, false)),
            &f
        ));
        // 恰好等于阈值通过；设了筛选后 IF 缺失/不可解析 = 未知 → 不匹配
        // （与前端 entryPassesFilter 镜像同口径；不设筛选仍全部放行）
        assert!(metrics_pass_filter(
            Some(&metrics(Some("10"), None, false)),
            &f
        ));
        assert!(!metrics_pass_filter(
            Some(&metrics(None, Some(4), false)),
            &f
        ));
        assert!(!metrics_pass_filter(
            Some(&metrics(Some("N/A"), None, false)),
            &f
        ));
        assert!(!metrics_pass_filter(None, &f));
    }

    #[test]
    fn filter_quartile_and_top() {
        let q2 = crate::projects::LitWatchFilterDto {
            max_cas_quartile: Some(2),
            ..Default::default()
        };
        assert!(metrics_pass_filter(
            Some(&metrics(None, Some(1), false)),
            &q2
        ));
        assert!(metrics_pass_filter(
            Some(&metrics(None, Some(2), false)),
            &q2
        ));
        assert!(!metrics_pass_filter(
            Some(&metrics(None, Some(3), false)),
            &q2
        ));
        // 设了分区筛选后分区未知 → 不匹配（与前端镜像同口径）
        assert!(!metrics_pass_filter(Some(&metrics(None, None, false)), &q2));

        let top = crate::projects::LitWatchFilterDto {
            top_only: true,
            ..Default::default()
        };
        assert!(metrics_pass_filter(Some(&metrics(None, None, true)), &top));
        assert!(!metrics_pass_filter(
            Some(&metrics(None, None, false)),
            &top
        ));
        // 设了仅 TOP 后指标完全未知 → 不匹配（与前端镜像同口径）
        assert!(!metrics_pass_filter(None, &top));
    }

    #[test]
    fn filter_conditions_are_anded() {
        let f = crate::projects::LitWatchFilterDto {
            min_if: Some(10.0),
            max_cas_quartile: Some(2),
            top_only: true,
        };
        assert!(metrics_pass_filter(
            Some(&metrics(Some("19.9"), Some(1), true)),
            &f
        ));
        // 任一条件不达标即排除
        assert!(!metrics_pass_filter(
            Some(&metrics(Some("5.0"), Some(1), true)),
            &f
        ));
        assert!(!metrics_pass_filter(
            Some(&metrics(Some("19.9"), Some(3), true)),
            &f
        ));
        assert!(!metrics_pass_filter(
            Some(&metrics(Some("19.9"), Some(1), false)),
            &f
        ));
    }

    #[test]
    fn output_note_reports_ignored_summary_blocks_and_missing_ledger() {
        let dir = tmpdir("output-note");
        write(
            &dir,
            "notes/inbox.md",
            "## 2026-08-22 巡检（自动雷达）\n- 新命中 0 篇\n\n## 论文 A\n- 来源：arxiv — 2026-08-22 — https://arxiv.org/abs/1\n",
        );
        assert_eq!(
            output_note(&dir).as_deref(),
            Some("已忽略 1 个没有文献字段的巡检摘要块"),
        );
        write(&dir, "papers/watch-seen.md", "# ledger\n");
        assert_eq!(
            output_note(&dir).as_deref(),
            Some("已忽略 1 个没有文献字段的巡检摘要块"),
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn followups_parse_tolerantly() {
        let text = "\
# 跟进队列

- 付费墙论文 A — Chen L et al. — https://doi.org/10.1000/a — 付费墙，待人工获取
- 无摘要论文 B — 10.1000/b
- 只有标题的论文 C
注释行跳过
";
        let f = parse_followups(text);
        assert_eq!(f.len(), 3);
        assert_eq!(f[0].title, "付费墙论文 A");
        assert_eq!(f[0].url, "https://doi.org/10.1000/a");
        assert!(f[0].note.contains("付费墙，待人工获取"), "{}", f[0].note);
        assert!(f[0].note.contains("Chen L et al."));
        assert_eq!(f[1].url, "10.1000/b");
        assert_eq!(f[2].url, "");
        assert_eq!(f[2].note, "");
    }

    #[test]
    fn followups_parse_inbox_style_blocks() {
        // 技能把跟进队列写成了和收件箱一样的多行：标题在 ## 下，
        // 作者/来源/原因各占一行。一行一条的解析会把作者行当成标题。
        let text = "\
# 跟进队列（无摘要 / 付费墙，待人工获取全文）

## Rational Synthesis of High-Entropy Microrings
- 来源：Catalysis Letters — 2026-10-12 — https://doi.org/10.1007/s10562-026-05549-4
- 作者：Lei Yang; YuXin Wan et al.
- 缺失原因：Crossref/OpenAlex 均无摘要

## 只有标题没有字段的一篇

- 一行一条的旧格式 — Chen L — https://doi.org/10.1000/z — 付费墙
";
        let f = parse_followups(text);
        assert_eq!(f.len(), 3, "{f:?}");
        assert_eq!(f[0].title, "Rational Synthesis of High-Entropy Microrings");
        assert_eq!(f[0].url, "https://doi.org/10.1007/s10562-026-05549-4");
        assert!(f[0].note.contains("Catalysis Letters"), "{}", f[0].note);
        assert!(f[0].note.contains("Lei Yang"), "{}", f[0].note);
        assert!(f[0].note.contains("均无摘要"), "{}", f[0].note);
        assert!(!f[0].note.contains("doi.org"), "{}", f[0].note);
        assert_eq!(f[1].title, "只有标题没有字段的一篇");
        assert_eq!(f[1].url, "");
        assert_eq!(f[2].title, "一行一条的旧格式");
        assert_eq!(f[2].url, "https://doi.org/10.1000/z");
    }

    #[test]
    fn schedule_watchlist_is_per_task_and_deletes_with_it() {
        let root = std::env::temp_dir().join(format!(
            "ccode-watch-subs-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("papers")).unwrap();
        let shared = "\
# 文献雷达订阅：每行 关键词 — 来源 — 备注
HER — arxiv,openalex
";
        std::fs::write(root.join("papers/watchlist.md"), shared).unwrap();
        let id_a = "11111111-1111-1111-1111-111111111111";
        let id_b = "22222222-2222-2222-2222-222222222222";
        // 旧共享清单搬进还没有自己清单的任务；已有自己清单的不动
        write_schedule_subscriptions(
            &root,
            id_b,
            &[WatchSubscriptionDto {
                keyword: "boride".into(),
                sources: vec!["arxiv".into()],
                note: String::new(),
            }],
        )
        .unwrap();
        let a = read_schedule_subscriptions(&root, id_a).unwrap();
        assert!(a.is_empty());
        let b = read_schedule_subscriptions(&root, id_b).unwrap();
        assert_eq!(b[0].keyword, "boride");
        // 删一份不影响另一份
        delete_schedule_subscriptions(&root.to_string_lossy(), id_b);
        assert!(read_schedule_subscriptions(&root, id_b).unwrap().is_empty());
        assert!(!root.join(".ccode/watch").join(id_a).join("watchlist.md").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_schedule_watchlist_never_touches_existing_keywords() {
        let root = std::env::temp_dir().join(format!(
            "ccode-watch-ensure-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let id = "33333333-3333-3333-3333-333333333333";
        // 已有关键词：「编辑源文件」前的准备一个字节都不动（曾经整表写空，2026-10-17 实证）
        write_schedule_subscriptions(
            &root,
            id,
            &[
                WatchSubscriptionDto { keyword: "镁硫电池".into(), sources: vec![], note: String::new() },
                WatchSubscriptionDto { keyword: "球磨法".into(), sources: vec![], note: String::new() },
            ],
        )
        .unwrap();
        let path = root.join(schedule_watchlist_rel(id).unwrap());
        let before = std::fs::read_to_string(&path).unwrap();
        ensure_schedule_watchlist(&root, id).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        assert_eq!(read_schedule_subscriptions(&root, id).unwrap().len(), 2);
        // 还没有文件：建一份只有格式说明的空清单
        let fresh = "44444444-4444-4444-4444-444444444444";
        ensure_schedule_watchlist(&root, fresh).unwrap();
        assert!(read_schedule_subscriptions(&root, fresh).unwrap().is_empty());
        assert!(std::fs::read_to_string(root.join(schedule_watchlist_rel(fresh).unwrap()))
            .unwrap()
            .starts_with("# 文献雷达订阅"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inbox_append_delta_takes_only_new_entries_with_their_marker() {
        let base = "# 文献雷达收件箱\n\n<!-- watch-run: 2026-10-12 -->\n\n## 旧\n- 来源：期刊 — 2026-10-11 — 10.1/old\n";
        let after = format!(
            "{base}\n<!-- watch-run: 2026-10-13 -->\n\n## 甲\n- 来源：期刊 — 2026-10-12 — 10.1/a\n\n## 乙\n- 来源：期刊 — 2026-10-12 — 10.1/b\n"
        );
        let none = std::collections::HashSet::new();
        // 主仓已有：只追加新条目，不带文件头
        let delta = inbox_append_delta(Some(base), Some(base), &after, &none).unwrap();
        assert!(delta.starts_with("<!-- watch-run: 2026-10-13 -->"));
        assert!(delta.contains("## 甲") && delta.contains("## 乙") && !delta.contains("## 旧"));
        assert!(!delta.contains("文献雷达收件箱"));
        // 主仓还没有收件箱：带上文件头
        let fresh = inbox_append_delta(None, None, &after, &none).unwrap();
        assert!(fresh.starts_with("# 文献雷达收件箱"));
        // 排除乙、主仓已有甲（同名）：没有可追加的，连批次标记也不留
        let ids: Vec<String> = watch_inbox_from_text(&after)
            .into_iter()
            .filter(|e| e.title == "乙")
            .map(|e| e.id)
            .collect();
        let drop: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
        let main_has_a = format!("{base}\n## 甲\n- 来源：期刊 — 2026-10-12 — 10.1/a\n");
        assert_eq!(inbox_append_delta(Some(&main_has_a), Some(base), &after, &drop), None);
    }

    #[test]
    fn followup_append_delta_handles_one_liners_and_drops_excluded() {
        let initial = "- 旧 — 10.1/old — 付费墙\n";
        let after = "- 旧 — 10.1/old — 付费墙\n- 新甲 — 10.1/a — 付费墙\n- 新乙 — 10.1/b — 无摘要\n";
        let delta =
            followup_append_delta(Some(initial), Some(initial), after, &["新乙".into()]).unwrap();
        assert_eq!(delta, "- 新甲 — 10.1/a — 付费墙");
        // 主仓已有同名待办：不重复
        let main = "- 旧 — 10.1/old — 付费墙\n- 新甲 — 10.1/a — 付费墙\n";
        assert_eq!(followup_append_delta(Some(main), Some(initial), after, &["新乙".into()]), None);
    }

    #[test]
    fn adopt_watch_pdfs_copies_only_this_runs_kept_downloads() {
        let root = tmpdir("watch-pdfs");
        let iso = root.join("iso");
        let project = root.join("project");
        std::fs::create_dir_all(iso.join("papers")).unwrap();
        std::fs::create_dir_all(project.join("papers")).unwrap();
        for name in [
            "Kept Paper About Magnesium Sulfur.pdf",
            "Excluded Paper About Ball Milling.pdf",
            "Renamed Long Ago.pdf",
        ] {
            std::fs::write(iso.join("papers").join(name), b"%PDF-1.4 test").unwrap();
        }
        let only = vec![
            "Kept Paper About Magnesium Sulfur.pdf".to_string(),
            "Excluded Paper About Ball Milling.pdf".to_string(),
        ];
        // 排除条目的标题比文件名长（雷达起名会截短）：前缀对上也算
        let excluded = vec!["Excluded paper about ball milling: a review".to_string()];
        let copied = adopt_watch_pdfs(&iso, &project, Some(&only), &excluded).unwrap();
        assert_eq!(copied, vec!["papers/Kept Paper About Magnesium Sulfur.pdf"]);
        // 以前各轮下的（主仓里已被改名/删掉）不再拷回
        assert!(!project.join("papers/Renamed Long Ago.pdf").exists());
        // 旧证据没有记录时回落旧口径，但排除的仍不拷
        let legacy = adopt_watch_pdfs(&iso, &project, None, &excluded).unwrap();
        assert_eq!(legacy, vec!["papers/Renamed Long Ago.pdf"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn followups_parse_numbered_batch() {
        // 实际巡检写成编号列表：## 只是批次名，标题在「1. 」后，
        // 作者和原因缩进挂在下面，DOI 写成「DOI: 10.xxxx/…」而不是链接。
        let text = "\
# lit-watch 跟进队列

## 2026-10-13 批次

1. Quantifying the Heterointerface Contribution in a Cu7S4 Cathode
   - Wang X.; Zhang G. et al. — ACS Applied Materials & Interfaces, 2026-10-07 — DOI: 10.1021/acsami.6c16394
   - 原因：付费墙（closed），无免费直链 PDF。
2. Imidazole-Amine Synergistic Coordination
   - Cui Z. et al. — Small, 2026-10-07 — DOI: 10.1002/smll.76114
   - 原因：bronze OA，仅出版商页。
";
        let f = parse_followups(text);
        assert_eq!(f.len(), 2, "{f:?}");
        assert_eq!(
            f[0].title,
            "Quantifying the Heterointerface Contribution in a Cu7S4 Cathode"
        );
        assert_eq!(f[0].url, "https://doi.org/10.1021/acsami.6c16394");
        assert!(f[0].note.contains("Wang X."), "{}", f[0].note);
        assert!(f[0].note.contains("ACS Applied"), "{}", f[0].note);
        assert!(f[0].note.contains("付费墙"), "{}", f[0].note);
        assert!(!f[0].note.contains("10.1021"), "{}", f[0].note);
        assert!(f[1].title.starts_with("Imidazole"), "{}", f[1].title);
        assert_eq!(f[1].url, "https://doi.org/10.1002/smll.76114");
    }

    #[test]
    fn watchlist_parse_and_render_round_trip_preserving_comments() {
        let text = "\
# 订阅清单：每行 关键词 — 来源 — 备注
perovskite stability — arxiv,openalex — 每周 +bib
solid electrolyte — crossref
lone keyword
# 尾部注释也保留
";
        let subs = parse_subscriptions(text);
        assert_eq!(subs.len(), 3);
        assert_eq!(subs[0].keyword, "perovskite stability");
        assert_eq!(subs[0].sources, vec!["arxiv", "openalex"]);
        assert_eq!(subs[0].note, "每周 +bib");
        assert_eq!(subs[1].sources, vec!["crossref"]);
        assert_eq!(subs[1].note, "");
        assert_eq!(subs[2].keyword, "lone keyword");
        assert_eq!(subs[2].sources, Vec::<String>::new());
        // 整表写回：注释保留、字段往返
        let rendered = render_watchlist(Some(text), &subs);
        let back = parse_subscriptions(&rendered);
        assert_eq!(back, subs);
        assert!(rendered.contains("# 订阅清单"), "注释行要保留: {rendered}");
        assert!(rendered.contains("# 尾部注释也保留"), "{rendered}");
        assert!(rendered.contains("perovskite stability — arxiv,openalex — 每周 +bib"));
        // 空关键词丢弃；新建文件带格式模板注释（注释不影响解析）
        let rendered = render_watchlist(
            None,
            &[WatchSubscriptionDto {
                keyword: "  ".into(),
                sources: vec![],
                note: String::new(),
            }],
        );
        assert!(parse_subscriptions(&rendered).is_empty());
        assert!(rendered.contains("# 文献雷达订阅"), "{rendered}");
    }

    #[test]
    fn included_lines_parse_fields_and_stable_ids() {
        let text = "Perovskite Solar Cells: A Review — Zhang S, 2025 — Adv. Mater. — 10.1000/x1\n另一篇论文 — 待补 — 待补 — 待补\n";
        let list = parse_included(text);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].title, "Perovskite Solar Cells: A Review");
        assert_eq!(list[0].authors_year, "Zhang S, 2025");
        assert_eq!(list[0].source, "Adv. Mater.");
        assert_eq!(list[0].link, "10.1000/x1");
        assert!(list[0].line_id.starts_with("i-"));
        assert_eq!(
            list[0].raw_line,
            "Perovskite Solar Cells: A Review — Zhang S, 2025 — Adv. Mater. — 10.1000/x1"
        );
        assert_eq!(list[1].title, "另一篇论文");
    }

    #[test]
    fn reading_list_round_trip_and_cross_ledger_dedup() {
        let dir = tmpdir("reading-list");
        // 积累账落 papers/reading-list.md，行格式与 included.md 同构
        let r = add_reading_list_at(&dir, "Radar Paper One", "Chen L, 2026", "Nat. Energy", "10.1/a")
            .unwrap();
        assert!(r.added);
        assert!(dir.join("papers/reading-list.md").exists());
        // 同标题（规范化后相同）→ 自身去重
        let r2 = add_reading_list_at(&dir, "radar paper one!", "X", "Y", "Z").unwrap();
        assert!(!r2.added);
        // 已在正典 included.md 的篇也不重复记（两表并集去重域）
        fs::write(dir.join("papers/included.md"), "Canon Paper — A, 2025 — JACS — 10.1/b\n").unwrap();
        let r3 = add_reading_list_at(&dir, "Canon Paper", "", "", "").unwrap();
        assert!(!r3.added);
        // list / remove 与 included 同一套解析
        let list = reading_list_entries_at(&dir).unwrap();
        assert_eq!(list.len(), 1);
        remove_reading_list_at(&dir, &list[0].line_id).unwrap();
        assert!(reading_list_entries_at(&dir).unwrap().is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn freeze_intake_copies_nonempty_reading_list_into_worktree() {
        let dir = tmpdir("intake");
        let worktree = dir.join("wt");
        fs::create_dir_all(&worktree).unwrap();
        // 空账/无账：不生成快照，不报错
        assert!(!freeze_intake_at(&dir, &worktree).unwrap());
        add_reading_list_at(&dir, "Accumulated Paper", "A, 2026", "J", "10.1/x").unwrap();
        assert!(freeze_intake_at(&dir, &worktree).unwrap());
        let snap = fs::read_to_string(worktree.join(".ccode/handoff-lit-intake.md")).unwrap();
        assert!(snap.contains("Accumulated Paper"), "{snap}");
        // 快照是开工定格副本：之后积累账再动，快照不变
        add_reading_list_at(&dir, "Later Paper", "", "", "").unwrap();
        let snap2 = fs::read_to_string(worktree.join(".ccode/handoff-lit-intake.md")).unwrap();
        assert!(!snap2.contains("Later Paper"), "{snap2}");
        // 工作区目录不存在 → 明确报错
        assert!(freeze_intake_at(&dir, &dir.join("nope")).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pdf_magic_check_follows_pdf_rs_rule() {
        assert!(looks_like_pdf(b"%PDF-1.7 body"));
        // 前导字节 + 魔数落在前 1024 字节窗口内
        let mut v = vec![b' '; 100];
        v.extend_from_slice(b"%PDF-1.7");
        assert!(looks_like_pdf(&v));
        assert!(!looks_like_pdf(b"<html>not a pdf</html>"));
        assert!(!looks_like_pdf(b""));
    }

    #[test]
    fn pick_paper_name_hint_skips_generic_page_title() {
        // PDF 阅读器常见空/站名/paper-5：用 Mesa 打开时记下的标题，清单才能对上已存
        assert!(!is_usable_paper_title(""));
        assert!(!is_usable_paper_title("paper"));
        assert!(!is_usable_paper_title("paper-5"));
        assert!(!is_usable_paper_title("paper-5.pdf"));
        assert!(!is_usable_paper_title("ScienceDirect"));
        assert!(!is_usable_paper_title(
            "https://www.sciencedirect.com/science/article/pii/S1"
        ));
        assert!(is_usable_paper_title(
            "Development of a chloride-free dual-salt electrolyte"
        ));
        assert_eq!(
            pick_paper_name_hint(
                "paper-5",
                "",
                "https://www.sciencedirect.com/science/article/pii/S092583882604209X/pdfft",
                "Development of a chloride-free dual-salt electrolyte",
                "10.1016/j.jallcom.2026.190140",
            ),
            "Development of a chloride-free dual-salt electrolyte"
        );
        // 页上有正经标题：不拿语境那篇顶替（用户可能另开了一篇）
        assert_eq!(
            pick_paper_name_hint(
                "Another Real Article Title Here",
                "10.1002/adma.202304268",
                "",
                "Development of a chloride-free dual-salt electrolyte",
                "10.1016/j.jallcom.2026.190140",
            ),
            "Another Real Article Title Here"
        );
        // 页上没标题但 URL 带 DOI：用 DOI 当文件名（to_fetch_progress 认 DOI）
        assert_eq!(
            pick_paper_name_hint(
                "ScienceDirect",
                "",
                "https://onlinelibrary.wiley.com/doi/pdf/10.1002/adma.202304268",
                "",
                "",
            ),
            "10.1002_adma.202304268"
        );
    }

    #[test]
    fn pdf_name_sanitized_and_deduped() {
        // 分隔符/控制字符/Windows 非法字符清除，非 .pdf 结尾补
        assert_eq!(sanitize_pdf_name("a/b\\c:d*e?f\"g<h>i|j"), "abcdefghij.pdf");
        assert_eq!(sanitize_pdf_name("paper.pdf"), "paper.pdf");
        assert_eq!(sanitize_pdf_name("paper.PDF"), "paper.pdf");
        assert_eq!(sanitize_pdf_name(""), "paper.pdf");
        assert_eq!(sanitize_pdf_name("..."), "paper.pdf");
        assert_eq!(sanitize_pdf_name("含中文 标题"), "含中文 标题.pdf");
        // 限长：总长度不超过 主干上限 + .pdf
        let long = "字".repeat(300);
        let name = sanitize_pdf_name(&long);
        assert!(
            name.chars().count() <= FILE_STEM_CAP + 4,
            "{}",
            name.chars().count()
        );
        assert!(name.ends_with(".pdf"));
        // 重名避让 -2/-3
        let dir = tmpdir("dup");
        let p1 = unique_pdf_path(&dir, "x.pdf");
        fs::write(&p1, b"a").unwrap();
        let p2 = unique_pdf_path(&dir, "x.pdf");
        assert_eq!(p2.file_name().unwrap(), "x-2.pdf");
        fs::write(&p2, b"b").unwrap();
        let p3 = unique_pdf_path(&dir, "x.pdf");
        assert_eq!(p3.file_name().unwrap(), "x-3.pdf");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_pdf_registers_resource_in_project_toml() {
        let dir = tmpdir("save");
        let dto = save_and_register_pdf(&dir, "my paper", b"%PDF-1.7 fake").unwrap();
        assert!(
            std::path::Path::new(&dto.path).ends_with("papers/my paper.pdf"),
            "{}",
            dto.path
        );
        assert_eq!(dto.name, "my paper");
        let cfg = crate::projects::read_config_at(&dir).config;
        assert_eq!(cfg.resources.len(), 1);
        assert_eq!(cfg.resources[0].kind, "paper");
        assert_eq!(cfg.resources[0].name, "my paper");
        assert_eq!(cfg.resources[0].path, "papers/my paper.pdf");
        // 同 hint 再下载：文件避让 -2，资源另登记一条
        let dto2 = save_and_register_pdf(&dir, "my paper", b"%PDF-1.7 fake2").unwrap();
        assert!(
            std::path::Path::new(&dto2.path).ends_with("papers/my paper-2.pdf"),
            "{}",
            dto2.path
        );
        let cfg2 = crate::projects::read_config_at(&dir).config;
        assert_eq!(cfg2.resources.len(), 2);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn attach_pdf_copies_and_registers() {
        let dir = tmpdir("attach");
        let src_dir = tmpdir("attach-src");
        let src = src_dir.join("手动下载.pdf");
        fs::write(&src, b"%PDF-1.7 body").unwrap();
        let dto = attach_pdf_at(&dir, src.to_str().unwrap(), "My Paper Title").unwrap();
        assert!(
            std::path::Path::new(&dto.path).ends_with("papers/My Paper Title.pdf"),
            "{}",
            dto.path
        );
        assert_eq!(dto.name, "My Paper Title");
        // 复制而非移动：源文件还在
        assert!(src.exists());
        let cfg = crate::projects::read_config_at(&dir).config;
        assert_eq!(cfg.resources.len(), 1);
        assert_eq!(cfg.resources[0].kind, "paper");
        assert_eq!(cfg.resources[0].path, "papers/My Paper Title.pdf");
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&src_dir).ok();
    }

    #[test]
    fn attach_pdf_rejects_non_pdf() {
        let dir = tmpdir("attach-bad");
        let src_dir = tmpdir("attach-bad-src");
        // 扩展名不对
        let txt = src_dir.join("notes.txt");
        fs::write(&txt, b"%PDF-1.7 disguised").unwrap();
        let err = attach_pdf_at(&dir, txt.to_str().unwrap(), "t").unwrap_err();
        assert!(err.contains("PDF"), "{err}");
        // 扩展名对但魔数不对
        let fake = src_dir.join("fake.pdf");
        fs::write(&fake, b"<html>login page</html>").unwrap();
        let err = attach_pdf_at(&dir, fake.to_str().unwrap(), "t").unwrap_err();
        assert!(err.contains("不是有效的 PDF"), "{err}");
        // 不存在的路径
        let err = attach_pdf_at(&dir, "/nonexistent/x.pdf", "t").unwrap_err();
        assert!(err.contains("不可读"), "{err}");
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&src_dir).ok();
    }

    #[cfg(unix)] // 符号链接语义仅 unix；Windows 无权限创建
    #[test]
    fn symlink_escaping_root_rejected() {
        let dir = tmpdir("sroot");
        let outside = tmpdir("soutside");
        let secret = outside.join("inbox.md");
        fs::write(&secret, "## 外面的条目\n").unwrap();
        fs::create_dir_all(dir.join("notes")).unwrap();
        std::os::unix::fs::symlink(&secret, dir.join("notes/inbox.md")).unwrap();
        let err = read_text_inside(&dir, "notes/inbox.md").unwrap_err();
        assert!(err.contains("项目目录之外"), "{err}");
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn explain_cache_roundtrip_by_normalized_title() {
        let dir = tmpdir("explain");
        save_explain_at(&dir, "Perovskite Solar Cells: A Review", "问题与动机\n正文").unwrap();
        assert!(save_explain_at(&dir, "", "x").is_err());
        assert!(save_explain_at(&dir, "x", "  ").is_err());
        let mut entries =
            parse_inbox_entries("## Perovskite Solar Cells: A Review\n- 摘要首句：We present.\n");
        attach_explains(&dir, &mut entries);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].explain.as_deref(), Some("问题与动机\n正文"));
        save_explain_at(&dir, "perovskite solar cells a review", "新稿").unwrap();
        attach_explains(&dir, &mut entries);
        assert_eq!(entries[0].explain.as_deref(), Some("新稿"));
        fs::remove_dir_all(&dir).ok();
    }
}


