//! 期刊指标表（IF / 中科院分区 / TOP）：供文献雷达、检索清单与 Agent 查表使用。
//!
//! 数据源（版权数据，不随安装包分发，保存在 `config_dir/ccode/journal-metrics/`）：
//! - 启动后后台静默拉取与按周期（14 天）检查更新，首次装好软件「拿来就用」；
//! - 跨年自适应：不写死年份文件名，按本机可选指针 `sources.json` → jsDelivr 文件列表 API →
//!   Gitee Contents API → GitHub Contents API 动态发现最新年份的 `JCR{YYYY}*.csv` 与
//!   `FQBJCR{YYYY}*.csv`，再按多镜像（jsDelivr / Fastly / Gitee / GitHub raw）带出网代理下载；
//! - 也支持用户手动导入本地 CSV（自动按表头嗅探 JCR / 中科院分区表）。
//!
//! 两表按「期刊名规范化」（复用 lit_watch::normalize_title：去非字母数字 + 小写）与 ISSN 合并成
//! 进程内缓存，下载或导入完成后 invalidate_cache 并广播 `journal-metrics-updated` 事件。
//! 表文件不存在时整个模块静默表现为「无数据」（lookup 恒 None、status.available=false），不报错；
//! 查询只做规范化后的精确匹配，miss 诚实返回 None，不做模糊匹配。

use chrono::Datelike;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use tauri::Emitter;

/// 指标表更新完成的 Tauri 事件名：前端监听后自动刷新徽章与状态
pub const EVENT_UPDATED: &str = "journal-metrics-updated";
/// 兼容兜底的默认文件名（所有目录发现 API 均不可达且最新年份探测不到时回落）
const FALLBACK_JCR_FILE: &str = "JCR2025-UTF8.csv";
const FALLBACK_FQB_FILE: &str = "FQBJCR2025-UTF8.csv";
/// 本机可选数据源指针文件（无需发版即可切源或指向自定义镜像）
const SOURCES_MANIFEST_FILE: &str = "sources.json";
/// 同步元数据（记录上次检查时间、上游更新时间与远端最新年份，减少无谓轮询与限流）
const SYNC_META_FILE: &str = "sync-meta.json";
/// 单个镜像连接超时：死链快速切换下一个镜像
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// 单个镜像下载总超时
const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
/// 目录发现 / 元数据查询超时
const UPDATE_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// 后台自动检查周期（14 天，与 model_registry 保持同口径；JCR/中科院均为年度发布）
const AUTO_REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(14 * 24 * 3600);
/// 前端页面常规更新检查冷却期（24 小时内复用 sync-meta，避免频繁打开页面触发限流）
const UPDATE_CHECK_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(24 * 3600);
/// 远端下载校验最少有效期刊数（拦住镜像返回 HTML 错误页或截断文件）
const MIN_REMOTE_JOURNALS: usize = 100;
/// ShowJCR 仓库内 CSV 所在目录（原始名与 URL 编码名）
const REMOTE_DIR_RAW: &str = "中科院分区表及JCR原始数据文件";
const REMOTE_DIR: &str =
    "%E4%B8%AD%E7%A7%91%E9%99%A2%E5%88%86%E5%8C%BA%E8%A1%A8%E5%8F%8AJCR%E5%8E%9F%E5%A7%8B%E6%95%B0%E6%8D%AE%E6%96%87%E4%BB%B6";
const USER_AGENT: &str = "Mesa journal-metrics (https://github.com/Zeta-Techs/mesa)";

// ===== DTO（camelCase，风格同 lit_watch.rs） =====

/// 检索清单一次送来的查询。刊名和 ISSN 都空、又没有 DOI 时，对应结果为 null。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalMetricsQuery {
    pub venue: String,
    pub issn: String,
    /// 刊名写成「待补」时用来向 OpenAlex 补一次刊名。不写回项目文件。
    #[serde(default)]
    pub doi: String,
}

/// 单刊合并指标（两表任一命中即返回）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalMetricsDto {
    /// JCR IF 原样字符串（如 "29.1"）；JCR 表没有该刊为 None
    pub impact_factor: Option<String>,
    /// 中科院升级版大类分区 1-4；FQB 表没有该刊为 None
    pub cas_quartile: Option<u8>,
    /// 中科院 Top 期刊标记（Top=是）
    pub top: bool,
}

/// journal_metrics_status 返回：表是否可用 + 合并后总刊数 + 年份与下载状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalMetricsStatusDto {
    /// 至少一张表存在且能解析出条目
    pub available: bool,
    /// 合并后总刊数
    pub journal_count: u32,
    /// 本地表下载时间（RFC3339；已加载 CSV 取较新的 mtime），未装为 None
    pub downloaded_at: Option<String>,
    /// 当前加载的 JCR 表年份（如 2025 / 2026）；无法从文件名推断时为 None
    #[serde(default)]
    pub jcr_year: Option<u16>,
    /// 当前加载的中科院分区表年份（如 2025 / 2026）；无法从文件名推断时为 None
    #[serde(default)]
    pub fqb_year: Option<u16>,
    /// 是否正在后台自动拉取或手动更新中
    #[serde(default)]
    pub downloading: bool,
}

/// check_journal_metrics_update 返回：上游最新年份 / 更新时间与本地比对结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalMetricsUpdateDto {
    /// 上游数据目录最近更新时间（RFC3339）
    pub upstream_updated_at: Option<String>,
    /// 上游比本地表新（本地未装恒 false）
    pub has_update: bool,
    /// 上游发现的最新 JCR 年份
    #[serde(default)]
    pub latest_jcr_year: Option<u16>,
    /// 上游发现的最新中科院分区表年份
    #[serde(default)]
    pub latest_fqb_year: Option<u16>,
}

// ===== 内部元数据与指针结构 =====

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TableKind {
    Jcr,
    Fqb,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    file: String,
    #[serde(default)]
    year: Option<u16>,
    #[serde(default)]
    urls: Vec<String>,
}

/// 可选数据源指针（`<config>/ccode/journal-metrics/sources.json` 或 `MESA_JOURNAL_MANIFEST_URL`）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricsManifest {
    #[serde(default)]
    jcr: Option<ManifestEntry>,
    #[serde(default)]
    fqb: Option<ManifestEntry>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncMeta {
    #[serde(default)]
    last_checked_at: Option<String>,
    #[serde(default)]
    upstream_updated_at: Option<String>,
    #[serde(default)]
    latest_jcr_year: Option<u16>,
    #[serde(default)]
    latest_fqb_year: Option<u16>,
    #[serde(default)]
    jcr_file: Option<String>,
    #[serde(default)]
    fqb_file: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct LocalTableSelection {
    jcr_path: Option<PathBuf>,
    jcr_year: Option<u16>,
    fqb_path: Option<PathBuf>,
    fqb_year: Option<u16>,
}

#[derive(Debug, Clone)]
struct RemoteTarget {
    file: String,
    year: Option<u16>,
    custom_urls: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct RemoteDiscovery {
    jcr: Option<RemoteTarget>,
    fqb: Option<RemoteTarget>,
    upstream_updated_at: Option<String>,
}

// ===== 并发单飞锁 =====

static DOWNLOAD_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct DownloadGuard;

impl DownloadGuard {
    fn try_acquire() -> Option<Self> {
        DOWNLOAD_IN_FLIGHT
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for DownloadGuard {
    fn drop(&mut self) {
        DOWNLOAD_IN_FLIGHT.store(false, Ordering::Release);
    }
}

fn is_downloading() -> bool {
    DOWNLOAD_IN_FLIGHT.load(Ordering::Acquire)
}

// ===== 加载与缓存 =====

fn metrics_dir() -> Option<PathBuf> {
    Some(crate::dirs::config_dir()?.join("ccode").join("journal-metrics"))
}

/// 表缓存：RwLock<Option<Arc<..>>> 而非 OnceLock——下载/导入完成后要 invalidate 重建
static TABLE_CACHE: RwLock<Option<Arc<MetricsTables>>> = RwLock::new(None);

/// 下载/导入完成后清缓存（下次 lookup 重新解析）
pub(crate) fn invalidate_cache() {
    if let Ok(mut guard) = TABLE_CACHE.write() {
        *guard = None;
    }
}

/// 取合并表（首次调用时解析磁盘文件；文件不存在/解析失败按空表处理，不报错）
fn table() -> Arc<MetricsTables> {
    if let Ok(guard) = TABLE_CACHE.read() {
        if let Some(t) = guard.as_ref() {
            return t.clone();
        }
    }
    let loaded = Arc::new(load_tables());
    if let Ok(mut guard) = TABLE_CACHE.write() {
        *guard = Some(loaded.clone());
    }
    loaded
}

// ===== 文件名识别与表头嗅探 =====

fn strip_bom(text: &str) -> &str {
    text.trim_start_matches('\u{feff}')
}

/// 从文件名提取 4 位年份（2000–2099）
fn extract_year(s: &str) -> Option<u16> {
    let bytes = s.as_bytes();
    for win in bytes.windows(4) {
        if win.iter().all(|b| b.is_ascii_digit()) {
            if let Ok(text) = std::str::from_utf8(win) {
                if let Ok(year) = text.parse::<u16>() {
                    if (2000..=2099).contains(&year) {
                        return Some(year);
                    }
                }
            }
        }
    }
    None
}

/// 按 ShowJCR 命名规则归类 CSV：返回 (表类型, 年份, 是否显式 UTF8)
fn classify_csv_filename(name: &str) -> Option<(TableKind, Option<u16>, bool)> {
    let lower = name.trim().to_ascii_lowercase();
    if !lower.ends_with(".csv") {
        return None;
    }
    let is_utf8 = lower.contains("utf8") || lower.contains("utf-8");
    if lower.starts_with("fqbjcr") {
        return Some((TableKind::Fqb, extract_year(&lower), is_utf8));
    }
    if lower.starts_with("jcr") {
        return Some((TableKind::Jcr, extract_year(&lower), is_utf8));
    }
    None
}

/// 在一组 CSV 文件名中挑出指定类型的最新一份（年份最大 > 显式 UTF8 > 字典序）
fn pick_latest_csv(names: &[String], kind: TableKind) -> Option<(String, Option<u16>)> {
    let mut candidates: Vec<(&String, u16, bool)> = names
        .iter()
        .filter_map(|name| {
            let (k, year, is_utf8) = classify_csv_filename(name)?;
            if k != kind {
                return None;
            }
            Some((name, year.unwrap_or(0), is_utf8))
        })
        .collect();
    candidates.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| b.2.cmp(&a.2))
            .then_with(|| b.0.cmp(a.0))
    });
    candidates
        .first()
        .map(|(name, year, _)| ((*name).clone(), (*year > 0).then_some(*year)))
}

/// 根据 CSV 内容首行表头嗅探类型（用于用户手动导入或自定义命名的 CSV）
fn sniff_csv_kind(text: &str) -> Option<(TableKind, Option<u16>)> {
    let clean = strip_bom(text);
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(clean.as_bytes());
    let headers = rdr.headers().ok()?;
    let has_journal = col_index(headers, "Journal", None).is_some();
    if !has_journal {
        return None;
    }
    if col_index(headers, "大类分区", None).is_some() {
        return Some((TableKind::Fqb, None));
    }
    if let Some(idx) = col_index(headers, "IF(2025)", Some("IF(")) {
        let year = headers.get(idx).and_then(extract_year);
        return Some((TableKind::Jcr, year));
    }
    None
}

/// 扫描本地 `journal-metrics/` 目录：优先最新年份标准 CSV，缺失时再嗅探用户自定义 CSV
fn discover_local_files(dir: &Path) -> LocalTableSelection {
    let mut out = LocalTableSelection::default();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if name.to_ascii_lowercase().ends_with(".csv") {
                names.push(name.to_string());
            }
        }
    }
    if let Some((file, year)) = pick_latest_csv(&names, TableKind::Jcr) {
        out.jcr_path = Some(dir.join(file));
        out.jcr_year = year;
    }
    if let Some((file, year)) = pick_latest_csv(&names, TableKind::Fqb) {
        out.fqb_path = Some(dir.join(file));
        out.fqb_year = year;
    }
    // 兼容用户手动放入但未按 JCR*/FQBJCR* 命名的 CSV：缺哪张就按表头补哪张
    if out.jcr_path.is_none() || out.fqb_path.is_none() {
        let mut custom: Vec<(PathBuf, std::time::SystemTime)> = names
            .iter()
            .filter(|name| classify_csv_filename(name).is_none())
            .map(|name| {
                let p = dir.join(name);
                let mtime = fs::metadata(&p)
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                (p, mtime)
            })
            .collect();
        custom.sort_by(|a, b| b.1.cmp(&a.1));
        for (path, _) in custom {
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            let Some((kind, year)) = sniff_csv_kind(&text) else {
                continue;
            };
            match kind {
                TableKind::Jcr if out.jcr_path.is_none() => {
                    out.jcr_path = Some(path);
                    out.jcr_year = year;
                }
                TableKind::Fqb if out.fqb_path.is_none() => {
                    out.fqb_path = Some(path);
                    out.fqb_year = year;
                }
                _ => {}
            }
        }
    }
    out
}

// ===== 解析（注入文本，便于单测） =====

/// 在表头里找列位置；IF 列名随年份变化（`IF(2025)` / `IF(2026)`），按前缀匹配
fn col_index(
    headers: &csv::StringRecord,
    exact: &str,
    prefix_fallback: Option<&str>,
) -> Option<usize> {
    headers
        .iter()
        .position(|h| h.trim() == exact)
        .or_else(|| {
            prefix_fallback
                .and_then(|p| headers.iter().position(|h| h.trim().starts_with(p)))
        })
}

/// 取/建合并条目：key 为规范化期刊名（空名跳过整行）
fn entry_for<'a>(
    map: &'a mut HashMap<String, JournalMetricsDto>,
    journal: &str,
) -> Option<&'a mut JournalMetricsDto> {
    let key = crate::lit_watch::normalize_title(journal.trim());
    if key.is_empty() {
        return None;
    }
    Some(map.entry(key).or_insert_with(|| JournalMetricsDto {
        impact_factor: None,
        cas_quartile: None,
        top: false,
    }))
}

/// 解析 JCR 表：填 impact_factor（空串按 None），返回从表头提取的年份（若有）
fn parse_jcr(text: &str, map: &mut HashMap<String, JournalMetricsDto>) -> Option<u16> {
    let clean = strip_bom(text);
    // flexible：允许行尾列数不齐，坏行跳过不整体失败
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(clean.as_bytes());
    let Ok(headers) = rdr.headers().cloned() else {
        return None;
    };
    let i_journal = col_index(&headers, "Journal", None)?;
    let i_if = col_index(&headers, "IF(2025)", Some("IF("))?;
    let header_year = headers.get(i_if).and_then(extract_year);
    for rec in rdr.records().flatten() {
        let (Some(journal), Some(impact)) = (rec.get(i_journal), rec.get(i_if)) else {
            continue;
        };
        let impact = impact.trim();
        if impact.is_empty() {
            continue;
        }
        if let Some(e) = entry_for(map, journal) {
            e.impact_factor = Some(impact.to_string());
        }
    }
    header_year
}

/// 大类分区字段形如 `3 [168/495]`：取开头数字 1-4
fn parse_cas_quartile(field: &str) -> Option<u8> {
    field
        .split_whitespace()
        .next()?
        .parse::<u8>()
        .ok()
        .filter(|q| (1..=4).contains(q))
}

/// 解析中科院分区表：填 cas_quartile / top，返回数据行提取的年份（若有）
fn parse_fqb(text: &str, map: &mut HashMap<String, JournalMetricsDto>) -> Option<u16> {
    let clean = strip_bom(text);
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(clean.as_bytes());
    let Ok(headers) = rdr.headers().cloned() else {
        return None;
    };
    let (Some(i_journal), Some(i_quartile), Some(i_top)) = (
        col_index(&headers, "Journal", None),
        col_index(&headers, "大类分区", None),
        col_index(&headers, "Top", None),
    ) else {
        return None;
    };
    let i_year = col_index(&headers, "年份", None);
    let mut row_year: Option<u16> = None;
    for rec in rdr.records().flatten() {
        let Some(journal) = rec.get(i_journal) else {
            continue;
        };
        if row_year.is_none() {
            row_year = i_year
                .and_then(|idx| rec.get(idx))
                .and_then(extract_year);
        }
        let quartile = rec.get(i_quartile).and_then(parse_cas_quartile);
        let top = rec.get(i_top).is_some_and(|t| t.trim() == "是");
        // 两列都空（分区表尾部空行等）就不建条目
        if quartile.is_none() && !top {
            continue;
        }
        if let Some(e) = entry_for(map, journal) {
            e.cas_quartile = quartile;
            e.top = top;
        }
    }
    row_year
}

/// 校验下载/导入的 CSV 字节是否有效（至少解析出 min_entries 条期刊，防错误 HTML 页面污染本地表）
fn validate_csv_bytes(kind: TableKind, bytes: &[u8], min_entries: usize) -> Result<usize, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "文件不是有效的 UTF-8 CSV".to_string())?;
    let mut map = HashMap::new();
    match kind {
        TableKind::Jcr => {
            parse_jcr(text, &mut map);
        }
        TableKind::Fqb => {
            parse_fqb(text, &mut map);
        }
    }
    if map.len() < min_entries {
        return Err(format!(
            "文件内容校验未通过（仅解析出 {} 条有效期刊，期望至少 {} 条）",
            map.len(),
            min_entries
        ));
    }
    Ok(map.len())
}

// ===== 查询 =====

/// 规范化后的精确匹配（注入表，便于单测）；miss 时逐级剥掉末尾的出版商括号尾巴
/// （巡检来源常写成「Advanced Functional Materials (Wiley)」「…（ACS）」，表里没有这截）再重试
fn lookup_in(
    table: &HashMap<String, JournalMetricsDto>,
    journal_name: &str,
) -> Option<JournalMetricsDto> {
    let mut name = journal_name.trim().to_string();
    loop {
        let key = crate::lit_watch::normalize_title(&name);
        if !key.is_empty() {
            if let Some(m) = table.get(&key) {
                return Some(m.clone());
            }
        }
        match strip_trailing_paren(&name) {
            Some(rest) => name = rest,
            None => return None,
        }
    }
}

/// 剥掉末尾括号段（半角/全角，可多级），返回剩余部分；没有可剥的返回 None
fn strip_trailing_paren(name: &str) -> Option<String> {
    let t = name.trim_end();
    let open = if t.ends_with(')') {
        '('
    } else if t.ends_with('）') {
        '（'
    } else {
        return None;
    };
    let idx = t.rfind(open)?;
    let rest = t[..idx].trim();
    if rest.is_empty() {
        return None;
    }
    Some(rest.to_string())
}

/// 文献雷达 enrichment 用：规范化精确匹配，miss / 无表文件返回 None
pub(crate) fn lookup(journal_name: &str) -> Option<JournalMetricsDto> {
    lookup_in(&table().by_name, journal_name)
}

/// 检索清单的第二把钥匙：ISSN / EISSN 去横线、转大写后精确匹配。长度不是 8 的不查。
fn normalize_issn(raw: &str) -> String {
    let key: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let key = key.to_ascii_uppercase();
    if key.len() == 8 { key } else { String::new() }
}

fn remember_issn(into: &mut HashMap<String, String>, journal: &str, raw: &str) {
    let name = crate::lit_watch::normalize_title(journal.trim());
    let issn = normalize_issn(raw);
    if name.is_empty() || issn.is_empty() {
        return;
    }
    into.insert(issn, name);
}

/// 从 JCR 的 ISSN、EISSN 列记下「ISSN → 规范化刊名」
fn collect_jcr_issns(text: &str, into: &mut HashMap<String, String>) {
    let clean = strip_bom(text);
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(clean.as_bytes());
    let Ok(headers) = rdr.headers().cloned() else {
        return;
    };
    let Some(i_journal) = col_index(&headers, "Journal", None) else {
        return;
    };
    let i_issn = col_index(&headers, "ISSN", None);
    let i_eissn = col_index(&headers, "EISSN", None);
    if i_issn.is_none() && i_eissn.is_none() {
        return;
    }
    for rec in rdr.records().flatten() {
        let Some(journal) = rec.get(i_journal) else { continue };
        for idx in [i_issn, i_eissn].into_iter().flatten() {
            if let Some(raw) = rec.get(idx) {
                remember_issn(into, journal, raw);
            }
        }
    }
}

/// 中科院表的 `ISSN/EISSN` 是 `印刷/电子`，斜杠两边各记一条
fn collect_fqb_issns(text: &str, into: &mut HashMap<String, String>) {
    let clean = strip_bom(text);
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(clean.as_bytes());
    let Ok(headers) = rdr.headers().cloned() else {
        return;
    };
    let (Some(i_journal), Some(i_issn)) = (
        col_index(&headers, "Journal", None),
        col_index(&headers, "ISSN/EISSN", None),
    ) else {
        return;
    };
    for rec in rdr.records().flatten() {
        let (Some(journal), Some(raw)) = (rec.get(i_journal), rec.get(i_issn)) else {
            continue;
        };
        for part in raw.split(['/', '／']) {
            remember_issn(into, journal, part);
        }
    }
}

struct MetricsTables {
    by_name: HashMap<String, JournalMetricsDto>,
    /// ISSN → 规范化刊名。解析完两表后再指回 by_name，避免先克隆丢分区。
    issn_to_name: HashMap<String, String>,
    jcr_year: Option<u16>,
    fqb_year: Option<u16>,
}

fn load_tables() -> MetricsTables {
    let mut by_name = HashMap::new();
    let mut issn_to_name = HashMap::new();
    let mut jcr_year = None;
    let mut fqb_year = None;
    let Some(dir) = metrics_dir() else {
        return MetricsTables {
            by_name,
            issn_to_name,
            jcr_year,
            fqb_year,
        };
    };
    let sel = discover_local_files(&dir);
    if let Some(path) = &sel.jcr_path {
        if let Ok(text) = fs::read_to_string(path) {
            let parsed_year = parse_jcr(&text, &mut by_name);
            collect_jcr_issns(&text, &mut issn_to_name);
            jcr_year = sel.jcr_year.or(parsed_year);
        }
    }
    if let Some(path) = &sel.fqb_path {
        if let Ok(text) = fs::read_to_string(path) {
            let parsed_year = parse_fqb(&text, &mut by_name);
            collect_fqb_issns(&text, &mut issn_to_name);
            fqb_year = sel.fqb_year.or(parsed_year);
        }
    }
    MetricsTables {
        by_name,
        issn_to_name,
        jcr_year,
        fqb_year,
    }
}

fn lookup_issn_in(tables: &MetricsTables, issn: &str) -> Option<JournalMetricsDto> {
    for key in issn_keys(issn) {
        if let Some(name) = tables.issn_to_name.get(&key) {
            if let Some(found) = tables.by_name.get(name) {
                return Some(found.clone());
            }
        }
    }
    None
}

/// 一条记录里常写成「印刷号, 电子号」或用斜杠、分号隔开。逐个按 8 位去对，不把两段拼成一条。
fn issn_keys(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in raw.split(|c: char| !c.is_ascii_alphanumeric() && c != '-') {
        let key = normalize_issn(part);
        if key.len() == 8 && !out.contains(&key) {
            out.push(key);
        }
    }
    if out.is_empty() {
        let whole = normalize_issn(raw);
        if whole.len() == 8 {
            out.push(whole);
        }
    }
    out
}

/// 刊名优先，对不上再用 ISSN。两边都空或都未收录返回 None。
fn resolve_metrics(tables: &MetricsTables, venue: &str, issn: &str) -> Option<JournalMetricsDto> {
    if let Some(found) = lookup_in(&tables.by_name, venue) {
        return Some(found);
    }
    lookup_issn_in(tables, issn)
}

// ===== helper：给 Agent 查影响因子（2026-11-10 HER：人按「IF ≥ 10」退回，AI 手里没有影响因子只能凭记忆估） =====

/// 注入 Agent 进程的变量名：值是 helper 路径，检索技能的 `lit_records.py impact` 按它查
pub const TOOL_ENV: &str = "MESA_JOURNAL_TOOL";

/// 认得 `journal` 的随包 helper（试跑 `journal --probe`；旧 helper 不认就不注入）
pub fn helper_exe() -> Option<PathBuf> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHE
        .get_or_init(|| crate::image_gen::find_bundled_helper("journal"))
        .clone()
}

/// 按 included.json 每条的 venue / issn 查，与评审清单徽章同一套匹配（resolve_metrics，不联网）。
/// 输出 `{ "<id>": {"impactFactor": "9.5", "casQuartile": 1, "top": true} | null }`；表没装返回 Err
fn journal_lookup_json(text: &str, tables: &MetricsTables) -> Result<String, String> {
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(text).map_err(|e| format!("included.json 解析失败：{e}"))?;
    let mut out = serde_json::Map::new();
    for row in &rows {
        let Some(id) = row.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let field = |k: &str| row.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let hit = resolve_metrics(tables, &field("venue"), &field("issn"));
        out.insert(
            id.to_string(),
            serde_json::to_value(hit).unwrap_or(serde_json::Value::Null),
        );
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

/// `mesa_helper journal <papers/included.json>`：只读、不改文件，结果打到标准输出（lit_records.py impact 合进 json）。
/// 退出码：0 成功、2 参数错、3 期刊指标表没装或读不了
pub fn helper_journal_cli(args: &[String]) -> i32 {
    let Some(path) = args.first() else {
        eprintln!("用法：mesa_helper journal <papers/included.json>");
        return 2;
    };
    if path == "--probe" {
        println!("ok");
        return 0;
    }
    let tables = table();
    if tables.by_name.is_empty() {
        eprintln!("期刊指标表还没就绪（可能正在后台下载或网络未连通）：请稍候或在 Mesa 的检索清单顶上点「下载期刊指标表」后再查；影响因子不要凭记忆估");
        return 3;
    }
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("读不了 {path}：{e}");
            return 2;
        }
    };
    match journal_lookup_json(&text, &tables) {
        Ok(json) => {
            println!("{json}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            2
        }
    }
}

/// 本地表的下载时间：已选中的 CSV 文件 mtime 取较新者
fn local_downloaded_at() -> Option<String> {
    let dir = metrics_dir()?;
    let sel = discover_local_files(&dir);
    let mut newest: Option<std::time::SystemTime> = None;
    for path in [sel.jcr_path, sel.fqb_path].into_iter().flatten() {
        if let Ok(mtime) = fs::metadata(&path).and_then(|m| m.modified()) {
            newest = Some(newest.map_or(mtime, |cur| cur.max(mtime)));
        }
    }
    newest.map(|t| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339())
}

fn compute_status() -> JournalMetricsStatusDto {
    let t = table();
    JournalMetricsStatusDto {
        available: !t.by_name.is_empty(),
        journal_count: t.by_name.len() as u32,
        downloaded_at: local_downloaded_at(),
        jcr_year: t.jcr_year,
        fqb_year: t.fqb_year,
        downloading: is_downloading(),
    }
}

// ===== 同步元数据读写 =====

fn sync_meta_path() -> Option<PathBuf> {
    Some(metrics_dir()?.join(SYNC_META_FILE))
}

fn read_sync_meta() -> SyncMeta {
    let Some(path) = sync_meta_path() else {
        return SyncMeta::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_sync_meta(meta: &SyncMeta) {
    let Some(path) = sync_meta_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(meta) {
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
}

fn is_within_duration(rfc3339: &str, max_age: std::time::Duration) -> bool {
    let Ok(ts) = chrono::DateTime::parse_from_rfc3339(rfc3339) else {
        return false;
    };
    let now = chrono::Utc::now();
    let elapsed = now.signed_duration_since(ts.with_timezone(&chrono::Utc));
    elapsed.num_seconds() >= 0 && (elapsed.num_seconds() as u64) < max_age.as_secs()
}

// ===== HTTP 客户端与出网代理 =====

/// 与 model_registry 同口径：设置里填了有效出网代理时自动挂载
fn outbound_proxy() -> Option<String> {
    if cfg!(test) {
        return None;
    }
    let s = crate::settings::read_current();
    s.outbound_proxy
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty() && crate::settings::validate_outbound_proxy(p).is_ok())
        .map(str::to_string)
}

fn build_http_client(
    connect_timeout: std::time::Duration,
    total_timeout: std::time::Duration,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .timeout(total_timeout)
        .user_agent(USER_AGENT);
    if let Some(p) = outbound_proxy() {
        builder = builder.proxy(reqwest::Proxy::all(&p).map_err(|e| format!("出网代理不可用：{e}"))?);
    }
    builder
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

// ===== 远端发现：可选指针 → jsDelivr 文件列表 → Gitee API → GitHub API =====

/// 从 jsDelivr flat 文件列表 JSON 提取数据目录下的 CSV 文件名
fn parse_jsdelivr_file_list(body: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(files) = v.get("files").and_then(|f| f.as_array()) else {
        return Vec::new();
    };
    let prefix = format!("/{REMOTE_DIR_RAW}/");
    files
        .iter()
        .filter_map(|item| item.get("name")?.as_str())
        .filter_map(|path| path.strip_prefix(&prefix))
        .filter(|rel| !rel.contains('/') && rel.to_ascii_lowercase().ends_with(".csv"))
        .map(str::to_string)
        .collect()
}

/// 从 GitHub / Gitee Contents API 数组响应提取 CSV 文件名
fn parse_contents_api_names(body: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(items) = v.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| item.get("name")?.as_str())
        .filter(|name| name.to_ascii_lowercase().ends_with(".csv"))
        .map(str::to_string)
        .collect()
}

/// 从 GitHub / Gitee commits API 响应提取最近 commit 时间（注入文本，便于单测）
fn parse_upstream_commit_date(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let date = v
        .as_array()?
        .first()?
        .get("commit")?
        .get("committer")?
        .get("date")?
        .as_str()?;
    Some(date.to_string())
}

fn manifest_to_discovery(m: MetricsManifest) -> RemoteDiscovery {
    RemoteDiscovery {
        jcr: m.jcr.map(|e| RemoteTarget {
            year: e.year.or_else(|| extract_year(&e.file)),
            file: e.file,
            custom_urls: e.urls,
        }),
        fqb: m.fqb.map(|e| RemoteTarget {
            year: e.year.or_else(|| extract_year(&e.file)),
            file: e.file,
            custom_urls: e.urls,
        }),
        upstream_updated_at: m.updated_at,
    }
}

/// 读取可选数据源指针：优先本机 `sources.json`，其次环境变量 `MESA_JOURNAL_MANIFEST_URL`
async fn load_manifest_override(client: &reqwest::Client) -> Option<RemoteDiscovery> {
    if let Some(path) = metrics_dir().map(|d| d.join(SOURCES_MANIFEST_FILE)) {
        if let Ok(text) = fs::read_to_string(path) {
            if let Ok(m) = serde_json::from_str::<MetricsManifest>(&text) {
                if m.jcr.is_some() || m.fqb.is_some() {
                    return Some(manifest_to_discovery(m));
                }
            }
        }
    }
    if let Ok(url) = std::env::var("MESA_JOURNAL_MANIFEST_URL") {
        let url = url.trim();
        if url.starts_with("https://") || url.starts_with("http://") {
            if let Ok(resp) = client.get(url).send().await {
                if resp.status().is_success() {
                    if let Ok(bytes) = crate::storage::response_bytes(resp, 512 * 1024).await {
                        if let Ok(m) = serde_json::from_slice::<MetricsManifest>(&bytes) {
                            if m.jcr.is_some() || m.fqb.is_some() {
                                return Some(manifest_to_discovery(m));
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

fn discovery_from_csv_names(names: &[String], updated_at: Option<String>) -> Option<RemoteDiscovery> {
    let jcr = pick_latest_csv(names, TableKind::Jcr).map(|(file, year)| RemoteTarget {
        file,
        year,
        custom_urls: Vec::new(),
    });
    let fqb = pick_latest_csv(names, TableKind::Fqb).map(|(file, year)| RemoteTarget {
        file,
        year,
        custom_urls: Vec::new(),
    });
    if jcr.is_none() && fqb.is_none() {
        return None;
    }
    Some(RemoteDiscovery {
        jcr,
        fqb,
        upstream_updated_at: updated_at,
    })
}

async fn fetch_commit_date(client: &reqwest::Client) -> Option<String> {
    let urls = [
        format!(
            "https://gitee.com/api/v5/repos/hitfyd/ShowJCR/commits?path={REMOTE_DIR}&per_page=1"
        ),
        format!(
            "https://api.github.com/repos/hitfyd/ShowJCR/commits?path={REMOTE_DIR}&per_page=1"
        ),
    ];
    for url in urls {
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(bytes) = crate::storage::response_bytes(resp, 512 * 1024).await {
                    let body = String::from_utf8_lossy(&bytes);
                    if let Some(date) = parse_upstream_commit_date(&body) {
                        return Some(date);
                    }
                }
            }
        }
    }
    None
}

/// 发现远端最新的 JCR 与中科院分区表文件名（不依赖单一 API，避免 GitHub 60次/小时限流）
async fn discover_remote(client: &reqwest::Client, with_commit_date: bool) -> Result<RemoteDiscovery, String> {
    if let Some(m) = load_manifest_override(client).await {
        return Ok(m);
    }

    let mut discovered: Option<RemoteDiscovery> = None;

    // 1. jsDelivr 文件列表 API（全球/国内 CDN，无 GitHub 匿名限流）
    let jsdelivr_url = "https://data.jsdelivr.com/v1/packages/gh/hitfyd/ShowJCR@master?structure=flat";
    if let Ok(resp) = client.get(jsdelivr_url).send().await {
        if resp.status().is_success() {
            if let Ok(bytes) = crate::storage::response_bytes(resp, 4 * 1024 * 1024).await {
                let names = parse_jsdelivr_file_list(&String::from_utf8_lossy(&bytes));
                discovered = discovery_from_csv_names(&names, None);
            }
        }
    }

    // 2. Gitee Contents API（国内直连）
    if discovered.is_none() {
        let gitee_url =
            format!("https://gitee.com/api/v5/repos/hitfyd/ShowJCR/contents/{REMOTE_DIR}");
        if let Ok(resp) = client.get(&gitee_url).send().await {
            if resp.status().is_success() {
                if let Ok(bytes) = crate::storage::response_bytes(resp, 2 * 1024 * 1024).await {
                    let names = parse_contents_api_names(&String::from_utf8_lossy(&bytes));
                    discovered = discovery_from_csv_names(&names, None);
                }
            }
        }
    }

    // 3. GitHub Contents API（兜底）
    if discovered.is_none() {
        let gh_url =
            format!("https://api.github.com/repos/hitfyd/ShowJCR/contents/{REMOTE_DIR}");
        if let Ok(resp) = client.get(&gh_url).send().await {
            if resp.status().is_success() {
                if let Ok(bytes) = crate::storage::response_bytes(resp, 2 * 1024 * 1024).await {
                    let names = parse_contents_api_names(&String::from_utf8_lossy(&bytes));
                    discovered = discovery_from_csv_names(&names, None);
                }
            }
        }
    }

    let mut result = discovered.ok_or_else(|| "无法获取远端期刊指标表目录".to_string())?;
    if with_commit_date && result.upstream_updated_at.is_none() {
        result.upstream_updated_at = fetch_commit_date(client).await;
    }
    Ok(result)
}

/// 构造某个 CSV 的多镜像下载地址（自定义源置顶 → jsDelivr → Fastly jsDelivr → Gitee raw → GitHub raw）
fn mirror_urls_for(file_name: &str, custom_urls: &[String]) -> Vec<String> {
    let mut urls = Vec::with_capacity(custom_urls.len() + 4);
    for u in custom_urls {
        let trimmed = u.trim();
        if !trimmed.is_empty() && !urls.iter().any(|x| x == trimmed) {
            urls.push(trimmed.to_string());
        }
    }
    let defaults = [
        format!("https://cdn.jsdelivr.net/gh/hitfyd/ShowJCR@master/{REMOTE_DIR}/{file_name}"),
        format!("https://fastly.jsdelivr.net/gh/hitfyd/ShowJCR@master/{REMOTE_DIR}/{file_name}"),
        format!("https://gitee.com/hitfyd/ShowJCR/raw/master/{REMOTE_DIR}/{file_name}"),
        format!("https://raw.githubusercontent.com/hitfyd/ShowJCR/master/{REMOTE_DIR}/{file_name}"),
    ];
    for u in defaults {
        if !urls.iter().any(|x| x == &u) {
            urls.push(u);
        }
    }
    urls
}

/// 目录发现全部不可用时的兜底候选文件名（从当前年份倒推到 2025）
fn fallback_candidate_files(kind: TableKind, current_year: u16) -> Vec<(String, u16)> {
    let start = current_year.clamp(2025, 2099);
    let mut out = Vec::new();
    for y in (2025..=start).rev() {
        let name = match kind {
            TableKind::Jcr => format!("JCR{y}-UTF8.csv"),
            TableKind::Fqb => format!("FQBJCR{y}-UTF8.csv"),
        };
        out.push((name, y));
    }
    if out.is_empty() {
        let fallback = match kind {
            TableKind::Jcr => (FALLBACK_JCR_FILE.to_string(), 2025),
            TableKind::Fqb => (FALLBACK_FQB_FILE.to_string(), 2025),
        };
        out.push(fallback);
    }
    out
}

/// 下载并校验一份 CSV：多镜像顺序尝试，任何镜像内容校验不过立刻切下一个
async fn fetch_and_validate_csv(
    client: &reqwest::Client,
    kind: TableKind,
    file_name: &str,
    custom_urls: &[String],
) -> Result<Vec<u8>, String> {
    let urls = mirror_urls_for(file_name, custom_urls);
    let mut last_err = String::new();
    for url in &urls {
        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => {
                match crate::storage::response_bytes(resp, 32 * 1024 * 1024).await {
                    Ok(bytes) => match validate_csv_bytes(kind, &bytes, MIN_REMOTE_JOURNALS) {
                        Ok(_) => return Ok(bytes),
                        Err(e) => last_err = e,
                    },
                    Err(e) => last_err = e,
                }
            }
            Ok(resp) => last_err = format!("HTTP {}", resp.status()),
            Err(e) => last_err = format!("{e}"),
        }
    }
    Err(format!(
        "下载 {file_name} 失败（全部镜像均不可达或内容无效）: {last_err}"
    ))
}

/// 落盘：先写 .tmp 再原子改名（同 lit_watch 下载口径）
fn save_csv(dir: &Path, file_name: &str, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let tmp = dir.join(format!("{file_name}.tmp"));
    fs::write(&tmp, bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    fs::rename(&tmp, dir.join(file_name)).map_err(|e| format!("改名落盘失败: {e}"))?;
    Ok(())
}

/// 新年份表落盘成功后，清掉同类型更早年份的托管 CSV，避免旧文件残留
fn cleanup_older_managed_csvs(dir: &Path, kind: TableKind, keep_file: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name == keep_file {
            continue;
        }
        if let Some((k, _, _)) = classify_csv_filename(name) {
            if k == kind {
                let _ = fs::remove_file(path);
            }
        }
    }
}

/// 执行一次完整下载（支持跨年自动发现 + 多镜像回落 + 原子落盘 + 清理旧版）
async fn download_latest_tables_impl() -> Result<JournalMetricsStatusDto, String> {
    let Some(_guard) = DownloadGuard::try_acquire() else {
        return Err("期刊指标表正在下载中，请稍候".into());
    };
    let discovery_client = build_http_client(CONNECT_TIMEOUT, UPDATE_CHECK_TIMEOUT)?;
    let download_client = build_http_client(CONNECT_TIMEOUT, DOWNLOAD_TIMEOUT)?;

    let discovery = discover_remote(&discovery_client, true).await.ok();
    let current_year = chrono::Local::now().year() as u16;

    let mut downloads: Vec<(TableKind, String, Option<u16>, Vec<u8>)> = Vec::new();
    for kind in [TableKind::Jcr, TableKind::Fqb] {
        let target = discovery.as_ref().and_then(|d| match kind {
            TableKind::Jcr => d.jcr.clone(),
            TableKind::Fqb => d.fqb.clone(),
        });
        if let Some(t) = target {
            let bytes =
                fetch_and_validate_csv(&download_client, kind, &t.file, &t.custom_urls).await?;
            downloads.push((kind, t.file, t.year, bytes));
        } else {
            // 目录 API 不可用：按年份倒序尝试直连下载
            let mut last_err = String::new();
            let mut hit = None;
            for (cand_file, cand_year) in fallback_candidate_files(kind, current_year) {
                match fetch_and_validate_csv(&download_client, kind, &cand_file, &[]).await {
                    Ok(bytes) => {
                        hit = Some((cand_file, Some(cand_year), bytes));
                        break;
                    }
                    Err(e) => last_err = e,
                }
            }
            match hit {
                Some((file, year, bytes)) => downloads.push((kind, file, year, bytes)),
                None => return Err(last_err),
            }
        }
    }

    let upstream_updated_at = discovery.and_then(|d| d.upstream_updated_at);
    tauri::async_runtime::spawn_blocking(move || {
        let dir = metrics_dir().ok_or("无法定位应用数据目录")?;
        let mut meta = read_sync_meta();
        let now_rfc = chrono::Local::now().to_rfc3339();
        meta.last_checked_at = Some(now_rfc);
        if let Some(up) = upstream_updated_at {
            meta.upstream_updated_at = Some(up);
        }
        for (kind, name, year, bytes) in &downloads {
            save_csv(&dir, name, bytes)?;
            cleanup_older_managed_csvs(&dir, *kind, name);
            match kind {
                TableKind::Jcr => {
                    meta.jcr_file = Some(name.clone());
                    meta.latest_jcr_year = *year;
                }
                TableKind::Fqb => {
                    meta.fqb_file = Some(name.clone());
                    meta.latest_fqb_year = *year;
                }
            }
        }
        write_sync_meta(&meta);
        invalidate_cache();
        Ok(compute_status())
    })
    .await
    .map_err(|e| format!("保存期刊指标表失败: {e}"))?
}

// ===== 更新判定与后台自动同步 =====

/// 上游是否比本地表新：两边时间都能解析才比较，解析失败按「无新版」（不虚构提醒）
fn upstream_is_newer(upstream: &str, local: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(upstream),
        chrono::DateTime::parse_from_rfc3339(local),
    ) {
        (Ok(u), Ok(l)) => u > l,
        _ => false,
    }
}

/// 综合年份与上游时间判定是否有新版（纯函数，便于单测）
fn evaluate_has_update(
    local_jcr_year: Option<u16>,
    local_fqb_year: Option<u16>,
    local_downloaded_at: Option<&str>,
    remote_jcr_year: Option<u16>,
    remote_fqb_year: Option<u16>,
    upstream_updated_at: Option<&str>,
) -> bool {
    let Some(local_at) = local_downloaded_at else {
        return false;
    };
    if let (Some(r), Some(l)) = (remote_jcr_year, local_jcr_year) {
        if r > l {
            return true;
        }
    }
    if let (Some(r), Some(l)) = (remote_fqb_year, local_fqb_year) {
        if r > l {
            return true;
        }
    }
    // 已有明确年份且两表年份都没有升级时，如果上游只是改了无关文件（如 CCF / 预警名单），
    // 仍允许同年度勘误更新（当上游时间严格晚于本地下载时间）
    match upstream_updated_at {
        Some(up) => upstream_is_newer(up, local_at),
        None => false,
    }
}

/// 查上游是否有新版；`force=false` 时 24 小时内复用本地 sync-meta，避免频繁打开页面触发限流
async fn check_update_impl(force: bool) -> Result<JournalMetricsUpdateDto, String> {
    let status = tauri::async_runtime::spawn_blocking(compute_status)
        .await
        .map_err(|e| format!("读取期刊指标状态失败: {e}"))?;

    if !force {
        let cached = tauri::async_runtime::spawn_blocking(read_sync_meta)
            .await
            .unwrap_or_default();
        if let Some(checked) = cached.last_checked_at.as_deref() {
            if is_within_duration(checked, UPDATE_CHECK_COOLDOWN) {
                let has_update = evaluate_has_update(
                    status.jcr_year,
                    status.fqb_year,
                    status.downloaded_at.as_deref(),
                    cached.latest_jcr_year,
                    cached.latest_fqb_year,
                    cached.upstream_updated_at.as_deref(),
                );
                return Ok(JournalMetricsUpdateDto {
                    upstream_updated_at: cached.upstream_updated_at,
                    has_update,
                    latest_jcr_year: cached.latest_jcr_year,
                    latest_fqb_year: cached.latest_fqb_year,
                });
            }
        }
    }

    let client = build_http_client(CONNECT_TIMEOUT, UPDATE_CHECK_TIMEOUT)?;
    let discovery = discover_remote(&client, true).await?;
    let latest_jcr_year = discovery.jcr.as_ref().and_then(|t| t.year);
    let latest_fqb_year = discovery.fqb.as_ref().and_then(|t| t.year);
    let upstream = discovery.upstream_updated_at.clone();

    let meta_upstream = upstream.clone();
    let meta_jcr_file = discovery.jcr.as_ref().map(|t| t.file.clone());
    let meta_fqb_file = discovery.fqb.as_ref().map(|t| t.file.clone());
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let mut meta = read_sync_meta();
        meta.last_checked_at = Some(chrono::Local::now().to_rfc3339());
        if meta_upstream.is_some() {
            meta.upstream_updated_at = meta_upstream;
        }
        if latest_jcr_year.is_some() {
            meta.latest_jcr_year = latest_jcr_year;
        }
        if latest_fqb_year.is_some() {
            meta.latest_fqb_year = latest_fqb_year;
        }
        if meta_jcr_file.is_some() {
            meta.jcr_file = meta_jcr_file;
        }
        if meta_fqb_file.is_some() {
            meta.fqb_file = meta_fqb_file;
        }
        write_sync_meta(&meta);
    })
    .await;

    let has_update = evaluate_has_update(
        status.jcr_year,
        status.fqb_year,
        status.downloaded_at.as_deref(),
        latest_jcr_year,
        latest_fqb_year,
        upstream.as_deref(),
    );
    Ok(JournalMetricsUpdateDto {
        upstream_updated_at: upstream,
        has_update,
        latest_jcr_year,
        latest_fqb_year,
    })
}

/// 应用启动时调用（与 model_registry::spawn_auto_refresh 同口径）：
/// - 未装表：延迟 3 秒后后台静默下载，成功后广播 `journal-metrics-updated`；
/// - 已装表且距上次检查超过 14 天：后台轻查一次，确认有新版时静默更新并广播事件；
/// - 失败仅记日志不弹窗，前端仍可手动点更新或导入本地 CSV。
pub fn spawn_auto_refresh(app: tauri::AppHandle) {
    if cfg!(test) {
        return;
    }
    std::thread::spawn(move || {
        // 把启动前几秒 CPU 和网络让给主窗口与会话加载
        std::thread::sleep(std::time::Duration::from_secs(3));
        tauri::async_runtime::spawn(async move {
            let (available, need_check) = tauri::async_runtime::spawn_blocking(|| {
                let status = compute_status();
                if !status.available {
                    return (false, true);
                }
                let meta = read_sync_meta();
                let checked_recently = meta
                    .last_checked_at
                    .as_deref()
                    .or(status.downloaded_at.as_deref())
                    .is_some_and(|ts| is_within_duration(ts, AUTO_REFRESH_INTERVAL));
                (true, !checked_recently)
            })
            .await
            .unwrap_or((false, false));

            if !need_check {
                return;
            }

            let should_download = if !available {
                true
            } else {
                match check_update_impl(true).await {
                    Ok(u) => u.has_update,
                    Err(e) => {
                        crate::logbuf::record(
                            "info",
                            "journal_metrics",
                            &format!("后台检查期刊指标表更新跳过: {e}"),
                        );
                        false
                    }
                }
            };

            if !should_download {
                return;
            }

            match download_latest_tables_impl().await {
                Ok(status) => {
                    crate::logbuf::record(
                        "info",
                        "journal_metrics",
                        &format!(
                            "期刊指标表已自动就绪（{} 种期刊，JCR={:?}，中科院={:?}）",
                            status.journal_count, status.jcr_year, status.fqb_year
                        ),
                    );
                    let _ = app.emit(EVENT_UPDATED, &status);
                }
                Err(e) => {
                    crate::logbuf::record(
                        "warn",
                        "journal_metrics",
                        &format!("后台自动准备期刊指标表未成功（可稍后在界面重试）: {e}"),
                    );
                }
            }
        });
    });
}

// ===== DOI 补刊名（OpenAlex → Crossref） =====

/// 本地表对不上时才允许外查。已有 ISSN 也算本地能查，不再打 OpenAlex。
fn needs_remote_venue(tables: &MetricsTables, venue: &str, issn: &str) -> bool {
    resolve_metrics(tables, venue, issn).is_none()
}

fn doi_token(raw: &str) -> Option<String> {
    let marked = raw.trim().trim_start_matches("doi:").trim();
    let start = marked.find("10.")?;
    let tail = &marked[start..];
    let end = tail
        .find(|c: char| {
            c.is_whitespace() || matches!(c, '，' | '。' | '；' | ',' | ';' | ')' | '）')
        })
        .unwrap_or(tail.len());
    let doi = tail[..end].trim_end_matches(['.', ',']).to_string();
    if doi.len() > 8 && doi.contains('/') {
        Some(doi)
    } else {
        None
    }
}

fn encode_doi(doi: &str) -> String {
    let mut out = String::with_capacity(doi.len());
    for b in doi.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn source_names(source: &serde_json::Value) -> Option<(String, String)> {
    let venue = source
        .get("display_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let issn = source
        .get("issn_l")
        .and_then(|v| v.as_str())
        .or_else(|| {
            source
                .get("issn")
                .and_then(|v| v.as_array())
                .and_then(|list| list.iter().find_map(|v| v.as_str()))
        })
        .unwrap_or("")
        .trim()
        .to_string();
    if venue.is_empty() && issn.is_empty() {
        None
    } else {
        Some((venue, issn))
    }
}

/// OpenAlex：先主位置，主位置没有期刊时再在 locations 里找 type=journal。
fn openalex_venue(value: &serde_json::Value) -> Option<(String, String)> {
    if let Some(found) = value
        .pointer("/primary_location/source")
        .and_then(source_names)
    {
        if !found.0.is_empty() || !found.1.is_empty() {
            return Some(found);
        }
    }
    value
        .get("locations")
        .and_then(|v| v.as_array())
        .and_then(|list| {
            list.iter().find_map(|loc| {
                let source = loc.get("source")?;
                if source.get("type").and_then(|v| v.as_str()) != Some("journal") {
                    return None;
                }
                source_names(source)
            })
        })
}

/// Crossref 的 container-title 是期刊全称。不用 short-container-title，缩写对不上表。
fn crossref_venue(value: &serde_json::Value) -> Option<(String, String)> {
    let message = value.get("message").unwrap_or(value);
    let venue = message
        .get("container-title")
        .and_then(|v| v.as_array())
        .and_then(|list| list.iter().find_map(|v| v.as_str()))
        .unwrap_or("")
        .trim()
        .to_string();
    let issn = message
        .get("ISSN")
        .and_then(|v| v.as_array())
        .and_then(|list| list.iter().find_map(|v| v.as_str()))
        .unwrap_or("")
        .trim()
        .to_string();
    if venue.is_empty() && issn.is_empty() {
        None
    } else {
        Some((venue, issn))
    }
}

async fn get_json(client: &reqwest::Client, url: &str) -> Option<serde_json::Value> {
    client.get(url).send().await.ok()?.json().await.ok()
}

/// 刊名缺失时按 DOI 补全称和 ISSN。OpenAlex 没有期刊就问 Crossref。数字仍只认本地表。
async fn venue_for_doi(client: &reqwest::Client, doi: &str) -> Option<(String, String)> {
    let encoded = encode_doi(doi);
    let openalex = format!(
        "https://api.openalex.org/works/https://doi.org/{encoded}?mailto=hong.tongzhou@zetatechs.com"
    );
    if let Some(value) = get_json(client, &openalex).await {
        if let Some(found) = openalex_venue(&value) {
            if !found.0.is_empty() || !found.1.is_empty() {
                return Some(found);
            }
        }
    }
    let crossref = format!("https://api.crossref.org/works/{encoded}");
    get_json(client, &crossref)
        .await
        .and_then(|value| crossref_venue(&value))
}

// ===== Tauri commands =====

/// 检索清单现查：按入参顺序返回，未收录或表未装为 null。不写项目文件。
#[tauri::command]
pub async fn lookup_journal_metrics(
    queries: Vec<JournalMetricsQuery>,
) -> Result<Vec<Option<JournalMetricsDto>>, String> {
    let tables = tauri::async_runtime::spawn_blocking(table)
        .await
        .map_err(|e| format!("读取期刊指标表失败: {e}"))?;
    let mut out: Vec<Option<JournalMetricsDto>> = queries
        .iter()
        .map(|q| resolve_metrics(&tables, &q.venue, &q.issn))
        .collect();
    let missing: Vec<usize> = queries
        .iter()
        .enumerate()
        .filter(|(i, q)| {
            out[*i].is_none()
                && needs_remote_venue(&tables, &q.venue, &q.issn)
                && doi_token(&q.doi).is_some()
        })
        .map(|(i, _)| i)
        .collect();
    if missing.is_empty() {
        return Ok(out);
    }
    let client = build_http_client(
        std::time::Duration::from_secs(8),
        std::time::Duration::from_secs(12),
    )?;
    for chunk in missing.chunks(6) {
        let mut jobs = Vec::with_capacity(chunk.len());
        for &idx in chunk {
            let doi = doi_token(&queries[idx].doi).unwrap_or_default();
            let client = client.clone();
            jobs.push(tauri::async_runtime::spawn(async move {
                venue_for_doi(&client, &doi).await
            }));
        }
        for (idx, job) in chunk.iter().zip(jobs) {
            let Ok(Some((venue, issn))) = job.await else {
                continue;
            };
            out[*idx] = resolve_metrics(&tables, &venue, &issn);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn journal_metrics_status() -> Result<JournalMetricsStatusDto, String> {
    tauri::async_runtime::spawn_blocking(compute_status)
        .await
        .map_err(|e| format!("读取期刊指标状态失败: {e}"))
}

#[tauri::command]
pub async fn download_journal_metrics(
    app: tauri::AppHandle,
) -> Result<JournalMetricsStatusDto, String> {
    let status = download_latest_tables_impl().await?;
    let _ = app.emit(EVENT_UPDATED, &status);
    Ok(status)
}

#[tauri::command]
pub async fn check_journal_metrics_update(
    force: Option<bool>,
) -> Result<JournalMetricsUpdateDto, String> {
    check_update_impl(force.unwrap_or(false)).await
}

/// 手动导入本地 CSV 兜底（断网或使用本单位/自定义最新表）：按表头自动识别 JCR / 中科院分区表
#[tauri::command]
pub async fn import_journal_metrics_csv(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<JournalMetricsStatusDto, String> {
    if paths.is_empty() {
        return Err("请选择至少一份 CSV 文件".into());
    }
    let status = tauri::async_runtime::spawn_blocking(move || {
        let dir = metrics_dir().ok_or("无法定位应用数据目录")?;
        let mut imported = 0usize;
        for raw in paths {
            let src = PathBuf::from(raw.trim());
            let bytes = fs::read(&src).map_err(|e| format!("读取 {} 失败: {e}", src.display()))?;
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| format!("{} 不是 UTF-8 编码的 CSV", src.display()))?;
            let (kind, sniff_year) = sniff_csv_kind(text).ok_or_else(|| {
                format!(
                    "{} 缺少可识别的表头（需要包含 Journal 及 IF(…) 或 大类分区 列）",
                    src.display()
                )
            })?;
            validate_csv_bytes(kind, &bytes, 1)?;
            let orig_name = src
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("custom.csv");
            let year = extract_year(orig_name).or(sniff_year);
            let target_name = match (kind, year) {
                (TableKind::Jcr, Some(y)) => format!("JCR{y}-UTF8.csv"),
                (TableKind::Fqb, Some(y)) => format!("FQBJCR{y}-UTF8.csv"),
                (TableKind::Jcr, None) => "JCR-custom-UTF8.csv".to_string(),
                (TableKind::Fqb, None) => "FQBJCR-custom-UTF8.csv".to_string(),
            };
            save_csv(&dir, &target_name, &bytes)?;
            cleanup_older_managed_csvs(&dir, kind, &target_name);
            imported += 1;
        }
        if imported == 0 {
            return Err("没有导入任何有效文件".into());
        }
        invalidate_cache();
        Ok::<_, String>(compute_status())
    })
    .await
    .map_err(|e| format!("导入期刊指标表失败: {e}"))??;
    let _ = app.emit(EVENT_UPDATED, &status);
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    const JCR_SAMPLE: &str = "\
Journal,ISSN,EISSN,Web of Science,IF(2025),Category_1,IF Quartile(2025)_1,IF Rank(2025)_1
CA-A CANCER JOURNAL FOR CLINICIANS,0007-9235,1542-4863,SCIE,685.2,ONCOLOGY,Q1,1/333
Advanced Materials,0935-9648,1521-4095,SCIE,29.1,\"MATERIALS SCIENCE, MULTIDISCIPLINARY\",Q1,10/460
No Impact Journal,0000-0000,,ESCI,,CHEMISTRY,Q4,300/301
";

    const FQB_SAMPLE: &str = "\
Journal,年份,ISSN/EISSN,Review,OA Journal Index（OAJ）,Open Access,Web of Science,标注,大类,大类分区,Top,小类1,小类1分区
2D Materials,2025,2053-1583/2053-1583,否,否,否,SCIE,,材料科学,3 [168/495],否,\" MATERIALS SCIENCE, MULTIDISCIPLINARY 材料科学：综合\",3 [168/436]
Advanced Materials,2025,0935-9648/1521-4095,否,否,否,SCIE,,材料科学,1 [8/495],是, MATERIALS SCIENCE 材料科学,1 [8/436]
";

    fn merged() -> HashMap<String, JournalMetricsDto> {
        let mut map = HashMap::new();
        parse_jcr(JCR_SAMPLE, &mut map);
        parse_fqb(FQB_SAMPLE, &mut map);
        map
    }

    #[test]
    fn journal_lookup_json_matches_by_venue_then_issn_and_nulls_misses() {
        let mut by_name = HashMap::new();
        by_name.insert(
            crate::lit_watch::normalize_title("Chemical Reviews"),
            JournalMetricsDto {
                impact_factor: Some("55.8".into()),
                cas_quartile: Some(1),
                top: true,
            },
        );
        by_name.insert(
            crate::lit_watch::normalize_title("Fuel"),
            JournalMetricsDto {
                impact_factor: Some("7.5".into()),
                cas_quartile: Some(2),
                top: false,
            },
        );
        let mut issn_to_name = HashMap::new();
        issn_to_name.insert(
            "00162361".to_string(),
            crate::lit_watch::normalize_title("Fuel"),
        );
        let tables = MetricsTables {
            by_name,
            issn_to_name,
            jcr_year: Some(2025),
            fqb_year: Some(2025),
        };
        let text = r#"[
            {"id":"a","venue":"Chemical Reviews","issn":"0009-2665"},
            {"id":"b","venue":"燃料（错写的刊名）","issn":"0016-2361"},
            {"id":"c","venue":"Unknown Journal","issn":"待补"}
        ]"#;
        let out: serde_json::Value =
            serde_json::from_str(&journal_lookup_json(text, &tables).unwrap()).unwrap();
        assert_eq!(out["a"]["impactFactor"], "55.8");
        assert_eq!(out["a"]["top"], true);
        assert_eq!(out["b"]["impactFactor"], "7.5");
        assert!(out["c"].is_null());
    }

    #[test]
    fn picks_latest_year_and_prefers_utf8_across_years() {
        let names: Vec<String> = [
            "JCR2023.csv",
            "JCR2025-UTF8.csv",
            "JCR2026.csv",
            "JCR2026-UTF8.csv",
            "FQBJCR2023-UTF8.csv",
            "FQBJCR2025-UTF8.csv",
            "FQBJCR2026-UTF8.csv",
            "CCF2026.csv",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(
            pick_latest_csv(&names, TableKind::Jcr),
            Some(("JCR2026-UTF8.csv".into(), Some(2026)))
        );
        assert_eq!(
            pick_latest_csv(&names, TableKind::Fqb),
            Some(("FQBJCR2026-UTF8.csv".into(), Some(2026)))
        );
    }

    #[test]
    fn parses_jsdelivr_and_contents_api_lists() {
        let jsdelivr = serde_json::json!({
            "files": [
                { "name": "/README.md" },
                { "name": format!("/{REMOTE_DIR_RAW}/JCR2025-UTF8.csv") },
                { "name": format!("/{REMOTE_DIR_RAW}/JCR2026-UTF8.csv") },
                { "name": format!("/{REMOTE_DIR_RAW}/FQBJCR2025-UTF8.csv") },
                { "name": format!("/{REMOTE_DIR_RAW}/sub/ignored.csv") }
            ]
        })
        .to_string();
        let names = parse_jsdelivr_file_list(&jsdelivr);
        assert_eq!(names.len(), 3);
        assert_eq!(
            pick_latest_csv(&names, TableKind::Jcr),
            Some(("JCR2026-UTF8.csv".into(), Some(2026)))
        );

        let contents = r#"[
            {"name":"JCR2024-UTF8.csv","type":"file"},
            {"name":"FQBJCR2026-UTF8.csv","type":"file"},
            {"name":"jcr.db","type":"file"}
        ]"#;
        let cnames = parse_contents_api_names(contents);
        assert_eq!(cnames, vec!["JCR2024-UTF8.csv", "FQBJCR2026-UTF8.csv"]);
    }

    #[test]
    fn handles_utf8_bom_and_sniffs_table_kind() {
        let jcr_bom = format!("\u{feff}{JCR_SAMPLE}");
        let mut map = HashMap::new();
        assert_eq!(parse_jcr(&jcr_bom, &mut map), Some(2025));
        assert_eq!(
            map.get("advancedmaterials")
                .and_then(|m| m.impact_factor.as_deref()),
            Some("29.1")
        );
        assert_eq!(sniff_csv_kind(&jcr_bom), Some((TableKind::Jcr, Some(2025))));
        assert_eq!(sniff_csv_kind(FQB_SAMPLE), Some((TableKind::Fqb, None)));
        assert_eq!(sniff_csv_kind("<html>404 Not Found</html>"), None);
        assert!(validate_csv_bytes(TableKind::Jcr, b"<html>404</html>", 1).is_err());
        assert!(validate_csv_bytes(TableKind::Jcr, jcr_bom.as_bytes(), 2).is_ok());
    }

    #[test]
    fn evaluate_update_detects_newer_year_or_timestamp() {
        let local = Some("2025-07-01T00:00:00Z");
        // 年份升级必判有新版（即便上游时间解析不到）
        assert!(evaluate_has_update(
            Some(2025),
            Some(2025),
            local,
            Some(2026),
            Some(2025),
            None
        ));
        assert!(evaluate_has_update(
            Some(2025),
            Some(2025),
            local,
            Some(2025),
            Some(2026),
            None
        ));
        // 年份相同且时间不更新：无新版
        assert!(!evaluate_has_update(
            Some(2025),
            Some(2025),
            local,
            Some(2025),
            Some(2025),
            Some("2025-06-20T00:00:00Z")
        ));
        // 本地未装表：恒 false
        assert!(!evaluate_has_update(
            None,
            None,
            None,
            Some(2026),
            Some(2026),
            Some("2026-07-01T00:00:00Z")
        ));
    }

    #[test]
    fn parses_upstream_commit_date() {
        let body = r#"[{"sha":"abc","commit":{"author":{"date":"2025-06-20T01:02:03Z"},"committer":{"date":"2025-06-21T04:05:06Z"}}}]"#;
        assert_eq!(
            parse_upstream_commit_date(body).as_deref(),
            Some("2025-06-21T04:05:06Z")
        );
        // 空数组 / 非 JSON / 缺字段都诚实 None
        assert_eq!(parse_upstream_commit_date("[]"), None);
        assert_eq!(parse_upstream_commit_date("not json"), None);
        assert_eq!(parse_upstream_commit_date(r#"[{"commit":{}}]"#), None);
    }

    #[test]
    fn upstream_newer_only_when_strictly_later() {
        let local = "2025-06-20T12:00:00+08:00";
        assert!(upstream_is_newer("2025-06-20T12:00:01+08:00", local));
        assert!(!upstream_is_newer("2025-06-20T12:00:00+08:00", local));
        assert!(!upstream_is_newer("2025-06-19T12:00:00+08:00", local));
        // 跨时区同一时刻不算新；解析失败不算新
        assert!(!upstream_is_newer("2025-06-20T04:00:00Z", local));
        assert!(!upstream_is_newer("garbage", local));
    }

    #[test]
    fn jcr_parses_quoted_comma_fields() {
        let mut map = HashMap::new();
        parse_jcr(JCR_SAMPLE, &mut map);
        // 带引号逗号的 Category 字段不得错位：IF 仍取到 29.1
        let m = map.get("advancedmaterials").unwrap();
        assert_eq!(m.impact_factor.as_deref(), Some("29.1"));
        assert_eq!(
            map.get("caacancerjournalforclinicians")
                .unwrap()
                .impact_factor
                .as_deref(),
            Some("685.2")
        );
        // IF 为空的刊不建条目
        assert!(map.get("noimpactjournal").is_none());
    }

    #[test]
    fn fqb_extracts_quartile_and_top() {
        let mut map = HashMap::new();
        assert_eq!(parse_fqb(FQB_SAMPLE, &mut map), Some(2025));
        let m2d = map.get("2dmaterials").unwrap();
        assert_eq!(m2d.cas_quartile, Some(3));
        assert!(!m2d.top);
        let am = map.get("advancedmaterials").unwrap();
        assert_eq!(am.cas_quartile, Some(1));
        assert!(am.top);
    }

    #[test]
    fn cas_quartile_parses_leading_digit() {
        assert_eq!(parse_cas_quartile("3 [168/495]"), Some(3));
        assert_eq!(parse_cas_quartile("1 [8/495]"), Some(1));
        assert_eq!(parse_cas_quartile(""), None);
        assert_eq!(parse_cas_quartile("-"), None);
        assert_eq!(parse_cas_quartile("9 [1/1]"), None); // 分区只有 1-4
    }

    #[test]
    fn merges_both_tables_into_one_entry() {
        let map = merged();
        let m = map.get("advancedmaterials").unwrap();
        assert_eq!(m.impact_factor.as_deref(), Some("29.1")); // 来自 JCR
        assert_eq!(m.cas_quartile, Some(1)); // 来自 FQB
        assert!(m.top);
        // 只在单表的刊也各有半边
        assert_eq!(map.get("2dmaterials").unwrap().impact_factor, None);
        assert_eq!(
            map.get("caacancerjournalforclinicians")
                .unwrap()
                .cas_quartile,
            None
        );
    }

    #[test]
    fn lookup_normalizes_case_and_punctuation() {
        let map = merged();
        // 大小写 / 标点 / 空格差异都应命中
        assert!(lookup_in(&map, "Advanced Materials").is_some());
        assert!(lookup_in(&map, "ADVANCED MATERIALS").is_some());
        assert!(lookup_in(&map, "advanced  materials!").is_some());
        assert!(lookup_in(&map, "2D Materials").is_some());
        assert!(lookup_in(&map, "CA: A Cancer Journal for Clinicians").is_some());
    }

    #[test]
    fn lookup_miss_returns_none() {
        let map = merged();
        assert!(lookup_in(&map, "Journal of Nonexistent Results").is_none());
        assert!(lookup_in(&map, "arxiv").is_none());
        assert!(lookup_in(&map, "").is_none());
        assert!(lookup_in(&map, "  ").is_none());
    }

    fn sample_tables() -> MetricsTables {
        let mut by_name = HashMap::new();
        let mut issn_to_name = HashMap::new();
        parse_jcr(JCR_SAMPLE, &mut by_name);
        collect_jcr_issns(JCR_SAMPLE, &mut issn_to_name);
        parse_fqb(FQB_SAMPLE, &mut by_name);
        collect_fqb_issns(FQB_SAMPLE, &mut issn_to_name);
        MetricsTables {
            by_name,
            issn_to_name,
            jcr_year: Some(2025),
            fqb_year: Some(2025),
        }
    }

    #[test]
    fn issn_hits_when_venue_is_abbreviation() {
        let tables = sample_tables();
        // 检索记录常写缩写，刊名对不上；ISSN 去横线后命中同一条
        let hit = resolve_metrics(&tables, "Adv. Mater.", "0935-9648").unwrap();
        assert_eq!(hit.impact_factor.as_deref(), Some("29.1"));
        assert_eq!(hit.cas_quartile, Some(1));
        assert!(hit.top);
        // 电子 ISSN、大小写、空格同样命中
        assert!(lookup_issn_in(&tables, "1521 4095").is_some());
        assert!(lookup_issn_in(&tables, "2053-1583").is_some());
        // 刊名优先：对得上就不用 ISSN
        let named = resolve_metrics(&tables, "Advanced Materials", "0000-0000").unwrap();
        assert_eq!(named.impact_factor.as_deref(), Some("29.1"));
        // 两边都空、ISSN 位数不对、表里没有，都不编数字
        assert!(resolve_metrics(&tables, "", "").is_none());
        assert!(resolve_metrics(&tables, "Adv. Mater.", "待补").is_none());
        assert!(resolve_metrics(&tables, "arxiv", "9999-9999").is_none());
        // 一条记录里两个 ISSN 用逗号或斜杠隔开，逐个对，不拼成一条
        assert!(lookup_issn_in(&tables, "0935-9648, 1521-4095").is_some());
        assert!(lookup_issn_in(&tables, "2053-1583/2053-1583").is_some());
        assert!(needs_remote_venue(&tables, "待补", ""));
        assert!(needs_remote_venue(&tables, "Adv. Mater.", ""));
        assert!(!needs_remote_venue(&tables, "Adv. Mater.", "0935-9648"));
        assert!(!needs_remote_venue(&tables, "Advanced Materials", ""));
    }

    #[test]
    fn doi_lookup_reads_journal_from_either_api() {
        let openalex = serde_json::json!({
            "primary_location": { "source": null },
            "locations": [
                { "source": { "type": "repository", "display_name": "PubMed" } },
                { "source": { "type": "journal", "display_name": "Advanced Materials", "issn_l": "0935-9648" } }
            ]
        });
        let (venue, issn) = openalex_venue(&openalex).unwrap();
        assert_eq!(venue, "Advanced Materials");
        assert_eq!(issn, "0935-9648");
        assert!(openalex_venue(&serde_json::json!({"primary_location": {"source": null}})).is_none());

        let crossref = serde_json::json!({
            "message": {
                "container-title": ["ChemistrySelect"],
                "short-container-title": ["ChemistrySelect"],
                "ISSN": ["2365-6549", "2365-6549"]
            }
        });
        let (venue, issn) = crossref_venue(&crossref).unwrap();
        assert_eq!(venue, "ChemistrySelect");
        assert_eq!(issn, "2365-6549");
        // 书章没有期刊全称
        assert!(crossref_venue(&serde_json::json!({"message": {"container-title": []}})).is_none());
    }

    #[test]
    fn lookup_strips_publisher_suffix() {
        let map = merged();
        // 巡检来源常带出版商尾巴：逐级剥掉末尾括号段后命中
        assert!(lookup_in(&map, "Advanced Materials (Wiley)").is_some());
        assert!(lookup_in(&map, "Advanced Materials（Wiley）").is_some());
        assert!(lookup_in(&map, "2D Materials (IOP) (UK)").is_some());
        // 剥完仍查不到 = None（不模糊猜测）；「(Wiley)」整串剥完为空也 None
        assert!(lookup_in(&map, "Unknown Journal (Wiley)").is_none());
        assert!(lookup_in(&map, "(Wiley)").is_none());
        // 表内名本身带括号尾也能先全名命中（不剥优先）
        assert!(lookup_in(&map, "Advanced Materials").is_some());
    }
}
