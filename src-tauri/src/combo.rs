//! Agent × 模型 × 网关槽 × 体检 的求交器。
//! 能力链在 Rust；前端只消费本模块下发的 DTO，不得自己查 model_registry。

use crate::agent_specs::{self, request_policy_support};
use crate::gateway_store::{self, probe_field_status, Slot};
use crate::model_registry;
use crate::profiles::{Gateway, ProbeStatus, Profile};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComboSurfaceDto {
    pub agent: String,
    pub agents: Vec<String>,
    pub model: String,
    pub gateway_id: Option<String>,
    pub slot: Option<String>,
    pub thinking: bool,
    pub vision: bool,
    /// 确知的上下文窗口；不知道是 None（界面不画上下文圈，见 model_context_size_known_for）
    pub context: Option<i64>,
    pub output: i64,
    /// 状态栏是否展示 CLI 原生 /effort（启动时选中模型求交）
    pub show_native_effort: bool,
    /// 网关里勾选的可切换档。空 = 用 CLI 自己的整张档位表。
    pub effort_levels: Vec<String>,
    /// 这次启动会注入的开场档（绑定逐模型策略 `@` 默认档；通道不通 = None）。
    /// 状态栏「当前思考档」的兜底来源——没注入就是 None，不能拿档位表第几格冒充
    pub launch_effort: Option<String>,
    /// 启动注入是否写入 effort（通道 supported 且体检未失败且用户存了值时由 launch 再判）
    pub inject_effort_allowed: bool,
    pub inject_temperature_allowed: bool,
    pub inject_top_p_allowed: bool,
    pub inject_max_tokens_allowed: bool,
    pub inject_headers_allowed: bool,
    /// 已存值但当前求交的 Agent 并集没有通道；模型不会思考时为 false（字段应隐藏而非只读）
    pub effort_readonly: bool,
    pub temperature_readonly: bool,
    pub top_p_readonly: bool,
    pub max_tokens_readonly: bool,
    pub mixed_models_note: Option<String>,
    /// 逐字段通道种类（inject/persist/tui/unsupported/unknown 的并集结果）：
    /// 前端三态按它区分「启动可注」与「仅设为全局生效」
    pub channel_effort: &'static str,
    pub channel_temperature: &'static str,
    pub channel_top_p: &'static str,
    pub channel_max_tokens: &'static str,
    pub channel_headers: &'static str,
    pub probe_effort: &'static str,
    pub probe_temperature: &'static str,
    pub probe_headers: &'static str,
    pub probe_note: Option<String>,
    /// 策略通道形态说明（如 grok「策略经 GROK_CONFIG overlay 注入」）；多 agent 求交时去重拼接
    pub policy_channel_note: Option<String>,
    pub missing_slot: bool,
}

fn channel_ok(status: &str) -> bool {
    status == "inject"
}

/// 注入与设为全局共享的「可携带」判定：inject/persist 都保留存储值
///（persist 字段启动注入不注，但设为全局要写，apply_to_profile 不得剥掉）
fn channel_carries(status: &str) -> bool {
    matches!(status, "inject" | "persist")
}

/// 单 agent 单字段的通道状态（含协议维度门控）：kimi 的 KIMI_MODEL_THINKING_EFFORT
/// 仅 kimi 协议通道读取（2026-08-28 二进制实证），绑 anthropic/openai 协议时静默忽略——
/// 该绑定按无通道计（unknown），防止求交把「静默不注」画成「启动会注」
fn channel_status_for(agent: &str, protocol: Option<&str>, field: &str) -> &'static str {
    let status = field_status(agent, field);
    if agent == "kimi" && field == "effort" && protocol.is_some_and(|p| p != "kimi") {
        return "unknown";
    }
    status
}

fn field_status(agent: &str, field: &str) -> &'static str {
    let s = request_policy_support(agent);
    match field {
        "temperature" => s.temperature,
        "top_p" => s.top_p,
        "max_tokens" => s.max_output_tokens,
        "effort" => s.reasoning_effort,
        _ => s.custom_headers,
    }
}

/// 多 agent 并集的通道种类：inject > persist > tui > unsupported > unknown
///（网关库同一网关可能绑多家；只要有一家能注入即算可注入）
fn union_channel_kind(agents: &[(&str, Option<&str>)], field: &str) -> &'static str {
    let mut best = "unknown";
    for &(a, proto) in agents {
        let s = channel_status_for(a, proto, field);
        best = match (best, s) {
            ("inject", _) | (_, "inject") => "inject",
            ("persist", _) | (_, "persist") => "persist",
            ("tui", _) | (_, "tui") => "tui",
            ("unsupported", _) | (_, "unsupported") => "unsupported",
            _ => "unknown",
        };
    }
    best
}

fn probe_blocks(status: ProbeStatus) -> bool {
    status == ProbeStatus::Failed
}

fn probe_status_any(
    gateway: Option<&Gateway>,
    slot: Option<Slot>,
    field: &str,
    model: &str,
) -> ProbeStatus {
    let Some(g) = gateway else {
        return ProbeStatus::Never;
    };
    let Some(s) = slot else {
        return ProbeStatus::Never;
    };
    probe_field_status(g, s, field, Some(model))
}

fn probe_note_for(gateway: Option<&Gateway>, probe_effort: ProbeStatus) -> Option<String> {
    if probe_effort != ProbeStatus::Failed {
        return None;
    }
    let when = gateway
        .and_then(|g| {
            g.last_probe
                .iter()
                .filter(|p| p.effort == ProbeStatus::Failed)
                .map(|p| p.probed_at.as_str())
                .max()
        })
        .map(|iso| iso.chars().take(10).collect::<String>())
        .filter(|s| !s.is_empty());
    Some(match when {
        Some(d) => format!("实测该网关会丢弃 effort 参数（{d} 体检）"),
        None => "实测该网关会丢弃 effort 参数".into(),
    })
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn surface_for(
    agent: &str,
    model: &str,
    gateway: Option<&Gateway>,
    slot: Option<Slot>,
    stored_effort: bool,
    binding_models: &[String],
    missing_slot: bool,
) -> ComboSurfaceDto {
    surface_for_agents(
        &[(agent, None)],
        model,
        gateway,
        slot,
        stored_effort,
        false,
        false,
        false,
        binding_models,
        missing_slot,
        &[],
    )
}

pub fn surface_for_agents(
    agents: &[(&str, Option<&str>)],
    model: &str,
    gateway: Option<&Gateway>,
    slot: Option<Slot>,
    stored_effort: bool,
    stored_temp: bool,
    stored_top_p: bool,
    stored_max: bool,
    binding_models: &[String],
    missing_slot: bool,
    effort_levels: &[String],
) -> ComboSurfaceDto {
    let gid = gateway.map(|g| g.id.as_str());
    let has_codex = agents.iter().any(|(a, _)| *a == "codex");
    let codex_official_thinking = has_codex
        && !model.is_empty()
        && model_registry::model_thinking_declared_for(model, gid) != Some(false)
        && crate::agents::codex_official_effort_levels(model, false).is_some();
    let claude_alias_thinking = agents.iter().any(|(a, _)| *a == "claude-code")
        && matches!(
            model.trim().to_ascii_lowercase().as_str(),
            "default" | "opus" | "sonnet" | "haiku" | "opusplan"
        );
    let thinking = model_registry::model_thinking_for(model, gid)
        || codex_official_thinking
        || claude_alias_thinking;
    // 新添加但尚未进内置表 / 公共能力库的模型（声明层为 None）：与 apply_to_profile 同口径，
    // 「不知道」不等于「不会思考」——只要没有显式声明 false，就不拦思考档展示与切换
    let effort_capable = thinking
        || (!model.trim().is_empty()
            && model_registry::model_thinking_declared_for(model, gid) != Some(false));
    let vision = model_registry::model_supports_vision_for(model, gid);
    let context = model_registry::model_context_size_known_for(model, gid);
    let output = model_registry::model_output_limit_for(model, gid);
    let channel_effort = union_channel_kind(agents, "effort");
    let channel_temperature = union_channel_kind(agents, "temperature");
    let channel_top_p = union_channel_kind(agents, "top_p");
    let channel_max_tokens = union_channel_kind(agents, "max_tokens");
    let channel_headers = union_channel_kind(agents, "headers");
    let has_native_effort = agents.iter().any(|(agent, _)| {
        agent_specs::agent_spec(agent)
            .and_then(|s| s.effort_levels)
            .is_some_and(|(levels, _)| levels.len() > 1)
    });

    let probe_effort = probe_status_any(gateway, slot, "effort", model);
    let probe_temp = probe_status_any(gateway, slot, "temperature", model);
    let probe_headers = probe_status_any(gateway, slot, "headers", model);

    // Grok：模型没在 config 里声明档位时，启动参数和 /effort 都被它忽略（agents::grok_model_declares_effort）。
    // 只绑了 grok 的组合按「这次给不了档」算，不在开聊前 / 运行中摆一排点了没用的档位
    let grok_only = !agents.is_empty() && agents.iter().all(|(a, _)| *a == "grok");
    let grok_blocks = grok_only && !crate::agents::grok_model_declares_effort(model);
    let inject_effort_allowed =
        effort_capable && channel_ok(channel_effort) && !probe_blocks(probe_effort) && !grok_blocks;
    let show_native_effort =
        effort_capable && has_native_effort && !probe_blocks(probe_effort) && !grok_blocks;
    // 不会思考 → 隐藏思考档；persist/tui 的已存值仍可改/可见，不算「通道不通」
    let effort_readonly = stored_effort && effort_capable && !channel_carries(channel_effort);

    let mixed = if binding_models.len() > 1 {
        let flags: Vec<bool> = binding_models
            .iter()
            .map(|m| model_registry::model_thinking_for(m, gid))
            .collect();
        let thinking_mixed = flags.iter().any(|x| *x) && flags.iter().any(|x| !*x);
        // 混采样也算：各模型在网关上存的策略不一致时，换模不换策略（进程级注入不重注）。
        // f64 无 Eq/Hash，按 bit  pattern 进集合
        let policy_mixed = gateway.is_some_and(|g| {
            let tuples: std::collections::HashSet<_> = binding_models
                .iter()
                .filter_map(|m| g.models.iter().find(|x| x.id == *m))
                .map(|gm| {
                    (
                        gm.temperature.map(|f| f.to_bits()),
                        gm.top_p.map(|f| f.to_bits()),
                        gm.max_output_tokens,
                        gm.reasoning_effort.clone(),
                    )
                })
                .collect();
            tuples.len() > 1
        });
        thinking_mixed || policy_mixed
    } else {
        false
    };
    let mixed_models_note = if mixed {
        Some("此绑定的模型在思考能力或已存策略上不一致。启动后在 CLI 里换模不会重注策略，要按新模型请重开标签。".into())
    } else {
        None
    };

    ComboSurfaceDto {
        agent: agents.first().copied().unwrap_or(("", None)).0.into(),
        agents: agents.iter().map(|(s, _)| (*s).to_string()).collect(),
        model: model.into(),
        gateway_id: gid.map(str::to_string),
        slot: slot.map(|s| s.as_str().to_string()),
        thinking,
        vision,
        context,
        output,
        show_native_effort,
        inject_effort_allowed,
        inject_temperature_allowed: channel_ok(channel_temperature) && !probe_blocks(probe_temp),
        inject_top_p_allowed: channel_ok(channel_top_p) && !probe_blocks(probe_temp),
        inject_max_tokens_allowed: channel_ok(channel_max_tokens),
        inject_headers_allowed: channel_ok(channel_headers) && !probe_blocks(probe_headers),
        effort_readonly,
        temperature_readonly: stored_temp && !channel_carries(channel_temperature),
        top_p_readonly: stored_top_p && !channel_carries(channel_top_p),
        max_tokens_readonly: stored_max && !channel_carries(channel_max_tokens),
        mixed_models_note,
        channel_effort,
        channel_temperature,
        channel_top_p,
        channel_max_tokens,
        channel_headers,
        probe_effort: probe_effort.as_str(),
        probe_temperature: probe_temp.as_str(),
        probe_headers: probe_headers.as_str(),
        probe_note: probe_note_for(gateway, probe_effort),
        effort_levels: effort_levels.to_vec(),
        launch_effort: None,
        policy_channel_note: {
            let mut notes: Vec<&str> = agents
                .iter()
                .filter_map(|(a, _)| agent_specs::policy_channel_note(a))
                .collect();
            notes.dedup();
            if notes.is_empty() {
                None
            } else {
                Some(notes.join("；"))
            }
        },
        missing_slot,
    }
}

pub fn apply_to_profile(profile: &mut Profile, model: Option<&str>) {
    let surface = surface_for_profile(profile, model);
    // 剥的是「任何入口都到不了」（无 inject/persist 通道）或「体检明确失败」的存储值；
    // persist 字段保留——启动不注，但「设为全局」要写（gemini modelConfigs 路径）。
    //
    // effort 另要求模型会思考，但这里**不能用** surface.thinking：那是 bool，把「确知
    // 不思考」与「不知道」压成同一个 false。本函数做的是删除——未知模型会被当成不思考，
    // 用户存好的 reasoning_effort 被无声抹掉且不可恢复。所以只有**声明层确知 false**
    // 才配当删除依据；未知一律保留（启动注入侧会再判一次，留着不会误注）。
    let model_name = model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| profile.models.first().map(String::as_str))
        .unwrap_or("");
    let thinking_declared = crate::model_registry::model_thinking_declared_for(
        model_name,
        profile.gateway_id.as_deref(),
    );
    let probe_failed = |s: &str| s == "failed";
    let agy_official_no_effort = profile.agent == "agy"
        && profile.account_type == crate::profiles::AccountType::Official
        && !model_name.is_empty()
        && crate::agents::agy_official_effort_family(model_name).is_none();
    if !channel_carries(surface.channel_effort)
        || thinking_declared == Some(false)
        || probe_failed(surface.probe_effort)
        || agy_official_no_effort
    {
        profile.request_policy.reasoning_effort = None;
    }
    if !(channel_carries(surface.channel_temperature) && !probe_failed(surface.probe_temperature)) {
        profile.request_policy.temperature = None;
    }
    if !(channel_carries(surface.channel_top_p) && !probe_failed(surface.probe_temperature)) {
        profile.request_policy.top_p = None;
    }
    if !channel_carries(surface.channel_max_tokens) {
        profile.request_policy.max_output_tokens = None;
    }
    if !(channel_carries(surface.channel_headers) && !probe_failed(surface.probe_headers)) {
        profile.request_policy.header_env.clear();
    }
}

pub fn surface_for_profile(profile: &Profile, model: Option<&str>) -> ComboSurfaceDto {
    let model = model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| profile.models.first().map(String::as_str))
        .unwrap_or("");
    let gw = profile
        .gateway_id
        .as_deref()
        .and_then(gateway_store::find_gateway);
    let slot = gateway_store::slot_for_agent(&profile.agent, profile.protocol.as_deref());
    let gm = gw.as_ref().and_then(|g| {
        g.models
            .iter()
            .find(|m| m.id == model)
            .or_else(|| g.models.iter().find(|m| m.id.eq_ignore_ascii_case(model)))
    });
    let stored_effort = profile.request_policy.reasoning_effort.is_some()
        || gm.and_then(|m| m.reasoning_effort.as_ref()).is_some();
    let stored_temp =
        profile.request_policy.temperature.is_some() || gm.and_then(|m| m.temperature).is_some();
    let stored_top_p = profile.request_policy.top_p.is_some() || gm.and_then(|m| m.top_p).is_some();
    let stored_max = profile.request_policy.max_output_tokens.is_some()
        || gm.and_then(|m| m.max_output_tokens).is_some();
    // 开场档与 materialize 同口径：所选模型在网关上的逐模型策略优先，其次绑定物化出的策略
    let launch_effort = gm
        .and_then(|m| m.reasoning_effort.as_deref())
        .and_then(crate::agent_specs::launch_reasoning_effort)
        .or_else(|| {
            profile
                .request_policy
                .reasoning_effort
                .as_deref()
                .and_then(crate::agent_specs::launch_reasoning_effort)
        });
    let raw_gw_levels = gm
        .and_then(|m| m.reasoning_effort.as_deref())
        .map(crate::agent_specs::reasoning_effort_levels)
        .unwrap_or_default();
    let is_official = profile.account_type == crate::profiles::AccountType::Official;
    let agy_model_cap: Option<Vec<&'static str>> = if profile.agent == "agy" {
        if is_official {
            if model.is_empty() {
                Some(vec!["low", "medium", "high"])
            } else {
                crate::agents::agy_official_effort_family(model).map(|f| f.levels)
            }
        } else if let Some(fam) = crate::agents::agy_builtin_gemini_family(model) {
            if fam.levels.is_empty() {
                None
            } else {
                Some(fam.levels)
            }
        } else {
            Some(vec!["low", "medium", "high"])
        }
    } else {
        None
    };
    let codex_official_levels = if profile.agent == "codex" {
        crate::agents::codex_official_effort_levels(model, is_official)
    } else {
        None
    };
    let cli_model_cap: Option<Vec<String>> = match profile.agent.as_str() {
        "claude-code" => Some(
            crate::agents::claude_model_effort_levels(model)
                .into_iter()
                .map(str::to_string)
                .collect(),
        ),
        "qwen" => Some(
            crate::agents::qwen_model_effort_levels(model)
                .into_iter()
                .map(str::to_string)
                .collect(),
        ),
        _ => None,
    };
    let effective_levels: Vec<String> = if let Some(ref cap) = agy_model_cap {
        if !raw_gw_levels.is_empty() {
            let filtered: Vec<String> = raw_gw_levels
                .into_iter()
                .filter(|lv| cap.contains(&lv.as_str()))
                .collect();
            if filtered.is_empty() {
                cap.iter().map(|s| (*s).to_string()).collect()
            } else {
                filtered
            }
        } else {
            cap.iter().map(|s| (*s).to_string()).collect()
        }
    } else if profile.agent == "codex" {
        let cap = codex_official_levels.clone().unwrap_or_else(|| {
            crate::agent_specs::effort_options("codex")
                .into_iter()
                .map(str::to_string)
                .collect()
        });
        if !raw_gw_levels.is_empty() {
            let filtered: Vec<String> = raw_gw_levels
                .into_iter()
                .filter(|lv| cap.iter().any(|c| c == lv))
                .collect();
            if filtered.is_empty() { cap } else { filtered }
        } else {
            cap
        }
    } else if let Some(ref cap) = cli_model_cap {
        if cap.is_empty() {
            Vec::new()
        } else if !raw_gw_levels.is_empty() {
            let filtered: Vec<String> = raw_gw_levels
                .into_iter()
                .filter(|lv| cap.iter().any(|c| c == lv))
                .collect();
            if filtered.is_empty() { cap.clone() } else { filtered }
        } else {
            cap.clone()
        }
    } else if raw_gw_levels.is_empty() && profile.agent == "kimi" {
        crate::agents::kimi_model_effort_levels(profile, model).unwrap_or_default()
    } else if raw_gw_levels.is_empty() && profile.agent == "opencode" {
        crate::agent_specs::effort_options("opencode")
            .into_iter()
            .map(str::to_string)
            .collect()
    } else {
        raw_gw_levels
    };
    let mut surface = surface_for_agents(
        &[(profile.agent.as_str(), profile.protocol.as_deref())],
        model,
        gw.as_ref(),
        Some(slot),
        stored_effort,
        stored_temp,
        stored_top_p,
        stored_max,
        &profile.models,
        profile.slot_missing,
        &effective_levels,
    );
    // 官方账号未显式指定模型（走 CLI 自带默认模型）时，一等/主流家的官方默认模型均支持思考档；
    // 反过来 agy 官方账号选了非支持族模型（如 claude-sonnet-4-6）或 Claude/Qwen 选了无分档模型时必须关掉开关。
    if is_official && model.is_empty() {
        if matches!(
            profile.agent.as_str(),
            "claude-code" | "codex" | "agy" | "kimi" | "qwen" | "grok"
        ) {
            surface.thinking = true;
            let probe_ok = surface.probe_effort != "failed";
            surface.inject_effort_allowed = channel_ok(surface.channel_effort) && probe_ok;
            let has_native = agent_specs::agent_spec(&profile.agent)
                .and_then(|s| s.effort_levels)
                .is_some_and(|(levels, _)| levels.len() > 1);
            surface.show_native_effort = has_native && probe_ok;
        }
    } else if profile.agent == "codex"
        && is_official
        && codex_official_levels.is_some()
        && model_registry::model_thinking_declared_for(model, profile.gateway_id.as_deref())
            != Some(false)
    {
        surface.thinking = true;
        surface.inject_effort_allowed =
            channel_ok(surface.channel_effort) && surface.probe_effort != "failed";
    } else if profile.agent == "grok"
        && is_official
        && {
            let low = model.trim().to_ascii_lowercase();
            low.starts_with("grok-3") || low.starts_with("grok-4")
        }
        && model_registry::model_thinking_declared_for(model, profile.gateway_id.as_deref())
            != Some(false)
    {
        surface.thinking = true;
        let probe_ok = surface.probe_effort != "failed";
        surface.inject_effort_allowed = channel_ok(surface.channel_effort) && probe_ok;
        surface.show_native_effort = probe_ok;
        if surface.effort_levels.is_empty() {
            surface.effort_levels = crate::agent_specs::effort_options("grok")
                .into_iter()
                .map(str::to_string)
                .collect();
        }
    } else if (profile.agent == "agy" && agy_model_cap.is_none())
        || cli_model_cap.as_ref().is_some_and(Vec::is_empty)
    {
        surface.inject_effort_allowed = false;
        surface.show_native_effort = false;
        surface.effort_levels.clear();
    }
    if !surface.inject_effort_allowed && !surface.show_native_effort {
        surface.effort_levels.clear();
    }
    // 通道不通（不会思考 / 体检失败 / 该家无注入通道）时启动不会注入，开场档就是「不知道」
    if surface.inject_effort_allowed {
        surface.launch_effort = launch_effort;
    }
    surface
}

#[tauri::command]
pub fn combo_surface(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    profile_id: String,
    model: Option<String>,
) -> Result<ComboSurfaceDto, String> {
    let profile = store.get(&profile_id)?;
    Ok(surface_for_profile(&profile, model.as_deref()))
}

/// 网关库语境：绑了该网关的所有 Agent 通道取并集。
/// 读网关文件（带几百 KB 目录）与绑定表：async 外壳 + 后台线程，不占主线程（terminal.md「会等待的命令不占主线程」）
#[tauri::command]
pub async fn combo_surface_for_gateway(
    gateway_id: String,
    model: String,
) -> Result<ComboSurfaceDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        surfaces_for_gateway_sync(&gateway_id, std::iter::once(model))?
            .pop()
            .ok_or_else(|| "网关不存在".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 批量版：网关文件与绑定表只读一次（原先逐个模型各读一遍，首屏 24 个模型就是 24 遍）。
/// 2026-11-07 开发版实测：同步跑在主线程时，网关库点进编辑页第一帧晚到 300–440ms
#[tauri::command]
pub async fn combo_surface_for_gateway_batch(
    gateway_id: String,
    models: Vec<String>,
) -> Result<Vec<ComboSurfaceDto>, String> {
    tauri::async_runtime::spawn_blocking(move || surfaces_for_gateway_sync(&gateway_id, models))
        .await
        .map_err(|e| e.to_string())?
}

fn surfaces_for_gateway_sync(
    gateway_id: &str,
    models: impl IntoIterator<Item = String>,
) -> Result<Vec<ComboSurfaceDto>, String> {
    let gw = gateway_store::find_gateway(gateway_id).ok_or("网关不存在")?;
    let bindings = gateway_store::load_bindings().unwrap_or_default();
    let agents: Vec<(String, Option<String>)> = bindings
        .iter()
        .filter(|b| b.gateway_id.as_deref() == Some(gateway_id))
        .map(|b| (b.agent.clone(), b.protocol.clone()))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let agent_refs: Vec<(&str, Option<&str>)> = agents
        .iter()
        .map(|(a, p)| (a.as_str(), p.as_deref()))
        .collect();
    let binding_models: Vec<String> = bindings
        .iter()
        .filter(|b| b.gateway_id.as_deref() == Some(gateway_id))
        .flat_map(|b| b.models.clone())
        .collect();
    Ok(models
        .into_iter()
        .map(|model| {
            let gm = gw.models.iter().find(|m| m.id == model);
            let slot = gm
                .and_then(|m| m.catalog_slot.as_deref())
                .and_then(Slot::from_str)
                .or_else(|| {
                    agents
                        .first()
                        .map(|(a, p)| gateway_store::slot_for_agent(a, p.as_deref()))
                });
            surface_for_agents(
                &agent_refs,
                &model,
                Some(&gw),
                slot,
                gm.and_then(|m| m.reasoning_effort.as_ref()).is_some(),
                gm.and_then(|m| m.temperature).is_some(),
                gm.and_then(|m| m.top_p).is_some(),
                gm.and_then(|m| m.max_output_tokens).is_some(),
                &binding_models,
                false,
                &gm.and_then(|m| m.reasoning_effort.as_deref())
                    .map(crate::agent_specs::reasoning_effort_levels)
                    .unwrap_or_default(),
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{Gateway, GatewayModel, ProbeRecord, ProtocolSlots};

    fn gw_with_probe(effort_failed: bool) -> Gateway {
        gw_with_probe_fields(
            effort_failed,
            ProbeStatus::Never,
            Some("grok-4"),
            "https://example.com",
        )
    }

    fn gw_with_probe_fields(
        effort_failed: bool,
        sampling: ProbeStatus,
        model: Option<&str>,
        url: &str,
    ) -> Gateway {
        let has_probe = effort_failed || sampling != ProbeStatus::Never;
        Gateway {
            id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
            name: "g".into(),
            no_auth: false,
            key_hint: None,
            wallet_user_id: None,
            wallet_key_hint: None,
            slots: ProtocolSlots {
                anthropic: Some(url.into()),
                ..Default::default()
            },
            header_env: Default::default(),
            models: vec![GatewayModel {
                id: "grok-4".into(),
                source: "user".into(),
                status: "available".into(),
                last_seen_at: None,
                catalog_slot: None,
                temperature: None,
                top_p: None,
                max_output_tokens: None,
                reasoning_effort: Some("high".into()),
            }],
            catalog_fetched_at: None,
            catalog_from_slot: None,
            slot_probes: Vec::new(),
            revision: String::new(),
            last_probe: if has_probe {
                vec![ProbeRecord {
                    slot: "anthropic".into(),
                    model: model.map(str::to_string),
                    url_fp: gateway_store::url_fingerprint(url),
                    key_fp: gateway_store::key_presence_fp(false),
                    streaming: ProbeStatus::Passed,
                    effort: if effort_failed {
                        ProbeStatus::Failed
                    } else {
                        ProbeStatus::Passed
                    },
                    sampling,
                    headers: ProbeStatus::Never,
                    basic: ProbeStatus::Passed,
                    probed_at: "t".into(),
                    latency_ms: Some(245),
                }]
            } else {
                vec![]
            },
            compat: Default::default(),
        }
    }

    /// apply_to_profile 的最小 profile：agent 定通道、models 定模型名、effort 是待剥的存量值。
    fn profile_with(agent: &str, models: &[&str], effort: Option<&str>) -> Profile {
        Profile {
            id: "p".into(),
            agent: agent.into(),
            name: "测试".into(),
            account_type: Default::default(),
            no_auth: false,
            protocol: None,
            api_backend: None,
            base_url: Some("https://relay.example.com".into()),
            models: models.iter().map(|s| s.to_string()).collect(),
            role_models: Default::default(),
            extra_env: Default::default(),
            request_policy: crate::profiles::RequestPolicy {
                reasoning_effort: effort.map(str::to_string),
                ..Default::default()
            },
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
            official_ref: None,
        }
    }

    #[test]
    fn apply_to_profile_keeps_stored_effort_when_thinking_unknown() {
        // 注册链未确知该模型是否思考（不在内置表、无网关实测、无用户覆盖）：
        // 「不知道」不等于「不思考」，不能当删除依据——用户存好的 effort 留着，
        // 启动注入侧会再判一次，留着不会误注。
        let mut p = profile_with("claude-code", &["my-relay-model"], Some("high"));
        apply_to_profile(&mut p, None);
        assert_eq!(p.request_policy.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn apply_to_profile_keeps_stored_effort_when_thinking_declared_true() {
        // 内置表确知 claude-opus-4 会思考 → 保留（声明为真同样不是删除依据）
        let mut p = profile_with("claude-code", &["claude-opus-4"], Some("high"));
        apply_to_profile(&mut p, None);
        assert_eq!(p.request_policy.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn apply_to_profile_drops_stored_effort_when_thinking_declared_false() {
        // 内置表确知 claude-3-5 不思考（Some(false) 是唯一配当删除依据的声明值）
        let mut p = profile_with("claude-code", &["claude-3-5-sonnet"], Some("high"));
        apply_to_profile(&mut p, None);
        assert_eq!(p.request_policy.reasoning_effort, None);
    }

    #[test]
    fn apply_to_profile_drops_stored_effort_when_channel_missing() {
        // gemini 的 effort 通道为 unknown（当前无入口）：不管模型是否思考都剥——
        // 通道判据与模型声明判据是两条独立的 or 分支
        let mut p = profile_with("gemini", &["claude-opus-4"], Some("high"));
        apply_to_profile(&mut p, None);
        assert_eq!(p.request_policy.reasoning_effort, None);
    }

    #[test]
    fn claude_thinking_model_shows_native_effort() {
        let dto = surface_for(
            "claude-code",
            "claude-opus-4",
            None,
            Some(Slot::Anthropic),
            false,
            &["claude-opus-4".into()],
            false,
        );
        assert!(dto.thinking);
        assert!(dto.show_native_effort);
        assert!(dto.inject_effort_allowed);
    }

    #[test]
    fn probe_failed_hides_native_effort() {
        let gw = gw_with_probe(true);
        let dto = surface_for(
            "claude-code",
            "grok-4",
            Some(&gw),
            Some(Slot::Anthropic),
            true,
            &["grok-4".into()],
            false,
        );
        assert!(!dto.show_native_effort);
        assert!(!dto.inject_effort_allowed);
        assert_eq!(dto.probe_effort, "failed");
    }

    #[test]
    fn never_probed_does_not_block_supported_channel() {
        let gw = gw_with_probe(false);
        let dto = surface_for(
            "claude-code",
            "claude-opus-4",
            Some(&gw),
            Some(Slot::Anthropic),
            false,
            &["claude-opus-4".into()],
            false,
        );
        assert_eq!(dto.probe_effort, "never");
        assert!(dto.inject_effort_allowed);
    }

    #[test]
    fn gemini_has_no_effort_channel() {
        let dto = surface_for(
            "gemini",
            "gemini-2.5-pro",
            None,
            Some(Slot::Gemini),
            true,
            &["gemini-2.5-pro".into()],
            false,
        );
        assert!(dto.effort_readonly);
        assert!(!dto.inject_effort_allowed);
    }

    #[test]
    fn mixed_models_note() {
        let dto = surface_for(
            "claude-code",
            "claude-opus-4",
            None,
            Some(Slot::Anthropic),
            false,
            &["claude-opus-4".into(), "deepseek-chat".into()],
            false,
        );
        assert!(dto.mixed_models_note.is_some());
    }

    #[test]
    fn agent_union_effort_channel_from_any_bound() {
        let dto = surface_for_agents(
            &[("gemini", None), ("claude-code", None)],
            "claude-opus-4",
            None,
            Some(Slot::Anthropic),
            true,
            false,
            false,
            false,
            &["claude-opus-4".into()],
            false,
            &[],
        );
        assert!(dto.inject_effort_allowed);
        assert!(!dto.effort_readonly);
        assert!(dto.inject_temperature_allowed);
    }

    #[test]
    fn kimi_effort_channel_gated_by_protocol() {
        // KIMI_MODEL_THINKING_EFFORT 仅 kimi 协议通道读取：protocol=openai 的 kimi 绑定
        // 求交必须关掉思考档注入（否则画成「启动会注」实际静默不注）
        let kimi_openai = surface_for_agents(
            &[("kimi", Some("openai"))],
            "kimi-k3",
            None,
            Some(Slot::Openai),
            true,
            false,
            false,
            false,
            &["kimi-k3".into()],
            false,
            &[],
        );
        assert!(!kimi_openai.inject_effort_allowed);
        assert_eq!(kimi_openai.channel_effort, "unknown");
        assert!(kimi_openai.effort_readonly, "已存值但通道被协议关掉 → 只读");
        let kimi_native = surface_for_agents(
            &[("kimi", Some("kimi"))],
            "kimi-k3",
            None,
            Some(Slot::Openai),
            true,
            false,
            false,
            false,
            &["kimi-k3".into()],
            false,
            &[],
        );
        assert!(kimi_native.inject_effort_allowed);
        assert_eq!(kimi_native.channel_effort, "inject");
    }

    #[test]
    fn persist_only_sampling_channels_stay_editable() {
        // gemini 温度/top_p：仅设为全局通道——启动不注（inject=false）但存储可携带（非只读）
        let dto = surface_for_agents(
            &[("gemini", None)],
            "gemini-3-pro",
            None,
            None,
            false,
            true,
            false,
            false,
            &["gemini-3-pro".into()],
            false,
            &[],
        );
        assert!(!dto.inject_temperature_allowed);
        assert_eq!(dto.channel_temperature, "persist");
        assert!(!dto.temperature_readonly, "persist 通道的已存值仍可编辑");
    }

    #[test]
    fn qwen_sampling_channels_inject_via_system_overlay() {
        // qwen 温度/top_p/思考档：启动时经系统设置覆盖层注入（2026-11-01 假网关实测四项都到线上）
        let dto = surface_for_agents(
            &[("qwen", None)],
            "qwen3-coder",
            None,
            Some(Slot::Openai),
            false,
            true,
            false,
            false,
            &["qwen3-coder".into()],
            false,
            &[],
        );
        assert!(dto.inject_temperature_allowed);
        assert_eq!(dto.channel_temperature, "inject");
        assert_eq!(dto.channel_max_tokens, "inject");
        assert_eq!(dto.channel_effort, "inject");
    }

    #[test]
    fn non_thinking_stored_effort_is_not_channel_readonly() {
        let dto = surface_for(
            "claude-code",
            "deepseek-chat",
            None,
            Some(Slot::Anthropic),
            true,
            &["deepseek-chat".into()],
            false,
        );
        assert!(!dto.thinking);
        assert!(!dto.effort_readonly);
        assert!(!dto.inject_effort_allowed);
    }

    #[test]
    fn probe_failed_sets_note_and_temperature_mapping() {
        let gw = gw_with_probe(true);
        let dto = surface_for(
            "claude-code",
            "grok-4",
            Some(&gw),
            Some(Slot::Anthropic),
            true,
            &["grok-4".into()],
            false,
        );
        assert_eq!(dto.probe_effort, "failed");
        assert_eq!(dto.probe_temperature, "never");
        assert!(dto.probe_note.as_deref().unwrap().contains("丢弃 effort"));
        assert!(dto.inject_temperature_allowed, "思考档失败不得关掉采样参数");
    }

    #[test]
    fn sampling_failed_blocks_temperature_not_effort() {
        let gw = gw_with_probe_fields(
            false,
            ProbeStatus::Failed,
            Some("grok-4"),
            "https://example.com",
        );
        let dto = surface_for(
            "claude-code",
            "grok-4",
            Some(&gw),
            Some(Slot::Anthropic),
            true,
            &["grok-4".into()],
            false,
        );
        assert_eq!(dto.probe_temperature, "failed");
        assert!(!dto.inject_temperature_allowed);
        assert_eq!(dto.probe_effort, "passed");
        assert!(dto.inject_effort_allowed);
    }

    #[test]
    fn other_model_probe_does_not_block_current() {
        let gw = gw_with_probe_fields(
            true,
            ProbeStatus::Never,
            Some("model-a"),
            "https://example.com",
        );
        let dto = surface_for(
            "claude-code",
            "grok-4",
            Some(&gw),
            Some(Slot::Anthropic),
            true,
            &["grok-4".into()],
            false,
        );
        assert_eq!(dto.probe_effort, "never");
        assert!(dto.inject_effort_allowed);
    }

    #[test]
    fn agy_official_and_api_effort_surface() {
        use crate::profiles::AccountType;
        let make_profile = |account_type: AccountType, models: &[&str]| {
            let mut p = profile_with("agy", models, None);
            p.account_type = account_type;
            if account_type == AccountType::Official {
                p.base_url = None;
            }
            p
        };

        // 官方账号未列模型（走 CLI 默认 Gemini 模型）：放行思考档（low/medium/high）
        let official_empty = make_profile(AccountType::Official, &[]);
        let s_empty = surface_for_profile(&official_empty, None);
        assert!(s_empty.thinking);
        assert!(s_empty.inject_effort_allowed);
        assert_eq!(s_empty.effort_levels, vec!["low", "medium", "high"]);

        // 官方账号选带后缀的 Gemini 模型：可注入并给该族档位表
        let s_flash = surface_for_profile(&official_empty, Some("gemini-3.8-flash-high"));
        assert!(s_flash.inject_effort_allowed);
        assert_eq!(s_flash.effort_levels, vec!["low", "medium", "high"]);

        let s_pro = surface_for_profile(&official_empty, Some("gemini-3.1-pro-low"));
        assert!(s_pro.inject_effort_allowed);
        assert_eq!(s_pro.effort_levels, vec!["low", "high"]);

        // 官方账号选非 Gemini 族（agy CLI 对 claude-sonnet-4-6 传 --effort 会 rc=1 报错）：禁用注入
        let s_claude = surface_for_profile(&official_empty, Some("claude-sonnet-4-6"));
        assert!(!s_claude.inject_effort_allowed);
        assert!(s_claude.effort_levels.is_empty());

        // API 连接：gemini-4-hydrogen 支持 xhigh 四档，gemini-4-carbon 支持三档
        let api_prof = make_profile(AccountType::Api, &["gemini-4-carbon", "gemini-4-hydrogen"]);
        let s_carbon = surface_for_profile(&api_prof, Some("gemini-4-carbon"));
        assert!(s_carbon.inject_effort_allowed);
        assert_eq!(s_carbon.effort_levels, vec!["low", "medium", "high"]);

        let s_hydrogen = surface_for_profile(&api_prof, Some("gemini-4-hydrogen"));
        assert!(s_hydrogen.inject_effort_allowed);
        assert_eq!(s_hydrogen.effort_levels, vec!["low", "medium", "high", "xhigh"]);
    }
}
