//! 上下文分类明细（聊天输入框上下文圆环点开的浮层，2026-10-20）：用这个标签同一套启动参数在后台再起一次 CLI，
//! 只跑它自带的 `/context`，读出「系统提示 / 工具 / 技能 / 对话 / 离自动压缩还有多少」。
//!
//! - 只有 Claude Code、Qwen Code 能在无头模式跑 `/context`（2026-10-20 本机实测：Claude 2.1.292
//!   `-p "/context" --resume <id> --no-session-persistence`、Qwen 0.25.2 `-p "/context" --resume <id>`；
//!   拿 2.8MB 真实对话的副本跑，对话文件一个字节没变）。CodeBuddy 有这个命令，但无头模式把它当普通提问发给模型；
//!   其余家没有这类命令——前端只显示总量，不调这里。
//! - 不调用模型生成，不花钱；Claude Code 会调网关的计数接口，网关不支持时它自己估。
//! - Claude Code 关掉 hooks 再跑（`disableAllHooks`）：用户只是点开一个浮层，不该触发他自己挂的通知脚本。
//! - 输出是 CLI 自己的估算，前端标「估算」；分类名只收已知的或短英文名，不把输出原文送前端。

use serde::Serialize;
use std::time::Duration;

/// MCP 服务器多时 Claude Code 要先连上它们才数得出工具，给宽一点
const TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCategoryDto {
    /// CLI 输出里的分类名原文（英文，如 `Messages`、`System tools`）；前端按它翻成中文
    pub key: String,
    pub tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBreakdownDto {
    /// CLI 自己认的上下文窗口
    pub window: u64,
    /// 已占用（各分类之和；Qwen 有接口回报的实际用量时用它）
    pub used: u64,
    /// 离自动压缩还有多少（Claude 的 Free space、Qwen 的 Free，两家都已扣掉自动压缩预留）
    pub until_compact: Option<u64>,
    /// 占用里的各分类（不含剩余与自动压缩预留）
    pub categories: Vec<ContextCategoryDto>,
}

pub(crate) fn supported(agent: &str) -> bool {
    matches!(agent, "claude-code" | "qwen")
}

/// `302.9k` / `1m` / `167,000` / `100` → token 数
fn parse_tokens(s: &str) -> Option<u64> {
    let t = s.trim().trim_end_matches("tokens").trim().replace(',', "");
    let lower = t.to_ascii_lowercase();
    let (num, mul) = if let Some(n) = lower.strip_suffix('k') {
        (n, 1e3)
    } else if let Some(n) = lower.strip_suffix('m') {
        (n, 1e6)
    } else {
        (lower.as_str(), 1.0)
    };
    let v: f64 = num.trim().parse().ok()?;
    (v.is_finite() && v >= 0.0).then(|| (v * mul).round() as u64)
}

/// 分类名只收短的英文名（CLI 自己的分类表头）；别的内容不往前端送
fn category_key(label: &str) -> Option<String> {
    let l = label.trim();
    (!l.is_empty()
        && l.len() <= 40
        && l.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-'))
    .then(|| l.to_string())
}

/// Claude Code `-p "/context"` 的 Markdown：`**Tokens:** 302.9k / 1m (30%)` + 「Estimated usage by category」表
pub(crate) fn parse_claude(text: &str) -> Option<ContextBreakdownDto> {
    let mut window = None;
    let mut used = None;
    let mut until_compact = None;
    let mut categories = Vec::new();
    let mut in_table = false;
    for line in text.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("**Tokens:**") {
            let rest = rest.split('(').next().unwrap_or("");
            let mut parts = rest.split('/');
            used = parts.next().and_then(parse_tokens);
            window = parts.next().and_then(parse_tokens);
            continue;
        }
        if l.starts_with('#') {
            in_table = l.to_ascii_lowercase().contains("usage by category");
            continue;
        }
        if !in_table || !l.starts_with('|') {
            continue;
        }
        let cells: Vec<&str> = l.trim_matches('|').split('|').map(str::trim).collect();
        if cells.len() < 2 || cells[0] == "Category" || cells[0].starts_with('-') {
            continue;
        }
        let (Some(key), Some(tokens)) = (category_key(cells[0]), parse_tokens(cells[1])) else {
            continue;
        };
        match key.as_str() {
            "Free space" => until_compact = Some(tokens),
            "Autocompact buffer" => {}
            _ => categories.push(ContextCategoryDto { key, tokens }),
        }
    }
    let window = window.filter(|w| *w > 0)?;
    if categories.is_empty() {
        return None;
    }
    let used = used.unwrap_or_else(|| categories.iter().map(|c| c.tokens).sum());
    Some(ContextBreakdownDto {
        window,
        used,
        until_compact,
        categories,
    })
}

/// Qwen Code `-p "/context"` 的纯文本（不随界面语言翻译，formatContextUsageText 写死英文）：
/// `Context window: 200.0k tokens`、`  Used   5 tokens (0.0%)`、`  Free   167.0k tokens (83.5%)`，
/// 之后「Usage by category」下每类一行；还没有接口回报时只有「Estimated pre-conversation overhead」下的分类
pub(crate) fn parse_qwen(text: &str) -> Option<ContextBreakdownDto> {
    let mut window = None;
    let mut used = None;
    let mut until_compact = None;
    let mut categories = Vec::new();
    for line in text.lines() {
        if let Some(i) = line.find("Context window:") {
            window = parse_tokens(&line[i + "Context window:".len()..]);
            continue;
        }
        // 分类行：两个空格缩进、名字、对齐空格、「N tokens (x%)」
        let Some(i) = line.find(" tokens (") else {
            continue;
        };
        if !line.starts_with("  ") {
            continue;
        }
        let left = &line[..i];
        let Some(num) = left.split_whitespace().last() else {
            continue;
        };
        let label = left[..left.len() - num.len()].trim();
        // 「└ Cached prefix」是 Used 的子项，不是一类
        if label.starts_with('└') {
            continue;
        }
        let (Some(key), Some(tokens)) = (category_key(label), parse_tokens(num)) else {
            continue;
        };
        match key.as_str() {
            "Used" => used = Some(tokens),
            "Free" => until_compact = Some(tokens),
            _ => categories.push(ContextCategoryDto { key, tokens }),
        }
    }
    let window = window.filter(|w| *w > 0)?;
    if categories.is_empty() {
        return None;
    }
    let used = used.unwrap_or_else(|| categories.iter().map(|c| c.tokens).sum());
    Some(ContextBreakdownDto {
        window,
        used,
        until_compact,
        categories,
    })
}

/// 会话 id 进命令行参数：只收 id 形状（`--resume` 也认标题，不能让任意文本混进去）
fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn headless_args(agent: &str, session_id: &str) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "/context".into(),
        "--resume".into(),
        session_id.into(),
    ];
    if agent == "claude-code" {
        args.push("--no-session-persistence".into());
    }
    args
}

#[tauri::command]
pub async fn context_breakdown(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    agent_id: String,
    profile_id: String,
    cwd: String,
    model: Option<String>,
    session_id: String,
) -> Result<ContextBreakdownDto, String> {
    if !supported(&agent_id) {
        return Err("这家 CLI 不提供分类明细".into());
    }
    if !valid_session_id(&session_id) {
        return Err("还没有可读的对话".into());
    }
    let selected = model.filter(|m| !m.trim().is_empty());
    let mut profile = store.get_with_model(&profile_id, selected.as_deref())?;
    if profile.agent != agent_id {
        return Err("连接与 Agent 不匹配".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let binary = crate::agents::binary_for(&agent_id).ok_or("未知 Agent")?;
        let binary_path = crate::agents::resolve_binary(binary)
            .ok_or_else(|| format!("未找到 {binary}（PATH 与常见安装目录均无）"))?;
        // 与终端启动同一套：密钥只在拉起瞬间读出注入子进程
        let key = crate::profiles::get_key_for_profile(&profile)?;
        crate::agents::ensure_launch_credentials(&profile, key.as_deref())?;
        let model = selected.or_else(|| profile.models.first().cloned());
        crate::combo::apply_to_profile(&mut profile, model.as_deref());
        crate::agents::validate_launch_compatibility(&profile, model.as_deref())?;
        let plan = crate::agents::launch_plan(&profile, key, model.as_deref())?;
        let mut args = plan.args.clone();
        if agent_id == "claude-code" {
            crate::chat_channel::merge_settings_key(
                &mut args,
                "disableAllHooks",
                serde_json::Value::Bool(true),
            );
        }
        args.extend(headless_args(&agent_id, &session_id));
        let mut cmd = crate::process::background_command(&binary_path);
        cmd.args(&args);
        for (k, v) in &plan.env {
            cmd.env(k, v);
        }
        for k in &plan.env_remove {
            cmd.env_remove(k);
        }
        for (k, v) in crate::mcp::spawn_env_secrets() {
            cmd.env(k, v);
        }
        cmd.env("NO_COLOR", "1");
        // 会话按目录存：在这段对话自己的目录里跑，项目的记忆文件 / MCP 也才算得进去
        cmd.current_dir(crate::paths::expand_tilde(&cwd));
        let out = crate::process::capture_command_for(&mut cmd, TIMEOUT, 1024 * 1024, None)?;
        if out.timed_out {
            return Err(format!("读取超时（{} 秒）", TIMEOUT.as_secs()));
        }
        let stdout = crate::updater::strip_ansi(&String::from_utf8_lossy(&out.stdout));
        let parsed = match agent_id.as_str() {
            "claude-code" => parse_claude(&stdout),
            _ => parse_qwen(&stdout),
        };
        parsed.ok_or_else(|| {
            let err = crate::updater::strip_ansi(&String::from_utf8_lossy(&out.stderr));
            let tail: String = err
                .lines()
                .chain(stdout.lines())
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .take(2)
                .collect::<Vec<_>>()
                .join(" ");
            let tail: String = tail.chars().take(160).collect();
            if tail.is_empty() {
                "没认出 /context 的输出".to_string()
            } else {
                format!(
                    "没认出 /context 的输出：{}",
                    crate::sessions::redact_sensitive_text(&tail)
                )
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-10-20 Claude Code 2.1.292 实录（2.8MB 真实对话副本，网关不支持计数接口时的估算）
    const CLAUDE: &str = "## Context Usage

**Model:** claude-opus-5-5
**Tokens:** 302.9k / 1m (30%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.2k | 0.2% |
| System tools | 26.4k | 2.6% |
| Skills | 2k | 0.2% |
| Messages | 272.3k | 27.2% |
| Free space | 664.1k | 66.4% |
| Autocompact buffer | 33k | 3.3% |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| dataviz | Built-in | ~480 |
";

    /// 2026-10-20 Qwen Code 0.25.2 实录（有接口回报之后）
    const QWEN: &str = "## Context Usage

Model: e2e-default  Context window: 200.0k tokens

  Used                               12.3k tokens (6.2%)
  └ Cached prefix                     8.0k tokens (4.0%)
  Free                              154.7k tokens (77.4%)

**Compaction thresholds**
  Effective window:   180,000  (window − 20,000 reserve)
  Auto threshold:     167,000
  Current tier:       safe

**Usage by category**
  System prompt                       3.5k tokens (1.7%)
  Built-in tools                      1.7k tokens (0.8%)
  Memory files                        4.3k tokens (2.1%)
  Skills                              2.3k tokens (1.1%)
  Messages                             500 tokens (0.3%)

*Run /context detail for per-item breakdown.*
";

    #[test]
    fn tokens_parse_cli_units() {
        assert_eq!(parse_tokens("302.9k"), Some(302_900));
        assert_eq!(parse_tokens("1m"), Some(1_000_000));
        assert_eq!(parse_tokens("167,000"), Some(167_000));
        assert_eq!(parse_tokens(" 100 "), Some(100));
        assert_eq!(parse_tokens("200.0k tokens"), Some(200_000));
        assert_eq!(parse_tokens("~480"), None);
    }

    #[test]
    fn claude_context_markdown() {
        let b = parse_claude(CLAUDE).unwrap();
        assert_eq!(b.window, 1_000_000);
        assert_eq!(b.used, 302_900);
        assert_eq!(b.until_compact, Some(664_100));
        let keys: Vec<_> = b.categories.iter().map(|c| c.key.as_str()).collect();
        // 技能明细表（### Skills）不混进分类；剩余与压缩预留不算占用
        assert_eq!(keys, ["System prompt", "System tools", "Skills", "Messages"]);
        assert_eq!(b.categories[3].tokens, 272_300);
    }

    #[test]
    fn qwen_context_text() {
        let b = parse_qwen(QWEN).unwrap();
        assert_eq!(b.window, 200_000);
        assert_eq!(b.used, 12_300);
        assert_eq!(b.until_compact, Some(154_700));
        let keys: Vec<_> = b.categories.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(keys, ["System prompt", "Built-in tools", "Memory files", "Skills", "Messages"]);
        // 还没有接口回报：只有对话前开销，占用取各类之和
        let pre = "## Context Usage

*No API response yet. Send a message to see actual usage.*

**Estimated pre-conversation overhead**
Model: m  Context window: 200.0k tokens

  System prompt                       3.5k tokens (1.7%)
  Built-in tools                      1.7k tokens (0.8%)
";
        let b = parse_qwen(pre).unwrap();
        assert_eq!(b.used, 5_200);
        assert_eq!(b.until_compact, None);
    }

    #[test]
    fn unrecognized_output_and_unsafe_ids() {
        assert_eq!(parse_claude("ok"), None);
        assert_eq!(parse_qwen("ok"), None);
        assert!(valid_session_id("94d0b475-ea88-424b-b1fa-c42895a7b323"));
        assert!(!valid_session_id("--settings"));
        assert!(!valid_session_id("我的 对话"));
        assert_eq!(
            headless_args("claude-code", "s1"),
            ["-p", "/context", "--resume", "s1", "--no-session-persistence"]
        );
        assert_eq!(headless_args("qwen", "s1"), ["-p", "/context", "--resume", "s1"]);
    }
}
