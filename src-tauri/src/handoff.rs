//! 跨 Agent 接力（P3，架构 §11.3 机制四）：接力不是记忆转移——
//! 从当前会话生成结构化简报落成文件，新 Agent 带简报启动，
//! 并用接力链小表记录「新会话接自哪个 agent 的哪个会话」。
//!
//! 安全口径与会话导出一致：简报全文过 redact_sensitive_text 脱敏后才写盘，
//! 密钥不出站；目标路径默认 cwd/.ccode/handoff-<时间>.md，自定义路径必须位于项目目录内。

use rusqlite::{params, Connection};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::agent_specs::{self, PromptInject};
use crate::git_info::GitStatusDto;
use crate::sessions::{self, ChatMessageDto, SessionMetaDto};

/// 简报全文上限（同 inbox 追加口径）
const BRIEF_CAP: usize = 64 * 1024;
/// 单条消息原文上限。超过才截断并标明，避免一条工具回显把整份简报撑满。
const MSG_VERBATIM_CAP: usize = 4_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffBriefDto {
    pub file_path: String,
    /// 给界面回显的一句话概述（要点数 / 改动文件数）
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffTargetDto {
    pub id: String,
    /// 本机已安装（resolve_binary 命中）
    pub installed: bool,
    /// 注册表 prompt_inject 非 Unsupported（目前仅 kimi 需手动发送首条指令）
    pub prompt_supported: bool,
}

/// 接力目标清单：九 CLI 全量返回，前端按 installed/prompt_supported 排序与标注
#[tauri::command]
pub fn handoff_targets() -> Vec<HandoffTargetDto> {
    agent_specs::all_agent_specs()
        .iter()
        .map(|spec| HandoffTargetDto {
            id: spec.id.into(),
            installed: crate::agents::resolve_binary(spec.binary).is_some(),
            prompt_supported: spec.prompt_inject != PromptInject::Unsupported,
        })
        .collect()
}

/// 保留原文（不折叠空白、不改写）。超长只截这一条并标明。
fn verbatim(text: &str) -> String {
    let t = text.trim();
    if t.chars().count() <= MSG_VERBATIM_CAP {
        return t.to_string();
    }
    format!(
        "{}…（本条超过 {MSG_VERBATIM_CAP} 字，后部已截断）",
        t.chars().take(MSG_VERBATIM_CAP).collect::<String>()
    )
}

fn quote_block(index: usize, text: &str) -> String {
    let body = verbatim(text)
        .lines()
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{index}.\n{body}\n")
}

/// 消息正文：只取 text 块（thinking/工具调用不进要点）
fn message_text(m: &ChatMessageDto) -> String {
    m.blocks
        .iter()
        .filter(|b| b.kind == "text")
        .map(|b| b.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 共用段：任务信息（agent/cwd/标题/会话 ID）
fn render_task_info(out: &mut String, agent: &str, session_id: &str, cwd: &str, title: &str) {
    out.push_str("## 任务信息\n\n");
    out.push_str(&format!("- 来源 Agent：{agent}\n"));
    out.push_str(&format!("- 项目目录：{cwd}\n"));
    out.push_str(&format!("- 会话标题：{title}\n"));
    out.push_str(&format!("- 会话 ID：{session_id}\n\n"));
}

/// 共用段：当前 git 状态（非仓库时注明）
fn render_git_status(out: &mut String, git: Option<&GitStatusDto>) {
    out.push_str("## 当前 git 状态\n\n");
    match git {
        Some(g) if g.is_repo => {
            out.push_str(&format!(
                "- 分支：{}（领先 {} / 落后 {}）\n",
                if g.branch.is_empty() {
                    "（未命名）"
                } else {
                    &g.branch
                },
                g.ahead,
                g.behind
            ));
            if g.files.is_empty() {
                out.push_str("- 工作区干净，无未提交改动\n");
            } else {
                out.push_str(&format!(
                    "- 改动 {} 个文件（+{} -{}）：\n",
                    g.files.len(),
                    g.total_add,
                    g.total_del
                ));
                for f in &g.files {
                    let stat = match (f.additions, f.deletions) {
                        (Some(a), Some(d)) => format!("（+{a} -{d}）"),
                        _ => "（二进制或新增）".to_string(),
                    };
                    out.push_str(&format!("  - {} {} {}\n", f.status, f.path, stat));
                }
            }
        }
        _ => out.push_str("- （项目目录不是 git 仓库）\n"),
    }
}

/// 共用段：接力说明（用户原话不改写；助手正文供核对）
fn render_handoff_note(out: &mut String, agent: &str) {
    out.push_str("\n## 接力说明\n\n");
    out.push_str(&format!(
        "- 本简报由 Mesa 从 {agent} 会话生成。用户原话已按时间全部列出，必须照原话理解，不要改写。\n"
    ));
    out.push_str("- 助手正文在文末，不含工具调用。源会话仍留在原 Agent。\n");
    out.push_str("- 简报里没有的细节不要编。不确定时先读列出的文件和当前 git 状态。\n");
}

fn brief_title(session_id: &str, title: Option<&str>) -> String {
    title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .unwrap_or_else(|| {
            format!(
                "未命名对话 · {}",
                session_id.chars().take(8).collect::<String>()
            )
        })
}

/// 某一角色的正文，按时间。空正文跳过。工具调用不在 text 块里，不会进来。
fn role_quotes(messages: &[ChatMessageDto], role: &str) -> Vec<String> {
    messages
        .iter()
        .filter(|m| m.role == role)
        .map(|m| message_text(m))
        .filter(|t| !t.trim().is_empty())
        .collect()
}

fn render_quotes(out: &mut String, heading: &str, empty: &str, quotes: &[String]) {
    out.push_str(heading);
    out.push_str("\n\n");
    if quotes.is_empty() {
        out.push_str(empty);
        out.push_str("\n\n");
        return;
    }
    for (i, text) in quotes.iter().enumerate() {
        out.push_str(&quote_block(i + 1, text));
        out.push('\n');
    }
}

/// 组装简报。用户原话与助手正文都按时间逐条收录，不抽样、不改写。
/// 助手正文放在文末：超过 64KB 时先截助手部分，用户原话保留。
/// git 为 None 或 is_repo=false 时注明非仓库。
pub(crate) fn render_handoff_brief(
    agent: &str,
    session_id: &str,
    cwd: &str,
    title: Option<&str>,
    messages: &[ChatMessageDto],
    git: Option<&GitStatusDto>,
) -> String {
    let title = brief_title(session_id, title);
    let mut out = String::new();
    out.push_str(&format!("# 接力简报：{title}\n\n"));
    out.push_str(&format!(
        "> 本简报由 Mesa 从 {agent} 会话生成（{}）。用户原话逐条原文列出，不要改写。助手正文在文末，不含工具调用。这不是原会话文件。\n\n",
        sessions::now_iso()
    ));
    render_task_info(&mut out, agent, session_id, cwd, &title);
    render_quotes(
        &mut out,
        "## 用户原话（全部，按时间）",
        "- （没有用户原话）",
        &role_quotes(messages, "user"),
    );
    render_git_status(&mut out, git);
    render_handoff_note(&mut out, agent);
    render_quotes(
        &mut out,
        "## 助手正文（全部，按时间，供核对）",
        "- （没有助手正文）",
        &role_quotes(messages, "assistant"),
    );
    out
}

/// 「◈ 提炼接力」：用户原话仍逐条原文。AI 只写「要接上的结论」，不能代替原话。
pub(crate) fn render_digest_brief(
    agent: &str,
    session_id: &str,
    cwd: &str,
    title: Option<&str>,
    messages: &[ChatMessageDto],
    ai_body: &str,
    git: Option<&GitStatusDto>,
) -> String {
    let title = brief_title(session_id, title);
    let mut out = String::new();
    out.push_str(&format!("# 接力简报（AI 提炼）：{title}\n\n"));
    out.push_str(&format!(
        "> 本简报由 Mesa 从 {agent} 会话生成（{}）。用户原话逐条原文列出，不要改写。下面的结论只帮助接上助手做过的事，不能覆盖用户原话。助手正文在文末供核对。\n\n",
        sessions::now_iso()
    ));
    render_task_info(&mut out, agent, session_id, cwd, &title);
    render_quotes(
        &mut out,
        "## 用户原话（全部，按时间）",
        "- （没有用户原话）",
        &role_quotes(messages, "user"),
    );
    out.push_str("## 要接上的结论（从助手正文提炼，不能代替用户原话）\n\n");
    out.push_str(ai_body.trim());
    out.push_str("\n\n");
    render_git_status(&mut out, git);
    render_handoff_note(&mut out, agent);
    render_quotes(
        &mut out,
        "## 助手正文（全部，按时间，供核对）",
        "- （没有助手正文）",
        &role_quotes(messages, "assistant"),
    );
    out
}

/// 全文脱敏后按 64KB 上限截断（字符边界对齐），超限追加截断标记
pub(crate) fn redact_and_cap(text: &str) -> String {
    let redacted = sessions::redact_sensitive_text(text);
    if redacted.len() <= BRIEF_CAP {
        return redacted;
    }
    let marker = "\n\n…（简报超过 64KB 上限，尾部已截断）\n";
    let budget = BRIEF_CAP - marker.len();
    let cut = redacted
        .char_indices()
        .map(|(i, _)| i)
        .take_while(|i| *i <= budget)
        .last()
        .unwrap_or(0);
    format!("{}{marker}", &redacted[..cut])
}

/// 接力简报是过程文件而非任务产物（默认 .gitignore 规则的存量仓库补丁）：
/// 写简报时顺手把 `.ccode/handoff-*.md` 补进仓库 .gitignore。best-effort——
/// 非 git 仓库/读取失败静默跳过；已有规则不重复追加。
fn ensure_handoff_ignored(project_root: &Path) {
    if crate::workspaces::run_git(
        project_root,
        &["rev-parse", "--is-inside-work-tree"],
        std::time::Duration::from_secs(10),
    )
    .is_err()
    {
        return;
    }
    let Some(content) =
        with_handoff_rule(&fs::read_to_string(project_root.join(".gitignore")).unwrap_or_default())
    else {
        return;
    };
    let _ = crate::profiles::atomic_write(&project_root.join(".gitignore"), &content);
}

/// 纯逻辑：缺 `.ccode/handoff-*.md` 规则时返回追加后的全文，已有返回 None
fn with_handoff_rule(existing: &str) -> Option<String> {
    const RULE: &str = ".ccode/handoff-*.md";
    if existing.lines().any(|l| l.trim() == RULE) {
        return None;
    }
    let mut content = existing.to_string();
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str("\n# Mesa 接力简报（过程文件，不进版本库）\n.ccode/handoff-*.md\n");
    Some(content)
}

/// 解析简报写入路径：默认 <cwd>/.ccode/handoff-<时间>.md；
/// 自定义路径（相对则基于 cwd）的父目录必须 canonicalize 后仍在项目根内，防符号链接逃逸。
fn handoff_target_path(cwd: &str, target_path: Option<&str>) -> Result<PathBuf, String> {
    // 剥 verbatim：返回值会作为 filePath 交给前端与下一个 agent，`\\?\C:\…` 不能外漏
    let root = crate::paths::canonicalize_plain(Path::new(&sessions::expand_tilde(cwd)))
        .map_err(|e| format!("项目目录无效: {e}"))?;
    if !root.is_dir() {
        return Err("项目路径不是目录".into());
    }
    match target_path.map(str::trim).filter(|p| !p.is_empty()) {
        None => {
            // 文件名时间戳：冒号在 Windows 文件名非法，只留字母数字（同 keys.json 备份名约定）
            let stamp: String = sessions::now_iso()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect();
            Ok(root.join(".ccode").join(format!("handoff-{stamp}.md")))
        }
        Some(p) => {
            let expanded = sessions::expand_tilde(p);
            let candidate = {
                let c = PathBuf::from(&expanded);
                if c.is_absolute() {
                    c
                } else {
                    root.join(c)
                }
            };
            // 父目录可能尚不存在：向上找最近的已存在祖先 canonicalize 校验（防符号链接逃逸）
            let mut ancestor = candidate.parent().map(Path::to_path_buf);
            let canon = loop {
                let Some(a) = ancestor else {
                    return Err("目标路径无效".into());
                };
                match crate::paths::canonicalize_plain(&a) {
                    Ok(c) => break c,
                    Err(_) => ancestor = a.parent().map(Path::to_path_buf),
                }
            };
            if !crate::paths::path_within_path(&canon, &root) {
                return Err("目标路径必须位于项目目录内".into());
            }
            Ok(crate::paths::strip_verbatim(candidate))
        }
    }
}

/// 只比较正文骨架（空白一律压成一个空格）：前端拼正文用 `\n\n`、这里用 `\n`，换行差异不算不同
fn text_skeleton(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 聊天层「从这里分叉」（2026-10-18）：截到用户点的那条助手回复为止（含）。按正文认，不按下标——
/// 聊天层只载入了尾部几页，下标对不上全文。同样的正文出现多次取最后一次；认不出就报错，不悄悄给全文
fn cut_messages_at(
    messages: Vec<ChatMessageDto>,
    until_text: &str,
) -> Result<Vec<ChatMessageDto>, String> {
    let want = text_skeleton(until_text);
    if want.is_empty() {
        return Err("选中的这段回复没有正文，没法从这里分叉".into());
    }
    let at = messages.iter().rposition(|m| {
        m.role != "user" && {
            let have = text_skeleton(&message_text(m));
            have == want || have.contains(&want)
        }
    });
    match at {
        Some(i) => {
            let mut messages = messages;
            messages.truncate(i + 1);
            Ok(messages)
        }
        None => Err("在会话记录里找不到这段回复（可能还没写进会话文件），稍等几秒再试".into()),
    }
}

fn build_handoff_brief_impl(
    agent: &str,
    session_id: &str,
    file_path: &str,
    cwd: &str,
    title: Option<&str>,
    target_path: Option<&str>,
    until_text: Option<&str>,
) -> Result<HandoffBriefDto, String> {
    // 全文解析。用户原话与助手正文都逐条写入，不抽样。
    let messages = sessions::conversation_impl(agent, file_path);
    let messages = match until_text {
        Some(text) => cut_messages_at(messages, text)?,
        None => messages,
    };
    let git = crate::git_info::git_status_sync(cwd).ok();
    let brief = render_handoff_brief(agent, session_id, cwd, title, &messages, git.as_ref());
    let text = redact_and_cap(&brief);
    let path = handoff_target_path(cwd, target_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 .ccode 目录失败: {e}"))?;
    }
    // 简报落 .ccode/ 即确保仓库忽略 handoff-*.md（存量仓库的默认规则补齐）
    ensure_handoff_ignored(Path::new(cwd));
    crate::profiles::atomic_write(&path, &text)?;
    let user_count = messages
        .iter()
        .filter(|m| m.role == "user" && !message_text(m).trim().is_empty())
        .count();
    let file_count = git
        .as_ref()
        .filter(|g| g.is_repo)
        .map(|g| g.files.len())
        .unwrap_or(0);
    Ok(HandoffBriefDto {
        file_path: path.to_string_lossy().into_owned(),
        summary: format!("{user_count} 条用户原话 · {file_count} 个改动文件（已脱敏）"),
    })
}

/// 从源会话生成接力简报并原子写入目标路径，返回文件路径与一句话概述。
/// `until_text`：聊天层「从这里分叉」——只取到这条助手回复为止
#[tauri::command]
pub async fn build_handoff_brief(
    agent: String,
    session_id: String,
    file_path: String,
    cwd: String,
    title: Option<String>,
    target_path: Option<String>,
    until_text: Option<String>,
) -> Result<HandoffBriefDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        build_handoff_brief_impl(
            &agent,
            &session_id,
            &file_path,
            &cwd,
            title.as_deref(),
            target_path.as_deref(),
            until_text.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("生成接力简报失败: {e}"))?
}

/// 「◈ 提炼接力」送入 AI 的助手正文上限。用户原话不进这段输入，避免被中间截断改写。
const DIGEST_CAP: usize = 24 * 1024;

/// 只拼助手正文。超限时中间省略并明确告知模型，简报文末仍保留助手正文供核对。
fn assistant_digest_input(messages: &[ChatMessageDto]) -> String {
    let quotes = role_quotes(messages, "assistant");
    if quotes.is_empty() {
        return "（没有助手正文）".into();
    }
    let joined = quotes
        .iter()
        .enumerate()
        .map(|(i, text)| format!("[{}]\n{text}", i + 1))
        .collect::<Vec<_>>()
        .join("\n\n");
    if joined.len() <= DIGEST_CAP {
        return joined;
    }
    format!(
        "注意：助手正文超过提炼输入上限，中间有一段没有送给你。不要把没看到的部分写成结论。简报文末仍附有助手正文。\n{}",
        crate::ai::cap_text_middle(&joined, DIGEST_CAP)
    )
}

fn build_session_digest_impl(
    profiles: Vec<crate::profiles::Profile>,
    agent: &str,
    session_id: &str,
    file_path: &str,
    cwd: &str,
    title: Option<&str>,
    target_path: Option<&str>,
) -> Result<HandoffBriefDto, String> {
    // 用户原话由简报逐条原文写入，不交给模型改写。模型只看助手正文，抽出要接上的结论。
    let messages = sessions::conversation_impl(agent, file_path);
    let assistant = assistant_digest_input(&messages);
    if role_quotes(&messages, "user").is_empty() && assistant.trim().is_empty() {
        return Err("会话内容为空，无法提炼".into());
    }
    let ai_body = crate::ai::ai_prompt_impl(
        profiles,
        None,
        Some(crate::ai::FN_DIGEST),
        crate::ai::build_digest_prompt(&assistant),
    )?;
    let git = crate::git_info::git_status_sync(cwd).ok();
    let brief = render_digest_brief(
        agent,
        session_id,
        cwd,
        title,
        &messages,
        &ai_body,
        git.as_ref(),
    );
    // AI 输出再过一次脱敏（与规则式简报同一口径），随后 64KB 上限
    let text = redact_and_cap(&brief);
    let path = handoff_target_path(cwd, target_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 .ccode 目录失败: {e}"))?;
    }
    // 简报落 .ccode/ 即确保仓库忽略 handoff-*.md（存量仓库的默认规则补齐）
    ensure_handoff_ignored(Path::new(cwd));
    crate::profiles::atomic_write(&path, &text)?;
    Ok(HandoffBriefDto {
        file_path: path.to_string_lossy().into_owned(),
        summary: format!("AI 提炼全会话 {} 条消息（已脱敏）", messages.len()),
    })
}

/// 「◈ 提炼接力」：AI 蒸馏全会话成结构化简报并原子写入目标路径（需设置页可用的 AI profile）
#[tauri::command]
pub async fn build_session_digest(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    agent: String,
    session_id: String,
    file_path: String,
    cwd: String,
    title: Option<String>,
    target_path: Option<String>,
) -> Result<HandoffBriefDto, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        build_session_digest_impl(
            profiles,
            &agent,
            &session_id,
            &file_path,
            &cwd,
            title.as_deref(),
            target_path.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("提炼接力简报失败: {e}"))?
}

// ===== 提炼简报人工定稿：DigestPicker 编辑后的写回 =====
// 任务书结论统一走 .ccode/drafts/ 草稿（append_step_draft），不再有「钉卡」中间层；
// 这里只负责把人改完的提炼简报写回它自己的过程文件（.ccode/handoff-*.md，不进版本库）。

/// 提炼简报写回：path 必须已存在（它是 build_session_digest 的产物），
/// canonicalize 后必须位于 .ccode/ 目录内且文件名以 handoff- 开头（防逃逸/防误覆盖其他文件）；
/// 内容过 redact_and_cap 脱敏截断后原子覆盖写。
#[tauri::command]
pub async fn finalize_digest_brief(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || finalize_digest_brief_at(&path, &content))
        .await
        .map_err(|e| format!("写回提炼简报失败: {e}"))?
}

fn finalize_digest_brief_at(path: &str, content: &str) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("简报内容为空，无法保存".into());
    }
    let p = PathBuf::from(sessions::expand_tilde(path));
    // canonicalize 要求文件已存在，顺带解开符号链接（逃逸链接解析后落在 .ccode 之外即拒）
    let canon = fs::canonicalize(&p).map_err(|e| format!("简报文件不存在或不可读: {e}"))?;
    if !canon.is_file() {
        return Err("目标不是文件，拒绝覆盖".into());
    }
    let in_ccode = canon
        .parent()
        .and_then(|d| d.file_name())
        .is_some_and(|n| n == ".ccode");
    let is_handoff = canon
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("handoff-"));
    if !in_ccode || !is_handoff {
        return Err("只能写回 .ccode/ 下的 handoff-*.md 提炼简报".into());
    }
    crate::profiles::atomic_write(&canon, &redact_and_cap(content))
}

/// 旧版「定稿简报」残留扫描（迁移提示用）：列项目根 .ccode/ 下 brief-*.md，
/// 返回相对项目根的正斜杠路径列表（文件名带时间戳，字典序即时间序）。
/// list 口径无写门槛（同 read_task_draft）：仅要求 project_root 是有效目录。
#[tauri::command]
pub async fn list_legacy_briefs(project_root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_legacy_briefs_at(&sessions::expand_tilde(&project_root))
    })
    .await
    .map_err(|e| format!("扫描遗留简报失败: {e}"))?
}

fn list_legacy_briefs_at(project_root: &str) -> Result<Vec<String>, String> {
    let root = fs::canonicalize(project_root).map_err(|e| format!("项目目录无效: {e}"))?;
    let mut out: Vec<String> = Vec::new();
    // 无 .ccode 目录 → 空表（不报错）
    if let Ok(entries) = fs::read_dir(root.join(".ccode")) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with("brief-") && name.ends_with(".md") {
                out.push(format!(".ccode/{name}"));
            }
        }
    }
    out.sort();
    Ok(out)
}

// ===== 接力链（app.db 小表）：登记时目标会话还不存在，按 agent+cwd 记录，
// 列表扫描到新会话后固化进 session_meta.handoff_from_* =====

pub(crate) fn ensure_handoff_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS handoff_links(
          target_agent TEXT NOT NULL, target_cwd TEXT NOT NULL,
          from_agent TEXT NOT NULL, from_session_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(target_agent, target_cwd));",
    )
    .map_err(|e| format!("初始化 handoff_links 表失败: {e}"))
}

fn mark_handoff_at(
    conn: &Connection,
    target_agent: &str,
    target_cwd: &str,
    from_agent: &str,
    from_session_id: &str,
) -> Result<(), String> {
    ensure_handoff_table(conn)?;
    conn.execute(
        "INSERT INTO handoff_links(target_agent, target_cwd, from_agent, from_session_id, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(target_agent, target_cwd) DO UPDATE SET from_agent=?3, from_session_id=?4, created_at=?5",
        params![target_agent, target_cwd, from_agent, from_session_id, sessions::now_iso()],
    )
    .map_err(|e| format!("登记接力链失败: {e}"))?;
    Ok(())
}

/// 发起接力时登记：目标 agent + 目录 ← 来源 agent + 会话
#[tauri::command]
pub fn mark_handoff(
    target_agent: String,
    target_cwd: String,
    from_agent: String,
    from_session_id: String,
) -> Result<(), String> {
    let conn = sessions::open_db()?;
    mark_handoff_at(
        &conn,
        &target_agent,
        &target_cwd,
        &from_agent,
        &from_session_id,
    )
}

struct HandoffLink {
    target_agent: String,
    target_cwd: String,
    from_agent: String,
    from_session_id: String,
    created_at: String,
}

fn read_handoff_links(conn: &Connection) -> Vec<HandoffLink> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT target_agent, target_cwd, from_agent, from_session_id, created_at FROM handoff_links",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok(HandoffLink {
            target_agent: r.get(0)?,
            target_cwd: r.get(1)?,
            from_agent: r.get(2)?,
            from_session_id: r.get(3)?,
            created_at: r.get(4)?,
        })
    });
    rows.map(|rs| rs.flatten().collect()).unwrap_or_default()
}

/// 会话目录与登记目录的等价判定：先做展开后的字符串相等（零开销），
/// 不一致再走归一化（canonicalize + 分隔符/前缀归一），避免每次列表全量 canonicalize。
/// 接力链与卡片认领共用同一口径。
pub(crate) fn cwd_matches(session_path: &str, link_cwd: &str) -> bool {
    let expanded = sessions::expand_tilde(link_cwd);
    if session_path == expanded {
        return true;
    }
    crate::usage::normalize_provenance_path(session_path)
        == crate::usage::normalize_provenance_path(&expanded)
}

/// 把接力链并入列表结果（list_sessions 在 apply_meta 之后调用）：
/// 对每条登记，找该 agent+cwd 下登记时间之后有活动、且尚未固化接力来源的最新会话，
/// 标注并固化进 session_meta，随后消费该登记（接力来源以 session_meta 为准，
/// 同目录之后更新的会话不再被误标）。
pub(crate) fn apply_handoff(conn: &Connection, sessions: &mut [SessionMetaDto]) {
    if ensure_handoff_table(conn).is_err() {
        return;
    }
    for link in read_handoff_links(conn) {
        let mut best: Option<usize> = None;
        for (i, s) in sessions.iter().enumerate() {
            if s.agent != link.target_agent || s.handoff_from_agent.is_some() {
                continue;
            }
            // 只认登记之后有活动的会话，避免把接力标到发起前就存在的旧会话上
            if s.updated_at.as_deref().unwrap_or("") < link.created_at.as_str() {
                continue;
            }
            if !cwd_matches(&s.project_path, &link.target_cwd) {
                continue;
            }
            if best.is_none_or(|b| sessions[b].updated_at < s.updated_at) {
                best = Some(i);
            }
        }
        let Some(i) = best else { continue };
        sessions[i].handoff_from_agent = Some(link.from_agent.clone());
        sessions[i].handoff_from_session = Some(link.from_session_id.clone());
        let _ = conn.execute(
            "INSERT INTO session_meta(agent, session_id, handoff_from_agent, handoff_from_session)
             VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(agent, session_id) DO UPDATE SET handoff_from_agent=?3, handoff_from_session=?4",
            params![sessions[i].agent, sessions[i].session_id, link.from_agent, link.from_session_id],
        );
        // 固化完成即消费登记：接力链以 session_meta 为持久记录
        let _ = conn.execute(
            "DELETE FROM handoff_links WHERE target_agent=?1 AND target_cwd=?2",
            params![link.target_agent, link.target_cwd],
        );
    }
}

/// 供测试与调用方共用的会话 DTO 构造（字段随 sessions.rs 演进，集中一处）
#[cfg(test)]
fn test_session(
    agent: &str,
    session_id: &str,
    project_path: &str,
    updated_at: &str,
) -> SessionMetaDto {
    SessionMetaDto {
        agent: agent.into(),
        session_id: session_id.into(),
        project_path: project_path.into(),
        cwd: Some(project_path.into()),
        title: None,
        created_at: None,
        updated_at: Some(updated_at.into()),
        file_path: String::new(),
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
        source: "cli".into(),
        internal: false,
        handoff_from_agent: None,
        handoff_from_session: None,
        task_id: None,
        task_name: None,
        provider: None,
        profile_id: None,
        forked_from: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::{BlockDto, ChatMessageDto};

    fn msg(role: &str, text: &str) -> ChatMessageDto {
        ChatMessageDto {
            role: role.into(),
            blocks: vec![BlockDto {
                kind: "text".into(),
                text: text.into(),
                tool_name: None,
                is_error: false,
                call_id: None,
            }],
            timestamp: None,
            usage: None,
            id: None,
        }
    }

    #[test]
    fn fork_here_cuts_at_the_chosen_reply() {
        let messages = vec![
            msg("user", "第一问"),
            msg("assistant", "第一段回复\n\n第二行"),
            msg("user", "第二问"),
            msg("assistant", "第二段回复"),
        ];
        // 前端用 \n\n 拼正文、这里用 \n：空白差异不影响认出
        let cut = cut_messages_at(messages.clone(), "第一段回复\n第二行").unwrap();
        assert_eq!(cut.len(), 2);
        assert_eq!(message_text(&cut[1]), "第一段回复\n\n第二行");
        // 认不出 / 空正文：报错，不悄悄给全文
        assert!(cut_messages_at(messages.clone(), "没有这段").is_err());
        assert!(cut_messages_at(messages, "   ").is_err());
    }

    #[test]
    fn fork_here_takes_the_latest_duplicate_reply() {
        let messages = vec![
            msg("user", "a"),
            msg("assistant", "好的"),
            msg("user", "b"),
            msg("assistant", "好的"),
            msg("user", "c"),
        ];
        assert_eq!(cut_messages_at(messages, "好的").unwrap().len(), 4);
    }

    fn git_dto() -> GitStatusDto {
        GitStatusDto {
            is_repo: true,
            branch: "main".into(),
            ahead: 2,
            behind: 0,
            files: vec![crate::git_info::GitFileDto {
                path: "src/a.rs".into(),
                status: "M".into(),
                additions: Some(10),
                deletions: Some(3),
            }],
            total_add: 10,
            total_del: 3,
            merging: false,
        }
    }

    /// 简报结构：任务信息 / 对话要点（最近用户消息 + 最后助手回复）/ git 状态 / 接力说明
    #[test]
    fn brief_structure_sections() {
        let messages = vec![
            msg("user", "帮我调研 RAG 评测方案"),
            msg("assistant", "好的，我先读一下代码"),
            msg("user", "重点关注召回率指标"),
            msg("assistant", "已完成初稿，结论如下……"),
        ];
        let brief = render_handoff_brief(
            "codex",
            "sess-12345678",
            "/tmp/proj",
            Some("RAG 调研"),
            &messages,
            Some(&git_dto()),
        );
        assert!(brief.contains("# 接力简报：RAG 调研"));
        assert!(brief.contains("- 来源 Agent：codex"));
        assert!(brief.contains("- 项目目录：/tmp/proj"));
        assert!(brief.contains("- 会话 ID：sess-12345678"));
        assert!(brief.contains("> 帮我调研 RAG 评测方案"));
        assert!(brief.contains("> 重点关注召回率指标"));
        assert!(brief.contains("> 好的，我先读一下代码"));
        assert!(brief.contains("> 已完成初稿，结论如下……"));
        assert!(brief.contains("- 分支：main（领先 2 / 落后 0）"));
        assert!(brief.contains("  - M src/a.rs （+10 -3）"));
        assert!(brief.contains("不要改写"));
        assert!(brief.contains("## 用户原话（全部，按时间）"));
        assert!(brief.contains("## 助手正文（全部，按时间，供核对）"));
    }

    /// 中段的用户原话也逐条在，不因为靠后才保留
    #[test]
    fn brief_keeps_every_user_message() {
        let mut messages = vec![msg("user", "课题是比较三种检索式的召回")];
        for i in 0..20 {
            messages.push(msg("user", &format!("后续第 {i} 条")));
            messages.push(msg("assistant", "收到"));
        }
        let brief = render_handoff_brief("codex", "s-long", "/tmp/p", Some("检索"), &messages, None);
        assert!(brief.contains("> 课题是比较三种检索式的召回"));
        assert!(brief.contains("> 后续第 0 条"));
        assert!(brief.contains("> 后续第 19 条"));
        assert!(!brief.contains("中间省略"));
    }

    /// 空会话与非 git 目录的兜底文案
    #[test]
    fn brief_empty_conversation_and_non_repo() {
        let brief = render_handoff_brief("kimi", "abc", "/tmp/x", None, &[], None);
        assert!(brief.contains("未命名对话 · abc"));
        assert!(brief.contains("（没有用户原话）"));
        assert!(brief.contains("（没有助手正文）"));
        assert!(brief.contains("（项目目录不是 git 仓库）"));
    }

    /// 提炼简报结构：AI 提炼标题 + 共用任务信息/git 段 + AI 正文 + 接力声明
    #[test]
    fn digest_brief_structure_sections() {
        let ai_body = "## 任务目标\n做提炼接力\n\n## 下一步建议\n先写后端";
        let messages = vec![msg("user", "不要改纳入标准")];
        let brief = render_digest_brief(
            "claude-code",
            "sess-12345678",
            "/tmp/proj",
            Some("提炼接力"),
            &messages,
            ai_body,
            Some(&git_dto()),
        );
        assert!(brief.contains("# 接力简报（AI 提炼）：提炼接力"));
        assert!(brief.contains("- 来源 Agent：claude-code"));
        assert!(brief.contains("- 项目目录：/tmp/proj"));
        assert!(brief.contains("- 分支：main（领先 2 / 落后 0）"));
        assert!(brief.contains("> 不要改纳入标准"));
        assert!(brief.contains("## 要接上的结论"));
        assert!(brief.contains("## 任务目标\n做提炼接力"));
        assert!(brief.contains("不要改写"));
        // 未命名回落与规则式简报一致
        let brief = render_digest_brief("kimi", "abc", "/tmp/x", None, &[], "正文", None);
        assert!(brief.contains("未命名对话 · abc"));
        assert!(brief.contains("（项目目录不是 git 仓库）"));
    }

    /// 提炼简报同样过脱敏：AI 正文里的已知前缀密钥不得落盘
    #[test]
    fn digest_brief_redacts_ai_output() {
        let secret = "sk-ant-api03-abcdef123456";
        let brief = render_digest_brief(
            "codex",
            "s1",
            "/tmp/p",
            None,
            &[],
            &format!("密钥是 {secret}"),
            None,
        );
        let text = redact_and_cap(&brief);
        assert!(!text.contains(secret), "AI 输出必须脱敏: {text}");
        assert!(text.contains("已隐藏密钥"));
    }

    /// 脱敏生效：已知前缀密钥（sk- 开头 ≥12 字符）不得原样进简报
    #[test]
    fn brief_redacts_known_secret_tokens() {
        let secret = "sk-ant-api03-abcdef123456";
        let messages = vec![msg("user", &format!("用这个密钥调试 {secret} 看看"))];
        let brief = render_handoff_brief("claude-code", "s1", "/tmp/p", None, &messages, None);
        let text = redact_and_cap(&brief);
        assert!(!text.contains(secret), "密钥必须脱敏: {text}");
        assert!(text.contains("已隐藏密钥"));
    }

    /// 64KB 上限：超长内容按字符边界截断并带截断标记
    #[test]
    fn brief_cap_truncates_oversized() {
        let big = "数".repeat(80 * 1024); // 多字节字符验证边界对齐
        let text = redact_and_cap(&big);
        assert!(text.len() <= BRIEF_CAP, "超过上限: {}", text.len());
        assert!(text.contains("尾部已截断"));
        // 未超限时原样返回（不脱敏无密钥文本、不加标记）
        let small = redact_and_cap("# 简报\n\n- 用户：你好\n");
        assert!(small.contains("- 用户：你好"));
        assert!(!small.contains("尾部已截断"));
    }

    /// .gitignore 规则补齐：缺失才追加、已有不重复、无尾换行先补齐
    #[test]
    fn with_handoff_rule_appends_once() {
        let added = with_handoff_rule("*.pdf\n").unwrap();
        assert!(added.contains(".ccode/handoff-*.md"));
        // 已有规则 → None（幂等）
        assert!(with_handoff_rule(&added).is_none());
        // 空文件也能写
        assert!(with_handoff_rule("")
            .unwrap()
            .contains(".ccode/handoff-*.md"));
        // 无尾换行的存量文件：先换行再追加，不粘连
        let noeol = with_handoff_rule("*.pdf").unwrap();
        assert!(noeol.contains("*.pdf\n\n# Mesa 接力简报"), "{noeol}");
    }

    /// 目标路径：默认落 .ccode/ 下；自定义路径逃出项目根必须拒绝
    #[test]
    fn target_path_default_and_escape_rejected() {
        let root = std::env::temp_dir().join(format!("ccode-handoff-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let cwd = root.to_string_lossy().into_owned();
        let default = handoff_target_path(&cwd, None).unwrap();
        assert!(default.starts_with(crate::paths::canonicalize_plain(&root).unwrap()));
        assert!(
            !default.to_string_lossy().starts_with(r"\\?\"),
            "返回给前端/agent 的路径不得带 verbatim 前缀"
        );
        assert!(default.to_string_lossy().contains(".ccode"));
        assert!(default.extension().is_some_and(|e| e == "md"));
        // 相对路径基于项目根
        let rel = handoff_target_path(&cwd, Some("notes/brief.md")).unwrap();
        assert!(rel.ends_with(std::path::Path::new("notes").join("brief.md").as_path()));
        // 绝对路径逃出项目根：拒绝
        assert!(handoff_target_path(&cwd, Some("/tmp/outside-brief.md")).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    fn test_db() -> Connection {
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
        sessions::migrate_session_meta(&conn);
        conn
    }

    // ===== 提炼简报写回（finalize_digest_brief）与遗留简报扫描（list_legacy_briefs） =====

    /// 写回：内容覆盖原 handoff-*.md 且脱敏；非 handoff- 前缀、.ccode 之外、不存在路径一律拒绝
    #[test]
    fn finalize_digest_brief_overwrites_redacted_and_rejects_foreign_paths() {
        let root = std::env::temp_dir().join(format!("ccode-finalize-{}", uuid::Uuid::new_v4()));
        let ccode = root.join(".ccode");
        fs::create_dir_all(&ccode).unwrap();
        let target = ccode.join("handoff-20260814T000000Z.md");
        fs::write(&target, "# 旧内容").unwrap();

        // 正常覆盖写 + 脱敏
        let secret = "sk-ant-api03-abcdef123456";
        finalize_digest_brief_at(
            target.to_str().unwrap(),
            &format!("# 定稿\n\n密钥 {secret}"),
        )
        .unwrap();
        let text = fs::read_to_string(&target).unwrap();
        assert!(!text.contains("旧内容"), "应整份覆盖: {text}");
        assert!(!text.contains(secret), "落盘必须脱敏: {text}");
        assert!(text.contains("已隐藏密钥"));

        // 空内容拒绝且不破坏原文件
        assert!(finalize_digest_brief_at(target.to_str().unwrap(), "   ").is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), text);

        // 同目录但非 handoff- 前缀：拒绝（防误覆盖草稿/档案卡等）
        let other = ccode.join("project.toml");
        fs::write(&other, "x").unwrap();
        let err = finalize_digest_brief_at(other.to_str().unwrap(), "# x").unwrap_err();
        assert!(err.contains("handoff-"), "{err}");

        // .ccode 之外的路径：拒绝（防逃逸）
        let outside = root.join("handoff-outside.md");
        fs::write(&outside, "x").unwrap();
        assert!(finalize_digest_brief_at(outside.to_str().unwrap(), "# x").is_err());

        // 不存在的路径：拒绝（写回载体必须是已生成的 handoff 文件）
        let missing = ccode.join("handoff-missing.md");
        assert!(finalize_digest_brief_at(missing.to_str().unwrap(), "# x").is_err());
        assert!(!missing.exists(), "拒绝时不得顺手新建文件");
        std::fs::remove_dir_all(&root).ok();
    }

    /// 遗留简报扫描：只收 .ccode/brief-*.md，按时间（文件名）排序；无 .ccode 目录返回空
    #[test]
    fn list_legacy_briefs_filters_and_sorts() {
        let root = std::env::temp_dir().join(format!("ccode-legacy-{}", uuid::Uuid::new_v4()));
        let ccode = root.join(".ccode");
        fs::create_dir_all(&ccode).unwrap();
        fs::write(ccode.join("brief-20260802T100000Z.md"), "# 二").unwrap();
        fs::write(ccode.join("brief-20260801T100000Z.md"), "# 一").unwrap();
        fs::write(ccode.join("handoff-20260803T100000Z.md"), "# 过程文件不收").unwrap();
        fs::write(ccode.join("brief-notes.txt"), "非 md 不收").unwrap();
        fs::write(root.join("brief-root.md"), "根目录不收").unwrap();

        let list = list_legacy_briefs_at(root.to_str().unwrap()).unwrap();
        assert_eq!(
            list,
            vec![
                ".ccode/brief-20260801T100000Z.md".to_string(),
                ".ccode/brief-20260802T100000Z.md".to_string(),
            ]
        );

        // 无 .ccode 目录 → 空表
        let bare = std::env::temp_dir().join(format!("ccode-legacy-bare-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&bare).unwrap();
        assert!(list_legacy_briefs_at(bare.to_str().unwrap())
            .unwrap()
            .is_empty());
        // 不存在的项目根 → 报错
        assert!(list_legacy_briefs_at(bare.join("missing").to_str().unwrap()).is_err());
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&bare).ok();
    }

    /// 接力链往返：登记 → 新会话被扫描到后标注并固化；旧会话/异 agent 不误标
    #[test]
    fn handoff_mark_and_apply_round_trip() {
        let conn = test_db();
        mark_handoff_at(&conn, "codex", "/tmp/proj", "claude-code", "src-sess-1").unwrap();

        // 登记时间之前的旧会话（不应被标注）与之后的新会话
        let old = test_session("codex", "old-sess", "/tmp/proj", "2000-01-01T00:00:00Z");
        let new = test_session("codex", "new-sess", "/tmp/proj", "2999-01-01T00:00:00Z");
        let other_agent = test_session("gemini", "g-sess", "/tmp/proj", "2999-01-01T00:00:00Z");
        let mut sessions = vec![old, new, other_agent];
        apply_handoff(&conn, &mut sessions);

        assert!(
            sessions[0].handoff_from_agent.is_none(),
            "登记前的旧会话不得标注"
        );
        assert_eq!(
            sessions[1].handoff_from_agent.as_deref(),
            Some("claude-code")
        );
        assert_eq!(
            sessions[1].handoff_from_session.as_deref(),
            Some("src-sess-1")
        );
        assert!(
            sessions[2].handoff_from_agent.is_none(),
            "agent 不匹配不得标注"
        );

        // 已固化进 session_meta：换一批 DTO 走 meta 合并口径也能读到（模拟下次列表）
        let persisted: Option<(String, String)> = conn
            .query_row(
                "SELECT handoff_from_agent, handoff_from_session FROM session_meta WHERE agent='codex' AND session_id='new-sess'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        assert_eq!(
            persisted.as_ref().map(|(a, s)| (a.as_str(), s.as_str())),
            Some(("claude-code", "src-sess-1"))
        );
        // 登记已消费：链接表不再保留该接力，固化后同 cwd 更新的会话不再被误标
        assert!(read_handoff_links(&conn).is_empty());

        // 固化后同 cwd 更新的会话不再抢占该标注
        let newer = test_session("codex", "newer-sess", "/tmp/proj", "2999-06-01T00:00:00Z");
        let mut marked = test_session("codex", "new-sess", "/tmp/proj", "2999-01-01T00:00:00Z");
        marked.handoff_from_agent = Some("claude-code".into());
        marked.handoff_from_session = Some("src-sess-1".into());
        let mut sessions = vec![marked, newer];
        apply_handoff(&conn, &mut sessions);
        assert_eq!(
            sessions[0].handoff_from_agent.as_deref(),
            Some("claude-code")
        );
        assert!(
            sessions[1].handoff_from_agent.is_none(),
            "已固化后不得转移标注"
        );
    }

    /// 同 agent+cwd 重复登记：后一次覆盖前一次（重新接力语义）
    #[test]
    fn handoff_mark_overwrites_same_target() {
        let conn = test_db();
        mark_handoff_at(&conn, "kimi", "/tmp/p", "codex", "s1").unwrap();
        mark_handoff_at(&conn, "kimi", "/tmp/p", "qwen", "s2").unwrap();
        let links = read_handoff_links(&conn);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].from_agent, "qwen");
        assert_eq!(links[0].from_session_id, "s2");
    }

    /// 接力目标清单覆盖九 CLI，目前仅 kimi 标注需手动注入
    #[test]
    fn handoff_targets_cover_registry() {
        let targets = handoff_targets();
        assert_eq!(targets.len(), 9);
        let manual: Vec<&str> = targets
            .iter()
            .filter(|t| !t.prompt_supported)
            .map(|t| t.id.as_str())
            .collect();
        assert_eq!(manual, ["kimi"]);
    }
}
