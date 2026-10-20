//! 网关 + 绑定持久化与从旧 profiles.json 的一次性迁移。
//! Profile 仍是启动/列表用的扁平视图（由 Binding × Gateway 物化）。

use crate::profiles::{
    AccountType, Binding, BindingKind, Gateway, GatewayModel, ProbeStatus, Profile, ProtocolSlots,
    RequestPolicy, SlotProbeSummary,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    Anthropic,
    Openai,
    Responses,
    Gemini,
    Cursor,
}

impl Slot {
    pub fn as_str(self) -> &'static str {
        match self {
            Slot::Anthropic => "anthropic",
            Slot::Openai => "openai",
            Slot::Responses => "responses",
            Slot::Gemini => "gemini",
            Slot::Cursor => "cursor",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "anthropic" => Some(Slot::Anthropic),
            "openai" => Some(Slot::Openai),
            "responses" => Some(Slot::Responses),
            "gemini" => Some(Slot::Gemini),
            "cursor" => Some(Slot::Cursor),
            _ => None,
        }
    }
}

pub fn slot_for_agent(agent: &str, protocol: Option<&str>) -> Slot {
    match agent {
        "claude-code" | "codebuddy" => Slot::Anthropic,
        "codex" => Slot::Responses,
        "gemini" => Slot::Gemini,
        "cursor" => Slot::Cursor,
        "qwen" | "kimi" if protocol == Some("anthropic") => Slot::Anthropic,
        _ => Slot::Openai,
    }
}

pub fn slot_url<'a>(slots: &'a ProtocolSlots, slot: Slot) -> Option<&'a str> {
    match slot {
        Slot::Anthropic => slots.anthropic.as_deref(),
        Slot::Openai => slots.openai.as_deref(),
        Slot::Responses => slots.responses.as_deref(),
        Slot::Gemini => slots.gemini.as_deref(),
        Slot::Cursor => slots.cursor.as_deref(),
    }
    .filter(|s| !s.trim().is_empty())
}

/// 按槽合并模型目录：只把本槽先前 fetched 的缺失 id 标 stale，其它槽的目录保留。
pub(crate) fn apply_fetched_catalog(
    gw: &mut Gateway,
    slot: &str,
    ids: &[String],
    fetched_at: &str,
) {
    let id_set: HashSet<&str> = ids.iter().map(String::as_str).collect();
    for model in gw.models.iter_mut().filter(|m| m.source == "fetched") {
        let belongs = model.catalog_slot.as_deref() == Some(slot)
            || (model.catalog_slot.is_none() && gw.catalog_from_slot.as_deref() == Some(slot));
        if belongs && !id_set.contains(model.id.as_str()) {
            model.status = "stale".into();
        }
    }
    for id in ids {
        if !gw.models.iter().any(|m| m.id == *id) {
            gw.models.push(GatewayModel {
                id: id.clone(),
                source: "fetched".into(),
                status: "available".into(),
                last_seen_at: Some(fetched_at.to_string()),
                catalog_slot: Some(slot.to_string()),
                temperature: None,
                top_p: None,
                max_output_tokens: None,
                reasoning_effort: None,
            });
        } else if let Some(model) = gw.models.iter_mut().find(|m| m.id == *id) {
            model.status = "available".into();
            model.last_seen_at = Some(fetched_at.to_string());
            model.catalog_slot = Some(slot.to_string());
        }
    }
    gw.catalog_fetched_at = Some(fetched_at.to_string());
    gw.catalog_from_slot = Some(slot.to_string());
}

pub fn set_slot_url(slots: &mut ProtocolSlots, slot: Slot, url: Option<String>) {
    let url = url.filter(|s| !s.trim().is_empty());
    match slot {
        Slot::Anthropic => slots.anthropic = url,
        Slot::Openai => slots.openai = url,
        Slot::Responses => slots.responses = url,
        Slot::Gemini => slots.gemini = url,
        Slot::Cursor => slots.cursor = url,
    }
}

/// URL 归一化：大小写、默认端口、尾斜杠这些「写法差异」不该影响指纹。
/// `https://API.example.com:443/v1/` 与 `https://api.example.com/v1` 是同一个端点，
/// 归一前会算出两个指纹，于是改一个尾斜杠就把体检结论判成失效（用户反复点测试、
/// 列表里永远「未测试」）。scheme 与 host 按 RFC 3986 本就不区分大小写，默认端口
/// 与空 path 等价，故这些归一是纯无损的；path 保留原大小写（可能真的区分）。
fn normalize_url(url: &str) -> String {
    let trimmed = url.trim();
    let Ok(mut parsed) = reqwest::Url::parse(trimmed) else {
        // 解析不了（用户半截输入）就只做保守处理，别把原文改坏。
        return trimmed.trim_end_matches('/').to_string();
    };
    let _ = parsed.set_fragment(None);
    if parsed.path() == "/" {
        // `https://example.com` 与 `https://example.com/` 是同一个端点，
        // 统一成无尾斜杠，与旧口径一致（旧记录因此不会误失效）。
        let _ = parsed.set_path("");
    }
    let normalized = parsed.as_str().trim_end_matches('/').to_string();
    // 解析成功但产生了别的形态（如 punycode 化）时，仍以能还原出原文为准。
    if normalized.is_empty() {
        trimmed.trim_end_matches('/').to_string()
    } else {
        normalized
    }
}

pub fn url_fingerprint(url: &str) -> String {
    format!("{:x}", md5::compute(normalize_url(url).as_bytes()))
}

pub fn key_presence_fp(has_key: bool) -> String {
    if has_key {
        "has".into()
    } else {
        "none".into()
    }
}

pub fn gateway_content_revision(gateway: &Gateway) -> String {
    let mut models: Vec<String> = gateway
        .models
        .iter()
        .map(|m| {
            format!(
                "{}:{}:{:?}:{:?}:{:?}:{:?}",
                m.id, m.status, m.temperature, m.top_p, m.max_output_tokens, m.reasoning_effort
            )
        })
        .collect();
    models.sort();
    let raw = format!(
        "{}|{}|{}|{}|{}|{}|{}|{}",
        gateway.name,
        gateway.no_auth,
        serde_json::to_string(&gateway.slots).unwrap_or_default(),
        serde_json::to_string(&gateway.header_env).unwrap_or_default(),
        gateway.key_hint.as_deref().unwrap_or(""),
        models.join(";"),
        gateway.wallet_user_id.as_deref().unwrap_or(""),
        gateway.wallet_key_hint.as_deref().unwrap_or("")
    );
    format!("{:x}", md5::compute(raw.as_bytes()))
}

pub fn probe_field_status(
    gateway: &Gateway,
    slot: Slot,
    field: &str,
    model: Option<&str>,
) -> ProbeStatus {
    probe_field_status_with_key(gateway, slot, field, model, gateway.key_hint.is_some())
}

/// 同上，但「密钥有无」由调用方给出：连接状态徽标拿的是 keys.json 的权威判定，
/// 不能依赖可能失配的 `gateway.key_hint`（旧钥匙串迁移只写 keys.json、不补 hint，
/// 于是 hint=None 会让明明有密钥的体检结论被判成「未体检」）。
pub fn probe_field_status_with_key(
    gateway: &Gateway,
    slot: Slot,
    field: &str,
    model: Option<&str>,
    has_key: bool,
) -> ProbeStatus {
    let slot_s = slot.as_str();
    let url = slot_url(&gateway.slots, slot).unwrap_or("");
    let url_fp = url_fingerprint(url);
    let key_fp = key_presence_fp(has_key);
    let rec = gateway
        .last_probe
        .iter()
        .filter(|p| p.slot == slot_s)
        .filter(|p| p.url_fp == url_fp && p.key_fp == key_fp)
        .filter(|p| match model.map(str::trim).filter(|m| !m.is_empty()) {
            Some(m) => p.model.as_deref() == Some(m),
            None => p.model.as_deref().is_none() || p.model.as_deref() == Some(""),
        })
        .max_by_key(|p| p.probed_at.as_str());
    let Some(rec) = rec else {
        return ProbeStatus::Never;
    };
    match field {
        "effort" => rec.effort,
        "temperature" | "top_p" | "sampling" => rec.sampling,
        "headers" => rec.headers,
        "streaming" => rec.streaming,
        "basic" => rec.basic,
        _ => ProbeStatus::Never,
    }
}

/// 体检结果只对写下时的地址/密钥指纹有效。网关已改则丢弃迟到的回包。
/// `has_key` 由调用方从密钥库权威获取，不得依赖 `key_hint`（key_hint 只是显示提示，可与实际状态不同步）。
pub fn probe_record_still_valid(
    gateway: &Gateway,
    rec: &crate::profiles::ProbeRecord,
    has_key: bool,
) -> bool {
    let Some(slot) = Slot::from_str(&rec.slot) else {
        return false;
    };
    let url = slot_url(&gateway.slots, slot).unwrap_or("");
    rec.url_fp == url_fingerprint(url) && rec.key_fp == key_presence_fp(has_key)
}

pub fn invalidate_slot_probes(gateway: &mut Gateway, slot: Slot) {
    let s = slot.as_str();
    gateway.last_probe.retain(|p| p.slot != s);
}

pub fn invalidate_all_probes(gateway: &mut Gateway) {
    gateway.last_probe.clear();
}

/// 每槽取 probed_at 最新的一条，做成列表摘要。延迟数值不参与语义，只原样带出。
pub fn slot_probe_summaries(probes: &[crate::profiles::ProbeRecord]) -> Vec<SlotProbeSummary> {
    use std::collections::BTreeMap;
    let mut latest: BTreeMap<&str, &crate::profiles::ProbeRecord> = BTreeMap::new();
    for rec in probes {
        match latest.get(rec.slot.as_str()) {
            Some(prev) if prev.probed_at.as_str() >= rec.probed_at.as_str() => {}
            _ => {
                latest.insert(rec.slot.as_str(), rec);
            }
        }
    }
    latest
        .into_iter()
        .map(|(slot, rec)| SlotProbeSummary {
            slot: slot.to_string(),
            last_latency_ms: rec.latency_ms,
            last_probe_at: Some(rec.probed_at.clone()),
            last_ok: match rec.basic {
                ProbeStatus::Passed => Some(true),
                ProbeStatus::Failed => Some(false),
                ProbeStatus::Never => None,
            },
        })
        .collect()
}

// ===== 磁盘 =====

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MergeJournal {
    pub version: u32,
    pub entries: Vec<MergeEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeEntry {
    pub discarded_id: String,
    pub kept_id: String,
    pub agent: String,
    pub gateway_id: String,
    pub models: Vec<String>,
    pub extra_env: HashMap<String, String>,
    #[serde(default)]
    pub protocol: Option<String>,
    /// 被合并掉的连接名（还原时用作新网关名）
    #[serde(default)]
    pub name: Option<String>,
}

/// 配置目录。走 `storage::config_root()` 而不是直接问 `dirs`，因为测试要能把
/// 整个配置根重定向到临时目录——这里读写的 gateways.json/bindings.json 是真实用户数据，
/// 以前测试留下的假网关会真的出现在网关库里（见 `config_root` 的注释）。
fn config_dir() -> Result<PathBuf, String> {
    crate::storage::config_root().ok_or_else(|| "无法确定平台配置目录".to_string())
}

pub fn gateways_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("gateways.json"))
}

pub fn bindings_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("bindings.json"))
}

pub fn merge_journal_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("gateway-merge.json"))
}

pub fn read_json_vec<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|e| format!("解析 {} 失败: {e}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("读取 {} 失败: {e}", path.display())),
    }
}

pub fn write_json_vec<T: Serialize>(path: &Path, items: &[T]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(path, &text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn load_gateways() -> Result<Vec<Gateway>, String> {
    read_json_vec(&gateways_path()?)
}

pub fn load_bindings() -> Result<Vec<Binding>, String> {
    read_json_vec(&bindings_path()?)
}

pub fn save_gateways(items: &[Gateway]) -> Result<(), String> {
    write_json_vec(&gateways_path()?, items)
}

pub fn save_bindings(items: &[Binding]) -> Result<(), String> {
    write_json_vec(&bindings_path()?, items)
}

pub fn find_gateway(id: &str) -> Option<Gateway> {
    load_gateways().ok()?.into_iter().find(|g| g.id == id)
}

/// 槽对应的「探针用」Agent：决定 /models 与 chat 端点形态。
pub fn agent_for_slot(slot: Slot) -> &'static str {
    match slot {
        Slot::Anthropic => "claude-code",
        Slot::Openai => "opencode",
        Slot::Responses => "codex",
        Slot::Gemini => "gemini",
        Slot::Cursor => "cursor",
    }
}

/// 把合并清单里被吞的绑定还原回去。
/// 同一 `(agent, gateway)` 已有绑定时克隆网关（新 id + 复制密钥），否则绑回原网关。
/// 返回 (还原条数, 需要复制密钥的 from→to)。
pub fn restore_merged_bindings(
    journal: &MergeJournal,
    gateways: &mut Vec<Gateway>,
    bindings: &mut Vec<Binding>,
) -> (usize, Vec<(String, String)>) {
    let mut restored = 0;
    let mut key_copies = Vec::new();
    for e in &journal.entries {
        if bindings.iter().any(|b| b.id == e.discarded_id) {
            continue;
        }
        let collision = bindings
            .iter()
            .any(|b| b.agent == e.agent && b.gateway_id.as_deref() == Some(e.gateway_id.as_str()));
        let gid = if collision {
            let Some(src) = gateways.iter().find(|g| g.id == e.gateway_id).cloned() else {
                continue;
            };
            let mut gw = src.clone();
            gw.id = uuid::Uuid::new_v4().to_string();
            gw.name = e
                .name
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("{}（还原）", src.name));
            gw.last_probe.clear();
            gw.slot_probes.clear();
            key_copies.push((src.id, gw.id.clone()));
            let new_id = gw.id.clone();
            gateways.push(gw);
            new_id
        } else {
            e.gateway_id.clone()
        };
        bindings.push(Binding {
            id: e.discarded_id.clone(),
            agent: e.agent.clone(),
            name: e
                .name
                .clone()
                .unwrap_or_else(|| format!("{}（还原）", e.agent)),
            kind: BindingKind::Api,
            gateway_id: Some(gid),
            protocol: e.protocol.clone(),
            api_backend: None,
            models: e.models.clone(),
            role_models: Default::default(),
            extra_env: e.extra_env.clone(),
            last_used_at: None,
        });
        restored += 1;
    }
    (restored, key_copies)
}

// ===== 物化 =====

pub fn materialize(
    binding: &Binding,
    gateway: Option<&Gateway>,
    selected_model: Option<&str>,
) -> Profile {
    let official = binding.kind == BindingKind::Official;
    let (name, no_auth, key_hint, has_key, header_env, slot_url, slot_missing, models_policy) =
        if official {
            (
                "官方账号".to_string(),
                false,
                None,
                false,
                BTreeMap::new(),
                None,
                false,
                None,
            )
        } else if let Some(g) = gateway {
            let slot = slot_for_agent(&binding.agent, binding.protocol.as_deref());
            let url = slot_url(&g.slots, slot).map(str::to_string).map(|u| {
                // gemini CLI 对 GOOGLE_GEMINI_BASE_URL 无条件自拼 /v1beta/…、Claude Code 对
                // ANTHROPIC_BASE_URL 自拼 /v1/messages（2026-10-19 本机探针实测，双版本段 404）。
                // 用户把 OpenAI 风格 /v1 地址填进这两个槽是常态（网关保存还把主地址折进全部槽），
                // 物化时剥掉末尾版本段，启动注入 / 设为全局 / 拉目录拿到的都是 CLI 真正要的 base。
                // 仅限已实证自拼版本段的两家；codebuddy / qwen、kimi 的 anthropic 协议通道未实证，不动。
                match binding.agent.as_str() {
                    "gemini" | "claude-code" => {
                        crate::models::strip_trailing_version_segment(&u)
                    }
                    _ => u,
                }
            });
            let missing = url.is_none();
            let model_id = selected_model
                .filter(|m| !m.is_empty())
                .or_else(|| binding.models.first().map(String::as_str));
            let gm = model_id.and_then(|id| g.models.iter().find(|m| m.id == id));
            (
                if binding.name.trim().is_empty() {
                    g.name.clone()
                } else {
                    binding.name.clone()
                },
                g.no_auth,
                g.key_hint.clone(),
                false, // has_key 由调用方填
                g.header_env.clone(),
                url,
                missing,
                gm,
            )
        } else {
            (
                "(缺失网关)".into(),
                false,
                None,
                false,
                BTreeMap::new(),
                None,
                true,
                None,
            )
        };

    let mut request_policy = RequestPolicy {
        header_env,
        ..Default::default()
    };
    if let Some(m) = models_policy {
        request_policy.temperature = m.temperature;
        request_policy.top_p = m.top_p;
        request_policy.max_output_tokens = m.max_output_tokens;
        request_policy.reasoning_effort = m
            .reasoning_effort
            .as_deref()
            .and_then(crate::agent_specs::launch_reasoning_effort);
    }

    let (connection_status, model_sync_status, model_sync_note) =
        connection_state(binding, gateway, slot_missing, has_key, official);

    Profile {
        id: binding.id.clone(),
        agent: binding.agent.clone(),
        name,
        account_type: if official {
            AccountType::Official
        } else {
            AccountType::Api
        },
        no_auth,
        protocol: binding.protocol.clone(),
        api_backend: binding.api_backend.clone(),
        base_url: slot_url,
        models: binding.models.clone(),
        role_models: binding.role_models.clone(),
        extra_env: binding.extra_env.clone(),
        request_policy,
        key_hint,
        model: None,
        last_used_at: binding.last_used_at.clone(),
        has_key,
        gateway_id: binding.gateway_id.clone(),
        slot_missing,
        connection_status,
        model_sync_status,
        model_sync_note,
        provider_override: None,
    }
}

fn connection_state(
    binding: &Binding,
    gateway: Option<&Gateway>,
    slot_missing: bool,
    has_key: bool,
    official: bool,
) -> (String, String, Option<String>) {
    if official {
        return ("official".into(), "unknown".into(), None);
    }
    let Some(gateway) = gateway else {
        return (
            "gateway_missing".into(),
            "missing".into(),
            Some("绑定的网关已不存在".into()),
        );
    };
    let model_ids: std::collections::HashSet<&str> =
        gateway.models.iter().map(|m| m.id.as_str()).collect();
    let missing: Vec<&str> = binding
        .models
        .iter()
        .filter(|m| !model_ids.contains(m.as_str()))
        .map(String::as_str)
        .collect();
    let stale: Vec<&str> = binding
        .models
        .iter()
        .filter(|m| {
            gateway
                .models
                .iter()
                .any(|g| g.id == **m && g.status == "stale")
        })
        .map(String::as_str)
        .collect();
    let model_sync = if binding.models.is_empty() || gateway.models.is_empty() {
        ("unknown".into(), None)
    } else if !missing.is_empty() {
        (
            "missing".into(),
            Some(format!("绑定模型不在网关目录：{}", missing.join("、"))),
        )
    } else if !stale.is_empty() {
        (
            "stale".into(),
            Some(format!("网关目录已标记历史失效：{}", stale.join("、"))),
        )
    } else {
        ("synced".into(), None)
    };
    let status = if slot_missing {
        "slot_missing"
    } else if !gateway.no_auth && !has_key {
        "credential_missing"
    } else {
        let slot = slot_for_agent(&binding.agent, binding.protocol.as_deref());
        // §8：消费必须匹配「当前槽 + 当前绑定模型 + URL/密钥指纹」，禁用「该槽最近一条」
        // ——否则同网关 A 模型的体检结论会株连选了 B 模型的绑定（与 probe_field_status 同口径）。
        let probe = probe_field_status_with_key(
            gateway,
            slot,
            "basic",
            binding.models.first().map(String::as_str),
            has_key,
        );
        match probe {
            crate::profiles::ProbeStatus::Failed => "probe_failed",
            crate::profiles::ProbeStatus::Passed => {
                if model_sync.0 == "missing" || model_sync.0 == "stale" {
                    "model_unsynced"
                } else if gateway
                    .catalog_fetched_at
                    .as_deref()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .is_some_and(|t| {
                        chrono::Utc::now() - t.with_timezone(&chrono::Utc)
                            > chrono::Duration::days(7)
                    })
                {
                    "catalog_stale"
                } else {
                    "ready"
                }
            }
            _ => "untested",
        }
    };
    (status.into(), model_sync.0, model_sync.1)
}

pub fn refresh_profile_connection_state(
    profile: &mut Profile,
    binding: &Binding,
    gateway: Option<&Gateway>,
) {
    let (connection_status, model_sync_status, model_sync_note) = connection_state(
        binding,
        gateway,
        profile.slot_missing,
        profile.has_key,
        profile.account_type == crate::profiles::AccountType::Official,
    );
    profile.connection_status = connection_status;
    profile.model_sync_status = model_sync_status;
    profile.model_sync_note = model_sync_note;
}

// ===== 迁移 =====

#[derive(Debug, Serialize, Deserialize)]
pub struct MigrationResult {
    pub gateways: Vec<Gateway>,
    pub bindings: Vec<Binding>,
    pub keys: HashMap<String, String>,
    pub journal: MergeJournal,
    pub rewrites: Vec<(String, String)>, // discarded -> kept
}

fn key_fingerprint(key: &str) -> String {
    format!("{:x}", md5::compute(key.as_bytes()))
}

fn last_used_rank(iso: &Option<String>) -> &str {
    iso.as_deref().unwrap_or("")
}

/// 把旧连接级 RequestPolicy 摊到模型条目上；冲突时较新的赢。
fn apply_policy_to_models(
    models: &mut Vec<GatewayModel>,
    ids: &[String],
    policy: &RequestPolicy,
    newer: bool,
) {
    for id in ids {
        if !models.iter().any(|m| m.id == *id) {
            models.push(GatewayModel {
                id: id.clone(),
                source: "user".into(),
                status: "available".into(),
                last_seen_at: None,
                catalog_slot: None,
                temperature: None,
                top_p: None,
                max_output_tokens: None,
                reasoning_effort: None,
            });
        }
        if let Some(m) = models.iter_mut().find(|m| m.id == *id) {
            merge_opt(&mut m.temperature, policy.temperature, newer);
            merge_opt(&mut m.top_p, policy.top_p, newer);
            merge_opt(&mut m.max_output_tokens, policy.max_output_tokens, newer);
            merge_opt_s(
                &mut m.reasoning_effort,
                policy.reasoning_effort.clone(),
                newer,
            );
        }
    }
}

fn merge_opt<T: PartialEq>(slot: &mut Option<T>, incoming: Option<T>, newer: bool) {
    match (&*slot, incoming) {
        (None, Some(v)) => *slot = Some(v),
        (Some(_), Some(v)) if newer => *slot = Some(v),
        _ => {}
    }
}

fn merge_opt_s(slot: &mut Option<String>, incoming: Option<String>, newer: bool) {
    merge_opt(slot, incoming, newer);
}

fn merge_headers(
    into: &mut BTreeMap<String, String>,
    from: &BTreeMap<String, String>,
    newer: bool,
) {
    for (k, v) in from {
        if newer || !into.contains_key(k) {
            into.insert(k.clone(), v.clone());
        }
    }
}

pub fn migrate_from_profiles(
    old: Vec<Profile>,
    old_keys: HashMap<String, String>,
) -> MigrationResult {
    let mut official: Vec<Binding> = Vec::new();
    let mut api: Vec<Profile> = Vec::new();
    for p in old {
        if p.account_type == AccountType::Official {
            official.push(Binding {
                id: p.id,
                agent: p.agent,
                name: p.name,
                kind: BindingKind::Official,
                gateway_id: None,
                protocol: None,
                api_backend: None,
                models: p.models,
                role_models: p.role_models,
                extra_env: p.extra_env,
                last_used_at: p.last_used_at,
            });
        } else {
            api.push(p);
        }
    }

    // 分组键：有密钥 → 指纹；无密钥 → "noauth|" + 规范化 URL
    fn group_key(p: &Profile, keys: &HashMap<String, String>) -> String {
        if let Some(k) = keys.get(&p.id).filter(|s| !s.is_empty()) {
            format!("k:{}", key_fingerprint(k))
        } else {
            format!(
                "n:{}|{}",
                p.no_auth,
                p.base_url.as_deref().map(normalize_url).unwrap_or_default()
            )
        }
    }

    let mut groups: BTreeMap<String, Vec<Profile>> = BTreeMap::new();
    for p in api {
        groups.entry(group_key(&p, &old_keys)).or_default().push(p);
    }

    let mut gateways = Vec::new();
    let mut bindings = official;
    let mut journal = MergeJournal {
        version: 1,
        entries: Vec::new(),
    };
    let mut rewrites = Vec::new();
    let mut new_keys: HashMap<String, String> = HashMap::new();

    for (_gk, mut members) in groups {
        members
            .sort_by(|a, b| last_used_rank(&b.last_used_at).cmp(last_used_rank(&a.last_used_at)));
        // 同一密钥下按槽拆网关：同槽不同 URL 不能合
        let mut buckets: Vec<Vec<Profile>> = Vec::new();
        'place: for p in members {
            let slot = slot_for_agent(&p.agent, p.protocol.as_deref());
            let url = p.base_url.as_deref().map(normalize_url);
            for bucket in &mut buckets {
                let conflict = bucket.iter().any(|q| {
                    let qs = slot_for_agent(&q.agent, q.protocol.as_deref());
                    qs == slot
                        && q.base_url.as_deref().map(normalize_url) != url
                        && url.is_some()
                        && q.base_url.as_ref().is_some()
                });
                if !conflict {
                    bucket.push(p);
                    continue 'place;
                }
            }
            buckets.push(vec![p]);
        }

        for bucket in buckets {
            let gw_id = uuid::Uuid::new_v4().to_string();
            let name = bucket
                .iter()
                .max_by_key(|p| last_used_rank(&p.last_used_at))
                .map(|p| p.name.clone())
                .unwrap_or_else(|| "未命名网关".into());
            let no_auth = bucket.iter().any(|p| p.no_auth);
            let mut slots = ProtocolSlots::default();
            let mut header_env = BTreeMap::new();
            let mut models: Vec<GatewayModel> = Vec::new();
            let mut key_hint = None;
            let mut key_val: Option<String> = None;

            for (i, p) in bucket.iter().enumerate() {
                let slot = slot_for_agent(&p.agent, p.protocol.as_deref());
                if slot_url(&slots, slot).is_none() {
                    set_slot_url(&mut slots, slot, p.base_url.clone());
                }
                // 桶已按 lastUsedAt 新→旧；只有第一条是「较新」，后面只填空不覆盖
                let newer = i == 0;
                merge_headers(&mut header_env, &p.request_policy.header_env, newer);
                apply_policy_to_models(&mut models, &p.models, &p.request_policy, newer);
                if key_hint.is_none() {
                    key_hint = p.key_hint.clone();
                }
                if key_val.is_none() {
                    key_val = old_keys.get(&p.id).cloned();
                }
            }
            if let Some(k) = key_val {
                new_keys.insert(gw_id.clone(), k);
            }

            // 按 (agent) 合并绑定
            let mut by_agent: BTreeMap<String, Vec<&Profile>> = BTreeMap::new();
            for p in &bucket {
                by_agent.entry(p.agent.clone()).or_default().push(p);
            }
            for (agent, mut list) in by_agent {
                list.sort_by(|a, b| {
                    last_used_rank(&b.last_used_at).cmp(last_used_rank(&a.last_used_at))
                });
                let kept = list[0];
                let mut models_list = kept.models.clone();
                let mut seen: HashSet<String> = models_list.iter().cloned().collect();
                for other in list.iter().skip(1) {
                    for m in &other.models {
                        if seen.insert(m.clone()) {
                            models_list.push(m.clone());
                        }
                    }
                    journal.entries.push(MergeEntry {
                        discarded_id: other.id.clone(),
                        kept_id: kept.id.clone(),
                        agent: agent.clone(),
                        gateway_id: gw_id.clone(),
                        models: other.models.clone(),
                        extra_env: other.extra_env.clone(),
                        protocol: other.protocol.clone(),
                        name: Some(other.name.clone()),
                    });
                    rewrites.push((other.id.clone(), kept.id.clone()));
                }
                bindings.push(Binding {
                    id: kept.id.clone(),
                    agent,
                    name: kept.name.clone(),
                    kind: BindingKind::Api,
                    gateway_id: Some(gw_id.clone()),
                    protocol: kept.protocol.clone(),
                    api_backend: None,
                    models: models_list,
                    role_models: kept.role_models.clone(),
                    extra_env: kept.extra_env.clone(),
                    last_used_at: kept.last_used_at.clone(),
                });
            }

            gateways.push(Gateway {
                id: gw_id,
                name,
                no_auth,
                key_hint,
                wallet_user_id: None,
                wallet_key_hint: None,
                slots,
                header_env,
                models,
                catalog_fetched_at: None,
                catalog_from_slot: None,
                last_probe: Vec::new(),
                slot_probes: Vec::new(),
                revision: String::new(),
            });
        }
    }

    MigrationResult {
        gateways,
        bindings,
        keys: new_keys,
        journal,
        rewrites,
    }
}

pub fn apply_rewrites_to_settings_and_schedules(
    rewrites: &[(String, String)],
) -> Result<(), String> {
    if rewrites.is_empty() {
        return Ok(());
    }
    crate::settings::rewrite_profile_refs(rewrites)?;
    crate::scheduler::rewrite_profile_ids(rewrites)?;
    crate::sessions::rewrite_session_profile_ids(rewrites)?;
    Ok(())
}

pub fn split_migrated() -> bool {
    bindings_path()
        .ok()
        .and_then(|p| fs::metadata(p).ok())
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(
        id: &str,
        agent: &str,
        name: &str,
        url: &str,
        models: &[&str],
        last: Option<&str>,
    ) -> Profile {
        Profile {
            id: id.into(),
            agent: agent.into(),
            name: name.into(),
            account_type: AccountType::Api,
            no_auth: false,
            protocol: None,
            api_backend: None,
            base_url: Some(url.into()),
            models: models.iter().map(|s| s.to_string()).collect(),
            role_models: Default::default(),
            extra_env: HashMap::new(),
            request_policy: RequestPolicy {
                reasoning_effort: Some("high".into()),
                ..Default::default()
            },
            key_hint: Some("···abcd".into()),
            model: None,
            last_used_at: last.map(|s| s.into()),
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
    fn slot_table_matches_spec() {
        assert_eq!(slot_for_agent("claude-code", None), Slot::Anthropic);
        assert_eq!(slot_for_agent("codex", None), Slot::Responses);
        assert_eq!(slot_for_agent("gemini", None), Slot::Gemini);
        assert_eq!(slot_for_agent("cursor", None), Slot::Cursor);
        assert_eq!(slot_for_agent("grok", None), Slot::Openai);
        assert_eq!(slot_for_agent("opencode", None), Slot::Openai);
        assert_eq!(slot_for_agent("kimi", Some("anthropic")), Slot::Anthropic);
        assert_eq!(slot_for_agent("kimi", Some("kimi")), Slot::Openai);
        assert_eq!(slot_for_agent("qwen", None), Slot::Openai);
        assert_eq!(slot_for_agent("codebuddy", None), Slot::Anthropic);
    }

    fn fetched(id: &str, slot: Option<&str>) -> GatewayModel {
        GatewayModel {
            id: id.into(),
            source: "fetched".into(),
            status: "available".into(),
            last_seen_at: None,
            catalog_slot: slot.map(str::to_string),
            temperature: None,
            top_p: None,
            max_output_tokens: None,
            reasoning_effort: None,
        }
    }

    #[test]
    fn apply_fetched_catalog_stales_only_same_slot() {
        let mut gw = Gateway {
            id: "g".into(),
            name: "G".into(),
            no_auth: false,
            key_hint: None,
            wallet_user_id: None,
            wallet_key_hint: None,
            slots: ProtocolSlots::default(),
            header_env: Default::default(),
            models: vec![
                fetched("oa-1", Some("openai")),
                fetched("an-1", Some("anthropic")),
            ],
            catalog_fetched_at: None,
            catalog_from_slot: Some("openai".into()),
            last_probe: Vec::new(),
            slot_probes: Vec::new(),
            revision: String::new(),
        };
        apply_fetched_catalog(&mut gw, "anthropic", &["an-2".into()], "t");
        let by_id: HashMap<_, _> = gw
            .models
            .iter()
            .map(|m| (m.id.as_str(), m.status.as_str()))
            .collect();
        assert_eq!(by_id["oa-1"], "available");
        assert_eq!(by_id["an-1"], "stale");
        assert_eq!(by_id["an-2"], "available");
        assert_eq!(gw.catalog_from_slot.as_deref(), Some("anthropic"));
    }

    #[test]
    fn same_key_different_agents_one_gateway() {
        let mut keys = HashMap::new();
        keys.insert("p-claude".into(), "sk-same".into());
        keys.insert("p-codex".into(), "sk-same".into());
        let old = vec![
            p(
                "p-claude",
                "claude-code",
                "NewAPI",
                "https://api.example.com",
                &["claude-sonnet"],
                Some("2026-01-02"),
            ),
            {
                let mut x = p(
                    "p-codex",
                    "codex",
                    "NewAPI",
                    "https://api.example.com/v1",
                    &["gpt-5"],
                    Some("2026-01-01"),
                );
                x.request_policy.reasoning_effort = Some("low".into());
                x
            },
        ];
        let r = migrate_from_profiles(old, keys);
        assert_eq!(r.gateways.len(), 1);
        assert_eq!(r.bindings.len(), 2);
        assert!(r
            .bindings
            .iter()
            .all(|b| b.id == "p-claude" || b.id == "p-codex"));
        let gw = &r.gateways[0];
        assert!(gw
            .slots
            .anthropic
            .as_deref()
            .unwrap()
            .contains("example.com"));
        assert!(gw.slots.responses.as_deref().unwrap().contains("/v1"));
        assert_eq!(r.keys.len(), 1);
        assert!(r.keys.contains_key(&gw.id));
        // 策略摊到各自模型
        assert_eq!(
            gw.models
                .iter()
                .find(|m| m.id == "claude-sonnet")
                .unwrap()
                .reasoning_effort
                .as_deref(),
            Some("high")
        );
        assert_eq!(
            gw.models
                .iter()
                .find(|m| m.id == "gpt-5")
                .unwrap()
                .reasoning_effort
                .as_deref(),
            Some("low")
        );
    }

    #[test]
    fn same_slot_url_conflict_splits_gateways() {
        let mut keys = HashMap::new();
        keys.insert("a".into(), "sk-same".into());
        keys.insert("b".into(), "sk-same".into());
        let old = vec![
            p(
                "a",
                "claude-code",
                "A",
                "https://one.example.com",
                &["m1"],
                None,
            ),
            p(
                "b",
                "claude-code",
                "B",
                "https://two.example.com",
                &["m2"],
                None,
            ),
        ];
        let r = migrate_from_profiles(old, keys);
        assert_eq!(r.gateways.len(), 2);
        assert_eq!(r.bindings.len(), 2);
    }

    #[test]
    fn same_agent_same_url_merges_model_lists() {
        let mut keys = HashMap::new();
        keys.insert("work".into(), "sk-same".into());
        keys.insert("cheap".into(), "sk-same".into());
        let old = vec![
            p(
                "work",
                "claude-code",
                "工作",
                "https://api.example.com",
                &["opus", "sonnet"],
                Some("2026-08-02"),
            ),
            p(
                "cheap",
                "claude-code",
                "省钱",
                "https://api.example.com",
                &["sonnet", "haiku"],
                Some("2026-08-01"),
            ),
        ];
        let r = migrate_from_profiles(old, keys);
        assert_eq!(r.gateways.len(), 1);
        assert_eq!(r.bindings.len(), 1);
        assert_eq!(r.bindings[0].id, "work");
        assert_eq!(r.bindings[0].models, vec!["opus", "sonnet", "haiku"]);
        assert_eq!(r.rewrites, vec![("cheap".into(), "work".into())]);
        assert_eq!(r.journal.entries.len(), 1);
    }

    #[test]
    fn official_keeps_id_no_gateway() {
        let mut p = p("off", "claude-code", "x", "", &[], None);
        p.account_type = AccountType::Official;
        p.base_url = None;
        let r = migrate_from_profiles(vec![p], HashMap::new());
        assert!(r.gateways.is_empty());
        assert_eq!(r.bindings.len(), 1);
        assert_eq!(r.bindings[0].kind, BindingKind::Official);
        assert_eq!(r.bindings[0].id, "off");
        assert!(r.bindings[0].gateway_id.is_none());
    }

    #[test]
    fn binding_id_not_reissued() {
        let mut keys = HashMap::new();
        keys.insert("keep-me".into(), "sk".into());
        let old = vec![p("keep-me", "gemini", "G", "https://g", &["m"], None)];
        let r = migrate_from_profiles(old, keys);
        assert_eq!(r.bindings[0].id, "keep-me");
        assert_ne!(r.gateways[0].id, "keep-me");
    }

    #[test]
    fn policy_conflict_keeps_newer_last_used() {
        let mut keys = HashMap::new();
        keys.insert("new".into(), "sk".into());
        keys.insert("old".into(), "sk".into());
        let mut newer = p(
            "new",
            "claude-code",
            "A",
            "https://api.example.com",
            &["m1"],
            Some("2026-08-02"),
        );
        newer.request_policy.reasoning_effort = Some("high".into());
        let mut older = p(
            "old",
            "claude-code",
            "B",
            "https://api.example.com",
            &["m1"],
            Some("2026-08-01"),
        );
        older.request_policy.reasoning_effort = Some("low".into());
        older.protocol = Some("anthropic".into());
        older
            .extra_env
            .insert("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into());
        let r = migrate_from_profiles(vec![older, newer], keys);
        assert_eq!(
            r.gateways[0]
                .models
                .iter()
                .find(|m| m.id == "m1")
                .unwrap()
                .reasoning_effort
                .as_deref(),
            Some("high")
        );
        assert_eq!(r.journal.entries[0].protocol.as_deref(), Some("anthropic"));
        assert_eq!(
            r.journal.entries[0]
                .extra_env
                .get("HTTPS_PROXY")
                .map(String::as_str),
            Some("http://127.0.0.1:7890")
        );
    }

    #[test]
    fn restore_merged_bindings_keeps_protocol_and_extra_env() {
        let journal = MergeJournal {
            version: 1,
            entries: vec![MergeEntry {
                discarded_id: "old".into(),
                kept_id: "new".into(),
                agent: "qwen".into(),
                gateway_id: "g1".into(),
                models: vec!["m2".into()],
                extra_env: {
                    let mut m = HashMap::new();
                    m.insert("FOO".into(), "1".into());
                    m
                },
                protocol: Some("openai".into()),
                name: Some("省钱".into()),
            }],
        };
        let mut gateways = vec![Gateway {
            id: "g1".into(),
            name: "G".into(),
            no_auth: false,
            key_hint: None,
            wallet_user_id: None,
            wallet_key_hint: None,
            slots: ProtocolSlots::default(),
            header_env: Default::default(),
            models: vec![],
            catalog_fetched_at: None,
            catalog_from_slot: None,
            last_probe: vec![],
            slot_probes: vec![],
            revision: String::new(),
        }];
        let mut bindings = vec![Binding {
            id: "new".into(),
            agent: "claude-code".into(),
            name: "NewAPI".into(),
            kind: BindingKind::Api,
            gateway_id: Some("g1".into()),
            protocol: None,
            api_backend: None,
            models: vec!["m1".into()],
            role_models: Default::default(),
            extra_env: HashMap::new(),
            last_used_at: None,
        }];
        let (n, copies) = restore_merged_bindings(&journal, &mut gateways, &mut bindings);
        assert_eq!(n, 1);
        assert!(copies.is_empty());
        let restored = bindings.iter().find(|b| b.id == "old").unwrap();
        assert_eq!(restored.protocol.as_deref(), Some("openai"));
        assert_eq!(restored.extra_env.get("FOO").map(String::as_str), Some("1"));
        assert_eq!(
            restore_merged_bindings(&journal, &mut gateways, &mut bindings).0,
            0
        );
    }

    #[test]
    fn restore_same_agent_clones_gateway_and_keeps_name() {
        let journal = MergeJournal {
            version: 1,
            entries: vec![MergeEntry {
                discarded_id: "cheap".into(),
                kept_id: "work".into(),
                agent: "claude-code".into(),
                gateway_id: "g1".into(),
                models: vec!["m-cheap".into()],
                extra_env: HashMap::new(),
                protocol: None,
                name: Some("省钱".into()),
            }],
        };
        let mut gateways = vec![Gateway {
            id: "g1".into(),
            name: "工作".into(),
            no_auth: false,
            key_hint: Some("····".into()),
            wallet_user_id: None,
            wallet_key_hint: None,
            slots: ProtocolSlots {
                anthropic: Some("https://api.example.com".into()),
                ..Default::default()
            },
            header_env: Default::default(),
            models: vec![],
            catalog_fetched_at: None,
            catalog_from_slot: None,
            last_probe: vec![],
            slot_probes: vec![],
            revision: String::new(),
        }];
        let mut bindings = vec![Binding {
            id: "work".into(),
            agent: "claude-code".into(),
            name: "work".into(),
            kind: BindingKind::Api,
            gateway_id: Some("g1".into()),
            protocol: None,
            api_backend: None,
            models: vec!["m-work".into()],
            role_models: Default::default(),
            extra_env: HashMap::new(),
            last_used_at: None,
        }];
        let (n, copies) = restore_merged_bindings(&journal, &mut gateways, &mut bindings);
        assert_eq!(n, 1);
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].0, "g1");
        assert_eq!(gateways.len(), 2);
        let new_gw = gateways.iter().find(|g| g.id == copies[0].1).unwrap();
        assert_eq!(new_gw.name, "省钱");
        let restored = bindings.iter().find(|b| b.id == "cheap").unwrap();
        assert_eq!(restored.gateway_id.as_deref(), Some(new_gw.id.as_str()));
        assert_eq!(restored.models, vec!["m-cheap"]);
    }

    #[test]
    fn materialize_uses_selected_model_policy() {
        let gw = Gateway {
            id: "g".into(),
            name: "G".into(),
            no_auth: false,
            key_hint: None,
            wallet_user_id: None,
            wallet_key_hint: None,
            slots: ProtocolSlots {
                anthropic: Some("https://a.example".into()),
                ..Default::default()
            },
            header_env: Default::default(),
            models: vec![
                GatewayModel {
                    id: "first".into(),
                    source: "user".into(),
                    status: "available".into(),
                    last_seen_at: None,
                    catalog_slot: None,
                    temperature: Some(0.1),
                    top_p: None,
                    max_output_tokens: None,
                    reasoning_effort: Some("low".into()),
                },
                GatewayModel {
                    id: "second".into(),
                    source: "user".into(),
                    status: "available".into(),
                    last_seen_at: None,
                    catalog_slot: None,
                    temperature: Some(0.9),
                    top_p: None,
                    max_output_tokens: None,
                    reasoning_effort: Some("high".into()),
                },
            ],
            catalog_fetched_at: None,
            catalog_from_slot: None,
            last_probe: Vec::new(),
            slot_probes: Vec::new(),
            revision: String::new(),
        };
        let b = Binding {
            id: "b".into(),
            agent: "claude-code".into(),
            name: "test".into(),
            kind: BindingKind::Api,
            gateway_id: Some("g".into()),
            protocol: None,
            api_backend: None,
            models: vec!["first".into(), "second".into()],
            role_models: Default::default(),
            extra_env: HashMap::new(),
            last_used_at: None,
        };
        let first = materialize(&b, Some(&gw), None);
        assert_eq!(first.name, "test");
        assert_eq!(
            first.request_policy.reasoning_effort.as_deref(),
            Some("low")
        );
        let second = materialize(&b, Some(&gw), Some("second"));
        assert_eq!(
            second.request_policy.reasoning_effort.as_deref(),
            Some("high")
        );
        assert_eq!(second.request_policy.temperature, Some(0.9));
    }

    #[test]
    fn materialize_strips_version_segment_for_self_versioning_agents() {
        // 同址网关（保存时主地址折进全部槽，OpenAI 风格 /v1 结尾）：
        // gemini / claude-code 的 CLI 自拼版本段，物化时剥掉；openai 系 CLI 直接拼
        // 资源名，/v1 是约定的一部分，原样保留
        let gw = Gateway {
            id: "g".into(),
            name: "G".into(),
            no_auth: false,
            key_hint: None,
            wallet_user_id: None,
            wallet_key_hint: None,
            slots: ProtocolSlots {
                anthropic: Some("https://relay.example.com/v1".into()),
                openai: Some("https://relay.example.com/v1".into()),
                responses: Some("https://relay.example.com/v1".into()),
                gemini: Some("https://relay.example.com/v1".into()),
                cursor: None,
            },
            header_env: Default::default(),
            models: vec![],
            catalog_fetched_at: None,
            catalog_from_slot: None,
            last_probe: Vec::new(),
            slot_probes: Vec::new(),
            revision: String::new(),
        };
        let mk = |agent: &str| Binding {
            id: format!("b-{agent}"),
            agent: agent.into(),
            name: agent.into(),
            kind: BindingKind::Api,
            gateway_id: Some("g".into()),
            protocol: None,
            api_backend: None,
            models: vec!["m".into()],
            role_models: Default::default(),
            extra_env: HashMap::new(),
            last_used_at: None,
        };
        assert_eq!(
            materialize(&mk("gemini"), Some(&gw), None).base_url.as_deref(),
            Some("https://relay.example.com")
        );
        assert_eq!(
            materialize(&mk("claude-code"), Some(&gw), None)
                .base_url
                .as_deref(),
            Some("https://relay.example.com")
        );
        // 对照组：v1beta 结尾也剥；openai 系原样
        let mut gw_beta = gw.clone();
        gw_beta.slots.gemini = Some("https://relay.example.com/v1beta".into());
        assert_eq!(
            materialize(&mk("gemini"), Some(&gw_beta), None)
                .base_url
                .as_deref(),
            Some("https://relay.example.com")
        );
        assert_eq!(
            materialize(&mk("codex"), Some(&gw), None).base_url.as_deref(),
            Some("https://relay.example.com/v1")
        );
        assert_eq!(
            materialize(&mk("opencode"), Some(&gw), None)
                .base_url
                .as_deref(),
            Some("https://relay.example.com/v1")
        );
    }

    #[test]
    fn materialize_drops_slash_reasoning_effort() {
        let mut gw = Gateway {
            id: "g".into(),
            name: "G".into(),
            no_auth: false,
            key_hint: None,
            wallet_user_id: None,
            wallet_key_hint: None,
            slots: ProtocolSlots::default(),
            header_env: Default::default(),
            models: vec![GatewayModel {
                id: "gpt-6-sol".into(),
                source: "fetched".into(),
                status: "available".into(),
                last_seen_at: None,
                catalog_slot: Some("openai".into()),
                temperature: None,
                top_p: None,
                max_output_tokens: None,
                reasoning_effort: Some("hign/xhign".into()),
            }],
            catalog_fetched_at: None,
            catalog_from_slot: None,
            last_probe: Vec::new(),
            slot_probes: Vec::new(),
            revision: String::new(),
        };
        let b = Binding {
            id: "b".into(),
            agent: "grok".into(),
            name: "GPT".into(),
            kind: BindingKind::Api,
            gateway_id: Some("g".into()),
            protocol: None,
            api_backend: None,
            models: vec!["gpt-6-sol".into()],
            role_models: Default::default(),
            extra_env: HashMap::new(),
            last_used_at: None,
        };
        let profile = materialize(&b, Some(&gw), None);
        assert!(profile.request_policy.reasoning_effort.is_none());
        gw.models[0].reasoning_effort = Some(" High ".into());
        let profile = materialize(&b, Some(&gw), None);
        assert_eq!(
            profile.request_policy.reasoning_effort.as_deref(),
            Some("high")
        );
        gw.models[0].reasoning_effort = Some("low,high,xhigh@xhigh".into());
        let profile = materialize(&b, Some(&gw), None);
        assert_eq!(
            profile.request_policy.reasoning_effort.as_deref(),
            Some("xhigh")
        );
    }

    #[test]
    fn slot_probe_summaries_picks_latest_per_slot() {
        let probes = vec![
            crate::profiles::ProbeRecord {
                slot: "anthropic".into(),
                model: None,
                url_fp: "a".into(),
                key_fp: "k".into(),
                streaming: ProbeStatus::Passed,
                effort: ProbeStatus::Passed,
                sampling: ProbeStatus::Never,
                headers: ProbeStatus::Never,
                basic: ProbeStatus::Passed,
                probed_at: "2026-08-01T00:00:00Z".into(),
                latency_ms: Some(400),
            },
            crate::profiles::ProbeRecord {
                slot: "anthropic".into(),
                model: None,
                url_fp: "a".into(),
                key_fp: "k".into(),
                streaming: ProbeStatus::Passed,
                effort: ProbeStatus::Failed,
                sampling: ProbeStatus::Never,
                headers: ProbeStatus::Never,
                basic: ProbeStatus::Failed,
                probed_at: "2026-08-30T12:00:00Z".into(),
                latency_ms: Some(120),
            },
            crate::profiles::ProbeRecord {
                slot: "openai".into(),
                model: None,
                url_fp: "b".into(),
                key_fp: "k".into(),
                streaming: ProbeStatus::Never,
                effort: ProbeStatus::Never,
                sampling: ProbeStatus::Never,
                headers: ProbeStatus::Never,
                basic: ProbeStatus::Passed,
                probed_at: "2026-08-20T00:00:00Z".into(),
                latency_ms: Some(80),
            },
        ];
        let sum = slot_probe_summaries(&probes);
        let anth = sum.iter().find(|s| s.slot == "anthropic").unwrap();
        assert_eq!(anth.last_ok, Some(false));
        assert_eq!(anth.last_latency_ms, Some(120));
        assert_eq!(anth.last_probe_at.as_deref(), Some("2026-08-30T12:00:00Z"));
        let oai = sum.iter().find(|s| s.slot == "openai").unwrap();
        assert_eq!(oai.last_ok, Some(true));
        assert_eq!(oai.last_latency_ms, Some(80));
    }

    #[test]
    fn probe_field_status_matches_model_and_url_not_latest_slot() {
        let mut gw = Gateway {
            id: "g".into(),
            name: "g".into(),
            no_auth: false,
            key_hint: Some("····".into()),
            wallet_user_id: None,
            wallet_key_hint: None,
            slots: ProtocolSlots {
                anthropic: Some("https://example.com".into()),
                ..Default::default()
            },
            header_env: Default::default(),
            models: vec![],
            catalog_fetched_at: None,
            catalog_from_slot: None,
            last_probe: vec![
                crate::profiles::ProbeRecord {
                    slot: "anthropic".into(),
                    model: Some("model-a".into()),
                    url_fp: url_fingerprint("https://example.com"),
                    key_fp: "has".into(),
                    streaming: ProbeStatus::Passed,
                    effort: ProbeStatus::Failed,
                    sampling: ProbeStatus::Never,
                    headers: ProbeStatus::Never,
                    basic: ProbeStatus::Passed,
                    probed_at: "2026-09-01T00:00:00Z".into(),
                    latency_ms: None,
                },
                crate::profiles::ProbeRecord {
                    slot: "anthropic".into(),
                    model: Some("model-b".into()),
                    url_fp: url_fingerprint("https://example.com"),
                    key_fp: "has".into(),
                    streaming: ProbeStatus::Passed,
                    effort: ProbeStatus::Passed,
                    sampling: ProbeStatus::Never,
                    headers: ProbeStatus::Never,
                    basic: ProbeStatus::Passed,
                    probed_at: "2026-09-02T00:00:00Z".into(),
                    latency_ms: None,
                },
            ],
            slot_probes: vec![],
            revision: String::new(),
        };
        assert_eq!(
            probe_field_status(&gw, Slot::Anthropic, "effort", Some("model-a")),
            ProbeStatus::Failed
        );
        assert_eq!(
            probe_field_status(&gw, Slot::Anthropic, "effort", Some("model-b")),
            ProbeStatus::Passed
        );
        assert_eq!(
            probe_field_status(&gw, Slot::Anthropic, "temperature", Some("model-a")),
            ProbeStatus::Never
        );
        gw.slots.anthropic = Some("https://other.example.com".into());
        assert_eq!(
            probe_field_status(&gw, Slot::Anthropic, "effort", Some("model-b")),
            ProbeStatus::Never
        );
        let rec = crate::profiles::ProbeRecord {
            slot: "anthropic".into(),
            model: Some("model-b".into()),
            url_fp: url_fingerprint("https://example.com"),
            key_fp: "has".into(),
            streaming: ProbeStatus::Passed,
            effort: ProbeStatus::Passed,
            sampling: ProbeStatus::Never,
            headers: ProbeStatus::Never,
            basic: ProbeStatus::Passed,
            probed_at: "2026-09-02T00:00:00Z".into(),
            latency_ms: None,
        };
        assert!(
            !probe_record_still_valid(&gw, &rec, true),
            "地址已改，迟到回包不得当作新配置结论"
        );
        gw.slots.anthropic = Some("https://example.com/".into());
        assert!(probe_record_still_valid(&gw, &rec, true));
    }

    /// 连接状态徽标同样受 §8 约束：A 模型的体检结论不得株连选了 B 模型的绑定
    #[test]
    fn connection_status_probe_must_match_binding_model_and_fingerprint() {
        let gw = Gateway {
            id: "g".into(),
            name: "g".into(),
            no_auth: false,
            key_hint: Some("····".into()),
            wallet_user_id: None,
            wallet_key_hint: None,
            slots: ProtocolSlots {
                anthropic: Some("https://example.com".into()),
                ..Default::default()
            },
            header_env: Default::default(),
            models: vec![fetched("model-a", None), fetched("model-b", None)],
            catalog_fetched_at: None,
            catalog_from_slot: None,
            last_probe: vec![crate::profiles::ProbeRecord {
                slot: "anthropic".into(),
                model: Some("model-a".into()),
                url_fp: url_fingerprint("https://example.com"),
                key_fp: "has".into(),
                streaming: ProbeStatus::Passed,
                effort: ProbeStatus::Passed,
                sampling: ProbeStatus::Never,
                headers: ProbeStatus::Never,
                basic: ProbeStatus::Passed,
                probed_at: "2026-09-01T00:00:00Z".into(),
                latency_ms: None,
            }],
            slot_probes: vec![],
            revision: String::new(),
        };
        let binding = |model: &str| crate::profiles::Binding {
            id: "b".into(),
            agent: "claude-code".into(),
            name: "b".into(),
            kind: crate::profiles::BindingKind::Api,
            gateway_id: Some("g".into()),
            protocol: None,
            api_backend: None,
            models: vec![model.into()],
            role_models: Default::default(),
            extra_env: Default::default(),
            last_used_at: None,
        };
        assert_eq!(
            connection_state(&binding("model-a"), Some(&gw), false, true, false).0,
            "ready",
            "体检模型与绑定默认模型一致才算 ready"
        );
        assert_eq!(
            connection_state(&binding("model-b"), Some(&gw), false, true, false).0,
            "untested",
            "同槽另一模型的体检结论不得顶到这条绑定上"
        );
        // 指纹不匹配（网关换了地址）时同样回「未体检」，不得沿用旧结论
        let mut moved = gw.clone();
        moved.slots.anthropic = Some("https://other.example.com".into());
        assert_eq!(
            connection_state(&binding("model-a"), Some(&moved), false, true, false).0,
            "untested"
        );
        // 密钥有无以调用方（keys.json 权威判定）为准：key_hint 失配（旧钥匙串迁移只写 keys.json、
        // 不补 hint）不得把有密钥的体检结论误判成「未体检」
        let mut hintless = gw.clone();
        hintless.key_hint = None;
        assert_eq!(
            connection_state(&binding("model-a"), Some(&hintless), false, true, false).0,
            "ready"
        );
    }
}
