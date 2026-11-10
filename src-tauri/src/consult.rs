//! 研讨（2026-11-11，docs/design-group-consult.md）：同一个问题请二到四位不同模型族的 AI 只读作答。
//! 第一轮各答各的、互相看不见；全部回来后自动交叉 N 轮（看别家第一轮再补充 / 反驳，没话说回 `[PASS]`）；
//! 之后人追问，AI 之间 `@` 接力有上限（人不说话时最多 relay_limit 次）。
//! 每次被叫到 = 一次一次性无头调用（不续 CLI 会话），记忆就是这里拼的记录。
//! Mesa 只做两件事：把每条回答的固定尾段（结论 / 依据 / 没把握的）拆出来排对照条，核对依据里的路径在不在；
//! 不判谁对、不投票、不出共识。记录在项目 `.ccode/consults/<id>.jsonl`，不进 git，出 Rust 前脱敏。
//! 本文件上半是纯逻辑（记录、解析、提示词），下半是调度（consult_runtime 段）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};

pub const DIR_REL: &str = ".ccode/consults";
pub const MIN_MEMBERS: usize = 2;
pub const MAX_MEMBERS: usize = 4;
pub const MAX_MATERIALS: usize = 8;
pub const MAX_CROSS_ROUNDS: u32 = 2;
pub const MAX_RELAY_LIMIT: u32 = 6;
pub const DEFAULT_RELAY_LIMIT: u32 = 2;
/// 单份材料摘录上限（只看材料的成员拿到的）与全部摘录合计上限，按字符算
const EXCERPT_PER_FILE: usize = 16_000;
const EXCERPT_TOTAL: usize = 48_000;
/// 拼给成员的记录合计上限：超了先把最早的长回答换成它的结论一句
const TRANSCRIPT_CAP: usize = 40_000;
const QUESTION_CAP: usize = 4_000;
const USER_TEXT_CAP: usize = 4_000;
/// 读记录的上限（单份研讨文件）
const RECORD_CAP: u64 = 8 * 1024 * 1024;

// ───────────────────────── 数据 ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    /// 研讨内的短 id：m1..m4
    pub id: String,
    /// 显示名 = 模型族名（Claude、GPT、Kimi…），同族两位时前端加短模型名区分
    pub name: String,
    /// 模型族（vendor-icon 的厂商 id），认不出为 None
    #[serde(default)]
    pub family: Option<String>,
    pub agent: String,
    pub profile_id: String,
    #[serde(default)]
    pub model: String,
    /// 能看项目：CLI 外壳支持进程级只读（Claude Code、Codex），与接的是哪个模型无关
    #[serde(default)]
    pub can_read_project: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    /// 项目内相对路径（只收相对、不含 `..`）
    pub path: String,
    /// 位置说明：「1-60」行号范围、「§2.4」章节，空 = 全文
    #[serde(default)]
    pub range: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefCheck {
    pub raw: String,
    pub path: String,
    #[serde(default)]
    pub loc: String,
    /// ok：文件在；missing：项目里找不到；unseen：在，但这位只看材料、没给它这份
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub at: String,
    /// user / member / system
    pub role: String,
    #[serde(default)]
    pub member: Option<String>,
    /// r1（第一轮）/ cross（交叉）/ chat（追问与接力）
    pub phase: String,
    /// 交叉第几轮（1 起）；其余为 0
    #[serde(default)]
    pub round: u32,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub conclusion: Option<String>,
    #[serde(default)]
    pub refs: Vec<RefCheck>,
    #[serde(default)]
    pub unsure: Option<String>,
    /// 回了 [PASS]：界面不显示，对照条写「没补充」
    #[serde(default)]
    pub pass: bool,
    /// ok / error / timeout / stopped
    #[serde(default = "ok_status")]
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    /// 这条消息 @ 到的成员 id
    #[serde(default)]
    pub mentions: Vec<String>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

fn ok_status() -> String {
    "ok".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub id: String,
    pub title: String,
    /// auto / user（人改过的标题不再自动覆盖）
    #[serde(default = "auto_source")]
    pub title_source: String,
    pub created_at: String,
    pub question: String,
    #[serde(default)]
    pub materials: Vec<Material>,
    pub members: Vec<Member>,
    pub cross_rounds: u32,
    pub relay_limit: u32,
    /// 成员读文件的地方（评审页发起时是这一步的工作副本，产物还没带回项目根）；空 = 项目根。记录永远写在项目根
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_root: Option<String>,
    /// 给人看的说明：「第 3 步 · 论文初稿的工作副本」
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_label: Option<String>,
}

/// 成员读文件的根：read_root 在就用它，否则项目根
pub(crate) fn read_root_of(meta: &Meta, root: &Path) -> PathBuf {
    meta.read_root
        .as_deref()
        .map(|r| PathBuf::from(crate::sessions::expand_tilde(r)))
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| root.to_path_buf())
}

fn auto_source() -> String {
    "auto".into()
}

/// 记录文件里的一行
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Line {
    Meta(Meta),
    Msg(Message),
    /// 标题改动（人改 / 自动起名）
    Title { title: String, source: String },
}

/// 读出来的整份研讨
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Consult {
    pub meta: Meta,
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConsultSummary {
    pub id: String,
    pub project_root: String,
    pub title: String,
    pub members: Vec<Member>,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
}

// ───────────────────────── 文件 ─────────────────────────

pub(crate) fn dir_of(root: &Path) -> PathBuf {
    root.join(DIR_REL)
}

fn file_of(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!("研讨编号不对：{id}"));
    }
    Ok(dir_of(root).join(format!("{id}.jsonl")))
}

/// 编号只许 `YYYYMMDD-HHMMSS-xxxx` 这类字母数字与连字符，防路径穿越
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub(crate) fn new_id() -> String {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let short: String = uuid::Uuid::new_v4().simple().to_string().chars().take(4).collect();
    format!("{stamp}-{short}")
}

pub(crate) fn now() -> String {
    chrono::Local::now().to_rfc3339()
}

fn append_line(root: &Path, id: &str, line: &Line) -> Result<(), String> {
    let path = file_of(root, id)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("建研讨目录失败：{e}"))?;
    }
    let mut text = serde_json::to_string(line).map_err(|e| e.to_string())?;
    text.push('\n');
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("写研讨记录失败：{e}"))?;
    f.write_all(text.as_bytes()).map_err(|e| format!("写研讨记录失败：{e}"))
}

pub(crate) fn write_meta(root: &Path, meta: &Meta) -> Result<(), String> {
    let path = file_of(root, &meta.id)?;
    if path.exists() {
        return Err("同名研讨记录已存在".into());
    }
    append_line(root, &meta.id, &Line::Meta(meta.clone()))
}

pub(crate) fn append_message(root: &Path, id: &str, msg: &Message) -> Result<(), String> {
    append_line(root, id, &Line::Msg(msg.clone()))
}

pub(crate) fn append_title(root: &Path, id: &str, title: &str, source: &str) -> Result<(), String> {
    append_line(root, id, &Line::Title { title: title.to_string(), source: source.to_string() })
}

/// 读整份记录：meta 行 + 消息按追加顺序；同 id 的消息后写的覆盖先写的（重试一家时）。
/// 坏行跳过（写到一半断电），没有 meta 行视为坏文件
pub(crate) fn read_at(root: &Path, id: &str) -> Result<Consult, String> {
    let path = file_of(root, id)?;
    let file = fs::File::open(&path).map_err(|_| "这份研讨记录已经不在了".to_string())?;
    let mut text = String::new();
    std::io::Read::read_to_string(&mut std::io::Read::take(file, RECORD_CAP), &mut text)
        .map_err(|e| format!("读研讨记录失败：{e}"))?;
    parse_record(&text).ok_or_else(|| "研讨记录损坏：缺开头一行".to_string())
}

pub(crate) fn parse_record(text: &str) -> Option<Consult> {
    let mut meta: Option<Meta> = None;
    let mut messages: Vec<Message> = Vec::new();
    for raw in text.lines() {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let Ok(line) = serde_json::from_str::<Line>(raw) else { continue };
        match line {
            Line::Meta(m) => {
                if meta.is_none() {
                    meta = Some(m);
                }
            }
            Line::Msg(m) => {
                if let Some(slot) = messages.iter_mut().find(|x| x.id == m.id) {
                    *slot = m;
                } else {
                    messages.push(m);
                }
            }
            Line::Title { title, source } => {
                if let Some(meta) = meta.as_mut() {
                    // 人改过的标题不被自动起名覆盖
                    if source == "user" || meta.title_source != "user" {
                        meta.title = title;
                        meta.title_source = source;
                    }
                }
            }
        }
    }
    Some(Consult { meta: meta?, messages })
}

pub(crate) fn summary_of(root: &Path, c: &Consult, updated_at: String) -> ConsultSummary {
    ConsultSummary {
        id: c.meta.id.clone(),
        project_root: root.to_string_lossy().into_owned(),
        title: c.meta.title.clone(),
        members: c.meta.members.clone(),
        created_at: c.meta.created_at.clone(),
        updated_at,
        message_count: c.messages.iter().filter(|m| !m.pass && m.role != "system").count(),
    }
}

/// 列一个项目里的全部研讨（新的在前）
pub(crate) fn list_at(root: &Path) -> Vec<ConsultSummary> {
    let Ok(rd) = fs::read_dir(dir_of(root)) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let Ok(c) = read_at(root, id) else { continue };
        let updated = fs::metadata(&path)
            .and_then(|m| m.modified())
            .map(|t| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339())
            .unwrap_or_else(|_| c.meta.created_at.clone());
        out.push(summary_of(root, &c, updated));
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

// ───────────────────────── 校验 ─────────────────────────

/// 项目内相对路径：去掉开头的 `./`，拒绝绝对路径、`..`、`~`、盘符
pub(crate) fn clean_rel(path: &str) -> Option<String> {
    let p = path.trim().trim_matches(|c| c == '`' || c == '"' || c == '\'').replace('\\', "/");
    let p = p.trim_start_matches("./");
    if p.is_empty() || p.starts_with('/') || p.starts_with('~') || p.contains(':') {
        return None;
    }
    let pb = Path::new(p);
    if pb.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(p.to_string())
}

pub(crate) fn validate_meta(meta: &Meta) -> Result<(), String> {
    let n = meta.members.len();
    if !(MIN_MEMBERS..=MAX_MEMBERS).contains(&n) {
        return Err(format!("研讨要请 {MIN_MEMBERS} 到 {MAX_MEMBERS} 位，现在是 {n} 位"));
    }
    let mut names: Vec<&str> = meta.members.iter().map(|m| m.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    if names.len() != n || meta.members.iter().any(|m| m.name.trim().is_empty() || m.name.contains('@')) {
        return Err("成员名字不能为空、不能重名".into());
    }
    if meta.question.trim().is_empty() {
        return Err("先写要研讨的问题".into());
    }
    if meta.materials.len() > MAX_MATERIALS {
        return Err(format!("材料最多 {MAX_MATERIALS} 份"));
    }
    if meta.cross_rounds > MAX_CROSS_ROUNDS || meta.relay_limit > MAX_RELAY_LIMIT {
        return Err("交叉轮数或接力上限超出范围".into());
    }
    Ok(())
}

// ───────────────────────── 解析回答 ─────────────────────────

/// 回答里的固定尾段
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Tail {
    pub body: String,
    pub conclusion: Option<String>,
    pub refs_raw: Option<String>,
    pub unsure: Option<String>,
}

fn strip_label<'a>(line: &'a str, labels: &[&str]) -> Option<&'a str> {
    let l = line.trim().trim_start_matches(['-', '*', '>', ' ']).trim_start_matches("**");
    for lab in labels {
        if let Some(rest) = l.strip_prefix(lab) {
            let rest = rest.trim_start_matches("**");
            let rest = rest.strip_prefix('：').or_else(|| rest.strip_prefix(':'))?;
            return Some(rest.trim_start_matches("**").trim());
        }
    }
    None
}

fn none_if_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() || matches!(t, "无" | "—" | "-" | "（无）" | "(无)" | "没有" | "空") {
        None
    } else {
        Some(t.to_string())
    }
}

/// 从回答末尾往上找「结论 / 依据 / 没把握的」三行（任意顺序、可缺）；遇到别的非空行就停。
/// 找到的行从正文里去掉，其余原样留作正文
pub(crate) fn parse_tail(text: &str) -> Tail {
    let lines: Vec<&str> = text.trim_end().lines().collect();
    let mut tail = Tail::default();
    let mut cut = lines.len();
    let mut i = lines.len();
    while i > 0 {
        let line = lines[i - 1];
        if line.trim().is_empty() || line.trim() == "---" {
            i -= 1;
            continue;
        }
        if let Some(v) = strip_label(line, &["结论"]) {
            if tail.conclusion.is_none() {
                tail.conclusion = none_if_empty(v);
            }
        } else if let Some(v) = strip_label(line, &["依据", "出处"]) {
            if tail.refs_raw.is_none() {
                tail.refs_raw = none_if_empty(v);
            }
        } else if let Some(v) = strip_label(line, &["没把握的", "没把握", "不确定的", "不确定"]) {
            if tail.unsure.is_none() {
                tail.unsure = none_if_empty(v);
            }
        } else {
            break;
        }
        i -= 1;
        cut = i;
    }
    tail.body = lines[..cut].join("\n").trim().to_string();
    tail
}

/// 把「依据」那一行拆成一条条：分隔符 `；` `;` `、` `，` ` · `；每条开头的路径 + 其余当位置
pub(crate) fn split_refs(raw: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let normalized = raw.replace(" · ", "；").replace('；', ";").replace('、', ";").replace('，', ";");
    for item in normalized.split(';') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let stripped = item.trim_matches(|c| c == '`' || c == '[' || c == ']');
        // 路径 = 开头一段不含空白、中文标点的字符；`path:12-30` 的冒号后算位置
        let end = stripped
            .char_indices()
            .find(|(_, c)| c.is_whitespace() || matches!(c, '「' | '（' | '(' | '§' | '`' | '，' | '。'))
            .map(|(i, _)| i)
            .unwrap_or(stripped.len());
        let head = &stripped[..end];
        let rest = stripped[end..].trim().trim_start_matches('`').trim();
        let (path, loc_in_head) = match head.find(':') {
            // Windows 盘符（C:）不当位置分隔；clean_rel 会拒绝
            Some(i) if i > 1 => (&head[..i], head[i + 1..].to_string()),
            _ => (head, String::new()),
        };
        let path = path.trim_matches('`');
        // 不像文件路径（没有点也没有斜杠）的整条当说明，不核对
        if !path.contains('.') && !path.contains('/') {
            continue;
        }
        let loc = [loc_in_head.as_str(), rest].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" ");
        out.push((item.to_string(), path.to_string(), loc));
    }
    out
}

/// 核对依据里的路径：在不在项目里；只看材料的成员引用了没给它的文件标 unseen
pub(crate) fn check_refs(root: &Path, raw: &str, member: &Member, materials: &[Material]) -> Vec<RefCheck> {
    split_refs(raw)
        .into_iter()
        .map(|(raw, path, loc)| {
            let state = match clean_rel(&path) {
                None => "missing",
                Some(rel) => {
                    if !root.join(&rel).exists() {
                        "missing"
                    } else if !member.can_read_project && !materials.iter().any(|m| m.path == rel) {
                        "unseen"
                    } else {
                        "ok"
                    }
                }
            };
            RefCheck { raw, path, loc, state: state.into() }
        })
        .collect()
}

pub(crate) fn is_pass(text: &str) -> bool {
    let t = text.trim().trim_matches(|c| c == '`' || c == '*' || c == '"' || c == '「' || c == '」').trim();
    t.is_empty() || t.eq_ignore_ascii_case("[pass]") || t.eq_ignore_ascii_case("pass")
}

const ALL_WORDS: &[&str] = &["所有人", "大家", "全体", "all", "everyone"];

/// 文本里 @ 到的成员（按出现顺序去重）。`@所有人` 等 = 全部成员（不含 self_id）。
/// 名字取最长匹配：「Claude·Opus」优先于「Claude」
pub(crate) fn mentions(text: &str, members: &[Member], self_id: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut sorted: Vec<&Member> = members.iter().collect();
    sorted.sort_by_key(|m| std::cmp::Reverse(m.name.chars().count()));
    for (i, _) in text.match_indices('@') {
        let rest = &text[i + 1..];
        if ALL_WORDS.iter().any(|w| rest.to_lowercase().starts_with(&w.to_lowercase())) {
            for m in members {
                if Some(m.id.as_str()) != self_id && !out.contains(&m.id) {
                    out.push(m.id.clone());
                }
            }
            continue;
        }
        if let Some(m) = sorted.iter().find(|m| rest.to_lowercase().starts_with(&m.name.to_lowercase())) {
            if Some(m.id.as_str()) != self_id && !out.contains(&m.id) {
                out.push(m.id.clone());
            }
        }
    }
    out
}

// ───────────────────────── 提示词 ─────────────────────────

fn clip(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(cap).collect();
        t.push_str("\n…（后面略）");
        t
    }
}

/// 行号范围「12-30」「第 12–30 行」→ (12, 30)；其余（§2.4 等）返回 None
fn line_range(range: &str) -> Option<(usize, usize)> {
    let digits: Vec<usize> = range
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    let looks_lines = range.contains('-') || range.contains('–') || range.contains("行");
    match digits.as_slice() {
        [a, b] if looks_lines && a <= b && *a > 0 => Some((*a, *b)),
        [a] if range.contains("行") && *a > 0 => Some((*a, *a)),
        _ => None,
    }
}

/// 只看材料的成员拿到的摘录：按行号范围截，章节范围给全文由它自己找；合计有上限
pub(crate) fn material_excerpts(root: &Path, materials: &[Material]) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for m in materials {
        let Some(rel) = clean_rel(&m.path) else { continue };
        let path = root.join(&rel);
        let text = match fs::read(&path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(_) => {
                out.push_str(&format!("\n### {rel}\n（读不到这份文件）\n"));
                continue;
            }
        };
        let body = match line_range(&m.range) {
            Some((a, b)) => text
                .lines()
                .enumerate()
                .filter(|(i, _)| *i + 1 >= a && *i < b)
                .map(|(i, l)| format!("{:>5}  {l}", i + 1))
                .collect::<Vec<_>>()
                .join("\n"),
            None => text
                .lines()
                .enumerate()
                .map(|(i, l)| format!("{:>5}  {l}", i + 1))
                .collect::<Vec<_>>()
                .join("\n"),
        };
        let room = EXCERPT_TOTAL.saturating_sub(used).min(EXCERPT_PER_FILE);
        if room < 200 {
            out.push_str(&format!("\n### {rel}\n（摘录总长到上限，这份没附上）\n"));
            continue;
        }
        let body = clip(&body, room);
        used += body.chars().count();
        let range = if m.range.trim().is_empty() { String::new() } else { format!("（{}）", m.range.trim()) };
        out.push_str(&format!("\n### {rel}{range}\n```\n{body}\n```\n"));
    }
    crate::sessions::redact_sensitive_text(&out)
}

fn member_line(m: &Member) -> String {
    let model = if m.model.trim().is_empty() { String::new() } else { format!("，模型 {}", m.model.trim()) };
    format!("{}{}", m.name, model)
}

/// 开场：身份、规矩、问题、材料。phase 决定最后一段怎么交代
pub(crate) fn opening(meta: &Meta, me: &Member, root: &Path, excerpts: Option<&str>) -> String {
    let others: Vec<String> = meta.members.iter().filter(|m| m.id != me.id).map(|m| format!("@{}", m.name)).collect();
    let mut s = String::new();
    s.push_str(&format!(
        "你是「{}」，在 Mesa 的一场研讨里。几位不同厂家的 AI 就同一个问题各自给判断，最后由提问的人决定采纳什么。其他几位：{}。\n\n",
        member_line(me),
        others.join("、")
    ));
    s.push_str("规矩：\n");
    s.push_str("1. 只看不动：只读文件，不改任何文件、不运行命令、不联网。\n");
    s.push_str("2. 只就问题和材料说话；拿不准的写进「没把握的」，不要编造文献、数字或文件内容。\n");
    s.push_str("3. 依据必须能定位：写项目内相对路径加位置（行号、页码或章节），例如 notes/extraction.md:14-38。\n");
    s.push_str("4. 用中文回答，先说判断再说理由，简洁，不用客套。\n");
    s.push_str("5. 回答最后固定三行（不要加粗、不要放进代码块）：\n结论：一句话\n依据：路径:位置；路径:位置\n没把握的：没有就写「无」\n\n");
    if me.can_read_project {
        s.push_str(&format!(
            "项目根目录：{}\n下面的材料请先自己读（用相对路径打开），需要时可以顺着依据去看项目里别的文件。\n\n",
            root.display()
        ));
    } else {
        s.push_str("你看不到项目文件，只能依据下面附上的摘录（行首数字是行号）；依据只能写摘录里的路径和位置。\n\n");
    }
    s.push_str(&format!("要研讨的问题：\n{}\n", clip(meta.question.trim(), QUESTION_CAP)));
    if !meta.materials.is_empty() {
        s.push_str("\n材料：\n");
        for m in &meta.materials {
            let range = if m.range.trim().is_empty() { "全文".to_string() } else { m.range.trim().to_string() };
            s.push_str(&format!("- {}（{range}）\n", m.path));
        }
    }
    if let Some(ex) = excerpts {
        if !ex.trim().is_empty() {
            s.push_str("\n材料摘录：\n");
            s.push_str(ex);
        }
    }
    s
}

fn speaker(meta: &Meta, msg: &Message) -> String {
    match msg.role.as_str() {
        "user" => "提问的人".into(),
        "member" => msg
            .member
            .as_deref()
            .and_then(|id| meta.members.iter().find(|m| m.id == id))
            .map(|m| m.name.clone())
            .unwrap_or_else(|| "某位成员".into()),
        _ => "Mesa".into(),
    }
}

fn render_msg(meta: &Meta, msg: &Message, short: bool) -> String {
    let phase = match msg.phase.as_str() {
        "r1" => "第一轮".to_string(),
        "cross" => format!("交叉第 {} 轮", msg.round.max(1)),
        _ => String::new(),
    };
    let head = if phase.is_empty() { speaker(meta, msg) } else { format!("{}（{phase}）", speaker(meta, msg)) };
    let body = if short {
        msg.conclusion.clone().map(|c| format!("结论：{c}")).unwrap_or_else(|| clip(&msg.text, 300))
    } else {
        let mut t = msg.text.clone();
        if let Some(c) = &msg.conclusion {
            t.push_str(&format!("\n结论：{c}"));
        }
        if !msg.refs.is_empty() {
            t.push_str(&format!("\n依据：{}", msg.refs.iter().map(|r| r.raw.as_str()).collect::<Vec<_>>().join("；")));
        }
        if let Some(u) = &msg.unsure {
            t.push_str(&format!("\n没把握的：{u}"));
        }
        t
    };
    format!("【{head}】\n{body}")
}

/// 已经亮出来的记录（第一轮回答、交叉、追问），过滤掉 PASS、出错和 Mesa 提示；
/// 合计超上限时从最早的开始改成「结论一句」，人的话永远全文
pub(crate) fn transcript(meta: &Meta, msgs: &[Message]) -> String {
    let visible: Vec<&Message> = msgs.iter().filter(|m| !m.pass && m.status == "ok" && m.role != "system").collect();
    let mut short = vec![false; visible.len()];
    let total = |short: &[bool]| -> usize {
        visible.iter().zip(short).map(|(m, s)| render_msg(meta, m, *s).chars().count() + 2).sum()
    };
    let mut i = 0;
    while total(&short) > TRANSCRIPT_CAP && i < visible.len() {
        if visible[i].role == "member" {
            short[i] = true;
        }
        i += 1;
    }
    visible.iter().zip(&short).map(|(m, s)| render_msg(meta, m, *s)).collect::<Vec<_>>().join("\n\n")
}

/// 第一轮：只有开场，看不到别人
pub(crate) fn prompt_round1(opening: &str) -> String {
    format!("{opening}\n\n这是第一轮：几位各自独立作答，你看不到别人的回答。现在请给出你的判断。")
}

/// 交叉：看别家第一轮（和此前的交叉）后补充、反驳或改判；没有就 [PASS]
pub(crate) fn prompt_cross(opening: &str, meta: &Meta, me: &Member, msgs: &[Message], round: u32) -> String {
    let record = transcript(meta, msgs);
    format!(
        "{opening}\n\n下面是到目前为止的研讨记录（含你自己第一轮的回答）：\n\n{record}\n\n\
         现在是交叉第 {round} 轮：请对照别人的回答，只写补充、反驳或改判，回应谁就在开头 @ 它的名字；\
         不要重复你已经说过的。没有要补充的，只回 [PASS]。\n\
         要是回答，最后照样写三行（结论 / 依据 / 没把握的），结论写你现在的判断。你是「{}」。",
        me.name
    )
}

/// 追问与接力：看全部记录，回最后一句；没有新东西就 [PASS]
pub(crate) fn prompt_chat(opening: &str, meta: &Meta, me: &Member, msgs: &[Message], asked_by: &str) -> String {
    let record = transcript(meta, msgs);
    let others: Vec<String> = meta.members.iter().filter(|m| m.id != me.id).map(|m| format!("@{}", m.name)).collect();
    format!(
        "{opening}\n\n研讨记录：\n\n{record}\n\n\
         轮到你了（{asked_by}叫了你，回应记录里最后那几句）。要请别人接着回答就 @ 它的名字（{}）；\
         只是提一句就别 @。跟你无关或没有新东西，只回 [PASS]。\n\
         要是回答，最后照样写三行（结论 / 依据 / 没把握的）。你是「{}」。",
        others.join(" 或 "),
        me.name
    )
}

/// 自动标题：MMDD|研究|问题前 18 个字（会话标题口径；人改过的不覆盖）
pub(crate) fn auto_title(question: &str) -> String {
    let first = question.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("研讨");
    let topic: String = first
        .chars()
        .filter(|c| !matches!(c, '|' | '\r' | '\n'))
        .take(18)
        .collect();
    format!("{}|研究|{}", chrono::Local::now().format("%m%d"), topic.trim_end_matches(['？', '?', '。', '，', ',']))
}

pub(crate) fn clip_user_text(s: &str) -> String {
    clip(s.trim(), USER_TEXT_CAP)
}

// ───────────────────────── 接力 ─────────────────────────

/// 一批回答之后下一步叫谁：回答里 @ 到的成员（去重、不含说话人自己）
#[derive(Debug, PartialEq)]
pub(crate) enum RelayStep {
    /// 没人被 @，停下等人
    Done,
    /// 接着叫这几位，asked_by 是谁叫的（名字）
    Next { targets: Vec<String>, asked_by: String },
    /// 到上限了，停下并提示
    Capped,
}

pub(crate) fn next_relay(meta: &Meta, answers: &[Message], used: u32) -> RelayStep {
    let mut targets: Vec<String> = Vec::new();
    let mut callers: Vec<String> = Vec::new();
    for a in answers.iter().filter(|a| a.status == "ok" && !a.pass && a.role == "member") {
        let mut called = false;
        for id in &a.mentions {
            if Some(id) != a.member.as_ref() && !targets.contains(id) {
                targets.push(id.clone());
                called = true;
            }
        }
        if called {
            let name = speaker(meta, a);
            if !callers.contains(&name) {
                callers.push(name);
            }
        }
    }
    if targets.is_empty() {
        RelayStep::Done
    } else if used >= meta.relay_limit {
        RelayStep::Capped
    } else {
        RelayStep::Next { targets, asked_by: callers.join("、") }
    }
}

// ───────────────────────── 调度（consult_runtime） ─────────────────────────

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Emitter;

/// 能看项目的 CLI 外壳：进程级只读已实证的两家（ai::inspect_readonly_args；与前端 consult.ts INSPECT_AGENTS 镜像）
pub(crate) const INSPECT_AGENTS: &[&str] = &["claude-code", "codex"];
pub const EVENT: &str = "consult-event";

struct Call {
    msg_id: String,
    member: String,
    phase: String,
    started_at: String,
    stop: Arc<AtomicBool>,
    run_id: Arc<Mutex<Option<String>>>,
}

#[derive(Default)]
struct Live {
    calls: Vec<Call>,
    /// 有一段调度在跑（含两批之间的空档）
    driving: bool,
    /// 人按了全部停止：当前这段调度不再往下开新的一批
    halted: bool,
    /// 人不说话时已经接力了几次
    relay_used: u32,
    /// 忙的时候人发的话：这段调度结束后接着叫这几位
    pending: Option<Vec<String>>,
}

fn live() -> &'static Mutex<HashMap<String, Live>> {
    static LIVE: OnceLock<Mutex<HashMap<String, Live>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn with_live<T>(id: &str, f: impl FnOnce(&mut Live) -> T) -> T {
    let mut map = live().lock().unwrap_or_else(|e| e.into_inner());
    f(map.entry(id.to_string()).or_default())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsultEvent {
    pub consult_id: String,
    /// started：某位开始答；step：正在做的一步；text：到此为止的回答（第一轮不推）；done：某位答完（记录已写）；idle：这段调度结束
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
}

fn emit(app: &tauri::AppHandle, ev: ConsultEvent) {
    let _ = app.emit(EVENT, ev);
}

fn event(id: &str, kind: &str) -> ConsultEvent {
    ConsultEvent {
        consult_id: id.to_string(),
        kind: kind.to_string(),
        msg_id: None,
        member: None,
        phase: None,
        text: None,
        step: None,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunningDto {
    pub msg_id: String,
    pub member: String,
    pub phase: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsultDto {
    pub consult: Consult,
    pub running: Vec<RunningDto>,
    /// 有调度在跑（含两批之间）
    pub busy: bool,
}

fn running_of(id: &str) -> (Vec<RunningDto>, bool) {
    let map = live().lock().unwrap_or_else(|e| e.into_inner());
    match map.get(id) {
        None => (Vec::new(), false),
        Some(l) => (
            l.calls
                .iter()
                .map(|c| RunningDto {
                    msg_id: c.msg_id.clone(),
                    member: c.member.clone(),
                    phase: c.phase.clone(),
                    started_at: c.started_at.clone(),
                })
                .collect(),
            l.driving,
        ),
    }
}

/// 一位成员答一次：拼提示词 → 无头只读调用 → 拆尾段、核依据 → 写记录
#[allow(clippy::too_many_arguments)]
fn call_member(
    app: &tauri::AppHandle,
    profiles: Vec<crate::profiles::Profile>,
    root: &Path,
    meta: &Meta,
    me: &Member,
    snapshot: &[Message],
    phase: &str,
    round: u32,
    asked_by: &str,
    msg_id: String,
    stop: Arc<AtomicBool>,
    run_slot: Arc<Mutex<Option<String>>>,
) -> Message {
    let started = std::time::Instant::now();
    let read_root = read_root_of(meta, root);
    let root = read_root.as_path();
    let excerpts = if me.can_read_project { None } else { Some(material_excerpts(root, &meta.materials)) };
    let open = opening(meta, me, root, excerpts.as_deref());
    let prompt = match phase {
        "r1" => prompt_round1(&open),
        "cross" => prompt_cross(&open, meta, me, snapshot, round),
        _ => prompt_chat(&open, meta, me, snapshot, asked_by),
    };
    let prompt = crate::sessions::redact_sensitive_text(&prompt);
    let mut state = crate::project_assistant::StreamState::new(root.to_string_lossy().into_owned());
    let (cid, mid, mem, ph) = (meta.id.clone(), msg_id.clone(), me.id.clone(), phase.to_string());
    let app2 = app.clone();
    let mut on_line = move |line: &str| {
        if let Some(up) = state.handle_line(line) {
            let mut ev = event(&cid, if up.step.is_some() { "step" } else { "text" });
            ev.msg_id = Some(mid.clone());
            ev.member = Some(mem.clone());
            ev.phase = Some(ph.clone());
            ev.step = up.step;
            // 第一轮各答各的：回答原文不往前端推，答完一起亮
            if ph != "r1" {
                ev.text = up.text;
            }
            if ev.step.is_some() || ev.text.is_some() {
                emit(&app2, ev);
            }
        }
    };
    let mut cost: Option<f64> = None;
    let slot = run_slot.clone();
    let hook: Box<dyn Fn(&str)> = Box::new(move |run_id: &str| {
        *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(run_id.to_string());
    });
    let model = if me.model.trim().is_empty() { None } else { Some(me.model.clone()) };
    let result = crate::ai::with_run_hook(hook, || {
        if me.can_read_project {
            let r = crate::ai::ai_inspect_readonly(
                profiles.clone(),
                Some(me.profile_id.clone()),
                model.clone(),
                root,
                &[],
                prompt.clone(),
                None,
                Some(&mut on_line),
                Some(&mut cost),
                &[],
            );
            match r {
                Err(e) if e.starts_with(crate::ai::INSPECT_UNSUPPORTED) => crate::ai::ai_prompt_impl_full(
                    profiles,
                    Some(me.profile_id.clone()),
                    model,
                    Some("consult"),
                    prompt,
                    None,
                    Some(&mut on_line),
                    Some(&mut cost),
                ),
                other => other,
            }
        } else {
            crate::ai::ai_prompt_impl_full(
                profiles,
                Some(me.profile_id.clone()),
                model,
                Some("consult"),
                prompt,
                None,
                Some(&mut on_line),
                Some(&mut cost),
            )
        }
    });
    let mut msg = Message {
        id: msg_id,
        at: now(),
        role: "member".into(),
        member: Some(me.id.clone()),
        phase: phase.to_string(),
        round,
        text: String::new(),
        conclusion: None,
        refs: Vec::new(),
        unsure: None,
        pass: false,
        status: "ok".into(),
        error: None,
        mentions: Vec::new(),
        cost_usd: cost,
        duration_ms: Some(started.elapsed().as_millis() as u64),
    };
    match result {
        Ok(raw) => {
            let raw = crate::sessions::redact_sensitive_text(raw.trim());
            if is_pass(&raw) {
                msg.pass = true;
            } else {
                let tail = parse_tail(&raw);
                msg.mentions = mentions(&tail.body, &meta.members, Some(&me.id));
                msg.refs = tail.refs_raw.as_deref().map(|r| check_refs(root, r, me, &meta.materials)).unwrap_or_default();
                msg.text = tail.body;
                msg.conclusion = tail.conclusion;
                msg.unsure = tail.unsure;
            }
        }
        Err(e) => {
            msg.status = if stop.load(Ordering::Acquire) || e.contains("已取消") {
                "stopped".into()
            } else if e.contains("超时") {
                "timeout".into()
            } else {
                "error".into()
            };
            if msg.status == "error" {
                msg.error = Some(crate::sessions::redact_sensitive_text(&clip(&e, 600)));
            }
        }
    }
    msg
}

/// 一批成员并发各答一次（看到的是同一份快照），全部回来再返回
fn run_batch(
    app: &tauri::AppHandle,
    profiles: &[crate::profiles::Profile],
    root: &Path,
    id: &str,
    phase: &str,
    round: u32,
    targets: &[String],
    asked_by: &str,
) -> Vec<Message> {
    let Ok(snapshot) = read_at(root, id) else { return Vec::new() };
    let meta = snapshot.meta.clone();
    let mut handles = Vec::new();
    for target in targets {
        let Some(me) = meta.members.iter().find(|m| &m.id == target).cloned() else { continue };
        let msg_id = format!("{}-{}", me.id, uuid::Uuid::new_v4().simple().to_string().chars().take(8).collect::<String>());
        let stop = Arc::new(AtomicBool::new(false));
        let run_slot = Arc::new(Mutex::new(None));
        let started_at = now();
        with_live(id, |l| {
            l.calls.push(Call {
                msg_id: msg_id.clone(),
                member: me.id.clone(),
                phase: phase.to_string(),
                started_at: started_at.clone(),
                stop: stop.clone(),
                run_id: run_slot.clone(),
            })
        });
        let mut ev = event(id, "started");
        ev.msg_id = Some(msg_id.clone());
        ev.member = Some(me.id.clone());
        ev.phase = Some(phase.to_string());
        emit(app, ev);
        let (app, profiles, root, meta, msgs) =
            (app.clone(), profiles.to_vec(), root.to_path_buf(), meta.clone(), snapshot.messages.clone());
        let (phase, asked_by, id) = (phase.to_string(), asked_by.to_string(), id.to_string());
        handles.push(std::thread::spawn(move || {
            let msg = call_member(&app, profiles, &root, &meta, &me, &msgs, &phase, round, &asked_by, msg_id.clone(), stop, run_slot);
            let _ = append_message(&root, &id, &msg);
            with_live(&id, |l| l.calls.retain(|c| c.msg_id != msg_id));
            let mut ev = event(&id, "done");
            ev.msg_id = Some(msg_id);
            ev.member = Some(msg.member.clone().unwrap_or_default());
            ev.phase = Some(phase);
            emit(&app, ev);
            msg
        }));
    }
    handles.into_iter().filter_map(|h| h.join().ok()).collect()
}

fn halted(id: &str) -> bool {
    with_live(id, |l| l.halted)
}

/// 人发话之后：叫 targets，之后按回答里的 @ 接力，到上限停
fn drive_chat(app: &tauri::AppHandle, profiles: &[crate::profiles::Profile], root: &Path, id: &str, first: Vec<String>) {
    let mut targets = first;
    let mut asked_by = "提问的人".to_string();
    loop {
        let answers = run_batch(app, profiles, root, id, "chat", 0, &targets, &asked_by);
        if halted(id) || with_live(id, |l| l.pending.is_some()) {
            return;
        }
        let Ok(c) = read_at(root, id) else { return };
        match next_relay(&c.meta, &answers, with_live(id, |l| l.relay_used)) {
            RelayStep::Done => return,
            RelayStep::Capped => {
                let note = Message {
                    id: format!("sys-{}", uuid::Uuid::new_v4().simple()),
                    at: now(),
                    role: "system".into(),
                    member: None,
                    phase: "chat".into(),
                    round: 0,
                    text: format!("它们已经互相叫了 {} 次，先停一下，等你发话。", c.meta.relay_limit),
                    conclusion: None,
                    refs: Vec::new(),
                    unsure: None,
                    pass: false,
                    status: "ok".into(),
                    error: None,
                    mentions: Vec::new(),
                    cost_usd: None,
                    duration_ms: None,
                };
                let _ = append_message(root, id, &note);
                return;
            }
            RelayStep::Next { targets: t, asked_by: by } => {
                with_live(id, |l| l.relay_used += 1);
                targets = t;
                asked_by = by;
            }
        }
    }
}

/// 开一段调度（新线程）：body 跑完后看有没有忙时攒下的人话，有就接着叫；最后推 idle
fn spawn_drive(
    app: tauri::AppHandle,
    profiles: Vec<crate::profiles::Profile>,
    root: PathBuf,
    id: String,
    body: impl FnOnce(&tauri::AppHandle, &[crate::profiles::Profile], &Path, &str) + Send + 'static,
) {
    with_live(&id, |l| {
        l.driving = true;
        l.halted = false;
    });
    std::thread::spawn(move || {
        body(&app, &profiles, &root, &id);
        loop {
            let pending = with_live(&id, |l| {
                if l.halted {
                    l.pending = None;
                }
                l.halted = false;
                l.pending.take()
            });
            match pending {
                Some(targets) => drive_chat(&app, &profiles, &root, &id, targets),
                None => break,
            }
        }
        with_live(&id, |l| l.driving = false);
        emit(&app, event(&id, "idle"));
    });
}

/// 第一轮 → 交叉 N 轮
fn drive_opening(app: &tauri::AppHandle, profiles: &[crate::profiles::Profile], root: &Path, id: &str) {
    let Ok(c) = read_at(root, id) else { return };
    let all: Vec<String> = c.meta.members.iter().map(|m| m.id.clone()).collect();
    let r1 = run_batch(app, profiles, root, id, "r1", 0, &all, "提问的人");
    let answered: Vec<String> =
        r1.iter().filter(|m| m.status == "ok" && !m.pass).filter_map(|m| m.member.clone()).collect();
    if answered.len() < 2 {
        return;
    }
    for round in 1..=c.meta.cross_rounds {
        if halted(id) || with_live(id, |l| l.pending.is_some()) {
            return;
        }
        run_batch(app, profiles, root, id, "cross", round, &answered, "Mesa");
    }
}

fn root_of(project_root: &str) -> PathBuf {
    PathBuf::from(crate::sessions::expand_tilde(project_root))
}

fn exclude_dir(root: &Path) {
    crate::projects::exclude_in_git(root, "/.ccode/consults/");
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberInput {
    pub name: String,
    #[serde(default)]
    pub family: Option<String>,
    pub agent: String,
    pub profile_id: String,
    #[serde(default)]
    pub model: String,
}

pub(crate) fn build_meta(
    question: &str,
    materials: Vec<Material>,
    members: Vec<MemberInput>,
    cross_rounds: u32,
    relay_limit: Option<u32>,
    read_root: Option<String>,
    read_label: Option<String>,
) -> Result<Meta, String> {
    let read_root = read_root.map(|r| r.trim().to_string()).filter(|r| !r.is_empty());
    if let Some(r) = &read_root {
        if !PathBuf::from(crate::sessions::expand_tilde(r)).is_dir() {
            return Err("要读的工作副本已经不在了".into());
        }
    }
    let mut mats: Vec<Material> = Vec::new();
    for m in materials {
        let path = clean_rel(&m.path).ok_or_else(|| format!("材料只能是项目里的文件：{}", m.path))?;
        if !mats.iter().any(|x| x.path == path && x.range == m.range) {
            mats.push(Material { path, range: m.range.trim().to_string() });
        }
    }
    let members: Vec<Member> = members
        .into_iter()
        .enumerate()
        .map(|(i, m)| Member {
            id: format!("m{}", i + 1),
            name: m.name.trim().to_string(),
            family: m.family,
            can_read_project: INSPECT_AGENTS.contains(&m.agent.as_str()),
            agent: m.agent,
            profile_id: m.profile_id,
            model: m.model,
        })
        .collect();
    let question = clip(question.trim(), QUESTION_CAP);
    let meta = Meta {
        id: new_id(),
        title: auto_title(&question),
        title_source: "auto".into(),
        created_at: now(),
        question,
        materials: mats,
        members,
        cross_rounds,
        relay_limit: relay_limit.unwrap_or(DEFAULT_RELAY_LIMIT),
        read_label: read_root.as_ref().and(read_label.map(|l| clip(l.trim(), 80))),
        read_root,
    };
    validate_meta(&meta)?;
    Ok(meta)
}

/// 发起研讨：写记录、马上开第一轮（后台），返回记录
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn consult_create(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    project_root: String,
    question: String,
    materials: Vec<Material>,
    members: Vec<MemberInput>,
    cross_rounds: u32,
    relay_limit: Option<u32>,
    read_root: Option<String>,
    read_label: Option<String>,
) -> Result<ConsultDto, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&project_root);
        if !root.is_dir() {
            return Err("项目目录不在了".to_string());
        }
        for m in &members {
            if !profiles.iter().any(|p| p.id == m.profile_id) {
                return Err(format!("{} 用的连接已经不在了，换一条再开", m.name));
            }
        }
        let meta = build_meta(&question, materials, members, cross_rounds, relay_limit, read_root, read_label)?;
        write_meta(&root, &meta)?;
        exclude_dir(&root);
        let id = meta.id.clone();
        spawn_drive(app, profiles, root.clone(), id.clone(), drive_opening);
        let consult = read_at(&root, &id)?;
        let (running, busy) = running_of(&id);
        Ok(ConsultDto { consult, running, busy: busy || true })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn consult_read(project_root: String, id: String) -> Result<ConsultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&project_root);
        let consult = read_at(&root, &id)?;
        let (running, busy) = running_of(&id);
        Ok(ConsultDto { consult, running, busy })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsultListItem {
    #[serde(flatten)]
    pub summary: ConsultSummary,
    pub busy: bool,
}

/// 列几个项目的研讨（对话页按范围传项目根）
#[tauri::command]
pub async fn consult_list(project_roots: Vec<String>) -> Result<Vec<ConsultListItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<ConsultListItem> = Vec::new();
        for r in project_roots {
            for s in list_at(&root_of(&r)) {
                let busy = running_of(&s.id).1;
                out.push(ConsultListItem { summary: s, busy });
            }
        }
        out.sort_by(|a, b| b.summary.updated_at.cmp(&a.summary.updated_at));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 人发一句：@ 到谁叫谁，不 @ 叫全部；正在答的时候先记下，这一段结束后接着叫
#[tauri::command]
pub async fn consult_send(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    project_root: String,
    id: String,
    text: String,
) -> Result<ConsultDto, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&project_root);
        let c = read_at(&root, &id)?;
        let text = clip_user_text(&crate::sessions::redact_sensitive_text(&text));
        if text.is_empty() {
            return Err("先写一句".into());
        }
        let mut targets = mentions(&text, &c.meta.members, None);
        if targets.is_empty() {
            targets = c.meta.members.iter().map(|m| m.id.clone()).collect();
        }
        let msg = Message {
            id: format!("u-{}", uuid::Uuid::new_v4().simple()),
            at: now(),
            role: "user".into(),
            member: None,
            phase: "chat".into(),
            round: 0,
            text,
            conclusion: None,
            refs: Vec::new(),
            unsure: None,
            pass: false,
            status: "ok".into(),
            error: None,
            mentions: targets.clone(),
            cost_usd: None,
            duration_ms: None,
        };
        append_message(&root, &id, &msg)?;
        let busy = with_live(&id, |l| {
            l.relay_used = 0;
            if l.driving {
                let mut merged = l.pending.take().unwrap_or_default();
                for t in &targets {
                    if !merged.contains(t) {
                        merged.push(t.clone());
                    }
                }
                l.pending = Some(merged);
            }
            l.driving
        });
        if !busy {
            spawn_drive(app, profiles, root.clone(), id.clone(), move |app, profiles, root, id| {
                drive_chat(app, profiles, root, id, targets)
            });
        }
        let consult = read_at(&root, &id)?;
        let (running, busy) = running_of(&id);
        Ok(ConsultDto { consult, running, busy })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 停：给 member 只停那一位，不给停全部（并且这段调度不再往下开新的一批）
#[tauri::command]
pub async fn consult_stop(id: String, member: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let targets: Vec<(Arc<AtomicBool>, Arc<Mutex<Option<String>>>)> = with_live(&id, |l| {
            if member.is_none() {
                l.halted = true;
                l.pending = None;
            }
            l.calls
                .iter()
                .filter(|c| member.as_deref().is_none_or(|m| c.member == m))
                .map(|c| (c.stop.clone(), c.run_id.clone()))
                .collect()
        });
        for (stop, slot) in targets {
            stop.store(true, Ordering::Release);
            // Run 登记与进程登记之间有空档：最多等 5 秒，拿到 Run id、取消成功为止
            std::thread::spawn(move || {
                for _ in 0..50 {
                    let run = slot.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    if let Some(run) = run {
                        if crate::process::cancel_capture(&run).is_ok() {
                            return;
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            });
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 重试出错 / 超时 / 被停的那一位那一次（同一条消息 id，记录里后写的覆盖先写的）
#[tauri::command]
pub async fn consult_retry(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    project_root: String,
    id: String,
    msg_id: String,
) -> Result<(), String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&project_root);
        let c = read_at(&root, &id)?;
        if with_live(&id, |l| l.driving) {
            return Err("还有成员在答，等这一段结束再重试".into());
        }
        let old = c.messages.iter().find(|m| m.id == msg_id).cloned().ok_or("找不到这一条")?;
        if old.status == "ok" || old.role != "member" {
            return Err("这一条不用重试".into());
        }
        let me = old.member.clone().and_then(|mid| c.meta.members.iter().find(|m| m.id == mid).cloned()).ok_or("找不到这位成员")?;
        // 重试看到的仍是它当时该看到的：第一轮只看开场，其余看到这条之前的记录
        let before: Vec<Message> = c.messages.iter().take_while(|m| m.id != msg_id).cloned().collect();
        spawn_drive(app, profiles, root, id, move |app, profiles, root, id| {
            let stop = Arc::new(AtomicBool::new(false));
            let slot = Arc::new(Mutex::new(None));
            with_live(id, |l| {
                l.calls.push(Call {
                    msg_id: old.id.clone(),
                    member: me.id.clone(),
                    phase: old.phase.clone(),
                    started_at: now(),
                    stop: stop.clone(),
                    run_id: slot.clone(),
                })
            });
            let mut ev = event(id, "started");
            ev.msg_id = Some(old.id.clone());
            ev.member = Some(me.id.clone());
            ev.phase = Some(old.phase.clone());
            emit(app, ev);
            let Ok(meta) = read_at(root, id).map(|c| c.meta) else { return };
            let msg = call_member(app, profiles.to_vec(), root, &meta, &me, &before, &old.phase, old.round, "提问的人", old.id.clone(), stop, slot);
            let _ = append_message(root, id, &msg);
            with_live(id, |l| l.calls.retain(|c| c.msg_id != old.id));
            let mut ev = event(id, "done");
            ev.msg_id = Some(old.id.clone());
            emit(app, ev);
        });
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn consult_rename(project_root: String, id: String, title: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let t: String = title.trim().chars().filter(|c| *c != '\n' && *c != '\r').take(80).collect();
        if t.is_empty() {
            return Err("标题不能为空".into());
        }
        append_title(&root_of(&project_root), &id, &t, "user")
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除：进回收站；正在答的先停
#[tauri::command]
pub async fn consult_delete(project_root: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if with_live(&id, |l| l.driving) {
            return Err("还有成员在答，先停下再删".into());
        }
        let path = file_of(&root_of(&project_root), &id)?;
        if path.exists() {
            crate::projects::trash_to_recycle_bin(&path).map_err(|e| format!("移到回收站失败：{e}"))?;
        }
        live().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: &str, name: &str, read: bool) -> Member {
        Member {
            id: id.into(),
            name: name.into(),
            family: None,
            agent: "claude-code".into(),
            profile_id: "p".into(),
            model: String::new(),
            can_read_project: read,
        }
    }

    fn meta(members: Vec<Member>) -> Meta {
        Meta {
            id: "20261111-120000-abcd".into(),
            title: "t".into(),
            title_source: "auto".into(),
            created_at: "2026-11-11T12:00:00+08:00".into(),
            question: "亚组按平台还是按地区？".into(),
            materials: vec![Material { path: "notes/a.md".into(), range: "1-2".into() }],
            members,
            cross_rounds: 1,
            relay_limit: 2,
            read_root: None,
            read_label: None,
        }
    }

    fn msg(id: &str, role: &str, member: Option<&str>, phase: &str, text: &str) -> Message {
        Message {
            id: id.into(),
            at: "x".into(),
            role: role.into(),
            member: member.map(String::from),
            phase: phase.into(),
            round: 0,
            text: text.into(),
            conclusion: None,
            refs: vec![],
            unsure: None,
            pass: false,
            status: "ok".into(),
            error: None,
            mentions: vec![],
            cost_usd: None,
            duration_ms: None,
        }
    }

    #[test]
    fn tail_is_split_from_body() {
        let t = parse_tail("按平台分站不住。\n\n理由……\n\n结论：平台与地区重叠\n依据：notes/a.md:14-38；analysis/b.md「亚组」\n没把握的：无\n");
        assert_eq!(t.body, "按平台分站不住。\n\n理由……");
        assert_eq!(t.conclusion.as_deref(), Some("平台与地区重叠"));
        assert_eq!(t.refs_raw.as_deref(), Some("notes/a.md:14-38；analysis/b.md「亚组」"));
        assert_eq!(t.unsure, None);
    }

    #[test]
    fn tail_tolerates_bold_and_bullets_and_missing_lines() {
        let t = parse_tail("正文\n- **结论**：保留但标探索性\n**依据：** a.md:3");
        assert_eq!(t.conclusion.as_deref(), Some("保留但标探索性"));
        assert_eq!(t.refs_raw.as_deref(), Some("a.md:3"));
        assert_eq!(t.body, "正文");
        let none = parse_tail("只有正文，没写尾段");
        assert_eq!(none.body, "只有正文，没写尾段");
        assert!(none.conclusion.is_none());
    }

    #[test]
    fn refs_split_into_path_and_location() {
        let r = split_refs("notes/extraction.md:14-38；analysis/meta-results.md「亚组」、manuscript/methods.md §2.4 · `analysis/loo.csv`");
        let paths: Vec<&str> = r.iter().map(|x| x.1.as_str()).collect();
        assert_eq!(paths, ["notes/extraction.md", "analysis/meta-results.md", "manuscript/methods.md", "analysis/loo.csv"]);
        assert_eq!(r[0].2, "14-38");
        assert_eq!(r[1].2, "「亚组」");
        assert_eq!(r[2].2, "§2.4");
        // 纯说明不当路径
        assert!(split_refs("我的经验").is_empty());
    }

    #[test]
    fn refs_are_checked_against_project() {
        let dir = std::env::temp_dir().join(format!("consult-refs-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::write(dir.join("notes/a.md"), "x").unwrap();
        fs::write(dir.join("notes/b.md"), "y").unwrap();
        let mats = vec![Material { path: "notes/a.md".into(), range: String::new() }];
        let reader = member("m1", "Claude", true);
        let blind = member("m2", "Gemini", false);
        let raw = "notes/a.md:1；notes/b.md:2；notes/zz.md；../etc/passwd";
        let a: Vec<String> = check_refs(&dir, raw, &reader, &mats).into_iter().map(|r| r.state).collect();
        assert_eq!(a, ["ok", "ok", "missing", "missing"]);
        let b: Vec<String> = check_refs(&dir, raw, &blind, &mats).into_iter().map(|r| r.state).collect();
        assert_eq!(b, ["ok", "unseen", "missing", "missing"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clean_rel_rejects_escapes() {
        assert_eq!(clean_rel("./a/b.md").as_deref(), Some("a/b.md"));
        assert_eq!(clean_rel("a\\b.md").as_deref(), Some("a/b.md"));
        for bad in ["/etc/x", "../x", "a/../../x", "~/x", "C:/x", ""] {
            assert!(clean_rel(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn pass_detection() {
        assert!(is_pass("[PASS]"));
        assert!(is_pass("  `[pass]` "));
        assert!(is_pass(""));
        assert!(!is_pass("[PASS] 但我补一句"));
    }

    #[test]
    fn mentions_pick_longest_name_and_skip_self() {
        let ms = vec![member("m1", "Claude", true), member("m2", "Claude·Sonnet", true), member("m3", "GPT", true)];
        assert_eq!(mentions("@Claude·Sonnet 你看看", &ms, None), ["m2"]);
        assert_eq!(mentions("@gpt 和 @Claude 呢", &ms, None), ["m3", "m1"]);
        assert_eq!(mentions("@所有人", &ms, Some("m1")), ["m2", "m3"]);
        assert!(mentions("邮箱 a@b.com", &ms, None).is_empty());
        assert!(mentions("@GPT", &ms, Some("m3")).is_empty());
    }

    #[test]
    fn round1_prompt_never_contains_other_answers() {
        let m = meta(vec![member("m1", "Claude", true), member("m2", "GPT", false)]);
        let root = Path::new("/tmp/p");
        let open = opening(&m, &m.members[0], root, None);
        let p = prompt_round1(&open);
        assert!(p.contains("你看不到别人的回答"));
        assert!(p.contains("项目根目录"));
        assert!(!p.contains("研讨记录"));
        let blind = opening(&m, &m.members[1], root, Some("摘录"));
        assert!(blind.contains("你看不到项目文件"));
        assert!(blind.contains("材料摘录"));
    }

    #[test]
    fn transcript_drops_pass_and_shrinks_oldest() {
        let m = meta(vec![member("m1", "Claude", true), member("m2", "GPT", true)]);
        let mut a = msg("1", "member", Some("m1"), "r1", &"长".repeat(TRANSCRIPT_CAP));
        a.conclusion = Some("平台站不住".into());
        let mut p = msg("2", "member", Some("m2"), "cross", "[PASS]");
        p.pass = true;
        let u = msg("3", "user", None, "chat", "@GPT 41% 哪来的？");
        let t = transcript(&m, &[a, p, u]);
        assert!(t.contains("结论：平台站不住"));
        assert!(!t.contains("[PASS]"));
        assert!(t.contains("【提问的人】\n@GPT 41% 哪来的？"));
        assert!(t.chars().count() < TRANSCRIPT_CAP);
    }

    #[test]
    fn record_roundtrip_and_title_rules() {
        let dir = std::env::temp_dir().join(format!("consult-rec-{}", uuid::Uuid::new_v4().simple()));
        let m = meta(vec![member("m1", "Claude", true), member("m2", "GPT", true)]);
        write_meta(&dir, &m).unwrap();
        assert!(write_meta(&dir, &m).is_err());
        append_message(&dir, &m.id, &msg("a", "member", Some("m1"), "r1", "v1")).unwrap();
        append_message(&dir, &m.id, &msg("a", "member", Some("m1"), "r1", "v2")).unwrap();
        append_title(&dir, &m.id, "人改的", "user").unwrap();
        append_title(&dir, &m.id, "自动的", "auto").unwrap();
        let c = read_at(&dir, &m.id).unwrap();
        assert_eq!(c.messages.len(), 1);
        assert_eq!(c.messages[0].text, "v2");
        assert_eq!(c.meta.title, "人改的");
        assert_eq!(list_at(&dir).len(), 1);
        assert!(read_at(&dir, "../x").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn excerpts_follow_line_ranges() {
        let dir = std::env::temp_dir().join(format!("consult-ex-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::write(dir.join("notes/a.md"), "一\n二\n三\n四\n").unwrap();
        let ex = material_excerpts(&dir, &[Material { path: "notes/a.md".into(), range: "第 2–3 行".into() }]);
        assert!(ex.contains("    2  二") && ex.contains("    3  三"));
        assert!(!ex.contains("一") && !ex.contains("四"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_limits() {
        let mut m = meta(vec![member("m1", "Claude", true)]);
        assert!(validate_meta(&m).is_err());
        m.members.push(member("m2", "Claude", true));
        assert!(validate_meta(&m).is_err(), "重名");
        m.members[1].name = "GPT".into();
        assert!(validate_meta(&m).is_ok());
        m.relay_limit = 9;
        assert!(validate_meta(&m).is_err());
    }
    #[test]
    fn relay_follows_mentions_until_cap() {
        let m = meta(vec![member("m1", "Claude", true), member("m2", "GPT", true), member("m3", "Kimi", true)]);
        let mut a = msg("a", "member", Some("m1"), "chat", "@GPT 你再看看");
        a.mentions = vec!["m2".into()];
        let mut b = msg("b", "member", Some("m3"), "chat", "@GPT @Claude");
        b.mentions = vec!["m2".into(), "m1".into()];
        let mut pass = msg("c", "member", Some("m2"), "chat", "");
        pass.pass = true;
        pass.mentions = vec!["m3".into()];
        assert_eq!(
            next_relay(&m, &[a.clone(), b.clone(), pass], 0),
            RelayStep::Next { targets: vec!["m2".into(), "m1".into()], asked_by: "Claude、Kimi".into() }
        );
        assert_eq!(next_relay(&m, &[a.clone()], 2), RelayStep::Capped);
        let plain = msg("d", "member", Some("m1"), "chat", "没 @ 人");
        assert_eq!(next_relay(&m, &[plain], 0), RelayStep::Done);
    }

    #[test]
    fn build_meta_assigns_ids_and_read_tiers() {
        let input = |name: &str, agent: &str| MemberInput {
            name: name.into(),
            family: None,
            agent: agent.into(),
            profile_id: "p".into(),
            model: String::new(),
        };
        let m = build_meta(
            "问题",
            vec![Material { path: "./notes/a.md".into(), range: " 1-2 ".into() }],
            vec![input("Claude", "claude-code"), input("GPT", "codex"), input("Gemini", "gemini")],
            1,
            None,
            None,
            None,
        )
        .unwrap();
        let ids: Vec<&str> = m.members.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["m1", "m2", "m3"]);
        let reads: Vec<bool> = m.members.iter().map(|x| x.can_read_project).collect();
        assert_eq!(reads, [true, true, false]);
        assert_eq!(m.materials[0].path, "notes/a.md");
        assert_eq!(m.materials[0].range, "1-2");
        assert_eq!(m.relay_limit, DEFAULT_RELAY_LIMIT);
        assert!(m.title.contains("|研究|问题"));
        assert!(build_meta("问题", vec![Material { path: "/etc/x".into(), range: String::new() }], vec![input("A", "codex"), input("B", "codex")], 1, None, None, None).is_err());
    }

    #[test]
    fn read_root_falls_back_to_project_root() {
        let mut m = meta(vec![member("m1", "Claude", true), member("m2", "GPT", true)]);
        let root = Path::new("/nonexistent/project");
        assert_eq!(read_root_of(&m, root), root);
        let wt = std::env::temp_dir();
        m.read_root = Some(wt.to_string_lossy().into_owned());
        assert_eq!(read_root_of(&m, root), wt);
        m.read_root = Some("/nonexistent/worktree".into());
        assert_eq!(read_root_of(&m, root), root, "工作副本没了就退回项目根");
    }

}
