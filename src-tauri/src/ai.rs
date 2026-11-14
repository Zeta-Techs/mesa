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
pub const FN_DIGEST: &str = "digest"; // 设置里「结论提炼」：ai_distill_review（评审沉淀起草）+ 融合任务书
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
        "agy" => vec!["-p".into(), prompt.into()],
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
        // 一次性调用跑在 Mesa 自建的临时目录里：Cursor 在没信任过的目录 -p 直接退出、要人选（2026-10-28 实测），
        // 这个目录是 Mesa 建的、用完即删，替它信任
        "cursor" => {
            let mut a = headless_args("cursor", prompt);
            a.push("--trust".into());
            a
        }
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

/// 边跑边出字的 Claude 一次性调用参数（项目助手用）：`stream-json` 逐条吐（要配 `--verbose`），
/// `--include-partial-messages` 带上逐字的增量；最后一行仍是 `type: result`，parse_oneshot_output 照常认
pub(crate) fn claude_stream_args(prompt: &str) -> Vec<String> {
    vec![
        "-p".into(),
        prompt.into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
        "--no-session-persistence".into(),
    ]
}

/// 把启动计划里已有的思考档改成 `level`（只改已经设了的，没设的不加）
pub(crate) fn lower_effort(agent: &str, plan: &mut agents::LaunchPlan, level: &str) {
    match agent {
        "claude-code" => {
            for (k, v) in plan.env.iter_mut() {
                if k == "CLAUDE_CODE_EFFORT_LEVEL" {
                    *v = level.to_string();
                }
            }
        }
        "codex" => {
            for a in plan.args.iter_mut() {
                if a.starts_with("model_reasoning_effort=") {
                    *a = format!(r#"model_reasoning_effort="{level}""#);
                }
            }
        }
        "agy" => {
            if let Some(i) = plan.args.iter().position(|a| a == "--effort") {
                if let Some(v) = plan.args.get_mut(i + 1) {
                    *v = level.to_string();
                }
            }
        }
        _ => {}
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
            // 取最后一条 result：Claude Code 2.1.3xx 的 stream-json 在 result 之后还会吐一行
            // {"type":"system","subtype":"task_summary"}（2026-11-11 研讨真跑实证），只看最后一行会误报失败
            let v: Value = raw
                .lines()
                .rev()
                .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
                .find(|v| v.get("type").and_then(Value::as_str) == Some("result"))
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
/// 照 codex `-s workspace-write` 的先例给 grok 加 --yolo（自动批准全部工具，含写文件）。
/// claude 同理加 `--permission-mode bypassPermissions`（2026-11-01 用户拍板，同 grok）：2.1.302 起 `-p` 在第三方网关上
/// 不带权限档就是 default 档，写文件、curl、WebFetch 全被拒（2.1.308 假网关实测）；acceptEdits 只放行改文件，
/// 雷达要 curl 联网照样跑不了；auto 档对外操作要模型判安全，经中转判不出
pub(crate) fn headless_task_args(agent: &str, prompt: &str) -> Vec<String> {
    match agent {
        "claude-code" => {
            let mut args = headless_args(agent, prompt);
            args.extend(["--permission-mode".into(), "bypassPermissions".into()]);
            args
        }
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
        "agy" => vec![
            "--dangerously-skip-permissions".into(),
            "-p".into(),
            prompt.into(),
        ],
        other => headless_args(other, prompt),
    }
}

/// 按授权（grant.rs）给出的定时 / 可写无头参数：形状与 headless_task_args 一致，权限那几个参数换成授权算出的
pub(crate) fn headless_task_args_granted(agent: &str, prompt: &str, plan: &crate::grant::GrantPlan) -> Vec<String> {
    match agent {
        "claude-code" => {
            let mut args = headless_args(agent, prompt);
            args.extend(plan.args.iter().cloned());
            args
        }
        "codex" => {
            let mut args: Vec<String> = vec!["exec".into(), "--skip-git-repo-check".into()];
            args.extend(plan.args.iter().cloned());
            args.push(prompt.into());
            args
        }
        "grok" => {
            let mut args: Vec<String> = vec!["-p".into(), prompt.into(), "--output-format".into(), "json".into()];
            args.extend(plan.args.iter().cloned());
            args
        }
        "agy" => {
            let mut args = plan.args.clone();
            args.extend(["-p".into(), prompt.into()]);
            args
        }
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
    // 官方账号没登录 / 登录过期（Claude 的 JSON result「Not logged in · Please run /login」、CodeBuddy「Authentication required」；
    // Claude 2.1.318 起登录到期说「Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login`…」）
    if low.contains("not logged in")
        || low.contains("please run /login")
        || low.contains("authentication required")
        || low.contains("reached its time limit")
        || low.contains("claude auth login")
    {
        return "官方账号还没登录或登录已过期，请到连接页这家 Agent 的组头点「官方登录」。".into();
    }
    // Claude 的 JSON 结果里 is_error 为真时 result 就是错误句：取出来，别把整段 JSON 甩给人
    if let Some(r) = detail
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
        .filter(|v| v.get("is_error").and_then(|b| b.as_bool()) == Some(true))
        .and_then(|v| v.get("result").and_then(|r| r.as_str()).map(str::to_string))
    {
        return tail_chars(&r, 200);
    }
    // Gemini 个人 Google 账号：Google 已不让个人版 Code Assist 用 Gemini CLI（2026-10-28 实测 IneligibleTierError）
    if low.contains("ineligibletiererror") || low.contains("no longer supported for gemini code assist") {
        return "Google 已不让个人 Google 账号使用 Gemini CLI（改推 Antigravity）。请改用 API 连接，或用 Workspace / 企业版账号登录。".into();
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

fn extract_stream_json_session_id(value: &serde_json::Value) -> Option<&str> {
    value
        .get("session_id")
        .or_else(|| value.get("sessionId"))
        .or_else(|| value.get("thread_id"))
        .or_else(|| value.get("conversation_id"))
        .or_else(|| value.get("result").and_then(|r| r.get("conversation_id")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn remember_headless_session(agent: &str, out: &str, err: &str) -> Option<String> {
    let id = extract_headless_session_id(&format!("{out}\n{err}")).or_else(|| {
        out.lines().find_map(|line| {
            let value: serde_json::Value = serde_json::from_str(line).ok()?;
            extract_stream_json_session_id(&value).map(str::to_owned)
        })
    })?;
    let _ = crate::sessions::mark_session_internal(agent, &id);
    Some(id)
}

/// 正在跑的无头运行锁定的会话：run_id → (agent, 会话 id)。只在运行期间存在
fn headless_sessions() -> &'static std::sync::Mutex<std::collections::HashMap<String, (String, String)>> {
    static MAP: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, (String, String)>>> =
        std::sync::OnceLock::new();
    MAP.get_or_init(Default::default)
}

struct HeadlessSessionReg(String);
impl HeadlessSessionReg {
    fn new(run_id: &str, agent: &str, session_id: &str) -> Self {
        headless_sessions()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(run_id.to_string(), (agent.to_string(), session_id.to_string()));
        Self(run_id.to_string())
    }
}
impl Drop for HeadlessSessionReg {
    fn drop(&mut self) {
        headless_sessions().lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
    }
}

thread_local! {
    /// 本线程下一次无头调用登记好 Run 后回调一次 Run id（研讨要能停单家：`process::cancel_capture` 认 Run id）。
    /// 线程局部，不改各调用点签名；只有 `with_run_hook` 里设，出来就清
    static RUN_STARTED_HOOK: std::cell::RefCell<Option<Box<dyn Fn(&str)>>> = const { std::cell::RefCell::new(None) };
}

thread_local! {
    /// 本线程下一次只读查看要分叉的会话 id（只对 Claude Code 生效，见 ai_inspect_readonly）
    static FORK_SESSION: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// 在 f 里发生的只读查看接上 session_id 的记忆另起一份（不落盘、不改原会话）
pub(crate) fn with_fork_session<T>(session_id: String, f: impl FnOnce() -> T) -> T {
    FORK_SESSION.with(|h| *h.borrow_mut() = Some(session_id));
    let out = f();
    FORK_SESSION.with(|h| *h.borrow_mut() = None);
    out
}

/// 在 f 里发生的无头调用（`ai_prompt_impl_full` / `ai_inspect_readonly`）登记 Run 后调 hook(run_id)
pub(crate) fn with_run_hook<T>(hook: Box<dyn Fn(&str)>, f: impl FnOnce() -> T) -> T {
    RUN_STARTED_HOOK.with(|h| *h.borrow_mut() = Some(hook));
    let out = f();
    RUN_STARTED_HOOK.with(|h| *h.borrow_mut() = None);
    out
}

fn notify_run_started(run_id: &str) {
    RUN_STARTED_HOOK.with(|h| {
        if let Some(cb) = h.borrow().as_ref() {
            cb(run_id);
        }
    });
}

/// 正在跑的无头运行锁定的会话（agent, 会话 id）
pub(crate) fn headless_session_of(run_id: &str) -> Option<(String, String)> {
    headless_sessions().lock().unwrap_or_else(|e| e.into_inner()).get(run_id).cloned()
}

/// 支持 --session-id 的 CLI：无头启动前锁死文件名并立刻标 internal。
fn lock_headless_session(agent: &str) -> (Option<String>, Vec<String>) {
    if let Some(session) = FOLLOWUP_SESSION.with(|value| value.borrow().clone()) {
        let (_, args) = crate::agents::resume_args(agent, &session);
        return (Some(session), if agent == "codex" { Vec::new() } else { args });
    }
    let supported = crate::agent_specs::agent_spec(agent).is_some_and(|s| s.fixed_session_id);
    if !supported {
        return (None, Vec::new());
    }
    let id = uuid::Uuid::new_v4().to_string();
    (Some(id.clone()), vec!["--session-id".into(), id])
}

thread_local! {
    static FOLLOWUP_SESSION: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
    static FOLLOWUP_OUTPUT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub(crate) fn with_followup_round<T>(session: Option<String>, work: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            FOLLOWUP_SESSION.with(|value| *value.borrow_mut() = None);
            FOLLOWUP_OUTPUT.with(|value| value.set(false));
        }
    }
    FOLLOWUP_SESSION.with(|value| *value.borrow_mut() = session);
    FOLLOWUP_OUTPUT.with(|value| value.set(true));
    let _reset = Reset;
    work()
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
    run_capture_with(agent, expected_host, cmd, timeout, run_id, session_out, None)
}

/// 把 stdout 字节流切成完整的行交给回调（最后一段不完整的留在 pending 里等下一批）
pub(crate) fn feed_lines(pending: &mut Vec<u8>, bytes: &[u8], on_line: &mut dyn FnMut(&str)) {
    pending.extend_from_slice(bytes);
    while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = pending.drain(..=pos).collect();
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end();
        if !text.is_empty() {
            on_line(text);
        }
    }
}

fn run_capture_with(
    agent: Option<&str>,
    expected_host: Option<&str>,
    cmd: &mut crate::process::BackgroundCommand,
    timeout: Duration,
    run_id: Option<&str>,
    session_out: &mut Option<String>,
    on_stdout: Option<&mut dyn FnMut(&[u8])>,
) -> Result<String, String> {
    let captured = crate::process::capture_command_streaming(cmd, timeout, 8 * 1024 * 1024, run_id, on_stdout)?;
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
    // stdout 和 stderr 都给摘要：Claude 2.1.318 起官方登录到期前 10 天往 stderr 写一行提醒，只取 stderr 时
    // 真正的错误（在 stdout 的 JSON / 文本里）会被这行盖掉
    let detail = match (err.trim().is_empty(), out.trim().is_empty()) {
        (true, _) => out,
        (false, true) => err,
        (false, false) => format!("{err}\n{out}"),
    };
    let detail = detail.trim();
    if detail.is_empty() {
        // 噪音过滤后可能两头皆空：如实说没有错误信息，别给一条空摘要
        let code = captured.status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        return Err(format!("AI 无头调用失败（退出码 {code}），CLI 未输出错误信息"));
    }
    Err(summarize_headless_error(detail, expected_host))
}

/// prompt 作命令行参数传给 CLI：参数里不能有 NUL，有一个整条命令就起不来（「启动进程失败: nul byte found in
/// provided data」）。2026-11-05 用户实测：沉浸阅读划词翻译，PDF 文字层抽出的文字带 U+0000（缺字形的
/// 占位），翻译直接失败。NUL 对 prompt 没有意义，去掉
fn argv_safe_prompt(prompt: String) -> String {
    if prompt.contains('\0') {
        prompt.replace('\0', "")
    } else {
        prompt
    }
}

pub(crate) fn ai_prompt_impl(
    profiles: Vec<Profile>,
    profile_id: Option<String>,
    fn_key: Option<&str>,
    prompt: String,
) -> Result<String, String> {
    ai_prompt_impl_model(profiles, profile_id, None, fn_key, prompt)
}

/// 同 `ai_prompt_impl`，另可点名模型（项目专属绑定带的模型，如项目助手）；
/// 点名的不在这份连接的模型名单里时照旧回落名单第一个
pub(crate) fn ai_prompt_impl_model(
    profiles: Vec<Profile>,
    profile_id: Option<String>,
    model: Option<String>,
    fn_key: Option<&str>,
    prompt: String,
) -> Result<String, String> {
    ai_prompt_impl_full(profiles, profile_id, model, fn_key, prompt, None, None, None)
}

/// 项目助手要的两样（2026-11-04 用户：回答太慢）：
/// - `effort`：把这次调用的思考档压到这一档——只在连接本来就设了思考档时改（Claude `CLAUDE_CODE_EFFORT_LEVEL`、
///   Codex `model_reasoning_effort`），没设的不加（加了不认的网关会 400）；
/// - `on_line`：边跑边拿到 stdout 的完整一行（Claude 换成 `stream-json` 逐字吐，Codex `--json` 本就逐条），用于推到面板。
pub(crate) fn ai_prompt_impl_full(
    profiles: Vec<Profile>,
    profile_id: Option<String>,
    model: Option<String>,
    fn_key: Option<&str>,
    prompt: String,
    effort: Option<&str>,
    on_line: Option<&mut dyn FnMut(&str)>,
    cost_out: Option<&mut Option<f64>>,
) -> Result<String, String> {
    let prompt = argv_safe_prompt(prompt);
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
    if profile.agent == "agy" {
        return Err("Antigravity CLI 每次无头调用都会写入会话记录，暂不用于后台标题/翻译；请在设置「AI 角色分工」改选 Claude Code 或 Codex".into());
    }
    let binary = agents::binary_for(&profile.agent)
        .ok_or_else(|| format!("profile 所属 agent 不支持无头调用: {}", profile.agent))?;
    let binary_path = agents::resolve_binary(binary)
        .ok_or_else(|| format!("未找到 {binary}（PATH 与常见安装目录均无）"))?;
    // 密钥只在调用瞬间读出注入子进程，与终端启动同一约束
    let key = profiles::get_key_for_profile(&profile)?;
    agents::ensure_launch_credentials(&profile, key.as_deref())?;
    let mut profile = profile;
    let selected = pick_listed_model(&profile.models, model.as_deref().or(preferred));
    crate::combo::apply_to_profile(&mut profile, selected.as_deref());
    agents::validate_launch_compatibility(&profile, selected.as_deref())?;
    let mut plan = agents::launch_plan(&profile, key, selected.as_deref())?;
    if let Some(level) = effort {
        lower_effort(&profile.agent, &mut plan, level);
    }
    let mut cmd = crate::process::background_command(&binary_path);
    let ephemeral = oneshot_is_ephemeral(&profile.agent);
    let streaming = on_line.is_some() && profile.agent == "claude-code";
    // 不落盘就没有会话文件，锁会话 id / 标 internal 都无对象
    let (lock_id, lock_args) = if ephemeral {
        (None, Vec::new())
    } else {
        lock_headless_session(&profile.agent)
    };
    if let Some(id) = &lock_id {
        let _ = crate::sessions::mark_session_internal(&profile.agent, id);
        let _ = crate::sessions::set_session_profile(
            &profile.agent,
            id,
            &profile.id,
            selected.as_deref().map(|m| (m, "")),
        );
    }
    let oneshot = if streaming { claude_stream_args(&prompt) } else { headless_oneshot_args(&profile.agent, &prompt) };
    for a in compose_headless_args(&profile.agent, &plan.args, &oneshot) {
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
    notify_run_started(&run.id);
    let mut on_line = on_line;
    let mut pending: Vec<u8> = Vec::new();
    let mut feed = |bytes: &[u8]| {
        if let Some(cb) = on_line.as_mut() {
            feed_lines(&mut pending, bytes, *cb);
        }
    };
    let result = run_capture_with(
        Some(&profile.agent),
        host.as_deref(),
        &mut cmd,
        AI_TIMEOUT,
        Some(&run.id),
        &mut None,
        Some(&mut feed),
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
            if let Some(out) = cost_out {
                *out = crate::usage::events_cost_usd(&events);
            }
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

/// 项目助手「只读查看项目文件」（2026-11-04 用户拍板：问出错时让它自己打开脚本 / 日志 / 产物核对）。
/// 目前只有 Claude Code 与 Codex：两家都能不落盘（花费从输出直接记账，不在项目里留内部会话、不登记项目级内部来源），
/// 只读也有进程级保证（Claude 拿掉一切写 / 执行 / 联网工具、Codex `-s read-only`）。
/// Claude 不用 plan 档：2026-11-04 实测 2.1.309 的 `-p --permission-mode plan` 会在 `~/.claude/plans/` 落一份计划文件
/// （碰了 CLI 配置目录，违反「各 CLI 配置目录只读」）；改 default 档 + `--disallowedTools` 去掉写与执行，
/// 同日实测让它「顺手把脚本改好」也只是把改法贴出来，项目与 ~/.claude/plans 都没多文件。别家返回以 INSPECT_UNSUPPORTED 开头的错，
/// 前端退回只看记录。跑在项目根，工作副本经 `--add-dir`（Claude）带上；Codex 只读沙箱本就能读别处
pub(crate) const INSPECT_UNSUPPORTED: &str = "INSPECT_UNSUPPORTED";
/// 只读查看时 Claude 只给的内置工具（白名单，2026-11-06）：黑名单每个新版本都会漏——当日 2.1.318 实测 init 工具表里还有
/// PowerShell（Windows，`CLAUDE_CODE_USE_POWERSHELL_TOOL=1` 时出现，设置里放行过的命令 -p 里不经审批）、EnterWorktree（在项目里建
/// worktree）、CronCreate / SendMessage / Workflow 等。配 `--strict-mcp-config` 不加载用户的 MCP 服务器（MCP 工具同样能写）
const CLAUDE_INSPECT_TOOLS: &str = "Read Grep Glob";
/// `--tools` 白名单可靠的最低版本：2.1.186 起首次冷启动不再漏放特性开关后的工具（更新日志），2.1.162 起 Grep / Glob 才真生效
const CLAUDE_INSPECT_TOOLS_MIN: (u32, u32, u32) = (2, 1, 186);
/// 更老或读不到版本时退回的黑名单：改文件、跑命令（含 Windows 的 PowerShell）、建 worktree、联网、开子代理
const CLAUDE_INSPECT_DISALLOWED: &str = "Edit Write MultiEdit NotebookEdit Bash PowerShell EnterWorktree WebFetch WebSearch Task";
const INSPECT_TIMEOUT: Duration = Duration::from_secs(240);

/// images：附图（项目助手粘贴的截图，2026-11-05）。Codex 用自带的 `--image=a,b` 附在这条消息上（写成一个参数：
/// `-i` 后面能吃多个值，会把提示词也当成图）；Claude Code 没有附图参数，由调用方把图所在目录 `--add-dir`、提示词里点名路径，
/// 它用 Read 工具打开（只读模式里 Read 本来就放行，实测 2.1.309 能读出截图里的报错）
/// claude_version：本机 Claude Code 版本（`agents::cli_version`），够 `CLAUDE_INSPECT_TOOLS_MIN` 才用白名单
pub(crate) fn inspect_readonly_args(
    agent: &str,
    prompt: &str,
    extra_dirs: &[String],
    stream: bool,
    images: &[String],
    claude_version: Option<(u32, u32, u32)>,
) -> Option<Vec<String>> {
    match agent {
        "claude-code" => {
            let mut a: Vec<String> = if stream {
                claude_stream_args(prompt)
            } else {
                vec![
                    "-p".into(),
                    prompt.into(),
                    "--output-format".into(),
                    "json".into(),
                    "--no-session-persistence".into(),
                ]
            };
            a.extend(["--permission-mode".to_string(), "default".into()]);
            if claude_version.is_some_and(|v| v >= CLAUDE_INSPECT_TOOLS_MIN) {
                a.extend(["--tools".to_string(), CLAUDE_INSPECT_TOOLS.into(), "--strict-mcp-config".into()]);
            } else {
                a.extend(["--disallowedTools".to_string(), CLAUDE_INSPECT_DISALLOWED.into()]);
            }
            for d in extra_dirs {
                a.push("--add-dir".into());
                a.push(d.clone());
            }
            Some(a)
        }
        "codex" => {
            let mut a: Vec<String> = vec![
                "exec".into(),
                "--skip-git-repo-check".into(),
                "--ephemeral".into(),
                "--json".into(),
                "-s".into(),
                "read-only".into(),
            ];
            if !images.is_empty() {
                a.push(format!("--image={}", images.join(",")));
            }
            a.push(prompt.into());
            Some(a)
        }
        _ => None,
    }
}

/// 带图时提示词前面加的一段：Claude Code 要自己用 Read 打开（点名路径），Codex 图已附在消息上
pub(crate) fn image_prompt_note(agent: &str, images: &[String]) -> String {
    if images.is_empty() {
        return String::new();
    }
    match agent {
        "claude-code" => format!(
            "用户随问题附了 {} 张截图，回答前先用 Read 工具逐张打开看（图里的报错、界面状态是这次提问的关键）：\n{}\n\n",
            images.len(),
            images.iter().map(|p| format!("- {p}")).collect::<Vec<_>>().join("\n")
        ),
        _ => format!("用户随问题附了 {} 张截图（已附在这条消息里），回答前先看图，图里的报错、界面状态是这次提问的关键。\n\n", images.len()),
    }
}

pub(crate) fn ai_inspect_readonly(
    profiles: Vec<Profile>,
    profile_id: Option<String>,
    model: Option<String>,
    project_root: &std::path::Path,
    extra_dirs: &[String],
    prompt: String,
    effort: Option<&str>,
    on_line: Option<&mut dyn FnMut(&str)>,
    cost_out: Option<&mut Option<f64>>,
    images: &[String],
) -> Result<String, String> {
    if !project_root.is_dir() {
        return Err("项目文件夹不在了".into());
    }
    let settings = crate::settings::read_current_checked()?;
    let fn_key = "project-assistant";
    let fn_profile = settings.ai_profiles.as_ref().and_then(|m| m.get(fn_key).cloned());
    let profile = resolve_profile_from(
        profiles,
        profile_id.clone().filter(|v| !v.trim().is_empty()),
        fn_profile,
        settings.ai_profile_id.clone(),
        &settings.hidden_profiles.unwrap_or_default().into_iter().collect(),
    )?;
    let mut dirs: Vec<String> = extra_dirs
        .iter()
        .filter(|d| std::path::Path::new(d.as_str()).is_dir())
        .take(8)
        .cloned()
        .collect();
    // 附图所在目录也给 Claude 读（Codex 的只读沙箱本就能读别处，图又是作为附件传）
    for img in images {
        if let Some(parent) = std::path::Path::new(img).parent().map(|p| p.to_string_lossy().into_owned()) {
            if !dirs.contains(&parent) {
                dirs.push(parent);
            }
        }
    }
    let prompt = format!("{}{}", image_prompt_note(&profile.agent, images), prompt);
    let claude_version = (profile.agent == "claude-code").then(|| agents::cli_version("claude-code")).flatten();
    let Some(mut args) = inspect_readonly_args(&profile.agent, &prompt, &dirs, on_line.is_some(), images, claude_version) else {
        return Err(format!("{INSPECT_UNSUPPORTED}: {}", profile.agent));
    };
    // 问它一句（不打断，2026-11-11）：Claude Code 原生分叉——接上那段会话的记忆另起一份，配 --no-session-persistence 不落盘，
    // 原会话一个字不动；只认 Claude Code（Codex 的 fork 只有交互形态，exec resume 会写回原会话）
    if profile.agent == "claude-code" {
        if let Some(sid) = FORK_SESSION.with(|f| f.borrow().clone()) {
            args.extend(["--resume".to_string(), sid, "--fork-session".into()]);
        }
    }
    let binary = agents::binary_for(&profile.agent)
        .ok_or_else(|| format!("profile 所属 agent 不支持无头调用: {}", profile.agent))?;
    let binary_path = agents::resolve_binary(binary)
        .ok_or_else(|| format!("未找到 {binary}（PATH 与常见安装目录均无）"))?;
    let key = profiles::get_key_for_profile(&profile)?;
    agents::ensure_launch_credentials(&profile, key.as_deref())?;
    let mut profile = profile;
    let selected = pick_listed_model(&profile.models, model.as_deref());
    crate::combo::apply_to_profile(&mut profile, selected.as_deref());
    agents::validate_launch_compatibility(&profile, selected.as_deref())?;
    let mut plan = agents::launch_plan(&profile, key, selected.as_deref())?;
    if let Some(level) = effort {
        lower_effort(&profile.agent, &mut plan, level);
    }
    let mut cmd = crate::process::background_command(&binary_path);
    for a in compose_headless_args(&profile.agent, &plan.args, &args) {
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
    cmd.current_dir(project_root);
    let host = endpoint_host(profile.base_url.as_deref());
    let root_text = project_root.to_string_lossy().into_owned();
    // internal：不进项目的运行列表、任务面板「过程」与卡点
    let run = crate::runs::open_headless_with_root(
        Some(&root_text),
        &profile.agent,
        &profile.id,
        &root_text,
        "headless:ai-prompt:project-assistant-inspect",
        false,
        "discuss",
    )?;
    if let Err(error) = crate::runs::claim_start(&run.id).and_then(|_| crate::runs::mark_started(&run.id)) {
        let _ = crate::runs::close_run_with_result(&run.id, None, "failed", None, Some("无头 Run 状态登记失败"));
        return Err(error);
    }
    notify_run_started(&run.id);
    let mut on_line = on_line;
    let mut pending: Vec<u8> = Vec::new();
    let mut feed = |bytes: &[u8]| {
        if let Some(cb) = on_line.as_mut() {
            feed_lines(&mut pending, bytes, *cb);
        }
    };
    let result = run_capture_with(Some(&profile.agent), host.as_deref(), &mut cmd, INSPECT_TIMEOUT, Some(&run.id), &mut None, Some(&mut feed))
        .and_then(|raw| {
            let (text, events) =
                parse_oneshot_output(&profile.agent, &raw, selected.as_deref(), &crate::usage::today_local())?;
            if let Some(out) = cost_out {
                *out = crate::usage::events_cost_usd(&events);
            }
            if let Err(e) = crate::usage::record_ephemeral_usage(
                &profile.agent,
                &format!("ephemeral-{}", run.id),
                &root_text,
                profile.account_type == crate::profiles::AccountType::Official,
                &events,
            ) {
                eprintln!("[ai] {e}");
            }
            Ok(text)
        });
    let status = if result.is_ok() { "completed" } else { "failed" };
    let _ = crate::runs::close_run_with_result(
        &run.id,
        None,
        status,
        None,
        result.is_err().then_some("项目助手只读查看失败"),
    );
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

/// 拼好、还没起的无头命令（定时任务与目标无头运行共用一条注入链路）
pub(crate) struct HeadlessCommand {
    pub cmd: crate::process::BackgroundCommand,
    /// 这条连接配的端点 host：401 报错分流用
    pub host: Option<String>,
    /// 启动前锁定的会话 id（支持 --session-id 的 CLI），其余为 None、跑完从输出里抠
    pub lock_id: Option<String>,
    /// 按授权跑时这家实际落实了什么（人话，记进 Run 事件）；没授权为 None
    pub grant_summary: Option<String>,
    /// 所属连接 id 与解析后的模型名（无头会话落盘后写入 session_meta，供 Kimi 2.6 用量计价与预算轮询）
    pub profile_id: String,
    pub selected_model: Option<String>,
}

/// 无头命令拼装：解析二进制、现取密钥（只进子进程 env）、注入连接、拼 plan + 无头形态参数、定工作目录。
/// `write` = 要在工作目录里写文件（定时任务 / 可写目标，headless_task_args）；否则只读形态（headless_args）
pub(crate) fn build_headless_command(
    profile: &Profile,
    model: Option<&str>,
    prompt: &str,
    cwd: &std::path::Path,
    write: bool,
) -> Result<HeadlessCommand, String> {
    build_headless_command_granted(profile, model, prompt, cwd, write, None)
}

/// `grant`：定时任务按授权范围跑（grant.rs）；None = 照旧（可写的是全权限）
pub(crate) fn build_headless_command_granted(
    profile: &Profile,
    model: Option<&str>,
    prompt: &str,
    cwd: &std::path::Path,
    write: bool,
    grant: Option<&crate::grant::Grant>,
) -> Result<HeadlessCommand, String> {
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
    if let Some((key, value)) = crate::dep_check::agent_python_env() {
        cmd.env(key, value);
    }
    let (lock_id, lock_args) = lock_headless_session(&profile.agent);
    let mut grant_plan = None;
    let headless = if write {
        let task_args = match grant {
            Some(g) => {
                let gp = crate::grant::plan_for(&profile.agent, g, &[], cfg!(windows));
                let args = headless_task_args_granted(&profile.agent, prompt, &gp);
                grant_plan = Some(gp);
                args
            }
            None => headless_task_args(&profile.agent, prompt),
        };
        with_codex_win_sandbox(task_args, codex_win_sandbox_for_run(&profile.agent))
    } else {
        headless_args(&profile.agent, prompt)
    };
    let headless = if FOLLOWUP_OUTPUT.with(|value| value.get()) {
        followup_args(&profile.agent, headless, FOLLOWUP_SESSION.with(|value| value.borrow().clone()))?
    } else { headless };
    let mut all_args = compose_headless_args(&profile.agent, &plan.args, &headless);
    if let Some(extra) = grant_plan.as_ref().and_then(|g| g.claude_settings.as_ref()) {
        crate::grant::merge_claude_settings(&mut all_args, extra)?;
    }
    for a in all_args {
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
    if profile.agent == "gemini" {
        crate::projects::ensure_geminiignore(cwd);
    }
    cmd.current_dir(cwd);
    Ok(HeadlessCommand {
        cmd,
        host: endpoint_host(profile.base_url.as_deref()),
        lock_id,
        grant_summary: grant_plan.map(|g| g.summary),
        profile_id: profile.id,
        selected_model: selected,
    })
}

fn followup_args(agent: &str, mut args: Vec<String>, session: Option<String>) -> Result<Vec<String>, String> {
    if !crate::agent_specs::headless_followup_cap(agent).supported {
        return Err("该 Agent 不支持分轮无头续跑".into());
    }
    match agent {
        "claude-code" => {
            if let Some(index) = args.iter().position(|value| value == "--output-format") { args[index + 1] = "json".into(); }
        }
        "codex" => {
            if let Some(session) = session {
                let mut index = 0;
                while index + 1 < args.len() {
                    if args[index] == "-s" || args[index] == "--sandbox" {
                        let sandbox = args[index + 1].clone();
                        args.splice(index..index + 2, ["-c".into(), format!("sandbox_mode=\"{sandbox}\"")]);
                    }
                    index += 1;
                }
                args.insert(1, "resume".into());
                let prompt = args.pop().ok_or("没有提示词")?;
                args.push(session);
                args.push(prompt);
            }
            args.insert(1, "--json".into());
        }
        "kimi" | "agy" => args.extend(["--output-format".into(), "stream-json".into()]),
        _ => return Err("该 Agent 不支持分轮无头续跑".into()),
    }
    Ok(args)
}

pub(crate) fn followup_text(agent: &str, raw: &str) -> Result<String, String> {
    match agent {
        "claude-code" | "codex" => parse_oneshot_output(agent, raw, None, "").map(|(text, _)| text),
        "kimi" => {
            // 只收助手说的话：stream-json 若回显用户消息，提示词里的回执示例会被误当成回执
            fn push_content(content: Option<&serde_json::Value>, parts: &mut Vec<String>) {
                match content {
                    Some(serde_json::Value::String(text)) => parts.push(text.clone()),
                    Some(serde_json::Value::Array(items)) => {
                        for part in items {
                            let kind = part.get("type").and_then(|value| value.as_str()).unwrap_or("text");
                            if matches!(kind, "text" | "output_text") {
                                if let Some(text) = part.get("text").and_then(|value| value.as_str()) { parts.push(text.to_string()); }
                            }
                        }
                    }
                    _ => {}
                }
            }
            let mut parts = Vec::new();
            for line in raw.lines() {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                if value.get("role").and_then(|value| value.as_str()) == Some("assistant") {
                    push_content(value.get("content"), &mut parts);
                } else if value.get("type").and_then(|value| value.as_str()) == Some("assistant") {
                    push_content(value.get("message").and_then(|value| value.get("content")), &mut parts);
                }
            }
            if parts.is_empty() { Err("没有可读的 Kimi 回执文本".into()) } else { Ok(parts.join("")) }
        }
        "agy" => {
            // Antigravity CLI 1.5.8 `--output-format stream-json` 实测：
            // 首行 {"event":"init","conversation_id":"..."}；过程行 step_update（user_input / agent_response text_delta）；
            // 末行 {"event":"result","result":{"conversation_id":"...","status":"SUCCESS","response":"..."}}。
            // 绝不收 step_type == "user_input"，避免提示词里的回执示例被误当成助手回执。
            let mut final_response: Option<String> = None;
            let mut deltas = Vec::new();
            for line in raw.lines() {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                match value.get("event").and_then(|v| v.as_str()) {
                    Some("result") => {
                        if let Some(res) = value.get("result") {
                            if let Some(status) = res.get("status").and_then(|v| v.as_str()) {
                                if !status.eq_ignore_ascii_case("SUCCESS") {
                                    let msg = res
                                        .get("error")
                                        .or_else(|| res.get("message"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or(status);
                                    return Err(format!("Antigravity CLI 执行未成功: {msg}"));
                                }
                            }
                            if let Some(resp) = res.get("response").and_then(|v| v.as_str()) {
                                if !resp.trim().is_empty() {
                                    final_response = Some(resp.to_string());
                                }
                            }
                        }
                    }
                    Some("step_update") => {
                        if value.get("step_type").and_then(|v| v.as_str()) == Some("agent_response") {
                            if let Some(delta) = value.get("text_delta").and_then(|v| v.as_str()) {
                                deltas.push(delta.to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
            if let Some(resp) = final_response {
                Ok(resp)
            } else if !deltas.is_empty() {
                Ok(deltas.join(""))
            } else {
                Err("没有可读的 Antigravity CLI 回执文本".into())
            }
        }
        _ => Err("没有该 Agent 的分轮输出解析器".into()),
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
    run_agent_task_granted(profile, model, prompt, cwd, timeout, reuse_key, sentinel, project_root, existing_run_id, None)
}

/// 同 run_agent_task，按授权范围跑（grant.rs，定时任务用）：参数按这家能落实的给，Run 上记一条 run.grant；
/// 设了预算而 CLI 没有原生预算参数、又能锁定会话 id 的，Mesa 每 30 秒按会话用量看一次，到额停掉（run.budget）
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_agent_task_granted(
    profile: &Profile,
    model: Option<&str>,
    prompt: &str,
    cwd: &std::path::Path,
    timeout: Duration,
    reuse_key: Option<&str>,
    sentinel: bool,
    project_root: Option<&std::path::Path>,
    existing_run_id: Option<&str>,
    grant: Option<&crate::grant::Grant>,
) -> Result<(String, String), String> {
    let HeadlessCommand { mut cmd, host, lock_id, grant_summary, profile_id, selected_model } =
        build_headless_command_granted(profile, model, prompt, cwd, true, grant)?;
    if let Some(id) = &lock_id {
        let _ = crate::sessions::mark_session_internal(&profile.agent, id);
        let _ = crate::sessions::set_session_profile(
            &profile.agent,
            id,
            &profile_id,
            selected_model.as_deref().map(|m| (m, "")),
        );
    }
    let default_reuse = format!("headless:ai:{}", cwd.display());
    let reuse = reuse_key.unwrap_or(&default_reuse);
    let project_root_owned = project_root.map(|p| p.to_string_lossy().into_owned());
    let run = if let Some(id) = existing_run_id {
        crate::runs::run_get_sync(id.to_string())?.ok_or("预登记的 Run 不存在")?
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
    // 看一眼（2026-11-04 补）：属于某个项目的无头运行（定时任务）也带上 helper 与这次的 Run，能只读看同项目在做什么、给别的工作留话；
    // 与 PTY 同一对变量（pty.rs），helper 按 Run 找项目、把自己排除在同伴外
    if project_root.is_some() {
        if let Some(tool) = crate::image_gen::helper_exe() {
            cmd.env(crate::peek::TOOL_ENV, &tool);
            cmd.env(crate::peek::RUN_ENV, &run.id);
        }
        if let Some(tool) = crate::journal_metrics::helper_exe() {
            cmd.env(crate::journal_metrics::TOOL_ENV, &tool);
        }
    }
    // 锁定了会话 id 的：跑的期间登记，卡住检测据此看会话文件有没有在长（跑完即撤）
    let _session_reg = lock_id
        .as_ref()
        .map(|id| HeadlessSessionReg::new(&run.id, &profile.agent, id));
    if let Some(summary) = grant_summary.as_deref() {
        let _ = crate::runs::record_run_event(&run.id, "run.grant", summary);
    }
    let budget_session = std::sync::Arc::new(std::sync::Mutex::new(lock_id.clone()));
    let budget_watch = grant
        .and_then(|g| g.budget_usd)
        .filter(|_| profile.agent != "claude-code")
        .map(|budget| BudgetWatch::start(run.id.clone(), profile.agent.clone(), budget_session.clone(), budget));
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
    let mut recorded_stream_session: Option<String> = None;
    let mut pending = Vec::new();
    let mut on_output = |bytes: &[u8]| feed_lines(&mut pending, bytes, &mut |line| {
        if FOLLOWUP_OUTPUT.with(|value| value.get()) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(session) = extract_stream_json_session_id(&value) {
                    if recorded_stream_session.as_deref() != Some(session) {
                        recorded_stream_session = Some(session.to_string());
                        let _ = crate::sessions::mark_session_internal(&profile.agent, session);
                        let _ = crate::sessions::set_session_profile(
                            &profile.agent,
                            session,
                            &profile_id,
                            selected_model.as_deref().map(|m| (m, "")),
                        );
                    }
                    *budget_session.lock().unwrap_or_else(|error| error.into_inner()) = Some(session.into());
                    let _ = crate::runs::attach_session_impl(&run.id, session);
                }
            }
        }
    });
    let out = run_capture_with(
        Some(&profile.agent),
        host.as_deref(),
        &mut cmd,
        timeout,
        Some(&run.id),
        &mut seen_session,
        Some(&mut on_output),
    );
    // 会话 id 记到 Run 上（定时历史「看过程」据此打开那次后台对话）：
    // 能锁定 id 的 CLI 用启动前锁的，其余用输出里抠到的
    let session = lock_id.or(seen_session);
    if let Some(sid) = session.as_deref() {
        let _ = crate::sessions::mark_session_internal(&profile.agent, sid);
        let _ = crate::sessions::set_session_profile(
            &profile.agent,
            sid,
            &profile_id,
            selected_model.as_deref().map(|m| (m, "")),
        );
    }
    let over_budget = budget_watch.map(BudgetWatch::finish).unwrap_or(false);
    let out = if over_budget {
        Err(format!(
            "到预算停下：这次花费到了授权里设的上限 ${:.2}（按会话用量、官方价算）",
            grant.and_then(|g| g.budget_usd).unwrap_or_default()
        ))
    } else {
        out
    };
    let status = if out.is_ok() {
        "completed"
    } else if over_budget || out.as_ref().err().is_some_and(|e| e.contains("已取消")) {
        "stopped"
    } else {
        "failed"
    };
    let closed = crate::runs::close_run_with_result(
        &run.id,
        session.as_deref(),
        status,
        None,
        if over_budget { Some("到授权预算停下") } else { (out.is_err()).then_some("定时/无头 Agent 执行失败") },
    );
    closed.map_err(|e| format!("Agent 已退出，但运行状态保存失败：{e}"))?;
    out.map(|text| (text, run.id))
}

/// 授权预算的旁路盯梢（CLI 没有原生预算参数时）：每 30 秒按锁定的会话 id 算一次花费，到额就取消这次运行
struct BudgetWatch {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    hit: std::sync::Arc<std::sync::atomic::AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl BudgetWatch {
    fn start(run_id: String, agent: String, session: std::sync::Arc<std::sync::Mutex<Option<String>>>, budget: f64) -> Self {
        use std::sync::atomic::Ordering;
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hit = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (s2, h2) = (stop.clone(), hit.clone());
        let baseline = if FOLLOWUP_OUTPUT.with(|value| value.get()) { session.lock().unwrap_or_else(|error| error.into_inner()).as_deref().and_then(|session| crate::usage::session_cost_priced(&agent, session)).unwrap_or(0.0) } else { 0.0 };
        let handle = std::thread::Builder::new()
            .name("grant-budget".into())
            .spawn(move || {
                let mut waited = 0u64;
                while !s2.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_secs(1));
                    waited += 1;
                    if waited % 30 != 0 {
                        continue;
                    }
                    let current = session.lock().unwrap_or_else(|error| error.into_inner()).clone();
                    if let Some(cost) = current.as_deref().and_then(|session| crate::usage::session_cost_priced(&agent, session)) {
                        if cost - baseline >= budget {
                            h2.store(true, Ordering::Relaxed);
                            let _ = crate::runs::record_run_event(&run_id, "run.budget", &format!("花费 ${cost:.2} 到了预算 ${budget:.2}，Mesa 停掉了这次运行"));
                            let _ = crate::process::cancel_capture(&run_id);
                            break;
                        }
                    }
                }
            })
            .ok();
        BudgetWatch { stop, hit, handle }
    }

    /// 运行结束：停掉盯梢，返回是不是因为到预算才停的
    fn finish(mut self) -> bool {
        use std::sync::atomic::Ordering;
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        self.hit.load(Ordering::Relaxed)
    }
}

/// 目标无头运行的结局：与交互终端收尾同一组状态（completed / failed / stopped），交给 runs::close_run_with_result
pub(crate) struct HeadlessExit {
    pub status: &'static str,
    pub code: Option<i32>,
    pub reason: Option<String>,
    pub session: Option<String>,
}

/// 目标无头运行（2026-11-06：项目助手派出的目标不再开没人看的终端）：跑到进程结束为止。
/// stdout / stderr 按行写进运行记录（run.output，脱敏与限量在 runs::record_output）；超时、取消由捕获层杀进程树。
/// 与定时任务不同，会话不标 internal——目标是人派的活，同交互开工一样算正常对话与用量
pub(crate) fn run_goal_headless_to_exit(
    agent: &str,
    job: HeadlessCommand,
    timeout: Duration,
    run_id: &str,
) -> HeadlessExit {
    let HeadlessCommand {
        mut cmd,
        host,
        lock_id,
        grant_summary: _,
        profile_id,
        selected_model,
    } = job;
    if let Some(id) = &lock_id {
        let _ = crate::sessions::set_session_profile(
            agent,
            id,
            &profile_id,
            selected_model.as_deref().map(|m| (m, "")),
        );
    }
    // 锁定了会话 id 的：跑的期间登记，卡住检测据此看会话文件有没有在长（跑完即撤）
    let _session_reg = lock_id
        .as_ref()
        .map(|id| HeadlessSessionReg::new(run_id, agent, id));
    let record = |line: &str| {
        let line = strip_known_cli_noise(line);
        if !line.trim().is_empty() {
            let _ = crate::runs::record_output(run_id, &format!("{line}\n"));
        }
    };
    let (mut out_pending, mut err_pending) = (Vec::new(), Vec::new());
    let mut on_out = |bytes: &[u8]| feed_lines(&mut out_pending, bytes, &mut |line| record(line));
    let mut on_err = |bytes: &[u8]| feed_lines(&mut err_pending, bytes, &mut |line| record(line));
    let captured = crate::process::capture_command_streaming_both(
        &mut cmd,
        timeout,
        8 * 1024 * 1024,
        Some(run_id),
        Some(&mut on_out),
        Some(&mut on_err),
    );
    // 末尾没换行的半行也记上
    for rest in [&out_pending, &err_pending] {
        if !rest.is_empty() {
            record(String::from_utf8_lossy(rest).trim_end());
        }
    }
    let captured = match captured {
        Ok(captured) => captured,
        Err(error) => {
            return HeadlessExit {
                status: "failed",
                code: None,
                reason: Some(format!("Agent 没能启动：{error}")),
                session: None,
            }
        }
    };
    let out = strip_known_cli_noise(&String::from_utf8_lossy(&captured.stdout));
    let err = strip_known_cli_noise(&String::from_utf8_lossy(&captured.stderr));
    let session = lock_id.or_else(|| extract_headless_session_id(&format!("{out}\n{err}")));
    if let Some(sid) = session.as_deref() {
        let _ = crate::sessions::set_session_profile(
            agent,
            sid,
            &profile_id,
            selected_model.as_deref().map(|m| (m, "")),
        );
    }
    let code = captured.status.and_then(|status| status.code());
    if captured.cancelled {
        let reason = if crate::process::shutting_down() {
            "应用退出"
        } else {
            "用户主动停止"
        };
        return HeadlessExit {
            status: "stopped",
            code,
            reason: Some(reason.into()),
            session,
        };
    }
    if captured.timed_out {
        return HeadlessExit {
            status: "failed",
            code,
            reason: Some(format!(
                "运行超时（超过 {} 分钟仍未结束），已停止",
                timeout.as_secs() / 60
            )),
            session,
        };
    }
    if captured.status.is_some_and(|status| status.success()) {
        return HeadlessExit {
            status: "completed",
            code: Some(0),
            reason: None,
            session,
        };
    }
    // stdout 和 stderr 都给摘要（同 run_capture_with）：真正的错误可能在任一路
    let detail = match (err.trim().is_empty(), out.trim().is_empty()) {
        (true, _) => out,
        (false, true) => err,
        (false, false) => format!("{err}\n{out}"),
    };
    let shown = code.map_or_else(|| "被系统结束".to_string(), |code| format!("退出码 {code}"));
    let reason = if detail.trim().is_empty() {
        format!("Agent 异常结束（{shown}），没有输出错误信息")
    } else {
        format!(
            "Agent 异常结束（{shown}）：{}",
            summarize_headless_error(detail.trim(), host.as_deref())
        )
    };
    HeadlessExit {
        status: "failed",
        code,
        reason: Some(reason),
        session,
    }
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
        // Mesa 塞在第一句前面的项目上下文包不是人话（项目里「＋ 新对话」），起名只认你说的
        let t = crate::sessions::strip_mesa_launch_pack(b.text.trim()).trim();
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
    let cjk = theme
        .chars()
        .filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c))
        .count();
    // 6–16 字（英文字母、数字两个算一个字，crate::sessions::title_width 同口径）
    (12..=32).contains(&crate::sessions::title_width(theme)) && cjk >= 4 && !joins_two_things(theme)
}

/// 「修 A 并推送」「A 以及 B」：一个标题塞了两件事。合并 / 并发 / 并行这类词里的「并」不算
fn joins_two_things(theme: &str) -> bool {
    if theme.contains("以及") || theme.contains("同时") {
        return true;
    }
    let chars: Vec<char> = theme.chars().collect();
    chars.iter().enumerate().any(|(i, c)| {
        *c == '并'
            && !(i > 0 && "合兼吞归一".contains(chars[i - 1]))
            && !chars.get(i + 1).is_some_and(|n| "发行列存入购网集联排轨".contains(*n))
    })
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

fn build_session_title_prompt(
    material: &str,
    mmdd: &str,
    early: bool,
    reference: &[String],
    background: Option<&str>,
) -> String {
    let scope = if early {
        "这是临时标题，只根据用户第一条真正的问题。"
    } else {
        "根据用户自己说过的话。首条是最初意图，纠正是中途改方向，定题是最后要求。不要参考助手回复或工具调用。"
    };
    let occupied = if reference.is_empty() {
        String::new()
    } else {
        let lines: Vec<String> = reference.iter().map(|t| format!("- {t}")).collect();
        format!(
            "\n已有标题，不要重复或只改一两个字：\n{}\n",
            lines.join("\n")
        )
    };
    let background = match background {
        Some(bg) => format!(
            "\n## 背景（Mesa 提供，不是用户说的）\n{bg}\n\
             用户原话若只是「读 TASK.md，按简报做到完成标准」「任务书定稿」这类通用开工语，\
             主题按背景写出具体是哪一步、做的什么课题，例如「镁硫电池综述大纲任务书敲定」；\
             用户原话有具体要求时以原话为准，背景只用来补足对象。\n"
        ),
        None => String::new(),
    };
    format!(
        "{scope}只输出一行，不要解释、不要引号、不要代码块。\n\
         格式：类型|主题\n\
         类型只能是以下之一：功能、设计、修复、优化、发布、探索、文档、研究。\n\
         同时符合多个类型时选最能代表这次目的的一个。\n\
         主题：6到16个字（英文字母、数字两个算一个字），必须让人一眼看出「对什么做了哪一件事」。\n\
         只写一件事：做了几件就挑最主要的那件，不要用「并」「以及」「同时」把两件事连起来。\n\
         写成对象+动作，例如「Grok继续链合并去重」「目标卡与项目栏同底」。\n\
         不要项目名 Mesa/Ccode，不要完整句子，不要「优化界面」「功能开发」「问题修复」「架构调整」这种空标题。\n\
         不要输出日期（日期由系统填写，创建日为 {mmdd}）。{occupied}{background}\n\
         ## 用户原话\n{material}"
    )
}

/// 去重参照：撞车多发生在同类话题，先挑跟这次原话（含背景）共享字词最多的已有标题，
/// 再用最近的补满。整库按写入先后排，只取前 N 条会全是最老的那批，起不到提醒作用。
fn pick_reference_titles(taken: &[String], material: &str, limit: usize) -> Vec<String> {
    let want = title_grams(material);
    let mut scored: Vec<(usize, usize)> = taken
        .iter()
        .enumerate()
        .map(|(i, t)| (title_grams(&title_identity_key(t)).intersection(&want).count(), i))
        .filter(|(score, _)| *score > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let mut picked: Vec<usize> = scored.into_iter().take(limit / 2).map(|(_, i)| i).collect();
    for i in (0..taken.len()).rev() {
        if picked.len() >= limit {
            break;
        }
        if !picked.contains(&i) {
            picked.push(i);
        }
    }
    picked.into_iter().map(|i| taken[i].clone()).collect()
}

/// 粗粒度字词：相邻两个汉字一组 + 三个字母以上的英文词（小写）
fn title_grams(text: &str) -> std::collections::HashSet<String> {
    let is_cjk = |c: char| ('\u{4e00}'..='\u{9fff}').contains(&c);
    let mut out = std::collections::HashSet::new();
    let chars: Vec<char> = text.chars().collect();
    for w in chars.windows(2) {
        if is_cjk(w[0]) && is_cjk(w[1]) {
            out.insert(w.iter().collect());
        }
    }
    for word in text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| w.len() >= 3)
    {
        out.insert(word.to_ascii_lowercase());
    }
    out
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

/// 开工类对话的背景：流水线步骤 / 任务工作区里，首句常是固定开工语（「读 TASK.md，按简报做到完成标准」），
/// 只看原话起出来的标题分不出是哪个项目哪一步。普通对话没有背景，仍只看用户原话。
fn title_background(meta: &crate::sessions::SessionMetaDto) -> Option<String> {
    let step = meta
        .step_name
        .as_deref()
        .or(meta.workspace.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (task_title, topic) = meta
        .cwd
        .as_deref()
        .and_then(|cwd| fs::read(PathBuf::from(cwd).join("TASK.md")).ok())
        .map(|bytes| {
            let head = String::from_utf8_lossy(&bytes[..bytes.len().min(16 * 1024)]).into_owned();
            parse_task_md_head(&head)
        })
        .unwrap_or((None, None));
    if step.is_none() && task_title.is_none() && topic.is_none() {
        return None;
    }
    let project = project_display_name(&meta.project_path);
    format_title_background(
        project.as_deref(),
        step,
        task_title.as_deref(),
        topic.as_deref(),
    )
}

/// 补名批的廉价预判（不读文件）：有步骤名或工作区名的对话一定有背景。
fn has_background_hint(meta: &crate::sessions::SessionMetaDto) -> bool {
    meta.step_name.as_deref().is_some_and(|s| !s.trim().is_empty())
        || meta.workspace.as_deref().is_some_and(|s| !s.trim().is_empty())
}

fn project_display_name(project_path: &str) -> Option<String> {
    let project_path = project_path.trim();
    if project_path.is_empty() {
        return None;
    }
    crate::projects::registered_project_rows()
        .into_iter()
        .find(|(path, _)| crate::paths::same_path(path, project_path))
        .map(|(_, name)| name)
        .filter(|n| !n.trim().is_empty())
        .or_else(|| worktree_project_dir(project_path))
        .or_else(|| {
            std::path::Path::new(project_path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
        })
}

/// 工作区已归档的老会话，路径还停在 `~/ccode/workspaces/<项目>/<工作区>`（编程车道 worktrees 同构）：
/// 取 `<项目>` 这一级，别把工作区目录名当项目名。
fn worktree_project_dir(project_path: &str) -> Option<String> {
    let home = crate::ccode_home::current().ok()?;
    ["workspaces", "worktrees"].iter().find_map(|sub| {
        let root = home.join(sub);
        let root = root.to_string_lossy();
        if !crate::paths::path_within(project_path, &root) {
            return None;
        }
        std::path::Path::new(project_path)
            .strip_prefix(std::path::Path::new(root.as_ref()))
            .ok()?
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
    })
}

/// TASK.md 开头：一级标题（任务书标题，多为步骤名）与「## 课题主题」下第一行。
fn parse_task_md_head(text: &str) -> (Option<String>, Option<String>) {
    let mut title = None;
    let mut topic = None;
    let mut in_topic = false;
    for line in text.lines().map(str::trim) {
        if title.is_none() {
            if let Some(t) = line.strip_prefix("# ") {
                title = Some(cap_chars(t.trim(), 60)).filter(|t| !t.is_empty());
                continue;
            }
        }
        if let Some(h) = line.strip_prefix("## ") {
            in_topic = h.trim() == "课题主题";
            continue;
        }
        if in_topic && topic.is_none() && !line.is_empty() && !line.starts_with('#') {
            topic = Some(cap_chars(line, 60));
            in_topic = false;
        }
        if title.is_some() && topic.is_some() {
            break;
        }
    }
    (title, topic)
}

fn format_title_background(
    project: Option<&str>,
    step: Option<&str>,
    task_title: Option<&str>,
    topic: Option<&str>,
) -> Option<String> {
    fn clean(s: Option<&str>) -> Option<&str> {
        s.map(str::trim).filter(|s| !s.is_empty())
    }
    let (project, step, task_title, topic) =
        (clean(project), clean(step), clean(task_title), clean(topic));
    if step.is_none() && task_title.is_none() && topic.is_none() {
        return None;
    }
    let mut lines = Vec::new();
    if let Some(p) = project {
        lines.push(format!("项目：{p}"));
    }
    if let Some(s) = step {
        lines.push(format!("步骤：{s}"));
    }
    if let Some(t) = task_title.filter(|t| Some(*t) != step) {
        lines.push(format!("任务书标题：{t}"));
    }
    if let Some(t) = topic {
        lines.push(format!("课题：{t}"));
    }
    Some(lines.join("\n"))
}

/// 这次起名用的材料指纹（原话摘取 + 背景）。同样的材料问过一次就不再问 AI：
/// 重开旧对话、只有一轮就退出的对话，都不会再白调一次、把标题换个说法。
fn title_basis(material: &str, background: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"title-v1\n");
    h.update(background.unwrap_or("").as_bytes());
    h.update(b"\n--\n");
    h.update(material.as_bytes());
    format!("{:x}", h.finalize())[..16].to_string()
}

#[derive(Debug, PartialEq)]
enum TitlePlan {
    /// 同样的材料问过了
    Skip,
    /// 指纹之前起的合格标题：补记指纹，不动标题
    Adopt,
    Ask,
}

/// 读对话之前的廉价判断：人手改过的不碰；临时标题只给还没有名字的新对话。
fn title_precheck(state: &crate::sessions::TitleState, early: bool) -> bool {
    !state.user_owned() && !(early && state.current_title().is_some())
}

fn plan_title(
    state: &crate::sessions::TitleState,
    basis: &str,
    has_background: bool,
    current_ready: bool,
) -> TitlePlan {
    // 起名规则收紧后（2026-10-28 主题 6–16 字、只写一件事），按旧规则起的标题即使材料没变也重起一回
    let outdated = state.current_title().is_some_and(|t| parse_kind_theme(t).is_none());
    match state.basis.as_deref() {
        Some(b) if b == basis && !outdated => TitlePlan::Skip,
        Some(_) => TitlePlan::Ask,
        // 有背景的老标题多半是照着开工语起的（「按简报做到完成标准」），借这次重起一回
        None if current_ready && !has_background => TitlePlan::Adopt,
        None => TitlePlan::Ask,
    }
}

#[derive(Debug, PartialEq)]
enum TitleOutcome {
    Titled(String),
    /// 不该起或不用起（手改过、内部、太短、材料没变……）：前端不要重试
    Skipped,
    /// 问了 AI 但没拿到合格标题（调用失败 / 格式不合）：可以过会儿再试
    Retry,
}

fn auto_title_session_impl(
    profiles: Vec<Profile>,
    agent: &str,
    session_id: &str,
    file_path: &str,
    created_at: Option<&str>,
    early: bool,
    meta: &dyn Fn() -> Option<crate::sessions::SessionMetaDto>,
    occupied: Option<&[String]>,
) -> Result<TitleOutcome, String> {
    if crate::sessions::session_marked_internal(agent, session_id) {
        return Ok(TitleOutcome::Skipped);
    }
    let state = crate::sessions::session_title_state(agent, session_id).unwrap_or_default();
    if !title_precheck(&state, early) {
        return Ok(TitleOutcome::Skipped);
    }
    let msgs = crate::sessions::conversation_impl(agent, file_path);
    if conversation_too_thin(&msgs) {
        return Ok(TitleOutcome::Skipped);
    }
    let mmdd = created_at.and_then(shanghai_mmdd).or_else(|| {
        first_message_timestamp(&msgs)
            .as_deref()
            .and_then(shanghai_mmdd)
    });
    let Some(mmdd) = mmdd else {
        return Ok(TitleOutcome::Skipped);
    };
    let material = user_title_material(&msgs, early);
    if material.trim().is_empty() {
        return Ok(TitleOutcome::Skipped);
    }
    let background = meta().as_ref().and_then(title_background);
    let basis = title_basis(&material, background.as_deref());
    let owned = occupied
        .map(|t| t.to_vec())
        .unwrap_or_else(|| crate::sessions::list_custom_titles_except(agent, session_id));
    let current_ready = state
        .current_title()
        .is_some_and(|t| mesa_auto_title_ready(t, &owned));
    match plan_title(&state, &basis, background.is_some(), current_ready) {
        TitlePlan::Skip => return Ok(TitleOutcome::Skipped),
        TitlePlan::Adopt => {
            crate::sessions::record_title_basis(agent, session_id, &basis)?;
            return Ok(TitleOutcome::Skipped);
        }
        TitlePlan::Ask => {}
    }
    let reference = pick_reference_titles(
        &owned,
        &format!("{}\n{material}", background.as_deref().unwrap_or("")),
        40,
    );
    let Ok(raw) = ai_prompt_impl(
        profiles,
        None,
        Some(FN_SUMMARIZE),
        build_session_title_prompt(&material, &mmdd, early, &reference, background.as_deref()),
    ) else {
        return Ok(TitleOutcome::Retry);
    };
    let Some((kind, theme)) = extract_title_candidate(&raw).and_then(|l| parse_kind_theme(&l))
    else {
        return Ok(TitleOutcome::Retry);
    };
    let title = crate::sessions::redact_sensitive_text(&format!("{mmdd}|{kind}|{theme}"));
    let title = uniquify_session_title(&title, &owned);
    if !crate::sessions::try_set_custom_title(agent, session_id, &title, Some(&basis))? {
        return Ok(TitleOutcome::Skipped);
    }
    Ok(TitleOutcome::Titled(title))
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

/// 自动起名：`stage=early` 只用首条用户问题，且只给还没有标题的新对话；默认/final 用用户侧首条+纠正+定题。
/// 人手改过的标题、内部会话、内容不足、没有创建日、或材料跟上次起名时一样则跳过（返回 None，前端不重试）；
/// 问了 AI 没拿到合格标题才返回 Err，前端过会儿再试。
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
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        auto_title_session_impl(
            profiles,
            &agent,
            &session_id,
            &file_path,
            created_at.as_deref(),
            early,
            &|| crate::sessions::find_session_sync(&agent, &session_id),
            None,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    match outcome {
        TitleOutcome::Titled(title) => Ok(Some(title)),
        TitleOutcome::Skipped => Ok(None),
        TitleOutcome::Retry => Err("这次没起出合格的标题".into()),
    }
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
    let mut states = crate::sessions::all_title_states();

    let mut taken: Vec<String> = Vec::new();
    let mut pending = Vec::new();
    for s in sessions {
        let state = states
            .remove(&(s.agent.clone(), s.session_id.clone()))
            .unwrap_or_default();
        if state.user_owned() {
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
        pending.push((s, state));
    }

    let mut renamed = 0u32;
    let mut skipped = 0u32;
    let mut failed = 0u32;
    for (s, state) in pending {
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
            // 合格的标题不读对话直接跳过；只有「有背景、还没按背景起过」的开工类老标题重起一回
            if mesa_auto_title_ready(cur, &taken)
                && (state.basis.is_some() || !has_background_hint(&s))
            {
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
            &|| Some(s.clone()),
            Some(&taken),
        ) {
            Ok(TitleOutcome::Titled(title)) => {
                taken.push(title);
                renamed += 1;
            }
            Ok(TitleOutcome::Skipped | TitleOutcome::Retry) => {
                if let Some(cur) = current.as_deref() {
                    let unique = uniquify_session_title(cur, &taken);
                    if unique != cur
                        && crate::sessions::try_set_custom_title(
                            &s.agent,
                            &s.session_id,
                            &unique,
                            None,
                        )
                        .unwrap_or(false)
                    {
                        taken.push(unique);
                        renamed += 1;
                        continue;
                    }
                    // 留着原标题的也算占用，后面的不能再撞上它
                    taken.push(cur.to_string());
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
    #[test]
    fn argv_safe_prompt_drops_nul_bytes() {
        assert_eq!(super::argv_safe_prompt("ab\0c\0".into()), "abc");
        assert_eq!(super::argv_safe_prompt("译这段".into()), "译这段");
    }

    /// 跨厂商复核真跑（2026-11-02，用户允许）：走定时任务同一条无头启动——密钥在本进程里从 keys.json 取、只注入子进程，
    /// 不经过命令行。MESA_RR_AGENT / MESA_RR_CWD（真实项目副本）/ MESA_RR_PROMPT（复核指令文件）；默认不跑。
    #[test]
    #[ignore]
    fn cross_review_real_run() {
        let (Ok(agent), Ok(cwd), Ok(prompt_file)) = (
            std::env::var("MESA_RR_AGENT"),
            std::env::var("MESA_RR_CWD"),
            std::env::var("MESA_RR_PROMPT"),
        ) else {
            return;
        };
        let store = crate::profiles::ProfileStore::new().unwrap();
        let mut list: Vec<Profile> = store.list().unwrap().into_iter().filter(|p| p.agent == agent).collect();
        if let Ok(id) = std::env::var("MESA_RR_PROFILE") {
            list.retain(|p| p.id == id);
        }
        list.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
        let profile = list.first().expect("这家没有可用连接");
        eprintln!("连接：{}；模型：{:?}", profile.name, profile.models.first());
        let prompt = std::fs::read_to_string(prompt_file).unwrap();
        match run_agent_task(profile, None, &prompt, std::path::Path::new(&cwd), Duration::from_secs(1500), None, false, None, None) {
            Ok((text, run)) => eprintln!("run={run}\n{}", tail_chars(&text, 3000)),
            Err(e) => eprintln!("失败：{}", tail_chars(&e, 3000)),
        }
    }

    /// 授权范围真跑（2026-11-08，默认不跑）：MESA_GR_AGENT=claude-code|codex，用这家最近用过的连接，按「只放行学术网站、
    /// 预算 $0.30」跑一次：让它访问学术接口、访问别的网站、往工作目录外写文件。断言目录外的文件没写成。
    #[test]
    #[ignore]
    fn grant_sandbox_real_run() {
        let Ok(agent) = std::env::var("MESA_GR_AGENT") else { return };
        let store = crate::profiles::ProfileStore::new().unwrap();
        let mut list: Vec<Profile> = store.list().unwrap().into_iter().filter(|p| p.agent == agent).collect();
        eprintln!("这家的连接：{:?}", list.iter().map(|p| (p.name.clone(), format!("{:?}", p.account_type), p.models.first().cloned())).collect::<Vec<_>>());
        if let Ok(name) = std::env::var("MESA_GR_PROFILE") {
            list.retain(|p| p.name == name || p.id == name);
        }
        list.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
        let profile = list.first().expect("这家没有可用连接");
        // 不放系统临时目录：各家沙箱都放行临时目录的写（装依赖、抽 PDF 文字要用），放那里测不出「目录外」
        let base = crate::dirs::home_dir().unwrap().join(format!(".ccode-grant-real-{}", uuid::Uuid::new_v4().simple()));
        let cwd = base.join("work");
        let outside = base.join("outside");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let target = outside.join("escaped.txt");
        let prompt = format!(
            "Run these shell commands one at a time and report each command's exit status and output in one line each. Do not try workarounds if one fails.\n\
             1) curl -s -o /dev/null -w '%{{http_code}}' --max-time 20 https://api.openalex.org/works\n\
             1b) curl -s --max-time 20 \"https://api.openalex.org/works?per-page=1\" | head -c 80\n\
             2) curl -s -o /dev/null -w '%{{http_code}}' --max-time 10 https://example.com\n\
             3) echo hi > {}\n\
             4) echo ok > inside.txt",
            target.display()
        );
        let grant = crate::grant::Grant { network: crate::grant::Network::Academic, budget_usd: Some(0.3) };
        // MESA_GR_NOTE=1：带上定时任务真实的授权说明，看它会不会按「被拦下：」逐条写出来
        let prompt = if std::env::var("MESA_GR_NOTE").is_ok() {
            format!(
                "Task: download the page https://example.com/ into page.html in the working directory using curl, then report.{}",
                crate::scheduler::grant_note(&grant)
            )
        } else {
            prompt
        };
        // 测试构建里 Codex 配置读的是空替身；真跑要按本机真实 config.toml 判断渠道有没有 auth
        crate::agents::set_test_codex_config(crate::agent_specs::codex_user_config());
        eprintln!("连接：{}", profile.name);
        let res = run_agent_task_granted(profile, None, &prompt, &cwd, Duration::from_secs(300), None, false, None, None, Some(&grant));
        match &res {
            Ok((text, run)) => eprintln!("run={run}\n{}", tail_chars(text, 3000)),
            Err(e) => eprintln!("失败：{}", tail_chars(e, 3000)),
        }
        if std::env::var("MESA_GR_NOTE").is_ok() {
            let text = res.as_ref().map(|(t, _)| t.clone()).unwrap_or_default();
            let blocked = crate::scheduler::blocked_lines(&text);
            eprintln!("认出的被拦下：{blocked:?}");
            assert!(!blocked.is_empty(), "应按「被拦下：」写出被拦的事");
        }
        let escaped = target.exists();
        let inside = cwd.join("inside.txt").exists();
        let _ = std::fs::remove_dir_all(&base);
        assert!(!escaped, "工作目录外的文件不该写成");
        eprintln!("工作目录内写成：{inside}");
    }

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
    fn followup_args_keep_resume_and_sandbox_without_restarting_business() {
        let args = followup_args("codex", headless_task_args("codex", "接着做"), Some("session".into())).unwrap();
        assert!(args.contains(&"resume".into()));
        assert!(args.contains(&"sandbox_mode=\"workspace-write\"".into()));
        assert!(!args.contains(&"-s".into()));
        assert_eq!(args.last().unwrap(), "接着做");
        assert_eq!(args[args.len() - 2], "session");
        assert!(followup_args("gemini", vec![], None).is_err());
        with_followup_round(Some("original".into()), || {
            let (session, args) = lock_headless_session("claude-code");
            assert_eq!(session.as_deref(), Some("original"));
            assert_eq!(args, ["-r", "original"]);
            let (agy_session, agy_args) = lock_headless_session("agy");
            assert_eq!(agy_session.as_deref(), Some("original"));
            assert_eq!(agy_args[..2], ["--conversation", "original"]);
        });
        assert!(!FOLLOWUP_OUTPUT.with(|value| value.get()));
        let agy_args = followup_args("agy", headless_task_args("agy", "第二轮"), Some("conv-1".into())).unwrap();
        assert_eq!(
            agy_args,
            vec!["--dangerously-skip-permissions", "-p", "第二轮", "--output-format", "stream-json"]
        );
        let agy_stream = concat!(
            r#"{"event":"init","conversation_id":"conv-1","init":{}}"#, "\n",
            r#"{"event":"step_update","step_type":"user_input","text_delta":"示例回执 MESA_FOLLOWUP_RECEIPT"}"#, "\n",
            r#"{"event":"step_update","step_type":"agent_response","text_delta":"真实助手"}"#, "\n",
            r#"{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"真实助手回复"}}"#, "\n"
        );
        assert_eq!(followup_text("agy", agy_stream).unwrap(), "真实助手回复");
        let init_val: serde_json::Value = serde_json::from_str(r#"{"event":"init","conversation_id":"conv-1"}"#).unwrap();
        assert_eq!(extract_stream_json_session_id(&init_val), Some("conv-1"));
    }

    #[test]
    #[ignore]
    fn followup_real_cli_roundtrip_local_gateway() {
        let endpoint = std::env::var("MESA_FOLLOWUP_ENDPOINT").expect("local gateway endpoint");
        assert!(endpoint.starts_with("http://127.0.0.1:"));
        let agent = std::env::var("MESA_FOLLOWUP_AGENT").unwrap_or_else(|_| "codex".into());
        let dir = std::env::temp_dir().join(format!("mesa-followup-cli-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let _config = crate::storage::redirect_config_root(&dir.join("config"));
        let mut profile = profile("local-probe", &agent, None);
        profile.no_auth = true;
        profile.protocol = Some(if agent == "claude-code" { "anthropic" } else { "openai" }.into());
        profile.base_url = Some(endpoint);
        let model = if agent == "claude-code" { "claude-sonnet-4-5" } else { "gpt-5" };
        profile.models = vec![model.into()];
        let mut prior_session = None;
        for round in 0..2 {
            let job = with_followup_round(prior_session.clone(), || build_headless_command_granted(&profile, Some(model), "TRIGGER_LONG 只返回给定文本，不做其他事", &dir, true, Some(&crate::grant::Grant::legacy_open()))).unwrap();
            let HeadlessCommand { mut cmd, lock_id, .. } = job;
            let home = dir.join("home"); fs::create_dir_all(&home).unwrap();
            for name in ["codex", "claude", "kimi"] { fs::create_dir_all(home.join(name)).unwrap(); }
            cmd.env("HOME", &home).env("CODEX_HOME", home.join("codex")).env("CLAUDE_CONFIG_DIR", home.join("claude")).env("KIMI_CODE_HOME", home.join("kimi"));
            cmd.env("CODEX_API_KEY", "local-test-placeholder").env("ANTHROPIC_API_KEY", "local-test-placeholder").env("KIMI_MODEL_API_KEY", "local-test-placeholder");
            if agent == "codex" { cmd.arg("--ignore-user-config"); }
            if agent == "claude-code" { cmd.args(["--strict-mcp-config", "--tools", "Read"]); }
            let result = crate::process::capture_command(&mut cmd, Duration::from_secs(90), 1024 * 1024).unwrap();
            let out = String::from_utf8_lossy(&result.stdout).into_owned();
            let err = String::from_utf8_lossy(&result.stderr).into_owned();
            fs::write(dir.join(format!("round-{round}.jsonl")), &out).unwrap();
            assert!(result.status.is_some_and(|status| status.success()), "{agent}: {out}\n{err}");
            let text = followup_text(&agent, &out).unwrap();
            assert!(text.contains("mesa-receipt"), "{text}");
            prior_session = lock_id.or_else(|| out.lines().find_map(|line| {
                let value: serde_json::Value = serde_json::from_str(line).ok()?;
                value.get("session_id").or_else(|| value.get("sessionId")).or_else(|| value.get("thread_id"))?.as_str().map(str::to_owned)
            }));
            assert!(prior_session.is_some(), "no session: {out}");
        }
        eprintln!("CLI_PROBE={agent} two rounds preserved session, output={}", dir.display());
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
    fn summarize_headless_error_explains_logged_out_and_unwraps_claude_json() {
        let claude = r#"{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}"#;
        assert!(summarize_headless_error(claude, None).contains("官方登录"));
        let expired = "Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` or `claude setup-token`.";
        assert!(summarize_headless_error(expired, None).contains("官方登录"));
        let other = r#"{"type":"result","is_error":true,"result":"API Error: 529 overloaded"}"#;
        assert_eq!(summarize_headless_error(other, None), "API Error: 529 overloaded");
        assert!(headless_oneshot_args("cursor", "hi").contains(&"--trust".to_string()));
    }

    #[test]
    fn summarize_headless_error_explains_gemini_individual_tier() {
        let dump = "Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products";
        let msg = summarize_headless_error(dump, None);
        assert!(msg.contains("个人 Google 账号") && msg.contains("API 连接"), "{msg}");
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
        // stream-json 在 result 之后还有一行 task_summary（2.1.3xx 实录，2026-11-11）：仍取 result
        let stream = format!(
            "{}\n{}\n{}",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"好"}]}}"#,
            ok,
            r#"{"type":"system","subtype":"task_summary","detail":null,"uuid":"u","session_id":"s"}"#
        );
        assert_eq!(parse_oneshot_output("claude-code", &stream, Some("glm-5.3"), "d").unwrap().0, "好的");
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
        assert_eq!(headless_args("agy", "你好"), vec!["-p", "你好"]);
        assert_eq!(
            headless_task_args("agy", "你好"),
            vec!["--dangerously-skip-permissions", "-p", "你好"]
        );
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
        // claude：不带权限档时第三方网关上什么都写不了，定时任务全部放行（同 grok --yolo）
        let claude = headless_task_args("claude-code", "你好");
        assert!(claude.starts_with(&headless_args("claude-code", "你好")));
        assert!(claude.ends_with(&["--permission-mode".to_string(), "bypassPermissions".to_string()]));
        // 其余 agent 与 headless_args 同形
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
    fn lower_effort_only_rewrites_an_existing_level() {
        let mut plan = agents::LaunchPlan::default();
        plan.env.push(("CLAUDE_CODE_EFFORT_LEVEL".into(), "xhigh".into()));
        lower_effort("claude-code", &mut plan, "low");
        assert_eq!(plan.env, vec![("CLAUDE_CODE_EFFORT_LEVEL".to_string(), "low".to_string())]);
        let mut none = agents::LaunchPlan::default();
        lower_effort("claude-code", &mut none, "low");
        assert!(none.env.is_empty(), "连接没设思考档的不加（加了不认的网关会 400）");
        let mut codex = agents::LaunchPlan::default();
        codex.args = vec!["-c".into(), r#"model_reasoning_effort="high""#.into()];
        lower_effort("codex", &mut codex, "low");
        assert_eq!(codex.args[1], r#"model_reasoning_effort="low""#);
        let stream = claude_stream_args("hi");
        assert!(stream.windows(2).any(|w| w == ["--output-format", "stream-json"]) && stream.iter().any(|a| a == "--verbose"));
    }

    #[test]
    fn feed_lines_waits_for_whole_lines() {
        let mut pending = Vec::new();
        let mut got: Vec<String> = Vec::new();
        let mut cb = |l: &str| got.push(l.to_string());
        feed_lines(&mut pending, b"{\"a\":1}\n{\"b\"", &mut cb);
        feed_lines(&mut pending, b":2}\n\n", &mut cb);
        assert_eq!(got, vec![r#"{"a":1}"#, r#"{"b":2}"#]);
    }

    #[test]
    fn inspect_readonly_args_are_read_only_and_ephemeral() {
        let claude = inspect_readonly_args("claude-code", "看看", &["/w/a".into()], false, &[], Some((2, 1, 318))).unwrap();
        assert!(claude.windows(2).any(|w| w == ["--permission-mode", "default"]), "不用 plan 档（会写 ~/.claude/plans）");
        // 新版：白名单正好三样只读工具、不加载 MCP，不再带黑名单
        assert!(claude.windows(2).any(|w| w == ["--tools", "Read Grep Glob"]));
        assert!(claude.iter().any(|a| a == "--strict-mcp-config"));
        assert!(!claude.iter().any(|a| a == "--disallowedTools"));
        // 老版本 / 读不到版本：退回黑名单，Windows 的 PowerShell 与建 worktree 也要拿掉
        for old in [Some((2, 1, 185)), None] {
            let a = inspect_readonly_args("claude-code", "看看", &[], false, &[], old).unwrap();
            assert!(!a.iter().any(|x| x == "--tools"));
            let disallowed = a.iter().position(|x| x == "--disallowedTools").map(|i| a[i + 1].clone()).unwrap();
            for tool in ["Edit", "Write", "Bash", "PowerShell", "EnterWorktree", "WebFetch"] {
                assert!(disallowed.split(' ').any(|t| t == tool), "{tool} 要拿掉");
            }
        }
        assert!(claude.iter().any(|a| a == "--no-session-persistence"));
        assert!(claude.windows(2).any(|w| w == ["--add-dir", "/w/a"]));
        assert!(!claude.iter().any(|a| a.contains("bypass")));
        let codex = inspect_readonly_args("codex", "看看", &[], false, &[], None).unwrap();
        assert!(codex.windows(2).any(|w| w == ["-s", "read-only"]));
        assert!(codex.iter().any(|a| a == "--ephemeral"));
        // plan 默认的 -s workspace-write 要被剥掉，只剩只读那一档
        let plan = vec!["-s".to_string(), "workspace-write".to_string()];
        let composed = compose_headless_args("codex", &plan, &codex);
        assert_eq!(composed.iter().filter(|a| *a == "-s").count(), 1);
        assert!(composed.windows(2).any(|w| w == ["-s", "read-only"]));
        assert!(inspect_readonly_args("kimi", "看看", &[], false, &[], None).is_none());
        assert!(inspect_readonly_args("gemini", "看看", &[], false, &[], None).is_none());
        assert!(inspect_readonly_args("agy", "看看", &[], false, &[], None).is_none());
        // 附图（2026-11-05）：Codex 一个 --image= 参数、在提示词前面；Claude 不加参数，靠提示词点名 + --add-dir
        let with_img = inspect_readonly_args("codex", "看看", &[], false, &["/t/a.png".into(), "/t/b.png".into()], None).unwrap();
        assert_eq!(&with_img[with_img.len() - 2..], ["--image=/t/a.png,/t/b.png", "看看"]);
        assert!(image_prompt_note("claude-code", &["/t/a.png".into()]).contains("Read 工具") );
        assert!(image_prompt_note("codex", &[]).is_empty());
        let streamed = inspect_readonly_args("claude-code", "看看", &[], true, &[], None).unwrap();
        assert!(streamed.windows(2).any(|w| w == ["--output-format", "stream-json"]));
        assert!(streamed.iter().any(|a| a == "--include-partial-messages") && streamed.iter().any(|a| a == "--verbose"));
        assert!(streamed.windows(2).any(|w| w == ["--permission-mode", "default"]));
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
        let t = build_session_title_prompt("[用户·首条] 加预设", "0908", true, &[], None);
        assert!(t.contains("类型|主题"));
        assert!(t.contains("0908"));
        assert!(t.contains("第一条真正的问题"));
        assert!(t.contains("[用户·首条] 加预设"));
        assert!(t.contains("6到16"));
        assert!(t.contains("只写一件事"));
        assert!(t.contains("对象+动作"));
        let t2 = build_session_title_prompt("[用户·定题] 改成雷达", "0908", false, &[], None);
        assert!(t2.contains("不要参考助手回复"));
        assert!(!t2.contains("第一条真正的问题"));
        let t3 = build_session_title_prompt(
            "[用户·首条] 加预设",
            "0908",
            true,
            &["0908|功能|Grok继续链合并去重".into()],
            None,
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
            cwd: None,
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
        assert!(parse_kind_theme("修复|登录异常").is_none());
        assert!(parse_kind_theme("修复|登录状态异常").is_some());
        assert!(parse_kind_theme("修复|一二三四五六七八九十一二三四五六七").is_none());
        // 英文两个字母算一个字：25 个字符的混排主题只有 17.5 字宽
        assert!(parse_kind_theme("修复|Codex退出遗留app-server孤儿进程回收").is_none());
        assert!(parse_kind_theme("修复|Codex退出遗留孤儿进程回收").is_some());
        // 一个标题只写一件事；合并 / 并行里的「并」不算
        assert!(parse_kind_theme("修复|tray编译错误并推送").is_none());
        assert!(parse_kind_theme("优化|图标以及配色调整").is_none());
        assert!(parse_kind_theme("功能|会话列表并行加载").is_some());
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

    fn title_state(title: Option<&str>, source: Option<&str>, basis: Option<&str>) -> crate::sessions::TitleState {
        crate::sessions::TitleState {
            custom_title: title.map(str::to_string),
            source: source.map(str::to_string),
            basis: basis.map(str::to_string),
        }
    }

    #[test]
    fn title_precheck_skips_user_titles_and_early_on_titled_sessions() {
        // 人手改过的、旧数据有标题没来源的：读对话、问 AI 之前就停
        assert!(!title_precheck(&title_state(Some("我的标题"), Some("user"), None), false));
        assert!(!title_precheck(&title_state(Some("旧标题"), None, None), false));
        // 临时标题只给还没名字的新对话：重开旧对话不再按首条覆盖
        assert!(!title_precheck(&title_state(Some("1020|修复|某某链路合并去重"), Some("auto"), None), true));
        assert!(title_precheck(&title_state(None, None, None), true));
        assert!(title_precheck(&title_state(Some("1020|修复|某某链路合并去重"), Some("auto"), None), false));
    }

    #[test]
    fn plan_title_reuses_same_material_and_adopts_old_titles() {
        let b = title_basis("[用户·首条] 把 Blender 的 MCP 加到预设里", None);
        assert_eq!(b, title_basis("[用户·首条] 把 Blender 的 MCP 加到预设里", None));
        assert_ne!(b, title_basis("[用户·首条] 把 Blender 的 MCP 加到预设里", Some("步骤：精读")));
        let auto = |basis: Option<&str>| title_state(Some("1020|功能|Blender预设加入MCP服务"), Some("auto"), basis);
        // 材料没变：不问
        assert_eq!(plan_title(&auto(Some(&b)), &b, false, true), TitlePlan::Skip);
        assert_eq!(plan_title(&auto(Some(&b)), &b, true, false), TitlePlan::Skip);
        // 材料没变但标题不合现行规则（旧规则下起的长标题）：重起一回
        let old = title_state(Some("1024|修复|tray.rs修Windows编译错误并推送"), Some("auto"), Some(&b));
        assert_eq!(plan_title(&old, &b, false, false), TitlePlan::Ask);
        // 材料变了（多聊了几轮）：问
        assert_eq!(plan_title(&auto(Some("other")), &b, false, true), TitlePlan::Ask);
        // 指纹之前的合格老标题：补记指纹，不换说法
        assert_eq!(plan_title(&auto(None), &b, false, true), TitlePlan::Adopt);
        // 开工类老标题（有背景）重起一回；不合格的照常问
        assert_eq!(plan_title(&auto(None), &b, true, true), TitlePlan::Ask);
        assert_eq!(plan_title(&auto(None), &b, false, false), TitlePlan::Ask);
        assert_eq!(plan_title(&title_state(None, None, None), &b, false, false), TitlePlan::Ask);
    }

    #[test]
    fn task_md_head_and_background() {
        let text = "# 综述大纲\n\n项目根：`/x`\n\n## 课题主题\n镁硫电池\n\n## 项目规则\n- 不虚构\n";
        assert_eq!(
            parse_task_md_head(text),
            (Some("综述大纲".into()), Some("镁硫电池".into()))
        );
        assert_eq!(parse_task_md_head("# test\n\n- 基准：master\n"), (Some("test".into()), None));
        assert_eq!(parse_task_md_head("## 课题主题\n\n## 其他\n"), (None, None));
        // 任务书标题跟步骤名一样时不重复写
        assert_eq!(
            format_title_background(Some("综述流程测试"), Some("综述大纲"), Some("综述大纲"), Some("镁硫电池")).as_deref(),
            Some("项目：综述流程测试\n步骤：综述大纲\n课题：镁硫电池")
        );
        // 只有项目名不算背景：普通对话照旧只看原话
        assert_eq!(format_title_background(Some("Ccode"), None, None, None), None);
        assert_eq!(format_title_background(None, Some(" "), None, None), None);
    }

    #[test]
    fn build_title_prompt_carries_background_only_when_present() {
        let with = build_session_title_prompt("[用户·首条] 读 TASK.md", "1015", false, &[], Some("步骤：文献检索"));
        assert!(with.contains("## 背景"));
        assert!(with.contains("步骤：文献检索"));
        let without = build_session_title_prompt("[用户·首条] 修个 bug", "1015", false, &[], None);
        assert!(!without.contains("## 背景"));
    }

    #[test]
    fn reference_titles_prefer_related_then_recent() {
        let mut taken: Vec<String> = (0..60).map(|i| format!("0901|功能|无关旧标题编号{i}")).collect();
        taken.insert(3, "0902|文档|文献检索筛选任务书定稿".into());
        let picked = pick_reference_titles(&taken, "[用户·首条] 敲定文献检索任务书", 10);
        assert_eq!(picked.len(), 10);
        // 老的同类标题被挑出来
        assert!(picked.contains(&"0902|文档|文献检索筛选任务书定稿".to_string()));
        // 其余用最近的补满，而不是最老的
        assert!(picked.contains(&"0901|功能|无关旧标题编号59".to_string()));
        assert!(!picked.contains(&"0901|功能|无关旧标题编号0".to_string()));
        assert_eq!(pick_reference_titles(&[], "随便", 10), Vec::<String>::new());
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

#[cfg(test)]
mod followup_text_tests {
    use super::followup_text;

    #[test]
    fn kimi_ignores_echoed_user_prompt() {
        let raw = concat!(
            "{\"role\":\"user\",\"content\":\"写完后回执 {\\\"state\\\":\\\"done\\\"}\"}\n",
            "{\"text\":\"{\\\"state\\\":\\\"done\\\"}\"}\n",
            "{\"role\":\"assistant\",\"content\":[{\"type\":\"think\",\"text\":\"想一想\"},{\"type\":\"text\",\"text\":\"好的\"}]}\n",
        );
        assert_eq!(followup_text("kimi", raw).unwrap(), "好的");
        let only_user = "{\"role\":\"user\",\"content\":\"{\\\"state\\\":\\\"done\\\"}\"}\n";
        assert!(followup_text("kimi", only_user).is_err());
    }
}
