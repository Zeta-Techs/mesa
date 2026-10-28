//! 模型能力注册表（2026-08-17 起）：内置前缀表 + <config>/ccode/model-capabilities.json
//! 覆盖 + 关键词推断兜底，同 usage.rs「内置定价表 + pricing.json 覆盖」口径
//! （最长前缀匹配、剥中转 provider/ 前缀）。
//! 2026-08-31 起公共能力库下载顺带提取定价（models.dev cost / OpenRouter pricing →
//! 条目的 cost 字段），经 db_price_table 供 usage.rs 定价链消费。
//! 消费方：kimi（KIMI_MODEL_CAPABILITIES / KIMI_MODEL_MAX_CONTEXT_SIZE / [models.*] 的
//! capabilities）、codex（catalog context_window）、opencode（models 条目 reasoning/limit）。
//! 内置表宁缺毋滥：只收官方文档明确支持思考的模型，不确定的不收（落关键词推断），
//! 收错的能力声明（思考开了报错）比漏报更有害。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilityDto {
    pub model: String,
    pub thinking: bool,
    /// 上下文窗口：确知才有（model_context_size_known_for）；不知道就是 None，界面不画圈不写数
    pub context: Option<i64>,
    pub tools: Option<bool>,
    pub vision: Option<bool>,
    pub video: Option<bool>,
    pub streaming: Option<bool>,
}

/// 单条能力：thinking = 支持思考档位；context = 上下文窗口、output = 输出上限、
/// vision = 图像输入。**全部字段 Option**：None = 「这层不知道」，查询链逐字段继续向下找
/// （网关只报了上下文不代表它否认推理能力——显式 false 与缺数据必须分开）；
/// 内置表不逐模型收 output/vision（宁缺毋滥同 context 口径）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCaps {
    pub thinking: Option<bool>,
    pub context: Option<i64>,
    pub output: Option<i64>,
    pub vision: Option<bool>,
    /// Grok 目录条目的 apiBackend（responses/chat_completions/messages）；
    /// 仅权威层（用户覆盖/网关实测缓存）可能有值，供设为全局与预览说实话
    pub api_backend: Option<String>,
}

const fn caps(thinking: bool, context: Option<i64>) -> ModelCaps {
    ModelCaps {
        thinking: Some(thinking),
        context,
        output: None,
        vision: None,
        api_backend: None,
    }
}

/// 同 `caps`，但显式声明视觉能力（确知多模态家族）。
/// 视觉知识以前散在 `model_supports_vision_for` 末尾的硬编码清单里兜底——那份清单
/// 本身就是「确知多模态」名单，收进这里后「未声明」才真正等于「不知道」，
/// catalog 才能据此省略 input_modalities，而不是替用户把未知模型声明成纯文本。
const fn capsv(thinking: bool, context: Option<i64>, vision: bool) -> ModelCaps {
    ModelCaps {
        thinking: Some(thinking),
        context,
        output: None,
        vision: Some(vision),
        api_backend: None,
    }
}

/// 内置前缀表（最长前缀匹配：kimi-k2-thinking 优先于 kimi-k2）。
/// 数据口径：2026-08 各官方文档；context 只填确知值（kimi 系按官方上下文映射），
/// 其余 None 落 fallback_context_size 的保守默认。
const BUILTIN_CAPS: &[(&str, ModelCaps)] = &[
    // Kimi（官方：k3 = 1M 多模态思考，k2.5+ = 256K 思考，k2-thinking = 128K 思考，k2 = 128K 无思考）
    ("kimi-k3", capsv(true, Some(1_048_576), true)),
    ("kimi-k2.7", caps(true, Some(262_144))),
    ("kimi-k2.6", caps(true, Some(262_144))),
    ("kimi-k2.5", caps(true, Some(262_144))),
    ("kimi-k2-thinking", caps(true, Some(131_072))),
    ("kimi-k2", caps(false, Some(131_072))),
    ("kimi-k1.5", caps(true, Some(131_072))),
    // DeepSeek（reasoner = r1 推理版；chat/v3 非思考）
    // v4 起全系思考（2026-10 官方 / 公共库同口径）
    ("deepseek-v4", caps(true, None)),
    ("deepseek-reasoner", caps(true, None)),
    ("deepseek-r1", caps(true, None)),
    ("deepseek-chat", caps(false, None)),
    // OpenAI（gpt-5/gpt-6 全系 + o 系为 reasoning 模型；4o/4.1 不是）
    ("gpt-5", caps(true, None)),
    ("gpt-6", caps(true, None)),
    ("o1", caps(true, None)),
    ("o3", caps(true, None)),
    ("o4-mini", caps(true, None)),
    ("gpt-4o", capsv(false, None, true)),
    ("gpt-4.1", caps(false, None)),
    // Anthropic（3.7 起全系 extended thinking；3.5 及更早不支持；5 代与 Fable 全系思考 + 看图，2026-10-28 补）
    ("claude-fable", capsv(true, None, true)),
    ("claude-opus-5", capsv(true, None, true)),
    ("claude-sonnet-5", capsv(true, None, true)),
    ("claude-haiku-5", capsv(true, None, true)),
    ("claude-opus-4", capsv(true, None, true)),
    ("claude-sonnet-4", caps(true, None)),
    ("claude-haiku-4", caps(true, None)),
    ("claude-3-7-sonnet", caps(true, None)),
    ("claude-3-5", caps(false, None)),
    // Google（2.5 起全系 thinking）
    ("gemini-4", capsv(true, None, true)),
    ("gemini-3", capsv(true, None, true)),
    ("gemini-2.5", capsv(true, None, true)),
    // 智谱（4.5 起 hybrid thinking 可开关；z1 = 推理专版）
    ("glm-z1", caps(true, None)),
    ("glm-5", caps(true, None)),
    ("glm-4.7", caps(true, None)),
    ("glm-4.6", caps(true, None)),
    ("glm-4.5", caps(true, None)),
    // 阿里（qwen3 全系 hybrid thinking，qwen3-coder 除外；qwq = 推理专版）
    ("qwq", caps(true, None)),
    ("qwen3-coder", caps(false, None)),
    ("qwen3", caps(true, None)),
    // xAI（grok-3 起支持 reasoning）
    ("grok-4", caps(true, None)),
    ("grok-3", caps(true, None)),
];

/// 覆盖文件：<config>/ccode/model-capabilities.json
/// 格式：{"模型前缀": {"thinking": true, "context": 262144, "output": 8192, "vision": true}}（四个字段都可选）
fn override_path() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("ccode")
            .join("model-capabilities.json"),
    )
}

/// 共享的「前缀 → 能力」JSON 解析（覆盖文件 / 网关实测缓存 / 公共能力库同一形状）
fn parse_caps_map(text: &str) -> Vec<(String, ModelCaps)> {
    let mut out = Vec::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return out;
    };
    if let Some(obj) = v.as_object() {
        for (prefix, caps_v) in obj {
            // 空前缀会匹配一切模型名，视为配置错误直接忽略（同 pricing 口径）；`_meta` 等下划线键是说明不是模型
            if prefix.trim().is_empty() || prefix.starts_with('_') {
                continue;
            }
            let Some(c) = caps_v.as_object() else {
                continue;
            };
            let thinking = c.get("thinking").and_then(|b| b.as_bool());
            let context = c.get("context").and_then(|n| n.as_i64()).filter(|n| *n > 0);
            let output = c.get("output").and_then(|n| n.as_i64()).filter(|n| *n > 0);
            let vision = c.get("vision").and_then(|b| b.as_bool());
            let api_backend = c
                .get("api_backend")
                .and_then(|b| b.as_str())
                .filter(|s| GROK_API_BACKENDS.contains(s))
                .map(str::to_string);
            // 至少一个字段有效才算条目；缺省字段 = None（这层不知道，查询链继续向下）
            out.push((
                prefix.to_lowercase(),
                ModelCaps {
                    thinking,
                    context,
                    output,
                    vision,
                    api_backend,
                },
            ));
        }
    }
    out
}

fn load_override() -> Vec<(String, ModelCaps)> {
    // 单测不读本机真实文件：链语义由 chain_field 单测覆盖，本机缓存会让期望值随机器漂移
    if cfg!(test) {
        return Vec::new();
    }
    let out = Vec::new();
    let Some(path) = override_path() else {
        return out;
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return out;
    };
    parse_caps_map(&text)
        .into_iter()
        .map(|(p, c)| (p, c))
        .collect()
}

// ===== 用户覆盖层读写（连接页网关库「能力声明」编辑，2026-09-19）=====
//
// 此前覆盖文件只能手编 JSON（注册链最高层却没有写入代码）；查询链四层全 miss 的
// 中转自命名模型会被低报（context 兜底 128K → claude 提前 compact / codex catalog
// 窗口低报 / grok 回落 256000）。补上命令 + UI 后，声明能力不再依赖手改文件。

/// 覆盖条目 DTO（读写同一形状）。api_backend 只有 grok 消费、UI 不编辑，
/// 但往返必须保留——手写在文件里的 grok 目录声明不能被 UI 保存顺手抹掉。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelCapsOverrideDto {
    pub prefix: String,
    pub thinking: Option<bool>,
    pub context: Option<i64>,
    pub output: Option<i64>,
    pub vision: Option<bool>,
    pub api_backend: Option<String>,
}

/// 校验单条覆盖：前缀非空、至少声明一个字段、数值字段必须为正。
/// 前缀归一（trim + 小写）与 parse_caps_map 的读入口径一致。
fn validate_override(entry: &mut ModelCapsOverrideDto) -> Result<(), String> {
    entry.prefix = entry.prefix.trim().to_lowercase();
    if entry.prefix.is_empty() {
        return Err("模型名前缀不能为空".into());
    }
    if entry.context.is_some_and(|v| v <= 0) {
        return Err("上下文窗口必须大于 0".into());
    }
    if entry.output.is_some_and(|v| v <= 0) {
        return Err("输出上限必须大于 0".into());
    }
    let any = entry.thinking.is_some()
        || entry.context.is_some()
        || entry.output.is_some()
        || entry.vision.is_some()
        || entry.api_backend.is_some();
    if !any {
        return Err("至少声明一个能力字段（上下文 / 输出 / 思考 / 视觉）".into());
    }
    Ok(())
}

/// 覆盖文件序列化：只写 Some 字段（与 parse_caps_map 读入口径互为镜像），按前缀排序
fn overrides_to_text(list: &[ModelCapsOverrideDto]) -> Result<String, String> {
    let mut obj = serde_json::Map::new();
    for entry in list {
        let mut m = serde_json::Map::new();
        if let Some(v) = entry.thinking {
            m.insert("thinking".into(), serde_json::json!(v));
        }
        if let Some(v) = entry.context {
            m.insert("context".into(), serde_json::json!(v));
        }
        if let Some(v) = entry.output {
            m.insert("output".into(), serde_json::json!(v));
        }
        if let Some(v) = entry.vision {
            m.insert("vision".into(), serde_json::json!(v));
        }
        if let Some(v) = &entry.api_backend {
            m.insert("api_backend".into(), serde_json::json!(v));
        }
        obj.insert(entry.prefix.clone(), serde_json::Value::Object(m));
    }
    serde_json::to_string_pretty(&serde_json::Value::Object(obj))
        .map_err(|e| format!("序列化能力覆盖失败: {e}"))
}

fn write_overrides_to(path: &Path, list: &[ModelCapsOverrideDto]) -> Result<(), String> {
    crate::profiles::atomic_write(path, &overrides_to_text(list)?)
}

/// 读覆盖文件为 DTO 列表（文件缺失/损坏返回空表——读取方本就把它当「无声明」）
fn read_overrides_at(path: &Path) -> Vec<ModelCapsOverrideDto> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut list: Vec<ModelCapsOverrideDto> = parse_caps_map(&text)
        .into_iter()
        .map(|(prefix, c)| ModelCapsOverrideDto {
            prefix,
            thinking: c.thinking,
            context: c.context,
            output: c.output,
            vision: c.vision,
            api_backend: c.api_backend,
        })
        .collect();
    list.sort_by(|a, b| a.prefix.cmp(&b.prefix));
    list
}

#[tauri::command]
pub fn list_model_capability_overrides() -> Vec<ModelCapsOverrideDto> {
    override_path()
        .map(|p| read_overrides_at(&p))
        .unwrap_or_default()
}

/// 写单条覆盖（同前缀整条替换），返回写后的完整列表供前端刷新
#[tauri::command]
pub fn set_model_capability_override(
    entry: ModelCapsOverrideDto,
) -> Result<Vec<ModelCapsOverrideDto>, String> {
    let mut entry = entry;
    validate_override(&mut entry)?;
    let Some(path) = override_path() else {
        return Err("无法确定平台配置目录".into());
    };
    let mut list = read_overrides_at(&path);
    match list.iter().position(|e| e.prefix == entry.prefix) {
        Some(i) => list[i] = entry,
        None => list.push(entry),
    }
    list.sort_by(|a, b| a.prefix.cmp(&b.prefix));
    write_overrides_to(&path, &list)?;
    Ok(list)
}

/// 删单条覆盖；返回写后的完整列表供前端刷新
#[tauri::command]
pub fn clear_model_capability_override(
    prefix: String,
) -> Result<Vec<ModelCapsOverrideDto>, String> {
    let prefix = prefix.trim().to_lowercase();
    let Some(path) = override_path() else {
        return Err("无法确定平台配置目录".into());
    };
    let mut list = read_overrides_at(&path);
    let before = list.len();
    list.retain(|e| e.prefix != prefix);
    if list.len() == before {
        return Ok(list);
    }
    write_overrides_to(&path, &list)?;
    Ok(list)
}

// ===== 外部能力数据源（2026-08-26；查询链：用户覆盖 > 网关实测缓存 > 公共能力库 > 内置表） =====
//
// ① 网关实测缓存（model-capabilities-relay.json）：「获取模型」时 fetch_models 顺带解析
//    OpenRouter 风格 /models 响应里的元数据落盘——网关自己最清楚它卖的模型（含网关改名模型），
//    是最准的来源；同一模型在不同网关能力不同时最新一次拉取赢。
// ② 公共能力库（model-capabilities-db.json）：用户主动下载，models.dev 优先、OpenRouter 回落
//    （models.dev 本机不可达已实证；两家解析进同一形状）。进程内缓存，下载后失效重载。

fn relay_cache_path() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("ccode")
            .join("model-capabilities-relay.json"),
    )
}

fn db_path() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("ccode")
            .join("model-capabilities-db.json"),
    )
}

fn load_relay_for(gateway_id: Option<&str>) -> Vec<(String, ModelCaps)> {
    if cfg!(test) {
        return Vec::new();
    }
    let Some(gid) = gateway_id.filter(|s| !s.is_empty()) else {
        return Vec::new(); // 无网关维度不读 relay（含无前缀旧键）
    };
    let Some(path) = relay_cache_path() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let prefix = format!("{gid}|");
    parse_caps_map(&text)
        .into_iter()
        .filter_map(|(k, c)| k.strip_prefix(&prefix).map(|rest| (rest.to_string(), c)))
        .collect()
}

pub(crate) fn purge_relay_for_gateway(gateway_id: &str) {
    let Some(path) = relay_cache_path() else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let Some(obj) = v.as_object_mut() else { return };
    let prefix = format!("{gateway_id}|");
    obj.retain(|k, _| !k.starts_with(&prefix));
    if let Ok(out) = serde_json::to_string_pretty(&v) {
        let _ = crate::profiles::atomic_write(&path, &out);
    }
}

/// 网关目录里已下架（标了 stale）的模型，从网关实测缓存里删掉（2026-10-28：原先只增不删，下架的一直留着）
pub(crate) fn forget_relay_models(gateway_id: &str, ids: &[String]) {
    if ids.is_empty() || cfg!(test) {
        return;
    }
    if let Some(path) = relay_cache_path() {
        forget_relay_models_at(&path, gateway_id, ids);
    }
}

fn forget_relay_models_at(path: &Path, gateway_id: &str, ids: &[String]) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let Some(obj) = v.as_object_mut() else { return };
    let gone: std::collections::HashSet<String> = ids
        .iter()
        .map(|id| format!("{gateway_id}|{}", normalize(id)))
        .collect();
    let before = obj.len();
    obj.retain(|k, _| !gone.contains(k));
    if obj.len() == before {
        return;
    }
    if let Ok(out) = serde_json::to_string_pretty(&v) {
        let _ = crate::profiles::atomic_write(path, &out);
    }
}

/// 随包快照（2026-10-28）：发版前 `npm run gen:model-db` 用同一套下载合并逻辑生成；新装、没联网、
/// 下载失败的用户也有公共库这一层。本机下载的同名条目优先
const BUNDLED_DB: &str = include_str!("../data/model-db-snapshot.json");

/// 快照的生成时间与条目数（连接页 ⋯ 菜单显示）
fn bundled_meta() -> (usize, Option<String>) {
    let v: serde_json::Value = serde_json::from_str(BUNDLED_DB).unwrap_or_default();
    let at = v.get("_meta").and_then(|m| m.get("generatedAt")).and_then(|t| t.as_str()).map(String::from);
    (parse_caps_map(BUNDLED_DB).len(), at)
}

static DB_CACHE: std::sync::OnceLock<std::sync::RwLock<Option<Vec<(String, ModelCaps)>>>> =
    std::sync::OnceLock::new();
static DB_PRICE_CACHE: std::sync::OnceLock<std::sync::RwLock<Option<Vec<(String, (f64, f64))>>>> =
    std::sync::OnceLock::new();

fn load_db() -> Vec<(String, ModelCaps)> {
    if cfg!(test) {
        return Vec::new(); // 同 load_override：单测不读本机真实文件
    }
    let cache = DB_CACHE.get_or_init(|| std::sync::RwLock::new(None));
    if let Some(cached) = cache.read().ok().and_then(|g| g.clone()) {
        return cached;
    }
    // 旧快照的键还是原写法（claude-opus-5.5、带 :batch 的变体）：统一写法后同名的取第一条，变体不进表。
    // 本机下载的在前，随包快照补它没有的（没下过、下载失败的用户也有这一层）
    let mut parsed = dedup_keys(keyed(
        db_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|t| {
                parse_caps_map(&t)
                    .into_iter()
                    .filter(|(k, _)| !k.contains(':'))
                    .collect()
            })
            .unwrap_or_default(),
    ));
    merge_tables(&mut parsed, dedup_keys(keyed(parse_caps_map(BUNDLED_DB))));
    if let Ok(mut g) = cache.write() {
        *g = Some(parsed.clone());
    }
    parsed
}

/// 统一写法后同名的只留第一条
fn dedup_keys<T>(table: Vec<(String, T)>) -> Vec<(String, T)> {
    let mut seen = std::collections::HashSet::new();
    table.into_iter().filter(|(k, _)| seen.insert(k.clone())).collect()
}

/// 公共能力库的定价层（usage.rs 定价链消费：内置表 < 公共库 < 用户 pricing.json）。
/// 同一份 model-capabilities-db.json 里的 cost 字段；单测不读本机真实文件
pub(crate) fn db_price_table() -> Vec<(String, (f64, f64))> {
    if cfg!(test) {
        return Vec::new();
    }
    let cache = DB_PRICE_CACHE.get_or_init(|| std::sync::RwLock::new(None));
    if let Some(cached) = cache.read().ok().and_then(|g| g.clone()) {
        return cached;
    }
    let mut parsed = dedup_keys(keyed(
        db_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|t| {
                parse_price_map(&t)
                    .into_iter()
                    .filter(|(k, _)| !k.contains(':'))
                    .collect()
            })
            .unwrap_or_default(),
    ));
    merge_tables(&mut parsed, dedup_keys(keyed(parse_price_map(BUNDLED_DB))));
    if let Ok(mut g) = cache.write() {
        *g = Some(parsed.clone());
    }
    parsed
}

fn invalidate_db_cache() {
    if let Some(c) = DB_CACHE.get() {
        if let Ok(mut g) = c.write() {
            *g = None;
        }
    }
    if let Some(c) = DB_PRICE_CACHE.get() {
        if let Ok(mut g) = c.write() {
            *g = None;
        }
    }
}

/// grok 的 apiBackend 合法值（grok-build parse_remote_model_value 实证闭集）
const GROK_API_BACKENDS: [&str; 3] = ["chat_completions", "responses", "messages"];

/// OpenRouter 风格 /models 响应 → 能力表（网关实测缓存与公共库回落共用）。
/// 只提取能力字段；一个字段都没有的条目丢弃（纯 id 列表不动缓存）。
/// context 兼容 grok 目录的驼峰/snake 别名（contextWindow/context_window/
/// _meta.totalContextTokens，与 grok parse_remote_model_value 同口径）；
/// apiBackend/api_backend 只收闭集值
pub(crate) fn parse_openrouter_models(v: &serde_json::Value) -> Vec<(String, ModelCaps)> {
    let mut out = Vec::new();
    let Some(arr) = v.get("data").and_then(|d| d.as_array()) else {
        return out;
    };
    for item in arr {
        let Some(id) = item.get("id").and_then(|i| i.as_str()) else {
            continue;
        };
        let context = item
            .get("context_length")
            .and_then(|n| n.as_i64())
            .or_else(|| item.get("top_provider")?.get("context_length")?.as_i64())
            // grok 目录别名（parse_remote_model_value 同口径链）
            .or_else(|| item.get("contextWindow")?.as_i64())
            .or_else(|| item.get("context_window")?.as_i64())
            .or_else(|| item.get("_meta")?.get("totalContextTokens")?.as_i64())
            .filter(|n| *n > 0);
        let output = item
            .get("top_provider")
            .and_then(|t| t.get("max_completion_tokens"))
            .and_then(|n| n.as_i64())
            .or_else(|| item.get("max_output_tokens").and_then(|n| n.as_i64()))
            .filter(|n| *n > 0);
        let vision = item
            .get("architecture")
            .and_then(|a| a.get("input_modalities"))
            .and_then(|m| m.as_array())
            .map(|ms| ms.iter().any(|m| m.as_str() == Some("image")));
        // supported_parameters 字段存在 → 按有没有 reasoning 给显式 true/false；
        // 字段整个缺席 → None（这层不知道，查询链继续向下，不能错记成 false）
        let thinking = item
            .get("supported_parameters")
            .and_then(|p| p.as_array())
            .map(|ps| {
                ps.iter()
                    .any(|p| matches!(p.as_str(), Some("reasoning") | Some("include_reasoning")))
            });
        let api_backend = item
            .get("apiBackend")
            .or_else(|| item.get("api_backend"))
            .and_then(|b| b.as_str())
            .filter(|s| GROK_API_BACKENDS.contains(s))
            .map(str::to_string);
        if context.is_none()
            && output.is_none()
            && vision.is_none()
            && thinking.is_none()
            && api_backend.is_none()
        {
            continue;
        }
        out.push((
            normalize(id),
            ModelCaps {
                thinking,
                context,
                output,
                vision,
                api_backend,
            },
        ));
    }
    out
}

/// models.dev 里的原厂（2026-10-28）：同一型号常被十几家服务商各列一次（各家的上下文、价格可能被裁剪或加价），
/// 原厂先读、先到先得；其余按名字顺序，结果稳定
const MODELS_DEV_VENDORS: &[&str] = &[
    "anthropic", "openai", "google", "xai", "deepseek", "moonshotai", "zhipuai", "alibaba", "mistral",
];

/// models.dev 的服务商按「原厂在前」排好，供两个解析函数共用
fn models_dev_providers(v: &serde_json::Value) -> Vec<(&String, &serde_json::Value)> {
    let Some(providers) = v.as_object() else {
        return Vec::new();
    };
    let mut list: Vec<(&String, &serde_json::Value)> = providers.iter().collect();
    list.sort_by_key(|(name, _)| {
        (
            MODELS_DEV_VENDORS.iter().position(|v| v == name).unwrap_or(usize::MAX),
            name.to_string(),
        )
    });
    list
}

/// models.dev 的 api.json（{provider: {models: {id: {...}}}}）→ 同一能力表形状。
/// 键用统一写法、同一型号只留一条（原厂优先），`:batch` 这类变体不收
fn parse_models_dev(v: &serde_json::Value) -> Vec<(String, ModelCaps)> {
    let mut out = Vec::new();
    for (_provider, pv) in models_dev_providers(v) {
        let Some(models) = pv.get("models").and_then(|m| m.as_object()) else {
            continue;
        };
        for (id, mv) in models {
            if id.contains(':') {
                continue;
            }
            let context = mv
                .get("limit")
                .and_then(|l| l.get("context"))
                .and_then(|n| n.as_i64())
                .filter(|n| *n > 0);
            let output = mv
                .get("limit")
                .and_then(|l| l.get("output"))
                .and_then(|n| n.as_i64())
                .filter(|n| *n > 0);
            let vision = mv
                .get("modalities")
                .and_then(|m| m.get("input"))
                .and_then(|i| i.as_array())
                .map(|ms| ms.iter().any(|m| m.as_str() == Some("image")));
            let thinking = mv.get("reasoning").and_then(|b| b.as_bool());
            if context.is_none() && output.is_none() && vision.is_none() && thinking.is_none() {
                continue;
            }
            out.push((
                model_key(id),
                ModelCaps {
                    thinking,
                    context,
                    output,
                    vision,
                    api_backend: None, // models.dev 公共库不携带 wire 后端
                },
            ));
        }
    }
    dedup_keys(out)
}

// ===== 定价提取（2026-08-31）：同一份公共库响应顺带落 cost，usage.rs 定价链消费 =====

/// models.dev 条目的 cost.{input,output}（美元/每百万 token）→ (id, (输入价, 输出价))
fn parse_models_dev_prices(v: &serde_json::Value) -> Vec<(String, (f64, f64))> {
    let mut out = Vec::new();
    for (_provider, pv) in models_dev_providers(v) {
        let Some(models) = pv.get("models").and_then(|m| m.as_object()) else {
            continue;
        };
        for (id, mv) in models {
            if id.contains(':') {
                continue;
            }
            let Some(cost) = mv.get("cost") else { continue };
            let pair = match (
                cost.get("input").and_then(|n| n.as_f64()),
                cost.get("output").and_then(|n| n.as_f64()),
            ) {
                (Some(i), Some(o)) if i.is_finite() && i >= 0.0 && o.is_finite() && o >= 0.0 => {
                    (i, o)
                }
                _ => continue,
            };
            out.push((model_key(id), pair));
        }
    }
    dedup_keys(out)
}

/// OpenRouter 风格条目的 pricing.{prompt,completion}（每 token 美元，字符串）→
/// 每百万 token 价格。两家数据源解析进同一形状
fn parse_openrouter_prices(v: &serde_json::Value) -> Vec<(String, (f64, f64))> {
    let mut out = Vec::new();
    let Some(arr) = v.get("data").and_then(|d| d.as_array()) else {
        return out;
    };
    for item in arr {
        let Some(id) = item.get("id").and_then(|i| i.as_str()) else {
            continue;
        };
        let per_million = |key: &str| {
            item.get("pricing")?
                .get(key)?
                .as_str()?
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(|n| n * 1_000_000.0)
        };
        let (Some(i), Some(o)) = (per_million("prompt"), per_million("completion")) else {
            continue;
        };
        out.push((normalize(id), (i, o)));
    }
    out
}

/// 公共库落盘文件里的 cost 字段解析（{"模型": {"cost": [输入价, 输出价], ...}}）
fn parse_price_map(text: &str) -> Vec<(String, (f64, f64))> {
    let mut out = Vec::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return out;
    };
    if let Some(obj) = v.as_object() {
        for (prefix, entry) in obj {
            // 空前缀会匹配一切模型名，视为配置错误直接忽略（同 caps 口径）；下划线键是说明
            if prefix.trim().is_empty() || prefix.starts_with('_') {
                continue;
            }
            let Some(pair) = entry.get("cost").and_then(|c| c.as_array()) else {
                continue;
            };
            if pair.len() != 2 {
                continue;
            }
            if let (Some(i), Some(o)) = (pair[0].as_f64(), pair[1].as_f64()) {
                if i.is_finite() && i >= 0.0 && o.is_finite() && o >= 0.0 {
                    out.push((prefix.to_lowercase(), (i, o)));
                }
            }
        }
    }
    out
}

/// fetch_models 顺带调用：把网关 /models 响应里的元数据合并进实测缓存。
/// 返回值 = 响应里能解析出的能力条数（即使还没有 gateway id、不能落盘，也据实计数，
/// 避免新建网关拉取时 UI 一律显示「未提供能力元数据」）。
/// 键为 `{gatewayId}|{model}`；无网关 id 只计数不写（禁止再写无前缀键互踩）。
pub(crate) fn record_relay_models(v: &serde_json::Value, gateway_id: Option<&str>) -> usize {
    let count = parse_openrouter_models(v).len();
    let Some(gid) = gateway_id.filter(|s| !s.is_empty()) else {
        return count;
    };
    let Some(path) = relay_cache_path() else {
        return count;
    };
    let _ = record_relay_models_to(&path, v, gid);
    count
}

/// record_relay_models 的可注入内核（测试用）
fn record_relay_models_to(path: &Path, v: &serde_json::Value, gateway_id: &str) -> usize {
    let fresh = parse_openrouter_models(v);
    if fresh.is_empty() {
        return 0;
    }
    let count = fresh.len();
    let mut map: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    for (id, c) in fresh {
        map.insert(
            format!("{gateway_id}|{id}"),
            serde_json::json!({
                "thinking": c.thinking,
                "context": c.context,
                "output": c.output,
                "vision": c.vision,
                "api_backend": c.api_backend,
            }),
        );
    }
    let Ok(text) =
        serde_json::to_string_pretty(&serde_json::Value::Object(map)).map_err(|e| e.to_string())
    else {
        return 0;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = crate::profiles::atomic_write(path, &text);
    count
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDbStatusDto {
    pub downloaded: bool,
    pub models: usize,
    /// 带定价（cost 字段）的条目数：统计页费用估算的数据源覆盖度
    pub priced_models: usize,
    /// 下载时间（本地文件 mtime，RFC3339）
    pub downloaded_at: Option<String>,
    /// 随包快照的条目数与生成时间（没下载过时这一层在用）
    pub bundled_models: usize,
    pub bundled_at: Option<String>,
}

/// 公共能力库状态（设置/配置页展示用）
#[tauri::command]
pub async fn model_db_status() -> Result<ModelDbStatusDto, String> {
    tauri::async_runtime::spawn_blocking(model_db_status_sync)
        .await
        .map_err(|e| e.to_string())
}
fn model_db_status_sync() -> ModelDbStatusDto {
    let Some(path) = db_path() else {
        return ModelDbStatusDto {
            downloaded: false,
            models: 0,
            priced_models: 0,
            downloaded_at: None,
            bundled_models: bundled_meta().0,
            bundled_at: bundled_meta().1,
        };
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return ModelDbStatusDto {
            downloaded: false,
            models: 0,
            priced_models: 0,
            downloaded_at: None,
            bundled_models: bundled_meta().0,
            bundled_at: bundled_meta().1,
        };
    };
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let models = parse_caps_map(&text).len();
    let priced_models = parse_price_map(&text).len();
    let downloaded_at = meta.modified().ok().and_then(|t| {
        let secs = t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
        chrono::DateTime::from_timestamp(secs, 0).map(|d| d.to_rfc3339())
    });
    let (bundled_models, bundled_at) = bundled_meta();
    ModelDbStatusDto {
        downloaded: true,
        models,
        priced_models,
        downloaded_at,
        bundled_models,
        bundled_at,
    }
}

/// 设置里填了、且格式有效的出网代理（国内网络直连 models.dev 基本连不上，2026-10-28 起下载能力库也走它）
fn outbound_proxy() -> Option<String> {
    if cfg!(test) {
        return None;
    }
    let s = crate::settings::read_current();
    s.outbound_proxy
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty() && crate::settings::validate_outbound_proxy(p).is_ok())
        .map(str::to_string)
}

/// 公共库多久算旧：超过就在启动时后台重下（2026-10-28：原先只能手动下载，没下过的用户这一层是空的）
const DB_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(14 * 24 * 3600);

/// 启动时调用：公共库没下过或超过 14 天，后台下一次；失败不打扰（随包快照兜底，连接页 ⋯ 里照旧能手动下）
pub fn spawn_auto_refresh() {
    if cfg!(test) {
        return;
    }
    let stale = db_path()
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .is_none_or(|age| age > DB_MAX_AGE);
    if stale {
        tauri::async_runtime::spawn(async {
            let _ = download_model_db().await;
        });
    }
}

// ===== 公共库数据源（2026-10-28 改）=====
//
// models.dev（社区中立库，233 家服务商、按原厂写法）+ LiteLLM 的模型表（jsDelivr 镜像，国内直连通常可达，
// 原厂写法）两家都下、按型号合并（models.dev 先到先得，LiteLLM 补它没有的）；两家都不通才退 OpenRouter
// （它只列自己转售的模型、写法带点号）。每家先直连，连不上且设了出网代理再经代理试一次。
// 发版时还把合并结果存成随包快照（data/model-db-snapshot.json），新装、没联网的用户也有这一层。

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DbSource {
    ModelsDev,
    LiteLlm,
    OpenRouter,
}

impl DbSource {
    fn url(self) -> &'static str {
        match self {
            DbSource::ModelsDev => "https://models.dev/api.json",
            DbSource::LiteLlm => {
                "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json"
            }
            DbSource::OpenRouter => "https://openrouter.ai/api/v1/models",
        }
    }
    fn name(self) -> &'static str {
        match self {
            DbSource::ModelsDev => "models.dev",
            DbSource::LiteLlm => "LiteLLM",
            DbSource::OpenRouter => "OpenRouter",
        }
    }
    /// models.dev 本机常超时：短超时先放弃、换代理或下一家，避免空等
    fn timeout(self) -> std::time::Duration {
        std::time::Duration::from_secs(match self {
            DbSource::ModelsDev => 10,
            DbSource::LiteLlm => 25,
            DbSource::OpenRouter => 20,
        })
    }
    fn parse(self, v: &serde_json::Value) -> (CapsTable, PriceTable) {
        match self {
            DbSource::ModelsDev => (parse_models_dev(v), parse_models_dev_prices(v)),
            DbSource::LiteLlm => parse_litellm(v),
            // OpenRouter 的 `x:free` / `x:extended` 是同一型号的变体（价格、上下文不同），公共库不收
            DbSource::OpenRouter => (
                dedup_keys(keyed(
                    parse_openrouter_models(v).into_iter().filter(|(k, _)| !k.contains(':')).collect(),
                )),
                dedup_keys(keyed(
                    parse_openrouter_prices(v).into_iter().filter(|(k, _)| !k.contains(':')).collect(),
                )),
            ),
        }
    }
}

type CapsTable = Vec<(String, ModelCaps)>;
type PriceTable = Vec<(String, (f64, f64))>;

/// LiteLLM 里的原厂：同一型号还以 bedrock/vertex/openrouter 等前缀各列一次，原厂、不带前缀的先收
const LITELLM_VENDORS: &[&str] = &[
    "anthropic", "openai", "gemini", "xai", "deepseek", "moonshot", "zai", "dashscope", "mistral",
];

/// LiteLLM model_prices_and_context_window.json → 同一能力表 / 价目形状。只收对话模型（chat / responses），
/// 出图、向量等不收；sample_spec 是格式说明不是模型
fn parse_litellm(v: &serde_json::Value) -> (CapsTable, PriceTable) {
    let Some(obj) = v.as_object() else {
        return (Vec::new(), Vec::new());
    };
    let mut items: Vec<(&String, &serde_json::Value)> = obj
        .iter()
        .filter(|(k, e)| {
            k.as_str() != "sample_spec"
                && matches!(e.get("mode").and_then(|m| m.as_str()), Some("chat") | Some("responses"))
        })
        .collect();
    let rank = |k: &str, e: &serde_json::Value| {
        let vendor = e.get("litellm_provider").and_then(|p| p.as_str()).unwrap_or("");
        let native = !k.contains('/') && LITELLM_VENDORS.contains(&vendor);
        (if native { 0 } else { 1 }, k.to_string())
    };
    items.sort_by_key(|(k, e)| rank(k, e));
    let mut caps = Vec::new();
    let mut prices = Vec::new();
    for (id, e) in items {
        let int = |key: &str| e.get(key).and_then(|n| n.as_i64()).filter(|n| *n > 0);
        let context = int("max_input_tokens").or_else(|| int("max_tokens"));
        let output = int("max_output_tokens");
        let vision = e.get("supports_vision").and_then(|b| b.as_bool());
        let thinking = e.get("supports_reasoning").and_then(|b| b.as_bool());
        let key = model_key(id);
        if context.is_some() || output.is_some() || vision.is_some() || thinking.is_some() {
            caps.push((key.clone(), ModelCaps { thinking, context, output, vision, api_backend: None }));
        }
        let per_million = |k: &str| {
            e.get(k).and_then(|n| n.as_f64()).filter(|n| n.is_finite() && *n >= 0.0).map(|n| n * 1_000_000.0)
        };
        if let (Some(i), Some(o)) = (per_million("input_cost_per_token"), per_million("output_cost_per_token")) {
            prices.push((key, (i, o)));
        }
    }
    (dedup_keys(caps), dedup_keys(prices))
}

async fn fetch_json(url: &str, timeout: std::time::Duration, via: Option<&str>) -> Result<serde_json::Value, String> {
    let mut builder = reqwest::Client::builder().timeout(timeout);
    if let Some(p) = via {
        builder = builder.proxy(reqwest::Proxy::all(p).map_err(|e| format!("出网代理不可用：{e}"))?);
    }
    let client = builder.build().map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let resp = client.get(url).send().await.map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("返回 HTTP {}", resp.status()));
    }
    let bytes = crate::storage::response_bytes(resp, 48 * 1024 * 1024).await?;
    serde_json::from_slice(&bytes).map_err(|e| format!("解析失败: {e}"))
}

/// 一家数据源：先直连，不通且设了出网代理再经代理
async fn fetch_source(src: DbSource, proxy: Option<&str>) -> Result<(CapsTable, PriceTable), String> {
    let mut errs = Vec::new();
    for via in std::iter::once(None).chain(proxy.map(Some)) {
        match fetch_json(src.url(), src.timeout(), via).await {
            Ok(v) => {
                let (caps, prices) = src.parse(&v);
                if !caps.is_empty() {
                    return Ok((caps, prices));
                }
                errs.push("响应解析为空".to_string());
            }
            Err(e) => errs.push(format!("{}{e}", if via.is_some() { "经出网代理" } else { "" })),
        }
    }
    Err(format!("{}：{}", src.name(), errs.join("；")))
}

/// 按型号合并：先到的那家先占，后面的只补它没有的
fn merge_tables<T>(into: &mut Vec<(String, T)>, more: Vec<(String, T)>) {
    let seen: std::collections::HashSet<String> = into.iter().map(|(k, _)| k.clone()).collect();
    into.extend(more.into_iter().filter(|(k, _)| !seen.contains(k)));
}

/// 下载并合并公共库；返回 (能力表, 价目表, 用到的数据源)
async fn fetch_db() -> Result<(CapsTable, PriceTable, Vec<&'static str>), String> {
    let proxy = outbound_proxy();
    let (mut caps, mut prices, mut used, mut errs) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    // 两家并发下（各自先直连、再经代理）
    let (pa, pb) = (proxy.clone(), proxy.clone());
    let ha = tauri::async_runtime::spawn(async move { fetch_source(DbSource::ModelsDev, pa.as_deref()).await });
    let hb = tauri::async_runtime::spawn(async move { fetch_source(DbSource::LiteLlm, pb.as_deref()).await });
    let a = ha.await.map_err(|e| e.to_string()).and_then(|r| r);
    let b = hb.await.map_err(|e| e.to_string()).and_then(|r| r);
    for (src, got) in [(DbSource::ModelsDev, a), (DbSource::LiteLlm, b)] {
        match got {
            Ok((c, p)) => {
                merge_tables(&mut caps, c);
                merge_tables(&mut prices, p);
                used.push(src.name());
            }
            Err(e) => errs.push(e),
        }
    }
    if used.is_empty() {
        match fetch_source(DbSource::OpenRouter, proxy.as_deref()).await {
            Ok((c, p)) => {
                caps = c;
                prices = p;
                used.push(DbSource::OpenRouter.name());
            }
            Err(e) => errs.push(e),
        }
    }
    if used.is_empty() {
        return Err(format!("模型能力库下载失败：{}", errs.join("；")));
    }
    Ok((caps, prices, used))
}

/// 落盘形状（下载结果与随包快照同一份）：{型号: {thinking, context, output, vision, cost: [输入价, 输出价]}}，
/// 键已是统一写法；`_meta` 记来源与时间（解析时跳过 `_` 开头的键）
fn db_json(caps: &CapsTable, prices: &PriceTable, sources: &[&str]) -> Result<String, String> {
    let price_of_id: std::collections::HashMap<&str, (f64, f64)> =
        prices.iter().map(|(id, p)| (id.as_str(), *p)).collect();
    let mut map = serde_json::Map::new();
    map.insert(
        "_meta".into(),
        serde_json::json!({ "sources": sources, "generatedAt": chrono::Utc::now().to_rfc3339() }),
    );
    for (id, c) in caps {
        let mut entry = serde_json::Map::new();
        for (k, v) in [
            ("thinking", serde_json::json!(c.thinking)),
            ("context", serde_json::json!(c.context)),
            ("output", serde_json::json!(c.output)),
            ("vision", serde_json::json!(c.vision)),
        ] {
            if !v.is_null() {
                entry.insert(k.into(), v);
            }
        }
        if let Some((i, o)) = price_of_id.get(id.as_str()) {
            entry.insert("cost".into(), serde_json::json!([i, o]));
        }
        map.insert(id.clone(), serde_json::Value::Object(entry));
    }
    // 只有定价、没有能力字段的条目也保留（费用估算不需要能力声明）
    for (id, p) in prices {
        if !map.contains_key(id) {
            map.insert(id.clone(), serde_json::json!({ "cost": [p.0, p.1] }));
        }
    }
    serde_json::to_string(&serde_json::Value::Object(map)).map_err(|e| e.to_string())
}

/// 下载公共模型能力库（连接页 ⋯「更新模型能力库」与启动时自动更新共用）。
/// 能力之外顺带提取定价（cost），统计页费用估算与能力声明共用同一份快照
#[tauri::command]
pub async fn download_model_db() -> Result<ModelDbStatusDto, String> {
    let (caps, prices, used) = fetch_db().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = db_path().ok_or("无法确定平台配置目录")?;
        let text = db_json(&caps, &prices, &used)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        crate::profiles::atomic_write(&path, &text)?;
        invalidate_db_cache();
        Ok(model_db_status_sync())
    })
    .await
    .map_err(|e| format!("保存模型能力库失败: {e}"))?
}

/// 剥中转/聚合的 provider 前缀（zetatechs/kimi-k3、openai/gpt-5），按末段模型名匹配
/// （同 usage.rs price_of 口径）。关键词推断用这个（保留原样的点号）；查表用 [`model_key`]
fn normalize(model: &str) -> String {
    model.rsplit('/').next().unwrap_or(model).to_lowercase()
}

/// 查表用的统一写法（2026-10-28）：在 normalize 之上去掉 `:batch` / `:free` 这类变体后缀、点号当横杠。
/// OpenRouter 写 `claude-opus-5.5`，Anthropic / Claude Code 写 `claude-opus-5-5`；不统一时完整名对不上，
/// 按前缀退到 `claude-opus-5`（上一代），价格跟着错（Opus 5.5 被按 Opus 5 计）
pub(crate) fn model_key(model: &str) -> String {
    let m = normalize(model);
    let m = m.split(':').next().unwrap_or(&m);
    m.trim().replace('.', "-")
}

/// 快照日期 / latest 后缀去掉后的「同一型号」：claude-opus-4-1-20250805、deepseek-v4-flash-latest。
/// 只认 8 位日期、YYYY-MM-DD 与 latest；四位数（qwen3-…-2507、gpt-4-0613）是版本号不是快照，不剥
fn snapshot_base(key: &str) -> &str {
    if let Some(rest) = key.strip_suffix("-latest") {
        return rest;
    }
    let bytes = key.as_bytes();
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if let Some((head, tail)) = key.rsplit_once('-') {
        if tail.len() == 8 && digits(tail) {
            return head;
        }
    }
    // YYYY-MM-DD：末尾 11 个字符是 -dddd-dd-dd
    if bytes.len() > 11 {
        let tail = &key[key.len() - 11..];
        let parts: Vec<&str> = tail[1..].split('-').collect();
        if tail.starts_with('-')
            && parts.len() == 3
            && parts[0].len() == 4
            && parts[1].len() == 2
            && parts[2].len() == 2
            && parts.iter().all(|p| digits(p))
        {
            return &key[..key.len() - 11];
        }
    }
    key
}

/// 一层表怎么认模型：用户覆盖与内置表写的是「前缀」（一个系列一条），按最长前缀；
/// 网关实测与公共库是逐个型号的完整名，只认同一型号（统一写法后相等，或去掉快照后缀后相等）——
/// 按前缀退到别的型号会张冠李戴（2026-10-28：中转自起名的模型拿到另一个型号的上下文和价格）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyMatch {
    Prefix,
    Exact,
}

/// 把表的键换成统一写法（加载时做一次）
pub(crate) fn keyed<T>(table: Vec<(String, T)>) -> Vec<(String, T)> {
    table.into_iter().map(|(k, v)| (model_key(&k), v)).collect()
}

/// 单层查询：键须已是 [`model_key`] 写法，`key` 同
pub(crate) fn match_in<'a, T>(table: &'a [(String, T)], key: &str, how: KeyMatch) -> Option<&'a T> {
    match how {
        KeyMatch::Prefix => table
            .iter()
            .filter(|(p, _)| key.starts_with(p.as_str()))
            .max_by_key(|(p, _)| p.len())
            .map(|(_, c)| c),
        KeyMatch::Exact => table.iter().find(|(k, _)| k == key).map(|(_, c)| c).or_else(|| {
            let base = snapshot_base(key);
            table.iter().find(|(k, _)| snapshot_base(k) == base).map(|(_, c)| c)
        }),
    }
}

/// 逐字段链式查询内核（测试可注入表）：每层按该层的认法命中，命中但字段为 None
/// （这层不知道）时继续向下——不是整条命中即返回。官方账号的模型别名（opus、sonnet…）先换成实测的完整型号
fn chain_field<T>(
    tables: &[(Vec<(String, ModelCaps)>, KeyMatch)],
    model: &str,
    f: impl Fn(&ModelCaps) -> Option<T>,
) -> Option<T> {
    let resolved = crate::model_aliases::resolve(model);
    let key = model_key(&resolved);
    for (table, how) in tables {
        if let Some(c) = match_in(table, &key, *how) {
            if let Some(v) = f(c) {
                return Some(v);
            }
        }
    }
    None
}

fn builtin_table() -> Vec<(String, ModelCaps)> {
    keyed(
        BUILTIN_CAPS
            .iter()
            .map(|(p, c)| (p.to_string(), c.clone()))
            .collect(),
    )
}

/// 逐字段查询链：用户覆盖 > 网关实测缓存（需 gateway_id）> 公共能力库 > 内置表。
fn lookup_field_for<T>(
    model: &str,
    gateway_id: Option<&str>,
    f: impl Fn(&ModelCaps) -> Option<T>,
) -> Option<T> {
    let tables = [
        (keyed(load_override()), KeyMatch::Prefix),
        (keyed(load_relay_for(gateway_id)), KeyMatch::Exact),
        (load_db(), KeyMatch::Exact),
        (builtin_table(), KeyMatch::Prefix),
    ];
    chain_field(&tables, model, f)
}

/// 上下文窗口（仅限权威层：用户覆盖 + 网关实测缓存，公共库/内置表/关键词一律不算）。
/// 供 grok「设为全局」写 [model.*].context_window——grok 里 config 的 [model.*] 优先级
/// 高于中转 /models 目录，估值层不配覆盖目录声明；这两层都不知道就不写（grok 按目录或
/// 256_000 默认计）
pub(crate) fn model_context_size_authoritative_for(
    model: &str,
    gateway_id: Option<&str>,
) -> Option<i64> {
    let tables = [
        (keyed(load_override()), KeyMatch::Prefix),
        (keyed(load_relay_for(gateway_id)), KeyMatch::Exact),
    ];
    chain_field(&tables, model, |c| c.context)
}

/// Best available persisted context declaration for a CLI config file.
/// User overrides and gateway metadata win; the public database is used only
/// when it has an explicit value, never the generic fallback estimate.
pub(crate) fn model_context_size_for_config(model: &str, gateway_id: Option<&str>) -> Option<i64> {
    let tables = [
        (keyed(load_override()), KeyMatch::Prefix),
        (keyed(load_relay_for(gateway_id)), KeyMatch::Exact),
        (load_db(), KeyMatch::Exact),
    ];
    chain_field(&tables, model, |c| c.context)
}

/// Grok 目录声明的 apiBackend（仅权威层：用户覆盖/网关实测缓存）。
/// 供预览说实话（「目录已声明 responses」）与设为全局参考
pub(crate) fn model_api_backend_for(model: &str, gateway_id: Option<&str>) -> Option<String> {
    let tables = [
        (keyed(load_override()), KeyMatch::Prefix),
        (keyed(load_relay_for(gateway_id)), KeyMatch::Exact),
    ];
    chain_field(&tables, model, |c| c.api_backend.clone())
}

/// 关键词推断兜底（注册表未命中时）：覆盖中转改名/全新模型的常见命名。
/// 新推理模型出现时优先补内置表（准确），关键词表只兜底。
fn keyword_thinking(model: &str) -> bool {
    let m = normalize(model);
    m.contains("thinking")
        || m.contains("reasoner")
        || m.contains("-r1")
        || m.contains("qwq")
        || m.contains("glm-z1")
        || m.starts_with("kimi-k2.5")
        || m.starts_with("kimi-k2.6")
        || m.starts_with("kimi-k2.7")
        || m.starts_with("kimi-k3")
}

/// 保守默认上下文映射（注册表条目不填 context 或未命中时的兜底）：
/// kimi 系按官方映射，其余 128K 保守值
fn fallback_context_size(model: &str) -> i64 {
    kimi_official_context(model).unwrap_or(131_072)
}

/// kimi 系的官方上下文映射（确知值，不是猜的）
fn kimi_official_context(model: &str) -> Option<i64> {
    let m = normalize(model);
    if m.starts_with("kimi-k3") {
        Some(1_048_576)
    } else if m.starts_with("kimi-k2.6") || m.starts_with("kimi-k2.7") {
        Some(262_144)
    } else {
        None
    }
}

/// 给人看的上下文窗口：查询链有声明或属 kimi 官方映射才 Some，**不拿 128K 保守值冒充**。
/// 原先状态栏 / 聊天层上下文圈用的是带兜底的 `model_context_size_for`，库里没有的模型一律显示「131K」，
/// 而 CLI 自己按各自默认算（Gemini 1M、Claude / Qwen 200K），圈比 CLI 实际满得多（2026-10-21 gemini-4-argon 用户质疑）
pub(crate) fn model_context_size_known_for(model: &str, gateway_id: Option<&str>) -> Option<i64> {
    lookup_field_for(model, gateway_id, |c| c.context).or_else(|| kimi_official_context(model))
}

/// 模型是否支持思考：逐字段查询链 → 关键词推断兜底
#[cfg_attr(not(test), allow(dead_code))]
pub fn model_thinking(model: &str) -> bool {
    model_thinking_for(model, None)
}

pub fn model_thinking_for(model: &str, gateway_id: Option<&str>) -> bool {
    lookup_field_for(model, gateway_id, |c| c.thinking).unwrap_or_else(|| keyword_thinking(model))
}

/// 思考能力的**声明层**视图：只有查询链里有显式声明（用户覆盖/网关实测/公共库/内置表）
/// 才返回 Some，关键词推断与「未命中即 false」都不算。
///
/// 用途：区分「确知不思考」与「不知道」。`model_thinking_for` 把两者都压成 false，
/// 拿它做**破坏性**决策（清掉用户已存的 reasoning_effort）时，未知模型会被当成
/// 不思考，用户配置被无声抹掉。只有 `Some(false)` 配当删除依据。
pub(crate) fn model_thinking_declared_for(model: &str, gateway_id: Option<&str>) -> Option<bool> {
    lookup_field_for(model, gateway_id, |c| c.thinking)
}

/// 模型上下文窗口：逐字段查询链 → 保守默认映射
#[cfg_attr(not(test), allow(dead_code))]
pub fn model_context_size(model: &str) -> i64 {
    model_context_size_for(model, None)
}

pub fn model_context_size_for(model: &str, gateway_id: Option<&str>) -> i64 {
    lookup_field_for(model, gateway_id, |c| c.context)
        .unwrap_or_else(|| fallback_context_size(model))
}

/// 上下文窗口的**声明层**视图：查询链里有显式值才 Some。
///
/// 与 `model_context_size_for` 的分工：那个永远给一个数（控制面板显示、UI 估算要有个数），
/// 这个只回答「我们确知吗」。写进**别人家配置文件**的值必须走这条——把 128K 保守默认
/// 当声明写进 codex catalog，会让 1M 上下文的模型在真实窗口里被 codex 按 128K 提前压缩，
/// 比不写更坏（codex 自己认得时以目录为准，我们不写它反而算得对）。
pub(crate) fn model_context_size_declared_for(
    model: &str,
    gateway_id: Option<&str>,
) -> Option<i64> {
    lookup_field_for(model, gateway_id, |c| c.context)
}

/// 输出上限的**声明层**视图：查询链里有显式值才 Some（内置表 output 全为 None，
/// 所以现状等于「只有用户覆盖/网关实测/公共库声明才算」）。opencode 的 limit.output
/// 是 schema 必填，调用方拿 None 时只能写保守值，但至少知道那是保守值而非声明。
pub(crate) fn model_output_limit_declared_for(
    model: &str,
    gateway_id: Option<&str>,
) -> Option<i64> {
    lookup_field_for(model, gateway_id, |c| c.output)
}

/// 输出上限兜底：models.dev 上多数 chat 模型的常见值，保守不越界
/// （opencode 拿 limit.output 当 max output tokens 用，宁小勿大）
const DEFAULT_OUTPUT_LIMIT: i64 = 8192;

/// 模型输出上限：逐字段查询链 → 保守默认
#[cfg_attr(not(test), allow(dead_code))]
pub fn model_output_limit(model: &str) -> i64 {
    model_output_limit_for(model, None)
}

pub fn model_output_limit_for(model: &str, gateway_id: Option<&str>) -> i64 {
    lookup_field_for(model, gateway_id, |c| c.output).unwrap_or(DEFAULT_OUTPUT_LIMIT)
}

/// 是否支持图像输入：逐字段查询链有显式声明（true/false 都算数——网关如实报了
/// input_modalities 就听它的）→ 未声明时回落确知多模态清单（宁缺毋滥——给纯文本
/// 模型声明图像输入会让用户拖图进去才报错）。
/// codex catalog 的 input_modalities / kimi capabilities image_in / opencode modalities 用
#[cfg_attr(not(test), allow(dead_code))]
pub fn model_supports_vision(model: &str) -> bool {
    model_supports_vision_for(model, None)
}

pub fn model_supports_vision_for(model: &str, gateway_id: Option<&str>) -> bool {
    // 确知多模态清单已收进 BUILTIN_CAPS（capsv），链上就能查到；未命中即「不知道」，
    // 保守当不支持（宁缺毋滥——宁可少声明，不可替用户把未知模型声明成多模态）
    model_supports_vision_declared_for(model, gateway_id).unwrap_or(false)
}

/// 视觉能力的**声明层**视图：只有链上有显式声明（含内置表里的确知多模态）才 Some。
/// 写进别人家配置的字段用它——None 时要么省略该键、要么按「不知道」保守处理，
/// 而不是替用户断言「这个模型是纯文本」（那会让中继上的视觉模型在 CLI 里丢掉图像输入）。
pub(crate) fn model_supports_vision_declared_for(
    model: &str,
    gateway_id: Option<&str>,
) -> Option<bool> {
    lookup_field_for(model, gateway_id, |c| c.vision)
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn model_capability(model: &str) -> ModelCapabilityDto {
    model_capability_for(model, None)
}

pub fn model_capability_for(model: &str, gateway_id: Option<&str>) -> ModelCapabilityDto {
    let normalized = normalize(model);
    // 三态如实出线：链上显式声明「不能看图」要传 Some(false)——界面靠它在带图发送前提醒
    // （曾折成 None，确知纯文本的 glm-5.3 带图发出去才吃 400，提醒从未出现过）
    let vision = model_supports_vision_declared_for(model, gateway_id);
    let video = if normalized.contains("kimi-k3") {
        Some(true)
    } else {
        None
    };
    let tools = if normalized.contains("coder")
        || normalized.contains("gpt")
        || normalized.contains("claude")
        || normalized.contains("gemini")
        || normalized.contains("kimi")
        || normalized.contains("qwen")
        || normalized.contains("deepseek")
        || normalized.contains("grok")
        || normalized.contains("glm")
    {
        Some(true)
    } else {
        None
    };
    ModelCapabilityDto {
        model: model.to_string(),
        thinking: model_thinking_for(model, gateway_id),
        context: model_context_size_known_for(model, gateway_id),
        tools,
        vision,
        video,
        streaming: Some(true),
    }
}

#[tauri::command]
pub fn model_capability_brief(gateway_id: String, model_id: String) -> ModelCapabilityDto {
    model_capability_for(&model_id, Some(gateway_id.as_str()))
}

#[tauri::command]
pub fn model_capabilities(
    models: Vec<String>,
    gateway_id: Option<String>,
) -> Vec<ModelCapabilityDto> {
    models
        .iter()
        .map(|model| model_capability_for(model, gateway_id.as_deref()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_context_does_not_pass_off_the_conservative_default() {
        // 库里没有的模型：显示层给 None，不拿 128K 兜底冒充（启动注入另有带兜底的那条）
        assert_eq!(model_context_size_known_for("gemini-4-argon", None), None);
        assert_eq!(model_capability_for("gemini-4-argon", None).context, None);
        assert_eq!(model_context_size_for("gemini-4-argon", None), 131_072);
        // kimi 官方映射是确知值
        assert_eq!(model_context_size_known_for("kimi-k3", None), Some(1_048_576));
    }

    #[test]
    fn builtin_table_hits_known_models() {
        assert!(model_thinking("kimi-k3"));
        assert!(model_thinking("kimi-k2-thinking"));
        assert!(!model_thinking("kimi-k2"));
        assert!(model_thinking("deepseek-reasoner"));
        assert!(!model_thinking("deepseek-chat"));
        assert!(model_thinking("gpt-5.1"));
        assert!(model_thinking("gpt-6-astra"));
        assert!(!model_thinking("gpt-4o"));
        assert!(model_thinking("claude-sonnet-4-5"));
        assert!(!model_thinking("claude-3-5-sonnet-20241022"));
        assert!(model_thinking("glm-4.6"));
        assert!(model_thinking("qwen3-32b"));
        assert!(!model_thinking("qwen3-coder-plus"));
        assert!(model_thinking("grok-4-1"));
        assert!(model_supports_vision("kimi-k3"));
        assert!(model_capability("kimi-k3").thinking);
        // 视觉三态：确知能看 Some(true)，查不到 None（不冒充「不能看」）；显式 false 原样透传
        assert_eq!(model_capability("kimi-k3").vision, Some(true));
        assert_eq!(model_capability("gemini-4-argon").vision, Some(true));
        assert_eq!(model_capability("mystery-model-x").vision, None);
    }

    #[test]
    fn provider_prefix_stripped_before_match() {
        assert!(model_thinking("zetatechs/kimi-k3"));
        assert!(model_thinking("openai/gpt-5-codex"));
        assert_eq!(model_context_size("some-relay/kimi-k2.6"), 262_144);
    }

    #[test]
    fn keyword_fallback_for_unknown_models() {
        // 表外模型落关键词推断
        assert!(model_thinking("some-new-model-thinking-v2"));
        assert!(model_thinking("qwq-32b-preview"));
        assert!(!model_thinking("some-random-model"));
    }

    #[test]
    fn longest_prefix_wins_over_shorter() {
        // kimi-k2-thinking 必须命中 thinking 条目，而不是被 kimi-k2（无思考）截胡
        assert!(model_thinking("kimi-k2-thinking"));
        assert!(!model_thinking("kimi-k2-0905-preview"));
    }

    #[test]
    fn output_limit_falls_back_to_conservative_default() {
        // 内置表不收 output（None）→ 一律落 8192 保守默认；覆盖文件可逐前缀配
        assert_eq!(model_output_limit("kimi-k3"), 8192);
        assert_eq!(model_output_limit("gpt-5"), 8192);
        assert_eq!(model_output_limit("some-relay/unknown-model"), 8192);
    }

    #[test]
    fn override_write_read_roundtrip_and_validation() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model-capabilities.json");

        // 写两条（含手写 api_backend 保留路径），读回与链消费同一解析器
        let list = vec![
            ModelCapsOverrideDto {
                prefix: "relay-vision-pro".into(),
                context: Some(1_048_576),
                vision: Some(true),
                thinking: None,
                output: None,
                api_backend: None,
            },
            ModelCapsOverrideDto {
                prefix: "grok-relay-x".into(),
                api_backend: Some("responses".into()),
                thinking: None,
                context: Some(500_000),
                output: None,
                vision: None,
            },
        ];
        write_overrides_to(&path, &list).unwrap();
        let read = read_overrides_at(&path);
        assert_eq!(read.len(), 2);
        // api_backend 不被 UI 往返抹掉
        assert_eq!(
            read.iter()
                .find(|e| e.prefix == "grok-relay-x")
                .unwrap()
                .api_backend,
            Some("responses".into())
        );
        // 覆盖层即时生效：链上 context/vision 按 1M 取值（cfg!(test) 只挡 load_override，
        // 这里显式走 parse_caps_map 同一入口验证文件形状）
        let parsed = parse_caps_map(&std::fs::read_to_string(&path).unwrap());
        assert!(parsed.iter().any(|(p, c)| p == "relay-vision-pro"
            && c.context == Some(1_048_576)
            && c.vision == Some(true)));

        // 校验：空前缀 / 全空字段 / 非正数
        let mut bad = ModelCapsOverrideDto {
            prefix: "  ".into(),
            thinking: None,
            context: None,
            output: None,
            vision: None,
            api_backend: None,
        };
        assert!(validate_override(&mut bad).is_err());
        bad.prefix = "x".into();
        assert!(validate_override(&mut bad).is_err());
        bad.context = Some(0);
        assert!(validate_override(&mut bad).is_err());
        // 前缀归一：大写/空白落小写
        let mut ok = ModelCapsOverrideDto {
            prefix: "  Relay-Vision-Pro ".into(),
            thinking: Some(true),
            context: None,
            output: None,
            vision: None,
            api_backend: None,
        };
        validate_override(&mut ok).unwrap();
        assert_eq!(ok.prefix, "relay-vision-pro");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_openrouter_models_extracts_capability_fields() {
        let v = serde_json::json!({"data": [
            {
                "id": "deepseek/deepseek-v3.2",
                "context_length": 163840,
                "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
                "top_provider": {"max_completion_tokens": 147456},
                "supported_parameters": ["tools", "reasoning", "structured_outputs"]
            },
            {
                "id": "someone/vision-x",
                "context_length": 262144,
                "architecture": {"input_modalities": ["text", "image"]},
                "supported_parameters": ["tools"]
            },
            {"id": "bare-id-only"}
        ]});
        let map: std::collections::HashMap<String, ModelCaps> =
            parse_openrouter_models(&v).into_iter().collect();
        let d = &map["deepseek-v3.2"];
        assert_eq!(
            d.thinking,
            Some(true),
            "supported_parameters 含 reasoning → 思考"
        );
        assert_eq!(d.context, Some(163840));
        assert_eq!(d.output, Some(147456));
        assert_eq!(d.vision, Some(false));
        let vx = &map["vision-x"];
        // supported_parameters 在场但没有 reasoning → 显式 false（网关如实声明了参数全集）
        assert_eq!(vx.thinking, Some(false));
        assert_eq!(vx.vision, Some(true));
        assert_eq!(vx.context, Some(262144));
        // 纯 id 无元数据的条目丢弃
        assert!(!map.contains_key("bare-id-only"));
    }

    #[test]
    fn anthropic_and_openai_id_lists_are_not_capability_tables() {
        // 中转常见两种 /models：Anthropic 展示字段 / OpenAI 对象字段，都没有
        // context_length / architecture / supported_parameters。
        let anthropic = serde_json::json!({"data": [{
            "id": "m1",
            "created_at": "2026-01-01T00:00:00Z",
            "display_name": "M1",
            "type": "model"
        }]});
        let openai = serde_json::json!({"data": [{
            "id": "m1",
            "object": "model",
            "created": 1,
            "owned_by": "vendor",
            "supported_endpoint_types": ["chat"]
        }]});
        assert!(parse_openrouter_models(&anthropic).is_empty());
        assert!(parse_openrouter_models(&openai).is_empty());
        assert_eq!(record_relay_models(&anthropic, None), 0);
        assert_eq!(record_relay_models(&openai, None), 0);
        let rich = serde_json::json!({"data": [{
            "id": "relay/custom",
            "context_length": 32000
        }]});
        assert_eq!(
            record_relay_models(&rich, None),
            1,
            "无网关 id 仍按响应计数"
        );
    }

    #[test]
    fn openrouter_entry_without_supported_parameters_leaves_thinking_unknown() {
        // supported_parameters 整个缺席 = 这层不知道，必须 None（不能错记 false
        // 挡住公共库的正确答案）
        let v = serde_json::json!({"data": [{
            "id": "relay/partial-model",
            "context_length": 50000,
            "architecture": {"input_modalities": ["text"]}
        }]});
        let map = parse_openrouter_models(&v);
        assert_eq!(map[0].1.thinking, None);
        assert_eq!(map[0].1.context, Some(50000));
    }

    #[test]
    fn parse_openrouter_models_accepts_grok_catalog_aliases() {
        // grok 目录字段（与 grok parse_remote_model_value 同口径）：驼峰/蛇形/_meta 的
        // context 别名 + apiBackend 闭集
        let v = serde_json::json!({"data": [
            {"id": "relay/grok-fast", "contextWindow": 262144, "apiBackend": "responses"},
            {"id": "relay/grok-snake", "context_window": 131072},
            {"id": "relay/grok-meta", "_meta": {"totalContextTokens": 200000}},
            {"id": "relay/bad-backend", "apiBackend": "weird"}
        ]});
        let map: std::collections::HashMap<String, ModelCaps> =
            parse_openrouter_models(&v).into_iter().collect();
        assert_eq!(map["grok-fast"].context, Some(262144));
        assert_eq!(map["grok-fast"].api_backend.as_deref(), Some("responses"));
        assert_eq!(map["grok-snake"].context, Some(131072));
        assert_eq!(map["grok-meta"].context, Some(200000));
        // 闭集外的 apiBackend 丢弃；该条目只有这一个字段 → 整条不沉淀
        assert!(!map.contains_key("bad-backend"));
    }

    #[test]
    fn authoritative_context_ignores_estimated_layers() {
        // cfg!(test) 下文件型加载器不读本机真实缓存 → 用户覆盖与网关缓存都为空；
        // kimi-k3 在内置表/兜底里有值（1M），权威层访问器必须仍返回 None——
        // 估值层不配写进 grok config（那里优先级高于中转目录）
        assert_eq!(model_context_size_authoritative_for("kimi-k3", None), None);
        assert_eq!(
            model_context_size_authoritative_for("openai/gpt-5", Some("gw")),
            None
        );
    }

    #[test]
    fn chain_field_falls_through_per_field_not_per_entry() {
        // 用户场景：网关缓存只有 context（其余 None），公共库同模型有 thinking——
        // 逐字段向下补：context 用网关实测，thinking 用公共库
        let relay = vec![(
            "model-x".to_string(),
            ModelCaps {
                thinking: None,
                context: Some(99999),
                output: None,
                vision: None,
                api_backend: None,
            },
        )];
        let db = vec![(
            "model-x".to_string(),
            ModelCaps {
                thinking: Some(true),
                context: Some(11111),
                output: Some(4096),
                vision: None,
                api_backend: None,
            },
        )];
        let tables = [(relay, KeyMatch::Exact), (db, KeyMatch::Exact)];
        assert_eq!(chain_field(&tables, "model-x", |c| c.context), Some(99999));
        assert_eq!(chain_field(&tables, "model-x", |c| c.thinking), Some(true));
        assert_eq!(chain_field(&tables, "model-x", |c| c.output), Some(4096));
        assert_eq!(chain_field(&tables, "model-x", |c| c.vision), None);
    }

    #[test]
    fn parse_models_dev_extracts_capability_fields() {
        let v = serde_json::json!({
            "moonshot": {"models": {"kimi-k3": {
                "reasoning": true,
                "limit": {"context": 1048576, "output": 8192},
                "modalities": {"input": ["text", "image"], "output": ["text"]}
            }}},
            "openai": {"models": {"gpt-5": {
                "reasoning": true,
                "limit": {"context": 400000, "output": 128000},
                "modalities": {"input": ["text"], "output": ["text"]}
            }}}
        });
        let map: std::collections::HashMap<String, ModelCaps> =
            parse_models_dev(&v).into_iter().collect();
        let k = &map["kimi-k3"];
        assert_eq!(k.thinking, Some(true));
        assert_eq!(k.context, Some(1_048_576));
        assert_eq!(k.vision, Some(true));
        let g = &map["gpt-5"];
        assert_eq!(g.output, Some(128000));
        assert_eq!(g.vision, Some(false));
    }

    #[test]
    fn parse_models_dev_prices_extracts_cost() {
        let v = serde_json::json!({
            "moonshot": {"models": {
                "kimi-k3": {"cost": {"input": 3.0, "output": 15.0, "cache_read": 0.3}},
                "kimi-free-x": {"cost": {"input": 0, "output": 0}},
                "kimi-no-cost": {"reasoning": true},
                "kimi-bad-cost": {"cost": {"input": -1, "output": 2}}
            }}
        });
        let map: std::collections::HashMap<String, (f64, f64)> =
            parse_models_dev_prices(&v).into_iter().collect();
        assert_eq!(map["kimi-k3"], (3.0, 15.0));
        assert_eq!(map["kimi-free-x"], (0.0, 0.0), "免费模型的如实 0 价保留");
        assert!(!map.contains_key("kimi-no-cost"), "无 cost = 这层不知道");
        assert!(!map.contains_key("kimi-bad-cost"), "非法数值丢弃");
    }

    #[test]
    fn parse_openrouter_prices_converts_per_token_to_per_million() {
        let v = serde_json::json!({"data": [
            {"id": "anthropic/claude-sonnet-5", "pricing": {"prompt": "0.000002", "completion": "0.00001"}},
            {"id": "openai/gpt-5.2", "pricing": {"prompt": "0.00000175", "completion": "0.000014"}},
            {"id": "bare/no-pricing"}
        ]});
        let map: std::collections::HashMap<String, (f64, f64)> =
            parse_openrouter_prices(&v).into_iter().collect();
        assert_eq!(map["claude-sonnet-5"], (2.0, 10.0));
        assert_eq!(map["gpt-5.2"], (1.75, 14.0));
        assert!(!map.contains_key("no-pricing"));
    }

    #[test]
    fn parse_price_map_reads_cost_field() {
        // 公共库落盘形状：能力与 cost 同条目共存；无 cost 的条目不产生定价
        let text = r#"{
            "kimi-k3": {"thinking": true, "cost": [3.0, 15.0]},
            "gpt-5": {"thinking": true, "context": 400000},
            "price-only-x": {"cost": [0.5, 1.5]},
            "": {"cost": [9.0, 9.0]}
        }"#;
        let map: std::collections::HashMap<String, (f64, f64)> =
            parse_price_map(text).into_iter().collect();
        assert_eq!(map.len(), 2);
        assert_eq!(map["kimi-k3"], (3.0, 15.0));
        assert_eq!(map["price-only-x"], (0.5, 1.5), "纯定价条目同样入定价层");
    }

    #[test]
    fn relay_cache_record_merges_and_roundtrips() {
        let dir = std::env::temp_dir().join(format!("ccode-mr-{}", uuid::Uuid::new_v4()));
        let path = dir.join("relay.json");
        let v = serde_json::json!({"data": [{
            "id": "relay/custom-model-x",
            "context_length": 99999,
            "architecture": {"input_modalities": ["text", "image"]},
            "supported_parameters": ["tools", "reasoning"],
            "apiBackend": "responses"
        }]});
        record_relay_models_to(&path, &v, "gw1");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"api_backend\": \"responses\""));
        let loaded = parse_caps_map(&raw);
        let c = match_in(&loaded, "gw1|custom-model-x", KeyMatch::Exact).unwrap();
        assert!(
            c.thinking == Some(true)
                && c.vision == Some(true)
                && c.context == Some(99999)
                && c.api_backend.as_deref() == Some("responses")
        );
        // 再记一条别的模型：合并不覆盖
        let v2 = serde_json::json!({"data": [{"id": "other", "context_length": 1000}]});
        record_relay_models_to(&path, &v2, "gw1");
        let loaded = parse_caps_map(&std::fs::read_to_string(&path).unwrap());
        assert_eq!(loaded.len(), 2);
        // 纯 id 列表不动缓存
        let before = std::fs::read_to_string(&path).unwrap();
        record_relay_models_to(
            &path,
            &serde_json::json!({"data": [{"id": "no-meta"}]}),
            "gw1",
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn model_key_unifies_dots_variants_and_provider() {
        assert_eq!(model_key("anthropic/claude-opus-5.5"), "claude-opus-5-5");
        assert_eq!(model_key("claude-opus-5.5:batch"), "claude-opus-5-5");
        assert_eq!(model_key("Claude-Opus-5-5"), "claude-opus-5-5");
        assert_eq!(snapshot_base("claude-opus-4-1-20250805"), "claude-opus-4-1");
        assert_eq!(snapshot_base("gpt-4o-2024-08-06"), "gpt-4o");
        assert_eq!(snapshot_base("deepseek-v4-flash-latest"), "deepseek-v4-flash");
        // 四位数是版本号不是快照
        assert_eq!(snapshot_base("qwen3-235b-a22b-2507"), "qwen3-235b-a22b-2507");
    }

    #[test]
    fn exact_layers_do_not_fall_back_to_another_model() {
        // 2026-10-28 实例：公共库写 claude-opus-5.5，Claude Code 报 claude-opus-5-5；
        // 不统一写法时按前缀退到 claude-opus-5（上一代）
        let db = keyed(vec![
            ("claude-opus-5".to_string(), caps(true, Some(1))),
            ("claude-opus-5.5".to_string(), caps(true, Some(2))),
            ("glm-4".to_string(), caps(false, Some(3))),
        ]);
        assert_eq!(match_in(&db, &model_key("claude-opus-5-5"), KeyMatch::Exact).and_then(|c| c.context), Some(2));
        assert_eq!(
            match_in(&db, &model_key("claude-opus-5-5-20261001"), KeyMatch::Exact).and_then(|c| c.context),
            Some(2)
        );
        // 库里没有这个型号：完整名层不拿别的型号顶
        assert!(match_in(&db, &model_key("glm-4.7-flash"), KeyMatch::Exact).is_none());
        // 前缀层照旧按系列
        assert_eq!(match_in(&db, &model_key("glm-4.7-flash"), KeyMatch::Prefix).and_then(|c| c.context), Some(3));
    }

    #[test]
    fn models_dev_prefers_vendor_and_skips_variants() {
        let v = serde_json::json!({
            "github-copilot": {"models": {"claude-opus-5.5": {"limit": {"context": 128000}}}},
            "anthropic": {"models": {
                "claude-opus-5-5": {"limit": {"context": 1000000}, "cost": {"input": 4, "output": 20}},
                "claude-opus-5-5:batch": {"limit": {"context": 1}, "cost": {"input": 2, "output": 10}}
            }},
        });
        let caps = parse_models_dev(&v);
        assert_eq!(caps.len(), 1);
        assert_eq!(caps[0].0, "claude-opus-5-5");
        assert_eq!(caps[0].1.context, Some(1_000_000));
        assert_eq!(parse_models_dev_prices(&v), vec![("claude-opus-5-5".to_string(), (4.0, 20.0))]);
    }

    #[test]
    fn forget_relay_models_drops_delisted_for_that_gateway_only() {
        let dir = std::env::temp_dir().join(format!("ccode-mr-{}", uuid::Uuid::new_v4()));
        let path = dir.join("relay.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &path,
            r#"{"gw1|old-model":{"context":1},"gw1|keep":{"context":2},"gw2|old-model":{"context":3}}"#,
        )
        .unwrap();
        forget_relay_models_at(&path, "gw1", &["relay/old-model".to_string()]);
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["gw1|keep", "gw2|old-model"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn builtin_covers_claude_5_family() {
        assert!(model_thinking("claude-opus-5-5"));
        assert!(model_thinking("claude-fable-5-1"));
        assert!(model_supports_vision("claude-sonnet-5-5"));
        assert!(model_thinking("deepseek-v4.1-flash"));
    }

    #[test]
    fn litellm_prefers_native_vendor_and_skips_non_chat() {
        let v = serde_json::json!({
            "sample_spec": {"mode": "chat", "max_input_tokens": 1},
            "openrouter/anthropic/claude-opus-5.5": {"mode": "chat", "litellm_provider": "openrouter", "max_input_tokens": 200000,
                "input_cost_per_token": 0.00001, "output_cost_per_token": 0.00005},
            "claude-opus-5-5": {"mode": "chat", "litellm_provider": "anthropic", "max_input_tokens": 1000000, "max_output_tokens": 128000,
                "supports_vision": true, "supports_reasoning": true, "input_cost_per_token": 0.000004, "output_cost_per_token": 0.00002},
            "gpt-image-2": {"mode": "image_generation", "litellm_provider": "openai"}
        });
        let (caps, prices) = parse_litellm(&v);
        assert_eq!(caps.len(), 1);
        assert_eq!(caps[0].1.context, Some(1_000_000));
        assert_eq!(caps[0].1.thinking, Some(true));
        assert_eq!(prices.len(), 1);
        assert!((prices[0].1 .0 - 4.0).abs() < 1e-9 && (prices[0].1 .1 - 20.0).abs() < 1e-9);
    }

    #[test]
    fn db_json_roundtrips_and_skips_meta() {
        let caps = vec![("m-1".to_string(), caps(true, Some(5)))];
        let prices = vec![("m-1".to_string(), (1.0, 2.0)), ("m-2".to_string(), (3.0, 4.0))];
        let text = db_json(&caps, &prices, &["models.dev"]).unwrap();
        let back = parse_caps_map(&text);
        assert_eq!(back.len(), 2); // m-2 只有价格也留着
        assert!(back.iter().all(|(k, _)| !k.starts_with('_')));
        assert_eq!(parse_price_map(&text).len(), 2);
        let mut a = vec![("x".to_string(), 1)];
        merge_tables(&mut a, vec![("x".to_string(), 2), ("y".to_string(), 3)]);
        assert_eq!(a, vec![("x".to_string(), 1), ("y".to_string(), 3)]);
    }

    #[test]
    fn bundled_snapshot_parses() {
        let v: serde_json::Value = serde_json::from_str(BUNDLED_DB).expect("随包快照不是合法 JSON");
        assert!(v.is_object());
    }

    /// 发版前刷新随包快照：npm run gen:model-db（= cargo test --lib gen_model_db_snapshot -- --ignored --nocapture）。
    /// 走同一套下载合并逻辑，连不上 models.dev 时设 HTTPS_PROXY
    #[test]
    #[ignore]
    fn gen_model_db_snapshot() {
        let (caps, prices, used) = tauri::async_runtime::block_on(fetch_db()).expect("下载失败");
        let text = db_json(&caps, &prices, &used).unwrap();
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("data").join("model-db-snapshot.json");
        std::fs::write(&path, text).unwrap();
        println!("{} 个型号、{} 个带价（{}）→ {}", caps.len(), prices.len(), used.join(" + "), path.display());
    }

    #[test]
    fn context_size_chain() {
        assert_eq!(model_context_size("kimi-k3"), 1_048_576);
        assert_eq!(model_context_size("kimi-k2.7"), 262_144);
        // 表内 thinking 条目 context=None → 保守默认
        assert_eq!(model_context_size("gpt-5"), 131_072);
        // 表外模型 → fallback 映射
        assert_eq!(model_context_size("unknown-model"), 131_072);
    }
}
