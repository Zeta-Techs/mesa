//! 订阅余量查询（用量页「订阅余量」卡，多供应商一张卡可切换）：
//! 智谱 GLM Coding Plan + Kimi For Coding + MiniMax Coding Plan（2026-09-19）；
//! Claude / Codex 官方账号的行在 `official_quota.rs`（2026-10-31），共用本模块的 DTO 与缓存。
//! 接口规格 = 四个开源实现交叉实证（cc-switch / OmniRoute / CodingPlanQuota / quotio-desktop）：
//! - 智谱额度：GET {base}/api/monitor/usage/quota/limit（团队版 ?type=2 + bigmodel-organization/project 头）
//!   Authorization: Bearer <key>（OmniRoute/quotio 口径；cc-switch 用裸 key 亦通，智谱两种都认）。
//!   data.level = 套餐；data.limits[] 只收 type ∈ TOKENS_LIMIT|CREDIT_LIMIT（积分制套餐，大小写不敏感），
//!   percentage = 已用 0-100，nextResetTime = 毫秒，unit 3 = 5 小时窗 / 6 = 周窗。
//!   窗口分类必须锚 unit，禁按重置时间排序代替——周期末尾周窗会比 5h 窗更早重置，时间排序必然标反
//!   （cc-switch issue #3036）；unit 缺失兜底：无 reset 的条目优先归 5h，其余按 reset 升序补位；
//!   老套餐（2026-02-12 前订阅）只回 1 条，自然降级为仅展示 5h。
//! - 智谱重置卡：GET {base}/api/biz/customer-package-reset/list?targetType=PERSONAL 报余额，
//!   POST {base}/api/biz/customer-package-reset/use 消费一张（body：targetType=PERSONAL /
//!   resetType=FIVE_HOUR|WEEK / recordId / requestId）。仅 OmniRoute 有实现，字段多别名防御：
//!   recordId|id|packageResetId|resetId、expireTime|expiredTime|expiresAt|endTime、
//!   status/state/outcome/result/code ∈ consumed|redeeming|redeemed|used|expired|unavailable 视为不可用；
//!   过期时间无时区时间戳（YYYY-MM-DD HH:mm:ss）分区域解析：bigmodel.cn 按北京时间 +8
//!   （2026-09-19 用户拿官网比对实测修正）、api.z.ai 按 UTC（OmniRoute 实证）。信封 fail-closed：
//!   success==true 且 code ∈ {0,200}；列表要求 fiveHourResets/weekResets 两桶都是数组
//!   （截断响应不得当作 0 张）；业务码 1001 = 密钥失效。
//! - Kimi For Coding：GET https://{api.kimi.com|api.kimi.ai}/coding/v1/usages（国内 / 国际站），Bearer。根级 limits[] 每项
//!   detail.limit/remaining 是「5 小时窗配额点数」（多模型各一窗），usage 是周限额；
//!   used = limit - remaining（下限 0），utilization = used/limit*100；resetTime 字符串/毫秒皆可。
//!   多个 5h 窗取 utilization 最高（最紧）的一个展示，其余不摊开（cc-switch 原样摊多条同名 tier，
//!   Mesa 卡片一窗一行，取最紧的不失真）。无重置卡接口。
//! - MiniMax：GET https://{api.minimaxi.com|api.minimax.io}/v1/api/openplatform/coding_plan/remains，
//!   Bearer。国内新推理域名 api.minimax.cn 同一账号体系，额度仍查 api.minimaxi.com（该接口只在旧域名有出处，
//!   cc-switch coding_plan.rs 同口径）。base_resp.status_code != 0 即业务错；model_remains[] 只取 model_name=="general"，
//!   字段是「剩余百分比」要反转为已用；周桶仅 current_weekly_status==1 才有（3 = 无周限额）。
//!   无重置卡接口。
//! - 火山方舟 Coding/Agent Plan 未接：查询走控制面 OpenAPI 需 IAM AK/SK 签名，与网关单密钥
//!   模型不符（网关要先加 AK/SK 字段），单独一批做。
//! - 智谱团队版从网关 headerEnv 的 bigmodel-organization / bigmodel-project 隐式识别（无显式表单）。
//! 纪律：密钥只在本模块出 keys.json，绝不进 DTO/日志；用卡是消费性写操作——只经显式命令触发、
//! 前端必须确认弹窗，成功后作废该网关缓存；查询不注出网代理（与网关体检同口径）；无后台轮询，
//! 用量页可见时每 2 分钟自动查（TTL 与之对齐），手动刷新才 force，瞬时失败回落上次成功值并标 fromCache。

use crate::profiles::{Gateway, ProtocolSlots};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const QUOTA_PATH: &str = "/api/monitor/usage/quota/limit";
const RESET_CARD_PATH: &str = "/api/biz/customer-package-reset";
const KIMI_USAGE_URL: &str = "https://api.kimi.com/coding/v1/usages";
const KIMI_GLOBAL_USAGE_URL: &str = "https://api.kimi.ai/coding/v1/usages";
const MINIMAX_QUOTA_PATH: &str = "/v1/api/openplatform/coding_plan/remains";
/// 进程内缓存 TTL：与前端用量页可见期 2 分钟自动轮询对齐（缓存挡的是秒级重复进页，
/// 不是省轮询）；页面不可见/后台不轮询
const CACHE_TTL_MS: i64 = 2 * 60 * 1000;
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
/// 用户给的智谱 Coding Plan 控制台入口（「去控制台」深链）
const ZHIPU_CONSOLE_URL: &str = "https://bigmodel.cn/coding-plan/personal/usage";

pub const WINDOW_FIVE_HOUR: &str = "five_hour";
pub const WINDOW_WEEKLY: &str = "weekly";
/// 月窗：目前只有 Codex 免费档（30 天窗，official_quota.rs）
pub const WINDOW_MONTHLY: &str = "monthly";

// ===== DTO（camelCase 出站；绝无密钥字段） =====

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanQuotaWindowDto {
    pub window: String,
    /// 已用百分比 0-100
    pub used_percent: f64,
    /// 重置时间（毫秒 epoch）
    pub resets_at: Option<i64>,
    /// 已用/总量的绝对值（智谱积分、Kimi 配额点数）；只给百分比的供应商（MiniMax）为 None。
    /// 前端只在两个都有值时展示——只有总量没已用等于没说
    pub used: Option<f64>,
    pub total: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanResetCardsDto {
    pub ok: bool,
    pub five_hour: u32,
    pub weekly: u32,
    /// 每类最早过期的可用卡（毫秒 epoch）；use 命令按它优先消费，临期提示用户先用
    pub five_hour_expires_at: Option<i64>,
    pub weekly_expires_at: Option<i64>,
    pub last_five_hour_reset_at: Option<String>,
    pub last_week_reset_at: Option<String>,
    pub error: Option<String>,
    /// 不分窗口的重置卡（Codex：一张卡重置当下卡住你的那个窗口），智谱恒 0
    pub general: u32,
    pub general_expires_at: Option<i64>,
    /// 此刻能用的张数（Codex 只在额度被卡住后才 > 0）；None = 供应商不报这个数
    pub general_applicable: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanQuotaDto {
    pub gateway_id: String,
    pub gateway_name: String,
    /// 机器名：zhipu | kimi | minimax（显示名前端映射）
    pub provider: String,
    pub plan_level: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
    pub windows: Vec<PlanQuotaWindowDto>,
    /// 只有智谱有重置卡接口；false 时前端不渲染重置卡行
    pub reset_cards_supported: bool,
    pub reset_cards: PlanResetCardsDto,
    pub queried_at: i64,
    pub from_cache: bool,
    /// 「去控制台」打开的地址：按这一行的供应商和站点（国内 / 国际）给，前端不自己拼
    pub console_url: String,
}

// ===== 供应商识别（槽 URL 命中）与上下文 =====

#[derive(Debug, Clone, PartialEq)]
enum PlanProvider {
    Zhipu { region: ZhipuRegion },
    Kimi { global: bool },
    MiniMax { international: bool },
}

impl PlanProvider {
    fn id(&self) -> &'static str {
        match self {
            PlanProvider::Zhipu { .. } => "zhipu",
            PlanProvider::Kimi { .. } => "kimi",
            PlanProvider::MiniMax { .. } => "minimax",
        }
    }

    /// 控制台深链：智谱是用户给的用量页；Kimi 是 Kimi Code 控制台（套餐与按量的 Moonshot 开放平台
    /// 不是一个后台）；MiniMax 是套餐页（2026-10-31 实测旧路径 user-center/payment/... 跳到 console/plan）
    fn console_url(&self) -> &'static str {
        match self {
            PlanProvider::Zhipu { region: ZhipuRegion::Cn } => ZHIPU_CONSOLE_URL,
            PlanProvider::Zhipu { region: ZhipuRegion::International } => "https://z.ai/subscribe",
            PlanProvider::Kimi { global: false } => "https://www.kimi.com/code/console",
            PlanProvider::Kimi { global: true } => "https://www.kimi.ai/code/console",
            PlanProvider::MiniMax { international: true } => "https://platform.minimax.io/console/plan",
            PlanProvider::MiniMax { international: false } => "https://platform.minimax.cn/console/plan",
        }
    }

    fn supports_reset_cards(&self) -> bool {
        matches!(self, PlanProvider::Zhipu { .. })
    }
}

/// 槽 URL 命中订阅套餐网关：智谱 bigmodel.cn / api.z.ai；Kimi For Coding api.kimi.com（国内）/
/// api.kimi.ai（国际）；MiniMax minimaxi.com·minimax.cn（国内）/ minimax.io（国际）。普通按量付费端点不命中。
/// 前端 `plan-quota.ts gatewayHasPlanQuota` 同口径。
fn detect_plan_provider(slots: &ProtocolSlots) -> Option<PlanProvider> {
    let urls = [
        slots.anthropic.as_deref(),
        slots.openai.as_deref(),
        slots.responses.as_deref(),
        slots.gemini.as_deref(),
        slots.cursor.as_deref(),
    ];
    for url in urls.iter().flatten() {
        let u = url.to_lowercase();
        if u.contains("bigmodel.cn") {
            return Some(PlanProvider::Zhipu {
                region: ZhipuRegion::Cn,
            });
        }
        if u.contains("api.z.ai") {
            return Some(PlanProvider::Zhipu {
                region: ZhipuRegion::International,
            });
        }
        if u.contains("api.kimi.com") {
            return Some(PlanProvider::Kimi { global: false });
        }
        if u.contains("api.kimi.ai") {
            return Some(PlanProvider::Kimi { global: true });
        }
        if u.contains("minimax.io") {
            return Some(PlanProvider::MiniMax {
                international: true,
            });
        }
        if u.contains("minimaxi.com") || u.contains("minimax.cn") {
            return Some(PlanProvider::MiniMax {
                international: false,
            });
        }
    }
    None
}

// ===== 查询上下文（供应商 + 密钥 + 智谱团队头） =====

#[derive(Debug, Clone, PartialEq)]
enum ZhipuRegion {
    Cn,
    International,
}

impl ZhipuRegion {
    fn base(&self) -> &'static str {
        match self {
            ZhipuRegion::Cn => "https://open.bigmodel.cn",
            ZhipuRegion::International => "https://api.z.ai",
        }
    }

    /// 无时区时间戳的时区偏移：国内站北京时间、国际站 UTC（见 parse_card_timestamp_tz 注释）
    fn naive_tz_offset_hours(&self) -> i64 {
        match self {
            ZhipuRegion::Cn => 8,
            ZhipuRegion::International => 0,
        }
    }
}

#[derive(Debug, Clone)]
struct PlanCtx {
    provider: PlanProvider,
    key: String,
    organization: Option<String>,
    project: Option<String>,
}

/// 团队版隐式识别：网关自定义 Header 里带齐 bigmodel-organization / bigmodel-project 即团队版
fn team_headers(
    header_env: &std::collections::BTreeMap<String, String>,
) -> (Option<String>, Option<String>) {
    let get = |k: &str| {
        header_env
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(k))
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    (get("bigmodel-organization"), get("bigmodel-project"))
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ===== 额度解析（纯函数，单测覆盖） =====

#[derive(Debug, Clone, PartialEq)]
struct PlanWindow {
    window: &'static str,
    used_percent: f64,
    reset_ms: Option<i64>,
    /// 绝对值（智谱 currentValue/usage、Kimi limit/remaining）；只给百分比的供应商为 None
    used: Option<f64>,
    total: Option<f64>,
}

/// JSON 数值或字符串数值 → f64（智谱偶发字符串数字，cc-switch parse_f64 口径）
fn parse_f64(v: &serde_json::Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

/// 密钥失效的统一文案（智谱业务码 1001 / MiniMax 1004 / HTTP 401·403 三条路都归到这里）
const KEY_INVALID_MSG: &str = "密钥失效，请到连接页更新这个网关的密钥";

fn parse_zhipu_quota(
    body: &serde_json::Value,
) -> Result<(Option<String>, Vec<PlanWindow>), String> {
    if body.get("success").and_then(|v| v.as_bool()) == Some(false) {
        // 业务码 1001 = 鉴权失败（无 key 实测：HTTP 200 包 {code:1001, success:false}）
        if body.get("code").and_then(|v| v.as_i64()) == Some(1001) {
            return Err(KEY_INVALID_MSG.into());
        }
        let msg = body
            .get("msg")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(format!("智谱接口错误: {msg}"));
    }
    let data = body
        .get("data")
        .ok_or_else(|| "响应缺少 data 字段".to_string())?;
    let level = data
        .get("level")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let limits = data
        .get("limits")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "响应缺少 limits 字段".to_string())?;

    let mut five_hour: Option<PlanWindow> = None;
    let mut weekly: Option<PlanWindow> = None;
    let mut unclassified: Vec<PlanWindow> = Vec::new();
    for item in limits {
        let kind = item
            .get("type")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_ascii_uppercase())
            .unwrap_or_default();
        if kind != "TOKENS_LIMIT" && kind != "CREDIT_LIMIT" {
            continue;
        }
        let percentage = item.get("percentage").and_then(parse_f64).unwrap_or(0.0);
        let reset_ms = item
            .get("nextResetTime")
            .and_then(|v| v.as_i64())
            .filter(|v| *v > 0);
        // 绝对值：currentValue = 已用、usage = 总量（积分制套餐实测字段，2026-09-21）；
        // 缺任一个都不展示（前端按两个都有值才算）
        let used = item.get("currentValue").and_then(parse_f64);
        let total = item.get("usage").and_then(parse_f64);
        let mut entry = PlanWindow {
            window: WINDOW_FIVE_HOUR,
            used_percent: percentage,
            reset_ms,
            used,
            total,
        };
        match item.get("unit").and_then(|v| v.as_i64()) {
            Some(3) if five_hour.is_none() => five_hour = Some(entry),
            // 归周窗必须**改窗名**：PlanWindow 现在自带 window 字段（旧版是 push 时才贴标签），
            // 漏这一行两根条都会写「5 小时」（2026-09-21 重构时踩到，单测逮住）
            Some(6) if weekly.is_none() => {
                entry.window = WINDOW_WEEKLY;
                weekly = Some(entry);
            }
            _ => unclassified.push(entry),
        }
    }
    // 兜底启发式：无 reset 的优先归 5h（0% 状态可能没有 reset），其余按 reset 升序补位
    unclassified.sort_by_key(|w| w.reset_ms.unwrap_or(i64::MIN));
    for mut entry in unclassified {
        if five_hour.is_none() {
            entry.window = WINDOW_FIVE_HOUR;
            five_hour = Some(entry);
        } else if weekly.is_none() {
            entry.window = WINDOW_WEEKLY;
            weekly = Some(entry);
        }
    }
    let mut windows = Vec::new();
    if let Some(w) = five_hour {
        windows.push(w);
    }
    if let Some(w) = weekly {
        windows.push(w);
    }
    Ok((level, windows))
}

// ===== Kimi / MiniMax 额度解析（纯函数，口径 = cc-switch query_kimi / parse_minimax_tiers） =====

/// resetTime 兼容：数字按秒（<1e12）/毫秒区分；字符串走 ISO / z.ai 无时区解析
fn extract_reset_ms(v: &serde_json::Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        if n <= 0 {
            return None;
        }
        return Some(if n < 1_000_000_000_000 { n * 1000 } else { n });
    }
    v.as_str().and_then(|s| parse_card_timestamp_tz(s, 0))
}

/// Kimi：根级 limits[] 每项一模型一个 5 小时窗（limit/remaining 是配额点数），
/// 取 utilization 最紧的一个；usage 是周限额。响应无信封，缺字段按 0 额度算。
fn parse_kimi_quota(body: &serde_json::Value) -> Result<Vec<PlanWindow>, String> {
    let mut best_five: Option<PlanWindow> = None;
    if let Some(limits) = body.get("limits").and_then(|v| v.as_array()) {
        for item in limits {
            let Some(detail) = item.get("detail") else {
                continue;
            };
            // 百分比口径保持原样（缺 limit 按 1.0 兜底 → 报文残缺时显示 100% 而不是假装没用）；
            // 绝对值只在字段真的给了才带（total = limit 原值）
            let limit_given = detail.get("limit").and_then(parse_f64);
            let limit = limit_given.unwrap_or(1.0);
            let remaining = detail.get("remaining").and_then(parse_f64).unwrap_or(0.0);
            let used = (limit - remaining).max(0.0);
            let utilization = if limit > 0.0 {
                used / limit * 100.0
            } else {
                0.0
            };
            let reset_ms = detail.get("resetTime").and_then(extract_reset_ms);
            let candidate = PlanWindow {
                window: WINDOW_FIVE_HOUR,
                used_percent: utilization,
                reset_ms,
                used: limit_given.map(|_| used),
                total: limit_given,
            };
            if best_five
                .as_ref()
                .map_or(true, |cur| candidate.used_percent > cur.used_percent)
            {
                best_five = Some(candidate);
            }
        }
    }
    let mut windows = Vec::new();
    if let Some(w) = best_five {
        windows.push(w);
    }
    if let Some(usage) = body.get("usage") {
        let limit_given = usage.get("limit").and_then(parse_f64);
        let limit = limit_given.unwrap_or(1.0);
        let remaining = usage.get("remaining").and_then(parse_f64).unwrap_or(0.0);
        let used = (limit - remaining).max(0.0);
        let utilization = if limit > 0.0 {
            used / limit * 100.0
        } else {
            0.0
        };
        windows.push(PlanWindow {
            window: WINDOW_WEEKLY,
            used_percent: utilization,
            reset_ms: usage.get("resetTime").and_then(extract_reset_ms),
            used: limit_given.map(|_| used),
            total: limit_given,
        });
    }
    if windows.is_empty() {
        return Err("Kimi 响应里没有可用的额度字段".into());
    }
    Ok(windows)
}

/// MiniMax：base_resp.status_code != 0 即业务错；model_remains[] 只取 general 条目，
/// 字段是「剩余百分比」反转成已用；周桶仅 current_weekly_status==1 才有（3 = 无周限额）。
fn parse_minimax_quota(body: &serde_json::Value) -> Result<Vec<PlanWindow>, String> {
    if let Some(base) = body.get("base_resp") {
        let code = base
            .get("status_code")
            .and_then(|v| v.as_i64())
            .unwrap_or(-1);
        if code != 0 {
            // 1004 = 鉴权失败（无 key 实测）；其余透传原文
            if code == 1004 {
                return Err(KEY_INVALID_MSG.into());
            }
            let msg = base
                .get("status_msg")
                .and_then(|v| v.as_str())
                .unwrap_or("未知错误");
            return Err(format!("MiniMax 接口错误 (code {code}): {msg}"));
        }
    }
    let item = body
        .get("model_remains")
        .and_then(|v| v.as_array())
        .and_then(|rows| {
            rows.iter()
                .find(|r| r.get("model_name").and_then(|m| m.as_str()) == Some("general"))
        })
        .ok_or_else(|| "MiniMax 响应缺少 general 额度条目".to_string())?;
    let mut windows = Vec::new();
    if let Some(remain) = item
        .get("current_interval_remaining_percent")
        .and_then(|v| v.as_f64())
    {
        windows.push(PlanWindow {
            window: WINDOW_FIVE_HOUR,
            used_percent: 100.0 - remain,
            reset_ms: item
                .get("end_time")
                .and_then(|v| v.as_i64())
                .filter(|v| *v > 0),
            // 这家只回百分比，没有绝对额度可展示
            used: None,
            total: None,
        });
    }
    if item.get("current_weekly_status").and_then(|v| v.as_i64()) == Some(1) {
        if let Some(remain) = item
            .get("current_weekly_remaining_percent")
            .and_then(|v| v.as_f64())
        {
            windows.push(PlanWindow {
                window: WINDOW_WEEKLY,
                used_percent: 100.0 - remain,
                reset_ms: item
                    .get("weekly_end_time")
                    .and_then(|v| v.as_i64())
                    .filter(|v| *v > 0),
                used: None,
                total: None,
            });
        }
    }
    if windows.is_empty() {
        return Err("MiniMax 响应里没有可用的额度字段".into());
    }
    Ok(windows)
}

// ===== 重置卡解析（纯函数，单测覆盖；口径 = OmniRoute glmResetCards.ts） =====

#[derive(Debug, Clone, PartialEq)]
struct ZhipuCard {
    record_id: String,
    /// FIVE_HOUR | WEEK
    reset_type: String,
    expire_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct ZhipuCards {
    five_hour: Vec<ZhipuCard>,
    weekly: Vec<ZhipuCard>,
    last_five_hour_reset_at: Option<String>,
    last_week_reset_at: Option<String>,
}

/// 无时区时间戳（YYYY-MM-DD HH:mm:ss[.fff]，结尾无其它字符）按给定时区偏移解析；
/// 常规 ISO 8601（带时区/偏移）走 chrono 不受偏移影响。先 RFC3339 后无时区形态，
/// 避免把带 Z/偏移的合法 ISO 误吞进无时区分支丢毫秒（OmniRoute 正则锚定 $ 的同款纪律）。
/// 偏移口径（2026-09-19 用户拿官网比对实测修正）：bigmodel.cn 无时区时间戳是北京时间（+8）；
/// api.z.ai 按 UTC（OmniRoute 实证）。写死 +8 而非读本机时区——CI/异地机器结果必须一致。
fn parse_card_timestamp_tz(value: &str, tz_offset_hours: i64) -> Option<i64> {
    let t = value.trim();
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(t) {
        return Some(dt.timestamp_millis());
    }
    let normalized = t.replace('T', " ");
    let parts: Vec<&str> = normalized.split(' ').collect();
    if parts.len() != 2 {
        return None;
    }
    let all_digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    let date: Vec<i64> = parts[0]
        .split('-')
        .map(str::trim)
        .filter(|s| all_digits(s))
        .filter_map(|s| s.parse().ok())
        .collect();
    if date.len() != 3 {
        return None;
    }
    let (hms_raw, frac_raw) = match parts[1].split_once('.') {
        Some((h, f)) => (h, Some(f)),
        None => (parts[1], None),
    };
    let hms: Vec<&str> = hms_raw.split(':').collect();
    if hms.len() != 3 || !hms.iter().all(|s| all_digits(s)) {
        return None;
    }
    let time: Vec<i64> = hms.iter().filter_map(|s| s.parse().ok()).collect();
    if time.len() != 3 {
        return None;
    }
    let millis: i64 = match frac_raw {
        Some(f) if all_digits(f) && f.len() <= 3 => {
            let padded = format!("{f:0<3}");
            padded[..3].parse().unwrap_or(0)
        }
        Some(_) => return None,
        None => 0,
    };
    // 公历 → UTC 毫秒（days_from_civil 算法，无闰秒外推）
    let (y, m, d) = (date[0], date[1], date[2]);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y_adj = if m <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(
        (days * 86400 + time[0] * 3600 + time[1] * 60 + time[2]) * 1000 + millis
            - tz_offset_hours * 3_600_000,
    )
}

/// 多别名取首个非空字符串字段
fn card_string(record: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| {
        record
            .get(*k)
            .and_then(|v| {
                v.as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .or_else(|| v.as_f64().map(|n| format_number_id(n)))
            })
            .filter(|s| !s.is_empty())
    })
}

/// 数值 id 去掉小数尾巴（智谱 recordId 可能以 number 出现，use 接口要原值）
fn format_number_id(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        format!("{}", n as i64)
    } else {
        n.to_string()
    }
}

/// status/state/outcome/result/code 归一小写去非字母数字后比对不可用集合
fn card_unavailable(record: &serde_json::Value) -> bool {
    let status_keys = ["status", "state", "outcome", "result", "code"];
    for key in status_keys {
        let normalized: String = record
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| {
                s.trim()
                    .to_lowercase()
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric())
                    .collect()
            })
            .unwrap_or_default();
        if [
            "consumed",
            "redeeming",
            "redeemed",
            "used",
            "expired",
            "unavailable",
        ]
        .contains(&normalized.as_str())
        {
            return true;
        }
    }
    if record.get("available").and_then(|v| v.as_bool()) == Some(false) {
        return true;
    }
    if record.get("consumed").and_then(|v| v.as_bool()) == Some(true) {
        return true;
    }
    if record.get("redeemed").and_then(|v| v.as_bool()) == Some(true) {
        return true;
    }
    false
}

/// 信封校验（fail-closed）：success==true 且 code 为数字且 ∈ {0,200}
fn envelope_ok(body: &serde_json::Value) -> bool {
    if body.get("success").and_then(|v| v.as_bool()) != Some(true) {
        return false;
    }
    match body.get("code").and_then(|v| v.as_i64()) {
        Some(0) | Some(200) => true,
        _ => false,
    }
}

fn envelope_error(body: &serde_json::Value) -> String {
    let msg = body
        .get("msg")
        .or_else(|| body.get("message"))
        .and_then(|v| v.as_str())
        .unwrap_or("响应格式异常");
    // 业务码 1001 = 密钥失效（OmniRoute 口径 + 本机无 key 实测）
    if body.get("code").and_then(|v| v.as_i64()) == Some(1001) {
        return KEY_INVALID_MSG.into();
    }
    format!("智谱接口错误: {msg}")
}

fn parse_card_entry(
    value: &serde_json::Value,
    fallback_type: &str,
    now: i64,
    tz_offset_hours: i64,
) -> Option<ZhipuCard> {
    let record = value.as_object()?;
    if record.is_empty() || card_unavailable(value) {
        return None;
    }
    let record_id = card_string(value, &["recordId", "id", "packageResetId", "resetId"])?;
    let expire_ms = card_string(
        value,
        &["expireTime", "expiredTime", "expiresAt", "endTime"],
    )
    .and_then(|s| parse_card_timestamp_tz(&s, tz_offset_hours));
    if let Some(exp) = expire_ms {
        if exp <= now {
            return None;
        }
    }
    let reset_type = value
        .get("resetType")
        .or_else(|| value.get("type"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_uppercase())
        .filter(|s| s == "FIVE_HOUR" || s == "WEEK")
        .unwrap_or_else(|| fallback_type.to_string());
    Some(ZhipuCard {
        record_id,
        reset_type,
        expire_ms,
    })
}

/// 一类卡里最早过期的可用卡（列表已按过期升序；无过期时间的卡不算临期）
fn earliest_expiry(cards: &[ZhipuCard]) -> Option<i64> {
    cards.iter().filter_map(|c| c.expire_ms).min()
}

fn parse_zhipu_cards(
    body: &serde_json::Value,
    now: i64,
    tz_offset_hours: i64,
) -> Result<ZhipuCards, String> {
    if !envelope_ok(body) {
        return Err(envelope_error(body));
    }
    let data = body
        .get("data")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "重置卡响应缺少 data".to_string())?;
    // 双桶必须都是数组：截断响应不得当作 0 张（fail-closed）
    let (five_raw, week_raw) = (
        data.get("fiveHourResets").and_then(|v| v.as_array()),
        data.get("weekResets").and_then(|v| v.as_array()),
    );
    let (five_raw, week_raw) = match (five_raw, week_raw) {
        (Some(f), Some(w)) => (f, w),
        _ => return Err("重置卡响应不完整（缺少重置卡列表）".into()),
    };
    let mut out = ZhipuCards {
        five_hour: five_raw
            .iter()
            .filter_map(|v| parse_card_entry(v, "FIVE_HOUR", now, tz_offset_hours))
            .collect(),
        weekly: week_raw
            .iter()
            .filter_map(|v| parse_card_entry(v, "WEEK", now, tz_offset_hours))
            .collect(),
        last_five_hour_reset_at: None,
        last_week_reset_at: None,
    };
    // 按过期时间升序：越早过期的越先用（OmniRoute getExpirySortValue 口径；无过期时间排最后）
    let by_expiry = |a: &ZhipuCard, b: &ZhipuCard| {
        a.expire_ms
            .unwrap_or(i64::MAX)
            .cmp(&b.expire_ms.unwrap_or(i64::MAX))
    };
    out.five_hour.sort_by(by_expiry);
    out.weekly.sort_by(by_expiry);
    if let Some(data_v) = body.get("data") {
        out.last_five_hour_reset_at = card_string(data_v, &["lastFiveHourResetTime"]);
        out.last_week_reset_at = card_string(data_v, &["lastWeekResetTime"]);
    }
    Ok(out)
}

// ===== HTTP 层 =====

struct HttpOutcome {
    status: u16,
    body: serde_json::Value,
}

fn map_http_error(outcome: &HttpOutcome, body_text: &str) -> String {
    if outcome.status == 401 || outcome.status == 403 {
        return KEY_INVALID_MSG.into();
    }
    // 优先取业务信封里的 msg（body 可能是 JSON 错误信封）
    if let Some(msg) = outcome
        .body
        .get("msg")
        .or_else(|| outcome.body.get("message"))
        .and_then(|v| v.as_str())
    {
        if outcome.body.get("code").and_then(|v| v.as_i64()) == Some(1001) {
            return KEY_INVALID_MSG.into();
        }
        return format!("智谱接口错误 (HTTP {}): {msg}", outcome.status);
    }
    format!("智谱接口错误 (HTTP {}): {}", outcome.status, body_text)
}

/// 共享 HTTP 客户端：review 前每次请求都新建 Client，等于每次重新 TLS 握手；
/// 复用连接池后同站第二路（智谱的额度 + 重置卡）省一次握手。
fn http_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(HTTP_TIMEOUT)
                .pool_idle_timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        })
        .clone()
}

async fn plan_get(url: &str, ctx: &PlanCtx, team: bool) -> Result<HttpOutcome, String> {
    let client = http_client();
    let mut req = client
        .get(url)
        .header("Authorization", format!("Bearer {}", ctx.key))
        .header("Accept", "application/json");
    if team {
        if let Some(org) = &ctx.organization {
            req = req.header("bigmodel-organization", org);
        }
        if let Some(project) = &ctx.project {
            req = req.header("bigmodel-project", project);
        }
    }
    let resp = req.send().await.map_err(|e| format!("网络错误: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    let body = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    Ok(HttpOutcome { status, body })
}

async fn plan_post_json(
    url: &str,
    ctx: &PlanCtx,
    team: bool,
    payload: &serde_json::Value,
) -> Result<HttpOutcome, String> {
    let client = http_client();
    let mut req = client
        .post(url)
        .header("Authorization", format!("Bearer {}", ctx.key))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json");
    if team {
        if let Some(org) = &ctx.organization {
            req = req.header("bigmodel-organization", org);
        }
        if let Some(project) = &ctx.project {
            req = req.header("bigmodel-project", project);
        }
    }
    let resp = req
        .json(payload)
        .send()
        .await
        .map_err(|e| format!("网络错误: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    let body = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    Ok(HttpOutcome { status, body })
}

// ===== 查询编排 + 缓存 =====

struct CacheEntry {
    dto: PlanQuotaDto,
    at: i64,
}

fn quota_cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_team(ctx: &PlanCtx) -> bool {
    ctx.organization.is_some() && ctx.project.is_some()
}

/// 请求 + 解析的小公共层：2xx 才进解析，其余归一为错误文案
async fn fetch_and_parse<F>(
    url: &str,
    ctx: &PlanCtx,
    team: bool,
    parse: F,
) -> Result<(Option<String>, Vec<PlanWindow>), String>
where
    F: FnOnce(serde_json::Value) -> Result<(Option<String>, Vec<PlanWindow>), String>,
{
    match plan_get(url, ctx, team).await {
        Ok(outcome) if outcome.status >= 200 && outcome.status < 300 => parse(outcome.body),
        Ok(outcome) => Err(map_http_error(&outcome, "请求失败")),
        Err(e) => Err(e),
    }
}

/// 查单个网关：额度 +（仅智谱）重置卡。额度失败时整行回落缓存（fromCache），重置卡失败只降级该字段。
async fn refresh_gateway(gateway: &Gateway, ctx: &PlanCtx) -> PlanQuotaDto {
    let mut dto = PlanQuotaDto {
        gateway_id: gateway.id.clone(),
        gateway_name: gateway.name.clone(),
        provider: ctx.provider.id().into(),
        plan_level: None,
        ok: false,
        error: None,
        windows: Vec::new(),
        reset_cards_supported: ctx.provider.supports_reset_cards(),
        reset_cards: PlanResetCardsDto::default(),
        queried_at: now_ms(),
        from_cache: false,
        console_url: ctx.provider.console_url().into(),
    };
    // 1) 额度（按供应商分派端点与解析器）
    let quota = match &ctx.provider {
        PlanProvider::Zhipu { region } => {
            let team = is_team(ctx);
            let mut url = format!("{}{}", region.base(), QUOTA_PATH);
            if team {
                url.push_str("?type=2");
            }
            fetch_and_parse(&url, ctx, team, |body| parse_zhipu_quota(&body)).await
        }
        PlanProvider::Kimi { global } => {
            let url = if *global { KIMI_GLOBAL_USAGE_URL } else { KIMI_USAGE_URL };
            fetch_and_parse(url, ctx, false, |body| {
                parse_kimi_quota(&body).map(|w| (None, w))
            })
            .await
        }
        PlanProvider::MiniMax { international } => {
            let domain = if *international {
                "api.minimax.io"
            } else {
                "api.minimaxi.com"
            };
            let url = format!("https://{domain}{MINIMAX_QUOTA_PATH}");
            fetch_and_parse(&url, ctx, false, |body| {
                parse_minimax_quota(&body).map(|w| (None, w))
            })
            .await
        }
    };
    match quota {
        Ok((level, windows)) => {
            dto.ok = true;
            dto.plan_level = level;
            dto.windows = windows
                .into_iter()
                .map(|w| PlanQuotaWindowDto {
                    window: w.window.to_string(),
                    used_percent: w.used_percent,
                    resets_at: w.reset_ms,
                    used: w.used,
                    total: w.total,
                })
                .collect();
        }
        Err(e) => dto.error = Some(e),
    }
    // 2) 重置卡（仅智谱；额度都失败时仍尝试：卡数独立有用；失败只降级该字段不拖垮整行）
    if let PlanProvider::Zhipu { region } = &ctx.provider {
        let team = is_team(ctx);
        let cards_url = format!(
            "{}{}/list?targetType=PERSONAL",
            region.base(),
            RESET_CARD_PATH
        );
        match plan_get(&cards_url, ctx, team).await {
            Ok(outcome) if outcome.status >= 200 && outcome.status < 300 => {
                match parse_zhipu_cards(&outcome.body, now_ms(), region.naive_tz_offset_hours()) {
                    Ok(cards) => {
                        dto.reset_cards = PlanResetCardsDto {
                            ok: true,
                            five_hour: cards.five_hour.len() as u32,
                            weekly: cards.weekly.len() as u32,
                            five_hour_expires_at: earliest_expiry(&cards.five_hour),
                            weekly_expires_at: earliest_expiry(&cards.weekly),
                            last_five_hour_reset_at: cards.last_five_hour_reset_at,
                            last_week_reset_at: cards.last_week_reset_at,
                            error: None,
                            ..PlanResetCardsDto::default()
                        };
                    }
                    Err(e) => {
                        dto.reset_cards.error = Some(e);
                    }
                }
            }
            Ok(outcome) => {
                dto.reset_cards.error = Some(map_http_error(&outcome, "请求失败"));
            }
            Err(e) => dto.reset_cards.error = Some(e),
        }
    }
    dto
}

/// 订阅套餐网关识别 + 密钥装配；命中返回上下文，未命中返回 None
fn plan_ctx_for(gateway: &Gateway) -> Result<Option<PlanCtx>, String> {
    let Some(provider) = detect_plan_provider(&gateway.slots) else {
        return Ok(None);
    };
    let key = crate::profiles::get_key(&gateway.id)?;
    let Some(key) = key.filter(|k| !k.trim().is_empty()) else {
        return Ok(Some(PlanCtx {
            provider,
            key: String::new(),
            organization: None,
            project: None,
        }));
    };
    let (organization, project) = team_headers(&gateway.header_env);
    Ok(Some(PlanCtx {
        provider,
        key,
        organization,
        project,
    }))
}

pub(crate) fn cache_get(gateway_id: &str, now: i64) -> Option<PlanQuotaDto> {
    quota_cache().lock().ok().and_then(|map| {
        map.get(gateway_id)
            .filter(|e| now - e.at <= CACHE_TTL_MS)
            .map(|e| e.dto.clone())
    })
}

fn cache_get_stale(gateway_id: &str) -> Option<PlanQuotaDto> {
    quota_cache()
        .lock()
        .ok()
        .and_then(|map| map.get(gateway_id).map(|e| e.dto.clone()))
}

fn cache_put(dto: &PlanQuotaDto) {
    if let Ok(mut map) = quota_cache().lock() {
        map.insert(
            dto.gateway_id.clone(),
            CacheEntry {
                dto: dto.clone(),
                at: now_ms(),
            },
        );
    }
}

pub(crate) fn cache_invalidate(gateway_id: &str) {
    if let Ok(mut map) = quota_cache().lock() {
        map.remove(gateway_id);
    }
}

/// 用量页「订阅余量」总览：扫全部网关，套餐网关命中才出卡；命中行 2 分钟缓存（对齐前端轮询）。
///
/// 多网关并发（与 gateway_balance_overview 同口径）：先 spawn 全部再按序收，
/// 等待 ≈ 最慢的一家，不是各家相加（配了智谱 + Kimi + MiniMax 时差别明显）。
#[tauri::command]
pub async fn plan_quota_overview(force: Option<bool>) -> Vec<PlanQuotaDto> {
    let force = force.unwrap_or(false);
    // 官方账号（Claude / Codex）与网关行并发查，排在网关行后面
    let official = tauri::async_runtime::spawn(crate::official_quota::official_rows(force));
    let gateways = crate::gateway_store::load_gateways().unwrap_or_default();
    let mut rows: Vec<Option<PlanQuotaDto>> = (0..gateways.len()).map(|_| None).collect();
    let mut jobs: Vec<(usize, Gateway, PlanCtx)> = Vec::new();
    let mut cursor = 0usize;
    for gateway in gateways {
        let idx = cursor;
        cursor += 1;
        let detected = detect_plan_provider(&gateway.slots);
        let ctx = match plan_ctx_for(&gateway) {
            Ok(Some(ctx)) => ctx,
            Ok(None) => continue,
            Err(e) => {
                // keys.json 读失败：出错行，不静默隐藏（用户加了套餐网关就该看到为什么没数据）
                rows[idx] = Some(PlanQuotaDto {
                    gateway_id: gateway.id.clone(),
                    gateway_name: gateway.name.clone(),
                    provider: detected.as_ref().map(|p| p.id().to_string()).unwrap_or_default(),
                    plan_level: None,
                    ok: false,
                    error: Some(format!("读取密钥失败: {e}")),
                    windows: Vec::new(),
                    reset_cards_supported: detected.as_ref().is_some_and(|p| p.supports_reset_cards()),
                    reset_cards: PlanResetCardsDto::default(),
                    queried_at: now_ms(),
                    from_cache: false,
                    console_url: detected.as_ref().map(|p| p.console_url().to_string()).unwrap_or_default(),
                });
                continue;
            }
        };
        if ctx.key.is_empty() {
            rows[idx] = Some(PlanQuotaDto {
                gateway_id: gateway.id.clone(),
                gateway_name: gateway.name.clone(),
                provider: ctx.provider.id().into(),
                plan_level: None,
                ok: false,
                error: Some("网关未保存密钥，到连接页填写后可查订阅余量".into()),
                windows: Vec::new(),
                reset_cards_supported: ctx.provider.supports_reset_cards(),
                reset_cards: PlanResetCardsDto::default(),
                queried_at: now_ms(),
                from_cache: false,
                console_url: ctx.provider.console_url().into(),
            });
            continue;
        }
        if !force {
            if let Some(hit) = cache_get(&gateway.id, now_ms()) {
                rows[idx] = Some(hit);
                continue;
            }
        }
        jobs.push((idx, gateway, ctx));
    }

    let handles: Vec<_> = jobs
        .into_iter()
        .map(|(idx, gateway, ctx)| {
            tauri::async_runtime::spawn(async move {
                let dto = refresh_gateway(&gateway, &ctx).await;
                (idx, dto)
            })
        })
        .collect();

    for handle in handles {
        let Ok((idx, dto)) = handle.await else {
            continue;
        };
        rows[idx] = Some(settle_fresh(dto));
    }
    let mut out: Vec<PlanQuotaDto> = rows.into_iter().flatten().collect();
    if let Ok(official) = official.await {
        out.extend(official);
    }
    out
}

/// 刚查回的一行入缓存；失败时回落上次成功值（标 fromCache），不拿错误行盖掉好数据
pub(crate) fn settle_fresh(mut dto: PlanQuotaDto) -> PlanQuotaDto {
    if !dto.ok {
        if let Some(prev) = cache_get_stale(&dto.gateway_id).filter(|p| p.ok) {
            let queried_at = prev.queried_at;
            dto = prev;
            dto.from_cache = true;
            dto.queried_at = queried_at;
        }
    } else {
        cache_put(&dto);
    }
    dto
}

/// 用一张重置卡（消费性写操作）：显式命令触发，前端必须确认弹窗。
/// 服务端挑该类型最早过期的可用卡消费；成功后作废缓存并返回刷新后的余量。
#[tauri::command]
pub async fn plan_use_reset_card(
    gateway_id: String,
    reset_type: String,
) -> Result<PlanQuotaDto, String> {
    if gateway_id == crate::official_quota::CODEX_ROW_ID {
        return crate::official_quota::use_codex_reset_card().await;
    }
    let api_type = match reset_type.as_str() {
        "five_hour" => "FIVE_HOUR",
        "weekly" => "WEEK",
        _ => return Err("未知的重置卡类型".into()),
    };
    let gateways = crate::gateway_store::load_gateways().unwrap_or_default();
    let gateway = gateways
        .into_iter()
        .find(|g| g.id == gateway_id)
        .ok_or_else(|| "网关不存在，可能已被删除".to_string())?;
    let ctx = plan_ctx_for(&gateway)?
        .filter(|c| !c.key.is_empty())
        .ok_or_else(|| "网关未保存密钥，无法使用重置卡".to_string())?;
    let region = match &ctx.provider {
        PlanProvider::Zhipu { region } => region,
        _ => return Err("该供应商暂无重置卡功能".into()),
    };
    let team = is_team(&ctx);
    let list_url = format!(
        "{}{}/list?targetType=PERSONAL",
        region.base(),
        RESET_CARD_PATH
    );
    let outcome = plan_get(&list_url, &ctx, team).await?;
    if !(outcome.status >= 200 && outcome.status < 300) {
        return Err(map_http_error(&outcome, "查询重置卡失败"));
    }
    let cards = parse_zhipu_cards(&outcome.body, now_ms(), region.naive_tz_offset_hours())?;
    let pool = match api_type {
        "FIVE_HOUR" => &cards.five_hour,
        _ => &cards.weekly,
    };
    let card = pool
        .first()
        .ok_or_else(|| {
            format!(
                "没有可用的{}重置卡",
                if api_type == "FIVE_HOUR" {
                    "5 小时"
                } else {
                    "周"
                }
            )
        })?
        .clone();
    let use_url = format!("{}{}/use", region.base(), RESET_CARD_PATH);
    let payload = serde_json::json!({
        "targetType": "PERSONAL",
        "resetType": card.reset_type,
        "recordId": card.record_id,
        "requestId": uuid::Uuid::new_v4().to_string(),
    });
    let outcome = plan_post_json(&use_url, &ctx, team, &payload).await?;
    if !(outcome.status >= 200 && outcome.status < 300) {
        return Err(map_http_error(&outcome, "使用重置卡失败"));
    }
    if !envelope_ok(&outcome.body) {
        return Err(envelope_error(&outcome.body));
    }
    // 成功：作废缓存，立即重查（force）返回新余量
    cache_invalidate(&gateway_id);
    let mut dto = refresh_gateway(&gateway, &ctx).await;
    if !dto.ok {
        if let Some(prev) = cache_get_stale(&gateway_id) {
            dto = prev;
            dto.from_cache = true;
        }
    } else {
        cache_put(&dto);
    }
    Ok(dto)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slots_with(urls: &[(&str, &str)]) -> ProtocolSlots {
        let mut slots = ProtocolSlots {
            anthropic: None,
            openai: None,
            responses: None,
            gemini: None,
            cursor: None,
        };
        for (slot, url) in urls {
            match *slot {
                "anthropic" => slots.anthropic = Some(url.to_string()),
                "openai" => slots.openai = Some(url.to_string()),
                "responses" => slots.responses = Some(url.to_string()),
                "gemini" => slots.gemini = Some(url.to_string()),
                _ => slots.cursor = Some(url.to_string()),
            }
        }
        slots
    }

    #[test]
    fn plan_provider_detection_by_slot_url() {
        assert_eq!(
            detect_plan_provider(&slots_with(&[(
                "anthropic",
                "https://open.bigmodel.cn/api/anthropic"
            )])),
            Some(PlanProvider::Zhipu {
                region: ZhipuRegion::Cn
            })
        );
        assert_eq!(
            detect_plan_provider(&slots_with(&[("openai", "https://api.z.ai/api/paas/v4")])),
            Some(PlanProvider::Zhipu {
                region: ZhipuRegion::International
            })
        );
        assert_eq!(
            detect_plan_provider(&slots_with(&[("anthropic", "https://api.kimi.com/coding")])),
            Some(PlanProvider::Kimi { global: false })
        );
        assert_eq!(
            detect_plan_provider(&slots_with(&[("openai", "https://api.kimi.ai/coding/v1")])),
            Some(PlanProvider::Kimi { global: true })
        );
        // MiniMax 国内新推理域名（同一账号体系，额度照旧查 api.minimaxi.com）
        assert_eq!(
            detect_plan_provider(&slots_with(&[("anthropic", "https://api.minimax.cn/anthropic")])),
            Some(PlanProvider::MiniMax {
                international: false
            })
        );
        assert_eq!(
            detect_plan_provider(&slots_with(&[(
                "openai",
                "https://api.minimaxi.com/api/paas/v4"
            )])),
            Some(PlanProvider::MiniMax {
                international: false
            })
        );
        assert_eq!(
            detect_plan_provider(&slots_with(&[(
                "openai",
                "https://api.minimax.io/api/paas/v4"
            )])),
            Some(PlanProvider::MiniMax {
                international: true
            })
        );
        // 普通按量付费端点不命中
        assert_eq!(
            detect_plan_provider(&slots_with(&[("openai", "https://api.deepseek.com/v1")])),
            None
        );
        assert_eq!(
            detect_plan_provider(&slots_with(&[("openai", "https://api.moonshot.cn/v1")])),
            None
        );
    }

    #[test]
    fn team_headers_case_insensitive_from_header_env() {
        let mut env = std::collections::BTreeMap::new();
        env.insert("BigModel-Organization".to_string(), " org-1 ".to_string());
        let (org, project) = team_headers(&env);
        assert_eq!(org.as_deref(), Some("org-1"));
        assert!(project.is_none());
        env.insert("bigmodel-project".to_string(), "p1".to_string());
        assert!(team_headers(&env).1.is_some());
    }

    #[test]
    fn quota_parse_classifies_by_unit_not_reset_order() {
        // 周窗重置时间早于 5h 窗（周期末尾形态，cc-switch #3036）——按 unit 锚定不能标反
        let body = serde_json::json!({
            "success": true,
            "data": {
                "level": "MaxPlan",
                "limits": [
                    { "type": "TOKENS_LIMIT", "percentage": 42.0, "nextResetTime": 1000, "unit": 6, "number": 7 },
                    { "type": "TOKENS_LIMIT", "percentage": 91.0, "nextResetTime": 999_999_999_999i64, "unit": 3, "number": 5 }
                ]
            }
        });
        let (level, windows) = parse_zhipu_quota(&body).unwrap();
        assert_eq!(level.as_deref(), Some("MaxPlan"));
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].window, WINDOW_FIVE_HOUR);
        assert_eq!(windows[0].used_percent, 91.0);
        assert_eq!(windows[1].window, WINDOW_WEEKLY);
    }

    #[test]
    fn quota_parse_accepts_credit_limit_and_business_error() {
        let body = serde_json::json!({
            "success": true,
            "data": { "limits": [
                { "type": "CREDIT_LIMIT", "percentage": "12.5", "unit": 3 }
            ]}
        });
        let (_, windows) = parse_zhipu_quota(&body).unwrap();
        assert_eq!(windows[0].used_percent, 12.5); // 字符串数值也认
        let err = serde_json::json!({ "success": false, "msg": "quota not found" });
        assert!(parse_zhipu_quota(&err)
            .unwrap_err()
            .contains("quota not found"));
        // 业务码 1001（无 key 实测形态）→ 密钥失效统一文案
        let no_key = serde_json::json!({
            "code": 1001, "msg": "Header中未收到Authorization参数，无法进行身份验证。", "success": false
        });
        assert!(parse_zhipu_quota(&no_key).unwrap_err().contains("密钥失效"));
    }

    #[test]
    fn zhipu_parse_keeps_absolute_credits() {
        // 本机实测响应原样（2026-09-21 只读查询 open.bigmodel.cn 个人版）：
        // 5h 窗 0%（0/28000，且**没有 nextResetTime**）；周窗 100%（140023/140000）
        let body = serde_json::json!({
            "code": 200, "msg": "操作成功", "success": true,
            "data": { "level": "max", "limits": [
                { "type": "CREDIT_LIMIT", "unit": 3, "number": 5, "usage": 28000,
                  "currentValue": 0, "remaining": 28000, "percentage": 0 },
                { "type": "CREDIT_LIMIT", "unit": 6, "number": 1, "usage": 140000,
                  "currentValue": 140023, "remaining": 0, "percentage": 100,
                  "nextResetTime": 1_790_065_352_976i64 }
            ]}
        });
        let (level, windows) = parse_zhipu_quota(&body).unwrap();
        assert_eq!(level.as_deref(), Some("max"));
        assert_eq!(windows[0].window, WINDOW_FIVE_HOUR);
        assert_eq!(windows[0].used, Some(0.0));
        assert_eq!(windows[0].total, Some(28000.0));
        // 5h 窗缺 nextResetTime → 不编一个重置时间出来（前端脚注留空）
        assert_eq!(windows[0].reset_ms, None);
        assert_eq!(windows[1].window, WINDOW_WEEKLY);
        // 超发（已用 > 总量）如实透传，不在解析层钳到总量——报表口径要能看出超了
        assert_eq!(windows[1].used, Some(140023.0));
        assert_eq!(windows[1].total, Some(140000.0));
        // 只有百分比、没有绝对值字段的老报文 → 不猜 0
        let legacy = serde_json::json!({
            "success": true,
            "data": { "limits": [ { "type": "TOKENS_LIMIT", "percentage": 42.0, "unit": 3 } ] }
        });
        let (_, w) = parse_zhipu_quota(&legacy).unwrap();
        assert_eq!(w[0].used, None);
        assert_eq!(w[0].total, None);
    }

    #[test]
    fn quota_parse_unit_missing_fallback_and_old_plan() {
        // unit 缺失：无 reset 优先归 5h，其余按 reset 升序补位
        let body = serde_json::json!({
            "success": true,
            "data": { "limits": [
                { "type": "TOKENS_LIMIT", "percentage": 10.0, "nextResetTime": 2000 },
                { "type": "TOKENS_LIMIT", "percentage": 50.0 }
            ]}
        });
        let (_, windows) = parse_zhipu_quota(&body).unwrap();
        assert_eq!(windows[0].window, WINDOW_FIVE_HOUR);
        assert_eq!(windows[0].used_percent, 50.0);
        assert_eq!(windows[1].window, WINDOW_WEEKLY);
        assert_eq!(windows[1].reset_ms, Some(2000));
        // 老套餐只回 1 条 → 只有 5h
        let old = serde_json::json!({
            "success": true,
            "data": { "limits": [ { "type": "TOKENS_LIMIT", "percentage": 3.0, "unit": 3 } ] }
        });
        let (_, w1) = parse_zhipu_quota(&old).unwrap();
        assert_eq!(w1.len(), 1);
    }

    #[test]
    fn card_timestamp_parses_zai_and_iso() {
        // z.ai 无时区时间戳按 UTC
        // 偏移 0（z.ai / Kimi 退化口径）
        assert_eq!(
            parse_card_timestamp_tz("2026-09-20 01:02:03", 0),
            Some(1_789_866_123_000)
        );
        assert_eq!(
            parse_card_timestamp_tz("2026-09-20T01:02:03.5Z", 0),
            Some(1_789_866_123_500)
        );
        // 带时区的 ISO 不吃偏移
        assert_eq!(
            parse_card_timestamp_tz("2026-09-20T01:02:03.5Z", 8),
            Some(1_789_866_123_500)
        );
        // bigmodel.cn 北京时间：同一字符串比 UTC 早 8 小时（用户官网比对实测修正）
        assert_eq!(
            parse_card_timestamp_tz("2026-09-20 01:02:03", 8),
            Some(1_789_837_323_000)
        );
        assert!(parse_card_timestamp_tz("not a time", 8).is_none());
    }

    #[test]
    fn cards_parse_filters_unavailable_expired_and_sorts() {
        let now = 1_789_000_000_000i64;
        let body = serde_json::json!({
            "success": true, "code": 0,
            "data": {
                "fiveHourResets": [
                    { "recordId": 101, "expireTime": "2999-01-01 00:00:00", "packageName": "A" },
                    { "recordId": 102, "status": "consumed" },
                    { "recordId": 103, "expireTime": "2000-01-01 00:00:00" },
                    { "recordId": 104, "expireTime": "2998-01-01 00:00:00" },
                    { "resetId": "abc", "available": false }
                ],
                "weekResets": [],
                "lastFiveHourResetTime": "2026-09-19 10:00:00",
                "lastWeekResetTime": null
            }
        });
        let cards = parse_zhipu_cards(&body, now, 8).unwrap();
        // 过滤已消费/已过期/available=false；剩两张按过期升序（104 早于 101）
        assert_eq!(cards.five_hour.len(), 2);
        assert_eq!(cards.five_hour[0].record_id, "104");
        assert_eq!(cards.five_hour[1].record_id, "101");
        assert_eq!(cards.weekly.len(), 0);
        assert_eq!(
            cards.last_five_hour_reset_at.as_deref(),
            Some("2026-09-19 10:00:00")
        );
    }

    #[test]
    fn cards_envelope_fail_closed() {
        let now = 0i64;
        // code 缺失 → fail
        let no_code = serde_json::json!({ "success": true, "data": { "fiveHourResets": [], "weekResets": [] } });
        assert!(parse_zhipu_cards(&no_code, now, 8).is_err());
        // 单桶截断 → 不得当作 0 张
        let truncated =
            serde_json::json!({ "success": true, "code": 0, "data": { "fiveHourResets": [] } });
        assert!(parse_zhipu_cards(&truncated, now, 8).is_err());
        // 业务码 1001 → 密钥失效
        let expired = serde_json::json!({ "success": false, "code": 1001, "msg": "unauthorized" });
        let err = parse_zhipu_cards(&expired, now, 8).unwrap_err();
        assert!(err.contains("密钥失效"));
    }

    #[test]
    fn kimi_parse_picks_tightest_five_hour_and_weekly() {
        // 两个模型的 5h 窗取 utilization 最紧的（80%）；usage 周窗独立成桶；
        // resetTime 字符串（ISO）与毫秒数字都要认
        let body = serde_json::json!({
            "limits": [
                { "model": "kimi-k3", "detail": { "limit": 100, "remaining": 20, "resetTime": "2026-09-20T01:00:00Z" } },
                { "model": "kimi-k2.5", "detail": { "limit": 50, "remaining": 40, "resetTime": 1756800000i64 } }
            ],
            "usage": { "limit": 600, "remaining": 512, "resetTime": 1756848000000i64 }
        });
        let windows = parse_kimi_quota(&body).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].window, WINDOW_FIVE_HOUR);
        assert_eq!(windows[0].used_percent, 80.0);
        assert_eq!(windows[0].reset_ms, Some(1_789_866_000_000));
        assert_eq!(windows[1].window, WINDOW_WEEKLY);
        assert_eq!(windows[1].used_percent, (600.0 - 512.0) / 600.0 * 100.0);
        assert_eq!(windows[1].reset_ms, Some(1756848000000i64));
        // 绝对值 = 配额点数（limit/remaining 直接可算）→ 前端能显示「已用 80 / 100」
        assert_eq!(windows[0].used, Some(80.0));
        assert_eq!(windows[0].total, Some(100.0));
        assert_eq!(windows[1].used, Some(88.0));
        assert_eq!(windows[1].total, Some(600.0));
        // 只剩 remaining 没有 limit 的残报文：limit 兜底 1.0 → 已用钳到 0（现状口径，不动）；
        // 关键是**不编绝对值**——没有 limit 就没有总量可言
        let partial = serde_json::json!({
            "limits": [ { "model": "kimi-k3", "detail": { "remaining": 5 } } ]
        });
        let p = parse_kimi_quota(&partial).unwrap();
        assert_eq!(p[0].used_percent, 0.0);
        assert_eq!(p[0].used, None);
        assert_eq!(p[0].total, None);
        // 空响应报错
        assert!(parse_kimi_quota(&serde_json::json!({})).is_err());
    }

    #[test]
    fn minimax_parse_inverts_remaining_and_gates_weekly() {
        let body = serde_json::json!({
            "base_resp": { "status_code": 0, "status_msg": "" },
            "model_remains": [
                {
                    "model_name": "general",
                    "current_interval_remaining_percent": 64.0,
                    "end_time": 1756812345000i64,
                    "current_weekly_status": 1,
                    "current_weekly_remaining_percent": 78.5,
                    "weekly_end_time": 1757232000000i64
                },
                { "model_name": "video", "current_interval_remaining_percent": 99.0 }
            ]
        });
        let windows = parse_minimax_quota(&body).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].window, WINDOW_FIVE_HOUR);
        assert_eq!(windows[0].used_percent, 36.0); // 剩余反转成已用
        assert_eq!(windows[0].reset_ms, Some(1756812345000i64));
        assert_eq!(windows[1].window, WINDOW_WEEKLY);
        assert_eq!(windows[1].used_percent, 21.5);
        // 这家只回百分比 → 绝对值留空（前端不显示绝对行，不是显示 0/0）
        assert_eq!(windows[0].used, None);
        assert_eq!(windows[0].total, None);
        // 周桶 status != 1 → 只有 5h
        let no_weekly = serde_json::json!({
            "base_resp": { "status_code": 0 },
            "model_remains": [
                { "model_name": "general", "current_interval_remaining_percent": 10.0, "end_time": -1, "current_weekly_status": 3 }
            ]
        });
        let w1 = parse_minimax_quota(&no_weekly).unwrap();
        assert_eq!(w1.len(), 1);
        assert_eq!(w1[0].reset_ms, None); // end_time<=0 视为无重置
                                          // 业务错：1004（无 key 实测）归密钥失效
        let err = serde_json::json!({ "base_resp": { "status_code": 1004, "status_msg": "invalid key" } });
        assert!(parse_minimax_quota(&err).unwrap_err().contains("密钥失效"));
        let err2 = serde_json::json!({ "base_resp": { "status_code": 1005, "status_msg": "server busy" } });
        assert!(parse_minimax_quota(&err2)
            .unwrap_err()
            .contains("server busy"));
    }

    #[test]
    fn number_record_id_kept_integral() {
        let v = serde_json::json!({ "recordId": 105.0 });
        assert_eq!(card_string(&v, &["recordId"]).as_deref(), Some("105"));
    }

    #[test]
    fn earliest_expiry_takes_min_and_skips_unknown() {
        let cards = vec![
            ZhipuCard {
                record_id: "1".into(),
                reset_type: "FIVE_HOUR".into(),
                expire_ms: Some(3000),
            },
            ZhipuCard {
                record_id: "2".into(),
                reset_type: "FIVE_HOUR".into(),
                expire_ms: None,
            },
            ZhipuCard {
                record_id: "3".into(),
                reset_type: "FIVE_HOUR".into(),
                expire_ms: Some(2000),
            },
        ];
        assert_eq!(earliest_expiry(&cards), Some(2000));
        assert_eq!(earliest_expiry(&cards[1..2]), None);
        assert_eq!(earliest_expiry(&[]), None);
    }
}
