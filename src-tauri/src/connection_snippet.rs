//! 编辑连接弹层的「配置」视图：把一条连接按这家 CLI 自己的格式（JSON / TOML）渲染成片段，改完再解析回连接字段。
//! 片段就是「设为全局」会写进这家配置文件的那几项；原生格式放不下的连接字段放 `mesa` 小节；
//! 写了连接之外的 CLI 键报错（docs/design-config-file-editor.md 第二部分）。纯函数，不读写任何文件、不碰密钥原值

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// 片段里已保存密钥的占位开头：前端只有尾号，保持占位 = 不改密钥
const KEY_PLACEHOLDER_HEAD: &str = "«已保存密钥";

/// 弹层表单与片段之间交换的连接字段（camelCase 与前端同名）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetFields {
    #[serde(default)]
    pub name: String,
    /// "api" | "official"
    #[serde(default)]
    pub account_type: String,
    #[serde(default)]
    pub no_auth: bool,
    #[serde(default)]
    pub base_url: String,
    /// 渲染用：已存密钥的尾号（没有 = 还没存密钥）
    #[serde(default)]
    pub key_hint: Option<String>,
    /// 解析结果：片段里填了新密钥才有
    #[serde(default)]
    pub new_key: Option<String>,
    #[serde(default)]
    pub protocol: Option<String>,
    #[serde(default)]
    pub api_backend: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub top_p: Option<f64>,
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub header_env: BTreeMap<String, String>,
    #[serde(default)]
    pub extra_env: BTreeMap<String, String>,
    /// RoleModels 原样（对象；空 = 没设）
    #[serde(default)]
    pub role_models: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetDto {
    /// "json" | "toml"
    pub format: &'static str,
    /// Monaco 语言 id
    pub language: &'static str,
    /// 片段对应的文件（说明行用）
    pub file: &'static str,
    pub text: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Fmt {
    Json,
    Toml,
}

fn fmt_of(agent: &str) -> Fmt {
    match agent {
        "codex" | "kimi" | "grok" => Fmt::Toml,
        _ => Fmt::Json,
    }
}

fn file_of(agent: &str) -> &'static str {
    match agent {
        "claude-code" => "~/.claude/settings.json",
        "codebuddy" => "~/.codebuddy/settings.json",
        "qwen" => "~/.qwen/settings.json",
        "gemini" => "~/.gemini/settings.json 与 .env",
        "opencode" => "~/.config/opencode/opencode.json",
        "cursor" => "启动时的环境变量",
        "codex" => "~/.codex/config.toml",
        "kimi" => "~/.kimi-code/config.toml",
        "grok" => "~/.grok/config.toml",
        _ => "",
    }
}

// ===== 有序树与两种写法 =====

enum N {
    S(String),
    I(i64),
    F(f64),
    B(bool),
    A(Vec<N>),
    O(Vec<(String, N)>),
}

#[derive(Default)]
struct Obj(Vec<(String, N)>);

impl Obj {
    fn put(&mut self, k: &str, v: Option<N>) {
        if let Some(v) = v {
            if matches!(&v, N::O(items) if items.is_empty()) {
                return;
            }
            self.0.push((k.to_string(), v));
        }
    }
    fn n(self) -> N {
        N::O(self.0)
    }
}

fn s(v: impl Into<String>) -> N {
    N::S(v.into())
}

fn non_empty(v: &str) -> Option<&str> {
    let t = v.trim();
    (!t.is_empty()).then_some(t)
}

fn write_json(n: &N, indent: usize, out: &mut String) {
    let pad = "  ".repeat(indent + 1);
    match n {
        N::S(v) => out.push_str(&serde_json::to_string(v).unwrap_or_default()),
        N::I(v) => out.push_str(&v.to_string()),
        N::F(v) => out.push_str(&float_text(*v)),
        N::B(v) => out.push_str(if *v { "true" } else { "false" }),
        N::A(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push_str("[\n");
            for (i, item) in items.iter().enumerate() {
                out.push_str(&pad);
                write_json(item, indent + 1, out);
                out.push_str(if i + 1 < items.len() { ",\n" } else { "\n" });
            }
            out.push_str(&"  ".repeat(indent));
            out.push(']');
        }
        N::O(items) => {
            if items.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push_str("{\n");
            for (i, (k, v)) in items.iter().enumerate() {
                out.push_str(&pad);
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push_str(": ");
                write_json(v, indent + 1, out);
                out.push_str(if i + 1 < items.len() { ",\n" } else { "\n" });
            }
            out.push_str(&"  ".repeat(indent));
            out.push('}');
        }
    }
}

fn float_text(v: f64) -> String {
    let t = v.to_string();
    if t.contains('.') || t.contains('e') {
        t
    } else {
        format!("{t}.0")
    }
}

fn toml_key(k: &str) -> String {
    if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        k.to_string()
    } else {
        serde_json::to_string(k).unwrap_or_default()
    }
}

fn toml_inline(n: &N) -> String {
    match n {
        N::S(v) => serde_json::to_string(v).unwrap_or_default(),
        N::I(v) => v.to_string(),
        N::F(v) => float_text(*v),
        N::B(v) => v.to_string(),
        N::A(items) => format!("[{}]", items.iter().map(toml_inline).collect::<Vec<_>>().join(", ")),
        N::O(items) => format!(
            "{{ {} }}",
            items.iter().map(|(k, v)| format!("{} = {}", toml_key(k), toml_inline(v))).collect::<Vec<_>>().join(", ")
        ),
    }
}

/// 表头前缀 `path`（空 = 根）：先写本表的标量，再逐个写子表
fn write_toml(items: &[(String, N)], path: &[String], out: &mut String) {
    let scalars: Vec<_> = items.iter().filter(|(_, v)| !matches!(v, N::O(_))).collect();
    // 只有子表的父表不写表头（[a.b] 自带 a），完全空的表照写
    let has_sub = items.iter().any(|(_, v)| matches!(v, N::O(_)));
    if !path.is_empty() && (!scalars.is_empty() || !has_sub) {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!("[{}]\n", path.iter().map(|p| toml_key(p)).collect::<Vec<_>>().join(".")));
    }
    for (k, v) in scalars {
        out.push_str(&format!("{} = {}\n", toml_key(k), toml_inline(v)));
    }
    for (k, v) in items {
        if let N::O(sub) = v {
            let mut p = path.to_vec();
            p.push(k.clone());
            write_toml(sub, &p, out);
        }
    }
}

// ===== 渲染 =====

fn key_value(f: &SnippetFields) -> Option<N> {
    if f.account_type != "api" || f.no_auth {
        return None;
    }
    Some(match f.key_hint.as_deref().and_then(non_empty) {
        Some(hint) => s(format!("{KEY_PLACEHOLDER_HEAD} ···{hint}»")),
        None => s(""),
    })
}

fn url_value(f: &SnippetFields) -> Option<N> {
    (f.account_type == "api").then(|| non_empty(&f.base_url).map(s)).flatten()
}

fn str_map(map: &BTreeMap<String, String>) -> Option<N> {
    (!map.is_empty()).then(|| N::O(map.iter().map(|(k, v)| (k.clone(), s(v.clone()))).collect()))
}

fn json_to_n(v: &Value) -> N {
    match v {
        Value::String(x) => s(x.clone()),
        Value::Bool(b) => N::B(*b),
        Value::Number(x) => x.as_i64().map(N::I).unwrap_or_else(|| N::F(x.as_f64().unwrap_or(0.0))),
        Value::Array(a) => N::A(a.iter().map(json_to_n).collect()),
        Value::Object(o) => N::O(o.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), json_to_n(v))).collect()),
        Value::Null => s(""),
    }
}

/// 哪些字段这家有原生键（其余进 mesa）
struct Native {
    effort: bool,
    max_tokens: bool,
    sampling: bool,
    models: bool,
    protocol: bool,
}

fn native_of(agent: &str) -> Native {
    Native {
        effort: matches!(agent, "claude-code" | "codex" | "grok"),
        max_tokens: matches!(agent, "claude-code" | "codebuddy" | "grok"),
        sampling: agent == "grok",
        models: agent == "opencode",
        protocol: matches!(agent, "qwen" | "kimi"),
    }
}

fn mesa_section(agent: &str, f: &SnippetFields) -> N {
    let nat = native_of(agent);
    let mut m = Obj::default();
    m.put("name", non_empty(&f.name).map(s));
    // Codex 配置里没有放明文密钥的位置（Mesa 用 auth.command 现取），放 mesa 小节
    if agent == "codex" {
        m.put("api_key", key_value(f));
    }
    if !nat.models {
        m.put("models", Some(N::A(f.models.iter().map(|x| s(x.clone())).collect())));
    }
    if !nat.sampling {
        m.put("temperature", f.temperature.map(N::F));
        m.put("top_p", f.top_p.map(N::F));
    }
    if !nat.max_tokens {
        m.put("max_output_tokens", f.max_output_tokens.map(|v| N::I(v as i64)));
    }
    if !nat.effort {
        m.put("reasoning_effort", f.reasoning_effort.as_deref().and_then(non_empty).map(s));
    }
    if !nat.protocol {
        m.put("protocol", f.protocol.as_deref().and_then(non_empty).map(s));
    }
    m.put("headers", str_map(&f.header_env));
    m.put("extra_env", str_map(&f.extra_env));
    if f.no_auth {
        m.put("no_auth", Some(N::B(true)));
    }
    if f.role_models.as_object().is_some_and(|o| o.values().any(|v| !v.is_null())) {
        m.put("role_models", Some(json_to_n(&f.role_models)));
    }
    m.n()
}

fn proto_prefix(protocol: Option<&str>) -> &'static str {
    if protocol == Some("anthropic") {
        "ANTHROPIC"
    } else {
        "OPENAI"
    }
}

fn render_tree(agent: &str, f: &SnippetFields) -> Result<Vec<(String, N)>, String> {
    let default = f.models.first().map(|m| s(m.clone()));
    let effort = f.reasoning_effort.as_deref().and_then(non_empty).map(s);
    let max_tokens = f.max_output_tokens;
    let mut root = Obj::default();
    match agent {
        "claude-code" | "codebuddy" => {
            let p = if agent == "claude-code" { "ANTHROPIC" } else { "CODEBUDDY" };
            let mut env = Obj::default();
            env.put(&format!("{p}_BASE_URL"), url_value(f));
            env.put(if agent == "claude-code" { "ANTHROPIC_AUTH_TOKEN" } else { "CODEBUDDY_API_KEY" }, key_value(f));
            let mt = if agent == "claude-code" { "CLAUDE_CODE_MAX_OUTPUT_TOKENS" } else { "CODEBUDDY_CODE_MAX_OUTPUT_TOKENS" };
            env.put(mt, max_tokens.map(|v| s(v.to_string())));
            root.put("env", Some(env.n()));
            root.put("model", default);
            if agent == "claude-code" {
                root.put("effortLevel", effort);
            }
        }
        "qwen" => {
            let mut auth = Obj::default();
            auth.put("selectedType", Some(s(f.protocol.clone().unwrap_or_else(|| "openai".into()))));
            let mut sec = Obj::default();
            sec.put("auth", Some(auth.n()));
            root.put("security", Some(sec.n()));
            let p = proto_prefix(f.protocol.as_deref());
            let mut env = Obj::default();
            env.put(&format!("{p}_BASE_URL"), url_value(f));
            env.put(&format!("{p}_API_KEY"), key_value(f));
            root.put("env", Some(env.n()));
            let mut model = Obj::default();
            model.put("name", default);
            root.put("model", Some(model.n()));
        }
        "gemini" => {
            let mut model = Obj::default();
            model.put("name", default);
            root.put("model", Some(model.n()));
            let mut env = Obj::default();
            env.put("GOOGLE_GEMINI_BASE_URL", url_value(f));
            env.put("GEMINI_API_KEY", key_value(f));
            root.put("env", Some(env.n()));
        }
        "opencode" => {
            root.put("model", f.models.first().map(|m| s(format!("mesa/{m}"))));
            let mut options = Obj::default();
            options.put("baseURL", url_value(f));
            options.put("apiKey", key_value(f));
            let mut provider = Obj::default();
            provider.put("options", Some(options.n()));
            provider.put("models", Some(N::O(f.models.iter().map(|m| (m.clone(), N::O(Vec::new()))).collect())));
            let mut providers = Obj::default();
            providers.put("mesa", Some(provider.n()));
            root.put("provider", Some(providers.n()));
        }
        "cursor" => {
            let mut env = Obj::default();
            env.put("CURSOR_API_KEY", key_value(f));
            env.put("CURSOR_API_ENDPOINT", url_value(f));
            root.put("env", Some(env.n()));
            root.put("model", default);
        }
        "codex" => {
            root.put("model", default);
            root.put("model_reasoning_effort", effort);
            if f.account_type == "api" {
                root.put("model_provider", Some(s("custom")));
                let mut blk = Obj::default();
                blk.put("base_url", url_value(f));
                let mut providers = Obj::default();
                providers.put("custom", Some(blk.n()));
                root.put("model_providers", Some(providers.n()));
            }
        }
        "kimi" => {
            root.put("default_model", default);
            if f.account_type == "api" {
                let mut p = Obj::default();
                p.put("type", Some(s(f.protocol.clone().unwrap_or_else(|| "kimi".into()))));
                p.put("base_url", url_value(f));
                p.put("api_key", key_value(f));
                let mut providers = Obj::default();
                providers.put("mesa", Some(p.n()));
                root.put("providers", Some(providers.n()));
            }
        }
        "grok" => {
            let mut models = Obj::default();
            models.put("default", default);
            models.put("default_reasoning_effort", effort);
            models.put("temperature", f.temperature.map(N::F));
            models.put("top_p", f.top_p.map(N::F));
            models.put("max_completion_tokens", max_tokens.map(|v| N::I(v as i64)));
            root.put("models", Some(models.n()));
            if let (Some(m), true) = (f.models.first(), f.account_type == "api") {
                let mut sec = Obj::default();
                sec.put("base_url", url_value(f));
                sec.put("api_key", key_value(f));
                sec.put("api_backend", f.api_backend.as_deref().and_then(non_empty).map(s));
                let mut tbl = Obj::default();
                tbl.put(m, Some(sec.n()));
                root.put("model", Some(tbl.n()));
            }
        }
        other => return Err(format!("{other} 没有配置视图")),
    }
    root.put("mesa", Some(mesa_section(agent, f)));
    Ok(root.0)
}

pub fn render(agent: &str, f: &SnippetFields) -> Result<SnippetDto, String> {
    let tree = render_tree(agent, f)?;
    let mut text = String::new();
    match fmt_of(agent) {
        Fmt::Json => {
            write_json(&N::O(tree), 0, &mut text);
            text.push('\n');
        }
        Fmt::Toml => write_toml(&tree, &[], &mut text),
    }
    let format = if fmt_of(agent) == Fmt::Json { "json" } else { "toml" };
    Ok(SnippetDto {
        format,
        language: if format == "json" { "json" } else { "ini" },
        file: file_of(agent),
        text,
    })
}

// ===== 解析 =====

/// 取出并删掉 `path` 处的值（找不到 = None）
fn take(root: &mut Value, path: &[&str]) -> Option<Value> {
    let (last, parents) = path.split_last()?;
    let mut cur = root;
    for p in parents {
        cur = cur.get_mut(*p)?;
    }
    cur.as_object_mut()?.remove(*last)
}

fn as_text(v: Option<Value>, what: &str) -> Result<Option<String>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(x)) => Ok(non_empty(&x).map(str::to_string)),
        Some(_) => Err(format!("{what} 要写成字符串")),
    }
}

fn as_f64(v: Option<Value>, what: &str) -> Result<Option<f64>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => Ok(n.as_f64()),
        Some(Value::String(x)) if x.trim().is_empty() => Ok(None),
        Some(Value::String(x)) => x.trim().parse().map(Some).map_err(|_| format!("{what} 要写成数字")),
        Some(_) => Err(format!("{what} 要写成数字")),
    }
}

fn as_u64(v: Option<Value>, what: &str) -> Result<Option<u64>, String> {
    match as_f64(v, what)? {
        None => Ok(None),
        Some(x) if x >= 0.0 && x.fract() == 0.0 => Ok(Some(x as u64)),
        Some(_) => Err(format!("{what} 要写成正整数")),
    }
}

fn as_str_map(v: Option<Value>, what: &str) -> Result<BTreeMap<String, String>, String> {
    match v {
        None | Some(Value::Null) => Ok(BTreeMap::new()),
        Some(Value::Object(o)) => o
            .into_iter()
            .map(|(k, v)| match v {
                Value::String(x) => Ok((k, x)),
                _ => Err(format!("{what} 里 {k} 的值要写成字符串")),
            })
            .collect(),
        Some(_) => Err(format!("{what} 要写成「名: 值」的对象")),
    }
}

/// 删掉空对象后，剩下的叶子路径 = 不认识的键
fn leftovers(v: &Value, prefix: &str, out: &mut Vec<String>) {
    if let Value::Object(o) = v {
        for (k, child) in o {
            let path = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
            match child {
                Value::Object(c) if c.is_empty() => {}
                Value::Object(_) => leftovers(child, &path, out),
                _ => out.push(path),
            }
        }
    }
}

/// 认任意一个子表名（片段里固定写 custom / mesa，用户改了名也认），只允许一个
fn single_child(root: &mut Value, table: &str) -> Result<Option<(String, Value)>, String> {
    let Some(Value::Object(map)) = root.get_mut(table) else {
        return Ok(None);
    };
    if map.len() > 1 {
        return Err(format!("[{table}] 下只能有一段（这条连接自己的），现在有 {} 段", map.len()));
    }
    let key = map.keys().next().cloned();
    Ok(key.and_then(|k| map.remove(&k).map(|v| (k, v))))
}

pub fn parse(agent: &str, account_type: &str, text: &str) -> Result<SnippetFields, String> {
    let mut root: Value = match fmt_of(agent) {
        Fmt::Json => serde_json::from_str(crate::mcp::strip_bom(text))
            .map_err(|e| format!("不是合法的 JSON（第 {} 行第 {} 列）：{e}", e.line(), e.column()))?,
        Fmt::Toml => {
            let t: toml::Value = toml::from_str(text).map_err(|e| format!("不是合法的 TOML：{}", e.to_string().trim()))?;
            serde_json::to_value(t).map_err(|e| e.to_string())?
        }
    };
    if !root.is_object() {
        return Err("最外层必须是对象".into());
    }
    let mut f = SnippetFields { account_type: account_type.to_string(), ..Default::default() };
    let mut key: Option<String> = None;
    let mut url: Option<String> = None;
    let mut default: Option<String> = None;
    let mut native_models: Option<Vec<String>> = None;
    match agent {
        "claude-code" | "codebuddy" => {
            let (p, k, mt) = if agent == "claude-code" {
                ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_MAX_OUTPUT_TOKENS")
            } else {
                ("CODEBUDDY_BASE_URL", "CODEBUDDY_API_KEY", "CODEBUDDY_CODE_MAX_OUTPUT_TOKENS")
            };
            url = as_text(take(&mut root, &["env", p]), p)?;
            key = as_text(take(&mut root, &["env", k]), k)?;
            f.max_output_tokens = as_u64(take(&mut root, &["env", mt]), mt)?;
            default = as_text(take(&mut root, &["model"]), "model")?;
            if agent == "claude-code" {
                f.reasoning_effort = as_text(take(&mut root, &["effortLevel"]), "effortLevel")?;
            }
        }
        "qwen" => {
            f.protocol = as_text(take(&mut root, &["security", "auth", "selectedType"]), "selectedType")?;
            for p in ["OPENAI", "ANTHROPIC"] {
                if let Some(u) = as_text(take(&mut root, &["env", &format!("{p}_BASE_URL")]), "BASE_URL")? {
                    url = Some(u);
                }
                if let Some(k) = as_text(take(&mut root, &["env", &format!("{p}_API_KEY")]), "API_KEY")? {
                    key = Some(k);
                }
            }
            default = as_text(take(&mut root, &["model", "name"]), "model.name")?;
        }
        "gemini" => {
            default = as_text(take(&mut root, &["model", "name"]), "model.name")?;
            url = as_text(take(&mut root, &["env", "GOOGLE_GEMINI_BASE_URL"]), "GOOGLE_GEMINI_BASE_URL")?;
            key = as_text(take(&mut root, &["env", "GEMINI_API_KEY"]), "GEMINI_API_KEY")?;
        }
        "opencode" => {
            let model = as_text(take(&mut root, &["model"]), "model")?;
            if let Some((_, mut p)) = single_child(&mut root, "provider")? {
                url = as_text(take(&mut p, &["options", "baseURL"]), "baseURL")?;
                key = as_text(take(&mut p, &["options", "apiKey"]), "apiKey")?;
                match take(&mut p, &["models"]) {
                    None | Some(Value::Null) => {}
                    Some(Value::Object(m)) => native_models = Some(m.keys().cloned().collect()),
                    Some(_) => return Err("provider 的 models 要写成以模型名为键的对象".into()),
                }
                let mut rest = Vec::new();
                leftovers(&p, "provider.mesa", &mut rest);
                if !rest.is_empty() {
                    return Err(unknown_keys(&rest));
                }
            }
            // 「渠道/模型」：渠道名只是展示用
            default = model.map(|m| m.split_once('/').map(|(_, m)| m.to_string()).unwrap_or(m));
        }
        "cursor" => {
            key = as_text(take(&mut root, &["env", "CURSOR_API_KEY"]), "CURSOR_API_KEY")?;
            url = as_text(take(&mut root, &["env", "CURSOR_API_ENDPOINT"]), "CURSOR_API_ENDPOINT")?;
            default = as_text(take(&mut root, &["model"]), "model")?;
        }
        "codex" => {
            default = as_text(take(&mut root, &["model"]), "model")?;
            f.reasoning_effort = as_text(take(&mut root, &["model_reasoning_effort"]), "model_reasoning_effort")?;
            let _ = take(&mut root, &["model_provider"]);
            if let Some((_, mut blk)) = single_child(&mut root, "model_providers")? {
                url = as_text(take(&mut blk, &["base_url"]), "base_url")?;
                let mut rest = Vec::new();
                leftovers(&blk, "model_providers.custom", &mut rest);
                if !rest.is_empty() {
                    return Err(unknown_keys(&rest));
                }
            }
        }
        "kimi" => {
            default = as_text(take(&mut root, &["default_model"]), "default_model")?;
            if let Some((_, mut p)) = single_child(&mut root, "providers")? {
                f.protocol = as_text(take(&mut p, &["type"]), "type")?;
                url = as_text(take(&mut p, &["base_url"]), "base_url")?;
                key = as_text(take(&mut p, &["api_key"]), "api_key")?;
                let mut rest = Vec::new();
                leftovers(&p, "providers.mesa", &mut rest);
                if !rest.is_empty() {
                    return Err(unknown_keys(&rest));
                }
            }
        }
        "grok" => {
            default = as_text(take(&mut root, &["models", "default"]), "models.default")?;
            f.reasoning_effort = as_text(take(&mut root, &["models", "default_reasoning_effort"]), "default_reasoning_effort")?;
            f.temperature = as_f64(take(&mut root, &["models", "temperature"]), "temperature")?;
            f.top_p = as_f64(take(&mut root, &["models", "top_p"]), "top_p")?;
            f.max_output_tokens = as_u64(take(&mut root, &["models", "max_completion_tokens"]), "max_completion_tokens")?;
            if let Some((name, mut sec)) = single_child(&mut root, "model")? {
                url = as_text(take(&mut sec, &["base_url"]), "base_url")?;
                key = as_text(take(&mut sec, &["api_key"]), "api_key")?;
                f.api_backend = as_text(take(&mut sec, &["api_backend"]), "api_backend")?;
                let mut rest = Vec::new();
                leftovers(&sec, &format!("model.{name}"), &mut rest);
                if !rest.is_empty() {
                    return Err(unknown_keys(&rest));
                }
                // 段名就是默认模型：两处不一致时以 [models].default 为准，没写 default 用段名
                if default.is_none() {
                    default = Some(name);
                }
            }
        }
        other => return Err(format!("{other} 没有配置视图")),
    }
    // mesa 小节
    let mut mesa = take(&mut root, &["mesa"]).unwrap_or(Value::Null);
    if !(mesa.is_object() || mesa.is_null()) {
        return Err("mesa 要写成对象".into());
    }
    f.name = as_text(take(&mut mesa, &["name"]), "mesa.name")?.unwrap_or_default();
    if agent == "codex" {
        key = as_text(take(&mut mesa, &["api_key"]), "mesa.api_key")?;
    }
    let listed: Option<Vec<String>> = match take(&mut mesa, &["models"]) {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) => Some(
            a.into_iter()
                .map(|v| v.as_str().map(|x| x.trim().to_string()).ok_or("mesa.models 里每一项都要是模型名字符串".to_string()))
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .filter(|x| !x.is_empty())
                .collect(),
        ),
        Some(_) => return Err("mesa.models 要写成模型名数组".into()),
    };
    let mut models = native_models.or(listed).unwrap_or_default();
    if let Some(d) = default.filter(|d| !d.is_empty()) {
        match models.iter().position(|m| *m == d) {
            Some(i) => {
                let m = models.remove(i);
                models.insert(0, m);
            }
            None if models.is_empty() => models.push(d),
            None => return Err(format!("默认模型 {d} 不在模型名单里：先把它加进名单")),
        }
    }
    let mut seen = std::collections::HashSet::new();
    models.retain(|m| seen.insert(m.clone()));
    f.models = models;
    if let Some(t) = as_f64(take(&mut mesa, &["temperature"]), "mesa.temperature")? {
        f.temperature = Some(t);
    }
    if let Some(t) = as_f64(take(&mut mesa, &["top_p"]), "mesa.top_p")? {
        f.top_p = Some(t);
    }
    if let Some(t) = as_u64(take(&mut mesa, &["max_output_tokens"]), "mesa.max_output_tokens")? {
        f.max_output_tokens = Some(t);
    }
    if let Some(e) = as_text(take(&mut mesa, &["reasoning_effort"]), "mesa.reasoning_effort")? {
        f.reasoning_effort = Some(e);
    }
    if let Some(p) = as_text(take(&mut mesa, &["protocol"]), "mesa.protocol")? {
        f.protocol = Some(p);
    }
    f.header_env = as_str_map(take(&mut mesa, &["headers"]), "mesa.headers")?;
    f.extra_env = as_str_map(take(&mut mesa, &["extra_env"]), "mesa.extra_env")?;
    f.no_auth = match take(&mut mesa, &["no_auth"]) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => b,
        Some(_) => return Err("mesa.no_auth 要写成 true / false".into()),
    };
    f.role_models = match take(&mut mesa, &["role_models"]) {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Object(mut o)) => {
            // 只认 RoleModels 的四个键，多出来的算不认识
            let mut known = serde_json::Map::new();
            for k in ["small", "subagent", "slots", "displayNames"] {
                if let Some(v) = o.remove(k) {
                    known.insert(k.to_string(), v);
                }
            }
            if !o.is_empty() {
                let mut rest: Vec<String> = o.keys().map(|k| format!("mesa.role_models.{k}")).collect();
                rest.sort();
                return Err(unknown_keys(&rest));
            }
            Value::Object(known)
        }
        Some(_) => return Err("mesa.role_models 要写成对象".into()),
    };
    let mut rest = Vec::new();
    leftovers(&root, "", &mut rest);
    leftovers(&mesa, "mesa", &mut rest);
    if !rest.is_empty() {
        return Err(unknown_keys(&rest));
    }
    if account_type == "api" {
        f.base_url = url.unwrap_or_default();
        f.new_key = key.filter(|k| !k.starts_with(KEY_PLACEHOLDER_HEAD));
    }
    Ok(f)
}

fn unknown_keys(paths: &[String]) -> String {
    format!(
        "这些不是这条连接的设置：{}。连接之外的 CLI 设置到连接页这家 Agent 的 ⋯「编辑配置文件」里改",
        paths.join("、")
    )
}

#[tauri::command]
pub fn connection_snippet_render(agent: String, fields: SnippetFields) -> Result<SnippetDto, String> {
    render(&agent, &fields)
}

#[tauri::command]
pub fn connection_snippet_parse(agent: String, account_type: String, text: String) -> Result<SnippetFields, String> {
    parse(&agent, &account_type, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENTS: [&str; 9] = ["claude-code", "codebuddy", "qwen", "gemini", "opencode", "cursor", "codex", "kimi", "grok"];

    fn full(agent: &str) -> SnippetFields {
        SnippetFields {
            name: "Zeta".into(),
            account_type: "api".into(),
            base_url: "https://api.zetatechs.com/v1".into(),
            key_hint: Some("TKsD".into()),
            protocol: match agent {
                "qwen" => Some("openai".into()),
                "kimi" => Some("kimi".into()),
                _ => None,
            },
            api_backend: (agent == "grok").then(|| "responses".into()),
            models: vec!["m-a".into(), "m/b".into()],
            temperature: Some(0.3),
            top_p: Some(0.9),
            max_output_tokens: Some(8192),
            reasoning_effort: Some("high".into()),
            header_env: [("X-Tenant".to_string(), "TENANT_TOKEN".to_string())].into(),
            extra_env: [("HTTPS_PROXY".to_string(), "http://127.0.0.1:7890".to_string())].into(),
            role_models: serde_json::json!({ "small": "m/b" }),
            ..Default::default()
        }
    }

    #[test]
    fn every_agent_round_trips_without_touching_the_key() {
        for agent in AGENTS {
            let f = full(agent);
            let dto = render(agent, &f).unwrap();
            assert!(dto.text.contains("«已保存密钥 ···TKsD»"), "{agent}: 密钥是占位\n{}", dto.text);
            let back = parse(agent, "api", &dto.text).unwrap_or_else(|e| panic!("{agent}: {e}\n{}", dto.text));
            let mut want = f.clone();
            want.key_hint = None;
            assert_eq!(back, want, "{agent} 往返一致\n{}", dto.text);
            assert_eq!(dto.format, if matches!(agent, "codex" | "kimi" | "grok") { "toml" } else { "json" });
        }
    }

    #[test]
    fn native_keys_land_where_the_cli_reads_them() {
        let claude = render("claude-code", &full("claude-code")).unwrap().text;
        assert!(claude.contains("\"ANTHROPIC_BASE_URL\": \"https://api.zetatechs.com/v1\""));
        assert!(claude.contains("\"effortLevel\": \"high\""));
        let codex = render("codex", &full("codex")).unwrap().text;
        assert!(codex.contains("model = \"m-a\""));
        assert!(codex.contains("[model_providers.custom]\nbase_url = "));
        let grok = render("grok", &full("grok")).unwrap().text;
        assert!(grok.contains("[model.m-a]") && grok.contains("api_backend = \"responses\""));
        let oc = render("opencode", &full("opencode")).unwrap().text;
        assert!(oc.contains("\"model\": \"mesa/m-a\"") && oc.contains("\"m/b\": {}"));
    }

    #[test]
    fn new_key_default_reorder_and_unknown_keys() {
        let mut t = render("codex", &full("codex")).unwrap().text;
        t = t.replace("model = \"m-a\"", "model = \"m/b\"");
        t = t.replace("«已保存密钥 ···TKsD»", "sk-new");
        let f = parse("codex", "api", &t).unwrap();
        assert_eq!(f.models, ["m/b", "m-a"], "默认模型挪到第一个");
        assert_eq!(f.new_key.as_deref(), Some("sk-new"));
        let bad = t.replace("model = \"m/b\"", "model = \"zz\"");
        assert!(parse("codex", "api", &bad).unwrap_err().contains("不在模型名单里"));
        let extra = format!("model_context_window = 1000\n{t}");
        let err = parse("codex", "api", &extra).unwrap_err();
        assert!(err.contains("model_context_window") && err.contains("编辑配置文件"), "{err}");
        // 落进最后一张表（TOML 语义）的也拦得住
        let tail = format!("{t}\nmodel_context_window = 1000\n");
        assert!(parse("codex", "api", &tail).unwrap_err().contains("model_context_window"));
        let json_extra = r#"{"model":"x","permissions":{"defaultMode":"auto"},"mesa":{"models":["x"],"bogus":1}}"#;
        let err = parse("claude-code", "api", json_extra).unwrap_err();
        assert!(err.contains("permissions.defaultMode") && err.contains("mesa.bogus"), "{err}");
        // 删掉密钥那一行 = 不改
        let nokey = r#"{"model":"x","mesa":{"models":["x"]}}"#;
        assert_eq!(parse("claude-code", "api", nokey).unwrap().new_key, None);
    }

    #[test]
    fn official_accounts_hide_url_and_key() {
        let mut f = full("codex");
        f.account_type = "official".into();
        let t = render("codex", &f).unwrap().text;
        assert!(!t.contains("base_url") && !t.contains("已保存密钥"));
        let back = parse("codex", "official", &t).unwrap();
        assert_eq!(back.base_url, "");
        assert_eq!(back.models, ["m-a", "m/b"]);
    }

    #[test]
    fn rejects_malformed_text() {
        assert!(parse("claude-code", "api", "{ nope").unwrap_err().contains("JSON"));
        assert!(parse("grok", "api", "a = ").unwrap_err().contains("TOML"));
        assert!(parse("grok", "api", "[model.a]\nbase_url = \"x\"\n[model.b]\nbase_url = \"y\"\n").is_err(), "只能一段");
    }
}
