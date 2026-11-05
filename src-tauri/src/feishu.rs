//! 飞书机器人通道（2026-11-06）：用户在手机飞书里跟 Mesa 的项目助手说话。
//!
//! Mesa 用飞书「企业自建应用」的长连接事件订阅主动连出去（WebSocket），不开端口、不要公网地址。
//! 本模块只管传输、配对 / 绑定、密钥与发消息；收到的话交给前端（路由与 AI 全在前端）。
//! - App Secret 存 0600 keys.json（键 `feishu:<app_id>`），不回给前端、不进日志；`feishu.json` 只存 App ID / 开关 / 绑定人 open_id
//! - 配对要人在 Mesa 里点开始：6 位码 10 分钟有效，错 5 次作废；只认单聊文字
//! - 只有绑定人的单聊文字、卡片按钮点击才发给前端（`feishu-message` / `feishu-card-action`）；别人一律不转
//!
//! 协议对照官方 SDK 源码（2026-11-06 核对，不凭印象）：
//! - Go：https://github.com/larksuite/oapi-sdk-go/tree/v3_main/ws
//!   client_transport.go（POST /callback/ws/endpoint 取接入点、握手失败头 Handshake-*、哪些错误不重连）、
//!   client_session.go（连上立刻 ping、按 PingInterval 续 ping、读超时 2×PingInterval+5s、pong 里下发新配置）、
//!   client_message.go（数据帧按 sum/seq 合包、5 秒缓存；处理完原帧回写：头加 biz_rt、payload 换成 Response JSON）、
//!   client_lifecycle.go（首次重连等 0..ReconnectNonce 秒随机、之后每 ReconnectInterval 一次、ReconnectCount<0 不限次）、
//!   pbbp2.pb.go（Frame / Header 的字段号与编码顺序）、const.go / model.go（头键、错误码、ClientConfig 默认值）
//! - Node：https://github.com/larksuite/node-sdk/blob/main/ws-client/index.ts（回执 data 是 base64 的 JSON，与 Go 的 []byte 同形）
//! - 卡片回调：https://github.com/larksuite/oapi-sdk-go/blob/v3_main/event/dispatcher/callback/model.go
//!   （card.action.trigger 走同一条事件通道 type=event；回包可带 toast）
//! - 收消息：https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/im/v1/model.go（P2MessageReceiveV1Data）
//! - 令牌：https://github.com/larksuite/oapi-sdk-go/blob/v3_main/core/tokenmanager.go（tenant_access_token + expire 秒）

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

const API_BASE: &str = "https://open.feishu.cn";
const ENDPOINT_PATH: &str = "/callback/ws/endpoint";
const TOKEN_PATH: &str = "/open-apis/auth/v3/tenant_access_token/internal";
const SEND_PATH: &str = "/open-apis/im/v1/messages?receive_id_type=open_id";

const PAIR_TTL: Duration = Duration::from_secs(10 * 60);
const PAIR_MAX_WRONG: u32 = 5;
/// 不是绑定人发来的话，同一个人多久最多回一次「只听绑定它的人」
const STRANGER_REPLY_EVERY: Duration = Duration::from_secs(10 * 60);
const DEDUPE_CAP: usize = 512;
/// 分包缓存：与 Go SDK 同为 5 秒，每来一片续期
const FRAGMENT_TTL: Duration = Duration::from_secs(5);
const MAX_FRAGMENTS: usize = 64;
const MAX_PENDING_MESSAGES: usize = 32;
/// 读超时只是为了能按时 ping、按时看停止标志，不是断线判定
const READ_TICK: Duration = Duration::from_millis(500);

const TEXT_PAIRED: &str = "已绑定到这台电脑上的 Mesa";
const TEXT_STRANGER: &str = "这个机器人只听绑定它的人";
const TEXT_WRONG_CODE: &str = "配对码不对或已过期，请在 Mesa 里重新点「开始配对」";
const TEXT_ONLY_TEXT: &str = "暂时只收文字消息";

// ===== pbbp2 帧编解码（手写，字段号与写出顺序照 pbbp2.pb.go）=====

#[derive(Debug, Clone, Default, PartialEq)]
struct Frame {
    seq_id: u64,
    log_id: u64,
    service: i32,
    /// 0 = 控制帧（ping/pong），1 = 数据帧（event/card）
    method: i32,
    headers: Vec<(String, String)>,
    payload_encoding: String,
    payload_type: String,
    payload: Option<Vec<u8>>,
    log_id_new: String,
}

const METHOD_CONTROL: i32 = 0;
const METHOD_DATA: i32 = 1;

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn put_len_field(out: &mut Vec<u8>, tag: u8, bytes: &[u8]) {
    out.push(tag);
    put_varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

fn get_varint(buf: &[u8], pos: &mut usize) -> Result<u64, String> {
    let mut v: u64 = 0;
    for shift in (0..64).step_by(7) {
        let b = *buf.get(*pos).ok_or("帧数据不完整")?;
        *pos += 1;
        v |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Ok(v);
        }
    }
    Err("帧里的整数过长".into())
}

fn get_len_bytes<'a>(buf: &'a [u8], pos: &mut usize) -> Result<&'a [u8], String> {
    let len = get_varint(buf, pos)? as usize;
    let end = pos.checked_add(len).filter(|e| *e <= buf.len()).ok_or("帧数据不完整")?;
    let out = &buf[*pos..end];
    *pos = end;
    Ok(out)
}

fn skip_field(buf: &[u8], pos: &mut usize, wire: u64) -> Result<(), String> {
    match wire {
        0 => get_varint(buf, pos).map(|_| ()),
        1 | 5 => {
            let n = if wire == 1 { 8 } else { 4 };
            *pos = pos.checked_add(n).filter(|e| *e <= buf.len()).ok_or("帧数据不完整")?;
            Ok(())
        }
        2 => get_len_bytes(buf, pos).map(|_| ()),
        _ => Err(format!("帧里有不认识的字段类型 {wire}")),
    }
}

fn utf8(bytes: &[u8]) -> Result<String, String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| "帧里的文字不是 UTF-8".to_string())
}

impl Frame {
    fn header(&self, key: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    fn header_int(&self, key: &str) -> usize {
        self.header(key).and_then(|v| v.trim().parse().ok()).unwrap_or(0)
    }

    /// 与 Go 的 MarshalToSizedBuffer 同序同形：必填 1-4 总写，6/7/9 空串也写，8 只在有 payload 时写
    fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(64 + self.payload.as_ref().map_or(0, Vec::len));
        out.push(0x08);
        put_varint(&mut out, self.seq_id);
        out.push(0x10);
        put_varint(&mut out, self.log_id);
        // int32 负数按 proto 规则符号扩展成 10 字节 varint
        out.push(0x18);
        put_varint(&mut out, i64::from(self.service) as u64);
        out.push(0x20);
        put_varint(&mut out, i64::from(self.method) as u64);
        for (k, v) in &self.headers {
            let mut h = Vec::with_capacity(k.len() + v.len() + 4);
            put_len_field(&mut h, 0x0a, k.as_bytes());
            put_len_field(&mut h, 0x12, v.as_bytes());
            put_len_field(&mut out, 0x2a, &h);
        }
        put_len_field(&mut out, 0x32, self.payload_encoding.as_bytes());
        put_len_field(&mut out, 0x3a, self.payload_type.as_bytes());
        if let Some(p) = &self.payload {
            put_len_field(&mut out, 0x42, p);
        }
        put_len_field(&mut out, 0x4a, self.log_id_new.as_bytes());
        out
    }

    fn decode(buf: &[u8]) -> Result<Frame, String> {
        let mut f = Frame::default();
        let mut pos = 0;
        while pos < buf.len() {
            let key = get_varint(buf, &mut pos)?;
            let (field, wire) = (key >> 3, key & 7);
            match (field, wire) {
                (1, 0) => f.seq_id = get_varint(buf, &mut pos)?,
                (2, 0) => f.log_id = get_varint(buf, &mut pos)?,
                (3, 0) => f.service = get_varint(buf, &mut pos)? as i32,
                (4, 0) => f.method = get_varint(buf, &mut pos)? as i32,
                (5, 2) => {
                    let h = get_len_bytes(buf, &mut pos)?;
                    f.headers.push(decode_header(h)?);
                }
                (6, 2) => f.payload_encoding = utf8(get_len_bytes(buf, &mut pos)?)?,
                (7, 2) => f.payload_type = utf8(get_len_bytes(buf, &mut pos)?)?,
                (8, 2) => f.payload = Some(get_len_bytes(buf, &mut pos)?.to_vec()),
                (9, 2) => f.log_id_new = utf8(get_len_bytes(buf, &mut pos)?)?,
                _ => skip_field(buf, &mut pos, wire)?,
            }
        }
        Ok(f)
    }
}

fn decode_header(buf: &[u8]) -> Result<(String, String), String> {
    let (mut k, mut v) = (String::new(), String::new());
    let mut pos = 0;
    while pos < buf.len() {
        let key = get_varint(buf, &mut pos)?;
        match (key >> 3, key & 7) {
            (1, 2) => k = utf8(get_len_bytes(buf, &mut pos)?)?,
            (2, 2) => v = utf8(get_len_bytes(buf, &mut pos)?)?,
            (_, wire) => skip_field(buf, &mut pos, wire)?,
        }
    }
    Ok((k, v))
}

fn ping_frame(service: i32) -> Frame {
    Frame {
        service,
        method: METHOD_CONTROL,
        headers: vec![("type".into(), "ping".into())],
        ..Frame::default()
    }
}

/// 数据帧回执的 payload：Go 的 Response{code, headers, data}，data 为 []byte → JSON 里是 base64
fn response_payload(code: u16, data: Option<&Value>) -> Vec<u8> {
    use base64::Engine;
    let data = data.map(|d| base64::engine::general_purpose::STANDARD.encode(d.to_string()));
    json!({ "code": code, "headers": null, "data": data }).to_string().into_bytes()
}

// ===== 分包合并（sum > 1 时按 message_id 收齐再交出）=====

#[derive(Default)]
struct Reassembler {
    pending: HashMap<String, (Vec<Option<Vec<u8>>>, Instant)>,
}

impl Reassembler {
    fn push(&mut self, msg_id: &str, sum: usize, seq: usize, data: Vec<u8>, now: Instant) -> Option<Vec<u8>> {
        if sum <= 1 {
            return Some(data);
        }
        if sum > MAX_FRAGMENTS || seq >= sum || msg_id.is_empty() {
            return None;
        }
        self.pending.retain(|_, (_, deadline)| *deadline > now);
        if !self.pending.contains_key(msg_id) && self.pending.len() >= MAX_PENDING_MESSAGES {
            return None;
        }
        let entry = self
            .pending
            .entry(msg_id.to_string())
            .or_insert_with(|| (vec![None; sum], now));
        if entry.0.len() != sum {
            entry.0 = vec![None; sum];
        }
        entry.0[seq] = Some(data);
        entry.1 = now + FRAGMENT_TTL;
        if entry.0.iter().any(Option::is_none) {
            return None;
        }
        let (parts, _) = self.pending.remove(msg_id)?;
        Some(parts.into_iter().flatten().flatten().collect())
    }
}

// ===== 收到的事件 → 该做什么（纯逻辑，便于离线测）=====

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeishuMessageDto {
    pub text: String,
    pub message_id: String,
    /// 消息发送时间（毫秒时间戳）
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeishuCardActionDto {
    /// 按钮上的 action.value 原样给前端
    pub value: Value,
    /// 这次点击的事件 id（每次点击不同，去重用）
    pub message_id: String,
    /// 卡片所在那条消息的 id（om_…）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_message_id: Option<String>,
}

#[derive(Debug, PartialEq)]
enum Inbound {
    Ignore,
    Message(FeishuMessageDto),
    CardAction(FeishuCardActionDto),
    /// 配对成功：绑定这个 open_id
    Paired { open_id: String },
    /// 只回一句话，不转给前端
    Reply { open_id: String, text: &'static str },
}

struct Pairing {
    code: String,
    expires_at: Instant,
    wrong: u32,
}

/// 有界去重表：先进先出淘汰
struct Dedupe {
    order: VecDeque<String>,
    set: HashSet<String>,
}

impl Dedupe {
    fn new() -> Self {
        Self { order: VecDeque::new(), set: HashSet::new() }
    }

    /// 第一次见到返回 true
    fn insert(&mut self, key: String) -> bool {
        if self.set.contains(&key) {
            return false;
        }
        if self.order.len() >= DEDUPE_CAP {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        self.set.insert(key.clone());
        self.order.push_back(key);
        true
    }
}

struct Router {
    bound_open_id: Option<String>,
    pairing: Option<Pairing>,
    seen: Dedupe,
    stranger_replied: HashMap<String, Instant>,
}

/// 「绑定 123456」「绑定：123456」或只发 6 位数字 → 码
fn pair_code_candidate(text: &str) -> Option<String> {
    let t = text.trim();
    let t = t.strip_prefix("绑定").unwrap_or(t);
    let t = t.trim_matches(|c: char| c.is_whitespace() || c == ':' || c == '：');
    (t.len() == 6 && t.bytes().all(|b| b.is_ascii_digit())).then(|| t.to_string())
}

fn str_at<'a>(v: &'a Value, pointer: &str) -> Option<&'a str> {
    v.pointer(pointer).and_then(Value::as_str).filter(|s| !s.is_empty())
}

impl Router {
    fn new(bound_open_id: Option<String>) -> Self {
        Self {
            bound_open_id,
            pairing: None,
            seen: Dedupe::new(),
            stranger_replied: HashMap::new(),
        }
    }

    fn start_pairing(&mut self, code: String, now: Instant) {
        self.pairing = Some(Pairing { code, expires_at: now + PAIR_TTL, wrong: 0 });
    }

    fn route(&mut self, payload: &[u8], now: Instant) -> Inbound {
        let Ok(v) = serde_json::from_slice::<Value>(payload) else {
            return Inbound::Ignore;
        };
        let Some(event_type) = str_at(&v, "/header/event_type") else {
            return Inbound::Ignore;
        };
        let event_id = str_at(&v, "/header/event_id").unwrap_or("").to_string();
        if !event_id.is_empty() && !self.seen.insert(format!("evt:{event_id}")) {
            return Inbound::Ignore;
        }
        let event = v.get("event").unwrap_or(&Value::Null);
        match event_type {
            "im.message.receive_v1" => self.on_message(event, now),
            "card.action.trigger" => self.on_card(event, &event_id),
            _ => Inbound::Ignore,
        }
    }

    fn is_bound(&self, open_id: &str) -> bool {
        self.bound_open_id.as_deref() == Some(open_id)
    }

    fn on_message(&mut self, event: &Value, now: Instant) -> Inbound {
        let Some(message_id) = str_at(event, "/message/message_id") else {
            return Inbound::Ignore;
        };
        if !self.seen.insert(format!("msg:{message_id}")) {
            return Inbound::Ignore;
        }
        // 只认真人单聊；群里的、机器人发的一律不理
        if str_at(event, "/sender/sender_type") != Some("user")
            || str_at(event, "/message/chat_type") != Some("p2p")
        {
            return Inbound::Ignore;
        }
        let Some(open_id) = str_at(event, "/sender/sender_id/open_id").map(str::to_string) else {
            return Inbound::Ignore;
        };
        // 文字消息的 content 是一段 JSON 字符串：{"text": "..."}
        let text = (str_at(event, "/message/message_type") == Some("text"))
            .then(|| str_at(event, "/message/content"))
            .flatten()
            .and_then(|c| serde_json::from_str::<Value>(c).ok())
            .and_then(|c| c.get("text").and_then(Value::as_str).map(str::to_string));

        let bound = self.is_bound(&open_id);
        if let Some(code) = text.as_deref().and_then(pair_code_candidate) {
            if let Some(p) = self.pairing.as_mut() {
                if now >= p.expires_at {
                    self.pairing = None;
                    return Inbound::Reply { open_id, text: TEXT_WRONG_CODE };
                }
                if p.code == code {
                    self.pairing = None;
                    self.bound_open_id = Some(open_id.clone());
                    return Inbound::Paired { open_id };
                }
                p.wrong += 1;
                if p.wrong >= PAIR_MAX_WRONG {
                    self.pairing = None;
                }
                return Inbound::Reply { open_id, text: TEXT_WRONG_CODE };
            }
            if !bound {
                return self.stranger_reply(open_id, now, TEXT_WRONG_CODE);
            }
        }
        if !bound {
            return self.stranger_reply(open_id, now, TEXT_STRANGER);
        }
        match text {
            Some(t) if !t.trim().is_empty() => {
                let at = str_at(event, "/message/create_time")
                    .and_then(|s| s.parse::<i64>().ok())
                    .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
                Inbound::Message(FeishuMessageDto { text: t, message_id: message_id.to_string(), at })
            }
            _ => Inbound::Reply { open_id, text: TEXT_ONLY_TEXT },
        }
    }

    fn stranger_reply(&mut self, open_id: String, now: Instant, text: &'static str) -> Inbound {
        self.stranger_replied
            .retain(|_, at| now.saturating_duration_since(*at) < STRANGER_REPLY_EVERY);
        if self.stranger_replied.contains_key(&open_id) || self.stranger_replied.len() >= 256 {
            return Inbound::Ignore;
        }
        self.stranger_replied.insert(open_id.clone(), now);
        Inbound::Reply { open_id, text }
    }

    fn on_card(&mut self, event: &Value, event_id: &str) -> Inbound {
        match str_at(event, "/operator/open_id") {
            Some(open_id) if self.is_bound(open_id) => {}
            _ => return Inbound::Ignore,
        }
        let open_message_id = str_at(event, "/context/open_message_id").map(str::to_string);
        let message_id = if event_id.is_empty() {
            open_message_id.clone().unwrap_or_default()
        } else {
            event_id.to_string()
        };
        Inbound::CardAction(FeishuCardActionDto {
            value: event.pointer("/action/value").cloned().unwrap_or(Value::Null),
            message_id,
            open_message_id,
        })
    }
}

// ===== 配置与密钥 =====

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StoredConfig {
    #[serde(default)]
    app_id: String,
    #[serde(default)]
    enabled: bool,
    /// 绑定人的 open_id（同一个人在不同应用下 open_id 不同，换 App ID 即作废）
    #[serde(default)]
    bound_open_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeishuConfigDto {
    pub enabled: bool,
    pub app_id: String,
    pub has_secret: bool,
    /// 只给尾号，形如 `ou_…a1b2`
    pub bound_user: Option<String>,
    /// off | connecting | online | error
    pub status: String,
    pub last_error: Option<String>,
}

static CONFIG_LOCK: Mutex<()> = Mutex::new(());

fn config_path() -> Result<PathBuf, String> {
    Ok(crate::storage::config_root().ok_or("无法确定 Mesa 配置目录")?.join("feishu.json"))
}

fn load_config() -> StoredConfig {
    let Ok(path) = config_path() else { return StoredConfig::default() };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            crate::logbuf::record("warn", "feishu", &format!("飞书配置读不懂，按未配置处理：{e}"));
            StoredConfig::default()
        }),
        Err(_) => StoredConfig::default(),
    }
}

fn update_config(f: impl FnOnce(&mut StoredConfig)) -> Result<StoredConfig, String> {
    let _process = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _file = crate::storage::config_lock("feishu")?;
    let mut cfg = load_config();
    f(&mut cfg);
    let bytes = serde_json::to_vec_pretty(&cfg).map_err(|e| e.to_string())?;
    crate::storage::atomic_write(&config_path()?, &bytes, true)?;
    Ok(cfg)
}

fn secret_key_id(app_id: &str) -> String {
    format!("feishu:{app_id}")
}

fn load_secret(app_id: &str) -> Option<String> {
    if app_id.is_empty() {
        return None;
    }
    crate::profiles::get_shared_key(&secret_key_id(app_id)).ok().flatten().filter(|s| !s.is_empty())
}

fn open_id_tail(id: &str) -> String {
    let chars: Vec<char> = id.chars().collect();
    if chars.len() <= 7 {
        return "ou_…".into();
    }
    let head: String = chars[..3].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

/// 出错文案进界面 / 日志前脱敏：本应用的 Secret 一定遮掉，再过一遍通用规则
fn redact(text: &str, secret: &str) -> String {
    let secrets = if secret.is_empty() { Vec::new() } else { vec![secret.to_string()] };
    let once = crate::sessions::redact_sensitive_text_with(text, &secrets);
    crate::sessions::redact_sensitive_text(&once)
}

/// 保存设置（同步体，测试直接调）。返回保存后的配置；连接重启由调用方做
fn config_set_impl(app_id: &str, app_secret: Option<&str>, enabled: bool) -> Result<StoredConfig, String> {
    let app_id = app_id.trim().to_string();
    if app_id.chars().any(char::is_whitespace) {
        return Err("App ID 里不能有空格".into());
    }
    let secret = app_secret.map(str::trim).filter(|s| !s.is_empty());
    if secret.is_some() && app_id.is_empty() {
        return Err("先填 App ID 再保存 App Secret".into());
    }
    if enabled {
        if app_id.is_empty() {
            return Err("打开前要先填 App ID".into());
        }
        if secret.is_none() && load_secret(&app_id).is_none() {
            return Err("打开前要先填 App Secret".into());
        }
    }
    let old = load_config();
    if let Some(s) = secret {
        crate::profiles::set_shared_key(&secret_key_id(&app_id), s)?;
    }
    let changed_app = old.app_id != app_id;
    let cfg = update_config(|c| {
        c.app_id = app_id.clone();
        c.enabled = enabled;
        if changed_app {
            // open_id 按应用区分，换了应用原来的绑定就不认了
            c.bound_open_id = None;
        }
    })?;
    if changed_app && !old.app_id.is_empty() {
        let _ = crate::profiles::clear_shared_key(&secret_key_id(&old.app_id));
    }
    Ok(cfg)
}

// ===== 运行状态 =====

struct Runtime {
    generation: u64,
    stop: Option<Arc<AtomicBool>>,
    status: &'static str,
    last_error: Option<String>,
}

static RUNTIME: Mutex<Runtime> = Mutex::new(Runtime {
    generation: 0,
    stop: None,
    status: "off",
    last_error: None,
});
static ROUTER: LazyLock<Mutex<Router>> = LazyLock::new(|| Mutex::new(Router::new(None)));
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn runtime() -> std::sync::MutexGuard<'static, Runtime> {
    RUNTIME.lock().unwrap_or_else(|e| e.into_inner())
}

fn router() -> std::sync::MutexGuard<'static, Router> {
    ROUTER.lock().unwrap_or_else(|e| e.into_inner())
}

fn config_dto() -> FeishuConfigDto {
    let cfg = load_config();
    let (status, last_error) = {
        let rt = runtime();
        (rt.status.to_string(), rt.last_error.clone())
    };
    FeishuConfigDto {
        enabled: cfg.enabled,
        has_secret: load_secret(&cfg.app_id).is_some(),
        app_id: cfg.app_id,
        bound_user: cfg.bound_open_id.as_deref().map(open_id_tail),
        status,
        last_error,
    }
}

fn emit<S: Serialize + Clone>(event: &str, payload: S) {
    if let Some(app) = APP.get() {
        let _ = app.emit(event, payload);
    }
}

fn emit_status() {
    emit("feishu-status", config_dto());
}

/// 只认当前这一代连接报的状态；旧线程收尾时报的不算
fn set_status(generation: u64, status: &'static str, last_error: Option<String>) {
    {
        let mut rt = runtime();
        if rt.generation != generation {
            return;
        }
        rt.status = status;
        rt.last_error = last_error;
    }
    emit_status();
}

fn stop_current(rt: &mut Runtime) {
    if let Some(stop) = rt.stop.take() {
        stop.store(true, Ordering::SeqCst);
    }
    rt.generation += 1;
}

/// 按配置（重）起连接：开着且有 Secret 才连，否则停掉
fn restart(cfg: &StoredConfig) {
    {
        let mut r = router();
        if r.bound_open_id != cfg.bound_open_id {
            r.bound_open_id = cfg.bound_open_id.clone();
        }
        if !cfg.enabled {
            r.pairing = None;
        }
    }
    let secret = if cfg.enabled { load_secret(&cfg.app_id) } else { None };
    let mut rt = runtime();
    stop_current(&mut rt);
    let Some(secret) = secret else {
        rt.status = if cfg.enabled { "error" } else { "off" };
        rt.last_error = cfg.enabled.then(|| "缺少 App Secret，请在设置里重新填写".to_string());
        drop(rt);
        emit_status();
        return;
    };
    let generation = rt.generation;
    let stop = Arc::new(AtomicBool::new(false));
    rt.stop = Some(stop.clone());
    rt.status = "connecting";
    rt.last_error = None;
    drop(rt);
    emit_status();
    let app_id = cfg.app_id.clone();
    let spawned = std::thread::Builder::new()
        .name("feishu-ws".into())
        .spawn(move || connection_loop(generation, stop, app_id, secret));
    if let Err(e) = spawned {
        set_status(generation, "error", Some(format!("起不来飞书连接线程：{e}")));
    }
}

/// 应用启动时调：记下 AppHandle，开着就在后台连上（读配置放后台线程，不占 setup）
pub(crate) fn start_at_setup(app: tauri::AppHandle) {
    let _ = APP.set(app);
    std::thread::spawn(|| {
        let cfg = load_config();
        if cfg.enabled {
            restart(&cfg);
        } else {
            router().bound_open_id = cfg.bound_open_id;
        }
    });
}

/// 退出收尾：只置停止标志，连接线程自己发 close 帧后退出
pub(crate) fn shutdown() {
    stop_current(&mut runtime());
}

// ===== 长连接 =====

#[derive(Debug)]
struct ConnError {
    msg: String,
    /// 对应 Go SDK 的 ServerError（可重连）/ ClientError（凭证、权限类，不重连）
    retryable: bool,
}

impl ConnError {
    fn retry(msg: impl Into<String>) -> Self {
        Self { msg: msg.into(), retryable: true }
    }
    fn fatal(msg: impl Into<String>) -> Self {
        Self { msg: msg.into(), retryable: false }
    }
}

/// 服务端下发的连接参数（秒）；默认值同 Go SDK
#[derive(Debug, Clone, Copy, PartialEq)]
struct ClientConf {
    reconnect_count: i64,
    reconnect_interval: u64,
    reconnect_nonce: u64,
    ping_interval: u64,
}

impl Default for ClientConf {
    fn default() -> Self {
        Self { reconnect_count: -1, reconnect_interval: 120, reconnect_nonce: 30, ping_interval: 120 }
    }
}

impl ClientConf {
    /// 照 Go 的 applyConfig 整体替换，但不认 0 / 负的间隔（防止下发异常把 ping 打成死循环）
    fn apply(&mut self, v: &Value) {
        let get = |k: &str| v.get(k).and_then(Value::as_i64);
        if let Some(n) = get("ReconnectCount") {
            self.reconnect_count = n;
        }
        if let Some(n) = get("ReconnectInterval").filter(|n| *n > 0) {
            self.reconnect_interval = n as u64;
        }
        if let Some(n) = get("ReconnectNonce").filter(|n| *n >= 0) {
            self.reconnect_nonce = n as u64;
        }
        if let Some(n) = get("PingInterval").filter(|n| *n > 0) {
            self.ping_interval = n as u64;
        }
    }
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// 取长连接接入点（POST /callback/ws/endpoint）。错误码分档照 client_transport.go fetchEndpoint
async fn fetch_endpoint(app_id: &str, secret: &str) -> Result<(String, Value), ConnError> {
    let resp = http()
        .post(format!("{API_BASE}{ENDPOINT_PATH}"))
        .header("locale", "zh")
        .json(&json!({ "AppID": app_id, "AppSecret": secret }))
        .send()
        .await
        .map_err(|e| ConnError::retry(format!("连不上飞书服务器：{e}")))?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    let msg = body.get("msg").and_then(Value::as_str).unwrap_or("").to_string();
    if !status.is_success() {
        return Err(ConnError::retry(format!(
            "飞书长连接接入点暂时不可用（HTTP {}）{}",
            status.as_u16(),
            if msg.is_empty() { String::new() } else { format!("：{msg}") }
        )));
    }
    let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);
    match code {
        0 => {}
        1 | 1000040343 => return Err(ConnError::retry(format!("飞书服务器忙（错误码 {code}），稍后自动重连"))),
        _ => {
            return Err(ConnError::fatal(format!(
                "飞书拒绝了长连接：{}（错误码 {code}）。请核对 App ID / App Secret，并确认应用已发布、事件订阅选了「使用长连接接收」",
                if msg.is_empty() { "未说明原因" } else { &msg }
            )))
        }
    }
    let url = body
        .pointer("/data/URL")
        .and_then(Value::as_str)
        .filter(|u| !u.is_empty())
        .ok_or_else(|| ConnError::retry("飞书没给长连接地址，稍后自动重连"))?;
    let conf = body.pointer("/data/ClientConfig").cloned().unwrap_or(Value::Null);
    Ok((url.to_string(), conf))
}

type Socket = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>;

fn query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1.split('#').next()?;
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

/// 握手被拒时按 Handshake-* 头分档（client_transport.go parseHandshakeError）
fn handshake_error(resp: &tungstenite::http::Response<Option<Vec<u8>>>) -> ConnError {
    let header = |k: &str| resp.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let code: i64 = header("Handshake-Status").parse().ok().filter(|c| *c != 0).unwrap_or(i64::from(resp.status().as_u16()));
    let msg = header("Handshake-Msg");
    let auth_code: i64 = header("Handshake-Autherrcode").parse().unwrap_or(0);
    let detail = if msg.is_empty() { String::new() } else { format!("：{msg}") };
    match code {
        514 if auth_code == 1000040350 => ConnError::fatal(format!(
            "这个飞书应用的长连接数已满（同一应用最多几条），先关掉别处用同一应用的连接{detail}"
        )),
        403 => ConnError::fatal(format!("飞书拒绝了长连接（403）{detail}")),
        _ => ConnError::retry(format!("长连接握手失败（{code}）{detail}")),
    }
}

fn open_socket(url: &str) -> Result<(Socket, i32), ConnError> {
    use tungstenite::client::IntoClientRequest;
    let request = url
        .into_client_request()
        .map_err(|e| ConnError::retry(format!("飞书给的长连接地址不对：{e}")))?;
    let uri = request.uri().clone();
    let host = uri.host().ok_or_else(|| ConnError::retry("飞书给的长连接地址缺主机名"))?.to_string();
    let port = uri.port_u16().unwrap_or(if uri.scheme_str() == Some("ws") { 80 } else { 443 });
    let addrs: Vec<_> = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| ConnError::retry(format!("解析不了飞书长连接地址：{e}")))?
        .collect();
    let mut last = None;
    let mut stream = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, Duration::from_secs(10)) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(e) => last = Some(e),
        }
    }
    let stream = stream.ok_or_else(|| {
        ConnError::retry(format!(
            "连不上飞书长连接服务器：{}",
            last.map(|e| e.to_string()).unwrap_or_else(|| "没有可用地址".into())
        ))
    })?;
    // 握手期间给足时间；握手完再改成短读超时
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_nodelay(true);
    let (mut socket, _resp) = tungstenite::client_tls_with_config(request, stream, None, None).map_err(|e| match e {
        tungstenite::HandshakeError::Failure(tungstenite::Error::Http(resp)) => handshake_error(&resp),
        tungstenite::HandshakeError::Failure(e) => ConnError::retry(format!("长连接握手失败：{e}")),
        tungstenite::HandshakeError::Interrupted(_) => ConnError::retry("长连接握手超时"),
    })?;
    let tcp = match socket.get_mut() {
        tungstenite::stream::MaybeTlsStream::Plain(s) => Some(&*s),
        tungstenite::stream::MaybeTlsStream::Rustls(s) => Some(&s.sock),
        #[allow(unreachable_patterns)]
        _ => None,
    };
    if let Some(tcp) = tcp {
        let _ = tcp.set_read_timeout(Some(READ_TICK));
    }
    let service = query_param(url, "service_id").and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok((socket, service))
}

fn sleep_unless_stopped(stop: &AtomicBool, total: Duration) -> bool {
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200).min(deadline.saturating_duration_since(Instant::now())));
    }
    !stop.load(Ordering::SeqCst)
}

fn random_below(limit_ms: u64) -> u64 {
    if limit_ms == 0 {
        return 0;
    }
    let n = u128::from_le_bytes(*uuid::Uuid::new_v4().as_bytes());
    (n % u128::from(limit_ms)) as u64
}

fn connection_loop(generation: u64, stop: Arc<AtomicBool>, app_id: String, secret: String) {
    let mut conf = ClientConf::default();
    let mut attempts: i64 = 0;
    let mut reassembler = Reassembler::default();
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let result = (|| {
            let (url, c) = tauri::async_runtime::block_on(fetch_endpoint(&app_id, &secret))?;
            conf.apply(&c);
            let (mut socket, service) = open_socket(&url)?;
            attempts = 0;
            set_status(generation, "online", None);
            run_session(&mut socket, service, &mut conf, &stop, &app_id, &secret, &mut reassembler)
        })();
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let err = match result {
            Ok(()) => return,
            Err(e) => e,
        };
        let msg = redact(&err.msg, &secret);
        crate::logbuf::record("warn", "feishu", &msg);
        if !err.retryable {
            set_status(generation, "error", Some(msg));
            return;
        }
        if conf.reconnect_count >= 0 && attempts >= conf.reconnect_count {
            set_status(generation, "error", Some(format!("重连 {attempts} 次仍没连上：{msg}")));
            return;
        }
        // 等待重连期间仍算「连接中」，lastError 写上次为什么断
        set_status(generation, "connecting", Some(msg));
        let delay = if attempts == 0 {
            Duration::from_millis(random_below(conf.reconnect_nonce * 1000).max(1000))
        } else {
            Duration::from_secs(conf.reconnect_interval)
        };
        attempts += 1;
        if !sleep_unless_stopped(&stop, delay) {
            return;
        }
    }
}

fn is_timeout(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)
}

fn send_frame(socket: &mut Socket, frame: &Frame) -> Result<(), ConnError> {
    socket
        .send(tungstenite::Message::binary(frame.encode()))
        .map_err(|e| ConnError::retry(format!("往飞书写数据失败：{e}")))
}

/// 一条连接的收发循环。Ok = 被要求停下；Err = 断了要重连
fn run_session(
    socket: &mut Socket,
    service: i32,
    conf: &mut ClientConf,
    stop: &AtomicBool,
    app_id: &str,
    secret: &str,
    reassembler: &mut Reassembler,
) -> Result<(), ConnError> {
    let mut next_ping = Instant::now();
    let mut last_recv = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            let _ = socket.close(None);
            let _ = socket.flush();
            return Ok(());
        }
        let now = Instant::now();
        if now >= next_ping {
            send_frame(socket, &ping_frame(service))?;
            next_ping = now + Duration::from_secs(conf.ping_interval);
        }
        if now.saturating_duration_since(last_recv) > Duration::from_secs(conf.ping_interval * 2 + 5) {
            return Err(ConnError::retry("飞书长连接心跳超时，网络可能断了"));
        }
        match socket.read() {
            Ok(tungstenite::Message::Binary(bytes)) => {
                last_recv = Instant::now();
                handle_binary(socket, &bytes, conf, app_id, secret, reassembler)?;
            }
            Ok(tungstenite::Message::Close(_)) => {
                return Err(ConnError::retry("飞书服务器关闭了长连接"));
            }
            Ok(_) => last_recv = Instant::now(),
            Err(tungstenite::Error::Io(e)) if is_timeout(&e) => {}
            Err(e) => return Err(ConnError::retry(format!("飞书长连接断开：{e}"))),
        }
    }
}

fn handle_binary(
    socket: &mut Socket,
    bytes: &[u8],
    conf: &mut ClientConf,
    app_id: &str,
    secret: &str,
    reassembler: &mut Reassembler,
) -> Result<(), ConnError> {
    let frame = match Frame::decode(bytes) {
        Ok(f) => f,
        Err(e) => {
            crate::logbuf::record("warn", "feishu", &format!("解不开飞书发来的帧：{e}"));
            return Ok(());
        }
    };
    let kind = frame.header("type").unwrap_or("").to_string();
    if frame.method == METHOD_CONTROL {
        if kind == "pong" {
            if let Some(v) = frame.payload.as_deref().and_then(|p| serde_json::from_slice::<Value>(p).ok()) {
                conf.apply(&v);
            }
        }
        return Ok(());
    }
    if frame.method != METHOD_DATA {
        return Ok(());
    }
    let started = Instant::now();
    let msg_id = frame.header("message_id").unwrap_or("").to_string();
    let Some(payload) = reassembler.push(
        &msg_id,
        frame.header_int("sum"),
        frame.header_int("seq"),
        frame.payload.clone().unwrap_or_default(),
        started,
    ) else {
        return Ok(());
    };
    // 两个官方 SDK 都只处理 type=event（新版卡片回调 card.action.trigger 也走它），别的不回执
    if kind != "event" {
        return Ok(());
    }
    let inbound = router().route(&payload, started);
    let toast = matches!(inbound, Inbound::CardAction(_))
        .then(|| json!({ "toast": { "type": "info", "content": "收到" } }));
    let mut ack = frame;
    ack.headers.push(("biz_rt".into(), started.elapsed().as_millis().to_string()));
    ack.payload = Some(response_payload(200, toast.as_ref()));
    send_frame(socket, &ack)?;
    apply_inbound(inbound, app_id, secret);
    Ok(())
}

fn spawn_reply(app_id: &str, secret: &str, open_id: String, text: &'static str) {
    let (app_id, secret) = (app_id.to_string(), secret.to_string());
    tauri::async_runtime::spawn(async move {
        let content = json!({ "text": text }).to_string();
        if let Err(e) = send_message(&app_id, &secret, &open_id, "text", content).await {
            crate::logbuf::record("warn", "feishu", &redact(&format!("飞书回话失败：{e}"), &secret));
        }
    });
}

fn apply_inbound(inbound: Inbound, app_id: &str, secret: &str) {
    match inbound {
        Inbound::Ignore => {}
        Inbound::Message(dto) => emit("feishu-message", dto),
        Inbound::CardAction(dto) => emit("feishu-card-action", dto),
        Inbound::Paired { open_id } => {
            let saved = update_config(|c| {
                if c.app_id == app_id {
                    c.bound_open_id = Some(open_id.clone());
                }
            });
            if let Err(e) = saved {
                crate::logbuf::record("warn", "feishu", &format!("保存飞书绑定失败：{e}"));
            }
            emit_status();
            spawn_reply(app_id, secret, open_id, TEXT_PAIRED);
        }
        Inbound::Reply { open_id, text } => spawn_reply(app_id, secret, open_id, text),
    }
}

// ===== REST：令牌与发消息 =====

struct TokenCache {
    app_id: String,
    token: String,
    expires_at: Instant,
}

static TOKEN: Mutex<Option<TokenCache>> = Mutex::new(None);

async fn tenant_token(app_id: &str, secret: &str, force: bool) -> Result<String, String> {
    if !force {
        let cached = TOKEN.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = cached.as_ref().filter(|c| c.app_id == app_id && c.expires_at > Instant::now()) {
            return Ok(c.token.clone());
        }
    }
    let resp = http()
        .post(format!("{API_BASE}{TOKEN_PATH}"))
        .json(&json!({ "app_id": app_id, "app_secret": secret }))
        .send()
        .await
        .map_err(|e| format!("连不上飞书服务器：{e}"))?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);
    let token = body.get("tenant_access_token").and_then(Value::as_str).unwrap_or("");
    if code != 0 || token.is_empty() {
        let msg = body.get("msg").and_then(Value::as_str).unwrap_or("");
        return Err(format!(
            "飞书不认这组 App ID / App Secret：{}（错误码 {code}，HTTP {}）",
            if msg.is_empty() { "未说明原因" } else { msg },
            status.as_u16()
        ));
    }
    let expire = body.get("expire").and_then(Value::as_u64).unwrap_or(7200);
    // 提前 5 分钟换新，免得发到一半过期
    let ttl = Duration::from_secs(expire.saturating_sub(300).max(60));
    *TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = Some(TokenCache {
        app_id: app_id.to_string(),
        token: token.to_string(),
        expires_at: Instant::now() + ttl,
    });
    Ok(token.to_string())
}

/// 发一条消息给某个 open_id，返回 message_id。content 是 JSON **字符串**（飞书接口要求）
async fn send_message(app_id: &str, secret: &str, open_id: &str, msg_type: &str, content: String) -> Result<String, String> {
    let body = json!({ "receive_id": open_id, "msg_type": msg_type, "content": content });
    for attempt in 0..2 {
        let token = tenant_token(app_id, secret, attempt > 0).await?;
        let resp = http()
            .post(format!("{API_BASE}{SEND_PATH}"))
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("连不上飞书服务器：{e}"))?;
        let status = resp.status();
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        let code = v.get("code").and_then(Value::as_i64).unwrap_or(-1);
        if code == 0 {
            return v
                .pointer("/data/message_id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| "飞书收下了消息但没回消息 id".to_string());
        }
        // 令牌失效（99991661 缺令牌 / 99991663 令牌无效）：换新令牌再试一次
        if attempt == 0 && matches!(code, 99991661 | 99991663) {
            continue;
        }
        let msg = v.get("msg").and_then(Value::as_str).unwrap_or("");
        return Err(format!(
            "飞书没收下这条消息：{}（错误码 {code}，HTTP {}）",
            if msg.is_empty() { "未说明原因" } else { msg },
            status.as_u16()
        ));
    }
    Err("飞书令牌换新后仍被拒".into())
}

/// 发给绑定人：通道要开着、要已绑定
async fn send_to_bound(msg_type: &str, content: String) -> Result<String, String> {
    let cfg = load_config();
    if !cfg.enabled {
        return Err("飞书通道没打开".into());
    }
    let secret = load_secret(&cfg.app_id).ok_or("缺少 App Secret，请在设置里重新填写")?;
    let open_id = cfg.bound_open_id.ok_or("还没绑定")?;
    send_message(&cfg.app_id, &secret, &open_id, msg_type, content)
        .await
        .map_err(|e| redact(&e, &secret))
}

// ===== 命令 =====

#[tauri::command]
pub async fn feishu_config_get() -> Result<FeishuConfigDto, String> {
    tauri::async_runtime::spawn_blocking(config_dto)
        .await
        .map_err(|e| format!("读取飞书设置失败：{e}"))
}

#[tauri::command]
pub async fn feishu_config_set(app_id: String, app_secret: Option<String>, enabled: bool) -> Result<FeishuConfigDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = config_set_impl(&app_id, app_secret.as_deref(), enabled)?;
        restart(&cfg);
        Ok(config_dto())
    })
    .await
    .map_err(|e| format!("保存飞书设置失败：{e}"))?
}

#[tauri::command]
pub async fn feishu_pair_start() -> Result<String, String> {
    let cfg = tauri::async_runtime::spawn_blocking(load_config)
        .await
        .map_err(|e| format!("读取飞书设置失败：{e}"))?;
    if !cfg.enabled || cfg.app_id.is_empty() {
        return Err("先填好 App ID 和 App Secret 并打开飞书通道".into());
    }
    let code = format!("{:06}", random_below(1_000_000));
    router().start_pairing(code.clone(), Instant::now());
    Ok(code)
}

#[tauri::command]
pub async fn feishu_unbind() -> Result<FeishuConfigDto, String> {
    tauri::async_runtime::spawn_blocking(|| {
        update_config(|c| c.bound_open_id = None)?;
        router().bound_open_id = None;
        let dto = config_dto();
        emit("feishu-status", dto.clone());
        Ok(dto)
    })
    .await
    .map_err(|e| format!("解除绑定失败：{e}"))?
}

#[tauri::command]
pub async fn feishu_send_text(text: String) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("消息是空的".into());
    }
    send_to_bound("text", json!({ "text": text }).to_string()).await
}

#[tauri::command]
pub async fn feishu_send_card(card: Value) -> Result<String, String> {
    if !card.is_object() {
        return Err("卡片内容要是一个 JSON 对象".into());
    }
    send_to_bound("interactive", card.to_string()).await
}

/// 设置页「测试连接」：拿一次令牌和长连接接入点，不开连接
#[tauri::command]
pub async fn feishu_test() -> Result<String, String> {
    let cfg = tauri::async_runtime::spawn_blocking(load_config)
        .await
        .map_err(|e| format!("读取飞书设置失败：{e}"))?;
    if cfg.app_id.is_empty() {
        return Err("还没填 App ID".into());
    }
    let secret = load_secret(&cfg.app_id).ok_or("还没填 App Secret")?;
    tenant_token(&cfg.app_id, &secret, true).await.map_err(|e| redact(&e, &secret))?;
    fetch_endpoint(&cfg.app_id, &secret)
        .await
        .map_err(|e| redact(&e.msg, &secret))?;
    Ok("连接正常：App ID / App Secret 有效，长连接接入点也拿到了".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_sample() -> Frame {
        Frame {
            seq_id: 300,
            log_id: 7,
            service: 12,
            method: METHOD_DATA,
            headers: vec![
                ("type".into(), "event".into()),
                ("message_id".into(), "m-1".into()),
                ("sum".into(), "1".into()),
                ("seq".into(), "0".into()),
                ("trace_id".into(), "飞书-trace".into()),
            ],
            payload_encoding: String::new(),
            payload_type: String::new(),
            payload: Some(br#"{"a":1}"#.to_vec()),
            log_id_new: "new-log".into(),
        }
    }

    #[test]
    fn frame_round_trip_with_headers() {
        let f = frame_sample();
        let back = Frame::decode(&f.encode()).unwrap();
        assert_eq!(back, f);
        assert_eq!(back.header("trace_id"), Some("飞书-trace"));
        assert_eq!(back.header_int("sum"), 1);
    }

    #[test]
    fn ping_frame_bytes_match_go_marshal() {
        // Go: SeqID/LogID/service/method 总写；payload_encoding/type/LogIDNew 空串也写；payload nil 不写
        let bytes = ping_frame(12).encode();
        let mut want = vec![0x08, 0, 0x10, 0, 0x18, 12, 0x20, 0, 0x2a, 12, 0x0a, 4];
        want.extend_from_slice(b"type");
        want.extend_from_slice(&[0x12, 4]);
        want.extend_from_slice(b"ping");
        want.extend_from_slice(&[0x32, 0, 0x3a, 0, 0x4a, 0]);
        assert_eq!(bytes, want);
    }

    #[test]
    fn negative_service_and_unknown_fields_survive() {
        let f = Frame { service: -3, method: METHOD_CONTROL, ..Frame::default() };
        let mut bytes = f.encode();
        // 尾部塞一个不认识的字段（编号 15，varint）
        bytes.extend_from_slice(&[0x78, 0x05]);
        let back = Frame::decode(&bytes).unwrap();
        assert_eq!(back.service, -3);
        assert!(back.payload.is_none());
        assert!(Frame::decode(&[0x42, 0x10, 1]).is_err(), "长度越界要报错");
    }

    #[test]
    fn fragments_reassemble_in_any_order_and_expire() {
        let t0 = Instant::now();
        let mut r = Reassembler::default();
        assert_eq!(r.push("m", 1, 0, b"whole".to_vec(), t0), Some(b"whole".to_vec()));
        assert_eq!(r.push("m", 3, 2, b"c".to_vec(), t0), None);
        assert_eq!(r.push("m", 3, 0, b"a".to_vec(), t0), None);
        assert_eq!(r.push("m", 3, 1, b"b".to_vec(), t0), Some(b"abc".to_vec()));
        assert!(r.pending.is_empty());
        // 越界 seq 丢弃
        assert_eq!(r.push("x", 2, 5, b"?".to_vec(), t0), None);
        // 超过 5 秒没续上：前一片作废
        assert_eq!(r.push("y", 2, 0, b"1".to_vec(), t0), None);
        let later = t0 + FRAGMENT_TTL + Duration::from_secs(1);
        assert_eq!(r.push("y", 2, 1, b"2".to_vec(), later), None);
    }

    #[test]
    fn response_payload_matches_sdk_shape() {
        use base64::Engine;
        let plain: Value = serde_json::from_slice(&response_payload(200, None)).unwrap();
        assert_eq!(plain, json!({ "code": 200, "headers": null, "data": null }));
        let toast = json!({ "toast": { "type": "info", "content": "收到" } });
        let v: Value = serde_json::from_slice(&response_payload(200, Some(&toast))).unwrap();
        let data = base64::engine::general_purpose::STANDARD
            .decode(v["data"].as_str().unwrap())
            .unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&data).unwrap(), toast);
    }

    fn message_event(event_id: &str, message_id: &str, open_id: &str, chat_type: &str, text: &str) -> Vec<u8> {
        json!({
            "schema": "2.0",
            "header": {
                "event_id": event_id,
                "event_type": "im.message.receive_v1",
                "create_time": "1730000000000",
                "token": "",
                "app_id": "cli_test",
                "tenant_key": "tk"
            },
            "event": {
                "sender": {
                    "sender_id": { "union_id": "on_x", "user_id": "u1", "open_id": open_id },
                    "sender_type": "user",
                    "tenant_key": "tk"
                },
                "message": {
                    "message_id": message_id,
                    "create_time": "1730000000123",
                    "chat_id": "oc_1",
                    "chat_type": chat_type,
                    "message_type": "text",
                    "content": json!({ "text": text }).to_string()
                }
            }
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn bound_user_p2p_text_is_emitted() {
        let mut r = Router::new(Some("ou_me".into()));
        let now = Instant::now();
        let got = r.route(&message_event("e1", "om_1", "ou_me", "p2p", "进度怎么样"), now);
        assert_eq!(
            got,
            Inbound::Message(FeishuMessageDto { text: "进度怎么样".into(), message_id: "om_1".into(), at: 1730000000123 })
        );
        let dto = serde_json::to_value(FeishuMessageDto { text: "t".into(), message_id: "m".into(), at: 1 }).unwrap();
        assert_eq!(dto, json!({ "text": "t", "messageId": "m", "at": 1 }));
        // 群聊不理
        assert_eq!(r.route(&message_event("e2", "om_2", "ou_me", "group", "hi"), now), Inbound::Ignore);
    }

    #[test]
    fn redelivered_event_is_deduped() {
        let mut r = Router::new(Some("ou_me".into()));
        let now = Instant::now();
        let ev = message_event("e1", "om_1", "ou_me", "p2p", "hi");
        assert!(matches!(r.route(&ev, now), Inbound::Message(_)));
        assert_eq!(r.route(&ev, now), Inbound::Ignore);
        // 换了 event_id 但同一条消息：也算重复
        assert_eq!(r.route(&message_event("e9", "om_1", "ou_me", "p2p", "hi"), now), Inbound::Ignore);
    }

    #[test]
    fn stranger_is_filtered_and_reply_rate_limited() {
        let mut r = Router::new(Some("ou_me".into()));
        let now = Instant::now();
        assert_eq!(
            r.route(&message_event("e1", "om_1", "ou_other", "p2p", "hi"), now),
            Inbound::Reply { open_id: "ou_other".into(), text: TEXT_STRANGER }
        );
        assert_eq!(r.route(&message_event("e2", "om_2", "ou_other", "p2p", "hi"), now), Inbound::Ignore);
        let later = now + STRANGER_REPLY_EVERY + Duration::from_secs(1);
        assert!(matches!(r.route(&message_event("e3", "om_3", "ou_other", "p2p", "hi"), later), Inbound::Reply { .. }));
        // 没绑定任何人时，谁发都不转
        let mut empty = Router::new(None);
        assert!(!matches!(empty.route(&message_event("e1", "om_1", "ou_me", "p2p", "hi"), now), Inbound::Message(_)));
    }

    #[test]
    fn pairing_accepts_valid_code_in_both_forms() {
        let now = Instant::now();
        let mut r = Router::new(None);
        r.start_pairing("123456".into(), now);
        assert_eq!(
            r.route(&message_event("e1", "om_1", "ou_new", "p2p", "绑定 123456"), now),
            Inbound::Paired { open_id: "ou_new".into() }
        );
        assert_eq!(r.bound_open_id.as_deref(), Some("ou_new"));
        assert!(r.pairing.is_none(), "用过即作废");
        // 绑定后同一个人的话照常转
        assert!(matches!(r.route(&message_event("e2", "om_2", "ou_new", "p2p", "你好"), now), Inbound::Message(_)));

        let mut r2 = Router::new(None);
        r2.start_pairing("000042".into(), now);
        assert!(matches!(r2.route(&message_event("e1", "om_1", "ou_a", "p2p", " 000042 "), now), Inbound::Paired { .. }));
        assert_eq!(pair_code_candidate("绑定：654321").as_deref(), Some("654321"));
        assert_eq!(pair_code_candidate("12345"), None);
        assert_eq!(pair_code_candidate("绑定 12345a"), None);
    }

    #[test]
    fn pairing_rejects_expired_and_wrong_codes() {
        let now = Instant::now();
        let mut r = Router::new(None);
        r.start_pairing("123456".into(), now);
        let later = now + PAIR_TTL + Duration::from_secs(1);
        assert_eq!(
            r.route(&message_event("e1", "om_1", "ou_a", "p2p", "123456"), later),
            Inbound::Reply { open_id: "ou_a".into(), text: TEXT_WRONG_CODE }
        );
        assert!(r.bound_open_id.is_none());
        assert!(r.pairing.is_none());

        r.start_pairing("123456".into(), now);
        for i in 0..PAIR_MAX_WRONG {
            let got = r.route(&message_event(&format!("w{i}"), &format!("om_w{i}"), "ou_a", "p2p", "999999"), now);
            assert_eq!(got, Inbound::Reply { open_id: "ou_a".into(), text: TEXT_WRONG_CODE });
        }
        assert!(r.pairing.is_none(), "错满次数作废");
        // 作废后再发对的码也不认
        assert!(!matches!(r.route(&message_event("ok", "om_ok", "ou_a", "p2p", "123456"), now), Inbound::Paired { .. }));
        assert!(r.bound_open_id.is_none());
    }

    fn card_event(event_id: &str, open_id: &str) -> Vec<u8> {
        json!({
            "schema": "2.0",
            "header": { "event_id": event_id, "event_type": "card.action.trigger", "create_time": "1", "app_id": "cli_test", "tenant_key": "tk" },
            "event": {
                "operator": { "tenant_key": "tk", "user_id": "u1", "open_id": open_id },
                "token": "c-token",
                "action": { "value": { "kind": "approve", "runId": "r-1" }, "tag": "button" },
                "host": "im_message",
                "context": { "open_message_id": "om_card", "open_chat_id": "oc_1" }
            }
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn card_action_from_bound_user_is_emitted() {
        let mut r = Router::new(Some("ou_me".into()));
        let now = Instant::now();
        let got = r.route(&card_event("c1", "ou_me"), now);
        let Inbound::CardAction(dto) = got else { panic!("应转给前端：{got:?}") };
        assert_eq!(dto.value, json!({ "kind": "approve", "runId": "r-1" }));
        assert_eq!(dto.open_message_id.as_deref(), Some("om_card"));
        assert_eq!(
            serde_json::to_value(&dto).unwrap(),
            json!({ "value": { "kind": "approve", "runId": "r-1" }, "messageId": "c1", "openMessageId": "om_card" })
        );
        assert_eq!(r.route(&card_event("c1", "ou_me"), now), Inbound::Ignore, "重投去重");
        assert_eq!(r.route(&card_event("c2", "ou_other"), now), Inbound::Ignore, "别人点的不转");
    }

    #[test]
    fn client_conf_applies_server_values() {
        let mut c = ClientConf::default();
        c.apply(&json!({ "PingInterval": 90, "ReconnectInterval": 60, "ReconnectNonce": 10, "ReconnectCount": 5 }));
        assert_eq!(c, ClientConf { reconnect_count: 5, reconnect_interval: 60, reconnect_nonce: 10, ping_interval: 90 });
        c.apply(&json!({ "PingInterval": 0 }));
        assert_eq!(c.ping_interval, 90, "0 不收");
        assert_eq!(query_param("wss://x/ws?device_id=d&service_id=33", "service_id").as_deref(), Some("33"));
    }

    #[test]
    fn config_keeps_secret_out_of_file_and_dto() {
        let tmp = std::env::temp_dir().join(format!("mesa-feishu-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let _root = crate::storage::redirect_config_root(&tmp);

        assert!(config_set_impl("cli_a", None, true).is_err(), "没 Secret 不能打开");
        let cfg = config_set_impl("cli_a", Some("secret-value-1234567890"), true).unwrap();
        assert!(cfg.enabled);
        let file = std::fs::read_to_string(tmp.join("feishu.json")).unwrap();
        assert!(!file.contains("secret-value"), "Secret 不进 feishu.json");
        assert_eq!(load_secret("cli_a").as_deref(), Some("secret-value-1234567890"));

        update_config(|c| c.bound_open_id = Some("ou_1234567890abcd".into())).unwrap();
        let dto = config_dto();
        assert!(dto.has_secret);
        assert_eq!(dto.bound_user.as_deref(), Some("ou_…abcd"));
        let json = serde_json::to_string(&dto).unwrap();
        assert!(!json.contains("secret-value"));
        assert!(json.contains("\"hasSecret\":true") && json.contains("\"boundUser\"") && json.contains("\"lastError\""));

        // Secret 留空 = 保持原值
        assert!(config_set_impl("cli_a", Some(""), false).is_ok());
        assert!(load_secret("cli_a").is_some());
        // 换应用：绑定作废、旧 Secret 清掉
        let cfg = config_set_impl("cli_b", Some("another-secret-0987654321"), true).unwrap();
        assert!(cfg.bound_open_id.is_none());
        assert!(load_secret("cli_a").is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
