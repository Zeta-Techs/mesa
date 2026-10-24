//! 出图模型（2026-10-23）：模型分类（哪些不能当对话模型）+ 按厂商选接口出图。
//!
//! - 分类：网关的 `/models` 目录把出图 / 视频 / 向量 / 语音模型和对话模型混在一起列，
//!   只有个别网关标了端点类型，所以按模型名判断。规则与前端 `src/model-kinds.ts` 互为镜像，
//!   两侧测试共读 `tests/fixtures/model-kinds.json`，改一侧必须同改另一侧。
//! - 出图：连接页「出图模型」选定网关 + 模型（存在设置里）；Gemini 系走原生 generateContent，
//!   不通再退对话接口取图；其余（gpt-image / Grok / 豆包 Seedream / 通义万相 / CogView …）
//!   走 OpenAI 出图接口 `/images/generations`。
//! - Agent 侧：随包 `mesa_helper image …` 调本模块（helper_image_cli），密钥由 helper 从
//!   keys.json 现取，不进 Agent 的环境变量；Mesa 启动 PTY 时只注入 `MESA_IMAGE_TOOL`（helper 路径）。

use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

// ===== 模型分类 =====

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelKind {
    Chat,
    Image,
    Video,
    Embedding,
    Rerank,
    Audio,
    Moderation,
}

impl ModelKind {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn as_str(self) -> &'static str {
        match self {
            ModelKind::Chat => "chat",
            ModelKind::Image => "image",
            ModelKind::Video => "video",
            ModelKind::Embedding => "embedding",
            ModelKind::Rerank => "rerank",
            ModelKind::Audio => "audio",
            ModelKind::Moderation => "moderation",
        }
    }
}

/// 模型名拆词：去掉 `厂商/` 前缀，小写，按 `-` `_` `:` 空格等切开；`.` 留在词里（wan2.6、flux.1）
fn tokens(id: &str) -> Vec<String> {
    let base = id.rsplit('/').next().unwrap_or(id).to_lowercase();
    base.split(|c: char| !(c.is_ascii_alphanumeric() || c == '.'))
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

fn any_exact(toks: &[String], words: &[&str]) -> bool {
    toks.iter().any(|t| words.contains(&t.as_str()))
}

fn any_prefix(toks: &[String], prefixes: &[&str]) -> bool {
    toks.iter().any(|t| prefixes.iter().any(|p| t.starts_with(p)))
}

/// 判定顺序有讲究：视频先于出图（grok-imagine-video、wanx2.1-t2v），重排先于向量（bge-reranker）
pub fn model_kind(id: &str) -> ModelKind {
    let t = tokens(id);
    if any_exact(&t, &["video", "videos", "t2v", "i2v", "r2v", "kf2v", "s2v", "animate", "vace"])
        || any_prefix(&t, &["sora", "veo", "kling", "seedance", "hailuo", "vidu", "cogvideo", "runway", "pika"])
    {
        return ModelKind::Video;
    }
    if any_exact(&t, &["image", "images", "imageedit", "t2i", "i2i", "imagine", "banana", "diffusion"])
        || any_prefix(
            &t,
            &[
                "imagen", "seedream", "seededit", "cogview", "flux", "dall", "midjourney", "ideogram",
                "recraft", "kolors", "hidream", "jimeng", "wanx", "sdxl", "sd3",
            ],
        )
    {
        return ModelKind::Image;
    }
    if any_prefix(&t, &["rerank"]) {
        return ModelKind::Rerank;
    }
    if any_exact(&t, &["embedding", "embeddings", "embed"]) || any_prefix(&t, &["bge", "m3e"]) {
        return ModelKind::Embedding;
    }
    if any_exact(&t, &["tts", "whisper", "transcribe", "asr", "speech"])
        || any_prefix(&t, &["cosyvoice", "paraformer", "sambert", "sensevoice"])
    {
        return ModelKind::Audio;
    }
    if any_exact(&t, &["moderation"]) {
        return ModelKind::Moderation;
    }
    ModelKind::Chat
}

/// 能「只给一句话就出图」的模型：出图类里去掉改图 / 图生图 / 图片翻译（要先给一张图）
pub fn is_image_gen_model(id: &str) -> bool {
    if model_kind(id) != ModelKind::Image {
        return false;
    }
    let t = tokens(id);
    !(any_exact(&t, &["edit", "imageedit", "i2i", "mt"]) || any_prefix(&t, &["seededit"]))
}

/// 启动 Agent 前的闸（agents::validate_launch_compatibility）：非对话模型给出白话原因
pub fn non_chat_launch_error(model: &str) -> Option<String> {
    let what = match model_kind(model) {
        ModelKind::Chat => return None,
        ModelKind::Image => {
            return Some(format!(
                "{model} 是出图模型，不能用来和 Agent 对话。换一个对话模型启动；要出图，到连接页最下方「出图模型」选它，Agent 就能调用它出图"
            ))
        }
        ModelKind::Video => "视频模型",
        ModelKind::Embedding => "向量模型",
        ModelKind::Rerank => "重排模型",
        ModelKind::Audio => "语音模型",
        ModelKind::Moderation => "审核模型",
    };
    Some(format!("{model} 是{what}，不能用来和 Agent 对话，换一个对话模型启动"))
}

// ===== 接口选择 =====

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    /// POST {base}/images/generations（OpenAI 出图接口；绝大多数厂商与中转兼容）
    OpenAiImages,
    /// POST {base}/v1beta/models/{m}:generateContent，失败再退 /chat/completions
    Gemini,
}

impl Protocol {
    pub fn label(self) -> &'static str {
        match self {
            Protocol::OpenAiImages => "OpenAI 出图接口",
            Protocol::Gemini => "Gemini 原生接口",
        }
    }
}

pub fn protocol_for(model: &str) -> Protocol {
    let t = tokens(model);
    if t.first().is_some_and(|f| f == "gemini") || any_exact(&t, &["banana"]) {
        Protocol::Gemini
    } else {
        Protocol::OpenAiImages
    }
}

/// OpenAI 风格资源地址：base 已带版本段（/v1、/api/v3、/api/paas/v4）直接挂，否则补 /v1
fn openai_url(base: &str, resource: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if crate::models::ends_with_version_segment(base) {
        format!("{base}/{resource}")
    } else {
        format!("{base}/v1/{resource}")
    }
}

fn gemini_url(base: &str, model: &str) -> String {
    let base = crate::models::strip_trailing_version_segment(base.trim().trim_end_matches('/'));
    format!("{}/v1beta/models/{model}:generateContent", base.trim_end_matches('/'))
}

/// 尺寸 `宽x高` → Gemini 支持的最接近画幅；解析不了返回 None（不传，用模型默认）
fn aspect_ratio(size: &str) -> Option<&'static str> {
    let (w, h) = size.trim().to_lowercase().split_once(['x', '*', '×']).map(|(w, h)| {
        (w.trim().parse::<f64>().ok(), h.trim().parse::<f64>().ok())
    })?;
    let (w, h) = (w?, h?);
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    const RATIOS: &[(&str, f64)] = &[
        ("1:1", 1.0),
        ("2:3", 2.0 / 3.0),
        ("3:2", 1.5),
        ("3:4", 0.75),
        ("4:3", 4.0 / 3.0),
        ("4:5", 0.8),
        ("5:4", 1.25),
        ("9:16", 9.0 / 16.0),
        ("16:9", 16.0 / 9.0),
        ("21:9", 21.0 / 9.0),
    ];
    let r = w / h;
    RATIOS
        .iter()
        .min_by(|a, b| (a.1 - r).abs().total_cmp(&(b.1 - r).abs()))
        .map(|(name, _)| *name)
}

// ===== 解析各家返回 =====

#[derive(Debug, PartialEq)]
enum Piece {
    Bytes(Vec<u8>),
    Url(String),
}

fn decode_b64(s: &str) -> Option<Vec<u8>> {
    let clean: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(clean.as_bytes())
        .ok()
        .filter(|b| !b.is_empty())
}

/// data:image/...;base64,xxx 或 http(s) 地址
fn piece_from_ref(r: &str) -> Option<Piece> {
    let r = r.trim();
    if let Some(rest) = r.strip_prefix("data:") {
        let (_, data) = rest.split_once(";base64,")?;
        return decode_b64(data).map(Piece::Bytes);
    }
    if r.starts_with("https://") || r.starts_with("http://") {
        return Some(Piece::Url(r.to_string()));
    }
    None
}

/// OpenAI 出图接口：data[].b64_json | data[].url
fn parse_openai_images(v: &serde_json::Value) -> Vec<Piece> {
    let Some(arr) = v.get("data").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| {
            if let Some(b) = item.get("b64_json").and_then(|b| b.as_str()) {
                return decode_b64(b).map(Piece::Bytes);
            }
            item.get("url").and_then(|u| u.as_str()).and_then(piece_from_ref)
        })
        .collect()
}

/// Gemini 原生：candidates[].content.parts[].inlineData{data}（兼容 snake 写法）
fn parse_gemini(v: &serde_json::Value) -> Vec<Piece> {
    let mut out = Vec::new();
    for cand in v.get("candidates").and_then(|c| c.as_array()).into_iter().flatten() {
        let parts = cand.pointer("/content/parts").and_then(|p| p.as_array());
        for part in parts.into_iter().flatten() {
            let inline = part.get("inlineData").or_else(|| part.get("inline_data"));
            if let Some(data) = inline.and_then(|i| i.get("data")).and_then(|d| d.as_str()) {
                if let Some(bytes) = decode_b64(data) {
                    out.push(Piece::Bytes(bytes));
                }
            }
        }
    }
    out
}

/// 对话接口里带回的图：message.images[].image_url.url（OpenRouter 形状）或正文里的
/// markdown 图片 `![..](data:… / https://…)`（New API 转 Gemini 的形状，2026-10-23 实测）
fn parse_chat_images(v: &serde_json::Value) -> Vec<Piece> {
    let mut out = Vec::new();
    let Some(msg) = v.pointer("/choices/0/message") else {
        return out;
    };
    for img in msg.get("images").and_then(|i| i.as_array()).into_iter().flatten() {
        let url = img
            .pointer("/image_url/url")
            .or_else(|| img.get("url"))
            .and_then(|u| u.as_str());
        if let Some(p) = url.and_then(piece_from_ref) {
            out.push(p);
        }
    }
    if !out.is_empty() {
        return out;
    }
    let content = match msg.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| {
                p.pointer("/image_url/url")
                    .and_then(|u| u.as_str())
                    .map(|u| format!("![]({u})"))
                    .or_else(|| p.get("text").and_then(|t| t.as_str()).map(str::to_string))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    let mut rest = content.as_str();
    while let Some(i) = rest.find("](") {
        let after = &rest[i + 2..];
        let end = after.find(')').unwrap_or(after.len());
        if let Some(p) = piece_from_ref(&after[..end]) {
            out.push(p);
        }
        rest = &after[end..];
    }
    out
}

/// 按文件头认图片格式；认不出的不当图片（防止把网关错误页存成 .png）
pub fn image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.starts_with(b"GIF8") {
        Some("gif")
    } else {
        None
    }
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    }
}

// ===== 解析配置 =====

/// 一次出图要用的连接：网关地址、密钥、Header，与模型
pub struct Target {
    pub gateway_id: String,
    pub gateway_name: String,
    pub no_auth: bool,
    pub openai_base: Option<String>,
    pub gemini_base: Option<String>,
    pub headers: Vec<(String, String)>,
    pub model: String,
}

fn target_from_gateway(gw: &crate::profiles::Gateway, model: &str) -> Target {
    use crate::gateway_store::{slot_url, Slot};
    let pick = |order: &[Slot]| {
        order
            .iter()
            .find_map(|s| slot_url(&gw.slots, *s))
            .map(str::to_string)
    };
    Target {
        gateway_id: gw.id.clone(),
        gateway_name: gw.name.clone(),
        no_auth: gw.no_auth,
        openai_base: pick(&[Slot::Openai, Slot::Responses, Slot::Anthropic]),
        gemini_base: pick(&[Slot::Gemini, Slot::Openai, Slot::Responses]),
        // Header 值 = Mesa 进程环境变量（网关只存变量名，同 agents.rs apply_request_policy_env）
        headers: gw
            .header_env
            .iter()
            .filter_map(|(h, var)| {
                std::env::var(var)
                    .ok()
                    .filter(|v| !v.is_empty())
                    .map(|v| (h.clone(), v))
            })
            .collect(),
        model: model.to_string(),
    }
}

fn gateway_has_model(gw: &crate::profiles::Gateway, model: &str) -> bool {
    gw.models.iter().any(|m| m.id == model && m.status != "stale")
}

/// 模型挑选：显式指定的模型优先在默认网关找，找不到再去别的网关目录里找；
/// 都没有就仍用默认网关（目录可能不全，让网关自己回话）
fn resolve_target_in(
    gateways: &[crate::profiles::Gateway],
    default_gateway: Option<&str>,
    default_model: Option<&str>,
    model_override: Option<&str>,
) -> Result<Target, String> {
    let default_gw = default_gateway.and_then(|id| gateways.iter().find(|g| g.id == id));
    let model = model_override
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .or(default_model.map(str::trim).filter(|m| !m.is_empty()));
    let Some(model) = model else {
        return Err(NOT_CONFIGURED.into());
    };
    if let Some(gw) = default_gw.filter(|g| gateway_has_model(g, model)) {
        return Ok(target_from_gateway(gw, model));
    }
    if let Some(gw) = gateways.iter().find(|g| gateway_has_model(g, model)) {
        return Ok(target_from_gateway(gw, model));
    }
    if let Some(gw) = default_gw {
        return Ok(target_from_gateway(gw, model));
    }
    if default_gateway.is_some() {
        return Err("设置里选的出图网关已经不在了：到 Mesa 连接页最下方「出图模型」重新选一个".into());
    }
    Err(format!(
        "没有哪个网关的模型目录里有 {model}：到 Mesa 连接页最下方「出图模型」选一个网关"
    ))
}

const NOT_CONFIGURED: &str =
    "还没配置出图模型：到 Mesa 连接页最下方「出图模型」选一个（各家网关目录里的出图模型都能选）";

pub fn resolve_target(model_override: Option<&str>) -> Result<Target, String> {
    let s = crate::settings::read_current();
    let gateways = crate::gateway_store::load_gateways()?;
    resolve_target_in(
        &gateways,
        s.image_gen_gateway_id.as_deref(),
        s.image_gen_model.as_deref(),
        model_override,
    )
}

// ===== 请求 =====

pub struct GenRequest {
    pub prompt: String,
    pub size: Option<String>,
    pub n: u32,
    /// 改图：在这几张图上改（--image，可多张）；空 = 文生图
    pub images: Vec<InputImage>,
}

/// 改图的输入图：字节 + 按文件头认出的格式
pub struct InputImage {
    pub bytes: Vec<u8>,
    pub ext: &'static str,
}

impl InputImage {
    fn data_url(&self) -> String {
        format!(
            "data:{};base64,{}",
            mime_of(self.ext),
            base64::engine::general_purpose::STANDARD.encode(&self.bytes)
        )
    }
}

/// 改图输入单张上限（与聊天层读图同档）
const INPUT_IMAGE_CAP: u64 = 20 * 1024 * 1024;
/// 一次最多带几张参考图
const INPUT_IMAGE_MAX: usize = 4;

/// 读一张改图输入：只认真图片（按文件头），超限拒绝
pub fn load_input_image(path: &Path) -> Result<InputImage, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读不了图片 {}: {e}", path.display()))?;
    if meta.len() > INPUT_IMAGE_CAP {
        return Err(format!("图片 {} 超过 20 MB", path.display()));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("读不了图片 {}: {e}", path.display()))?;
    let ext = image_ext(&bytes).ok_or_else(|| format!("{} 不是 png / jpg / webp / gif 图片", path.display()))?;
    Ok(InputImage { bytes, ext })
}

/// 豆包 Seedream / SeedEdit 的改图是出图接口里带 `image` 字段（火山方舟口径），不走 /images/edits
fn edits_via_generations(model: &str) -> bool {
    let t = tokens(model);
    any_prefix(&t, &["seedream", "seededit"])
}

/// 手拼 multipart/form-data（/images/edits 用；不为这一处给 reqwest 加 multipart 特性）
fn multipart_body(fields: &[(&str, String)], files: &[(&str, &InputImage)]) -> (String, Vec<u8>) {
    let boundary = format!("mesa-{}", uuid::Uuid::new_v4().simple());
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes(),
        );
    }
    for (i, (name, img)) in files.iter().enumerate() {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"image-{}.{}\"\r\nContent-Type: {}\r\n\r\n",
                i + 1,
                img.ext,
                mime_of(img.ext)
            )
            .as_bytes(),
        );
        body.extend_from_slice(&img.bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

pub struct GenImage {
    pub bytes: Vec<u8>,
    pub ext: &'static str,
}

pub struct GenOutcome {
    pub images: Vec<GenImage>,
    pub protocol: Protocol,
    /// 走了退路（Gemini 原生不通改用对话接口）时说一句
    pub note: Option<String>,
}

fn preview(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let red = crate::sessions::redact_sensitive_text(&flat);
    if red.chars().count() > 300 {
        format!("{}…", red.chars().take(300).collect::<String>())
    } else {
        red
    }
}

/// 网关回的错误：优先取 error.message，再退原文开头（脱敏）
fn error_text(status: reqwest::StatusCode, body: &str) -> String {
    let msg = serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| {
        v.pointer("/error/message")
            .or_else(|| v.get("message"))
            .or_else(|| v.get("msg"))
            .and_then(|m| m.as_str())
            .map(str::to_string)
    });
    format!("HTTP {}：{}", status.as_u16(), preview(msg.as_deref().unwrap_or(body)))
}

async fn post_json(
    client: &reqwest::Client,
    url: &str,
    target: &Target,
    key: Option<&str>,
    body: &serde_json::Value,
    gemini: bool,
) -> Result<serde_json::Value, String> {
    send(client.post(url).json(body), target, key, gemini).await
}

async fn post_multipart(
    client: &reqwest::Client,
    url: &str,
    target: &Target,
    key: Option<&str>,
    (content_type, body): (String, Vec<u8>),
) -> Result<serde_json::Value, String> {
    let req = client.post(url).header(reqwest::header::CONTENT_TYPE, content_type).body(body);
    send(req, target, key, false).await
}

async fn send(
    mut req: reqwest::RequestBuilder,
    target: &Target,
    key: Option<&str>,
    gemini: bool,
) -> Result<serde_json::Value, String> {
    if let Some(k) = key {
        req = req.bearer_auth(k);
        if gemini {
            req = req.header("x-goog-api-key", k);
        }
    }
    for (h, v) in &target.headers {
        req = req.header(h.as_str(), v.as_str());
    }
    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            "等了 5 分钟网关还没出图，已放弃".to_string()
        } else {
            format!("连不上网关：{}", preview(&e.to_string()))
        }
    })?;
    let status = resp.status();
    let bytes = crate::storage::response_bytes(resp, 64 * 1024 * 1024).await?;
    let text = String::from_utf8_lossy(&bytes);
    if !status.is_success() {
        return Err(error_text(status, &text));
    }
    serde_json::from_str(&text).map_err(|_| format!("网关回的不是 JSON：{}", preview(&text)))
}

/// 拿图片地址：签名地址不带任何鉴权头（密钥不发给第三方存储）。
/// 先直连；连不上且设置里配了出网代理，再经代理拿一次（imgen.x.ai 国内直连超时，2026-10-23 实测）
async fn download(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let direct = client
        .get(url)
        .timeout(Duration::from_secs(90))
        .send()
        .await;
    let resp = match direct {
        Ok(r) => r,
        Err(e) if e.is_connect() || e.is_timeout() => {
            let s = crate::settings::read_current();
            let proxy = s
                .outbound_proxy
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty() && crate::settings::validate_outbound_proxy(p).is_ok());
            let Some(proxy) = proxy else {
                return Err(format!(
                    "下载图片失败（连不上 {}；要走代理的话到 Mesa 设置 → 网络 填出网代理）",
                    host_of(url)
                ));
            };
            let via = reqwest::Client::builder()
                .proxy(reqwest::Proxy::all(proxy).map_err(|e| format!("出网代理不可用：{e}"))?)
                .timeout(Duration::from_secs(90))
                .build()
                .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
            via.get(url)
                .send()
                .await
                .map_err(|e| format!("下载图片失败（直连和出网代理都不通）：{}", preview(&e.to_string())))?
        }
        Err(e) => return Err(format!("下载图片失败：{}", preview(&e.to_string()))),
    };
    if !resp.status().is_success() {
        return Err(format!("下载图片失败：HTTP {}", resp.status().as_u16()));
    }
    crate::storage::response_bytes(resp, 64 * 1024 * 1024).await
}

fn host_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "图片地址".into())
}

async fn materialize(client: &reqwest::Client, pieces: Vec<Piece>) -> Result<Vec<GenImage>, String> {
    let mut out = Vec::new();
    for p in pieces {
        let bytes = match p {
            Piece::Bytes(b) => b,
            Piece::Url(u) => download(client, &u).await?,
        };
        let Some(ext) = image_ext(&bytes) else {
            return Err("网关回的内容不是图片".into());
        };
        out.push(GenImage { bytes, ext });
    }
    Ok(out)
}

pub async fn generate(target: &Target, req: &GenRequest) -> Result<GenOutcome, String> {
    let prompt = req.prompt.trim();
    if prompt.is_empty() {
        return Err("出图要一段描述（--prompt）".into());
    }
    let key = if target.no_auth {
        None
    } else {
        Some(crate::profiles::get_key(&target.gateway_id)?.ok_or_else(|| {
            format!("网关「{}」没存密钥：到 Mesa 连接页补上", target.gateway_name)
        })?)
    };
    let n = req.n.clamp(1, 4);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        // 连接阶段单独限时：图片存储直连不通时尽快改走出网代理（download）
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let protocol = protocol_for(&target.model);
    match protocol {
        Protocol::OpenAiImages => {
            let base = target
                .openai_base
                .as_deref()
                .ok_or_else(|| format!("网关「{}」没填 OpenAI 地址", target.gateway_name))?;
            let mut body = serde_json::json!({ "model": target.model, "prompt": prompt, "n": n });
            if let Some(size) = req.size.as_deref().filter(|s| !s.trim().is_empty()) {
                body["size"] = serde_json::json!(size.trim());
            }
            // 改图带的参考图写进出图接口的 image 字段（data URL；一张给字符串、多张给数组）
            let with_images = |mut body: serde_json::Value| {
                let urls: Vec<String> = req.images.iter().map(InputImage::data_url).collect();
                body["image"] = if urls.len() == 1 { serde_json::json!(urls[0]) } else { serde_json::json!(urls) };
                body
            };
            let gen_url = openai_url(base, "images/generations");
            let v = if req.images.is_empty() {
                post_json(&client, &gen_url, target, key.as_deref(), &body, false).await?
            } else if edits_via_generations(&target.model) {
                post_json(&client, &gen_url, target, key.as_deref(), &with_images(body), false).await?
            } else {
                // OpenAI 口径改图：/images/edits（multipart）；网关不认再试出图接口带 image 字段
                let mut fields = vec![("model", target.model.clone()), ("prompt", prompt.to_string()), ("n", n.to_string())];
                if let Some(size) = req.size.as_deref().filter(|s| !s.trim().is_empty()) {
                    fields.push(("size", size.trim().to_string()));
                }
                let name = if req.images.len() == 1 { "image" } else { "image[]" };
                let files: Vec<(&str, &InputImage)> = req.images.iter().map(|i| (name, i)).collect();
                let edits_url = openai_url(base, "images/edits");
                match post_multipart(&client, &edits_url, target, key.as_deref(), multipart_body(&fields, &files)).await {
                    Ok(v) => v,
                    Err(edit_err) => post_json(&client, &gen_url, target, key.as_deref(), &with_images(body), false)
                        .await
                        .map_err(|e| format!("改图接口：{edit_err}；出图接口带图：{e}"))?,
                }
            };
            let images = materialize(&client, parse_openai_images(&v)).await?;
            if images.is_empty() {
                return Err(format!("网关回话里没有图片：{}", preview(&v.to_string())));
            }
            Ok(GenOutcome { images, protocol, note: None })
        }
        Protocol::Gemini => {
            let mut config = serde_json::json!({ "responseModalities": ["TEXT", "IMAGE"] });
            if let Some(ar) = req.size.as_deref().and_then(aspect_ratio) {
                config["imageConfig"] = serde_json::json!({ "aspectRatio": ar });
            }
            let mut parts = vec![serde_json::json!({ "text": prompt })];
            for img in &req.images {
                parts.push(serde_json::json!({ "inlineData": {
                    "mimeType": mime_of(img.ext),
                    "data": base64::engine::general_purpose::STANDARD.encode(&img.bytes),
                } }));
            }
            let body = serde_json::json!({
                "contents": [{ "role": "user", "parts": parts }],
                "generationConfig": config,
            });
            let mut images = Vec::new();
            let mut native_err = None;
            if let Some(base) = target.gemini_base.as_deref() {
                // 原生接口一次一张，要几张调几次
                for _ in 0..n {
                    match post_json(&client, &gemini_url(base, &target.model), target, key.as_deref(), &body, true)
                        .await
                    {
                        Ok(v) => images.extend(materialize(&client, parse_gemini(&v)).await?),
                        Err(e) => {
                            native_err = Some(e);
                            break;
                        }
                    }
                }
            }
            if !images.is_empty() {
                return Ok(GenOutcome { images, protocol, note: None });
            }
            // 退路：OpenAI 兼容的对话接口（多数中转把 Gemini 出图挂在这里）
            let Some(base) = target.openai_base.as_deref() else {
                return Err(native_err.unwrap_or_else(|| "Gemini 原生接口没回图片".into()));
            };
            let content = if req.images.is_empty() {
                serde_json::json!(prompt)
            } else {
                let mut parts = vec![serde_json::json!({ "type": "text", "text": prompt })];
                for img in &req.images {
                    parts.push(serde_json::json!({ "type": "image_url", "image_url": { "url": img.data_url() } }));
                }
                serde_json::json!(parts)
            };
            let chat = serde_json::json!({
                "model": target.model,
                "messages": [{ "role": "user", "content": content }],
            });
            let mut fallback = Vec::new();
            for _ in 0..n {
                let v = post_json(&client, &openai_url(base, "chat/completions"), target, key.as_deref(), &chat, false)
                    .await
                    .map_err(|e| match &native_err {
                        Some(n) => format!("Gemini 原生接口：{n}；对话接口：{e}"),
                        None => e,
                    })?;
                fallback.extend(materialize(&client, parse_chat_images(&v)).await?);
            }
            if fallback.is_empty() {
                return Err("Gemini 原生接口和对话接口都没回图片（这个模型可能不出图）".into());
            }
            Ok(GenOutcome {
                images: fallback,
                protocol,
                note: Some("Gemini 原生接口不通，改用对话接口取的图".into()),
            })
        }
    }
}

// ===== 落盘 =====

/// 写图片：扩展名按实际格式改正（不把 jpg 存成 .png）；目标已存在时加 -2、-3，不覆盖；
/// 多张时依次加 -1、-2
pub fn save_images(images: &[GenImage], out: &Path) -> Result<Vec<PathBuf>, String> {
    let dir = out.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录 {} 失败: {e}", dir.display()))?;
    let stem = out
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("image")
        .to_string();
    let mut saved = Vec::new();
    for (i, img) in images.iter().enumerate() {
        let base = if images.len() > 1 { format!("{stem}-{}", i + 1) } else { stem.clone() };
        let mut path = dir.join(format!("{base}.{}", img.ext));
        let mut k = 2;
        while path.exists() {
            path = dir.join(format!("{base}-{k}.{}", img.ext));
            k += 1;
        }
        std::fs::write(&path, &img.bytes).map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
        saved.push(path);
    }
    Ok(saved)
}

// ===== helper 定位与 PTY 注入 =====

/// 随包 helper（mesa_helper）的路径：打包版与主程序同目录（Tauri sidecar 去掉 triple 后缀），
/// 开发态在 target/debug/。试跑 `image --probe` 认得出图子命令才算数（旧 helper 不认）。
pub fn helper_exe() -> Option<PathBuf> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHE.get_or_init(find_helper).clone()
}

fn find_helper() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let triple = env!("TAURI_ENV_TARGET_TRIPLE");
    let names = [format!("mesa_helper{ext}"), format!("mesa_helper-{triple}{ext}")];
    let dirs = [Some(dir.to_path_buf()), dir.parent().map(Path::to_path_buf)];
    for d in dirs.into_iter().flatten() {
        for name in &names {
            let p = d.join(name);
            if !std::fs::metadata(&p).is_ok_and(|m| m.is_file() && m.len() > 0) {
                continue;
            }
            let probe = crate::process::background_command(&p)
                .args(["image", "--probe"])
                .stdin(std::process::Stdio::null())
                .output();
            if probe.is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "ok") {
                return Some(p);
            }
        }
    }
    None
}

/// 注入 Agent 进程的变量名：值是 helper 路径，技能 image-gen 按它调出图
pub const TOOL_ENV: &str = "MESA_IMAGE_TOOL";

// ===== helper 命令行入口 =====

const CLI_USAGE: &str = "用法：mesa_helper image --prompt \"描述\" --out 路径.png [--model 模型] [--size 1024x1024] [--n 1]\n\
     \x20     mesa_helper image --prompt-file 描述.txt --out 路径.png …   （长描述写进文件，避开命令行转义）\n\
     \x20     mesa_helper image --image 原图.png --prompt \"要怎么改\" --out 新图.png   （改图：在原图上改，--image 可给多张）\n\
     \x20     mesa_helper image --list   （列出设置里的出图模型和各网关可用的出图模型）";

struct CliArgs {
    prompt: Option<String>,
    prompt_file: Option<String>,
    out: Option<String>,
    model: Option<String>,
    size: Option<String>,
    n: u32,
    images: Vec<String>,
    list: bool,
}

fn parse_cli(args: &[String]) -> Result<CliArgs, String> {
    let mut a = CliArgs { prompt: None, prompt_file: None, out: None, model: None, size: None, n: 1, images: Vec::new(), list: false };
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut val = || it.next().cloned().ok_or_else(|| format!("{flag} 后面缺值"));
        match flag.as_str() {
            "--prompt" => a.prompt = Some(val()?),
            "--prompt-file" => a.prompt_file = Some(val()?),
            "--out" => a.out = Some(val()?),
            "--model" => a.model = Some(val()?),
            "--size" => a.size = Some(val()?),
            "--n" => a.n = val()?.parse().map_err(|_| "--n 要填 1–4 的数字".to_string())?,
            "--image" => a.images.push(val()?),
            "--list" => a.list = true,
            "-h" | "--help" => return Err(CLI_USAGE.into()),
            other => return Err(format!("不认识的参数 {other}\n{CLI_USAGE}")),
        }
    }
    Ok(a)
}

fn list_text() -> String {
    let s = crate::settings::read_current();
    let gateways = crate::gateway_store::load_gateways().unwrap_or_default();
    let mut lines = Vec::new();
    match (s.image_gen_model.as_deref(), s.image_gen_gateway_id.as_deref()) {
        (Some(m), Some(g)) => {
            let name = gateways.iter().find(|x| x.id == g).map(|x| x.name.as_str()).unwrap_or("（已删除的网关）");
            lines.push(format!("默认出图模型：{m}（网关「{name}」）"));
        }
        _ => lines.push(NOT_CONFIGURED.into()),
    }
    for c in candidates_from(&gateways) {
        lines.push(format!("网关「{}」可用：{}", c.gateway_name, c.models.join("、")));
    }
    lines.join("\n")
}

/// `mesa_helper image …` 的实现；返回进程退出码。成功时每张图一行 `saved: 绝对路径`
pub fn helper_image_cli(args: &[String]) -> i32 {
    if args.first().map(String::as_str) == Some("--probe") {
        println!("ok");
        return 0;
    }
    let a = match parse_cli(args) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    if a.list {
        println!("{}", list_text());
        return 0;
    }
    let prompt = match (&a.prompt, &a.prompt_file) {
        (Some(p), _) => p.clone(),
        (None, Some(f)) => match std::fs::read_to_string(f) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("读不了描述文件 {f}: {e}");
                return 2;
            }
        },
        (None, None) => {
            eprintln!("缺描述：--prompt 或 --prompt-file\n{CLI_USAGE}");
            return 2;
        }
    };
    let Some(out) = a.out.clone() else {
        eprintln!("缺输出路径：--out\n{CLI_USAGE}");
        return 2;
    };
    let target = match resolve_target(a.model.as_deref()) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    if a.images.len() > INPUT_IMAGE_MAX {
        eprintln!("--image 最多 {INPUT_IMAGE_MAX} 张");
        return 2;
    }
    let mut images = Vec::new();
    for p in &a.images {
        match load_input_image(Path::new(p)) {
            Ok(img) => images.push(img),
            Err(e) => {
                eprintln!("{e}");
                return 2;
            }
        }
    }
    let req = GenRequest { prompt, size: a.size.clone(), n: a.n, images };
    let started = Instant::now();
    let result = tauri::async_runtime::block_on(generate(&target, &req));
    match result.and_then(|o| save_images(&o.images, Path::new(&out)).map(|p| (o, p))) {
        Ok((outcome, paths)) => {
            println!(
                "model: {}（网关「{}」，{}，{:.1} 秒）",
                target.model,
                target.gateway_name,
                outcome.protocol.label(),
                started.elapsed().as_secs_f64()
            );
            if let Some(note) = outcome.note {
                println!("note: {note}");
            }
            for p in paths {
                let abs = std::fs::canonicalize(&p).unwrap_or(p);
                println!("saved: {}", crate::paths::strip_verbatim(abs).display());
            }
            0
        }
        Err(e) => {
            eprintln!("出图失败（{}，网关「{}」）：{e}", target.model, target.gateway_name);
            1
        }
    }
}

// ===== Tauri 命令 =====

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenGatewayDto {
    pub gateway_id: String,
    pub gateway_name: String,
    pub models: Vec<String>,
}

fn candidates_from(gateways: &[crate::profiles::Gateway]) -> Vec<ImageGenGatewayDto> {
    gateways
        .iter()
        .filter_map(|g| {
            let mut models: Vec<String> = g
                .models
                .iter()
                .filter(|m| m.status != "stale" && is_image_gen_model(&m.id))
                .map(|m| m.id.clone())
                .collect();
            models.sort();
            models.dedup();
            (!models.is_empty()).then(|| ImageGenGatewayDto {
                gateway_id: g.id.clone(),
                gateway_name: g.name.clone(),
                models,
            })
        })
        .collect()
}

/// 各网关目录里能出图的模型（设置页下拉用）
#[tauri::command]
pub async fn image_gen_candidates() -> Result<Vec<ImageGenGatewayDto>, String> {
    Ok(candidates_from(&crate::gateway_store::load_gateways()?))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenStatusDto {
    /// Agent 能不能调：随包 helper 找到且认出图子命令
    pub helper_ready: bool,
}

#[tauri::command]
pub async fn image_gen_status() -> ImageGenStatusDto {
    let ready = tauri::async_runtime::spawn_blocking(|| helper_exe().is_some())
        .await
        .unwrap_or(false);
    ImageGenStatusDto { helper_ready: ready }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenTestDto {
    pub data_url: String,
    pub protocol: String,
    pub elapsed_ms: u64,
    pub note: Option<String>,
}

/// 连接页「试出与对比」：按网关 + 模型 + 用户写的描述出一张，图只回前端预览、不落盘（对比时前端并行调多次）
#[tauri::command]
pub async fn image_gen_test(
    gateway_id: String,
    model: String,
    prompt: Option<String>,
) -> Result<ImageGenTestDto, String> {
    let gateways = crate::gateway_store::load_gateways()?;
    let gw = gateways
        .iter()
        .find(|g| g.id == gateway_id)
        .ok_or("这个网关已经不在了")?;
    let target = target_from_gateway(gw, model.trim());
    let req = GenRequest {
        prompt: prompt
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| "A small ceramic cup of tea on a wooden desk, soft morning light, simple composition".into()),
        size: None,
        n: 1,
        images: Vec::new(),
    };
    let started = Instant::now();
    let outcome = generate(&target, &req).await?;
    let img = outcome.images.first().ok_or("网关没回图片")?;
    Ok(ImageGenTestDto {
        data_url: format!(
            "data:{};base64,{}",
            mime_of(img.ext),
            base64::engine::general_purpose::STANDARD.encode(&img.bytes)
        ),
        protocol: outcome.protocol.label().into(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        note: outcome.note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{Gateway, GatewayModel, ProtocolSlots};

    #[derive(serde::Deserialize)]
    struct Case {
        id: String,
        kind: String,
        gen: bool,
    }

    /// 与前端 tests/model-kinds.test.ts 共读同一份样例：两侧判定不得分叉
    #[test]
    fn model_kinds_match_shared_fixture() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../tests/fixtures/model-kinds.json")).unwrap();
        assert!(cases.len() > 40);
        for c in cases {
            assert_eq!(model_kind(&c.id).as_str(), c.kind, "{} 的类别", c.id);
            assert_eq!(is_image_gen_model(&c.id), c.gen, "{} 能否直接出图", c.id);
        }
    }

    #[test]
    fn launch_gate_blocks_non_chat_models_with_reason() {
        assert_eq!(non_chat_launch_error("gpt-6-astra"), None);
        assert!(non_chat_launch_error("gpt-image-2.5").unwrap().contains("出图模型"));
        assert!(non_chat_launch_error("text-embedding-3-large").unwrap().contains("向量模型"));
    }

    #[test]
    fn protocol_picks_gemini_native_only_for_gemini_family() {
        assert_eq!(protocol_for("gemini-3.1-flash-image"), Protocol::Gemini);
        assert_eq!(protocol_for("google/gemini-2.5-flash-image-preview"), Protocol::Gemini);
        assert_eq!(protocol_for("imagen-4.0-generate-001"), Protocol::OpenAiImages);
        assert_eq!(protocol_for("gpt-image-2.5"), Protocol::OpenAiImages);
        assert_eq!(protocol_for("doubao-seedream-4-0-250828"), Protocol::OpenAiImages);
    }

    #[test]
    fn endpoint_urls_follow_version_segment() {
        assert_eq!(
            openai_url("https://ent.zetatechs.com/v1", "images/generations"),
            "https://ent.zetatechs.com/v1/images/generations"
        );
        assert_eq!(
            openai_url("https://open.bigmodel.cn/api/paas/v4/", "images/generations"),
            "https://open.bigmodel.cn/api/paas/v4/images/generations"
        );
        assert_eq!(
            openai_url("https://api.x.ai", "images/generations"),
            "https://api.x.ai/v1/images/generations"
        );
        assert_eq!(
            gemini_url("https://ent.zetatechs.com/v1", "gemini-3-pro-image"),
            "https://ent.zetatechs.com/v1beta/models/gemini-3-pro-image:generateContent"
        );
        assert_eq!(
            gemini_url("https://generativelanguage.googleapis.com", "gemini-3-pro-image"),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent"
        );
    }

    #[test]
    fn aspect_ratio_snaps_to_nearest_supported() {
        assert_eq!(aspect_ratio("1024x1024"), Some("1:1"));
        assert_eq!(aspect_ratio("1536x1024"), Some("3:2"));
        assert_eq!(aspect_ratio("1080×1920"), Some("9:16"));
        assert_eq!(aspect_ratio("auto"), None);
    }

    const PNG_1PX: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    #[test]
    fn parses_three_vendor_response_shapes() {
        // OpenAI / gpt-image：b64_json；Grok / 豆包 / 万相：url（2026-10-23 实测形状）
        let v = serde_json::json!({"data": [{"b64_json": PNG_1PX}, {"url": "https://imgen.x.ai/a.jpg", "mime_type": "image/jpeg"}]});
        let p = parse_openai_images(&v);
        assert!(matches!(&p[0], Piece::Bytes(b) if image_ext(b) == Some("png")));
        assert_eq!(p[1], Piece::Url("https://imgen.x.ai/a.jpg".into()));
        // Gemini 原生
        let g = serde_json::json!({"candidates": [{"content": {"parts": [{"text": "here"}, {"inlineData": {"mimeType": "image/png", "data": PNG_1PX}}]}}]});
        assert_eq!(parse_gemini(&g).len(), 1);
        // 对话接口：markdown data URL（New API 转 Gemini）与 OpenRouter images 字段
        let c = serde_json::json!({"choices": [{"message": {"content": format!("好的 ![image](data:image/png;base64,{PNG_1PX}) 完")}}]});
        assert_eq!(parse_chat_images(&c).len(), 1);
        let o = serde_json::json!({"choices": [{"message": {"content": "", "images": [{"image_url": {"url": format!("data:image/png;base64,{PNG_1PX}")}}]}}]});
        assert_eq!(parse_chat_images(&o).len(), 1);
        // 只有文字没有图
        let none = serde_json::json!({"choices": [{"message": {"content": "I can't draw that"}}]});
        assert!(parse_chat_images(&none).is_empty());
    }

    #[test]
    fn non_image_bytes_are_rejected() {
        assert_eq!(image_ext(b"<html>error</html>"), None);
        assert_eq!(image_ext(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
    }

    #[test]
    fn save_images_fixes_extension_and_never_overwrites() {
        let dir = tempfile_dir();
        let png = decode_b64(PNG_1PX).unwrap();
        let imgs = [GenImage { bytes: png.clone(), ext: "png" }];
        let a = save_images(&imgs, &dir.join("figs/cover.jpg")).unwrap();
        assert!(a[0].ends_with("figs/cover.png"));
        let b = save_images(&imgs, &dir.join("figs/cover.png")).unwrap();
        assert!(b[0].ends_with("figs/cover-2.png"));
        let two = [GenImage { bytes: png.clone(), ext: "png" }, GenImage { bytes: png, ext: "png" }];
        let c = save_images(&two, &dir.join("figs/set.png")).unwrap();
        assert!(c[0].ends_with("figs/set-1.png") && c[1].ends_with("figs/set-2.png"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn tempfile_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("mesa-image-gen-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn gw(id: &str, models: &[(&str, &str)]) -> Gateway {
        Gateway {
            id: id.into(),
            name: format!("网关{id}"),
            no_auth: false,
            key_hint: None,
            slots: ProtocolSlots {
                openai: Some(format!("https://{id}.example/v1")),
                ..Default::default()
            },
            header_env: Default::default(),
            models: models
                .iter()
                .map(|(m, status)| GatewayModel {
                    id: (*m).into(),
                    source: "fetched".into(),
                    status: (*status).into(),
                    last_seen_at: None,
                    catalog_slot: None,
                    temperature: None,
                    top_p: None,
                    max_output_tokens: None,
                    reasoning_effort: None,
                })
                .collect(),
            catalog_fetched_at: None,
            catalog_from_slot: None,
            last_probe: Vec::new(),
            slot_probes: Vec::new(),
            revision: String::new(),
            wallet_user_id: None,
            wallet_key_hint: None,
        }
    }

    #[test]
    fn resolve_prefers_default_gateway_then_any_catalog() {
        let gws = vec![
            gw("a", &[("gpt-image-2.5", "available")]),
            gw("b", &[("grok-imagine-image", "available"), ("gpt-image-2.5", "available")]),
            gw("c", &[("qwen-image", "stale")]),
        ];
        // 默认：设置里的网关 + 模型
        let t = resolve_target_in(&gws, Some("b"), Some("gpt-image-2.5"), None).unwrap();
        assert_eq!((t.gateway_id.as_str(), t.model.as_str()), ("b", "gpt-image-2.5"));
        // 指定别家的模型：默认网关没有就去别的网关找
        let t = resolve_target_in(&gws, Some("a"), Some("gpt-image-2.5"), Some("grok-imagine-image")).unwrap();
        assert_eq!(t.gateway_id, "b");
        // 目录里谁都没有（或只剩已下架的）：仍走默认网关，让网关自己回话
        let t = resolve_target_in(&gws, Some("a"), Some("gpt-image-2.5"), Some("qwen-image")).unwrap();
        assert_eq!(t.gateway_id, "a");
        // 没配置
        assert!(resolve_target_in(&gws, None, None, None).err().unwrap().contains("还没配置出图模型"));
        // 默认网关被删了
        assert!(resolve_target_in(&gws, Some("gone"), Some("x-image"), None).err().unwrap().contains("已经不在了"));
        // 没配置但显式指定了目录里有的模型：照样能用
        let t = resolve_target_in(&gws, None, None, Some("grok-imagine-image")).unwrap();
        assert_eq!(t.gateway_id, "b");
    }

    #[test]
    fn candidates_list_only_text_to_image_models() {
        let gws = vec![
            gw("a", &[("gpt-6-astra", "available"), ("gpt-image-2.5", "available"), ("qwen-image-edit", "available"), ("sora-2", "available")]),
            gw("b", &[("deepseek-v4", "available")]),
            gw("c", &[("cogview-4", "stale")]),
        ];
        let c = candidates_from(&gws);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].models, vec!["gpt-image-2.5".to_string()]);
    }

    #[test]
    fn cli_parses_flags_and_rejects_unknown() {
        let args: Vec<String> = ["--prompt", "a cat", "--out", "figures/cat.png", "--model", "gpt-image-2.5", "--n", "2"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let a = parse_cli(&args).unwrap();
        assert_eq!(a.prompt.as_deref(), Some("a cat"));
        assert_eq!(a.n, 2);
        assert!(parse_cli(&["--bogus".to_string()]).is_err());
        assert!(parse_cli(&["--out".to_string()]).is_err());
        let edit: Vec<String> = ["--image", "a.png", "--image", "b.jpg", "--prompt", "x"].iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_cli(&edit).unwrap().images, vec!["a.png".to_string(), "b.jpg".to_string()]);
    }

    #[test]
    fn edit_routes_seedream_through_generations_others_through_edits() {
        assert!(edits_via_generations("doubao-seedream-4-0-250828"));
        assert!(edits_via_generations("doubao-seededit-3-0-i2i-250628"));
        assert!(!edits_via_generations("gpt-image-2.5"));
        assert!(!edits_via_generations("grok-imagine-image"));
    }

    #[test]
    fn input_image_must_be_real_image_and_encodes_as_data_url() {
        let dir = tempfile_dir();
        let png = dir.join("a.png");
        std::fs::write(&png, decode_b64(PNG_1PX).unwrap()).unwrap();
        let img = load_input_image(&png).unwrap();
        assert_eq!(img.ext, "png");
        assert!(img.data_url().starts_with("data:image/png;base64,iVBOR"));
        let fake = dir.join("b.png");
        std::fs::write(&fake, b"<html>not an image</html>").unwrap();
        assert!(load_input_image(&fake).err().unwrap().contains("不是"));
        assert!(load_input_image(&dir.join("missing.png")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn multipart_body_has_fields_files_and_closing_boundary() {
        let img = InputImage { bytes: decode_b64(PNG_1PX).unwrap(), ext: "png" };
        let (ct, body) = multipart_body(&[("model", "gpt-image-2.5".into()), ("prompt", "蓝色帽子".into())], &[("image", &img)]);
        let boundary = ct.strip_prefix("multipart/form-data; boundary=").unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("name=\"model\"\r\n\r\ngpt-image-2.5\r\n"));
        assert!(text.contains("name=\"prompt\"\r\n\r\n蓝色帽子\r\n"));
        assert!(text.contains("name=\"image\"; filename=\"image-1.png\"\r\nContent-Type: image/png\r\n\r\n"));
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));
    }
}
