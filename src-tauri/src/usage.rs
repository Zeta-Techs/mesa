//! 用量与费用统计（§6.11）：各 agent 的会话 usage 按天聚合进 app.db，
//! 定价链（用户 pricing.json > 公共能力库 cost > 内置表，高层任意前缀命中即胜、
//! 同层最长前缀优先）估算 USD 费用；价格不明的只显示 token。

use chrono::{DateTime, Days, Local, NaiveDate, TimeZone};
use rusqlite::{params, Connection};
use tauri::Emitter;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

const LIST_CAP: usize = 20;
// v5：usage_daily 增加 workspace 列（工作区成本归因）。扫描时 worktree 会话的项目路径
// 已被改写成真实仓库路径，工作区归属信息无法仅靠既有索引在查询时反推，必须建索引时落库，
// 因此升版本并自动重建旧索引。
// v6：usage_daily 与 usage_provenance 增加 official 列（官方账号「订阅」口径）。
// 建索引时按 provenance 落库，查询期不再反推，升版本自动重建旧索引；
// provenance 表不在重置范围内，单独走 ALTER 补列。
// v7：usage_provenance 增加 session_id 列（主键变为 agent+project_path+session_id）——
// 官方账号登记从项目级改为会话级，旧项目级行只回填登记时刻已存在的会话（不再粘住新会话）；
// 会话级 internal 标记（session_meta.internal，无头 AI / 定时巡检按会话 id 登记）纳入用量索引。
// SQLite 不能 ALTER 主键，provenance 整表重建迁移、旧行保留；升版本自动重建用量索引。
// v8：Grok 回合用量改认 params.update.usage（camelCase）。v7 索引按猜的 _meta.usage
// 提取，Grok 行为空；只清 Grok 的日行和 seen 标记，其它 agent 的已建索引留着。
// v9（2026-10-22）：Codex / Gemini / Qwen 的输入数含缓存读（Codex 的输出还含推理），原先原样入库——缓存在费用里
// 按全价再加一折、合计里算两遍，Codex 推理算两遍。改为入库时拆成没命中的输入（uncached_input）；
// 只清这三家能从会话文件重抽的行（有 seen 标记）和它们的 seen 标记，其余 agent 与重抽不回来的行不动。
// v10（2026-10-31）：Claude Code 同一次回复拆成几行、每行带整份 usage，原先逐行相加，用量约翻倍；改为按 message.id 合一。
// 只清 Claude Code 能从会话文件重抽的行和它的 seen 标记；文件已被 CLI 清掉的旧行重抽不回来，保持原数。
// v13（2026-11-13）：Kimi 2.6 不再写 llm.request，Mesa 开的会话用量记成合成别名；改按启动记下的模型换。只清 Kimi 能重抽的行
const USAGE_SCHEMA_VERSION: &str = "13";
const SOURCE_CLI: &str = "cli";
const SOURCE_CCODE_AI: &str = "ccode-ai";
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

// ===== 事件提取（每个 agent 一个小提取器，只拿 时间/模型/usage） =====

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct UsageEvent {
    pub day: String,   // 本机时区日期
    pub model: String, // 未知为 ""
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// cache_write 里按 1 小时缓存写入的部分（只有 Claude 记：usage.cache_creation.ephemeral_1h_input_tokens）。
    /// 官方价是输入价 2 倍，5 分钟缓存是 1.25 倍。本机实测（2026-11-07，711 份会话）绝大多数是 5 分钟，1 小时约占 3%，
    /// 但两档差价大，混着按一个价算会偏
    pub cache_write_1h: u64,
    /// 事件来源由后端运行来源登记决定，不由路径或模型名猜测。
    pub source: String,
    pub internal: bool,
    /// 官方账号（订阅制）用量：同样由 provenance 登记决定，不由事件本身猜测
    pub official: bool,
}

/// 输入里拆掉缓存，只留「没命中缓存的输入」（2026-10-22）。Codex（OpenAI 口径）、Gemini / Qwen（Gemini API 口径）、
/// Grok camelCase 的输入数都已经含缓存读（实机：Codex total_tokens = input + output，Qwen totalTokenCount =
/// prompt + candidates）；不拆的话缓存在费用里按输入全价再加一折、在用量合计里算两遍。Claude / Kimi 的输入本就不含缓存，
/// 不走这里。缓存比输入还大（字段口径对不上）就原样返回，不拆成 0
pub(crate) fn uncached_input(input: u64, cache_read: u64, cache_write: u64) -> u64 {
    let cached = cache_read.saturating_add(cache_write);
    if input >= cached {
        input - cached
    } else {
        input
    }
}

fn get_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

fn day_of_iso(ts: &str) -> String {
    DateTime::parse_from_rfc3339(ts)
        .map(|dt| dt.with_timezone(&Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| ts.chars().take(10).collect())
}

fn day_of_ms(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// `own`：本文件自己的会话 id。Claude 接续文件开头复制了上游全部历史（行里 sessionId 是上游的），
/// 那些用量已经记在上游文件名下，再算一遍就翻倍。
/// 同一次回复按内容块（思考 / 文字 / 工具调用）拆成几行，每行都带这次回复的整份 usage（2026-10-31 实测
/// 本机近三天约 4,900 组几乎全部逐字相同，偶有一行全 0 占位）：按 message.id 合成一次、逐项取大，否则拆几行算几遍
fn claude_events<I, S>(lines: I, own: Option<&str>) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out: Vec<UsageEvent> = Vec::new();
    let mut by_msg: HashMap<String, usize> = HashMap::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        if get_str(&v, "type") != Some("assistant")
            || v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true)
        {
            continue;
        }
        if let (Some(own), Some(sid)) = (own, get_str(&v, "sessionId")) {
            if sid != own {
                continue;
            }
        }
        let Some(msg) = v.get("message") else {
            continue;
        };
        let Some(u) = msg.get("usage") else {
            continue;
        };
        let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        let ev = UsageEvent {
            day: get_str(&v, "timestamp").map(day_of_iso).unwrap_or_default(),
            model: get_str(msg, "model").unwrap_or("").to_string(),
            input: num("input_tokens"),
            output: num("output_tokens"),
            cache_read: num("cache_read_input_tokens"),
            cache_write: num("cache_creation_input_tokens"),
            cache_write_1h: u
                .get("cache_creation")
                .and_then(|c| c.get("ephemeral_1h_input_tokens"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0),
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        };
        let id = get_str(msg, "id").filter(|id| !id.is_empty());
        if let Some(&at) = id.and_then(|id| by_msg.get(id)) {
            let prev = &mut out[at];
            prev.input = prev.input.max(ev.input);
            prev.output = prev.output.max(ev.output);
            prev.cache_read = prev.cache_read.max(ev.cache_read);
            prev.cache_write = prev.cache_write.max(ev.cache_write);
            prev.cache_write_1h = prev.cache_write_1h.max(ev.cache_write_1h);
            continue;
        }
        if let Some(id) = id {
            by_msg.insert(id.to_string(), out.len());
        }
        out.push(ev);
    }
    out
}

fn codex_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    let mut model = String::new(); // turn_context 的 model，取最后出现的（每轮会刷新）
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        match get_str(&v, "type") {
            Some("turn_context") => {
                if let Some(m) = v.get("payload").and_then(|p| get_str(p, "model")) {
                    model = m.to_string();
                }
            }
            Some("event_msg") => {
                let Some(p) = v.get("payload") else {
                    continue;
                };
                if get_str(p, "type") != Some("token_count") {
                    continue;
                }
                // last_token_usage 是本轮增量（total 是累计，按天聚合必须用增量）
                let Some(t) = p.get("info").and_then(|i| i.get("last_token_usage")) else {
                    continue;
                };
                let num = |k: &str| t.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                out.push(UsageEvent {
                    day: get_str(&v, "timestamp").map(day_of_iso).unwrap_or_default(),
                    model: model.clone(),
                    // input_tokens 含 cached_input_tokens、output_tokens 含 reasoning_output_tokens
                    // （实机 total_tokens = input + output）：拆缓存、推理不另加
                    input: uncached_input(num("input_tokens"), num("cached_input_tokens"), 0),
                    output: num("output_tokens"),
                    cache_read: num("cached_input_tokens"),
                    cache_write: num("cache_write_input_tokens"),
                    cache_write_1h: 0,
                    source: SOURCE_CLI.into(),
                    internal: false,
                    official: false,
                });
            }
            _ => {}
        }
    }
    out
}

fn gemini_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        if get_str(&v, "type") != Some("gemini") {
            continue;
        }
        let Some(t) = v.get("tokens") else {
            continue;
        };
        let num = |k: &str| t.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        out.push(UsageEvent {
            day: get_str(&v, "timestamp").map(day_of_iso).unwrap_or_default(),
            model: get_str(&v, "model").unwrap_or("").to_string(),
            // input 是 promptTokenCount，含缓存读（Gemini API 口径）；thoughts 不在 output 里，另加
            input: uncached_input(num("input"), num("cached"), 0),
            output: num("output") + num("thoughts"),
            cache_read: num("cached"),
            cache_write: 0,
            cache_write_1h: 0,
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        });
    }
    out
}

fn qwen_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        let Some(u) = v.get("usageMetadata") else {
            continue;
        };
        let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        out.push(UsageEvent {
            day: get_str(&v, "timestamp").map(day_of_iso).unwrap_or_default(),
            model: get_str(&v, "model").unwrap_or("").to_string(),
            // promptTokenCount 含 cachedContentTokenCount（实机 totalTokenCount = prompt + candidates）
            input: uncached_input(num("promptTokenCount"), num("cachedContentTokenCount"), 0),
            output: num("candidatesTokenCount"),
            cache_read: num("cachedContentTokenCount"),
            cache_write: 0,
            cache_write_1h: 0,
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        });
    }
    out
}

fn kimi_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    // usage.record 记的是 config.toml 里的模型别名（Mesa 启动合成的 `__kimi_env_model__`、`zetatechs/kimi-k3`），
    // 同一份文件的 llm.request 行带着 modelAlias → model 真名；不换回来，用量里就是一个查不到价的占位名（2026-11-07）。
    // Kimi 2.6 起文件里不再写 llm.request，合成别名由建索引时按启动记下的模型换（kimi_launch_models，2026-11-13）
    let mut alias_to_model: HashMap<String, String> = HashMap::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        if get_str(&v, "type") == Some("llm.request") {
            if let (Some(alias), Some(model)) = (get_str(&v, "modelAlias"), get_str(&v, "model")) {
                if !alias.is_empty() && !model.is_empty() {
                    alias_to_model.insert(alias.to_string(), model.to_string());
                }
            }
            continue;
        }
        if get_str(&v, "type") != Some("usage.record") {
            continue;
        }
        let Some(u) = v.get("usage") else {
            continue;
        };
        let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        let alias = get_str(&v, "model").unwrap_or("");
        out.push(UsageEvent {
            day: v
                .get("time")
                .and_then(|t| t.as_i64())
                .map(day_of_ms)
                .unwrap_or_default(),
            model: alias_to_model.get(alias).map_or(alias, String::as_str).to_string(),
            input: num("inputOther"),
            output: num("output"),
            cache_read: num("inputCacheRead"),
            cache_write: num("inputCacheCreation"),
            cache_write_1h: 0,
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        });
    }
    out
}

/// CodeBuddy：usage/工具调用字段未实证（实测样本是 401 会话，无 usage 行），
/// 按 Anthropic 兼容字段名尽力而为；无 usage 字段的行不产生事件（不报错）。
/// TODO: 拿到真账号样本后补全实际字段名。
fn codebuddy_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        if get_str(&v, "type") != Some("message") || get_str(&v, "role") != Some("assistant") {
            continue;
        }
        let Some(u) = v.get("usage") else {
            continue;
        };
        let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        // timestamp 是毫秒 epoch 数字（容错 ISO 字符串）
        let day = match v.get("timestamp") {
            Some(Value::Number(n)) => n.as_i64().map(day_of_ms).unwrap_or_default(),
            Some(Value::String(s)) => day_of_iso(s),
            _ => String::new(),
        };
        out.push(UsageEvent {
            day,
            model: get_str(&v, "model").unwrap_or("").to_string(),
            input: num("input_tokens"),
            output: num("output_tokens"),
            cache_read: num("cache_read_input_tokens"),
            cache_write: num("cache_creation_input_tokens"),
            cache_write_1h: 0,
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        });
    }
    out
}

/// Cursor：usage 字段未实证（调研无真账号样本，2026.08.04-aaa8809），
/// 按常见字段名候选尽力而为；无 usage 字段的行不产生事件（不报错）。
/// TODO: 拿到真账号样本后补全实际字段名。
fn cursor_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        let Some(u) = v.get("usage") else {
            continue;
        };
        // 字段名候选：snake_case / camelCase / OpenAI 风格
        let nums = |keys: &[&str]| {
            keys.iter()
                .find_map(|k| u.get(k).and_then(|x| x.as_u64()))
                .unwrap_or(0)
        };
        // 时间戳字段名未实证，多候选；数字按量级区分毫秒/秒 epoch，字符串当 ISO
        let day = ["timestamp", "time", "created_at", "createdAt", "ts"]
            .iter()
            .find_map(|k| match v.get(k) {
                Some(Value::Number(n)) => n.as_i64().map(|raw| {
                    if raw.abs() >= 1_000_000_000_000 {
                        day_of_ms(raw)
                    } else {
                        day_of_ms(raw * 1000)
                    }
                }),
                Some(Value::String(s)) => Some(day_of_iso(s)),
                _ => None,
            })
            .unwrap_or_default();
        out.push(UsageEvent {
            day,
            model: get_str(&v, "model").unwrap_or("").to_string(),
            input: nums(&["input_tokens", "inputTokens", "prompt_tokens"]),
            output: nums(&["output_tokens", "outputTokens", "completion_tokens"]),
            cache_read: nums(&["cache_read_input_tokens", "cacheReadInputTokens"]),
            cache_write: nums(&["cache_creation_input_tokens", "cacheCreationInputTokens"]),
            cache_write_1h: 0,
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        });
    }
    out
}

fn usage_u64(u: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|k| u.get(*k).and_then(|x| x.as_u64()))
        .unwrap_or(0)
}

/// 实机（2026-09-22）回合用量在 `params.update.usage`。
/// 早期按文档猜的 `_meta.usage`（`params._meta` 或 `params.update._meta`）仍认。
fn grok_usage_value(params: &Value) -> Option<&Value> {
    let update = params.get("update");
    update
        .and_then(|u| u.get("usage"))
        .filter(|u| u.is_object())
        .or_else(|| {
            update
                .and_then(|u| u.get("_meta"))
                .and_then(|m| m.get("usage"))
                .filter(|u| u.is_object())
        })
        .or_else(|| {
            params
                .get("_meta")
                .and_then(|m| m.get("usage"))
                .filter(|u| u.is_object())
        })
}

fn grok_usage_has_own_tokens(u: &Value) -> bool {
    u.get("inputTokens").is_some()
        || u.get("input_tokens").is_some()
        || u.get("outputTokens").is_some()
        || u.get("output_tokens").is_some()
}

/// 多模型各记各的。条目不带 token（旧夹具空对象）时，整笔归到第一个模型名。
fn grok_usage_parts(u: &Value) -> Vec<(String, &Value)> {
    let Some(map) = u.get("modelUsage").and_then(|m| m.as_object()) else {
        return vec![(String::new(), u)];
    };
    if map.is_empty() || !map.values().any(grok_usage_has_own_tokens) {
        let model = map.keys().next().cloned().unwrap_or_default();
        return vec![(model, u)];
    }
    map.iter()
        .filter(|(_, part)| grok_usage_has_own_tokens(part))
        .map(|(model, part)| (model.clone(), part))
        .collect()
}

fn grok_event_from_usage(day: String, model: String, u: &Value) -> Option<UsageEvent> {
    let raw_input = usage_u64(u, &["input_tokens", "inputTokens"]);
    let output = usage_u64(u, &["output_tokens", "outputTokens"]);
    let cache_read = usage_u64(u, &["cached_read_tokens", "cachedReadTokens"]);
    let cache_write = usage_u64(
        u,
        &[
            "cache_creation_input_tokens",
            "cacheCreationTokens",
            "cache_creation_tokens",
        ],
    );
    // camelCase 实机：inputTokens 已含缓存读（cache 从不大于 input，total = input + output）。
    // 拆成未命中输入再入库，否则缓存会按输入全价再加一折。reasoningTokens 不另加：
    // 它不是 total 之外的第三项，有时还大于 outputTokens。
    // snake_case 旧夹具把 input_tokens 与 cached_read_tokens 当独立字段，不拆。
    let input = if u.get("inputTokens").is_some() {
        uncached_input(raw_input, cache_read, cache_write)
    } else {
        raw_input
    };
    if input + output + cache_read + cache_write == 0 {
        return None;
    }
    Some(UsageEvent {
        day,
        model,
        input,
        output,
        cache_read,
        cache_write,
        cache_write_1h: 0,
        source: SOURCE_CLI.into(),
        internal: false,
        official: false,
    })
}

/// Grok Build：token usage 在 turn 结束通知里。无 usage 对象的行不产生事件（不报错）。
fn grok_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        let Some(params) = v.get("params") else {
            continue;
        };
        let Some(u) = grok_usage_value(params) else {
            continue;
        };
        // 时间戳是 unix 秒数字（容错 ISO 字符串）
        let day = match v.get("timestamp") {
            Some(Value::Number(n)) => n.as_i64().map(|s| day_of_ms(s * 1000)).unwrap_or_default(),
            Some(Value::String(s)) => day_of_iso(s),
            _ => String::new(),
        };
        for (model, part) in grok_usage_parts(u) {
            if let Some(event) = grok_event_from_usage(day.clone(), model, part) {
                out.push(event);
            }
        }
    }
    out
}

fn opencode_events(db_path: &Path, session_id: &str) -> Vec<UsageEvent> {
    let Some(conn) = crate::sessions::open_opencode_db(db_path) else {
        return Vec::new();
    };
    // 逐行流式消费：message.data 可能很大，整会话一次性入内存在长会话下峰值过高。
    // 列级防御沿用 SELECT * + 按列名取索引（drizzle 迁移频繁，缺列给默认而不是报错）。
    // 2.x 的会话在 session_message：用量在 assistant 行与压缩行的 data.tokens，模型在 data.model.id
    let v2 = crate::sessions::opencode_store_of(&conn, session_id) == crate::sessions::OpencodeStore::V2;
    let sql = if v2 {
        "SELECT * FROM session_message WHERE session_id=? AND type IN ('assistant','compaction') ORDER BY seq ASC"
    } else {
        "SELECT * FROM message WHERE session_id=? ORDER BY time_created ASC"
    };
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let Some(data_idx) = names.iter().position(|n| n == "data") else {
        return Vec::new();
    };
    let time_idx = names.iter().position(|n| n == "time_created");
    let Ok(mut rows) = stmt.query(rusqlite::params![session_id]) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    while let Ok(Some(row)) = rows.next() {
        let data = row.get::<_, String>(data_idx).unwrap_or_default();
        // 与旧 DbRow::as_i64 同口径：Integer 直取，Real 截断，其余视为缺失
        let time_created = time_idx.and_then(|i| {
            row.get::<_, rusqlite::types::Value>(i)
                .ok()
                .and_then(|v| match v {
                    rusqlite::types::Value::Integer(n) => Some(n),
                    rusqlite::types::Value::Real(f) => Some(f as i64),
                    _ => None,
                })
        });
        let Ok(v) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if !v2 && get_str(&v, "role") != Some("assistant") {
            continue;
        }
        let Some(t) = v.get("tokens") else {
            continue;
        };
        let num = |k: &str| t.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
        let cache = t.get("cache");
        let cnum = |k: &str| {
            cache
                .and_then(|c| c.get(k))
                .and_then(|x| x.as_i64())
                .unwrap_or(0)
        };
        // modelID 为主；model 也可能是 {providerID,modelID} 对象，2.x 是 {id,providerID}
        let model = get_str(&v, "modelID")
            .map(String::from)
            .or_else(|| {
                v.get("model")
                    .and_then(|m| get_str(m, "modelID").or_else(|| get_str(m, "id")))
                    .map(String::from)
            })
            .unwrap_or_default();
        out.push(UsageEvent {
            day: time_created.map(day_of_ms).unwrap_or_default(),
            model,
            input: num("input") as u64,
            output: (num("output") + num("reasoning")) as u64,
            cache_read: cnum("read") as u64,
            cache_write: cnum("write") as u64,
            cache_write_1h: 0,
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        });
    }
    out
}

fn usage_line_reader(path: &Path) -> Option<Box<dyn BufRead>> {
    let mut file = File::open(path).ok()?;
    let mut magic = [0u8; 4];
    let read = file.read(&mut magic).ok()?;
    file.seek(SeekFrom::Start(0)).ok()?;
    if read == magic.len() && magic == ZSTD_MAGIC {
        let decoder = zstd::stream::read::Decoder::new(file).ok()?;
        Some(Box::new(BufReader::new(decoder)))
    } else {
        Some(Box::new(BufReader::new(file)))
    }
}

fn extract_file_events(agent: &str, path: &Path, session_id: Option<&str>) -> Vec<UsageEvent> {
    let Some(reader) = usage_line_reader(path) else {
        return Vec::new();
    };
    // JSONL 逐行解析，峰值内存由单条记录而非整个会话大小决定；压缩会话也边解码边消费。
    let lines = reader
        .split(b'\n')
        .map_while(Result::ok)
        .map(|line| String::from_utf8_lossy(&line).into_owned());
    events_from_lines(agent, lines, session_id)
}

fn events_from_lines<I, S>(agent: &str, lines: I, session_id: Option<&str>) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    match agent {
        "codex" => codex_events(lines),
        "gemini" => gemini_events(lines),
        "qwen" => qwen_events(lines),
        "kimi" => kimi_events(lines),
        "codebuddy" => codebuddy_events(lines),
        "cursor" => cursor_events(lines),
        "grok" => grok_events(lines),
        _ => claude_events(lines, session_id),
    }
}

/// 尾窗起步大小；之后每轮翻倍，读到文件头就等于整份
const TAIL_WINDOW_START: u64 = 512 * 1024;

/// 从文件尾往前按窗口找最后一次出现的东西（2026-10-24 侧栏切对话卡顿：几十 MB 的 Claude 会话整份解析要几百毫秒，
/// 点开对话要先等它才出标签）。窗口首行多半是半截，丢掉；`pick` 在当前窗口里找不到就翻倍再找。
/// 返回 None 表示没法倒着读（zstd 压缩、打不开），调用方走整份流式；Some(None) 是整份都找过了也没有
fn find_in_tail<T>(path: &Path, mut pick: impl FnMut(&[String]) -> Option<T>) -> Option<Option<T>> {
    let mut file = File::open(path).ok()?;
    let mut magic = [0u8; 4];
    if file.read(&mut magic).ok()? == magic.len() && magic == ZSTD_MAGIC {
        return None;
    }
    let len = file.metadata().ok()?.len();
    let mut step = TAIL_WINDOW_START;
    loop {
        let start = len.saturating_sub(step);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = Vec::with_capacity((len - start) as usize);
        file.by_ref().take(len - start).read_to_end(&mut buf).ok()?;
        let body = if start == 0 {
            &buf[..]
        } else {
            match buf.iter().position(|&b| b == b'\n') {
                Some(at) => &buf[at + 1..],
                None => &[][..],
            }
        };
        let lines: Vec<String> = body
            .split(|&b| b == b'\n')
            .filter(|l| !l.is_empty())
            .map(|l| String::from_utf8_lossy(l).into_owned())
            .collect();
        if let Some(found) = pick(&lines) {
            return Some(Some(found));
        }
        if start == 0 {
            return Some(None);
        }
        step = step.saturating_mul(2);
    }
}

fn last_model_of(events: Vec<UsageEvent>) -> Option<String> {
    events
        .into_iter()
        .rev()
        .map(|e| e.model)
        .find(|m| !m.is_empty() && m != "<synthetic>")
}

/// 会话 → usage 事件流；普通 JSONL 与 zstd 会话均流式读取。
fn extract_events(session: &crate::sessions::SessionMetaDto) -> Vec<UsageEvent> {
    if session.agent == "opencode" {
        let Some((db, sid)) = session.file_path.split_once('#') else {
            return Vec::new();
        };
        return opencode_events(Path::new(db), sid);
    }
    let path = Path::new(&session.file_path);
    extract_file_events(&session.agent, path, Some(&session.session_id))
}

/// 这段对话最后一轮实际用的模型（接着聊时输入框默认选它，2026-10-24 用户：点开一段对话，底部应是它之前用的配置）。
/// 复用用量提取器：各家把模型名记在哪不一样，提取器已经各认各的；读不到为 None。
/// `<synthetic>` 是 Claude 自己补的占位消息（中断、出错），不是模型
pub(crate) fn last_session_model(agent: &str, file_path: &str, session_id: &str) -> Option<String> {
    if agent == "opencode" {
        let (db, sid) = file_path.split_once('#')?;
        return last_model_of(opencode_events(Path::new(db), sid));
    }
    let path = Path::new(file_path);
    // 先倒着读尾窗：最后一轮的模型就在文件末尾附近（单个 JSON 文档的家尾窗解析不出，会一路翻倍到整份）
    if let Some(found) = find_in_tail(path, |lines| {
        last_model_of(events_from_lines(agent, lines, Some(session_id)))
    }) {
        return found;
    }
    last_model_of(extract_file_events(agent, path, Some(session_id)))
}

/// 一行 Codex rollout 若是 turn_context，取出它 payload 里的某个字段（effort / model）
fn codex_turn_field(text: &str, key: &str) -> Option<String> {
    if !text.contains("\"turn_context\"") {
        return None;
    }
    let v = serde_json::from_str::<Value>(text).ok()?;
    if get_str(&v, "type") != Some("turn_context") {
        return None;
    }
    let e = v.get("payload").and_then(|p| get_str(p, key))?;
    (!e.is_empty()).then(|| e.to_string())
}

/// Codex 会话最后一个 turn_context 的某字段：先读尾窗，没有再整份顺读
fn last_codex_turn_field(file_path: &str, key: &str) -> Option<String> {
    let path = Path::new(file_path);
    if let Some(found) = find_in_tail(path, |lines| {
        lines.iter().rev().find_map(|l| codex_turn_field(l, key))
    }) {
        return found;
    }
    let reader = usage_line_reader(path)?;
    let mut value = None;
    for line in reader.split(b'\n').map_while(Result::ok) {
        if let Some(e) = codex_turn_field(&String::from_utf8_lossy(&line), key) {
            value = Some(e);
        }
    }
    value
}

/// Codex 会话最后一轮的思考档（rollout 的 turn_context 每轮都记 effort）；别家会话文件不记，返回 None
pub(crate) fn last_codex_effort(file_path: &str) -> Option<String> {
    last_codex_turn_field(file_path, "effort")
}

/// Codex 会话最后一轮发请求用的模型（turn_context 记的）：一轮都没跑完、没有用量记录的对话也读得到
pub(crate) fn last_codex_turn_model(file_path: &str) -> Option<String> {
    last_codex_turn_field(file_path, "model")
}

// ===== 聚合 =====

#[derive(Debug, Clone)]
pub(crate) struct SessionContrib {
    pub agent: String,
    pub session_id: String,
    pub project_path: String,
    /// 会话发生在任务工作区时的工作区名（扫描已识别）；非工作区会话为空串
    pub workspace: String,
    pub events: Vec<UsageEvent>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DailyRow {
    pub day: String,
    pub agent: String,
    pub model: String,
    pub project_path: String,
    pub session_id: String,
    pub workspace: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cache_write_1h: u64,
    pub source: String,
    pub internal: bool,
    /// 官方账号（订阅制）用量：不按量计费，统计页费用栏显示「订阅」
    pub official: bool,
}

/// 按 (day, agent, model, project, session, workspace, source, internal, official) 聚合；无 usage 事件的会话不产生行
pub(crate) fn aggregate(contribs: &[SessionContrib]) -> Vec<DailyRow> {
    #[allow(clippy::type_complexity)]
    let mut map: HashMap<
        (
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            bool,
            bool,
        ),
        DailyRow,
    > = HashMap::new();
    for c in contribs {
        for e in &c.events {
            if e.day.is_empty() {
                continue; // 时间戳缺失的事件无法归入任何日桶，直接丢弃而不是产出 day="" 噪声行
            }
            let key = (
                e.day.clone(),
                c.agent.clone(),
                e.model.clone(),
                c.project_path.clone(),
                c.session_id.clone(),
                c.workspace.clone(),
                e.source.clone(),
                e.internal,
                e.official,
            );
            let row = map.entry(key.clone()).or_insert_with(|| DailyRow {
                day: key.0,
                agent: key.1,
                model: key.2,
                project_path: key.3,
                session_id: key.4,
                workspace: key.5,
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
                cache_write_1h: 0,
                source: key.6,
                internal: key.7,
                official: key.8,
            });
            row.input += e.input;
            row.output += e.output;
            row.cache_read += e.cache_read;
            row.cache_write += e.cache_write;
            row.cache_write_1h += e.cache_write_1h;
        }
    }
    map.into_values().collect()
}

// ===== app.db =====

fn usage_db() -> Result<Connection, String> {
    let conn = crate::sessions::open_db()?;
    ensure_usage_schema(&conn)?;
    Ok(conn)
}

fn usage_columns(conn: &Connection) -> Result<HashSet<String>, String> {
    table_columns(conn, "usage_daily")
}

fn table_columns(conn: &Connection, table: &str) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

fn ensure_usage_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_daily(
          day TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL,
          project_path TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
          input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
          cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
          cache_write_1h INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'cli', internal INTEGER NOT NULL DEFAULT 0,
          workspace TEXT NOT NULL DEFAULT '', official INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(day, agent, model, project_path, session_id));
         CREATE TABLE IF NOT EXISTS usage_meta(key TEXT PRIMARY KEY, value TEXT);
         CREATE TABLE IF NOT EXISTS usage_provenance(
           agent TEXT NOT NULL, project_path TEXT NOT NULL,
           session_id TEXT NOT NULL DEFAULT '',
           source TEXT NOT NULL, internal INTEGER NOT NULL DEFAULT 0,
           official INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL,
           PRIMARY KEY(agent, project_path, session_id));",
    )
    .map_err(|e| format!("初始化用量表失败: {e}"))?;
    let columns = usage_columns(conn)?;
    if !columns.contains("source") {
        conn.execute(
            "ALTER TABLE usage_daily ADD COLUMN source TEXT NOT NULL DEFAULT 'cli'",
            [],
        )
        .map_err(|e| format!("升级用量来源字段失败: {e}"))?;
    }
    if !columns.contains("internal") {
        conn.execute(
            "ALTER TABLE usage_daily ADD COLUMN internal INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("升级内部活动字段失败: {e}"))?;
    }
    if !columns.contains("workspace") {
        conn.execute(
            "ALTER TABLE usage_daily ADD COLUMN workspace TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|e| format!("升级工作区归因字段失败: {e}"))?;
    }
    if !columns.contains("official") {
        conn.execute(
            "ALTER TABLE usage_daily ADD COLUMN official INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("升级官方账号标记字段失败: {e}"))?;
    }
    if !columns.contains("cache_write_1h") {
        conn.execute(
            "ALTER TABLE usage_daily ADD COLUMN cache_write_1h INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("升级 1 小时缓存写字段失败: {e}"))?;
    }
    // provenance 表不在版本重置范围内（登记行要跨重建保留），单独补列
    let provenance_columns = table_columns(conn, "usage_provenance")?;
    if !provenance_columns.contains("official") {
        conn.execute(
            "ALTER TABLE usage_provenance ADD COLUMN official INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("升级来源登记官方账号字段失败: {e}"))?;
    }
    // v7：provenance 加 session_id 列、主键随之变化。SQLite 不能 ALTER 主键，整表重建；
    // 旧行 session_id 置 '' 保留（项目级旧登记，命中口径见 session_provenance），历史不丢
    if !provenance_columns.contains("session_id") {
        conn.execute_batch(
            "CREATE TABLE usage_provenance_v7(
               agent TEXT NOT NULL, project_path TEXT NOT NULL,
               session_id TEXT NOT NULL DEFAULT '',
               source TEXT NOT NULL, internal INTEGER NOT NULL DEFAULT 0,
               official INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL,
               PRIMARY KEY(agent, project_path, session_id));
             INSERT INTO usage_provenance_v7(agent, project_path, session_id, source, internal, official, created_at)
               SELECT agent, project_path, '', source, internal, official, created_at FROM usage_provenance;
             DROP TABLE usage_provenance;
             ALTER TABLE usage_provenance_v7 RENAME TO usage_provenance;",
        )
        .map_err(|e| format!("升级来源登记会话字段失败: {e}"))?;
    }
    let current: Option<String> = conn
        .query_row(
            "SELECT value FROM usage_meta WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .ok();
    if current.as_deref() != Some(USAGE_SCHEMA_VERSION) {
        // 旧索引没有可靠来源，清空后由会话源重新生成，避免把历史猜测伪装成权威分类。
        // v7→v8 只是 Grok 提取口径变了，v8→v9 只是 Codex / Gemini / Qwen 拆缓存，v9→v10 只是 Claude Code 按回复去重，v10→v11 只是 Kimi 模型别名换真名，v11→v12 只是 Claude Code 分出 1 小时缓存写，v12→v13 只是 Kimi 按启动模型换别名：只清这几家能从会话文件重抽的行
        // （有 seen 标记）和它们的 seen 标记，其它 agent 已建好的日行留着，避免整库重解析；文件已不在的行重抽不回来，
        // 留着（用量历史永久保留）
        let partial: Option<&[&str]> = match current.as_deref() {
            Some("12") => Some(&["kimi"]),
            Some("11") => Some(&["claude-code", "kimi"]),
            Some("10") => Some(&["claude-code", "kimi"]),
            Some("9") => Some(&["claude-code", "kimi"]),
            Some("8") => Some(&["claude-code", "codex", "gemini", "qwen", "kimi"]),
            Some("7") => Some(&["claude-code", "grok", "codex", "gemini", "qwen", "kimi"]),
            _ => None,
        };
        let reset_sql = match partial {
            Some(agents) => {
                let list = agents.iter().map(|a| format!("'{a}'")).collect::<Vec<_>>().join(",");
                let seen = agents
                    .iter()
                    .map(|a| format!("key LIKE 'seen:{a}:%'"))
                    .collect::<Vec<_>>()
                    .join(" OR ");
                format!(
                    "DELETE FROM usage_daily WHERE agent IN ({list}) AND EXISTS (
                       SELECT 1 FROM usage_meta m
                       WHERE m.key = 'seen:' || usage_daily.agent || ':' || usage_daily.session_id || ':live'
                          OR m.key = 'seen:' || usage_daily.agent || ':' || usage_daily.session_id || ':snap'
                          OR m.key = 'seen:' || usage_daily.agent || ':' || usage_daily.session_id);
                     DELETE FROM usage_meta WHERE {seen} OR key='initialized';"
                )
            }
            // 只清还能从会话文件重抽的行（有 seen 标记的）；文件已不在的历史行与
            // 不落盘的一次性内部调用行（ephemeral-*）重抽不回来，整表清空就是永久丢账
            None => "DELETE FROM usage_daily WHERE EXISTS (
               SELECT 1 FROM usage_meta m
               WHERE m.key = 'seen:' || usage_daily.agent || ':' || usage_daily.session_id || ':live'
                  OR m.key = 'seen:' || usage_daily.agent || ':' || usage_daily.session_id || ':snap'
                  OR m.key = 'seen:' || usage_daily.agent || ':' || usage_daily.session_id);
             DELETE FROM usage_meta WHERE key LIKE 'seen:%' OR key='initialized';"
                .to_string(),
        };
        conn.execute_batch(&reset_sql)
            .map_err(|e| format!("重置旧用量索引失败: {e}"))?;
        conn.execute(
            "INSERT INTO usage_meta(key, value) VALUES('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![USAGE_SCHEMA_VERSION],
        )
        .map_err(|e| format!("记录用量表版本失败: {e}"))?;
    }
    Ok(())
}

fn register_provenance_impl(
    conn: &Connection,
    agent: &str,
    project_path: &str,
    session_id: &str,
    source: &str,
    internal: bool,
    official: bool,
) -> Result<(), String> {
    let project_path = normalize_provenance_path(project_path);
    conn.execute(
        "INSERT INTO usage_provenance(agent, project_path, session_id, source, internal, official, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(agent, project_path, session_id) DO UPDATE SET
           source=excluded.source, internal=excluded.internal,
           official=excluded.official, created_at=excluded.created_at",
        params![
            agent,
            project_path,
            session_id,
            source,
            i64::from(internal),
            i64::from(official),
            crate::sessions::now_iso()
        ],
    )
    .map_err(|e| format!("记录用量来源失败: {e}"))?;
    Ok(())
}

/// Ccode 无头 AI 临时 cwd 的目录名：`ccode-ai-<uuid>`（与 `ai.rs` 命名同步）。
/// 对话列表用它在 provenance 被清理后仍把这些会话归入内部 AI；用量统计不走这条。
pub(crate) fn is_ccode_ai_temp_cwd(path: &str) -> bool {
    let name = path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    let Some(rest) = name.strip_prefix("ccode-ai-") else {
        return false;
    };
    rest.len() == 36
        && rest.as_bytes().iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// 定时雷达隔离 worktree（~/ccode/watch-worktrees/<项目>/<任务id>）里的会话一律是
/// Mesa 无头拉起的自动活动。按会话 id 的 mark_session_internal 依赖从 CLI 输出解析
/// id——失败/超时的运行解析不到就漏标（2026-10-16 实证：失败运行留下的 codex 会话
/// 未标 internal，隔离目录以任务 UUID 冒充「最近项目」），读取侧按路径兜底。
pub(crate) fn is_watch_worktree_cwd(path: &str) -> bool {
    let key = crate::paths::path_key(&crate::sessions::expand_tilde(path));
    // 家目录可换位置：旧位置里的隔离树会话同样是无头自动活动
    crate::ccode_home::all_sub("watch-worktrees").iter().any(|root| {
        let root_key = crate::paths::path_key(&root.to_string_lossy());
        key == root_key || key.starts_with(&format!("{root_key}/"))
    })
}

pub(crate) fn normalize_provenance_path(path: &str) -> String {
    let expanded = crate::sessions::expand_tilde(path);
    let resolved =
        std::fs::canonicalize(&expanded).unwrap_or_else(|_| std::path::PathBuf::from(&expanded));
    let mut normalized = resolved.to_string_lossy().replace('\\', "/");
    // canonicalize 在 Windows 返回 \\?\ 前缀的 verbatim 形式（替换分隔符后为 //?/），
    // 登记/查询两侧统一剥离再归一化；非 Windows 平台该前缀不会出现，剥离是恒等操作
    if let Some(rest) = normalized.strip_prefix("//?/") {
        normalized = rest.to_string();
    }
    #[cfg(target_os = "macos")]
    {
        // macOS 的 std::env::temp_dir 常返回 /var，CLI 会话通常记录真实的 /private/var。
        if normalized == "/var" || normalized.starts_with("/var/") {
            normalized = format!("/private{normalized}");
        } else if normalized == "/tmp" || normalized.starts_with("/tmp/") {
            normalized = format!("/private{normalized}");
        }
    }
    #[cfg(target_os = "windows")]
    {
        normalized = normalized.to_lowercase();
    }
    if normalized.len() > 1 {
        normalized.truncate(normalized.trim_end_matches('/').len());
    }
    normalized
}

/// Ccode 自己发起无头 AI 调用时登记精确来源；普通终端启动不调用本函数。
/// 临时 cwd 一次运行一个目录（`ccode-ai-<uuid>`），项目级行（session_id=''）天然就是运行粒度。
/// 用户在 Mesa 里亲手删除对话：连同它的用量历史一起删（其余「文件消失」一律保留用量，见 rebuild）。
pub(crate) fn forget_session_usage(agent: &str, session_id: &str) {
    let Ok(conn) = usage_db() else {
        return;
    };
    let _ = conn.execute(
        "DELETE FROM usage_daily WHERE agent=?1 AND session_id=?2",
        params![agent, session_id],
    );
    let _ = conn.execute(
        "DELETE FROM usage_meta WHERE key=?1 OR key=?2",
        params![
            format!("seen:{agent}:{session_id}:live"),
            format!("seen:{agent}:{session_id}:snap")
        ],
    );
}

/// 不落盘的一次性内部调用（claude `--no-session-persistence` / codex `--ephemeral`）：
/// 没有会话文件可供重建时抽取，花费从 CLI 返回结果里直接记账。session_id 用
/// `ephemeral-<run id>`，扫描永远遇不到它，不会被重建覆盖或删除。
pub(crate) fn record_ephemeral_usage(
    agent: &str,
    session_id: &str,
    project_path: &str,
    official: bool,
    events: &[UsageEvent],
) -> Result<(), String> {
    if events.is_empty() {
        return Ok(());
    }
    let conn = usage_db()?;
    let mut events = events.to_vec();
    for e in &mut events {
        e.source = SOURCE_CCODE_AI.into();
        e.internal = true;
        e.official = official;
    }
    let contrib = SessionContrib {
        agent: agent.into(),
        session_id: session_id.into(),
        project_path: project_path.into(),
        workspace: String::new(),
        events,
    };
    for row in aggregate(&[contrib]) {
        conn.execute(
            "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
                                    input, output, cache_read, cache_write, cache_write_1h, source, internal, workspace, official)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(day, agent, model, project_path, session_id) DO UPDATE SET
               input=input+excluded.input, output=output+excluded.output,
               cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write,
               cache_write_1h=cache_write_1h+excluded.cache_write_1h",
            params![
                row.day, row.agent, row.model, row.project_path, row.session_id,
                row.input as i64, row.output as i64, row.cache_read as i64, row.cache_write as i64,
                row.cache_write_1h as i64, row.source, i64::from(row.internal), row.workspace, i64::from(row.official),
            ],
        )
        .map_err(|e| format!("记录内部调用用量失败: {e}"))?;
    }
    Ok(())
}

/// 今天（本机时区）的日期串，一次性调用的用量记在调用当天
pub(crate) fn today_local() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

pub(crate) fn register_internal_ai_run(agent: &str, project_path: &Path) -> Result<(), String> {
    let conn = usage_db()?;
    register_provenance_impl(
        &conn,
        agent,
        &project_path.to_string_lossy(),
        "",
        SOURCE_CCODE_AI,
        true,
        false,
    )
}

/// 官方账号（订阅制）profile 的终端启动登记：source 保持 cli（是用户自己的交互会话），
/// 只标 official，统计页费用栏据此显示「订阅」。
/// v7 起按会话级登记（session_id 取启动 hint / 恢复目标会话），项目只作归属信息——
/// 旧的项目级登记会把同项目后来的 API 会话也标成官方，不再写入。
/// 启动时还不知道会话 id 的 agent 这里不落行，由重建索引时按 session_meta.profile_id
/// 解析认证方式兜底（见 session_provenance）。
pub(crate) fn register_official_launch(
    agent: &str,
    project_path: &Path,
    session_id: Option<&str>,
) -> Result<(), String> {
    let Some(session_id) = session_id.filter(|s| !s.trim().is_empty()) else {
        return Ok(());
    };
    let conn = usage_db()?;
    register_provenance_impl(
        &conn,
        agent,
        &project_path.to_string_lossy(),
        session_id,
        SOURCE_CLI,
        false,
        true,
    )
}

/// session_meta 的会话级标记：(agent, session_id) → (internal, profile_id)。
/// internal = 无头 AI（雷达解读/定时巡检）按会话 id 的登记；profile_id = 会话关联的启动配置，
/// 供重建索引时解析认证方式。表或列不存在（旧库未升级）按空处理
fn session_meta_flags(conn: &Connection) -> HashMap<(String, String), (bool, Option<String>)> {
    let mut map = HashMap::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT agent, session_id, internal, profile_id FROM session_meta
         WHERE internal=1 OR (profile_id IS NOT NULL AND profile_id<>'')",
    ) else {
        return map;
    };
    if let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)? != 0,
            row.get::<_, Option<String>>(3)?,
        ))
    }) {
        for (agent, sid, internal, profile_id) in rows.flatten() {
            map.insert((agent, sid), (internal, profile_id));
        }
    }
    map
}

/// Mesa 开的 Kimi 会话启动时记下的模型：session_id → 模型名。会话文件只记合成别名 `__kimi_env_model__`，
/// Kimi 2.6 起不再写带真名的 llm.request，用量只能靠它换回真名。表或列不存在按空处理
fn kimi_launch_models(conn: &Connection) -> HashMap<String, String> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT session_id, launch_model FROM session_meta
         WHERE agent='kimi' AND launch_model IS NOT NULL AND launch_model<>''",
    ) else {
        return HashMap::new();
    };
    stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

/// 文件里换不回真名的 Kimi 合成别名，改记启动时的模型（没记下的保持原样）
fn fill_kimi_launch_model(events: &mut [UsageEvent], launch_model: Option<&String>) {
    let Some(model) = launch_model else {
        return;
    };
    for event in events {
        if event.model == crate::agents::KIMI_ENV_MODEL_ALIAS {
            event.model.clone_from(model);
        }
    }
}

/// 官方账号（订阅制）profile id 集：重建索引时把会话档案的 profile 解析成认证方式。
/// 测试环境不读本机真实配置（解析链语义由注入 meta_official 的单测覆盖）
#[cfg(not(test))]
fn official_profile_ids() -> HashSet<String> {
    crate::profiles::ProfileStore::new()
        .and_then(|store| store.list())
        .map(|profiles| {
            profiles
                .into_iter()
                .filter(|p| p.account_type == crate::profiles::AccountType::Official)
                .map(|p| p.id)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
fn official_profile_ids() -> HashSet<String> {
    HashSet::new()
}

/// 会话的 (source, internal, official) 判定。优先级：
/// 1. session_meta.internal：无头 AI 按会话 id 的登记，命中即内部活动（internal 优先于一切）
/// 2. 会话级 provenance 行（session_id 非空）：官方账号启动登记的权威记录
/// 3. 项目级 provenance 行（session_id=''）：
///    - internal 行 = 无头 AI 的独占临时 cwd 登记，精确路径匹配即命中
///    - official 行 = v7 前的旧登记（当时整个项目被标官方）：只回填登记时刻已存在的会话
///      （session_created <= created_at），之后新建的会话按新口径重新判定——旧登记不再粘住新会话；
///      会话创建时间缺失时按旧行为保留标记（历史不丢）
/// 4. 会话档案的 profile 是官方账号 → official（覆盖启动时未知会话 id 的 agent）
fn session_provenance(
    conn: &Connection,
    agent: &str,
    project_path: &str,
    session_id: &str,
    session_created: Option<&str>,
    meta_internal: bool,
    meta_official: bool,
) -> (String, bool, bool) {
    if meta_internal {
        return (SOURCE_CCODE_AI.into(), true, false);
    }
    if !session_id.is_empty() {
        let hit = conn
            .query_row(
                "SELECT source, internal, official FROM usage_provenance
                 WHERE agent=?1 AND session_id=?2 AND session_id<>''",
                params![agent, session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)? != 0,
                        row.get::<_, i64>(2)? != 0,
                    ))
                },
            )
            .ok();
        if let Some((source, internal, official)) = hit {
            if internal {
                return (source, true, false);
            }
            if official {
                return (source, false, true);
            }
        }
    }
    let project_path = normalize_provenance_path(project_path);
    let rows = conn
        .prepare(
            "SELECT source, internal, official, created_at FROM usage_provenance
             WHERE agent=?1 AND project_path=?2 AND session_id=''",
        )
        .and_then(|mut stmt| {
            stmt.query_map(params![agent, project_path], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)? != 0,
                    row.get::<_, i64>(2)? != 0,
                    row.get::<_, String>(3)?,
                ))
            })
            .map(|rows| rows.flatten().collect::<Vec<_>>())
        })
        .unwrap_or_default();
    for (source, internal, _, _) in &rows {
        if *internal {
            return (source.clone(), true, false);
        }
    }
    for (source, _, official, created_at) in &rows {
        // ISO 时间戳定宽可字典序比较（同 card_claims 的 created_at 口径）
        if *official && session_created.is_none_or(|c| c <= created_at.as_str()) {
            return (source.clone(), false, true);
        }
    }
    if meta_official {
        return (SOURCE_CLI.into(), false, true);
    }
    (SOURCE_CLI.into(), false, false)
}

/// 小键值：给用量之外的维护任务记时间戳（如内部对话清理的上次运行时刻）
pub(crate) fn kv_get(key: &str) -> Option<String> {
    usage_db().ok().and_then(|conn| meta_get(&conn, key))
}

pub(crate) fn kv_set(key: &str, value: &str) {
    if let Ok(conn) = usage_db() {
        meta_set(&conn, key, value);
    }
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM usage_meta WHERE key=?1",
        params![key],
        |r| r.get(0),
    )
    .ok()
}

fn meta_set(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute(
        "INSERT INTO usage_meta(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value=?2",
        params![key, value],
    );
}

/// 非内部登记：临时目录下、目录已不存在、且超过 7 天的行可清。
/// 内部 AI 登记不清——清掉后会话文件还在，对话页会把 `ccode-ai-<uuid>` 当成普通项目。
/// 真实项目目录的行一律不动（可能暂时未挂载，不能误清）。created_at 是 ISO 字符串可字典序比较
fn prune_stale_provenance(conn: &Connection) {
    const PRUNE_AFTER_SECS: u64 = 7 * 24 * 3600;
    let Some(now) = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
    else {
        return;
    };
    let cutoff = crate::sessions::iso_from_unix(now.saturating_sub(PRUNE_AFTER_SECS));
    let tmp = normalize_provenance_path(&std::env::temp_dir().to_string_lossy());
    // 先收集再删：活跃 SELECT 语句上直接写同连接可能撞 SQLITE_LOCKED
    let rows = {
        let Ok(mut stmt) = conn.prepare(
            "SELECT agent, project_path, internal FROM usage_provenance WHERE created_at < ?1",
        ) else {
            return;
        };
        stmt.query_map(params![cutoff], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
            ))
        })
        .map(|rows| rows.flatten().collect::<Vec<_>>())
        .unwrap_or_default()
    };
    for (agent, path, internal) in rows {
        // 内部 AI 登记一旦清掉，会话文件还在、项目树就会冒出一串 ccode-ai-<uuid>
        if internal {
            continue;
        }
        let under_tmp = path == tmp || path.starts_with(&format!("{tmp}/"));
        if under_tmp && !std::path::Path::new(&path).exists() {
            let _ = conn.execute(
                "DELETE FROM usage_provenance WHERE agent=?1 AND project_path=?2",
                params![agent, path],
            );
        }
    }
}

// ===== 增量重建 =====

/// 快照与活会话可共用 session_id：marker 键必须区分来源，
/// 否则来源切换时两边 marker 互顶，每轮都全量重解析
fn seen_key(s: &crate::sessions::SessionMetaDto) -> String {
    format!(
        "seen:{}:{}:{}",
        s.agent,
        s.session_id,
        if s.alive { "live" } else { "snap" }
    )
}

/// 从 seen 键反解 (agent, session_id)，供清理已消失会话的行；旧格式/损坏键返回 None
#[cfg_attr(not(test), allow(dead_code))]
fn parse_seen_key(key: &str) -> Option<(String, String)> {
    let rest = key.strip_prefix("seen:")?;
    let (agent_sid, _kind) = rest.rsplit_once(':')?;
    let (agent, sid) = agent_sid.split_once(':')?;
    Some((agent.to_string(), sid.to_string()))
}

fn rebuild_impl() -> Result<UsageBuildResult, String> {
    let conn = usage_db()?;
    prune_stale_provenance(&conn);
    let meta_flags = session_meta_flags(&conn);
    let kimi_models = kimi_launch_models(&conn);
    let official_profiles = official_profile_ids();
    let scan = crate::sessions::scan_sessions();
    let mut indexed = 0usize;
    let mut seen: HashSet<String> = HashSet::new();
    for s in scan.sessions.iter().chain(&scan.hidden_members) {
        let key = seen_key(s);
        seen.insert(key.clone());
        // 快照补出的会话（alive=false）file_path 指向快照，内容稳定；
        // updated_at 缺失时用 created_at 兜底，保持 marker 恒定可跳过
        let marker = if s.alive {
            s.updated_at.clone().unwrap_or_default()
        } else {
            s.updated_at
                .clone()
                .or_else(|| s.created_at.clone())
                .unwrap_or_default()
        };
        if meta_get(&conn, &key).as_deref() == Some(marker.as_str()) && !marker.is_empty() {
            continue;
        }
        let (meta_internal, meta_profile) = meta_flags
            .get(&(s.agent.clone(), s.session_id.clone()))
            .cloned()
            .unwrap_or((false, None));
        let meta_official = meta_profile.is_some_and(|p| official_profiles.contains(&p));
        let (source, internal, official) = session_provenance(
            &conn,
            &s.agent,
            &s.project_path,
            &s.session_id,
            s.created_at.as_deref(),
            meta_internal,
            meta_official,
        );
        let mut events = extract_events(s);
        if s.agent == "kimi" {
            fill_kimi_launch_model(&mut events, kimi_models.get(&s.session_id));
        }
        for event in &mut events {
            event.source.clone_from(&source);
            event.internal = internal;
            event.official = official;
        }
        conn.execute(
            "DELETE FROM usage_daily WHERE agent=?1 AND session_id=?2",
            params![s.agent, s.session_id],
        )
        .map_err(|e| e.to_string())?;
        let contrib = SessionContrib {
            agent: s.agent.clone(),
            session_id: s.session_id.clone(),
            project_path: s.project_path.clone(),
            workspace: s.workspace.clone().unwrap_or_default(),
            events,
        };
        for row in aggregate(&[contrib]) {
            conn.execute(
                "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
                                        input, output, cache_read, cache_write, cache_write_1h, source, internal, workspace, official)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(day, agent, model, project_path, session_id) DO UPDATE SET
                   input=input+excluded.input, output=output+excluded.output,
                   cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write,
               cache_write_1h=cache_write_1h+excluded.cache_write_1h,
                   source=excluded.source, internal=excluded.internal, workspace=excluded.workspace,
                   official=excluded.official",
                params![
                    row.day, row.agent, row.model, row.project_path, row.session_id,
                    row.input as i64, row.output as i64, row.cache_read as i64, row.cache_write as i64,
                    row.cache_write_1h as i64, row.source, i64::from(row.internal), row.workspace, i64::from(row.official),
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        meta_set(&conn, &key, &marker);
        indexed += 1;
    }
    // 已消失的会话：只撤「已索引」标记，**用量行留作历史账**（2026-10-17 用户拍板）。
    // 会话文件会被 CLI 自己清掉（Claude Code 默认只留 30 天）或被 Mesa 的内部对话保留期清理
    // 删掉；原先这里连行一起删，用量页的 Claude Code 历史永远只剩最近 30 天。
    // 只有用户在 Mesa 里亲手删除对话才连用量一起删（forget_session_usage）。
    // 文件以后若又出现（快照恢复等），上面的循环会先按 agent+session 删行再重抽，不会翻倍。
    let mut stale: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT key FROM usage_meta WHERE key LIKE 'seen:%'")
            .map_err(|e| e.to_string())?;
        let keys = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for k in keys.flatten() {
            if !seen.contains(&k) {
                stale.push(k);
            }
        }
    }
    for k in stale {
        let _ = conn.execute("DELETE FROM usage_meta WHERE key=?1", params![k]);
    }
    meta_set(&conn, "initialized", &crate::sessions::now_iso());
    let rows: usize = conn
        .query_row("SELECT COUNT(*) FROM usage_daily", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap_or(0) as usize;
    Ok(UsageBuildResult {
        sessions_indexed: indexed,
        rows,
    })
}

/// rebuild 的 DELETE→upsert 序列不在一个事务里：终端状态栏轮询的 session_usage 与
/// 手动刷新并发时，两个 rebuild 都可能先通过 marker 检查再交错执行同一会话，
/// ON CONFLICT 的累加分支会把 token 翻倍。所有调用点一律经此入口串行化；
/// 毒锁按 sessions.rs 既有口径容忍（持锁 panic 不应永久瘫痪终端状态栏轮询）。
fn rebuild_locked() -> Result<UsageBuildResult, String> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    let mutex = LOCK.get_or_init(|| std::sync::Mutex::new(()));
    let _guard = mutex.lock().unwrap_or_else(|e| e.into_inner());
    rebuild_impl()
}

// ===== 定价 =====

/// 内置前缀价目（美元 / 每百万 token）；最长前缀匹配（gpt-5-codex 优先于 gpt-5、
/// grok-4.1-fast 优先于 grok-4、qwen3-coder 优先于 qwen3）。
/// 数据口径：2026-08-31 各官方定价页（xAI 官方站不可达，grok 系据 OpenRouter/LiteLLM
/// 归档价）。同前缀跨代价格不同的一律给新代加更长前缀、旧价留给老会话归属；
/// 价格随时间漂移的模型（gemini-3.6-flash 推广价、deepseek 峰谷价、上下文档位、
/// qwen 阶梯价）取当前首档，精度损失由公共能力库/用户覆盖两层兜底修正。
const BUILTIN_PRICING: &[(&str, (f64, f64))] = &[
    // Anthropic（Opus 4.5 起降至 5/25，仅 4.1 为 15/75；Sonnet 5 起 2/10；Haiku 4.5 = 1/5）
    ("claude-opus-4-1", (15.0, 75.0)),
    ("claude-opus", (5.0, 25.0)),
    ("claude-sonnet-4", (3.0, 15.0)),
    ("claude-sonnet", (2.0, 10.0)),
    ("claude-haiku", (1.0, 5.0)),
    ("claude-fable", (10.0, 50.0)),
    // OpenAI（codex 版与同代基础模型同价：5.1-codex 命中 gpt-5.1、5.2-codex 命中 gpt-5.2）
    ("gpt-5.6-sol", (4.0, 20.0)),
    ("gpt-5.6-terra", (2.0, 12.0)),
    ("gpt-5.6-luna", (0.2, 1.2)),
    ("gpt-5.5", (5.0, 30.0)),
    ("gpt-5.4", (2.5, 15.0)),
    ("gpt-5.3-codex", (1.75, 14.0)),
    ("gpt-5.2", (1.75, 14.0)),
    ("gpt-5.1", (1.25, 10.0)),
    ("gpt-5-mini", (0.25, 2.0)),
    ("gpt-5-nano", (0.05, 0.4)),
    ("gpt-5-codex", (1.25, 10.0)),
    ("gpt-5", (1.25, 10.0)),
    // Kimi（官方国际站 USD 价，缓存未命中输入；缓存命中约一折，与 cost_of 的
    // cache_read×0.1 系数一致。国内站人民币价折算略低，k2 初代已退役留作旧会话归属）
    ("kimi-k3", (3.0, 15.0)),
    ("kimi-k2.7", (0.95, 4.0)),
    ("kimi-k2.6", (0.95, 4.0)),
    ("kimi-k2.5", (0.6, 3.0)),
    ("kimi-k2", (0.6, 2.5)),
    ("moonshot", (0.6, 3.0)), // V1 系 2026-08-31 全线下线，留作旧会话归属
    // Google（2.5-pro/3.1-pro 的 >200K 档更贵，取首档；3.6-flash 为推广价，
    // 2027-01-01 起恢复 1.5/7.5；3-pro 已关停，留作旧会话归属）
    ("gemini-3.6-flash", (0.75, 3.75)),
    ("gemini-3.5-flash", (1.5, 9.0)),
    ("gemini-3.1-pro", (2.0, 12.0)),
    ("gemini-3-pro", (2.0, 12.0)),
    ("gemini-3-flash", (0.5, 3.0)),
    ("gemini-2.5-pro", (1.25, 10.0)),
    ("gemini-2.5-flash", (0.3, 2.5)),
    // xAI（官方站不可达，据 OpenRouter 现行目录 + LiteLLM 归档；3 系与初代 4
    // 2026 年上半年已停售，留作旧会话归属；>200k 档翻倍不单列）
    ("grok-4.1-fast", (0.2, 0.5)),
    ("grok-4-fast", (0.2, 0.5)),
    ("grok-4.6", (2.0, 6.0)),
    ("grok-4.5", (2.0, 6.0)),
    ("grok-4.3", (1.25, 2.5)),
    ("grok-4.2", (1.25, 2.5)), // 含 grok-4.20
    ("grok-4", (3.0, 15.0)),
    ("grok-3-mini", (0.3, 0.5)),
    ("grok-3", (3.0, 15.0)),
    ("grok-code-fast", (0.2, 1.5)),
    ("grok-build", (1.0, 2.0)),
    // 智谱 z.ai 官方国际价（国内站人民币价另有口径；Flash 免费款不收条目——
    // 0 价会参与计费把桶标成「已计价」，免费模型应走公共库如实 0 价）
    ("glm-5.3-flash", (0.15, 0.5)),
    ("glm-5.3", (1.4, 4.4)),
    ("glm-5.2", (1.4, 4.4)),
    ("glm-5p2", (1.4, 4.4)), // 中转对 GLM-5.2 的常见改名
    ("glm-5.1", (1.4, 4.4)),
    ("glm-5", (1.0, 3.2)),
    ("glm-4.5-air", (0.2, 1.1)),
    ("glm-4.5-x", (2.2, 8.9)),
    ("glm-4.7", (0.6, 2.2)),
    ("glm-4.6", (0.6, 2.2)),
    ("glm-4.5", (0.6, 2.2)),
    // 阿里百炼国际价 ≤32K 首档（国内区约六折；32K 以上阶梯档不展开）
    ("qwen3-coder-flash", (0.3, 1.5)),
    ("qwen3-coder", (1.0, 5.0)),
    ("qwen3-max", (1.2, 6.0)),
    ("qwen3", (0.5, 2.0)),
    // DeepSeek 峰时价（谷时半价；表不带时间维度，V3 旧会话按现价归属）
    ("deepseek-v4-pro", (1.32, 3.96)),
    ("deepseek", (0.44, 1.32)),
];

/// 汇率取值链：settings.json 的 rate_usd_cny > pricing.json 的 "_rate" > 默认 7.2
fn load_rate_with(settings_rate: Option<f64>, override_path: Option<&Path>) -> f64 {
    if let Some(r) = settings_rate.filter(|r| *r > 0.0) {
        return r;
    }
    override_path
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v.get("_rate").and_then(|r| r.as_f64()))
        .filter(|r| *r > 0.0)
        .unwrap_or(crate::settings::DEFAULT_RATE_USD_CNY)
}

fn load_rate(override_path: Option<&Path>) -> f64 {
    load_rate_with(crate::settings::rate_setting(), override_path)
}

/// 定价链：按优先级升序的三层（内置表 < 公共能力库 < 用户 pricing.json）。
/// 查询时从高层往低层找，**高层任意前缀命中即胜**，同层内最长前缀优先——
/// 与 model_registry 逐字段查询链同语义：用户写「claude-sonnet」就是覆盖全系
/// sonnet，低层更长的代际前缀（claude-sonnet-4 旧代价）不挡路
type PriceChain = [Vec<(String, Price)>; 3];

/// 一个模型的各种单价（美元 / 每百万 token）。公共库与自定义价带缓存读 / 写价，内置价目只有两价；
/// 缺的缓存价见 [`Price::new`]
#[derive(Debug, Clone, Copy, PartialEq)]
struct Price {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    /// 1 小时缓存写（只有 Claude 分开记）：官方价恒为输入价 2 倍
    cache_write_1h: f64,
}

impl Price {
    /// 数据源没给的缓存价按输入价折算：读 1 折、写全价（spec 未定义写价，取保守全价）
    fn new(input: f64, output: f64, cache_read: Option<f64>, cache_write: Option<f64>) -> Self {
        Price {
            input,
            output,
            cache_read: cache_read.unwrap_or(input * 0.1),
            cache_write: cache_write.unwrap_or(input),
            cache_write_1h: input * 2.0,
        }
    }
}

impl From<(f64, f64)> for Price {
    fn from((input, output): (f64, f64)) -> Self {
        Price::new(input, output, None, None)
    }
}

impl From<crate::model_registry::DbPrice> for Price {
    fn from(p: crate::model_registry::DbPrice) -> Self {
        Price::new(p.input, p.output, p.cache_read, p.cache_write)
    }
}

fn price_layer<P: Into<Price>>(table: Vec<(String, P)>) -> Vec<(String, Price)> {
    table.into_iter().map(|(k, v)| (k, v.into())).collect()
}

/// 用户 pricing.json 层：按人民币填的用汇率折成美元（只在真有人民币条目时才去读汇率）
fn user_price_layer(override_path: Option<&Path>) -> Vec<(String, Price)> {
    let entries = override_path
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|text| crate::pricing::parse_entries(&text))
        .unwrap_or_default();
    let rate = if entries.iter().any(|(_, p)| p.cny) { load_rate(override_path) } else { 1.0 };
    entries
        .into_iter()
        .map(|(prefix, p)| {
            let k = if p.cny { 1.0 / rate } else { 1.0 };
            let price = Price::new(p.input * k, p.output * k, p.cache_read.map(|v| v * k), p.cache_write.map(|v| v * k));
            (prefix, price)
        })
        .collect()
}

fn load_pricing(override_path: Option<&Path>) -> PriceChain {
    let builtin: Vec<(String, (f64, f64))> = BUILTIN_PRICING
        .iter()
        .map(|(p, v)| (p.to_string(), *v))
        .collect();
    // 公共能力库层（models.dev/OpenRouter 下载快照，model-capabilities-db.json 的
    // cost 字段）：比内置表新、跟随数据源更新
    let db = price_layer(crate::model_registry::db_price_table());
    // 统一写法（点当横杠、去 :batch 变体）：claude-opus-5.5 与 claude-opus-5-5 才对得上（model_registry::model_key）
    [
        crate::model_registry::keyed(price_layer(builtin)),
        db,
        crate::model_registry::keyed(user_price_layer(override_path)),
    ]
}


/// 输入 / 输出两价（一键配置认轻量、待补清单、测试用）；算费走 [`full_price_of`]
fn price_of(model: &str, chain: &PriceChain) -> Option<(f64, f64)> {
    full_price_of(model, chain).map(|p| (p.input, p.output))
}

fn full_price_of(model: &str, chain: &PriceChain) -> Option<Price> {
    price_with_layer(model, chain).map(|(p, _)| p)
}

/// 查价并说出是哪一层给的（0 内置、1 公共库、2 自定义），设置页「现在按什么价算」用
fn price_with_layer(model: &str, chain: &PriceChain) -> Option<(Price, usize)> {
    use crate::model_registry::{match_in, model_key, KeyMatch};
    // 中转/聚合的 provider 前缀（accounts/fireworks/models/x、zetatechs/x）剥掉、统一写法，按末段模型名匹配
    let key = model_key(model);
    // 高层先问：用户覆盖 > 公共库 > 内置。公共库是逐个型号的完整名，只认同一型号——
    // 按前缀退到上一代会算错价（2026-10-28：Opus 5.5 被按 Opus 5 计）；用户覆盖与内置表是前缀
    let how = [KeyMatch::Prefix, KeyMatch::Exact, KeyMatch::Prefix];
    for (i, (layer, how)) in chain.iter().zip(how).enumerate().rev() {
        if let Some(p) = match_in(layer, &key, how) {
            return Some((*p, i));
        }
    }
    None
}

#[derive(Debug, Default, Clone, Copy)]
struct TokenAcc {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    /// cache_write 里的 1 小时缓存部分
    cache_write_1h: u64,
}

fn cost_of(acc: &TokenAcc, price: Price) -> f64 {
    let write_1h = acc.cache_write_1h.min(acc.cache_write);
    (acc.input as f64 * price.input
        + acc.output as f64 * price.output
        + acc.cache_read as f64 * price.cache_read
        + (acc.cache_write - write_1h) as f64 * price.cache_write
        + write_1h as f64 * price.cache_write_1h)
        / 1_000_000.0
}

/// 几段会话一共花了多少（事件规则每周花费上限用，2026-11-04）：先增量建一次索引，再按会话合计，查不到价的不计
pub(crate) fn sessions_cost_usd(sessions: &[(String, String)]) -> f64 {
    if sessions.is_empty() {
        return 0.0;
    }
    let _ = rebuild_locked();
    let Ok(conn) = usage_db() else { return 0.0 };
    sessions
        .iter()
        .filter_map(|(agent, sid)| session_usage_from(&conn, agent, sid).ok())
        .map(|u| u.cost_usd)
        .sum()
}

/// 一段会话的花费（美元）；没有一个模型能计价时返回 None（「没记录就不写」，不报 0）
pub(crate) fn session_cost_priced(agent: &str, session_id: &str) -> Option<f64> {
    let _ = rebuild_locked();
    let conn = usage_db().ok()?;
    let u = session_usage_from(&conn, agent, session_id).ok()?;
    (u.priced && u.cost_usd > 0.0).then_some(u.cost_usd)
}

/// 一次不落盘调用的花费（项目助手每条回答下面写，2026-11-04）：同统计页口径（用户 pricing.json > 公共库 > 内置），
/// 有一个模型查不到价就返回 None（不报半个数）
pub(crate) fn events_cost_usd(events: &[UsageEvent]) -> Option<f64> {
    if events.is_empty() {
        return None;
    }
    let pricing_path = crate::dirs::config_dir().map(|d| d.join("ccode").join("pricing.json"));
    let chain = load_pricing(pricing_path.as_deref());
    let mut total = 0.0;
    for e in events {
        let price = full_price_of(&e.model, &chain)?;
        total += cost_of(
            &TokenAcc {
                input: e.input,
                output: e.output,
                cache_read: e.cache_read,
                cache_write: e.cache_write,
                cache_write_1h: e.cache_write_1h,
            },
            price,
        );
    }
    Some(total)
}

/// 缓存读相对「按输入全价」省下的钱（默认缓存读 1 折，省 9 折；自定义了缓存读价按差价）。无定价或 0 读则 None。
fn cache_savings_usd(model: &str, cache_read: u64, chain: &PriceChain) -> Option<f64> {
    if cache_read == 0 {
        return None;
    }
    full_price_of(model, chain)
        .map(|p| cache_read as f64 * (p.input - p.cache_read).max(0.0) / 1_000_000.0)
}

fn parse_day(iso: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(iso, "%Y-%m-%d").ok()
}

fn each_day(from: NaiveDate, to: NaiveDate) -> Vec<String> {
    let mut out = Vec::new();
    let mut d = from;
    while d <= to {
        out.push(d.format("%Y-%m-%d").to_string());
        d = match d.checked_add_days(Days::new(1)) {
            Some(n) => n,
            None => break,
        };
    }
    out
}

// ===== 查询 =====

fn cutoff_day_from(range: &str, today: NaiveDate) -> Option<String> {
    let days_back = match range {
        "today" => 0,
        "week" => 6,
        "month" => 29,
        _ => return None, // "all" 不过滤
    };
    today
        .checked_sub_days(Days::new(days_back))
        .map(|day| day.format("%Y-%m-%d").to_string())
}

fn cutoff_day(range: &str) -> Option<String> {
    cutoff_day_from(range, Local::now().date_naive())
}

#[derive(Debug, Default)]
struct Bucket {
    tokens: TokenAcc,
    sessions: HashSet<String>,
    by_model: HashMap<String, TokenAcc>,
}

impl Bucket {
    fn add(&mut self, model: &str, session_id: &str, acc: TokenAcc) {
        self.tokens.input += acc.input;
        self.tokens.output += acc.output;
        self.tokens.cache_read += acc.cache_read;
        self.tokens.cache_write += acc.cache_write;
        self.tokens.cache_write_1h += acc.cache_write_1h;
        self.sessions.insert(session_id.to_string());
        let m = self.by_model.entry(model.to_string()).or_default();
        m.input += acc.input;
        m.output += acc.output;
        m.cache_read += acc.cache_read;
        m.cache_write += acc.cache_write;
        m.cache_write_1h += acc.cache_write_1h;
    }

    /// 部分计价：只累加有价格的模型份额；(费用, 是否含未计价模型用量)。
    /// 全部不明价 → 费用 None（前端显示 ~）；混有不明价 → costPartial=true（前端显示 ≥）
    fn cost(&self, table: &PriceChain) -> (Option<f64>, bool) {
        let mut total = 0.0;
        let mut has_priced = false;
        let mut has_unpriced = false;
        for (model, acc) in &self.by_model {
            if acc.input + acc.output + acc.cache_read + acc.cache_write == 0 {
                continue;
            }
            match full_price_of(model, table) {
                Some(price) => {
                    has_priced = true;
                    total += cost_of(acc, price);
                }
                None => has_unpriced = true,
            }
        }
        (if has_priced { Some(total) } else { None }, has_unpriced)
    }
}

type StoredUsageRow = (
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    i64,
    i64,
    String,
    bool,
    String, // workspace：工作区名，非工作区会话为 ""
    bool,   // official：官方账号（订阅制）用量，不按量计费
    i64,    // cache_write_1h：cache_write 里的 1 小时缓存部分
);

fn build_stats(rows: Vec<StoredUsageRow>, table: &PriceChain, rate_usd_cny: f64) -> UsageStatsDto {
    let mut cards = Bucket::default();
    // 计费范围：官方账号（订阅制）与内部活动不按量计费，总额/趋势/榜单同一口径；
    // 它们的 token 量单列展示（official_tokens/internal_tokens），不进费用
    let mut billed = Bucket::default();
    let mut official_tokens = 0u64;
    let mut internal_tokens = 0u64;
    let mut cache_savings = 0.0;
    let mut cache_savings_any = false;
    // (agent, official)：官方账号用量与 API 用量分桶，费用栏分别显示「订阅」与估算金额
    let mut by_agent: HashMap<(String, bool), Bucket> = HashMap::new();
    let mut by_project: HashMap<(String, String, bool, bool), Bucket> = HashMap::new();
    let mut by_model: HashMap<(String, String, bool), Bucket> = HashMap::new();
    // (工作区名, 所属仓库路径, internal, official)：同名工作区在不同仓库下各自成行
    let mut by_workspace: HashMap<(String, String, bool, bool), Bucket> = HashMap::new();
    // 按天成桶（v3.88 趋势线）：区间总数看不出「这周比上周多花多少」，
    // 而数据本来就是按天存的，聚合一层即可，不引图表库
    let mut by_day: std::collections::BTreeMap<String, Bucket> = Default::default();
    // 每天的可计费桶：token 趋势展示全部用量，费用与总额共用同一计费范围
    let mut by_day_billed: std::collections::BTreeMap<String, Bucket> = Default::default();
    for (_day, agent, model, project, sid, i, o, cr, cw, source, internal, workspace, official, cw1h) in
        rows
    {
        let acc = TokenAcc {
            input: i as u64,
            output: o as u64,
            cache_read: cr as u64,
            cache_write: cw as u64,
            cache_write_1h: cw1h as u64,
        };
        cards.add(&model, &sid, acc);
        if internal {
            internal_tokens += acc.input + acc.output;
        } else if official {
            official_tokens += acc.input + acc.output;
        } else {
            billed.add(&model, &sid, acc);
            if let Some(saved) = cache_savings_usd(&model, acc.cache_read, table) {
                cache_savings += saved;
                cache_savings_any = true;
            }
        }
        if !_day.is_empty() {
            by_day
                .entry(_day.clone())
                .or_default()
                .add(&model, &sid, acc);
            if !official && !internal {
                by_day_billed
                    .entry(_day)
                    .or_default()
                    .add(&model, &sid, acc);
            }
        }
        by_agent
            .entry((agent, official))
            .or_default()
            .add(&model, &sid, acc);
        by_project
            .entry((project.clone(), source.clone(), internal, official))
            .or_default()
            .add(&model, &sid, acc);
        by_model
            .entry((model.clone(), source, internal))
            .or_default()
            .add(&model, &sid, acc);
        if !workspace.is_empty() {
            by_workspace
                .entry((workspace, project, internal, official))
                .or_default()
                .add(&model, &sid, acc);
        }
    }
    let total = |b: &Bucket| b.tokens.input + b.tokens.output;
    let mut agent_rows: Vec<UsageAgentRowDto> = by_agent
        .into_iter()
        .map(|((agent, official), b)| {
            let (cost_usd, cost_partial) = b.cost(table);
            UsageAgentRowDto {
                tokens: total(&b),
                cost_usd,
                cost_partial,
                agent,
                model_count: b.by_model.len() as u32,
                official,
            }
        })
        .collect();
    agent_rows.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    agent_rows.truncate(LIST_CAP);
    let mut project_rows: Vec<UsageProjectRowDto> = by_project
        .into_iter()
        .map(|((project_path, source, internal, official), b)| {
            let (cost_usd, cost_partial) = b.cost(table);
            UsageProjectRowDto {
                tokens: total(&b),
                sessions: b.sessions.len() as u64,
                cost_usd,
                cost_partial,
                project_path,
                source,
                internal,
                official,
            }
        })
        .collect();
    project_rows.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    project_rows.truncate(LIST_CAP);
    let mut model_rows: Vec<UsageModelRowDto> = by_model
        .into_iter()
        .map(|((model, source, internal), b)| {
            let (cost_usd, cost_partial) = b.cost(table);
            UsageModelRowDto {
                model: if model.is_empty() {
                    "(未知)".into()
                } else {
                    model
                },
                input: b.tokens.input,
                output: b.tokens.output,
                cost_usd,
                cost_partial,
                source,
                internal,
            }
        })
        .collect();
    model_rows.sort_by(|a, b| (b.input + b.output).cmp(&(a.input + a.output)));
    model_rows.truncate(LIST_CAP);
    let mut workspace_rows: Vec<UsageWorkspaceRowDto> = by_workspace
        .into_iter()
        .map(|((workspace, repo_path, internal, official), b)| {
            let (cost, cost_partial) = b.cost(table);
            UsageWorkspaceRowDto {
                workspace_name: workspace,
                repo_name: Path::new(&repo_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or(repo_path),
                tokens_in: b.tokens.input,
                tokens_out: b.tokens.output,
                cost,
                cost_partial,
                models: b.by_model.len() as u32,
                internal,
                official,
            }
        })
        .collect();
    workspace_rows.sort_by(|a, b| (b.tokens_in + b.tokens_out).cmp(&(a.tokens_in + a.tokens_out)));
    workspace_rows.truncate(LIST_CAP);
    // 趋势序列：按日期升序，日期字符串定宽（YYYY-MM-DD）故 BTreeMap 顺序即时间序
    let daily: Vec<UsageDayRowDto> = by_day
        .into_iter()
        .map(|(day, b)| {
            let day_billed = by_day_billed.remove(&day).unwrap_or_default();
            let (cost_usd, cost_partial) = day_billed.cost(table);
            UsageDayRowDto {
                day,
                input: b.tokens.input,
                output: b.tokens.output,
                // 与 usage_trend 同口径：当天无可计费行记 0；有可计费行但全未计价保持 None（~）
                cost_usd: if day_billed.by_model.is_empty() {
                    Some(0.0)
                } else {
                    cost_usd
                },
                cost_partial,
            }
        })
        .collect();
    let (cards_cost, cards_partial) = billed.cost(table);
    UsageStatsDto {
        daily,
        cards: UsageCardsDto {
            input: cards.tokens.input,
            output: cards.tokens.output,
            cache_read: cards.tokens.cache_read,
            cache_write: cards.tokens.cache_write,
            sessions: cards.sessions.len() as u64,
            cost_usd: cards_cost,
            cost_partial: cards_partial,
            cache_savings_usd: if cache_savings_any {
                Some(cache_savings)
            } else {
                None
            },
            official_tokens,
            internal_tokens,
        },
        by_agent: agent_rows,
        by_project: project_rows,
        by_model: model_rows,
        by_workspace: workspace_rows,
        rate_usd_cny,
    }
}

fn query_stats(range: &str) -> Result<UsageStatsDto, String> {
    let conn = usage_db()?;
    let (sql, cutoff) = match cutoff_day(range) {
        Some(c) => (
            "SELECT day, agent, model, project_path, session_id, input, output, cache_read, cache_write,
                    source, internal, workspace, official, cache_write_1h
             FROM usage_daily WHERE day >= ?1",
            Some(c),
        ),
        None => (
            "SELECT day, agent, model, project_path, session_id, input, output, cache_read, cache_write,
                    source, internal, workspace, official, cache_write_1h
             FROM usage_daily",
            None,
        ),
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows: Vec<StoredUsageRow> = {
        let map_row = |r: &rusqlite::Row| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get::<_, i64>(10)? != 0,
                r.get(11)?,
                r.get::<_, i64>(12)? != 0,
                r.get(13)?,
            ))
        };
        let collected: rusqlite::Result<Vec<_>> = match &cutoff {
            Some(c) => stmt
                .query_map(params![c], map_row)
                .map_err(|e| e.to_string())?
                .collect(),
            None => stmt
                .query_map([], map_row)
                .map_err(|e| e.to_string())?
                .collect(),
        };
        collected.map_err(|e| e.to_string())?
    };
    let pricing_path = crate::dirs::config_dir().map(|d| d.join("ccode").join("pricing.json"));
    let table = load_pricing(pricing_path.as_deref());
    Ok(build_stats(
        rows,
        &table,
        load_rate(pricing_path.as_deref()),
    ))
}

// ===== DTO 与 commands =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBuildResult {
    pub sessions_indexed: usize,
    pub rows: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDayRowDto {
    /// 本机日期 YYYY-MM-DD（定宽，字典序即时间序）
    pub day: String,
    pub input: u64,
    pub output: u64,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCardsDto {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub sessions: u64,
    /// 计费范围（排除官方账号与内部活动）内已计价模型的份额合计；全部不明价时为 None
    pub cost_usd: Option<f64>,
    /// 计费桶里还混有不明价模型的用量（费用应显示为 ≥）
    pub cost_partial: bool,
    /// 计费范围内已计价模型的缓存读相对全价输入省下的钱；无定价缓存为 None
    pub cache_savings_usd: Option<f64>,
    /// 官方账号（订阅制）用量的 token 量（输入+输出）：单列展示，不计入费用
    pub official_tokens: u64,
    /// 内部活动（无头 AI / 定时巡检）的 token 量（输入+输出）：单列展示，不计入费用
    pub internal_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAgentRowDto {
    pub agent: String,
    pub tokens: u64,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
    /// 该 agent 在统计范围内使用过的不同模型数
    pub model_count: u32,
    /// 官方账号（订阅制）用量：不按量计费，前端费用栏显示「订阅」
    pub official: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProjectRowDto {
    pub project_path: String,
    pub tokens: u64,
    pub sessions: u64,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
    pub source: String,
    pub internal: bool,
    /// 官方账号（订阅制）用量：不按量计费，前端费用栏显示「订阅」
    pub official: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelRowDto {
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
    pub source: String,
    pub internal: bool,
}

/// 任务成本（§P5 成本按工作区归因）：usage 落在某工作区 worktree 内的会话按工作区成桶
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWorkspaceRowDto {
    pub workspace_name: String,
    /// 所属项目（仓库）名
    pub repo_name: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    /// 与项目排行同口径：已计价模型份额合计，全部不明价为 None
    pub cost: Option<f64>,
    pub cost_partial: bool,
    /// 统计范围内用过的不同模型数
    pub models: u32,
    pub internal: bool,
    /// 官方账号（订阅制）用量：不按量计费，前端费用栏显示「订阅」
    pub official: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatsDto {
    pub cards: UsageCardsDto,
    /// 按天的 token 与费用（升序）：统计页趋势线用；区间总数看不出周比周的变化
    pub daily: Vec<UsageDayRowDto>,
    pub by_agent: Vec<UsageAgentRowDto>,
    pub by_project: Vec<UsageProjectRowDto>,
    pub by_model: Vec<UsageModelRowDto>,
    /// 按工作区/任务归因的成本（仅含命中工作区的用量，按 token 降序）
    pub by_workspace: Vec<UsageWorkspaceRowDto>,
    /// USD→CNY 汇率（pricing.json 的 "_rate" 可覆盖，默认 7.2）
    pub rate_usd_cny: f64,
}

#[tauri::command]
pub async fn rebuild_usage_index() -> Result<UsageBuildResult, String> {
    tauri::async_runtime::spawn_blocking(rebuild_locked)
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Debug, Default, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageDto {
    /// 没命中缓存的输入（各家入库时已拆好，见 uncached_input）
    pub input: u64,
    pub output: u64,
    /// 读缓存 / 写缓存：Claude 这类带缓存的长对话里这才是大头（每轮都把整段上下文读一遍），
    /// 状态栏的合计要算上，否则只剩新输入 + 输出、比实际处理量少两三个数量级（2026-10-22 用户：「token 数是不是显示有误」）
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost_usd: f64,
    /// 至少一个模型命中定价表（费用才有意义；全未命中时前端只显示 token）
    pub priced: bool,
}

/// 按 session 聚合用量（查询本体，测试可注入内存库）；费用按模型分组各自计价再合计
fn session_usage_from(
    conn: &Connection,
    agent: &str,
    session_id: &str,
) -> Result<SessionUsageDto, String> {
    let mut stmt = conn
        .prepare(
            "SELECT model, SUM(input), SUM(output), SUM(cache_read), SUM(cache_write), SUM(cache_write_1h)
             FROM usage_daily WHERE agent = ?1 AND session_id = ?2 GROUP BY model",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![agent, session_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let pricing = load_pricing(None);
    let mut out = SessionUsageDto::default();
    for row in rows {
        let (model, i, o, cr, cw, cw1h) = row.map_err(|e| e.to_string())?;
        out.input += i as u64;
        out.output += o as u64;
        out.cache_read += cr as u64;
        out.cache_write += cw as u64;
        if let Some(price) = full_price_of(&model, &pricing) {
            out.priced = true;
            out.cost_usd += cost_of(
                &TokenAcc {
                    input: i as u64,
                    output: o as u64,
                    cache_read: cr as u64,
                    cache_write: cw as u64,
                    cache_write_1h: cw1h as u64,
                },
                price,
            );
        }
    }
    Ok(out)
}

/// 一个会话用过的模型（研究记录用）：只查已索引的 usage_daily，不触发重建；查不到给空
pub(crate) fn session_models(agent: &str, session_id: &str) -> Vec<String> {
    let Ok(conn) = usage_db() else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT DISTINCT model FROM usage_daily WHERE agent = ?1 AND session_id = ?2 AND model <> '' ORDER BY model",
    ) else {
        return Vec::new();
    };
    stmt.query_map(rusqlite::params![agent, session_id], |r| r.get::<_, String>(0))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

/// 单个会话的累计用量（终端状态栏）：先增量索引（marker 未变的会话直接跳过，运行中
/// 会话随前端轮询节奏追新）再按 session_id 聚合 usage_daily
#[tauri::command]
pub async fn session_usage(agent: String, session_id: String) -> Result<SessionUsageDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rebuild_locked()?;
        let conn = usage_db()?;
        session_usage_from(&conn, &agent, &session_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_usage_stats(range: String) -> Result<UsageStatsDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 首次使用自动建索引，页面无需手动触发
        let first_run = usage_db()
            .map(|conn| meta_get(&conn, "initialized").is_none())
            .unwrap_or(false);
        if first_run {
            rebuild_locked()?;
        }
        query_stats(&range)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrendDayDto {
    pub day: String,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
    pub has_usage: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrendDto {
    pub days: Vec<UsageTrendDayDto>,
    pub rate_usd_cny: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTopSessionDto {
    pub agent: String,
    pub session_id: String,
    pub project_path: String,
    pub title: Option<String>,
    pub tokens: u64,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
}

type TrendQueryRow = (
    String, // day
    String, // agent
    String, // model
    String, // project_path
    String, // session_id
    i64,
    i64,
    i64,
    i64,
    bool, // official
    bool, // internal
    i64,  // cache_write_1h
);

fn select_daily_rows(
    conn: &Connection,
    cutoff: Option<&str>,
) -> Result<Vec<TrendQueryRow>, String> {
    let sql = if cutoff.is_some() {
        "SELECT day, agent, model, project_path, session_id, input, output, cache_read, cache_write, official, internal,
                cache_write_1h
         FROM usage_daily WHERE day >= ?1"
    } else {
        "SELECT day, agent, model, project_path, session_id, input, output, cache_read, cache_write, official, internal,
                cache_write_1h
         FROM usage_daily"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let map_row = |r: &rusqlite::Row| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, i64>(7)?,
            r.get::<_, i64>(8)?,
            r.get::<_, i64>(9)? != 0,
            r.get::<_, i64>(10)? != 0,
            r.get::<_, i64>(11)?,
        ))
    };
    let collected: rusqlite::Result<Vec<_>> = if let Some(c) = cutoff {
        stmt.query_map(params![c], map_row)
            .map_err(|e| e.to_string())?
            .collect()
    } else {
        stmt.query_map([], map_row)
            .map_err(|e| e.to_string())?
            .collect()
    };
    collected.map_err(|e| e.to_string())
}

struct DayAgg {
    billed: Bucket,
    has_usage: bool,
}

fn usage_trend_from(
    conn: &Connection,
    range: &str,
    today: NaiveDate,
    table: &PriceChain,
    rate: f64,
) -> Result<UsageTrendDto, String> {
    let cutoff = cutoff_day_from(range, today);
    let rows = select_daily_rows(conn, cutoff.as_deref())?;
    let mut by_day: std::collections::BTreeMap<String, DayAgg> = Default::default();
    for (day, _agent, model, _project, sid, i, o, cr, cw, official, internal, cw1h) in &rows {
        if day.is_empty() || *internal {
            continue;
        }
        let slot = by_day.entry(day.clone()).or_insert_with(|| DayAgg {
            billed: Bucket::default(),
            has_usage: false,
        });
        slot.has_usage = true;
        if !official {
            slot.billed.add(
                model,
                sid,
                TokenAcc {
                    input: *i as u64,
                    output: *o as u64,
                    cache_read: *cr as u64,
                    cache_write: *cw as u64,
                    cache_write_1h: *cw1h as u64,
                },
            );
        }
    }
    let to = today;
    let from = match cutoff.as_deref().and_then(parse_day) {
        Some(d) => d,
        None => by_day
            .keys()
            .next()
            .and_then(|d| parse_day(d))
            .unwrap_or(today),
    };
    let days = each_day(from, to)
        .into_iter()
        .map(|day| match by_day.remove(&day) {
            Some(agg) => {
                let (cost_usd, cost_partial) = agg.billed.cost(table);
                UsageTrendDayDto {
                    day,
                    // 当天没有任何 API 行（空天或纯订阅）记 0；只有未计价模型时保持 None（~）
                    cost_usd: if agg.billed.by_model.is_empty() {
                        Some(0.0)
                    } else {
                        cost_usd
                    },
                    cost_partial,
                    has_usage: agg.has_usage,
                }
            }
            None => UsageTrendDayDto {
                day,
                cost_usd: Some(0.0),
                cost_partial: false,
                has_usage: false,
            },
        })
        .collect();
    Ok(UsageTrendDto {
        days,
        rate_usd_cny: rate,
    })
}

fn session_custom_title(conn: &Connection, agent: &str, session_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT custom_title FROM session_meta WHERE agent=?1 AND session_id=?2",
        params![agent, session_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
    .and_then(|t| {
        let s = t.trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(crate::sessions::redact_sensitive_text(&s))
        }
    })
}

fn top_sessions_from(
    conn: &Connection,
    range: &str,
    today: NaiveDate,
    table: &PriceChain,
) -> Result<Vec<UsageTopSessionDto>, String> {
    let cutoff = cutoff_day_from(range, today);
    let rows = select_daily_rows(conn, cutoff.as_deref())?;
    let mut by_session: HashMap<(String, String), (Bucket, String)> = HashMap::new();
    for (_day, agent, model, project, sid, i, o, cr, cw, official, internal, cw1h) in rows {
        if official || internal || sid.is_empty() {
            continue;
        }
        let sid_key = sid.clone();
        let entry = by_session
            .entry((agent, sid))
            .or_insert_with(|| (Bucket::default(), project.clone()));
        if entry.1.is_empty() && !project.is_empty() {
            entry.1 = project;
        }
        entry.0.add(
            &model,
            &sid_key,
            TokenAcc {
                input: i as u64,
                output: o as u64,
                cache_read: cr as u64,
                cache_write: cw as u64,
                cache_write_1h: cw1h as u64,
            },
        );
    }
    let mut ranked: Vec<(f64, UsageTopSessionDto)> = by_session
        .into_iter()
        .filter_map(|((agent, session_id), (bucket, project_path))| {
            let (cost_usd, cost_partial) = bucket.cost(table);
            cost_usd.map(|cost| {
                (
                    cost,
                    UsageTopSessionDto {
                        title: None,
                        tokens: bucket.tokens.input + bucket.tokens.output,
                        cost_usd: Some(cost),
                        cost_partial,
                        agent,
                        session_id,
                        project_path,
                    },
                )
            })
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.1.tokens.cmp(&a.1.tokens))
            .then(a.1.agent.cmp(&b.1.agent))
            .then(a.1.session_id.cmp(&b.1.session_id))
    });
    ranked.truncate(5);
    Ok(ranked
        .into_iter()
        .map(|(_, mut row)| {
            // 红线：标题出站前必须脱敏（用户可能在自定义标题里粘过密钥），同 redact_session_meta 口径
            row.title = session_custom_title(conn, &row.agent, &row.session_id)
                .map(|t| crate::sessions::redact_sensitive_text(&t));
            row
        })
        .collect())
}

/// 设置页「自定义定价」的待补清单：用量里出现过、但三层价目都查不到价的模型。
/// 用户此前只能对着「≥ / ~」猜是哪个模型没价（2026-10-17）。订阅额度（official）不计费，不列
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnpricedModelDto {
    pub model: String,
    /// 四类 token 合计（只用于排序与让用户判断值不值得补）
    pub tokens: u64,
    pub last_day: String,
}

fn unpriced_models(conn: &Connection, chain: &PriceChain) -> Result<Vec<UnpricedModelDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT model, SUM(input + output + cache_read + cache_write), MAX(day)
             FROM usage_daily WHERE official = 0 AND model <> '' GROUP BY model",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out: Vec<UnpricedModelDto> = rows
        .flatten()
        .filter(|(model, tokens, _)| *tokens > 0 && price_of(model, chain).is_none())
        .map(|(model, tokens, last_day)| UnpricedModelDto {
            model,
            tokens: tokens.max(0) as u64,
            last_day,
        })
        .collect();
    out.sort_by(|a, b| b.tokens.cmp(&a.tokens).then_with(|| a.model.cmp(&b.model)));
    out.truncate(30);
    Ok(out)
}

#[tauri::command]
pub async fn usage_unpriced_models() -> Result<Vec<UnpricedModelDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = usage_db()?;
        let (chain, _) = pricing_table_and_rate();
        unpriced_models(&conn, &chain)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 设置页每行自定义价下面那句「不填时按什么价算 · 用量里命中哪些模型」（2026-11-07 用户：自定义定价太简陋，
/// 填的时候看不到自己在盖掉什么、会管到哪些模型）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PricingPreviewDto {
    pub prefix: String,
    /// 没有这一行时按什么价算（美元 / 每百万 token）；None = 内置与公共库都查不到
    pub base: Option<PricingBaseDto>,
    /// 用量里会被这个前缀管到的模型，按 token 多少排，最多 5 个
    pub matched: Vec<UnpricedModelDto>,
    pub matched_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PricingBaseDto {
    pub input: f64,
    pub output: f64,
    /// 缓存读 / 写价（数据源没给的已按输入价折算）：「照这个价改」一并带入，自定义一行不丢原有缓存价
    pub cache_read: f64,
    pub cache_write: f64,
    /// builtin = 内置价目，db = 公共模型库
    pub source: String,
}

fn pricing_preview_from(conn: &Connection, prefixes: &[String], chain: &PriceChain) -> Result<Vec<PricingPreviewDto>, String> {
    use crate::model_registry::model_key;
    let mut stmt = conn
        .prepare(
            "SELECT model, SUM(input + output + cache_read + cache_write), MAX(day)
             FROM usage_daily WHERE official = 0 AND model <> '' GROUP BY model",
        )
        .map_err(|e| e.to_string())?;
    let mut used: Vec<UnpricedModelDto> = stmt
        .query_map([], |row| {
            Ok(UnpricedModelDto {
                model: row.get(0)?,
                tokens: row.get::<_, i64>(1)?.max(0) as u64,
                last_day: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|m| m.tokens > 0)
        .collect();
    used.sort_by(|a, b| b.tokens.cmp(&a.tokens).then_with(|| a.model.cmp(&b.model)));
    // 不算用户层：要说的是「没有自定义时」的价
    let base_chain: PriceChain = [chain[0].clone(), chain[1].clone(), Vec::new()];
    Ok(prefixes
        .iter()
        .map(|prefix| {
            let key = model_key(prefix);
            let base = (!key.is_empty())
                .then(|| price_with_layer(prefix, &base_chain))
                .flatten()
                .map(|(p, layer)| PricingBaseDto {
                    input: p.input,
                    output: p.output,
                    cache_read: p.cache_read,
                    cache_write: p.cache_write,
                    source: if layer == 0 { "builtin" } else { "db" }.into(),
                });
            let hits: Vec<&UnpricedModelDto> = if key.is_empty() {
                Vec::new()
            } else {
                used.iter().filter(|m| model_key(&m.model).starts_with(&key)).collect()
            };
            PricingPreviewDto {
                prefix: prefix.clone(),
                base,
                matched_count: hits.len(),
                matched: hits.into_iter().take(5).cloned().collect(),
            }
        })
        .collect())
}

#[tauri::command]
pub async fn usage_pricing_preview(prefixes: Vec<String>) -> Result<Vec<PricingPreviewDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = usage_db()?;
        let (chain, _) = pricing_table_and_rate();
        pricing_preview_from(&conn, &prefixes, &chain)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 一批模型的输入单价（美元 / 百万 token，与用量页算费同一条定价链）；查不到的不出现在结果里。
/// 网关库「一键配置各 CLI」靠它认同家的轻量型号（gpt-6-luna 这类名字里没有 mini / flash 的）
#[tauri::command]
pub async fn model_input_prices(models: Vec<String>) -> Result<std::collections::HashMap<String, f64>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (chain, _) = pricing_table_and_rate();
        Ok(input_prices(&models, &chain))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn input_prices(models: &[String], chain: &PriceChain) -> std::collections::HashMap<String, f64> {
    models
        .iter()
        .filter_map(|m| price_of(m, chain).map(|(input, _)| (m.clone(), input)))
        .collect()
}

fn pricing_table_and_rate() -> (PriceChain, f64) {
    let pricing_path = crate::dirs::config_dir().map(|d| d.join("ccode").join("pricing.json"));
    (
        load_pricing(pricing_path.as_deref()),
        load_rate(pricing_path.as_deref()),
    )
}

#[tauri::command]
pub async fn usage_trend(range: String) -> Result<UsageTrendDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = usage_db()?;
        let (table, rate) = pricing_table_and_rate();
        usage_trend_from(&conn, &range, Local::now().date_naive(), &table, rate)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn top_sessions(range: String) -> Result<Vec<UsageTopSessionDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = usage_db()?;
        let (table, _) = pricing_table_and_rate();
        top_sessions_from(&conn, &range, Local::now().date_naive(), &table)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== 活跃度热力图（全历史非零日序列） =====

/// 活跃度热力图的单日行：四列主量只计非 internal（计费+官方订阅都在内，订阅日也是
/// 真实使用）；internal/official 作为并列子计量出站，前端「显示内部活动」开关只做
/// 展示层合成，永不进格子着色与连续天数。official_tokens/internal_tokens 是四类
/// 合计，与四列主量同量纲（注意与 cards 的输入+输出口径不同，tooltip 文案已披露）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageActivityDayDto {
    /// 本机时区日期 YYYY-MM-DD（与 usage_daily 落库同口径）；只出现有行的天，年份窗口零填由前端做
    pub day: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// 当天有用量行的非 internal 不重复会话数（官方订阅会话计入）
    pub sessions: u32,
    /// 其中官方订阅份额（四类合计）：tooltip 注记用，不参与计费
    pub official_tokens: u64,
    /// 内部活动四类合计：仅开关打开时 tooltip 注记
    pub internal_tokens: u64,
    pub internal_sessions: u32,
    /// 当天可计费行费用（官方/内部不计）：与 usage_trend 同口径，
    /// 无可计费行记 Some(0.0)、有但全未计价保持 None（前端显示 ~）
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageActivityDto {
    /// 查询时刻的本机日期：前端年份窗口与「今天」宽限的唯一今天出处（跨午夜由前端重算）
    pub today: String,
    /// 最早有记录的日子；空库为 None（前端据此收敛年份翻页下界与全库空判定）
    pub first_day: Option<String>,
    /// 升序全历史非零日（翻年/streak/开关全部前端推导，零重查）
    pub days: Vec<UsageActivityDayDto>,
    /// 增量索引刷新失败但返回了已建索引数据时为 true（前端出一行警示）
    pub stale: bool,
    /// 冷启动兜底：重建超预算仍在后台跑、先返回了库里现有数据（2026-10-15）——
    /// 后台刷完会发 usage-activity-refreshed 事件，前端补拉后自动变新
    pub refreshing: bool,
}

/// 查询本体（注入 today 供测试）：token/会话主查询按 PK 最左列 GROUP BY day 索引有序扫；
/// 费用必须按 (day, model) 粒度走 Bucket::cost 计价链（跨模型合计无法还原费用），
/// 与 build_stats 的 by_day_billed 同形
fn usage_activity_from(
    conn: &Connection,
    today: NaiveDate,
    table: &PriceChain,
) -> Result<UsageActivityDto, String> {
    let today_str = today.format("%Y-%m-%d").to_string();
    #[allow(clippy::type_complexity)]
    let mut stmt = conn
        .prepare(
            "SELECT day,
               SUM(CASE WHEN internal=0 THEN input ELSE 0 END),
               SUM(CASE WHEN internal=0 THEN output ELSE 0 END),
               SUM(CASE WHEN internal=0 THEN cache_read ELSE 0 END),
               SUM(CASE WHEN internal=0 THEN cache_write ELSE 0 END),
               SUM(CASE WHEN internal=0 AND official=1
                        THEN input+output+cache_read+cache_write ELSE 0 END),
               SUM(CASE WHEN internal=1
                        THEN input+output+cache_read+cache_write ELSE 0 END),
               COUNT(DISTINCT CASE WHEN internal=0 THEN session_id END),
               COUNT(DISTINCT CASE WHEN internal=1 THEN session_id END)
             FROM usage_daily
             WHERE day <> '' AND day <= ?1
             GROUP BY day ORDER BY day",
        )
        .map_err(|e| e.to_string())?;
    type MainRow = (
        String,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
    );
    let main_rows: Vec<MainRow> = stmt
        .query_map(params![today_str], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, i64>(8)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    // 可计费行（非官方非内部）按天按模型聚合后走既有计价链
    let mut cost_stmt = conn
        .prepare(
            "SELECT day, model, SUM(input), SUM(output), SUM(cache_read), SUM(cache_write), SUM(cache_write_1h)
             FROM usage_daily
             WHERE day <> '' AND day <= ?1 AND internal=0 AND official=0
             GROUP BY day, model",
        )
        .map_err(|e| e.to_string())?;
    let cost_rows: Vec<(String, String, i64, i64, i64, i64, i64)> = cost_stmt
        .query_map(params![today_str], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    let mut by_day_billed: std::collections::BTreeMap<String, Bucket> = Default::default();
    for (day, model, i, o, cr, cw, cw1h) in cost_rows {
        by_day_billed.entry(day).or_default().add(
            &model,
            "",
            TokenAcc {
                input: i as u64,
                output: o as u64,
                cache_read: cr as u64,
                cache_write: cw as u64,
                cache_write_1h: cw1h as u64,
            },
        );
    }
    let days: Vec<UsageActivityDayDto> = main_rows
        .into_iter()
        .map(
            |(day, input, output, cache_read, cache_write, official_tokens, internal_tokens, sessions, internal_sessions)| {
                let billed = by_day_billed.remove(&day).unwrap_or_default();
                let (cost_usd, cost_partial) = billed.cost(table);
                UsageActivityDayDto {
                    day,
                    input: input.max(0) as u64,
                    output: output.max(0) as u64,
                    cache_read: cache_read.max(0) as u64,
                    cache_write: cache_write.max(0) as u64,
                    sessions: sessions.max(0) as u32,
                    official_tokens: official_tokens.max(0) as u64,
                    internal_tokens: internal_tokens.max(0) as u64,
                    internal_sessions: internal_sessions.max(0) as u32,
                    // 与 usage_trend 同口径：当天没有任何可计费行（空天/纯订阅）记 0；
                    // 有可计费行但全未计价保持 None（前端显示 ~）
                    cost_usd: if billed.by_model.is_empty() {
                        Some(0.0)
                    } else {
                        cost_usd
                    },
                    cost_partial,
                }
            },
        )
        .collect();
    Ok(UsageActivityDto {
        today: today_str,
        first_day: days.first().map(|d| d.day.clone()),
        days,
        stale: false,
        refreshing: false,
    })
}

/// usage_activity 等增量索引的预算：稳态（进程内文件缓存热、marker 全命中）几十毫秒
/// 内完成；冷启动全量扫描（约三千个会话文件）要几秒。超预算先返回库里现有数据，
/// 重建继续在后台跑、成功后发事件让前端补拉——图先出来，几秒内自动变新。
const USAGE_REBUILD_BUDGET_MS: u64 = 800;

/// 冷启动兜底的后台重建是否已在跑：在跑就不再叠一个（排队等锁只会白占阻塞线程、
/// 攒出发射事件的风暴——2026-10-15 实证：无此闸时事件→补拉→再超时→再发事件
/// 会自激成环，后端被打满、sessions/projects 全饿死）。完成通知由先起的那次负责。
static USAGE_REBUILD_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 早退等结果的调用方计数：事件不能只看发起方是否超时离开——IN_FLIGHT 早退方
/// 不拥有任何通知渠道，若那次重建快于预算，send 成功、事件不发，早退方的
/// refreshing 永无终点（2026-10-16 复审坐实）。重建完成时据此计数补发。
static USAGE_REBUILD_WAITERS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// 活跃度热力图数据。三段式（2026-10-15 拍板 + 2026-10-16 复审修订）：
/// ① 先查旧数（冷库也查得动，前端先有图）；② 预算内（USAGE_REBUILD_BUDGET_MS）
/// 重建完成 → **重查一次再返回**——等待成本已付，重查只是毫秒级聚合，这样快路径
/// 仍兑现「先索引后查询」（否则隔夜外部会话被静默吞掉、且与同屏 agents 矩阵口径
/// 自相矛盾）；③ 超预算 → 先回旧数（refreshing=true），后台刷完发
/// usage-activity-refreshed 前端补拉（每个旧数周期最多自动补拉一次，环不可能成形）。
/// 索引刷新失败不阻断查询：快路径 stale=true 前端出警示；慢失败也发事件，让前端
/// 仅一次的补拉去命中快失败路径把警示浮出来（失败不再因慢而静默）。
#[tauri::command]
pub async fn usage_activity(app: tauri::AppHandle) -> Result<UsageActivityDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dto = {
            let conn = usage_db()?;
            let (table, _) = pricing_table_and_rate();
            usage_activity_from(&conn, Local::now().date_naive(), &table)?
        };
        // 已有后台重建在跑：本调用必然拿不到快结果，登记等待后先出旧数，
        // 在跑的那次完成时会按等待计数补发事件
        if USAGE_REBUILD_IN_FLIGHT.swap(true, std::sync::atomic::Ordering::SeqCst) {
            USAGE_REBUILD_WAITERS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            dto.refreshing = true;
            return Ok(dto);
        }
        let (done_tx, done_rx) = std::sync::mpsc::channel::<bool>();
        tauri::async_runtime::spawn_blocking(move || {
            let failed = rebuild_locked().is_err();
            USAGE_REBUILD_IN_FLIGHT.store(false, std::sync::atomic::Ordering::SeqCst);
            // 通道传「失败与否」——接收端直接赋 dto.stale，两端语义必须同名同向
            //（首版传 is_ok() 接收端当 is_err() 用，重建越成功越报「索引刷新失败」，
            //  2026-10-16 用户实证）
            let waiters = USAGE_REBUILD_WAITERS.swap(0, std::sync::atomic::Ordering::SeqCst);
            // 发事件的三种情形任一即发：发起方超时离开（send 失败）/ 有早退等待者 /
            // 重建失败（慢失败不再静默——前端仅一次的补拉会命中快失败路径报 stale）。
            // 快路径（send 成功、无等待者、未失败）绝不发：事件风暴的闸保持原样
            if done_tx.send(failed).is_err() || waiters > 0 || failed {
                let _ = app.emit("usage-activity-refreshed", ());
            }
        });
        match done_rx.recv_timeout(std::time::Duration::from_millis(
            USAGE_REBUILD_BUDGET_MS,
        )) {
            // 预算内刷完：重查一次（恢复「先索引后查询」，重建扫进的新数据不丢）；
            // 重查本身失败才回落旧数并显性置 stale（fail-visible 不静默）
            Ok(rebuild_failed) => {
                let requery = usage_db().and_then(|conn| {
                    let (table, _) = pricing_table_and_rate();
                    usage_activity_from(&conn, Local::now().date_naive(), &table)
                });
                match requery {
                    Ok(fresh) => {
                        dto = fresh;
                        dto.stale = rebuild_failed;
                    }
                    Err(_) => dto.stale = true,
                }
            }
            // 超预算：立刻弃守接收端（事件已由等待计数兜底，不再依赖 send 失败），
            // 先出旧数，后台还在刷（不是失败，不占用 stale 警示位）
            Err(_) => {
                drop(done_rx);
                dto.refreshing = true;
            }
        }
        Ok(dto)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== 活跃度二期：点格下钻与按 agent 拆分 =====

/// 按 agent 的单日分解（四类合计；非 internal）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDayAgentRowDto {
    pub agent: String,
    pub tokens: u64,
    pub sessions: u32,
}

/// 点格下钻的当日会话行：标题出站前已过 redact_sensitive_text（top_sessions 同口径），
/// 无自定义名为 None，前端回落扫描标题/短 id
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDaySessionDto {
    pub agent: String,
    pub session_id: String,
    pub title: Option<String>,
    pub project_path: String,
    /// 四类合计
    pub tokens: u64,
    pub official: bool,
    pub internal: bool,
    /// 仅可计费会话有估算费用；订阅/内部会话为 None（前端显示「订阅」/不显示）
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDayDetailDto {
    pub day: String,
    /// 当日总量（与热力图格同口径，含 official/internal 子计量）
    pub totals: UsageActivityDayDto,
    /// 按 agent 四类合计（非 internal，tokens 降序）
    pub by_agent: Vec<UsageDayAgentRowDto>,
    /// 当日会话（四类合计降序，internal 沉底；前端按「显示内部活动」滤）
    pub sessions: Vec<UsageDaySessionDto>,
}

/// 单日明细：一条查询取当日全部行，总量/分解/会话列表在 Rust 侧聚合
fn usage_day_detail_from(
    conn: &Connection,
    day: &str,
    table: &PriceChain,
) -> Result<UsageDayDetailDto, String> {
    let mut stmt = conn
        .prepare(
            "SELECT agent, model, project_path, session_id, input, output, cache_read, cache_write, internal, official,
                    cache_write_1h
             FROM usage_daily WHERE day = ?1",
        )
        .map_err(|e| e.to_string())?;
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, String, String, i64, i64, i64, i64, bool, bool, i64)> = stmt
        .query_map(params![day], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, i64>(8)? != 0,
                r.get::<_, i64>(9)? != 0,
                r.get::<_, i64>(10)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;

    let mut totals_input = 0u64;
    let mut totals_output = 0u64;
    let mut totals_cache_read = 0u64;
    let mut totals_cache_write = 0u64;
    let mut main_sessions: HashSet<String> = HashSet::new();
    let mut internal_sessions: HashSet<String> = HashSet::new();
    let mut official_tokens = 0u64;
    let mut internal_tokens = 0u64;
    let mut billed_day = Bucket::default();
    // (agent, sid) → 四类合计 + 项目路径 + 标志；可计费会话另有按模型分桶算费用
    #[derive(Default)]
    struct SessionAgg {
        tokens: u64,
        project: String,
        official: bool,
        internal: bool,
        cost: std::collections::HashMap<String, TokenAcc>,
    }
    let mut by_session: std::collections::BTreeMap<(String, String), SessionAgg> = Default::default();
    let mut by_agent_tokens: HashMap<String, u64> = HashMap::new();
    let mut by_agent_sessions: HashMap<String, HashSet<String>> = HashMap::new();

    for (agent, model, project, sid, i, o, cr, cw, internal, official, cw1h) in rows {
        let acc = TokenAcc {
            input: i as u64,
            output: o as u64,
            cache_read: cr as u64,
            cache_write: cw as u64,
            cache_write_1h: cw1h as u64,
        };
        let four = acc.input + acc.output + acc.cache_read + acc.cache_write;
        let entry = by_session.entry((agent.clone(), sid.clone())).or_default();
        entry.tokens += four;
        if entry.project.is_empty() && !project.is_empty() {
            entry.project = project;
        }
        entry.official |= official;
        entry.internal |= internal;
        if internal {
            internal_tokens += four;
            internal_sessions.insert(sid.clone());
        } else {
            totals_input += acc.input;
            totals_output += acc.output;
            totals_cache_read += acc.cache_read;
            totals_cache_write += acc.cache_write;
            main_sessions.insert(sid.clone());
            if official {
                official_tokens += four;
            } else {
                billed_day.add(&model, &sid, acc);
            }
            *by_agent_tokens.entry(agent.clone()).or_insert(0) += four;
            by_agent_sessions
                .entry(agent.clone())
                .or_default()
                .insert(sid.clone());
        }
        if !internal && !official {
            if let Some(e) = by_session.get_mut(&(agent, sid)) {
                let m = e.cost.entry(model).or_default();
                m.input += acc.input;
                m.output += acc.output;
                m.cache_read += acc.cache_read;
                m.cache_write += acc.cache_write;
        m.cache_write_1h += acc.cache_write_1h;
            }
        }
    }

    let mut by_agent: Vec<UsageDayAgentRowDto> = by_agent_tokens
        .into_iter()
        .map(|(agent, tokens)| UsageDayAgentRowDto {
            agent: agent.clone(),
            tokens,
            sessions: by_agent_sessions.remove(&agent).map(|s| s.len() as u32).unwrap_or(0),
        })
        .collect();
    by_agent.sort_by(|a, b| b.tokens.cmp(&a.tokens).then(a.agent.cmp(&b.agent)));

    let mut main_rows: Vec<((u64, String, String), SessionAgg)> = Vec::new();
    let mut internal_rows: Vec<((u64, String, String), SessionAgg)> = Vec::new();
    for ((agent, sid), agg) in by_session {
        let key = (agg.tokens, agent, sid);
        if agg.internal {
            internal_rows.push((key, agg));
        } else {
            main_rows.push((key, agg));
        }
    }
    main_rows.sort_by(|a, b| b.0.cmp(&a.0));
    internal_rows.sort_by(|a, b| b.0.cmp(&a.0));
    let mut sessions: Vec<UsageDaySessionDto> = main_rows
        .into_iter()
        .chain(internal_rows)
        .map(|((tokens, agent, sid), agg)| {
            let (cost_usd, cost_partial) = if agg.internal || agg.official {
                (None, false)
            } else {
                let mut bucket = Bucket::default();
                for (model, acc) in &agg.cost {
                    bucket.add(model, "", *acc);
                }
                bucket.cost(table)
            };
            UsageDaySessionDto {
                title: session_custom_title(conn, &agent, &sid),
                agent,
                session_id: sid,
                project_path: agg.project,
                tokens,
                official: agg.official,
                internal: agg.internal,
                cost_usd,
                cost_partial,
            }
        })
        .collect();
    sessions.truncate(LIST_CAP);

    let (cost_usd, cost_partial) = billed_day.cost(table);
    Ok(UsageDayDetailDto {
        day: day.to_string(),
        totals: UsageActivityDayDto {
            day: day.to_string(),
            input: totals_input,
            output: totals_output,
            cache_read: totals_cache_read,
            cache_write: totals_cache_write,
            sessions: main_sessions.len() as u32,
            official_tokens,
            internal_tokens,
            internal_sessions: internal_sessions.len() as u32,
            cost_usd: if billed_day.by_model.is_empty() {
                Some(0.0)
            } else {
                cost_usd
            },
            cost_partial,
        },
        by_agent,
        sessions,
    })
}

/// 点格下钻：当日总量 + 按 agent 分解 + 会话列表（前端可直跳结构化会话视图）。
/// 不触发增量索引——进页时 usage_activity 已跑过，同一次浏览内点格不该重复付这笔钱
#[tauri::command]
pub async fn usage_day_detail(day: String) -> Result<UsageDayDetailDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = usage_db()?;
        let (table, _) = pricing_table_and_rate();
        usage_day_detail_from(&conn, &day, &table)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 按 agent 拆分的年矩阵（筛选胶囊用）：某年每天每 agent 的四类合计（非 internal）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageActivityAgentsDayDto {
    pub day: String,
    /// tokens 降序
    pub by_agent: Vec<UsageDayAgentRowDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageActivityAgentsDto {
    pub year: i32,
    /// 该年出现过的非 internal agent（按年总量降序）
    pub agents: Vec<String>,
    /// 只含有数据的天（升序）
    pub days: Vec<UsageActivityAgentsDayDto>,
}

fn usage_activity_agents_from(
    conn: &Connection,
    year: i32,
    today: NaiveDate,
) -> Result<UsageActivityAgentsDto, String> {
    let start = format!("{year:04}-01-01");
    let end_today = today.format("%Y-%m-%d").to_string();
    let end = if end_today > format!("{year:04}-12-31") {
        format!("{year:04}-12-31")
    } else {
        end_today
    };
    let mut stmt = conn
        .prepare(
            "SELECT day, agent, SUM(input+output+cache_read+cache_write), COUNT(DISTINCT session_id)
             FROM usage_daily
             WHERE day >= ?1 AND day <= ?2 AND internal = 0
             GROUP BY day, agent ORDER BY day",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, i64, i64)> = stmt
        .query_map(params![start, end], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    let mut by_day: std::collections::BTreeMap<String, Vec<UsageDayAgentRowDto>> = Default::default();
    let mut year_totals: HashMap<String, u64> = HashMap::new();
    for (day, agent, tokens, sessions) in rows {
        let tokens = tokens.max(0) as u64;
        *year_totals.entry(agent.clone()).or_insert(0) += tokens;
        by_day.entry(day).or_default().push(UsageDayAgentRowDto {
            agent,
            tokens,
            sessions: sessions.max(0) as u32,
        });
    }
    let mut agents: Vec<String> = year_totals.keys().cloned().collect();
    agents.sort_by(|a, b| {
        year_totals
            .get(b)
            .unwrap_or(&0)
            .cmp(year_totals.get(a).unwrap_or(&0))
            .then(a.cmp(b))
    });
    let mut days: Vec<UsageActivityAgentsDayDto> = by_day
        .into_iter()
        .map(|(day, mut rows)| {
            rows.sort_by(|a, b| b.tokens.cmp(&a.tokens).then(a.agent.cmp(&b.agent)));
            UsageActivityAgentsDayDto { day, by_agent: rows }
        })
        .collect();
    days.sort_by(|a, b| a.day.cmp(&b.day));
    Ok(UsageActivityAgentsDto { year, agents, days })
}

/// 按 agent 拆分的年矩阵：与热力图同页取数（进页/翻年/刷新时各一次，切胶囊纯前端过滤）
#[tauri::command]
pub async fn usage_activity_agents(year: i32) -> Result<UsageActivityAgentsDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = usage_db()?;
        usage_activity_agents_from(&conn, year, Local::now().date_naive())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests;

// ===== 按网关归因：usage_daily ⋈ session_meta.profile_id ⋈ binding.gateway_id =====

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayUsageRow {
    pub gateway_id: String,
    pub gateway_name: String,
    pub bucket: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
    pub session_count: u64,
    pub agents: Vec<String>,
}

fn usage_by_gateway_impl(
    conn: &Connection,
    range: &str,
    bindings: &[crate::profiles::Binding],
    gateways: &[crate::profiles::Gateway],
) -> Result<Vec<GatewayUsageRow>, String> {
    let sql = match cutoff_day(range) {
        Some(_) => "SELECT d.agent, d.model, d.session_id, d.input, d.output, d.cache_read, d.cache_write, d.official,
                           m.profile_id, d.cache_write_1h
                    FROM usage_daily d
                    LEFT JOIN session_meta m ON m.agent = d.agent AND m.session_id = d.session_id
                    WHERE d.day >= ?1",
        None => "SELECT d.agent, d.model, d.session_id, d.input, d.output, d.cache_read, d.cache_write, d.official,
                        m.profile_id, d.cache_write_1h
                 FROM usage_daily d
                 LEFT JOIN session_meta m ON m.agent = d.agent AND m.session_id = d.session_id",
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let cutoff = cutoff_day(range);
    let map_row = |r: &rusqlite::Row| -> rusqlite::Result<(
        String,
        String,
        String,
        i64,
        i64,
        i64,
        i64,
        i64,
        Option<String>,
        i64,
    )> {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
            r.get(7)?,
            r.get(8)?,
            r.get(9)?,
        ))
    };
    let rows: Vec<_> = match &cutoff {
        Some(c) => stmt
            .query_map(params![c], map_row)
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?,
        None => stmt
            .query_map([], map_row)
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?,
    };
    let bind_by_id: HashMap<&str, &crate::profiles::Binding> =
        bindings.iter().map(|b| (b.id.as_str(), b)).collect();
    let gw_by_id: HashMap<&str, &crate::profiles::Gateway> =
        gateways.iter().map(|g| (g.id.as_str(), g)).collect();

    #[derive(Default)]
    struct Acc {
        bucket: Bucket,
        agents: HashSet<String>,
        name: String,
        kind: String,
        gid: String,
    }
    let mut accs: HashMap<String, Acc> = HashMap::new();
    for (agent, model, session_id, input, output, cr, cw, official, profile_id, cw1h) in rows {
        let official_row = official != 0;
        let (key, name, kind, gid) = if official_row {
            (
                "official".to_string(),
                "官方订阅".to_string(),
                "official".to_string(),
                String::new(),
            )
        } else {
            match profile_id.as_deref().filter(|s| !s.is_empty()) {
                None => (
                    "unlinked".into(),
                    "未关联".into(),
                    "unlinked".into(),
                    String::new(),
                ),
                Some(pid) => match bind_by_id.get(pid) {
                    None => (
                        "unlinked".into(),
                        "未关联".into(),
                        "unlinked".into(),
                        String::new(),
                    ),
                    Some(b) if b.kind == crate::profiles::BindingKind::Official => (
                        "official".into(),
                        "官方订阅".into(),
                        "official".into(),
                        String::new(),
                    ),
                    Some(b) => match b.gateway_id.as_deref() {
                        None => (
                            "unlinked".into(),
                            "未关联".into(),
                            "unlinked".into(),
                            String::new(),
                        ),
                        Some(id) if gw_by_id.contains_key(id) => {
                            let n = gw_by_id.get(id).map(|g| g.name.clone()).unwrap_or_default();
                            (id.to_string(), n, "gateway".into(), id.to_string())
                        }
                        Some(id) => {
                            let short: String = id
                                .chars()
                                .filter(|c| c.is_ascii_hexdigit())
                                .take(8)
                                .collect();
                            (
                                format!("deleted:{id}"),
                                format!("已删除网关 · {short}"),
                                "deleted".into(),
                                id.to_string(),
                            )
                        }
                    },
                },
            }
        };
        let e = accs.entry(key).or_insert_with(|| Acc {
            name,
            kind,
            gid,
            ..Default::default()
        });
        e.agents.insert(agent);
        e.bucket.add(
            &model,
            &session_id,
            TokenAcc {
                input: input as u64,
                output: output as u64,
                cache_read: cr as u64,
                cache_write: cw as u64,
                cache_write_1h: cw1h as u64,
            },
        );
    }
    let table = load_pricing(None);
    let mut out: Vec<GatewayUsageRow> = accs
        .into_iter()
        .map(|(_, a)| {
            let (cost_usd, cost_partial) = a.bucket.cost(&table);
            let mut agents: Vec<String> = a.agents.into_iter().collect();
            agents.sort();
            GatewayUsageRow {
                gateway_id: a.gid,
                gateway_name: a.name,
                bucket: a.kind,
                tokens_in: a.bucket.tokens.input,
                tokens_out: a.bucket.tokens.output,
                cost_usd,
                cost_partial,
                session_count: a.bucket.sessions.len() as u64,
                agents,
            }
        })
        .collect();
    out.sort_by(|a, b| (b.tokens_in + b.tokens_out).cmp(&(a.tokens_in + a.tokens_out)));
    Ok(out)
}

pub(crate) fn month_cost_usd_by_gateway() -> std::collections::HashMap<String, Option<f64>> {
    let bindings = crate::gateway_store::load_bindings().unwrap_or_default();
    let gateways = crate::gateway_store::load_gateways().unwrap_or_default();
    let Ok(conn) = usage_db() else {
        return Default::default();
    };
    let Ok(rows) = usage_by_gateway_impl(&conn, "month", &bindings, &gateways) else {
        return Default::default();
    };
    rows.into_iter()
        .filter(|r| r.bucket == "gateway")
        .map(|r| (r.gateway_id, r.cost_usd))
        .collect()
}

#[tauri::command]
pub async fn usage_by_gateway(range: String) -> Result<Vec<GatewayUsageRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = crate::profiles::ProfileStore::new().and_then(|s| s.list());
        let bindings = crate::gateway_store::load_bindings().unwrap_or_default();
        let gateways = crate::gateway_store::load_gateways().unwrap_or_default();
        let conn = usage_db()?;
        usage_by_gateway_impl(&conn, &range, &bindings, &gateways)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod gateway_usage_tests;

