//! 「设为全局默认」：把 profile 写入各 CLI 自己的配置文件。
//! 这是全应用唯一被允许写 CLI 配置的地方；写任何已存在的文件前必须先备份。

use crate::agents;
use crate::profiles::{self, Profile, ProfileStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 一次计划好的写入：tag 用于备份文件命名（kimi 两个 config.toml 靠它区分）
struct PlannedWrite {
    tag: &'static str,
    path: PathBuf,
    content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupEntry {
    tag: String,
    target: String,
    existed: bool,
    backup_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupManifest {
    batch_id: String,
    operation: String,
    entries: Vec<BackupEntry>,
}

#[derive(Debug, Clone)]
struct TxAction {
    tag: String,
    path: PathBuf,
    content: Option<Vec<u8>>,
}

static GLOBAL_CONFIG_MUTEX: Mutex<()> = Mutex::new(());

/// 与 apply_profile_global 同一口径：选中模型求交后再 plan。
pub(crate) fn profile_for_register(
    store: &ProfileStore,
    profile_id: &str,
) -> Result<(Profile, String), String> {
    let profile = profile_for_write(store, profile_id)?;
    let key = crate::profiles::get_key_for_profile(&profile)?.ok_or("该配置没有已保存的密钥")?;
    Ok((profile, key))
}

pub(crate) fn profile_for_write(store: &ProfileStore, profile_id: &str) -> Result<Profile, String> {
    let mut profile = store.get_with_model(profile_id, None)?;
    let first = profile.models.first().cloned();
    crate::combo::apply_to_profile(&mut profile, first.as_deref());
    Ok(profile)
}

fn disk_matches_plans(plans: &[PlannedWrite]) -> bool {
    plans
        .iter()
        .all(|p| crate::drift::planned_matches_live(&p.path, &p.content))
}

/// 托盘选中态：计划产物与磁盘是否一致（子集比对）。None = dry-run 失败，回落「上次写入」。
pub(crate) fn dry_run_matches(store: &ProfileStore, profile: &Profile) -> Option<bool> {
    if is_official(profile) && !official_global_is_patch(&profile.agent) {
        return None;
    }
    let profile = profile_for_write(store, &profile.id).ok()?;
    let key = crate::profiles::get_key_for_profile(&profile)
        .ok()
        .flatten();
    let home = crate::dirs::home_dir()?;
    let plans = plan_writes(&home, &profile, key.as_deref(), &profile.models).ok()?;
    Some(plans_match_disk(&profile, &plans))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalApplyResultDto {
    pub files: Vec<String>,
    pub validation: crate::profile_validation::ProfileValidationDto,
    /// 同预览的 override_notes：一键切换不弹预览，写完用提示条说
    pub override_notes: Vec<String>,
}

/// Codex「设为全局」挡路：live 被 cc-switch / custom 占用，或本机有 cc-switch。
pub const CODEX_SET_GLOBAL_CONFLICT: &str = "\
这会把 ChatGPT 和外部 Codex 的默认渠道切到此连接。\n\
\n\
当前 config.toml 里已有 cc-switch 的配置（custom 渠道或它的模型目录），或本机装着 cc-switch。Mesa 也写在 custom 这个渠道名下（两边的对话在客户端侧栏里归在一处），写入会整块换掉 cc-switch 当前写在那里的连接；不要两边同时改默认渠道。\n\
\n\
要在 Codex 客户端里续 Mesa 开的对话，用对话页的「在 Codex 客户端打开」（缺渠道定义时会当场补写），不必设为全局。\n\
\n\
仍要设为全局？";

/// 其他 Agent「设为全局」挡路：本机有 cc-switch。
pub const SET_GLOBAL_CC_SWITCH_CONFLICT: &str = "\
这会把该 CLI 的默认配置切到此连接，外部终端都会走它。\n\
\n\
本机检测到 cc-switch。不要两边同时改同一个 Agent 的全局配置。\n\
\n\
仍要设为全局？";

/// 磁盘 Codex 配置是否像被 cc-switch（或其他 custom 渠道）占用默认位。
pub fn codex_other_switcher_marks(config: &str) -> bool {
    let config = crate::mcp::strip_bom(config);
    if config.contains("cc-switch-model-catalog") {
        return true;
    }
    let Ok(doc) = config.parse::<toml_edit::DocumentMut>() else {
        return config.contains("[model_providers.custom]");
    };
    // custom 是 Mesa 与 cc-switch 共用的渠道名：Mesa 自己写的（name = "Mesa"）与
    // ChatGPT 登录形态（官方，谁写的都一样，没有第三方配置可被冲掉）不算别家
    let Some(blk) = doc
        .get("model_providers")
        .and_then(|i| i.as_table_like())
        .and_then(|t| t.get(CODEX_GLOBAL_PROVIDER))
    else {
        // 默认指着 custom 却没有定义块：不是 Mesa 写出来的样子，按别家算
        return doc.get("model_provider").and_then(|i| i.as_str()) == Some(CODEX_GLOBAL_PROVIDER);
    };
    let name = blk.get("name").and_then(|v| v.as_str());
    let official_shape = name == Some("OpenAI")
        && blk.get("requires_openai_auth").and_then(|v| v.as_bool()) == Some(true)
        && blk.get("base_url").is_none();
    !(name == Some("Mesa") || official_shape)
}

pub fn cc_switch_dir_present(home: &std::path::Path) -> bool {
    home.join(".cc-switch").is_dir()
}

/// 纯判定：本机有 cc-switch，或 Codex live 已被 custom/cc-switch 占用。
pub fn set_global_conflict_reason(
    agent: &str,
    cc_switch_present: bool,
    codex_live: Option<&str>,
) -> Option<&'static str> {
    match agent {
        "cursor" => None,
        "codex" => {
            let live_hit = codex_live.is_some_and(codex_other_switcher_marks);
            (live_hit || cc_switch_present).then_some(CODEX_SET_GLOBAL_CONFLICT)
        }
        _ => cc_switch_present.then_some(SET_GLOBAL_CC_SWITCH_CONFLICT),
    }
}

/// 连接页 / 托盘共用：有冲突返回挡路文案。
pub fn set_global_conflict_message(agent: &str) -> Option<String> {
    let home = crate::dirs::home_dir()?;
    let cc = cc_switch_dir_present(&home);
    let live = if agent == "codex" {
        fs::read_to_string(cli_dir(&home, "codex").join("config.toml")).ok()
    } else {
        None
    };
    set_global_conflict_reason(agent, cc, live.as_deref()).map(str::to_string)
}

#[tauri::command]
pub fn set_global_conflict(agent: String) -> Option<String> {
    set_global_conflict_message(&agent)
}

/// 搬迁变量读进程环境；测试只看传入的 home，绝不按本机环境写到真实目录
fn relocation_env(var: &str) -> Option<PathBuf> {
    if cfg!(test) {
        return None;
    }
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// 该 Agent 的用户级配置目录（认 CLI 自己的搬迁变量，与 MCP / 技能同源）
fn cli_dir(home: &Path, agent: &str) -> PathBuf {
    crate::agent_specs::agent_config_root_with(agent, home, &relocation_env)
        .unwrap_or_else(|| home.to_path_buf())
}

/// Codex 用户级目录（认 CODEX_HOME）：续聊层读对话表、模型表与 config.toml 用
pub(crate) fn codex_dir(home: &Path) -> PathBuf {
    cli_dir(home, "codex")
}

/// 旧版 kimi-cli 的目录（`KIMI_SHARE_DIR` 顶替 `~/.kimi`）
fn kimi_legacy_dir(home: &Path) -> PathBuf {
    crate::agent_specs::kimi_legacy_root_with(home, &relocation_env)
}

/// 每个 agent 的全局配置目标文件（tag, 绝对路径），无清单回落恢复用
fn target_paths(home: &Path, agent: &str) -> Vec<(&'static str, PathBuf)> {
    let dir = cli_dir(home, agent);
    match agent {
        "claude-code" => vec![("settings.json", dir.join("settings.json"))],
        "codex" => vec![
            ("config.toml", dir.join("config.toml")),
            // 仅给旧批次恢复用：v3.249 起「设为全局」不再写 auth.json。
            // 清单恢复按当时写过的文件走；无清单回落仍可能碰到旧 auth.json 备份。
            ("auth.json", dir.join("auth.json")),
        ],
        "gemini" => vec![
            (".env", dir.join(".env")),
            // 光有 .env 不够：gemini ≥0.46 在 base URL 存在时把 env 推断为 gateway 认证，
            // validateAuthMethod 不认 → headless 直接报 auth 错起不来；必须落
            // settings.json 的 selectedType="gemini-api-key"（cc-switch 同口径，审计实证）
            ("settings.json", dir.join("settings.json")),
        ],
        "qwen" => vec![("settings.json", dir.join("settings.json"))],
        "codebuddy" => vec![
            ("settings.json", dir.join("settings.json")),
            ("models.json", dir.join("models.json")),
        ],
        "opencode" => vec![
            ("opencode.json", dir.join("opencode.json")),
            ("opencode.jsonc", dir.join("opencode.jsonc")),
        ],
        "kimi" => vec![
            ("config.toml", dir.join("config.toml")),
            ("legacy-config.toml", kimi_legacy_dir(home).join("config.toml")),
        ],
        "grok" => vec![("config.toml", dir.join("config.toml"))],
        _ => vec![],
    }
}

// ===== JSON 补丁 =====

fn parse_json_doc(existing: Option<&str>) -> Result<Value, String> {
    let v: Value = match existing.map(crate::mcp::strip_bom) {
        Some(t) if !t.trim().is_empty() => serde_json::from_str(t)
            .map_err(|e| format!("现有配置不是合法 JSON，已停止写入以免破坏: {e}"))?,
        _ => json!({}),
    };
    if !v.is_object() {
        return Err("现有配置根节点不是对象，已停止写入".into());
    }
    Ok(v)
}

/// 沿路径确保每一级都是对象并返回末级；遇到非对象字段时报错停止而不是覆盖
fn ensure_obj<'a>(
    mut cur: &'a mut Value,
    path: &[&str],
) -> Result<&'a mut serde_json::Map<String, Value>, String> {
    for &p in path {
        if cur.is_null() {
            *cur = json!({});
        }
        if !cur.is_object() {
            return Err(format!("配置字段 {p} 的上级不是对象，已停止写入"));
        }
        cur = &mut cur[p];
    }
    if cur.is_null() {
        *cur = json!({});
    }
    if !cur.is_object() {
        return Err(format!(
            "配置字段 {} 不是对象，已停止写入",
            path.last().copied().unwrap_or("")
        ));
    }
    Ok(cur.as_object_mut().unwrap())
}

fn to_pretty(v: &Value) -> Result<String, String> {
    let mut s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    s.push('\n');
    Ok(s)
}

/// Claude Code 全局写入（2026-10-30 与启动同源）：「谁用哪个模型」整套走 `agents::claude_model_env`
/// （四个别名槽缺的用主模型补、后台小模型、子 Agent、确知不思考的 MAX_THINKING_TOKENS=0、窗口、非 Claude 模型的
/// ToolSearch / 任务清单开关），与 `--settings` 覆盖层同一份。两处与启动不同，因为这里写的是用户自己的默认：
/// - 主模型写顶层 `model`、思考档写顶层 `effortLevel`（low/medium/high/xhigh；`max` 不收，只能走 env），**不写
///   `ANTHROPIC_MODEL` / `CLAUDE_CODE_EFFORT_LEVEL`**：env 两项优先级最高，会把用户在外面 `/model`、`/effort` 的选择
///   每次新会话都改回来（官方 model-config 文档优先级表）；
/// - 窗口只在确知 >200K 时写，否则两键都撤（上一家的 1M 残留比没有更有害）。
fn patch_claude_settings(existing: Option<&str>, profile: &Profile, key: Option<&str>) -> Result<String, String> {
    let mut v = parse_json_doc(existing)?;
    let env = ensure_obj(&mut v, &["env"])?;
    match profile.base_url.as_deref().filter(|u| !u.trim().is_empty()) {
        Some(u) => {
            env.insert("ANTHROPIC_BASE_URL".into(), json!(u));
        }
        None => {
            env.remove("ANTHROPIC_BASE_URL");
        }
    }
    if let Some(k) = key {
        env.insert("ANTHROPIC_AUTH_TOKEN".into(), json!(k));
    }
    // 上一次 Mesa 写的「值」认得出来的几项先撤，再按这次的连接重算（用户手设的别的值不动）
    let mesa_value = |k: &str, val: &Value| match k {
        "MAX_THINKING_TOKENS" => val == "0",
        "ENABLE_TOOL_SEARCH" => val == "false",
        "CLAUDE_CODE_ENABLE_TODO_TOOLS" => val == "1",
        _ => false,
    };
    let stale_values: Vec<String> = env.iter().filter(|(k, val)| mesa_value(k, val)).map(|(k, _)| k.clone()).collect();
    for k in stale_values {
        env.remove(&k);
    }
    for k in ["ANTHROPIC_MODEL", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"] {
        env.remove(k);
    }
    let user_keys: Vec<String> = env.keys().cloned().collect();
    let main = profile.models.first().map(String::as_str);
    let model_env = agents::claude_model_env(profile, main, &user_keys);
    let written: std::collections::HashSet<String> = model_env.iter().map(|(k, _)| k.clone()).collect();
    // 别家留下的连接键（另一把 ANTHROPIC_API_KEY、请求头、Bedrock 等协议开关、上一份更长名单的槽位……）撤掉：
    // 留着会和这次写的地址、令牌一起生效（2026-10-28 假网关实测两把密钥同时发出）。长期登录令牌
    // CLAUDE_CODE_OAUTH_TOKEN 不动——它是官方账号的登录方式，API 令牌在时它不起作用
    let stale: Vec<String> = env
        .keys()
        .filter(|k| {
            agents::claude_connection_env_key(k)
                && !k.starts_with("CLAUDE_CODE_OAUTH_")
                && !matches!(k.as_str(), "ANTHROPIC_BASE_URL" | "ANTHROPIC_AUTH_TOKEN")
                && !written.contains(k.as_str())
        })
        .cloned()
        .collect();
    for k in stale {
        env.remove(&k);
    }
    for (k, val) in model_env {
        // 窗口在这里按「确知才写」另算（见下），claude_model_env 的「用户设过就写回 200000」是给启动覆盖层的
        if matches!(k.as_str(), "ANTHROPIC_MODEL" | "CLAUDE_CODE_MAX_CONTEXT_TOKENS" | "CLAUDE_CODE_AUTO_COMPACT_WINDOW") {
            continue;
        }
        env.insert(k, json!(val));
    }
    // claude 对不认识的第三方模型按 200K 假设；注册表确知更大的（如 kimi-k3 1M）必须显式声明，否则长会话提前
    // compact（cc-switch 同口径）。AUTO_COMPACT_WINDOW 与上限同值成对管理。用 declared 视图：估值不当声明
    if let Some(ctx) = main
        .and_then(|m| crate::model_registry::model_context_size_declared_for(m, profile.gateway_id.as_deref()))
        .filter(|c| *c > 200_000)
    {
        env.insert("CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(), json!(ctx.to_string()));
        env.insert("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), json!(ctx.to_string()));
    }
    let effort = profile
        .request_policy
        .reasoning_effort
        .as_deref()
        .and_then(crate::agent_specs::canonical_reasoning_effort);
    // settings 的 effortLevel 只收四档；max 只能走 env（随写随清，与旧口径一致）
    if effort.as_deref() == Some("max") {
        env.insert("CLAUDE_CODE_EFFORT_LEVEL".into(), json!("max"));
    }
    let root = v.as_object_mut().expect("parse_json_doc 保证是对象");
    // 顶层属于连接的键：apiKeyHelper 的输出会作 x-api-key 一起发出，fallbackModel 是别家的模型名
    for k in agents::CLAUDE_CONNECTION_TOP_KEYS {
        root.remove(*k);
    }
    match main {
        Some(m) => {
            root.insert("model".into(), json!(m));
        }
        None => {
            // 没列模型 = 用 Claude 自己的默认；上一家中转写的模型名留着会打到这次的地址上
            let foreign = root
                .get("model")
                .and_then(|m| m.as_str())
                .is_some_and(|m| !official_model_kept("claude-code", m));
            if foreign {
                root.remove("model");
            }
        }
    }
    match effort.as_deref().filter(|e| matches!(*e, "low" | "medium" | "high" | "xhigh")) {
        Some(e) => {
            root.insert("effortLevel".into(), json!(e));
        }
        None if effort.is_some() => {
            root.remove("effortLevel");
        }
        None => {}
    }
    to_pretty(&v)
}

/// 网关兼容选项写进 Claude settings.json：开着的写；没开的两个开关撤掉（属于上一家中转），超时没设不动
fn patch_claude_compat(content: &str, compat: &crate::profiles::GatewayCompat) -> Result<String, String> {
    let mut v = parse_json_doc(Some(content))?;
    let env = ensure_obj(&mut v, &["env"])?;
    for (k, val) in agents::claude_compat_env(compat) {
        match val {
            Some(val) => {
                env.insert(k.into(), json!(val));
            }
            None if k != "API_TIMEOUT_MS" => {
                env.remove(k);
            }
            None => {}
        }
    }
    to_pretty(&v)
}

/// 网关兼容选项写进 Codex 共用渠道块：请求超时 → stream_idle_timeout_ms（块是整块重建的，没设就没有）
fn patch_codex_compat(content: &str, compat: &crate::profiles::GatewayCompat) -> Result<String, String> {
    let Some(secs) = compat.timeout_secs else {
        return Ok(content.to_string());
    };
    let mut doc = parse_toml_doc(Some(content))?;
    let providers = sub_table(doc.as_item_mut(), "model_providers")?;
    let blk = sub_table(providers, CODEX_GLOBAL_PROVIDER)?;
    blk["stream_idle_timeout_ms"] = toml_edit::value(i64::from(secs) * 1000);
    Ok(doc.to_string())
}

fn patch_qwen_settings(
    existing: Option<&str>,
    key: Option<&str>,
    profile: &Profile,
) -> Result<String, String> {
    let protocol = profile.protocol.as_deref().unwrap_or("openai");
    let base_url = profile.base_url.as_deref();
    let models = &profile.models;
    let model = models.first().map(String::as_str);
    let mut v = parse_json_doc(existing)?;
    ensure_obj(&mut v, &["security", "auth"])?.insert("selectedType".into(), json!(protocol));
    let env = ensure_obj(&mut v, &["env"])?;
    // 模型条目的 envKey 指这个 Mesa 专用名：settings.json 的 env 优先级最低，项目里常见的 .env 只要有
    // OPENAI_API_KEY 就会把公共名顶掉（0.26.3 bundle：shell > 第一个找到的 .env > settings env）
    match key {
        Some(k) => {
            env.insert(QWEN_MESA_KEY_ENV.into(), json!(k));
        }
        None => {
            env.remove(QWEN_MESA_KEY_ENV);
        }
    }
    // gemini/vertex-ai 协议暂不支持，按 openai 处理（与 launch_plan 一致）
    let is_anthropic = protocol == "anthropic";
    let triple: [(&str, Option<&str>); 3] = if is_anthropic {
        [
            ("ANTHROPIC_API_KEY", key),
            ("ANTHROPIC_BASE_URL", base_url),
            ("ANTHROPIC_MODEL", model),
        ]
    } else {
        [
            ("OPENAI_API_KEY", key),
            ("OPENAI_BASE_URL", base_url),
            ("OPENAI_MODEL", model),
        ]
    };
    for (k, val) in triple {
        if let Some(val) = val {
            env.insert(k.into(), json!(val));
        }
    }
    if let Some(m) = model {
        ensure_obj(&mut v, &["model"])?.insert("name".into(), json!(m));
    }
    // TUI /model 对话框列出的就是 modelProviders.<协议>.models 里的条目；
    // 只换本协议里 Mesa 的条目（envKey 是 Mesa 专用名，或与这次同名），用户自己的条目、其他协议/字段原样保留
    if !models.is_empty() {
        let env_key = if key.is_some() {
            QWEN_MESA_KEY_ENV
        } else if is_anthropic {
            "ANTHROPIC_API_KEY"
        } else {
            "OPENAI_API_KEY"
        };
        // 逐模型 generationConfig.samplingParams（0.22.0 bundle 实证：条目级优先于顶层
        // model.generationConfig，键名是 snake_case 线格式 temperature/top_p/max_tokens；
        // dialog schema 未列该子键但运行时任其生效——「代码读、schema 未写」的半隐藏通道）。
        // 策略取各模型自己的值（网关行 → apply_to_profile 物化，与 opencode 全局写入同口径）。
        // 注意：条目配了 samplingParams 会跳过 qwen 的 known-model max_tokens 自动钳制——
        // 用户显式值原样下发，超上限 400 风险在网关策略侧自控（matrix §9 第 8 条）
        let gw = profile
            .gateway_id
            .as_deref()
            .and_then(crate::gateway_store::find_gateway);
        let entries: Vec<Value> = models
            .iter()
            .map(|m| {
                let mut e = json!({ "id": m, "name": m, "envKey": env_key });
                if let Some(u) = base_url {
                    e["baseUrl"] = json!(u);
                }
                let mut tmp = profile.clone();
                if let Some(gm) = gw
                    .as_ref()
                    .and_then(|g| g.models.iter().find(|x| x.id == *m))
                {
                    tmp.request_policy.temperature = gm.temperature;
                    tmp.request_policy.top_p = gm.top_p;
                    tmp.request_policy.max_output_tokens = gm.max_output_tokens;
                    tmp.request_policy.reasoning_effort = gm.reasoning_effort.clone();
                }
                crate::combo::apply_to_profile(&mut tmp, Some(m));
                let policy = &tmp.request_policy;
                let mut sp = serde_json::Map::new();
                if let Some(val) = policy.temperature {
                    sp.insert("temperature".into(), json!(val));
                }
                if let Some(val) = policy.top_p {
                    sp.insert("top_p".into(), json!(val));
                }
                if let Some(val) = policy.max_output_tokens {
                    sp.insert("max_tokens".into(), json!(val));
                }
                // 思考档：0.26.3 从 samplingParams 的扁平 reasoning_effort 读（chunk resolveReasoningForModel）
                if let Some(raw) = policy.reasoning_effort.as_deref().filter(|s| !s.trim().is_empty()) {
                    let val = crate::agent_specs::canonical_reasoning_effort(raw).unwrap_or_else(|| raw.trim().to_string());
                    sp.insert("reasoning_effort".into(), json!(val));
                }
                let mut gc = serde_json::Map::new();
                if !sp.is_empty() {
                    gc.insert("samplingParams".into(), Value::Object(sp));
                }
                // 条目是封闭的，顶层配置不补进来：中转模型的窗口不写就回落 CLI 按名字猜的默认值
                if let Some(ctx) =
                    crate::model_registry::model_context_size_declared_for(m, profile.gateway_id.as_deref())
                {
                    gc.insert("contextWindowSize".into(), json!(ctx));
                }
                if !gc.is_empty() {
                    e["generationConfig"] = Value::Object(gc);
                }
                e
            })
            .collect();
        let slot = ensure_obj(&mut v, &["modelProviders", protocol])?;
        let kept: Vec<Value> = slot
            .get("models")
            .and_then(|m| m.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|e| !qwen_mesa_entry(e) && !e.get("id").and_then(|i| i.as_str()).is_some_and(|id| models.iter().any(|m| m == id)))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        slot.insert("models".into(), json!(entries.into_iter().chain(kept).collect::<Vec<_>>()));
    }
    to_pretty(&v)
}

/// Mesa 写的 Qwen 模型条目：envKey 是 Mesa 专用变量名（2026-10-30 起）
fn qwen_mesa_entry(e: &Value) -> bool {
    e.get("envKey").and_then(|k| k.as_str()) == Some(QWEN_MESA_KEY_ENV)
}

/// Qwen 模型条目 envKey 用的 Mesa 专用变量名（见 patch_qwen_settings）
const QWEN_MESA_KEY_ENV: &str = "MESA_QWEN_API_KEY";

/// Codex 自定义 provider 的认证：写 `experimental_bearer_token`（ChatGPT 自带
/// Codex 的 ModelProviderInfo 认这个字段）。不写 auth.json（官方登录单槽），
/// 也不写 `http_headers`——那是 MCP 字段，写在 provider 上 ChatGPT 会加载失败，
/// 对话串报 Model provider not found。requires_openai_auth = false 明确不走 auth.json。
fn set_codex_provider_static_auth(blk: &mut toml_edit::Item, key: &str) {
    use toml_edit::value;
    if let Some(t) = blk.as_table_mut() {
        t.remove("env_key");
        t.remove("http_headers");
    }
    blk["requires_openai_auth"] = value(false);
    blk["experimental_bearer_token"] = value(key);
}

/// gemini 的 settings.json：补 security.auth.selectedType = "gemini-api-key"——
/// 光有 .env 的 GEMINI_API_KEY 时 gemini ≥0.46 无法推断认证方式（base URL 存在时
/// env 推断为 gateway，validateAuthMethod 不认 → headless 报 auth 错起不来），
/// cc-switch 同口径。settings.json 是 JSONC（容忍注释/尾逗号，读侧剥注释后重写为
/// 严格 JSON），其余字段一律保留
///
/// 自定义模型进 /model 选择器（0.46.0 bundle 实证，2026-09-01）：唯一通道 =
/// experimental.dynamicModelConfiguration 开关 + modelConfigs.modelDefinitions
/// （env/flag 无等价物，启动注入够不到）；isVisible 必须显式 true，tier=custom 最稳
/// （auto 挤主视图、pro 被无权限账号过滤）；与内置表浅合并不丢官方模型；
/// 消费侧全门控该开关且 requiresRestart——已在跑的 gemini 会话要重启才生效。
/// 只写/更新当前名单的条目，不删旧条目（键是模型 id，用户可能手维护）。
// pub(crate) 而非私有：capability_golden 的黄金样本要在 crate 内直接渲染这两个写入点，
// 按「最终文本」断言跨层结论。不加 test-only 包装层——包装层会与真函数漂移，
// 而漂移的样本比没有样本更坏（它锁的是包装层的行为，不是写盘的行为）。
pub(crate) fn patch_gemini_settings(
    existing: Option<&str>,
    profile_name: &str,
    models: &[String],
    gateway_id: Option<&str>,
) -> Result<String, String> {
    let mut v = match existing {
        Some(text) => serde_json::from_str::<Value>(&crate::mcp::strip_jsonc(text))
            .map_err(|e| format!("现有 settings.json 解析失败，已停止写入: {e}"))?,
        None => json!({}),
    };
    ensure_obj(&mut v, &["security", "auth"])?
        .insert("selectedType".into(), json!("gemini-api-key"));
    if !models.is_empty() {
        ensure_obj(&mut v, &["experimental"])?
            .insert("dynamicModelConfiguration".into(), json!(true));
        let defs = ensure_obj(&mut v, &["modelConfigs", "modelDefinitions"])?;
        for m in models {
            let mut def = json!({
                // 选择器显示名与 claude/kimi/codex 同口径：配置名 · 模型
                "displayName": format!("{profile_name} · {m}"),
                "tier": "custom",
                "family": "custom",
                "isPreview": false,
                "isVisible": true,
            });
            // 能力标记宁缺毋滥：注册链确知才写，否则留空走 CLI 缺省。
            // 用 declared 视图而非 model_thinking_for——后者把关键词推断也算命，
            // 给「名字里带 thinking」的中转改名模型写死 thinking:true 是无据的正向声明；
            // 确知（用户覆盖/网关实测/公共库/内置表）才配写。
            let mut feats = serde_json::Map::new();
            if crate::model_registry::model_thinking_declared_for(m, gateway_id) == Some(true) {
                feats.insert("thinking".into(), json!(true));
            }
            if crate::model_registry::model_supports_vision_declared_for(m, gateway_id) == Some(true) {
                feats.insert("multimodalToolUse".into(), json!(true));
            }
            if !feats.is_empty() {
                def["features"] = Value::Object(feats);
            }
            defs.insert(m.clone(), def);
        }
    }
    to_pretty(&v)
}

/// Gemini 全局写入补两处（2026-10-30）：
/// - `model.name` 也写首个模型：`~/.gemini/.env` 只在当前目录往上没找到别的 `.env`、且目录被信任时才读，
///   settings.json 不受这两条影响（shell 的 GEMINI_MODEL 仍压过它，预览另行提醒）；
/// - 逐模型温度 / top_p / 输出上限写进 `modelConfigs.customOverrides`（`match.model` = 模型 id，
///   0.66 bundle ModelConfigService：overrides → customOverrides → runtime 依次合并 generateContentConfig）。
///   Mesa 只管 match 恰为本连接模型的条目：先撤再写，别的条目不动。思考档不写：中转的 thinkingConfig 形状未实证。
fn patch_gemini_extras(content: &str, profile: &Profile) -> Result<String, String> {
    let mut v = parse_json_doc(Some(content))?;
    if let Some(m) = profile.models.first() {
        ensure_obj(&mut v, &["model"])?.insert("name".into(), json!(m));
    }
    let gw = profile
        .gateway_id
        .as_deref()
        .and_then(crate::gateway_store::find_gateway);
    let mut fresh = Vec::new();
    for m in &profile.models {
        let mut tmp = profile.clone();
        if let Some(gm) = gw.as_ref().and_then(|g| g.models.iter().find(|x| x.id == *m)) {
            tmp.request_policy.temperature = gm.temperature;
            tmp.request_policy.top_p = gm.top_p;
            tmp.request_policy.max_output_tokens = gm.max_output_tokens;
        }
        crate::combo::apply_to_profile(&mut tmp, Some(m));
        let policy = &tmp.request_policy;
        let mut gcc = serde_json::Map::new();
        if let Some(t) = policy.temperature {
            gcc.insert("temperature".into(), json!(t));
        }
        if let Some(t) = policy.top_p {
            gcc.insert("topP".into(), json!(t));
        }
        if let Some(t) = policy.max_output_tokens {
            gcc.insert("maxOutputTokens".into(), json!(t));
        }
        if !gcc.is_empty() {
            fresh.push(json!({
                "match": { "model": m },
                "modelConfig": { "generateContentConfig": Value::Object(gcc) },
            }));
        }
    }
    let ours = |o: &Value| {
        o.pointer("/match/model")
            .and_then(|m| m.as_str())
            .is_some_and(|m| profile.models.iter().any(|x| x == m))
            && o.get("match").and_then(|x| x.as_object()).is_some_and(|x| x.len() == 1)
    };
    let has_list = v.pointer("/modelConfigs/customOverrides").is_some();
    if has_list || !fresh.is_empty() {
        let configs = ensure_obj(&mut v, &["modelConfigs"])?;
        let list = configs.entry("customOverrides").or_insert_with(|| json!([]));
        let Some(arr) = list.as_array_mut() else {
            return Err("配置字段 modelConfigs.customOverrides 不是数组，已停止写入".into());
        };
        arr.retain(|o| !ours(o));
        arr.extend(fresh);
    }
    to_pretty(&v)
}

/// Gemini 第一次用：只把认证方式设成 API Key（`security.auth.selectedType`），别的一个字段都不动、不写模型名单。
/// 没选过认证方式时 Gemini 进门先问用哪种认证、再要把密钥存进钥匙串（2026-10-27 空 HOME 实录）；
/// 选成 API Key 后它直接用 Mesa 启动时给的密钥。用户在聊天卡上点了才写（gemini_use_api_key_auth）
pub(crate) fn patch_gemini_auth_only(existing: Option<&str>) -> Result<String, String> {
    let mut v = match existing {
        Some(text) if !text.trim().is_empty() => serde_json::from_str::<Value>(&crate::mcp::strip_jsonc(text))
            .map_err(|e| format!("现有 settings.json 解析失败，已停止写入: {e}"))?,
        _ => json!({}),
    };
    if !v.is_object() {
        return Err("现有 settings.json 根节点不是对象，已停止写入".into());
    }
    ensure_obj(&mut v, &["security", "auth"])?.insert("selectedType".into(), json!("gemini-api-key"));
    to_pretty(&v)
}

/// OpenCode 全局写入（2026-10-30 口径，2026-10-31 改「老对话要用的只加不删」）：
/// - 别的 `ccode` / `ccode-<短id>` 块：密钥是 `{file:}` 引用且文件还在的留着（老对话还要用）；明文密钥的、
///   引用的文件已不在的撤掉——后者留着整份配置加载失败（1.19.5 实测 `bad file reference … does not exist`）。
///   认得出网关的老渠道由 extend_opencode_plans 按 `{file:}` 重写回来；
/// - `model` / `small_model` 指向本渠道；这次没有就撤掉还指着 Mesa 旧渠道的那项（用户自己的不动）；
/// - 不再写 `autoupdate: false`：那是 Mesa 启动时自己的事（env 关），不该改用户在外面用 OpenCode 的更新行为。
/// JSONC 注释：读 `opencode.jsonc` 时剥掉注释，写回是严格 JSON（预览与备份照常）。
fn patch_opencode_config(
    existing: Option<&str>,
    provider: Value,
    model: Option<&str>,
    small_model: Option<&str>,
    provider_id: &str,
) -> Result<String, String> {
    let mut v = match existing.map(crate::mcp::strip_jsonc) {
        Some(t) if !t.trim().is_empty() => serde_json::from_str::<Value>(&t)
            .map_err(|e| format!("现有配置不是合法 JSON，已停止写入以免破坏: {e}"))?,
        _ => json!({}),
    };
    if !v.is_object() {
        return Err("现有配置根节点不是对象，已停止写入".into());
    }
    let map = ensure_obj(&mut v, &["provider"])?;
    let stale: Vec<String> = map
        .iter()
        .filter(|(k, blk)| {
            crate::provider_id::is_ccode_provider(k) && k.as_str() != provider_id && !opencode_key_file_alive(blk)
        })
        .map(|(k, _)| k.clone())
        .collect();
    for k in stale {
        map.remove(&k);
    }
    map.insert(provider_id.into(), provider);
    let root = v.as_object_mut().unwrap();
    let points_to_mesa = |val: Option<&Value>| {
        val.and_then(|m| m.as_str())
            .and_then(|m| m.split_once('/'))
            .is_some_and(|(p, _)| crate::provider_id::is_ccode_provider(p))
    };
    for (k, val) in [("model", model), ("small_model", small_model)] {
        match val {
            Some(m) => {
                root.insert(k.into(), json!(format!("{provider_id}/{m}")));
            }
            None if points_to_mesa(root.get(k)) => {
                root.remove(k);
            }
            None => {}
        }
    }
    to_pretty(&v)
}

/// 渠道块的密钥是 `{file:<路径>}` 引用且那个文件还在
fn opencode_key_file_alive(blk: &Value) -> bool {
    blk.pointer("/options/apiKey")
        .and_then(|k| k.as_str())
        .and_then(|k| k.strip_prefix("{file:"))
        .and_then(|k| k.strip_suffix('}'))
        .is_some_and(|p| Path::new(p).is_file())
}

/// OpenCode 对话里出现过的 Mesa 渠道与模型（只读 opencode.db 的 assistant 消息）
fn opencode_thread_refs() -> Vec<(String, String)> {
    let Some(db) = crate::sessions::opencode_db_candidates().into_iter().find(|p| p.is_file()) else {
        return Vec::new();
    };
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(300));
    let Ok(mut stmt) = conn.prepare(
        "SELECT DISTINCT json_extract(data, '$.providerID'), json_extract(data, '$.modelID') FROM message \
         WHERE json_extract(data, '$.role') = 'assistant'",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)));
    rows.map(|it| {
        it.flatten()
            .filter_map(|(p, m)| Some((p?, m.unwrap_or_default())))
            .filter(|(p, _)| crate::provider_id::short_id_from_provider(p).is_some())
            .collect()
    })
    .unwrap_or_default()
}

/// 一条 OpenCode 绑定写成渠道块：密钥落 0600 文件、块里写 `{file:}`，按模型的参数与请求头同启动口径
fn opencode_provider_plan(
    home: &Path,
    profile: &Profile,
    key: Option<&str>,
) -> Result<(Value, Option<PlannedWrite>), String> {
    let pid = profile.provider_name();
    let model = profile.models.first().map(String::as_str);
    let (key_ref, key_plan) = match key {
        Some(k) => {
            let kp = opencode_key_path(home, &pid).ok_or("无法确定平台配置目录")?;
            let r = format!("{{file:{}}}", kp.to_string_lossy());
            (Some(r), Some(PlannedWrite { tag: "opencode-key", path: kp, content: k.to_string() }))
        }
        None => (None, None),
    };
    let mut provider = agents::opencode_provider_json(profile, key_ref.as_deref(), model);
    overlay_opencode_per_model(&mut provider, profile);
    // 请求头写 {env:VAR}：值取外部终端里的同名变量，不落密文
    if !profile.request_policy.header_env.is_empty() {
        let headers: serde_json::Map<String, Value> = profile
            .request_policy
            .header_env
            .iter()
            .map(|(h, var)| (h.clone(), json!(format!("{{env:{var}}}"))))
            .collect();
        provider["options"]["headers"] = Value::Object(headers);
    }
    Ok((provider, key_plan))
}

/// OpenCode 续聊层（2026-10-31，同 Codex「切全局只动默认」）：对话里出现过、或磁盘上已有的别的 Mesa 渠道，
/// 认得出网关的按 `{file:}` 重写（明文块因此改成引用，老对话用过、绑定里已没有的模型补回去）。
/// 只进预览与写入，不进漂移比对（对象按键子集比，多出的渠道块本来就不算漂移）
fn extend_opencode_plans(
    home: &Path,
    plans: &mut Vec<PlannedWrite>,
    profiles: &[Profile],
    current: &Profile,
) -> Result<(), String> {
    let Some(idx) = plans.iter().position(|p| p.tag == "opencode.json" || p.tag == "opencode.jsonc") else {
        return Ok(());
    };
    let current_pid = current.provider_name();
    let refs = opencode_thread_refs();
    let disk: Vec<String> = read_existing(&plans[idx].path)?
        .and_then(|t| serde_json::from_str::<Value>(&crate::mcp::strip_jsonc(&t)).ok())
        .and_then(|v| v.get("provider").and_then(|p| p.as_object()).map(|m| m.keys().cloned().collect()))
        .unwrap_or_default();
    let mut targets: Vec<String> = refs.iter().map(|(p, _)| p.clone()).chain(disk).collect();
    targets.sort();
    targets.dedup();
    targets.retain(|p| crate::provider_id::short_id_from_provider(p).is_some() && *p != current_pid);
    if targets.is_empty() {
        return Ok(());
    }
    let mut v: Value = serde_json::from_str(&plans[idx].content).map_err(|e| e.to_string())?;
    let mut extra = Vec::new();
    for pid in targets {
        let Some(binding) = profiles.iter().find(|p| {
            p.agent == "opencode"
                && p.account_type != crate::profiles::AccountType::Official
                && !p.no_auth
                && p.base_url.is_some()
                && p.gateway_id.as_deref().is_some_and(|g| crate::provider_id::gateway_matches_provider(g, &pid))
        }) else {
            continue;
        };
        let Ok(Some(key)) = crate::profiles::get_key_for_profile(binding) else {
            continue;
        };
        let mut b = binding.clone();
        b.provider_override = Some(pid.clone());
        for (_, m) in refs.iter().filter(|(p, m)| *p == pid && !m.is_empty()) {
            if !b.models.contains(m) {
                b.models.push(m.clone());
            }
        }
        let (provider, key_plan) = opencode_provider_plan(home, &b, Some(&key))?;
        ensure_obj(&mut v, &["provider"])?.insert(pid, provider);
        extra.extend(key_plan);
    }
    plans[idx].content = to_pretty(&v)?;
    for p in extra {
        upsert_plan(plans, p.tag, p.path, p.content);
    }
    Ok(())
}

/// OpenCode 密钥落 Mesa 自己的 0600 文件，opencode.json 里写 `{file:<路径>}` 引用（官方 config 文档的变量替换），
/// 免得明文进 opencode.json（常被同步进 dotfiles）。测试态放在传入的 home 下，不碰本机配置目录
fn opencode_key_path(home: &Path, provider_id: &str) -> Option<PathBuf> {
    let dir = if cfg!(test) {
        home.join("mesa-secrets")
    } else {
        crate::dirs::config_dir()?.join("ccode").join("secrets")
    };
    Some(dir.join(format!("opencode-{provider_id}.key")))
}

/// OpenCode 全局写入：每个模型写自己的 options，不再把一份策略套到全部模型。
fn overlay_opencode_per_model(provider: &mut Value, profile: &Profile) {
    let Some(models_map) = provider.get_mut("models").and_then(|v| v.as_object_mut()) else {
        return;
    };
    let gw = profile
        .gateway_id
        .as_deref()
        .and_then(crate::gateway_store::find_gateway);
    for m in &profile.models {
        let mut tmp = profile.clone();
        if let Some(gm) = gw
            .as_ref()
            .and_then(|g| g.models.iter().find(|x| x.id == *m))
        {
            tmp.request_policy.temperature = gm.temperature;
            tmp.request_policy.top_p = gm.top_p;
            tmp.request_policy.max_output_tokens = gm.max_output_tokens;
            tmp.request_policy.reasoning_effort = gm.reasoning_effort.clone();
        }
        crate::combo::apply_to_profile(&mut tmp, Some(m));
        let policy = &tmp.request_policy;
        let mut opts = serde_json::Map::new();
        if let Some(v) = policy.temperature {
            opts.insert("temperature".into(), json!(v));
        }
        if let Some(v) = policy.top_p {
            opts.insert("topP".into(), json!(v));
        }
        if let Some(v) = policy.max_output_tokens {
            opts.insert("maxOutputTokens".into(), json!(v));
        }
        if let Some(v) = policy.reasoning_effort.as_deref() {
            opts.insert("reasoningEffort".into(), json!(v));
        }
        if opts.is_empty() {
            continue;
        }
        if let Some(entry) = models_map.get_mut(m) {
            entry["options"] = Value::Object(opts);
        }
    }
}

// ===== TOML 补丁（toml_edit 保留文档其余部分） =====

pub(crate) fn parse_toml_doc(existing: Option<&str>) -> Result<toml_edit::DocumentMut, String> {
    crate::mcp::strip_bom(existing.unwrap_or(""))
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("现有 TOML 配置解析失败，已停止写入: {e}"))
}

/// 取子表；已存在但不是表时报错停止，避免覆盖用户数据
pub(crate) fn sub_table<'a>(
    item: &'a mut toml_edit::Item,
    key: &str,
) -> Result<&'a mut toml_edit::Item, String> {
    if let Some(existing) = item.as_table().and_then(|t| t.get(key)) {
        if !existing.is_table() {
            return Err(format!("配置项 {key} 不是表，已停止写入"));
        }
    }
    let table = item
        .as_table_mut()
        .ok_or_else(|| "配置文档结构异常，已停止写入".to_string())?;
    Ok(table.entry(key).or_insert(toml_edit::table()))
}

/// Codex「设为全局」统一写进同一个渠道名（2026-10-28 用户拍板，与 cc-switch 同名）：
/// 客户端侧栏只列当前默认渠道下的对话（matrix §1 实测），每个网关一个名字会让切换后
/// 别的连接的对话全藏起来。官方账号不进这个名字（见 patch_codex_config_official：中转历史接不到官方）。
/// Mesa 自己启动用的 `ccode-<短id>` 内联渠道不变（恢复会话靠它认网关）。
pub(crate) const CODEX_GLOBAL_PROVIDER: &str = "custom";

/// 整块换掉共用渠道：上一家（cc-switch 或官方形态）留下的 requires_openai_auth、
/// supports_websockets、env_key 等残键不能带到新连接上。
fn replace_codex_global_provider(
    doc: &mut toml_edit::DocumentMut,
    table: toml_edit::Table,
) -> Result<(), String> {
    let providers = sub_table(doc.as_item_mut(), "model_providers")?;
    let t = providers
        .as_table_mut()
        .ok_or_else(|| "model_providers 不是表，已停止写入".to_string())?;
    t.insert(CODEX_GLOBAL_PROVIDER, toml_edit::Item::Table(table));
    doc["model_provider"] = toml_edit::value(CODEX_GLOBAL_PROVIDER);
    Ok(())
}

fn patch_codex_config(
    existing: Option<&str>,
    base_url: Option<&str>,
    model: Option<&str>,
    catalog: Option<&std::path::Path>,
    effort: Option<&str>,
    key: &str,
) -> Result<String, String> {
    use toml_edit::value;
    let mut doc = parse_toml_doc(existing)?;
    if let Some(t) = sub_table(doc.as_item_mut(), "model_providers")?.as_table_mut() {
        t.remove(crate::provider_id::LEGACY);
    }
    let mut blk = toml_edit::Table::new();
    blk["name"] = value("Mesa");
    if let Some(u) = base_url {
        blk["base_url"] = value(u);
    }
    blk["wire_api"] = value("responses");
    // 认证同 set_codex_provider_static_auth：bearer 写块内，不走 auth.json
    blk["requires_openai_auth"] = value(false);
    blk["experimental_bearer_token"] = value(key);
    replace_codex_global_provider(&mut doc, blk)?;
    if let Some(m) = model.filter(|s| !s.is_empty()) {
        doc["model"] = value(m);
    } else {
        doc.remove("model");
    }
    // /model 选择器的模型目录（仅启动时读取）；空名单必须撤掉上一份引用。
    if let Some(p) = catalog {
        doc["model_catalog_json"] = value(p.to_string_lossy().as_ref());
    } else {
        doc.remove("model_catalog_json");
    }
    if let Some(e) = effort.filter(|s| !s.is_empty()) {
        doc["model_reasoning_effort"] = value(e);
    } else {
        doc.remove("model_reasoning_effort");
    }
    // 与启动注入同口径（agents::codex_relay_compat_args）：中转不支持官方托管的网页搜索，带着就被拒
    doc["web_search"] = value("disabled");
    // /review、子 agent、记忆整理另外点名的模型：设过的改成这次的模型（同启动 codex_relay_model_args）
    if let Some(m) = model.filter(|s| !s.is_empty()) {
        for path in agents::CODEX_SIDE_MODEL_KEYS {
            set_toml_path_if_present(&mut doc, path, m);
        }
    }
    Ok(doc.to_string())
}

/// 磁盘上的全局目录若以计划里的条目开头（后面是续聊层追加的），返回磁盘原文，否则返回计划
fn codex_catalog_as_written(path: &Path, planned: String) -> String {
    let models = |t: &str| {
        serde_json::from_str::<Value>(t)
            .ok()
            .and_then(|v| v.get("models").and_then(|m| m.as_array()).cloned())
    };
    let Ok(live) = fs::read_to_string(path) else {
        return planned;
    };
    match (models(&planned), models(&live)) {
        (Some(p), Some(l)) if l.len() > p.len() && l[..p.len()] == p[..] => live,
        _ => planned,
    }
}

/// 与启动注入同口径、全局写入以前漏掉的两处：
/// - 顶层 `model_context_window` / `model_auto_compact_token_limit` 盖过模型目录里的窗口：确知新模型窗口就改写
///   （同 agents 启动 `-c`，压缩点取 95%），不知道就撤掉，上一家留下的旧窗口不能接着用；
/// - ChatGPT 自带的 `codex-app-tools` 插件走官方登录，中转下失效登录态 401（同 codex_relay_compat_args）。
///   官方切回时 patch_codex_config_official 撤掉这一项。
/// - 自定义请求头写成渠道的 `env_http_headers`（值是环境变量名，不落密文；外部终端有这个变量就带上）。
fn patch_codex_relay_extras(
    content: &str,
    model: Option<&str>,
    gateway_id: Option<&str>,
    header_env: &BTreeMap<String, String>,
) -> Result<String, String> {
    use toml_edit::value;
    let mut doc = parse_toml_doc(Some(content))?;
    if !header_env.is_empty() {
        let providers = sub_table(doc.as_item_mut(), "model_providers")?;
        let blk = sub_table(providers, CODEX_GLOBAL_PROVIDER)?;
        let mut headers = toml_edit::InlineTable::new();
        for (h, var) in header_env {
            headers.insert(h.as_str(), toml_edit::Value::from(var.as_str()));
        }
        blk["env_http_headers"] = value(headers);
    }
    let ctx = model.and_then(|m| crate::model_registry::model_context_size_declared_for(m, gateway_id));
    match ctx {
        Some(c) => {
            doc["model_context_window"] = value(c);
            doc["model_auto_compact_token_limit"] = value(c.saturating_mul(95) / 100);
        }
        None => {
            doc.remove("model_context_window");
            doc.remove("model_auto_compact_token_limit");
        }
    }
    let plugins = sub_table(doc.as_item_mut(), "plugins")?;
    let entry = sub_table(plugins, CODEX_APP_TOOLS_PLUGIN)?;
    entry["enabled"] = value(false);
    Ok(doc.to_string())
}

const CODEX_APP_TOOLS_PLUGIN: &str = "codex-app-tools@openai-bundled";

/// 键路径上已有字符串值时改成 `value`；没有就不建
fn set_toml_path_if_present(doc: &mut toml_edit::DocumentMut, path: &[&str], value: &str) {
    let (last, parents) = path.split_last().expect("非空路径");
    let mut cur: &mut toml_edit::Item = doc.as_item_mut();
    for seg in parents {
        match cur.get_mut(*seg) {
            Some(next) => cur = next,
            None => return,
        }
    }
    if cur.get(*last).and_then(|v| v.as_str()).is_some() {
        cur[*last] = toml_edit::value(value);
    }
}

/// 键路径上的字符串值满足条件时删掉
fn remove_toml_path_if(doc: &mut toml_edit::DocumentMut, path: &[&str], pred: impl Fn(&str) -> bool) {
    let (last, parents) = path.split_last().expect("非空路径");
    let mut cur: &mut toml_edit::Item = doc.as_item_mut();
    for seg in parents {
        match cur.get_mut(*seg) {
            Some(next) => cur = next,
            None => return,
        }
    }
    if cur.get(*last).and_then(|v| v.as_str()).is_some_and(&pred) {
        if let Some(t) = cur.as_table_like_mut() {
            t.remove(last);
        }
    }
}

/// Codex 官方账号「设为全局」：撤掉 `model_provider`（回落内置 openai，认证交给 auth.json 的 ChatGPT 登录）、
/// 模型目录与非官方模型名。**共用渠道 `custom` 块原样留着**（2026-10-28 用户实测改回）：曾把官方也写进
/// custom（cc-switch 统一官方块同形），结果客户端里中转跑过的老对话被接到官方，历史里中转留下的条目
/// 官方接口不收（`input[n].content: array too long`），整段对话续不上。官方对话归内置 openai，
/// 中转老对话留在 custom 照旧走原连接；思考档、MCP、项目信任、其他渠道定义块不动。
fn patch_codex_config_official(existing: Option<&str>) -> Result<String, String> {
    let mut doc = parse_toml_doc(existing)?;
    doc.remove("model_provider");
    // Mesa 的全局目录留着：官方默认下还装着中转老对话的模型（续聊层按需重建或撤掉，见 codex_continuity）
    remove_toml_path_if(&mut doc, &["model_catalog_json"], |p| !crate::codex_continuity::is_global_catalog(p));
    // openai_base_url 会把内置 openai 渠道改道到别的地址；web_search 是中转时 Mesa 关的，官方恢复默认
    doc.remove("openai_base_url");
    remove_toml_path_if(&mut doc, &["web_search"], |v| v == "disabled");
    // 中转时 Mesa 关掉的 ChatGPT 插件与写进去的上下文窗口，官方恢复默认
    let plugins_empty = match doc.get_mut("plugins").and_then(|p| p.as_table_like_mut()) {
        Some(plugins) => {
            let off = plugins
                .get(CODEX_APP_TOOLS_PLUGIN)
                .and_then(|e| e.get("enabled"))
                .and_then(|v| v.as_bool())
                == Some(false);
            if off {
                plugins.remove(CODEX_APP_TOOLS_PLUGIN);
            }
            plugins.is_empty()
        }
        None => false,
    };
    if plugins_empty {
        doc.remove("plugins");
    }
    doc.remove("model_context_window");
    doc.remove("model_auto_compact_token_limit");
    for path in agents::CODEX_SIDE_MODEL_KEYS {
        remove_toml_path_if(&mut doc, path, |m| !agents::official_model_allowed("codex", m));
    }
    let foreign = doc
        .get("model")
        .and_then(|v| v.as_str())
        .is_some_and(|m| !agents::official_model_allowed("codex", m));
    if foreign {
        doc.remove("model");
    }
    Ok(doc.to_string())
}

/// 「注册到 Codex 客户端（不切换默认）」的 config.toml 补丁：只写 provider 定义块，
/// 顶层 model_provider/model 一律不动——matrix §2：[model_providers.x] 只有显式设为
/// 默认才接管请求；客户端续聊会话只需要定义可查（查不到才报「Model provider not found」）
///
/// 认证与「设为全局」同一条：experimental_bearer_token，不写 auth.json。
fn patch_codex_config_register(
    existing: Option<&str>,
    base_url: Option<&str>,
    provider_id: &str,
    key: &str,
) -> Result<String, String> {
    use toml_edit::value;
    let mut doc = parse_toml_doc(existing)?;
    let providers = sub_table(doc.as_item_mut(), "model_providers")?;
    let blk = sub_table(providers, provider_id)?;
    blk["name"] = value("Mesa");
    if let Some(u) = base_url {
        blk["base_url"] = value(u);
    }
    set_codex_provider_static_auth(blk, key);
    blk["wire_api"] = value("responses");
    Ok(doc.to_string())
}

/// kimi 模型别名：清洗为 TOML 裸键字符集 [A-Za-z0-9_-]，无需引号
fn kimi_model_alias(model: &str) -> String {
    model
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

// pub(crate)：理由同 patch_gemini_settings（黄金样本按最终文本断言）。
pub(crate) fn patch_kimi_config(
    existing: Option<&str>,
    provider_type: &str,
    profile_name: &str,
    base_url: Option<&str>,
    key: Option<&str>,
    models: &[String],
    require_context_size: bool,
    provider_id: &str,
    gateway_id: Option<&str>,
) -> Result<String, String> {
    use toml_edit::value;
    let mut doc = parse_toml_doc(existing)?;
    // 旧版 `ccode` 渠道：还有模型别名指着它（老会话按别名续）就留着，没人用了才撤
    let legacy_in_use = doc
        .get("models")
        .and_then(|m| m.as_table_like())
        .is_some_and(|t| {
            t.iter().any(|(_, item)| item.get("provider").and_then(|p| p.as_str()) == Some(crate::provider_id::LEGACY))
        });
    let providers = sub_table(doc.as_item_mut(), "providers")?;
    if provider_id != crate::provider_id::LEGACY && !legacy_in_use {
        if let Some(t) = providers.as_table_mut() {
            t.remove(crate::provider_id::LEGACY);
        }
    }
    let ccode = sub_table(providers, provider_id)?;
    ccode["type"] = value(provider_type);
    if let Some(u) = base_url {
        ccode["base_url"] = value(u);
    }
    if let Some(k) = key {
        ccode["api_key"] = value(k);
    }
    // 选择器按 [models.*] 别名列出模型：每个 profile 模型一个别名表
    if models.is_empty() {
        // 向后兼容：无模型列表时仍写单个 models.ccode 占位
        let models_tbl = sub_table(doc.as_item_mut(), "models")?;
        let mc = sub_table(models_tbl, provider_id)?;
        mc["provider"] = value(provider_id);
        if require_context_size {
            mc["max_context_size"] = value(131_072);
        }
        doc["default_model"] = value(provider_id);
    } else {
        let models_tbl = sub_table(doc.as_item_mut(), "models")?;
        for m in models {
            let t = sub_table(models_tbl, &kimi_model_alias(m))?;
            t["provider"] = value(provider_id);
            t["model"] = value(m.as_str());
            // 此键为必填（实证：kimi 2.1.0 二进制在模型无 maxContextSize 时硬抛
            // 「must define a positive max_context_size in config.toml」，非校验告警）。
            // 因此**不能省略**——注册链未知时只能写保守下限，与 opencode 的 limit 同理。
            // （旧注释称「0.31+ 必填」，该版本边界无实证，勿作依赖。）
            if require_context_size {
                t["max_context_size"] =
                    value(crate::model_registry::model_context_size_for(m, gateway_id));
                // 选择器 label 优先 display_name：用 profile 名避免显示成 provider id "ccode"
                t["display_name"] = value(format!("{profile_name} · {m}"));
                // 思考/视觉能力只写**确知为真**的（声明层 `== Some(true)`），估值层的
                // 关键词推断不参与：`capabilities` 是完备声明（CLI 用 some(===) 判成员），
                // 写进去等于断言「不在此表即不支持」。对未知模型我们没资格做这个断言。
                //
                // 此处与 env 通道（agents.rs）策略不同，因为缺省集不同：
                //   env 通道缺省是确定的 `["image_in","thinking"]`，并集不会超出它；
                //   本通道是普通 model alias，`capabilities` 为 schema 可选，缺省值
                //   取决于 CLI 自己是否认得该模型（`capabilitiesForModel` 无信息时返回
                //   undefined），我们猜不出边界，所以未知就整个不写。
                //
                // （旧注释称本通道缺省只有 ["tool_use"]——那是
                // CUSTOM_REGISTRY_DEFAULT_CAPABILITIES，属自定义注册项路径，与 model
                // alias 不是一条路，勿再引用。）
                let thinking = crate::model_registry::model_thinking_declared_for(m, gateway_id);
                let vision = crate::model_registry::model_supports_vision_declared_for(m, gateway_id);
                if thinking == Some(true) || vision == Some(true) {
                    let mut caps = vec!["tool_use"];
                    if thinking == Some(true) {
                        caps.push("thinking");
                    }
                    if vision == Some(true) {
                        caps.push("image_in");
                    }
                    t["capabilities"] =
                        toml_edit::value(caps.into_iter().collect::<toml_edit::Array>());
                }
            }
        }
        doc["default_model"] = value(kimi_model_alias(&models[0]));
    }
    Ok(doc.to_string())
}

/// Mesa 开的 Kimi 会话存的模型别名是 `__kimi_env_model__`（启动经 KIMI_MODEL_* 合成，agents::KIMI_ENV_MODEL_ALIAS），
/// 离开 Mesa 用 `kimi -S` 续时别名找不到。新版全局配置里把这个别名指到这次的连接与首个模型：外面续 Mesa 开的会话走
/// 当前全局连接；Mesa 里启动时 env 合成的同名别名优先（2.4.1 实测），不受影响。只写新版目录（旧版 Python CLI 不用这个别名）
fn patch_kimi_env_alias(content: &str, profile: &Profile, provider_id: &str) -> Result<String, String> {
    use toml_edit::value;
    let Some(m) = profile.models.first() else {
        return Ok(content.to_string());
    };
    let mut doc = parse_toml_doc(Some(content))?;
    let models_tbl = sub_table(doc.as_item_mut(), "models")?;
    let mut t = toml_edit::Table::new();
    t["provider"] = value(provider_id);
    t["model"] = value(m.as_str());
    t["max_context_size"] = value(crate::model_registry::model_context_size_for(m, profile.gateway_id.as_deref()));
    t["display_name"] = value(format!("Mesa 开的对话 · {m}"));
    models_tbl
        .as_table_mut()
        .ok_or_else(|| "models 不是表，已停止写入".to_string())?
        .insert(agents::KIMI_ENV_MODEL_ALIAS, toml_edit::Item::Table(t));
    Ok(doc.to_string())
}

/// Kimi 思考档写进各模型段的 `default_effort`（2.4.0 二进制：模型段 support_efforts / default_effort）。与启动的
/// KIMI_MODEL_THINKING_EFFORT 同口径只给 kimi 协议：别的协议 Kimi 把档位原样发给中转，不认的会报错。没设就撤掉 Mesa 写过的。
/// **只写 default_effort 不起作用**（2026-10-30 2.4.0 临时 KIMI_CODE_HOME + 假网关：请求 `thinking` 里没有 effort；
/// 补上 support_efforts 才带 `"effort": "high"`）——段里没声明档位表时，按网关这一行的档位（没有就 low/medium/high）补一份
fn patch_kimi_effort(content: &str, profile: &Profile, provider_type: &str) -> Result<String, String> {
    let effort = profile
        .request_policy
        .reasoning_effort
        .as_deref()
        .and_then(crate::agent_specs::canonical_reasoning_effort)
        .filter(|_| provider_type == "kimi");
    let mut doc = parse_toml_doc(Some(content))?;
    let pid = profile.provider_name();
    if let Some(models) = doc.get_mut("models").and_then(|m| m.as_table_like_mut()) {
        for (_, entry) in models.iter_mut() {
            let Some(t) = entry.as_table_like_mut() else { continue };
            if t.get("provider").and_then(|p| p.as_str()) != Some(pid.as_str()) {
                continue;
            }
            match effort.as_deref() {
                Some(e) => {
                    if t.get("support_efforts").is_none() {
                        let model = t.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
                        let mut levels = gateway_effort_levels(profile, &model)
                            .unwrap_or_else(|| ["low", "medium", "high"].map(String::from).to_vec());
                        if !levels.iter().any(|l| l == e) {
                            levels.push(e.to_string());
                        }
                        t.insert("support_efforts", toml_edit::value(levels.into_iter().collect::<toml_edit::Array>()));
                    }
                    t.insert("default_effort", toml_edit::value(e));
                }
                None => {
                    t.remove("default_effort");
                }
            }
        }
    }
    Ok(doc.to_string())
}

/// Grok：~/.grok/config.toml（TOML）。写入面与启动注入同口径（matrix §9）：
/// 密钥写进每个 `[model.<id>].api_key`（2026-10-30 起）：凭证优先级只有「逐模型 api_key/env_key > 登录令牌 >
/// XAI_API_KEY」三档，**顶层 `api_key` 1.0.70 不读**（隔离 GROK_HOME + 本地抓包实测：只写顶层报未登录；
/// 登录过官方账号时中转段没有自己的 key 会把 xAI 令牌发去中转）。以前写的顶层 api_key 顺手撤掉 +
/// [endpoints].models_base_url（= 注入的 GROK_MODELS_BASE_URL）+
/// [models].default（首个模型）。请求策略落 [models] 全局默认（键名与 GROK_CONFIG
/// overlay 一致：temperature/top_p/max_completion_tokens/default_reasoning_effort）；
/// Header 写 $VAR 引用——grok 读磁盘配置同样过 expand_env_vars_in_toml
///（loader.rs load_toml_file 实证），密文不落盘。
/// 与 claude 的 Mesa 专有键（EFFORT_LEVEL 随写随清）不同：[models] 这些是通用键，
/// 用户手写的同名值也可能是本意——只设不删，过期值靠「撤销上次写入/恢复初始状态」兜底。
/// 逐模型 [model.<id>] 段（2026-09-01 起）：绑定设了 API 后端（api_backend，overlay
/// 白名单够不到、全局写入是 Mesa 侧唯一通道）或权威层确知 context_window 时才建段，
/// name 随段写（配置名 · 模型，选择器口径一致）；权威层 = 用户覆盖/网关实测缓存
///（model_context_size_authoritative_for——config 优先级高于中转目录，估值层不配写）。
/// 段键 = 目录模型 id，含 / 或 . 的 id 依赖 toml_edit 自动加引号（测试锁死）。
/// 每个绑定模型都建段，并写推理强度菜单（1.0.40 实证）：中转 `/v1/models` 不带
/// `reasoning_efforts` 时 Grok 不出 `/effort`；只写 `[models].default_reasoning_effort`
/// 也不出菜单。字段形状与内置 grok-4.6 一致（`value`/`label`/`description`，
/// 旧 `{ effort = "..." }` 整段被忽略）。已有 `reasoning_efforts` 不覆盖；
/// 中转目录把模型标成 `supports_reasoning_effort = false` 时改回 true，否则菜单写了也不出。
/// [mcp_servers] 等其他段与用户手写的 [model.*] 其他字段一律不动。
fn patch_grok_config(
    existing: Option<&str>,
    key: Option<&str>,
    profile: &Profile,
) -> Result<String, String> {
    use toml_edit::value;
    let base_url = profile.base_url.as_deref();
    let model = profile.models.first().map(String::as_str);
    let policy = &profile.request_policy;
    let mut doc = parse_toml_doc(existing)?;
    // 顶层 api_key 是 Mesa 以前写的（Grok 不读），留着只是明文密钥
    doc.remove("api_key");
    if let Some(u) = base_url {
        let endpoints = sub_table(doc.as_item_mut(), "endpoints")?;
        endpoints["models_base_url"] = value(u);
    }
    let models_tbl = sub_table(doc.as_item_mut(), "models")?;
    if let Some(m) = model {
        models_tbl["default"] = value(m);
    }
    // 白名单是用户的选择器过滤，不接管；但默认模型不在名单里 Grok 直接拒绝启动（1.0.34 实证），只把默认模型并进去
    if let (Some(m), Some(list)) = (
        model,
        models_tbl.get_mut("allowed_models").and_then(|v| v.as_array_mut()),
    ) {
        if !list.iter().any(|v| v.as_str() == Some(m)) {
            list.push(m);
        }
    }
    // 会话标题 / 摘要与输入框下一句提示的模型：没设时 Grok 用内置 grok-* 却发到默认模型的地址，中转不认、
    // 标题生成失败；设着的常是上一家的模型。与启动覆盖层（agents::grok_config_overlay）同口径：
    // 钉成连接「模型分工」的后台小模型，没指定用主模型。xAI 官方地址不动
    let relay = base_url.is_some_and(|u| !agents::grok_is_xai_endpoint(u));
    if let Some(m) = profile.role_models.small.as_deref().or(model).filter(|_| relay) {
        models_tbl["session_summary"] = value(m);
        models_tbl["prompt_suggestion"] = value(m);
    }
    if let Some(v) = policy.temperature {
        models_tbl["temperature"] = value(v);
    }
    if let Some(v) = policy.top_p {
        models_tbl["top_p"] = value(v);
    }
    if let Some(v) = policy.max_output_tokens {
        models_tbl["max_completion_tokens"] = value(v as i64);
    }
    if let Some(v) = policy
        .reasoning_effort
        .as_deref()
        .and_then(crate::agent_specs::canonical_reasoning_effort)
        .filter(|s| crate::agent_specs::GROK_REASONING_EFFORTS.contains(&s.as_str()))
    {
        models_tbl["default_reasoning_effort"] = value(v);
    }
    if !policy.header_env.is_empty() {
        let mut headers = toml_edit::InlineTable::new();
        for (h, var) in &policy.header_env {
            headers.insert(h.as_str(), toml_edit::Value::from(format!("${var}")));
        }
        models_tbl["extra_headers"] = toml_edit::value(headers);
    }
    let api_backend = profile.api_backend.as_deref().filter(|s| !s.is_empty());
    for m in &profile.models {
        let ctx =
            crate::model_registry::model_context_size_for_config(m, profile.gateway_id.as_deref());
        let model_tbl = sub_table(doc.as_item_mut(), "model")?;
        let entry = sub_table(model_tbl, m)?;
        entry["name"] = value(format!("{} · {m}", profile.name));
        if let Some(u) = base_url {
            entry["base_url"] = value(u);
        }
        if let Some(k) = key {
            entry["api_key"] = value(k);
            if let Some(t) = entry.as_table_mut() {
                t.remove("env_key");
            }
        }
        if let Some(b) = api_backend {
            entry["api_backend"] = value(b);
        }
        if let Some(c) = ctx {
            entry["context_window"] = value(c);
        }
        let Some(table) = entry.as_table_mut() else {
            return Err(format!("模型 {m} 的配置段不是表，已停止写入"));
        };
        write_grok_reasoning_menu(table, gateway_effort_levels(profile, m).as_deref());
    }
    Ok(doc.to_string())
}

fn gateway_effort_levels(profile: &Profile, model: &str) -> Option<Vec<String>> {
    let raw = profile
        .gateway_id
        .as_deref()
        .and_then(crate::gateway_store::find_gateway)
        .and_then(|g| g.models.into_iter().find(|row| row.id == model))
        .and_then(|row| row.reasoning_effort)?;
    let levels = crate::agent_specs::reasoning_effort_levels(&raw);
    (!levels.is_empty()).then_some(levels)
}

/// Grok 1.0.40 推理强度菜单：与内置 grok-4.6 同形（`value`/`label`/`description`）。
/// 自定义端点的模型目录通常不带 `reasoning_efforts`，不写这段则 `/effort` 不出。
/// 用户已写过菜单则保留，避免每次设为全局覆盖手改档位。
/// 中转目录常把第三方模型标成 `supports_reasoning_effort = false`，
/// 这个 false 会让 Grok 丢掉后面补上的菜单，所以设为全局时改回 true。
fn write_grok_reasoning_menu(entry: &mut toml_edit::Table, levels: Option<&[String]>) {
    use toml_edit::{value, ArrayOfTables, Item, Table};
    if entry
        .get("supports_reasoning_effort")
        .and_then(|v| v.as_bool())
        != Some(true)
    {
        entry["supports_reasoning_effort"] = value(true);
    }
    if entry.get("reasoning_efforts").is_some() {
        return;
    }
    let chosen: Vec<String> = levels
        .filter(|rows| !rows.is_empty())
        .map(|rows| rows.to_vec())
        .unwrap_or_else(|| {
            ["xhigh", "high", "medium", "low"]
                .into_iter()
                .map(str::to_string)
                .collect()
        });
    let labels = [
        ("none", "None", "No extra reasoning"),
        ("minimal", "Minimal Effort", "Smallest reasoning budget"),
        ("low", "Low Effort", "Quick, fast implementations"),
        (
            "medium",
            "Medium Effort",
            "Balanced effort with standard implementation and testing",
        ),
        (
            "high",
            "High Effort",
            "Higher implementation quality with extensive reasoning",
        ),
        (
            "xhigh",
            "Extra High Effort",
            "Highest effort and reasoning level",
        ),
        ("max", "Max Effort", "Maximum reasoning budget"),
    ];
    if entry.get("reasoning_effort").is_none() {
        let fallback = chosen
            .iter()
            .find(|s| s.as_str() == "high")
            .or_else(|| chosen.first())
            .map(String::as_str)
            .unwrap_or("high");
        entry["reasoning_effort"] = value(fallback);
    }
    let default_level = entry
        .get("reasoning_effort")
        .and_then(|v| v.as_str())
        .filter(|s| chosen.iter().any(|row| row == s))
        .unwrap_or(chosen.first().map(String::as_str).unwrap_or("high"))
        .to_string();
    let mut tables = ArrayOfTables::new();
    for effort in &chosen {
        let (label, description) = labels
            .iter()
            .find(|(value, _, _)| *value == effort.as_str())
            .map(|(_, label, description)| (*label, *description))
            .unwrap_or((effort.as_str(), "Reasoning effort"));
        let is_default = effort == &default_level;
        let mut row = Table::new();
        row.insert("value", value(effort.as_str()));
        row.insert("label", value(label));
        row.insert("description", value(description));
        if is_default {
            row.insert("default", value(true));
        }
        tables.push(row);
    }
    entry.insert("reasoning_efforts", Item::ArrayOfTables(tables));
}

/// CodeBuddy：settings.json 的 env 块写 CODEBUDDY_* 三件套与输出上限。这次没有的值一律撤掉（2026-10-30）：
/// 以前只在有值时写，上一条连接的地址 / 模型会跟着这次的密钥一起生效
fn patch_codebuddy_settings(
    existing: Option<&str>,
    base_url: Option<&str>,
    key: Option<&str>,
    model: Option<&str>,
    max_output_tokens: Option<u64>,
) -> Result<String, String> {
    let mut v = parse_json_doc(existing)?;
    let env = ensure_obj(&mut v, &["env"])?;
    let max = max_output_tokens.map(|n| n.to_string());
    for (k, val) in [
        ("CODEBUDDY_BASE_URL", base_url),
        ("CODEBUDDY_API_KEY", key),
        ("CODEBUDDY_MODEL", model),
        ("CODEBUDDY_CODE_MAX_OUTPUT_TOKENS", max.as_deref()),
    ] {
        match val {
            Some(val) => {
                env.insert(k.into(), json!(val));
            }
            None => {
                env.remove(k);
            }
        }
    }
    // 别家留下的另一种令牌与请求头会跟着这次的地址一起发出
    env.remove("CODEBUDDY_AUTH_TOKEN");
    env.remove("CODEBUDDY_CUSTOM_HEADERS");
    to_pretty(&v)
}

/// CodeBuddy 的模型名单：`~/.codebuddy/models.json`（官方 docs/cli/models：`models` 数组按 id 覆盖内置、新 id 追加，
/// 1 秒防抖热加载）。每个绑定模型一条：`url` 是完整的 `<base>/chat/completions`（与 CODEBUDDY_BASE_URL 自拼同形），
/// `apiKey` 写 `${CODEBUDDY_API_KEY}` 引用 settings.json env 里那一把，不在这里再存明文；确知窗口写 `maxInputTokens`。
/// Mesa 的条目认 `name` =「配置名 · 模型」：先撤上一份 Mesa 条目再写，用户自己的条目与 `availableModels` 不动。
fn patch_codebuddy_models(existing: Option<&str>, profile: &Profile) -> Result<String, String> {
    let mut v = parse_json_doc(existing)?;
    let root = v.as_object_mut().expect("parse_json_doc 保证是对象");
    let list = root.entry("models").or_insert_with(|| json!([]));
    let Some(arr) = list.as_array_mut() else {
        return Err("models.json 的 models 不是数组，已停止写入".into());
    };
    arr.retain(|e| !codebuddy_mesa_entry(e));
    if let Some(base) = profile.base_url.as_deref().filter(|u| !u.trim().is_empty()) {
        let url = format!("{}/chat/completions", base.trim_end_matches('/'));
        for m in &profile.models {
            arr.retain(|e| e.get("id").and_then(|i| i.as_str()) != Some(m.as_str()));
            let mut e = json!({
                "id": m,
                "name": format!("{} · {m}", profile.name),
                "url": url,
                "apiKey": "${CODEBUDDY_API_KEY}",
                "supportsToolCall": true,
            });
            let gw = profile.gateway_id.as_deref();
            if let Some(ctx) = crate::model_registry::model_context_size_declared_for(m, gw) {
                e["maxInputTokens"] = json!(ctx);
            }
            if crate::model_registry::model_supports_vision_declared_for(m, gw) == Some(true) {
                e["supportsImages"] = json!(true);
            }
            if crate::model_registry::model_thinking_declared_for(m, gw) == Some(true) {
                e["supportsReasoning"] = json!(true);
            }
            arr.push(e);
        }
    }
    to_pretty(&v)
}

/// models.json 里 Mesa 写的条目：显示名是「配置名 · <id>」且引用 settings.json 的密钥
fn codebuddy_mesa_entry(e: &Value) -> bool {
    let id = e.get("id").and_then(|i| i.as_str()).unwrap_or("");
    let named = e
        .get("name")
        .and_then(|n| n.as_str())
        .is_some_and(|n| !id.is_empty() && n.ends_with(&format!(" · {id}")));
    named && e.get("apiKey").and_then(|k| k.as_str()) == Some("${CODEBUDDY_API_KEY}")
}

// ===== .env 补丁（gemini） =====

fn patch_env_file(existing: Option<&str>, pairs: &[(String, String)]) -> Result<String, String> {
    let mut lines: Vec<String> = existing.unwrap_or("").lines().map(String::from).collect();
    for (k, v) in pairs {
        // 值含换行会拆出额外 KEY=VALUE 行，既破坏 .env 也可能注入别的变量
        if v.contains('\n') || v.contains('\r') {
            return Err(format!("环境变量 {k} 的值包含换行符，已停止写入"));
        }
        let prefix = format!("{k}=");
        match lines.iter_mut().find(|l| l.starts_with(&prefix)) {
            Some(l) => *l = format!("{k}={v}"),
            None => lines.push(format!("{k}={v}")),
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    Ok(out)
}

// ===== 官方账号「设为全局」：撤掉 Mesa 写的 API 键，交回 CLI 自己的登录 =====
//
// 2026-10-28 用户拍板：官方账号与 API 连接一样走写计划（预览、备份、挡路、托盘勾选），
// 不再整份恢复首次快照（会冲掉之后的 MCP、项目信任等改动）。每家只撤会盖过官方登录的
// 键；别的配置、别的渠道定义一律不动。OpenCode 没有官方账号，Cursor 不支持设为全局。

/// 有官方账号「设为全局」写计划的 Agent。与前端 `officialGlobalIsPatch` 双端镜像。
pub(crate) fn official_global_is_patch(agent: &str) -> bool {
    matches!(
        agent,
        "codex" | "claude-code" | "gemini" | "qwen" | "codebuddy" | "kimi" | "grok"
    )
}

/// 官方账号能不能接着用这个模型名：中转模型名留给官方账号会直接报模型不存在。
pub(crate) fn official_model_kept(agent: &str, model: &str) -> bool {
    let m = model.trim().to_ascii_lowercase();
    match agent {
        // Claude Code 的别名（opus / sonnet …）官方账号照样认
        "claude-code" => {
            m.starts_with("claude")
                || matches!(m.as_str(), "opus" | "sonnet" | "haiku" | "fable" | "default" | "best" | "opusplan")
        }
        // gemini-* 与 CLI 自带别名（auto / pro / flash / flash-lite）
        "gemini" => m.starts_with("gemini") || matches!(m.as_str(), "auto" | "pro" | "flash" | "flash-lite"),
        "grok" => m.starts_with("grok"),
        _ => agents::official_model_allowed(agent, model),
    }
}

/// JSON 文件里删一组 env 键；模型键只在不是官方模型时删。
fn json_env_remove(
    v: &mut Value,
    keys: &[&str],
    model_keys: &[&str],
    agent: &str,
) -> Vec<String> {
    let mut removed_models = Vec::new();
    if let Some(env) = v.get_mut("env").and_then(|e| e.as_object_mut()) {
        for k in keys {
            env.remove(*k);
        }
        for k in model_keys {
            let foreign = env
                .get(*k)
                .and_then(|m| m.as_str())
                .is_some_and(|m| !official_model_kept(agent, m));
            if foreign {
                if let Some(Value::String(m)) = env.remove(*k) {
                    removed_models.push(m);
                }
            }
        }
    }
    removed_models
}

/// Claude Code：settings.json 的 env 里撤端点 / 密钥、Mesa 管的模型槽与上下文键；
/// ANTHROPIC_MODEL 是官方模型（或别名）时留着，思考档留着。
fn patch_claude_settings_official(existing: &str) -> Result<String, String> {
    let mut v = parse_json_doc(Some(existing))?;
    let mut keys: Vec<String> = [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_CUSTOM_MODEL_OPTION",
        "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    for slot in ["SONNET", "OPUS", "HAIKU", "FABLE"] {
        keys.push(format!("ANTHROPIC_DEFAULT_{slot}_MODEL"));
        keys.push(format!("ANTHROPIC_DEFAULT_{slot}_MODEL_NAME"));
    }
    // 其余连接键（请求头、别的 ANTHROPIC_*、Bedrock / Vertex 协议开关）同样会盖过官方登录
    if let Some(env) = v.get("env").and_then(|e| e.as_object()) {
        for k in env.keys() {
            if agents::claude_connection_env_key(k)
                && k != "ANTHROPIC_MODEL"
                && !k.starts_with("CLAUDE_CODE_OAUTH_")
            {
                keys.push(k.clone());
            }
        }
    }
    // Mesa 按中转模型写的几项（值认得出来）：官方模型用不着
    if let Some(env) = v.get("env").and_then(|e| e.as_object()) {
        for (k, val) in env {
            let mesa = match k.as_str() {
                "MAX_THINKING_TOKENS" => val == "0",
                "ENABLE_TOOL_SEARCH" => val == "false",
                "CLAUDE_CODE_ENABLE_TODO_TOOLS" => val == "1",
                _ => false,
            };
            if mesa {
                keys.push(k.clone());
            }
        }
    }
    let refs: Vec<&str> = keys.iter().map(String::as_str).collect();
    json_env_remove(&mut v, &refs, &["ANTHROPIC_MODEL"], "claude-code");
    if let Some(o) = v.as_object_mut() {
        o.remove("apiKeyHelper");
    }
    // 顶层 model（不在 env 里）同理：中转写的 glm 之类撤掉，Claude 用自己的默认
    let foreign_top = v
        .get("model")
        .and_then(|m| m.as_str())
        .is_some_and(|m| !official_model_kept("claude-code", m));
    if foreign_top {
        if let Some(o) = v.as_object_mut() {
            o.remove("model");
        }
    }
    to_pretty(&v)
}

/// CodeBuddy：settings.json 的 env 撤 CODEBUDDY_* 端点 / 密钥，非官方模型名一并撤（env 与顶层 `model` 都看）。
fn patch_codebuddy_settings_official(existing: &str) -> Result<String, String> {
    let mut v = parse_json_doc(Some(existing))?;
    json_env_remove(
        &mut v,
        &["CODEBUDDY_BASE_URL", "CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN", "CODEBUDDY_CUSTOM_HEADERS"],
        &["CODEBUDDY_MODEL"],
        "codebuddy",
    );
    let foreign_top = v
        .get("model")
        .and_then(|m| m.as_str())
        .is_some_and(|m| !official_model_kept("codebuddy", m));
    if foreign_top {
        if let Some(o) = v.as_object_mut() {
            o.remove("model");
        }
    }
    to_pretty(&v)
}

/// CodeBuddy models.json：撤 Mesa 写的条目（引用的密钥已撤，留着选了就报错），用户自己的条目留着
fn patch_codebuddy_models_official(existing: &str) -> Result<String, String> {
    let mut v = parse_json_doc(Some(existing))?;
    if let Some(arr) = v.get_mut("models").and_then(|m| m.as_array_mut()) {
        arr.retain(|e| !codebuddy_mesa_entry(e));
    }
    to_pretty(&v)
}

/// Qwen：撤 env 里两套协议的端点 / 密钥 / 模型（含 Mesa 专用密钥名）；`model.name` 只在等于被撤的模型名
/// （Mesa 写的）时撤。modelProviders 名单留着。**不再改成 qwen-oauth**（2026-10-30）：0.26.3 里 Qwen OAuth
/// 免费档 2026-04-15 停用后显示「No longer available」，切过去用不了；认证方式是 Mesa 写的协议名
///（openai / anthropic）就撤掉，Qwen 进门让用户自己选 Coding Plan 或 API Key。
fn patch_qwen_settings_official(existing: &str) -> Result<String, String> {
    let mut v = parse_json_doc(Some(existing))?;
    let mesa_auth = v
        .pointer("/security/auth/selectedType")
        .and_then(|t| t.as_str())
        .is_some_and(|t| matches!(t, "openai" | "anthropic"));
    if mesa_auth {
        if let Some(auth) = v.pointer_mut("/security/auth").and_then(|a| a.as_object_mut()) {
            auth.remove("selectedType");
        }
    }
    let mut removed = Vec::new();
    if let Some(env) = v.get_mut("env").and_then(|e| e.as_object_mut()) {
        env.remove(QWEN_MESA_KEY_ENV);
        for k in [
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "OPENAI_MODEL",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_MODEL",
        ] {
            if let Some(Value::String(m)) = env.remove(k) {
                if k.ends_with("_MODEL") {
                    removed.push(m);
                }
            }
        }
    }
    // Mesa 写的模型条目指着刚撤掉的 MESA_QWEN_API_KEY，留着就是 /model 里选了必失败的死条目；用户自己的条目不动
    if let Some(providers) = v.get_mut("modelProviders").and_then(|p| p.as_object_mut()) {
        for slot in providers.values_mut() {
            if let Some(arr) = slot.get_mut("models").and_then(|m| m.as_array_mut()) {
                arr.retain(|e| {
                    if qwen_mesa_entry(e) {
                        if let Some(id) = e.get("id").and_then(|i| i.as_str()) {
                            removed.push(id.to_string());
                        }
                        false
                    } else {
                        true
                    }
                });
            }
        }
    }
    let name = v.pointer("/model/name").and_then(|n| n.as_str()).map(String::from);
    if name.is_some_and(|n| removed.contains(&n)) {
        if let Some(model) = v.get_mut("model").and_then(|m| m.as_object_mut()) {
            model.remove("name");
        }
    }
    to_pretty(&v)
}

/// Gemini：Mesa 写的认证方式（gemini-api-key）撤掉，非 gemini 的 `model.name` 撤掉；模型名单与按模型参数留着。
/// 不再写死 oauth-personal（2026-10-30）：用 Vertex / 自己 AI Studio 密钥的人会被改掉，个人 Google 账号
/// 本身也常用不了（agents gemini 认证提示）。撤掉后 Gemini 进门让用户自己选认证方式。
fn patch_gemini_settings_official(existing: &str) -> Result<String, String> {
    let mut v = serde_json::from_str::<Value>(&crate::mcp::strip_jsonc(existing))
        .map_err(|e| format!("现有 settings.json 解析失败，已停止写入: {e}"))?;
    if !v.is_object() {
        return Err("现有 settings.json 根节点不是对象，已停止写入".into());
    }
    let mesa_auth = v.pointer("/security/auth/selectedType").and_then(|t| t.as_str()) == Some("gemini-api-key");
    if mesa_auth {
        if let Some(auth) = v.pointer_mut("/security/auth").and_then(|a| a.as_object_mut()) {
            auth.remove("selectedType");
        }
    }
    let foreign = v
        .pointer("/model/name")
        .and_then(|m| m.as_str())
        .is_some_and(|m| !official_model_kept("gemini", m));
    if foreign {
        if let Some(model) = v.get_mut("model").and_then(|m| m.as_object_mut()) {
            model.remove("name");
        }
    }
    to_pretty(&v)
}

/// .env 里删整行 `KEY=…`；模型键只在不是官方模型时删。
fn patch_env_file_remove(existing: &str, keys: &[&str], model_keys: &[&str], agent: &str) -> String {
    let drop = |line: &str| {
        let Some((k, val)) = line.split_once('=') else {
            return false;
        };
        let k = k.trim().trim_start_matches("export ").trim();
        keys.contains(&k)
            || (model_keys.contains(&k)
                && !official_model_kept(agent, val.trim().trim_matches('"').trim_matches('\'')))
    };
    let mut out: Vec<&str> = existing.lines().filter(|l| !drop(l)).collect();
    while out.last().is_some_and(|l| l.trim().is_empty()) {
        out.pop();
    }
    if out.is_empty() {
        String::new()
    } else {
        let mut s = out.join("\n");
        s.push('\n');
        s
    }
}

/// Kimi：默认模型改指官方登录（`kimi login`）配好的 `managed:kimi-code` 模型；
/// 没登录过就撤掉默认模型，kimi 进门会要求 /login。Mesa 写的渠道和模型别名连同密钥留着：会话存的是模型别名，
/// `kimi -S` 续中转老会话还要走原渠道（2026-10-31「切全局只动默认」，取代 10-30「撤掉渠道里的明文 api_key」——
/// 撤了老会话一续就缺密钥；Kimi 只有明文与 `api_key_env`〔要用户 shell 导出〕两种写法，没有可现取的引用）。
fn patch_kimi_config_official(existing: &str) -> Result<String, String> {
    let mut doc = parse_toml_doc(Some(existing))?;
    let managed: Vec<String> = doc
        .get("models")
        .and_then(|m| m.as_table_like())
        .map(|t| {
            t.iter()
                .filter(|(_, item)| {
                    item.get("provider").and_then(|p| p.as_str()) == Some("managed:kimi-code")
                })
                .map(|(k, _)| k.to_string())
                .collect()
        })
        .unwrap_or_default();
    let current = doc.get("default_model").and_then(|v| v.as_str()).map(String::from);
    match current.filter(|c| managed.contains(c)).or_else(|| managed.first().cloned()) {
        Some(alias) => doc["default_model"] = toml_edit::value(alias),
        None => {
            doc.remove("default_model");
        }
    }
    Ok(doc.to_string())
}

/// Grok：撤顶层 api_key / env_key 与 [endpoints].models_base_url；默认模型不是 grok 模型时撤；
/// 指向非 x.ai 地址的 [model.<id>] 段：没有自己密钥的整段撤（留着官方登录的令牌会被发去中转）；
/// 带自己 api_key / env_key 的留着——用户手写的不动，Mesa 写的也留（2026-10-31「切全局只动默认」，取代 10-30
/// 「Mesa 写的连同密钥整段撤」：会话记着 current_model_id，撤了 `grok -r` 续中转老会话就找不到模型）。
fn patch_grok_config_official(existing: &str) -> Result<String, String> {
    let mut doc = parse_toml_doc(Some(existing))?;
    doc.remove("api_key");
    doc.remove("env_key");
    let endpoints_empty = match doc.get_mut("endpoints").and_then(|e| e.as_table_like_mut()) {
        Some(t) => {
            t.remove("models_base_url");
            t.is_empty()
        }
        None => false,
    };
    if endpoints_empty {
        doc.remove("endpoints");
    }
    if let Some(models) = doc.get_mut("models").and_then(|m| m.as_table_like_mut()) {
        // 默认模型与标题 / 提示用的模型：不是 grok 模型的撤掉（官方账号用不了）
        for key in ["default", "session_summary", "prompt_suggestion"] {
            let foreign = models
                .get(key)
                .and_then(|d| d.as_str())
                .is_some_and(|d| !official_model_kept("grok", d));
            if foreign {
                models.remove(key);
            }
        }
    }
    let mut model_empty = false;
    if let Some(entries) = doc.get_mut("model").and_then(|m| m.as_table_like_mut()) {
        let relay: Vec<String> = entries
            .iter()
            .filter(|(_, item)| {
                let to_relay = item
                    .get("base_url")
                    .and_then(|u| u.as_str())
                    .is_some_and(|u| !crate::agents::grok_is_xai_endpoint(u));
                let own_key = item.get("api_key").is_some() || item.get("env_key").is_some();
                to_relay && !own_key
            })
            .map(|(k, _)| k.to_string())
            .collect();
        for k in relay {
            entries.remove(&k);
        }
        model_empty = entries.is_empty();
    }
    if model_empty {
        doc.remove("model");
    }
    Ok(doc.to_string())
}

/// 官方账号「设为全局」的写计划：文件不存在就不写（不存在 = 本来就没有 API 配置）。
fn plan_official_writes(home: &Path, agent: &str) -> Result<Vec<PlannedWrite>, String> {
    let mut plans = Vec::new();
    let dir = cli_dir(home, agent);
    let mut add = |tag: &'static str, path: PathBuf, f: &dyn Fn(&str) -> Result<String, String>| {
        if let Some(text) = read_existing(&path)? {
            plans.push(PlannedWrite { tag, content: f(&text)?, path });
        }
        Ok::<(), String>(())
    };
    match agent {
        "codex" => add("config.toml", dir.join("config.toml"), &|t| patch_codex_config_official(Some(t)))?,
        "claude-code" => add("settings.json", dir.join("settings.json"), &patch_claude_settings_official)?,
        "codebuddy" => {
            add("settings.json", dir.join("settings.json"), &patch_codebuddy_settings_official)?;
            add("models.json", dir.join("models.json"), &patch_codebuddy_models_official)?;
        }
        "qwen" => add("settings.json", dir.join("settings.json"), &patch_qwen_settings_official)?,
        "gemini" => {
            add(".env", dir.join(".env"), &|t| {
                Ok(patch_env_file_remove(
                    t,
                    &["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL"],
                    &["GEMINI_MODEL"],
                    "gemini",
                ))
            })?;
            add("settings.json", dir.join("settings.json"), &patch_gemini_settings_official)?;
        }
        "kimi" => {
            add("config.toml", dir.join("config.toml"), &patch_kimi_config_official)?;
            add("legacy-config.toml", kimi_legacy_dir(home).join("config.toml"), &patch_kimi_config_official)?;
        }
        "grok" => add("config.toml", dir.join("config.toml"), &patch_grok_config_official)?,
        other => return Err(format!("{other} 的官方账号不支持「设为全局」")),
    }
    Ok(plans)
}

/// 官方计划与磁盘是否「完全一致」。API 计划用子集比对（磁盘多出用户自己的键不算漂移）；
/// 官方计划是删键，子集比对对删键永远为真，必须整份比对。
fn disk_equals_plans(plans: &[PlannedWrite]) -> bool {
    plans.iter().all(|p| {
        let Ok(live) = fs::read_to_string(&p.path) else {
            return false;
        };
        let live = crate::mcp::strip_bom(&live);
        let name = p.path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name.ends_with(".json") {
            match (
                serde_json::from_str::<Value>(&p.content),
                serde_json::from_str::<Value>(&crate::mcp::strip_jsonc(live)),
            ) {
                (Ok(a), Ok(b)) => a == b,
                _ => p.content.trim() == live.trim(),
            }
        } else if name.ends_with(".toml") {
            match (toml::from_str::<toml::Value>(&p.content), toml::from_str::<toml::Value>(live)) {
                (Ok(a), Ok(b)) => a == b,
                _ => p.content.trim() == live.trim(),
            }
        } else {
            p.content.trim() == live.trim()
        }
    })
}

fn is_official(profile: &Profile) -> bool {
    profile.account_type == crate::profiles::AccountType::Official
}

/// 计划与磁盘是否一致：官方整份比、API 子集比（用户层的选择键不比，见 drift_plans）。
fn plans_match_disk(profile: &Profile, plans: &[PlannedWrite]) -> bool {
    if is_official(profile) {
        disk_equals_plans(plans)
    } else {
        disk_matches_plans(&drift_plans(profile, plans))
    }
}

/// 漂移比对用的计划：去掉用户在 CLI 里自己会改的「选择」键（规则 5「用户能改的写用户层」）。
/// Codex 客户端 / TUI 换模型、换思考档会把顶层 `model` / `model_reasoning_effort` 写回 config.toml
/// （2026-10-31 实测：在客户端选了 gpt-6-luna，磁盘就成了 gpt-6-luna）；Claude `/model`、`/effort` 同理写 settings.json
/// 顶层 `model` / `effortLevel`。这是用户的选择，不算「外部改过」，「按 Mesa 重写」也不该把它改回去。
/// 连接本身（地址、密钥、渠道、模型名单）照旧比。
fn drift_plans(profile: &Profile, plans: &[PlannedWrite]) -> Vec<PlannedWrite> {
    let keys: &[&str] = match profile.agent.as_str() {
        "codex" => &["model", "model_reasoning_effort"],
        "claude-code" => &["model", "effortLevel"],
        _ => &[],
    };
    plans
        .iter()
        .map(|p| {
            let name = p.path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let content = if keys.is_empty() {
                p.content.clone()
            } else if name == "config.toml" {
                match parse_toml_doc(Some(&p.content)) {
                    Ok(mut doc) => {
                        for k in keys {
                            doc.remove(k);
                        }
                        doc.to_string()
                    }
                    Err(_) => p.content.clone(),
                }
            } else if name == "settings.json" {
                match serde_json::from_str::<Value>(&p.content) {
                    Ok(mut v) => {
                        if let Some(o) = v.as_object_mut() {
                            for k in keys {
                                o.remove(*k);
                            }
                        }
                        to_pretty(&v).unwrap_or_else(|_| p.content.clone())
                    }
                    Err(_) => p.content.clone(),
                }
            } else {
                p.content.clone()
            };
            PlannedWrite { tag: p.tag, path: p.path.clone(), content }
        })
        .collect()
}

// ===== 计划与执行 =====

/// Codex 续聊层（codex_continuity）：在这次写计划上补老对话要用的渠道定义，重建全局模型目录。
/// 只进预览与写入，不进漂移比对——对话表天天在变，进比对会误报「外部改过」；
/// 续聊层只加渠道块、只在目录尾部追加，基础计划对磁盘的子集比对照样成立。
/// `relay` = 这次设为全局的中转绑定；None = 切回官方
fn extend_codex_plans(
    home: &Path,
    plans: &mut Vec<PlannedWrite>,
    profiles: &[Profile],
    relay: Option<&Profile>,
) -> Result<(), String> {
    use crate::codex_continuity as cc;
    let dir = codex_dir(home);
    let cfg_path = dir.join("config.toml");
    let base = match plans.iter().find(|p| p.path == cfg_path) {
        Some(p) => p.content.clone(),
        None => match read_existing(&cfg_path)? {
            Some(t) => t,
            None => return Ok(()),
        },
    };
    let inp = cc::Inputs::gather(&dir, profiles)?;
    let head = match relay {
        Some(p) => cc::Head::Relay(cc::relay_head_entries(p)),
        None => cc::Head::Official,
    };
    let out = cc::layer(&base, &head, &inp)?;
    upsert_plan(plans, "config.toml", cfg_path, out.config);
    match out.catalog {
        Some(text) => upsert_plan(plans, "model-catalog.json", inp.catalog_path, text),
        None => plans.retain(|p| p.path != inp.catalog_path),
    }
    Ok(())
}

fn upsert_plan(plans: &mut Vec<PlannedWrite>, tag: &'static str, path: PathBuf, content: String) {
    match plans.iter_mut().find(|p| p.path == path) {
        Some(p) => p.content = content,
        None => plans.push(PlannedWrite { tag, path, content }),
    }
}

/// 「补齐」与体检共用的输入：所有绑定，加上当前记着的 Codex 全局中转绑定（官方或没记录为 None）
fn codex_continuity_inputs(store: &ProfileStore) -> Result<(Vec<Profile>, Option<Profile>), String> {
    let active = crate::settings::read_current()
        .active_global_profiles
        .and_then(|m| m.get("codex").cloned())
        .and_then(|id| profile_for_write(store, &id).ok())
        .filter(|p| !is_official(p));
    Ok((store.list()?, active))
}

/// 按磁盘现状（谁是默认）算续聊层。返回（config.toml 原文, 续聊层结果, 默认, 输入）
fn codex_continuity_layer(
    home: &Path,
    profiles: &[Profile],
    active: Option<&Profile>,
) -> Result<Option<(String, crate::codex_continuity::LayerOut, crate::codex_continuity::Head, crate::codex_continuity::Inputs)>, String> {
    use crate::codex_continuity as cc;
    let dir = codex_dir(home);
    let Some(text) = read_existing(&dir.join("config.toml"))? else {
        return Ok(None);
    };
    let doc = parse_toml_doc(Some(&text))?;
    let head = cc::disk_head(&doc, || active.map(cc::relay_head_entries));
    let inp = cc::Inputs::gather(&dir, profiles)?;
    let out = cc::layer(&text, &head, &inp)?;
    Ok(Some((text, out, head, inp)))
}

/// 连接页 Codex 一栏的体检：客户端里有多少对话接不上（渠道没定义 / 模型不在目录里）、几个渠道块还存着明文密钥
#[tauri::command]
pub async fn codex_client_continuity(
    store: tauri::State<'_, ProfileStore>,
) -> Result<crate::codex_continuity::ContinuityDto, String> {
    let (profiles, active) = codex_continuity_inputs(&store)?;
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
        match codex_continuity_layer(&home, &profiles, active.as_ref())? {
            Some((text, _, head, inp)) => crate::codex_continuity::check(&text, &head, &inp),
            None => Ok(Default::default()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 「补齐」：只加渠道定义、重建 Mesa 的全局模型目录，不动默认渠道与模型；走全局写入的备份，可「撤销上次写入」
#[tauri::command]
pub async fn fix_codex_client_continuity(
    store: tauri::State<'_, ProfileStore>,
) -> Result<Vec<String>, String> {
    let (profiles, active) = codex_continuity_inputs(&store)?;
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
        let _guard = GLOBAL_CONFIG_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let _file_guard = crate::storage::config_lock("global-config")?;
        let Some((text, out, _, inp)) = codex_continuity_layer(&home, &profiles, active.as_ref())? else {
            return Ok(Vec::new());
        };
        let cfg_path = codex_dir(&home).join("config.toml");
        let mut plans = Vec::new();
        if out.config != text {
            plans.push(PlannedWrite { tag: "config.toml", path: cfg_path, content: out.config });
        }
        if let Some(catalog) = out.catalog {
            plans.push(PlannedWrite { tag: "model-catalog.json", path: inp.catalog_path, content: catalog });
        }
        if plans.is_empty() || disk_equals_plans(&plans) {
            return Ok(Vec::new());
        }
        apply_plans(&backups_root()?.join("codex"), &home, &plans)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_existing(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        // BOM 在读入口统一剥掉：各 patch_* 解析前不必各自处理，写回也不再带 BOM
        //（原文件字节已由备份按 fs::read 原样保留）
        Ok(text) => Ok(Some(crate::mcp::strip_bom(&text).to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "读取 {} 失败，已停止写入以免覆盖成空白配置: {error}",
            path.display()
        )),
    }
}

/// 计算要写入的全部文件内容；home 显式传入以便测试不碰真实主目录
fn plan_writes(
    home: &Path,
    profile: &Profile,
    key: Option<&str>,
    models: &[String],
) -> Result<Vec<PlannedWrite>, String> {
    if is_official(profile) {
        return plan_official_writes(home, &profile.agent);
    }
    if profile.no_auth {
        return Err("无密钥连接不支持「设为全局」；请使用启动注入，避免污染 CLI 全局配置".into());
    }
    let base_url = profile.base_url.as_deref();
    // 全局模式没有运行时模型选择，默认取模型列表首个（与启动注入的兜底一致）
    let model = models.first().map(|s| s.as_str());
    // 能力表先行：不支持的 agent 带原因 fail-loud，不进写计划分发
    match crate::agent_specs::agent_spec(&profile.agent).map(|s| s.set_global) {
        Some(crate::agent_specs::SetGlobalCap::Supported) => {}
        Some(crate::agent_specs::SetGlobalCap::Unsupported(reason)) => {
            return Err(format!(
                "「设为全局默认」暂不支持 {}：{reason}",
                profile.agent
            ))
        }
        None => {
            return Err(format!(
                "「设为全局默认」暂不支持 {}（未适配）",
                profile.agent
            ))
        }
    }
    let dir = cli_dir(home, &profile.agent);
    let mut plans = Vec::new();
    let mut push = |tag: &'static str, path: PathBuf, content: String| {
        plans.push(PlannedWrite { tag, path, content });
    };
    match profile.agent.as_str() {
        "claude-code" => {
            let path = dir.join("settings.json");
            let content = patch_claude_settings(read_existing(&path)?.as_deref(), profile, key)?;
            let content = patch_claude_compat(&content, &profile.request_policy.compat)?;
            push("settings.json", path, content);
        }
        "codex" => {
            // /model 选择器的模型目录：先写 catalog 文件，再把路径写进 config.toml。
            // 写全局专用的一份（启动会按绑定重写每连接那份；全局这份还要由续聊层补老对话的模型）
            let catalog = if profile.models.is_empty() {
                None
            } else {
                let path = agents::codex_global_catalog_path().ok_or("无法确定平台配置目录")?;
                let mut content = serde_json::to_string_pretty(&agents::codex_catalog_json_for(
                    &profile.name,
                    &profile.models,
                    profile.gateway_id.as_deref(),
                ))
                .map_err(|e| e.to_string())?;
                content.push('\n');
                // 续聊层在这份目录尾部追加了老对话的模型（codex_continuity）：磁盘上的目录以这次的条目开头，
                // 就当作 Mesa 写的样子（漂移比对数组是整组比的，否则一追加就报「外部改过」，按 Mesa 重写也消不掉）
                let content = codex_catalog_as_written(&path, content);
                push("model-catalog.json", path.clone(), content);
                Some(path)
            };
            let path = dir.join("config.toml");
            let key = key.ok_or("该配置没有已保存的密钥")?;
            let content = patch_codex_config(
                read_existing(&path)?.as_deref(),
                base_url,
                model,
                catalog.as_deref(),
                profile.request_policy.reasoning_effort.as_deref(),
                key,
            )?;
            let content = patch_codex_compat(&content, &profile.request_policy.compat)?;
            let content = patch_codex_relay_extras(
                &content,
                model,
                profile.gateway_id.as_deref(),
                &profile.request_policy.header_env,
            )?;
            push("config.toml", path, content);
            // 密钥在 provider 块内 experimental_bearer_token；不写 auth.json，
            // 也不写 http_headers（ChatGPT 自带 Codex 不认这个字段）
        }
        "gemini" => {
            let pairs: Vec<(String, String)> = [
                ("GEMINI_API_KEY", key),
                ("GOOGLE_GEMINI_BASE_URL", base_url),
                ("GEMINI_MODEL", model),
            ]
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (k.to_string(), v.to_string())))
            .collect();
            let path = dir.join(".env");
            // 没有任何可写值且文件不存在时，不创建空文件
            if !pairs.is_empty() || path.exists() {
                let content = patch_env_file(read_existing(&path)?.as_deref(), &pairs)?;
                push(".env", path, content);
            }
            // 认证方式落盘（见 patch_gemini_settings 注释：没有它 headless 起不来）；
            // 顺带登记自定义模型进 /model 选择器（experimental 段，重启生效）
            let path = dir.join("settings.json");
            let content = patch_gemini_settings(
                read_existing(&path)?.as_deref(),
                &profile.name,
                &profile.models,
                profile.gateway_id.as_deref(),
            )?;
            let content = patch_gemini_extras(&content, profile)?;
            push("settings.json", path, content);
        }
        "qwen" => {
            let path = dir.join("settings.json");
            let content = patch_qwen_settings(read_existing(&path)?.as_deref(), key, profile)?;
            push("settings.json", path, content);
        }
        "opencode" => {
            let pid = profile.provider_name();
            // 密钥改写成 {file:…} 引用（文件随同一批事务写，0600）
            let (provider, key_plan) = opencode_provider_plan(home, profile, key)?;
            if let Some(kp) = key_plan {
                push(kp.tag, kp.path, kp.content);
            }
            // 全局目录按 config.json → opencode.json → opencode.jsonc 合并、后者盖前者（OpenCode 自己也优先写 .jsonc）：
            // 有 .jsonc 就写它，否则写 opencode.json——只写 opencode.json 时 .jsonc 里的 model / provider 会把它盖掉
            let jsonc = dir.join("opencode.jsonc");
            let (tag, path) = if jsonc.is_file() {
                ("opencode.jsonc", jsonc)
            } else {
                ("opencode.json", dir.join("opencode.json"))
            };
            let content = patch_opencode_config(
                read_existing(&path)?.as_deref(),
                provider,
                model,
                profile.role_models.small.as_deref(),
                &pid,
            )?;
            push(tag, path, content);
        }
        "codebuddy" => {
            let path = dir.join("settings.json");
            let content = patch_codebuddy_settings(
                read_existing(&path)?.as_deref(),
                base_url,
                key,
                model,
                profile.request_policy.max_output_tokens,
            )?;
            push("settings.json", path, content);
            let models_path = dir.join("models.json");
            let existing = read_existing(&models_path)?;
            // 没有模型名单、文件也不存在时不建空文件
            if !profile.models.is_empty() || existing.is_some() {
                let content = patch_codebuddy_models(existing.as_deref(), profile)?;
                push("models.json", models_path, content);
            }
        }
        "kimi" => {
            // 两个变体共用 kimi 命令：存在的变体目录都写；都不存在时写到新版目录
            let provider_type = profile.protocol.as_deref().unwrap_or("kimi");
            let new_path = dir.join("config.toml");
            let legacy_path = kimi_legacy_dir(home).join("config.toml");
            let mut targets: Vec<(&'static str, PathBuf)> = Vec::new();
            if new_path.parent().is_some_and(|d| d.exists()) {
                targets.push(("config.toml", new_path.clone()));
            }
            if legacy_path.parent().is_some_and(|d| d.exists()) {
                targets.push(("legacy-config.toml", legacy_path.clone()));
            }
            if targets.is_empty() {
                targets.push(("config.toml", new_path));
            }
            for (tag, path) in targets {
                // 两版都写 max_context_size：旧版 kimi-cli 官方文档同样列为模型必填（display_name / capabilities 也是合法字段），
                // 以前按「未知字段可能报错」不写，文档不支持这个顾虑（2026-10-30）
                let content = patch_kimi_config(
                    read_existing(&path)?.as_deref(),
                    provider_type,
                    &profile.name,
                    base_url,
                    key,
                    &profile.models,
                    true,
                    &profile.provider_name(),
                    profile.gateway_id.as_deref(),
                )?;
                let content = patch_kimi_effort(&content, profile, provider_type)?;
                let content = if tag == "config.toml" {
                    patch_kimi_env_alias(&content, profile, &profile.provider_name())?
                } else {
                    content
                };
                push(tag, path, content);
            }
        }
        "grok" => {
            let path = dir.join("config.toml");
            let content = patch_grok_config(read_existing(&path)?.as_deref(), key, profile)?;
            push("config.toml", path, content);
        }
        // 防御兜底：能力表标 Supported 但这里漏了 arm（两表漂移），属内部错误
        other => {
            return Err(format!(
                "内部错误：{other} 的能力表标为支持「设为全局默认」但写计划缺失"
            ))
        }
    }
    Ok(plans)
}

const PREVIEW_CHANGE_CAP: usize = 24;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalWriteChangeDto {
    pub path: String,
    pub op: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalWriteFilePreviewDto {
    pub path: String,
    pub tag: String,
    pub action: String,
    pub changes: Vec<GlobalWriteChangeDto>,
    pub omitted: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalWritePreviewDto {
    pub files: Vec<GlobalWriteFilePreviewDto>,
    pub skipped_policies: Vec<String>,
    /// 外部终端里会盖过这次写入的来源（shell 变量、更高优先级的配置文件）
    pub override_notes: Vec<String>,
    pub restart_note: String,
    pub scope_note: String,
}

fn preview_redact(value: &str) -> String {
    crate::sessions::redact_sensitive_text(value)
}

fn secret_field(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    p.contains("api_key")
        || p.contains("apikey")
        || p.contains("auth_token")
        || p.contains("authtoken")
        || p.contains("bearer")
        || p.contains("secret")
        || p.ends_with(".key")
        || p.contains("experimental_bearer")
}

fn preview_value(path: &str, raw: &str) -> String {
    if secret_field(path) {
        return "（已脱敏）".into();
    }
    let redacted = preview_redact(raw);
    if redacted.chars().count() > 80 {
        let cut: String = redacted.chars().take(77).collect();
        format!("{cut}…")
    } else {
        redacted
    }
}

fn flatten_json(value: &Value, prefix: &str, out: &mut BTreeMap<String, String>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                let path = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{prefix}.{k}")
                };
                flatten_json(v, &path, out);
            }
        }
        Value::Array(items) => {
            if items.iter().all(|v| !v.is_object() && !v.is_array()) {
                let joined = items
                    .iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                out.insert(prefix.to_string(), joined);
            } else {
                out.insert(prefix.to_string(), value.to_string());
            }
        }
        Value::Null => {
            out.insert(prefix.to_string(), "null".into());
        }
        other => {
            let text = match other {
                Value::String(s) => s.clone(),
                _ => other.to_string(),
            };
            out.insert(prefix.to_string(), text);
        }
    }
}

fn flatten_toml_item(item: &toml_edit::Item, prefix: &str, out: &mut BTreeMap<String, String>) {
    match item {
        toml_edit::Item::None => {}
        toml_edit::Item::Value(val) => {
            if let Some(table) = val.as_inline_table() {
                for (k, v) in table {
                    let path = if prefix.is_empty() {
                        k.to_string()
                    } else {
                        format!("{prefix}.{k}")
                    };
                    flatten_toml_item(&toml_edit::Item::Value(v.clone()), &path, out);
                }
            } else {
                let text = val
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| val.to_string());
                out.insert(prefix.to_string(), text);
            }
        }
        toml_edit::Item::Table(table) => {
            for (k, v) in table.iter() {
                let path = if prefix.is_empty() {
                    k.to_string()
                } else {
                    format!("{prefix}.{k}")
                };
                flatten_toml_item(v, &path, out);
            }
        }
        toml_edit::Item::ArrayOfTables(arr) => {
            out.insert(prefix.to_string(), format!("({} 段)", arr.len()));
        }
    }
}

fn flatten_env(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            out.insert(k.trim().to_string(), v.to_string());
        }
    }
    out
}

fn flatten_content(path: &Path, text: &str) -> BTreeMap<String, String> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.ends_with(".json") {
        if let Ok(v) = serde_json::from_str::<Value>(text) {
            let mut out = BTreeMap::new();
            flatten_json(&v, "", &mut out);
            return out;
        }
    }
    if name.ends_with(".toml") {
        if let Ok(doc) = text.parse::<toml_edit::DocumentMut>() {
            let mut out = BTreeMap::new();
            flatten_toml_item(doc.as_item(), "", &mut out);
            return out;
        }
    }
    // 密钥文件（OpenCode {file:} 引用的那份）：只说有没有、变没变，绝不出值
    if name.ends_with(".key") {
        let mut out = BTreeMap::new();
        let digest = format!("（已脱敏 · {} 字）", text.trim().chars().count());
        out.insert("(密钥)".into(), digest);
        return out;
    }
    if name == ".env" || name.ends_with(".env") {
        return flatten_env(text);
    }
    let mut out = BTreeMap::new();
    out.insert("(全文)".into(), text.to_string());
    out
}

fn diff_maps(
    before: &BTreeMap<String, String>,
    after: &BTreeMap<String, String>,
) -> (Vec<GlobalWriteChangeDto>, usize) {
    let mut keys: Vec<&String> = before.keys().chain(after.keys()).collect();
    keys.sort();
    keys.dedup();
    let mut changes = Vec::new();
    for key in keys {
        let old = before.get(key);
        let new = after.get(key);
        if old == new {
            continue;
        }
        let op = match (old, new) {
            (None, Some(_)) => "add",
            (Some(_), None) => "remove",
            _ => "modify",
        };
        changes.push(GlobalWriteChangeDto {
            path: key.clone(),
            op: op.into(),
            before: old.map(|v| preview_value(key, v)),
            after: new.map(|v| preview_value(key, v)),
        });
    }
    let omitted = changes.len().saturating_sub(PREVIEW_CHANGE_CAP);
    changes.truncate(PREVIEW_CHANGE_CAP);
    (changes, omitted)
}

fn preview_plans(
    home: &Path,
    agent: &str,
    plans: &[PlannedWrite],
    skipped_policies: Vec<String>,
    override_notes: Vec<String>,
) -> GlobalWritePreviewDto {
    let mut files = Vec::new();
    for plan in plans {
        let existing = read_existing(&plan.path).ok().flatten();
        let action = if existing.is_none() {
            "create"
        } else if existing.as_deref() == Some(plan.content.as_str()) {
            "unchanged"
        } else {
            "modify"
        };
        if action == "unchanged" {
            continue;
        }
        let before = existing
            .as_deref()
            .map(|t| flatten_content(&plan.path, t))
            .unwrap_or_default();
        let after = flatten_content(&plan.path, &plan.content);
        let (changes, omitted) = diff_maps(&before, &after);
        files.push(GlobalWriteFilePreviewDto {
            path: display_path(home, &plan.path),
            tag: plan.tag.to_string(),
            action: action.into(),
            changes,
            omitted,
        });
    }
    GlobalWritePreviewDto {
        files,
        skipped_policies,
        override_notes,
        restart_note: restart_note(agent).into(),
        scope_note: "只改外部 CLI 的配置文件。不会改 Mesa 启动栏预选，也不会改某个项目的默认配置。"
            .into(),
    }
}

/// 写入后什么时候生效。Codex 一句按 2026-10-28 隔离 CODEX_HOME 实测（客户端同款 app-server 0.164）：
/// 新建对话每次重读 config.toml 的渠道；已开对话沿用旧渠道；模型目录与侧栏历史（只列启动时默认渠道
/// 的对话）只在启动时定。客户端另自带模型选择与预热对话，故对客户端仍说「重启」。
fn restart_note(agent: &str) -> &'static str {
    if agent == "codex" {
        "Mesa 不用重启。外部终端新开的 Codex 会话走新配置，已开着的不变。Codex 客户端请重启：不重启时新建对话虽会换渠道，但模型列表和客户端记住的模型还是旧的。各条 API 连接共用 custom 这一个渠道名，在它们之间切换，客户端侧栏里的对话不会被藏起来；官方账号的对话单独归在 ChatGPT 自己的渠道下，中转连接上跑过的老对话要接着聊，先切回那条连接（中转留下的历史官方接口不收）。"
    } else {
        "Mesa 不用重启。外部终端里新开的会话读新配置，已经开着的不会自动重读，需要新开才会生效。"
    }
}

/// 登录 shell 有没有导出这个变量（unix 读导入时记下的名字；Windows 图形程序本来就继承用户环境）
fn shell_has(name: &str) -> bool {
    if cfg!(test) {
        return false;
    }
    #[cfg(unix)]
    {
        crate::shell_env::login_shell_has(name)
    }
    #[cfg(not(unix))]
    {
        std::env::var_os(name).is_some_and(|v| !v.is_empty())
    }
}

/// 外部终端里会盖过这次写入的来源（2026-10-30）：shell 变量只报确实导出了的，不猜；项目级配置看不到，
/// 按家说明一次。`has` 由调用方给：生产读登录 shell，测试传假表
fn override_notes_with(agent: &str, has: &dyn Fn(&str) -> bool) -> Vec<String> {
    let shell = |vars: &[&str], what: &str| -> Option<String> {
        let hit: Vec<&str> = vars.iter().copied().filter(|v| has(v)).collect();
        (!hit.is_empty()).then(|| format!("你的 shell 导出了 {}，外部终端里会盖过这里写的{what}", hit.join("、")))
    };
    let mut notes = Vec::new();
    match agent {
        "claude-code" => {
            let managed: &[&str] = if cfg!(target_os = "macos") {
                &["/Library/Application Support/ClaudeCode/managed-settings.json"]
            } else if cfg!(windows) {
                &[r"C:\Program Files\ClaudeCode\managed-settings.json"]
            } else {
                &["/etc/claude-code/managed-settings.json"]
            };
            if managed.iter().any(|p| Path::new(p).is_file()) {
                notes.push("本机有企业托管的 Claude Code 设置（managed-settings.json），里面设了的项会盖过这里写的".into());
            }
        }
        "codex" => notes.push("已信任项目里的 .codex/config.toml 可另设模型与思考档，在那些项目里以它为准".into()),
        "gemini" => {
            notes.extend(shell(
                &["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GEMINI_MODEL", "GOOGLE_GENAI_USE_VERTEXAI"],
                "密钥、地址或模型",
            ));
            notes.push("Gemini 只读当前文件夹往上找到的第一个 .env：项目里有 .env，或文件夹没被信任时，~/.gemini/.env 里的密钥和地址读不到（模型另写在 settings.json）".into());
        }
        "qwen" => notes.extend(shell(
            &["OPENAI_BASE_URL", "OPENAI_MODEL", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"],
            "地址或模型",
        )),
        "opencode" => {
            notes.extend(shell(&["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"], "配置"));
            notes.push("项目里的 opencode.json 会盖过全局配置，在那些项目里以它为准".into());
        }
        "codebuddy" => notes.push("项目里的 .codebuddy/models.json 会整份盖过这里写的模型名单".into()),
        "kimi" => notes.extend(shell(
            &["KIMI_MODEL_NAME", "KIMI_MODEL_API_KEY", "KIMI_MODEL_BASE_URL", "KIMI_API_KEY", "KIMI_BASE_URL"],
            "连接",
        )),
        "grok" => notes.extend(shell(&["GROK_MODELS_BASE_URL", "GROK_DEFAULT_MODEL"], "地址或默认模型")),
        _ => {}
    }
    notes
}

fn deferred_validation() -> crate::profile_validation::ProfileValidationDto {
    let skip = |msg: &str| crate::profile_validation::ValidationCheckDto {
        status: "skipped".into(),
        message: msg.into(),
        latency_ms: None,
    };
    crate::profile_validation::ProfileValidationDto {
        ok: true,
        checked_at: crate::sessions::now_iso(),
        local: skip("已写入，复检稍后进行"),
        cli: skip(""),
        api: skip(""),
    }
}

fn official_apply_result(files: Vec<String>, message: &str) -> GlobalApplyResultDto {
    let skip = |msg: &str| crate::profile_validation::ValidationCheckDto {
        status: "skipped".into(),
        message: msg.into(),
        latency_ms: None,
    };
    GlobalApplyResultDto {
        files,
        override_notes: Vec::new(),
        validation: crate::profile_validation::ProfileValidationDto {
            ok: true,
            checked_at: crate::sessions::now_iso(),
            local: crate::profile_validation::ValidationCheckDto {
                status: "passed".into(),
                message: message.into(),
                latency_ms: None,
            },
            cli: skip("官方账号不跑 CLI 复检"),
            api: skip(""),
        },
    }
}

fn skipped_policy_notes(profile: &Profile) -> Vec<String> {
    let surface = crate::combo::surface_for_profile(profile, None);
    let mut notes = Vec::new();
    let mut push = |channel: &str, stored: bool, name: &str| {
        if !stored {
            return;
        }
        match channel {
            "tui" => notes.push(format!(
                "{name}只在会话里用原生命令生效，写入全局配置不会带上"
            )),
            "unsupported" => notes.push(format!("{name}这个 CLI 不支持，写入全局配置不会带上")),
            "unknown" => notes.push(format!("{name}未证实能写入全局配置，不会带上")),
            _ => {}
        }
    };
    let policy = &profile.request_policy;
    push(surface.channel_effort, policy.reasoning_effort.is_some(), "思考档");
    push(surface.channel_temperature, policy.temperature.is_some(), "温度");
    push(surface.channel_top_p, policy.top_p.is_some(), "top_p");
    push(surface.channel_max_tokens, policy.max_output_tokens.is_some(), "输出上限");
    if !profile.extra_env.is_empty() {
        notes.push("附加环境变量只在 Mesa 启动时注入，不写入 CLI 全局文件".into());
    }
    // Header 的值取自环境变量：能写「变量名引用」的几家（Codex env_http_headers、OpenCode {env:}、Grok $VAR）写引用；
    // 其余只认明文，写进去等于密文落盘，只在 Mesa 启动时带
    if !profile.request_policy.header_env.is_empty()
        && !matches!(profile.agent.as_str(), "codex" | "opencode" | "grok")
    {
        notes.push("自定义请求头这个 CLI 只认明文，不写进全局配置；只在 Mesa 启动时带上".into());
    }
    notes
}

fn backups_root() -> Result<PathBuf, String> {
    Ok(crate::dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("backups"))
}

fn timestamp_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let tod = secs % 86400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// 天数 → 公历日期（Howard Hinnant 算法，UTC）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn list_backups(dir: &Path, tag: &str) -> Vec<String> {
    let prefix = format!("{tag}.");
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n.starts_with(&prefix) && n.ends_with(".bak"))
                .collect()
        })
        .unwrap_or_default()
}

fn backup_file_raw(dir: &Path, tag: &str, path: &Path, ts: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let bak = dir.join(format!("{tag}.{ts}.bak"));
    fs::copy(path, &bak).map_err(|e| format!("备份 {} 失败: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bak, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置备份权限失败: {e}"))?;
    }
    Ok(bak)
}

fn prune_tag_backups(dir: &Path, tag: &str) {
    let mut baks = list_backups(dir, tag);
    baks.sort();
    while baks.len() > 5 {
        let oldest = baks.remove(0);
        let _ = fs::remove_file(dir.join(oldest));
    }
}

// 仅测试用来快速制造多份带时间戳的备份验证轮换；生产路径走 backup_actions 的事务备份
#[cfg(test)]
fn backup_file_with_ts(dir: &Path, tag: &str, path: &Path, ts: &str) -> Result<PathBuf, String> {
    let bak = backup_file_raw(dir, tag, path, ts)?;
    prune_tag_backups(dir, tag);
    Ok(bak)
}

fn batch_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("{}-{nanos:09}-{}", timestamp_now(), &id[..8])
}

fn manifest_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("batch.{id}.json"))
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    crate::storage::atomic_write(path, bytes, true)
}

fn write_manifest(dir: &Path, manifest: &BackupManifest) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let mut text = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    text.push('\n');
    let path = manifest_path(dir, &manifest.batch_id);
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = write_private_file(&tmp, text.as_bytes()) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("写入批次备份清单失败: {e}"));
    }
    Ok(())
}

fn remove_batch_artifacts(dir: &Path, id: &str) {
    let _ = fs::remove_file(manifest_path(dir, id));
    let suffix = format!(".{id}.bak");
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(&suffix) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

fn backup_actions(
    backups_dir: &Path,
    id: &str,
    operation: &str,
    actions: &[TxAction],
) -> Result<Vec<Option<Vec<u8>>>, String> {
    let mut entries = Vec::new();
    let mut originals = Vec::new();
    let mut created_backups = Vec::new();
    for action in actions {
        let original = match fs::read(&action.path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                for path in &created_backups {
                    let _ = fs::remove_file(path);
                }
                return Err(format!("读取现有配置 {} 失败: {e}", action.path.display()));
            }
        };
        let backup_file = if original.is_some() {
            match backup_file_raw(backups_dir, &action.tag, &action.path, id) {
                Ok(path) => {
                    created_backups.push(path.clone());
                    Some(path.file_name().unwrap().to_string_lossy().into_owned())
                }
                Err(e) => {
                    for path in &created_backups {
                        let _ = fs::remove_file(path);
                    }
                    return Err(e);
                }
            }
        } else {
            None
        };
        entries.push(BackupEntry {
            tag: action.tag.clone(),
            target: action.path.to_string_lossy().into_owned(),
            existed: original.is_some(),
            backup_file,
        });
        originals.push(original);
    }
    if let Err(e) = write_manifest(
        backups_dir,
        &BackupManifest {
            batch_id: id.to_string(),
            operation: operation.to_string(),
            entries,
        },
    ) {
        for path in &created_backups {
            let _ = fs::remove_file(path);
        }
        return Err(e);
    }
    Ok(originals)
}

fn stage_actions(actions: &[TxAction], id: &str) -> Result<Vec<Option<PathBuf>>, String> {
    let mut staged: Vec<Option<PathBuf>> = Vec::new();
    for (i, action) in actions.iter().enumerate() {
        if let Some(parent) = action.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        if let Some(content) = &action.content {
            let name = action
                .path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "config".into());
            let tmp = action
                .path
                .with_file_name(format!(".{name}.ccode-{id}-{i}.tmp"));
            if let Err(e) = write_private_file(&tmp, content) {
                for path in staged.iter().flatten() {
                    let _ = fs::remove_file(path);
                }
                return Err(e);
            }
            staged.push(Some(tmp));
        } else {
            staged.push(None);
        }
    }
    Ok(staged)
}

fn restore_original(path: &Path, original: &Option<Vec<u8>>, id: &str) -> Result<(), String> {
    match original {
        Some(bytes) => {
            let tmp = path.with_file_name(format!(
                ".{}.ccode-{id}-rollback.tmp",
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
            write_private_file(&tmp, bytes)?;
            replace_staged(&tmp, path).map_err(|e| format!("回滚 {} 失败: {e}", path.display()))
        }
        None => match fs::remove_file(path) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("回滚新建文件 {} 失败: {e}", path.display())),
        },
    }
}

/// 跨平台替换不得先删原文件；只读属性和失败恢复由共享写入原语处理。
fn replace_staged(from: &Path, to: &Path) -> std::io::Result<()> {
    crate::storage::replace(from, to).map_err(std::io::Error::other)
}

fn commit_actions_with<F>(
    actions: &[TxAction],
    staged: &[Option<PathBuf>],
    originals: &[Option<Vec<u8>>],
    id: &str,
    mut rename: F,
) -> Result<(), String>
where
    F: FnMut(&Path, &Path, usize) -> std::io::Result<()>,
{
    for (i, action) in actions.iter().enumerate() {
        let result = if let Some(tmp) = &staged[i] {
            rename(tmp, &action.path, i)
        } else {
            match fs::remove_file(&action.path) {
                Ok(_) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e),
            }
        };
        if let Err(e) = result {
            let mut rollback_errors = Vec::new();
            for (action, original) in actions.iter().zip(originals) {
                if let Err(err) = restore_original(&action.path, original, id) {
                    rollback_errors.push(err);
                }
            }
            for path in staged.iter().flatten() {
                let _ = fs::remove_file(path);
            }
            let suffix = if rollback_errors.is_empty() {
                "已自动回滚全部目标文件".to_string()
            } else {
                format!("自动回滚不完整：{}", rollback_errors.join("；"))
            };
            return Err(format!(
                "替换 {} 失败: {e}；{suffix}",
                action.path.display()
            ));
        }
    }
    Ok(())
}

fn manifest_files(dir: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .map(|n| {
                            let n = n.to_string_lossy();
                            n.starts_with("batch.") && n.ends_with(".json")
                        })
                        .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    paths.sort();
    paths
}

fn prune_manifests(dir: &Path) {
    let mut paths = manifest_files(dir);
    while paths.len() > 5 {
        let _ = fs::remove_file(paths.remove(0));
    }
}

fn transact(
    backups_dir: &Path,
    home: &Path,
    actions: &[TxAction],
    operation: &str,
) -> Result<Vec<String>, String> {
    if actions.is_empty() {
        return Ok(Vec::new());
    }
    let id = batch_id();
    let originals = backup_actions(backups_dir, &id, operation, actions)?;
    // apply 时顺带保证「首次写入前」原始快照存在（永久保留，不参与轮换）；
    // 快照内容 = 本次读到的写入前状态，即使后面的提交失败回滚也依然准确
    if operation == "apply" {
        ensure_original_snapshot(backups_dir, actions, &originals);
    }
    let staged = match stage_actions(actions, &id) {
        Ok(staged) => staged,
        Err(e) => {
            remove_batch_artifacts(backups_dir, &id);
            return Err(e);
        }
    };
    commit_actions_with(actions, &staged, &originals, &id, |from, to, _| {
        replace_staged(from, to)
    })?;
    for action in actions {
        prune_tag_backups(backups_dir, &action.tag);
    }
    prune_manifests(backups_dir);
    Ok(actions
        .iter()
        .map(|a| display_path(home, &a.path))
        .collect())
}

fn apply_plans(
    backups_dir: &Path,
    home: &Path,
    plans: &[PlannedWrite],
) -> Result<Vec<String>, String> {
    let actions: Vec<TxAction> = plans
        .iter()
        .map(|plan| TxAction {
            tag: plan.tag.to_string(),
            path: plan.path.clone(),
            content: Some(plan.content.as_bytes().to_vec()),
        })
        .collect();
    transact(backups_dir, home, &actions, "apply")
}

// ===== 「首次写入前」原始快照（永久保留，不参与 5 份轮换） =====
//
// 动机：常规批次备份每个 tag 只留 5 份、清单也只留 5 份——连续「设为全局」几次后，
// 最早的「Mesa 动手之前」的状态就被轮换掉了，「恢复备份」只能回到上一次写入前，
// 用户真正想要的「恢复默认」永远够不到。original/ 子目录在首次 apply 时落一份，
// 之后任何 apply/restore 都不碰（prune 只扫扁平的 <tag>.*.bak 与 batch.*.json）。

fn original_dir(backups_dir: &Path) -> PathBuf {
    backups_dir.join("original")
}

/// 首次 apply 时用写入前内容（originals）落永久快照；已存在则不动。
/// 失败只记日志不否决主流程（常规批次备份链仍可用）；半份快照清掉下次重试
fn ensure_original_snapshot(
    backups_dir: &Path,
    actions: &[TxAction],
    originals: &[Option<Vec<u8>>],
) {
    let dir = original_dir(backups_dir);
    if dir.join("manifest.json").is_file() {
        return;
    }
    let result = (|| -> Result<(), String> {
        // 目录要先建：全部目标在首次写入前都不存在时，循环里不会走到建目录的分支
        fs::create_dir_all(&dir).map_err(|e| format!("创建原始快照目录失败: {e}"))?;
        let mut entries = Vec::new();
        for (action, original) in actions.iter().zip(originals) {
            let backup_file = if let Some(bytes) = original {
                // 不可变快照，文件名直接用 tag（不需要时间戳）
                write_private_file(&dir.join(&action.tag), bytes)?;
                Some(action.tag.clone())
            } else {
                None
            };
            entries.push(BackupEntry {
                tag: action.tag.clone(),
                target: action.path.to_string_lossy().into_owned(),
                existed: original.is_some(),
                backup_file,
            });
        }
        let mut text = serde_json::to_string_pretty(&BackupManifest {
            batch_id: "original".into(),
            operation: "original".into(),
            entries,
        })
        .map_err(|e| e.to_string())?;
        text.push('\n');
        write_private_file(&dir.join("manifest.json"), text.as_bytes())
    })();
    if let Err(e) = result {
        crate::logbuf::record("error", "global-config", &format!("写入原始快照失败: {e}"));
        let _ = fs::remove_dir_all(&dir);
    }
}

/// 恢复到「Mesa 首次写入前」的原始状态：快照里不存在的文件 = 当时是 Mesa 新建的，
/// 恢复即删除（transact 会先把当前状态存成常规批次，可再恢复回来）
fn restore_from_original(backups_dir: &Path, home: &Path) -> Result<Vec<String>, String> {
    let dir = original_dir(backups_dir);
    let manifest: BackupManifest = serde_json::from_str(
        &fs::read_to_string(dir.join("manifest.json"))
            .map_err(|e| format!("读取原始快照清单失败: {e}"))?,
    )
    .map_err(|e| format!("原始快照清单损坏: {e}"))?;
    let mut actions = Vec::new();
    for entry in manifest.entries {
        let content = match &entry.backup_file {
            Some(name) => {
                Some(fs::read(dir.join(name)).map_err(|e| format!("读取原始快照失败: {e}"))?)
            }
            None => None,
        };
        actions.push(TxAction {
            tag: entry.tag,
            path: PathBuf::from(entry.target),
            content,
        });
    }
    transact(backups_dir, home, &actions, "restore-original")
}

fn latest_valid_manifest(dir: &Path) -> Option<BackupManifest> {
    manifest_files(dir).into_iter().rev().find_map(|path| {
        let manifest: BackupManifest =
            serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
        manifest
            .entries
            .iter()
            .all(|entry| {
                !entry.existed
                    || entry
                        .backup_file
                        .as_ref()
                        .is_some_and(|name| dir.join(name).is_file())
            })
            .then_some(manifest)
    })
}

fn restore_from(backups_dir: &Path, home: &Path, agent: &str) -> Result<Vec<String>, String> {
    let actions = if let Some(manifest) = latest_valid_manifest(backups_dir) {
        manifest
            .entries
            .into_iter()
            .map(|entry| {
                let content = match entry.backup_file {
                    Some(name) => Some(
                        fs::read(backups_dir.join(name))
                            .map_err(|e| format!("读取恢复备份失败: {e}"))?,
                    ),
                    None => None,
                };
                Ok(TxAction {
                    tag: entry.tag,
                    path: PathBuf::from(entry.target),
                    content,
                })
            })
            .collect::<Result<Vec<_>, String>>()?
    } else {
        let mut actions = Vec::new();
        for (tag, path) in target_paths(home, agent) {
            let mut baks = list_backups(backups_dir, tag);
            baks.sort();
            if let Some(newest) = baks.pop() {
                actions.push(TxAction {
                    tag: tag.to_string(),
                    path,
                    content: Some(
                        fs::read(backups_dir.join(newest))
                            .map_err(|e| format!("读取恢复备份失败: {e}"))?,
                    ),
                });
            }
        }
        actions
    };
    transact(backups_dir, home, &actions, "restore")
}

fn display_path(home: &Path, path: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rel) => format!("~/{}", rel.to_string_lossy()),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

pub(crate) fn drift_status(store: &ProfileStore, agent: &str) -> crate::drift::GlobalDriftDto {
    let settings = crate::settings::read_current();
    let Some(pid) = settings
        .active_global_profiles
        .as_ref()
        .and_then(|m| m.get(agent))
        .cloned()
    else {
        return crate::drift::classify(true, None, Vec::new());
    };
    let profile = match profile_for_write(store, &pid) {
        Ok(p) => p,
        Err(e) => return crate::drift::classify(false, Some(e), Vec::new()),
    };
    if is_official(&profile) && !official_global_is_patch(&profile.agent) {
        return crate::drift::classify(true, None, Vec::new());
    }
    let key = crate::profiles::get_key_for_profile(&profile)
        .ok()
        .flatten();
    let Some(home) = crate::dirs::home_dir() else {
        return crate::drift::classify(false, Some("无法确定用户主目录".into()), Vec::new());
    };
    let plans = match plan_writes(&home, &profile, key.as_deref(), &profile.models) {
        Ok(p) => p,
        Err(e) => return crate::drift::classify(false, Some(e), Vec::new()),
    };
    let mut drifted = Vec::new();
    for p in &plans {
        if !plans_match_disk(&profile, std::slice::from_ref(p)) {
            drifted.push(p.tag.to_string());
        }
    }
    crate::drift::classify(false, None, drifted)
}

#[tauri::command]
pub fn check_global_drift(
    store: tauri::State<'_, ProfileStore>,
    agent: String,
) -> Result<crate::drift::GlobalDriftDto, String> {
    Ok(drift_status(&store, &agent))
}

#[tauri::command]
pub fn preview_profile_global(
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
) -> Result<GlobalWritePreviewDto, String> {
    let mut profile = store.get_with_model(&profile_id, None)?;
    if is_official(&profile) {
        let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
        let mut plans = plan_writes(&home, &profile, None, &[])?;
        if profile.agent == "codex" {
            extend_codex_plans(&home, &mut plans, &store.list()?, None)?;
        }
        return Ok(preview_plans(&home, &profile.agent, &plans, Vec::new(), Vec::new()));
    }
    let skipped = skipped_policy_notes(&profile);
    let first = profile.models.first().cloned();
    crate::combo::apply_to_profile(&mut profile, first.as_deref());
    let key = profiles::get_key_for_profile(&profile)?;
    crate::agents::ensure_launch_credentials(&profile, key.as_deref())?;
    let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
    let mut plans = plan_writes(&home, &profile, key.as_deref(), &profile.models)?;
    if profile.agent == "codex" {
        extend_codex_plans(&home, &mut plans, &store.list()?, Some(&profile))?;
    }
    if profile.agent == "opencode" {
        extend_opencode_plans(&home, &mut plans, &store.list()?, &profile)?;
    }
    Ok(preview_plans(&home, &profile.agent, &plans, skipped, override_notes_with(&profile.agent, &shell_has)))
}

#[tauri::command]
pub async fn apply_profile_global(
    app: tauri::AppHandle,
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
    validate: Option<bool>,
) -> Result<GlobalApplyResultDto, String> {
    // 一键切换（连接行地球图标）传 false：写完立刻返回，复检由前端随后调 validate_global_profile
    let validate = validate.unwrap_or(true);
    let profile = profile_for_write(&store, &profile_id)?;
    // Codex 续聊层要认出老对话的网关（codex_continuity）
    let all_profiles = if matches!(profile.agent.as_str(), "codex" | "opencode") { store.list()? } else { Vec::new() };
    if is_official(&profile) {
        let result = tauri::async_runtime::spawn_blocking(move || {
            let _guard = GLOBAL_CONFIG_MUTEX
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let _file_guard = crate::storage::config_lock("global-config")?;
            let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
            let mut plans = plan_writes(&home, &profile, None, &[])?;
            if profile.agent == "codex" {
                extend_codex_plans(&home, &mut plans, &all_profiles, None)?;
            }
            // 磁盘已经是官方形态：不写、不产生空备份批次
            let files = if disk_equals_plans(&plans) {
                Vec::new()
            } else {
                apply_plans(&backups_root()?.join(&profile.agent), &home, &plans)?
            };
            crate::settings::record_active_global(&profile.agent, &profile.id);
            Ok(official_apply_result(files, "已切回官方账号"))
        })
        .await
        .map_err(|e| e.to_string())?;
        let _ = crate::tray::rebuild_and_wait(app.clone()).await;
        return result;
    }
    let key = profiles::get_key_for_profile(&profile)?;
    crate::agents::ensure_launch_credentials(&profile, key.as_deref())?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = GLOBAL_CONFIG_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _file_guard = crate::storage::config_lock("global-config")?;
        let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
        let mut plans = plan_writes(&home, &profile, key.as_deref(), &profile.models)?;
        if profile.agent == "codex" {
            extend_codex_plans(&home, &mut plans, &all_profiles, Some(&profile))?;
        }
        if profile.agent == "opencode" {
            extend_opencode_plans(&home, &mut plans, &all_profiles, &profile)?;
        }
        let backups_dir = backups_root()?.join(&profile.agent);
        let files = apply_plans(&backups_dir, &home, &plans)?;
        // 写成功即记录「全局生效」追踪（settings.active_global_profiles）；后面的验证
        // 失败不影响记录——文件已真实写入，验证只是体检报告
        crate::settings::record_active_global(&profile.agent, &profile.id);
        let validation = if validate {
            crate::profile_validation::validate_after_global_write(&profile, key.as_deref())
        } else {
            deferred_validation()
        };
        let override_notes = override_notes_with(&profile.agent, &shell_has);
        Ok(GlobalApplyResultDto { files, validation, override_notes })
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = crate::tray::rebuild_and_wait(app.clone()).await;
    result
}

/// 把绑定的 base_url + 密钥写成 config.toml 里名为 `block_name` 的 provider 定义块。
/// 调用方：客户端接力的「写入并打开」（client_open_launch）与会话导入（传入 rollout 记录的原始名，如 A 机 `ccode-<A短id>`）。
/// 只写 config.toml 的定义块（认证走 auth.command，不动 auth.json），与「设为全局」共用备份，可「撤销上次写入」。
pub(crate) fn register_codex_client_provider_named(
    profile: Profile,
    key: String,
    block_name: String,
) -> Result<Vec<String>, String> {
    if profile.agent != "codex" {
        return Err("只有 Codex 绑定支持注册到客户端".into());
    }
    if profile.account_type == crate::profiles::AccountType::Official {
        return Err("官方账号无需注册：客户端与 CLI 共享官方登录态，天然可续聊".into());
    }
    if profile.no_auth {
        return Err("无密钥连接不支持注册：客户端拿不到凭证，注册了也无法续聊".into());
    }
    if profile.base_url.is_none() {
        return Err("这个网关还没配端点，没有可注册的 provider 定义".into());
    }
    let _guard = GLOBAL_CONFIG_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _file_guard = crate::storage::config_lock("global-config")?;
    let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
    let cfg_path = cli_dir(&home, "codex").join("config.toml");
    // 只写 config.toml，auth.json 完全不碰（单槽 OPENAI_API_KEY 是客户端自身 API-Key 登录态的凭证，写它会顶掉登录）
    let existing = read_existing(&cfg_path)?;
    // 认证走 auth.command（mesa_helper 现取 keys.json），config.toml 不落明文；
    // 找不到随包 helper（开发态还没建出来）才退回 experimental_bearer_token
    let content = match crate::codex_continuity::stable_helper() {
        Some(helper) if profile.gateway_id.is_some() => {
            crate::codex_continuity::register_block(existing.as_deref(), &block_name, &profile, &helper)?
        }
        _ => patch_codex_config_register(existing.as_deref(), profile.base_url.as_deref(), &block_name, &key)?,
    };
    let plans = vec![PlannedWrite { tag: "config.toml", path: cfg_path.clone(), content }];
    let backups_dir = backups_root()?.join("codex");
    apply_plans(&backups_dir, &home, &plans)
}

/// 聊天卡「设成 API Key 并启动」（2026-10-27 用户拍板）：先备份，再只改 `~/.gemini/settings.json` 的认证方式。
/// 目录同 agents::gemini_selected_auth_type（连接上的 GEMINI_CLI_HOME > 进程环境 > 家目录），写完那边就读得到；
/// 备份进 gemini 的备份目录，连接页「恢复备份」照常能回退
#[tauri::command]
pub async fn gemini_use_api_key_auth(
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
) -> Result<Vec<String>, String> {
    let profile = store.get(&profile_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        if profile.agent != "gemini" {
            return Err("只有 Gemini 的连接需要设认证方式".into());
        }
        let _guard = GLOBAL_CONFIG_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _file_guard = crate::storage::config_lock("global-config")?;
        let home = agents::gemini_home(&profile).ok_or("无法确定 Gemini 的配置目录")?;
        let path = home.join(".gemini/settings.json");
        let plans = vec![PlannedWrite {
            tag: "settings.json",
            content: patch_gemini_auth_only(read_existing(&path)?.as_deref())?,
            path,
        }];
        apply_plans(&backups_root()?.join("gemini"), &home, &plans)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 一键切换写完后的复检（含 CLI 读配置与网络检查，几秒到十几秒），不挡界面。
#[tauri::command]
pub async fn validate_global_profile(
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
) -> Result<crate::profile_validation::ProfileValidationDto, String> {
    let profile = profile_for_write(&store, &profile_id)?;
    if is_official(&profile) {
        return Ok(official_apply_result(Vec::new(), "已切回官方账号").validation);
    }
    let key = profiles::get_key_for_profile(&profile)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::profile_validation::validate_after_global_write(&profile, key.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalDriftDetailDto {
    pub profile_id: String,
    pub files: Vec<GlobalWriteFilePreviewDto>,
}

/// 漂移明细内核：before = Mesa 计划，after = 磁盘。API 只报 Mesa 管的键（不报磁盘多出的）。
fn drift_files(
    home: &Path,
    profile: &Profile,
    key: Option<&str>,
) -> Result<Vec<GlobalWriteFilePreviewDto>, String> {
    let plans = plan_writes(home, profile, key, &profile.models)?;
    let official = is_official(profile);
    let plans = if official { plans } else { drift_plans(profile, &plans) };
    let mut files = Vec::new();
    for plan in &plans {
        let live = read_existing(&plan.path)?;
        let mesa = flatten_content(&plan.path, &plan.content);
        let disk = live
            .as_deref()
            .map(|t| flatten_content(&plan.path, t))
            .unwrap_or_default();
        let (mut changes, _) = diff_maps(&mesa, &disk);
        if !official {
            changes.retain(|c| c.op != "add");
        }
        if changes.is_empty() {
            continue;
        }
        let omitted = changes.len().saturating_sub(PREVIEW_CHANGE_CAP);
        changes.truncate(PREVIEW_CHANGE_CAP);
        files.push(GlobalWriteFilePreviewDto {
            path: display_path(home, &plan.path),
            tag: plan.tag.to_string(),
            action: if live.is_none() { "deleted".into() } else { "modify".into() },
            changes,
            omitted,
        });
    }
    Ok(files)
}

/// 「外部 CLI 文件已被改过」点开看：Mesa 上次写的内容（按当前连接重算）对照磁盘现状，脱敏。
/// API 连接只报 Mesa 管的键被改 / 被删（磁盘多出用户自己的键不算改过，与漂移判定同口径）；
/// 官方账号整份比，磁盘多出的键（比如又被写回的中转端点）也报。
#[tauri::command]
pub async fn global_drift_detail(
    store: tauri::State<'_, ProfileStore>,
    agent: String,
) -> Result<GlobalDriftDetailDto, String> {
    let pid = crate::settings::read_current()
        .active_global_profiles
        .and_then(|m| m.get(&agent).cloned())
        .ok_or("这个 Agent 还没有由 Mesa 写过全局默认")?;
    let profile = profile_for_write(&store, &pid)?;
    let key = profiles::get_key_for_profile(&profile).ok().flatten();
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
        let files = drift_files(&home, &profile, key.as_deref())?;
        Ok(GlobalDriftDetailDto {
            profile_id: profile.id.clone(),
            files,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 「保留外部改动」：不再把这份配置记成 Mesa 写的全局默认（不碰任何文件）。
#[tauri::command]
pub async fn forget_active_global(app: tauri::AppHandle, agent: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::settings::clear_active_global(&agent))
        .await
        .map_err(|e| e.to_string())?;
    let _ = crate::tray::rebuild_and_wait(app).await;
    Ok(())
}

#[tauri::command]
pub async fn restore_global_backup(
    app: tauri::AppHandle,
    agent: String,
) -> Result<Vec<String>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = GLOBAL_CONFIG_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _file_guard = crate::storage::config_lock("global-config")?;
        let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
        let dir = backups_root()?.join(&agent);
        let restored = restore_from(&dir, &home, &agent)?;
        // 恢复后全局内容不再是任何 profile 的快照，清除「全局生效」追踪
        crate::settings::clear_active_global(&agent);
        Ok(restored)
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = crate::tray::rebuild_and_wait(app.clone()).await;
    result
}

#[tauri::command]
pub async fn has_original_backup(agent: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        backups_root()
            .map(|r| {
                r.join(&agent)
                    .join("original")
                    .join("manifest.json")
                    .is_file()
            })
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
pub async fn restore_original_backup(
    app: tauri::AppHandle,
    agent: String,
) -> Result<Vec<String>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = GLOBAL_CONFIG_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _file_guard = crate::storage::config_lock("global-config")?;
        let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
        let dir = backups_root()?.join(&agent);
        let restored = restore_from_original(&dir, &home)?;
        // 恢复初始状态后同样清除「全局生效」追踪
        crate::settings::clear_active_global(&agent);
        Ok(restored)
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = crate::tray::rebuild_and_wait(app.clone()).await;
    result
}

#[tauri::command]
pub async fn has_global_backup(agent: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = match backups_root() {
            Ok(r) => r.join(&agent),
            Err(_) => return false,
        };
        latest_valid_manifest(&dir).is_some()
            || fs::read_dir(dir)
                .map(|rd| {
                    rd.flatten()
                        .any(|e| e.file_name().to_string_lossy().ends_with(".bak"))
                })
                .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemini_auth_only_touches_just_selected_type() {
        // 刚装好没有文件：只写认证方式
        let v: Value = serde_json::from_str(&patch_gemini_auth_only(None).unwrap()).unwrap();
        assert_eq!(v, json!({ "security": { "auth": { "selectedType": "gemini-api-key" } } }));
        // 已有设置（带注释的 JSONC）：别的字段原样保留，Google 登录改成 API Key，不写模型名单
        let existing = r#"{
          // 用户自己的
          "ui": { "theme": "GitHub" },
          "security": { "auth": { "selectedType": "oauth-personal", "useExternal": false }, "folderTrust": { "enabled": true } },
          "mcpServers": { "x": { "command": "y" } },
        }"#;
        let v: Value = serde_json::from_str(&patch_gemini_auth_only(Some(existing)).unwrap()).unwrap();
        assert_eq!(v["security"]["auth"]["selectedType"], "gemini-api-key");
        assert_eq!(v["security"]["auth"]["useExternal"], false);
        assert_eq!(v["security"]["folderTrust"]["enabled"], true);
        assert_eq!(v["ui"]["theme"], "GitHub");
        assert_eq!(v["mcpServers"]["x"]["command"], "y");
        assert!(v.get("modelConfigs").is_none() && v.get("experimental").is_none());
        // 坏文件不写
        assert!(patch_gemini_auth_only(Some("{ not json")).is_err());
        assert!(patch_gemini_auth_only(Some("[1]")).is_err());
    }

    /// 测试用：按旧参数拼一个 Claude 连接再走 patch_claude_settings
    fn pc(
        existing: Option<&str>,
        base_url: Option<&str>,
        key: Option<&str>,
        models: &[String],
        gateway_id: Option<&str>,
        effort: Option<&str>,
    ) -> Result<String, String> {
        let mut p = profile("claude-code");
        p.base_url = base_url.map(String::from);
        p.models = models.to_vec();
        p.gateway_id = gateway_id.map(String::from);
        p.request_policy.reasoning_effort = effort.map(String::from);
        patch_claude_settings(existing, &p, key)
    }

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-gcfg-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn profile(agent: &str) -> Profile {
        Profile {
            id: "test".into(),
            agent: agent.into(),
            name: "测试".into(),
            account_type: Default::default(),
            no_auth: false,
            protocol: None,
            api_backend: None,
            base_url: Some("https://relay.example.com".into()),
            models: vec!["m1".into()],
            role_models: Default::default(),
            extra_env: Default::default(),
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

    #[test]
    fn claude_patch_preserves_unrelated_fields() {
        let existing = r#"{"env": {"OTHER": "1"}, "theme": "dark"}"#;
        let out = pc(
            Some(existing),
            Some("https://relay.example.com"),
            Some("sk-secret"),
            &["claude-sonnet-4".to_string(), "m2".to_string()],
            None,
            None,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://relay.example.com");
        assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-secret");
        // 主模型写顶层 model（用户在外面 /model 能改），不写压过一切的 ANTHROPIC_MODEL
        assert_eq!(v["model"], "claude-sonnet-4");
        assert!(v["env"].get("ANTHROPIC_MODEL").is_none());
        // 模型列表注册进 /model 选择器的别名槽（显示名同启动：配置名 · 模型）
        assert_eq!(
            v["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"],
            "claude-sonnet-4"
        );
        assert_eq!(v["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"], "测试 · m2");
        assert_eq!(v["env"]["OTHER"], "1");
        assert_eq!(v["theme"], "dark");
    }

    #[test]
    fn claude_patch_writes_user_layer_and_clears_previous_connection() {
        let existing = r#"{"fallbackModel":"glm-old","effortLevel":"low","env":{"ANTHROPIC_BASE_URL":"https://old","CLAUDE_CODE_EFFORT_LEVEL":"high","MAX_THINKING_TOKENS":"0","ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION":"x"}}"#;
        let out = pc(Some(existing), None, Some("sk"), &["claude-opus-5-5".to_string()], None, Some("xhigh")).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["env"].get("ANTHROPIC_BASE_URL").is_none(), "这条连接没有地址：上一家的地址撤掉");
        assert!(v.get("fallbackModel").is_none());
        assert_eq!(v["effortLevel"], "xhigh");
        assert!(v["env"].get("CLAUDE_CODE_EFFORT_LEVEL").is_none(), "env 的思考档压过用户 /effort，不写");
        assert!(v["env"].get("MAX_THINKING_TOKENS").is_none(), "上一家写的 0 撤掉");
        assert!(v["env"].get("ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION").is_none());
        // max 不进 effortLevel（只收四档），走 env
        let out = pc(Some(&out), None, None, &["m".to_string()], None, Some("max")).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("effortLevel").is_none());
        assert_eq!(v["env"]["CLAUDE_CODE_EFFORT_LEVEL"], "max");
        // 没列模型：上一家的中转模型名撤掉，官方别名留着
        let v: Value = serde_json::from_str(&pc(Some(r#"{"model":"glm-5"}"#), None, None, &[], None, None).unwrap()).unwrap();
        assert!(v.get("model").is_none());
        let v: Value = serde_json::from_str(&pc(Some(r#"{"model":"opus"}"#), None, None, &[], None, None).unwrap()).unwrap();
        assert_eq!(v["model"], "opus");
    }

    #[test]
    fn claude_patch_replaces_model_slots_instead_of_leaving_previous() {
        let existing = r#"{
          "env": {
            "ANTHROPIC_MODEL": "old-default",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "m1",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "m1",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "m2",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "m2",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "m3",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "m3",
            "ANTHROPIC_DEFAULT_FABLE_MODEL": "m4",
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "m4",
            "ANTHROPIC_CUSTOM_MODEL_OPTION": "m5",
            "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "m5"
          }
        }"#;
        let out = pc(
            Some(existing),
            None,
            None,
            &["only-one".to_string()],
            None,
            None,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["model"], "only-one");
        assert!(v["env"].get("ANTHROPIC_MODEL").is_none());
        // 与启动同口径：名单不够四个，空槽用主模型补（haiku 槽是后台小任务用的，留着官方名会打到中转上失败）
        for slot in ["SONNET", "OPUS", "HAIKU", "FABLE"] {
            assert_eq!(v["env"][format!("ANTHROPIC_DEFAULT_{slot}_MODEL")], "only-one", "{slot}");
        }
        assert_eq!(v["env"]["ANTHROPIC_SMALL_FAST_MODEL"], "only-one");
        assert!(v["env"].get("ANTHROPIC_CUSTOM_MODEL_OPTION").is_none());
        assert!(v["env"].get("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME").is_none());
    }

    #[test]
    fn codex_patch_clears_effort_and_empty_catalog() {
        let existing = "model = \"old-model\"\nmodel_catalog_json = \"/old.json\"\nmodel_reasoning_effort = \"high\"\nmodel_provider = \"ccode\"\n";
        let out = patch_codex_config(
            Some(existing),
            Some("https://r.example.com/v1"),
            None,
            None,
            None,
            "sk-secret",
        )
        .unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert!(doc.get("model").is_none());
        assert!(doc.get("model_catalog_json").is_none());
        assert!(doc.get("model_reasoning_effort").is_none());
        assert_eq!(doc["model_provider"].as_str(), Some("custom"));
        assert_eq!(doc["web_search"].as_str(), Some("disabled"));
        // 设过的 /review、子 agent 模型改成这次的模型，没设的不建
        let out = patch_codex_config(Some("review_model = \"gpt-6-sol\"\n[agents]\nmax_threads = 4\n"), Some("https://r/v1"), Some("m1"), None, None, "sk").unwrap();
        let d: toml::Value = toml::from_str(&out).unwrap();
        assert_eq!(d["review_model"].as_str(), Some("m1"));
        assert!(d["agents"].get("default_subagent_model").is_none());
        assert_eq!(d["agents"]["max_threads"].as_integer(), Some(4));
    }

    #[test]
    fn read_existing_stops_on_undecodable_file() {
        let dir = tmpdir("read-existing-binary");
        let path = dir.join("settings.json");
        fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();
        let err = read_existing(&path).unwrap_err();
        assert!(err.contains("已停止写入"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bom_prefixed_configs_are_patched_not_rejected() {
        // PowerShell 5.1 Set-Content -Encoding UTF8 / 旧记事本会给配置加 UTF-8 BOM
        let dir = tmpdir("read-existing-bom");
        let path = dir.join("settings.json");
        fs::write(&path, "\u{feff}{\"keep\": 1}").unwrap();
        let text = read_existing(&path).unwrap().unwrap();
        assert!(!text.starts_with('\u{feff}'));
        let out = pc(Some(&text), Some("https://x"), None, &[], None, None)
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["keep"], 1);
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://x");
        fs::remove_dir_all(&dir).ok();
        // 解析函数自身也容忍（调用方没走 read_existing 时）
        let out =
            pc(Some("\u{feff}{\"keep\": 2}"), None, None, &[], None, None)
                .unwrap();
        assert!(!out.starts_with('\u{feff}'));
        let out = patch_gemini_settings(Some("\u{feff}{\"keep\": 3}"), "n", &[], None).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["keep"], 3);
        let doc = parse_toml_doc(Some("\u{feff}model = \"m\"\n")).unwrap();
        assert_eq!(doc["model"].as_str(), Some("m"));
        assert!(codex_other_switcher_marks("\u{feff}model_provider = \"custom\"\n"));
    }

    #[test]
    fn claude_patch_from_missing_file_creates_env_only() {
        let out = pc(None, None, None, &[], None, None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["env"].is_object());
        assert_eq!(v["env"].as_object().unwrap().len(), 0);
    }

    #[test]
    fn claude_patch_writes_max_context_only_when_beyond_default_assumption() {
        // 注册表确知 >200K 的模型（kimi-k3 = 1M）：必须显式声明，否则 claude 按 200K 假设提前 compact；
        // AUTO_COMPACT_WINDOW 与上限同值成对写（压缩触发点跟随声明窗口）
        let out =
            pc(None, None, None, &["kimi-k3".to_string()], None, None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "1048576");
        assert_eq!(v["env"]["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "1048576");
        // ≤200K 的模型：不写；已有旧值时两键都清掉（防上一个 profile 的 1M 残留误导）
        let out = pc(
            Some(
                r#"{"env": {"CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1048576", "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1048576"}}"#,
            ),
            None,
            None,
            &["claude-sonnet-4".to_string()],
            None,
            None,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["env"].get("CLAUDE_CODE_MAX_CONTEXT_TOKENS").is_none());
        assert!(v["env"].get("CLAUDE_CODE_AUTO_COMPACT_WINDOW").is_none());
    }

    #[test]
    fn codex_config_patch_preserves_other_tables() {
        // 共用渠道上一家（cc-switch / 官方形态）留下的残键；旧 ccode 块删、别的网关块留
        let existing = "[other]\nkeep = 1\n\n[model_providers.custom]\nname = \"OpenAI\"\nold = \"x\"\nrequires_openai_auth = true\nsupports_websockets = true\nenv_key = \"CODEX_API_KEY\"\nhttp_headers = { Authorization = \"Bearer sk-stale\" }\n\n[model_providers.ccode]\nname = \"Mesa\"\n\n[model_providers.ccode-abc]\nname = \"Mesa\"\n";
        let out = patch_codex_config(
            Some(existing),
            Some("https://r.example.com/v1"),
            Some("gpt-5"),
            Some(std::path::Path::new("/cfg/ccode/catalogs/codex-p1.json")),
            None,
            "sk-secret",
        )
        .unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["other"]["keep"].as_integer(), Some(1));
        assert!(doc["model_providers"].get("ccode").is_none());
        assert!(doc["model_providers"].get("ccode-abc").is_some());
        let ccode = &doc["model_providers"]["custom"];
        assert_eq!(ccode["name"].as_str(), Some("Mesa"));
        assert!(ccode.get("supports_websockets").is_none());
        assert_eq!(ccode["base_url"].as_str(), Some("https://r.example.com/v1"));
        // 认证走 experimental_bearer_token；旧 env_key / http_headers 清掉，不写 auth.json
        assert!(ccode.get("env_key").is_none());
        assert!(ccode.get("http_headers").is_none());
        assert_eq!(ccode["requires_openai_auth"].as_bool(), Some(false));
        assert_eq!(
            ccode["experimental_bearer_token"].as_str(),
            Some("sk-secret")
        );
        assert_eq!(ccode["wire_api"].as_str(), Some("responses"));
        // 共用渠道整块换掉，上一家的键不带过来
        assert!(ccode.get("old").is_none());
        assert_eq!(doc["model_provider"].as_str(), Some("custom"));
        assert_eq!(doc["model"].as_str(), Some("gpt-5"));
        assert_eq!(
            doc["model_catalog_json"].as_str(),
            Some("/cfg/ccode/catalogs/codex-p1.json")
        );
    }

    #[test]
    fn gateway_compat_written_on_global_and_cleared_when_off() {
        let on = crate::profiles::GatewayCompat { timeout_secs: Some(600), no_experimental_betas: true, no_thinking: true };
        let v: Value = serde_json::from_str(&patch_claude_compat(r#"{"env":{"API_TIMEOUT_MS":"1"}}"#, &on).unwrap()).unwrap();
        assert_eq!(v["env"]["API_TIMEOUT_MS"], "600000");
        assert_eq!(v["env"]["CLAUDE_CODE_DISABLE_THINKING"], "1");
        let off = crate::profiles::GatewayCompat::default();
        let v: Value = serde_json::from_str(&patch_claude_compat(&v.to_string(), &off).unwrap()).unwrap();
        assert!(v["env"].get("CLAUDE_CODE_DISABLE_THINKING").is_none() && v["env"].get("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS").is_none());
        assert_eq!(v["env"]["API_TIMEOUT_MS"], "600000", "超时没设不动");
        let out = patch_codex_compat("model_provider = \"custom\"\n[model_providers.custom]\nname = \"Mesa\"\n", &on).unwrap();
        let d: toml::Value = toml::from_str(&out).unwrap();
        assert_eq!(d["model_providers"]["custom"]["stream_idle_timeout_ms"].as_integer(), Some(600000));
    }

    #[test]
    fn claude_global_write_drops_other_providers_connection_keys() {
        let existing = r#"{"apiKeyHelper":"echo sk","hooks":{"Stop":[]},"env":{"ANTHROPIC_API_KEY":"sk-other","ANTHROPIC_CUSTOM_HEADERS":"X: y","CLAUDE_CODE_USE_BEDROCK":"1","CLAUDE_CODE_OAUTH_TOKEN":"oat","DISABLE_TELEMETRY":"1","AWS_PROFILE":"work"}}"#;
        let out = pc(Some(existing), Some("https://gw"), Some("sk-mesa"), &["m1".into()], None, None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let env = &v["env"];
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "sk-mesa");
        assert_eq!(env["ANTHROPIC_DEFAULT_SONNET_MODEL"], "m1");
        for k in ["ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_USE_BEDROCK"] {
            assert!(env.get(k).is_none(), "{k}");
        }
        for k in ["CLAUDE_CODE_OAUTH_TOKEN", "DISABLE_TELEMETRY", "AWS_PROFILE"] {
            assert!(env.get(k).is_some(), "{k} 留着");
        }
        assert!(v.get("apiKeyHelper").is_none());
        assert!(v.get("hooks").is_some());
        // 官方：别家的请求头、协议开关也撤
        let off: Value = serde_json::from_str(&patch_claude_settings_official(existing).unwrap()).unwrap();
        assert!(off["env"].get("ANTHROPIC_CUSTOM_HEADERS").is_none() && off["env"].get("CLAUDE_CODE_USE_BEDROCK").is_none());
        assert_eq!(off["env"]["CLAUDE_CODE_OAUTH_TOKEN"], "oat");
        assert!(off.get("apiKeyHelper").is_none());
    }

    #[test]
    fn qwen_uses_mesa_key_env_and_writes_effort() {
        let mut p = profile("qwen");
        p.models = vec!["glm-5".into()];
        p.request_policy.reasoning_effort = Some("high".into());
        let out = patch_qwen_settings(None, Some("sk-q"), &p).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"][QWEN_MESA_KEY_ENV], "sk-q");
        let entry = &v["modelProviders"]["openai"]["models"][0];
        assert_eq!(entry["envKey"], QWEN_MESA_KEY_ENV, "项目 .env 的 OPENAI_API_KEY 顶不掉");
        assert_eq!(entry["generationConfig"]["samplingParams"]["reasoning_effort"], "high");
    }

    #[test]
    fn gemini_extras_write_model_name_and_own_overrides_only() {
        let mut p = profile("gemini");
        p.models = vec!["glm-5".into(), "k3".into()];
        p.request_policy.temperature = Some(0.4);
        let existing = r#"{"modelConfigs":{"customOverrides":[
            {"match":{"model":"glm-5"},"modelConfig":{"generateContentConfig":{"temperature":1}}},
            {"match":{"model":"glm-5","overrideScope":"core"},"modelConfig":{}},
            {"match":{"model":"gemini-3-pro"},"modelConfig":{}}
        ]}}"#;
        let v: Value = serde_json::from_str(&patch_gemini_extras(existing, &p).unwrap()).unwrap();
        assert_eq!(v["model"]["name"], "glm-5");
        let arr = v["modelConfigs"]["customOverrides"].as_array().unwrap();
        // 用户的两条留着，Mesa 的旧条目换成新的（每个模型一条）
        assert_eq!(arr.len(), 4);
        assert!(arr.iter().any(|o| o["match"]["model"] == "gemini-3-pro"));
        assert!(arr.iter().any(|o| o["match"]["overrideScope"] == "core"));
        let ours: Vec<_> = arr.iter().filter(|o| o["match"].as_object().unwrap().len() == 1 && o["match"]["model"] != "gemini-3-pro").collect();
        assert_eq!(ours.len(), 2);
        assert!(ours.iter().all(|o| o["modelConfig"]["generateContentConfig"]["temperature"] == 0.4));
        // 没有策略时不新建 modelConfigs
        let mut bare = profile("gemini");
        bare.models = vec!["glm-5".into()];
        let v: Value = serde_json::from_str(&patch_gemini_extras("{}", &bare).unwrap()).unwrap();
        assert!(v.get("modelConfigs").is_none());
    }

    #[test]
    fn codex_relay_extras_replace_stale_window_and_disable_app_tools() {
        // 未知模型：上一家留下的窗口撤掉；app-tools 插件关掉；用户别的插件不动
        let stale = "model_context_window = 1000000\nmodel_auto_compact_token_limit = 950000\n[plugins.\"other@x\"]\nenabled = true\n";
        let mut hdr = BTreeMap::new();
        hdr.insert("X-Region".to_string(), "MODEL_REGION".to_string());
        let out = patch_codex_relay_extras(stale, Some("relay-unknown-xyz"), None, &hdr).unwrap();
        let doc: toml::Value = toml::from_str(&out).unwrap();
        assert!(doc.get("model_context_window").is_none());
        assert!(doc.get("model_auto_compact_token_limit").is_none());
        assert_eq!(doc["plugins"]["codex-app-tools@openai-bundled"]["enabled"].as_bool(), Some(false));
        assert_eq!(doc["plugins"]["other@x"]["enabled"].as_bool(), Some(true));
        assert_eq!(doc["model_providers"]["custom"]["env_http_headers"]["X-Region"].as_str(), Some("MODEL_REGION"));
        // 官方切回：关掉的插件、写进去的窗口撤掉，别的插件留着
        let back = patch_codex_config_official(Some(&out)).unwrap();
        let doc: toml::Value = toml::from_str(&back).unwrap();
        assert!(doc["plugins"].get("codex-app-tools@openai-bundled").is_none());
        assert_eq!(doc["plugins"]["other@x"]["enabled"].as_bool(), Some(true));
        let only = patch_codex_config_official(Some("model_context_window = 5\n[plugins.\"codex-app-tools@openai-bundled\"]\nenabled = false\n")).unwrap();
        assert_eq!(only.trim(), "");
    }

    #[test]
    fn codex_official_falls_back_to_builtin_openai_and_keeps_custom() {
        let existing = r#"model_provider = "custom"
model = "deepseek-v4"
model_catalog_json = "/cfg/ccode/catalogs/codex-p1.json"
model_reasoning_effort = "high"

[model_providers.custom]
name = "Mesa"
base_url = "https://relay.example.com/v1"
experimental_bearer_token = "sk-k"
requires_openai_auth = false

[model_providers.ccode-abc]
name = "Mesa"
base_url = "https://relay.example.com/v1"

[mcp_servers.x]
command = "y"

[projects."/w"]
trust_level = "trusted"
"#;
        let out = patch_codex_config_official(Some(existing)).unwrap();
        let doc: toml::Value = toml::from_str(&out).unwrap();
        // 回落内置 openai；共用渠道块原样留着，中转跑过的老对话照旧走原连接
        assert!(doc.get("model_provider").is_none());
        let side = patch_codex_config_official(Some("openai_base_url = \"https://x\"\nweb_search = \"disabled\"\nreview_model = \"deepseek-v4\"\n[agents]\ndefault_subagent_model = \"gpt-6-luna\"\n")).unwrap();
        let sd: toml::Value = toml::from_str(&side).unwrap();
        assert!(sd.get("openai_base_url").is_none() && sd.get("web_search").is_none() && sd.get("review_model").is_none());
        assert_eq!(sd["agents"]["default_subagent_model"].as_str(), Some("gpt-6-luna"), "官方模型名留着");
        let blk = &doc["model_providers"]["custom"];
        assert_eq!(blk["name"].as_str(), Some("Mesa"));
        assert_eq!(blk["base_url"].as_str(), Some("https://relay.example.com/v1"));
        assert!(doc.get("model_catalog_json").is_none());
        assert!(doc.get("model").is_none(), "中转模型名不能留给官方账号");
        assert_eq!(doc["model_reasoning_effort"].as_str(), Some("high"));
        // 别的渠道定义块留着（客户端打开旧对话要查得到），其余配置原样
        assert!(doc["model_providers"].get("ccode-abc").is_some());
        assert_eq!(doc["mcp_servers"]["x"]["command"].as_str(), Some("y"));
        assert_eq!(doc["projects"]["/w"]["trust_level"].as_str(), Some("trusted"));
        // 官方模型名保留；幂等（托盘 dry-run 靠它判当前就是官方）
        let kept = patch_codex_config_official(Some("model = \"gpt-6-astra\"\n")).unwrap();
        assert!(kept.contains("model = \"gpt-6-astra\""));
        assert_eq!(patch_codex_config_official(Some(&kept)).unwrap(), kept);
    }

    #[test]
    fn official_plans_drop_only_api_keys_per_agent() {
        let home = tmpdir("official-all");
        let w = |rel: &str, body: &str| {
            let p = home.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, body).unwrap();
        };
        let off = |agent: &str| {
            let mut p = profile(agent);
            p.account_type = crate::profiles::AccountType::Official;
            p.base_url = None;
            plan_writes(&home, &p, None, &[]).unwrap()
        };
        // 文件都不存在：无事可写
        for a in ["codex", "claude-code", "gemini", "qwen", "codebuddy", "kimi", "grok"] {
            assert!(off(a).is_empty(), "{a}");
        }
        assert!(official_global_is_patch("grok") && !official_global_is_patch("opencode"));

        w(".claude/settings.json", r#"{"theme":"dark","env":{"ANTHROPIC_BASE_URL":"https://r","ANTHROPIC_AUTH_TOKEN":"sk","ANTHROPIC_MODEL":"glm-5","ANTHROPIC_DEFAULT_OPUS_MODEL":"glm-5","CLAUDE_CODE_EFFORT_LEVEL":"high","MY_VAR":"1"}}"#);
        let v: Value = serde_json::from_str(&off("claude-code")[0].content).unwrap();
        assert_eq!(v["env"], json!({"CLAUDE_CODE_EFFORT_LEVEL":"high","MY_VAR":"1"}));
        assert_eq!(v["theme"], "dark");
        w(".claude/settings.json", r#"{"env":{"ANTHROPIC_MODEL":"opus"}}"#);
        let v: Value = serde_json::from_str(&off("claude-code")[0].content).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_MODEL"], "opus");
        w(".claude/settings.json", r#"{"model":"glm-5.3[1m]","env":{}}"#);
        let v: Value = serde_json::from_str(&off("claude-code")[0].content).unwrap();
        assert!(v.get("model").is_none(), "顶层中转模型也撤");

        w(".codebuddy/settings.json", r#"{"env":{"CODEBUDDY_BASE_URL":"https://r","CODEBUDDY_API_KEY":"sk","CODEBUDDY_MODEL":"deepseek-v4"}}"#);
        let v: Value = serde_json::from_str(&off("codebuddy")[0].content).unwrap();
        assert_eq!(v["env"], json!({}));

        w(".qwen/settings.json", r#"{"security":{"auth":{"selectedType":"openai"}},"env":{"OPENAI_API_KEY":"sk","MESA_QWEN_API_KEY":"sk","OPENAI_BASE_URL":"https://r","OPENAI_MODEL":"glm-5"},"model":{"name":"glm-5"},"modelProviders":{"openai":{"models":[{"id":"glm-5"}]}}}"#);
        let v: Value = serde_json::from_str(&off("qwen")[0].content).unwrap();
        assert!(v["security"]["auth"].get("selectedType").is_none(), "Qwen OAuth 已停用：撤掉 Mesa 写的协议名，不改成 qwen-oauth");
        assert_eq!(v["env"], json!({}));
        assert!(v["model"].get("name").is_none());
        assert!(v["modelProviders"]["openai"].is_object());

        w(".gemini/.env", "GEMINI_API_KEY=sk\nGOOGLE_GEMINI_BASE_URL=https://r\nGEMINI_MODEL=glm-5\nOTHER=1\n");
        w(".gemini/settings.json", "{ // jsonc\n \"security\": {\"auth\": {\"selectedType\": \"gemini-api-key\"}}, \"model\": {\"name\": \"glm-5\"}, \"ui\": {\"theme\": \"x\"} }");
        let plans = off("gemini");
        assert_eq!(plans[0].content, "OTHER=1\n");
        let v: Value = serde_json::from_str(&plans[1].content).unwrap();
        assert!(v["security"]["auth"].get("selectedType").is_none(), "撤掉 Mesa 写的 API Key 认证，不写死 Google 登录");
        assert!(v["model"].get("name").is_none());
        // 用户自己选的（比如 Vertex）不动
        w(".gemini/settings.json", r#"{"security":{"auth":{"selectedType":"vertex-ai"}}}"#);
        let v: Value = serde_json::from_str(&off("gemini")[1].content).unwrap();
        assert_eq!(v["security"]["auth"]["selectedType"], "vertex-ai");
        w(".gemini/settings.json", "{ // jsonc\n \"security\": {\"auth\": {\"selectedType\": \"gemini-api-key\"}}, \"ui\": {\"theme\": \"x\"} }");
        let v: Value = serde_json::from_str(&off("gemini")[1].content).unwrap();
        assert_eq!(v["ui"]["theme"], "x");

        w(".kimi-code/config.toml", "default_model = \"kimi-k3\"\n[providers.ccode-x]\ntype = \"openai\"\n[models.kimi-k3]\nprovider = \"ccode-x\"\n[models.\"kimi-code/k3\"]\nprovider = \"managed:kimi-code\"\n");
        let doc: toml::Value = toml::from_str(&off("kimi")[0].content).unwrap();
        assert_eq!(doc["default_model"].as_str(), Some("kimi-code/k3"));
        assert!(doc["providers"].get("ccode-x").is_some());
        w(".kimi-code/config.toml", "default_model = \"kimi-k3\"\n[models.kimi-k3]\nprovider = \"ccode-x\"\n");
        let doc: toml::Value = toml::from_str(&off("kimi")[0].content).unwrap();
        assert!(doc.get("default_model").is_none(), "没登录过就撤默认模型");

        w(".grok/config.toml", "api_key = \"sk\"\n[endpoints]\nmodels_base_url = \"https://r/v1\"\n[models]\ndefault = \"glm-5\"\ntemperature = 0.3\n[model.glm-5]\nbase_url = \"https://r/v1\"\n[model.grok-4]\nbase_url = \"https://api.x.ai/v1\"\n[model.k3]\nname = \"中转 · k3\"\nbase_url = \"https://r/v1\"\napi_key = \"sk\"\n[model.byok]\nname = \"我的\"\nbase_url = \"https://mine/v1\"\nenv_key = \"MINE_KEY\"\n[mcp_servers.m]\ncommand = \"c\"\n");
        let doc: toml::Value = toml::from_str(&off("grok")[0].content).unwrap();
        assert!(doc.get("api_key").is_none() && doc.get("endpoints").is_none());
        assert!(doc["models"].get("default").is_none());
        assert_eq!(doc["models"]["temperature"].as_float(), Some(0.3));
        assert!(doc["model"].get("glm-5").is_none() && doc["model"].get("grok-4").is_some());
        assert!(doc["model"].get("k3").is_some(), "带自己密钥的中转段留着（Mesa 写的也留，老会话还要续）");
        assert!(doc["model"].get("byok").is_some(), "用户手写、带自己密钥的段留着");
        assert!(doc["mcp_servers"].get("m").is_some());

        // 每家补丁幂等：写完再算一遍计划，整份比对一致
        for a in ["claude-code", "gemini", "qwen", "codebuddy", "kimi", "grok"] {
            let plans = off(a);
            apply_plans(&home.join("bk").join(a), &home, &plans).unwrap();
            assert!(disk_equals_plans(&off(a)), "{a}");
        }
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn model_picked_in_the_cli_is_the_users_choice_not_drift() {
        // Codex 客户端里换模型会写回顶层 model；连接本身（地址）被改才算漂移
        let home = tmpdir("user-choice");
        let p = profile("codex");
        let key = Some("sk-secret-abcdef");
        let plans = plan_writes(&home, &p, key, &p.models).unwrap();
        apply_plans(&home.join("bk"), &home, &plans).unwrap();
        let cfg = home.join(".codex/config.toml");
        let text = fs::read_to_string(&cfg).unwrap().replace("model = \"m1\"", "model = \"gpt-6-luna\"");
        assert!(text.contains("gpt-6-luna"));
        fs::write(&cfg, &text).unwrap();
        assert!(drift_files(&home, &p, key).unwrap().is_empty());
        let plans = plan_writes(&home, &p, key, &p.models).unwrap();
        assert!(plans_match_disk(&p, &plans));
        fs::write(&cfg, text.replace("https://relay.example.com", "https://other.example.com")).unwrap();
        assert!(!drift_files(&home, &p, key).unwrap().is_empty());
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn codex_catalog_tail_added_by_continuity_layer_is_not_drift() {
        // 续聊层在全局目录尾部追加老对话的模型：漂移比对数组整组比，不认这条就一直报「外部改过」，按 Mesa 重写也消不掉
        let home = tmpdir("catalog-tail");
        let p = profile("codex");
        let key = Some("sk-secret-abcdef");
        let plans = plan_writes(&home, &p, key, &p.models).unwrap();
        apply_plans(&home.join("bk"), &home, &plans).unwrap();
        let cat = agents::codex_global_catalog_path().unwrap();
        let mut v: Value = serde_json::from_str(&fs::read_to_string(&cat).unwrap()).unwrap();
        v["models"].as_array_mut().unwrap().push(json!({"slug": "old-thread-model"}));
        fs::write(&cat, v.to_string()).unwrap();
        assert!(drift_files(&home, &p, key).unwrap().is_empty());
        let plans = plan_writes(&home, &p, key, &p.models).unwrap();
        assert!(disk_matches_plans(&plans));
        // 开头的条目被改了才算
        v["models"][0]["display_name"] = json!("别人改的");
        fs::write(&cat, v.to_string()).unwrap();
        assert!(!drift_files(&home, &p, key).unwrap().is_empty());
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn drift_files_reports_mesa_keys_only_for_api() {
        let home = tmpdir("drift-detail");
        let p = profile("codex");
        let key = Some("sk-secret-abcdef");
        let plans = plan_writes(&home, &p, key, &p.models).unwrap();
        apply_plans(&home.join("bk"), &home, &plans).unwrap();
        assert!(drift_files(&home, &p, key).unwrap().is_empty());
        // 外部把地址改了、又加了自己的键：只报地址，密钥不出明文
        let cfg = home.join(".codex/config.toml");
        let text = fs::read_to_string(&cfg).unwrap()
            .replace("https://relay.example.com", "https://other.example.com")
            .replace("experimental_bearer_token = \"sk-secret-abcdef\"", "experimental_bearer_token = \"sk-other-999999\"");
        fs::write(&cfg, format!("approval_policy = \"never\"\n{text}")).unwrap();
        let files = drift_files(&home, &p, key).unwrap();
        let changes = &files.iter().find(|f| f.tag == "config.toml").unwrap().changes;
        assert!(changes.iter().all(|c| c.op != "add"));
        assert!(changes.iter().any(|c| c.path.ends_with("base_url") && c.after.as_deref().unwrap_or("").contains("other.example.com")));
        let json = serde_json::to_string(&files).unwrap();
        assert!(!json.contains("sk-secret-abcdef") && !json.contains("sk-other-999999"));
        // 官方：磁盘多出的键（又被写回的中转渠道）也报
        let mut off = profile("codex");
        off.account_type = crate::profiles::AccountType::Official;
        let plans = plan_writes(&home, &off, None, &[]).unwrap();
        apply_plans(&home.join("bk2"), &home, &plans).unwrap();
        // 官方计划留着 Mesa 的全局目录引用（续聊层按需撤），这里换成别人的目录
        let text: String = fs::read_to_string(&cfg)
            .unwrap()
            .lines()
            .filter(|l| !l.starts_with("model_catalog_json"))
            .map(|l| format!("{l}\n"))
            .collect();
        fs::write(&cfg, format!("model_catalog_json = \"/x.json\"\n{text}")).unwrap();
        let files = drift_files(&home, &off, None).unwrap();
        assert!(files[0].changes.iter().any(|c| c.op == "add" && c.path == "model_catalog_json"));
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn official_match_is_exact_not_subset() {
        // 删键计划用子集比对永远为真（托盘会两项都打勾），官方必须整份比
        let home = tmpdir("official-exact");
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(home.join(".codex/config.toml"), "model_provider = \"ccode-x\"\n").unwrap();
        let mut p = profile("codex");
        p.account_type = crate::profiles::AccountType::Official;
        let plans = plan_writes(&home, &p, None, &[]).unwrap();
        assert!(!disk_equals_plans(&plans));
        apply_plans(&home.join("bk"), &home, &plans).unwrap();
        assert!(disk_equals_plans(&plan_writes(&home, &p, None, &[]).unwrap()));
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn codex_plan_writes_does_not_touch_auth_json() {
        let home = tmpdir("codex-no-auth");
        let mut p = profile("codex");
        p.models.clear();
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(
            home.join(".codex/auth.json"),
            r#"{"tokens":{"id_token":"keep"}}"#,
        )
        .unwrap();
        let plans = plan_writes(&home, &p, Some("sk-secret"), &[]).unwrap();
        assert!(
            plans.iter().all(|w| !w.path.ends_with("auth.json")),
            "设为全局不得改 auth.json"
        );
        let cfg = plans
            .iter()
            .find(|w| w.path.ends_with("config.toml"))
            .expect("应写 config.toml");
        assert!(cfg.content.contains("experimental_bearer_token"));
        assert!(cfg.content.contains("sk-secret"));
        assert!(cfg.content.contains("model_provider"));
        assert!(!cfg.content.contains("http_headers"));
        assert_eq!(
            fs::read_to_string(home.join(".codex/auth.json")).unwrap(),
            r#"{"tokens":{"id_token":"keep"}}"#,
            "plan 阶段不得改磁盘 auth.json"
        );
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn codex_register_patch_writes_definition_without_switching_default() {
        // 注册到客户端：只写 provider 定义块（含块内静态认证头），顶层默认渠道与模型原样不动
        let existing = "model_provider = \"custom\"\nmodel = \"gpt-5.6-luna\"\n\n[model_providers.custom]\nbase_url = \"https://old.example.com/v1\"\n\n[model_providers.ccode-a1b2c3d4]\nrequires_openai_auth = true\nenv_key = \"CODEX_API_KEY\"\n";
        let out = patch_codex_config_register(
            Some(existing),
            Some("https://relay.example.com/v1"),
            "ccode-a1b2c3d4",
            "sk-relay-key",
        )
        .unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(
            doc["model_provider"].as_str(),
            Some("custom"),
            "默认渠道不动"
        );
        assert_eq!(doc["model"].as_str(), Some("gpt-5.6-luna"), "默认模型不动");
        assert_eq!(
            doc["model_providers"]["custom"]["base_url"].as_str(),
            Some("https://old.example.com/v1"),
            "既有 provider 块不动"
        );
        let blk = &doc["model_providers"]["ccode-a1b2c3d4"];
        assert_eq!(
            blk["base_url"].as_str(),
            Some("https://relay.example.com/v1")
        );
        // 认证 = experimental_bearer_token；旧 requires_openai_auth=true / env_key 被清掉
        assert_eq!(
            blk["experimental_bearer_token"].as_str(),
            Some("sk-relay-key")
        );
        assert_eq!(blk["requires_openai_auth"].as_bool(), Some(false));
        assert!(blk.get("env_key").is_none());
        assert!(blk.get("http_headers").is_none());
        assert_eq!(blk["wire_api"].as_str(), Some("responses"));
        // 空文档也能建块；无 model_provider 的文档不会被补出开关行
        let out2 =
            patch_codex_config_register(None, Some("https://r.example.com/v1"), "ccode-x", "sk-k")
                .unwrap();
        let doc2: toml_edit::DocumentMut = out2.parse().unwrap();
        assert!(doc2.get("model_provider").is_none());
        assert_eq!(
            doc2["model_providers"]["ccode-x"]["base_url"].as_str(),
            Some("https://r.example.com/v1")
        );
    }

    #[test]
    fn codex_other_switcher_marks_catalog_and_custom() {
        assert!(codex_other_switcher_marks(
            "model_catalog_json = \"cc-switch-model-catalog.json\"\n"
        ));
        assert!(codex_other_switcher_marks(
            "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://a\"\n"
        ));
        assert!(codex_other_switcher_marks(
            "[model_providers.custom]\nbase_url = \"https://a\"\n"
        ));
        assert!(!codex_other_switcher_marks(
            "model_provider = \"ccode-abcd\"\n[model_providers.ccode-abcd]\nbase_url = \"https://a\"\n"
        ));
        assert!(!codex_other_switcher_marks("model = \"gpt-5\"\n"));
        // 共用渠道名：Mesa 写的、ChatGPT 登录形态的都不算别家
        assert!(!codex_other_switcher_marks(
            "model_provider = \"custom\"\n[model_providers.custom]\nname = \"Mesa\"\nbase_url = \"https://a\"\n"
        ));
        assert!(!codex_other_switcher_marks(
            "model_provider = \"custom\"\n[model_providers.custom]\nname = \"OpenAI\"\nrequires_openai_auth = true\n"
        ));
        assert!(codex_other_switcher_marks(
            "model_provider = \"custom\"\n[model_providers.custom]\nname = \"NewAPI\"\nbase_url = \"https://a\"\n"
        ));
    }

    #[test]
    fn set_global_conflict_reason_all_agents() {
        assert!(set_global_conflict_reason("claude-code", true, None).is_some());
        assert!(set_global_conflict_reason("gemini", true, None).is_some());
        assert!(set_global_conflict_reason("qwen", true, None).is_some());
        assert!(set_global_conflict_reason("kimi", true, None).is_some());
        assert!(set_global_conflict_reason("grok", true, None).is_some());
        assert!(set_global_conflict_reason("claude-code", false, None).is_none());
        assert!(set_global_conflict_reason("cursor", true, None).is_none());
        assert_eq!(
            set_global_conflict_reason("codex", true, None),
            Some(CODEX_SET_GLOBAL_CONFLICT)
        );
        assert_eq!(
            set_global_conflict_reason(
                "codex",
                false,
                Some("[model_providers.custom]\nbase_url = \"https://a\"\n")
            ),
            Some(CODEX_SET_GLOBAL_CONFLICT)
        );
        assert!(set_global_conflict_reason("codex", false, Some("model = \"gpt-5\"\n")).is_none());
        assert_eq!(
            set_global_conflict_reason("opencode", true, None),
            Some(SET_GLOBAL_CC_SWITCH_CONFLICT)
        );
    }

    #[test]
    fn gemini_settings_patch_adds_selected_type_and_tolerates_jsonc() {
        // 从无到有
        let v: Value =
            serde_json::from_str(&patch_gemini_settings(None, "测试", &[], None).unwrap()).unwrap();
        assert_eq!(v["security"]["auth"]["selectedType"], "gemini-api-key");
        // 无模型名单时不写 experimental 段
        assert!(v.get("experimental").is_none());
        // JSONC 容错（注释 + 尾逗号），既有字段保留
        let existing = "{\n  // 主题\n  \"theme\": \"dark\",\n}\n";
        let v: Value = serde_json::from_str(
            &patch_gemini_settings(Some(existing), "测试", &[], None).unwrap(),
        )
        .unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["security"]["auth"]["selectedType"], "gemini-api-key");
        // 损坏文件拒写（fail-loud），不静默覆盖
        assert!(patch_gemini_settings(Some("{ not json"), "测试", &[], None).is_err());
    }

    #[test]
    fn gemini_settings_patch_registers_custom_models_for_picker() {
        // /model 选择器登记（0.46.0 bundle 实证）：experimental 开关 + modelDefinitions，
        // isVisible 必显式 true，tier=custom；既有字段与用户条目保留
        let existing = r#"{"modelConfigs": {"modelDefinitions": {"user-one": {"tier": "custom", "isVisible": true}}}}"#;
        let out = patch_gemini_settings(
            Some(existing),
            "我的网关",
            &["gemini-3-pro".into(), "kimi-k3".into()],
            None,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["experimental"]["dynamicModelConfiguration"], true);
        let defs = &v["modelConfigs"]["modelDefinitions"];
        assert_eq!(defs["gemini-3-pro"]["tier"], "custom");
        assert_eq!(defs["gemini-3-pro"]["isVisible"], true);
        assert_eq!(
            defs["gemini-3-pro"]["displayName"],
            "我的网关 · gemini-3-pro"
        );
        // 用户手维护的条目不动
        assert_eq!(defs["user-one"]["isVisible"], true);
        // kimi-k3 注册链确知思考+视觉 → features 声明；gemini-3-pro 视觉确知
        assert_eq!(defs["kimi-k3"]["features"]["thinking"], true);
        assert_eq!(defs["gemini-3-pro"]["features"]["multimodalToolUse"], true);
    }

    #[test]
    fn gemini_env_patch_replaces_only_our_keys() {
        let existing = "# comment\nGEMINI_API_KEY=old\nOTHER=1\n";
        let pairs = vec![
            ("GEMINI_API_KEY".to_string(), "new-key".to_string()),
            ("GEMINI_MODEL".to_string(), "gemini-3-pro".to_string()),
        ];
        let out = patch_env_file(Some(existing), &pairs).unwrap();
        assert!(out.contains("GEMINI_API_KEY=new-key"));
        assert!(out.contains("GEMINI_MODEL=gemini-3-pro"));
        assert!(out.contains("OTHER=1"));
        assert!(out.contains("# comment"));
        assert!(!out.contains("old"));
    }

    #[test]
    fn gemini_env_patch_rejects_multiline_values() {
        let pairs = vec![("GEMINI_API_KEY".to_string(), "k1\nINJECTED=1".to_string())];
        let err = patch_env_file(None, &pairs).unwrap_err();
        assert!(err.contains("换行符"), "{err}");
        let pairs_cr = vec![("GEMINI_MODEL".to_string(), "m\rx".to_string())];
        assert!(patch_env_file(None, &pairs_cr).is_err());
    }

    #[test]
    fn qwen_patch_openai_protocol() {
        let existing = r#"{"security": {"auth": {"other": true}}}"#;
        let mut p = profile("qwen");
        p.base_url = Some("https://dashscope.aliyuncs.com/compatible-mode/v1".into());
        p.models = vec!["qwen3-coder".into(), "qwen3-max".into()];
        let out = patch_qwen_settings(Some(existing), Some("sk-secret"), &p).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["security"]["auth"]["selectedType"], "openai");
        assert_eq!(v["security"]["auth"]["other"], true);
        assert_eq!(v["env"]["OPENAI_API_KEY"], "sk-secret");
        assert_eq!(v["env"]["OPENAI_MODEL"], "qwen3-coder");
        assert_eq!(v["model"]["name"], "qwen3-coder");
        assert!(v["env"].get("ANTHROPIC_API_KEY").is_none());
        // modelProviders.openai.models：TUI /model 对话框的数据源
        let models = v["modelProviders"]["openai"]["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["id"], "qwen3-coder");
        assert_eq!(models[0]["name"], "qwen3-coder");
        assert_eq!(
            models[0]["baseUrl"],
            "https://dashscope.aliyuncs.com/compatible-mode/v1"
        );
        assert_eq!(models[0]["envKey"], QWEN_MESA_KEY_ENV);
        assert_eq!(models[1]["id"], "qwen3-max");
        // 无策略时不写 generationConfig
        assert!(models[0].get("generationConfig").is_none());
    }

    #[test]
    fn qwen_patch_entries_carry_generation_config_from_policy() {
        // generationConfig.samplingParams（0.22.0 bundle 实证，snake_case 线格式键名），
        // 逐模型取各模型的策略值
        let mut p = profile("qwen");
        p.models = vec!["qwen3-coder".into(), "qwen3-max".into()];
        p.request_policy.temperature = Some(0.6);
        p.request_policy.top_p = Some(0.95);
        p.request_policy.max_output_tokens = Some(8192);
        let out = patch_qwen_settings(None, Some("sk-secret"), &p).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let models = v["modelProviders"]["openai"]["models"].as_array().unwrap();
        let sp = &models[0]["generationConfig"]["samplingParams"];
        assert_eq!(sp["temperature"], 0.6);
        assert_eq!(sp["top_p"], 0.95);
        assert_eq!(sp["max_tokens"], 8192);
        assert!(sp.get("topP").is_none(), "键名必须是 snake_case 线格式");
    }

    /// 跨层一致性：agent_specs::request_policy_support 的通道表和本文件的补丁函数是两处
    /// 手写知识。加一个 agent、改一档通道，两边都不会编译失败——只有这个测试会响。
    ///
    /// 只断言表里说「写盘可达」（persist）的部分：
    /// - persist ⇒ 该字段必须真的落到写出的配置里；
    /// - unsupported ⇒ 即使设了值，写出的文本里也不该出现（防补丁函数偷偷多写一条表不知道的路径）。
    /// **不断言 inject。** 表的取值按入口记账，inject 指的是启动注入（agents::apply_request_policy_env），
    /// 本来就**不该**进配置文件；把「inject ⇒ 写盘」写成断言，等于把当初 persist 拆分要修的那个
    /// 混淆（见 agent_specs.rs 里 qwen 那条注释）重新钉进测试。启动注入那半边归 agents.rs 的测试管。
    #[test]
    fn policy_channel_table_agrees_with_patch_functions() {
        use crate::agent_specs::request_policy_support;

        // 探针值取得足够怪：在输出里按子串找它们，撞上别的字段的概率可以忽略。
        // 三个字段各用不同数量级，便于区分是谁漏出来的。
        const PROBE_TEMP: f64 = 0.123456;
        const PROBE_TOP_P: f64 = 0.654321;
        const PROBE_MAX: u64 = 987654;

        // 表里五个字段名，与 RequestPolicySupportDto 的字段一一对应。
        const FIELDS: [&str; 5] = [
            "temperature",
            "top_p",
            "max_output_tokens",
            "reasoning_effort",
            "custom_headers",
        ];

        let field_value = |field: &str| -> Value {
            match field {
                "temperature" => json!(PROBE_TEMP),
                "top_p" => json!(PROBE_TOP_P),
                "max_output_tokens" => json!(PROBE_MAX),
                "reasoning_effort" => json!("probeEffort7"),
                "custom_headers" => json!("PROBE_HEADER_ENV_7"),
                other => panic!("表里出现了测试不认识的字段 {other}，请同步本测试"),
            }
        };
        let field_status = |agent: &str, field: &str| match field {
            "temperature" => request_policy_support(agent).temperature,
            "top_p" => request_policy_support(agent).top_p,
            "max_output_tokens" => request_policy_support(agent).max_output_tokens,
            "reasoning_effort" => request_policy_support(agent).reasoning_effort,
            "custom_headers" => request_policy_support(agent).custom_headers,
            other => panic!("表里出现了测试不认识的字段 {other}"),
        };

        // 只把该字段设上，其余留空——这样输出里出现的探针值一定来自这个字段。
        let only = |agent: &str, field: &str| -> (Profile, String) {
            let mut p = profile(agent);
            p.models = vec!["probe-model-7".into()];
            let value = field_value(field);
            match field {
                "temperature" => p.request_policy.temperature = Some(value.as_f64().unwrap()),
                "top_p" => p.request_policy.top_p = Some(value.as_f64().unwrap()),
                "max_output_tokens" => {
                    p.request_policy.max_output_tokens = Some(value.as_u64().unwrap())
                }
                "reasoning_effort" => {
                    p.request_policy.reasoning_effort = Some(value.as_str().unwrap().into())
                }
                "custom_headers" => {
                    p.request_policy
                        .header_env
                        .insert("X-Probe".into(), "PROBE_HEADER_ENV_7".into());
                }
                other => panic!("字段 {other} 没有探针"),
            }
            // 在写出的文本里找这个子串。字符串字段用裸文本（配置里会带引号，
            // 裸串仍是其子串）；数值字段直接用 JSON 记法。
            let text = match value.as_str() {
                Some(s) => s.to_string(),
                None => value.to_string(),
            };
            (p, text)
        };

        // 跑「设为全局」的写盘路径，返回要落盘的文本。每个 agent 一条，缺了就 panic——
        // 将来加了 agent，这里必须显式补一条，不能悄悄漏测。
        let written = |p: &Profile| -> String {
            let key = Some("sk-probe");
            match p.agent.as_str() {
                "claude-code" => {
                    pc(None, p.base_url.as_deref(), key, &p.models, None, None)
                }
                "qwen" => patch_qwen_settings(None, key, p),
                "gemini" => patch_gemini_settings(None, &p.name, &p.models, None)
                    .and_then(|c| patch_gemini_extras(&c, p)),
                "codex" => patch_codex_config(
                    None,
                    p.base_url.as_deref(),
                    p.models.first().map(String::as_str),
                    None,
                    None,
                    "sk-probe",
                ),
                "opencode" => {
                    let mut provider = crate::agents::opencode_provider_json(p, key, None);
                    overlay_opencode_per_model(&mut provider, p);
                    patch_opencode_config(None, provider, None, None, "ccode-probe")
                }
                "kimi" => patch_kimi_config(
                    None,
                    "kimi",
                    &p.name,
                    p.base_url.as_deref(),
                    key,
                    &p.models,
                    true,
                    "ccode-probe",
                    None,
                ),
                "grok" => patch_grok_config(None, key, p),
                "codebuddy" => patch_codebuddy_settings(
                    None,
                    p.base_url.as_deref(),
                    key,
                    p.models.first().map(String::as_str),
                    p.request_policy.max_output_tokens,
                ),
                other => panic!("新增了 agent {other}，请在跨层一致性测试里补一条写盘路径"),
            }
            .unwrap_or_else(|e| panic!("{} 写盘失败: {e}", p.agent))
        };

        // 表里声明「设为全局写盘可达」的格子。改动这张表时这个测试会要求你同时改补丁函数
        // （或反过来），这正是它的用处——它不该被顺手放宽。
        let agents = [
            "claude-code",
            "codebuddy",
            "gemini",
            "codex",
            "opencode",
            "kimi",
            "qwen",
            "grok",
        ];
        let mut persist_cells = Vec::new();
        let mut failures = Vec::new();
        for agent in agents {
            for field in FIELDS {
                let status = field_status(agent, field);
                let (p, probe) = only(agent, field);
                let text = written(&p);
                let present = text.contains(&probe);
                match status {
                    "persist" => {
                        persist_cells.push(format!("{agent}.{field}"));
                        if !present {
                            failures.push(format!(
                                "{agent} 的 {field} 声明为 persist（设为全局可达），\
                                 但写出的配置里没有这个值——补丁函数漏写了，或表该降级"
                            ));
                        }
                    }
                    "unsupported" => {
                        if present {
                            failures.push(format!(
                                "{agent} 的 {field} 声明为 unsupported（CLI 无入口），\
                                 却出现在了写出的配置里——补丁函数多了一条表不知道的写盘路径"
                            ));
                        }
                    }
                    // inject 属于启动注入那半边，tui/unknown 本就不该落盘；这里不表态。
                    _ => {}
                }
            }
        }
        assert!(
            failures.is_empty(),
            "通道表与写盘函数不一致：\n{}",
            failures.join("\n")
        );

        // 表里 persist 的格子：gemini 三项采样（customOverrides）与 qwen 采样 + 思考档（samplingParams）。
        // 这条防的是「表被悄悄扩了 persist 而没人实现」——真出现了，上面 failures 会先响，这里再说明该去看哪。
        assert_eq!(
            persist_cells,
            [
                "gemini.temperature",
                "gemini.top_p",
                "gemini.max_output_tokens",
                "qwen.temperature",
                "qwen.top_p",
                "qwen.reasoning_effort",
            ]
            .map(String::from)
            .to_vec(),
            "persist 格子变了：确认补丁函数跟上后，同步更新这里"
        );
    }

    #[test]
    fn qwen_patch_anthropic_protocol() {
        let mut p = profile("qwen");
        p.protocol = Some("anthropic".into());
        p.base_url = Some("https://r.example.com".into());
        p.models = vec![];
        let out = patch_qwen_settings(None, Some("k"), &p).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["security"]["auth"]["selectedType"], "anthropic");
        assert_eq!(v["env"]["ANTHROPIC_API_KEY"], "k");
        assert!(v["env"].get("OPENAI_API_KEY").is_none());
        assert!(v.get("model").is_none());
        assert!(v.get("modelProviders").is_none());
    }

    #[test]
    fn qwen_patch_model_providers_preserves_other_protocols() {
        let existing =
            r#"{"modelProviders": {"gemini": {"models": [{"id": "g1"}]}, "openai": {"extra": 1}}}"#;
        let mut p = profile("qwen");
        p.base_url = None;
        p.models = vec!["qwen3-coder".into()];
        let out = patch_qwen_settings(Some(existing), None, &p).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        // 其他协议原样保留，本协议的既有字段不清掉
        assert_eq!(v["modelProviders"]["gemini"]["models"][0]["id"], "g1");
        assert_eq!(v["modelProviders"]["openai"]["extra"], 1);
        let models = v["modelProviders"]["openai"]["models"].as_array().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["id"], "qwen3-coder");
        assert!(
            models[0].get("baseUrl").is_none(),
            "无 base_url 时不写该字段"
        );
    }

    #[test]
    fn qwen_global_write_keeps_users_own_model_entries() {
        // 规则 3：只管自己写的条目。以前整组换掉，用户自己配的 DashScope 模型被一起删了
        let existing = r#"{"modelProviders": {"openai": {"models": [
            {"id": "my-own", "envKey": "DASHSCOPE_API_KEY", "baseUrl": "https://dashscope"},
            {"id": "old-mesa", "envKey": "MESA_QWEN_API_KEY", "baseUrl": "https://old-relay"},
            {"id": "m1", "envKey": "OPENAI_API_KEY"}
        ]}}}"#;
        let p = profile("qwen");
        let out = patch_qwen_settings(Some(existing), Some("sk-new"), &p).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let ids: Vec<&str> = v["modelProviders"]["openai"]["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["m1", "my-own"], "这次的在前；上一份 Mesa 条目撤掉；同名的换成这次的");
        // 官方切回：Mesa 条目（指着被撤的 MESA_QWEN_API_KEY）撤掉，用户的留着，默认模型若是 Mesa 的一并撤
        let mut doc: Value = serde_json::from_str(&out).unwrap();
        doc["model"]["name"] = json!("m1");
        let off = patch_qwen_settings_official(&doc.to_string()).unwrap();
        let v: Value = serde_json::from_str(&off).unwrap();
        let ids: Vec<&str> = v["modelProviders"]["openai"]["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["my-own"]);
        assert!(v.pointer("/model/name").is_none());
    }

    #[test]
    fn opencode_patch_preserves_other_providers() {
        let existing = r#"{
          // jsonc 注释
          "provider": {"other": {"npm": "x"}, "ccode-old1": {"options": {"apiKey": "sk-old"}}},
          "small_model": "ccode-old1/tiny", "theme": "dark",
        }"#;
        let p = profile("opencode");
        let provider = agents::opencode_provider_json(&p, Some("sk-secret"), Some("m1"));
        let out = patch_opencode_config(Some(existing), provider, Some("m1"), None, "ccode-new2").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["provider"]["other"]["npm"], "x");
        assert!(v["provider"].get("ccode-old1").is_none(), "上一份 Mesa 渠道连同明文密钥撤掉");
        assert_eq!(v["provider"]["ccode-new2"]["npm"], "@ai-sdk/openai-compatible");
        assert_eq!(v["model"], "ccode-new2/m1");
        assert!(v.get("small_model").is_none(), "指着 Mesa 旧渠道的小模型撤掉");
        assert!(v.get("autoupdate").is_none(), "不改用户自己用 OpenCode 时的更新行为");
        assert_eq!(v["theme"], "dark");
    }

    #[test]
    fn grok_official_keeps_relay_sections_with_their_own_key() {
        // 会话记着 current_model_id：带自己密钥的中转段（Mesa 写的也算）留着，老会话还能续；没密钥的撤（防官方令牌发去中转）
        let existing = "api_key = \"sk-top\"\n\n[model.relay-a]\nname = \"测试 · relay-a\"\nbase_url = \"https://relay.example.com/v1\"\napi_key = \"sk-a\"\n\n[model.keyless]\nbase_url = \"https://relay.example.com/v1\"\n";
        let out = patch_grok_config_official(existing).unwrap();
        let doc: toml::Value = toml::from_str(&out).unwrap();
        assert!(doc.get("api_key").is_none());
        assert_eq!(doc["model"]["relay-a"]["api_key"].as_str(), Some("sk-a"));
        assert!(doc["model"].get("keyless").is_none());
    }

    #[test]
    fn opencode_keeps_old_mesa_providers_whose_key_file_exists() {
        // 老对话还要用：引用着的密钥文件在就留；文件没了的整份配置会加载失败（1.19.5 实测），撤
        let home = tmpdir("oc-keep");
        let alive = home.join("alive.key");
        fs::write(&alive, "sk-a").unwrap();
        let existing = json!({
            "provider": {
                "ccode-alive": {"options": {"apiKey": format!("{{file:{}}}", alive.to_string_lossy())}},
                "ccode-gone": {"options": {"apiKey": format!("{{file:{}}}", home.join("gone.key").to_string_lossy())}},
                "ccode-plain": {"options": {"apiKey": "sk-plain"}}
            }
        })
        .to_string();
        let p = profile("opencode");
        let provider = agents::opencode_provider_json(&p, None, Some("m1"));
        let out = patch_opencode_config(Some(&existing), provider, Some("m1"), None, "ccode-new2").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let keys: Vec<&String> = v["provider"].as_object().unwrap().keys().collect();
        assert!(keys.iter().any(|k| *k == "ccode-alive"));
        assert!(!keys.iter().any(|k| *k == "ccode-gone" || *k == "ccode-plain"));
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn kimi_writes_effort_for_kimi_protocol_and_clears_key_on_official() {
        let mut p = profile("kimi");
        p.protocol = Some("kimi".into());
        p.models = vec!["kimi-k3".into()];
        p.request_policy.reasoning_effort = Some("high".into());
        let pid = p.provider_name();
        let base = patch_kimi_config(None, "kimi", &p.name, Some("https://k/v1"), Some("sk"), &p.models, true, &pid, None).unwrap();
        let out = patch_kimi_effort(&base, &p, "kimi").unwrap();
        let doc: toml::Value = toml::from_str(&out).unwrap();
        assert_eq!(doc["models"]["kimi-k3"]["default_effort"].as_str(), Some("high"));
        // 只写 default_effort 不起作用，要连档位表一起声明
        let levels: Vec<_> = doc["models"]["kimi-k3"]["support_efforts"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
        assert!(levels.contains(&"high"));
        // 别的协议不写（Kimi 原样发给中转），写过的撤掉
        let other = patch_kimi_effort(&out, &p, "openai").unwrap();
        let doc: toml::Value = toml::from_str(&other).unwrap();
        assert!(doc["models"]["kimi-k3"].get("default_effort").is_none());
        // 官方切回：渠道、别名连同密钥留着（老会话按别名续，撤了密钥一续就失败）
        let off = patch_kimi_config_official(&out).unwrap();
        let doc: toml::Value = toml::from_str(&off).unwrap();
        assert_eq!(doc["providers"][&pid]["api_key"].as_str(), Some("sk"));
        assert!(doc["models"].get("kimi-k3").is_some());
        // Mesa 开的会话存的别名：全局里指到这次的连接
        let aliased = patch_kimi_env_alias(&out, &p, &pid).unwrap();
        let doc: toml::Value = toml::from_str(&aliased).unwrap();
        assert_eq!(doc["models"]["__kimi_env_model__"]["provider"].as_str(), Some(pid.as_str()));
        assert_eq!(doc["models"]["__kimi_env_model__"]["model"].as_str(), Some("kimi-k3"));
        // 还有别名指着旧版 ccode 渠道时不撤它
        let legacy = "[providers.ccode]\ntype = \"openai\"\n[models.old]\nprovider = \"ccode\"\nmodel = \"x\"\n";
        let kept = patch_kimi_config(Some(legacy), "kimi", &p.name, Some("https://k/v1"), Some("sk"), &p.models, true, &pid, None).unwrap();
        assert!(kept.contains("[providers.ccode]"));
    }

    /// CLI 金丝雀「全局配置」层（scripts/cli-canary）：按 Mesa 真实的设为全局写计划，把某家的配置写进
    /// E2E_GLOBAL_HOME（临时家目录），之后由脚本不经 Mesa 直接拉起 CLI，看假网关收到的模型和密钥是不是这条连接的。
    /// 写到家目录外的文件（Codex 模型目录）改放到临时家目录下，引用一并改写；不碰本机任何配置
    #[test]
    #[ignore]
    fn e2e_write_global_config() {
        let base = std::env::var("E2E_BASE").expect("E2E_BASE");
        let home = PathBuf::from(std::env::var("E2E_GLOBAL_HOME").expect("E2E_GLOBAL_HOME"));
        let agent = std::env::var("E2E_AGENT").expect("E2E_AGENT");
        // base_url 后缀同 agents::e2e_dump_launch_plans：Anthropic 协议不带 /v1，Gemini 由 CLI 拼 /v1beta
        let (proto, suffix) = match agent.as_str() {
            "claude-code" | "gemini" => (None, ""),
            "qwen" | "kimi" => (Some("openai"), "/v1"),
            _ => (None, "/v1"),
        };
        let mut p = profile(&agent);
        p.id = format!("e2e-global-{agent}");
        p.name = "E2E".into();
        p.base_url = Some(format!("{base}/{agent}{suffix}"));
        p.protocol = proto.map(Into::into);
        p.models = vec!["e2e-global".into()];
        let mut plans = plan_writes(&home, &p, Some("sk-e2e-global"), &p.models).expect("写计划");
        let moved: Vec<(String, PathBuf)> = plans
            .iter()
            .filter(|w| !w.path.starts_with(&home))
            .map(|w| {
                let to = home.join("mesa-config").join(w.path.file_name().unwrap());
                (w.path.to_string_lossy().into_owned(), to)
            })
            .collect();
        for w in plans.iter_mut() {
            for (from, to) in &moved {
                let to_s = to.to_string_lossy().into_owned();
                if w.path.to_string_lossy() == from.as_str() {
                    w.path = to.clone();
                }
                w.content = w
                    .content
                    // TOML / JSON 里 Windows 路径的反斜杠是转义过的，两种写法都换
                    .replace(&from.replace('\\', "\\\\"), &to_s.replace('\\', "\\\\"))
                    .replace(from.as_str(), &to_s);
            }
        }
        let mut written = Vec::new();
        for w in &plans {
            fs::create_dir_all(w.path.parent().unwrap()).unwrap();
            fs::write(&w.path, &w.content).unwrap();
            written.push(w.path.to_string_lossy().into_owned());
        }
        println!("E2E_GLOBAL_WRITTEN {}", serde_json::to_string(&written).unwrap());
    }

    #[test]
    fn override_notes_name_only_exported_shell_vars() {
        let has = |v: &str| matches!(v, "GEMINI_MODEL" | "GROK_DEFAULT_MODEL");
        let gemini = override_notes_with("gemini", &has);
        assert!(gemini[0].contains("GEMINI_MODEL") && !gemini[0].contains("GEMINI_API_KEY"), "{gemini:?}");
        assert!(gemini.iter().any(|n| n.contains(".env")), "Gemini 的 .env 只读一份要说");
        assert!(override_notes_with("grok", &has)[0].contains("GROK_DEFAULT_MODEL"));
        assert!(override_notes_with("kimi", &has).is_empty(), "没导出的不报");
    }

    #[test]
    fn opencode_plan_uses_key_file_ref_and_jsonc_when_present() {
        let home = tmpdir("opencode-plan");
        let dir = home.join(".config/opencode");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("opencode.jsonc"), "{ // mine\n \"theme\": \"x\" }").unwrap();
        let mut p = profile("opencode");
        p.models = vec!["m1".into()];
        p.request_policy.header_env.insert("X-Org".into(), "ORG_TOKEN".into());
        let plans = plan_writes(&home, &p, Some("sk-plain"), &p.models).unwrap();
        let key = plans.iter().find(|w| w.tag == "opencode-key").unwrap();
        assert_eq!(key.content, "sk-plain");
        let cfg = plans.iter().find(|w| w.tag == "opencode.jsonc").expect("有 .jsonc 就写它");
        assert!(!cfg.content.contains("sk-plain"), "opencode 配置里不出明文密钥");
        let v: Value = serde_json::from_str(&cfg.content).unwrap();
        let pid = p.provider_name();
        assert_eq!(v["provider"][&pid]["options"]["apiKey"], format!("{{file:{}}}", key.path.to_string_lossy()));
        assert_eq!(v["provider"][&pid]["options"]["headers"]["X-Org"], "{env:ORG_TOKEN}");
        assert_eq!(v["theme"], "x");
        // 预览不出密钥值
        let preview = preview_plans(&home, "opencode", &plans, vec![], vec![]);
        let shown: Vec<_> = preview.files.iter().flat_map(|f| f.changes.iter().filter_map(|c| c.after.clone())).collect();
        assert!(!shown.iter().any(|a| a.contains("sk-plain")), "{shown:?}");
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn codebuddy_patch_writes_env_block_and_preserves_rest() {
        let existing = r#"{"env": {"OTHER": "1"}, "theme": "dark"}"#;
        let out = patch_codebuddy_settings(
            Some(existing),
            Some("https://api.deepseek.com/anthropic"),
            Some("sk-secret"),
            Some("deepseek-v3-2-volc"),
            Some(8192),
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["env"]["CODEBUDDY_BASE_URL"],
            "https://api.deepseek.com/anthropic"
        );
        assert_eq!(v["env"]["CODEBUDDY_API_KEY"], "sk-secret");
        assert_eq!(v["env"]["CODEBUDDY_MODEL"], "deepseek-v3-2-volc");
        assert_eq!(v["env"]["CODEBUDDY_CODE_MAX_OUTPUT_TOKENS"], "8192");
        assert_eq!(v["env"]["OTHER"], "1", "无关 env 必须保留");
        assert_eq!(v["theme"], "dark", "无关字段必须保留");
        // 缺省（文件不存在）：只创建 env 块
        let out = patch_codebuddy_settings(None, None, Some("sk-secret"), None, None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["CODEBUDDY_API_KEY"], "sk-secret");
        assert!(v["env"].get("CODEBUDDY_BASE_URL").is_none());
        // 上一条连接的地址 / 模型 / 输出上限这次没有就撤，不跟着新密钥一起生效
        let prev = r#"{"env":{"CODEBUDDY_BASE_URL":"https://old","CODEBUDDY_MODEL":"old-m","CODEBUDDY_CODE_MAX_OUTPUT_TOKENS":"1"}}"#;
        let v: Value = serde_json::from_str(&patch_codebuddy_settings(Some(prev), None, Some("sk"), None, None).unwrap()).unwrap();
        for k in ["CODEBUDDY_BASE_URL", "CODEBUDDY_MODEL", "CODEBUDDY_CODE_MAX_OUTPUT_TOKENS"] {
            assert!(v["env"].get(k).is_none(), "{k}");
        }
    }

    #[test]
    fn codebuddy_models_json_owns_only_mesa_entries() {
        let mut p = profile("codebuddy");
        p.base_url = Some("https://gw.example/v1/".into());
        p.models = vec!["glm-5".into(), "kimi-k3".into()];
        let existing = r#"{"availableModels":["glm-5"],"models":[
            {"id":"old","name":"旧连接 · old","apiKey":"${CODEBUDDY_API_KEY}","url":"https://old/chat/completions"},
            {"id":"mine","name":"我的","apiKey":"${MY_KEY}","url":"https://mine/chat/completions"},
            {"id":"glm-5","name":"手写同名","url":"https://x"}
        ]}"#;
        let v: Value = serde_json::from_str(&patch_codebuddy_models(Some(existing), &p).unwrap()).unwrap();
        let ids: Vec<_> = v["models"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["mine", "glm-5", "kimi-k3"], "上一份 Mesa 条目撤、同 id 由这次接管、用户条目留");
        let glm = &v["models"][1];
        assert_eq!(glm["url"], "https://gw.example/v1/chat/completions");
        assert_eq!(glm["apiKey"], "${CODEBUDDY_API_KEY}");
        assert_eq!(glm["name"], "测试 · glm-5");
        assert_eq!(v["availableModels"], json!(["glm-5"]), "用户的下拉过滤不动");
        // 官方切回：Mesa 条目撤，用户条目留
        let off: Value = serde_json::from_str(&patch_codebuddy_models_official(&v.to_string()).unwrap()).unwrap();
        let ids: Vec<_> = off["models"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["mine"]);
    }

    #[test]
    fn kimi_patch_writes_alias_table_per_model() {
        let existing = "[providers.other]\ntype = \"openai\"\n";
        let out = patch_kimi_config(
            Some(existing),
            "kimi",
            "Zetatechs",
            Some("https://api.moonshot.cn/v1"),
            Some("sk-secret"),
            &[
                "kimi-k3".into(),
                "kimi.k2.5 turbo".into(),
                "deepseek-chat".into(),
            ],
            true,
            "ccode",
            None,
        )
        .unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["providers"]["other"]["type"].as_str(), Some("openai"));
        let ccode = &doc["providers"]["ccode"];
        assert_eq!(ccode["type"].as_str(), Some("kimi"));
        assert_eq!(
            ccode["base_url"].as_str(),
            Some("https://api.moonshot.cn/v1")
        );
        assert_eq!(ccode["api_key"].as_str(), Some("sk-secret"));
        // 每个模型一个 [models.<alias>] 表；非法字符清洗为 _
        assert_eq!(doc["models"]["kimi-k3"]["provider"].as_str(), Some("ccode"));
        assert_eq!(doc["models"]["kimi-k3"]["model"].as_str(), Some("kimi-k3"));
        // 0.31+ 必填 max_context_size：k3 = 1M；「kimi.k2.5 turbo」统一写法后认作 k2.5 系（256K，2026-10-28 能力库点号当横杠），
        // 真不认识的（deepseek-chat 内置表没给上下文）= 128K 保守默认
        assert_eq!(
            doc["models"]["kimi-k3"]["max_context_size"].as_integer(),
            Some(1_048_576)
        );
        assert_eq!(
            doc["models"]["kimi_k2_5_turbo"]["max_context_size"].as_integer(),
            Some(262_144)
        );
        assert_eq!(
            doc["models"]["deepseek-chat"]["max_context_size"].as_integer(),
            Some(131_072)
        );
        assert_eq!(
            doc["models"]["kimi_k2_5_turbo"]["model"].as_str(),
            Some("kimi.k2.5 turbo")
        );
        // display_name 用 profile 名 + 模型名（选择器 label 优先 display_name）
        assert_eq!(
            doc["models"]["kimi-k3"]["display_name"].as_str(),
            Some("Zetatechs · kimi-k3")
        );
        // 推断为思考模型的写 capabilities；普通模型不写（走 CLI registry 默认）
        let caps = &doc["models"]["kimi-k3"]["capabilities"];
        assert_eq!(
            caps.as_array().map(|a| a.len()),
            Some(3),
            "kimi-k3 应声明 tool_use + thinking + image_in（多模态思考）"
        );
        assert_eq!(
            doc["models"]["kimi-k3"]["capabilities"][1].as_str(),
            Some("thinking")
        );
        assert_eq!(
            doc["models"]["kimi-k3"]["capabilities"][2].as_str(),
            Some("image_in")
        );
        assert!(doc["models"]["deepseek-chat"].get("capabilities").is_none());
        // default_model = 首个模型的别名
        assert_eq!(doc["default_model"].as_str(), Some("kimi-k3"));
    }

    #[test]
    fn kimi_patch_without_models_keeps_single_ccode_alias() {
        let out =
            patch_kimi_config(None, "openai", "P", None, None, &[], true, "ccode", None).unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["providers"]["ccode"]["type"].as_str(), Some("openai"));
        assert_eq!(doc["models"]["ccode"]["provider"].as_str(), Some("ccode"));
        assert_eq!(
            doc["models"]["ccode"]["max_context_size"].as_integer(),
            Some(131_072)
        );
        assert_eq!(doc["default_model"].as_str(), Some("ccode"));
    }

    #[test]
    fn kimi_patch_legacy_variant_omits_context_size() {
        // 旧版 kimi-cli（~/.kimi）：不写 max_context_size/display_name/capabilities，
        // 防止老版本解析未知字段报错
        let out = patch_kimi_config(
            None,
            "kimi",
            "P",
            None,
            None,
            &["kimi-k3".into()],
            false,
            "ccode",
            None,
        )
        .unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert!(doc["models"]["kimi-k3"].get("max_context_size").is_none());
        assert!(doc["models"]["kimi-k3"].get("display_name").is_none());
        assert!(doc["models"]["kimi-k3"].get("capabilities").is_none());
    }

    #[test]
    fn kimi_alias_sanitizes_to_bare_key_charset() {
        assert_eq!(kimi_model_alias("kimi-k2"), "kimi-k2");
        assert_eq!(kimi_model_alias("a.b/c d"), "a_b_c_d");
    }

    #[test]
    fn grok_config_patch_writes_and_preserves() {
        // 既有 [mcp_servers] 段与外来键原样保留；写入面 = 逐模型 api_key（顶层旧 api_key 撤掉）+
        // [endpoints].models_base_url + [models].default/策略全局默认；白名单并进绑定模型
        let existing = "api_key = \"old\"\ntheme = \"dark\"\n\n[mcp_servers.fs]\ncommand = \"npx\"\n\n[models]\nallowed_models = [\"grok-4.5\"]\n";
        let mut p = profile("grok");
        p.models = vec!["grok-code-fast-1".into()];
        p.request_policy.temperature = Some(0.7);
        p.request_policy.top_p = Some(0.95);
        p.request_policy.max_output_tokens = Some(8192);
        p.request_policy.reasoning_effort = Some("high".into());
        p.request_policy
            .header_env
            .insert("X-Tenant".into(), "TENANT_TOKEN".into());
        let out = patch_grok_config(Some(existing), Some("xai-secret"), &p).unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert!(doc.get("api_key").is_none(), "顶层 api_key Grok 不读，不写");
        assert_eq!(doc["model"]["grok-code-fast-1"]["api_key"].as_str(), Some("xai-secret"));
        assert_eq!(
            doc["endpoints"]["models_base_url"].as_str(),
            Some("https://relay.example.com")
        );
        let models = &doc["models"];
        assert_eq!(models["default"].as_str(), Some("grok-code-fast-1"));
        assert_eq!(models["temperature"].as_float(), Some(0.7));
        assert_eq!(models["top_p"].as_float(), Some(0.95));
        assert_eq!(models["max_completion_tokens"].as_integer(), Some(8192));
        assert_eq!(models["default_reasoning_effort"].as_str(), Some("high"));
        // Header 是 $VAR 引用（grok 读盘时展开），密文不落盘
        assert_eq!(
            models["extra_headers"]["X-Tenant"].as_str(),
            Some("$TENANT_TOKEN")
        );
        // 用户既有内容一律不动
        assert_eq!(doc["theme"].as_str(), Some("dark"));
        assert_eq!(doc["mcp_servers"]["fs"]["command"].as_str(), Some("npx"));
        // allowed_models 属用户选择器过滤，不接管；只并进默认模型（不在名单里 Grok 拒绝启动）
        let allowed: Vec<_> = models["allowed_models"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(allowed, ["grok-4.5", "grok-code-fast-1"]);
        // 每个绑定模型都建段并写推理菜单（中转目录不带档位时 /effort 才出得来）
        let entry = &doc["model"]["grok-code-fast-1"];
        assert_eq!(entry["supports_reasoning_effort"].as_bool(), Some(true));
        assert_eq!(entry["reasoning_effort"].as_str(), Some("high"));
        let efforts = entry["reasoning_efforts"].as_array_of_tables().unwrap();
        assert_eq!(efforts.len(), 4);
        assert_eq!(efforts.get(0).unwrap()["value"].as_str(), Some("xhigh"));
        assert_eq!(efforts.get(1).unwrap()["value"].as_str(), Some("high"));
        assert_eq!(efforts.get(1).unwrap()["default"].as_bool(), Some(true));
        assert_eq!(efforts.get(3).unwrap()["value"].as_str(), Some("low"));
        // 斜杠串不是一个档位，不能写进 default_reasoning_effort（Grok 会拒启动）
        p.request_policy.reasoning_effort = Some("hign/xhign".into());
        let out = patch_grok_config(Some(existing), Some("xai-secret"), &p).unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert!(doc["models"].get("default_reasoning_effort").is_none());
    }

    #[test]
    fn grok_relay_write_points_title_model_at_this_connection() {
        let mut p = profile("grok");
        p.base_url = Some("https://relay.example.com/v1".into());
        p.models = vec!["glm-5".into(), "glm-5-flash".into()];
        let out = patch_grok_config(Some("[models]\nsession_summary = \"other-relay-claude\"\n"), Some("sk"), &p).unwrap();
        let d: toml::Value = toml::from_str(&out).unwrap();
        assert_eq!(d["models"]["session_summary"].as_str(), Some("glm-5"));
        assert_eq!(d["models"]["prompt_suggestion"].as_str(), Some("glm-5"));
        p.role_models.small = Some("glm-5-flash".into());
        let d: toml::Value = toml::from_str(&patch_grok_config(None, Some("sk"), &p).unwrap()).unwrap();
        assert_eq!(d["models"]["session_summary"].as_str(), Some("glm-5-flash"));
        // xAI 官方地址不动
        p.base_url = Some("https://api.x.ai/v1".into());
        let d: toml::Value = toml::from_str(&patch_grok_config(Some("[models]\nsession_summary = \"grok-4.6\"\n"), Some("sk"), &p).unwrap()).unwrap();
        assert_eq!(d["models"]["session_summary"].as_str(), Some("grok-4.6"));
    }

    #[test]
    fn grok_config_patch_set_only_never_removes_user_keys() {
        // [models] 是通用键表：策略未设时只设不删——用户手写的 temperature 保留
        //（过期 Mesa 值靠「撤销上次写入/恢复初始状态」兜底，不靠静默删除）
        let existing = "[models]\ntemperature = 0.3\ndefault = \"grok-4.5\"\n";
        let mut p = profile("grok");
        p.models = vec!["grok-code-fast-1".into()];
        let out = patch_grok_config(Some(existing), Some("xai-secret"), &p).unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["models"]["temperature"].as_float(), Some(0.3));
        assert_eq!(doc["models"]["default"].as_str(), Some("grok-code-fast-1"));
        assert!(doc["models"].get("top_p").is_none());
        assert!(doc["models"].get("extra_headers").is_none());
        // 无 base_url / 无密钥 / 无模型时不建对应键
        p.base_url = None;
        p.models = vec![];
        let out = patch_grok_config(None, None, &p).unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert!(doc.get("api_key").is_none());
        assert!(doc.get("endpoints").is_none());
    }

    #[test]
    fn grok_config_patch_writes_per_model_sections_with_api_backend() {
        // 绑定设了 API 后端 → 逐模型建 [model.<id>] 段（api_backend + name）；
        // 含 / 的模型 id 依赖 toml_edit 自动加引号，round-trip 解析验证合法且键名原样
        let mut p = profile("grok");
        p.name = "我的中转".into();
        p.models = vec!["openai/gpt-5.1".into(), "grok-4.5".into()];
        p.api_backend = Some("responses".into());
        let existing = "[model.\"openai/gpt-5.1\"]\ndescription = \"用户手写\"\n";
        let out = patch_grok_config(Some(existing), Some("xai-secret"), &p).unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        let gpt = &doc["model"]["openai/gpt-5.1"];
        assert_eq!(gpt["api_backend"].as_str(), Some("responses"));
        assert_eq!(gpt["name"].as_str(), Some("我的中转 · openai/gpt-5.1"));
        // 用户手写的同段其他字段不动
        assert_eq!(gpt["description"].as_str(), Some("用户手写"));
        assert_eq!(
            doc["model"]["grok-4.5"]["api_backend"].as_str(),
            Some("responses")
        );
        // 权威层（用户覆盖/网关实测）在测试环境为空 → 不写 context_window
        assert!(gpt.get("context_window").is_none());
        assert_eq!(gpt["supports_reasoning_effort"].as_bool(), Some(true));
        assert_eq!(
            gpt["reasoning_efforts"]
                .as_array_of_tables()
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn grok_config_patch_keeps_existing_reasoning_menu() {
        // 手写菜单与显式关闭不覆盖；缺菜单的模型仍补上
        let existing = "\
[model.\"grok-4.7\"]
supports_reasoning_effort = true
reasoning_effort = \"low\"

[[model.\"grok-4.7\".reasoning_efforts]]
value = \"low\"
label = \"Low\"

[model.\"no-think\"]
supports_reasoning_effort = false
";
        let mut p = profile("grok");
        p.models = vec!["grok-4.7".into(), "no-think".into(), "fresh".into()];
        let out = patch_grok_config(Some(existing), None, &p).unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        let kept = doc["model"]["grok-4.7"]["reasoning_efforts"]
            .as_array_of_tables()
            .unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept.get(0).unwrap()["value"].as_str(), Some("low"));
        assert_eq!(
            doc["model"]["grok-4.7"]["reasoning_effort"].as_str(),
            Some("low")
        );
        // 中转目录的显式 false 会压掉菜单，设为全局时改回 true 并补档位
        assert_eq!(
            doc["model"]["no-think"]["supports_reasoning_effort"].as_bool(),
            Some(true)
        );
        assert_eq!(
            doc["model"]["no-think"]["reasoning_efforts"]
                .as_array_of_tables()
                .unwrap()
                .len(),
            4
        );
        assert_eq!(
            doc["model"]["fresh"]["reasoning_efforts"]
                .as_array_of_tables()
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn grok_plan_writes_targets_grok_config_toml() {
        let home = tmpdir("grok-plan");
        let p = profile("grok");
        let plans = plan_writes(&home, &p, Some("xai-secret"), &["m1".to_string()]).unwrap();
        assert_eq!(plans.len(), 1);
        assert!(plans[0].path.ends_with(".grok/config.toml"));
        let doc: toml::Value = toml::from_str(&plans[0].content).unwrap();
        assert_eq!(doc["model"]["m1"]["api_key"].as_str(), Some("xai-secret"));
        assert!(doc.get("api_key").is_none());
        assert!(plans[0].content.contains("models_base_url"));
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn kimi_plan_writes_existing_variant_dirs() {
        let home = tmpdir("kimi-dirs");
        let p = profile("kimi");
        // 都不存在 → 只写新版目录
        let plans = plan_writes(&home, &p, None, &["m1".to_string()]).unwrap();
        assert_eq!(plans.len(), 1);
        assert!(plans[0].path.ends_with(".kimi-code/config.toml"));
        // 只有旧版目录 → 只写旧版
        fs::create_dir_all(home.join(".kimi")).unwrap();
        let plans = plan_writes(&home, &p, None, &["m1".to_string()]).unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].tag, "legacy-config.toml");
        assert!(plans[0].content.contains("max_context_size"), "旧版官方文档同样要求 max_context_size");
        // 两者都有 → 都写
        fs::create_dir_all(home.join(".kimi-code")).unwrap();
        let plans = plan_writes(&home, &p, None, &["m1".to_string()]).unwrap();
        assert_eq!(plans.len(), 2);
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn apply_creates_backup_and_restore_brings_back_newest() {
        let home = tmpdir("apply-home");
        let backups = tmpdir("apply-bak");
        let target_dir = home.join(".claude");
        fs::create_dir_all(&target_dir).unwrap();
        let target = target_dir.join("settings.json");
        fs::write(&target, r#"{"env": {"OTHER": "1"}}"#).unwrap();

        let p = profile("claude-code");
        let plans = plan_writes(&home, &p, Some("sk-secret"), &["m1".to_string()]).unwrap();
        let written = apply_plans(&backups, &home, &plans).unwrap();
        assert_eq!(written, vec!["~/.claude/settings.json".to_string()]);
        // 原文件被备份，新内容已写入
        let baks = list_backups(&backups, "settings.json");
        assert_eq!(baks.len(), 1);
        let new_content = fs::read_to_string(&target).unwrap();
        assert!(new_content.contains("ANTHROPIC_AUTH_TOKEN"));
        // 再改一次并重新应用：第二批清单记录 v2，restore 应按完整批次恢复它
        fs::write(&target, r#"{"v": 2}"#).unwrap();
        let plans = plan_writes(&home, &p, Some("sk-secret-2"), &["m1".to_string()]).unwrap();
        apply_plans(&backups, &home, &plans).unwrap();
        let restored = restore_from(&backups, &home, "claude-code").unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(fs::read_to_string(&target).unwrap(), r#"{"v": 2}"#);
        // 恢复前的当前状态也生成一批备份；原恢复点不会被消费，可再次恢复撤销本次操作
        assert!(list_backups(&backups, "settings.json").len() >= 3);
        assert!(manifest_files(&backups).len() >= 3);
        fs::remove_dir_all(&home).ok();
        fs::remove_dir_all(&backups).ok();
    }

    #[test]
    fn transaction_rolls_back_all_targets_when_later_replace_fails() {
        let dir = tmpdir("rollback");
        let a = dir.join("a.json");
        let b = dir.join("b.json");
        fs::write(&a, "old-a").unwrap();
        fs::write(&b, "old-b").unwrap();
        let actions = vec![
            TxAction {
                tag: "a".into(),
                path: a.clone(),
                content: Some(b"new-a".to_vec()),
            },
            TxAction {
                tag: "b".into(),
                path: b.clone(),
                content: Some(b"new-b".to_vec()),
            },
        ];
        let id = batch_id();
        let originals = actions
            .iter()
            .map(|a| fs::read(&a.path).ok())
            .collect::<Vec<_>>();
        let staged = stage_actions(&actions, &id).unwrap();
        let err = commit_actions_with(&actions, &staged, &originals, &id, |from, to, i| {
            if i == 1 {
                Err(std::io::Error::other("injected failure"))
            } else {
                fs::rename(from, to)
            }
        })
        .unwrap_err();
        assert!(err.contains("已自动回滚全部目标文件"), "{err}");
        assert_eq!(fs::read_to_string(&a).unwrap(), "old-a");
        assert_eq!(fs::read_to_string(&b).unwrap(), "old-b");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_removes_file_that_did_not_exist_before_apply() {
        let home = tmpdir("restore-absent-home");
        let backups = tmpdir("restore-absent-bak");
        let target = home.join(".gemini/.env");
        let p = profile("gemini");
        let plans = plan_writes(&home, &p, Some("secret"), &["m1".to_string()]).unwrap();
        apply_plans(&backups, &home, &plans).unwrap();
        assert!(target.exists());
        restore_from(&backups, &home, "gemini").unwrap();
        assert!(!target.exists(), "应用前不存在的文件恢复时应被移除");
        fs::remove_dir_all(&home).ok();
        fs::remove_dir_all(&backups).ok();
    }

    #[test]
    fn original_snapshot_survives_rotations_and_restores_first_write_state() {
        let home = tmpdir("orig-home");
        let backups = tmpdir("orig-bak");
        let target_dir = home.join(".claude");
        fs::create_dir_all(&target_dir).unwrap();
        let target = target_dir.join("settings.json");
        // Mesa 动手前的原始内容
        fs::write(&target, r#"{"env": {"OTHER": "1"}}"#).unwrap();
        let p = profile("claude-code");
        // 连续 7 次 apply：常规批次窗口（5 份）被烧穿，原始快照必须始终在场
        for _ in 0..7 {
            let plans = plan_writes(&home, &p, Some("sk-secret"), &["m1".to_string()]).unwrap();
            apply_plans(&backups, &home, &plans).unwrap();
        }
        assert!(list_backups(&backups, "settings.json").len() <= 5);
        assert_eq!(
            fs::read_to_string(original_dir(&backups).join("settings.json")).unwrap(),
            r#"{"env": {"OTHER": "1"}}"#,
            "原始快照必须保持首次写入前的内容"
        );
        // 恢复初始状态 = 回到首次写入前
        restore_from_original(&backups, &home).unwrap();
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            r#"{"env": {"OTHER": "1"}}"#
        );
        // 原始快照不被恢复动作消耗，可再次恢复
        assert!(original_dir(&backups).join("manifest.json").is_file());
        fs::remove_dir_all(&home).ok();
        fs::remove_dir_all(&backups).ok();
    }

    #[test]
    fn restore_original_removes_file_created_by_first_apply() {
        let home = tmpdir("orig-absent-home");
        let backups = tmpdir("orig-absent-bak");
        let target = home.join(".gemini/.env");
        let p = profile("gemini");
        let plans = plan_writes(&home, &p, Some("secret"), &["m1".to_string()]).unwrap();
        apply_plans(&backups, &home, &plans).unwrap();
        assert!(target.exists());
        restore_from_original(&backups, &home).unwrap();
        assert!(
            !target.exists(),
            "首次写入前不存在的文件，恢复初始状态时应删除"
        );
        fs::remove_dir_all(&home).ok();
        fs::remove_dir_all(&backups).ok();
    }

    #[test]
    fn backup_rotation_keeps_newest_five() {
        let dir = tmpdir("rotation");
        let target = dir.join("f.json");
        fs::write(&target, "{}").unwrap();
        for i in 0..7 {
            backup_file_with_ts(&dir, "f.json", &target, &format!("2026010{i}-000000")).unwrap();
        }
        let mut baks = list_backups(&dir, "f.json");
        baks.sort();
        assert_eq!(baks.len(), 5);
        assert_eq!(baks[0], "f.json.20260102-000000.bak");
        assert_eq!(baks[4], "f.json.20260106-000000.bak");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn timestamp_formats_utc() {
        let (y, m, d) = civil_from_days(20454); // 2026-01-01
        assert_eq!((y, m, d), (2026, 1, 1));
        assert_eq!(timestamp_now().len(), 15); // yyyymmdd-hhmmss
    }

    #[test]
    fn disk_matches_plans_uses_json_subset_not_full_trim() {
        let dir = tmpdir("dry-subset");
        let path = dir.join("settings.json");
        fs::write(
            &path,
            "{\n  \"env\": {\"A\": \"1\"},\n  \"theme\": \"dark\"\n}\n",
        )
        .unwrap();
        let planned = PlannedWrite {
            tag: "settings.json",
            path: path.clone(),
            content: "{\"env\":{\"A\":\"1\"}}".into(),
        };
        assert!(disk_matches_plans(&[planned]), "CLI 多出来的键不算漂移");
        fs::write(&path, "{\"env\":{\"A\":\"2\"}}").unwrap();
        let planned2 = PlannedWrite {
            tag: "settings.json",
            path,
            content: "{\"env\":{\"A\":\"1\"}}".into(),
        };
        assert!(!disk_matches_plans(&[planned2]));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preview_lists_removed_claude_slots_and_redacts_token() {
        let dir = tmpdir("preview-claude");
        let path = dir.join(".claude/settings.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{
          "env": {
            "ANTHROPIC_MODEL": "old-default",
            "ANTHROPIC_AUTH_TOKEN": "sk-secret-abcdef",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "m1",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "m2",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "m3"
          }
        }"#,
        )
        .unwrap();
        let planned = pc(
            Some(&fs::read_to_string(&path).unwrap()),
            None,
            Some("sk-secret-abcdef"),
            &["only-one".to_string()],
            None,
            None,
        )
        .unwrap();
        let preview = preview_plans(
            &dir,
            "claude-code",
            &[PlannedWrite {
                tag: "settings.json",
                path: path.clone(),
                content: planned,
            }],
            vec![],
            vec![],
        );
        assert_eq!(preview.files.len(), 1);
        assert_eq!(preview.files[0].action, "modify");
        assert!(preview.files[0]
            .changes
            .iter()
            .any(|c| { c.path == "env.ANTHROPIC_MODEL" && c.op == "remove" }));
        assert!(preview.files[0]
            .changes
            .iter()
            .any(|c| { c.path == "env.ANTHROPIC_DEFAULT_OPUS_MODEL" && c.op == "modify" }));
        let token = preview.files[0]
            .changes
            .iter()
            .find(|c| c.path.contains("AUTH_TOKEN"));
        if let Some(c) = token {
            assert_eq!(c.after.as_deref(), Some("（已脱敏）"));
        }
        assert!(preview.restart_note.contains("新开"));
        assert!(preview.scope_note.contains("不会改 Mesa 启动栏"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skipped_policy_notes_cover_tui_and_extra_env() {
        let mut p = profile("kimi");
        p.protocol = Some("openai".into());
        p.request_policy.reasoning_effort = Some("high".into());
        p.extra_env
            .insert("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into());
        let notes = skipped_policy_notes(&p);
        assert!(notes.iter().any(|n| n.contains("思考档")));
        assert!(notes.iter().any(|n| n.contains("附加环境变量")));
    }
}
