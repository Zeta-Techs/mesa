//! 无头 AI 调用层（§6.12 闭环）：复用 profile 的 launch_plan 注入，
//! 以各 agent 的非交互模式跑一次性 prompt，供提交信息/会话摘要/自动起名/PR 描述等生成功能使用。

use crate::agents;
use crate::profiles::{self, Profile, ProfileStore};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

const AI_TIMEOUT: Duration = Duration::from_secs(120);
const DIFF_CAP: usize = 8 * 1024;
const USER_TURN_CAP: usize = 800;
const USER_TITLE_CAP: usize = 4 * 1024;
const SESSION_TITLE_KINDS: &[&str] = &[
    "功能", "设计", "修复", "优化", "发布", "探索", "文档", "研究",
];

// ===== profile 解析与无头参数 =====

/// 内置 AI 功能 key（settings.ai_profiles 的键）：按功能独立指定 profile
pub const FN_COMMIT: &str = "commit"; // ai_commit_message（◈ 提交信息）
pub const FN_SUMMARIZE: &str = "summarize"; // ai_summarize_session（会话摘要）+ ai_auto_title_session（聊完起名）
pub const FN_PR: &str = "pr"; // ai_draft_pr（PR 描述起草）
pub const FN_DISTILL: &str = "distill"; // ai_distill_skill（✦ 沉淀为技能）
pub const FN_SKILL_OPTIMIZE: &str = "skill-optimize"; // optimize_skills_draft（◈ 优化另存：多源合成出稿）
pub const FN_CONFLICT: &str = "conflict"; // ai_conflict_advice（冲突选侧建议）
pub const FN_DIGEST: &str = "digest"; // build_session_digest（◈ 提炼接力）+ ai_distill_review（评审沉淀起草）
                                      // 「translate」由 JS 侧（技能页翻译）作为 ai_prompt 的 fnKey 显式传入，Rust 无字面引用
#[allow(dead_code)]
pub const FN_TRANSLATE: &str = "translate";
pub const FN_WATCH_EXPLAIN: &str = "watch-explain"; // 文献雷达「解读」（LitWatchCard 显式传入）

/// 显式 id 优先；其次该功能的专属 profile（ai_profiles[fn_key]）；再次设置页 AI 专用 profile；
/// 最后最近使用（last_used_at 最新）；一个都没有才报错。
/// 功能专属 id 已失效（被删）视为不存在继续回落；显式/全局专用 id 失效仍明确报错。
/// 软停用（settings.hidden_profiles）只作用于「最近使用」这一自动回落槽：停用项被跳过，
/// 全部被停用时回落含停用项（好过报错哑掉）；显式/专属/专用槽是用户显式绑定，照常尊重
pub(crate) fn resolve_profile_from(
    profiles: Vec<Profile>,
    profile_id: Option<String>,
    fn_profile_id: Option<String>,
    dedicated_id: Option<String>,
    hidden_ids: &std::collections::HashSet<String>,
) -> Result<Profile, String> {
    if let Some(id) = profile_id.filter(|v| !v.trim().is_empty()) {
        return profiles
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| format!("profile 不存在: {id}"));
    }
    if let Some(id) = fn_profile_id.filter(|v| !v.trim().is_empty()) {
        if let Some(p) = profiles.iter().find(|p| p.id == id) {
            return Ok(p.clone());
        }
    }
    if let Some(id) = dedicated_id.filter(|v| !v.trim().is_empty()) {
        return profiles
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| {
                format!("profile 不存在: {id}（如来自设置页的 AI 专用配置，请到设置页重选）")
            });
    }
    // 最近使用：先跳过官方账号（无头调用吃 OAuth，过期会甩一大段 401 日志）；
    // 显式/专属/专用槽仍尊重官方账号。没有 API 配置才回落官方。
    let visible: Vec<&Profile> = profiles
        .iter()
        .filter(|p| !hidden_ids.contains(&p.id))
        .collect();
    visible
        .iter()
        .copied()
        .filter(|p| p.account_type != crate::profiles::AccountType::Official)
        .max_by(|a, b| a.last_used_at.cmp(&b.last_used_at))
        .or_else(|| {
            visible
                .iter()
                .copied()
                .max_by(|a, b| a.last_used_at.cmp(&b.last_used_at))
        })
        .or_else(|| {
            profiles
                .iter()
                .max_by(|a, b| a.last_used_at.cmp(&b.last_used_at))
        })
        .cloned()
        .ok_or_else(|| "请先在配置页创建并保存一个 profile".to_string())
}

/// 这次解析落到哪一档，就用哪一档记下的模型。
/// 显式传入的 profile（调用方自己选的）不带模型，回落该配置的第一个。
/// 功能专属命中时只用功能自己的模型，不借用全局专用的模型。
pub(crate) fn preferred_ai_model<'a>(
    resolved_id: &str,
    explicit_id: Option<&str>,
    fn_id: Option<&str>,
    fn_model: Option<&'a str>,
    dedicated_id: Option<&str>,
    dedicated_model: Option<&'a str>,
) -> Option<&'a str> {
    if explicit_id.is_some_and(|id| !id.trim().is_empty()) {
        return None;
    }
    if fn_id.is_some_and(|id| id == resolved_id) {
        return fn_model.filter(|model| !model.trim().is_empty());
    }
    if dedicated_id.is_some_and(|id| id == resolved_id) {
        return dedicated_model.filter(|model| !model.trim().is_empty());
    }
    None
}

/// preferred 还在这份配置的模型列表里就用它，否则用第一个。
pub(crate) fn pick_listed_model(models: &[String], preferred: Option<&str>) -> Option<String> {
    preferred
        .map(str::trim)
        .filter(|model| !model.is_empty() && models.iter().any(|item| item == model))
        .map(str::to_string)
        .or_else(|| models.first().cloned())
}

/// 各 agent 的非交互调用参数（matrix「关键启动参数」列；codex 的 provider -c 参数在 plan.args 里）
fn headless_args(agent: &str, prompt: &str) -> Vec<String> {
    match agent {
        "claude-code" => vec![
            "-p".into(),
            prompt.into(),
            "--output-format".into(),
            "text".into(),
        ],
        // AI 无头调用只读沙箱（只生成文本，不需要写权限）
        "codex" => vec![
            "exec".into(),
            "--skip-git-repo-check".into(),
            "-s".into(),
            "read-only".into(),
            prompt.into(),
        ],
        "gemini" => vec!["-p".into(), prompt.into()],
        "kimi" => vec!["-p".into(), prompt.into()],
        // codebuddy 位置参数是交互模式；无头必须 -p/--print
        "codebuddy" => vec!["-p".into(), prompt.into()],
        // cursor 无头：-p/--print + --output-format text（与 claude 同形）
        "cursor" => vec![
            "-p".into(),
            prompt.into(),
            "--output-format".into(),
            "text".into(),
        ],
        // grok 无头：-p/--print + --output-format json（**不读 stdin**，prompt 必须走参数）
        "grok" => vec![
            "-p".into(),
            prompt.into(),
            "--output-format".into(),
            "json".into(),
        ],
        "opencode" => vec!["run".into(), prompt.into()],
        // qwen 与未知 agent 按位置参数兜底
        _ => vec![prompt.into()],
    }
}

/// 一次性内部调用（起标题 / 提交信息 / 摘要 / 翻译…，ai_prompt_impl 专用）能否不落盘：
/// 2026-10-17 本机 `--help` 实证——claude `--no-session-persistence`（仅 -p 有效）、
/// codex exec `--ephemeral`。其余 CLI 没有同类开关，照旧落盘，由内部对话保留期清理兜底。
/// 不落盘就没有会话文件可抽用量，所以同时切 JSON 输出，从结果里直接记账。
pub(crate) fn oneshot_is_ephemeral(agent: &str) -> bool {
    matches!(agent, "claude-code" | "codex")
}

/// ai_prompt_impl 的无头参数：可不落盘的 CLI 走不落盘 + JSON 输出，其余与 headless_args 同形。
/// 定时任务（headless_task_args）不走这里——巡检运行事后要能回看。
fn headless_oneshot_args(agent: &str, prompt: &str) -> Vec<String> {
    match agent {
        "claude-code" => vec![
            "-p".into(),
            prompt.into(),
            "--output-format".into(),
            "json".into(),
            "--no-session-persistence".into(),
        ],
        "codex" => vec![
            "exec".into(),
            "--skip-git-repo-check".into(),
            "--ephemeral".into(),
            "--json".into(),
            "-s".into(),
            "read-only".into(),
            prompt.into(),
        ],
        other => headless_args(other, prompt),
    }
}

/// 解析不落盘调用的 JSON 输出 → (正文, 用量事件)。格式 2026-10-17 本机实录：
/// - claude `--output-format json`：单个对象，`result` 是正文，`is_error` 为真时 `result` 是错误句；
///   用量优先 `modelUsage`（按模型分），没有就用顶层 `usage` 记在所选模型上
/// - codex `exec --json`：JSONL 事件流，`item.completed` 且 `item.type=agent_message` 的 `text`
///   是正文（取最后一条）；`turn.completed.usage` 是本轮用量；`type=error` 的 item 是告警
///   （配置项过时之类），只有拿不到正文时才当错误原因
pub(crate) fn parse_oneshot_output(
    agent: &str,
    raw: &str,
    model: Option<&str>,
    day: &str,
) -> Result<(String, Vec<crate::usage::UsageEvent>), String> {
    use serde_json::Value;
    let num = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
    let ev = |model: &str, input: u64, output: u64, cache_read: u64, cache_write: u64| {
        crate::usage::UsageEvent {
            day: day.to_string(),
            model: model.to_string(),
            input,
            output,
            cache_read,
            cache_write,
            ..Default::default()
        }
    };
    match agent {
        "claude-code" => {
            let v: Value = raw
                .lines()
                .rev()
                .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
                .filter(|v| v.get("type").and_then(Value::as_str) == Some("result"))
                .ok_or_else(|| tail_chars(raw.trim(), 240))?;
            let text = v.get("result").and_then(Value::as_str).unwrap_or("").trim().to_string();
            if v.get("is_error").and_then(Value::as_bool) == Some(true) {
                return Err(if text.is_empty() { "AI 调用失败（CLI 未给出原因）".into() } else { text });
            }
            let mut events = Vec::new();
            if let Some(by_model) = v.get("modelUsage").and_then(Value::as_object) {
                for (m, u) in by_model {
                    events.push(ev(
                        m,
                        num(u, "inputTokens"),
                        num(u, "outputTokens"),
                        num(u, "cacheReadInputTokens"),
                        num(u, "cacheCreationInputTokens"),
                    ));
                }
            }
            if events.is_empty() {
                if let Some(u) = v.get("usage") {
                    events.push(ev(
                        model.unwrap_or(""),
                        num(u, "input_tokens"),
                        num(u, "output_tokens"),
                        num(u, "cache_read_input_tokens"),
                        num(u, "cache_creation_input_tokens"),
                    ));
                }
            }
            events.retain(|e| e.input + e.output + e.cache_read + e.cache_write > 0);
            if text.is_empty() {
                return Err("AI 返回为空（无文本输出）".into());
            }
            Ok((text, events))
        }
        "codex" => {
            let mut text: Option<String> = None;
            let mut warning: Option<String> = None;
            let mut events = Vec::new();
            for line in raw.lines() {
                let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                match v.get("type").and_then(Value::as_str) {
                    Some("item.completed") => {
                        let item = v.get("item").cloned().unwrap_or(Value::Null);
                        match item.get("type").and_then(Value::as_str) {
                            Some("agent_message") => {
                                text = item.get("text").and_then(Value::as_str).map(str::to_string);
                            }
                            Some("error") => {
                                warning = item.get("message").and_then(Value::as_str).map(str::to_string);
                            }
                            _ => {}
                        }
                    }
                    Some("turn.completed") => {
                        if let Some(u) = v.get("usage") {
                            events.push(ev(
                                model.unwrap_or(""),
                                // 与会话文件同口径：input 含缓存、output 含推理（usage::uncached_input）
                                crate::usage::uncached_input(num(u, "input_tokens"), num(u, "cached_input_tokens"), 0),
                                num(u, "output_tokens"),
                                num(u, "cached_input_tokens"),
                                num(u, "cache_write_input_tokens"),
                            ));
                        }
                    }
                    Some("turn.failed") | Some("error") => {
                        let msg = v
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .or_else(|| v.get("message"))
                            .and_then(Value::as_str);
                        if let Some(m) = msg {
                            warning = Some(m.to_string());
                        }
                    }
                    _ => {}
                }
            }
            events.retain(|e| e.input + e.output + e.cache_read + e.cache_write > 0);
            match text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
                Some(t) => Ok((t, events)),
                None => Err(warning.unwrap_or_else(|| "AI 返回为空（无文本输出）".into())),
            }
        }
        _ => Ok((raw.trim().to_string(), Vec::new())),
    }
}

/// 定时任务（scheduler）的无头参数：与 headless_args 同形，唯一区别是 codex 用
/// workspace-write 沙箱、grok 加 --yolo——定时任务要在项目里写文件（如 lit-watch 的
/// notes/inbox.md、papers/watch-seen.md），read-only 跑不了；grok headless 默认权限模式
/// 未确认（若默认交互式问权限，headless 下非白名单请求会被 Cancelled 导致任务失败），
/// 照 codex `-s workspace-write` 的先例给 grok 加 --yolo（自动批准全部工具，含写文件）
pub(crate) fn headless_task_args(agent: &str, prompt: &str) -> Vec<String> {
    match agent {
        // workspace-write 默认拦网，lit-watch 巡检必须联网；headless 无人可批，不开网必失败
        "codex" => vec![
            "exec".into(),
            "--skip-git-repo-check".into(),
            "-s".into(),
            "workspace-write".into(),
            "-c".into(),
            "sandbox_workspace_write.network_access=true".into(),
            prompt.into(),
        ],
        "grok" => vec![
            "-p".into(),
            prompt.into(),
            "--output-format".into(),
            "json".into(),
            "--yolo".into(),
        ],
        other => headless_args(other, prompt),
    }
}

// ===== 进程执行（不走 PTY；stdout/stderr 各开线程读，超时 kill 并返回部分输出） =====

/// 这次无头运行要不要给 Codex 加 Windows 沙箱覆盖（只 Windows、只 Codex；用户自己没配、在 Mesa 里确认过才加，
/// 见 agent_specs::codex_win_sandbox_override）
fn codex_win_sandbox_for_run(agent: &str) -> Option<&'static str> {
    if !cfg!(windows) || agent != "codex" {
        return None;
    }
    let consent = crate::settings::read_current().codex_win_sandbox_consent.unwrap_or(false);
    crate::agent_specs::codex_win_sandbox_override(
        crate::agent_specs::codex_windows_sandbox_mode().as_deref(),
        consent,
    )
}

/// 把 `-c windows.sandbox="…"` 插在提示词（最后一个参数）前面；不改用户的 config.toml，只对这次运行
fn with_codex_win_sandbox(mut args: Vec<String>, sandbox: Option<&str>) -> Vec<String> {
    if let Some(mode) = sandbox {
        let at = args.len().saturating_sub(1);
        args.splice(at..at, ["-c".to_string(), format!("windows.sandbox=\"{mode}\"")]);
    }
    args
}

/// 无头失败不要把 CLI 整段日志甩给用户。官方账号过期、401 等收成一句中文。
/// expected_host = 当前配置应请求的端点（绑定 base_url 的 host 部分），用于把
/// 401 invalid_api_key 细分成两条修复路径：报错 URL 是 api.openai.com 而配置是网关
/// = 渠道路由错（model_provider 没指向自定义渠道，引导重设全局默认）；URL 是网关
/// 自己 = 密钥被拒（引导重填密钥）。没有网关上下文时按 OpenAI 官方密钥处理。
pub(crate) fn summarize_headless_error(detail: &str, expected_host: Option<&str>) -> String {
    let low = detail.to_ascii_lowercase();
    if low.contains("token_revoked")
        || low.contains("refresh_token_invalidated")
        || low.contains("invalidated oauth")
        || low.contains("your session has ended")
        || low.contains("please log out and sign in")
        || low.contains("refresh token was revoked")
        || (low.contains("401")
            && !low.contains("invalid_api_key")
            && !low.contains("incorrect api key")
            && (low.contains("chatgpt.com")
                || low.contains("oauth")
                || low.contains("unauthorized")))
    {
        return "官方账号登录已失效，请到连接页重新登录。后台调用请在设置里指定一套 API 配置。"
            .into();
    }
    // 密钥被 401 拒绝：按报错 URL 与期望端点的关系区分「发错端点」和「密钥本身被拒」
    if low.contains("invalid_api_key") || low.contains("incorrect api key") {
        let gateway = expected_host.filter(|h| !h.ends_with("openai.com"));
        return match gateway {
            Some(host) if low.contains("api.openai.com") => format!(
                "请求被发到了 OpenAI 官方端点，而不是当前配置的网关（{host}）——通常是 model_provider 没指向自定义渠道（可能被其他工具改写了配置）。请到连接页对该配置重新「设为全局默认」，或检查对应 CLI 的配置文件。"
            ),
            Some(host) => format!(
                "网关（{host}）拒绝了密钥（401）——密钥可能填错或已过期。请到连接页编辑该配置重新填写密钥，保存后可用「验证」确认。"
            ),
            None => {
                "OpenAI 官方端点拒绝了密钥（401 invalid_api_key）——密钥可能填错或已吊销，请检查后重试。".into()
            }
        };
    }
    let mut last_err: Option<&str> = None;
    for line in detail.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("Reading additional input") {
            continue;
        }
        if let Some(rest) = t.strip_prefix("ERROR:") {
            last_err = Some(rest.trim());
        } else if t.contains(" ERROR ") {
            last_err = Some(t);
        }
    }
    if let Some(e) = last_err {
        return tail_chars(e, 200);
    }
    tail_chars(detail, 240)
}

fn tail_chars(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        text.to_string()
    } else {
        chars[chars.len() - max..].iter().collect()
    }
}

/// 绑定 base_url → host（小写，剥 scheme/路径）；空或畸形返回 None
fn endpoint_host(base_url: Option<&str>) -> Option<String> {
    let s = base_url?.trim();
    if s.is_empty() {
        return None;
    }
    let no_scheme = s.split("://").nth(1).unwrap_or(s);
    let host = no_scheme.split('/').next().unwrap_or(no_scheme).trim();
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// 从 CLI 输出里抠会话 id（Codex exec 打在 stderr：`session id: <uuid>`）。
pub(crate) fn extract_headless_session_id(detail: &str) -> Option<String> {
    for line in detail.lines() {
        let t = line.trim();
        let lower = t.to_ascii_lowercase();
        if !(lower.starts_with("session id:")
            || lower.starts_with("session_id:")
            || lower.starts_with("sessionid:"))
        {
            continue;
        }
        let Some((_, rest)) = t.split_once(':') else {
            continue;
        };
        let id: String = rest
            .trim()
            .chars()
            .take_while(|c| c.is_ascii_hexdigit() || *c == '-')
            .collect();
        if id.len() >= 8 {
            return Some(id);
        }
    }
    None
}

fn remember_headless_session(agent: &str, out: &str, err: &str) -> Option<String> {
    let id = extract_headless_session_id(&format!("{out}\n{err}"))?;
    let _ = crate::sessions::mark_session_internal(agent, &id);
    Some(id)
}

/// 支持 --session-id 的 CLI：无头启动前锁死文件名并立刻标 internal。
fn lock_headless_session(agent: &str) -> (Option<String>, Vec<String>) {
    let supported = crate::agent_specs::agent_spec(agent).is_some_and(|s| s.fixed_session_id);
    if !supported {
        return (None, Vec::new());
    }
    let id = uuid::Uuid::new_v4().to_string();
    (Some(id.clone()), vec!["--session-id".into(), id])
}

/// CLI 输出里的已知良性噪音行：不影响结果，混进任务摘要会冒充错误正文。
/// claude-code ≥2.1.285 对任何非官方模型 id（网关模型如 glm-*）在 -p/SDK 查询前都会
/// 打一行 `[claude-code:unrecognized_model] {...}`（warn 级遥测，打完请求照发——
/// 2026-10-03 假端点与真实网关双重实证均正常完成）；Mesa 捕获层整行过滤，防用户误诊。
fn strip_known_cli_noise(text: &str) -> String {
    text.lines()
        .filter(|line| {
            !line
                .trim_start()
                .starts_with("[claude-code:unrecognized_model]")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn run_capture_for(
    agent: Option<&str>,
    expected_host: Option<&str>,
    cmd: &mut crate::process::BackgroundCommand,
    timeout: Duration,
    run_id: Option<&str>,
    session_out: &mut Option<String>,
) -> Result<String, String> {
    let captured = crate::process::capture_command_for(cmd, timeout, 8 * 1024 * 1024, run_id)?;
    if captured.cancelled {
        return Err("任务已取消".into());
    }
    let out = strip_known_cli_noise(&String::from_utf8_lossy(&captured.stdout));
    let err = strip_known_cli_noise(&String::from_utf8_lossy(&captured.stderr));
    if let Some(agent) = agent {
        *session_out = remember_headless_session(agent, &out, &err);
    }
    if captured.timed_out {
        let detail = summarize_headless_error(format!("{out}\n{err}").trim(), expected_host);
        return Err(format!("AI 调用超时（{}s）。{detail}", timeout.as_secs()));
    }
    if captured.truncated {
        return Err("AI 输出超过 8 MB 安全上限，结果未采用；请缩小任务范围".into());
    }
    if captured.status.is_some_and(|status| status.success()) {
        let text = out.trim().to_string();
        if text.is_empty() {
            return Err("AI 返回为空（无文本输出）".into());
        }
        return Ok(text);
    }
    let detail = if err.trim().is_empty() { out } else { err };
    let detail = detail.trim();
    if detail.is_empty() {
        // 噪音过滤后可能两头皆空：如实说没有错误信息，别给一条空摘要
        let code = captured.status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        return Err(format!("AI 无头调用失败（退出码 {code}），CLI 未输出错误信息"));
    }
    Err(summarize_headless_error(detail, expected_host))
}

pub(crate) fn ai_prompt_impl(
    profiles: Vec<Profile>,
    profile_id: Option<String>,
    fn_key: Option<&str>,
    prompt: String,
) -> Result<String, String> {
    // 设置页的按功能/全局专用 profile 作为显式 id 之外的默认（每次现读，改动即时生效）
    let settings = crate::settings::read_current_checked()?;
    let explicit_id = profile_id.clone().filter(|v| !v.trim().is_empty());
    let fn_profile = fn_key.and_then(|k| {
        settings
            .ai_profiles
            .as_ref()
            .and_then(|m| m.get(k).cloned())
    });
    let fn_model = fn_key.and_then(|k| {
        settings
            .ai_profile_models
            .as_ref()
            .and_then(|m| m.get(k))
            .map(String::as_str)
    });
    let profile = resolve_profile_from(
        profiles,
        profile_id,
        fn_profile.clone(),
        settings.ai_profile_id.clone(),
        &settings
            .hidden_profiles
            .unwrap_or_default()
            .into_iter()
            .collect(),
    )?;
    let preferred = preferred_ai_model(
        &profile.id,
        explicit_id.as_deref(),
        fn_profile.as_deref(),
        fn_model,
        settings.ai_profile_id.as_deref(),
        settings.ai_model.as_deref(),
    );
    let binary = agents::binary_for(&profile.agent)
        .ok_or_else(|| format!("profile 所属 agent 不支持无头调用: {}", profile.agent))?;
    let binary_path = agents::resolve_binary(binary)
        .ok_or_else(|| format!("未找到 {binary}（PATH 与常见安装目录均无）"))?;
    // 密钥只在调用瞬间读出注入子进程，与终端启动同一约束
    let key = profiles::get_key_for_profile(&profile)?;
    agents::ensure_launch_credentials(&profile, key.as_deref())?;
    let mut profile = profile;
    let selected = pick_listed_model(&profile.models, preferred);
    crate::combo::apply_to_profile(&mut profile, selected.as_deref());
    agents::validate_launch_compatibility(&profile, selected.as_deref())?;
    let plan = agents::launch_plan(&profile, key, selected.as_deref())?;
    let mut cmd = crate::process::background_command(&binary_path);
    let ephemeral = oneshot_is_ephemeral(&profile.agent);
    // 不落盘就没有会话文件，锁会话 id / 标 internal 都无对象
    let (lock_id, lock_args) = if ephemeral {
        (None, Vec::new())
    } else {
        lock_headless_session(&profile.agent)
    };
    if let Some(id) = &lock_id {
        let _ = crate::sessions::mark_session_internal(&profile.agent, id);
    }
    for a in compose_headless_args(
        &profile.agent,
        &plan.args,
        &headless_oneshot_args(&profile.agent, &prompt),
    ) {
        cmd.arg(a);
    }
    for a in lock_args {
        cmd.arg(a);
    }
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    // 官方账号 profile：剔除继承环境里的残留 API 密钥变量（与终端启动同一约束）
    for k in &plan.env_remove {
        cmd.env_remove(k);
    }
    for (k, v) in crate::mcp::spawn_env_secrets() {
        cmd.env(k, v);
    }
    // 隔离的临时 cwd：防止 agent 把当前项目环境（AGENTS.md 等）混进生成结果
    let cwd = std::env::temp_dir().join(format!("ccode-ai-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&cwd).map_err(|e| format!("创建临时目录失败: {e}"))?;
    // 在启动前登记精确来源；usage 只认该登记，不再把用户主动在 /tmp 运行的任务误判为内部活动。
    if let Err(error) = crate::usage::register_internal_ai_run(&profile.agent, &cwd) {
        let _ = fs::remove_dir_all(&cwd);
        return Err(error);
    }
    cmd.current_dir(&cwd);
    let host = endpoint_host(profile.base_url.as_deref());
    let reuse = format!("headless:ai-prompt:{}", fn_key.unwrap_or("generic"));
    let run = crate::runs::open_headless(
        &profile.agent,
        &profile.id,
        &cwd.to_string_lossy(),
        &reuse,
        false,
        "discuss",
    );
    let run = match run {
        Ok(run) => run,
        Err(error) => {
            let _ = fs::remove_dir_all(&cwd);
            return Err(error);
        }
    };
    {
        let r = &run;
        if let Err(error) =
            crate::runs::claim_start(&r.id).and_then(|_| crate::runs::mark_started(&r.id))
        {
            let _ = crate::runs::close_run_with_result(
                &r.id,
                None,
                "failed",
                None,
                Some("无头 Run 状态登记失败"),
            );
            let _ = fs::remove_dir_all(&cwd);
            return Err(error);
        }
    }
    let result = run_capture_for(
        Some(&profile.agent),
        host.as_deref(),
        &mut cmd,
        AI_TIMEOUT,
        Some(&run.id),
        &mut None,
    );
    // 不落盘调用：JSON 里拆出正文与用量，用量直接记账（扫描不到会话文件，重建补不回来）
    let result = if ephemeral {
        result.and_then(|raw| {
            let (text, events) = parse_oneshot_output(
                &profile.agent,
                &raw,
                selected.as_deref(),
                &crate::usage::today_local(),
            )?;
            if let Err(e) = crate::usage::record_ephemeral_usage(
                &profile.agent,
                &format!("ephemeral-{}", run.id),
                &cwd.to_string_lossy(),
                profile.account_type == crate::profiles::AccountType::Official,
                &events,
            ) {
                eprintln!("[ai] {e}");
            }
            Ok(text)
        })
    } else {
        result
    };
    let status = if result.is_ok() {
        "completed"
    } else if result.as_ref().err().is_some_and(|e| e.contains("已取消")) {
        "stopped"
    } else {
        "failed"
    };
    let closed = crate::runs::close_run_with_result(
        &run.id,
        None,
        status,
        None,
        (result.is_err()).then_some("无头 Agent 执行失败"),
    );
    let _ = fs::remove_dir_all(&cwd);
    closed.map_err(|e| format!("Agent 已退出，但运行状态保存失败：{e}"))?;
    result
}

/// 定时任务执行段（scheduler 用）：与 ai_prompt_impl 同一注入链路，但 cwd 是传入的
/// 项目目录——不建/删临时目录，也不登记 usage_provenance.internal（那会把该 Agent
/// 在此项目的交互会话一并标成内部）。会话按 session id 标 internal，不进本项目会话。
/// token 仍按项目归因。密钥同样只在拉起瞬间读出注入。
/// 去掉 plan 参数里的沙箱档位（-s/--sandbox 键值对）：无头场景沙箱档位由各调用点的
/// headless 参数定夺（一次性 prompt = read-only、定时任务 = workspace-write），
/// 与 plan 的默认 workspace-write 并存会让 codex 报「-s 不能重复」直接退出
fn strip_sandbox_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut skip_next = false;
    for a in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if a == "-s" || a == "--sandbox" {
            skip_next = true;
            continue;
        }
        out.push(a.clone());
    }
    out
}

/// 无头调用的最终参数拼装（plan 注入参数 + 无头形态参数）。
/// codex 的 exec 是子命令：plan 的 -c/-m 必须跟在子命令头之后——实测 codex v0.148 把
/// `-c` 放在 exec 前会被顶层解析静默吞掉（provider 回落到 ~/.codex/config.toml 的默认
/// provider，自定义端点配置整个失效，报错的 401 极具迷惑性）；plan 的默认沙箱档剥离，
/// 由 headless 尾部的档位决定（-s 单值参数，重复即报错）。其余 agent 无子命令，顺序照旧
pub(crate) fn compose_headless_args(
    agent: &str,
    plan_args: &[String],
    headless: &[String],
) -> Vec<String> {
    // headless_task_args/headless_args 的 codex 形状固定为 ["exec", "--skip-git-repo-check", …]（有测试钉住）
    const CODEX_HEAD: usize = 2;
    if agent == "codex" && headless.len() >= CODEX_HEAD {
        let mut out = headless[..CODEX_HEAD].to_vec();
        out.extend(strip_sandbox_args(plan_args));
        out.extend(headless[CODEX_HEAD..].iter().cloned());
        out
    } else {
        let mut out = plan_args.to_vec();
        out.extend(headless.iter().cloned());
        out
    }
}

pub(crate) fn run_agent_task(
    profile: &Profile,
    model: Option<&str>,
    prompt: &str,
    cwd: &std::path::Path,
    timeout: Duration,
    reuse_key: Option<&str>,
    sentinel: bool,
    project_root: Option<&std::path::Path>,
    existing_run_id: Option<&str>,
) -> Result<(String, String), String> {
    let binary = agents::binary_for(&profile.agent)
        .ok_or_else(|| format!("profile 所属 agent 不支持无头调用: {}", profile.agent))?;
    let binary_path = agents::resolve_binary(binary)
        .ok_or_else(|| format!("未找到 {binary}（PATH 与常见安装目录均无）"))?;
    let key = profiles::get_key_for_profile(&profile)?;
    agents::ensure_launch_credentials(&profile, key.as_deref())?;
    let mut profile = profile.clone();
    let selected = pick_listed_model(&profile.models, model);
    crate::combo::apply_to_profile(&mut profile, selected.as_deref());
    agents::validate_launch_compatibility(&profile, selected.as_deref())?;
    let plan = agents::launch_plan(&profile, key, selected.as_deref())?;
    let mut cmd = crate::process::background_command(&binary_path);
    // 先于 plan.env 设：Agent 在无头运行里起的 Python 不再按系统代码页（GBK）出字，profile 里写了的照 profile
    if let Some((key, value)) = crate::process::agent_python_io_env() {
        cmd.env(key, value);
    }
    let (lock_id, lock_args) = lock_headless_session(&profile.agent);
    if let Some(id) = &lock_id {
        let _ = crate::sessions::mark_session_internal(&profile.agent, id);
    }
    for a in compose_headless_args(
        &profile.agent,
        &plan.args,
        &with_codex_win_sandbox(
            headless_task_args(&profile.agent, prompt),
            codex_win_sandbox_for_run(&profile.agent),
        ),
    ) {
        cmd.arg(a);
    }
    for a in lock_args {
        cmd.arg(a);
    }
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    for k in &plan.env_remove {
        cmd.env_remove(k);
    }
    for (k, v) in crate::mcp::spawn_env_secrets() {
        cmd.env(k, v);
    }
    cmd.current_dir(cwd);
    let host = endpoint_host(profile.base_url.as_deref());
    let default_reuse = format!("headless:ai:{}", cwd.display());
    let reuse = reuse_key.unwrap_or(&default_reuse);
    let project_root_owned = project_root.map(|p| p.to_string_lossy().into_owned());
    let run = if let Some(id) = existing_run_id {
        crate::runs::run_get(id.to_string())?.ok_or("预登记的 Run 不存在")?
    } else {
        crate::runs::open_headless_with_root(
            project_root_owned.as_deref(),
            &profile.agent,
            &profile.id,
            &cwd.to_string_lossy(),
            reuse,
            sentinel,
            if sentinel { "write_tree" } else { "discuss" },
        )?
    };
    crate::runs::claim_start(&run.id)?;
    if let Err(error) = crate::runs::mark_started(&run.id) {
        let _ = crate::runs::close_run_with_result(
            &run.id,
            None,
            "failed",
            None,
            Some("无头运行登记失败"),
        );
        return Err(error);
    }
    let mut seen_session = None;
    let out = run_capture_for(
        Some(&profile.agent),
        host.as_deref(),
        &mut cmd,
        timeout,
        Some(&run.id),
        &mut seen_session,
    );
    // 会话 id 记到 Run 上（定时历史「看过程」据此打开那次后台对话）：
    // 能锁定 id 的 CLI 用启动前锁的，其余用输出里抠到的
    let session = lock_id.or(seen_session);
    let status = if out.is_ok() {
        "completed"
    } else if out.as_ref().err().is_some_and(|e| e.contains("已取消")) {
        "stopped"
    } else {
        "failed"
    };
    let closed = crate::runs::close_run_with_result(
        &run.id,
        session.as_deref(),
        status,
        None,
        (out.is_err()).then_some("定时/无头 Agent 执行失败"),
    );
    closed.map_err(|e| format!("Agent 已退出，但运行状态保存失败：{e}"))?;
    out.map(|text| (text, run.id))
}

// ===== prompt 构造（纯函数，可测） =====

/// 截断到 max 字节：先对齐 UTF-8 边界，再尽量在换行处收（不切断行）
fn cap_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let cut = text[..end].rfind('\n').map(|i| i + 1).unwrap_or(end);
    let cut = if cut == 0 { end } else { cut };
    format!("{}\n...（内容过长已截断）", &text[..cut])
}

/// 超长时保留首尾、挖掉中间（会话文本用，头尾信息密度最高）
pub(crate) fn cap_text_middle(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let half = max / 2;
    let mut head_end = half;
    while !text.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let mut tail_start = text.len() - half;
    while !text.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    format!(
        "{}\n...（中间省略）...\n{}",
        &text[..head_end],
        &text[tail_start..]
    )
}

fn build_commit_prompt(status: &str, numstat: &str, diff: &str, style: Option<&str>) -> String {
    // 状态栏「⚡ Commit & Push」分割菜单的风格偏好（空 = 默认 conventional commits 风格）
    let style_line = style
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!("风格偏好（覆盖默认风格要求）：{}\n", s.trim()))
        .unwrap_or_default();
    format!(
        "请根据以下 git 变更生成提交信息。\n\
         要求：第一行是 conventional commits 风格主题（feat/fix/refactor/docs/chore 等开头，≤50 字符）；\
         空一行；再写 1-3 行中文要点。只输出提交信息本身，不要解释、不要包裹引号、不要代码块。\n\
         {style_line}\n\
         ## git status\n{status}\n\n## git diff --numstat\n{numstat}\n\n## git diff\n{}",
        cap_text(diff, DIFF_CAP)
    )
}

fn build_summary_prompt(conversation: &str) -> String {
    format!(
        "用 3-5 行中文概括下面这个编程会话：目标是什么、做了哪些关键改动、结果如何。\
         不要逐条复述工具调用，不要客套话，直接给概括。\n\n{conversation}"
    )
}

/// 「◈ 提炼接力」：模型只整理助手正文里要接上的结论。
/// 用户原话由简报逐条原文附上，这里禁止改写或复述。
pub(crate) fn build_digest_prompt(assistant_text: &str) -> String {
    format!(
        "下面只有上一轮助手回复的正文，工具调用已经去掉。\
         用户的每一句原话由系统逐条写进简报，你不要复述、不要改写、不要翻译用户的话。\n\
         请只根据这些助手正文，列出下一个全新会话接着做时必须知道、而用户原话未必已经写明的信息。\
         只输出中文 markdown 正文（不要解释、不要用代码块包裹全文），按以下小节，没有就写「（无）」：\n\
         ## 已完成并有依据的结论\n## 涉及的文件与路径\n## 已否决或明确不做的\n\
         ## 还没做完的\n## 下一步建议\n\
         每条都必须能在助手正文里找到依据。正文没写的不要编，不要补文献、DOI、页码或数据。\
         不要寒暄，不要复述工具调用。\n\n\
         ## 助手正文\n{assistant_text}"
    )
}

fn build_pr_prompt(log: &str, numstat: &str) -> String {
    format!(
        "根据以下提交记录与 diff 统计，为一个 PR 起草中文描述（markdown），结构：\n\
         ## 变更点（分点列出）\n## 动机\n## 测试情况（如提交里没有测试，说明原因）\n\
         只基于给出的提交记录与统计，不要编造未出现的文件或改动。\n\n\
         ## git log --oneline\n{log}\n\n## diff --numstat\n{numstat}"
    )
}

/// 没有新的交接约束时，起草必须只输出这一行。前端据此留空，不把复述写进下一步。
const DISTILL_NOTHING_LINE: &str = "不必沉淀。下一步任务书已经覆盖，按已验收产物做。";

/// 评审「沉淀到下一步」的 AI 起草 prompt（功能键复用 FN_DIGEST）。
/// 对照下一步已有任务书和本步已验收产物，只写下一步还没有的约束。
fn build_review_distill_prompt(
    step_name: &str,
    current_task: &str,
    next_task: &str,
    deliverables: &str,
    review_notes: &str,
    log: &str,
    numstat: &str,
) -> String {
    let current = if current_task.trim().is_empty() {
        "（本步 TASK.md 未读到）".to_string()
    } else {
        cap_text(current_task, DIFF_CAP)
    };
    let next = if next_task.trim().is_empty() {
        "（下一步任务书还没有正文，按模板开工时会带上默认简报）".to_string()
    } else {
        cap_text(next_task, DIFF_CAP)
    };
    let files = if deliverables.trim().is_empty() {
        "（没有读到本步预期产物正文，不要凭文件名发明结论）".to_string()
    } else {
        cap_text_middle(deliverables, DIFF_CAP * 2)
    };
    let notes = if review_notes.trim().is_empty() {
        "（无）".to_string()
    } else {
        cap_text(review_notes, DIFF_CAP)
    };
    format!(
        "步骤刚验收。给人改一版交给下一步「{step_name}」的备忘。\
         改完才会写进下一步任务书。下一步开工会读自己的任务书，也会读已验收产物。\n\
         先读「下一步已有任务书」，列出它已经允许和已经禁止的事。\
         然后只写两类，而且必须具体到文件、章节、图号、表号或结论编号：\n\
         1. 本步产物里已经做了、下一步照自己的常规会改回去或删掉的决定。\
         2. 产物里写明还没由人确认、下一步不能当成已通过的事项。\n\
         下一步任务书已经禁止的事，不要再写一条相同的禁令。\
         下一步任务书已经允许的做法，不要写成禁止。\
         通用写作规则、词数、语种、引用格式、验收过程、提交哈希、行数，都不写。\
         补交上游文件、登录、授权这类不由下一步做的事，也不写。\n\
         一条都没有时，只输出这一行，不要任何标题或其他字：{DISTILL_NOTHING_LINE}\n\
         有内容时只输出中文 markdown 正文，不要解释，不要用代码块包裹全文，按下面两节：\n\
         ## 不要改回去的决定\n## 还没由人确认\n\
         没有第二类时第二节写「（无）」。只依据给出的材料，不要编造未出现的文件或结论。\n\n\
         ## 本步 TASK.md\n{current}\n\n## 下一步已有任务书\n{next}\n\n\
         ## 本步已验收产物\n{files}\n\n## 人在审阅里留下的意见\n{notes}\n\n\
         ## git log --oneline\n{log}\n\n## diff --numstat\n{numstat}"
    )
}

/// 模型声明没有新增约束时，不把这段写进下一步任务书。
fn review_distill_is_empty(text: &str) -> bool {
    let body = text
        .trim()
        .trim_matches('`')
        .trim()
        .trim_start_matches("markdown")
        .trim();
    body == DISTILL_NOTHING_LINE
        || body.starts_with(DISTILL_NOTHING_LINE)
        || body.contains("不必沉淀")
}

/// 只读本步预期产物里的文本稿。目录展开一层 md；pdf/docx 不读。
fn read_step_deliverable_text(root: &std::path::Path, patterns: &[String]) -> String {
    let mut out = String::new();
    for pattern in patterns {
        let rel = pattern.trim().trim_start_matches(['/', '\\']);
        if rel.is_empty() || rel.contains("..") {
            continue;
        }
        if pattern.ends_with('/') || pattern.ends_with('\\') {
            let entries = match fs::read_dir(root.join(rel)) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            let mut names: Vec<_> = entries.filter_map(|e| e.ok()).collect();
            names.sort_by_key(|e| e.file_name());
            for entry in names.into_iter().take(12) {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.to_ascii_lowercase().ends_with(".md") {
                    continue;
                }
                push_deliverable_file(&mut out, root, &format!("{rel}{name}"));
            }
            continue;
        }
        push_deliverable_file(&mut out, root, rel);
    }
    out
}

fn push_deliverable_file(out: &mut String, root: &std::path::Path, rel: &str) {
    let lower = rel.to_ascii_lowercase();
    if lower.ends_with(".pdf")
        || lower.ends_with(".docx")
        || lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".zip")
    {
        return;
    }
    let path = root.join(rel);
    if !crate::paths::path_within(&path.to_string_lossy(), &root.to_string_lossy()) {
        return;
    }
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return,
    };
    if text.trim().is_empty() {
        return;
    }
    let body = if rel.replace('\\', "/").ends_with("papers/included.md") {
        distill_included_brief(&text)
    } else {
        cap_text(&text, 6 * 1024)
    };
    out.push_str(&format!("### {rel}\n{body}\n\n"));
}

/// 纳入清单动辄数百行。起草只需要篇数、开头几条和待确认，不必把全文送给模型。
fn distill_included_brief(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.iter().filter(|line| {
        let t = line.trim_start();
        t.starts_with(|c: char| c.is_ascii_digit()) && t.contains(". ")
    }).count();
    let mut out = format!("（纳入清单共 {total} 条，这里只给开头和待确认）\n");
    let mut kept = 0usize;
    for line in &lines {
        let t = line.trim_start();
        let numbered = t.starts_with(|c: char| c.is_ascii_digit()) && t.contains(". ");
        if numbered {
            if kept >= 12 && !t.contains("待确认") {
                continue;
            }
            kept += 1;
        }
        out.push_str(line);
        out.push('\n');
        if out.len() > 6 * 1024 {
            break;
        }
    }
    out
}

fn build_distill_skill_prompt(excerpt: &str) -> String {
    format!(
        "下面这段文字是用户与 AI 助手的一段交互摘录（用户纠正/指导了助手的做法）。\
         请把其中可复用的经验提炼成一个「技能」草稿，供以后让 AI 遵循。\n\
         只输出一个 JSON 对象，不要解释、不要代码块：\n\
         {{\"name\":\"技能目录名（单段安全名称：小写字母/数字/连字符，如 review-paper-notes）\",\
         \"description\":\"一句话中文描述：这个技能帮 AI 做什么\",\
         \"content\":\"SKILL.md 正文（markdown）：整理成规则清单/步骤，直接可执行，不复述原文\"}}\n\n\
         ## 交互摘录\n{excerpt}"
    )
}

/// 从 AI 输出里抠 JSON 对象解析（模型可能裹 markdown/废话，防御式：截取首个 {{ 到末个 }}）
fn parse_skill_draft(raw: &str) -> Result<SkillDraftDto, String> {
    let parse_err = || {
        format!(
            "AI 输出无法解析为技能草稿：{}",
            raw.chars().take(80).collect::<String>()
        )
    };
    let (s, e) = match (raw.find('{'), raw.rfind('}')) {
        (Some(s), Some(e)) if s < e => (s, e),
        _ => return Err(parse_err()),
    };
    let draft: SkillDraftDto = serde_json::from_str(&raw[s..=e]).map_err(|_| parse_err())?;
    let name = draft.name.trim().to_lowercase();
    let description = draft.description.trim().to_string();
    let content = draft.content.trim().to_string();
    if name.is_empty() || content.is_empty() {
        return Err(parse_err());
    }
    Ok(SkillDraftDto {
        name,
        description,
        content,
    })
}

fn build_conflict_prompt(branch: &str, base: &str, files: &[(String, String)]) -> String {
    let mut body = String::new();
    for (path, content) in files {
        body.push_str(&format!("## 文件 {path}\n{}\n\n", cap_text(content, 4000)));
    }
    format!(
        "你在帮用户解决 git 合并冲突：分支 {branch} 正在把 {base} 并入。\
         下面文件中 <<<<<<< HEAD 与 ======= 之间是「分支侧」内容，======= 与 >>>>>>> 之间是「{base} 侧」内容。\n\
         请逐个文件判断该选哪侧：ours（分支侧合理）、theirs（{base} 侧合理）、\
         manual（两边需要各保留一部分，建议人工逐行合并）。\n\
         只输出 JSON 数组，不要解释、不要代码块：\n\
         [{{\"path\":\"文件路径\",\"choice\":\"ours|theirs|manual\",\"reason\":\"一句话中文理由\"}}]\n\n{body}"
    )
}

/// 从 AI 输出里抠出 JSON 数组解析（模型可能裹 markdown/废话，防御式；失败则全部 manual）
fn parse_conflict_advice(raw: &str, files: &[String]) -> Vec<ConflictAdviceDto> {
    if let (Some(s), Some(e)) = (raw.find('['), raw.rfind(']')) {
        if let Ok(list) = serde_json::from_str::<Vec<ConflictAdviceDto>>(&raw[s..=e]) {
            if !list.is_empty() {
                return list;
            }
        }
    }
    files
        .iter()
        .map(|f| ConflictAdviceDto {
            path: f.clone(),
            choice: "manual".into(),
            reason: format!(
                "AI 输出无法解析：{}",
                raw.chars().take(80).collect::<String>()
            ),
        })
        .collect()
}

// ===== git 材料收集 =====

fn git_text(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = crate::git_info::run_git(cwd, args)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn git_text_selected(cwd: &str, command: &[&str], paths: &[String]) -> Result<String, String> {
    // 统一走二进制解析（GUI 打包版短 PATH 兜底），解析不到再退回裸名
    let git = agents::resolve_binary("git").unwrap_or_else(|| PathBuf::from("git"));
    let mut cmd = crate::process::background_command(git);
    cmd.arg("-C")
        .arg(cwd)
        .arg("--literal-pathspecs")
        .args(command)
        .arg("--")
        .args(paths);
    let out = cmd.output().map_err(|e| format!("执行 git 失败: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn collect_commit_material(
    cwd: &str,
    paths: Option<&[String]>,
) -> Result<(String, String, String), String> {
    let selected = paths
        .map(|paths| crate::git_info::validate_selected_paths(cwd, paths))
        .transpose()?;
    let status = match &selected {
        Some(paths) => git_text_selected(cwd, &["status", "--porcelain"], paths)?,
        None => git_text(cwd, &["status", "--porcelain"])?,
    };
    if status.trim().is_empty() {
        return Err("工作区干净，没有可提交的变更".into());
    }
    let numstat = match &selected {
        Some(paths) => git_text_selected(cwd, &["diff", "--numstat", "HEAD"], paths),
        None => git_text(cwd, &["diff", "--numstat", "HEAD"]),
    }
    .unwrap_or_default();
    let diff = match &selected {
        Some(paths) => git_text_selected(cwd, &["diff", "HEAD"], paths),
        None => git_text(cwd, &["diff", "HEAD"]),
    }
    .unwrap_or_default();
    Ok((status, numstat, diff))
}

/// 会话文本：user/assistant 的 text 块按角色拼起来
pub(crate) fn conversation_text(msgs: &[crate::sessions::ChatMessageDto]) -> String {
    let mut out = String::new();
    for m in msgs {
        for b in &m.blocks {
            if b.kind == "text" && !b.text.trim().is_empty() {
                let role = if m.role == "user" { "用户" } else { "助手" };
                out.push_str(&format!("[{role}] {}\n", b.text.trim()));
            }
        }
    }
    out
}

pub(crate) fn shanghai_mmdd(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let east = chrono::FixedOffset::east_opt(8 * 3600)?;
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Some(dt.with_timezone(&east).format("%m%d").to_string());
    }
    if let Ok(n) = raw.parse::<f64>() {
        let secs = if n > 1e11 { n / 1000.0 } else { n };
        let dt = chrono::DateTime::from_timestamp(secs as i64, 0)?;
        return Some(dt.with_timezone(&east).format("%m%d").to_string());
    }
    None
}

fn first_message_timestamp(msgs: &[crate::sessions::ChatMessageDto]) -> Option<String> {
    msgs.iter().find_map(|m| m.timestamp.clone())
}

fn user_turn_text(m: &crate::sessions::ChatMessageDto) -> Option<String> {
    if m.role != "user" {
        return None;
    }
    let mut parts = Vec::new();
    for b in &m.blocks {
        if b.kind != "text" {
            continue;
        }
        let t = b.text.trim();
        if t.is_empty() || crate::sessions::is_injected_context_message(t) {
            continue;
        }
        parts.push(t);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

pub(crate) fn user_turns(msgs: &[crate::sessions::ChatMessageDto]) -> Vec<String> {
    msgs.iter().filter_map(user_turn_text).collect()
}

fn turn_too_thin(text: &str) -> bool {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return true;
    }
    let mut rest = compact.to_lowercase();
    for g in [
        "你好", "您好", "hello", "hi", "hey", "nihao", "哈喽", "在吗",
    ] {
        rest = rest.replace(&g.to_lowercase(), "");
    }
    rest.chars().count() < 8
}

pub(crate) fn conversation_too_thin(msgs: &[crate::sessions::ChatMessageDto]) -> bool {
    user_turns(msgs).iter().all(|t| turn_too_thin(t))
}

fn cap_chars(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        s.to_string()
    } else {
        chars[..max].iter().collect()
    }
}

/// 只取用户原话：开头看首条；聊完看首条意图 + 中途纠正 + 最后定题。不取助手回复。
pub(crate) fn user_title_material(msgs: &[crate::sessions::ChatMessageDto], early: bool) -> String {
    let real: Vec<String> = user_turns(msgs)
        .into_iter()
        .filter(|t| !turn_too_thin(t))
        .collect();
    if real.is_empty() {
        return String::new();
    }
    if early || real.len() == 1 {
        return format!("[用户·首条] {}", cap_chars(&real[0], USER_TURN_CAP));
    }
    let mut parts = vec![format!(
        "[用户·首条] {}",
        cap_chars(&real[0], USER_TURN_CAP)
    )];
    if real.len() >= 3 {
        if let Some(mid) = real[1..real.len() - 1]
            .iter()
            .max_by_key(|s| s.chars().count())
        {
            parts.push(format!("[用户·纠正] {}", cap_chars(mid, USER_TURN_CAP)));
        }
    }
    let last = real.last().unwrap();
    if last != &real[0] {
        parts.push(format!("[用户·定题] {}", cap_chars(last, USER_TURN_CAP)));
    }
    cap_text(&parts.join("\n\n"), USER_TITLE_CAP)
}

fn extract_title_candidate(raw: &str) -> Option<String> {
    let stripped = raw
        .trim()
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if stripped.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(stripped) {
            for key in ["text", "message", "content", "output"] {
                if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
                    return extract_title_candidate(s);
                }
            }
        }
    }
    stripped
        .lines()
        .map(str::trim)
        .find(|l| l.contains('|') && !l.starts_with('#'))
        .map(|s| s.to_string())
}

fn is_mmdd_token(s: &str) -> bool {
    s.len() == 4 && s.chars().all(|c| c.is_ascii_digit())
}

fn theme_is_specific(theme: &str) -> bool {
    let chars: Vec<char> = theme.chars().collect();
    let n = chars.len();
    let cjk = chars
        .iter()
        .filter(|c| **c >= '\u{4e00}' && **c <= '\u{9fff}')
        .count();
    (8..=28).contains(&n) && cjk >= 4
}

pub(crate) fn parse_kind_theme(line: &str) -> Option<(String, String)> {
    let line = line
        .trim()
        .trim_matches(|c: char| c == '"' || c == '`' || c == '“' || c == '”');
    let parts: Vec<&str> = line
        .split('|')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let (kind, theme) = if parts.len() >= 3 && is_mmdd_token(parts[0]) {
        (parts[1], parts[2..].join(""))
    } else if parts.len() >= 2 {
        (parts[0], parts[1..].join(""))
    } else {
        return None;
    };
    if !SESSION_TITLE_KINDS.contains(&kind) {
        return None;
    }
    if !theme_is_specific(&theme) {
        return None;
    }
    Some((kind.to_string(), theme))
}

fn build_session_title_prompt(material: &str, mmdd: &str, early: bool, taken: &[String]) -> String {
    let scope = if early {
        "这是临时标题，只根据用户第一条真正的问题。"
    } else {
        "根据用户自己说过的话。首条是最初意图，纠正是中途改方向，定题是最后要求。不要参考助手回复或工具调用。"
    };
    let occupied = if taken.is_empty() {
        String::new()
    } else {
        let lines: Vec<String> = taken.iter().take(40).map(|t| format!("- {t}")).collect();
        format!(
            "\n已有标题，不要重复或只改一两个字：\n{}\n",
            lines.join("\n")
        )
    };
    format!(
        "{scope}只输出一行，不要解释、不要引号、不要代码块。\n\
         格式：类型|主题\n\
         类型只能是以下之一：功能、设计、修复、优化、发布、探索、文档、研究。\n\
         同时符合多个类型时选最能代表这次目的的一个。\n\
         主题：8到28个字，必须让人一眼看出「对什么做了哪一件事」。\n\
         写成对象+动作，例如「Grok继续链合并去重」「目标卡与项目栏同底」。\n\
         不要项目名 Mesa/Ccode，不要完整句子，不要「优化界面」「功能开发」「问题修复」「架构调整」这种空标题。\n\
         不要输出日期（日期由系统填写，创建日为 {mmdd}）。{occupied}\n\
         ## 用户原话\n{material}"
    )
}

fn title_identity_key(title: &str) -> String {
    let title = title.trim();
    let parts: Vec<&str> = title
        .split('|')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if parts.len() >= 3 && is_mmdd_token(parts[0]) {
        format!("{}|{}", parts[1], parts[2..].join("|"))
    } else {
        title.to_string()
    }
}

/// 已占用的标题按「类型|主题」去重（日期不同仍算重复）。
pub(crate) fn uniquify_session_title(title: &str, taken: &[String]) -> String {
    let title = title.trim();
    if title.is_empty() {
        return title.to_string();
    }
    let taken_keys: std::collections::HashSet<String> =
        taken.iter().map(|s| title_identity_key(s)).collect();
    let taken_exact: std::collections::HashSet<&str> = taken
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if !taken_exact.contains(title) && !taken_keys.contains(&title_identity_key(title)) {
        return title.to_string();
    }
    for n in 2..30 {
        let candidate = format!("{title}·{n}");
        if !taken_exact.contains(candidate.as_str())
            && !taken_keys.contains(&title_identity_key(&candidate))
        {
            return candidate;
        }
    }
    title.to_string()
}

fn mesa_auto_title_ready(title: &str, taken: &[String]) -> bool {
    parse_kind_theme(title).is_some() && uniquify_session_title(title, taken) == title
}

fn auto_title_session_impl(
    profiles: Vec<Profile>,
    agent: &str,
    session_id: &str,
    file_path: &str,
    created_at: Option<&str>,
    early: bool,
    occupied: Option<&[String]>,
) -> Result<Option<String>, String> {
    if crate::sessions::session_marked_internal(agent, session_id) {
        return Ok(None);
    }
    let msgs = crate::sessions::conversation_impl(agent, file_path);
    if conversation_too_thin(&msgs) {
        return Ok(None);
    }
    let mmdd = created_at.and_then(shanghai_mmdd).or_else(|| {
        first_message_timestamp(&msgs)
            .as_deref()
            .and_then(shanghai_mmdd)
    });
    let Some(mmdd) = mmdd else {
        return Ok(None);
    };
    let material = user_title_material(&msgs, early);
    if material.trim().is_empty() {
        return Ok(None);
    }
    let owned = occupied
        .map(|t| t.to_vec())
        .unwrap_or_else(|| crate::sessions::list_custom_titles_except(agent, session_id));
    let raw = match ai_prompt_impl(
        profiles,
        None,
        Some(FN_SUMMARIZE),
        build_session_title_prompt(&material, &mmdd, early, &owned),
    ) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let Some(line) = extract_title_candidate(&raw) else {
        return Ok(None);
    };
    let Some((kind, theme)) = parse_kind_theme(&line) else {
        return Ok(None);
    };
    let title = crate::sessions::redact_sensitive_text(&format!("{mmdd}|{kind}|{theme}"));
    let title = uniquify_session_title(&title, &owned);
    if !crate::sessions::try_set_custom_title(agent, session_id, &title)? {
        return Ok(None);
    }
    Ok(Some(title))
}

// ===== Tauri commands =====

/// 「✦ 沉淀为技能」的草稿：name/description 进 SKILL.md frontmatter，content 为正文规则清单
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SkillDraftDto {
    pub name: String,
    pub description: String,
    pub content: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictAdviceDto {
    pub path: String,
    /// "ours"（选分支侧）| "theirs"（选 base 侧）| "manual"（建议人工逐行合并）
    pub choice: String,
    pub reason: String,
}

/// 无头一次性 prompt（供前端调试与未来功能复用）；fn_key = 功能 key（见 FN_* 常量），None 走全局默认
#[tauri::command]
pub async fn ai_prompt(
    store: tauri::State<'_, ProfileStore>,
    profile_id: Option<String>,
    fn_key: Option<String>,
    prompt: String,
) -> Result<String, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        ai_prompt_impl(profiles, profile_id, fn_key.as_deref(), prompt)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 「◈ 提交信息」生成；style = 状态栏分割菜单的风格偏好（None = 默认 conventional commits）
#[tauri::command]
pub async fn ai_commit_message(
    store: tauri::State<'_, ProfileStore>,
    cwd: String,
    paths: Option<Vec<String>>,
    style: Option<String>,
) -> Result<String, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = crate::sessions::expand_tilde(&cwd);
        let (status, numstat, diff) = collect_commit_material(&cwd, paths.as_deref())?;
        // 出站前脱敏（与会话摘要同一约束）：diff 可能含误提交的 .env / 粘进代码的密钥
        let status = crate::sessions::redact_sensitive_text(&status);
        let numstat = crate::sessions::redact_sensitive_text(&numstat);
        let diff = crate::sessions::redact_sensitive_text(&diff);
        ai_prompt_impl(
            profiles,
            None,
            Some(FN_COMMIT),
            build_commit_prompt(&status, &numstat, &diff, style.as_deref()),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_summarize_session(
    store: tauri::State<'_, ProfileStore>,
    agent: String,
    session_id: String,
    file_path: String,
) -> Result<String, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let msgs = crate::sessions::conversation_impl(&agent, &file_path);
        let text = conversation_text(&msgs);
        if text.trim().is_empty() {
            return Err("会话内容为空，无法概括".into());
        }
        let summary = ai_prompt_impl(
            profiles,
            None,
            Some(FN_SUMMARIZE),
            build_summary_prompt(&cap_text_middle(&text, DIFF_CAP)),
        )?;
        let summary = crate::sessions::redact_sensitive_text(&summary);
        crate::sessions::set_session_summary(&agent, &session_id, &summary)?;
        Ok(summary)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 自动起名：`stage=early` 只用首条用户问题；默认/final 用用户侧首条+纠正+定题。
/// 人手改过的标题、内部会话、内容不足或没有创建日则跳过。
/// 设置页「会话自动命名」关掉时直接返回 None（前端也跳过调用，这里是最终闸门）。
#[tauri::command]
pub async fn ai_auto_title_session(
    store: tauri::State<'_, ProfileStore>,
    agent: String,
    session_id: String,
    file_path: String,
    created_at: Option<String>,
    stage: Option<String>,
) -> Result<Option<String>, String> {
    if !crate::settings::auto_title_sessions_enabled() {
        return Ok(None);
    }
    let profiles = store.list()?;
    let early = stage.as_deref() == Some("early");
    tauri::async_runtime::spawn_blocking(move || {
        auto_title_session_impl(
            profiles,
            &agent,
            &session_id,
            &file_path,
            created_at.as_deref(),
            early,
            None,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetitleAllResultDto {
    pub renamed: u32,
    pub skipped: u32,
    pub failed: u32,
}

/// 按新规则重写所有非手改标题：过短、空泛、缺 Mesa 标题、或与已有标题撞车。
/// 人手改过的（title_source=user / 旧数据已有自定义标题）不覆盖；不写回 CLI 源文件。
/// 「会话自动命名」关掉时同样跳过——这条虽是批量命令，但唯一触发点是打开对话页的
/// 自动补名，没有手动入口，关了开关还改标题就是「关不掉」。
#[tauri::command]
pub async fn ai_retitle_all_sessions(
    store: tauri::State<'_, ProfileStore>,
) -> Result<RetitleAllResultDto, String> {
    if !crate::settings::auto_title_sessions_enabled() {
        return Ok(RetitleAllResultDto { renamed: 0, skipped: 0, failed: 0 });
    }
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        retitle_all_sessions_impl(profiles, &crate::settings::auto_title_sessions_enabled)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn retitle_all_sessions_impl(
    profiles: Vec<Profile>,
    gate: &dyn Fn() -> bool,
) -> Result<RetitleAllResultDto, String> {
    // 入口复查（命令入口查过一次；收进 impl 是为了让关停语义可单测）
    if !gate() {
        return Ok(RetitleAllResultDto { renamed: 0, skipped: 0, failed: 0 });
    }
    let mut sessions = crate::sessions::list_sessions_sync();
    sessions.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    let mut taken: Vec<String> = Vec::new();
    let mut pending = Vec::new();
    for s in sessions {
        if crate::sessions::session_title_is_user_owned(&s.agent, &s.session_id) {
            if let Some(t) = s
                .custom_title
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
            {
                taken.push(t.to_string());
            }
            continue;
        }
        pending.push(s);
    }

    let mut renamed = 0u32;
    let mut skipped = 0u32;
    let mut failed = 0u32;
    for s in pending {
        // 批量可跑几十秒到几分钟：用户中途在设置页关掉开关，下一轮就停，
        // 不再有新标题落盘（评审确认的「关不掉」窗口）
        if !gate() {
            break;
        }
        if s.internal || !s.alive || s.file_path.trim().is_empty() {
            if let Some(t) = s
                .custom_title
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
            {
                taken.push(t.to_string());
            }
            skipped += 1;
            continue;
        }
        let current = s
            .custom_title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string);
        if let Some(cur) = current.as_deref() {
            if mesa_auto_title_ready(cur, &taken) {
                taken.push(cur.to_string());
                skipped += 1;
                continue;
            }
        }
        match auto_title_session_impl(
            profiles.clone(),
            &s.agent,
            &s.session_id,
            &s.file_path,
            s.created_at.as_deref(),
            false,
            Some(&taken),
        ) {
            Ok(Some(title)) => {
                taken.push(title);
                renamed += 1;
            }
            Ok(None) => {
                if let Some(cur) = current.as_deref() {
                    let unique = uniquify_session_title(cur, &taken);
                    if unique != cur
                        && crate::sessions::try_set_custom_title(&s.agent, &s.session_id, &unique)
                            .unwrap_or(false)
                    {
                        taken.push(unique);
                        renamed += 1;
                        continue;
                    }
                }
                skipped += 1;
            }
            Err(_) => failed += 1,
        }
    }
    Ok(RetitleAllResultDto {
        renamed,
        skipped,
        failed,
    })
}

#[tauri::command]
pub async fn ai_draft_pr(
    store: tauri::State<'_, ProfileStore>,
    id: String,
) -> Result<String, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::workspaces::db()?;
        let w = crate::workspaces::get_workspace(&conn, &id)?;
        let wt = PathBuf::from(&w.worktree_path);
        let base = crate::workspaces::base_ref(&wt, &w.base_branch);
        let log = crate::workspaces::run_git(
            &wt,
            &["log", "--oneline", &format!("{base}..HEAD"), "-50"],
            Duration::from_secs(30),
        )?;
        if log.trim().is_empty() {
            return Err("分支上还没有提交，先提交再起草 PR".into());
        }
        let mb = crate::workspaces::run_git(
            &wt,
            &["merge-base", &base, "HEAD"],
            Duration::from_secs(30),
        )?;
        let numstat = crate::workspaces::run_git(
            &wt,
            &["diff", "--numstat", &format!("{mb}..HEAD")],
            Duration::from_secs(30),
        )
        .unwrap_or_default();
        ai_prompt_impl(profiles, None, Some(FN_PR), build_pr_prompt(&log, &numstat))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 评审「沉淀到下一步」的 AI 起草：本步提交清单 + diff 统计 + TASK.md（读不到则省略）→ 初稿文本。
/// 功能键复用 FN_DIGEST（同属「蒸馏简报」场景，不新增设置项）；输出脱敏后返回，
/// 落盘由前端走 append_step_draft 写进下一步任务书草稿（.ccode/drafts/）。
#[tauri::command]
pub async fn ai_distill_review(
    store: tauri::State<'_, ProfileStore>,
    id: String,
    step_name: String,
) -> Result<String, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::workspaces::db()?;
        let w = crate::workspaces::get_workspace(&conn, &id)?;
        let wt = PathBuf::from(&w.worktree_path);
        // 保存进项目后，工作区 HEAD 已经等于主分支，base..HEAD 是空的。
        // 这一步的提交在主仓里，用分支名找第二父提交是本步的那些。
        let repo = PathBuf::from(&w.repo_path);
        let saved = w.merged_at.is_some();
        let git_root = if saved { repo.as_path() } else { wt.as_path() };
        // 保存记录的标题是 Merge commit，不含分支名。用本步 HEAD 当第二父提交去找。
        let saved_tip = if saved {
            crate::workspaces::run_git(&wt, &["rev-parse", "HEAD"], Duration::from_secs(15))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        } else {
            None
        };
        let log = if let Some(tip) = saved_tip.as_deref() {
            let found = crate::workspaces::run_git(
                git_root,
                &["log", "--first-parent", "--format=%H %P", "-80", "HEAD"],
                Duration::from_secs(30),
            )?;
            let short = &tip[..tip.len().min(12)];
            let hit = found.lines().find(|line| line.split_whitespace().nth(2) == Some(tip) || line.contains(short));
            match hit.and_then(|line| line.split_whitespace().next()) {
                Some(hash) => crate::workspaces::run_git(
                    git_root,
                    &["log", "--oneline", "-1", hash],
                    Duration::from_secs(15),
                )?,
                None => crate::workspaces::run_git(
                    &wt,
                    &["log", "--oneline", "-20", "HEAD"],
                    Duration::from_secs(30),
                )?,
            }
        } else if saved {
            crate::workspaces::run_git(
                git_root,
                &["log", "--oneline", "-50", "--grep", w.branch.as_str()],
                Duration::from_secs(30),
            )?
        } else {
            let base = crate::workspaces::base_ref(&wt, &w.base_branch);
            let range = format!("{base}..HEAD");
            crate::workspaces::run_git(
                git_root,
                &["log", "--oneline", &range, "-50"],
                Duration::from_secs(30),
            )?
        };
        if log.trim().is_empty() {
            return Err(if saved {
                "这一步保存进项目的提交没找到，先手写沉淀".into()
            } else {
                "分支上还没有提交，无法起草沉淀".into()
            });
        }
        let numstat = if saved {
            let hashes = if let Some(tip) = saved_tip.as_deref() {
                tip.to_string()
            } else {
                crate::workspaces::run_git(
                    git_root,
                    &["log", "--format=%H", "-20", "--grep", w.branch.as_str()],
                    Duration::from_secs(30),
                )
                .unwrap_or_default()
            };
            hashes
                .lines()
                .filter(|line| !line.trim().is_empty())
                .take(8)
                .filter_map(|hash| {
                    crate::workspaces::run_git(
                        git_root,
                        &["show", "--numstat", "--format=", hash.trim()],
                        Duration::from_secs(30),
                    )
                    .ok()
                })
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            let base = crate::workspaces::base_ref(&wt, &w.base_branch);
            let mb = crate::workspaces::run_git(
                &wt,
                &["merge-base", &base, "HEAD"],
                Duration::from_secs(30),
            )?;
            crate::workspaces::run_git(
                &wt,
                &["diff", "--numstat", &format!("{mb}..HEAD")],
                Duration::from_secs(30),
            )
            .unwrap_or_default()
        };
        // TASK.md 是开步脚手架（不进 git），读不到不阻断起草。
        // 产物以保存后的项目根为准；还没保存时读工作树。
        let material_root = if saved { repo.as_path() } else { wt.as_path() };
        let task_brief = fs::read_to_string(wt.join("TASK.md")).unwrap_or_default();
        let cfg = crate::projects::read_config_at(&repo).config;
        let current_step = cfg.steps.iter().find(|s| s.workspace_name == w.name);
        let next_step = cfg.steps.iter().find(|s| s.name == step_name);
        let next_rel = next_step
            .map(|s| crate::projects::draft_rel_path(&s.name, &s.workspace_name))
            .unwrap_or_default();
        let next_task = if next_rel.is_empty() {
            String::new()
        } else {
            fs::read_to_string(repo.join(&next_rel)).unwrap_or_default()
        };
        let deliverables = read_step_deliverable_text(
            material_root,
            current_step.map(|s| s.expected_artifacts.as_slice()).unwrap_or(&[]),
        );
        let review_notes = fs::read_to_string(wt.join(".ccode/review-notes.md"))
            .or_else(|_| fs::read_to_string(repo.join(".ccode/review-notes.md")))
            .unwrap_or_default();
        let raw = ai_prompt_impl(
            profiles,
            None,
            Some(FN_DIGEST),
            build_review_distill_prompt(
                &step_name,
                &task_brief,
                &next_task,
                &deliverables,
                &review_notes,
                &log,
                &numstat,
            ),
        )?;
        let redacted = crate::sessions::redact_sensitive_text(&raw);
        if review_distill_is_empty(&redacted) {
            Ok(String::new())
        } else {
            Ok(redacted)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 选段「✦ 沉淀为技能」：把交互摘录提炼成技能草稿（前端预填新建技能 modal，保存仍走 create_skill）
#[tauri::command]
pub async fn ai_distill_skill(
    store: tauri::State<'_, ProfileStore>,
    excerpt: String,
) -> Result<SkillDraftDto, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        // 出站前脱敏（与会话摘要同一约束）：选段可能粘到完整密钥
        let excerpt = crate::sessions::redact_sensitive_text(&excerpt);
        if excerpt.trim().is_empty() {
            return Err("选段为空，无法提炼".into());
        }
        let raw = ai_prompt_impl(
            profiles,
            None,
            Some(FN_DISTILL),
            build_distill_skill_prompt(&cap_text_middle(&excerpt, DIFF_CAP)),
        )?;
        parse_skill_draft(&raw)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// AI 冲突审查：读取工作区里待解决的冲突文件，逐个给出选侧建议 + 理由
#[tauri::command]
pub async fn ai_conflict_advice(
    store: tauri::State<'_, ProfileStore>,
    id: String,
) -> Result<Vec<ConflictAdviceDto>, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::workspaces::db()?;
        let w = crate::workspaces::get_workspace(&conn, &id)?;
        let wt = PathBuf::from(&w.worktree_path);
        let unmerged = crate::workspaces::run_git(
            &wt,
            &["diff", "--name-only", "--diff-filter=U"],
            Duration::from_secs(10),
        )?;
        let files: Vec<String> = unmerged
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect();
        if files.is_empty() {
            return Err("没有待解决的冲突文件（先「并入主分支」产生冲突后再来）".into());
        }
        let mut contents = Vec::new();
        for f in &files {
            // 删/改冲突（一侧已删除）时工作区里文件不存在，直读会 os error 2：
            // 回落到索引两侧（:2 工作区分支 / :3 基准分支）拼内容供 AI 判读
            let text = match fs::read_to_string(wt.join(f)) {
                Ok(t) => t,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    let ours =
                        crate::workspaces::run_git_raw(&wt, &["show", &format!(":2:{f}")]).ok();
                    let theirs =
                        crate::workspaces::run_git_raw(&wt, &["show", &format!(":3:{f}")]).ok();
                    match (ours, theirs) {
                        (Some(o), Some(t)) => format!(
                            "<<<<<<< {}（工作区侧）\n{o}\n=======\n{t}\n>>>>>>> {}（基准侧）\n",
                            w.branch, w.base_branch
                        ),
                        (Some(o), None) => format!(
                            "（本文件在基准侧「{}」已删除；以下为工作区侧「{}」内容）\n{o}",
                            w.base_branch, w.branch
                        ),
                        (None, Some(t)) => format!(
                            "（本文件在工作区侧「{}」已删除；以下为基准侧「{}」内容）\n{t}",
                            w.branch, w.base_branch
                        ),
                        (None, None) => {
                            return Err(format!(
                                "读取 {f} 失败: 工作区与索引两侧均无内容（os error 2）"
                            ))
                        }
                    }
                }
                Err(e) => return Err(format!("读取 {f} 失败: {e}")),
            };
            contents.push((f.clone(), text));
        }
        let raw = ai_prompt_impl(
            profiles,
            None,
            Some(FN_CONFLICT),
            build_conflict_prompt(&w.branch, &w.base_branch, &contents),
        )?;
        Ok(parse_conflict_advice(&raw, &files))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{AccountType, Profile};

    fn profile(id: &str, agent: &str, last_used_at: Option<&str>) -> Profile {
        Profile {
            id: id.into(),
            agent: agent.into(),
            name: id.into(),
            account_type: Default::default(),
            no_auth: false,
            protocol: None,
            api_backend: None,
            base_url: None,
            models: vec![],
            role_models: Default::default(),
            extra_env: std::collections::HashMap::new(),
            request_policy: crate::profiles::RequestPolicy::default(),
            key_hint: None,
            model: None,
            has_key: false,
            last_used_at: last_used_at.map(String::from),
            gateway_id: None,
            slot_missing: false,
            connection_status: String::new(),
            model_sync_status: String::new(),
            model_sync_note: None,
            provider_override: None,
        }
    }

    #[test]
    fn retitle_all_stops_immediately_when_gate_closed() {
        // 「会话自动命名」关掉时补名批全停。闸门收进 impl 入口正是为了这条测试：
        // 删掉它，「关掉开关」会静默退化回关不掉，而其余测试照样全绿。
        // 闸门关 = 不扫会话文件、不发起任何 AI 调用，直接全零返回。
        let r = retitle_all_sessions_impl(Vec::new(), &|| false).unwrap();
        assert_eq!(r.renamed, 0);
        assert_eq!(r.skipped, 0);
        assert_eq!(r.failed, 0);
    }

    #[test]
    fn headless_credentials_require_key_unless_explicitly_exempt() {
        let mut p = profile("api", "codex", None);
        assert!(agents::ensure_launch_credentials(&p, None).is_err());
        assert!(agents::ensure_launch_credentials(&p, Some(" ")).is_err());
        assert!(agents::ensure_launch_credentials(&p, Some("synthetic-test-key")).is_ok());
        p.no_auth = true;
        assert!(agents::ensure_launch_credentials(&p, None).is_ok());
        p.no_auth = false;
        p.account_type = AccountType::Official;
        assert!(agents::ensure_launch_credentials(&p, None).is_ok());
    }

    #[test]
    fn profile_resolution_prefers_last_used() {
        let profiles = vec![
            profile("a", "codex", Some("2026-07-01T00:00:00Z")),
            profile("b", "claude-code", Some("2026-07-30T00:00:00Z")),
            profile("c", "gemini", None),
        ];
        let no_hidden = &Default::default();
        // 显式 id 优先
        let p = resolve_profile_from(profiles.clone(), Some("a".into()), None, None, no_hidden)
            .unwrap();
        assert_eq!(p.id, "a");
        // 否则 last_used_at 最新者；None 排最后
        let p = resolve_profile_from(profiles.clone(), None, None, None, no_hidden).unwrap();
        assert_eq!(p.id, "b");
        // 全都没用过：取其一（max_by 的稳定首个），不报错
        let fresh = vec![profile("x", "codex", None), profile("y", "gemini", None)];
        assert!(resolve_profile_from(fresh, None, None, None, no_hidden).is_ok());
        // 空列表报错
        let err = resolve_profile_from(vec![], None, None, None, no_hidden).unwrap_err();
        assert!(err.contains("请先在配置页创建并保存一个 profile"), "{err}");
        // 不存在的 id 报错
        assert!(resolve_profile_from(profiles, Some("zzz".into()), None, None, no_hidden).is_err());
    }

    #[test]
    fn profile_resolution_dedicated_beats_last_used_but_not_explicit() {
        let profiles = vec![
            profile("a", "codex", Some("2026-07-01T00:00:00Z")),
            profile("b", "claude-code", Some("2026-07-30T00:00:00Z")),
        ];
        let no_hidden = &Default::default();
        // 设置页专用 profile 盖过最近使用
        let p = resolve_profile_from(profiles.clone(), None, None, Some("a".into()), no_hidden)
            .unwrap();
        assert_eq!(p.id, "a");
        // 显式 id 仍最优先
        let p = resolve_profile_from(
            profiles.clone(),
            Some("b".into()),
            None,
            Some("a".into()),
            no_hidden,
        )
        .unwrap();
        assert_eq!(p.id, "b");
        // 专用 id 已被删除：明确报错（提示去设置页重选），不静默回落
        let err =
            resolve_profile_from(profiles, None, None, Some("gone".into()), no_hidden).unwrap_err();
        assert!(err.contains("profile 不存在"), "{err}");
    }

    #[test]
    fn profile_resolution_fn_specific_beats_dedicated_but_not_explicit() {
        let profiles = vec![
            profile("a", "codex", Some("2026-07-01T00:00:00Z")),
            profile("b", "claude-code", Some("2026-07-30T00:00:00Z")),
        ];
        let no_hidden = &Default::default();
        // 功能专属盖过全局专用
        let p = resolve_profile_from(
            profiles.clone(),
            None,
            Some("b".into()),
            Some("a".into()),
            no_hidden,
        )
        .unwrap();
        assert_eq!(p.id, "b");
        // 显式 id 仍最优先
        let p = resolve_profile_from(
            profiles.clone(),
            Some("a".into()),
            Some("b".into()),
            None,
            no_hidden,
        )
        .unwrap();
        assert_eq!(p.id, "a");
        // 功能专属 id 已失效（被删）：视为不存在，回落全局专用
        let p = resolve_profile_from(
            profiles.clone(),
            None,
            Some("gone".into()),
            Some("a".into()),
            no_hidden,
        )
        .unwrap();
        assert_eq!(p.id, "a");
        // 功能专属与全局都失效：继续回落最近使用（不报错）
        let p = resolve_profile_from(profiles, None, Some("gone".into()), None, no_hidden).unwrap();
        assert_eq!(p.id, "b");
    }

    #[test]
    fn profile_resolution_hidden_skipped_in_last_used_fallback() {
        let profiles = vec![
            profile("a", "codex", Some("2026-07-01T00:00:00Z")),
            profile("b", "claude-code", Some("2026-07-30T00:00:00Z")),
        ];
        let hidden: std::collections::HashSet<String> = ["b".to_string()].into_iter().collect();
        // 软停用只作用于「最近使用」自动回落：b 更新但被停用 → 挑 a
        let p = resolve_profile_from(profiles.clone(), None, None, None, &hidden).unwrap();
        assert_eq!(p.id, "a");
        // 显式/专属槽是用户显式绑定，停用项照常尊重
        let p =
            resolve_profile_from(profiles.clone(), Some("b".into()), None, None, &hidden).unwrap();
        assert_eq!(p.id, "b");
        let p =
            resolve_profile_from(profiles.clone(), None, Some("b".into()), None, &hidden).unwrap();
        assert_eq!(p.id, "b");
        // 全部被停用：回落含停用项，不报错哑掉
        let all_hidden: std::collections::HashSet<String> =
            ["a".to_string(), "b".to_string()].into_iter().collect();
        let p = resolve_profile_from(profiles, None, None, None, &all_hidden).unwrap();
        assert_eq!(p.id, "b");
    }

    #[test]
    fn listed_model_prefers_the_slot_that_actually_resolved() {
        let models = vec!["glm-5.3".into(), "glm-5.3-flashx".into()];
        assert_eq!(
            pick_listed_model(&models, Some("glm-5.3-flashx")).as_deref(),
            Some("glm-5.3-flashx")
        );
        assert_eq!(
            pick_listed_model(&models, Some("missing")).as_deref(),
            Some("glm-5.3"),
            "选中的模型已从配置里拿掉时回落第一个"
        );
        assert_eq!(pick_listed_model(&models, None).as_deref(), Some("glm-5.3"));
        // 功能专属命中：用功能自己的模型，不用全局专用的
        assert_eq!(
            preferred_ai_model("p", None, Some("p"), Some("flash"), Some("p"), Some("big")),
            Some("flash")
        );
        // 功能没单独选：落到全局专用，用专用模型
        assert_eq!(
            preferred_ai_model("p", None, None, None, Some("p"), Some("flash")),
            Some("flash")
        );
        // 调用方显式指定配置时不套设置里的模型
        assert_eq!(
            preferred_ai_model("p", Some("p"), None, None, Some("p"), Some("flash")),
            None
        );
        // 最近使用回落：没有记下的模型
        assert_eq!(
            preferred_ai_model(
                "other",
                None,
                Some("gone"),
                Some("flash"),
                Some("p"),
                Some("big")
            ),
            None
        );
    }

    #[test]
    fn profile_resolution_last_used_skips_official_when_api_exists() {
        let mut official = profile("off", "codex", Some("2026-09-03T08:00:00Z"));
        official.account_type = AccountType::Official;
        let api = profile("api", "codex", Some("2026-08-01T00:00:00Z"));
        let profiles = vec![official.clone(), api];
        let no_hidden = &Default::default();
        // 官方更新，但无头自动回落跳过它，改走带密钥的 API 配置
        let p = resolve_profile_from(profiles.clone(), None, None, None, no_hidden).unwrap();
        assert_eq!(p.id, "api");
        // 显式/专用仍尊重官方
        let p = resolve_profile_from(profiles.clone(), Some("off".into()), None, None, no_hidden)
            .unwrap();
        assert_eq!(p.id, "off");
        let p = resolve_profile_from(profiles, None, None, Some("off".into()), no_hidden).unwrap();
        assert_eq!(p.id, "off");
        // 只有官方时才回落官方（好过报错哑掉）
        let only = vec![official];
        let p = resolve_profile_from(only, None, None, None, no_hidden).unwrap();
        assert_eq!(p.id, "off");
    }

    #[test]
    fn strip_known_cli_noise_removes_unrecognized_model_warning() {
        // claude-code ≥2.1.285 对网关模型（glm-* 等）在 -p 查询前打的良性 warn：
        // 整行过滤，其余行原样保留（含前导空格的变体也滤）
        let raw = "Warning: something else\n[claude-code:unrecognized_model] {\"model\":\"glm-5.3\",\"query_source\":\"sdk\"}\n实际输出文本";
        let stripped = strip_known_cli_noise(raw);
        assert!(!stripped.contains("unrecognized_model"), "{stripped}");
        assert!(stripped.contains("Warning: something else"), "{stripped}");
        assert!(stripped.contains("实际输出文本"), "{stripped}");
        assert_eq!(strip_known_cli_noise("  [claude-code:unrecognized_model] x\nok"), "ok");
        assert_eq!(strip_known_cli_noise("干净输出"), "干净输出");
    }

    #[test]
    fn summarize_headless_error_collapses_codex_oauth_dump() {
        let dump = r#"Reading additional input from stdin...
2026-09-03T08:51:28.634104Z ERROR codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized: Encountered invalidated oauth token for user, failing request, url: https://chatgpt.com/backend-api/codex/models?client_version=0.153.0, auth error code: token_revoked
ERROR: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again."#;
        let msg = summarize_headless_error(dump, None);
        assert!(msg.contains("官方账号登录已失效"), "{msg}");
        assert!(!msg.contains("Reading additional input"), "{msg}");
        assert!(!msg.contains("chatgpt.com/backend-api"), "{msg}");
        assert!(msg.chars().count() < 80, "{msg}");
        // 普通 ERROR 行只留最后一句，不甩整段
        let other = "INFO start\nERROR: model not found\nERROR: rate limited";
        assert_eq!(summarize_headless_error(other, None), "rate limited");
    }

    #[test]
    fn summarize_headless_error_distinguishes_401_routing_from_bad_key() {
        // 用户真实报错：网关 key 被发到 api.openai.com（model_provider 未指向自定义渠道）
        let routed_wrong =
            "unexpected status 401 Unauthorized: Incorrect API key provided: sk-ab***. \
            url: https://api.openai.com/v1/responses, auth error code: invalid_api_key";
        let msg = summarize_headless_error(routed_wrong, Some("ent.zetatechs.com"));
        assert!(msg.contains("OpenAI 官方端点"), "{msg}");
        assert!(msg.contains("ent.zetatechs.com"), "{msg}");
        assert!(msg.contains("设为全局默认"), "{msg}");
        // 不能被笼统归成官方账号登录失效
        assert!(!msg.contains("官方账号登录已失效"), "{msg}");
        // 报错 URL 是网关自己 = 密钥被拒，引导重填
        let bad_key = "unexpected status 401 Unauthorized: Incorrect API key provided, \
            url: https://ent.zetatechs.com/v1/responses, auth error code: invalid_api_key";
        let msg = summarize_headless_error(bad_key, Some("ent.zetatechs.com"));
        assert!(msg.contains("拒绝了密钥"), "{msg}");
        assert!(msg.contains("重新填写密钥"), "{msg}");
        // 无网关上下文（官方端点 / 官方 key 场景）
        let msg = summarize_headless_error(routed_wrong, None);
        assert!(msg.contains("OpenAI 官方端点拒绝了密钥"), "{msg}");
        // 网关地址本身就是 openai 官方（直连官方 API）时按官方密钥口径
        let msg = summarize_headless_error(routed_wrong, Some("api.openai.com"));
        assert!(msg.contains("OpenAI 官方端点拒绝了密钥"), "{msg}");
        // token_revoked 优先级不变
        let revoked = "401 Unauthorized token_revoked";
        assert!(summarize_headless_error(revoked, Some("ent.zetatechs.com"))
            .contains("官方账号登录已失效"));
    }

    #[test]
    fn endpoint_host_parses_base_url() {
        assert_eq!(
            endpoint_host(Some("https://ent.zetatechs.com/v1")).as_deref(),
            Some("ent.zetatechs.com")
        );
        assert_eq!(
            endpoint_host(Some("http://127.0.0.1:8317")).as_deref(),
            Some("127.0.0.1:8317")
        );
        assert_eq!(endpoint_host(Some("  ")), None);
        assert_eq!(endpoint_host(None), None);
    }

    #[test]
    fn extract_headless_session_id_from_codex_banner() {
        let dump = "OpenAI Codex v0.153.0\n--------\nworkdir: /tmp/x\nsession id: 01a06677-48fa-7991-b99d-cdfd5d7f6fd4\n--------\nuser\n请用中文解读";
        assert_eq!(
            extract_headless_session_id(dump).as_deref(),
            Some("01a06677-48fa-7991-b99d-cdfd5d7f6fd4")
        );
        assert_eq!(extract_headless_session_id("no session here"), None);
        assert_eq!(
            extract_headless_session_id("Session ID: abcdef12-3456-7890-abcd-ef1234567890 extra")
                .as_deref(),
            Some("abcdef12-3456-7890-abcd-ef1234567890")
        );
    }

    #[test]
    fn oneshot_args_are_ephemeral_only_for_claude_and_codex() {
        let claude = headless_oneshot_args("claude-code", "你好");
        assert!(claude.contains(&"--no-session-persistence".to_string()));
        assert!(claude.windows(2).any(|w| w == ["--output-format", "json"]));
        let codex = headless_oneshot_args("codex", "你好");
        assert_eq!(&codex[..2], &["exec", "--skip-git-repo-check"], "compose_headless_args 依赖前两项");
        assert!(codex.contains(&"--ephemeral".to_string()) && codex.contains(&"--json".to_string()));
        assert_eq!(headless_oneshot_args("kimi", "你好"), headless_args("kimi", "你好"));
        // 定时任务不受影响：巡检运行事后要能回看
        assert!(!headless_task_args("claude-code", "你好").contains(&"--no-session-persistence".to_string()));
        assert!(!headless_task_args("codex", "你好").contains(&"--ephemeral".to_string()));
    }

    #[test]
    fn parse_oneshot_claude_json() {
        // 2026-10-17 本机实录形态（字段裁剪）
        let ok = r#"{"type":"result","is_error":false,"result":"  好的 ","usage":{"input_tokens":5,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"modelUsage":{"glm-5.3":{"inputTokens":120,"outputTokens":8,"cacheReadInputTokens":30,"cacheCreationInputTokens":4}}}"#;
        let (text, ev) = parse_oneshot_output("claude-code", ok, Some("glm-5.3"), "2026-10-17").unwrap();
        assert_eq!(text, "好的");
        assert_eq!(ev.len(), 1);
        assert_eq!((ev[0].model.as_str(), ev[0].input, ev[0].output, ev[0].cache_read, ev[0].cache_write), ("glm-5.3", 120, 8, 30, 4));
        assert_eq!(ev[0].day, "2026-10-17");
        // 没有 modelUsage 时用顶层 usage 记在所选模型上
        let flat = r#"{"type":"result","is_error":false,"result":"x","usage":{"input_tokens":5,"output_tokens":2}}"#;
        let (_, ev) = parse_oneshot_output("claude-code", flat, Some("m"), "d").unwrap();
        assert_eq!((ev[0].model.as_str(), ev[0].input, ev[0].output), ("m", 5, 2));
        // is_error：result 就是错误句（实录：未登录）
        let err = r#"{"type":"result","is_error":true,"result":"Not logged in · Please run /login","usage":{}}"#;
        assert_eq!(
            parse_oneshot_output("claude-code", err, None, "d").unwrap_err(),
            "Not logged in · Please run /login"
        );
    }

    #[test]
    fn parse_oneshot_codex_jsonl() {
        // 2026-10-17 本机实录：配置告警以 error item 出现，不影响正文
        let raw = r#"{"type":"thread.started","thread_id":"t"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Codex is ignoring 1 unrecognized configuration setting."}}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"好的"}}
{"type":"turn.completed","usage":{"input_tokens":20513,"cached_input_tokens":9088,"cache_write_input_tokens":0,"output_tokens":23,"reasoning_output_tokens":16}}"#;
        let (text, ev) = parse_oneshot_output("codex", raw, Some("gpt-5"), "2026-10-17").unwrap();
        assert_eq!(text, "好的");
        assert_eq!(
            (ev[0].input, ev[0].output, ev[0].cache_read),
            (11425, 23, 9088),
            "与 rollout 抽取同口径：输入拆掉缓存读，推理已含在输出里"
        );
        // 没有正文：拿最后一条告警/失败当原因
        let failed = r#"{"type":"turn.failed","error":{"message":"401 Unauthorized"}}"#;
        assert_eq!(parse_oneshot_output("codex", failed, None, "d").unwrap_err(), "401 Unauthorized");
    }

    #[test]
    fn headless_args_per_agent() {
        assert_eq!(
            headless_args("claude-code", "你好"),
            vec!["-p", "你好", "--output-format", "text"]
        );
        assert_eq!(
            headless_args("codex", "你好"),
            vec!["exec", "--skip-git-repo-check", "-s", "read-only", "你好"]
        );
        assert_eq!(headless_args("gemini", "你好"), vec!["-p", "你好"]);
        assert_eq!(headless_args("qwen", "你好"), vec!["你好"]);
        assert_eq!(headless_args("kimi", "你好"), vec!["-p", "你好"]);
        assert_eq!(headless_args("opencode", "你好"), vec!["run", "你好"]);
        assert_eq!(headless_args("codebuddy", "你好"), vec!["-p", "你好"]);
        assert_eq!(
            headless_args("cursor", "你好"),
            vec!["-p", "你好", "--output-format", "text"]
        );
    }

    #[test]
    fn codex_win_sandbox_override_goes_before_prompt() {
        let args = with_codex_win_sandbox(headless_task_args("codex", "你好"), Some("unelevated"));
        assert_eq!(args.last().map(String::as_str), Some("你好"), "提示词仍是最后一个参数");
        let n = args.len();
        assert_eq!(&args[n - 3..n - 1], ["-c", "windows.sandbox=\"unelevated\""]);
        assert_eq!(with_codex_win_sandbox(headless_task_args("codex", "你好"), None), headless_task_args("codex", "你好"));
        // 非 Windows / 非 Codex 一律不加
        assert_eq!(codex_win_sandbox_for_run("claude-code"), None);
        #[cfg(not(windows))]
        assert_eq!(codex_win_sandbox_for_run("codex"), None);
    }

    #[test]
    fn headless_task_args_codex_workspace_write_others_same() {
        // 定时任务要写项目文件（notes/inbox.md 等），codex 必须 workspace-write + 开网（巡检要联网）
        assert_eq!(
            headless_task_args("codex", "你好"),
            vec![
                "exec",
                "--skip-git-repo-check",
                "-s",
                "workspace-write",
                "-c",
                "sandbox_workspace_write.network_access=true",
                "你好"
            ]
        );
        // 其余 agent 与 headless_args 同形
        assert_eq!(
            headless_task_args("claude-code", "你好"),
            headless_args("claude-code", "你好")
        );
        assert_eq!(
            headless_task_args("kimi", "你好"),
            headless_args("kimi", "你好")
        );
        assert_eq!(
            headless_task_args("opencode", "你好"),
            headless_args("opencode", "你好")
        );
    }

    #[test]
    fn compose_headless_args_codex_puts_plan_args_after_exec() {
        // 回归锚点（实测 codex v0.148）：-c/-m 在 exec 前被顶层解析静默吞掉，
        // provider 回落桌面版 config.toml —— plan 参数必须跟在 exec 子命令头之后；
        // plan 默认带的 -s workspace-write 要剥离，由 headless 尾部的档位定夺（重复即报错）
        let plan = vec![
            "-c".to_string(),
            r#"model_provider="ccode""#.to_string(),
            "-m".to_string(),
            "m1".to_string(),
            "-s".to_string(),
            "workspace-write".to_string(),
        ];
        let out = compose_headless_args("codex", &plan, &headless_task_args("codex", "你好"));
        assert_eq!(
            out,
            vec![
                "exec",
                "--skip-git-repo-check",
                "-c",
                r#"model_provider="ccode""#,
                "-m",
                "m1",
                "-s",
                "workspace-write",
                "-c",
                "sandbox_workspace_write.network_access=true",
                "你好"
            ]
        );
        // 一次性 prompt 路径：沙箱档 = read-only（plan 的 workspace-write 不重复出现）
        let out_ro = compose_headless_args("codex", &plan, &headless_args("codex", "你好"));
        assert_eq!(
            out_ro,
            vec![
                "exec",
                "--skip-git-repo-check",
                "-c",
                r#"model_provider="ccode""#,
                "-m",
                "m1",
                "-s",
                "read-only",
                "你好"
            ]
        );
        // 其余 agent：plan 在前、无头参数在后（无子命令，旧顺序不变）
        let out2 = compose_headless_args("kimi", &plan, &headless_task_args("kimi", "你好"));
        assert_eq!(
            out2,
            vec![
                "-c",
                r#"model_provider="ccode""#,
                "-m",
                "m1",
                "-s",
                "workspace-write",
                "-p",
                "你好"
            ]
        );
    }

    #[test]
    fn cap_text_respects_boundaries_and_lines() {
        let short = "abc";
        assert_eq!(cap_text(short, 100), "abc");
        // 多字节字符边界：上限落在「中」中间时不炸、不断字
        let text = "中文行一\n中文行二\n中文行三\n";
        let capped = cap_text(text, 8);
        assert!(capped.ends_with("...（内容过长已截断）"));
        assert!(!capped.contains('\u{FFFD}'));
        // 换行处收：尽量保住整行
        let lines = "aaaa\nbbbb\ncccc\n";
        let capped = cap_text(lines, 9);
        assert!(capped.starts_with("aaaa\n"));
        // 中间挖空保留首尾
        let long = "首".repeat(3000) + &"中".repeat(3000) + &"尾".repeat(3000);
        let capped = cap_text_middle(&long, 2000);
        assert!(capped.contains("...（中间省略）..."));
        assert!(capped.starts_with('首'));
        assert!(capped.ends_with('尾'));
    }

    #[test]
    fn parse_skill_draft_extracts_json_and_normalizes() {
        // 裹了废话/markdown 的输出也能抠出 JSON；name 归一为小写
        let raw = "好的：\n```json\n{\"name\":\"Paper-Notes \",\"description\":\"整理论文笔记\",\"content\":\"# 规则\\n- 先摘要\"}\n```";
        let d = parse_skill_draft(raw).unwrap();
        assert_eq!(d.name, "paper-notes");
        assert_eq!(d.description, "整理论文笔记");
        assert!(d.content.starts_with("# 规则"));
        // 无 JSON / 缺字段都要报错（前端行内提示，不落半成品）
        assert!(parse_skill_draft("我不知道").is_err());
        assert!(
            parse_skill_draft("{\"name\":\"x\",\"description\":\"\",\"content\":\"\"}").is_err()
        );
    }

    #[test]
    fn parse_conflict_advice_extracts_json_and_falls_back() {
        let files = vec!["a.txt".to_string(), "b.txt".to_string()];
        // 裹了废话/markdown 的输出也能抠出 JSON
        let raw = "好的，分析如下：\n```json\n[{\"path\":\"a.txt\",\"choice\":\"ours\",\"reason\":\"分支侧更新\"}]\n```";
        let list = parse_conflict_advice(raw, &files);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].choice, "ours");
        // 无 JSON → 全部 manual 兜底
        let list = parse_conflict_advice("我不知道", &files);
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|a| a.choice == "manual"));
    }

    #[test]
    fn digest_prompt_has_sections_and_constraints() {
        let p = build_digest_prompt("[用户] 做一个提炼接力功能");
        for section in [
            "已完成并有依据的结论",
            "涉及的文件与路径",
            "已否决或明确不做的",
            "还没做完的",
            "下一步建议",
        ] {
            assert!(p.contains(section), "缺小节 {section}");
        }
        assert!(p.contains("不要改写"), "用户原话不得由模型改写");
        assert!(p.contains("不要复述工具调用"));
        assert!(p.contains("[用户] 做一个提炼接力功能"));
    }

    #[test]
    fn review_distill_prompt_asks_only_for_new_constraints() {
        let p = build_review_distill_prompt(
            "综述初稿",
            "# 综述大纲\n产出 outline.md",
            "# 综述初稿\n按 outline.md 写",
            "### outline.md\n核心只写镁负极",
            "- 「核心只写镁负极」（outline.md）：背景一句带过",
            "abc123 feat: 大纲",
            "228\t0\toutline.md",
        );
        assert!(p.contains("不要改回去的决定"));
        assert!(p.contains("还没由人确认"));
        assert!(p.contains("不要写成禁止"));
        assert!(p.contains("已经禁止的事"));
        assert!(p.contains("不必沉淀"));
        assert!(p.contains("下一步「综述初稿」"));
        assert!(p.contains("产出 outline.md"));
        assert!(p.contains("按 outline.md 写"));
        assert!(p.contains("核心只写镁负极"));
        assert!(p.contains("背景一句带过"));
        assert!(p.contains("abc123"));
        assert!(p.contains("不要编造"));
        let empty = build_review_distill_prompt("综述初稿", "", "", "", "", "abc123 x", "");
        assert!(empty.contains("未读到"));
        assert!(empty.contains("还没有正文"));
        let brief = distill_included_brief(
            "1. Alpha paper — Smith — 2020 — Nature\n2. Beta paper — Lee — 2021 — Science 待确认\n3. Gamma paper — Wu — 2022 — Cell\n",
        );
        assert!(brief.contains("共 3 条"));
        assert!(brief.contains("Alpha"));
        assert!(brief.contains("待确认"));
        assert!(review_distill_is_empty("不必沉淀。下一步任务书已经覆盖，按已验收产物做。"));
        assert!(review_distill_is_empty(
            "```\n不必沉淀。下一步任务书已经覆盖，按已验收产物做。\n```"
        ));
        assert!(!review_distill_is_empty("## 下一步还没有的约束\n- 可写正文键必须在证据表里"));
    }

    #[test]
    fn review_distill_reads_markdown_deliverables_only() {
        let root = std::env::temp_dir().join(format!(
            "ccode-distill-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("outline.md"), "核心只写镁负极").unwrap();
        fs::write(root.join("notes/a.md"), "笔记甲").unwrap();
        fs::write(root.join("notes/b.txt"), "不是 md").unwrap();
        fs::write(root.join("figure.pdf"), "%PDF").unwrap();
        let text = read_step_deliverable_text(
            &root,
            &[
                "outline.md".into(),
                "notes/".into(),
                "figure.pdf".into(),
                "../outside.md".into(),
            ],
        );
        assert!(text.contains("### outline.md"));
        assert!(text.contains("核心只写镁负极"));
        assert!(text.contains("### notes/a.md"));
        assert!(!text.contains("不是 md"));
        assert!(!text.contains("figure.pdf"));
        assert!(!text.contains("outside"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prompt_builders_contain_material_and_caps() {
        let diff = "line\n".repeat(3000); // ~15KB > 8KB 上限
        let p = build_commit_prompt(" M a.rs", "1\t0\ta.rs", &diff, None);
        assert!(p.contains("conventional commits"));
        assert!(p.contains(" M a.rs"));
        assert!(p.contains("...（内容过长已截断）"));
        assert!(p.len() < 12000, "prompt 必须被截断: {}", p.len());
        // 风格偏好附加进 prompt（状态栏分割菜单的 Customize Prompt）
        let p2 = build_commit_prompt(" M a.rs", "1\t0\ta.rs", "x", Some("全英文，带 emoji"));
        assert!(p2.contains("全英文，带 emoji"));
        assert!(!p.contains("风格偏好"));
        let s = build_summary_prompt("[用户] 修 bug");
        assert!(s.contains("3-5 行"));
        let pr = build_pr_prompt("abc123 feat: x", "5\t1\tsrc/a.rs");
        assert!(pr.contains("## 变更点"));
        assert!(pr.contains("不要编造"));
        let t = build_session_title_prompt("[用户·首条] 加预设", "0908", true, &[]);
        assert!(t.contains("类型|主题"));
        assert!(t.contains("0908"));
        assert!(t.contains("第一条真正的问题"));
        assert!(t.contains("[用户·首条] 加预设"));
        assert!(t.contains("8到28"));
        assert!(t.contains("对象+动作"));
        let t2 = build_session_title_prompt("[用户·定题] 改成雷达", "0908", false, &[]);
        assert!(t2.contains("不要参考助手回复"));
        assert!(!t2.contains("第一条真正的问题"));
        let t3 = build_session_title_prompt(
            "[用户·首条] 加预设",
            "0908",
            true,
            &["0908|功能|Grok继续链合并去重".into()],
        );
        assert!(t3.contains("已有标题"));
        assert!(t3.contains("Grok继续链合并去重"));
    }

    fn chat(role: &str, text: &str, ts: Option<&str>) -> crate::sessions::ChatMessageDto {
        crate::sessions::ChatMessageDto {
            role: role.into(),
            blocks: vec![crate::sessions::BlockDto {
                kind: "text".into(),
                text: text.into(),
                tool_name: None,
                is_error: false,
                call_id: None,
            }],
            timestamp: ts.map(String::from),
            usage: None,
            id: None,
        }
    }

    #[test]
    fn shanghai_mmdd_uses_create_date_not_utc_calendar_day() {
        assert_eq!(
            shanghai_mmdd("2026-09-08T16:30:00Z").as_deref(),
            Some("0909")
        );
        assert_eq!(
            shanghai_mmdd("2026-09-08T10:00:00+08:00").as_deref(),
            Some("0908")
        );
        let ts = chrono::DateTime::parse_from_rfc3339("2026-09-08T16:00:00Z")
            .unwrap()
            .timestamp()
            .to_string();
        assert_eq!(shanghai_mmdd(&ts).as_deref(), Some("0909"));
        assert_eq!(shanghai_mmdd(""), None);
        assert_eq!(shanghai_mmdd("not-a-date"), None);
    }

    #[test]
    fn parse_kind_theme_accepts_with_or_without_date() {
        assert_eq!(
            parse_kind_theme("修复|Grok继续链合并去重"),
            Some(("修复".into(), "Grok继续链合并去重".into()))
        );
        assert_eq!(
            parse_kind_theme("0908|优化|Agent 会话管理"),
            Some(("优化".into(), "Agent 会话管理".into()))
        );
        assert_eq!(
            parse_kind_theme("设计|目标卡与项目栏同底"),
            Some(("设计".into(), "目标卡与项目栏同底".into()))
        );
        assert!(parse_kind_theme("闲聊|随便说说").is_none());
        assert!(parse_kind_theme("修复|短").is_none());
        assert!(parse_kind_theme("修复|登录状态异常").is_none());
        assert!(parse_kind_theme(
            "修复|一二三四五六七八九十一二三四五六七八九十一二三四五六七八九"
        )
        .is_none());
        assert!(parse_kind_theme("hello|world").is_none());
        assert!(parse_kind_theme("功能|Blender 预设").is_none());
        assert_eq!(
            parse_kind_theme(
                &extract_title_candidate("```\n功能|Grok继续链合并去重\n```").unwrap()
            ),
            Some(("功能".into(), "Grok继续链合并去重".into()))
        );
        assert_eq!(
            parse_kind_theme(
                &extract_title_candidate(r#"{"text":"设计|目标卡与项目栏同底"}"#).unwrap()
            ),
            Some(("设计".into(), "目标卡与项目栏同底".into()))
        );
    }

    #[test]
    fn uniquify_session_title_collides_across_dates() {
        assert_eq!(
            uniquify_session_title("0908|修复|Grok继续链合并去重", &[]),
            "0908|修复|Grok继续链合并去重"
        );
        assert_eq!(
            uniquify_session_title(
                "0908|修复|Grok继续链合并去重",
                &["0908|修复|Grok继续链合并去重".into()]
            ),
            "0908|修复|Grok继续链合并去重·2"
        );
        assert_eq!(
            uniquify_session_title(
                "0909|修复|Grok继续链合并去重",
                &["0908|修复|Grok继续链合并去重".into()]
            ),
            "0909|修复|Grok继续链合并去重·2"
        );
        assert_eq!(
            uniquify_session_title(
                "0908|修复|Grok继续链合并去重",
                &[
                    "0908|修复|Grok继续链合并去重".into(),
                    "0908|修复|Grok继续链合并去重·2".into()
                ]
            ),
            "0908|修复|Grok继续链合并去重·3"
        );
    }

    #[test]
    fn conversation_too_thin_skips_greetings() {
        assert!(conversation_too_thin(&[chat("user", "你好", None)]));
        assert!(conversation_too_thin(&[chat("user", "hello", None)]));
        assert!(conversation_too_thin(&[]));
        assert!(!conversation_too_thin(&[chat(
            "user",
            "把 Blender 的 MCP 加到预设里",
            None
        )]));
    }

    #[test]
    fn user_title_material_uses_user_turns_not_assistant() {
        let msgs = vec![
            chat("user", "你好", None),
            chat("assistant", "很长的助手回复不应进标题材料", None),
            chat("user", "把 Blender 的 MCP 加到预设里", None),
            chat("user", "不对，改成只探测安装，不要代装", None),
            chat("user", "再补一条预设说明", None),
        ];
        let early = user_title_material(&msgs, true);
        assert!(early.contains("Blender"));
        assert!(!early.contains("助手"));
        assert!(!early.contains("纠正"));
        let fin = user_title_material(&msgs, false);
        assert!(fin.contains("首条"));
        assert!(fin.contains("纠正") || fin.contains("定题"));
        assert!(fin.contains("预设说明"));
        assert!(!fin.contains("很长的助手回复"));
    }
}
