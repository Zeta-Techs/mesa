use crate::profiles;

/// 任务卡（项目档案卡 project.toml 的 [[tasks]] 段）：对话/会话的归档夹。
/// 卡片本身无状态机，不碰工作区/评审流程。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskCardDto {
    /// "t-<短随机>"，项目内唯一
    pub id: String,
    /// 卡片名（同项目内唯一，大小写敏感）
    pub name: String,
    /// 挂到的流水线步骤名（步骤 name）；未挂为 None
    pub step: Option<String>,
    /// 开工后绑定的工作区名（先留字段，前端后续填）
    pub workspace: Option<String>,
    /// 卡片种类："draft"（服务于任务书草稿的讨论卡）| "idea"（自由想法卡，只读纯聊、可融合进任务书）；
    /// 缺省推断 = step 非空 → draft，否则 idea（正好等于引入 kind 前的两种行为）
    pub kind: String,
    pub created_at: String,
}

impl Default for TaskCardDto {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            step: None,
            workspace: None,
            kind: "idea".into(),
            created_at: String::new(),
        }
    }
}

/// 模型列表缓存：按「gateway/profile identity + slot + normalized base_url + key fingerprint」落盘
/// （config_dir/ccode/model-list-cache.json）。
/// 大网关的全量列表是现算+传输（400+ 条动辄 10s），拉一次后复用；force=true（↻ 刷新/连通测试）才走网络。
/// 是缓存不是用户配置：读取损坏容忍为空表，写入 tmp+rename 原子落盘，失败静默（下次拉取自然重试）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ModelListCacheEntry {
    models: Vec<String>,
    /// RFC3339 本地时间，仅展示用
    fetched_at: String,
    /// 能力元数据条目数；旧缓存缺省为 0。
    #[serde(default)]
    capability_metadata_count: usize,
}

type ModelListCache = std::collections::HashMap<String, ModelListCacheEntry>;

static MODEL_LIST_CACHE: std::sync::RwLock<Option<ModelListCache>> = std::sync::RwLock::new(None);

fn model_list_cache_path() -> Option<std::path::PathBuf> {
    Some(
        dirs::config_dir()?
            .join("ccode")
            .join("model-list-cache.json"),
    )
}

fn model_list_cache_get(key: &str) -> Option<ModelListCacheEntry> {
    if cfg!(test) {
        return None; // 测试不读本机真实缓存（同 model_registry 口径）
    }
    let mut guard = MODEL_LIST_CACHE.write().ok()?;
    if guard.is_none() {
        *guard = Some(
            model_list_cache_path()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default(),
        );
    }
    guard.as_ref()?.get(key).cloned()
}

fn model_list_cache_put(key: &str, entry: ModelListCacheEntry) {
    if cfg!(test) {
        return;
    }
    let Ok(mut guard) = MODEL_LIST_CACHE.write() else {
        return;
    };
    let map = guard.get_or_insert_with(Default::default);
    map.insert(key.to_string(), entry);
    let Some(path) = model_list_cache_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(map) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

fn model_list_cache_key(
    gateway_id: Option<&str>,
    agent: &str,
    protocol: Option<&str>,
    base_url: &str,
    api_key: Option<&str>,
) -> String {
    // URL 及密钥指纹必须参与缓存身份：同一个网关槽位改端点或换 key 后，
    // 普通「获取模型」（force=false）不能继续复用旧结果。密钥本体不落盘。
    let key_fp = api_key
        .filter(|k| !k.trim().is_empty())
        .map(|k| format!("{:x}", md5::compute(k.as_bytes())))
        .unwrap_or_else(|| "no-key".into());
    let scope = gateway_id.unwrap_or("-");
    let normalized_base = base_url.trim().trim_end_matches('/');
    format!(
        "{scope}|{agent}|{}|{normalized_base}|{key_fp}",
        protocol.unwrap_or("")
    )
}

/// URL/路径末段是否为版本段（`v1` / `v1beta` / `v3` / `v4` …：v 后跟数字开头的
/// 小写字母数字）。这类 base 视为已自带版本号，拼资源名时直接挂在版本段下、
/// 不再补协议默认版本段——GLM 的 `/api/paas/v4` 若补 `/v1` 会拼出
/// `/api/paas/v4/v1/chat/completions`（GLM 404，2026-09-17 实测）。
pub(crate) fn ends_with_version_segment(input: &str) -> bool {
    let last = input.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let Some(rest) = last.strip_prefix('v') else {
        return false;
    };
    let mut chars = rest.chars();
    match chars.next() {
        Some(c) if c.is_ascii_digit() => {
            chars.all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
        }
        _ => false,
    }
}

/// 剥掉 URL 路径末尾的版本段（`/v1`、`/v1beta`、`/v4` …），返回归一后的字符串。
/// 供「CLI 自己拼版本段」的端点用：gemini CLI 对 GOOGLE_GEMINI_BASE_URL 无条件追加
/// `/v1beta/models/<模型>:…`（2026-10-19 本机 0.64.0 探针实测：base 带 `/v1` 会拼出
/// `/v1/v1beta/…` 被中转 404，CLI 报「Model not found or is invalid」）；Claude Code 对
/// ANTHROPIC_BASE_URL 同样自拼 `/v1/messages`（同日实测 `/v1/v1/messages?beta=true`）。
/// 用户把 OpenAI 风格的 `/v1` 地址填进这两个槽是常态（网关保存还把主地址折进全部槽），
/// 剥掉后 CLI 拼出的才是端点真身。只剥一段；非版本段结尾原样返回。
pub(crate) fn strip_trailing_version_segment(input: &str) -> String {
    let trimmed = input.trim_end_matches('/');
    if !ends_with_version_segment(trimmed) {
        return input.to_string();
    }
    match trimmed.rfind('/') {
        Some(idx) => trimmed[..idx].to_string(),
        // 末段是版本段且前面没有 '/'：整个路径就是版本段（如 "v1"），剥成空
        None => String::new(),
    }
}

/// 拉目录候选地址链（fetch_models 用）：
/// - 末段是版本段（/v1、/v1beta、/v4 …）直接拼 /models；否则先试 /v1/models 再试 /models。
///   v3/v4 等非常规版本段（GLM /api/paas/v4）资源直接挂版本段下为主选，保留 /v1/models 作次选兜底。
/// - gemini 例外：CLI 对 base 无条件自拼 /v1beta/…，槽位带版本段（用户把 OpenAI
///   风格 /v1 地址填进 gemini 槽）先剥掉，候选链与 CLI 实际请求路径对齐
fn model_list_candidates(base: &str, gemini: bool) -> Vec<String> {
    if gemini {
        let base = strip_trailing_version_segment(base);
        vec![format!("{base}/v1beta/models"), format!("{base}/models")]
    } else if base.ends_with("/v1") {
        vec![format!("{base}/models")]
    } else if ends_with_version_segment(base) {
        vec![format!("{base}/models"), format!("{base}/v1/models")]
    } else {
        vec![format!("{base}/v1/models"), format!("{base}/models")]
    }
}

/// fetch_models 的返回：模型列表 + 是否命中缓存 + 拉取时间（前端展示「缓存 · HH:MM」）
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchModelsResult {
    pub models: Vec<String>,
    from_cache: bool,
    fetched_at: String,
    /// 0 表示网关只返回模型 ID，能力会回退到其他能力层。
    capability_metadata_count: usize,
}

/// 从 profile 的端点拉取可用模型列表。
/// 密钥优先用表单里新输入的，否则取 keys.json 已存的；只用于本次请求，不持久化。
#[tauri::command]
pub async fn fetch_models(
    base_url: String,
    api_key: Option<String>,
    profile_id: Option<String>,
    agent_id: Option<String>,
    protocol: Option<String>,
    gateway_id: Option<String>,
    // true = 跳过缓存强制走网络（↻ 刷新、「测试」按钮）
    force: Option<bool>,
) -> Result<FetchModelsResult, String> {
    let resolved_gateway = gateway_id.clone().or_else(|| {
        profile_id.as_deref().and_then(|id| {
            crate::profiles::ProfileStore::new()
                .ok()
                .and_then(|s| s.get(id).ok())
                .and_then(|p| p.gateway_id)
        })
    });
    let key = match api_key.filter(|k| !k.trim().is_empty()) {
        Some(k) => Some(k),
        None => {
            if let Some(gid) = resolved_gateway.as_deref() {
                profiles::get_key(gid)?
            } else if let Some(id) = profile_id.as_deref() {
                let store = crate::profiles::ProfileStore::new()?;
                match store.get(id) {
                    Ok(p) => profiles::get_key_for_profile(&p)?,
                    Err(_) => profiles::get_key(id)?,
                }
            } else {
                None
            }
        }
    };

    let agent = agent_id.as_deref().unwrap_or("openai");
    if agent == "cursor" {
        return Err("Cursor 使用专有协议，无法通过通用模型列表接口获取模型".into());
    }
    let gemini = agent == "gemini";
    let anthropic = agent == "claude-code"
        || matches!(protocol.as_deref(), Some("anthropic"));
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请先填写 Base URL".into());
    }
    let slot = crate::gateway_store::slot_for_agent(agent, protocol.as_deref());
    let cache_key = model_list_cache_key(
        resolved_gateway.as_deref(),
        agent,
        protocol.as_deref().or(Some(slot.as_str())),
        base,
        key.as_deref(),
    );
    if !force.unwrap_or(false) {
        if let Some(hit) = model_list_cache_get(&cache_key) {
            return Ok(FetchModelsResult {
                models: hit.models,
                from_cache: true,
                fetched_at: hit.fetched_at,
                capability_metadata_count: hit.capability_metadata_count,
            });
        }
    }
    let candidates = model_list_candidates(base, gemini);

    // 30s：大网关全量模型列表（400+ 条带元数据）传输+解压可能超过 10s，压线即超时
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut last_err = String::new();
    for url in candidates {
        let mut req = client.get(&url);
        if let Some(k) = &key {
            if gemini {
                if let Ok(mut parsed) = reqwest::Url::parse(&url) {
                    parsed.query_pairs_mut().append_pair("key", k);
                    req = client.get(parsed);
                }
            }
            // 同时携带两种鉴权头：OpenAI 系认 Bearer，Anthropic 系认 x-api-key，多余的头无害
            if !gemini {
                req = req.header("Authorization", format!("Bearer {k}"));
            }
            if anthropic {
                req = req
                    .header("x-api-key", k)
                    .header("anthropic-version", "2023-06-01");
            }
        }
        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                // 先读文本再解析：失败时能把响应开头（脱敏后）带进报错，
                // 否则 reqwest 的 "error decoding response body" 无任何自查线索
                let bytes = crate::storage::response_bytes(resp, 16 * 1024 * 1024).await?;
                let text = String::from_utf8_lossy(&bytes);
                let body: serde_json::Value = serde_json::from_str(&text)
                    .map_err(|e| format!("解析响应失败: {e}；响应开头: {}", body_preview(&text)))?;
                // 顺带沉淀能力元数据（OpenRouter 风格响应带 context_length/modality 等；
                // 纯 id 列表的网关此调用为 no-op）——能力注册表的最准数据源
                let capability_metadata_count =
                    crate::model_registry::record_relay_models(&body, resolved_gateway.as_deref());
                let fetched_at = chrono::Local::now().to_rfc3339();
                let models = parse_model_ids(&body);
                if models.is_empty() {
                    // HTTP 200 包着错误体（智谱 api/v1 风格）：当失败处理、带出真实原因，
                    // 继续试下一个候选地址；真返回空列表的网关不受影响（无错误标记）
                    if let Some(msg) = gateway_error_envelope(&body) {
                        last_err = redact_fetch_error(&format!("{url}：{msg}"), key.as_deref());
                        continue;
                    }
                }
                model_list_cache_put(
                    &cache_key,
                    ModelListCacheEntry {
                        models: models.clone(),
                        fetched_at: fetched_at.clone(),
                        capability_metadata_count,
                    },
                );
                return Ok(FetchModelsResult {
                    models,
                    from_cache: false,
                    fetched_at,
                    capability_metadata_count,
                });
            }
            Ok(resp) => {
                last_err = redact_fetch_error(
                    &format!("{url} 返回 HTTP {}", resp.status()),
                    key.as_deref(),
                );
            }
            Err(e) => {
                last_err = redact_fetch_error(&format!("{url} 请求失败: {e}"), key.as_deref());
            }
        }
    }
    Err(format!(
        "获取模型列表失败：{}",
        crate::sessions::redact_sensitive_text(&last_err)
    ))
}

/// 拉目录失败文案：reqwest Display 常带完整请求 URL，gemini 槽密钥在 query 里。
fn redact_fetch_error(message: &str, key: Option<&str>) -> String {
    let mut s = message.to_string();
    if let Some(k) = key.filter(|k| k.chars().count() >= 8) {
        s = s.replace(k, "[已隐藏密钥]");
    }
    crate::sessions::redact_sensitive_text(&s)
}

/// 解析失败时附进报错的响应预览：压平空白、截断、过脱敏（网关错误页可能回显 key）
fn body_preview(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let redacted = crate::sessions::redact_sensitive_text(&flat);
    const MAX: usize = 200;
    if redacted.chars().count() > MAX {
        let cut: String = redacted.chars().take(MAX).collect();
        format!("{cut}…")
    } else {
        redacted
    }
}

/// 智谱 api/v1 等网关把业务错误包成 HTTP 200（{"code":1001,"msg":"…","success":false}
/// 或 {"error":{"code":"1001","message":"…"}}）：这不是模型列表。解析结果为空时按错误
/// 处理并把原因带给前端，避免「成功但 0 个模型」误导排查方向（2026-09-15 实证）。
fn gateway_error_envelope(v: &serde_json::Value) -> Option<String> {
    let scalar = |val: Option<&serde_json::Value>| match val {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        _ => None,
    };
    if v.get("success").and_then(|s| s.as_bool()) == Some(false) {
        let code = scalar(v.get("code")).unwrap_or_default();
        let msg = scalar(v.get("msg")).unwrap_or_default();
        return Some(format!("网关返回错误 {code}：{msg}"));
    }
    // OpenAI 风格错误对象：仅当响应里没有 data/models 列表字段时判定（正常列表不带顶层 error）
    if !v.is_array() && v.get("data").is_none() && v.get("models").is_none() {
        if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
            let code = scalar(err.get("code")).unwrap_or_default();
            let msg = scalar(err.get("message")).unwrap_or_default();
            return Some(format!("网关返回错误 {code}：{msg}"));
        }
    }
    None
}

fn push_unique(out: &mut Vec<String>, s: &str) {
    let s = s.trim();
    if !s.is_empty() && !out.iter().any(|x| x == s) {
        out.push(s.to_string());
    }
}

/// 兼容常见返回：OpenAI/Anthropic 的 `data[].id`、Gemini 的 `models[].name`、
/// GLM codex 目录的 `models[].slug`（/api/v1/models，2026-09-17 实测）、裸字符串数组
fn parse_model_ids(v: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                push_unique(&mut out, id);
            } else if let Some(s) = item.as_str() {
                push_unique(&mut out, s);
            }
        }
    }
    if out.is_empty() {
        if let Some(arr) = v.get("models").and_then(|d| d.as_array()) {
            for item in arr {
                if let Some(name) = item.get("name").and_then(|i| i.as_str()) {
                    // Gemini 风格的 name 形如 "models/gemini-pro"，去掉前缀
                    push_unique(&mut out, name.strip_prefix("models/").unwrap_or(name));
                } else if let Some(slug) = item.get("slug").and_then(|i| i.as_str()) {
                    // GLM codex 目录风格的条目键
                    push_unique(&mut out, slug);
                } else if let Some(s) = item.as_str() {
                    push_unique(&mut out, s);
                }
            }
        }
    }
    if out.is_empty() {
        if let Some(arr) = v.as_array() {
            for item in arr {
                if let Some(s) = item.as_str() {
                    push_unique(&mut out, s);
                } else if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                    push_unique(&mut out, id);
                }
            }
        }
    }
    out
}

fn catalog_slot_walk_order(
    prefer: Option<&str>,
) -> Vec<(crate::gateway_store::Slot, &'static str)> {
    let mut order = vec![
        (crate::gateway_store::Slot::Anthropic, "claude-code"),
        (crate::gateway_store::Slot::Openai, "opencode"),
        (crate::gateway_store::Slot::Responses, "codex"),
        (crate::gateway_store::Slot::Gemini, "gemini"),
    ];
    if let Some(pref) = prefer.and_then(crate::gateway_store::Slot::from_str) {
        if let Some(i) = order.iter().position(|(slot, _)| *slot == pref) {
            let item = order.remove(i);
            order.insert(0, item);
        }
    }
    order
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchGatewayCatalogDto {
    pub gateway: crate::profiles::Gateway,
    pub capability_metadata_count: usize,
}

/// 优先调用方指定的协议槽（连接行刷新）或网关上次成功槽，再按 Anthropic → OpenAI → Responses → Gemini。
#[tauri::command]
pub async fn fetch_gateway_catalog(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    gateway_id: String,
    prefer_slot: Option<String>,
) -> Result<FetchGatewayCatalogDto, String> {
    let gw = store
        .list_gateways()?
        .into_iter()
        .find(|g| g.id == gateway_id)
        .ok_or("网关不存在")?;
    let prefer = prefer_slot.as_deref().or(gw.catalog_from_slot.as_deref());
    let order = catalog_slot_walk_order(prefer);
    let mut last_err = "没有可拉取的协议槽".to_string();
    for (slot, agent) in order {
        let Some(url) = crate::gateway_store::slot_url(&gw.slots, slot) else {
            continue;
        };
        match fetch_models(
            url.to_string(),
            None,
            None,
            Some(agent.to_string()),
            None,
            Some(gateway_id.clone()),
            Some(true),
        )
        .await
        {
            Ok(res) if !res.models.is_empty() => {
                let gateway = store.merge_fetched_models(&gateway_id, slot.as_str(), res.models)?;
                return Ok(FetchGatewayCatalogDto {
                    gateway,
                    capability_metadata_count: res.capability_metadata_count,
                });
            }
            Ok(_) => last_err = format!("{} 槽返回空目录", slot.as_str()),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_trailing_version_segment() {
        assert_eq!(
            strip_trailing_version_segment("https://relay.example.com/v1"),
            "https://relay.example.com"
        );
        assert_eq!(
            strip_trailing_version_segment("https://relay.example.com/v1/"),
            "https://relay.example.com"
        );
        assert_eq!(
            strip_trailing_version_segment("https://relay.example.com/v1beta"),
            "https://relay.example.com"
        );
        assert_eq!(
            strip_trailing_version_segment("https://relay.example.com/gemini/v4"),
            "https://relay.example.com/gemini"
        );
        // 非版本段结尾：原样返回（含末尾斜杠）
        assert_eq!(
            strip_trailing_version_segment("https://relay.example.com"),
            "https://relay.example.com"
        );
        assert_eq!(
            strip_trailing_version_segment("https://relay.example.com/"),
            "https://relay.example.com/"
        );
        assert_eq!(
            strip_trailing_version_segment("https://open.bigmodel.cn/api/paas/v4"),
            "https://open.bigmodel.cn/api/paas"
        );
    }

    #[test]
    fn model_list_candidates_rules() {
        // gemini：槽位带 /v1（OpenAI 风格同址折槽的常态）先剥，候选对齐 CLI 自拼路径
        assert_eq!(
            model_list_candidates("https://relay.example.com/v1", true),
            vec![
                "https://relay.example.com/v1beta/models",
                "https://relay.example.com/models",
            ]
        );
        // gemini 根地址：与旧链一致
        assert_eq!(
            model_list_candidates("https://relay.example.com", true),
            vec![
                "https://relay.example.com/v1beta/models",
                "https://relay.example.com/models",
            ]
        );
        // openai 系不变：/v1 结尾直接拼 /models
        assert_eq!(
            model_list_candidates("https://relay.example.com/v1", false),
            vec!["https://relay.example.com/v1/models"]
        );
        // openai 系不变：GLM /api/paas/v4 版本段主选 + /v1 兜底
        assert_eq!(
            model_list_candidates("https://open.bigmodel.cn/api/paas/v4", false),
            vec![
                "https://open.bigmodel.cn/api/paas/v4/models",
                "https://open.bigmodel.cn/api/paas/v4/v1/models",
            ]
        );
    }

    #[test]
    fn parses_glm_codex_slug_catalog() {
        // GLM 的 codex 目录（/api/v1/models）：models[].slug + 元数据字段
        let v = json!({"models": [
            {"slug": "glm-5.3", "context_window": 1048576, "display_name": "GLM-5.3"},
            {"slug": "glm-5.3-flash"}
        ]});
        assert_eq!(parse_model_ids(&v), vec!["glm-5.3", "glm-5.3-flash"]);
    }

    #[test]
    fn version_segment_detection() {
        // 版本段：v 后跟数字开头的小写字母数字
        assert!(ends_with_version_segment(
            "https://open.bigmodel.cn/api/paas/v4"
        ));
        assert!(ends_with_version_segment("/v1"));
        assert!(ends_with_version_segment("/v1beta"));
        assert!(ends_with_version_segment("https://relay.example.com/v3"));
        assert!(ends_with_version_segment("https://x.cn/v4/"));
        // 非版本段：不误判
        assert!(!ends_with_version_segment("/api/anthropic"));
        assert!(!ends_with_version_segment("/models"));
        assert!(!ends_with_version_segment(""));
        assert!(!ends_with_version_segment("/v"));
        assert!(!ends_with_version_segment("/vX1"));
        assert!(!ends_with_version_segment("https://api.deepseek.com"));
    }

    #[test]
    fn catalog_slot_walk_puts_prefer_first() {
        let names: Vec<_> = catalog_slot_walk_order(Some("openai"))
            .into_iter()
            .map(|(slot, _)| slot.as_str())
            .collect();
        assert_eq!(names[0], "openai");
        assert!(names.contains(&"anthropic"));
        let default: Vec<_> = catalog_slot_walk_order(None)
            .into_iter()
            .map(|(slot, _)| slot.as_str())
            .collect();
        assert_eq!(default[0], "anthropic");
    }

    #[test]
    fn parses_openai_data_format() {
        let v = json!({"object": "list", "data": [{"id": "gpt-5"}, {"id": "gpt-5-codex"}, {"id": "gpt-5"}]});
        assert_eq!(parse_model_ids(&v), vec!["gpt-5", "gpt-5-codex"]);
    }

    #[test]
    fn parses_gemini_models_format_and_strips_prefix() {
        let v = json!({"models": [{"name": "models/gemini-3.6-flash"}, {"name": "models/gemini-3-pro"}]});
        assert_eq!(
            parse_model_ids(&v),
            vec!["gemini-3.6-flash", "gemini-3-pro"]
        );
    }

    #[test]
    fn parses_bare_string_array_and_tolerates_junk() {
        let v = json!(["claude-sonnet-4", " ", {"id": "claude-opus-4"}]);
        assert_eq!(
            parse_model_ids(&v),
            vec!["claude-sonnet-4", "claude-opus-4"]
        );
    }

    #[test]
    fn body_preview_flattens_whitespace() {
        assert_eq!(
            body_preview("<html>\n  <body>oops</body>\n</html>"),
            "<html> <body>oops</body> </html>"
        );
    }

    #[test]
    fn detects_zhipu_style_200_error_envelopes() {
        // api/v1 风格：HTTP 200 包 success:false + code/msg（无 key 探针实测形状）
        let v = json!({"code": 1001, "msg": "Header中未收到Authorization参数", "success": false});
        assert_eq!(
            gateway_error_envelope(&v).as_deref(),
            Some("网关返回错误 1001：Header中未收到Authorization参数")
        );
        // error 对象风格（code 允许字符串）
        let v = json!({"error": {"code": "500", "message": "404 NOT_FOUND"}});
        assert_eq!(
            gateway_error_envelope(&v).as_deref(),
            Some("网关返回错误 500：404 NOT_FOUND")
        );
    }

    #[test]
    fn normal_list_responses_are_not_error_envelopes() {
        assert_eq!(
            gateway_error_envelope(&json!({"object": "list", "data": []})),
            None
        );
        assert_eq!(
            gateway_error_envelope(&json!({"data": [{"id": "glm-4.7"}], "error": null})),
            None
        );
        assert_eq!(gateway_error_envelope(&json!(["glm-4.7"])), None);
        // success:true 是正常业务响应，不是错误
        assert_eq!(
            gateway_error_envelope(&json!({"code": 200, "msg": "ok", "success": true})),
            None
        );
    }

    #[test]
    fn model_cache_identity_changes_with_url_and_key() {
        let a = model_list_cache_key(
            Some("gw"),
            "opencode",
            Some("openai"),
            "https://example.test/v1",
            Some("key-a"),
        );
        let b = model_list_cache_key(
            Some("gw"),
            "opencode",
            Some("openai"),
            "https://other.test/v1",
            Some("key-a"),
        );
        let c = model_list_cache_key(
            Some("gw"),
            "opencode",
            Some("openai"),
            "https://example.test/v1",
            Some("key-b"),
        );
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert!(!a.contains("key-a"));
        assert_eq!(
            a,
            model_list_cache_key(
                Some("gw"),
                "opencode",
                Some("openai"),
                " https://example.test/v1/ ",
                Some("key-a"),
            )
        );
    }

    #[test]
    fn fetch_error_redacts_key_in_reqwest_url() {
        let key = "super-secret-gateway-key-zzzz";
        let msg = format!(
            "https://generativelanguage.googleapis.com/v1beta/models 请求失败: error sending request for url (https://generativelanguage.googleapis.com/v1beta/models?key={key})"
        );
        let out = redact_fetch_error(&msg, Some(key));
        assert!(!out.contains(key), "{out}");
        assert!(out.contains("[已隐藏密钥]"), "{out}");
    }

    #[test]
    fn body_preview_truncates_long_body() {
        let long = "x".repeat(500);
        let out = body_preview(&long);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), 201);
    }
}
