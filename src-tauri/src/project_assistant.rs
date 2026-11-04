//! 项目助手（2026-11-04 用户拍板，docs/design-project-assistant.md）：项目里有不明白、出了错，问它。
//!
//! 这里只管三样落盘与一次调用，项目快照由前端用已有命令拼（project-snapshot.ts）：
//! - **Mesa 出错记录**：前端统一接住失败的后台调用（mesa-error-capture.ts），按参数里的路径归到项目，
//!   写进配置目录 `project-assistant/<项目键>/mesa-errors.jsonl`。不写进项目 `.ccode/`——那里每多一个文件
//!   都要同步忽略规则、合并判定与保存排除表；换来的代价是记录不跟着项目换机器。
//! - **问答记录**：同目录 `assistant.jsonl`，面板显示、可清空。
//! - **问一次**：出站前整段脱敏（快照里有路径、报错原文），按专属绑定的连接 / 模型无头调用一次，回答同样脱敏后落记录。
//!
//! 只读、只解释：这里没有任何改项目文件、派活、传话的口子。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const DIR: &str = "project-assistant";
const ERRORS_FILE: &str = "mesa-errors.jsonl";
const LOG_FILE: &str = "assistant.jsonl";
/// 出错记录只留 30 天、最多 500 条；同一处错 10 分钟内再犯只加次数
const ERRORS_KEEP_DAYS: i64 = 30;
const ERRORS_CAP: usize = 500;
const DEDUPE_MINUTES: i64 = 10;
/// 问答记录最多留 200 轮（面板全显示，喂给 AI 的只取最近几轮，由前端定）
const LOG_CAP: usize = 200;
const FIELD_CAP: usize = 4000;
const ANSWER_CAP: usize = 12000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MesaErrorDto {
    /// 最后一次发生的时间（RFC3339）
    pub at: String,
    /// 第一次发生的时间
    #[serde(default)]
    pub first_at: String,
    /// 10 分钟内同一处错的次数
    #[serde(default = "one")]
    pub count: u32,
    /// invoke（后台调用失败）| toast（只有界面提示）| crash（前端未处理的报错）
    pub source: String,
    /// 后台命令名；只有界面提示时为空
    #[serde(default)]
    pub command: String,
    pub message: String,
    /// 紧跟着弹出的红色提示原文（用户真正看到的那句）
    #[serde(default)]
    pub notice: Option<String>,
    #[serde(default)]
    pub version: String,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssistantTurnDto {
    pub at: String,
    pub question: String,
    pub answer: String,
    /// 用的哪个连接（给人看的一行，如「Codex · 公司中转 · gpt-5」）
    #[serde(default)]
    pub connection: String,
    /// 这一问依据了什么（「说明书 · 8.1 聊天 / 终端」「这个项目的记录」），回答下面一行小字
    #[serde(default)]
    pub basis: String,
}

fn truncate(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        return text.to_string();
    }
    let mut out: String = text.chars().take(cap).collect();
    out.push_str("…（已截断）");
    out
}

fn project_dir(project_root: &str) -> Result<PathBuf, String> {
    let root = crate::sessions::expand_tilde(project_root.trim());
    if root.is_empty() {
        return Err("缺少项目路径".into());
    }
    let key = crate::paths::path_key(&root);
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Ok(crate::storage::config_root()
        .ok_or("无法确定配置目录")?
        .join(DIR)
        .join(hex))
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Vec<T> {
    fs::read_to_string(path)
        .map(|text| {
            text.lines()
                .filter(|l| !l.trim().is_empty())
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn write_jsonl<T: Serialize>(path: &Path, rows: &[T]) -> Result<(), String> {
    let mut out = String::new();
    for row in rows {
        out.push_str(&serde_json::to_string(row).map_err(|e| e.to_string())?);
        out.push('\n');
    }
    crate::storage::atomic_write(path, out.as_bytes(), true)
}

fn with_lock<R>(dir: &Path, f: impl FnOnce() -> Result<R, String>) -> Result<R, String> {
    fs::create_dir_all(dir).map_err(|e| format!("建记录目录失败：{e}"))?;
    let _lock = crate::storage::lock_at(&dir.join("records.lock"))?;
    f()
}

fn parse_at(at: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(at).ok()
}

/// 合并进已有记录：同一处错（来源 + 命令 + 消息）10 分钟内再犯只加次数、更新时间；
/// 30 天前的丢掉，超过上限丢最旧的
pub(crate) fn merge_error(
    mut rows: Vec<MesaErrorDto>,
    entry: MesaErrorDto,
    now: chrono::DateTime<chrono::FixedOffset>,
) -> Vec<MesaErrorDto> {
    rows.retain(|r| {
        parse_at(&r.at).is_some_and(|t| (now - t).num_days() < ERRORS_KEEP_DAYS)
    });
    let same = rows.iter_mut().rev().find(|r| {
        r.source == entry.source
            && r.command == entry.command
            && r.message == entry.message
            && parse_at(&r.at).is_some_and(|t| (now - t).num_minutes() < DEDUPE_MINUTES)
    });
    match same {
        Some(row) => {
            row.count = row.count.saturating_add(1);
            row.at = entry.at;
            if entry.notice.is_some() {
                row.notice = entry.notice;
            }
        }
        None => rows.push(entry),
    }
    if rows.len() > ERRORS_CAP {
        let drop = rows.len() - ERRORS_CAP;
        rows.drain(..drop);
    }
    rows
}

/// 界面提示跟上来时补到最近一条还没配提示的同项目记录上（只看 5 秒内的）
pub(crate) fn attach_notice(
    rows: &mut [MesaErrorDto],
    notice: &str,
    now: chrono::DateTime<chrono::FixedOffset>,
) -> bool {
    let Some(row) = rows.iter_mut().rev().find(|r| {
        r.notice.is_none() && parse_at(&r.at).is_some_and(|t| (now - t).num_seconds().abs() <= 5)
    }) else {
        return false;
    };
    row.notice = Some(notice.to_string());
    true
}

/// 例行的「没找到」（界面探文件在不在，没有就算了）：没配上红色提示的不记、读出时也滤掉（前端 mesa-errors.ts isRoutineFailure 同口径）。
/// 2026-11-04 本机实证：一天记下的全是 read_file_preview / read_research_ledger / list_dir 的这一类，一条提示都没有
pub(crate) fn is_routine_failure(message: &str) -> bool {
    const ROUTINE: &[&str] = &[
        "(os error 2)",
        "(os error 20)",
        "No such file or directory",
        "Not a directory",
        "文件不存在或不可读",
        "路径不可读",
    ];
    let lower = message.to_lowercase();
    ROUTINE.iter().any(|p| lower.contains(&p.to_lowercase()))
}

fn now_fixed() -> chrono::DateTime<chrono::FixedOffset> {
    chrono::Local::now().fixed_offset()
}

fn record_error_sync(
    project_root: &str,
    source: &str,
    command: &str,
    message: &str,
    notice: Option<&str>,
) -> Result<(), String> {
    let source = match source {
        "invoke" | "toast" | "crash" => source,
        _ => return Err(format!("不认识的出错来源：{source}")),
    };
    let message = truncate(&crate::sessions::redact_sensitive_text(message.trim()), FIELD_CAP);
    let notice = notice
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| truncate(&crate::sessions::redact_sensitive_text(n), FIELD_CAP));
    if message.is_empty() && notice.is_none() {
        return Ok(());
    }
    if source == "invoke" && notice.is_none() && is_routine_failure(&message) {
        return Ok(());
    }
    let dir = project_dir(project_root)?;
    let path = dir.join(ERRORS_FILE);
    with_lock(&dir, || {
        let now = now_fixed();
        let mut rows: Vec<MesaErrorDto> = read_jsonl(&path);
        // 只有一句界面提示：先试着补到刚记下的那条后台失败上，补不上才单记一条
        if source == "toast" {
            if let Some(n) = notice.as_deref() {
                if attach_notice(&mut rows, n, now) {
                    return write_jsonl(&path, &rows);
                }
            }
        }
        let at = now.to_rfc3339();
        let entry = MesaErrorDto {
            at: at.clone(),
            first_at: at,
            count: 1,
            source: source.to_string(),
            command: command.trim().chars().take(120).collect(),
            message: if message.is_empty() { notice.clone().unwrap_or_default() } else { message },
            notice,
            version: env!("CARGO_PKG_VERSION").to_string(),
        };
        let rows = merge_error(rows, entry, now);
        write_jsonl(&path, &rows)
    })
}

#[tauri::command]
pub async fn mesa_error_record(
    project_root: String,
    source: String,
    command: Option<String>,
    message: String,
    notice: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        record_error_sync(
            &project_root,
            &source,
            command.as_deref().unwrap_or(""),
            &message,
            notice.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 最近的在后（与文件同序）
#[tauri::command]
pub async fn mesa_errors_read(project_root: String, limit: Option<usize>) -> Result<Vec<MesaErrorDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = project_dir(&project_root)?.join(ERRORS_FILE);
        let rows: Vec<MesaErrorDto> = read_jsonl::<MesaErrorDto>(&path)
            .into_iter()
            .filter(|r| r.notice.is_some() || !is_routine_failure(&r.message))
            .collect();
        let limit = limit.unwrap_or(ERRORS_CAP).min(ERRORS_CAP);
        Ok(rows[rows.len().saturating_sub(limit)..].to_vec())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn assistant_log_read(project_root: String) -> Result<Vec<AssistantTurnDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(read_jsonl(&project_dir(&project_root)?.join(LOG_FILE)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn assistant_log_clear(project_root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = project_dir(&project_root)?;
        let path = dir.join(LOG_FILE);
        with_lock(&dir, || match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("清空失败：{e}")),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn append_turn(project_root: &str, turn: AssistantTurnDto) -> Result<(), String> {
    let dir = project_dir(project_root)?;
    let path = dir.join(LOG_FILE);
    with_lock(&dir, || {
        let mut rows: Vec<AssistantTurnDto> = read_jsonl(&path);
        rows.push(turn);
        if rows.len() > LOG_CAP {
            let drop = rows.len() - LOG_CAP;
            rows.drain(..drop);
        }
        write_jsonl(&path, &rows)
    })
}

/// 问一次：prompt 是前端拼好的（规矩 + 项目快照 + 最近几轮 + 这次的问题），这里整段脱敏后出站。
/// profile_id 为空 = 设置里「AI 功能」的连接（fn_key = project-assistant）；model 为空 = 连接里的第一个
#[tauri::command]
pub async fn project_assistant_ask(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    project_root: String,
    profile_id: Option<String>,
    model: Option<String>,
    connection: Option<String>,
    basis: Option<String>,
    question: String,
    prompt: String,
    inspect: Option<bool>,
    extra_dirs: Option<Vec<String>>,
) -> Result<AssistantTurnDto, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let question = question.trim().to_string();
        if question.is_empty() {
            return Err("先写要问什么".into());
        }
        let prompt = crate::sessions::redact_sensitive_text(&prompt);
        let model = model.filter(|m| !m.trim().is_empty());
        // 只读查看项目文件（问出错时）：在项目根跑、只读、不落盘；这家不支持时报 INSPECT_UNSUPPORTED，前端退回只看记录
        let raw = if inspect.unwrap_or(false) {
            let root = PathBuf::from(crate::sessions::expand_tilde(&project_root));
            crate::ai::ai_inspect_readonly(profiles, profile_id, model, &root, &extra_dirs.unwrap_or_default(), prompt)?
        } else {
            crate::ai::ai_prompt_impl_model(profiles, profile_id, model, Some("project-assistant"), prompt)?
        };
        let answer = truncate(crate::sessions::redact_sensitive_text(raw.trim()).as_str(), ANSWER_CAP);
        if answer.is_empty() {
            return Err("AI 没有回答，换个说法再问一次".into());
        }
        let turn = AssistantTurnDto {
            at: now_fixed().to_rfc3339(),
            question: truncate(&crate::sessions::redact_sensitive_text(&question), FIELD_CAP),
            answer,
            connection: connection.unwrap_or_default().chars().take(200).collect(),
            basis: basis.unwrap_or_default().chars().take(300).collect(),
        };
        // 记不下不挡回答：这次照样给人看
        let _ = append_turn(&project_root, turn.clone());
        Ok(turn)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 评审退回意见（工作副本里的 `.ccode/review-notes.md`）：快照用，只读、有上限、脱敏
#[tauri::command]
pub async fn assistant_review_notes(worktree_path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(crate::sessions::expand_tilde(&worktree_path)).join(".ccode/review-notes.md");
        let file = fs::File::open(path).ok()?;
        let mut text = String::new();
        std::io::Read::read_to_string(&mut std::io::Read::take(file, 16 * 1024), &mut text).ok()?;
        let text = text.trim();
        (!text.is_empty()).then(|| crate::sessions::redact_sensitive_text(text))
    })
    .await
    .ok()
    .flatten()
}

// ===== 说明书检索（2026-11-04 用户：「问怎么换模型也要看项目记录吗」）=====
// 「怎么用 Mesa」一类问题不拼项目快照，改翻说明书：说明书随应用打包（编译期读进来），按问题挑最相关的几段。
// 切分口径：按标题记下所在小节，按空行切段（列表紧跟在引导句后面不空行，会和引导句在同一段）；
// 打分用汉字两两相邻的字组与英文词，罕见的词分量重（idf），标题里出现的加倍。

const USER_GUIDE: &str = include_str!("../../docs/guide/user-guide.md");
const GUIDE_HIT_CAP: usize = 1800;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GuideHitDto {
    /// 所在小节标题（如「8.1 聊天 / 终端」）
    pub heading: String,
    pub text: String,
}

struct GuidePara {
    heading: String,
    /// 在本小节里是第几段（0 起）
    pos: usize,
    text: String,
    grams: std::collections::HashSet<String>,
    heading_grams: std::collections::HashSet<String>,
}

/// 字组：连续汉字两两相邻取一组；英文 / 数字按词（两个字符以上），一律小写
pub(crate) fn guide_grams(text: &str) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let mut han: Vec<char> = Vec::new();
    let mut word = String::new();
    let flush_han = |han: &mut Vec<char>, out: &mut std::collections::HashSet<String>| {
        for pair in han.windows(2) {
            out.insert(pair.iter().collect());
        }
        han.clear();
    };
    for ch in text.chars() {
        let is_han = ('\u{4e00}'..='\u{9fff}').contains(&ch);
        if is_han {
            if word.chars().count() >= 2 {
                out.insert(std::mem::take(&mut word));
            }
            word.clear();
            han.push(ch);
        } else {
            flush_han(&mut han, &mut out);
            if ch.is_ascii_alphanumeric() {
                word.push(ch.to_ascii_lowercase());
            } else {
                if word.chars().count() >= 2 {
                    out.insert(std::mem::take(&mut word));
                }
                word.clear();
            }
        }
    }
    flush_han(&mut han, &mut out);
    if word.chars().count() >= 2 {
        out.insert(word);
    }
    out
}

/// 问句里不带意思的词（问法、语气、人称），去掉再取字组，免得「怎么」「如何」把所有段都匹配上
const QUESTION_FILLERS: &[&str] = &[
    "怎么样", "怎么办", "怎么", "如何", "怎样", "在哪里", "在哪儿", "在哪", "哪里", "哪儿", "能不能", "可不可以", "可以", "是不是",
    "什么", "一下", "我想", "我要", "请问", "为什么", "这个", "那个", "应该", "需要", "吗", "呢", "吧", "啊", "的", "了", "我", "你",
];

fn guide_paras() -> &'static Vec<GuidePara> {
    static PARAS: std::sync::OnceLock<Vec<GuidePara>> = std::sync::OnceLock::new();
    PARAS.get_or_init(|| {
        let mut out = Vec::new();
        let mut heading = String::new();
        let mut buf: Vec<&str> = Vec::new();
        let mut in_comment = false;
        let push = |heading: &str, buf: &mut Vec<&str>, out: &mut Vec<GuidePara>| {
            let text = buf.join("\n").trim().to_string();
            buf.clear();
            // 目录那一节只是链接清单，不进检索
            if text.chars().count() < 12 || heading.is_empty() || heading == "目录" {
                return;
            }
            let pos = out.iter().rev().take_while(|p: &&GuidePara| p.heading == heading).count();
            out.push(GuidePara {
                heading: heading.to_string(),
                pos,
                grams: guide_grams(&text),
                heading_grams: guide_grams(heading),
                text,
            });
        };
        for line in USER_GUIDE.lines() {
            let t = line.trim();
            if in_comment {
                if t.contains("-->") {
                    in_comment = false;
                }
                continue;
            }
            if t.starts_with("<!--") {
                in_comment = !t.contains("-->");
                continue;
            }
            if t.starts_with('#') {
                push(&heading, &mut buf, &mut out);
                heading = t.trim_start_matches('#').trim().to_string();
                continue;
            }
            // 后补素材位不进检索
            if t.starts_with("【配图】") || t.starts_with("【配视频】") || t.starts_with("> 【配") {
                continue;
            }
            if t.is_empty() {
                push(&heading, &mut buf, &mut out);
            } else {
                buf.push(line);
            }
        }
        push(&heading, &mut buf, &mut out);
        out
    })
}

/// 常问的几类「怎么用」直接指到说明书对应处（光靠字面匹配，「换模型」会先翻到「雷达解读换模型」这种偏门段落）：
/// 问句里有左边任一词，就给右边这些小节（标题包含）或段落（以它开头）加重分
const GUIDE_TOPICS: &[(&[&str], &[&str])] = &[
    (&["模型", "思考档", "思考强度"], &["**换 Agent、模型和思考强度**", "9.7 思考档位"]),
    (&["连接", "中转", "密钥", "apikey", "网关"], &["9.2 加一条连接"]),
    (&["官方", "订阅", "登录"], &["9.3 官方订阅"]),
    (&["默认agent", "分工", "绑定", "专属"], &["**Agent 分工页签**"]),
    (&["全局"], &["9.6 两种「生效」别混"]),
    (&["技能", "skill"], &["10 技能页"]),
    (&["mcp"], &["11 MCP 页"]),
    (&["主题", "深色", "浅色", "外观", "字号", "字体"], &["13.1 外观"]),
    (&["快捷键"], &["13.4 快捷键"]),
    (&["更新", "升级", "新版"], &["检查更新"]),
    (&["反馈", "提需求", "bug"], &["反馈与提需求"]),
    (&["定时", "雷达"], &["5.2 新建定时任务", "5.1 文献雷达"]),
    (&["评审", "保存进项目", "采纳"], &["4.9 评审页"]),
    (&["用量", "花费", "余额", "费用"], &["12 用量页"]),
    (&["手机"], &["8.4.2 从手机添加"]),
    (&["添加项目", "新建项目", "加项目"], &["3.2 添加项目"]),
    (&["出图", "画图", "生成图片"], &["9.8 出图模型"]),
    (&["项目助手", "小桌"], &["**项目助手：看不懂、出错了，问它**"]),
];

fn topic_boost(question: &str, para: &GuidePara) -> f64 {
    let q: String = question.to_lowercase().chars().filter(|c| !c.is_whitespace()).collect();
    let mut boost = 0.0;
    for (words, anchors) in GUIDE_TOPICS {
        if !words.iter().any(|w| q.contains(w)) {
            continue;
        }
        for anchor in *anchors {
            if para.text.starts_with(anchor) {
                boost += 60.0;
            } else if para.heading.contains(anchor) {
                boost += (40.0 - para.pos as f64 * 6.0).max(8.0);
            }
        }
    }
    boost
}

pub(crate) fn guide_search(question: &str, limit: usize) -> Vec<GuideHitDto> {
    let mut q = question.to_string();
    for filler in QUESTION_FILLERS {
        q = q.replace(filler, " ");
    }
    let grams = guide_grams(&q);
    if grams.is_empty() && !GUIDE_TOPICS.iter().any(|(words, _)| words.iter().any(|w| question.to_lowercase().contains(w))) {
        return Vec::new();
    }
    let paras = guide_paras();
    let n = paras.len() as f64;
    let weights: Vec<(&String, f64)> = grams
        .iter()
        .map(|g| {
            let df = paras.iter().filter(|p| p.grams.contains(g) || p.heading_grams.contains(g)).count() as f64;
            (g, ((n + 1.0) / (df + 1.0)).ln())
        })
        .filter(|(_, w)| *w > 0.0)
        .collect();
    let mut scored: Vec<(usize, f64)> = paras
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let score: f64 = weights
                .iter()
                .map(|(g, w)| {
                    let mut s = 0.0;
                    if p.grams.contains(*g) {
                        s += 1.0;
                    }
                    if p.heading_grams.contains(*g) {
                        s += 2.0;
                    }
                    s * w
                })
                .sum::<f64>()
                + topic_boost(question, p);
            (i, score)
        })
        .filter(|(_, s)| *s > 0.0)
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut used = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (i, _) in scored {
        if out.len() >= limit {
            break;
        }
        if used.contains(&i) {
            continue;
        }
        // 带上同一小节里紧跟的两段（引导句后面常是分条说明）
        let mut text = String::new();
        for j in i..(i + 3).min(paras.len()) {
            if paras[j].heading != paras[i].heading || used.contains(&j) {
                break;
            }
            used.insert(j);
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(&paras[j].text);
            if text.chars().count() >= GUIDE_HIT_CAP {
                break;
            }
        }
        out.push(GuideHitDto { heading: paras[i].heading.clone(), text: truncate(&text, GUIDE_HIT_CAP) });
    }
    out
}

#[tauri::command]
pub async fn assistant_guide_search(question: String, limit: Option<usize>) -> Vec<GuideHitDto> {
    let limit = limit.unwrap_or(4).clamp(1, 8);
    tauri::async_runtime::spawn_blocking(move || guide_search(&question, limit))
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(minutes_ago: i64) -> String {
        (now_fixed() - chrono::Duration::minutes(minutes_ago)).to_rfc3339()
    }

    fn row(command: &str, message: &str, minutes_ago: i64) -> MesaErrorDto {
        MesaErrorDto {
            at: at(minutes_ago),
            first_at: at(minutes_ago),
            count: 1,
            source: "invoke".into(),
            command: command.into(),
            message: message.into(),
            notice: None,
            version: "0".into(),
        }
    }

    #[test]
    fn guide_search_finds_the_model_switch_section() {
        let hits = guide_search("如何跟换模型", 4);
        assert!(!hits.is_empty());
        assert!(
            hits.iter().any(|h| h.text.contains("模型 · 思考")),
            "换模型应翻到「模型 · 思考档」那一段：{:?}",
            hits.iter().map(|h| &h.heading).collect::<Vec<_>>()
        );
        assert!(guide_search("怎么 如何 吗", 4).is_empty(), "只有问法没有内容时不乱翻");
        assert!(hits.iter().all(|h| h.text.chars().count() <= GUIDE_HIT_CAP + 10));
    }

    #[test]
    fn every_guide_topic_anchor_still_exists() {
        // 说明书改了标题 / 引导句，这里会红：同步改 GUIDE_TOPICS，免得「怎么换模型」又翻到偏门段落
        let paras = guide_paras();
        for (_, anchors) in GUIDE_TOPICS {
            for anchor in *anchors {
                assert!(
                    paras.iter().any(|p| p.text.starts_with(anchor) || p.heading.contains(anchor)),
                    "说明书里找不到 GUIDE_TOPICS 的锚点：{anchor}"
                );
            }
        }
    }

    #[test]
    fn guide_grams_pairs_han_and_keeps_words() {
        let g = guide_grams("换 Claude 模型");
        assert!(g.contains("claude"));
        assert!(g.contains("模型"));
        assert!(!g.contains("换"));
    }

    #[test]
    fn same_error_within_ten_minutes_only_counts_up() {
        let rows = vec![row("save_step", "nothing added", 3)];
        let merged = merge_error(rows, row("save_step", "nothing added", 0), now_fixed());
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].count, 2);
        let merged = merge_error(merged, row("save_step", "other", 0), now_fixed());
        assert_eq!(merged.len(), 2);
        let old = vec![row("save_step", "nothing added", 30)];
        assert_eq!(merge_error(old, row("save_step", "nothing added", 0), now_fixed()).len(), 2);
    }

    #[test]
    fn old_rows_expire_and_cap_holds() {
        let rows = vec![row("a", "x", 60 * 24 * 31)];
        let merged = merge_error(rows, row("b", "y", 0), now_fixed());
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].command, "b");
        let many: Vec<_> = (0..ERRORS_CAP).map(|i| row("c", &i.to_string(), 0)).collect();
        let merged = merge_error(many, row("c", "new", 0), now_fixed());
        assert_eq!(merged.len(), ERRORS_CAP);
        assert_eq!(merged.last().unwrap().message, "new");
        assert_eq!(merged[0].message, "1");
    }

    #[test]
    fn routine_not_found_is_only_kept_with_a_notice() {
        let tmp = std::env::temp_dir().join(format!("mesa-assistant-routine-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let _guard = crate::storage::redirect_config_root(&tmp);
        record_error_sync("/p/r", "invoke", "read_file_preview", "路径不可读: No such file or directory (os error 2)", None).unwrap();
        assert!(read_jsonl::<MesaErrorDto>(&project_dir("/p/r").unwrap().join(ERRORS_FILE)).is_empty());
        record_error_sync("/p/r", "invoke", "save_step", "路径不可读: No such file or directory (os error 2)", Some("保存失败")).unwrap();
        record_error_sync("/p/r", "invoke", "workspace_review", "评审基线写入失败", None).unwrap();
        let rows: Vec<MesaErrorDto> = read_jsonl(&project_dir("/p/r").unwrap().join(ERRORS_FILE));
        assert_eq!(rows.len(), 2, "配上提示的例行失败、真正的失败都记");
        assert!(is_routine_failure("读取目录失败: Not a directory (os error 20)"));
        assert!(!is_routine_failure("路径不在项目/登记资源/工作区/终端目录范围内，拒绝读取"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn notice_attaches_only_to_fresh_unmatched_row() {
        let mut rows = vec![row("a", "x", 0)];
        assert!(attach_notice(&mut rows, "保存失败：x", now_fixed()));
        assert_eq!(rows[0].notice.as_deref(), Some("保存失败：x"));
        assert!(!attach_notice(&mut rows, "又一句", now_fixed()), "已配过提示的不再配");
        let mut stale = vec![row("a", "x", 2)];
        assert!(!attach_notice(&mut stale, "晚到的提示", now_fixed()));
    }

    #[test]
    fn records_and_turns_live_per_project_in_config_dir() {
        let tmp = std::env::temp_dir().join(format!("mesa-assistant-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let _guard = crate::storage::redirect_config_root(&tmp);
        record_error_sync("/p/one", "invoke", "save_step", "boom", None).unwrap();
        record_error_sync("/p/one", "toast", "", "", Some("保存进项目失败：boom")).unwrap();
        record_error_sync("/p/two", "invoke", "x", "other", None).unwrap();
        let one: Vec<MesaErrorDto> = read_jsonl(&project_dir("/p/one").unwrap().join(ERRORS_FILE));
        assert_eq!(one.len(), 1, "提示补到了刚才那条后台失败上");
        assert_eq!(one[0].notice.as_deref(), Some("保存进项目失败：boom"));
        assert!(!project_dir("/p/one").unwrap().starts_with("/p/one"), "不写进项目目录");
        assert!(record_error_sync("/p/one", "weird", "", "x", None).is_err());
        append_turn("/p/one", AssistantTurnDto { at: at(0), question: "q".into(), answer: "a".into(), connection: String::new(), basis: String::new() }).unwrap();
        let turns: Vec<AssistantTurnDto> = read_jsonl(&project_dir("/p/one").unwrap().join(LOG_FILE));
        assert_eq!(turns.len(), 1);
        let none: Vec<AssistantTurnDto> = read_jsonl(&project_dir("/p/two").unwrap().join(LOG_FILE));
        assert!(none.is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }
}
