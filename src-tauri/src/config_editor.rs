//! 连接页「编辑配置文件」：读出各家 CLI 的全局配置（密钥换成可还原的占位），校验后经 global_config 写回。
//! 写盘只走 `global_config::write_user_edit`（与设为全局同一把锁、同一套批次备份）。设计见 docs/design-config-file-editor.md

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// 文件格式：决定着色、校验与密钥识别
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Json,
    /// 允许注释的 JSON（OpenCode .jsonc、Gemini / Qwen 的 settings.json）
    Jsonc,
    Toml,
    Dotenv,
}

fn format_for(agent: &str, tag: &str) -> Format {
    match tag {
        ".env" => Format::Dotenv,
        t if t.ends_with(".toml") => Format::Toml,
        t if crate::global_config::config_file_is_jsonc(agent, t) => Format::Jsonc,
        _ => Format::Json,
    }
}

/// Monaco 语言 id（没有内置 TOML，ini 的着色够用）
fn language_of(format: Format) -> &'static str {
    match format {
        Format::Json | Format::Jsonc => "json",
        Format::Toml | Format::Dotenv => "ini",
    }
}

const PLACEHOLDER_HEAD: &str = "«已隐藏密钥 ···";

/// 键名像密钥：含 key / token / secret / password / bearer / credential（不分大小写）
fn secret_key_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["key", "token", "secret", "password", "passwd", "bearer", "credential"]
        .iter()
        .any(|w| lower.contains(w))
}

/// 值像密钥：够长、不含空白，且不是数字、环境变量名、变量引用或路径（env_key = "OPENAI_API_KEY" 这类不藏）
fn secret_value(value: &str) -> bool {
    let v = value.trim();
    v.chars().count() >= 8
        && !v.chars().any(char::is_whitespace)
        && !v.chars().all(|c| c.is_ascii_digit())
        && !v.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !v.starts_with('$')
        && !v.starts_with("{env:")
        && !v.starts_with("{file:")
        && !v.starts_with('/')
        && !v.starts_with('~')
        && !v.contains(":\\")
        && !v.starts_with(PLACEHOLDER_HEAD)
}

/// 常见密钥前缀（结构认不出时兜底，比如文件当前解析不了）
fn known_prefix_secret(token: &str) -> bool {
    token.chars().count() >= 20
        && ["sk-", "sk_", "AIza", "xai-", "ghp_", "github_pat_", "glpat-", "gsk_", "AKIA"]
            .iter()
            .any(|p| token.starts_with(p))
}

fn collect_json(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                match v {
                    serde_json::Value::String(s) if secret_key_name(k) && secret_value(s) => out.push(s.clone()),
                    _ => collect_json(v, out),
                }
            }
        }
        serde_json::Value::Array(items) => items.iter().for_each(|v| collect_json(v, out)),
        _ => {}
    }
}

fn collect_toml(value: &toml::Value, out: &mut Vec<String>) {
    match value {
        toml::Value::Table(map) => {
            for (k, v) in map {
                match v {
                    toml::Value::String(s) if secret_key_name(k) && secret_value(s) => out.push(s.clone()),
                    _ => collect_toml(v, out),
                }
            }
        }
        toml::Value::Array(items) => items.iter().for_each(|v| collect_toml(v, out)),
        _ => {}
    }
}

/// 文件里的密钥值：结构上键名像密钥的、等于 Mesa 已存密钥的、带常见密钥前缀的
fn secrets_in(format: Format, text: &str, stored: &[String]) -> Vec<String> {
    let text = crate::mcp::strip_bom(text);
    let mut out = Vec::new();
    match format {
        Format::Json | Format::Jsonc => {
            let body = if format == Format::Jsonc { crate::mcp::strip_jsonc(text) } else { text.to_string() };
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                collect_json(&v, &mut out);
            }
        }
        Format::Toml => {
            if let Ok(v) = toml::from_str::<toml::Value>(text) {
                collect_toml(&v, &mut out);
            }
        }
        Format::Dotenv => {
            for line in text.lines() {
                let line = line.trim().trim_start_matches("export ").trim();
                if let Some((k, v)) = line.split_once('=') {
                    let v = v.trim().trim_matches('"').trim_matches('\'');
                    if secret_key_name(k.trim()) && secret_value(v) {
                        out.push(v.to_string());
                    }
                }
            }
        }
    }
    for s in stored {
        if s.chars().count() >= 8 && text.contains(s.as_str()) {
            out.push(s.clone());
        }
    }
    for token in text.split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))) {
        if known_prefix_secret(token) {
            out.push(token.to_string());
        }
    }
    out.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    out.dedup();
    out
}

fn hash8(secret: &str) -> String {
    let digest = Sha256::digest(secret.as_bytes());
    digest[..4].iter().map(|b| format!("{b:02x}")).collect()
}

fn placeholder(secret: &str) -> String {
    let tail: String = {
        let chars: Vec<char> = secret.chars().collect();
        chars[chars.len().saturating_sub(4)..].iter().collect()
    };
    format!("{PLACEHOLDER_HEAD}{tail} #{}»", hash8(secret))
}

/// 把密钥换成占位（长的先换，免得短的是长的一截）
fn hide(text: &str, secrets: &[String]) -> (String, usize) {
    let mut out = text.to_string();
    let mut hidden = 0;
    for s in secrets {
        if out.contains(s.as_str()) {
            out = out.replace(s.as_str(), &placeholder(s));
            hidden += 1;
        }
    }
    (out, hidden)
}

/// 占位换回原值；认不出的占位（被改了半截、从别的文件粘来）拒绝
fn restore(text: &str, secrets: &[String]) -> Result<String, String> {
    let by_hash: HashMap<String, &String> = secrets.iter().map(|s| (hash8(s), s)).collect();
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(PLACEHOLDER_HEAD) {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let Some(end) = tail.find('»') else {
            return Err("有一处「已隐藏密钥」占位不完整：保持原样，或整个换成新的密钥".into());
        };
        let ph = &tail[..end + '»'.len_utf8()];
        let hash = ph.rsplit('#').next().unwrap_or("").trim_end_matches('»').trim();
        match by_hash.get(hash) {
            Some(secret) => out.push_str(secret),
            None => {
                return Err(format!(
                    "认不出占位 {ph}：它不是这个文件里原有的密钥。保持原样，或整个换成新的密钥"
                ))
            }
        }
        rest = &tail[end + '»'.len_utf8()..];
    }
    out.push_str(rest);
    Ok(out)
}

/// 保存前的格式校验：不过就不写，报出位置
fn validate(format: Format, text: &str) -> Result<(), String> {
    let text = crate::mcp::strip_bom(text);
    match format {
        Format::Json | Format::Jsonc => {
            if text.trim().is_empty() {
                return Err("内容是空的：要清空请写 {}".into());
            }
            let body = if format == Format::Jsonc { crate::mcp::strip_jsonc(text) } else { text.to_string() };
            if body.trim().is_empty() {
                return Err("只有注释没有 JSON 对象：请至少保留 {}".into());
            }
            let v: serde_json::Value = serde_json::from_str(&body)
                .map_err(|e| format!("不是合法的 JSON（第 {} 行第 {} 列）：{e}", e.line(), e.column()))?;
            if !v.is_object() {
                return Err("JSON 最外层必须是对象 { … }".into());
            }
        }
        Format::Toml => {
            text.parse::<toml_edit::DocumentMut>()
                .map_err(|e| format!("不是合法的 TOML：{}", e.to_string().trim()))?;
        }
        Format::Dotenv => {
            for (i, raw) in text.lines().enumerate() {
                let line = raw.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let line = line.strip_prefix("export ").unwrap_or(line);
                let key = line.split_once('=').map(|(k, _)| k.trim()).unwrap_or("");
                let ok = !key.is_empty()
                    && key.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                    && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
                if !ok {
                    return Err(format!("第 {} 行不是 KEY=VALUE 形式", i + 1));
                }
            }
        }
    }
    Ok(())
}

/// 磁盘原文的版本号（文件不存在 = "absent"）：保存时核对，期间被别人改过就不写
fn revision_of(bytes: Option<&[u8]>) -> String {
    match bytes {
        None => "absent".into(),
        Some(b) => Sha256::digest(b)[..8].iter().map(|x| format!("{x:02x}")).collect(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileDto {
    pub tag: String,
    /// 显示用路径（家目录下写成 ~/…）
    pub path: String,
    pub exists: bool,
    pub language: &'static str,
    /// 密钥已换成占位的内容
    pub content: String,
    pub revision: String,
    pub hidden_secrets: usize,
    /// 读不出（权限、编码）时的原因；有它就只读显示
    pub error: Option<String>,
}

fn read_files(home: &std::path::Path, agent: &str, stored: &[String]) -> Vec<ConfigFileDto> {
    crate::global_config::editable_config_files(home, agent)
        .into_iter()
        .map(|(tag, path)| {
            let format = format_for(agent, tag);
            let display = crate::global_config::display_path(home, &path);
            let base = ConfigFileDto {
                tag: tag.to_string(),
                path: display,
                exists: false,
                language: language_of(format),
                content: String::new(),
                revision: revision_of(None),
                hidden_secrets: 0,
                error: None,
            };
            match std::fs::read(&path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => base,
                Err(e) => ConfigFileDto { error: Some(format!("读取失败：{e}")), ..base },
                Ok(bytes) => match String::from_utf8(bytes.clone()) {
                    Err(_) => ConfigFileDto {
                        exists: true,
                        revision: revision_of(Some(&bytes)),
                        error: Some("文件不是 UTF-8 文本，不能在这里编辑".into()),
                        ..base
                    },
                    Ok(text) => {
                        let (content, hidden) = hide(&text, &secrets_in(format, &text, stored));
                        ConfigFileDto {
                            exists: true,
                            content,
                            revision: revision_of(Some(&bytes)),
                            hidden_secrets: hidden,
                            ..base
                        }
                    }
                },
            }
        })
        .collect()
}

/// 保存：还原占位 → 校验 → 内容没变不写 → 持锁核版本后经 global_config 事务写入。返回 Some(显示路径)，没变返回 None
fn save_file(
    home: &std::path::Path,
    agent: &str,
    tag: &str,
    content: &str,
    revision: &str,
    stored: &[String],
) -> Result<Option<String>, String> {
    let (tag, path) = crate::global_config::editable_config_files(home, agent)
        .into_iter()
        .find(|(t, _)| *t == tag)
        .ok_or("这个文件不在可编辑的清单里")?;
    let format = format_for(agent, tag);
    let disk = match std::fs::read(&path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("读取失败：{e}")),
    };
    let stale = || "文件在你打开之后被改过（CLI 自己、别的工具或设为全局都可能改它）：关掉重新打开再改".to_string();
    if revision_of(disk.as_deref()) != revision {
        return Err(stale());
    }
    let disk_text = disk.as_deref().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
    let restored = restore(content, &secrets_in(format, &disk_text, stored))?;
    validate(format, &restored)?;
    if disk.is_some() && restored == disk_text {
        return Ok(None);
    }
    let expected = revision.to_string();
    crate::global_config::write_user_edit(home, agent, tag, &path, &restored, |now| {
        if revision_of(now) == expected {
            Ok(())
        } else {
            Err(stale())
        }
    })?;
    Ok(Some(crate::global_config::display_path(home, &path)))
}

#[tauri::command]
pub async fn config_files_read(agent: String) -> Result<Vec<ConfigFileDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
        Ok(read_files(&home, &agent, &crate::profiles::stored_secrets()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn config_file_save(
    app: tauri::AppHandle,
    agent: String,
    tag: String,
    content: String,
    revision: String,
) -> Result<Option<String>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let home = crate::dirs::home_dir().ok_or("无法确定用户主目录")?;
        save_file(&home, &agent, &tag, &content, &revision, &crate::profiles::stored_secrets())
    })
    .await
    .map_err(|e| e.to_string())?;
    if matches!(result, Ok(Some(_))) {
        // 托盘的「全局」勾选与漂移标记按新内容重算
        let _ = crate::tray::rebuild_and_wait(app).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_secret_fields_but_not_names_or_refs() {
        let text = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"abcd1234efgh5678","CLAUDE_CODE_MAX_OUTPUT_TOKENS":"64000","ANTHROPIC_BASE_URL":"https://x/v1"},
            "envKey":"OPENAI_API_KEY","apiKeyHelper":"/usr/local/bin/h","other":"${MY_KEY}"}"#;
        let secrets = secrets_in(Format::Json, text, &[]);
        assert_eq!(secrets, ["abcd1234efgh5678"]);
        let (shown, n) = hide(text, &secrets);
        assert_eq!(n, 1);
        assert!(!shown.contains("abcd1234efgh5678"));
        assert!(shown.contains("«已隐藏密钥 ···5678 #"));
        assert!(shown.contains("OPENAI_API_KEY") && shown.contains("64000"));
        assert_eq!(restore(&shown, &secrets).unwrap(), text, "原样往返");
    }

    #[test]
    fn toml_dotenv_stored_and_prefix_secrets_are_hidden() {
        let toml = "[model.m]\napi_key = \"zz-secret-value-1\"\nenv_key = \"XAI_API_KEY\"\n[x]\nnote = \"sk-abcdefghijklmnopqrstu\"\n";
        let s = secrets_in(Format::Toml, toml, &[]);
        assert!(s.contains(&"zz-secret-value-1".to_string()));
        assert!(s.contains(&"sk-abcdefghijklmnopqrstu".to_string()), "常见前缀兜底");
        let env = "GEMINI_API_KEY=\"AIzaSyD-1234567890abcdef\"\nGEMINI_MODEL=gemini-3\n";
        assert_eq!(secrets_in(Format::Dotenv, env, &[]), ["AIzaSyD-1234567890abcdef"]);
        let plain = "custom = \"mesa-stored-key-xyz\"\n";
        assert_eq!(secrets_in(Format::Toml, plain, &["mesa-stored-key-xyz".into()]), ["mesa-stored-key-xyz"]);
    }

    #[test]
    fn restore_rejects_unknown_or_broken_placeholder_and_accepts_new_key() {
        let secrets = vec!["abcd1234efgh5678".to_string()];
        assert!(restore("x = \"«已隐藏密钥 ···9999 #deadbeef»\"", &secrets).is_err());
        assert!(restore("x = \"«已隐藏密钥 ···5678", &secrets).is_err());
        assert_eq!(restore("x = \"sk-new-key\"", &secrets).unwrap(), "x = \"sk-new-key\"", "换成新密钥照写");
    }

    #[test]
    fn validate_by_format() {
        assert_eq!(format_for("opencode", "opencode.json"), Format::Jsonc);
        assert_eq!(format_for("opencode", "opencode.jsonc"), Format::Jsonc);
        assert_eq!(format_for("opencode", "config.json"), Format::Jsonc);
        assert_eq!(format_for("gemini", "settings.json"), Format::Jsonc);
        assert_eq!(format_for("qwen", "settings.json"), Format::Jsonc);
        assert_eq!(format_for("claude-code", "settings.json"), Format::Json);
        assert_eq!(format_for("codebuddy", "settings.json"), Format::Json);
        assert!(validate(Format::Json, "{\"a\":1}").is_ok());
        assert!(validate(Format::Json, "[1]").is_err());
        assert!(validate(Format::Json, "").is_err());
        assert!(validate(Format::Json, "{ // c\n}").is_err());
        assert!(validate(Format::Jsonc, "{ // c\n \"a\": 1 }").is_ok());
        assert!(validate(Format::Jsonc, "// only comment\n").is_err());
        assert!(validate(Format::Toml, "a = 1\n[b]\nc = \"d\"").is_ok());
        assert!(validate(Format::Toml, "a = ").is_err());
        assert!(validate(Format::Dotenv, "# c\nA=1\nexport B_2=x\n\n").is_ok());
        assert!(validate(Format::Dotenv, "not a pair").is_err());
    }

    #[test]
    fn save_round_trip_checks_revision_and_backs_up() {
        let home = std::env::temp_dir().join(format!("mesa-cfg-edit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(home.join(".grok")).unwrap();
        let path = home.join(".grok/config.toml");
        std::fs::write(&path, "[model.m]\napi_key = \"zz-secret-value-1\"\n").unwrap();
        let files = read_files(&home, "grok", &[]);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.hidden_secrets, 1);
        assert!(!f.content.contains("zz-secret"));
        // 没改：不写
        assert_eq!(save_file(&home, "grok", "config.toml", &f.content, &f.revision, &[]).unwrap(), None);
        // 版本对不上：拒绝
        assert!(save_file(&home, "grok", "config.toml", &f.content, "0000", &[]).is_err());
        // 格式错：拒绝，磁盘不动
        assert!(save_file(&home, "grok", "config.toml", "a = ", &f.revision, &[]).is_err());
        std::fs::remove_dir_all(&home).ok();
    }

    /// 真写一遍（含批次备份）：HOME 换成临时目录再跑，备份落在临时目录下的配置目录里，不碰本机
    /// `env HOME=$(mktemp -d) CARGO_HOME=~/.cargo RUSTUP_HOME=~/.rustup cargo test --lib config_edit_real_write -- --ignored`
    #[test]
    #[ignore]
    fn config_edit_real_write() {
        let home = crate::dirs::home_dir().unwrap();
        assert!(home.to_string_lossy().contains("tmp") || home.to_string_lossy().contains("/T/"), "只在临时 HOME 下跑");
        std::fs::create_dir_all(home.join(".grok")).unwrap();
        let path = home.join(".grok/config.toml");
        std::fs::write(&path, "[model.m]\napi_key = \"zz-secret-value-1\"\n").unwrap();
        let f = read_files(&home, "grok", &[]).remove(0);
        let edited = format!("{}\n[cli]\nauto_update = false\n", f.content);
        let saved = save_file(&home, "grok", "config.toml", &edited, &f.revision, &[]).unwrap();
        assert_eq!(saved.as_deref(), Some("~/.grok/config.toml"));
        let now = std::fs::read_to_string(&path).unwrap();
        assert!(now.contains("api_key = \"zz-secret-value-1\""), "密钥原样写回");
        assert!(now.contains("auto_update = false"));
        let backups = crate::dirs::config_dir().unwrap().join("ccode/backups/grok");
        let n = std::fs::read_dir(&backups).unwrap().count();
        assert!(n >= 2, "批次备份与原始快照都在：{n}");
        // 旧版本号再存：拒绝
        assert!(save_file(&home, "grok", "config.toml", &edited, &f.revision, &[]).is_err());
        println!("OK backups={n}");
    }

    #[test]
    fn codex_auth_json_is_not_editable() {
        let home = std::env::temp_dir().join(format!("mesa-cfg-list-{}", uuid::Uuid::new_v4()));
        let tags: Vec<_> = crate::global_config::editable_config_files(&home, "codex").into_iter().map(|(t, _)| t).collect();
        assert_eq!(tags, ["config.toml"]);
        assert!(crate::global_config::editable_config_files(&home, "cursor").is_empty());
        let oc: Vec<_> = crate::global_config::editable_config_files(&home, "opencode").into_iter().map(|(t, _)| t).collect();
        assert_eq!(oc, ["opencode.json"], "都没有时列 opencode.json");
    }
}
