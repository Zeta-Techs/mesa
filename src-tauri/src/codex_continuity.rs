//! Codex 客户端续聊（2026-10-31 用户拍板）：切全局只动「新对话默认」，老对话要用的只加不删。
//!
//! Codex 三样东西作用范围不同（matrix §1）：对话用哪个渠道在开对话时定死；渠道定义在全局 config.toml，
//! 开 / 续对话时读；模型目录全局只有一份，客户端启动时读。切全局时把老对话要用的渠道或模型拿掉，
//! 客户端就报 `Model provider ... not found` 或 `This model isn't available`。所以：
//! - **渠道定义**：对话表里出现过、Mesa 认得出网关的 `ccode-<短id>` 补定义块；认证写 `auth.command`
//!   （`mesa_helper codex-token <网关 id>` 现取 keys.json），config.toml 不落明文。Mesa 以前写的明文块顺带改成这样。
//! - **模型目录**：Mesa 专用文件 `codex-global.json` = 当前默认的模型 + 老对话用过、渠道还在的模型（官方对话的
//!   官方模型照抄本机 `models_cache.json`，中转对话按 Mesa 模板）。官方默认下没有中转老对话就不接管目录。
//! - 只读对话表（`state_<N>.sqlite`），不改对话；写 config.toml 只在用户点「设为全局」或「补齐」时，走全局写入的备份。
//!   目录文件是 Mesa 自己的，启动时按本机官方模型表刷新（`refresh_on_startup`）。

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::profiles::{AccountType, Profile};
use crate::provider_id;

/// helper 子命令名：渠道块 `auth.args` 的第一个参数
pub(crate) const TOKEN_SUBCOMMAND: &str = "codex-token";
/// 内置 ChatGPT 登录渠道
const OFFICIAL: &str = provider_id::CODEX_CHATGPT;
/// 目录条目上限：对话表再多也不把选择器撑成长单
const MAX_ENTRIES: usize = 60;

// ===== helper 子命令 =====

pub fn helper_token_cli(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("--probe") => {
            println!("ok");
            0
        }
        Some(gid) if !gid.trim().is_empty() => match crate::profiles::read_key_file_only(gid) {
            Ok(Some(key)) => {
                print!("{key}");
                0
            }
            Ok(None) => {
                eprintln!("Mesa 里没有这个网关的密钥（{gid}），连接可能已删除：到 Mesa 连接页 Codex 一栏点「补齐」或重新设为全局");
                1
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        _ => {
            eprintln!("用法：mesa_helper {TOKEN_SUBCOMMAND} <网关 id>");
            2
        }
    }
}

/// 写进 config.toml 的 helper 路径：随包 helper 拷一份到 Mesa 配置目录 `bin/` 下用。
/// 开发版的 helper 在 target/debug/deps/ 下、名字带哈希，换一次构建就不在了；打包版随 .app 挪位置也会断。
/// 拷贝跟着 Mesa 走（每次用到时比对大小与修改时间，旧了就换）
pub(crate) fn stable_helper() -> Option<PathBuf> {
    let src = crate::image_gen::find_bundled_helper(TOKEN_SUBCOMMAND)?;
    let name = if cfg!(windows) { "mesa_helper.exe" } else { "mesa_helper" };
    let Some(dir) = crate::storage::config_root().map(|r| r.join("bin")) else {
        return Some(src);
    };
    let dest = dir.join(name);
    if needs_copy(&src, &dest) {
        let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
        let copied = std::fs::create_dir_all(&dir)
            .and_then(|_| std::fs::copy(&src, &tmp))
            .and_then(|_| {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
                }
                std::fs::rename(&tmp, &dest)
            });
        if copied.is_err() {
            let _ = std::fs::remove_file(&tmp);
            // Windows 上正被 Codex 调着的 exe 换不掉：旧拷贝还在就接着用，没有才退回随包原件
            if !dest.is_file() {
                return Some(src);
            }
        }
    }
    Some(dest)
}

fn needs_copy(src: &Path, dest: &Path) -> bool {
    let (Ok(s), Ok(d)) = (std::fs::metadata(src), std::fs::metadata(dest)) else {
        return true;
    };
    s.len() != d.len() || s.modified().ok() > d.modified().ok()
}

// ===== 输入 =====

/// 对话表里的一组（渠道, 模型）
#[derive(Debug, Clone)]
pub(crate) struct ThreadRef {
    pub provider: String,
    pub model: String,
    pub threads: u32,
}

/// 能给 Codex 渠道补定义的网关（取自 Codex 的 API 绑定）
#[derive(Debug, Clone)]
pub(crate) struct GwLite {
    pub gateway_id: String,
    pub name: String,
    pub base_url: String,
    pub header_env: BTreeMap<String, String>,
    pub timeout_secs: Option<u32>,
}

impl GwLite {
    fn from_profile(p: &Profile) -> Option<Self> {
        Some(GwLite {
            gateway_id: p.gateway_id.clone()?,
            name: p.name.clone(),
            base_url: p.base_url.clone()?,
            header_env: p.request_policy.header_env.clone(),
            timeout_secs: p.request_policy.compat.timeout_secs,
        })
    }

    fn matches(&self, provider: &str) -> bool {
        provider_id::gateway_matches_provider(&self.gateway_id, provider)
    }
}

pub(crate) struct Inputs {
    pub refs: Vec<ThreadRef>,
    pub gateways: Vec<GwLite>,
    pub helper: Option<PathBuf>,
    /// ChatGPT 账号能用的模型（登录着才有）：`models_cache.json` 里 visibility = list 的原样条目
    pub official: Vec<Value>,
    pub catalog_path: PathBuf,
}

impl Inputs {
    pub(crate) fn gather(codex_dir: &Path, profiles: &[Profile]) -> Result<Self, String> {
        Ok(Self {
            refs: read_thread_refs(codex_dir),
            gateways: gateways_from(profiles),
            helper: stable_helper(),
            official: official_entries(codex_dir),
            catalog_path: crate::agents::codex_global_catalog_path().ok_or("无法确定平台配置目录")?,
        })
    }

    fn gateway_for(&self, provider: &str) -> Option<&GwLite> {
        self.gateways.iter().find(|g| g.matches(provider))
    }
}

/// 对话表按（渠道, 模型）聚合，最近用过的在前；归档的不算（客户端侧栏不列）
pub(crate) fn read_thread_refs(codex_dir: &Path) -> Vec<ThreadRef> {
    let Some(db) = crate::client_open::codex_state_db(codex_dir) else {
        return Vec::new();
    };
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(300));
    let Ok(mut stmt) = conn.prepare(
        "SELECT model_provider, COALESCE(model, ''), COUNT(*) FROM threads WHERE archived = 0 \
         GROUP BY model_provider, model ORDER BY MAX(updated_at) DESC",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok(ThreadRef {
            provider: r.get(0)?,
            model: r.get(1)?,
            threads: r.get::<_, i64>(2)?.max(0) as u32,
        })
    });
    match rows {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

pub(crate) fn gateways_from(profiles: &[Profile]) -> Vec<GwLite> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for p in profiles {
        if p.agent != "codex" || p.account_type == AccountType::Official || p.no_auth || !p.has_key {
            continue;
        }
        let (Some(gid), Some(url)) = (p.gateway_id.as_ref(), p.base_url.as_ref()) else {
            continue;
        };
        if url.trim().is_empty() || !seen.insert(gid.clone()) {
            continue;
        }
        out.extend(GwLite::from_profile(p));
    }
    out
}

/// ChatGPT 登录着才给官方模型（API Key 模式的 auth.json 不算，matrix §1）
fn official_entries(codex_dir: &Path) -> Vec<Value> {
    let logged_in = std::fs::read_to_string(codex_dir.join("auth.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .is_some_and(|v| v.get("tokens").is_some_and(|t| t.is_object()));
    if !logged_in {
        return Vec::new();
    }
    std::fs::read_to_string(codex_dir.join("models_cache.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("models").and_then(|m| m.as_array()).cloned())
        .map(|models| {
            models
                .into_iter()
                .filter(|m| m.get("visibility").and_then(|v| v.as_str()) == Some("list"))
                .filter(|m| m.get("slug").and_then(|s| s.as_str()).is_some())
                .collect()
        })
        .unwrap_or_default()
}

// ===== 渠道定义块 =====

fn is_mesa_block(item: &toml_edit::Item) -> bool {
    item.get("name").and_then(|v| v.as_str()) == Some("Mesa")
}

/// 与 Mesa 启动时内联的渠道同形（agents::codex_inline_provider_args），认证换成 auth.command
fn provider_block(gw: &GwLite, helper: &Path) -> toml_edit::Table {
    use toml_edit::value;
    let mut blk = toml_edit::Table::new();
    blk["name"] = value("Mesa");
    blk["base_url"] = value(gw.base_url.as_str());
    blk["wire_api"] = value("responses");
    if let Some(secs) = gw.timeout_secs {
        blk["stream_idle_timeout_ms"] = value(i64::from(secs) * 1000);
    }
    if !gw.header_env.is_empty() {
        let mut headers = toml_edit::InlineTable::new();
        for (h, var) in &gw.header_env {
            headers.insert(h.as_str(), toml_edit::Value::from(var.as_str()));
        }
        blk["env_http_headers"] = value(headers);
    }
    let mut auth = toml_edit::Table::new();
    auth["command"] = value(helper.to_string_lossy().as_ref());
    let mut args = toml_edit::Array::new();
    args.push(TOKEN_SUBCOMMAND);
    args.push(gw.gateway_id.as_str());
    auth["args"] = value(args);
    blk["auth"] = toml_edit::Item::Table(auth);
    blk
}

/// 客户端接力「写入并打开」与会话导入：按给定块名写一条渠道定义（整块换掉，认证走 auth.command）。
/// 块名可能不是本机派生名（导入别的机器的对话时用 rollout 里记的原名），网关以绑定为准
pub(crate) fn register_block(existing: Option<&str>, block_name: &str, profile: &Profile, helper: &Path) -> Result<String, String> {
    let gw = GwLite::from_profile(profile).ok_or("这个连接还没配网关端点，没有可写的渠道定义")?;
    let mut doc = crate::global_config::parse_toml_doc(existing)?;
    let providers = crate::global_config::sub_table(doc.as_item_mut(), "model_providers")?;
    providers
        .as_table_mut()
        .ok_or_else(|| "model_providers 不是表，已停止写入".to_string())?
        .insert(block_name, toml_edit::Item::Table(provider_block(&gw, helper)));
    Ok(doc.to_string())
}

/// 要补 / 要改写的渠道：对话里出现过的 `ccode-<短id>`，加上 Mesa 以前写下的 `ccode-*` 块；认不出网关的不碰
fn provider_targets(doc: &toml_edit::DocumentMut, inp: &Inputs) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for r in &inp.refs {
        if provider_id::short_id_from_provider(&r.provider).is_some() && !names.contains(&r.provider) {
            names.push(r.provider.clone());
        }
    }
    if let Some(t) = doc.get("model_providers").and_then(|i| i.as_table_like()) {
        for (k, item) in t.iter() {
            if provider_id::short_id_from_provider(k).is_some() && is_mesa_block(item) && !names.iter().any(|n| n == k) {
                names.push(k.to_string());
            }
        }
    }
    names.retain(|n| inp.gateway_for(n).is_some());
    names
}

fn patch_providers(doc: &mut toml_edit::DocumentMut, inp: &Inputs) -> Result<(), String> {
    let Some(helper) = inp.helper.as_deref() else {
        return Ok(());
    };
    let targets = provider_targets(doc, inp);
    if targets.is_empty() {
        return Ok(());
    }
    let providers = crate::global_config::sub_table(doc.as_item_mut(), "model_providers")?;
    let t = providers
        .as_table_mut()
        .ok_or_else(|| "model_providers 不是表，已停止写入".to_string())?;
    for name in targets {
        let Some(gw) = inp.gateway_for(&name) else { continue };
        // 用户自己写的同名块不动
        if t.get(&name).is_some_and(|item| !is_mesa_block(item)) {
            continue;
        }
        t.insert(&name, toml_edit::Item::Table(provider_block(gw, helper)));
    }
    Ok(())
}

/// config.toml 里有定义的渠道名（内置 openai 恒在）
fn defined_providers(doc: &toml_edit::DocumentMut) -> HashSet<String> {
    let mut out: HashSet<String> = doc
        .get("model_providers")
        .and_then(|i| i.as_table_like())
        .map(|t| t.iter().map(|(k, _)| k.to_string()).collect())
        .unwrap_or_default();
    out.insert(OFFICIAL.to_string());
    out
}

// ===== 模型目录 =====

/// 这次的「默认」：中转默认带上当前连接的目录条目；官方默认；别家（cc-switch 等）占着默认就不接管目录
pub(crate) enum Head {
    Relay(Vec<Value>),
    Official,
    Foreign,
}

fn slug(e: &Value) -> Option<&str> {
    e.get("slug").and_then(|s| s.as_str())
}

fn renamed(mut e: Value, prefix: &str) -> Value {
    let shown = e
        .get("display_name")
        .and_then(|v| v.as_str())
        .or_else(|| slug(&e))
        .unwrap_or_default()
        .to_string();
    e["display_name"] = Value::from(format!("{prefix} · {shown}"));
    e
}

/// 全局目录的条目；None = 不需要 Mesa 接管目录（官方默认且没有要续的中转老对话）
fn build_catalog(head: &Head, doc: &toml_edit::DocumentMut, inp: &Inputs) -> Option<Vec<Value>> {
    let defined = defined_providers(doc);
    let mut out: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push = |e: Value, out: &mut Vec<Value>| {
        if let Some(s) = slug(&e) {
            if out.len() < MAX_ENTRIES && seen.insert(s.to_string()) {
                out.push(e);
            }
        }
    };
    let official = matches!(head, Head::Official);
    match head {
        Head::Foreign => return None,
        Head::Relay(entries) => entries.iter().cloned().for_each(|e| push(e, &mut out)),
        Head::Official => inp.official.iter().cloned().for_each(|e| push(e, &mut out)),
    }
    let head_len = out.len();
    // 中转默认下有官方老对话：官方模型整组带上（客户端在官方对话里还能换别的官方模型）
    if !official && inp.refs.iter().any(|r| r.provider == OFFICIAL) {
        for e in &inp.official {
            push(renamed(e.clone(), "ChatGPT"), &mut out);
        }
    }
    // 共用渠道 custom 的老对话：中转默认下它们走的就是当前连接，模型以当前目录为准；官方默认下补它们用过的模型
    let shared = crate::global_config::CODEX_GLOBAL_PROVIDER;
    let shared_gw = shared_gateway(doc, inp);
    // 同一个模型名在几条连接的老对话里都有：目录按模型名只留一条，显示名就不挂某一条连接的名字
    let mut owners: BTreeMap<&str, HashSet<&str>> = BTreeMap::new();
    for r in &inp.refs {
        if !r.model.is_empty() && r.provider != OFFICIAL {
            owners.entry(r.model.as_str()).or_default().insert(r.provider.as_str());
        }
    }
    let label = |name: &str, model: &str| -> String {
        if owners.get(model).is_some_and(|o| o.len() > 1) {
            "老对话".to_string()
        } else {
            name.to_string()
        }
    };
    for r in &inp.refs {
        if r.model.is_empty() || !defined.contains(&r.provider) {
            continue;
        }
        if provider_id::short_id_from_provider(&r.provider).is_some() {
            if let Some(gw) = inp.gateway_for(&r.provider) {
                push(crate::agents::codex_catalog_entry_for(&label(&gw.name, &r.model), &r.model, Some(&gw.gateway_id)), &mut out);
            }
        } else if r.provider == shared && official {
            let (name, gid) = match shared_gw {
                Some(gw) => (gw.name.as_str(), Some(gw.gateway_id.as_str())),
                None => (shared, None),
            };
            push(crate::agents::codex_catalog_entry_for(&label(name, &r.model), &r.model, gid), &mut out);
        }
    }
    if official && out.len() == head_len {
        return None;
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

/// 共用渠道 custom 现在指着哪条连接（按地址认；认不出就只用渠道名）
fn shared_gateway<'a>(doc: &toml_edit::DocumentMut, inp: &'a Inputs) -> Option<&'a GwLite> {
    let url = doc
        .get("model_providers")?
        .get(crate::global_config::CODEX_GLOBAL_PROVIDER)?
        .get("base_url")?
        .as_str()?;
    inp.gateways.iter().find(|g| g.base_url.trim_end_matches('/') == url.trim_end_matches('/'))
}

/// 路径是不是 Mesa 写的模型目录（每条连接一份的旧口径 `codex-<id>.json`，或全局专用 `codex-global.json`）
pub(crate) fn is_mesa_catalog(path: &str) -> bool {
    let p = path.replace('\\', "/");
    p.contains("/ccode/catalogs/codex-") && p.ends_with(".json")
}

pub(crate) fn is_global_catalog(path: &str) -> bool {
    path.replace('\\', "/").ends_with("/ccode/catalogs/codex-global.json")
}

/// 结果：改后的 config.toml 与要写的目录文件（None = 不写目录）
pub(crate) struct LayerOut {
    pub config: String,
    pub catalog: Option<String>,
}

/// 在（已经按这次默认改好的）config.toml 上加续聊层：补渠道定义，按 head 重建全局目录
pub(crate) fn layer(config: &str, head: &Head, inp: &Inputs) -> Result<LayerOut, String> {
    let mut doc = crate::global_config::parse_toml_doc(Some(config))?;
    patch_providers(&mut doc, inp)?;
    let current = doc.get("model_catalog_json").and_then(|v| v.as_str()).map(str::to_string);
    let catalog = match build_catalog(head, &doc, inp) {
        Some(entries) => {
            doc["model_catalog_json"] = toml_edit::value(inp.catalog_path.to_string_lossy().as_ref());
            let mut text = serde_json::to_string_pretty(&serde_json::json!({ "models": entries }))
                .map_err(|e| e.to_string())?;
            text.push('\n');
            Some(text)
        }
        None => {
            // 别家的目录不动；Mesa 的目录这次用不上就撤掉引用（官方回落 Codex 自己的模型表）
            if !matches!(head, Head::Foreign) && current.as_deref().is_some_and(is_mesa_catalog) {
                doc.remove("model_catalog_json");
            }
            None
        }
    };
    Ok(LayerOut { config: doc.to_string(), catalog })
}

/// 按磁盘现状判断默认是谁（「补齐」与启动刷新用；设为全局时调用方自己知道）
pub(crate) fn disk_head(doc: &toml_edit::DocumentMut, relay_head: impl FnOnce() -> Option<Vec<Value>>) -> Head {
    let shared = crate::global_config::CODEX_GLOBAL_PROVIDER;
    match doc.get("model_provider").and_then(|v| v.as_str()) {
        None => Head::Official,
        Some(p) if p == OFFICIAL => Head::Official,
        Some(p) if p == shared => {
            let mesa = doc
                .get("model_providers")
                .and_then(|t| t.get(shared))
                .is_some_and(is_mesa_block);
            match (mesa, relay_head()) {
                (true, Some(entries)) => Head::Relay(entries),
                _ => Head::Foreign,
            }
        }
        Some(_) => Head::Foreign,
    }
}

/// 当前全局连接的目录条目（设为全局写的那一组，排在全局目录最前）
pub(crate) fn relay_head_entries(profile: &Profile) -> Vec<Value> {
    crate::agents::codex_catalog_json_for(&profile.name, &profile.models, profile.gateway_id.as_deref())
        .get("models")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default()
}

// ===== 体检 =====

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContinuityDto {
    /// 渠道没定义、客户端打不开的对话数（补齐能救的）
    pub missing_provider_threads: u32,
    /// 模型不在模型目录里、客户端报「This model isn't available」的对话数（补齐能救的）
    pub missing_model_threads: u32,
    /// 补不了的：连接已删除或旧版 Mesa 的 `ccode` 渠道（客户端里打开时「在 Codex 客户端打开」可选连接补写）
    pub unfixable_threads: u32,
    /// Mesa 以前写下、还存着明文密钥的渠道定义块个数（补齐时改成从 Mesa 现取）
    pub plaintext_blocks: u32,
    /// 随包 helper 找不到：补不了渠道定义
    pub helper_missing: bool,
}

fn catalog_slugs(path: &str) -> HashSet<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("models").and_then(|m| m.as_array()).cloned())
        .map(|ms| ms.iter().filter_map(|e| slug(e).map(str::to_string)).collect())
        .unwrap_or_default()
}

/// 只读体检：对着「补齐」会做的事数一数
pub(crate) fn check(config: &str, head: &Head, inp: &Inputs) -> Result<ContinuityDto, String> {
    let before = crate::global_config::parse_toml_doc(Some(config))?;
    let defined_before = defined_providers(&before);
    let out = layer(config, head, inp)?;
    let after = crate::global_config::parse_toml_doc(Some(&out.config))?;
    let defined_after = defined_providers(&after);
    // 模型目录：补齐前客户端看见的（Mesa 目录读文件，没有目录 = Codex 自己的表，只认得官方模型）与补齐后的
    let slugs_before: Option<HashSet<String>> = before
        .get("model_catalog_json")
        .and_then(|v| v.as_str())
        .map(catalog_slugs);
    let official_slugs: HashSet<String> =
        inp.official.iter().filter_map(|e| slug(e).map(str::to_string)).collect();
    let slugs_after: Option<HashSet<String>> = out.catalog.as_deref().map(|t| {
        serde_json::from_str::<Value>(t)
            .ok()
            .and_then(|v| v.get("models").and_then(|m| m.as_array()).cloned())
            .map(|ms| ms.iter().filter_map(|e| slug(e).map(str::to_string)).collect())
            .unwrap_or_default()
    });
    let visible = |set: &Option<HashSet<String>>, m: &str| match set {
        Some(s) => s.contains(m),
        None => official_slugs.contains(m),
    };
    let mut dto = ContinuityDto { helper_missing: inp.helper.is_none(), ..Default::default() };
    for r in &inp.refs {
        if !defined_before.contains(&r.provider) {
            if defined_after.contains(&r.provider) {
                dto.missing_provider_threads += r.threads;
            } else if provider_id::is_ccode_provider(&r.provider) {
                dto.unfixable_threads += r.threads;
            }
            continue;
        }
        // 共用渠道在中转默认下走当前连接，模型以当前目录为准；目录外的模型不算（客户端会让换一个）
        if r.model.is_empty() || (r.provider == crate::global_config::CODEX_GLOBAL_PROVIDER && matches!(head, Head::Relay(_))) {
            continue;
        }
        let after_ok = match &slugs_after {
            Some(s) => s.contains(&r.model),
            None => !after.contains_key("model_catalog_json") && official_slugs.contains(&r.model),
        };
        if !visible(&slugs_before, &r.model) && after_ok {
            dto.missing_model_threads += r.threads;
        }
    }
    if let Some(t) = before.get("model_providers").and_then(|i| i.as_table_like()) {
        dto.plaintext_blocks = t
            .iter()
            .filter(|(k, item)| {
                provider_id::short_id_from_provider(k).is_some()
                    && is_mesa_block(item)
                    && item.get("experimental_bearer_token").is_some()
                    && inp.helper.is_some()
                    && inp.gateway_for(k).is_some()
            })
            .count() as u32;
    }
    Ok(dto)
}

/// 启动时刷新 Mesa 自己的全局目录文件（不碰 config.toml）：官方模型表随 Codex 升级会变，冻结的旧表会让新模型选不到。
/// 只在 config.toml 正指着 `codex-global.json` 时做；顺带把 helper 拷贝换成这一版
pub(crate) fn refresh_on_startup(store: &crate::profiles::ProfileStore) {
    let Some(home) = crate::dirs::home_dir() else { return };
    let codex_dir = crate::global_config::codex_dir(&home);
    let Ok(text) = std::fs::read_to_string(codex_dir.join("config.toml")) else { return };
    let Ok(doc) = crate::global_config::parse_toml_doc(Some(&text)) else { return };
    let pointer = doc.get("model_catalog_json").and_then(|v| v.as_str()).map(str::to_string);
    let has_auth_blocks = doc
        .get("model_providers")
        .and_then(|i| i.as_table_like())
        .is_some_and(|t| t.iter().any(|(_, item)| is_mesa_block(item) && item.get("auth").is_some()));
    if has_auth_blocks {
        let _ = stable_helper();
    }
    let Some(pointer) = pointer.filter(|p| is_global_catalog(p)) else { return };
    let profiles = store.list().unwrap_or_default();
    let Ok(inp) = Inputs::gather(&codex_dir, &profiles) else { return };
    let head = disk_head(&doc, || {
        let id = crate::settings::read_current().active_global_profiles?.get("codex").cloned()?;
        let p = crate::global_config::profile_for_write(store, &id).ok()?;
        Some(relay_head_entries(&p))
    });
    // 只刷目录文件：渠道定义的增减要用户点了才写
    let mut no_new_blocks = inp;
    no_new_blocks.helper = None;
    let Ok(out) = layer(&text, &head, &no_new_blocks) else { return };
    if let Some(catalog) = out.catalog {
        let same = std::fs::read_to_string(&pointer).is_ok_and(|old| old == catalog);
        if !same {
            if let Err(e) = crate::profiles::atomic_write(Path::new(&pointer), &catalog) {
                crate::logbuf::record("warn", "codex-continuity", &format!("刷新模型目录失败: {e}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gw(id: &str, name: &str) -> GwLite {
        GwLite {
            gateway_id: id.into(),
            name: name.into(),
            base_url: format!("https://{name}.example.com/v1"),
            header_env: BTreeMap::new(),
            timeout_secs: None,
        }
    }

    fn r(provider: &str, model: &str, threads: u32) -> ThreadRef {
        ThreadRef { provider: provider.into(), model: model.into(), threads }
    }

    fn official(slug: &str) -> Value {
        serde_json::json!({ "slug": slug, "display_name": slug.to_uppercase(), "visibility": "list" })
    }

    fn inputs(refs: Vec<ThreadRef>) -> Inputs {
        Inputs {
            refs,
            gateways: vec![gw("a1b2c3d4-0000", "relayA"), gw("bbbbbbbb-0000", "relayB")],
            helper: Some(PathBuf::from("/cfg/ccode/bin/mesa_helper")),
            official: vec![official("gpt-6-luna"), official("gpt-5.6-terra")],
            catalog_path: PathBuf::from("/cfg/ccode/catalogs/codex-global.json"),
        }
    }

    fn head_entry(slug: &str) -> Value {
        serde_json::json!({ "slug": slug, "display_name": format!("当前 · {slug}") })
    }

    fn slugs(text: &str) -> Vec<String> {
        let v: Value = serde_json::from_str(text).unwrap();
        v["models"].as_array().unwrap().iter().map(|e| e["slug"].as_str().unwrap().to_string()).collect()
    }

    const RELAY_DISK: &str = "model_provider = \"custom\"\nmodel = \"ds\"\nmodel_catalog_json = \"/cfg/ccode/catalogs/codex-global.json\"\n\n[model_providers.custom]\nname = \"Mesa\"\nbase_url = \"https://relayA.example.com/v1\"\n";

    #[test]
    fn relay_default_registers_thread_providers_with_auth_command_not_plaintext() {
        let inp = inputs(vec![r("ccode-a1b2c3d4", "glm", 3), r("ccode-99999999", "x", 1), r("ccode", "y", 1)]);
        let out = layer(RELAY_DISK, &Head::Relay(vec![head_entry("ds")]), &inp).unwrap();
        let doc: toml_edit::DocumentMut = out.config.parse().unwrap();
        let blk = &doc["model_providers"]["ccode-a1b2c3d4"];
        assert_eq!(blk["base_url"].as_str(), Some("https://relayA.example.com/v1"));
        assert_eq!(blk["auth"]["command"].as_str(), Some("/cfg/ccode/bin/mesa_helper"));
        let args: Vec<_> = blk["auth"]["args"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(args, ["codex-token", "a1b2c3d4-0000"]);
        assert!(blk.get("experimental_bearer_token").is_none() && blk.get("env_key").is_none());
        // 认不出网关的（连接删了）与旧版 ccode 不补
        assert!(doc["model_providers"].get("ccode-99999999").is_none());
        assert!(doc["model_providers"].get("ccode").is_none());
        // 默认不动
        assert_eq!(doc["model_provider"].as_str(), Some("custom"));
        assert_eq!(slugs(out.catalog.as_deref().unwrap()), ["ds", "glm"]);
    }

    #[test]
    fn relay_default_keeps_official_threads_choosable() {
        let inp = inputs(vec![r("openai", "gpt-6-luna", 2)]);
        let out = layer(RELAY_DISK, &Head::Relay(vec![head_entry("ds")]), &inp).unwrap();
        let cat: Value = serde_json::from_str(out.catalog.as_deref().unwrap()).unwrap();
        assert_eq!(slugs(out.catalog.as_deref().unwrap()), ["ds", "gpt-6-luna", "gpt-5.6-terra"]);
        assert_eq!(cat["models"][1]["display_name"].as_str(), Some("ChatGPT · GPT-6-LUNA"));
    }

    #[test]
    fn model_shared_by_several_connections_is_not_labelled_with_one_of_them() {
        let inp = inputs(vec![r("ccode-a1b2c3d4", "ds-flash", 3), r("ccode-bbbbbbbb", "ds-flash", 1), r("ccode-bbbbbbbb", "only-b", 1)]);
        let out = layer(RELAY_DISK, &Head::Relay(vec![head_entry("ds")]), &inp).unwrap();
        let cat: Value = serde_json::from_str(out.catalog.as_deref().unwrap()).unwrap();
        assert_eq!(cat["models"][1]["display_name"].as_str(), Some("老对话 · ds-flash"));
        assert_eq!(cat["models"][2]["display_name"].as_str(), Some("relayB · only-b"));
    }

    #[test]
    fn mesa_plaintext_block_is_migrated_user_block_left_alone() {
        let disk = format!(
            "{RELAY_DISK}\n[model_providers.ccode-a1b2c3d4]\nname = \"Mesa\"\nbase_url = \"https://old\"\nrequires_openai_auth = false\nexperimental_bearer_token = \"sk-plain\"\n\n[model_providers.ccode-bbbbbbbb]\nname = \"mine\"\nexperimental_bearer_token = \"sk-user\"\n"
        );
        let inp = inputs(vec![r("ccode-bbbbbbbb", "m", 1)]);
        let before = check(&disk, &Head::Relay(vec![head_entry("ds")]), &inp).unwrap();
        assert_eq!(before.plaintext_blocks, 1);
        let out = layer(&disk, &Head::Relay(vec![head_entry("ds")]), &inp).unwrap();
        assert!(!out.config.contains("sk-plain"));
        assert!(out.config.contains("sk-user"), "用户自己写的块原样留着");
    }

    #[test]
    fn official_default_without_relay_threads_does_not_take_over_catalog() {
        let disk = "model_catalog_json = \"/cfg/ccode/catalogs/codex-global.json\"\n";
        let inp = inputs(vec![r("openai", "gpt-6-luna", 5)]);
        let out = layer(disk, &Head::Official, &inp).unwrap();
        assert!(out.catalog.is_none());
        assert!(!out.config.contains("model_catalog_json"));
        // 别人的目录不动
        let foreign = "model_catalog_json = \"/x/cc-switch-model-catalog.json\"\n";
        assert!(layer(foreign, &Head::Official, &inp).unwrap().config.contains("cc-switch"));
    }

    #[test]
    fn official_default_with_relay_threads_lists_official_then_their_models() {
        let disk = "[model_providers.custom]\nname = \"Mesa\"\nbase_url = \"https://relayB.example.com/v1\"\n";
        let inp = inputs(vec![r("custom", "gpt-5.6-sol", 4), r("ccode-a1b2c3d4", "glm", 2), r("openai", "gpt-6-luna", 1)]);
        let out = layer(disk, &Head::Official, &inp).unwrap();
        assert_eq!(slugs(out.catalog.as_deref().unwrap()), ["gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "glm"]);
        let cat: Value = serde_json::from_str(out.catalog.as_deref().unwrap()).unwrap();
        assert!(cat["models"][2]["display_name"].as_str().unwrap().starts_with("relayB · "));
        assert!(out.config.contains("model_catalog_json"));
        assert!(!out.config.contains("model_provider ="), "官方默认不写 model_provider");
    }

    #[test]
    fn foreign_default_only_gets_provider_blocks() {
        let disk = "model_provider = \"custom\"\nmodel_catalog_json = \"/x/cc-switch-model-catalog.json\"\n[model_providers.custom]\nname = \"cc-switch\"\n";
        let inp = inputs(vec![r("ccode-a1b2c3d4", "glm", 1)]);
        let out = layer(disk, &Head::Foreign, &inp).unwrap();
        assert!(out.catalog.is_none());
        assert!(out.config.contains("cc-switch-model-catalog"));
        assert!(out.config.contains("[model_providers.ccode-a1b2c3d4]"));
    }

    #[test]
    fn check_counts_what_the_fix_would_rescue() {
        // 截图里的两种：官方老对话的模型不在中转目录里、Mesa 开的对话渠道没定义
        let dir = std::env::temp_dir().join(format!("ccode-cont-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cat = dir.join("ccode/catalogs/codex-global.json");
        std::fs::create_dir_all(cat.parent().unwrap()).unwrap();
        std::fs::write(&cat, serde_json::json!({ "models": [head_entry("ds")] }).to_string()).unwrap();
        let disk = format!(
            "model_provider = \"custom\"\nmodel_catalog_json = \"{}\"\n[model_providers.custom]\nname = \"Mesa\"\n",
            cat.to_string_lossy().replace('\\', "/")
        );
        let mut inp = inputs(vec![r("openai", "gpt-6-luna", 4), r("ccode-a1b2c3d4", "glm", 7), r("ccode-99999999", "z", 2), r("custom", "old", 3)]);
        inp.catalog_path = cat.clone();
        let dto = check(&disk, &Head::Relay(vec![head_entry("ds")]), &inp).unwrap();
        assert_eq!(dto.missing_provider_threads, 7);
        assert_eq!(dto.missing_model_threads, 4);
        assert_eq!(dto.unfixable_threads, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_helper_means_no_blocks_but_catalog_still_merges() {
        let mut inp = inputs(vec![r("ccode-a1b2c3d4", "glm", 1), r("openai", "gpt-6-luna", 1)]);
        inp.helper = None;
        let out = layer(RELAY_DISK, &Head::Relay(vec![head_entry("ds")]), &inp).unwrap();
        assert!(!out.config.contains("ccode-a1b2c3d4"));
        // 渠道没定义，它的模型不进目录
        assert_eq!(slugs(out.catalog.as_deref().unwrap()), ["ds", "gpt-6-luna", "gpt-5.6-terra"]);
    }

    /// 真机干跑（不进 CI）：在拷贝出来的 Codex 目录上算续聊层并写回那个目录，再用真 codex 核对。
    /// MESA_E2E_CODEX_HOME=拷贝目录（config.toml / state_N.sqlite / models_cache.json / auth.json）
    /// MESA_E2E_GWS=`网关id|名字|地址;…`  MESA_E2E_HELPER=helper 路径
    #[test]
    #[ignore]
    fn e2e_dry_run_on_copied_codex_home() {
        let dir = PathBuf::from(std::env::var("MESA_E2E_CODEX_HOME").expect("MESA_E2E_CODEX_HOME"));
        let gateways = std::env::var("MESA_E2E_GWS")
            .expect("MESA_E2E_GWS")
            .split(';')
            .filter(|s| !s.is_empty())
            .map(|s| {
                let f: Vec<&str> = s.split('|').collect();
                GwLite { gateway_id: f[0].into(), name: f[1].into(), base_url: f[2].into(), header_env: BTreeMap::new(), timeout_secs: None }
            })
            .collect();
        let inp = Inputs {
            refs: read_thread_refs(&dir),
            gateways,
            helper: Some(PathBuf::from(std::env::var("MESA_E2E_HELPER").expect("MESA_E2E_HELPER"))),
            official: official_entries(&dir),
            catalog_path: dir.join("ccode/catalogs/codex-global.json"),
        };
        let text = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        let doc = crate::global_config::parse_toml_doc(Some(&text)).unwrap();
        let current: Option<Vec<Value>> = doc
            .get("model_catalog_json")
            .and_then(|v| v.as_str())
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["models"].as_array().cloned());
        let head = disk_head(&doc, || current);
        println!("head = {}", match head { Head::Relay(_) => "relay", Head::Official => "official", Head::Foreign => "foreign" });
        println!("check = {:?}", check(&text, &head, &inp).unwrap());
        let out = layer(&text, &head, &inp).unwrap();
        if let Some(cat) = &out.catalog {
            std::fs::create_dir_all(inp.catalog_path.parent().unwrap()).unwrap();
            std::fs::write(&inp.catalog_path, cat).unwrap();
        }
        std::fs::write(dir.join("config.toml"), &out.config).unwrap();
        println!("after = {:?}", check(&out.config, &head, &inp).unwrap());
    }

    #[test]
    fn catalog_path_recognition() {
        assert!(is_mesa_catalog("/Users/x/Library/Application Support/ccode/catalogs/codex-f65b.json"));
        assert!(is_mesa_catalog(r"C:\Users\x\AppData\Roaming\ccode\catalogs\codex-global.json"));
        assert!(is_global_catalog(r"C:\Users\x\AppData\Roaming\ccode\catalogs\codex-global.json"));
        assert!(!is_global_catalog("/a/ccode/catalogs/codex-p1.json"));
        assert!(!is_mesa_catalog("/x/cc-switch-model-catalog.json"));
    }
}
