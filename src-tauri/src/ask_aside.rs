//! 问它一句（不打断，2026-11-11，借自 ClawChat「分身」，docs/design-group-consult.md §10）：
//! 工作台任务面板里一段工作正在跑，你想问它一句（做到哪了、为什么这么改），又不想打断它。
//! - Claude Code：原生分叉——`-p --resume <会话> --fork-session --no-session-persistence`，接上它的记忆另起一份、只读工具、
//!   答完不落盘，原会话一个字不动（ai::with_fork_session）。
//! - Codex：它的 fork 只有交互形态，`exec resume` 会写回原会话，所以改用「记忆副本」——Mesa 解析出的这段对话（已脱敏）
//!   连同问题交给同一条连接的一次性只读调用，同样不碰原会话。
//! - 一律只读、不动手：要它照做请用「给它留话」。其余几家还没有可靠的只读一次性调用，先不做。
use serde::Serialize;
use std::path::PathBuf;

/// 记忆副本最多带这么多字（从最近的往前截）
const COPY_CAP: usize = 40_000;
const QUESTION_CAP: usize = 2_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsideAnswerDto {
    pub text: String,
    /// fork = 原生分叉；copy = 记忆副本
    pub how: String,
    pub cost_usd: Option<f64>,
}

pub(crate) const ASIDE_AGENTS: &[&str] = &["claude-code", "codex"];

fn tail_chars(s: &str, cap: usize) -> String {
    let n = s.chars().count();
    if n <= cap {
        s.to_string()
    } else {
        format!("…（更早的略）\n{}", s.chars().skip(n - cap).collect::<String>())
    }
}

pub(crate) fn fork_prompt(question: &str) -> String {
    format!(
        "（旁边有人借你这段记忆的副本问一句，答完这份副本就丢掉。你现在只能看、不能动手：不改文件、不跑会改动东西的命令，\
         也别答应去做什么——要你做事，他会另外给原来的你留话。用中文简短回答。）\n\n{}",
        question.trim()
    )
}

pub(crate) fn copy_prompt(transcript: &str, question: &str) -> String {
    format!(
        "下面是一段正在干活的对话记录，你就是记录里那位 AI，这是你记忆的副本，答完就丢掉。\
         你现在只能看、不能动手：不改文件、不跑会改动东西的命令，也别答应去做什么——要你做事，他会另外给原来的你留话。\n\n\
         ===== 对话记录（最近的部分）=====\n{}\n===== 记录结束 =====\n\n旁边有人问你一句：{}\n用中文简短回答；记录里看不出来的就直说看不出来。",
        tail_chars(transcript, COPY_CAP),
        question.trim()
    )
}

#[tauri::command]
pub async fn run_ask_aside(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    run_id: String,
    question: String,
) -> Result<AsideAnswerDto, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let question: String = question.trim().chars().take(QUESTION_CAP).collect();
        if question.is_empty() {
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
        let cwd = PathBuf::from(&run.isolation_path);
        // 用它自己在用的模型（记录里认得出才用；认不出交给连接的默认）
        let model = crate::usage::session_models(&run.agent, &session)
            .into_iter()
            .last()
            .or_else(|| crate::sessions::launch_model_of(&run.agent, &session));
        let mut cost: Option<f64> = None;
        let (raw, how) = if run.agent == "claude-code" {
            let prompt = crate::sessions::redact_sensitive_text(&fork_prompt(&question));
            let r = crate::ai::with_fork_session(session, || {
                crate::ai::ai_inspect_readonly(profiles, run.profile_id.clone(), model, &cwd, &[], prompt, None, None, Some(&mut cost), &[])
            })?;
            (r, "fork")
        } else {
            let md = crate::sessions::session_markdown(&run.agent, &session).ok_or("读不到这段工作的对话记录")?;
            let prompt = crate::sessions::redact_sensitive_text(&copy_prompt(&md, &question));
            let r = crate::ai::ai_inspect_readonly(profiles, run.profile_id.clone(), model, &cwd, &[], prompt, None, None, Some(&mut cost), &[])?;
            (r, "copy")
        };
        Ok(AsideAnswerDto { text: crate::sessions::redact_sensitive_text(raw.trim()), how: how.into(), cost_usd: cost })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let profile = all.iter().find(|p| p.id == id && p.agent == "claude-code").expect("MESA_ASIDE_PROFILE 要是一条 Claude Code 连接");
        let cwd = crate::dirs::home_dir().unwrap().join(format!(".ccode-aside-real-{}", uuid::Uuid::new_v4().simple()));
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
            crate::ai::ai_inspect_readonly(all.clone(), Some(profile.id.clone()), None, &cwd, &[], fork_prompt("刚才让你记住的数是多少？"), None, None, Some(&mut cost), &[])
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
