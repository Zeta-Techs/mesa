use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageDto {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// 同一 agent 内的分叉来源（目前只有 Claude）：本会话从哪条会话的某一点分出来、
    /// 而原会话之后还在继续写。直线接续合并成一条，不填这个字段
    #[serde(default)]
    pub forked_from: Option<String>,
    /// 沉浸阅读区派的精读对话（照 Run 记录 task_kind=reader 认，runs::apply_reader_runs）：
    /// 侧栏默认不列，项目菜单可打开（2026-11-06 用户）
    #[serde(default)]
    pub reader: bool,
    /// 精读对话读的哪篇 PDF（复用键按篇之后才有；旧的按项目一个的为 None）：再点这篇精读时接回它
    #[serde(default)]
    pub reader_pdf: Option<String>,
    /// 流程对话在这一步里是哪一段（侧栏按步骤分组、按角色起行名用，apply_step_meta 回填）
    #[serde(flatten, default)]
    pub step_meta: SessionStepMeta,
    /// 接力对话（relay.rs apply_relay_chains）：先后经过的几家与各段；不是接力对话为空。拍平出线
    #[serde(flatten, default)]
    pub relay: SessionRelayMeta,
    /// 标题是人手改的（session_meta.title_source=user）：侧栏照写人起的名字，不换成角色名
    #[serde(default)]
    pub title_by_user: bool,
}

/// 一段接力对话在列表里只占一行（代表 = 最后接手的那段）：用过的几家（按出现先后）与各段（docs/design-chat-relay.md §3.6）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRelayMeta {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relay_agents: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relay_segments: Vec<RelaySegmentRef>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelaySegmentRef {
    pub agent: String,
    pub session_id: String,
    pub title: Option<String>,
    pub file_path: String,
    pub updated_at: Option<String>,
}

/// 流程对话的步骤位置与角色（只用于显示，不写任何会话文件）。拍平进 SessionMetaDto 出线
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStepMeta {
    /// 这一步在项目档案卡 steps 里排第几（1 起）；步骤已删 / 不是流程对话为 None
    #[serde(default)]
    pub step_index: Option<u32>,
    /// discuss（商量任务书）| work（干活）| lane（分路的一路）| merge（分路后的收尾）| round（某次开轮开的，起因见 round_kind）；认不出为 None
    #[serde(default)]
    pub step_role: Option<String>,
    /// round 的起因：rework | followup | fresh | comments | catchup（`.ccode/step-rounds.jsonl`）
    #[serde(default)]
    pub round_kind: Option<String>,
    /// 分路的第几路（1 起），只 lane 有
    #[serde(default)]
    pub lane_no: Option<u32>,
    /// 这一路的做完标记（`.ccode/fanout/lane-<k>.done`）在不在
    #[serde(default)]
    pub lane_done: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockDto {
    pub kind: String, // text | thinking | tool_use | tool_result
    pub text: String,
    pub tool_name: Option<String>,
    /// 工具结果被 CLI 自己标成出错（Claude 的 is_error）：前端按失败显示，不再只靠猜结果开头的文字
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_error: bool,
    /// 工具调用 id（tool_use 与 tool_result 两头都带）：前端按它配对、判断还在不在跑；
    /// 来源没有就不带（前端退回按顺序配对）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageDto {
    pub role: String, // user | assistant
    pub blocks: Vec<BlockDto>,
    pub timestamp: Option<String>,
    pub usage: Option<TokenUsageDto>,
    /// 来源给的消息 id（Claude 的行 uuid、Codex 的条目 id …）：前端拿它当稳定身份
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// 写这条回复时 Agent 所在的目录（Claude 每行的 cwd：它在 shell 里 cd 过就跟着变）：回复里的相对路径以它为基准，
    /// 不是会话起点目录（2026-10-30 实证：cd 进 out/promo 后写的 [x.mp4](x.mp4) 按项目根解析成「文件不存在」）。来源没有就不带
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
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
        is_error: false,
        call_id: None,
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
/// Claude Code 把多行粘贴的提问包成 `<pasted_content id="79fb">…</pasted_content id="79fb">` 写进会话文件
/// （开头还带两个空行）。Mesa 聊天层发多行提问就是一次粘贴，所以几乎每条多行提问都带；
/// 回放和标题只要里面的话。只认标签名后紧跟 `>` 或空白、且标签行内不换行的，防误伤正文里谈到这个词。
/// 没找到收尾标签（尾部截断）就只去掉开头标签。无包装时原样返回，不动缩进。
fn unwrap_pasted_content(text: &str) -> String {
    const OPEN: &str = "<pasted_content";
    const CLOSE: &str = "</pasted_content";
    if find_ascii_ci(text, OPEN).is_none() {
        return text.to_string();
    }
    // 取出一个完整标签 `<name ...>` 的结束下标（含 `>`）；属性里不得有换行或再开一个 `<`
    fn tag_end(s: &str, name_end: usize) -> Option<usize> {
        let next = s[name_end..].chars().next()?;
        if next != '>' && !next.is_whitespace() {
            return None;
        }
        let gt = s[name_end..].find('>')?;
        let attrs = &s[name_end..name_end + gt];
        (!attrs.contains('\n') && !attrs.contains('<')).then_some(name_end + gt + 1)
    }
    let mut s = text.to_string();
    let mut from = 0;
    let mut changed = false;
    while let Some(rel) = find_ascii_ci(&s[from..], OPEN) {
        let start = from + rel;
        let Some(open_end) = tag_end(&s, start + OPEN.len()) else {
            from = start + OPEN.len();
            continue;
        };
        let (inner_end, after) = match find_ascii_ci(&s[open_end..], CLOSE)
            .and_then(|r| tag_end(&s, open_end + r + CLOSE.len()).map(|e| (open_end + r, e)))
        {
            Some(pair) => pair,
            None => (s.len(), s.len()),
        };
        let inner = s[open_end..inner_end].trim_matches('\n').to_string();
        s = format!("{}{}{}", &s[..start], inner, &s[after..]);
        from = start + inner.len();
        changed = true;
    }
    if changed {
        s.trim().to_string()
    } else {
        s
    }
}

/// 一段文本块在展示前的清洗：所有人都剥 `<user_query>` / `<turn_aborted>`；
/// 粘贴包装只在**用户**消息里剥（助手正文可能正在讲这个标签，不能动）
fn clean_block_text(role: &str, text: &str) -> String {
    let t = unwrap_prompt_tags(text);
    if role == "user" {
        unwrap_pasted_content(&t)
    } else {
        t
    }
}

/// 标题字宽（半字为单位）：ASCII 算半个字，其余算一个字。自动起名的主题上限同口径（ai.rs theme_is_specific）
pub(crate) fn title_width(text: &str) -> usize {
    text.chars().map(|c| if c.is_ascii() { 1 } else { 2 }).sum()
}

/// 回落标题（CLI 自带标题 / 首句）截到 24 字左右：英文两个字母算一个字
fn truncate_title(text: &str) -> String {
    const MAX_WIDTH: usize = 48;
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = normalized.trim();
    if title_width(t) <= MAX_WIDTH {
        return t.to_string();
    }
    let mut width = 0;
    let head: String = t
        .chars()
        .take_while(|c| {
            width += title_width(c.encode_utf8(&mut [0; 4]));
            width <= MAX_WIDTH
        })
        .collect();
    format!("{}…", head.trim_end())
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

/// Mesa 在项目里开对话时塞在第一句前面的项目上下文包（前端 project-context.ts composeLaunchPrompt / splitLaunchPrompt 镜像）：
/// 不是人话。列表标题与自动起名只认分隔（单独一行 ----）后面你说的；只有包没有分隔的整条返回空串。
/// 只认默认包头，自定义模板的包头认不出，照旧当人话。
/// 接力抬头（relay_brief::RELAY_HEAD，换一家接着做时 Mesa 写在那句话前面）同样不是人话，一并剥掉
pub(crate) fn strip_mesa_launch_pack(text: &str) -> &str {
    let text = strip_before_separator(text, "你正在项目「");
    strip_before_separator(text, crate::relay_brief::RELAY_HEAD)
}

/// 只剥项目说明，接力抬头留着（relay.rs 认抬头用）
pub(crate) fn strip_project_pack(text: &str) -> &str {
    strip_before_separator(text, "你正在项目「")
}

fn strip_before_separator<'a>(text: &'a str, head: &str) -> &'a str {
    if !text.trim_start().starts_with(head) {
        return text;
    }
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        offset += line.len();
        if line.trim() == "----" {
            return text[offset..].trim_start();
        }
    }
    ""
}

fn usable_title(text: &str) -> Option<String> {
    let text = strip_mesa_launch_pack(text);
    let title = truncate_title(&unwrap_pasted_content(&unwrap_prompt_tags(text)));
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

pub(crate) fn redact_sensitive_text_with(text: &str, secrets: &[String]) -> String {
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
                block.text = clean_block_text(&message.role, &block.text);
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
        id: None,
        cwd: None,
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
/// 文件刚写过但尾部已是确定的回合结束（settled）不算 live：Claude 闲着也会往会话文件补 away_summary /
/// cost-state 这类元数据行，只看 mtime 时侧栏光标在 Agent 闲着时也呼吸（2026-10-25 用户）。
/// Qwen 另认 runtime sidecar（进程还在但 jsonl 可能停更）。
fn refresh_live_flag(meta: &mut SessionMetaDto) {
    if !meta.alive {
        meta.live = false;
        return;
    }
    let mut live = meta
        .updated_at
        .as_deref()
        .is_some_and(|t| iso_within_secs(t, 60))
        && tail_state_impl(&meta.agent, &meta.file_path) != "settled";
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

/// 归档 zst 专用：只解到头窗满即停，不解剩余流。列表只需要元数据——title 与
/// session_meta（cwd/id/version/forked/provider）全在头部，updated_at 本就取 mtime；
/// 尾窗唯一用途是 token_usage，归档会话宁缺毋滥给 None（2026-10-16 拍板懒解压：
/// Codex 批量压缩历史后，为尾窗整流解码 2.8GB 归档曾是冷启动的绝对大头）。
/// 明文文件走与 read_head_tail 相同的 seek 头窗路径。
fn read_head_only(path: &Path, budget: usize) -> Option<Vec<String>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(path).ok()?;
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).ok()?;
    if magic != ZSTD_MAGIC {
        let len = f.metadata().ok()?.len() as usize;
        if len <= budget * 2 {
            let raw = fs::read(path).ok()?;
            return Some(to_lines(&String::from_utf8_lossy(&raw)));
        }
        f.seek(SeekFrom::Start(0)).ok()?;
        let mut head = vec![0u8; budget];
        let n = f.read(&mut head).ok()?;
        head.truncate(n);
        return Some(align_head(&head));
    }
    let f2 = fs::File::open(path).ok()?;
    let mut dec = zstd::stream::read::Decoder::new(f2).ok()?;
    let mut head: Vec<u8> = Vec::with_capacity(budget);
    let mut buf = [0u8; 65536];
    loop {
        match dec.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if head.len() < budget {
                    let take = (budget - head.len()).min(n);
                    head.extend_from_slice(&buf[..take]);
                }
                if head.len() >= budget {
                    break; // 头窗已满即停：这是本函数存在的全部意义
                }
            }
        }
    }
    Some(align_head(&head))
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

// ===== 各家会话解析：一家一个子模块（sessions/<家>.rs），父模块整体接回 =====

mod claude;
mod codex;
mod gemini;
mod qwen;
mod kimi;
mod codebuddy;
mod cursor;
mod grok;
mod opencode;

pub(crate) use claude::*;
pub(crate) use codex::*;
use gemini::*;
use qwen::*;
use kimi::*;
use codebuddy::*;
use cursor::*;
use grok::*;
pub(crate) use opencode::*;

// ===== 扫描 =====

#[derive(Debug, Clone, Default)]
pub struct ScanResult {
    pub sessions: Vec<SessionMetaDto>,
    /// codex 链代表 id → 全部成员 id（含代表自己）；链代表随新 resume 换人时，
    /// 用户写在任一成员 id 上的 pinned/tags 等整理数据仍能找回来
    pub chain_members: HashMap<String, Vec<String>>,
    /// 并进链代表、列表里不单独出现的会话文件（目前只有 Claude 接续链）。
    /// 每份文件只算自己 id 的行，用量重建要逐个过，否则上游那段的用量会丢
    pub hidden_members: Vec<SessionMetaDto>,
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
pub(crate) struct FileSig {
    pub(crate) len: u64,
    pub(crate) mtime_ns: i64,
}

type OpencodeDbEntry = (FileSig, Option<FileSig>, Vec<SessionMetaDto>);

/// OpenCode 库的会话行，主库与 `-wal` 指纹都没变才复用上一轮。
///
/// OpenCode 开着 WAL：新会话、新消息先只写进 `opencode.db-wal`，主库要等自动检查点（约 1000 页）才动。
/// 只看主库指纹时新会话长时间扫不到，聊天层迟迟接不上会话、回复不显示或隔几分钟才出来
/// （2026-10-21 用户实测：会话 09:21 建、主库 09:24 才第一次写，聊天层恰好那时才接上；macOS 同理）
fn opencode_rows_cached(
    db: &Path,
    prev: Option<&OpencodeDbEntry>,
) -> (Option<OpencodeDbEntry>, Vec<SessionMetaDto>) {
    let sig = file_sig(db);
    let mut wal = db.as_os_str().to_owned();
    wal.push("-wal");
    let wal_sig = file_sig(Path::new(&wal));
    let rows = match (sig, prev) {
        (Some(sig), Some((old, old_wal, rows))) if *old == sig && *old_wal == wal_sig => rows.clone(),
        _ => opencode_scan_db(db),
    };
    (sig.map(|sig| (sig, wal_sig, rows.clone())), rows)
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
pub(crate) struct ScanFileCache {
    /// 主会话文件：路径 → (指纹, meta)
    pub(crate) plain: HashMap<String, (FileSig, SessionMetaDto)>,
    /// codex/grok：meta + 链父 id（merge_codex_chains 的输入）
    pub(crate) chained: HashMap<String, (FileSig, SessionMetaDto, Option<String>)>,
    /// claude：meta + 接续关系（merge_claude_chains 的输入）。单独一栏：plain 每段整表替换
    pub(crate) claude: HashMap<String, (FileSig, SessionMetaDto, ClaudeLineage)>,
    /// kimi：state.json 内容参与解析，值多带一份 state 指纹
    pub(crate) kimi: HashMap<String, (FileSig, Option<FileSig>, SessionMetaDto)>,
    /// 快照区（kimi 之外各家 + opencode .json）：解析不依赖外部文件
    pub(crate) snapshot: HashMap<String, (FileSig, SessionMetaDto)>,
    /// kimi 快照要先读字节分辨新/旧协议，单独一栏
    pub(crate) kimi_snapshot: HashMap<String, (FileSig, SessionMetaDto)>,
    /// opencode 共享 SQLite：(主库指纹, -wal 指纹) → 整批行（见 opencode_rows_cached）
    opencode_db: HashMap<String, OpencodeDbEntry>,
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

/// Claude：多带接续关系；按指纹跳过未变文件
fn cached_claude(
    files: Vec<PathBuf>,
    cache: &mut HashMap<String, (FileSig, SessionMetaDto, ClaudeLineage)>,
) -> Vec<(SessionMetaDto, ClaudeLineage)> {
    let mut next = HashMap::with_capacity(files.len());
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        let Some(sig) = file_sig(&f) else { continue };
        let key = cache_key(&f);
        let pair = match cache.get(&key) {
            Some((old_sig, m, lin)) if *old_sig == sig => (m.clone(), lin.clone()),
            _ => match claude_file_meta_lineage(&f, true) {
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
    let mut claude_hidden: Vec<(String, SessionMetaDto)> = Vec::new();
    let forks = read_session_forks();
    let fork_children: HashSet<(&str, &str)> =
        forks.iter().map(|(a, c, _)| (a.as_str(), c.as_str())).collect();
    let mut cache = scan_file_cache().lock().unwrap_or_else(|e| e.into_inner());
    // 冷启动兜底（2026-10-16）：装回上一进程落盘的 meta 缓存——指纹未变的文件
    // 直接沿用旧解析结果，归档 zst 一个字节都不用重读（秒开的关键）
    crate::scan_persist::load_once(&mut cache);
    let ScanFileCache {
        plain,
        chained,
        claude,
        kimi,
        snapshot,
        kimi_snapshot,
        opencode_db,
        opencode_legacy,
        grok_summary,
    } = &mut *cache;
    // Gemini 的 slug → 项目路径映射在扫描与快照补全时都要用
    let roots = SessionRoots::current();
    let gemini_map = roots
        .as_ref()
        .map(|r| gemini_slug_map(&r.gemini.join("tmp")))
        .unwrap_or_default();
    if let Some(roots) = &roots {
        let mut claude_files = Vec::new();
        collect_files(&roots.claude_projects(), 2, &mut claude_files);
        let mut claude_metas = cached_claude(claude_files, claude);
        // Mesa 分叉出来的那份不按接续并进原对话（见 SESSION_FORKS_DDL）
        for (m, lin) in claude_metas.iter_mut() {
            if fork_children.contains(&("claude-code", m.session_id.as_str())) {
                lin.parent = None;
            }
        }
        let (reps, members, hidden) = merge_claude_chains(claude_metas);
        out.extend(reps);
        chain_members.extend(members);
        claude_hidden = hidden;
        // archived_sessions 里的文件是 alive 的归档，不是「已失效」
        let [codex_active, codex_archived] = roots.codex_dirs();
        let mut active_files = Vec::new();
        collect_files(&codex_active, 5, &mut active_files);
        let mut archived_files = Vec::new();
        collect_files(&codex_archived, 5, &mut archived_files);
        active_files.extend(archived_files);
        // archived 标记不进缓存值：目录固定（sessions/ vs archived_sessions/），
        // 按路径直读即可，同一路径不会跨目录漂移
        let codex_metas = cached_chained(active_files, chained, |f| {
            let archived = f.components().any(|c| c.as_os_str() == "archived_sessions");
            codex_file_meta(f, true, archived)
        });
        let codex_metas = codex_metas
            .into_iter()
            .map(|(m, p)| {
                let p = p.filter(|_| !fork_children.contains(&("codex", m.session_id.as_str())));
                (m, p)
            })
            .collect();
        let (reps, members) = merge_codex_chains(codex_metas);
        out.extend(reps);
        chain_members.extend(members);
        // Gemini：深度 3 恰好到 chats/*.jsonl，chats/<parentId>/ 下的子 agent 会话被排除；
        // 旧版单 JSON .json 文件不匹配 .jsonl 后缀，自然跳过（如需兼容再单开解析器）
        let mut gemini_files = Vec::new();
        collect_files(&roots.gemini.join("tmp"), 3, &mut gemini_files);
        let gemini_metas = cached_plain(gemini_files, plain, |f| {
            gemini_file_meta(f, true, &gemini_map)
        });
        out.extend(dedupe_gemini_sessions(gemini_metas));
        // Qwen：深度 4 覆盖 chats/archive/；archive 目录下的是归档（alive 但 archived）
        let mut qwen_files = Vec::new();
        collect_files(&roots.qwen.join("projects"), 4, &mut qwen_files);
        out.extend(cached_plain(qwen_files, plain, |f| {
            let archived = f
                .parent()
                .and_then(|p| p.file_name())
                .is_some_and(|n| n == "archive");
            qwen_file_meta(f, true, archived)
        }));
        // Kimi 新版：session_index.jsonl 是枚举入口（workDir 即项目归属）。
        // sid/wd 参与 meta 但不来自文件本身——键里带上 sid/wd，索引行改写即换键重解析
        let index = roots.kimi_index();
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
        let buckets = kimi_workdir_buckets(&roots.kimi_legacy_json());
        if !buckets.is_empty() {
            let mut kimi_files = Vec::new();
            collect_files(&roots.kimi_legacy.join("sessions"), 3, &mut kimi_files);
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
        let mut opencode_db_next: HashMap<String, OpencodeDbEntry> =
            HashMap::with_capacity(opencode_db.len());
        for db in opencode_db_candidates() {
            if db.exists() {
                let key = cache_key(&db);
                let (entry, rows) = opencode_rows_cached(&db, opencode_db.get(&key));
                if let Some(entry) = entry {
                    opencode_db_next.insert(key, entry);
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
        collect_files(&roots.codebuddy.join("projects"), 2, &mut codebuddy_files);
        out.extend(cached_plain(codebuddy_files, plain, |f| {
            codebuddy_file_meta(f, true)
        }));
        // Cursor：projects/<编码cwd>/agent-transcripts/<uuid>/<uuid>.jsonl（深度 4 到文件）；
        // ~/.cursor 与 IDE 共享，只收 agent-transcripts 子树（其他位置的 jsonl 不是会话）
        let mut cursor_files = Vec::new();
        collect_files(&roots.cursor_projects(), 4, &mut cursor_files);
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
        collect_files(&roots.grok.join("sessions"), 3, &mut grok_files);
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
        let grok_metas = grok_metas
            .into_iter()
            .map(|(m, p)| {
                let p = p.filter(|_| !fork_children.contains(&("grok", m.session_id.as_str())));
                (m, p)
            })
            .collect();
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
    // 家目录可被用户换位置：当前根 + 曾用根 + 默认根的工作树都算 Mesa 自己的
    let mut coding_roots: Vec<String> = Vec::new();
    if let Ok(cur) = crate::coding::worktrees_root() {
        coding_roots.push(cur.to_string_lossy().into_owned());
    }
    for r in crate::ccode_home::all_sub("worktrees") {
        coding_roots.push(r.to_string_lossy().into_owned());
    }
    if !coding_roots.is_empty() {
        // 同一工作树只解析一次：lanes 查表每次新开连接（带幂等 DDL），逐会话查会
        // 拖慢冷扫描（实测约 30 个会话多花 1.7s）；按路径去重后每棵树最多一次
        let mut attr_by_path: HashMap<String, Option<(String, String)>> = HashMap::new();
        for s in &mut out {
            if s.workspace.is_some() {
                continue;
            }
            if !coding_roots
                .iter()
                .any(|r| crate::paths::path_within(&s.project_path, r))
            {
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
    // 被并掉的 Claude 链成员跟代表同一归属（代表已经过工作区归并）
    let rep_place: HashMap<&str, (&String, &Option<String>)> = out
        .iter()
        .filter(|m| m.agent == "claude-code")
        .map(|m| (m.session_id.as_str(), (&m.project_path, &m.workspace)))
        .collect();
    let hidden_members = claude_hidden
        .into_iter()
        .map(|(rep, mut m)| {
            if let Some((p, w)) = rep_place.get(rep.as_str()) {
                m.project_path = (*p).clone();
                m.workspace = (*w).clone();
            }
            m
        })
        .collect();
    apply_session_forks(&mut out, &chain_members, &forks);
    ScanResult {
        sessions: out,
        chain_members,
        hidden_members,
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

/// Claude 接续链（2026-10-21）。直线接续——上游在分叉点之后再没写过——并成一条，代表取链尾
/// （最新那份文件带着全部历史，「继续」必须接它）；上游分出去之后还在写，或同一点被接续了
/// 第二次，是真分叉：各自成行，`forked_from` 指向上游所在那一行的 id，标题改用分叉后第一句。
/// 第三项是被并掉的成员（代表 id, meta）：列表不显示，但用量要逐文件算本文件自己的行。
fn merge_claude_chains(
    metas: Vec<(SessionMetaDto, ClaudeLineage)>,
) -> (
    Vec<SessionMetaDto>,
    HashMap<String, Vec<String>>,
    Vec<(String, SessionMetaDto)>,
) {
    let n = metas.len();
    let index: HashMap<String, usize> = metas
        .iter()
        .enumerate()
        .map(|(i, (m, _))| (m.session_id.clone(), i))
        .collect();
    let mut children: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, (_, lin)) in metas.iter().enumerate() {
        if let Some(p) = lin.parent.as_ref().and_then(|p| index.get(p)) {
            if *p != i {
                children.entry(*p).or_default().push(i);
            }
        }
    }
    let mut linear_parent: Vec<Option<usize>> = vec![None; n];
    let mut fork_parent: Vec<Option<usize>> = vec![None; n];
    let mut has_linear_child = vec![false; n];
    for (p, kids) in &mut children {
        kids.sort_by(|a, b| metas[*a].1.branch_at.cmp(&metas[*b].1.branch_at));
        let p_last = metas[*p].1.last_at.as_deref();
        for &c in kids.iter() {
            let eligible = match (p_last, metas[c].1.branch_at.as_deref()) {
                (Some(last), Some(branch)) => last <= branch,
                _ => true, // 时间读不全：按直线接续处理（只是少一个分叉标记，不丢内容）
            };
            if eligible && !has_linear_child[*p] {
                linear_parent[c] = Some(*p);
                has_linear_child[*p] = true;
            } else {
                fork_parent[c] = Some(*p);
            }
        }
    }
    let root_of = |mut i: usize| {
        for _ in 0..n {
            match linear_parent[i] {
                Some(p) => i = p,
                None => break,
            }
        }
        i
    };
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        groups.entry(root_of(i)).or_default().push(i);
    }
    // 链尾 = 组里唯一没有直线后继的那份
    let mut rep_of_root: HashMap<usize, usize> = HashMap::new();
    for (root, g) in &groups {
        let tail = g
            .iter()
            .copied()
            .find(|&i| !has_linear_child[i])
            .unwrap_or(*root);
        rep_of_root.insert(*root, tail);
    }
    let rep_ids: Vec<String> = (0..n)
        .map(|i| metas[rep_of_root[&root_of(i)]].0.session_id.clone())
        .collect();
    let forked_from: Vec<Option<String>> = (0..n)
        .map(|i| fork_parent[i].map(|p| rep_ids[p].clone()))
        .collect();
    let mut slots: Vec<Option<(SessionMetaDto, ClaudeLineage)>> =
        metas.into_iter().map(Some).collect();
    let mut reps = Vec::new();
    let mut members = HashMap::new();
    let mut hidden = Vec::new();
    for (root, g) in groups {
        let rep_idx = rep_of_root[&root];
        let Some((mut rep, rep_lin)) = slots[rep_idx].take() else { continue };
        rep.chain_count = g.len();
        // 分叉只看链头：链头从别处分出来，整条链都算那条分叉
        rep.forked_from = forked_from[root].clone();
        if rep.forked_from.is_some() {
            let own = if root == rep_idx {
                rep_lin.own_title
            } else {
                slots[root].as_ref().and_then(|(_, l)| l.own_title.clone())
            };
            if own.is_some() {
                rep.title = own;
            }
        }
        if g.len() > 1 {
            let mut ids = vec![rep.session_id.clone()];
            for &i in &g {
                if i == rep_idx {
                    continue;
                }
                if let Some((m, _)) = slots[i].take() {
                    ids.push(m.session_id.clone());
                    hidden.push((rep.session_id.clone(), m));
                }
            }
            members.insert(rep.session_id.clone(), ids);
        }
        reps.push(rep);
    }
    (reps, members, hidden)
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
        forked_from: None,
        reader: false,
        reader_pdf: None,
        step_meta: Default::default(),
        relay: Default::default(),
        title_by_user: false,
    })
}

// ===== 快照与 app.db =====

fn snapshots_root() -> Option<PathBuf> {
    crate::dirs::config_dir().map(|d| d.join("ccode").join("snapshots"))
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
    let dir = crate::dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode");
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let conn =
        Connection::open(dir.join("app.db")).map_err(|e| format!("打开 app.db 失败: {e}"))?;
    // 与 projects::db_at / workspaces::db_at 同一口径（同一个 app.db）：不设等待窗口时
    // 本连接是并发写下最先吃 SQLITE_BUSY 的那个（session_meta / card_claims 的写入走这里）
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("设置 app.db 等待时间失败: {e}"))?;
    static WAL_TRIED: std::sync::Once = std::sync::Once::new();
    WAL_TRIED.call_once(|| ensure_wal_mode(&conn));
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
    conn.execute_batch(SESSION_FORKS_DDL)
        .map_err(|e| format!("初始化 session_forks 表失败: {e}"))?;
    Ok(conn)
}

/// Mesa 发起的分叉（2026-10-31）：新会话 → 原会话。CLI 自己写的上游指针（Claude 的接续链、Codex 的
/// forked_from_id、Grok 的 parent_session_id）分不清「接着聊另存」和「分叉」，按接续并成一条会把原对话藏掉；
/// 记在这里的一律当分叉单列，forked_from 指回原对话
const SESSION_FORKS_DDL: &str = "CREATE TABLE IF NOT EXISTS session_forks(
  agent TEXT NOT NULL, child_id TEXT NOT NULL, parent_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(agent, child_id));";

/// (agent, 新会话, 原会话)；库打不开当没有
fn read_session_forks() -> Vec<(String, String, String)> {
    let Ok(conn) = open_db() else { return Vec::new() };
    let Ok(mut stmt) = conn.prepare("SELECT agent, child_id, parent_id FROM session_forks") else {
        return Vec::new();
    };
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

/// 分叉标签认出自己的新会话后登记（运行页调用）。同一个会话不能是自己的分叉
#[tauri::command]
pub async fn record_session_fork(agent: String, child_id: String, parent_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if child_id.trim().is_empty() || parent_id.trim().is_empty() || child_id == parent_id {
            return Err("分叉记录不完整".to_string());
        }
        let conn = open_db()?;
        conn.execute(
            "INSERT INTO session_forks(agent, child_id, parent_id, created_at) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(agent, child_id) DO NOTHING",
            params![agent, child_id, parent_id, now_iso()],
        )
        .map_err(|e| format!("登记分叉失败: {e}"))?;
        invalidate_scan_cache();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 扫描收尾：Mesa 登记的分叉指回原对话所在那一行（原对话并进了链就指链代表）；CLI 已认出的分叉不动
fn apply_session_forks(
    out: &mut [SessionMetaDto],
    chain_members: &HashMap<String, Vec<String>>,
    forks: &[(String, String, String)],
) {
    if forks.is_empty() {
        return;
    }
    let mut rep_of: HashMap<&str, &str> = HashMap::new();
    for (rep, members) in chain_members {
        for m in members {
            rep_of.insert(m.as_str(), rep.as_str());
        }
    }
    let resolve = |id: &str| -> String { rep_of.get(id).copied().unwrap_or(id).to_string() };
    let targets: Vec<(String, String, String)> = forks
        .iter()
        .map(|(agent, child, parent)| (agent.clone(), resolve(child), resolve(parent)))
        .filter(|(_, c, p)| c != p)
        .collect();
    for m in out.iter_mut() {
        if m.forked_from.is_some() {
            continue;
        }
        if let Some((_, _, p)) = targets.iter().find(|(a, c, _)| *a == m.agent && *c == m.session_id) {
            m.forked_from = Some(p.clone());
        }
    }
}

/// 多个 Agent 同时落库时，WAL 让读不被写的提交挡住（默认的回滚日志模式下写提交会短暂独占整库）。
/// journal_mode 写进库文件、一次生效，所以每个进程只试一次；别的连接占着切不动就保持现状，不影响使用
pub(crate) fn ensure_wal_mode(conn: &Connection) {
    let Ok(mode) = conn.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0)) else {
        return;
    };
    if !mode.eq_ignore_ascii_case("wal") {
        let _ = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get::<_, String>(0));
    }
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
        "launch_model TEXT",
        "launch_effort TEXT",
        "title_basis TEXT",
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
    /// title_source=user：人手改的标题（旧数据没有这一列的不算）
    title_by_user: bool,
}

fn read_all_meta(conn: &Connection) -> HashMap<(String, String), MetaRow> {
    let mut map = HashMap::new();
    let Ok(mut stmt) = conn
        .prepare("SELECT agent, session_id, pinned, archived, custom_title, tags, summary, handoff_from_agent, handoff_from_session, task_id, step_name, profile_id, project_path, internal, title_source FROM session_meta")
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
            r.get::<_, Option<String>>(14).unwrap_or(None),
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
            title_source,
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
                    title_by_user: title_source.as_deref() == Some("user"),
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

fn claude_local_output_text(t: &str) -> bool {
    let t = t.trim_start();
    ["<local-command-stdout>", "<local-command-stderr>", "<bash-stdout>", "<bash-stderr>"]
        .iter()
        .any(|tag| t.starts_with(tag))
}

fn claude_local_output_line(v: &Value) -> bool {
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .is_some_and(claude_local_output_text)
}

fn claude_tail_state(lines: &[String]) -> &'static str {
    // Claude 在一轮结束时写 system/turn_duration：这是确定的「回合已结束」，与 TUI 是否还在出字无关
    // （状态行、计时这类重绘会让 PTY 一直有输出，只靠「PTY 静下来」判收尾会永远转圈）。
    // 见到它就把随后找到的那条助手正文判成 settled（问句收尾仍是 confirm）
    let mut turn_ended = false;
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
            Some("system") if get_str(&v, "subtype") == Some("turn_duration") => {
                turn_ended = true;
                continue;
            }
            // 新版把本地命令写成 system/local_command（命令、输出各一行）：输出行同下方 user 输出行，
            // 命令在本机跑完了。会话里第一件事就是 /cost 时没有 turn_duration 可依，不认它就一直「unknown」
            Some("system") if get_str(&v, "subtype") == Some("local_command") => {
                if get_str(&v, "content").is_some_and(claude_local_output_text) {
                    return "settled";
                }
                continue;
            }
            // 回合已结束后往回只遇到 user（被打断、只有工具回执）也算收尾
            Some("user") if turn_ended => return "settled",
            // 本地命令（/model、/effort、! ls…）的输出行：命令在本机跑完了，模型没有在干活
            Some("user") if claude_local_output_line(&v) => return "settled",
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
                    // 尾部有待执行的工具调用；回合都结束了就不是在等工具
                    return if turn_ended { "settled" } else { "working" };
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
                    Some(_) if turn_ended => return "settled",
                    Some(_) => return "done",
                }
            }
            _ => continue,
        }
    }
    if turn_ended {
        "settled"
    } else {
        "unknown"
    }
}

fn codex_tail_state(lines: &[String]) -> &'static str {
    // Codex 一轮结束写 event_msg/task_complete（按 Esc 打断写 turn_aborted）：同 Claude 的 turn_duration，
    // 是确定的回合结束，与 TUI 还出不出字无关。原先判 done，前端要等 PTY 静下来 8 秒才收尾，
    // 内嵌终端里一直有重绘时聊天层就停在「正在回复」（2026-10-18 用户截图：回答早已落盘）
    let mut turn_ended = false;
    let ended = |turn_ended: bool, fallback: &'static str| {
        if turn_ended {
            "settled"
        } else {
            fallback
        }
    };
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
                        Some("user") => return ended(turn_ended, "working"),
                        Some("assistant") => {
                            let text = codex_message_text(p).unwrap_or_default();
                            return if ends_with_question(&text) {
                                "confirm"
                            } else {
                                ended(turn_ended, "done")
                            };
                        }
                        _ => continue,
                    },
                    // 调用未回/刚回，都还在一轮当中
                    Some("function_call") | Some("custom_tool_call") => {
                        return ended(turn_ended, "working")
                    }
                    Some("function_call_output") | Some("custom_tool_call_output") => {
                        return ended(turn_ended, "working")
                    }
                    _ => continue,
                }
            }
            Some("event_msg") => {
                let Some(p) = v.get("payload") else {
                    continue;
                };
                match get_str(p, "type") {
                    Some("user_message") => return ended(turn_ended, "working"),
                    // 中途流式正文不是回合结束；Codex 工具调用之间也会写 agent_message
                    Some("agent_message") => continue,
                    Some("task_complete") | Some("turn_aborted") => {
                        turn_ended = true;
                        continue;
                    }
                    _ => continue,
                }
            }
            _ => continue,
        }
    }
    ended(turn_ended, "unknown")
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
            // 开会话时的环境上下文不是提问：只开了会话还没说话时不能算「干活中」
            Some("user") if gemini_is_injected_context(&v) => continue,
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
            // 回合确定结束（Kimi Code 2.1 wire：agent.turn.ended → turn.ended → prompt.completed），
            // 同 Claude turn_duration / Codex task_complete：不再等 PTY 静下来
            Some("turn.ended") => return "settled",
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
        match get_str(&v, "type") {
            // 工具调用了 / 结果回来了，回答还没写：这一轮还在干活
            Some("function_call" | "function_call_result") => return "working",
            Some("message") => {}
            _ => continue, // file-history-snapshot 等事件行不算数
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
            // 回合确定结束，同 Claude turn_duration：不再等 PTY 静下来
            Some("turn_ended") => return "settled",
            // 用户消息发出后还没等到回合结束；工具调用/结果都在回合进行中
            Some("user_message") | Some("tool_call") | Some("tool_result") => return "working",
            _ => continue,
        }
    }
    "unknown"
}

/// 2.x 有明确的回合结束行（idle）：最后一行是 idle 即回合结束；assistant 还没完成或停在工具调用上算在干活。
/// 系统提示、切模型 / 切 agent 等行不表示回合状态，往前找（升级过来的旧会话末尾常是一条 system 提示）
fn opencode_v2_tail_state(conn: &Connection, sid: &str) -> &'static str {
    for row in query_rows(
        conn,
        "SELECT * FROM session_message WHERE session_id=? ORDER BY seq DESC LIMIT 20",
        &[&sid],
    ) {
        let row = DbRow {
            names: row.0,
            vals: row.1,
        };
        let data = row
            .as_str("data")
            .and_then(|d| serde_json::from_str::<Value>(&d).ok())
            .unwrap_or(Value::Null);
        match row.as_str("type").as_deref() {
            Some("idle") => return "settled",
            Some("user") | Some("shell") => return "working",
            Some("compaction") if get_str(&data, "status") == Some("running") => return "working",
            Some("assistant") => {
                let completed = data.get("time").and_then(|t| t.get("completed")).is_some();
                return if completed && get_str(&data, "finish") != Some("tool-calls") {
                    "done"
                } else {
                    "working"
                };
            }
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
    if opencode_store_of(&conn, &sid) == OpencodeStore::V2 {
        return opencode_v2_tail_state(&conn, &sid);
    }
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
    // 首轮扫描后把五张 meta 缓存表落盘（每进程一次）：下个进程冷启动免重解析
    if let Ok(c) = scan_file_cache().lock() {
        crate::scan_persist::save_once(&c, res.sessions.len());
    }
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

/// 全量扫描 + session_meta 合并（会话列表同口径，不分页）；续聊核对 harness 用
#[cfg(test)]
pub(crate) fn scan_with_meta() -> Vec<SessionMetaDto> {
    let scan = cached_scan();
    let mut sessions = scan.sessions;
    if let Ok(conn) = open_db() {
        let meta = read_all_meta(&conn);
        apply_meta(&mut sessions, &scan.chain_members, &meta);
    }
    sessions
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
            s.title_by_user = row.title_by_user && row.custom_title.is_some();
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

/// 流程对话排第几步：按步骤名在档案卡 steps 里的位置（1 起）。商量任务书的会话在项目根、不在工作区里，
/// 步骤名来自持久列，所以统一按名字查；每个项目根每轮列表只读一次 project.toml
fn apply_step_index(sessions: &mut [SessionMetaDto]) {
    let mut cache: HashMap<String, Vec<String>> = HashMap::new();
    for s in sessions.iter_mut() {
        let Some(name) = s.step_name.as_deref() else {
            continue;
        };
        let order = cache
            .entry(s.project_path.clone())
            .or_insert_with(|| crate::projects::step_order_at(Path::new(&s.project_path)));
        s.step_meta.step_index = step_index_in(order, name);
    }
}

pub(crate) fn step_index_in(order: &[String], name: &str) -> Option<u32> {
    order
        .iter()
        .position(|n| n == name)
        .and_then(|i| u32::try_from(i + 1).ok())
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
        } else if crate::usage::is_watch_worktree_cwd(&session.project_path) {
            // 定时雷达隔离 worktree：无头自动活动，失败运行漏标 internal 的读取侧兜底
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
        crate::relay::apply_relay_chains(&conn, &mut sessions);
        apply_card_claims(&conn, &mut sessions);
        apply_step_claims(&conn, &mut sessions);
        crate::runs::apply_reader_runs(&conn, &mut sessions, &scan.chain_members);
        crate::runs::apply_step_runs(&conn, &mut sessions, &scan.chain_members);
    }
    apply_task_names(&mut sessions);
    apply_step_index(&mut sessions);
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

/// 按 id 找一条会话（聊天层已从旁路 / hook 知道会话 id 时用）。10 秒扫描缓存里还没有它（刚建的会话）就失效重扫一次，
/// 每 2 秒至多一次——否则聊天层要等满一轮缓存才接上，短回复在这一轮结束后先消失、隔几秒才出来（2026-10-21 OpenCode 实测）
#[tauri::command]
pub async fn find_session(agent: String, session_id: String) -> Option<SessionMetaDto> {
    tauri::async_runtime::spawn_blocking(move || find_session_sync(&agent, &session_id))
        .await
        .ok()
        .flatten()
}

pub(crate) fn find_session_sync(agent: &str, session_id: &str) -> Option<SessionMetaDto> {
    let pick = |list: Vec<SessionMetaDto>| {
        list.into_iter()
            .find(|s| s.agent == agent && s.session_id == session_id)
    };
    if let Some(found) = pick(list_sessions_sync()) {
        return Some(found);
    }
    static LAST_RESCAN: Mutex<Option<Instant>> = Mutex::new(None);
    {
        let mut last = LAST_RESCAN.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(2)) {
            return None;
        }
        *last = Some(Instant::now());
    }
    invalidate_scan_cache();
    pick(list_sessions_sync())
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

/// 记下这段对话用哪条连接启动的；`launch` 带上时一并记这次启动的模型与思考档（空串 = 用连接 / CLI 默认）。
/// 接着聊时输入框默认按它来（session_resume_config），会话文件里读得到的以文件为准
pub(crate) fn set_session_profile(
    agent: &str,
    session_id: &str,
    profile_id: &str,
    launch: Option<(&str, &str)>,
) -> Result<(), String> {
    let conn = open_db()?;
    set_session_profile_at(&conn, agent, session_id, profile_id, launch)?;
    invalidate_scan_cache();
    Ok(())
}

fn set_session_profile_at(
    conn: &Connection,
    agent: &str,
    session_id: &str,
    profile_id: &str,
    launch: Option<(&str, &str)>,
) -> Result<(), String> {
    match launch {
        Some((model, effort)) => conn.execute(
            "INSERT INTO session_meta(agent, session_id, profile_id, launch_model, launch_effort)
             VALUES(?1, ?2, ?3, NULLIF(?4, ''), NULLIF(?5, ''))
             ON CONFLICT(agent, session_id) DO UPDATE SET profile_id=?3,
               launch_model=COALESCE(NULLIF(?4, ''), launch_model), launch_effort=NULLIF(?5, '')",
            params![agent, session_id, profile_id, model.trim(), effort.trim()],
        ),
        None => conn.execute(
            "INSERT INTO session_meta(agent, session_id, profile_id) VALUES(?1, ?2, ?3)
             ON CONFLICT(agent, session_id) DO UPDATE SET profile_id=?3",
            params![agent, session_id, profile_id],
        ),
    }
    .map(|_| ())
    .map_err(|e| format!("写入会话连接归属失败: {e}"))
}

#[tauri::command]
pub async fn set_session_profile_command(
    agent: String,
    session_id: String,
    profile_id: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_session_profile_command_sync(agent, session_id, profile_id, model, effort))
        .await
        .map_err(|e| e.to_string())?
}
fn set_session_profile_command_sync(
    agent: String,
    session_id: String,
    profile_id: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    let launch = model
        .as_deref()
        .map(|m| (m, effort.as_deref().unwrap_or("")));
    set_session_profile(&agent, &session_id, &profile_id, launch)
}

/// Mesa 启动这段对话时记下的模型（研究记录在用量还没索引到时兜底）
pub(crate) fn launch_model_of(agent: &str, session_id: &str) -> Option<String> {
    let conn = open_db().ok()?;
    conn.query_row(
        "SELECT launch_model FROM session_meta WHERE agent=?1 AND session_id=?2",
        params![agent, session_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
    .filter(|m| !m.trim().is_empty())
}

/// 接着聊一段对话时默认用的模型与思考档（2026-10-24 用户：点开一段对话，输入框底部应是它之前用的配置）
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumeConfigDto {
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// 模型：会话文件里最后一轮实际用的（CLI 里中途 /model 换过的也算），读不到用 Mesa 启动时记下的；
/// 思考档：Codex 文件每轮都记，别家只有 Mesa 启动时记下的。连接不在这里：列表里的 profileId 已经带着
fn session_resume_config_at(
    conn: &Connection,
    agent: &str,
    session_id: &str,
    file_path: &str,
) -> SessionResumeConfigDto {
    let (launch_model, launch_effort) = conn
        .query_row(
            "SELECT launch_model, launch_effort FROM session_meta WHERE agent=?1 AND session_id=?2",
            params![agent, session_id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .unwrap_or((None, None));
    let file_effort = if agent == "codex" {
        crate::usage::last_codex_effort(file_path)
    } else {
        None
    };
    let mut file_model = crate::usage::last_session_model(agent, file_path, session_id);
    if agent == "kimi" {
        let config = SessionRoots::current()
            .and_then(|r| fs::read_to_string(r.kimi_code.join("config.toml")).ok())
            .unwrap_or_default();
        file_model = file_model.and_then(|alias| kimi_model_from_alias(&alias, &config));
    }
    SessionResumeConfigDto {
        model: file_model.or(launch_model),
        effort: file_effort.or(launch_effort),
    }
}

/// Kimi 会话文件记的是 config.toml 里的模型别名（`zetatechs/kimi-k3`、Mesa 启动时合成的 `__kimi_env_model__`），
/// 不是网关上的模型名——原样拿去续聊，网关报「No available channel for model zetatechs/kimi-k3」（2026-11-03 实测）。
/// 按 `[models.<别名>].model` 换回真名；Mesa 合成的别名只活在那次启动的环境变量里，换不回给 None（调用方用启动时记下的）
fn kimi_model_from_alias(alias: &str, config: &str) -> Option<String> {
    if alias == crate::agents::KIMI_ENV_MODEL_ALIAS {
        return None;
    }
    let real = config
        .parse::<toml::Table>()
        .ok()
        .and_then(|t| {
            t.get("models")?
                .get(alias)?
                .get("model")?
                .as_str()
                .map(str::to_string)
        });
    real.or_else(|| Some(alias.to_string()))
        .filter(|m| !m.trim().is_empty())
}

/// session_resume_config 的同步版（续聊核对 harness 用，同一口径）
#[cfg(test)]
pub(crate) fn session_resume_config_sync(agent: &str, session_id: &str, file_path: &str) -> SessionResumeConfigDto {
    open_db()
        .map(|conn| session_resume_config_at(&conn, agent, session_id, file_path))
        .unwrap_or_default()
}

#[tauri::command]
pub async fn session_resume_config(
    agent: String,
    session_id: String,
    file_path: String,
) -> Result<SessionResumeConfigDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        Ok(session_resume_config_at(&conn, &agent, &session_id, &file_path))
    })
    .await
    .map_err(|e| e.to_string())?
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

/// 已认领的标签，CLI 换了会话文件之后接着跟：Gemini / Kimi / Grok 打 /clear 会另开新会话文件（2026-10-20 三家实测），
/// 它们默认没有旁路报「换了会话」，标签一直盯着旧文件、聊天层看不到新回复（三平台都有）。
/// 同 agent 同目录出现了比当前认领更新、启动前没有、也没被任何标签认领过的会话就改认它（取最新的）；
/// 同 agent 同目录还有别的标签登记着时不猜——分不清是哪个标签开的新对话，宁可不跟也不抢
#[tauri::command]
pub async fn claim_session_successor(claim_id: String) -> Option<SessionMetaDto> {
    let scan = tauri::async_runtime::spawn_blocking(cached_scan)
        .await
        .ok()?;
    let mut registry = session_claims().lock().ok()?;
    let mut found = pick_claim_successor(&mut registry, &claim_id, scan.sessions)?;
    drop(registry);
    redact_session_meta(std::slice::from_mut(&mut found));
    Some(found)
}

fn claim_time(session: &SessionMetaDto) -> &str {
    session
        .created_at
        .as_deref()
        .unwrap_or(session.updated_at.as_deref().unwrap_or(""))
}

fn pick_claim_successor(
    registry: &mut SessionClaimRegistry,
    claim_id: &str,
    sessions: Vec<SessionMetaDto>,
) -> Option<SessionMetaDto> {
    let context = registry.contexts.get(claim_id)?.clone();
    let current = registry.assignments.get(claim_id)?.clone();
    let rivals = registry.contexts.iter().any(|(id, other)| {
        id != claim_id
            && other.agent == context.agent
            && crate::paths::same_path(&other.project_path, &context.project_path)
    });
    if rivals {
        return None;
    }
    let current_time = sessions
        .iter()
        .find(|s| s.agent == current.0 && s.session_id == current.1)
        .map(|s| claim_time(s).to_string())?;
    let mut taken = registry.used_sessions.clone();
    taken.extend(registry.assignments.values().cloned());
    let next = sessions
        .into_iter()
        .filter(|s| {
            s.agent == context.agent
                && crate::paths::same_path(&s.project_path, &context.project_path)
                && !context.excluded.contains(&s.session_id)
                && !taken.contains(&(s.agent.clone(), s.session_id.clone()))
                && claim_time(s) > current_time.as_str()
        })
        .max_by(|a, b| claim_time(a).cmp(claim_time(b)).then(a.session_id.cmp(&b.session_id)))?;
    registry.used_sessions.insert(current);
    registry
        .assignments
        .insert(claim_id.to_string(), (next.agent.clone(), next.session_id.clone()));
    Some(next)
}

/// 注意力标记 v1（§6.11）：读会话文件尾部分类 done/working/confirm/unknown
#[tauri::command]
pub async fn session_tail_state(agent: String, file_path: String) -> String {
    tauri::async_runtime::spawn_blocking(move || tail_state_impl(&agent, &file_path))
        .await
        .unwrap_or_else(|_| "unknown".into())
}

/// Claude 会话里最近一次记下的权限模式（`permission-mode` 行，或 user 行上的 permissionMode 字段）。
/// 运行中在终端切了模式（审批菜单里「切到 auto」、Shift+Tab）时，聊天层权限徽标靠它跟上
/// （2026-10-19 用户：点了切换，终端变了，聊天层还是原来那档）。别家暂不读，返回 None。
fn claude_permission_mode(lines: &[String]) -> Option<String> {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        if get_str(&v, "type") == Some("permission-mode") {
            if let Some(m) = get_str(&v, "permissionMode") {
                return Some(m.to_string());
            }
        }
        if get_str(&v, "type") == Some("user") {
            if let Some(m) = get_str(&v, "permissionMode") {
                return Some(m.to_string());
            }
        }
    }
    None
}

#[tauri::command]
pub async fn session_permission_mode(agent: String, file_path: String) -> Option<String> {
    if agent != "claude-code" {
        return None;
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Claude 每轮可能写一行几百 KB 的附件，窗口放宽些；permission-mode 行每轮都会再写
        claude_permission_mode(&last_lines(Path::new(&file_path), 512 * 1024))
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn get_session_conversation(agent: String, file_path: String) -> Vec<ChatMessageDto> {
    conversation_impl(&agent, &file_path)
}

const CONVERSATION_PAGE_BYTES: u64 = 192 * 1024;
/// 一页凑不够消息时窗口逐次翻倍往前读，单步最多这么大（重解析总量保持在最终读量的两倍内）
const CONVERSATION_PAGE_MAX_STEP: u64 = CONVERSATION_PAGE_BYTES * 8;
/// 一次请求最多往前扫这么多字节（Codex 工具行经常 >192KB，空窗必须连跳）。
const CONVERSATION_PAGE_SCAN_LIMIT: u64 = CONVERSATION_PAGE_BYTES * 40;
const OPENCODE_PAGE_MESSAGES: usize = 80;
/// 一页至少解析出这么多条消息才停：Claude 每轮写一行几百 KB 的 prompt_snapshot 附件，
/// 192KB 的窗常常只剩最后一句提问（2026-10-17 用户截图）；原先 6 条一页，工具调用也算条数，
/// 看长对话要一直点「加载更早」（2026-10-21 用户），提到 40 条并配合前端滚到顶自动加载
const CONVERSATION_PAGE_MIN_MESSAGES: usize = 40;

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
    let mut step = CONVERSATION_PAGE_BYTES;
    loop {
        let start = end.saturating_sub(step);
        let win = read_jsonl_window(&mut file, start, end)?;
        let mut combined = win.lines;
        combined.append(&mut lines);
        lines = combined;
        scanned = scanned.saturating_add(step);
        step = (step * 2).min(CONVERSATION_PAGE_MAX_STEP);
        let mut messages = parse_session_lines(agent, &lines);
        if messages.len() >= CONVERSATION_PAGE_MIN_MESSAGES
            || win.cursor.is_none()
            || scanned >= CONVERSATION_PAGE_SCAN_LIMIT
        {
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
    let store = opencode_store_of(&conn, &sid);
    let table = store.message_table();
    let before_i64 = before.map(|value| value.min(i64::MAX as u64) as i64);
    let (message_rows, cursor) = if let Some(at) = around {
        let at_i = at.min(i64::MAX as u64) as i64;
        let mut older: Vec<DbRow> = query_rows(
            &conn,
            &format!("SELECT * FROM {table} WHERE session_id=? AND time_created<=? ORDER BY time_created DESC LIMIT 40"),
            &[&sid, &at_i],
        )
        .into_iter()
        .map(|row| DbRow { names: row.0, vals: row.1 })
        .collect();
        let newer: Vec<DbRow> = query_rows(
            &conn,
            &format!("SELECT * FROM {table} WHERE session_id=? AND time_created>? ORDER BY time_created ASC LIMIT 40"),
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
            query_rows(&conn, &format!("SELECT * FROM {table} WHERE session_id=? AND time_created<? ORDER BY time_created DESC LIMIT 80"), &[&sid, &before])
        } else {
            query_rows(
                &conn,
                &format!("SELECT * FROM {table} WHERE session_id=? ORDER BY time_created DESC LIMIT 80"),
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
    let mut messages: Vec<ChatMessageDto> = opencode_rows_with_parts(&conn, store, message_rows)
        .into_iter()
        .filter_map(|(_, ts, data, parts)| opencode_message(&data, parts.iter().collect(), ts))
        .collect();
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

/// 某个分页位置之前的全部记录，一次给齐（2026-10-26 用户对照 Claude 客户端：往上翻要丝滑、滚动条别一下变短）。
/// 打开一段对话先摆最近一页，随后在后台用它把更早的一次接齐，前端不再一页页往上接。
/// 普通 jsonl 直接读 [0, before) 解析一遍；OpenCode / Grok 的分页位置不是字节偏移，按页往前接到头。
/// 实测（release）：p50 4.9MB 会话 17ms / 439 条，p90 15MB 55ms / 1422 条，最大 93MB 219ms / 5042 条。
#[tauri::command]
pub async fn get_session_conversation_rest(
    agent: String,
    file_path: String,
    before: u64,
) -> Result<ConversationPageDto, String> {
    tauri::async_runtime::spawn_blocking(move || conversation_rest_impl(&agent, &file_path, before))
        .await
        .map_err(|e| format!("读取更早的记录失败: {e}"))?
}

pub(crate) fn conversation_rest_impl(
    agent: &str,
    file_path: &str,
    before: u64,
) -> Result<ConversationPageDto, String> {
    if agent != "opencode" && agent != "grok" {
        let source = PathBuf::from(file_path);
        let path = if source.exists() {
            source
        } else {
            find_snapshot(agent, &source).ok_or("会话文件已不存在，且没有可用快照")?
        };
        let mut magic = [0u8; 4];
        let compressed = fs::File::open(&path)
            .and_then(|mut file| file.read_exact(&mut magic))
            .is_ok()
            && magic == ZSTD_MAGIC;
        // 压缩会话没有更早一页（首屏 cursor 就是 None），走不到这里；到了也不读
        if compressed {
            return Ok(ConversationPageDto { messages: Vec::new(), cursor: None });
        }
        let mut file = fs::File::open(&path).map_err(|e| format!("读取会话失败: {e}"))?;
        let len = file
            .metadata()
            .map_err(|e| format!("读取会话信息失败: {e}"))?
            .len();
        let win = read_jsonl_window(&mut file, 0, before.min(len))?;
        let mut messages = parse_session_lines(agent, &win.lines);
        redact_conversation(&mut messages);
        return Ok(ConversationPageDto { messages, cursor: None });
    }
    let mut out: Vec<ChatMessageDto> = Vec::new();
    let mut cursor = Some(before);
    // 防原地打转：分页位置必须一直往前
    while let Some(at) = cursor {
        let page = conversation_page_impl(agent, file_path, Some(at), None)?;
        let mut messages = page.messages;
        messages.append(&mut out);
        out = messages;
        cursor = page.cursor.filter(|next| *next < at);
    }
    Ok(ConversationPageDto { messages: out, cursor: None })
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
                "command" => out.push_str(&format!("\n**命令** `{}`\n", b.text)),
                "command_output" => {
                    let f = fence_for(&b.text);
                    out.push_str(&format!("\n{f}text\n{}\n{f}\n", b.text));
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

/// 研究过程报告附对话原文用（2026-11-02）：按 agent + session_id 找到会话文件，渲成 Markdown 并整份脱敏；找不到或空给 None
pub(crate) fn session_markdown(agent: &str, session_id: &str) -> Option<String> {
    let meta = cached_scan()
        .sessions
        .into_iter()
        .find(|s| s.agent == agent && s.session_id == session_id)?;
    let msgs = conversation_impl(agent, &meta.file_path);
    if msgs.is_empty() {
        return None;
    }
    let title = meta.title.clone().unwrap_or_else(|| session_id.to_string());
    Some(redact_sensitive_text(&render_markdown(agent, session_id, &redact_sensitive_text(&title), &msgs)))
}

/// 一行里内嵌图片的字节数（2026-11-11，借 ClawChat 实测）：Codex 把看过的每张图以 `data:image/…;base64,…` 原样存进会话、
/// 每轮整个重发；按 base64 长度 × 3/4 估原始字节
pub(crate) fn inline_image_bytes(line: &str) -> u64 {
    let mut total = 0u64;
    let mut rest = line;
    while let Some(i) = rest.find("data:image/") {
        let after = &rest[i..];
        let Some(b) = after.find(";base64,") else { break };
        let payload = &after[b + 8..];
        let end = payload.find(|c: char| !(c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=')).unwrap_or(payload.len());
        total += (end as u64) * 3 / 4;
        rest = &payload[end..];
    }
    total
}

/// Codex 会话里累计存了多少图片（字节）：按文件大小 + 修改时间缓存，文件不变不重读
#[tauri::command]
pub async fn session_image_bytes(agent: String, session_id: String) -> Result<u64, String> {
    use std::io::BufRead;
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, (u64, std::time::SystemTime, u64)>>> =
        std::sync::OnceLock::new();
    tauri::async_runtime::spawn_blocking(move || {
        if agent != "codex" {
            return Ok(0);
        }
        let Some(meta) = cached_scan().sessions.into_iter().find(|s| s.agent == agent && s.session_id == session_id) else {
            return Ok(0);
        };
        let path = std::path::PathBuf::from(&meta.file_path);
        let stat = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        let (size, mtime) = (stat.len(), stat.modified().unwrap_or(std::time::UNIX_EPOCH));
        let cache = CACHE.get_or_init(Default::default);
        if let Some((s, m, b)) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&meta.file_path) {
            if *s == size && *m == mtime {
                return Ok(*b);
            }
        }
        let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut bytes = 0u64;
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            bytes += inline_image_bytes(&line);
        }
        cache.lock().unwrap_or_else(|e| e.into_inner()).insert(meta.file_path.clone(), (size, mtime, bytes));
        Ok(bytes)
    })
    .await
    .map_err(|e| e.to_string())?
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
    let downloads = crate::dirs::download_dir()
        .or_else(|| crate::dirs::home_dir().map(|h| h.join("Downloads")))
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
pub async fn unpin_session(
    agent: String,
    session_id: String,
    delete_snapshot: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || unpin_session_sync(agent, session_id, delete_snapshot))
        .await
        .map_err(|e| e.to_string())?
}
fn unpin_session_sync(
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
pub async fn set_session_meta(
    agent: String,
    session_id: String,
    custom_title: Option<String>,
    tags: Vec<String>,
    archived: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_session_meta_sync(agent, session_id, custom_title, tags, archived))
        .await
        .map_err(|e| e.to_string())?
}
fn set_session_meta_sync(
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

/// 自动起名要看的那一行：现标题、来源、上次起名用的材料指纹（title_basis）。
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct TitleState {
    pub custom_title: Option<String>,
    pub source: Option<String>,
    pub basis: Option<String>,
}

impl TitleState {
    /// 人手改过的标题，或旧数据没有 title_source 但已有自定义标题：自动起名不得覆盖。
    pub(crate) fn user_owned(&self) -> bool {
        if self.source.as_deref() == Some("user") {
            return true;
        }
        self.source.is_none() && self.current_title().is_some()
    }

    pub(crate) fn current_title(&self) -> Option<&str> {
        self.custom_title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
    }
}

pub(crate) fn session_title_state(agent: &str, session_id: &str) -> Option<TitleState> {
    let conn = open_db().ok()?;
    conn.query_row(
        "SELECT custom_title, title_source, title_basis FROM session_meta WHERE agent=?1 AND session_id=?2",
        params![agent, session_id],
        |r| {
            Ok(TitleState {
                custom_title: r.get(0)?,
                source: r.get(1)?,
                basis: r.get(2)?,
            })
        },
    )
    .ok()
}

/// 补名批用：一次读出全部会话的起名状态，免得逐条开库。
pub(crate) fn all_title_states() -> HashMap<(String, String), TitleState> {
    let mut map = HashMap::new();
    let Ok(conn) = open_db() else {
        return map;
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT agent, session_id, custom_title, title_source, title_basis FROM session_meta",
    ) else {
        return map;
    };
    if let Ok(rows) = stmt.query_map([], |r| {
        Ok((
            (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
            TitleState {
                custom_title: r.get(2)?,
                source: r.get(3)?,
                basis: r.get(4)?,
            },
        ))
    }) {
        map.extend(rows.flatten());
    }
    map
}

/// 已有合格的自动标题、只是没记过材料指纹（指纹之前的老标题）：补记指纹，不动标题。
pub(crate) fn record_title_basis(agent: &str, session_id: &str, basis: &str) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute(
        "UPDATE session_meta SET title_basis=?3
         WHERE agent=?1 AND session_id=?2 AND title_source='auto'",
        params![agent, session_id, basis],
    )
    .map_err(|e| format!("记录起名依据失败: {e}"))?;
    Ok(())
}

/// 自动起名写入。人手改过的标题（title_source=user）不覆盖；机器临时标题可被聊完校正覆盖。
/// `basis` = 这次起名用的材料指纹，同样的材料下次不再问 AI；None 保留原指纹（只去重改名时）。
/// 返回是否写入。
pub(crate) fn try_set_custom_title(
    agent: &str,
    session_id: &str,
    title: &str,
    basis: Option<&str>,
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
        "INSERT INTO session_meta(agent, session_id, custom_title, title_source, title_basis)
         VALUES(?1, ?2, ?3, 'auto', ?4)
         ON CONFLICT(agent, session_id) DO UPDATE SET custom_title=?3, title_source='auto',
           title_basis=COALESCE(?4, session_meta.title_basis)
         WHERE session_meta.title_source IS NULL OR session_meta.title_source != 'user'",
        params![agent, session_id, title, basis],
    )
    .map_err(|e| format!("写入会话标题失败: {e}"))?;
    invalidate_scan_cache();
    Ok(true)
}

/// 其它会话已占用的展示标题（不含本条），供自动起名去重；按写入先后排，越新越靠后。
pub(crate) fn list_custom_titles_except(agent: &str, session_id: &str) -> Vec<String> {
    let Ok(conn) = open_db() else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT custom_title FROM session_meta
         WHERE custom_title IS NOT NULL AND TRIM(custom_title) != ''
           AND NOT (agent = ?1 AND session_id = ?2)
         ORDER BY rowid",
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

/// 会话归卡（任务卡）：写 session_meta.task_id；None 或空白 = 移出卡片。
/// 只存 id，卡片名在列表时按项目档案卡回填（卡片改名/删除不需要回写这里）。
#[tauri::command]
pub async fn assign_session_task(
    agent: String,
    session_id: String,
    task_id: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || assign_session_task_sync(agent, session_id, task_id))
        .await
        .map_err(|e| e.to_string())?
}
fn assign_session_task_sync(
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
pub async fn claim_next_session_for_card(
    agent: String,
    cwd: String,
    task_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || claim_next_session_for_card_sync(agent, cwd, task_id))
        .await
        .map_err(|e| e.to_string())?
}
fn claim_next_session_for_card_sync(
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
pub async fn claim_next_session_for_step(
    agent: String,
    cwd: String,
    step_name: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || claim_next_session_for_step_sync(agent, cwd, step_name))
        .await
        .map_err(|e| e.to_string())?
}
fn claim_next_session_for_step_sync(
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
    let mut dirs = SessionRoots::current()
        .map(|r| session_data_dirs_at(&r))
        .unwrap_or_default();
    if let Some(snap) = snapshots_root() {
        // pin 快照：.jsonl/.jsonl.zst，opencode 快照是导出的 .json
        dirs.push((snap, true));
    }
    dirs
}

/// 预分配会话 id（--session-id）的 CLI 在第一条消息之前不落盘：启动后直接退出、启动即崩，
/// Run 上记着 id，盘上却没有这段对话，按 id 恢复会报「No conversation found」并以 1 退出。
/// 返回 Some(false) = 确定没有；Some(true) = 找到了；None = 这家不判（布局未核实，照常恢复）。
/// `env` 是本次启动注入的变量：配置目录搬迁（CLAUDE_CONFIG_DIR 等）以它为准，其次进程环境，
/// 默认目录也一并查——任一处有就算有，宁可放过也不误判成没有。
pub(crate) fn fixed_id_session_exists(
    agent: &str,
    session_id: &str,
    env: &[(String, String)],
) -> Option<bool> {
    let home = crate::dirs::home_dir()?;
    fixed_id_session_exists_at(&home, agent, session_id, env)
}

fn fixed_id_session_exists_at(
    home: &Path,
    agent: &str,
    session_id: &str,
    env: &[(String, String)],
) -> Option<bool> {
    let (var, default_root) = match agent {
        // 两家都是 <root>/projects/<cwd 编码>/<uuid>.jsonl
        "claude-code" => ("CLAUDE_CONFIG_DIR", home.join(".claude")),
        "codebuddy" => ("CODEBUDDY_CONFIG_DIR", home.join(".codebuddy")),
        _ => return None,
    };
    let sid = session_id.trim();
    // id 里带路径分隔符不是合法会话 id，交给 CLI 自己报错
    if sid.is_empty() || sid.contains(['/', '\\']) {
        return None;
    }
    let mut roots = vec![default_root];
    let injected = env
        .iter()
        .find(|(k, _)| k == var)
        .map(|(_, v)| v.clone())
        .or_else(|| std::env::var(var).ok())
        .filter(|v| !v.trim().is_empty());
    if let Some(root) = injected {
        roots.push(PathBuf::from(root));
    }
    let file = format!("{sid}.jsonl");
    for root in roots {
        let Ok(dirs) = std::fs::read_dir(root.join("projects")) else {
            continue;
        };
        for dir in dirs.flatten() {
            if dir.path().join(&file).is_file() {
                return Some(true);
            }
        }
    }
    Some(false)
}

#[cfg(test)]
mod fixed_id_session_tests;

/// 各家会话数据的根目录。会话扫描、删除白名单、会话导入只从这里取，不得再写 `home.join(".xxx")`：
/// 配置根一律经 `agent_specs::agent_config_root_with`（与设为全局 / MCP / 技能同一个函数，认 CLAUDE_CONFIG_DIR、
/// CODEX_HOME、GEMINI_CLI_HOME、QWEN_HOME、KIMI_CODE_HOME、KIMI_SHARE_DIR、CODEBUDDY_CONFIG_DIR、GROK_HOME），
/// 2026-11-01 前读侧写死家目录，设了搬迁变量的用户配置写对了地方、会话却看不见。
/// 会话另有自己搬家变量的两家在这里补：Qwen 的运行时目录、Cursor 的 `CURSOR_DATA_DIR`。
pub(crate) struct SessionRoots {
    /// `<root>/projects/<slug>/<uuid>.jsonl`
    pub claude: PathBuf,
    /// `<root>/sessions|archived_sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`
    pub codex: PathBuf,
    /// `.gemini` 目录本身：`<root>/tmp/<slug>/chats/*.jsonl`、`<root>/projects.json`
    pub gemini: PathBuf,
    /// Qwen 运行时目录（不一定是配置根）：`<root>/projects/<slug>/chats/**/*.jsonl`
    pub qwen: PathBuf,
    /// Kimi Code（新版）：`<root>/session_index.jsonl` + `<root>/sessions/`
    pub kimi_code: PathBuf,
    /// 旧版 kimi-cli：`<root>/kimi.json` + `<root>/sessions/<md5>/<uuid>/context.jsonl`
    pub kimi_legacy: PathBuf,
    /// `<root>/projects/<slug>/<uuid>.jsonl`
    pub codebuddy: PathBuf,
    /// `<root>/projects/<编码cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`
    pub cursor: PathBuf,
    /// `<root>/sessions/<encoded-cwd>/<session-id>/updates.jsonl`
    pub grok: PathBuf,
    /// OpenCode 旧版 storage（v1.2+ 的共享 SQLite 另走 `opencode_db_candidates`）
    pub opencode_legacy: PathBuf,
}

impl SessionRoots {
    /// `env` 由调用方给：生产读进程环境（登录 shell 的搬迁变量已在启动时导入），测试传假表
    pub(crate) fn with(home: &Path, env: &dyn Fn(&str) -> Option<PathBuf>) -> Self {
        let root = |agent: &str| {
            crate::agent_specs::agent_config_root_with(agent, home, env)
                .expect("九家 agent 都有配置根")
        };
        let qwen_config = root("qwen");
        Self {
            claude: root("claude-code"),
            codex: root("codex"),
            gemini: root("gemini"),
            qwen: qwen_runtime_root(home, &qwen_config, env),
            kimi_code: root("kimi"),
            kimi_legacy: crate::agent_specs::kimi_legacy_root_with(home, env),
            codebuddy: root("codebuddy"),
            // 配置根仍是 ~/.cursor（mcp.json 等写死在那），会话目录另认 CURSOR_DATA_DIR
            //（2026.10.22 bundle `cursor-config/dist/paths.js`）
            cursor: env("CURSOR_DATA_DIR").unwrap_or_else(|| home.join(".cursor")),
            grok: root("grok"),
            opencode_legacy: home.join(".local").join("share").join("opencode").join("storage"),
        }
    }

    /// 没有搬迁变量时的家目录默认布局（测试与只认家目录的旧调用）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn at(home: &Path) -> Self {
        Self::with(home, &|_| None)
    }

    pub(crate) fn current() -> Option<Self> {
        let home = crate::dirs::home_dir()?;
        Some(Self::with(&home, &crate::agent_specs::env_path))
    }

    pub(crate) fn claude_projects(&self) -> PathBuf {
        self.claude.join("projects")
    }

    pub(crate) fn cursor_projects(&self) -> PathBuf {
        self.cursor.join("projects")
    }

    pub(crate) fn kimi_index(&self) -> PathBuf {
        self.kimi_code.join("session_index.jsonl")
    }

    pub(crate) fn kimi_legacy_json(&self) -> PathBuf {
        self.kimi_legacy.join("kimi.json")
    }

    pub(crate) fn codex_dirs(&self) -> [PathBuf; 2] {
        [
            self.codex.join("sessions"),
            self.codex.join("archived_sessions"),
        ]
    }

    /// 各根 canonicalize 一遍（macOS /var → /private/var；不存在的保持原样），供落位校验二次比对
    pub(crate) fn canonicalized(&self) -> Self {
        let c = |p: &PathBuf| p.canonicalize().unwrap_or_else(|_| p.clone());
        Self {
            claude: c(&self.claude),
            codex: c(&self.codex),
            gemini: c(&self.gemini),
            qwen: c(&self.qwen),
            kimi_code: c(&self.kimi_code),
            kimi_legacy: c(&self.kimi_legacy),
            codebuddy: c(&self.codebuddy),
            cursor: c(&self.cursor),
            grok: c(&self.grok),
            opencode_legacy: c(&self.opencode_legacy),
        }
    }
}

/// Qwen 会话所在的运行时目录（0.26.3 `Storage.getRuntimeBaseDir`）：
/// `QWEN_RUNTIME_DIR` > 用户 settings 的 `advanced.runtimeOutputDir` > 配置根（`QWEN_HOME`）。
/// 相对路径 Qwen 按它自己的 cwd / 工作区解析，Mesa 无从得知，按配置根处理（看不见好过看错地方）。
fn qwen_runtime_root(
    home: &Path,
    config_root: &Path,
    env: &dyn Fn(&str) -> Option<PathBuf>,
) -> PathBuf {
    let absolute = |raw: &str| -> Option<PathBuf> {
        let raw = raw.trim();
        let p = if raw == "~" {
            home.to_path_buf()
        } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
            home.join(rest)
        } else {
            PathBuf::from(raw)
        };
        p.is_absolute().then_some(p)
    };
    if let Some(dir) = env("QWEN_RUNTIME_DIR") {
        return absolute(&dir.to_string_lossy()).unwrap_or_else(|| config_root.to_path_buf());
    }
    let configured = fs::read_to_string(config_root.join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&crate::mcp::strip_jsonc(&t)).ok())
        .and_then(|v| {
            v.get("advanced")?
                .get("runtimeOutputDir")?
                .as_str()
                .map(str::to_string)
        })
        .filter(|s| !s.trim().is_empty());
    match configured {
        Some(dir) => absolute(&dir).unwrap_or_else(|| config_root.to_path_buf()),
        None => config_root.to_path_buf(),
    }
}

/// 各 CLI 会话数据目录（不含 Mesa pin 快照）。
/// 导入白名单与删除白名单同源；测试传 `SessionRoots::at(假 home)` 或带假搬迁变量的 `with`。
pub(crate) fn session_data_dirs_at(roots: &SessionRoots) -> Vec<(PathBuf, bool)> {
    let [codex_sessions, codex_archived] = roots.codex_dirs();
    vec![
        // claude: projects/<dir>/<uuid>.jsonl；codex: sessions|archived_sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]
        (roots.claude_projects(), false),
        (codex_sessions, false),
        (codex_archived, false),
        // gemini: tmp/<slug>/chats/*.jsonl；qwen: projects/**/chats/**/*.jsonl
        (roots.gemini.join("tmp"), false),
        (roots.qwen.join("projects"), false),
        // kimi 旧版 sessions/<md5>/<uuid>/context.jsonl（同目录 state.json 不许删 → .json 不放行）
        (roots.kimi_legacy.join("sessions"), false),
        // kimi 新版 sessions/<wd_*>/<id>/agents/main/wire.jsonl；
        // 枚举入口 session_index.jsonl 在 Kimi Code 根上，限定 sessions/ 子目录后自然排除
        (roots.kimi_code.join("sessions"), false),
        // OpenCode legacy storage：session/message/part 都是 .json（v1.2+ 的共享 SQLite 走删行，不在这里）
        (roots.opencode_legacy.clone(), true),
        // codebuddy: projects/<slug>/<uuid>.jsonl（同根的 .credentials.json 等不许删 → 限定 projects 子目录）
        (roots.codebuddy.join("projects"), false),
        // grok: sessions/<encoded-cwd>/<session-id>/updates.jsonl（同根的 auth.json/config.toml
        // 与 sessions 根的 session_search.sqlite 不许删 → 限定 sessions 子目录）
        (roots.grok.join("sessions"), false),
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
            SessionRoots::current().and_then(|r| r.cursor_projects().canonicalize().ok())
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
    delete_source_file_mode(file_path, false)
}

/// permanent = true 只给「内部对话保留期清理」用：Mesa 自己产生的一次性后台对话，
/// 成千上万条逐个进回收站既慢（Finder 逐批调度）又把回收站塞满；用户手动删除照旧进回收站。
fn delete_source_file_mode(file_path: &str, permanent: bool) -> Result<bool, String> {
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
        if permanent {
            fs::remove_file(&p).map_err(|e| format!("删除 {c} 失败: {e}"))?;
        } else {
            trash::delete(&p).map_err(|e| format!("删除 {c} 失败: {e}"))?;
        }
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
    let tables: HashSet<String> = query_rows(&conn, "SELECT name FROM sqlite_master WHERE type='table'", &[])
        .into_iter()
        .filter_map(|row| DbRow { names: row.0, vals: row.1 }.as_str("name"))
        .collect();
    // 2.x 删会话只删 session_v2 一行、靠外键级联带走收件箱 / 指令 / 附件引用等附属行；Mesa 不开外键开关
    //（1.x 旧表开了可能删不动），照库里声明的外键逐表删引用这个会话的行
    let mut v2_children: Vec<(String, String)> = Vec::new();
    if tables.contains("session_v2") {
        let mut names: Vec<&String> = tables.iter().collect();
        names.sort();
        for t in names {
            if t == "session_v2" {
                continue;
            }
            for row in query_rows(
                &conn,
                "SELECT \"table\" AS parent, \"from\" AS col FROM pragma_foreign_key_list(?)",
                &[&t.as_str()],
            ) {
                let row = DbRow { names: row.0, vals: row.1 };
                if row.as_str("parent").as_deref() == Some("session_v2") {
                    if let Some(col) = row.as_str("col") {
                        v2_children.push((t.clone(), col));
                    }
                }
            }
        }
    }
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {e}"))?;
    // 升级过的库同一会话两套表各有一份：两边都删，否则删了 2.x 那份、1.x 的旧副本又冒出来
    for (table, sql) in [
        ("part", "DELETE FROM part WHERE session_id=?1"),
        ("message", "DELETE FROM message WHERE session_id=?1"),
        ("session", "DELETE FROM session WHERE id=?1"),
        ("event", "DELETE FROM event WHERE aggregate_id=?1"),
        ("event_sequence", "DELETE FROM event_sequence WHERE aggregate_id=?1"),
    ] {
        if !tables.contains(table) {
            continue;
        }
        tx.execute(sql, params![session_id])
            .map_err(|e| format!("删除 OpenCode 会话失败: {e}"))?;
    }
    // session_part 同时引用 session_message，先删它；其余子表无先后
    v2_children.sort_by_key(|(t, _)| t != "session_part");
    for (table, col) in &v2_children {
        tx.execute(
            &format!("DELETE FROM \"{table}\" WHERE \"{col}\"=?1"),
            params![session_id],
        )
        .map_err(|e| format!("删除 OpenCode 会话失败: {e}"))?;
    }
    if tables.contains("session_v2") {
        tx.execute("DELETE FROM session_v2 WHERE id=?1", params![session_id])
            .map_err(|e| format!("删除 OpenCode 会话失败: {e}"))?;
    }
    tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
    Ok(())
}

/// Codex 链成员文件：rollout-<时间>-<uuid>.jsonl[.zst]，按文件名尾部 uuid 精确匹配
/// （与 find_snapshot 取尾部 uuid 的约定一致；payload id 与文件名 uuid 不一致的极端情况不覆盖）
fn grok_member_files(member_ids: &[String]) -> Vec<PathBuf> {
    let Some(roots) = SessionRoots::current() else {
        return Vec::new();
    };
    grok_member_files_in(&[roots.grok.join("sessions")], member_ids)
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

/// Codex 对话最后一轮用的模型（按 id 找 rollout 读 turn_context）；续聊补 `-m` 用，读不到给 None
pub(crate) fn codex_thread_model(session_id: &str) -> Option<String> {
    let file = codex_member_files(&[session_id.to_string()]).into_iter().next()?;
    crate::usage::last_codex_turn_model(&file.to_string_lossy())
}

fn codex_member_files(member_ids: &[String]) -> Vec<PathBuf> {
    let Some(roots) = SessionRoots::current() else {
        return Vec::new();
    };
    codex_member_files_in(&roots.codex_dirs(), member_ids)
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
pub(crate) fn delete_session_files(
    agent: &str,
    session_id: &str,
    file_path: &str,
    chain_members: &HashMap<String, Vec<String>>,
    permanent: bool,
) -> Result<Vec<String>, String> {
    let mut extra_meta_ids = Vec::new();
    if agent == "opencode" {
        match file_path.split_once('#') {
            // v1.2+：会话是共享库里的行，文件层面没有东西可删
            Some((db, sid)) => delete_opencode_rows(Path::new(db), sid)?,
            // legacy storage 的 .json（或快照路径兜底）
            None => {
                delete_source_file_mode(file_path, permanent)?;
            }
        }
    } else {
        delete_source_file_mode(file_path, permanent)?;
        if agent == "codex" || agent == "grok" || agent == "claude-code" {
            // resume/fork 链：只删代表文件会让链换个代表重新出现，成员文件一并删除
            let members = chain_members.get(session_id).cloned().unwrap_or_default();
            let extra_files = match agent {
                "codex" => codex_member_files(&members),
                "grok" => grok_member_files(&members),
                _ => claude_member_files(file_path, session_id, &members),
            };
            for f in extra_files {
                delete_source_file_mode(&f.to_string_lossy(), permanent)?;
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

/// Claude 链成员与代表在同一项目目录下，文件名即 id
fn claude_member_files(rep_file: &str, rep_id: &str, members: &[String]) -> Vec<PathBuf> {
    let Some(dir) = Path::new(rep_file).parent() else {
        return Vec::new();
    };
    members
        .iter()
        .filter(|id| id.as_str() != rep_id && is_uuid_like(id))
        .map(|id| dir.join(format!("{id}.jsonl")))
        .filter(|p| p.exists())
        .collect()
}

fn delete_session_impl(agent: &str, session_id: &str, file_path: &str) -> Result<(), String> {
    // 链成员表只有 codex 用得到；走缓存，不额外触发全量扫描之外的 IO
    let chain_members = if agent == "codex" || agent == "grok" || agent == "claude-code" {
        cached_scan().chain_members
    } else {
        HashMap::new()
    };
    let member_ids = delete_session_files(agent, session_id, file_path, &chain_members, false)?;
    // 用户亲手删除：用量历史一起删（其余「文件消失」一律保留用量，见 usage::rebuild）
    crate::usage::forget_session_usage(agent, session_id);
    for id in &member_ids {
        crate::usage::forget_session_usage(agent, id);
    }
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
        match delete_session_files(&s.agent, &s.session_id, &s.file_path, &chain_members, false) {
            Ok(member_ids) => {
                crate::usage::forget_session_usage(&s.agent, &s.session_id);
                for id in &member_ids {
                    crate::usage::forget_session_usage(&s.agent, id);
                }
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
        let updated = opencode_latest_updated(&conn, session_id)?.max(0) as u64;
        let wal_len = std::fs::metadata(format!("{db}-wal"))
            .map(|meta| meta.len())
            .unwrap_or(0);
        return Some((updated, wal_len));
    }
    let p = if let Some(stripped) = file_path.strip_prefix("~/") {
        crate::dirs::home_dir()?.join(stripped)
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
mod tests;




#[cfg(test)]
mod wal_mode_tests;
#[cfg(test)]
mod inline_image_tests {
    #[test]
    fn counts_base64_payloads() {
        let line = r#"{"content":[{"type":"input_image","image_url":"data:image/png;base64,AAAABBBB"},{"t":"data:image/jpeg;base64,QUJD"}]}"#;
        assert_eq!(super::inline_image_bytes(line), 6 + 3);
        assert_eq!(super::inline_image_bytes("没有图"), 0);
    }
}
