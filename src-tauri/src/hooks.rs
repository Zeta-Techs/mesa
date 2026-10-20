//! 精确注意力标记（agent hooks 桥接）：用户按 agent 显式开启后，向各家 CLI 的 hooks 配置
//! 写入三个事件（工作中/已完成/待确认）的命令条目，CLI 每次触发事件时把原始事件 JSON
//! （带 unix 时间戳前缀）追加到 <config>/ccode/hooks-state/<tag>-hooks.jsonl。
//! sessions 的注意力分类对已开启的 agent 优先读该日志（双键匹配取最新事件），比尾部文本
//! 推断精确；日志缺失/过期（>10 分钟无更新）自动回落尾部推断。
//! 写各家配置遵守 global_config 同款约定：写前备份、原子写、只动 hooks 段、
//! 用户已有 hooks 合并而非覆盖、移除时只删含本日志路径（marker）的条目、配置损坏拒绝写入。
//! 每 agent 一张桥接规格（BRIDGE_SPECS），读写引擎共用；cursor/opencode 无可用形态，不在表内。

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 状态日志过期阈值：超过 10 分钟无事件视为失效，回落尾部推断
const HOOKS_TTL_SECS: i64 = 10 * 60;
/// 读取日志的尾部窗口（日志只增不删，分类只看尾部即可）
const LOG_TAIL_WINDOW: u64 = 256 * 1024;
/// 同前缀备份保留份数
const BACKUP_KEEP: usize = 10;
/// kimi [[hooks]] 的 timeout 字段（strict 四字段之一，多写字段会导致整个配置加载失败）
const KIMI_HOOK_TIMEOUT: i64 = 30;

/// 配置文件文档族：决定读-改-写的内核
#[derive(Clone, Copy, PartialEq)]
enum DocFamily {
    /// 含 hooks 键的设置文档；tolerant = JSONC 容错读（qwen/gemini 容忍注释与尾逗号）
    SettingsJson { tolerant: bool },
    /// 整文件归我们的 hooks 文件（grok）：开启=写文件，关闭=删文件，外来文件拒绝覆盖
    HooksFileJson,
    /// kimi config.toml 的 [[hooks]] 扁平表（toml_edit 保留其余键原样）
    KimiToml,
}

/// 每 agent 一张桥接规格（事件名/matcher 为 matrix 源码级调研结论）
struct BridgeSpec {
    /// agent id（同 agent_specs 注册表）
    agent: &'static str,
    /// 配置文件（相对 home）
    config_rel: &'static str,
    /// 状态日志/备份命名用短标签（claude 沿用既有 claude-hooks.jsonl 文件名与备份前缀）
    log_tag: &'static str,
    family: DocFamily,
    /// (事件名, matcher) × [working, done, confirm] 三槽
    events: [(&'static str, &'static str); 3],
    /// codex：handler 额外带 "async": true
    handler_async: bool,
}

impl BridgeSpec {
    /// 报错文案用的展示路径
    fn display(&self) -> String {
        format!("~/{}", self.config_rel)
    }
    /// 识别「我们的条目」的子串：命令里含状态日志路径，移除时只删含此子串的命令
    /// （恒为正斜杠形态，匹配前把候选命令的反斜杠归一化——Windows 命令内路径是反斜杠分隔）
    fn marker(&self) -> String {
        format!("hooks-state/{}-hooks.jsonl", self.log_tag)
    }
}

static BRIDGE_SPECS: &[BridgeSpec] = &[
    BridgeSpec {
        agent: "claude-code",
        config_rel: ".claude/settings.json",
        log_tag: "claude",
        family: DocFamily::SettingsJson { tolerant: false },
        events: [("UserPromptSubmit", ""), ("Stop", ""), ("Notification", "")],
        handler_async: false,
    },
    BridgeSpec {
        agent: "qwen",
        config_rel: ".qwen/settings.json",
        log_tag: "qwen",
        family: DocFamily::SettingsJson { tolerant: true },
        events: [
            ("UserPromptSubmit", ""),
            ("Stop", ""),
            ("Notification", "permission_prompt|idle_prompt"),
        ],
        handler_async: false,
    },
    BridgeSpec {
        agent: "codebuddy",
        config_rel: ".codebuddy/settings.json",
        log_tag: "codebuddy",
        family: DocFamily::SettingsJson { tolerant: false },
        events: [
            ("UserPromptSubmit", ""),
            ("Stop", ""),
            ("Notification", "permission_prompt|idle_prompt"),
        ],
        handler_async: false,
    },
    BridgeSpec {
        agent: "gemini",
        config_rel: ".gemini/settings.json",
        log_tag: "gemini",
        family: DocFamily::SettingsJson { tolerant: true },
        events: [
            ("BeforeAgent", ""),
            ("AfterAgent", ""),
            ("Notification", "*"),
        ],
        handler_async: false,
    },
    BridgeSpec {
        agent: "kimi",
        config_rel: ".kimi-code/config.toml",
        log_tag: "kimi",
        family: DocFamily::KimiToml,
        events: [
            ("UserPromptSubmit", ""),
            ("Stop", ""),
            ("PermissionRequest", ""),
        ],
        handler_async: false,
    },
    BridgeSpec {
        agent: "grok",
        config_rel: ".grok/hooks/ccode.json",
        log_tag: "grok",
        family: DocFamily::HooksFileJson,
        events: [
            ("UserPromptSubmit", ""),
            ("Stop", ""),
            ("Notification", "permission_prompt|idle_prompt"),
        ],
        handler_async: false,
    },
    BridgeSpec {
        agent: "codex",
        config_rel: ".codex/hooks.json",
        log_tag: "codex",
        family: DocFamily::SettingsJson { tolerant: false },
        events: [
            ("UserPromptSubmit", ""),
            ("Stop", ""),
            ("PermissionRequest", ""),
        ],
        handler_async: true,
    },
];

fn spec_for(agent: &str) -> Option<&'static BridgeSpec> {
    BRIDGE_SPECS.iter().find(|s| s.agent == agent)
}

fn hooks_state_dir() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("hooks-state"))
}

fn hooks_log_path(spec: &BridgeSpec) -> Result<PathBuf, String> {
    Ok(hooks_state_dir()?.join(format!("{}-hooks.jsonl", spec.log_tag)))
}

fn backups_dir() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("backups"))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ===== hook 命令构造 =====

#[cfg(not(windows))]
fn shell_quote(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\'', "'\\''"))
}

/// Windows hook 脚本文件名：与状态日志同目录（hooks-state/），七家共用一份，日志路径走参数
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const WIN_HOOK_SCRIPT: &str = "ccode-hook.ps1";

/// Windows hook 脚本正文：读 stdin 事件 JSON，加 unix 秒前缀后单行追加到参数给的日志。
///
/// 读写都必须显式钉 UTF-8，不能用 [Console]::In / Add-Content：那两者按系统 ANSI
/// 代码页（中文机器 = GBK936）解码再编码，UTF-8 的中文字节被错位配对后会把紧跟的
/// ASCII 字符当 trail byte 吞掉。实测 {"message":"新项目"} 往返后闭合引号消失，
/// serde_json 解析失败 ⇒ 整条 hook 记录被丢弃（transcript_path 一旦中招，
/// grok 这类只能靠它归属会话的 agent 会永久丢失精确注意力标记）。
/// 用 UTF8Encoding::new($false) 而非 -Encoding utf8：PS 5.1 的后者会写 BOM，
/// 首行多出 U+FEFF 会让读取侧的 unix 秒 parse::<i64>() 失败。\s+ 折叠换行保证一行一条记录。
/// 正文保持纯 ASCII：PS 5.1 按 ANSI 代码页读无 BOM 脚本，ASCII 在任何代码页下都无损。
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const WIN_HOOK_SCRIPT_BODY: &str = "param([string]$LogPath)\r\n\
$u = New-Object Text.UTF8Encoding $false\r\n\
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($LogPath))\r\n\
$l = (New-Object IO.StreamReader ([Console]::OpenStandardInput()), $u).ReadToEnd()\r\n\
$ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()\r\n\
[IO.File]::AppendAllText($LogPath, ($ts.ToString() + ' ' + ($l -replace '\\s+', ' ') + [Environment]::NewLine), $u)\r\n";

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn win_hook_script_path(log_path: &Path) -> PathBuf {
    log_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(WIN_HOOK_SCRIPT)
}

/// 命令行里的路径：正斜杠 + 双引号。正斜杠 PowerShell 照认，又不会被 bash 双引号当转义；
/// 不含 `$`/反引号/单引号，bash、cmd、PowerShell 三种宿主 shell 解析结果一致
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn win_cmdline_path(p: &Path) -> String {
    let plain = crate::paths::strip_verbatim(p.to_path_buf());
    format!(
        "\"{}\"",
        plain.to_string_lossy().replace('\\', "/").replace('"', "")
    )
}

/// 写（覆盖）Windows hook 脚本；开启时调用，保证脚本与当前版本正文一致
#[cfg(windows)]
fn write_win_hook_script(log_path: &Path) -> Result<(), String> {
    let script = win_hook_script_path(log_path);
    if let Some(dir) = script.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建 {} 失败: {e}", dir.display()))?;
    }
    crate::profiles::atomic_write(&script, WIN_HOOK_SCRIPT_BODY)
}

/// hook 命令：读 stdin 事件 JSON，加 unix 秒前缀后单行追加到状态日志。
/// unix 走 sh（各 CLI 以 sh -c 执行），命令内 mkdir -p 兜底目录不存在。
///
/// Windows 各家 CLI 用不同宿主 shell 跑 hook：Claude Code 走 Git Bash，Gemini 走
/// `powershell -Command`，Qwen 等经 Node 走 `cmd /d /s /c`。内联 `-Command "$d=…"` 的旧写法
/// 在 bash 里 `$变量` 被提前展开、在 cmd/PowerShell 里内层引号被拆，日志一行都写不出来。
/// 现在逻辑全放进 hooks-state/ccode-hook.ps1，命令行只剩两个双引号路径，三种宿主都原样传参。
/// 日志路径作为参数留在命令里——marker 识别（更新/移除我们的条目）照旧生效，新旧两种写法都认。
fn hook_command(log_path: &Path) -> String {
    #[cfg(not(windows))]
    {
        let log = shell_quote(log_path);
        let dir = shell_quote(log_path.parent().unwrap_or_else(|| Path::new(".")));
        format!(
            "umask 077; mkdir -p {dir}; {{ printf '%s ' \"$(date +%s)\"; cat; printf '\\n'; }} >> {log}"
        )
    }
    #[cfg(windows)]
    {
        win_hook_command(log_path)
    }
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn win_hook_command(log_path: &Path) -> String {
    format!(
        "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File {} {}",
        win_cmdline_path(&win_hook_script_path(log_path)),
        win_cmdline_path(log_path)
    )
}

// ===== JSON 文档族（settings.json / hooks.json）：hooks 段合并/移除（纯函数） =====

fn parse_json_doc(existing: Option<&str>, spec: &BridgeSpec) -> Result<Value, String> {
    let display = spec.display();
    let v: Value = match existing.map(crate::mcp::strip_bom) {
        Some(t) if !t.trim().is_empty() => {
            // qwen/gemini 的 settings.json 实为 JSONC：先去注释与尾逗号（mcp.rs 同款容错读）
            let text = match spec.family {
                DocFamily::SettingsJson { tolerant: true } => crate::mcp::strip_jsonc(t),
                _ => t.to_string(),
            };
            serde_json::from_str(&text)
                .map_err(|e| format!("{display} 不是合法 JSON，已停止写入以免破坏: {e}"))?
        }
        _ => json!({}),
    };
    if !v.is_object() {
        return Err(format!("{display} 根节点不是对象，已停止写入"));
    }
    Ok(v)
}

fn to_pretty(v: &Value) -> Result<String, String> {
    let mut s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    s.push('\n');
    Ok(s)
}

/// 事件组里我们追加的 handler；codex 额外带 "async": true
fn handler_json(spec: &BridgeSpec, command: &str) -> Value {
    let mut h = json!({ "type": "command", "command": command });
    if spec.handler_async {
        h.as_object_mut()
            .unwrap()
            .insert("async".into(), json!(true));
    }
    h
}

/// 从事件组数组中剔除我们的条目；组内 hooks 清空则整组删除
fn strip_marker_entries(arr: &mut Vec<Value>, marker: &str) {
    arr.retain_mut(|group| {
        if let Some(hooks) = group.get_mut("hooks").and_then(|h| h.as_array_mut()) {
            hooks.retain(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    // Windows 命令内路径是反斜杠分隔，归一化后再匹配 marker，否则关开关删不掉条目
                    .is_none_or(|c| !c.replace('\\', "/").contains(marker))
            });
            !hooks.is_empty()
        } else {
            true // 不是标准组结构的用户条目，原样保留
        }
    });
}

/// 合并：保留其他配置键与用户已有 hooks，三个事件各追加一条我们的命令；重复调用幂等
fn merge_json_doc(
    spec: &BridgeSpec,
    existing: Option<&str>,
    command: &str,
) -> Result<String, String> {
    let mut v = parse_json_doc(existing, spec)?;
    if let Some(h) = v.get("hooks") {
        if !h.is_object() {
            return Err(format!(
                "{} 的 hooks 字段不是对象，已停止写入",
                spec.display()
            ));
        }
    }
    let hooks = v
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().unwrap();
    let marker = spec.marker();
    for &(event, matcher) in spec.events.iter() {
        if let Some(e) = hooks.get(event) {
            if !e.is_array() {
                return Err(format!("hooks.{event} 不是数组，已停止写入"));
            }
        }
        let arr = hooks
            .entry(event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap();
        strip_marker_entries(arr, &marker); // 幂等：先清旧条目再追加
        arr.push(json!({
            "matcher": matcher,
            "hooks": [handler_json(spec, command)]
        }));
    }
    to_pretty(&v)
}

/// 移除：只删含 marker 的命令条目；事件数组/hooks 对象清空后回收空壳键，其余原样保留
fn remove_json_doc(spec: &BridgeSpec, existing: Option<&str>) -> Result<String, String> {
    let mut v = parse_json_doc(existing, spec)?;
    let Some(hooks) = v.get_mut("hooks") else {
        return to_pretty(&v); // 本来就没有 hooks 段
    };
    if !hooks.is_object() {
        return Err(format!(
            "{} 的 hooks 字段不是对象，已停止写入",
            spec.display()
        ));
    }
    let hooks = hooks.as_object_mut().unwrap();
    let marker = spec.marker();
    let events: Vec<String> = hooks.keys().cloned().collect();
    for event in events {
        if let Some(arr) = hooks.get_mut(&event).and_then(|e| e.as_array_mut()) {
            strip_marker_entries(arr, &marker);
            if arr.is_empty() {
                hooks.remove(&event);
            }
        }
    }
    if hooks.is_empty() {
        v.as_object_mut().unwrap().remove("hooks");
    }
    to_pretty(&v)
}

// ===== kimi TOML 文档族（[[hooks]] 扁平表，strict 四字段） =====

fn parse_toml_doc(existing: Option<&str>, display: &str) -> Result<toml_edit::DocumentMut, String> {
    crate::mcp::strip_bom(existing.unwrap_or(""))
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("{display} 解析失败，已停止写入以免破坏: {e}"))
}

/// 剔除 command 含 marker 的 [[hooks]] 条目
fn strip_toml_marker_entries(arr: &mut toml_edit::ArrayOfTables, marker: &str) {
    let drop: Vec<usize> = arr
        .iter()
        .enumerate()
        .filter(|(_, t)| {
            t.get("command")
                .and_then(|c| c.as_str())
                .is_some_and(|c| c.replace('\\', "/").contains(marker))
        })
        .map(|(i, _)| i)
        .collect();
    for i in drop.into_iter().rev() {
        arr.remove(i);
    }
}

/// kimi 合并：[[hooks]] 每事件一条 strict 四字段；其余键（providers/models 等）原样保留；幂等
fn merge_kimi_toml(
    spec: &BridgeSpec,
    existing: Option<&str>,
    command: &str,
) -> Result<String, String> {
    use toml_edit::value;
    let mut doc = parse_toml_doc(existing, &spec.display())?;
    if let Some(item) = doc.get("hooks") {
        if item.as_array_of_tables().is_none() {
            return Err(format!(
                "{} 的 hooks 字段不是数组表，已停止写入",
                spec.display()
            ));
        }
    }
    if doc.get("hooks").is_none() {
        doc["hooks"] = toml_edit::Item::ArrayOfTables(toml_edit::ArrayOfTables::new());
    }
    let arr = doc["hooks"].as_array_of_tables_mut().unwrap();
    strip_toml_marker_entries(arr, &spec.marker()); // 幂等：先清旧条目再追加
    for &(event, matcher) in spec.events.iter() {
        let mut t = toml_edit::Table::new();
        t["event"] = value(event);
        t["matcher"] = value(matcher);
        t["command"] = value(command);
        t["timeout"] = value(KIMI_HOOK_TIMEOUT);
        arr.push(t);
    }
    Ok(doc.to_string())
}

/// kimi 移除：只删含 marker 的 [[hooks]] 条目；清空后回收 hooks 键，其余原样保留
fn remove_kimi_toml(spec: &BridgeSpec, existing: Option<&str>) -> Result<String, String> {
    let mut doc = parse_toml_doc(existing, &spec.display())?;
    let Some(item) = doc.get_mut("hooks") else {
        return Ok(doc.to_string()); // 本来就没有 hooks 段
    };
    let Some(arr) = item.as_array_of_tables_mut() else {
        return Err(format!(
            "{} 的 hooks 字段不是数组表，已停止写入",
            spec.display()
        ));
    };
    strip_toml_marker_entries(arr, &spec.marker());
    if arr.is_empty() {
        doc.as_table_mut().remove("hooks");
    }
    Ok(doc.to_string())
}

// ===== grok 整文件族（~/.grok/hooks/ccode.json 归我们） =====

/// grok hooks 文件全文：与 claude 同款的「hooks 键 → 事件 → 组」结构，无其他键需要合并
fn whole_file_doc(spec: &BridgeSpec, command: &str) -> Result<String, String> {
    let mut hooks = serde_json::Map::new();
    for &(event, matcher) in spec.events.iter() {
        hooks.insert(
            event.into(),
            json!([{ "matcher": matcher, "hooks": [handler_json(spec, command)] }]),
        );
    }
    to_pretty(&json!({ "hooks": hooks }))
}

fn has_marker(text: &str, marker: &str) -> bool {
    // JSON 文本里 Windows 路径分隔符被转义成两个字符 \\：必须先按对归一，
    // 否则单字符替换会得到双斜杠（C://..//hooks-state//...）匹配不上 marker
    text.replace("\\\\", "/")
        .replace('\\', "/")
        .contains(marker)
}

// ===== 备份与事务写入 =====

/// 读现有配置：不存在/空白 = None；BOM 剥掉（写回不带 BOM，原字节由备份保留）。
/// 读失败（非 UTF-8、无权限等）必须报错停写——当成「不存在」会拿只含 hooks 的新文件
/// 覆盖掉用户整份配置，且因 existing=None 连备份都不做（global_config 同口径）。
fn read_existing(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(t) => {
            let t = crate::mcp::strip_bom(&t);
            Ok((!t.trim().is_empty()).then(|| t.to_string()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!(
            "读取 {} 失败，已停止写入以免覆盖: {e}",
            path.display()
        )),
    }
}

/// 写前备份到 <config>/ccode/backups/<tag>-hooks-settings-<纳秒>.<ext>，按前缀保留最近 N 份
/// （纳秒后缀保证同秒内连续开/关两次也各留一份，不会被同名覆盖；claude 沿用既有前缀，
/// 历史备份仍按同一前缀参与轮换）
fn backup_config(spec: &BridgeSpec, backups: &Path, config: &Path) -> Result<(), String> {
    fs::create_dir_all(backups).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let ext = if spec.family == DocFamily::KimiToml {
        "toml"
    } else {
        "json"
    };
    let prefix = format!("{}-hooks-settings-", spec.log_tag);
    let dst = backups.join(format!("{prefix}{nanos:020}.{ext}"));
    fs::copy(config, &dst).map_err(|e| format!("备份 {} 失败: {e}", spec.display()))?;
    let mut olds: Vec<PathBuf> = fs::read_dir(backups)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with(&prefix))
                })
                .collect()
        })
        .unwrap_or_default();
    olds.sort();
    for p in olds.iter().take(olds.len().saturating_sub(BACKUP_KEEP)) {
        fs::remove_file(p).ok();
    }
    Ok(())
}

/// 旧版 Windows 钩子特征：内联 `powershell -Command "$d=…"`（JSON / TOML 转义后子串仍在）
#[cfg(any(windows, test))]
fn is_legacy_win_hook(config_text: &str) -> bool {
    config_text.contains("-Command") && config_text.contains("$d=") && config_text.contains("hooks-state")
}

/// Windows 老用户迁移：旧版内联钩子在 bash / PowerShell 宿主下会被吞掉 `$变量`、从不生效。
/// 启动时对开关已开的 agent，配置里仍是旧写法才按新写法重写一次（apply_hooks_at 自带备份 +
/// 替换旧条目）；已是新写法不动，不会每次启动多出一份备份。失败只记日志，不挡启动
#[cfg(windows)]
pub(crate) fn migrate_legacy_windows_hooks() {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let Ok(backups) = backups_dir() else {
        return;
    };
    let settings = crate::settings::read_current();
    for s in crate::agent_specs::all_agent_specs() {
        let Some(spec) = spec_for(s.id) else {
            continue;
        };
        if !crate::settings::hooks_attention_enabled(&settings, s.id) {
            continue;
        }
        let Ok(text) = fs::read_to_string(home.join(spec.config_rel)) else {
            continue;
        };
        if !is_legacy_win_hook(&text) {
            continue;
        }
        let result = hooks_log_path(spec)
            .and_then(|log| apply_hooks_at(spec, &home, &log, &backups, true));
        if let Err(e) = result {
            crate::logbuf::record("warn", "hooks", &format!("{} 旧版钩子迁移失败: {e}", s.id));
        }
    }
}

/// 应用开关：enabled=true 合并 hooks 配置，false 移除我们的条目；写前备份 + 原子写。
/// 关闭时顺带清理状态日志；未安装过（文件不存在）时关闭是无操作。
/// grok 整文件形态：开启=写文件（已存在且不含 marker 则报错拒绝覆盖），关闭=删文件。
fn apply_hooks_at(
    spec: &BridgeSpec,
    home: &Path,
    log_path: &Path,
    backups: &Path,
    enabled: bool,
) -> Result<(), String> {
    let config_path = home.join(spec.config_rel);
    let marker = spec.marker();
    #[cfg(windows)]
    if enabled {
        write_win_hook_script(log_path)?;
    }
    if spec.family == DocFamily::HooksFileJson {
        if enabled {
            let existing = read_existing(&config_path)?;
            if let Some(t) = &existing {
                if !has_marker(t, &marker) {
                    return Err(format!(
                        "{} 已存在且不是本应用写入的（不含标记），为避免误删他人配置已拒绝覆盖",
                        spec.display()
                    ));
                }
                backup_config(spec, backups, &config_path)?;
            }
            if let Some(parent) = config_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("创建 {} 失败: {e}", parent.display()))?;
            }
            crate::profiles::atomic_write(
                &config_path,
                &whole_file_doc(spec, &hook_command(log_path))?,
            )?;
            return Ok(());
        }
        // 关闭：读不了的文件（非 UTF-8 等）不可能是我们写的，按「不是我们的」处理
        return match read_existing(&config_path).unwrap_or(None) {
            None => Ok(()), // 未安装过：无操作
            Some(t) if has_marker(&t, &marker) => {
                backup_config(spec, backups, &config_path)?;
                fs::remove_file(&config_path)
                    .map_err(|e| format!("删除 {} 失败: {e}", spec.display()))?;
                fs::remove_file(log_path).ok(); // 关闭即清理状态日志，避免残留状态被误读
                Ok(())
            }
            // 文件不是我们的：不动它，只清状态日志
            Some(_) => {
                fs::remove_file(log_path).ok();
                Ok(())
            }
        };
    }
    let existing = read_existing(&config_path)?;
    if !enabled && existing.is_none() {
        return Ok(());
    }
    let content = if enabled {
        let command = hook_command(log_path);
        match spec.family {
            DocFamily::KimiToml => merge_kimi_toml(spec, existing.as_deref(), &command)?,
            _ => merge_json_doc(spec, existing.as_deref(), &command)?,
        }
    } else {
        match spec.family {
            DocFamily::KimiToml => remove_kimi_toml(spec, existing.as_deref())?,
            _ => remove_json_doc(spec, existing.as_deref())?,
        }
    };
    if existing.is_some() {
        backup_config(spec, backups, &config_path)?;
    }
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 {} 失败: {e}", parent.display()))?;
    }
    crate::profiles::atomic_write(&config_path, &content)?;
    if !enabled {
        fs::remove_file(log_path).ok(); // 关闭即清理状态日志，避免残留状态被误读
    }
    Ok(())
}

// ===== 状态日志读取（注意力分类数据源） =====

struct HookRecord {
    ts: i64,
    session_id: String,
    transcript_path: Option<String>,
    /// 归一化事件名（去下划线 + 全小写；grok 值是 snake_case，其余 PascalCase）
    event: String,
    reason: Option<String>,
    /// 「在等什么」的人类可读摘要（claude Notification 的 message、PermissionRequest 的工具名等）；
    /// 尽力提取，schema 各家不同且未文档化，取不到就 None
    detail: Option<String>,
}

fn normalize_event(raw: &str) -> String {
    raw.chars()
        .filter(|c| *c != '_')
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 归一化事件 → 注意力状态；一张表覆盖七家桥接的全部事件名
fn event_state(normalized: &str) -> Option<&'static str> {
    match normalized {
        "userpromptsubmit" | "beforeagent" => Some("working"),
        // 回合确定结束：同会话文件里的 turn_duration / task_complete 判 settled，前端不再等 PTY 静下来
        // （2026-10-18 用户截图：Codex 开着精确注意力，回答落盘后聊天层仍「正在回复」）
        "stop" | "afteragent" => Some("settled"),
        "notification" | "permissionrequest" => Some("confirm"),
        _ => None,
    }
}

/// 防御式解析日志：一行一条 `<unix秒> <事件JSON>`；容忍坏行、末行截断与 pretty JSON 续行
/// （hook stdin 若非单行 JSON，续行拼回上一条记录再解析）。
/// 信封兼容：claude/qwen/codebuddy/gemini/codex/kimi 用 snake_case 键，grok 用 camelCase 键。
fn parse_log_records(text: &str) -> Vec<HookRecord> {
    fn push(out: &mut Vec<HookRecord>, buf: &str) {
        let Some((ts_s, body)) = buf.split_once(' ') else {
            return;
        };
        let Ok(ts) = ts_s.parse::<i64>() else { return };
        let Ok(v) = serde_json::from_str::<Value>(body) else {
            return;
        };
        let get = |snake: &str, camel: &str| {
            v.get(snake)
                .or_else(|| v.get(camel))
                .and_then(|x| x.as_str())
        };
        let (Some(sid), Some(ev)) = (
            get("session_id", "sessionId"),
            get("hook_event_name", "hookEventName"),
        ) else {
            return;
        };
        out.push(HookRecord {
            ts,
            session_id: sid.to_string(),
            transcript_path: get("transcript_path", "transcriptPath").map(String::from),
            event: normalize_event(ev),
            reason: v.get("reason").and_then(|x| x.as_str()).map(String::from),
            // 「在等什么」详情：各家 payload 字段未文档化，按已知形态尽力提取——
            // claude/qwen/codebuddy/gemini Notification 有 message；kimi/codex PermissionRequest
            // 可能带 tool_name/title；都取不到就 None（横幅退回通用文案）
            detail: ["message", "tool_name", "toolName", "title"]
                .iter()
                .find_map(|k| v.get(*k).and_then(|x| x.as_str()))
                .map(String::from),
        });
    }
    let mut out = Vec::new();
    let mut buf = String::new();
    for line in text.lines() {
        let starts_record = line
            .split_once(' ')
            .is_some_and(|(head, _)| head.parse::<i64>().is_ok());
        if starts_record {
            if !buf.is_empty() {
                push(&mut out, &buf);
            }
            buf = line.to_string();
        } else if !buf.is_empty() {
            buf.push_str(line); // pretty JSON 续行
        }
    }
    if !buf.is_empty() {
        push(&mut out, &buf);
    }
    out
}

/// 取该会话最新事件映射的注意力状态与详情；无记录或最新事件已过期（>TTL）返回 None（回落尾部推断）。
/// 会话归属双键匹配：记录 session_id == 会话文件主名，或 transcript_path == 会话文件完整路径
/// （grok 会话文件主名恒为 updates，必须靠 transcript_path 命中；kimi 无 transcript_path 自然只用前者）。
/// grok 的 Stop 在会话 teardown 时会以 reason=shutdown/channel_closed 重复 fire：
/// stop 事件只认 reason 缺失或 "end_turn" 的记录，其余 reason 跳过不更新状态。
fn latest_from_text(
    text: &str,
    session_id: &str,
    file_path: &str,
    now: i64,
) -> Option<(&'static str, Option<String>)> {
    let mut best: Option<(i64, &'static str, Option<String>)> = None;
    for rec in parse_log_records(text) {
        if rec.session_id != session_id
            && !rec
                .transcript_path
                .as_deref()
                .is_some_and(|p| crate::paths::same_path(p, file_path))
        {
            continue;
        }
        if rec.event == "stop" && rec.reason.as_deref().is_some_and(|r| r != "end_turn") {
            continue;
        }
        let Some(state) = event_state(&rec.event) else {
            continue;
        };
        if best.as_ref().is_none_or(|(ts, _, _)| rec.ts >= *ts) {
            best = Some((rec.ts, state, rec.detail));
        }
    }
    let (ts, state, detail) = best?;
    if now - ts > HOOKS_TTL_SECS {
        return None;
    }
    Some((state, detail))
}

fn state_from_text(text: &str, session_id: &str, file_path: &str, now: i64) -> Option<String> {
    latest_from_text(text, session_id, file_path, now).map(|(state, _)| state.to_string())
}

fn read_log_tail(path: &Path) -> String {
    let Ok(mut f) = fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len > LOG_TAIL_WINDOW && f.seek(SeekFrom::Start(len - LOG_TAIL_WINDOW)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// sessions::tail_state_impl 的精确标记融合入口：
/// 仅当 agent 在桥接注册表内、设置开启、且日志内有该会话的未过期事件时返回精确状态，
/// 其余情况 None 回落尾部推断。
pub(crate) fn state_for_session_file(agent: &str, file_path: &str) -> Option<String> {
    let spec = spec_for(agent)?;
    if !crate::settings::hooks_attention_enabled(&crate::settings::read_current(), agent) {
        return None;
    }
    let session_id = Path::new(file_path)
        .file_stem()?
        .to_string_lossy()
        .into_owned();
    if session_id.is_empty() {
        return None;
    }
    let log = hooks_log_path(spec).ok()?;
    state_from_text(&read_log_tail(&log), &session_id, file_path, now_unix())
}

// ===== Tauri commands =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookSupportDto {
    pub agent: String,
    pub supported: bool,
    /// 支持但有注意事项 / 不支持的原因；None = 支持且无额外提示
    pub note: Option<String>,
    /// 支持的 agent 的配置文件展示路径（设置页提示用）
    pub config_path: Option<String>,
}

/// 注意事项/不支持原因（None = 支持且无额外提示）
fn support_note(agent: &str) -> Option<&'static str> {
    match agent {
        "codex" => Some("首次生效需在 Codex /hooks 面板信任该 hook"),
        "codebuddy" => Some("已运行的会话需重启后生效"),
        "cursor" => Some("无「等待确认」原生事件，机制未实机验证"),
        "opencode" => Some("无 shell hooks 形态（仅 JS 插件），暂未接入"),
        _ => None,
    }
}

/// 设置页「精确注意力标记」列表：九家全列出，支持与否 + 备注
#[tauri::command]
pub async fn hooks_attention_support() -> Vec<HookSupportDto> {
    crate::agent_specs::all_agent_specs()
        .iter()
        .map(|s| {
            let spec = spec_for(s.id);
            HookSupportDto {
                agent: s.id.to_string(),
                supported: spec.is_some(),
                note: support_note(s.id).map(String::from),
                config_path: spec.map(|sp| sp.display()),
            }
        })
        .collect()
}

/// 聊天层审批卡片的数据源：当前「等待确认」事件的详情（如 claude 的
/// "Claude needs your permission to use Bash"，PermissionRequest 的工具名）。
/// 与 state_for_session_file 同一套门控（注册表/设置开关/归属匹配/TTL）；
/// 最新状态不是 confirm 或 payload 没带可读字段时返回 None（前端回落通用文案）。
#[tauri::command]
pub async fn session_confirm_detail(agent: String, file_path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let spec = spec_for(&agent)?;
        if !crate::settings::hooks_attention_enabled(&crate::settings::read_current(), &agent) {
            return None;
        }
        let session_id = Path::new(&file_path)
            .file_stem()?
            .to_string_lossy()
            .into_owned();
        if session_id.is_empty() {
            return None;
        }
        let log = hooks_log_path(spec).ok()?;
        let (state, detail) =
            latest_from_text(&read_log_tail(&log), &session_id, &file_path, now_unix())?;
        if state != "confirm" {
            return None;
        }
        detail
    })
    .await
    .ok()
    .flatten()
}

/// 设置页开关：先改该 agent 的 hooks 配置（备份+原子写），成功后记应用设置；
/// 应用设置写失败时回滚 hooks，避免开关显示与实际安装不一致。
#[tauri::command]
pub async fn set_hooks_attention(
    agent: String,
    enabled: bool,
) -> Result<crate::settings::AppSettingsDto, String> {
    let spec = spec_for(&agent).ok_or_else(|| format!("{agent} 暂不支持精确注意力标记"))?;
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    let log = hooks_log_path(spec)?;
    let backups = backups_dir()?;
    {
        let (h, l, b) = (home.clone(), log.clone(), backups.clone());
        tauri::async_runtime::spawn_blocking(move || apply_hooks_at(spec, &h, &l, &b, enabled))
            .await
            .map_err(|e| format!("切换精确注意力标记失败: {e}"))??;
    }
    match crate::settings::set_hooks_attention_entry(&agent, enabled) {
        Ok(full) => Ok(full),
        Err(e) => {
            tauri::async_runtime::spawn_blocking(move || {
                apply_hooks_at(spec, &home, &log, &backups, !enabled)
            })
            .await
            .ok();
            Err(format!("应用设置保存失败，已还原 {agent} hooks 配置: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-hooks-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn claude() -> &'static BridgeSpec {
        spec_for("claude-code").unwrap()
    }

    // ===== JSON 设置文档族（claude 为代表） =====

    #[test]
    fn merge_into_empty_creates_three_events_idempotent() {
        let spec = claude();
        let out = merge_json_doc(spec, None, "CMD hooks-state/claude-hooks.jsonl").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        for (event, _) in spec.events {
            let arr = v["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{event} 一条我们的条目");
            assert_eq!(
                arr[0]["hooks"][0]["command"],
                "CMD hooks-state/claude-hooks.jsonl"
            );
        }
        // 重复合并不叠加
        let out2 = merge_json_doc(spec, Some(&out), "CMD hooks-state/claude-hooks.jsonl").unwrap();
        let v2: Value = serde_json::from_str(&out2).unwrap();
        for (event, _) in spec.events {
            assert_eq!(
                v2["hooks"][event].as_array().unwrap().len(),
                1,
                "{event} 幂等"
            );
        }
    }

    #[test]
    fn merge_preserves_user_hooks_and_other_keys() {
        let existing = r#"{
            "env": {"FOO": "bar"},
            "hooks": {
                "Notification": [
                    {"matcher": "", "hooks": [{"type": "command", "command": "user-script"}]}
                ]
            }
        }"#;
        let out = merge_json_doc(
            claude(),
            Some(existing),
            "CMD hooks-state/claude-hooks.jsonl",
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["FOO"], "bar", "其他配置键保留");
        let notif = v["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 2, "用户条目保留 + 追加我们的");
        assert_eq!(notif[0]["hooks"][0]["command"], "user-script");
    }

    #[test]
    fn merge_and_remove_reject_broken_json() {
        assert!(merge_json_doc(claude(), Some("{broken"), "CMD").is_err());
        assert!(remove_json_doc(claude(), Some("{broken")).is_err());
        assert!(
            merge_json_doc(claude(), Some(r#"{"hooks": 42}"#), "CMD").is_err(),
            "hooks 非对象拒绝"
        );
        assert!(
            merge_json_doc(claude(), Some(r#"{"hooks": {"Stop": {"x": 1}}}"#), "CMD").is_err(),
            "事件非数组拒绝"
        );
    }

    #[test]
    fn remove_only_ours_and_cleans_empty_shells() {
        let existing = r#"{
            "env": {"FOO": "bar"},
            "hooks": {
                "Stop": [
                    {"matcher": "", "hooks": [{"type": "command", "command": "user-stop"}]},
                    {"matcher": "", "hooks": [
                        {"type": "command", "command": "x hooks-state/claude-hooks.jsonl y"},
                        {"type": "command", "command": "user-mixed"}
                    ]}
                ],
                "UserPromptSubmit": [
                    {"matcher": "", "hooks": [{"type": "command", "command": "x hooks-state/claude-hooks.jsonl"}]}
                ]
            }
        }"#;
        let out = remove_json_doc(claude(), Some(existing)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["FOO"], "bar");
        // Stop：我们的命令被剔除但同组的用户命令保留，组与用户组都在
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        let cmds: Vec<&str> = stop
            .iter()
            .flat_map(|g| g["hooks"].as_array().unwrap().iter())
            .map(|h| h["command"].as_str().unwrap())
            .collect();
        assert_eq!(cmds, ["user-stop", "user-mixed"], "只删我们的条目");
        // UserPromptSubmit 只剩我们的条目 → 事件键整体回收
        assert!(v["hooks"].get("UserPromptSubmit").is_none());
    }

    #[test]
    fn remove_drops_hooks_key_when_empty() {
        let existing = r#"{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "hooks-state/claude-hooks.jsonl"}]}]}}"#;
        let out = remove_json_doc(claude(), Some(existing)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("hooks").is_none(), "hooks 清空后回收键");
        // 本来就没有 hooks 段：原样（不报错）
        let out = remove_json_doc(claude(), Some(r#"{"env": {}}"#)).unwrap();
        assert!(serde_json::from_str::<Value>(&out)
            .unwrap()
            .get("hooks")
            .is_none());
    }

    /// qwen/gemini 容错读：带注释与尾逗号的 JSONC 可合并，其余键保留
    #[test]
    fn jsonc_tolerant_family_merges_comments_and_trailing_commas() {
        let existing = "{\n  // 用户注释\n  \"theme\": \"dark\",\n}\n";
        let out = merge_json_doc(
            spec_for("qwen").unwrap(),
            Some(existing),
            "CMD hooks-state/qwen-hooks.jsonl",
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["theme"], "dark", "JSONC 容错读且其他键保留");
        // qwen 的 Notification 带 matcher；其余事件空 matcher
        let notif = v["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif[0]["matcher"], "permission_prompt|idle_prompt");
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap()[0]["matcher"], "");
        // 容错族对真正的坏 JSON 同样拒绝
        assert!(merge_json_doc(spec_for("gemini").unwrap(), Some("{broken"), "CMD").is_err());
    }

    /// codex：handler 带 async:true，confirm 槽是 PermissionRequest
    #[test]
    fn codex_handlers_carry_async_and_permission_request() {
        let out = merge_json_doc(
            spec_for("codex").unwrap(),
            None,
            "CMD hooks-state/codex-hooks.jsonl",
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        for event in ["UserPromptSubmit", "Stop", "PermissionRequest"] {
            let arr = v["hooks"][event].as_array().unwrap();
            assert_eq!(
                arr[0]["hooks"][0]["async"], true,
                "{event} handler 带 async"
            );
        }
        assert!(
            v["hooks"].get("Notification").is_none(),
            "codex 不写 Notification"
        );
    }

    // ===== kimi TOML 文档族 =====

    #[test]
    fn kimi_toml_merge_strict_four_fields_preserves_other_keys() {
        let existing = "default_model = \"ccode\"\n\n[providers.ccode]\ntype = \"kimi\"\n";
        let out = merge_kimi_toml(
            spec_for("kimi").unwrap(),
            Some(existing),
            "sh hooks-state/kimi-hooks.jsonl",
        )
        .unwrap();
        let doc = out.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(
            doc["default_model"].as_str(),
            Some("ccode"),
            "其余键原样保留"
        );
        assert_eq!(doc["providers"]["ccode"]["type"].as_str(), Some("kimi"));
        let arr = doc["hooks"].as_array_of_tables().unwrap();
        assert_eq!(arr.len(), 3);
        let events: Vec<&str> = arr.iter().map(|t| t["event"].as_str().unwrap()).collect();
        assert_eq!(events, ["UserPromptSubmit", "Stop", "PermissionRequest"]);
        for t in arr.iter() {
            // strict 四字段，多写字段会导致 kimi 整个配置加载失败
            let keys: Vec<&str> = t.iter().map(|(k, _)| k).collect();
            assert_eq!(keys, ["event", "matcher", "command", "timeout"]);
            assert_eq!(t["timeout"].as_integer(), Some(30));
        }
        // 幂等：重复合并不叠加
        let out2 = merge_kimi_toml(
            spec_for("kimi").unwrap(),
            Some(&out),
            "sh hooks-state/kimi-hooks.jsonl",
        )
        .unwrap();
        let doc2 = out2.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(doc2["hooks"].as_array_of_tables().unwrap().len(), 3);
    }

    #[test]
    fn kimi_toml_remove_only_ours_and_rejects_misshaped() {
        let existing = "[x]\ny = 1\n\n[[hooks]]\nevent = \"Stop\"\nmatcher = \"\"\ncommand = \"user-cmd\"\ntimeout = 5\n\n[[hooks]]\nevent = \"Stop\"\nmatcher = \"\"\ncommand = \"sh hooks-state/kimi-hooks.jsonl\"\ntimeout = 30\n";
        let out = remove_kimi_toml(spec_for("kimi").unwrap(), Some(existing)).unwrap();
        let doc = out.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(doc["x"]["y"].as_integer(), Some(1), "其余键原样保留");
        let arr = doc["hooks"].as_array_of_tables().unwrap();
        assert_eq!(arr.len(), 1, "只删我们的条目");
        assert_eq!(arr.get(0).unwrap()["command"].as_str(), Some("user-cmd"));
        // 只剩我们的条目 → hooks 键整体回收
        let ours_only = "[[hooks]]\nevent = \"Stop\"\nmatcher = \"\"\ncommand = \"sh hooks-state/kimi-hooks.jsonl\"\ntimeout = 30\n";
        let out = remove_kimi_toml(spec_for("kimi").unwrap(), Some(ours_only)).unwrap();
        assert!(out
            .parse::<toml_edit::DocumentMut>()
            .unwrap()
            .get("hooks")
            .is_none());
        // hooks 不是数组表 → 拒绝
        assert!(
            merge_kimi_toml(spec_for("kimi").unwrap(), Some("[hooks]\nx = 1\n"), "CMD").is_err()
        );
        // 坏 TOML → 拒绝
        assert!(merge_kimi_toml(spec_for("kimi").unwrap(), Some("= broken"), "CMD").is_err());
    }

    // ===== grok 整文件族 =====

    #[test]
    fn grok_whole_file_create_delete_and_reject_foreign() {
        let dir = tmpdir("grok");
        let home = dir.join("home");
        let log = dir.join("hooks-state").join("grok-hooks.jsonl");
        let backups = dir.join("backups");
        let spec = spec_for("grok").unwrap();
        let config = home.join(spec.config_rel);

        // 开启：整文件创建，三事件组结构
        apply_hooks_at(spec, &home, &log, &backups, true).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
        for (event, _) in spec.events {
            assert!(v["hooks"][event].is_array(), "{event} 已写入");
        }
        assert_eq!(
            v["hooks"]["Notification"][0]["matcher"],
            "permission_prompt|idle_prompt"
        );

        // 重复开启：含 marker → 幂等重写 + 备份
        apply_hooks_at(spec, &home, &log, &backups, true).unwrap();
        assert_eq!(
            fs::read_dir(&backups).unwrap().count(),
            1,
            "覆盖我们的文件前备份"
        );

        // 外来文件（无 marker）：开启拒绝覆盖
        let foreign_home = dir.join("home2");
        let foreign = foreign_home.join(spec.config_rel);
        fs::create_dir_all(foreign.parent().unwrap()).unwrap();
        fs::write(&foreign, r#"{"hooks": {"Stop": []}}"#).unwrap();
        let err = apply_hooks_at(spec, &foreign_home, &log, &backups, true).unwrap_err();
        assert!(err.contains("拒绝覆盖"), "{err}");
        // 外来文件上关闭：不删文件
        apply_hooks_at(spec, &foreign_home, &log, &backups, false).ok();
        assert!(foreign.exists(), "外来文件不被删除");

        // 关闭：删文件 + 清状态日志 + 备份
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        fs::write(&log, "1 {}\n").unwrap();
        apply_hooks_at(spec, &home, &log, &backups, false).unwrap();
        assert!(!config.exists(), "关闭删整文件");
        assert!(!log.exists(), "关闭清理状态日志");
        fs::remove_dir_all(&dir).ok();
    }

    // ===== 日志解析 =====

    #[test]
    fn parse_log_records_tolerates_multiline_and_garbage() {
        let text = "not-a-record\n\
                    100 {\"session_id\": \"s1\", \"hook_event_name\": \"UserPromptSubmit\"}\n\
                    101 {\n  \"session_id\": \"s1\",\n  \"hook_event_name\": \"Stop\"\n}\n\
                    102 {broken json\n\
                    103 {\"hook_event_name\": \"Stop\"}\n";
        let recs = parse_log_records(text);
        assert_eq!(recs.len(), 2, "坏行与缺字段行跳过");
        assert_eq!(recs[0].ts, 100);
        assert_eq!(
            recs[1].event, "stop",
            "pretty JSON 续行拼回解析 + 事件名归一化"
        );
    }

    /// snake_case（claude 等）与 camelCase（grok）双信封都可解析
    #[test]
    fn parse_log_records_accepts_snake_and_camel_envelopes() {
        let text = "100 {\"session_id\": \"s1\", \"hook_event_name\": \"Notification\", \"transcript_path\": \"/t/a.jsonl\"}\n\
                    101 {\"sessionId\": \"s2\", \"hookEventName\": \"user_prompt_submit\", \"transcriptPath\": \"/t/b.jsonl\"}\n";
        let recs = parse_log_records(text);
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].session_id, "s1");
        assert_eq!(recs[0].transcript_path.as_deref(), Some("/t/a.jsonl"));
        assert_eq!(recs[1].session_id, "s2");
        assert_eq!(recs[1].event, "userpromptsubmit", "snake_case 事件值归一化");
        assert_eq!(recs[1].transcript_path.as_deref(), Some("/t/b.jsonl"));
    }

    /// 事件名归一化：七家全部事件名映射到三态
    #[test]
    fn event_state_covers_all_bridge_events() {
        for (raw, want) in [
            ("UserPromptSubmit", "working"),
            ("BeforeAgent", "working"),
            ("user_prompt_submit", "working"),
            ("Stop", "settled"),
            ("AfterAgent", "settled"),
            ("stop", "settled"),
            ("Notification", "confirm"),
            ("PermissionRequest", "confirm"),
            ("notification", "confirm"),
        ] {
            assert_eq!(event_state(&normalize_event(raw)), Some(want), "{raw}");
        }
        assert_eq!(event_state(&normalize_event("Whatever")), None);
    }

    #[test]
    fn state_from_text_latest_event_and_ttl() {
        let text = "100 {\"session_id\": \"s1\", \"hook_event_name\": \"UserPromptSubmit\"}\n\
                    200 {\"session_id\": \"s2\", \"hook_event_name\": \"Notification\"}\n\
                    300 {\"session_id\": \"s1\", \"hook_event_name\": \"Stop\"}\n";
        assert_eq!(
            state_from_text(text, "s1", "/x/s1.jsonl", 310).as_deref(),
            Some("settled"),
            "取最新事件"
        );
        assert_eq!(
            state_from_text(text, "s2", "/x/s2.jsonl", 310).as_deref(),
            Some("confirm")
        );
        assert_eq!(
            state_from_text(text, "s3", "/x/s3.jsonl", 310),
            None,
            "无记录 → None"
        );
        assert_eq!(
            state_from_text(text, "s1", "/x/s1.jsonl", 300 + HOOKS_TTL_SECS + 1),
            None,
            "过期 → None 回落尾部推断"
        );
        let working = "100 {\"session_id\": \"s1\", \"hook_event_name\": \"UserPromptSubmit\"}";
        assert_eq!(
            state_from_text(working, "s1", "/x/s1.jsonl", 120).as_deref(),
            Some("working")
        );
    }

    /// grok：Stop 只认 reason=end_turn（或无 reason）；shutdown/channel_closed 的 teardown 记录不更新状态
    #[test]
    fn grok_stop_reason_filter() {
        let text = "100 {\"sessionId\": \"s1\", \"hookEventName\": \"user_prompt_submit\"}\n\
                    200 {\"sessionId\": \"s1\", \"hookEventName\": \"stop\", \"reason\": \"end_turn\"}\n\
                    300 {\"sessionId\": \"s1\", \"hookEventName\": \"stop\", \"reason\": \"shutdown\"}\n";
        assert_eq!(
            state_from_text(text, "s1", "/x/updates.jsonl", 310).as_deref(),
            Some("settled"),
            "teardown 的 shutdown stop 跳过，取 end_turn"
        );
        // 只有 teardown 记录 → 最近有效事件仍是 working
        let torn = "100 {\"sessionId\": \"s1\", \"hookEventName\": \"user_prompt_submit\"}\n\
                    300 {\"sessionId\": \"s1\", \"hookEventName\": \"stop\", \"reason\": \"channel_closed\"}\n";
        assert_eq!(
            state_from_text(torn, "s1", "/x/updates.jsonl", 310).as_deref(),
            Some("working")
        );
        // 无 reason 的 stop（claude 等）照常认
        let plain = "100 {\"session_id\": \"s1\", \"hook_event_name\": \"Stop\"}";
        assert_eq!(
            state_from_text(plain, "s1", "/x/s1.jsonl", 110).as_deref(),
            Some("settled")
        );
    }

    /// 双键匹配：session_id 命中文件主名，或 transcript_path 命中完整路径
    /// （grok 会话文件主名恒为 updates，必须靠 transcriptPath 命中）
    #[test]
    fn dual_key_session_matching() {
        let text = "100 {\"sessionId\": \"grok-abc\", \"hookEventName\": \"notification\", \"transcriptPath\": \"/home/u/.grok/sessions/-proj/grok-abc/updates.jsonl\"}\n\
                    200 {\"session_id\": \"kimi-1\", \"hook_event_name\": \"PermissionRequest\"}\n";
        // grok：session_id 与主名 updates 不符，transcriptPath 完整路径命中
        assert_eq!(
            state_from_text(
                text,
                "updates",
                "/home/u/.grok/sessions/-proj/grok-abc/updates.jsonl",
                210
            )
            .as_deref(),
            Some("confirm"),
            "updates.jsonl 靠 transcriptPath 命中"
        );
        // 主名命中但 transcript 不符也算（其他会话的主名恰好叫 updates 时按前者口径）
        assert_eq!(
            state_from_text(
                text,
                "kimi-1",
                "/home/u/.kimi-code/sessions/kimi-1.jsonl",
                210
            )
            .as_deref(),
            Some("confirm"),
            "kimi 无 transcript_path，靠 session_id == 主名"
        );
        // 双键都不中 → None
        assert_eq!(
            state_from_text(text, "other", "/elsewhere/x.jsonl", 210),
            None
        );
        #[cfg(windows)]
        {
            let win = "100 {\"sessionId\": \"grok-abc\", \"hookEventName\": \"notification\", \"transcriptPath\": \"C:\\\\Users\\\\u\\\\.grok\\\\sessions\\\\proj\\\\updates.jsonl\"}\n";
            assert_eq!(
                state_from_text(
                    win,
                    "updates",
                    r"c:\users\u\.grok\sessions\proj\updates.jsonl",
                    110
                )
                .as_deref(),
                Some("confirm"),
                "Windows 下分隔符与盘符大小写差异仍应命中"
            );
        }
    }

    // ===== 事务写入（claude 为代表，覆盖备份/清理/无操作） =====

    #[test]
    fn apply_hooks_at_roundtrip_backup_and_cleanup() {
        let dir = tmpdir("roundtrip");
        let home = dir.join("home");
        let log = dir.join("hooks-state").join("claude-hooks.jsonl");
        let backups = dir.join("backups");
        let spec = claude();
        let settings = home.join(spec.config_rel);
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(&settings, r#"{"env": {"KEEP": "1"}}"#).unwrap();
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        fs::write(&log, "1 {}\n").unwrap();

        // 开启：hooks 写入、原文件被备份、其他键保留
        apply_hooks_at(spec, &home, &log, &backups, true).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["env"]["KEEP"], "1");
        assert!(v["hooks"]["Stop"].is_array());
        let baks: Vec<_> = fs::read_dir(&backups).unwrap().flatten().collect();
        assert_eq!(baks.len(), 1, "写前备份");
        assert!(
            baks[0]
                .file_name()
                .to_string_lossy()
                .starts_with("claude-hooks-settings-"),
            "备份前缀按 agent 区分（claude 沿用既有前缀）"
        );

        // 关闭：hooks 段移除、其他键保留、状态日志清理、再留一份备份
        apply_hooks_at(spec, &home, &log, &backups, false).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["env"]["KEEP"], "1");
        assert!(v.get("hooks").is_none());
        assert!(!log.exists(), "关闭清理状态日志");
        assert_eq!(fs::read_dir(&backups).unwrap().count(), 2);

        // 未安装过（文件不存在）时关闭 = 无操作
        let missing_home = dir.join("nope");
        apply_hooks_at(spec, &missing_home, &log, &backups, false).unwrap();
        assert!(!missing_home.join(spec.config_rel).exists());
        fs::remove_dir_all(&dir).ok();
    }

    /// kimi 端到端：config.toml 合并/移除走文件，备份用 .toml 扩展名
    #[test]
    fn apply_hooks_at_kimi_toml_roundtrip() {
        let dir = tmpdir("kimi");
        let home = dir.join("home");
        let log = dir.join("hooks-state").join("kimi-hooks.jsonl");
        let backups = dir.join("backups");
        let spec = spec_for("kimi").unwrap();
        let config = home.join(spec.config_rel);
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        fs::write(&config, "default_model = \"ccode\"\n").unwrap();

        apply_hooks_at(spec, &home, &log, &backups, true).unwrap();
        let text = fs::read_to_string(&config).unwrap();
        let doc = text.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(doc["default_model"].as_str(), Some("ccode"), "其余键保留");
        assert_eq!(doc["hooks"].as_array_of_tables().unwrap().len(), 3);
        let bak = fs::read_dir(&backups).unwrap().flatten().next().unwrap();
        assert!(
            bak.file_name()
                .to_string_lossy()
                .starts_with("kimi-hooks-settings-"),
            "备份前缀按 agent 区分"
        );
        assert!(bak.path().extension().is_some_and(|e| e == "toml"));

        apply_hooks_at(spec, &home, &log, &backups, false).unwrap();
        let doc = fs::read_to_string(&config)
            .unwrap()
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        assert!(doc.get("hooks").is_none(), "关闭后 hooks 键回收");
        assert_eq!(doc["default_model"].as_str(), Some("ccode"));
        fs::remove_dir_all(&dir).ok();
    }

    /// Windows 新命令形态：只有两个双引号路径，无 `$`/单引号；日志路径留在命令里，marker 照常命中；
    /// 旧版内联 `-Command "$d=…"` 条目在重新开启时被替换而不是叠加
    #[test]
    fn legacy_win_hook_detection_matches_old_form_only() {
        let old_json = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"powershell -NoProfile -Command \"$d='C:\\Users\\x\\AppData\\Roaming\\ccode\\hooks-state';\""}]}]}}"#;
        assert!(is_legacy_win_hook(old_json));
        let new_json = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"C:/x/hooks-state/ccode-hook.ps1\" \"C:/x/hooks-state/claude-hooks.jsonl\""}]}]}}"#;
        assert!(!is_legacy_win_hook(new_json));
        assert!(!is_legacy_win_hook("{}"));
    }

    /// 旧版内联 `-Command "$d=…"` 条目在重新开启时被替换而不是叠加
    #[test]
    fn win_hook_command_is_shell_neutral_and_replaces_old_form() {
        let (log, root) = if cfg!(windows) {
            (
                r"C:\Users\张 三\AppData\Roaming\ccode\hooks-state\claude-hooks.jsonl",
                "C:/Users/张 三/AppData/Roaming",
            )
        } else {
            (
                "/home/张 三/.config/ccode/hooks-state/claude-hooks.jsonl",
                "/home/张 三/.config",
            )
        };
        let cmd = win_hook_command(Path::new(log));
        assert_eq!(
            cmd,
            format!(
                "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \
                 \"{root}/ccode/hooks-state/ccode-hook.ps1\" \
                 \"{root}/ccode/hooks-state/claude-hooks.jsonl\""
            )
        );
        assert!(!cmd.contains('$') && !cmd.contains('\'') && !cmd.contains('\\'));
        let spec = claude();
        assert!(has_marker(&cmd, &spec.marker()));
        assert!(WIN_HOOK_SCRIPT_BODY.is_ascii(), "PS 5.1 按 ANSI 读无 BOM 脚本，正文必须纯 ASCII");

        let old = r#"powershell -NoProfile -Command "$d='C:\Users\x\AppData\Roaming\ccode\hooks-state';New-Item -ItemType Directory -Force -Path $d|Out-Null;$u=New-Object Text.UTF8Encoding $false;$l=(New-Object IO.StreamReader ([Console]::OpenStandardInput()),$u).ReadToEnd();[IO.File]::AppendAllText('C:\Users\x\AppData\Roaming\ccode\hooks-state\claude-hooks.jsonl',(([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()).ToString()+' '+($l -replace '\s+',' ')+[Environment]::NewLine),$u)""#;
        let existing = merge_json_doc(spec, None, old).unwrap();
        let out = merge_json_doc(spec, Some(&existing), &cmd).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        for (event, _) in spec.events {
            let arr = v["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{event} 旧条目被替换");
            assert_eq!(arr[0]["hooks"][0]["command"], cmd.as_str());
        }
        // 旧形态也能被关闭移除
        let removed = remove_json_doc(spec, Some(&existing)).unwrap();
        assert!(serde_json::from_str::<Value>(&removed).unwrap().get("hooks").is_none());
        // kimi TOML 同理
        let kimi = spec_for("kimi").unwrap();
        let old_kimi = old.replace("claude-hooks", "kimi-hooks");
        let new_kimi = cmd.replace("claude-hooks", "kimi-hooks");
        let t = merge_kimi_toml(kimi, None, &old_kimi).unwrap();
        let t = merge_kimi_toml(kimi, Some(&t), &new_kimi).unwrap();
        let doc = t.parse::<toml_edit::DocumentMut>().unwrap();
        let arr = doc["hooks"].as_array_of_tables().unwrap();
        assert_eq!(arr.len(), 3);
        assert!(arr
            .iter()
            .all(|h| h["command"].as_str() == Some(new_kimi.as_str())));
    }

    /// BOM 开头的配置（PowerShell 5.1 / 旧记事本）照常合并，写回不带 BOM；读不了的配置拒写不覆盖
    #[test]
    fn bom_configs_merge_and_undecodable_config_is_refused() {
        let dir = tmpdir("bom");
        let home = dir.join("home");
        let log = dir.join("hooks-state").join("claude-hooks.jsonl");
        let backups = dir.join("backups");
        let spec = claude();
        let settings = home.join(spec.config_rel);
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(&settings, "\u{feff}{\"env\": {\"KEEP\": \"1\"}}").unwrap();
        apply_hooks_at(spec, &home, &log, &backups, true).unwrap();
        let text = fs::read_to_string(&settings).unwrap();
        assert!(!text.starts_with('\u{feff}'));
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["env"]["KEEP"], "1");
        assert!(v["hooks"]["Stop"].is_array());

        // JSONC 容错族与 kimi TOML 同样容忍 BOM
        let qwen = spec_for("qwen").unwrap();
        assert!(merge_json_doc(qwen, Some("\u{feff}{\"a\": 1,}"), "x").is_ok());
        let kimi = spec_for("kimi").unwrap();
        assert!(merge_kimi_toml(kimi, Some("\u{feff}default_model = \"m\"\n"), "x").is_ok());

        // 非 UTF-8：不能当成「不存在」拿只含 hooks 的新文件覆盖
        let bad = [0xff, 0xfe, b'{', 0xfd];
        fs::write(&settings, bad).unwrap();
        assert!(apply_hooks_at(spec, &home, &log, &backups, true).is_err());
        assert!(apply_hooks_at(spec, &home, &log, &backups, false).is_err());
        assert_eq!(fs::read(&settings).unwrap(), bad, "原文件原样保留");
        fs::remove_dir_all(&dir).ok();
    }

    /// 真机执行：生成的命令分别经 cmd /d /s /c（Qwen 等 Node 系）、powershell -Command（Gemini）、
    /// Git Bash -c（Claude Code）三种宿主跑一遍，日志都要写出可解析的记录（含中文不乱码）
    #[cfg(windows)]
    #[test]
    fn win_hook_command_runs_under_cmd_powershell_and_bash() {
        use std::io::Write;
        let dir = tmpdir("exec").join("带 空格 目录");
        let log = dir.join("hooks-state").join("claude-hooks.jsonl");
        write_win_hook_script(&log).unwrap();
        let cmd = win_hook_command(&log);

        let run = |host: &str, mut c: crate::process::BackgroundCommand| {
            c.stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let mut child = c.spawn().unwrap_or_else(|e| panic!("{host} 起不来: {e}"));
            let payload = format!(
                "{{\n  \"session_id\": \"{host}\",\n  \"hook_event_name\": \"Notification\",\n  \"message\": \"新项目\"\n}}\n"
            );
            child
                .stdin
                .take()
                .unwrap()
                .write_all(payload.as_bytes())
                .unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(
                out.status.success(),
                "{host} 退出码 {:?}: {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr)
            );
        };

        let mut hosts = vec!["cmd", "powershell"];
        let mut c = crate::process::background_command("cmd.exe");
        c.raw_arg(format!("/d /s /c \"{cmd}\""));
        run("cmd", c);
        let mut c = crate::process::background_command("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-Command", &cmd]);
        run("powershell", c);
        if let Some(bash) = crate::agents::resolve_git_bash() {
            let mut c = crate::process::background_command(bash);
            c.args(["-c", &cmd]);
            run("bash", c);
            hosts.push("bash");
        }

        let records = parse_log_records(&fs::read_to_string(&log).unwrap());
        let ids: Vec<&str> = records.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, hosts, "每种宿主各写一条可解析记录");
        assert!(records
            .iter()
            .all(|r| r.detail.as_deref() == Some("新项目") && r.ts > 0));
        fs::remove_dir_all(dir.parent().unwrap()).ok();
    }

    /// 支持清单：七家在桥接注册表内，cursor/opencode 不支持且带备注
    #[test]
    fn support_list_covers_all_nine() {
        let list = crate::agent_specs::all_agent_specs();
        assert_eq!(list.len(), 9, "九家 agent");
        let supported: Vec<&str> = list
            .iter()
            .filter(|s| spec_for(s.id).is_some())
            .map(|s| s.id)
            .collect();
        assert_eq!(
            supported,
            [
                "claude-code",
                "codex",
                "gemini",
                "qwen",
                "kimi",
                "codebuddy",
                "grok"
            ]
        );
        for id in ["cursor", "opencode"] {
            assert!(spec_for(id).is_none());
            assert!(support_note(id).is_some(), "{id} 不支持须带备注");
        }
        assert!(support_note("codex").is_some() && support_note("codebuddy").is_some());
    }
}
