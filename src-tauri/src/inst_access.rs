//! 机构访问（高校/研究所）全文获取通道：登录会话罐 + 代理前缀改写 + 落地页 PDF 链接提取。
//!
//! 形态（2026-09-16 拍板）：**人登录一次、系统复用会话**——用户在内嵌登录窗里自己完成
//! 机构 SSO（含 MFA），Mesa 只读取登录后的会话 Cookie 落 0600 本地文件，下载时按域名匹配
//! 注入请求头。绝不存储机构账号密码、绝不做无人值守自动登录（MFA 过不去；脚本式批量
//! 下载会被出版商风控识别并连坐全校 IP）。
//!
//! 三条硬边界（docs/conventions/pipeline.md「机构访问通道」）：
//! 1. **只由人在界面上逐篇触发**——不进定时雷达/无头 Run（scheduler 不携带本会话）；
//! 2. 会话文件是秘密：0600 存 `<config>/ccode/inst-session.json`（与 keys.json 同纪律），
//!    值绝不出站到前端（状态 DTO 只暴露域名/条数/时间），不进诊断包；
//! 3. 失败即回落 papers/to-fetch.md / watch-followup.md 人工获取，不自动重试轰炸。
//!
//! 下载阶梯本体在 lit_watch.rs `fetch_fulltext_bytes`（直链 → DOI 开放副本 → 本通道），
//! 本模块只提供通道件。前缀式（EZproxy/OpenAthens `?url=` 改写）先行；深信服类 WebVPN
//! 的各校私有重写规则不做泛化。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tauri::WebviewUrl;
use tauri::WebviewWindowBuilder;

/// 下载上限/超时沿用 lit-watch 全文下载口径（60MB / 120s）
const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
/// 登录窗轮询间隔（窗口存活期间持续增量捕获，不设总时长上限）
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const LOGIN_WINDOW_LABEL: &str = "inst-login";
/// OA 查证（Unpaywall/OpenAlex）单独收紧超时：best-effort，慢网不拖累整条阶梯
const OA_TIMEOUT: Duration = Duration::from_secs(10);
const UA: &str = "Mesa lit-watch (https://github.com/hongtongzhou-design/ccode)";
/// 登录窗拦下的 PDF 用浏览器 UA：CDN（mdpi-res.com 等）按页面自己的下载发，
/// 不带 Mesa 爬虫 UA。程序化阶梯（fetch_via_session）仍用上面的礼貌 UA。
const WINDOW_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
/// Unpaywall 要求带联系邮箱（礼貌参数，非鉴权）
const OA_EMAIL: &str = "hong.tongzhou@zetatechs.com";

// ===== 会话罐（0600，值不出站） =====

/// 单条会话 Cookie。domain 统一存无前导点小写；path 缺省 "/"；
/// 有效期不存（登录窗拿到什么存什么，按会话 Cookie 对待，过期由「停在登录页」反馈）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct StoredCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    #[serde(default)]
    secure: bool,
    #[serde(default)]
    http_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstSessionStore {
    cookies: Vec<StoredCookie>,
    updated_at: String,
    /// 保存会话时的登录起始主机（展示用，非秘密）
    captured_from: String,
    /// 会话可信度：至少一条 Cookie 命中前缀主机或出版商域（入口页一打开的
    /// pre-auth Cookie 不算——旧口径立刻显示「已保存」并点亮获取按钮，真取时
    /// 又报会话过期，两头骗人）。旧文件无此字段按 true 兼容（此前保存的都当已登录）
    #[serde(default = "default_true")]
    credible: bool,
}

fn default_true() -> bool {
    true
}

fn session_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("inst-session.json"))
}

/// 读取会话罐：文件缺失 = 未登录（None）；损坏 fail-loud——保留原件报错，
/// 绝不当空罐继续（否则下次保存静默覆盖，用户以为还登录着）
fn load_session() -> Result<Option<InstSessionStore>, String> {
    let path = session_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取机构会话失败: {e}"))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("机构会话文件已损坏（{}）: {e}", path.display()))
}

fn save_session(store: &InstSessionStore) -> Result<(), String> {
    let path = session_path()?;
    let body = serde_json::to_vec_pretty(store).map_err(|e| format!("序列化机构会话失败: {e}"))?;
    crate::storage::atomic_write(&path, &body, true)
}

/// 机构通道配置快照：前缀（settings，非秘密）+ 会话罐（0600）
pub(crate) struct InstitutionalChannel {
    prefix: Option<String>,
    session: Option<InstSessionStore>,
}

impl InstitutionalChannel {
    pub(crate) fn load() -> Self {
        let settings = crate::settings::read_current();
        let prefix = settings
            .institutional_prefix
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .filter(|v| valid_http_url(v))
            .map(str::to_string);
        let session = load_session().unwrap_or_else(|e| {
            crate::logbuf::record("error", "inst-access", &e);
            None
        });
        Self { prefix, session }
    }

    /// 通道可用：有前缀（含校园 IP 经代理直通）或已有**可信**会话（校园 IP 直连
    /// 模式）——只有入口页 pre-auth Cookie 的罐子不算可用（真取时只会报会话
    /// 过期，2026-09-17 审计；旧文件 serde default true 不回归既有保存态）
    pub(crate) fn active(&self) -> bool {
        self.prefix.is_some() || self.session.as_ref().is_some_and(|s| s.credible)
    }
}

// ===== DTO =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstSessionStatusDto {
    pub prefix_configured: bool,
    /// 前缀填了但不是合法 http(s) URL——通道加载会静默丢弃它（与 load 同口径
    /// 过滤），前端就地提示补 scheme，别让「已配置」按钮亮着空转
    pub prefix_invalid: bool,
    pub prefix_host: String,
    pub login_url_saved: bool,
    pub session_present: bool,
    pub session_credible: bool,
    /// 保存会话时的登录起始主机（展示用，非秘密；兑现 captured_from 字段意图）
    pub captured_from: String,
    pub updated_at: Option<String>,
    pub cookie_count: usize,
    /// 会话覆盖的域名清单（主机名，非秘密；展示「都拿到了哪些站的会话」）
    pub domains: Vec<String>,
}

fn status_inner() -> Result<InstSessionStatusDto, String> {
    let settings = crate::settings::read_current();
    let prefix = settings
        .institutional_prefix
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    // 口径统一（2026-09-17 审计）：「已配置」必须是通道 load 也认的前缀——
    // 缺 scheme 的前缀 load 侧会被 valid_http_url 过滤掉，status 再报已配置
    // 就是两头矛盾；非法的前缀单列 prefix_invalid 供前端就地提示
    let prefix_valid = prefix.is_some_and(|p| valid_http_url(p));
    let prefix_host = prefix
        .and_then(|p| reqwest::Url::parse(p).ok())
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    let session = load_session()?;
    let (present, credible, updated_at, count, domains, captured_from) = match &session {
        None => (false, false, None, 0, Vec::new(), String::new()),
        Some(s) => {
            let mut domains: Vec<String> = s.cookies.iter().map(|c| c.domain.clone()).collect();
            domains.sort();
            domains.dedup();
            (
                !s.cookies.is_empty(),
                s.credible,
                Some(s.updated_at.clone()),
                s.cookies.len(),
                domains,
                s.captured_from.clone(),
            )
        }
    };
    Ok(InstSessionStatusDto {
        prefix_configured: prefix_valid,
        prefix_invalid: prefix.is_some() && !prefix_valid,
        prefix_host,
        login_url_saved: settings
            .institutional_login_url
            .as_deref()
            .map(str::trim)
            .is_some_and(|v| !v.is_empty()),
        session_present: present,
        session_credible: credible,
        captured_from,
        updated_at,
        cookie_count: count,
        domains,
    })
}

// ===== 纯函数件（下载通道用，单测覆盖） =====

fn valid_http_url(raw: &str) -> bool {
    reqwest::Url::parse(raw)
        .ok()
        .and_then(|u| match u.scheme() {
            "http" | "https" => u.host_str().map(|h| !h.is_empty()),
            _ => None,
        })
        .unwrap_or(false)
}

/// query 值百分号编码（RFC 3986 unreserved 之外全编）
fn encode_query_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 代理前缀改写（EZproxy/OpenAthens 形态）：`prefix + ?url=<编码目标>`。
/// 用户常直接粘贴书签样式前缀（已以 `url=`/`qurl=` 结尾，大小写不限）——先剥掉
/// 再统一拼，避免 `?url=&url=`；qurl 形态只认 url= 会剥出 `login?q&url=…` 坏链
/// （部分学校的书签/指南链接即 qurl 形态，两条取全文链路全打不开）
pub(crate) fn proxy_wrap(prefix: &str, target: &str) -> String {
    let base = prefix.trim_end();
    let lower = base.to_ascii_lowercase();
    let base = if lower.ends_with("qurl=") {
        &base[..base.len() - "qurl=".len()]
    } else if lower.ends_with("url=") {
        &base[..base.len() - "url=".len()]
    } else {
        base
    };
    // 剥完参数尾巴后残留的 ? / & 一并清掉，统一按 base 是否含 ? 决定分隔符
    let base = base.trim_end_matches(['?', '&']);
    let sep = if base.contains('?') { '&' } else { '?' };
    format!("{base}{sep}url={}", encode_query_value(target))
}

/// 目标是否已是代理形态：host 等于前缀主机或其子域——用户从 EZproxy 会话里
/// 复制的完整代理链（`login?url=…`）、通配 DNS 改写域（`www-sciencedirect-com.
/// ezproxy.uni.edu`）都算。已是代理形态的不得再包一层（双重代理 404 / 重定向成环）
pub(crate) fn target_already_proxied(target: &str, prefix: &str) -> bool {
    let Some(prefix_host) = reqwest::Url::parse(prefix.trim())
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
    else {
        return false;
    };
    match reqwest::Url::parse(target.trim()) {
        Ok(u) => u
            .host_str()
            .is_some_and(|h| domain_matches(h, prefix_host.as_str())),
        Err(_) => false,
    }
}

/// 会话 Cookie 匹配（RFC 6265 宽松子集）：域名等于或点后缀命中、路径前缀命中、
/// secure 仅 https 发。返回 `name=value; name=value` 请求头值
pub(crate) fn cookie_header_for(cookies: &[StoredCookie], url: &reqwest::Url) -> String {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let path = url.path();
    let https = url.scheme() == "https";
    let mut parts: Vec<String> = Vec::new();
    for c in cookies {
        let domain = c.domain.trim_start_matches('.').to_ascii_lowercase();
        if domain.is_empty() {
            continue;
        }
        let host_hit = host == domain || host.ends_with(&format!(".{domain}"));
        if !host_hit {
            continue;
        }
        let cpath = if c.path.starts_with('/') {
            c.path.clone()
        } else {
            format!("/{}", c.path)
        };
        let cpath = cpath.trim_end_matches('/');
        let path_hit = if cpath.is_empty() {
            true // 根路径 "/" 匹配一切
        } else {
            path == cpath || path.starts_with(&format!("{cpath}/"))
        };
        if !path_hit || (c.secure && !https) {
            continue;
        }
        parts.push(format!("{}={}", c.name, c.value));
    }
    parts.join("; ")
}

/// 从条目链接提取 DOI：裸 `10.x/y`（可带 `doi:` 前缀）、doi.org/dx.doi.org 路径、
/// `?doi=` 参数；剥尾部句读（清单行里的 DOI 常跟句号逗号）
pub(crate) fn doi_from_url(raw: &str) -> Option<String> {
    let t = raw.trim();
    let bare = t
        .strip_prefix("doi:")
        .or_else(|| t.strip_prefix("DOI:"))
        .map(str::trim)
        .unwrap_or(t)
        .trim_end_matches(['.', ',', ';', ')', ']', '}']);
    if is_doish(bare) {
        return Some(bare.to_string());
    }
    let url = reqwest::Url::parse(t).ok()?;
    let lower_host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if lower_host == "doi.org" || lower_host == "dx.doi.org" {
        let doi = url
            .path()
            .trim_start_matches('/')
            .trim_end_matches(['.', ',', ';']);
        if is_doish(doi) {
            return Some(doi.to_string());
        }
    }
    for (k, v) in url.query_pairs() {
        if k.eq_ignore_ascii_case("doi") && is_doish(&v) {
            return Some(v.trim_end_matches(['.', ',', ';']).to_string());
        }
    }
    // Wiley/ACS：/doi/pdf/10.1002/x、/doi/epdf/10.1002/x、/doi/10.1002/x
    let path = url.path();
    let lower = path.to_ascii_lowercase();
    for prefix in [
        "/doi/pdfdirect/",
        "/doi/pdf/",
        "/doi/epdf/",
        "/doi/full/",
        "/doi/abs/",
        "/doi/",
    ] {
        if let Some(idx) = lower.find(prefix) {
            let rest = &path[idx + prefix.len()..];
            let doi = rest.trim_end_matches(['.', ',', ';']);
            if is_doish(doi) {
                return Some(doi.to_string());
            }
        }
    }
    None
}

/// 两个地址是不是同一篇：两边都能抽出 DOI 且相同。抽不出则不当作同一篇
/// （避免把窗里点到的另一篇，用「窗口打开」时那篇的标题去命名）
pub(crate) fn same_paper_url(a: &str, b: &str) -> bool {
    match (doi_from_url(a), doi_from_url(b)) {
        (Some(x), Some(y)) => x.eq_ignore_ascii_case(&y),
        _ => false,
    }
}

fn is_doish(s: &str) -> bool {
    // 10. 前缀 + 注册码 + "/" + 后缀，字符集收紧到 DOI 常用集（含中文 DOI 罕见，排除）
    let mut parts = s.splitn(2, '/');
    let prefix = parts.next().unwrap_or("");
    let suffix = parts.next().unwrap_or("");
    !suffix.is_empty()
        && prefix.len() > 3
        && prefix.starts_with("10.")
        && prefix[3..].bytes().all(|b| b.is_ascii_digit())
}

/// 基本实体反转义（href 常见 `&amp;`）
fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
}

/// 落地页提取 PDF 候选链接（不带本篇 DOI 的旧口径，单测沿用）
#[allow(dead_code)]
pub(crate) fn pdf_link_candidates(html: &str, base: &reqwest::Url) -> Vec<String> {
    pdf_link_candidates_for(html, base, None)
}

/// 带「本篇 DOI」的候选提取（headless 阶梯口径，2026-09-17 审计补单篇归属判定）：
/// `citation_pdf_url` meta（Crossref 推荐标准，出版商覆盖最广）最优先；锚链按
/// 「含本篇 DOI 优先 → 主链 → 补充材料（mmc/suppl 形态降权）」排序；无 meta、
/// 无 DOI 佐证的多条 pdfish 锚链（issue 目录/检索页形态）不猜——宁报「落到列表页」
/// 也不把别人的 PDF 当本篇收（与注入脚本/扩展侧同款纪律）。相对链接按 base
/// 绝对化、跨组去重、限 5 条
pub(crate) fn pdf_link_candidates_for(
    html: &str,
    base: &reqwest::Url,
    page_doi: Option<&str>,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let push =
        |raw: String, bucket: &mut Vec<String>, seen: &mut std::collections::HashSet<String>| {
            let href = html_unescape(raw.trim());
            let lower = href.to_ascii_lowercase();
            if lower.starts_with("javascript:")
                || lower.starts_with("mailto:")
                || href.starts_with('#')
                || href.is_empty()
            {
                return;
            }
            if let Ok(abs) = base.join(&href) {
                let s = abs.to_string();
                if seen.insert(s.clone()) {
                    bucket.push(s);
                }
            }
        };
    // meta citation_pdf_url：attribute 顺序两种都认
    let mut meta: Vec<String> = Vec::new();
    for line in html.split('<') {
        let lower = line.to_ascii_lowercase();
        if !lower.starts_with("meta") || !lower.contains("citation_pdf_url") {
            continue;
        }
        if let Some(v) = extract_attr(line, "content") {
            push(v, &mut meta, &mut seen);
        }
    }
    let mut doi_hits: Vec<String> = Vec::new();
    let mut mains: Vec<String> = Vec::new();
    let mut extras: Vec<String> = Vec::new();
    let doi_norm = page_doi
        .map(|d| d.trim().to_ascii_lowercase())
        .filter(|d| !d.is_empty());
    // <a href> 常见 PDF 形态（含标签名后换行的形态——旧口径只认空格/制表符）
    for line in html.split('<') {
        let lower = line.to_ascii_lowercase();
        if !(lower.starts_with("a ")
            || lower.starts_with("a\t")
            || lower.starts_with("a\n")
            || lower.starts_with("a\r"))
        {
            continue;
        }
        let Some(href) = extract_attr(line, "href") else {
            continue;
        };
        let h = html_unescape(href.trim()).to_ascii_lowercase();
        let pdfish = h.contains(".pdf")
            || h.contains("/pdf/")
            || h.ends_with("/pdf")
            || h.contains("pdfft")
            || h.contains("pdfdirect")
            || h.contains("getpdf")
            || h.contains("articlepdf")
            || h.contains("epdf")
            || h.contains("stamp.jsp");
        if !pdfish {
            continue;
        }
        if doi_norm.as_deref().is_some_and(|d| h.contains(d)) {
            push(href, &mut doi_hits, &mut seen);
        } else if h.contains("mmc")
            || h.contains("suppl")
            || h.contains("/moesm")
            || h.contains("/si/")
            || h.contains("supporting-information")
        {
            push(href, &mut extras, &mut seen);
        } else {
            push(href, &mut mains, &mut seen);
        }
    }
    if !meta.is_empty() {
        out.extend(meta);
        out.extend(doi_hits);
        out.extend(mains);
        out.extend(extras);
    } else if !doi_hits.is_empty() {
        // 页面能佐证本篇 DOI：DOI 命中链优先，主链次之；补充材料不进
        // （错收比漏收难察觉——SD 页内唯一 pdfish 锚链常是补充材料）
        out.extend(doi_hits);
        out.extend(mains);
    } else if mains.len() == 1 {
        // 无 DOI 佐证：唯一一条主链才采用（多链 = issue 目录/检索页形态，不猜）
        out.extend(mains);
    }
    out.truncate(5);
    out
}

/// 从单个标签文本里抽属性值：认 `name="v"` / `name='v'` / `name=v`（无引号到空白）。
/// 按引号外空白切属性段再匹配属性名——`data-href=` 是另一个属性名不误当 href、
/// 属性值里出现的 `href=` 字样（title="pdf href=1"）不会抢在真属性前面
/// （2026-09-17 审计：旧裸子串 find 两个坑都踩）
fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let mut segments: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for ch in tag.chars() {
        match quote {
            Some(q) => {
                cur.push(ch);
                if ch == q {
                    quote = None;
                }
            }
            None => {
                if ch == '"' || ch == '\'' {
                    quote = Some(ch);
                    cur.push(ch);
                } else if ch.is_whitespace() || ch == '>' {
                    // '>' 是标签结束符：html.split('<') 出来的片段带 `…>后续文本`，
                    // 不切会把尾巴并进属性值（/a.pdf">PDF）
                    if !cur.is_empty() {
                        segments.push(std::mem::take(&mut cur));
                    }
                } else {
                    cur.push(ch);
                }
            }
        }
    }
    if !cur.is_empty() {
        segments.push(cur);
    }
    for seg in segments {
        let Some((name, value)) = seg.split_once('=') else {
            continue;
        };
        if !name.eq_ignore_ascii_case(attr) {
            continue;
        }
        let v = value.trim();
        return Some(
            v.trim_matches(|c| c == '"' || c == '\'')
                // XHTML 自闭合（content="url"/>）：'>' 切段后值尾残留 '/'（终检）
                .trim_end_matches('/')
                .to_string(),
        );
    }
    None
}

/// 登录页探测（宽进：命中即提示重新登录，不作为硬判定——页脚登录挂件也会命中，
/// 调用方应先提候选链接、提不出来时才把它当会话过期口径）
pub(crate) fn html_needs_login(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    lower.split('<').any(|line| {
        let l = line.trim_start();
        (l.starts_with("input") || l.starts_with("button"))
            && extract_attr(l, "type").is_some_and(|t| t.trim().eq_ignore_ascii_case("password"))
    })
}

/// SAML 中继页探测：隐藏的 SAMLRequest/SAMLResponse 自动提交表单（或 onload
/// 自动提交的隐藏域）。EZproxy/OpenAthens 会话过期而学校 IdP 还在线时，重定向
/// 链会停在这种中间页——没有 password 输入，html_needs_login 看不见它，
/// 旧口径误报「不在订阅范围」
pub(crate) fn saml_relay(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    (lower.contains("samlrequest") || lower.contains("samlresponse"))
        && (lower.contains("<form") || lower.contains("<input"))
}

// ===== 网络件 =====

/// 会话取字节：手动逐跳跟随重定向（每跳按目标 host 重算 Cookie 头——reqwest 自动
/// Cookie 头在跨域跳转会被剥，EZproxy 链路恰好依赖每跳都带），60MB 流式中止
pub(crate) struct ChannelFetch {
    pub bytes: Vec<u8>,
    pub final_url: String,
    pub content_type: String,
}

pub(crate) async fn fetch_via_session(
    url: &str,
    session: Option<&InstSessionStore>,
) -> Result<ChannelFetch, String> {
    fetch_via_session_ex(url, session, UA, None).await
}

async fn fetch_via_session_ex(
    url: &str,
    session: Option<&InstSessionStore>,
    ua: &str,
    referer: Option<&str>,
) -> Result<ChannelFetch, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(ua)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let cap = crate::lit_watch::DOWNLOAD_CAP;
    let mut current = reqwest::Url::parse(url).map_err(|e| format!("链接无效: {e}"))?;
    for _ in 0..6 {
        let mut req = client.get(current.clone());
        if let Some(s) = session {
            let header = cookie_header_for(&s.cookies, &current);
            if !header.is_empty() {
                req = req.header(reqwest::header::COOKIE, header);
            }
        }
        if let Some(r) = referer {
            if !r.is_empty() {
                req = req.header(reqwest::header::REFERER, r);
            }
        }
        req = req.header(
            reqwest::header::ACCEPT,
            "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
        );
        let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
        let status = resp.status();
        if status.is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| format!("重定向缺 Location（HTTP {status}）"))?
                .to_string();
            current = current
                .join(&loc)
                .map_err(|e| format!("重定向地址无效（{loc}）: {e}"))?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = crate::storage::response_bytes(resp, cap).await?;
        if bytes.is_empty() {
            return Err("下载内容为空".into());
        }
        return Ok(ChannelFetch {
            bytes,
            final_url: current.to_string(),
            content_type,
        });
    }
    Err("重定向次数过多".into())
}

/// 机构通道取全文：经前缀改写（有配置且目标不是代理形态时）取落地页/直链 →
/// PDF 魔数过了即返回；HTML 则按本篇 DOI 提取候选逐个再取。调用方（lit_watch
/// 阶梯）已保证 url 是 http(s)
pub(crate) async fn fetch_via_channel(
    target: &str,
    ch: &InstitutionalChannel,
) -> Result<Vec<u8>, String> {
    let prefix_host = ch
        .prefix
        .as_deref()
        .and_then(|p| reqwest::Url::parse(p).ok())
        .and_then(|u| u.host_str().map(str::to_string));
    let start = ch
        .prefix
        .as_deref()
        .map(|p| {
            // 已是代理形态（用户粘贴 login?url=… 完整链 / 通配 DNS 改写域）不得
            // 再包一层——双重代理 404 / 重定向成环（2026-09-17 审计）
            if target_already_proxied(target, p) {
                target.to_string()
            } else {
                proxy_wrap(p, target)
            }
        })
        .unwrap_or_else(|| target.to_string());
    let fetched = fetch_via_session(&start, ch.session.as_ref()).await?;
    if crate::lit_watch::looks_like_pdf(&fetched.bytes) {
        return Ok(fetched.bytes);
    }
    let html = String::from_utf8_lossy(&fetched.bytes).to_string();
    let looks_html = fetched
        .content_type
        .to_ascii_lowercase()
        .contains("text/html")
        || html.to_ascii_lowercase().contains("<html")
        || html.contains("citation_pdf_url");
    if !looks_html {
        return Err("机构通道返回的不是 PDF 也不是落地页".into());
    }
    let base =
        reqwest::Url::parse(&fetched.final_url).map_err(|e| format!("落地页地址无效: {e}"))?;
    let prefix_host = prefix_host.unwrap_or_default();
    let page_doi = doi_from_url(target);
    let cands = pdf_link_candidates_for(&html, &base, page_doi.as_deref());
    if cands.is_empty() {
        // 候选提不出来才回落登录态判定（页脚登录挂件会让 password 探测误命中，
        // 提前掐断本可解析的落地页——2026-09-17 审计双向失准修正）
        if saml_relay(&html) {
            return Err(
                "停在机构身份认证中间页（SAML）——会话可能已过期，请到设置 → 网络 → 学校图书馆 重新登录"
                    .into(),
            );
        }
        if html_needs_login(&html) {
            return Err(
                "停在机构登录页——会话可能已过期，请到设置 → 网络 → 学校图书馆 重新登录".into(),
            );
        }
        return Err(
            "已到达落地页但没识别出本篇的 PDF 链接（可能是列表/检索页，或该文献不在订阅范围）"
                .into(),
        );
    }
    for cand in cands.into_iter().take(3) {
        // 前缀模式下候选链接已被 EZproxy 改写成代理域（前缀主机或其子域，通配
        // DNS 形态 host 不等于前缀主机但仍是代理形态）就不再包一层
        let cand_host = reqwest::Url::parse(&cand)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default();
        let url_to_try = if !prefix_host.is_empty()
            && !domain_matches(&cand_host, &prefix_host)
            && ch.prefix.is_some()
        {
            proxy_wrap(ch.prefix.as_deref().unwrap_or(""), &cand)
        } else {
            cand
        };
        if let Ok(f2) = fetch_via_session(&url_to_try, ch.session.as_ref()).await {
            if crate::lit_watch::looks_like_pdf(&f2.bytes) {
                return Ok(f2.bytes);
            }
        }
    }
    if html_needs_login(&html) {
        return Err("停在机构登录页——会话可能已过期，请到设置 → 网络 → 学校图书馆 重新登录".into());
    }
    Err("已到达落地页但没找到可下载的 PDF 链接（该文献可能不在订阅范围）".into())
}

/// DOI → 合法开放副本直链（绿 OA/预印本/仓储副本）：Unpaywall 优先，OpenAlex 回落。
/// best-effort：任一环节失败继续回落，全落空才返回 None，不阻塞后续机构通道
pub(crate) async fn oa_pdf_url_for(doi: &str) -> Option<(String, &'static str)> {
    let client = reqwest::Client::builder()
        .timeout(OA_TIMEOUT)
        .user_agent(UA)
        .build()
        .ok()?;
    // Unpaywall 传输层失败（超时/DNS——国内访问 api.unpaywall.org 常见）只当「没查到」
    // 继续回落 OpenAlex；旧 `.ok()?` 在这里把整个函数提前弹空，回落永远走不到
    let upw: Option<serde_json::Value> = match client
        .get(format!(
            "https://api.unpaywall.org/v2/{}?email={OA_EMAIL}",
            encode_query_value(doi)
        ))
        .send()
        .await
    {
        Ok(r) => r.json().await.ok(),
        Err(_) => None,
    };
    if let Some(hit) = oa_pick_unpaywall(upw.as_ref()) {
        return Some(hit);
    }
    // OpenAlex: works/doi:<doi>（mailto 进 polite pool，共享池被打满时限流更缓）
    let oax: Option<serde_json::Value> = match client
        .get(format!(
            "https://api.openalex.org/works/https://doi.org/{}?mailto={OA_EMAIL}",
            encode_query_value(doi)
        ))
        .send()
        .await
    {
        Ok(r) => r.json().await.ok(),
        Err(_) => None,
    };
    oa_pick_openalex(oax.as_ref())
}

/// Unpaywall 选址（纯逻辑供单测）：best_oa_location 直链优先、url 仅在长得像 PDF
/// 时用；best 之外线性扫 oa_locations——最优位置是仓储落地页（无直链）时，另一
/// 位置的直链副本不该跟着陪葬
fn oa_pick_unpaywall(v: Option<&serde_json::Value>) -> Option<(String, &'static str)> {
    let v = v?;
    let loc_pdf = |loc: &serde_json::Value| -> Option<String> {
        if let Some(pdf) = loc
            .get("url_for_pdf")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
        {
            return Some(pdf.to_string());
        }
        loc.get("url")
            .and_then(|x| x.as_str())
            .filter(|u| u.to_ascii_lowercase().contains(".pdf"))
            .map(str::to_string)
    };
    if let Some(hit) = v.get("best_oa_location").and_then(loc_pdf) {
        return Some((hit, "unpaywall"));
    }
    v.get("oa_locations")
        .and_then(|arr| arr.as_array())
        .and_then(|locs| {
            locs.iter()
                .find_map(|l| loc_pdf(l).map(|u| (u, "unpaywall")))
        })
}

/// OpenAlex 选址（纯逻辑供单测）：best_oa_location.pdf_url 优先，locations[] 兜底
fn oa_pick_openalex(v: Option<&serde_json::Value>) -> Option<(String, &'static str)> {
    let v = v?;
    let pdf = |l: &serde_json::Value| -> Option<String> {
        l.get("pdf_url")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    if let Some(hit) = v.get("best_oa_location").and_then(|l| pdf(l)) {
        return Some((hit, "openalex"));
    }
    v.get("locations")
        .and_then(|arr| arr.as_array())
        .and_then(|locs| locs.iter().find_map(|l| pdf(l).map(|u| (u, "openalex"))))
}

/// 机构通道失败的分流提示：反爬墙（HTTP 403/429，Wiley/Elsevier 等对非浏览器客户端
/// 一律拦截——2026-09-16 实证带全量会话+浏览器 UA 仍 403，与登录无关）给「浏览器
/// 打开」出口；其余按会话过期/订阅范围口径。文案对齐现行三按钮口径：自动获取 /
/// 浏览器打开（90 秒收货）/ 关联本地 PDF（2026-09-17 审计——旧文案指向已下线的
/// 「在机构窗口打开」按钮）
pub(crate) fn institutional_failure_hint(err: &str) -> String {
    if err.contains("HTTP 403") || err.contains("HTTP 429") {
        return format!(
            "出版商反爬墙拒绝了程序化下载（{err}）——Wiley/Elsevier 等出版商拦截一切非浏览器客户端，与登录状态无关。点这一篇的「浏览器打开」，在浏览器里点站方下载，90 秒内落下的 PDF 会自动收进项目 papers/；没收到的用「关联本地 PDF」导入"
        );
    }
    format!("机构通道未取到全文：{err}。可到设置 → 网络 → 学校图书馆 重新登录后重试，或点「浏览器打开」在浏览器里下载（90 秒内自动收进 papers/），再不行用「关联本地 PDF」手动导入")
}

// ===== 登录窗 =====

/// 登录窗注入脚本（下载漏斗的页侧一半）：
/// ① 外部站（CARSI 资源页等）的 `target="_blank"` 链接与 window.open 在内嵌
///    WKWebView/WebView2 里默认无人接（点不动）——改写为本窗内导航；PDF/epdf
///    除外：改走抓取，禁止主框架跳进阅读器/内联 PDF（会变成整页图片、没保存入口）；
/// ② 常驻「⤓ 取 PDF」胶囊：每 2s 重检直链（citation_pdf_url / 链接形态，晚渲染/
///    SPA 换页都能追上），未检出时置灰常驻并给指引——不再一次判定永久沉默；
///    胶囊创建即上文案：没有直链的页面也得显示置灰指引，不得空着（空胶囊就是
///    一个黑圈，2026-09-16 用户实测以为坏了）；
/// ③ `__mesaGrab` 取 PDF：先借 `a[download]`/真正的下载按钮（WKDownload 进漏斗），
///    再给目标 URL 合成 `a[download]`（同源时 shouldPerformDownload，wry 走下载
///    委托、不经过 on_navigation），最后页上下文 fetch→魔数校验→blob 下载。
///    **禁止** `location.href` 打开 pdfish URL——那会让 WKWebView 内联渲染 PDF
///    （看起来像跳进一张图，脚本全死、漏斗接不住）。图片/HTML 也不当 PDF 存；
/// ④ ScienceDirect 文章页（含 EZproxy 改写域）不放 citation_pdf_url、PDF 链接也
///    不含 DOI（PII 路径），②的通用探测必落空、View PDF 又是 JS 弹层按钮——
///    探测兜底按页面内嵌 JSON（article.pdfDownload.urlMetadata）拼站方带 token
///    直链，拿不到就按 PII 构造 `/pdfft?download=true`（与 Zotero 适配器同源，
///    机构网络下无 md5/pid 参数实测也够）。只认 /science/article/(abs/)?pii/
///    路径，期刊页/检索页没有单篇 PII 不得构造。
/// initialization_script 每次导航都会重注入（WKUserContentController 级）
const LOGIN_INIT_SCRIPT: &str = r#"
(function () {
  if (window.__mesaNavPatch) return; window.__mesaNavPatch = 1;

  // about:blank 占位：系统深色下空白页默认黑底；脚本在 document-start 就能把
  // html 底色刷成浅灰，不必等 body / 也不依赖建窗后的 eval 竞态
  if (location.protocol === 'about:') {
    try {
      document.documentElement.style.background = '#f6f6f6';
      document.documentElement.style.colorScheme = 'light';
      var paintBlank = function () {
        if (!document.body) return;
        document.body.style.background = '#f6f6f6';
        document.body.style.margin = '0';
        document.body.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font:14px system-ui;color:#666">正在带登录会话打开…<span id="__mesa_wait" style="font-size:12px;color:#aaa;margin-top:8px">通常只要一两秒</span></div>';
        setTimeout(function () {
          if (location.protocol !== 'about:') return;
          var s = document.getElementById('__mesa_wait');
          if (s) s.textContent = '仍在连接，网络较慢…可以稍候，或关掉窗口再开一次';
        }, 4000);
        setTimeout(function () {
          if (location.protocol !== 'about:') return;
          var s = document.getElementById('__mesa_wait');
          if (s) s.textContent = '打开超时。请关掉本窗，再点一次「窗口打开」';
        }, 12000);
      };
      if (document.body) paintBlank();
      else document.addEventListener('DOMContentLoaded', paintBlank);
    } catch (e) {}
    return;
  }

  // 状态浮条：一切进度/成败都落在这里（Rust 侧 eval 全局钩子回写终态）
  function mesaStatus(text, sticky) {
    var el = document.getElementById('__mesa_status');
    if (!el) {
      el = document.createElement('div');
      el.id = '__mesa_status';
      el.setAttribute('style', 'position:fixed;right:16px;bottom:68px;z-index:2147483647;padding:9px 14px;border-radius:10px;border:1px solid rgba(140,140,140,.5);background:rgba(28,28,30,.92);color:#fff;font:13px system-ui;box-shadow:0 4px 14px rgba(0,0,0,.4);max-width:70vw');
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = text;
    if (el.__mesaT) clearTimeout(el.__mesaT);
    if (!sticky) el.__mesaT = setTimeout(function () { el.remove(); }, 4500);
  }

  // 终态/进度回写（Rust 侧 eval 调用）：浮条从「下载中」变终态
  window.__mesaStatusSaved = function (name) {
    window.__mesaReplayed = 1; // 本页已展示，不再重放
    window.__mesaDlPending = 0;
    mesaStatus('✓ 已存进 papers/：' + name, false);
  };
  window.__mesaStatusFailed = function (msg) {
    window.__mesaReplayed = 1;
    window.__mesaDlPending = 0;
    mesaStatus('✗ ' + msg, false);
  };
  // 中性提示（非终态）：忙档吞点击等场景给用户一句交代，不再静默
  window.__mesaNote = function (text) { mesaStatus(text, false); };
  window.__mesaDownloading = function () {
    var at = Date.now();
    window.__mesaDlPending = at;
    window.__mesaDlStarted = at;
    mesaStatus('下载中…完成后自动存进项目 papers/', true);
    // 看门狗（2026-09-16 20:33 实测：blob 下载 Requested 后 Finished 挂起、
    // 45s 兜底计时器又因时间戳刷新被烧掉，用户永远卡在「下载中」）——终态钩子
    // 会清 __mesaDlPending，到点仍等于本次时间戳才提示。60s：出版商 PDF 常有
    // 5-10MB，晚高峰传输超 20s 很正常（22:56 实测 20s 误报把用户吓退，下载其实
    // 还在跑）——宁可晚提醒，不得把进行中的下载说成失败
    setTimeout(function () {
      if (window.__mesaDlPending === at) {
        window.__mesaDlPending = 0;
        mesaStatus('下载仍在等待结果（大文件可能较慢）——若一直没动静可再试一次，或用页面自带的下载按钮', false);
      }
    }, 60000);
  };
  window.__mesaSaving = function (host) {
    window.__mesaDlPending = Date.now();
    mesaStatus('正在保存 PDF' + (host ? '（' + host + '）' : '') + '…', true);
  };
  // 终态跨页重放：下载期间页面常常会跳转（换页/内嵌 PDF 视图），直接 eval 的
  // 终态打在死页面上用户看不见。Rust 侧存住终态，新页面加载后补播一次；
  // 页级 __mesaReplayed 守卫保证每页最多重放一条
  window.__mesaReplay = function (msg) {
    if (window.__mesaReplayed) return;
    window.__mesaReplayed = 1;
    mesaStatus(msg, false);
  };

  // PDF 直链识别：citation_pdf_url 优先，其次页面链接（与 Rust pdfish_url 同口径）
  var mesaPdfRe = /\.pdf(\?|#|$)|\/pdf\/|pdfft|pdfdirect|getpdf|articlepdf|stamp\.jsp|\/doi\/epdf\//i;
  function mesaFixPdfUrl(u) { return u ? u.replace('/doi/epdf/', '/doi/pdf/') : u; }
  function mesaIsPdfish(u) { return mesaPdfRe.test(u || '') || /pdf\.sciencedirect\.com/i.test(u || ''); }
  function mesaIsEpdf(u) { return /\/doi\/epdf\//i.test(u || ''); }
  function mesaIsImageUrl(u) {
    var l = (u || '').toLowerCase();
    var path = l.split('?')[0].split('#')[0];
    return /\.(jpg|jpeg|png|gif|webp|svg)$/.test(path)
      || l.indexOf('els-cdn.com/content/image') >= 0
      || l.indexOf('/image/1-s2.0-') >= 0;
  }
  function mesaViewerUrl(u) {
    if (!u || mesaIsEpdf(u)) return null;
    if (!/\/doi\/pdf\//i.test(u)) return null;
    return u.replace('/doi/pdf/', '/doi/epdf/');
  }
  function mesaOpenViewer(u, why) {
    var v = mesaViewerUrl(u);
    if (!v) { mesaStatus('✗ ' + why, false); return; }
    mesaStatus(why + '。已打开阅读页，可用页内下载或右下角 ⤓ 再存', false);
    location.href = v;
  }
  function mesaPageDoi() {
    var m = document.querySelector('meta[name="citation_doi"], meta[name="dc.Identifier"]');
    if (m && m.content) return (m.content || '').replace(/^doi:\s*/i, '').trim();
    return '';
  }
  function mesaPdfUrl() {
    var m = document.querySelector('meta[name="citation_pdf_url"]');
    if (m && m.content) {
      var mu = mesaFixPdfUrl(m.content);
      if (mesaPdfRe.test(mu)) return mu;
    }
    // SD 文章页整页走专用链，不进通用启发式（2026-09-17 与扩展 content.js /
    // Zotero 适配器顺序对齐）：SD 页内 pdfish 锚链常是补充材料，通用单链采用会
    // 误收。顺序 = #pdfLink/token 直链 → 内嵌阅读器 → PII 构造兜底
    if (mesaIsSdArticle()) {
      var sdt = mesaSdPdfUrl(true);
      if (sdt) return sdt;
      var em = mesaEmbeddedPdf();
      if (em) return em;
      return mesaSdPdfUrl(false);
    }
    var doi = mesaPageDoi();
    var as = document.querySelectorAll('a[href]');
    var distinct = {};
    var onlyLink = null;
    for (var i = 0; i < as.length; i++) {
      var h = mesaFixPdfUrl(as[i].href || '');
      if (!mesaPdfRe.test(h)) continue;
      if (!doi) return h;
      if (h.indexOf(doi) >= 0) return h;
      if (!distinct[h]) { distinct[h] = 1; onlyLink = h; }
    }
    // 第二遍（2026-09-16）：PII/编号式出版商的 PDF 链接不含 DOI 前缀（RSC
    // articlepdf 只有 DOI 后缀、IEEE 是 arnumber）——本页是文章页
    // （有 citation_doi）且全文只此一条 PDF 链接（列表/检索页必然多条）时采用
    if (onlyLink && Object.keys(distinct).length === 1) return onlyLink;
    // 站方阅读器：真 PDF 常以内嵌 iframe/object 呈现——取内嵌地址供 fetch+分片
    // 回传（2026-09-16 用户拍板：View PDF 不拦、进阅读器取）
    return mesaEmbeddedPdf();
  }
  // SD 文章页判定（最窄分支纪律：只认 /science/article/(abs/)?pii/，期刊页/
  // 检索页不构造）
  function mesaIsSdArticle() {
    return /^\/science\/article\/(?:abs\/)?pii\/[^/?#]+/i.test(location.pathname);
  }
  // 内嵌阅读器扫描（iframe/object/embed 里的 pdfish 地址）
  function mesaEmbeddedPdf() {
    var ems = document.querySelectorAll('iframe[src], object[data], embed[src]');
    for (var k = 0; k < ems.length; k++) {
      var s = ems[k].src || ems[k].data || '';
      if (s && mesaPdfRe.test(s)) return mesaFixPdfUrl(s);
    }
    return null;
  }
  function mesaSuggestName(u) {
    try {
      var p = new URL(u, location.href);
      var last = p.pathname.split('/').filter(Boolean).pop() || 'paper';
      if (!/\.pdf$/i.test(last)) last += '.pdf';
      return decodeURIComponent(last);
    } catch (e) { return 'paper.pdf'; }
  }
  // ScienceDirect 下载链接判定（2026-09-16 终局，三形态实测 + wry 源码）：SD 对
  // 「下载式」请求（a[download] 合成、WKDownload action 路径）一律回 HTML（19:02/
  // 21:37/21:59 三轮实测）；「普通导航」被 wry 内联渲染成白屏（wry 的
  // navigation_policy_response 只看 canShowMIMEType、无视 Content-Disposition）；
  // 唯一可行 = 页内 fetch 取字节 + mesa-chunk:// 分片回传（见 mesaChunkRelay）
  function mesaIsSdPdfLink(u) {
    try {
      var p = new URL(u, location.href);
      return /sciencedirect/i.test(p.host) && p.pathname.indexOf('pdfft') >= 0;
    } catch (e) { return false; }
  }
  // 本页是否 SD：SD 上「View PDF」不拦——让站方自己的阅读器/弹层打开（2026-09-16
  // 用户拍板「进 View PDF 再下载」），胶囊在阅读器里识别内嵌 PDF 地址走分片回传
  function mesaIsSdPage() {
    return /sciencedirect/i.test(location.host);
  }
  // MDPI：PDF 在跨域 CDN（mdpi-res.com），页内 fetch/a[download] 都不可靠——
  // 可靠通道是 Rust 窗口会话直拉（on_navigation 拦截后 spawn_intercepted_pdf_save，
  // 浏览器 UA + 会话，绕过 CORS，文档记载的 MDPI 型正路）。点胶囊/链接时用
  // location.href 触发拦截（导航被取消、页面不动），直拉失败 Rust 自会回落页侧 grab
  function mesaIsMdpiLink(u) {
    try {
      return /mdpi/i.test(new URL(u, location.href).host);
    } catch (e) { return false; }
  }
  // ScienceDirect 直链解析（见脚本头注释④）。优先级与 Zotero 适配器实证一致：
  // ① 页面自己的 #pdfLink（href 是站方链接，可能是中间页——verifiedGrab 会跟跳）；
  // ② 内嵌 JSON 的 urlMetadata（机构网络预加载，token 直链）；③ 按 PII 构造 pdfft
  // （无 token 实测也常直出 PDF）。EZproxy 改写域同样成立——全部基于 location.origin
  // strict = 只认高置信信号（#pdfLink / token 直链），不做 PII 构造兜底——
  // 构造链排在通用内嵌扫描之后由调用方收尾（阅读器态真 PDF 就内嵌在 iframe，
  // token 直链优先于构造链）
  function mesaSdPdfUrl(strict) {
    var m = location.pathname.match(/^\/science\/article\/(?:abs\/)?pii\/([^/?#]+)/i);
    if (!m) return null;
    try {
      var pl = document.getElementById('pdfLink');
      if (pl && pl.href && pl.href !== '#' && mesaPdfRe.test(pl.href)) return pl.href;
    } catch (e) {}
    var scripts = document.querySelectorAll('script[type="application/json"]');
    for (var i = 0; i < scripts.length; i++) {
      var t = scripts[i].textContent || '';
      if (t.indexOf('pdfDownload') < 0) continue;
      // 单个 script 解析失败只跳过它（截断 JSON / 非 JSON 误命中），不弃全扫
      try {
        var data = JSON.parse(t);
        var um = data && data.article && data.article.pdfDownload
          && data.article.pdfDownload.urlMetadata;
        if (um && um.path && um.pii && um.pdfExtension
          && um.queryParams && um.queryParams.md5 && um.queryParams.pid) {
          return location.origin + '/' + um.path + '/' + um.pii + um.pdfExtension
            + '?md5=' + encodeURIComponent(um.queryParams.md5)
            + '&pid=' + encodeURIComponent(um.queryParams.pid);
        }
      } catch (e) {}
    }
    if (strict) return null;
    return location.origin + '/science/article/pii/' + m[1] + '/pdfft?download=true';
  }
  // 「中间页」判定与解析（2026-09-16 泛化，不限 SD）：不少出版商的 pdfish 链接
  // 返回的是 HTML 包装页——SD pdfft 是 meta refresh 跳转、IEEE stamp.jsp 是
  // iframe 内嵌 ielx 直链、Elsevier 旧链有 #redirect-message。直接 a[download]
  // 会把网页存下来（19:02 实测 got-html），必须先 fetch 验明正身、HTML 里找真链
  // 属性值里的 & 会被序列化成 &amp;：取出的 URL 必须先反转义，否则 query 参数
  // 被拆坏（SD pdfft 的 md5/pid 少一个参数就回错误页，2026-09-17 审计）
  function mesaUnescape(s) {
    return s ? String(s)
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'") : s;
  }
  // 中间页里找真 PDF 地址：meta refresh 的 CONTENT="0;URL=…"、
  // #redirect-message 里的 <a href>、iframe/embed/object 内嵌的 pdfish src/data
  function mesaIntermediaryNext(html) {
    var mr = html.match(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/i);
    if (mr) {
      var c = /content\s*=\s*["']?([^"'>]+)/i.exec(mr[0]);
      var mm = c && /\d+;\s*url=(.+)/i.exec(c[1]);
      if (mm) return mesaUnescape(mm[1].replace(/["']/g, ''));
    }
    var ra = html.match(/id="redirect-message"[\s\S]{0,600}?<a[^>]+href="([^"]+)"/i);
    if (ra) return mesaUnescape(ra[1]);
    var em = html.match(/<(?:iframe|embed)[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/i)
      || html.match(/<object[^>]+data\s*=\s*["']([^"']+)["'][^>]*>/i);
    if (em && mesaPdfRe.test(em[1])) return mesaUnescape(em[1]);
    return null;
  }
  // 分片回传（2026-09-16 终局）：页内 fetch 是唯一能拿到 PDF 字节的通道（下载式
  // 请求被 SD 回 HTML、自然导航被 wry 内联渲染白屏、blob 下载 Finished 挂起——
  // 三形态全实测），字节经 mesa-chunk:// 自定义 scheme 分片导航送回本机：
  // 每次导航都过 on_navigation（Rust 取消导航并收片，页面不动），不受出版商
  // CSP / 混合内容限制。Zotero Connector「页内取字节、带外送回」的 webview 等价物
  function mesaB64Chunk(bytes, start, len) {
    var s = '';
    var end = Math.min(bytes.length, start + len);
    for (var i = start; i < end; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, end)));
    }
    return btoa(s);
  }
  async function mesaChunkRelay(bytes) {
    // 61440 = 3 的倍数：非末块的 btoa 输出必带 == 填充，拼在一起后非对齐位置的
    // = 是非法 base64（65536%3==1，>64KB 的 PDF 走分片必挂解码，2026-09-17 审计
    // 实测 Invalid symbol 61）——块长取 3 的倍数让中间块零填充，Rust 侧另按
    // 逐块解码兜底任意对齐
    var CHUNK = 61440;
    var total = Math.max(1, Math.ceil(bytes.length / CHUNK));
    var a = document.createElement('a');
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    // begin 握手：先声明「即将回传 total 块」，Rust 只收握手后 60s 内、块数吻合
    // 的分片——窗内任意页面裸 location.href 塞 mesa-chunk:// 不再被无条件接收
    a.href = 'mesa-chunk://b/' + total;
    a.click();
    await new Promise(function (r2) { setTimeout(r2, 60); });
    for (var i = 0; i < total; i++) {
      a.href = 'mesa-chunk://c/' + (i + 1) + '/' + total + '/' + mesaB64Chunk(bytes, i * CHUNK, CHUNK);
      a.click();
      await new Promise(function (r2) { setTimeout(r2, 24); });
    }
    setTimeout(function () { a.remove(); }, 60000);
  }
  // fetch 取 PDF 字节（跟中间页 ≤3 跳：HTML 解析 refresh/redirect/iframe 真链），
  // %PDF- 魔数过了才分片回传。成功 true；任何失败 false（调用方走既有兜底）
  async function mesaFetchPdfRelay(u) {
    var tries = [u];
    for (var hop = 0; hop < tries.length && hop < 3; hop++) {
      var cur = tries[hop];
      var r;
      try { r = await fetch(cur, { credentials: 'include' }); } catch (e) { return false; }
      if (!r.ok) return false;
      var ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('image/') >= 0) return false;
      if (ct.indexOf('html') >= 0) {
        var html = await r.text();
        var next = mesaIntermediaryNext(html);
        if (!next) return false;
        try { next = new URL(next, r.url || cur).href; } catch (e) { return false; }
        if (tries.indexOf(next) < 0) tries.push(next);
        continue;
      }
      var bytes = new Uint8Array(await r.arrayBuffer());
      if (!mesaLooksLikePdf(bytes)) return false;
      mesaStatus('已取到 PDF（' + Math.round(bytes.length / 1024) + ' KB），正在传回本机…', true);
      await mesaChunkRelay(bytes);
      return true;
    }
    return false;
  }
  function mesaLooksLikePdf(bytes) {
    return bytes && bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  }
  function mesaLooksLikeImage(bytes) {
    if (!bytes || bytes.length < 3) return false;
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return true;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E) return true;
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
    return false;
  }

  // 远端直链 a[download]：同源时 WebKit shouldPerformDownload → wry 走下载委托
  // （不经过 on_navigation）。空 download 属性在部分站点不触发，必须带文件名。
  // a 元素延迟移除：click 后立即 remove 可能取消在途下载（21:17 挂死嫌疑之一）
  function mesaFallbackDownload(u) {
    var a = document.createElement('a');
    a.href = u;
    a.setAttribute('download', mesaSuggestName(u));
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 60000);
  }

  // 只点真正的下载控件：a[download] 或 button。不点「PDF」导航链接——
  // 点了会进 epdf 图片阅读器或 WKWebView 内联 PDF（2026-09-16 用户实测）
  function mesaFindPageButton() {
    var cands = document.querySelectorAll('a[download], button, [role="button"]');
    var best = null, bestScore = 0;
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      var text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      var score = 0;
      if (/^(download pdf|pdf download|pdf)$/i.test(text)) score = 3;
      else if (/pdf/i.test(text) && /(download|下载|save|保存)/i.test(text)) score = 2;
      if (el.tagName === 'A' && el.hasAttribute('download')) score = Math.max(score, 3);
      if (score > bestScore && (el.offsetWidth > 0 || el.offsetHeight > 0)) {
        best = el; bestScore = score;
      }
    }
    return best;
  }
  async function mesaWaitDl(ms) {
    var steps = Math.max(1, Math.floor(ms / 400));
    for (var i = 0; i < steps; i++) {
      await new Promise(function (r) { setTimeout(r, 400); });
      if (window.__mesaDlStarted && Date.now() - window.__mesaDlStarted < 3000) return true;
    }
    return false;
  }
  async function mesaTryPageButton() {
    var btn = mesaFindPageButton();
    if (!btn) return false;
    btn.click();
    return await mesaWaitDl(3200);
  }

  window.__mesaGrab = async function (u, selfheal) {
    if (window.__mesaGrabBusy) return;
    window.__mesaGrabBusy = 1;
    try { await mesaGrabInner(u, selfheal); } finally { window.__mesaGrabBusy = 0; }
  };
  // got-html 回救（Rust 侧下载校验发现拿到网页时 eval）：歇 2s 过站点连击限速窗
  // 后 fetch 取字节分片回传；失败按既有口径收尾（Wiley 型转阅读页，其余报错）
  window.__mesaGrabVerified = async function (u) {
    if (window.__mesaGrabBusy) return;
    window.__mesaGrabBusy = 1;
    try {
      u = mesaFixPdfUrl(u);
      window.__mesaDlPending = Date.now();
      mesaStatus('拿到的是网页——正在解析真 PDF 链接…', true);
      await new Promise(function (r2) { setTimeout(r2, 2000); });
      if (await mesaFetchPdfRelay(u)) return;
      window.__mesaDlPending = 0;
      mesaOpenViewer(u, '没能从页面解析出 PDF（可能不在订阅范围）');
    } finally { window.__mesaGrabBusy = 0; }
  };
  window.__mesaOpenViewer = function (u, why) { mesaOpenViewer(u, why || '未能保存 PDF'); };
  async function mesaGrabInner(u, selfheal) {
    u = mesaFixPdfUrl(u);
    var host = '';
    var sameOrigin = false;
    try {
      var parsed = new URL(u, location.href);
      host = parsed.host;
      sameOrigin = parsed.origin === location.origin;
    } catch (e) {}
    window.__mesaDlPending = Date.now();
    mesaStatus('正在保存 PDF（' + host + '）…', true);
    setTimeout(function () {
      if (window.__mesaDlPending && Date.now() - window.__mesaDlPending > 44000) {
        window.__mesaDlPending = 0;
        mesaStatus('45 秒没等到结果——可再试一次，或用页面自带的 Download PDF', false);
      }
    }, 45000);
    // 导航拦截转来时已经有直链：再点页面 Download 只会重新跳 CDN，空等几秒。
    // 跨域 CDN（mdpi-res.com）上 a[download] 会被浏览器忽略，合成点击也无效。
    // SD 页面跳过：站方下载控件发起的正是会被挂起/回 HTML 的「下载式」请求
    if (!selfheal && sameOrigin && !mesaIsSdPage() && await mesaTryPageButton()) return;
    // ScienceDirect（含一切「下载式请求被回 HTML」的形态）：页内 fetch 取字节 +
    // mesa-chunk:// 分片回传本机（三形态全实测后唯一可行通道）；失败交回通用路径
    if (sameOrigin && mesaIsSdPdfLink(u)) {
      if (await mesaFetchPdfRelay(u)) return;
    }
    // MDPI：跨域 CDN 型——location.href 触发导航拦截，走 Rust 窗口会话直拉
    // （页面不动；直拉失败 Rust 回落 eval grab(selfheal)——selfheal 时不再次导航
    // （NAV_SUPPRESS 10s 内同 URL 已吞掉），落到下面通用路径兜底）
    if (!selfheal && mesaIsMdpiLink(u)) {
      location.href = u;
      return;
    }
    // 首发下载必须对该 URL 零请求（21:37 实测：先 fetch 预检过的 URL，随后的下载
    // 被 SD 回 HTML——连击限速/单次资格；中间页解析由 got-html → __mesaGrabVerified 兜）。
    if (sameOrigin) {
      mesaFallbackDownload(u);
      if (await mesaWaitDl(3200)) return;
    }
    try {
      var r = await fetch(u, { credentials: 'include' });
      var ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!r.ok || ct.indexOf('html') >= 0 || ct.indexOf('image/') >= 0) {
        mesaOpenViewer(u, '站点没给 PDF 文件（' + (ct.split(';')[0] || ('HTTP ' + r.status)) + '）');
        return;
      }
      var b = await r.blob();
      var head = new Uint8Array(await b.slice(0, 8).arrayBuffer());
      if (mesaLooksLikeImage(head) || !mesaLooksLikePdf(head)) {
        mesaOpenViewer(u, '站点给的不是 PDF 文件');
        return;
      }
      // 已验明是 PDF：分片回传本机。禁止 blob: 下载——
      // macOS Finished 回调会挂起，浮条永远停在「下载中」
      var pdfBytes = new Uint8Array(await b.arrayBuffer());
      await mesaChunkRelay(pdfBytes);
    } catch (e) {
      mesaOpenViewer(u, '取 PDF 失败');
    }
  }

  // View PDF / 直链：拦住改保存。图片新窗不得把文章页换成一张图
  // （ScienceDirect 图形摘要、View PDF 弹窗常是 els-cdn jpg）。
  document.addEventListener('click', function (e) {
    for (var n = e.target; n && n !== document; n = n.parentElement) {
      if (!n.tagName) continue;
      var label = (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      if (/^(view pdf|download pdf)$/i.test(label)) {
        // SD 不拦 View PDF（2026-09-16 用户拍板「进 View PDF 再下载」）：让站方
        // 自己的阅读器/弹层打开，胶囊在里面识别内嵌 PDF 地址走分片回传——
        // 拦下改抓取只会触发对下载式请求的连击（挂起/拿网页）
        if (mesaIsSdPage()) return;
        e.preventDefault();
        e.stopPropagation();
        // 点中的常是控件内层（图标/文字 span）：沿祖先找承载 href 的 <a>——
        // 只看命中节点自身会漏掉「View PDF 文字在 <a> 的子节点上」的形态
        var va = n.closest ? n.closest('a[href]') : null;
        var vh = va ? va.href : '';
        var vu = (vh && /^https?:/i.test(vh) && mesaIsPdfish(vh) && !mesaIsImageUrl(vh)) ? vh : mesaPdfUrl();
        if (vu) {
          window.__mesaGrab(mesaFixPdfUrl(vu), false);
        } else {
          // SPA 首屏未就绪的宽限：点得早会假阴性（胶囊 2s 周期重检追得上，点击分支
          // 却是一次性判定）——晚 1.5s 再测，仍无才报「未检出」
          setTimeout(function () {
            var vu2 = mesaPdfUrl();
            if (vu2) window.__mesaGrab(mesaFixPdfUrl(vu2), false);
            else mesaStatus('这页没检出 PDF 直链，请用右下角 ⤓', false);
          }, 1500);
        }
        return;
      }
      if (n.tagName !== 'A') continue;
      var href = n.href || '';
      if (!/^https?:/i.test(href)) continue;
      if (mesaIsImageUrl(href)) {
        if (n.target === '_blank') { e.preventDefault(); e.stopPropagation(); }
        return;
      }
      if (n.target === '_blank') n.target = '_self';
      if (n.hasAttribute('download')) return;
      if (mesaIsEpdf(href)) return;
      if (mesaIsPdfish(href)) {
        var same = false;
        try { same = new URL(href, location.href).origin === location.origin; } catch (e2) {}
        if (same) {
          e.preventDefault();
          e.stopPropagation();
          window.__mesaGrab(mesaFixPdfUrl(href), false);
        }
        return;
      }
    }
  }, true);
  window.open = function (u) {
    if (u && /^https?:/i.test(u)) {
      if (mesaIsImageUrl(u)) return null;
      if (mesaIsPdfish(u) && !mesaIsEpdf(u)) {
        try {
          if (new URL(u, location.href).origin === location.origin) {
            window.__mesaGrab(mesaFixPdfUrl(u), false);
            return null;
          }
        } catch (e) {}
      }
      location.href = u;
    }
    return null;
  };

  // 常驻胶囊：周期重检直链；未检出时置灰常驻、点了给指引
  var pill = null, pillUrl = null;
  function mesaPillReset() {
    pill.textContent = pillUrl ? '⤓ 取 PDF（自动存进项目）' : 'Mesa · 未检出直链（用页面下载钮即可）';
    pill.style.opacity = pillUrl ? '1' : '.55';
  }
  function mesaEnsurePill() {
    if (!document.body) return;
    if (!pill || !document.getElementById('__mesa_save')) {
      pill = document.createElement('button');
      pill.id = '__mesa_save';
      pill.title = '双指左右轻扫可回退/前进页面';
      pill.setAttribute('style', 'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:9px 14px;border-radius:10px;border:1px solid rgba(140,140,140,.5);background:rgba(28,28,30,.9);color:#fff;font:13px system-ui;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4)');
      pill.onclick = function () {
        if (!pillUrl) {
          mesaStatus('这页没检出 PDF 直链——用页面自带的 Download PDF，Mesa 会自动接住存进项目', false);
          return;
        }
        pill.disabled = true;
        pill.textContent = '取中…';
        window.__mesaGrab(pillUrl, false);
        setTimeout(function () { pill.disabled = false; mesaPillReset(); }, 6000);
      };
      document.body.appendChild(pill);
      // 创建即上文案：没有直链的页面也显示置灰指引——否则空胶囊就是一个黑圈，
      // 后面 u === pillUrl（都为 null）时 reset 不会执行，永远空着
      mesaPillReset();
    }
    var u = mesaPdfUrl();
    if (u !== pillUrl) { pillUrl = u; mesaPillReset(); }
  }
  setInterval(mesaEnsurePill, 2000);
  mesaEnsurePill();
})();
"#;

/// 建窗占位画面（eval 到 about:blank 上）：冷启动与播种等待期间显示浅底提示，
/// 不再黑屏。注意不能用 data: URL 作初始地址——WKWebView 的 load(request) 不支持
/// data 方案（wry 构建期只吃 URL），窗口会直接建失败
const LOGIN_PLACEHOLDER_PAINT: &str = r#"
document.documentElement.style.background = '#f6f6f6';
document.documentElement.style.colorScheme = 'light';
if (document.body) {
  document.body.style.background = '#f6f6f6';
  document.body.style.margin = '0';
  document.body.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font:14px system-ui;color:#666">正在带登录会话打开…<span id="__mesa_wait" style="font-size:12px;color:#aaa;margin-top:8px">通常只要一两秒</span></div>';
}
"#;

/// 域名匹配（host 等于 domain 或点后缀命中）——播种相关性判定与请求头注入同一口径
pub(crate) fn domain_matches(host: &str, domain: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
}

fn apply_stored_cookies(window: &tauri::WebviewWindow, cookies: &[&StoredCookie]) {
    for c in cookies {
        let domain = c.domain.trim_start_matches('.');
        if domain.is_empty() || c.name.is_empty() {
            continue;
        }
        let mut builder = tauri::webview::Cookie::build((c.name.clone(), c.value.clone()))
            .domain(format!(".{domain}"))
            .path(if c.path.is_empty() {
                "/".into()
            } else {
                c.path.clone()
            });
        if c.secure {
            builder = builder.secure(true);
        }
        if c.http_only {
            builder = builder.http_only(true);
        }
        let _ = window.set_cookie(builder.build());
    }
}

/// 登录窗轮询线程的全局去重标记（多入口 open 时只跑一条轮询）
static POLL_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 接住的 PDF 队列（多槽：路径 + 字节，入库读内存不依赖磁盘还在）。旧单槽在
/// 90 秒窗内连收两篇时后到者无条件覆盖前者的暂存——前端按 A 的 file_name_hint
/// 把 B 的字节落盘，A 丢、B 错挂（2026-09-17 审计高危）。多槽按暂存路径对账，
/// 收齐 4 份后丢最旧（连带删暂存文件）
static RELAY_SLOT: std::sync::Mutex<Vec<RelaySlotEntry>> = std::sync::Mutex::new(Vec::new());
static RELAY_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) struct RelaySlotEntry {
    pub(crate) path: PathBuf,
    pub(crate) bytes: Vec<u8>,
    pub(crate) at: String,
}

/// PDF 尾部完整性：末 2KB 内应有 %%EOF（标准写法；追加空白也在窗口内）。
/// Safari 等边下边写的浏览器截到一半的文件头部魔数照样过——收编前必须验尾
pub(crate) fn pdf_tail_complete(bytes: &[u8]) -> bool {
    let tail = &bytes[bytes.len().saturating_sub(2048)..];
    tail.windows(5).any(|w| w == b"%%EOF")
}

/// 0600 落盘（与 inst-session.json 同纪律——暂存的是付费墙全文，别的本地用户
/// 不该能读；裸 fs::write 按 umask 落 0644）
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("暂存 PDF 失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    f.write_all(bytes)
        .map_err(|e| format!("暂存 PDF 失败: {e}"))
}

fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}
/// 刚入库成功的结果：StrictMode 双听 / 双拦截会立刻再调一次入库，
/// 暂存文件已被删，返回同一 DTO 而不是 ENOENT
static LAST_RELAY_SAVE: std::sync::Mutex<
    Option<(std::time::Instant, crate::lit_watch::DownloadedPaperDto)>,
> = std::sync::Mutex::new(None);
/// 「窗口打开」时的落盘语境；下载接应事件携带。窗里逛到另一篇时要用
/// 当前 PDF 的 DOI 命名，不得沿用打开时那篇的标题
static RELAY_CONTEXT: std::sync::Mutex<Option<RelayContext>> = std::sync::Mutex::new(None);
/// 收货通道（download_inbox）按归属匹配结果写入落盘语境（多项目并行打开时
/// 单槽语境必须跟实际命中的那篇走，不得沿用最后一次打开的）
pub(crate) fn valid_http_url_pub(u: &str) -> bool {
    valid_http_url(u)
}
pub(crate) fn proxy_wrap_pub(prefix: &str, target: &str) -> String {
    proxy_wrap(prefix, target)
}
pub(crate) fn set_relay_context(project_root: &str, title: &str, open_url: &str) {
    if let Ok(mut g) = RELAY_CONTEXT.lock() {
        *g = Some(RelayContext {
            project_root: project_root.to_string(),
            title: title.to_string(),
            open_url: open_url.to_string(),
        });
    }
}
/// 最近一次真正去拉的 PDF 地址（拦截 / on_download），用来和 open_url 对 DOI
static LAST_PDF_URL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[derive(Debug, Clone)]
pub(crate) struct RelayContext {
    project_root: String,
    title: String,
    open_url: String,
}
/// 登录窗同时只处理一篇（点 Download 常先拦 /pdf 再拦 CDN .pdf）
static INTERCEPT_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// got-html 回救单发守卫：同一 URL 30 秒内只回救一次——「回救→又拿到网页→再回救」
/// 死循环只发生在级联内；用户稍后手动重试是新一轮，不拦
static GOTHTML_RETRIED: std::sync::Mutex<Option<(String, std::time::Instant)>> =
    std::sync::Mutex::new(None);
/// got-html 回救防循环窗口
const GOTHTML_RETRY_WINDOW: Duration = Duration::from_secs(30);

// ===== 分片中继（页 → 本机字节运送，2026-09-16 终局）=====
// 实测收敛（SD 三形态 + wry 源码）：页内 fetch 是唯一能拿到 PDF 字节的通道（下载式
// 请求被回 HTML、自然导航被 wry 内联渲染成白屏——wry 的 navigation_policy_response
// 只看 canShowMIMEType、无视 Content-Disposition）；blob 下载 Finished 挂起。因此
// 页侧 fetch 到字节后，按 base64 分片经 mesa-chunk:// 自定义 scheme 导航运回——
// 每次导航都过 on_navigation（可取消，页面不跳转），不受出版商 CSP / 混合内容限制
// （Zotero Connector「页内取字节、带外送回」架构的 webview 等价物）。
// URL 形态：mesa-chunk://c/{seq}/{total}/{base64}；收齐 seq=1..=total 后解码、
// %PDF- 魔数校验、走既有单槽暂存/inst-pdf-relayed 入库链。

/// 单块上限（base64 后）；总块数上限对应 60MB 级 PDF
const CHUNK_MAX_LEN: usize = 96 * 1024;
const CHUNK_MAX_TOTAL: u32 = 2048;
/// 分片收集缓冲（60s 未收齐即弃，防半途页面关掉留垃圾）
struct ChunkRelayBuf {
    parts: std::collections::BTreeMap<u32, String>,
    total: u32,
    at: std::time::Instant,
}
static CHUNK_RELAY_BUF: std::sync::Mutex<Option<ChunkRelayBuf>> = std::sync::Mutex::new(None);

/// 分片导航解析（纯逻辑供单测）：seq/total/b64 三段
fn parse_chunk_nav(u: &str) -> Option<(u32, u32, &str)> {
    let rest = u.strip_prefix("mesa-chunk://c/")?;
    let mut it = rest.splitn(3, '/');
    let seq = it.next()?.parse::<u32>().ok()?;
    let total = it.next()?.parse::<u32>().ok()?;
    let b64 = it.next()?;
    (total > 0 && total <= CHUNK_MAX_TOTAL && seq > 0 && seq <= total && !b64.is_empty())
        .then_some((seq, total, b64))
}

/// begin 握手解析（纯逻辑供单测）：`mesa-chunk://b/{total}`——页侧分片回传前的
/// 一次声明，Rust 收到后武装接收窗（60s 内、块数吻合才收）
fn parse_chunk_begin(u: &str) -> Option<u32> {
    let rest = u.strip_prefix("mesa-chunk://b/")?;
    let total = rest.parse::<u32>().ok()?;
    (total > 0 && total <= CHUNK_MAX_TOTAL).then_some(total)
}

/// 分片接收武装位（begin 握手后 60s 内才收 c/ 分片；窗内任意页面不经握手裸塞
/// mesa-chunk:// 导航不再被无条件接收——降不了定向攻击，但堵住零成本投递）
static CHUNK_ARMED: std::sync::Mutex<Option<(u32, std::time::Instant)>> =
    std::sync::Mutex::new(None);

fn arm_chunk_relay(total: u32, now: std::time::Instant) {
    if let Ok(mut g) = CHUNK_ARMED.lock() {
        *g = Some((total, now));
    }
}

/// 分片是否在武装窗内且块数吻合（纯逻辑供单测）
fn chunk_relay_armed(
    armed: &Option<(u32, std::time::Instant)>,
    total: u32,
    now: std::time::Instant,
) -> bool {
    armed
        .as_ref()
        .is_some_and(|(t, at)| *t == total && now.duration_since(*at) < Duration::from_secs(60))
}

/// 拼装解码：逐块独立解码再拼字节——每块是页侧独立 btoa 的合法 base64（自带
/// 填充），拼接后整体解码会因中间块的 = 非法而挂（65536 块长时代的活 bug，
/// 2026-09-17 审计实测 Invalid symbol 61）；逐块解码对任意块长都对
fn decode_chunk_parts(parts: &std::collections::BTreeMap<u32, String>) -> Result<Vec<u8>, String> {
    let engine = base64::engine::general_purpose::STANDARD;
    let mut out = Vec::new();
    for (seq, b64) in parts {
        let mut buf = base64::Engine::decode(&engine, b64.as_bytes())
            .map_err(|e| format!("第 {seq} 块解码失败: {e}"))?;
        out.append(&mut buf);
    }
    Ok(out)
}

/// on_navigation 收到分片：入缓冲；收齐后逐块解码 → 校验 → 入库链
fn handle_chunk_nav(app: &tauri::AppHandle, u: &str, now: std::time::Instant) {
    let Some((seq, total, b64)) = parse_chunk_nav(u) else {
        return;
    };
    if b64.len() > CHUNK_MAX_LEN {
        return;
    }
    let armed_ok = CHUNK_ARMED
        .lock()
        .ok()
        .and_then(|g| chunk_relay_armed(&g, total, now).then_some(()))
        .is_some();
    if !armed_ok {
        crate::logbuf::record("warn", "inst-access", "未经 begin 握手的分片回传，拒绝");
        let _ = app.get_webview_window(LOGIN_WINDOW_LABEL).map(|w| {
            w.eval(
                "window.__mesaStatusFailed && window.__mesaStatusFailed('未经发起的分片回传被拒绝')",
            )
        });
        return;
    }
    let Ok(mut guard) = CHUNK_RELAY_BUF.lock() else {
        return;
    };
    let buf = match guard.as_mut() {
        Some(b) if b.total == total && now.duration_since(b.at) < Duration::from_secs(60) => b,
        _ => {
            *guard = Some(ChunkRelayBuf {
                parts: std::collections::BTreeMap::new(),
                total,
                at: now,
            });
            guard.as_mut().expect("just set")
        }
    };
    buf.at = now;
    buf.parts.insert(seq, b64.to_string());
    // 分片到达即续武装窗（终检回归提示：60s 从 begin 起算不刷新，60MB≈1000 块
    // 在慢机器上尾块会被拒）
    if let Ok(mut armed) = CHUNK_ARMED.lock() {
        if let Some((t, at)) = armed.as_mut() {
            if *t == total {
                *at = now;
            }
        }
    }
    if buf.parts.len() != total as usize {
        return;
    }
    let parts = guard.take().expect("checked").parts;
    drop(guard);
    if let Ok(mut armed) = CHUNK_ARMED.lock() {
        *armed = None; // 本次回传完成，重新武装需再握手
    }
    let app = app.clone();
    std::thread::spawn(move || match decode_chunk_parts(&parts) {
        Ok(bytes) => {
            if !crate::lit_watch::looks_like_pdf(&bytes)
                || bytes.len() > crate::lit_watch::DOWNLOAD_CAP
            {
                crate::logbuf::record(
                    "warn",
                    "inst-access",
                    "分片中继内容校验未过（非 PDF 或超限），丢弃",
                );
                let _ = app.get_webview_window(LOGIN_WINDOW_LABEL).map(|w| {
                    w.eval(
                        "window.__mesaStatusFailed && window.__mesaStatusFailed('传回的内容不是有效 PDF')",
                    )
                });
                return;
            }
            match stage_relayed_pdf(&bytes) {
                Ok(staged) => emit_relayed_pdf(&app, &staged, bytes.len()),
                Err(e) => {
                    crate::logbuf::record("warn", "inst-access", &format!("分片中继入库失败: {e}"));
                    let js = format!(
                        "window.__mesaStatusFailed && window.__mesaStatusFailed({})",
                        serde_json::to_string(&e).unwrap_or_default()
                    );
                    if let Some(w) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
                        let _ = w.eval(js);
                    }
                }
            }
        }
        Err(e) => {
            crate::logbuf::record("warn", "inst-access", &format!("分片中继解码失败: {e}"));
        }
    });
}

/// 暂存中继 PDF（单槽覆盖），返回暂存信息（路径 + 「窗口打开」时的落盘语境），
/// 发事件由上层（有线程安全的 AppHandle）完成
pub(crate) struct StagedRelay {
    pub(crate) path: PathBuf,
    pub(crate) context: Option<(String, String)>,
}

pub(crate) fn stage_relayed_pdf(bytes: &[u8]) -> Result<StagedRelay, String> {
    let dir = dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode/tmp");
    ensure_private_dir(&dir)?;
    // 唯一文件名：多槽并存的前提（固定 inst-relay.pdf 时后到者覆盖前者暂存）
    let uid = RELAY_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = dir.join(format!("inst-relay-{millis}-{uid}.pdf"));
    write_private(&path, bytes)?;
    let ctx = RELAY_CONTEXT
        .lock()
        .map_err(|_| "中继状态锁中毒".to_string())?
        .clone();
    let source = LAST_PDF_URL
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default();
    let hint = file_hint_from_context(&ctx, &source);
    if let Ok(mut last) = LAST_RELAY_SAVE.lock() {
        *last = None;
    }
    if let Ok(mut slot) = RELAY_SLOT.lock() {
        slot.push(RelaySlotEntry {
            path: path.clone(),
            bytes: bytes.to_vec(),
            at: chrono::Utc::now().to_rfc3339(),
        });
        while slot.len() > 4 {
            if let Some(old) = slot.first().map(|e| e.path.clone()) {
                let _ = std::fs::remove_file(&old);
            }
            slot.remove(0);
        }
    }
    Ok(StagedRelay {
        path,
        context: ctx.map(|c| (c.project_root, hint)),
    })
}

fn file_hint_from_context(ctx: &Option<RelayContext>, source_url: &str) -> String {
    if let Some(c) = ctx {
        if (source_url.is_empty() || same_paper_url(&c.open_url, source_url)) && !c.title.is_empty()
        {
            return c.title.clone();
        }
    }
    doi_from_url(source_url)
        .or_else(|| {
            ctx.as_ref()
                .map(|c| c.title.clone())
                .filter(|t| !t.is_empty())
        })
        .unwrap_or_else(|| "paper".into())
}

fn remember_pdf_url(url: &str) {
    if let Ok(mut slot) = LAST_PDF_URL.lock() {
        *slot = Some(url.to_string());
    }
}

/// 登录窗主框架导航拦截判定：高置信 PDF 直链。放行会被 WKWebView 内联渲染
/// （canShowMIMEType("application/pdf") == true → Allow）——无 DOM、无法保存。
/// `/doi/epdf/` 是 Wiley/ACS **网页阅读器**（本来就是一页页图），必须放行：
/// 点工具栏 PDF 就是要打开它；拦下来再下载，Wiley 只给 HTML，阅读页也进不去。
pub(crate) fn pdfish_url(u: &str) -> bool {
    let l = u.to_ascii_lowercase();
    if l.contains("/doi/epdf/") {
        return false;
    }
    let path = l.split(['?', '#']).next().unwrap_or(&l);
    path.ends_with(".pdf")
        || path.ends_with("/pdf")
        || path.contains("/doi/pdf/")
        || path.contains("/pdf/")
        || l.contains("pdfft")
        || l.contains("pdfdirect")
        || l.contains("getpdf")
        || l.contains("articlepdf")
        || l.contains("stamp.jsp")
        || l.contains("pdf.sciencedirect")
}

/// 图形摘要 / 配图直链：不得当成新窗口或主框架目标（ScienceDirect View PDF
/// 弹窗有时先给 els-cdn 图片，整页就被换成一张图）
pub(crate) fn image_url(u: &str) -> bool {
    let l = u.to_ascii_lowercase();
    let path = l.split(['?', '#']).next().unwrap_or(&l);
    path.ends_with(".jpg")
        || path.ends_with(".jpeg")
        || path.ends_with(".png")
        || path.ends_with(".gif")
        || path.ends_with(".webp")
        || path.ends_with(".svg")
        || l.contains("els-cdn.com/content/image")
        || l.contains("/image/1-s2.0-")
}

/// `/doi/pdf/` → `/doi/epdf/`（Wiley/ACS 阅读页）。已经是 epdf 或不认识则 None。
pub(crate) fn pdf_viewer_url(raw: &str) -> Option<String> {
    let l = raw.to_ascii_lowercase();
    if l.contains("/doi/epdf/") {
        return None;
    }
    let needle = "/doi/pdf/";
    let idx = l.find(needle)?;
    let mut out = String::with_capacity(raw.len() + 1);
    out.push_str(&raw[..idx]);
    out.push_str("/doi/epdf/");
    out.push_str(&raw[idx + needle.len()..]);
    Some(out)
}

/// 打开（或复用）机构登录窗并导航到 url，随后启动增量会话捕获轮询。
/// 新建窗口时先播种会话罐 Cookie 再导航（wry 窗口关闭后 cookie 存储即失——
/// 不播种的话每次「窗口打开」都要重新登录，2026-09-16 用户实测）
fn ensure_login_window(
    app: &tauri::AppHandle,
    url: reqwest::Url,
    title: &str,
) -> Result<(), String> {
    let jar = load_session().unwrap_or_else(|e| {
        crate::logbuf::record("error", "inst-access", &e);
        None
    });
    match app.get_webview_window(LOGIN_WINDOW_LABEL) {
        Some(window) => {
            window
                .navigate(url)
                .map_err(|e| format!("登录窗口导航失败: {e}"))?;
        }
        None => {
            // 先开空白页（播种 Cookie 完成后再导航，避免第一跳就以无会话状态打出版商
            // 登录页）；建窗后立即画占位画面，消掉冷启动黑屏
            let blank =
                reqwest::Url::parse("about:blank").map_err(|e| format!("空白页地址无效: {e}"))?;
            let app_nw = app.clone();
            let app_dl = app.clone();
            let app_nav = app.clone();
            let window =
                WebviewWindowBuilder::new(app, LOGIN_WINDOW_LABEL, WebviewUrl::External(blank))
                    .title(title)
                    .inner_size(1120.0, 820.0)
                    // 窗口层浅底：about:blank 在系统深色下默认黑屏，webview 层 macOS 不生效
                    .background_color(tauri::utils::config::Color(0xf6, 0xf6, 0xf6, 0xff))
                    .initialization_script(LOGIN_INIT_SCRIPT)
                    // 下载漏斗（2026-09-16 终局）：窗内一切下载（页面自带按钮的 attachment
                    // 响应、⤓ 胶囊、导航拦截转下载）都经系统下载委托到这里——Requested 把
                    // 落点改写到受控暂存，Finished 校验入库。不再依赖 ~/Downloads 落点猜测
                    .on_download(move |webview, event| match event {
                        tauri::webview::DownloadEvent::Requested { url, destination } => {
                            let suggested = destination
                                .file_name()
                                .map(|n| n.to_string_lossy().into_owned())
                                .unwrap_or_else(|| "paper.pdf".into());
                            let dest = download_staging_path(&suggested);
                            *destination = dest.clone();
                            if let Ok(mut active) = DL_ACTIVE.lock() {
                                active.insert(url.to_string(), (dest.clone(), suggested.clone()));
                            }
                            let _ = webview
                                .eval("window.__mesaDownloading && window.__mesaDownloading()");
                            spawn_download_watchdog(
                                app_dl.clone(),
                                url.to_string(),
                                dest,
                                suggested,
                            );
                            true
                        }
                        tauri::webview::DownloadEvent::Finished { url, success, .. } => {
                            // macOS 完成回调不带落盘路径——按 Requested 记的 map 对账
                            let app = app_dl.clone();
                            let url = url.to_string();
                            std::thread::spawn(move || {
                                handle_download_finished(&app, &url, success);
                            });
                            true
                        }
                        _ => true,
                    })
                    // 高置信 PDF/epdf 主框架导航一律取消（防内联 PDF / 图片阅读器）。
                    // wry：a[download] 的 shouldPerformDownload 走 Download 策略，根本
                    // 不进这个回调。同 URL 10s 内第二次仍取消，只是不再重复 eval grab。
                    // 分片中继例外：mesa-chunk:// 是页侧字节回传，取消导航、页面不动
                    .on_navigation(move |url| {
                        let u = url.as_str();
                        if let Some(total) = u
                            .strip_prefix("mesa-chunk://")
                            .and_then(|_| parse_chunk_begin(u))
                        {
                            arm_chunk_relay(total, std::time::Instant::now());
                            return false;
                        }
                        if u.starts_with("mesa-chunk://") {
                            handle_chunk_nav(&app_nav, u, std::time::Instant::now());
                            return false;
                        }
                        if !u.starts_with("http") || !pdfish_url(u) {
                            return true;
                        }
                        let already = NAV_SUPPRESS
                            .lock()
                            .map(|mut seen| {
                                nav_suppress_should_allow(&mut seen, u, std::time::Instant::now())
                            })
                            .unwrap_or(false);
                        if already {
                            return false;
                        }
                        spawn_intercepted_pdf_save(app_nav.clone(), u.to_string());
                        false
                    })
                    .on_new_window(move |url, _features| {
                        if url.scheme() != "http" && url.scheme() != "https" {
                            return tauri::webview::NewWindowResponse::Allow;
                        }
                        let u = url.as_str().to_string();
                        let app = app_nw.clone();
                        if image_url(&u) {
                            return tauri::webview::NewWindowResponse::Deny;
                        }
                        if pdfish_url(&u) {
                            spawn_intercepted_pdf_save(app, u);
                            return tauri::webview::NewWindowResponse::Deny;
                        }
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(50));
                            if let Some(w) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
                                let _ = w.navigate(url);
                            }
                        });
                        tauri::webview::NewWindowResponse::Deny
                    })
                    .build()
                    .map_err(|e| format!("打开登录窗口失败: {e}"))?;
            let _ = window.eval(LOGIN_PLACEHOLDER_PAINT);
            // 开「双指左右轻扫后退/前进」：WKWebView 内联渲染的 PDF 视图没有
            // DOM、脚本全失效，窗口又没装工具栏——不开手势，点进「View PDF」
            // 这类直链就被整页 PDF 关住回不去（2026-09-16 用户实测）
            #[cfg(target_os = "macos")]
            {
                let _ = window.with_webview(|webview| unsafe {
                    let raw = webview.inner();
                    let wk = &*(raw as *mut objc2::runtime::AnyObject);
                    let _: () = objc2::msg_send![
                        wk,
                        setAllowsBackForwardNavigationGestures: true
                    ];
                });
            }
            // 播种：先种目标域 Cookie（通常几条），马上导航；其余域后台补种，
            // 不挡首屏。以前把整罐（CARSI 点过的所有出版商）逐条 set_cookie
            // 再 cookies_for_url 轮询最多 1.6s，占位页会卡很久。
            let app2 = app.clone();
            let pdfish_target = pdfish_url(url.as_str());
            if pdfish_target {
                spawn_intercepted_pdf_save(app.clone(), url.to_string());
            }
            std::thread::spawn(move || {
                let Some(w) = app2.get_webview_window(LOGIN_WINDOW_LABEL) else {
                    return;
                };
                let all = jar.as_ref().map(|j| j.cookies.as_slice()).unwrap_or(&[]);
                let host = url.host_str().unwrap_or("");
                let (matched, rest): (Vec<&StoredCookie>, Vec<&StoredCookie>) =
                    all.iter().partition(|c| domain_matches(host, &c.domain));
                apply_stored_cookies(&w, &matched);
                if !matched.is_empty() {
                    std::thread::sleep(Duration::from_millis(80));
                }
                if !pdfish_target {
                    let _ = w.navigate(url);
                }
                apply_stored_cookies(&w, &rest);
            });
        }
    }
    Ok(())
}

/// 会话指纹：域名+Cookie 名+值哈希。只看 name@domain 时同名换值（重新登录/
/// 会话轮换——EZproxy 的 JSESSIONID 刷新是最常见形态）指纹不变、永不落罐，
/// 无头阶梯带着文件里的旧值反复报「会话已过期」，与注释宣称的「重新登录立即
/// 落罐」直接矛盾（2026-09-17 审计）
fn cookie_signature(cookies: &[StoredCookie]) -> String {
    fn value_hash(v: &str) -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        use std::hash::Hash;
        use std::hash::Hasher;
        v.hash(&mut h);
        h.finish()
    }
    let mut keys: Vec<String> = cookies
        .iter()
        .map(|c| format!("{}@{}#{:016x}", c.name, c.domain, value_hash(&c.value)))
        .collect();
    keys.sort();
    keys.dedup();
    keys.join("|")
}

/// 常见出版商域（「会话可信」判据用）：命中前缀主机或其中任一域的 Cookie 才算
/// 真建立了机构访问；只剩 CARSI/IdP 入口页自己种的 pre-auth Cookie 时不算
const PUBLISHER_DOMAINS: &[&str] = &[
    "sciencedirect.com",
    "elsevier.com",
    "cell.com",
    "thelancet.com",
    "wiley.com",
    "springer.com",
    "nature.com",
    "ieee.org",
    "acs.org",
    "rsc.org",
    "aps.org",
    "aip.org",
    "tandfonline.com",
    "sagepub.com",
    "oup.com",
    "jstor.org",
    "cambridge.org",
    "iop.org",
    "mdpi.com",
    "emerald.com",
    "degruyter.com",
    "science.org",
    "pnas.org",
    "plos.org",
    "acm.org",
    "worldscientific.com",
    "spiedigitallibrary.org",
    "optica.org",
    "osapublishing.org",
];

/// 会话可信判据：至少一条 Cookie 的域命中前缀主机（EZproxy 会话即种在前缀域）
/// 或常见出版商域。入口页一打开的 pre-auth Cookie 不满足——此前立刻「已保存」
/// 并点亮获取按钮，真取时又报会话过期（2026-09-17 审计）
fn credible_session(cookies: &[StoredCookie], prefix_host: &str) -> bool {
    let named = cookies.iter().any(|c| {
        let d = c.domain.trim_start_matches('.');
        !d.is_empty()
            && ((!prefix_host.is_empty() && domain_matches(d, prefix_host))
                || PUBLISHER_DOMAINS.iter().any(|p| domain_matches(d, p)))
    });
    if named {
        return true;
    }
    // 域清单盖不住的出版商（终检二轮：ACM/WorldScientific 等登录旅程会种 3+ 个
    // 不同域的会话）——多个不同域并存本身即「点进过资源」的强信号，按可信放行
    let mut domains: Vec<&str> = cookies
        .iter()
        .map(|c| c.domain.trim_start_matches('.'))
        .filter(|d| !d.is_empty())
        .collect();
    domains.sort_unstable();
    domains.dedup();
    cookies.len() >= 5 && domains.len() >= 3
}

/// 用户刚清除会话的代际标记：轮询读到下一次窗内 Cookie 只重置基线、不落盘
/// （否则窗内 cookie 结构一变，含已清除值的整罐又被写回磁盘「复活」）
static SESSION_CLEAR_ARMED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn host_of_url(u: &str) -> String {
    reqwest::Url::parse(u)
        .ok()
        .and_then(|x| x.host_str().map(str::to_string))
        .unwrap_or_default()
}

/// 增量捕获轮询（独立线程——Windows cookie API 在主线程同步调用会死锁）：
/// 每 3 秒读登录窗全部 Cookie，指纹变化即落罐并发事件（带可信标记）。
/// **不自动关窗**——CARSI 流程要在窗里继续点进出版商才会产生出版商会话，
/// 过早关窗会让用户永远差最后一步；窗口被用户关掉即停
fn spawn_capture_poll(app: tauri::AppHandle) {
    if POLL_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || {
        let mut last_sig: Option<String> = None;
        let prefix_host = crate::settings::read_current()
            .institutional_prefix
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .and_then(|p| reqwest::Url::parse(p).ok())
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default();
        // 不设时长上限：窗口开着就一直增量捕获——重新登录（会话过期后）立即落罐，
        // 否则下次开窗播种的还是旧会话，用户被反复要求重新登录（2026-09-16 实测踩坑）
        loop {
            std::thread::sleep(POLL_INTERVAL);
            let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) else {
                break; // 用户关掉了登录窗
            };
            if SESSION_CLEAR_ARMED.swap(false, std::sync::atomic::Ordering::AcqRel) {
                // 清除后第一次读到什么都是新基线，不落盘。空罐的指纹是空串——
                // 存成 Some("") 会让下一拍的空罐分支把刚删掉的文件以空罐写回
                // （复活），空罐一律归 None
                let sig = window
                    .cookies()
                    .ok()
                    .map(|all| cookie_signature(&collect_stored_cookies(all)))
                    .filter(|s| !s.is_empty());
                last_sig = sig;
                continue;
            }
            let Ok(all) = window.cookies() else {
                continue;
            };
            let cookies = collect_stored_cookies(all);
            if cookies.is_empty() {
                // 全量登出后窗内清空：空罐也要回写一次（旧 continue 让文件永远
                // 留着旧会话，状态页一直显示「已保存 N 条」）
                if last_sig.is_some() {
                    let _ = save_session(&InstSessionStore {
                        cookies: Vec::new(),
                        updated_at: chrono::Utc::now().to_rfc3339(),
                        captured_from: live_window_url(&app)
                            .as_deref()
                            .map(host_of_url)
                            .unwrap_or_default(),
                        credible: false,
                    });
                    last_sig = None;
                    let _ = app.emit(
                        "inst-session-captured",
                        serde_json::json!({ "credible": false, "empty": true }),
                    );
                }
                continue;
            }
            let sig = cookie_signature(&cookies);
            if last_sig.as_deref() == Some(sig.as_str()) {
                continue;
            }
            let credible = credible_session(&cookies, &prefix_host);
            match save_session(&InstSessionStore {
                cookies,
                updated_at: chrono::Utc::now().to_rfc3339(),
                captured_from: live_window_url(&app)
                    .as_deref()
                    .map(host_of_url)
                    .unwrap_or_default(),
                credible,
            }) {
                Ok(()) => {
                    last_sig = Some(sig);
                    let _ = app.emit(
                        "inst-session-captured",
                        serde_json::json!({ "credible": credible }),
                    );
                }
                Err(e) => crate::logbuf::record("error", "inst-access", &e),
            }
        }
        POLL_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    });
}

/// 从登录窗读取全部 http(s) 会话 Cookie 落罐（域名缺失/空值丢弃）
fn collect_stored_cookies(all: Vec<tauri::webview::Cookie<'_>>) -> Vec<StoredCookie> {
    all.into_iter()
        .filter_map(|c| {
            let domain = c.domain()?.trim_start_matches('.').to_ascii_lowercase();
            if domain.is_empty() {
                return None;
            }
            let (name, value) = c.name_value();
            if name.is_empty() || value.is_empty() {
                return None;
            }
            Some(StoredCookie {
                name: name.to_string(),
                value: value.to_string(),
                domain,
                path: c.path().unwrap_or("/").to_string(),
                secure: c.secure().unwrap_or(false),
                http_only: c.http_only().unwrap_or(false),
            })
        })
        .collect()
}

/// 手动捕获入口共用：读窗全量 Cookie 落罐（空罐报错）。可信判据与轮询同款
fn capture_from_window(
    window: &tauri::WebviewWindow,
    captured_from: &str,
) -> Result<usize, String> {
    let all = window
        .cookies()
        .map_err(|e| format!("读取登录会话失败: {e}"))?;
    let cookies = collect_stored_cookies(all);
    if cookies.is_empty() {
        return Err("登录窗口里还没有可保存的会话".into());
    }
    let prefix_host = crate::settings::read_current()
        .institutional_prefix
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .and_then(|p| reqwest::Url::parse(p).ok())
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    let credible = credible_session(&cookies, &prefix_host);
    let count = cookies.len();
    save_session(&InstSessionStore {
        cookies,
        updated_at: chrono::Utc::now().to_rfc3339(),
        captured_from: captured_from.to_string(),
        credible,
    })?;
    Ok(count)
}

// ===== 下载漏斗（on_download → 受控暂存 → 入库链，2026-09-16 终局）=====
// wry 导航策略源码实证：带 download 属性/attachment 的请求走系统下载委托；
// application/pdf 主框架导航会被 WKWebView 内联渲染（无 DOM、脚本全失效）。
// 登录窗 builder 上注册 on_download 后，窗内一切下载的落点都由我们决定：
// Requested 改写到 <config>/ccode/tmp/inst-dl/（uuid 前缀防并发），Finished 按
// map 对账读文件、魔数校验（网页 HTML 诚实报错不入库），再走既有单槽暂存/
// inst-pdf-relayed 事件/App 层 inst_save_relayed_pdf 入库链（12:52 端到端验证过）。
// 不再监听 ~/Downloads——受控下载不经过那里，也就不会误捞用户的其他下载。

/// 活动下载表：Requested 记 url → (暂存落点, 建议文件名)，Finished 消费
/// （macOS 完成回调无路径，靠这里对账）
static DL_ACTIVE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, (PathBuf, String)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
/// 导航拦截去重表：同 URL 10s 内第二次仍取消导航，只是不再重复 eval grab
static NAV_SUPPRESS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
static DL_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const SUPPRESS_WINDOW: Duration = Duration::from_secs(10);

/// 最近一次下载终态（跨页重放用）：下载期间页面常会跳转，直接 eval 的终态
/// 打在死页面上看不见。新页面加载后由重放线程补播一次（页级守卫防重复）
static LAST_DL_NOTICE: std::sync::Mutex<Option<(String, std::time::Instant)>> =
    std::sync::Mutex::new(None);
/// 终态保鲜期：只覆盖「下载中途换页」那一下。太长会把上一篇的 ✓ 弹到下一篇上
const NOTICE_TTL: Duration = Duration::from_secs(20);
static NOTICE_REPLAY_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn record_dl_notice(msg: &str) {
    if let Ok(mut slot) = LAST_DL_NOTICE.lock() {
        *slot = Some((msg.to_string(), std::time::Instant::now()));
    }
}

fn clear_dl_notice() {
    if let Ok(mut slot) = LAST_DL_NOTICE.lock() {
        *slot = None;
    }
}

/// 终态重放线程：登录窗存活期间每 3s 把未过期终态 eval 进当前页面——
/// 页面脚本 __mesaReplay 自带页级守卫，同一页只补播一次，换新页才有下一条
fn spawn_notice_replay(app: tauri::AppHandle) {
    if NOTICE_REPLAY_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));
        if app.get_webview_window(LOGIN_WINDOW_LABEL).is_none() {
            break;
        }
        let notice = LAST_DL_NOTICE.lock().ok().and_then(|slot| {
            slot.as_ref()
                .and_then(|(msg, at)| (at.elapsed() < NOTICE_TTL).then(|| msg.clone()))
        });
        let Some(msg) = notice else { continue };
        let js = format!(
            "window.__mesaReplay && window.__mesaReplay({})",
            serde_json::to_string(&msg).unwrap_or_default()
        );
        eval_login_status(&app, &js);
    });
    NOTICE_REPLAY_RUNNING.store(false, std::sync::atomic::Ordering::Release);
}

/// 下载暂存目录（下载在途文件；入库或失败即删，超时残留由 sweep 清理）。
/// 0700 创建——里面是付费墙全文，Linux 多用户机器上别的本地用户不该能读
fn download_staging_dir() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("tmp")
        .join("inst-dl");
    ensure_private_dir(&dir)?;
    Ok(dir)
}

/// 一次下载的暂存落点：时间戳+序号前缀防并发撞名，建议名经 sanitize_fs_name 清洗
fn download_staging_path(suggested: &str) -> PathBuf {
    let dir = download_staging_dir().unwrap_or_else(|e| {
        eprintln!("[inst-access] 下载暂存目录不可用: {e}");
        // 回落也用私有子目录，不再裸进 /tmp（全局可读，2026-09-17 审计）
        let fallback = std::env::temp_dir().join("ccode-inst-dl");
        let _ = ensure_private_dir(&fallback);
        fallback
    });
    let name =
        crate::paths::sanitize_fs_name(suggested).unwrap_or_else(|_| "paper.pdf".to_string());
    let uid = format!(
        "{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        DL_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    dir.join(format!("{uid}-{name}"))
}

/// 导航去重判定（纯逻辑供单测）：同 URL 在窗口期内第二次出现 → true（已处理，
/// 仍取消导航，不再 eval grab）并消费
fn nav_suppress_should_allow(
    seen: &mut std::collections::HashMap<String, std::time::Instant>,
    url: &str,
    now: std::time::Instant,
) -> bool {
    seen.retain(|_, at| now.duration_since(*at) < SUPPRESS_WINDOW);
    if seen.remove(url).is_some() {
        true
    } else {
        seen.insert(url.to_string(), now);
        false
    }
}

/// 发接应事件（下载漏斗与未来其他接应共用同一事件/入库链路）
pub(crate) fn emit_relayed_pdf(app: &tauri::AppHandle, staged: &StagedRelay, size: usize) {
    #[derive(serde::Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Payload {
        path: String,
        size: usize,
        project_root: String,
        file_name_hint: String,
    }
    let (project_root, hint) = staged
        .context
        .clone()
        .unwrap_or_else(|| (String::new(), String::new()));
    let _ = app.emit(
        "inst-pdf-relayed",
        Payload {
            path: staged.path.to_string_lossy().into_owned(),
            size,
            project_root,
            file_name_hint: hint,
        },
    );
}

/// on_download Finished 落点：map 对账 → 读文件 → 校验 → 既有入库链。
/// map miss（完成回调 URL 与请求不一致等罕见路径）时只做残留清扫，不猜文件
fn take_download_entry(url: &str) -> Option<(PathBuf, String)> {
    let mut active = DL_ACTIVE.lock().ok()?;
    if let Some(e) = active.remove(url) {
        return Some(e);
    }
    // blob: / 重定向完成后 URL 常对不上 Requested。单槽时按仅剩那条对账
    if active.len() == 1 {
        let key = active.keys().next().cloned()?;
        return active.remove(&key);
    }
    None
}

fn spawn_download_watchdog(app: tauri::AppHandle, url: String, dest: PathBuf, suggested: String) {
    std::thread::spawn(move || {
        // 等「写完的信号」再收（2026-09-17 审计修正：旧固定 8s 即读，把 >8s 传完的
        // PDF 截断入库，Finished 回调随后到、对账表已被消费，完整版反被当残留清扫）：
        // - Finished 先到（正常路径）会消费对账表 → 本线程直接退场；
        // - 大小连续两轮稳定且（是完整 PDF 或压根不是 PDF——got-html 交给入库链
        //   的回救分支）→ 按 watchdog 兜底收；
        // - 120s 仍无终态 → 清对账表报超时。
        let mut last_len: u64 = 0;
        let mut stable = 0u32;
        for _ in 0..40 {
            std::thread::sleep(Duration::from_secs(3));
            let still = DL_ACTIVE
                .lock()
                .ok()
                .map(|m| m.contains_key(&url) || m.values().any(|(p, _)| p == &dest))
                .unwrap_or(false);
            if !still || !dest.exists() {
                return; // Finished 已对账处理
            }
            let cur = match std::fs::metadata(&dest) {
                Ok(m) => m.len(),
                Err(_) => return,
            };
            if cur == last_len && cur > 0 {
                stable += 1;
            } else {
                stable = 0;
            }
            last_len = cur;
            if stable >= 2 {
                if let Ok(bytes) = std::fs::read(&dest) {
                    let complete =
                        crate::lit_watch::looks_like_pdf(&bytes) && pdf_tail_complete(&bytes);
                    let clearly_not_pdf = !crate::lit_watch::looks_like_pdf(&bytes);
                    if complete || clearly_not_pdf {
                        let consumed = take_download_entry(&url).is_some()
                            || DL_ACTIVE
                                .lock()
                                .ok()
                                .and_then(|mut m| {
                                    let key = m
                                        .iter()
                                        .find(|(_, (p, _))| p == &dest)
                                        .map(|(k, _)| k.clone());
                                    key.and_then(|k| m.remove(&k))
                                })
                                .is_some();
                        if consumed {
                            import_pdf_from_staging(&app, &dest, &suggested, &url);
                        }
                        return;
                    }
                    // 是 PDF 但尾部没 %%EOF：仍在写（站点分段刷盘），继续等
                }
            }
        }
        let leftover = take_download_entry(&url).or_else(|| {
            DL_ACTIVE.lock().ok().and_then(|mut m| {
                let key = m
                    .iter()
                    .find(|(_, (p, _))| p == &dest)
                    .map(|(k, _)| k.clone());
                key.and_then(|k| m.remove(&k))
            })
        });
        if leftover.is_some() {
            let _ = std::fs::remove_file(&dest);
            let msg = "下载超时（站点没把文件发完）";
            crate::logbuf::record("warn", "inst-access", &format!("{msg}: {url}"));
            record_dl_notice(&format!("✗ {msg}"));
            eval_login_status(
                &app,
                "window.__mesaStatusFailed && window.__mesaStatusFailed('下载超时（站点没把文件发完）。请再点 View PDF 或右下角 ⤓')",
            );
        }
    });
}

fn handle_download_finished(app: &tauri::AppHandle, url: &str, success: bool) {
    let entry = take_download_entry(url);
    let Some((path, suggested)) = entry else {
        sweep_stale_staging();
        return;
    };
    remember_pdf_url(url);
    if !success {
        let _ = std::fs::remove_file(&path);
        let msg = "下载未完成（被站点或网络中断）";
        let log = format!("下载中断: {url} → {}", path.display());
        eprintln!("[inst-access] {log}");
        crate::logbuf::record("warn", "inst-access", &log);
        record_dl_notice(&format!("✗ {msg}"));
        eval_login_status(
            app,
            "window.__mesaStatusFailed && window.__mesaStatusFailed('下载未完成（被站点或网络中断）')",
        );
        return;
    }
    import_pdf_from_staging(app, &path, &suggested, url);
}

/// 暂存下载文件入库：校验 → 单槽暂存 → 事件（App 层 inst_save_relayed_pdf 落
/// papers/）。非 PDF 内容（出版商回了网页）打开阅读页，不把人关在文章页干瞪眼
fn import_pdf_from_staging(
    app: &tauri::AppHandle,
    path: &Path,
    fallback_hint: &str,
    source_url: &str,
) {
    let result = std::fs::read(path)
        .map_err(|e| format!("读取下载暂存失败: {e}"))
        .and_then(|bytes| {
            if bytes.is_empty() || bytes.len() > crate::lit_watch::DOWNLOAD_CAP {
                return Err("内容为空或超过 60 MB 上限".into());
            }
            if !crate::lit_watch::looks_like_pdf(&bytes) {
                return Err("got-html".into());
            }
            let mut staged = stage_relayed_pdf(&bytes)?;
            if let Some((_, hint)) = staged.context.as_mut() {
                if hint.trim().is_empty() {
                    *hint = fallback_hint.to_string();
                }
            } else {
                staged.context = Some((String::new(), fallback_hint.to_string()));
            }
            emit_relayed_pdf(app, &staged, bytes.len());
            Ok(())
        });
    match result {
        Ok(()) => {
            let _ = std::fs::remove_file(path);
        }
        Err(msg) => {
            let _ = std::fs::remove_file(path);
            let log = format!("下载内容校验未过（{msg}）: {fallback_hint}");
            eprintln!("[inst-access] {log}");
            crate::logbuf::record("warn", "inst-access", &log);
            if msg == "got-html" {
                // 按出版商形态分派（勿顾此失彼）：Wiley/ACS 型 /doi/pdf/（有阅读页
                // 可转）维持原路打开 epdf；其余（SD pdfft / IEEE stamp.jsp 等中间页
                // 出版商）交回页侧 __mesaGrabVerified 解析真链重试。同一 URL 只回救
                // 一次（防死循环）；旧窗口没这个钩子时保持原报错，不静默
                let retried = GOTHTML_RETRIED
                    .lock()
                    .ok()
                    .and_then(|g| {
                        g.as_ref().and_then(|(last, at)| {
                            (last == source_url && at.elapsed() < GOTHTML_RETRY_WINDOW)
                                .then(|| true)
                        })
                    })
                    .unwrap_or(false);
                if pdf_viewer_url(source_url).is_some() || retried {
                    eval_open_pdf_viewer(app, source_url, "这次拿到的是网页而非 PDF 文件");
                } else {
                    if let Ok(mut g) = GOTHTML_RETRIED.lock() {
                        *g = Some((source_url.to_string(), std::time::Instant::now()));
                    }
                    let js = format!(
                        "window.__mesaGrabVerified ? window.__mesaGrabVerified({}) \
                         : (window.__mesaStatusFailed && window.__mesaStatusFailed('这次拿到的是网页而非 PDF 文件'))",
                        serde_json::to_string(source_url).unwrap_or_default()
                    );
                    record_dl_notice("✗ 拿到的是网页——正在解析真 PDF 链接…");
                    eval_login_status(app, &js);
                }
            } else {
                record_dl_notice(&format!("✗ {msg}"));
                let js = format!(
                    "window.__mesaStatusFailed && window.__mesaStatusFailed({})",
                    serde_json::to_string(&msg).unwrap_or_default()
                );
                eval_login_status(app, &js);
            }
        }
    }
}

fn eval_open_pdf_viewer(app: &tauri::AppHandle, pdf_url: &str, why: &str) {
    let js = if pdf_viewer_url(pdf_url).is_some() {
        let msg = format!("{why}。已打开阅读页，可用页内下载或右下角 ⤓ 再存");
        record_dl_notice(&format!("✗ {msg}"));
        format!(
            "window.__mesaOpenViewer && window.__mesaOpenViewer({}, {})",
            serde_json::to_string(pdf_url).unwrap_or_default(),
            serde_json::to_string(why).unwrap_or_default()
        )
    } else {
        record_dl_notice(&format!("✗ {why}"));
        format!(
            "window.__mesaStatusFailed && window.__mesaStatusFailed({})",
            serde_json::to_string(why).unwrap_or_default()
        )
    };
    eval_login_status(app, &js);
}

/// 清扫下载暂存目录里超过 1 小时的残留（失败/中断下载的兜底，不猜新文件）；
/// 顺带清扫多槽中继暂存（inst-relay-*.pdf）里已不在槽内、无语境滞留的旧文件
fn sweep_stale_staging() {
    let Ok(dir) = download_staging_dir() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let active: Vec<PathBuf> = DL_ACTIVE
        .lock()
        .map(|active| active.values().map(|(p, _)| p.clone()).collect())
        .unwrap_or_default();
    for entry in entries.flatten() {
        let path = entry.path();
        if active.iter().any(|a| a == &path) {
            continue;
        }
        let stale = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(3600));
        if stale {
            let _ = std::fs::remove_file(&path);
        }
    }
    // 多槽中继暂存的滞留清理（正常路径 inst_save_relayed_pdf 已删；这里兜
    // 「入队后前端没来取/应用重启」的孤儿）
    if let Some(tmp) = dirs::config_dir().map(|d| d.join("ccode").join("tmp")) {
        let in_slot: Vec<PathBuf> = RELAY_SLOT
            .lock()
            .map(|q| q.iter().map(|e| e.path.clone()).collect())
            .unwrap_or_default();
        if let Ok(rd) = std::fs::read_dir(&tmp) {
            for entry in rd.flatten() {
                let path = entry.path();
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if !name.starts_with("inst-relay-") || in_slot.contains(&path) {
                    continue;
                }
                let stale = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > Duration::from_secs(3600));
                if stale {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}

/// 向登录窗 eval 一段状态回写（任意线程可调；窗口不在则静默）
fn eval_login_status(app: &tauri::AppHandle, js: &str) {
    if let Some(w) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = w.eval(js.to_string());
    }
}

/// 登录窗当前 Cookie（失败回落会话罐）。Windows 的 cookie API 不在主线程调。
fn live_window_cookies(app: &tauri::AppHandle) -> Vec<StoredCookie> {
    if let Some(w) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        if let Ok(all) = w.cookies() {
            let cookies = collect_stored_cookies(all);
            if !cookies.is_empty() {
                return cookies;
            }
        }
    }
    load_session()
        .ok()
        .flatten()
        .map(|s| s.cookies)
        .unwrap_or_default()
}

fn live_window_url(app: &tauri::AppHandle) -> Option<String> {
    app.get_webview_window(LOGIN_WINDOW_LABEL)
        .and_then(|w| w.url().ok())
        .map(|u| u.to_string())
        .filter(|u| u.starts_with("http"))
}

/// 导航拦截到的 PDF（含跨域 CDN，如 mdpi-res.com）：页内 fetch 会被 CORS 拦住，
/// a[download] 跨域也不触发 WKDownload。改为用窗口里的会话从 Rust 拉字节，
/// 走同一条入库漏斗。失败再回落页侧 __mesaGrab。
fn spawn_intercepted_pdf_save(app: tauri::AppHandle, target: String) {
    if INTERCEPT_BUSY.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        struct BusyGuard;
        impl Drop for BusyGuard {
            fn drop(&mut self) {
                INTERCEPT_BUSY.store(false, std::sync::atomic::Ordering::Release);
            }
        }
        let _busy = BusyGuard;
        remember_pdf_url(&target);
        let host = reqwest::Url::parse(&target)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default();
        let js = format!(
            "window.__mesaSaving && window.__mesaSaving({})",
            serde_json::to_string(&host).unwrap_or_else(|_| "\"\"".into())
        );
        eval_login_status(&app, &js);

        let app_cookies = app.clone();
        let cookies =
            tauri::async_runtime::spawn_blocking(move || live_window_cookies(&app_cookies))
                .await
                .unwrap_or_default();
        let referer = live_window_url(&app);
        let store = InstSessionStore {
            cookies,
            updated_at: String::new(),
            captured_from: String::new(),
            credible: true, // 窗内实时 cookie，不经落盘判定
        };
        let fetched =
            fetch_via_session_ex(&target, Some(&store), WINDOW_UA, referer.as_deref()).await;
        match fetched {
            Ok(f) if crate::lit_watch::looks_like_pdf(&f.bytes) => {
                match stage_relayed_pdf(&f.bytes) {
                    Ok(staged) => emit_relayed_pdf(&app, &staged, f.bytes.len()),
                    Err(e) => {
                        crate::logbuf::record("warn", "inst-access", &format!("拦截入库失败: {e}"));
                        eval_login_status(
                            &app,
                            &format!(
                                "window.__mesaStatusFailed && window.__mesaStatusFailed({})",
                                serde_json::to_string(&e).unwrap_or_default()
                            ),
                        );
                    }
                }
            }
            other => {
                let why = match other {
                    Ok(f) => format!("内容不是 PDF（{}）", f.content_type),
                    Err(e) => e,
                };
                crate::logbuf::record(
                    "info",
                    "inst-access",
                    &format!("拦截直拉未拿到 PDF（{why}）: {target}"),
                );
                if pdf_viewer_url(&target).is_some() {
                    eval_open_pdf_viewer(&app, &target, "未能直接保存 PDF");
                } else {
                    let grab = format!(
                        "window.__mesaGrab && window.__mesaGrab({}, true)",
                        serde_json::to_string(&target).unwrap_or_default()
                    );
                    eval_login_status(&app, &grab);
                }
            }
        }
    });
}

// ===== Tauri commands =====

#[tauri::command]
pub async fn inst_session_status() -> Result<InstSessionStatusDto, String> {
    status_inner()
}

/// 打开机构登录窗（CARSI 入口/图书馆入口）。登录后窗口**不自动关**：
/// CARSI 流程要在窗里继续点进出版商资源（Wiley/IEEE…）才会建立出版商会话，
/// 每进入一个新域，轮询会把会话增量落罐（设置页实时看到「已保存 N 条」变化）。
/// 全部点完后手动关窗即可，会话已保存
#[tauri::command]
pub async fn inst_open_login(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let start = url.trim().to_string();
    if !valid_http_url(&start) {
        return Err("登录地址须是 http(s):// 开头的完整 URL".into());
    }
    let start_url = reqwest::Url::parse(&start).map_err(|e| format!("登录地址无效: {e}"))?;
    ensure_login_window(
        &app,
        start_url,
        "机构登录 · 登录后可继续点进数据库，会话自动保存，完成后关掉本窗",
    )?;
    spawn_capture_poll(app.clone());
    spawn_notice_replay(app.clone());
    Ok(())
}

/// 「在机构窗口打开」：把某一篇文献的落地页开进机构登录窗（自动播种已保存的登录
/// 会话 + 真浏览器引擎，能过出版商反爬墙）。窗内一切下载经 on_download 漏斗接进
/// 对应项目 papers/（页面自带下载按钮或注入的「⤓ 取 PDF」胶囊都行）。
/// project_root/title 为可选落盘语境（缺省只暂存，回 Mesa 手动关联）
#[tauri::command]
pub async fn inst_open_url(
    app: tauri::AppHandle,
    url: String,
    project_root: Option<String>,
    title: Option<String>,
) -> Result<(), String> {
    let target = url.trim().to_string();
    if !valid_http_url(&target) {
        return Err("地址须是 http(s):// 开头的完整 URL".into());
    }
    clear_dl_notice();
    *RELAY_CONTEXT
        .lock()
        .map_err(|_| "中继状态锁中毒".to_string())? = match (project_root, title) {
        (Some(r), Some(t)) if !r.trim().is_empty() => Some(RelayContext {
            project_root: r.trim().to_string(),
            title: t.trim().to_string(),
            open_url: target.clone(),
        }),
        _ => None,
    };
    let target_url = reqwest::Url::parse(&target).map_err(|e| format!("地址无效: {e}"))?;
    ensure_login_window(
        &app,
        target_url,
        "机构访问 · 已带登录会话；下载开始后 Mesa 自动接住存进项目",
    )?;
    spawn_capture_poll(app.clone());
    spawn_notice_replay(app.clone());
    Ok(())
}

/// 中继 PDF 入库（App 层监听 inst-pdf-relayed 后调用）：只认当前暂存槽里的文件
/// （防任意路径读取），落点/登记同 download_paper_pdf（papers/ + project.toml）
#[tauri::command]
pub async fn inst_save_relayed_pdf(
    app: tauri::AppHandle,
    project_root: String,
    path: String,
    file_name_hint: String,
) -> Result<crate::lit_watch::DownloadedPaperDto, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut slot = RELAY_SLOT
            .lock()
            .map_err(|_| "中继状态锁中毒".to_string())?;
        let idx = slot.iter().position(|e| e.path.to_string_lossy() == path);
        let Some(idx) = idx else {
            if let Ok(last) = LAST_RELAY_SAVE.lock() {
                if let Some((at, dto)) = last.as_ref() {
                    if at.elapsed() < Duration::from_secs(3) {
                        return Ok(dto.clone());
                    }
                }
            }
            return Err("没有待入库的 PDF（可能已被处理或应用重启过）".into());
        };
        let entry = slot.remove(idx);
        let (staged, bytes, _at) = (entry.path, entry.bytes, entry.at);
        // 错误路径把条目插回**原位**而非队尾（终检二轮：push 到尾会破坏 FIFO——
        // 槽满逐出队首时，会把另一条仍有效的暂存错杀掉）
        macro_rules! restore {
            ($b:expr) => {{
                let pos = idx.min(slot.len());
                slot.insert(
                    pos,
                    RelaySlotEntry {
                        path: staged,
                        bytes: $b,
                        at: _at,
                    },
                );
            }};
        }
        let bytes = if bytes.is_empty() {
            match std::fs::read(&staged) {
                Ok(b) => b,
                Err(e) => {
                    restore!(Vec::new());
                    return Err(format!("读取暂存 PDF 失败: {e}"));
                }
            }
        } else {
            bytes
        };
        if bytes.len() > crate::lit_watch::DOWNLOAD_CAP {
            restore!(bytes);
            return Err("文件超过 60 MB 上限".into());
        }
        if !crate::lit_watch::looks_like_pdf(&bytes) {
            restore!(bytes);
            return Err("暂存内容不是有效的 PDF".into());
        }
        let root = crate::projects::ensure_task_project_root(Path::new(&project_root))?;
        let dto = match save_relayed_at(&root, &file_name_hint, &bytes) {
            Ok(d) => d,
            Err(e) => {
                restore!(bytes);
                return Err(e);
            }
        };
        let _ = std::fs::remove_file(&staged);
        if let Ok(mut last) = LAST_RELAY_SAVE.lock() {
            *last = Some((std::time::Instant::now(), dto.clone()));
        }
        Ok(dto)
    })
    .await
    .map_err(|e| format!("入库失败: {e}"))?;
    // 结果回写登录窗浮条：用户正盯着那个窗，这里是最直接的成败反馈
    // （OS 通知可能没授权，不能只靠它）；同时记入终态存档——下载期间页面
    // 跳转过的话，这里的 eval 打在死页面上，靠重放线程在新页面补播
    if let Ok(dto) = &result {
        record_dl_notice(&if dto.dedup {
            format!("✓ papers/ 已有同一份（{}），未重复存入", dto.name)
        } else {
            format!("✓ 已存进 papers/：{}", dto.name)
        });
    } else if let Err(e) = &result {
        record_dl_notice(&format!("✗ 入库失败：{e}"));
    }
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let js = match &result {
            Ok(dto) => format!(
                "window.__mesaStatusSaved && window.__mesaStatusSaved({})",
                serde_json::to_string(&if dto.dedup {
                    format!("papers/ 已有同一份（{}），未重复存入", dto.name)
                } else {
                    dto.name.clone()
                })
                .unwrap_or_default()
            ),
            Err(e) => format!(
                "window.__mesaStatusFailed && window.__mesaStatusFailed({})",
                serde_json::to_string(e).unwrap_or_default()
            ),
        };
        let _ = window.eval(js);
    }
    result
}

/// 落盘复用 lit_watch 的口径（papers/ + 登记）；save_and_register_pdf 是其私有件，
/// 薄封装在此避免整段复制
fn save_relayed_at(
    root: &Path,
    hint: &str,
    bytes: &[u8],
) -> Result<crate::lit_watch::DownloadedPaperDto, String> {
    crate::lit_watch::save_paper_bytes(root, hint, bytes)
}

/// 手动保存会话（「我已登录，保存会话」）：**只服务于内嵌登录窗**（把窗里 Cookie
/// 倒进 Mesa，供无头阶梯/调试）。浏览器通道无需保存——浏览器 profile 自己长期
/// 有效；内嵌窗没开时按此口径解释，不引导用户做多余操作
#[tauri::command]
pub async fn inst_capture_session(app: tauri::AppHandle) -> Result<InstSessionStatusDto, String> {
    let window = app
        .get_webview_window(LOGIN_WINDOW_LABEL)
        .ok_or("在浏览器中登录的无需保存会话（浏览器里长期有效，直接去待获取清单点「浏览器打开」下载即可）。此按钮只用于内嵌登录窗——需要时先点「内嵌窗登录」")?;
    let host = window
        .url()
        .ok()
        .as_ref()
        .map(|u| u.as_str().to_string())
        .and_then(|u| {
            if u.starts_with("http") {
                Some(host_of_url(&u))
            } else {
                None
            }
        })
        .unwrap_or_default();
    capture_from_window(&window, &host)
        .map_err(|e| format!("保存会话失败：{e}（确认已在内嵌窗里完成登录）"))?;
    status_inner()
}

#[tauri::command]
pub async fn inst_clear_session(app: tauri::AppHandle) -> Result<InstSessionStatusDto, String> {
    // 三步走（2026-09-17 审计：旧实现只删磁盘文件——登录窗 cookie store 还活着，
    // 窗里继续下载仍带全部机构会话；窗内 cookie 结构一变轮询又把整罐写回「复活」）。
    // 代际标记必须**最先**置位（终检二轮：删 cookie 数百 ms、关窗再置位的窗口期
    // 里，轮询一拍就能把整罐写回刚删的文件）
    SESSION_CLEAR_ARMED.store(true, std::sync::atomic::Ordering::Release);
    let path = session_path()?;
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            SESSION_CLEAR_ARMED.store(false, std::sync::atomic::Ordering::Release);
            return Err(format!("清除机构会话失败: {e}"));
        }
    }
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let win = window.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Ok(all) = win.cookies() {
                for c in all {
                    let _ = win.delete_cookie(c);
                }
            }
        })
        .await;
        let _ = window.close();
    }
    status_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(domain: &str, path: &str, secure: bool) -> StoredCookie {
        StoredCookie {
            name: "sess".into(),
            value: "abc".into(),
            domain: domain.into(),
            path: path.into(),
            secure,
            http_only: false,
        }
    }

    #[test]
    fn proxy_wrap_appends_encoded_target() {
        assert_eq!(
            proxy_wrap("https://proxy.uni.edu/login?url=", "https://a.com/x"),
            "https://proxy.uni.edu/login?url=https%3A%2F%2Fa.com%2Fx"
        );
        // 已带 query 的前缀接 &
        assert_eq!(
            proxy_wrap("https://p.edu/login?x=1", "https://a.com/y z"),
            "https://p.edu/login?x=1&url=https%3A%2F%2Fa.com%2Fy%20z"
        );
    }

    #[test]
    fn cookie_header_matches_domain_path_secure() {
        let jar = vec![
            cookie("proxy.uni.edu", "/", false),
            StoredCookie {
                name: "securec".into(),
                value: "1".into(),
                domain: ".sciencedirect.com".into(),
                path: "/doi/".into(),
                secure: true,
                http_only: false,
            },
        ];
        let u = reqwest::Url::parse("https://proxy.uni.edu/login?url=x").unwrap();
        assert_eq!(cookie_header_for(&jar, &u), "sess=abc");
        // 子域命中（前导点归一）
        let u2 = reqwest::Url::parse("https://www.sciencedirect.com/doi/pdf/1").unwrap();
        assert_eq!(cookie_header_for(&jar, &u2), "securec=1");
        // 路径不前缀命中：不出场
        let u3 = reqwest::Url::parse("https://www.sciencedirect.com/science/article").unwrap();
        assert_eq!(cookie_header_for(&jar, &u3), "");
        // secure cookie 不走 http
        let u4 = reqwest::Url::parse("http://www.sciencedirect.com/doi/x").unwrap();
        assert_eq!(cookie_header_for(&jar, &u4), "");
        // 不同域不外泄
        let u5 = reqwest::Url::parse("https://evil.com/").unwrap();
        assert_eq!(cookie_header_for(&jar, &u5), "");
    }

    #[test]
    fn doi_from_url_variants() {
        assert_eq!(
            doi_from_url("10.1002/adma.202304268"),
            Some("10.1002/adma.202304268".into())
        );
        assert_eq!(
            doi_from_url("doi: 10.1038/s41586-024-1"),
            Some("10.1038/s41586-024-1".into())
        );
        assert_eq!(
            doi_from_url("https://doi.org/10.1016/j.nano.2023.07.011."),
            Some("10.1016/j.nano.2023.07.011".into())
        );
        assert_eq!(
            doi_from_url("https://dx.doi.org/10.1109/ICRA.1"),
            Some("10.1109/ICRA.1".into())
        );
        assert_eq!(
            doi_from_url("https://example.com/view?doi=10.1126/science.abc123"),
            Some("10.1126/science.abc123".into())
        );
        assert_eq!(doi_from_url("https://example.com/article"), None);
        assert_eq!(doi_from_url("not a doi"), None);
        assert_eq!(
            doi_from_url("https://onlinelibrary.wiley.com/doi/pdf/10.1002/idm2.70075"),
            Some("10.1002/idm2.70075".into())
        );
        assert_eq!(
            doi_from_url("https://onlinelibrary.wiley.com/doi/epdf/10.1002/idm2.70075"),
            Some("10.1002/idm2.70075".into())
        );
        assert_eq!(
            doi_from_url("https://onlinelibrary.wiley.com/doi/10.1002/idm2.70075"),
            Some("10.1002/idm2.70075".into())
        );
    }

    #[test]
    fn same_paper_url_matches_doi_not_title() {
        assert!(same_paper_url(
            "https://doi.org/10.1002/idm2.70075",
            "https://onlinelibrary.wiley.com/doi/pdf/10.1002/idm2.70075"
        ));
        assert!(!same_paper_url(
            "https://doi.org/10.1002/adma.202304268",
            "https://onlinelibrary.wiley.com/doi/pdf/10.1002/idm2.70075"
        ));
    }

    #[test]
    fn file_hint_uses_open_title_only_for_same_doi() {
        let ctx = Some(RelayContext {
            project_root: "/p".into(),
            title: "Constructing Charge Transfer Pathways".into(),
            open_url: "https://doi.org/10.1002/adma.202304268".into(),
        });
        assert_eq!(
            file_hint_from_context(
                &ctx,
                "https://onlinelibrary.wiley.com/doi/pdf/10.1002/idm2.70075"
            ),
            "10.1002/idm2.70075"
        );
        assert_eq!(
            file_hint_from_context(
                &ctx,
                "https://onlinelibrary.wiley.com/doi/pdf/10.1002/adma.202304268"
            ),
            "Constructing Charge Transfer Pathways"
        );
    }

    #[test]
    fn pdf_link_candidates_prefers_citation_pdf_url() {
        let base =
            reqwest::Url::parse("https://www.sciencedirect.com/science/article/pii/S1").unwrap();
        let html = r##"
        <html><head>
        <meta name="citation_pdf_url" content="https://www.sciencedirect.com/science/article/pii/S1/pdfft?md5=x&amp;pid=1">
        </head><body>
        <a href="/science/article/pii/S1/pdf">Full text</a>
        <a href="javascript:alert(1)">no</a>
        <a href="#top">top</a>
        <a href="mailto:a@b.c">mail</a>
        </body></html>"##;
        let out = pdf_link_candidates(html, &base);
        assert_eq!(out.len(), 2);
        assert!(out[0]
            .starts_with("https://www.sciencedirect.com/science/article/pii/S1/pdfft?md5=x&pid=1"));
        assert_eq!(
            out[1],
            "https://www.sciencedirect.com/science/article/pii/S1/pdf"
        );
    }

    #[test]
    fn pdf_link_candidates_meta_attr_order_and_dedup() {
        let base = reqwest::Url::parse("https://onlinelibrary.wiley.com/doi/10.1/x").unwrap();
        let html = r#"
        <meta content="/doi/pdf/10.1/x" name="citation_pdf_url">
        <a href="/doi/pdf/10.1/x">PDF</a>
        <a href='/doi/epdf/10.1/x'>ePDF</a>"#;
        let out = pdf_link_candidates(html, &base);
        assert_eq!(
            out,
            vec![
                "https://onlinelibrary.wiley.com/doi/pdf/10.1/x".to_string(),
                "https://onlinelibrary.wiley.com/doi/epdf/10.1/x".to_string(),
            ]
        );
    }

    #[test]
    fn html_needs_login_detects_password_input() {
        assert!(html_needs_login(
            r#"<form><input type="password" name="pass"></form>"#
        ));
        assert!(html_needs_login(r#"<INPUT TYPE='password'>"#));
        assert!(!html_needs_login("<html><body>article body</body></html>"));
    }

    #[test]
    fn failure_hint_splits_bot_wall_from_session_issues() {
        let walled = institutional_failure_hint("HTTP 403 Forbidden");
        assert!(walled.contains("浏览器打开"), "{walled}");
        assert!(
            !walled.contains("在机构窗口打开"),
            "旧口径指向已下线的按钮: {walled}"
        );
        let expired = institutional_failure_hint("停在机构登录页——会话可能已过期");
        assert!(expired.contains("重新登录"), "{expired}");
        assert!(!expired.contains("在机构窗口打开"));
        assert!(expired.contains("关联本地 PDF"), "{expired}");
    }

    #[test]
    fn domain_matches_suffix_and_exact() {
        assert!(domain_matches("onlinelibrary.wiley.com", "wiley.com"));
        assert!(domain_matches(
            "onlinelibrary.wiley.com",
            ".onlinelibrary.wiley.com"
        ));
        assert!(domain_matches("wiley.com", "wiley.com"));
        assert!(!domain_matches("evil-wiley.com", "wiley.com"));
        assert!(!domain_matches("wiley.com", ""));
    }

    #[test]
    fn chunk_nav_parse_rules() {
        assert_eq!(
            parse_chunk_nav("mesa-chunk://c/1/3/aGVsbG8="),
            Some((1, 3, "aGVsbG8="))
        );
        assert_eq!(
            parse_chunk_nav("mesa-chunk://c/3/3/QUJD"),
            Some((3, 3, "QUJD"))
        );
        // seq 越界 / total 为 0 或超限 / 缺段：不收
        assert_eq!(parse_chunk_nav("mesa-chunk://c/0/3/eHg="), None);
        assert_eq!(parse_chunk_nav("mesa-chunk://c/4/3/eHg="), None);
        assert_eq!(parse_chunk_nav("mesa-chunk://c/1/0/eHg="), None);
        assert_eq!(parse_chunk_nav("mesa-chunk://c/1/999999/eHg="), None);
        assert_eq!(parse_chunk_nav("mesa-chunk://c/1/3/"), None);
        assert_eq!(parse_chunk_nav("mesa-chunk://x/1/3/eHg="), None);
        assert_eq!(parse_chunk_nav("https://example.com/"), None);
    }

    #[test]
    fn pdfish_url_matches_pdf_files_not_epdf_viewers() {
        assert!(pdfish_url(
            "https://onlinelibrary.wiley.com/doi/pdf/10.1002/adma.202304268"
        ));
        assert!(pdfish_url(
            "https://www.sciencedirect.com/science/article/pii/S1/pdfft?md5=x"
        ));
        assert!(pdfish_url("https://arxiv.org/pdf/2401.12345v2"));
        assert!(pdfish_url(
            "https://example.com/path/file.pdf?download=true"
        ));
        // epdf 是 Wiley/ACS 阅读页：放行，点工具栏 PDF 才能打开
        assert!(!pdfish_url(
            "https://onlinelibrary.wiley.com/doi/epdf/10.1002/adma.202304268"
        ));
        assert!(!pdfish_url(
            "https://pubs.acs.org/doi/epdf/10.1021/acs.1c00000"
        ));
        assert!(pdfish_url(
            "https://pubs.acs.org/doi/pdf/10.1021/acs.1c00000?download=true"
        ));
        assert!(pdfish_url(
            "https://pdf.sciencedirect.com/science/article/pii/S092583882600813X"
        ));
        assert!(pdfish_url("https://www.mdpi.com/2673-6497/7/1/7/pdf"));
        assert!(pdfish_url(
            "https://mdpi-res.com/d_attachment/solids/solids-07-00007/article_deploy/solids-07-00007.pdf?version=1"
        ));
        assert!(!pdfish_url(
            "https://onlinelibrary.wiley.com/doi/10.1002/adma.202304268"
        ));
        assert!(!pdfish_url("https://www.mdpi.com/2673-6497/7/1/7"));
        assert!(!pdfish_url("https://www.carsi.edu.cn/resource/1"));
    }

    #[test]
    fn pdf_viewer_url_rewrites_wiley_pdf_to_epdf() {
        assert_eq!(
            pdf_viewer_url("https://onlinelibrary.wiley.com/doi/pdf/10.1002/idm2.70075"),
            Some("https://onlinelibrary.wiley.com/doi/epdf/10.1002/idm2.70075".into())
        );
        assert_eq!(
            pdf_viewer_url("https://onlinelibrary.wiley.com/doi/epdf/10.1002/idm2.70075"),
            None
        );
        assert_eq!(pdf_viewer_url("https://mdpi-res.com/x/paper.pdf"), None);
    }

    #[test]
    fn image_url_matches_elsevier_graphical_abstract() {
        assert!(image_url(
            "https://ars.els-cdn.com/content/image/1-s2.0-S092583882600813X-ga1-lrg.jpg"
        ));
        assert!(image_url("https://www.example.com/fig.png?w=800"));
        assert!(!image_url(
            "https://www.sciencedirect.com/science/article/pii/S092583882600813X/pdfft?pid=main.pdf"
        ));
    }

    #[test]
    fn nav_suppress_allows_second_hit_then_rearms() {
        let mut seen = std::collections::HashMap::new();
        let t0 = std::time::Instant::now();
        // 首次（false = 尚未处理，调用方取消导航并 eval grab）
        assert!(!nav_suppress_should_allow(
            &mut seen,
            "https://x.com/doi/pdf/10.1/a",
            t0
        ));
        // 窗口期内再来：true = 已处理（调用方仍取消导航，不再 grab）
        assert!(nav_suppress_should_allow(
            &mut seen,
            "https://x.com/doi/pdf/10.1/a",
            t0 + Duration::from_secs(1)
        ));
        // 消费后第三次重新武装（用户再点一次仍应 grab）
        assert!(!nav_suppress_should_allow(
            &mut seen,
            "https://x.com/doi/pdf/10.1/a",
            t0 + Duration::from_secs(2)
        ));
        // 超窗旧记录被清掉：视作首次（用户隔了挺久再点，仍应被接住）
        seen.insert("https://x.com/doi/pdf/10.1/b".into(), t0);
        assert!(!nav_suppress_should_allow(
            &mut seen,
            "https://x.com/doi/pdf/10.1/b",
            t0 + SUPPRESS_WINDOW + Duration::from_secs(1)
        ));
    }

    #[test]
    fn download_staging_path_sanitizes_and_never_collides() {
        let a = download_staging_path("../../evil/name?.pdf");
        let b = download_staging_path("../../evil/name?.pdf");
        let name_a = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name_a.contains("evil"), "建议名应保留有效部分: {name_a}");
        // 无路径分隔符 → 只是名字里的子串，作为单段文件名逃不出暂存目录
        assert!(!name_a.contains('/'), "不得带路径分隔符: {name_a}");
        assert!(!name_a.contains('\\'), "不得带 Windows 分隔符: {name_a}");
        assert_ne!(a, b, "uuid 前缀必须防并发撞名");
        assert_eq!(
            a.parent(),
            download_staging_dir().ok().as_deref(),
            "必须落在受控暂存目录里"
        );
    }

    #[test]
    fn cookie_signature_tracks_value_rotation() {
        let a = vec![cookie("a.com", "/", false), cookie("b.com", "/", false)];
        // 同名同域换值（重新登录/会话轮换——EZproxy JSESSIONID 刷新最常见）必须
        // 算指纹变化：旧口径只看 name@domain，换值永不落罐，无头阶梯一直带旧值
        let mut b = a.clone();
        b[0].value = "changed".into();
        assert_ne!(cookie_signature(&a), cookie_signature(&b));
        // 新域出现 = 结构变化
        b.push(cookie("c.com", "/", false));
        assert_ne!(cookie_signature(&a), cookie_signature(&b));
        // 完全一致 = 指纹一致
        assert_eq!(cookie_signature(&a), cookie_signature(&a.clone()));
    }

    #[test]
    fn credible_session_requires_publisher_or_prefix_domain() {
        let entry_only = vec![cookie("carsi.edu.cn", "/", false)];
        assert!(!credible_session(&entry_only, "ezproxy.uni.edu"));
        // 命中前缀主机（EZproxy 会话种在前缀域）
        let via_prefix = vec![cookie("ezproxy.uni.edu", "/", false)];
        assert!(credible_session(&via_prefix, "ezproxy.uni.edu"));
        // 命中出版商域（CARSI 点进出版商后）
        let via_pub = vec![
            cookie("carsi.edu.cn", "/", false),
            StoredCookie {
                name: "sess".into(),
                value: "x".into(),
                domain: "onlinelibrary.wiley.com".into(),
                path: "/".into(),
                secure: true,
                http_only: false,
            },
        ];
        assert!(credible_session(&via_pub, ""));
        // 通配 DNS 改写域不算（host 不以出版商域为点后缀）——种在前缀域的会话才算
        assert!(!credible_session(&via_prefix, ""));
    }

    #[test]
    fn saml_relay_detected_by_hidden_form() {
        assert!(saml_relay(
            r#"<form method="post" action="https://idp.edu.edu/idp/profile/SAML2/POST/SSO"><input type="hidden" name="SAMLRequest" value="x"/></form>"#
        ));
        assert!(saml_relay(
            r#"<body onload="document.forms[0].submit()"><input type="hidden" name="SAMLResponse" value="y">"#
        ));
        assert!(!saml_relay("<html><body>article</body></html>"));
        // 正文里偶然提到 SAMLRequest 一词、没有 form：不算
        assert!(!saml_relay("<p>The SAMLRequest parameter is used by…</p>"));
    }

    #[test]
    fn proxy_wrap_strips_qurl_and_case_insensitive() {
        // qurl 形态：旧口径剥 url= 剩 login?q，拼出 login?q&url=… 坏链
        assert_eq!(
            proxy_wrap("https://proxy.uni.edu/login?qurl=", "https://a.com/x"),
            "https://proxy.uni.edu/login?url=https%3A%2F%2Fa.com%2Fx"
        );
        assert_eq!(
            proxy_wrap("https://proxy.uni.edu/login?URL=", "https://a.com/x"),
            "https://proxy.uni.edu/login?url=https%3A%2F%2Fa.com%2Fx"
        );
        assert_eq!(
            proxy_wrap("https://p.edu/login?qurl=", "https://a.com/y"),
            "https://p.edu/login?url=https%3A%2F%2Fa.com%2Fy"
        );
    }

    #[test]
    fn target_already_proxied_matches_prefix_host_and_subdomains() {
        let prefix = "https://ezproxy.uni.edu/login?url=";
        // 用户从 EZproxy 会话复制的完整代理链
        assert!(target_already_proxied(
            "https://ezproxy.uni.edu/login?url=https%3A%2F%2Fwww.sciencedirect.com%2Fx",
            prefix
        ));
        // 通配 DNS 改写域（前缀主机的子域）
        assert!(target_already_proxied(
            "https://www-sciencedirect-com.ezproxy.uni.edu/science/article/pii/S1",
            prefix
        ));
        // 直连出版商：不是代理形态，需要包
        assert!(!target_already_proxied(
            "https://www.sciencedirect.com/science/article/pii/S1",
            prefix
        ));
        assert!(!target_already_proxied("https://a.com/x", ""));
    }

    #[test]
    fn oa_pick_unpaywall_falls_back_to_oa_locations() {
        // best 是仓储落地页（无直链、url 不含 .pdf）但 oa_locations 里有直链副本
        let v: serde_json::Value = serde_json::json!({
            "best_oa_location": { "url_for_pdf": null, "url": "https://repo.edu/handle/1234" },
            "oa_locations": [
                { "url_for_pdf": "https://repo.edu/bitstream/1234/article.pdf", "url": "https://repo.edu/handle/1234" }
            ]
        });
        assert_eq!(
            oa_pick_unpaywall(Some(&v)),
            Some((
                "https://repo.edu/bitstream/1234/article.pdf".into(),
                "unpaywall"
            ))
        );
        // best 自带直链：最优先
        let b: serde_json::Value = serde_json::json!({
            "best_oa_location": { "url_for_pdf": "https://pub.com/x.pdf" }
        });
        assert_eq!(
            oa_pick_unpaywall(Some(&b)),
            Some(("https://pub.com/x.pdf".into(), "unpaywall"))
        );
        assert_eq!(oa_pick_unpaywall(None), None);
    }

    #[test]
    fn oa_pick_openalex_scans_locations_array() {
        let v: serde_json::Value = serde_json::json!({
            "best_oa_location": { "landing_page_url": "https://repo.edu/x" },
            "locations": [
                { "landing_page_url": "https://a.edu/x" },
                { "pdf_url": "https://a.edu/x/article.pdf" }
            ]
        });
        assert_eq!(
            oa_pick_openalex(Some(&v)),
            Some(("https://a.edu/x/article.pdf".into(), "openalex"))
        );
        assert_eq!(oa_pick_openalex(None), None);
    }

    #[test]
    fn pdf_link_candidates_for_requires_single_paper_attribution() {
        let base = reqwest::Url::parse("https://www.sciencedirect.com").unwrap();
        // 列表/检索页形态：多条不同 pdfish 锚链、无 meta 无 DOI → 不猜
        let listy = r#"
        <a href="/science/article/pii/S1/pdfft">1</a>
        <a href="/science/article/pii/S2/pdfft">2</a>"#;
        assert!(pdf_link_candidates_for(listy, &base, None).is_empty());
        // 有本篇 DOI：含 DOI 的链优先于其它主链
        let doi_page = r#"
        <a href="/doi/pdf/10.1002/adma.202304268?download=true">PDF</a>
        <a href="/doi/pdf/10.1002/adma.202304269">other</a>"#;
        let out = pdf_link_candidates_for(doi_page, &base, Some("10.1002/adma.202304268"));
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("adma.202304268?download=true"));
        // 补充材料降权：有主链时 mmc 链排后；只剩补充材料链不采用（SD 误收形态）
        let sd_like = r#"
        <a href="/science/article/pii/S1/pdf/mmc1.pdf">supplement</a>"#;
        assert!(pdf_link_candidates_for(sd_like, &base, Some("10.1016/j.x.1")).is_empty());
    }

    #[test]
    fn extract_attr_requires_word_boundary() {
        // data-href 内部的 href= 不得误当 href 取值
        let tag = r#"<a data-href="/supp/mmc1.pdf" title="pdf href=1" href="/a.pdf">"#;
        let line = tag.trim_start_matches('<');
        assert_eq!(extract_attr(line, "href").as_deref(), Some("/a.pdf"));
        assert_eq!(
            extract_attr(line, "data-href").as_deref(),
            Some("/supp/mmc1.pdf")
        );
        // 属性值里的字样（title="pdf href=1"）不得抢先命中
        assert_eq!(extract_attr(line, "title").as_deref(), Some("pdf href=1"));
    }

    #[test]
    fn decode_chunk_parts_handles_padded_mid_chunks() {
        // 复现页侧分块：每块独立 btoa（自带填充）——65536 块长时代拼接整体解码
        // 必挂（Invalid symbol 61），逐块解码对任意块长都对
        let mut bytes = Vec::new();
        for i in 0..200_000u32 {
            bytes.push((i % 251) as u8);
        }
        let engine = base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;
        let mut parts = std::collections::BTreeMap::new();
        let chunk = 65536usize;
        let total = bytes.len().div_ceil(chunk);
        for (i, part) in bytes.chunks(chunk).enumerate() {
            let mut s = String::new();
            engine.encode_string(part, &mut s);
            parts.insert((i + 1) as u32, s);
        }
        assert!(total >= 3, "样例必须跨多块");
        let decoded = decode_chunk_parts(&parts).expect("逐块解码必须成功");
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn chunk_relay_requires_recent_begin_handshake() {
        let t0 = std::time::Instant::now();
        let total = 3;
        assert!(chunk_relay_armed(
            &Some((total, t0)),
            total,
            t0 + Duration::from_secs(30)
        ));
        // 块数不吻合：拒
        assert!(!chunk_relay_armed(
            &Some((total, t0)),
            total + 1,
            t0 + Duration::from_secs(30)
        ));
        // 超出 60s 武装窗：拒
        assert!(!chunk_relay_armed(
            &Some((total, t0)),
            total,
            t0 + Duration::from_secs(61)
        ));
        // 从未握手：拒
        assert!(!chunk_relay_armed(&None, total, t0));
    }

    #[test]
    fn pdf_tail_complete_detects_truncation() {
        let mut full = b"%PDF-1.7 fake body\n%%EOF\n".to_vec();
        assert!(pdf_tail_complete(&full));
        // 头 1024 字节完整、尾部被截：旧魔数校验照样过，尾部校验拦下
        let truncated: Vec<u8> = b"%PDF-1.7 "
            .iter()
            .copied()
            .chain(std::iter::repeat_n(b'A', 5000))
            .collect();
        assert!(!pdf_tail_complete(&truncated));
        // %%EOF 后带少量空白（正常写法）仍在 2KB 窗口内
        full.extend_from_slice(b"\n\n");
        assert!(pdf_tail_complete(&full));
    }

    /// 本地 mock HTTP 上游：routes = (路径前缀, 响应) 逐请求匹配；accept_count 次
    /// 后关闸。2026-09-17 审计：全仓没有一个异步测试，网络状态机（重定向/落地页
    /// 候选/登录页分流）此前零覆盖
    fn mock_http_server(routes: Vec<(String, String)>) -> std::net::SocketAddr {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for (path_prefix, body) in routes {
                let Ok((mut sock, _)) = listener.accept() else {
                    return;
                };
                let mut buf = [0u8; 4096];
                let n = sock.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
                assert!(
                    req.contains(&path_prefix.to_ascii_lowercase()),
                    "请求 {req:?} 应命中路由 {path_prefix:?}"
                );
                let _ = sock.write_all(body.as_bytes());
                let _ = sock.shutdown(std::net::Shutdown::Write);
            }
        });
        addr
    }

    fn http_resp(status_line: &str, headers: &[(&str, &str)], body: &str) -> String {
        let mut out = format!("HTTP/1.1 {status_line}\r\n");
        for (k, v) in headers {
            out.push_str(&format!("{k}: {v}\r\n"));
        }
        out.push_str("Connection: close\r\n\r\n");
        out.push_str(body);
        out
    }

    #[test]
    fn fetch_via_channel_follows_redirect_to_pdf() {
        let addr = mock_http_server(vec![
            (
                "get /start".into(),
                http_resp("302 Found", &[("Location", "/pdf")], ""),
            ),
            (
                "get /pdf".into(),
                http_resp(
                    "200 OK",
                    &[("Content-Type", "application/pdf")],
                    "%PDF-1.7 redirect target %%EOF\n",
                ),
            ),
        ]);
        let ch = InstitutionalChannel {
            prefix: None,
            session: None,
        };
        let bytes =
            tauri::async_runtime::block_on(fetch_via_channel(&format!("http://{addr}/start"), &ch))
                .expect("重定向到直链 PDF 必须取到");
        assert!(crate::lit_watch::looks_like_pdf(&bytes));
    }

    #[test]
    fn fetch_via_channel_landing_page_resolves_candidate() {
        let landing = r#"<html><head>
        <meta name="citation_pdf_url" content="/pdf?md5=a&amp;pid=1">
        </head><body>article</body></html>"#;
        let addr = mock_http_server(vec![
            (
                "get /page".into(),
                http_resp("200 OK", &[("Content-Type", "text/html")], landing),
            ),
            (
                "get /pdf".into(),
                http_resp(
                    "200 OK",
                    &[("Content-Type", "application/pdf")],
                    "%PDF-1.7 landing candidate %%EOF\n",
                ),
            ),
        ]);
        let ch = InstitutionalChannel {
            prefix: None,
            session: None,
        };
        let bytes =
            tauri::async_runtime::block_on(fetch_via_channel(&format!("http://{addr}/page"), &ch))
                .expect("落地页 citation_pdf_url 候选必须解析并取到");
        assert!(crate::lit_watch::looks_like_pdf(&bytes));
    }

    #[test]
    fn fetch_via_channel_list_page_and_login_page_error_kinds() {
        // 列表/检索页：多条不同 pdfish 锚链、无 meta 无 DOI——不猜，报「没识别出本篇」
        let listy = r#"<html><body>
        <a href="/a1.pdf">1</a> <a href="/a2.pdf">2</a>
        </body></html>"#;
        let addr = mock_http_server(vec![(
            "get /list".into(),
            http_resp("200 OK", &[("Content-Type", "text/html")], listy),
        )]);
        let ch = InstitutionalChannel {
            prefix: None,
            session: None,
        };
        let err =
            tauri::async_runtime::block_on(fetch_via_channel(&format!("http://{addr}/list"), &ch))
                .unwrap_err();
        assert!(err.contains("没识别出本篇"), "{err}");

        // 登录页：提不出候选 + password 输入——报「停在机构登录页」
        let login = r#"<html><body><form><input type="password" name="pass"></form></body></html>"#;
        let addr2 = mock_http_server(vec![(
            "get /login".into(),
            http_resp("200 OK", &[("Content-Type", "text/html")], login),
        )]);
        let err2 = tauri::async_runtime::block_on(fetch_via_channel(
            &format!("http://{addr2}/login"),
            &ch,
        ))
        .unwrap_err();
        assert!(err2.contains("停在机构登录页"), "{err2}");

        // SAML 中继页：无 password、有 SAMLRequest 隐藏表单——报「身份认证中间页」
        let saml = r#"<html><body onload="document.forms[0].submit()"><form method="post"><input type="hidden" name="SAMLRequest" value="x"></form></body></html>"#;
        let addr3 = mock_http_server(vec![(
            "get /saml".into(),
            http_resp("200 OK", &[("Content-Type", "text/html")], saml),
        )]);
        let err3 =
            tauri::async_runtime::block_on(fetch_via_channel(&format!("http://{addr3}/saml"), &ch))
                .unwrap_err();
        assert!(err3.contains("SAML"), "{err3}");
    }

    #[test]
    fn session_roundtrip_and_private_perms() {
        let dir = std::env::temp_dir().join(format!("ccode-inst-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        // 直接测 save/load 逻辑（session_path 绑定全局配置目录，改造成注入路径的内核）
        let store = InstSessionStore {
            cookies: vec![cookie("proxy.uni.edu", "/", false)],
            updated_at: "2026-09-16T00:00:00Z".into(),
            captured_from: "proxy.uni.edu".into(),
            credible: true,
        };
        let path = dir.join("inst-session.json");
        let body = serde_json::to_vec_pretty(&store).unwrap();
        crate::storage::atomic_write(&path, &body, true).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let back: InstSessionStore =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back.cookies.len(), 1);
        assert_eq!(back.cookies[0].domain, "proxy.uni.edu");
        fs::remove_dir_all(&dir).unwrap();
    }
}
