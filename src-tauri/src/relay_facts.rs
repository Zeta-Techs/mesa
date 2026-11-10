//! 接力简报里「这一轮改了什么、跑了什么」（docs/design-chat-relay.md §5）。
//!
//! 从会话记录的 tool_use / tool_result 块按轮整理，不靠 git 状态猜：改了哪些文件（能从参数算出就带 +/-）、
//! 最后一条命令和退出码、失败时输出的最后几行。只认核实过的几家工具名（`verified`），其余家的工具记录不解析，
//! 简报里写明「这家的工具记录没有解析」。读到的文件内容、命令完整输出、搜索结果一概不收；
//! 命令或路径碰到凭据类文件的，输出不附。全文脱敏由简报落盘前统一做（handoff::redact_and_cap）。

use serde_json::Value;

use crate::sessions::ChatMessageDto;

/// 失败命令附的输出：最后几行、最多多少字
const TAIL_LINES: usize = 20;
const TAIL_CHARS: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolKind {
    /// 改已有文件（参数里有新旧两段）
    Edit,
    /// 整个写入
    Write,
    /// 补丁（Codex apply_patch）
    Patch,
    Shell,
    Other,
}

/// 工具名 → 类别。只收核实过真实会话样本的三家（2026-11-10：Claude Code、Codex、Kimi Code 2.4）
pub(crate) fn tool_kind(agent: &str, name: &str) -> ToolKind {
    match (agent, name) {
        ("claude-code", "Edit" | "MultiEdit" | "NotebookEdit") => ToolKind::Edit,
        ("claude-code", "Write") => ToolKind::Write,
        ("claude-code", "Bash") => ToolKind::Shell,
        ("kimi", "Edit" | "StrReplaceFile") => ToolKind::Edit,
        ("kimi", "Write" | "WriteFile") => ToolKind::Write,
        ("kimi", "Bash" | "Shell") => ToolKind::Shell,
        ("codex", "apply_patch") => ToolKind::Patch,
        ("codex", "exec_command" | "shell" | "local_shell" | "container.exec") => ToolKind::Shell,
        _ => ToolKind::Other,
    }
}

/// 这家的工具记录有没有解析（没核实的家简报里如实说，不假装「没改文件」）
pub(crate) fn verified(agent: &str) -> bool {
    matches!(agent, "claude-code" | "codex" | "kimi")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileChange {
    pub path: String,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandFact {
    /// 命令第一行（过长截断）
    pub line: String,
    pub exit: Option<i32>,
    pub failed: bool,
    /// 失败时输出的最后几行；碰到凭据文件或没失败为 None
    pub tail: Option<String>,
    /// 命令涉及凭据类文件：输出不附
    pub sensitive: bool,
    /// 记录里有这条命令的结果（没有 = 被打断或还在跑）
    pub has_result: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RoundFacts {
    pub files: Vec<FileChange>,
    pub commands: usize,
    pub last_command: Option<CommandFact>,
}

impl RoundFacts {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty() && self.commands == 0
    }
}

/// 一轮的消息（用户那句之后、下一句用户原话之前的全部）→ 这一轮的事实
pub(crate) fn round_facts(agent: &str, messages: &[ChatMessageDto]) -> RoundFacts {
    let mut facts = RoundFacts::default();
    if !verified(agent) {
        return facts;
    }
    // 先把结果按调用 id 收好；没有 id 的按出现顺序配给前一个还没有结果的调用
    let mut results: Vec<(Option<String>, String, bool)> = Vec::new();
    for m in messages {
        for b in &m.blocks {
            if b.kind == "tool_result" {
                results.push((b.call_id.clone(), b.text.clone(), b.is_error));
            }
        }
    }
    let mut used = vec![false; results.len()];
    for m in messages {
        for b in &m.blocks {
            if b.kind != "tool_use" {
                continue;
            }
            let name = b.tool_name.as_deref().unwrap_or("");
            let kind = tool_kind(agent, name);
            if kind == ToolKind::Other {
                continue;
            }
            let result = match &b.call_id {
                Some(id) => results
                    .iter()
                    .position(|(rid, _, _)| rid.as_deref() == Some(id.as_str())),
                None => used.iter().position(|u| !u),
            };
            if let Some(i) = result {
                used[i] = true;
            }
            let result = result.map(|i| (&results[i].1, results[i].2));
            match kind {
                ToolKind::Edit | ToolKind::Write => {
                    if let Some(change) = file_change(kind, &b.text) {
                        merge_change(&mut facts.files, change);
                    }
                }
                ToolKind::Patch => {
                    for change in patch_changes(&b.text) {
                        merge_change(&mut facts.files, change);
                    }
                }
                ToolKind::Shell => {
                    facts.commands += 1;
                    facts.last_command = Some(command_fact(&b.text, result));
                }
                ToolKind::Other => {}
            }
        }
    }
    facts
}

fn merge_change(files: &mut Vec<FileChange>, change: FileChange) {
    if let Some(f) = files.iter_mut().find(|f| f.path == change.path) {
        f.added = add_opt(f.added, change.added);
        f.removed = add_opt(f.removed, change.removed);
    } else {
        files.push(change);
    }
}

fn add_opt(a: Option<u32>, b: Option<u32>) -> Option<u32> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x + y),
        _ => None,
    }
}

fn line_count(text: &str) -> u32 {
    if text.is_empty() {
        0
    } else {
        text.lines().count() as u32
    }
}

fn str_field<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| v.get(*k).and_then(Value::as_str))
}

/// Edit / Write 的参数（JSON）→ 文件与行数。Edit：删去旧段行数、加上新段行数；Write：整份行数，删去的算不出
fn file_change(kind: ToolKind, input: &str) -> Option<FileChange> {
    let v: Value = serde_json::from_str(input).ok()?;
    let path = str_field(&v, &["file_path", "path", "notebook_path"])?.to_string();
    if kind == ToolKind::Write {
        let content = str_field(&v, &["content"]).unwrap_or("");
        return Some(FileChange { path, added: Some(line_count(content)), removed: None });
    }
    // MultiEdit：edits 数组逐段相加
    if let Some(edits) = v.get("edits").and_then(Value::as_array) {
        let mut added = 0;
        let mut removed = 0;
        for e in edits {
            added += line_count(str_field(e, &["new_string"]).unwrap_or(""));
            removed += line_count(str_field(e, &["old_string"]).unwrap_or(""));
        }
        return Some(FileChange { path, added: Some(added), removed: Some(removed) });
    }
    let old = str_field(&v, &["old_string", "old_str", "old"]);
    let new = str_field(&v, &["new_string", "new_str", "new", "new_source"]);
    match (old, new) {
        (Some(o), Some(n)) => Some(FileChange {
            path,
            added: Some(line_count(n)),
            removed: Some(line_count(o)),
        }),
        _ => Some(FileChange { path, added: None, removed: None }),
    }
}

/// Codex apply_patch 的补丁正文：`*** Update File: x` / `*** Add File: x` / `*** Delete File: x`，
/// 段内以 + / - 开头的行计数（不含 *** 与 @@ 头）。参数偶尔包成 JSON（{"input": …}），先剥
fn patch_changes(input: &str) -> Vec<FileChange> {
    let text = serde_json::from_str::<Value>(input)
        .ok()
        .and_then(|v| str_field(&v, &["input", "patch"]).map(String::from))
        .unwrap_or_else(|| input.to_string());
    let mut out: Vec<FileChange> = Vec::new();
    let mut current: Option<FileChange> = None;
    for line in text.lines() {
        let head = ["*** Update File: ", "*** Add File: ", "*** Delete File: "]
            .iter()
            .find_map(|p| line.strip_prefix(p));
        if let Some(path) = head {
            if let Some(c) = current.take() {
                out.push(c);
            }
            current = Some(FileChange {
                path: path.trim().to_string(),
                added: Some(0),
                removed: Some(0),
            });
            continue;
        }
        if line.starts_with("***") || line.starts_with("@@") {
            continue;
        }
        if let Some(c) = current.as_mut() {
            if line.starts_with('+') {
                c.added = c.added.map(|n| n + 1);
            } else if line.starts_with('-') {
                c.removed = c.removed.map(|n| n + 1);
            }
        }
    }
    if let Some(c) = current {
        out.push(c);
    }
    out
}

/// 命令参数 → 第一行。Claude / Kimi：{"command": "…"}；Codex exec_command：{"cmd": "…"}；
/// Codex shell：{"command": ["bash", "-lc", "…"]}（取最后一段）
fn command_line(input: &str) -> String {
    let raw = match serde_json::from_str::<Value>(input) {
        Ok(v) => match v.get("command").or_else(|| v.get("cmd")) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => parts
                .last()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            _ => input.to_string(),
        },
        Err(_) => input.to_string(),
    };
    let first = raw.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let more = raw.lines().filter(|l| !l.trim().is_empty()).count() > 1;
    let mut line: String = first.chars().take(160).collect();
    if first.chars().count() > 160 || more {
        line.push('…');
    }
    line
}

/// 命令或路径碰到凭据类文件：输出不附（输出可能就是密钥本身，脱敏规则认不全）
pub(crate) fn touches_credentials(text: &str) -> bool {
    const MARKS: &[&str] = &[
        ".ssh/",
        "id_rsa",
        "id_ed25519",
        "keys.json",
        "auth.json",
        ".netrc",
        ".aws/",
        "credentials",
        ".env",
        ".npmrc",
        ".pypirc",
        "keychain",
        "security find-",
    ];
    let lower = text.to_ascii_lowercase();
    MARKS.iter().any(|m| lower.contains(m))
}

/// 结果文本里的退出码：Codex「Process exited with code N」/「Exit code: N」、JSON 的 exit_code
fn exit_code(result: &str) -> Option<i32> {
    for pat in ["Process exited with code ", "Exit code: ", "exit code ", "\"exit_code\":"] {
        if let Some(i) = result.find(pat) {
            let rest = result[i + pat.len()..].trim_start();
            let num: String = rest
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '-')
                .collect();
            if let Ok(n) = num.parse() {
                return Some(n);
            }
        }
    }
    None
}

fn command_fact(input: &str, result: Option<(&String, bool)>) -> CommandFact {
    let line = command_line(input);
    let sensitive = touches_credentials(input);
    let (exit, is_error, text) = match result {
        Some((text, is_error)) => (exit_code(text), is_error, Some(text.as_str())),
        None => (None, false, None),
    };
    let failed = is_error || exit.is_some_and(|c| c != 0);
    let tail = match (failed, sensitive, text) {
        (true, false, Some(t)) => Some(output_tail(t)),
        _ => None,
    };
    CommandFact { line, exit, failed, tail, sensitive, has_result: text.is_some() }
}

fn output_tail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(TAIL_LINES);
    let tail = lines[start..].join("\n");
    let count = tail.chars().count();
    if count <= TAIL_CHARS {
        return tail;
    }
    tail.chars().skip(count - TAIL_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::BlockDto;

    fn block(kind: &str, text: &str, name: Option<&str>, id: Option<&str>, err: bool) -> BlockDto {
        BlockDto {
            kind: kind.into(),
            text: text.into(),
            tool_name: name.map(String::from),
            is_error: err,
            call_id: id.map(String::from),
        }
    }

    fn msg(role: &str, blocks: Vec<BlockDto>) -> ChatMessageDto {
        ChatMessageDto { role: role.into(), blocks, timestamp: None, usage: None, id: None, cwd: None }
    }

    #[test]
    fn claude_edit_write_and_failed_bash() {
        let msgs = vec![
            msg(
                "assistant",
                vec![
                    block(
                        "tool_use",
                        r#"{"file_path":"src/a.ts","old_string":"x\ny","new_string":"x\ny\nz"}"#,
                        Some("Edit"),
                        Some("t1"),
                        false,
                    ),
                    block("tool_use", r#"{"file_path":"README.md","content":"a\nb"}"#, Some("Write"), Some("t2"), false),
                    block("tool_use", r#"{"command":"npm test"}"#, Some("Bash"), Some("t3"), false),
                    block("tool_use", r#"{"file_path":"src/a.ts"}"#, Some("Read"), Some("t4"), false),
                ],
            ),
            msg("user", vec![block("tool_result", "1 failing\nexpected 2", None, Some("t3"), true)]),
        ];
        let f = round_facts("claude-code", &msgs);
        assert_eq!(
            f.files,
            vec![
                FileChange { path: "src/a.ts".into(), added: Some(3), removed: Some(2) },
                FileChange { path: "README.md".into(), added: Some(2), removed: None },
            ]
        );
        assert_eq!(f.commands, 1);
        let c = f.last_command.unwrap();
        assert_eq!(c.line, "npm test");
        assert!(c.failed);
        assert_eq!(c.tail.as_deref(), Some("1 failing\nexpected 2"));
    }

    #[test]
    fn codex_patch_and_exec_exit_code() {
        let patch = "*** Begin Patch\n*** Update File: src/x.rs\n@@\n-old\n+new\n+more\n*** Add File: b.md\n+hi\n*** End Patch";
        let msgs = vec![msg(
            "assistant",
            vec![
                block("tool_use", patch, Some("apply_patch"), Some("c1"), false),
                block("tool_use", r#"{"cmd":"cargo test\n--quiet"}"#, Some("exec_command"), Some("c2"), false),
                block("tool_result", "Chunk ID: 1\nProcess exited with code 0\nOutput:\nok", None, Some("c2"), false),
            ],
        )];
        let f = round_facts("codex", &msgs);
        assert_eq!(f.files[0], FileChange { path: "src/x.rs".into(), added: Some(2), removed: Some(1) });
        assert_eq!(f.files[1], FileChange { path: "b.md".into(), added: Some(1), removed: Some(0) });
        let c = f.last_command.unwrap();
        assert_eq!(c.line, "cargo test…");
        assert_eq!(c.exit, Some(0));
        assert!(!c.failed);
        assert!(c.tail.is_none());
    }

    #[test]
    fn kimi_edit_uses_path_and_shell_array() {
        let msgs = vec![msg(
            "assistant",
            vec![
                block("tool_use", r#"{"path":"/p/App.css","old_string":"a","new_string":"b"}"#, Some("Edit"), Some("k1"), false),
                block("tool_use", r#"{"command":"cat ~/.ssh/id_rsa"}"#, Some("Bash"), Some("k2"), false),
                block("tool_result", "-----BEGIN", None, Some("k2"), true),
            ],
        )];
        let f = round_facts("kimi", &msgs);
        assert_eq!(f.files[0].path, "/p/App.css");
        let c = f.last_command.unwrap();
        assert!(c.sensitive);
        assert!(c.failed);
        assert!(c.tail.is_none(), "凭据文件的输出不附");
    }

    #[test]
    fn unverified_agent_reports_nothing() {
        let msgs = vec![msg("assistant", vec![block("tool_use", r#"{"command":"ls"}"#, Some("Bash"), None, false)])];
        assert!(round_facts("gemini", &msgs).is_empty());
        assert!(!verified("gemini"));
    }

    #[test]
    fn codex_shell_array_takes_script() {
        assert_eq!(command_line(r#"{"command":["bash","-lc","git status"]}"#), "git status");
    }
}
