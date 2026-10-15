//! 应用内「反馈与提需求」的后端通道。
//!
//! 主通道 = 公司收集端点（POST JSON，后台直发，不打开邮件应用）；端点地址收敛在
//! `FEEDBACK_ENDPOINT` 一个常量——未配置（None）时前端回落 mailto 通道（零基建，
//! 表单照填、调系统邮件应用预填寄出）。公司端点上线后改这一行即完成切换，
//! 表单与正文结构两端共用（src/feedback.ts）。
//!
//! 隐私口径：只在用户点「发送」时出网，只寄表单里的字段 + 环境行（版本/平台/
//! 架构/渠道），无任何自动采集；不注出网代理，不走更新检查之外的任何后台请求。

use serde::{Deserialize, Serialize};
use std::str::FromStr;

/// 公司反馈收集端点。未配置 = None → 前端走 mailto 回落。
/// 服务端需自理限流与滥用防护（地址随开源仓库公开）。
const FEEDBACK_ENDPOINT: Option<&str> = None;

/// 提交超时：反馈不是关键路径，网络差就失败提示，不重试不阻塞
const SUBMIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// 反馈直达邮箱（与前端 src/feedback.ts FEEDBACK_EMAIL 双端镜像）
const FEEDBACK_EMAIL: &str = "hong.tongzhou@zetatechs.com";

/// 环境信息（前端 build_info + getVersion 组装后随提交带上）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackEnvDto {
    pub version: Option<String>,
    pub os: Option<String>,
    pub arch: Option<String>,
    pub channel: Option<String>,
}

/// 附件截图（端点通道随 JSON 直传；邮件通道由 save_feedback_images 落盘后
/// 让用户在邮件应用里手动添加——mailto 协议带不了附件）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackImageDto {
    pub name: String,
    pub mime: String,
    /// 图片内容（Base64，不含 data: 前缀）；前端限制 ≤3 张、单张 ≤2MB
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackPayloadDto {
    /// 固定 "mesa"——端点多产品共用时的分流字段
    pub app: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub contact: Option<String>,
    pub env: FeedbackEnvDto,
    /// 最近错误日志摘录（feedback_error_log 生成；与「附环境」勾选同进退）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_log: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<FeedbackImageDto>>,
}

/// 反馈附带的最近错误日志摘录：最近 error 级 ≤5 条、每条按字符截 200，
/// 时间正序纯文本。logbuf 落环前已过 redact_sensitive_text，出站安全；
/// 无错误日志返回 None（前端不落「最近错误日志」段）。
#[tauri::command]
pub fn feedback_error_log() -> Option<String> {
    format_error_log(crate::logbuf::get_app_log(300))
}

/// 纯函数体（tests 钉住过滤/截断/≤5 条语义）
pub(crate) fn format_error_log(logs: Vec<crate::logbuf::LogEntryDto>) -> Option<String> {
    let mut errs: Vec<String> = logs
        .into_iter()
        .filter(|l| l.level.eq_ignore_ascii_case("error"))
        .map(|l| {
            let msg: String = l.message.chars().take(200).collect();
            let msg = if l.message.chars().count() > 200 {
                format!("{msg}…")
            } else {
                msg
            };
            format!("{} [{}] {}", l.ts, l.source, msg)
        })
        .collect();
    if errs.is_empty() {
        return None;
    }
    let tail: Vec<String> = if errs.len() > 5 {
        errs.split_off(errs.len() - 5)
    } else {
        errs
    };
    Some(tail.join("\n"))
}

/// 当前生效的提交通道：Some(url) = 端点直发；None = mailto 回落（前端拼 mailto）
#[tauri::command]
pub fn feedback_endpoint() -> Option<String> {
    FEEDBACK_ENDPOINT.map(str::to_string)
}

/// 邮箱直发配置（settings.json 的 feedbackSmtp；授权码另存 keys.json）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSmtpConfigDto {
    /// 展示名（"QQ 邮箱" / "163 邮箱" / "自定义"…），仅用于界面与错误文案
    pub provider: String,
    pub host: String,
    pub port: u16,
    /// "tls"（465 隐式 TLS）| "starttls"（587）
    pub tls: String,
    /// 发件邮箱（同时是 SMTP 登录用户名）
    pub from: String,
}

/// 授权码在 keys.json 里的键（0600、与 API 密钥同一存储纪律，绝不回显）
const FEEDBACK_SMTP_KEY_ID: &str = "feedback-smtp";

/// 校验直发配置（update_settings 入口与 send 双处共享的闸门，tests 覆盖）：
/// host 非空、端口非 0、tls 闭集、from 能按 Mailbox 解析（比含 @ 严——
/// 「a b@c」「a@b@c」这类保存时不该放行，否则发送时才报解析失败）
pub(crate) fn validate_smtp_config(c: &FeedbackSmtpConfigDto) -> Result<(), String> {
    if c.host.trim().is_empty() {
        return Err("SMTP 服务器不能为空".into());
    }
    if c.port == 0 {
        return Err("SMTP 端口非法".into());
    }
    if c.tls != "tls" && c.tls != "starttls" {
        return Err("TLS 模式只支持 tls / starttls".into());
    }
    if lettre::message::Mailbox::from_str(c.from.trim()).is_err() {
        return Err("发件邮箱格式不对（需形如 a@b.c）".into());
    }
    Ok(())
}

/// 附件 / 落盘共用的补扩展：名字不以图片扩展结尾时按 mime 补——名字中段
/// 含点（「微信截图_2026.10.1」）不代表有扩展名，双击打不开就白截了
fn image_name_with_ext(clean: &str, mime: &str) -> String {
    let lower = clean.to_ascii_lowercase();
    let has_img_ext = [".png", ".jpg", ".jpeg", ".gif", ".webp"]
        .iter()
        .any(|e| lower.ends_with(e));
    if has_img_ext {
        return clean.to_string();
    }
    match mime {
        "image/png" => format!("{clean}.png"),
        "image/jpeg" => format!("{clean}.jpg"),
        "image/gif" => format!("{clean}.gif"),
        "image/webp" => format!("{clean}.webp"),
        _ => format!("{clean}.png"),
    }
}

/// 保存邮箱直发授权码（0600 keys.json；配置本身走 settings 的 update_settings）
#[tauri::command]
pub fn set_feedback_smtp_secret(secret: String) -> Result<(), String> {
    let s = secret.trim();
    if s.is_empty() {
        return Err("授权码不能为空".into());
    }
    crate::profiles::set_shared_key(FEEDBACK_SMTP_KEY_ID, s)
}

/// 清除授权码（与设置里的清空配置配对使用）
#[tauri::command]
pub fn clear_feedback_smtp_secret() -> Result<(), String> {
    crate::profiles::clear_shared_key(FEEDBACK_SMTP_KEY_ID)
}

/// 邮箱直发：用用户配置的 SMTP 账号把反馈寄给维护者，截图作为真实附件。
/// 通道序（前端决策）：端点 > 邮箱直发 > mailto——本命令只在配置了 feedbackSmtp 时可用了。
#[tauri::command]
pub async fn send_feedback_smtp(
    subject: String,
    body: String,
    images: Option<Vec<FeedbackImageDto>>,
) -> Result<(), String> {
    let config = crate::settings::current_with_defaults()
        .feedback_smtp
        .ok_or("未配置邮箱直发（反馈表单的「配置邮箱直发」里配置）")?;
    validate_smtp_config(&config)?;
    let secret = crate::profiles::get_shared_key(FEEDBACK_SMTP_KEY_ID)?
        .ok_or("授权码缺失，请重新保存邮箱配置")?;
    tauri::async_runtime::spawn_blocking(move || {
        send_smtp_blocking(&config, &secret, &subject, &body, images.as_deref().unwrap_or(&[]))
    })
    .await
    .map_err(|e| format!("邮件发送任务失败: {e}"))?
}

/// SMTP 发送（阻塞体）。25s 超时覆盖建连+TLS+传输；错误带 provider 便于用户对号。
/// 传输端构建（send 与 test_connection 共用）：按 tls 选 relay(465 隐式) /
/// starttls_relay(587)，端口用配置覆盖，凭据 = 发件邮箱 + 授权码，25s 超时。
/// SMTP 认证被拒（535）时的中文分诊：QQ/163 的报错是一份英文清单，用户
/// 无从下手；把真实病因与动作翻出来附在原文后。
fn smtp_error_hint(raw: String) -> String {
    if raw.contains("535") || raw.contains("Login fail") {
        format!(
            "{raw}\n排查：①网页版邮箱设置里确认「POP3/SMTP 服务」已开启（与 IMAP 是两个开关、各有独立授权码）②授权码只在生成时显示一次——重新生成并当场复制 ③短时间多次尝试会被临时锁定，等 30 分钟再试 ④英文别名账号改用数字账号（数字QQ号@qq.com）作发件邮箱再试 ⑤账号风控按帮助页解锁"
        )
    } else {
        raw
    }
}

fn smtp_transport(
    config: &FeedbackSmtpConfigDto,
    secret: &str,
) -> Result<lettre::SmtpTransport, String> {
    use lettre::transport::smtp::authentication::Credentials;
    let ctx = |e: String| format!("{}（{}）：{e}", config.provider, config.host);
    let base = if config.tls == "starttls" {
        lettre::SmtpTransport::starttls_relay(&config.host)
    } else {
        lettre::SmtpTransport::relay(&config.host)
    }
    .map_err(|e| ctx(format!("无法建立 {} 连接: {e}", config.tls)))?;
    Ok(base
        .port(config.port)
        .credentials(Credentials::new(config.from.clone(), secret.to_string()))
        .timeout(Some(std::time::Duration::from_secs(25)))
        .build())
}

/// 测试连接：用已存配置 + 授权码做真实「连接 + TLS + 认证」（NOOP 后退出，
/// 不发信）。通过 = 发送必过；失败文案带 provider/host 与 lettre 原始错误，
/// 535 = 授权码错误（QQ/163 需在网页版开启 SMTP 并用生成的授权码，非登录密码）。
#[tauri::command]
pub async fn test_feedback_smtp() -> Result<(), String> {
    let config = crate::settings::current_with_defaults()
        .feedback_smtp
        .ok_or("未配置邮箱直发")?;
    validate_smtp_config(&config)?;
    let secret = crate::profiles::get_shared_key(FEEDBACK_SMTP_KEY_ID)?
        .ok_or("授权码缺失，请重新保存邮箱配置")?;
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = |e: String| format!("{}（{}）：{e}", config.provider, config.host);
        let mailer = smtp_transport(&config, &secret)?;
        mailer
            .test_connection()
            .map_err(|e| smtp_error_hint(ctx(format!("连接/授权验证失败 {e}"))))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("测试任务失败: {e}"))?
}

fn send_smtp_blocking(
    config: &FeedbackSmtpConfigDto,
    secret: &str,
    subject: &str,
    body: &str,
    images: &[FeedbackImageDto],
) -> Result<(), String> {
    use base64::Engine;
    use lettre::message::header::ContentType;
    use lettre::message::{Attachment, MultiPart, SinglePart};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{Message, SmtpTransport, Transport};

    let ctx = |e: String| format!("{}（{}）：{e}", config.provider, config.host);
    let mut builder = Message::builder()
        .from(
            config
                .from
                .parse()
                .map_err(|e| ctx(format!("发件地址解析失败 {e}")))?,
        )
        .to(FEEDBACK_EMAIL.parse().map_err(|e| ctx(format!("收件地址解析失败 {e}")))?)
        .subject(subject);
    // 让回信能到用户（维护者回复直达，而不是石沉大海）
    if let Ok(reply_to) = config.from.parse() {
        builder = builder.reply_to(reply_to);
    }

    // 正文 + 附件（MultiPart/mixed；截图按存档名与 mime 还原为真实附件）
    let mut mixed = MultiPart::mixed().singlepart(
        SinglePart::builder()
            .header(ContentType::TEXT_PLAIN)
            .body(body.to_string()),
    );
    for (i, img) in images.iter().enumerate() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(img.data.as_bytes())
            .map_err(|e| format!("截图 {i} 解码失败: {e}"))?;
        let clean = crate::paths::sanitize_fs_name(&img.name)
            .unwrap_or_else(|_| format!("screenshot-{i}.png"));
        let ct = img
            .mime
            .parse()
            .or_else(|_| ContentType::parse("image/png"))
            .map_err(|e| format!("截图 {i} 类型解析失败: {e}"))?;
        mixed = mixed.singlepart(Attachment::new(image_name_with_ext(&clean, &img.mime)).body(bytes, ct));
    }
    let email = builder
        .multipart(mixed)
        .map_err(|e| ctx(format!("邮件组装失败 {e}")))?;

    let mailer = smtp_transport(config, secret)?;
    mailer
        .send(&email)
        .map_err(|e| smtp_error_hint(ctx(format!("发送失败 {e}"))))?;
    Ok(())
}

/// 应用内提交：POST 到公司端点。只在用户点「发送」时被调用。
#[tauri::command]
pub async fn submit_feedback(
    kind: String,
    title: String,
    detail: String,
    contact: Option<String>,
    env: FeedbackEnvDto,
    error_log: Option<String>,
    images: Option<Vec<FeedbackImageDto>>,
) -> Result<(), String> {
    let endpoint = FEEDBACK_ENDPOINT.ok_or_else(|| "未配置反馈端点（本版本走邮件通道）".to_string())?;
    let payload = FeedbackPayloadDto {
        app: "mesa".into(),
        kind,
        title,
        detail,
        contact,
        env,
        error_log,
        images,
    };
    let client = reqwest::Client::builder()
        .timeout(SUBMIT_TIMEOUT)
        .user_agent("Mesa feedback (https://github.com/hongtongzhou-design/ccode)")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let resp = client
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("发送失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("发送失败：服务端返回 {}", resp.status()));
    }
    Ok(())
}

/// 邮件通道的附件辅助：mailto 带不了附件，截图先落盘到
/// 下载目录/ccode-exports/mesa-feedback-<时间>/，返回目录路径——
/// 前端在正文里注明该目录，并给「打开文件夹」让用户在邮件应用里手动添加。
#[tauri::command]
pub async fn save_feedback_images(images: Vec<FeedbackImageDto>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let dir = dirs::download_dir()
            .ok_or("无法确定下载目录")?
            .join("ccode-exports")
            .join(format!("mesa-feedback-{stamp}"));
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
        for (i, img) in images.iter().enumerate() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(img.data.as_bytes())
                .map_err(|e| format!("图片 {i} 解码失败: {e}"))?;
            // 名字清洗 + 扩展名按 mime 补（共用 image_name_with_ext）
            let clean = crate::paths::sanitize_fs_name(&img.name)
                .map_err(|e| format!("图片 {i} 文件名非法: {e}"))?;
            let path = dir.join(format!("{:02}-{}", i + 1, image_name_with_ext(&clean, &img.mime)));
            std::fs::write(&path, &bytes).map_err(|e| format!("写图片失败: {e}"))?;
        }
        Ok(dir.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("保存截图任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(from: &str, tls: &str, port: u16) -> FeedbackSmtpConfigDto {
        FeedbackSmtpConfigDto {
            provider: "QQ 邮箱".into(),
            host: "smtp.qq.com".into(),
            port,
            tls: tls.into(),
            from: from.into(),
        }
    }

    #[test]
    fn smtp_config_validation_gate() {
        assert!(validate_smtp_config(&cfg("a@b.c", "tls", 465)).is_ok());
        assert!(validate_smtp_config(&cfg("名 <a@b.c>", "starttls", 587)).is_ok());
        // from：含 @ 但解析不了的形态要在保存时就拦（否则发送时才炸）
        assert!(validate_smtp_config(&cfg("a b@c", "tls", 465)).is_err());
        assert!(validate_smtp_config(&cfg("a@b@c", "tls", 465)).is_err());
        assert!(validate_smtp_config(&cfg("noat", "tls", 465)).is_err());
        // host / 端口 / tls 闭集
        assert!(
            validate_smtp_config(&FeedbackSmtpConfigDto {
                host: "  ".into(),
                ..cfg("a@b.c", "tls", 465)
            })
            .is_err()
        );
        assert!(validate_smtp_config(&cfg("a@b.c", "tls", 0)).is_err());
        assert!(validate_smtp_config(&cfg("a@b.c", "ssl", 465)).is_err());
    }

    #[test]
    fn error_log_snippet_filters_truncates_and_caps() {
        use crate::logbuf::LogEntryDto;
        let mk = |ts: &str, level: &str, msg: &str| LogEntryDto {
            ts: ts.into(),
            level: level.into(),
            source: "runs".into(),
            message: msg.into(),
        };
        // 只有非 error 级 → None
        assert!(format_error_log(vec![mk("t1", "warn", "w")]).is_none());
        // error 过滤 + 时间正序保留；warn/info 不进
        let logs = vec![
            mk("t1", "info", "i"),
            mk("t2", "error", "启动失败A"),
            mk("t3", "warn", "w"),
            mk("t4", "error", "启动失败B"),
        ];
        let out = format_error_log(logs).unwrap();
        assert_eq!(out, "t2 [runs] 启动失败A\nt4 [runs] 启动失败B");
        // >5 条只留最近 5 条；每条按字符截 200（中文按字符不按字节）
        let many: Vec<_> = (0..7)
            .map(|i| mk(&format!("t{i}"), "error", &"错".repeat(300)))
            .collect();
        let out2 = format_error_log(many).unwrap();
        let lines: Vec<&str> = out2.split('\n').collect();
        assert_eq!(lines.len(), 5);
        assert!(lines[0].starts_with("t2 "));
        assert!(!lines[0].starts_with("t1 "), "最旧的 t0/t1 被挤出");
        assert!(lines[0].contains('…'), "超 200 字符截断");
        assert_eq!(lines[0].chars().filter(|c| *c == '错').count(), 200);
    }

    #[test]
    fn image_name_ext_supplements_only_when_missing() {
        assert_eq!(image_name_with_ext("shot.png", "image/png"), "shot.png");
        assert_eq!(image_name_with_ext("shot.jpg", "image/png"), "shot.jpg");
        // 名字中段含点不算扩展名（「微信截图_2026.10.1」补 .png）
        assert_eq!(
            image_name_with_ext("微信截图_2026.10.1", "image/png"),
            "微信截图_2026.10.1.png"
        );
        assert_eq!(image_name_with_ext("shot", "image/jpeg"), "shot.jpg");
        assert_eq!(image_name_with_ext("shot", "weird/type"), "shot.png");
    }
}

#[cfg(test)]
mod real_probe {
    use super::*;

    /// 真实探测（需人工触发，不进常规基线）：读用户已保存的配置与授权码，
    /// 走 send 同一条 smtp_transport 做 test_connection，把 lettre 原始错误打全。
    /// 用法：cargo test real_smtp_probe -- --ignored --nocapture
    #[test]
    #[ignore = "触碰用户真实配置与外网，仅排障时手动跑"]
    fn real_smtp_probe() {
        let config = crate::settings::current_with_defaults()
            .feedback_smtp
            .expect("未配置 feedbackSmtp");
        let secret = crate::profiles::get_shared_key(FEEDBACK_SMTP_KEY_ID)
            .ok()
            .flatten()
            .expect("keys.json 无 feedback-smtp 授权码");
        println!("配置: {} {}:{} tls={} from={}", config.provider, config.host, config.port, config.tls, config.from);
        println!("授权码长度: {} 首字符: {:?}", secret.chars().count(), secret.chars().next().map(|c| c.is_ascii_alphanumeric()));
        match smtp_transport(&config, &secret) {
            Err(e) => println!("transport 构建失败: {e}"),
            Ok(mailer) => match mailer.test_connection() {
                Ok(_) => println!("连接+TLS+认证 全部通过"),
                Err(e) => println!("失败原始错误: {e}"),
            },
        }
    }
}
