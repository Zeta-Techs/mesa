use crate::agent_specs::{agent_spec, AgentSpec, LaunchSpec, SpecialLaunch};
use crate::profiles::{Profile, ProfileStore};
use serde::Serialize;
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "command")]
pub enum ModelSwitchDto {
    /// 带参直切（命令模板含 {model} 占位）
    Direct(String),
    /// 唤出 TUI 选择器由用户完成
    Picker(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortSpecDto {
    pub levels: Vec<String>,
    /// 命令模板（含 {level} 占位），pty_write 写入
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
    pub id: String,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    /// 该 CLI 有进程级只读参数（注册表 readonly_args 非空）。
    /// false = 「聊想法只读保护」对它只剩 prompt 里的软约束，agent 可以无视——
    /// UI 据此如实标注，不让开关沉默降级（用户在头脑风暴时最依赖「它不会动我文件」这个假设）
    pub readonly_supported: bool,
    /// 能直接在启动参数里指定的原生权限档（ask 请求批准 / auto 帮我批准 / full 完全访问，注册表 permission_args）
    pub permission_modes: Vec<String>,
    /// 运行中模型切换命令形态（终端状态栏模型菜单；None = 无机制不显示）
    pub model_switch: Option<ModelSwitchDto>,
    /// 运行中思考档调节（档位表 + 命令模板；None = 不显示「◈ 思考」控件）
    pub effort: Option<EffortSpecDto>,
    /// TUI 的 Enter 需要 CSI-u 形式（kitty 键盘协议；kimi）——xterm 键盘层与状态栏写入改写
    pub submit_csi_u: bool,
}

/// 启动计划：env 差异由 adapter 吸收（Codex 没有 base-url 环境变量，只能走 -c 参数）
#[derive(Debug, Default)]
pub struct LaunchPlan {
    pub env: Vec<(String, String)>,
    pub args: Vec<String>,
    /// 必须从继承环境中剔除的变量（官方账号模式：防 shell 残留 API key 静默覆盖账号登录）
    pub env_remove: Vec<String>,
    /// 初始 prompt（一键开步首条指令）的参数形态；pty_spawn 追加在全部参数之后，
    /// 保证位置参数语义（codex 的 -c/-m/-s、claude 的 --session-id 都在它前面）
    pub prompt_args: Vec<String>,
    /// 请求了初始 prompt 但该 CLI 不支持注入（PromptInject::Unsupported / 未知 agent），
    /// 前端据此提示「请手动发送」
    pub prompt_dropped: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvPreviewDto {
    pub name: String,
    /// 来源标注（展示用启发式：命名即来源约定；同键多次出现 = 后者覆盖前者）
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOverlayPreviewDto {
    /// 载体环境变量名（如 GROK_CONFIG）
    pub name: String,
    /// 美化后的 overlay 内容。白名单放行前提 = 值里无密文
    ///（grok 的 Header 是 $VAR 引用）；出站前仍统一过一遍脱敏兜底
    pub content: String,
    /// 该 overlay 的能力边界说明（如实交代注不进的字段去向）
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPlanPreviewDto {
    pub agent: String,
    pub binary: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<EnvPreviewDto>,
    pub env_remove: Vec<String>,
    pub prompt_supported: bool,
    pub request_policy: crate::profiles::RequestPolicy,
    /// 配置 overlay 预览（env 只显示名称，overlay 内容无密文才展示原文）
    pub overlays: Vec<ConfigOverlayPreviewDto>,
    /// agent 级的协议/上下文说明行（如 codex 的 wire_api 与 catalog 上下文窗口）
    pub notes: Vec<String>,
}

/// 预览里的 env 来源启发式分类（只读展示，不影响注入本身）
fn env_preview_source(name: &str, profile: &Profile) -> &'static str {
    if profile.extra_env.contains_key(name) {
        return "附加环境变量";
    }
    match name {
        // apply_request_policy_env 与各臂策略注入的键全集
        "CLAUDE_CODE_EXTRA_BODY"
        | "CLAUDE_CODE_MAX_OUTPUT_TOKENS"
        | "CLAUDE_CODE_EFFORT_LEVEL"
        | "ANTHROPIC_CUSTOM_HEADERS"
        | "CODEBUDDY_CODE_MAX_OUTPUT_TOKENS"
        | "CODEBUDDY_CUSTOM_HEADERS"
        | "KIMI_MODEL_THINKING_EFFORT"
        | "QWEN_CODE_MAX_OUTPUT_TOKENS" => return "请求策略",
        // grok 的模型名单收敛 + 请求策略 [models] 全局默认都装在这个 overlay 里
        "GROK_CONFIG" => return "Grok overlay",
        _ => {}
    }
    if name.starts_with("ANTHROPIC_DEFAULT_") || name.starts_with("ANTHROPIC_CUSTOM_MODEL_OPTION") {
        return "模型选择器";
    }
    if name == "CLAUDE_CODE_MAX_CONTEXT_TOKENS" || name == "CLAUDE_CODE_AUTO_COMPACT_WINDOW" {
        return "能力声明（注册链 >200K 才注入）";
    }
    match name {
        "ANTHROPIC_MODEL" | "CODEBUDDY_MODEL" | "KIMI_MODEL_NAME" => "默认模型",
        n if n.contains("BASE_URL") || n == "CURSOR_API_ENDPOINT" => "端点",
        n if n.contains("API_KEY") || n.contains("AUTH_TOKEN") => "密钥注入",
        "HTTPS_PROXY" | "HTTP_PROXY" | "ALL_PROXY" | "NO_PROXY" => "出网代理",
        _ => "内置注入",
    }
}

/// Cursor 自家云。只有这种地址才注入 CURSOR_API_KEY；其余地址是第三方网关。
pub(crate) fn cursor_cloud_endpoint(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url.trim()) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    host == "api2.cursor.sh"
        || host == "cursor.sh"
        || host == "cursor.com"
        || host.ends_with(".cursor.sh")
        || host.ends_with(".cursor.com")
}

/// 返回不含密钥值的启动计划，供配置页诊断和跨平台问题排查使用。
#[tauri::command]
pub fn preview_launch_plan(
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
    model: Option<String>,
) -> Result<LaunchPlanPreviewDto, String> {
    let mut profile = store.get_with_model(&profile_id, model.as_deref())?;
    let key = crate::profiles::get_key_for_profile(&profile)?;
    let selected = model
        .clone()
        .filter(|m| !m.trim().is_empty())
        .or_else(|| profile.models.first().cloned());
    crate::combo::apply_to_profile(&mut profile, selected.as_deref());
    let plan = launch_plan(&profile, key, selected.as_deref())?;
    // 配置 overlay 预览白名单：只有值里确定无密文的才展示原文
    //（GROK_CONFIG 的 Header 是 $VAR 引用，grok 进程内展开；CLAUDE_CODE_EXTRA_BODY
    // 只装 temperature/top_p 数值。OPENCODE_CONFIG_CONTENT 等含密钥载体永远不进这里）
    let overlays = plan
        .env
        .iter()
        .filter(|(name, _)| matches!(name.as_str(), "GROK_CONFIG" | "CLAUDE_CODE_EXTRA_BODY"))
        .map(|(name, value)| {
            let pretty = serde_json::from_str::<serde_json::Value>(value)
                .and_then(|j| serde_json::to_string_pretty(&j))
                .unwrap_or_else(|_| value.clone());
            let note = match name.as_str() {
                "GROK_CONFIG" => Some(grok_overlay_note()),
                _ => None,
            };
            ConfigOverlayPreviewDto {
                name: name.clone(),
                content: crate::sessions::redact_sensitive_text(&pretty),
                note,
            }
        })
        .collect();
    // agent 级协议/上下文说明（不含密钥；只写能实证的事实）
    let mut notes: Vec<String> = Vec::new();
    if profile.agent == "grok" {
        if let Some(b) = profile.api_backend.as_deref().filter(|s| !s.is_empty()) {
            notes.push(format!(
                "API 后端：{b}（仅「设为全局默认」写入 [model.*] 段生效，启动注入不携带）"
            ));
        }
        if let Some(m) = selected.as_deref() {
            // 只写权威层确知的事实（中转目录/用户覆盖）；估值层不说，256000 默认由 overlay 附注交代
            if let Some(ctx) = crate::model_registry::model_context_size_authoritative_for(
                m,
                profile.gateway_id.as_deref(),
            ) {
                notes.push(format!("上下文窗口：{ctx}（中转目录 / 用户覆盖声明）"));
            }
            if let Some(b) =
                crate::model_registry::model_api_backend_for(m, profile.gateway_id.as_deref())
            {
                notes.push(format!(
                    "中转目录声明 apiBackend={b}（grok 自读，无需设置绑定字段）"
                ));
            }
        }
    }
    if profile.agent == "codex" && profile.account_type != crate::profiles::AccountType::Official {
        notes.push("协议：Responses（wire_api=responses，中转必须实现 /v1/responses）".into());
        if let Some(m) = selected.as_deref() {
            // 说实话：注册链确知才叫「catalog 声明」；不知道时 catalog 不写这两个字段，
            // 由 codex 按自带默认算——预告里的措辞必须跟实际写入一致，否则用户拿它
            // 排查提前 compact 时会被引到错误方向。
            match crate::model_registry::model_context_size_declared_for(
                m,
                profile.gateway_id.as_deref(),
            ) {
                Some(ctx) => notes.push(format!(
                    "上下文窗口：{ctx}（catalog 声明，有效窗口按 95% 计）"
                )),
                None => notes.push(
                    "上下文窗口：注册链未确知，catalog 不声明（codex 按自带默认算；可在连接页「能力声明」里补）"
                        .into(),
                ),
            }
        }
    }
    // API 连接：磁盘配置文件里的同名键会盖过本次注入。只提示不阻断（见 api_launch_conflict_notes）
    if profile.account_type == crate::profiles::AccountType::Api {
        if let Some(home) = dirs::home_dir() {
            notes.extend(api_launch_conflict_notes(&home, &profile));
        }
    }
    if profile.agent == "codex" && profile.account_type == crate::profiles::AccountType::Official {
        notes.push(format!(
            "本进程用 -c model_provider=\"{}\" 盖过磁盘 config.toml 的默认渠道，走 ChatGPT 登录（不改用户文件）",
            crate::provider_id::CODEX_CHATGPT
        ));
        if selected.is_none() {
            notes.push(
                "启动栏未选模型时，磁盘 config.toml 的 model 仍会生效；网关专用模型名在 ChatGPT 上可能不可用，请在启动栏选官方模型，或登录后在 TUI 里 /model"
                    .into(),
            );
        }
        notes.push(
            "官方通道直连 OpenAI；国内网络请在设置 → 网络填写出网代理（连接附加环境变量可覆盖）。网关启动不走这份代理"
                .into(),
        );
    }
    let args = plan
        .args
        .into_iter()
        .map(|arg| crate::sessions::redact_sensitive_text(&arg))
        .collect();
    let env = plan
        .env
        .into_iter()
        .map(|(name, _)| {
            let source = env_preview_source(&name, &profile).to_string();
            EnvPreviewDto { name, source }
        })
        .collect();
    Ok(LaunchPlanPreviewDto {
        agent: profile.agent.clone(),
        binary: resolve_binary(binary_for(&profile.agent).unwrap_or(""))
            .map(|p| p.to_string_lossy().into_owned()),
        args,
        env,
        env_remove: plan.env_remove,
        prompt_supported: !plan.prompt_dropped,
        request_policy: profile.request_policy,
        overlays,
        notes,
    })
}

/// 解析 CLI 二进制的绝对路径：先 which（继承进程 PATH），miss 时按平台查常见
/// 安装目录兜底。背景：macOS 打包版从 Finder 启动时 PATH 很短（/usr/bin:/bin），
/// brew/npm 装的 CLI 不在其中（AGENTS.md 本机环境档案「GUI 应用 PATH 很短」）。
/// 所有二进制定位一律走这里，不再直接 which / 裸名 spawn。
pub fn resolve_binary(name: &str) -> Option<std::path::PathBuf> {
    if let Ok(p) = which::which(name) {
        return Some(p);
    }
    find_in_dirs(name, &crate::agent_specs::binary_candidate_dirs())
}

/// 启动时把候选目录里存在的补到本进程 PATH 末尾（只追加、不改原有顺序，已在 PATH 上的不重复），
/// 之后起的所有子进程都继承这份。resolve_binary 能在候选目录里找到 npm 装的 CLI，但它们多是
/// `#!/usr/bin/env node` 脚本，子进程沿用 Finder 给的短 PATH 就找不到 node、一起就退出
/// （2026-10-27 本机：node 在 /opt/homebrew/bin，打包版 Codex / Gemini / CodeBuddy 起不来）；
/// Agent 里再起的 git / rg / python / MCP 服务器也要同一份。必须在起任何线程之前调（set_var 不是线程安全的）。
/// Windows 的 GUI 进程本就拿到注册表里的完整 PATH，不动。
#[cfg(unix)]
pub fn extend_process_path() {
    let candidates = crate::agent_specs::binary_candidate_dirs();
    if let Some(next) = extended_path(std::env::var_os("PATH").as_deref(), &candidates, |d| d.is_dir()) {
        std::env::set_var("PATH", next);
    }
}

/// extend_process_path 的纯逻辑：没有要补的返回 None
#[cfg_attr(not(any(unix, test)), allow(dead_code))]
fn extended_path(
    current: Option<&std::ffi::OsStr>,
    candidates: &[PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> Option<std::ffi::OsString> {
    let mut entries: Vec<PathBuf> = current.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    let before = entries.len();
    for dir in candidates {
        if exists(dir) && !entries.iter().any(|e| e == dir) {
            entries.push(dir.clone());
        }
    }
    if entries.len() == before {
        return None;
    }
    std::env::join_paths(entries).ok()
}

/// Git for Windows 自带的 bash（流水线钩子 / run 脚本）。
/// 不认 `System32\bash.exe`（那是 WSL 启动器，Win32 路径的 bash 脚本会挂）。
/// macOS/Linux 上就是 `resolve_binary("bash")`，调用方若已有自己的 bash 解析则不必走这里。
/// 调用方全在 Windows 门控内（pty.rs script_shell_argv / workspaces.rs shell_cmd）。
#[cfg_attr(not(windows), allow(dead_code))]
pub fn resolve_git_bash() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        if let Some(p) = git_bash_default_paths().into_iter().find(|p| p.is_file()) {
            return Some(p);
        }
        let p = resolve_binary("bash")?;
        let s = p.to_string_lossy().to_ascii_lowercase();
        if s.contains("\\system32\\") || s.contains("/system32/") || s.contains("windowsapps") {
            return None;
        }
        Some(p)
    }
    #[cfg(not(windows))]
    {
        resolve_binary("bash")
    }
}

/// Git for Windows 的 bash.exe 默认落点，按序：全机安装（%ProgramFiles%\Git），再是「仅为我安装」
/// （winget 用户范围 / 安装器选项，%LOCALAPPDATA%\Programs\Git）。后者装完 Mesa 只认得 git、
/// 认不出 Git Bash（内置终端下拉不出现、run 脚本找不到 bash），2026-10-21 补
#[cfg(windows)]
fn git_bash_default_paths() -> Vec<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|k| std::env::var_os(k).map(std::path::PathBuf::from))
        .collect();
    if let Some(local) = dirs::data_local_dir() {
        roots.push(local.join("Programs"));
    }
    roots.into_iter().map(|r| r.join("Git").join("bin").join("bash.exe")).collect()
}

/// 在候选目录里按序找第一个存在的文件；Windows 下 npm 全局包是 .cmd shim，补扩展名匹配
fn find_in_dirs(name: &str, dirs: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    find_all_in_dirs(name, dirs).into_iter().next()
}

/// 每个目录取一个命中（扩展名优先级同 find_in_dirs），按目录顺序返回全部
fn find_all_in_dirs(name: &str, dirs: &[std::path::PathBuf]) -> Vec<std::path::PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        // Windows 上可执行的是 .exe/.cmd/.bat；npm 系目录里的裸名是 shell 脚本，
        // CreateProcess 直接起会报 os error 193——扩展名匹配必须优先，裸名只作兜底
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            name.into(),
        ]
    } else {
        vec![name.into()]
    };
    dirs.iter()
        .filter_map(|d| names.iter().map(|n| d.join(n)).find(|p| p.is_file()))
        .collect()
}

/// 同名程序的全部候选：PATH 顺序在前、候选目录在后，去重。只给「PATH 上第一个可能是
/// 占位程序」的场景用（Windows 应用商店的 python 占位）——调用方逐个验证能不能跑；
/// 常规解析仍走 resolve_binary。
pub fn resolve_binary_all(name: &str) -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = which::which_all(name)
        .map(|it| it.collect())
        .unwrap_or_default();
    for p in find_all_in_dirs(name, &crate::agent_specs::binary_candidate_dirs()) {
        let key = p.to_string_lossy();
        if !out
            .iter()
            .any(|q| crate::paths::same_path(&q.to_string_lossy(), &key))
        {
            out.push(p);
        }
    }
    out
}

/// --version 探测的统一超时：正常 CLI 毫秒级返回，卡死的 CLI 不能拖住检测/更新流程
pub(crate) const VERSION_QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// 无头探测（--version / 启动预检）不在用户的 CLI 目录里留垃圾。
///
/// Gemini CLI 0.64：`~/.gemini/projects.json` 不存在时每次启动都异步「写 tmp + 改名」登记项目，
/// `--version` 打完就退出、改名来不及做，`projects.json.<uuid>.tmp` 留在 ~/.gemini 里越积越多——
/// 没交互跑过 Gemini 的新装机器上，Mesa 每次探版本留两个（2026-10-20 新用户沙盒实证，
/// 已有 projects.json 时不写）。探测时把 GEMINI_CLI_HOME 指到 Mesa 自己的临时目录并预放一份
/// projects.json：版本照样读到，用户的 ~/.gemini 一个字节不碰。其余 CLI 不动。
pub(crate) fn quiet_cli_probe(cmd: &mut crate::process::BackgroundCommand, binary: &std::path::Path) {
    let is_gemini = binary
        .file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("gemini"));
    if !is_gemini {
        return;
    }
    let home = std::env::temp_dir().join("ccode-gemini-probe");
    let registry = home.join(".gemini").join("projects.json");
    if !registry.is_file() {
        // 建不出来也照样指过去：最坏是 tmp 留在 Mesa 的临时目录，而不是用户目录
        let _ = std::fs::create_dir_all(home.join(".gemini"));
        let _ = std::fs::write(&registry, "{\n  \"projects\": {}\n}");
    }
    cmd.env("GEMINI_CLI_HOME", &home);
}

/// 带超时跑 `<binary> --version` 并取首行输出；超时或失败杀掉子进程返回 None。
/// agents::detect 与 updater::version_of 共用（原实现无超时，CLI 卡死会无限阻塞）
pub(crate) fn version_with_timeout(
    path: &std::path::Path,
    timeout: std::time::Duration,
) -> Option<String> {
    version_args_with_timeout(path, &["--version"], timeout)
}

/// 探测参数来自 AgentSpec.version_args（八个 CLI 目前都是 --version）
fn version_args_with_timeout(
    path: &std::path::Path,
    args: &[&str],
    timeout: std::time::Duration,
) -> Option<String> {
    let text = cli_output_with_timeout(path, args, timeout)?;
    Some(text.lines().next().unwrap_or("").to_string())
}

/// 带超时跑一次 CLI 的只读子命令，取完整 stdout（去首尾空白）；超时或失败杀掉子进程返回 None
fn cli_output_with_timeout(
    path: &std::path::Path,
    args: &[&str],
    timeout: std::time::Duration,
) -> Option<String> {
    cli_output_with_env(path, args, &[], timeout)
}

fn cli_output_with_env(
    path: &std::path::Path,
    args: &[&str],
    envs: &[(String, String)],
    timeout: std::time::Duration,
) -> Option<String> {
    let mut cmd = crate::process::background_command(path);
    cmd.envs(envs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    quiet_cli_probe(&mut cmd, path);
    let mut child = cmd
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
    // 进程已退出：输出躺在管道缓冲里，读到 EOF 不会阻塞（--version / auth status 输出远小于缓冲）
    let out = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// 已登录但不一定能用的已知情形，接在「已检测到登录凭证」后面（凭证文件看不出来，只能提前说）
fn official_connected_caveat(agent_id: &str) -> &'static str {
    match agent_id {
        // 2026-10-28 本机实测：个人 Google 账号登录后 Gemini CLI 报 IneligibleTierError（UNSUPPORTED_CLIENT），
        // Google 已不让个人版 Code Assist 用这个客户端，改推 Antigravity；Workspace / 付费 Code Assist 账号不在此列
        "gemini" => "；注意：个人 Google 账号已不能用 Gemini CLI（Google 改推 Antigravity），只有 Workspace / 企业版 Code Assist 账号还能用，个人用户请改用 API 连接",
        _ => "",
    }
}

/// Claude Code 官方登录状态：macOS 上凭证在系统钥匙串、不落 ~/.claude/.credentials.json，
/// 只看文件会把已登录的人显示成「未登录」、让人以为要重新登录。文件查不到时问 `claude auth status`
/// （只读，JSON 的 loggedIn / authMethod；2.1.308 实证）。None = 问不到（没装 / 超时 / 输出变了）
fn claude_auth_status() -> Option<(bool, String)> {
    let path = resolve_binary("claude")?;
    let text = cli_output_with_timeout(&path, &["auth", "status", "--json"], std::time::Duration::from_secs(8))?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let logged_in = v.get("loggedIn")?.as_bool()?;
    let method = v.get("authMethod").and_then(|m| m.as_str()).unwrap_or("").to_string();
    Some((logged_in, method))
}

fn detect(spec: &AgentSpec) -> (Option<String>, Option<String>) {
    let path = match resolve_binary(spec.binary) {
        Some(p) => p,
        None => return (None, None),
    };
    let version = version_args_with_timeout(&path, spec.version_args, VERSION_QUERY_TIMEOUT);
    (Some(path.to_string_lossy().into_owned()), version)
}

/// 把 profile + keys.json 密钥翻译成启动 env/args。key 只在启动时刻读取，不外传。
/// model 为启动时选中的模型（调用方已兜底为 profile 模型列表的首个）。
/// env 名/固定参数等差异化数据全部来自 AgentSpec（agent_specs.rs）；
/// 只有无法纯数据化的注入形态保留分支逻辑（SpecialLaunch 各变体）。
/// 请求策略注入（仅 api 模式；官方账号拉起在上方已 early-return，不会走到这里）。
/// 只接 matrix §9 第 8 条实证过的通道，未实证 agent/字段一律不注（fail-loud 由能力表
/// 与校验提示承担）。getenv 解析 Header 值（Profile 只存变量名引用，不落密文）；
/// 变量不存在或为空时跳过该条 Header。
fn apply_request_policy_env(
    plan: &mut LaunchPlan,
    agent: &str,
    policy: &crate::profiles::RequestPolicy,
    getenv: &dyn Fn(&str) -> Option<String>,
) {
    // Header 名=环境变量名 → "Name: value" 逐行（claude/codebuddy 同格式，\n 连接，二进制实证）
    let inject_headers = |plan: &mut LaunchPlan, env_key: &str| {
        let lines: Vec<String> = policy
            .header_env
            .iter()
            .filter_map(|(h, var)| {
                getenv(var)
                    .filter(|v| !v.is_empty())
                    .map(|v| format!("{h}: {v}"))
            })
            .collect();
        if !lines.is_empty() {
            plan.env.push((env_key.into(), lines.join("\n")));
        }
    };
    match agent {
        "claude-code" => {
            // temperature/top_p 无独立 env：CLAUDE_CODE_EXTRA_BODY 解析为 JSON 对象后展开进
            // API 请求体（v2.x 二进制反编译实证），只写用户填了的字段
            let mut extra = serde_json::Map::new();
            if let Some(v) = policy.temperature {
                extra.insert("temperature".into(), serde_json::json!(v));
            }
            if let Some(v) = policy.top_p {
                extra.insert("top_p".into(), serde_json::json!(v));
            }
            if !extra.is_empty() {
                plan.env.push((
                    "CLAUDE_CODE_EXTRA_BODY".into(),
                    serde_json::Value::Object(extra).to_string(),
                ));
            }
            if let Some(v) = policy.max_output_tokens {
                plan.env
                    .push(("CLAUDE_CODE_MAX_OUTPUT_TOKENS".into(), v.to_string()));
            }
            if let Some(v) = &policy.reasoning_effort {
                plan.env
                    .push(("CLAUDE_CODE_EFFORT_LEVEL".into(), v.clone()));
            }
            inject_headers(plan, "ANTHROPIC_CUSTOM_HEADERS");
        }
        "codebuddy" => {
            // claude-code fork 但 env 前缀独立（v2.132.0 实测 ANTHROPIC_* 无效）；
            // 当前版本的通用策略入口是 max-output 环境变量；Header 仍使用独立
            // CODEBUDDY_CUSTOM_HEADERS 环境变量，避免把敏感值放进命令行。
            if let Some(v) = policy.max_output_tokens {
                plan.env
                    .push(("CODEBUDDY_CODE_MAX_OUTPUT_TOKENS".into(), v.to_string()));
            }
            inject_headers(plan, "CODEBUDDY_CUSTOM_HEADERS");
        }
        "qwen" => {
            // 0.22.0 bundle 实证：temperature/top_p 的通道只有 settings.json 条目级
            // generationConfig.samplingParams（「设为全局」写入），env 侧够不到；
            // env 唯一实证的策略通道是 QWEN_CODE_MAX_OUTPUT_TOKENS——注意若全局配置
            // 条目已带 samplingParams，qwen 会跳过该 env（条目优先）
            if let Some(v) = policy.max_output_tokens {
                plan.env
                    .push(("QWEN_CODE_MAX_OUTPUT_TOKENS".into(), v.to_string()));
            }
        }
        _ => {}
    }
}

/// grok 的 GROK_CONFIG overlay 构建（launch 注入与 preview 展示共用这一处）。
/// 实证口径（2026-08-31 grok-build main 源码 + 官方 user-guide 11-custom-models）：
/// overlay 白名单（config_override.rs OVERLAY_ALLOW_PATHS，fail-closed 丢弃未列出的键）
/// 只放行 [models] 全局块 / [features] / 少量 toolset 叶子，**[model.<id>] 明确不在内**
/// ——api_backend / context_window 经 overlay 注不进，只能由中转 /models 目录条目的
/// apiBackend / contextWindow 字段或用户 ~/.grok/config.toml 的 [model.*] 段提供。
/// 可注的是 [models] 全局默认：temperature/top_p/max_completion_tokens（注意键名）/
/// default_reasoning_effort/extra_headers；逐模型 [model.*] 与中转目录声明优先于它们。
/// Header 以 "$VAR" 引用透传（overlay 管线 expand_env_vars_in_toml 在 grok 进程内展开），
/// 密文不进 env 值、不进预览；变量缺失时 grok 行为未实证，按原样发送处理（用户自查）。
fn grok_config_overlay(profile: &Profile, model: Option<&str>) -> Option<serde_json::Value> {
    let mut models = serde_json::Map::new();
    // default：1.0.34 实证（remote_config/resolution.rs）开会话前先拿「有效默认模型」与
    // allowed_models 比对，不匹配直接拒启动——原话 "<id>" (your default) isn't allowed by
    // allowed_models. Broaden the patterns or remove allowed_models, then try again.。
    // 有效默认取自 ~/.grok/config.toml 的 [models].default（可能是别家绑定「设为全局默认」
    // 留下的模型），而 GROK_DEFAULT_MODEL 只是「偏好」、在这道门之后才生效（日志
    // source=env），救不回被拒的启动。overlay 白名单放行 [models] 全局块，故本次启动有
    // 模型时把它写成 default：比对随之通过，也顺带治「未注 default 时回落第一方 grok-*
    // 模型直连 xAI 代理」的老坑（2026-09-20 实测复现 + 修复）
    if let Some(m) = model {
        models.insert("default".into(), serde_json::json!(m));
    }
    // allowed_models：把模型列表收敛进选择器（不注则 GROK_MODELS_BASE_URL 网关的全量
    // 目录，动辄几百个，全进选择器）。空列表不注（allowed_models 空 = fail-closed
    // 一个都不匹配）；选中模型兜底并入，防选择器与默认模型脱节
    if !profile.models.is_empty() {
        let mut allowed = profile.models.clone();
        for m in model.into_iter().chain(profile.role_models.small.as_deref()) {
            if !allowed.iter().any(|x| x == m) {
                allowed.push(m.into());
            }
        }
        models.insert("allowed_models".into(), serde_json::json!(allowed));
    }
    // 后台小任务的模型（grok 1.0.62 内置配置参考：models.session_summary「会话标题与摘要」、
    // models.prompt_suggestion「输入框的下一句提示，未设走远端下发再到会话模型」）：用户全局 config 常把它们
    // 指到别的网关 / 第一方模型（本机实例：session_summary = 另一家网关的 claude-opus），Mesa 会话的标题与摘要
    // 就被送去那家计费。钉成连接「模型分工」的后台小模型，没指定用这次的主模型（都在 allowed_models 内）
    if let Some(m) = profile.role_models.small.as_deref().or(model) {
        models.insert("session_summary".into(), serde_json::json!(m));
        models.insert("prompt_suggestion".into(), serde_json::json!(m));
    }
    // 请求策略 → [models] 全局默认（effort 键名 default_reasoning_effort，
    // 档位集见 agent_specs::effort_options）
    let policy = &profile.request_policy;
    if let Some(v) = policy.temperature {
        models.insert("temperature".into(), serde_json::json!(v));
    }
    if let Some(v) = policy.top_p {
        models.insert("top_p".into(), serde_json::json!(v));
    }
    if let Some(v) = policy.max_output_tokens {
        models.insert("max_completion_tokens".into(), serde_json::json!(v));
    }
    if let Some(v) = policy
        .reasoning_effort
        .as_deref()
        .and_then(crate::agent_specs::canonical_reasoning_effort)
    {
        models.insert("default_reasoning_effort".into(), serde_json::json!(v));
    }
    if !policy.header_env.is_empty() {
        let headers: serde_json::Map<String, serde_json::Value> = policy
            .header_env
            .iter()
            .map(|(h, var)| (h.clone(), serde_json::json!(format!("${var}"))))
            .collect();
        models.insert("extra_headers".into(), serde_json::Value::Object(headers));
    }
    if models.is_empty() {
        None
    } else {
        Some(serde_json::json!({ "models": models }))
    }
}

/// 连接地址是不是 xAI 官方（api.x.ai 及其子域）：只有官方 key 能用 Grok 内置的服务端 web_search
pub(crate) fn grok_is_xai_endpoint(url: &str) -> bool {
    reqwest::Url::parse(url.trim())
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
        .is_some_and(|h| h == "x.ai" || h.ends_with(".x.ai"))
}

/// GROK_CONFIG overlay 的预览附注（preview_launch_plan 用）：如实交代注不进的字段去向
fn grok_overlay_note() -> String {
    "api_backend / context_window 不在 grok overlay 白名单内（[model.*] 表会被静默丢弃）；渠道有二：中转 /models 目录条目带 apiBackend / contextWindow 字段，或绑定设「API 后端」后经「设为全局默认」写入 ~/.grok/config.toml 的 [model.*] 段；目录缺 contextWindow 时 grok 按 256000 计".into()
}

/// 用户级 ~/.claude/settings.json（或 CLAUDE_CONFIG_DIR）env 里出现的键名（只读，不取值）。
/// settings 的 env 优先于进程环境：这些键 Mesa 不在 --settings 里盖掉，就会从用户全局漏进 Mesa 的会话
fn claude_user_settings_env_keys(profile: &Profile) -> Vec<String> {
    // 单测不读本机真实配置（结果会随机器变）：由 TEST_CLAUDE_USER_KEYS 注入
    #[cfg(test)]
    {
        let _ = profile;
        return tests::TEST_CLAUDE_USER_KEYS.with(|k| k.borrow().clone());
    }
    #[cfg(not(test))]
    read_claude_user_settings_env_keys(profile)
}

#[cfg_attr(test, allow(dead_code))]
fn read_claude_user_settings_env_keys(profile: &Profile) -> Vec<String> {
    let dir = profile
        .extra_env
        .get("CLAUDE_CONFIG_DIR")
        .cloned()
        .or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok())
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".claude")));
    let Some(text) = dir.and_then(|d| std::fs::read_to_string(d.join("settings.json")).ok()) else {
        return Vec::new();
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("env").and_then(|e| e.as_object()).map(|m| m.keys().cloned().collect()))
        .unwrap_or_default()
}

/// 用户 ~/.claude/settings.json 顶层出现的键名（只读，不取值）；单测不读本机
fn claude_user_top_keys(profile: &Profile) -> Vec<String> {
    #[cfg(test)]
    {
        let _ = profile;
        return tests::TEST_CLAUDE_TOP_KEYS.with(|k| k.borrow().clone());
    }
    #[cfg(not(test))]
    {
        let Some(dir) = profile
            .extra_env
            .get("CLAUDE_CONFIG_DIR")
            .cloned()
            .or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok())
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".claude")))
        else {
            return Vec::new();
        };
        std::fs::read_to_string(dir.join("settings.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.as_object().map(|m| m.keys().cloned().collect()))
            .unwrap_or_default()
    }
}

/// 用户 ~/.claude/settings.json 顶层的 `model`（只读）。中转常把它设成 glm 之类，官方账号认不得；单测不读本机
fn claude_user_top_model(profile: &Profile) -> Option<String> {
    #[cfg(test)]
    {
        let _ = profile;
        return tests::TEST_CLAUDE_TOP_MODEL.with(|k| k.borrow().clone());
    }
    #[cfg(not(test))]
    {
        let dir = profile
            .extra_env
            .get("CLAUDE_CONFIG_DIR")
            .cloned()
            .or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok())
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".claude")))?;
        let text = std::fs::read_to_string(dir.join("settings.json")).ok()?;
        serde_json::from_str::<serde_json::Value>(&text)
            .ok()?
            .get("model")?
            .as_str()
            .map(str::to_string)
    }
}

/// Claude Code 的「谁用哪个模型」整套 env（--settings 覆盖层与进程 env 共用这一份，2026-10-17 端到端核对后重写）。
///
/// 假网关实测（Claude 2.1.292）：Mesa 原先只按绑定名单填前几个槽位，用户全局 settings.json 里的
/// ANTHROPIC_DEFAULT_HAIKU_MODEL / CLAUDE_CODE_SUBAGENT_MODEL 照样生效——会话标题生成、子 agent 的请求带着
/// 全局的 glm-5.3 打到 Mesa 选的网关，换成别家网关就直接失败。所以：
/// - 四个槽位全填：绑定名单不够四个时，空槽用这次选的模型（没选用名单第一个）补上；ANTHROPIC_SMALL_FAST_MODEL 跟 HAIKU 槽。
/// - 子 agent 模型只在用户全局设了时才盖（设成这次的模型）：没设时保持 Claude 原生「继承主模型 / 按 frontmatter 选」。
/// - 上下文窗口：确知 >200K 时声明；用户全局设过而这次不确知时写回 Claude 对未知模型的默认 200000，免得沿用全局的 1M。
fn claude_model_env(profile: &Profile, model: Option<&str>, user_keys: &[String]) -> Vec<(String, String)> {
    let mut env = Vec::new();
    let selected = model.map(str::trim).filter(|m| !m.is_empty());
    let fill = selected.or_else(|| profile.models.iter().map(String::as_str).find(|m| !m.trim().is_empty()));
    // 空槽只在绑定列了模型（第三方网关）时补：没列模型 = 用 Claude 自己的别名映射，不去改它
    let slot_fill = if profile.models.is_empty() { None } else { fill };
    // 连接里「模型分工」指定的后台小模型 / 子 Agent 模型（RoleModels）：指定了就用，没指定跟主模型
    let small = profile.role_models.small.as_deref();
    let subagent = profile.role_models.subagent.as_deref();
    const SLOTS: [&str; 4] = ["SONNET", "OPUS", "HAIKU", "FABLE"];
    let mut haiku = None;
    for (i, slot) in SLOTS.iter().enumerate() {
        // haiku 别名就是 Claude 的「后台小模型」：会话标题、网页摘要等小任务用它
        let pinned = if *slot == "HAIKU" { small } else { None };
        let Some(m) = pinned.or(profile.models.get(i).map(String::as_str)).or(slot_fill) else {
            continue;
        };
        if *slot == "HAIKU" {
            haiku = Some(m.to_string());
        }
        env.push((format!("ANTHROPIC_DEFAULT_{slot}_MODEL"), m.to_string()));
        env.push((format!("ANTHROPIC_DEFAULT_{slot}_MODEL_NAME"), format!("{} · {m}", profile.name)));
    }
    if let Some(fifth) = profile.models.get(4) {
        env.push(("ANTHROPIC_CUSTOM_MODEL_OPTION".into(), fifth.clone()));
        env.push(("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".into(), format!("{} · {fifth}", profile.name)));
    }
    if let Some(m) = selected {
        env.push(("ANTHROPIC_MODEL".into(), m.to_string()));
    }
    if let Some(h) = haiku {
        env.push(("ANTHROPIC_SMALL_FAST_MODEL".into(), h));
    }
    let user_has = |k: &str| user_keys.iter().any(|x| x == k);
    if let Some(m) = subagent {
        // 连接里指定了子 Agent 模型：明确写（非 FORCE，Task 参数 / frontmatter 显式选的仍可盖过它）
        env.push(("CLAUDE_CODE_SUBAGENT_MODEL".into(), m.to_string()));
        if user_has("CLAUDE_CODE_SUBAGENT_MODEL_FORCE") {
            env.push(("CLAUDE_CODE_SUBAGENT_MODEL_FORCE".into(), m.to_string()));
        }
    } else if let Some(m) = fill {
        for k in ["CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE"] {
            if user_has(k) {
                env.push((k.into(), m.to_string()));
            }
        }
    }
    // 模型能力库确知「不会思考」的主模型：不发思考参数（Claude 对不认识的模型默认带 adaptive thinking，
    // 不收这个参数的网关会 400）。假网关实测 MAX_THINKING_TOKENS=0 去掉 thinking 字段，
    // CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING 不去（2026-10-17）
    if selected.is_some_and(|m| {
        crate::model_registry::model_thinking_declared_for(m, profile.gateway_id.as_deref()) == Some(false)
    }) {
        env.push(("MAX_THINKING_TOKENS".into(), "0".into()));
    }
    // 用 declared 视图：门限是 >200K，估值不当声明（见进程 env 旧注释，口径不变）
    let declared = selected.and_then(|m| {
        crate::model_registry::model_context_size_declared_for(m, profile.gateway_id.as_deref())
    });
    let ctx = match declared {
        Some(c) if c > 200_000 => Some(c),
        _ if user_has("CLAUDE_CODE_MAX_CONTEXT_TOKENS") || user_has("CLAUDE_CODE_AUTO_COMPACT_WINDOW") => {
            Some(declared.unwrap_or(200_000))
        }
        _ => None,
    };
    if let Some(c) = ctx {
        // 自动压缩窗口与上限成对注入、同值（cc-switch 校准口径）
        env.push(("CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(), c.to_string()));
        env.push(("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), c.to_string()));
    }
    // 非 Claude 模型关掉工具搜索（ToolSearch）：Claude Code 对第三方网关也开着，内置工具 Bash / Read / Write 照常发，
    // 另把十来个少用的工具藏到 ToolSearch 后面。glm-5.3-flash 会拿 ToolSearch 去「搜」Write / Bash，
    // 搜不到（它们本来就在、不在延迟列表里）就断定没有工具、整轮不干活（2026-10-21 用户会话实证；假网关核对：
    // 关掉后 ToolSearch 与占位工具消失，24 个工具一次发全）。用户自己设过就不动
    if fill.is_some_and(|m| !m.to_ascii_lowercase().starts_with("claude-")) && !user_has("ENABLE_TOOL_SEARCH") {
        env.push(("ENABLE_TOOL_SEARCH".into(), "false".into()));
    }
    // 非 Claude 模型打开任务清单工具（TaskCreate / TaskUpdate…）：Claude Code 2.1.306 只给自家老模型（≤ opus-4-7 / sonnet-4-6）
    // 默认发，别的模型名一律不发，模型就说「没有待办 / 计划工具」、只能用 Markdown 列计划，聊天层画不出计划卡
    // （2026-10-21 用户会话实证 glm-5.3；假网关核对：加上后多出 4 个 Task 工具）。Claude 新模型是官方有意不发，不动
    if fill.is_some_and(|m| !m.to_ascii_lowercase().starts_with("claude-")) && !user_has("CLAUDE_CODE_ENABLE_TODO_TOOLS") {
        env.push(("CLAUDE_CODE_ENABLE_TODO_TOOLS".into(), "1".into()));
    }
    env
}

/// Claude Code 的 settings.json env 会覆盖父进程 shell env。用 --settings 传入一个高优先级
/// 覆盖层，避免用户全局配置把 Mesa 当前连接静默改回另一家模型**或另一把密钥**。
///
/// 2026-09-27 修：此前只提升 base_url、不带 token（「认证密钥仍只存在子进程环境中」）。
/// 结果磁盘 `~/.claude/settings.json` 的 `env` 块里残留的 `ANTHROPIC_AUTH_TOKEN` 依然按
/// 配置层优先级胜出，而 base_url 已被换成本次网关 —— 请求带着别家的令牌打到新网关，
/// 表现是 401「令牌已过期或验证不正确」（GLM 案例）。token 必须与 base_url 同层配对，
/// 与 global_config::patch_claude_settings 的写法对齐。
///
/// 密钥不内联进 argv（`ps` 可见），改为写一个 0600 临时文件后以路径传入。
fn claude_settings_override(
    profile: &Profile,
    key: Option<&str>,
    model: Option<&str>,
) -> Result<String, String> {
    let mut env = serde_json::Map::new();
    if profile.account_type == crate::profiles::AccountType::Api {
        if let Some(url) = profile.base_url.as_deref().filter(|u| !u.trim().is_empty()) {
            env.insert("ANTHROPIC_BASE_URL".into(), serde_json::json!(url));
        }
        if let Some(secret) = key.map(str::trim).filter(|k| !k.is_empty()) {
            env.insert("ANTHROPIC_AUTH_TOKEN".into(), serde_json::json!(secret));
        }
    }
    let user_keys = claude_user_settings_env_keys(profile);
    for (k, v) in claude_model_env(profile, model, &user_keys) {
        env.insert(k, serde_json::json!(v));
    }
    // 网关兼容选项：开着的写进覆盖层（磁盘 settings 盖过进程 env）；没开、磁盘却留着别家的开关时写空串
    for (k, v) in claude_compat_env(&profile.request_policy.compat) {
        match v {
            Some(v) => {
                env.insert(k.into(), serde_json::json!(v));
            }
            None if user_keys.iter().any(|u| u == k) && k != "API_TIMEOUT_MS" => {
                env.insert(k.into(), serde_json::json!(""));
            }
            None => {}
        }
    }
    let body = serde_json::json!({ "env": env }).to_string();
    write_settings_overlay_file("claude-settings", &body)
}

/// Claude Code 用户 settings.json env 里，属于「连接」的键（请求发到哪、凭什么鉴权、用哪个模型、走哪种协议）。
/// 这些键磁盘层盖过进程 env：别家留下的不写空，就会跟着 Mesa 这次的连接一起发出去（2026-10-28 假网关实测：
/// 别家的 `ANTHROPIC_API_KEY` 作 x-api-key、别家的 `ANTHROPIC_CUSTOM_HEADERS` 原样发到 Mesa 选的网关；
/// `CLAUDE_CODE_USE_BEDROCK=1` 时请求根本不去网关）。AWS / Vertex 区域等不在内：协议开关写空后它们不起作用，
/// 而它们可能是用户给 Claude 里跑的命令准备的
pub(crate) fn claude_connection_env_key(key: &str) -> bool {
    key.starts_with("ANTHROPIC_")
        || matches!(
            key,
            "CLAUDE_CODE_USE_BEDROCK"
                | "CLAUDE_CODE_USE_VERTEX"
                | "CLAUDE_CODE_USE_FOUNDRY"
                | "CLAUDE_CODE_USE_GATEWAY"
                | "CLAUDE_CODE_USE_MANTLE"
                | "CLAUDE_CODE_USE_ANTHROPIC_AWS"
                | "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD"
                | "CLAUDE_CODE_OAUTH_TOKEN"
                | "CLAUDE_CODE_OAUTH_REFRESH_TOKEN"
                | "CLAUDE_CODE_OAUTH_SCOPES"
        )
}

/// 顶层（不在 env 里）属于连接的键：apiKeyHelper 的输出会作 x-api-key 一起发出（实测），fallbackModel 是别家的模型名
const CLAUDE_CONNECTION_TOP_KEYS: &[&str] = &["apiKeyHelper", "fallbackModel"];

/// CodeBuddy 的连接键：同 Claude，settings.json env 盖过进程 env（2.177.0 实测：磁盘的地址和密钥压过 Mesa 注入的，
/// 请求带着磁盘那家的密钥打到磁盘那家），只能放进 `--settings`
const CODEBUDDY_CONNECTION_KEYS: &[&str] = &[
    "CODEBUDDY_BASE_URL",
    "CODEBUDDY_API_KEY",
    "CODEBUDDY_AUTH_TOKEN",
    "CODEBUDDY_MODEL",
    "CODEBUDDY_CUSTOM_HEADERS",
];

/// 进程 env 里某键最后一次的值（extra_env 排在最后，同名后者生效）
fn last_env(plan: &LaunchPlan, key: &str) -> Option<String> {
    plan.env.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.clone())
}

/// API 连接启动的最后一步：把磁盘配置层会盖过 Mesa 的连接键放进 `--settings` 覆盖层。
/// Claude：在已有覆盖文件里补——用户全局设过、覆盖层还没写的连接键，进程 env 里有值就用它（如请求头），
/// 没有就写空串（= 没设，2.1.308 实测）；顶层 apiKeyHelper / fallbackModel 同理写空。
/// CodeBuddy：新建覆盖文件，五个连接键一律写进去（没有的写空串）
fn finalize_settings_overlay(plan: &mut LaunchPlan, profile: &Profile) -> Result<(), String> {
    match profile.agent.as_str() {
        "claude-code" => {
            let Some(i) = plan.args.iter().position(|a| a == "--settings") else {
                return Ok(());
            };
            let Some(path) = plan.args.get(i + 1).cloned() else {
                return Ok(());
            };
            let user_keys = claude_user_settings_env_keys(profile);
            let user_top = claude_user_top_keys(profile);
            let pending: Vec<&String> = user_keys
                .iter()
                .filter(|k| claude_connection_env_key(k))
                .collect();
            let top: Vec<&str> = CLAUDE_CONNECTION_TOP_KEYS
                .iter()
                .copied()
                .filter(|k| user_top.iter().any(|u| u == k))
                .collect();
            if pending.is_empty() && top.is_empty() {
                return Ok(());
            }
            let text = std::fs::read_to_string(&path)
                .map_err(|e| format!("读取 Claude Code 设置覆盖文件失败: {e}"))?;
            let mut v: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| format!("Claude Code 设置覆盖文件损坏: {e}"))?;
            if let Some(env) = v.get_mut("env").and_then(|e| e.as_object_mut()) {
                for k in pending {
                    if !env.contains_key(k.as_str()) {
                        env.insert(k.clone(), serde_json::json!(last_env(plan, k).unwrap_or_default()));
                    }
                }
            }
            if let Some(obj) = v.as_object_mut() {
                for k in top {
                    obj.insert(k.into(), serde_json::json!(""));
                }
            }
            std::fs::write(&path, v.to_string())
                .map_err(|e| format!("写入 Claude Code 设置覆盖文件失败: {e}"))?;
        }
        "codebuddy" if profile.account_type == crate::profiles::AccountType::Api => {
            let mut env = serde_json::Map::new();
            for k in CODEBUDDY_CONNECTION_KEYS {
                env.insert((*k).into(), serde_json::json!(last_env(plan, k).unwrap_or_default()));
            }
            let body = serde_json::json!({ "env": env }).to_string();
            let path = write_settings_overlay_file("codebuddy-settings", &body)?;
            plan.args.insert(0, path);
            plan.args.insert(0, "--settings".into());
        }
        _ => {}
    }
    Ok(())
}

/// 设置里的共用环境变量（读时再过一遍拒收规则，手改设置文件塞进来的也不放行）；单测不读本机
fn shared_env() -> Vec<(String, String)> {
    #[cfg(test)]
    let map = tests::TEST_SHARED_ENV.with(|k| k.borrow().clone());
    #[cfg(not(test))]
    let map = crate::settings::read_current().shared_env.unwrap_or_default();
    map.into_iter()
        .filter(|(k, _)| crate::settings::shared_env_rejection(k).is_none())
        .collect()
}

/// 网关兼容选项 → Claude Code 的 env：(键, 开着时的值)。超时没设时不动用户自己的（它也可能是用户的全局偏好）
pub(crate) fn claude_compat_env(c: &crate::profiles::GatewayCompat) -> [(&'static str, Option<String>); 3] {
    [
        ("API_TIMEOUT_MS", c.timeout_secs.map(|s| (u64::from(s) * 1000).to_string())),
        ("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", c.no_experimental_betas.then(|| "1".to_string())),
        ("CLAUDE_CODE_DISABLE_THINKING", c.no_thinking.then(|| "1".to_string())),
    ]
}

/// `--settings` 覆盖文件：含密钥载体，必须 0600 落盘（与 write_external_wrapper 同口径），用完定时清掉
fn write_settings_overlay_file(prefix: &str, body: &str) -> Result<String, String> {
    let dir = external_wrapper_dir()?;
    let path = dir.join(format!("{prefix}-{}.json", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| format!("创建 Claude Code 设置覆盖文件失败: {e}"))?;
    use std::io::Write;
    file.write_all(body.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| {
            let _ = std::fs::remove_file(&path);
            format!("写入 Claude Code 设置覆盖文件失败: {e}")
        })?;
    schedule_wrapper_cleanup(path.clone());
    Ok(path.to_string_lossy().into_owned())
}

/// Gemini CLI 的认证方式只看用户 settings 的 `security.auth.selectedType`，环境变量只在它没设时兜底
/// （0.64 validateNonInteractiveAuth：`configuredAuthType || getAuthTypeFromEnv()`）。2026-10-17 端到端实测：
/// - 用户本机选过 Google 账号登录（oauth-personal）：Mesa 注入的 GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL 全被无视，
///   拉起后直接要开浏览器登录，请求到不了所选网关；
/// - 没选过、但注入了 GOOGLE_GEMINI_BASE_URL：环境推断出 gateway 认证，CLI 模式报「Invalid auth method selected」；
/// - selectedType = gemini-api-key：请求按所选模型打到网关（/v1beta/models/<模型>:streamGenerateContent）。
/// 能盖过用户设置的系统设置层（GEMINI_CLI_SYSTEM_SETTINGS_PATH）要求文件归 root 所有，普通用户写的会被静默跳过，走不通；
/// 不替用户改配置文件——拦下来说清楚怎么改（「设为全局默认」会写 selectedType 并先备份）。
fn gemini_auth_blocker(profile: &Profile) -> Option<String> {
    let has_base = profile.base_url.as_deref().is_some_and(|u| !u.trim().is_empty());
    gemini_auth_blocker_for(gemini_selected_auth_type(profile).as_deref(), has_base, false)
}

/// 在终端里起 Gemini（pty_spawn）时的拦法：没选过认证方式也拦，不管带不带地址——交互界面第一次进门先问认证、
/// 再要把密钥存进系统钥匙串（2026-10-27 空 HOME 实录）。无头运行（-p）没有这两屏，环境变量兜底就够，仍按 launch_plan 的口径
pub(crate) fn gemini_interactive_blocker(profile: &Profile, has_key: bool) -> Option<String> {
    if profile.agent != "gemini" || (!has_key && profile.base_url.is_none()) {
        return None;
    }
    let has_base = profile.base_url.as_deref().is_some_and(|u| !u.trim().is_empty());
    gemini_auth_blocker_for(gemini_selected_auth_type(profile).as_deref(), has_base, true)
}

/// 用户 Gemini settings 的 security.auth.selectedType（只读）；单测不读本机（TEST_GEMINI_AUTH 注入）
fn gemini_selected_auth_type(profile: &Profile) -> Option<String> {
    #[cfg(test)]
    {
        let _ = profile;
        return tests::TEST_GEMINI_AUTH.with(|k| k.borrow().clone());
    }
    #[cfg(not(test))]
    {
    let dir = gemini_home(profile)?;
    let selected = std::fs::read_to_string(dir.join(".gemini").join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| {
            v.pointer("/security/auth/selectedType")
                .and_then(|x| x.as_str())
                .map(str::to_string)
        });
    selected
    }
}

/// Gemini 读 settings.json 的目录：连接上的 GEMINI_CLI_HOME > 进程环境 > 家目录（只读判定与聊天卡写入同一处）
pub(crate) fn gemini_home(profile: &Profile) -> Option<PathBuf> {
    profile
        .extra_env
        .get("GEMINI_CLI_HOME")
        .cloned()
        .or_else(|| std::env::var("GEMINI_CLI_HOME").ok())
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
}

/// 拦下的话里都带这一句：聊天层认它出「设成 API Key 并启动」卡（src/terminal-wait.ts GEMINI_AUTH_MARK 同字）
pub(crate) const GEMINI_AUTH_MARK: &str = "把认证方式设成 API Key";

/// interactive = 在终端里起（gemini_interactive_blocker）：没选过认证方式不带地址也拦。聊天层把这段话认成一张卡，
/// 点了只设认证方式（global_config::gemini_use_api_key_auth）
fn gemini_auth_blocker_for(selected: Option<&str>, has_base: bool, interactive: bool) -> Option<String> {
    let tail = format!(
        "{GEMINI_AUTH_MARK}就能直接用这条连接：在聊天里点「设成 API Key 并启动」，或在这条连接上点「设为全局默认」（都会先备份 ~/.gemini/settings.json）。"
    );
    match selected {
        Some("gemini-api-key") => None,
        None if !has_base && !interactive => None,
        None => Some(format!(
            "Gemini CLI 还没选认证方式（刚装好时是这样），会先问你用哪种认证、再要把密钥存进系统钥匙串。{tail}"
        )),
        Some(other) => {
            let now = match other {
                "oauth-personal" => "用 Google 账号登录",
                "vertex-ai" => "用 Vertex AI",
                _ => "用别的认证方式",
            };
            Some(format!(
                "Gemini CLI 现在{now}，会无视这条连接的密钥和地址，请求到不了网关。{tail}"
            ))
        }
    }
}

pub fn launch_plan(
    profile: &Profile,
    key: Option<String>,
    model: Option<&str>,
) -> Result<LaunchPlan, String> {
    let mut plan = LaunchPlan::default();
    // 空串/纯空白按「未选模型」归一：前端 buildAskAiPending 会带空串占位（防被启动栏上次的
    // 模型顶掉），Some("") 会让下面的 grok 兜底与各处 filter 全部失效，并把空模型写进
    // GROK_DEFAULT_MODEL / allowed_models / [models].default（2026-09-20 修）
    let model = model.map(str::trim).filter(|m| !m.is_empty());
    // 官方账号模式：不注入 base_url/密钥（用 CLI 自己的账号登录），仅按需注入选中模型；
    // 并按规格 purge 继承环境里的残留 API 密钥变量（防静默覆盖账号登录，§11.7）
    if profile.account_type == crate::profiles::AccountType::Official {
        if let Some(spec) = agent_spec(&profile.agent) {
            apply_official_inject(&mut plan, spec, profile, model);
        }
        // 出网代理：只给官方账号（网关启动不走）。extra_env 同名键排在后面覆盖。
        for (k, v) in crate::settings::official_outbound_env() {
            plan.env.push((k, v));
        }
        plan.env.extend(shared_env());
        // extra_env 依旧最后注入（用户显式覆盖的逃生口，与 api 模式一致）
        for (k, v) in &profile.extra_env {
            plan.env.push((k.clone(), v.clone()));
        }
        return Ok(plan);
    }
    // grok 未显式选模型时用绑定清单第一个兜底（2026-09-17 实测）：grok 按 id 路由，
    // 不注 GROK_DEFAULT_MODEL / -m 会回落 ~/.grok/config.toml 的 [models].default——
    // 通常是第一方 grok-* 模型，第一方 id 绕过网关直连 xAI 代理，失败形态是
    // 「连接超时」而非「模型不存在」，极易误诊成网关不通。其他 CLI 未选模型同样
    // 回落自家默认，但请求仍发往所选网关、报错可读，不做兜底。
    let model = model.or_else(|| {
        if profile.agent != "grok" {
            return None;
        }
        profile
            .models
            .iter()
            .find(|m| !m.trim().is_empty())
            .map(String::as_str)
    });
    if let Some(spec) = agent_spec(&profile.agent) {
        match &spec.launch {
            LaunchSpec::Env(env) => {
                apply_env_inject(&mut plan, env, profile, key.as_deref(), model);
                // gemini：认证方式不是 API Key 时注入的密钥和地址全被无视——拦下来说清楚（gemini_auth_blocker）
                if profile.agent == "gemini" && (key.is_some() || profile.base_url.is_some()) {
                    if let Some(msg) = gemini_auth_blocker(profile) {
                        return Err(msg);
                    }
                }
                // grok：GROK_CONFIG 是 JSON overlay（深合并进 config.toml）——模型名单
                // 收敛 + 请求策略 [models] 全局默认，构建与白名单口径见 grok_config_overlay
                if profile.agent == "grok" {
                    if let Some(overlay) = grok_config_overlay(profile, model) {
                        plan.env.push(("GROK_CONFIG".into(), overlay.to_string()));
                    }
                }
            }
            LaunchSpec::ByProtocol(entries) => {
                // 缺省 = 协议表第一个；未支持的取值（gemini/vertex-ai 暂不支持）也按第一个注入
                let default = spec.protocols.first().copied().unwrap_or("");
                let proto = profile.protocol.as_deref().unwrap_or(default);
                let entry = entries
                    .iter()
                    .find(|e| e.protocol == proto)
                    .or_else(|| entries.first());
                if let Some(entry) = entry {
                    apply_env_inject(&mut plan, &entry.env, profile, key.as_deref(), model);
                    for arg in entry.args {
                        plan.args.push((*arg).into());
                    }
                }
            }
            LaunchSpec::Special(special) => match special {
                SpecialLaunch::ClaudeModelSlots(env) => {
                    apply_env_inject(&mut plan, env, profile, key.as_deref(), model);
                    // settings.json 的 env 优先于 shell env；把本次连接的 base_url / 密钥 /
                    // 模型选择一并通过 --settings 提升到 CLI 配置层，防止全局 settings 覆盖。
                    // base_url 与 token 必须同层配对，只提其一会让请求带着旧令牌打到新网关（401）。
                    plan.args.push("--settings".into());
                    plan.args.push(claude_settings_override(
                        profile,
                        key.as_deref(),
                        model,
                    )?);
                    if let Some(selected) = model.filter(|m| !m.trim().is_empty()) {
                        plan.args.push("--model".into());
                        plan.args.push(selected.into());
                    }
                    if let Some(effort) = profile
                        .request_policy
                        .reasoning_effort
                        .as_deref()
                        .filter(|e| !e.trim().is_empty())
                    {
                        plan.args.push("--effort".into());
                        plan.args.push(effort.into());
                    }
                    // 槽位注册（/model 选择器列出绑定的模型）、空槽补齐、子 agent / 上下文窗口防全局泄漏：
                    // 与 --settings 覆盖层同一份（claude_model_env）。进程 env 也写一份，给不读 settings 的子进程用
                    for (k, v) in claude_model_env(profile, model, &claude_user_settings_env_keys(profile)) {
                        if k != "ANTHROPIC_MODEL" {
                            plan.env.push((k, v));
                        }
                    }
                }
                SpecialLaunch::CodexInlineProvider {
                    key_env,
                    sandbox_args,
                } => {
                    if let Some(key) = key {
                        plan.env.push(((*key_env).into(), key));
                    }
                    // Codex 没有 base URL 环境变量，且只支持 Responses API：
                    // 用 -c 内联定义 provider（名从网关派生；旧 rollout 回落 ccode）
                    let pid = profile.provider_name();
                    if let Some(url) = &profile.base_url {
                        plan.args
                            .extend(codex_inline_provider_args(url, key_env, &pid));
                        // 网关兼容选项：请求超时 → 渠道的 stream_idle_timeout_ms（0.164 二进制里有）
                        if let Some(secs) = profile.request_policy.compat.timeout_secs {
                            plan.args.push("-c".into());
                            plan.args.push(format!(
                                "model_providers.{pid}.stream_idle_timeout_ms={}",
                                u64::from(secs) * 1000
                            ));
                        }
                        // 中转不支持 ChatGPT 订阅档和官方 hosted 网页搜索；-c 只盖本进程
                        plan.args.extend(codex_relay_compat_args());
                    }
                    if let Some(model) = model {
                        plan.args.push("-m".into());
                        plan.args.push(model.into());
                        if profile.base_url.is_some() {
                            plan.args.extend(codex_relay_model_args(codex_user_config_for_launch().as_ref(), model));
                        }
                        // Override stale user-level Codex context limits for this session.
                        // The catalog and auto-compact threshold must follow the selected
                        // model, not whichever model was last used globally.
                        //
                        // 只在我们**确知**窗口时覆盖：注册链未知时宁可不写——codex 自己认得
                        // 的模型（原生 -c 内联 provider 下仍会查自家 registry）会得到正确窗口，
                        // 而写一个 128K 猜测等于把 272K/1M 的真实窗口压低，比不覆盖更坏；
                        // 「覆盖过期值」的诉求只在确知时才有意义，猜测覆盖不解决过期问题。
                        if let Some(context) = crate::model_registry::model_context_size_declared_for(
                            model,
                            profile.gateway_id.as_deref(),
                        ) {
                            plan.args.push("-c".into());
                            plan.args.push(format!("model_context_window={context}"));
                            plan.args.push("-c".into());
                            plan.args.push(format!(
                                "model_auto_compact_token_limit={}",
                                context.saturating_mul(95) / 100
                            ));
                        }
                        // 会话内自省入口：codex 没有模型/base URL 环境变量（matrix §2），配置又走
                        // 内联 -c 不落盘，agent 被问「你是什么模型」时 config.json/$CODEX_MODEL 全空。
                        // 注入 Mesa 命名空间的显示名（配置名 · 模型，与选择器口径一致），
                        // 对齐 kimi KIMI_MODEL_DISPLAY_NAME 先例；纯信息性，codex 本身不读
                        plan.env.push((
                            "CCODE_MODEL_DISPLAY_NAME".into(),
                            format!("{} · {model}", profile.name),
                        ));
                    }
                    // 默认沙箱：只能写当前工作目录（需全权限时在系统终端自行启动）
                    for arg in *sandbox_args {
                        plan.args.push((*arg).into());
                    }
                    // workspace-write 默认拦网：文献检索/查资料一联网就弹提权确认，
                    // 这里放开沙箱内联网（只影响 workspace-write 档，read-only 下该键被忽略）
                    plan.args.push("-c".into());
                    plan.args
                        .push("sandbox_workspace_write.network_access=true".into());
                    // 请求策略（实证通道）：effort = config 键 model_reasoning_effort；
                    // Header = provider env_http_headers（值是环境变量名引用，不落密文）。
                    // 后者依赖内联 provider 定义存在，无 base_url 时没有 ccode provider 可挂
                    if let Some(effort) = profile.request_policy.reasoning_effort.as_deref() {
                        plan.args.push("-c".into());
                        plan.args
                            .push(format!(r#"model_reasoning_effort="{effort}""#));
                    }
                    if profile.base_url.is_some() {
                        for (header, env_name) in &profile.request_policy.header_env {
                            plan.args.push("-c".into());
                            plan.args.push(format!(
                                r#"model_providers.{pid}.env_http_headers."{header}"="{env_name}""#
                            ));
                        }
                    }
                }
                SpecialLaunch::OpenCodeInlineConfig {
                    config_env,
                    no_autoupdate_env,
                } => {
                    // OpenCode 没有通用 key/baseURL 环境变量：用 OPENCODE_CONFIG_CONTENT 内联配置注入，
                    // 该层优先级高于 auth.json 和 env（matrix §5），行为确定
                    let pid = profile.provider_name();
                    let provider = opencode_provider_json(profile, key.as_deref(), model);
                    let mut providers = serde_json::Map::new();
                    providers.insert(pid.clone(), provider);
                    let mut config = serde_json::json!({ "provider": providers });
                    if let Some(m) = model {
                        config["model"] = serde_json::json!(format!("{pid}/{m}"));
                    }
                    // 连接「模型分工」的后台小模型 → small_model（会话标题这类小任务）；没指定时不写，
                    // opencode 对自定义 provider 回落到主模型（假网关实测标题请求带主模型，2026-10-17）
                    if let Some(small) = profile.role_models.small.as_deref() {
                        config["small_model"] = serde_json::json!(format!("{pid}/{small}"));
                    }
                    // 请求策略（config schema 实证：model options 含 temperature/topP/
                    // maxOutputTokens/reasoningEffort；provider options 支持 headers）。
                    // 在这里合并而不进 opencode_provider_json：该函数与全局写入共用，
                    // headers 值是拉起瞬间从进程环境解析的密文，绝不能走落盘路径
                    let policy = &profile.request_policy;
                    let mut model_opts = serde_json::Map::new();
                    if let Some(v) = policy.temperature {
                        model_opts.insert("temperature".into(), serde_json::json!(v));
                    }
                    if let Some(v) = policy.top_p {
                        model_opts.insert("topP".into(), serde_json::json!(v));
                    }
                    if let Some(v) = policy.max_output_tokens {
                        model_opts.insert("maxOutputTokens".into(), serde_json::json!(v));
                    }
                    if let Some(v) = policy.reasoning_effort.as_deref() {
                        model_opts.insert("reasoningEffort".into(), serde_json::json!(v));
                    }
                    if !model_opts.is_empty() {
                        if let Some(m) = model {
                            if let Some(entry) = config["provider"][&pid]["models"].get_mut(m) {
                                entry["options"] = serde_json::Value::Object(model_opts.clone());
                            }
                        }
                    }
                    let headers: serde_json::Map<String, serde_json::Value> = policy
                        .header_env
                        .iter()
                        .filter_map(|(h, var)| {
                            std::env::var(var)
                                .ok()
                                .filter(|v| !v.is_empty())
                                .map(|v| (h.clone(), serde_json::json!(v)))
                        })
                        .collect();
                    if !headers.is_empty() {
                        config["provider"][&pid]["options"]["headers"] =
                            serde_json::Value::Object(headers);
                    }
                    plan.env.push(((*config_env).into(), config.to_string()));
                    // 防止自更新在启动时替换掉我们检测到的二进制
                    plan.env.push(((*no_autoupdate_env).into(), "1".into()));
                }
                SpecialLaunch::KimiDualChannel => {
                    // 新旧两个产品共用 kimi 命令：新版故意忽略 shell env 的 API key，只认
                    // KIMI_MODEL_* 合成通道；旧版读 KIMI_API_KEY/KIMI_BASE_URL。
                    // 两组都设，各变体忽略自己不读的；KIMI_MODEL_NAME 两边通用。
                    // 新版通道需模型名才启用：无模型时整组跳过，回落到用户自己的配置。
                    // env 名留在代码里：双通道的条件结构无法纯数据化
                    if let Some(model) = model {
                        plan.env.push(("KIMI_MODEL_NAME".into(), model.into()));
                        let provider_type = profile.protocol.clone().unwrap_or_else(|| {
                            spec.protocols.first().copied().unwrap_or("kimi").into()
                        });
                        plan.env
                            .push(("KIMI_MODEL_PROVIDER_TYPE".into(), provider_type.clone()));
                        if let Some(key) = &key {
                            plan.env.push(("KIMI_MODEL_API_KEY".into(), key.clone()));
                        }
                        if let Some(url) = &profile.base_url {
                            plan.env.push(("KIMI_MODEL_BASE_URL".into(), url.clone()));
                        }
                        // 合成模型的元数据（2026-08-17 二进制实证）：
                        // 选择器 label 优先 displayName——用 profile 名避免显示成内部名。
                        // capabilities 的判定见下方 provider_type != "kimi" 分支的实证注释。kimi 官方
                        // 协议通道缺省 [`image_in`,`thinking`] 已合理，不注入以免覆盖丢 image_in。
                        plan.env.push((
                            "KIMI_MODEL_DISPLAY_NAME".into(),
                            format!("{} · {model}", profile.name),
                        ));
                        // env 通道与 config.toml 不同：未设时 kimi 用
                        // `parsePositiveInt(raw) ?? DEFAULT_MAX_CONTEXT_SIZE` 兜底，
                        // **不报错**（config.toml 缺了才硬抛 "must define a positive
                        // max_context_size"）。所以这里未知就不写——写 128K 猜测会让
                        // 1M 窗口的模型被 CLI 按 128K 算，比不写更坏。
                        if let Some(ctx) = crate::model_registry::model_context_size_declared_for(
                            model,
                            profile.gateway_id.as_deref(),
                        ) {
                            plan.env.push((
                                "KIMI_MODEL_MAX_CONTEXT_SIZE".into(),
                                ctx.to_string(),
                            ));
                        }
                        if provider_type != "kimi" {
                            // 二进制实证（kimi 2.1.0）：env 通道未设 KIMI_MODEL_CAPABILITIES 时
                            // 兜底是 `DEFAULT_CAPABILITIES = ["image_in","thinking"]`——它**不含
                            // tool_use**，所以这里不能一省了之（省了就是没工具）；而缺省值本身已含
                            // image_in/thinking，所以写窄了（少写 image_in）反而是降级。
                            //
                            // 该数组是**完备声明**：CLI 用 `capabilities.some(===)` 判成员，
                            // 不在表里就等于「不支持」。所以只写「确知为真」的 plus CLI 自己的
                            // 缺省集——让这次写入只可能加、不可能减。估值层的猜测（关键词推断、
                            // 128K/256K 保守默认）不配当声明。
                            //
                            // 旧注释称「兼容协议通道 capabilities 缺省只有 ["tool_use"]」张冠李戴：
                            // 那是 CUSTOM_REGISTRY_DEFAULT_CAPABILITIES（自定义注册项），非本通道。
                            let thinking = crate::model_registry::model_thinking_declared_for(
                                model,
                                profile.gateway_id.as_deref(),
                            );
                            let vision = crate::model_registry::model_supports_vision_declared_for(
                                model,
                                profile.gateway_id.as_deref(),
                            );
                            // None = 未确知：保留 CLI 缺省里的成员（不替它摘），确知为假才摘
                            let mut caps = vec!["tool_use"];
                            if thinking != Some(false) {
                                caps.push("thinking");
                            }
                            if vision != Some(false) {
                                caps.push("image_in");
                            }
                            plan.env
                                .push(("KIMI_MODEL_CAPABILITIES".into(), caps.join(",")));
                        } else if let Some(effort) = &profile.request_policy.reasoning_effort {
                            // KIMI_MODEL_THINKING_EFFORT（2026-08-28 二进制实证：原样透传 +
                            // 小写归一，env 路径无闭集校验；仅 kimi 协议通道读取，
                            // 兼容协议通道会被静默忽略所以干脆不注）
                            plan.env
                                .push(("KIMI_MODEL_THINKING_EFFORT".into(), effort.to_lowercase()));
                        }
                        plan.args.extend(kimi_env_model_args(
                            crate::agent_specs::variant_of(spec),
                        ));
                    }
                    if let Some(key) = &key {
                        plan.env.push(("KIMI_API_KEY".into(), key.clone()));
                    }
                    if let Some(url) = &profile.base_url {
                        plan.env.push(("KIMI_BASE_URL".into(), url.clone()));
                    }
                }
                SpecialLaunch::CursorFlags {
                    key_env,
                    endpoint_env,
                    model_flag,
                } => {
                    // CURSOR_API_KEY 只交给 Cursor 自家云去换登录（/auth/exchange_user_api_key）。
                    // 第三方网关的钥匙换不成，CLI 会报 “API key is invalid”。这种绑定直接拒绝启动，
                    // 不再把网关钥匙写进环境。官方账号路径另有 env_remove，清掉残留钥匙。
                    let endpoint = profile
                        .base_url
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    if let Some(url) = endpoint {
                        if !cursor_cloud_endpoint(url) {
                            return Err(
                                "Cursor 不接受这个网关的钥匙。CURSOR_API_KEY 只能是 cursor.com 的用户 API Key，GLM 这类网关的钥匙换不了 Cursor 登录。请改用「官方账号」，在终端执行 cursor-agent login；或新建一条不填第三方地址的连接，钥匙用 cursor.com/dashboard 里创建的用户 API Key。".into(),
                            );
                        }
                        plan.env.push(((*endpoint_env).into(), url.into()));
                    }
                    if let Some(key) = key {
                        plan.env.push(((*key_env).into(), key));
                    }
                    if let Some(model) = model {
                        plan.args.push((*model_flag).into());
                        plan.args.push(model.into());
                    }
                }
            },
        }
    }
    if profile.agent == "grok" {
        // Grok 1.0.x 的 CLI flag 优先级高于全局 config，确保启动栏选中的模型/思考档
        // 真正作用于本次会话。api_backend 仍只能由逐模型 config 或网关目录声明提供。
        if let Some(selected) = model.filter(|m| !m.trim().is_empty()) {
            plan.args.push("-m".into());
            plan.args.push(selected.into());
        }
        if let Some(effort) = profile
            .request_policy
            .reasoning_effort
            .as_deref()
            .and_then(crate::agent_specs::canonical_reasoning_effort)
            .filter(|e| crate::agent_specs::GROK_REASONING_EFFORTS.contains(&e.as_str()))
        {
            plan.args.push("--reasoning-effort".into());
            plan.args.push(effort);
        }
        // 内置 web_search 是 xAI 的服务端搜索：另用一个 grok-4.x 搜索模型、拿 XAI_API_KEY 去 xAI 鉴权，
        // 经第三方网关时那把钥匙在 xAI 那边 401（2026-10-21 用户：内置的 web_search 工具报了 401 授权错误）。
        // 连接地址不是 xAI 官方就关掉（--disable-web-search 连带关 web_fetch，它默认本来就关）
        if profile.account_type == crate::profiles::AccountType::Api
            && profile.base_url.as_deref().is_some_and(|u| !grok_is_xai_endpoint(u))
        {
            plan.args.push("--disable-web-search".into());
        }
    }
    // CodeBuddy 的 effort 是 CLI flag，不是环境变量；只在启动时携带，避免伪造配置文件字段。
    if profile.agent == "codebuddy" {
        if let Some(selected) = model.filter(|m| !m.trim().is_empty()) {
            plan.args.push("--model".into());
            plan.args.push(selected.into());
        }
        if let Some(effort) = profile
            .request_policy
            .reasoning_effort
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            plan.args.push("--effort".into());
            plan.args.push(effort.into());
        }
    }
    // 请求策略注入：按能力表实证通道落地，extra_env 仍可最后覆盖
    apply_request_policy_env(&mut plan, &profile.agent, &profile.request_policy, &|k| {
        std::env::var(k).ok()
    });
    // opencode（opentui）按终端身份名单决定通知协议，Mesa 不在名单里 → 全程静默；
    // 它官方提供 env 覆盖出口：指到 OSC 777，Mesa 已能消费 notify;title;body 三段式
    // （2026-10-10 调研实证 terminal.zig detectNotificationProtocol / OPENTUI_NOTIFICATION_PROTOCOL）
    if profile.agent == "opencode"
        && !profile.extra_env.contains_key("OPENTUI_NOTIFICATION_PROTOCOL")
    {
        plan.env.push(("OPENTUI_NOTIFICATION_PROTOCOL".into(), "osc777".into()));
    }
    // 共用环境变量（设置里）在前，连接自己的附加环境变量在后覆盖
    plan.env.extend(shared_env());
    // 附加环境变量放在最后：CommandBuilder 重复 env 后者生效，用户可借此覆盖 adapter 内置值
    for (k, v) in &profile.extra_env {
        plan.env.push((k.clone(), v.clone()));
    }
    finalize_settings_overlay(&mut plan, profile)?;
    if profile.no_auth {
        for key in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "CODEBUDDY_API_KEY",
            "CODEBUDDY_AUTH_TOKEN",
            "CURSOR_API_KEY",
            "XAI_API_KEY",
            "GROK_CODE_XAI_API_KEY",
            "KIMI_API_KEY",
            "KIMI_MODEL_API_KEY",
        ] {
            if !plan.env_remove.iter().any(|existing| existing == key) {
                plan.env_remove.push(key.into());
            }
        }
    }
    Ok(plan)
}

/// 带初始 prompt 的启动计划（一键开步首条指令）：api / 官方账号两种模式同样适用。
/// 注入形态读注册表 prompt_inject：Positional → prompt_args 单元素（pty_spawn 放最后），
/// Flag → `-i <prompt>`；Unsupported 或未知 agent 不注入并置 prompt_dropped 标记。
pub fn launch_plan_with_prompt(
    profile: &Profile,
    key: Option<String>,
    model: Option<&str>,
    initial_prompt: Option<&str>,
) -> Result<LaunchPlan, String> {
    let mut plan = launch_plan(profile, key, model)?;
    let Some(prompt) = initial_prompt.map(str::trim).filter(|p| !p.is_empty()) else {
        return Ok(plan);
    };
    match agent_spec(&profile.agent).map(|s| s.prompt_inject) {
        Some(crate::agent_specs::PromptInject::Positional) => {
            plan.prompt_args.push(prompt.into());
        }
        Some(crate::agent_specs::PromptInject::Flag(flag)) => {
            plan.prompt_args.push(flag.into());
            plan.prompt_args.push(prompt.into());
        }
        // 该 CLI 无交互模式初始 prompt 参数（目前仅 kimi）：不注入，让前端提示手动发送
        Some(crate::agent_specs::PromptInject::Unsupported) | None => {
            plan.prompt_dropped = true;
        }
    }
    Ok(plan)
}

/// Check whether the selected profile can be represented by a CLI launch plan.
/// Grok's inline overlay can carry global model defaults, but cannot carry a
/// per-model `api_backend`; refusing non-default backends is safer than
/// silently sending a Responses/Messages profile as Chat Completions.
pub fn validate_launch_compatibility(
    profile: &Profile,
    selected_model: Option<&str>,
) -> Result<(), String> {
    // 出图 / 视频 / 向量等模型当对话模型，CLI 每一轮都被网关拒（2026-10-23 gpt-image-2.5 实例）：启动前拦下说原因
    if let Some(model) = selected_model.or_else(|| profile.models.first().map(String::as_str)) {
        if let Some(msg) = crate::image_gen::non_chat_launch_error(model) {
            return Err(msg);
        }
    }
    if profile.agent == "grok" && profile.account_type == crate::profiles::AccountType::Api {
        let backend = profile.api_backend.as_deref().unwrap_or("chat_completions");
        if backend != "chat_completions" {
            let model = selected_model
                .or_else(|| profile.models.first().map(String::as_str))
                .unwrap_or("");
            let home = profile
                .extra_env
                .get("GROK_HOME")
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("GROK_HOME")
                        .filter(|s| !s.is_empty())
                        .map(PathBuf::from)
                })
                .or_else(|| dirs::home_dir().map(|home| home.join(".grok")))
                .ok_or("无法确定 Grok 配置目录")?;
            let path = home.join("config.toml");
            let text = std::fs::read_to_string(&path).map_err(|_| {
                format!(
                    "Grok 模型 {model} 使用 {backend}，但未找到 {}；请先「设为全局默认」",
                    path.display()
                )
            })?;
            if !grok_model_config_matches(&text, model, backend, profile.base_url.as_deref()) {
                return Err(format!(
                    "Grok 模型 {model} 的 apiBackend={backend} 尚未写入 {}；请先「设为全局默认」后再启动",
                    path.display()
                ));
            }
        }
    }
    Ok(())
}

/// Grok 的思考档只对「目录 / config 里声明了档位」的模型生效：别家模型（网关里的 glm、deepseek…）
/// `--reasoning-effort` 与 `[models].default_reasoning_effort` 都被忽略，CLI 原话
/// 「<模型> has no effort levels; ignoring --effort/--reasoning-effort」（1.0.62 假网关实测，2026-10-17）。
/// 声明的唯一可达位置是用户 ~/.grok/config.toml 的 [model."<id>"]（overlay 白名单不收），
/// 「设为全局默认」会写 supports_reasoning_effort + reasoning_efforts。只读判断，供求交器决定给不给档
pub(crate) fn grok_model_declares_effort(model: &str) -> bool {
    #[cfg(test)]
    {
        let _ = model;
        return false;
    }
    #[cfg(not(test))]
    {
        let home = std::env::var_os("GROK_HOME")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".grok")));
        let Some(text) = home.and_then(|h| std::fs::read_to_string(h.join("config.toml")).ok()) else {
            return false;
        };
        let Ok(v) = toml::from_str::<toml::Value>(&text) else {
            return false;
        };
        v.get("model")
            .and_then(|m| m.get(model))
            .is_some_and(|entry| {
                entry.get("supports_reasoning_effort").and_then(|x| x.as_bool()) == Some(true)
                    || entry
                        .get("reasoning_efforts")
                        .and_then(|x| x.as_array())
                        .is_some_and(|a| !a.is_empty())
            })
    }
}

fn grok_model_config_matches(
    text: &str,
    model: &str,
    backend: &str,
    base_url: Option<&str>,
) -> bool {
    let Ok(doc) = text.parse::<toml::Value>() else {
        return false;
    };
    let Some(entry) = doc
        .get("model")
        .and_then(|v| v.get(model))
        .and_then(|v| v.as_table())
    else {
        return false;
    };
    if entry.get("api_backend").and_then(|v| v.as_str()) != Some(backend) {
        return false;
    }
    base_url
        .map(|url| {
            entry
                .get("base_url")
                .and_then(|v| v.as_str())
                .is_some_and(|configured| {
                    configured.trim_end_matches('/') == url.trim_end_matches('/')
                })
        })
        .unwrap_or(true)
}

/// 「聊想法」只读模式（硬保护，想法期防 agent 擅自改主仓文件）：在启动计划 args 上应用
/// 注册表 readonly_args。codex 特殊：只读要替换默认的 `-s workspace-write`
///（重复 -s 哪个生效未文档化，不赌后者生效——先剔除原沙箱参数对再追加）。
/// 返回 None = 该 CLI 无只读/计划模式参数；discuss 启动必须拒绝，不得沿用可写参数。
/// 剔除 `-s/--sandbox <值>` 参数对（值是分离的下一个参数）：codex 重复 -s 的生效顺序未文档化，换沙箱前先剔
fn without_sandbox_pair(base_args: &[String]) -> Vec<String> {
    let mut filtered = Vec::with_capacity(base_args.len());
    let mut skip_next = false;
    for a in base_args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if a == "-s" || a == "--sandbox" {
            skip_next = true;
            continue;
        }
        filtered.push(a.clone());
    }
    filtered
}

pub fn readonly_launch_args(agent_id: &str, base_args: &[String]) -> Option<Vec<String>> {
    let spec = agent_spec(agent_id)?;
    if spec.readonly_args.is_empty() {
        return None;
    }
    if let Some(min) = readonly_min_version(agent_id) {
        if !cli_version(agent_id).is_some_and(|v| v >= min) {
            return None;
        }
    }
    let mut args: Vec<String> = if agent_id == "codex" {
        without_sandbox_pair(base_args)
    } else {
        base_args.to_vec()
    };
    for a in spec.readonly_args {
        args.push((*a).into());
    }
    Some(args)
}

/// 只讨论要看版本的家（2026-10-26 本机实测的版本）：低于它或查不到版本就当没有只讨论，启动时拒绝、徽标置灰。
/// Qwen 更早的版本 `--approval-mode` 没有 plan（0.21.1 连这个参数都没有）；OpenCode 的 plan_exit 与权限写法按 1.19.3 核对
pub(crate) fn readonly_min_version(agent_id: &str) -> Option<(u32, u32, u32)> {
    match agent_id {
        "qwen" => Some((0, 25, 3)),
        "opencode" => Some((1, 19, 3)),
        _ => None,
    }
}

/// 检测结果里的「能不能只讨论」：注册表有只读参数，且要看版本的家版本够
fn readonly_supported_at(spec: &AgentSpec, version: Option<&str>) -> bool {
    !spec.readonly_args.is_empty()
        && readonly_min_version(spec.id)
            .is_none_or(|min| version.and_then(parse_cli_semver).is_some_and(|v| v >= min))
}

/// OpenCode 只讨论时 plan agent 的权限（经 OPENCODE_CONFIG_CONTENT 注入，不写用户配置）。自带的 plan agent 只禁了改文件，
/// bash、子任务、MCP 工具都不问就跑（1.19.3 实测 `echo > 文件` 直接写成）；这里先把一切改成要问，再放行只读的几样，
/// 改文件只放行方案文件（`.opencode/plans/` 或数据目录 `opencode/plans/`，通配符 * 跨目录）
fn opencode_plan_permission() -> serde_json::Value {
    serde_json::json!({
        "*": "ask",
        "read": { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
        "glob": "allow", "grep": "allow", "list": "allow", "lsp": "allow",
        "webfetch": "allow", "websearch": "allow", "codesearch": "allow",
        "todowrite": "allow", "todoread": "allow", "question": "allow", "skill": "allow", "plan_exit": "allow",
        "edit": { "*": "deny", "*opencode/plans/*.md": "allow" },
        "external_directory": { "*": "ask", "*opencode/plans/*": "allow", "*opencode/tool-output/*": "allow" }
    })
}

/// 只讨论启动时另加的环境变量（readonly_launch_args 管参数，这里管环境）。OpenCode：打开实验性的计划模式
/// （有了它 plan agent 才有 plan_exit，写完方案问要不要切到 build 开工），并把上面的权限并进内联配置的 agent.plan
pub fn readonly_launch_env(agent_id: &str, env: &mut Vec<(String, String)>) {
    if agent_id != "opencode" {
        return;
    }
    env.retain(|(k, _)| k != "OPENCODE_EXPERIMENTAL_PLAN_MODE");
    env.push(("OPENCODE_EXPERIMENTAL_PLAN_MODE".into(), "1".into()));
    let idx = env.iter().position(|(k, _)| k == "OPENCODE_CONFIG_CONTENT");
    let mut cfg: serde_json::Value = idx
        .and_then(|i| serde_json::from_str(&env[i].1).ok())
        .filter(|v: &serde_json::Value| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let agent = cfg
        .as_object_mut()
        .unwrap()
        .entry("agent")
        .or_insert_with(|| serde_json::json!({}));
    if !agent.is_object() {
        *agent = serde_json::json!({});
    }
    let plan = agent.as_object_mut().unwrap().entry("plan").or_insert_with(|| serde_json::json!({}));
    if !plan.is_object() {
        *plan = serde_json::json!({});
    }
    plan.as_object_mut().unwrap().insert("permission".into(), opencode_plan_permission());
    let text = cfg.to_string();
    match idx {
        Some(i) => env[i].1 = text,
        None => env.push(("OPENCODE_CONFIG_CONTENT".into(), text)),
    }
}

/// 本机原生权限档（ask / auto / full）的启动参数；这家没有该档返回 None（调用方拒绝启动，不静默降级）。
/// 自带 `-s` 的档（codex full）先剔除 Mesa 默认注入的沙箱参数对
pub fn permission_launch_args(agent_id: &str, base_args: &[String], mode: &str) -> Option<Vec<String>> {
    let spec = agent_spec(agent_id)?;
    let (_, extra) = spec.permission_args.iter().find(|(m, _)| *m == mode)?;
    // 自带沙箱的档要先剔掉默认的 `-s workspace-write`：codex `--approve-for-me` 自己用 workspace-write，
    // 与 -s 同给时 codex 0.163 直接拒绝启动（2026-10-18 聊天层第三期 PTY 实录：「--sandbox cannot be used with --approve-for-me」）
    let mut args = if extra
        .iter()
        .any(|a| *a == "-s" || *a == "--sandbox" || *a == "--approve-for-me")
    {
        without_sandbox_pair(base_args)
    } else {
        base_args.to_vec()
    };
    args.extend(extra.iter().map(|a| (*a).to_string()));
    Some(args)
}

/// 官方账号禁止把中转/国产网关模型名跟着注入。
/// 与前端 `officialModelAllowed` 双端镜像：否则 Codex `-m deepseek` 还会带上
/// ChatGPT 订阅的 `service_tier=priority`，CLI 报模型不支持该档。
pub(crate) fn official_model_allowed(agent: &str, model: &str) -> bool {
    let m = model.trim().to_ascii_lowercase();
    if m.is_empty() {
        return false;
    }
    const FOREIGN: &[&str] = &[
        "deepseek", "qwen", "glm-", "glm/", "moonshot", "kimi-", "doubao", "hunyuan", "yi-",
        "ernie", "baichuan", "minimax", "spark-",
    ];
    // kimi 官方账号下 kimi- / moonshot 是自家模型（kimi-code/k3）；
    // 这两项只用来拦 Claude/Codex 等订阅误带中转名。
    if FOREIGN.iter().any(|p| {
        if agent == "kimi" && (*p == "kimi-" || *p == "moonshot") {
            return false;
        }
        m.contains(p)
    }) {
        return false;
    }
    if agent == "codex" {
        return m.starts_with("gpt-")
            || m.starts_with("o1")
            || m.starts_with("o3")
            || m.starts_with("o4")
            || m.contains("codex");
    }
    true
}

/// 官方账号启动时一律写空的 Claude 键：端点与两种密钥（空串 = 没设）。
const CLAUDE_OFFICIAL_BLANK_ALWAYS: &[&str] = &["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];
/// 用户全局设过才写空的模型类键（中转常把这些槽指到 glm 之类，官方账号认不得）。
const CLAUDE_OFFICIAL_BLANK_IF_SET: &[&str] = &[
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
];
const CODEBUDDY_OFFICIAL_BLANK: &[&str] =
    &["CODEBUDDY_BASE_URL", "CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN", "CODEBUDDY_MODEL"];

/// 官方账号的 `--settings` 内联覆盖层：把会盖过官方登录的 env 键写成空串（内容不含任何密钥，
/// 故内联不落盘；聊天层的 hooks 照常并进这一份）。选了模型时模型键写这次的模型。
fn official_settings_blanks(
    always: &[&str],
    if_set: &[&str],
    user_keys: &[String],
    model: Option<(&str, &str)>,
) -> String {
    let mut env = serde_json::Map::new();
    for k in always {
        env.insert((*k).into(), serde_json::json!(""));
    }
    for k in if_set {
        if user_keys.iter().any(|u| u == k) {
            env.insert((*k).into(), serde_json::json!(""));
        }
    }
    if let Some((name, m)) = model {
        env.insert(name.into(), serde_json::json!(m));
    }
    serde_json::json!({ "env": env }).to_string()
}

/// Kimi 新版把 KIMI_MODEL_* 合成的模型注册成这个别名，但它只当「新会话」的默认模型：
/// `-S` 续聊按会话里存的模型别名走（2.3.3 实证：换连接后续聊仍打旧连接的 key，401）。
/// 显式 `-m` 点名它才盖过，之后再续聊也沿用。旧版 Python CLI 没有这个别名，不加。
const KIMI_ENV_MODEL_ALIAS: &str = "__kimi_env_model__";

fn kimi_env_model_args(variant: Option<&str>) -> Vec<String> {
    if variant == Some("legacy") {
        return vec![];
    }
    vec!["-m".into(), KIMI_ENV_MODEL_ALIAS.into()]
}

/// Kimi 官方账号的模型别名：`kimi login` 在 config.toml 配好的 `managed:kimi-code` 模型（当前默认就是则用它）。
/// 新版目录（KIMI_CODE_HOME 或 ~/.kimi-code）优先，再看旧版 ~/.kimi；单测不读本机（TEST_KIMI_CONFIG 注入）
fn kimi_official_alias(profile: &Profile) -> Option<String> {
    kimi_managed_alias(&kimi_config_text(Some(profile))?)
}

fn kimi_config_text(profile: Option<&Profile>) -> Option<String> {
    #[cfg(test)]
    {
        let _ = profile;
        return tests::TEST_KIMI_CONFIG.with(|k| k.borrow().clone());
    }
    #[cfg(not(test))]
    {
        let home = dirs::home_dir()?;
        let new_dir = profile
            .and_then(|p| p.extra_env.get("KIMI_CODE_HOME").cloned())
            .or_else(|| std::env::var("KIMI_CODE_HOME").ok())
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".kimi-code"));
        [new_dir.join("config.toml"), home.join(".kimi/config.toml")]
            .iter()
            .find_map(|p| std::fs::read_to_string(p).ok())
    }
}

/// config.toml 里官方登录配的全部模型别名，默认模型排第一
fn kimi_managed_aliases(text: &str) -> Vec<String> {
    let Some(first) = kimi_managed_alias(text) else {
        return Vec::new();
    };
    let Ok(doc) = toml::from_str::<toml::Value>(text) else {
        return vec![first];
    };
    let mut out = vec![first.clone()];
    if let Some(models) = doc.get("models").and_then(|m| m.as_table()) {
        for (k, m) in models {
            if k != &first
                && m.get("provider").and_then(|p| p.as_str()) == Some("managed:kimi-code")
            {
                out.push(k.clone());
            }
        }
    }
    out
}

/// 要联网才拿得到的官方模型名单，缓存在 Mesa 配置目录 `official-models/<agent>.json`（6 小时内不重拉）
#[cfg_attr(test, allow(dead_code))]
fn official_models_cache_path(agent: &str) -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("ccode").join("official-models").join(format!("{agent}.json")))
}

#[cfg_attr(test, allow(dead_code))]
fn read_official_models_cache(agent: &str) -> Vec<String> {
    official_models_cache_path(agent)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .unwrap_or_default()
}

#[cfg_attr(test, allow(dead_code))]
fn refresh_official_models_cache(agent: &str, fetch: impl FnOnce() -> Vec<String>) {
    let Some(path) = official_models_cache_path(agent) else {
        return;
    };
    let fresh = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < std::time::Duration::from_secs(6 * 3600));
    if fresh {
        return;
    }
    let models = fetch();
    if models.is_empty() {
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(&models) {
        let _ = std::fs::write(&path, text);
    }
}

/// ~/.grok/config.toml 里 base_url 不是 x.ai 的 [model.<名>] 段：这个名字在官方账号下也会被转去中转
#[cfg_attr(test, allow(dead_code))]
fn grok_relay_model_sections() -> Vec<String> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let base = std::env::var_os("GROK_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".grok"));
    std::fs::read_to_string(base.join("config.toml"))
        .ok()
        .map(|t| grok_relay_sections_in(&t))
        .unwrap_or_default()
}

fn grok_relay_sections_in(text: &str) -> Vec<String> {
    let Ok(v) = toml::from_str::<toml::Value>(text) else {
        return Vec::new();
    };
    v.get("model")
        .and_then(|m| m.as_table())
        .map(|t| {
            t.iter()
                .filter(|(_, sec)| {
                    sec.get("base_url")
                        .and_then(|u| u.as_str())
                        .is_some_and(|u| !grok_is_xai_endpoint(u))
                })
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// `grok models` 的输出（1.0.70 实证）：「  * grok-4.7 (default)」「  - grok-4.5」，默认那个排第一
fn parse_grok_models(text: &str) -> Vec<String> {
    let mut out: Vec<(bool, String)> = text
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let (mark, rest) = l.split_at(l.find(' ')?);
            if mark != "*" && mark != "-" {
                return None;
            }
            let slug = rest.split_whitespace().next()?.to_string();
            Some((mark == "*" || rest.contains("(default)"), slug))
        })
        .collect();
    out.sort_by_key(|(default, _)| !*default);
    out.into_iter().map(|(_, s)| s).collect()
}

/// `cursor-agent models` 的输出：「slug - 显示名」逐行，第一行标题（2026-10-28 本机实证）
fn parse_cursor_models(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| {
            let (slug, _) = l.trim().split_once(" - ")?;
            let slug = slug.trim();
            (!slug.is_empty() && !slug.contains(' ')).then(|| slug.to_string())
        })
        .collect()
}

/// config.toml 文本里官方登录配的模型别名；没登录过（没有 managed:kimi-code 模型）返回 None
fn kimi_managed_alias(text: &str) -> Option<String> {
    let doc: toml::Value = toml::from_str(text).ok()?;
    let models = doc.get("models")?.as_table()?;
    let managed = |k: &str| {
        models
            .get(k)
            .and_then(|m| m.get("provider"))
            .and_then(|p| p.as_str())
            == Some("managed:kimi-code")
    };
    let current = doc.get("default_model").and_then(|v| v.as_str());
    current
        .filter(|c| managed(c))
        .map(str::to_string)
        .or_else(|| models.keys().find(|k| managed(k)).cloned())
}

/// 官方账号连接没在 Mesa 里列模型时，从 CLI 自己的缓存给出这个账号能用的模型。
/// 目前只有 Codex：它从 ChatGPT 后端拉来的模型目录缓存在 `models_cache.json`，取 `visibility = "list"` 的、按 priority 排
/// （2026-10-28：官方账号连接以前「未指定模型」，启动不带 -m，Codex 就用磁盘里中转留下的模型名，
/// 报 model is not supported when using Codex with a ChatGPT account）。
pub(crate) fn official_models_for(agent: &str) -> Vec<String> {
    #[cfg(test)]
    {
        let _ = agent;
        return tests::TEST_OFFICIAL_MODELS.with(|k| k.borrow().clone());
    }
    #[cfg(not(test))]
    {
        match agent {
            "codex" => {}
            // kimi login 配好的 managed:kimi-code 模型（默认那个排前面）
            "kimi" => {
                return kimi_config_text(None).map(|t| kimi_managed_aliases(&t)).unwrap_or_default();
            }
            // `cursor-agent models` 要联网，查登录状态时顺手缓存（official_models_cache_*）
            "cursor" => return read_official_models_cache("cursor"),
            // `grok models` 同样要联网，查登录状态时缓存；config.toml 里借官方名字转去中转的 [model.*] 段剔掉
            "grok" => {
                let hijacked = grok_relay_model_sections();
                return read_official_models_cache("grok")
                    .into_iter()
                    .filter(|m| !hijacked.contains(m))
                    .collect();
            }
            // 没有本地名单、但 CLI 认固定别名的几家（2026-10-28 核对）：Claude `--model default/opus/sonnet/haiku`
            // （假网关实测分别解析成 claude-opus-5-5 / -opus- / -sonnet- / -haiku-5-5，default = 不传时的默认）；
            // Gemini 0.65 bundle 的 GEMINI_MODEL_ALIAS_*（auto = 默认路由）；Qwen OAuth 只有 coder-model（实测回落提示）。
            // 第一个都是 CLI 自己的默认，选它等于不指定
            // Claude 另把账号额外可选的模型缓存在 ~/.claude.json additionalModelOptionsCache（如 claude-fable-5-1[1m]），接在别名后面
            "claude-code" => {
                let extra = dirs::home_dir()
                    .and_then(|h| std::fs::read_to_string(h.join(".claude.json")).ok())
                    .map(|t| claude_additional_models(&t))
                    .unwrap_or_default();
                return claude_official_models(extra);
            }
            // 名单在 tests/fixtures/gemini-model-aliases.json（model_aliases.rs 实测对应型号）
            "gemini" => return crate::model_aliases::aliases_of("gemini"),
            "qwen" => return vec!["coder-model".to_string()],
            _ => return Vec::new(),
        }
        let Some(home) = dirs::home_dir() else {
            return Vec::new();
        };
        let base = std::env::var_os("CODEX_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        std::fs::read_to_string(base.join("models_cache.json"))
            .map(|t| codex_listed_models(&t))
            .unwrap_or_default()
    }
}

/// Claude 官方名单：CLI 认的别名（名单在 tests/fixtures/claude-model-aliases.json，金丝雀拿 `claude --help` 核对；
/// default = 不传时的默认）+ 账号额外可选的完整名
fn claude_official_models(extra: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = crate::model_aliases::claude_aliases();
    for m in extra {
        if !out.contains(&m) {
            out.push(m);
        }
    }
    out
}

/// ~/.claude.json 的 additionalModelOptionsCache：[{ value, label, description }]，取 value
fn claude_additional_models(text: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("additionalModelOptionsCache")?.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|o| o.get("value")?.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from))
        .collect()
}

/// 启动时用的官方名单：Grok 没缓存过（没打开过连接页）时当场问一次 `grok models`（约 3 秒）。
/// 连接列表（materialize）只读缓存，不在这里等网络
pub(crate) fn official_models_for_launch(agent: &str) -> Vec<String> {
    #[cfg(not(test))]
    if agent == "grok" && read_official_models_cache("grok").is_empty() {
        if let Some(path) = resolve_binary("grok") {
            refresh_official_models_cache("grok", || {
                cli_output_with_env(&path, &["models"], &crate::settings::official_outbound_env(), std::time::Duration::from_secs(20))
                    .map(|t| parse_grok_models(&t))
                    .unwrap_or_default()
            });
        }
    }
    official_models_for(agent)
}

/// models_cache.json 里列给人选的模型（visibility = list），按 priority 升序
fn codex_listed_models(text: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let mut rows: Vec<(i64, String)> = v
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|m| m.get("visibility").and_then(|x| x.as_str()) == Some("list"))
                .filter_map(|m| {
                    let slug = m.get("slug")?.as_str()?.trim();
                    (!slug.is_empty()).then(|| {
                        (m.get("priority").and_then(|p| p.as_i64()).unwrap_or(i64::MAX), slug.to_string())
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    rows.sort();
    rows.into_iter().map(|(_, s)| s).collect()
}

/// 官方账号模式的注入：purge 残留密钥 env（规格 env_purge_list），模型非空才注入模型 env/参数。
/// 凭证与 base URL 一律不注入——认证完全交给 CLI 自己的账号登录。
/// Codex 例外：必须 `-c model_provider="openai"` 盖过磁盘默认渠道（见该臂注释）。
fn apply_official_inject(
    plan: &mut LaunchPlan,
    spec: &AgentSpec,
    profile: &Profile,
    model: Option<&str>,
) {
    let owned = model.and_then(|m| {
        let t = m.trim();
        if !official_model_allowed(&profile.agent, t) {
            return None;
        }
        if !profile.models.is_empty() && !profile.models.iter().any(|x| x == t) {
            return None;
        }
        Some(t.to_string())
    });
    let model = owned.as_deref();
    if let Some(oa) = &spec.official_account {
        for var in oa.env_purge_list {
            plan.env_remove.push((*var).into());
        }
    }
    match &spec.launch {
        LaunchSpec::Env(env) => {
            if let (Some(name), Some(m)) = (env.model, model) {
                plan.env.push((name.into(), m.into()));
            }
            // CodeBuddy 同 Claude：settings.json env 盖过进程 env，--settings 覆盖层写空串（2026-10-28 实测）
            if profile.agent == "codebuddy" {
                let overlay = official_settings_blanks(
                    CODEBUDDY_OFFICIAL_BLANK,
                    &[],
                    &[],
                    env.model.zip(model),
                );
                plan.args.push("--settings".into());
                plan.args.push(overlay);
            }
            // Grok：config.toml 的 [models].default / session_summary / prompt_suggestion 常是中转留下的
            // （本机实例：default = glm-5.3-flash，session_summary 指向一个借官方名字 grok-4.5、实际转去中转的 [model.*] 段）。
            // GROK_CONFIG 覆盖层的 [models] 在白名单内，三项都钉成这次的官方模型；没选模型用 `grok models` 的默认
            if profile.agent == "grok" {
                let fallback = if model.is_none() {
                    official_models_for_launch("grok").into_iter().next()
                } else {
                    None
                };
                if let Some(m) = model.or(fallback.as_deref()) {
                    if model.is_none() {
                        if let Some(name) = env.model {
                            plan.env.push((name.into(), m.into()));
                        }
                    }
                    let overlay = serde_json::json!({ "models": {
                        "default": m, "session_summary": m, "prompt_suggestion": m,
                    }});
                    plan.env.push(("GROK_CONFIG".into(), overlay.to_string()));
                }
            }
        }
        LaunchSpec::ByProtocol(entries) => {
            // 与 api 模式同一缺省规则取协议条目，但只注入模型 env；
            // --auth-type 等凭证参数不注入（官方账号用 CLI 默认认证方式）
            let default = spec.protocols.first().copied().unwrap_or("");
            let proto = profile.protocol.as_deref().unwrap_or(default);
            let entry = entries
                .iter()
                .find(|e| e.protocol == proto)
                .or_else(|| entries.first());
            if let (Some(entry), Some(m)) = (entry, model) {
                if let Some(name) = entry.env.model {
                    plan.env.push((name.into(), m.into()));
                }
            }
            // Qwen：认证方式缺省读 settings 的 selectedType（设过 API 就走 API）。命令行参数优先级最高，
            // 显式指定账号登录，磁盘 .env / settings 里的密钥都不再起作用（2026-10-28 实测）
            if profile.agent == "qwen" {
                plan.args.push("--auth-type".into());
                plan.args.push("qwen-oauth".into());
            }
        }
        LaunchSpec::Special(special) => match special {
            // 模型槽位注册（ANTHROPIC_DEFAULT_*）只在 api 模式做：官方账号的可用模型由订阅决定
            SpecialLaunch::ClaudeModelSlots(env) => {
                if let (Some(name), Some(m)) = (env.model, model) {
                    plan.env.push((name.into(), m.into()));
                }
                // 磁盘 settings.json 的 env 盖过进程 env：留着的中转端点 / 密钥会让「官方账号」实际走 API。
                // --settings 覆盖层里写成空串就等于没设，Claude 回到自己的登录（2026-10-28 隔离 HOME 实测）
                let mut overlay = official_settings_blanks(
                    CLAUDE_OFFICIAL_BLANK_ALWAYS,
                    CLAUDE_OFFICIAL_BLANK_IF_SET,
                    &claude_user_settings_env_keys(profile),
                    env.model.zip(model),
                );
                // 顶层 "model" 不在 env 里：中转写的 glm 之类会让官方账号报模型不存在。
                // 覆盖层写空串 = 用 Claude 自己的默认（null 不顶用，2.1.308 实测）；选了模型时走 --model
                if let Some(m) = model {
                    plan.args.push("--model".into());
                    plan.args.push(m.into());
                } else if claude_user_top_model(profile)
                    .is_some_and(|m| !crate::global_config::official_model_kept("claude-code", &m))
                {
                    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&overlay) {
                        v["model"] = serde_json::json!("");
                        overlay = v.to_string();
                    }
                }
                plan.args.push("--settings".into());
                plan.args.push(overlay);
            }
            SpecialLaunch::CodexInlineProvider { sandbox_args, .. } => {
                // 没选到模型（或选的是中转模型被滤掉）时不能不带 -m：Codex 会用磁盘 config.toml 里
                // 中转留下的 model，ChatGPT 账号直接 400。用官方名单第一个
                let fallback = if model.is_none() {
                    official_models_for(&profile.agent).into_iter().next()
                } else {
                    None
                };
                if let Some(m) = model.or(fallback.as_deref()) {
                    plan.args.push("-m".into());
                    plan.args.push(m.into());
                }
                // 默认沙箱与认证方式无关，官方账号同样生效；沙箱内联网同步放开
                for arg in *sandbox_args {
                    plan.args.push((*arg).into());
                }
                plan.args.push("-c".into());
                plan.args
                    .push("sandbox_workspace_write.network_access=true".into());
                // 磁盘 config.toml 的 model_provider 指向自定义网关时会盖过 ChatGPT
                // 登录（选官方账号仍走网关计费）。-c 优先级最高，本进程切到内置
                // openai 渠道（读 ChatGPT 凭证），不改用户文件、不写 model_providers 块。
                plan.args.push("-c".into());
                plan.args.push(format!(
                    r#"model_provider="{}""#,
                    crate::provider_id::CODEX_CHATGPT
                ));
            }
            // cursor 官方账号：不注入密钥/端点，模型 flag 与认证方式无关照常可用
            SpecialLaunch::CursorFlags { model_flag, .. } => {
                if let Some(m) = model {
                    plan.args.push((*model_flag).into());
                    plan.args.push(m.into());
                }
            }
            // kimi 官方账号：KIMI_MODEL_* env 合成通道会抢 OAuth 登录态（已被 purge 清单移除），
            // 模型只能走 -m flag（新版 CLI --help 实证，与认证方式无关）
            SpecialLaunch::KimiDualChannel => {
                // 没选模型时 kimi 用 config.toml 的 default_model，那常是 API 连接的别名：
                // 改用 `kimi login` 配好的 managed:kimi-code 模型
                let fallback = if model.is_none() { kimi_official_alias(profile) } else { None };
                if let Some(m) = model.or(fallback.as_deref()) {
                    plan.args.push("-m".into());
                    plan.args.push(m.into());
                }
            }
            // opencode 内联配置缺 provider 会指向不存在的节点——官方账号模式下不注入模型
            //（opencode 无官方账号语义，注册表保持 None，正常不会走到）
            _ => {}
        },
    }
}

/// 通用 env 注入：base_url/密钥/选中模型各自写入规格指定的 env 名（None = 该 CLI 无此 env）
fn apply_env_inject(
    plan: &mut LaunchPlan,
    env: &crate::agent_specs::EnvInject,
    profile: &Profile,
    key: Option<&str>,
    model: Option<&str>,
) {
    if let (Some(name), Some(url)) = (env.base_url, &profile.base_url) {
        plan.env.push((name.into(), url.clone()));
    }
    if let (Some(name), Some(k)) = (env.key, key) {
        plan.env.push((name.into(), k.into()));
    }
    if let (Some(name), Some(m)) = (env.model, model) {
        plan.env.push((name.into(), m.into()));
    }
    for (k, v) in env.fixed_env {
        plan.env.push(((*k).into(), (*v).into()));
    }
    for arg in env.fixed_args {
        plan.args.push((*arg).into());
    }
}

// ===== kimi 模型元数据：能力与上下文统一走 model_registry（内置表 + 覆盖文件 + 推断兜底） =====

/// OpenCode 的 provider 条目（npm + options + models），启动注入与全局写入共用。
/// provider 级 name = 选择器里的供应商显示名（用 profile 名，不再是内部 id "ccode"）；
/// models 条目 name = 模型显示名（models.dev 覆盖语义，官方文档核实）；
/// 思考能力与上下文取自 model_registry（内置表 + 覆盖文件 + 推断兜底）
pub(crate) fn opencode_provider_json(
    profile: &Profile,
    key: Option<&str>,
    model: Option<&str>,
) -> serde_json::Value {
    let mut options = serde_json::Map::new();
    if let Some(url) = &profile.base_url {
        options.insert("baseURL".into(), serde_json::json!(url));
    }
    if let Some(k) = key {
        options.insert("apiKey".into(), serde_json::json!(k));
    }
    let mut models_map = serde_json::Map::new();
    let mut all: Vec<&str> = profile.models.iter().map(|m| m.as_str()).collect();
    if let Some(m) = model {
        if !all.contains(&m) {
            all.push(m);
        }
    }
    for m in all {
        // limit 是 opencode 用户配置 schema 里**条件必填**：`limit` 键本身可省，
        // 但一旦出现，`context` 与 `output` 都是必填（只有 input 可选）。
        // 1.18 实测缺 output 直接 "Configuration is invalid" 退出 1。
        // 所以这里不能像 codex catalog 那样「未知就省略」——未知只能写保守下限，
        // 且要清楚那是下限不是声明（注册链确知时就是真值）。
        let mut entry = serde_json::json!({
            "name": format!("{} · {m}", profile.name),
            "limit": {
                "context": crate::model_registry::model_context_size_for(m, profile.gateway_id.as_deref()),
                "output": crate::model_registry::model_output_limit_for(m, profile.gateway_id.as_deref()),
            },
        });
        // 思考模型补 reasoning: true（models.dev 覆盖语义）；否则 models.dev
        // 查不到条目时 opencode 按无思考能力处理
        if crate::model_registry::model_thinking_for(m, profile.gateway_id.as_deref()) {
            entry["reasoning"] = serde_json::json!(true);
        }
        // 视觉模型补 modalities（input 加 image）；缺省 = 纯文本，中继视觉模型
        // 不声明会在 opencode 里丢掉图像输入
        if crate::model_registry::model_supports_vision_for(m, profile.gateway_id.as_deref()) {
            entry["modalities"] =
                serde_json::json!({ "input": ["text", "image"], "output": ["text"] });
        }
        models_map.insert(m.into(), entry);
    }
    serde_json::json!({
        "npm": "@ai-sdk/openai-compatible",
        "name": profile.name,
        "options": options,
        "models": models_map,
    })
}

// ===== codex 模型 catalog：TUI /model 选择器的数据源（仅启动时读取一次） =====

/// catalog 文件路径：<config dir>/ccode/catalogs/codex-<profile_id>.json
pub fn codex_catalog_path(profile_id: &str) -> Option<std::path::PathBuf> {
    Some(
        dirs::config_dir()?
            .join("ccode")
            .join("catalogs")
            .join(format!("codex-{profile_id}.json")),
    )
}

/// Codex 对没登记的模型用的默认系统提示词。catalog 必须填 base_instructions，填了就整段替换 Codex 自己的提示词：
/// 以前填「You are a coding agent.」，模型不知道 apply_patch，改文件全用 Set-Content / 重定向，会话里没有差异、聊天层画不出来
/// （2026-10-20 Windows 实跑：同一网关同一模型，一句话版 5 次改文件全走 PowerShell，换回原文全走 apply_patch）。
/// 优先向本机装的 Codex 取原文（local_codex_base_instructions，跟着 Codex 版本走）；取不到才用这份随包兜底
/// （Codex 0.163 原文，Apache-2.0，OpenAI）
const CODEX_BASE_INSTRUCTIONS: &str = include_str!("codex_base_instructions.md");
/// Windows 补充：PowerShell 里调 apply_patch Codex 接不住（引号串、here-string、管道实跑都报错），
/// 只认「整条命令就是一个 bash heredoc」；不说模型会先在 PowerShell 里试错几轮
const CODEX_WINDOWS_PATCH_NOTE: &str = include_str!("codex_windows_patch_note.md");

fn codex_base_instructions() -> String {
    let base = codex_cli_version()
        .and_then(local_codex_base_instructions)
        .unwrap_or_else(|| CODEX_BASE_INSTRUCTIONS.to_string())
        .replace("\r\n", "\n");
    if cfg!(windows) {
        format!("{}\n\n{}", base.trim_end(), CODEX_WINDOWS_PATCH_NOTE.replace("\r\n", "\n"))
    } else {
        base
    }
}

/// 本机 Codex（该版本）的默认提示词，缓存在 `<配置根>/catalogs/codex-base-instructions-<版本>.md`，
/// 每个版本只取一次；旧版本的缓存顺手删掉。取失败本进程内不再重试这个版本（每次启动都等不值得）
#[cfg(not(test))]
fn local_codex_base_instructions(version: (u32, u32, u32)) -> Option<String> {
    static LOCK: std::sync::Mutex<Option<(u32, u32, u32)>> = std::sync::Mutex::new(None);
    let mut failed = LOCK.lock().ok()?;
    let dir = crate::storage::config_root()?.join("catalogs");
    let name = format!("codex-base-instructions-{}.{}.{}.md", version.0, version.1, version.2);
    let cache = dir.join(&name);
    if let Ok(text) = std::fs::read_to_string(&cache) {
        if plausible_codex_instructions(&text) {
            return Some(text);
        }
    }
    if *failed == Some(version) {
        return None;
    }
    let Some(text) = extract_codex_base_instructions() else {
        eprintln!("[codex] 没取到 Codex {version:?} 的默认提示词，模型清单用随包的 0.163 原文");
        *failed = Some(version);
        return None;
    };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n.starts_with("codex-base-instructions-") && n != name {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let _ = crate::profiles::atomic_write(&cache, &text);
    Some(text)
}

/// 测试态不跑本机 Codex（结果与开发机装没装、装哪版无关）
#[cfg(test)]
fn local_codex_base_instructions(_version: (u32, u32, u32)) -> Option<String> {
    None
}

/// Codex 没有直接导出这段原文的命令（`debug models` 只有 GPT 专用的打包条目，`debug prompt-input` 不含它），
/// 做法是在一次性的 CODEX_HOME 里跑一次 `codex exec`、渠道的密钥变量故意不给：Codex 先写会话文件
/// （首行 session_meta.base_instructions 就是原文），发请求前报「Missing environment variable」退出——
/// 不联网、不碰用户的 ~/.codex，实测约 0.5 秒。临时目录用完即删
#[cfg_attr(test, allow(dead_code))]
fn extract_codex_base_instructions() -> Option<String> {
    const KEY_VAR: &str = "MESA_CODEX_INSTRUCTIONS_PROBE_UNSET";
    let bin = resolve_binary("codex")?;
    let tmp = crate::storage::config_root()?.join("tmp");
    // 上次没删干净的（见下）先扫掉
    if let Ok(entries) = std::fs::read_dir(&tmp) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with("codex-instructions-") {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    let scratch = tmp.join(format!("codex-instructions-{}", uuid::Uuid::new_v4()));
    let home = scratch.join("home");
    let work = scratch.join("work");
    let result = (|| {
        std::fs::create_dir_all(&home).ok()?;
        std::fs::create_dir_all(&work).ok()?;
        let p = "mesa-probe";
        let mut child = crate::process::background_command(&bin)
            .args([
                "exec".to_string(),
                "--skip-git-repo-check".into(),
                "-c".into(),
                format!(r#"model_provider="{p}""#),
                "-c".into(),
                format!(r#"model_providers.{p}.name="{p}""#),
                "-c".into(),
                // 万一真发出去也只到本机一个不通的端口
                format!(r#"model_providers.{p}.base_url="http://127.0.0.1:9/v1""#),
                "-c".into(),
                format!(r#"model_providers.{p}.env_key="{KEY_VAR}""#),
                "-c".into(),
                format!(r#"model_providers.{p}.wire_api="responses""#),
                "-c".into(),
                format!("model_providers.{p}.request_max_retries=0"),
                "-c".into(),
                format!("model_providers.{p}.stream_max_retries=0"),
                "-m".into(),
                "mesa-probe-model".into(),
                "hi".into(),
            ])
            .current_dir(&work)
            .env("CODEX_HOME", &home)
            .env_remove(KEY_VAR)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(30)),
                Err(_) => return None,
            }
        }
        let rollout = first_jsonl(&home.join("sessions"))?;
        codex_instructions_from_rollout(&std::fs::read_to_string(rollout).ok()?)
    })();
    // Windows 上 codex 退出后约 1.2–1.4 秒目录句柄才放（实测文件删得掉、空目录删不掉）：放后台重试，不拖慢启动
    if std::fs::remove_dir_all(&scratch).is_err() && scratch.exists() {
        std::thread::spawn(move || {
            for _ in 0..50 {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if std::fs::remove_dir_all(&scratch).is_ok() || !scratch.exists() {
                    break;
                }
            }
        });
    }
    result
}

#[cfg_attr(test, allow(dead_code))]
fn first_jsonl(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = first_jsonl(&p) {
                return Some(f);
            }
        } else if p.extension().is_some_and(|x| x == "jsonl") {
            return Some(p);
        }
    }
    None
}

/// 会话文件首行 session_meta 里的 base_instructions.text（换行统一成 LF）
fn codex_instructions_from_rollout(text: &str) -> Option<String> {
    let first: serde_json::Value = serde_json::from_str(text.lines().next()?).ok()?;
    if first["type"] != "session_meta" {
        return None;
    }
    let s = first["payload"]["base_instructions"]["text"].as_str()?.replace("\r\n", "\n");
    plausible_codex_instructions(&s).then_some(s)
}

/// 像一段完整的系统提示词（防把截断 / 占位文本缓存下来）
fn plausible_codex_instructions(text: &str) -> bool {
    text.len() > 2000 && text.contains("apply_patch")
}

/// 单个 catalog 条目：字段拼写与标量值照抄 codex-rs/models-manager/models.json 的打包条目
/// （reasoning levels 使用 Codex 当前完整档位集——cc-switch 的 catalog 同样全量模板
/// （自家资源 codex_native_responses_template.json），模型不支持时端点忽略 effort，口径稳妥；
/// display_name 带 profile 名，选择器里不再是裸模型 id）
fn codex_catalog_entry_for(
    profile_name: &str,
    model: &str,
    gateway_id: Option<&str>,
) -> serde_json::Value {
    let mut entry = serde_json::json!({
        "slug": model,
        "display_name": format!("{profile_name} · {model}"),
        "description": null,
        // 有效上下文百分比：codex 按它算自动压缩阈值，缺了会用满窗口才压缩、
        // 容易先撞上下文上限报错（cc-switch 模板同值 95）
        "effective_context_window_percent": 95,
        // codex 的 web_search 是官方 hosted tool，第三方中继不支持——如实声明 false，
        // 不摆一个调了必挂的死工具（cc-switch 对拒收网关同样禁用）
        "supports_search_tool": false,
        // 空 = 不声明 ChatGPT 的 priority 档；请求时的 web_search 仍靠启动 -c 关掉
        "service_tiers": [],
        "supported_reasoning_levels": [
            { "effort": "low", "description": "Fast responses with lighter reasoning" },
            { "effort": "medium", "description": "Balances speed and reasoning depth for everyday tasks" },
            { "effort": "high", "description": "Greater reasoning depth for complex problems" },
            { "effort": "xhigh", "description": "Very deep reasoning for difficult problems" },
            { "effort": "ultra", "description": "Maximum reasoning depth for supported models" },
            { "effort": "max", "description": "Maximum reasoning depth" },
        ],
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": true,
        "priority": 1,
        "availability_nux": null,
        "upgrade": null,
        "base_instructions": codex_base_instructions(),
        "support_verbosity": true,
        "default_verbosity": "low",
        // 不声明 apply_patch_tool_type：freeform（type=custom）工具会被原生 /responses 与
        // Anthropic 协议网关拒/丢（cc-switch 实证，非代理档一律剥除；0.163 也只认 freeform 一种）；
        // 缺省时模型在 shell 里调 apply_patch，Codex 接住后照样出改文件事件与差异
        "truncation_policy": { "mode": "tokens", "limit": 10000 },
        "supports_parallel_tool_calls": true,
        // v0.146 起为必填（无 serde default），空数组即可
        "experimental_supported_tools": [],
        // ≥0.144.5 缺此字段会拒收整份 catalog，ChatGPT 自带 Codex 同样（cc-switch 同补）
        "supports_reasoning_summaries": true,
    });
    // 上下文窗口/图像输入都是**可选**字段：codex 的 catalog 解析器只强制
    // supports_reasoning_summaries 与 base_instructions（cc-switch 的
    // CODEX_CATALOG_PARSER_REQUIRED_FIELDS 明列；其 CHANGELOG 亦言可选能力字段
    // 「缺省即解析器默认」的语义要保住）。所以不知道就不写——把 128K 保守默认当真值
    // 写进去，反而会让 1M 窗口的模型被 codex 按 128K 提前压缩，比不写更坏。
    if let Some(ctx) = crate::model_registry::model_context_size_declared_for(model, gateway_id) {
        entry["context_window"] = serde_json::json!(ctx);
        entry["max_context_window"] = serde_json::json!(ctx);
    }
    if let Some(vision) = crate::model_registry::model_supports_vision_declared_for(model, gateway_id)
    {
        entry["input_modalities"] = if vision {
            serde_json::json!(["text", "image"])
        } else {
            serde_json::json!(["text"])
        };
    }
    entry
}

/// ModelsResponse { models: [ModelInfo] }：每个 profile 模型一条目
#[cfg(test)]
pub fn codex_catalog_json(profile_name: &str, models: &[String]) -> serde_json::Value {
    codex_catalog_json_for(profile_name, models, None)
}

pub fn codex_catalog_json_for(
    profile_name: &str,
    models: &[String],
    gateway_id: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "models": models
            .iter()
            .map(|m| codex_catalog_entry_for(profile_name, m, gateway_id))
            .collect::<Vec<_>>(),
    })
}

fn write_codex_catalog_to(
    path: &std::path::Path,
    profile_name: &str,
    models: &[String],
    gateway_id: Option<&str>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 catalog 目录失败: {e}"))?;
    }
    let text =
        serde_json::to_string_pretty(&codex_catalog_json_for(profile_name, models, gateway_id))
            .map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(path, &text)
}

/// 把 profile 的模型列表写成 codex catalog 文件（原子写）；无模型时返回 None
pub fn write_codex_catalog(profile: &Profile) -> Result<Option<std::path::PathBuf>, String> {
    if profile.models.is_empty() {
        return Ok(None);
    }
    let path = codex_catalog_path(&profile.id).ok_or("无法确定平台配置目录")?;
    write_codex_catalog_to(
        &path,
        &profile.name,
        &profile.models,
        profile.gateway_id.as_deref(),
    )?;
    Ok(Some(path))
}

/// -c 注入的 catalog 路径参数：-c 的值是 TOML，路径必须带引号成 TOML 字符串。
/// Windows 反斜杠必须换成正斜杠：TOML 基本字符串里 `\U` 是 Unicode 转义起始，
/// `C:\Users\…` 会解析失败，codex 起不来。正斜杠 Windows API 与 TOML 都接受。
fn catalog_args(path: &std::path::Path) -> Vec<String> {
    let p = path.to_string_lossy().replace('\\', "/");
    vec!["-c".into(), format!(r#"model_catalog_json="{p}""#)]
}

/// 启动前的每-agent 文件准备，返回需追加到 CLI 的参数。
/// codex：写模型 catalog 并用 -c 指过去，让 TUI /model 选择器列出 profile 的全部模型
pub fn prepare_launch(profile: &Profile) -> Result<Vec<String>, String> {
    let is_codex = matches!(
        agent_spec(&profile.agent).map(|s| &s.launch),
        Some(LaunchSpec::Special(
            SpecialLaunch::CodexInlineProvider { .. }
        ))
    );
    let mut args = Vec::new();
    if is_codex {
        if let Some(path) = write_codex_catalog(profile)? {
            args.extend(catalog_args(&path));
            args.extend(codex_plan_tool_args(
                &codex_base_instructions(),
                codex_modern(),
                crate::agent_specs::codex_user_config().as_ref(),
            ));
        }
        // 只给交互式启动（内嵌终端 / 外部终端，都经这里）：exec 不认这个参数，无头调用不走这里。
        // Mesa 一律用 -c 注入，codex 0.163 只能不走共享后台服务，不明说就每次报一条
        // 「Running without the shared background server」（2026-10-19 用户：终端里 3 条 warning）
        if codex_modern() {
            args.push("--no-daemon".into());
        }
    }
    Ok(args)
}

/// 本机实测过的新版行为起点（0.163）：`--no-daemon` 可用；模型目录 / 兜底元数据没声明的档位
/// CLI 自己丢掉（配置里的 priority 不会再带到中转），不必再用 -c 强塞 service_tier
const CODEX_MODERN: (u32, u32, u32) = (0, 163, 0);

/// catalog 里的 base_instructions（Codex 给未登记模型的默认提示词）写着「你有 `update_plan` 工具」，
/// 但 0.163 起 Codex 默认不发这个工具（官方模型也不发，改走 goals）：模型照提示词去找、找不到就说
/// 「当前会话没有暴露计划工具」，聊天层也画不出计划卡（2026-10-21 用户实测 glm-5.3-flash；假网关核对：
/// 加 `tools.update_plan.enabled=true` 后多出 update_plan）。提示词里提到才给，旧版不认这个键不加，
/// 用户自己在 config.toml 配过 `[tools.update_plan]` 不动
fn codex_plan_tool_args(instructions: &str, modern: bool, user_config: Option<&toml::Value>) -> Vec<String> {
    let user_set = user_config
        .and_then(|c| c.get("tools"))
        .and_then(|t| t.get("update_plan"))
        .is_some();
    if modern && !user_set && instructions.contains("update_plan") {
        vec!["-c".into(), "tools.update_plan.enabled=true".into()]
    } else {
        Vec::new()
    }
}

fn codex_modern() -> bool {
    codex_cli_version().is_some_and(|v| v >= CODEX_MODERN)
}

/// 「codex-cli 0.163.0」→ (0, 163, 0)：取第一个「数字.数字.数字」
fn parse_cli_semver(text: &str) -> Option<(u32, u32, u32)> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find_map(|tok| {
            let mut it = tok.split('.');
            let (a, b, c) = (it.next()?, it.next()?, it.next()?);
            Some((a.parse().ok()?, b.parse().ok()?, c.parse().ok()?))
        })
}

/// 本机 codex 的版本。检测缓存里有就用（不看有效期：版本只在更新后变，更新时缓存会清），
/// 没有再现查一次 --version（实测几十毫秒）。查不到 = None，按旧版参数启动，保证起得来
#[cfg(not(test))]
fn codex_cli_version() -> Option<(u32, u32, u32)> {
    cli_version_uncached_ok("codex")
}

/// 本机装着的这家 CLI 版本：优先取检测缓存，没有就跑一次 `--version`（3 秒超时）
#[cfg_attr(test, allow(dead_code))]
fn cli_version_uncached_ok(agent: &str) -> Option<(u32, u32, u32)> {
    let cached = DETECT_CACHE.lock().ok().and_then(|cache| {
        cache
            .as_ref()
            .and_then(|(_, results)| results.iter().find(|r| r.id == agent))
            .and_then(|r| r.version.clone())
    });
    let text = cached.or_else(|| {
        let spec = agent_spec(agent)?;
        let path = resolve_binary(spec.binary)?;
        version_args_with_timeout(&path, spec.version_args, std::time::Duration::from_secs(3))
    })?;
    parse_cli_semver(&text)
}

/// 聊天层旁路要看版本的几家（chat_channel.rs）：测试态一律当查不到，不跑本机二进制
#[cfg(not(test))]
pub(crate) fn cli_version(agent: &str) -> Option<(u32, u32, u32)> {
    cli_version_uncached_ok(agent)
}

#[cfg(test)]
pub(crate) fn cli_version(agent: &str) -> Option<(u32, u32, u32)> {
    // 端到端测试（chat_channel e2e，--ignored）要按本机真实版本走
    std::env::var("MESA_E2E_REAL_CLI")
        .is_ok()
        .then(|| cli_version_uncached_ok(agent))
        .flatten()
}

#[cfg(test)]
thread_local! {
    /// 单测钉住版本：默认 None（旧版行为，与开发机装没装 codex 无关）
    static CODEX_VERSION_FOR_TEST: std::cell::Cell<Option<(u32, u32, u32)>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(test)]
fn codex_cli_version() -> Option<(u32, u32, u32)> {
    CODEX_VERSION_FOR_TEST.with(|c| c.get())
}

pub fn binary_for(agent_id: &str) -> Option<&'static str> {
    agent_spec(agent_id).map(|s| s.binary)
}

/// 各 CLI 的按 ID 恢复会话参数（§6.12 A），参数格式来自 AgentSpec.resume。
/// 返回 (prepend, args)：codex 的 resume 是子命令需放最前，其余是位置无关的 flag。
pub(crate) fn resume_args(agent_id: &str, session_id: &str) -> (bool, Vec<String>) {
    match agent_spec(agent_id) {
        Some(spec) => (
            spec.resume.prepend,
            spec.resume
                .args
                .iter()
                .map(|a| a.replace("{session}", session_id))
                .collect(),
        ),
        None => (false, vec![]),
    }
}

/// 中转 Codex 盖掉磁盘/ChatGPT 登录带进本进程的官方能力（不写 config.toml）。
/// `web_search` 默认开，catalog 的 `supports_search_tool` 挡不住请求（cc-switch 同结论）；
/// DeepSeek 等会拒服务端搜索（有的中转转成 Anthropic `web_search_20250305`）。
/// `service_tier=priority` 是订阅档，中转模型不声明——旧版 codex 照发，改 `auto` 不再带 priority；
/// 0.163 起 CLI 自己丢掉没声明的档，再塞 `auto` 反而每次报「not advertised」warning，只给旧版塞。
/// 中转不盖掉 `features.apps`：0.154 上 `features.apps=false` 会把用户 HTTP MCP
/// （Consensus / Undermind）收成 `mcp__<名>` 占位，调用即 `unsupported call`，
/// 即使 CONSENSUS_API_KEY 已注入、端点可达。内置 ChatGPT `codex_apps` 改关插件，
/// 避免失效登录态 401 token_revoked（`mcp_servers.codex_apps.enabled=false` 报 invalid transport）。
fn codex_relay_compat_args() -> Vec<String> {
    let mut args = vec!["-c".into(), r#"web_search="disabled""#.into()];
    if !codex_modern() {
        args.extend(["-c".into(), r#"service_tier="auto""#.into()]);
    }
    args.extend([
        "-c".into(),
        r#"plugins.codex-app-tools@openai-bundled.enabled=false"#.into(),
    ]);
    args
}

/// Codex 里另外点名模型的几处（`/review`、子 agent、记忆整理）：磁盘上常是官方模型名，走中转时照发就报模型不存在
/// （0.164 二进制里都有这几个键；cc-switch 把它们算作连接键）。全局写入与启动同一张表
pub(crate) const CODEX_SIDE_MODEL_KEYS: &[&[&str]] = &[
    &["review_model"],
    &["agents", "default_subagent_model"],
    &["memories", "extract_model"],
    &["memories", "consolidation_model"],
];

/// 中转启动：磁盘设过上面几处的，本进程改成这次的模型（-c 只盖本进程；没设的不加，让 Codex 自己继承主模型）
fn codex_relay_model_args(cfg: Option<&toml::Value>, model: &str) -> Vec<String> {
    let Some(cfg) = cfg else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for path in CODEX_SIDE_MODEL_KEYS {
        let mut cur = Some(cfg);
        for seg in *path {
            cur = cur.and_then(|v| v.get(*seg));
        }
        if cur.and_then(|v| v.as_str()).is_some_and(|m| m != model) {
            out.push("-c".into());
            out.push(format!(r#"{}="{}""#, path.join("."), model.replace('"', "")));
        }
    }
    out
}

fn codex_user_config_for_launch() -> Option<toml::Value> {
    #[cfg(test)]
    {
        return tests::TEST_CODEX_CONFIG.with(|k| k.borrow().clone());
    }
    #[cfg(not(test))]
    crate::agent_specs::codex_user_config()
}

/// Codex 内联 provider 的 -c 定义参数（启动注入与外部恢复命令同一出处）。
/// 新会话 provider 名是 ccode-<网关短id>；旧 rollout 仍可能记 model_provider="ccode"，
/// 恢复时没有这组定义 codex 报 "Model provider `ccode` not found"。
/// 只含 base_url 与 env_key 变量名引用，不含密钥
/// （密钥值由用户 shell 环境里的 CODEX_API_KEY 提供，不进命令行——关键约定不变）
fn codex_inline_provider_args(base_url: &str, key_env: &str, provider: &str) -> Vec<String> {
    let mut out = Vec::new();
    for kv in [
        format!(r#"model_providers.{provider}.name="Mesa""#),
        format!(r#"model_providers.{provider}.base_url="{base_url}""#),
        format!(r#"model_providers.{provider}.env_key="{key_env}""#),
        format!(r#"model_providers.{provider}.wire_api="responses""#),
    ] {
        out.push("-c".into());
        out.push(kv);
    }
    out.push("-c".into());
    out.push(format!(r#"model_provider="{provider}""#));
    out
}

/// 复制到用户终端的恢复命令附加参数：仅 codex 且调用方给出 Base URL 时补
/// provider 定义；复制命令本身不携带 Mesa profile 密钥，其他 agent 依赖用户全局配置。
fn resume_extra_args(
    agent_id: &str,
    base_url: Option<&str>,
    session_provider: Option<&str>,
) -> Vec<String> {
    match (agent_id, base_url) {
        ("codex", Some(url)) if !url.trim().is_empty() => match agent_spec("codex") {
            Some(spec) => match spec.launch {
                crate::agent_specs::LaunchSpec::Special(
                    crate::agent_specs::SpecialLaunch::CodexInlineProvider { key_env, .. },
                ) => {
                    let pid = match session_provider.map(str::trim).filter(|s| !s.is_empty()) {
                        Some(p) if crate::provider_id::is_ccode_provider(p) => p,
                        _ => crate::provider_id::LEGACY,
                    };
                    let mut args = codex_inline_provider_args(url, key_env, pid);
                    args.extend(codex_relay_compat_args());
                    args
                }
                _ => vec![],
            },
            None => vec![],
        },
        _ => vec![],
    }
}

/// 外部终端启动的临时包装器：只把明确选中的 profile id/model 这类无敏感元数据从前端传进来，
/// 缺少 profile id 时 fail-closed，避免多配置场景静默选错端点。密钥由后端从 ProfileStore
/// 读取后写入一次性 0600 文件。包装器路径本身可以进入
/// Ghostty 的启动命令，因为路径不含密钥；包装器经 /bin/sh 启动后立即自删，超时兜底清理。
fn external_profile(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: Option<&str>,
    provider: Option<&str>,
    base_url: Option<&str>,
    selected_model: Option<&str>,
) -> Result<Profile, String> {
    let requested_id = require_external_profile_id(profile_id)?;
    let mut profile = store.get_with_model(requested_id, selected_model)?;
    if profile.agent != agent_id {
        return Err(format!("profile 不存在或与 {agent_id} 不兼容"));
    }
    // 与前端 pickResumeProfile 一致：派生 provider 时绑定的网关必须对得上。
    if let Some(prov) = provider
        .map(str::trim)
        .filter(|p| p.starts_with(crate::provider_id::PREFIX))
    {
        if !profile
            .gateway_id
            .as_deref()
            .is_some_and(|g| crate::provider_id::gateway_matches_provider(g, prov))
        {
            let all = store.list()?;
            if let Some(alt) = all.iter().find(|p| {
                p.agent == agent_id
                    && p.gateway_id
                        .as_deref()
                        .is_some_and(|g| crate::provider_id::gateway_matches_provider(g, prov))
            }) {
                profile = store.get_with_model(&alt.id, selected_model)?;
            }
        }
    }
    profile.apply_session_provider(provider);
    // 兼容旧版调用方传入的 baseUrl；新路径优先使用 profile 自身配置。
    if profile
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_none()
    {
        if let Some(url) = base_url.map(str::trim).filter(|s| !s.is_empty()) {
            profile.base_url = Some(url.to_string());
        }
    }
    crate::profile_validation::validate_profile_fields(&profile)?;
    Ok(profile)
}

fn require_external_profile_id(profile_id: Option<&str>) -> Result<&str, String> {
    profile_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "外部启动必须指定 Mesa profile，请重新选择配置".to_string())
}

/// 启动凭证检查：API 连接必须有密钥（或显式无密钥）；官方账号必须先过配置层冲突防线。
pub(crate) fn ensure_launch_credentials(
    profile: &Profile,
    key: Option<&str>,
) -> Result<(), String> {
    if profile.account_type == crate::profiles::AccountType::Official {
        // 只读检测、命中即拒，不自动改用户配置文件：claude 等的配置文件 env 块会
        // 覆盖 shell env（matrix §1），env_remove 只清进程环境变量管不到磁盘配置——
        // 残留 ANTHROPIC_* 会让「官方账号」会话实际走 API 计费。
        if let Some(home) = dirs::home_dir() {
            let conflicts = official_launch_conflicts(&home, profile);
            if !conflicts.is_empty() {
                return Err(format!(
                    "无法按官方账号启动：{}。到连接页在这家 Agent 的「官方账号」那行点地球图标切回官方（只撤这几项，提示里可撤销）后再启动",
                    conflicts.join("；")
                ));
            }
        }
        return Ok(());
    }
    if profile.account_type == crate::profiles::AccountType::Api
        && !profile.no_auth
        && key.is_none_or(|value| value.trim().is_empty())
    {
        return Err("API 连接没有密钥；请回到连接页填写密钥，或明确勾选本地端点无密钥".into());
    }
    Ok(())
}

/// 官方账号启动前的配置层冲突扫描（只读；home 显式传入便于测试，不随宿主机器漂移）
fn official_launch_conflicts(home: &std::path::Path, profile: &Profile) -> Vec<String> {
    if profile.account_type != crate::profiles::AccountType::Official {
        return Vec::new();
    }
    let Some(spec) = agent_spec(&profile.agent) else {
        return Vec::new();
    };
    let Some(oa) = &spec.official_account else {
        return Vec::new();
    };
    match profile.agent.as_str() {
        // 启动时进程级盖过（--settings 空串 / --auth-type），磁盘残留不再挡官方账号
        "claude-code" | "codebuddy" | "qwen" => Vec::new(),
        // Gemini 的认证方式只认 settings 的 selectedType，进程级盖不过（见 gemini_auth_blocker 注释）
        "gemini" => match gemini_selected_auth_type(profile) {
            // 进程里写空 GEMINI_MODEL 压不住 .env（0.65 实测），中转模型名只能拦
            Some(t) if t == "oauth-personal" => dotenv_value(&home.join(".gemini/.env"), "GEMINI_MODEL")
                .filter(|m| !crate::global_config::official_model_kept("gemini", m))
                .map(|m| vec![format!("~/.gemini/.env 里的 GEMINI_MODEL 是中转模型 {m}")])
                .unwrap_or_default(),
            Some(t) => vec![format!("~/.gemini/settings.json 里认证方式是 {t}，不是 Google 账号登录")],
            None => probe_conflicts(home, oa),
        },
        // Kimi 没选模型时用 kimi login 配好的模型；一个都没有就是还没登录官方账号
        "kimi" => {
            if profile.models.is_empty() && kimi_official_alias(profile).is_none() {
                vec!["Kimi 的 config.toml 里还没有官方账号的模型（还没用 kimi login 登录）".into()]
            } else {
                Vec::new()
            }
        }
        // Grok：api_key 照旧按探测拦；默认模型是中转模型（glm 之类）时官方账号也用不了
        "grok" => {
            let mut out = probe_conflicts(home, oa);
            let default = std::fs::read_to_string(home.join(".grok/config.toml"))
                .ok()
                .and_then(|t| toml::from_str::<toml::Value>(&t).ok())
                .and_then(|v| v.get("models")?.get("default")?.as_str().map(str::to_string));
            // 启动时 GROK_CONFIG 覆盖层把默认模型钉成官方模型（apply_official_inject）；定不出官方模型时才拦
            let can_pin = !profile.models.is_empty() || !official_models_for_launch("grok").is_empty();
            if let Some(m) = default.filter(|m| !can_pin && !crate::global_config::official_model_kept("grok", m)) {
                out.push(format!("~/.grok/config.toml 的默认模型是中转模型 {m}"));
            }
            out
        }
        _ => probe_conflicts(home, oa),
    }
}

/// .env 里某个键的值（只用于模型名这类非密钥；引号去掉）
fn dotenv_value(path: &std::path::Path, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    text.lines().find_map(|l| {
        let (k, v) = l.trim().trim_start_matches("export ").split_once('=')?;
        (k.trim() == key).then(|| v.trim().trim_matches('"').trim_matches('\'').to_string())
    })
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

// 运行路径仅 unix（外部终端 sh 包装器）
#[cfg_attr(not(unix), allow(dead_code))]
fn sh_script_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn external_wrapper_dir() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("external-launch");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建外部启动临时目录失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("收紧外部启动临时目录权限失败: {e}"))?;
    }
    // Windows：目录在 %APPDATA%\ccode 下，默认 ACL 已是当前用户；不要在启动热路径
    // 同步跑 icacls（Defender 下可卡数秒，表现为「在外部继续」点了很久才弹出窗口）。
    sweep_stale_external_wrappers(&dir);
    Ok(dir)
}

/// 清扫遗留的启动包装器（best-effort）：正常寿命 = 脚本首行自删 + 60s 兜底线程；
/// 兜底线程没跑到进程就退出时，靠这里在下一次外部启动前回收，不让旧 wrapper 无限滞留。
fn sweep_stale_external_wrappers(dir: &std::path::Path) {
    let Some(cutoff) =
        std::time::SystemTime::now().checked_sub(std::time::Duration::from_secs(120))
    else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("launch-") && !name.starts_with("claude-settings-") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|mtime| mtime < cutoff);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn schedule_wrapper_cleanup(path: PathBuf) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(60));
        let _ = std::fs::remove_file(path);
    });
}

/// 外部终端一次性启动包装。凭证通道分平台（audit P0）：
/// - Linux：终端由 Mesa 直接 spawn，密钥注入终端进程 env 继承进窗口 shell，脚本不含凭证；
/// - macOS：终端经 launchd 拉起（open/AppleScript/已在运行的 Ghostty 实例），父进程 env
///   到不了新窗口，密钥只能随脚本传递——0600 文件 + 0700 目录 + 首行自删 + 60s 兜底清理。
#[cfg(unix)]
fn write_external_wrapper(
    binary: &str,
    args: &[String],
    env: &[(String, String)],
    env_remove: &[String],
) -> Result<PathBuf, String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    for (name, _) in env {
        if !valid_env_name(name) {
            return Err(format!("profile 附加环境变量名非法: {name}"));
        }
    }
    let dir = external_wrapper_dir()?;
    let path = dir.join(format!("launch-{}.sh", uuid::Uuid::new_v4()));
    let mut text = String::from(
        "#!/bin/sh\n\n# Mesa one-shot external launch; remove credentials before exec.\n\n",
    );
    text.push_str("self=\"$0\"\nrm -f -- \"$self\" 2>/dev/null || :\n");
    for name in env_remove {
        if valid_env_name(name) {
            text.push_str("unset ");
            text.push_str(name);
            text.push('\n');
        }
    }
    for (name, value) in env {
        text.push_str("export ");
        text.push_str(name);
        text.push('=');
        text.push_str(&sh_script_quote(value));
        text.push('\n');
    }
    text.push_str("exec ");
    text.push_str(&sh_script_quote(binary));
    for arg in args {
        text.push(' ');
        text.push_str(&sh_script_quote(arg));
    }
    text.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| format!("创建外部启动包装器失败: {e}"))?;
    file.write_all(text.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| {
            let _ = std::fs::remove_file(&path);
            format!("写入外部启动包装器失败: {e}")
        })?;
    schedule_wrapper_cleanup(path.clone());
    Ok(path)
}

/// PowerShell 外部启动脚本正文：只含自删 + 启动命令，不含任何环境变量。
/// 密钥走父进程环境块经 start 继承（与 cmd 路径同口径，spawn_windows_start 注入）。
// 运行路径仅 Windows；测试在任意宿主构造文本
#[cfg(any(windows, test))]
fn external_ps1_script_text(binary: &str, args: &[String]) -> String {
    // 首字符必须是 UTF-8 BOM：powershell.exe（5.1）对**无 BOM** 文件按系统 ANSI 代码页
    // 解析（中文系统 = GBK936）。脚本里的中文（用户名 C:\Users\张三、项目名、prompt 参数）
    // 会被按 GBK 错位解码，把后面的引号当成汉字的 trail byte 吞掉，直接报
    // 「字符串缺少终止符」——整个脚本一行都不执行，外部终端一闪而过。
    // 是否触发取决于具体汉字的字节序列（「中文路径」侥幸无损、「技能张三」必炸），
    // 是数据相关的间歇故障，务必不要因为某次没复现就把 BOM 去掉。
    let mut text = String::from("\u{FEFF}$self = $PSCommandPath\nRemove-Item -LiteralPath $self -Force -ErrorAction SilentlyContinue\n");
    text.push_str("& ");
    text.push_str(&format!("'{}'", binary.replace('\'', "''")));
    for arg in args {
        text.push(' ');
        text.push_str(&format!("'{}'", arg.replace('\'', "''")));
    }
    text.push('\n');
    text
}

#[cfg(windows)]
fn write_external_wrapper(binary: &str, args: &[String]) -> Result<PathBuf, String> {
    let dir = external_wrapper_dir()?;
    let path = dir.join(format!("launch-{}.ps1", uuid::Uuid::new_v4()));
    std::fs::write(&path, external_ps1_script_text(binary, args))
        .map_err(|e| format!("写入外部启动包装器失败: {e}"))?;
    schedule_wrapper_cleanup(path.clone());
    Ok(path)
}

#[cfg(unix)]
fn external_wrapper_command(cwd: &str, wrapper: &Path) -> String {
    let cwd = expand_home_path(cwd);
    format!(
        "cd {} && /bin/sh {}",
        sh_quote_if_needed(&cwd),
        sh_quote_if_needed(&wrapper.to_string_lossy())
    )
}

/// 外部终端命令交给 shell 前先展开用户输入的家目录缩写。
/// 不能直接把 `~` 放进单引号，否则 POSIX shell 会按字面目录名处理。
fn expand_home_path(cwd: &str) -> String {
    let Some(home) = dirs::home_dir() else {
        return cwd.to_string();
    };
    let trimmed = cwd.trim();
    if trimmed == "~" {
        return home.to_string_lossy().into_owned();
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        return home.join(rest).to_string_lossy().into_owned();
    }
    cwd.to_string()
}

fn external_launch_args(
    agent_id: &str,
    profile: &Profile,
    key: Option<String>,
    model: Option<&str>,
    resume_session_id: Option<&str>,
    prompt: Option<&str>,
) -> Result<(Vec<String>, Vec<(String, String)>, Vec<String>), String> {
    validate_launch_compatibility(profile, model)?;
    let plan = match prompt {
        Some(prompt) => launch_plan_with_prompt(profile, key, model, Some(prompt))?,
        None => launch_plan(profile, key, model)?,
    };
    if prompt.is_some() && plan.prompt_dropped {
        return Err(format!(
            "{agent_id} 不支持启动注入参数，简报指令需启动后手动发送"
        ));
    }
    let extra = prepare_launch(profile)?;
    let mut args = Vec::new();
    if let Some(session_id) = resume_session_id {
        let (prepend, resume) = resume_args(agent_id, session_id);
        if prepend {
            args.extend(resume.iter().cloned());
        }
        args.extend(plan.args);
        args.extend(extra);
        if !prepend {
            args.extend(resume);
        }
    } else {
        args.extend(plan.args);
        args.extend(extra);
        // 与内嵌启动保持同一会话归属语义：支持固定 session id 的 CLI
        //（Claude/Qwen/CodeBuddy）在外部提炼接力时也锁定本次新会话文件名。
        // 必须放在首条 prompt 之前，避免位置参数 CLI 把它误当成用户指令。
        if agent_spec(agent_id).is_some_and(|spec| spec.fixed_session_id) {
            args.push("--session-id".into());
            args.push(uuid::Uuid::new_v4().to_string());
        }
        args.extend(plan.prompt_args);
    }
    Ok((args, plan.env, plan.env_remove))
}

fn open_external_profiled(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: Option<&str>,
    provider: Option<&str>,
    base_url: Option<&str>,
    model: Option<&str>,
    cwd: &str,
    resume_session_id: Option<&str>,
    prompt: Option<&str>,
) -> Result<(), String> {
    let mut profile = external_profile(store, agent_id, profile_id, provider, base_url, model)?;
    let selected_model = model
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .or_else(|| profile.models.first().cloned());
    crate::combo::apply_to_profile(&mut profile, selected_model.as_deref());
    let key = crate::profiles::get_key_for_profile(&profile)?;
    ensure_launch_credentials(&profile, key.as_deref())?;
    let (args, env, env_remove) = external_launch_args(
        agent_id,
        &profile,
        key,
        selected_model.as_deref(),
        resume_session_id,
        prompt,
    )?;
    let binary =
        resolve_binary(binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?)
            .ok_or_else(|| format!("未找到 {agent_id} 的 CLI 二进制"))?;
    let pref = crate::settings::read_current()
        .external_terminal
        .unwrap_or_else(|| "auto".into());
    #[cfg(windows)]
    {
        return open_windows_external(
            &pref,
            cwd,
            &binary.to_string_lossy(),
            &args,
            &env,
            &env_remove,
        );
    }
    // macOS：终端经 launchd 拉起（open/AppleScript/已运行的 Ghostty 实例），父进程 env
    // 到不了新窗口，密钥只能随一次性包装脚本传递（0600 + 首行自删 + 60s 兜底清理）。
    #[cfg(target_os = "macos")]
    {
        let wrapper = write_external_wrapper(&binary.to_string_lossy(), &args, &env, &env_remove)?;
        let cmd = external_wrapper_command(cwd, &wrapper);
        match open_external_terminal(&cmd, &pref, cwd, &wrapper) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = std::fs::remove_file(&wrapper);
                Err(e)
            }
        }
    }
    // Linux：终端由 Mesa 直接 spawn，密钥注入终端进程 env 由窗口 shell 继承
    //（与 Windows start 环境块同口径），包装脚本不含凭证。
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let wrapper = write_external_wrapper(&binary.to_string_lossy(), &args, &[], &[])?;
        let cmd = external_wrapper_command(cwd, &wrapper);
        match open_external_terminal(&cmd, &pref, cwd, &wrapper, &env, &env_remove) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = std::fs::remove_file(&wrapper);
                Err(e)
            }
        }
    }
}

/// shell 单引号转义（POSIX）；仅含安全字符时不加引号，保持 cc-switch 风格的干净命令行
// 运行路径仅 unix；Windows 仅测试调用
#[cfg_attr(not(any(unix, test)), allow(dead_code))]
fn sh_quote_if_needed(s: &str) -> String {
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "-._/".contains(c))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// 会话恢复的完整命令行（cd 到项目目录 + CLI resume 参数）。
/// 刻意不带 profile env——密钥只在 Mesa 自家拉起时注入（关键约定），
/// 外部恢复用的是用户全局配置。binary 参数允许外部拉起时传绝对路径（见下）。
// 运行路径仅 unix（Windows 走 windows_resume_command_line）；测试跨平台校验命令文本
#[cfg_attr(not(any(unix, test)), allow(dead_code))]
fn resume_command_line_with(
    agent_id: &str,
    session_id: &str,
    cwd: &str,
    binary: &str,
    extra_args: &[String],
) -> Result<String, String> {
    let (_, args) = resume_args(agent_id, session_id);
    if args.is_empty() {
        return Err(format!("{agent_id} 不支持按 ID 恢复"));
    }
    // binary 可能是含空格的绝对路径（外部拉起场景），与 cwd 一样必须 shell 转义
    let mut cmd = format!(
        "cd {} && {}",
        sh_quote_if_needed(cwd),
        sh_quote_if_needed(binary)
    );
    for a in args.iter().chain(extra_args) {
        cmd.push(' ');
        cmd.push_str(&sh_quote_if_needed(a));
    }
    Ok(cmd)
}

/// PowerShell 单引号包裹（内嵌 ' 加倍）。复制命令给用户粘贴到 Windows 默认交互 shell。
#[cfg(any(windows, test))]
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

#[cfg(any(windows, test))]
fn ps_arg(a: &str) -> String {
    if a.starts_with('-')
        && !a
            .chars()
            .any(|c| c.is_whitespace() || c == '\'' || c == '"')
    {
        a.to_string()
    } else {
        ps_quote(a)
    }
}

#[cfg(any(windows, test))]
fn windows_ps_invoke(
    cwd: &str,
    binary: &str,
    args: impl IntoIterator<Item = impl AsRef<str>>,
) -> String {
    let mut cmd = format!("Set-Location {}; & {}", ps_quote(cwd), ps_quote(binary));
    for a in args {
        cmd.push(' ');
        cmd.push_str(&ps_arg(a.as_ref()));
    }
    cmd
}

#[cfg(any(windows, test))]
fn windows_resume_command_line(
    agent_id: &str,
    session_id: &str,
    cwd: &str,
    binary: &str,
    extra_args: &[String],
) -> Result<String, String> {
    let (_, args) = resume_args(agent_id, session_id);
    if args.is_empty() {
        return Err(format!("{agent_id} 不支持按 ID 恢复"));
    }
    Ok(windows_ps_invoke(
        cwd,
        binary,
        args.iter().chain(extra_args),
    ))
}

/// 复制用命令行：裸命令名（用户真实交互终端 rc 齐全，且 cc-switch 风格干净）
// 测试便捷包装：生产入口 session_resume_command 直接走 _with（带 extra args）
#[cfg_attr(not(test), allow(dead_code))]
pub fn resume_command_line(agent_id: &str, session_id: &str, cwd: &str) -> Result<String, String> {
    let binary = binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    resume_command_line_with(agent_id, session_id, cwd, binary, &[])
}

/// Codex 桌面客户端可识别的 provider 名单：客户端打开会话时按 rollout 记录的
/// model_provider 在 config.toml 里找定义，缺失即报「Model provider `X` not found」
/// 拒绝继续（2026-08-31 实测）。内置 "openai" 恒可用、不在表内；
/// 文件缺失/损坏返回空表（client_open 预检据此判断渠道是否需要补写）。
pub fn codex_client_config_providers() -> Vec<String> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let base = std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let Ok(text) = std::fs::read_to_string(base.join("config.toml")) else {
        return Vec::new();
    };
    codex_config_provider_names(&text)
}

fn codex_config_provider_names(text: &str) -> Vec<String> {
    let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else {
        return Vec::new();
    };
    doc.get("model_providers")
        .and_then(|i| i.as_table())
        .map(|t| {
            t.iter()
                .filter(|(_, item)| {
                    // ChatGPT 自带 Codex 不认 provider 上的 http_headers（MCP 字段），
                    // 整段加载失败后查找即报 not found。不当成已注册，菜单才能再点「注册」迁走。
                    item.as_table()
                        .is_none_or(|tbl| tbl.get("http_headers").is_none())
                })
                .map(|(k, _)| k.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// 复制给用户粘贴进自己 PowerShell 的命令：裸名 `codex` 会先命中 npm 生成的 codex.ps1，
/// 被 Windows 客户端默认执行策略（Restricted）拦下「禁止运行脚本」。改写成解析出的
/// .exe / .cmd 绝对路径，不经 .ps1；解析不到（或解析到无扩展名的 shell 脚本）退回裸名
#[cfg(windows)]
fn windows_paste_binary(binary: &str) -> String {
    resolve_binary(binary)
        .filter(|p| {
            p.extension().is_some_and(|e| {
                e.eq_ignore_ascii_case("exe")
                    || e.eq_ignore_ascii_case("cmd")
                    || e.eq_ignore_ascii_case("bat")
            })
        })
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| binary.to_string())
}

/// 复制用：返回该会话的恢复命令行。
/// base_url：codex 会话走 Mesa 内联 provider（rollout 记 model_provider="ccode"）时必须
/// 补上 provider 定义才能在外部恢复——定义不含密钥（env_key 是变量名引用）
#[tauri::command]
pub fn session_resume_command(
    agent_id: &str,
    session_id: &str,
    cwd: &str,
    base_url: Option<String>,
    provider: Option<String>,
) -> Result<String, String> {
    let binary = binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    let extra = resume_extra_args(agent_id, base_url.as_deref(), provider.as_deref());
    #[cfg(target_os = "windows")]
    return windows_resume_command_line(
        agent_id,
        session_id,
        cwd,
        &windows_paste_binary(binary),
        &extra,
    );
    #[cfg(not(target_os = "windows"))]
    resume_command_line_with(agent_id, session_id, cwd, binary, &extra)
}

/// 外部终端在后台线程打开：macOS 上要等 osascript / open 跑完（第一次控制某个终端应用时系统还会弹授权框，
/// 人点之前一直等着）。同步命令跑在主线程上，这期间 Mesa 所有终端的输出和按键都会停住
///（见 conventions/terminal.md「会等待的命令不占主线程」）
async fn open_external_off_main(
    app: tauri::AppHandle,
    open: impl FnOnce(&ProfileStore) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        open(&app.state::<ProfileStore>())
    })
    .await
    .map_err(|e| format!("打开外部终端失败: {e}"))?
}

/// 在外部终端应用中恢复会话。profile、模型、provider 与 CLI 参数由后端复用
/// launch_plan 生成；密钥只写入一次性 0600 wrapper，绝不进入 argv/剪贴板/前端 payload。
#[tauri::command]
pub async fn resume_external_terminal(
    app: tauri::AppHandle,
    agent_id: String,
    session_id: String,
    cwd: String,
    profile_id: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    base_url: Option<String>,
) -> Result<(), String> {
    open_external_off_main(app, move |store| {
        open_external_profiled(
            store,
            &agent_id,
            profile_id.as_deref(),
            provider.as_deref(),
            base_url.as_deref(),
            model.as_deref(),
            &cwd,
            Some(&session_id),
            None,
        )
    })
    .await
}

/// 在外部终端按指定 Mesa profile 新建会话。与连接页「在终端使用」同一套注入计划。
#[tauri::command]
pub async fn new_external_terminal(
    app: tauri::AppHandle,
    agent_id: String,
    cwd: String,
    profile_id: String,
    model: Option<String>,
) -> Result<(), String> {
    open_external_off_main(app, move |store| {
        open_external_profiled(
            store,
            &agent_id,
            Some(&profile_id),
            None,
            None,
            model.as_deref(),
            &cwd,
            None,
            None,
        )
    })
    .await
}

/// 「◈ 提炼接力」外部续作命令行：cd 到项目目录 + 新会话首条指令（读简报续作，非 resume）。
/// 注入形态读注册表 prompt_inject：Positional → 位置参数，Flag → `-i '<prompt>'`；
/// Unsupported（目前仅 kimi）报错，由前端改为复制指令文本。
/// 与 resume 命令同一口径：不带 profile env，外部用的是用户全局配置。
// 运行路径仅 unix（sh 引号口径）；Windows 仅测试调用
#[cfg_attr(not(any(unix, test)), allow(dead_code))]
fn digest_command_line_with(
    agent_id: &str,
    cwd: &str,
    prompt: &str,
    binary: &str,
) -> Result<String, String> {
    let mut cmd = format!(
        "cd {} && {}",
        sh_quote_if_needed(cwd),
        sh_quote_if_needed(binary)
    );
    match agent_spec(agent_id).map(|s| s.prompt_inject) {
        Some(crate::agent_specs::PromptInject::Positional) => {
            cmd.push(' ');
            cmd.push_str(&sh_quote_if_needed(prompt));
        }
        Some(crate::agent_specs::PromptInject::Flag(flag)) => {
            cmd.push(' ');
            cmd.push_str(flag);
            cmd.push(' ');
            cmd.push_str(&sh_quote_if_needed(prompt));
        }
        Some(crate::agent_specs::PromptInject::Unsupported) => {
            return Err(format!(
                "{agent_id} 无启动注入参数，简报指令需启动后手动发送"
            ));
        }
        None => return Err(format!("未知 agent: {agent_id}")),
    }
    Ok(cmd)
}

/// PowerShell 方言的提炼接力命令行（镜像 windows_resume_command_line）
#[cfg(any(windows, test))]
fn windows_digest_command_line(
    agent_id: &str,
    cwd: &str,
    prompt: &str,
    binary: &str,
) -> Result<String, String> {
    let extra: Vec<String> = match agent_spec(agent_id).map(|s| s.prompt_inject) {
        Some(crate::agent_specs::PromptInject::Positional) => vec![prompt.to_string()],
        Some(crate::agent_specs::PromptInject::Flag(flag)) => {
            vec![flag.to_string(), prompt.to_string()]
        }
        Some(crate::agent_specs::PromptInject::Unsupported) => {
            return Err(format!(
                "{agent_id} 无启动注入参数，简报指令需启动后手动发送"
            ));
        }
        None => return Err(format!("未知 agent: {agent_id}")),
    };
    Ok(windows_ps_invoke(cwd, binary, extra))
}

/// 复制用：提炼接力的外部续作命令行（裸命令名，同 session_resume_command 口径）
#[tauri::command]
pub fn session_digest_command(agent_id: &str, cwd: &str, prompt: &str) -> Result<String, String> {
    let binary = binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    #[cfg(target_os = "windows")]
    return windows_digest_command_line(agent_id, cwd, prompt, &windows_paste_binary(binary));
    #[cfg(not(target_os = "windows"))]
    digest_command_line_with(agent_id, cwd, prompt, binary)
}

/// 在外部终端应用中以「读简报续作」开新会话；使用与内嵌启动相同的 profile 注入计划。
#[tauri::command]
pub async fn digest_external_terminal(
    app: tauri::AppHandle,
    agent_id: String,
    cwd: String,
    prompt: String,
    profile_id: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    open_external_off_main(app, move |store| {
        open_external_profiled(
            store,
            &agent_id,
            profile_id.as_deref(),
            None,
            None,
            model.as_deref(),
            &cwd,
            None,
            Some(&prompt),
        )
    })
    .await
}

/// 应用装在哪：/Applications 或用户自己的 ~/Applications（不用管理员权限装的 iTerm / Ghostty 常在后者，
/// 原先只认 /Applications，装在 ~/Applications 的报「未安装」）
#[cfg(target_os = "macos")]
fn mac_app_installed(bundle: &str) -> bool {
    std::path::Path::new("/Applications").join(bundle).exists()
        || dirs::home_dir().is_some_and(|h| h.join("Applications").join(bundle).exists())
}

#[cfg(target_os = "macos")]
fn open_external_terminal(cmd: &str, pref: &str, cwd: &str, wrapper: &Path) -> Result<(), String> {
    match pref {
        "ghostty" => open_ghostty(cmd, cwd, wrapper),
        "iterm" => open_iterm(cmd),
        "terminal" => open_terminal_app(cmd),
        // auto：Ghostty → iTerm → Terminal.app
        _ if mac_app_installed("Ghostty.app") => open_ghostty(cmd, cwd, wrapper),
        _ if mac_app_installed("iTerm.app") => open_iterm(cmd),
        _ => open_terminal_app(cmd),
    }
}

#[cfg(target_os = "macos")]
fn open_ghostty(cmd: &str, cwd: &str, wrapper: &Path) -> Result<(), String> {
    if !mac_app_installed("Ghostty.app") {
        return Err("未安装 Ghostty（设置页改选其他终端）".into());
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let running = Command::new("pgrep")
        .args(["-x", "ghostty"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !running {
        // 未运行：open -na 拉起（仅此一次产生实例）；Ghostty -e 之后的参数整体作为命令
        // 执行；-l -i 交互登录 shell（非交互模式 zsh 不加载 .zshrc / bash 不加载 .bashrc）
        return spawn_status(
            Command::new("open").args([
                "-na", "Ghostty", "--args", "-e", &shell, "-l", "-i", "-c", cmd,
            ]),
            "Ghostty",
        );
    }
    // 已运行：使用 Ghostty 自带 AppleScript 字典直接创建带 command 的窗口。
    // 旧实现通过 System Events 模拟 ⌘N/⌘V/回车：辅助功能权限或脚本任一步失败时，
    // 命令可能已经贴进终端但 wrapper 随错误返回被删除，最终变成「No such file」。
    // 原生 new surface configuration 不需要控制 System Events，也不经过剪贴板。
    // Ghostty 的 command 字段会自动包装成 `exec -l <command>`，所以不能传
    // `cd ... && ...`；否则会变成 `exec -l cd ...`。另外，command 字段对带空格
    // 的 shell 命令路径（本机 wrapper 位于 `Application Support`）不会可靠保留
    // POSIX 引号。让 Ghostty 先启动 /bin/sh，再通过 initial input 交给 shell
    // 解析一次路径，避免出现“wrapper 不存在”的假错误。
    let initial_working_directory = expand_home_path(cwd);
    let initial_input = format!(
        "exec /bin/sh {}\n",
        sh_quote_if_needed(&wrapper.to_string_lossy())
    );
    let escaped_cwd = applescript_escape(&initial_working_directory);
    let escaped_input = applescript_escape(&initial_input);
    spawn_status(
        Command::new("osascript").args([
            "-e",
            "tell application \"Ghostty\"",
            "-e",
            "set cfg to new surface configuration",
            "-e",
            &format!("set initial working directory of cfg to \"{escaped_cwd}\""),
            "-e",
            "set command of cfg to \"/bin/sh\"",
            "-e",
            &format!("set initial input of cfg to \"{escaped_input}\""),
            "-e",
            "new window with configuration cfg",
            "-e",
            "activate",
            "-e",
            "end tell",
        ]),
        "Ghostty",
    )
}

#[cfg(target_os = "macos")]
fn open_iterm(cmd: &str) -> Result<(), String> {
    if !mac_app_installed("iTerm.app") {
        return Err("未安装 iTerm2（设置页改选其他终端）".into());
    }
    // iTerm2 的进程名是 iTerm2（应用名 iTerm）
    let running = Command::new("pgrep")
        .args(["-x", "iTerm2"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let mut args = Vec::new();
    for line in iterm_script(cmd, running) {
        args.push("-e".to_string());
        args.push(line);
    }
    spawn_status(Command::new("osascript").args(&args), "iTerm")
}

/// iTerm2 AppleScript：命令写进**刚建的那个窗口**（用 create window 的返回值，不用 current window——
/// 别的窗口抢到焦点时，旧写法会把命令打进用户正在用的窗口）。iTerm 没在运行时，拉起后它自己会开一个窗口：
/// 等它出来直接用，免得一次出现两个窗口（等 3 秒还没有再自己建）。
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn iterm_script(cmd: &str, running: bool) -> Vec<String> {
    let escaped = cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let mut lines = vec!["tell application \"iTerm\"".to_string(), "activate".to_string()];
    if running {
        lines.push("set w to (create window with default profile)".into());
    } else {
        lines.extend(
            [
                "repeat 30 times",
                "if (count of windows) > 0 then exit repeat",
                "delay 0.1",
                "end repeat",
                "if (count of windows) > 0 then",
                "set w to current window",
                "else",
                "set w to (create window with default profile)",
                "end if",
            ]
            .map(String::from),
        );
    }
    lines.push(format!("tell current session of w to write text \"{escaped}\""));
    lines.push("end tell".into());
    lines
}

/// 系统自带 Terminal.app 兜底（do script 本身跑在 login shell 里）
#[cfg(target_os = "macos")]
fn open_terminal_app(cmd: &str) -> Result<(), String> {
    spawn_status(
        Command::new("osascript").args([
            "-e",
            "tell application \"Terminal\"",
            "-e",
            "activate",
            "-e",
            &format!("do script \"{}\"", applescript_escape(cmd)),
            "-e",
            "end tell",
        ]),
        "Terminal",
    )
}

/// AppleScript 字符串字面量转义（\ 和 "）
#[cfg(target_os = "macos")]
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn spawn_status(cmd: &mut Command, what: &str) -> Result<(), String> {
    let status = cmd.status().map_err(|e| format!("启动 {what} 失败: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("启动 {what} 失败: {status}"))
    }
}

/// cmd.exe 参数引用：无特殊字符原样；否则双引号包裹，内嵌 `"` 加倍。
/// 不处理 `%`：命令行上（非批处理）`%%` 不是转义、原样留两个 %，也挡不住 %VAR% 展开——
/// 含 `%`/换行的参数不走内联命令行，改写批处理包装（batch_quote_arg）。
#[cfg(any(windows, test))]
fn cmd_quote_arg(s: &str) -> String {
    let special = s.is_empty()
        || s.bytes().any(|b| {
            matches!(
                b,
                b' ' | b'\t' | b'"' | b'&' | b'|' | b'<' | b'>' | b'^' | b'%' | b'!' | b'(' | b')'
            )
        });
    if !special {
        return s.to_string();
    }
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\"\""),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// .cmd 批处理正文里的参数：批处理里 `%%` 才是字面 `%`（防 %VAR% 展开）；
/// 换行在 cmd 里无法表示（批处理按行执行），折成空格保住其余内容
#[cfg(any(windows, test))]
fn batch_quote_arg(s: &str) -> String {
    let flat = s.replace("\r\n", " ").replace(['\r', '\n'], " ");
    cmd_quote_arg(&flat).replace('%', "%%")
}

/// 内联 `cmd /K` 命令行放不下的参数：`%` 会被两层 cmd 各展开一次，换行会截断命令行
#[cfg(any(windows, test))]
fn cmd_inline_unsafe(s: &str) -> bool {
    s.contains(['%', '\n', '\r'])
}

/// 外层 `cmd /C start …` 对内层 `/S /K "<inner>"` 的转义：外层看来引号奇偶与内层相反
///（多包了一对引号），内层引号里的 `& | < > ^ ( )` 在外层是裸露的，要加 `^` 让外层原样交给 start
#[cfg(any(windows, test))]
fn cmd_outer_escape(inner: &str) -> String {
    let mut out = String::with_capacity(inner.len() + 8);
    // 进入 inner 之前已有一个开引号：外层视角初始在引号内
    let mut quoted = true;
    for c in inner.chars() {
        if c == '"' {
            quoted = !quoted;
        } else if !quoted && matches!(c, '&' | '|' | '<' | '>' | '^' | '(' | ')') {
            out.push('^');
        }
        out.push(c);
    }
    out
}

#[cfg(any(windows, test))]
fn windows_start_prefix(cwd: &str) -> String {
    // 标题必须非空：start "" 会给新控制台留下空标题，GetConsoleTitleW 对空标题返回 0，
    // 旧版 libuv（<1.52，kimi 等自带运行时的 CLI 可能内嵌）uv_get_process_title
    // 把 0 当成功、process_title 缓存仍是 NULL，随后 assert(process_title) 直接 abort
    // （win/util.c:412，start "" 场景 100% 复现，见 nodejs/node#58695）。
    let mut line = String::from("start \"Mesa\"");
    if !cwd.trim().is_empty() {
        line.push_str(&format!(" /D \"{}\"", cwd.replace('"', "")));
    }
    line
}

/// 设置「命令提示符」：可见宿主是 cmd，密钥走父进程环境块经 start 继承，不经 PowerShell。
///
/// 必须 `/S /K "<整行>"`：不带 /S 时，只要整行引号多于两个（程序路径含空格、
/// 参数也要引号），cmd 会剥掉首尾两个引号把路径拆坏（`C:\Program Files (x86)\…`、
/// `C:\Users\John Smith\…` 实证）；/S 语义固定为只剥最外一对。
#[cfg(any(windows, test))]
fn windows_external_start_line_cmd(cwd: &str, binary: &str, args: &[String]) -> String {
    windows_cmd_start_line_with(cwd, "", "/K", binary, args)
}

/// start_flags / switch 只为测试可换成 `/B /WAIT` + `/C`（不开可见窗口、跑完即退）
#[cfg(any(windows, test))]
fn windows_cmd_start_line_with(
    cwd: &str,
    start_flags: &str,
    switch: &str,
    binary: &str,
    args: &[String],
) -> String {
    let mut inner = cmd_quote_arg(binary);
    for a in args {
        inner.push(' ');
        inner.push_str(&cmd_quote_arg(a));
    }
    let mut line = windows_start_prefix(cwd);
    if !start_flags.is_empty() {
        line.push(' ');
        line.push_str(start_flags);
    }
    line.push_str(&format!(" cmd.exe /S {switch} \"{}\"", cmd_outer_escape(&inner)));
    line
}

/// cmd 宿主的启动行：能内联就内联；含 `%`/换行或超长时返回 None，由调用方改写批处理包装
#[cfg(any(windows, test))]
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_external_cmd_inline(cwd: &str, binary: &str, args: &[String]) -> Option<String> {
    if cmd_inline_unsafe(binary) || args.iter().any(|a| cmd_inline_unsafe(a)) {
        return None;
    }
    let line = windows_external_start_line_cmd(cwd, binary, args);
    (line.len() <= WINDOWS_START_LINE_MAX).then_some(line)
}

/// 设置「PowerShell」：可见宿主是 powershell -NoExit -File wrapper；
/// 密钥经 start 环境块继承进会话（与 cmd 路径同口径），ps1 只含启动命令。
#[cfg(any(windows, test))]
fn windows_external_start_line_ps(cwd: &str, wrapper: &Path) -> String {
    let mut line = windows_start_prefix(cwd);
    line.push_str(" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File ");
    line.push_str(&format!(
        "\"{}\"",
        wrapper.to_string_lossy().replace('"', "")
    ));
    line
}

/// cmd 命令行上限约 8191；超了改写无密钥的 .cmd 再 /K 它。
#[cfg(any(windows, test))]
#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_START_LINE_MAX: usize = 7000;

/// .cmd 包装器正文。批处理必须是单字节编码（UTF-16 会被读成乱码）；前两行 ASCII，chcp 65001 之后
/// cmd 按 UTF-8 解码后续行——命令行里的中文 prompt 靠这个存活，别写成 UTF-16/带 BOM
#[cfg(any(windows, test))]
#[cfg_attr(not(windows), allow(dead_code))]
fn external_cmd_wrapper_body(binary: &str, args: &[String]) -> String {
    let mut body = String::from("@echo off\r\nchcp 65001 >nul\r\n");
    body.push_str(&batch_quote_arg(binary));
    for a in args {
        body.push(' ');
        body.push_str(&batch_quote_arg(a));
    }
    body.push_str("\r\n");
    body
}

#[cfg(windows)]
fn write_external_cmd_wrapper(binary: &str, args: &[String]) -> Result<PathBuf, String> {
    let dir = external_wrapper_dir()?;
    let path = dir.join(format!("launch-{}.cmd", uuid::Uuid::new_v4()));
    let body = external_cmd_wrapper_body(binary, args);
    std::fs::write(&path, body.as_bytes()).map_err(|e| format!("写入外部启动包装器失败: {e}"))?;
    // 只含 binary+args（密钥走环境块不经这里），无需额外 ACL；60s 兜底清理
    schedule_wrapper_cleanup(path.clone());
    Ok(path)
}

#[cfg(target_os = "windows")]
fn spawn_windows_start(
    line: &str,
    env: &[(String, String)],
    env_remove: &[String],
) -> Result<(), String> {
    // 两个坑都别改回去：
    // 1) 预加引号的复合命令不能走 Command::args——Rust 会把 " 加壳成 \"，而 cmd 对 /C
    //    之后的文本不认反斜杠转义，start 会把引号标题当程序名。必须 raw_arg 原文直投。
    // 2) 不能直接 spawn powershell/cmd + CREATE_NEW_CONSOLE：dev 实例从 npm/Git Bash
    //    链路继承的 std 句柄是管道不是控制台，会原样遗传给子进程。start 经 ShellExecute
    //    拉起，子进程的 std 挂到它自己的新控制台。外层 cmd CREATE_NO_WINDOW 不可见，
    //    可见窗口由 start 创建——符合「只有用户明确打开的外部终端允许可见窗口」。
    // 3) 更不能 output()/pipe 收尾：start 的子进程继承 cmd 的管道句柄，read-to-EOF
    //    会阻塞到用户关掉外部窗口——同步 command 堵死、整个应用「未响应」（实测复现）。
    //    start 立即返回、cmd 随即退出，wait 只收 cmd 自己，毫秒级。
    let mut c = crate::process::background_command("cmd");
    for (k, v) in env {
        if valid_env_name(k) {
            c.env(k, v);
        }
    }
    for k in env_remove {
        if valid_env_name(k) {
            c.env_remove(k);
        }
    }
    c.arg("/C");
    c.raw_arg(line);
    let mut child = c.spawn().map_err(|e| format!("启动外部终端失败: {e}"))?;
    let status = child.wait().map_err(|e| format!("启动外部终端失败: {e}"))?;
    if !status.success() {
        return Err(format!("启动外部终端失败: {status}"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_windows_external(
    pref: &str,
    cwd: &str,
    binary: &str,
    args: &[String],
    env: &[(String, String)],
    env_remove: &[String],
) -> Result<(), String> {
    let cwd = expand_home_path(cwd);
    if pref == "powershell" {
        // 密钥放父进程环境块经 start 继承（与 cmd 路径同口径），ps1 只含启动命令
        let wrapper = write_external_wrapper(binary, args)?;
        let line = windows_external_start_line_ps(&cwd, &wrapper);
        return spawn_windows_start(&line, env, env_remove).map_err(|e| {
            let _ = std::fs::remove_file(&wrapper);
            e
        });
    }
    // cmd / auto：密钥放在父进程环境块，start 继承进可见 cmd。不经 PowerShell，
    // 避免 5.1 当 conhost 把 TUI 卡住，也避免 AMSI 扫描每次新写的 ps1。
    let line = match windows_external_cmd_inline(&cwd, binary, args) {
        Some(line) => line,
        None => {
            let wrapper = write_external_cmd_wrapper(binary, args)?;
            windows_external_start_line_cmd(&cwd, &wrapper.to_string_lossy(), &[])
        }
    };
    spawn_windows_start(&line, env, env_remove)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_external_terminal(
    cmd: &str,
    pref: &str,
    _cwd: &str,
    _wrapper: &Path,
    env: &[(String, String)],
    env_remove: &[String],
) -> Result<(), String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    // auto 按优先级探测；显式选择只试指定终端，未装则报错（设置页可改选）
    let candidates: Vec<&str> = match pref {
        "auto" | "" => vec![
            "gnome-terminal",
            "konsole",
            "xfce4-terminal",
            "x-terminal-emulator",
            "xterm",
        ],
        other => vec![other],
    };
    for term in candidates {
        if let Some(bin) = resolve_binary(term) {
            let mut c = Command::new(bin);
            // 密钥经 spawn env 由终端进程继承进窗口 shell（与 Windows start 环境块
            // 同口径），包装脚本本体不含凭证
            for (k, v) in env {
                if valid_env_name(k) {
                    c.env(k, v);
                }
            }
            for k in env_remove {
                if valid_env_name(k) {
                    c.env_remove(k);
                }
            }
            // -l -i 交互登录 shell：非交互模式不加载 .zshrc/.bashrc，用户 PATH 会丢
            if term == "gnome-terminal" {
                c.args(["--", &shell, "-l", "-i", "-c", cmd]);
            } else {
                c.args(["-e", &shell, "-l", "-i", "-c", cmd]);
            }
            c.spawn().map_err(|e| format!("启动 {term} 失败: {e}"))?;
            return Ok(());
        }
    }
    Err(match pref {
        "auto" | "" => "未找到可用的终端模拟器（gnome-terminal/konsole/xterm）".into(),
        other => format!("未安装所选终端 {other}（设置页改选其他终端）"),
    })
}

/// kimi 新旧两个产品共用命令，按数据目录推断装的是哪个变体（"new" | "legacy"）。
/// 目录名来自 AgentSpec.packaging.legacy_variant
pub(crate) fn kimi_variant() -> Option<&'static str> {
    crate::agent_specs::variant_of(agent_spec("kimi")?)
}

fn kimi_variant_hint() -> Option<&'static str> {
    match kimi_variant() {
        Some("new") => Some("新版"),
        Some("legacy") => Some("旧版"),
        _ => None,
    }
}

/// 检测结果按进程缓存；更新成功后由 updater 调 invalidate_detect_cache 清空。
/// 另加 2 分钟 TTL：用户在 Mesa 外自行安装 CLI 后不必重启才认（与 CHECK_CACHE 同口径）。
const DETECT_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(120);
static DETECT_CACHE: std::sync::Mutex<Option<(std::time::Instant, Vec<DetectResult>)>> =
    std::sync::Mutex::new(None);

pub(crate) fn invalidate_detect_cache() {
    *DETECT_CACHE.lock().unwrap() = None;
}

fn detect_one(spec: &'static AgentSpec) -> DetectResult {
    let (binary_path, mut version) = detect(spec);
    // 双变体 CLI（kimi）在版本号后标注装的是新版还是旧版
    if spec.packaging.legacy_variant.is_some() {
        if let (Some(v), Some(hint)) = (&version, kimi_variant_hint()) {
            version = Some(format!("{v} ({hint})"));
        }
    }
    let readonly_supported = readonly_supported_at(spec, version.as_deref());
    DetectResult {
        id: spec.id.to_string(),
        binary_path,
        version,
        readonly_supported,
        permission_modes: spec
            .permission_args
            .iter()
            .map(|(m, _)| (*m).to_string())
            .collect(),
        model_switch: match spec.model_switch {
            crate::agent_specs::ModelSwitch::Direct(t) => {
                Some(ModelSwitchDto::Direct(t.to_string()))
            }
            crate::agent_specs::ModelSwitch::Picker(c) => {
                Some(ModelSwitchDto::Picker(c.to_string()))
            }
            crate::agent_specs::ModelSwitch::None => None,
        },
        effort: spec.effort_levels.map(|(levels, cmd)| EffortSpecDto {
            levels: levels.iter().map(|s| s.to_string()).collect(),
            command: cmd.to_string(),
        }),
        submit_csi_u: spec.submit_csi_u,
    }
}

#[tauri::command]
pub async fn detect_agents() -> Vec<DetectResult> {
    {
        let cache = DETECT_CACHE.lock().unwrap();
        if let Some((ts, cached)) = &*cache {
            if ts.elapsed() < DETECT_CACHE_TTL {
                return cached.clone();
            }
        }
    }
    // --version 要 spawn 8 个子进程，放阻塞线程池并并行跑（与 updater 的更新检查同模式；
    // 单个 CLI 卡死由 version_with_timeout 的 5s 超时兜底）
    let results = tauri::async_runtime::spawn_blocking(|| {
        let handles: Vec<_> = crate::agent_specs::all_agent_specs()
            .iter()
            .map(|spec| std::thread::spawn(move || detect_one(spec)))
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    *DETECT_CACHE.lock().unwrap() = Some((std::time::Instant::now(), results.clone()));
    results
}

// ===== 官方账号（P1a）：只读检测 auth 文件，绝不写入/删除 =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialAccountStatusDto {
    /// 注册表已填该 agent 的官方账号规格
    pub supported: bool,
    /// auth 文件存在且解析出凭证字段
    pub connected: bool,
    /// 检测说明（漏报场景/文件异常），界面直接展示
    pub detail: Option<String>,
    /// 终端内执行的登录命令（含二进制名；不支持官方账号时 None）
    pub login_command: Option<String>,
    /// 配置文件冲突告警（中文可读描述；只含文件名与变量名，绝不含密钥值）
    pub conflicts: Vec<String>,
    /// Files that can be safely cleaned by removing only Mesa-owned API keys.
    pub cleanup_supported: bool,
    /// 组头登录标签要注入的环境（出网代理；连接 extra_env 由前端再覆盖）
    pub login_env: std::collections::BTreeMap<String, String>,
    /// 登录账号的套餐（Pro / Max / Plus / Free …），只在 connected 时给（2026-10-28 用户：官方账号行端点栏只显示套餐，
    /// 不显示邮箱）。目前只读 Claude Code / Codex 实测过的来源，其余读不到就 None，不猜
    pub plan: Option<String>,
    /// 登录账号的邮箱：只在悬停提示里给（2026-10-28 用户：不常驻显示，鼠标放上去再看）。
    /// Claude Code / Codex 读文件，Cursor 取 status 输出；只在 connected 时给
    pub email: Option<String>,
}

/// auth 文件里标识「官方账号已登录」的凭证字段名（各家结构不同，命中任一即算）：
/// codex tokens.access_token、claude claudeAiOauth.accessToken、gemini access_token / refresh_token。
/// 注意 OPENAI_API_KEY 不在此列——那是 API Key 模式（第三方中转同一形状），
/// 由 OfficialAccountSpec.api_key_fields 单独识别，不能算作官方账号连接
const CREDENTIAL_FIELD_NAMES: &[&str] = &[
    "access_token",
    "accessToken",
    "refresh_token",
    "refreshToken",
    "id_token",
];

/// 递归（限深）查找指定字段：值是非空字符串才命中；防御式——结构随版本漂移时不误判
fn json_has_field(value: &serde_json::Value, fields: &[&str], depth: u8) -> bool {
    if depth == 0 || fields.is_empty() {
        return false;
    }
    match value {
        serde_json::Value::Object(map) => map.iter().any(|(k, v)| {
            (fields.contains(&k.as_str()) && v.as_str().is_some_and(|s| !s.is_empty()))
                || json_has_field(v, fields, depth - 1)
        }),
        _ => false,
    }
}

/// 单个 auth 文件的只读探测；文件不存在/不可读 → None（按缺失处理）。
/// api_key_fields 命中（且无官方凭证字段）→ ApiKeyMode：API Key 模式不算官方账号连接
fn probe_auth_file(path: &std::path::Path, api_key_fields: &[&str]) -> Option<AuthProbe> {
    let text = std::fs::read_to_string(path).ok()?;
    Some(match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) if json_has_field(&v, CREDENTIAL_FIELD_NAMES, 4) => AuthProbe::Connected,
        Ok(v) if json_has_field(&v, api_key_fields, 4) => AuthProbe::ApiKeyMode,
        Ok(_) => AuthProbe::Unrecognized,
        Err(_) => AuthProbe::Corrupt,
    })
}

#[derive(Debug, PartialEq, Eq)]
enum AuthProbe {
    Connected,
    /// API Key 模式（如 codex auth.json 顶层 OPENAI_API_KEY）：可能是官方 --api-key，
    /// 也可能是第三方中转，不能显示为「已连接官方账号」
    ApiKeyMode,
    /// 存在但找不到凭证字段（结构可能随版本漂移）
    Unrecognized,
    /// 存在但解析失败（可能损坏或末行截断）
    Corrupt,
}

// ===== 配置冲突探测（P1a 增强）：CLI 自读配置文件里的残留密钥会覆盖官方账号登录 =====
// 只读扫描，只报变量名；密钥值只在这一行内存里经过，绝不进 DTO/日志

/// .env 逐行解析：容忍注释/空行/export 前缀与等号两侧空白；
/// 大小写敏感（env 变量名本身大小写敏感，小写变体不会被 CLI 当作同一变量读取）
fn dotenv_conflict_keys(text: &str, keys: &[&str]) -> Vec<String> {
    let mut hits = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some((name, _)) = line.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if keys.contains(&name) {
            hits.push(name.to_string());
        }
    }
    hits
}

/// settings.json 防御式解析：只查顶层 env 对象的键；文件损坏/env 非对象 → 无冲突
fn settings_env_conflict_keys(text: &str, keys: &[&str]) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(env) = value.get("env").and_then(|e| e.as_object()) else {
        return Vec::new();
    };
    env.keys()
        .filter(|k| keys.contains(&k.as_str()))
        .cloned()
        .collect()
}

fn toml_conflict_keys(text: &str, keys: &[&str]) -> Vec<String> {
    let Ok(value) = text.parse::<toml::Value>() else {
        return Vec::new();
    };
    let mut out = value
        .as_table()
        .into_iter()
        .flat_map(|table| table.keys())
        .filter(|key| keys.contains(&key.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    out.sort();
    out.dedup();
    out
}

/// 逐条执行注册表的冲突探测；文件缺失/不可读静默跳过（不算冲突）
fn probe_conflicts(
    home: &std::path::Path,
    oa: &crate::agent_specs::OfficialAccountSpec,
) -> Vec<String> {
    probe_conflict_hits(home, oa)
        .into_iter()
        .map(|(file, key, note)| format!("~/{file} 中存在 {key}，{note}"))
        .collect()
}

/// 探测结果的三元组形态（文件、键名、该探测器的说明）。只回键名不回值——
/// 调用方各自决定措辞与去向（官方账号：拒绝启动；API 连接：启动预览里提示）。
fn probe_conflict_hits(
    home: &std::path::Path,
    oa: &crate::agent_specs::OfficialAccountSpec,
) -> Vec<(&'static str, String, &'static str)> {
    let mut out = Vec::new();
    for probe in oa.conflict_probes {
        let Ok(text) = std::fs::read_to_string(home.join(probe.file)) else {
            continue;
        };
        let hits = if probe.file.ends_with(".json") {
            settings_env_conflict_keys(&text, probe.keys)
        } else if probe.file.ends_with(".toml") {
            toml_conflict_keys(&text, probe.keys)
        } else {
            dotenv_conflict_keys(&text, probe.keys)
        };
        for key in hits {
            out.push((probe.file, key, probe.note));
        }
    }
    out
}

/// API 连接启动前的只读提醒：磁盘配置文件里的同名键会盖过 Mesa 本次注入。
///
/// 与官方账号防线的区别是**不阻断**——API 连接本来就靠注入这些变量工作，磁盘上有残留
/// 是可疑而非致命；而 `claude_settings_override` 现在会把 base_url 与 token 一起提升到
/// `--settings` 层压过磁盘，多数情况已经自愈。这条提醒留给覆盖层管不到的键
///（例如与 `ANTHROPIC_AUTH_TOKEN` 并存的 `ANTHROPIC_API_KEY`）。
fn api_launch_conflict_notes(home: &std::path::Path, profile: &Profile) -> Vec<String> {
    // Claude Code / CodeBuddy 的连接键已由 --settings 覆盖层盖过（finalize_settings_overlay），不再提醒
    if matches!(profile.agent.as_str(), "claude-code" | "codebuddy") {
        return Vec::new();
    }
    let Some(spec) = agent_spec(&profile.agent) else {
        return Vec::new();
    };
    let Some(oa) = &spec.official_account else {
        return Vec::new();
    };
    probe_conflict_hits(home, oa)
        .into_iter()
        .map(|(file, key, _)| {
            format!(
                "注意：~/{file} 中存在 {key}，其配置层优先级高于本次启动注入的变量，可能盖掉本连接的设置"
            )
        })
        .collect()
}

fn clear_conflict_keys_in_file(
    path: &std::path::Path,
    probe: &crate::agent_specs::ConflictProbe,
) -> Result<bool, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    if probe.file.ends_with(".json") {
        let mut value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("{} 不是合法 JSON，已停止清理: {e}", path.display()))?;
        let Some(env) = value.get_mut("env").and_then(|v| v.as_object_mut()) else {
            return Ok(false);
        };
        let mut changed = false;
        for key in probe.keys {
            changed |= env.remove(*key).is_some();
        }
        if changed {
            let mut out = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
            out.push('\n');
            crate::profiles::atomic_write(path, &out)?;
            tighten_private_file(path)?;
        }
        return Ok(changed);
    }
    if probe.file.ends_with(".toml") {
        let mut doc = text
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("{} 不是合法 TOML，已停止清理: {e}", path.display()))?;
        let mut changed = false;
        for key in probe.keys {
            changed |= doc.remove(key).is_some();
        }
        if changed {
            crate::profiles::atomic_write(path, &doc.to_string())?;
            tighten_private_file(path)?;
        }
        return Ok(changed);
    }
    if probe.file.ends_with(".env") {
        let mut changed = false;
        let lines: Vec<String> = text
            .lines()
            .filter(|line| {
                let trimmed = line.trim();
                let assignment = trimmed.strip_prefix("export ").unwrap_or(trimmed);
                let name = assignment.split_once('=').map(|(name, _)| name.trim());
                let remove = name.is_some_and(|name| probe.keys.contains(&name));
                changed |= remove;
                !remove
            })
            .map(String::from)
            .collect();
        if changed {
            let mut out = lines.join("\n");
            out.push('\n');
            crate::profiles::atomic_write(path, &out)?;
            tighten_private_file(path)?;
        }
        return Ok(changed);
    }
    Ok(false)
}

// unix 收紧 0600；Windows 无 unix 权限位语义，空操作（参数仅 unix 分支消费）
#[cfg_attr(not(unix), allow(unused_variables))]
fn tighten_private_file(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("收紧冲突配置权限失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn clear_account_conflicts(agent_id: &str) -> Result<Vec<String>, String> {
    let spec = agent_spec(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    let oa = spec
        .official_account
        .as_ref()
        .ok_or_else(|| "该 agent 没有可清理的官方账号冲突项".to_string())?;
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    let backup_dir = dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("conflict-backups");
    std::fs::create_dir_all(&backup_dir).map_err(|e| format!("创建冲突备份目录失败: {e}"))?;
    let mut changed = Vec::new();
    for probe in oa.conflict_probes {
        if !probe.file.ends_with(".json")
            && !probe.file.ends_with(".env")
            && !probe.file.ends_with(".toml")
        {
            continue;
        }
        let path = home.join(probe.file);
        if path.is_file() {
            let backup = backup_dir.join(format!(
                "{}-{}-{}.bak",
                agent_id,
                uuid::Uuid::new_v4(),
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
            std::fs::copy(&path, &backup).map_err(|e| format!("备份冲突文件失败: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&backup, std::fs::Permissions::from_mode(0o600))
                    .map_err(|e| format!("设置冲突备份权限失败: {e}"))?;
            }
            if clear_conflict_keys_in_file(&path, probe)? {
                changed.push(format!("~/{}（备份已保存）", probe.file));
            } else {
                let _ = std::fs::remove_file(&backup);
            }
        }
    }
    Ok(changed)
}

/// 展开 auth 文件候选：(展示路径, 绝对路径)。`/*` 结尾 = 目录扫描（kimi credentials/<name>.json
/// 文件名随 provider 名变化）：只探直接子级 *.json，不进 mcp/ 等子目录（那是 MCP 服务器凭证，
/// 不算 CLI 登录态）；目录缺失/不可读 = 无候选（按未检出处理）。扫描结果按文件名排序保证稳定输出
fn auth_probe_candidates(
    home: &std::path::Path,
    oa: &crate::agent_specs::OfficialAccountSpec,
) -> Vec<(String, std::path::PathBuf)> {
    let mut out: Vec<(String, std::path::PathBuf)> = Vec::new();
    for rel in oa.auth_file_paths {
        if let Some(dir_rel) = rel.strip_suffix("/*") {
            let Ok(entries) = std::fs::read_dir(home.join(dir_rel)) else {
                continue;
            };
            let mut scanned: Vec<(String, std::path::PathBuf)> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file() && p.extension().is_some_and(|e| e == "json"))
                .map(|p| {
                    let display = format!(
                        "{dir_rel}/{}",
                        p.file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default()
                    );
                    (display, p)
                })
                .collect();
            scanned.sort_by(|a, b| a.0.cmp(&b.0));
            out.extend(scanned);
        } else {
            out.push(((*rel).to_string(), home.join(rel)));
        }
    }
    out
}

/// 官方账号连接状态（P1a）。supported = 注册表有规格；connected = auth 文件检出凭证。
/// 断开不做文件删除——引导用户用 CLI 自己的 logout（前端文案）
fn official_login_env() -> std::collections::BTreeMap<String, String> {
    crate::settings::official_outbound_env()
        .into_iter()
        .collect()
}

/// 会跑 `claude auth status`（最多几秒）：不占主线程
#[tauri::command]
pub async fn official_account_status(agent_id: String) -> OfficialAccountStatusDto {
    let id = agent_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 官方别名对应的完整型号（Claude、Gemini）：CLI 版本变了才后台重测（model_aliases.rs）
        crate::model_aliases::refresh_in_background(&id);
        let mut st = official_account_status_sync(&id);
        // 已登录才读套餐：Claude Code 登出后 ~/.claude.json 里的 oauthAccount 可能还留着
        if st.connected {
            if let Some(home) = dirs::home_dir() {
                let (plan, email) = official_identity(&id, &home);
                st.plan = plan;
                st.email = st.email.take().or(email);
            }
        }
        st
    })
        .await
        .unwrap_or_else(|e| OfficialAccountStatusDto {
            supported: false,
            connected: false,
            detail: Some(format!("检测官方账号状态失败: {e}")),
            login_command: None,
            conflicts: Vec::new(),
            cleanup_supported: false,
            login_env: official_login_env(),
            plan: None,
            email: None,
        })
}

/// 套餐代号转人看的：claude_pro → Pro、plus → Plus；空串 None
fn plan_label(raw: &str) -> Option<String> {
    let s = raw.trim().trim_start_matches("claude_").replace('_', " ");
    let mut chars = s.chars();
    let first = chars.next()?;
    Some(first.to_uppercase().chain(chars).collect())
}

fn email_of(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|x| x.as_str()).map(str::trim).filter(|e| e.contains('@')).map(str::to_string)
}

/// ~/.claude.json 的 oauthAccount：(套餐 organizationType（claude_pro / claude_max …）, 邮箱 emailAddress)
fn claude_identity(v: &serde_json::Value) -> (Option<String>, Option<String>) {
    let Some(oa) = v.get("oauthAccount") else { return (None, None) };
    (
        oa.get("organizationType").and_then(|x| x.as_str()).and_then(plan_label),
        email_of(oa.get("emailAddress")),
    )
}

/// ~/.codex/auth.json：只解 tokens.id_token 的载荷段取 (chatgpt_plan_type, email)，令牌本身不出这个函数
fn codex_identity(v: &serde_json::Value) -> (Option<String>, Option<String>) {
    use base64::Engine as _;
    let claims = (|| {
        let token = v.get("tokens")?.get("id_token")?.as_str()?;
        let payload = token.split('.').nth(1)?;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload.trim_end_matches('='))
            .ok()?;
        serde_json::from_slice::<serde_json::Value>(&bytes).ok()
    })();
    let Some(claims) = claims else { return (None, None) };
    (
        claims
            .get("https://api.openai.com/auth")
            .and_then(|a| a.get("chatgpt_plan_type"))
            .and_then(|x| x.as_str())
            .and_then(plan_label),
        email_of(claims.get("email")),
    )
}

/// `cursor-agent status` 的「✓ Logged in as a@b.com」
fn cursor_email(line: &str) -> Option<String> {
    let rest = line.split("Logged in as").nth(1)?;
    let word = rest.split_whitespace().next()?;
    email_of(Some(&serde_json::Value::String(word.to_string())))
}

/// `cursor-agent about` 的「Subscription Tier   Free」「User Email   a@b.com」
fn cursor_about_identity(text: &str) -> (Option<String>, Option<String>) {
    let field = |name: &str| {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(name).map(|v| v.trim().to_string()))
            .filter(|v| !v.is_empty())
    };
    (
        field("Subscription Tier").as_deref().and_then(plan_label),
        email_of(field("User Email").map(serde_json::Value::String).as_ref()),
    )
}

/// ~/.grok/auth.json 是「issuer::id → 账号」的表，取第一个带 email 的账号
fn grok_email(v: &serde_json::Value) -> Option<String> {
    v.as_object()?.values().find_map(|acc| email_of(acc.get("email")))
}

/// ~/.grok/settings_cache.json 的 payload（JSON 字符串）里 settings.subscription_tier_display（缺了退 subscription_tier）
fn grok_plan(v: &serde_json::Value) -> Option<String> {
    let payload: serde_json::Value = serde_json::from_str(v.get("payload")?.as_str()?).ok()?;
    let st = payload.get("settings")?;
    ["subscription_tier_display", "subscription_tier"]
        .iter()
        .find_map(|k| st.get(*k).and_then(|x| x.as_str()))
        .and_then(plan_label)
}

/// 已登录账号的 (套餐, 邮箱)：各家实测过的来源（2026-10-28 本机核对）；读不到的就 None，不猜。
/// Gemini 本地只存当前账号邮箱，套餐（Code Assist 档位）要联网问，不取
fn official_identity(agent_id: &str, home: &std::path::Path) -> (Option<String>, Option<String>) {
    let read = |rel: &str| -> Option<serde_json::Value> {
        serde_json::from_str(&std::fs::read_to_string(home.join(rel)).ok()?).ok()
    };
    match agent_id {
        "claude-code" => read(".claude.json").map(|v| claude_identity(&v)).unwrap_or_default(),
        "codex" => read(".codex/auth.json").map(|v| codex_identity(&v)).unwrap_or_default(),
        "grok" => (
            read(".grok/settings_cache.json").and_then(|v| grok_plan(&v)),
            read(".grok/auth.json").and_then(|v| grok_email(&v)),
        ),
        "gemini" => (
            None,
            read(".gemini/google_accounts.json").and_then(|v| email_of(v.get("active"))),
        ),
        "cursor" => resolve_binary("cursor-agent")
            .and_then(|p| cli_output_with_timeout(&p, &["about"], std::time::Duration::from_secs(10)))
            .map(|t| cursor_about_identity(&t))
            .unwrap_or_default(),
        _ => (None, None),
    }
}

fn official_account_status_sync(agent_id: &str) -> OfficialAccountStatusDto {
    // 登录凭证在文件里、下面的凭证检查会提前返回：先顺手缓存官方模型名单（单测不跑真 CLI、不写本机缓存）
    if agent_id == "grok" && !cfg!(test) {
        if let Some(path) = resolve_binary("grok") {
            let has_login = dirs::home_dir().is_some_and(|h| h.join(".grok/auth.json").is_file());
            if has_login {
                // 要连 x.ai：带上设置里的出网代理（与官方启动同口径）
                refresh_official_models_cache("grok", || {
                    cli_output_with_env(&path, &["models"], &crate::settings::official_outbound_env(), std::time::Duration::from_secs(20))
                        .map(|t| parse_grok_models(&t))
                        .unwrap_or_default()
                });
            }
        }
    }
    let login_env = official_login_env();
    let Some(spec) = agent_spec(agent_id) else {
        return OfficialAccountStatusDto {
            supported: false,
            connected: false,
            detail: Some(format!("未知 agent: {agent_id}")),
            login_command: None,
            conflicts: Vec::new(),
            cleanup_supported: false,
            login_env,
            plan: None,
            email: None,
        };
    };
    let Some(oa) = spec.official_account.as_ref() else {
        return OfficialAccountStatusDto {
            supported: false,
            connected: false,
            detail: Some("该 CLI 暂未接入官方账号（不支持或无官方账号语义）".into()),
            login_command: None,
            conflicts: Vec::new(),
            cleanup_supported: false,
            login_env,
            plan: None,
            email: None,
        };
    };
    // login_cmd 为空 = 裸启动 CLI 后在 TUI 内登录（gemini / qwen）
    let login_command = Some(
        std::iter::once(spec.binary)
            .chain(oa.login_cmd.iter().copied())
            .collect::<Vec<_>>()
            .join(" "),
    );
    let home = dirs::home_dir();
    // 冲突探测与连接状态无关：未登录时残留的 API 配置同样值得告警
    let conflicts = home
        .as_ref()
        .map(|h| probe_conflicts(h, oa))
        .unwrap_or_default();
    let mut unrecognized: Option<String> = None;
    let mut api_key_mode: Option<String> = None;
    let mut corrupt: Option<String> = None;
    let candidates = home
        .as_ref()
        .map(|h| auth_probe_candidates(h, oa))
        .unwrap_or_default();
    for (rel, path) in &candidates {
        match probe_auth_file(path, oa.api_key_fields) {
            Some(AuthProbe::Connected) => {
                return OfficialAccountStatusDto {
                    supported: true,
                    connected: true,
                    detail: Some(format!("已检测到登录凭证（~/{rel}）{}", official_connected_caveat(agent_id))),
                    login_command,
                    conflicts,
                    cleanup_supported: oa.conflict_probes.iter().all(|probe| {
                        probe.file.ends_with(".json")
                            || probe.file.ends_with(".env")
                            || probe.file.ends_with(".toml")
                    }),
                    login_env: login_env.clone(),
                    plan: None,
                    email: None,
                };
            }
            Some(AuthProbe::Unrecognized) => {
                if unrecognized.is_none() {
                    unrecognized = Some(rel.clone());
                }
            }
            Some(AuthProbe::ApiKeyMode) => {
                if api_key_mode.is_none() {
                    api_key_mode = Some(rel.clone());
                }
            }
            Some(AuthProbe::Corrupt) => {
                if corrupt.is_none() {
                    corrupt = Some(rel.clone());
                }
            }
            None => {}
        }
    }
    if agent_id == "cursor" {
        if let Some(path) = resolve_binary("cursor-agent") {
            let status = cli_output_with_timeout(&path, &["status"], std::time::Duration::from_secs(8));
            if let Some(line) = status.as_deref().and_then(|t| t.lines().find(|l| l.contains("Logged in"))) {
                refresh_official_models_cache("cursor", || {
                    cli_output_with_timeout(&path, &["models"], std::time::Duration::from_secs(20))
                        .map(|t| parse_cursor_models(&t))
                        .unwrap_or_default()
                });
                return OfficialAccountStatusDto {
                    supported: true,
                    connected: true,
                    detail: Some(format!("cursor-agent status：{}", line.trim().trim_start_matches('✓').trim())),
                    // 邮箱只进悬停提示，界面上不常驻
                    login_command,
                    conflicts,
                    cleanup_supported: true,
                    login_env,
                    plan: None,
                    email: cursor_email(line),
                };
            }
        }
    }
    let mut cli_says_logged_out: Option<&str> = None;
    if agent_id == "claude-code" {
        if let Some((logged_in, method)) = claude_auth_status() {
            if !logged_in {
                cli_says_logged_out = Some("claude auth status 显示未登录（登录已过期或已登出），点「官方登录」重登");
            }
            if logged_in {
                return OfficialAccountStatusDto {
                    supported: true,
                    connected: true,
                    detail: Some(format!("claude auth status 显示已登录（{method}）")),
                    login_command,
                    conflicts,
                    cleanup_supported: true,
                    login_env,
                    plan: None,
                    email: None,
                };
            }
        }
    }
    let detail = if let Some(msg) = cli_says_logged_out {
        msg.to_string()
    } else if let Some(rel) = corrupt {
        format!("~/{rel} 存在但无法解析（文件可能损坏）")
    } else if let Some(rel) = api_key_mode {
        // API Key 模式不是官方账号：官方 --api-key 与第三方中转（如 cc-switch）写出的
        // 文件形状相同，文件层面无法区分，如实说明而不显示「已连接官方账号」
        format!("~/{rel} 是 API Key 配置（可能来自官方 --api-key 或第三方中转），不是官方账号登录")
    } else if let Some(rel) = unrecognized {
        format!("~/{rel} 存在但未识别到凭证字段（格式可能随版本变化）")
    } else {
        match oa.detection_note {
            Some(note) => format!("未检测到凭证文件；{note}"),
            None => "未检测到凭证文件".into(),
        }
    };
    OfficialAccountStatusDto {
        supported: true,
        connected: false,
        detail: Some(detail),
        login_command,
        conflicts,
        cleanup_supported: oa.conflict_probes.iter().all(|probe| {
            probe.file.ends_with(".json")
                || probe.file.ends_with(".env")
                || probe.file.ends_with(".toml")
        }),
        login_env,
        plan: None,
        email: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_config_provider_names_parses_table() {
        let text = "model = \"gpt-5\"\n\n[model_providers.custom]\nbase_url = \"https://a\"\n\n[model_providers.ccode]\nrequires_openai_auth = true\n";
        assert_eq!(codex_config_provider_names(text), vec!["custom", "ccode"]);
        assert!(codex_config_provider_names("").is_empty());
        assert!(codex_config_provider_names("not toml [[[").is_empty());
        assert!(codex_config_provider_names("model = \"gpt-5\"\n").is_empty());
        // provider 上的 http_headers 客户端加载失败，不当成已注册
        let stale = "[model_providers.ccode-x]\nbase_url = \"https://a\"\n\n[model_providers.ccode-x.http_headers]\nAuthorization = \"Bearer sk\"\n";
        assert!(codex_config_provider_names(stale).is_empty());
    }

    fn profile(agent: &str, base_url: Option<&str>) -> Profile {
        Profile {
            id: "test".into(),
            agent: agent.into(),
            name: "测试".into(),
            account_type: Default::default(),
            no_auth: false,
            protocol: None,
            api_backend: None,
            base_url: base_url.map(|s| s.into()),
            models: vec![],
            role_models: Default::default(),
            extra_env: std::collections::HashMap::new(),
            request_policy: crate::profiles::RequestPolicy::default(),
            key_hint: None,
            model: None,
            last_used_at: None,
            has_key: false,
            gateway_id: None,
            slot_missing: false,
            connection_status: String::new(),
            model_sync_status: String::new(),
            model_sync_note: None,
            provider_override: None,
        }
    }

    thread_local! {
        pub(super) static TEST_SHARED_ENV: std::cell::RefCell<std::collections::BTreeMap<String, String>> =
            const { std::cell::RefCell::new(std::collections::BTreeMap::new()) };
        pub(super) static TEST_CODEX_CONFIG: std::cell::RefCell<Option<toml::Value>> =
            const { std::cell::RefCell::new(None) };
        pub(super) static TEST_CLAUDE_TOP_KEYS: std::cell::RefCell<Vec<String>> =
            const { std::cell::RefCell::new(Vec::new()) };
        pub(super) static TEST_CLAUDE_TOP_MODEL: std::cell::RefCell<Option<String>> =
            const { std::cell::RefCell::new(None) };
        pub(super) static TEST_OFFICIAL_MODELS: std::cell::RefCell<Vec<String>> =
            const { std::cell::RefCell::new(Vec::new()) };
        pub(super) static TEST_KIMI_CONFIG: std::cell::RefCell<Option<String>> =
            const { std::cell::RefCell::new(None) };
        pub(super) static TEST_CLAUDE_USER_KEYS: std::cell::RefCell<Vec<String>> =
            const { std::cell::RefCell::new(Vec::new()) };
        // 默认当作已选 API Key（其余 gemini 单测测的是注入本身）
        pub(super) static TEST_GEMINI_AUTH: std::cell::RefCell<Option<String>> =
            std::cell::RefCell::new(Some("gemini-api-key".into()));
    }

    #[test]
    fn gemini_api_binding_refuses_when_cli_auth_ignores_env() {
        // 端到端实测：oauth-personal 时 Mesa 注入的密钥和地址全被无视；没选认证方式但带地址时 CLI 报 Invalid auth
        assert!(gemini_auth_blocker_for(Some("oauth-personal"), true, false).unwrap().contains("Google 账号"));
        assert!(gemini_auth_blocker_for(None, true, false).is_some());
        assert!(gemini_auth_blocker_for(Some("gemini-api-key"), true, true).is_none());
        // 无头运行不带地址：环境变量兜底就够，不拦
        assert!(gemini_auth_blocker_for(None, false, false).is_none(), "官方 Gemini API（不带地址）无头靠环境变量就行");
        // 在终端里起、刚装好没选过认证方式：不带地址也拦（第一次进门先问认证、再要存钥匙串，2026-10-27 空 HOME 实录）
        let fresh = gemini_auth_blocker_for(None, false, true).unwrap();
        assert!(fresh.contains("还没选认证方式") && fresh.contains(GEMINI_AUTH_MARK));
        assert!(gemini_auth_blocker_for(Some("oauth-personal"), false, true).unwrap().contains(GEMINI_AUTH_MARK));
        // 前端按这句认卡（src/terminal-wait.ts GEMINI_AUTH_MARK）：两边同字
        let ts = include_str!("../../src/terminal-wait.ts");
        assert!(ts.contains(&format!("GEMINI_AUTH_MARK = \"{GEMINI_AUTH_MARK}\"")));
        let p = profile("gemini", Some("https://gw.example"));
        TEST_GEMINI_AUTH.with(|k| *k.borrow_mut() = Some("oauth-personal".into()));
        let err = launch_plan(&p, Some("sk".into()), Some("m")).unwrap_err();
        TEST_GEMINI_AUTH.with(|k| *k.borrow_mut() = Some("gemini-api-key".into()));
        assert!(err.contains("设为全局默认"));
    }

    #[test]
    fn claude_fills_empty_slots_and_blocks_global_leaks() {
        // 两个模型的绑定：HAIKU / FABLE 槽原先空着，用户全局的 glm-5.3 会漏进会话标题、小模型任务
        let mut p = profile("claude-code", Some("https://gw.example/anthropic"));
        p.models = vec!["m1".into(), "m2".into()];
        let plan = launch_plan(&p, Some("sk".into()), Some("m2")).unwrap();
        let settings = read_settings_override(&plan);
        assert_eq!(settings["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"], "m1");
        assert_eq!(settings["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"], "m2");
        assert_eq!(settings["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "m2", "空槽用这次选的模型补");
        assert_eq!(settings["env"]["ANTHROPIC_DEFAULT_FABLE_MODEL"], "m2");
        assert_eq!(settings["env"]["ANTHROPIC_SMALL_FAST_MODEL"], "m2");
        // 用户全局没设子 agent 模型：不盖，保留 Claude 原生继承
        assert!(settings["env"].get("CLAUDE_CODE_SUBAGENT_MODEL").is_none());
        // 用户全局设了（实测会把子 agent 请求带到全局模型上）：盖成这次的模型；上下文窗口写回默认 200K
        TEST_CLAUDE_USER_KEYS.with(|k| {
            *k.borrow_mut() = vec![
                "CLAUDE_CODE_SUBAGENT_MODEL".into(),
                "CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(),
            ]
        });
        let plan = launch_plan(&p, Some("sk".into()), Some("m2")).unwrap();
        TEST_CLAUDE_USER_KEYS.with(|k| k.borrow_mut().clear());
        let settings = read_settings_override(&plan);
        assert_eq!(settings["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], "m2");
        assert_eq!(settings["env"]["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "200000");
        assert_eq!(settings["env"]["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "200000");
    }

    #[test]
    fn role_models_route_small_and_subagent_per_agent() {
        let roles = crate::profiles::RoleModels {
            small: Some("cheap".into()),
            subagent: Some("sub".into()),
        };
        // Claude：haiku 槽 + SMALL_FAST 用后台小模型；子 Agent 显式写
        let mut p = profile("claude-code", Some("https://gw.example/anthropic"));
        p.models = vec!["main".into(), "cheap".into(), "sub".into()];
        p.role_models = roles.clone();
        let plan = launch_plan(&p, Some("sk".into()), Some("main")).unwrap();
        let settings = read_settings_override(&plan);
        assert_eq!(settings["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "cheap");
        assert_eq!(settings["env"]["ANTHROPIC_SMALL_FAST_MODEL"], "cheap");
        assert_eq!(settings["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], "sub");
        // Grok：会话标题 / 输入提示钉到后台小模型；没指定时钉主模型（防用户全局指到别家网关）
        let mut g = profile("grok", Some("https://gw.example/v1"));
        g.models = vec!["main".into(), "cheap".into()];
        g.role_models = roles.clone();
        let overlay = grok_config_overlay(&g, Some("main")).unwrap();
        assert_eq!(overlay["models"]["session_summary"], "cheap");
        assert_eq!(overlay["models"]["prompt_suggestion"], "cheap");
        g.role_models = Default::default();
        let overlay = grok_config_overlay(&g, Some("main")).unwrap();
        assert_eq!(overlay["models"]["session_summary"], "main");
        // OpenCode：small_model
        let mut o = profile("opencode", Some("https://gw.example/v1"));
        o.models = vec!["main".into(), "cheap".into()];
        o.role_models = roles;
        let plan = launch_plan(&o, Some("sk".into()), Some("main")).unwrap();
        let cfg: serde_json::Value = serde_json::from_str(
            &plan.env.iter().find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT").unwrap().1,
        )
        .unwrap();
        assert!(cfg["small_model"].as_str().unwrap().ends_with("/cheap"));
    }

    #[test]
    fn claude_skips_thinking_for_models_declared_non_thinking() {
        // deepseek-chat 内置能力表确知不会思考：不发 adaptive thinking（不收的网关会 400）
        let mut p = profile("claude-code", Some("https://gw.example/anthropic"));
        p.models = vec!["deepseek-chat".into()];
        let plan = launch_plan(&p, Some("sk".into()), Some("deepseek-chat")).unwrap();
        let settings = read_settings_override(&plan);
        assert_eq!(settings["env"]["MAX_THINKING_TOKENS"], "0");
        let mut p = profile("claude-code", Some("https://gw.example/anthropic"));
        p.models = vec!["glm-5.3".into()];
        let plan = launch_plan(&p, Some("sk".into()), Some("glm-5.3")).unwrap();
        assert!(read_settings_override(&plan)["env"].get("MAX_THINKING_TOKENS").is_none());
    }

    /// 手动跑的端到端核对（2026-10-17 用户：查清各家 CLI 里 Mesa 能否正确配置模型）：
    /// 按假网关地址给每家生成真实启动计划，写成 JSON，由 scripts/e2e-model-routing/drive.py 拿去真起 CLI，
    /// 看请求里带的模型、打到的路径对不对。`E2E_BASE=http://127.0.0.1:端口 E2E_OUT=计划.json
    /// cargo test --lib e2e_dump_launch_plans -- --ignored`
    #[test]
    #[ignore = "手动跑：配合 scripts/e2e-model-routing/"]
    fn e2e_dump_launch_plans() {
        let base = std::env::var("E2E_BASE").expect("E2E_BASE");
        let out = std::env::var("E2E_OUT").expect("E2E_OUT");
        // 测试态 Codex 版本默认取桩（None = 当旧版）：端到端要按本机真实版本拼参数（--no-daemon、计划工具）
        CODEX_VERSION_FOR_TEST.with(|c| c.set(cli_version_uncached_ok("codex")));
        // (agent, 协议, base_url 后缀)：Anthropic 协议的 base 不带 /v1（CLI 自己拼 /v1/messages），
        // OpenAI / Responses 协议带 /v1，Gemini 由 CLI 拼 /v1beta
        let cases: [(&str, Option<&str>, &str); 9] = [
            ("claude-code", None, ""),
            ("codebuddy", None, "/v1"),
            ("codex", None, "/v1"),
            ("qwen", Some("openai"), "/v1"),
            ("kimi", Some("openai"), "/v1"),
            ("opencode", None, "/v1"),
            ("grok", None, "/v1"),
            ("gemini", None, ""),
            ("cursor", None, ""),
        ];
        let mut all = serde_json::Map::new();
        for (agent, proto, suffix) in cases {
            let mut p = profile(agent, Some(&format!("{base}/{agent}{suffix}")));
            // 端到端要看真实机器上的全局配置会不会漏进来：读本机 ~/.claude/settings.json 的键名
            let keys = read_claude_user_settings_env_keys(&p);
            TEST_CLAUDE_USER_KEYS.with(|k| *k.borrow_mut() = keys);
            p.protocol = proto.map(Into::into);
            p.name = "E2E".into();
            p.models = vec!["e2e-default".into(), "e2e-picked".into()];
            // E2E_SMALL=e2e-default：核对「模型分工」的后台小模型是否真被用于标题 / 摘要
            if let Ok(small) = std::env::var("E2E_SMALL") {
                p.role_models.small = Some(small);
            }
            // E2E_EFFORT=high：同时核对思考档在各家线上的形态（别家模型能不能吃到）
            if let Ok(effort) = std::env::var("E2E_EFFORT") {
                p.request_policy.reasoning_effort = Some(effort);
            }
            let plan = launch_plan(&p, Some("sk-e2e-test".into()), Some("e2e-picked"));
            all.insert(
                agent.into(),
                match plan {
                    Ok(plan) => {
                        // 启动前准备追加的参数（Codex 的模型目录 catalog、计划工具、--no-daemon），同 pty.rs：
                        // 接在计划参数（含权限档）后面——缺了它端到端和金丝雀核对的就不是 Mesa 真实的启动
                        // （2026-10-21：catalog 的提示词与 update_plan 都没被核对到）
                        let extra = prepare_launch(&p).unwrap_or_default();
                        let with_extra = |mut a: Vec<String>| {
                            a.extend(extra.iter().cloned());
                            a
                        };
                        // 聊天层权限四档的启动参数（pty.rs 同一处拼法），第三期逐家抓屏用；
                        // 只讨论走 readonly_args（2026-10-26 补：Claude 计划模式出完方案后的「要不要开工」菜单要抓）
                        let mut tiers: serde_json::Map<String, serde_json::Value> = ["ask", "auto", "full"]
                            .iter()
                            .filter_map(|m| {
                                permission_launch_args(agent, &plan.args, m)
                                    .map(|a| ((*m).to_string(), serde_json::json!(with_extra(a))))
                            })
                            .collect();
                        // 要看版本的家（Qwen / OpenCode）测试态查不到版本：设 MESA_E2E_REAL_CLI=1 按本机版本出
                        let mut discuss_env = plan.env.clone();
                        if let Some(a) = readonly_launch_args(agent, &plan.args) {
                            tiers.insert("discuss".into(), serde_json::json!(with_extra(a)));
                            readonly_launch_env(agent, &mut discuss_env);
                        }
                        serde_json::json!({
                            "env": plan.env,
                            "args": with_extra(plan.args.clone()),
                            "env_remove": plan.env_remove,
                            "permission": tiers,
                            // 只讨论另加的环境（OpenCode 计划模式开关与 plan agent 权限，readonly_launch_env）
                            "discuss_env": discuss_env,
                        })
                    }
                    Err(e) => serde_json::json!({ "error": e }),
                },
            );
        }
        std::fs::write(out, serde_json::to_string_pretty(&all).unwrap()).unwrap();
    }

    #[test]
    fn claude_non_claude_model_turns_off_tool_search() {
        let mut p = profile("claude-code", Some("https://open.bigmodel.cn/api/anthropic"));
        p.models = vec!["glm-5.3-flash".into()];
        let env = claude_model_env(&p, Some("glm-5.3-flash"), &[]);
        assert!(env.contains(&("ENABLE_TOOL_SEARCH".into(), "false".into())));
        assert!(env.contains(&("CLAUDE_CODE_ENABLE_TODO_TOOLS".into(), "1".into())));
        // Claude 自家模型照 Claude Code 默认；用户自己设过不动
        let env = claude_model_env(&p, Some("claude-sonnet-4-5"), &[]);
        assert!(!env.iter().any(|(k, _)| k == "ENABLE_TOOL_SEARCH" || k == "CLAUDE_CODE_ENABLE_TODO_TOOLS"));
        let env = claude_model_env(&p, Some("glm-5.3"), &["ENABLE_TOOL_SEARCH".into(), "CLAUDE_CODE_ENABLE_TODO_TOOLS".into()]);
        assert!(!env.iter().any(|(k, _)| k == "ENABLE_TOOL_SEARCH" || k == "CLAUDE_CODE_ENABLE_TODO_TOOLS"));
    }

    #[test]
    fn claude_plan_registers_models_into_picker() {
        let mut p = profile("claude-code", None);
        p.models = vec![
            "m1".into(),
            "m2".into(),
            "m3".into(),
            "m4".into(),
            "m5".into(),
        ];
        let plan = launch_plan(&p, None, Some("m1")).unwrap();
        assert!(plan
            .env
            .contains(&("ANTHROPIC_DEFAULT_SONNET_MODEL".into(), "m1".into())));
        // _NAME 槽是选择器显示名：带 profile 名（配置名 · 模型）
        assert!(plan.env.contains(&(
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME".into(),
            "测试 · m2".into()
        )));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_DEFAULT_HAIKU_MODEL".into(), "m3".into())));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_DEFAULT_FABLE_MODEL".into(), "m4".into())));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_CUSTOM_MODEL_OPTION".into(), "m5".into())));
        assert!(plan.env.contains(&(
            "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".into(),
            "测试 · m5".into()
        )));
        // 用户全局没设子 agent 模型时，不被 Mesa 固定到绑定列表中的任意模型，保留 Claude 原生选择链
        assert!(!plan
            .env
            .iter()
            .any(|(k, _)| k == "CLAUDE_CODE_SUBAGENT_MODEL"));
        // --settings 现在传的是 0600 临时文件的路径（密钥不进 argv），内容从文件读回
        let settings = read_settings_override(&plan);
        assert_eq!(settings["env"]["ANTHROPIC_MODEL"], "m1");
        assert_eq!(settings["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "m3");
    }

    /// 取 `--settings` 覆盖层的内容：参数是文件路径，读回并解析（测试用）
    fn read_settings_override(plan: &LaunchPlan) -> serde_json::Value {
        let path = plan
            .args
            .windows(2)
            .find(|pair| pair[0] == "--settings")
            .map(|pair| pair[1].clone())
            .expect("启动计划里应有 --settings");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("读不到设置覆盖文件 {path}: {e}"));
        serde_json::from_str(&text).expect("设置覆盖文件不是合法 JSON")
    }

    #[test]
    fn claude_plan_declares_context_over_200k() {
        // 注册链确知 >200K（kimi-k3 = 1M 内置表）→ 成对注入 MAX_CONTEXT_TOKENS +
        // AUTO_COMPACT_WINDOW（同值）；未知模型（兜底 128K）两个都不注入
        let mut p = profile("claude-code", None);
        p.models = vec!["kimi-k3".into()];
        let plan = launch_plan(&p, None, Some("kimi-k3")).unwrap();
        assert!(plan
            .env
            .contains(&("CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(), "1048576".into())));
        assert!(plan
            .env
            .contains(&("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), "1048576".into())));
        let mut p2 = profile("claude-code", None);
        p2.models = vec!["unknown-model".into()];
        let plan2 = launch_plan(&p2, None, Some("unknown-model")).unwrap();
        assert!(!plan2
            .env
            .iter()
            .any(|(k, _)| k == "CLAUDE_CODE_MAX_CONTEXT_TOKENS"
                || k == "CLAUDE_CODE_AUTO_COMPACT_WINDOW"));
        // 不再注入子 agent 覆盖
        assert!(!plan2
            .env
            .iter()
            .any(|(k, _)| k == "CLAUDE_CODE_SUBAGENT_MODEL"));
    }

    #[test]
    fn extra_env_appended_last_for_override() {
        let mut p = profile("claude-code", Some("https://relay.example.com"));
        p.extra_env
            .insert("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into());
        p.extra_env.insert(
            "ANTHROPIC_BASE_URL".into(),
            "https://override.example.com".into(),
        );
        let plan = launch_plan(&p, None, None).unwrap();
        assert!(plan
            .env
            .contains(&("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into())));
        // 与 adapter 内置值重复时，extra_env 排在后面（CommandBuilder 后者生效）
        let last = plan
            .env
            .iter()
            .rposition(|(k, _)| k == "ANTHROPIC_BASE_URL")
            .unwrap();
        assert_eq!(plan.env[last].1, "https://override.example.com");
    }

    #[test]
    fn claude_plan_sets_only_present_fields() {
        let p = profile("claude-code", Some("https://relay.example.com"));
        let plan = launch_plan(&p, Some("sk-secret".into()), None).unwrap();
        assert!(plan.args.windows(2).any(|pair| pair[0] == "--settings"));
        assert!(plan.env.contains(&(
            "ANTHROPIC_BASE_URL".into(),
            "https://relay.example.com".into()
        )));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_AUTH_TOKEN".into(), "sk-secret".into())));
        // 2026-09-27：base_url 与 token 必须在 --settings 层成对出现。只提 base_url 会让
        // 磁盘 ~/.claude/settings.json 里残留的旧 token 胜出，请求带着别家令牌打到本网关（401）。
        let settings = read_settings_override(&plan);
        assert_eq!(settings["env"]["ANTHROPIC_BASE_URL"], "https://relay.example.com");
        assert_eq!(settings["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-secret");
        assert!(!plan.env.iter().any(|(k, _)| k == "ANTHROPIC_MODEL"));
    }

    #[test]
    fn claude_plan_without_key_omits_token() {
        let p = profile("claude-code", None);
        let plan = launch_plan(&p, None, Some("claude-sonnet-4")).unwrap();
        assert_eq!(plan.env.len(), 1);
        assert!(plan.args.windows(2).any(|pair| pair[0] == "--model"));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_MODEL".into(), "claude-sonnet-4".into())));
        // 无密钥时覆盖层也不该凭空造一个 token 键出来
        let settings = read_settings_override(&plan);
        assert!(settings["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
    }

    #[test]
    fn claude_request_policy_injects_verified_channels() {
        let mut p = profile("claude-code", None);
        p.request_policy.temperature = Some(0.7);
        p.request_policy.top_p = Some(0.9);
        p.request_policy.max_output_tokens = Some(8192);
        p.request_policy.reasoning_effort = Some("high".into());
        p.request_policy
            .header_env
            .insert("X-Region".into(), "MODEL_REGION".into());
        p.request_policy
            .header_env
            .insert("X-Miss".into(), "MISSING_VAR".into());
        let mut plan = LaunchPlan::default();
        apply_request_policy_env(&mut plan, "claude-code", &p.request_policy, &|k| {
            (k == "MODEL_REGION").then(|| "cn-1".to_string())
        });
        // temperature/top_p 合并进同一个 EXTRA_BODY JSON（只含填了的字段）
        let body = plan
            .env
            .iter()
            .find(|(k, _)| k == "CLAUDE_CODE_EXTRA_BODY")
            .map(|(_, v)| v.clone())
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["temperature"], 0.7);
        assert_eq!(v["top_p"], 0.9);
        assert!(plan
            .env
            .contains(&("CLAUDE_CODE_MAX_OUTPUT_TOKENS".into(), "8192".into())));
        assert!(plan
            .env
            .contains(&("CLAUDE_CODE_EFFORT_LEVEL".into(), "high".into())));
        // 解析不到的环境变量跳过该 header，不注空值
        assert!(plan
            .env
            .contains(&("ANTHROPIC_CUSTOM_HEADERS".into(), "X-Region: cn-1".into())));
    }

    #[test]
    fn codebuddy_request_policy_uses_own_prefix_and_skips_unverified() {
        let mut p = profile("codebuddy", None);
        p.request_policy.temperature = Some(0.7); // 无 EXTRA_BODY 通道：不注
        p.request_policy.max_output_tokens = Some(4096);
        p.request_policy.reasoning_effort = Some("high".into()); // unknown：不注
        p.request_policy
            .header_env
            .insert("X-Region".into(), "MODEL_REGION".into());
        let mut plan = LaunchPlan::default();
        apply_request_policy_env(&mut plan, "codebuddy", &p.request_policy, &|k| {
            (k == "MODEL_REGION").then(|| "cn-1".to_string())
        });
        assert_eq!(plan.env.len(), 2);
        assert!(plan
            .env
            .contains(&("CODEBUDDY_CODE_MAX_OUTPUT_TOKENS".into(), "4096".into())));
        assert!(plan
            .env
            .contains(&("CODEBUDDY_CUSTOM_HEADERS".into(), "X-Region: cn-1".into())));
    }

    #[test]
    fn codebuddy_launch_uses_current_effort_and_model_flags() {
        let mut p = profile("codebuddy", Some("https://relay.example.com/anthropic"));
        p.request_policy.reasoning_effort = Some("high".into());
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("m1")).unwrap();
        assert!(plan
            .args
            .windows(2)
            .any(|pair| pair[0] == "--model" && pair[1] == "m1"));
        assert!(plan
            .args
            .windows(2)
            .any(|pair| pair[0] == "--effort" && pair[1] == "high"));
    }

    #[test]
    fn request_policy_not_injected_for_unverified_agents_or_official() {
        // 未实证 agent（codex）：任何策略字段都不产生 env
        let mut p = profile("codex", None);
        p.request_policy.temperature = Some(0.2);
        let plan = launch_plan(&p, None, None).unwrap();
        assert!(!plan.env.iter().any(|(k, _)| {
            k.contains("EXTRA_BODY")
                || k.contains("EFFORT")
                || k.contains("CUSTOM_HEADERS")
                || k.contains("MAX_OUTPUT_TOKENS")
        }));
        // 官方账号模式：early-return 路径不经过策略注入
        let mut p = profile("claude-code", None);
        p.account_type = crate::profiles::AccountType::Official;
        p.request_policy.max_output_tokens = Some(8192);
        let plan = launch_plan(&p, None, None).unwrap();
        assert!(!plan
            .env
            .iter()
            .any(|(k, _)| k == "CLAUDE_CODE_MAX_OUTPUT_TOKENS"));
    }

    #[test]
    fn extra_env_overrides_policy_injection() {
        // 用户 extra_env 与策略注入同键时排在最后（CommandBuilder 后者生效）
        let mut p = profile("claude-code", None);
        p.request_policy.temperature = Some(0.7);
        p.extra_env.insert(
            "CLAUDE_CODE_EXTRA_BODY".into(),
            "{\"temperature\":0.1}".into(),
        );
        let plan = launch_plan(&p, None, None).unwrap();
        let last = plan
            .env
            .iter()
            .rposition(|(k, _)| k == "CLAUDE_CODE_EXTRA_BODY")
            .unwrap();
        assert_eq!(plan.env[last].1, "{\"temperature\":0.1}");
    }

    #[test]
    fn codex_request_policy_injects_effort_and_env_headers() {
        let mut p = profile("codex", Some("https://relay.example.com/v1"));
        p.request_policy.reasoning_effort = Some("high".into());
        p.request_policy.temperature = Some(0.2); // 无通道：不注
        p.request_policy
            .header_env
            .insert("X-Region".into(), "MODEL_REGION".into());
        let plan = launch_plan(&p, None, Some("gpt-x")).unwrap();
        assert!(plan
            .args
            .iter()
            .any(|a| a == r#"model_reasoning_effort="high""#));
        assert!(plan
            .args
            .iter()
            .any(|a| a == r#"model_providers.ccode.env_http_headers."X-Region"="MODEL_REGION""#));
        // 无 base_url = 无内联 provider 可挂，headers 不注；effort 是全局键照常
        let mut p2 = profile("codex", None);
        p2.request_policy
            .header_env
            .insert("X-Region".into(), "MODEL_REGION".into());
        let plan2 = launch_plan(&p2, None, None).unwrap();
        assert!(!plan2.args.iter().any(|a| a.contains("env_http_headers")));
    }

    #[test]
    fn opencode_request_policy_merges_into_inline_config() {
        let mut p = profile("opencode", Some("https://relay.example.com/v1"));
        p.models = vec!["m1".into()];
        p.request_policy.temperature = Some(0.3);
        p.request_policy.max_output_tokens = Some(4096);
        p.request_policy.reasoning_effort = Some("low".into());
        let plan = launch_plan(&p, None, Some("m1")).unwrap();
        let raw = plan
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .unwrap()
            .1
            .clone();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let opts = &v["provider"]["ccode"]["models"]["m1"]["options"];
        assert_eq!(opts["temperature"], 0.3);
        assert_eq!(opts["maxOutputTokens"], 4096);
        assert_eq!(opts["reasoningEffort"], "low");
        // headers 引用的环境变量未设置时不进配置（不落空值/密文）
        assert!(v["provider"]["ccode"]["options"].get("headers").is_none());
    }

    #[test]
    fn kimi_request_policy_effort_only_on_kimi_channel() {
        let mut p = profile("kimi", Some("https://api.moonshot.cn"));
        p.request_policy.reasoning_effort = Some("High".into());
        let plan = launch_plan(&p, None, Some("kimi-k3")).unwrap();
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_THINKING_EFFORT".into(), "high".into())));
        // anthropic 兼容通道该 env 被 CLI 静默忽略——干脆不注
        p.protocol = Some("anthropic".into());
        let plan = launch_plan(&p, None, Some("kimi-k3")).unwrap();
        assert!(!plan
            .env
            .iter()
            .any(|(k, _)| k == "KIMI_MODEL_THINKING_EFFORT"));
    }

    #[test]
    fn codebuddy_plan_injects_codebuddy_env() {
        let p = profile("codebuddy", Some("https://api.deepseek.com/anthropic"));
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("deepseek-v3-2-volc")).unwrap();
        assert!(plan.env.contains(&(
            "CODEBUDDY_BASE_URL".into(),
            "https://api.deepseek.com/anthropic".into()
        )));
        assert!(plan
            .env
            .contains(&("CODEBUDDY_API_KEY".into(), "sk-secret".into())));
        assert!(plan
            .env
            .contains(&("CODEBUDDY_MODEL".into(), "deepseek-v3-2-volc".into())));
        // 初始 prompt 是位置参数（一键开步注入）
        let plan = launch_plan_with_prompt(&p, Some("sk-secret".into()), None, Some("干活")).unwrap();
        assert_eq!(plan.prompt_args, vec!["干活"]);
    }

    #[test]
    fn codebuddy_official_plan_purges_api_env() {
        // 官方账号拉起：不注入 API env，且必须 env_remove 残留密钥变量（env 优先压账号，实测 401）
        let p = official_profile("codebuddy");
        let plan = launch_plan(&p, None, None).unwrap();
        assert!(!plan.env.iter().any(|(k, _)| k.starts_with("CODEBUDDY_")));
        assert!(plan.env_remove.contains(&"CODEBUDDY_API_KEY".to_string()));
        assert!(plan
            .env_remove
            .contains(&"CODEBUDDY_AUTH_TOKEN".to_string()));
    }

    #[test]
    fn grok_plan_injects_xai_env() {
        let mut p = profile("grok", Some("https://relay.example.com/v1"));
        p.models = vec!["grok-code-fast-1".into(), "grok-4.5".into()];
        let plan = launch_plan(&p, Some("xai-secret".into()), Some("grok-code-fast-1")).unwrap();
        assert!(plan.env.contains(&(
            "GROK_MODELS_BASE_URL".into(),
            "https://relay.example.com/v1".into()
        )));
        assert!(plan
            .env
            .contains(&("XAI_API_KEY".into(), "xai-secret".into())));
        assert!(plan
            .env
            .contains(&("GROK_DEFAULT_MODEL".into(), "grok-code-fast-1".into())));
        assert!(plan
            .args
            .windows(2)
            .any(|pair| pair[0] == "-m" && pair[1] == "grok-code-fast-1"));
        // 第三方网关：内置 web_search 拿网关钥匙去 xAI 鉴权必 401，关掉；xAI 官方地址保留
        assert!(plan.args.iter().any(|a| a == "--disable-web-search"));
        let mut official = p.clone();
        official.base_url = Some("https://api.x.ai/v1".into());
        let plan_official = launch_plan(&official, Some("xai-secret".into()), Some("grok-code-fast-1")).unwrap();
        assert!(!plan_official.args.iter().any(|a| a == "--disable-web-search"));
        // 模型列表经 GROK_CONFIG overlay 收敛进选择器（allowed_models）
        let grok_config = plan
            .env
            .iter()
            .find(|(k, _)| k == "GROK_CONFIG")
            .map(|(_, v)| v.clone())
            .expect("grok 有模型列表时必须注入 GROK_CONFIG");
        let v: serde_json::Value = serde_json::from_str(&grok_config).unwrap();
        assert_eq!(
            v["models"]["allowed_models"],
            serde_json::json!(["grok-code-fast-1", "grok-4.5"])
        );
        // overlay 同时把本次启动模型写成 [models].default：1.0.34 先拿 config 的 default 比对
        // allowed_models，不匹配就拒启动（GROK_DEFAULT_MODEL 偏好在之后才生效）
        assert_eq!(
            v["models"]["default"],
            serde_json::json!("grok-code-fast-1")
        );
        // 初始 prompt 是位置参数（一键开步注入）
        let plan = launch_plan_with_prompt(&p, Some("xai-secret".into()), None, Some("干活")).unwrap();
        assert_eq!(plan.prompt_args, vec!["干活"]);
        // 空模型列表不注入 GROK_CONFIG（allowed_models 空 = fail-closed 全不匹配）
        let empty = profile("grok", Some("https://relay.example.com/v1"));
        let plan = launch_plan(&empty, Some("xai-secret".into()), None).unwrap();
        assert!(!plan.env.iter().any(|(k, _)| k == "GROK_CONFIG"));
    }

    #[test]
    fn grok_plan_falls_back_to_first_binding_model() {
        // 未选模型时用绑定清单第一个兜底：防回落 config.toml 第一方默认直连 xAI 代理
        let mut p = profile("grok", Some("https://open.bigmodel.cn/api/paas/v4"));
        p.models = vec!["glm-5.3".into(), "glm-5.2".into()];
        let plan = launch_plan(&p, Some("k".into()), None).unwrap();
        assert!(plan
            .env
            .contains(&("GROK_DEFAULT_MODEL".into(), "glm-5.3".into())));
        assert!(plan
            .args
            .windows(2)
            .any(|pair| pair[0] == "-m" && pair[1] == "glm-5.3"));
    }

    #[test]
    fn grok_model_fallback_scoped_to_grok() {
        // 空模型清单不兜底（维持原行为）
        let empty = profile("grok", Some("https://relay.example.com/v1"));
        let plan = launch_plan(&empty, Some("k".into()), None).unwrap();
        assert!(!plan.env.iter().any(|(k, _)| k == "GROK_DEFAULT_MODEL"));
        assert!(!plan.args.iter().any(|a| a == "-m"));

        // 显式选模永远优先于兜底（不被清单第一个覆盖）
        let mut p = profile("grok", Some("https://open.bigmodel.cn/api/paas/v4"));
        p.models = vec!["glm-5.3".into(), "glm-5.2".into()];
        let plan = launch_plan(&p, Some("k".into()), Some("glm-5.2")).unwrap();
        assert!(plan
            .env
            .contains(&("GROK_DEFAULT_MODEL".into(), "glm-5.2".into())));
        assert!(!plan
            .env
            .contains(&("GROK_DEFAULT_MODEL".into(), "glm-5.3".into())));
    }

    #[test]
    fn grok_overlay_default_overrides_stale_global_default() {
        // 回归（2026-09-20 用户实机）：~/.grok/config.toml 的 [models].default 若是别家绑定
        // 「设为全局默认」留下的模型（本例 grok-4.6），1.0.34 会先拿它比对本次 allowed_models
        // 并直接拒启动。overlay 写 default=本次启动模型可让这道门通过。
        let mut p = profile("grok", Some("https://relay.example.com/v1"));
        p.models = vec!["deepseek-v4-flash-0731".into()];
        let overlay_of = |plan: &LaunchPlan| -> serde_json::Value {
            serde_json::from_str(
                &plan
                    .env
                    .iter()
                    .find(|(k, _)| k == "GROK_CONFIG")
                    .map(|(_, v)| v.clone())
                    .expect("有模型时必须注入 GROK_CONFIG"),
            )
            .unwrap()
        };
        // 显式选模
        let plan = launch_plan(&p, Some("k".into()), Some("deepseek-v4-flash-0731")).unwrap();
        let v = overlay_of(&plan);
        assert_eq!(
            v["models"]["default"],
            serde_json::json!("deepseek-v4-flash-0731")
        );
        assert_eq!(
            v["models"]["allowed_models"],
            serde_json::json!(["deepseek-v4-flash-0731"])
        );
        // 未选模型 → 兜底绑定清单第一个，default 与 -m 同为它
        let plan = launch_plan(&p, Some("k".into()), None).unwrap();
        let v = overlay_of(&plan);
        assert_eq!(
            v["models"]["default"],
            serde_json::json!("deepseek-v4-flash-0731")
        );
    }

    #[test]
    fn grok_empty_model_is_treated_as_unselected() {
        // 前端 buildAskAiPending 会带空串模型占位：必须按「未选」处理——兜底绑定清单第一个，
        // 不得把空串写进 GROK_DEFAULT_MODEL / allowed_models / [models].default
        let mut p = profile("grok", Some("https://relay.example.com/v1"));
        p.models = vec!["glm-5.3".into()];
        for empty in [Some(""), Some("   ")] {
            let plan = launch_plan(&p, Some("k".into()), empty).unwrap();
            assert!(
                plan.env
                    .contains(&("GROK_DEFAULT_MODEL".into(), "glm-5.3".into())),
                "空模型必须回落绑定清单第一个"
            );
            assert!(!plan.env.iter().any(|(_, v)| v.is_empty()));
            let v: serde_json::Value = serde_json::from_str(
                &plan
                    .env
                    .iter()
                    .find(|(k, _)| k == "GROK_CONFIG")
                    .map(|(_, v)| v.clone())
                    .expect("有模型时必须注入 GROK_CONFIG"),
            )
            .unwrap();
            assert_eq!(
                v["models"]["allowed_models"],
                serde_json::json!(["glm-5.3"])
            );
            assert_eq!(v["models"]["default"], serde_json::json!("glm-5.3"));
            assert!(plan
                .args
                .windows(2)
                .any(|pair| pair[0] == "-m" && pair[1] == "glm-5.3"));
        }
    }

    #[test]
    fn grok_non_default_backend_fails_closed_before_spawn() {
        let mut p = profile("grok", Some("https://relay.example.com/v1"));
        p.api_backend = Some("responses".into());
        assert!(validate_launch_compatibility(&p, None).is_err());
    }

    #[test]
    fn grok_model_config_match_requires_backend_and_endpoint() {
        let text = r#"
[model."kimi-k3"]
model = "kimi-k3"
base_url = "https://relay.example.com/v1"
api_backend = "responses"
"#;
        assert!(grok_model_config_matches(
            text,
            "kimi-k3",
            "responses",
            Some("https://relay.example.com/v1/")
        ));
        assert!(!grok_model_config_matches(
            text,
            "kimi-k3",
            "chat_completions",
            Some("https://relay.example.com/v1")
        ));
    }

    #[test]
    fn grok_overlay_carries_models_defaults_from_policy() {
        // 请求策略 → overlay [models] 全局默认（白名单实证只放行 [models] 全局块，
        // [model.<id>] 注不进）；注意键名 max_completion_tokens / default_reasoning_effort
        let mut p = profile("grok", Some("https://relay.example.com/v1"));
        p.request_policy.temperature = Some(0.7);
        p.request_policy.top_p = Some(0.95);
        p.request_policy.max_output_tokens = Some(8192);
        p.request_policy.reasoning_effort = Some("high".into());
        p.request_policy
            .header_env
            .insert("X-Tenant".into(), "TENANT_TOKEN".into());
        // 空模型列表 + 有策略：仍注入（overlay 不止 allowed_models 一个用途）
        let plan = launch_plan(&p, Some("xai-secret".into()), None).unwrap();
        let grok_config = plan
            .env
            .iter()
            .find(|(k, _)| k == "GROK_CONFIG")
            .map(|(_, v)| v.clone())
            .expect("有请求策略时必须注入 GROK_CONFIG");
        let v: serde_json::Value = serde_json::from_str(&grok_config).unwrap();
        // 无模型列表 → 不注 allowed_models（fail-closed 全不匹配）
        assert!(v["models"].get("allowed_models").is_none());
        assert_eq!(v["models"]["temperature"], serde_json::json!(0.7));
        assert_eq!(v["models"]["top_p"], serde_json::json!(0.95));
        assert_eq!(
            v["models"]["max_completion_tokens"],
            serde_json::json!(8192)
        );
        assert_eq!(
            v["models"]["default_reasoning_effort"],
            serde_json::json!("high")
        );
        // Header 是 $VAR 引用（grok 进程内展开），密文不进 env 值
        assert_eq!(
            v["models"]["extra_headers"],
            serde_json::json!({ "X-Tenant": "$TENANT_TOKEN" })
        );
        p.request_policy.reasoning_effort = Some("hign/xhign".into());
        let plan = launch_plan(&p, Some("xai-secret".into()), Some("gpt-6-sol")).unwrap();
        let grok_config = plan
            .env
            .iter()
            .find(|(k, _)| k == "GROK_CONFIG")
            .map(|(_, v)| v.clone())
            .expect("温度等策略仍在，overlay 还要注入");
        let v: serde_json::Value = serde_json::from_str(&grok_config).unwrap();
        assert!(v["models"].get("default_reasoning_effort").is_none());
        assert!(!plan.args.iter().any(|a| a == "--reasoning-effort"));
        // 无策略、无模型 → 完全不注
        let bare = profile("grok", Some("https://relay.example.com/v1"));
        let plan = launch_plan(&bare, None, None).unwrap();
        assert!(!plan.env.iter().any(|(k, _)| k == "GROK_CONFIG"));
    }

    #[test]
    fn grok_official_plan_purges_api_env() {
        // 官方账号拉起：不注入 API env，且必须 env_remove 残留密钥变量（凭证优先级 api_key > env_key > 登录 token）
        let p = official_profile("grok");
        let plan = launch_plan(&p, None, None).unwrap();
        assert!(!plan
            .env
            .iter()
            .any(|(k, _)| k.starts_with("XAI_") || k.starts_with("GROK_")));
        assert!(plan.env_remove.contains(&"XAI_API_KEY".to_string()));
        assert!(plan
            .env_remove
            .contains(&"GROK_CODE_XAI_API_KEY".to_string()));
    }

    #[test]
    fn cursor_plan_injects_key_endpoint_env_and_model_flag() {
        let p = profile("cursor", Some("https://api2.cursor.sh"));
        let plan = launch_plan(
            &p,
            Some("key-secret".into()),
            Some("claude-opus-4-8[context=1m,effort=high]"),
        ).unwrap();
        assert!(plan
            .env
            .contains(&("CURSOR_API_KEY".into(), "key-secret".into())));
        assert!(plan.env.contains(&(
            "CURSOR_API_ENDPOINT".into(),
            "https://api2.cursor.sh".into()
        )));
        // 模型走 --model flag（bracket 参数化原样透传），不是 env
        assert_eq!(
            plan.args,
            vec!["--model", "claude-opus-4-8[context=1m,effort=high]"]
        );
        assert!(!plan.env.iter().any(|(k, _)| k.contains("MODEL")));
        // 空字段不注入：无 base_url/密钥/模型时 env 与 args 都为空
        let bare = launch_plan(&profile("cursor", None), None, None).unwrap();
        assert!(bare.env.is_empty());
        assert!(bare.args.is_empty());
        // 初始 prompt 是位置参数（一键开步注入）
        let plan = launch_plan_with_prompt(&p, Some("key-secret".into()), None, Some("干活")).unwrap();
        assert_eq!(plan.prompt_args, vec!["干活"]);
        assert!(!plan.prompt_dropped);
    }

    #[test]
    fn cursor_plan_rejects_gateway_key_on_third_party_endpoint() {
        let p = profile("cursor", Some("https://open.bigmodel.cn/api/paas/v4"));
        let err = launch_plan(&p, Some("gateway-key".into()), Some("glm-5.3")).unwrap_err();
        assert!(err.contains("官方账号"));
        assert!(err.contains("cursor-agent login"));
    }

    #[test]
    fn cursor_official_plan_purges_key_but_keeps_model_flag() {
        // 官方账号拉起：不注入 CURSOR_API_KEY（且 env_remove 残留），模型 flag 照常可用
        let p = official_profile("cursor");
        let plan = launch_plan(&p, Some("key-secret".into()), Some("gpt-5")).unwrap();
        assert!(!plan.env.iter().any(|(k, _)| k.starts_with("CURSOR_")));
        assert_eq!(plan.args, vec!["--model", "gpt-5"]);
        assert!(plan.env_remove.contains(&"CURSOR_API_KEY".to_string()));
        // 模型为空：无任何参数
        let bare = launch_plan(&p, None, None).unwrap();
        assert!(bare.args.is_empty());
        assert!(bare.env.is_empty());
    }

    #[test]
    fn permission_launch_args_per_agent() {
        assert_eq!(
            permission_launch_args("claude-code", &[], "full").unwrap(),
            vec!["--permission-mode", "bypassPermissions"]
        );
        assert_eq!(
            permission_launch_args("claude-code", &[], "auto").unwrap(),
            vec!["--permission-mode", "auto"]
        );
        assert_eq!(
            permission_launch_args("qwen", &[], "auto").unwrap(),
            vec!["--approval-mode", "auto"]
        );
        assert_eq!(permission_launch_args("kimi", &[], "auto").unwrap(), vec!["--yolo"]);
        assert_eq!(permission_launch_args("cursor", &[], "auto").unwrap(), vec!["--auto-review"]);
        // 没有该档：拒绝，不静默退回本机默认
        assert!(permission_launch_args("cursor", &[], "ask").is_none());
        assert!(permission_launch_args("gemini", &[], "auto").is_none());
        assert!(permission_launch_args("opencode", &[], "auto").is_none());
        // 旧的「自动改文件」档已并掉
        assert!(permission_launch_args("claude-code", &[], "auto_edit").is_none());
        // codex：ask 保留默认沙箱；auto（--approve-for-me 自带 workspace-write，与 -s 互斥）与 full 换掉 -s workspace-write
        let base: Vec<String> = vec!["-c".into(), "x=1".into(), "-s".into(), "workspace-write".into()];
        assert_eq!(
            permission_launch_args("codex", &base, "ask").unwrap(),
            vec!["-c", "x=1", "-s", "workspace-write", "-a", "on-request"]
        );
        assert_eq!(
            permission_launch_args("codex", &base, "auto").unwrap(),
            vec!["-c", "x=1", "--approve-for-me"]
        );
        assert_eq!(
            permission_launch_args("codex", &base, "full").unwrap(),
            vec!["-c", "x=1", "-a", "never", "-s", "danger-full-access"]
        );
    }

    #[test]
    fn readonly_launch_args_per_agent() {
        // 硬保护矩阵（注册表 readonly_args）：六家有只读/计划模式参数
        assert_eq!(
            readonly_launch_args("claude-code", &[]).unwrap(),
            vec!["--permission-mode", "plan"]
        );
        assert_eq!(
            readonly_launch_args("gemini", &[]).unwrap(),
            vec!["--approval-mode", "plan"]
        );
        assert_eq!(readonly_launch_args("kimi", &[]).unwrap(), vec!["--plan"]);
        assert_eq!(readonly_launch_args("cursor", &[]).unwrap(), vec!["--plan"]);
        assert_eq!(
            readonly_launch_args("codebuddy", &[]).unwrap(),
            vec!["--permission-mode", "plan"]
        );
        // grok：dontAsk（CI 严格白名单）+ sandbox read-only（OS 级只读）
        assert_eq!(
            readonly_launch_args("grok", &[]).unwrap(),
            vec!["--permission-mode", "dontAsk", "--sandbox", "read-only"]
        );
        // codex：只读替换默认的 -s workspace-write（先剔除原沙箱参数对再追加）
        let base: Vec<String> = vec![
            "-c".into(),
            "x=1".into(),
            "-s".into(),
            "workspace-write".into(),
        ];
        assert_eq!(
            readonly_launch_args("codex", &base).unwrap(),
            vec!["-c", "x=1", "-s", "read-only"]
        );
        // 要看版本的家（qwen / opencode）：测试态查不到本机版本 = 当没有只讨论；未知 agent 也是 None
        assert!(readonly_launch_args("qwen", &[]).is_none());
        assert!(readonly_launch_args("opencode", &[]).is_none());
        assert!(readonly_launch_args("nope", &[]).is_none());
    }

    #[test]
    fn readonly_supported_follows_min_version() {
        let qwen = agent_spec("qwen").unwrap();
        assert_eq!(qwen.readonly_args, &["--approval-mode", "plan"]);
        assert!(readonly_supported_at(qwen, Some("0.25.3")));
        assert!(readonly_supported_at(qwen, Some("Qwen Code 0.26.1")));
        assert!(!readonly_supported_at(qwen, Some("0.25.2")));
        assert!(!readonly_supported_at(qwen, None), "查不到版本不冒险");
        let oc = agent_spec("opencode").unwrap();
        assert_eq!(oc.readonly_args, &["--agent", "plan"]);
        assert!(readonly_supported_at(oc, Some("1.19.3")));
        assert!(!readonly_supported_at(oc, Some("1.18.10")));
        // 不看版本的家照旧
        assert!(readonly_supported_at(agent_spec("claude-code").unwrap(), None));
        assert!(readonly_supported_at(agent_spec("cursor").unwrap(), None));
    }

    #[test]
    fn readonly_env_tightens_opencode_plan_agent() {
        let mut env = vec![
            ("OPENCODE_CONFIG_CONTENT".to_string(), r#"{"model":"ccode/m","agent":{"build":{"x":1}}}"#.to_string()),
            ("OPENCODE_DISABLE_AUTOUPDATE".to_string(), "1".to_string()),
        ];
        readonly_launch_env("opencode", &mut env);
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("OPENCODE_EXPERIMENTAL_PLAN_MODE").as_deref(), Some("1"));
        let cfg: serde_json::Value = serde_json::from_str(&get("OPENCODE_CONFIG_CONTENT").unwrap()).unwrap();
        assert_eq!(cfg["model"], "ccode/m", "原有配置保留");
        assert_eq!(cfg["agent"]["build"]["x"], 1);
        let perm = &cfg["agent"]["plan"]["permission"];
        assert_eq!(perm["*"], "ask", "bash / 子任务 / MCP 一律先问");
        assert_eq!(perm["edit"]["*"], "deny");
        assert_eq!(perm["edit"]["*opencode/plans/*.md"], "allow", "方案文件能写");
        assert_eq!(perm["plan_exit"], "allow");
        // 第一个键必须是 *：OpenCode 按顺序后来者优先，先兜底再放行（serde_json 按键名排序，* 排在字母前）
        assert_eq!(perm.as_object().unwrap().keys().next().map(String::as_str), Some("*"));
        // 没有内联配置也补一份；别家不动
        let mut bare = Vec::new();
        readonly_launch_env("opencode", &mut bare);
        assert!(bare.iter().any(|(k, _)| k == "OPENCODE_CONFIG_CONTENT"));
        let mut other = vec![("A".to_string(), "1".to_string())];
        readonly_launch_env("qwen", &mut other);
        assert_eq!(other.len(), 1);
    }

    #[test]
    fn codex_modern_drops_service_tier_and_adds_no_daemon_only_when_interactive() {
        // 2026-10-19 用户：Codex 终端 3 条 warning，其中两条是 Mesa 的参数引起的（本机 0.163 PTY 实录）
        assert_eq!(parse_cli_semver("codex-cli 0.163.0"), Some((0, 163, 0)));
        assert_eq!(parse_cli_semver("codex-cli 0.98.1-beta"), Some((0, 98, 1)));
        assert_eq!(parse_cli_semver("unknown"), None);
        let p = profile("codex", Some("https://relay.example.com/v1"));
        let set = |v| CODEX_VERSION_FOR_TEST.with(|c| c.set(v));
        // 新版：不塞 service_tier；交互式启动（prepare_launch）带 --no-daemon
        set(Some((0, 163, 0)));
        let joined = launch_plan(&p, Some("sk".into()), Some("glm-5.3")).unwrap().args.join(" ");
        assert!(!joined.contains("service_tier"));
        assert!(joined.contains(r#"web_search="disabled""#));
        assert!(!joined.contains("--no-daemon"), "launch_plan 也给 exec 用，exec 不认 --no-daemon");
        assert!(prepare_launch(&p).unwrap().contains(&"--no-daemon".to_string()));
        // 旧版与查不到版本：照旧塞 auto、不带 --no-daemon（旧版不认这个参数，带了起不来）
        for v in [Some((0, 154, 0)), None] {
            set(v);
            let joined = launch_plan(&p, Some("sk".into()), Some("glm-5.3")).unwrap().args.join(" ");
            assert!(joined.contains(r#"service_tier="auto""#));
            assert!(!prepare_launch(&p).unwrap().contains(&"--no-daemon".to_string()));
        }
        // 别家不受影响
        set(Some((0, 163, 0)));
        assert!(!prepare_launch(&profile("claude-code", Some("https://x"))).unwrap().contains(&"--no-daemon".to_string()));
        set(None);
    }

    #[test]
    fn codex_plan_inlines_provider_via_c_args() {
        let p = profile("codex", Some("https://relay.example.com/v1"));
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("gpt-5-codex")).unwrap();
        assert!(plan
            .env
            .contains(&("CODEX_API_KEY".into(), "sk-secret".into())));
        let joined = plan.args.join(" ");
        assert!(joined.contains(r#"model_providers.ccode.base_url="https://relay.example.com/v1""#));
        assert!(joined.contains(r#"model_providers.ccode.wire_api="responses""#));
        assert!(joined.contains(r#"model_provider="ccode""#));
        assert!(joined.contains("-m gpt-5-codex"));
        assert!(joined.contains(r#"web_search="disabled""#));
        assert!(joined.contains(r#"service_tier="auto""#));
        assert!(!joined.contains("features.apps=false"));
        assert!(joined.contains("plugins.codex-app-tools@openai-bundled.enabled=false"));
        // 窗口未确知 → 不写 -c 覆盖：gpt-5-codex 在内置表里 context=None（只标了会思考），
        // 单测里用户覆盖/网关实测/公共库均为空，declared 视图返回 None。此时写 128K 猜测
        // 会把 codex 自带 registry 里的真实窗口压低，比不覆盖更坏。
        assert!(!joined.contains("model_context_window"));
        assert!(!joined.contains("model_auto_compact_token_limit"));
        // 会话内自省：模型显示名随启动注入（配置名 · 模型），agent 可查
        assert!(plan.env.contains(&(
            "CCODE_MODEL_DISPLAY_NAME".into(),
            format!("{} · gpt-5-codex", p.name),
        )));
    }

    #[test]
    fn codex_plan_without_model_has_no_display_name_env() {
        let p = profile("codex", Some("https://relay.example.com/v1"));
        let plan = launch_plan(&p, Some("sk-secret".into()), None).unwrap();
        assert!(!plan
            .env
            .iter()
            .any(|(k, _)| k == "CCODE_MODEL_DISPLAY_NAME"));
    }

    #[test]
    fn codex_plan_without_base_url_has_no_provider_args() {
        let p = profile("codex", None);
        let plan = launch_plan(&p, None, None).unwrap();
        // 无 provider 参数，只有默认沙箱参数 + 沙箱内联网放开
        assert_eq!(
            plan.args,
            vec![
                "-s",
                "workspace-write",
                "-c",
                "sandbox_workspace_write.network_access=true"
            ]
        );
        assert!(plan.env.is_empty());
    }

    #[test]
    fn gemini_plan_sets_only_present_fields() {
        let p = profile("gemini", Some("https://relay.example.com"));
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("gemini-3-pro")).unwrap();
        assert!(plan.args.is_empty());
        assert!(plan
            .env
            .contains(&("GEMINI_API_KEY".into(), "sk-secret".into())));
        assert!(plan.env.contains(&(
            "GOOGLE_GEMINI_BASE_URL".into(),
            "https://relay.example.com".into()
        )));
        assert!(plan
            .env
            .contains(&("GEMINI_MODEL".into(), "gemini-3-pro".into())));

        let bare = launch_plan(&p, None, None).unwrap();
        assert!(bare.env.contains(&(
            "GOOGLE_GEMINI_BASE_URL".into(),
            "https://relay.example.com".into()
        )));
        assert!(!bare.env.iter().any(|(k, _)| k == "GEMINI_API_KEY"));
        assert!(!bare.env.iter().any(|(k, _)| k == "GEMINI_MODEL"));
    }

    // ===== 官方账号模式（P1a）=====

    fn official_profile(agent: &str) -> Profile {
        let mut p = profile(agent, Some("https://relay.example.com"));
        p.account_type = crate::profiles::AccountType::Official;
        p
    }

    #[test]
    fn official_plan_injects_no_credentials_and_purges_residual_env() {
        let p = official_profile("claude-code");
        let plan = launch_plan(&p, Some("sk-secret".into()), None).unwrap();
        // 密钥/base_url 一律不注入，模型为空也不注入模型 env
        assert!(plan.env.is_empty());
        assert!(!plan.env.iter().any(|(_, v)| v.contains("sk-secret")));
        assert!(plan.env_remove.contains(&"ANTHROPIC_AUTH_TOKEN".into()));
        assert!(plan.env_remove.contains(&"ANTHROPIC_API_KEY".into()));
        assert!(plan.env_remove.contains(&"ANTHROPIC_BASE_URL".into()));
        // 磁盘 settings.json env 盖过进程 env：--settings 内联把端点 / 密钥写成空串，不含任何密钥
        assert_eq!(plan.args[0], "--settings");
        let v: serde_json::Value = serde_json::from_str(&plan.args[1]).unwrap();
        for k in ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] {
            assert_eq!(v["env"][k], "", "{k}");
        }
        assert!(!plan.args[1].contains("sk-secret"));
        // 用户全局设过的模型槽也写空；选了模型时模型键写这次的模型
        tests::TEST_CLAUDE_USER_KEYS.with(|k| *k.borrow_mut() = vec!["ANTHROPIC_DEFAULT_OPUS_MODEL".into(), "ANTHROPIC_MODEL".into()]);
        let plan = launch_plan(&p, None, Some("claude-opus-5")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&plan.args[plan.args.iter().position(|a| a == "--settings").unwrap() + 1]).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"], "");
        assert_eq!(v["env"]["ANTHROPIC_MODEL"], "claude-opus-5");
        tests::TEST_CLAUDE_USER_KEYS.with(|k| k.borrow_mut().clear());
    }

    #[test]
    fn codebuddy_and_qwen_official_override_disk_auth() {
        let plan = launch_plan(&official_profile("codebuddy"), None, None).unwrap();
        assert_eq!(plan.args[0], "--settings");
        let v: serde_json::Value = serde_json::from_str(&plan.args[1]).unwrap();
        assert_eq!(v["env"]["CODEBUDDY_BASE_URL"], "");
        assert_eq!(v["env"]["CODEBUDDY_API_KEY"], "");
        let plan = launch_plan(&official_profile("qwen"), None, None).unwrap();
        let i = plan.args.iter().position(|a| a == "--auth-type").unwrap();
        assert_eq!(plan.args[i + 1], "qwen-oauth");
        // 这三家的磁盘残留不再挡启动
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".codebuddy")).unwrap();
        std::fs::write(dir.join(".codebuddy/settings.json"), r#"{"env":{"CODEBUDDY_API_KEY":"sk"}}"#).unwrap();
        assert!(official_launch_conflicts(&dir, &official_profile("codebuddy")).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_official_lists_cached_models_and_never_launches_without_model() {
        let cache = r#"{"models":[{"slug":"gpt-reserve","visibility":"hide","priority":4},{"slug":"gpt-5.6-terra","visibility":"list","priority":8},{"slug":"gpt-6-luna","visibility":"list","priority":5}]}"#;
        assert_eq!(codex_listed_models(cache), vec!["gpt-6-luna", "gpt-5.6-terra"]);
        assert!(codex_listed_models("not json").is_empty());
        let mut p = official_profile("codex");
        p.models.clear();
        tests::TEST_OFFICIAL_MODELS.with(|k| *k.borrow_mut() = vec!["gpt-6-luna".into()]);
        // 选的是中转模型（被滤掉）：仍带官方第一个，不让磁盘里的 deepseek 顶上
        let plan = launch_plan(&p, None, Some("deepseek-v4-flash-0731")).unwrap();
        let i = plan.args.iter().position(|a| a == "-m").unwrap();
        assert_eq!(plan.args[i + 1], "gpt-6-luna");
        tests::TEST_OFFICIAL_MODELS.with(|k| k.borrow_mut().clear());
    }

    #[test]
    fn official_claude_blanks_relay_top_model_and_other_agents_gate_relay_models() {
        let p = official_profile("claude-code");
        tests::TEST_CLAUDE_TOP_MODEL.with(|k| *k.borrow_mut() = Some("glm-5.3[1m]".into()));
        let plan = launch_plan(&p, None, None).unwrap();
        let ov = &plan.args[plan.args.iter().position(|a| a == "--settings").unwrap() + 1];
        let v: serde_json::Value = serde_json::from_str(ov).unwrap();
        assert_eq!(v["model"], "", "空串 = Claude 自己的默认");
        // 用户顶层设的是官方别名：不动
        tests::TEST_CLAUDE_TOP_MODEL.with(|k| *k.borrow_mut() = Some("opus".into()));
        let plan = launch_plan(&p, None, None).unwrap();
        let ov = &plan.args[plan.args.iter().position(|a| a == "--settings").unwrap() + 1];
        assert!(serde_json::from_str::<serde_json::Value>(ov).unwrap().get("model").is_none());
        // 选了模型走 --model
        let plan = launch_plan(&p, None, Some("claude-opus-5")).unwrap();
        let i = plan.args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(plan.args[i + 1], "claude-opus-5");
        tests::TEST_CLAUDE_TOP_MODEL.with(|k| *k.borrow_mut() = None);

        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".grok")).unwrap();
        std::fs::create_dir_all(dir.join(".gemini")).unwrap();
        std::fs::write(dir.join(".grok/config.toml"), "[models]\ndefault = \"glm-5.3-flash\"\n").unwrap();
        let mut grok = official_profile("grok");
        grok.base_url = None;
        assert!(official_launch_conflicts(&dir, &grok)[0].contains("glm-5.3-flash"));
        std::fs::write(dir.join(".grok/config.toml"), "[models]\ndefault = \"grok-4.5\"\n").unwrap();
        assert!(official_launch_conflicts(&dir, &grok).is_empty());
        std::fs::write(dir.join(".gemini/.env"), "GEMINI_MODEL=\"relay-glm\"\n").unwrap();
        let gemini = official_profile("gemini");
        tests::TEST_GEMINI_AUTH.with(|k| *k.borrow_mut() = Some("oauth-personal".into()));
        assert!(official_launch_conflicts(&dir, &gemini)[0].contains("relay-glm"));
        std::fs::write(dir.join(".gemini/.env"), "GEMINI_MODEL=gemini-3.5-pro\n").unwrap();
        assert!(official_launch_conflicts(&dir, &gemini).is_empty());
        tests::TEST_GEMINI_AUTH.with(|k| *k.borrow_mut() = Some("gemini-api-key".into()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn official_identity_reads_plan_and_email() {
        let claude = serde_json::json!({ "oauthAccount": { "emailAddress": "a@b.com", "organizationType": "claude_max" } });
        assert_eq!(claude_identity(&claude), (Some("Max".into()), Some("a@b.com".into())));
        assert_eq!(claude_identity(&serde_json::json!({})), (None, None));

        use base64::Engine as _;
        let claims = serde_json::json!({ "email": "c@d.com", "https://api.openai.com/auth": { "chatgpt_plan_type": "plus" } });
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string());
        let auth = serde_json::json!({ "tokens": { "id_token": format!("h.{payload}.sig"), "access_token": "secret" } });
        assert_eq!(codex_identity(&auth), (Some("Plus".into()), Some("c@d.com".into())));
        // API Key 模式没有 id_token
        assert_eq!(codex_identity(&serde_json::json!({ "OPENAI_API_KEY": "sk-x" })), (None, None));
        assert_eq!(codex_identity(&serde_json::json!({ "tokens": { "id_token": "garbage" } })), (None, None));

        assert_eq!(cursor_email("✓ Logged in as e@f.com").as_deref(), Some("e@f.com"));
        assert_eq!(cursor_email("✓ Logged in"), None);

        let about = "About Cursor CLI\n\nCLI Version         2026.10.22\nSubscription Tier   Pro\nUser Email          e@f.com\n";
        assert_eq!(cursor_about_identity(about), (Some("Pro".into()), Some("e@f.com".into())));

        let grok_auth = serde_json::json!({ "https://auth.x.ai::u1": { "auth_mode": "oidc", "email": "g@h.com", "key": "secret" } });
        assert_eq!(grok_email(&grok_auth).as_deref(), Some("g@h.com"));
        let payload = serde_json::json!({ "settings": { "subscription_tier": null, "subscription_tier_display": "SuperGrok" } });
        let cache = serde_json::json!({ "payload": payload.to_string() });
        assert_eq!(grok_plan(&cache).as_deref(), Some("SuperGrok"));
        assert_eq!(grok_plan(&serde_json::json!({ "payload": "{}" })), None);
    }

    #[test]
    fn codex_relay_launch_points_side_models_at_this_model() {
        let cfg: toml::Value = toml::from_str("review_model = \"gpt-6-sol\"\n[agents]\ndefault_subagent_model = \"gpt-6-luna\"\n[memories]\nextract_model = \"m1\"\n").unwrap();
        let args = codex_relay_model_args(Some(&cfg), "m1");
        assert_eq!(args, vec!["-c", "review_model=\"m1\"", "-c", "agents.default_subagent_model=\"m1\""]);
        assert!(codex_relay_model_args(None, "m1").is_empty());
        tests::TEST_CODEX_CONFIG.with(|k| *k.borrow_mut() = Some(cfg));
        let plan = launch_plan(&profile("codex", Some("https://relay.example.com/v1")), Some("sk".into()), Some("deepseek-v4")).unwrap();
        assert!(plan.args.iter().any(|a| a == "review_model=\"deepseek-v4\""));
        tests::TEST_CODEX_CONFIG.with(|k| *k.borrow_mut() = None);
    }

    #[test]
    fn gateway_compat_reaches_claude_overlay_and_codex_provider() {
        let mut p = profile("claude-code", Some("https://gw.example.com"));
        p.request_policy.compat = crate::profiles::GatewayCompat {
            timeout_secs: Some(600),
            no_experimental_betas: true,
            no_thinking: false,
        };
        tests::TEST_CLAUDE_USER_KEYS.with(|k| *k.borrow_mut() = vec!["CLAUDE_CODE_DISABLE_THINKING".into()]);
        let plan = launch_plan(&p, Some("sk".into()), Some("m1")).unwrap();
        let path = &plan.args[plan.args.iter().position(|a| a == "--settings").unwrap() + 1];
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(v["env"]["API_TIMEOUT_MS"], "600000");
        assert_eq!(v["env"]["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"], "1");
        assert_eq!(v["env"]["CLAUDE_CODE_DISABLE_THINKING"], "", "上一家留下的开关写空");
        tests::TEST_CLAUDE_USER_KEYS.with(|k| k.borrow_mut().clear());
        let mut c = profile("codex", Some("https://relay.example.com/v1"));
        c.request_policy.compat.timeout_secs = Some(300);
        let plan = launch_plan(&c, Some("sk".into()), Some("m1")).unwrap();
        assert!(plan.args.iter().any(|a| a.ends_with(".stream_idle_timeout_ms=300000")));
    }

    #[test]
    fn shared_env_goes_in_before_connection_extra_env() {
        tests::TEST_SHARED_ENV.with(|k| {
            *k.borrow_mut() = [("DISABLE_TELEMETRY", "1"), ("MY_FLAG", "shared"), ("OPENAI_API_KEY", "sk-sneak")]
                .into_iter()
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .collect()
        });
        let mut p = profile("codex", Some("https://relay.example.com/v1"));
        p.extra_env.insert("MY_FLAG".into(), "conn".into());
        let plan = launch_plan(&p, Some("sk".into()), Some("m1")).unwrap();
        let last = |k: &str| plan.env.iter().rev().find(|(x, _)| x == k).map(|(_, v)| v.clone());
        assert_eq!(last("DISABLE_TELEMETRY").as_deref(), Some("1"));
        assert_eq!(last("MY_FLAG").as_deref(), Some("conn"), "连接的附加环境变量覆盖共用的");
        assert!(!plan.env.iter().any(|(_, v)| v == "sk-sneak"), "像密钥的键读时也拦");
        let off = launch_plan(&official_profile("codex"), None, None).unwrap();
        assert!(off.env.iter().any(|(k, _)| k == "DISABLE_TELEMETRY"), "官方账号也带");
        tests::TEST_SHARED_ENV.with(|k| k.borrow_mut().clear());
        assert!(crate::settings::shared_env_rejection("GEMINI_SANDBOX").is_none());
        for bad in ["ANTHROPIC_AUTH_TOKEN", "OPENAI_BASE_URL", "GEMINI_MODEL", "HTTPS_PROXY", "PATH", "1BAD", "A-B"] {
            assert!(crate::settings::shared_env_rejection(bad).is_some(), "{bad}");
        }
    }

    #[test]
    fn grok_official_pins_models_and_skips_relay_sections() {
        let out = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  - grok-4.5\n  * grok-4.7 (default)\n";
        assert_eq!(parse_grok_models(out), vec!["grok-4.7", "grok-4.5"]);
        let cfg = "[model.\"grok-4.5\"]\nbase_url = \"https://relay.example.com/v1\"\n[model.grok-4.7]\nbase_url = \"https://api.x.ai/v1\"\n";
        assert_eq!(grok_relay_sections_in(cfg), vec!["grok-4.5"]);
        let mut p = official_profile("grok");
        p.models.clear();
        tests::TEST_OFFICIAL_MODELS.with(|k| *k.borrow_mut() = vec!["grok-4.7".into()]);
        let plan = launch_plan(&p, None, None).unwrap();
        let overlay = plan.env.iter().find(|(k, _)| k == "GROK_CONFIG").map(|(_, v)| v.clone()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&overlay).unwrap();
        assert_eq!(v["models"]["default"], "grok-4.7");
        assert_eq!(v["models"]["session_summary"], "grok-4.7");
        assert!(plan.env.iter().any(|(k, v)| k == "GROK_DEFAULT_MODEL" && v == "grok-4.7"));
        // 能定出官方模型：磁盘默认是中转模型也不拦
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".grok")).unwrap();
        std::fs::write(dir.join(".grok/config.toml"), "[models]\ndefault = \"glm-5.3-flash\"\n").unwrap();
        assert!(official_launch_conflicts(&dir, &p).is_empty());
        tests::TEST_OFFICIAL_MODELS.with(|k| k.borrow_mut().clear());
        assert!(!official_launch_conflicts(&dir, &p).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn claude_official_models_append_additional_options() {
        let text = r#"{"additionalModelOptionsCache":[{"value":"claude-fable-5-1[1m]","label":"Fable"},{"value":"opus"},{"label":"x"}]}"#;
        let extra = claude_additional_models(text);
        assert_eq!(extra, vec!["claude-fable-5-1[1m]", "opus"]);
        assert_eq!(
            claude_official_models(extra),
            vec!["default", "fable", "opus", "sonnet", "haiku", "claude-fable-5-1[1m]"]
        );
        assert!(claude_additional_models("{}").is_empty());
    }

    #[test]
    fn official_model_lists_parse_cursor_and_kimi() {
        let out = "Available models\n\nauto - Auto (current, default)\ngpt-5.3-codex - Codex 5.3\nclaude-opus-5-thinking-high - Claude Opus 5 1M Thinking\n";
        assert_eq!(parse_cursor_models(out), vec!["auto", "gpt-5.3-codex", "claude-opus-5-thinking-high"]);
        let cfg = "default_model = \"kimi-code/k3\"\n[models.\"kimi-code/k2\"]\nprovider = \"managed:kimi-code\"\n[models.\"kimi-code/k3\"]\nprovider = \"managed:kimi-code\"\n[models.relay]\nprovider = \"ccode-x\"\n";
        assert_eq!(kimi_managed_aliases(cfg), vec!["kimi-code/k3", "kimi-code/k2"]);
        assert!(kimi_managed_aliases("[models.relay]\nprovider = \"x\"\n").is_empty());
    }

    #[test]
    fn kimi_official_without_model_uses_login_alias() {
        let cfg = "default_model = \"relay-k3\"\n[models.relay-k3]\nprovider = \"ccode-x\"\n[models.\"kimi-code/k3\"]\nprovider = \"managed:kimi-code\"\n";
        assert_eq!(kimi_managed_alias(cfg).as_deref(), Some("kimi-code/k3"));
        assert_eq!(kimi_managed_alias("default_model = \"a\"\n[models.a]\nprovider = \"x\"\n"), None);
        let mut p = official_profile("kimi");
        p.models.clear();
        tests::TEST_KIMI_CONFIG.with(|k| *k.borrow_mut() = Some(cfg.into()));
        let plan = launch_plan(&p, None, None).unwrap();
        let i = plan.args.iter().position(|a| a == "-m").unwrap();
        assert_eq!(plan.args[i + 1], "kimi-code/k3");
        assert!(official_launch_conflicts(std::path::Path::new("/nonexistent"), &p).is_empty());
        // 没登录过：拦下并说清楚
        tests::TEST_KIMI_CONFIG.with(|k| *k.borrow_mut() = Some("default_model = \"a\"\n".into()));
        assert!(official_launch_conflicts(std::path::Path::new("/nonexistent"), &p)[0].contains("kimi login"));
        tests::TEST_KIMI_CONFIG.with(|k| *k.borrow_mut() = None);
    }

    #[test]
    fn kimi_official_plan_purges_synth_channel_and_uses_model_flag() {
        let p = official_profile("kimi");
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("kimi-code/k3")).unwrap();
        // KIMI_MODEL_* 合成通道会抢 OAuth 登录态：一律 env_remove 且不注入任何 env
        assert!(plan.env.is_empty());
        for var in [
            "KIMI_MODEL_NAME",
            "KIMI_MODEL_PROVIDER_TYPE",
            "KIMI_MODEL_API_KEY",
            "KIMI_MODEL_BASE_URL",
            "KIMI_MODEL_DISPLAY_NAME",
            "KIMI_MODEL_CAPABILITIES",
            "KIMI_MODEL_MAX_CONTEXT_SIZE",
            "KIMI_API_KEY",
            "KIMI_BASE_URL",
        ] {
            assert!(plan.env_remove.contains(&var.into()), "purge 缺 {var}");
        }
        // 模型走 -m flag（与认证方式无关），密钥绝不出现
        assert_eq!(plan.args, vec!["-m", "kimi-code/k3"]);
        assert!(!plan.args.iter().any(|a| a.contains("sk-secret")));
        let blocked = launch_plan(&p, None, Some("deepseek-chat"));
        assert!(blocked.unwrap().args.is_empty());
    }

    #[test]
    fn official_plan_injects_model_only_when_selected() {
        let p = official_profile("claude-code");
        let plan = launch_plan(&p, None, Some("claude-sonnet-4")).unwrap();
        assert_eq!(
            plan.env,
            vec![("ANTHROPIC_MODEL".to_string(), "claude-sonnet-4".to_string())]
        );
        // 模型槽位注册（ANTHROPIC_DEFAULT_*）只在 api 模式做
        assert!(!plan
            .env
            .iter()
            .any(|(k, _)| k.starts_with("ANTHROPIC_DEFAULT_")));
        // purge 列表照常
        assert!(!plan.env_remove.is_empty());
    }

    #[test]
    fn official_plan_keeps_extra_env_as_escape_hatch() {
        let mut p = official_profile("claude-code");
        p.extra_env
            .insert("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into());
        let plan = launch_plan(&p, None, None).unwrap();
        assert_eq!(
            plan.env,
            vec![(
                "HTTPS_PROXY".to_string(),
                "http://127.0.0.1:7890".to_string()
            )]
        );
    }

    #[test]
    fn official_codex_plan_overrides_provider_to_chatgpt_and_keeps_sandbox() {
        let p = official_profile("codex");
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("gpt-5-codex")).unwrap();
        assert!(plan.env.is_empty());
        let joined = plan.args.join(" ");
        // 不写中转 provider 块；只把本进程默认渠道切到内置 ChatGPT
        assert!(!joined.contains("model_providers"));
        assert!(joined.contains(r#"model_provider="openai""#));
        assert!(!joined.contains(r#"web_search="disabled""#));
        assert!(!joined.contains(r#"service_tier="auto""#));
        // 官方账号保留内置 codex_apps（ChatGPT 订阅的 apps 功能可用），不跟着网关关
        assert!(!joined.contains("features.apps=false"));
        assert!(!joined.contains("enable_mcp_apps"));
        assert!(joined.contains("-m gpt-5-codex"));
        // 默认沙箱与认证方式无关，官方账号同样生效；沙箱内联网同步放开
        assert!(joined.contains("-s workspace-write"));
        assert!(joined.contains("sandbox_workspace_write.network_access=true"));
        assert!(plan.env_remove.contains(&"CODEX_API_KEY".into()));
        assert!(plan.env_remove.contains(&"OPENAI_API_KEY".into()));
        // 模型为空：沙箱 + 本进程切 ChatGPT 渠道
        let bare = launch_plan(&p, None, None).unwrap();
        assert_eq!(
            bare.args,
            vec![
                "-s",
                "workspace-write",
                "-c",
                "sandbox_workspace_write.network_access=true",
                "-c",
                r#"model_provider="openai""#,
            ]
        );
    }

    #[test]
    fn official_codex_drops_deepseek_model() {
        let p = official_profile("codex");
        let plan = launch_plan(&p, None, Some("deepseek-v4-flash-0731")).unwrap();
        assert!(
            !plan.args.iter().any(|a| a.contains("deepseek")),
            "{:?}",
            plan.args
        );
        assert!(!plan.args.iter().any(|a| a == "-m"));
        assert!(plan
            .args
            .iter()
            .any(|a| a.contains(r#"model_provider="openai""#)));
    }

    #[test]
    fn official_gemini_plan_purges_gateway_env() {
        let p = official_profile("gemini");
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("gemini-3-pro")).unwrap();
        // base URL（GATEWAY 模式）与密钥都不注入，只注入模型
        assert_eq!(
            plan.env,
            vec![("GEMINI_MODEL".to_string(), "gemini-3-pro".to_string())]
        );
        assert!(plan.env_remove.contains(&"GEMINI_API_KEY".into()));
        assert!(plan.env_remove.contains(&"GOOGLE_GEMINI_BASE_URL".into()));
    }

    #[test]
    fn official_plan_for_unsupported_agent_is_inert() {
        // 规格未填官方账号的 agent（opencode）：purge 为空、不注入任何凭证/模型，不崩溃
        let p = official_profile("opencode");
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("m1")).unwrap();
        assert!(plan.env.is_empty());
        assert!(plan.args.is_empty());
        assert!(plan.env_remove.is_empty());
    }

    // ===== 初始 prompt 注入（一键开步首条指令）=====

    #[test]
    fn prompt_inject_positional_and_flag_shapes() {
        // claude/codex：位置参数（单元素，pty_spawn 追加在命令行最后）
        let p = profile("claude-code", None);
        let plan =
            launch_plan_with_prompt(&p, None, Some("m1"), Some("读 TASK.md，按简报开始执行"))
                .unwrap();
        assert_eq!(plan.prompt_args, vec!["读 TASK.md，按简报开始执行"]);
        assert!(!plan.prompt_dropped);
        // 位置参数不在 plan.args 里（保证 codex 沙箱/-c、claude --session-id 都在它前面）
        assert!(!plan.args.iter().any(|a| a.contains("TASK.md")));
        // gemini/qwen：-i <prompt>（执行后继续交互）
        for agent in ["gemini", "qwen"] {
            let p = profile(agent, None);
            let plan = launch_plan_with_prompt(&p, None, None, Some("开始干活")).unwrap();
            assert_eq!(
                plan.prompt_args,
                vec!["-i", "开始干活"],
                "{agent} 应为 -i 形态"
            );
            assert!(!plan.prompt_dropped);
        }
    }

    #[test]
    fn prompt_inject_coexists_with_codex_sandbox_args() {
        // codex 特殊变体：既有 -c/-m/沙箱参数保持原顺序，prompt 单列在 prompt_args 末尾追加
        let p = profile("codex", Some("https://relay.example.com/v1"));
        let plan = launch_plan_with_prompt(
            &p,
            Some("sk-secret".into()),
            Some("gpt-5-codex"),
            Some("开工"),
        ).unwrap();
        assert_eq!(plan.prompt_args, vec!["开工"]);
        let joined = plan.args.join(" ");
        assert!(joined.contains("-s workspace-write"));
        assert!(joined.contains(r#"model_provider="ccode""#));
        assert!(joined.contains("-m gpt-5-codex"));
        assert!(!joined.contains("开工"), "prompt 不得混入既有参数序列");
    }

    #[test]
    fn prompt_inject_unsupported_marks_dropped() {
        // kimi 没有可用于交互新会话的初始 prompt 参数：不注入 + 标记。
        let p = profile("kimi", None);
        let plan = launch_plan_with_prompt(&p, None, None, Some("开工")).unwrap();
        assert!(plan.prompt_args.is_empty(), "kimi 不得注入");
        assert!(plan.prompt_dropped, "kimi 应置 dropped 标记");
        // OpenCode 1.18.x 的 --prompt 是交互会话可用的显式参数。
        let p = profile("opencode", None);
        let plan = launch_plan_with_prompt(&p, None, None, Some("开工")).unwrap();
        assert_eq!(plan.prompt_args, vec!["--prompt", "开工"]);
        assert!(!plan.prompt_dropped);
        // 未知 agent：无从注入，同样标记
        let p = profile("no-such-agent", None);
        let plan = launch_plan_with_prompt(&p, None, None, Some("开工")).unwrap();
        assert!(plan.prompt_dropped);
    }

    #[test]
    fn prompt_inject_applies_to_official_account_too() {
        // api / 官方账号两种模式都注入（prompt 与认证方式无关）；purge/凭证语义不受影响
        let p = official_profile("claude-code");
        let plan = launch_plan_with_prompt(&p, Some("sk-secret".into()), None, Some("开工")).unwrap();
        assert_eq!(plan.prompt_args, vec!["开工"]);
        assert!(plan.env_remove.contains(&"ANTHROPIC_AUTH_TOKEN".into()));
        assert!(!plan.env.iter().any(|(_, v)| v.contains("sk-secret")));
    }

    #[test]
    fn prompt_inject_skips_empty_and_blank_prompt() {
        let p = profile("claude-code", None);
        for prompt in [None, Some(""), Some("   ")] {
            let plan = launch_plan_with_prompt(&p, None, None, prompt).unwrap();
            assert!(plan.prompt_args.is_empty());
            assert!(!plan.prompt_dropped);
        }
        // 前后空白先裁剪再注入
        let plan = launch_plan_with_prompt(&p, None, None, Some("  开工  ")).unwrap();
        assert_eq!(plan.prompt_args, vec!["开工"]);
    }

    // ===== auth 文件只读探测（防御式）=====

    fn probe_temp(name: &str, content: &str, api_key_fields: &[&str]) -> Option<AuthProbe> {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        let probe = probe_auth_file(&path, api_key_fields);
        std::fs::remove_dir_all(&dir).ok();
        probe
    }

    #[test]
    fn auth_probe_detects_codex_chatgpt_and_apikey_shapes() {
        // ChatGPT 账号：tokens.access_token
        let probe = probe_temp(
            "auth.json",
            r#"{"OPENAI_API_KEY":null,"tokens":{"id_token":"x","access_token":"tok","refresh_token":"r"},"last_refresh":"2026-01-01T00:00:00Z"}"#,
            &["OPENAI_API_KEY"],
        );
        assert_eq!(probe, Some(AuthProbe::Connected));
        // API key 模式：顶层 OPENAI_API_KEY（官方 --api-key 与第三方中转同一形状），
        // 不算官方账号连接
        let probe = probe_temp(
            "auth.json",
            r#"{"OPENAI_API_KEY":"sk-x","tokens":null}"#,
            &["OPENAI_API_KEY"],
        );
        assert_eq!(probe, Some(AuthProbe::ApiKeyMode));
        // 规格没声明 api_key_fields 时同样形状回落 Unrecognized（不误判已连接）
        let probe = probe_temp("auth.json", r#"{"OPENAI_API_KEY":"sk-x"}"#, &[]);
        assert_eq!(probe, Some(AuthProbe::Unrecognized));
    }

    #[test]
    fn auth_probe_detects_nested_claude_and_flat_gemini_shapes() {
        // claude：凭证嵌套在 claudeAiOauth 下（camelCase）
        let probe = probe_temp(
            ".credentials.json",
            r#"{"claudeAiOauth":{"accessToken":"tok","refreshToken":"r","expiresAt":123}}"#,
            &[],
        );
        assert_eq!(probe, Some(AuthProbe::Connected));
        // gemini：google-auth-library Credentials 扁平结构
        let probe = probe_temp(
            "oauth_creds.json",
            r#"{"access_token":"tok","refresh_token":"r","scope":"s","token_type":"Bearer","expiry_date":123}"#,
            &[],
        );
        assert_eq!(probe, Some(AuthProbe::Connected));
    }

    #[test]
    fn auth_probe_is_defensive_on_missing_corrupt_and_unrecognized() {
        // 缺失 → None
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        assert_eq!(probe_auth_file(&dir.join("nope.json"), &[]), None);
        // 损坏（截断的 JSON）→ Corrupt，不误判为已连接
        let probe = probe_temp("auth.json", r#"{"tokens":{"access_token":"to"#, &[]);
        assert_eq!(probe, Some(AuthProbe::Corrupt));
        // 合法 JSON 但无凭证字段 → Unrecognized
        let probe = probe_temp("auth.json", r#"{"foo":"bar","n":1}"#, &[]);
        assert_eq!(probe, Some(AuthProbe::Unrecognized));
        // 空字符串凭证不算命中
        let probe = probe_temp("auth.json", r#"{"access_token":""}"#, &[]);
        assert_eq!(probe, Some(AuthProbe::Unrecognized));
    }

    // ===== auth 候选展开（/* 目录扫描）=====

    #[test]
    fn auth_candidates_expand_dir_scan_and_skip_subdirs_and_non_json() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let cred = dir.join(".kimi-code/credentials");
        std::fs::create_dir_all(cred.join("mcp")).unwrap();
        // 文件名取 Windows 也合法的形式（kimi 实际命名含冒号，仅 unix 能建）
        std::fs::write(cred.join("managed-kimi-code.json"), "{}").unwrap();
        std::fs::write(cred.join("notes.txt"), "{}").unwrap();
        std::fs::write(cred.join("mcp/server.json"), "{}").unwrap();
        let oa = crate::agent_specs::OfficialAccountSpec {
            login_cmd: &["login"],
            auth_file_paths: &[".kimi-code/credentials/*"],
            env_purge_list: &["KIMI_API_KEY"],
            conflict_probes: &[],
            detection_note: None,
            api_key_fields: &[],
        };
        let found = auth_probe_candidates(&dir, &oa);
        // 只命中直接子级 .json：mcp/ 子目录与 .txt 都排除
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, ".kimi-code/credentials/managed-kimi-code.json");
        assert!(found[0].1.ends_with("managed-kimi-code.json"));
        // 目录缺失 → 无候选（按未检出处理，不报错）
        std::fs::remove_dir_all(&cred).ok();
        assert!(auth_probe_candidates(&dir, &oa).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn auth_candidates_pass_plain_paths_through() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let spec = crate::agent_specs::agent_spec("qwen").unwrap();
        let oa = spec.official_account.as_ref().unwrap();
        let found = auth_probe_candidates(&dir, oa);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, ".qwen/oauth_creds.json");
        assert!(found[0].1.ends_with(".qwen/oauth_creds.json"));
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 配置冲突探测（.env / settings.json）=====

    const CONFLICT_KEYS: &[&str] = &["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL"];

    #[test]
    fn dotenv_probe_tolerates_comments_blank_lines_and_export_prefix() {
        let text = "# 注释\n\nGEMINI_API_KEY=sk-live-secret-123\nexport GOOGLE_GEMINI_BASE_URL = https://relay.example.com\n  # 缩进注释\nNOT_A_KEY=x\n";
        let hits = dotenv_conflict_keys(text, CONFLICT_KEYS);
        assert_eq!(hits, vec!["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"]);
        // 只报变量名，密钥值绝不进结果
        assert!(!hits.iter().any(|h| h.contains("sk-live-secret-123")));
    }

    #[test]
    fn dotenv_probe_is_case_sensitive_and_skips_malformed_lines() {
        // 小写变体不算（env 变量名大小写敏感，CLI 不会把它读成同一变量）
        assert!(dotenv_conflict_keys("gemini_api_key=x\n", CONFLICT_KEYS).is_empty());
        // 无等号的行、空键名都不命中
        assert!(dotenv_conflict_keys("GEMINI_API_KEY\n=value\n", CONFLICT_KEYS).is_empty());
    }

    #[test]
    fn settings_json_probe_reads_only_top_level_env_object() {
        // env 对象内命中；env 之外的同名键（如 mcpServers 里）不命中
        let text = r#"{"env":{"ANTHROPIC_API_KEY":"sk-ant-secret"},"mcpServers":{"x":{"env":{"ANTHROPIC_API_KEY":"y"}}}}"#;
        let keys = &["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"];
        assert_eq!(
            settings_env_conflict_keys(text, keys),
            vec!["ANTHROPIC_API_KEY"]
        );
    }

    #[test]
    fn settings_json_probe_is_defensive_on_non_object_corrupt_and_missing_env() {
        let keys = &["ANTHROPIC_API_KEY"];
        // env 不是对象
        assert!(settings_env_conflict_keys(r#"{"env":"ANTHROPIC_API_KEY"}"#, keys).is_empty());
        // 损坏的 JSON
        assert!(settings_env_conflict_keys(r#"{"env":{"ANTHROPIC_API_KEY":"x""#, keys).is_empty());
        // 没有 env 键
        assert!(settings_env_conflict_keys(r#"{"model":"opus"}"#, keys).is_empty());
    }

    #[test]
    fn probe_conflicts_reports_file_and_key_only_and_skips_missing_files() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".gemini")).unwrap();
        std::fs::write(
            dir.join(".gemini/.env"),
            "GEMINI_API_KEY=sk-super-secret-value\n",
        )
        .unwrap();
        let spec = crate::agent_specs::agent_spec("gemini").unwrap();
        let oa = spec.official_account.as_ref().unwrap();
        let conflicts = probe_conflicts(&dir, oa);
        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].contains("~/.gemini/.env"));
        assert!(conflicts[0].contains("GEMINI_API_KEY"));
        // DTO 文案不得含密钥值
        assert!(!conflicts[0].contains("sk-super-secret-value"));
        // 文件缺失静默跳过：claude 的 settings.json 探测在该目录无文件，不产生冲突
        let claude = crate::agent_specs::agent_spec("claude-code").unwrap();
        assert!(probe_conflicts(&dir, claude.official_account.as_ref().unwrap()).is_empty());
        // codex 保守留空：永不产生冲突
        let codex = crate::agent_specs::agent_spec("codex").unwrap();
        assert!(probe_conflicts(&dir, codex.official_account.as_ref().unwrap()).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn official_launch_conflicts_block_settings_env_residuals() {
        // 官方账号启动防线：进程级盖不过的磁盘残留（Grok config.toml 的 api_key）必须拦在启动前，
        // 否则「官方账号」会话实际走 API 计费；Claude 的 settings.json env 改由 --settings 空串盖过，不再拦
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::create_dir_all(dir.join(".grok")).unwrap();
        std::fs::write(
            dir.join(".claude/settings.json"),
            r#"{"env": {"ANTHROPIC_BASE_URL": "https://gw.example.com", "ANTHROPIC_AUTH_TOKEN": "sk-disk-secret"}}"#,
        )
        .unwrap();
        std::fs::write(dir.join(".grok/config.toml"), "api_key = \"sk-disk-secret\"\n").unwrap();
        let mut claude = profile("claude-code", None);
        claude.account_type = crate::profiles::AccountType::Official;
        assert!(official_launch_conflicts(&dir, &claude).is_empty());
        let mut grok = profile("grok", None);
        grok.account_type = crate::profiles::AccountType::Official;
        let joined = official_launch_conflicts(&dir, &grok).join("；");
        assert!(joined.contains("~/.grok/config.toml") && joined.contains("api_key"));
        assert!(!joined.contains("sk-disk-secret"), "只报变量名不读值");
        // API 连接不触发该防线（API 模式本来就注入这些变量）
        let api = profile("grok", Some("https://gw.example.com"));
        assert!(official_launch_conflicts(&dir, &api).is_empty());
        // codex 官方账号无探测项（启动用 -c model_provider 盖过）
        let mut codex = profile("codex", None);
        codex.account_type = crate::profiles::AccountType::Official;
        assert!(official_launch_conflicts(&dir, &codex).is_empty());
        // Gemini：认证方式不是 Google 账号登录就拦
        let mut gemini = profile("gemini", None);
        gemini.account_type = crate::profiles::AccountType::Official;
        assert!(official_launch_conflicts(&dir, &gemini)[0].contains("gemini-api-key"));
        tests::TEST_GEMINI_AUTH.with(|k| *k.borrow_mut() = Some("oauth-personal".into()));
        assert!(official_launch_conflicts(&dir, &gemini).is_empty());
        tests::TEST_GEMINI_AUTH.with(|k| *k.borrow_mut() = Some("gemini-api-key".into()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn official_launch_conflicts_empty_when_settings_clean() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(dir.join(".claude/settings.json"), r#"{"model": "opus"}"#).unwrap();
        let mut official = profile("claude-code", None);
        official.account_type = crate::profiles::AccountType::Official;
        assert!(official_launch_conflicts(&dir, &official).is_empty());
        // 文件缺失同样放行（probe 语义：缺失/不可读静默跳过）
        std::fs::remove_dir_all(&dir).ok();
        assert!(official_launch_conflicts(&dir, &official).is_empty());
    }

    #[test]
    fn api_launch_notes_flag_disk_residuals_without_blocking() {
        // API 连接的提醒：磁盘残留会盖过本次注入——只提示，不进 ensure_launch_credentials 的
        // Err 路径（那种连接今天本来就能用，硬拦会打断既有工作流）
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".gemini")).unwrap();
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(dir.join(".gemini/.env"), "GEMINI_API_KEY=sk-disk-secret\n").unwrap();
        let api = profile("gemini", Some("https://relay.example.com"));
        let notes = api_launch_conflict_notes(&dir, &api);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("~/.gemini/.env"));
        assert!(notes[0].contains("GEMINI_API_KEY"));
        assert!(!notes[0].contains("sk-disk-secret"), "只报变量名不读值");
        // 提醒归提醒，凭证检查对带密钥的 API 连接照常放行
        assert!(ensure_launch_credentials(&api, Some("sk-secret")).is_ok());
        // Claude / CodeBuddy 的连接键由 --settings 覆盖层盖过，不再提醒
        std::fs::write(dir.join(".claude/settings.json"), r#"{"env": {"ANTHROPIC_AUTH_TOKEN": "sk"}}"#).unwrap();
        let claude = profile("claude-code", Some("https://open.bigmodel.cn/api/anthropic"));
        assert!(api_launch_conflict_notes(&dir, &claude).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn api_overlay_blanks_other_providers_connection_keys() {
        let p = profile("claude-code", Some("https://gw.example.com"));
        tests::TEST_CLAUDE_USER_KEYS.with(|k| {
            *k.borrow_mut() = vec![
                "ANTHROPIC_API_KEY".into(),
                "ANTHROPIC_CUSTOM_HEADERS".into(),
                "CLAUDE_CODE_USE_BEDROCK".into(),
                "AWS_PROFILE".into(),
                "DISABLE_TELEMETRY".into(),
            ]
        });
        tests::TEST_CLAUDE_TOP_KEYS.with(|k| *k.borrow_mut() = vec!["apiKeyHelper".into(), "hooks".into()]);
        let plan = launch_plan(&p, Some("sk-mesa".into()), Some("m1")).unwrap();
        let path = &plan.args[plan.args.iter().position(|a| a == "--settings").unwrap() + 1];
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-mesa");
        assert_eq!(v["env"]["ANTHROPIC_API_KEY"], "");
        assert_eq!(v["env"]["ANTHROPIC_CUSTOM_HEADERS"], "");
        assert_eq!(v["env"]["CLAUDE_CODE_USE_BEDROCK"], "");
        assert!(v["env"].get("AWS_PROFILE").is_none() && v["env"].get("DISABLE_TELEMETRY").is_none());
        assert_eq!(v["apiKeyHelper"], "");
        assert!(v.get("hooks").is_none());
        tests::TEST_CLAUDE_USER_KEYS.with(|k| k.borrow_mut().clear());
        tests::TEST_CLAUDE_TOP_KEYS.with(|k| k.borrow_mut().clear());

        // CodeBuddy：五个连接键都进覆盖文件，磁盘那家的盖不过来
        let p = profile("codebuddy", Some("https://gw.example.com/v1"));
        let plan = launch_plan(&p, Some("sk-mesa".into()), Some("m1")).unwrap();
        let path = &plan.args[plan.args.iter().position(|a| a == "--settings").unwrap() + 1];
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(v["env"]["CODEBUDDY_BASE_URL"], "https://gw.example.com/v1");
        assert_eq!(v["env"]["CODEBUDDY_API_KEY"], "sk-mesa");
        assert_eq!(v["env"]["CODEBUDDY_MODEL"], "m1");
        assert_eq!(v["env"]["CODEBUDDY_AUTH_TOKEN"], "");
        assert!(!plan.args.iter().any(|a| a.contains("sk-mesa")), "密钥不进命令行");
    }

    #[test]
    fn external_ps1_script_text_carries_no_env_or_credentials() {
        // audit P0：ps1 只含自删 + 启动命令；密钥走 start 环境块继承，不落脚本
        let text =
            external_ps1_script_text("C:\\tools\\claude.cmd", &["读 简报".into(), "it's".into()]);
        assert!(
            text.starts_with('\u{FEFF}'),
            "powershell 5.1 GBK 解码坑：BOM 不能丢"
        );
        assert!(text.contains("& 'C:\\tools\\claude.cmd'"));
        assert!(text.contains("'it''s'"), "单引号加倍转义");
        assert!(!text.contains("$env:"), "脚本不得写环境变量");
        assert!(
            !text.contains("Remove-Item Env:"),
            "env_remove 也在父进程环境块完成"
        );
    }

    #[test]
    fn sweep_stale_external_wrappers_removes_only_old_launch_files() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let stale = dir.join("launch-old.sh");
        let fresh = dir.join("launch-fresh.sh");
        let other = dir.join("keep.txt");
        std::fs::write(&stale, "x").unwrap();
        std::fs::write(&fresh, "x").unwrap();
        std::fs::write(&other, "x").unwrap();
        let file = std::fs::File::options().write(true).open(&stale).unwrap();
        file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(600))
            .unwrap();
        drop(file);
        sweep_stale_external_wrappers(&dir);
        assert!(!stale.exists(), "超龄 launch- 文件被清扫");
        assert!(fresh.exists(), "新 wrapper 不动（终端可能还没读到）");
        assert!(other.exists(), "非 launch- 前缀不动");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn qwen_conflict_probe_flags_dotenv_residual_keys() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".qwen")).unwrap();
        std::fs::write(
            dir.join(".qwen/.env"),
            "OPENAI_API_KEY=sk-super-secret-value\nDASHSCOPE_API_KEY=sk-other\n",
        )
        .unwrap();
        let spec = crate::agent_specs::agent_spec("qwen").unwrap();
        let oa = spec.official_account.as_ref().unwrap();
        let conflicts = probe_conflicts(&dir, oa);
        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].contains("~/.qwen/.env"));
        assert!(conflicts[0].contains("OPENAI_API_KEY"));
        // DASHSCOPE_API_KEY 不在探测清单（是否压 OAuth 未核实，见注册表注释）
        assert!(!conflicts[0].contains("DASHSCOPE_API_KEY"));
        assert!(!conflicts[0].contains("sk-super-secret-value"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn qwen_plan_defaults_to_openai_protocol() {
        let p = profile(
            "qwen",
            Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
        );
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("qwen3-coder")).unwrap();
        assert!(plan
            .env
            .contains(&("OPENAI_API_KEY".into(), "sk-secret".into())));
        assert!(plan.env.contains(&(
            "OPENAI_BASE_URL".into(),
            "https://dashscope.aliyuncs.com/compatible-mode/v1".into()
        )));
        assert!(plan
            .env
            .contains(&("OPENAI_MODEL".into(), "qwen3-coder".into())));
        assert!(!plan.env.iter().any(|(k, _)| k.starts_with("ANTHROPIC_")));
        assert_eq!(plan.args, vec!["--auth-type", "openai"]);
    }

    #[test]
    fn qwen_plan_anthropic_protocol() {
        let mut p = profile("qwen", Some("https://relay.example.com"));
        p.protocol = Some("anthropic".into());
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("claude-sonnet-4")).unwrap();
        assert!(plan
            .env
            .contains(&("ANTHROPIC_API_KEY".into(), "sk-secret".into())));
        assert!(plan.env.contains(&(
            "ANTHROPIC_BASE_URL".into(),
            "https://relay.example.com".into()
        )));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_MODEL".into(), "claude-sonnet-4".into())));
        assert!(!plan.env.iter().any(|(k, _)| k.starts_with("OPENAI_")));
        assert_eq!(plan.args, vec!["--auth-type", "anthropic"]);
    }

    #[test]
    fn opencode_plan_inlines_config_json() {
        let mut p = profile("opencode", Some("https://openrouter.ai/api/v1"));
        p.models = vec!["m1".into(), "m2".into()];
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("m2")).unwrap();
        assert!(plan
            .env
            .contains(&("OPENCODE_DISABLE_AUTOUPDATE".into(), "1".into())));
        let (k, v) = plan
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .expect("OPENCODE_CONFIG_CONTENT 应存在");
        assert_eq!(k, "OPENCODE_CONFIG_CONTENT");
        let config: serde_json::Value = serde_json::from_str(v).expect("应为合法 JSON");
        let ccode = &config["provider"]["ccode"];
        assert_eq!(ccode["npm"], "@ai-sdk/openai-compatible");
        assert_eq!(ccode["options"]["baseURL"], "https://openrouter.ai/api/v1");
        assert_eq!(ccode["options"]["apiKey"], "sk-secret");
        assert!(ccode["models"]["m1"].is_object());
        assert!(ccode["models"]["m2"].is_object());
        assert_eq!(config["model"], "ccode/m2");
    }

    #[test]
    fn opencode_plan_without_model_omits_top_level_model() {
        let p = profile("opencode", None);
        let plan = launch_plan(&p, None, None).unwrap();
        let (_, v) = plan
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .unwrap();
        let config: serde_json::Value = serde_json::from_str(v).unwrap();
        assert!(config.get("model").is_none());
        // 没有 key/base_url 时 options 里不放这两个字段
        assert!(config["provider"]["ccode"]["options"]
            .get("apiKey")
            .is_none());
        assert!(config["provider"]["ccode"]["options"]
            .get("baseURL")
            .is_none());
    }

    #[test]
    fn kimi_plan_sets_both_env_groups() {
        let p = profile("kimi", Some("https://api.moonshot.cn/v1"));
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("kimi-k2")).unwrap();
        // 新版合成通道
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_NAME".into(), "kimi-k2".into())));
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_PROVIDER_TYPE".into(), "kimi".into())));
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_API_KEY".into(), "sk-secret".into())));
        assert!(plan.env.contains(&(
            "KIMI_MODEL_BASE_URL".into(),
            "https://api.moonshot.cn/v1".into()
        )));
        // 旧版 Python CLI
        assert!(plan
            .env
            .contains(&("KIMI_API_KEY".into(), "sk-secret".into())));
        assert!(plan
            .env
            .contains(&("KIMI_BASE_URL".into(), "https://api.moonshot.cn/v1".into())));
        // 合成模型元数据：显示名 = profile 名 · 模型；上下文按模型映射（k2 = 128K）
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_DISPLAY_NAME".into(), "测试 · kimi-k2".into())));
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_MAX_CONTEXT_SIZE".into(), "131072".into())));
        // kimi 官方协议不注入 CAPABILITIES（CLI 默认 ["image_in","thinking"] 已合理）
        assert!(!plan.env.iter().any(|(k, _)| k == "KIMI_MODEL_CAPABILITIES"));
        assert_eq!(plan.args, kimi_env_model_args(kimi_variant()));
    }

    #[test]
    fn kimi_env_channel_names_synthetic_alias_except_legacy() {
        // 续聊（-S）按会话里存的模型走，换连接要靠 -m 点名合成别名才生效
        assert_eq!(kimi_env_model_args(Some("new")), vec!["-m", "__kimi_env_model__"]);
        assert_eq!(kimi_env_model_args(None), vec!["-m", "__kimi_env_model__"]);
        assert!(kimi_env_model_args(Some("legacy")).is_empty());
    }

    #[test]
    fn kimi_plan_thinking_model_declares_capabilities_on_compat_protocol() {
        let mut p = profile("kimi", Some("https://relay.example.com/v1"));
        p.protocol = Some("openai".into());
        let plan = launch_plan(&p, None, Some("kimi-k2-thinking")).unwrap();
        // 兼容协议通道：确知思考 → 加 thinking；视觉未确知 → 保留 env 缺省里的 image_in
        // （缺省 ["image_in","thinking"]，见 agents.rs 正文注释的二进制实证）。
        // 该数组是完备声明，未确知就保留缺省成员，不替 CLI 摘掉它。
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_CAPABILITIES".into(), "tool_use,thinking,image_in".into())));
        assert!(plan.env.contains(&(
            "KIMI_MODEL_DISPLAY_NAME".into(),
            "测试 · kimi-k2-thinking".into()
        )));
    }

    #[test]
    fn kimi_plan_plain_model_declares_capabilities_union_with_default() {
        // 非思考模型：thinking 确知为假 → 摘掉；视觉未确知 → 保留。
        // env 通道缺省是已知有限集 ["image_in","thinking"]，含 image_in 但**不含 tool_use**，
        // 而该数组是完备声明（CLI 用 some(===) 判成员），故这里写的是
        // 「缺省集去掉确知为假的成员，再加回缺省本就欠的 tool_use」——
        // 只做加法与「确知为假才摘」，估值层猜测不参与。
        let mut p = profile("kimi", Some("https://relay.example.com/v1"));
        p.protocol = Some("openai".into());
        let plan = launch_plan(&p, None, Some("deepseek-chat")).unwrap();
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_CAPABILITIES".into(), "tool_use,image_in".into())));
        // 显示名照常注入；上下文窗口**不写**——deepseek-chat 在内置表里 context=None
        // （只标了不思考），单测其余三层为空。env 通道未设时 kimi 走
        // `parsePositiveInt(raw) ?? DEFAULT_MAX_CONTEXT_SIZE` 兜底，不报错，
        // 所以不写是安全的；写 128K 猜测反而会让真实窗口被按 128K 算。
        assert!(plan.env.contains(&(
            "KIMI_MODEL_DISPLAY_NAME".into(),
            "测试 · deepseek-chat".into()
        )));
        assert!(!plan
            .env
            .iter()
            .any(|(k, _)| k == "KIMI_MODEL_MAX_CONTEXT_SIZE"));
    }

    #[test]
    fn kimi_plan_vision_model_declares_image_in_on_compat_protocol() {
        // 多模态思考模型（kimi-k3）：tool_use + thinking + image_in
        let mut p = profile("kimi", Some("https://relay.example.com/v1"));
        p.protocol = Some("openai".into());
        let plan = launch_plan(&p, None, Some("kimi-k3")).unwrap();
        assert!(plan.env.contains(&(
            "KIMI_MODEL_CAPABILITIES".into(),
            "tool_use,thinking,image_in".into()
        )));
        // 纯视觉非思考模型（gpt-4o）：tool_use + image_in，不带 thinking
        let mut p = profile("kimi", Some("https://relay.example.com/v1"));
        p.protocol = Some("openai".into());
        let plan = launch_plan(&p, None, Some("gpt-4o")).unwrap();
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_CAPABILITIES".into(), "tool_use,image_in".into())));
        // kimi 官方协议通道：CLI 缺省 ["image_in","thinking"] 已合理，不注入
        let p = profile("kimi", None);
        let plan = launch_plan(&p, None, Some("kimi-k3")).unwrap();
        assert!(!plan.env.iter().any(|(k, _)| k == "KIMI_MODEL_CAPABILITIES"));
    }

    #[test]
    fn kimi_plan_respects_protocol_for_provider_type() {
        let mut p = profile("kimi", None);
        p.protocol = Some("anthropic".into());
        let plan = launch_plan(&p, None, Some("claude-sonnet-4")).unwrap();
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_PROVIDER_TYPE".into(), "anthropic".into())));
    }

    #[test]
    fn kimi_plan_without_model_skips_synthetic_channel() {
        let p = profile("kimi", Some("https://api.moonshot.cn/v1"));
        let plan = launch_plan(&p, Some("sk-secret".into()), None).unwrap();
        assert!(!plan.env.iter().any(|(k, _)| k.starts_with("KIMI_MODEL_")));
        // 没有合成模型就不能点名它的别名
        assert!(!plan.args.iter().any(|a| a == KIMI_ENV_MODEL_ALIAS));
        // 旧版组不受模型缺失影响
        assert!(plan
            .env
            .contains(&("KIMI_API_KEY".into(), "sk-secret".into())));
        assert!(plan
            .env
            .contains(&("KIMI_BASE_URL".into(), "https://api.moonshot.cn/v1".into())));
    }

    #[test]
    fn opencode_inject_json_registers_every_profile_model() {
        let mut p = profile("opencode", Some("https://openrouter.ai/api/v1"));
        p.models = vec!["m1".into(), "m2".into(), "m3".into()];
        let plan = launch_plan(&p, None, Some("m2")).unwrap();
        let (_, v) = plan
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .unwrap();
        let config: serde_json::Value = serde_json::from_str(v).unwrap();
        let models = config["provider"]["ccode"]["models"].as_object().unwrap();
        for m in ["m1", "m2", "m3"] {
            assert!(models.contains_key(m), "provider.ccode.models 缺 {m}");
            // 每个条目带显示名（配置名 · 模型）与 limit.context（注册表保守默认 128K）
            // + limit.output（opencode 1.18 起 schema 必填，缺省 8192）
            assert_eq!(
                models[m]["name"].as_str(),
                Some(format!("测试 · {m}").as_str())
            );
            assert_eq!(models[m]["limit"]["context"].as_i64(), Some(131_072));
            assert_eq!(models[m]["limit"]["output"].as_i64(), Some(8192));
        }
        // provider 级 name = profile 名（选择器不再显示内部 id "ccode"）
        assert_eq!(config["provider"]["ccode"]["name"].as_str(), Some("测试"));
        // 表外未知模型不声明 reasoning
        assert!(models["m1"].get("reasoning").is_none());
        // 视觉模型补 modalities（input 含 image）；非视觉模型不声明
        let v2 = opencode_provider_json(
            &{
                let mut p2 = profile("opencode", Some("https://openrouter.ai/api/v1"));
                p2.models = vec!["kimi-k3".into(), "deepseek-chat".into()];
                p2
            },
            None,
            None,
        );
        let models2 = v2["models"].as_object().unwrap();
        assert_eq!(
            models2["kimi-k3"]["modalities"]["input"],
            serde_json::json!(["text", "image"])
        );
        assert!(models2["deepseek-chat"].get("modalities").is_none());
    }

    #[test]
    fn opencode_inject_marks_thinking_model_reasoning() {
        // 注册表命中思考模型 → models 条目带 reasoning: true
        let mut p = profile("opencode", Some("https://openrouter.ai/api/v1"));
        p.models = vec!["deepseek-reasoner".into()];
        let plan = launch_plan(&p, None, None).unwrap();
        let (_, v) = plan
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .unwrap();
        let config: serde_json::Value = serde_json::from_str(v).unwrap();
        assert_eq!(
            config["provider"]["ccode"]["models"]["deepseek-reasoner"]["reasoning"],
            true
        );
    }

    #[test]
    fn codex_catalog_contains_every_model_with_template_shape() {
        let v = codex_catalog_json("测试", &["gpt-5-codex".into(), "gpt-5.1".into()]);
        let models = v["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        let e = &models[0];
        assert_eq!(e["slug"], "gpt-5-codex");
        // display_name 带 profile 名（选择器不再是裸模型 id）
        assert_eq!(e["display_name"], "测试 · gpt-5-codex");
        assert_eq!(models[1]["slug"], "gpt-5.1");
        // 关键枚举拼写与打包条目一致（codex-rs models-manager/models.json）
        assert_eq!(e["shell_type"], "shell_command");
        assert_eq!(e["visibility"], "list");
        // freeform apply_patch 会中转被拒（cc-switch 实证）→ 不声明，走 shell 版
        assert!(e.get("apply_patch_tool_type").is_none());
        // base_instructions 用 Codex 自己的默认提示词（教模型用 apply_patch），不是一句话占位
        let bi = e["base_instructions"].as_str().unwrap();
        assert!(bi.starts_with("You are a coding agent running in the Codex CLI"));
        assert!(bi.contains("apply_patch") && !bi.contains('\r'));
        assert_eq!(bi.contains("shell: \"bash\""), cfg!(windows), "Windows 补充只在 Windows 上带");
        assert_eq!(e["truncation_policy"]["mode"], "tokens");
        assert_eq!(e["default_verbosity"], "low");
        assert_eq!(e["supported_in_api"], true);
        let efforts: Vec<&str> = e["supported_reasoning_levels"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|l| l["effort"].as_str())
            .collect();
        assert_eq!(efforts, ["low", "medium", "high", "xhigh", "ultra", "max"]);
        // 能力字段：有效上下文 95%（自动压缩阈值）、如实声明无 search tool
        assert_eq!(e["effective_context_window_percent"], 95);
        assert_eq!(e["supports_search_tool"], false);
        assert_eq!(e["supports_reasoning_summaries"], true);
        assert_eq!(e["service_tiers"], serde_json::json!([]));
        // 窗口与图像输入都是 catalog 的**可选**字段（codex 解析器只强制
        // supports_reasoning_summaries/base_instructions）→ 未确知就不写，
        // 让 codex 用自己的默认值，而不是替它断言一个猜测值。
        // gpt-5 系在内置表里 context=None、vision=None，单测里其余三层为空 → 两个键都缺
        assert!(e.get("context_window").is_none());
        assert!(e.get("max_context_window").is_none());
        assert!(e.get("input_modalities").is_none());
        // 确知多模态且确知窗口（kimi-k3）→ 两个键都写
        let v2 = codex_catalog_json("测试", &["kimi-k3".into()]);
        assert_eq!(
            v2["models"][0]["input_modalities"],
            serde_json::json!(["text", "image"])
        );
        assert_eq!(v2["models"][0]["context_window"], serde_json::json!(1_048_576));
    }

    #[test]
    fn codex_instructions_read_from_rollout_first_line() {
        let body = format!("You are a coding agent.\r\nUse `apply_patch`.\r\n{}", "x".repeat(3000));
        let meta = serde_json::json!({"type":"session_meta","payload":{"base_instructions":{"text": body}}});
        let text = format!("{meta}\n{{\"type\":\"turn_context\"}}\n");
        let got = codex_instructions_from_rollout(&text).unwrap();
        assert!(got.starts_with("You are a coding agent.\nUse `apply_patch`.\n"), "换行统一成 LF");
        // 首行不是 session_meta、内容太短或不像提示词：不收（不能把它缓存下来）
        assert!(codex_instructions_from_rollout("{\"type\":\"turn_context\"}\n").is_none());
        let short = serde_json::json!({"type":"session_meta","payload":{"base_instructions":{"text":"You are a coding agent."}}});
        assert!(codex_instructions_from_rollout(&short.to_string()).is_none());
        // 随包兜底本身得过同一道门
        assert!(plausible_codex_instructions(CODEX_BASE_INSTRUCTIONS));
    }

    /// 手动跑：真起本机 codex 取默认提示词（不联网、临时目录用完即删）。`cargo test --lib codex_instructions_extract_real -- --ignored --nocapture`
    #[test]
    #[ignore = "需要本机装着 codex"]
    fn codex_instructions_extract_real() {
        let t = std::time::Instant::now();
        let text = extract_codex_base_instructions().expect("取不到");
        eprintln!("{} 字，用时 {:?}，开头：{}", text.chars().count(), t.elapsed(), &text[..80]);
        assert!(plausible_codex_instructions(&text));
        // 临时目录（后台重试删）几秒内清干净
        std::thread::sleep(std::time::Duration::from_secs(4));
        let tmp = crate::storage::config_root().unwrap().join("tmp");
        let left = std::fs::read_dir(&tmp)
            .map(|d| d.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("codex-instructions-")).count())
            .unwrap_or(0);
        assert_eq!(left, 0, "临时目录没删干净");
    }

    #[test]
    fn codex_catalog_written_atomically() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("catalogs").join("codex-p1.json");
        write_codex_catalog_to(&path, "测试", &["m1".into()], None).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["models"][0]["slug"], "m1");
        assert_eq!(v["models"][0]["display_name"], "测试 · m1");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_plan_tool_follows_instructions() {
        let on = vec!["-c".to_string(), "tools.update_plan.enabled=true".to_string()];
        let prompt = "You have access to an `update_plan` tool";
        assert_eq!(codex_plan_tool_args(prompt, true, None), on);
        // 提示词没提、旧版 Codex、用户自己配过：都不加
        assert!(codex_plan_tool_args("no plan here", true, None).is_empty());
        assert!(codex_plan_tool_args(prompt, false, None).is_empty());
        let user: toml::Value = toml::from_str("[tools.update_plan]\nenabled = false\n").unwrap();
        assert!(codex_plan_tool_args(prompt, true, Some(&user)).is_empty());
        let other: toml::Value = toml::from_str("[windows]\nsandbox = \"elevated\"\n").unwrap();
        assert_eq!(codex_plan_tool_args(prompt, true, Some(&other)), on);
        // 内嵌的默认提示词确实提到它（本机取不到时用这份）
        assert!(CODEX_BASE_INSTRUCTIONS.contains("update_plan"));
    }

    #[test]
    fn codex_catalog_arg_is_toml_quoted() {
        let args = catalog_args(std::path::Path::new(
            "/Users/x/Library/Application Support/ccode/catalogs/codex-1.json",
        ));
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "-c");
        assert!(
            args[1].starts_with(r#"model_catalog_json=""#) && args[1].ends_with('"'),
            "路径必须是 TOML 字符串（带引号）: {}",
            args[1]
        );
        assert!(args[1].contains("codex-1.json"));
    }

    #[test]
    fn codex_catalog_arg_uses_forward_slashes() {
        // TOML 基本字符串里 `\U` 是非法转义；Windows 路径必须改成正斜杠
        let args = catalog_args(std::path::Path::new(
            r"C:\Users\x\AppData\Roaming\ccode\catalogs\codex-1.json",
        ));
        assert!(!args[1].contains('\\'), "不得残留反斜杠: {}", args[1]);
        assert!(
            args[1].contains("C:/Users/x/AppData/Roaming/ccode/catalogs/codex-1.json"),
            "{}",
            args[1]
        );
    }

    #[test]
    fn find_in_dirs_picks_first_existing_candidate() {
        let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let d1 = base.join("d1");
        let d2 = base.join("d2");
        std::fs::create_dir_all(&d1).unwrap();
        std::fs::create_dir_all(&d2).unwrap();
        std::fs::write(d1.join("tool"), "x").unwrap();
        std::fs::write(d2.join("tool"), "x").unwrap();
        // 两个目录都有同名文件时排前的目录胜出
        assert_eq!(
            find_in_dirs("tool", &[d1.clone(), d2.clone()]),
            Some(d1.join("tool"))
        );
        // 只在后一个候选目录存在也能找到（前面的目录 miss 不阻断）
        assert_eq!(
            find_in_dirs("tool", &[base.join("nope"), d2.clone()]),
            Some(d2.join("tool"))
        );
        // 目录不存在 / 文件不存在 → None
        assert_eq!(find_in_dirs("tool", &[base.join("nope")]), None);
        assert_eq!(find_in_dirs("ghost", &[d1.clone(), d2.clone()]), None);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn extended_path_appends_existing_candidates_in_order() {
        let p = |s: &str| PathBuf::from(s);
        let gui = std::env::join_paths([p("/usr/bin"), p("/bin"), p("/usr/local/bin")]).unwrap();
        let candidates = [p("/home/u/.local/bin"), p("/nope"), p("/opt/homebrew/bin"), p("/usr/local/bin")];
        let exists = |d: &Path| d != Path::new("/nope");
        let next = extended_path(Some(&gui), &candidates, exists).expect("有要补的目录");
        // 原有顺序不动，存在的候选按候选顺序追加；不存在的、已在 PATH 上的不补
        assert_eq!(
            std::env::split_paths(&next).collect::<Vec<_>>(),
            [p("/usr/bin"), p("/bin"), p("/usr/local/bin"), p("/home/u/.local/bin"), p("/opt/homebrew/bin")]
        );
        // 从终端启动（候选都已在 PATH 上）→ 不改
        assert_eq!(extended_path(Some(&next), &candidates, exists), None);
        // 没有 PATH 时只剩候选
        let only = extended_path(None, &candidates[..1], exists).unwrap();
        assert_eq!(std::env::split_paths(&only).collect::<Vec<_>>(), [p("/home/u/.local/bin")]);
    }

    #[cfg(windows)]
    #[test]
    fn find_in_dirs_matches_exe_and_cmd_shims_on_windows() {
        let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        // npm 全局包在 Windows 上是 .cmd shim：裸名找不到、带扩展名能命中
        std::fs::write(base.join("tool.cmd"), "x").unwrap();
        assert_eq!(
            find_in_dirs("tool", &[base.clone()]),
            Some(base.join("tool.cmd"))
        );
        // 裸名（shell 脚本）与 .cmd 并存时 .cmd 胜出：裸名在 Windows 上不可执行（os error 193）
        std::fs::write(base.join("tool2"), "x").unwrap();
        std::fs::write(base.join("tool2.cmd"), "x").unwrap();
        assert_eq!(
            find_in_dirs("tool2", &[base.clone()]),
            Some(base.join("tool2.cmd"))
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn resolve_binary_returns_none_for_unknown_name() {
        // 名字足够独特：PATH 与各平台候选目录都不会有
        assert!(resolve_binary("ccode-no-such-binary-9f8e7d6c").is_none());
    }

    #[test]
    fn resume_command_line_formats_per_agent() {
        // 安全字符不加引号（cc-switch 风格）；codex 的 resume 子命令在最前
        assert_eq!(
            resume_command_line("codex", "019fbd46-bdc5", "/tmp/proj").unwrap(),
            "cd /tmp/proj && codex resume 019fbd46-bdc5"
        );
        assert_eq!(
            resume_command_line("claude-code", "abc", "/tmp/proj").unwrap(),
            "cd /tmp/proj && claude -r abc"
        );
        assert_eq!(
            resume_command_line("kimi", "abc", "/tmp/proj").unwrap(),
            "cd /tmp/proj && kimi -S abc"
        );
        assert_eq!(
            resume_command_line("opencode", "abc", "/tmp/proj").unwrap(),
            "cd /tmp/proj && opencode --session abc"
        );
        assert_eq!(
            resume_command_line("codebuddy", "abc", "/tmp/proj").unwrap(),
            "cd /tmp/proj && codebuddy -r abc"
        );
        assert_eq!(
            resume_command_line("cursor", "abc", "/tmp/proj").unwrap(),
            "cd /tmp/proj && cursor-agent --resume abc"
        );
        assert_eq!(
            resume_command_line("grok", "abc", "/tmp/proj").unwrap(),
            "cd /tmp/proj && grok -r abc"
        );
        // 路径含空格/中文 → 单引号包裹
        assert_eq!(
            resume_command_line("codex", "abc", "/tmp/我的 项目").unwrap(),
            "cd '/tmp/我的 项目' && codex resume abc"
        );
        // 未知 agent 报错
        assert!(resume_command_line("no-such", "abc", "/tmp").is_err());
        // 外部拉起变体：给定绝对路径直接用
        assert_eq!(
            resume_command_line_with("kimi", "abc", "/tmp", "/Users/x/.kimi-code/bin/kimi", &[])
                .unwrap(),
            "cd /tmp && /Users/x/.kimi-code/bin/kimi -S abc"
        );
        // 绝对路径含空格 → binary 也必须 shell 转义（否则命令行在空格处断裂）
        assert_eq!(
            resume_command_line_with("kimi", "abc", "/tmp", "/Users/x/My Apps/bin/kimi", &[])
                .unwrap(),
            "cd /tmp && '/Users/x/My Apps/bin/kimi' -S abc"
        );
    }

    #[test]
    fn resume_command_with_codex_inline_provider() {
        // codex 内联 provider 会话（rollout 记 model_provider="ccode"）外部恢复必须带 -c 定义，
        // 否则报 "Model provider `ccode` not found"；定义只含 base_url/env_key 引用，不含密钥
        let extra = resume_extra_args("codex", Some("https://relay.example.com/v1"), None);
        let cmd = resume_command_line_with("codex", "abc", "/tmp/proj", "codex", &extra).unwrap();
        // kv 值含双引号 → 单引号包裹（sh_quote_if_needed），语义无损
        assert!(
            cmd.contains(r#"-c 'model_providers.ccode.base_url="https://relay.example.com/v1"'"#)
        );
        assert!(cmd.contains(r#"-c 'model_provider="ccode"'"#));
        assert!(cmd.contains(r#"-c 'web_search="disabled"'"#));
        assert!(cmd.contains(r#"-c 'service_tier="auto"'"#));
        assert!(!cmd.contains("features.apps=false"));
        assert!(cmd.contains("plugins.codex-app-tools@openai-bundled.enabled=false"));
        assert!(cmd.starts_with("cd /tmp/proj && codex resume abc"));
        // 非 codex / 无 base_url：不追加任何定义（env 注入型 agent 裸 resume 即可）
        assert!(resume_extra_args("claude-code", Some("https://x"), None).is_empty());
        assert!(resume_extra_args("codex", None, None).is_empty());
        assert!(resume_extra_args("codex", Some("  "), None).is_empty());
        let bare = resume_command_line_with(
            "codex",
            "abc",
            "/tmp/proj",
            "codex",
            &resume_extra_args("codex", None, None),
        )
        .unwrap();
        assert_eq!(bare, "cd /tmp/proj && codex resume abc");
        let derived = resume_extra_args(
            "codex",
            Some("https://relay.example.com/v1"),
            Some("ccode-a1b2c3d4"),
        );
        let derived_cmd =
            resume_command_line_with("codex", "abc", "/tmp/proj", "codex", &derived).unwrap();
        assert!(derived_cmd.contains(
            r#"-c 'model_providers.ccode-a1b2c3d4.base_url="https://relay.example.com/v1"'"#
        ));
        assert!(derived_cmd.contains(r#"-c 'model_provider="ccode-a1b2c3d4"'"#));
        assert!(!derived_cmd.contains(r#"model_provider="ccode""#));
    }

    #[test]
    fn windows_resume_line_uses_powershell_dialect() {
        // PowerShell：Set-Location + & 调用操作符；单引号包裹路径
        assert_eq!(
            windows_resume_command_line(
                "claude-code",
                "abc",
                r"C:\work\my proj",
                r"C:\tools\claude.cmd",
                &[]
            )
            .unwrap(),
            r#"Set-Location 'C:\work\my proj'; & 'C:\tools\claude.cmd' -r 'abc'"#
        );
        let line =
            windows_resume_command_line("kimi", "abc", r"C:\it's\proj", "kimi", &[]).unwrap();
        assert_eq!(line, r#"Set-Location 'C:\it''s\proj'; & 'kimi' -S 'abc'"#);
        assert!(windows_resume_command_line("no-such", "abc", r"C:\x", "x", &[]).is_err());
        let with_provider = windows_resume_command_line(
            "codex",
            "abc",
            r"C:\p",
            "codex",
            &resume_extra_args("codex", Some("https://relay.example.com/v1"), None),
        )
        .unwrap();
        assert!(with_provider.contains("-c"));
        assert!(
            with_provider.contains(r#"model_provider="ccode""#)
                || with_provider.contains("'model_provider=")
        );
    }

    #[test]
    fn digest_command_line_formats_per_agent() {
        let prompt = "读 .ccode/handoff-x.md 接力简报，继续完成任务";
        // Positional：prompt 追加为位置参数（含空格/中文 → 单引号包裹）
        assert_eq!(
            digest_command_line_with("claude-code", "/tmp/proj", prompt, "claude").unwrap(),
            format!("cd /tmp/proj && claude '{prompt}'")
        );
        assert_eq!(
            digest_command_line_with("codex", "/tmp/proj", prompt, "codex").unwrap(),
            format!("cd /tmp/proj && codex '{prompt}'")
        );
        // Flag：-i '<prompt>'
        assert_eq!(
            digest_command_line_with("gemini", "/tmp/proj", prompt, "gemini").unwrap(),
            format!("cd /tmp/proj && gemini -i '{prompt}'")
        );
        // Unsupported（kimi）与未知 agent 报错；OpenCode 1.18.x 已支持 --prompt
        assert!(digest_command_line_with("kimi", "/tmp/proj", prompt, "kimi").is_err());
        assert_eq!(
            digest_command_line_with("opencode", "/tmp/proj", prompt, "opencode").unwrap(),
            format!("cd /tmp/proj && opencode --prompt '{prompt}'")
        );
        assert!(digest_command_line_with("no-such", "/tmp", prompt, "x").is_err());
        // cwd 与绝对路径二进制的转义（同 resume 口径）
        assert_eq!(
            digest_command_line_with(
                "qwen",
                "/tmp/我的 项目",
                prompt,
                "/Users/x/My Apps/bin/qwen"
            )
            .unwrap(),
            format!("cd '/tmp/我的 项目' && '/Users/x/My Apps/bin/qwen' -i '{prompt}'")
        );
        // prompt 内嵌单引号 → POSIX 转义
        let quoted =
            digest_command_line_with("claude-code", "/tmp", "读 it's 简报", "claude").unwrap();
        assert_eq!(quoted, "cd /tmp && claude '读 it'\\''s 简报'");
    }

    #[test]
    fn external_plan_reuses_profile_injections_without_putting_key_in_args() {
        let mut p = profile("codex", Some("https://relay.example.com/v1"));
        p.models = vec!["deepseek-v4".into()];
        let (args, env, _) = external_launch_args(
            "codex",
            &p,
            Some("sk-secret".into()),
            Some("deepseek-v4"),
            Some("session-1"),
            None,
        )
        .unwrap();
        assert!(args.iter().any(|a| a == "model_provider=\"ccode\""));
        assert!(args.iter().any(|a| a == "deepseek-v4"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "CODEX_API_KEY" && v == "sk-secret"));
        assert!(!args.iter().any(|a| a.contains("sk-secret")));
    }

    #[test]
    fn external_launch_requires_an_explicit_profile_id() {
        assert!(require_external_profile_id(None).is_err());
        assert!(require_external_profile_id(Some("  ")).is_err());
        assert_eq!(require_external_profile_id(Some(" p1 ")).unwrap(), "p1");
    }

    #[test]
    fn no_auth_profile_cleans_inherited_credentials() {
        let mut p = profile("codex", Some("http://127.0.0.1:11434/v1"));
        p.no_auth = true;
        let plan = launch_plan(&p, None, Some("local-model")).unwrap();
        assert!(plan.env_remove.contains(&"OPENAI_API_KEY".to_string()));
        assert!(plan.env_remove.contains(&"CODEX_API_KEY".to_string()));
    }

    #[test]
    fn external_digest_locks_fixed_session_agents_to_a_new_session_id() {
        let mut p = profile("claude-code", Some("https://relay.example.com"));
        p.models = vec!["sonnet-custom".into()];
        let (args, _, _) = external_launch_args(
            "claude-code",
            &p,
            Some("sk-secret".into()),
            Some("sonnet-custom"),
            None,
            Some("读取简报继续"),
        )
        .unwrap();
        let pos = args.iter().position(|a| a == "--session-id").unwrap();
        assert!(!args[pos + 1].is_empty());
        assert_eq!(args.last().map(String::as_str), Some("读取简报继续"));
    }

    #[cfg(unix)]
    #[test]
    fn external_wrapper_is_private_and_contains_no_secret_in_path() {
        use std::os::unix::fs::PermissionsExt;
        let wrapper = write_external_wrapper(
            "/bin/echo",
            &["hello world".into()],
            &[("CCODE_TEST_SECRET".into(), "sk-secret".into())],
            &["NO_COLOR".into()],
        )
        .unwrap();
        let mode = std::fs::metadata(&wrapper).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert!(!wrapper.to_string_lossy().contains("sk-secret"));
        let body = std::fs::read_to_string(&wrapper).unwrap();
        assert!(body.contains("CCODE_TEST_SECRET='sk-secret'"));
        assert!(body.contains("exec '/bin/echo' 'hello world'"));
        let _ = std::fs::remove_file(wrapper);
    }

    #[cfg(unix)]
    #[test]
    fn external_wrapper_executes_and_removes_itself_before_agent_start() {
        let wrapper =
            write_external_wrapper("/usr/bin/printf", &["%s".into(), "ok".into()], &[], &[])
                .unwrap();
        let out = std::process::Command::new("/bin/sh")
            .arg(&wrapper)
            .output()
            .unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "ok");
        assert!(!wrapper.exists());
    }

    #[test]
    fn windows_digest_line_uses_powershell_dialect() {
        let line = windows_digest_command_line(
            "claude-code",
            r"C:\work\my proj",
            "读简报",
            r"C:\tools\claude.cmd",
        )
        .unwrap();
        assert_eq!(
            line,
            r#"Set-Location 'C:\work\my proj'; & 'C:\tools\claude.cmd' '读简报'"#
        );
        let line = windows_digest_command_line("gemini", r"C:\x", "读简报", "gemini").unwrap();
        assert_eq!(line, r#"Set-Location 'C:\x'; & 'gemini' -i '读简报'"#);
        assert!(windows_digest_command_line("kimi", r"C:\x", "读简报", "kimi").is_err());
    }

    #[test]
    fn windows_external_cmd_host_quotes_and_skips_powershell() {
        let line = windows_external_start_line_cmd(
            r"C:\work\my proj",
            r"C:\tools\claude.cmd",
            &["-r".into(), "abc".into()],
        );
        assert_eq!(
            line,
            r#"start "Mesa" /D "C:\work\my proj" cmd.exe /S /K "C:\tools\claude.cmd -r abc""#
        );
        assert!(!line.contains("powershell"));
        let spaced = windows_external_start_line_cmd(
            r"C:\work",
            r"C:\Program Files\kimi\kimi.exe",
            &["-S".into(), "sid".into()],
        );
        // /S 只剥最外一对引号：路径自己的引号完整留给内层 cmd
        assert!(spaced.ends_with(r#"cmd.exe /S /K ""C:\Program Files\kimi\kimi.exe" -S sid""#));
        assert_eq!(cmd_quote_arg(r#"a"b"#), r#""a""b""#);
        // 内联命令行上 %% 不是转义：cmd_quote_arg 不再加倍，批处理正文才加倍
        assert_eq!(cmd_quote_arg("a%PATH%"), r#""a%PATH%""#);
        assert_eq!(batch_quote_arg("a%PATH%"), r#""a%%PATH%%""#);
        assert_eq!(batch_quote_arg("l1\r\nl2\nl3"), r#""l1 l2 l3""#);
    }

    #[test]
    fn windows_external_cmd_escapes_outer_layer_and_routes_percent_to_wrapper() {
        // 外层 cmd /C 看来内层引号里的内容是裸露的：特殊字符要加 ^，路径括号也算
        let line = windows_external_start_line_cmd(
            r"C:\w",
            r"C:\Program Files (x86)\n\codex.cmd",
            &["a&b".into(), "plain".into()],
        );
        assert!(
            line.ends_with(r#"/S /K ""C:\Program Files ^(x86^)\n\codex.cmd" "a^&b" plain""#),
            "{line}"
        );
        assert_eq!(
            windows_external_cmd_inline(r"C:\w", "codex", &["-r".into(), "id".into()]),
            Some(r#"start "Mesa" /D "C:\w" cmd.exe /S /K "codex -r id""#.to_string())
        );
        for bad in ["100%", "%PATH%", "l1\nl2", "a\rb"] {
            assert!(
                windows_external_cmd_inline(r"C:\w", "codex", &[bad.into()]).is_none(),
                "{bad:?} 必须改走批处理包装"
            );
        }
        assert!(windows_external_cmd_inline(r"C:\w", r"C:\100%\codex.cmd", &[]).is_none());
        let long = "x".repeat(WINDOWS_START_LINE_MAX);
        assert!(windows_external_cmd_inline(r"C:\w", "codex", &[long]).is_none());
        let body = external_cmd_wrapper_body(r"C:\Program Files\c.cmd", &["50% off".into()]);
        assert_eq!(
            body,
            "@echo off\r\nchcp 65001 >nul\r\n\"C:\\Program Files\\c.cmd\" \"50%% off\"\r\n"
        );
    }

    /// 真机：外层 cmd /C start（与生产同一 spawn_windows_start）→ 内层 cmd /S，程序在含空格和括号的
    /// 目录里，参数含空格/&/|/^/括号/引号；包装器路径验证 % 原样到达。用 /B /WAIT + /C 不开可见窗口
    #[cfg(windows)]
    #[test]
    fn windows_cmd_start_line_survives_real_cmd() {
        let root = std::env::temp_dir().join(format!("ccode-start-{}", uuid::Uuid::new_v4()));
        let bin_dir = root.join("Program Files (x86)").join("my tool");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let out = bin_dir.join("out.txt");
        let echo = bin_dir.join("echo args.cmd");
        std::fs::write(&echo, "@echo %*> \"%~dp0out.txt\"\r\n").unwrap();
        let echo_s = echo.to_string_lossy().into_owned();
        let cwd = root.to_string_lossy().into_owned();

        let args: Vec<String> = [
            "a b", "x&y", "a^b", "p|q", "(paren)", "<lt>", r#"say "hi""#, "plain",
        ]
        .map(String::from)
        .to_vec();
        let line = windows_cmd_start_line_with(&cwd, "/B /WAIT", "/C", &echo_s, &args);
        spawn_windows_start(&line, &[], &[]).unwrap();
        assert_eq!(
            std::fs::read_to_string(&out).unwrap().trim_end(),
            r#""a b" "x&y" "a^b" "p|q" "(paren)" "<lt>" "say ""hi""" plain"#
        );

        std::fs::remove_file(&out).unwrap();
        let wrapper = bin_dir.join("launch wrapper.cmd");
        let pct: Vec<String> = ["100%", "%PATH%", "l1\nl2"].map(String::from).to_vec();
        std::fs::write(&wrapper, external_cmd_wrapper_body(&echo_s, &pct)).unwrap();
        let line =
            windows_cmd_start_line_with(&cwd, "/B /WAIT", "/C", &wrapper.to_string_lossy(), &[]);
        spawn_windows_start(&line, &[], &[]).unwrap();
        assert_eq!(
            std::fs::read_to_string(&out).unwrap().trim_end(),
            r#""100%" "%PATH%" "l1 l2""#
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn windows_external_powershell_host_uses_noexit_file() {
        let line = windows_external_start_line_ps(
            r"C:\work\my proj",
            Path::new(r"C:\Users\x\AppData\Roaming\ccode\external-launch\launch-1.ps1"),
        );
        assert_eq!(
            line,
            "start \"Mesa\" /D \"C:\\work\\my proj\" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File \"C:\\Users\\x\\AppData\\Roaming\\ccode\\external-launch\\launch-1.ps1\""
        );
        assert!(line.contains("-NoExit"));
        assert!(!line.contains("cmd.exe /K"));
    }

    #[cfg(unix)]
    #[test]
    fn version_with_timeout_reads_first_line() {
        let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let bin = base.join("fake-cli");
        std::fs::write(&bin, "#!/bin/sh\necho '1.2.3 (Fake CLI)'\necho second\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(
            version_with_timeout(&bin, std::time::Duration::from_secs(5)),
            Some("1.2.3 (Fake CLI)".into())
        );
        // 空输出 → None
        std::fs::write(&bin, "#!/bin/sh\nexit 0\n").unwrap();
        assert_eq!(
            version_with_timeout(&bin, std::time::Duration::from_secs(5)),
            None
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn gemini_version_probe_uses_mesa_scratch_home() {
        let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        // 叫 gemini 的假 CLI：版本行里回显它看到的 GEMINI_CLI_HOME
        let gemini = base.join("gemini");
        let other = base.join("qwen");
        for bin in [&gemini, &other] {
            std::fs::write(bin, "#!/bin/sh\necho \"9.9.9 ${GEMINI_CLI_HOME:-unset}\"\n").unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let probe_home = std::env::temp_dir().join("ccode-gemini-probe");
        assert_eq!(
            version_with_timeout(&gemini, std::time::Duration::from_secs(5)),
            Some(format!("9.9.9 {}", probe_home.display()))
        );
        // 预放的登记文件在 Mesa 的临时目录里，Gemini 因此不再写 projects.json.*.tmp
        assert!(probe_home.join(".gemini").join("projects.json").is_file());
        // 别家 CLI 不受影响（环境里本来没有就还是没有）
        if std::env::var_os("GEMINI_CLI_HOME").is_none() {
            assert_eq!(
                version_with_timeout(&other, std::time::Duration::from_secs(5)),
                Some("9.9.9 unset".into())
            );
        }
        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn version_with_timeout_kills_hung_cli() {
        let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let bin = base.join("hung-cli");
        // --version 永不返回：超时后必须杀掉并返回 None（不能无限阻塞）
        std::fs::write(&bin, "#!/bin/sh\nsleep 60\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(
            version_with_timeout(&bin, std::time::Duration::from_millis(300)),
            None
        );
        // 子进程已被杀掉（防挂死兜底之外不做墙钟时序硬断言）
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn sh_quote_if_needed_escapes_single_quote() {
        assert_eq!(sh_quote_if_needed("plain-1.x"), "plain-1.x");
        assert_eq!(sh_quote_if_needed("it's"), "'it'\\''s'");
    }

    #[test]
    fn expand_home_path_resolves_tilde_before_shell_quoting() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand_home_path("~"), home.to_string_lossy());
        assert_eq!(
            expand_home_path("~/Mesa project"),
            home.join("Mesa project").to_string_lossy()
        );
        assert_eq!(expand_home_path("/tmp/project"), "/tmp/project");
    }

    #[cfg(unix)]
    #[test]
    fn iterm_script_writes_into_the_window_it_created() {
        let cmd = r#"cd '/Users/a/Mesa project' && /bin/sh '/x/launch "q".sh'"#;
        let warm = iterm_script(cmd, true);
        assert!(warm.contains(&"set w to (create window with default profile)".to_string()));
        assert!(!warm.iter().any(|l| l.contains("current window")), "不能写进当前焦点窗口");
        let last = &warm[warm.len() - 2];
        assert!(last.starts_with("tell current session of w to write text \""));
        assert!(last.contains(r#"launch \"q\".sh"#), "双引号要转义：{last}");
        // 冷启动：等 iTerm 自己开的窗口，不另建第二个
        let cold = iterm_script(cmd, false);
        assert!(cold.iter().any(|l| l == "set w to current window"));
        assert!(cold.iter().any(|l| l.starts_with("repeat 30 times")));
    }

    #[cfg(unix)]
    #[test]
    fn external_wrapper_command_does_not_single_quote_tilde() {
        let wrapper = Path::new("/tmp/ccode-wrapper.sh");
        let cmd = external_wrapper_command("~/Mesa project", wrapper);
        assert!(cmd.starts_with("cd "));
        assert!(!cmd.contains("cd '~"));
        assert!(cmd.contains("Mesa project"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn candidate_dirs_cover_homebrew_prefixes() {
        let dirs = crate::agent_specs::binary_candidate_dirs();
        assert!(dirs
            .iter()
            .any(|d| d == std::path::Path::new("/opt/homebrew/bin")));
        assert!(dirs
            .iter()
            .any(|d| d == std::path::Path::new("/usr/local/bin")));
        // MacTeX/TeXLive（latexmk）：GUI 短 PATH 兜底，批次 E LaTeX 编译链
        assert!(dirs
            .iter()
            .any(|d| d == std::path::Path::new("/Library/TeX/texbin")));
        // node 版本管理器（volta/mise）固定 shim 目录：GUI 短 PATH 兜底
        assert!(dirs.iter().any(|d| d.ends_with(".volta/bin")));
        assert!(dirs.iter().any(|d| d.ends_with(".local/share/mise/shims")));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn candidate_dirs_cover_node_manager_shims() {
        let dirs = crate::agent_specs::binary_candidate_dirs();
        // node 版本管理器（volta/mise）固定 shim 目录
        assert!(dirs.iter().any(|d| d.ends_with(".volta/bin")));
        assert!(dirs.iter().any(|d| d.ends_with(".local/share/mise/shims")));
    }

    #[cfg(windows)]
    #[test]
    fn paste_binary_avoids_ps1_shims() {
        // 解析得到的必须是 .exe / .cmd 绝对路径（不经 npm 的 .ps1，躲开 Restricted 执行策略）
        let node = windows_paste_binary("node");
        assert!(
            node.to_ascii_lowercase().ends_with("node.exe"),
            "{node}"
        );
        // 解析不到就退回裸名
        assert_eq!(windows_paste_binary("ccode-no-such-cli-7f3a"), "ccode-no-such-cli-7f3a");
    }

    #[cfg(windows)]
    #[test]
    fn candidate_dirs_cover_git_for_windows() {
        let dirs = crate::agent_specs::binary_candidate_dirs();
        // winget Git.Git / 官方安装器默认落点 %ProgramFiles%\Git\cmd
        assert!(dirs
            .iter()
            .any(|d| d.ends_with(std::path::Path::new("Git").join("cmd"))));
        // PowerShell 7 MSI 默认落点：Mesa 开着时装上，不重启也能认出
        assert!(dirs
            .iter()
            .any(|d| d.ends_with(std::path::Path::new("PowerShell").join("7"))));
    }

    #[cfg(windows)]
    #[test]
    fn git_bash_paths_cover_per_user_install() {
        let paths = git_bash_default_paths();
        let per_user = dirs::data_local_dir().unwrap().join("Programs").join("Git").join("bin").join("bash.exe");
        assert!(paths.contains(&per_user), "「仅为我安装」的 Git Bash");
        // 全机安装排在前面
        assert!(paths.first().unwrap().ends_with(std::path::Path::new("Git").join("bin").join("bash.exe")));
        assert_ne!(paths.first(), Some(&per_user));
    }

    #[cfg(windows)]
    #[test]
    fn candidate_dirs_cover_tinytex_from_quarto() {
        let dirs = crate::agent_specs::binary_candidate_dirs();
        // quarto install tinytex 落点 %APPDATA%\TinyTeX\bin\windows（旧版 win32）
        let tinytex = std::path::Path::new("TinyTeX").join("bin");
        assert!(dirs.iter().any(|d| d.ends_with(tinytex.join("windows"))));
        assert!(dirs.iter().any(|d| d.ends_with(tinytex.join("win32"))));
    }
}
