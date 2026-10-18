//! Profile 三层验证：本地配置解析、CLI 启动预检、最小 models API 请求。
//! 密钥只在后端读取并注入请求/子进程，任何输出返回 React 前统一脱敏。

use crate::agents;
use crate::profiles::{self, Profile, ProfileStore};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

const CLI_TIMEOUT: Duration = Duration::from_secs(20);
const API_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationCheckDto {
    /// passed | failed | skipped
    pub status: String,
    pub message: String,
    pub latency_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileValidationDto {
    pub ok: bool,
    pub checked_at: String,
    pub local: ValidationCheckDto,
    pub cli: ValidationCheckDto,
    pub api: ValidationCheckDto,
}

fn check(status: &str, message: impl Into<String>, latency_ms: Option<u128>) -> ValidationCheckDto {
    ValidationCheckDto {
        status: status.into(),
        message: crate::sessions::redact_sensitive_text(&message.into()),
        latency_ms,
    }
}

fn result(
    local: ValidationCheckDto,
    cli: ValidationCheckDto,
    api: ValidationCheckDto,
) -> ProfileValidationDto {
    let ok = [&local, &cli, &api]
        .iter()
        .all(|item| item.status != "failed");
    ProfileValidationDto {
        ok,
        checked_at: crate::sessions::now_iso(),
        local,
        cli,
        api,
    }
}

fn parse_json_file(path: &Path, label: &str) -> Result<Option<String>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|e| format!("读取 {label} 失败: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{label} 不是合法 JSON: {e}"))?;
    if !value.is_object() {
        return Err(format!("{label} 根节点必须是对象"));
    }
    Ok(Some(label.into()))
}

fn parse_toml_file(path: &Path, label: &str) -> Result<Option<String>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|e| format!("读取 {label} 失败: {e}"))?;
    text.parse::<toml::Value>()
        .map_err(|e| format!("{label} 不是合法 TOML: {e}"))?;
    Ok(Some(label.into()))
}

pub(crate) fn validate_profile_fields(profile: &Profile) -> Result<Vec<String>, String> {
    if agents::binary_for(&profile.agent).is_none() {
        return Err(format!("未知 agent: {}", profile.agent));
    }
    if profile.account_type == profiles::AccountType::Official && profile.no_auth {
        return Err("官方账号不能设置为无密钥模式".into());
    }
    if profile.name.trim().is_empty() {
        return Err("配置名称不能为空".into());
    }
    if let Some(base_url) = profile.base_url.as_deref() {
        let url = reqwest::Url::parse(base_url).map_err(|e| format!("API 地址格式错误: {e}"))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("API 地址只支持 http/https".into());
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("API 地址不得内嵌用户名或密码".into());
        }
        validate_anthropic_base_url(profile, &url)?;
    }
    // 协议取值校验：合法值与缺省（第一个）都来自 AgentSpec.protocols；空表 = 无协议概念
    if let Some(spec) = crate::agent_specs::agent_spec(&profile.agent) {
        if let Some(default) = spec.protocols.first() {
            let value = profile.protocol.as_deref().unwrap_or(default);
            if !spec.protocols.contains(&value) {
                return Err(format!("{} 不支持协议 {value}", spec.display_name));
            }
        }
    }
    // grok 的 API 后端（绑定级，仅设为全局写 [model.*] 段消费）：闭集 + 仅 grok
    if let Some(backend) = profile.api_backend.as_deref() {
        if profile.agent != "grok" {
            return Err("apiBackend 仅 Grok Build 支持".into());
        }
        const GROK_BACKENDS: [&str; 3] = ["chat_completions", "responses", "messages"];
        if !GROK_BACKENDS.contains(&backend) {
            return Err(format!(
                "Grok 不支持 API 后端 {backend}（可选 chat_completions / responses / messages）"
            ));
        }
    }
    for key in profile.extra_env.keys() {
        if key.trim().is_empty() || key.contains('=') || key.contains('\0') {
            return Err(format!("附加环境变量名不合法: {key:?}"));
        }
    }
    let policy = &profile.request_policy;
    if let Some(v) = policy.temperature {
        if !v.is_finite() || !(0.0..=2.0).contains(&v) {
            return Err("temperature 必须是 0 到 2 之间的有限数字".into());
        }
    }
    if let Some(v) = policy.top_p {
        if !v.is_finite() || !(0.0..=1.0).contains(&v) {
            return Err("topP 必须是 0 到 1 之间的有限数字".into());
        }
    }
    if matches!(policy.max_output_tokens, Some(0)) {
        return Err("maxOutputTokens 必须大于 0".into());
    }
    if policy
        .reasoning_effort
        .as_deref()
        .is_some_and(|v| v.trim().is_empty())
    {
        return Err("reasoningEffort 不能为空".into());
    }
    // claude-code 的 effort 档位有实证闭集（/effort 与 CLAUDE_CODE_EFFORT_LEVEL 同口径，
    // matrix §1 v2.1.212 strings 实证）——保存期拦掉无效值，免得启动才被 CLI 拒
    if profile.agent == "claude-code" {
        if let Some(v) = policy.reasoning_effort.as_deref() {
            const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
            if !EFFORTS.contains(&v) {
                return Err(format!(
                    "Claude Code 的 reasoningEffort 只接受 {}",
                    EFFORTS.join(" / ")
                ));
            }
        }
    }
    for (header, env_name) in &policy.header_env {
        // header 名禁冒号/引号/控制符（引号会撞 codex TOML 内联键的引号段）
        if header.trim().is_empty() || header.contains(['\r', '\n', ':', '"']) {
            return Err(format!("模型 Header 名不合法: {header:?}"));
        }
        // 环境变量名收 POSIX 字符集：值会进 codex -c 的 TOML 字符串与 shell，
        // 放宽字符集会留出注入面
        let valid_env_name = env_name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && env_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid_env_name {
            return Err(format!("模型 Header 环境变量名不合法: {env_name:?}"));
        }
    }
    if profile.no_auth {
        // 认证变量闭集单一出处：profiles::AUTH_BEARING_ENV（导出剔除查同一张表，防两处名单漂移）
        if let Some(key) = profile
            .extra_env
            .keys()
            .find(|key| crate::profiles::auth_bearing_env_name(key))
        {
            return Err(format!("无密钥模式不能附加认证变量 {key}"));
        }
    }
    if profile.extra_env.values().any(|value| value.contains('\0')) {
        return Err("附加环境变量值不得包含 NUL 字符".into());
    }
    let mut notes = Vec::new();
    let support = crate::agent_specs::request_policy_support(&profile.agent);
    let policy = &profile.request_policy;
    if policy.temperature.is_some()
        || policy.top_p.is_some()
        || policy.max_output_tokens.is_some()
        || policy.reasoning_effort.is_some()
        || !policy.header_env.is_empty()
    {
        notes.push("请求策略按能力表逐字段处理：有实证通道的字段在启动时注入（已接线 claude-code/codebuddy/codex/opencode/kimi/grok，qwen 仅 max output 一条 env），不支持或未知的字段仅保存声明、不会伪造注入".into());
    }
    // 通道表按入口记账（inject/persist/tui/unsupported/unknown），提示文案分入口
    let channel_note = |label: &str, status: &str| -> Option<String> {
        match status {
            "inject" => None,
            "persist" => Some(format!(
                "{label} 的通道是「设为全局默认」写入 CLI 配置文件；启动注入不携带此字段"
            )),
            "tui" => Some(format!(
                "{label} 仅支持会话内原生命令切换（如 /effort），启动与写盘均不携带"
            )),
            other => Some(format!(
                "当前 Agent 对 {label} 的协议支持状态为 {other}，不会由 Mesa 强行注入"
            )),
        }
    };
    if let Some(note) = policy
        .temperature
        .is_some()
        .then(|| channel_note("temperature", support.temperature))
        .flatten()
    {
        notes.push(note);
    }
    if let Some(note) = policy
        .top_p
        .is_some()
        .then(|| channel_note("topP", support.top_p))
        .flatten()
    {
        notes.push(note);
    }
    if let Some(note) = policy
        .max_output_tokens
        .is_some()
        .then(|| channel_note("maxOutputTokens", support.max_output_tokens))
        .flatten()
    {
        notes.push(note);
    }
    if let Some(note) = policy
        .reasoning_effort
        .is_some()
        .then(|| channel_note("reasoningEffort", support.reasoning_effort))
        .flatten()
    {
        notes.push(note);
    }
    if !policy.header_env.is_empty() {
        if let Some(note) = channel_note("模型自定义 Header", support.custom_headers) {
            notes.push(note);
        }
    }
    if profile.models.is_empty() {
        notes.push("未指定模型，将使用 CLI 自身默认值".into());
    }
    // grok 的 api_backend 只随设为全局落盘，启动注入不携带——只提醒不阻断
    if profile.agent == "grok" && profile.api_backend.is_some() {
        notes.push("API 后端（apiBackend）只在「设为全局默认」写入 ~/.grok/config.toml 后生效；启动注入不携带此设置".into());
    }
    // Anthropic 协议通道的 SDK 会在 Base URL 后自动拼 /v1/messages：base 以 /v1 结尾会打成
    // /v1/v1/messages 404（2026-08-28 实测），且「获取模型」（OpenAI 风格 {base}/models）照样成功，
    // 极具迷惑性——只提醒不阻断
    let anthropic_wire = matches!(profile.agent.as_str(), "claude-code" | "codebuddy")
        || profile.protocol.as_deref() == Some("anthropic");
    if anthropic_wire {
        if let Some(base) = profile.base_url.as_deref() {
            if base.trim_end_matches('/').ends_with("/v1") {
                notes.push(
                    "Base URL 以 /v1 结尾：Anthropic 客户端会自动拼 /v1/messages，实际请求将变成 /v1/v1/messages 报 404（此时「获取模型」仍能成功，不代表运行可用）——请去掉末尾的 /v1"
                        .into(),
                );
            }
        }
    }
    Ok(notes)
}

/// Anthropic-compatible CLIs append `/v1/messages` themselves. A full resource
/// URL here would become `/v1/messages/v1/messages` and fail at runtime.
fn validate_anthropic_base_url(profile: &Profile, url: &reqwest::Url) -> Result<(), String> {
    let anthropic = matches!(profile.agent.as_str(), "claude-code" | "codebuddy")
        || profile.protocol.as_deref() == Some("anthropic");
    if !anthropic {
        return Ok(());
    }
    let path = url.path().trim_end_matches('/');
    if path.ends_with("/messages") {
        return Err(
            "Anthropic 兼容端点不能填写完整 /messages 地址；请填写基础 URL（CLI 会自动追加 /v1/messages）"
                .into(),
        );
    }
    Ok(())
}

/// 槽位名 → 该槽的完整端点后缀（可多个）。用户把「完整端点」当基础 URL 填进槽时，
/// CLI 会在后面再追加一遍自己的后缀，静默变成 404。原先只校验 anthropic 槽，
/// 另外四槽可以存进任意字符串（含空格、非 URL 全文）——这里统一成一张表。
///
/// gemini 两条：`/v1beta/models/gemini-3-pro:generateContent` 用的是冒号形式，
/// 只写 `/generateContent` 会漏掉它——而这恰恰是官方文档里最常被照抄的形状。
pub(crate) const SLOT_ENDPOINT_SUFFIXES: &[(&str, &[&str], &str)] = &[
    ("anthropic", &["/messages"], "CLI 会自动追加 /v1/messages"),
    (
        "openai",
        &["/chat/completions"],
        "CLI 会自动追加 /chat/completions",
    ),
    ("responses", &["/responses"], "CLI 会自动追加 /responses"),
    (
        "gemini",
        &["/generateContent", ":generateContent"],
        "CLI 会自动追加 /v1beta/models/<模型>:generateContent",
    ),
    (
        "cursor",
        &["/chat/completions"],
        "CLI 会自动追加 /chat/completions",
    ),
];

/// 逐槽校验地址：格式必须可解析，且不得已经包含该槽的完整端点后缀。
/// 空槽是合法状态（缺槽由绑定侧的 `slot_missing` 报，不在这里拦）。
pub(crate) fn validate_slot_urls(slots: &crate::profiles::ProtocolSlots) -> Result<(), String> {
    let entries: [(&str, Option<&str>); 5] = [
        ("anthropic", slots.anthropic.as_deref()),
        ("openai", slots.openai.as_deref()),
        ("responses", slots.responses.as_deref()),
        ("gemini", slots.gemini.as_deref()),
        ("cursor", slots.cursor.as_deref()),
    ];
    for (slot, url) in entries {
        let Some(url) = url.filter(|s| !s.trim().is_empty()) else {
            continue;
        };
        let parsed = reqwest::Url::parse(url).map_err(|e| format!("{slot} 槽地址格式错误: {e}"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(format!(
                "{slot} 槽地址必须以 http:// 或 https:// 开头（当前：{}）",
                parsed.scheme()
            ));
        }
        if parsed.host_str().is_none() {
            return Err(format!("{slot} 槽地址缺少主机名"));
        }
        let Some((_, suffixes, hint)) = SLOT_ENDPOINT_SUFFIXES
            .iter()
            .find(|(name, _, _)| *name == slot)
        else {
            continue;
        };
        let path = parsed.path().trim_end_matches('/');
        if let Some(suffix) = suffixes.iter().find(|suffix| path.ends_with(**suffix)) {
            return Err(format!(
                "{slot} 槽不能填写完整 {suffix} 地址；请填写基础 URL（{hint}）"
            ));
        }
    }
    Ok(())
}

fn local_check_at(home: &Path, profile: &Profile) -> ValidationCheckDto {
    let started = Instant::now();
    let outcome = (|| -> Result<String, String> {
        let notes = validate_profile_fields(profile)?;
        let mut parsed = Vec::new();
        let mut add = |item: Result<Option<String>, String>| -> Result<(), String> {
            if let Some(label) = item? {
                parsed.push(label);
            }
            Ok(())
        };
        match profile.agent.as_str() {
            "claude-code" => add(parse_json_file(
                &home.join(".claude/settings.json"),
                "~/.claude/settings.json",
            ))?,
            "codex" => {
                add(parse_toml_file(
                    &home.join(".codex/config.toml"),
                    "~/.codex/config.toml",
                ))?;
                add(parse_json_file(
                    &home.join(".codex/auth.json"),
                    "~/.codex/auth.json",
                ))?;
            }
            "gemini" => add(parse_json_file(
                &home.join(".gemini/settings.json"),
                "~/.gemini/settings.json",
            ))?,
            "qwen" => add(parse_json_file(
                &home.join(".qwen/settings.json"),
                "~/.qwen/settings.json",
            ))?,
            "codebuddy" => add(parse_json_file(
                &home.join(".codebuddy/settings.json"),
                "~/.codebuddy/settings.json",
            ))?,
            // grok 主配置是 TOML（[model.<name>] 段的 base_url/env_key 线索在 profile 字段已验）
            "grok" => add(parse_toml_file(
                &home.join(".grok/config.toml"),
                "~/.grok/config.toml",
            ))?,
            // cursor 仅 AGENT_CLI_CREDENTIAL_STORE=file 时落 auth.json（默认在钥匙串）
            "cursor" => add(parse_json_file(
                &home.join(".cursor/auth.json"),
                "~/.cursor/auth.json",
            ))?,
            "opencode" => add(parse_json_file(
                &home.join(".config/opencode/opencode.json"),
                "~/.config/opencode/opencode.json",
            ))?,
            "kimi" => {
                add(parse_toml_file(
                    &home.join(".kimi-code/config.toml"),
                    "~/.kimi-code/config.toml",
                ))?;
                add(parse_toml_file(
                    &home.join(".kimi/config.toml"),
                    "~/.kimi/config.toml",
                ))?;
            }
            _ => {}
        }
        let mut message = if parsed.is_empty() {
            "Profile 字段合法；未发现该 CLI 的现有全局配置文件".to_string()
        } else {
            format!("Profile 字段合法；已解析 {}", parsed.join("、"))
        };
        if !notes.is_empty() {
            message.push_str(&format!("；{}", notes.join("；")));
        }
        Ok(message)
    })();
    match outcome {
        Ok(message) => check("passed", message, Some(started.elapsed().as_millis())),
        Err(message) => check("failed", message, Some(started.elapsed().as_millis())),
    }
}

fn tail_chars(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        text.to_string()
    } else {
        chars[chars.len() - max..].iter().collect()
    }
}

fn head_chars(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        text.to_string()
    } else {
        chars[..max].iter().collect()
    }
}

fn exit_code_label(code: Option<i32>) -> String {
    match code {
        Some(code) => format!("CLI 退出码 {code}"),
        None => "CLI 异常退出".into(),
    }
}

fn capture_cli(
    cmd: &mut crate::process::BackgroundCommand,
    timeout: Duration,
) -> Result<crate::process::CapturedOutput, String> {
    let captured = crate::process::capture_command(cmd, timeout, 1024 * 1024)?;
    if captured.cancelled {
        return Err("CLI 预检已取消".into());
    }
    if captured.timed_out {
        return Err(format!("CLI 预检超时（{} 秒）", timeout.as_secs()));
    }
    if captured.truncated {
        return Err("CLI 预检输出超过 1 MB 安全上限".into());
    }
    Ok(captured)
}

fn capture_text(captured: &crate::process::CapturedOutput) -> String {
    let stdout = String::from_utf8_lossy(&captured.stdout);
    let stderr = String::from_utf8_lossy(&captured.stderr);
    let stdout_t = stdout.trim();
    let stderr_t = stderr.trim();
    if stdout_t.starts_with('{') {
        stdout_t.to_string()
    } else if stderr_t.starts_with('{') {
        stderr_t.to_string()
    } else if stderr_t.is_empty() {
        stdout_t.to_string()
    } else {
        stderr_t.to_string()
    }
}

fn first_nonempty_line(text: &str) -> &str {
    text.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
}

fn parse_json_value(text: &str) -> Option<serde_json::Value> {
    let trimmed = text.trim();
    let start = trimmed.find('{')?;
    let slice = &trimmed[start..];
    serde_json::from_str(slice).ok().or_else(|| {
        let mut de = serde_json::Deserializer::from_str(slice);
        serde_json::Value::deserialize(&mut de).ok()
    })
}

fn is_codex_doctor_report(value: &serde_json::Value) -> bool {
    value.get("checks").is_some()
        || value.get("overallStatus").is_some()
        || value.get("schemaVersion").is_some()
}

fn doctor_check_is_relevant(id: &str, category: &str) -> bool {
    const RELEVANT: [&str; 2] = ["auth", "config"];
    RELEVANT.iter().any(|name| {
        category.eq_ignore_ascii_case(name)
            || id.eq_ignore_ascii_case(name)
            || id
                .split_once('.')
                .is_some_and(|(prefix, _)| prefix.eq_ignore_ascii_case(name))
    })
}

fn doctor_status_is_fail(status: &str) -> bool {
    matches!(status, "fail" | "failed" | "error")
}

struct DoctorCheckRef<'a> {
    id: &'a str,
    category: &'a str,
    status: &'a str,
    summary: &'a str,
}

fn doctor_checks(report: &serde_json::Value) -> Vec<DoctorCheckRef<'_>> {
    let Some(checks) = report.get("checks") else {
        return Vec::new();
    };
    match checks {
        serde_json::Value::Object(map) => map
            .iter()
            .map(|(key, value)| DoctorCheckRef {
                id: value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or(key.as_str()),
                category: value.get("category").and_then(|v| v.as_str()).unwrap_or(""),
                status: value.get("status").and_then(|v| v.as_str()).unwrap_or(""),
                summary: value.get("summary").and_then(|v| v.as_str()).unwrap_or(""),
            })
            .collect(),
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|value| {
                Some(DoctorCheckRef {
                    id: value.get("id").and_then(|v| v.as_str())?,
                    category: value.get("category").and_then(|v| v.as_str()).unwrap_or(""),
                    status: value.get("status").and_then(|v| v.as_str()).unwrap_or(""),
                    summary: value.get("summary").and_then(|v| v.as_str()).unwrap_or(""),
                })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn format_doctor_check(check: &DoctorCheckRef<'_>) -> String {
    if check.summary.is_empty() {
        check.id.to_string()
    } else {
        format!("{} — {}", check.id, check.summary)
    }
}

/// Codex 0.154+ `doctor --json` 把本机体检整包打成 overallStatus=fail / exit 1。
/// 注入自定义 provider 时，中转探测 404 会记成 reachability fail；会话库、桌面 CDN
/// 等也与 Mesa 这条配置无关。CLI 层只认 config/auth，连通性归 API 层。
fn interpret_codex_doctor(output: &str, exit_code: Option<i32>) -> Result<String, String> {
    let parsed = parse_json_value(output).filter(is_codex_doctor_report);
    let Some(report) = parsed else {
        if exit_code == Some(0) {
            let suffix = first_nonempty_line(output);
            return Ok(if suffix.is_empty() {
                "Codex doctor 通过".into()
            } else {
                format!("Codex doctor 通过：{}", head_chars(suffix, 200))
            });
        }
        return Err(format!(
            "{}: {}",
            exit_code_label(exit_code),
            head_chars(output.trim(), 400)
        ));
    };
    let checks = doctor_checks(&report);
    let relevant_fails: Vec<_> = checks
        .iter()
        .filter(|item| {
            doctor_check_is_relevant(item.id, item.category) && doctor_status_is_fail(item.status)
        })
        .collect();
    if !relevant_fails.is_empty() {
        let detail = relevant_fails
            .iter()
            .map(|item| format_doctor_check(item))
            .collect::<Vec<_>>()
            .join("；");
        return Err(format!("Codex doctor 未通过：{detail}"));
    }
    let other_fails = checks.iter().any(|item| {
        !doctor_check_is_relevant(item.id, item.category) && doctor_status_is_fail(item.status)
    });
    if other_fails {
        Ok("Codex doctor 通过：配置与认证正常；端点连通性以 API 层为准".into())
    } else {
        Ok("Codex doctor 通过".into())
    }
}

fn codex_config_args(plan: &agents::LaunchPlan) -> Vec<String> {
    let mut args = Vec::new();
    let mut index = 0;
    while index < plan.args.len() {
        if plan.args[index] == "-c" && index + 1 < plan.args.len() {
            args.push("-c".into());
            args.push(plan.args[index + 1].clone());
            index += 2;
        } else {
            index += 1;
        }
    }
    args
}

fn cli_check(profile: &Profile, key: Option<&str>, injected: bool) -> ValidationCheckDto {
    let started = Instant::now();
    let outcome = (|| -> Result<String, String> {
        let binary = agents::binary_for(&profile.agent).ok_or("该 agent 不支持 CLI 预检")?;
        let binary =
            agents::resolve_binary(binary).ok_or_else(|| format!("未找到 {binary} CLI"))?;
        let plan = agents::launch_plan(
            profile,
            key.map(ToOwned::to_owned),
            profile.models.first().map(String::as_str),
        )?;
        let mut cmd = crate::process::background_command(binary);
        if injected {
            for (name, value) in &plan.env {
                cmd.env(name, value);
            }
        }
        let description = match profile.agent.as_str() {
            "claude-code" if key.is_some() => {
                cmd.args(["auth", "status", "--json"]);
                "Claude auth status"
            }
            "claude-code" => {
                cmd.arg("--version");
                "Claude 启动预检（未配置密钥，跳过 auth status）"
            }
            "codex" => {
                if injected {
                    cmd.args(codex_config_args(&plan));
                }
                cmd.args(["doctor", "--json"]);
                "Codex doctor"
            }
            "opencode" => {
                cmd.args(["debug", "config"]);
                "OpenCode resolved config"
            }
            "kimi" => {
                cmd.arg("doctor");
                "Kimi doctor"
            }
            "gemini" => {
                cmd.arg("--version");
                "Gemini 启动预检（CLI 暂无 doctor）"
            }
            "qwen" => {
                cmd.arg("--version");
                "Qwen 启动预检（CLI 暂无 doctor）"
            }
            "codebuddy" => {
                cmd.arg("--version");
                "CodeBuddy 启动预检（CLI 暂无 doctor）"
            }
            "grok" => {
                cmd.arg("--version");
                "Grok 启动预检（CLI 暂无 doctor）"
            }
            "cursor" => {
                cmd.arg("--version");
                "Cursor 启动预检（CLI 暂无 doctor）"
            }
            _ => return Err("该 agent 不支持 CLI 预检".into()),
        };
        cmd.env("NO_COLOR", "1");
        let cwd = std::env::temp_dir().join(format!("ccode-validate-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&cwd).map_err(|e| format!("创建预检目录失败: {e}"))?;
        cmd.current_dir(&cwd);
        let captured = capture_cli(&mut cmd, CLI_TIMEOUT);
        let _ = fs::remove_dir_all(&cwd);
        let captured = captured?;
        let text = capture_text(&captured);
        let exit_code = captured.status.and_then(|s| s.code());
        if profile.agent == "codex" {
            return interpret_codex_doctor(&text, exit_code);
        }
        if captured.status.is_some_and(|s| s.success()) {
            let suffix = first_nonempty_line(&text);
            return Ok(if suffix.is_empty() {
                format!("{description} 通过")
            } else {
                format!("{description} 通过：{suffix}")
            });
        }
        Err(format!(
            "{}: {}",
            exit_code_label(exit_code),
            head_chars(text.trim(), 400)
        ))
    })();
    match outcome {
        Ok(message) => check("passed", message, Some(started.elapsed().as_millis())),
        Err(message) => check("failed", message, Some(started.elapsed().as_millis())),
    }
}

#[derive(Clone, Copy)]
enum ApiKind {
    OpenAi,
    Anthropic,
    /// OpenAI Responses 线格式（POST {base}/responses、input 单字符串、
    /// reasoning.effort）——codex 与 grok 的 responses 后端实际流量形状
    Responses,
    Gemini,
}

fn api_kind(profile: &Profile) -> ApiKind {
    match profile.agent.as_str() {
        // codebuddy 协议 Anthropic 兼容（docs 有 DeepSeek Anthropic 端点对接示例）
        "claude-code" | "codebuddy" => ApiKind::Anthropic,
        "gemini" => ApiKind::Gemini,
        // codex 走 Responses 线格式：chat/completions 形状探针会被 GLM 这类
        // Responses-only 网关拒掉（实测 403 model_access_denied），却放行 /responses
        "codex" => ApiKind::Responses,
        "qwen" | "kimi" if profile.protocol.as_deref() == Some("anthropic") => ApiKind::Anthropic,
        // grok 绑定声明了 messages 后端（仅设为全局写入生效）→ 探针走 Anthropic 形状
        "grok" if profile.api_backend.as_deref() == Some("messages") => ApiKind::Anthropic,
        "grok" if profile.api_backend.as_deref() == Some("responses") => ApiKind::Responses,
        _ => ApiKind::OpenAi,
    }
}

fn anthropic_uses_bearer(profile: &Profile) -> bool {
    matches!(profile.agent.as_str(), "claude-code" | "codebuddy" | "grok")
}

/// 协议族标签（profiles::copy_to_agent 的兼容性判定用）。与 api_kind 同口径，
/// 唯一差异是 cursor：api_kind 因 `_` 兜底落入 OpenAi 仅用于跳过云端验证，
/// 复制判定时 Cursor 是专有协议（见 api_check 注释），自成一族不与任何 agent 互通
pub(crate) fn api_kind_label(agent: &str, protocol: Option<&str>) -> &'static str {
    match agent {
        "claude-code" | "codebuddy" => "anthropic",
        "gemini" => "gemini",
        "cursor" => "cursor",
        "qwen" | "kimi" if protocol == Some("anthropic") => "anthropic",
        _ => "openai",
    }
}

fn default_base(profile: &Profile, kind: ApiKind) -> &'static str {
    match kind {
        // codebuddy 缺省端点：官方国际站（product.json 的 endpoint 字段）
        ApiKind::Anthropic if profile.agent == "codebuddy" => "https://www.codebuddy.ai",
        ApiKind::Anthropic => "https://api.anthropic.com/v1",
        ApiKind::Gemini => "https://generativelanguage.googleapis.com/v1beta",
        ApiKind::OpenAi if profile.agent == "kimi" => "https://api.moonshot.cn/v1",
        ApiKind::OpenAi if profile.agent == "grok" => "https://api.x.ai/v1",
        ApiKind::OpenAi | ApiKind::Responses => "https://api.openai.com/v1",
    }
}

fn models_url(base: &str, kind: ApiKind) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base).map_err(|e| format!("API 地址格式错误: {e}"))?;
    let path = url.path().trim_end_matches('/');
    // 与 chat_url 同口径：版本段结尾直接拼 models，否则补协议默认版本段
    let suffix = if crate::models::ends_with_version_segment(path) {
        "models"
    } else {
        match kind {
            ApiKind::Gemini => "v1beta/models",
            _ => "v1/models",
        }
    };
    let next = if path.is_empty() {
        format!("/{suffix}")
    } else if path.ends_with("/models") {
        path.to_string()
    } else {
        format!("{path}/{suffix}")
    };
    url.set_path(&next);
    Ok(url)
}

fn model_ids(value: &serde_json::Value, kind: ApiKind) -> Vec<String> {
    let entries = match kind {
        ApiKind::Gemini => value.get("models"),
        // Responses 形状目录：OpenAI 官方回 data[].id；GLM 的 codex 目录回
        // models[].slug（实测 2026-09-17，条目带 context_window/display_name）
        ApiKind::Responses => value
            .get("models")
            .filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
            .or_else(|| value.get("data")),
        _ => value.get("data"),
    };
    entries
        .and_then(|item| item.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let key = match kind {
                ApiKind::Gemini => "name",
                ApiKind::Responses if item.get("slug").is_some() => "slug",
                _ => "id",
            };
            item.get(key)
                .and_then(|value| value.as_str())
                .map(|value| value.trim_start_matches("models/").to_string())
        })
        .collect()
}

async fn api_check(profile: &Profile, key: Option<&str>) -> ValidationCheckDto {
    // Cursor 是专有协议（非 OpenAI/Anthropic 兼容），models 请求形态无从适配——
    // 不硬套三种 ApiKind，标记不支持云端验证，只给本地两层检查
    if profile.agent == "cursor" {
        return check(
            "skipped",
            "Cursor 为专有协议，不支持云端验证；以本地配置解析与 CLI 预检为准",
            None,
        );
    }
    let Some(key) = key.filter(|value| !value.trim().is_empty()) else {
        return check(
            "skipped",
            "未保存 API 密钥，无法验证 endpoint、密钥和模型（CLI 登录配置仍可单独使用）",
            None,
        );
    };
    let started = Instant::now();
    let outcome = async {
        let kind = api_kind(profile);
        let base = profile
            .base_url
            .as_deref()
            .unwrap_or_else(|| default_base(profile, kind));
        let mut url = models_url(base, kind)?;
        let client = reqwest::Client::builder()
            .timeout(API_TIMEOUT)
            .build()
            .map_err(|e| format!("创建 API 客户端失败: {e}"))?;
        let mut request = client.get(url.clone());
        match kind {
            ApiKind::OpenAi | ApiKind::Responses => {
                request = request.bearer_auth(key);
            }
            ApiKind::Anthropic => {
                request = if anthropic_uses_bearer(profile) {
                    request.bearer_auth(key)
                } else {
                    request.header("x-api-key", key)
                }
                .header("anthropic-version", "2023-06-01");
            }
            ApiKind::Gemini => {
                url.query_pairs_mut().append_pair("key", key);
                request = client.get(url.clone());
            }
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("无法访问 API endpoint: {e}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| format!("读取 API 响应失败: {e}"))?;
        if !status.is_success() {
            let detail = tail_chars(body.trim(), 500);
            return Err(match status.as_u16() {
                401 | 403 => format!("密钥被端点拒绝（HTTP {status}）——密钥可能填错、过期或已被吊销，请核对后重新填写。{detail}"),
                404 | 405 => format!("模型列表接口不存在，可能是 endpoint 或协议不匹配（HTTP {status}）：{detail}"),
                _ => format!("API 返回 HTTP {status}：{detail}"),
            });
        }
        let value: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("API 响应不是预期 JSON，可能协议不匹配: {e}"))?;
        let ids = model_ids(&value, kind);
        if ids.is_empty() {
            return Err("endpoint 与密钥可访问，但响应中没有可识别的模型列表，无法确认协议和模型".into());
        }
        if let Some(model) = profile.models.first() {
            if !ids.iter().any(|id| id == model) {
                return Err(format!("密钥与 endpoint 可访问，但模型 {model} 不在返回列表中"));
            }
            Ok(format!("endpoint、密钥和模型 {model} 均通过"))
        } else {
            Ok(format!("endpoint 与密钥通过，共返回 {} 个模型", ids.len()))
        }
    }
    .await;
    match outcome {
        Ok(message) => check("passed", message, Some(started.elapsed().as_millis())),
        Err(message) => check("failed", message, Some(started.elapsed().as_millis())),
    }
}

// ===== 网关体检探针（2026-08-28）：绕过 CLI 直连端点发最小请求，观测裸响应 =====
// 回答「网关把请求怎么了」：流式还是整段、请求策略参数被接受还是被拒/触发降级。
// 探针只发 max_tokens=16 的 ping，单次成本可忽略；它证明的是「网关对这种请求的行为」，
// 是 CLI 实际流量的强代理证据（要 100% 还原 CLI 流量只能靠 CLI 自身 debug 日志，不属于本探针）。
// 密钥不出本模块；所有出站文案经 check() 统一脱敏。

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayProbeDto {
    pub ok: bool,
    pub model: String,
    pub checks: Vec<ValidationCheckDto>,
}

/// 对话端点 URL：与 models_url 同口径——base 末段是版本段（/v1、/v1beta、/v4 …）
/// 直接拼资源名；否则补协议默认版本段。GLM 的 /api/paas/v4 属于前者（补 /v1 会 404）
fn chat_url(base: &str, kind: ApiKind) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base).map_err(|e| format!("API 地址格式错误: {e}"))?;
    let path = url.path().trim_end_matches('/');
    if matches!(kind, ApiKind::Anthropic) && path.ends_with("/messages") {
        return Err(
            "Anthropic 兼容端点不能填写完整 /messages 地址；请填写基础 URL（CLI 会自动追加 /v1/messages）"
                .into(),
        );
    }
    let (version, resource) = match kind {
        ApiKind::Anthropic => ("v1", "messages"),
        ApiKind::OpenAi => ("v1", "chat/completions"),
        ApiKind::Responses => ("v1", "responses"),
        ApiKind::Gemini => return Err("Gemini 协议暂不支持探针".into()),
    };
    let next = if crate::models::ends_with_version_segment(path) {
        format!("{path}/{resource}")
    } else if path.is_empty() {
        format!("/{version}/{resource}")
    } else {
        format!("{path}/{version}/{resource}")
    };
    url.set_path(&next);
    Ok(url)
}

/// 探针请求体：stream 控制流式。思考档与采样必须分开发，避免一个字段失败株连另一个。
/// anthropic 的 effort 没有线协议字段，CLI 内部翻译成 thinking 块——探针同样翻译成
/// thinking.enabled（budget 1024，max_tokens 同步抬到 2048 满足 > budget 的协议要求）
/// Responses 的 effort 用规范字段 reasoning.effort（GLM 实测接受，2026-09-17）
fn probe_body(
    kind: ApiKind,
    model: &str,
    policy: &profiles::RequestPolicy,
    include_effort: bool,
    include_sampling: bool,
    stream: bool,
) -> serde_json::Value {
    if matches!(kind, ApiKind::Responses) {
        // OpenAI Responses 线格式：input 单字符串 + max_output_tokens，
        // 与 codex/grok-responses 的实际流量同形
        let mut body = serde_json::json!({
            "model": model,
            "input": "ping",
            "stream": stream,
        });
        body["max_output_tokens"] = serde_json::json!(16u64);
        if include_sampling {
            if let Some(v) = policy.temperature {
                body["temperature"] = serde_json::json!(v);
            }
            if let Some(v) = policy.top_p {
                body["top_p"] = serde_json::json!(v);
            }
        }
        if include_effort {
            if let Some(effort) = policy.reasoning_effort.as_deref() {
                body["reasoning"] = serde_json::json!({ "effort": effort });
                // effort 档下 16 个输出额度可能全被 reasoning 吃掉，抬到 64
                body["max_output_tokens"] = serde_json::json!(64u64);
            }
        }
        return body;
    }
    let mut body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "ping" }],
        "stream": stream,
    });
    let mut max_tokens = 16u64;
    body["max_tokens"] = serde_json::json!(max_tokens);
    if include_sampling {
        if let Some(v) = policy.temperature {
            body["temperature"] = serde_json::json!(v);
        }
        if let Some(v) = policy.top_p {
            body["top_p"] = serde_json::json!(v);
        }
    }
    if include_effort {
        if let Some(effort) = policy.reasoning_effort.as_deref() {
            match kind {
                ApiKind::Anthropic => {
                    body["thinking"] =
                        serde_json::json!({ "type": "enabled", "budget_tokens": 1024 });
                    if max_tokens <= 1024 {
                        max_tokens = 2048;
                        body["max_tokens"] = serde_json::json!(max_tokens);
                    }
                    let _ = effort; // 档位本身不进 anthropic 请求体，只体现为 thinking 开关
                }
                _ => {
                    body["reasoning_effort"] = serde_json::json!(effort);
                }
            }
        }
    }
    body
}

struct ProbeOutcome {
    status: reqwest::StatusCode,
    /// content-type 含 event-stream
    sse: bool,
    content_type: String,
    /// 非 2xx 时的响应尾部（截断）
    error_tail: String,
}

async fn send_probe(request: reqwest::RequestBuilder) -> Result<ProbeOutcome, String> {
    let response = request.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let sse = content_type.contains("event-stream");
    // SSE 成功响应不读全文（流会挂住）；只在非 2xx 时取错误尾部
    let error_tail = if status.is_success() {
        String::new()
    } else {
        tail_chars(response.text().await.unwrap_or_default().trim(), 300)
    };
    Ok(ProbeOutcome {
        status,
        sse,
        content_type,
        error_tail,
    })
}

#[tauri::command]
pub async fn probe_gateway(
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
    model: Option<String>,
) -> Result<GatewayProbeDto, String> {
    let profile = store.get(&profile_id)?;
    probe_loaded_profile(&store, profile, model, false, None, true).await
}

/// 草稿探测：可带未保存的地址/密钥。只有地址与已存槽一致且没提交新密钥时才把结果写入 lastProbe。
pub(crate) fn should_persist_slot_probe(
    has_gateway: bool,
    draft_url: Option<&str>,
    saved_url: Option<&str>,
    draft_key: Option<&str>,
) -> bool {
    if !has_gateway || draft_key.is_some() {
        return false;
    }
    match (
        draft_url.map(str::trim).filter(|s| !s.is_empty()),
        saved_url.map(str::trim).filter(|s| !s.is_empty()),
    ) {
        (None, Some(_)) => true,
        (Some(draft), Some(saved)) => {
            crate::gateway_store::url_fingerprint(draft)
                == crate::gateway_store::url_fingerprint(saved)
        }
        _ => false,
    }
}

#[tauri::command]
pub async fn probe_gateway_slot(
    store: tauri::State<'_, ProfileStore>,
    gateway_id: Option<String>,
    slot: String,
    model: Option<String>,
    basic_only: Option<bool>,
    base_url: Option<String>,
    api_key: Option<String>,
    no_auth: Option<bool>,
) -> Result<GatewayProbeDto, String> {
    let slot =
        crate::gateway_store::Slot::from_str(&slot).ok_or_else(|| format!("未知协议槽: {slot}"))?;
    if slot == crate::gateway_store::Slot::Cursor {
        return Err("Cursor 为专有协议，不支持网关体检".into());
    }
    if slot == crate::gateway_store::Slot::Gemini {
        return Err("Gemini 协议暂不支持网关体检".into());
    }
    let draft_url = base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let draft_key = api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let gid = gateway_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let mut gw = if let Some(id) = gid.as_deref() {
        store
            .list_gateways()?
            .into_iter()
            .find(|g| g.id == id)
            .ok_or("网关不存在")?
    } else {
        crate::profiles::Gateway {
            id: String::new(),
            name: "草稿".into(),
            no_auth: no_auth.unwrap_or(draft_key.is_none()),
            key_hint: None,
            wallet_user_id: None,
            wallet_key_hint: None,
            slots: crate::profiles::ProtocolSlots::default(),
            header_env: Default::default(),
            models: Vec::new(),
            catalog_fetched_at: None,
            catalog_from_slot: None,
            last_probe: Vec::new(),
            slot_probes: Vec::new(),
            revision: String::new(),
        }
    };
    if let Some(flag) = no_auth {
        gw.no_auth = flag;
    }
    let saved_url = crate::gateway_store::slot_url(&gw.slots, slot).map(str::to_string);
    if let Some(url) = &draft_url {
        crate::gateway_store::set_slot_url(&mut gw.slots, slot, Some(url.clone()));
    } else if crate::gateway_store::slot_url(&gw.slots, slot).is_none() {
        return Err("这个槽还没填端点".into());
    }
    let persist = should_persist_slot_probe(
        !gw.id.is_empty(),
        draft_url.as_deref(),
        saved_url.as_deref(),
        draft_key.as_deref(),
    );
    let model = Some(default_probe_model(&gw, slot, model));
    let binding = crate::profiles::Binding {
        id: format!(
            "probe-{}",
            if gw.id.is_empty() {
                "draft"
            } else {
                gw.id.as_str()
            }
        ),
        agent: crate::gateway_store::agent_for_slot(slot).into(),
        name: format!("探测 · {}", gw.name),
        kind: crate::profiles::BindingKind::Api,
        gateway_id: if gw.id.is_empty() {
            None
        } else {
            Some(gw.id.clone())
        },
        protocol: None,
        api_backend: None,
        models: gw.models.iter().map(|m| m.id.clone()).collect(),
        role_models: Default::default(),
        extra_env: Default::default(),
        last_used_at: None,
    };
    let mut profile = crate::gateway_store::materialize(&binding, Some(&gw), model.as_deref());
    profile.has_key = draft_key.is_some() || gw.key_hint.is_some();
    profile.no_auth = gw.no_auth && draft_key.is_none();
    probe_loaded_profile(
        &store,
        profile,
        model,
        basic_only.unwrap_or(false),
        draft_key,
        persist,
    )
    .await
}

fn default_probe_model(
    gw: &crate::profiles::Gateway,
    slot: crate::gateway_store::Slot,
    explicit: Option<String>,
) -> String {
    if let Some(m) = explicit
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return m;
    }
    if let Ok(bindings) = crate::gateway_store::load_bindings() {
        for b in bindings {
            if b.gateway_id.as_deref() != Some(gw.id.as_str()) {
                continue;
            }
            if crate::gateway_store::slot_for_agent(&b.agent, b.protocol.as_deref()) != slot {
                continue;
            }
            if let Some(m) = b.models.iter().find(|s| !s.is_empty()) {
                return m.clone();
            }
        }
    }
    gw.models
        .iter()
        .map(|m| m.id.clone())
        .find(|s| !s.is_empty())
        .unwrap_or_default()
}

async fn probe_loaded_profile(
    store: &ProfileStore,
    profile: crate::profiles::Profile,
    model: Option<String>,
    basic_only: bool,
    key_override: Option<String>,
    persist: bool,
) -> Result<GatewayProbeDto, String> {
    let key = if profile.no_auth {
        None
    } else if let Some(k) = key_override.filter(|s| !s.trim().is_empty()) {
        Some(k)
    } else {
        profiles::get_key_for_profile(&profile)?
    };
    if profile.agent == "cursor" {
        return Err("Cursor 为专有协议，不支持网关体检".into());
    }
    let kind = api_kind(&profile);
    if matches!(kind, ApiKind::Gemini) {
        return Err("Gemini 协议暂不支持网关体检".into());
    }
    let model = model
        .or_else(|| profile.models.first().cloned())
        .filter(|m| !m.trim().is_empty());
    let base = profile
        .base_url
        .as_deref()
        .unwrap_or_else(|| default_base(&profile, kind))
        .to_string();
    if model.is_none() {
        return probe_catalog_connectivity(&profile, &base, key.as_deref(), persist, store).await;
    }
    let model = model.unwrap();
    let url = chat_url(&base, kind)?;
    let client = reqwest::Client::builder()
        .timeout(API_TIMEOUT)
        .build()
        .map_err(|e| format!("创建 API 客户端失败: {e}"))?;

    // 鉴权镜像 CLI 真实形态：Claude/CodeBuddy/Grok 使用 Bearer；Qwen/Kimi
    // Anthropic 兼容通道使用 x-api-key。
    let build = |body: serde_json::Value, with_headers: bool| {
        let mut req = client.post(url.clone()).json(&body);
        if let Some(k) = key.as_deref().filter(|k| !k.trim().is_empty()) {
            req = match kind {
                ApiKind::Anthropic => {
                    let req = if anthropic_uses_bearer(&profile) {
                        req.bearer_auth(k)
                    } else {
                        req.header("x-api-key", k)
                    };
                    req.header("anthropic-version", "2023-06-01")
                }
                _ => req.bearer_auth(k),
            };
        }
        if with_headers {
            // Header 名=环境变量名引用，值从进程环境解析（与启动注入同口径）
            for (header, env_name) in &profile.request_policy.header_env {
                if let Ok(value) = std::env::var(env_name) {
                    if !value.is_empty() {
                        req = req.header(header, value);
                    }
                }
            }
        }
        req
    };

    let policy = &profile.request_policy;
    let has_effort = policy
        .reasoning_effort
        .as_deref()
        .is_some_and(|s| !s.is_empty());
    let has_sampling = policy.temperature.is_some() || policy.top_p.is_some();
    let mut checks = Vec::new();

    // ① 基础请求：鉴权 + 模型存在（不流式、不带策略）
    let started = Instant::now();
    let basic = send_probe(build(
        probe_body(kind, &model, policy, false, false, false),
        false,
    ))
    .await;
    let basic_ok = matches!(&basic, Ok(o) if o.status.is_success());
    checks.push(match &basic {
        Ok(o) if o.status.is_success() => {
            check("passed", "基础请求", Some(started.elapsed().as_millis()))
        }
        Ok(o) => check(
            "failed",
            format!("基础请求 HTTP {}：{}", o.status, o.error_tail),
            Some(started.elapsed().as_millis()),
        ),
        Err(e) => check(
            "failed",
            format!("基础请求：{e}"),
            Some(started.elapsed().as_millis()),
        ),
    });
    let basic_latency = checks.last().and_then(|c| c.latency_ms).map(|n| n as u64);
    if !basic_ok {
        // 基础请求挂了，流式/参数探测无意义
        for label in ["流式响应", "思考档参数", "采样参数", "自定义 Header"] {
            checks.push(check(
                "skipped",
                format!("{label}：基础请求未通过，跳过"),
                None,
            ));
        }
        persist_slot_probe(
            store,
            &profile,
            &model,
            &base,
            key.as_deref(),
            &checks,
            basic_latency,
            basic_only,
            persist,
        );
        return Ok(GatewayProbeDto {
            ok: false,
            model,
            checks,
        });
    }
    if basic_only {
        persist_slot_probe(
            store,
            &profile,
            &model,
            &base,
            key.as_deref(),
            &checks,
            basic_latency,
            true,
            persist,
        );
        return Ok(GatewayProbeDto {
            ok: true,
            model,
            checks,
        });
    }

    // ② 流式：裸 stream:true，看网关回不回 SSE
    let started = Instant::now();
    let bare_stream = send_probe(build(
        probe_body(kind, &model, policy, false, false, true),
        false,
    ))
    .await;
    checks.push(match &bare_stream {
        Ok(o) if o.status.is_success() && o.sse => check(
            "passed",
            "流式响应：网关返回 SSE",
            Some(started.elapsed().as_millis()),
        ),
        Ok(o) if o.status.is_success() => check(
            "failed",
            format!(
                "流式响应：HTTP 200 但非 SSE（content-type: {}），该模型/端点不流式",
                o.content_type
            ),
            Some(started.elapsed().as_millis()),
        ),
        Ok(o) => check(
            "failed",
            format!("流式响应 HTTP {}：{}", o.status, o.error_tail),
            Some(started.elapsed().as_millis()),
        ),
        Err(e) => check(
            "failed",
            format!("流式响应：{e}"),
            Some(started.elapsed().as_millis()),
        ),
    });

    // ③ 思考档、采样分开发：一个模型拒 effort 不得关掉温度。
    append_policy_probe_check(
        &mut checks,
        if has_effort {
            let started = Instant::now();
            Some((
                started,
                send_probe(build(
                    probe_body(kind, &model, policy, true, false, true),
                    false,
                ))
                .await,
            ))
        } else {
            None
        },
        "思考档参数",
    );
    append_policy_probe_check(
        &mut checks,
        if has_sampling {
            let started = Instant::now();
            Some((
                started,
                send_probe(build(
                    probe_body(kind, &model, policy, false, true, true),
                    false,
                ))
                .await,
            ))
        } else {
            None
        },
        "采样参数",
    );

    // ④ 自定义 Header：带上解析后的 header 发一次基础请求
    let started = Instant::now();
    if policy.header_env.is_empty() {
        checks.push(check("skipped", "自定义 Header：未配置", None));
    } else {
        let unresolved: Vec<&str> = policy
            .header_env
            .values()
            .filter(|var| std::env::var(var).map(|v| v.is_empty()).unwrap_or(true))
            .map(String::as_str)
            .collect();
        let with_headers = send_probe(build(
            probe_body(kind, &model, policy, false, false, false),
            true,
        ))
        .await;
        let suffix = if unresolved.is_empty() {
            String::new()
        } else {
            format!(
                "；环境变量 {} 未设置，对应 Header 未发送",
                unresolved.join("、")
            )
        };
        checks.push(match &with_headers {
            Ok(o) if o.status.is_success() => check(
                "passed",
                format!("自定义 Header：网关接受{suffix}"),
                Some(started.elapsed().as_millis()),
            ),
            Ok(o) => check(
                "failed",
                format!(
                    "自定义 Header：HTTP {}：{}{}",
                    o.status, o.error_tail, suffix
                ),
                Some(started.elapsed().as_millis()),
            ),
            Err(e) => check(
                "failed",
                format!("自定义 Header：{e}{suffix}"),
                Some(started.elapsed().as_millis()),
            ),
        });
    }

    let ok = checks.iter().all(|c| c.status != "failed");
    persist_slot_probe(
        store,
        &profile,
        &model,
        &base,
        key.as_deref(),
        &checks,
        basic_latency,
        false,
        persist,
    );
    Ok(GatewayProbeDto { ok, model, checks })
}

/// 还没有模型名单时：用 GET /models 验证地址和密钥，不写目录。
async fn probe_catalog_connectivity(
    profile: &crate::profiles::Profile,
    base: &str,
    key: Option<&str>,
    persist: bool,
    store: &ProfileStore,
) -> Result<GatewayProbeDto, String> {
    let started = Instant::now();
    let result = crate::models::fetch_models(
        base.to_string(),
        key.map(str::to_string),
        None,
        Some(profile.agent.clone()),
        profile.protocol.clone(),
        if persist {
            profile.gateway_id.clone()
        } else {
            None
        },
        Some(true),
    )
    .await;
    let latency = started.elapsed().as_millis();
    let (ok, message) = match result {
        Ok(res) if res.models.is_empty() => (false, "基础请求：目录为空".to_string()),
        Ok(res) => (true, format!("基础请求：目录 {} 个模型", res.models.len())),
        Err(e) => (false, format!("基础请求：{e}")),
    };
    let checks = vec![check(
        if ok { "passed" } else { "failed" },
        message,
        Some(latency),
    )];
    persist_slot_probe(
        store,
        profile,
        "",
        base,
        key,
        &checks,
        Some(latency as u64),
        true,
        persist,
    );
    Ok(GatewayProbeDto {
        ok,
        model: String::new(),
        checks,
    })
}

fn append_policy_probe_check(
    checks: &mut Vec<ValidationCheckDto>,
    outcome: Option<(Instant, Result<ProbeOutcome, String>)>,
    label: &str,
) {
    let Some((started, outcome)) = outcome else {
        checks.push(check("skipped", format!("{label}：未配置"), None));
        return;
    };
    checks.push(match &outcome {
        Ok(o) if o.status.is_success() && o.sse => check(
            "passed",
            format!("{label}：被接受且保持流式"),
            Some(started.elapsed().as_millis()),
        ),
        Ok(o) if o.status.is_success() => check(
            "failed",
            format!("{label}：被接受（HTTP 200）但响应不再流式——疑似网关对带参请求降级"),
            Some(started.elapsed().as_millis()),
        ),
        Ok(o) => check(
            "failed",
            format!("{label}：被拒（HTTP {}）：{}", o.status, o.error_tail),
            Some(started.elapsed().as_millis()),
        ),
        Err(e) => check(
            "failed",
            format!("{label}：{e}"),
            Some(started.elapsed().as_millis()),
        ),
    });
}

fn persist_slot_probe(
    store: &ProfileStore,
    profile: &crate::profiles::Profile,
    model: &str,
    base: &str,
    key: Option<&str>,
    checks: &[ValidationCheckDto],
    latency_ms: Option<u64>,
    basic_only: bool,
    persist: bool,
) {
    if !persist {
        return;
    }
    let Some(gid) = profile.gateway_id.clone() else {
        return;
    };
    let slot = crate::gateway_store::slot_for_agent(&profile.agent, profile.protocol.as_deref());
    let st = |prefix: &str| -> crate::profiles::ProbeStatus {
        match checks.iter().find(|c| c.message.starts_with(prefix)) {
            Some(c) if c.status == "passed" => crate::profiles::ProbeStatus::Passed,
            Some(c) if c.status == "failed" => crate::profiles::ProbeStatus::Failed,
            _ => crate::profiles::ProbeStatus::Never,
        }
    };
    let mut rec = crate::profiles::ProbeRecord {
        slot: slot.as_str().into(),
        model: Some(model.to_string()),
        url_fp: crate::gateway_store::url_fingerprint(base),
        key_fp: crate::gateway_store::key_presence_fp(key.is_some_and(|k| !k.is_empty())),
        streaming: st("流式"),
        effort: st("思考档"),
        sampling: st("采样"),
        headers: st("自定义 Header"),
        basic: st("基础请求"),
        probed_at: crate::sessions::now_iso(),
        latency_ms,
    };
    if basic_only {
        if let Ok(gws) = crate::gateway_store::load_gateways() {
            if let Some(prev) = gws.iter().find(|g| g.id == gid).and_then(|g| {
                g.last_probe
                    .iter()
                    .filter(|p| {
                        p.slot == rec.slot
                            && p.model == rec.model
                            && p.url_fp == rec.url_fp
                            && p.key_fp == rec.key_fp
                    })
                    .max_by_key(|p| p.probed_at.as_str())
            }) {
                rec.streaming = prev.streaming;
                rec.effort = prev.effort;
                rec.sampling = prev.sampling;
                rec.headers = prev.headers;
            }
        }
    }
    let _ = store.record_probe(&gid, rec);
}

pub(crate) fn validate_after_global_write(
    profile: &Profile,
    key: Option<&str>,
) -> ProfileValidationDto {
    let local = match dirs::home_dir() {
        Some(home) => local_check_at(&home, profile),
        None => check("failed", "无法确定用户主目录", None),
    };
    let cli = cli_check(profile, key, false);
    let api = check(
        "skipped",
        "全局写入后仅自动检查本地配置与 CLI；可点击“验证”执行 API 请求",
        None,
    );
    result(local, cli, api)
}

#[tauri::command]
pub async fn validate_profile(
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
) -> Result<ProfileValidationDto, String> {
    let profile = store.get(&profile_id)?;
    let key = profiles::get_key_for_profile(&profile)?;
    let local_profile = profile.clone();
    let local = tauri::async_runtime::spawn_blocking(move || match dirs::home_dir() {
        Some(home) => local_check_at(&home, &local_profile),
        None => check("failed", "无法确定用户主目录", None),
    })
    .await
    .map_err(|e| e.to_string())?;
    let cli_profile = profile.clone();
    let cli_key = key.clone();
    let cli = tauri::async_runtime::spawn_blocking(move || {
        cli_check(&cli_profile, cli_key.as_deref(), true)
    })
    .await
    .map_err(|e| e.to_string())?;
    let api = if local.status == "failed" {
        check("skipped", "请先修复本地配置解析错误，再执行 API 验证", None)
    } else {
        api_check(&profile, key.as_deref()).await
    };
    Ok(result(local, cli, api))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::ProtocolSlots;

    fn profile(agent: &str) -> Profile {
        Profile {
            id: "p".into(),
            agent: agent.into(),
            name: "测试".into(),
            account_type: Default::default(),
            no_auth: false,
            protocol: None,
            api_backend: None,
            base_url: Some("https://relay.example.com/v1".into()),
            models: vec!["model-a".into()],
            role_models: Default::default(),
            extra_env: Default::default(),
            request_policy: crate::profiles::RequestPolicy::default(),
            key_hint: None,
            model: None,
            last_used_at: None,
            has_key: true,
            gateway_id: None,
            slot_missing: false,
            connection_status: String::new(),
            model_sync_status: String::new(),
            model_sync_note: None,
            provider_override: None,
        }
    }

    #[test]
    fn responses_kind_probe_matches_codex_traffic_shape() {
        // codex / grok-responses → Responses 线格式，与 CLI 实际流量同形：
        // chat/completions 形状会被 GLM 这类 Responses-only 网关拒（403 实测）
        assert!(matches!(api_kind(&profile("codex")), ApiKind::Responses));
        let mut grok = profile("grok");
        grok.api_backend = Some("responses".into());
        assert!(matches!(api_kind(&grok), ApiKind::Responses));

        assert_eq!(
            chat_url("https://open.bigmodel.cn/api/v1", ApiKind::Responses)
                .unwrap()
                .path(),
            "/api/v1/responses"
        );
        assert_eq!(
            chat_url("https://api.openai.com/v1", ApiKind::Responses)
                .unwrap()
                .path(),
            "/v1/responses"
        );
        assert_eq!(
            models_url("https://open.bigmodel.cn/api/v1", ApiKind::Responses)
                .unwrap()
                .path(),
            "/api/v1/models"
        );

        // 请求体：input 单字符串 + max_output_tokens，不出现 messages
        let policy = crate::profiles::RequestPolicy::default();
        let body = probe_body(ApiKind::Responses, "glm-5.3", &policy, false, false, false);
        assert_eq!(body["input"], serde_json::json!("ping"));
        assert_eq!(body["max_output_tokens"], serde_json::json!(16));
        assert!(body.get("messages").is_none());
        // effort 走规范字段 reasoning.effort（GLM 实测接受）
        let mut policy = crate::profiles::RequestPolicy::default();
        policy.reasoning_effort = Some("low".into());
        let body = probe_body(ApiKind::Responses, "glm-5.3", &policy, true, false, false);
        assert_eq!(body["reasoning"], serde_json::json!({ "effort": "low" }));
        assert!(body.get("reasoning_effort").is_none());

        // 目录解析：GLM codex 目录 models[].slug；OpenAI 官方 data[].id
        let glm_catalog =
            serde_json::json!({"models": [{"slug": "glm-5.3"}, {"slug": "glm-5.3-flash"}]});
        assert_eq!(
            model_ids(&glm_catalog, ApiKind::Responses),
            vec!["glm-5.3", "glm-5.3-flash"]
        );
        let openai_catalog = serde_json::json!({"data": [{"id": "gpt-5.3"}]});
        assert_eq!(
            model_ids(&openai_catalog, ApiKind::Responses),
            vec!["gpt-5.3"]
        );
    }

    #[test]
    fn probe_body_splits_effort_and_sampling() {
        let mut policy = crate::profiles::RequestPolicy::default();
        policy.temperature = Some(0.4);
        policy.top_p = Some(0.8);
        policy.reasoning_effort = Some("high".into());
        let sampling = probe_body(ApiKind::OpenAi, "m", &policy, false, true, true);
        assert_eq!(sampling["temperature"], serde_json::json!(0.4));
        assert_eq!(sampling["top_p"], serde_json::json!(0.8));
        assert!(sampling.get("reasoning_effort").is_none());
        let effort = probe_body(ApiKind::OpenAi, "m", &policy, true, false, true);
        assert_eq!(effort["reasoning_effort"], serde_json::json!("high"));
        assert!(effort.get("temperature").is_none());
        let anth = probe_body(ApiKind::Anthropic, "m", &policy, true, false, true);
        assert!(anth.get("thinking").is_some());
        assert!(anth.get("temperature").is_none());
    }

    #[test]
    fn models_url_preserves_gateway_prefix() {
        assert_eq!(
            models_url("https://relay.example.com/gateway/v1", ApiKind::OpenAi)
                .unwrap()
                .as_str(),
            "https://relay.example.com/gateway/v1/models"
        );
        assert_eq!(
            models_url("https://relay.example.com/gemini", ApiKind::Gemini)
                .unwrap()
                .as_str(),
            "https://relay.example.com/gemini/v1beta/models"
        );
    }

    #[test]
    fn chat_and_models_urls_treat_version_segments_as_versioned() {
        // GLM /api/paas/v4：末段是版本段 → 资源直接挂版本段下，不再补 /v1
        // （补 /v1 会拼出 /paas/v4/v1/chat/completions，GLM 实测 404 误报体检失败）
        assert_eq!(
            chat_url("https://open.bigmodel.cn/api/paas/v4", ApiKind::OpenAi)
                .unwrap()
                .path(),
            "/api/paas/v4/chat/completions"
        );
        assert_eq!(
            models_url("https://open.bigmodel.cn/api/paas/v4", ApiKind::OpenAi)
                .unwrap()
                .path(),
            "/api/paas/v4/models"
        );
        // 常规形态不回归：/v1 结尾、无路径、非版本段前缀
        assert_eq!(
            chat_url("https://api.openai.com/v1", ApiKind::OpenAi)
                .unwrap()
                .path(),
            "/v1/chat/completions"
        );
        assert_eq!(
            chat_url("https://relay.example.com", ApiKind::OpenAi)
                .unwrap()
                .path(),
            "/v1/chat/completions"
        );
        assert_eq!(
            chat_url("https://open.bigmodel.cn/api/anthropic", ApiKind::Anthropic)
                .unwrap()
                .path(),
            "/api/anthropic/v1/messages"
        );
        assert_eq!(
            models_url("https://relay.example.com/gemini", ApiKind::Gemini)
                .unwrap()
                .path(),
            "/gemini/v1beta/models"
        );
    }

    #[test]
    fn draft_probe_does_not_persist_until_saved() {
        assert!(!should_persist_slot_probe(
            false,
            Some("https://a"),
            None,
            None
        ));
        assert!(!should_persist_slot_probe(
            true,
            Some("https://new"),
            Some("https://old"),
            None,
        ));
        assert!(!should_persist_slot_probe(
            true,
            Some("https://old"),
            Some("https://old"),
            Some("sk-new"),
        ));
        assert!(should_persist_slot_probe(
            true,
            Some("https://old"),
            Some("https://old"),
            None,
        ));
        assert!(should_persist_slot_probe(
            true,
            None,
            Some("https://old"),
            None
        ));
    }

    #[test]
    fn request_policy_ranges_and_header_references_are_validated() {
        let mut p = profile("claude-code");
        p.request_policy.temperature = Some(2.1);
        assert!(validate_profile_fields(&p).is_err());
        p.request_policy.temperature = Some(0.7);
        p.request_policy.top_p = Some(1.1);
        assert!(validate_profile_fields(&p).is_err());
        p.request_policy.top_p = Some(0.9);
        p.request_policy
            .header_env
            .insert("X-Relay-Key".into(), "RELAY_KEY".into());
        assert!(validate_profile_fields(&p).is_ok());
        p.request_policy
            .header_env
            .insert("Bad:Header".into(), "RELAY_KEY".into());
        assert!(validate_profile_fields(&p).is_err());
    }

    #[test]
    fn no_auth_rejects_auth_bearing_env_from_shared_list() {
        let mut p = profile("opencode");
        p.no_auth = true;
        // OPENCODE_CONFIG_CONTENT 内嵌整份带凭据的配置，不含 KEY/TOKEN 字面，只有闭集能拦
        p.extra_env.insert(
            "OPENCODE_CONFIG_CONTENT".into(),
            r#"{"apiKey":"sk-inside-json"}"#.into(),
        );
        assert!(validate_profile_fields(&p).is_err());
        p.extra_env.clear();
        // 闭集判定大小写不敏感：小写写法不得绕过
        p.extra_env
            .insert("anthropic_api_key".into(), "sk-lower".into());
        assert!(validate_profile_fields(&p).is_err());
        p.extra_env.clear();
        // 非认证变量照常放行（别把子串启发式搬到这里，否则 OPENCODE_CONFIG 这类会被误伤）
        p.extra_env
            .insert("OPENCODE_CONFIG".into(), "/tmp/opencode.json".into());
        assert!(validate_profile_fields(&p).is_ok());
    }

    #[test]
    fn unsupported_request_policy_is_a_warning_not_silent_success() {
        let mut p = profile("codex");
        p.request_policy.temperature = Some(0.2);
        let notes = validate_profile_fields(&p).unwrap();
        assert!(notes.iter().any(|n| n.contains("temperature")));
    }

    #[test]
    fn anthropic_base_url_trailing_v1_is_warned_not_blocked() {
        // /v1 结尾会被 SDK 拼成 /v1/v1/messages 404：给提醒但保存不阻断
        let mut p = profile("claude-code");
        p.base_url = Some("https://relay.example.com/v1".into());
        let notes = validate_profile_fields(&p).unwrap();
        assert!(notes.iter().any(|n| n.contains("/v1/v1/messages")));
        // 不带 /v1 不提醒；非 Anthropic 通道（如 codex 的 OpenAI 系 /v1 惯例）不提醒
        p.base_url = Some("https://relay.example.com".into());
        assert!(!validate_profile_fields(&p)
            .unwrap()
            .iter()
            .any(|n| n.contains("/v1/v1")));
        let mut c = profile("codex");
        c.base_url = Some("https://relay.example.com/v1".into());
        assert!(!validate_profile_fields(&c)
            .unwrap()
            .iter()
            .any(|n| n.contains("/v1/v1")));
    }

    #[test]
    fn anthropic_full_messages_url_is_rejected() {
        let mut p = profile("claude-code");
        p.base_url = Some("https://relay.example.com/v1/messages".into());
        assert!(validate_profile_fields(&p)
            .unwrap_err()
            .contains("不能填写完整 /messages"));
    }

    #[test]
    fn every_slot_rejects_its_own_full_endpoint() {
        for (slot, suffix) in [
            ("anthropic", "/v1/messages"),
            ("openai", "/v1/chat/completions"),
            ("responses", "/v1/responses"),
            ("gemini", "/v1beta/models/gemini-pro:generateContent"),
            ("cursor", "/v1/chat/completions"),
        ] {
            let mut slots = ProtocolSlots::default();
            let url = format!("https://relay.example.com{suffix}");
            match slot {
                "anthropic" => slots.anthropic = Some(url),
                "openai" => slots.openai = Some(url),
                "responses" => slots.responses = Some(url),
                "gemini" => slots.gemini = Some(url),
                _ => slots.cursor = Some(url),
            }
            let err = validate_slot_urls(&slots).unwrap_err();
            assert!(err.contains(slot), "{slot} 的报错要指出是哪个槽: {err}");
        }
    }

    #[test]
    fn slot_urls_accept_base_urls_and_empty() {
        // 空槽合法（缺槽由绑定的 slot_missing 报）
        assert!(validate_slot_urls(&ProtocolSlots::default()).is_ok());
        let slots = ProtocolSlots {
            anthropic: Some("https://api.example.com".into()),
            openai: Some("https://api.example.com/v1".into()),
            responses: Some("https://open.bigmodel.cn/api/v1".into()),
            gemini: None,
            cursor: None,
        };
        assert!(validate_slot_urls(&slots).is_ok());
    }

    #[test]
    fn slot_urls_reject_unparseable_and_non_http() {
        let mut slots = ProtocolSlots {
            anthropic: Some("不是地址".into()),
            ..Default::default()
        };
        assert!(validate_slot_urls(&slots)
            .unwrap_err()
            .contains("anthropic 槽地址格式错误"));

        slots.anthropic = Some("ftp://api.example.com".into());
        assert!(validate_slot_urls(&slots)
            .unwrap_err()
            .contains("http:// 或 https://"));
    }

    #[test]
    fn claude_effort_closed_set_is_validated() {
        let mut p = profile("claude-code");
        p.request_policy.reasoning_effort = Some("ultra".into());
        assert!(validate_profile_fields(&p).is_err());
        p.request_policy.reasoning_effort = Some("xhigh".into());
        assert!(validate_profile_fields(&p).is_ok());
        // 其他 agent 不套用 claude 的档位闭集
        let mut k = profile("kimi");
        k.request_policy.reasoning_effort = Some("ultra".into());
        assert!(validate_profile_fields(&k).is_ok());
    }

    #[test]
    fn local_check_reports_invalid_cli_config() {
        let home =
            std::env::temp_dir().join(format!("ccode-profile-check-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(home.join(".kimi-code")).unwrap();
        fs::write(home.join(".kimi-code/config.toml"), "[providers.bad\n").unwrap();
        let result = local_check_at(&home, &profile("kimi"));
        assert_eq!(result.status, "failed");
        assert!(result.message.contains("不是合法 TOML"));
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn profile_fields_reject_protocol_and_embedded_credentials() {
        let mut qwen = profile("qwen");
        qwen.protocol = Some("gemini".into());
        assert!(validate_profile_fields(&qwen)
            .unwrap_err()
            .contains("不支持协议"));
        qwen.protocol = Some("openai".into());
        qwen.base_url = Some("https://user:pass@example.com/v1".into());
        assert!(validate_profile_fields(&qwen)
            .unwrap_err()
            .contains("不得内嵌"));
    }

    #[test]
    fn model_ids_support_openai_anthropic_and_gemini_shapes() {
        let openai = serde_json::json!({"data": [{"id": "m1"}]});
        let gemini = serde_json::json!({"models": [{"name": "models/gemini-2.5-pro"}]});
        assert_eq!(model_ids(&openai, ApiKind::OpenAi), vec!["m1"]);
        assert_eq!(model_ids(&openai, ApiKind::Anthropic), vec!["m1"]);
        assert_eq!(model_ids(&gemini, ApiKind::Gemini), vec!["gemini-2.5-pro"]);
    }

    fn doctor_report(auth: &str, config: &str, reachability: &str) -> String {
        serde_json::json!({
            "schemaVersion": 1,
            "overallStatus": "fail",
            "checks": {
                "auth.credentials": {
                    "id": "auth.credentials",
                    "category": "auth",
                    "status": auth,
                    "summary": "auth summary"
                },
                "config.load": {
                    "id": "config.load",
                    "category": "config",
                    "status": config,
                    "summary": "config loaded"
                },
                "network.provider_reachability": {
                    "id": "network.provider_reachability",
                    "category": "reachability",
                    "status": reachability,
                    "summary": "one or more required provider endpoints are unreachable over HTTP"
                },
                "terminal.title": {
                    "id": "terminal.title",
                    "category": "title",
                    "status": "ok",
                    "summary": "terminal title default"
                }
            }
        })
        .to_string()
    }

    #[test]
    fn codex_doctor_reachability_fail_does_not_fail_cli_layer() {
        let message = interpret_codex_doctor(&doctor_report("ok", "ok", "fail"), Some(1)).unwrap();
        assert!(message.contains("通过"));
        assert!(message.contains("API 层"));
        assert!(!message.contains("terminal.title"));
        assert!(!message.contains("Some(1)"));
    }

    #[test]
    fn codex_doctor_auth_fail_still_fails_cli_layer() {
        let err = interpret_codex_doctor(&doctor_report("fail", "ok", "ok"), Some(1)).unwrap_err();
        assert!(err.contains("auth.credentials"));
        assert!(!err.contains("Some("));
    }

    #[test]
    fn codex_doctor_config_fail_still_fails_cli_layer() {
        let err = interpret_codex_doctor(&doctor_report("ok", "fail", "ok"), Some(1)).unwrap_err();
        assert!(err.contains("config.load"));
    }

    #[test]
    fn unparsed_cli_failure_uses_numeric_exit_code_and_head() {
        let err = interpret_codex_doctor("not-json doctor output", Some(1)).unwrap_err();
        assert!(err.contains("CLI 退出码 1"));
        assert!(!err.contains("Some("));
        assert!(err.contains("not-json"));
    }

    #[test]
    #[ignore = "需本机 codex；注入假钥会让 doctor 因中转探测 exit 1"]
    fn cli_check_codex_injected_live_doctor_ignores_reachability() {
        if crate::agents::resolve_binary("codex").is_none() {
            return;
        }
        let mut p = profile("codex");
        p.base_url = Some("https://example.com/v1".into());
        let result = cli_check(&p, Some("sk-test-dummy"), true);
        eprintln!(
            "cli_check status={} latency={:?} message={}",
            result.status, result.latency_ms, result.message
        );
        assert_eq!(result.status, "passed", "{}", result.message);
        assert!(result.message.contains("通过"), "{}", result.message);
        assert!(
            !result.message.contains("Some(1)") && !result.message.contains("terminal.title"),
            "{}",
            result.message
        );
    }
}
