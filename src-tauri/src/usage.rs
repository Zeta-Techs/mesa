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
const USAGE_SCHEMA_VERSION: &str = "9";
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
/// 那些用量已经记在上游文件名下，再算一遍就翻倍
fn claude_events<I, S>(lines: I, own: Option<&str>) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
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
        out.push(UsageEvent {
            day: get_str(&v, "timestamp").map(day_of_iso).unwrap_or_default(),
            model: get_str(msg, "model").unwrap_or("").to_string(),
            input: num("input_tokens"),
            output: num("output_tokens"),
            cache_read: num("cache_read_input_tokens"),
            cache_write: num("cache_creation_input_tokens"),
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        });
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
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        if get_str(&v, "type") != Some("usage.record") {
            continue;
        }
        let Some(u) = v.get("usage") else {
            continue;
        };
        let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        out.push(UsageEvent {
            day: v
                .get("time")
                .and_then(|t| t.as_i64())
                .map(day_of_ms)
                .unwrap_or_default(),
            model: get_str(&v, "model").unwrap_or("").to_string(),
            input: num("inputOther"),
            output: num("output"),
            cache_read: num("inputCacheRead"),
            cache_write: num("inputCacheCreation"),
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
    // 列级防御沿用 SELECT * + 按列名取索引（drizzle 迁移频繁，缺列给默认而不是报错）
    let Ok(mut stmt) =
        conn.prepare("SELECT * FROM message WHERE session_id=? ORDER BY time_created ASC")
    else {
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
        if get_str(&v, "role") != Some("assistant") {
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
        // modelID 为主；model 也可能是 {providerID,modelID} 对象
        let model = get_str(&v, "modelID")
            .map(String::from)
            .or_else(|| {
                v.get("model")
                    .and_then(|m| get_str(m, "modelID"))
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
                source: key.6,
                internal: key.7,
                official: key.8,
            });
            row.input += e.input;
            row.output += e.output;
            row.cache_read += e.cache_read;
            row.cache_write += e.cache_write;
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
        // v7→v8 只是 Grok 提取口径变了，v8→v9 只是 Codex / Gemini / Qwen 拆缓存：只清这几家能从会话文件重抽的行
        // （有 seen 标记）和它们的 seen 标记，其它 agent 已建好的日行留着，避免整库重解析；文件已不在的行重抽不回来，
        // 留着（用量历史永久保留）
        let partial: Option<&[&str]> = match current.as_deref() {
            Some("8") => Some(&["codex", "gemini", "qwen"]),
            Some("7") => Some(&["grok", "codex", "gemini", "qwen"]),
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
                                    input, output, cache_read, cache_write, source, internal, workspace, official)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(day, agent, model, project_path, session_id) DO UPDATE SET
               input=input+excluded.input, output=output+excluded.output,
               cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write",
            params![
                row.day, row.agent, row.model, row.project_path, row.session_id,
                row.input as i64, row.output as i64, row.cache_read as i64, row.cache_write as i64,
                row.source, i64::from(row.internal), row.workspace, i64::from(row.official),
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
                                        input, output, cache_read, cache_write, source, internal, workspace, official)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(day, agent, model, project_path, session_id) DO UPDATE SET
                   input=input+excluded.input, output=output+excluded.output,
                   cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write,
                   source=excluded.source, internal=excluded.internal, workspace=excluded.workspace,
                   official=excluded.official",
                params![
                    row.day, row.agent, row.model, row.project_path, row.session_id,
                    row.input as i64, row.output as i64, row.cache_read as i64, row.cache_write as i64,
                    row.source, i64::from(row.internal), row.workspace, i64::from(row.official),
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
type PriceChain = [Vec<(String, (f64, f64))>; 3];

fn load_pricing(override_path: Option<&Path>) -> PriceChain {
    let builtin: Vec<(String, (f64, f64))> = BUILTIN_PRICING
        .iter()
        .map(|(p, v)| (p.to_string(), *v))
        .collect();
    // 公共能力库层（models.dev/OpenRouter 下载快照，model-capabilities-db.json 的
    // cost 字段）：比内置表新、跟随数据源更新
    let db = crate::model_registry::db_price_table();
    let mut user: Vec<(String, (f64, f64))> = Vec::new();
    if let Some(path) = override_path {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(obj) = v.as_object() {
                    for (prefix, price) in obj {
                        // 空前缀会匹配一切模型名，视为配置错误直接忽略
                        if prefix.trim().is_empty() {
                            continue;
                        }
                        if let Some(pair) = price.as_array() {
                            if pair.len() == 2 {
                                if let (Some(i), Some(o)) = (pair[0].as_f64(), pair[1].as_f64()) {
                                    user.push((prefix.to_lowercase(), (i, o)));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    [builtin, db, user]
}

/// 单层内最长前缀命中
fn longest_price_in(table: &[(String, (f64, f64))], model: &str) -> Option<(f64, f64)> {
    table
        .iter()
        .filter(|(prefix, _)| model.starts_with(prefix.as_str()))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(_, price)| *price)
}

fn price_of(model: &str, chain: &PriceChain) -> Option<(f64, f64)> {
    // 中转/聚合的 provider 前缀（accounts/fireworks/models/x、zetatechs/x）剥掉，按末段模型名匹配
    let model = model.rsplit('/').next().unwrap_or(model).to_lowercase();
    // 高层先问：用户覆盖 > 公共库 > 内置
    for layer in chain.iter().rev() {
        if let Some(p) = longest_price_in(layer, &model) {
            return Some(p);
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
}

/// cache_read 按输入价 1 折算；cache_write 按输入全价（spec 未定义，取保守全价）
fn cost_of(acc: &TokenAcc, price: (f64, f64)) -> f64 {
    let (ir, or_) = price;
    (acc.input as f64 * ir
        + acc.output as f64 * or_
        + acc.cache_read as f64 * ir * 0.1
        + acc.cache_write as f64 * ir)
        / 1_000_000.0
}

/// 缓存读相对「按输入全价」省下的钱：实际按 1 折计，省 9 折。无定价或 0 读则 None。
fn cache_savings_usd(model: &str, cache_read: u64, chain: &PriceChain) -> Option<f64> {
    if cache_read == 0 {
        return None;
    }
    price_of(model, chain).map(|(ir, _)| cache_read as f64 * ir * 0.9 / 1_000_000.0)
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
        self.sessions.insert(session_id.to_string());
        let m = self.by_model.entry(model.to_string()).or_default();
        m.input += acc.input;
        m.output += acc.output;
        m.cache_read += acc.cache_read;
        m.cache_write += acc.cache_write;
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
            match price_of(model, table) {
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
    for (_day, agent, model, project, sid, i, o, cr, cw, source, internal, workspace, official) in
        rows
    {
        let acc = TokenAcc {
            input: i as u64,
            output: o as u64,
            cache_read: cr as u64,
            cache_write: cw as u64,
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
                    source, internal, workspace, official
             FROM usage_daily WHERE day >= ?1",
            Some(c),
        ),
        None => (
            "SELECT day, agent, model, project_path, session_id, input, output, cache_read, cache_write,
                    source, internal, workspace, official
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
    let pricing_path = dirs::config_dir().map(|d| d.join("ccode").join("pricing.json"));
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
            "SELECT model, SUM(input), SUM(output), SUM(cache_read), SUM(cache_write)
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
            ))
        })
        .map_err(|e| e.to_string())?;
    let pricing = load_pricing(None);
    let mut out = SessionUsageDto::default();
    for row in rows {
        let (model, i, o, cr, cw) = row.map_err(|e| e.to_string())?;
        out.input += i as u64;
        out.output += o as u64;
        out.cache_read += cr as u64;
        out.cache_write += cw as u64;
        if let Some(price) = price_of(&model, &pricing) {
            out.priced = true;
            out.cost_usd += cost_of(
                &TokenAcc {
                    input: i as u64,
                    output: o as u64,
                    cache_read: cr as u64,
                    cache_write: cw as u64,
                },
                price,
            );
        }
    }
    Ok(out)
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
);

fn select_daily_rows(
    conn: &Connection,
    cutoff: Option<&str>,
) -> Result<Vec<TrendQueryRow>, String> {
    let sql = if cutoff.is_some() {
        "SELECT day, agent, model, project_path, session_id, input, output, cache_read, cache_write, official, internal
         FROM usage_daily WHERE day >= ?1"
    } else {
        "SELECT day, agent, model, project_path, session_id, input, output, cache_read, cache_write, official, internal
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
    for (day, _agent, model, _project, sid, i, o, cr, cw, official, internal) in &rows {
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
    for (_day, agent, model, project, sid, i, o, cr, cw, official, internal) in rows {
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
#[derive(Debug, Clone, Serialize)]
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

fn pricing_table_and_rate() -> (PriceChain, f64) {
    let pricing_path = dirs::config_dir().map(|d| d.join("ccode").join("pricing.json"));
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
            "SELECT day, model, SUM(input), SUM(output), SUM(cache_read), SUM(cache_write)
             FROM usage_daily
             WHERE day <> '' AND day <= ?1 AND internal=0 AND official=0
             GROUP BY day, model",
        )
        .map_err(|e| e.to_string())?;
    let cost_rows: Vec<(String, String, i64, i64, i64, i64)> = cost_stmt
        .query_map(params![today_str], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    let mut by_day_billed: std::collections::BTreeMap<String, Bucket> = Default::default();
    for (day, model, i, o, cr, cw) in cost_rows {
        by_day_billed.entry(day).or_default().add(
            &model,
            "",
            TokenAcc {
                input: i as u64,
                output: o as u64,
                cache_read: cr as u64,
                cache_write: cw as u64,
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
            "SELECT agent, model, project_path, session_id, input, output, cache_read, cache_write, internal, official
             FROM usage_daily WHERE day = ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String, i64, i64, i64, i64, bool, bool)> = stmt
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

    for (agent, model, project, sid, i, o, cr, cw, internal, official) in rows {
        let acc = TokenAcc {
            input: i as u64,
            output: o as u64,
            cache_read: cr as u64,
            cache_write: cw as u64,
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
mod tests {
    use super::*;

    fn ev(day: &str, model: &str, input: u64, output: u64) -> UsageEvent {
        UsageEvent {
            day: day.into(),
            model: model.into(),
            input,
            output,
            cache_read: 0,
            cache_write: 0,
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        }
    }

    #[test]
    fn aggregate_groups_by_day_model_session() {
        let contribs = vec![
            SessionContrib {
                agent: "codex".into(),
                session_id: "s1".into(),
                project_path: "/p".into(),
                workspace: String::new(),
                events: vec![
                    ev("2026-07-01", "gpt-5", 10, 5),
                    ev("2026-07-01", "gpt-5", 20, 5),
                    ev("2026-07-02", "gpt-5", 1, 1),
                ],
            },
            SessionContrib {
                agent: "codex".into(),
                session_id: "s2".into(),
                project_path: "/p".into(),
                workspace: String::new(),
                events: vec![ev("2026-07-01", "gpt-5", 7, 3)],
            },
            SessionContrib {
                agent: "claude-code".into(),
                session_id: "s3".into(),
                project_path: "/p".into(),
                workspace: String::new(),
                events: vec![], // 无 usage 的会话不产生行
            },
        ];
        let rows = aggregate(&contribs);
        assert_eq!(rows.len(), 3, "(d1,s1)+(d1,s2)+(d2,s1) 三行");
        let d1s1 = rows
            .iter()
            .find(|r| r.day == "2026-07-01" && r.session_id == "s1")
            .unwrap();
        assert_eq!((d1s1.input, d1s1.output), (30, 10));
        let d2 = rows.iter().find(|r| r.day == "2026-07-02").unwrap();
        assert_eq!((d2.input, d2.session_id.as_str()), (1, "s1"));
    }

    #[test]
    fn aggregate_drops_events_without_day() {
        let contribs = vec![SessionContrib {
            agent: "kimi".into(),
            session_id: "s1".into(),
            project_path: "/p".into(),
            workspace: String::new(),
            events: vec![ev("", "kimi-k2", 10, 5), ev("2026-08-01", "kimi-k2", 1, 1)],
        }];
        let rows = aggregate(&contribs);
        assert_eq!(rows.len(), 1, "时间戳缺失的事件不得产出 day=\"\" 噪声行");
        assert_eq!(rows[0].day, "2026-08-01");
        assert_eq!((rows[0].input, rows[0].output), (1, 1));
    }

    #[test]
    fn seen_key_parse_roundtrips_new_format_only() {
        assert_eq!(
            parse_seen_key("seen:codex:s1:live"),
            Some(("codex".into(), "s1".into()))
        );
        assert_eq!(
            parse_seen_key("seen:claude-code:abc:snap"),
            Some(("claude-code".into(), "abc".into()))
        );
        // 旧格式（无来源后缀）与损坏键反解失败，避免误删其他会话的行
        assert_eq!(parse_seen_key("seen:codex:s1"), None);
        assert_eq!(parse_seen_key("seen:onlyone"), None);
        assert_eq!(parse_seen_key("other:x"), None);
    }

    #[test]
    fn opencode_events_streamed_from_db() {
        let dir = std::env::temp_dir().join(format!("ccode-usage-oc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("opencode.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);",
            )
            .unwrap();
            let rows = [
                ("m1", "s1", 1785307071000i64, r#"{"role":"user"}"#),
                (
                    "m2",
                    "s1",
                    1785307072000,
                    r#"{"role":"assistant","modelID":"grok-4","tokens":{"input":10,"output":5,"reasoning":2,"cache":{"read":3,"write":1}}}"#,
                ),
                (
                    "m3",
                    "s2",
                    1785307073000,
                    r#"{"role":"assistant","tokens":{"input":99,"output":9}}"#,
                ),
            ];
            for (id, sid, t, data) in rows {
                conn.execute(
                    "INSERT INTO message VALUES(?1,?2,?3,?4)",
                    params![id, sid, t, data],
                )
                .unwrap();
            }
        }
        let events = opencode_events(&db, "s1");
        assert_eq!(events.len(), 1, "只取本会话的 assistant 行");
        assert_eq!(events[0].day, day_of_ms(1785307072000));
        assert_eq!(
            (
                events[0].input,
                events[0].output,
                events[0].cache_read,
                events[0].cache_write
            ),
            (10, 7, 3, 1),
            "reasoning 计入输出侧"
        );
        assert_eq!(events[0].model, "grok-4");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pricing_override_ignores_empty_prefix() {
        let dir = std::env::temp_dir().join(format!("ccode-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("pricing.json");
        std::fs::write(&p, r#"{"": [9.0, 9.0], "relay-y": [0.5, 0.5]}"#).unwrap();
        let table = load_pricing(Some(&p));
        assert_eq!(
            price_of("totally-unknown-model", &table),
            None,
            "空前缀不得匹配一切模型"
        );
        assert_eq!(price_of("relay-y-x", &table), Some((0.5, 0.5)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn schema_reset_keeps_rows_that_cannot_be_rebuilt() {
        // 用户拍板：会话文件消失后用量留作历史账；表版本升级时只清能从文件重抽的行
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO usage_daily(day, agent, model, project_path, session_id, input, output, cache_read, cache_write, source, internal, workspace, official)
               VALUES('2026-08-01','claude-code','m','/p','alive',1,1,0,0,'cli',0,'',0),
                     ('2026-08-01','claude-code','m','/p','gone',2,2,0,0,'cli',0,'',0),
                     ('2026-10-17','codex','m','/tmp/ccode-ai-x','ephemeral-r1',3,3,0,0,'ccode-ai',1,'',0);
             INSERT INTO usage_meta(key, value) VALUES('seen:claude-code:alive:live','t');
             UPDATE usage_meta SET value='6' WHERE key='schema_version';",
        )
        .unwrap();
        ensure_usage_schema(&conn).unwrap();
        let mut ids: Vec<String> = conn
            .prepare("SELECT session_id FROM usage_daily ORDER BY session_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .flatten()
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["ephemeral-r1".to_string(), "gone".to_string()]);
    }

    #[test]
    fn usage_schema_migration_resets_unclassified_index() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_daily(
               day TEXT, agent TEXT, model TEXT, project_path TEXT, session_id TEXT,
               input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
               PRIMARY KEY(day, agent, model, project_path, session_id));
             CREATE TABLE usage_meta(key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO usage_daily VALUES('2026-08-01','codex','gpt-5','/tmp/manual','s1',1,1,0,0);
             INSERT INTO usage_meta VALUES('initialized','old'),('seen:codex:s1','old');",
        )
        .unwrap();
        ensure_usage_schema(&conn).unwrap();
        let columns = usage_columns(&conn).unwrap();
        assert!(columns.contains("source"));
        assert!(columns.contains("internal"));
        assert!(columns.contains("workspace"), "v5 起补工作区归因列");
        assert!(columns.contains("official"), "v6 起补官方账号标记列");
        assert!(
            table_columns(&conn, "usage_provenance")
                .unwrap()
                .contains("session_id"),
            "v7 起来源登记补会话级列"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM usage_daily", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "没有来源证据的旧索引必须重建"
        );
        assert_eq!(
            meta_get(&conn, "schema_version").as_deref(),
            Some(USAGE_SCHEMA_VERSION)
        );
        assert!(meta_get(&conn, "initialized").is_none());
    }

    #[test]
    fn usage_schema_v8_reindexes_grok_only() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_daily(
               day TEXT, agent TEXT, model TEXT, project_path TEXT, session_id TEXT,
               input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
               source TEXT, internal INTEGER, workspace TEXT, official INTEGER,
               PRIMARY KEY(day, agent, model, project_path, session_id));
             CREATE TABLE usage_meta(key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE usage_provenance(
               agent TEXT NOT NULL, project_path TEXT NOT NULL,
               session_id TEXT NOT NULL DEFAULT '',
               source TEXT NOT NULL, internal INTEGER NOT NULL DEFAULT 0,
               official INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL,
               PRIMARY KEY(agent, project_path, session_id));
             INSERT INTO usage_daily VALUES
               ('2026-09-21','claude-code','opus','/repo','s-claude',10,2,0,0,'cli',0,'',0),
               ('2026-09-21','codex','gpt-5','/repo','s-codex',10,2,0,0,'cli',0,'',0),
               ('2026-09-21','grok','grok-4','/repo','s-grok',0,0,0,0,'cli',0,'',0);
             INSERT INTO usage_meta VALUES
               ('schema_version','7'),
               ('initialized','old'),
               ('seen:claude-code:s-claude:live','old'),
               ('seen:codex:s-codex:live','old'),
               ('seen:grok:s-grok:live','old');",
        )
        .unwrap();
        ensure_usage_schema(&conn).unwrap();
        assert_eq!(
            meta_get(&conn, "schema_version").as_deref(),
            Some(USAGE_SCHEMA_VERSION)
        );
        assert!(meta_get(&conn, "initialized").is_none());
        // v7 直升 v9：Grok（v8）与 Codex（v9）都重抽，Claude 不动
        assert_eq!(
            meta_get(&conn, "seen:claude-code:s-claude:live").as_deref(),
            Some("old")
        );
        assert!(meta_get(&conn, "seen:codex:s-codex:live").is_none());
        assert!(meta_get(&conn, "seen:grok:s-grok:live").is_none());
        let agents: Vec<String> = conn
            .prepare("SELECT agent FROM usage_daily ORDER BY agent")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(agents, vec!["claude-code".to_string()]);
    }

    #[test]
    fn usage_schema_v9_reindexes_cache_inclusive_agents_only() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_daily(
               day TEXT, agent TEXT, model TEXT, project_path TEXT, session_id TEXT,
               input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
               source TEXT, internal INTEGER, workspace TEXT, official INTEGER,
               PRIMARY KEY(day, agent, model, project_path, session_id));
             CREATE TABLE usage_meta(key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE usage_provenance(
               agent TEXT NOT NULL, project_path TEXT NOT NULL,
               session_id TEXT NOT NULL DEFAULT '',
               source TEXT NOT NULL, internal INTEGER NOT NULL DEFAULT 0,
               official INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL,
               PRIMARY KEY(agent, project_path, session_id));
             INSERT INTO usage_daily VALUES
               ('2026-10-21','claude-code','opus','/repo','s-claude',10,2,0,0,'cli',0,'',0),
               ('2026-10-21','codex','gpt-5','/repo','s-codex',10,2,4,0,'cli',0,'',0),
               ('2026-10-01','codex','gpt-5','/repo','s-gone',10,2,4,0,'cli',0,'',0),
               ('2026-10-21','qwen','qwen3','/repo','s-qwen',10,2,4,0,'cli',0,'',0),
               ('2026-10-21','grok','grok-4','/repo','s-grok',10,2,0,0,'cli',0,'',0);
             INSERT INTO usage_meta VALUES
               ('schema_version','8'),
               ('initialized','old'),
               ('seen:claude-code:s-claude:live','old'),
               ('seen:codex:s-codex:live','old'),
               ('seen:qwen:s-qwen','old'),
               ('seen:grok:s-grok:live','old');",
        )
        .unwrap();
        ensure_usage_schema(&conn).unwrap();
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some(USAGE_SCHEMA_VERSION));
        assert!(meta_get(&conn, "initialized").is_none());
        assert!(meta_get(&conn, "seen:codex:s-codex:live").is_none());
        assert!(meta_get(&conn, "seen:qwen:s-qwen").is_none());
        assert_eq!(meta_get(&conn, "seen:claude-code:s-claude:live").as_deref(), Some("old"));
        assert_eq!(meta_get(&conn, "seen:grok:s-grok:live").as_deref(), Some("old"));
        let left: Vec<String> = conn
            .prepare("SELECT agent || ':' || session_id FROM usage_daily ORDER BY 1")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        // 能重抽的三家行清掉；文件已不在（无 seen）的 Codex 行重抽不回来，留着
        assert_eq!(left, vec!["claude-code:s-claude", "codex:s-gone", "grok:s-grok"]);
    }

    #[test]
    fn cache_inclusive_inputs_are_split_on_ingest() {
        assert_eq!(uncached_input(100, 30, 0), 70);
        assert_eq!(uncached_input(100, 30, 10), 60);
        assert_eq!(uncached_input(20, 30, 0), 20, "缓存比输入还大：字段口径对不上，原样返回");
        // Codex 实机：total_tokens = input + output（缓存含在输入里、推理含在输出里）
        let lines = vec![r#"{"timestamp":"2026-10-22T00:05:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":82770,"cached_input_tokens":34240,"cache_write_input_tokens":0,"output_tokens":356,"reasoning_output_tokens":265,"total_tokens":83126}}}}"#.to_string()];
        let ev = &codex_events(&lines)[0];
        assert_eq!((ev.input, ev.output, ev.cache_read), (48530, 356, 34240));
        // Qwen 实机：totalTokenCount = prompt + candidates
        let q = vec![r#"{"timestamp":"2026-10-22T00:05:00Z","model":"qwen3","usageMetadata":{"promptTokenCount":20911,"cachedContentTokenCount":1152,"candidatesTokenCount":1287,"totalTokenCount":22198,"thoughtsTokenCount":0}}"#.to_string()];
        let qv = &qwen_events(&q)[0];
        assert_eq!((qv.input, qv.output, qv.cache_read), (19759, 1287, 1152));
    }

    /// 旧的纯路径查询形态：无会话 id、无创建时间、无会话级标记（等价 v7 前行为）
    fn prov(conn: &Connection, agent: &str, project_path: &str) -> (String, bool, bool) {
        session_provenance(conn, agent, project_path, "", None, false, false)
    }

    #[test]
    fn internal_provenance_is_exact_not_tmp_path_heuristic() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        register_provenance_impl(
            &conn,
            "codex",
            "/private/tmp/ccode-ai-known",
            "",
            SOURCE_CCODE_AI,
            true,
            false,
        )
        .unwrap();
        assert_eq!(
            prov(&conn, "codex", "/private/tmp/ccode-ai-known"),
            (SOURCE_CCODE_AI.into(), true, false)
        );
        assert_eq!(
            prov(&conn, "codex", "/tmp/user-task"),
            (SOURCE_CLI.into(), false, false),
            "用户主动在 /tmp 运行不得被判成内部活动"
        );
        assert_eq!(
            prov(&conn, "codex", "/tmp/ccode-ai-unregistered"),
            (SOURCE_CLI.into(), false, false),
            "仅路径长得像 Mesa 临时任务也不是来源证据"
        );
        assert_eq!(
            prov(&conn, "claude-code", "/private/tmp/ccode-ai-known"),
            (SOURCE_CLI.into(), false, false),
            "来源登记同时绑定 agent"
        );
        #[cfg(target_os = "macos")]
        {
            register_provenance_impl(
                &conn,
                "kimi",
                "/var/folders/test/ccode-ai-canonical",
                "",
                SOURCE_CCODE_AI,
                true,
                false,
            )
            .unwrap();
            assert_eq!(
                prov(
                    &conn,
                    "kimi",
                    "/private/var/folders/test/ccode-ai-canonical"
                ),
                (SOURCE_CCODE_AI.into(), true, false),
                "macOS 临时目录别名只做路径归一化，不影响来源判定"
            );
        }
    }

    #[test]
    fn provenance_migration_adds_session_column_and_keeps_rows() {
        // v6 旧表（无 session_id、主键 agent+project_path）整表重建迁移：旧行保留为项目级登记
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_daily(day TEXT, agent TEXT, model TEXT, project_path TEXT, session_id TEXT,
               input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
               PRIMARY KEY(day, agent, model, project_path, session_id));
             CREATE TABLE usage_meta(key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE usage_provenance(
               agent TEXT NOT NULL, project_path TEXT NOT NULL,
               source TEXT NOT NULL, internal INTEGER NOT NULL DEFAULT 0,
               official INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL,
               PRIMARY KEY(agent, project_path));
             INSERT INTO usage_provenance VALUES('codex','/home/u/proj','cli',0,1,'2026-09-01T00:00:00Z');",
        )
        .unwrap();
        ensure_usage_schema(&conn).unwrap();
        assert!(table_columns(&conn, "usage_provenance")
            .unwrap()
            .contains("session_id"));
        let (sid, official, created): (String, i64, String) = conn
            .query_row(
                "SELECT session_id, official, created_at FROM usage_provenance WHERE agent='codex'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(sid, "", "旧行迁移为项目级登记（session_id=''），历史不丢");
        assert_eq!(official, 1);
        assert_eq!(
            created, "2026-09-01T00:00:00Z",
            "登记时间保留，供旧行命中口径使用"
        );
        // 新主键允许同项目并存项目级旧行与会话级新行
        register_provenance_impl(
            &conn,
            "codex",
            "/home/u/proj",
            "sess-1",
            SOURCE_CLI,
            false,
            true,
        )
        .unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM usage_provenance WHERE agent='codex'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn cards_cost_excludes_official_and_internal_tokens_counted_separately() {
        let table = load_pricing(None);
        let mut rows: Vec<StoredUsageRow> = vec![
            ws_row("/p", "s1", "gpt-5", 1_000_000, 100_000, false, ""),
            ws_row("/p", "s3", "gpt-5", 400_000, 40_000, true, ""),
        ];
        {
            let mut official = ws_row("/p", "s2", "gpt-5", 200_000, 20_000, false, "");
            official.12 = true;
            rows.push(official);
        }
        {
            // 纯官方用量的另一天：当天无可计费行，费用记 0 而非 ~
            let mut only_official = ws_row("/p", "s4", "gpt-5", 10, 10, false, "");
            only_official.0 = "2026-08-02".into();
            only_official.12 = true;
            rows.push(only_official);
        }
        let stats = build_stats(rows, &table, 7.2);
        // gpt-5：1M 输入 ×1.25 + 0.1M 输出 ×10 = 2.25，只有 s1 进计费范围
        let expect = 1.25 + 1.0;
        assert!(
            (stats.cards.cost_usd.unwrap() - expect).abs() < 1e-9,
            "总费用与趋势/榜单同一计费范围：官方账号与内部活动不计费"
        );
        assert!(!stats.cards.cost_partial);
        assert_eq!(stats.cards.input, 1_600_010, "token 总量仍是全部真实用量");
        assert_eq!(stats.cards.output, 160_010);
        assert_eq!(stats.cards.official_tokens, 220_020, "官方用量单列展示");
        assert_eq!(stats.cards.internal_tokens, 440_000, "内部用量单列展示");
        let day1 = stats.daily.iter().find(|d| d.day == "2026-08-01").unwrap();
        assert_eq!(day1.input, 1_600_000, "按天 token 含全部用量");
        assert!(
            (day1.cost_usd.unwrap() - expect).abs() < 1e-9,
            "按天费用同样只含可计费范围"
        );
        let day2 = stats.daily.iter().find(|d| d.day == "2026-08-02").unwrap();
        assert_eq!(
            day2.cost_usd,
            Some(0.0),
            "纯订阅的一天费用记 0（同 usage_trend 口径）"
        );
    }

    #[test]
    fn session_meta_internal_marks_usage_per_session() {
        // 定时巡检/雷达解读按会话 id 写 session_meta.internal，用量索引必须采用：
        // 同项目其它会话不受影响，也无需写入项目级 provenance
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta(agent TEXT, session_id TEXT, internal INTEGER NOT NULL DEFAULT 0, profile_id TEXT);
             INSERT INTO session_meta VALUES('codex', 'watch-1', 1, NULL),
                                            ('codex', 'interactive-1', 0, 'p1');",
        )
        .unwrap();
        let flags = session_meta_flags(&conn);
        let (internal, _) = flags
            .get(&("codex".to_string(), "watch-1".to_string()))
            .cloned()
            .unwrap_or((false, None));
        assert!(internal, "会话级 internal 登记必须被读到");
        assert_eq!(
            session_provenance(
                &conn,
                "codex",
                "/home/u/proj",
                "watch-1",
                None,
                internal,
                false
            ),
            (SOURCE_CCODE_AI.into(), true, false),
            "定时会话按 session 级标记归入内部活动"
        );
        assert_eq!(
            session_provenance(
                &conn,
                "codex",
                "/home/u/proj",
                "interactive-1",
                None,
                false,
                false
            ),
            (SOURCE_CLI.into(), false, false),
            "同项目的交互会话不被误标"
        );
        // meta_official 通道：会话档案的 profile 是官方账号 → official（internal 优先于它）
        assert_eq!(
            session_provenance(&conn, "codex", "/home/u/proj", "s-off", None, false, true),
            (SOURCE_CLI.into(), false, true)
        );
        assert_eq!(
            session_provenance(&conn, "codex", "/home/u/proj", "s-both", None, true, true),
            (SOURCE_CCODE_AI.into(), true, false),
            "internal 优先于 official"
        );
    }

    #[test]
    fn official_provenance_session_grained_and_legacy_cutoff() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        // 会话级登记（v7 新口径）：命中只认 session_id，不看项目路径
        register_provenance_impl(
            &conn,
            "gemini",
            "/home/u/proj",
            "sess-official",
            SOURCE_CLI,
            false,
            true,
        )
        .unwrap();
        assert_eq!(
            session_provenance(
                &conn,
                "gemini",
                "/home/u/proj",
                "sess-official",
                None,
                false,
                false
            ),
            (SOURCE_CLI.into(), false, true),
            "会话级官方登记命中"
        );
        assert_eq!(
            session_provenance(
                &conn,
                "gemini",
                "/home/u/proj",
                "sess-api",
                None,
                false,
                false
            ),
            (SOURCE_CLI.into(), false, false),
            "同项目后来的 API 会话不再被官方登记粘住"
        );
        // 项目级旧行（v7 前登记，session_id=''）：只回填登记时刻已存在的会话
        conn.execute(
            "INSERT INTO usage_provenance(agent, project_path, session_id, source, internal, official, created_at)
             VALUES('codex', '/home/u/legacy', '', 'cli', 0, 1, '2026-09-01T00:00:00Z')",
            [],
        )
        .unwrap();
        assert_eq!(
            session_provenance(
                &conn,
                "codex",
                "/home/u/legacy",
                "s-old",
                Some("2026-08-20T10:00:00Z"),
                false,
                false,
            ),
            (SOURCE_CLI.into(), false, true),
            "登记时刻之前的旧会话保持历史标记"
        );
        assert_eq!(
            session_provenance(
                &conn,
                "codex",
                "/home/u/legacy",
                "s-new",
                Some("2026-09-05T10:00:00Z"),
                false,
                false,
            ),
            (SOURCE_CLI.into(), false, false),
            "登记之后新建的会话按新口径判定，旧登记不粘住新会话"
        );
        assert_eq!(
            session_provenance(
                &conn,
                "codex",
                "/home/u/legacy",
                "s-unknown",
                None,
                false,
                false
            ),
            (SOURCE_CLI.into(), false, true),
            "创建时间缺失的旧会话按旧行为保留标记（历史不丢）"
        );
    }

    #[test]
    fn official_provenance_marks_rows_and_splits_cost_buckets() {
        // 项目级旧登记（v7 前行）+ 创建时间缺失的会话 → 保持历史 official 标记；
        // 新登记走会话级（见 official_provenance_session_grained_and_legacy_cutoff）
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        register_provenance_impl(&conn, "gemini", "/home/u/proj", "", SOURCE_CLI, false, true)
            .unwrap();
        assert_eq!(
            prov(&conn, "gemini", "/home/u/proj"),
            (SOURCE_CLI.into(), false, true),
            "官方账号登记：source 保持 cli，只标 official"
        );
        assert_eq!(
            prov(&conn, "gemini", "/home/u/other"),
            (SOURCE_CLI.into(), false, false),
            "未登记的项目不受影响"
        );
        assert_eq!(
            prov(&conn, "codex", "/home/u/proj"),
            (SOURCE_CLI.into(), false, false),
            "official 登记同样绑定 agent"
        );
        // 同一 agent 下 official 与普通用量在 agent/项目/工作区维度分桶，费用互不染指
        let rows: Vec<StoredUsageRow> = vec![
            ws_row("/home/u/proj", "s1", "gemini-3-pro", 100, 10, false, ""),
            {
                let mut r = ws_row("/home/u/proj", "s2", "gemini-3-pro", 50, 5, false, "");
                r.12 = true;
                r
            },
            {
                let mut r = ws_row("/home/u/proj", "s3", "gemini-3-pro", 20, 2, false, "task-x");
                r.12 = true;
                r
            },
        ];
        let stats = build_stats(rows, &load_pricing(None), 7.2);
        let official_agent = stats.by_agent.iter().find(|a| a.official).unwrap();
        let normal_agent = stats.by_agent.iter().find(|a| !a.official).unwrap();
        assert_eq!(official_agent.tokens, 50 + 5 + 20 + 2);
        assert_eq!(normal_agent.tokens, 110);
        assert!(normal_agent.cost_usd.is_some(), "普通行仍按官方价估算");
        let official_project = stats.by_project.iter().find(|p| p.official).unwrap();
        assert_eq!(official_project.sessions, 2);
        assert!(stats.by_project.iter().any(|p| !p.official));
        let official_ws = stats.by_workspace.iter().find(|w| w.official).unwrap();
        assert_eq!(official_ws.workspace_name, "task-x");
        assert_eq!(official_ws.tokens_in + official_ws.tokens_out, 22);
    }

    #[test]
    fn session_usage_aggregates_per_session_with_pricing() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let mut ins = |session: &str, model: &str, i: i64, o: i64, cr: i64, cw: i64| {
            conn.execute(
                "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
                 input, output, cache_read, cache_write) VALUES ('2026-08-17','claude-code',?1,'/p',?2,?3,?4,?5,?6)",
                rusqlite::params![model, session, i, o, cr, cw],
            )
            .unwrap();
        };
        ins("s1", "claude-sonnet-4", 1_000_000, 100_000, 0, 0);
        ins("s1", "gpt-5", 500_000, 50_000, 100_000, 0); // 同会话多模型分组计价
        ins("s1", "unknown-model-x", 10_000, 5_000, 0, 0); // 未命中定价表不计费
        ins("s2", "claude-sonnet-4", 9_999, 1, 0, 0); // 别的会话不混入
        let dto = session_usage_from(&conn, "claude-code", "s1").unwrap();
        assert_eq!(dto.input, 1_510_000);
        assert_eq!(dto.output, 155_000);
        assert_eq!((dto.cache_read, dto.cache_write), (100_000, 0), "缓存单独给出，状态栏合计要算上");
        assert!(dto.priced);
        // sonnet: 1M×3 + 0.1M×15 = 4.5；gpt-5: 0.5M×1.25 + 0.05M×10 + 0.1M×1.25×0.1 = 1.1375
        let expect = 4.5 + 1.1375;
        assert!((dto.cost_usd - expect).abs() < 1e-9, "{}", dto.cost_usd);
        // 未命中定价表时 priced=false（前端只显示 token）
        let dto2 = session_usage_from(&conn, "claude-code", "s-none").unwrap();
        assert_eq!(dto2.input, 0);
        assert!(!dto2.priced);
    }

    #[test]
    fn prune_stale_provenance_keeps_internal_ai_rows() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let tmp = normalize_provenance_path(&std::env::temp_dir().to_string_lossy());
        let internal_old = format!("{tmp}/ccode-ai-{}", uuid::Uuid::new_v4());
        let cli_old = format!("{tmp}/ccode-prune-cli-{}", uuid::Uuid::new_v4());
        let old = "2020-01-01T00:00:00Z";
        conn.execute(
            "INSERT INTO usage_provenance(agent, project_path, source, internal, created_at)
             VALUES('kimi', ?1, ?2, 1, ?3)",
            params![internal_old.as_str(), SOURCE_CCODE_AI, old],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO usage_provenance(agent, project_path, source, internal, created_at)
             VALUES('kimi', ?1, 'cli', 0, ?2)",
            params![cli_old.as_str(), old],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO usage_provenance(agent, project_path, source, internal, created_at)
             VALUES('kimi', '/ccode-test-real-project', 'cli', 0, ?1)",
            params![old],
        )
        .unwrap();
        prune_stale_provenance(&conn);
        let mut rows: Vec<String> = conn
            .prepare("SELECT project_path FROM usage_provenance")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .flatten()
            .collect();
        rows.sort();
        let mut expected = vec!["/ccode-test-real-project".to_string(), internal_old];
        expected.sort();
        assert_eq!(
            rows, expected,
            "内部 AI 登记保留；非内部且 tmp 下已消失的老行仍清"
        );
    }

    #[test]
    fn ccode_ai_temp_cwd_only_matches_uuid_dir_name() {
        assert!(is_ccode_ai_temp_cwd(
            "/var/folders/xx/T/ccode-ai-2666326a-de4f-48c0-92aa-1979d2e1abcd"
        ));
        assert!(is_ccode_ai_temp_cwd(
            "C:\\Users\\me\\AppData\\Local\\Temp\\ccode-ai-2666326a-de4f-48c0-92aa-1979d2e1abcd"
        ));
        assert!(!is_ccode_ai_temp_cwd("/tmp/ccode-ai-not-a-uuid"));
        assert!(!is_ccode_ai_temp_cwd("/Users/me/Ccode"));
        assert!(!is_ccode_ai_temp_cwd("/tmp/user-task"));
    }

    #[test]
    fn watch_worktree_cwd_only_matches_under_mesa_root() {
        let home = dirs::home_dir().expect("测试机必有 home");
        let inside = home.join("ccode/watch-worktrees/测试项目/f4334054-d77e-4c11-ab56-22bb11a2a83f");
        assert!(is_watch_worktree_cwd(&inside.to_string_lossy()));
        // 根目录本身也命中：与 list_repos 的排除口径（== 或前缀 /）一致
        let root = home.join("ccode/watch-worktrees");
        assert!(is_watch_worktree_cwd(&root.to_string_lossy()));
        // 兄弟目录不算：工作区 worktree 与真实项目仓库不受影响
        assert!(!is_watch_worktree_cwd(
            &home.join("ccode/workspaces/测试项目/lit-search").to_string_lossy()
        ));
        assert!(!is_watch_worktree_cwd(
            &home.join("Desktop/测试项目").to_string_lossy()
        ));
        // 相近前缀不误伤：只是开头同名的目录
        assert!(!is_watch_worktree_cwd(
            &home.join("ccode/watch-worktrees-别家").to_string_lossy()
        ));
        assert!(!is_watch_worktree_cwd(""));
    }

    #[test]
    fn stats_keep_internal_dimension_for_same_model() {
        let rows: Vec<StoredUsageRow> = vec![
            (
                "2026-08-01".into(),
                "codex".into(),
                "gpt-5-codex".into(),
                "/tmp/user-task".into(),
                "normal".into(),
                100,
                10,
                0,
                0,
                SOURCE_CLI.into(),
                false,
                String::new(),
                false,
            ),
            (
                "2026-08-01".into(),
                "codex".into(),
                "gpt-5-codex".into(),
                "/private/tmp/ccode-ai-known".into(),
                "internal".into(),
                20,
                5,
                0,
                0,
                SOURCE_CCODE_AI.into(),
                true,
                String::new(),
                false,
            ),
        ];
        let stats = build_stats(rows, &load_pricing(None), 7.2);
        assert_eq!(stats.by_project.len(), 2);
        assert!(stats
            .by_project
            .iter()
            .any(|row| row.project_path == "/tmp/user-task"
                && !row.internal
                && row.source == SOURCE_CLI));
        assert!(stats
            .by_project
            .iter()
            .any(|row| row.internal && row.source == SOURCE_CCODE_AI));
        assert_eq!(
            stats.by_model.len(),
            2,
            "相同模型的普通与内部用量不得混成一行"
        );
        assert!(stats.by_model.iter().any(|row| !row.internal));
        assert!(stats.by_model.iter().any(|row| row.internal));
    }

    /// 造一行 StoredUsageRow（official 默认 false，workspace 之外参数从简）
    fn ws_row(
        project: &str,
        sid: &str,
        model: &str,
        input: i64,
        output: i64,
        internal: bool,
        workspace: &str,
    ) -> StoredUsageRow {
        (
            "2026-08-01".into(),
            "codex".into(),
            model.into(),
            project.into(),
            sid.into(),
            input,
            output,
            0,
            0,
            SOURCE_CLI.into(),
            internal,
            workspace.into(),
            false,
        )
    }

    #[test]
    fn workspace_attribution_groups_and_keeps_project_dimension() {
        let rows: Vec<StoredUsageRow> = vec![
            // 工作区会话（扫描已把项目路径改写为真实仓库，workspace 列记工作区名）
            ws_row(
                "/home/u/code/myrepo",
                "s1",
                "gpt-5",
                100,
                10,
                false,
                "feat-x",
            ),
            ws_row("/home/u/code/myrepo", "s2", "gpt-5", 50, 5, false, "feat-x"),
            // 同名工作区在另一个仓库下：各自成行
            ws_row("/home/u/code/other", "s3", "gpt-5", 30, 3, false, "feat-x"),
            // 主仓库 / 非工作区会话：不进 by_workspace，项目维度不受影响
            ws_row("/home/u/code/myrepo", "s4", "gpt-5", 7, 1, false, ""),
            ws_row("/elsewhere", "s5", "gpt-5", 9, 1, false, ""),
        ];
        let stats = build_stats(rows, &load_pricing(None), 7.2);
        assert_eq!(stats.by_workspace.len(), 2, "同名不同仓库的工作区不得合并");
        let feat_myrepo = stats
            .by_workspace
            .iter()
            .find(|r| r.repo_name == "myrepo")
            .unwrap();
        assert_eq!(feat_myrepo.workspace_name, "feat-x");
        assert_eq!((feat_myrepo.tokens_in, feat_myrepo.tokens_out), (150, 15));
        assert_eq!(feat_myrepo.models, 1);
        assert!(feat_myrepo.cost.is_some(), "gpt-5 官方价应可估算");
        assert!(!feat_myrepo.cost_partial);
        assert!(!feat_myrepo.internal);
        assert!(stats
            .by_workspace
            .iter()
            .all(|r| !r.workspace_name.is_empty()));
        // 项目维度保持原样：工作区用量仍计入所属仓库项目行
        let proj = stats
            .by_project
            .iter()
            .find(|p| p.project_path == "/home/u/code/myrepo")
            .unwrap();
        assert_eq!(proj.tokens, 150 + 15 + 7 + 1);
    }

    #[test]
    fn workspace_rows_sorted_by_tokens_and_partial_cost() {
        let rows: Vec<StoredUsageRow> = vec![
            ws_row("/r/a", "s1", "mystery-model", 10, 10, false, "small"),
            ws_row("/r/a", "s2", "gpt-5", 1_000_000, 1_000_000, false, "big"),
            ws_row("/r/a", "s3", "mystery-model", 5, 5, false, "big"),
            // 内部来源落在工作区时与普通行分桶，开关口径与项目排行一致
            ws_row("/r/a", "s4", "gpt-5", 60, 6, true, "big"),
        ];
        let stats = build_stats(rows, &load_pricing(None), 7.2);
        assert_eq!(stats.by_workspace.len(), 3);
        assert_eq!(stats.by_workspace[0].workspace_name, "big", "按 token 降序");
        assert!(!stats.by_workspace[0].internal);
        let big = &stats.by_workspace[0];
        assert!(big.cost.is_some(), "只累加已计价份额");
        assert!(big.cost_partial, "混有不明价模型必须标记 ≥");
        assert_eq!(big.models, 2);
        let big_internal = stats
            .by_workspace
            .iter()
            .find(|r| r.workspace_name == "big" && r.internal)
            .unwrap();
        assert!(!big_internal.cost_partial);
        let small = stats
            .by_workspace
            .iter()
            .find(|r| r.workspace_name == "small")
            .unwrap();
        assert_eq!(small.cost, None, "全部不明价 → 费用 None（前端显示 ~）");
        assert!(small.cost_partial);
    }

    #[test]
    fn pricing_longest_prefix_and_unknown() {
        let table = load_pricing(None);
        assert_eq!(price_of("gpt-5-codex-mini", &table), Some((1.25, 10.0)));
        assert_eq!(
            price_of("claude-sonnet-4-5", &table),
            Some((3.0, 15.0)),
            "旧代 Sonnet 4.x 价"
        );
        assert_eq!(
            price_of("claude-sonnet-5", &table),
            Some((2.0, 10.0)),
            "Sonnet 5 起降价"
        );
        assert_eq!(
            price_of("claude-opus-4-1-20250805", &table),
            Some((15.0, 75.0)),
            "仅 Opus 4.1 为旧高价"
        );
        assert_eq!(price_of("claude-opus-5", &table), Some((5.0, 25.0)));
        assert_eq!(price_of("some-relay-model", &table), None);
        assert_eq!(price_of("", &table), None, "未知模型无价格");
        // 扩充的中转/聚合模型走官方价
        assert_eq!(
            price_of("grok-4.5", &table),
            Some((2.0, 6.0)),
            "grok-4.5 新代价，不再落 grok-4 旧价"
        );
        assert_eq!(
            price_of("grok-4-0709", &table),
            Some((3.0, 15.0)),
            "初代 grok-4 保留旧价"
        );
        assert_eq!(
            price_of("grok-4.1-fast-mini", &table),
            Some((0.2, 0.5)),
            "更长前缀优先于 grok-4"
        );
        assert_eq!(price_of("grok-3-mini-128k", &table), Some((0.3, 0.5)));
        assert_eq!(price_of("grok-code-fast-1", &table), Some((0.2, 1.5)));
        assert_eq!(price_of("glm-4.6-air", &table), Some((0.6, 2.2)));
        assert_eq!(
            price_of("glm-5.2", &table),
            Some((1.4, 4.4)),
            "glm-5 新代官方价已出"
        );
        assert_eq!(
            price_of("qwen3-coder-plus", &table),
            Some((1.0, 5.0)),
            "qwen3-coder 优先于 qwen3"
        );
        assert_eq!(price_of("qwen3-max", &table), Some((1.2, 6.0)));
        assert_eq!(price_of("moonshot-v1-8k", &table), Some((0.6, 3.0)));
        assert_eq!(price_of("gemini-3-pro-preview", &table), Some((2.0, 12.0)));
        assert_eq!(
            price_of("gemini-3.6-flash-lite", &table),
            Some((0.75, 3.75)),
            "3.6-flash 推广价"
        );
        assert_eq!(
            price_of("gemini-2.5-pro", &table),
            Some((1.25, 10.0)),
            "旧条目保留"
        );
        // 新代条目
        assert_eq!(price_of("claude-fable-2", &table), Some((10.0, 50.0)));
        assert_eq!(price_of("gemini-3.5-flash-tts", &table), Some((1.5, 9.0)));
        assert_eq!(
            price_of("gemini-3.1-pro-preview", &table),
            Some((2.0, 12.0))
        );
        assert_eq!(price_of("kimi-k2.6", &table), Some((0.95, 4.0)));
        assert_eq!(price_of("deepseek-v4-pro-0813", &table), Some((1.32, 3.96)));
    }

    #[test]
    fn pricing_layer_precedence_high_layer_wins() {
        // 层序契约：高层任意前缀命中即胜（用户写短前缀即覆盖低层长前缀旧价）；
        // 同层内最长前缀优先
        let chain: PriceChain = [
            vec![("m-x".into(), (1.0, 1.0)), ("m-y-pro".into(), (1.0, 1.0))], // 内置
            vec![("m-x".into(), (2.0, 2.0))],                                 // 公共能力库
            vec![("m-x".into(), (3.0, 3.0)), ("m-y".into(), (9.0, 9.0))],     // 用户覆盖
        ];
        assert_eq!(
            price_of("m-x-pro", &chain),
            Some((3.0, 3.0)),
            "用户覆盖 > 公共库 > 内置"
        );
        assert_eq!(
            price_of("m-y-pro", &chain),
            Some((9.0, 9.0)),
            "高层短前缀覆盖低层长前缀"
        );
        let chain2: PriceChain = [
            vec![("m-z".into(), (1.0, 1.0)), ("m-z-pro".into(), (2.0, 2.0))],
            vec![],
            vec![],
        ];
        assert_eq!(
            price_of("m-z-pro", &chain2),
            Some((2.0, 2.0)),
            "同层最长前缀优先"
        );
    }

    #[test]
    fn pricing_strips_provider_prefix() {
        let table = load_pricing(None);
        // 中转/聚合的 provider 前缀：按最后一个 / 之后的末段匹配
        assert_eq!(
            price_of("accounts/fireworks/models/glm-5p2", &table),
            Some((1.4, 4.4)),
            "glm 前缀命中"
        );
        assert_eq!(price_of("zetatechs/kimi-k3", &table), Some((3.0, 15.0)));
        assert_eq!(
            price_of("openrouter/claude-sonnet-4", &table),
            Some((3.0, 15.0))
        );
        assert_eq!(
            price_of("relay/mystery-x", &table),
            None,
            "末段不明依然不明价"
        );
    }

    #[test]
    fn rate_priority_chain() {
        assert_eq!(load_rate_with(None, None), 7.2, "默认 7.2");
        let dir = std::env::temp_dir().join(format!("ccode-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("pricing.json");
        std::fs::write(&p, r#"{"_rate": 7.05, "claude-sonnet": [1.0, 5.0]}"#).unwrap();
        assert_eq!(load_rate_with(None, Some(&p)), 7.05, "_rate 键覆盖默认汇率");
        assert_eq!(
            load_rate_with(Some(7.3), Some(&p)),
            7.3,
            "settings.json 优先于 pricing.json _rate"
        );
        assert_eq!(load_rate_with(Some(7.3), None), 7.3);
        std::fs::write(&p, r#"{"_rate": -1}"#).unwrap();
        assert_eq!(load_rate_with(None, Some(&p)), 7.2, "非法 _rate 回落默认");
        assert_eq!(
            load_rate_with(Some(-2.0), None),
            7.2,
            "非法 settings 汇率同样回落"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pricing_override_merges_over_builtins() {
        let dir = std::env::temp_dir().join(format!("ccode-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("pricing.json");
        std::fs::write(
            &p,
            r#"{"claude-sonnet": [1.0, 5.0], "relay-x": [0.1, 0.2]}"#,
        )
        .unwrap();
        let table = load_pricing(Some(&p));
        assert_eq!(
            price_of("claude-sonnet-4", &table),
            Some((1.0, 5.0)),
            "覆盖内置（含低层更长前缀的旧代价）"
        );
        assert_eq!(
            price_of("relay-x-pro", &table),
            Some((0.1, 0.2)),
            "新增自定义前缀"
        );
        assert_eq!(
            price_of("claude-opus-4-1", &table),
            Some((15.0, 75.0)),
            "内置旧代价保留"
        );
        assert_eq!(
            price_of("claude-opus-4-5", &table),
            Some((5.0, 25.0)),
            "内置新代价保留"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn range_cutoff_days() {
        let today = NaiveDate::from_ymd_opt(2026, 7, 30).unwrap();
        assert_eq!(
            cutoff_day_from("today", today).as_deref(),
            Some("2026-07-30")
        );
        assert_eq!(
            cutoff_day_from("week", today).as_deref(),
            Some("2026-07-24")
        );
        assert_eq!(
            cutoff_day_from("month", today).as_deref(),
            Some("2026-07-01")
        );
        assert_eq!(cutoff_day_from("all", today), None);
    }

    #[test]
    fn unpriced_models_lists_billed_models_without_price() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let chain: PriceChain = [vec![("gpt-5".to_string(), (1.25, 10.0))], vec![], vec![]];
        insert_daily(&conn, "2026-10-01", "codex", "gpt-5", "/p", "s1", 100, 10, 0, false);
        insert_daily(&conn, "2026-10-02", "kimi", "kimi-k3", "/p", "s2", 500, 50, 0, false);
        insert_daily(&conn, "2026-10-05", "kimi", "kimi-k3", "/p", "s3", 100, 0, 0, false);
        insert_daily(&conn, "2026-10-03", "grok", "relay-x", "/p", "s4", 10, 0, 0, false);
        // 订阅额度不计费，不该被列出
        insert_daily(&conn, "2026-10-04", "gemini", "gemini-sub", "/p", "s5", 900, 0, 0, true);
        let got = unpriced_models(&conn, &chain).unwrap();
        let names: Vec<&str> = got.iter().map(|m| m.model.as_str()).collect();
        assert_eq!(names, vec!["kimi-k3", "relay-x"], "有价的与订阅的不列，按用量降序");
        assert_eq!(got[0].tokens, 650);
        assert_eq!(got[0].last_day, "2026-10-05");
    }

    fn insert_daily(
        conn: &Connection,
        day: &str,
        agent: &str,
        model: &str,
        project: &str,
        sid: &str,
        input: i64,
        output: i64,
        cache_read: i64,
        official: bool,
    ) {
        conn.execute(
            "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
             input, output, cache_read, cache_write, official)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?9)",
            rusqlite::params![
                day,
                agent,
                model,
                project,
                sid,
                input,
                output,
                cache_read,
                i64::from(official)
            ],
        )
        .unwrap();
    }

    #[test]
    fn usage_trend_empty_db_fills_month_zeros() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 3, 15).unwrap();
        let dto = usage_trend_from(&conn, "month", today, &load_pricing(None), 7.2).unwrap();
        assert_eq!(dto.days.len(), 30, "近 30 天含 today");
        assert_eq!(dto.days[0].day, "2026-02-14");
        assert_eq!(dto.days[29].day, "2026-03-15");
        assert!(dto
            .days
            .iter()
            .all(|d| !d.has_usage && d.cost_usd == Some(0.0)));
    }

    #[test]
    fn usage_trend_fills_today_and_week_length() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 3, 15).unwrap();
        let table = load_pricing(None);
        let day = usage_trend_from(&conn, "today", today, &table, 7.2).unwrap();
        assert_eq!(day.days.len(), 1, "今日只填当天");
        assert_eq!(day.days[0].day, "2026-03-15");
        let week = usage_trend_from(&conn, "week", today, &table, 7.2).unwrap();
        assert_eq!(week.days.len(), 7, "近 7 天含 today");
        assert_eq!(week.days[0].day, "2026-03-09");
        assert_eq!(week.days[6].day, "2026-03-15");
    }

    #[test]
    fn usage_trend_fills_across_month_and_skips_official_cost() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 3, 5).unwrap();
        insert_daily(
            &conn,
            "2026-02-28",
            "codex",
            "gpt-5",
            "/p",
            "s-api",
            1_000_000,
            0,
            0,
            false,
        );
        insert_daily(
            &conn,
            "2026-02-28",
            "gemini",
            "gemini-3-pro",
            "/p",
            "s-off",
            9_000_000,
            0,
            0,
            true,
        );
        insert_daily(
            &conn,
            "2026-03-05",
            "codex",
            "mystery-x",
            "/p",
            "s-unk",
            100,
            10,
            0,
            false,
        );
        let dto = usage_trend_from(&conn, "month", today, &load_pricing(None), 7.2).unwrap();
        assert_eq!(dto.days.first().map(|d| d.day.as_str()), Some("2026-02-04"));
        let feb = dto.days.iter().find(|d| d.day == "2026-02-28").unwrap();
        assert!(feb.has_usage);
        assert!(
            feb.cost_usd.unwrap() > 0.0,
            "官方账号那行不计费，API 行仍计价"
        );
        let mar = dto.days.iter().find(|d| d.day == "2026-03-05").unwrap();
        assert!(mar.has_usage);
        assert_eq!(mar.cost_usd, None, "当天只有未计价模型 → ~ 而不是 0");
        let gap = dto.days.iter().find(|d| d.day == "2026-03-01").unwrap();
        assert!(!gap.has_usage);
        assert_eq!(gap.cost_usd, Some(0.0));
    }

    #[test]
    fn top_sessions_ranks_billed_skips_official_and_unpriced() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta(
               agent TEXT NOT NULL, session_id TEXT NOT NULL,
               custom_title TEXT, PRIMARY KEY(agent, session_id));",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_meta(agent, session_id, custom_title) VALUES('codex','s-big','飞了的长会话')",
            [],
        )
        .unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
        insert_daily(
            &conn,
            "2026-08-20",
            "codex",
            "gpt-5",
            "/proj/a",
            "s-big",
            2_000_000,
            0,
            0,
            false,
        );
        insert_daily(
            &conn,
            "2026-08-21",
            "codex",
            "gpt-5",
            "/proj/a",
            "s-small",
            100_000,
            0,
            0,
            false,
        );
        insert_daily(
            &conn,
            "2026-08-22",
            "gemini",
            "gemini-3-pro",
            "/proj/b",
            "s-off",
            9_000_000,
            0,
            0,
            true,
        );
        insert_daily(
            &conn,
            "2026-08-23",
            "codex",
            "mystery-x",
            "/proj/c",
            "s-unk",
            9_000_000,
            0,
            0,
            false,
        );
        insert_daily(
            &conn,
            "2026-07-01",
            "codex",
            "gpt-5",
            "/proj/a",
            "s-old",
            9_000_000,
            0,
            0,
            false,
        );
        let top = top_sessions_from(&conn, "month", today, &load_pricing(None)).unwrap();
        assert_eq!(top.len(), 2, "官方与未计价不进榜，区间外的旧会话也不进");
        assert_eq!(top[0].session_id, "s-big");
        assert_eq!(top[0].title.as_deref(), Some("飞了的长会话"));
        assert_eq!(top[1].session_id, "s-small");
        assert!(top[0].cost_usd.unwrap() > top[1].cost_usd.unwrap());
    }

    #[test]
    fn usage_trend_and_top_sessions_skip_internal() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
        insert_daily(
            &conn,
            "2026-08-20",
            "codex",
            "gpt-5",
            "/p",
            "s-user",
            100_000,
            0,
            0,
            false,
        );
        conn.execute(
            "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
             input, output, cache_read, cache_write, official, internal)
             VALUES ('2026-08-21','kimi','kimi-k2','/tmp/ccode-ai','s-radar',9000000,0,0,0,0,1)",
            [],
        )
        .unwrap();
        let dto = usage_trend_from(&conn, "month", today, &load_pricing(None), 7.2).unwrap();
        let radar = dto.days.iter().find(|d| d.day == "2026-08-21").unwrap();
        assert!(!radar.has_usage, "内部活动不得进入花费折线");
        assert_eq!(radar.cost_usd, Some(0.0));
        let user = dto.days.iter().find(|d| d.day == "2026-08-20").unwrap();
        assert!(user.has_usage);
        let top = top_sessions_from(&conn, "month", today, &load_pricing(None)).unwrap();
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].session_id, "s-user");
    }

    #[test]
    fn top_session_title_is_redacted() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta(
               agent TEXT NOT NULL, session_id TEXT NOT NULL,
               custom_title TEXT, PRIMARY KEY(agent, session_id));",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_meta(agent, session_id, custom_title)
             VALUES('codex','s-leak','任务 sk-live-secret-987654')",
            [],
        )
        .unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
        insert_daily(
            &conn,
            "2026-08-20",
            "codex",
            "gpt-5",
            "/p",
            "s-leak",
            1_000_000,
            0,
            0,
            false,
        );
        let top = top_sessions_from(&conn, "month", today, &load_pricing(None)).unwrap();
        let title = top[0].title.as_deref().unwrap();
        assert!(!title.contains("sk-live-secret-987654"));
        assert!(title.contains("已隐藏密钥"));
    }

    #[test]
    fn top_sessions_equal_cost_uses_stable_tiebreak() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
        insert_daily(
            &conn,
            "2026-08-20",
            "codex",
            "gpt-5",
            "/p",
            "s-b",
            1_000_000,
            0,
            0,
            false,
        );
        insert_daily(
            &conn,
            "2026-08-21",
            "codex",
            "gpt-5",
            "/p",
            "s-a",
            1_000_000,
            0,
            0,
            false,
        );
        let top = top_sessions_from(&conn, "month", today, &load_pricing(None)).unwrap();
        assert_eq!(top.len(), 2);
        assert_eq!(top[0].session_id, "s-a", "花费相同按 session_id 升序");
        assert_eq!(top[1].session_id, "s-b");
    }

    #[test]
    fn top_sessions_empty_db() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
        let top = top_sessions_from(&conn, "all", today, &load_pricing(None)).unwrap();
        assert!(top.is_empty());
    }

    #[test]
    fn cache_savings_priced_only_skips_official() {
        let table = load_pricing(None);
        let rows: Vec<StoredUsageRow> = vec![
            (
                "2026-08-01".into(),
                "codex".into(),
                "gpt-5".into(),
                "/p".into(),
                "s1".into(),
                0,
                0,
                1_000_000,
                0,
                SOURCE_CLI.into(),
                false,
                String::new(),
                false,
            ),
            (
                "2026-08-01".into(),
                "codex".into(),
                "mystery-x".into(),
                "/p".into(),
                "s2".into(),
                0,
                0,
                1_000_000,
                0,
                SOURCE_CLI.into(),
                false,
                String::new(),
                false,
            ),
            {
                let mut r = ws_row("/p", "s3", "gpt-5", 0, 0, false, "");
                r.7 = 1_000_000; // cache_read
                r.12 = true; // official
                r
            },
        ];
        let stats = build_stats(rows, &table, 7.2);
        // gpt-5 输入 1.25 / MTok，省 90% → 1.125；未计价与官方不计入
        let saved = stats.cards.cache_savings_usd.unwrap();
        assert!((saved - 1.125).abs() < 1e-9, "{saved}");
    }

    #[test]
    fn bucket_cost_partial_semantics() {
        let table = load_pricing(None);
        // 全计价 → 精确费用，非 partial
        let mut b = Bucket::default();
        b.add(
            "gpt-5",
            "s1",
            TokenAcc {
                input: 1_000_000,
                output: 1_000_000,
                cache_read: 0,
                cache_write: 0,
            },
        );
        assert_eq!(b.cost(&table), (Some(1.25 + 10.0), false));
        // 混有不明价 → 只算已计价份额，partial=true
        b.add(
            "mystery",
            "s2",
            TokenAcc {
                input: 5,
                output: 5,
                cache_read: 0,
                cache_write: 0,
            },
        );
        let (cost, partial) = b.cost(&table);
        assert_eq!(cost, Some(11.25), "不明价模型不再毒化整桶");
        assert!(partial);
        // 全不明价 → None（partial 也置位，前端显示 ~）
        let mut c = Bucket::default();
        c.add(
            "mystery",
            "s1",
            TokenAcc {
                input: 5,
                output: 5,
                cache_read: 0,
                cache_write: 0,
            },
        );
        assert_eq!(c.cost(&table), (None, true));
    }

    #[test]
    fn claude_continuation_counts_only_own_lines() {
        // 接续文件开头是上游复制来的历史，那份用量记在上游名下
        let lines = vec![
            r#"{"type":"assistant","sessionId":"up","timestamp":"2026-10-18T01:00:00Z","message":{"model":"m","usage":{"input_tokens":100,"output_tokens":10}}}"#.to_string(),
            r#"{"type":"assistant","sessionId":"me","timestamp":"2026-10-19T01:00:00Z","message":{"model":"m","usage":{"input_tokens":7,"output_tokens":1}}}"#.to_string(),
        ];
        let evs = claude_events(&lines, Some("me"));
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].input, 7);
        assert_eq!(claude_events(&lines, None).len(), 2, "不知道自己 id 时不过滤");
    }

    #[test]
    fn extractors_claude_codex_kimi() {
        // claude：assistant 行的 usage + model
        let lines = vec![
            r#"{"type":"assistant","timestamp":"2026-07-29T01:00:00Z","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}"#.to_string(),
            r#"{"type":"user","message":{"role":"user","content":"q"}}"#.to_string(),
        ];
        let evs = claude_events(&lines, None);
        assert_eq!(evs.len(), 1);
        assert_eq!(
            (evs[0].day.as_str(), evs[0].model.as_str()),
            (
                day_of_iso("2026-07-29T01:00:00Z").as_str(),
                "claude-sonnet-4-5"
            )
        );
        assert_eq!(
            (
                evs[0].input,
                evs[0].output,
                evs[0].cache_read,
                evs[0].cache_write
            ),
            (10, 5, 3, 2)
        );
        // codex：turn_context 定 model，token_count 的 last_token_usage 是本轮增量
        let lines = vec![
            r#"{"timestamp":"2026-07-29T02:00:00Z","type":"turn_context","payload":{"model":"gpt-5-codex"}}"#.to_string(),
            r#"{"timestamp":"2026-07-29T02:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20,"reasoning_output_tokens":5,"cached_input_tokens":10},"total_token_usage":{"input_tokens":999}}}}"#.to_string(),
        ];
        let evs = codex_events(&lines);
        assert_eq!(evs.len(), 1);
        assert_eq!(
            (evs[0].input, evs[0].output, evs[0].cache_read),
            (90, 20, 10),
            "用增量而非累计；输入拆掉缓存、推理不另加"
        );
        assert_eq!(evs[0].model, "gpt-5-codex");
        // kimi：usage.record
        let lines = vec![
            r#"{"type":"usage.record","model":"kimi-k2","usage":{"inputOther":50,"output":9,"inputCacheRead":4,"inputCacheCreation":1},"time":1785307071000}"#.to_string(),
        ];
        let evs = kimi_events(&lines);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].day, day_of_ms(1785307071000));
        assert_eq!(
            (
                evs[0].input,
                evs[0].output,
                evs[0].cache_read,
                evs[0].cache_write
            ),
            (50, 9, 4, 1)
        );
        // codebuddy：毫秒 epoch 时间戳；无 usage 字段的行（401 实测样本）不产生事件
        let lines = vec![
            r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"say hi"}],"timestamp":1786005441386}"#.to_string(),
            r#"{"type":"message","role":"assistant","content":[{"type":"output_text","text":"401 Unauthorized"}],"timestamp":1786005443775}"#.to_string(),
        ];
        assert!(
            codebuddy_events(&lines).is_empty(),
            "无 usage 字段必须零事件不报错"
        );
        let lines = vec![
            r#"{"type":"message","role":"assistant","model":"glm-5.0","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":2},"timestamp":1786005443775}"#.to_string(),
        ];
        let evs = codebuddy_events(&lines);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].day, day_of_ms(1786005443775));
        assert_eq!(evs[0].model, "glm-5.0");
        assert_eq!(
            (
                evs[0].input,
                evs[0].output,
                evs[0].cache_read,
                evs[0].cache_write
            ),
            (10, 5, 3, 2)
        );
        // cursor：usage 字段未实证，按字段名候选尽力而为；无 usage 字段的行必须零事件不报错
        let lines = vec![
            r#"{"type":"user_message","message":{"content":[{"text":"hi"}]},"timestamp":1786005441386}"#.to_string(),
            r#"{"type":"turn_ended","timestamp":1786005441500}"#.to_string(),
        ];
        assert!(
            cursor_events(&lines).is_empty(),
            "无 usage 字段必须零事件不报错"
        );
        let lines = vec![
            r#"{"type":"turn_ended","model":"claude-opus-4-8","usage":{"inputTokens":20,"outputTokens":7},"timestamp":1786005443775}"#.to_string(),
        ];
        let evs = cursor_events(&lines);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].day, day_of_ms(1786005443775));
        assert_eq!(evs[0].model, "claude-opus-4-8");
        assert_eq!(
            (evs[0].input, evs[0].output),
            (20, 7),
            "camelCase 候选字段名也要能取到"
        );
        // grok：_meta.usage 在 turn 结束通知里（params._meta 与 params.update._meta 两层都探）；
        // 无 usage 的行必须零事件不报错
        let lines = vec![
            r#"{"timestamp":1786005441,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"}}}}"#.to_string(),
            r#"{"timestamp":1786005442,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"你好"}}}}"#.to_string(),
            r#"{"timestamp":1786005443,"method":"session/update","params":{"_meta":{"totalTokens":999},"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}}}"#.to_string(),
        ];
        assert!(
            grok_events(&lines).is_empty(),
            "无 usage 对象的行（含流式 _meta.totalTokens）必须零事件不报错"
        );
        // params.update._meta 位置
        let lines = vec![
            r#"{"timestamp":1786005445,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"完成"},"_meta":{"usage":{"input_tokens":120,"output_tokens":30,"total_tokens":150,"cached_read_tokens":40,"modelUsage":{"grok-code-fast-1":{"input_tokens":120,"output_tokens":30,"cached_read_tokens":40}},"numTurns":1,"usageIsIncomplete":false}}}}}"#.to_string(),
        ];
        let evs = grok_events(&lines);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].day, day_of_ms(1786005445 * 1000), "unix 秒转日期");
        assert_eq!(
            evs[0].model, "grok-code-fast-1",
            "modelUsage 第一个键作模型名"
        );
        assert_eq!(
            (
                evs[0].input,
                evs[0].output,
                evs[0].cache_read,
                evs[0].cache_write
            ),
            (120, 30, 40, 0)
        );
        // params._meta 位置（兼容另一层）
        let lines = vec![
            r#"{"timestamp":1786005500,"method":"session/update","params":{"_meta":{"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"cached_read_tokens":2,"modelUsage":{"grok-4":{}},"numTurns":1}},"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}}}"#.to_string(),
        ];
        let evs = grok_events(&lines);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].model, "grok-4");
        assert_eq!((evs[0].input, evs[0].output, evs[0].cache_read), (10, 5, 2));
        // 实机：_x.ai/session/update 的 turn_completed，用量在 params.update.usage（camelCase）。
        // inputTokens 含缓存，入库时拆成未命中输入。
        let lines = vec![
            r#"{"timestamp":1786005600,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":1000,"outputTokens":50,"totalTokens":1050,"cachedReadTokens":400,"cacheCreationTokens":10,"reasoningTokens":80,"modelUsage":{"grok-4.7-build":{"inputTokens":1000,"outputTokens":50,"cachedReadTokens":400,"cacheCreationTokens":10}}}}}}"#.to_string(),
        ];
        let evs = grok_events(&lines);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].day, day_of_ms(1786005600 * 1000));
        assert_eq!(evs[0].model, "grok-4.7-build");
        assert_eq!(
            (
                evs[0].input,
                evs[0].output,
                evs[0].cache_read,
                evs[0].cache_write
            ),
            (590, 50, 400, 10),
            "inputTokens 去掉缓存读和缓存写"
        );
        // 同一回合两个模型各记各的，不把合计塞给第一个键
        let lines = vec![
            r#"{"timestamp":1786005700,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":300,"outputTokens":30,"cachedReadTokens":100,"modelUsage":{"grok-4.6":{"inputTokens":100,"outputTokens":10,"cachedReadTokens":40},"grok-4.6-build":{"inputTokens":200,"outputTokens":20,"cachedReadTokens":60}}}}}}"#.to_string(),
        ];
        let evs = grok_events(&lines);
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].model, "grok-4.6");
        assert_eq!(
            (evs[0].input, evs[0].output, evs[0].cache_read),
            (60, 10, 40)
        );
        assert_eq!(evs[1].model, "grok-4.6-build");
        assert_eq!(
            (evs[1].input, evs[1].output, evs[1].cache_read),
            (140, 20, 60)
        );
    }

    #[test]
    fn large_jsonl_and_zstd_sessions_are_streamed() {
        use std::io::{BufWriter, Write};

        let dir = std::env::temp_dir().join(format!("ccode-usage-stream-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let plain = dir.join("large.jsonl");
        let mut writer = BufWriter::new(File::create(&plain).unwrap());
        writeln!(writer, r#"{{"timestamp":"2026-08-04T04:00:00Z","type":"turn_context","payload":{{"model":"gpt-5-codex"}}}}"#).unwrap();
        let ignored = format!("{}\n", "x".repeat(1024));
        for _ in 0..10_300 {
            writer.write_all(ignored.as_bytes()).unwrap();
        }
        writeln!(writer, r#"{{"timestamp":"2026-08-04T04:01:00Z","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":100,"output_tokens":20,"reasoning_output_tokens":5,"cached_input_tokens":10}}}}}}}}"#).unwrap();
        writer.flush().unwrap();
        assert!(std::fs::metadata(&plain).unwrap().len() > 10 * 1024 * 1024);
        let events = extract_file_events("codex", &plain, None);
        assert_eq!(events.len(), 1, "大于旧 10 MB 上限的会话不得整份跳过");
        assert_eq!(
            (events[0].input, events[0].output, events[0].cache_read),
            (90, 20, 10)
        );

        let compressed = dir.join("small.jsonl.zst");
        let raw = std::fs::read(&plain).unwrap();
        std::fs::write(&compressed, zstd::stream::encode_all(&raw[..], 1).unwrap()).unwrap();
        let compressed_events = extract_file_events("codex", &compressed, None);
        assert_eq!(
            compressed_events, events,
            "zstd 会话必须同样流式解码并提取用量"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}

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
                           m.profile_id
                    FROM usage_daily d
                    LEFT JOIN session_meta m ON m.agent = d.agent AND m.session_id = d.session_id
                    WHERE d.day >= ?1",
        None => "SELECT d.agent, d.model, d.session_id, d.input, d.output, d.cache_read, d.cache_write, d.official,
                        m.profile_id
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
    for (agent, model, session_id, input, output, cr, cw, official, profile_id) in rows {
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
mod gateway_usage_tests {
    use super::*;
    use crate::profiles::{Binding, BindingKind, Gateway, ProtocolSlots};

    fn gw(id: &str, name: &str) -> Gateway {
        Gateway {
            id: id.into(),
            name: name.into(),
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
        }
    }

    fn bind(id: &str, agent: &str, gid: Option<&str>, kind: BindingKind) -> Binding {
        Binding {
            id: id.into(),
            agent: agent.into(),
            name: id.into(),
            kind,
            gateway_id: gid.map(|s| s.into()),
            protocol: None,
            api_backend: None,
            models: vec![],
            role_models: Default::default(),
            extra_env: Default::default(),
            last_used_at: None,
        }
    }

    #[test]
    fn usage_join_three_missing_buckets_and_live_gateway() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_daily(day TEXT, agent TEXT, model TEXT, project_path TEXT, session_id TEXT,
             input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, official INTEGER);
             CREATE TABLE session_meta(agent TEXT, session_id TEXT, profile_id TEXT);
             INSERT INTO usage_daily VALUES
             ('2026-08-30','claude-code','m','/p','s-gw',10,1,0,0,0),
             ('2026-08-30','codex','m','/p','s-none',20,2,0,0,0),
             ('2026-08-30','claude-code','m','/p','s-dead',30,3,0,0,0),
             ('2026-08-30','gemini','m','/p','s-off',40,4,0,0,1),
             ('2026-08-30','claude-code','m','/p','s-del',50,5,0,0,0);
             INSERT INTO session_meta VALUES
             ('claude-code','s-gw','b-live'),
             ('claude-code','s-dead','gone'),
             ('claude-code','s-del','b-del');",
        )
        .unwrap();
        let gws = vec![gw("g-live", "Zeta")];
        let bindings = vec![
            bind("b-live", "claude-code", Some("g-live"), BindingKind::Api),
            bind("b-del", "claude-code", Some("g-gone"), BindingKind::Api),
        ];
        let rows = usage_by_gateway_impl(&conn, "all", &bindings, &gws).unwrap();
        let live = rows.iter().find(|r| r.bucket == "gateway").unwrap();
        assert_eq!(live.gateway_name, "Zeta");
        assert_eq!(live.tokens_in, 10);
        let unlinked = rows.iter().find(|r| r.bucket == "unlinked").unwrap();
        assert_eq!(unlinked.tokens_in, 20 + 30); // no meta + deleted binding id
        let official = rows.iter().find(|r| r.bucket == "official").unwrap();
        assert_eq!(official.tokens_in, 40);
        let deleted = rows.iter().find(|r| r.bucket == "deleted").unwrap();
        assert!(deleted.gateway_name.contains("已删除网关"));
        assert_eq!(deleted.tokens_in, 50);
    }

    // ===== usage_activity（活跃度热力图） =====

    /// 直插一行 usage_daily：比 insert_daily 多 internal 与 cache_write 维度
    fn insert_activity_row(
        conn: &Connection,
        day: &str,
        agent: &str,
        model: &str,
        sid: &str,
        i: i64,
        o: i64,
        cr: i64,
        cw: i64,
        internal: bool,
        official: bool,
    ) {
        conn.execute(
            "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
             input, output, cache_read, cache_write, internal, official)
             VALUES (?1,?2,?3,'/p',?4,?5,?6,?7,?8,?9,?10)",
            rusqlite::params![
                day,
                agent,
                model,
                sid,
                i,
                o,
                cr,
                cw,
                i64::from(internal),
                i64::from(official),
            ],
        )
        .unwrap();
    }

    #[test]
    fn usage_activity_empty_db() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let dto =
            usage_activity_from(&conn, NaiveDate::from_ymd_opt(2026, 3, 15).unwrap(), &load_pricing(None))
                .unwrap();
        assert!(dto.days.is_empty());
        assert_eq!(dto.first_day, None);
        assert_eq!(dto.today, "2026-03-15");
        assert!(!dto.stale);
    }

    #[test]
    fn usage_activity_sums_main_and_splits_internal_official() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        // 同日：两个可计费会话（不同模型）+ 一条官方订阅行 + 一条内部行
        insert_activity_row(&conn, "2026-08-14", "codex", "gpt-5", "s1", 100, 10, 1000, 0, false, false);
        insert_activity_row(&conn, "2026-08-14", "claude-code", "claude-sonnet-4", "s2", 50, 5, 500, 0, false, false);
        insert_activity_row(&conn, "2026-08-14", "kimi", "kimi-k2", "s3", 30, 3, 300, 0, false, true);
        insert_activity_row(&conn, "2026-08-14", "claude-code", "claude-sonnet-4", "s4", 999, 99, 999, 9, true, false);
        let dto =
            usage_activity_from(&conn, NaiveDate::from_ymd_opt(2026, 8, 20).unwrap(), &load_pricing(None))
                .unwrap();
        assert_eq!(dto.days.len(), 1);
        let d = &dto.days[0];
        // 主量只计非 internal（billed + official 都在内）
        assert_eq!((d.input, d.output, d.cache_read, d.cache_write), (180, 18, 1800, 0));
        // 按天会话数 = 非 internal 不重复会话（billed 2 + official 1）
        assert_eq!(d.sessions, 3);
        // 官方/内部并列子计量（四类合计）
        assert_eq!(d.official_tokens, 333);
        assert_eq!(d.internal_tokens, 2106);
        assert_eq!(d.internal_sessions, 1);
        // 费用只计可计费行，且 > 0
        assert!(d.cost_usd.unwrap() > 0.0);
        assert_eq!(dto.first_day.as_deref(), Some("2026-08-14"));
    }

    #[test]
    fn usage_activity_skips_blank_and_future_days_and_keeps_ascending() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        insert_activity_row(&conn, "2026-08-02", "codex", "gpt-5", "s1", 10, 1, 0, 0, false, false);
        insert_activity_row(&conn, "2026-08-01", "codex", "gpt-5", "s1", 20, 2, 0, 0, false, false);
        // 空日（防御）与未来日（CLI 时钟漂移）都不得出现
        insert_activity_row(&conn, "", "codex", "gpt-5", "s2", 1, 1, 0, 0, false, false);
        insert_activity_row(&conn, "2026-09-05", "codex", "gpt-5", "s3", 1, 1, 0, 0, false, false);
        let dto =
            usage_activity_from(&conn, NaiveDate::from_ymd_opt(2026, 8, 14).unwrap(), &load_pricing(None))
                .unwrap();
        let days: Vec<&str> = dto.days.iter().map(|d| d.day.as_str()).collect();
        assert_eq!(days, vec!["2026-08-01", "2026-08-02"], "乱序插入仍升序，空/未来日被截掉");
        assert_eq!(dto.first_day.as_deref(), Some("2026-08-01"));
    }

    #[test]
    fn usage_activity_internal_only_day_stays_but_costs_zero() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        insert_activity_row(&conn, "2026-08-01", "claude-code", "claude-sonnet-4", "s1", 10, 1, 0, 0, true, false);
        let dto =
            usage_activity_from(&conn, NaiveDate::from_ymd_opt(2026, 8, 14).unwrap(), &load_pricing(None))
                .unwrap();
        assert_eq!(dto.days.len(), 1, "纯 internal 日保留行（开关打开时前端注记），主量为 0");
        let d = &dto.days[0];
        assert_eq!((d.input, d.sessions, d.internal_tokens), (0, 0, 11));
        assert_eq!(d.cost_usd, Some(0.0));
    }

    #[test]
    fn usage_activity_costs_none_when_unpriced_and_zero_when_official_only() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        // 全未计价模型：费用 None（前端 ~），不是 0
        insert_activity_row(&conn, "2026-08-01", "codex", "mystery-x", "s1", 100, 10, 0, 0, false, false);
        // 纯订阅日：无可计费行记 Some(0.0)
        insert_activity_row(&conn, "2026-08-02", "kimi", "kimi-k2", "s2", 30, 3, 300, 0, false, true);
        let dto =
            usage_activity_from(&conn, NaiveDate::from_ymd_opt(2026, 8, 14).unwrap(), &load_pricing(None))
                .unwrap();
        assert_eq!(dto.days[0].cost_usd, None);
        assert_eq!(dto.days[1].cost_usd, Some(0.0));
        assert!(dto.days[1].official_tokens > 0);
    }

    #[test]
    fn usage_day_detail_totals_match_activity_and_ranks_sessions() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let table = load_pricing(None);
        // 与 usage_activity_sums 同款数据：两会话可计费 + 一订阅 + 一内部
        insert_activity_row(&conn, "2026-08-14", "codex", "gpt-5", "s1", 100, 10, 1000, 0, false, false);
        insert_activity_row(&conn, "2026-08-14", "claude-code", "claude-sonnet-4", "s2", 50, 5, 500, 0, false, false);
        insert_activity_row(&conn, "2026-08-14", "kimi", "kimi-k2", "s3", 30, 3, 300, 0, false, true);
        insert_activity_row(&conn, "2026-08-14", "claude-code", "claude-sonnet-4", "s4", 999, 99, 999, 9, true, false);
        let today = NaiveDate::from_ymd_opt(2026, 8, 20).unwrap();
        let act = usage_activity_from(&conn, today, &table).unwrap();
        let det = usage_day_detail_from(&conn, "2026-08-14", &table).unwrap();
        // 总量与热力图格同口径
        assert_eq!(det.totals.input, act.days[0].input);
        assert_eq!(det.totals.sessions, act.days[0].sessions);
        assert_eq!(det.totals.official_tokens, act.days[0].official_tokens);
        assert_eq!(det.totals.internal_tokens, act.days[0].internal_tokens);
        assert_eq!(det.totals.cost_usd, act.days[0].cost_usd);
        // by_agent 只含非 internal，tokens 降序；codex(1110) > claude(555) > kimi(333)
        assert_eq!(
            det.by_agent.iter().map(|r| (r.agent.as_str(), r.tokens)).collect::<Vec<_>>(),
            vec![("codex", 1110), ("claude-code", 555), ("kimi", 333)]
        );
        // 会话四类合计降序、internal 沉底
        assert_eq!(
            det.sessions.iter().map(|s| s.session_id.as_str()).collect::<Vec<_>>(),
            vec!["s1", "s2", "s3", "s4"]
        );
        let s4 = det.sessions.last().unwrap();
        assert!(s4.internal && s4.cost_usd.is_none(), "内部会话不算费用");
        let s3 = det.sessions.iter().find(|s| s.session_id == "s3").unwrap();
        assert!(s3.official && s3.cost_usd.is_none(), "订阅会话不算费用");
        let s1 = det.sessions.iter().find(|s| s.session_id == "s1").unwrap();
        assert!(s1.cost_usd.unwrap() > 0.0);
        assert_eq!(s1.title, None, "无 session_meta 表时标题安全回落 None");
        // 空日：不炸、全零
        let empty = usage_day_detail_from(&conn, "2026-08-19", &table).unwrap();
        assert_eq!(empty.totals.sessions, 0);
        assert!(empty.sessions.is_empty());
    }

    #[test]
    fn usage_activity_agents_window_and_internal_excluded() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        insert_activity_row(&conn, "2025-12-31", "codex", "gpt-5", "s1", 10, 1, 0, 0, false, false);
        insert_activity_row(&conn, "2026-01-02", "codex", "gpt-5", "s2", 20, 2, 0, 0, false, false);
        insert_activity_row(&conn, "2026-01-02", "claude-code", "claude-sonnet-4", "s3", 40, 4, 0, 0, false, false);
        insert_activity_row(&conn, "2026-01-05", "kimi", "kimi-k2", "s4", 30, 3, 0, 0, false, false);
        insert_activity_row(&conn, "2026-01-06", "claude-code", "claude-sonnet-4", "s5", 999, 9, 0, 0, true, false);
        insert_activity_row(&conn, "2026-01-07", "codex", "gpt-5", "s6", 5, 0, 0, 0, false, false); // 未来日
        let dto = usage_activity_agents_from(
            &conn,
            2026,
            NaiveDate::from_ymd_opt(2026, 1, 6).unwrap(),
        )
        .unwrap();
        assert_eq!(dto.year, 2026);
        // agent 按年总量降序：claude(44) > kimi(33) > codex(22)；internal 与未来日不进
        assert_eq!(dto.agents, vec!["claude-code", "kimi", "codex"]);
        let d2 = dto.days.iter().find(|d| d.day == "2026-01-02").unwrap();
        assert_eq!(
            d2.by_agent.iter().map(|r| (r.agent.as_str(), r.tokens)).collect::<Vec<_>>(),
            vec![("claude-code", 44), ("codex", 22)]
        );
        assert!(!dto.days.iter().any(|d| d.day == "2026-01-07"), "未来日不进矩阵");
    }
}
