use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime};
use tauri::{AppHandle, Emitter};

// 会话文件监听独立于文件树 watcher：会话根目录通常位于隐藏目录，不能复用
// fs_tree 的隐藏路径噪声过滤。监听只在目标文件/数据库变化时发事件。
struct SessionWatchEntry {
    _watcher: RecommendedWatcher,
}

static SESSION_WATCHERS: OnceLock<Mutex<HashMap<String, SessionWatchEntry>>> = OnceLock::new();

fn session_watchers() -> &'static Mutex<HashMap<String, SessionWatchEntry>> {
    SESSION_WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalized_watch_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn session_watch_targets(file_path: &str) -> (PathBuf, Vec<String>) {
    let expanded = expand_tilde(file_path);
    if let Some((db, _session_id)) = expanded.split_once('#') {
        let db = PathBuf::from(db);
        let mut targets = vec![normalized_watch_path(&db)];
        targets.push(normalized_watch_path(Path::new(&format!(
            "{}-wal",
            db.to_string_lossy()
        ))));
        let parent = db.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();
        // SQLite 可能通过替换/重建文件触发父目录事件；保留目录本身作为目标，
        // 但不匹配同目录下其它具体文件，避免无关写入造成刷新风暴。
        targets.push(normalized_watch_path(&parent));
        return (parent, targets);
    }
    let path = PathBuf::from(expanded);
    let parent = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    (parent, vec![normalized_watch_path(&path)])
}

fn watch_event_matches(paths: &[PathBuf], targets: &[String]) -> bool {
    paths.iter().any(|path| {
        let actual = normalized_watch_path(path);
        targets
            .iter()
            .any(|target| actual == *target || actual.ends_with(target))
    })
}

// ===== 前端 DTO =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageDto {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetaDto {
    pub agent: String, // "claude-code" | "codex"
    pub session_id: String,
    pub project_path: String,
    /// 原始会话工作目录。`project_path` 可能因 worktree 归并而改写为主仓库，
    /// 恢复会话必须优先使用这个值。
    #[serde(default)]
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub created_at: Option<String>, // 文件里的 ISO 时间戳，或文件 mtime
    pub updated_at: Option<String>,
    pub file_path: String,
    pub token_usage: Option<TokenUsageDto>,
    pub cli_version: Option<String>,
    // 以下来自 app.db 的 session_meta 表
    pub pinned: bool,
    pub archived: bool,
    pub custom_title: Option<String>,
    pub tags: Vec<String>,
    pub alive: bool, // 源文件是否还在（不在则回放走快照）
    /// Codex resume/fork 与 Grok compact/继续链长度（同一对话多个文件合并为一条）；无链为 1
    pub chain_count: usize,
    /// 会话发生在任务工作区（git worktree）里时的工作区名（§6.10）；project_path 同时改写为真实仓库
    pub workspace: Option<String>,
    /// 工作区名命中项目档案卡 steps[].workspaceName 时的流水线步骤名（RX3a 对话步骤化）；
    /// 不匹配或无工作区为 None，前端回落显示 workspace 原名
    #[serde(default)]
    pub step_name: Option<String>,
    /// AI 生成的会话摘要（session_meta.summary 列）
    #[serde(default)]
    pub summary: Option<String>,
    /// 进行中：源文件 mtime（opencode 为 time_updated）在最近 60 秒内
    #[serde(default)]
    pub live: bool,
    /// 会话来源；普通 CLI 为 cli，Mesa 无头 AI 为 ccode-ai。
    #[serde(default = "default_session_source")]
    pub source: String,
    /// 内部 AI：provenance 命中，或 Mesa 自建 `ccode-ai-<uuid>` 临时 cwd（登记被清后的会话）。
    /// 用量统计仍只认 provenance 表，不按路径改写。
    #[serde(default)]
    pub internal: bool,
    /// 接力来源（P3 机制四）：该会话由哪个 agent 的哪个会话接力而来；非接力会话为 None
    #[serde(default)]
    pub handoff_from_agent: Option<String>,
    #[serde(default)]
    pub handoff_from_session: Option<String>,
    /// 会话归卡（任务卡）：session_meta.task_id 列；未归卡为 None
    #[serde(default)]
    pub task_id: Option<String>,
    /// task_id 命中所属项目档案卡 [[tasks]] 时由后端回填的卡片名；卡片已删容忍为 None
    #[serde(default)]
    pub task_name: Option<String>,
    /// Codex rollout 元信息的 model_provider（"ccode" = Mesa 启动时 -c 内联定义的 provider，
    /// 不写用户全局配置——恢复时必须挑带 Base URL 的配置重新注入定义，否则 codex 报
    /// "Model provider `ccode` not found"）；其他 agent 或无记录为 None
    #[serde(default)]
    pub provider: Option<String>,
    /// Mesa profile used to start this session when known; historical/external sessions may be null.
    #[serde(default)]
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockDto {
    pub kind: String, // text | thinking | tool_use | tool_result
    pub text: String,
    pub tool_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageDto {
    pub role: String, // user | assistant
    pub blocks: Vec<BlockDto>,
    pub timestamp: Option<String>,
    pub usage: Option<TokenUsageDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPageDto {
    pub messages: Vec<ChatMessageDto>,
    /// 下一页的上界：文件会话为字节偏移，OpenCode 为 time_created。
    pub cursor: Option<u64>,
}

// ===== 通用小工具 =====

fn get_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

fn text_block(text: String) -> BlockDto {
    BlockDto {
        kind: "text".into(),
        text,
        tool_name: None,
    }
}

fn default_session_source() -> String {
    "cli".into()
}

/// ASCII 标签的大小写不敏感查找：只把 ASCII 字母折叠成小写比较，
/// 多字节字符（İ/ß 等 to_ascii_lowercase 后长度会变）不参与转换，
/// 返回的始终是原串的字节下标，可安全切片。
fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    (0..=h.len() - n.len()).find(|&i| {
        h[i..i + n.len()]
            .iter()
            .zip(n.iter())
            .all(|(a, b)| a.to_ascii_lowercase() == *b)
    })
}

/// 按开闭标签处理一段：keep_inner 留下标签里的字（user_query）；
/// false 整段丢掉（turn_aborted 是暂停机读标记，不是助手回复）。
fn rewrite_tagged_block(text: &str, open: &str, close: &str, keep_inner: bool) -> String {
    let mut s = text.to_string();
    loop {
        let Some(start) = find_ascii_ci(&s, open) else {
            break;
        };
        let inner_at = start + open.len();
        if let Some(rel) = find_ascii_ci(&s[inner_at..], close) {
            let inner = s[inner_at..inner_at + rel].trim().to_string();
            let after = inner_at + rel + close.len();
            let mid = if keep_inner { inner } else { String::new() };
            s = format!("{}{}{}", &s[..start], mid, &s[after..]);
        } else if keep_inner {
            s = format!("{}{}", &s[..start], &s[inner_at..]);
            break;
        } else {
            s.truncate(start);
            break;
        }
    }
    s
}

/// Grok 等会把用户话包在 `<user_query>` 里；列表和回放只显示里面的话。
/// Esc 暂停会写下 `<turn_aborted>…`——那是机读标记，不当成助手气泡。
fn unwrap_prompt_tags(text: &str) -> String {
    let s = rewrite_tagged_block(text, "<user_query>", "</user_query>", true);
    rewrite_tagged_block(&s, "<turn_aborted>", "</turn_aborted>", false)
        .trim()
        .to_string()
}

/// 列表标题：折叠空白后截断到约 60 字符，避免多行 prompt 撑高列表。
fn truncate_title(text: &str) -> String {
    const MAX: usize = 60;
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = normalized.trim();
    if t.chars().count() <= MAX {
        t.to_string()
    } else {
        format!("{}…", t.chars().take(MAX).collect::<String>())
    }
}

/// 纯问候语判定（整条消息就是打招呼、没有实质内容）：列表标题拒识——
/// 各解析器「title 为空才取」的守卫会顺势跳到下一条 user 消息（第二句实质 prompt）。
/// 只精确匹配整条文本（折叠大小写、去尾部标点/语气符），「你好，帮我看看 ××」这类
/// 问候+正事同条的不误伤。
fn is_generic_greeting(text: &str) -> bool {
    let t = text
        .trim()
        .trim_end_matches(['!', '！', '~', '～', '。', '.', '?', '？', '…', '，', ','])
        .trim()
        .to_lowercase();
    matches!(
        t.as_str(),
        "hi" | "hello"
            | "hey"
            | "hiya"
            | "howdy"
            | "hi there"
            | "hello there"
            | "hey there"
            | "你好"
            | "您好"
            | "嗨"
            | "哈喽"
            | "在吗"
            | "在么"
            | "喂"
    )
}

fn usable_title(text: &str) -> Option<String> {
    let title = truncate_title(&unwrap_prompt_tags(text));
    let lower = title.trim().to_ascii_lowercase();
    let generic = matches!(
        lower.as_str(),
        "new session"
            | "untitled"
            | "untitled session"
            | "session"
            | "new chat"
            | "新会话"
            | "新对话"
            | "未命名"
            | "未命名会话"
            | "未命名对话"
    );
    if title.is_empty()
        || generic
        || is_generic_greeting(&title)
        || title.starts_with('<')
        || title.starts_with("# AGENTS.md")
        || title.starts_with("The following is the ")
    {
        None
    } else {
        Some(title)
    }
}

fn masked_secret(secret: &str) -> String {
    let tail: String = secret
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("[已隐藏密钥 ···{tail}]")
}

/// 常见密钥前缀检测（sk-/ghp_/AIza/AKIA 等，≥12 字符才命中）；mcp.rs 明文密钥拦截也用它
pub(crate) fn common_secret_token(token: &str) -> Option<String> {
    let start = token
        .char_indices()
        .find(|(_, c)| c.is_ascii_alphanumeric())
        .map(|(i, _)| i)?;
    let end = token
        .char_indices()
        .rev()
        .find(|(_, c)| c.is_ascii_alphanumeric())
        .map(|(i, c)| i + c.len_utf8())?;
    let core = &token[start..end];
    let value = core.rsplit_once('=').map(|(_, v)| v).unwrap_or(core);
    let lower = value.to_ascii_lowercase();
    let known_prefix = lower.starts_with("sk-")
        || lower.starts_with("sk_")
        || lower.starts_with("sk-ant")
        || lower.starts_with("ghp_")
        || lower.starts_with("gho_")
        || lower.starts_with("github_pat_")
        || lower.starts_with("glpat-")
        || lower.starts_with("gsk_")
        || lower.starts_with("xai-")
        || lower.starts_with("xoxb-")
        || lower.starts_with("xoxp-")
        || value.starts_with("AIza")
        || value.starts_with("AKIA")
        // 裸 JWT（三段 base64url，中段足够长）——终端回放里第三方网关密钥常见形态
        || (value.split('.').count() == 3
            && value
                .split('.')
                .take(2)
                .all(|seg| !seg.is_empty() && seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            && value.split('.').nth(1).map(|s| s.chars().count()).unwrap_or(0) >= 12);
    if !known_prefix || value.chars().count() < 12 {
        return None;
    }
    let value_at = core.rfind(value).unwrap_or(0);
    Some(format!(
        "{}{}{}{}",
        &token[..start],
        &core[..value_at],
        masked_secret(value),
        &token[end..]
    ))
}

fn redact_sensitive_text_with(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for secret in secrets {
        if secret.chars().count() >= 8 && out.contains(secret) {
            out = out.replace(secret, &masked_secret(secret));
        }
    }
    out.split_inclusive(char::is_whitespace)
        .map(|part| common_secret_token(part).unwrap_or_else(|| part.to_string()))
        .collect()
}

pub(crate) fn redact_sensitive_text(text: &str) -> String {
    redact_sensitive_text_with(text, &crate::profiles::stored_secrets())
}

fn redact_session_meta(sessions: &mut [SessionMetaDto]) {
    let secrets = crate::profiles::stored_secrets();
    for session in sessions {
        session.title = session
            .title
            .take()
            .map(|t| redact_sensitive_text_with(&t, &secrets));
        session.custom_title = session
            .custom_title
            .take()
            .map(|t| redact_sensitive_text_with(&t, &secrets));
        session.summary = session
            .summary
            .take()
            .map(|t| redact_sensitive_text_with(&t, &secrets));
    }
}

fn redact_conversation(messages: &mut Vec<ChatMessageDto>) {
    let secrets = crate::profiles::stored_secrets();
    for message in messages.iter_mut() {
        for block in &mut message.blocks {
            if block.kind == "text" {
                block.text = unwrap_prompt_tags(&block.text);
            }
            block.text = redact_sensitive_text_with(&block.text, &secrets);
        }
        message
            .blocks
            .retain(|block| block.kind != "text" || !block.text.trim().is_empty());
    }
    messages.retain(|message| !message.blocks.is_empty());
}

/// 工具结果尽量并入上一条 assistant（视觉上跟随发起调用的那条）；没有则单发一条 user
fn push_tool_result(msgs: &mut Vec<ChatMessageDto>, blocks: Vec<BlockDto>, ts: Option<String>) {
    if let Some(last) = msgs.last_mut() {
        if last.role == "assistant" {
            last.blocks.extend(blocks);
            return;
        }
    }
    msgs.push(ChatMessageDto {
        role: "user".into(),
        blocks,
        timestamp: ts,
        usage: None,
    });
}

/// payload 字段可能是字符串也可能是对象，统一成文本
fn stringify_payload(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

pub(crate) fn to_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

// ===== 时间格式化（避免仅为 mtime 格式化引入 chrono） =====

/// Unix 秒 → ISO8601 UTC 字符串（Howard Hinnant 的 civil_from_days 算法）
pub(crate) fn iso_from_unix(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

pub(crate) fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    iso_from_unix(secs)
}

pub(crate) fn expand_tilde(path: &str) -> String {
    // 统一走方言层（~/ 与 ~\ 同等处理，注释见 paths::expand_tilde）
    crate::paths::expand_tilde(path)
}

fn mtime_iso(path: &Path) -> Option<String> {
    let m = fs::metadata(path).ok()?.modified().ok()?;
    let secs = m.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(iso_from_unix(secs))
}

/// live 判定：mtime 距现在不超过 within_secs（文件正在被 agent 写入）
fn mtime_fresh(path: &Path, within_secs: u64) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|e| e.as_secs() <= within_secs)
        .unwrap_or(false)
}

/// `updated_at` 与 `iso_from_unix` 同形（`YYYY-MM-DDTHH:MM:SSZ`），字典序即时间序。
fn iso_within_secs(iso: &str, within_secs: u64) -> bool {
    let now = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    iso >= iso_from_unix(now.saturating_sub(within_secs)).as_str()
}

/// live 是时间派生值：文件指纹缓存不得冻结它。出站现算——过了 60 秒就熄绿点。
/// Qwen 另认 runtime sidecar（进程还在但 jsonl 可能停更）。
fn refresh_live_flag(meta: &mut SessionMetaDto) {
    if !meta.alive {
        meta.live = false;
        return;
    }
    let mut live = meta
        .updated_at
        .as_deref()
        .is_some_and(|t| iso_within_secs(t, 60));
    if !live && meta.agent == "qwen" {
        live = qwen_runtime_sidecar(Path::new(&meta.file_path)).is_some();
    }
    meta.live = live;
}

fn refresh_scan_live(res: &mut ScanResult) {
    for session in &mut res.sessions {
        refresh_live_flag(session);
    }
}

// ===== 文件读取（含 zstd） =====

const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

/// 按 magic 识别 zstd（Codex 旧会话会被后台压缩成 .jsonl.zst）；截断的压缩流保留已解码部分
fn maybe_decompress(bytes: &[u8]) -> Vec<u8> {
    if !bytes.starts_with(&ZSTD_MAGIC) {
        return bytes.to_vec();
    }
    let Ok(mut decoder) = zstd::stream::read::Decoder::new(bytes) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut buf = [0u8; 65536];
    loop {
        match decoder.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
    }
    out
}

pub(crate) fn read_session_bytes(path: &Path) -> Option<Vec<u8>> {
    let raw = fs::read(path).ok()?;
    Some(maybe_decompress(&raw))
}

/// 扫描用窗口化读取：大文件不再全量读入内存——普通文件 seek 读头/尾窗；
/// zstd（Codex 压缩会话）流式解码一遍，只保留头窗 + 尾窗环形缓冲，峰值内存 ~2×budget。
/// 小文件（≤2×budget）照旧全读（含解压）。切片对齐与 head_tail_lines 同语义
fn read_head_tail(path: &Path, budget: usize) -> Option<(Vec<String>, Vec<String>)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(path).ok()?;
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).ok()?;
    if magic == ZSTD_MAGIC {
        // zstd：解压后大小可能远超压缩文件（重复内容压到几 KB），不能按压缩体积走
        // 小文件阈值——一律流式解码一遍，只保留头窗 + 尾窗滑窗，峰值内存 ~2×budget。
        // 尾窗必须批量滑动（drain 让位 + extend_from_slice 接块尾，都是 memmove 级）：
        // 逐字节 pop/extend 曾把 2.8GB 归档 zst 的开机扫描烧到 90 秒（2026-10-15 实证）
        let f2 = fs::File::open(path).ok()?;
        let mut dec = zstd::stream::read::Decoder::new(f2).ok()?;
        let mut head: Vec<u8> = Vec::with_capacity(budget);
        let mut tail: Vec<u8> = Vec::with_capacity(budget);
        let mut total = 0usize;
        let mut buf = [0u8; 65536];
        loop {
            match dec.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    total += n;
                    let chunk = &buf[..n];
                    if head.len() < budget {
                        let take = (budget - head.len()).min(chunk.len());
                        head.extend_from_slice(&chunk[..take]);
                    }
                    // 只需最后 budget 字节：先批量挤出超量前缀，再接本块尾部
                    let keep = n.min(budget);
                    let overflow = (tail.len() + keep).saturating_sub(budget);
                    if overflow > 0 {
                        tail.drain(..overflow);
                    }
                    tail.extend_from_slice(&chunk[n - keep..]);
                }
            }
        }
        let tail_v: Vec<u8> = tail;
        if total <= budget {
            // 解压后不足一窗：head 即全量
            return Some((to_lines(&String::from_utf8_lossy(&head)), Vec::new()));
        }
        if total <= budget * 2 {
            // 两窗之间：head=前 budget 字节，尾部缺口 = tail 的最后 (total-budget) 字节，拼出全量
            let mut all = head;
            all.extend_from_slice(&tail_v[2 * budget - total..]);
            return Some((to_lines(&String::from_utf8_lossy(&all)), Vec::new()));
        }
        Some((align_head(&head), align_tail(&tail_v)))
    } else {
        let len = f.metadata().ok()?.len() as usize;
        if len <= budget * 2 {
            let raw = fs::read(path).ok()?;
            return Some((to_lines(&String::from_utf8_lossy(&raw)), Vec::new()));
        }
        f.seek(SeekFrom::Start(0)).ok()?;
        let mut head = vec![0u8; budget];
        let n = f.read(&mut head).ok()?;
        head.truncate(n);
        f.seek(SeekFrom::Start((len - budget) as u64)).ok()?;
        let mut tail = vec![0u8; budget];
        let n = f.read(&mut tail).ok()?;
        tail.truncate(n);
        Some((align_head(&head), align_tail(&tail)))
    }
}

/// 头窗对齐：截到最后一个换行（丢弃末尾半行）
fn align_head(bytes: &[u8]) -> Vec<String> {
    let end = bytes
        .iter()
        .rposition(|&b| b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    to_lines(&String::from_utf8_lossy(&bytes[..end]))
}

/// 尾窗对齐：从第一个换行之后起（丢弃开头半行）
fn align_tail(bytes: &[u8]) -> Vec<String> {
    let from = bytes
        .iter()
        .position(|&b| b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(bytes.len());
    to_lines(&String::from_utf8_lossy(&bytes[from..]))
}

/// 全量读取下的头/尾切分（read_head_tail 的参照实现，仅测试对照用）
#[cfg(test)]
fn head_tail_lines(bytes: &[u8], budget: usize) -> (Vec<String>, Vec<String>) {
    if bytes.len() <= budget * 2 {
        return (to_lines(&String::from_utf8_lossy(bytes)), Vec::new());
    }
    let head_end = bytes[..budget]
        .iter()
        .rposition(|&b| b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    let tail_from = bytes.len() - budget;
    let tail_from = bytes[tail_from..]
        .iter()
        .position(|&b| b == b'\n')
        .map(|i| tail_from + i + 1)
        .unwrap_or(bytes.len());
    (
        to_lines(&String::from_utf8_lossy(&bytes[..head_end])),
        to_lines(&String::from_utf8_lossy(&bytes[tail_from..])),
    )
}

/// max_depth 限制递归深度：Claude 会话文件直接在项目目录下（更深处的 subagents/workflows
/// 目录是支线副本，不能当会话列出）；Codex 有 YYYY/MM/DD 分层，需要多几层
fn collect_files(dir: &Path, max_depth: usize, out: &mut Vec<PathBuf>) {
    if max_depth == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_files(&p, max_depth - 1, out);
        } else {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if name.ends_with(".jsonl") || name.ends_with(".jsonl.zst") {
                out.push(p);
            }
        }
    }
}

// ===== Claude Code =====

/// 从 user 行提取标题候选；命令输出/meta 样式（XML 标签开头）不算
fn claude_user_title(v: &Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr.iter().find_map(|b| {
            if get_str(b, "type") == Some("text") {
                get_str(b, "text").map(String::from)
            } else {
                None
            }
        })?,
        _ => return None,
    };
    usable_title(&text)
}

fn claude_usage(u: &Value) -> TokenUsageDto {
    let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    TokenUsageDto {
        input: num("input_tokens"),
        output: num("output_tokens"),
        cache_read: num("cache_read_input_tokens"),
        cache_write: num("cache_creation_input_tokens"),
    }
}

fn claude_tool_result_text(b: &Value) -> String {
    match b.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|p| get_str(p, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        other => stringify_payload(other),
    }
}

fn claude_file_meta(path: &Path, alive: bool) -> Option<SessionMetaDto> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let (mut cwd, mut created, mut session_id, mut version) = (None, None, None, None);
    let (mut title, mut ai_title) = (None, None);
    for line in head.iter().chain(&tail) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if cwd.is_none() {
            cwd = get_str(&v, "cwd").map(String::from);
        }
        if created.is_none() {
            created = get_str(&v, "timestamp").map(String::from);
        }
        if session_id.is_none() {
            session_id = get_str(&v, "sessionId").map(String::from);
        }
        if version.is_none() {
            version = get_str(&v, "version").map(String::from);
        }
        if get_str(&v, "type") == Some("ai-title") {
            if let Some(t) = get_str(&v, "aiTitle") {
                if let Some(candidate) = usable_title(t) {
                    ai_title = Some(candidate); // 尾部后出现的有效标题覆盖先出现的
                }
            }
        }
        if title.is_none()
            && get_str(&v, "type") == Some("user")
            && v.get("isSidechain").and_then(|x| x.as_bool()) != Some(true)
            && v.get("isMeta").and_then(|x| x.as_bool()) != Some(true)
        {
            title = claude_user_title(&v);
        }
    }
    // 目录名是 sanitize 后的项目路径（有损），不解码；读不到 cwd 时原样兜底
    let project_path = cwd.clone().unwrap_or_else(|| {
        path.parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some(SessionMetaDto {
        agent: "claude-code".into(),
        session_id,
        project_path: project_path.clone(),
        cwd: Some(project_path.clone()),
        title: ai_title.or(title),
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage: None, // Claude 的用量分散在每行，全量统计留给 P3
        cli_version: version,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive,
        chain_count: 1,
        workspace: None,
        step_name: None,
        summary: None,
        live: alive && mtime_fresh(path, 60),
        source: default_session_source(),
        internal: false,
        handoff_from_agent: None,
        handoff_from_session: None,
        task_id: None,
        task_name: None,
        provider: None,
        profile_id: None,
    })
}

fn parse_claude(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue; // 末行截断等坏行直接跳过
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue; // 子 agent 支线消息不进主对话
        }
        if v.get("isMeta").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        let ts = get_str(&v, "timestamp").map(String::from);
        match get_str(&v, "type") {
            Some("user") => {
                let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
                    continue;
                };
                match content {
                    Value::String(s) => {
                        if !s.trim().is_empty() {
                            msgs.push(ChatMessageDto {
                                role: "user".into(),
                                blocks: vec![text_block(s.clone())],
                                timestamp: ts,
                                usage: None,
                            });
                        }
                    }
                    Value::Array(arr) => {
                        let mut blocks = Vec::new();
                        for b in arr {
                            match get_str(b, "type") {
                                Some("text") => {
                                    if let Some(t) = get_str(b, "text") {
                                        blocks.push(text_block(t.to_string()));
                                    }
                                }
                                Some("tool_result") => blocks.push(BlockDto {
                                    kind: "tool_result".into(),
                                    text: claude_tool_result_text(b),
                                    tool_name: None,
                                }),
                                _ => {}
                            }
                        }
                        if blocks.is_empty() {
                            continue;
                        }
                        if blocks.iter().all(|b| b.kind == "tool_result") {
                            push_tool_result(&mut msgs, blocks, ts);
                        } else {
                            msgs.push(ChatMessageDto {
                                role: "user".into(),
                                blocks,
                                timestamp: ts,
                                usage: None,
                            });
                        }
                    }
                    _ => {}
                }
            }
            Some("assistant") => {
                let Some(msg) = v.get("message") else {
                    continue;
                };
                let mut blocks = Vec::new();
                if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
                    for b in arr {
                        match get_str(b, "type") {
                            Some("text") => {
                                if let Some(t) = get_str(b, "text") {
                                    blocks.push(text_block(t.to_string()));
                                }
                            }
                            Some("thinking") => {
                                if let Some(t) = get_str(b, "thinking") {
                                    blocks.push(BlockDto {
                                        kind: "thinking".into(),
                                        text: t.to_string(),
                                        tool_name: None,
                                    });
                                }
                            }
                            Some("tool_use") => blocks.push(BlockDto {
                                kind: "tool_use".into(),
                                text: b.get("input").map(|i| i.to_string()).unwrap_or_default(),
                                tool_name: get_str(b, "name").map(String::from),
                            }),
                            _ => {}
                        }
                    }
                }
                if blocks.is_empty() {
                    continue;
                }
                msgs.push(ChatMessageDto {
                    role: "assistant".into(),
                    blocks,
                    timestamp: ts,
                    usage: msg.get("usage").map(claude_usage),
                });
            }
            _ => {} // summary / ai-title / file-history-snapshot 等非对话类型
        }
    }
    msgs
}

// ===== Codex CLI =====

fn codex_message_text(p: &Value) -> Option<String> {
    if get_str(p, "type") != Some("message") {
        return None;
    }
    let parts = p.get("content")?.as_array()?;
    let text = parts
        .iter()
        .filter_map(|c| match get_str(c, "type") {
            Some("input_text") | Some("output_text") => get_str(c, "text"),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/** Codex 会把工作区规则/导入历史作为 user response_item 写入会话；这类上下文不是用户对话，不能展示在聊天层。 */
pub(crate) fn is_injected_context_message(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("# AGENTS.md")
        || trimmed.starts_with("\\# AGENTS.md")
        || trimmed.starts_with("The following is the Codex agent history")
        || trimmed.starts_with("The following is the Claude Code history")
}

fn codex_token_usage(v: &Value) -> Option<TokenUsageDto> {
    if get_str(v, "type") != Some("event_msg") {
        return None;
    }
    let p = v.get("payload")?;
    if get_str(p, "type") != Some("token_count") {
        return None;
    }
    let t = p.get("info")?.get("total_token_usage")?;
    let num = |k: &str| t.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    Some(TokenUsageDto {
        input: num("input_tokens"),
        // reasoning token 计入输出侧，与计费口径一致
        output: num("output_tokens") + num("reasoning_output_tokens"),
        cache_read: num("cached_input_tokens"),
        cache_write: num("cache_write_input_tokens"),
    })
}

/// 返回值附带 forked_from_id（resume/fork 链的父线程 id，可能不存在），供扫描时合并链
fn codex_file_meta(
    path: &Path,
    alive: bool,
    archived: bool,
) -> Option<(SessionMetaDto, Option<String>)> {
    // Codex 开头的 user_instructions 块可能很大，头部放宽到 256KB 才更常拿到真实首条提问
    let (head, tail) = read_head_tail(path, 256 * 1024)?;
    let (mut cwd, mut created, mut session_id, mut version, mut title) =
        (None, None, None, None, None);
    let mut forked_from_id = None;
    // rollout 元信息的 model_provider：恢复会话时按它挑兼容 profile（"ccode" = 内联 provider）
    let mut provider = None;
    for line in &head {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if created.is_none() {
            created = get_str(&v, "timestamp").map(String::from);
        }
        if get_str(&v, "type") == Some("session_meta") {
            if let Some(p) = v.get("payload") {
                cwd = get_str(p, "cwd").map(String::from);
                session_id = get_str(p, "id")
                    .or_else(|| get_str(p, "session_id"))
                    .map(String::from);
                version = get_str(p, "cli_version").map(String::from);
                forked_from_id = get_str(p, "forked_from_id").map(String::from);
                provider = get_str(p, "model_provider").map(String::from);
                if let Some(t) = get_str(p, "timestamp") {
                    created = Some(t.to_string());
                }
            }
        }
        if title.is_none() && get_str(&v, "type") == Some("response_item") {
            if let Some(p) = v.get("payload") {
                if get_str(p, "role") == Some("user") {
                    if let Some(t) = codex_message_text(p) {
                        let t = t.trim();
                        // 跳过注入的指令块和粘贴的导出历史，取第一条真实提问作标题
                        if !t.starts_with('<')
                            && !is_injected_context_message(t)
                            && !t.starts_with("The following is the ")
                        {
                            title = usable_title(t);
                        }
                    }
                }
            }
        }
    }
    // 小文件全在头部、tail 为空，此时从头部找最后一条 token_count
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let token_usage = tail_src.iter().rev().find_map(|line| {
        serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|v| codex_token_usage(&v))
    });
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some((
        SessionMetaDto {
            agent: "codex".into(),
            session_id,
            project_path: cwd.clone().unwrap_or_default(),
            cwd,
            title,
            created_at: created,
            updated_at: mtime_iso(path),
            file_path: path.to_string_lossy().into_owned(),
            token_usage,
            cli_version: version,
            pinned: false,
            archived,
            custom_title: None,
            tags: Vec::new(),
            alive,
            chain_count: 1,
            workspace: None,
            step_name: None,
            summary: None,
            live: alive && mtime_fresh(path, 60),
            source: default_session_source(),
            internal: false,
            handoff_from_agent: None,
            handoff_from_session: None,
            task_id: None,
            task_name: None,
            provider,
            profile_id: None,
        },
        forked_from_id,
    ))
}

fn parse_codex(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    let mut legacy = Vec::new();
    let mut has_response_message = false;
    let mut last_usage = None;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ts = get_str(&v, "timestamp").map(String::from);
        match get_str(&v, "type") {
            Some("response_item") => {
                let Some(p) = v.get("payload") else {
                    continue;
                };
                match get_str(p, "type") {
                    Some("message") => {
                        let role = get_str(p, "role").unwrap_or("");
                        if role != "user" && role != "assistant" {
                            continue; // developer/system 指令不进对话视图
                        }
                        if let Some(text) = codex_message_text(p) {
                            if role == "user" && is_injected_context_message(&text) {
                                continue;
                            }
                            has_response_message = true;
                            msgs.push(ChatMessageDto {
                                role: role.into(),
                                blocks: vec![text_block(text)],
                                timestamp: ts,
                                usage: None,
                            });
                        }
                    }
                    Some("function_call") | Some("custom_tool_call") => msgs.push(ChatMessageDto {
                        role: "assistant".into(),
                        blocks: vec![BlockDto {
                            kind: "tool_use".into(),
                            text: get_str(p, "arguments")
                                .or_else(|| get_str(p, "input"))
                                .unwrap_or("")
                                .to_string(),
                            tool_name: get_str(p, "name").map(String::from),
                        }],
                        timestamp: ts,
                        usage: None,
                    }),
                    Some("function_call_output") | Some("custom_tool_call_output") => {
                        let text = stringify_payload(p.get("output"));
                        push_tool_result(
                            &mut msgs,
                            vec![BlockDto {
                                kind: "tool_result".into(),
                                text,
                                tool_name: None,
                            }],
                            ts,
                        );
                    }
                    _ => {}
                }
            }
            Some("event_msg") => {
                let Some(p) = v.get("payload") else {
                    continue;
                };
                match get_str(p, "type") {
                    // 旧格式兜底：新文件里它与 response_item 重复，只在没有 response_item 消息时采用
                    Some("user_message") | Some("agent_message") => {
                        if let Some(t) = get_str(p, "message") {
                            if get_str(p, "type") == Some("user_message")
                                && is_injected_context_message(t)
                            {
                                continue;
                            }
                            let role = if get_str(p, "type") == Some("user_message") {
                                "user"
                            } else {
                                "assistant"
                            };
                            legacy.push(ChatMessageDto {
                                role: role.into(),
                                blocks: vec![text_block(t.to_string())],
                                timestamp: ts,
                                usage: None,
                            });
                        }
                    }
                    Some("token_count") => {
                        if let Some(u) = codex_token_usage(&v) {
                            last_usage = Some(u);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    let mut msgs = if has_response_message { msgs } else { legacy };
    // token_count 的总量挂在最后一条 assistant 消息上，代表整场用量
    if let Some(u) = last_usage {
        if let Some(m) = msgs.iter_mut().rev().find(|m| m.role == "assistant") {
            if m.usage.is_none() {
                m.usage = Some(u);
            }
        }
    }
    msgs
}

// ===== Gemini CLI =====

/// slug → 项目绝对路径映射。绝不自己推导 slug：
/// 优先 ~/.gemini/projects.json（{"projects": {"<abs path>": "<slug>"}}）反向，
/// 再以各 slug 目录里的 .project_root 标记文件兜底
fn gemini_slug_map(tmp_root: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some(cfg) = tmp_root.parent() {
        if let Ok(text) = fs::read_to_string(cfg.join("projects.json")) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(projects) = v.get("projects").and_then(|p| p.as_object()) {
                    for (path, slug) in projects {
                        if let Some(slug) = slug.as_str() {
                            map.insert(slug.to_string(), path.clone());
                        }
                    }
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(tmp_root) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let Some(slug) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            if map.contains_key(&slug) {
                continue;
            }
            if let Ok(root) = fs::read_to_string(p.join(".project_root")) {
                let root = root.trim().to_string();
                if !root.is_empty() {
                    map.insert(slug, root);
                }
            }
        }
    }
    map
}

/// content 可能是字符串或 parts 数组（[{text}]）
fn gemini_content_text(c: &Value) -> Option<String> {
    let text = match c {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|p| get_str(p, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn gemini_usage(t: &Value) -> TokenUsageDto {
    let num = |k: &str| t.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    TokenUsageDto {
        input: num("input"),
        output: num("output"),
        cache_read: num("cached"),
        cache_write: 0, // gemini 的 tokens 没有写缓存概念
    }
}

/// 列表标题候选：空白或 XML 标签开头（注入内容）的不算
fn title_from_text(text: &str) -> Option<String> {
    usable_title(text)
}

fn gemini_file_meta(
    path: &Path,
    alive: bool,
    slug_to_path: &HashMap<String, String>,
) -> Option<SessionMetaDto> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let (mut session_id, mut created, mut title, mut summary, mut directories) =
        (None, None, None, None, None);
    for line in head.iter().chain(&tail) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // $set 控制记录：补丁元数据，summary 可作标题（后出现覆盖先出现）
        if let Some(set) = v.get("$set") {
            if let Some(s) = get_str(set, "summary") {
                if let Some(candidate) = usable_title(s) {
                    summary = Some(candidate);
                }
            }
            continue;
        }
        // 首行 metadata（无 type 字段）
        if v.get("type").is_none() {
            if session_id.is_none() {
                session_id = get_str(&v, "sessionId").map(String::from);
            }
            if created.is_none() {
                created = get_str(&v, "startTime").map(String::from);
            }
            if directories.is_none() {
                directories = v
                    .get("directories")
                    .and_then(|d| d.as_array())
                    .and_then(|a| a.first())
                    .and_then(|x| x.as_str())
                    .map(String::from);
            }
            if summary.is_none() {
                summary = get_str(&v, "summary").and_then(usable_title);
            }
            continue;
        }
        if title.is_none() && get_str(&v, "type") == Some("user") {
            if let Some(t) = v.get("content").and_then(gemini_content_text) {
                title = title_from_text(&t);
            }
        }
    }
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let token_usage = tail_src.iter().rev().find_map(|line| {
        let v = serde_json::from_str::<Value>(line).ok()?;
        if get_str(&v, "type") == Some("gemini") {
            v.get("tokens").map(gemini_usage)
        } else {
            None
        }
    });
    // 项目归属：slug 映射 → metadata.directories。活会话都拿不到就跳过（不猜 slug）；
    // pin 快照允许占位，apply_meta 再用 session_meta.project_path 回填。
    let slug = path
        .parent()?
        .parent()?
        .file_name()?
        .to_string_lossy()
        .into_owned();
    let project_path = match slug_to_path.get(&slug).cloned().or(directories) {
        Some(p) => p,
        None if !alive => "已固定".into(),
        None => return None,
    };
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some(SessionMetaDto {
        agent: "gemini".into(),
        session_id,
        project_path: project_path.clone(),
        cwd: Some(project_path.clone()),
        title: summary.or(title),
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage,
        cli_version: None,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive,
        chain_count: 1,
        workspace: None,
        step_name: None,
        summary: None,
        live: alive && mtime_fresh(path, 60),
        source: default_session_source(),
        internal: false,
        handoff_from_agent: None,
        handoff_from_session: None,
        task_id: None,
        task_name: None,
        provider: None,
        profile_id: None,
    })
}

/// Gemini 偶尔会为同一个 sessionId 留下多个 chats/*.jsonl（例如重启/恢复时重写启动记录）。
/// 会话主键在 Mesa 中是 agent + session_id，因此列表只能保留最新落盘文件作为代表。
fn dedupe_gemini_sessions(metas: Vec<SessionMetaDto>) -> Vec<SessionMetaDto> {
    let mut latest: HashMap<String, SessionMetaDto> = HashMap::new();
    for meta in metas {
        let replace = latest.get(&meta.session_id).is_none_or(|current| {
            meta.updated_at > current.updated_at
                || (meta.updated_at == current.updated_at && meta.file_path > current.file_path)
        });
        if replace {
            latest.insert(meta.session_id.clone(), meta);
        }
    }
    latest.into_values().collect()
}

fn parse_gemini(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs: Vec<ChatMessageDto> = Vec::new();
    let mut ids: Vec<Option<String>> = Vec::new(); // 与 msgs 平行，供 $rewindTo 定位
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // $rewindTo 控制记录：删除该消息 id 起的全部消息
        if let Some(rewind) = get_str(&v, "$rewindTo") {
            if let Some(pos) = ids.iter().position(|id| id.as_deref() == Some(rewind)) {
                msgs.truncate(pos);
                ids.truncate(pos);
            }
            continue;
        }
        if v.get("$set").is_some() {
            continue;
        }
        let ts = get_str(&v, "timestamp").map(String::from);
        let id = get_str(&v, "id").map(String::from);
        match get_str(&v, "type") {
            Some("user") => {
                if let Some(text) = v.get("content").and_then(gemini_content_text) {
                    msgs.push(ChatMessageDto {
                        role: "user".into(),
                        blocks: vec![text_block(text)],
                        timestamp: ts,
                        usage: None,
                    });
                    ids.push(id);
                }
            }
            Some("gemini") => {
                let mut blocks = Vec::new();
                if let Some(text) = v.get("content").and_then(gemini_content_text) {
                    blocks.push(text_block(text));
                }
                if let Some(calls) = v.get("toolCalls").and_then(|t| t.as_array()) {
                    for c in calls {
                        blocks.push(BlockDto {
                            kind: "tool_use".into(),
                            text: c.get("args").map(|a| a.to_string()).unwrap_or_default(),
                            tool_name: get_str(c, "name").map(String::from),
                        });
                        if let Some(result) = c.get("result") {
                            blocks.push(BlockDto {
                                kind: "tool_result".into(),
                                text: stringify_payload(Some(result)),
                                tool_name: None,
                            });
                        }
                    }
                }
                if blocks.is_empty() {
                    continue;
                }
                msgs.push(ChatMessageDto {
                    role: "assistant".into(),
                    blocks,
                    timestamp: ts,
                    usage: v.get("tokens").map(gemini_usage),
                });
                ids.push(id);
            }
            _ => {} // metadata / info / error / warning 不进对话视图
        }
    }
    msgs
}

// ===== Qwen Code =====

fn qwen_usage(u: &Value) -> TokenUsageDto {
    let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    TokenUsageDto {
        input: num("promptTokenCount"),
        output: num("candidatesTokenCount"),
        cache_read: num("cachedContentTokenCount"),
        cache_write: 0,
    }
}

/// genai Content {role, parts[]} → 块列表；thought 部分映射为 thinking
fn qwen_parts_blocks(msg: &Value) -> Vec<BlockDto> {
    let mut blocks = Vec::new();
    let Some(parts) = msg.get("parts").and_then(|p| p.as_array()) else {
        return blocks;
    };
    for p in parts {
        if let Some(fc) = p.get("functionCall") {
            blocks.push(BlockDto {
                kind: "tool_use".into(),
                text: fc.get("args").map(|a| a.to_string()).unwrap_or_default(),
                tool_name: get_str(fc, "name").map(String::from),
            });
        } else if let Some(fr) = p.get("functionResponse") {
            let text = stringify_payload(fr.get("response"));
            blocks.push(BlockDto {
                kind: "tool_result".into(),
                text: if text.is_empty() {
                    fr.to_string()
                } else {
                    text
                },
                tool_name: None,
            });
        } else if let Some(t) = get_str(p, "text") {
            let kind = if p.get("thought").and_then(|x| x.as_bool()) == Some(true) {
                "thinking"
            } else {
                "text"
            };
            blocks.push(BlockDto {
                kind: kind.into(),
                text: t.to_string(),
                tool_name: None,
            });
        }
    }
    blocks
}

fn qwen_content_text(msg: &Value) -> Option<String> {
    let parts = msg.get("parts")?.as_array()?;
    let text = parts
        .iter()
        .filter(|p| p.get("thought").and_then(|x| x.as_bool()) != Some(true))
        .filter_map(|p| get_str(p, "text"))
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// qwen 运行时标记：会话目录里存在 <sessionId>.runtime.json sidecar 视为进行中
fn qwen_runtime_sidecar(path: &Path) -> Option<PathBuf> {
    let sid = path.file_stem()?.to_string_lossy();
    let candidate = path.parent()?.join(format!("{sid}.runtime.json"));
    candidate.exists().then_some(candidate)
}

fn qwen_file_meta(path: &Path, alive: bool, archived: bool) -> Option<SessionMetaDto> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let (mut cwd, mut created, mut session_id, mut version, mut title, mut custom_title) =
        (None, None, None, None, None, None);
    for line in head.iter().chain(&tail) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        if cwd.is_none() {
            cwd = get_str(&v, "cwd").map(String::from);
        }
        if created.is_none() {
            created = get_str(&v, "timestamp").map(String::from);
        }
        if session_id.is_none() {
            session_id = get_str(&v, "sessionId").map(String::from);
        }
        if version.is_none() {
            version = get_str(&v, "version").map(String::from);
        }
        // system 记录只关心 custom_title（目录名会碰撞，标题以它为准）
        if get_str(&v, "type") == Some("system") && get_str(&v, "subtype") == Some("custom_title") {
            if let Some(t) = v
                .get("systemPayload")
                .and_then(|p| get_str(p, "customTitle"))
            {
                if let Some(candidate) = usable_title(t) {
                    custom_title = Some(candidate);
                }
            }
        }
        if title.is_none() && get_str(&v, "type") == Some("user") {
            if let Some(t) = v.get("message").and_then(qwen_content_text) {
                title = title_from_text(&t);
            }
        }
    }
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let token_usage = tail_src.iter().rev().find_map(|line| {
        serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|v| v.get("usageMetadata").map(qwen_usage))
    });
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some(SessionMetaDto {
        agent: "qwen".into(),
        session_id,
        project_path: cwd.clone().unwrap_or_default(),
        cwd,
        title: custom_title.or(title),
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage,
        cli_version: version,
        pinned: false,
        archived,
        custom_title: None,
        tags: Vec::new(),
        alive,
        chain_count: 1,
        workspace: None,
        step_name: None,
        summary: None,
        live: alive && (mtime_fresh(path, 60) || qwen_runtime_sidecar(path).is_some()),
        source: default_session_source(),
        internal: false,
        handoff_from_agent: None,
        handoff_from_session: None,
        task_id: None,
        task_name: None,
        provider: None,
        profile_id: None,
    })
}

fn parse_qwen(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        let ts = get_str(&v, "timestamp").map(String::from);
        match get_str(&v, "type") {
            Some(role @ ("user" | "assistant")) => {
                let Some(msg) = v.get("message") else {
                    continue;
                };
                let blocks = qwen_parts_blocks(msg);
                if blocks.is_empty() {
                    continue;
                }
                msgs.push(ChatMessageDto {
                    role: role.into(),
                    blocks,
                    timestamp: ts,
                    usage: v.get("usageMetadata").map(qwen_usage),
                });
            }
            // 独立 tool_result 记录并入上一条 assistant（视觉跟随调用）
            Some("tool_result") => {
                let blocks: Vec<BlockDto> = v
                    .get("message")
                    .map(qwen_parts_blocks)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|b| b.kind == "tool_result")
                    .collect();
                if !blocks.is_empty() {
                    push_tool_result(&mut msgs, blocks, ts);
                }
            }
            _ => {} // system 等记录不进对话（custom_title 只用于列表标题）
        }
    }
    msgs
}

// ===== Kimi Code（新版 kimi-code + 旧版 kimi-cli，统一 agent id "kimi"） =====

/// wire/context 记录的时间是 epoch 毫秒（容忍字符串形式）
fn kimi_time(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => n.as_u64().map(|ms| iso_from_unix(ms / 1000)),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// content 可能是字符串或 parts 数组 [{type:"text",text},{type:"think",think}]
fn kimi_content_text(c: &Value) -> Option<String> {
    let text = match c {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter(|p| get_str(p, "type") != Some("think"))
            .filter_map(|p| get_str(p, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn kimi_content_blocks(c: &Value) -> Vec<BlockDto> {
    let mut blocks = Vec::new();
    match c {
        Value::String(s) => {
            if !s.trim().is_empty() {
                blocks.push(text_block(s.clone()));
            }
        }
        Value::Array(arr) => {
            for p in arr {
                match get_str(p, "type") {
                    Some("think") => {
                        if let Some(t) = get_str(p, "think") {
                            blocks.push(BlockDto {
                                kind: "thinking".into(),
                                text: t.to_string(),
                                tool_name: None,
                            });
                        }
                    }
                    _ => {
                        if let Some(t) = get_str(p, "text") {
                            blocks.push(text_block(t.to_string()));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    blocks
}

/// toolCalls/tool_calls（两个变体拼写不同）→ tool_use 块；arguments 是 JSON 字符串原样保留
fn kimi_tool_call_blocks(m: &Value) -> Vec<BlockDto> {
    let calls = m
        .get("toolCalls")
        .or_else(|| m.get("tool_calls"))
        .and_then(|t| t.as_array());
    let Some(calls) = calls else {
        return Vec::new();
    };
    calls
        .iter()
        .map(|c| {
            let f = c.get("function");
            BlockDto {
                kind: "tool_use".into(),
                text: f
                    .and_then(|f| get_str(f, "arguments"))
                    .unwrap_or("")
                    .to_string(),
                tool_name: f.and_then(|f| get_str(f, "name")).map(String::from),
            }
        })
        .collect()
}

fn kimi_usage(u: &Value) -> TokenUsageDto {
    let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    // inputOther 是非缓存输入；缓存读/写单列，与 Claude 口径一致
    TokenUsageDto {
        input: num("inputOther"),
        output: num("output"),
        cache_read: num("inputCacheRead"),
        cache_write: num("inputCacheCreation"),
    }
}

/// 新版 kimi-code：session_index.jsonl 给 (sessionId, sessionDir, workDir)，
/// 会话本体在 sessionDir/agents/main/wire.jsonl（agents/agent-* 是子 agent，不读）
fn kimi_wire_file_meta(
    path: &Path,
    alive: bool,
    session_id: &str,
    project_path: String,
    state: Option<&Value>,
) -> Option<SessionMetaDto> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let (mut created, mut title) = (None, None);
    for line in &head {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match get_str(&v, "type") {
            Some("metadata") => {
                if created.is_none() {
                    created = v.get("created_at").and_then(kimi_time);
                }
            }
            Some("turn.prompt") => {
                if title.is_none()
                    && v.get("origin").and_then(|o| get_str(o, "kind")) == Some("user")
                {
                    if let Some(t) = v.get("input").and_then(kimi_content_text) {
                        title = title_from_text(&t);
                    }
                }
            }
            _ => {}
        }
    }
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let token_usage = tail_src.iter().rev().find_map(|line| {
        let v = serde_json::from_str::<Value>(line).ok()?;
        if get_str(&v, "type") == Some("usage.record") {
            v.get("usage").map(kimi_usage)
        } else {
            None
        }
    });
    // 标题以 state.json 为准（CLI 自己维护，含 AI 起题），否则首条用户输入
    let state_title = state
        .and_then(|s| get_str(s, "title"))
        .and_then(usable_title);
    if created.is_none() {
        created = state.and_then(|s| s.get("createdAt")).and_then(kimi_time);
    }
    Some(SessionMetaDto {
        agent: "kimi".into(),
        session_id: session_id.to_string(),
        project_path: project_path.clone(),
        cwd: Some(project_path.clone()),
        title: state_title.or(title),
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage,
        cli_version: None,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive,
        chain_count: 1,
        workspace: None,
        step_name: None,
        summary: None,
        live: alive && mtime_fresh(path, 60),
        source: default_session_source(),
        internal: false,
        handoff_from_agent: None,
        handoff_from_session: None,
        task_id: None,
        task_name: None,
        provider: None,
        profile_id: None,
    })
}

fn parse_kimi(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs: Vec<ChatMessageDto> = Vec::new();
    let mut last_usage = None;
    let mut last_prompt: Option<String> = None; // 用于去掉 append_message 对 prompt 的回显
                                                // 新协议里 assistant 的输出走 append_loop_event 流式事件；cur 是当前 step 打开的 assistant 消息
    let mut cur: Option<usize> = None;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ts = v.get("time").and_then(kimi_time);
        match get_str(&v, "type") {
            Some("turn.prompt") => {
                cur = None;
                if v.get("origin").and_then(|o| get_str(o, "kind")) != Some("user") {
                    continue; // slash 命令等非用户来源不进对话
                }
                if let Some(text) = v.get("input").and_then(kimi_content_text) {
                    msgs.push(ChatMessageDto {
                        role: "user".into(),
                        blocks: vec![text_block(text.clone())],
                        timestamp: ts,
                        usage: None,
                    });
                    last_prompt = Some(text);
                }
            }
            Some("context.append_loop_event") => {
                let Some(e) = v.get("event") else {
                    continue;
                };
                match get_str(e, "type") {
                    // 一个 step = 一次 LLM 响应 = 一条 assistant 消息
                    Some("step.begin") => {
                        msgs.push(ChatMessageDto {
                            role: "assistant".into(),
                            blocks: Vec::new(),
                            timestamp: ts,
                            usage: None,
                        });
                        cur = Some(msgs.len() - 1);
                    }
                    Some("content.part") => {
                        let Some(i) = cur else { continue };
                        let Some(p) = e.get("part") else { continue };
                        match get_str(p, "type") {
                            Some("think") => {
                                if let Some(t) = get_str(p, "think") {
                                    msgs[i].blocks.push(BlockDto {
                                        kind: "thinking".into(),
                                        text: t.to_string(),
                                        tool_name: None,
                                    });
                                }
                            }
                            _ => {
                                if let Some(t) = get_str(p, "text") {
                                    msgs[i].blocks.push(text_block(t.to_string()));
                                }
                            }
                        }
                    }
                    // args 是对象（不同于 append_message 的 JSON 字符串）
                    Some("tool.call") => {
                        let Some(i) = cur else { continue };
                        msgs[i].blocks.push(BlockDto {
                            kind: "tool_use".into(),
                            text: e.get("args").map(|a| a.to_string()).unwrap_or_default(),
                            tool_name: get_str(e, "name").map(String::from),
                        });
                    }
                    Some("tool.result") => {
                        let r = e.get("result");
                        let text = {
                            let via_output = stringify_payload(r.and_then(|r| r.get("output")));
                            if via_output.is_empty() {
                                stringify_payload(r)
                            } else {
                                via_output
                            }
                        };
                        let block = BlockDto {
                            kind: "tool_result".into(),
                            text,
                            tool_name: None,
                        };
                        match cur {
                            Some(i) => msgs[i].blocks.push(block),
                            None => push_tool_result(&mut msgs, vec![block], ts),
                        }
                    }
                    Some("step.end") => {
                        if let Some(i) = cur.take() {
                            if let Some(u) = e.get("usage").map(kimi_usage) {
                                msgs[i].usage = Some(u);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Some("context.append_message") => {
                let Some(m) = v.get("message") else {
                    continue;
                };
                match get_str(m, "role") {
                    Some("user") => {
                        // 注入内容（system-reminder 等）跳过
                        let kind = m.get("origin").and_then(|o| get_str(o, "kind"));
                        if kind.is_some() && kind != Some("user") {
                            continue;
                        }
                        let Some(text) = m.get("content").and_then(kimi_content_text) else {
                            continue;
                        };
                        if last_prompt.take().as_deref() == Some(text.as_str()) {
                            continue; // turn.prompt 的回显，已发过
                        }
                        msgs.push(ChatMessageDto {
                            role: "user".into(),
                            blocks: vec![text_block(text)],
                            timestamp: ts,
                            usage: None,
                        });
                    }
                    Some("assistant") => {
                        let mut blocks =
                            kimi_content_blocks(m.get("content").unwrap_or(&Value::Null));
                        blocks.extend(kimi_tool_call_blocks(m));
                        if blocks.is_empty() {
                            continue;
                        }
                        msgs.push(ChatMessageDto {
                            role: "assistant".into(),
                            blocks,
                            timestamp: ts,
                            usage: None,
                        });
                    }
                    Some("tool") => {
                        let text = m
                            .get("content")
                            .and_then(kimi_content_text)
                            .unwrap_or_default();
                        push_tool_result(
                            &mut msgs,
                            vec![BlockDto {
                                kind: "tool_result".into(),
                                text,
                                tool_name: None,
                            }],
                            ts,
                        );
                    }
                    _ => {}
                }
            }
            Some("usage.record") => {
                if let Some(u) = v.get("usage").map(kimi_usage) {
                    last_usage = Some(u);
                }
            }
            _ => {}
        }
    }
    if let Some(u) = last_usage {
        if let Some(m) = msgs.iter_mut().rev().find(|m| m.role == "assistant") {
            if m.usage.is_none() {
                m.usage = Some(u);
            }
        }
    }
    // step.begin 后没有任何内容的空 assistant 消息（被中断的 step）不出现在视图里
    msgs.retain(|m| !m.blocks.is_empty() || m.usage.is_some());
    msgs
}

/// 旧版 kimi-cli：~/.kimi/sessions/<md5(workDir)>/<uuid>/context.jsonl，
/// bucket → 项目路径靠 kimi.json 的 work_dirs[].path 逐个 md5 反查
fn kimi_workdir_buckets(kimi_json: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(text) = fs::read_to_string(kimi_json) else {
        return map;
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return map;
    };
    if let Some(dirs) = v.get("work_dirs").and_then(|d| d.as_array()) {
        for d in dirs {
            if let Some(path) = get_str(d, "path") {
                let bucket = format!("{:x}", md5::compute(path.as_bytes()));
                map.insert(bucket, path.to_string());
            }
        }
    }
    map
}

fn kimi_legacy_file_meta(
    path: &Path,
    alive: bool,
    session_id: &str,
    project_path: String,
    state: Option<&Value>,
) -> Option<SessionMetaDto> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let mut title = None;
    for line in &head {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if get_str(&v, "role") == Some("user") {
            if let Some(t) = v.get("content").and_then(kimi_content_text) {
                title = title_from_text(&t);
                break;
            }
        }
    }
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let token_usage = tail_src.iter().rev().find_map(|line| {
        let v = serde_json::from_str::<Value>(line).ok()?;
        if get_str(&v, "role") == Some("_usage") {
            kimi_legacy_usage(&v)
        } else {
            None
        }
    });
    let state_title = state
        .and_then(|s| get_str(s, "title"))
        .and_then(usable_title);
    let created = state.and_then(|s| s.get("createdAt")).and_then(kimi_time);
    Some(SessionMetaDto {
        agent: "kimi".into(),
        session_id: session_id.to_string(),
        project_path: project_path.clone(),
        cwd: Some(project_path.clone()),
        title: state_title.or(title),
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage,
        cli_version: None,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive,
        chain_count: 1,
        workspace: None,
        step_name: None,
        summary: None,
        live: alive && mtime_fresh(path, 60),
        source: default_session_source(),
        internal: false,
        handoff_from_agent: None,
        handoff_from_session: None,
        task_id: None,
        task_name: None,
        provider: None,
        profile_id: None,
    })
}

/// 旧版 _usage 记录是累计 token 数；字段位置未核实，usage 对象或 content JSON 字符串都试
fn kimi_legacy_usage(v: &Value) -> Option<TokenUsageDto> {
    let u = v.get("usage").cloned().or_else(|| {
        v.get("content")
            .and_then(|c| c.as_str())
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
    })?;
    let num = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| u.get(*k).and_then(|x| x.as_u64()))
            .unwrap_or(0)
    };
    Some(TokenUsageDto {
        input: num(&["input_tokens", "prompt_tokens"]),
        output: num(&["output_tokens", "completion_tokens"]),
        cache_read: num(&["cached_tokens", "cache_read"]),
        cache_write: num(&["cache_write"]),
    })
}

fn parse_kimi_legacy(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    let mut last_usage = None;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let role = get_str(&v, "role").unwrap_or("");
        if role == "_usage" {
            if let Some(u) = kimi_legacy_usage(&v) {
                last_usage = Some(u);
            }
            continue;
        }
        if role.starts_with('_') {
            continue; // 内部记录不进对话
        }
        match role {
            "user" => {
                if let Some(text) = v.get("content").and_then(kimi_content_text) {
                    msgs.push(ChatMessageDto {
                        role: "user".into(),
                        blocks: vec![text_block(text)],
                        timestamp: None,
                        usage: None,
                    });
                }
            }
            "assistant" => {
                let mut blocks = kimi_content_blocks(v.get("content").unwrap_or(&Value::Null));
                blocks.extend(kimi_tool_call_blocks(&v));
                if blocks.is_empty() {
                    continue;
                }
                msgs.push(ChatMessageDto {
                    role: "assistant".into(),
                    blocks,
                    timestamp: None,
                    usage: None,
                });
            }
            "tool" => {
                let text = v
                    .get("content")
                    .and_then(kimi_content_text)
                    .unwrap_or_default();
                push_tool_result(
                    &mut msgs,
                    vec![BlockDto {
                        kind: "tool_result".into(),
                        text,
                        tool_name: None,
                    }],
                    None,
                );
            }
            _ => {}
        }
    }
    if let Some(u) = last_usage {
        if let Some(m) = msgs.iter_mut().rev().find(|m| m.role == "assistant") {
            if m.usage.is_none() {
                m.usage = Some(u);
            }
        }
    }
    msgs
}

/// 快照文件名丢失变体线索（wire.jsonl / context.jsonl 都变成 <id>.jsonl），
/// 按内容首行判别：新版 wire 记录带 type 字段，旧版 context 记录顶层是 role
fn kimi_looks_like_wire(lines: &[String]) -> bool {
    lines
        .iter()
        .find_map(|l| serde_json::from_str::<Value>(l).ok())
        .map_or(false, |v| v.get("type").is_some())
}

// ===== CodeBuddy Code（~/.codebuddy/projects/<slug>/<uuid>.jsonl，slug 规则同 Claude） =====
//
// 行 schema（v2.132.0 实测）：
//   {"type":"message","role":"user","content":[{"type":"input_text","text":...}],
//    "sessionId":"<uuid>","cwd":"<项目路径>","timestamp":<毫秒 epoch>}
//   assistant 行 content 块为 output_text；file-history-snapshot 等事件行跳过。
// 与 claude schema 不同构，独立解析器；防御式：未知 type/缺字段/末行截断一律跳过。

/// 时间戳是毫秒 epoch 数字（容错 ISO 字符串），统一转 ISO
fn codebuddy_time(v: &Value) -> Option<String> {
    match v.get("timestamp") {
        Some(Value::Number(n)) => n.as_u64().map(|ms| iso_from_unix(ms / 1000)),
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// content 数组里指定块类型的文本拼接（input_text / output_text）
fn codebuddy_content_text(v: &Value, block_type: &str) -> Option<String> {
    let arr = v.get("content")?.as_array()?;
    let text = arr
        .iter()
        .filter_map(|b| {
            if get_str(b, "type") == Some(block_type) {
                get_str(b, "text")
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn codebuddy_file_meta(path: &Path, alive: bool) -> Option<SessionMetaDto> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let (mut cwd, mut created, mut session_id, mut title) = (None, None, None, None);
    for line in head.iter().chain(&tail) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if cwd.is_none() {
            cwd = get_str(&v, "cwd").map(String::from);
        }
        if created.is_none() {
            created = codebuddy_time(&v);
        }
        if session_id.is_none() {
            session_id = get_str(&v, "sessionId").map(String::from);
        }
        if title.is_none()
            && get_str(&v, "type") == Some("message")
            && get_str(&v, "role") == Some("user")
        {
            title = codebuddy_content_text(&v, "input_text").and_then(|t| usable_title(&t));
        }
    }
    // 目录名是 sanitize 后的项目路径（有损），不解码；读不到 cwd 时原样兜底（同 Claude 规则）
    let project_path = cwd.clone().unwrap_or_else(|| {
        path.parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some(SessionMetaDto {
        agent: "codebuddy".into(),
        session_id,
        project_path: project_path.clone(),
        cwd: cwd.clone(),
        title,
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage: None,
        cli_version: None,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive,
        chain_count: 1,
        workspace: None,
        step_name: None,
        summary: None,
        live: alive && mtime_fresh(path, 60),
        source: default_session_source(),
        internal: false,
        handoff_from_agent: None,
        handoff_from_session: None,
        task_id: None,
        task_name: None,
        provider: None,
        profile_id: None,
    })
}

fn parse_codebuddy(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue; // 末行截断等坏行直接跳过
        };
        if get_str(&v, "type") != Some("message") {
            continue; // file-history-snapshot 等事件行
        }
        let ts = codebuddy_time(&v);
        match get_str(&v, "role") {
            Some("user") => {
                let Some(text) = codebuddy_content_text(&v, "input_text") else {
                    continue;
                };
                msgs.push(ChatMessageDto {
                    role: "user".into(),
                    blocks: vec![text_block(text)],
                    timestamp: ts,
                    usage: None,
                });
            }
            Some("assistant") => {
                let Some(text) = codebuddy_content_text(&v, "output_text") else {
                    continue;
                };
                msgs.push(ChatMessageDto {
                    role: "assistant".into(),
                    blocks: vec![text_block(text)],
                    timestamp: ts,
                    usage: None,
                });
            }
            _ => {}
        }
    }
    msgs
}

// ===== Cursor CLI（~/.cursor/projects/<编码cwd>/agent-transcripts/<uuid>/<uuid>.jsonl） =====
//
// 目录名=文件名=session id；<编码cwd> 把路径分隔符替换成 '-'（有损，不解码，同 Claude slug 规则）。
// JSONL 每行带 type 字段，源码枚举（2026.08.04-aaa8809 调研）：
//   user_message / tool_call / tool_result / turn_ended / turn_id / message_id 等。
// 完整字段样本未验证——防御式解析：未知 type 跳过，文本/时间戳按多个候选字段名提取，
// 缺字段/末行截断一律容忍。会话发现只能文件扫描（agent ls 是 Ink TUI，非 TTY 会崩）。

/// 文本提取：字符串直取；数组拼接各块文本；对象取 text 字段。
/// 候选层级 message.content / content / text 依次尝试（字段名未实证，多候选兜底）
fn cursor_text_of(x: &Value) -> Option<String> {
    match x {
        Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
        Value::Array(arr) => {
            let text = arr
                .iter()
                .filter_map(cursor_text_of)
                .collect::<Vec<_>>()
                .join("\n");
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
        Value::Object(_) => x
            .get("text")
            .and_then(cursor_text_of)
            .or_else(|| x.get("content").and_then(cursor_text_of)),
        _ => None,
    }
}

fn cursor_text(v: &Value) -> Option<String> {
    v.get("message")
        .and_then(cursor_text_of)
        .or_else(|| v.get("content").and_then(cursor_text_of))
        .or_else(|| v.get("text").and_then(cursor_text_of))
}

/// 时间戳候选字段名未实证，逐个尝试；数字按量级区分毫秒/秒 epoch，字符串当 ISO 原样透传
fn cursor_time(v: &Value) -> Option<String> {
    for key in ["timestamp", "time", "created_at", "createdAt", "ts"] {
        match v.get(key) {
            Some(Value::Number(n)) => {
                let raw = n.as_i64()?;
                let secs = if raw.abs() >= 1_000_000_000_000 {
                    raw / 1000
                } else {
                    raw
                };
                return u64::try_from(secs).ok().map(iso_from_unix);
            }
            Some(Value::String(s)) => return Some(s.clone()),
            _ => continue,
        }
    }
    None
}

fn cursor_file_meta(path: &Path, alive: bool) -> Option<SessionMetaDto> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let (mut cwd, mut created, mut session_id, mut title) = (None, None, None, None);
    for line in head.iter().chain(&tail) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if cwd.is_none() {
            // cwd 字段名未实证，多候选兜底；没有就靠目录名（有损）兜底
            cwd = ["cwd", "project_path", "workingDirectory"]
                .iter()
                .find_map(|k| get_str(&v, k))
                .map(String::from);
        }
        if created.is_none() {
            created = cursor_time(&v);
        }
        if session_id.is_none() {
            // 候选只收明确的会话 id 字段名；泛化的 "id" 会误中 turn_id/message_id 事件行
            session_id = ["session_id", "sessionId"]
                .iter()
                .find_map(|k| get_str(&v, k))
                .map(String::from);
        }
        if title.is_none() && get_str(&v, "type") == Some("user_message") {
            title = cursor_text(&v).and_then(|t| usable_title(&t));
        }
    }
    // 目录名是编码后的项目路径（分隔符→'-'，有损不解码）；读不到 cwd 时原样兜底（同 Claude 规则）。
    // 结构 projects/<编码cwd>/agent-transcripts/<uuid>/<uuid>.jsonl：上三级才是编码目录名
    let project_path = cwd.clone().unwrap_or_else(|| {
        path.parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some(SessionMetaDto {
        agent: "cursor".into(),
        session_id,
        project_path: project_path.clone(),
        cwd: cwd.clone(),
        title,
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage: None,
        cli_version: None,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive,
        chain_count: 1,
        workspace: None,
        step_name: None,
        summary: None,
        live: alive && mtime_fresh(path, 60),
        source: default_session_source(),
        internal: false,
        handoff_from_agent: None,
        handoff_from_session: None,
        task_id: None,
        task_name: None,
        provider: None,
        profile_id: None,
    })
}

fn parse_cursor(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue; // 末行截断等坏行直接跳过
        };
        let ts = cursor_time(&v);
        match get_str(&v, "type") {
            Some("user_message") => {
                let Some(text) = cursor_text(&v) else {
                    continue;
                };
                msgs.push(ChatMessageDto {
                    role: "user".into(),
                    blocks: vec![text_block(text)],
                    timestamp: ts,
                    usage: None,
                });
            }
            // 助手正文是否带独立 type 未实证，多候选；tool_call 等事件行不渲染成消息
            Some("assistant_message") => {
                let Some(text) = cursor_text(&v) else {
                    continue;
                };
                msgs.push(ChatMessageDto {
                    role: "assistant".into(),
                    blocks: vec![text_block(text)],
                    timestamp: ts,
                    usage: None,
                });
            }
            _ => {} // tool_call/tool_result/turn_ended/turn_id/message_id 及未知 type 跳过
        }
    }
    msgs
}

// ===== Grok Build（~/.grok/sessions/<encoded-cwd>/<session-id>/，xai-org/grok-build 源码调研 2026-08） =====
//
// 目录式会话：每会话一个 <session-id-uuidv7>/ 目录，内含
//   summary.json   —— info{id,cwd}、generated_title、parent_session_id（compact/继续的父会话）、created_at/updated_at
//   updates.jsonl  —— 权威对话日志（append-only），本解析器的消费对象
//   chat_history.jsonl 等（原始请求消息，不解析）
// updates.jsonl 每行：{"timestamp": <unix秒>, "method": "session/update", "params": <ACP SessionNotification>}；
// 消费方式 = params.update.sessionUpdate：user_message_chunk / agent_message_chunk
//（content 为 ACP ContentBlock，text 在 content.text）/ tool_call / tool_call_update / plan 等，
// 另有 _x.ai/ 前缀扩展通知。~/.grok/sessions/session_search.sqlite 只是 FTS 索引，不是会话本体。
// 防御式：未知 sessionUpdate 类型/缺字段/末行截断一律跳过。

/// ACP ContentBlock 提取文本（text 在 content.text；容错 content 为字符串直取）
fn grok_content_text(update: &Value) -> Option<String> {
    let content = update.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Object(_) => get_str(content, "text")?.to_string(),
        _ => return None,
    };
    let text = unwrap_prompt_tags(&text);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// 行时间戳：unix 秒数字转 ISO（容错字符串原样透传）
fn grok_time(v: &Value) -> Option<String> {
    match v.get("timestamp") {
        Some(Value::Number(n)) => n.as_u64().map(iso_from_unix),
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// 会话目录路径：.../sessions/<encoded-cwd>/<session-id>/<file>
/// 回退两级取 encoded-cwd 目录名（有损不解码）；summary.json 的 info.cwd 优先
fn grok_session_dir(path: &Path) -> Option<&Path> {
    path.parent()
}

/// 从同目录 summary.json 读元信息（缺文件/缺字段容错回落）
fn grok_summary(path: &Path) -> Option<Value> {
    let dir = grok_session_dir(path)?;
    read_json_file(&dir.join("summary.json"))
}

fn grok_file_meta(path: &Path, alive: bool) -> Option<(SessionMetaDto, Option<String>)> {
    // 会话文件本体是 updates.jsonl；meta 优先 summary.json，回落 updates.jsonl 行内提取
    let summary = grok_summary(path);
    let info = summary.as_ref().and_then(|s| s.get("info"));
    let parent = summary
        .as_ref()
        .and_then(|s| get_str(s, "parent_session_id"))
        .map(String::from);
    let (mut created, mut updated, mut title) = (None, None, None);
    let cwd = info.and_then(|i| get_str(i, "cwd")).map(String::from);
    let session_id = info.and_then(|i| get_str(i, "id")).map(String::from);
    if let Some(s) = &summary {
        created = grok_time_field(s, "created_at").or_else(|| grok_time(s));
        updated = grok_time_field(s, "updated_at");
        title = get_str(s, "generated_title").and_then(usable_title);
    }
    // summary.json 读不到时从 updates.jsonl 行内补（head 提首条用户消息做标题，尾行时间戳做 updated）
    if created.is_none() || title.is_none() || cwd.is_none() {
        if let Some((head, tail)) = read_head_tail(path, 64 * 1024) {
            for line in head.iter().chain(&tail) {
                let Ok(v) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                if created.is_none() {
                    created = grok_time(&v);
                }
                if updated.is_none() {
                    updated = grok_time(&v);
                }
                if title.is_none() {
                    if let Some(update) = v.get("params").and_then(|p| p.get("update")) {
                        if get_str(update, "sessionUpdate") == Some("user_message_chunk") {
                            title = grok_content_text(update).and_then(|t| usable_title(&t));
                        }
                    }
                }
            }
        }
    }
    let project_path = cwd.clone().unwrap_or_else(|| {
        // 目录名是 URL 编码的 cwd（超长则 slug+hash），不解码；读不到 info.cwd 时原样兜底（同 Claude 规则）
        grok_session_dir(path)
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let session_id = session_id
        .or_else(|| {
            grok_session_dir(path)
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
        })
        .unwrap_or_default();
    Some((
        SessionMetaDto {
            agent: "grok".into(),
            session_id,
            project_path: project_path.clone(),
            cwd: cwd.clone(),
            title,
            created_at: created,
            updated_at: updated.or_else(|| mtime_iso(path)),
            file_path: path.to_string_lossy().into_owned(),
            token_usage: None,
            cli_version: None,
            pinned: false,
            archived: false,
            custom_title: None,
            tags: Vec::new(),
            alive,
            chain_count: 1,
            workspace: None,
            step_name: None,
            summary: None,
            live: alive && mtime_fresh(path, 60),
            source: default_session_source(),
            internal: false,
            handoff_from_agent: None,
            handoff_from_session: None,
            task_id: None,
            task_name: None,
            provider: None,
            profile_id: None,
        },
        parent,
    ))
}

/// summary.json 的 updated_at 字段（created_at 走 grok_time 复用 timestamp 键——summary 顶层
/// 是 created_at/updated_at 不是 timestamp，分开取）
fn grok_time_field(v: &Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_u64().map(iso_from_unix),
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

fn parse_grok(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs: Vec<ChatMessageDto> = Vec::new();
    // 流式 chunk 聚合（2026-08-24）：grok 一条消息是多个连续 chunk，逐 chunk 独立成条会把
    // 一句话刷成一屏碎片——连续同角色 chunk 追加进上一条消息；tool_call/tool_call_update
    // 打断连续性（其后的 chunk 是工具回合后的新一轮输出）；plan/未知类型跳过且不打断
    let mut break_run = true;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue; // 末行截断等坏行直接跳过
        };
        let Some(update) = v.get("params").and_then(|p| p.get("update")) else {
            continue;
        };
        let ts = grok_time(&v);
        match get_str(update, "sessionUpdate") {
            Some(kind @ ("user_message_chunk" | "agent_message_chunk")) => {
                let Some(text) = grok_content_text(update) else {
                    continue;
                };
                let role = if kind == "user_message_chunk" {
                    "user"
                } else {
                    "assistant"
                };
                if !break_run && msgs.last().is_some_and(|m| m.role == role) {
                    let m = msgs.last_mut().unwrap();
                    if let Some(b) = m.blocks.first_mut() {
                        b.text.push_str(&text);
                    }
                } else {
                    msgs.push(ChatMessageDto {
                        role: role.into(),
                        blocks: vec![text_block(text)],
                        timestamp: ts,
                        usage: None,
                    });
                }
                break_run = false;
            }
            Some("tool_call" | "tool_call_update") => break_run = true,
            // plan 及未知 sessionUpdate 类型（含 _x.ai/ 扩展）跳过且不打断流式连续性
            _ => {}
        }
    }
    msgs
}

/// Grok 的 `updates.jsonl` 是 UI 事件流；完整历史在同目录的
/// `chat_history.jsonl`。优先读取后者，避免 compact 后旧回合不在事件流窗口中。
fn grok_history_path(updates_path: &Path) -> Option<PathBuf> {
    Some(updates_path.parent()?.join("chat_history.jsonl"))
}

fn grok_history_text(content: &Value) -> Option<String> {
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                if let Value::String(s) = item {
                    return Some(s.clone());
                }
                let obj = item.as_object()?;
                (obj.get("type").and_then(Value::as_str) == Some("text")).then(|| {
                    obj.get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                })
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    let text = unwrap_prompt_tags(&text);
    (!text.is_empty()).then_some(text)
}

fn parse_grok_history(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut messages = Vec::new();
    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let role = get_str(&value, "type");
        let is_user_prompt = role == Some("user")
            && value.get("prompt_index").is_some()
            && value.get("synthetic_reason").is_none();
        let is_assistant = role == Some("assistant");
        if !is_user_prompt && !is_assistant {
            continue;
        }
        let Some(text) = grok_history_text(value.get("content").unwrap_or(&Value::Null)) else {
            continue;
        };
        messages.push(ChatMessageDto {
            role: if is_user_prompt { "user" } else { "assistant" }.into(),
            blocks: vec![text_block(text)],
            timestamp: None,
            usage: None,
        });
    }
    messages
}

fn grok_history_messages(path: &Path) -> Option<Vec<ChatMessageDto>> {
    let history = grok_history_path(path)?;
    let bytes = read_session_bytes(&history)?;
    Some(parse_grok_history(&to_lines(&String::from_utf8_lossy(
        &bytes,
    ))))
}

/// grok 尾部状态：从后往前找最近的已知事件。
/// user_message_chunk = 用户刚发消息（回合进行中）→ working；
/// agent_message_chunk = 助手输出 → 文本问句收尾判 confirm，否则 done；
/// tool_call/tool_call_update = 工具回合进行中 → working。
fn grok_tail_state(lines: &[String]) -> &'static str {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(update) = v.get("params").and_then(|p| p.get("update")) else {
            continue;
        };
        match get_str(update, "sessionUpdate") {
            Some("user_message_chunk") => return "working",
            Some("agent_message_chunk") => {
                let text = grok_content_text(update).unwrap_or_default();
                return if ends_with_question(&text) {
                    "confirm"
                } else {
                    "done"
                };
            }
            Some("tool_call") | Some("tool_call_update") => return "working",
            _ => continue,
        }
    }
    "unknown"
}

/// OpenCode 数据目录候选：OPENCODE_DB 优先；Windows 再探 %LOCALAPPDATA%\opencode
/// 与 %APPDATA%\opencode；最后回落 unix 形态 ~/.local/share/opencode。
fn opencode_db_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var("OPENCODE_DB") {
        if !p.is_empty() {
            out.push(PathBuf::from(p));
        }
    }
    #[cfg(windows)]
    {
        if let Some(local) = dirs::data_local_dir() {
            out.push(local.join("opencode").join("opencode.db"));
        }
        if let Some(roaming) = dirs::data_dir() {
            out.push(roaming.join("opencode").join("opencode.db"));
        }
    }
    if let Some(h) = dirs::home_dir() {
        out.push(
            h.join(".local")
                .join("share")
                .join("opencode")
                .join("opencode.db"),
        );
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(crate::paths::path_key(&p.to_string_lossy())));
    out
}

#[cfg(test)]
fn opencode_db_path() -> Option<PathBuf> {
    let cands = opencode_db_candidates();
    cands
        .iter()
        .find(|p| p.exists())
        .cloned()
        .or_else(|| cands.into_iter().next())
}

fn is_known_opencode_db(path: &Path) -> bool {
    let got = crate::paths::path_key(&path.to_string_lossy());
    let got_canon = path
        .canonicalize()
        .ok()
        .map(|p| crate::paths::path_key(&p.to_string_lossy()));
    opencode_db_candidates().iter().any(|c| {
        let k = crate::paths::path_key(&c.to_string_lossy());
        if k == got {
            return true;
        }
        let c_canon = c
            .canonicalize()
            .ok()
            .map(|p| crate::paths::path_key(&p.to_string_lossy()));
        matches!((got_canon.as_ref(), c_canon.as_ref()), (Some(a), Some(b)) if a == b)
    })
}

/// WAL 模式只读打开 + busy_timeout；库不存在/打不开都返回 None（扫描时跳过）
pub(crate) fn open_opencode_db(path: &Path) -> Option<Connection> {
    if !path.exists() {
        return None;
    }
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(3));
    Some(conn)
}

// drizzle 迁移频繁，列级防御：SELECT * 后按列名取值，缺列给默认值而不是报错
pub(crate) fn query_rows(
    conn: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Vec<(Vec<String>, Vec<rusqlite::types::Value>)> {
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let Ok(rows) = stmt.query(params) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut rows = rows;
    while let Ok(Some(row)) = rows.next() {
        let mut vals = Vec::new();
        for i in 0..names.len() {
            vals.push(
                row.get::<_, rusqlite::types::Value>(i)
                    .unwrap_or(rusqlite::types::Value::Null),
            );
        }
        out.push((names.clone(), vals));
    }
    out
}

// 行 -> 按名取值的小包装，复用 col_string/col_i64 的防御逻辑
pub(crate) struct DbRow {
    pub names: Vec<String>,
    pub vals: Vec<rusqlite::types::Value>,
}

impl DbRow {
    pub(crate) fn as_str(&self, key: &str) -> Option<String> {
        self.names
            .iter()
            .position(|n| n == key)
            .and_then(|i| match &self.vals[i] {
                rusqlite::types::Value::Text(s) => Some(s.clone()),
                rusqlite::types::Value::Integer(n) => Some(n.to_string()),
                _ => None,
            })
    }

    pub(crate) fn as_i64(&self, key: &str) -> Option<i64> {
        self.names
            .iter()
            .position(|n| n == key)
            .and_then(|i| match &self.vals[i] {
                rusqlite::types::Value::Integer(n) => Some(*n),
                rusqlite::types::Value::Real(f) => Some(*f as i64),
                _ => None,
            })
    }
}

fn opencode_ms_to_iso(ms: i64) -> String {
    iso_from_unix(if ms >= 0 { (ms / 1000) as u64 } else { 0 })
}

fn opencode_usage(
    input: i64,
    output: i64,
    reasoning: i64,
    cache_read: i64,
    cache_write: i64,
) -> TokenUsageDto {
    TokenUsageDto {
        input: input as u64,
        // reasoning 计入输出侧，与 Codex 口径一致
        output: (output + reasoning) as u64,
        cache_read: cache_read as u64,
        cache_write: cache_write as u64,
    }
}

fn opencode_scan_db(db_path: &Path) -> Vec<SessionMetaDto> {
    let Some(conn) = open_opencode_db(db_path) else {
        return Vec::new();
    };
    // project_id → worktree（"global" 项目没有 worktree，回落 session.directory）
    let mut worktrees: HashMap<String, String> = HashMap::new();
    for row in query_rows(&conn, "SELECT * FROM project", &[]) {
        let row = DbRow {
            names: row.0,
            vals: row.1,
        };
        if let (Some(id), Some(wt)) = (row.as_str("id"), row.as_str("worktree")) {
            worktrees.insert(id, wt);
        }
    }
    let mut out = Vec::new();
    for row in query_rows(&conn, "SELECT * FROM session", &[]) {
        let row = DbRow {
            names: row.0,
            vals: row.1,
        };
        let Some(id) = row.as_str("id") else {
            continue;
        };
        let project_id = row.as_str("project_id").unwrap_or_default();
        let directory = row.as_str("directory").unwrap_or_default();
        let project_path = if project_id.is_empty() || project_id == "global" {
            directory
        } else {
            worktrees.get(&project_id).cloned().unwrap_or(directory)
        };
        let t = |k: &str| row.as_i64(k).unwrap_or(0);
        let token_usage = if t("tokens_input") + t("tokens_output") + t("tokens_reasoning") > 0 {
            Some(opencode_usage(
                t("tokens_input"),
                t("tokens_output"),
                t("tokens_reasoning"),
                t("tokens_cache_read"),
                t("tokens_cache_write"),
            ))
        } else {
            None
        };
        // opencode 没有单会话文件：用行的 time_updated 判活（60 秒内被写过即在跑）
        let live = row
            .as_i64("time_updated")
            .map(|ms| {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                (now_ms - ms).abs() <= 60_000
            })
            .unwrap_or(false);
        out.push(SessionMetaDto {
            agent: "opencode".into(),
            session_id: id.clone(),
            project_path: project_path.clone(),
            cwd: Some(project_path.clone()),
            title: row.as_str("title").and_then(|t| usable_title(&t)),
            created_at: row.as_i64("time_created").map(opencode_ms_to_iso),
            updated_at: row.as_i64("time_updated").map(opencode_ms_to_iso),
            // 没有单会话文件：db 路径 + "#" + session_id，pin/回放据此定位
            file_path: format!("{}#{}", db_path.display(), id),
            token_usage,
            cli_version: row.as_str("version"),
            pinned: false,
            archived: false,
            custom_title: None,
            tags: Vec::new(),
            alive: true, // 行在即在
            chain_count: 1,
            workspace: None,
            step_name: None,
            summary: None,
            live,
            source: default_session_source(),
            internal: false,
            handoff_from_agent: None,
            handoff_from_session: None,
            task_id: None,
            task_name: None,
            provider: None,
            profile_id: None,
        });
    }
    // OpenCode 新会话常暂存为 "New Session"：只对占位标题的会话惰性补标题——
    // 按 session_id 限量查最早的消息，不再全表扫 message 逐行解析 JSON。
    // LIMIT 是防御兜底：首条真实用户消息通常就是最前面几条之一
    for m in out.iter_mut().filter(|m| m.title.is_none()) {
        let sid = m.session_id.clone();
        for row in query_rows(
            &conn,
            "SELECT * FROM message WHERE session_id=? ORDER BY time_created ASC LIMIT 20",
            &[&sid],
        ) {
            let row = DbRow {
                names: row.0,
                vals: row.1,
            };
            let Some(data) = row.as_str("data") else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&data) else {
                continue;
            };
            if get_str(&value, "role") != Some("user") {
                continue;
            }
            if let Some(text) = opencode_user_text(&value, &[]) {
                if let Some(title) = usable_title(&text) {
                    m.title = Some(title);
                    break;
                }
            }
        }
    }
    out
}

/// part.data → 块：text / reasoning→thinking / tool→tool_use(+tool_result)；
/// step-start/finish、file、snapshot、agent、retry、subtask、compaction 等一律跳过
fn opencode_part_blocks(data: &Value) -> Vec<BlockDto> {
    let mut blocks = Vec::new();
    match get_str(data, "type") {
        Some("text") => {
            if let Some(t) = get_str(data, "text") {
                if !t.trim().is_empty() {
                    blocks.push(text_block(t.to_string()));
                }
            }
        }
        Some("reasoning") => {
            if let Some(t) = get_str(data, "text") {
                if !t.trim().is_empty() {
                    blocks.push(BlockDto {
                        kind: "thinking".into(),
                        text: t.to_string(),
                        tool_name: None,
                    });
                }
            }
        }
        Some("tool") => {
            let state = data.get("state");
            let input = state.and_then(|s| s.get("input"));
            blocks.push(BlockDto {
                kind: "tool_use".into(),
                text: input.map(|i| i.to_string()).unwrap_or_default(),
                tool_name: get_str(data, "tool").map(String::from),
            });
            // 完成给 output、失败给 error；进行中的调用只有 tool_use
            let result = state
                .and_then(|s| s.get("output"))
                .map(|v| stringify_payload(Some(v)));
            let error = state
                .and_then(|s| s.get("error"))
                .map(|v| stringify_payload(Some(v)));
            let text = match (result, error) {
                (Some(o), _) if !o.is_empty() => o,
                (_, Some(e)) if !e.is_empty() => e,
                _ => String::new(),
            };
            if !text.is_empty() {
                blocks.push(BlockDto {
                    kind: "tool_result".into(),
                    text,
                    tool_name: None,
                });
            }
        }
        _ => {}
    }
    blocks
}

/// 用户消息文本：summary.body（或字符串 summary）→ parts 里的 text
fn opencode_user_text(data: &Value, parts: &[&Value]) -> Option<String> {
    let summary = data.get("summary");
    let from_summary = summary
        .and_then(|s| get_str(s, "body").or_else(|| s.as_str()))
        .filter(|t| !t.trim().is_empty())
        .map(String::from);
    from_summary.or_else(|| {
        let text = parts
            .iter()
            .filter_map(|p| {
                if get_str(p, "type") == Some("text") {
                    get_str(p, "text")
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        if text.trim().is_empty() {
            None
        } else {
            Some(text)
        }
    })
}

/// message.data + 其 parts → ChatMessageDto；非 user/assistant 返回 None
fn opencode_message(
    data: &Value,
    parts: Vec<&Value>,
    ts_ms: Option<i64>,
) -> Option<ChatMessageDto> {
    let ts = ts_ms
        .or_else(|| {
            data.get("time")
                .and_then(|t| t.get("created"))
                .and_then(|t| t.as_i64())
        })
        .map(opencode_ms_to_iso);
    match get_str(data, "role") {
        Some("user") => {
            let text = opencode_user_text(data, &parts)?;
            Some(ChatMessageDto {
                role: "user".into(),
                blocks: vec![text_block(text)],
                timestamp: ts,
                usage: None,
            })
        }
        Some("assistant") => {
            let mut blocks = Vec::new();
            for p in parts {
                blocks.extend(opencode_part_blocks(p));
            }
            if blocks.is_empty() {
                return None;
            }
            let usage = data.get("tokens").map(|t| {
                let num = |k: &str| t.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
                let cache = t.get("cache");
                let cnum = |k: &str| {
                    cache
                        .and_then(|c| c.get(k))
                        .and_then(|x| x.as_i64())
                        .unwrap_or(0)
                };
                opencode_usage(
                    num("input"),
                    num("output"),
                    num("reasoning"),
                    cnum("read"),
                    cnum("write"),
                )
            });
            Some(ChatMessageDto {
                role: "assistant".into(),
                blocks,
                timestamp: ts,
                usage,
            })
        }
        _ => None,
    }
}

fn opencode_parse_db(db_path: &Path, session_id: &str) -> Vec<ChatMessageDto> {
    let Some(conn) = open_opencode_db(db_path) else {
        return Vec::new();
    };
    let sid = session_id.to_string();
    // parts 按 message_id 分组（part 表带 session_id 列，按时间序）
    let mut parts_by_msg: HashMap<String, Vec<Value>> = HashMap::new();
    for row in query_rows(
        &conn,
        "SELECT * FROM part WHERE session_id=? ORDER BY time_created ASC",
        &[&sid],
    ) {
        let row = DbRow {
            names: row.0,
            vals: row.1,
        };
        let (Some(msg_id), Some(data)) = (row.as_str("message_id"), row.as_str("data")) else {
            continue;
        };
        if let Ok(v) = serde_json::from_str::<Value>(&data) {
            parts_by_msg.entry(msg_id).or_default().push(v);
        }
    }
    let mut msgs = Vec::new();
    for row in query_rows(
        &conn,
        "SELECT * FROM message WHERE session_id=? ORDER BY time_created ASC",
        &[&sid],
    ) {
        let row = DbRow {
            names: row.0,
            vals: row.1,
        };
        let Some(data) = row.as_str("data") else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        let parts = row
            .as_str("id")
            .and_then(|id| parts_by_msg.remove(&id))
            .unwrap_or_default();
        let ts = row.as_i64("time_created");
        if let Some(m) = opencode_message(&v, parts.iter().collect(), ts) {
            msgs.push(m);
        }
    }
    msgs
}

/// pin 导出：{session:{列...}, messages:[{id,time_created,data}], parts:[{message_id,data}]}
///（自包含且保留 id 关联，回放不依赖原库）
fn opencode_export_session(db_path: &Path, session_id: &str) -> Result<Value, String> {
    let conn = open_opencode_db(db_path).ok_or("OpenCode 数据库不可读")?;
    let sid = session_id.to_string();
    let mut session_json = serde_json::json!({ "id": sid });
    // id 是主键，最多一行；查不到时保留只含 id 的兜底对象
    if let Some(row) = query_rows(&conn, "SELECT * FROM session WHERE id=?", &[&sid])
        .into_iter()
        .next()
    {
        let row = DbRow {
            names: row.0,
            vals: row.1,
        };
        let mut obj = serde_json::Map::new();
        for (i, name) in row.names.iter().enumerate() {
            let v = match &row.vals[i] {
                rusqlite::types::Value::Null => Value::Null,
                rusqlite::types::Value::Integer(n) => serde_json::json!(n),
                rusqlite::types::Value::Real(f) => serde_json::json!(f),
                rusqlite::types::Value::Text(s) => serde_json::json!(s),
                rusqlite::types::Value::Blob(_) => continue,
            };
            obj.insert(name.clone(), v);
        }
        session_json = Value::Object(obj);
    }
    let messages: Vec<Value> = query_rows(
        &conn,
        "SELECT * FROM message WHERE session_id=? ORDER BY time_created ASC",
        &[&sid],
    )
    .into_iter()
    .filter_map(|r| {
        let row = DbRow {
            names: r.0,
            vals: r.1,
        };
        let data = row
            .as_str("data")
            .and_then(|d| serde_json::from_str::<Value>(&d).ok())?;
        Some(serde_json::json!({
            "id": row.as_str("id"),
            "time_created": row.as_i64("time_created"),
            "data": data,
        }))
    })
    .collect();
    let parts: Vec<Value> = query_rows(
        &conn,
        "SELECT * FROM part WHERE session_id=? ORDER BY time_created ASC",
        &[&sid],
    )
    .into_iter()
    .filter_map(|r| {
        let row = DbRow {
            names: r.0,
            vals: r.1,
        };
        let data = row
            .as_str("data")
            .and_then(|d| serde_json::from_str::<Value>(&d).ok())?;
        Some(serde_json::json!({
            "message_id": row.as_str("message_id"),
            "data": data,
        }))
    })
    .collect();
    Ok(serde_json::json!({
        "session": session_json,
        "messages": messages,
        "parts": parts,
    }))
}

/// 快照 JSON → 消息列表：按导出时保留的 message_id 分组 parts
fn opencode_parse_snapshot(v: &Value) -> Vec<ChatMessageDto> {
    let messages = v.get("messages").and_then(|m| m.as_array());
    let parts = v.get("parts").and_then(|p| p.as_array());
    let (Some(messages), Some(parts)) = (messages, parts) else {
        return Vec::new();
    };
    let mut parts_by_msg: HashMap<String, Vec<&Value>> = HashMap::new();
    for p in parts {
        if let Some(mid) = get_str(p, "message_id") {
            if let Some(data) = p.get("data") {
                parts_by_msg.entry(mid.to_string()).or_default().push(data);
            }
        }
    }
    let mut msgs = Vec::new();
    for m in messages {
        let Some(data) = m.get("data") else {
            continue;
        };
        let owned = get_str(m, "id")
            .and_then(|id| parts_by_msg.remove(id))
            .unwrap_or_default();
        let ts = m.get("time_created").and_then(|t| t.as_i64());
        if let Some(msg) = opencode_message(data, owned, ts) {
            msgs.push(msg);
        }
    }
    msgs
}

// ----- 旧版（pre-v1.2）storage/ 扁平 JSON -----
// 更老的 project/<slug>/storage/... 布局不兼容（此处只读 v1.1 的 storage/ 结构）

fn opencode_legacy_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(windows)]
    if let Some(local) = dirs::data_local_dir() {
        roots.push(local.join("opencode").join("storage"));
    }
    if let Some(h) = dirs::home_dir() {
        roots.push(
            h.join(".local")
                .join("share")
                .join("opencode")
                .join("storage"),
        );
    }
    roots
}

/// legacy 目录下的一层 .json 文件（collect_files 只认 .jsonl[.zst]，不能复用）
fn collect_json_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_file() && p.extension().and_then(|x| x.to_str()) == Some("json") {
            out.push(p);
        }
    }
}

fn read_json_file(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Session Info 的时间字段：顶层 epoch ms 或嵌套 time.{created,updated}
fn legacy_time(v: &Value, flat: &str, nested: &str) -> Option<i64> {
    v.get(flat).and_then(|t| t.as_i64()).or_else(|| {
        v.get("time")
            .and_then(|t| t.get(nested))
            .and_then(|t| t.as_i64())
    })
}

fn legacy_tokens(v: &Value) -> Option<TokenUsageDto> {
    let t = |k: &str| v.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    if t("tokens_input") + t("tokens_output") + t("tokens_reasoning") > 0 {
        Some(opencode_usage(
            t("tokens_input"),
            t("tokens_output"),
            t("tokens_reasoning"),
            t("tokens_cache_read"),
            t("tokens_cache_write"),
        ))
    } else {
        None
    }
}

fn opencode_scan_legacy(storage: &Path) -> Vec<SessionMetaDto> {
    // legacy 是 .json 文件，不能用 collect_files（只认 .jsonl[.zst]）
    let mut files = Vec::new();
    if let Ok(projects) = fs::read_dir(storage.join("session")) {
        for p in projects.flatten() {
            let Ok(entries) = fs::read_dir(p.path()) else {
                continue;
            };
            for e in entries.flatten() {
                let path = e.path();
                if path.extension().and_then(|x| x.to_str()) == Some("json") {
                    files.push(path);
                }
            }
        }
    }
    let mut out = Vec::new();
    for f in files {
        let Some(v) = read_json_file(&f) else {
            continue;
        };
        let id = get_str(&v, "id")
            .map(String::from)
            .or_else(|| f.file_stem().map(|s| s.to_string_lossy().into_owned()))
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        out.push(SessionMetaDto {
            agent: "opencode".into(),
            session_id: id,
            project_path: get_str(&v, "directory").unwrap_or("").to_string(),
            cwd: get_str(&v, "directory").map(String::from),
            title: get_str(&v, "title").and_then(usable_title),
            created_at: legacy_time(&v, "time_created", "created").map(opencode_ms_to_iso),
            updated_at: legacy_time(&v, "time_updated", "updated").map(opencode_ms_to_iso),
            file_path: f.to_string_lossy().into_owned(),
            token_usage: legacy_tokens(&v),
            cli_version: get_str(&v, "version").map(String::from),
            pinned: false,
            archived: false,
            custom_title: None,
            tags: Vec::new(),
            alive: true,
            chain_count: 1,
            workspace: None,
            step_name: None,
            summary: None,
            live: mtime_fresh(&f, 60),
            source: default_session_source(),
            internal: false,
            handoff_from_agent: None,
            handoff_from_session: None,
            task_id: None,
            task_name: None,
            provider: None,
            profile_id: None,
        });
    }
    out
}

fn opencode_parse_legacy(session_json: &Path) -> Vec<ChatMessageDto> {
    let storage = session_json
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent());
    let Some(storage) = storage else {
        return Vec::new();
    };
    let sid = session_json
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    // message/<sid>/<msgID>.json 按 data.time.created 排序
    let mut msg_files = Vec::new();
    collect_json_files(&storage.join("message").join(&sid), &mut msg_files);
    let mut messages: Vec<(i64, String, Value)> = Vec::new();
    for f in msg_files {
        let Some(v) = read_json_file(&f) else {
            continue;
        };
        let ts = legacy_time(&v, "time_created", "created").unwrap_or(0);
        let mid = f
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        messages.push((ts, mid, v));
    }
    messages.sort_by_key(|(ts, _, _)| *ts);
    let mut msgs = Vec::new();
    for (ts, mid, v) in messages {
        let mut part_files = Vec::new();
        collect_json_files(&storage.join("part").join(&mid), &mut part_files);
        part_files.sort();
        let parts: Vec<Value> = part_files
            .iter()
            .filter_map(|f| read_json_file(f))
            .collect();
        if let Some(m) = opencode_message(&v, parts.iter().collect(), Some(ts)) {
            msgs.push(m);
        }
    }
    msgs
}

// ===== 扫描 =====

#[derive(Debug, Clone, Default)]
pub struct ScanResult {
    pub sessions: Vec<SessionMetaDto>,
    /// codex 链代表 id → 全部成员 id（含代表自己）；链代表随新 resume 换人时，
    /// 用户写在任一成员 id 上的 pinned/tags 等整理数据仍能找回来
    pub chain_members: HashMap<String, Vec<String>>,
    /// 项目路径 → provenance 规范化结果（含 canonicalize），随扫描缓存一轮，
    /// apply_provenance 不再每个会话每轮都 canonicalize
    pub provenance_paths: HashMap<String, String>,
}

// ===== 逐文件增量缓存 =====
//
// 10s 整表缓存（SCAN_CACHE）过期后，扫描仍按 (路径, mtime, 大小) 指纹跳过未变化文件的
// 重解析——原来每轮都要对全部会话文件跑 read_head_tail（Codex 的 .zst 还要流式解压），
// 窗口聚焦触发的同步会周期性打满 CPU。指纹未变 = 内容未变（jsonl 只追加），沿用旧 meta。
// `live` 除外：它是「距现在 ≤60s」的时间派生值，出站在 cached_scan 现算，禁止随指纹冻结
// （自动起名会在对话还在写时 invalidate + 重扫，冻住就会让绿点永远亮）。
// usage.rs 的增量索引是同一思路，但两边用途不同（meta 列表 vs token 事件），不共用存储。

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileSig {
    len: u64,
    mtime_ns: i64,
}

fn file_sig(path: &Path) -> Option<FileSig> {
    let md = fs::metadata(path).ok()?;
    let mtime_ns = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0);
    Some(FileSig {
        len: md.len(),
        mtime_ns,
    })
}

#[derive(Default)]
struct ScanFileCache {
    /// 主会话文件：路径 → (指纹, meta)
    plain: HashMap<String, (FileSig, SessionMetaDto)>,
    /// codex/grok：meta + 链父 id（merge_codex_chains 的输入）
    chained: HashMap<String, (FileSig, SessionMetaDto, Option<String>)>,
    /// kimi：state.json 内容参与解析，值多带一份 state 指纹
    kimi: HashMap<String, (FileSig, Option<FileSig>, SessionMetaDto)>,
    /// 快照区（kimi 之外各家 + opencode .json）：解析不依赖外部文件
    snapshot: HashMap<String, (FileSig, SessionMetaDto)>,
    /// kimi 快照要先读字节分辨新/旧协议，单独一栏
    kimi_snapshot: HashMap<String, (FileSig, SessionMetaDto)>,
    /// opencode 共享 SQLite：db 文件指纹 → 整批行
    opencode_db: HashMap<String, (FileSig, Vec<SessionMetaDto>)>,
    /// opencode 旧版扁平 JSON：storage 根路径 → (目录清单指纹, 整批)
    opencode_legacy: HashMap<String, (u64, Vec<SessionMetaDto>)>,
    /// grok 会话的 summary.json 指纹侧栏：与 chained 里 updates.jsonl 指纹分开比较，
    /// 不做 XOR 折叠（同长改动会抵消成缓存假命中）
    grok_summary: HashMap<String, Option<FileSig>>,
}

static SCAN_FILE_CACHE: OnceLock<Mutex<ScanFileCache>> = OnceLock::new();

fn scan_file_cache() -> &'static Mutex<ScanFileCache> {
    SCAN_FILE_CACHE.get_or_init(|| Mutex::new(ScanFileCache::default()))
}

fn cache_key(path: &Path) -> String {
    crate::paths::path_key(&path.to_string_lossy())
}

/// 逐文件带指纹的解析：未变命中缓存，变了才跑 parse。解析失败（None）不缓存——
/// 下次仍重试，避免把「文件写到一半」的瞬时状态记成长期缺席。
fn cached_plain(
    files: Vec<PathBuf>,
    cache: &mut HashMap<String, (FileSig, SessionMetaDto)>,
    mut parse: impl FnMut(&Path) -> Option<SessionMetaDto>,
) -> Vec<SessionMetaDto> {
    let mut next: HashMap<String, (FileSig, SessionMetaDto)> = HashMap::with_capacity(files.len());
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        let Some(sig) = file_sig(&f) else { continue };
        let key = cache_key(&f);
        let meta = match cache.get(&key) {
            Some((old_sig, old)) if *old_sig == sig => old.clone(),
            _ => match parse(&f) {
                Some(m) => m,
                None => continue,
            },
        };
        next.insert(key, (sig, meta.clone()));
        out.push(meta);
    }
    *cache = next; // 顺手淘汰已消失文件的条目
    out
}

/// codex/grok 同款，多带一个链父 id
fn cached_chained(
    files: Vec<PathBuf>,
    cache: &mut HashMap<String, (FileSig, SessionMetaDto, Option<String>)>,
    mut parse: impl FnMut(&Path) -> Option<(SessionMetaDto, Option<String>)>,
) -> Vec<(SessionMetaDto, Option<String>)> {
    let mut next: HashMap<String, (FileSig, SessionMetaDto, Option<String>)> =
        HashMap::with_capacity(files.len());
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        let Some(sig) = file_sig(&f) else { continue };
        let key = cache_key(&f);
        let pair = match cache.get(&key) {
            Some((old_sig, m, parent)) if *old_sig == sig => (m.clone(), parent.clone()),
            _ => match parse(&f) {
                Some(p) => p,
                None => continue,
            },
        };
        next.insert(key, (sig, pair.0.clone(), pair.1.clone()));
        out.push(pair);
    }
    *cache = next;
    out
}

/// opencode 旧版 storage 目录的清单指纹：逐文件 (路径+长度+mtime) 排序后折叠。
/// 目录本身 mtime 不反映深层文件改动，必须逐文件看。
fn dir_listing_sig(files: &[PathBuf]) -> u64 {
    let mut acc: u64 = 0xcbf29ce484222325;
    let mut keys: Vec<(String, u64, i64)> = files
        .iter()
        .filter_map(|f| file_sig(f).map(|s| (cache_key(f), s.len, s.mtime_ns)))
        .collect();
    keys.sort();
    for (k, len, mt) in keys {
        for b in k.as_bytes() {
            acc = (acc ^ (*b as u64)).wrapping_mul(0x100000001b3);
        }
        acc = (acc ^ len).wrapping_mul(0x100000001b3);
        acc = (acc ^ (mt as u64)).wrapping_mul(0x100000001b3);
    }
    acc
}

pub fn scan_sessions() -> ScanResult {
    let mut out = Vec::new();
    let mut chain_members = HashMap::new();
    let mut cache = scan_file_cache().lock().unwrap_or_else(|e| e.into_inner());
    let ScanFileCache {
        plain,
        chained,
        kimi,
        snapshot,
        kimi_snapshot,
        opencode_db,
        opencode_legacy,
        grok_summary,
    } = &mut *cache;
    // Gemini 的 slug → 项目路径映射在扫描与快照补全时都要用
    let gemini_map = dirs::home_dir()
        .map(|h| gemini_slug_map(&h.join(".gemini").join("tmp")))
        .unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        let mut claude_files = Vec::new();
        collect_files(&home.join(".claude").join("projects"), 2, &mut claude_files);
        out.extend(cached_plain(claude_files, plain, |f| {
            claude_file_meta(f, true)
        }));
        // archived_sessions 里的文件是 alive 的归档，不是「已失效」
        let mut active_files = Vec::new();
        collect_files(&home.join(".codex").join("sessions"), 5, &mut active_files);
        let mut archived_files = Vec::new();
        collect_files(
            &home.join(".codex").join("archived_sessions"),
            5,
            &mut archived_files,
        );
        active_files.extend(archived_files);
        // archived 标记不进缓存值：目录固定（sessions/ vs archived_sessions/），
        // 按路径直读即可，同一路径不会跨目录漂移
        let codex_metas = cached_chained(active_files, chained, |f| {
            let archived = f.components().any(|c| c.as_os_str() == "archived_sessions");
            codex_file_meta(f, true, archived)
        });
        let (reps, members) = merge_codex_chains(codex_metas);
        out.extend(reps);
        chain_members = members;
        // Gemini：深度 3 恰好到 chats/*.jsonl，chats/<parentId>/ 下的子 agent 会话被排除；
        // 旧版单 JSON .json 文件不匹配 .jsonl 后缀，自然跳过（如需兼容再单开解析器）
        let mut gemini_files = Vec::new();
        collect_files(&home.join(".gemini").join("tmp"), 3, &mut gemini_files);
        let gemini_metas = cached_plain(gemini_files, plain, |f| {
            gemini_file_meta(f, true, &gemini_map)
        });
        out.extend(dedupe_gemini_sessions(gemini_metas));
        // Qwen：深度 4 覆盖 chats/archive/；archive 目录下的是归档（alive 但 archived）
        let mut qwen_files = Vec::new();
        collect_files(&home.join(".qwen").join("projects"), 4, &mut qwen_files);
        out.extend(cached_plain(qwen_files, plain, |f| {
            let archived = f
                .parent()
                .and_then(|p| p.file_name())
                .is_some_and(|n| n == "archive");
            qwen_file_meta(f, true, archived)
        }));
        // Kimi 新版：session_index.jsonl 是枚举入口（workDir 即项目归属）。
        // sid/wd 参与 meta 但不来自文件本身——键里带上 sid/wd，索引行改写即换键重解析
        let index = home.join(".kimi-code").join("session_index.jsonl");
        if let Ok(text) = fs::read_to_string(&index) {
            let mut entries = Vec::new();
            for line in to_lines(&text) {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let (Some(sid), Some(dir), Some(wd)) = (
                    get_str(&v, "sessionId"),
                    get_str(&v, "sessionDir"),
                    get_str(&v, "workDir"),
                ) else {
                    continue;
                };
                let dir = PathBuf::from(dir);
                let wire = dir.join("agents").join("main").join("wire.jsonl");
                if !wire.exists() {
                    continue;
                }
                entries.push((wire, sid.to_string(), wd.to_string()));
            }
            let keyed: Vec<(String, PathBuf, String, String)> = entries
                .into_iter()
                .map(|(wire, sid, wd)| {
                    // 键只用可打印分隔符拼 sid/wd，wire 本身不进键（dir 已含在 sid 维度里）
                    (format!("wire|{sid}|{wd}"), wire, sid, wd)
                })
                .collect();
            let mut next: HashMap<String, (FileSig, Option<FileSig>, SessionMetaDto)> =
                HashMap::with_capacity(keyed.len());
            for (key, wire, sid, wd) in keyed {
                let Some(sig) = file_sig(&wire) else { continue };
                let session_dir = wire
                    .parent()
                    .and_then(|p| p.parent())
                    .and_then(|p| p.parent())
                    .map(|d| d.to_path_buf());
                let state_sig = session_dir
                    .as_ref()
                    .map(|d| d.join("state.json"))
                    .and_then(|p| file_sig(&p));
                let meta = match kimi.get(&key) {
                    Some((old_sig, old_state, old))
                        if *old_sig == sig && *old_state == state_sig =>
                    {
                        old.clone()
                    }
                    _ => {
                        let state = session_dir
                            .as_ref()
                            .and_then(|d| fs::read_to_string(d.join("state.json")).ok())
                            .and_then(|t| serde_json::from_str::<Value>(&t).ok());
                        match kimi_wire_file_meta(&wire, true, &sid, wd, state.as_ref()) {
                            Some(m) => m,
                            None => continue,
                        }
                    }
                };
                next.insert(key, (sig, state_sig, meta.clone()));
                out.push(meta);
            }
            *kimi = next;
        }
        // Kimi 旧版：sessions/<md5(workDir)>/<uuid>/context.jsonl
        let buckets = kimi_workdir_buckets(&home.join(".kimi").join("kimi.json"));
        if !buckets.is_empty() {
            let mut kimi_files = Vec::new();
            collect_files(&home.join(".kimi").join("sessions"), 3, &mut kimi_files);
            let keyed: Vec<(String, PathBuf, String, String)> = kimi_files
                .into_iter()
                .filter_map(|f| {
                    let bucket = f
                        .parent()
                        .and_then(|p| p.parent())
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().into_owned())?;
                    let project = buckets.get(&bucket)?.clone();
                    let sid = f
                        .parent()
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    // 键带 sid/project：buckets 表改写（同目录换归属）即换键重解析
                    Some((format!("legacy|{sid}|{project}"), f, sid, project))
                })
                .collect();
            let mut next: HashMap<String, (FileSig, Option<FileSig>, SessionMetaDto)> =
                HashMap::with_capacity(keyed.len());
            for (key, f, sid, project) in keyed {
                let Some(sig) = file_sig(&f) else { continue };
                let state_sig = f
                    .parent()
                    .map(|d| d.join("state.json"))
                    .and_then(|p| file_sig(&p));
                let meta = match kimi.get(&key) {
                    Some((old_sig, old_state, old))
                        if *old_sig == sig && *old_state == state_sig =>
                    {
                        old.clone()
                    }
                    _ => {
                        let state = f
                            .parent()
                            .and_then(|d| fs::read_to_string(d.join("state.json")).ok())
                            .and_then(|t| serde_json::from_str::<Value>(&t).ok());
                        match kimi_legacy_file_meta(&f, true, &sid, project, state.as_ref()) {
                            Some(m) => m,
                            None => continue,
                        }
                    }
                };
                next.insert(key, (sig, state_sig, meta.clone()));
                out.push(meta);
            }
            kimi.extend(next); // 新版键与 legacy| 前缀键不冲突，合并存一栏
        }
        // OpenCode：v1.2+ 读共享 SQLite（WAL 只读）；旧版读 storage/ 扁平 JSON
        let mut found_db = false;
        let mut opencode_db_next: HashMap<String, (FileSig, Vec<SessionMetaDto>)> =
            HashMap::with_capacity(opencode_db.len());
        for db in opencode_db_candidates() {
            if db.exists() {
                let sig = file_sig(&db);
                let key = cache_key(&db);
                let rows = match (sig, opencode_db.get(&key)) {
                    (Some(sig), Some((old_sig, rows))) if *old_sig == sig => rows.clone(),
                    _ => opencode_scan_db(&db),
                };
                if let Some(sig) = sig {
                    opencode_db_next.insert(key, (sig, rows.clone()));
                }
                out.extend(rows);
                found_db = true;
            }
        }
        // 候选清单外的旧条目按本轮清单淘汰（配置/默认目录漂移后不留无界残留）
        *opencode_db = opencode_db_next;
        if !found_db {
            for storage in opencode_legacy_roots() {
                if storage.exists() {
                    let mut files = Vec::new();
                    collect_files(&storage, 4, &mut files);
                    let sig = dir_listing_sig(&files);
                    let rows = match opencode_legacy.get(&cache_key(&storage)) {
                        Some((old_sig, rows)) if *old_sig == sig => rows.clone(),
                        _ => {
                            let rows = opencode_scan_legacy(&storage);
                            opencode_legacy.insert(cache_key(&storage), (sig, rows.clone()));
                            rows
                        }
                    };
                    out.extend(rows);
                }
            }
            // 同上：按本轮 storage 清单淘汰
            let legacy_keys: HashSet<String> = opencode_legacy_roots()
                .into_iter()
                .filter(|r| r.exists())
                .map(|r| cache_key(&r))
                .collect();
            opencode_legacy.retain(|k, _| legacy_keys.contains(k));
        }
        // CodeBuddy：projects/<slug>/<uuid>.jsonl（深度 2 恰好到文件）
        let mut codebuddy_files = Vec::new();
        collect_files(
            &home.join(".codebuddy").join("projects"),
            2,
            &mut codebuddy_files,
        );
        out.extend(cached_plain(codebuddy_files, plain, |f| {
            codebuddy_file_meta(f, true)
        }));
        // Cursor：projects/<编码cwd>/agent-transcripts/<uuid>/<uuid>.jsonl（深度 4 到文件）；
        // ~/.cursor 与 IDE 共享，只收 agent-transcripts 子树（其他位置的 jsonl 不是会话）
        let mut cursor_files = Vec::new();
        collect_files(&home.join(".cursor").join("projects"), 4, &mut cursor_files);
        cursor_files.retain(|f| f.components().any(|c| c.as_os_str() == "agent-transcripts"));
        out.extend(cached_plain(cursor_files, plain, |f| {
            cursor_file_meta(f, true)
        }));
        // Grok Build：sessions/<encoded-cwd>/<session-id>/updates.jsonl（深度 3 到文件）；
        // 只收文件名恰为 updates.jsonl 的（session_search.sqlite 是 FTS 索引不是会话本体，
        // chat_history.jsonl 是原始请求消息——均自然排除）。
        // compact/继续会 fork 新目录并写 parent_session_id，标题常与父会话相同——并入 Codex 同款链。
        // meta 优先读同目录 summary.json：它与 updates.jsonl 内容可独立更新，
        // 指纹须逐文件携带（updates 指纹 → summary 指纹），不折叠成单值——
        // 折叠（如 XOR）在同长改动下会抵消成假命中。
        let mut grok_files = Vec::new();
        collect_files(&home.join(".grok").join("sessions"), 3, &mut grok_files);
        grok_files.retain(|f| {
            f.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .as_deref()
                == Some("updates.jsonl")
        });
        let mut grok_metas = Vec::with_capacity(grok_files.len());
        let mut grok_next: HashMap<String, (FileSig, SessionMetaDto, Option<String>)> =
            HashMap::with_capacity(grok_files.len());
        let mut grok_summary_next: HashMap<String, Option<FileSig>> =
            HashMap::with_capacity(grok_files.len());
        for f in grok_files {
            let Some(sig) = file_sig(&f) else { continue };
            // summary.json 参与解析：它与 updates.jsonl 同目录、内容可独立更新
            let summary_sig = f
                .parent()
                .map(|d| d.join("summary.json"))
                .and_then(|p| file_sig(&p));
            let key = format!("grok|{}", f.display());
            let hit = chained
                .get(&key)
                .is_some_and(|(old_sig, _, _)| *old_sig == sig)
                && grok_summary
                    .get(&key)
                    .is_some_and(|old| *old == summary_sig);
            let pair = if hit {
                let (m, parent) = chained.get(&key).map(|(_, m, p)| (m, p)).unwrap();
                (m.clone(), parent.clone())
            } else {
                match grok_file_meta(&f, true) {
                    Some(p) => p,
                    None => continue,
                }
            };
            grok_next.insert(key.clone(), (sig, pair.0.clone(), pair.1.clone()));
            grok_summary_next.insert(key, summary_sig);
            grok_metas.push(pair);
        }
        // grok 与 codex 共用 chained 一栏：grok 键带前缀，codex 键是裸路径，互不冲突；
        // chained 已在 codex 段整体替换过，这里合并而不是覆盖
        chained.extend(grok_next);
        *grok_summary = grok_summary_next;
        let (reps, members) = merge_codex_chains(grok_metas);
        out.extend(reps);
        chain_members.extend(members);
    }
    // pin 即保留：源文件已消失的会话从快照补齐（§6.5）
    let seen: HashSet<(String, String)> = out
        .iter()
        .map(|m| (m.agent.clone(), m.session_id.clone()))
        .collect();
    if let Some(dir) = snapshots_root() {
        // 快照区两栏缓存也按本轮清单重建：已删除的快照文件不留缓存残留
        let mut snapshot_next: HashMap<String, (FileSig, SessionMetaDto)> =
            HashMap::with_capacity(snapshot.len());
        let mut kimi_snapshot_next: HashMap<String, (FileSig, SessionMetaDto)> =
            HashMap::with_capacity(kimi_snapshot.len());
        for agent in [
            "claude-code",
            "codex",
            "gemini",
            "qwen",
            "kimi",
            "opencode",
            "codebuddy",
            "cursor",
            "grok",
        ] {
            for f in snapshot_files(&dir, agent) {
                let stem = snapshot_stem(&f);
                if seen.contains(&(agent.to_string(), stem.clone())) {
                    continue; // 源文件还在，快照不重复列出
                }
                let key = format!("{agent}|{}", f.display());
                let parse = |f: &Path| {
                    let meta = match agent {
                        "codex" => codex_file_meta(f, false, false).map(|(m, _)| m),
                        "gemini" => gemini_file_meta(f, false, &gemini_map),
                        "qwen" => qwen_file_meta(f, false, false),
                        "opencode" => opencode_snapshot_meta(f, &stem),
                        "codebuddy" => codebuddy_file_meta(f, false),
                        "cursor" => cursor_file_meta(f, false),
                        "grok" => grok_file_meta(f, false).map(|(m, _)| m),
                        _ => claude_file_meta(f, false),
                    };
                    meta.map(|mut m| {
                        m.session_id = stem.clone(); // 快照文件名即 pin 时的 session_id
                        m.alive = false;
                        m
                    })
                };
                let meta = if agent == "kimi" {
                    // kimi 快照要先读字节分辨新/旧协议，单独一栏
                    let Some(sig) = file_sig(&f) else { continue };
                    let m = match kimi_snapshot.get(&key) {
                        Some((old_sig, old)) if *old_sig == sig => old.clone(),
                        _ => {
                            let parsed = read_session_bytes(&f).and_then(|b| {
                                let lines = to_lines(&String::from_utf8_lossy(&b));
                                let m = if kimi_looks_like_wire(&lines) {
                                    kimi_wire_file_meta(&f, false, &stem, String::new(), None)
                                } else {
                                    kimi_legacy_file_meta(&f, false, &stem, String::new(), None)
                                };
                                m.map(|mut m| {
                                    m.session_id = stem.clone();
                                    m.alive = false;
                                    m
                                })
                            });
                            match parsed {
                                Some(m) => m,
                                None => continue,
                            }
                        }
                    };
                    kimi_snapshot_next.insert(key, (sig, m.clone()));
                    Some(m)
                } else {
                    let Some(sig) = file_sig(&f) else { continue };
                    let m = match snapshot.get(&key) {
                        Some((old_sig, old)) if *old_sig == sig => old.clone(),
                        _ => match parse(&f) {
                            Some(m) => m,
                            None => continue,
                        },
                    };
                    snapshot_next.insert(key, (sig, m.clone()));
                    Some(m)
                };
                if let Some(m) = meta {
                    out.push(m);
                }
            }
        }
        *snapshot = snapshot_next;
        *kimi_snapshot = kimi_snapshot_next;
    }
    // 工作区 worktree 里的会话归并回「真实仓库 + 工作区名」（§6.10 ProjectAggregator 咬合点）
    let wt_rows = crate::workspaces::worktree_rows();
    if !wt_rows.is_empty() {
        for s in &mut out {
            if let Some((repo, ws)) = resolve_worktree_project(&s.project_path, &wt_rows) {
                s.project_path = repo;
                s.workspace = Some(ws);
            }
        }
    }
    // 编程工作树会话归并回主仓 + 分支名（C2）：与科研工作区同构，用量页「按项目」
    // 与会话列表经 scan_sessions 同源跟随，不再把每棵树当独立项目行。
    // 边界铁律：①科研先、编程只收剩余（科研工作区本身也是 git worktree，先归并防抢）；
    // ②只认 Mesa 自己的 ~/ccode/worktrees/ 下的树——git 兜底不能把任意 git 目录里
    // 的会话归并到那个仓（会话 cwd 没有边界，会误伤用户在 Mesa 外的普通 git 项目）。
    if let Ok(coding_root) = crate::coding::worktrees_root() {
        let root_str = coding_root.to_string_lossy().into_owned();
        // 同一工作树只解析一次：lanes 查表每次新开连接（带幂等 DDL），逐会话查会
        // 拖慢冷扫描（实测约 30 个会话多花 1.7s）；按路径去重后每棵树最多一次
        let mut attr_by_path: HashMap<String, Option<(String, String)>> = HashMap::new();
        for s in &mut out {
            if s.workspace.is_some() {
                continue;
            }
            if !crate::paths::path_within(&s.project_path, &root_str) {
                continue;
            }
            let attr = attr_by_path
                .entry(s.project_path.clone())
                .or_insert_with(|| crate::coding::attribution_for_worktree(&s.project_path))
                .clone();
            if let Some((repo, branch)) = attr {
                s.project_path = repo;
                s.workspace = Some(branch);
            }
        }
    }
    // RX3a 对话步骤化：工作区名命中项目档案卡 steps[].workspaceName 时附带步骤名。
    // 每轮扫描按仓库只读一次 project.toml；扫描结果本身有 10s 缓存，档案卡改动下轮生效
    let mut step_maps: HashMap<String, HashMap<String, String>> = HashMap::new();
    for s in &mut out {
        let Some(ws) = s.workspace.clone() else {
            continue;
        };
        let map = step_maps
            .entry(s.project_path.clone())
            .or_insert_with(|| crate::projects::step_names_at(Path::new(&s.project_path)));
        if let Some(name) = map.get(&ws) {
            s.step_name = Some(name.clone());
        }
    }
    ScanResult {
        sessions: out,
        chain_members,
        provenance_paths: HashMap::new(), // 由 cached_scan 按项目去重填充
    }
}

/// 会话的项目路径落在某个工作区 worktree 内（含子目录）时，返回 (真实仓库路径, 工作区名)；
/// 最长前缀优先，找不到返回 None（保持原样）
fn resolve_worktree_project(
    project_path: &str,
    rows: &[crate::workspaces::WorktreeRow],
) -> Option<(String, String)> {
    // worktree 路径来自 DB、会话 cwd 来自 CLI 写的 JSONL、启动 cwd 可能来自注册表——
    // 三种来源在 Windows 上分隔符、verbatim 前缀、大小写都可能不同，统一走 path_within
    let mut best: Option<&crate::workspaces::WorktreeRow> = None;
    for r in rows {
        let wt = r.worktree_path.trim_end_matches(&['/', '\\'][..]);
        let under = crate::paths::path_within(project_path, wt);
        if under {
            let len = wt.len();
            if best.map_or(true, |b| {
                len > b.worktree_path.trim_end_matches(&['/', '\\'][..]).len()
            }) {
                best = Some(r);
            }
        }
    }
    best.map(|r| (r.repo_path.clone(), r.name.clone()))
}

/// Codex resume/fork（forked_from_id）与 Grok compact/继续（parent_session_id）同一套并查集：
/// 新文件已带完整历史，列表只留 updated_at 最新的代表。父文件被清理时链仍然成立。
/// 返回值附带 代表 id → 成员 id 列表，供 db meta 按任一成员查找。
fn merge_codex_chains(
    metas: Vec<(SessionMetaDto, Option<String>)>,
) -> (Vec<SessionMetaDto>, HashMap<String, Vec<String>>) {
    fn find(parent: &mut HashMap<String, String>, x: &str) -> String {
        let mut root = x.to_string();
        while let Some(p) = parent.get(&root) {
            if *p == root {
                break;
            }
            root = p.clone();
        }
        let mut cur = x.to_string();
        while let Some(p) = parent.get(&cur).cloned() {
            if p == cur || p == root {
                break;
            }
            parent.insert(cur.clone(), root.clone());
            cur = p;
        }
        root
    }
    let mut parent: HashMap<String, String> = HashMap::new();
    for (m, fork) in &metas {
        parent
            .entry(m.session_id.clone())
            .or_insert_with(|| m.session_id.clone());
        if let Some(f) = fork {
            parent.entry(f.clone()).or_insert_with(|| f.clone());
            let ra = find(&mut parent, &m.session_id);
            let rb = find(&mut parent, f);
            if ra != rb {
                parent.insert(ra, rb);
            }
        }
    }
    let mut groups: HashMap<String, Vec<SessionMetaDto>> = HashMap::new();
    for (m, _) in metas {
        let root = find(&mut parent, &m.session_id);
        groups.entry(root).or_default().push(m);
    }
    let mut reps = Vec::new();
    let mut members = HashMap::new();
    for mut g in groups.into_values() {
        g.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let n = g.len();
        let member_ids: Vec<String> = g.iter().map(|m| m.session_id.clone()).collect();
        let mut rep = g.into_iter().next().unwrap_or_else(|| unreachable!());
        rep.chain_count = n;
        if n > 1 {
            members.insert(rep.session_id.clone(), member_ids);
        }
        reps.push(rep);
    }
    (reps, members)
}

fn snapshot_stem(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.strip_suffix(".jsonl.zst")
        .or_else(|| name.strip_suffix(".jsonl"))
        .or_else(|| name.strip_suffix(".json")) // opencode 快照是导出的 JSON
        .unwrap_or(&name)
        .to_string()
}

/// pin 快照目录下的文件：opencode 快照是导出的 .json（collect_files 只认 .jsonl[.zst]，单收）
fn snapshot_files(root: &Path, agent: &str) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if agent == "opencode" {
        collect_json_files(&root.join(agent), &mut files);
    } else {
        collect_files(&root.join(agent), 1, &mut files);
    }
    files
}

/// opencode pin 快照（opencode_export_session 导出的自包含 JSON）→ 列表条目
fn opencode_snapshot_meta(path: &Path, session_id: &str) -> Option<SessionMetaDto> {
    let v = read_json_file(path)?;
    let s = v.get("session")?;
    Some(SessionMetaDto {
        agent: "opencode".into(),
        session_id: session_id.to_string(),
        project_path: get_str(s, "directory").unwrap_or("").to_string(),
        cwd: get_str(s, "directory").map(String::from),
        title: get_str(s, "title").and_then(usable_title),
        created_at: s
            .get("time_created")
            .and_then(|t| t.as_i64())
            .map(opencode_ms_to_iso),
        updated_at: s
            .get("time_updated")
            .and_then(|t| t.as_i64())
            .map(opencode_ms_to_iso),
        file_path: path.to_string_lossy().into_owned(),
        token_usage: legacy_tokens(s),
        cli_version: get_str(s, "version").map(String::from),
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive: false,
        chain_count: 1,
        workspace: None,
        step_name: None,
        summary: None,
        live: false,
        source: default_session_source(),
        internal: false,
        handoff_from_agent: None,
        handoff_from_session: None,
        task_id: None,
        task_name: None,
        provider: None,
        profile_id: None,
    })
}

// ===== 快照与 app.db =====

fn snapshots_root() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("ccode").join("snapshots"))
}

/// session_id/agent 来自前端参数，进路径前收敛字符集，防目录穿越
fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn snapshot_path(agent: &str, session_id: &str, zst: bool) -> Option<PathBuf> {
    let name = format!(
        "{}.jsonl{}",
        sanitize_id(session_id),
        if zst { ".zst" } else { "" }
    );
    Some(snapshots_root()?.join(sanitize_id(agent)).join(name))
}

/// opencode 的会话存在共享 SQLite 里，pin 时导出为 JSON 快照（.json 扩展名）
fn snapshot_json_path(agent: &str, session_id: &str) -> Option<PathBuf> {
    let name = format!("{}.json", sanitize_id(session_id));
    Some(snapshots_root()?.join(sanitize_id(agent)).join(name))
}

fn snapshot_candidates(agent: &str, session_id: &str) -> Vec<PathBuf> {
    [
        snapshot_path(agent, session_id, false),
        snapshot_path(agent, session_id, true),
        snapshot_json_path(agent, session_id),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// 源文件消失时找快照：Claude 文件名即 session_id；Codex 是 rollout-<时间>-<uuid>，取尾部 uuid
fn find_snapshot(agent: &str, source: &Path) -> Option<PathBuf> {
    let stem = source.file_stem()?.to_string_lossy().into_owned();
    let mut stems = vec![stem.clone()];
    if stem.len() > 36 {
        if let Some(tail) = stem.get(stem.len() - 36..) {
            if tail.chars().filter(|c| *c == '-').count() == 4 {
                stems.push(tail.to_string());
            }
        }
    }
    for s in stems {
        if let Some(p) = snapshot_candidates(agent, &s)
            .into_iter()
            .find(|p| p.exists())
        {
            return Some(p);
        }
    }
    None
}

pub(crate) fn open_db() -> Result<Connection, String> {
    let dir = dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode");
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let conn =
        Connection::open(dir.join("app.db")).map_err(|e| format!("打开 app.db 失败: {e}"))?;
    // 与 projects::db_at / workspaces::db_at 同一口径（同一个 app.db）：不设等待窗口时
    // 本连接是并发写下最先吃 SQLITE_BUSY 的那个（session_meta / card_claims 的写入走这里）
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("设置 app.db 等待时间失败: {e}"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_meta(
          agent TEXT NOT NULL, session_id TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
          custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
          note TEXT, pinned_at TEXT,
          profile_id TEXT,
          PRIMARY KEY(agent, session_id));",
    )
    .map_err(|e| format!("初始化 session_meta 表失败: {e}"))?;
    migrate_session_meta(&conn);
    Ok(conn)
}

/// 老库补列（AI 摘要、接力来源、会话归卡、步骤归属）：已存在则报错忽略，幂等
pub(crate) fn migrate_session_meta(conn: &Connection) {
    for col in [
        "summary TEXT",
        "summary_at TEXT",
        "handoff_from_agent TEXT",
        "handoff_from_session TEXT",
        "task_id TEXT",
        "step_name TEXT",
        "profile_id TEXT",
        "project_path TEXT",
        "internal INTEGER NOT NULL DEFAULT 0",
        "title_source TEXT",
        "project_id TEXT",
    ] {
        let _ = conn.execute_batch(&format!("ALTER TABLE session_meta ADD COLUMN {col}"));
    }
}

struct MetaRow {
    pinned: bool,
    archived: bool,
    custom_title: Option<String>,
    tags: Vec<String>,
    summary: Option<String>,
    /// 固化后的接力来源（agent, session_id）
    handoff_from: Option<(String, String)>,
    /// 会话归卡（任务卡 id）
    task_id: Option<String>,
    /// 步骤认领固化后的步骤归属（「跟 AI 商量一下」等跑在项目根、落不到 worktree 的会话）
    step_name: Option<String>,
    profile_id: Option<String>,
    /// pin 时固化的项目归属（gemini 快照脱离 slug 目录后靠这一列回填）
    project_path: Option<String>,
    /// 无头 AI（雷达解读 / 定时巡检）按会话 id 标记，避免把整个项目路径标成 internal
    internal: bool,
}

fn read_all_meta(conn: &Connection) -> HashMap<(String, String), MetaRow> {
    let mut map = HashMap::new();
    let Ok(mut stmt) = conn
        .prepare("SELECT agent, session_id, pinned, archived, custom_title, tags, summary, handoff_from_agent, handoff_from_session, task_id, step_name, profile_id, project_path, internal FROM session_meta")
    else {
        return map;
    };
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, Option<String>>(8)?,
            r.get::<_, Option<String>>(9)?,
            r.get::<_, Option<String>>(10)?,
            r.get::<_, Option<String>>(11)?,
            r.get::<_, Option<String>>(12)?,
            r.get::<_, i64>(13).unwrap_or(0),
        ))
    });
    if let Ok(rows) = rows {
        for (
            agent,
            sid,
            pinned,
            archived,
            custom_title,
            tags,
            summary,
            hf_agent,
            hf_session,
            task_id,
            step_name,
            profile_id,
            project_path,
            internal,
        ) in rows.flatten()
        {
            map.insert(
                (agent, sid),
                MetaRow {
                    pinned: pinned != 0,
                    archived: archived != 0,
                    custom_title,
                    tags: serde_json::from_str(&tags).unwrap_or_default(),
                    summary,
                    handoff_from: hf_agent.zip(hf_session),
                    task_id,
                    step_name,
                    profile_id,
                    project_path,
                    internal: internal != 0,
                },
            );
        }
    }
    map
}

/// AI 摘要落库（ai_summarize_session 用）
pub(crate) fn set_session_summary(
    agent: &str,
    session_id: &str,
    summary: &str,
) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, summary, summary_at) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(agent, session_id) DO UPDATE SET summary=?3, summary_at=?4",
        params![agent, session_id, summary, now_iso()],
    )
    .map_err(|e| format!("写入摘要失败: {e}"))?;
    Ok(())
}

/// 无头 AI（雷达解读 / 定时巡检）按会话 id 标 internal。
/// 不能把整个项目路径写入 usage_provenance.internal——那会把该 Agent 在此项目的交互会话一并藏掉。
pub(crate) fn mark_session_internal(agent: &str, session_id: &str) -> Result<(), String> {
    let id = session_id.trim();
    if agent.trim().is_empty() || id.is_empty() {
        return Ok(());
    }
    let conn = open_db()?;
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, internal) VALUES(?1, ?2, 1)
         ON CONFLICT(agent, session_id) DO UPDATE SET internal=1",
        params![agent, id],
    )
    .map_err(|e| format!("标记内部会话失败: {e}"))?;
    Ok(())
}

// ===== 注意力标记 v1（§6.11）：读尾部 ~64KB 分类最后一个有意义的记录 =====
// 返回 "done" | "working" | "confirm" | "unknown"

/// 读文件最后 budget 字节的完整行：走 read_head_tail 的尾窗——普通文件 seek 只读尾部，
/// zstd 流式解码只留尾窗环形缓冲；不再为分类全量读入/解压整个文件
fn last_lines(path: &Path, budget: usize) -> Vec<String> {
    match read_head_tail(path, budget) {
        // 小文件（≤2×budget）head 即全量；大文件取对齐后的尾窗
        Some((head, tail)) => {
            if tail.is_empty() {
                head
            } else {
                tail
            }
        }
        None => Vec::new(),
    }
}

fn ends_with_question(text: &str) -> bool {
    let t = text.trim_end();
    t.ends_with('?') || t.ends_with('？')
}

fn claude_tail_state(lines: &[String]) -> &'static str {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true)
            || v.get("isMeta").and_then(|x| x.as_bool()) == Some(true)
        {
            continue;
        }
        match get_str(&v, "type") {
            Some("user") => return "working", // 发了 prompt 还没等到回答（或 tool_result 刚回）
            Some("assistant") => {
                let Some(arr) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                else {
                    continue;
                };
                if arr.iter().any(|b| get_str(b, "type") == Some("tool_use")) {
                    return "working"; // 尾部有待执行的工具调用
                }
                let last_text = arr.iter().rev().find_map(|b| {
                    if get_str(b, "type") == Some("text") {
                        get_str(b, "text")
                    } else {
                        None
                    }
                });
                match last_text {
                    None => continue,
                    Some(t) if ends_with_question(t) => return "confirm", // 文本以问句收尾，保守判定待确认
                    Some(_) => return "done",
                }
            }
            _ => continue,
        }
    }
    "unknown"
}

fn codex_tail_state(lines: &[String]) -> &'static str {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match get_str(&v, "type") {
            Some("response_item") => {
                let Some(p) = v.get("payload") else {
                    continue;
                };
                match get_str(p, "type") {
                    Some("message") => match get_str(p, "role") {
                        Some("user") => return "working",
                        Some("assistant") => {
                            let text = codex_message_text(p).unwrap_or_default();
                            return if ends_with_question(&text) {
                                "confirm"
                            } else {
                                "done"
                            };
                        }
                        _ => continue,
                    },
                    // 调用未回/刚回，都还在一轮当中
                    Some("function_call") | Some("custom_tool_call") => return "working",
                    Some("function_call_output") | Some("custom_tool_call_output") => {
                        return "working"
                    }
                    _ => continue,
                }
            }
            Some("event_msg") => {
                let Some(p) = v.get("payload") else {
                    continue;
                };
                match get_str(p, "type") {
                    Some("user_message") => return "working",
                    // 中途流式正文不是回合结束；Codex 工具调用之间也会写 agent_message
                    Some("agent_message") => continue,
                    Some("task_complete") => return "done",
                    _ => continue,
                }
            }
            _ => continue,
        }
    }
    "unknown"
}

fn gemini_tail_state(lines: &[String]) -> &'static str {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("$set").is_some() || v.get("$rewindTo").is_some() {
            continue;
        }
        match get_str(&v, "type") {
            Some("user") => return "working",
            Some("gemini") => {
                let text = v
                    .get("content")
                    .and_then(gemini_content_text)
                    .unwrap_or_default();
                return if ends_with_question(&text) {
                    "confirm"
                } else {
                    "done"
                };
            }
            _ => continue, // metadata / info / error / warning 不算数
        }
    }
    "unknown"
}

fn qwen_tail_state(lines: &[String]) -> &'static str {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        match get_str(&v, "type") {
            Some("user") => return "working",
            Some("assistant") => return "done",
            Some("tool_result") => return "working",
            _ => continue, // system 等
        }
    }
    "unknown"
}

fn kimi_tail_state(lines: &[String]) -> &'static str {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match get_str(&v, "type") {
            Some("turn.prompt") => {
                if v.get("origin").and_then(|o| get_str(o, "kind")) == Some("user") {
                    return "working";
                }
            }
            Some("context.append_message") => {
                match v.get("message").and_then(|m| get_str(m, "role")) {
                    Some("assistant") => return "done",
                    Some("user") | Some("tool") => return "working",
                    _ => continue,
                }
            }
            Some("context.append_loop_event") => {
                let Some(e) = v.get("event") else {
                    continue;
                };
                match get_str(e, "type") {
                    Some("step.end") => return "done",
                    // step 进行中（开始/内容流/工具调用与结果）都在工作
                    Some("step.begin") | Some("content.part") | Some("tool.call")
                    | Some("tool.result") => return "working",
                    _ => continue,
                }
            }
            _ => continue,
        }
    }
    "unknown"
}

fn codebuddy_tail_state(lines: &[String]) -> &'static str {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if get_str(&v, "type") != Some("message") {
            continue; // file-history-snapshot 等事件行不算数
        }
        match get_str(&v, "role") {
            Some("user") => return "working", // 发了 prompt 还没等到回答
            Some("assistant") => {
                let text = codebuddy_content_text(&v, "output_text").unwrap_or_default();
                return if ends_with_question(&text) {
                    "confirm"
                } else {
                    "done"
                };
            }
            _ => continue,
        }
    }
    "unknown"
}

/// cursor 尾部状态：从后往前找最近一条已知 type 的记录；未知 type 跳过
fn cursor_tail_state(lines: &[String]) -> &'static str {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match get_str(&v, "type") {
            Some("turn_ended") => return "done",
            // 用户消息发出后还没等到回合结束；工具调用/结果都在回合进行中
            Some("user_message") | Some("tool_call") | Some("tool_result") => return "working",
            _ => continue,
        }
    }
    "unknown"
}

fn opencode_tail_state(db_path: &Path, session_id: &str) -> &'static str {
    let Some(conn) = open_opencode_db(db_path) else {
        return "unknown";
    };
    let sid = session_id.to_string();
    let last_part = query_rows(
        &conn,
        "SELECT * FROM part WHERE session_id=? ORDER BY time_created DESC LIMIT 1",
        &[&sid],
    )
    .into_iter()
    .next();
    let last_msg = query_rows(
        &conn,
        "SELECT * FROM message WHERE session_id=? ORDER BY time_created DESC LIMIT 1",
        &[&sid],
    )
    .into_iter()
    .next();
    let part_ts = last_part
        .as_ref()
        .and_then(|r| {
            DbRow {
                names: r.0.clone(),
                vals: r.1.clone(),
            }
            .as_i64("time_created")
        })
        .unwrap_or(0);
    let msg_ts = last_msg
        .as_ref()
        .and_then(|r| {
            DbRow {
                names: r.0.clone(),
                vals: r.1.clone(),
            }
            .as_i64("time_created")
        })
        .unwrap_or(0);
    if part_ts == 0 && msg_ts == 0 {
        return "unknown";
    }
    if part_ts >= msg_ts {
        let row = DbRow {
            names: last_part.as_ref().unwrap().0.clone(),
            vals: last_part.unwrap().1,
        };
        let data = row
            .as_str("data")
            .and_then(|d| serde_json::from_str::<Value>(&d).ok());
        match data.as_ref().and_then(|d| get_str(d, "type")) {
            Some("tool") => {
                // 单条工具 part 无法判断一轮是否结束：pending/running 显然在工作；
                // completed/error 之后 agent 通常还要继续输出，保守同样判 working。
                // 真正结束时随后的 assistant text part 落库，下一轮轮询会改判 done
                return "working";
            }
            Some("text") | Some("reasoning") => return "done",
            _ => {} // 其他 part 类型回落到消息角色判断
        }
    }
    let Some(row) = last_msg else {
        return "unknown";
    };
    let row = DbRow {
        names: row.0,
        vals: row.1,
    };
    let role = row
        .as_str("data")
        .and_then(|d| serde_json::from_str::<Value>(&d).ok())
        .and_then(|v| get_str(&v, "role").map(String::from));
    match role.as_deref() {
        Some("user") => "working",
        Some("assistant") => "done",
        _ => "unknown",
    }
}

fn tail_state_impl(agent: &str, file_path: &str) -> String {
    if agent == "opencode" {
        let Some((db, sid)) = file_path.split_once('#') else {
            return "unknown".into();
        };
        return opencode_tail_state(Path::new(db), sid).into();
    }
    // 精确注意力标记（设置页按 agent 开启的 hooks 桥接）：事件日志优先于尾部推断；
    // 未在桥接注册表/设置未开启/日志缺失/事件过期均返回 None，自动回落下面的尾部推断
    if let Some(state) = crate::hooks::state_for_session_file(agent, file_path) {
        return state;
    }
    let lines = last_lines(Path::new(file_path), 64 * 1024);
    if lines.is_empty() {
        return "unknown".into();
    }
    match agent {
        "codex" => codex_tail_state(&lines),
        "gemini" => gemini_tail_state(&lines),
        "qwen" => qwen_tail_state(&lines),
        "kimi" => kimi_tail_state(&lines),
        "codebuddy" => codebuddy_tail_state(&lines),
        "cursor" => cursor_tail_state(&lines),
        "grok" => grok_tail_state(&lines),
        _ => claude_tail_state(&lines),
    }
    .into()
}

// ===== Tauri commands =====

/// 扫描结果缓存 10 秒：同步 command 跑在主线程上，列表每 5 秒全量扫几百个文件会卡 UI
static SCAN_CACHE: OnceLock<Mutex<Option<(Instant, ScanResult)>>> = OnceLock::new();

pub(crate) fn cached_scan() -> ScanResult {
    let m = SCAN_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = m.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, res)) = &*guard {
        if at.elapsed() < std::time::Duration::from_secs(10) {
            let mut res = res.clone();
            refresh_scan_live(&mut res);
            return res;
        }
    }
    let mut res = scan_sessions();
    // provenance 路径规范化（含 canonicalize）按项目去重算一次，随扫描结果缓存一轮
    let mut provenance_paths = HashMap::new();
    for s in &res.sessions {
        provenance_paths
            .entry(s.project_path.clone())
            .or_insert_with(|| crate::usage::normalize_provenance_path(&s.project_path));
    }
    res.provenance_paths = provenance_paths;
    refresh_scan_live(&mut res);
    *guard = Some((Instant::now(), res.clone()));
    res
}

fn recent_cached_scan() -> Option<ScanResult> {
    let cache = SCAN_CACHE.get()?;
    let guard = cache.lock().ok()?;
    let (at, result) = guard.as_ref()?;
    (at.elapsed() < std::time::Duration::from_secs(10)).then(|| result.clone())
}

/// pin/unpin/删除/改整理数据后立刻失效，下一次列表拿到新结果
pub(crate) fn invalidate_scan_cache() {
    if let Some(m) = SCAN_CACHE.get() {
        if let Ok(mut g) = m.lock() {
            *g = None;
        }
    }
}

#[cfg(test)]
pub(crate) fn reset_scan_caches_for_test() {
    invalidate_scan_cache();
    if let Ok(mut g) = scan_file_cache().lock() {
        *g = ScanFileCache::default();
    }
}

/// 「◈ 融合进任务书」的会话范围过滤（纯逻辑，可测）：只取 task_id 命中的会话，按时间升序
pub(crate) fn sessions_belonging_to(
    sessions: Vec<SessionMetaDto>,
    task_id: &str,
) -> Vec<SessionMetaDto> {
    let mut out: Vec<SessionMetaDto> = sessions
        .into_iter()
        .filter(|s| s.task_id.as_deref() == Some(task_id))
        .collect();
    out.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
    out
}

/// 某张任务卡名下的全部会话（融合进任务书的取材范围）：全量扫描 + meta/认领合并后按 task_id 过滤。
/// 与 list_sessions 同一归属口径（含 card_claims 固化）；不带分页，归卡会话量少
pub(crate) fn sessions_for_card(task_id: &str) -> Vec<SessionMetaDto> {
    let scan = cached_scan();
    let mut sessions = scan.sessions;
    if let Ok(conn) = open_db() {
        let meta = read_all_meta(&conn);
        apply_meta(&mut sessions, &scan.chain_members, &meta);
        apply_card_claims(&conn, &mut sessions);
    }
    sessions_belonging_to(sessions, task_id)
}

/// 把 session_meta 表的整理数据合并进扫描结果；codex 链代表自身没有行时按任一成员 id 找
fn apply_meta(
    sessions: &mut [SessionMetaDto],
    chain_members: &HashMap<String, Vec<String>>,
    meta: &HashMap<(String, String), MetaRow>,
) {
    for s in sessions {
        let row = meta
            .get(&(s.agent.clone(), s.session_id.clone()))
            .or_else(|| {
                chain_members.get(&s.session_id).and_then(|members| {
                    members
                        .iter()
                        .find_map(|id| meta.get(&(s.agent.clone(), id.clone())))
                })
            });
        if let Some(row) = row {
            s.pinned = row.pinned;
            // 扫描侧已标归档的（Codex archived_sessions 目录）不能被 db 行覆盖掉
            s.archived = s.archived || row.archived;
            s.custom_title = row.custom_title.clone();
            s.tags = row.tags.clone();
            s.summary = row.summary.clone();
            if let Some((hf_agent, hf_session)) = &row.handoff_from {
                s.handoff_from_agent = Some(hf_agent.clone());
                s.handoff_from_session = Some(hf_session.clone());
            }
            s.task_id = row.task_id.clone();
            // 步骤归属兜底：worktree 命中（RX3a，扫描侧已填）优先，持久列只补项目根会话的空
            if s.step_name.is_none() {
                s.step_name = row.step_name.clone();
            }
            s.profile_id = row.profile_id.clone();
            s.internal = s.internal || row.internal;
            // 快照脱离原目录后归属可能丢失：用 pin 时写入的 project_path 回填
            if !s.alive {
                if let Some(p) = row.project_path.as_ref().filter(|p| !p.is_empty()) {
                    s.project_path = p.clone();
                }
            }
        }
    }
}

/// 会话归卡回填：task_id 命中所属项目档案卡 [[tasks]] 时附带卡片名；卡片已删容忍为 None。
/// 与步骤名同一口径：每个项目根每轮列表只读一次 project.toml（列表结果另有 10s 扫描缓存）。
fn apply_task_names(sessions: &mut [SessionMetaDto]) {
    let mut cache: HashMap<String, HashMap<String, String>> = HashMap::new();
    for s in sessions.iter_mut() {
        let Some(task_id) = s.task_id.clone() else {
            continue;
        };
        let names = cache
            .entry(s.project_path.clone())
            .or_insert_with(|| crate::projects::task_names_at(Path::new(&s.project_path)));
        s.task_name = names.get(&task_id).cloned();
    }
}

fn apply_provenance(
    conn: &Connection,
    sessions: &mut [SessionMetaDto],
    norm_paths: &HashMap<String, String>,
) {
    let Ok(mut stmt) =
        conn.prepare("SELECT agent, project_path, source, internal FROM usage_provenance")
    else {
        return;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)? != 0,
        ))
    }) else {
        return;
    };
    let map: HashMap<(String, String), (String, bool)> = rows
        .flatten()
        .map(|(agent, path, source, internal)| ((agent, path), (source, internal)))
        .collect();
    for session in sessions {
        // 规范化结果随 ScanResult 缓存一轮；缓存外路径（理论上不会出现）现算兜底
        let path = norm_paths
            .get(&session.project_path)
            .cloned()
            .unwrap_or_else(|| crate::usage::normalize_provenance_path(&session.project_path));
        if let Some((source, internal)) = map.get(&(session.agent.clone(), path)) {
            session.source.clone_from(source);
            session.internal = session.internal || *internal;
        } else if crate::usage::is_ccode_ai_temp_cwd(&session.project_path) {
            session.source = "ccode-ai".into();
            session.internal = true;
        }
    }
}

pub(crate) fn list_sessions_sync() -> Vec<SessionMetaDto> {
    let scan = cached_scan();
    let mut sessions = scan.sessions;
    if let Ok(conn) = open_db() {
        let meta = read_all_meta(&conn);
        apply_meta(&mut sessions, &scan.chain_members, &meta);
        apply_provenance(&conn, &mut sessions, &scan.provenance_paths);
        crate::handoff::apply_handoff(&conn, &mut sessions);
        apply_card_claims(&conn, &mut sessions);
        apply_step_claims(&conn, &mut sessions);
    }
    apply_task_names(&mut sessions);
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    redact_session_meta(&mut sessions);
    sessions
}

#[tauri::command]
pub async fn list_sessions() -> Vec<SessionMetaDto> {
    // cached_scan 是 CPU 密集的全量扫描，移出 async worker（10s 缓存命中时也走这里，开销可忽略）
    tauri::async_runtime::spawn_blocking(list_sessions_sync)
        .await
        .unwrap_or_default()
}

#[derive(Clone)]
struct SessionClaimContext {
    agent: String,
    project_path: String,
    since_iso: String,
    excluded: HashSet<String>,
}

#[derive(Default)]
struct SessionClaimRegistry {
    contexts: HashMap<String, SessionClaimContext>,
    assignments: HashMap<String, (String, String)>,
    /// 本次应用进程内已分配过的会话不再复用，避免先启动的标签关闭后被另一个并发标签误领。
    used_sessions: HashSet<(String, String)>,
}

static SESSION_CLAIMS: OnceLock<Mutex<SessionClaimRegistry>> = OnceLock::new();

fn session_claims() -> &'static Mutex<SessionClaimRegistry> {
    SESSION_CLAIMS.get_or_init(|| Mutex::new(SessionClaimRegistry::default()))
}

fn link_project_path(cwd: &str) -> String {
    let cwd = expand_tilde(cwd);
    resolve_worktree_project(&cwd, &crate::workspaces::worktree_rows())
        .map(|(repo, _)| repo)
        .unwrap_or(cwd)
}

/// 无固定 session id 的 CLI 在进程启动前登记，记录当时已有会话，避免误绑旧记录。
pub(crate) fn register_session_claim(claim_id: &str, agent: &str, cwd: &str) {
    let project_path = link_project_path(cwd);
    // 启动命令是同步路径，只读取已有缓存，禁止为关联声明阻塞扫描数百个历史文件。
    let excluded = recent_cached_scan()
        .unwrap_or_default()
        .sessions
        .into_iter()
        .filter(|session| {
            session.agent == agent && crate::paths::same_path(&session.project_path, &project_path)
        })
        .map(|session| session.session_id)
        .collect();
    let mut registry = session_claims().lock().unwrap();
    if let Some(assignment) = registry.assignments.remove(claim_id) {
        registry.used_sessions.insert(assignment);
    }
    registry.contexts.insert(
        claim_id.to_string(),
        SessionClaimContext {
            agent: agent.to_string(),
            project_path,
            since_iso: now_iso(),
            excluded,
        },
    );
}

pub(crate) fn rewrite_session_profile_ids(rewrites: &[(String, String)]) -> Result<(), String> {
    let conn = open_db()?;
    for (from, to) in rewrites {
        conn.execute(
            "UPDATE session_meta SET profile_id=?1 WHERE profile_id=?2",
            params![to, from],
        )
        .map_err(|e| e.to_string())?;
    }
    invalidate_scan_cache();
    Ok(())
}

pub(crate) fn set_session_profile(
    agent: &str,
    session_id: &str,
    profile_id: &str,
) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, profile_id) VALUES(?1, ?2, ?3)
         ON CONFLICT(agent, session_id) DO UPDATE SET profile_id=?3",
        params![agent, session_id, profile_id],
    )
    .map_err(|e| format!("写入会话连接归属失败: {e}"))?;
    invalidate_scan_cache();
    Ok(())
}

#[tauri::command]
pub fn set_session_profile_command(
    agent: String,
    session_id: String,
    profile_id: String,
) -> Result<(), String> {
    set_session_profile(&agent, &session_id, &profile_id)
}

pub(crate) fn release_session_claim_impl(claim_id: &str) {
    let mut registry = session_claims().lock().unwrap();
    registry.contexts.remove(claim_id);
    if let Some(assignment) = registry.assignments.remove(claim_id) {
        registry.used_sessions.insert(assignment);
    }
}

/// 同 agent+目录的并发启动统一排序后分配；候选不足时宁可继续等待，也不抢占同一会话。
#[tauri::command]
pub async fn claim_session_for(claim_id: String) -> Option<SessionMetaDto> {
    let scan = tauri::async_runtime::spawn_blocking(cached_scan)
        .await
        .ok()?;
    let mut registry = session_claims().lock().ok()?;
    let context = registry.contexts.get(&claim_id)?.clone();

    if let Some((agent, session_id)) = registry.assignments.get(&claim_id).cloned() {
        let mut found = scan
            .sessions
            .into_iter()
            .find(|session| session.agent == agent && session.session_id == session_id);
        if let Some(session) = &mut found {
            redact_session_meta(std::slice::from_mut(session));
        }
        return found;
    }

    let mut pending: Vec<(String, SessionClaimContext)> = registry
        .contexts
        .iter()
        .filter(|(id, candidate)| {
            !registry.assignments.contains_key(*id)
                && candidate.agent == context.agent
                && crate::paths::same_path(&candidate.project_path, &context.project_path)
        })
        .map(|(id, candidate)| (id.clone(), candidate.clone()))
        .collect();
    pending.sort_by(|a, b| a.1.since_iso.cmp(&b.1.since_iso).then(a.0.cmp(&b.0)));

    let mut already_assigned = registry.used_sessions.clone();
    already_assigned.extend(registry.assignments.values().cloned());
    let mut candidates: Vec<SessionMetaDto> = scan
        .sessions
        .into_iter()
        .filter(|session| {
            session.agent == context.agent
                && crate::paths::same_path(&session.project_path, &context.project_path)
                && !already_assigned.contains(&(session.agent.clone(), session.session_id.clone()))
        })
        .collect();
    candidates.sort_by(|a, b| {
        a.created_at
            .as_deref()
            .unwrap_or(a.updated_at.as_deref().unwrap_or(""))
            .cmp(
                b.created_at
                    .as_deref()
                    .unwrap_or(b.updated_at.as_deref().unwrap_or("")),
            )
            .then(a.session_id.cmp(&b.session_id))
    });

    let mut staged: Vec<(String, String)> = Vec::new();
    let mut used = HashSet::new();
    for (id, pending_context) in &pending {
        let Some(candidate) = candidates.iter().find(|session| {
            !used.contains(&session.session_id)
                && !pending_context.excluded.contains(&session.session_id)
                && session.updated_at.as_deref().unwrap_or("") >= pending_context.since_iso.as_str()
        }) else {
            invalidate_scan_cache();
            return None;
        };
        used.insert(candidate.session_id.clone());
        staged.push((id.clone(), candidate.session_id.clone()));
    }
    for (id, session_id) in staged {
        let assignment = (context.agent.clone(), session_id);
        registry.used_sessions.insert(assignment.clone());
        registry.assignments.insert(id, assignment);
    }
    let (_, session_id) = registry.assignments.get(&claim_id)?.clone();
    drop(registry);
    let mut found = candidates
        .into_iter()
        .find(|session| session.session_id == session_id);
    if let Some(session) = &mut found {
        redact_session_meta(std::slice::from_mut(session));
    }
    found
}

#[tauri::command]
pub fn release_session_claim(claim_id: String) {
    release_session_claim_impl(&claim_id);
}

/// 注意力标记 v1（§6.11）：读会话文件尾部分类 done/working/confirm/unknown
#[tauri::command]
pub async fn session_tail_state(agent: String, file_path: String) -> String {
    tauri::async_runtime::spawn_blocking(move || tail_state_impl(&agent, &file_path))
        .await
        .unwrap_or_else(|_| "unknown".into())
}

#[tauri::command]
pub async fn get_session_conversation(agent: String, file_path: String) -> Vec<ChatMessageDto> {
    conversation_impl(&agent, &file_path)
}

const CONVERSATION_PAGE_BYTES: u64 = 192 * 1024;
/// 一页解析不出对话时继续往前扫的上限（Codex 工具行经常 >192KB，空窗必须连跳）。
const CONVERSATION_PAGE_SCAN_LIMIT: u64 = CONVERSATION_PAGE_BYTES * 24;
const OPENCODE_PAGE_MESSAGES: usize = 80;

pub(crate) fn parse_session_lines(agent: &str, lines: &[String]) -> Vec<ChatMessageDto> {
    match agent {
        "codex" => parse_codex(lines),
        "gemini" => parse_gemini(lines),
        "qwen" => parse_qwen(lines),
        "kimi" => {
            if kimi_looks_like_wire(lines) {
                parse_kimi(lines)
            } else {
                parse_kimi_legacy(lines)
            }
        }
        "codebuddy" => parse_codebuddy(lines),
        "cursor" => parse_cursor(lines),
        "grok" => parse_grok(lines),
        _ => parse_claude(lines),
    }
}

/// `[0, pos)` 里最后一个换行的偏移；没有则 None。
fn jsonl_last_newline_before(file: &mut fs::File, pos: u64) -> Result<Option<u64>, String> {
    if pos == 0 {
        return Ok(None);
    }
    const CHUNK: u64 = 64 * 1024;
    let mut from = pos;
    loop {
        let start = from.saturating_sub(CHUNK);
        let len = (from - start) as usize;
        file.seek(SeekFrom::Start(start))
            .map_err(|e| format!("定位会话失败: {e}"))?;
        let mut buf = vec![0u8; len];
        file.read_exact(&mut buf)
            .map_err(|e| format!("读取会话失败: {e}"))?;
        if let Some(index) = buf.iter().rposition(|&byte| byte == b'\n') {
            return Ok(Some(start + index as u64));
        }
        if start == 0 {
            return Ok(None);
        }
        from = start;
    }
}

/// 含 `pos` 的那条 JSONL 的起点（`pos` 为行界时即 `pos` 本身）。
fn jsonl_line_start(file: &mut fs::File, pos: u64) -> Result<u64, String> {
    Ok(jsonl_last_newline_before(file, pos)?
        .map(|offset| offset + 1)
        .unwrap_or(0))
}

/// 以 `end` 为排他终点的上一条 JSONL 起点。用来整行跳过超过窗口的记录。
fn jsonl_prev_record_start(file: &mut fs::File, end: u64) -> Result<u64, String> {
    if end == 0 {
        return Ok(0);
    }
    jsonl_line_start(file, end - 1)
}

struct JsonlWindow {
    lines: Vec<String>,
    /// 下一页的 `before`；None = 已经到文件头
    cursor: Option<u64>,
}

fn read_jsonl_window(file: &mut fs::File, start: u64, end: u64) -> Result<JsonlWindow, String> {
    let end = end.max(start);
    if end == 0 || start == end {
        return Ok(JsonlWindow {
            lines: Vec::new(),
            cursor: None,
        });
    }
    let mut previous = None;
    if start > 0 {
        file.seek(SeekFrom::Start(start - 1))
            .map_err(|e| format!("定位会话失败: {e}"))?;
        let mut byte = [0u8; 1];
        file.read_exact(&mut byte)
            .map_err(|e| format!("读取会话失败: {e}"))?;
        previous = Some(byte[0]);
    }
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("定位会话失败: {e}"))?;
    let mut bytes = vec![0u8; (end - start) as usize];
    file.read_exact(&mut bytes)
        .map_err(|e| format!("读取会话失败: {e}"))?;

    let (from, page_start) = if start == 0 || previous == Some(b'\n') {
        (0usize, start)
    } else if let Some(index) = bytes.iter().position(|&byte| byte == b'\n') {
        (index + 1, start + index as u64 + 1)
    } else {
        // 整窗落在一行中间：本页无完整记录，cursor 跳到该行起点
        let rec = jsonl_line_start(file, start)?;
        return Ok(JsonlWindow {
            lines: Vec::new(),
            cursor: (rec < end).then_some(rec),
        });
    };

    if page_start >= end {
        // 窗内唯一换行就是终点：那是超长行的行尾，整行跳过
        let rec = jsonl_prev_record_start(file, end)?;
        return Ok(JsonlWindow {
            lines: Vec::new(),
            cursor: (rec < end).then_some(rec),
        });
    }

    let lines = to_lines(&String::from_utf8_lossy(&bytes[from..]));
    let cursor = if page_start == 0 {
        None
    } else {
        let rec_start = jsonl_prev_record_start(file, page_start)?;
        let rec_len = page_start.saturating_sub(rec_start);
        // 紧邻的上一条已经比窗口大：一次跳过整行，避免 cursor 钉在行尾死循环
        let next = if rec_len > CONVERSATION_PAGE_BYTES {
            rec_start
        } else {
            page_start
        };
        (next < end).then_some(next)
    };
    Ok(JsonlWindow { lines, cursor })
}

fn plain_conversation_page(
    agent: &str,
    path: &Path,
    before: Option<u64>,
    around: Option<u64>,
) -> Result<ConversationPageDto, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("读取会话失败: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("读取会话信息失败: {e}"))?
        .len();
    if let Some(at) = around {
        let half = CONVERSATION_PAGE_BYTES / 2;
        let mut start = at.saturating_sub(half);
        let mut end = at.saturating_add(half).min(len);
        if end.saturating_sub(start) < CONVERSATION_PAGE_BYTES {
            start = end.saturating_sub(CONVERSATION_PAGE_BYTES);
        }
        if end.saturating_sub(start) < CONVERSATION_PAGE_BYTES {
            end = (start + CONVERSATION_PAGE_BYTES).min(len);
        }
        let win = read_jsonl_window(&mut file, start, end)?;
        let mut messages = parse_session_lines(agent, &win.lines);
        redact_conversation(&mut messages);
        return Ok(ConversationPageDto {
            messages,
            cursor: win.cursor,
        });
    }

    let mut end = before.unwrap_or(len).min(len);
    let mut lines: Vec<String> = Vec::new();
    let mut scanned = 0u64;
    loop {
        let start = end.saturating_sub(CONVERSATION_PAGE_BYTES);
        let win = read_jsonl_window(&mut file, start, end)?;
        let mut combined = win.lines;
        combined.append(&mut lines);
        lines = combined;
        scanned = scanned.saturating_add(CONVERSATION_PAGE_BYTES);
        let mut messages = parse_session_lines(agent, &lines);
        if !messages.is_empty() || win.cursor.is_none() || scanned >= CONVERSATION_PAGE_SCAN_LIMIT {
            redact_conversation(&mut messages);
            return Ok(ConversationPageDto {
                messages,
                cursor: win.cursor,
            });
        }
        let next = win.cursor.unwrap();
        if next >= end {
            redact_conversation(&mut messages);
            return Ok(ConversationPageDto {
                messages,
                cursor: None,
            });
        }
        end = next;
    }
}

fn opencode_conversation_page(
    db_path: &Path,
    session_id: &str,
    before: Option<u64>,
    around: Option<u64>,
) -> Result<ConversationPageDto, String> {
    let conn = open_opencode_db(db_path).ok_or("OpenCode 数据库不可读")?;
    let sid = session_id.to_string();
    let before_i64 = before.map(|value| value.min(i64::MAX as u64) as i64);
    let (message_rows, cursor) = if let Some(at) = around {
        let at_i = at.min(i64::MAX as u64) as i64;
        let mut older: Vec<DbRow> = query_rows(
            &conn,
            "SELECT * FROM message WHERE session_id=? AND time_created<=? ORDER BY time_created DESC LIMIT 40",
            &[&sid, &at_i],
        )
        .into_iter()
        .map(|row| DbRow { names: row.0, vals: row.1 })
        .collect();
        let newer: Vec<DbRow> = query_rows(
            &conn,
            "SELECT * FROM message WHERE session_id=? AND time_created>? ORDER BY time_created ASC LIMIT 40",
            &[&sid, &at_i],
        )
        .into_iter()
        .map(|row| DbRow { names: row.0, vals: row.1 })
        .collect();
        let cursor = if older.len() == 40 {
            older
                .last()
                .and_then(|row| row.as_i64("time_created"))
                .filter(|time| *time >= 0)
                .map(|time| time as u64)
        } else {
            None
        };
        older.reverse();
        older.extend(newer);
        (older, cursor)
    } else {
        let rows = if let Some(before) = before_i64 {
            query_rows(&conn, "SELECT * FROM message WHERE session_id=? AND time_created<? ORDER BY time_created DESC LIMIT 80", &[&sid, &before])
        } else {
            query_rows(
                &conn,
                "SELECT * FROM message WHERE session_id=? ORDER BY time_created DESC LIMIT 80",
                &[&sid],
            )
        };
        let mut message_rows: Vec<DbRow> = rows
            .into_iter()
            .map(|row| DbRow {
                names: row.0,
                vals: row.1,
            })
            .collect();
        let cursor = if message_rows.len() == OPENCODE_PAGE_MESSAGES {
            message_rows
                .last()
                .and_then(|row| row.as_i64("time_created"))
                .filter(|time| *time >= 0)
                .map(|time| time as u64)
        } else {
            None
        };
        message_rows.reverse();
        (message_rows, cursor)
    };
    let ids: Vec<String> = message_rows
        .iter()
        .filter_map(|row| row.as_str("id"))
        .collect();
    let mut parts_by_msg: HashMap<String, Vec<Value>> = HashMap::new();
    if !ids.is_empty() {
        let placeholders = (0..ids.len()).map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT * FROM part WHERE message_id IN ({placeholders}) ORDER BY time_created ASC"
        );
        let params: Vec<&dyn rusqlite::ToSql> =
            ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        for row in query_rows(&conn, &sql, &params) {
            let row = DbRow {
                names: row.0,
                vals: row.1,
            };
            let (Some(message_id), Some(data)) = (row.as_str("message_id"), row.as_str("data"))
            else {
                continue;
            };
            if let Ok(value) = serde_json::from_str::<Value>(&data) {
                parts_by_msg.entry(message_id).or_default().push(value);
            }
        }
    }
    let mut messages = Vec::new();
    for row in message_rows {
        let Some(data) = row.as_str("data") else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        let parts = row
            .as_str("id")
            .and_then(|id| parts_by_msg.remove(&id))
            .unwrap_or_default();
        if let Some(message) =
            opencode_message(&value, parts.iter().collect(), row.as_i64("time_created"))
        {
            messages.push(message);
        }
    }
    redact_conversation(&mut messages);
    Ok(ConversationPageDto { messages, cursor })
}

fn grok_conversation_page(path: &Path, before: Option<u64>) -> Option<ConversationPageDto> {
    let mut messages = grok_history_messages(path)?;
    const PAGE: usize = OPENCODE_PAGE_MESSAGES;
    let end = before
        .map(|value| (value as usize).min(messages.len()))
        .unwrap_or(messages.len());
    let start = end.saturating_sub(PAGE);
    let cursor = (start > 0).then_some(start as u64);
    messages = messages[start..end].to_vec();
    redact_conversation(&mut messages);
    Some(ConversationPageDto { messages, cursor })
}

pub(crate) fn conversation_page_impl(
    agent: &str,
    file_path: &str,
    before: Option<u64>,
    around: Option<u64>,
) -> Result<ConversationPageDto, String> {
    if agent == "opencode" {
        if let Some((db, sid)) = file_path.split_once('#') {
            if Path::new(db).exists() {
                return opencode_conversation_page(Path::new(db), sid, before, around);
            }
        }
        let mut messages = conversation_impl_raw(agent, file_path);
        let from = messages.len().saturating_sub(OPENCODE_PAGE_MESSAGES);
        messages.drain(..from);
        redact_conversation(&mut messages);
        return Ok(ConversationPageDto {
            messages,
            cursor: None,
        });
    }
    let source = PathBuf::from(file_path);
    let path = if source.exists() {
        source
    } else {
        find_snapshot(agent, &source).ok_or("会话文件已不存在，且没有可用快照")?
    };
    if agent == "grok" {
        if let Some(page) = grok_conversation_page(&path, before) {
            return Ok(page);
        }
    }
    let mut magic = [0u8; 4];
    let compressed = fs::File::open(&path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .is_ok()
        && magic == ZSTD_MAGIC;
    if compressed {
        if let Some(at) = around {
            return zstd_conversation_window(agent, &path, at);
        }
        let (head, tail) =
            read_head_tail(&path, CONVERSATION_PAGE_BYTES as usize).ok_or("压缩会话不可读")?;
        let lines = if tail.is_empty() { head } else { tail };
        let mut messages = parse_session_lines(agent, &lines);
        let from = messages.len().saturating_sub(OPENCODE_PAGE_MESSAGES);
        messages.drain(..from);
        redact_conversation(&mut messages);
        return Ok(ConversationPageDto {
            messages,
            cursor: None,
        });
    }
    plain_conversation_page(agent, &path, before, around)
}

/// zstd 不能按压缩文件偏移 seek；从流开头解到目标附近，取出一窗。不可再向前翻页。
fn zstd_conversation_window(
    agent: &str,
    path: &Path,
    around: u64,
) -> Result<ConversationPageDto, String> {
    use std::io::Read;
    let file = fs::File::open(path).map_err(|e| format!("读取会话失败: {e}"))?;
    let mut dec =
        zstd::stream::read::Decoder::new(file).map_err(|e| format!("解压会话失败: {e}"))?;
    let half = CONVERSATION_PAGE_BYTES as u64 / 2;
    let win_start = around.saturating_sub(half);
    let win_end = around.saturating_add(half);
    let mut buf = [0u8; 65536];
    let mut total = 0u64;
    let mut window = Vec::new();
    loop {
        match dec.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let chunk_start = total;
                let chunk_end = total + n as u64;
                total = chunk_end;
                if chunk_end <= win_start {
                    continue;
                }
                if chunk_start >= win_end && !window.is_empty() {
                    break;
                }
                let from = if chunk_start < win_start {
                    (win_start - chunk_start) as usize
                } else {
                    0
                };
                let to = if chunk_end > win_end {
                    (win_end - chunk_start) as usize
                } else {
                    n
                };
                let from = from.min(n);
                let to = to.min(n).max(from);
                window.extend_from_slice(&buf[from..to]);
            }
        }
    }
    let lines = to_lines(&String::from_utf8_lossy(&window));
    let mut messages = parse_session_lines(agent, &lines);
    redact_conversation(&mut messages);
    Ok(ConversationPageDto {
        messages,
        cursor: None,
    })
}

/// 长会话按尾部窗口分页读取；终端只取最近消息，会话页可按 cursor 向前加载。
/// `around` 为搜索命中位置：jsonl 是文件（或解压流）字节偏移，OpenCode 是 time_created。
#[tauri::command]
pub async fn get_session_conversation_page(
    agent: String,
    file_path: String,
    before: Option<u64>,
    around: Option<u64>,
) -> Result<ConversationPageDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        conversation_page_impl(&agent, &file_path, before, around)
    })
    .await
    .map_err(|e| format!("读取会话分页失败: {e}"))?
}

/// 会话全文解析（get_session_conversation 与 ai_summarize_session 共用）
pub(crate) fn conversation_impl(agent: &str, file_path: &str) -> Vec<ChatMessageDto> {
    let mut messages = conversation_impl_raw(agent, file_path);
    redact_conversation(&mut messages);
    messages
}

pub(crate) fn conversation_impl_raw(agent: &str, file_path: &str) -> Vec<ChatMessageDto> {
    if agent == "opencode" {
        // "<db路径>#<session_id>"：db 在就直接读库；db 不在了读 pin 快照
        if let Some((db, sid)) = file_path.split_once('#') {
            if Path::new(db).exists() {
                return opencode_parse_db(Path::new(db), sid);
            }
            return snapshot_json_path("opencode", sid)
                .filter(|p| p.exists())
                .and_then(|p| read_json_file(&p))
                .map(|v| opencode_parse_snapshot(&v))
                .unwrap_or_default();
        }
        // 快照导出 JSON（含 messages 键）或 legacy session JSON
        let path = PathBuf::from(&file_path);
        let Some(v) = read_json_file(&path) else {
            return Vec::new();
        };
        if v.get("messages").is_some() {
            return opencode_parse_snapshot(&v);
        }
        return opencode_parse_legacy(&path);
    }
    let path = PathBuf::from(&file_path);
    if agent == "grok" && path.exists() {
        if let Some(messages) = grok_history_messages(&path) {
            return messages;
        }
    }
    let bytes = read_session_bytes(&path)
        .or_else(|| find_snapshot(&agent, &path).and_then(|p| read_session_bytes(&p)));
    let Some(bytes) = bytes else {
        return Vec::new();
    };
    let lines = to_lines(&String::from_utf8_lossy(&bytes));
    parse_session_lines(agent, &lines)
}

// ===== 导出 Markdown =====

/// 文件名安全化：过滤各平台非法字符与路径分隔符/控制字符，限长，空则兜底
fn sanitize_export_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        return "session".into();
    }
    trimmed.chars().take(60).collect()
}

/// 代码围栏长度取内容中最长反引号串 +1（最少 3），防内容里的 ``` 提前闭合围栏
fn fence_for(text: &str) -> String {
    let mut max_run = 0usize;
    let mut run = 0usize;
    for c in text.chars() {
        if c == '`' {
            run += 1;
            max_run = max_run.max(run);
        } else {
            run = 0;
        }
    }
    "`".repeat((max_run + 1).max(3))
}

/// 会话渲染为 Markdown：标题/时间/agent 信息头 + 对话正文，工具调用与思考折叠为代码块
pub(crate) fn render_markdown(
    agent: &str,
    session_id: &str,
    title: &str,
    msgs: &[ChatMessageDto],
) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {title}\n\n"));
    out.push_str(&format!("- Agent: {agent}\n"));
    out.push_str(&format!("- Session: {session_id}\n"));
    let first_ts = msgs.iter().find_map(|m| m.timestamp.clone());
    let last_ts = msgs.iter().rev().find_map(|m| m.timestamp.clone());
    if let Some(t0) = &first_ts {
        let range = match &last_ts {
            Some(t1) if t1 != t0 => format!("{t0} → {t1}"),
            _ => t0.clone(),
        };
        out.push_str(&format!("- 时间: {range}\n"));
    }
    out.push_str(&format!("- 消息数: {}\n\n---\n", msgs.len()));

    for m in msgs {
        let role = if m.role == "user" { "用户" } else { "助手" };
        let ts = m
            .timestamp
            .as_deref()
            .map(|t| format!(" · {t}"))
            .unwrap_or_default();
        out.push_str(&format!("\n## {role}{ts}\n"));
        for b in &m.blocks {
            match b.kind.as_str() {
                "text" => out.push_str(&format!("\n{}\n", b.text)),
                "thinking" => {
                    let f = fence_for(&b.text);
                    out.push_str(&format!("\n**思考**\n\n{f}text\n{}\n{f}\n", b.text));
                }
                "tool_use" => {
                    let name = b.tool_name.as_deref().unwrap_or("tool");
                    let f = fence_for(&b.text);
                    out.push_str(&format!("\n**工具调用: {name}**\n\n{f}\n{}\n{f}\n", b.text));
                }
                "tool_result" => {
                    let f = fence_for(&b.text);
                    out.push_str(&format!("\n**工具结果**\n\n{f}\n{}\n{f}\n", b.text));
                }
                // 未知块类型防御式跳过（解析器随 CLI 版本漂移）
                _ => {}
            }
        }
        if let Some(u) = &m.usage {
            out.push_str(&format!(
                "\n<sub>tokens: ↑{} ↓{}</sub>\n",
                u.input, u.output
            ));
        }
    }
    out
}

/// 导出当前会话为 Markdown 到 ~/Downloads/ccode-exports/，返回导出文件路径
#[tauri::command]
pub async fn export_session_markdown(
    agent: String,
    session_id: String,
    file_path: String,
    title: String,
) -> Result<String, String> {
    // 解析+渲染是阻塞 IO/CPU，移出 async worker 防卡 UI
    tauri::async_runtime::spawn_blocking(move || {
        export_session_markdown_impl(&agent, &session_id, &file_path, &title)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn export_session_markdown_impl(
    agent: &str,
    session_id: &str,
    file_path: &str,
    title: &str,
) -> Result<String, String> {
    let msgs = conversation_impl(agent, file_path);
    if msgs.is_empty() {
        return Err("会话没有可导出的内容".into());
    }
    let title = redact_sensitive_text(title);
    let md = render_markdown(agent, session_id, &title, &msgs);
    let downloads = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .ok_or("无法确定下载目录")?;
    let dir = downloads.join("ccode-exports");
    fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败: {e}"))?;
    let id8: String = session_id.chars().take(8).collect();
    let path = dir.join(format!("{}-{id8}.md", sanitize_export_name(&title)));
    fs::write(&path, md).map_err(|e| format!("写入导出文件失败: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn pin_session(
    agent: String,
    session_id: String,
    file_path: String,
) -> Result<(), String> {
    // 复制快照/导出 opencode 库行是阻塞 IO，移出 async worker
    tauri::async_runtime::spawn_blocking(move || pin_session_impl(&agent, &session_id, &file_path))
        .await
        .map_err(|e| e.to_string())?
}

fn infer_pin_project_path(agent: &str, session_id: &str) -> Option<String> {
    cached_scan()
        .sessions
        .iter()
        .find(|s| s.agent == agent && s.session_id == session_id)
        .map(|s| s.project_path.clone())
        .filter(|p| !p.is_empty() && p != "已固定")
}

fn pin_session_impl(agent: &str, session_id: &str, file_path: &str) -> Result<(), String> {
    if agent == "opencode" {
        // OpenCode 没有单会话文件：从共享 db 导出自包含 JSON 快照
        let Some((db, sid)) = file_path.split_once('#') else {
            return Err("OpenCode 会话定位格式应为 <db路径>#<session_id>".into());
        };
        let data = opencode_export_session(Path::new(db), sid)?;
        let dst = snapshot_json_path(agent, sid).ok_or("无法确定平台配置目录")?;
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建快照目录失败: {e}"))?;
        }
        let text = serde_json::to_string(&data).map_err(|e| e.to_string())?;
        fs::write(&dst, text).map_err(|e| format!("写入快照失败: {e}"))?;
        let conn = open_db()?;
        conn.execute(
            "INSERT INTO session_meta(agent, session_id, pinned, pinned_at, project_path) VALUES(?1, ?2, 1, ?3, ?4)
             ON CONFLICT(agent, session_id) DO UPDATE SET pinned=1, pinned_at=?3, project_path=COALESCE(excluded.project_path, session_meta.project_path)",
            params![agent, session_id, now_iso(), infer_pin_project_path(agent, session_id)],
        )
        .map_err(|e| format!("写入 session_meta 失败: {e}"))?;
        invalidate_scan_cache();
        return Ok(());
    }
    let src = PathBuf::from(file_path);
    if !src.exists() {
        return Err("源会话文件已不存在，无法 pin".into());
    }
    let dst = snapshot_path(agent, session_id, file_path.ends_with(".zst"))
        .ok_or("无法确定平台配置目录")?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建快照目录失败: {e}"))?;
    }
    fs::copy(&src, &dst).map_err(|e| format!("复制快照失败: {e}"))?;
    let conn = open_db()?;
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, pinned, pinned_at, project_path) VALUES(?1, ?2, 1, ?3, ?4)
         ON CONFLICT(agent, session_id) DO UPDATE SET pinned=1, pinned_at=?3, project_path=COALESCE(excluded.project_path, session_meta.project_path)",
        params![agent, session_id, now_iso(), infer_pin_project_path(agent, session_id)],
    )
    .map_err(|e| format!("写入 session_meta 失败: {e}"))?;
    invalidate_scan_cache();
    Ok(())
}

#[tauri::command]
pub fn unpin_session(
    agent: String,
    session_id: String,
    delete_snapshot: bool,
) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute(
        "UPDATE session_meta SET pinned=0 WHERE agent=?1 AND session_id=?2",
        params![agent, session_id],
    )
    .map_err(|e| format!("更新 session_meta 失败: {e}"))?;
    if delete_snapshot {
        for p in snapshot_candidates(&agent, &session_id) {
            if p.exists() {
                let _ = fs::remove_file(p);
            }
        }
    }
    invalidate_scan_cache();
    Ok(())
}

#[tauri::command]
pub fn set_session_meta(
    agent: String,
    session_id: String,
    custom_title: Option<String>,
    tags: Vec<String>,
    archived: bool,
) -> Result<(), String> {
    let conn = open_db()?;
    let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?;
    let title_source = custom_title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|_| "user");
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, custom_title, tags, archived, title_source)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(agent, session_id) DO UPDATE SET custom_title=?3, tags=?4, archived=?5, title_source=?6",
        params![agent, session_id, custom_title, tags_json, archived, title_source],
    )
    .map_err(|e| format!("写入 session_meta 失败: {e}"))?;
    // 归档/标题/标签只在 sqlite；list 经 apply_meta 覆盖。不要清扫描缓存——
    // 否则前端一等 list_sessions 就要重扫九家会话文件，归档会卡一下。
    Ok(())
}

/// 无头/内部会话按 id 标记后，自动起名要跳过。
pub(crate) fn session_marked_internal(agent: &str, session_id: &str) -> bool {
    let Ok(conn) = open_db() else {
        return false;
    };
    conn.query_row(
        "SELECT internal FROM session_meta WHERE agent=?1 AND session_id=?2",
        params![agent, session_id],
        |r| r.get::<_, i64>(0),
    )
    .ok()
    .is_some_and(|v| v != 0)
}

/// 自动起名写入。人手改过的标题（title_source=user）不覆盖；机器临时标题可被聊完校正覆盖。
/// 返回是否写入。
pub(crate) fn try_set_custom_title(
    agent: &str,
    session_id: &str,
    title: &str,
) -> Result<bool, String> {
    let title = title.trim();
    if title.is_empty() {
        return Ok(false);
    }
    let conn = open_db()?;
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT custom_title, title_source FROM session_meta WHERE agent=?1 AND session_id=?2",
            params![agent, session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    if let Some((existing, source)) = row {
        if source.as_deref() == Some("user") {
            return Ok(false);
        }
        // 旧数据没有 title_source：有标题就当人改过的，避免自动起名盖掉已整理的历史标题
        if source.is_none() && existing.as_deref().is_some_and(|t| !t.trim().is_empty()) {
            return Ok(false);
        }
    }
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, custom_title, title_source)
         VALUES(?1, ?2, ?3, 'auto')
         ON CONFLICT(agent, session_id) DO UPDATE SET custom_title=?3, title_source='auto'
         WHERE session_meta.title_source IS NULL OR session_meta.title_source != 'user'",
        params![agent, session_id, title],
    )
    .map_err(|e| format!("写入会话标题失败: {e}"))?;
    invalidate_scan_cache();
    Ok(true)
}

/// 其它会话已占用的展示标题（不含本条），供自动起名去重。
pub(crate) fn list_custom_titles_except(agent: &str, session_id: &str) -> Vec<String> {
    let Ok(conn) = open_db() else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT custom_title FROM session_meta
         WHERE custom_title IS NOT NULL AND TRIM(custom_title) != ''
           AND NOT (agent = ?1 AND session_id = ?2)",
    ) else {
        return Vec::new();
    };
    stmt.query_map(params![agent, session_id], |r| r.get::<_, String>(0))
        .map(|rows| {
            rows.flatten()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// 人手改过的标题，或旧数据没有 title_source 但已有自定义标题：自动起名不得覆盖。
pub(crate) fn session_title_is_user_owned(agent: &str, session_id: &str) -> bool {
    let Ok(conn) = open_db() else {
        return true;
    };
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT custom_title, title_source FROM session_meta WHERE agent=?1 AND session_id=?2",
            params![agent, session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    match row {
        None => false,
        Some((existing, source)) => {
            if source.as_deref() == Some("user") {
                return true;
            }
            source.is_none() && existing.as_deref().is_some_and(|t| !t.trim().is_empty())
        }
    }
}

/// 会话归卡（任务卡）：写 session_meta.task_id；None 或空白 = 移出卡片。
/// 只存 id，卡片名在列表时按项目档案卡回填（卡片改名/删除不需要回写这里）。
#[tauri::command]
pub fn assign_session_task(
    agent: String,
    session_id: String,
    task_id: Option<String>,
) -> Result<(), String> {
    let conn = open_db()?;
    assign_session_task_at(&conn, &agent, &session_id, task_id.as_deref())
}

pub(crate) fn assign_session_task_at(
    conn: &Connection,
    agent: &str,
    session_id: &str,
    task_id: Option<&str>,
) -> Result<(), String> {
    let task_id = task_id
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, task_id) VALUES(?1, ?2, ?3)
         ON CONFLICT(agent, session_id) DO UPDATE SET task_id=?3",
        params![agent, session_id, task_id],
    )
    .map_err(|e| format!("写入 session_meta 失败: {e}"))?;
    Ok(())
}

/// 删除任务卡时顺带清空该卡片的会话归卡标记（卡片没了，会话不应再挂着失效 id）
pub(crate) fn clear_task_assignment(conn: &Connection, task_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE session_meta SET task_id=NULL WHERE task_id=?1",
        params![task_id],
    )
    .map_err(|e| format!("清理会话归卡标记失败: {e}"))?;
    Ok(())
}

// ===== 卡片认领（仿 handoff_links 两阶段登记）：从卡片发起聊天时登记
// 「该 agent 在该 cwd 的下一个新会话属于此卡」，列表扫描到后固化进 session_meta.task_id 并消费，
// 登记只生效一次（消费即失效），同目录之后更新的会话不再被误归 =====

pub(crate) fn ensure_card_claim_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS card_claims(
          agent TEXT NOT NULL, cwd TEXT NOT NULL, task_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(agent, cwd));",
    )
    .map_err(|e| format!("初始化 card_claims 表失败: {e}"))
}

/// 卡片发起聊天前登记认领（聊想法/开工/继续共用）；同 agent+cwd 重复登记覆盖（以最后一次发起为准）。
/// 登记不设过期：很久之后才产生的新会话也能命中（靠 created_at 时间口径排除登记前的旧会话）。
#[tauri::command]
pub fn claim_next_session_for_card(
    agent: String,
    cwd: String,
    task_id: String,
) -> Result<(), String> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Err("卡片 id 不能为空".into());
    }
    let conn = open_db()?;
    ensure_card_claim_table(&conn)?;
    conn.execute(
        "INSERT INTO card_claims(agent, cwd, task_id, created_at) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(agent, cwd) DO UPDATE SET task_id=?3, created_at=?4",
        params![agent, cwd, task_id, now_iso()],
    )
    .map_err(|e| format!("登记卡片认领失败: {e}"))?;
    Ok(())
}

struct CardClaim {
    agent: String,
    cwd: String,
    task_id: String,
    created_at: String,
}

fn read_card_claims(conn: &Connection) -> Vec<CardClaim> {
    let Ok(mut stmt) = conn.prepare("SELECT agent, cwd, task_id, created_at FROM card_claims")
    else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok(CardClaim {
            agent: r.get(0)?,
            cwd: r.get(1)?,
            task_id: r.get(2)?,
            created_at: r.get(3)?,
        })
    });
    rows.map(|rs| rs.flatten().collect()).unwrap_or_default()
}

/// 把卡片认领并入列表结果（list_sessions 在 apply_handoff 之后调用）：
/// 对每条登记，找该 agent+cwd 下登记时间之后有活动、且尚未归卡的最新会话，
/// 写入 session_meta.task_id 并消费登记。已手动归卡（task_id 非空）的会话不被抢占。
pub(crate) fn apply_card_claims(conn: &Connection, sessions: &mut [SessionMetaDto]) {
    if ensure_card_claim_table(conn).is_err() {
        return;
    }
    for claim in read_card_claims(conn) {
        let mut best: Option<usize> = None;
        for (i, s) in sessions.iter().enumerate() {
            if s.agent != claim.agent || s.task_id.is_some() {
                continue;
            }
            // 只认登记之后有活动的会话，避免把登记前就存在的旧会话归进卡片
            if s.updated_at.as_deref().unwrap_or("") < claim.created_at.as_str() {
                continue;
            }
            if !crate::handoff::cwd_matches(&s.project_path, &claim.cwd) {
                continue;
            }
            if best.is_none_or(|b| sessions[b].updated_at < s.updated_at) {
                best = Some(i);
            }
        }
        let Some(i) = best else { continue };
        let agent = sessions[i].agent.clone();
        let session_id = sessions[i].session_id.clone();
        sessions[i].task_id = Some(claim.task_id.clone());
        // 固化完成即消费登记：归卡以 session_meta 为持久记录
        let _ = assign_session_task_at(conn, &agent, &session_id, Some(&claim.task_id));
        let _ = conn.execute(
            "DELETE FROM card_claims WHERE agent=?1 AND cwd=?2",
            params![claim.agent, claim.cwd],
        );
    }
}

// ===== 步骤认领（与卡片认领同构，v3.93）：从「跟 AI 商量一下」（方式二·聊着定）等按步骤上下文
// 发起的会话，让该 agent 在该 cwd 的目标会话归到该步骤。与卡片同口径：命中后回填当次结果并固化进
// session_meta.step_name（步骤名直接存字符串，步骤改名后旧归属自然滞留、不影响其他过滤），
// 之后每轮列表由 apply_meta 持久列回填——否则对话页 8s 轮询的下一轮就丢掉归属。
// 目的是让这类跑在项目根（不落步骤工作区 worktree）的商量会话也能被「本步骤的对话」捞到。 =====

pub(crate) fn ensure_step_claim_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS step_claims(
          agent TEXT NOT NULL, cwd TEXT NOT NULL, step_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(agent, cwd));",
    )
    .map_err(|e| format!("初始化 step_claims 表失败: {e}"))
}

/// 按步骤上下文发起会话前登记认领（「跟 AI 商量一下」共用）；同 agent+cwd 重复登记覆盖（以最后一次为准）。
/// 登记不设过期：很久之后才产生的新会话也能命中（靠 created_at 时间口径排除登记前的旧会话）。
#[tauri::command]
pub fn claim_next_session_for_step(
    agent: String,
    cwd: String,
    step_name: String,
) -> Result<(), String> {
    let step_name = step_name.trim();
    if step_name.is_empty() {
        return Err("步骤名不能为空".into());
    }
    let conn = open_db()?;
    ensure_step_claim_table(&conn)?;
    conn.execute(
        "INSERT INTO step_claims(agent, cwd, step_name, created_at) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(agent, cwd) DO UPDATE SET step_name=?3, created_at=?4",
        params![agent, cwd, step_name, now_iso()],
    )
    .map_err(|e| format!("登记步骤认领失败: {e}"))?;
    Ok(())
}

struct StepClaim {
    agent: String,
    cwd: String,
    step_name: String,
    created_at: String,
}

fn read_step_claims(conn: &Connection) -> Vec<StepClaim> {
    let Ok(mut stmt) = conn.prepare("SELECT agent, cwd, step_name, created_at FROM step_claims")
    else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok(StepClaim {
            agent: r.get(0)?,
            cwd: r.get(1)?,
            step_name: r.get(2)?,
            created_at: r.get(3)?,
        })
    });
    rows.map(|rs| rs.flatten().collect()).unwrap_or_default()
}

/// 把步骤认领并入列表结果：对每条登记，找该 agent+cwd 下登记时间之后有活动、且尚未有步骤归属的
/// 最新会话，回填 step_name、固化进 session_meta 并消费登记。已有步骤归属（worktree 命中或
/// 此前固化）的会话不被抢占。
pub(crate) fn apply_step_claims(conn: &Connection, sessions: &mut [SessionMetaDto]) {
    if ensure_step_claim_table(conn).is_err() {
        return;
    }
    for claim in read_step_claims(conn) {
        let mut best: Option<usize> = None;
        for (i, s) in sessions.iter().enumerate() {
            // agent 不符或会话已有步骤归属（如 worktree 步骤命中的）不抢占
            if s.agent != claim.agent || s.step_name.is_some() {
                continue;
            }
            // 只认登记之后有活动的会话，避免把登记前就存在的旧会话误归进该步骤
            if s.updated_at.as_deref().unwrap_or("") < claim.created_at.as_str() {
                continue;
            }
            if !crate::handoff::cwd_matches(&s.project_path, &claim.cwd) {
                continue;
            }
            if best.is_none_or(|b| sessions[b].updated_at < s.updated_at) {
                best = Some(i);
            }
        }
        let Some(i) = best else { continue };
        let agent = sessions[i].agent.clone();
        let session_id = sessions[i].session_id.clone();
        sessions[i].step_name = Some(claim.step_name.clone());
        // 固化完成即消费登记：步骤归属以 session_meta 为持久记录（与归卡同口径）
        let _ = assign_session_step_at(conn, &agent, &session_id, &claim.step_name);
        let _ = conn.execute(
            "DELETE FROM step_claims WHERE agent=?1 AND cwd=?2",
            params![claim.agent, claim.cwd],
        );
    }
}

/// 步骤认领固化：写 session_meta.step_name（内部函数，仅 apply_step_claims 消费时调用）。
pub(crate) fn assign_session_step_at(
    conn: &Connection,
    agent: &str,
    session_id: &str,
    step_name: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, step_name) VALUES(?1, ?2, ?3)
         ON CONFLICT(agent, session_id) DO UPDATE SET step_name=?3",
        params![agent, session_id, step_name],
    )
    .map_err(|e| format!("写入 session_meta 失败: {e}"))?;
    Ok(())
}

// ===== 删除（用户显式发起，是只读原则的唯一例外） =====

/// 允许删除的会话数据目录：(目录, 是否同时允许 .json)。
/// 必须是各 CLI 实际存放会话文件的子目录，而不是 CLI 家目录整根——
/// 整根放行会让 file_path 指向同根的 auth.json、session_index.jsonl 等非会话文件
fn session_data_dirs() -> Vec<(PathBuf, bool)> {
    let mut dirs = dirs::home_dir()
        .map(|h| session_data_dirs_at(&h))
        .unwrap_or_default();
    if let Some(snap) = snapshots_root() {
        // pin 快照：.jsonl/.jsonl.zst，opencode 快照是导出的 .json
        dirs.push((snap, true));
    }
    dirs
}

/// 相对给定 home 的各 CLI 会话数据目录（不含 Mesa pin 快照）。
/// 导入白名单与删除白名单同源；测试可注入假 home。
pub(crate) fn session_data_dirs_at(home: &Path) -> Vec<(PathBuf, bool)> {
    vec![
        // claude: projects/<dir>/<uuid>.jsonl；codex: sessions|archived_sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]
        (home.join(".claude").join("projects"), false),
        (home.join(".codex").join("sessions"), false),
        (home.join(".codex").join("archived_sessions"), false),
        // gemini: tmp/<slug>/chats/*.jsonl；qwen: projects/**/chats/**/*.jsonl
        (home.join(".gemini").join("tmp"), false),
        (home.join(".qwen").join("projects"), false),
        // kimi 旧版 sessions/<md5>/<uuid>/context.jsonl（同目录 state.json 不许删 → .json 不放行）
        (home.join(".kimi").join("sessions"), false),
        // kimi 新版 sessions/<wd_*>/<id>/agents/main/wire.jsonl；
        // 枚举入口 session_index.jsonl 在 ~/.kimi-code 根上，限定 sessions/ 子目录后自然排除
        (home.join(".kimi-code").join("sessions"), false),
        // OpenCode legacy storage：session/message/part 都是 .json（v1.2+ 的共享 SQLite 走删行，不在这里）
        (
            home.join(".local")
                .join("share")
                .join("opencode")
                .join("storage"),
            true,
        ),
        // codebuddy: projects/<slug>/<uuid>.jsonl（同根的 .credentials.json 等不许删 → 限定 projects 子目录）
        (home.join(".codebuddy").join("projects"), false),
        // grok: sessions/<encoded-cwd>/<session-id>/updates.jsonl（同根的 auth.json/config.toml
        // 与 sessions 根的 session_search.sqlite 不许删 → 限定 sessions 子目录）
        (home.join(".grok").join("sessions"), false),
        // cursor 不进目录级白名单：~/.cursor 与 IDE 共享，projects 下也有非会话 jsonl，
        // 目录粒度太粗——由 deletable_session_file 里的 cursor_deletable 精确判定
    ]
}

/// cursor 会话删除的精确判定（projects_root = ~/.cursor/projects，调用方已 canonicalize）：
/// 只放行 <编码cwd>/agent-transcripts/**/*.jsonl；同根的 auth.json、IDE 数据、
/// projects 下 agent-transcripts 之外的 jsonl 一律拒绝
pub(crate) fn cursor_deletable(canon: &Path, projects_root: &Path) -> bool {
    let Ok(rel) = canon.strip_prefix(projects_root) else {
        return false;
    };
    let mut segs = rel.components();
    // 第一段是编码后的 cwd 目录；第二段必须是 agent-transcripts
    if segs.next().is_none() {
        return false;
    }
    if segs.next().map(|c| c.as_os_str()) != Some(std::ffi::OsStr::new("agent-transcripts")) {
        return false;
    }
    // agent-transcripts 之下必须还有内容，且最终文件是 .jsonl
    segs.next().is_some()
        && canon
            .file_name()
            .is_some_and(|n| n.to_string_lossy().ends_with(".jsonl"))
}

/// 删除目标两道闸：canonicalize 后必须落在已知会话数据目录内（防符号链接绕过），
/// 且后缀是会话文件（.jsonl/.jsonl.zst；仅明确允许的目录放行 .json）
/// 源文件是否落在会话白名单内（导出只读、删除共用）
pub(crate) fn session_file_in_whitelist(path: &Path) -> bool {
    deletable_session_file(path, &session_data_dirs())
}

pub(crate) fn deletable_session_file(path: &Path, dirs: &[(PathBuf, bool)]) -> bool {
    let Ok(canon) = path.canonicalize() else {
        return false;
    };
    let Some(name) = canon.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return false;
    };
    let jsonl = name.ends_with(".jsonl") || name.ends_with(".jsonl.zst");
    let json = name.ends_with(".json");
    if !jsonl && !json {
        return false;
    }
    // cursor 专属闸：目录级白名单粒度不够（~/.cursor 与 IDE 共享），单独精确判定
    if jsonl {
        if let Some(root) =
            dirs::home_dir().and_then(|h| h.join(".cursor").join("projects").canonicalize().ok())
        {
            if cursor_deletable(&canon, &root) {
                return true;
            }
        }
    }
    dirs.iter().any(|(dir, allow_json)| {
        (jsonl || (*allow_json && json))
            && dir
                .canonicalize()
                .map(|d| canon.starts_with(d))
                .unwrap_or(false)
    })
}

/// 删除源文件（不存在的候选跳过），返回是否真的删到了文件
fn delete_source_file(file_path: &str) -> Result<bool, String> {
    let mut deleted = false;
    let mut candidates = vec![file_path.to_string()];
    if !file_path.ends_with(".zst") {
        candidates.push(format!("{file_path}.zst")); // Codex 后台压缩后源文件名会变
    }
    let dirs = session_data_dirs();
    for c in candidates {
        let p = PathBuf::from(&c);
        if !p.exists() {
            continue;
        }
        if !deletable_session_file(&p, &dirs) {
            return Err(format!(
                "拒绝删除非会话文件（不在会话数据目录或后缀不符）: {c}"
            ));
        }
        trash::delete(&p).map_err(|e| format!("删除 {c} 失败: {e}"))?;
        deleted = true;
    }
    Ok(deleted)
}

/// OpenCode v1.2+ 的会话在共享 SQLite 里：读写连接 + 事务删 session/message/part 行
/// （只读扫描路径不变，仅删除开读写连接）。db_path 来自前端，只接受
/// `is_known_opencode_db` 候选路径之一，防把任意 SQLite 文件当会话库删
fn delete_opencode_rows(db_path: &Path, session_id: &str) -> Result<(), String> {
    if !is_known_opencode_db(db_path) {
        return Err("拒绝操作未知的 OpenCode 数据库".into());
    }
    delete_opencode_rows_impl(db_path, session_id)
}

fn delete_opencode_rows_impl(db_path: &Path, session_id: &str) -> Result<(), String> {
    let mut conn =
        Connection::open(db_path).map_err(|e| format!("打开 OpenCode 数据库失败: {e}"))?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(3));
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {e}"))?;
    for sql in [
        "DELETE FROM part WHERE session_id=?1",
        "DELETE FROM message WHERE session_id=?1",
        "DELETE FROM session WHERE id=?1",
    ] {
        tx.execute(sql, params![session_id])
            .map_err(|e| format!("删除 OpenCode 会话失败: {e}"))?;
    }
    tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
    Ok(())
}

/// Codex 链成员文件：rollout-<时间>-<uuid>.jsonl[.zst]，按文件名尾部 uuid 精确匹配
/// （与 find_snapshot 取尾部 uuid 的约定一致；payload id 与文件名 uuid 不一致的极端情况不覆盖）
fn grok_member_files(member_ids: &[String]) -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    grok_member_files_in(&[home.join(".grok").join("sessions")], member_ids)
}

fn grok_member_files_in(roots: &[PathBuf], member_ids: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if member_ids.is_empty() {
        return out;
    }
    let ids: HashSet<&str> = member_ids.iter().map(String::as_str).collect();
    let mut files = Vec::new();
    for root in roots {
        collect_files(root, 3, &mut files);
    }
    for f in files {
        if f.file_name().map(|n| n == "updates.jsonl") != Some(true) {
            continue;
        }
        let Some(dir) = f.parent().and_then(|p| p.file_name()) else {
            continue;
        };
        if ids.contains(dir.to_string_lossy().as_ref()) {
            out.push(f);
        }
    }
    out
}

fn codex_member_files(member_ids: &[String]) -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let roots = [
        home.join(".codex").join("sessions"),
        home.join(".codex").join("archived_sessions"),
    ];
    codex_member_files_in(&roots, member_ids)
}

fn codex_member_files_in(roots: &[PathBuf], member_ids: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if member_ids.is_empty() {
        return out;
    }
    let mut files = Vec::new();
    for root in roots {
        collect_files(root, 5, &mut files);
    }
    for f in files {
        let Some(name) = f.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let stem = name
            .strip_suffix(".jsonl.zst")
            .or_else(|| name.strip_suffix(".jsonl"))
            .unwrap_or(&name);
        let hit = member_ids.iter().any(|id| {
            stem == id
                || (stem.len() > id.len()
                    && stem.ends_with(id.as_str())
                    && stem.as_bytes()[stem.len() - id.len() - 1] == b'-')
        });
        if hit {
            out.push(f);
        }
    }
    out
}

/// 删除一个会话的全部磁盘痕迹：源文件（opencode 删库行；codex 连带链成员文件）+ pin 快照。
/// 返回需要一并清 meta 的额外 session id（codex 链成员，不含自身）
fn delete_session_files(
    agent: &str,
    session_id: &str,
    file_path: &str,
    chain_members: &HashMap<String, Vec<String>>,
) -> Result<Vec<String>, String> {
    let mut extra_meta_ids = Vec::new();
    if agent == "opencode" {
        match file_path.split_once('#') {
            // v1.2+：会话是共享库里的行，文件层面没有东西可删
            Some((db, sid)) => delete_opencode_rows(Path::new(db), sid)?,
            // legacy storage 的 .json（或快照路径兜底）
            None => {
                delete_source_file(file_path)?;
            }
        }
    } else {
        delete_source_file(file_path)?;
        if agent == "codex" || agent == "grok" {
            // resume/fork 链：只删代表文件会让链换个代表重新出现，成员文件一并删除
            let members = chain_members.get(session_id).cloned().unwrap_or_default();
            let extra_files = if agent == "codex" {
                codex_member_files(&members)
            } else {
                grok_member_files(&members)
            };
            for f in extra_files {
                delete_source_file(&f.to_string_lossy())?;
            }
            extra_meta_ids = members.into_iter().filter(|id| *id != session_id).collect();
        }
    }
    for p in snapshot_candidates(agent, session_id) {
        if p.exists() {
            let _ = fs::remove_file(p);
        }
    }
    for id in &extra_meta_ids {
        for p in snapshot_candidates(agent, id) {
            if p.exists() {
                let _ = fs::remove_file(p);
            }
        }
    }
    Ok(extra_meta_ids)
}

fn delete_session_impl(agent: &str, session_id: &str, file_path: &str) -> Result<(), String> {
    // 链成员表只有 codex 用得到；走缓存，不额外触发全量扫描之外的 IO
    let chain_members = if agent == "codex" || agent == "grok" {
        cached_scan().chain_members
    } else {
        HashMap::new()
    };
    let member_ids = delete_session_files(agent, session_id, file_path, &chain_members)?;
    let mut conn = open_db()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {e}"))?;
    tx.execute(
        "DELETE FROM session_meta WHERE agent=?1 AND session_id=?2",
        params![agent, session_id],
    )
    .map_err(|e| format!("删除 session_meta 失败: {e}"))?;
    crate::session_search::forget_in_tx(&tx, agent, session_id);
    for id in &member_ids {
        // 链成员 id 上的整理数据一并清掉，避免换代表后冒出幽灵行
        tx.execute(
            "DELETE FROM session_meta WHERE agent=?1 AND session_id=?2",
            params![agent, id],
        )
        .map_err(|e| format!("删除 session_meta 失败: {e}"))?;
        crate::session_search::forget_in_tx(&tx, agent, id);
    }
    tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
    invalidate_scan_cache();
    Ok(())
}

#[tauri::command]
pub async fn delete_session(
    agent: String,
    session_id: String,
    file_path: String,
) -> Result<(), String> {
    // 文件/库删除是阻塞 IO，移出 async worker
    tauri::async_runtime::spawn_blocking(move || {
        delete_session_impl(&agent, &session_id, &file_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_project_sessions(agent: String, project_path: String) -> Result<usize, String> {
    let project_path = expand_tilde(&project_path);
    let scan = tauri::async_runtime::spawn_blocking(cached_scan)
        .await
        .map_err(|e| e.to_string())?;
    let chain_members = scan.chain_members;
    let targets: Vec<SessionMetaDto> = scan
        .sessions
        .into_iter()
        .filter(|s| s.agent == agent && crate::paths::same_path(&s.project_path, &project_path))
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        delete_project_sessions_impl(targets, chain_members)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 逐会话先删文件/库行，成功才在同一事务里删 meta：删不掉的会话文件与 meta 都保留，
/// 不会出现文件已删/meta 残留（或相反）的幽灵状态；失败逐个列出并明示已删数量
fn delete_project_sessions_impl(
    targets: Vec<SessionMetaDto>,
    chain_members: HashMap<String, Vec<String>>,
) -> Result<usize, String> {
    // 单连接 + 事务批量删除（原实现逐项 open_db + 逐条 DELETE，大量会话时明显慢）
    let mut conn = open_db()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {e}"))?;
    let mut count = 0;
    let mut failed: Vec<String> = Vec::new();
    for s in &targets {
        match delete_session_files(&s.agent, &s.session_id, &s.file_path, &chain_members) {
            Ok(member_ids) => {
                tx.execute(
                    "DELETE FROM session_meta WHERE agent=?1 AND session_id=?2",
                    params![s.agent, s.session_id],
                )
                .map_err(|e| format!("删除 session_meta 失败: {e}"))?;
                for id in &member_ids {
                    tx.execute(
                        "DELETE FROM session_meta WHERE agent=?1 AND session_id=?2",
                        params![s.agent, id],
                    )
                    .map_err(|e| format!("删除 session_meta 失败: {e}"))?;
                }
                count += 1;
            }
            Err(e) => failed.push(format!("{}（{e}）", s.session_id)),
        }
    }
    tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
    invalidate_scan_cache();
    if failed.is_empty() {
        Ok(count)
    } else {
        Err(format!(
            "已删除 {count} 个会话，{} 个删除失败（文件与整理数据均已保留）：{}",
            failed.len(),
            failed.join("；")
        ))
    }
}

/// 会话文件签名（mtime_ms, size）：轮询时先比对签名，没变就不重解析
#[tauri::command]
pub async fn session_file_sig(file_path: String) -> Option<(u64, u64)> {
    if let Some((db, session_id)) = file_path.split_once('#') {
        let conn = open_opencode_db(Path::new(db))?;
        let updated = conn
            .query_row(
                "SELECT time_updated FROM session WHERE id=?1",
                params![session_id],
                |row| row.get::<_, i64>(0),
            )
            .ok()?
            .max(0) as u64;
        let wal_len = std::fs::metadata(format!("{db}-wal"))
            .map(|meta| meta.len())
            .unwrap_or(0);
        return Some((updated, wal_len));
    }
    let p = if let Some(stripped) = file_path.strip_prefix("~/") {
        dirs::home_dir()?.join(stripped)
    } else {
        std::path::PathBuf::from(&file_path)
    };
    let md = std::fs::metadata(p).ok()?;
    let mtime_ms = md
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some((mtime_ms, md.len()))
}

/// 监听已关联的会话文件。普通会话监听目标文件，OpenCode 监听数据库及其 WAL；
/// 事件经过 200ms 静默防抖后发出 `session-changed-<watch_id>`。
#[tauri::command]
pub fn watch_session(app: AppHandle, _agent: String, file_path: String) -> Result<String, String> {
    let (directory, targets) = session_watch_targets(&file_path);
    if !directory.is_dir() {
        return Err(format!("会话目录不存在：{}", directory.to_string_lossy()));
    }
    let watch_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let callback_targets = targets.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if let Ok(event) = result {
            if watch_event_matches(&event.paths, &callback_targets) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| format!("创建会话监听失败：{e}"))?;
    watcher
        .watch(&directory, RecursiveMode::Recursive)
        .map_err(|e| format!("监听会话目录失败：{e}"))?;

    let event_name = format!("session-changed-{watch_id}");
    let app_for_thread = app.clone();
    std::thread::spawn(move || loop {
        match rx.recv_timeout(std::time::Duration::from_millis(200)) {
            Ok(()) => {
                while rx
                    .recv_timeout(std::time::Duration::from_millis(200))
                    .is_ok()
                {}
                let _ = app_for_thread.emit(&event_name, ());
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    });
    session_watchers()
        .lock()
        .map_err(|_| "会话监听锁已损坏".to_string())?
        .insert(watch_id.clone(), SessionWatchEntry { _watcher: watcher });
    Ok(watch_id)
}

#[tauri::command]
pub fn unwatch_session(watch_id: String) -> Result<(), String> {
    session_watchers()
        .lock()
        .map_err(|_| "会话监听锁已损坏".to_string())?
        .remove(&watch_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|l| l.to_string()).collect()
    }

    // ===== 增量缓存 =====

    #[test]
    fn cached_plain_skips_parse_when_sig_unchanged() {
        let dir = std::env::temp_dir().join(format!("ccode-sig-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.jsonl");
        fs::write(&f, br#"{"type":"user","cwd":"/tmp/p","sessionId":"s1","message":{"role":"user","content":"hi"}}"#).unwrap();

        let mut cache: HashMap<String, (FileSig, SessionMetaDto)> = HashMap::new();
        let calls = std::cell::Cell::new(0usize);
        let first = cached_plain(vec![f.clone()], &mut cache, |p| {
            calls.set(calls.get() + 1);
            claude_file_meta(p, true)
        });
        assert_eq!(first.len(), 1);
        assert_eq!(calls.get(), 1);

        // 同一文件未变：不再调 parse
        let second = cached_plain(vec![f.clone()], &mut cache, |p| {
            calls.set(calls.get() + 1);
            claude_file_meta(p, true)
        });
        assert_eq!(second.len(), 1);
        assert_eq!(calls.get(), 1, "指纹未变必须命中缓存");
        assert_eq!(second[0].session_id, "s1");

        // 内容变了（长度不同）：重解析
        fs::write(&f, br#"{"type":"user","cwd":"/tmp/p","sessionId":"s2-changed","message":{"role":"user","content":"yo"}}"#).unwrap();
        let third = cached_plain(vec![f.clone()], &mut cache, |p| {
            calls.set(calls.get() + 1);
            claude_file_meta(p, true)
        });
        assert_eq!(calls.get(), 2, "指纹变了必须重解析");
        assert_eq!(third[0].session_id, "s2-changed");

        // 文件消失：条目被淘汰
        let gone = cached_plain(vec![], &mut cache, |p| claude_file_meta(p, true));
        assert!(gone.is_empty());
        assert!(cache.is_empty(), "消失的文件不许留在缓存里");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cached_chained_keeps_parent_across_hits() {
        let dir = std::env::temp_dir().join(format!("ccode-chain-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("rollout-2026-09-01-x.jsonl");
        fs::write(&f, br#"{"type":"session_meta","payload":{"id":"c1","cwd":"/tmp/p","forked_from_id":"root0"}}"#).unwrap();

        let mut cache: HashMap<String, (FileSig, SessionMetaDto, Option<String>)> = HashMap::new();
        let first = cached_chained(vec![f.clone()], &mut cache, |p| {
            codex_file_meta(p, true, false)
        });
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].1.as_deref(), Some("root0"));

        let second = cached_chained(vec![f.clone()], &mut cache, |p| {
            codex_file_meta(p, true, false)
        });
        assert_eq!(
            second[0].1.as_deref(),
            Some("root0"),
            "链父 id 命中缓存不丢"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dir_listing_sig_changes_with_content() {
        let dir = std::env::temp_dir().join(format!("ccode-dlsig-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x.jsonl");
        fs::write(&f, b"one").unwrap();
        let sig1 = dir_listing_sig(&[f.clone()]);
        fs::write(&f, b"one-longer").unwrap();
        let sig2 = dir_listing_sig(&[f.clone()]);
        assert_ne!(sig1, sig2, "长度变 = 指纹变");
        let sig3 = dir_listing_sig(&[dir.join("absent.jsonl")]);
        assert_ne!(sig2, sig3, "清单成员变 = 指纹变");
        let _ = fs::remove_dir_all(&dir);
    }

    // ===== Claude 解析 =====

    #[test]
    fn claude_parse_user_assistant_tool_flow() {
        let lines = s(&[
            r#"{"type":"summary","summary":"忽略我"}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-stdout>x</local-command-stdout>"}}"#,
            r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":"支线"}}"#,
            r#"{"type":"user","cwd":"/tmp/proj","sessionId":"s1","version":"1.0.0","message":{"role":"user","content":"帮我修 bug"},"timestamp":"2026-07-01T00:00:01Z"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"想想"},{"type":"text","text":"好的"},{"type":"tool_use","name":"Read","input":{"file_path":"/a"}}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}},"timestamp":"2026-07-01T00:00:02Z"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"file body"}]},"timestamp":"2026-07-01T00:00:03Z"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":"#, // 截断末行
        ]);
        let msgs = parse_claude(&lines);
        assert_eq!(msgs.len(), 2, "summary/isMeta/sidechain/截断行都要跳过");
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].text, "帮我修 bug");
        assert_eq!(msgs[0].timestamp.as_deref(), Some("2026-07-01T00:00:01Z"));
        assert_eq!(msgs[1].role, "assistant");
        // thinking + text + tool_use + 并入的 tool_result
        assert_eq!(msgs[1].blocks.len(), 4);
        assert_eq!(msgs[1].blocks[0].kind, "thinking");
        assert_eq!(msgs[1].blocks[1].kind, "text");
        assert_eq!(msgs[1].blocks[2].kind, "tool_use");
        assert_eq!(msgs[1].blocks[2].tool_name.as_deref(), Some("Read"));
        assert_eq!(msgs[1].blocks[3].kind, "tool_result");
        assert_eq!(msgs[1].blocks[3].text, "file body");
        let u = msgs[1].usage.as_ref().unwrap();
        assert_eq!(
            (u.input, u.output, u.cache_read, u.cache_write),
            (10, 5, 3, 2)
        );
    }

    #[test]
    fn claude_mixed_user_blocks_stay_user_message() {
        let lines = s(&[
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"out"},{"type":"text","text":"补充说明"}]}}"#,
        ]);
        let msgs = parse_claude(&lines);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks.len(), 2);
        assert_eq!(msgs[0].blocks[0].kind, "tool_result");
    }

    #[test]
    fn claude_tool_result_without_prior_assistant_becomes_user() {
        let lines = s(&[
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"out"}]}}"#,
        ]);
        let msgs = parse_claude(&lines);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].kind, "tool_result");
    }

    #[test]
    fn claude_meta_reads_cwd_title_and_ai_title_override() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("11111111-2222-3333-4444-555555555555.jsonl");
        let content = concat!(
            r#"{"type":"user","cwd":"/tmp/proj","sessionId":"sid-1","version":"1.2.3","timestamp":"2026-07-01T00:00:00Z","message":{"role":"user","content":"<command-name>/init</command-name>"}}"#,
            "\n",
            r#"{"type":"user","timestamp":"2026-07-01T00:01:00Z","message":{"role":"user","content":"真正的第一条消息"}}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"AI 起的标题","sessionId":"sid-1"}"#,
            "\n",
        );
        std::fs::write(&file, content).unwrap();
        let m = claude_file_meta(&file, true).unwrap();
        assert_eq!(m.project_path, "/tmp/proj");
        assert_eq!(m.session_id, "sid-1");
        assert_eq!(m.cli_version.as_deref(), Some("1.2.3"));
        assert_eq!(m.created_at.as_deref(), Some("2026-07-01T00:00:00Z"));
        assert_eq!(
            m.title.as_deref(),
            Some("AI 起的标题"),
            "ai-title 应覆盖首条用户消息"
        );
        assert!(m.updated_at.is_some());
        assert!(m.alive);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn title_truncates_to_60_chars() {
        let long = "啊".repeat(100);
        let t = truncate_title(&long);
        assert_eq!(t.chars().count(), 61); // 60 + 省略号
    }

    #[test]
    fn title_quality_rejects_placeholders_and_collapses_whitespace() {
        assert_eq!(usable_title("New Session"), None);
        assert_eq!(usable_title("未命名对话"), None);
        assert_eq!(
            usable_title("  修复统计页\n\n今日用量  ").as_deref(),
            Some("修复统计页 今日用量")
        );
    }

    #[test]
    fn title_quality_rejects_bare_greetings_but_keeps_greeting_with_content() {
        // 纯问候语拒识（解析器守卫会顺势跳到下一条 user 消息）
        for g in [
            "你好",
            "您好",
            "嗨",
            "在吗",
            "hi",
            "HI",
            "Hello!",
            "hey~",
            "你好。",
            "喂？",
        ] {
            assert_eq!(usable_title(g), None, "{g} 不该成为列表标题");
        }
        // 问候 + 正事同一条消息的不误伤
        assert_eq!(
            usable_title("你好，帮我看看这个 bug").as_deref(),
            Some("你好，帮我看看这个 bug")
        );
        assert_eq!(
            usable_title("<user_query>\n把文献综述的第二章压缩到 800 字\n</user_query>").as_deref(),
            Some("把文献综述的第二章压缩到 800 字")
        );
        assert_eq!(usable_title("<user_query>你好</user_query>"), None);
    }

    #[test]
    fn claude_meta_skips_greeting_and_takes_next_substantive_prompt() {
        // 首句是「你好」时标题取第二条实质 prompt（用户拍板：列表里一排「你好」没法区分）
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s-greet.jsonl");
        std::fs::write(
            &f,
            concat!(
                r#"{"type":"user","cwd":"/tmp/proj","sessionId":"sid-g","timestamp":"2026-07-01T00:00:00Z","message":{"content":"你好"}}"#,
                "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"你好！有什么可以帮你？"}]}}"#,
                "\n",
                r#"{"type":"user","message":{"content":"把文献综述的第二章压缩到 800 字"}}"#,
                "\n",
            ),
        )
        .unwrap();
        let m = claude_file_meta(&f, true).unwrap();
        assert_eq!(m.title.as_deref(), Some("把文献综述的第二章压缩到 800 字"));
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== CodeBuddy 解析（v2.132.0 实测样本行） =====

    #[test]
    fn codebuddy_parse_messages_skips_event_lines() {
        let lines = s(&[
            r#"{"id":"m1","timestamp":1786005441386,"type":"message","role":"user","content":[{"type":"input_text","text":"say hi"}],"providerData":{"agent":"cli"},"sessionId":"sid-cb","cwd":"/private/tmp/cbtest"}"#,
            r#"{"id":"s1","timestamp":1786005441391,"type":"file-history-snapshot","isSnapshotUpdate":false,"snapshot":{"messageId":"m1","trackedFileBackups":{}},"cwd":"/private/tmp/cbtest"}"#,
            r#"{"id":"m2","parentId":"m1","timestamp":1786005443775,"type":"message","role":"assistant","content":[{"type":"output_text","text":"你好！"}],"status":"incomplete","sessionId":"sid-cb","cwd":"/private/tmp/cbtest"}"#,
            r#"{"id":"m3","type":"unknown-future-event","foo":1}"#,
            r#"{"id":"m4","type":"message","role":"assistant","content":"#, // 截断末行
        ]);
        let msgs = parse_codebuddy(&lines);
        assert_eq!(
            msgs.len(),
            2,
            "file-history-snapshot/未知类型/截断行都要跳过"
        );
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].text, "say hi");
        assert_eq!(
            msgs[0].timestamp.as_deref(),
            Some("2026-08-06T08:37:21Z"),
            "毫秒 epoch 应转 ISO"
        );
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].blocks[0].text, "你好！");
    }

    #[test]
    fn codebuddy_meta_reads_cwd_session_and_title() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let proj = dir.join("-private-tmp-cbtest");
        std::fs::create_dir_all(&proj).unwrap();
        let file = proj.join("df3ac35f-6338-4875-bcb8-7ac811794538.jsonl");
        let content = concat!(
            r#"{"id":"m1","timestamp":1786005441386,"type":"message","role":"user","content":[{"type":"input_text","text":"say hi"}],"providerData":{"agent":"cli"},"sessionId":"df3ac35f-6338-4875-bcb8-7ac811794538","cwd":"/private/tmp/cbtest"}"#,
            "\n",
            r#"{"id":"s1","timestamp":1786005441391,"type":"file-history-snapshot","isSnapshotUpdate":false,"snapshot":{"messageId":"m1","trackedFileBackups":{}},"cwd":"/private/tmp/cbtest"}"#,
            "\n",
        );
        std::fs::write(&file, content).unwrap();
        let m = codebuddy_file_meta(&file, true).unwrap();
        assert_eq!(m.agent, "codebuddy");
        assert_eq!(m.project_path, "/private/tmp/cbtest");
        assert_eq!(m.session_id, "df3ac35f-6338-4875-bcb8-7ac811794538");
        assert_eq!(m.title.as_deref(), Some("say hi"));
        assert!(m.created_at.is_some());
        assert!(m.alive);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codebuddy_meta_falls_back_to_slug_dir_name() {
        // 行里没有 cwd/sessionId 时：项目归属回落 slug 目录名（同 Claude 规则），session id 回落文件名
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let proj = dir.join("-Users-x-proj");
        std::fs::create_dir_all(&proj).unwrap();
        let file = proj.join("aaaaaaaa-0000-0000-0000-000000000000.jsonl");
        std::fs::write(
            &file,
            r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}"#,
        )
        .unwrap();
        let m = codebuddy_file_meta(&file, true).unwrap();
        assert_eq!(m.project_path, "-Users-x-proj");
        assert_eq!(m.session_id, "aaaaaaaa-0000-0000-0000-000000000000");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== cursor 解析器（样本行按源码枚举构造：user_message/tool_call/tool_result/
    // turn_ended/turn_id/message_id；完整字段样本未验证，防御式）=====

    #[test]
    fn cursor_parse_skips_event_lines_unknown_types_and_truncation() {
        let lines = s(&[
            r#"{"type":"turn_id","id":"t1"}"#,
            r#"{"type":"user_message","message":{"content":[{"text":"写一个 hello world"}]},"timestamp":1786005441386}"#,
            r#"{"type":"message_id","id":"m1"}"#,
            r#"{"type":"tool_call","name":"read_file","timestamp":1786005441400}"#,
            r#"{"type":"tool_result","timestamp":1786005441450}"#,
            r#"{"type":"user_message","message":{"content":"纯字符串 content 也要能提取"},"time":1786005441460}"#,
            r#"{"type":"turn_ended","timestamp":1786005441500}"#,
            r#"{"type":"future_unknown_type","foo":1}"#,
            r#"{"type":"user_message","message":{"con"#, // 截断末行
        ]);
        let msgs = parse_cursor(&lines);
        assert_eq!(msgs.len(), 2, "事件行/未知类型/截断行都要跳过");
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].text, "写一个 hello world");
        assert_eq!(
            msgs[0].timestamp.as_deref(),
            Some("2026-08-06T08:37:21Z"),
            "毫秒 epoch 应转 ISO"
        );
        assert_eq!(msgs[1].blocks[0].text, "纯字符串 content 也要能提取");
        assert_eq!(msgs[1].timestamp.as_deref(), Some("2026-08-06T08:37:21Z"));
    }

    #[test]
    fn cursor_meta_reads_title_and_falls_back_to_encoded_dir() {
        // 结构 projects/<编码cwd>/agent-transcripts/<uuid>/<uuid>.jsonl；
        // 行里没有 cwd 字段时：项目归属回落上三级编码目录名（有损不解码），session id 回落文件名
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let sess = dir
            .join("-Users-x-proj")
            .join("agent-transcripts")
            .join("bbbbbbbb-0000-0000-0000-000000000000");
        std::fs::create_dir_all(&sess).unwrap();
        let file = sess.join("bbbbbbbb-0000-0000-0000-000000000000.jsonl");
        let content = concat!(
            r#"{"type":"turn_id","id":"t1"}"#,
            "\n",
            r#"{"type":"user_message","message":{"content":[{"text":"帮我看这份数据"}]},"timestamp":1786005441386}"#,
            "\n",
        );
        std::fs::write(&file, content).unwrap();
        let m = cursor_file_meta(&file, true).unwrap();
        assert_eq!(m.agent, "cursor");
        assert_eq!(m.project_path, "-Users-x-proj");
        assert_eq!(m.session_id, "bbbbbbbb-0000-0000-0000-000000000000");
        assert_eq!(m.title.as_deref(), Some("帮我看这份数据"));
        assert!(m.created_at.is_some());
        assert!(m.alive);
        // 行里带 cwd 字段时优先用真实路径
        std::fs::write(
            &file,
            r#"{"type":"user_message","message":{"content":[{"text":"hi"}]},"cwd":"/Users/x/proj","timestamp":1786005441386}"#,
        )
        .unwrap();
        let m = cursor_file_meta(&file, true).unwrap();
        assert_eq!(m.project_path, "/Users/x/proj");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tail_state_cursor() {
        let working = s(&[
            r#"{"type":"turn_ended"}"#,
            r#"{"type":"user_message","message":{"content":[{"text":"继续"}]}}"#,
        ]);
        assert_eq!(
            cursor_tail_state(&working),
            "working",
            "发了消息还没回合结束"
        );
        let tool = s(&[r#"{"type":"tool_call","name":"read_file"}"#]);
        assert_eq!(cursor_tail_state(&tool), "working");
        let done = s(&[
            r#"{"type":"user_message","message":{"content":[{"text":"hi"}]}}"#,
            r#"{"type":"future_unknown_type"}"#, // 未知 type 跳过，不算最新状态
            r#"{"type":"turn_ended"}"#,
        ]);
        assert_eq!(cursor_tail_state(&done), "done");
        assert_eq!(cursor_tail_state(&[]), "unknown");
    }

    #[test]
    fn cursor_deletable_whitelist_limits_to_agent_transcripts() {
        // projects_root 由调用方 canonicalize；测试里直接用临时目录
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let root = dir.join("projects");
        let ok = root
            .join("-tmp-x")
            .join("agent-transcripts")
            .join("u1")
            .join("u1.jsonl");
        assert!(
            cursor_deletable(&ok, &root),
            "agent-transcripts 下的 .jsonl 放行"
        );
        assert!(
            !cursor_deletable(&root.join("-tmp-x").join("other.jsonl"), &root),
            "agent-transcripts 之外的 jsonl 必须拒绝"
        );
        assert!(
            !cursor_deletable(
                &root
                    .join("-tmp-x")
                    .join("agent-transcripts")
                    .join("u1")
                    .join("meta.json"),
                &root
            ),
            "agent-transcripts 下的非 .jsonl 必须拒绝"
        );
        assert!(
            !cursor_deletable(&root.join("-tmp-x").join("agent-transcripts"), &root),
            "agent-transcripts 本身（下面没有文件）必须拒绝"
        );
        assert!(
            !cursor_deletable(&dir.join("auth.json"), &root),
            "projects 之外（同根 auth.json）必须拒绝"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== Grok Build 解析（updates.jsonl 的 ACP session/update 行） =====

    #[test]
    fn grok_parse_messages_skips_unknown_update_types_and_truncation() {
        let lines = s(&[
            r#"{"timestamp":1786005441,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"写一个 hello world"}}}}"#,
            r#"{"timestamp":1786005442,"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"read_file"}}}"#,
            r#"{"timestamp":1786005443,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"好的，已写好"}}}}"#,
            r#"{"timestamp":1786005444,"method":"session/update","params":{"update":{"sessionUpdate":"plan","entries":[]}}}"#,
            r#"{"timestamp":1786005445,"method":"_x.ai/custom","params":{"foo":1}}"#,
            r#"{"timestamp":1786005446,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"#, // 截断末行
        ]);
        let msgs = parse_grok(&lines);
        assert_eq!(msgs.len(), 2, "tool_call/plan/扩展通知/截断行都要跳过");
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].text, "写一个 hello world");
        assert_eq!(
            msgs[0].timestamp.as_deref(),
            Some("2026-08-06T08:37:21Z"),
            "unix 秒应转 ISO"
        );
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].blocks[0].text, "好的，已写好");
    }

    #[test]
    fn grok_parse_unwraps_user_query_in_chunks() {
        let lines = s(&[
            r#"{"timestamp":1,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"<user_query>\n你好\n</user_query>"}}}}"#,
        ]);
        let msgs = parse_grok(&lines);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].blocks[0].text, "你好");
    }

    #[test]
    fn grok_parse_merges_streaming_chunks_and_tool_calls_split_runs() {
        let lines = s(&[
            r#"{"timestamp":1,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"我来"}}}}"#,
            r#"{"timestamp":2,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"查一下。"}}}}"#,
            r#"{"timestamp":3,"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1"}}}"#,
            r#"{"timestamp":4,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"查到了。"}}}}"#,
            r#"{"timestamp":5,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"好"}}}}"#,
            r#"{"timestamp":6,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"，继续"}}}}"#,
        ]);
        let msgs = parse_grok(&lines);
        assert_eq!(msgs.len(), 3, "连续同角色 chunk 合并；tool_call 打断");
        assert_eq!(msgs[0].blocks[0].text, "我来查一下。");
        assert_eq!(msgs[0].timestamp.as_deref().is_some(), true);
        assert_eq!(msgs[1].blocks[0].text, "查到了。");
        assert_eq!(msgs[2].role, "user");
        assert_eq!(msgs[2].blocks[0].text, "好，继续");
    }

    #[test]
    fn grok_history_prefers_canonical_prompts_and_skips_runtime_context() {
        let lines = s(&[
            r#"{"type":"system","content":"context"}"#,
            r#"{"type":"user","content":"runtime context"}"#,
            r#"{"type":"user","synthetic_reason":"system_reminder","content":"hidden"}"#,
            r#"{"type":"user","prompt_index":0,"content":[{"type":"text","text":"第一问"}]}"#,
            r#"{"type":"assistant","content":"第一答"}"#,
            r#"{"type":"tool_result","content":"不要显示"}"#,
            r#"{"type":"user","prompt_index":1,"content":[{"type":"text","text":"第二问"},{"type":"image","data":"..."}]}"#,
            r#"{"type":"assistant","content":"第二答"}"#,
        ]);
        let messages = parse_grok_history(&lines);
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].blocks[0].text, "第一问");
        assert_eq!(messages[3].blocks[0].text, "第二答");
    }

    #[test]
    fn grok_history_unwraps_user_query_tags() {
        let lines = s(&[
            r#"{"type":"user","prompt_index":0,"content":"<user_query>\n你好\n</user_query>"}"#,
            r#"{"type":"assistant","content":"你好，需要我做什么？"}"#,
        ]);
        let messages = parse_grok_history(&lines);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].blocks[0].text, "你好");
        assert!(
            !messages[0].blocks[0].text.contains("user_query"),
            "回放不得露出 <user_query>"
        );
    }

    #[test]
    fn grok_strips_turn_aborted_marker() {
        assert_eq!(
            unwrap_prompt_tags(
                "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>"
            ),
            ""
        );
        assert_eq!(
            unwrap_prompt_tags("先说一句。<turn_aborted>\naborted\n</turn_aborted>"),
            "先说一句。"
        );
        let history = parse_grok_history(&s(&[
            r#"{"type":"user","prompt_index":0,"content":"你好"}"#,
            r#"{"type":"assistant","content":"<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>"}"#,
            r#"{"type":"user","prompt_index":1,"content":"你好"}"#,
        ]));
        assert_eq!(history.len(), 2, "纯暂停标记不当成助手回复");
        assert_eq!(history[0].role, "user");
        assert_eq!(history[1].role, "user");
        let chunks = parse_grok(&s(&[
            r#"{"timestamp":1,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"你好"}}}}"#,
            r#"{"timestamp":2,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"<turn_aborted>\ninterrupted\n</turn_aborted>"}}}}"#,
        ]));
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].role, "user");
    }

    #[test]
    fn tagged_block_ascii_ci_match_never_panics_on_width_changing_chars() {
        // İ/ß 这类字符 to_ascii_lowercase 后长度会变：旧实现用小写串下标切原串必 panic，
        // ASCII 逐字节比较返回的原串下标在任何多字节文本旁都安全。
        assert_eq!(unwrap_prompt_tags("İ<USER_QUERY>ß好</USER_QUERY>"), "İß好");
        assert_eq!(unwrap_prompt_tags("ẞ<turn_aborted>x</TURN_ABORTED>ß"), "ẞß");
    }

    #[test]
    fn grok_history_page_loads_older_messages_by_message_cursor() {
        let dir = std::env::temp_dir().join(format!("ccode-grok-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let updates = dir.join("updates.jsonl");
        std::fs::write(&updates, "{}\n").unwrap();
        let mut history = String::new();
        for index in 0..85 {
            history.push_str(&format!(
                r#"{{"type":"user","prompt_index":{index},"content":"问 {index}"}}"#,
            ));
            history.push('\n');
        }
        std::fs::write(dir.join("chat_history.jsonl"), history).unwrap();
        let latest = grok_conversation_page(&updates, None).unwrap();
        assert_eq!(latest.messages.len(), 80);
        assert_eq!(latest.messages[0].blocks[0].text, "问 5");
        assert_eq!(latest.cursor, Some(5));
        let older = grok_conversation_page(&updates, latest.cursor).unwrap();
        assert_eq!(older.messages.len(), 5);
        assert_eq!(older.messages[0].blocks[0].text, "问 0");
        assert_eq!(older.cursor, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grok_meta_reads_summary_json_and_falls_back_to_dir_name() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let sess = dir
            .join("sessions")
            .join("%2FUsers%2Fx%2Fproj")
            .join("018f7c2a-0000-7000-8000-000000000000");
        std::fs::create_dir_all(&sess).unwrap();
        let file = sess.join("updates.jsonl");
        std::fs::write(
            &file,
            r#"{"timestamp":1786005441,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"帮我看这份数据"}}}}"#,
        )
        .unwrap();
        // summary.json 提供 info.cwd/generated_title/current_model_id（比解码目录名可靠）
        std::fs::write(
            sess.join("summary.json"),
            r#"{"info":{"id":"018f7c2a-0000-7000-8000-000000000000","cwd":"/Users/x/proj"},"generated_title":"看数据","created_at":1786005441,"updated_at":1786005500,"num_messages":2,"current_model_id":"grok-code-fast-1"}"#,
        )
        .unwrap();
        let (m, parent) = grok_file_meta(&file, true).unwrap();
        assert_eq!(m.agent, "grok");
        assert_eq!(m.project_path, "/Users/x/proj", "info.cwd 优先于目录名");
        assert_eq!(m.session_id, "018f7c2a-0000-7000-8000-000000000000");
        assert_eq!(m.title.as_deref(), Some("看数据"));
        assert_eq!(m.created_at.as_deref(), Some("2026-08-06T08:37:21Z"));
        assert_eq!(m.updated_at.as_deref(), Some("2026-08-06T08:38:20Z"));
        assert!(parent.is_none());
        // summary.json 缺失时：项目归属回落 encoded-cwd 目录名（不解码），标题从 updates.jsonl 首条用户消息提取
        std::fs::remove_file(sess.join("summary.json")).unwrap();
        let (m, parent) = grok_file_meta(&file, true).unwrap();
        assert!(parent.is_none());
        assert_eq!(m.project_path, "%2FUsers%2Fx%2Fproj");
        assert_eq!(m.title.as_deref(), Some("帮我看这份数据"));
        assert!(m.created_at.is_some(), "行内 timestamp 兜底 created_at");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grok_parent_session_merges_resume_chain() {
        let (child, parent) = grok_file_meta_from_summary(
            r#"{"info":{"id":"child","cwd":"/p"},"generated_title":"同题","parent_session_id":"parent","created_at":1786005441,"updated_at":1786005500}"#,
        );
        assert_eq!(child.session_id, "child");
        assert_eq!(parent.as_deref(), Some("parent"));
        let metas = vec![
            (
                SessionMetaDto {
                    agent: "grok".into(),
                    session_id: "parent".into(),
                    project_path: "/p".into(),
                    cwd: Some("/p".into()),
                    title: Some("同题".into()),
                    created_at: None,
                    updated_at: Some("2026-08-06T08:00:00Z".into()),
                    file_path: "/p/parent/updates.jsonl".into(),
                    token_usage: None,
                    cli_version: None,
                    pinned: false,
                    archived: false,
                    custom_title: None,
                    tags: Vec::new(),
                    alive: true,
                    chain_count: 1,
                    workspace: None,
                    step_name: None,
                    summary: None,
                    live: false,
                    source: default_session_source(),
                    internal: false,
                    handoff_from_agent: None,
                    handoff_from_session: None,
                    task_id: None,
                    task_name: None,
                    provider: None,
                    profile_id: None,
                },
                None,
            ),
            (child, parent),
        ];
        let (merged, members) = merge_codex_chains(metas);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].chain_count, 2);
        assert_eq!(merged[0].session_id, "child");
        assert_eq!(members.get("child").map(|v| v.len()), Some(2));
    }

    fn grok_file_meta_from_summary(summary: &str) -> (SessionMetaDto, Option<String>) {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let sess = dir.join("sessions").join("cwd").join("child");
        std::fs::create_dir_all(&sess).unwrap();
        let file = sess.join("updates.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        std::fs::write(sess.join("summary.json"), summary).unwrap();
        let pair = grok_file_meta(&file, true).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        pair
    }

    #[test]
    fn tail_state_grok() {
        // 用户消息发出后还没等到助手输出 → working
        let working = s(&[
            r#"{"timestamp":1,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"已完成"}}}}"#,
            r#"{"timestamp":2,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"继续"}}}}"#,
        ]);
        assert_eq!(grok_tail_state(&working), "working");
        // 工具调用进行中 → working
        let tool = s(&[
            r#"{"timestamp":1,"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1"}}}"#,
        ]);
        assert_eq!(grok_tail_state(&tool), "working");
        // 助手输出收尾：问句判 confirm，陈述判 done；未知类型跳过不算最新状态
        let confirm = s(&[
            r#"{"timestamp":1,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"}}}}"#,
            r#"{"timestamp":2,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"要我继续吗？"}}}}"#,
        ]);
        assert_eq!(grok_tail_state(&confirm), "confirm");
        let done = s(&[
            r#"{"timestamp":1,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"已完成。"}}}}"#,
            r#"{"timestamp":2,"method":"session/update","params":{"update":{"sessionUpdate":"plan","entries":[]}}}"#,
        ]);
        assert_eq!(
            grok_tail_state(&done),
            "done",
            "plan 等事件行跳过，不算最新状态"
        );
        assert_eq!(grok_tail_state(&[]), "unknown");
    }

    #[test]
    fn grok_deletable_whitelist_limits_to_sessions_subdir() {
        // 白名单目录 = ~/.grok/sessions；同根的 auth.json/config.toml 与
        // sessions 根的 session_search.sqlite 均不在放行范围（目录闸 + .jsonl 后缀闸）
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let sessions = dir.join("sessions");
        let ok = sessions.join("%2Ftmp%2Fx").join("u1").join("updates.jsonl");
        assert!(
            ok.ends_with("updates.jsonl") && ok.starts_with(&sessions),
            "会话文件在 sessions 子目录内"
        );
        // deletable_session_file 需要 canonicalize 存在，建真文件验证
        std::fs::create_dir_all(ok.parent().unwrap()).unwrap();
        std::fs::write(&ok, "{}\n").unwrap();
        let dirs = vec![(sessions.clone(), false)];
        assert!(
            deletable_session_file(&ok, &dirs),
            "sessions/*/*/updates.jsonl 放行"
        );
        let summary = ok.parent().unwrap().join("summary.json");
        std::fs::write(&summary, "{}").unwrap();
        assert!(
            !deletable_session_file(&summary, &dirs),
            "同目录 summary.json（.json 不放行）必须拒绝"
        );
        let auth = dir.join("auth.json");
        std::fs::write(&auth, "{}").unwrap();
        assert!(
            !deletable_session_file(&auth, &dirs),
            "sessions 之外的 auth.json 必须拒绝"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn plain_conversation_page_loads_long_session_in_windows() {
        let dir = std::env::temp_dir().join(format!("ccode-page-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("long.jsonl");
        let mut content = String::new();
        for index in 0..4000 {
            content.push_str(&format!(
                "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"消息 {index:04} {}\"}},\"timestamp\":\"2026-07-01T00:00:00Z\"}}\n",
                "x".repeat(80)
            ));
        }
        std::fs::write(&file, &content).unwrap();
        let latest = plain_conversation_page("claude-code", &file, None, None).unwrap();
        assert!(latest.cursor.is_some(), "长会话首屏应提供更早页 cursor");
        assert!(latest
            .messages
            .last()
            .is_some_and(|message| message.blocks[0].text.contains("消息 3999")));
        let older = plain_conversation_page("claude-code", &file, latest.cursor, None).unwrap();
        assert!(!older.messages.is_empty());
        assert_ne!(
            older.messages.last().unwrap().blocks[0].text,
            latest.messages.first().unwrap().blocks[0].text
        );

        let needle = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"消息 0100 ";
        let at = content.find(needle).expect("early message") as u64;
        let mid = plain_conversation_page("claude-code", &file, None, Some(at)).unwrap();
        assert!(
            mid.messages
                .iter()
                .any(|m| m.blocks[0].text.contains("消息 0100")),
            "around 窗口应包含命中那一条"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    fn claude_user_line(text: &str) -> String {
        format!(
            "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"{text}\"}},\"timestamp\":\"2026-07-01T00:00:00Z\"}}\n"
        )
    }

    #[test]
    fn plain_conversation_page_skips_oversized_jsonl_line() {
        // Codex 工具行经常 >192KB：旧分页会把 cursor 钉在超长行尾，加载更早死循环。
        let dir = std::env::temp_dir().join(format!("ccode-huge-line-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("huge.jsonl");
        let huge = "H".repeat(300_000);
        let mut content = String::new();
        content.push_str(&claude_user_line("early-msg"));
        content.push_str(&claude_user_line(&huge));
        content.push_str(&claude_user_line("late-msg"));
        std::fs::write(&file, &content).unwrap();

        let latest = plain_conversation_page("claude-code", &file, None, None).unwrap();
        assert!(
            latest
                .messages
                .iter()
                .any(|m| m.blocks[0].text.contains("late-msg")),
            "尾页应有最后一条短消息: {:?}",
            latest
                .messages
                .iter()
                .map(|m| &m.blocks[0].text)
                .collect::<Vec<_>>()
        );
        assert!(
            latest
                .messages
                .iter()
                .all(|m| !m.blocks[0].text.contains(&huge)),
            "超长行不应整页塞进回放"
        );
        let cursor = latest.cursor.expect("尾页后面还有更早内容");
        let older = plain_conversation_page("claude-code", &file, Some(cursor), None).unwrap();
        assert_ne!(
            older.cursor, latest.cursor,
            "cursor 必须前进，不能钉在超长行尾"
        );
        assert!(
            older
                .messages
                .iter()
                .any(|m| m.blocks[0].text.contains("early-msg")),
            "一次加载更早应跳过超长行读到更早消息: {:?}",
            older
                .messages
                .iter()
                .map(|m| &m.blocks[0].text)
                .collect::<Vec<_>>()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn plain_conversation_page_skips_empty_event_windows() {
        let dir = std::env::temp_dir().join(format!("ccode-empty-win-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("events.jsonl");
        let mut content = String::new();
        content.push_str(&claude_user_line("early-msg"));
        let filler = "{\"type\":\"ignore\",\"payload\":{}}\n";
        while content.len() < 250_000 {
            content.push_str(filler);
        }
        content.push_str(&claude_user_line("late-msg"));
        std::fs::write(&file, &content).unwrap();

        let latest = plain_conversation_page("claude-code", &file, None, None).unwrap();
        assert!(latest
            .messages
            .iter()
            .any(|m| m.blocks[0].text.contains("late-msg")));
        let cursor = latest.cursor.expect("中间有填充行，应还能往前");
        let older = plain_conversation_page("claude-code", &file, Some(cursor), None).unwrap();
        assert!(
            older
                .messages
                .iter()
                .any(|m| m.blocks[0].text.contains("early-msg")),
            "空窗（无对话行）应在同一次请求里连跳: {:?}",
            older
                .messages
                .iter()
                .map(|m| &m.blocks[0].text)
                .collect::<Vec<_>>()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn redaction_masks_saved_secrets_everywhere() {
        let secret = "sk-stored-secret-123456".to_string();
        let text = format!("标题 {secret}，正文再次出现 {secret}");
        let redacted = redact_sensitive_text_with(&text, &[secret.clone()]);
        assert!(!redacted.contains(&secret));
        assert_eq!(redacted.matches("[已隐藏密钥 ···3456]").count(), 2);
    }

    #[test]
    fn redaction_masks_common_secret_prefixes_without_saved_key() {
        let text = "Bearer sk-live-secret-987654, OPENAI_API_KEY=sk_second_secret_123456";
        let redacted = redact_sensitive_text_with(text, &[]);
        assert!(!redacted.contains("sk-live-secret-987654"));
        assert!(!redacted.contains("sk_second_secret_123456"));
        assert!(redacted.contains("Bearer [已隐藏密钥 ···7654],"));
        assert!(redacted.contains("OPENAI_API_KEY=[已隐藏密钥 ···3456]"));
        assert_eq!(redact_sensitive_text_with("sk-short", &[]), "sk-short");
    }

    #[test]
    fn conversation_hides_turn_aborted_marker() {
        let mut messages = vec![
            ChatMessageDto {
                role: "user".into(),
                blocks: vec![text_block("你好".into())],
                timestamp: None,
                usage: None,
            },
            ChatMessageDto {
                role: "assistant".into(),
                blocks: vec![text_block(
                    "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>"
                        .into(),
                )],
                timestamp: None,
                usage: None,
            },
        ];
        redact_conversation(&mut messages);
        assert_eq!(messages.len(), 1, "暂停标记不得当成助手回复");
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].blocks[0].text, "你好");
    }

    // ===== Codex 解析 =====

    #[test]
    fn codex_parse_messages_tools_and_usage() {
        let lines = s(&[
            r#"{"timestamp":"2026-07-20T00:00:00Z","type":"session_meta","payload":{"id":"019f-test","timestamp":"2026-07-20T00:00:00Z","cwd":"/tmp/proj","cli_version":"0.20.0"}}"#,
            r#"{"timestamp":"2026-07-20T00:00:01Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"指令跳过"}]}}"#,
            r#"{"timestamp":"2026-07-20T00:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi codex"}]}}"#,
            r#"{"timestamp":"2026-07-20T00:00:03Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}"#,
            r#"{"timestamp":"2026-07-20T00:00:04Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}"#,
            r#"{"timestamp":"2026-07-20T00:00:05Z","type":"response_item","payload":{"type":"function_call_output","output":"total 0"}}"#,
            r#"{"timestamp":"2026-07-20T00:00:06Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":20,"reasoning_output_tokens":5,"cached_input_tokens":10,"cache_write_input_tokens":0}}}}"#,
        ]);
        let msgs = parse_codex(&lines);
        assert_eq!(msgs.len(), 3, "developer 消息跳过，tool_result 并入上一条");
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].text, "hi codex");
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].blocks[0].text, "hello");
        assert_eq!(msgs[2].role, "assistant");
        assert_eq!(msgs[2].blocks[0].kind, "tool_use");
        assert_eq!(msgs[2].blocks[0].tool_name.as_deref(), Some("shell"));
        assert_eq!(msgs[2].blocks[1].kind, "tool_result");
        assert_eq!(msgs[2].blocks[1].text, "total 0");
        // 最后一条 token_count 的总量挂在最后一条 assistant 上；reasoning 计入 output
        let u = msgs[2].usage.as_ref().unwrap();
        assert_eq!(
            (u.input, u.output, u.cache_read, u.cache_write),
            (100, 25, 10, 0)
        );
    }

    #[test]
    fn codex_legacy_event_msg_fallback() {
        let lines = s(&[
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"老格式提问"}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"老格式回答"}}"#,
        ]);
        let msgs = parse_codex(&lines);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[1].role, "assistant");
    }

    #[test]
    fn codex_response_item_wins_over_legacy_dup() {
        let lines = s(&[
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"重复的"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"新的"}]}}"#,
        ]);
        let msgs = parse_codex(&lines);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].blocks[0].text, "新的");
    }

    #[test]
    fn codex_parse_skips_injected_agents_context_but_keeps_real_user_message() {
        let lines = s(&[
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n\n<INSTRUCTIONS>\nengineering rules\n</INSTRUCTIONS>"}]}}"##,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"请分析这个项目"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好的"}]}}"#,
        ]);
        let msgs = parse_codex(&lines);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].blocks[0].text, "请分析这个项目");
        assert_eq!(msgs[1].blocks[0].text, "好的");
    }

    #[test]
    fn codex_meta_reads_session_meta_and_tail_usage() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file =
            dir.join("rollout-2026-07-20T00-00-00-019f8039-8bed-7323-8c9d-853c1e7a9edf.jsonl");
        let content = concat!(
            r#"{"timestamp":"2026-07-20T00:00:00Z","type":"session_meta","payload":{"id":"019f8039-8bed-7323-8c9d-853c1e7a9edf","timestamp":"2026-07-20T00:00:00Z","cwd":"/tmp/proj","cli_version":"0.20.0"}}"#,
            "\n",
            r#"{"timestamp":"2026-07-20T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"做点事"}]}}"#,
            "\n",
            r#"{"timestamp":"2026-07-20T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":50,"output_tokens":8,"cached_input_tokens":4,"cache_write_input_tokens":2}}}}"#,
            "\n",
        );
        std::fs::write(&file, content).unwrap();
        let (m, fork) = codex_file_meta(&file, true, false).unwrap();
        assert_eq!(m.project_path, "/tmp/proj");
        assert_eq!(m.session_id, "019f8039-8bed-7323-8c9d-853c1e7a9edf");
        assert_eq!(m.cli_version.as_deref(), Some("0.20.0"));
        assert_eq!(m.title.as_deref(), Some("做点事"));
        assert_eq!(m.chain_count, 1);
        assert!(!m.archived);
        assert_eq!(fork, None);
        let u = m.token_usage.unwrap();
        assert_eq!(
            (u.input, u.output, u.cache_read, u.cache_write),
            (50, 8, 4, 2)
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_archived_flag_comes_from_directory() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("rollout-x.jsonl");
        std::fs::write(
            &file,
            r#"{"type":"session_meta","payload":{"id":"t1","cwd":"/tmp/p","forked_from_id":"t0"}}"#,
        )
        .unwrap();
        let (m, fork) = codex_file_meta(&file, true, true).unwrap();
        assert!(
            m.archived,
            "archived_sessions 目录扫描出的文件必须带 archived 标记"
        );
        assert!(m.alive, "归档不等于已失效");
        assert_eq!(fork.as_deref(), Some("t0"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_title_skips_pasted_history_blob() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("rollout-x.jsonl");
        let content = concat!(
            r#"{"type":"session_meta","payload":{"id":"t1","cwd":"/tmp/p"}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"The following is the Codex agent history whose request actions..."}]}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"真正的提问"}]}}"#,
            "\n",
        );
        std::fs::write(&file, content).unwrap();
        let (m, _) = codex_file_meta(&file, true, false).unwrap();
        assert_eq!(
            m.title.as_deref(),
            Some("真正的提问"),
            "粘贴的导出历史不能作标题"
        );

        let file2 = dir.join("rollout-y.jsonl");
        let content2 = concat!(
            r#"{"type":"session_meta","payload":{"id":"t2","cwd":"/tmp/p"}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"The following is the Claude Code history..."}]}}"#,
            "\n",
        );
        std::fs::write(&file2, content2).unwrap();
        let (m2, _) = codex_file_meta(&file2, true, false).unwrap();
        assert_eq!(m2.title, None, "全是粘贴历史时标题为空");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== Codex resume/fork 链合并 =====

    fn codex_meta(id: &str, updated: &str, fork: Option<&str>) -> (SessionMetaDto, Option<String>) {
        (
            SessionMetaDto {
                agent: "codex".into(),
                session_id: id.into(),
                project_path: "/tmp/p".into(),
                cwd: Some("/tmp/p".into()),
                title: None,
                created_at: None,
                updated_at: Some(updated.into()),
                file_path: format!("/rollout-{id}.jsonl"),
                token_usage: None,
                cli_version: None,
                pinned: false,
                archived: false,
                custom_title: None,
                tags: Vec::new(),
                alive: true,
                chain_count: 1,
                workspace: None,
                step_name: None,
                summary: None,
                live: false,
                source: default_session_source(),
                internal: false,
                handoff_from_agent: None,
                handoff_from_session: None,
                task_id: None,
                task_name: None,
                provider: None,
                profile_id: None,
            },
            fork.map(String::from),
        )
    }

    #[test]
    fn codex_chain_merges_to_newest_representative() {
        let metas = vec![
            codex_meta("t1", "2026-07-01T00:00:00Z", None),
            codex_meta("t2", "2026-07-02T00:00:00Z", Some("t1")),
            codex_meta("t3", "2026-07-03T00:00:00Z", Some("t2")),
            codex_meta("u1", "2026-07-01T12:00:00Z", None), // 无关会话不受影响
        ];
        let (merged, members) = merge_codex_chains(metas);
        assert_eq!(merged.len(), 2);
        let rep = merged.iter().find(|m| m.chain_count == 3).unwrap();
        assert_eq!(rep.session_id, "t3", "代表是 updated_at 最新的文件");
        assert_eq!(rep.file_path, "/rollout-t3.jsonl");
        let single = merged.iter().find(|m| m.session_id == "u1").unwrap();
        assert_eq!(single.chain_count, 1);
        assert_eq!(
            members.get("t3").map(|v| v.len()),
            Some(3),
            "成员表记录链上全部 id 供 db meta 反查"
        );
        assert!(!members.contains_key("u1"), "单文件会话不进成员表");
    }

    #[test]
    fn codex_chain_survives_missing_parent_file() {
        // 父线程文件已被清理：forked_from_id 指向不存在的线程，链内剩余文件仍合并
        let metas = vec![
            codex_meta("t2", "2026-07-02T00:00:00Z", Some("t1")),
            codex_meta("t3", "2026-07-01T00:00:00Z", Some("t2")),
        ];
        let (merged, _) = merge_codex_chains(metas);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].chain_count, 2);
        assert_eq!(merged[0].session_id, "t2");
    }

    #[test]
    fn meta_written_for_chain_member_applies_to_rep() {
        // 用户归档了旧代表 t2，链换人后代表变 t3：t3 没有自己的 meta 行时要按成员 id 找回
        let metas = vec![
            codex_meta("t2", "2026-07-02T00:00:00Z", Some("t1")),
            codex_meta("t3", "2026-07-03T00:00:00Z", Some("t2")),
        ];
        let (mut merged, members) = merge_codex_chains(metas);
        let mut meta: HashMap<(String, String), MetaRow> = HashMap::new();
        meta.insert(
            ("codex".to_string(), "t2".to_string()),
            MetaRow {
                pinned: true,
                archived: true,
                custom_title: Some("旧代表上的标题".into()),
                tags: vec!["重要".into()],
                summary: None,
                handoff_from: None,
                task_id: None,
                step_name: None,
                profile_id: None,
                project_path: None,
                internal: false,
            },
        );
        apply_meta(&mut merged, &members, &meta);
        let rep = merged.iter().find(|m| m.session_id == "t3").unwrap();
        assert!(rep.pinned);
        assert!(rep.archived);
        assert_eq!(rep.custom_title.as_deref(), Some("旧代表上的标题"));
        assert_eq!(rep.tags, vec!["重要".to_string()]);
    }

    // ===== zstd / 路径 / 时间 =====

    #[test]
    fn zstd_roundtrip_parses() {
        let raw =
            b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hello zst\"}}\n"
                .to_vec();
        let compressed = zstd::stream::encode_all(&raw[..], 3).unwrap();
        assert!(compressed.starts_with(&ZSTD_MAGIC));
        let bytes = maybe_decompress(&compressed);
        let msgs = parse_claude(&to_lines(&String::from_utf8_lossy(&bytes)));
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].blocks[0].text, "hello zst");
    }

    #[test]
    fn snapshot_path_sanitizes_and_keeps_zst() {
        let p = snapshot_path("codex", "abc/def.json", true).unwrap();
        assert!(p.ends_with("snapshots/codex/abc_def_json.jsonl.zst"));
        let p2 = snapshot_path("claude-code", "sid-1", false).unwrap();
        assert!(p2.ends_with("snapshots/claude-code/sid-1.jsonl"));
    }

    #[test]
    fn iso_from_unix_formats_utc() {
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_unix(1700000000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn head_tail_splits_large_files() {
        let mut bytes = Vec::new();
        for i in 0..1000 {
            bytes.extend_from_slice(format!("{{\"n\":{i}}}\n").as_bytes());
        }
        let (head, tail) = head_tail_lines(&bytes, 1024);
        assert!(head.len() < 1000 && !head.is_empty());
        assert!(tail.len() < 1000 && !tail.is_empty());
        assert!(head
            .iter()
            .all(|l| serde_json::from_str::<Value>(l).is_ok()));
        assert!(tail
            .iter()
            .all(|l| serde_json::from_str::<Value>(l).is_ok()));
    }

    #[test]
    fn read_head_tail_matches_full_read_plain_and_zstd() {
        // 构造 >2×budget 的文件：前 100 行小行 + 中间大行 + 后 100 行
        let mut text = String::new();
        for i in 0..100 {
            text.push_str(&format!("{{\"n\":{i}}}\n"));
        }
        text.push_str(&"x".repeat(600 * 1024));
        text.push('\n');
        for i in 100..200 {
            text.push_str(&format!("{{\"n\":{i}}}\n"));
        }
        let dir = std::env::temp_dir().join(format!("ccode-ht-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // 普通文件：窗口化读取的头尾与全量读取的头尾一致
        let plain = dir.join("a.jsonl");
        std::fs::write(&plain, &text).unwrap();
        let (h1, t1) = read_head_tail(&plain, 64 * 1024).unwrap();
        let full = std::fs::read(&plain).unwrap();
        let (h2, t2) = head_tail_lines(&full, 64 * 1024);
        assert_eq!(h1, h2);
        assert_eq!(t1, t2);
        // zstd 压缩：流式解码的头尾与全量解压的头尾一致
        let zst = dir.join("a.jsonl.zst");
        let mut enc = zstd::stream::write::Encoder::new(Vec::new(), 3).unwrap();
        std::io::Write::write_all(&mut enc, text.as_bytes()).unwrap();
        let compressed = enc.finish().unwrap();
        std::fs::write(&zst, &compressed).unwrap();
        let (h3, t3) = read_head_tail(&zst, 64 * 1024).unwrap();
        let (h4, t4) = head_tail_lines(&maybe_decompress(&compressed), 64 * 1024);
        assert_eq!(h3, h4, "zstd 头窗应与全量解压一致");
        assert_eq!(t3, t4, "zstd 尾窗应与全量解压一致");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn last_lines_reads_tail_window_for_large_files() {
        let dir = std::env::temp_dir().join(format!("ccode-ll-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // 大文件（>2×budget）：返回对齐后的尾窗，不是全量
        let big = dir.join("big.jsonl");
        let mut text = String::new();
        for i in 0..4000 {
            text.push_str(&format!("{{\"n\":{i},\"pad\":\"{}\"}}\n", "x".repeat(60)));
        }
        std::fs::write(&big, &text).unwrap();
        assert!(text.len() > 128 * 1024);
        let lines = last_lines(&big, 64 * 1024);
        assert!(!lines.is_empty());
        assert!(lines.len() < 4000, "大文件只回尾窗，不全量");
        assert!(
            lines
                .iter()
                .all(|l| serde_json::from_str::<Value>(l).is_ok()),
            "尾窗对齐后每行都是完整 JSON"
        );
        assert!(
            lines.last().is_some_and(|l| l.contains("\"n\":3999")),
            "尾窗必须含文件末尾"
        );
        // 小文件照旧全量
        let small = dir.join("small.jsonl");
        std::fs::write(&small, "{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n").unwrap();
        assert_eq!(last_lines(&small, 64 * 1024).len(), 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== Gemini =====

    #[test]
    fn gemini_parse_rewind_truncates_and_tokens_map() {
        let lines = s(&[
            r#"{"sessionId":"g1","startTime":"2026-07-21T02:46:00Z","lastUpdated":"..."}"#,
            r#"{"id":"m1","timestamp":"2026-07-21T02:46:01Z","type":"user","content":"第一问"}"#,
            r#"{"id":"m2","timestamp":"2026-07-21T02:46:02Z","type":"gemini","content":"第一答","tokens":{"input":100,"output":20,"cached":10,"thoughts":5,"tool":0,"total":135},"model":"gemini-3"}"#,
            r#"{"id":"m3","timestamp":"2026-07-21T02:46:03Z","type":"user","content":"第二问（被回滚）"}"#,
            r#"{"$rewindTo":"m2"}"#,
            r#"{"id":"m4","timestamp":"2026-07-21T02:46:04Z","type":"user","content":"改问这个"}"#,
            r#"{"id":"m5","timestamp":"2026-07-21T02:46:05Z","type":"gemini","content":[{"text":"part1"},{"text":"part2"}],"toolCalls":[{"name":"read_file","args":{"path":"/a"},"result":"file body"}]}"#,
            r#"{"id":"m6","timestamp":"2026-07-21T02:46:06Z","type":"info","content":"忽略"}"#,
            r#"{"id":"m7","timestamp":"2026-07-21T02:46:07Z","type":"gemini","content":"截断"#, // 截断末行
        ]);
        let msgs = parse_gemini(&lines);
        // m2 起的消息被 $rewindTo 删除，之后 m4/m5 正常接续
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].blocks[0].text, "第一问");
        assert_eq!(msgs[1].blocks[0].text, "改问这个");
        let g = &msgs[2];
        assert_eq!(g.role, "assistant");
        assert_eq!(g.blocks[0].text, "part1\npart2");
        assert_eq!(g.blocks[1].kind, "tool_use");
        assert_eq!(g.blocks[1].tool_name.as_deref(), Some("read_file"));
        assert_eq!(g.blocks[2].kind, "tool_result");
        assert_eq!(g.blocks[2].text, "file body");
        // tokens 映射来自被回滚前 m2 之外——这里验证 m5 无 tokens 时 usage 为空，
        // 另起一条只含 tokens 的场景验证映射
        assert!(g.usage.is_none());
        let with_tokens = parse_gemini(&s(&[
            r#"{"id":"a","type":"gemini","content":"答","tokens":{"input":100,"output":20,"cached":10,"thoughts":5,"tool":0,"total":135}}"#,
        ]));
        let u = with_tokens[0].usage.as_ref().unwrap();
        assert_eq!(
            (u.input, u.output, u.cache_read, u.cache_write),
            (100, 20, 10, 0)
        );
    }

    #[test]
    fn gemini_slug_map_from_projects_json_and_marker() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let tmp = dir.join(".gemini").join("tmp");
        std::fs::create_dir_all(tmp.join("slug-a")).unwrap();
        std::fs::create_dir_all(tmp.join("slug-b")).unwrap();
        std::fs::write(
            dir.join(".gemini").join("projects.json"),
            r#"{"projects":{"/abs/path/a":"slug-a"}}"#,
        )
        .unwrap();
        std::fs::write(tmp.join("slug-b").join(".project_root"), "/abs/path/b\n").unwrap();
        let map = gemini_slug_map(&tmp);
        assert_eq!(map.get("slug-a").map(String::as_str), Some("/abs/path/a"));
        assert_eq!(map.get("slug-b").map(String::as_str), Some("/abs/path/b"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gemini_meta_summary_title_and_directories_fallback() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let chats = dir.join("tmp").join("some-slug").join("chats");
        std::fs::create_dir_all(&chats).unwrap();
        let file = chats.join("session-x.jsonl");
        let content = concat!(
            r#"{"sessionId":"g1","startTime":"2026-07-21T02:46:00Z","directories":["/abs/proj"]}"#,
            "\n",
            r#"{"id":"m1","timestamp":"2026-07-21T02:46:01Z","type":"user","content":"问点什么"}"#,
            "\n",
            r#"{"$set":{"summary":"AI 摘要标题","lastUpdated":"2026-07-21T03:00:00Z"}}"#,
            "\n",
        );
        std::fs::write(&file, content).unwrap();
        // 空映射 → 走 metadata.directories 兜底
        let m = gemini_file_meta(&file, true, &HashMap::new()).unwrap();
        assert_eq!(m.project_path, "/abs/proj");
        assert_eq!(m.session_id, "g1");
        assert_eq!(
            m.title.as_deref(),
            Some("AI 摘要标题"),
            "$set 的 summary 优先于首条用户消息"
        );
        assert_eq!(m.created_at.as_deref(), Some("2026-07-21T02:46:00Z"));
        // slug 映射命中时优先于 directories；映射和 directories 都没有则跳过该会话
        let mut map = HashMap::new();
        map.insert("some-slug".to_string(), "/mapped/proj".to_string());
        let m2 = gemini_file_meta(&file, true, &map).unwrap();
        assert_eq!(m2.project_path, "/mapped/proj");
        let file2 = chats.join("session-y.jsonl");
        std::fs::write(&file2, r#"{"sessionId":"g2","startTime":"t"}"#).unwrap();
        assert!(gemini_file_meta(&file2, true, &HashMap::new()).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gemini_duplicate_files_collapse_by_session_id() {
        let older = claim_test_session(
            "gemini",
            "same-session",
            "/tmp/project",
            "2026-08-21T07:00:00Z",
        );
        let newer = claim_test_session(
            "gemini",
            "same-session",
            "/tmp/project",
            "2026-08-21T07:04:00Z",
        );
        let mut out = dedupe_gemini_sessions(vec![newer, older]);
        assert_eq!(out.len(), 1);
        assert_eq!(
            out.pop().unwrap().updated_at.as_deref(),
            Some("2026-08-21T07:04:00Z")
        );

        let different = claim_test_session(
            "gemini",
            "different-session",
            "/tmp/project",
            "2026-08-21T07:05:00Z",
        );
        assert_eq!(dedupe_gemini_sessions(vec![different]).len(), 1);
    }

    // ===== Qwen =====

    #[test]
    fn qwen_parse_blocks_usage_and_sidechain() {
        let lines = s(&[
            r#"{"uuid":"1","sessionId":"q1","timestamp":"2026-07-01T00:00:00Z","type":"user","cwd":"/tmp/proj","version":"0.10.0","message":{"role":"user","parts":[{"text":"帮我写代码"}]}}"#,
            r#"{"uuid":"2","sessionId":"q1","type":"assistant","message":{"role":"model","parts":[{"text":"想想","thought":true},{"text":"好的"},{"functionCall":{"name":"write_file","args":{"path":"/a"}}}]},"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":10,"cachedContentTokenCount":5}}"#,
            r#"{"uuid":"3","sessionId":"q1","type":"tool_result","message":{"role":"tool","parts":[{"functionResponse":{"name":"write_file","response":{"ok":true}}}]}}"#,
            r#"{"uuid":"4","sessionId":"q1","type":"user","isSidechain":true,"message":{"role":"user","parts":[{"text":"支线"}]}}"#,
            r#"{"uuid":"5","sessionId":"q1","type":"system","subtype":"custom_title","systemPayload":{"customTitle":"自定义标题"}}"#,
            r#"{"uuid":"6","sessionId":"q1","type":"assistant","message":{"role":"model","parts":[{"text":"截断"#, // 截断末行
        ]);
        let msgs = parse_qwen(&lines);
        assert_eq!(
            msgs.len(),
            2,
            "sidechain/system/截断行跳过，tool_result 并入上一条"
        );
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].text, "帮我写代码");
        let a = &msgs[1];
        assert_eq!(a.role, "assistant");
        assert_eq!(a.blocks[0].kind, "thinking");
        assert_eq!(a.blocks[1].kind, "text");
        assert_eq!(a.blocks[2].kind, "tool_use");
        assert_eq!(a.blocks[2].tool_name.as_deref(), Some("write_file"));
        assert_eq!(a.blocks[3].kind, "tool_result");
        let u = a.usage.as_ref().unwrap();
        assert_eq!(
            (u.input, u.output, u.cache_read, u.cache_write),
            (50, 10, 5, 0)
        );
    }

    #[test]
    fn qwen_meta_custom_title_cwd_version_and_archive() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let chats = dir
            .join("projects")
            .join("-tmp-proj")
            .join("chats")
            .join("archive");
        std::fs::create_dir_all(&chats).unwrap();
        let file = chats.join("q1.jsonl");
        let content = concat!(
            r#"{"uuid":"1","sessionId":"q1","timestamp":"2026-07-01T00:00:00Z","type":"user","cwd":"/tmp/proj","version":"0.10.0","message":{"role":"user","parts":[{"text":"首条提问"}]}}"#,
            "\n",
            r#"{"uuid":"2","sessionId":"q1","type":"system","subtype":"custom_title","systemPayload":{"customTitle":"我的会话"}}"#,
            "\n",
            r#"{"uuid":"3","sessionId":"q1","type":"assistant","message":{"role":"model","parts":[{"text":"答"}]},"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":3}}"#,
            "\n",
        );
        std::fs::write(&file, content).unwrap();
        let m = qwen_file_meta(&file, true, true).unwrap();
        assert_eq!(
            m.project_path, "/tmp/proj",
            "项目归属以首条记录 cwd 为准，不解码目录名"
        );
        assert_eq!(m.session_id, "q1");
        assert_eq!(m.cli_version.as_deref(), Some("0.10.0"));
        assert_eq!(
            m.title.as_deref(),
            Some("我的会话"),
            "custom_title 覆盖首条用户消息"
        );
        assert!(m.archived);
        assert!(m.alive);
        let u = m.token_usage.unwrap();
        assert_eq!((u.input, u.output), (9, 3));
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== Kimi =====

    #[test]
    fn kimi_wire_parse_dedup_injection_tools_usage() {
        let lines = s(&[
            r#"{"type":"metadata","protocol_version":"1.4","created_at":1785307071000}"#,
            r#"{"type":"turn.prompt","input":[{"type":"text","text":"第一问"}],"origin":{"kind":"user"},"time":1785307072000}"#,
            r#"{"type":"context.append_message","message":{"role":"user","origin":{"kind":"user"},"content":[{"type":"text","text":"第一问"}]},"time":1785307072001}"#, // prompt 回显，去重
            r#"{"type":"context.append_message","message":{"role":"user","origin":{"kind":"injection"},"content":[{"type":"text","text":"<system-reminder>注入</system-reminder>"}]},"time":1785307072002}"#,
            r#"{"type":"context.append_message","message":{"role":"assistant","content":[{"type":"think","think":"想想"},{"type":"text","text":"好的"}],"toolCalls":[{"function":{"name":"Read","arguments":"{\"path\":\"/a\"}"}}]},"time":1785307073000}"#,
            r#"{"type":"context.append_message","message":{"role":"tool","content":[{"type":"text","text":"file body"}]},"time":1785307074000}"#,
            r#"{"type":"usage.record","usage":{"inputOther":100,"output":20,"inputCacheRead":10,"inputCacheCreation":5},"time":1785307075000}"#,
            r#"{"type":"turn.prompt","input":[{"type":"text","text":"slash 命令"}],"origin":{"kind":"slash"},"time":1785307076000}"#, // 非 user 来源跳过
            r#"{"type":"turn.prompt","input":[{"type":"text","text":"截断"#, // 截断末行
        ]);
        let msgs = parse_kimi(&lines);
        assert_eq!(msgs.len(), 2, "回显/注入/slash/截断行都要处理掉");
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].text, "第一问");
        assert_eq!(msgs[0].timestamp.as_deref(), Some("2026-07-29T06:37:52Z"));
        let a = &msgs[1];
        assert_eq!(a.role, "assistant");
        assert_eq!(a.blocks[0].kind, "thinking");
        assert_eq!(a.blocks[1].kind, "text");
        assert_eq!(a.blocks[2].kind, "tool_use");
        assert_eq!(a.blocks[2].tool_name.as_deref(), Some("Read"));
        assert_eq!(a.blocks[2].text, "{\"path\":\"/a\"}");
        assert_eq!(a.blocks[3].kind, "tool_result");
        assert_eq!(a.blocks[3].text, "file body");
        let u = a.usage.as_ref().unwrap();
        assert_eq!(
            (u.input, u.output, u.cache_read, u.cache_write),
            (100, 20, 10, 5)
        );
    }

    #[test]
    fn kimi_wire_parse_loop_events() {
        // 新协议：assistant 输出走 append_loop_event 流式事件（step.begin/content.part/tool.call/tool.result/step.end）
        let lines = s(&[
            r#"{"type":"metadata","protocol_version":"1.4","created_at":1785307071000}"#,
            r#"{"type":"turn.prompt","input":[{"type":"text","text":"跑一下测试"}],"origin":{"kind":"user"},"time":1785307072000}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"step.begin","step":1},"time":1785307072100}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"think","think":"先想"}},"time":1785307072200}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"我来跑"}},"time":1785307072300}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"tool.call","name":"Bash","args":{"command":"cargo test"}},"time":1785307072400}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"tool.result","result":{"output":"ok 70 passed"}},"time":1785307072500}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":500,"output":60,"inputCacheRead":7,"inputCacheCreation":3}},"time":1785307072600}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"step.begin","step":2},"time":1785307072700}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"全绿"}},"time":1785307072800}"#,
        ]);
        let msgs = parse_kimi(&lines);
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].role, "user");
        let a1 = &msgs[1];
        assert_eq!(a1.blocks[0].kind, "thinking");
        assert_eq!(a1.blocks[1].kind, "text");
        assert_eq!(a1.blocks[2].kind, "tool_use");
        assert_eq!(a1.blocks[2].tool_name.as_deref(), Some("Bash"));
        assert_eq!(a1.blocks[2].text, "{\"command\":\"cargo test\"}");
        assert_eq!(a1.blocks[3].kind, "tool_result");
        assert_eq!(a1.blocks[3].text, "ok 70 passed");
        let u = a1.usage.as_ref().unwrap();
        assert_eq!(
            (u.input, u.output, u.cache_read, u.cache_write),
            (500, 60, 7, 3)
        );
        assert_eq!(
            msgs[2].blocks[0].text, "全绿",
            "第二个 step 是独立的一条 assistant 消息"
        );
    }

    #[test]
    fn kimi_wire_meta_title_from_state_json() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let main = dir.join("session_abc").join("agents").join("main");
        std::fs::create_dir_all(&main).unwrap();
        let wire = main.join("wire.jsonl");
        std::fs::write(
            &wire,
            concat!(
                r#"{"type":"metadata","protocol_version":"1.4","created_at":1785307071000}"#,
                "\n",
                r#"{"type":"turn.prompt","input":[{"type":"text","text":"首条输入"}],"origin":{"kind":"user"},"time":1785307072000}"#,
                "\n",
                r#"{"type":"usage.record","usage":{"inputOther":7,"output":3}}"#,
                "\n",
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join("session_abc").join("state.json"),
            r#"{"createdAt":1785307071000,"title":"AI 起的标题"}"#,
        )
        .unwrap();
        let state: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("session_abc").join("state.json")).unwrap(),
        )
        .unwrap();
        let m = kimi_wire_file_meta(&wire, true, "abc", "/proj/x".into(), Some(&state)).unwrap();
        assert_eq!(m.agent, "kimi");
        assert_eq!(m.project_path, "/proj/x");
        assert_eq!(
            m.title.as_deref(),
            Some("AI 起的标题"),
            "state.json 标题优先"
        );
        assert_eq!(m.created_at.as_deref(), Some("2026-07-29T06:37:51Z"));
        let u = m.token_usage.unwrap();
        assert_eq!((u.input, u.output), (7, 3));
        // 无 state 时回落首条用户输入
        let m2 = kimi_wire_file_meta(&wire, true, "abc", "/proj/x".into(), None).unwrap();
        assert_eq!(m2.title.as_deref(), Some("首条输入"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn kimi_legacy_parse_and_buckets() {
        // md5("/tmp/proj") 预计算值，验证 bucket 反查规则
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let kimi_json = dir.join("kimi.json");
        std::fs::write(&kimi_json, r#"{"work_dirs":[{"path":"/tmp/proj"}]}"#).unwrap();
        let buckets = kimi_workdir_buckets(&kimi_json);
        assert_eq!(
            buckets
                .get("d5ebc5292b750d2bb41a2557ca31bcac")
                .map(String::as_str),
            Some("/tmp/proj")
        );
        std::fs::remove_dir_all(&dir).ok();

        let lines = s(&[
            r#"{"role":"_init","content":"内部记录"}"#,
            r#"{"role":"user","content":"旧版提问"}"#,
            r#"{"role":"assistant","content":[{"type":"text","text":"旧版回答"}],"tool_calls":[{"function":{"name":"Bash","arguments":"{\"cmd\":\"ls\"}"}}]}"#,
            r#"{"role":"tool","content":"total 0"}"#,
            r#"{"role":"_usage","usage":{"input_tokens":42,"output_tokens":9}}"#,
        ]);
        let msgs = parse_kimi_legacy(&lines);
        assert_eq!(msgs.len(), 2, "_ 开头的内部角色跳过，tool 并入上一条");
        assert_eq!(msgs[0].blocks[0].text, "旧版提问");
        let a = &msgs[1];
        assert_eq!(a.blocks[1].kind, "tool_use");
        assert_eq!(a.blocks[1].tool_name.as_deref(), Some("Bash"));
        assert_eq!(a.blocks[2].kind, "tool_result");
        let u = a.usage.as_ref().unwrap();
        assert_eq!((u.input, u.output), (42, 9));
    }

    #[test]
    fn kimi_variant_sniffing() {
        assert!(kimi_looks_like_wire(&s(&[r#"{"type":"metadata"}"#])));
        assert!(!kimi_looks_like_wire(&s(&[
            r#"{"role":"user","content":"x"}"#
        ])));
    }

    // ===== 删除路径校验 =====

    #[test]
    fn delete_refuses_paths_outside_session_data_dirs() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x.jsonl");
        std::fs::write(&f, "{}").unwrap();
        let err = delete_source_file(f.to_str().unwrap()).unwrap_err();
        assert!(
            err.contains("拒绝删除"),
            "会话数据目录外的文件必须拒绝: {err}"
        );
        assert!(f.exists(), "被拒绝的文件不能被删");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deletable_session_file_requires_data_dir_and_session_suffix() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        // 模拟 ~/.codex、~/.kimi-code、opencode legacy storage 的布局
        let codex_chats = dir
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("08")
            .join("04");
        std::fs::create_dir_all(&codex_chats).unwrap();
        let rollout = codex_chats.join("rollout-x.jsonl");
        std::fs::write(&rollout, "{}").unwrap();
        let auth = dir.join(".codex").join("auth.json");
        std::fs::write(&auth, "{}").unwrap();
        let kimi_main = dir
            .join(".kimi-code")
            .join("sessions")
            .join("s1")
            .join("agents")
            .join("main");
        std::fs::create_dir_all(&kimi_main).unwrap();
        let wire = kimi_main.join("wire.jsonl");
        std::fs::write(&wire, "{}").unwrap();
        let index = dir.join(".kimi-code").join("session_index.jsonl");
        std::fs::write(&index, "{}").unwrap();
        let state = dir
            .join(".kimi-code")
            .join("sessions")
            .join("s1")
            .join("state.json");
        std::fs::write(&state, "{}").unwrap();
        let storage = dir.join("storage").join("session").join("p1");
        std::fs::create_dir_all(&storage).unwrap();
        let ses_json = storage.join("ses_1.json");
        std::fs::write(&ses_json, "{}").unwrap();
        let cb_proj = dir.join(".codebuddy").join("projects").join("-tmp-x");
        std::fs::create_dir_all(&cb_proj).unwrap();
        let cb_session = cb_proj.join("u1.jsonl");
        std::fs::write(&cb_session, "{}").unwrap();
        let cb_creds = dir.join(".codebuddy").join(".credentials.json");
        std::fs::write(&cb_creds, "{}").unwrap();
        let notes = codex_chats.join("notes.txt");
        std::fs::write(&notes, "x").unwrap();
        let dirs = vec![
            (dir.join(".codex").join("sessions"), false),
            (dir.join(".kimi-code").join("sessions"), false),
            (dir.join("storage"), true),
            (dir.join(".codebuddy").join("projects"), false),
        ];
        assert!(deletable_session_file(&rollout, &dirs));
        assert!(deletable_session_file(&wire, &dirs));
        assert!(
            deletable_session_file(&ses_json, &dirs),
            "legacy storage 放行 .json"
        );
        assert!(
            deletable_session_file(&cb_session, &dirs),
            "codebuddy projects/<slug>/*.jsonl 放行"
        );
        assert!(
            !deletable_session_file(&cb_creds, &dirs),
            ".codebuddy 根上的凭证文件必须拒绝"
        );
        assert!(
            !deletable_session_file(&auth, &dirs),
            "同 CLI 根下的 auth.json 必须拒绝"
        );
        assert!(
            !deletable_session_file(&index, &dirs),
            "根上的 session_index.jsonl 必须拒绝"
        );
        assert!(
            !deletable_session_file(&state, &dirs),
            "未放行 .json 的目录里 state.json 必须拒绝"
        );
        assert!(!deletable_session_file(&notes, &dirs), "后缀不符必须拒绝");
        assert!(
            !deletable_session_file(&codex_chats.join("ghost.jsonl"), &dirs),
            "不存在的路径（canonicalize 失败）必须拒绝"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_member_files_match_rollout_tail_uuid() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let chats = dir.join("sessions").join("2026").join("08").join("04");
        std::fs::create_dir_all(&chats).unwrap();
        let id = "019f8039-8bed-7323-8c9d-853c1e7a9edf";
        let f1 = chats.join(format!("rollout-2026-08-04T00-00-00-{id}.jsonl"));
        let f2 = chats.join(format!("rollout-2026-08-04T01-00-00-{id}.jsonl.zst"));
        let other =
            chats.join("rollout-2026-08-04T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
        for f in [&f1, &f2, &other] {
            std::fs::write(f, "{}").unwrap();
        }
        let roots = vec![dir.join("sessions")];
        let found = codex_member_files_in(&roots, &[id.to_string()]);
        assert_eq!(
            found.len(),
            2,
            "同 uuid 的 .jsonl 与 .jsonl.zst 都命中: {found:?}"
        );
        assert!(found.contains(&f1) && found.contains(&f2));
        assert!(!found.contains(&other), "无关 uuid 不能命中");
        assert!(codex_member_files_in(&roots, &[]).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opencode_delete_removes_rows_and_rejects_unknown_db() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = opencode_fixture_db(&dir);
        // 非已知 OpenCode 库候选：整批拒绝且行不动
        let err = delete_opencode_rows(&db, "ses_1").unwrap_err();
        assert!(err.contains("拒绝"), "未知库必须拒绝: {err}");
        assert!(
            !opencode_parse_db(&db, "ses_1").is_empty(),
            "被拒绝后行必须还在"
        );
        // 删行本身：session/message/part 三表清掉目标会话，其他会话不受影响
        delete_opencode_rows_impl(&db, "ses_1").unwrap();
        let conn = open_opencode_db(&db).unwrap();
        assert!(query_rows(&conn, "SELECT * FROM session WHERE id='ses_1'", &[]).is_empty());
        assert!(
            query_rows(&conn, "SELECT * FROM message WHERE session_id='ses_1'", &[]).is_empty()
        );
        assert!(query_rows(&conn, "SELECT * FROM part WHERE session_id='ses_1'", &[]).is_empty());
        assert_eq!(
            query_rows(&conn, "SELECT * FROM session WHERE id='ses_2'", &[]).len(),
            1,
            "其他会话不受影响"
        );
        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opencode_db_candidates_include_platform_paths() {
        let cands = opencode_db_candidates();
        assert!(!cands.is_empty());
        assert!(opencode_db_path().is_some());
        #[cfg(windows)]
        {
            if let Some(local) = dirs::data_local_dir() {
                let root = local.join("opencode");
                assert!(
                    cands
                        .iter()
                        .any(|p| crate::paths::path_within_path(p, &root)),
                    "Windows 应探 %LOCALAPPDATA%\\opencode: {cands:?}"
                );
            }
        }
        if let Some(h) = dirs::home_dir() {
            assert!(
                cands.iter().any(|p| p.ends_with(
                    std::path::Path::new(".local")
                        .join("share")
                        .join("opencode")
                        .join("opencode.db")
                ) || crate::paths::path_within_path(
                    p,
                    &h.join(".local").join("share").join("opencode")
                )),
                "应保留 unix 形态回落: {cands:?}"
            );
        }
    }

    #[test]
    fn expand_tilde_accepts_forward_and_backslash() {
        let home = dirs::home_dir().unwrap().to_string_lossy().into_owned();
        assert_eq!(expand_tilde("~"), home);
        assert_eq!(expand_tilde("~/x"), format!("{home}/x"));
        assert_eq!(
            expand_tilde("~\\x"),
            format!("{home}\\x"),
            "Windows 风格 ~\\ 也要展开"
        );
        assert_eq!(expand_tilde("/abs/path"), "/abs/path");
        assert_eq!(
            expand_tilde("~other"),
            "~other",
            "~other 不是当前用户家目录，不展开"
        );
    }

    #[test]
    fn worktree_sessions_rewrite_to_real_repo() {
        let rows = vec![
            crate::workspaces::WorktreeRow {
                id: "ws-1".into(),
                worktree_path: "/home/u/ccode/workspaces/myrepo/feat-x".into(),
                repo_path: "/home/u/code/myrepo".into(),
                name: "feat-x".into(),
                branch: "ccode/feat-x".into(),
                base_branch: "main".into(),
            },
            crate::workspaces::WorktreeRow {
                id: "ws-2".into(),
                worktree_path: "/home/u/ccode/workspaces/other/task".into(),
                repo_path: "/home/u/code/other".into(),
                name: "task".into(),
                branch: "ccode/task".into(),
                base_branch: "main".into(),
            },
        ];
        // worktree 根命中
        let hit = resolve_worktree_project("/home/u/ccode/workspaces/myrepo/feat-x", &rows);
        assert_eq!(hit, Some(("/home/u/code/myrepo".into(), "feat-x".into())));
        // worktree 子目录也命中
        let sub = resolve_worktree_project("/home/u/ccode/workspaces/other/task/src", &rows);
        assert_eq!(sub, Some(("/home/u/code/other".into(), "task".into())));
        // 普通项目路径不受影响；相似前缀（feat-xy）不误判
        assert!(resolve_worktree_project("/home/u/code/myrepo", &rows).is_none());
        assert!(
            resolve_worktree_project("/home/u/ccode/workspaces/myrepo/feat-xy", &rows).is_none()
        );
        assert!(resolve_worktree_project("/anywhere", &[]).is_none());
    }

    #[test]
    fn worktree_resolve_accepts_backslash_separator() {
        // Windows：worktree 路径与会话 cwd 都用 '\'（且 worktree 路径可能带尾部分隔符）
        let rows = vec![crate::workspaces::WorktreeRow {
            id: "ws-w".into(),
            worktree_path: "C:\\ccode\\workspaces\\myrepo\\feat-x\\".into(),
            repo_path: "C:\\code\\myrepo".into(),
            name: "feat-x".into(),
            branch: "ccode/feat-x".into(),
            base_branch: "main".into(),
        }];
        let hit = resolve_worktree_project("C:\\ccode\\workspaces\\myrepo\\feat-x\\src", &rows);
        assert_eq!(hit, Some(("C:\\code\\myrepo".into(), "feat-x".into())));
        let root = resolve_worktree_project("C:\\ccode\\workspaces\\myrepo\\feat-x", &rows);
        assert!(root.is_some(), "尾部 '\\' 已归一，根路径本身也命中");
        assert!(
            resolve_worktree_project("C:\\ccode\\workspaces\\myrepo\\feat-xy", &rows).is_none()
        );
    }

    fn live_meta(agent: &str, updated_at: Option<&str>, live: bool) -> SessionMetaDto {
        SessionMetaDto {
            agent: agent.into(),
            session_id: "s1".into(),
            project_path: "/p".into(),
            cwd: Some("/p".into()),
            title: None,
            created_at: None,
            updated_at: updated_at.map(str::to_string),
            file_path: "/p/s1.jsonl".into(),
            token_usage: None,
            cli_version: None,
            pinned: false,
            archived: false,
            custom_title: None,
            tags: Vec::new(),
            alive: true,
            chain_count: 1,
            workspace: None,
            step_name: None,
            summary: None,
            live,
            source: default_session_source(),
            internal: false,
            handoff_from_agent: None,
            handoff_from_session: None,
            task_id: None,
            task_name: None,
            provider: None,
            profile_id: None,
        }
    }

    #[test]
    fn refresh_live_flag_does_not_freeze_stale_cache() {
        let now = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let mut stale = live_meta(
            "codex",
            Some(&iso_from_unix(now.saturating_sub(3600))),
            true,
        );
        refresh_live_flag(&mut stale);
        assert!(!stale.live, "一小时前的 updated_at 不得继续亮绿点");

        let mut fresh = live_meta("codex", Some(&iso_from_unix(now)), false);
        refresh_live_flag(&mut fresh);
        assert!(fresh.live, "60 秒内的 updated_at 应判 live");

        let mut dead = live_meta("codex", Some(&iso_from_unix(now)), true);
        dead.alive = false;
        refresh_live_flag(&mut dead);
        assert!(!dead.live, "源文件已失效即使时间新也不 live");
    }

    #[test]
    fn live_flag_from_fresh_mtime() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s1.jsonl");
        std::fs::write(
            &file,
            r#"{"type":"user","cwd":"/tmp/p","sessionId":"s1","timestamp":"2026-07-01T00:00:00Z","message":{"role":"user","content":"hi"}}"#,
        )
        .unwrap();
        // 刚写的文件 → live
        let m = claude_file_meta(&file, true).unwrap();
        assert!(m.live, "60 秒内的 mtime 应判 live");
        // 把 mtime 拨到一小时前 → 不 live
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let m = claude_file_meta(&file, true).unwrap();
        assert!(!m.live);
        // 死会话（alive=false）即使 mtime 新也不 live
        let m = claude_file_meta(&file, false).unwrap();
        assert!(!m.live);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn qwen_live_via_runtime_sidecar() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("q1.jsonl");
        std::fs::write(
            &file,
            r#"{"uuid":"1","sessionId":"q1","type":"user","cwd":"/tmp/p","message":{"role":"user","parts":[{"text":"hi"}]}}"#,
        )
        .unwrap();
        // 旧 mtime + 无 sidecar → 不 live
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert!(!qwen_file_meta(&file, true, false).unwrap().live);
        // sidecar 出现 → live
        std::fs::write(dir.join("q1.runtime.json"), "{}").unwrap();
        assert!(
            qwen_file_meta(&file, true, false).unwrap().live,
            "runtime sidecar 应判 live"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn session_meta_summary_migration_and_merge() {
        // 模拟旧库：没有 summary/summary_at 列，迁移应幂等补上
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("app.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta(
              agent TEXT NOT NULL, session_id TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
              custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
              note TEXT, pinned_at TEXT,
              PRIMARY KEY(agent, session_id));",
        )
        .unwrap();
        migrate_session_meta(&conn);
        migrate_session_meta(&conn); // 第二次不报错（幂等）
        conn.execute(
            "INSERT INTO session_meta(agent, session_id, summary, summary_at)
             VALUES('codex', 's1', 'AI 摘要内容', '2026-07-30T00:00:00Z')",
            [],
        )
        .unwrap();
        let meta = read_all_meta(&conn);
        let row = meta.get(&("codex".to_string(), "s1".to_string())).unwrap();
        assert_eq!(row.summary.as_deref(), Some("AI 摘要内容"));
        // apply_meta 合并进 DTO
        let (mut merged, _) =
            merge_codex_chains(vec![codex_meta("s1", "2026-07-03T00:00:00Z", None)]);
        apply_meta(&mut merged, &HashMap::new(), &meta);
        assert_eq!(merged[0].summary.as_deref(), Some("AI 摘要内容"));
        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn session_meta_task_id_migration_assign_and_clear() {
        // 模拟旧库：没有 task_id 列，迁移幂等补上
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta(
              agent TEXT NOT NULL, session_id TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
              custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
              note TEXT, pinned_at TEXT,
              PRIMARY KEY(agent, session_id));",
        )
        .unwrap();
        migrate_session_meta(&conn);
        migrate_session_meta(&conn); // 第二次不报错（幂等）

        // 归卡 → 移出（None 与空白串等价）→ 再归卡
        assign_session_task_at(&conn, "codex", "s1", Some("t-a1")).unwrap();
        let meta = read_all_meta(&conn);
        assert_eq!(
            meta.get(&("codex".to_string(), "s1".to_string()))
                .unwrap()
                .task_id
                .as_deref(),
            Some("t-a1")
        );
        assign_session_task_at(&conn, "codex", "s1", None).unwrap();
        assign_session_task_at(&conn, "codex", "s1", Some("   ")).unwrap();
        let meta = read_all_meta(&conn);
        assert_eq!(
            meta.get(&("codex".to_string(), "s1".to_string()))
                .unwrap()
                .task_id,
            None
        );

        // 归卡不影响其他整理字段（upsert 只动 task_id）
        assign_session_task_at(&conn, "codex", "s1", Some("t-a1")).unwrap();
        assign_session_task_at(&conn, "claude-code", "s2", Some("t-a1")).unwrap();
        // 删卡清理：该卡所有会话摘掉失效 id，其他卡不动
        assign_session_task_at(&conn, "codex", "s3", Some("t-b2")).unwrap();
        clear_task_assignment(&conn, "t-a1").unwrap();
        let meta = read_all_meta(&conn);
        assert_eq!(
            meta.get(&("codex".to_string(), "s1".to_string()))
                .unwrap()
                .task_id,
            None
        );
        assert_eq!(
            meta.get(&("claude-code".to_string(), "s2".to_string()))
                .unwrap()
                .task_id,
            None
        );
        assert_eq!(
            meta.get(&("codex".to_string(), "s3".to_string()))
                .unwrap()
                .task_id
                .as_deref(),
            Some("t-b2"),
            "其他卡片的归卡不受影响"
        );

        // apply_meta 把 task_id 合并进 DTO
        let (mut merged, _) =
            merge_codex_chains(vec![codex_meta("s3", "2026-07-03T00:00:00Z", None)]);
        apply_meta(&mut merged, &HashMap::new(), &meta);
        assert_eq!(merged[0].task_id.as_deref(), Some("t-b2"));
    }

    /// 卡片认领：登记 → 扫描命中新会话并固化 task_id → 消费登记；
    /// 登记前旧会话/异 agent/已归卡会话不误命中，消费后同目录新会话不再误归
    #[test]
    fn card_claim_applies_once_and_consumes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta(
              agent TEXT NOT NULL, session_id TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
              custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
              note TEXT, pinned_at TEXT,
              PRIMARY KEY(agent, session_id));",
        )
        .unwrap();
        migrate_session_meta(&conn);
        claim_test_register(&conn, "codex", "/tmp/proj", "t-card1");

        // 登记前的旧会话 / 登记后的新会话 / 异 agent / 已手动归卡
        let old = claim_test_session("codex", "old", "/tmp/proj", "2000-01-01T00:00:00Z");
        let new = claim_test_session("codex", "new", "/tmp/proj", "2999-01-01T00:00:00Z");
        let other = claim_test_session("gemini", "g1", "/tmp/proj", "2999-01-01T00:00:00Z");
        let mut taken = claim_test_session("codex", "taken", "/tmp/proj", "2999-02-01T00:00:00Z");
        taken.task_id = Some("t-other".into());
        let mut sessions = vec![old, new, other, taken];
        apply_card_claims(&conn, &mut sessions);

        assert_eq!(sessions[0].task_id, None, "登记前的旧会话不得归卡");
        assert_eq!(sessions[1].task_id.as_deref(), Some("t-card1"));
        assert_eq!(sessions[2].task_id, None, "agent 不匹配不得归卡");
        assert_eq!(
            sessions[3].task_id.as_deref(),
            Some("t-other"),
            "已归卡会话不被抢占"
        );
        // 固化进 session_meta（下次列表经 apply_meta 读到）
        let meta = read_all_meta(&conn);
        assert_eq!(
            meta.get(&("codex".to_string(), "new".to_string()))
                .unwrap()
                .task_id
                .as_deref(),
            Some("t-card1")
        );
        // 登记已消费：同目录之后更新的会话不再误归
        assert!(read_card_claims(&conn).is_empty());
        let newer = claim_test_session("codex", "newer", "/tmp/proj", "2999-06-01T00:00:00Z");
        let mut sessions = vec![newer];
        apply_card_claims(&conn, &mut sessions);
        assert_eq!(sessions[0].task_id, None, "消费后登记失效");

        // 无登记的目录不受影响
        let stray = claim_test_session("codex", "stray", "/tmp/other", "2999-01-01T00:00:00Z");
        let mut sessions = vec![stray];
        apply_card_claims(&conn, &mut sessions);
        assert_eq!(sessions[0].task_id, None);
    }

    /// 同 agent+cwd 重复登记：后一次覆盖前一次（以最后一次发起为准）
    #[test]
    fn card_claim_overwrites_same_target() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta(
              agent TEXT NOT NULL, session_id TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
              custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
              note TEXT, pinned_at TEXT,
              PRIMARY KEY(agent, session_id));",
        )
        .unwrap();
        migrate_session_meta(&conn);
        claim_test_register(&conn, "kimi", "/tmp/p", "t-a");
        claim_test_register(&conn, "kimi", "/tmp/p", "t-b");
        let claims = read_card_claims(&conn);
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].task_id, "t-b");
    }

    /// 测试内登记认领（command 本体走全局库，这里直写内存库）
    fn claim_test_register(conn: &Connection, agent: &str, cwd: &str, task_id: &str) {
        ensure_card_claim_table(conn).unwrap();
        conn.execute(
            "INSERT INTO card_claims(agent, cwd, task_id, created_at) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(agent, cwd) DO UPDATE SET task_id=?3, created_at=?4",
            params![agent, cwd, task_id, now_iso()],
        )
        .unwrap();
    }

    fn claim_test_session(agent: &str, id: &str, path: &str, updated: &str) -> SessionMetaDto {
        SessionMetaDto {
            agent: agent.into(),
            session_id: id.into(),
            project_path: path.into(),
            cwd: Some(path.into()),
            title: None,
            created_at: None,
            updated_at: Some(updated.into()),
            file_path: format!("/{id}.jsonl"),
            token_usage: None,
            cli_version: None,
            pinned: false,
            archived: false,
            custom_title: None,
            tags: Vec::new(),
            alive: true,
            chain_count: 1,
            workspace: None,
            step_name: None,
            summary: None,
            live: false,
            source: default_session_source(),
            internal: false,
            handoff_from_agent: None,
            handoff_from_session: None,
            task_id: None,
            task_name: None,
            provider: None,
            profile_id: None,
        }
    }

    #[test]
    fn sessions_belonging_to_filters_by_card_and_sorts_asc() {
        // 「◈ 融合进任务书」取材范围 = 该卡名下会话（task_id 口径），不碰其他会话
        let mut a = claim_test_session("codex", "s-a", "/p", "2026-07-01T00:00:00Z");
        a.task_id = Some("t-card".into());
        let mut b = claim_test_session("claude-code", "s-b", "/p", "2026-07-03T00:00:00Z");
        b.task_id = Some("t-card".into());
        let mut other = claim_test_session("codex", "s-c", "/p", "2026-07-02T00:00:00Z");
        other.task_id = Some("t-other".into());
        let unassigned = claim_test_session("codex", "s-d", "/p", "2026-07-04T00:00:00Z");
        let out = sessions_belonging_to(vec![b.clone(), other, unassigned, a.clone()], "t-card");
        let ids: Vec<&str> = out.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(ids, vec!["s-a", "s-b"], "只取当前卡，按活跃时间升序");
        assert!(sessions_belonging_to(vec![a, b], "t-nobody").is_empty());
    }

    #[test]
    fn apply_task_names_fills_and_tolerates_deleted_card() {
        // 卡片名按项目档案卡回填；卡片已删时 task_name=None 且 task_id 保留
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let project = dir.join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let card = crate::projects::create_task_card_at(&project, "文献筛选", None, None).unwrap();

        let mut hit = codex_meta("s1", "2026-07-03T00:00:00Z", None).0;
        hit.project_path = project.to_string_lossy().into_owned();
        hit.task_id = Some(card.id.clone());
        let mut gone = codex_meta("s2", "2026-07-03T00:00:00Z", None).0;
        gone.project_path = project.to_string_lossy().into_owned();
        gone.task_id = Some("t-deleted".into());
        let mut none = codex_meta("s3", "2026-07-03T00:00:00Z", None).0;
        none.project_path = project.to_string_lossy().into_owned();

        let mut sessions = vec![hit, gone, none];
        apply_task_names(&mut sessions);
        assert_eq!(sessions[0].task_name.as_deref(), Some("文献筛选"));
        assert_eq!(sessions[1].task_name, None, "卡片已删容忍为 None");
        assert_eq!(sessions[1].task_id.as_deref(), Some("t-deleted"));
        assert_eq!(sessions[2].task_name, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_step_claims_fills_consumes_and_does_not_preempt() {
        // 「跟 AI 商量一下」等按步骤上下文发起的会话：落在项目根也能归到该步骤，同时不抢占
        // 既有 worktree 步骤归属、不把登记前的旧会话误归、不跨项目归。
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS session_meta(
              agent TEXT NOT NULL, session_id TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
              custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
              note TEXT, pinned_at TEXT,
              PRIMARY KEY(agent, session_id));",
        )
        .unwrap();
        migrate_session_meta(&conn);
        ensure_step_claim_table(&conn).unwrap();
        conn.execute(
            "INSERT INTO step_claims(agent, cwd, step_name, created_at)
             VALUES('codex', '/proj', '文献检索与筛选', '2026-07-02T00:00:00Z')",
            [],
        )
        .unwrap();

        // 命中：agent+cwd 匹配、登记之后有活动、无既有步骤归属
        let mut hit = codex_meta("s-hit", "2026-07-03T00:00:00Z", None).0;
        hit.project_path = "/proj".into();
        // 登记前的旧会话：updated_at < created_at，不命中
        let mut old = codex_meta("s-old", "2026-07-01T00:00:00Z", None).0;
        old.project_path = "/proj".into();
        // 已有 worktree 步骤归属：不抢占
        let mut owned = codex_meta("s-owned", "2026-07-05T00:00:00Z", None).0;
        owned.project_path = "/proj".into();
        owned.step_name = Some("文献精读与笔记".into());
        // 其它项目：cwd 不匹配
        let mut elsewhere = codex_meta("s-else", "2026-07-05T00:00:00Z", None).0;
        elsewhere.project_path = "/other".into();

        let mut sessions = vec![elsewhere, owned, old, hit];
        apply_step_claims(&conn, &mut sessions);
        assert_eq!(sessions[3].step_name.as_deref(), Some("文献检索与筛选"));
        assert_eq!(sessions[2].step_name, None, "登记前的旧会话不归该步骤");
        assert_eq!(
            sessions[1].step_name.as_deref(),
            Some("文献精读与笔记"),
            "既有 worktree 步骤归属不被抢占"
        );
        assert_eq!(sessions[0].step_name, None, "别项目会话不归");
        // 消费：登记行已删，再次 apply 不重复生效
        apply_step_claims(&conn, &mut sessions);
        assert!(read_step_claims(&conn).is_empty(), "认领消费后登记清空");

        // 持久化：归属已固化进 session_meta——下一轮列表（全新扫描、step_name 全空）
        // 由 apply_meta 从持久列回填，对话页 8s 轮询不会丢归属
        let mut next_round = vec![{
            let mut s = codex_meta("s-hit", "2026-07-03T00:00:00Z", None).0;
            s.project_path = "/proj".into();
            s
        }];
        assert_eq!(next_round[0].step_name, None);
        let meta = read_all_meta(&conn);
        apply_meta(&mut next_round, &HashMap::new(), &meta);
        assert_eq!(
            next_round[0].step_name.as_deref(),
            Some("文献检索与筛选"),
            "步骤归属持久化进 session_meta，后续轮次由 apply_meta 回填"
        );
        // worktree 命中（扫描侧已填）优先于持久列，不被旧归属覆盖
        next_round[0].step_name = Some("数据清洗".into());
        apply_meta(&mut next_round, &HashMap::new(), &meta);
        assert_eq!(
            next_round[0].step_name.as_deref(),
            Some("数据清洗"),
            "worktree 步骤归属优先于持久列"
        );
    }

    // ===== OpenCode =====

    /// 按 matrix §5 模式建临时 SQLite：project/session/message/part 四表 + fixture 行
    fn opencode_fixture_db(dir: &Path) -> PathBuf {
        let db = dir.join("opencode.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE project(id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT,
               title TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
               tokens_cache_read INTEGER, tokens_cache_write INTEGER, agent TEXT, model TEXT,
               version TEXT, time_created INTEGER, time_updated INTEGER);
             CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
             CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
             INSERT INTO project VALUES('p1','/repo/x'),('global','');
             INSERT INTO session VALUES('ses_1','p1',NULL,'/fallback','修复登录 bug',0.1,100,20,5,10,2,'build','{}','0.9.0',1785307071000,1785307072000);
             INSERT INTO session VALUES('ses_2','global',NULL,'/tmp/dir2','',0,0,0,0,0,0,'build','{}',NULL,1785307080000,1785307080000);
             INSERT INTO message VALUES('msg_1','ses_1',1785307071100,'{\"role\":\"user\",\"summary\":{\"body\":\"帮我修 bug\"}}');
             INSERT INTO message VALUES('msg_2','ses_1',1785307071200,'{\"role\":\"assistant\",\"tokens\":{\"input\":100,\"output\":20,\"reasoning\":5,\"cache\":{\"read\":10,\"write\":2}}}');
             INSERT INTO part VALUES('prt_1','msg_2','ses_1',1785307071201,'{\"type\":\"reasoning\",\"text\":\"想想\"}');
             INSERT INTO part VALUES('prt_2','msg_2','ses_1',1785307071202,'{\"type\":\"text\",\"text\":\"好的\"}');
             INSERT INTO part VALUES('prt_3','msg_2','ses_1',1785307071203,'{\"type\":\"tool\",\"tool\":\"bash\",\"state\":{\"status\":\"completed\",\"input\":{\"cmd\":\"ls\"},\"output\":\"ok\"}}');
             INSERT INTO part VALUES('prt_4','msg_2','ses_1',1785307071204,'{\"type\":\"tool\",\"tool\":\"edit\",\"state\":{\"status\":\"error\",\"input\":{\"file\":\"/a\"},\"error\":\"写入失败\"}}');
             INSERT INTO part VALUES('prt_5','msg_2','ses_1',1785307071205,'{\"type\":\"step-start\"}');",
        )
        .unwrap();
        db
    }

    #[test]
    fn opencode_scan_maps_db_rows() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = opencode_fixture_db(&dir);
        let metas = opencode_scan_db(&db);
        assert_eq!(metas.len(), 2);
        let m1 = metas.iter().find(|m| m.session_id == "ses_1").unwrap();
        assert_eq!(m1.agent, "opencode");
        assert_eq!(m1.project_path, "/repo/x", "project_id → project.worktree");
        assert_eq!(m1.title.as_deref(), Some("修复登录 bug"));
        assert_eq!(
            m1.created_at.as_deref(),
            Some("2026-07-29T06:37:51Z"),
            "epoch ms → ISO"
        );
        assert_eq!(m1.cli_version.as_deref(), Some("0.9.0"));
        assert!(m1.file_path.ends_with("#ses_1"));
        assert!(m1.alive);
        let u = m1.token_usage.as_ref().unwrap();
        assert_eq!(
            (u.input, u.output, u.cache_read, u.cache_write),
            (100, 25, 10, 2)
        );
        let m2 = metas.iter().find(|m| m.session_id == "ses_2").unwrap();
        assert_eq!(
            m2.project_path, "/tmp/dir2",
            "global 项目回落 session.directory"
        );
        assert_eq!(m2.title, None, "空标题按 None 处理");
        assert!(m2.token_usage.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opencode_scan_backfills_placeholder_title_lazily() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = opencode_fixture_db(&dir);
        // 占位标题的会话：从首条真实用户消息补标题
        let conn = Connection::open(&db).unwrap();
        conn.execute(
            "INSERT INTO session VALUES('ses_new','p1',NULL,'/repo/x','New Session',0,0,0,0,0,0,'build','{}','0.9.0',1785307090000,1785307090000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message VALUES('msg_n','ses_new',1785307090100,'{\"role\":\"user\",\"summary\":{\"body\":\"帮我写个脚本\"}}')",
            [],
        )
        .unwrap();
        drop(conn);
        let metas = opencode_scan_db(&db);
        let m = metas.iter().find(|m| m.session_id == "ses_new").unwrap();
        assert_eq!(
            m.title.as_deref(),
            Some("帮我写个脚本"),
            "占位标题应惰性回补"
        );
        let m1 = metas.iter().find(|m| m.session_id == "ses_1").unwrap();
        assert_eq!(
            m1.title.as_deref(),
            Some("修复登录 bug"),
            "真实标题不走回补"
        );
        let m2 = metas.iter().find(|m| m.session_id == "ses_2").unwrap();
        assert_eq!(m2.title, None, "没有用户消息的占位会话回补不到也不编");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opencode_snapshot_collected_and_mapped() {
        // pin 快照回补：opencode 快照是 .json，必须进收集与解析
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let snap_root = dir.join("snapshots");
        std::fs::create_dir_all(snap_root.join("opencode")).unwrap();
        std::fs::create_dir_all(snap_root.join("codex")).unwrap();
        let json = snap_root.join("opencode").join("ses_x.json");
        std::fs::write(
            &json,
            r#"{"session":{"id":"ses_x","title":"快照标题","directory":"/proj/x","time_created":1785307071000,"time_updated":1785307072000,"tokens_input":7,"tokens_output":3}}"#,
        )
        .unwrap();
        let codex_snap = snap_root.join("codex").join("rollout-y.jsonl");
        std::fs::write(&codex_snap, "{}").unwrap();
        let oc_files = snapshot_files(&snap_root, "opencode");
        assert_eq!(oc_files.len(), 1, "opencode 的 .json 快照必须被收集");
        assert_eq!(oc_files[0], json);
        let cx_files = snapshot_files(&snap_root, "codex");
        assert_eq!(cx_files.len(), 1, "其他 agent 仍只收 .jsonl[.zst]");
        let m = opencode_snapshot_meta(&json, "ses_x").unwrap();
        assert_eq!(m.session_id, "ses_x");
        assert_eq!(m.title.as_deref(), Some("快照标题"));
        assert_eq!(m.project_path, "/proj/x");
        assert!(!m.alive);
        assert_eq!(m.created_at.as_deref(), Some("2026-07-29T06:37:51Z"));
        assert_eq!(m.token_usage.map(|u| (u.input, u.output)), Some((7, 3)));
        assert!(
            opencode_snapshot_meta(&codex_snap, "y").is_none(),
            "非导出 JSON 不产生条目"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opencode_parse_db_messages_blocks_usage() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = opencode_fixture_db(&dir);
        let msgs = opencode_parse_db(&db, "ses_1");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].text, "帮我修 bug");
        let a = &msgs[1];
        let kinds: Vec<&str> = a.blocks.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(
            kinds,
            vec![
                "thinking",
                "text",
                "tool_use",
                "tool_result",
                "tool_use",
                "tool_result"
            ]
        );
        assert_eq!(a.blocks[2].tool_name.as_deref(), Some("bash"));
        assert_eq!(a.blocks[3].text, "ok");
        assert_eq!(
            a.blocks[5].text, "写入失败",
            "error 状态的 state.error 进 tool_result"
        );
        let u = a.usage.as_ref().unwrap();
        assert_eq!(
            (u.input, u.output, u.cache_read, u.cache_write),
            (100, 25, 10, 2),
            "reasoning 计入 output"
        );
        assert_eq!(a.timestamp.as_deref(), Some("2026-07-29T06:37:51Z"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opencode_scan_tolerates_minimal_columns() {
        // drizzle 迁移漂移：只有最小列集也得能扫
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("opencode.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
             INSERT INTO session VALUES('ses_min','只有标题','/dir');",
        )
        .unwrap();
        drop(conn);
        let metas = opencode_scan_db(&db);
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].project_path, "/dir");
        assert!(metas[0].created_at.is_none());
        assert!(metas[0].token_usage.is_none());
        assert!(
            opencode_parse_db(&db, "ses_min").is_empty(),
            "缺 message/part 表 → 空消息列表"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opencode_export_snapshot_roundtrip() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = opencode_fixture_db(&dir);
        let exported = opencode_export_session(&db, "ses_1").unwrap();
        assert_eq!(
            get_str(exported.get("session").unwrap(), "title"),
            Some("修复登录 bug")
        );
        let msgs = opencode_parse_snapshot(&exported);
        let db_msgs = opencode_parse_db(&db, "ses_1");
        assert_eq!(msgs.len(), db_msgs.len());
        assert_eq!(
            msgs[1].blocks.len(),
            db_msgs[1].blocks.len(),
            "快照回放与读库一致"
        );
        assert_eq!(msgs[1].blocks[3].text, "ok");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opencode_legacy_flat_json_scan_and_parse() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let storage = dir.join("storage");
        std::fs::create_dir_all(storage.join("session/p1")).unwrap();
        std::fs::create_dir_all(storage.join("message/ses_9")).unwrap();
        std::fs::create_dir_all(storage.join("part/msg_2")).unwrap();
        std::fs::write(
            storage.join("session/p1/ses_9.json"),
            r#"{"id":"ses_9","title":"旧会话","directory":"/old/dir","time":{"created":1785307071000,"updated":1785307072000},"tokens_input":7,"tokens_output":3}"#,
        )
        .unwrap();
        std::fs::write(
            storage.join("message/ses_9/msg_1.json"),
            r#"{"role":"user","time":{"created":1785307071100},"summary":{"body":"旧问题"}}"#,
        )
        .unwrap();
        std::fs::write(
            storage.join("message/ses_9/msg_2.json"),
            r#"{"role":"assistant","time":{"created":1785307071200},"tokens":{"input":7,"output":3}}"#,
        )
        .unwrap();
        std::fs::write(
            storage.join("part/msg_2/prt_1.json"),
            r#"{"type":"text","text":"旧回答"}"#,
        )
        .unwrap();
        let metas = opencode_scan_legacy(&storage);
        assert_eq!(metas.len(), 1);
        let m = &metas[0];
        assert_eq!(m.session_id, "ses_9");
        assert_eq!(m.project_path, "/old/dir");
        assert_eq!(m.title.as_deref(), Some("旧会话"));
        assert_eq!(m.created_at.as_deref(), Some("2026-07-29T06:37:51Z"));
        assert_eq!(
            m.token_usage.as_ref().map(|u| (u.input, u.output)),
            Some((7, 3))
        );
        let msgs = opencode_parse_legacy(&storage.join("session/p1/ses_9.json"));
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].blocks[0].text, "旧问题");
        assert_eq!(msgs[1].blocks[0].text, "旧回答");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 注意力标记 v1 =====

    #[test]
    fn tail_state_claude_variants() {
        // 文本收尾 → done；问句收尾 → confirm
        let done = s(&[
            r#"{"type":"user","message":{"role":"user","content":"问"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"已完成修复。"}]}}"#,
        ]);
        assert_eq!(claude_tail_state(&done), "done");
        let confirm = s(&[
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"我需要删除这个文件，可以继续吗？"}]}}"#,
        ]);
        assert_eq!(claude_tail_state(&confirm), "confirm");
        // 尾部工具调用未回 → working；user 刚发 → working；meta/支线不算
        let tool = s(&[
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}}]}}"#,
        ]);
        assert_eq!(claude_tail_state(&tool), "working");
        let user = s(&[
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好"}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":"再改一下"}}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-stdout>x</local-command-stdout>"}}"#,
        ]);
        assert_eq!(claude_tail_state(&user), "working");
    }

    #[test]
    fn tail_state_codex_variants() {
        let done = s(&[
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"完成"}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{}}}"#, // token_count 等事件不算
        ]);
        assert_eq!(codex_tail_state(&done), "done");
        let working = s(&[
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}"}}"#,
        ]);
        assert_eq!(codex_tail_state(&working), "working");
        let user = s(&[
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"干活"}]}}"#,
        ]);
        assert_eq!(codex_tail_state(&user), "working");
        // 工具输出之后的中途 agent_message 不是收尾
        let mid = s(&[
            r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"1"}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"改名完成"}}"#,
        ]);
        assert_eq!(codex_tail_state(&mid), "working");
        let complete = s(&[
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好"}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
        ]);
        assert_eq!(codex_tail_state(&complete), "done");
    }

    #[test]
    fn tail_state_gemini_qwen_kimi() {
        let g_user = s(&[r#"{"id":"m1","type":"user","content":"在吗"}"#]);
        assert_eq!(gemini_tail_state(&g_user), "working");
        let g_done = s(&[
            r#"{"id":"m1","type":"gemini","content":"做完了"}"#,
            r#"{"$set":{"lastUpdated":"x"}}"#, // 控制记录跳过
        ]);
        assert_eq!(gemini_tail_state(&g_done), "done");
        let g_confirm = s(&[r#"{"id":"m1","type":"gemini","content":"要我继续吗？"}"#]);
        assert_eq!(gemini_tail_state(&g_confirm), "confirm");

        let q_user = s(&[r#"{"type":"user","message":{"role":"user","parts":[{"text":"问"}]}}"#]);
        assert_eq!(qwen_tail_state(&q_user), "working");
        let q_done =
            s(&[r#"{"type":"assistant","message":{"role":"model","parts":[{"text":"答"}]}}"#]);
        assert_eq!(qwen_tail_state(&q_done), "done");

        let k_working = s(&[
            r#"{"type":"turn.prompt","input":[{"type":"text","text":"干活"}],"origin":{"kind":"user"},"time":1}"#,
        ]);
        assert_eq!(kimi_tail_state(&k_working), "working");
        let k_done = s(&[
            r#"{"type":"context.append_loop_event","event":{"type":"step.end","usage":{}},"time":2}"#,
        ]);
        assert_eq!(kimi_tail_state(&k_done), "done");
        let k_tool = s(&[
            r#"{"type":"context.append_loop_event","event":{"type":"tool.call","name":"Bash","args":{}},"time":2}"#,
        ]);
        assert_eq!(kimi_tail_state(&k_tool), "working");
    }

    #[test]
    fn tail_state_codebuddy() {
        let working = s(&[
            r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"干活"}],"timestamp":1786005441386}"#,
        ]);
        assert_eq!(codebuddy_tail_state(&working), "working");
        let done = s(&[
            r#"{"type":"message","role":"assistant","content":[{"type":"output_text","text":"做完了"}]}"#,
            r#"{"type":"file-history-snapshot","snapshot":{}}"#, // 事件行不算数
        ]);
        assert_eq!(codebuddy_tail_state(&done), "done");
        let confirm = s(&[
            r#"{"type":"message","role":"assistant","content":[{"type":"output_text","text":"要我继续吗？"}]}"#,
        ]);
        assert_eq!(codebuddy_tail_state(&confirm), "confirm");
        assert_eq!(codebuddy_tail_state(&[]), "unknown");
    }

    #[test]
    fn tail_state_opencode_and_unknown() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = opencode_fixture_db(&dir);
        // fixture：最后一条 part 是 step-start（回落到消息角色），最后消息是 assistant → done
        assert_eq!(opencode_tail_state(&db, "ses_1"), "done");
        // 加一条 pending 工具 → working
        let conn = Connection::open(&db).unwrap();
        conn.execute("INSERT INTO part VALUES('prt_9','msg_2','ses_1',1785307071300,'{\"type\":\"tool\",\"tool\":\"bash\",\"state\":{\"status\":\"running\",\"input\":{}}}')", []).unwrap();
        drop(conn);
        assert_eq!(opencode_tail_state(&db, "ses_1"), "working");
        // 最后消息是 user → working
        let conn = Connection::open(&db).unwrap();
        conn.execute("INSERT INTO message VALUES('msg_9','ses_1',1785307071400,'{\"role\":\"user\",\"summary\":{\"body\":\"再来\"}}')", []).unwrap();
        drop(conn);
        assert_eq!(opencode_tail_state(&db, "ses_1"), "working");
        // 不存在的会话 / 不存在的库 → unknown
        assert_eq!(opencode_tail_state(&db, "ses_none"), "unknown");
        assert_eq!(
            opencode_tail_state(&dir.join("none.db"), "ses_1"),
            "unknown"
        );
        std::fs::remove_dir_all(&dir).ok();
        // 文件缺失 → unknown
        assert_eq!(
            tail_state_impl("claude-code", "/nonexistent/x.jsonl"),
            "unknown"
        );
    }

    // ===== 导出 Markdown =====

    fn msg(
        role: &str,
        blocks: Vec<(&str, &str, Option<&str>)>,
        ts: Option<&str>,
    ) -> ChatMessageDto {
        ChatMessageDto {
            role: role.into(),
            blocks: blocks
                .into_iter()
                .map(|(kind, text, tool)| BlockDto {
                    kind: kind.into(),
                    text: text.into(),
                    tool_name: tool.map(|t| t.into()),
                })
                .collect(),
            timestamp: ts.map(|t| t.into()),
            usage: None,
        }
    }

    #[test]
    fn render_markdown_header_and_sections() {
        let msgs = vec![
            msg(
                "user",
                vec![("text", "帮我修 bug", None)],
                Some("2026-07-01T00:00:01Z"),
            ),
            msg(
                "assistant",
                vec![
                    ("thinking", "想想", None),
                    ("text", "好的", None),
                    ("tool_use", "{\"file_path\":\"/a\"}", Some("Read")),
                    ("tool_result", "file body", None),
                ],
                Some("2026-07-01T00:00:02Z"),
            ),
        ];
        let md = render_markdown("claude-code", "abcdef123456", "修 bug", &msgs);
        assert!(md.starts_with("# 修 bug\n"));
        assert!(md.contains("- Agent: claude-code\n"));
        assert!(md.contains("- Session: abcdef123456\n"));
        assert!(md.contains("- 时间: 2026-07-01T00:00:01Z → 2026-07-01T00:00:02Z\n"));
        assert!(md.contains("- 消息数: 2\n"));
        assert!(md.contains("## 用户 · 2026-07-01T00:00:01Z\n"));
        assert!(md.contains("## 助手 · 2026-07-01T00:00:02Z\n"));
        assert!(md.contains("**思考**\n\n```text\n想想\n```\n"));
        assert!(md.contains("**工具调用: Read**\n\n```\n{\"file_path\":\"/a\"}\n```\n"));
        assert!(md.contains("**工具结果**\n\n```\nfile body\n```\n"));
    }

    #[test]
    fn render_markdown_fence_grows_with_backticks() {
        let msgs = vec![msg(
            "assistant",
            vec![("tool_result", "```js\ncode\n```", None)],
            None,
        )];
        let md = render_markdown("claude-code", "s", "t", &msgs);
        // 内容含 ``` 时围栏必须是 ````，保证原样保留
        assert!(md.contains("````\n```js\ncode\n```\n````\n"));
        // 无时间戳时头部不出现时间行，消息头不带时间
        assert!(!md.contains("- 时间:"));
        assert!(md.contains("## 助手\n"));
    }

    #[test]
    fn sanitize_export_name_filters_illegal_chars() {
        assert_eq!(sanitize_export_name("修 bug"), "修 bug");
        assert_eq!(
            sanitize_export_name("a/b\\c:d*e?f\"g<h>i|j"),
            "a-b-c-d-e-f-g-h-i-j"
        );
        assert_eq!(sanitize_export_name(""), "session");
        assert_eq!(sanitize_export_name("..."), "session");
        assert_eq!(
            sanitize_export_name("x".repeat(100).as_str())
                .chars()
                .count(),
            60
        );
    }

    // ===== 会话 watcher 目标过滤 =====

    #[test]
    fn session_watch_targets_plain_file_listens_parent_and_exact_file() {
        let (dir, targets) = session_watch_targets("/tmp/ccode/session.jsonl");
        assert_eq!(dir, PathBuf::from("/tmp/ccode"));
        assert_eq!(targets, vec!["/tmp/ccode/session.jsonl"]);
        assert!(watch_event_matches(
            &[PathBuf::from("/tmp/ccode/session.jsonl")],
            &targets
        ));
        assert!(!watch_event_matches(
            &[PathBuf::from("/tmp/ccode/session-other.jsonl")],
            &targets
        ));
    }

    #[test]
    fn session_watch_targets_opencode_db_includes_wal_but_filters_other_files() {
        let (dir, targets) = session_watch_targets("/tmp/ccode/opencode.db#ses_1");
        assert_eq!(dir, PathBuf::from("/tmp/ccode"));
        assert_eq!(
            targets,
            vec![
                "/tmp/ccode/opencode.db".to_string(),
                "/tmp/ccode/opencode.db-wal".to_string(),
                "/tmp/ccode".to_string()
            ]
        );
        assert!(watch_event_matches(
            &[PathBuf::from("/tmp/ccode/opencode.db-wal")],
            &targets
        ));
        assert!(watch_event_matches(
            &[PathBuf::from("/tmp/ccode")],
            &targets
        ));
        assert!(!watch_event_matches(
            &[PathBuf::from("/tmp/ccode/opencode.db-shm")],
            &targets
        ));
    }
}


