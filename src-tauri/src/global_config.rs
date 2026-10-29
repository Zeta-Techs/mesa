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
        fs::read_to_string(home.join(".codex/config.toml")).ok()
    } else {
        None
    };
    set_global_conflict_reason(agent, cc, live.as_deref()).map(str::to_string)
}

#[tauri::command]
pub fn set_global_conflict(agent: String) -> Option<String> {
    set_global_conflict_message(&agent)
}

/// 每个 agent 的全局配置目标文件（tag, 相对 home 路径），restore/has_backup 共用
fn target_specs(agent: &str) -> Vec<(&'static str, &'static str)> {
    match agent {
        "claude-code" => vec![("settings.json", ".claude/settings.json")],
        "codex" => vec![
            ("config.toml", ".codex/config.toml"),
            // 仅给旧批次恢复用：v3.249 起「设为全局」不再写 auth.json。
            // 清单恢复按当时写过的文件走；无清单回落仍可能碰到旧 auth.json 备份。
            ("auth.json", ".codex/auth.json"),
        ],
        "gemini" => vec![
            (".env", ".gemini/.env"),
            // 光有 .env 不够：gemini ≥0.46 在 base URL 存在时把 env 推断为 gateway 认证，
            // validateAuthMethod 不认 → headless 直接报 auth 错起不来；必须落
            // settings.json 的 selectedType="gemini-api-key"（cc-switch 同口径，审计实证）
            ("settings.json", ".gemini/settings.json"),
        ],
        "qwen" => vec![("settings.json", ".qwen/settings.json")],
        "opencode" => vec![("opencode.json", ".config/opencode/opencode.json")],
        "codebuddy" => vec![("settings.json", ".codebuddy/settings.json")],
        "kimi" => vec![
            ("config.toml", ".kimi-code/config.toml"),
            ("legacy-config.toml", ".kimi/config.toml"),
        ],
        "grok" => vec![("config.toml", ".grok/config.toml")],
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

fn patch_claude_settings(
    existing: Option<&str>,
    base_url: Option<&str>,
    key: Option<&str>,
    models: &[String],
    gateway_id: Option<&str>,
    effort: Option<&str>,
) -> Result<String, String> {
    let mut v = parse_json_doc(existing)?;
    let env = ensure_obj(&mut v, &["env"])?;
    if let Some(u) = base_url {
        env.insert("ANTHROPIC_BASE_URL".into(), json!(u));
    }
    if let Some(k) = key {
        env.insert("ANTHROPIC_AUTH_TOKEN".into(), json!(k));
    }
    if let Some(m) = models.first() {
        env.insert("ANTHROPIC_MODEL".into(), json!(m));
    } else {
        env.remove("ANTHROPIC_MODEL");
    }
    // 与注入模式一致：模型列表注册进 /model 选择器（前 4 个别名槽 + 第 5 个自定义槽）。
    // Mesa 管理的槽必须完整替换：名单变短或变空时清掉上一份配置留下的槽。
    const SLOTS: [&str; 4] = ["SONNET", "OPUS", "HAIKU", "FABLE"];
    for (i, slot) in SLOTS.iter().enumerate() {
        if let Some(m) = models.get(i) {
            env.insert(format!("ANTHROPIC_DEFAULT_{slot}_MODEL"), json!(m));
            env.insert(format!("ANTHROPIC_DEFAULT_{slot}_MODEL_NAME"), json!(m));
        } else {
            env.remove(&format!("ANTHROPIC_DEFAULT_{slot}_MODEL"));
            env.remove(&format!("ANTHROPIC_DEFAULT_{slot}_MODEL_NAME"));
        }
    }
    if let Some(fifth) = models.get(4) {
        env.insert("ANTHROPIC_CUSTOM_MODEL_OPTION".into(), json!(fifth));
        env.insert("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".into(), json!(fifth));
    } else {
        env.remove("ANTHROPIC_CUSTOM_MODEL_OPTION");
        env.remove("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME");
    }
    // claude 对不认识的第三方模型按 200K 上下文假设；注册表确知更大的（如 kimi-k3 1M）
    // 必须显式写 CLAUDE_CODE_MAX_CONTEXT_TOKENS，否则长会话提前 compact（cc-switch 同口径）。
    // AUTO_COMPACT_WINDOW（auto-compact 触发点的窗口基数）与上限同值成对管理——
    // 只抬上限不抬它，压缩触发点仍留在旧窗口档。不需要时两键都清：随「设为全局」
    // 归 Mesa 管，留着过期大值比没有更有害。
    //
    // 用 declared 视图：门限 >200K 意味着未声明（含 128K 保守默认）本来就走清理分支，
    // 两视图对现有模型行为完全一致；区别只在语义——不再拿估值冒充「注册表确知」。
    let max_ctx = models.first().and_then(|m| {
        crate::model_registry::model_context_size_declared_for(m, gateway_id)
    });
    match max_ctx {
        Some(ctx) if ctx > 200_000 => {
            env.insert(
                "CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(),
                json!(ctx.to_string()),
            );
            env.insert(
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(),
                json!(ctx.to_string()),
            );
        }
        _ => {
            env.remove("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
            env.remove("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
        }
    }
    if let Some(e) = effort.filter(|s| !s.is_empty()) {
        env.insert("CLAUDE_CODE_EFFORT_LEVEL".into(), json!(e));
    } else {
        env.remove("CLAUDE_CODE_EFFORT_LEVEL");
    }
    // Remove the legacy Mesa subagent override when updating a global profile.
    env.remove("CLAUDE_CODE_SUBAGENT_MODEL");
    // 别家留下的连接键（另一把 ANTHROPIC_API_KEY、请求头、Bedrock 等协议开关……）撤掉：留着会和这次写的
    // 地址、令牌一起生效（2026-10-28 假网关实测两把密钥同时发出）。长期登录令牌 CLAUDE_CODE_OAUTH_TOKEN 不动——
    // 它是官方账号的登录方式，API 令牌在时它不起作用
    let mesa_keys = mesa_claude_env_keys();
    let stale: Vec<String> = env
        .keys()
        .filter(|k| {
            agents::claude_connection_env_key(k)
                && !k.starts_with("CLAUDE_CODE_OAUTH_")
                && !mesa_keys.contains(k.as_str())
        })
        .cloned()
        .collect();
    for k in stale {
        env.remove(&k);
    }
    if let Some(o) = v.as_object_mut() {
        o.remove("apiKeyHelper");
    }
    // 不写 CLAUDE_CODE_SUBAGENT_MODEL：Claude Code 默认让 Task 子 agent 继承主模型，
    // 同时保留 Task 参数/frontmatter 的原生覆盖能力。写入该环境变量会压过这些选择，
    // 使子 agent 被错误固定到绑定列表中的某个模型。
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

/// patch_claude_settings 自己管的 env 键（写或按需清）：其余连接键属于别家
fn mesa_claude_env_keys() -> std::collections::HashSet<String> {
    let mut keys: std::collections::HashSet<String> = [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_CUSTOM_MODEL_OPTION",
        "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    for slot in ["SONNET", "OPUS", "HAIKU", "FABLE"] {
        keys.insert(format!("ANTHROPIC_DEFAULT_{slot}_MODEL"));
        keys.insert(format!("ANTHROPIC_DEFAULT_{slot}_MODEL_NAME"));
    }
    keys
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
    // 只覆盖本协议的 models 数组，其他协议/字段原样保留
    if !models.is_empty() {
        let env_key = if is_anthropic {
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
                if !sp.is_empty() {
                    e["generationConfig"] = json!({ "samplingParams": Value::Object(sp) });
                }
                e
            })
            .collect();
        ensure_obj(&mut v, &["modelProviders", protocol])?.insert("models".into(), json!(entries));
    }
    to_pretty(&v)
}

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

fn patch_opencode_config(
    existing: Option<&str>,
    provider: Value,
    model: Option<&str>,
    provider_id: &str,
) -> Result<String, String> {
    let mut v = parse_json_doc(existing)?;
    let map = ensure_obj(&mut v, &["provider"])?;
    if provider_id != crate::provider_id::LEGACY {
        map.remove(crate::provider_id::LEGACY);
    }
    map.insert(provider_id.into(), provider);
    let root = v.as_object_mut().unwrap();
    if let Some(m) = model {
        root.insert("model".into(), json!(format!("{provider_id}/{m}")));
    }
    root.insert("autoupdate".into(), json!(false));
    to_pretty(&v)
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

fn parse_toml_doc(existing: Option<&str>) -> Result<toml_edit::DocumentMut, String> {
    crate::mcp::strip_bom(existing.unwrap_or(""))
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("现有 TOML 配置解析失败，已停止写入: {e}"))
}

/// 取子表；已存在但不是表时报错停止，避免覆盖用户数据
fn sub_table<'a>(
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
    doc.remove("model_catalog_json");
    // openai_base_url 会把内置 openai 渠道改道到别的地址；web_search 是中转时 Mesa 关的，官方恢复默认
    doc.remove("openai_base_url");
    remove_toml_path_if(&mut doc, &["web_search"], |v| v == "disabled");
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
    let providers = sub_table(doc.as_item_mut(), "providers")?;
    if provider_id != crate::provider_id::LEGACY {
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

/// Grok：~/.grok/config.toml（TOML）。写入面与启动注入同口径（matrix §9）：
/// 顶层 api_key（凭证优先级最高档；官方账号冲突探针本就盯着它，语义自洽）+
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
    if let Some(k) = key {
        doc["api_key"] = value(k);
    }
    if let Some(u) = base_url {
        let endpoints = sub_table(doc.as_item_mut(), "endpoints")?;
        endpoints["models_base_url"] = value(u);
    }
    let models_tbl = sub_table(doc.as_item_mut(), "models")?;
    if let Some(m) = model {
        models_tbl["default"] = value(m);
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
        if let Some(b) = api_backend {
            entry["api_backend"] = value(b);
        }
        if let Some(c) = ctx {
            entry["context_window"] = value(c);
        }
        let Some(table) = entry.as_table_mut() else {
            return Err(format!("模型 {m} 的配置段不是表，已停止写入"));
        };
        write_grok_reasoning_menu(table, grok_menu_levels(profile, m).as_deref());
    }
    Ok(doc.to_string())
}

fn grok_menu_levels(profile: &Profile, model: &str) -> Option<Vec<String>> {
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

/// CodeBuddy：settings.json 的 env 块写 CODEBUDDY_* 三件套（无模型槽位机制，结构最简单）
fn patch_codebuddy_settings(
    existing: Option<&str>,
    base_url: Option<&str>,
    key: Option<&str>,
    model: Option<&str>,
) -> Result<String, String> {
    let mut v = parse_json_doc(existing)?;
    let env = ensure_obj(&mut v, &["env"])?;
    if let Some(u) = base_url {
        env.insert("CODEBUDDY_BASE_URL".into(), json!(u));
    }
    if let Some(k) = key {
        env.insert("CODEBUDDY_API_KEY".into(), json!(k));
    }
    if let Some(m) = model {
        env.insert("CODEBUDDY_MODEL".into(), json!(m));
    }
    // 别家留下的另一种令牌与请求头会跟着这次的地址一起发出
    env.remove("CODEBUDDY_AUTH_TOKEN");
    env.remove("CODEBUDDY_CUSTOM_HEADERS");
    to_pretty(&v)
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

/// CodeBuddy：settings.json 的 env 撤 CODEBUDDY_* 端点 / 密钥，非官方模型名一并撤。
fn patch_codebuddy_settings_official(existing: &str) -> Result<String, String> {
    let mut v = parse_json_doc(Some(existing))?;
    json_env_remove(
        &mut v,
        &["CODEBUDDY_BASE_URL", "CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN", "CODEBUDDY_CUSTOM_HEADERS"],
        &["CODEBUDDY_MODEL"],
        "codebuddy",
    );
    to_pretty(&v)
}

/// Qwen：认证方式改回 qwen-oauth，撤 env 里两套协议的端点 / 密钥 / 模型；
/// `model.name` 只在等于被撤的模型名（Mesa 写的）时撤。modelProviders 名单留着。
fn patch_qwen_settings_official(existing: &str) -> Result<String, String> {
    let mut v = parse_json_doc(Some(existing))?;
    ensure_obj(&mut v, &["security", "auth"])?.insert("selectedType".into(), json!("qwen-oauth"));
    let mut removed = Vec::new();
    if let Some(env) = v.get_mut("env").and_then(|e| e.as_object_mut()) {
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
    let name = v.pointer("/model/name").and_then(|n| n.as_str()).map(String::from);
    if name.is_some_and(|n| removed.contains(&n)) {
        if let Some(model) = v.get_mut("model").and_then(|m| m.as_object_mut()) {
            model.remove("name");
        }
    }
    to_pretty(&v)
}

/// Gemini：settings.json 认证方式改回 Google 账号登录（oauth-personal）；模型名单留着。
fn patch_gemini_settings_official(existing: &str) -> Result<String, String> {
    let mut v = serde_json::from_str::<Value>(&crate::mcp::strip_jsonc(existing))
        .map_err(|e| format!("现有 settings.json 解析失败，已停止写入: {e}"))?;
    if !v.is_object() {
        return Err("现有 settings.json 根节点不是对象，已停止写入".into());
    }
    ensure_obj(&mut v, &["security", "auth"])?
        .insert("selectedType".into(), json!("oauth-personal"));
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
/// 没登录过就撤掉默认模型，kimi 进门会要求 /login。Mesa 写的渠道和模型别名留在选择器里。
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
/// 指向非 x.ai 地址的 [model.<id>] 段整段撤——留着的话官方登录的令牌会被发去中转。
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
                item.get("base_url")
                    .and_then(|u| u.as_str())
                    .is_some_and(|u| !crate::agents::grok_is_xai_endpoint(u))
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
    let mut add = |tag: &'static str, rel: &str, f: &dyn Fn(&str) -> Result<String, String>| {
        let path = home.join(rel);
        if let Some(text) = read_existing(&path)? {
            plans.push(PlannedWrite { tag, content: f(&text)?, path });
        }
        Ok::<(), String>(())
    };
    match agent {
        "codex" => add("config.toml", ".codex/config.toml", &|t| patch_codex_config_official(Some(t)))?,
        "claude-code" => add("settings.json", ".claude/settings.json", &patch_claude_settings_official)?,
        "codebuddy" => add("settings.json", ".codebuddy/settings.json", &patch_codebuddy_settings_official)?,
        "qwen" => add("settings.json", ".qwen/settings.json", &patch_qwen_settings_official)?,
        "gemini" => {
            add(".env", ".gemini/.env", &|t| {
                Ok(patch_env_file_remove(
                    t,
                    &["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL"],
                    &["GEMINI_MODEL"],
                    "gemini",
                ))
            })?;
            add("settings.json", ".gemini/settings.json", &patch_gemini_settings_official)?;
        }
        "kimi" => {
            add("config.toml", ".kimi-code/config.toml", &patch_kimi_config_official)?;
            add("legacy-config.toml", ".kimi/config.toml", &patch_kimi_config_official)?;
        }
        "grok" => add("config.toml", ".grok/config.toml", &patch_grok_config_official)?,
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

/// 计划与磁盘是否一致：官方整份比、API 子集比。
fn plans_match_disk(profile: &Profile, plans: &[PlannedWrite]) -> bool {
    if is_official(profile) {
        disk_equals_plans(plans)
    } else {
        disk_matches_plans(plans)
    }
}

// ===== 计划与执行 =====

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
    let mut plans = Vec::new();
    let mut push = |tag: &'static str, path: PathBuf, content: String| {
        plans.push(PlannedWrite { tag, path, content });
    };
    match profile.agent.as_str() {
        "claude-code" => {
            let path = home.join(".claude/settings.json");
            let content = patch_claude_settings(
                read_existing(&path)?.as_deref(),
                base_url,
                key,
                models,
                profile.gateway_id.as_deref(),
                profile.request_policy.reasoning_effort.as_deref(),
            )?;
            let content = patch_claude_compat(&content, &profile.request_policy.compat)?;
            push("settings.json", path, content);
        }
        "codex" => {
            // /model 选择器的模型目录：先写 catalog 文件，再把路径写进 config.toml
            let catalog = if profile.models.is_empty() {
                None
            } else {
                let path = agents::codex_catalog_path(&profile.id).ok_or("无法确定平台配置目录")?;
                let mut content = serde_json::to_string_pretty(&agents::codex_catalog_json_for(
                    &profile.name,
                    &profile.models,
                    profile.gateway_id.as_deref(),
                ))
                .map_err(|e| e.to_string())?;
                content.push('\n');
                push("model-catalog.json", path.clone(), content);
                Some(path)
            };
            let path = home.join(".codex/config.toml");
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
            let path = home.join(".gemini/.env");
            // 没有任何可写值且文件不存在时，不创建空文件
            if !pairs.is_empty() || path.exists() {
                let content = patch_env_file(read_existing(&path)?.as_deref(), &pairs)?;
                push(".env", path, content);
            }
            // 认证方式落盘（见 patch_gemini_settings 注释：没有它 headless 起不来）；
            // 顺带登记自定义模型进 /model 选择器（experimental 段，重启生效）
            let path = home.join(".gemini/settings.json");
            let content = patch_gemini_settings(
                read_existing(&path)?.as_deref(),
                &profile.name,
                &profile.models,
                profile.gateway_id.as_deref(),
            )?;
            push("settings.json", path, content);
        }
        "qwen" => {
            let path = home.join(".qwen/settings.json");
            let content = patch_qwen_settings(read_existing(&path)?.as_deref(), key, profile)?;
            push("settings.json", path, content);
        }
        "opencode" => {
            let mut provider = agents::opencode_provider_json(profile, key, model);
            overlay_opencode_per_model(&mut provider, profile);
            let path = home.join(".config/opencode/opencode.json");
            let content = patch_opencode_config(
                read_existing(&path)?.as_deref(),
                provider,
                model,
                &profile.provider_name(),
            )?;
            push("opencode.json", path, content);
        }
        "codebuddy" => {
            let path = home.join(".codebuddy/settings.json");
            let content =
                patch_codebuddy_settings(read_existing(&path)?.as_deref(), base_url, key, model)?;
            push("settings.json", path, content);
        }
        "kimi" => {
            // 两个变体共用 kimi 命令：存在的变体目录都写；都不存在时写到新版目录
            let provider_type = profile.protocol.as_deref().unwrap_or("kimi");
            let new_path = home.join(".kimi-code/config.toml");
            let legacy_path = home.join(".kimi/config.toml");
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
                // 新版 0.31+ 要求 max_context_size；旧版 kimi-cli 不写（未知字段可能报错）
                let content = patch_kimi_config(
                    read_existing(&path)?.as_deref(),
                    provider_type,
                    &profile.name,
                    base_url,
                    key,
                    &profile.models,
                    tag == "config.toml",
                    &profile.provider_name(),
                    profile.gateway_id.as_deref(),
                )?;
                push(tag, path, content);
            }
        }
        "grok" => {
            let path = home.join(".grok/config.toml");
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
    push(
        surface.channel_effort,
        profile.request_policy.reasoning_effort.is_some(),
        "思考档",
    );
    push(
        surface.channel_temperature,
        profile.request_policy.temperature.is_some(),
        "温度",
    );
    push(
        surface.channel_top_p,
        profile.request_policy.top_p.is_some(),
        "top_p",
    );
    push(
        surface.channel_max_tokens,
        profile.request_policy.max_output_tokens.is_some(),
        "输出上限",
    );
    if !profile.extra_env.is_empty() {
        notes.push("附加环境变量只在 Mesa 启动时注入，不写入 CLI 全局文件".into());
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
        for (tag, rel) in target_specs(agent) {
            let mut baks = list_backups(backups_dir, tag);
            baks.sort();
            if let Some(newest) = baks.pop() {
                actions.push(TxAction {
                    tag: tag.to_string(),
                    path: home.join(rel),
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
        let plans = plan_writes(&home, &profile, None, &[])?;
        return Ok(preview_plans(&home, &profile.agent, &plans, Vec::new()));
    }
    let skipped = skipped_policy_notes(&profile);
    let first = profile.models.first().cloned();
    crate::combo::apply_to_profile(&mut profile, first.as_deref());
    let key = profiles::get_key_for_profile(&profile)?;
    crate::agents::ensure_launch_credentials(&profile, key.as_deref())?;
    let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
    let plans = plan_writes(&home, &profile, key.as_deref(), &profile.models)?;
    Ok(preview_plans(&home, &profile.agent, &plans, skipped))
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
    if is_official(&profile) {
        let result = tauri::async_runtime::spawn_blocking(move || {
            let _guard = GLOBAL_CONFIG_MUTEX
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let _file_guard = crate::storage::config_lock("global-config")?;
            let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
            let plans = plan_writes(&home, &profile, None, &[])?;
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
        let plans = plan_writes(&home, &profile, key.as_deref(), &profile.models)?;
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
        Ok(GlobalApplyResultDto { files, validation })
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = crate::tray::rebuild_and_wait(app.clone()).await;
    result
}

/// 把绑定的 base_url + 密钥写成 config.toml 里名为 `block_name` 的 provider 定义块。
/// 调用方：客户端接力的「写入并打开」（client_open_launch）与会话导入（传入 rollout 记录的原始名，如 A 机 `ccode-<A短id>`）。
/// 只写 config.toml 的定义块（认证走 experimental_bearer_token，不动 auth.json），与「设为全局」共用备份，可「撤销上次写入」。
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
    let cfg_path = home.join(".codex/config.toml");
    // 只写 config.toml：认证在 provider 块内 experimental_bearer_token，auth.json 完全不碰
    // （单槽 OPENAI_API_KEY 是客户端自身 API-Key 登录态的凭证，写它会顶掉登录）
    let plans = vec![PlannedWrite {
        tag: "config.toml",
        path: cfg_path.clone(),
        content: patch_codex_config_register(
            read_existing(&cfg_path)?.as_deref(),
            profile.base_url.as_deref(),
            &block_name,
            &key,
        )?,
    }];
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
        let out = patch_claude_settings(
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
        assert_eq!(v["env"]["ANTHROPIC_MODEL"], "claude-sonnet-4");
        // 模型列表注册进 /model 选择器的别名槽
        assert_eq!(
            v["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"],
            "claude-sonnet-4"
        );
        assert_eq!(v["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"], "m2");
        assert_eq!(v["env"]["OTHER"], "1");
        assert_eq!(v["theme"], "dark");
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
        let out = patch_claude_settings(
            Some(existing),
            None,
            None,
            &["only-one".to_string()],
            None,
            None,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_MODEL"], "only-one");
        assert_eq!(v["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"], "only-one");
        assert!(v["env"].get("ANTHROPIC_DEFAULT_OPUS_MODEL").is_none());
        assert!(v["env"].get("ANTHROPIC_DEFAULT_HAIKU_MODEL").is_none());
        assert!(v["env"].get("ANTHROPIC_DEFAULT_FABLE_MODEL").is_none());
        assert!(v["env"].get("ANTHROPIC_CUSTOM_MODEL_OPTION").is_none());
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
        let out = patch_claude_settings(Some(&text), Some("https://x"), None, &[], None, None)
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["keep"], 1);
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://x");
        fs::remove_dir_all(&dir).ok();
        // 解析函数自身也容忍（调用方没走 read_existing 时）
        let out =
            patch_claude_settings(Some("\u{feff}{\"keep\": 2}"), None, None, &[], None, None)
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
        let out = patch_claude_settings(None, None, None, &[], None, None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["env"].is_object());
        assert_eq!(v["env"].as_object().unwrap().len(), 0);
    }

    #[test]
    fn claude_patch_writes_max_context_only_when_beyond_default_assumption() {
        // 注册表确知 >200K 的模型（kimi-k3 = 1M）：必须显式声明，否则 claude 按 200K 假设提前 compact；
        // AUTO_COMPACT_WINDOW 与上限同值成对写（压缩触发点跟随声明窗口）
        let out =
            patch_claude_settings(None, None, None, &["kimi-k3".to_string()], None, None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "1048576");
        assert_eq!(v["env"]["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "1048576");
        // ≤200K 的模型：不写；已有旧值时两键都清掉（防上一个 profile 的 1M 残留误导）
        let out = patch_claude_settings(
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
        let out = patch_claude_settings(Some(existing), Some("https://gw"), Some("sk-mesa"), &["m1".into()], None, None).unwrap();
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

        w(".qwen/settings.json", r#"{"security":{"auth":{"selectedType":"openai"}},"env":{"OPENAI_API_KEY":"sk","OPENAI_BASE_URL":"https://r","OPENAI_MODEL":"glm-5"},"model":{"name":"glm-5"},"modelProviders":{"openai":{"models":[{"id":"glm-5"}]}}}"#);
        let v: Value = serde_json::from_str(&off("qwen")[0].content).unwrap();
        assert_eq!(v["security"]["auth"]["selectedType"], "qwen-oauth");
        assert_eq!(v["env"], json!({}));
        assert!(v["model"].get("name").is_none());
        assert!(v["modelProviders"]["openai"].is_object());

        w(".gemini/.env", "GEMINI_API_KEY=sk\nGOOGLE_GEMINI_BASE_URL=https://r\nGEMINI_MODEL=glm-5\nOTHER=1\n");
        w(".gemini/settings.json", "{ // jsonc\n \"security\": {\"auth\": {\"selectedType\": \"gemini-api-key\"}}, \"ui\": {\"theme\": \"x\"} }");
        let plans = off("gemini");
        assert_eq!(plans[0].content, "OTHER=1\n");
        let v: Value = serde_json::from_str(&plans[1].content).unwrap();
        assert_eq!(v["security"]["auth"]["selectedType"], "oauth-personal");
        assert_eq!(v["ui"]["theme"], "x");

        w(".kimi-code/config.toml", "default_model = \"kimi-k3\"\n[providers.ccode-x]\ntype = \"openai\"\n[models.kimi-k3]\nprovider = \"ccode-x\"\n[models.\"kimi-code/k3\"]\nprovider = \"managed:kimi-code\"\n");
        let doc: toml::Value = toml::from_str(&off("kimi")[0].content).unwrap();
        assert_eq!(doc["default_model"].as_str(), Some("kimi-code/k3"));
        assert!(doc["providers"].get("ccode-x").is_some());
        w(".kimi-code/config.toml", "default_model = \"kimi-k3\"\n[models.kimi-k3]\nprovider = \"ccode-x\"\n");
        let doc: toml::Value = toml::from_str(&off("kimi")[0].content).unwrap();
        assert!(doc.get("default_model").is_none(), "没登录过就撤默认模型");

        w(".grok/config.toml", "api_key = \"sk\"\n[endpoints]\nmodels_base_url = \"https://r/v1\"\n[models]\ndefault = \"glm-5\"\ntemperature = 0.3\n[model.glm-5]\nbase_url = \"https://r/v1\"\n[model.grok-4]\nbase_url = \"https://api.x.ai/v1\"\n[mcp_servers.m]\ncommand = \"c\"\n");
        let doc: toml::Value = toml::from_str(&off("grok")[0].content).unwrap();
        assert!(doc.get("api_key").is_none() && doc.get("endpoints").is_none());
        assert!(doc["models"].get("default").is_none());
        assert_eq!(doc["models"]["temperature"].as_float(), Some(0.3));
        assert!(doc["model"].get("glm-5").is_none() && doc["model"].get("grok-4").is_some());
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
        let text = fs::read_to_string(&cfg).unwrap();
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
        assert_eq!(models[0]["envKey"], "OPENAI_API_KEY");
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
                    patch_claude_settings(None, p.base_url.as_deref(), key, &p.models, None, None)
                }
                "qwen" => patch_qwen_settings(None, key, p),
                "gemini" => patch_gemini_settings(None, &p.name, &p.models, None),
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
                    patch_opencode_config(None, provider, None, "ccode-probe")
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

        // 表里 persist 的格子目前只有 qwen 的 temperature/top_p。这条防的是「表被悄悄扩了
        // persist 而没人实现」——真出现了，上面 failures 会先响，这里再说明该去看哪。
        assert_eq!(
            persist_cells,
            vec!["qwen.temperature".to_string(), "qwen.top_p".to_string()],
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
    fn opencode_patch_preserves_other_providers() {
        let existing = r#"{"provider": {"other": {"npm": "x"}}, "theme": "dark"}"#;
        let p = profile("opencode");
        let provider = agents::opencode_provider_json(&p, Some("sk-secret"), Some("m1"));
        let out = patch_opencode_config(Some(existing), provider, Some("m1"), "ccode").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["provider"]["other"]["npm"], "x");
        assert_eq!(v["provider"]["ccode"]["npm"], "@ai-sdk/openai-compatible");
        assert_eq!(v["provider"]["ccode"]["options"]["apiKey"], "sk-secret");
        assert_eq!(v["model"], "ccode/m1");
        assert_eq!(v["autoupdate"], false);
        assert_eq!(v["theme"], "dark");
    }

    #[test]
    fn codebuddy_patch_writes_env_block_and_preserves_rest() {
        let existing = r#"{"env": {"OTHER": "1"}, "theme": "dark"}"#;
        let out = patch_codebuddy_settings(
            Some(existing),
            Some("https://api.deepseek.com/anthropic"),
            Some("sk-secret"),
            Some("deepseek-v3-2-volc"),
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["env"]["CODEBUDDY_BASE_URL"],
            "https://api.deepseek.com/anthropic"
        );
        assert_eq!(v["env"]["CODEBUDDY_API_KEY"], "sk-secret");
        assert_eq!(v["env"]["CODEBUDDY_MODEL"], "deepseek-v3-2-volc");
        assert_eq!(v["env"]["OTHER"], "1", "无关 env 必须保留");
        assert_eq!(v["theme"], "dark", "无关字段必须保留");
        // 缺省（文件不存在）：只创建 env 块
        let out = patch_codebuddy_settings(None, None, Some("sk-secret"), None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["CODEBUDDY_API_KEY"], "sk-secret");
        assert!(v["env"].get("CODEBUDDY_BASE_URL").is_none());
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
        // 既有 [mcp_servers] 段与外来键原样保留；写入面 = 顶层 api_key +
        // [endpoints].models_base_url + [models].default/策略全局默认
        let existing = "theme = \"dark\"\n\n[mcp_servers.fs]\ncommand = \"npx\"\n\n[models]\nallowed_models = [\"grok-4.5\"]\n";
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
        assert_eq!(doc["api_key"].as_str(), Some("xai-secret"));
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
        assert_eq!(
            models["allowed_models"].as_array().unwrap().len(),
            1,
            "allowed_models 属用户选择器过滤，不接管"
        );
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
        assert!(plans[0].content.contains("api_key"));
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
        let planned = patch_claude_settings(
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
        );
        assert_eq!(preview.files.len(), 1);
        assert_eq!(preview.files[0].action, "modify");
        assert!(preview.files[0]
            .changes
            .iter()
            .any(|c| { c.path.contains("ANTHROPIC_DEFAULT_OPUS_MODEL") && c.op == "remove" }));
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
        let mut p = profile("qwen");
        p.request_policy.reasoning_effort = Some("high".into());
        p.extra_env
            .insert("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into());
        let notes = skipped_policy_notes(&p);
        assert!(notes.iter().any(|n| n.contains("思考档")));
        assert!(notes.iter().any(|n| n.contains("附加环境变量")));
    }
}
