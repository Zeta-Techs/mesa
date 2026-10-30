//! MCP server 清单与一键分发（规格单一出处 = docs/agent-integration-matrix.md §10，勿凭印象改字段）。
//!
//! 统一模型（Mesa 自有清单 <config>/ccode/mcp-servers.json）→ 各家配置文件的映射层。
//! 分发纪律（红线，见 §10.4）：
//! - 只写用户级配置（项目级在 claude/qwen/cursor/codebuddy 有审批闸，gemini/qwen 未信任目录忽略）；
//! - 目标文件多是混合状态文件，一律读-改-写一个键/段 + 写前备份 + 原子写，绝不整文件覆盖；
//! - 密钥不落明文：清单里 env/header 值允许 `$VAR`/`${VAR}` 引用形式，映射时转各家的间接引用字段；
//!   引用的值可存 mcp-keys.json（0600），启动与体检时注入，清单不落明文；
//! - 企业管理层存在即拒写（claude managed-mcp.json / opencode managed 目录）。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// ===== 统一清单模型 =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEnvPair {
    pub key: String,
    /// 字面值，或 `$VAR` / `${VAR}` 引用环境变量（分发时按各家语法转写，不落明文密钥）
    pub value: String,
}

/// 已存 MCP 密钥的展示用尾号（`list_mcp_env_secrets`）；不含密钥本体
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEnvSecretHintDto {
    pub name: String,
    /// 如 `···Y41`
    pub hint: String,
}

/// 最近一次连通性体检的沉淀（随清单落盘；DTO 直出前端，error 文案同 check_mcp_server 口径）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLastCheck {
    /// ISO 时间戳（sessions::now_iso 同口径）
    pub at: String,
    pub ok: bool,
    pub latency_ms: u64,
    /// 失败原因；成功为 null
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDto {
    pub id: String,
    /// server 名：各家交集取 [A-Za-z0-9-]（gemini 下划线会让 policy 引擎失效；claude/codex 允许但不取）
    pub name: String,
    /// "stdio" | "remote"
    pub kind: String,
    // stdio
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 可空串；claude/codebuddy/cursor 不写 cwd（未核实支持，matrix §10.2）
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub env: Vec<McpEnvPair>,
    // remote
    pub url: String,
    #[serde(default)]
    pub headers: Vec<McpEnvPair>,
    /// 分发开关（agent id → 是否分发）
    #[serde(default)]
    pub apps: HashMap<String, bool>,
    /// 全局启用开关（v3.93，matrix §10.2 预留字段落地）：false = 从所有 agent 移除条目
    /// 但保留 apps 映射，重新启用时按原样重投；旧清单无此字段，serde 默认 true
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 来源标记：ccode = 本应用新建；imported:<agent> = 从该 agent 收编；imported:json = 粘贴导入。
    /// 旧清单无此字段反序列化为空串 = 来源未知，删除分流按收编条目对待（宁可少删不可错删）
    #[serde(default)]
    pub origin: String,
    /// 慢启动 server 的启动超时声明（毫秒）：收编 codex/grok 的 startup_timeout_sec 自动带入，
    /// 也可在编辑表单手调；只被体检消费（check_stdio 按 clamp(8s, 30s) 生效），
    /// 分发映射不写它（matrix §10.2：别家无实证等价字段）
    #[serde(default)]
    pub startup_timeout_ms: Option<u64>,
    /// 最近一次体检沉淀（单条/批量检测都会更新；旧清单无此字段）
    #[serde(default)]
    pub last_check: Option<McpLastCheck>,
}

fn default_enabled() -> bool {
    true
}

// ===== 清单存储 =====

// 测试接缝（同 coding.rs TEST_WT_ROOT 先例）：thread_local 只影响设置它的测试线程
#[cfg(test)]
thread_local! {
    static TEST_STORE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
    static TEST_HOME: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
    static TEST_BACKUP: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

fn store_path() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(p) = TEST_STORE.with(|c| c.borrow().clone()) {
        return Ok(p);
    }
    Ok(crate::dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("mcp-servers.json"))
}

fn read_store() -> Result<Vec<McpServerDto>, String> {
    let path = store_path()?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("MCP 清单损坏: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("读取 MCP 清单失败: {e}")),
    }
}

fn write_store(list: &[McpServerDto]) -> Result<(), String> {
    let path = store_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    atomic_write_0600(&path, &text)
}

/// 清单文件 0600 原子写：可能含用户误填的明文密钥，权限与 keys.json 同口径
///（先收窄 tmp 权限再 rename，消除 0644 窗口；Windows 无 0600 语义由目录 ACL 控制）
fn atomic_write_0600(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    std::fs::write(&tmp, text).map_err(|e| format!("写入 {} 失败: {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置权限失败: {e}"))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("替换 {} 失败: {e}", path.display()))
}

// ===== MCP 密钥（mcp-keys.json）：表单填写，清单只留 ${VAR}，启动/体检时注入 =====

static MCP_KEYS_MUTEX: Mutex<()> = Mutex::new(());

struct McpKeysGuard {
    _process: std::sync::MutexGuard<'static, ()>,
    _file: Option<std::fs::File>,
}

fn mcp_keys_path() -> Result<PathBuf, String> {
    Ok(store_path()?.with_file_name("mcp-keys.json"))
}

fn mcp_keys_guard() -> Result<McpKeysGuard, String> {
    let process = MCP_KEYS_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    #[cfg(test)]
    if TEST_STORE.with(|c| c.borrow().is_some()) {
        return Ok(McpKeysGuard {
            _process: process,
            _file: None,
        });
    }
    let file = crate::storage::config_lock("mcp-keys")?;
    Ok(McpKeysGuard {
        _process: process,
        _file: Some(file),
    })
}

fn read_mcp_keys_unlocked() -> Result<HashMap<String, String>, String> {
    #[cfg(test)]
    if TEST_STORE.with(|c| c.borrow().is_none()) {
        return Ok(HashMap::new());
    }
    let path = mcp_keys_path()?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(format!("读取 MCP 密钥失败: {e}")),
    };
    serde_json::from_str(&text).map_err(|e| {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup = path.with_file_name(format!("mcp-keys.json.corrupt-{ts}"));
        match crate::storage::atomic_write(&backup, text.as_bytes(), true) {
            Ok(()) => format!(
                "mcp-keys.json 已损坏，原件已保留并备份为 {}: {e}",
                backup.display()
            ),
            Err(error) => format!("mcp-keys.json 已损坏，原件已保留；备份失败：{error}: {e}"),
        }
    })
}

fn write_mcp_keys_unlocked(keys: &HashMap<String, String>) -> Result<(), String> {
    #[cfg(test)]
    if TEST_STORE.with(|c| c.borrow().is_none()) {
        return Err("测试写入 mcp-keys 必须先设 TEST_STORE".into());
    }
    let path = mcp_keys_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(keys).map_err(|e| e.to_string())?;
    crate::storage::atomic_write(&path, text.as_bytes(), true)
}

fn read_mcp_keys() -> Result<HashMap<String, String>, String> {
    let _g = mcp_keys_guard()?;
    read_mcp_keys_unlocked()
}

fn merge_mcp_keys(updates: HashMap<String, String>) -> Result<(), String> {
    let _g = mcp_keys_guard()?;
    let mut keys = read_mcp_keys_unlocked()?;
    for (name, value) in updates {
        validate_mcp_secret_name(&name)?;
        if value.is_empty() {
            continue;
        }
        keys.insert(name, value);
    }
    write_mcp_keys_unlocked(&keys)
}

fn valid_posix_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 把密钥本体当成了变量名（用户把 ak_… 填进 `${}`）
fn env_name_looks_like_secret(name: &str) -> bool {
    if crate::sessions::common_secret_token(name).is_some() {
        return true;
    }
    let n = name.trim();
    n.len() >= 16 && n.starts_with("ak_") && n[3..].chars().all(|c| c.is_ascii_alphanumeric())
}

fn validate_mcp_secret_name(name: &str) -> Result<(), String> {
    if !valid_posix_env_name(name) {
        return Err(format!(
            "环境变量名不合法：{name}（只接受字母/数字/下划线，且不能以数字开头）"
        ));
    }
    if env_name_looks_like_secret(name) {
        return Err(
            "变量名看起来是密钥本身。请把密钥填到密钥栏，引用写成 ${VAR} 这种名字（不要把密钥写进变量名）"
                .into(),
        );
    }
    Ok(())
}

fn secret_hint(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() < 4 {
        return "已保存".into();
    }
    format!("···{}", chars[chars.len() - 4..].iter().collect::<String>())
}

/// 引用里误把密钥当变量名：Consensus 的 Authorization Bearer 自动改回
/// `${CONSENSUS_API_KEY}` 并把密钥收进 mcp-keys；其他条目明确报错。
fn rewrite_pasted_secret_refs(
    server: &mut McpServerDto,
    captured: &mut HashMap<String, String>,
) -> Result<(), String> {
    for pair in server.env.iter_mut().chain(server.headers.iter_mut()) {
        let refs = extract_env_refs(&pair.value);
        for name in refs {
            if !env_name_looks_like_secret(&name) {
                continue;
            }
            let is_consensus = server.name.eq_ignore_ascii_case("consensus");
            let is_auth = pair.key.eq_ignore_ascii_case("authorization");
            let is_bearer = pair
                .value
                .trim()
                .to_ascii_lowercase()
                .starts_with("bearer ");
            if is_consensus && is_auth && is_bearer {
                captured
                    .entry("CONSENSUS_API_KEY".into())
                    .or_insert(name.clone());
                pair.value = "Bearer ${CONSENSUS_API_KEY}".into();
                continue;
            }
            return Err(format!(
                "「{}」把密钥当成了环境变量名。请把密钥填到密钥栏，引用写成 ${{VAR}}（变量名不是密钥本身）",
                pair.key
            ));
        }
    }
    Ok(())
}

/// 解析 MCP 引用：先查 mcp-keys.json，再查进程环境。空值算未设置。
fn resolve_env_value(name: &str) -> Option<String> {
    if let Ok(keys) = read_mcp_keys() {
        if let Some(v) = keys.get(name) {
            if !v.is_empty() {
                return Some(v.clone());
            }
        }
    }
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// Agent 启动注入：把 mcp-keys.json 写进子进程环境，供各家 `${VAR}` / bearer_token_env_var 展开。
/// 读失败返回空表，不阻断启动。
pub fn spawn_env_secrets() -> HashMap<String, String> {
    read_mcp_keys()
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .collect()
}

/// 脱敏用：mcp-keys 里长度 ≥8 的值。失败当空，不在展示路径改名密钥文件。
pub(crate) fn stored_mcp_secrets() -> Vec<String> {
    read_mcp_keys()
        .unwrap_or_default()
        .into_values()
        .filter(|v| v.chars().count() >= 8)
        .collect()
}

/// server 名校验：各家交集 [A-Za-z0-9-]（gemini 下划线会让 policy 引擎静默失效）
fn validate_server_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("名称只能包含字母、数字、连字符（1-64 字符）".into());
    }
    if name.contains('_') {
        return Err("名称不要含下划线（gemini 的策略引擎按下划线切分，会静默失效）".into());
    }
    Ok(())
}

// ===== JSONC 容错读（gemini/qwen/opencode/codebuddy 容忍注释与尾逗号） =====

/// 去注释 + 尾逗号（字符串/转义状态机，不动字符串内容）；hooks.rs 的 JSONC 容错读也复用。
/// 开头的 UTF-8 BOM 一并去掉：PowerShell 5.1 `Set-Content -Encoding UTF8`、旧记事本存的
/// settings.json 带 BOM，serde_json 不认，会被误判成「配置损坏」拒写。
pub(crate) fn strip_jsonc(text: &str) -> String {
    let text = strip_bom(text);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_str = false;
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if c == '\\' {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
            }
            _ => out.push(c),
        }
    }
    // 尾逗号：逗号后只剩空白就接 ]/}（按 char 处理，不动多字节字符）
    let chars: Vec<char> = out.chars().collect();
    let mut result = String::with_capacity(out.len());
    let mut i = 0;
    let mut in_str = false;
    while i < chars.len() {
        let c = chars[i];
        if in_str {
            result.push(c);
            if c == '\\' && i + 1 < chars.len() {
                i += 1;
                result.push(chars[i]);
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            result.push('"');
            i += 1;
            continue;
        }
        if c == ',' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == ']' || chars[j] == '}') {
                i += 1; // 丢掉逗号
                continue;
            }
        }
        result.push(c);
        i += 1;
    }
    result
}

/// 去掉开头的 UTF-8 BOM（U+FEFF）。CLI 配置（JSON/TOML）读入后、解析前一律先过这里；
/// 写回时不再带 BOM（两种格式的规范都不要求，各家 CLI 也都能读无 BOM 文件）。
pub(crate) fn strip_bom(text: &str) -> &str {
    text.trim_start_matches('\u{feff}')
}

fn jsonc_read(path: &Path) -> Result<serde_json::Value, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    serde_json::from_str(&strip_jsonc(&text))
        .map_err(|e| format!("{} 解析失败: {e}（已拒写，请先手工修复）", path.display()))
}

// ===== 备份（复用 global_config 的备份根，标签 mcp） =====

fn backup_once(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    #[cfg(test)]
    let dir = match TEST_BACKUP.with(|c| c.borrow().clone()) {
        Some(p) => p,
        None => crate::dirs::config_dir()
            .ok_or("无法确定平台配置目录")?
            .join("ccode")
            .join("backups")
            .join("mcp"),
    };
    #[cfg(not(test))]
    let dir = crate::dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("backups")
        .join("mcp");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".into());
    let dest = dir.join(format!(
        "{}.{}.bak",
        name,
        crate::sessions::now_iso().replace([':', '.'], "-")
    ));
    std::fs::copy(path, &dest).map_err(|e| format!("备份 {} 失败: {e}", path.display()))?;
    Ok(())
}

// ===== env 引用解析 =====

/// `"$VAR"` / `"${VAR}"` → Some("VAR")；其他 → None（字面值）
fn env_ref(value: &str) -> Option<&str> {
    let v = value.trim();
    if let Some(rest) = v.strip_prefix("${") {
        return rest.strip_suffix('}').filter(|s| !s.is_empty());
    }
    v.strip_prefix('$')
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

/// 扫描值里的全部 $VAR / ${VAR} 引用，返回 (字节区间, 变量名)——整值与
/// "Bearer ${X}" 这类内嵌都算，分发转写与探测宿主展开共用这一套引用口径。
/// `$` 后非变量字符（含 `${` 无闭合、孤立 `$`）按字面处理；
/// `$`/`{`/`}`/变量名字符全是 ASCII，字节区间不会切断多字节字符
fn scan_env_refs(value: &str) -> Vec<(std::ops::Range<usize>, String)> {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'$' {
            i += 1;
            continue;
        }
        if bytes.get(i + 1) == Some(&b'{') {
            if let Some(rel) = value[i + 2..].find('}') {
                let name = &value[i + 2..i + 2 + rel];
                if !name.is_empty() {
                    out.push((i..i + 2 + rel + 1, name.to_string()));
                }
                i += 2 + rel + 1;
                continue;
            }
            i += 1;
            continue;
        }
        let start = i + 1;
        let mut end = start;
        while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
            end += 1;
        }
        if end > start {
            out.push((i..end, value[start..end].to_string()));
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

/// 值里的全部引用变量名（scan_env_refs 的名字投影）
fn extract_env_refs(value: &str) -> Vec<String> {
    scan_env_refs(value).into_iter().map(|(_, n)| n).collect()
}

/// 探测注入前的宿主展开：值里所有 $VAR/${VAR} 引用（含 "Bearer ${X}" 内嵌）按宿主
/// 环境展开；任一引用未设置（空值算未设置，与 mcp_missing_env_refs 预检同口径）→
/// Err(缺失变量名清单)，调用方整条不注入并附提示——比把字面 "${X}" 发给 server 诚实
fn expand_host_value(value: &str) -> Result<String, Vec<String>> {
    let spans = scan_env_refs(value);
    if spans.is_empty() {
        return Ok(value.to_string());
    }
    let mut missing: Vec<String> = Vec::new();
    let mut resolved: HashMap<String, String> = HashMap::new();
    for (_, name) in &spans {
        match resolve_env_value(name) {
            Some(v) => {
                resolved.insert(name.clone(), v);
            }
            None => {
                if !missing.contains(name) {
                    missing.push(name.clone());
                }
            }
        }
    }
    if !missing.is_empty() {
        return Err(missing);
    }
    // 单趟重建：按扫描出的区间拼接，避免先替 $A 再替 $AB 互相污染
    let mut out = String::with_capacity(value.len());
    let mut cursor = 0;
    for (range, name) in spans {
        out.push_str(&value[cursor..range.start]);
        out.push_str(&resolved[&name]);
        cursor = range.end;
    }
    out.push_str(&value[cursor..]);
    Ok(out)
}

fn pairs_to_map(pairs: &[McpEnvPair]) -> HashMap<String, String> {
    pairs
        .iter()
        .filter(|p| !p.key.trim().is_empty())
        .map(|p| (p.key.trim().to_string(), p.value.clone()))
        .collect()
}

/// 值里的 $VAR/${VAR} 引用转成目标语法（opencode 用 {env:VAR}，其余保持 ${VAR}）
fn rewrite_refs(value: &str, opencode_style: bool) -> String {
    if !opencode_style {
        return value.to_string();
    }
    let mut out = value.to_string();
    // 只处理整值引用（"Bearer ${X}" 这类内嵌引用 opencode 未核实，保持原样并在文档说明）
    if let Some(name) = env_ref(value) {
        out = format!("{{env:{name}}}");
    }
    out
}

// ===== 各家条目映射（serde_json::Value；codex 单独走 TOML） =====

/// stdio 命令落盘前解析（返回 (命令, 参数)）：
/// 1. 裸名 → 绝对路径（GUI/打包环境 PATH 很短，resolve_binary 候选目录兜底）；
/// 2. 解析结果是 node 系 shim（shebang 为 `#!/usr/bin/env node` 的脚本/symlink，如 npx）→
///    再深一步换成 node 绝对路径 + shim 真实路径作为首参——否则宿主 PATH 没有 node 时
///    照样 spawn ENOENT（shebang 依赖 PATH 里的 node）。解析不到任何一环就保留原样。
fn resolve_command_deep(command: &str, args: &[String]) -> (String, Vec<String>) {
    let name = command.trim();
    let Some(bin) = crate::agents::resolve_binary(name) else {
        return (name.to_string(), args.to_vec());
    };
    // canonicalize 后必须剥 verbatim：`\\?\C:\…\npx.cmd` 写进 claude/codex 配置
    // 部分 CLI 不认，且与前端/其他比较口径分裂。
    let real = crate::paths::canonicalize_plain(&bin)
        .unwrap_or_else(|_| crate::paths::strip_verbatim(bin.clone()));
    #[cfg(windows)]
    if let Some((node, entry)) = crate::process::node_entry_from_cmd_shim(&real) {
        let mut new_args = vec![mcp_path_text(entry)];
        new_args.extend(args.iter().cloned());
        return (mcp_path_text(node), new_args);
    }
    if is_node_shim(&real) {
        if let Some(node) = crate::agents::resolve_binary("node") {
            let mut new_args = vec![mcp_path_text(real)];
            new_args.extend(args.iter().cloned());
            return (mcp_path_text(node), new_args);
        }
    }
    (mcp_path_text(bin), args.to_vec())
}

/// MCP 配置里的路径：剥 Windows verbatim，避免 `\\?\` 落盘。
fn mcp_path_text(path: PathBuf) -> String {
    crate::paths::strip_verbatim(path)
        .to_string_lossy()
        .into_owned()
}

/// 首行 shebang 是 `#!/usr/bin/env node` 的脚本（只读前 128 字节）
fn is_node_shim(path: &Path) -> bool {
    use std::io::Read;
    let mut buf = [0u8; 128];
    let read = std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut buf))
        .unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..read]);
    head.lines()
        .next()
        .is_some_and(|l| l.starts_with("#!") && l.contains("env node"))
}

/// stdio 命令是否是相对路径（./ ../ 及 Windows 反斜杠变体、目录相向前缀）。
/// 相对路径的基准是来源 agent 自己的运行语境（如 codex 插件目录），换个工作目录就找不到
fn is_relative_command(command: &str) -> bool {
    let c = command.trim();
    if c.is_empty() {
        return false;
    }
    let looks_like_path =
        c.contains('/') || c.contains('\\') || (c.len() >= 2 && c.as_bytes()[1] == b':');
    // Unix 形态 `/abs/...` 在 Windows 上 Path::is_absolute 为 false（缺盘符前缀），
    // 但仍不是「随 cwd 漂移」的相对路径，不当成相对路径处理。
    let absolute = Path::new(c).is_absolute() || c.starts_with('/');
    looks_like_path && !absolute
}

/// 相对路径命令的解析结果：绝对路径命令 + 规范化后的工作目录
///（cwd 是相对形态（"." "./x" 等）时改成命中所用的基准目录，保留条目对工作目录的语义；
/// 绝对 cwd 保留原值，空 cwd 不动——原配置没声明工作目录，不替它猜）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpCommandFix {
    pub command: String,
    pub cwd: String,
}

/// 相对路径命令的解析基准目录，按序（命中即停，序位即优先级）：
/// 1. 条目自己声明的 cwd（绝对路径时）——条目自带的运行语境最可信；
/// 2. 来源 agent 的配置家目录（agent_paths 写目标的父目录，尊重 CODEX_HOME 等搬迁变量）；
/// 3. 来源 agent 的已知插件/缓存目录（只放有实证的，没有实证的不放）。
/// 去重靠 paths::path_key（禁字符串前缀比较，AGENTS.md 方言层约定）。
fn relative_resolution_bases(cwd: &str, agent: Option<&str>) -> Vec<PathBuf> {
    let mut bases: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let push = |p: PathBuf, bases: &mut Vec<PathBuf>, seen: &mut HashSet<String>| {
        if seen.insert(crate::paths::path_key(&p.to_string_lossy())) {
            bases.push(p);
        }
    };
    let c = cwd.trim();
    if !c.is_empty() && Path::new(c).is_absolute() {
        push(PathBuf::from(c), &mut bases, &mut seen);
    }
    if let Some(agent) = agent {
        if let Ok((write_target, _)) = agent_paths(agent) {
            if let Some(home) = write_target.parent() {
                push(home.to_path_buf(), &mut bases, &mut seen);
                // 有实证的插件/缓存目录（2026-09-03 实机：ChatGPT 桌面版写入 codex 的
                // [mcp_servers.computer-use] 为 command="./Codex Computer Use.app/…" + cwd="."，
                // 只有以 ~/.codex/computer-use 为工作目录拉起才解析得到；2026-08-17 案例同属
                // codex 插件目录）。其余家未观察到相对路径条目，不放
                if agent == "codex" {
                    push(home.join("computer-use"), &mut bases, &mut seen);
                    push(home.join("plugins"), &mut bases, &mut seen);
                }
            }
        }
    }
    bases
}

/// 相对路径命令 → 绝对路径候选（按基准序，路径去重）。
/// base.join(command) 命中已存在的文件即收；多基准同时命中时序位最前的在前，
/// 收编取首候选，一键修复弹层把全量候选交给用户选。
/// Windows 不补 .exe 猜测：实机案例均为精确相对路径，猜扩展名命中率低且会误导选择
fn resolve_relative_candidates(
    command: &str,
    cwd: &str,
    agent: Option<&str>,
) -> Vec<McpCommandFix> {
    if !is_relative_command(command) {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for base in relative_resolution_bases(cwd, agent) {
        let joined = base.join(command.trim());
        if !joined.is_file() {
            continue;
        }
        // join("./bin/serve") 会保留 "." 分量：canonicalize 落干净绝对路径（顺带解 symlink）；
        // 失败兜底按分量 lexical 归一（去掉 "." 与重复分隔符）
        let resolved = crate::paths::canonicalize_plain(&joined)
            .unwrap_or_else(|_| joined.components().collect());
        let text = mcp_path_text(resolved);
        if !seen.insert(crate::paths::path_key(&text)) {
            continue;
        }
        let c = cwd.trim();
        let normalized_cwd = if !c.is_empty() && !Path::new(c).is_absolute() {
            mcp_path_text(base.clone())
        } else {
            c.to_string()
        };
        out.push(McpCommandFix {
            command: text,
            cwd: normalized_cwd,
        });
    }
    out
}

/// 分发入口的相对路径处理（先解后拦）：先以条目自己的 cwd（绝对时）为基准尝试解析成
/// 绝对路径；解不出维持拒写，文案具体化——比静默写一个必然 ENOENT 的配置诚实
///（2026-09-03 起替代旧的直接拒写，实机案例见 matrix §10.4）
fn resolve_or_reject_relative(server: &McpServerDto) -> Result<String, String> {
    let c = server.command.trim();
    if !is_relative_command(c) {
        return Ok(c.to_string());
    }
    if let Some(fix) = resolve_relative_candidates(c, &server.cwd, None).first() {
        return Ok(fix.command.clone());
    }
    Err(format!(
        "该 server 的命令是相对路径（{c}）且无法确定基准目录，请改为绝对路径（如 /usr/local/bin/xx）后重试"
    ))
}

fn entry_json(server: &McpServerDto, agent: &str) -> Result<serde_json::Value, String> {
    use serde_json::{json, Map, Value};
    let env: Map<String, Value> = pairs_to_map(&server.env)
        .into_iter()
        .map(|(k, v)| (k, Value::String(rewrite_refs(&v, agent == "opencode"))))
        .collect();
    let headers: Map<String, Value> = pairs_to_map(&server.headers)
        .into_iter()
        .map(|(k, v)| (k, Value::String(rewrite_refs(&v, agent == "opencode"))))
        .collect();
    let mut m = Map::new();
    match agent {
        "claude-code" => {
            m.insert(
                "type".into(),
                json!(if server.kind == "stdio" {
                    "stdio"
                } else {
                    "http"
                }),
            );
        }
        "codebuddy" => {
            m.insert(
                "type".into(),
                json!(if server.kind == "stdio" {
                    "stdio"
                } else {
                    "http"
                }),
            );
        }
        "opencode" => {
            m.insert(
                "type".into(),
                json!(if server.kind == "stdio" {
                    "local"
                } else {
                    "remote"
                }),
            );
        }
        _ => {}
    }
    if server.kind == "stdio" {
        if server.command.trim().is_empty() {
            return Err("stdio 类型必须填命令".into());
        }
        // 相对路径先解后拦：解出绝对路径继续分发，解不出拒写（resolve_or_reject_relative）
        let command = resolve_or_reject_relative(server)?;
        let (command, args) = resolve_command_deep(&command, &server.args);
        if agent == "opencode" {
            // opencode：command 是命令+参数合成的一个数组
            let mut cmd = vec![Value::String(command)];
            cmd.extend(args.iter().map(|a| Value::String(a.clone())));
            m.insert("command".into(), Value::Array(cmd));
            if !env.is_empty() {
                m.insert("environment".into(), Value::Object(env)); // 注意不是 env
            }
        } else {
            m.insert("command".into(), json!(command));
            if !args.is_empty() {
                m.insert("args".into(), json!(args));
            }
            if !env.is_empty() {
                if agent == "kimi" {
                    // kimi 无插值：env 引用形式无法表达，拒写比静默失效诚实
                    for p in &server.env {
                        if env_ref(&p.value).is_some() {
                            return Err(format!(
                                "kimi 不支持 env 引用（{}），请填字面值或改用 headers 的 bearerTokenEnvVar",
                                p.key
                            ));
                        }
                    }
                }
                m.insert("env".into(), Value::Object(env));
            }
        }
        // cwd 只写给核实支持的家（claude/codebuddy/cursor 不写，matrix §10.2）
        if !server.cwd.trim().is_empty() && matches!(agent, "gemini" | "qwen" | "opencode" | "kimi")
        {
            m.insert("cwd".into(), json!(server.cwd.trim()));
        }
    } else {
        if server.url.trim().is_empty() {
            return Err("remote 类型必须填 URL".into());
        }
        match agent {
            "gemini" | "qwen" => {
                // remote 一律 httpUrl（url = SSE 已 legacy）
                m.insert("httpUrl".into(), json!(server.url.trim()));
            }
            _ => {
                m.insert("url".into(), json!(server.url.trim()));
            }
        }
        if agent == "kimi" {
            // kimi：Authorization: Bearer $X 引头部 → bearerTokenEnvVar；其余引用不支持
            let mut rest: Map<String, Value> = Map::new();
            for p in &server.headers {
                let key = p.key.trim();
                if key.is_empty() {
                    continue;
                }
                let v = p.value.trim();
                let bearer = v
                    .strip_prefix("Bearer ")
                    .or_else(|| v.strip_prefix("bearer "));
                if key.eq_ignore_ascii_case("authorization") {
                    if let Some(b) = bearer {
                        if let Some(name) = env_ref(b) {
                            m.insert("bearerTokenEnvVar".into(), json!(name));
                            continue;
                        }
                    }
                }
                if env_ref(v).is_some() {
                    return Err(format!("kimi 的 header {key} 不支持引用形式，请填字面值"));
                }
                rest.insert(key.to_string(), json!(p.value));
            }
            if !rest.is_empty() {
                m.insert("headers".into(), Value::Object(rest));
            }
        } else if !headers.is_empty() {
            m.insert("headers".into(), Value::Object(headers));
        }
    }
    Ok(Value::Object(m))
}

/// codex 的 TOML 条目（[mcp_servers.<name>]；env 引用走 env_vars/env_http_headers/bearer_token_env_var）
fn entry_toml(server: &McpServerDto) -> Result<toml_edit::Table, String> {
    let mut t = toml_edit::Table::new();
    if server.kind == "stdio" {
        if server.command.trim().is_empty() {
            return Err("stdio 类型必须填命令".into());
        }
        // 相对路径先解后拦：解出绝对路径继续分发，解不出拒写（resolve_or_reject_relative）
        let command = resolve_or_reject_relative(server)?;
        let (command, args) = resolve_command_deep(&command, &server.args);
        t["command"] = toml_edit::value(command.as_str());
        if !args.is_empty() {
            let mut arr = toml_edit::Array::new();
            for a in &args {
                arr.push(a.as_str());
            }
            t["args"] = toml_edit::value(arr);
        }
        let mut env = toml_edit::Table::new();
        let mut env_vars = toml_edit::Array::new();
        for p in &server.env {
            let key = p.key.trim();
            if key.is_empty() {
                continue;
            }
            if let Some(name) = env_ref(&p.value) {
                // codex 无通用插值（matrix §10.3）：env_vars 只是同名转发白名单，
                // 改名引用（键 TARGET_TOKEN 引用 $SOURCE_TOKEN）表达不了——静默丢键名
                // 会让 server 读到空变量，明确拒写并给出修法
                if name != key {
                    return Err(format!(
                        "codex 不支持环境变量改名引用：「{key}」引用了 ${name}，但它的 env_vars 只能同名转发。请把键名改成 {name}，或填字面值"
                    ));
                }
                env_vars.push(name); // codex 无插值：引用 → env_vars 白名单转发
            } else {
                env[key] = toml_edit::value(p.value.as_str());
            }
        }
        if !env.is_empty() {
            t["env"] = toml_edit::Item::Table(env);
        }
        if !env_vars.is_empty() {
            t["env_vars"] = toml_edit::value(env_vars);
        }
        if !server.cwd.trim().is_empty() {
            t["cwd"] = toml_edit::value(server.cwd.trim());
        }
    } else {
        if server.url.trim().is_empty() {
            return Err("remote 类型必须填 URL".into());
        }
        t["url"] = toml_edit::value(server.url.trim());
        let mut headers = toml_edit::Table::new();
        let mut env_headers = toml_edit::Table::new();
        for p in &server.headers {
            let key = p.key.trim();
            if key.is_empty() {
                continue;
            }
            let v = p.value.trim();
            let bearer = v
                .strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "));
            if key.eq_ignore_ascii_case("authorization") {
                if let Some(b) = bearer {
                    if let Some(name) = env_ref(b) {
                        t["bearer_token_env_var"] = toml_edit::value(name);
                        continue;
                    }
                }
            }
            if let Some(name) = env_ref(v) {
                env_headers[key] = toml_edit::value(name);
            } else {
                headers[key] = toml_edit::value(p.value.as_str());
            }
        }
        if !headers.is_empty() {
            t["http_headers"] = toml_edit::Item::Table(headers);
        }
        if !env_headers.is_empty() {
            t["env_http_headers"] = toml_edit::Item::Table(env_headers);
        }
        // 远程 HTTP 不要默认写长 startup_timeout_sec：Codex 启动/恢复会等满超时才画 TUI。
        // Consensus 握手常挂死，20s×两台学术 MCP 就是恢复时黑屏半分钟。只在用户显式声明时写入。
        if let Some(ms) = server.startup_timeout_ms {
            let secs = ((ms / 1000) as i64).clamp(8, 30);
            t["startup_timeout_sec"] = toml_edit::value(secs);
        }
    }
    Ok(t)
}

// ===== 各家目标文件解析（尊重整体搬迁环境变量；三平台由 home 推导） =====

fn home() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(p) = TEST_HOME.with(|c| c.borrow().clone()) {
        return Ok(p);
    }
    crate::dirs::home_dir().ok_or_else(|| "无法确定用户目录".to_string())
}

fn env_home(var: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// 返回 (写目标, 读候选列表)——codebuddy 有回退链，其他家读=写
fn agent_paths(agent: &str) -> Result<(PathBuf, Vec<PathBuf>), String> {
    let home = home()?;
    Ok(match agent {
        // ~/.claude.json 是高频共享状态文件（user scope）；managed-mcp.json 存在即拒写（§10.4）
        "claude-code" => {
            let base = env_home("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.clone());
            let p = base.join(".claude.json");
            (p.clone(), vec![p])
        }
        "codex" => {
            let base = crate::agent_specs::agent_config_root_with(agent, &home, &env_home).ok_or("未知 agent")?;
            let p = base.join("config.toml");
            (p.clone(), vec![p])
        }
        "gemini" => {
            // GEMINI_CLI_HOME 顶替的是家目录，配置在其下 .gemini/（见 agent_config_root_with）
            let base = crate::agent_specs::agent_config_root_with(agent, &home, &env_home).ok_or("未知 agent")?;
            let p = base.join("settings.json");
            (p.clone(), vec![p])
        }
        "qwen" => {
            let base = crate::agent_specs::agent_config_root_with(agent, &home, &env_home).ok_or("未知 agent")?;
            let p = base.join("settings.json");
            (p.clone(), vec![p])
        }
        // 全局目录合并加载 config.json → opencode.json → opencode.jsonc：写已存在者，都不存在建 opencode.jsonc
        "opencode" => {
            let base = crate::agent_specs::agent_config_root_with(agent, &home, &env_home).ok_or("未知 agent")?;
            let candidates = ["config.json", "opencode.json", "opencode.jsonc"]
                .iter()
                .map(|n| base.join(n))
                .collect::<Vec<_>>();
            let write = candidates
                .iter()
                .find(|p| p.exists())
                .cloned()
                .unwrap_or_else(|| base.join("opencode.jsonc"));
            (write, candidates)
        }
        "kimi" => {
            let base = crate::agent_specs::agent_config_root_with(agent, &home, &env_home).ok_or("未知 agent")?;
            let p = base.join("mcp.json");
            (p.clone(), vec![p])
        }
        // 回退链 .mcp.json → mcp.json（deprecated）；.codebuddy.json 是共享状态文件不碰，缺失则新建 .mcp.json
        "codebuddy" => {
            let base = crate::agent_specs::agent_config_root_with(agent, &home, &env_home).ok_or("未知 agent")?;
            let primary = base.join(".mcp.json");
            let legacy = base.join("mcp.json");
            let write = if primary.exists() || !legacy.exists() {
                primary.clone()
            } else {
                legacy.clone()
            };
            (write, vec![primary, legacy])
        }
        // CLI 与 IDE 共享（写入同时改变 IDE 行为，UI 需提示）
        "cursor" => {
            let p = home.join(".cursor").join("mcp.json");
            (p.clone(), vec![p])
        }
        // grok：~/.grok/config.toml 的 [mcp_servers.<name>] 段（TOML，不是 JSON）；
        // GROK_HOME 可整体搬迁。首版只做只读清单（agent_entries 解析 TOML），分发/写入
        // 在 apply_to_agent 明确拒绝（grok 自带 `grok mcp add` CLI，不硬造 TOML 原子写管线）
        "grok" => {
            let base = crate::agent_specs::agent_config_root_with(agent, &home, &env_home).ok_or("未知 agent")?;
            let p = base.join("config.toml");
            (p.clone(), vec![p])
        }
        _ => return Err(format!("未知 agent: {agent}")),
    })
}

/// 各家的顶层键（opencode 是 mcp，其余 mcpServers；codex 走 TOML 不在此列）
fn top_key(agent: &str) -> &'static str {
    match agent {
        "opencode" => "mcp",
        _ => "mcpServers",
    }
}

/// claude 企业管理层存在即拒写（managed-mcp.json 独占 MCP 配置）
fn check_managed_guard(agent: &str) -> Result<(), String> {
    if agent == "claude-code" {
        let mut paths = vec![
            "/Library/Application Support/ClaudeCode/managed-mcp.json".to_string(),
            "/etc/claude-code/managed-mcp.json".to_string(),
        ];
        if std::env::consts::OS == "windows" {
            paths.push(r"C:\Program Files\ClaudeCode\managed-mcp.json".to_string());
        }
        for p in paths {
            if Path::new(&p).exists() {
                return Err(
                    "检测到企业托管 MCP 配置（managed-mcp.json），用户级分发被独占，已跳过".into(),
                );
            }
        }
    }
    if agent == "opencode" {
        let mut paths = Vec::new();
        if let Ok(home) = home() {
            let base = std::env::var_os("XDG_CONFIG_HOME")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config"))
                .join("opencode");
            paths.push(base.join("managed"));
        }
        #[cfg(windows)]
        if let Some(pd) = std::env::var_os("ProgramData") {
            paths.push(PathBuf::from(pd).join("opencode").join("managed"));
        }
        #[cfg(target_os = "macos")]
        paths.push(PathBuf::from(
            "/Library/Application Support/opencode/managed",
        ));
        #[cfg(target_os = "linux")]
        paths.push(PathBuf::from("/etc/opencode/managed"));
        for p in paths {
            if p.exists() {
                return Err(
                    "检测到 OpenCode 企业托管配置目录（managed），用户级分发被独占，已跳过".into(),
                );
            }
        }
    }
    Ok(())
}

// ===== 读-改-写分发 =====

/// JSON 系七家：写/删 obj[top_key][name]，保留其余一切键；备份 + 原子写 + 读回校验
fn write_json_entry(
    agent: &str,
    name: &str,
    entry: Option<serde_json::Value>,
) -> Result<(), String> {
    check_managed_guard(agent)?;
    let (path, _) = agent_paths(agent)?;
    let mut root = if path.exists() {
        jsonc_read(&path)?
    } else {
        serde_json::json!({})
    };
    if !root.is_object() {
        return Err(format!("{} 顶层不是 JSON 对象，已拒写", path.display()));
    }
    let expect_present = entry.is_some();
    {
        let obj = root.as_object_mut().expect("已校验 object");
        let key = top_key(agent);
        if !obj.contains_key(key) {
            obj.insert(key.to_string(), serde_json::json!({}));
        }
        let Some(servers) = obj.get_mut(key).and_then(|v| v.as_object_mut()) else {
            return Err(format!("{} 的 {key} 键不是对象，已拒写", path.display()));
        };
        match entry {
            Some(e) => {
                servers.insert(name.to_string(), e);
            }
            None => {
                servers.remove(name);
            }
        }
        // codebuddy 的 disabledMcpServers 是与条目并列的禁用名单：分发/移除时把本条目
        // 从名单里清掉（只动自己名下这一项，其余名字保留）——否则外部禁用后，Mesa 重新
        // 分发重写了条目却仍被名单压着禁用，与 codex 重写即恢复启用的语义不一致
        if agent == "codebuddy" {
            if let Some(list) = obj
                .get_mut("disabledMcpServers")
                .and_then(|v| v.as_array_mut())
            {
                list.retain(|x| x.as_str() != Some(name));
            }
        }
    }
    backup_once(&path)?;
    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(&path, &text)?;
    // 读回校验：条目按预期存在/消失
    let back = jsonc_read(&path)?;
    let present = back.get(top_key(agent)).and_then(|v| v.get(name)).is_some();
    if present != expect_present {
        return Err(format!("写入 {} 后读回校验失败", path.display()));
    }
    Ok(())
}

/// codex：toml_edit 保格式读-改-写 [mcp_servers.<name>]，其余段不动
fn write_codex_entry(name: &str, entry: Option<toml_edit::Table>) -> Result<(), String> {
    let (path, _) = agent_paths("codex")?;
    let mut doc = if path.exists() {
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
        strip_bom(&text)
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("{} 解析失败: {e}（已拒写，请先手工修复）", path.display()))?
    } else {
        toml_edit::DocumentMut::new()
    };
    if doc.get("mcp_servers").is_none() {
        doc["mcp_servers"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let expect_present = entry.is_some();
    let servers = doc["mcp_servers"]
        .as_table_mut()
        .ok_or_else(|| format!("{} 的 mcp_servers 不是表，已拒写", path.display()))?;
    match entry {
        Some(t) => {
            servers.insert(name, toml_edit::Item::Table(t));
        }
        None => {
            servers.remove(name);
        }
    }
    backup_once(&path)?;
    crate::profiles::atomic_write(&path, &doc.to_string())?;
    // 读回校验
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("读回 {} 失败: {e}", path.display()))?;
    let back = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("写入后 {} 无法解析: {e}", path.display()))?;
    let present = back.get("mcp_servers").and_then(|t| t.get(name)).is_some();
    if present != expect_present {
        return Err(format!("写入 {} 后读回校验失败", path.display()));
    }
    Ok(())
}

/// 写/删一个 agent 侧条目（entry=None 即删除）
fn apply_to_agent(agent: &str, server: &McpServerDto, install: bool) -> Result<(), String> {
    // 分发闸（与 save_impl 明文拦截同口径）：明文密钥不写入任何 agent 配置；
    // 移除方向（install=false）不拦——减少暴露面的操作永远放行
    if install {
        let suspects = suspect_plaintext_keys(server);
        if !suspects.is_empty() {
            return Err(plaintext_reject_error(&suspects));
        }
    }
    // 只读能力的 agent（grok：TOML [mcp_servers] 与 model 同文件，自带 `grok mcp add`
    // CLI 做读改写，首版不硬造 TOML 原子写管线）按能力表带原因拒绝
    if let Some(crate::agent_specs::McpWriteCap::ReadOnly(reason)) =
        crate::agent_specs::agent_spec(agent).map(|s| s.mcp_write)
    {
        return Err(reason.into());
    }
    if agent == "codex" {
        let entry = if install {
            Some(entry_toml(server)?)
        } else {
            None
        };
        write_codex_entry(&server.name, entry)
    } else {
        let entry = if install {
            Some(entry_json(server, agent)?)
        } else {
            None
        };
        write_json_entry(agent, &server.name, entry)
    }
}

/// 读某 agent 配置里现有的 server 名列表（现状展示 + 漂移检测用）
fn agent_server_names(agent: &str) -> Result<Vec<String>, String> {
    Ok(agent_entries(agent)?.into_iter().map(|(k, _)| k).collect())
}

/// codex 的 TOML 表转 JSON 值（只收 string/array/table，够用且防御）
fn toml_to_json(item: &toml_edit::Item) -> serde_json::Value {
    use serde_json::{Map, Value};
    match item {
        toml_edit::Item::Value(v) => match v {
            toml_edit::Value::String(s) => Value::String(s.value().clone()),
            toml_edit::Value::Integer(i) => Value::Number((*i.value()).into()),
            toml_edit::Value::Float(f) => serde_json::Number::from_f64(*f.value())
                .map(Value::Number)
                .unwrap_or(Value::Null),
            toml_edit::Value::Boolean(b) => Value::Bool(*b.value()),
            toml_edit::Value::Array(a) => Value::Array(
                a.iter()
                    .map(|x| toml_to_json(&toml_edit::Item::Value(x.clone())))
                    .collect(),
            ),
            _ => Value::Null,
        },
        toml_edit::Item::Table(t) => Value::Object(
            t.iter()
                .map(|(k, v)| (k.to_string(), toml_to_json(v)))
                .collect::<Map<_, _>>(),
        ),
        _ => Value::Null,
    }
}

/// 各家 TOML 配置的段名（codex/grok 都是 mcp_servers，不共用函数体以防 grok 后续分岔）
fn toml_servers_key(agent: &str) -> &'static str {
    match agent {
        _ => "mcp_servers",
    }
}

/// 读某 agent 用户级配置里的完整 server 条目（名称 → 原始 JSON 值）
fn agent_entries(agent: &str) -> Result<Vec<(String, serde_json::Value)>, String> {
    let (_, candidates) = agent_paths(agent)?;
    if agent == "codex" || agent == "grok" {
        // codex：config.toml 的 [mcp_servers.<name>]（分发可写，见 write_codex_entry）
        // grok：同段名同构（TOML），首版只读清单不写——解析成本低且 toml_edit 已在依赖里
        let Some(path) = candidates.iter().find(|p| p.exists()) else {
            return Ok(Vec::new());
        };
        let text = std::fs::read_to_string(path).map_err(|e| format!("读取失败: {e}"))?;
        let doc = strip_bom(&text)
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("{} 解析失败: {e}", path.display()))?;
        return Ok(doc
            .get(toml_servers_key(agent))
            .and_then(|t| t.as_table())
            .map(|t| {
                t.iter()
                    .map(|(k, v)| (k.to_string(), toml_to_json(v)))
                    .collect()
            })
            .unwrap_or_default());
    }
    for path in candidates {
        if !path.exists() {
            continue;
        }
        let root = jsonc_read(&path)?;
        let entries = root
            .get(top_key(agent))
            .and_then(|v| v.as_object())
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        return Ok(entries);
    }
    Ok(Vec::new())
}

// ===== 反向映射：各家条目 → 统一模型（收编现有配置用；未知字段防御式丢弃） =====

/// 来源配置里的启动超时声明（codex/grok TOML 的 startup_timeout_sec，matrix §10.2）→ 毫秒；
/// 其余家未实证等价字段，不读不猜
fn parse_startup_timeout_ms(v: &serde_json::Value) -> Option<u64> {
    let secs = v.get("startup_timeout_sec").and_then(|x| x.as_f64())?;
    if secs.is_finite() && secs > 0.0 {
        Some((secs * 1000.0) as u64)
    } else {
        None
    }
}

fn reverse_entry(agent: &str, name: &str, v: &serde_json::Value) -> McpServerDto {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let arr = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let pairs = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_object())
            .map(|o| {
                o.iter()
                    .filter_map(|(k, x)| {
                        x.as_str().map(|val| McpEnvPair {
                            key: k.clone(),
                            value: val.to_string(),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    // {env:VAR} → ${VAR}（opencode 插值语法的逆向）
    let unref = |pairs: Vec<McpEnvPair>| -> Vec<McpEnvPair> {
        pairs
            .into_iter()
            .map(|p| {
                let value = p
                    .value
                    .strip_prefix("{env:")
                    .and_then(|r| r.strip_suffix('}'))
                    .map(|n| format!("${{{n}}}"))
                    .unwrap_or(p.value);
                McpEnvPair { key: p.key, value }
            })
            .collect()
    };
    let mut server = McpServerDto {
        id: String::new(),
        name: name.to_string(),
        kind: "stdio".into(),
        command: String::new(),
        args: vec![],
        cwd: String::new(),
        env: vec![],
        url: String::new(),
        headers: vec![],
        apps: HashMap::new(),
        enabled: true,
        // 来源由调用方标记（import_mcp_from_agent / parse_pasted），此处一律未知
        origin: String::new(),
        startup_timeout_ms: parse_startup_timeout_ms(v),
        last_check: None,
    };
    match agent {
        "opencode" => {
            if s("type") == "local" || v.get("command").is_some() {
                let cmd = arr("command");
                server.kind = "stdio".into();
                server.command = cmd.first().cloned().unwrap_or_default();
                server.args = cmd.into_iter().skip(1).collect();
                server.env = unref(pairs("environment"));
            } else {
                server.kind = "remote".into();
                server.url = s("url");
                server.headers = unref(pairs("headers"));
            }
            server.cwd = s("cwd");
        }
        "codex" => {
            if v.get("url").is_some() {
                server.kind = "remote".into();
                server.url = s("url");
                server.headers = pairs("http_headers");
                // env_http_headers: {Header: VAR} → Header: ${VAR}
                for p in pairs("env_http_headers") {
                    server.headers.push(McpEnvPair {
                        key: p.key,
                        value: format!("${{{}}}", p.value),
                    });
                }
                let bearer = s("bearer_token_env_var");
                if !bearer.is_empty() {
                    server.headers.push(McpEnvPair {
                        key: "Authorization".into(),
                        value: format!("Bearer ${{{bearer}}}"),
                    });
                }
            } else {
                server.command = s("command");
                server.args = arr("args");
                server.cwd = s("cwd");
                server.env = pairs("env");
                for name in arr("env_vars") {
                    server.env.push(McpEnvPair {
                        key: name.clone(),
                        value: format!("${{{name}}}"),
                    });
                }
            }
        }
        // grok：与 codex 同构的 [mcp_servers.<name>] TOML 段，但远程另有 `type`("http"/"sse")
        // 且 headers 直收 + bearer_token_env_var 是 env 引用（语义同 codex，无 env_http_headers 中间层）
        "grok" => {
            if v.get("url").is_some() {
                server.kind = "remote".into();
                server.url = s("url");
                server.headers = pairs("headers");
                let bearer = s("bearer_token_env_var");
                if !bearer.is_empty() {
                    server.headers.push(McpEnvPair {
                        key: "Authorization".into(),
                        value: format!("Bearer ${{{bearer}}}"),
                    });
                }
            } else {
                server.command = s("command");
                server.args = arr("args");
                server.cwd = s("cwd");
                server.env = pairs("env");
            }
        }
        "kimi" => {
            if v.get("url").is_some() {
                server.kind = "remote".into();
                server.url = s("url");
                server.headers = pairs("headers");
                let bearer = s("bearerTokenEnvVar");
                if !bearer.is_empty() {
                    server.headers.push(McpEnvPair {
                        key: "Authorization".into(),
                        value: format!("Bearer ${{{bearer}}}"),
                    });
                }
            } else {
                server.command = s("command");
                server.args = arr("args");
                server.cwd = s("cwd");
                server.env = pairs("env");
            }
        }
        _ => {
            // claude/codebuddy/cursor/gemini/qwen：command → stdio，url/httpUrl → remote
            if v.get("command").is_some() {
                server.command = s("command");
                server.args = arr("args");
                server.cwd = s("cwd");
                server.env = pairs("env");
            } else {
                server.kind = "remote".into();
                let url = s("url");
                server.url = if url.is_empty() { s("httpUrl") } else { url };
                server.headers = pairs("headers");
            }
        }
    }
    server
}

/// server 一句话摘要（收编列表展示用）
fn entry_summary(server: &McpServerDto) -> String {
    if server.kind == "stdio" {
        format!("{} {}", server.command, server.args.join(" "))
            .trim()
            .to_string()
    } else {
        server.url.clone()
    }
}

// ===== 明文密钥拦截与外部修改保护 =====

/// env/headers 里疑似明文密钥的「server（键）」清单；$VAR/${VAR} 引用形式不算
fn suspect_plaintext_keys(server: &McpServerDto) -> Vec<String> {
    let mut out = Vec::new();
    for p in server.env.iter().chain(server.headers.iter()) {
        if env_ref(&p.value).is_some() {
            continue;
        }
        if p.value
            .split_whitespace()
            .any(|w| crate::sessions::common_secret_token(w).is_some())
        {
            out.push(format!("{}（{}）", server.name, p.key));
        }
    }
    out
}

/// 明文密钥拒绝文案（保存/粘贴导入/分发同一口径，审计收口 2026-09-08：
/// 不再有「仍要保存」确认放行，密钥只接受 $VAR 引用形式，不落任何明文）
fn plaintext_reject_error(suspects: &[String]) -> String {
    format!(
        "检测到疑似明文密钥：{}。为防止密钥落盘泄露，只接受 $VAR / ${{VAR}} 环境变量引用形式（如 ${{MY_TOKEN}}），请改用引用后重试",
        suspects.join("、")
    )
}

/// 外部修改检测：agent 配置里的当前条目 vs 我们此刻会写出的条目（一致才允许静默移除）
fn entry_modified_externally(agent: &str, server: &McpServerDto) -> Result<bool, String> {
    let entries = agent_entries(agent)?;
    let Some((_, current)) = entries.into_iter().find(|(n, _)| *n == server.name) else {
        return Ok(false); // 已不在 = 没什么可保护的
    };
    let expected = if agent == "codex" {
        entry_toml(server).map(|t| toml_to_json(&toml_edit::Item::Table(t)))
    } else {
        entry_json(server, agent)
    };
    match expected {
        Ok(e) => Ok(current != e),
        // 清单内容按当前口径已构建不出分发产物（如历史遗留的 codex 改名引用、
        // kimi 不支持的 env 引用）：按「被改过」保护处理——移除需 force 确认，不静默删
        Err(_) => Ok(true),
    }
}

/// 条目级禁用语义只认实证过的三家（matrix §10.1/§10.2 + 2026-09-03 codex 本机实测
/// `enabled = false` 后 `codex mcp list` 显示 disabled）：codex/grok 的 TOML `enabled` 键、
/// codebuddy 的顶层并列 `disabledMcpServers` 名单。其余家未实证有 enabled 语义，
/// 一律不产出「外部已禁用」状态（宁缺毋滥，不猜）。
fn agent_has_enabled_semantics(agent: &str) -> bool {
    matches!(agent, "codex" | "grok" | "codebuddy")
}

/// TOML 系（codex/grok）：条目 `enabled` 缺省 = true
fn toml_entry_disabled(entries: &[(String, serde_json::Value)], name: &str) -> bool {
    entries
        .iter()
        .find(|(n, _)| *n == name)
        .and_then(|(_, v)| v.get("enabled").and_then(|x| x.as_bool()))
        .map(|b| !b)
        .unwrap_or(false)
}

/// codebuddy：顶层 `disabledMcpServers` 名单命中即禁用（与 mcpServers 并列键）
fn codebuddy_disabled(root: &serde_json::Value, name: &str) -> bool {
    root.get("disabledMcpServers")
        .and_then(|v| v.as_array())
        .is_some_and(|a| a.iter().any(|x| x.as_str() == Some(name)))
}

/// 该条目当前是否在 agent 侧被禁用；不支持 enabled 语义的家恒 false
fn entry_disabled_externally(agent: &str, name: &str) -> Result<bool, String> {
    match agent {
        "codex" | "grok" => Ok(toml_entry_disabled(&agent_entries(agent)?, name)),
        "codebuddy" => {
            let (_, candidates) = agent_paths(agent)?;
            let Some(path) = candidates.iter().find(|p| p.exists()) else {
                return Ok(false);
            };
            Ok(codebuddy_disabled(&jsonc_read(path)?, name))
        }
        _ => Ok(false),
    }
}

// ===== Tauri 命令 =====

#[tauri::command]
pub async fn list_mcp_servers() -> Result<Vec<McpServerDto>, String> {
    tauri::async_runtime::spawn_blocking(read_store)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_mcp_server(
    server: McpServerDto,
    allow_plaintext: bool,
    env_secrets: Option<HashMap<String, String>>,
) -> Result<Vec<McpServerDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_impl_with_secrets(server, allow_plaintext, env_secrets)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
fn save_impl(server: McpServerDto, allow_plaintext: bool) -> Result<Vec<McpServerDto>, String> {
    save_impl_with_secrets(server, allow_plaintext, None)
}

fn save_impl_with_secrets(
    mut server: McpServerDto,
    allow_plaintext: bool,
    env_secrets: Option<HashMap<String, String>>,
) -> Result<Vec<McpServerDto>, String> {
    // allow_plaintext 已废弃（审计收口 2026-09-08）：明文密钥不再允许「仍要保存」放行，
    // 参数保留仅为兼容旧前端的调用形
    let _ = allow_plaintext;
    server.name = server.name.trim().to_string();
    validate_server_name(&server.name)?;
    if server.kind != "stdio" && server.kind != "remote" {
        return Err("类型必须是 stdio 或 remote".into());
    }
    let mut captured = HashMap::new();
    rewrite_pasted_secret_refs(&mut server, &mut captured)?;
    let mut to_store = captured;
    if let Some(extra) = env_secrets {
        for (k, v) in extra {
            let v = v.trim().to_string();
            if v.is_empty() {
                continue;
            }
            to_store.insert(k, v);
        }
    }
    if !to_store.is_empty() {
        merge_mcp_keys(to_store)?;
    }
    // 明文密钥一律拒存：清单与各 agent 配置都不落明文（分发侧由 apply_to_agent 同闸拦）。
    // 兼容既有数据：清单里的历史明文条目不删不崩、照常列出，但再次编辑会被本闸拦住并
    // 引导改成引用——改成引用前 Mesa 不再把它写到任何地方，移除/删除方向不受影响
    let suspects = suspect_plaintext_keys(&server);
    if !suspects.is_empty() {
        return Err(plaintext_reject_error(&suspects));
    }
    let mut list = read_store()?;
    let is_new = server.id.is_empty();
    // 重命名检测：编辑路径记下旧名，新名条目重投完成后把旧名条目从各 agent 移除
    let mut old_name: Option<String> = None;
    if is_new {
        if list.iter().any(|s| s.name == server.name) {
            return Err(format!("已存在同名 server: {}", server.name));
        }
        server.id = uuid::Uuid::new_v4().to_string();
        server.origin = "ccode".into(); // 新建只此一个入口（前端传值一律忽略）
        list.push(server.clone());
    } else {
        let Some(pos) = list.iter().position(|s| s.id == server.id) else {
            return Err("该 server 不存在（可能已删除）".into());
        };
        if list
            .iter()
            .any(|s| s.name == server.name && s.id != server.id)
        {
            return Err(format!("已存在同名 server: {}", server.name));
        }
        if list[pos].name != server.name {
            old_name = Some(list[pos].name.clone());
        }
        server.apps = list[pos].apps.clone(); // 分发开关以开关命令为准，编辑不夹带
        server.enabled = list[pos].enabled; // 全局启用开关同理（set_mcp_server_enabled 管辖）
        server.origin = list[pos].origin.clone(); // 来源标记同理（整结构替换不能丢）
        server.last_check = list[pos].last_check.clone(); // 体检沉淀同理（编辑不是重新检测）
        list[pos] = server.clone();
    }
    // 先重投放到已开启的 agent（内容跟随最新清单），全成功才落库——
    // 顺序反过来会留下「清单说已分发但 agent 侧没写成」的假状态。
    // 全局停用（enabled=false）的条目只更新清单、不动任何 agent 配置：
    // 停用语义 = 条目已从各 agent 移除、apps 仅记意图，重开总开关才按原样重投——
    // 否则「界面显示停用、一次普通编辑又悄悄写回」
    if server.enabled {
        for (agent, on) in server.apps.clone() {
            if on {
                apply_to_agent(&agent, &server, true)?;
            }
        }
        // 重命名是受保护迁移：新名条目全部写好后，再把旧名条目从各 agent 配置移除
        //（同一套 读-改-写 + 备份 + 原子写 + 读回校验口径；旧名条目本就是 Mesa 按清单
        //  写的，编辑重投本就整结构覆盖，移除旧名不另做 EXTMOD 预检——权属口径一致；
        //  任一步失败都不落库，清单保持旧名，重试可续）
        if let Some(old) = old_name {
            for (agent, on) in server.apps.clone() {
                if on {
                    let mut prev = server.clone();
                    prev.name = old.clone();
                    apply_to_agent(&agent, &prev, false)?;
                }
            }
        }
    }
    write_store(&list)?;
    Ok(list)
}

/// 分发开关：开 = 写入该 agent 用户级配置；关 = 移除同名条目
///（移除前比对内容：该 agent 的条目被外部改过时需 force，防误删用户手调版本）
#[tauri::command]
pub async fn set_mcp_server_app(
    id: String,
    agent: String,
    enabled: bool,
    force: bool,
) -> Result<Vec<McpServerDto>, String> {
    tauri::async_runtime::spawn_blocking(move || set_app_impl(&id, &agent, enabled, force))
        .await
        .map_err(|e| e.to_string())?
}

fn set_app_impl(
    id: &str,
    agent: &str,
    enabled: bool,
    force: bool,
) -> Result<Vec<McpServerDto>, String> {
    crate::agent_specs::agent_spec(agent).ok_or_else(|| format!("未知 agent: {agent}"))?;
    let mut list = read_store()?;
    let Some(pos) = list.iter().position(|s| s.id == id) else {
        return Err("该 server 不存在（可能已删除）".into());
    };
    let server = list[pos].clone();
    // 全局停用中的条目拨开某 agent 开关：只记分发意图（apps 映射），不写 agent 配置——
    // 重开总开关时 set_mcp_server_enabled 按 apps 原样重投；拨关（移除方向）不受影响
    if !(enabled && !server.enabled) {
        if !enabled && !force && entry_modified_externally(agent, &server)? {
            return Err(format!("EXTMOD:{agent}"));
        }
        apply_to_agent(agent, &server, enabled)?;
    }
    list[pos].apps.insert(agent.to_string(), enabled);
    write_store(&list)?;
    Ok(list)
}

/// 全局启用开关（v3.93）：禁用 = 从所有已分发 agent 移除条目但保留 apps 映射
///（下次启用按原样重投）；禁用的 EXTMOD 预检与 delete 同口径，启用（写入方向）
/// 与 set_app 同口径不查外部修改
#[tauri::command]
pub async fn set_mcp_server_enabled(
    id: String,
    enabled: bool,
    force: bool,
) -> Result<Vec<McpServerDto>, String> {
    tauri::async_runtime::spawn_blocking(move || set_enabled_impl(&id, enabled, force))
        .await
        .map_err(|e| e.to_string())?
}

fn set_enabled_impl(id: &str, enabled: bool, force: bool) -> Result<Vec<McpServerDto>, String> {
    let mut list = read_store()?;
    let Some(pos) = list.iter().position(|s| s.id == id) else {
        return Err("该 server 不存在（可能已删除）".into());
    };
    let server = list[pos].clone();
    let targets: Vec<String> = server
        .apps
        .iter()
        .filter(|(_, on)| **on)
        .map(|(a, _)| a.clone())
        .collect();
    if !enabled && !force {
        let modified: Vec<String> = targets
            .iter()
            .filter_map(|a| {
                entry_modified_externally(a, &server)
                    .ok()
                    .filter(|m| *m)
                    .map(|_| a.clone())
            })
            .collect();
        if !modified.is_empty() {
            return Err(format!("EXTMOD:{}", modified.join("、")));
        }
    }
    for agent in &targets {
        apply_to_agent(agent, &server, enabled)?;
    }
    list[pos].enabled = enabled;
    write_store(&list)?;
    Ok(list)
}

/// 删除分流：keep_agent_configs=true = 收编条目的安全出口，只从清单移除，
/// 不碰任何 agent 配置文件（跳过 EXTMOD 预检与移除循环——整条目都是从 agent 侧收编的，
/// 默认动作绝不能反向删用户原有配置）；false = 维持完整行为（预检 + 逐 agent 移除）
#[tauri::command]
pub async fn delete_mcp_server(
    id: String,
    force: bool,
    keep_agent_configs: bool,
) -> Result<Vec<McpServerDto>, String> {
    tauri::async_runtime::spawn_blocking(move || delete_impl(&id, force, keep_agent_configs))
        .await
        .map_err(|e| e.to_string())?
}

fn delete_impl(
    id: &str,
    force: bool,
    keep_agent_configs: bool,
) -> Result<Vec<McpServerDto>, String> {
    let mut list = read_store()?;
    let Some(pos) = list.iter().position(|s| s.id == id) else {
        return Err("该 server 不存在（可能已删除）".into());
    };
    if keep_agent_configs {
        list.remove(pos);
        write_store(&list)?;
        return Ok(list);
    }
    let server = list[pos].clone();
    // 外部修改预检全做完再动手（防部分移除后清单与 agent 侧状态错位）
    if !force {
        let modified: Vec<String> = server
            .apps
            .iter()
            .filter(|(_, on)| **on)
            .filter_map(|(agent, _)| {
                entry_modified_externally(agent, &server)
                    .ok()
                    .filter(|m| *m)
                    .map(|_| agent.clone())
            })
            .collect();
        if !modified.is_empty() {
            return Err(format!("EXTMOD:{}", modified.join("、")));
        }
    }
    // 先逐 agent 移除已分发条目（单个失败即停，清单保留便于排查）
    for (agent, on) in &server.apps {
        if *on {
            apply_to_agent(agent, &server, false)?;
        }
    }
    list.remove(pos);
    write_store(&list)?;
    Ok(list)
}

/// 各 agent 用户级配置里现有的 server 名（含非 Mesa 管理的；前端用于漂移/现状展示）
#[tauri::command]
pub async fn mcp_agent_status() -> HashMap<String, Result<Vec<String>, String>> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::agent_specs::all_agent_specs()
            .iter()
            .map(|s| (s.id.to_string(), agent_server_names(s.id)))
            .collect()
    })
    .await
    .unwrap_or_default()
}

// ===== 收编现有配置 + 粘贴 JSON 导入 =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredMcpDto {
    pub agent: String,
    pub name: String,
    pub summary: String,
    /// 命令是相对路径（./ ../ 开头）：来源 agent 自己的运行语境下才解析得到，
    /// 收编时 resolver 会尝试落绝对路径；前端在列表行上预警
    pub relative_command: bool,
}

/// 扫描各家用户级配置，列出不在 Mesa 清单里的 server（「发现未纳管」同套路）
#[tauri::command]
pub async fn discover_mcp_servers() -> Result<Vec<DiscoveredMcpDto>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let known: HashSet<String> = read_store()?.iter().map(|s| s.name.clone()).collect();
        let mut out = Vec::new();
        for spec in crate::agent_specs::all_agent_specs() {
            let entries = match agent_entries(spec.id) {
                Ok(e) => e,
                Err(_) => continue, // 单个 agent 配置损坏不拖垮整体扫描
            };
            for (name, value) in entries {
                if known.contains(&name) {
                    continue;
                }
                let server = reverse_entry(spec.id, &name, &value);
                out.push(DiscoveredMcpDto {
                    agent: spec.id.to_string(),
                    relative_command: server.kind == "stdio"
                        && is_relative_command(&server.command),
                    summary: entry_summary(&server),
                    name,
                });
            }
        }
        out.sort_by(|a, b| a.agent.cmp(&b.agent).then(a.name.cmp(&b.name)));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 收编结果：更新后的清单 + 相对路径命令的处理计数（前端 toast 附注用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpImportOutcome {
    pub servers: Vec<McpServerDto>,
    /// 相对路径已解析为绝对路径的条数
    pub resolved: usize,
    /// 相对路径未能解析、照原样收进来的条数（清单页有告警与一键修复兜底）
    pub unresolved: usize,
}

/// stdio 相对路径命令的收编解析：命中首候选 → 存绝对路径 + cwd 规范化；
/// 全不命中 → 照原样收进来（fail-open：收编不是写 agent 配置，存下来让用户在清单里
/// 看到再修比拒收好；未解析条目由 mcp_command_path_status 的 relative 态持续告警）。
/// 返回 (resolved, unresolved) 计数
fn resolve_on_import(server: &mut McpServerDto, agent: Option<&str>) -> (usize, usize) {
    if server.kind != "stdio" || !is_relative_command(&server.command) {
        return (0, 0);
    }
    match resolve_relative_candidates(&server.command, &server.cwd, agent).first() {
        Some(fix) => {
            server.command = fix.command.clone();
            server.cwd = fix.cwd.clone();
            (1, 0)
        }
        None => (0, 1),
    }
}

/// 收编：把某 agent 配置里的既有 server 读进 Mesa 清单，并标记已分发到该 agent
#[tauri::command]
pub async fn import_mcp_from_agent(
    agent: String,
    name: String,
) -> Result<McpImportOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || import_from_agent_impl(&agent, &name))
        .await
        .map_err(|e| e.to_string())?
}

fn import_from_agent_impl(agent: &str, name: &str) -> Result<McpImportOutcome, String> {
    crate::agent_specs::agent_spec(agent).ok_or_else(|| format!("未知 agent: {agent}"))?;
    let mut list = read_store()?;
    if list.iter().any(|s| s.name == name) {
        return Err(format!("清单里已有同名 server: {name}"));
    }
    let entries = agent_entries(agent)?;
    let Some((_, value)) = entries.into_iter().find(|(n, _)| *n == name) else {
        return Err(format!("{} 的配置里找不到 server {name}", agent));
    };
    let mut server = reverse_entry(agent, name, &value);
    let (resolved, unresolved) = resolve_on_import(&mut server, Some(agent));
    server.id = uuid::Uuid::new_v4().to_string();
    server.apps.insert(agent.to_string(), true); // 已在该 agent 配置里，标记已分发
    server.origin = format!("imported:{agent}"); // 收编来源：删除分流据此默认仅从清单移除
    list.push(server);
    write_store(&list)?;
    Ok(McpImportOutcome {
        servers: list,
        resolved,
        unresolved,
    })
}

/// 粘贴 JSON 的纯解析（不写库）：剥包裹层 + 通用形状解析 + 标出将与清单重名被跳过的。
/// 相对路径命令同收编口径尝试解析（粘贴无来源 agent，基准只有条目自己的 cwd）。
/// 返回 (解析出的 server 预览, 同名跳过名单, 疑似明文密钥清单, (相对路径已解析数, 未解析数))
fn parse_pasted(
    text: &str,
) -> Result<(Vec<McpServerDto>, Vec<String>, Vec<String>, (usize, usize)), String> {
    let v: serde_json::Value = serde_json::from_str(strip_jsonc(text).as_str())
        .map_err(|e| format!("不是合法 JSON: {e}"))?;
    let obj = v.as_object().ok_or("必须是 JSON 对象")?;
    // 剥包裹层
    let map = obj
        .get("mcpServers")
        .or_else(|| obj.get("mcp_servers"))
        .or_else(|| obj.get("mcp"))
        .and_then(|v| v.as_object())
        .unwrap_or(obj);
    let existing: HashSet<String> = read_store()?.iter().map(|s| s.name.clone()).collect();
    let mut parsed = Vec::new();
    let mut skipped = Vec::new();
    let mut suspects = Vec::new();
    let mut resolved = 0usize;
    let mut unresolved = 0usize;
    for (name, value) in map {
        let name = name.trim().to_string();
        if name.is_empty() || !value.is_object() {
            continue;
        }
        if existing.contains(&name) {
            skipped.push(name);
            continue;
        }
        validate_server_name(&name).map_err(|e| format!("「{name}」: {e}"))?;
        // 通用形状解析（claude 风格字段；gemini 的 httpUrl 也认）
        let mut server = reverse_entry("claude-code", &name, value);
        if server.kind == "stdio" && server.command.is_empty() && !s_get(value, "url").is_empty() {
            server.kind = "remote".into();
            server.url = s_get(value, "url");
        }
        if server.kind == "remote" && server.url.is_empty() {
            server.url = s_get(value, "httpUrl");
        }
        let (r, u) = resolve_on_import(&mut server, None);
        resolved += r;
        unresolved += u;
        server.id = uuid::Uuid::new_v4().to_string();
        server.origin = "imported:json".into(); // 粘贴导入同收编对待：删除默认仅从清单移除
        suspects.extend(suspect_plaintext_keys(&server));
        parsed.push(server);
    }
    if parsed.is_empty() && skipped.is_empty() {
        return Err("没有解析出任何 server 条目（期望 {\"mcpServers\": {...}} 形状）".into());
    }
    Ok((parsed, skipped, suspects, (resolved, unresolved)))
}

/// 粘贴导入预览：只解析不写库（前端展示将添加的命令清单，确认后才调 import_mcp_json）
#[tauri::command]
pub async fn parse_mcp_json(
    text: String,
) -> Result<(Vec<McpServerDto>, Vec<String>, Vec<String>), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (parsed, skipped, suspects, _) = parse_pasted(&text)?;
        Ok((parsed, skipped, suspects))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 粘贴 JSON 导入：确认预览后落库。同名跳过。明文密钥一律拒绝（只接受 $VAR 引用）。
/// 返回 (新增, 跳过, 相对路径已解析数, 相对路径未解析数)
#[tauri::command]
pub async fn import_mcp_json(
    text: String,
    allow_plaintext: bool,
) -> Result<(Vec<String>, Vec<String>, usize, usize), String> {
    tauri::async_runtime::spawn_blocking(move || import_json_impl(&text, allow_plaintext))
        .await
        .map_err(|e| e.to_string())?
}

fn import_json_impl(
    text: &str,
    allow_plaintext: bool,
) -> Result<(Vec<String>, Vec<String>, usize, usize), String> {
    // allow_plaintext 已废弃（审计收口 2026-09-08）：与 save_impl 同口径一律拒绝
    let _ = allow_plaintext;
    let (parsed, skipped, suspects, counts) = parse_pasted(text)?;
    if !suspects.is_empty() {
        return Err(plaintext_reject_error(&suspects));
    }
    let mut list = read_store()?;
    let added: Vec<String> = parsed.iter().map(|s| s.name.clone()).collect();
    list.extend(parsed);
    write_store(&list)?;
    Ok((added, skipped, counts.0, counts.1))
}

fn s_get(v: &serde_json::Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

// ===== 测试 =====

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn stdio_server() -> McpServerDto {
        McpServerDto {
            id: "t1".into(),
            name: "fs-tools".into(),
            kind: "stdio".into(),
            // 必定不存在的命令名：resolve_binary 解析不到时回退原名，断言不受机器环境影响
            command: "ccode-test-nonexistent-bin".into(),
            args: vec!["-y".into(), "some-mcp".into()],
            cwd: "/tmp".into(),
            env: vec![
                McpEnvPair {
                    key: "DEBUG".into(),
                    value: "1".into(),
                },
                McpEnvPair {
                    key: "TOKEN".into(),
                    value: "${MY_TOKEN}".into(),
                },
            ],
            url: String::new(),
            headers: vec![],
            apps: HashMap::new(),
            enabled: true,
            origin: String::new(),
            startup_timeout_ms: None,
            last_check: None,
        }
    }

    fn remote_server() -> McpServerDto {
        McpServerDto {
            id: "t2".into(),
            name: "remote-api".into(),
            kind: "remote".into(),
            command: String::new(),
            args: vec![],
            cwd: String::new(),
            env: vec![],
            url: "https://example.com/mcp".into(),
            headers: vec![McpEnvPair {
                key: "Authorization".into(),
                value: "Bearer ${MCP_TOKEN}".into(),
            }],
            apps: HashMap::new(),
            enabled: true,
            origin: String::new(),
            startup_timeout_ms: None,
            last_check: None,
        }
    }

    #[test]
    fn jsonc_strips_comments_and_trailing_commas_keeps_strings() {
        let text = r#"{
            // 行注释
            "a": "http://x//not-comment",
            "b": [1, 2,], /* 块注释 */ "c": "}",
        }"#;
        let v: serde_json::Value = serde_json::from_str(&strip_jsonc(text)).unwrap();
        assert_eq!(v["a"], "http://x//not-comment");
        assert_eq!(v["b"], serde_json::json!([1, 2]));
        assert_eq!(v["c"], "}");
    }

    #[test]
    fn bom_prefixed_agent_config_reads_and_writes() {
        // PowerShell 5.1 Set-Content -Encoding UTF8 / 旧记事本存的配置带 BOM，不能被当成损坏拒写
        let v: serde_json::Value =
            serde_json::from_str(&strip_jsonc("\u{feff}{\"a\": 1,}")).unwrap();
        assert_eq!(v["a"], 1);
        let doc = strip_bom("\u{feff}[mcp_servers.x]\ncommand = \"y\"\n")
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        assert_eq!(doc["mcp_servers"]["x"]["command"].as_str(), Some("y"));

        let fx = Fixture::new();
        let path = fx.seed_cursor_config();
        let original = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, format!("\u{feff}{original}")).unwrap();
        let names: Vec<String> = agent_entries("cursor")
            .unwrap()
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        assert_eq!(names, vec!["adopted".to_string()]);
        write_json_entry("cursor", "added", Some(serde_json::json!({"command": "x"}))).unwrap();
        let back = std::fs::read_to_string(&path).unwrap();
        assert!(!back.starts_with('\u{feff}'), "写回不带 BOM");
        let v: serde_json::Value = serde_json::from_str(&back).unwrap();
        assert!(v["mcpServers"]["adopted"].is_object(), "既有条目保留");
        assert_eq!(v["mcpServers"]["added"]["command"], "x");
    }

    #[test]
    fn env_ref_parses_two_forms() {
        assert_eq!(env_ref("$FOO"), Some("FOO"));
        assert_eq!(env_ref("${FOO}"), Some("FOO"));
        assert_eq!(env_ref("Bearer $FOO"), None); // 内嵌不算整值引用
        assert_eq!(env_ref("plain"), None);
    }

    #[test]
    fn relative_stdio_command_rejected_on_distribute() {
        // 先解后拦：条目 cwd（/tmp，绝对）下解不出 ./plugins/foo/bin/serve → 维持拒写
        // 并引导改绝对路径，比静默写必挂配置诚实
        let mut s = stdio_server();
        s.command = "./plugins/foo/bin/serve".into();
        let err = entry_json(&s, "kimi").unwrap_err();
        assert!(err.contains("相对路径"), "{err}");
        assert!(err.contains("绝对路径"), "{err}");
        assert!(err.contains("无法确定基准目录"), "{err}");
        let err = entry_toml(&s).unwrap_err();
        assert!(err.contains("相对路径"), "{err}");
        s.command = "../up/serve".into();
        assert!(entry_json(&s, "claude-code").is_err());
        // 绝对路径与裸名不受影响（用 claude-code 做正例：kimi 会拒写 stdio_server 里的 env 引用）
        s.command = "/abs/path/serve".into();
        assert!(entry_json(&s, "claude-code").is_ok());
        #[cfg(windows)]
        {
            s.command = r"C:\abs\path\serve.exe".into();
            assert!(entry_json(&s, "claude-code").is_ok());
            s.command = r"dir\sub\serve.exe".into();
            assert!(entry_json(&s, "claude-code").is_err());
        }
        s.command = "ccode-test-nonexistent-bin".into();
        assert!(entry_json(&s, "claude-code").is_ok());
    }

    #[test]
    fn mapping_claude_http_and_stdio() {
        let s = stdio_server();
        let v = entry_json(&s, "claude-code").unwrap();
        assert_eq!(v["type"], "stdio");
        assert_eq!(v["command"], "ccode-test-nonexistent-bin");
        // claude 不写 cwd（未核实支持）
        assert!(v.get("cwd").is_none());
        // ${VAR} 引用原样保留
        assert_eq!(v["env"]["TOKEN"], "${MY_TOKEN}");
        let r = entry_json(&remote_server(), "claude-code").unwrap();
        assert_eq!(r["type"], "http");
        assert_eq!(r["headers"]["Authorization"], "Bearer ${MCP_TOKEN}");
    }

    #[test]
    fn mapping_opencode_local_array_and_env_rename() {
        let v = entry_json(&stdio_server(), "opencode").unwrap();
        assert_eq!(v["type"], "local");
        assert_eq!(
            v["command"],
            serde_json::json!(["ccode-test-nonexistent-bin", "-y", "some-mcp"])
        );
        assert_eq!(v["environment"]["DEBUG"], "1");
        // ${VAR} → {env:VAR}
        assert_eq!(v["environment"]["TOKEN"], "{env:MY_TOKEN}");
        assert!(v.get("env").is_none(), "opencode 的字段叫 environment");
    }

    #[test]
    fn mapping_gemini_remote_uses_httpurl() {
        let v = entry_json(&remote_server(), "gemini").unwrap();
        assert_eq!(v["httpUrl"], "https://example.com/mcp");
        assert!(v.get("url").is_none(), "remote 不写 url（SSE 已 legacy）");
    }

    #[test]
    fn mapping_kimi_bearer_ref_to_env_var() {
        let v = entry_json(&remote_server(), "kimi").unwrap();
        assert_eq!(v["bearerTokenEnvVar"], "MCP_TOKEN");
        assert!(v.get("headers").is_none());
        // stdio env 引用对 kimi 是硬错误
        assert!(entry_json(&stdio_server(), "kimi").is_err());
    }

    #[test]
    fn mapping_kimi_stdio_shape_args_array_no_empty_cwd() {
        // 回归：kimi 的 stdio 条目必须是 command + args 数组；cwd 为空时绝不落键
        //（外部编辑器曾把启动参数写进 cwd 导致 spawn ENOENT，Mesa 写出的形状必须干净）
        let mut s = stdio_server();
        s.cwd = String::new();
        s.env = vec![]; // 本测试只看 command/args/cwd 形状（kimi 的 env 引用拒写有独立用例覆盖）
        let v = entry_json(&s, "kimi").unwrap();
        assert!(v.get("cwd").is_none(), "空 cwd 不落键");
        assert_eq!(
            v["args"],
            serde_json::json!(["-y", "some-mcp"]),
            "args 必须是数组"
        );
        // 填了 cwd 才写（kimi 支持 cwd）
        s.cwd = "/tmp".into();
        assert_eq!(entry_json(&s, "kimi").unwrap()["cwd"], "/tmp");
    }

    #[test]
    fn mapping_codex_toml_ref_channels() {
        // codex 只支持同名转发：夹具的 TOKEN=${MY_TOKEN} 是改名引用（拒写有独立用例），
        // 这里换同名引用验证 env_vars 白名单通道
        let mut s = stdio_server();
        s.env = vec![
            McpEnvPair {
                key: "DEBUG".into(),
                value: "1".into(),
            },
            McpEnvPair {
                key: "MY_TOKEN".into(),
                value: "${MY_TOKEN}".into(),
            },
        ];
        let t = entry_toml(&s).unwrap();
        assert_eq!(t["command"].as_str(), Some("ccode-test-nonexistent-bin"));
        assert_eq!(t["env"]["DEBUG"].as_str(), Some("1"));
        // 引用进 env_vars 白名单，不落 env 明文
        assert!(t["env"].get("MY_TOKEN").is_none());
        assert_eq!(t["env_vars"][0].as_str(), Some("MY_TOKEN"));
        let rt = entry_toml(&remote_server()).unwrap();
        assert_eq!(rt["bearer_token_env_var"].as_str(), Some("MCP_TOKEN"));
        assert!(rt.get("http_headers").is_none());
        assert!(rt.get("startup_timeout_sec").is_none());
    }

    #[test]
    fn name_validation_intersection() {
        assert!(validate_server_name("fs-tools2").is_ok());
        assert!(validate_server_name("has space").is_err());
        assert!(
            validate_server_name("with_under").is_err(),
            "下划线禁（gemini policy）"
        );
        assert!(validate_server_name("").is_err());
    }

    #[test]
    fn reverse_mapping_codex_refs_and_bearer() {
        let v = serde_json::json!({
            "url": "https://x/mcp",
            "http_headers": {"X-Region": "us"},
            "env_http_headers": {"X-Key": "MY_KEY"},
            "bearer_token_env_var": "MCP_TOKEN"
        });
        let s = reverse_entry("codex", "r", &v);
        assert_eq!(s.kind, "remote");
        assert_eq!(s.url, "https://x/mcp");
        assert!(s
            .headers
            .iter()
            .any(|p| p.key == "X-Region" && p.value == "us"));
        assert!(s
            .headers
            .iter()
            .any(|p| p.key == "X-Key" && p.value == "${MY_KEY}"));
        assert!(s
            .headers
            .iter()
            .any(|p| p.key == "Authorization" && p.value == "Bearer ${MCP_TOKEN}"));
        // stdio：env_vars 转回 ${VAR} 引用
        let v2 = serde_json::json!({"command": "npx", "args": ["-y"], "env_vars": ["MY_TOKEN"]});
        let s2 = reverse_entry("codex", "t", &v2);
        assert_eq!(s2.command, "npx");
        assert_eq!(s2.env[0].key, "MY_TOKEN");
        assert_eq!(s2.env[0].value, "${MY_TOKEN}");
    }

    #[test]
    fn reverse_mapping_opencode_array_and_unref() {
        let v = serde_json::json!({
            "type": "local",
            "command": ["npx", "-y", "pkg"],
            "environment": {"TOKEN": "{env:MY_TOKEN}", "DEBUG": "1"}
        });
        let s = reverse_entry("opencode", "fs", &v);
        assert_eq!(s.kind, "stdio");
        assert_eq!(s.command, "npx");
        assert_eq!(s.args, vec!["-y", "pkg"]);
        assert!(s
            .env
            .iter()
            .any(|p| p.key == "TOKEN" && p.value == "${MY_TOKEN}"));
        assert!(s.env.iter().any(|p| p.key == "DEBUG" && p.value == "1"));
    }

    #[test]
    fn reverse_mapping_gemini_httpurl_and_kimi_bearer() {
        let v = serde_json::json!({"httpUrl": "https://x/mcp", "headers": {"A": "b"}});
        let s = reverse_entry("gemini", "r", &v);
        assert_eq!(s.kind, "remote");
        assert_eq!(s.url, "https://x/mcp");
        let kv = serde_json::json!({"url": "https://x/mcp", "bearerTokenEnvVar": "TOK"});
        let ks = reverse_entry("kimi", "r", &kv);
        assert!(ks
            .headers
            .iter()
            .any(|p| p.key == "Authorization" && p.value == "Bearer ${TOK}"));
    }

    #[test]
    fn plaintext_secret_detection() {
        let mut s = stdio_server();
        s.env = vec![
            McpEnvPair {
                key: "OK".into(),
                value: "1".into(),
            },
            McpEnvPair {
                key: "REF".into(),
                value: "${MY_TOKEN}".into(),
            },
            McpEnvPair {
                key: "KEY".into(),
                value: "sk-abcdef1234567890".into(),
            },
        ];
        s.headers = vec![McpEnvPair {
            key: "Authorization".into(),
            value: "Bearer sk-abcdef1234567890".into(),
        }];
        let suspects = suspect_plaintext_keys(&s);
        // 引用形式放行；裸 sk- 与 Bearer 内嵌 sk- 都拦截
        assert_eq!(suspects.len(), 2, "{suspects:?}");
        assert!(suspects.iter().any(|x| x.contains("KEY")));
        assert!(suspects.iter().any(|x| x.contains("Authorization")));
        assert!(!suspects.iter().any(|x| x.contains("REF")));
        assert!(!suspects.iter().any(|x| x.contains("OK")));
    }

    #[test]
    fn mcp_path_text_strips_verbatim_prefix() {
        let p = PathBuf::from(r"\\?\C:\Users\x\AppData\Roaming\npm\npx.cmd");
        let text = mcp_path_text(p);
        assert!(!text.starts_with(r"\\?\"), "{text}");
        assert!(
            text.ends_with(r"\npx.cmd") || text.ends_with("/npx.cmd"),
            "{text}"
        );
    }

    #[test]
    fn is_relative_command_catches_windows_and_unix_shapes() {
        assert!(!is_relative_command("npx"));
        assert!(!is_relative_command("/usr/bin/npx"));
        assert!(is_relative_command("./serve"));
        assert!(is_relative_command("../bin/serve"));
        assert!(is_relative_command(r".\serve"));
        assert!(is_relative_command(r"dir\sub\serve.exe"));
        assert!(is_relative_command("dir/sub/serve"));
        #[cfg(windows)]
        {
            assert!(!is_relative_command(r"C:\tools\serve.exe"));
            assert!(is_relative_command("C:rel.exe"));
            assert!(!is_relative_command(r"\\?\C:\tools\serve.exe"));
        }
    }

    #[test]
    fn node_shim_detected_by_shebang() {
        let dir = std::env::temp_dir().join(format!("ccode-shim-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("npx");
        std::fs::write(&shim, "#!/usr/bin/env node\nconsole.log(1)\n").unwrap();
        assert!(is_node_shim(&shim));
        let other = dir.join("tool");
        std::fs::write(&other, "#!/bin/sh\necho hi\n").unwrap();
        assert!(!is_node_shim(&other));
        assert!(!is_node_shim(&dir.join("missing")), "读不到不算 shim");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 本机装了 Node 时：裸名 npx 落盘必须是 node.exe + npx-cli.js，绝不是 npx.cmd
    #[cfg(windows)]
    #[test]
    fn npx_command_deepens_to_node_entry_on_windows() {
        if crate::agents::resolve_binary("npx").is_none() {
            return;
        }
        let (command, args) = resolve_command_deep("npx", &["-y".into(), "some-mcp".into()]);
        assert!(
            !command.to_ascii_lowercase().ends_with(".cmd"),
            "不能把 .cmd 写进 CLI 配置: {command}"
        );
        assert!(command.to_ascii_lowercase().ends_with("node.exe"), "{command}");
        assert!(args[0].ends_with("npx-cli.js"), "{args:?}");
        assert_eq!(&args[1..], ["-y", "some-mcp"]);
    }

    #[test]
    fn json_write_read_roundtrip_and_remove() {
        let dir = std::env::temp_dir().join(format!("ccode-mcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            "{\n  // 用户注释\n  \"other\": {\"keep\": true},\n}\n",
        )
        .unwrap();
        // 直接调底层：构造一个假的 agent 路径不可行（agent_paths 写死），
        // 这里验证 jsonc_read + 写回保留其他键的核心语义
        let mut root = jsonc_read(&path).unwrap();
        root["mcpServers"] = serde_json::json!({"fs-tools": {"command": "npx"}});
        crate::profiles::atomic_write(&path, &serde_json::to_string_pretty(&root).unwrap())
            .unwrap();
        let back = jsonc_read(&path).unwrap();
        assert_eq!(back["other"]["keep"], true, "无关键必须保留");
        assert_eq!(back["mcpServers"]["fs-tools"]["command"], "npx");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== origin 来源标记与收编条目删除分流 =====

    /// 临时 HOME + 临时清单 + 临时备份根的封闭夹具（thread_local 接缝，只影响本测试线程）。
    /// 写入目标用 cursor：agent_paths 里它是唯一没有环境变量搬迁口的家，路径完全由 home 推导
    struct Fixture {
        dir: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("ccode-mcp-origin-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            TEST_HOME.with(|c| *c.borrow_mut() = Some(dir.clone()));
            TEST_STORE.with(|c| *c.borrow_mut() = Some(dir.join("mcp-servers.json")));
            TEST_BACKUP.with(|c| *c.borrow_mut() = Some(dir.join("backups")));
            Self { dir }
        }
        /// 造假 cursor 用户级配置（含一个既有 MCP 条目），返回文件路径
        fn seed_cursor_config(&self) -> PathBuf {
            let path = self.dir.join(".cursor").join("mcp.json");
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(
                &path,
                r#"{"mcpServers": {"adopted": {"command": "npx", "args": ["-y", "some-mcp"]}}}"#,
            )
            .unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            TEST_HOME.with(|c| *c.borrow_mut() = None);
            TEST_STORE.with(|c| *c.borrow_mut() = None);
            TEST_BACKUP.with(|c| *c.borrow_mut() = None);
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn origin_defaults_to_empty_for_legacy_entries() {
        // 旧清单没有 origin 字段：反序列化为空串（前端按收编条目对待，宁可少删不可错删）
        let v = serde_json::json!({
            "id": "old1", "name": "legacy", "kind": "stdio",
            "command": "npx", "url": ""
        });
        let s: McpServerDto = serde_json::from_value(v).unwrap();
        assert_eq!(s.origin, "");
        assert!(s.enabled, "enabled 的 serde 默认值同样回归覆盖");
    }

    #[test]
    fn origin_written_on_create_adopt_and_paste() {
        let fx = Fixture::new();
        // 路径一：Mesa 新建（save 唯一入口，前端传值被忽略）
        let mut s = stdio_server();
        s.id = String::new();
        s.origin = "bogus-from-frontend".into();
        let list = save_impl(s, false).unwrap();
        assert_eq!(list[0].origin, "ccode");
        // 路径二：收编 agent 既有条目
        fx.seed_cursor_config();
        let outcome = import_from_agent_impl("cursor", "adopted").unwrap();
        let adopted = outcome
            .servers
            .iter()
            .find(|s| s.name == "adopted")
            .unwrap();
        assert_eq!(adopted.origin, "imported:cursor");
        assert_eq!(adopted.apps.get("cursor"), Some(&true));
        // 路径三：粘贴 JSON 导入（parse 阶段就标好，确认落库不另设）
        let (parsed, _, _, _) =
            parse_pasted(r#"{"mcpServers": {"pasted": {"command": "npx"}}}"#).unwrap();
        assert_eq!(parsed[0].origin, "imported:json");
    }

    #[test]
    fn edit_preserves_origin() {
        // 编辑是整结构替换：origin 必须像 apps/enabled 一样保留旧值，前端传值不能夹带
        let fx = Fixture::new();
        fx.seed_cursor_config();
        let outcome = import_from_agent_impl("cursor", "adopted").unwrap();
        let mut edited = outcome
            .servers
            .iter()
            .find(|s| s.name == "adopted")
            .unwrap()
            .clone();
        edited.args = vec!["-y".into(), "other-mcp".into()];
        edited.origin = "ccode".into(); // 前端无论传什么都会被旧值覆盖
        let list = save_impl(edited, false).unwrap();
        assert_eq!(list[0].origin, "imported:cursor");
        assert_eq!(list[0].args, vec!["-y", "other-mcp"], "编辑内容正常生效");
    }

    #[test]
    fn delete_keep_agent_configs_leaves_agent_files_untouched() {
        let fx = Fixture::new();
        let agent_file = fx.seed_cursor_config();
        let before = std::fs::read_to_string(&agent_file).unwrap();
        let outcome = import_from_agent_impl("cursor", "adopted").unwrap();
        let id = outcome.servers[0].id.clone();
        // 仅从清单移除：agent 配置文件一字节不动（EXTMOD 预检与移除循环整体跳过）
        let list = delete_impl(&id, false, true).unwrap();
        assert!(list.is_empty());
        assert_eq!(std::fs::read_to_string(&agent_file).unwrap(), before);
        assert!(
            !fx.dir.join("backups").exists(),
            "不动 agent 文件就不该产生备份"
        );
        // 对照组：连同配置删除（force 跳过预检）确实会把条目从 agent 配置里移除
        let outcome = import_from_agent_impl("cursor", "adopted").unwrap();
        let list = delete_impl(&outcome.servers[0].id, true, false).unwrap();
        assert!(list.is_empty());
        let after = jsonc_read(&agent_file).unwrap();
        assert!(after["mcpServers"].get("adopted").is_none());
    }

    // ===== check_stdio 双帧格式自适应（unix 专属：假 server 走 shell 脚本） =====

    /// 临时可执行 shell 脚本假 server；返回（目录守卫用路径, 指向脚本的 server DTO）
    #[cfg(unix)]
    fn script_server(body: &str) -> (PathBuf, McpServerDto) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("ccode-mcp-stdio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-server.sh");
        std::fs::write(&script, body).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut s = stdio_server();
        s.command = script.to_string_lossy().into_owned();
        s.args = vec![];
        s.cwd = String::new();
        s.env = vec![];
        (dir, s)
    }

    /// 规范 NDJSON server：收到 `{` 开头行回一行 JSON 结果
    #[cfg(unix)]
    const NDJSON_SERVER: &str = r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    '{'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"fake-ndjson","version":"1.0"}}}'
      exit 0
      ;;
  esac
done
"#;

    /// 旧式 Content-Length server：收到 `{` 开头行直接退出（不认 NDJSON），
    /// 收到 Content-Length 头按头+定长体读入并回同格式帧
    #[cfg(unix)]
    const CONTENT_LENGTH_SERVER: &str = r#"#!/bin/sh
while IFS= read -r line; do
  line=$(printf '%s' "$line" | tr -d '\r')
  case "$line" in
    '{'*)
      exit 1
      ;;
    [Cc]ontent-[Ll]ength:*)
      len=$(printf '%s' "$line" | sed 's/[^0-9]//g')
      IFS= read -r _blank
      dd bs=1 count="$len" of=/dev/null 2>/dev/null
      resp='{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"legacy-lsp","version":"0.9"}}}'
      printf 'Content-Length: %s\r\n\r\n%s' "${#resp}" "$resp"
      exit 0
      ;;
  esac
done
"#;

    #[cfg(unix)]
    #[test]
    fn check_stdio_ndjson_server_passes_first_try() {
        let (dir, s) = script_server(NDJSON_SERVER);
        let h = check_stdio(&s);
        assert!(h.ok, "{:?}", h.error);
        assert_eq!(h.detail.as_deref(), Some("fake-ndjson@1.0"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn check_stdio_content_length_server_passes_via_fallback() {
        // NDJSON 尝试下 server 见 `{` 行即退出（进程未响应就退出）→ 换 Content-Length 重试成功
        let (dir, s) = script_server(CONTENT_LENGTH_SERVER);
        let h = check_stdio(&s);
        assert!(h.ok, "{:?}", h.error);
        assert_eq!(h.detail.as_deref(), Some("legacy-lsp@0.9"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn check_stdio_both_frames_dead_report_combined_error() {
        // 两种帧格式都进程秒退：报错区分「两种帧格式均无响应」，且保留 env 缺失提示
        let (dir, mut s) = script_server("#!/bin/sh\nexit 1\n");
        s.env = vec![McpEnvPair {
            key: "TOKEN".into(),
            value: "${CCODE_TEST_DEFINITELY_MISSING_VAR}".into(),
        }];
        let h = check_stdio(&s);
        assert!(!h.ok);
        let err = h.error.unwrap();
        assert!(err.contains("两种帧格式均无响应"), "{err}");
        assert!(
            err.contains("NDJSON") && err.contains("Content-Length"),
            "{err}"
        );
        assert!(err.contains("进程未响应就退出了"), "{err}");
        assert!(
            err.contains("环境变量 CCODE_TEST_DEFINITELY_MISSING_VAR 未设置"),
            "{err}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 分发状态五态（mcp_distribution_status） =====

    #[test]
    fn toml_enabled_semantics() {
        let on = vec![(
            "s".to_string(),
            serde_json::json!({"command": "npx", "enabled": true}),
        )];
        let off = vec![(
            "s".to_string(),
            serde_json::json!({"command": "npx", "enabled": false}),
        )];
        let absent = vec![("s".to_string(), serde_json::json!({"command": "npx"}))];
        assert!(!toml_entry_disabled(&on, "s"));
        assert!(toml_entry_disabled(&off, "s"));
        assert!(!toml_entry_disabled(&absent, "s"), "enabled 缺省 = 启用");
        assert!(!toml_entry_disabled(&off, "other"), "条目不存在不算禁用");
        assert!(agent_has_enabled_semantics("codex"));
        assert!(agent_has_enabled_semantics("grok"));
        assert!(agent_has_enabled_semantics("codebuddy"));
        assert!(
            !agent_has_enabled_semantics("claude-code"),
            "未实证的家不产出该态"
        );
    }

    #[test]
    fn codebuddy_disabled_list_semantics() {
        let root = serde_json::json!({
            "mcpServers": {"a": {"command": "npx"}},
            "disabledMcpServers": ["a", "other"]
        });
        assert!(codebuddy_disabled(&root, "a"));
        assert!(!codebuddy_disabled(&root, "b"), "不在名单 = 启用");
        let no_key = serde_json::json!({"mcpServers": {"a": {}}});
        assert!(!codebuddy_disabled(&no_key, "a"), "缺键 = 启用");
        let wrong_shape = serde_json::json!({"disabledMcpServers": "a"});
        assert!(!codebuddy_disabled(&wrong_shape, "a"), "非数组不猜");
    }

    /// 造一份 cursor 配置为「与清单产物一致」的辅助：直接走真实分发写入
    fn seed_server_distributed(server: &McpServerDto) {
        write_store(&[server.clone()]).unwrap();
        apply_to_agent("cursor", server, true).unwrap();
    }

    #[test]
    fn distribution_status_ok_modified_missing_off() {
        let fx = Fixture::new();
        let mut s = stdio_server();
        s.apps.insert("cursor".into(), true);
        s.apps.insert("kimi".into(), false);
        seed_server_distributed(&s);
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(st.get("cursor").map(String::as_str), Some("ok"));
        assert_eq!(st.get("kimi").map(String::as_str), Some("off"));
        // 外部改内容 → modified
        let path = fx.dir.join(".cursor").join("mcp.json");
        let mut root = jsonc_read(&path).unwrap();
        root["mcpServers"]["fs-tools"]["args"] = serde_json::json!(["-y", "other"]);
        std::fs::write(&path, serde_json::to_string_pretty(&root).unwrap()).unwrap();
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(st.get("cursor").map(String::as_str), Some("modified"));
        // 外部删除条目 → missing（清单 apps 仍标已分发）
        root["mcpServers"]
            .as_object_mut()
            .unwrap()
            .remove("fs-tools");
        std::fs::write(&path, serde_json::to_string_pretty(&root).unwrap()).unwrap();
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(st.get("cursor").map(String::as_str), Some("missing"));
        // 整个配置文件没了也算 missing，不报警崩溃
        std::fs::remove_file(&path).unwrap();
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(st.get("cursor").map(String::as_str), Some("missing"));
        // 配置损坏 → 不报警原则，按 ok 处理
        std::fs::write(&path, "{ not json").unwrap();
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(st.get("cursor").map(String::as_str), Some("ok"));
        s.apps.clear();
    }

    #[test]
    fn distribution_status_disabled_externally_codex_and_codebuddy() {
        // 这两家的路径有环境变量搬迁口（CODEX_HOME / CODEBUDDY_CONFIG_DIR），
        // 设了就跳过——Fixture 的 thread_local HOME 压不住它们
        if std::env::var_os("CODEX_HOME").is_some()
            || std::env::var_os("CODEBUDDY_CONFIG_DIR").is_some()
        {
            return;
        }
        let fx = Fixture::new();
        let mut s = stdio_server();
        // codex 只支持同名转发：夹具的 TOKEN=${MY_TOKEN} 是改名引用会被拒写，换同名
        s.env = vec![McpEnvPair {
            key: "MY_TOKEN".into(),
            value: "${MY_TOKEN}".into(),
        }];
        s.apps.insert("codex".into(), true);
        s.apps.insert("codebuddy".into(), true);
        write_store(&[s.clone()]).unwrap();
        apply_to_agent("codex", &s, true).unwrap();
        apply_to_agent("codebuddy", &s, true).unwrap();
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(st.get("codex").map(String::as_str), Some("ok"), "{st:?}");
        assert_eq!(
            st.get("codebuddy").map(String::as_str),
            Some("ok"),
            "{st:?}"
        );
        // codex：外部加 enabled = false → disabled_externally（而不是 modified）
        let codex_path = fx.dir.join(".codex").join("config.toml");
        let mut doc = std::fs::read_to_string(&codex_path)
            .unwrap()
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        doc["mcp_servers"]["fs-tools"]["enabled"] = toml_edit::value(false);
        std::fs::write(&codex_path, doc.to_string()).unwrap();
        // codebuddy：外部把名字加进 disabledMcpServers
        let cb_path = fx.dir.join(".codebuddy").join(".mcp.json");
        let mut root = jsonc_read(&cb_path).unwrap();
        root["disabledMcpServers"] = serde_json::json!(["fs-tools", "someone-else"]);
        std::fs::write(&cb_path, serde_json::to_string_pretty(&root).unwrap()).unwrap();
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(
            st.get("codex").map(String::as_str),
            Some("disabled_externally"),
            "{st:?}"
        );
        assert_eq!(
            st.get("codebuddy").map(String::as_str),
            Some("disabled_externally"),
            "{st:?}"
        );
        // codebuddy 重新分发会把本条目从禁用名单清掉（名单里别人的名字保留），
        // codex 重写条目即丢掉 enabled=false——两边「拨开开关 = 恢复启用」语义一致
        apply_to_agent("codebuddy", &s, true).unwrap();
        apply_to_agent("codex", &s, true).unwrap();
        let root = jsonc_read(&cb_path).unwrap();
        assert_eq!(
            root["disabledMcpServers"],
            serde_json::json!(["someone-else"]),
            "只清自己名下的名字，键与别人的名字保留"
        );
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(st.get("codex").map(String::as_str), Some("ok"), "{st:?}");
        assert_eq!(
            st.get("codebuddy").map(String::as_str),
            Some("ok"),
            "{st:?}"
        );
    }

    // ===== 体检沉淀 / 启动超时 / env 引用预检 =====

    #[test]
    fn stdio_check_timeout_defaults_and_clamps() {
        let mut s = stdio_server();
        assert_eq!(
            stdio_check_timeout(&s),
            std::time::Duration::from_secs(8),
            "未声明维持 8s"
        );
        s.startup_timeout_ms = Some(2_000);
        assert_eq!(
            stdio_check_timeout(&s),
            std::time::Duration::from_secs(8),
            "声明值低于 8s 仍按 8s"
        );
        s.startup_timeout_ms = Some(20_000);
        assert_eq!(
            stdio_check_timeout(&s),
            std::time::Duration::from_secs(20),
            "声明值生效"
        );
        s.startup_timeout_ms = Some(120_000);
        assert_eq!(
            stdio_check_timeout(&s),
            std::time::Duration::from_secs(30),
            "声明值封顶 30s"
        );
    }

    #[test]
    fn startup_timeout_reverse_parsed_from_toml_fields() {
        // codex/grok 的 startup_timeout_sec（秒）→ 毫秒；缺键/非正数不落字段
        let v = serde_json::json!({"command": "npx", "startup_timeout_sec": 15});
        assert_eq!(
            reverse_entry("codex", "s", &v).startup_timeout_ms,
            Some(15_000)
        );
        let v = serde_json::json!({"command": "npx", "startup_timeout_sec": 0.5});
        assert_eq!(reverse_entry("grok", "s", &v).startup_timeout_ms, Some(500));
        let v = serde_json::json!({"command": "npx"});
        assert_eq!(reverse_entry("codex", "s", &v).startup_timeout_ms, None);
        let v = serde_json::json!({"command": "npx", "startup_timeout_sec": -3});
        assert_eq!(reverse_entry("codex", "s", &v).startup_timeout_ms, None);
        // 粘贴导入（claude 形状 JSON）里带了该键也顺带带入，没带则为空
        let fx = Fixture::new();
        let (parsed, _, _, _) = parse_pasted(
            r#"{"mcpServers": {"slow": {"command": "npx", "startup_timeout_sec": 12}}}"#,
        )
        .unwrap();
        assert_eq!(parsed[0].startup_timeout_ms, Some(12_000));
        drop(fx);
    }

    #[test]
    fn last_check_record_roundtrip_and_edit_preserves() {
        let fx = Fixture::new();
        let mut s = stdio_server();
        s.id = String::new();
        let list = save_impl(s, false).unwrap();
        let id = list[0].id.clone();
        assert!(list[0].last_check.is_none());
        // 沉淀：只动 last_check，其余字段原样
        let mut results = HashMap::new();
        results.insert(
            id.clone(),
            McpHealthDto {
                ok: false,
                latency_ms: 8_123,
                error: Some("8 秒未响应 initialize（超时）".into()),
                detail: None,
                status: "error".into(),
            },
        );
        record_last_checks(&results);
        let back = read_store().unwrap();
        let lc = back[0].last_check.as_ref().expect("应已沉淀");
        assert!(!lc.ok);
        assert_eq!(lc.latency_ms, 8_123);
        assert_eq!(lc.error.as_deref(), Some("8 秒未响应 initialize（超时）"));
        assert!(!lc.at.is_empty());
        assert_eq!(back[0].name, "fs-tools", "其他字段不动");
        // 编辑整结构替换不丢沉淀（与 origin/apps/enabled 同口径）
        let mut edited = back[0].clone();
        edited.args = vec!["-y".into(), "other".into()];
        edited.last_check = None; // 前端即使传空也被旧值覆盖
        let list = save_impl(edited, false).unwrap();
        assert_eq!(list[0].args, vec!["-y", "other"]);
        let lc = list[0].last_check.as_ref().expect("编辑后沉淀保留");
        assert_eq!(lc.latency_ms, 8_123);
        drop(fx);
    }

    #[test]
    fn missing_env_refs_collects_unset_only() {
        // 必定未设置的变量名；PATH 全平台必设；纯字面值不算；内嵌引用（Bearer ${X}）
        // 与整值引用同一口径都算（与探测注入的宿主展开一致），同名去重
        let pairs = vec![
            McpEnvPair {
                key: "A".into(),
                value: "${CCODE_TEST_DEFINITELY_MISSING_VAR}".into(),
            },
            McpEnvPair {
                key: "B".into(),
                value: "$CCODE_TEST_DEFINITELY_MISSING_VAR".into(),
            }, // 去重
            McpEnvPair {
                key: "C".into(),
                value: "$PATH".into(),
            },
            McpEnvPair {
                key: "D".into(),
                value: "plain-literal".into(),
            },
            McpEnvPair {
                key: "E".into(),
                value: "Bearer ${CCODE_TEST_DEFINITELY_MISSING_VAR}".into(),
            }, // 内嵌同样检出，去重后仍是一条
        ];
        let missing = missing_env_refs_impl(&pairs, None);
        assert_eq!(
            missing,
            vec!["CCODE_TEST_DEFINITELY_MISSING_VAR"],
            "{missing:?}"
        );
        // 空值算未设置（edition 2021，set_var 安全；用独立变量名不与并行测试互踩）
        std::env::set_var("CCODE_TEST_EMPTY_VAR", "");
        let missing = missing_env_refs_impl(
            &[McpEnvPair {
                key: "K".into(),
                value: "${CCODE_TEST_EMPTY_VAR}".into(),
            }],
            None,
        );
        assert_eq!(missing, vec!["CCODE_TEST_EMPTY_VAR"]);
        std::env::remove_var("CCODE_TEST_EMPTY_VAR");
    }

    // ===== 相对路径命令解析（resolver）与路径健康探测 =====

    /// 造一个临时文件，返回 canonicalize 后的绝对路径字符串
    ///（macOS 的 temp_dir 是 /var → /private/var symlink，与 resolver 产物同口径才好断言）
    fn touch_file(path: &Path) -> String {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
        mcp_path_text(crate::paths::canonicalize_plain(path).unwrap())
    }

    #[test]
    fn resolver_base_order_and_unique_hit() {
        let fx = Fixture::new();
        // 基准 1（条目绝对 cwd）与基准 2（cursor 配置家目录 = 临时 HOME/.cursor）都命中时
        // cwd 基准序位最前胜出
        let cwd_dir = fx.dir.join("plugin-a");
        let hit_a = touch_file(&cwd_dir.join("bin").join("serve"));
        let _hit_b = touch_file(&fx.dir.join(".cursor").join("bin").join("serve"));
        let hits =
            resolve_relative_candidates("./bin/serve", &cwd_dir.to_string_lossy(), Some("cursor"));
        assert_eq!(
            hits.len(),
            2,
            "两个基准各命中一次（路径不同不去重）: {hits:?}"
        );
        assert_eq!(hits[0].command, hit_a, "序位最前 = 条目自己的 cwd 基准");
        // 原 cwd 已是绝对路径：规范化保留原值
        assert_eq!(hits[0].cwd, cwd_dir.to_string_lossy().as_ref());
    }

    #[test]
    fn resolver_normalizes_relative_cwd_to_hit_base() {
        let fx = Fixture::new();
        // 2026-09-03 实机形状：command 相对 + cwd "." —— 命中基准后 cwd 一并规范化
        let hit = touch_file(&fx.dir.join(".cursor").join("bin").join("serve"));
        let hits = resolve_relative_candidates("./bin/serve", ".", Some("cursor"));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].command, hit);
        assert_eq!(
            hits[0].cwd,
            fx.dir.join(".cursor").to_string_lossy().as_ref(),
            "相对 cwd（.）改成命中所用的基准目录"
        );
    }

    #[test]
    fn resolver_miss_returns_empty_and_ignores_non_relative() {
        let fx = Fixture::new();
        assert!(
            resolve_relative_candidates("./no/such/file", ".", Some("cursor")).is_empty(),
            "全部基准不命中 = 空候选（调用方 fail-open / 拒写）"
        );
        assert!(resolve_relative_candidates("npx", "", Some("cursor")).is_empty());
        assert!(resolve_relative_candidates("/abs/serve", "", Some("cursor")).is_empty());
        // 粘贴导入无来源 agent：只有条目自己的绝对 cwd 一个基准
        let cwd_dir = fx.dir.join("pasted");
        let hit = touch_file(&cwd_dir.join("serve"));
        let hits = resolve_relative_candidates("./serve", &cwd_dir.to_string_lossy(), None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].command, hit);
        assert!(
            resolve_relative_candidates("./serve", "", None).is_empty(),
            "无 agent 且无绝对 cwd = 无基准可解"
        );
    }

    #[test]
    fn import_resolves_relative_command_and_normalizes_cwd() {
        let fx = Fixture::new();
        // codex 形状实机案例的 cursor 重演：./bin/serve + cwd "."，配置家目录下命中
        let hit = touch_file(&fx.dir.join(".cursor").join("bin").join("serve"));
        let path = fx.dir.join(".cursor").join("mcp.json");
        std::fs::write(
            &path,
            r#"{"mcpServers": {"rel-srv": {"command": "./bin/serve", "cwd": "."}}}"#,
        )
        .unwrap();
        let outcome = import_from_agent_impl("cursor", "rel-srv").unwrap();
        assert_eq!(outcome.resolved, 1);
        assert_eq!(outcome.unresolved, 0);
        let s = &outcome.servers[0];
        assert_eq!(s.command, hit, "收编入库的是解析后的绝对路径");
        assert_eq!(s.cwd, fx.dir.join(".cursor").to_string_lossy().as_ref());
    }

    #[test]
    fn import_unresolvable_relative_kept_as_is_fail_open() {
        let fx = Fixture::new();
        // fail-open：解不出也照原样收进来（收编不是写 agent 配置，清单页 relative 告警兜底）
        let path = fx.dir.join(".cursor").join("mcp.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"mcpServers": {"rel-srv": {"command": "./bin/serve", "cwd": "."}}}"#,
        )
        .unwrap();
        let outcome = import_from_agent_impl("cursor", "rel-srv").unwrap();
        assert_eq!(outcome.resolved, 0);
        assert_eq!(outcome.unresolved, 1);
        assert_eq!(
            outcome.servers[0].command, "./bin/serve",
            "原样收进来不拒收"
        );
        assert_eq!(outcome.servers[0].cwd, ".");
        // 清单页探测能把这条标出来
        assert_eq!(
            command_path_status(&outcome.servers[0].command),
            Some("relative")
        );
    }

    #[test]
    fn distribute_resolves_relative_via_own_cwd_before_rejecting() {
        let fx = Fixture::new();
        // 先解：条目自己的绝对 cwd 下有该文件 → 分发产物直接落绝对路径
        let hit = touch_file(&fx.dir.join("plug").join("bin").join("serve"));
        let mut s = stdio_server();
        s.command = "./bin/serve".into();
        s.cwd = fx.dir.join("plug").to_string_lossy().into_owned();
        let v = entry_json(&s, "claude-code").unwrap();
        assert_eq!(v["command"], serde_json::json!(hit));
        // 后拦：cwd 下没有该文件 → 拒写文案具体化
        s.cwd = fx.dir.join("empty-dir").to_string_lossy().into_owned();
        std::fs::create_dir_all(fx.dir.join("empty-dir")).unwrap();
        let err = entry_json(&s, "claude-code").unwrap_err();
        assert!(err.contains("无法确定基准目录"), "{err}");
    }

    #[test]
    fn command_path_status_closed_set() {
        let fx = Fixture::new();
        // relative：./ ../ 形态必挂
        assert_eq!(command_path_status("./bin/serve"), Some("relative"));
        // ok：绝对路径存在
        let hit = touch_file(&fx.dir.join("exists").join("serve"));
        assert_eq!(command_path_status(&hit), Some("ok"));
        // missing：绝对路径不存在（版本升级路径失效）
        let gone = fx
            .dir
            .join("gone")
            .join("serve")
            .to_string_lossy()
            .into_owned();
        assert_eq!(command_path_status(&gone), Some("missing"));
        // missing：裸命令名解析不到（必定不存在的名字，同 stdio_server 夹具口径）
        assert_eq!(
            command_path_status("ccode-test-nonexistent-bin"),
            Some("missing")
        );
        // 不判：$VAR 引用式与空命令
        assert_eq!(command_path_status("$MCP_BIN"), None);
        assert_eq!(command_path_status("${MCP_BIN}"), None);
        assert_eq!(command_path_status(""), None);
        // 裸名可解析 = ok（机器上有 node 才验这条，没有就跳过——不绑 CI 环境）
        if crate::agents::resolve_binary("node").is_some() {
            assert_eq!(command_path_status("node"), Some("ok"));
        }
    }

    // ===== 审计收口回归（2026-09-08）：明文密钥 / 停用编辑 / 重命名迁移 / codex 改名引用 / 探测展开 / 体检状态细分 =====

    /// 合成测试令牌（命中 sk- 前缀探测，非真实密钥）
    fn synthetic_sk() -> String {
        format!("sk-{}", "ccodetest".repeat(4))
    }

    #[test]
    fn plaintext_save_rejected_even_with_allow_flag() {
        let fx = Fixture::new();
        let marker = synthetic_sk();
        let mut s = remote_server();
        s.id = String::new();
        s.apps.insert("cursor".into(), true);
        s.headers = vec![McpEnvPair {
            key: "Authorization".into(),
            value: format!("Bearer {marker}"),
        }];
        assert!(!suspect_plaintext_keys(&s).is_empty());
        // allow_plaintext=true 也不再放行：不落清单、不写 agent 配置
        let err = save_impl(s, true).unwrap_err();
        assert!(err.contains("明文"), "{err}");
        assert!(err.contains("${"), "{err} 应引导改用引用形式");
        assert!(read_store().unwrap().is_empty(), "清单不落");
        assert!(
            !fx.dir.join(".cursor").join("mcp.json").exists(),
            "agent 配置不写"
        );
    }

    #[test]
    fn plaintext_paste_import_rejected_even_with_allow_flag() {
        let _fx = Fixture::new();
        let marker = synthetic_sk();
        let text = format!(
            r#"{{"mcpServers": {{"leaky": {{"url": "https://x/mcp", "headers": {{"Authorization": "Bearer {marker}"}}}}}}}}"#
        );
        let err = import_json_impl(&text, true).unwrap_err();
        assert!(err.contains("明文"), "{err}");
        assert!(read_store().unwrap().is_empty(), "清单不落");
    }

    #[test]
    fn plaintext_legacy_entry_kept_but_never_redistributed() {
        let fx = Fixture::new();
        // 模拟历史清单（旧版「仍要保存」放行的产物）：不删不崩、照常列出
        let marker = synthetic_sk();
        let mut s = remote_server();
        s.headers = vec![McpEnvPair {
            key: "Authorization".into(),
            value: format!("Bearer {marker}"),
        }];
        s.apps.insert("cursor".into(), true);
        write_store(&[s.clone()]).unwrap();
        // 编辑被拦并引导改引用，清单保持原样
        let err = save_impl(s.clone(), false).unwrap_err();
        assert!(err.contains("明文"), "{err}");
        assert_eq!(read_store().unwrap().len(), 1, "既有条目不被动");
        // 分发闸：拨开开关 / 重投都被拦，明文不进入任何 agent 配置
        let err = apply_to_agent("cursor", &s, true).unwrap_err();
        assert!(err.contains("明文"), "{err}");
        assert!(agent_entries("cursor").unwrap().is_empty());
        // 移除方向永远放行：删除可正常清掉这条历史数据
        let list = delete_impl(&s.id, false, false).unwrap();
        assert!(list.is_empty());
        let leaked = std::fs::read_to_string(fx.dir.join(".cursor").join("mcp.json"))
            .map(|t| t.contains(&marker))
            .unwrap_or(false);
        assert!(!leaked, "任何时刻明文都不落 agent 配置");
    }

    #[test]
    fn disabled_entry_edit_only_updates_manifest() {
        let fx = Fixture::new();
        let mut s = remote_server();
        s.id = String::new();
        s.apps.insert("cursor".into(), true);
        let saved = save_impl(s, false).unwrap().remove(0);
        assert_eq!(agent_entries("cursor").unwrap().len(), 1);
        // 全局停用：条目从 agent 移除、apps 意图保留
        let list = set_enabled_impl(&saved.id, false, false).unwrap();
        assert!(!list[0].enabled);
        assert!(agent_entries("cursor").unwrap().is_empty(), "停用即移除");
        // 编辑停用条目：只更新清单，不写回 agent（审计点：界面停用、编辑却悄悄写回）
        let mut edited = list[0].clone();
        edited.url = "https://example.com/edited".into();
        let list = save_impl(edited, false).unwrap();
        assert!(!list[0].enabled);
        assert_eq!(list[0].url, "https://example.com/edited");
        assert!(
            agent_entries("cursor").unwrap().is_empty(),
            "停用条目的编辑不得触碰 agent 配置"
        );
        // 停用中拨开另一个 agent 的开关：只记意图，同样不落盘
        let list = set_app_impl(&saved.id, "kimi", true, false).unwrap();
        assert_eq!(list[0].apps.get("kimi"), Some(&true));
        assert!(
            !fx.dir.join(".kimi-code").join("mcp.json").exists(),
            "停用中拨开开关只记意图"
        );
        // 重开总开关：按 apps 原样重投，且内容是编辑后的最新清单
        let list = set_enabled_impl(&saved.id, true, false).unwrap();
        assert!(list[0].enabled);
        let entries = agent_entries("cursor").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].1["url"], "https://example.com/edited",
            "重投用最新清单内容"
        );
        assert_eq!(agent_entries("kimi").unwrap().len(), 1, "kimi 意图一并重投");
    }

    #[test]
    fn rename_migrates_agent_entries() {
        let _fx = Fixture::new();
        let mut s = remote_server();
        s.id = String::new();
        s.apps.insert("cursor".into(), true);
        let mut saved = save_impl(s, false).unwrap().remove(0);
        saved.name = "renamed-api".into();
        let list = save_impl(saved.clone(), false).unwrap();
        assert_eq!(list[0].name, "renamed-api");
        let names: Vec<String> = agent_entries("cursor")
            .unwrap()
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        assert_eq!(
            names,
            vec!["renamed-api".to_string()],
            "旧名条目必须随改名移除: {names:?}"
        );
        // 删除新名后 agent 侧清空：不会有旧名残留复活
        delete_impl(&saved.id, false, false).unwrap();
        assert!(agent_entries("cursor").unwrap().is_empty());
    }

    #[test]
    fn rename_while_disabled_defers_agent_changes_to_reenable() {
        let _fx = Fixture::new();
        let mut s = remote_server();
        s.id = String::new();
        s.apps.insert("cursor".into(), true);
        let saved = save_impl(s, false).unwrap().remove(0);
        let list = set_enabled_impl(&saved.id, false, false).unwrap();
        assert!(agent_entries("cursor").unwrap().is_empty());
        // 停用中改名：agent 侧不动；重开后以新名写入、旧名不出现
        let mut renamed = list[0].clone();
        renamed.name = "renamed-api".into();
        let list = save_impl(renamed, false).unwrap();
        assert!(
            agent_entries("cursor").unwrap().is_empty(),
            "停用中改名不动 agent 配置"
        );
        set_enabled_impl(&list[0].id, true, false).unwrap();
        let names: Vec<String> = agent_entries("cursor")
            .unwrap()
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        assert_eq!(names, vec!["renamed-api".to_string()], "{names:?}");
    }

    #[test]
    fn codex_env_alias_rejected_with_guidance() {
        // 改名引用（TARGET_TOKEN=${SOURCE_TOKEN}）codex 表达不了：明确拒写并点名两个键名
        let mut s = stdio_server();
        s.env = vec![McpEnvPair {
            key: "TARGET_TOKEN".into(),
            value: "${SOURCE_TOKEN}".into(),
        }];
        let err = entry_toml(&s).unwrap_err();
        assert!(err.contains("TARGET_TOKEN"), "{err}");
        assert!(err.contains("SOURCE_TOKEN"), "{err}");
        // 同名转发仍然放行
        s.env = vec![McpEnvPair {
            key: "SOURCE_TOKEN".into(),
            value: "${SOURCE_TOKEN}".into(),
        }];
        let t = entry_toml(&s).unwrap();
        assert_eq!(t["env_vars"][0].as_str(), Some("SOURCE_TOKEN"));
        // remote 的 env_http_headers 是 Header→VAR 映射，键名本就不同，不受影响
        let mut r = remote_server();
        r.headers = vec![McpEnvPair {
            key: "X-Key".into(),
            value: "${MY_KEY}".into(),
        }];
        let t = entry_toml(&r).unwrap();
        assert_eq!(t["env_http_headers"]["X-Key"].as_str(), Some("MY_KEY"));
    }

    #[test]
    fn unbuildable_expected_entry_counts_as_modified() {
        // codex 路径有环境变量搬迁口，设了就跳过（thread_local HOME 压不住它）
        if std::env::var_os("CODEX_HOME").is_some() {
            return;
        }
        let fx = Fixture::new();
        // 磁盘上有同名条目，但清单内容按当前口径已构建不出分发产物
        //（历史遗留的 codex 改名引用）→ 按「被改过」保护，移除需 force 确认
        let codex_path = fx.dir.join(".codex").join("config.toml");
        std::fs::create_dir_all(codex_path.parent().unwrap()).unwrap();
        std::fs::write(&codex_path, "[mcp_servers.legacy]\ncommand = \"npx\"\n").unwrap();
        let mut s = stdio_server();
        s.name = "legacy".into();
        s.env = vec![McpEnvPair {
            key: "TARGET".into(),
            value: "${SOURCE}".into(),
        }];
        assert_eq!(
            entry_modified_externally("codex", &s).unwrap(),
            true,
            "构建不出预期产物按被改过保护，不静默删"
        );
    }

    #[test]
    fn env_refs_scanned_embedded_and_whole() {
        let names = |v: &str| {
            scan_env_refs(v)
                .into_iter()
                .map(|(_, n)| n)
                .collect::<Vec<_>>()
        };
        assert_eq!(names("${A} and $B"), vec!["A", "B"]);
        assert_eq!(names("Bearer ${CCODE_X}"), vec!["CCODE_X"]);
        assert_eq!(names("$A$B"), vec!["A", "B"], "相邻两个引用各自成界");
        assert!(names("plain").is_empty());
        assert!(names("100$").is_empty(), "孤立 $ 按字面");
        assert!(names("${}").is_empty(), "空引用名按字面");
        assert!(names("${A").is_empty(), "未闭合按字面");
        // 多字节字符不被字节扫描切断
        assert_eq!(names("前缀 ${变量名_AI} 后缀"), vec!["变量名_AI"]);
    }

    #[test]
    fn probe_expands_embedded_refs_from_host_env() {
        std::env::set_var("CCODE_TEST_PROBE_TOKEN", "tok-123");
        let mut envs = vec![];
        let mut missing = vec![];
        inject_pair(
            &mut envs,
            &mut missing,
            "Authorization",
            "Bearer ${CCODE_TEST_PROBE_TOKEN}",
        );
        assert_eq!(
            envs,
            vec![("Authorization".to_string(), "Bearer tok-123".to_string())],
            "内嵌引用按宿主环境展开（不再字面发送 Bearer ${{...}}）"
        );
        assert!(missing.is_empty());
        // $VAR 简写内嵌也展开
        let mut envs = vec![];
        inject_pair(
            &mut envs,
            &mut missing,
            "X-Key",
            "prefix-$CCODE_TEST_PROBE_TOKEN-suffix",
        );
        assert_eq!(envs[0].1, "prefix-tok-123-suffix");
        // 整值引用行为不变
        let mut envs = vec![];
        inject_pair(&mut envs, &mut missing, "K", "$CCODE_TEST_PROBE_TOKEN");
        assert_eq!(envs[0].1, "tok-123");
        std::env::remove_var("CCODE_TEST_PROBE_TOKEN");
        // 未设置的引用：整条不注入 + 记缺失（不再把字面 "${X}" 发给 server）
        let mut envs = vec![];
        let mut missing = vec![];
        inject_pair(
            &mut envs,
            &mut missing,
            "Authorization",
            "Bearer ${CCODE_TEST_DEFINITELY_MISSING_VAR}",
        );
        assert!(envs.is_empty());
        assert_eq!(missing, vec!["CCODE_TEST_DEFINITELY_MISSING_VAR"]);
        // 纯字面值原样通过
        let mut envs = vec![];
        let mut missing = vec![];
        inject_pair(&mut envs, &mut missing, "X-Plain", "literal-value");
        assert_eq!(envs[0].1, "literal-value");
        assert!(missing.is_empty());
    }

    #[test]
    fn mcp_keys_expand_and_pending_fill_missing_refs() {
        let _fx = Fixture::new();
        merge_mcp_keys(HashMap::from([(
            "CCODE_TEST_MCP_KEY".into(),
            "secret-from-file".into(),
        )]))
        .unwrap();
        let mut envs = vec![];
        let mut missing = vec![];
        inject_pair(
            &mut envs,
            &mut missing,
            "Authorization",
            "Bearer ${CCODE_TEST_MCP_KEY}",
        );
        assert_eq!(envs[0].1, "Bearer secret-from-file");
        assert!(missing.is_empty());
        let miss = missing_env_refs_impl(
            &[McpEnvPair {
                key: "Authorization".into(),
                value: "Bearer ${CCODE_TEST_MCP_KEY}".into(),
            }],
            None,
        );
        assert!(miss.is_empty(), "{miss:?}");
        let miss2 = missing_env_refs_impl(
            &[McpEnvPair {
                key: "A".into(),
                value: "${CCODE_TEST_MCP_ABSENT}".into(),
            }],
            None,
        );
        assert_eq!(miss2, vec!["CCODE_TEST_MCP_ABSENT"]);
        let pending = HashMap::from([("CCODE_TEST_MCP_ABSENT".into(), "typed".into())]);
        let miss3 = missing_env_refs_impl(
            &[McpEnvPair {
                key: "A".into(),
                value: "${CCODE_TEST_MCP_ABSENT}".into(),
            }],
            Some(&pending),
        );
        assert!(miss3.is_empty());
        let spawned = spawn_env_secrets();
        assert_eq!(
            spawned.get("CCODE_TEST_MCP_KEY").map(String::as_str),
            Some("secret-from-file")
        );
    }

    #[test]
    fn consensus_rewrites_key_used_as_var_name() {
        let mut s = remote_server();
        s.name = "consensus".into();
        s.headers = vec![McpEnvPair {
            key: "Authorization".into(),
            value: "Bearer ${ak_TESTKEYNOTREAL1234567890}".into(),
        }];
        let mut captured = HashMap::new();
        rewrite_pasted_secret_refs(&mut s, &mut captured).unwrap();
        assert_eq!(s.headers[0].value, "Bearer ${CONSENSUS_API_KEY}");
        assert_eq!(
            captured.get("CONSENSUS_API_KEY").map(String::as_str),
            Some("ak_TESTKEYNOTREAL1234567890")
        );
    }

    #[test]
    fn generic_secret_var_name_rejected() {
        let mut s = remote_server();
        s.headers[0].value = "Bearer ${ak_TESTKEYNOTREAL1234567890}".into();
        let mut captured = HashMap::new();
        let err = rewrite_pasted_secret_refs(&mut s, &mut captured).unwrap_err();
        assert!(err.contains("密钥当成了环境变量名"), "{err}");
        assert!(captured.is_empty());
    }

    fn academic_server_fixture(name: &str) -> McpServerDto {
        let mut server = remote_server();
        server.name = name.into();
        server.enabled = true;
        server
    }

    #[test]
    fn academic_login_note_names_what_is_missing() {
        let consensus = academic_server_fixture("consensus");
        let undermind = academic_server_fixture("Undermind");
        let secrets = HashSet::from(["CONSENSUS_API_KEY".to_string()]);
        let ready = academic_mcp_login_from(
            &[consensus.clone(), undermind.clone()],
            &secrets,
            true,
        );
        assert!(ready.ready);
        assert!(ready.note.is_empty());
        let missing_key = academic_mcp_login_from(
            &[consensus.clone(), undermind.clone()],
            &HashSet::new(),
            true,
        );
        assert!(!missing_key.ready);
        assert_eq!(missing_key.note, "Consensus 还没填密钥");
        let missing_login =
            academic_mcp_login_from(&[consensus, undermind], &secrets, false);
        assert!(!missing_login.ready);
        assert_eq!(missing_login.note, "Undermind 未登录");
        let empty = academic_mcp_login_from(&[], &HashSet::new(), false);
        assert!(!empty.ready);
        assert!(empty.note.contains("Consensus"));
        assert!(empty.note.contains("Undermind"));
    }

    #[test]
    fn academic_login_parsers_only_accept_logged_in_states() {
        assert!(codex_auth_is_logged_in("o_auth"));
        assert!(codex_auth_is_logged_in("bearer_token"));
        assert!(!codex_auth_is_logged_in("not_logged_in"));
        assert!(!codex_auth_is_logged_in("unsupported"));
        assert!(claude_status_is_logged_in("Status: ✔ Connected"));
        assert!(!claude_status_is_logged_in(
            "Status: ! Needs authentication"
        ));
        assert!(!claude_status_is_logged_in("no status here"));
        assert!(codex_oauth_account_is("undermind|abc", "undermind"));
        assert!(!codex_oauth_account_is("other|abc", "undermind"));
    }

    #[test]
    fn remote_auth_error_distinguishes_oauth_from_missing_key() {
        assert!(
            remote_auth_error(
                "HTTP 401 Unauthorized",
                r#"Bearer error="invalid_token", resource_metadata="https://mcp.undermind.ai/.well-known/oauth-protected-resource/mcp""#,
            )
            .contains("OAuth")
        );
        assert!(remote_auth_error("HTTP 401 Unauthorized", "").contains("密钥未设置"));
    }

    #[test]
    fn secret_hint_is_suffix_only() {
        assert_eq!(secret_hint("ak_TESTKEYNOTREAL1234567890"), "···7890");
        assert!(!secret_hint("ak_TESTKEYNOTREAL1234567890").contains("ak_"));
        assert_eq!(secret_hint("abc"), "已保存");
    }

    #[test]
    fn merge_mcp_keys_rejects_secret_as_name() {
        let _fx = Fixture::new();
        let err = merge_mcp_keys(HashMap::from([(
            "ak_TESTKEYNOTREAL1234567890".into(),
            "nope".into(),
        )]))
        .unwrap_err();
        assert!(err.contains("密钥本身") || err.contains("变量名"), "{err}");
    }

    /// 本地一次性 HTTP 假 server：读掉请求后回指定状态行（体检状态分类用，无墙钟断言）
    fn http_fixture_server(status_line: &str) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let line = status_line.to_string();
        let handle = std::thread::spawn(move || {
            use std::io::{Read, Write};
            if let Ok((mut s, _)) = listener.accept() {
                let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                let mut b = [0u8; 8192];
                let _ = s.read(&mut b);
                let _ = s.write_all(
                    format!("{line}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes(),
                );
            }
        });
        (format!("http://{addr}/mcp"), handle)
    }

    #[test]
    fn remote_check_classifies_status() {
        let check = |status_line: &str| {
            let (url, handle) = http_fixture_server(status_line);
            let mut server = remote_server();
            server.url = url;
            server.headers = vec![]; // 不依赖宿主环境变量
            let r = tauri::async_runtime::block_on(check_remote(&server));
            handle.join().unwrap();
            r
        };
        // 2xx = 握手成功
        let r = check("HTTP/1.1 200 OK");
        assert!(r.ok, "{:?}", r.error);
        assert_eq!(r.status, "handshake");
        assert_eq!(r.detail.as_deref(), Some("HTTP 200 OK"));
        // 401/403 = 认证失败（不再算「连通正常」）
        let r = check("HTTP/1.1 401 Unauthorized");
        assert!(!r.ok);
        assert_eq!(r.status, "auth");
        assert!(r.error.as_deref().unwrap().contains("401"), "{:?}", r.error);
        assert!(r.error.as_deref().unwrap().contains("认证失败"));
        let r = check("HTTP/1.1 403 Forbidden");
        assert!(!r.ok);
        assert_eq!(r.status, "auth");
        // 404 = 路径错误
        let r = check("HTTP/1.1 404 Not Found");
        assert!(!r.ok);
        assert_eq!(r.status, "not_found");
        assert!(r.error.as_deref().unwrap().contains("路径不存在"));
        // 其他 4xx = 地址可达但握手未确认（不算连通正常，也不算失败）
        let r = check("HTTP/1.1 405 Method Not Allowed");
        assert!(r.ok);
        assert_eq!(r.status, "reachable");
        // 5xx = 失败
        let r = check("HTTP/1.1 500 Internal Server Error");
        assert!(!r.ok);
        assert_eq!(r.status, "error");
    }
}

/// 分发状态五态闭集（MCP 页开关旁徽标用；开关本身仍表达清单分发意图 apps，
/// 这里只报告磁盘事实）：
/// - `off`：apps 未分发到该 agent；
/// - `ok`：落盘条目与清单产物一致；
/// - `modified`：条目存在但内容被外部改过；
/// - `missing`：apps 标记已分发但磁盘上条目不存在（外部删除）；
/// - `disabled_externally`：条目存在但在 agent 侧被禁用——只在该格式确有 enabled
///   语义时产出（codex/grok 的 TOML `enabled`、codebuddy 的 `disabledMcpServers`，
///   其余家不产出，宁缺毋滥）。
///
/// 只读探测，不写任何文件。此前 `entry_modified_externally` 只在删除/改投时用来
/// 拦「假状态」，界面上看不到——用户不知道自己在 agent 侧手改过的东西会被覆盖。
/// 探测失败（配置损坏/读不到）维持「不报警」原则按 `ok` 处理：假警报比漏报更烦人。
#[tauri::command]
pub async fn mcp_distribution_status(
    id: String,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || distribution_status_impl(&id))
        .await
        .map_err(|e| format!("查询 MCP 分发状态失败: {e}"))?
}

fn distribution_status_impl(
    id: &str,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let server = read_store()?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("找不到该 MCP server")?;
    let mut out = std::collections::BTreeMap::new();
    for (agent, on) in &server.apps {
        if !*on {
            out.insert(agent.clone(), "off".to_string());
            continue;
        }
        let state = match agent_entries(agent) {
            // 探测失败按「已写入」处理：不确定不该报警
            Err(_) => "ok",
            Ok(entries) => {
                if !entries.iter().any(|(n, _)| *n == server.name) {
                    "missing"
                } else if agent_has_enabled_semantics(agent)
                    && entry_disabled_externally(agent, &server.name).unwrap_or(false)
                {
                    // 禁用优先于 modified 报：codex 外部禁用会给条目加 enabled 键，
                    // 内容比对必然也算 modified，先报更准确的「被禁用」
                    "disabled_externally"
                } else if entry_modified_externally(agent, &server).unwrap_or(false) {
                    "modified"
                } else {
                    "ok"
                }
            }
        };
        out.insert(agent.clone(), state.to_string());
    }
    Ok(out)
}

// ===== 连通性健康检测（v3.93） =====

/// check_mcp_server 的返回：ok + 耗时 + 失败原因 + 附加说明（serverInfo / HTTP 状态）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHealthDto {
    pub ok: bool,
    /// 握手/请求耗时（毫秒）
    pub latency_ms: u64,
    /// 失败原因（路径无效 / 超时 / 连接拒绝…）；成功为 null
    pub error: Option<String>,
    /// 成功时的附加信息：stdio = serverInfo.name@version；remote = HTTP 状态行
    pub detail: Option<String>,
    /// 状态细分（闭集，前端 mcpHealthText 同源）：
    /// `handshake` = MCP initialize 握手成功（stdio 应答 / remote 2xx）；
    /// `reachable` = 地址可达但握手未确认（remote 3xx/其他 4xx，传输层通）；
    /// `auth` = 认证失败（401/403）；`not_found` = 路径错误（404）；
    /// `error` = 其余失败（5xx/网络/超时/stdio 拉起失败）
    pub status: String,
}

fn health_ok(started: std::time::Instant, detail: Option<String>, status: &str) -> McpHealthDto {
    McpHealthDto {
        ok: true,
        latency_ms: started.elapsed().as_millis() as u64,
        error: None,
        detail,
        status: status.into(),
    }
}

fn health_fail(started: std::time::Instant, error: String, status: &str) -> McpHealthDto {
    McpHealthDto {
        ok: false,
        latency_ms: started.elapsed().as_millis() as u64,
        error: Some(error),
        detail: None,
        status: status.into(),
    }
}

/// env/header 值注入前的宿主展开：所有 $VAR/${VAR} 引用（含 "Bearer ${X}" 内嵌，
/// 与分发/预检同一套引用口径）查宿主环境；字面值原样；任一引用未设置则整条不注入，
/// 缺失变量名进 missing（检测照常跑，失败文案附加提示）
fn inject_pair(
    envs: &mut Vec<(String, String)>,
    missing: &mut Vec<String>,
    key: &str,
    value: &str,
) {
    match expand_host_value(value) {
        Ok(v) => envs.push((key.to_string(), v)),
        Err(vars) => {
            for v in vars {
                if !missing.contains(&v) {
                    missing.push(v);
                }
            }
        }
    }
}

fn append_missing_hint(error: String, missing: &[String]) -> String {
    if missing.is_empty() {
        error
    } else {
        format!("{error}（另：环境变量 {} 未设置）", missing.join("、"))
    }
}

/// MCP initialize 请求体（stdio 与 remote 共用）
fn initialize_body() -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": { "name": "ccode-healthcheck", "version": "0.1.0" }
        }
    })
}

/// stdio 发送帧格式：MCP 规范是换行分隔 JSON（NDJSON，无头部）；
/// 少数旧实现说 LSP 风格 Content-Length 帧，做一次性回退兼容
#[derive(Clone, Copy)]
enum StdioFrame {
    Ndjson,
    ContentLength,
}

impl StdioFrame {
    fn label(self) -> &'static str {
        match self {
            Self::Ndjson => "NDJSON",
            Self::ContentLength => "Content-Length",
        }
    }
}

/// 单次 stdio 探测结局：Done = 终局（成功 / server 明确应答拒绝 / 命令级失败）；
/// FrameMismatch = 疑似帧格式不兼容（进程退出、首帧非法、超时），值得换格式重试，
/// 携带的错误文案已含 env 缺失提示与 stderr 末尾，供合并报告
enum StdioAttempt {
    Done(McpHealthDto),
    FrameMismatch(String),
}

/// stdio 体检每次尝试（NDJSON / Content-Length 各一次）的等待上限：
/// server 声明了启动超时的按 clamp(8s, 30s) 生效（慢启动 server 给足声明值、
/// 也不无限放大），未声明维持 8s。remote 探活恒 8s 不走这里
fn stdio_check_timeout(server: &McpServerDto) -> std::time::Duration {
    std::time::Duration::from_millis(
        server
            .startup_timeout_ms
            .map(|ms| ms.clamp(8_000, 30_000))
            .unwrap_or(8_000),
    )
}

/// stdio 检测：按分发同一口径解析命令（resolve_command_deep 含 node shim 深化）→
/// 拉起进程 → stdin 写 initialize 帧 → 上限内等首帧响应（8s，server 声明启动超时按
/// clamp(8s, 30s) 放宽）。覆盖最常见断连：
/// 路径失效/node 缺失（spawn ENOENT）、进程秒退、协议不应答（超时）。
/// 帧格式自适应：先发规范的 NDJSON 帧；server 未响应就退出 / 首帧解析失败 / 超时
/// 时换 Content-Length 帧重试一次（每次尝试各按上述上限）。
fn check_stdio(server: &McpServerDto) -> McpHealthDto {
    let started = std::time::Instant::now();
    let first_err = match check_stdio_attempt(server, StdioFrame::Ndjson, started) {
        StdioAttempt::Done(dto) => return dto,
        StdioAttempt::FrameMismatch(e) => e,
    };
    match check_stdio_attempt(server, StdioFrame::ContentLength, started) {
        StdioAttempt::Done(dto) => dto,
        StdioAttempt::FrameMismatch(second_err) => health_fail(
            started,
            format!(
                "两种帧格式均无响应（{}：{first_err}；{}：{second_err}）",
                StdioFrame::Ndjson.label(),
                StdioFrame::ContentLength.label(),
            ),
            "error",
        ),
    }
}

/// 拉起一次进程按指定帧格式发 initialize 并等首帧；响应读取器两种帧都认
/// （`{` 开头的行 = NDJSON 帧直接解析；Content-Length: 头走头+定长体路径）
fn check_stdio_attempt(
    server: &McpServerDto,
    frame: StdioFrame,
    started: std::time::Instant,
) -> StdioAttempt {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::process::Stdio;
    let (cmd, args) = resolve_command_deep(&server.command, &server.args);
    let mut command = crate::process::background_command(&cmd);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 与终端拉起同一环境纪律：NO_COLOR 移除、TERM/COLORTERM 显式设置
        .env_remove("NO_COLOR")
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .env("TERM_PROGRAM", "Mesa");
    if !server.cwd.trim().is_empty() {
        command.current_dir(server.cwd.trim());
    }
    let mut missing: Vec<String> = Vec::new();
    let mut envs: Vec<(String, String)> = Vec::new();
    for pair in &server.env {
        inject_pair(&mut envs, &mut missing, &pair.key, &pair.value);
    }
    command.envs(envs);
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return StdioAttempt::Done(health_fail(
                started,
                append_missing_hint(format!("命令不存在或路径失效：{cmd}"), &missing),
                "error",
            ));
        }
        Err(e) => {
            return StdioAttempt::Done(health_fail(
                started,
                append_missing_hint(format!("命令启动失败（{cmd}）：{e}"), &missing),
                "error",
            ));
        }
    };
    let body = initialize_body().to_string();
    let mut stdin = child.stdin.take().expect("stdin 已 pipe");
    // 发送帧按本次尝试的格式；读取器两种回包都认，server 用哪种帧回都能解析
    let write = match frame {
        StdioFrame::Ndjson => stdin
            .write_all(body.as_bytes())
            .and_then(|_| stdin.write_all(b"\n")),
        StdioFrame::ContentLength => stdin
            .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
            .and_then(|_| stdin.write_all(body.as_bytes())),
    }
    .and_then(|_| stdin.flush());
    if let Err(e) = write {
        crate::pty::kill_process_tree(child.id());
        let _ = child.kill();
        let _ = child.wait();
        return StdioAttempt::Done(health_fail(
            started,
            append_missing_hint(
                format!("写入 initialize 失败（进程可能已退出）：{e}"),
                &missing,
            ),
            "error",
        ));
    }
    // 响应读取搬进线程，主线程 recv_timeout 实现等待上限（CI 不挂死兜底）；
    // 上限 = stdio_check_timeout（默认 8s，server 声明启动超时按 clamp(8s, 30s) 放宽）
    let mut stdout = child.stdout.take().expect("stdout 已 pipe");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let r = (|| -> Result<String, String> {
            let mut reader = BufReader::new(&mut stdout);
            let mut content_len: Option<usize> = None;
            let mut line = String::new();
            loop {
                line.clear();
                let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("进程未响应就退出了".into());
                }
                let t = line.trim();
                if t.is_empty() {
                    if content_len.is_some() {
                        break;
                    }
                    continue;
                }
                // NDJSON 帧：`{` 开头的一整行 JSON，直接作为响应体
                if t.starts_with('{') {
                    return Ok(t.to_string());
                }
                if let Some(rest) = t.to_ascii_lowercase().strip_prefix("content-length:") {
                    content_len = rest.trim().parse().ok();
                }
            }
            let len = content_len.ok_or("响应缺少 Content-Length 头")?;
            let mut buf = vec![0u8; len.min(1024 * 1024)];
            reader.read_exact(&mut buf).map_err(|e| e.to_string())?;
            String::from_utf8(buf).map_err(|e| e.to_string())
        })();
        let _ = tx.send(r);
    });
    let outcome = rx.recv_timeout(stdio_check_timeout(server));
    let pid = child.id();
    let mut stderr = child.stderr.take();
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stderr.take() {
            let _ = std::io::Read::read_to_end(&mut s, &mut buf);
        }
        buf
    });
    crate::pty::kill_process_tree(pid);
    let _ = child.kill();
    let _ = child.wait();
    let err_bytes =
        crate::process::join_with_timeout(err_handle, std::time::Duration::from_secs(2));
    let err_text = String::from_utf8_lossy(&err_bytes).into_owned();
    // stderr 末尾尽力拼进错误文案，帮助定位 server 侧协议报错
    let with_stderr = |e: String| {
        if err_text.trim().is_empty() {
            e
        } else {
            let tail: String = err_text
                .trim()
                .chars()
                .rev()
                .take(200)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            format!("{e}；stderr 末尾：{tail}")
        }
    };
    match outcome {
        Ok(Ok(frame_json)) => match serde_json::from_str::<serde_json::Value>(&frame_json) {
            Ok(v) => {
                if let Some(err) = v.get("error") {
                    // server 正常应答了 JSON-RPC error：协议互通无问题，不重试
                    return StdioAttempt::Done(health_fail(
                        started,
                        append_missing_hint(format!("server 拒绝 initialize：{err}"), &missing),
                        "error",
                    ));
                }
                let info = v.pointer("/result/serverInfo");
                let detail = info.map(|i| {
                    format!(
                        "{}{}",
                        i.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                        i.get("version")
                            .and_then(|n| n.as_str())
                            .map(|v| format!("@{v}"))
                            .unwrap_or_default()
                    )
                });
                StdioAttempt::Done(health_ok(
                    started,
                    detail.filter(|d| !d.is_empty()),
                    "handshake",
                ))
            }
            Err(e) => StdioAttempt::FrameMismatch(append_missing_hint(
                with_stderr(format!("响应不是合法 JSON-RPC 帧：{e}")),
                &missing,
            )),
        },
        Ok(Err(e)) => StdioAttempt::FrameMismatch(append_missing_hint(with_stderr(e), &missing)),
        Err(_) => StdioAttempt::FrameMismatch(append_missing_hint(
            match server.startup_timeout_ms {
                // 声明了更长启动时间仍超时：点明已按声明等待（声明值即来源，UI 表单可改）
                Some(ms) => format!(
                    "{} 秒未响应 initialize（超时；该 server 声明的启动超时为 {}s，已按此等待）",
                    ms.clamp(8_000, 30_000) / 1_000,
                    ms / 1_000
                ),
                None => "8 秒未响应 initialize（超时）".to_string(),
            },
            &missing,
        )),
    }
}

/// 401/403 文案：带 RFC 9728 `resource_metadata` 的是 OAuth 保护资源（Undermind），
/// 不是「少填了 API key」。Mesa 探测不带 CLI 的 OAuth 令牌，不能当成配坏了。
fn remote_auth_error(detail: &str, www_authenticate: &str) -> String {
    let www = www_authenticate.to_ascii_lowercase();
    if www.contains("resource_metadata") || www.contains("oauth") {
        format!(
            "需要 OAuth 登录（{detail}）：在对应 CLI 执行 mcp login（Codex：codex mcp login <名>）。Mesa 体检不会代登，登录后请新开会话"
        )
    } else {
        format!("认证失败（{detail}）：密钥未设置、未注入或被服务端拒绝")
    }
}

/// remote 检测：POST initialize（MCP streamable HTTP 口径，Accept 双类型）。
/// 状态细分（McpHealthDto.status）：2xx = 握手成功；401/403 = 认证失败、404 = 路径错误
///（这两种按「连通正常」报是假阳性，必须判失败并点名原因）；3xx 与其他 4xx =
/// 地址可达但握手未确认（传输层本身是通的，多为协商问题）；5xx 与网络错误 = 失败。
async fn check_remote(server: &McpServerDto) -> McpHealthDto {
    let started = std::time::Instant::now();
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(e) => return health_fail(started, format!("HTTP 客户端初始化失败：{e}"), "error"),
    };
    let mut req = client
        .post(server.url.trim())
        .header(
            reqwest::header::ACCEPT,
            "application/json, text/event-stream",
        )
        .json(&initialize_body());
    let mut missing: Vec<String> = Vec::new();
    let mut pairs: Vec<(String, String)> = Vec::new();
    for pair in &server.headers {
        inject_pair(&mut pairs, &mut missing, &pair.key, &pair.value);
    }
    for (k, v) in pairs {
        req = req.header(k, v);
    }
    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            let detail = format!("HTTP {status}");
            let code = status.as_u16();
            if status.is_success() {
                health_ok(started, Some(detail), "handshake")
            } else if code == 401 || code == 403 {
                let www = resp
                    .headers()
                    .get(reqwest::header::WWW_AUTHENTICATE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("");
                health_fail(
                    started,
                    append_missing_hint(remote_auth_error(&detail, www), &missing),
                    "auth",
                )
            } else if code == 404 {
                health_fail(
                    started,
                    format!("路径不存在（{detail}）：请确认 URL 指向 MCP 端点"),
                    "not_found",
                )
            } else if status.is_server_error() {
                health_fail(started, append_missing_hint(detail, &missing), "error")
            } else {
                // 3xx/其他 4xx：传输层是通的，但 MCP 握手未确认，不算「连通正常」
                health_ok(started, Some(detail), "reachable")
            }
        }
        Err(e) => {
            let why = if e.is_timeout() {
                "8 秒超时".to_string()
            } else if e.is_connect() {
                format!("连接失败（服务未启动或地址错误）：{e}")
            } else {
                format!("请求失败：{e}")
            };
            health_fail(started, append_missing_hint(why, &missing), "error")
        }
    }
}

/// 单条体检分发（单条命令与批量检测共用）：remote 异步探活 / stdio 搬进 blocking 线程拉起握手
async fn check_one(server: &McpServerDto) -> McpHealthDto {
    if server.kind == "remote" {
        check_remote(server).await
    } else {
        let s = server.clone();
        match tauri::async_runtime::spawn_blocking(move || check_stdio(&s)).await {
            Ok(h) => h,
            Err(e) => health_fail(
                std::time::Instant::now(),
                format!("检测任务失败: {e}"),
                "error",
            ),
        }
    }
}

/// 体检结果沉淀进清单的 last_check 字段（读-改-写只动该字段，其余一律保留；
/// 落盘失败静默——检测结果已经拿到，不该被持久化失败拖垮）
fn record_last_checks(results: &HashMap<String, McpHealthDto>) {
    let _ = (|| -> Result<(), String> {
        let mut list = read_store()?;
        let mut dirty = false;
        for s in list.iter_mut() {
            if let Some(h) = results.get(&s.id) {
                s.last_check = Some(McpLastCheck {
                    at: crate::sessions::now_iso(),
                    ok: h.ok,
                    latency_ms: h.latency_ms,
                    error: h.error.clone(),
                });
                dirty = true;
            }
        }
        if dirty {
            write_store(&list)?;
        }
        Ok(())
    })();
}

/// 现场连通性检测（行内 ⚡ / 状态点点按触发）：不进页面时自动跑——
/// 拉起 N 个 stdio 进程的代价不该由打开页面承担，检测过才显示状态点。
/// 结果沉淀进清单 last_check（回页/刷新后行内仍能显示上次状态）
#[tauri::command]
pub async fn check_mcp_server(id: String) -> Result<McpHealthDto, String> {
    let server = tauri::async_runtime::spawn_blocking(move || {
        read_store()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| "该 server 不存在（可能已删除）".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let health = check_one(&server).await;
    let mut one = HashMap::new();
    one.insert(server.id.clone(), health.clone());
    tauri::async_runtime::spawn_blocking(move || record_last_checks(&one))
        .await
        .map_err(|e| e.to_string())?;
    Ok(health)
}

/// 批量体检（MCP 页「全部检测」）：对清单里所有启用的 server 分波并发检测
///（每波最多 4 个，避免一次拉起十几个 stdio 进程），全部完成后一次性沉淀
/// last_check 并返回 id → 结果（前端一次性回填，不做渐进式事件）
#[tauri::command]
pub async fn check_all_mcp_servers() -> Result<HashMap<String, McpHealthDto>, String> {
    let servers = tauri::async_runtime::spawn_blocking(|| {
        read_store().map(|l| l.into_iter().filter(|s| s.enabled).collect::<Vec<_>>())
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut results: HashMap<String, McpHealthDto> = HashMap::new();
    for chunk in servers.chunks(4) {
        let mut handles = Vec::with_capacity(chunk.len());
        for s in chunk {
            let s = s.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                let id = s.id.clone();
                (id, check_one(&s).await)
            }));
        }
        for h in handles {
            let (id, health) = h.await.map_err(|e| format!("体检任务失败: {e}"))?;
            results.insert(id, health);
        }
    }
    let persisted = results.clone();
    tauri::async_runtime::spawn_blocking(move || record_last_checks(&persisted))
        .await
        .map_err(|e| e.to_string())?;
    Ok(results)
}

/// $VAR 引用分发预检（只读）：提取 env/header 值里的引用（整值与内嵌，与探测注入同口径），
/// 查宿主环境返回未设置（空值算未设置）的变量名清单，去重排序。
/// 前端在保存/拨开分发开关前调用，缺失时给非阻断警告（GUI 应用读不到 shell rc 的 export）
#[tauri::command]
pub async fn mcp_missing_env_refs(
    pairs: Vec<McpEnvPair>,
    pending_secrets: Option<HashMap<String, String>>,
) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        missing_env_refs_impl(&pairs, pending_secrets.as_ref())
    })
    .await
    .unwrap_or_default()
}

fn missing_env_refs_impl(
    pairs: &[McpEnvPair],
    pending: Option<&HashMap<String, String>>,
) -> Vec<String> {
    let stored = read_mcp_keys().unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    for p in pairs {
        // 与探测注入同一套引用口径（extract_env_refs）：整值与 "Bearer ${X}" 内嵌都算
        for var in extract_env_refs(&p.value) {
            let pending_set = pending
                .and_then(|m| m.get(&var))
                .is_some_and(|v| !v.trim().is_empty());
            let stored_set = stored.get(&var).is_some_and(|v| !v.is_empty());
            let env_set = resolve_env_value(&var).is_some();
            if !pending_set && !stored_set && !env_set && !out.iter().any(|x| x == &var) {
                out.push(var);
            }
        }
    }
    out.sort();
    out
}

/// 检索步「配置学术检索 MCP」的登录态。只报有没有登录，不带密钥、令牌或体检原文。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcademicMcpLoginDto {
    /// Consensus 与 Undermind 都已添加，且各自处于已登录。
    pub ready: bool,
    /// 还没配好时的一句现状；已登录为空串。
    pub note: String,
}

fn academic_server<'a>(
    servers: &'a [McpServerDto],
    name: &str,
) -> Option<&'a McpServerDto> {
    servers.iter().find(|server| {
        server.enabled && server.name.eq_ignore_ascii_case(name)
    })
}

/// Codex `mcp list --json` 的 `auth_status`。`unsupported` 是 stdio，不算这两种远程库。
fn codex_auth_is_logged_in(status: &str) -> bool {
    matches!(
        status.trim(),
        "logged_in" | "bearer_token" | "o_auth" | "oauth"
    )
}

fn claude_status_line(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        let rest = trimmed
            .strip_prefix("Status:")
            .or_else(|| trimmed.strip_prefix("状态:"))?;
        return Some(rest.trim().to_string());
    }
    None
}

/// Claude `mcp get` 的 Status 行。`Connected` 算已登录；`Needs authentication` 不算。
fn claude_status_is_logged_in(text: &str) -> bool {
    let Some(status) = claude_status_line(text) else {
        return false;
    };
    let lower = status.to_ascii_lowercase();
    if lower.contains("needs authentication") || lower.contains("需要") {
        return false;
    }
    lower.contains("connected") || status.contains("已连接")
}

/// 钥匙串账号 `undermind` 或 `undermind|<hash>`。不读口令。
fn codex_oauth_account_is(account: &str, server: &str) -> bool {
    let account = account.trim();
    account.eq_ignore_ascii_case(server)
        || account
            .split('|')
            .next()
            .is_some_and(|head| head.eq_ignore_ascii_case(server))
}

fn codex_keychain_has_oauth(server: &str) -> bool {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = server;
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        let Ok(output) = crate::process::background_command("security")
            .args(["find-generic-password", "-s", "Codex MCP Credentials", "-g"])
            .output()
        else {
            return false;
        };
        let text = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let combined = format!("{text}\n{stdout}");
        for line in combined.lines() {
            let Some(rest) = line.split("\"acct\"").nth(1) else {
                continue;
            };
            let Some(blob) = rest.split("=\"").nth(1).and_then(|s| s.split('"').next()) else {
                continue;
            };
            if codex_oauth_account_is(blob, server) {
                return true;
            }
        }
        false
    }
}

/// 拉起 CLI 读登录状态。超时杀进程树。只返回文本，不含密钥。
fn capture_cli_text(program: &Path, args: &[&str]) -> Option<String> {
    let mut child = crate::process::background_command(program)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut buf);
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stderr, &mut buf);
        buf
    });
    let started = std::time::Instant::now();
    let limit = std::time::Duration::from_secs(8);
    loop {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        if started.elapsed() > limit {
            crate::pty::kill_process_tree(child.id());
            let _ = child.kill();
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    let _ = child.wait();
    let out = crate::process::join_with_timeout(out_handle, std::time::Duration::from_secs(1));
    let err = crate::process::join_with_timeout(err_handle, std::time::Duration::from_secs(1));
    Some(format!(
        "{}\n{}",
        String::from_utf8_lossy(&out),
        String::from_utf8_lossy(&err)
    ))
}

fn codex_auth_status(name: &str) -> Option<String> {
    let bin = crate::agents::resolve_binary("codex")?;
    let text = capture_cli_text(&bin, &["mcp", "list", "--json"])?;
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    let rows: Vec<serde_json::Value> = serde_json::from_str(&text[start..=end]).ok()?;
    rows.into_iter().find_map(|row| {
        let row_name = row.get("name")?.as_str()?;
        if !row_name.eq_ignore_ascii_case(name) {
            return None;
        }
        row.get("auth_status")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    })
}

fn claude_mcp_logged_in(name: &str) -> Option<bool> {
    let bin = crate::agents::resolve_binary("claude")?;
    let text = capture_cli_text(&bin, &["mcp", "get", name])?;
    if claude_status_line(&text).is_none() {
        return None;
    }
    Some(claude_status_is_logged_in(&text))
}

fn oauth_logged_in(name: &str) -> bool {
    if codex_auth_status(name).is_some_and(|status| codex_auth_is_logged_in(&status)) {
        return true;
    }
    if claude_mcp_logged_in(name) == Some(true) {
        return true;
    }
    codex_keychain_has_oauth(name)
}

/// MCP 页 OAuth 登录态（逐 Agent）：令牌在各 CLI 手里，Mesa 体检永远 401，
/// 「登没登上」只能问 CLI。只报状态与登录做法，不读令牌。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpOauthAgentDto {
    pub agent_id: String,
    /// logged_in / logged_out / unknown（这家查不到登录态）
    pub state: String,
    /// 在终端执行即可登录的命令；None = 这家只能在对话里登录，看 how
    pub login_command: Option<String>,
    /// 一句话做法（悬浮 / 无命令时直接显示）
    pub how: String,
}

/// 各家远程 MCP 的 OAuth 登录做法（本机 CLI 帮助核实）。name 已过 [A-Za-z0-9-] 校验，拼进命令安全。
fn mcp_oauth_login_guide(agent: &str, name: &str) -> (Option<String>, String) {
    match agent {
        "codex" => (
            Some(format!("codex mcp login {name}")),
            "终端执行后浏览器授权".into(),
        ),
        _ => (None, "在这家的对话里输入 /mcp，选中它登录".into()),
    }
}

fn mcp_oauth_state(agent: &str, name: &str) -> &'static str {
    match agent {
        "codex" => match codex_auth_status(name) {
            Some(status) if codex_auth_is_logged_in(&status) => "logged_in",
            _ if codex_keychain_has_oauth(name) => "logged_in",
            Some(_) => "logged_out",
            None => "unknown",
        },
        "claude-code" => match claude_mcp_logged_in(name) {
            Some(true) => "logged_in",
            Some(false) => "logged_out",
            None => "unknown",
        },
        _ => "unknown",
    }
}

/// 逐 Agent 查同名远程 MCP 的登录态（各家并行，单家 8 秒上限）
#[tauri::command]
pub async fn mcp_oauth_status(
    name: String,
    agents: Vec<String>,
) -> Result<Vec<McpOauthAgentDto>, String> {
    // 名字要拼进登录命令：收编条目可能带下划线，这里只放行 shell 安全字符
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("MCP 名称含特殊字符，无法查询登录状态".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // 各家 CLI 查询自带 8 秒超时杀进程树，这里并行跑、正常 join
        let handles: Vec<_> = agents
            .into_iter()
            .map(|agent| {
                let name = name.clone();
                std::thread::spawn(move || {
                    let state = mcp_oauth_state(&agent, &name).to_string();
                    let (login_command, how) = mcp_oauth_login_guide(&agent, &name);
                    McpOauthAgentDto {
                        agent_id: agent,
                        state,
                        login_command,
                        how,
                    }
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

fn academic_mcp_login_from(
    servers: &[McpServerDto],
    secrets: &HashSet<String>,
    undermind_logged_in: bool,
) -> AcademicMcpLoginDto {
    let mut issues: Vec<String> = Vec::new();
    let consensus = academic_server(servers, "consensus");
    if consensus.is_none() {
        issues.push("还没添加 Consensus".into());
    } else if !secrets.contains("CONSENSUS_API_KEY") {
        issues.push("Consensus 还没填密钥".into());
    }
    let undermind = academic_server(servers, "undermind");
    if undermind.is_none() {
        issues.push("还没添加 Undermind".into());
    } else if !undermind_logged_in {
        issues.push("Undermind 未登录".into());
    }
    AcademicMcpLoginDto {
        ready: issues.is_empty(),
        note: issues.join("；"),
    }
}

#[tauri::command]
pub async fn academic_mcp_login_status() -> Result<AcademicMcpLoginDto, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let servers = read_store()?;
        let secrets: HashSet<String> = read_mcp_keys()?
            .into_iter()
            .filter(|(_, value)| !value.is_empty())
            .map(|(name, _)| name)
            .collect();
        let logged_in = oauth_logged_in("undermind");
        Ok(academic_mcp_login_from(&servers, &secrets, logged_in))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_mcp_env_secrets() -> Result<Vec<McpEnvSecretHintDto>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let keys = read_mcp_keys()?;
        let mut out: Vec<McpEnvSecretHintDto> = keys
            .into_iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(name, value)| McpEnvSecretHintDto {
                name,
                hint: secret_hint(&value),
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== 命令路径健康探测与一键修复（只读探测 + 相对路径解析，2026-09-03） =====

/// 单条 stdio 命令的路径健康判定（闭集 ok/relative/missing）：
/// - `relative`：./ ../ 相对路径——基准是来源 agent 的运行语境，Mesa 内嵌终端拉起必挂；
/// - `missing`：绝对路径但磁盘上不存在（app 卸载/版本升级后路径失效），
///   或裸命令名连 resolve_binary 候选目录都解析不到；
/// - `ok`：绝对路径存在，或裸命令名可解析（裸名合法，分发时才绝对化，不误报）。
/// None = 不判：空命令 / $VAR 引用式命令（宿主环境展开，静态判不了）/ 非 stdio。
fn command_path_status(command: &str) -> Option<&'static str> {
    let c = command.trim();
    if c.is_empty() || env_ref(c).is_some() {
        return None;
    }
    if is_relative_command(c) {
        return Some("relative");
    }
    let looks_like_path =
        c.contains('/') || c.contains('\\') || (c.len() >= 2 && c.as_bytes()[1] == b':');
    if looks_like_path {
        return Some(if Path::new(c).exists() {
            "ok"
        } else {
            "missing"
        });
    }
    Some(if crate::agents::resolve_binary(c).is_some() {
        "ok"
    } else {
        "missing"
    })
}

/// 清单全量命令路径探测（只读；MCP 页告警徽标数据源）：
/// stdio server id → "ok" | "relative" | "missing"；不判的条目不进 map
#[tauri::command]
pub async fn mcp_command_path_status() -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let list = read_store()?;
        Ok(list
            .iter()
            .filter(|s| s.kind == "stdio")
            .filter_map(|s| {
                command_path_status(&s.command).map(|st| (s.id.clone(), st.to_string()))
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 相对路径命令的一键修复候选（MCP 页「修复为绝对路径」）：与收编同一套 resolver，
/// 来源 agent 从 origin（imported:<agent>）推断以启用配置家目录/插件目录基准；
/// 空 vec = 无命中（前端提示手工编辑），多候选由前端弹层交给用户选
#[tauri::command]
pub async fn resolve_mcp_command_fix(id: String) -> Result<Vec<McpCommandFix>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let list = read_store()?;
        let Some(server) = list.iter().find(|s| s.id == id) else {
            return Err("该 server 不存在（可能已删除）".into());
        };
        if server.kind != "stdio" || !is_relative_command(&server.command) {
            return Ok(Vec::new());
        }
        let agent = server
            .origin
            .strip_prefix("imported:")
            .filter(|a| *a != "json" && crate::agent_specs::agent_spec(a).is_some());
        Ok(resolve_relative_candidates(
            &server.command,
            &server.cwd,
            agent,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}
