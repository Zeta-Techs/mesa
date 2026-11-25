//! 问它一句（不打断，2026-11-11 工作台版；2026-11-25 扩展到聊天页与全 10 家 Agent）：
//! 不打断正在干活的 Agent、也不污染原对话上下文，借当前对话记忆只读答一句（答完不落盘进原会话）。
//! - Claude Code：原生分叉——`-p --resume <会话> --fork-session --no-session-persistence`，接上完整记忆、只读工具、
//!   原会话一字节不动（ai::with_fork_session）。
//! - Codex / Kimi / Grok：这三家均支持 `ai_inspect_readonly`（进程级只读查看工作区），用同家连接读脱敏后的
//!   对话记录副本（最近 4 万字）+ 卡内追问历史回答，不碰原会话（Codex `--ephemeral` 不落盘，Kimi/Grok 标 `internal`）。
//! - 其余 6 家（Gemini / Qwen / OpenCode / CodeBuddy / Cursor / Antigravity CLI）：暂未开放可靠无头只读工具，
//!   自动借项目助手 / 全局默认 / 本机可用的上述 4 家只读连接读当前对话副本代答（`how = "delegate"`）；
//!   若本机未配置这 4 家中任意一家，则回落一次性纯文本调用按记录回答（`how = "text"`，不读写工作区文件）。
use crate::profiles::{AccountType, Profile};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// 记忆副本最多带这么多字（从最近的往前截）
const COPY_CAP: usize = 40_000;
const QUESTION_CAP: usize = 2_000;
/// 侧边浮卡内连续追问历史：最多保留最近 8 轮，总长封顶 12,000 字
const HISTORY_TURNS_CAP: usize = 8;
const HISTORY_CHARS_CAP: usize = 12_000;

/// 支持 `ai::ai_inspect_readonly` 进程级只读无头调用的 4 家 Agent
pub(crate) const NATIVE_INSPECT_AGENTS: &[&str] = &["claude-code", "codex", "kimi", "grok"];
/// 工作台「问它一句」旧名单保留兼容引用
pub(crate) const ASIDE_AGENTS: &[&str] = &["claude-code", "codex"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsideTurnInput {
    pub question: String,
    pub answer: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAskAsideReq {
    pub agent: String,
    pub session_id: Option<String>,
    pub file_path: Option<String>,
    pub profile_id: Option<String>,
    pub model: Option<String>,
    /// 侧边栏独立选定的回答连接（可选；为空时按自动 4 档策略分流）
    #[serde(default)]
    pub override_profile_id: Option<String>,
    /// 侧边栏独立选定的回答模型（可选；与 override_profile_id 配合使用）
    #[serde(default)]
    pub override_model: Option<String>,
    pub cwd: Option<String>,
    pub question: String,
    #[serde(default)]
    pub history: Vec<AsideTurnInput>,
    /// 会话文件尚未落盘时的兜底对话纯文本（后端仍会完整脱敏）
    pub fallback_transcript: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsideAnswerDto {
    pub text: String,
    /// fork = Claude Code 原生分叉；copy = 同家只读记忆副本；delegate = 借只读连接代答；text = 仅按记录纯文本回答
    pub how: String,
    pub cost_usd: Option<f64>,
    pub responder_agent: Option<String>,
    pub responder_profile: Option<String>,
    pub responder_model: Option<String>,
}

fn agent_display_name(agent: &str) -> &str {
    match agent {
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        "kimi" => "Kimi Code",
        "grok" => "Grok Build",
        "gemini" => "Gemini CLI",
        "qwen" => "Qwen Code",
        "opencode" => "OpenCode",
        "codebuddy" => "CodeBuddy Code",
        "cursor" => "Cursor CLI",
        "agy" => "Antigravity CLI",
        other => other,
    }
}

fn tail_chars(s: &str, cap: usize) -> String {
    let n = s.chars().count();
    if n <= cap {
        s.to_string()
    } else {
        format!("…（更早的略）\n{}", s.chars().skip(n - cap).collect::<String>())
    }
}

fn format_aside_history(history: &[AsideTurnInput]) -> String {
    let recent: Vec<&AsideTurnInput> = history
        .iter()
        .filter(|t| !t.question.trim().is_empty() && !t.answer.trim().is_empty())
        .rev()
        .take(HISTORY_TURNS_CAP)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if recent.is_empty() {
        return String::new();
    }
    let mut parts = Vec::with_capacity(recent.len());
    for turn in recent {
        parts.push(format!("问：{}\n答：{}", turn.question.trim(), turn.answer.trim()));
    }
    let body = tail_chars(&parts.join("\n\n"), HISTORY_CHARS_CAP);
    format!("\n\n===== 刚才在旁边已追问过的几句（均不进原对话）=====\n{body}\n===== 追问记录结束 =====")
}

#[cfg(test)]
pub(crate) fn fork_prompt(question: &str) -> String {
    fork_prompt_with_history(question, &[])
}

pub(crate) fn fork_prompt_with_history(question: &str, history: &[AsideTurnInput]) -> String {
    let hist = format_aside_history(history);
    format!(
        "（旁边有人借你这段记忆的副本问一句，答完这份副本就丢掉。你现在只能看、不能动手：不改文件、不跑会改动东西的命令，\
         也别答应去做什么——要你做事，他会回到原对话里说。用中文简短直接回答。）{hist}\n\n{}",
        question.trim()
    )
}

#[cfg(test)]
pub(crate) fn copy_prompt(transcript: &str, question: &str) -> String {
    copy_prompt_with_history(transcript, question, &[])
}

pub(crate) fn copy_prompt_with_history(
    transcript: &str,
    question: &str,
    history: &[AsideTurnInput],
) -> String {
    let hist = format_aside_history(history);
    format!(
        "下面是一段正在进行或已暂停的对话记录，你就是记录里那位 AI，这是你记忆的副本，答完就丢掉。\
         你现在只能看、不能动手：不改文件、不跑会改动东西的命令，也别答应去做什么——要你做事，他会回到原对话里说。\n\n\
         ===== 对话记录（最近的部分）=====\n{}\n===== 记录结束 ====={hist}\n\n旁边有人问你一句：{}\n用中文简短直接回答；记录里看不出来的就直说看不出来。",
        tail_chars(transcript, COPY_CAP),
        question.trim()
    )
}

pub(crate) fn delegate_prompt(
    source_agent: &str,
    transcript: &str,
    question: &str,
    history: &[AsideTurnInput],
    can_read_files: bool,
) -> String {
    let hist = format_aside_history(history);
    let scope = if can_read_files {
        "你可以只读查看工作目录里的文件来核对细节，但绝不能修改文件、也不能运行会改动状态的命令。"
    } else {
        "你这次只能根据下面的对话记录回答，不能读写或修改任何文件。"
    };
    let source_label = agent_display_name(source_agent);
    format!(
        "下面是一段用户与 {source_label} 的对话记录副本。用户在旁边提出一个不打断主对话的临时问题，请你以只读旁观者身份简短代答，答完即丢，不会写入原对话。{scope}\n\n\
         ===== 原对话记录（最近的部分）=====\n{}\n===== 记录结束 ====={hist}\n\n旁边有人问你一句：{}\n用中文简短直接回答；记录里看不出来的就直说看不出来。",
        tail_chars(transcript, COPY_CAP),
        question.trim()
    )
}

pub(crate) fn is_native_inspect_agent(agent: &str) -> bool {
    NATIVE_INSPECT_AGENTS.contains(&agent)
}

fn cli_installed_for(agent: &str) -> bool {
    crate::agents::binary_for(agent)
        .and_then(crate::agents::resolve_binary)
        .is_some()
}

/// 在同家 Agent 里挑一条可用连接（显式 profile_id 优先，否则未停用的同家最近连接）
pub(crate) fn pick_same_agent_profile<'a>(
    profiles: &'a [Profile],
    agent: &str,
    explicit_id: Option<&str>,
    hidden: &HashSet<String>,
) -> Option<&'a Profile> {
    if let Some(id) = explicit_id.map(str::trim).filter(|v| !v.is_empty()) {
        if let Some(p) = profiles.iter().find(|p| p.id == id && p.agent == agent) {
            return Some(p);
        }
    }
    let visible: Vec<&Profile> = profiles
        .iter()
        .filter(|p| p.agent == agent && !hidden.contains(&p.id))
        .collect();
    visible
        .iter()
        .copied()
        .filter(|p| p.account_type != AccountType::Official)
        .max_by(|a, b| a.last_used_at.cmp(&b.last_used_at))
        .or_else(|| visible.iter().copied().max_by(|a, b| a.last_used_at.cmp(&b.last_used_at)))
        .or_else(|| {
            profiles
                .iter()
                .filter(|p| p.agent == agent)
                .max_by(|a, b| a.last_used_at.cmp(&b.last_used_at))
        })
}

/// 给其余 6 家挑代答只读连接：项目助手专属 → 全局 AI 专用 → 未停用最近使用的原生只读 4 家连接；
/// 同时按所命中的槽位带回其指定模型
pub(crate) fn pick_delegate_readonly_profile<'a, F>(
    profiles: &'a [Profile],
    fn_profile_id: Option<&str>,
    fn_model: Option<&str>,
    dedicated_id: Option<&str>,
    dedicated_model: Option<&str>,
    hidden: &HashSet<String>,
    is_installed: F,
) -> Option<(&'a Profile, Option<String>)>
where
    F: Fn(&str) -> bool,
{
    let usable = |p: &&Profile| is_native_inspect_agent(&p.agent) && is_installed(&p.agent);
    if let Some(id) = fn_profile_id.map(str::trim).filter(|v| !v.is_empty()) {
        if let Some(p) = profiles.iter().find(|p| p.id == id && usable(&p)) {
            let model = fn_model.map(str::trim).filter(|m| !m.is_empty()).map(str::to_string);
            return Some((p, model));
        }
    }
    if let Some(id) = dedicated_id.map(str::trim).filter(|v| !v.is_empty()) {
        if let Some(p) = profiles.iter().find(|p| p.id == id && usable(&p)) {
            let model = dedicated_model.map(str::trim).filter(|m| !m.is_empty()).map(str::to_string);
            return Some((p, model));
        }
    }
    let visible: Vec<&Profile> = profiles
        .iter()
        .filter(|p| !hidden.contains(&p.id) && usable(p))
        .collect();
    let picked = visible
        .iter()
        .copied()
        .filter(|p| p.account_type != AccountType::Official)
        .max_by(|a, b| a.last_used_at.cmp(&b.last_used_at))
        .or_else(|| visible.iter().copied().max_by(|a, b| a.last_used_at.cmp(&b.last_used_at)))
        .or_else(|| {
            profiles
                .iter()
                .filter(|p| usable(p))
                .max_by(|a, b| a.last_used_at.cmp(&b.last_used_at))
        })?;
    Some((picked, None))
}

fn resolve_transcript(
    agent: &str,
    session_id: Option<&str>,
    file_path: Option<&str>,
    fallback_transcript: Option<&str>,
) -> Option<String> {
    if let Some(md) = crate::sessions::session_markdown_with_path(agent, session_id, file_path) {
        return Some(md);
    }
    let fb = fallback_transcript.map(str::trim).filter(|s| !s.is_empty())?;
    Some(crate::sessions::redact_sensitive_text(fb))
}

fn infer_session_model(agent: &str, session_id: Option<&str>, explicit_model: Option<&str>) -> Option<String> {
    if let Some(m) = explicit_model.map(str::trim).filter(|s| !s.is_empty()) {
        if m != "<synthetic>" && m != crate::agents::KIMI_ENV_MODEL_ALIAS {
            return Some(m.to_string());
        }
    }
    let sid = session_id.map(str::trim).filter(|s| !s.is_empty())?;
    crate::usage::session_models(agent, sid)
        .into_iter()
        .filter(|m| m != "<synthetic>" && m != crate::agents::KIMI_ENV_MODEL_ALIAS)
        .last()
        .or_else(|| crate::sessions::launch_model_of(agent, sid))
}

/// 校验侧边提问显式选定的连接是否存在（纯函数，便于无 I/O 单测与复用）
pub(crate) fn resolve_override_profile<'a>(
    profiles: &'a [Profile],
    override_profile_id: Option<&str>,
) -> Result<Option<&'a Profile>, String> {
    let Some(ov_id) = override_profile_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let found = profiles
        .iter()
        .find(|p| p.id == ov_id)
        .ok_or_else(|| "侧边提问所选连接已不存在，请重新选择或切回「自动跟随」".to_string())?;
    Ok(Some(found))
}

fn execute_aside(profiles: Vec<Profile>, req: ChatAskAsideReq) -> Result<AsideAnswerDto, String> {
    let question: String = req.question.trim().chars().take(QUESTION_CAP).collect();
    if question.is_empty() {
        return Err("先写一句要问的".to_string());
    }
    let settings = crate::settings::read_current_checked()?;
    let hidden: HashSet<String> = settings
        .hidden_profiles
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect();
    let session_id = req.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let file_path = req.file_path.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let cwd_path: Option<PathBuf> = req
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_dir());

    let mut cost: Option<f64> = None;

    // 路径 0：用户在侧边提问栏显式选择了自己的连接 / 模型
    if let Some(ov_prof) = resolve_override_profile(&profiles, req.override_profile_id.as_deref())?.cloned() {
        let ov_model = req
            .override_model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        // 选的是同为 Claude Code 的连接且原会话有 session_id：直接用新模型走原生无落盘分叉
        if ov_prof.agent == "claude-code" && req.agent == "claude-code" && cli_installed_for("claude-code") {
            if let (Some(cwd), Some(sid)) = (cwd_path.as_deref(), session_id) {
                let prompt = crate::sessions::redact_sensitive_text(&fork_prompt_with_history(
                    &question,
                    &req.history,
                ));
                let raw = crate::ai::with_fork_session(sid.to_string(), || {
                    crate::ai::ai_inspect_readonly(
                        profiles.clone(),
                        Some(ov_prof.id.clone()),
                        ov_model.clone(),
                        cwd,
                        &[],
                        prompt,
                        None,
                        None,
                        Some(&mut cost),
                        &[],
                    )
                })?;
                let used_model = ov_model.clone().or_else(|| ov_prof.models.first().cloned());
                return Ok(AsideAnswerDto {
                    text: crate::sessions::redact_sensitive_text(raw.trim()),
                    how: "fork".into(),
                    cost_usd: cost,
                    responder_agent: Some(ov_prof.agent),
                    responder_profile: Some(ov_prof.name),
                    responder_model: used_model,
                });
            }
        }

        let transcript = resolve_transcript(
            &req.agent,
            session_id,
            file_path,
            req.fallback_transcript.as_deref(),
        )
        .ok_or_else(|| "还没读到这段对话的记录：先发一句再问".to_string())?;

        // 选的是原生只读 4 家且目录有效：走进程级只读查看工作区
        if is_native_inspect_agent(&ov_prof.agent) && cli_installed_for(&ov_prof.agent) {
            if let Some(cwd) = cwd_path.as_deref() {
                let same_agent = ov_prof.agent == req.agent;
                let prompt = crate::sessions::redact_sensitive_text(&if same_agent {
                    copy_prompt_with_history(&transcript, &question, &req.history)
                } else {
                    delegate_prompt(&req.agent, &transcript, &question, &req.history, true)
                });
                let used_model = ov_model.clone().or_else(|| ov_prof.models.first().cloned());
                let raw = crate::ai::ai_inspect_readonly(
                    profiles.clone(),
                    Some(ov_prof.id.clone()),
                    ov_model,
                    cwd,
                    &[],
                    prompt,
                    None,
                    None,
                    Some(&mut cost),
                    &[],
                )?;
                return Ok(AsideAnswerDto {
                    text: crate::sessions::redact_sensitive_text(raw.trim()),
                    how: if same_agent { "copy" } else { "delegate" }.into(),
                    cost_usd: cost,
                    responder_agent: Some(ov_prof.agent),
                    responder_profile: Some(ov_prof.name),
                    responder_model: used_model,
                });
            }
        }

        // 其余 6 家（或目录不存在）：用用户选定的连接与模型按对话记录纯文本回答
        let prompt = crate::sessions::redact_sensitive_text(&delegate_prompt(
            &req.agent,
            &transcript,
            &question,
            &req.history,
            false,
        ));
        let used_model = ov_model.clone().or_else(|| ov_prof.models.first().cloned());
        let raw = crate::ai::ai_prompt_impl_full(
            profiles,
            Some(ov_prof.id.clone()),
            ov_model,
            Some("project-assistant"),
            prompt,
            None,
            None,
            Some(&mut cost),
        )?;
        return Ok(AsideAnswerDto {
            text: crate::sessions::redact_sensitive_text(raw.trim()),
            how: "text".into(),
            cost_usd: cost,
            responder_agent: Some(ov_prof.agent),
            responder_profile: Some(ov_prof.name),
            responder_model: used_model,
        });
    }

    // 路径 1：原会话属于原生只读 4 家，且工作目录存在、同家连接与 CLI 均可用
    if is_native_inspect_agent(&req.agent) && cli_installed_for(&req.agent) {
        if let (Some(cwd), Some(same_prof)) = (
            cwd_path.as_deref(),
            pick_same_agent_profile(&profiles, &req.agent, req.profile_id.as_deref(), &hidden),
        ) {
            let same_prof = same_prof.clone();
            let model = infer_session_model(&req.agent, session_id, req.model.as_deref());
            let used_model = model.clone().or_else(|| same_prof.models.first().cloned());
            if req.agent == "claude-code" {
                if let Some(sid) = session_id {
                    let prompt = crate::sessions::redact_sensitive_text(&fork_prompt_with_history(
                        &question,
                        &req.history,
                    ));
                    let raw = crate::ai::with_fork_session(sid.to_string(), || {
                        crate::ai::ai_inspect_readonly(
                            profiles.clone(),
                            Some(same_prof.id.clone()),
                            model.clone(),
                            cwd,
                            &[],
                            prompt,
                            None,
                            None,
                            Some(&mut cost),
                            &[],
                        )
                    })?;
                    return Ok(AsideAnswerDto {
                        text: crate::sessions::redact_sensitive_text(raw.trim()),
                        how: "fork".into(),
                        cost_usd: cost,
                        responder_agent: Some(same_prof.agent),
                        responder_profile: Some(same_prof.name),
                        responder_model: used_model,
                    });
                }
            }
            // Codex / Kimi / Grok（或刚发完第一句尚未拿到 session_id 的 Claude Code）：同家记忆副本只读回答
            if let Some(transcript) = resolve_transcript(
                &req.agent,
                session_id,
                file_path,
                req.fallback_transcript.as_deref(),
            ) {
                let prompt = crate::sessions::redact_sensitive_text(&copy_prompt_with_history(
                    &transcript,
                    &question,
                    &req.history,
                ));
                let raw = crate::ai::ai_inspect_readonly(
                    profiles.clone(),
                    Some(same_prof.id.clone()),
                    model,
                    cwd,
                    &[],
                    prompt,
                    None,
                    None,
                    Some(&mut cost),
                    &[],
                )?;
                return Ok(AsideAnswerDto {
                    text: crate::sessions::redact_sensitive_text(raw.trim()),
                    how: "copy".into(),
                    cost_usd: cost,
                    responder_agent: Some(same_prof.agent),
                    responder_profile: Some(same_prof.name),
                    responder_model: used_model,
                });
            }
        }
    }

    // 路径 2：其余 6 家（或同家连接/目录不可用时），读取脱敏后的对话记录副本
    let transcript = resolve_transcript(
        &req.agent,
        session_id,
        file_path,
        req.fallback_transcript.as_deref(),
    )
    .ok_or_else(|| "还没读到这段对话的记录：先发一句再问".to_string())?;

    let fn_profile = settings
        .ai_profiles
        .as_ref()
        .and_then(|m| m.get("project-assistant").map(String::as_str));
    let fn_model = settings
        .ai_profile_models
        .as_ref()
        .and_then(|m| m.get("project-assistant").map(String::as_str));

    // 路径 2a：优先借项目助手 / 全局默认 / 本机可用的只读 4 家连接，保留只读查看项目文件能力
    if let (Some(cwd), Some((delegate, del_model))) = (
        cwd_path.as_deref(),
        pick_delegate_readonly_profile(
            &profiles,
            fn_profile,
            fn_model,
            settings.ai_profile_id.as_deref(),
            settings.ai_model.as_deref(),
            &hidden,
            cli_installed_for,
        ),
    ) {
        let delegate = delegate.clone();
        let used_model = del_model.clone().or_else(|| delegate.models.first().cloned());
        let prompt = crate::sessions::redact_sensitive_text(&delegate_prompt(
            &req.agent,
            &transcript,
            &question,
            &req.history,
            true,
        ));
        let raw = crate::ai::ai_inspect_readonly(
            profiles.clone(),
            Some(delegate.id.clone()),
            del_model,
            cwd,
            &[],
            prompt,
            None,
            None,
            Some(&mut cost),
            &[],
        )?;
        return Ok(AsideAnswerDto {
            text: crate::sessions::redact_sensitive_text(raw.trim()),
            how: "delegate".into(),
            cost_usd: cost,
            responder_agent: Some(delegate.agent),
            responder_profile: Some(delegate.name),
            responder_model: used_model,
        });
    }

    // 路径 2b：本机未装上述 4 家或工作目录不存在 → 纯文本一次性调用，仅据对话记录回答、不碰工作区
    let prompt = crate::sessions::redact_sensitive_text(&delegate_prompt(
        &req.agent,
        &transcript,
        &question,
        &req.history,
        false,
    ));
    let fallback_profile = fn_profile
        .and_then(|id| profiles.iter().find(|p| p.id == id))
        .or_else(|| {
            settings
                .ai_profile_id
                .as_deref()
                .and_then(|id| profiles.iter().find(|p| p.id == id))
        })
        .or_else(|| {
            req.profile_id
                .as_deref()
                .and_then(|id| profiles.iter().find(|p| p.id == id))
        })
        .cloned();
    let explicit_id = fallback_profile.as_ref().map(|p| p.id.clone());
    let text_model = if explicit_id.as_deref() == req.profile_id.as_deref() {
        infer_session_model(&req.agent, session_id, req.model.as_deref())
    } else if explicit_id.as_deref() == fn_profile {
        fn_model.map(str::to_string)
    } else {
        None
    };
    let used_model = text_model
        .clone()
        .or_else(|| fallback_profile.as_ref().and_then(|p| p.models.first().cloned()));
    let raw = crate::ai::ai_prompt_impl_full(
        profiles,
        explicit_id,
        text_model,
        Some("project-assistant"),
        prompt,
        None,
        None,
        Some(&mut cost),
    )?;
    Ok(AsideAnswerDto {
        text: crate::sessions::redact_sensitive_text(raw.trim()),
        how: "text".into(),
        cost_usd: cost,
        responder_agent: fallback_profile.as_ref().map(|p| p.agent.clone()),
        responder_profile: fallback_profile.as_ref().map(|p| p.name.clone()),
        responder_model: used_model,
    })
}

/// 聊天页「问它一句（不打断）」：面向任意标签 / 任意 10 家 Agent 的只读侧边提问（支持卡内连续追问）
#[tauri::command]
pub async fn chat_ask_aside(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    req: ChatAskAsideReq,
) -> Result<AsideAnswerDto, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || execute_aside(profiles, req))
        .await
        .map_err(|e| e.to_string())?
}

/// 工作台任务面板「问它一句（不打断）」：保持原签名，内部复用同一套只读执行逻辑
#[tauri::command]
pub async fn run_ask_aside(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    run_id: String,
    question: String,
) -> Result<AsideAnswerDto, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed: String = question.trim().chars().take(QUESTION_CAP).collect();
        if trimmed.is_empty() {
            return Err("先写一句要问的".to_string());
        }
        let run = crate::runs::run_get_sync(run_id.clone())?.ok_or("找不到这段工作的记录")?;
        if run.closed_at.is_some() {
            return Err("这段工作已经结束了，直接去看它的对话".into());
        }
        if !ASIDE_AGENTS.contains(&run.agent.as_str()) {
            return Err("「问它一句」目前只支持 Claude Code、Codex 的工作".into());
        }
        let session = run
            .session_id
            .clone()
            .or_else(|| crate::ai::headless_session_of(&run.id).map(|(_, s)| s))
            .ok_or("还没认出这段工作的对话记录：等它说过一句再问")?;
        execute_aside(
            profiles,
            ChatAskAsideReq {
                agent: run.agent,
                session_id: Some(session),
                file_path: None,
                profile_id: run.profile_id,
                model: None,
                override_profile_id: None,
                override_model: None,
                cwd: Some(run.isolation_path),
                question: trimmed,
                history: Vec::new(),
                fallback_transcript: None,
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[allow(dead_code)]
fn _path_unused_check(_: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_profile(id: &str, agent: &str, name: &str, last_used: Option<&str>, official: bool) -> Profile {
        Profile {
            id: id.into(),
            agent: agent.into(),
            name: name.into(),
            account_type: if official { AccountType::Official } else { AccountType::Api },
            no_auth: false,
            protocol: None,
            api_backend: None,
            base_url: None,
            models: vec![],
            role_models: Default::default(),
            extra_env: Default::default(),
            request_policy: Default::default(),
            key_hint: None,
            model: None,
            last_used_at: last_used.map(str::to_string),
            has_key: !official,
            gateway_id: None,
            slot_missing: false,
            connection_status: String::new(),
            model_sync_status: String::new(),
            model_sync_note: None,
            provider_override: None,
            official_ref: None,
        }
    }

    #[test]
    fn prompts_forbid_acting_and_keep_recent_transcript() {
        let f = fork_prompt("  做到哪了？ ");
        assert!(f.contains("不能动手") && f.ends_with("做到哪了？"));
        let long = format!("{}最近一句", "早".repeat(COPY_CAP + 10));
        let c = copy_prompt(&long, "为什么改列名？");
        assert!(c.contains("最近一句") && c.contains("更早的略"));
        assert!(c.contains("旁边有人问你一句：为什么改列名？"));
        assert!(c.chars().count() < COPY_CAP + 1000);
    }

    #[test]
    fn prompts_include_recent_aside_history_only() {
        let history: Vec<AsideTurnInput> = (1..=10)
            .map(|i| AsideTurnInput {
                question: format!("问题{i}"),
                answer: format!("回答{i}"),
            })
            .collect();
        let p = fork_prompt_with_history("最后追问", &history);
        assert!(p.contains("刚才在旁边已追问过的几句"));
        assert!(!p.contains("问题1\n") && !p.contains("问题2\n"));
        assert!(p.contains("问题3") && p.contains("回答10"));
        assert!(p.ends_with("最后追问"));

        let d = delegate_prompt("gemini", "用户：你好", "总结一下", &history[8..], true);
        assert!(d.contains("与 Gemini CLI 的对话记录副本"));
        assert!(d.contains("只读查看工作目录"));
        assert!(d.contains("问题9") && d.contains("总结一下"));

        let t = delegate_prompt("agy", "用户：你好", "总结一下", &[], false);
        assert!(t.contains("与 Antigravity CLI 的对话记录副本"));
        assert!(t.contains("不能读写或修改任何文件"));
    }

    #[test]
    fn delegate_picker_prefers_assistant_then_dedicated_then_recent_readonly() {
        let profiles = vec![
            fake_profile("p-gem", "gemini", "Gemini", Some("2026-11-25T10:00:00Z"), false),
            fake_profile("p-codex", "codex", "Codex Custom", Some("2026-11-20T10:00:00Z"), false),
            fake_profile("p-kimi", "kimi", "Kimi", Some("2026-11-24T10:00:00Z"), false),
            fake_profile("p-claude-off", "claude-code", "Claude Official", Some("2026-11-25T12:00:00Z"), true),
        ];
        let hidden = HashSet::new();

        // 1. 项目助手指向 Gemini（不在只读 4 家），全局专用指向 Codex → 选中 Codex 及其模型
        let (p, m) = pick_delegate_readonly_profile(
            &profiles,
            Some("p-gem"),
            Some("gemini-2.5"),
            Some("p-codex"),
            Some("gpt-5"),
            &hidden,
            |_| true,
        )
        .expect("应回落全局专用 Codex");
        assert_eq!(p.id, "p-codex");
        assert_eq!(m.as_deref(), Some("gpt-5"));

        // 2. 都没有指定 → 在原生 4 家中跳过官方账号，选最近用的非官方 Kimi
        let (p2, m2) = pick_delegate_readonly_profile(
            &profiles,
            None,
            None,
            None,
            None,
            &hidden,
            |_| true,
        )
        .expect("应选 Kimi");
        assert_eq!(p2.id, "p-kimi");
        assert!(m2.is_none());

        // 3. 若本机只有 Gemini 安装了 CLI → 返回 None 交给纯文本兜底
        let none = pick_delegate_readonly_profile(
            &profiles,
            None,
            None,
            None,
            None,
            &hidden,
            |a| a == "gemini",
        );
        assert!(none.is_none());
    }

    #[test]
    fn same_agent_picker_respects_explicit_and_skips_hidden() {
        let profiles = vec![
            fake_profile("c1", "codex", "隐藏的", Some("2026-11-25T12:00:00Z"), false),
            fake_profile("c2", "codex", "可用的", Some("2026-11-24T12:00:00Z"), false),
            fake_profile("g1", "gemini", "别的家", Some("2026-11-25T13:00:00Z"), false),
        ];
        let hidden: HashSet<String> = ["c1".to_string()].into_iter().collect();
        // 显式传错家的 id 不误选，回落同家可用 c2
        let picked = pick_same_agent_profile(&profiles, "codex", Some("g1"), &hidden).unwrap();
        assert_eq!(picked.id, "c2");
        // 显式传同家 c1（哪怕被隐藏）仍尊重
        let explicit = pick_same_agent_profile(&profiles, "codex", Some("c1"), &hidden).unwrap();
        assert_eq!(explicit.id, "c1");
    }

    #[test]
    fn override_profile_resolver_handles_none_found_and_missing() {
        let profiles = vec![fake_profile("p1", "codex", "Codex", None, false)];
        assert!(resolve_override_profile(&profiles, None).unwrap().is_none());
        assert!(resolve_override_profile(&profiles, Some("   ")).unwrap().is_none());
        let ok = resolve_override_profile(&profiles, Some("p1")).unwrap().unwrap();
        assert_eq!(ok.id, "p1");
        let err = resolve_override_profile(&profiles, Some("deleted-profile")).unwrap_err();
        assert!(err.contains("不存在"), "实际报错: {err}");
    }

    /// 原生分叉真跑（2026-11-11，默认不跑）：MESA_ASIDE_REAL=1，MESA_ASIDE_PROFILE=Claude Code 连接 id。
    /// 先落盘跑一段会话让它记住一个数，再分叉问它；断言分叉答得出、原会话文件一个字节没变
    #[test]
    #[ignore]
    fn fork_real_run() {
        if std::env::var("MESA_ASIDE_REAL").is_err() {
            return;
        }
        let store = crate::profiles::ProfileStore::new().unwrap();
        let all = store.list().unwrap();
        let id = std::env::var("MESA_ASIDE_PROFILE").unwrap_or_default();
        let profile = all
            .iter()
            .find(|p| p.id == id && p.agent == "claude-code")
            .expect("MESA_ASIDE_PROFILE 要是一条 Claude Code 连接");
        let cwd = crate::dirs::home_dir()
            .unwrap()
            .join(format!(".ccode-aside-real-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&cwd).unwrap();
        let (text, run) = crate::ai::run_agent_task(
            profile,
            profile.models.first().map(String::as_str),
            "记住这个数：7319。只回答「记住了」。",
            &cwd,
            std::time::Duration::from_secs(300),
            None,
            false,
            None,
            None,
        )
        .expect("落盘的那一段没跑成");
        eprintln!("原会话回答：{text}");
        let rec = crate::runs::run_get_sync(run).unwrap().unwrap();
        let sid = rec.session_id.clone().expect("没认出会话 id");
        let files: Vec<std::path::PathBuf> = walk(&crate::dirs::home_dir().unwrap().join(".claude/projects"))
            .into_iter()
            .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&sid)))
            .collect();
        let before: Vec<Vec<u8>> = files.iter().map(|p| std::fs::read(p).unwrap()).collect();
        let mut cost = None;
        let answer = crate::ai::with_fork_session(sid.clone(), || {
            crate::ai::ai_inspect_readonly(
                all.clone(),
                Some(profile.id.clone()),
                None,
                &cwd,
                &[],
                fork_prompt("刚才让你记住的数是多少？"),
                None,
                None,
                Some(&mut cost),
                &[],
            )
        });
        eprintln!("分叉回答：{answer:?}");
        let after: Vec<Vec<u8>> = files.iter().map(|p| std::fs::read(p).unwrap()).collect();
        let _ = std::fs::remove_dir_all(&cwd);
        assert!(answer.unwrap().contains("7319"), "分叉没接上原会话的记忆");
        assert!(!files.is_empty(), "没找到原会话文件");
        assert_eq!(before, after, "原会话文件被改了");
    }

    fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    out.extend(walk(&p));
                } else {
                    out.push(p);
                }
            }
        }
        out
    }
}
