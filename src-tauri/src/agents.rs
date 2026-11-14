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
        | "KIMI_MODEL_TEMPERATURE"
        | "KIMI_MODEL_TOP_P"
        | "KIMI_MODEL_MAX_COMPLETION_TOKENS"
        | "KIMI_CODE_CUSTOM_HEADERS"
        | "GEMINI_CLI_CUSTOM_HEADERS"
        | "QWEN_CODE_MAX_OUTPUT_TOKENS" => return "请求策略",
        // grok 的模型名单收敛 + 请求策略 [models] 全局默认都装在这个 overlay 里
        "GROK_CONFIG" => return "Grok overlay",
        // 文件里是本次连接的认证方式 / 模型 / 条目（不含密钥），盖过用户 settings.json
        "QWEN_CODE_SYSTEM_SETTINGS_PATH" => return "连接覆盖层",
        _ => {}
    }
    if name.starts_with("ANTHROPIC_DEFAULT_") || name.starts_with("ANTHROPIC_CUSTOM_MODEL_OPTION") {
        return "模型选择器";
    }
    if name == "CLAUDE_CODE_MAX_CONTEXT_TOKENS" || name == "CLAUDE_CODE_AUTO_COMPACT_WINDOW" {
        return "能力声明（注册链确知窗口不是 200K 才注入）";
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

/// 预览用的启动计划（含密钥值，只给预览命令内部用，出站前各自脱敏）：返回套好组合的连接、选中的模型、计划
pub(crate) fn launch_preview_inputs(
    store: &ProfileStore,
    profile_id: &str,
    model: Option<&str>,
) -> Result<(Profile, Option<String>, LaunchPlan), String> {
    let mut profile = store.get_with_model(profile_id, model)?;
    let key = crate::profiles::get_key_for_profile(&profile)?;
    let selected = model
        .filter(|m| !m.trim().is_empty())
        .map(str::to_string)
        .or_else(|| profile.models.first().cloned());
    crate::combo::apply_to_profile(&mut profile, selected.as_deref());
    let plan = launch_plan(&profile, key, selected.as_deref())?;
    Ok((profile, selected, plan))
}

/// 返回不含密钥值的启动计划，供配置页诊断和跨平台问题排查使用。
#[tauri::command]
pub fn preview_launch_plan(
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
    model: Option<String>,
) -> Result<LaunchPlanPreviewDto, String> {
    launch_plan_preview(&store, &profile_id, model.as_deref())
}

pub(crate) fn launch_plan_preview(
    store: &ProfileStore,
    profile_id: &str,
    model: Option<&str>,
) -> Result<LaunchPlanPreviewDto, String> {
    let (profile, selected, plan) = launch_preview_inputs(store, profile_id, model)?;
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
        if let Some(home) = crate::dirs::home_dir() {
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
        .or_else(|| find_in_dirs(name, &registry_path_dirs()))
}

/// Windows：Mesa 启动后才写进注册表 PATH 的目录。没开开发者模式的机器上 winget 建不了
/// Links 里的符号链接，改把 `WinGet\Packages\<包>` 写进用户 PATH（winget PortableInstaller 的回落），
/// 进程 PATH 和候选目录都没有它——不补这一步，装完显示成功、却仍是「未安装」，重启 Mesa 才认。
/// 其他只改 PATH 的安装器同理。只在前两步 miss 时读，两次注册表读取
#[cfg(windows)]
fn registry_path_dirs() -> Vec<std::path::PathBuf> {
    crate::process::child_path()
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default()
}

/// 非 Windows 的 PATH 不存注册表；启动后出现的候选目录已由 binary_candidate_dirs 覆盖
#[cfg(not(windows))]
fn registry_path_dirs() -> Vec<std::path::PathBuf> {
    Vec::new()
}

/// 启动时把候选目录里存在的补到本进程 PATH 末尾（只追加、不改原有顺序，已在 PATH 上的不重复），
/// 之后起的所有子进程都继承这份。resolve_binary 能在候选目录里找到 npm 装的 CLI，但它们多是
/// `#!/usr/bin/env node` 脚本，子进程沿用 Finder 给的短 PATH 就找不到 node、一起就退出
/// （2026-10-27 本机：node 在 /opt/homebrew/bin，打包版 Codex / Gemini / CodeBuddy 起不来）；
/// Agent 里再起的 git / rg / python / MCP 服务器也要同一份。必须在起任何线程之前调（set_var 不是线程安全的）。
/// Windows 的 GUI 进程本就拿到注册表里的完整 PATH，不动。启动后才装出来的目录由 process::child_path
/// 在起子进程时补（三平台都是）。
#[cfg(unix)]
pub fn extend_process_path() {
    let candidates = crate::agent_specs::binary_candidate_dirs();
    if let Some(next) = extended_path(std::env::var_os("PATH").as_deref(), &candidates, |d| d.is_dir()) {
        std::env::set_var("PATH", next);
    }
}

/// extend_process_path 的纯逻辑：没有要补的返回 None。起子进程时 process::child_path 也用它补
/// 启动后才出现的目录
#[cfg_attr(not(any(unix, test)), allow(dead_code))]
pub(crate) fn extended_path(
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
    if let Some(local) = crate::dirs::data_local_dir() {
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
    let mut dirs = crate::agent_specs::binary_candidate_dirs();
    dirs.extend(registry_path_dirs());
    for p in find_all_in_dirs(name, &dirs) {
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
        "gemini" => "；注意：个人 Google 账号已不能用 Gemini CLI（Google 改推 Antigravity），只有 Workspace / 企业版 Code Assist 账号还能用，个人用户可在 Mesa 里直接选 Antigravity CLI 或改用 API 连接",
        _ => "",
    }
}

/// Claude Code 官方登录状态：macOS 上凭证在系统钥匙串、不落 ~/.claude/.credentials.json，
/// 只看文件会把已登录的人显示成「未登录」、让人以为要重新登录。文件查不到时问 `claude auth status`
/// （只读，JSON 的 loggedIn / authMethod；2.1.308 实证；2.1.318 起另有 loginExpiresAt）。None = 问不到（没装 / 超时 / 输出变了）
fn claude_auth_status() -> Option<(bool, String, Option<i64>)> {
    let path = resolve_binary("claude")?;
    let args = ["auth", "status", "--json"];
    let timeout = std::time::Duration::from_secs(8);
    // 磁盘 settings.json（「设为全局默认」写的中转）或进程环境里有 ANTHROPIC_AUTH_TOKEN / API_KEY 时，
    // claude auth status 会把它当成登录（authMethod=oauth_token）说「已登录」，而 Mesa 启动官方账号时这些键都被盖空，
    // 实际是未登录（2026-10-29 用户：连接页显示官方已登录，发消息却是 Not logged in）。这种情形换一个看不到令牌的环境再问一次
    let text = if claude_token_shadowed() {
        cli_output_neutral_claude(&path, &args, timeout)?
    } else {
        cli_output_with_timeout(&path, &args, timeout)?
    };
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let logged_in = v.get("loggedIn")?.as_bool()?;
    let method = v.get("authMethod").and_then(|m| m.as_str()).unwrap_or("").to_string();
    Some((logged_in, method, v.get("loginExpiresAt").and_then(expiry_epoch_secs)))
}

/// 到期时间读成秒：ISO 时间串，或数字（毫秒 / 秒）。格式认不出返回 None（不猜）
fn expiry_epoch_secs(v: &serde_json::Value) -> Option<i64> {
    if let Some(s) = v.as_str() {
        return chrono::DateTime::parse_from_rfc3339(s.trim()).ok().map(|t| t.timestamp());
    }
    let n = v.as_i64()?;
    Some(if n > 100_000_000_000 { n / 1000 } else { n })
}

/// 官方登录快到期时的一句提醒（2.1.318 起 -p 会在到期前 10 天提醒，连接页同口径）；还早或已过都不说
fn login_expiry_note(expires_at: Option<i64>, now: i64) -> Option<String> {
    let left = expires_at? - now;
    if !(0..=10 * 86_400).contains(&left) {
        return None;
    }
    let days = left / 86_400;
    Some(if days == 0 {
        "这次登录今天到期，到期后要点「官方登录」重新登录".into()
    } else {
        format!("这次登录还有 {days} 天到期，到期后要点「官方登录」重新登录")
    })
}

const CLAUDE_SHADOW_KEYS: &[&str] = &["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

/// settings.json 的 env 里有会顶替官方登录的令牌键
fn settings_text_shadows_login(text: &str) -> bool {
    !settings_env_conflict_keys(text, CLAUDE_SHADOW_KEYS).is_empty()
}

fn claude_token_shadowed() -> bool {
    #[cfg(test)]
    {
        return false;
    }
    #[cfg(not(test))]
    {
        if CLAUDE_SHADOW_KEYS.iter().any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty())) {
            return true;
        }
        let dir = std::env::var("CLAUDE_CONFIG_DIR")
            .ok()
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| crate::dirs::home_dir().map(|h| h.join(".claude")));
        dir.and_then(|d| std::fs::read_to_string(d.join("settings.json")).ok())
            .is_some_and(|t| settings_text_shadows_login(&t))
    }
}

/// 在看不到令牌的环境里跑 claude 子命令：令牌类变量置空；再把 HOME 指到空临时目录，磁盘 settings.json 的 env 就读不到。
/// 钥匙串搜索列表按 HOME 找 ~/Library/Keychains，临时目录里必须链回真 Library，否则官方登录永远读成「未登录」
/// （2026-10-31 实证：订阅卡读得到余量、连接页却说没登录）。CLAUDE_CONFIG_DIR 自定义时钥匙串项名随目录变，不动 HOME
fn cli_output_neutral_claude(path: &std::path::Path, args: &[&str], timeout: std::time::Duration) -> Option<String> {
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut envs: Vec<(String, String)> = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]
        .iter()
        .map(|k| ((*k).to_string(), String::new()))
        .collect();
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut tmp: Option<PathBuf> = None;
    #[cfg(target_os = "macos")]
    if std::env::var_os("CLAUDE_CONFIG_DIR").is_none_or(|v| v.is_empty()) {
        let dir = std::env::temp_dir().join(format!("mesa-claude-probe-{}", uuid::Uuid::new_v4().simple()));
        if std::fs::create_dir_all(&dir).is_ok() {
            let linked = crate::dirs::home_dir()
                .is_some_and(|h| std::os::unix::fs::symlink(h.join("Library"), dir.join("Library")).is_ok());
            if linked {
                envs.push(("HOME".into(), dir.to_string_lossy().into_owned()));
            }
            tmp = Some(dir);
        }
    }
    let out = cli_output_with_env(path, args, &envs, timeout);
    if let Some(dir) = tmp {
        let _ = std::fs::remove_dir_all(dir);
    }
    out
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
    // Header 名=环境变量名 → "Name: value" 逐行（claude/codebuddy/kimi 同格式，\n 连接，二进制实证）；
    // gemini 按逗号切（0.66 parseCustomHeaders：`,(?=\s*[^,:]+:)`），用 ", " 连
    let inject_headers_sep = |plan: &mut LaunchPlan, env_key: &str, sep: &str| {
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
            plan.env.push((env_key.into(), lines.join(sep)));
        }
    };
    let inject_headers = |plan: &mut LaunchPlan, env_key: &str| inject_headers_sep(plan, env_key, "\n");
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
            // temperature/top_p/思考档走系统设置覆盖层里本次条目的 samplingParams（qwen_system_settings_overlay）；
            // env 只有 QWEN_CODE_MAX_OUTPUT_TOKENS 一条，条目带了 max_tokens 时 qwen 跳过它（条目优先），留着兜底
            if let Some(v) = policy.max_output_tokens {
                plan.env
                    .push(("QWEN_CODE_MAX_OUTPUT_TOKENS".into(), v.to_string()));
            }
        }
        "kimi" => {
            // 2026-11-04 假网关实测（2.4.1）：KIMI_MODEL_TEMPERATURE / TOP_P / MAX_COMPLETION_TOKENS 进合成通道的
            // modelOverrides，kimi / openai / anthropic 三种协议都发（openai、anthropic 发成 max_tokens）；只在合成通道
            // 启用（有 KIMI_MODEL_NAME）时才生效。KIMI_CODE_CUSTOM_HEADERS 每行「名: 值」，所有渠道都带。
            // 思考档另在 KimiDualChannel 臂里注（只有 kimi 协议读）
            if let Some(v) = policy.temperature {
                plan.env.push(("KIMI_MODEL_TEMPERATURE".into(), v.to_string()));
            }
            if let Some(v) = policy.top_p {
                plan.env.push(("KIMI_MODEL_TOP_P".into(), v.to_string()));
            }
            if let Some(v) = policy.max_output_tokens {
                plan.env
                    .push(("KIMI_MODEL_MAX_COMPLETION_TOKENS".into(), v.to_string()));
            }
            inject_headers(plan, "KIMI_CODE_CUSTOM_HEADERS");
        }
        "gemini" => {
            // 2026-11-04 假网关实测 0.66：gemini-api-key / gateway 认证下每个请求都带
            inject_headers_sep(plan, "GEMINI_CLI_CUSTOM_HEADERS", ", ");
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
        .or_else(|| crate::dirs::home_dir().map(|h| h.join(".claude")));
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
            .or_else(|| crate::dirs::home_dir().map(|h| h.join(".claude")))
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
            .or_else(|| crate::dirs::home_dir().map(|h| h.join(".claude")))?;
        let text = std::fs::read_to_string(dir.join("settings.json")).ok()?;
        serde_json::from_str::<serde_json::Value>(&text)
            .ok()?
            .get("model")?
            .as_str()
            .map(str::to_string)
    }
}

/// Claude Code 四个别名各指向哪个模型（与前端 `src/role-models.ts claudeAliasMap` 双端镜像，`tests/fixtures/claude-slots.json` 共读）：
/// - haiku：指定了后台小模型用它；
/// - 显式映射（`role_models.slots` 为 Some，2026-10-30 起）：表里有的用它，没有的跟默认（`fill`）；
/// - 旧绑定（None）：名单前四个依次占 sonnet / opus / haiku / fable，不够的跟默认。
/// 名单为空时 `fill` 为 None，没指定的槽不写（沿用 Claude 自己的映射）。表里的模型不在名单里的当没设
pub(crate) fn claude_slot_models(profile: &Profile, fill: Option<&str>) -> Vec<(&'static str, Option<String>)> {
    let listed = |m: &String| profile.models.iter().any(|x| x == m);
    let roles = &profile.role_models;
    ["sonnet", "opus", "haiku", "fable"]
        .into_iter()
        .enumerate()
        .map(|(i, slot)| {
            let small = if slot == "haiku" { roles.small.clone().filter(listed) } else { None };
            let pinned = match &roles.slots {
                Some(map) => map.get(slot).filter(|m| listed(m)).cloned(),
                None => profile.models.get(i).cloned(),
            };
            (slot, small.or(pinned).or_else(|| fill.map(String::from)))
        })
        .collect()
}

/// /model 菜单里另加的一项（ANTHROPIC_CUSTOM_MODEL_OPTION）：旧绑定是名单第 5 个；显式映射时是名单里第一个
/// 没被任何别名占用、也不是默认的模型（否则它在 /model 里选不到）
pub(crate) fn claude_custom_option(profile: &Profile, fill: Option<&str>) -> Option<String> {
    match &profile.role_models.slots {
        None => profile.models.get(4).cloned(),
        Some(_) => {
            let used: Vec<String> = claude_slot_models(profile, fill).into_iter().filter_map(|(_, m)| m).collect();
            profile
                .models
                .iter()
                .find(|m| !used.contains(m) && Some(m.as_str()) != fill)
                .cloned()
        }
    }
}

/// Claude Code 对不认识的模型 ID 假设的上下文窗口（官方 model-config「Correct the window for a gateway or custom model ID」）
pub(crate) const CLAUDE_ASSUMED_WINDOW: i64 = 200_000;

/// 声明上下文窗口的两个键：`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 是「这个模型的真实窗口」（不以 claude- 开头、不带 [1m]
/// 的 ID 直接生效，大小不限），自动压缩窗口与它同值成对（cc-switch 校准口径：只抬上限不抬它，压缩点留在旧档）。
/// 压缩窗口只收 100K–1M，低于 100K 时会被当成 100K，这时不写它——Claude 按声明的窗口压缩（2026-11-01：
/// 以前只在确知 >200K 时声明，128K 这类模型被当成 200K，会话没压缩就先撞上网关上限）
pub(crate) fn claude_window_env(ctx: i64) -> Vec<(String, String)> {
    let mut env = vec![("CLAUDE_CODE_MAX_CONTEXT_TOKENS".to_string(), ctx.to_string())];
    if ctx >= 100_000 {
        env.push(("CLAUDE_CODE_AUTO_COMPACT_WINDOW".to_string(), ctx.to_string()));
    }
    env
}

/// Claude Code 的「谁用哪个模型」整套 env（--settings 覆盖层与进程 env 共用这一份，2026-10-17 端到端核对后重写）。
///
/// 假网关实测（Claude 2.1.292）：Mesa 原先只按绑定名单填前几个槽位，用户全局 settings.json 里的
/// ANTHROPIC_DEFAULT_HAIKU_MODEL / CLAUDE_CODE_SUBAGENT_MODEL 照样生效——会话标题生成、子 agent 的请求带着
/// 全局的 glm-5.3 打到 Mesa 选的网关，换成别家网关就直接失败。所以：
/// - 四个槽位全填：绑定名单不够四个时，空槽用这次选的模型（没选用名单第一个）补上；ANTHROPIC_SMALL_FAST_MODEL 跟 HAIKU 槽。
/// - 子 agent 模型只在用户全局设了时才盖（设成这次的模型）：没设时保持 Claude 原生「继承主模型 / 按 frontmatter 选」。
/// - 上下文窗口：确知且不是 200K 时声明（claude_window_env）；用户全局设过而这次不确知时写回 Claude 对未知模型的默认 200000，免得沿用全局的 1M。
pub(crate) fn claude_model_env(profile: &Profile, model: Option<&str>, user_keys: &[String]) -> Vec<(String, String)> {
    let mut env = Vec::new();
    let selected = model.map(str::trim).filter(|m| !m.is_empty());
    let fill = selected.or_else(|| profile.models.iter().map(String::as_str).find(|m| !m.trim().is_empty()));
    // 空槽只在绑定列了模型（第三方网关）时补：没列模型 = 用 Claude 自己的别名映射，不去改它
    let slot_fill = if profile.models.is_empty() { None } else { fill };
    // 连接里「模型分工」指定的后台小模型 / 子 Agent 模型（RoleModels）：指定了就用，没指定跟主模型
    let small = profile.role_models.small.as_deref();
    let subagent = profile.role_models.subagent.as_deref();
    let display = |m: &str| {
        profile
            .role_models
            .display_names
            .get(m)
            .cloned()
            .unwrap_or_else(|| format!("{} · {m}", profile.name))
    };
    let mut haiku = None;
    for (slot, m) in claude_slot_models(profile, slot_fill) {
        let Some(m) = m else { continue };
        if slot == "haiku" {
            haiku = Some(m.clone());
        }
        let up = slot.to_ascii_uppercase();
        env.push((format!("ANTHROPIC_DEFAULT_{up}_MODEL"), m.clone()));
        env.push((format!("ANTHROPIC_DEFAULT_{up}_MODEL_NAME"), display(&m)));
    }
    if let Some(extra) = claude_custom_option(profile, slot_fill) {
        env.push(("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".into(), display(&extra)));
        env.push(("ANTHROPIC_CUSTOM_MODEL_OPTION".into(), extra));
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
        Some(c) if c != CLAUDE_ASSUMED_WINDOW => Some(c),
        _ if user_has("CLAUDE_CODE_MAX_CONTEXT_TOKENS") || user_has("CLAUDE_CODE_AUTO_COMPACT_WINDOW") => {
            Some(declared.unwrap_or(CLAUDE_ASSUMED_WINDOW))
        }
        _ => None,
    };
    if let Some(c) = ctx {
        env.extend(claude_window_env(c));
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
pub(crate) const CLAUDE_CONNECTION_TOP_KEYS: &[&str] = &["apiKeyHelper", "fallbackModel"];

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
/// 给授权范围（grant.rs）新建 Claude 设置覆盖文件用：同一目录、同一 0600 写法
pub(crate) fn write_settings_overlay_file_pub(prefix: &str, body: &str) -> Result<String, String> {
    write_settings_overlay_file(prefix, body)
}

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
        .map_err(|e| format!("创建设置覆盖文件失败: {e}"))?;
    use std::io::Write;
    file.write_all(body.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| {
            let _ = std::fs::remove_file(&path);
            format!("写入设置覆盖文件失败: {e}")
        })?;
    schedule_wrapper_cleanup(path.clone());
    Ok(path.to_string_lossy().into_owned())
}

/// Antigravity CLI 会话级 `--settings` 文件：落 `<config_root>/agy-settings/<uuid>.json`（0700 目录 / 0600 文件）。
/// 不能复用 `external-launch` 的 60 秒自删（会话中途 `/model` 或续聊还要读它；文件内不含任何密钥，只扫 >7 天旧文件）。
/// 走 `storage::config_root()`，使单测与金丝雀的 `TestConfigRoot` 重定向生效，不碰真实配置目录。
fn agy_settings_dir() -> Option<std::path::PathBuf> {
    #[cfg(test)]
    {
        let thread = format!("{:?}", std::thread::current().id())
            .replace(|c: char| !c.is_ascii_alphanumeric(), "");
        return Some(
            std::env::temp_dir()
                .join(format!("ccode-test-config-{thread}"))
                .join("ccode")
                .join("agy-settings"),
        );
    }
    #[cfg(not(test))]
    Some(crate::storage::config_root()?.join("agy-settings"))
}

fn write_agy_session_settings(profile: &Profile, picked: &str) -> Result<String, String> {
    let dir = agy_settings_dir().ok_or("无法确定平台配置目录")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 Antigravity 会话设置目录失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("收紧 Antigravity 会话设置目录权限失败: {e}"))?;
    }
    sweep_stale_agy_settings(&dir);
    let body = agy_session_settings_body(
        profile,
        picked,
        agy_user_settings_text(profile).as_deref(),
    )
    .to_string();
    let path = dir.join(format!("{}.json", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| format!("创建 Antigravity 会话设置文件失败: {e}"))?;
    use std::io::Write;
    file.write_all(body.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| {
            let _ = std::fs::remove_file(&path);
            format!("写入 Antigravity 会话设置文件失败: {e}")
        })?;
    Ok(path.to_string_lossy().into_owned())
}

fn sweep_stale_agy_settings(dir: &std::path::Path) {
    let Some(cutoff) =
        std::time::SystemTime::now().checked_sub(std::time::Duration::from_secs(7 * 86_400))
    else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.path().extension().is_some_and(|e| e == "json")
            && entry
                .metadata()
                .and_then(|m| m.modified())
                .is_ok_and(|mtime| mtime < cutoff)
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn agy_user_settings_text(profile: &Profile) -> Option<String> {
    #[cfg(test)]
    {
        let _ = profile;
        return tests::TEST_AGY_SETTINGS.with(|k| k.borrow().clone());
    }
    #[cfg(not(test))]
    {
        let home = profile
            .extra_env
            .get("HOME")
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from)
            .or_else(crate::dirs::home_dir)?;
        std::fs::read_to_string(home.join(".gemini/antigravity-cli/settings.json")).ok()
    }
}

/// 生成 Antigravity CLI 会话级 `--settings` 内容（纯函数）：
/// 保留用户 `~/.gemini/antigravity-cli/settings.json`（JSONC）里所有非 `mesa/` 自定义模型，
/// 并入当前连接的 `mesa/<id>` 条目（`API_PROVIDER_GOOGLE_GEMINI`），钉住 `modelProvider="gemini"` 与 `model="mesa/<picked>"`。
pub(crate) fn agy_session_settings_body(
    profile: &Profile,
    picked: &str,
    user_text: Option<&str>,
) -> serde_json::Value {
    let mut custom_models = serde_json::Map::new();
    if let Some(text) = user_text {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&crate::mcp::strip_jsonc(text)) {
            if let Some(existing) = v
                .pointer("/customModelsConfig/customModels")
                .and_then(|m| m.as_object())
            {
                for (k, val) in existing {
                    if !k.starts_with("mesa/") {
                        custom_models.insert(k.clone(), val.clone());
                    }
                }
            }
        }
    }
    let mut ids: Vec<&str> = Vec::new();
    for m in std::iter::once(picked).chain(profile.models.iter().map(String::as_str)) {
        let m = m.trim();
        if !m.is_empty() && !ids.contains(&m) {
            ids.push(m);
        }
    }
    for id in ids {
        custom_models.insert(
            format!("mesa/{id}"),
            serde_json::json!({
                "apiProvider": "API_PROVIDER_GOOGLE_GEMINI",
                "modelName": id,
            }),
        );
    }
    serde_json::json!({
        "modelProvider": "gemini",
        "model": format!("mesa/{picked}"),
        "customModelsConfig": {
            "customModels": custom_models,
        },
    })
}

/// `google.golang.org/genai` 自己拼 `/v1beta/models/...`：剥掉用户或中转末尾误带的 `/v1beta` 或 `/v1`
pub(crate) fn normalize_agy_gemini_base_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    for suffix in ["/v1beta", "/v1"] {
        if trimmed.len() > suffix.len()
            && trimmed[trimmed.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
        {
            return trimmed[..trimmed.len() - suffix.len()].to_string();
        }
    }
    trimmed.to_string()
}

fn agy_effort_arg(raw: Option<&str>) -> Option<&'static str> {
    let canonical = crate::agent_specs::canonical_reasoning_effort(raw?)?;
    match canonical.as_str() {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        _ => None,
    }
}

/// Qwen 的系统设置覆盖层（`QWEN_CODE_SYSTEM_SETTINGS_PATH`，合并时排在用户 settings.json 之后）。
/// 用户 settings.json 的 `model.name` 盖过 `OPENAI_MODEL`，命中的 `modelProviders` 条目自带的 baseUrl / envKey
/// 又盖过环境变量：设过全局（或在 Qwen 里 /model 过）之后按连接启动，请求打到全局那条连接——模型不同名时
/// 换成全局模型，同名时模型对、地址和密钥是全局的（2026-11-01 0.26.3 假网关实测；只加 `--model` 修不了同名）。
/// 覆盖层钉住认证方式、模型与本次连接的条目，两种情况都回到所选连接；条目 envKey 指本次注入的密钥变量，
/// 文件里没有密钥。Qwen 不要求这个文件归 root（与 Gemini 不同）。机器上已有的系统设置先读进来再盖这几个键，
/// 不丢管理员下发的设置
fn qwen_system_settings_overlay(profile: &Profile, protocol: &str, model: Option<&str>) -> Result<String, String> {
    let existing = std::env::var_os("QWEN_CODE_SYSTEM_SETTINGS_PATH")
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(qwen_default_system_settings_path)
        .and_then(|p| std::fs::read_to_string(p).ok());
    let base = existing
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&crate::mcp::strip_jsonc(&t)).ok())
        .filter(|v| v.is_object());
    let key_env = if protocol == "anthropic" { "ANTHROPIC_API_KEY" } else { "OPENAI_API_KEY" };
    let body = qwen_system_settings_body(profile, protocol, model, key_env, base);
    write_settings_overlay_file("qwen-settings", &body.to_string())
}

/// Qwen 系统设置的默认位置（0.26.3 getSystemSettingsPath）
fn qwen_default_system_settings_path() -> Option<std::path::PathBuf> {
    Some(std::path::PathBuf::from(if cfg!(target_os = "macos") {
        "/Library/Application Support/QwenCode/settings.json"
    } else if cfg!(windows) {
        r"C:\ProgramData\qwen-code\settings.json"
    } else {
        "/etc/qwen-code/settings.json"
    }))
}

/// 覆盖层内容（纯函数）：所选模型的条目带本次的请求策略（launch_plan 前 combo 已按所选模型物化），
/// 绑定里其余模型只带地址，会话里 /model 换过去也走这条连接
fn qwen_system_settings_body(
    profile: &Profile,
    protocol: &str,
    model: Option<&str>,
    key_env: &str,
    base: Option<serde_json::Value>,
) -> serde_json::Value {
    use serde_json::json;
    let mut v = base.unwrap_or_else(|| json!({}));
    let mut ids: Vec<&str> = profile.models.iter().map(String::as_str).collect();
    if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
        if !ids.contains(&m) {
            ids.insert(0, m);
        }
    }
    let selected = model.or(ids.first().copied());
    let entries: Vec<serde_json::Value> = ids
        .iter()
        .map(|id| {
            let mut e = json!({ "id": id, "name": id, "envKey": key_env });
            if let Some(u) = profile.base_url.as_deref() {
                e["baseUrl"] = json!(u);
            }
            let mut gc = serde_json::Map::new();
            if Some(*id) == selected {
                let policy = &profile.request_policy;
                let mut sp = serde_json::Map::new();
                if let Some(t) = policy.temperature {
                    sp.insert("temperature".into(), json!(t));
                }
                if let Some(t) = policy.top_p {
                    sp.insert("top_p".into(), json!(t));
                }
                if let Some(t) = policy.max_output_tokens {
                    sp.insert("max_tokens".into(), json!(t));
                }
                if let Some(raw) = policy.reasoning_effort.as_deref().filter(|s| !s.trim().is_empty()) {
                    let val = crate::agent_specs::canonical_reasoning_effort(raw).unwrap_or_else(|| raw.trim().to_string());
                    // anthropic 协议的生成器不看 samplingParams 里的思考档，只读条目的 generationConfig.reasoning.effort
                    //（0.26.5 假网关实测：写前者请求里没有 output_config.effort，写后者才有）；openai 协议照旧扁平 reasoning_effort
                    if protocol == "anthropic" {
                        gc.insert("reasoning".into(), json!({ "effort": val }));
                    } else {
                        sp.insert("reasoning_effort".into(), json!(val));
                    }
                }
                if !sp.is_empty() {
                    gc.insert("samplingParams".into(), serde_json::Value::Object(sp));
                }
            }
            if let Some(ctx) = crate::model_registry::model_context_size_declared_for(id, profile.gateway_id.as_deref()) {
                gc.insert("contextWindowSize".into(), json!(ctx));
            }
            if !gc.is_empty() {
                e["generationConfig"] = serde_json::Value::Object(gc);
            }
            e
        })
        .collect();
    let obj = v.as_object_mut().expect("覆盖层根节点是对象");
    let security = obj.entry("security").or_insert_with(|| json!({}));
    if !security.is_object() {
        *security = json!({});
    }
    let auth = security.as_object_mut().unwrap().entry("auth").or_insert_with(|| json!({}));
    if !auth.is_object() {
        *auth = json!({});
    }
    auth["selectedType"] = json!(protocol);
    if let Some(m) = selected {
        let model_obj = obj.entry("model").or_insert_with(|| json!({}));
        if !model_obj.is_object() {
            *model_obj = json!({});
        }
        model_obj["name"] = json!(m);
    }
    let providers = obj.entry("modelProviders").or_insert_with(|| json!({}));
    if !providers.is_object() {
        *providers = json!({});
    }
    providers[protocol] = json!(entries);
    v
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
        .or_else(crate::dirs::home_dir)
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
    // grok / agy 未显式选模型时用绑定清单第一个兜底：
    // - grok 按 id 路由，不注 GROK_DEFAULT_MODEL / -m 会回落 ~/.grok/config.toml 的 [models].default；
    // - agy API 连接必须登记并选中自定义模型 `mesa/<id>`，不带 `--model` 会走 Google 账号默认模型。
    let model = model.or_else(|| {
        if !matches!(profile.agent.as_str(), "grok" | "agy") {
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
                // agy：会话级 `--settings <0600 file>` + `--model mesa/<picked>` 零污染注入（不改用户 settings.json，不注 shell 函数）
                if profile.agent == "agy" {
                    let picked = model
                        .map(str::trim)
                        .filter(|m| !m.is_empty())
                        .ok_or("Antigravity CLI 使用 API 连接时必须至少配置一个模型")?;
                    // google.golang.org/genai 自己拼 /v1beta/models/...：独立连接直填 /v1 或 /v1beta 时统一剥掉；
                    // 不带地址（官方 Gemini API Key）时主动清掉父进程残留 GOOGLE_GEMINI_BASE_URL
                    let mut saw_base = false;
                    for (k, v) in &mut plan.env {
                        if k == "GOOGLE_GEMINI_BASE_URL" {
                            *v = normalize_agy_gemini_base_url(v);
                            saw_base = !v.is_empty();
                        }
                    }
                    if !saw_base {
                        plan.env.retain(|(k, _)| k != "GOOGLE_GEMINI_BASE_URL");
                        plan.env_remove.push("GOOGLE_GEMINI_BASE_URL".into());
                    }
                    let settings_file = write_agy_session_settings(profile, picked)?;
                    plan.args.push("--settings".into());
                    plan.args.push(settings_file);
                    plan.args.push("--model".into());
                    plan.args.push(format!("mesa/{picked}"));
                    if let Some(eff) = agy_effort_arg(profile.request_policy.reasoning_effort.as_deref()) {
                        plan.args.push("--effort".into());
                        plan.args.push(eff.into());
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
                    if profile.agent == "qwen" && profile.base_url.is_some() {
                        let path = qwen_system_settings_overlay(profile, entry.protocol, model)?;
                        plan.env.push(("QWEN_CODE_SYSTEM_SETTINGS_PATH".into(), path));
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
                    let user_keys = claude_user_settings_env_keys(profile);
                    for (k, v) in claude_model_env(profile, model, &user_keys) {
                        if k != "ANTHROPIC_MODEL" {
                            plan.env.push((k, v));
                        }
                    }
                    // 带密钥启动时 claude.ai 连接器本来就不加载（密钥优先于官方登录），可 2.1.311 起本机登录过 claude.ai 的
                    // 会往 stderr 直接写一句「⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY …」，
                    // 夹进终端画面、被聊天层读成回复（2026-11-09 用户截图）。明说不加载，它就不写；用户自己设过就不动
                    if key.is_some() && !user_keys.iter().any(|k| k == "ENABLE_CLAUDEAI_MCP_SERVERS") {
                        plan.env.push(("ENABLE_CLAUDEAI_MCP_SERVERS".into(), "0".into()));
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
                        let disk_auth = codex_disk_provider_has_auth(codex_user_config_for_launch().as_ref(), &pid);
                        plan.args
                            .extend(codex_inline_provider_args(url, key_env, &pid, disk_auth));
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
                        plan.args.extend(codex_login_method_args(codex_user_config_for_launch().as_ref()));
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
                    // 2.x：provider 换成原生写法（思考能力才保得住）；加 --standalone 用自己的私有服务——
                    // 默认连共享后台服务时内联配置被忽略，带着密钥的配置还会留在服务里被别的客户端看到（2026-11-04 实测）
                    if opencode_v2() {
                        opencode_inline_config_v2(&mut config, policy.reasoning_effort.as_deref());
                        plan.args.push("--standalone".into());
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
    if let Some((k, v)) = update_prompt_off_env(&profile.agent) {
        plan.env.push((k.into(), v.into()));
    }
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

/// 交互启动时关掉会弹进对话的更新提示（2026-10-29 用户拍板：只关会打断对话或弹提示的，后台静默更新的保持原样）。
/// Codex 走 `prepare_launch` 的 `-c`；这里是只能用环境变量关的家：
/// - Qwen：启动 3 秒后查更新，brew 装的在对话里冒「update available … brew upgrade」，npm 装的在后台更新后要求退出重启。
///   `QWEN_CODE_SKIP_UPDATE_CHECK_ONCE=true` 整个跳过检查（0.26.1 源码 startPostRenderPrefetches；本机 PTY 实测：不设出提示、设了不出）。
///   变量名是它更新后自我重启用的内部开关，不在官方文档里：升级 Qwen 适配时核对这个名字还在
fn update_prompt_off_env(agent: &str) -> Option<(&'static str, &'static str)> {
    match agent {
        "qwen" => Some(("QWEN_CODE_SKIP_UPDATE_CHECK_ONCE", "true")),
        _ => None,
    }
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
        if let (Some(model), Some(root)) = (
            selected_model.or_else(|| profile.models.first().map(String::as_str)),
            crate::agent_specs::agent_config_root("grok"),
        ) {
            if let Some(msg) = grok_model_section_conflict(&root, profile, model) {
                return Err(msg);
            }
        }
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
                .or_else(|| crate::dirs::home_dir().map(|home| home.join(".grok")))
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
            .or_else(|| crate::dirs::home_dir().map(|h| h.join(".grok")));
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
    // OpenCode 2.x 主命令不认 `--agent`：只讨论改由内联配置的 default_agent 定（readonly_launch_env）
    if agent_id == "opencode" && opencode_v2() {
        return Some(args);
    }
    for a in spec.readonly_args {
        args.push((*a).into());
    }
    Some(args)
}

/// 本机 OpenCode 是不是 2.x（2026-11-04 起两版都支持）：查不到版本按 1.x。2.x 换了启动参数、默认把对话交给共享后台服务、
/// 会话换了表，这几处按它分开走（matrix §5「OpenCode 2」）
pub(crate) fn opencode_v2() -> bool {
    cli_version("opencode").is_some_and(|v| v.0 >= 2)
}

/// 2.x 声明给思考模型的档位：1.x 配置枚举里通用的三档，连接另选了档位就补上
const OPENCODE_V2_EFFORTS: [&str; 3] = ["low", "medium", "high"];

/// 1.x 写法里 `@ai-sdk/openai-compatible` 模型 options 中留在请求外的键（2.x `ConfigProviderOptionsV1.compatibleModel`），
/// 其余的 2.x 原样放进请求体
const OPENCODE_V2_COMPATIBLE_SETTINGS: [&str; 13] = [
    "apiKey", "baseURL", "headers", "body", "extraBody", "timeout", "chunkTimeout", "headerTimeout", "disabled",
    "reasoningEffort", "textVerbosity", "user", "strictJsonSchema",
];

/// 1.x 写法的 provider 块 → 2.x 原生 `providers` 条目。照 2.2.5 `opencode debug config` 对 1.x 写法的规整结果逐字段写，
/// 只多两处：思考模型写 `capabilities.reasoning`（2.x 读 1.x 写法会丢掉 `reasoning: true`，档位就选不了），
/// 没声明视觉的模型写明只收文本（2.x 缺省收图，1.x 缺省纯文本；中转的纯文本模型收到图会报错）。
/// 同名的原生条目整块替换 1.x 条目，所以不能只补一个字段
pub(crate) fn opencode_provider_v2(v1: &serde_json::Value, effort: Option<&str>) -> serde_json::Value {
    use serde_json::{json, Map, Value};
    let npm = v1.get("npm").and_then(Value::as_str);
    let mut out = Map::new();
    if let Some(name) = v1.get("name") {
        out.insert("name".into(), name.clone());
    }
    if let Some(npm) = npm {
        out.insert("package".into(), json!(format!("aisdk:{npm}")));
    }
    if let Some(opts) = v1.get("options").and_then(Value::as_object) {
        let mut settings = Map::new();
        for (k, v) in opts {
            match k.as_str() {
                "headers" | "body" => {
                    out.insert(k.clone(), v.clone());
                }
                _ => {
                    settings.insert(k.clone(), v.clone());
                }
            }
        }
        out.insert("settings".into(), Value::Object(settings));
    }
    let compatible = npm == Some("@ai-sdk/openai-compatible");
    let mut models = Map::new();
    for (id, m) in v1.get("models").and_then(Value::as_object).into_iter().flatten() {
        let mut entry = Map::new();
        for key in ["name", "limit"] {
            if let Some(v) = m.get(key) {
                entry.insert(key.into(), v.clone());
            }
        }
        let mut caps = Map::new();
        let modalities = m.get("modalities");
        caps.insert(
            "input".into(),
            modalities.and_then(|x| x.get("input")).cloned().unwrap_or_else(|| json!(["text"])),
        );
        if let Some(output) = modalities.and_then(|x| x.get("output")) {
            caps.insert("output".into(), output.clone());
        }
        if m.get("reasoning") == Some(&json!(true)) {
            // 2.x 不声明时按包给默认档（openai-compatible 是 low / medium / high，2.2.5 /api/model 实测），
            // 声明了就只有这几档：连接选的、这个模型自己设的档（全局写入逐模型写 options.reasoningEffort）都补进去
            let own = m.pointer("/options/reasoningEffort").and_then(Value::as_str);
            let mut efforts: Vec<&str> = OPENCODE_V2_EFFORTS.to_vec();
            for e in [effort, own].into_iter().flatten() {
                if !e.is_empty() && e != "none" && !efforts.contains(&e) {
                    efforts.push(e);
                }
            }
            caps.insert("reasoning".into(), json!({ "supported": true, "effort": efforts }));
        }
        entry.insert("capabilities".into(), Value::Object(caps));
        if let Some(opts) = m.get("options").and_then(Value::as_object) {
            let (mut settings, mut body) = (Map::new(), Map::new());
            for (k, v) in opts {
                if !compatible || OPENCODE_V2_COMPATIBLE_SETTINGS.contains(&k.as_str()) {
                    settings.insert(k.clone(), v.clone());
                } else {
                    body.insert(k.clone(), v.clone());
                }
            }
            if !settings.is_empty() {
                entry.insert("settings".into(), Value::Object(settings));
            }
            if !body.is_empty() {
                entry.insert("body".into(), Value::Object(body));
            }
        }
        models.insert(id.clone(), Value::Object(entry));
    }
    out.insert("models".into(), Value::Object(models));
    Value::Object(out)
}

/// 启动内联配置改成 2.x 写法：`provider` 整体换成原生 `providers`；`model` / `small_model` / `agent` 等 2.x 照 1.x 写法读得懂，不动
fn opencode_inline_config_v2(config: &mut serde_json::Value, effort: Option<&str>) {
    let Some(obj) = config.as_object_mut() else {
        return;
    };
    let Some(serde_json::Value::Object(legacy)) = obj.remove("provider") else {
        return;
    };
    let native: serde_json::Map<String, serde_json::Value> = legacy
        .iter()
        .map(|(id, block)| (id.clone(), opencode_provider_v2(block, effort)))
        .collect();
    obj.insert("providers".into(), serde_json::Value::Object(native));
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
    if opencode_v2() {
        opencode_readonly_env_v2(env);
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

/// OpenCode 2.x 只讨论时的权限。2.x 的 plan agent 只禁改文件（方案目录 `~/.opencode/plan/` 除外，2.2.5 `plugin/plan.ts`），
/// shell、子任务、MCP 都按默认走；也没有 plan_exit——计划模式只在对话里商量，开工要人切回 build。
/// 规则后来者优先、deny 先判（2.x `Permission.evaluate`）；serde_json 按键名排序，`*` 排在字母前正好先兜底
fn opencode_plan_permission_v2() -> serde_json::Value {
    serde_json::json!({
        "*": "ask",
        "read": { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
        "glob": "allow", "grep": "allow", "webfetch": "allow", "websearch": "allow",
        "todo": "allow", "question": "allow", "skill": "allow",
        "edit": { "*": "deny", "~/.opencode/plan/*": "allow" },
        "external_directory": { "*": "ask", "~/.opencode/plan/*": "allow", "*opencode/tool-output/*": "allow" }
    })
}

/// 2.x 只讨论：主命令不认 `--agent`，改写内联配置的 `default_agent: "plan"`；权限写在顶层 `permission`，
/// 对所有 agent 生效——接着聊一段原本在 build 下的对话时 default_agent 管不到它，只讨论照样兑现（AGENTS.md 新建 / 恢复都兑现）
fn opencode_readonly_env_v2(env: &mut Vec<(String, String)>) {
    let idx = env.iter().position(|(k, _)| k == "OPENCODE_CONFIG_CONTENT");
    let mut cfg: serde_json::Value = idx
        .and_then(|i| serde_json::from_str(&env[i].1).ok())
        .filter(|v: &serde_json::Value| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    cfg["default_agent"] = serde_json::json!("plan");
    cfg["permission"] = opencode_plan_permission_v2();
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
    if agent == "agy" && m.starts_with("mesa/") {
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
pub(crate) const KIMI_ENV_MODEL_ALIAS: &str = "__kimi_env_model__";

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
        let home = crate::dirs::home_dir()?;
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
    Some(crate::dirs::config_dir()?.join("ccode").join("official-models").join(format!("{agent}.json")))
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
    let Some(home) = crate::dirs::home_dir() else {
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

/// `agy models` 内置兜底名单（未缓存时的默认列表，1.5.8 实证）
#[cfg_attr(test, allow(dead_code))]
pub(crate) const AGY_OFFICIAL_FALLBACK_MODELS: &[&str] = &[
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
];

fn strip_ansi_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&nc) = chars.peek() {
                    chars.next();
                    if ('@'..='~').contains(&nc) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// `agy models` 的输出：`<cli_id>\t<Display Name>` 逐行，前面可能夹带 ANSI 控制码与 `\r` spinner 帧（1.5.8 实证）
pub(crate) fn parse_agy_models(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw_line in text.lines() {
        let seg = raw_line.rsplit('\r').next().unwrap_or(raw_line);
        let clean = strip_ansi_escapes(seg);
        let Some((slug, display)) = clean.split_once('\t') else {
            continue;
        };
        let slug = slug.trim();
        let display = display.trim();
        if !slug.is_empty()
            && !display.is_empty()
            && !slug.contains(' ')
            && !slug.starts_with("mesa/")
            && !out.iter().any(|x| x == slug)
        {
            out.push(slug.to_string());
        }
    }
    out
}

fn agy_models_probe_env() -> Vec<(String, String)> {
    let mut envs = crate::settings::official_outbound_env();
    envs.push(("GEMINI_API_KEY".into(), String::new()));
    envs.push(("GOOGLE_GEMINI_BASE_URL".into(), String::new()));
    envs
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
                let extra = crate::dirs::home_dir()
                    .and_then(|h| std::fs::read_to_string(h.join(".claude.json")).ok())
                    .map(|t| claude_additional_models(&t))
                    .unwrap_or_default();
                return claude_official_models(extra);
            }
            // 名单在 tests/fixtures/gemini-model-aliases.json（model_aliases.rs 实测对应型号）
            "gemini" => return crate::model_aliases::aliases_of("gemini"),
            "agy" => {
                let cached = read_official_models_cache("agy");
                return if cached.is_empty() {
                    AGY_OFFICIAL_FALLBACK_MODELS.iter().map(|s| (*s).to_string()).collect()
                } else {
                    cached
                };
            }
            "qwen" => return vec!["coder-model".to_string()],
            _ => return Vec::new(),
        }
        let Some(home) = crate::dirs::home_dir() else {
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
    #[cfg(not(test))]
    if agent == "agy" && read_official_models_cache("agy").is_empty() {
        if let Some(path) = resolve_binary("agy") {
            let envs = agy_models_probe_env();
            refresh_official_models_cache("agy", || {
                cli_output_with_env(&path, &["models"], &envs, std::time::Duration::from_secs(12))
                    .map(|t| parse_agy_models(&t))
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
            if profile.agent == "agy" {
                if let Some(m) = model {
                    plan.args.push("--model".into());
                    plan.args.push(m.into());
                }
                if let Some(eff) = agy_effort_arg(profile.request_policy.reasoning_effort.as_deref()) {
                    plan.args.push("--effort".into());
                    plan.args.push(eff.into());
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
    Some(catalogs_dir()?.join(format!("codex-{profile_id}.json")))
}

/// 测试态改到临时目录：写计划的测试会真的落盘，不能写进用户的 catalogs/（全局那份正被 config.toml 指着）；
/// 按测试线程分开，并行的测试不互相覆盖同一份全局目录
fn catalogs_dir() -> Option<std::path::PathBuf> {
    #[cfg(test)]
    {
        let thread = format!("{:?}", std::thread::current().id()).replace(|c: char| !c.is_ascii_alphanumeric(), "");
        return Some(std::env::temp_dir().join(format!("ccode-test-config-{thread}")).join("ccode").join("catalogs"));
    }
    #[cfg(not(test))]
    Some(crate::dirs::config_dir()?.join("ccode").join("catalogs"))
}

/// 「设为全局」写进 config.toml 的模型目录：Mesa 专用一份，不与启动用的每连接目录共用
/// （启动会按绑定重写 `codex-<id>.json`，全局目录还要装老对话的模型，见 codex_continuity）
pub fn codex_global_catalog_path() -> Option<std::path::PathBuf> {
    Some(catalogs_dir()?.join("codex-global.json"))
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
pub(crate) fn codex_catalog_entry_for(
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
    // 默认思考档：条目不写时 Codex 当成 `none`（0.166 app-server model/list 实测 defaultReasoningEffort = "none"），
    // 客户端新建对话照发 `reasoning.effort = "none"`，推理模型直接 400「'none' is not supported」（2026-10-31 用户截图，
    // 中转 gpt-6.1-sol）。写 medium（与官方条目同口径）；确知不思考的模型不写，`none` 正合适
    if crate::model_registry::model_thinking_declared_for(model, gateway_id) != Some(false) {
        entry["default_reasoning_level"] = serde_json::json!("medium");
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
        // 不弹 Codex 自己的更新提示（2026-10-29 用户：打包版里点它的「更新」跑 `brew upgrade --cask codex`，
        // 找不到 brew 报 os error 2、Codex 退出码 1）：它在对话中途跑 brew / npm、跑完就退出，更新统一走连接页
        //「新版 / 更新」。只加在本次命令行上，不写 config.toml；本机 0.143 / 0.165 PTY 实测这个键能关掉提示
        args.extend(["-c".into(), "check_for_update_on_startup=false".into()]);
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

/// 原生分叉参数：(是否放最前, 参数, 能否同时用 --session-id 定新会话 ID)；这家没有原生分叉返回 None
pub(crate) fn fork_args(agent_id: &str, session_id: &str) -> Option<(bool, Vec<String>, bool)> {
    // OpenCode 2.x 主命令没有 --fork（只剩 `opencode run --fork`，不进交互界面），按没有原生分叉处理
    if agent_id == "opencode" && opencode_v2() {
        return None;
    }
    let fork = agent_spec(agent_id)?.fork.as_ref()?;
    Some((
        fork.prepend,
        fork.args.iter().map(|a| a.replace("{session}", session_id)).collect(),
        fork.session_id,
    ))
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

/// 用户 config.toml 设了 `forced_login_method`（不是 api）时，本进程改成 api。不改的话，Mesa 用 CODEX_API_KEY 注入的
/// 连接被当成「不许用的 API key 登录」：报 ChatGPT login is required、退出，还执行 Logging out——把用户的
/// ~/.codex/auth.json（ChatGPT 登录）删掉（0.166 假网关 + 临时 CODEX_HOME 实测，2026-11-01）。-c 只盖本进程，
/// auth.json 原样留着；没设或本来就是 api 的不加
fn codex_login_method_args(cfg: Option<&toml::Value>) -> Vec<String> {
    let forced = cfg
        .and_then(|c| c.get("forced_login_method"))
        .and_then(|v| v.as_str());
    match forced {
        Some(m) if m != "api" => vec!["-c".into(), r#"forced_login_method="api""#.into()],
        _ => Vec::new(),
    }
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

/// 测试里换掉「用户的 Codex 配置」（真跑测试要用本机真实配置时用）
#[cfg(test)]
pub(crate) fn set_test_codex_config(v: Option<toml::Value>) {
    tests::TEST_CODEX_CONFIG.with(|k| *k.borrow_mut() = v);
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
///
/// `disk_auth`：config.toml 里这个渠道已有 `auth`（客户端续聊补的定义块，mesa_helper 现取密钥，见 codex_continuity）。
/// Codex 不许 auth 与 env_key 并存（`provider auth cannot be combined with env_key`，0.166 实测整份配置加载失败），
/// 这时不注 env_key，认证交给那条命令——取的是同一把密钥
fn codex_inline_provider_args(base_url: &str, key_env: &str, provider: &str, disk_auth: bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut kvs = vec![
        format!(r#"model_providers.{provider}.name="Mesa""#),
        format!(r#"model_providers.{provider}.base_url="{base_url}""#),
    ];
    if !disk_auth {
        kvs.push(format!(r#"model_providers.{provider}.env_key="{key_env}""#));
    }
    kvs.push(format!(r#"model_providers.{provider}.wire_api="responses""#));
    for kv in kvs {
        out.push("-c".into());
        out.push(kv);
    }
    out.push("-c".into());
    out.push(format!(r#"model_provider="{provider}""#));
    out
}

/// config.toml 里该渠道有没有 `auth`（命令取令牌）
fn codex_disk_provider_has_auth(cfg: Option<&toml::Value>, provider: &str) -> bool {
    cfg.and_then(|c| c.get("model_providers"))
        .and_then(|p| p.get(provider))
        .is_some_and(|b| b.get("auth").is_some())
}

/// 复制到用户终端的恢复命令附加参数：仅 codex 且调用方给出 Base URL 时补
/// provider 定义；复制命令本身不携带 Mesa profile 密钥，其他 agent 依赖用户全局配置。
fn resume_extra_args(
    agent_id: &str,
    base_url: Option<&str>,
    session_provider: Option<&str>,
) -> Vec<String> {
    // 对话记的不是 Mesa 的 ccode-…（客户端开的 custom、官方 openai、用户自己的渠道）：只指回它，不带这条连接的定义
    if agent_id == "codex" {
        if let Some(p) = codex_foreign_thread_provider(session_provider) {
            return vec!["-c".into(), format!(r#"model_provider="{p}""#)];
        }
    }
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
                    let disk_auth = codex_disk_provider_has_auth(codex_user_config_for_launch().as_ref(), pid);
                    let mut args = codex_inline_provider_args(url, key_env, pid, disk_auth);
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

/// 对话记下的渠道不是 Mesa 的 `ccode` / `ccode-<短id>` 时返回它（只认 TOML 裸键能写的名字，防拼进 `-c` 出错）
pub(crate) fn codex_foreign_thread_provider(session_provider: Option<&str>) -> Option<&str> {
    let p = session_provider.map(str::trim).filter(|s| !s.is_empty())?;
    let bare = p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    (bare && !crate::provider_id::is_ccode_provider(p)).then_some(p)
}

/// Codex 0.166 起续聊只认对话记下的渠道：与当前渠道（含 `-c` 覆盖）不同就拒绝，报 `modelProviderMismatch`、
/// 请求都不发（PR openai/codex#57840；2026-11-01 本机 0.166.0 隔离 CODEX_HOME 实测，`-c model_provider=` 指回原渠道才能续）。
/// 对话记的不是 Mesa 的 `ccode-…`（客户端里开的 `custom`、官方 `openai`、用户自己配的渠道）时，按对话自己的渠道续
/// （2026-11-01 用户拍板）：`model_provider` 指回它；这条连接自己的模型、上下文、模型目录、旁路模型不带（那是别的渠道的）；
/// 不注入 `CODEX_API_KEY`——`openai` 要走 ChatGPT 登录，别的渠道认证在 config.toml 里——随之也不加
/// `forced_login_method` 覆盖。`openai` 另按官方账号撤掉残留密钥变量、不关官方的网页搜索和 apps。
/// 模型改用对话自己最后一轮的（`thread_model`）：不带 `-m` 时 codex 续聊发的是全局默认模型，不是对话原来的
/// （2026-11-03 本机 0.166 实测：GLM 老对话指回渠道后报「模型不存在」，补 `-m` 才续上）。返回是否改过
pub(crate) fn codex_resume_on_thread_provider(
    plan: &mut LaunchPlan,
    extra_args: &mut Vec<String>,
    thread_provider: Option<&str>,
    thread_model: Option<&str>,
) -> bool {
    let Some(p) = codex_foreign_thread_provider(thread_provider) else {
        return false;
    };
    let official = p == crate::provider_id::CODEX_CHATGPT;
    let mut drop_c: Vec<String> = [
        "model_provider=",
        "model_providers.",
        "model_context_window=",
        "model_auto_compact_token_limit=",
        "model_catalog_json=",
        "forced_login_method=",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    drop_c.extend(CODEX_SIDE_MODEL_KEYS.iter().map(|path| format!("{}=", path.join("."))));
    if official {
        drop_c.extend(["web_search=", "service_tier=", "plugins.codex-app-tools"].map(String::from));
    }
    let strip = |args: &mut Vec<String>| {
        let mut out = Vec::with_capacity(args.len());
        let mut i = 0;
        while i < args.len() {
            let next = args.get(i + 1);
            let pair = match args[i].as_str() {
                "-m" => true,
                "-c" => next.is_some_and(|v| drop_c.iter().any(|d| v.starts_with(d.as_str()))),
                _ => false,
            };
            if pair {
                i += 2;
            } else {
                out.push(args[i].clone());
                i += 1;
            }
        }
        *args = out;
    };
    strip(&mut plan.args);
    strip(extra_args);
    plan.env.retain(|(k, _)| k != "CODEX_API_KEY" && k != "CCODE_MODEL_DISPLAY_NAME");
    if official {
        for var in ["CODEX_API_KEY", "OPENAI_API_KEY"] {
            if !plan.env_remove.iter().any(|v| v == var) {
                plan.env_remove.push(var.into());
            }
        }
    }
    plan.args.push("-c".into());
    plan.args.push(format!(r#"model_provider="{p}""#));
    if let Some(m) = thread_model.map(str::trim).filter(|m| !m.is_empty()) {
        plan.args.extend(["-m".into(), m.to_string()]);
    }
    true
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
        if let Some(home) = crate::dirs::home_dir() {
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
    if profile.agent == "grok" {
        if let Some(root) = crate::agent_specs::agent_config_root("grok") {
            if let Some(msg) = grok_endpoint_conflict(&root, profile) {
                return Err(msg);
            }
        }
    }
    Ok(())
}

/// Grok 配置文件里与这次模型同名的 `[model."<id>"]` 段：段里的 base_url / 密钥压过 Mesa 注入（1.0.70 假网关实测），
/// GROK_CONFIG 覆盖层与命令行都盖不了。段的地址不是这条连接的（或是 Mesa 给别的网关写的 helper 取钥）就拦下说清楚
///（2026-11-01 用户拍板「启动前拦下说明」）。段没写地址的不管（走 [endpoints] / xAI，[endpoints] 另由 grok_endpoint_conflict 拦）
fn grok_model_section_conflict(root: &std::path::Path, profile: &Profile, model: &str) -> Option<String> {
    if profile.account_type != crate::profiles::AccountType::Api {
        return None;
    }
    let base = profile.base_url.as_deref().map(str::trim).filter(|u| !u.is_empty())?;
    let path = root.join("config.toml");
    let doc: toml::Value = toml::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
    let section = doc.get("model")?.get(model)?;
    let section_url = section.get("base_url")?.as_str()?.trim();
    let same_url = section_url.trim_end_matches('/') == base.trim_end_matches('/');
    let other_gateway = section
        .get("auth_provider")
        .and_then(|a| a.as_str())
        .filter(|a| a.starts_with("mesa-"))
        .zip(profile.gateway_id.as_deref())
        .is_some_and(|(a, gid)| a != crate::global_config::grok_auth_provider_name(gid));
    if same_url && !other_gateway {
        return None;
    }
    Some(format!(
        "Grok 配置文件（{}）里有一段 [model.\"{model}\"]，指向 {section_url}：Grok 用模型 {model} 时认这一段的地址和密钥、\
         不认 Mesa 注入的，按这条连接启动会把请求发到那里。这一段是「设为全局」写的，或是 Mesa 给以前在那条连接上开的对话补的\
         （让它们在 Mesa 外也能续聊，删掉后那些老对话在外面接不上）。可以换一个模型；或到连接页把这条连接设为 Grok 的全局默认\
         （同名段会改成这条连接）；或手动删掉这一段后再启动",
        path.display()
    ))
}

/// Grok 的 `[endpoints].models_base_url` 压过 Mesa 注入的 `GROK_MODELS_BASE_URL`（1.0.70 假网关实测，覆盖层也盖不了：
/// GROK_CONFIG 白名单不放行改网络去向的键）——按这条连接启动，请求会打到那个地址、带着这条连接的密钥。
/// 地址不同就拦下说清楚（`root` 显式传入便于测试）
fn grok_endpoint_conflict(root: &std::path::Path, profile: &Profile) -> Option<String> {
    if profile.account_type != crate::profiles::AccountType::Api {
        return None;
    }
    let base = profile.base_url.as_deref().filter(|u| !u.trim().is_empty())?;
    let text = std::fs::read_to_string(root.join("config.toml")).ok()?;
    let doc: toml::Value = toml::from_str(&text).ok()?;
    let pinned = doc.get("endpoints")?.get("models_base_url")?.as_str()?.trim();
    if pinned.is_empty() || pinned.trim_end_matches('/') == base.trim().trim_end_matches('/') {
        return None;
    }
    Some(format!(
        "Grok 配置文件（{}）的 [endpoints] 里 models_base_url 指向 {pinned}：Grok 认它、不认 Mesa 注入的地址，\
         按这条连接启动会把请求连同这条连接的密钥发到那里。到连接页给 Grok 重新「设为全局」（新版不再写这一行，\
         会把 Mesa 以前写的撤掉），或手动删掉这一行后再启动",
        root.join("config.toml").display()
    ))
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
        "claude-code" | "codebuddy" => Vec::new(),
        // Qwen OAuth 只有免费档，2026-04-15 停用后 0.26.3 显示「No longer available」：起来也用不了，直接说清楚
        "qwen" => vec![QWEN_OAUTH_DISCONTINUED.into()],
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
            let cfg = std::fs::read_to_string(home.join(".grok/config.toml"))
                .ok()
                .and_then(|t| toml::from_str::<toml::Value>(&t).ok());
            out.extend(grok_relay_segments_without_key(cfg.as_ref()).into_iter().map(|id| {
                format!("~/.grok/config.toml 的 [model.{id}] 指向中转地址却没有自己的密钥，官方登录令牌会被发过去")
            }));
            let default = cfg
                .as_ref()
                .and_then(|v| v.get("models")?.get("default")?.as_str().map(str::to_string));
            // 启动时 GROK_CONFIG 覆盖层把默认模型钉成官方模型（apply_official_inject）；定不出官方模型时才拦
            let can_pin = !profile.models.is_empty() || !official_models_for_launch("grok").is_empty();
            if let Some(m) = default.filter(|m| !can_pin && !crate::global_config::official_model_kept("grok", m)) {
                out.push(format!("~/.grok/config.toml 的默认模型是中转模型 {m}"));
            }
            out
        }
        "agy" => agy_official_settings_conflicts(home),
        _ => probe_conflicts(home, oa),
    }
}

/// Antigravity CLI 官方 Google 账号冲突检查（只读 JSONC）：
/// 顶层 `modelProvider = "gemini"` 或 `model = "mesa/..."` 会让裸 `agy` 走 API 自定义模型而非官方 Google 账号。
pub(crate) fn agy_official_settings_conflicts(home: &std::path::Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(home.join(".gemini/antigravity-cli/settings.json")) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&crate::mcp::strip_jsonc(&text)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if v.get("modelProvider").and_then(|x| x.as_str()) == Some("gemini") {
        out.push("~/.gemini/antigravity-cli/settings.json 中 modelProvider 设为 gemini，官方 Google 账号会被切去 API 模式".into());
    }
    if let Some(m) = v.get("model").and_then(|x| x.as_str()).filter(|m| m.starts_with("mesa/")) {
        out.push(format!("~/.gemini/antigravity-cli/settings.json 中默认模型是 API 自定义模型 {m}"));
    }
    out
}

/// Qwen 官方账号（Qwen OAuth）已停用的说明：启动拦截与连接页同一句
pub(crate) const QWEN_OAUTH_DISCONTINUED: &str =
    "Qwen OAuth 免费档已于 2026-04-15 停用，官方账号登录后也用不了。请在连接页添加阿里云 Coding Plan 或 API Key 连接";

/// Grok 指向非 x.ai 地址、又没有自己 api_key / env_key 的 `[model.<id>]` 段：凭证按优先级落到登录令牌，
/// 官方账号登录过时会把 xAI 令牌发去中转（凭证只有「逐模型 > 登录令牌 > XAI_API_KEY」三档，1.0.70）
fn grok_relay_segments_without_key(cfg: Option<&toml::Value>) -> Vec<String> {
    let Some(models) = cfg.and_then(|v| v.get("model")).and_then(|m| m.as_table()) else {
        return Vec::new();
    };
    models
        .iter()
        .filter(|(_, seg)| {
            let relay = seg
                .get("base_url")
                .and_then(|u| u.as_str())
                .is_some_and(|u| !grok_is_xai_endpoint(u));
            relay && seg.get("api_key").is_none() && seg.get("env_key").is_none()
        })
        .map(|(id, _)| id.clone())
        .collect()
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
    let dir = crate::dirs::config_dir()
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
    title: Option<&str>,
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
    // 窗口标题：终端默认显示目录，先用 OSC 2 写成对话名（CLI 自己改标题时以 CLI 为准）
    if let Some(title) = title {
        let clean: String = title.chars().filter(|c| !c.is_control()).collect();
        if !clean.trim().is_empty() {
            text.push_str(&format!("printf '\\033]2;%s\\007' {}\n", sh_script_quote(&clean)));
        }
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
fn external_ps1_script_text(binary: &str, args: &[String], title: Option<&str>) -> String {
    // 首字符必须是 UTF-8 BOM：powershell.exe（5.1）对**无 BOM** 文件按系统 ANSI 代码页
    // 解析（中文系统 = GBK936）。脚本里的中文（用户名 C:\Users\张三、项目名、prompt 参数）
    // 会被按 GBK 错位解码，把后面的引号当成汉字的 trail byte 吞掉，直接报
    // 「字符串缺少终止符」——整个脚本一行都不执行，外部终端一闪而过。
    // 是否触发取决于具体汉字的字节序列（「中文路径」侥幸无损、「技能张三」必炸），
    // 是数据相关的间歇故障，务必不要因为某次没复现就把 BOM 去掉。
    let mut text = String::from("\u{FEFF}$self = $PSCommandPath\nRemove-Item -LiteralPath $self -Force -ErrorAction SilentlyContinue\n");
    if let Some(raw) = title {
        let clean: String = raw.chars().filter(|c| !c.is_control()).collect();
        if !clean.trim().is_empty() {
            text.push_str(&format!(
                "try {{ $Host.UI.RawUI.WindowTitle = '{}' }} catch {{}}\n",
                clean.trim().replace('\'', "''")
            ));
        }
    }
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
fn write_external_wrapper(binary: &str, args: &[String], title: Option<&str>) -> Result<PathBuf, String> {
    let dir = external_wrapper_dir()?;
    let path = dir.join(format!("launch-{}.ps1", uuid::Uuid::new_v4()));
    std::fs::write(&path, external_ps1_script_text(binary, args, title))
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
    let Some(home) = crate::dirs::home_dir() else {
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
    resume_provider: Option<&str>,
    prompt: Option<&str>,
) -> Result<(Vec<String>, Vec<(String, String)>, Vec<String>), String> {
    validate_launch_compatibility(profile, model)?;
    // 没带首条指令也走 launch_plan_with_prompt：交互启动的环境（关更新提示）只在那里加
    let mut plan = launch_plan_with_prompt(profile, key, model, prompt)?;
    if prompt.is_some() && plan.prompt_dropped {
        return Err(format!(
            "{agent_id} 不支持启动注入参数，简报指令需启动后手动发送"
        ));
    }
    let mut extra = prepare_launch(profile)?;
    // 与内嵌终端同口径：对话不是 Mesa 的 ccode-… 时按它自己的渠道和模型续（不然 codex 报 modelProviderMismatch）
    if let (true, Some(sid), Some(_)) = (agent_id == "codex", resume_session_id, codex_foreign_thread_provider(resume_provider)) {
        let thread_model = crate::sessions::codex_thread_model(sid);
        codex_resume_on_thread_provider(&mut plan, &mut extra, resume_provider, thread_model.as_deref());
    }
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
    title: Option<&str>,
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
        provider,
        prompt,
    )?;
    let binary =
        resolve_binary(binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?)
            .ok_or_else(|| format!("未找到 {agent_id} 的 CLI 二进制"))?;
    if agent_id == "gemini" {
        crate::projects::ensure_geminiignore(std::path::Path::new(cwd));
    }
    let pref = crate::settings::read_current()
        .external_terminal
        .unwrap_or_else(|| "auto".into());
    let expanded_cwd = expand_home_path(cwd);
    let agy_snapshot = if agent_id == "agy" && resume_session_id.is_none() {
        snapshot_agy_external_before(&profile)
    } else {
        None
    };
    let opened: Result<(), String> = {
        #[cfg(windows)]
        {
            open_windows_external(
                &pref,
                cwd,
                &binary.to_string_lossy(),
                &args,
                &env,
                &env_remove,
                title,
            )
        }
        // macOS：终端经 launchd 拉起（open/AppleScript/已运行的 Ghostty 实例），父进程 env
        // 到不了新窗口，密钥只能随一次性包装脚本传递（0600 + 首行自删 + 60s 兜底清理）。
        #[cfg(target_os = "macos")]
        {
            let wrapper =
                write_external_wrapper(&binary.to_string_lossy(), &args, &env, &env_remove, title)?;
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
            let wrapper =
                write_external_wrapper(&binary.to_string_lossy(), &args, &[], &[], title)?;
            let cmd = external_wrapper_command(cwd, &wrapper);
            match open_external_terminal(&cmd, &pref, cwd, &wrapper, &env, &env_remove) {
                Ok(()) => Ok(()),
                Err(e) => {
                    let _ = std::fs::remove_file(&wrapper);
                    Err(e)
                }
            }
        }
    };
    opened?;
    record_external_session_launch(
        agent_id,
        &profile,
        selected_model.as_deref(),
        resume_session_id,
        &args,
        &expanded_cwd,
        agy_snapshot,
    );
    Ok(())
}

/// 外部终端新建 agy 会话的目录对齐结果（纯快照判定，供单测直接断各分支）
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AgyExternalMatch {
    /// `conversation_summaries.db` 或 `last_conversations.json` 已确认工作目录与本次启动目录相同
    Matched(String),
    /// 仅发现唯一一条尚无目录记录的新 CLI 会话（SQLite 尚未刷出 workspace_uris），复核仍唯一再绑定
    PendingSingle(String),
    /// 尚无新会话，或同时有多个无目录新会话（不猜）
    None,
}

pub(crate) fn detect_new_agy_external_session(
    agy_root: &Path,
    known_before: &std::collections::HashSet<String>,
    target_cwd: &str,
    started_at: std::time::SystemTime,
) -> AgyExternalMatch {
    let transcripts = crate::sessions::agy_collect_transcripts(&agy_root.join("brain"));
    let floor = started_at
        .checked_sub(std::time::Duration::from_secs(3))
        .unwrap_or(std::time::UNIX_EPOCH);
    let fresh: Vec<(String, std::time::SystemTime)> = transcripts
        .into_iter()
        .filter(|(cid, _)| !known_before.contains(cid))
        .filter_map(|(cid, path)| {
            let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?;
            (mtime >= floor).then_some((cid, mtime))
        })
        .collect();
    if fresh.is_empty() {
        return AgyExternalMatch::None;
    }
    let meta = crate::sessions::agy_load_meta_map(agy_root);
    let mut cwd_hits: Vec<(String, std::time::SystemTime)> = Vec::new();
    let mut unknown_cwd: Vec<String> = Vec::new();
    for (cid, mtime) in fresh {
        if meta.get(&cid).is_some_and(|e| e.excluded) {
            continue;
        }
        match meta.get(&cid).and_then(|e| e.cwd.as_deref()) {
            Some(c) if crate::paths::same_path(c, target_cwd) => {
                cwd_hits.push((cid, mtime));
            }
            Some(_) => {}
            None => unknown_cwd.push(cid),
        }
    }
    if !cwd_hits.is_empty() {
        cwd_hits.sort_by_key(|(_, mtime)| *mtime);
        return AgyExternalMatch::Matched(cwd_hits.remove(0).0);
    }
    if unknown_cwd.len() == 1 {
        return AgyExternalMatch::PendingSingle(unknown_cwd.remove(0));
    }
    AgyExternalMatch::None
}

fn snapshot_agy_external_before(
    profile: &Profile,
) -> Option<(PathBuf, std::collections::HashSet<String>, std::time::SystemTime)> {
    let home = profile
        .extra_env
        .get("HOME")
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .or_else(crate::dirs::home_dir)?;
    let agy_root = home.join(".gemini/antigravity-cli");
    let known: std::collections::HashSet<String> =
        crate::sessions::agy_collect_transcripts(&agy_root.join("brain"))
            .into_iter()
            .map(|(cid, _)| cid)
            .collect();
    Some((agy_root, known, std::time::SystemTime::now()))
}

fn record_external_session_launch(
    agent_id: &str,
    profile: &Profile,
    selected_model: Option<&str>,
    resume_session_id: Option<&str>,
    args: &[String],
    cwd: &str,
    agy_snapshot: Option<(PathBuf, std::collections::HashSet<String>, std::time::SystemTime)>,
) {
    #[cfg(test)]
    {
        let _ = (
            agent_id,
            profile,
            selected_model,
            resume_session_id,
            args,
            cwd,
            agy_snapshot,
        );
    }
    #[cfg(not(test))]
    {
        let effort = profile
            .request_policy
            .reasoning_effort
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        let model_str = selected_model
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(str::to_string);
        let direct_sid = resume_session_id.map(str::to_string).or_else(|| {
            args.windows(2)
                .find(|w| w[0] == "--session-id")
                .map(|w| w[1].clone())
        });
        if let Some(sid) = direct_sid {
            let launch = model_str.as_deref().map(|m| (m, effort.as_str()));
            let _ = crate::sessions::set_session_profile(agent_id, &sid, &profile.id, launch);
            return;
        }
        let Some((agy_root, known_before, started_at)) = agy_snapshot else {
            return;
        };
        let profile_id = profile.id.clone();
        let target_cwd = cwd.to_string();
        std::thread::spawn(move || {
            let mut last_pending: Option<String> = None;
            for _ in 0..400 {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                match detect_new_agy_external_session(
                    &agy_root,
                    &known_before,
                    &target_cwd,
                    started_at,
                ) {
                    AgyExternalMatch::Matched(cid) => {
                        let launch = model_str.as_deref().map(|m| (m, effort.as_str()));
                        let _ = crate::sessions::set_session_profile(
                            "agy",
                            &cid,
                            &profile_id,
                            launch,
                        );
                        return;
                    }
                    AgyExternalMatch::PendingSingle(cid) => {
                        if last_pending.as_deref() == Some(cid.as_str()) {
                            let launch = model_str.as_deref().map(|m| (m, effort.as_str()));
                            let _ = crate::sessions::set_session_profile(
                                "agy",
                                &cid,
                                &profile_id,
                                launch,
                            );
                            return;
                        }
                        last_pending = Some(cid);
                    }
                    AgyExternalMatch::None => {
                        last_pending = None;
                    }
                }
            }
        });
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
/// 返回（客户端能用的名字，写了 http_headers、客户端加载不了的名字）。
pub fn codex_client_config_providers() -> (Vec<String>, Vec<String>) {
    let Some(home) = crate::dirs::home_dir() else {
        return (Vec::new(), Vec::new());
    };
    let base = std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let Ok(text) = std::fs::read_to_string(base.join("config.toml")) else {
        return (Vec::new(), Vec::new());
    };
    (
        codex_config_provider_names(&text, false),
        codex_config_provider_names(&text, true),
    )
}

/// `with_headers = false` 列客户端能用的定义块；`true` 只列带 http_headers 的。
/// ChatGPT 自带 Codex 不认 provider 上的 http_headers（MCP 字段），整段加载失败后查找即报
/// not found，所以这类块不算已定义，预检据此提示改写。
fn codex_config_provider_names(text: &str, with_headers: bool) -> Vec<String> {
    let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else {
        return Vec::new();
    };
    doc.get("model_providers")
        .and_then(|i| i.as_table())
        .map(|t| {
            t.iter()
                .filter(|(_, item)| {
                    let has_headers = item
                        .as_table()
                        .is_some_and(|tbl| tbl.get("http_headers").is_some());
                    has_headers == with_headers
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
    let mut extra = resume_extra_args(agent_id, base_url.as_deref(), provider.as_deref());
    // 外面续 Codex 老对话：不带 `-m` 发的是全局默认模型，换过默认连接后老渠道报「模型不存在」
    if agent_id == "codex" {
        if let Some(m) = crate::sessions::codex_thread_model(session_id) {
            extra.extend(["-m".into(), m]);
        }
    }
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
    title: Option<String>,
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
            title.as_deref(),
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
            None,
        )
    })
    .await
}

/// 应用装在哪：/Applications 或用户自己的 ~/Applications（不用管理员权限装的 iTerm / Ghostty 常在后者，
/// 原先只认 /Applications，装在 ~/Applications 的报「未安装」）
#[cfg(target_os = "macos")]
fn mac_app_installed(bundle: &str) -> bool {
    std::path::Path::new("/Applications").join(bundle).exists()
        || crate::dirs::home_dir().is_some_and(|h| h.join("Applications").join(bundle).exists())
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
fn windows_start_title(title: Option<&str>) -> String {
    // cmd /C start "<title>" 引号内不能带 `"`（提前闭引号）和 `%`（触发环境变量展开）；
    // 空或全被洗掉时必须回落 "Mesa"，避免空标题触发旧版 libuv assert(process_title)（见下）
    let cleaned = title
        .map(|raw| {
            raw.chars()
                .filter(|c| !c.is_control() && *c != '%')
                .map(|c| if c == '"' { '\'' } else { c })
                .take(200)
                .collect::<String>()
        })
        .unwrap_or_default();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "Mesa".into()
    } else {
        trimmed.to_string()
    }
}

#[cfg(any(windows, test))]
fn windows_start_prefix(cwd: &str, title: Option<&str>) -> String {
    // 标题必须非空：start "" 会给新控制台留下空标题，GetConsoleTitleW 对空标题返回 0，
    // 旧版 libuv（<1.52，kimi 等自带运行时的 CLI 可能内嵌）uv_get_process_title
    // 把 0 当成功、process_title 缓存仍是 NULL，随后 assert(process_title) 直接 abort
    // （win/util.c:412，start "" 场景 100% 复现，见 nodejs/node#58695）。
    let mut line = format!("start \"{}\"", windows_start_title(title));
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
fn windows_external_start_line_cmd(
    cwd: &str,
    binary: &str,
    args: &[String],
    title: Option<&str>,
) -> String {
    windows_cmd_start_line_with(cwd, "", "/K", binary, args, title)
}

/// start_flags / switch 只为测试可换成 `/B /WAIT` + `/C`（不开可见窗口、跑完即退）
#[cfg(any(windows, test))]
fn windows_cmd_start_line_with(
    cwd: &str,
    start_flags: &str,
    switch: &str,
    binary: &str,
    args: &[String],
    title: Option<&str>,
) -> String {
    let mut inner = cmd_quote_arg(binary);
    for a in args {
        inner.push(' ');
        inner.push_str(&cmd_quote_arg(a));
    }
    let mut line = windows_start_prefix(cwd, title);
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
fn windows_external_cmd_inline(
    cwd: &str,
    binary: &str,
    args: &[String],
    title: Option<&str>,
) -> Option<String> {
    if cmd_inline_unsafe(binary) || args.iter().any(|a| cmd_inline_unsafe(a)) {
        return None;
    }
    let line = windows_external_start_line_cmd(cwd, binary, args, title);
    (line.len() <= WINDOWS_START_LINE_MAX).then_some(line)
}

/// 设置「PowerShell」：可见宿主是 powershell -NoExit -File wrapper；
/// 密钥经 start 环境块继承进会话（与 cmd 路径同口径），ps1 只含启动命令。
#[cfg(any(windows, test))]
fn windows_external_start_line_ps(cwd: &str, wrapper: &Path, title: Option<&str>) -> String {
    let mut line = windows_start_prefix(cwd, title);
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
    title: Option<&str>,
) -> Result<(), String> {
    let cwd = expand_home_path(cwd);
    if pref == "powershell" {
        // 密钥放父进程环境块经 start 继承（与 cmd 路径同口径），ps1 只含启动命令与窗口标题
        let wrapper = write_external_wrapper(binary, args, title)?;
        let line = windows_external_start_line_ps(&cwd, &wrapper, title);
        return spawn_windows_start(&line, env, env_remove).map_err(|e| {
            let _ = std::fs::remove_file(&wrapper);
            e
        });
    }
    // cmd / auto：密钥放在父进程环境块，start 继承进可见 cmd。不经 PowerShell，
    // 避免 5.1 当 conhost 把 TUI 卡住，也避免 AMSI 扫描每次新写的 ps1。
    let line = match windows_external_cmd_inline(&cwd, binary, args, title) {
        Some(line) => line,
        None => {
            let wrapper = write_external_cmd_wrapper(binary, args)?;
            windows_external_start_line_cmd(&cwd, &wrapper.to_string_lossy(), &[], title)
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
    let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
    let backup_dir = crate::dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("conflict-backups");
    std::fs::create_dir_all(&backup_dir).map_err(|e| format!("创建冲突备份目录失败: {e}"))?;
    if agent_id == "agy" {
        return clear_agy_settings_conflicts_at(&home, &backup_dir);
    }
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

pub(crate) fn clear_agy_settings_conflicts_at(
    home: &std::path::Path,
    backup_dir: &std::path::Path,
) -> Result<Vec<String>, String> {
    let rel = ".gemini/antigravity-cli/settings.json";
    let path = home.join(rel);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    let clean = crate::mcp::strip_jsonc(&text);
    let mut v: serde_json::Value = serde_json::from_str(&clean)
        .map_err(|e| format!("{} 不是合法 JSON/JSONC，已停止清理: {e}", path.display()))?;
    let Some(obj) = v.as_object_mut() else {
        return Err(format!("{} 根节点不是对象，已停止清理", path.display()));
    };
    let mut changed = false;
    if obj.get("modelProvider").and_then(|x| x.as_str()) == Some("gemini") {
        obj.remove("modelProvider");
        changed = true;
    }
    if obj
        .get("model")
        .and_then(|x| x.as_str())
        .is_some_and(|m| m.starts_with("mesa/"))
    {
        obj.remove("model");
        changed = true;
    }
    if let Some(cm) = obj
        .get_mut("customModelsConfig")
        .and_then(|c| c.get_mut("customModels"))
        .and_then(|m| m.as_object_mut())
    {
        let before = cm.len();
        cm.retain(|k, _| !k.starts_with("mesa/"));
        changed |= cm.len() != before;
    }
    if !changed {
        return Ok(Vec::new());
    }
    let backup = backup_dir.join(format!(
        "agy-{}-settings.json.bak",
        uuid::Uuid::new_v4()
    ));
    std::fs::copy(&path, &backup).map_err(|e| format!("备份冲突文件失败: {e}"))?;
    tighten_private_file(&backup)?;
    let mut pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    pretty.push('\n');
    let out = if clean != crate::mcp::strip_bom(&text) {
        crate::global_config::merge_jsonc_keys(&text, &pretty).unwrap_or(pretty)
    } else {
        pretty
    };
    crate::profiles::atomic_write(&path, &out)?;
    tighten_private_file(&path)?;
    Ok(vec![format!("~/{rel}（备份已保存）")])
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
            if let Some(home) = crate::dirs::home_dir() {
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
            let has_login = crate::dirs::home_dir().is_some_and(|h| h.join(".grok/auth.json").is_file());
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
    let home = crate::dirs::home_dir();
    // 冲突探测与连接状态无关：未登录时残留的 API 配置同样值得告警
    let mut conflicts = home
        .as_ref()
        .map(|h| probe_conflicts(h, oa))
        .unwrap_or_default();
    if agent_id == "agy" {
        if let Some(h) = home.as_ref() {
            conflicts.extend(agy_official_settings_conflicts(h));
        }
    }
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
    if agent_id == "agy" && !cfg!(test) {
        if let Some(path) = resolve_binary("agy") {
            let envs = agy_models_probe_env();
            let models = cli_output_with_env(&path, &["models"], &envs, std::time::Duration::from_secs(10))
                .map(|t| parse_agy_models(&t))
                .unwrap_or_default();
            if !models.is_empty() {
                let count = models.len();
                refresh_official_models_cache("agy", || models);
                return OfficialAccountStatusDto {
                    supported: true,
                    connected: true,
                    detail: Some(format!("agy models：已登录 Google 账号（共 {count} 个可用模型）")),
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
    let mut cli_says_logged_out: Option<&str> = None;
    if agent_id == "claude-code" {
        if let Some((logged_in, method, expires_at)) = claude_auth_status() {
            if !logged_in {
                cli_says_logged_out = Some("claude auth status 显示未登录（登录已过期或已登出），点「官方登录」重登");
            }
            if logged_in {
                let mut detail = format!("claude auth status 显示已登录（{method}）");
                if let Some(note) = login_expiry_note(expires_at, chrono::Utc::now().timestamp()) {
                    detail = format!("{detail}；{note}");
                }
                return OfficialAccountStatusDto {
                    supported: true,
                    connected: true,
                    detail: Some(detail),
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
mod tests;
