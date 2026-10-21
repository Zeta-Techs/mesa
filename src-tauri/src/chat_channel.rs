//! 聊天层结构化旁路（docs/design-chat-structured-channels.md）：CLI 的 TUI 照常跑在 PTY 里、终端仍是事实来源，
//! 这里只把 CLI 自己吐的结构化事件接进来，统一成一份「这一轮在哪一步」给聊天层。
//!
//! 逐家用各自官方提供、且不写用户配置的旁路（2026-10-20 本机逐家核实，scripts/e2e-model-routing/channel-probe.py）：
//! - Claude Code / CodeBuddy：`--settings` 带 hooks（hooks.rs launch_hooks_value），hook 进程继承 CCODE_TAB_ID，
//!   事件进各家状态日志，这里按标签号过滤
//! - Qwen：Dual Output（`--json-file` 事件流 + `--input-file` 反向命令，审批可从这边答）
//! - OpenCode：TUI 自带的本机服务（`--port` + OPENCODE_SERVER_PASSWORD），订阅 /event，审批走 /permission/<id>/reply
//! - Codex：私有 app-server（本机 WebSocket + 能力令牌），TUI 以 `--remote` 连上去，这里作为第二个客户端加入同一线程
//! - 其余开了全局 hooks 开关的家：同 Claude，按标签号读状态日志
//!
//! 任一旁路起不来就照旧启动、不接旁路，聊天层退回读会话文件 + 读屏（不减功能）。hook 一律不阻塞、不替用户回答；
//! 审批只在用户点了按钮后经 CLI 官方的回复通道送回，终端里先答也一样生效（哪边先答算哪边）。

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// 本机实测过的旁路起点版本（低于它或查不到版本就不接，照旧启动）
const QWEN_DUAL_MIN: (u32, u32, u32) = (0, 25, 2);
const OPENCODE_PORT_MIN: (u32, u32, u32) = (1, 19, 3);
const CODEX_REMOTE_MIN: (u32, u32, u32) = (0, 163, 0);
const CODEBUDDY_SETTINGS_MIN: (u32, u32, u32) = (2, 169, 0);
/// 这一轮实时文字最多留多少字符（只给预览用，正文以会话文件为准）
const LIVE_TEXT_CAP: usize = 24_000;
/// 审批卡里命令 / 差异 / 参数的长度上限
const PREVIEW_CAP: usize = 6_000;
/// 往前端推快照的最短间隔（实时文字一字一个事件，合并着推）
const EMIT_INTERVAL: Duration = Duration::from_millis(150);
/// Codex app-server 起来的等待上限（实测 0.1 秒左右）
const CODEX_READY_TIMEOUT: Duration = Duration::from_secs(4);

// ===== 快照（前端读的形状） =====

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnDto {
    /// 第几轮（这个标签起算）
    pub seq: u32,
    /// running | awaiting_approval | completed | failed | cancelled
    pub status: &'static str,
    pub stop_reason: Option<String>,
    /// 毫秒时间戳
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDto {
    /// 旁路的请求 id（能从聊天层回复的才有）
    pub request_id: Option<String>,
    /// true = 可经 CLI 官方通道从聊天层答（Qwen / OpenCode / Codex）；false = 只能在终端菜单里答
    pub replyable: bool,
    pub tool_name: Option<String>,
    /// execute | edit | read | fetch | other（ACP ToolKind 的子集）
    pub kind: &'static str,
    pub command: Option<String>,
    pub path: Option<String>,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    /// 统一差异（Codex 的 fileChange 直接给差异）
    pub diff: Option<String>,
    pub detail: Option<String>,
    /// 这家支持「本次会话都允许」时给出的文案
    pub always_label: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoticeDto {
    pub seq: u32,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSnapshot {
    pub tab_id: String,
    pub agent: String,
    /// hooks | qwen | opencode | codex
    pub kind: &'static str,
    pub session_id: Option<String>,
    /// 会话文件路径（Claude / CodeBuddy / Codex 直接告诉；Qwen / OpenCode 只给 id）
    pub transcript_path: Option<String>,
    /// 会话换过几次（/clear、恢复别的会话）：前端按它判断要不要改盯新文件
    pub session_seq: u32,
    /// startup | resume | clear | compact（Claude SessionStart 的 source）
    pub session_source: Option<String>,
    pub turn: Option<TurnDto>,
    pub approval: Option<ApprovalDto>,
    /// 这一轮旁路送来的实时文字（预览用；Claude 这类只有 hooks 的家没有）
    pub live_text: Option<String>,
    pub notice: Option<NoticeDto>,
}

// ===== 事件 =====

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ChannelEvent {
    Session {
        id: String,
        path: Option<String>,
        source: Option<String>,
    },
    TurnStart,
    ToolStart {
        call_id: Option<String>,
        name: String,
        input: Value,
    },
    ApprovalAsked {
        request_id: Option<String>,
        call_id: Option<String>,
        name: Option<String>,
        input: Value,
        replyable: bool,
        detail: Option<String>,
    },
    ApprovalResolved {
        request_id: Option<String>,
    },
    ToolEnd {
        call_id: Option<String>,
    },
    TextDelta(String),
    /// 新的一段回复开始（工具调用把正文隔开了）
    TextBreak,
    TurnEnd {
        reason: Option<String>,
    },
    Notice(String),
}

// ===== 回合状态机（纯逻辑） =====

#[derive(Debug, Default)]
pub(crate) struct Tracker {
    pub(crate) snap: ChannelSnapshot,
    /// 工具 id → (名字, 参数)：审批事件不带参数时（Claude 的 Notification、Codex 的 fileChange）从这里补
    tools: HashMap<String, (String, Value)>,
    last_tool: Option<(Option<String>, String, Value)>,
    /// 正文被工具隔开了，下一段文字前空一行
    pending_break: bool,
    /// 审批属于哪个工具调用（工具结束 = 已答）
    approval_call: Option<String>,
    /// hooks 在后台跑（Windows 的 Claude Code，hooks::launch_hooks_async）：每个 hook 起一个 PowerShell、
    /// 约一秒才写进日志，先触发的不一定先到——「等批准」可能比它那个工具的 PreToolUse 先到、
    /// 上一个工具的 PostToolUse 可能比「等批准」后到。打开后：审批不拿已经结束的上一个工具充数，
    /// 随后到的工具补上审批内容，与审批对不上的工具结束不撤卡。只在这种模式下生效，其余家照旧。
    async_hooks: bool,
    /// 已经结束的工具 id（async_hooks 时用；每轮清空）
    ended: std::collections::HashSet<String>,
    /// 审批卡内容来自哪个工具（名字 + 参数；async_hooks 时按它对账）
    approval_src: Option<(String, Value)>,
}

fn is_open(turn: &Option<TurnDto>) -> bool {
    turn.as_ref()
        .is_some_and(|t| matches!(t.status, "running" | "awaiting_approval"))
}

impl Tracker {
    pub(crate) fn new(tab_id: &str, agent: &str, kind: &'static str) -> Self {
        Self {
            snap: ChannelSnapshot {
                tab_id: tab_id.to_string(),
                agent: agent.to_string(),
                kind,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn start_turn(&mut self, now: i64) {
        let seq = self.snap.turn.as_ref().map(|t| t.seq).unwrap_or(0) + 1;
        self.snap.turn = Some(TurnDto {
            seq,
            status: "running",
            stop_reason: None,
            started_at: now,
            ended_at: None,
        });
        self.snap.live_text = None;
        self.snap.approval = None;
        self.approval_call = None;
        self.pending_break = false;
        self.ended.clear();
    }

    fn ensure_running(&mut self, now: i64) {
        if !is_open(&self.snap.turn) {
            self.start_turn(now);
        }
    }

    fn set_status(&mut self, status: &'static str) {
        if let Some(t) = self.snap.turn.as_mut() {
            if t.ended_at.is_none() {
                t.status = status;
            }
        }
    }

    fn clear_approval(&mut self) {
        self.snap.approval = None;
        self.approval_call = None;
        self.approval_src = None;
        self.set_status("running");
    }

    /// 后台 hook（async_hooks）下的工具 / 审批事件：先后不可信，只按身份对账。
    /// - 审批卡内容只认带内容的事件（PermissionRequest 的工具名 + 参数），或随后到的工具；不拿「上一个工具」充数
    /// - 审批与工具按 id（工具开始时）或「工具名 + 参数相同」对上；对上之前，别的工具开始 / 结束都不撤卡
    /// - 对上的那个工具结束（不管开始事件到没到过）= 答完
    fn apply_async_tool(&mut self, ev: ChannelEvent, now: i64) {
        // 当前审批卡的内容来自哪个工具（名字 + 参数）；没有卡、或卡上只有一句提示时为 None
        let src = self.snap.approval.as_ref().and(self.approval_src.clone());
        let same = |name: &str, input: &Value| {
            src.as_ref().is_some_and(|(n, i)| n == name && i == input)
        };
        match ev {
            ChannelEvent::ToolStart {
                call_id,
                name,
                input,
            } => {
                self.ensure_running(now);
                let finished = call_id.as_ref().is_some_and(|id| self.ended.contains(id));
                let unbound = self.approval_call.is_none();
                if let (Some(id), Some(a), true) = (&call_id, self.snap.approval.clone(), unbound) {
                    if src.is_none() && !finished {
                        // 只有「等批准」提示、还没内容：就是这个工具
                        let mut dto = approval_from_tool(&name, &input);
                        dto.request_id = a.request_id;
                        dto.replyable = a.replyable;
                        dto.detail = dto.detail.or(a.detail);
                        self.snap.approval = Some(dto);
                        self.approval_src = Some((name.clone(), input.clone()));
                        self.approval_call = Some(id.clone());
                    } else if same(&name, &input) {
                        if finished {
                            // 它的结束事件早到过：已经答完
                            self.clear_approval();
                        } else {
                            self.approval_call = Some(id.clone());
                        }
                    }
                }
                if let Some(id) = &call_id {
                    self.tools.insert(id.clone(), (name.clone(), input.clone()));
                }
                if !finished {
                    self.last_tool = Some((call_id, name, input));
                }
                self.pending_break = true;
            }
            ChannelEvent::ApprovalAsked {
                request_id,
                call_id,
                name,
                input,
                replyable,
                detail,
            } => {
                self.ensure_running(now);
                let detail = detail.map(|d| crate::sessions::redact_sensitive_text(&d));
                match name {
                    Some(name) if !input.is_null() => {
                        let mut dto = approval_from_tool(&name, &input);
                        dto.request_id = request_id;
                        dto.replyable = replyable && dto.request_id.is_some();
                        dto.detail = dto.detail.or(detail);
                        // 对上已经报到、还没结束的同一个工具
                        let bound = call_id.or_else(|| {
                            self.tools
                                .iter()
                                .find(|(id, (n, i))| !self.ended.contains(*id) && *n == name && *i == input)
                                .map(|(id, _)| id.clone())
                        });
                        self.snap.approval = Some(dto);
                        self.approval_src = Some((name, input));
                        self.approval_call = bound;
                    }
                    _ => {
                        // 只有「需要你批准」一句话：已经有卡就不动内容，没有就先出一张只带这句话的
                        if self.snap.approval.is_none() {
                            let mut dto = approval_from_tool("", &Value::Null);
                            dto.request_id = request_id;
                            dto.replyable = replyable && dto.request_id.is_some();
                            dto.detail = detail;
                            self.snap.approval = Some(dto);
                            self.approval_src = None;
                            self.approval_call = call_id;
                        }
                    }
                }
                self.set_status("awaiting_approval");
            }
            ChannelEvent::ToolEnd { call_id } => {
                let Some(id) = call_id else { return };
                self.ended.insert(id.clone());
                let answered = match &self.approval_call {
                    Some(bound) => *bound == id,
                    // 还没对上：内容相同的那个工具结束了也算答完
                    None => self.tools.get(&id).is_some_and(|(n, i)| same(n, i)),
                };
                if self.snap.approval.is_some() && answered {
                    self.clear_approval();
                }
            }
            _ => {}
        }
    }

    /// 应用一个事件；返回快照是否变了
    pub(crate) fn apply(&mut self, ev: ChannelEvent, now: i64) -> bool {
        let before = self.snap.clone();
        if self.async_hooks
            && matches!(
                ev,
                ChannelEvent::ToolStart { .. } | ChannelEvent::ApprovalAsked { .. } | ChannelEvent::ToolEnd { .. }
            )
        {
            self.apply_async_tool(ev, now);
            return self.snap != before;
        }
        match ev {
            ChannelEvent::Session { id, path, source } => {
                // Codex 在 Windows 上恢复会话时给的是 `\\?\C:\…` 形态，统一成普通路径（其余平台原样）
                let path = path.map(|p| {
                    crate::paths::strip_verbatim(PathBuf::from(p))
                        .to_string_lossy()
                        .into_owned()
                });
                let changed_id = self.snap.session_id.as_deref() != Some(id.as_str());
                let changed_path = path.is_some() && self.snap.transcript_path != path;
                if changed_id || changed_path {
                    if self.snap.session_id.is_some() {
                        self.snap.session_seq += 1;
                    }
                    self.snap.session_id = Some(id);
                    if path.is_some() {
                        self.snap.transcript_path = path;
                    }
                }
                if source.is_some() {
                    self.snap.session_source = source;
                }
            }
            ChannelEvent::TurnStart => {
                if !is_open(&self.snap.turn) {
                    self.start_turn(now);
                }
            }
            ChannelEvent::ToolStart {
                call_id,
                name,
                input,
            } => {
                self.ensure_running(now);
                // 等批准时来了下一个工具：上一个已经答过了
                if self.snap.approval.is_some()
                    && call_id.is_some()
                    && self.approval_call.is_some()
                    && call_id != self.approval_call
                {
                    self.snap.approval = None;
                    self.approval_call = None;
                    self.set_status("running");
                }
                if let Some(id) = &call_id {
                    self.tools.insert(id.clone(), (name.clone(), input.clone()));
                }
                self.last_tool = Some((call_id, name, input));
                self.pending_break = true;
            }
            ChannelEvent::ApprovalAsked {
                request_id,
                call_id,
                name,
                input,
                replyable,
                detail,
            } => {
                self.ensure_running(now);
                let known = call_id
                    .as_ref()
                    .and_then(|id| self.tools.get(id).cloned())
                    .or_else(|| {
                        self.last_tool
                            .as_ref()
                            .map(|(_, n, i)| (n.clone(), i.clone()))
                    });
                let (tool, args) = match (name, input.is_null()) {
                    (Some(n), false) => (n, input),
                    (Some(n), true) => (n, known.map(|(_, i)| i).unwrap_or(Value::Null)),
                    (None, _) => known.unwrap_or((String::new(), Value::Null)),
                };
                let mut dto = approval_from_tool(&tool, &args);
                dto.request_id = request_id;
                dto.replyable = replyable && dto.request_id.is_some();
                if dto.detail.is_none() {
                    dto.detail = detail.map(|d| crate::sessions::redact_sensitive_text(&d));
                }
                self.approval_call = call_id.or_else(|| {
                    self.last_tool.as_ref().and_then(|(id, _, _)| id.clone())
                });
                self.snap.approval = Some(dto);
                self.set_status("awaiting_approval");
            }
            ChannelEvent::ApprovalResolved { request_id } => {
                let matches = match (&self.snap.approval, &request_id) {
                    (Some(a), Some(id)) => a.request_id.as_deref() == Some(id.as_str()),
                    (Some(_), None) => true,
                    _ => false,
                };
                if matches {
                    self.snap.approval = None;
                    self.approval_call = None;
                    self.set_status("running");
                }
            }
            ChannelEvent::ToolEnd { call_id } => {
                if self.snap.approval.is_some()
                    && (call_id.is_none() || self.approval_call.is_none() || call_id == self.approval_call)
                {
                    self.snap.approval = None;
                    self.approval_call = None;
                    self.set_status("running");
                }
            }
            ChannelEvent::TextDelta(text) => {
                if text.is_empty() {
                    return false;
                }
                self.ensure_running(now);
                let live = self.snap.live_text.get_or_insert_with(String::new);
                if self.pending_break && !live.is_empty() && !live.ends_with("\n\n") {
                    live.push_str(if live.ends_with('\n') { "\n" } else { "\n\n" });
                }
                self.pending_break = false;
                live.push_str(&text);
                if live.len() > LIVE_TEXT_CAP {
                    let cut = live.len() - LIVE_TEXT_CAP;
                    let cut = (cut..live.len()).find(|i| live.is_char_boundary(*i)).unwrap_or(0);
                    live.drain(..cut);
                }
            }
            ChannelEvent::TextBreak => {
                self.pending_break = true;
            }
            ChannelEvent::TurnEnd { reason } => {
                if let Some(t) = self.snap.turn.as_mut() {
                    if t.ended_at.is_none() {
                        t.status = match reason.as_deref() {
                            Some("failed" | "error" | "error_during_execution") => "failed",
                            Some("interrupted" | "cancelled" | "aborted") => "cancelled",
                            _ => "completed",
                        };
                        t.stop_reason = reason;
                        t.ended_at = Some(now);
                    }
                }
                self.snap.approval = None;
                self.approval_call = None;
            }
            ChannelEvent::Notice(text) => {
                let seq = self.snap.notice.as_ref().map(|n| n.seq).unwrap_or(0) + 1;
                self.snap.notice = Some(NoticeDto { seq, text });
            }
        }
        self.snap != before
    }
}

fn cap(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…（后面还有 {} 字节）", &text[..end], text.len() - end)
}

fn redact_cap(text: &str) -> String {
    crate::sessions::redact_sensitive_text(&cap(text, PREVIEW_CAP))
}

/// 整个文件新建 / 删除：每行补上 + / -。已经是带符号的差异（每行都以该符号开头，或有 @@ 段头）就原样返回
fn mark_whole_file(text: &str, sign: char) -> String {
    let body = text.strip_suffix('\n').unwrap_or(text);
    if body.is_empty()
        || body.lines().any(|l| l.starts_with("@@"))
        || body.lines().all(|l| l.starts_with(sign))
    {
        return text.to_string();
    }
    body.lines().map(|l| format!("{sign}{l}")).collect::<Vec<_>>().join("\n")
}

fn str_field(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| match v.get(*k) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Array(a)) if !a.is_empty() && a.iter().all(|x| x.is_string()) => Some(
            a.iter()
                .filter_map(|x| x.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    })
}

/// 工具名 + 参数 → 审批卡要显示的东西（九家工具名不同，按名字与常见参数键归类；认不出的给参数原文）
pub(crate) fn approval_from_tool(name: &str, input: &Value) -> ApprovalDto {
    let lower = name.to_lowercase().replace(['_', '-'], "");
    let path = str_field(
        input,
        &["file_path", "filePath", "path", "absolute_path", "notebook_path"],
    );
    let mut dto = ApprovalDto {
        tool_name: (!name.is_empty()).then(|| name.to_string()),
        kind: "other",
        ..Default::default()
    };
    let is = |names: &[&str]| names.iter().any(|n| lower == *n);
    // CodeBuddy 的 ptc 模式只给一个 REPL 工具，命令写成 JS（`await Bash({ command })`），原样给人看
    if lower == "repl" {
        if let Some(code) = str_field(input, &["code"]) {
            dto.kind = "execute";
            dto.command = Some(redact_cap(&code));
            return dto;
        }
    }
    if is(&[
        "bash", "shell", "runshellcommand", "execcommand", "commandexecution", "runcommand",
        "runterminalcmd", "localshell", "powershell",
    ]) || (input.get("command").is_some() && path.is_none())
    {
        dto.kind = "execute";
        dto.command = str_field(input, &["command", "cmd", "script"]).map(|c| redact_cap(&c));
        dto.detail = str_field(input, &["description", "justification", "reason"])
            .map(|d| redact_cap(&d));
        if dto.command.is_none() {
            dto.detail = dto.detail.or_else(|| compact_args(input));
        }
        return dto;
    }
    if lower == "filechange" {
        dto.kind = "edit";
        if let Some(changes) = input.get("changes").and_then(|c| c.as_array()) {
            dto.path = changes
                .first()
                .and_then(|c| str_field(c, &["path"]))
                .map(|p| crate::sessions::redact_sensitive_text(&p));
            // 改多个文件时每段前加一行「*** 路径」（前端画成分隔），只改一个就只给差异
            let many = changes.len() > 1;
            let diff: Vec<String> = changes
                .iter()
                .map(|c| {
                    let p = str_field(c, &["path"]).unwrap_or_default();
                    let d = str_field(c, &["diff", "unified_diff"]).unwrap_or_default();
                    // 新建 / 删除时 app-server 的 diff 可能是文件原文（kind 为 {type:"add"|"delete"}），
                    // 不补符号前端会画成没变的上下文行
                    let kind = c
                        .get("kind")
                        .and_then(|k| k.get("type").or(Some(k)))
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    let d = match kind {
                        "add" => mark_whole_file(&d, '+'),
                        "delete" => mark_whole_file(&d, '-'),
                        _ => d,
                    };
                    match (many, d.is_empty()) {
                        (true, true) => format!("*** {p}"),
                        (true, false) => format!("*** {p}\n{d}"),
                        (false, _) => d,
                    }
                })
                .filter(|s| !s.is_empty())
                .collect();
            if !diff.is_empty() {
                dto.diff = Some(redact_cap(&diff.join("\n")));
            }
            if changes.len() > 1 {
                dto.detail = Some(format!("共改 {} 个文件", changes.len()));
            }
        }
        return dto;
    }
    if is(&[
        "edit", "multiedit", "replace", "strreplace", "strreplacefile", "editfile", "searchreplace",
        "write", "writefile", "createfile", "writetofile", "notebookedit", "applypatch",
    ]) {
        dto.kind = "edit";
        dto.path = path.map(|p| crate::sessions::redact_sensitive_text(&p));
        dto.old_text =
            str_field(input, &["old_string", "oldString", "old_str"]).map(|t| redact_cap(&t));
        dto.new_text = str_field(
            input,
            &["new_string", "newString", "new_str", "content", "file_text"],
        )
        .map(|t| redact_cap(&t));
        if let Some(edits) = input.get("edits").and_then(|e| e.as_array()) {
            let olds: Vec<String> = edits
                .iter()
                .filter_map(|e| str_field(e, &["old_string", "oldString"]))
                .collect();
            let news: Vec<String> = edits
                .iter()
                .filter_map(|e| str_field(e, &["new_string", "newString"]))
                .collect();
            if !olds.is_empty() {
                dto.old_text = Some(redact_cap(&olds.join("\n…\n")));
            }
            if !news.is_empty() {
                dto.new_text = Some(redact_cap(&news.join("\n…\n")));
            }
        }
        if lower == "applypatch" {
            dto.diff = str_field(input, &["patch", "input"]).map(|t| redact_cap(&t));
        }
        return dto;
    }
    if is(&["read", "readfile", "readmanyfiles", "view", "notebookread"]) {
        dto.kind = "read";
        dto.path = path.map(|p| crate::sessions::redact_sensitive_text(&p));
        return dto;
    }
    if is(&["webfetch", "fetch", "fetchurl", "readurl", "websearch", "googlewebsearch"]) {
        dto.kind = "fetch";
        dto.detail = str_field(input, &["url", "query", "prompt"]).map(|t| redact_cap(&t));
        return dto;
    }
    dto.path = path.map(|p| crate::sessions::redact_sensitive_text(&p));
    dto.detail = compact_args(input);
    dto
}

fn compact_args(input: &Value) -> Option<String> {
    match input {
        Value::Null => None,
        Value::Object(m) if m.is_empty() => None,
        other => Some(redact_cap(&other.to_string())),
    }
}

// ===== 各家事件 → ChannelEvent（纯函数） =====

/// hooks 状态日志的一条记录（Claude / CodeBuddy 每次启动注入，或用户开了全局开关的家）
pub(crate) fn map_hook(rec: &crate::hooks::HookRecord) -> Vec<ChannelEvent> {
    let payload = rec.payload.clone().unwrap_or(Value::Null);
    let s = |k: &str| payload.get(k).and_then(|v| v.as_str()).map(String::from);
    let mut out = Vec::new();
    match rec.event.as_str() {
        "sessionstart" => out.push(ChannelEvent::Session {
            id: rec.session_id.clone(),
            path: rec.transcript_path.clone(),
            source: s("source"),
        }),
        "userpromptsubmit" | "beforeagent" => out.push(ChannelEvent::TurnStart),
        "pretooluse" | "beforetool" => out.push(ChannelEvent::ToolStart {
            call_id: s("tool_use_id"),
            name: s("tool_name").unwrap_or_default(),
            input: payload.get("tool_input").cloned().unwrap_or(Value::Null),
        }),
        "notification" => {
            let kind = s("notification_type");
            if kind.is_none()
                || matches!(kind.as_deref(), Some("permission_prompt" | "elicitation_dialog"))
            {
                out.push(ChannelEvent::ApprovalAsked {
                    request_id: None,
                    call_id: None,
                    name: None,
                    input: Value::Null,
                    replyable: false,
                    detail: s("message"),
                });
            }
        }
        "permissionrequest" => out.push(ChannelEvent::ApprovalAsked {
            request_id: None,
            call_id: s("tool_use_id"),
            name: s("tool_name"),
            input: payload.get("tool_input").cloned().unwrap_or(Value::Null),
            replyable: false,
            detail: s("title").or_else(|| s("message")),
        }),
        "posttooluse" | "aftertool" | "posttoolusefailure" => out.push(ChannelEvent::ToolEnd {
            call_id: s("tool_use_id"),
        }),
        "stop" | "afteragent" => {
            // grok 的 Stop 在会话 teardown 时会以 shutdown / channel_closed 重复 fire
            let reason = s("reason");
            if reason.as_deref().is_none_or(|r| r == "end_turn") {
                out.push(ChannelEvent::TurnEnd {
                    reason: Some("end_turn".into()),
                });
            }
        }
        "precompact" => out.push(ChannelEvent::Notice("正在压缩上下文".into())),
        _ => {}
    }
    out
}

/// Qwen Dual Output 的一条事件（与 `--output-format stream-json` 同一套形状）
pub(crate) fn map_qwen(v: &Value) -> Vec<ChannelEvent> {
    let mut out = Vec::new();
    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    match ty {
        "system" => {
            if v.get("subtype").and_then(|x| x.as_str()) == Some("session_start") {
                let id = v
                    .get("session_id")
                    .or_else(|| v.get("data").and_then(|d| d.get("session_id")))
                    .and_then(|x| x.as_str());
                if let Some(id) = id {
                    out.push(ChannelEvent::Session {
                        id: id.to_string(),
                        path: None,
                        source: None,
                    });
                }
            }
        }
        "user" => {
            let content = v.get("message").and_then(|m| m.get("content"));
            match content {
                Some(Value::String(_)) => out.push(ChannelEvent::TurnStart),
                Some(Value::Array(items)) => {
                    let mut asked = false;
                    for item in items {
                        match item.get("type").and_then(|x| x.as_str()) {
                            Some("tool_result") => out.push(ChannelEvent::ToolEnd {
                                call_id: item
                                    .get("tool_use_id")
                                    .and_then(|x| x.as_str())
                                    .map(String::from),
                            }),
                            Some("text") if !asked => {
                                asked = true;
                                out.push(ChannelEvent::TurnStart);
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        "stream_event" => {
            let ev = v.get("event").cloned().unwrap_or(Value::Null);
            match ev.get("type").and_then(|x| x.as_str()) {
                Some("message_start") => out.push(ChannelEvent::TextBreak),
                Some("content_block_delta") => {
                    let delta = ev.get("delta");
                    if delta.and_then(|d| d.get("type")).and_then(|x| x.as_str())
                        == Some("text_delta")
                    {
                        if let Some(t) = delta.and_then(|d| d.get("text")).and_then(|x| x.as_str())
                        {
                            out.push(ChannelEvent::TextDelta(t.to_string()));
                        }
                    }
                }
                _ => {}
            }
        }
        "assistant" => {
            let content = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .cloned()
                .unwrap_or_default();
            let mut tools = 0;
            for item in &content {
                if item.get("type").and_then(|x| x.as_str()) == Some("tool_use") {
                    tools += 1;
                    out.push(ChannelEvent::ToolStart {
                        call_id: item.get("id").and_then(|x| x.as_str()).map(String::from),
                        name: item
                            .get("name")
                            .and_then(|x| x.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        input: item.get("input").cloned().unwrap_or(Value::Null),
                    });
                }
            }
            // 一次模型回复里没有工具调用 = 这一轮的最后一条（交互态不发 result，实测 0.25.2）
            if tools == 0 && !content.is_empty() {
                let reason = v
                    .get("message")
                    .and_then(|m| m.get("stop_reason"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("end_turn")
                    .to_string();
                out.push(ChannelEvent::TurnEnd {
                    reason: Some(reason),
                });
            }
        }
        "control_request" => {
            let req = v.get("request").cloned().unwrap_or(Value::Null);
            if req.get("subtype").and_then(|x| x.as_str()) == Some("can_use_tool") {
                let detail = req
                    .get("permission_suggestions")
                    .and_then(|s| s.as_array())
                    .and_then(|a| a.first())
                    .and_then(|s| s.get("description"))
                    .and_then(|x| x.as_str())
                    .map(String::from);
                out.push(ChannelEvent::ApprovalAsked {
                    request_id: v.get("request_id").and_then(|x| x.as_str()).map(String::from),
                    call_id: req
                        .get("tool_use_id")
                        .and_then(|x| x.as_str())
                        .map(String::from),
                    name: req.get("tool_name").and_then(|x| x.as_str()).map(String::from),
                    input: req.get("input").cloned().unwrap_or(Value::Null),
                    replyable: true,
                    detail,
                });
            }
        }
        "control_response" => {
            let id = v
                .get("response")
                .and_then(|r| r.get("request_id"))
                .and_then(|x| x.as_str())
                .map(String::from);
            out.push(ChannelEvent::ApprovalResolved { request_id: id });
        }
        "result" => out.push(ChannelEvent::TurnEnd {
            reason: v.get("subtype").and_then(|x| x.as_str()).map(|s| {
                if s == "success" {
                    "end_turn".to_string()
                } else {
                    s.to_string()
                }
            }),
        }),
        _ => {}
    }
    out
}

/// OpenCode SSE 事件；只跟 TUI 当前这个会话
#[derive(Default)]
pub(crate) struct OpenCodeState {
    session: Option<String>,
    /// part id → 类型（text / reasoning / tool …）：增量事件只带 part id
    parts: HashMap<String, String>,
}

pub(crate) fn map_opencode(ev: &Value, st: &mut OpenCodeState) -> Vec<ChannelEvent> {
    let mut out = Vec::new();
    let ty = ev.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let p = ev.get("properties").cloned().unwrap_or(Value::Null);
    let sid = p
        .get("sessionID")
        .and_then(|x| x.as_str())
        .map(String::from)
        .or_else(|| {
            p.get("info")
                .and_then(|i| i.get("id"))
                .and_then(|x| x.as_str())
                .map(String::from)
        });
    if matches!(ty, "session.created" | "tui.session.select") {
        if let Some(id) = sid.clone() {
            // 子会话（task 工具派的子 agent）带 parentID，不跟
            let child = p
                .get("info")
                .and_then(|i| i.get("parentID"))
                .is_some_and(|x| !x.is_null());
            if !child {
                st.session = Some(id.clone());
                out.push(ChannelEvent::Session {
                    id,
                    path: None,
                    source: None,
                });
            }
        }
        return out;
    }
    match (&st.session, &sid) {
        (Some(cur), Some(s)) if cur != s => return out,
        (None, Some(s)) if ty.starts_with("session.") || ty.starts_with("message.") => {
            st.session = Some(s.clone());
            out.push(ChannelEvent::Session {
                id: s.clone(),
                path: None,
                source: None,
            });
        }
        _ => {}
    }
    match ty {
        "session.status" => {
            match p
                .get("status")
                .and_then(|s| s.get("type"))
                .and_then(|x| x.as_str())
            {
                Some("busy") => out.push(ChannelEvent::TurnStart),
                Some("idle") => out.push(ChannelEvent::TurnEnd {
                    reason: Some("end_turn".into()),
                }),
                _ => {}
            }
        }
        "session.idle" => out.push(ChannelEvent::TurnEnd {
            reason: Some("end_turn".into()),
        }),
        "session.error" => out.push(ChannelEvent::TurnEnd {
            reason: Some("failed".into()),
        }),
        "message.part.updated" => {
            let part = p.get("part").cloned().unwrap_or(Value::Null);
            let id = part.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let pty = part.get("type").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let first = !id.is_empty() && !st.parts.contains_key(&id);
            if !id.is_empty() {
                st.parts.insert(id, pty.clone());
            }
            match pty.as_str() {
                "text" if first => out.push(ChannelEvent::TextBreak),
                "tool" => {
                    let call = part.get("callID").and_then(|x| x.as_str()).map(String::from);
                    let name = part
                        .get("tool")
                        .and_then(|x| x.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let state = part.get("state").cloned().unwrap_or(Value::Null);
                    match state.get("status").and_then(|x| x.as_str()) {
                        Some("pending" | "running") => out.push(ChannelEvent::ToolStart {
                            call_id: call,
                            name,
                            input: state.get("input").cloned().unwrap_or(Value::Null),
                        }),
                        Some("completed" | "error") => {
                            out.push(ChannelEvent::ToolEnd { call_id: call })
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        "message.part.delta" => {
            let part = p.get("partID").and_then(|x| x.as_str()).unwrap_or("");
            let field = p.get("field").and_then(|x| x.as_str()).unwrap_or("text");
            let kind = st.parts.get(part).map(String::as_str).unwrap_or("text");
            if kind == "text" && field == "text" {
                if let Some(d) = p.get("delta").and_then(|x| x.as_str()) {
                    out.push(ChannelEvent::TextDelta(d.to_string()));
                }
            }
        }
        "permission.asked" => {
            let meta = p.get("metadata").cloned().unwrap_or(Value::Null);
            let patterns = p
                .get("patterns")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join("、")
                })
                .filter(|s| !s.is_empty());
            out.push(ChannelEvent::ApprovalAsked {
                request_id: p.get("id").and_then(|x| x.as_str()).map(String::from),
                call_id: p
                    .get("tool")
                    .and_then(|t| t.get("callID"))
                    .and_then(|x| x.as_str())
                    .map(String::from),
                name: p.get("permission").and_then(|x| x.as_str()).map(String::from),
                input: meta,
                replyable: true,
                detail: patterns,
            });
        }
        "permission.replied" => out.push(ChannelEvent::ApprovalResolved {
            request_id: p
                .get("requestID")
                .or_else(|| p.get("permissionID"))
                .and_then(|x| x.as_str())
                .map(String::from),
        }),
        _ => {}
    }
    out
}

/// Codex app-server 的一条消息（通知 / 服务端请求 / 对我们请求的响应）
#[derive(Default)]
pub(crate) struct CodexState {
    /// 加入的线程（TUI 的主线程；子 agent 的线程不跟）
    thread: Option<String>,
    /// 已认定要跟的线程（thread/started 或已加载列表里认出）
    joined: bool,
    /// thread/resume 成功、开始收这条线程的条目事件与审批请求。新线程在第一条消息前没有 rollout，
    /// 这时 resume 会报「no rollout found」——等线程转为 active 再订一次（resume 会重放挂着的审批）
    subscribed: bool,
    /// 未答的服务端请求：字符串化 id → (原 id, 方法)
    pending: HashMap<String, (Value, String)>,
    /// 我们发出的请求 id → 用途
    calls: HashMap<i64, &'static str>,
    next_id: i64,
}

impl CodexState {
    fn call(&mut self, method: &str, params: Value, purpose: &'static str) -> Value {
        self.next_id += 1;
        self.calls.insert(self.next_id, purpose);
        json!({ "jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params })
    }
}

fn rpc_id_key(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// 返回（事件，要发出去的消息）
pub(crate) fn map_codex(msg: &Value, st: &mut CodexState) -> (Vec<ChannelEvent>, Vec<Value>) {
    let mut out = Vec::new();
    let mut send = Vec::new();
    let method = msg.get("method").and_then(|x| x.as_str());
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let thread_of = |p: &Value| {
        p.get("threadId")
            .and_then(|x| x.as_str())
            .map(String::from)
    };
    let ours = |st: &CodexState, p: &Value| match (&st.thread, thread_of(p)) {
        (Some(t), Some(x)) => *t == x,
        (Some(_), None) => true,
        (None, _) => false,
    };
    let join = |st: &mut CodexState, id: String, path: Option<String>, out: &mut Vec<ChannelEvent>, send: &mut Vec<Value>| {
        st.thread = Some(id.clone());
        st.joined = true;
        out.push(ChannelEvent::Session {
            id: id.clone(),
            path,
            source: None,
        });
        send.push(st.call("thread/resume", json!({ "threadId": id }), "resume"));
    };
    match (method, msg.get("id")) {
        // 对我们请求的响应
        (None, Some(id)) => {
            let purpose = id.as_i64().and_then(|n| st.calls.remove(&n));
            if purpose == Some("loaded") && st.thread.is_none() {
                let first = msg
                    .get("result")
                    .and_then(|r| r.get("data"))
                    .and_then(|d| d.as_array())
                    .and_then(|a| a.first())
                    .and_then(|x| x.as_str().map(String::from).or_else(|| {
                        x.get("id").and_then(|i| i.as_str()).map(String::from)
                    }));
                if let Some(t) = first {
                    join(st, t, None, &mut out, &mut send);
                }
            }
            if purpose == Some("resume") {
                st.subscribed = msg.get("error").is_none();
                let path = msg
                    .get("result")
                    .and_then(|r| r.get("thread"))
                    .and_then(|t| t.get("path"))
                    .and_then(|x| x.as_str())
                    .map(String::from);
                if let (Some(path), Some(id)) = (path, st.thread.clone()) {
                    out.push(ChannelEvent::Session {
                        id,
                        path: Some(path),
                        source: None,
                    });
                }
            }
        }
        // 服务端请求（审批）
        (Some(m), Some(id)) => {
            if !ours(st, &params) {
                return (out, send);
            }
            let key = rpc_id_key(id);
            st.pending.insert(key.clone(), (id.clone(), m.to_string()));
            let item = params.get("itemId").and_then(|x| x.as_str()).map(String::from);
            let reason = params.get("reason").and_then(|x| x.as_str()).map(String::from);
            match m {
                "item/commandExecution/requestApproval" => out.push(ChannelEvent::ApprovalAsked {
                    request_id: Some(key),
                    call_id: item,
                    name: Some("commandExecution".into()),
                    input: json!({ "command": params.get("command").cloned().unwrap_or(Value::Null) }),
                    replyable: true,
                    detail: reason,
                }),
                "item/fileChange/requestApproval" => out.push(ChannelEvent::ApprovalAsked {
                    request_id: Some(key),
                    call_id: item,
                    name: Some("fileChange".into()),
                    input: Value::Null,
                    replyable: true,
                    detail: reason,
                }),
                m if m.ends_with("requestApproval") || m.ends_with("Approval") => {
                    out.push(ChannelEvent::ApprovalAsked {
                        request_id: Some(key),
                        call_id: item,
                        name: None,
                        input: Value::Null,
                        replyable: false,
                        detail: reason,
                    })
                }
                _ => {}
            }
        }
        // 通知
        (Some(m), None) => match m {
            "thread/started" => {
                let thread = params.get("thread").cloned().unwrap_or(Value::Null);
                let id = thread.get("id").and_then(|x| x.as_str()).map(String::from);
                let is_child = thread.get("parentThreadId").is_some_and(|x| !x.is_null());
                if let (Some(id), false, true) = (id, is_child, st.thread.is_none()) {
                    let path = thread.get("path").and_then(|x| x.as_str()).map(String::from);
                    join(st, id, path, &mut out, &mut send);
                }
            }
            "serverRequest/resolved" => {
                if let Some(id) = params.get("requestId") {
                    let key = rpc_id_key(id);
                    st.pending.remove(&key);
                    out.push(ChannelEvent::ApprovalResolved {
                        request_id: Some(key),
                    });
                }
            }
            _ if !ours(st, &params) => {}
            "thread/status/changed" => {
                // 订阅前也会广播：用它补回合边界，并在线程开始干活时（rollout 已落盘）再订一次
                match params
                    .get("status")
                    .and_then(|s| s.get("type"))
                    .and_then(|x| x.as_str())
                {
                    Some("active") => {
                        out.push(ChannelEvent::TurnStart);
                        if !st.subscribed {
                            if let Some(id) = st.thread.clone() {
                                send.push(st.call("thread/resume", json!({ "threadId": id }), "resume"));
                            }
                        }
                    }
                    Some("idle") => out.push(ChannelEvent::TurnEnd {
                        reason: Some("end_turn".into()),
                    }),
                    _ => {}
                }
            }
            "turn/started" => out.push(ChannelEvent::TurnStart),
            "turn/completed" => {
                let status = params
                    .get("turn")
                    .and_then(|t| t.get("status"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("completed");
                out.push(ChannelEvent::TurnEnd {
                    reason: Some(if status == "completed" {
                        "end_turn".into()
                    } else {
                        status.to_string()
                    }),
                });
            }
            "item/agentMessage/delta" => {
                if let Some(d) = params.get("delta").and_then(|x| x.as_str()) {
                    out.push(ChannelEvent::TextDelta(d.to_string()));
                }
            }
            "item/started" | "item/completed" => {
                let item = params.get("item").cloned().unwrap_or(Value::Null);
                let id = item.get("id").and_then(|x| x.as_str()).map(String::from);
                let ty = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
                let started = m == "item/started";
                match ty {
                    "agentMessage" if started => out.push(ChannelEvent::TextBreak),
                    "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" => {
                        if started {
                            let (name, input) = match ty {
                                "commandExecution" => (
                                    "commandExecution".to_string(),
                                    json!({ "command": item.get("command").cloned().unwrap_or(Value::Null) }),
                                ),
                                "fileChange" => (
                                    "fileChange".to_string(),
                                    json!({ "changes": item.get("changes").cloned().unwrap_or(Value::Null) }),
                                ),
                                _ => (
                                    item.get("tool")
                                        .and_then(|x| x.as_str())
                                        .unwrap_or(ty)
                                        .to_string(),
                                    item.get("arguments").cloned().unwrap_or(Value::Null),
                                ),
                            };
                            out.push(ChannelEvent::ToolStart {
                                call_id: id,
                                name,
                                input,
                            });
                        } else {
                            out.push(ChannelEvent::ToolEnd { call_id: id });
                        }
                    }
                    "contextCompaction" if started => {
                        out.push(ChannelEvent::Notice("正在压缩上下文".into()))
                    }
                    _ => {}
                }
            }
            _ => {}
        },
        (None, None) => {}
    }
    (out, send)
}

// ===== 最小 WebSocket 客户端（Codex app-server；不另引依赖） =====

fn ws_handshake(stream: &mut TcpStream, port: u16, token: &str) -> Result<(), String> {
    use base64::Engine;
    let key = base64::engine::general_purpose::STANDARD.encode(uuid::Uuid::new_v4().as_bytes());
    let req = format!(
        "GET /rpc HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Authorization: Bearer {token}\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("握手失败: {e}"))?;
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 8192 {
            return Err("握手响应过长".into());
        }
        stream
            .read_exact(&mut byte)
            .map_err(|e| format!("握手失败: {e}"))?;
        head.push(byte[0]);
    }
    let status = String::from_utf8_lossy(&head);
    if !status.starts_with("HTTP/1.1 101") {
        return Err(format!(
            "握手被拒: {}",
            status.lines().next().unwrap_or_default()
        ));
    }
    Ok(())
}

/// 客户端发帧必须加掩码（RFC 6455 5.3）
pub(crate) fn ws_encode_text(payload: &[u8]) -> Vec<u8> {
    let mask: [u8; 4] = uuid::Uuid::new_v4().as_bytes()[..4].try_into().unwrap();
    let mut frame = vec![0x81u8];
    let n = payload.len();
    if n < 126 {
        frame.push(0x80 | n as u8);
    } else if n < 65536 {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        frame.push(0x80 | 127);
        frame.extend_from_slice(&(n as u64).to_be_bytes());
    }
    frame.extend_from_slice(&mask);
    frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    frame
}

fn ws_send(stream: &Mutex<TcpStream>, msg: &Value) -> Result<(), String> {
    let frame = ws_encode_text(msg.to_string().as_bytes());
    stream
        .lock()
        .map_err(|_| "连接已关闭".to_string())?
        .write_all(&frame)
        .map_err(|e| format!("发送失败: {e}"))
}

/// 读一条完整消息（拼接分片；ping 回 pong；close 返回 None）
pub(crate) fn ws_read_message(
    stream: &mut impl Read,
    pong: &mut dyn FnMut(&[u8]),
) -> std::io::Result<Option<Vec<u8>>> {
    let mut message = Vec::new();
    loop {
        let mut head = [0u8; 2];
        stream.read_exact(&mut head)?;
        let fin = head[0] & 0x80 != 0;
        let op = head[0] & 0x0F;
        let masked = head[1] & 0x80 != 0;
        let mut len = (head[1] & 0x7F) as u64;
        if len == 126 {
            let mut b = [0u8; 2];
            stream.read_exact(&mut b)?;
            len = u16::from_be_bytes(b) as u64;
        } else if len == 127 {
            let mut b = [0u8; 8];
            stream.read_exact(&mut b)?;
            len = u64::from_be_bytes(b);
        }
        if len > 64 * 1024 * 1024 {
            return Err(std::io::Error::other("帧过大"));
        }
        let mut mask = [0u8; 4];
        if masked {
            stream.read_exact(&mut mask)?;
        }
        let mut payload = vec![0u8; len as usize];
        stream.read_exact(&mut payload)?;
        if masked {
            for (i, b) in payload.iter_mut().enumerate() {
                *b ^= mask[i % 4];
            }
        }
        match op {
            0x8 => return Ok(None),
            0x9 => pong(&payload),
            0xA => {}
            _ => {
                message.extend_from_slice(&payload);
                if fin {
                    return Ok(Some(message));
                }
            }
        }
    }
}

// ===== 注册表与生命周期 =====

enum Replier {
    Qwen { input: PathBuf },
    OpenCode { port: u16, password: String },
    Codex { stream: Arc<Mutex<TcpStream>> },
}

struct Channel {
    tab_id: String,
    stop: AtomicBool,
    tracker: Mutex<Tracker>,
    dirty: AtomicBool,
    replier: Mutex<Option<Replier>>,
    codex: Mutex<CodexState>,
    sidecar_pid: Mutex<Option<u32>>,
    dir: Option<PathBuf>,
}

fn registry() -> &'static Mutex<HashMap<String, Arc<Channel>>> {
    static REG: OnceLock<Mutex<HashMap<String, Arc<Channel>>>> = OnceLock::new();
    REG.get_or_init(Default::default)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn channels_root() -> Option<PathBuf> {
    Some(crate::storage::config_root()?.join("chat-channels"))
}

/// 标签号进环境变量与 hook 命令行：只留安全字符（hook 命令按空格切段）
fn sanitize_tab(tab: &str) -> String {
    tab.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        .take(96)
        .collect()
}

/// 目录名以 Mesa 进程号开头：同一配置目录可能同时有打包版和 Mesa Dev 两个实例，启动清理只收已经不在的进程留下的
fn private_dir(tab: &str) -> Option<PathBuf> {
    let dir = channels_root()?.join(format!(
        "{}-{}-{}",
        std::process::id(),
        tab.replace(':', "_"),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    std::fs::create_dir_all(&dir).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Some(dir)
}

fn private_file(path: &Path) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path).map(|_| ())
}

/// 启动时清掉上次没收尾的旁路目录（崩溃残留；只收进程已不在的，另一个 Mesa 实例的不动），顺手给 hooks 状态日志瘦身
pub(crate) fn prune_on_startup() {
    if let Some(root) = channels_root() {
        if let Ok(entries) = std::fs::read_dir(&root) {
            let mut sys = sysinfo::System::new();
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let pid = name.split('-').next().and_then(|p| p.parse::<u32>().ok());
                let alive = pid.is_some_and(|pid| {
                    let pid = sysinfo::Pid::from_u32(pid);
                    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
                    sys.process(pid).is_some()
                });
                if !alive {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
    }
    for agent in ["claude-code", "codebuddy", "qwen", "gemini", "kimi", "grok", "codex"] {
        if let Some(log) = crate::hooks::log_path_for(agent) {
            crate::hooks::rotate_log_if_large(&log);
        }
    }
}

/// pty_spawn 准备好、还没起进程时的旁路
pub(crate) struct Prepared {
    agent: String,
    tab_id: String,
    kind: &'static str,
    dir: Option<PathBuf>,
    hooks_log: Option<(PathBuf, u64)>,
    qwen_events: Option<PathBuf>,
    replier: Option<Replier>,
    codex: Option<(u16, String, u32)>,
}

impl Prepared {
    /// 进程没起来：收掉旁路进程与目录
    pub(crate) fn abort(self) {
        if let Some((_, _, pid)) = self.codex {
            crate::pty::kill_process_tree(pid);
        }
        if let Some(dir) = self.dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

fn version_at_least(agent: &str, min: (u32, u32, u32)) -> bool {
    crate::agents::cli_version(agent).is_some_and(|v| v >= min)
}

/// 把 hooks 并进 Claude Code 的 `--settings`：参数是 Mesa 刚写的 0600 覆盖文件就改文件，是内联 JSON 就改内联，
/// 没有这个参数就加一个内联的
fn merge_settings_hooks(args: &mut Vec<String>, hooks: &Value) -> bool {
    merge_settings_key(args, "hooks", hooks["hooks"].clone())
}

/// 往 Claude Code / CodeBuddy 的 `--settings` 里并一个顶层键（同上：覆盖文件改文件、内联改内联、没有就加内联）
pub(crate) fn merge_settings_key(args: &mut Vec<String>, key: &str, value: Value) -> bool {
    if let Some(i) = args.iter().position(|a| a == "--settings") {
        let Some(current) = args.get(i + 1).cloned() else {
            return false;
        };
        let path = Path::new(&current);
        let from_file = !current.trim_start().starts_with('{') && path.is_file();
        let text = if from_file {
            match std::fs::read_to_string(path) {
                Ok(t) => t,
                Err(_) => return false,
            }
        } else {
            current.clone()
        };
        let Ok(mut v) = serde_json::from_str::<Value>(&text) else {
            return false;
        };
        let Some(obj) = v.as_object_mut() else {
            return false;
        };
        obj.insert(key.into(), value);
        let merged = v.to_string();
        if from_file {
            // 覆盖文件含密钥：原地改写保留 0600
            if std::fs::write(path, merged).is_err() {
                return false;
            }
        } else {
            args[i + 1] = merged;
        }
        return true;
    }
    let mut obj = serde_json::Map::new();
    obj.insert(key.into(), value);
    args.insert(0, Value::Object(obj).to_string());
    args.insert(0, "--settings".into());
    true
}

/// Codex 参数拆两半：`-c` / `--enable` / `--disable` 配置给 app-server，其余给 TUI；
/// TUI 加 `--remote` 连私有服务（`resume <id>` 子命令之后）
pub(crate) fn split_codex_args(args: &[String], port: u16) -> (Vec<String>, Vec<String>) {
    let mut server = Vec::new();
    let mut tui = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if matches!(a.as_str(), "-c" | "--config" | "--enable" | "--disable") && i + 1 < args.len()
        {
            server.push(a.clone());
            server.push(args[i + 1].clone());
            i += 2;
            continue;
        }
        if a == "--no-daemon" {
            i += 1;
            continue;
        }
        tui.push(a.clone());
        i += 1;
    }
    // 恢复时远程 TUI 拒收权限参数（「Permission overrides are not supported when resuming a remote task」，
    // 0.163 端到端实测）：改成 app-server 的配置，效果相同
    if tui.first().map(String::as_str) == Some("resume") {
        let mut kept = Vec::new();
        let mut j = 0;
        while j < tui.len() {
            let a = tui[j].as_str();
            let next = tui.get(j + 1).cloned();
            let mut cfg = |k: &str, v: &str| {
                server.push("-c".into());
                server.push(format!("{k}=\"{v}\""));
            };
            match (a, next) {
                ("-s" | "--sandbox", Some(v)) => {
                    cfg("sandbox_mode", &v);
                    j += 2;
                }
                ("-a" | "--ask-for-approval", Some(v)) => {
                    cfg("approval_policy", &v);
                    j += 2;
                }
                ("--approve-for-me", _) => {
                    cfg("approvals_reviewer", "auto_review");
                    cfg("sandbox_mode", "workspace-write");
                    j += 1;
                }
                ("--dangerously-bypass-approvals-and-sandbox", _) => {
                    cfg("approval_policy", "never");
                    cfg("sandbox_mode", "danger-full-access");
                    j += 1;
                }
                _ => {
                    kept.push(tui[j].clone());
                    j += 1;
                }
            }
        }
        tui = kept;
    }
    let at = if tui.first().map(String::as_str) == Some("resume") {
        tui.len().min(2)
    } else {
        0
    };
    let remote = [
        "--remote".to_string(),
        format!("ws://127.0.0.1:{port}"),
        "--remote-auth-token-env".to_string(),
        "CCODE_CODEX_TOKEN".to_string(),
    ];
    for (k, a) in remote.into_iter().enumerate() {
        tui.insert(at + k, a);
    }
    (server, tui)
}

fn free_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .ok()?
        .local_addr()
        .ok()
        .map(|a| a.port())
}

fn sha256_hex(text: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 拉起私有 app-server 并等它开始监听；失败返回 None（照旧启动 Codex）
fn start_codex_server(
    binary: &Path,
    cwd: &str,
    server_args: &[String],
    env: &[(String, String)],
    env_remove: &[String],
    dir: &Path,
) -> Option<(u16, String, u32)> {
    let port = free_port()?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut cmd = crate::process::background_command(binary);
    let listen: Vec<String> = vec![
        "app-server".into(),
        "--listen".into(),
        format!("ws://127.0.0.1:{port}"),
        "--ws-auth".into(),
        "capability-token".into(),
        "--ws-token-sha256".into(),
        sha256_hex(&token),
    ];
    cmd.args(&listen);
    cmd.args(server_args);
    cmd.current_dir(cwd);
    for (k, v) in env {
        cmd.env(k, v);
    }
    for k in env_remove {
        cmd.env_remove(k);
    }
    cmd.env_remove("CCODE_CODEX_TOKEN");
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null());
    match std::fs::File::create(dir.join("codex-server.log")) {
        Ok(f) => {
            cmd.stderr(f);
        }
        Err(_) => {
            cmd.stderr(std::process::Stdio::null());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    // Windows：挂进「Mesa 一退就全杀」的任务组，Mesa 崩溃 / 被强杀也不留占端口、占会话写锁的 app-server
    #[cfg(windows)]
    let mut child = cmd.spawn_tied_to_app().ok()?;
    #[cfg(not(windows))]
    let mut child = cmd.spawn().ok()?;
    let pid = child.id();
    let deadline = Instant::now() + CODEX_READY_TIMEOUT;
    loop {
        if TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(100),
        )
        .is_ok()
        {
            break;
        }
        if matches!(child.try_wait(), Ok(Some(_))) || Instant::now() > deadline {
            crate::pty::kill_process_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    // 回收进程（退出后不留僵尸）；结束由 close_for_pty 按进程组杀
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Some((port, token, pid))
}

/// pty_spawn 在起进程前调用：按这家改启动参数（`args` 不含末尾的初始 prompt）、返回要加给 PTY 的环境变量
/// 与旁路句柄。`server_env` = 交给 PTY 的完整环境（Codex 的 app-server 跑工具，要同一份）。
pub(crate) fn prepare(
    agent: &str,
    tab_id: Option<&str>,
    cwd: &str,
    binary: &Path,
    args: &mut Vec<String>,
    server_env: &[(String, String)],
    env_remove: &[String],
) -> (Vec<(String, String)>, Option<Prepared>) {
    let Some(tab) = tab_id.map(sanitize_tab).filter(|t| !t.is_empty()) else {
        return (Vec::new(), None);
    };
    let mut env = vec![("CCODE_TAB_ID".to_string(), tab.clone())];
    let base = |kind: &'static str| Prepared {
        agent: agent.to_string(),
        tab_id: tab.clone(),
        kind,
        dir: None,
        hooks_log: None,
        qwen_events: None,
        replier: None,
        codex: None,
    };
    let hooks_channel = |p: &mut Prepared| {
        let log = crate::hooks::log_path_for(agent)?;
        let offset = std::fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
        p.hooks_log = Some((log, offset));
        Some(())
    };
    match agent {
        "claude-code" | "codebuddy" => {
            if agent == "codebuddy" && !version_at_least(agent, CODEBUDDY_SETTINGS_MIN) {
                return (env, None);
            }
            let Some(hooks) = crate::hooks::launch_hooks_value(agent) else {
                return (env, None);
            };
            let mut p = base("hooks");
            if hooks_channel(&mut p).is_none() {
                return (env, None);
            }
            // Windows：没有网关的覆盖文件时（官方账号）不内联 JSON——经 .cmd 包装起的 CLI 参数要过 cmd，
            // hooks 里 matcher 的 `|` 会被当管道，Claude 直接起不来（2026-10-20 实测「文件名、目录名或卷标语法不正确」）。
            // 另起一份 Mesa 自己的设置文件，标签关掉随旁路目录删
            #[cfg(windows)]
            if !args.iter().any(|a| a == "--settings") {
                let Some(dir) = private_dir(&tab) else {
                    return (env, None);
                };
                let file = dir.join("settings.json");
                if std::fs::write(&file, "{}").is_err() {
                    let _ = std::fs::remove_dir_all(&dir);
                    return (env, None);
                }
                args.insert(0, file.to_string_lossy().into_owned());
                args.insert(0, "--settings".into());
                p.dir = Some(dir);
            }
            if !merge_settings_hooks(args, &hooks) {
                if let Some(dir) = p.dir.take() {
                    // 去掉刚加的 --settings（文件随目录删了，留着 CLI 会找不到）
                    args.drain(0..2);
                    let _ = std::fs::remove_dir_all(dir);
                }
                return (env, None);
            }
            (env, Some(p))
        }
        "qwen" if version_at_least(agent, QWEN_DUAL_MIN) => {
            let Some(dir) = private_dir(&tab) else {
                return (env, None);
            };
            let events = dir.join("events.jsonl");
            let input = dir.join("input.jsonl");
            if private_file(&events).is_err() || private_file(&input).is_err() {
                let _ = std::fs::remove_dir_all(&dir);
                return (env, None);
            }
            args.push("--json-file".into());
            args.push(events.to_string_lossy().into_owned());
            args.push("--input-file".into());
            args.push(input.to_string_lossy().into_owned());
            let mut p = base("qwen");
            p.qwen_events = Some(events);
            p.replier = Some(Replier::Qwen { input });
            p.dir = Some(dir);
            (env, Some(p))
        }
        "opencode" if version_at_least(agent, OPENCODE_PORT_MIN) => {
            let Some(port) = free_port() else {
                return (env, None);
            };
            let password = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            args.push("--port".into());
            args.push(port.to_string());
            env.push(("OPENCODE_SERVER_PASSWORD".into(), password.clone()));
            let mut p = base("opencode");
            p.replier = Some(Replier::OpenCode { port, password });
            (env, Some(p))
        }
        "codex" if version_at_least(agent, CODEX_REMOTE_MIN) => {
            let Some(dir) = private_dir(&tab) else {
                return (env, None);
            };
            let mut probe_args = args.clone();
            let (server_args, _) = split_codex_args(&probe_args, 0);
            let mut server_env: Vec<(String, String)> = server_env.to_vec();
            server_env.push(("CCODE_TAB_ID".into(), tab.clone()));
            let Some((port, token, pid)) =
                start_codex_server(binary, cwd, &server_args, &server_env, env_remove, &dir)
            else {
                let _ = std::fs::remove_dir_all(&dir);
                return (env, None);
            };
            let (_, tui) = split_codex_args(&probe_args, port);
            probe_args = tui;
            *args = probe_args;
            env.push(("CCODE_CODEX_TOKEN".into(), token.clone()));
            let mut p = base("codex");
            p.codex = Some((port, token, pid));
            p.dir = Some(dir);
            (env, Some(p))
        }
        _ => {
            // 开了全局 hooks 开关的家：hook 命令也记标签号，按标签过滤同一份状态日志
            if crate::hooks::log_path_for(agent).is_none()
                || !crate::settings::hooks_attention_enabled(&crate::settings::read_current(), agent)
            {
                return (env, None);
            }
            let mut p = base("hooks");
            if hooks_channel(&mut p).is_none() {
                return (env, None);
            }
            (env, Some(p))
        }
    }
}

/// 快照推到哪里：应用里是 `chat-channel-<tabId>` 事件；端到端测试收进一个列表。None = 旁路已关闭
pub(crate) type Sink = Arc<dyn Fn(Option<ChannelSnapshot>) + Send + Sync>;

/// PTY 起来后：登记并开始盯旁路
pub(crate) fn start(app: &AppHandle, pty_id: &str, prepared: Prepared) {
    let app = app.clone();
    let event = format!("chat-channel-{}", prepared.tab_id);
    let sink: Sink = Arc::new(move |snap| {
        let _ = match snap {
            Some(s) => app.emit(&event, s),
            None => app.emit(&event, Value::Null),
        };
    });
    start_with_sink(pty_id, prepared, sink);
}

pub(crate) fn start_with_sink(pty_id: &str, prepared: Prepared, sink: Sink) {
    let Prepared {
        agent,
        tab_id,
        kind,
        dir,
        hooks_log,
        qwen_events,
        replier,
        codex,
    } = prepared;
    let channel = Arc::new(Channel {
        tab_id: tab_id.clone(),
        stop: AtomicBool::new(false),
        tracker: Mutex::new({
            let mut t = Tracker::new(&tab_id, &agent, kind);
            t.async_hooks = kind == "hooks" && crate::hooks::launch_hooks_async(&agent);
            t
        }),
        dirty: AtomicBool::new(true),
        replier: Mutex::new(replier),
        codex: Mutex::new(CodexState::default()),
        sidecar_pid: Mutex::new(codex.as_ref().map(|(_, _, pid)| *pid)),
        dir,
    });
    // 同一标签之前的旁路（重启 Agent 时旧进程还没走完退出流程）先收掉
    let stale: Vec<String> = registry()
        .lock()
        .map(|reg| {
            reg.iter()
                .filter(|(_, c)| c.tab_id == tab_id)
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default();
    for old in stale {
        close_for_pty(&old);
    }
    if let Ok(mut reg) = registry().lock() {
        reg.insert(pty_id.to_string(), channel.clone());
    }
    spawn_flusher(sink, channel.clone());
    if let Some((log, offset)) = hooks_log {
        let ch = channel.clone();
        let tab = tab_id.clone();
        std::thread::spawn(move || {
            tail_file(&ch, &log, offset, |chunk, tracker, now| {
                let mut changed = false;
                for rec in crate::hooks::parse_log_records(chunk) {
                    if rec.tab.as_deref() != Some(tab.as_str()) {
                        continue;
                    }
                    // 没收到 SessionStart（Mesa 接回已在跑的进程）时，从任一事件认出会话
                    if tracker.snap.session_id.is_none() {
                        changed |= tracker.apply(
                            ChannelEvent::Session {
                                id: rec.session_id.clone(),
                                path: rec.transcript_path.clone(),
                                source: None,
                            },
                            now,
                        );
                    }
                    for ev in map_hook(&rec) {
                        changed |= tracker.apply(ev, now);
                    }
                }
                changed
            });
        });
    }
    if let Some(events) = qwen_events {
        let ch = channel.clone();
        std::thread::spawn(move || {
            tail_file(&ch, &events, 0, |chunk, tracker, now| {
                let mut changed = false;
                for line in chunk.lines() {
                    if let Ok(v) = serde_json::from_str::<Value>(line) {
                        for ev in map_qwen(&v) {
                            changed |= tracker.apply(ev, now);
                        }
                    }
                }
                changed
            });
        });
    }
    if kind == "opencode" {
        let ch = channel.clone();
        tauri::async_runtime::spawn(async move { opencode_loop(ch).await });
    }
    if let Some((port, token, _)) = codex {
        let ch = channel.clone();
        std::thread::spawn(move || codex_loop(ch, port, token));
    }
}

fn spawn_flusher(sink: Sink, ch: Arc<Channel>) {
    std::thread::spawn(move || {
        while !ch.stop.load(Ordering::Acquire) {
            if ch.dirty.swap(false, Ordering::AcqRel) {
                let snap = ch.tracker.lock().ok().map(|t| t.snap.clone());
                if let Some(snap) = snap {
                    sink(Some(snap));
                }
            }
            std::thread::sleep(EMIT_INTERVAL);
        }
        sink(None);
    });
}

fn feed(ch: &Channel, events: Vec<ChannelEvent>) {
    if events.is_empty() {
        return;
    }
    let now = now_ms();
    if let Ok(mut t) = ch.tracker.lock() {
        let mut changed = false;
        for ev in events {
            changed |= t.apply(ev, now);
        }
        if changed {
            ch.dirty.store(true, Ordering::Release);
        }
    }
}

/// 追加读文件：只处理完整的行；文件变短（被轮转）就从头读
fn tail_file(
    ch: &Channel,
    path: &Path,
    mut offset: u64,
    mut on_chunk: impl FnMut(&str, &mut Tracker, i64) -> bool,
) {
    let mut carry = String::new();
    while !ch.stop.load(Ordering::Acquire) {
        if let Ok(mut f) = std::fs::File::open(path) {
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            if len < offset {
                offset = 0;
                carry.clear();
            }
            if len > offset && f.seek(SeekFrom::Start(offset)).is_ok() {
                let mut buf = Vec::new();
                if f.take(len - offset).read_to_end(&mut buf).is_ok() {
                    offset += buf.len() as u64;
                    carry.push_str(&String::from_utf8_lossy(&buf));
                    if let Some(end) = carry.rfind('\n') {
                        let complete: String = carry.drain(..=end).collect();
                        let now = now_ms();
                        if let Ok(mut t) = ch.tracker.lock() {
                            if on_chunk(&complete, &mut t, now) {
                                ch.dirty.store(true, Ordering::Release);
                            }
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn basic_auth(password: &str) -> String {
    use base64::Engine;
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}"))
    )
}

async fn opencode_loop(ch: Arc<Channel>) {
    let (port, password) = match ch.replier.lock().ok().and_then(|r| match r.as_ref() {
        Some(Replier::OpenCode { port, password }) => Some((*port, password.clone())),
        _ => None,
    }) {
        Some(x) => x,
        None => return,
    };
    let client = match reqwest::Client::builder().no_proxy().build() {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut state = OpenCodeState::default();
    let started = Instant::now();
    while !ch.stop.load(Ordering::Acquire) {
        let resp = client
            .get(format!("http://127.0.0.1:{port}/event"))
            .header("Authorization", basic_auth(&password))
            .send()
            .await;
        let Ok(mut resp) = resp else {
            // TUI 的服务还没起来：开头 60 秒内重试，之后放慢
            let wait = if started.elapsed() < Duration::from_secs(60) {
                300
            } else {
                3000
            };
            tokio_sleep(wait).await;
            continue;
        };
        if !resp.status().is_success() {
            tokio_sleep(1000).await;
            continue;
        }
        let mut buf = String::new();
        while !ch.stop.load(Ordering::Acquire) {
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(end) = buf.find('\n') {
                        let line: String = buf.drain(..=end).collect();
                        if let Some(data) = line.trim_end().strip_prefix("data:") {
                            if let Ok(v) = serde_json::from_str::<Value>(data.trim()) {
                                feed(&ch, map_opencode(&v, &mut state));
                            }
                        }
                    }
                }
                _ => break,
            }
        }
        tokio_sleep(500).await;
    }
}

/// 异步里等一会儿（没有直接依赖 tokio，借阻塞线程池睡）
async fn tokio_sleep(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(ms))
    })
    .await;
}

fn codex_loop(ch: Arc<Channel>, port: u16, token: String) {
    // TUI 连上来之前服务就在了；这里连接失败只重试几次
    let mut stream = None;
    for _ in 0..20 {
        if ch.stop.load(Ordering::Acquire) {
            return;
        }
        if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
            if ws_handshake(&mut s, port, &token).is_ok() {
                stream = Some(s);
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let Some(stream) = stream else { return };
    let Ok(writer) = stream.try_clone() else { return };
    let writer = Arc::new(Mutex::new(writer));
    if let Ok(mut r) = ch.replier.lock() {
        *r = Some(Replier::Codex {
            stream: writer.clone(),
        });
    }
    let init = {
        let mut st = ch.codex.lock().unwrap_or_else(|e| e.into_inner());
        st.call(
            "initialize",
            json!({ "clientInfo": { "name": "mesa", "title": "Mesa", "version": env!("CARGO_PKG_VERSION") } }),
            "initialize",
        )
    };
    if ws_send(&writer, &init).is_err() {
        return;
    }
    let _ = ws_send(&writer, &json!({ "jsonrpc": "2.0", "method": "initialized" }));
    // 恢复的会话不一定广播 thread/started：没加入就隔一会儿问一次已加载的线程
    {
        let ch = ch.clone();
        let writer = writer.clone();
        std::thread::spawn(move || {
            for _ in 0..120 {
                if ch.stop.load(Ordering::Acquire) {
                    return;
                }
                let msg = {
                    let mut st = ch.codex.lock().unwrap_or_else(|e| e.into_inner());
                    if st.joined {
                        return;
                    }
                    st.call("thread/loaded/list", json!({}), "loaded")
                };
                if ws_send(&writer, &msg).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(1000));
            }
        });
    }
    let mut reader = stream;
    let pong_writer = writer.clone();
    let mut pong = move |payload: &[u8]| {
        let mut frame = ws_encode_text(payload);
        frame[0] = 0x8A;
        if let Ok(mut s) = pong_writer.lock() {
            let _ = s.write_all(&frame);
        }
    };
    while !ch.stop.load(Ordering::Acquire) {
        match ws_read_message(&mut reader, &mut pong) {
            Ok(Some(bytes)) => {
                let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
                    continue;
                };
                if std::env::var("MESA_CHANNEL_DEBUG").is_ok() {
                    eprintln!("codex← {}", v.to_string().chars().take(300).collect::<String>());
                }
                let (events, outgoing) = {
                    let mut st = ch.codex.lock().unwrap_or_else(|e| e.into_inner());
                    map_codex(&v, &mut st)
                };
                for msg in outgoing {
                    let _ = ws_send(&writer, &msg);
                }
                feed(&ch, events);
            }
            _ => break,
        }
    }
}

/// PTY 退出（或标签重启 Agent）：收掉旁路进程、连接与目录
pub(crate) fn close_for_pty(pty_id: &str) {
    let _ = close_channel(pty_id);
}

/// 收旁路；Windows 上返回收尾线程（应用退出时要等它杀完进程）
fn close_channel(pty_id: &str) -> Option<std::thread::JoinHandle<()>> {
    let ch = registry().lock().ok().and_then(|mut r| r.remove(pty_id))?;
    ch.stop.store(true, Ordering::Release);
    if let Ok(mut r) = ch.replier.lock() {
        if let Some(Replier::Codex { stream }) = r.take() {
            if let Ok(s) = stream.lock() {
                let _ = s.shutdown(std::net::Shutdown::Both);
            }
        }
    }
    let pid = ch.sidecar_pid.lock().ok().and_then(|mut p| p.take());
    #[cfg(windows)]
    {
        // Windows 上进程开着的文件删不掉（Codex app-server 的 stderr 就写在旁路目录里）：先杀进程树再删目录，
        // 句柄释放慢一拍就稍等重试
        let dir = ch.dir.clone();
        if pid.is_none() && dir.is_none() {
            return None;
        }
        Some(std::thread::spawn(move || {
            if let Some(pid) = pid {
                crate::pty::kill_process_tree(pid);
            }
            if let Some(dir) = dir {
                for _ in 0..10 {
                    if std::fs::remove_dir_all(&dir).is_ok() || !dir.exists() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }))
    }
    #[cfg(not(windows))]
    {
        if let Some(pid) = pid {
            std::thread::spawn(move || crate::pty::kill_process_tree(pid));
        }
        if let Some(dir) = &ch.dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        None
    }
}

/// 应用退出
pub(crate) fn shutdown_all() {
    let ids: Vec<String> = registry()
        .lock()
        .map(|r| r.keys().cloned().collect())
        .unwrap_or_default();
    let pending: Vec<_> = ids.iter().filter_map(|id| close_channel(id)).collect();
    // Windows：等收尾线程把 app-server 杀完再让应用退出（任务组是崩溃时的兜底），最多等 3 秒
    let deadline = Instant::now() + Duration::from_secs(3);
    for handle in pending {
        while !handle.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn channel_for_tab(tab_id: &str) -> Option<Arc<Channel>> {
    let tab = sanitize_tab(tab_id);
    registry()
        .lock()
        .ok()?
        .values()
        .find(|c| c.tab_id == tab)
        .cloned()
}

// ===== Tauri commands =====

/// 前端挂载 / 热更新后取一次当前快照（之后靠 chat-channel-<tabId> 事件）
#[tauri::command]
pub fn chat_channel_snapshot(tab_id: String) -> Option<ChannelSnapshot> {
    let ch = channel_for_tab(&tab_id)?;
    let snap = ch.tracker.lock().ok()?.snap.clone();
    Some(snap)
}

/// hooks 家（Claude Code）的回合在会话文件里已经收尾、旁路却还开着时收掉它：在审批菜单里拒绝工具或按 Esc 打断，
/// Claude 不触发 Stop hook，回合一直开着，聊天层挂着「正在回复」（2026-10-21 用户实测：拒绝两个工具后终端已结束、
/// 聊天层 1 分半仍在回复；三平台都有）。会话文件里有收尾标记（打断记一行 user「[Request interrupted…]」、
/// 一轮结束记 system/turn_duration），时间晚于这一轮开始才算。前端读会话文件时顺带问；收了返回 true
#[tauri::command]
pub fn chat_channel_settle_from_transcript(tab_id: String) -> bool {
    let Some(ch) = channel_for_tab(&tab_id) else {
        return false;
    };
    let (path, started) = {
        let Ok(t) = ch.tracker.lock() else {
            return false;
        };
        let open = t.snap.turn.as_ref().filter(|turn| turn.ended_at.is_none());
        match (t.snap.kind, open, t.snap.transcript_path.clone()) {
            ("hooks", Some(turn), Some(path)) if t.snap.agent == "claude-code" => (path, turn.started_at),
            _ => return false,
        }
    };
    // 只认这一轮开始之后的标记：上一轮的 turn_duration 一定早于这一轮的 UserPromptSubmit
    let Some(reason) = crate::sessions::claude_turn_end_after(Path::new(&path), started) else {
        return false;
    };
    feed(&ch, vec![ChannelEvent::TurnEnd { reason: Some(reason.into()) }]);
    true
}

/// 聊天层「等你决定」卡上点了按钮：经这家官方的回复通道送回（decision = allow | allow_always | deny）。
/// 只送用户点的那一项；终端里已经答过的，CLI 会回「已处理」并丢掉这条，不会出错。
#[tauri::command]
pub async fn chat_channel_reply(
    tab_id: String,
    request_id: String,
    decision: String,
) -> Result<(), String> {
    reply_impl(&tab_id, &request_id, &decision).await
}

async fn reply_impl(tab_id: &str, request_id: &str, decision: &str) -> Result<(), String> {
    let (tab_id, request_id, decision) = (tab_id.to_string(), request_id.to_string(), decision.to_string());
    let ch = channel_for_tab(&tab_id).ok_or("这个标签没有可回复的旁路")?;
    let allow = matches!(decision.as_str(), "allow" | "allow_always");
    let always = decision == "allow_always";
    if !allow && decision != "deny" {
        return Err(format!("不认识的选择: {decision}"));
    }
    enum Plan {
        Qwen(PathBuf),
        OpenCode(u16, String),
        Codex(Arc<Mutex<TcpStream>>),
    }
    let plan = {
        let r = ch.replier.lock().map_err(|_| "旁路已关闭")?;
        match r.as_ref() {
            Some(Replier::Qwen { input }) => Plan::Qwen(input.clone()),
            Some(Replier::OpenCode { port, password }) => Plan::OpenCode(*port, password.clone()),
            Some(Replier::Codex { stream }) => Plan::Codex(stream.clone()),
            None => return Err("这一家只能在终端菜单里回答".into()),
        }
    };
    match plan {
        Plan::Qwen(input) => {
            let line = json!({ "type": "confirmation_response", "request_id": request_id, "allowed": allow })
                .to_string();
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&input)
                .map_err(|e| format!("写入回复失败: {e}"))?;
            writeln!(f, "{line}").map_err(|e| format!("写入回复失败: {e}"))?;
        }
        Plan::OpenCode(port, password) => {
            let reply = if always {
                "always"
            } else if allow {
                "once"
            } else {
                "reject"
            };
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .map_err(|e| e.to_string())?;
            let resp = client
                .post(format!("http://127.0.0.1:{port}/permission/{request_id}/reply"))
                .header("Authorization", basic_auth(&password))
                .json(&json!({ "reply": reply }))
                .send()
                .await
                .map_err(|e| format!("回复失败: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("回复失败（{}）", resp.status()));
            }
        }
        Plan::Codex(stream) => {
            let (id, method) = {
                let st = ch.codex.lock().map_err(|_| "旁路已关闭")?;
                st.pending
                    .get(&request_id)
                    .cloned()
                    .ok_or("这条请求已经处理过了")?
            };
            let decision = match (allow, always) {
                (true, true) => "acceptForSession",
                (true, false) => "accept",
                (false, _) => "decline",
            };
            if !method.ends_with("requestApproval") {
                return Err("这类请求请在终端里回答".into());
            }
            ws_send(
                &stream,
                &json!({ "jsonrpc": "2.0", "id": id, "result": { "decision": decision } }),
            )?;
        }
    }
    // 卡片等 CLI 回「已处理」再撤；这里先标一下，免得用户连点
    if let Ok(mut t) = ch.tracker.lock() {
        if let Some(a) = t.snap.approval.as_mut() {
            if a.request_id.as_deref() == Some(request_id.as_str()) {
                a.replyable = false;
                ch.dirty.store(true, Ordering::Release);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker() -> Tracker {
        Tracker::new("tab-1", "claude-code", "hooks")
    }

    fn rec(line: &str) -> crate::hooks::HookRecord {
        crate::hooks::parse_log_records(line).into_iter().next().unwrap()
    }

    #[test]
    fn hooks_turn_lifecycle_with_approval_detail() {
        let mut t = tracker();
        let lines = [
            r#"1792430325 tab-1 {"session_id":"s1","transcript_path":"/p/s1.jsonl","hook_event_name":"SessionStart","source":"startup"}"#,
            r#"1792430340 tab-1 {"session_id":"s1","hook_event_name":"UserPromptSubmit","prompt":"跑一下"}"#,
            r#"1792430340 tab-1 {"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo mesa > mesa_probe.txt","description":"写一个探针文件"},"tool_use_id":"toolu_1"}"#,
            r#"1792430346 tab-1 {"session_id":"s1","hook_event_name":"Notification","message":"Claude needs your permission","notification_type":"permission_prompt"}"#,
        ];
        for (i, l) in lines.iter().enumerate() {
            for ev in map_hook(&rec(l)) {
                t.apply(ev, i as i64);
            }
        }
        assert_eq!(t.snap.session_id.as_deref(), Some("s1"));
        assert_eq!(t.snap.transcript_path.as_deref(), Some("/p/s1.jsonl"));
        let turn = t.snap.turn.clone().unwrap();
        assert_eq!(turn.status, "awaiting_approval");
        let a = t.snap.approval.clone().unwrap();
        assert_eq!(a.kind, "execute");
        assert_eq!(a.command.as_deref(), Some("echo mesa > mesa_probe.txt"));
        assert_eq!(a.detail.as_deref(), Some("写一个探针文件"));
        assert!(!a.replyable, "Claude 的审批只能在终端菜单里答");
        // 批准后工具结束 → 回到运行中；Stop → 完成
        for l in [
            r#"1792430348 tab-1 {"session_id":"s1","hook_event_name":"PostToolUse","tool_name":"Bash","tool_use_id":"toolu_1"}"#,
        ] {
            for ev in map_hook(&rec(l)) {
                t.apply(ev, 10);
            }
        }
        assert!(t.snap.approval.is_none());
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "running");
        for ev in map_hook(&rec(r#"1792430349 tab-1 {"session_id":"s1","hook_event_name":"Stop","stop_hook_active":false}"#)) {
            t.apply(ev, 11);
        }
        let turn = t.snap.turn.clone().unwrap();
        assert_eq!(turn.status, "completed");
        assert_eq!(turn.ended_at, Some(11));
        // 重复的结束不再改动
        assert!(!t.apply(ChannelEvent::TurnEnd { reason: None }, 12));
    }

    #[test]
    fn clear_switches_session_and_bumps_seq() {
        let mut t = tracker();
        t.apply(
            ChannelEvent::Session { id: "a".into(), path: Some("/a.jsonl".into()), source: Some("startup".into()) },
            0,
        );
        assert_eq!(t.snap.session_seq, 0);
        t.apply(
            ChannelEvent::Session { id: "b".into(), path: Some("/b.jsonl".into()), source: Some("clear".into()) },
            1,
        );
        assert_eq!(t.snap.session_seq, 1);
        assert_eq!(t.snap.transcript_path.as_deref(), Some("/b.jsonl"));
        assert_eq!(t.snap.session_source.as_deref(), Some("clear"));
        // 同一会话再报一次（compact）不算换
        t.apply(
            ChannelEvent::Session { id: "b".into(), path: Some("/b.jsonl".into()), source: Some("compact".into()) },
            2,
        );
        assert_eq!(t.snap.session_seq, 1);
    }

    #[test]
    fn idle_notification_is_not_an_approval() {
        let r = rec(r#"1 tab-1 {"session_id":"s","hook_event_name":"Notification","message":"Claude is waiting for your input","notification_type":"idle_prompt"}"#);
        assert!(map_hook(&r).is_empty());
    }

    #[test]
    fn grok_shutdown_stop_is_ignored() {
        let r = rec(r#"1 tab-1 {"sessionId":"s","hookEventName":"stop","reason":"shutdown"}"#);
        assert!(map_hook(&r).is_empty());
        let r = rec(r#"1 tab-1 {"sessionId":"s","hookEventName":"stop","reason":"end_turn"}"#);
        assert_eq!(map_hook(&r).len(), 1);
    }

    #[test]
    fn qwen_dual_output_sequence() {
        // 2026-10-20 本机 Qwen 0.25.2 实录的事件顺序（channel-probe.py dual）
        let events = [
            json!({"type":"system","subtype":"session_start","session_id":"q1","data":{"session_id":"q1","protocol_version":2}}),
            json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"TRIGGER_TOOL 跑一下"}]}}),
            json!({"type":"stream_event","event":{"type":"message_start"}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好的"}}}),
            json!({"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"call_probe","name":"run_shell_command","input":{"command":"echo mesa > mesa_probe.txt"}}]}}),
            json!({"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"run_shell_command","tool_use_id":"call_probe","input":{"command":"echo mesa > mesa_probe.txt","description":"写一个探针文件"},"permission_suggestions":[{"type":"allow","label":"Allow Command","description":"Execute: echo mesa > mesa_probe.txt"}]}}),
        ];
        let mut t = Tracker::new("tab-q", "qwen", "qwen");
        for (i, e) in events.iter().enumerate() {
            for ev in map_qwen(e) {
                t.apply(ev, i as i64);
            }
        }
        assert_eq!(t.snap.session_id.as_deref(), Some("q1"));
        assert_eq!(t.snap.live_text.as_deref(), Some("好的"));
        let a = t.snap.approval.clone().unwrap();
        assert!(a.replyable);
        assert_eq!(a.request_id.as_deref(), Some("r1"));
        assert_eq!(a.command.as_deref(), Some("echo mesa > mesa_probe.txt"));
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "awaiting_approval");
        for e in [
            json!({"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"allowed":true}}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call_probe","content":"ok"}]}}),
            json!({"type":"stream_event","event":{"type":"message_start"}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}}),
            json!({"type":"assistant","message":{"stop_reason":null,"content":[{"type":"text","text":"done"}]}}),
        ] {
            for ev in map_qwen(&e) {
                t.apply(ev, 20);
            }
        }
        assert!(t.snap.approval.is_none());
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "completed");
        assert_eq!(t.snap.live_text.as_deref(), Some("好的\n\ndone"));
    }

    #[test]
    fn opencode_permission_and_idle() {
        let mut st = OpenCodeState::default();
        let mut t = Tracker::new("tab-o", "opencode", "opencode");
        // 2026-10-20 本机 OpenCode 1.19.3 实录（channel-probe.py opencode，OPENCODE_ASK=1）
        let events = [
            json!({"type":"session.created","properties":{"sessionID":"ses_1","info":{"id":"ses_1"}}}),
            json!({"type":"session.status","properties":{"sessionID":"ses_1","status":{"type":"busy"}}}),
            json!({"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_1","type":"text"},"time":1}}),
            json!({"type":"message.part.delta","properties":{"sessionID":"ses_1","messageID":"msg_1","partID":"prt_1","field":"text","delta":"你好"}}),
            json!({"type":"permission.asked","properties":{"id":"per_1","sessionID":"ses_1","permission":"bash","patterns":["echo mesa > mesa_probe.txt"],"metadata":{"command":"echo mesa > mesa_probe.txt"},"always":["echo *"],"tool":{"messageID":"msg_1","callID":"call_probe"}}}),
        ];
        for e in &events {
            for ev in map_opencode(e, &mut st) {
                t.apply(ev, 1);
            }
        }
        assert_eq!(t.snap.session_id.as_deref(), Some("ses_1"));
        assert_eq!(t.snap.live_text.as_deref(), Some("你好"));
        let a = t.snap.approval.clone().unwrap();
        assert_eq!(a.request_id.as_deref(), Some("per_1"));
        assert_eq!(a.command.as_deref(), Some("echo mesa > mesa_probe.txt"));
        assert!(a.replyable);
        for e in [
            json!({"type":"permission.replied","properties":{"sessionID":"ses_1","requestID":"per_1","reply":"once"}}),
            json!({"type":"session.idle","properties":{"sessionID":"ses_1"}}),
        ] {
            for ev in map_opencode(&e, &mut st) {
                t.apply(ev, 2);
            }
        }
        assert!(t.snap.approval.is_none());
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "completed");
        // 别的会话的事件不跟
        let other = json!({"type":"session.status","properties":{"sessionID":"ses_2","status":{"type":"busy"}}});
        assert!(map_opencode(&other, &mut st).is_empty());
    }

    #[test]
    fn codex_join_approval_and_turn_end() {
        let mut st = CodexState::default();
        let mut t = Tracker::new("tab-c", "codex", "codex");
        let mut apply = |msg: Value, st: &mut CodexState, t: &mut Tracker| {
            let (evs, send) = map_codex(&msg, st);
            for ev in evs {
                t.apply(ev, 1);
            }
            send
        };
        let send = apply(
            json!({"method":"thread/started","params":{"thread":{"id":"th1","path":"/r/rollout.jsonl","parentThreadId":null}}}),
            &mut st,
            &mut t,
        );
        assert_eq!(send.len(), 1);
        assert_eq!(send[0]["method"], "thread/resume");
        assert_eq!(t.snap.transcript_path.as_deref(), Some("/r/rollout.jsonl"));
        // 子 agent 的线程不跟
        apply(json!({"method":"thread/started","params":{"thread":{"id":"th2","parentThreadId":"th1"}}}), &mut st, &mut t);
        assert_eq!(t.snap.session_id.as_deref(), Some("th1"));
        apply(json!({"method":"turn/started","params":{"threadId":"th1","turn":{"id":"u1","status":"inProgress"}}}), &mut st, &mut t);
        apply(json!({"method":"item/started","params":{"threadId":"th1","turnId":"u1","item":{"type":"fileChange","id":"it1","changes":[{"path":"/w/a.txt","kind":"add","diff":"+hello"}]}}}), &mut st, &mut t);
        apply(json!({"id":7,"method":"item/fileChange/requestApproval","params":{"threadId":"th1","turnId":"u1","itemId":"it1","startedAtMs":1}}), &mut st, &mut t);
        let a = t.snap.approval.clone().unwrap();
        assert_eq!(a.request_id.as_deref(), Some("7"));
        assert_eq!(a.kind, "edit");
        assert_eq!(a.path.as_deref(), Some("/w/a.txt"));
        assert_eq!(a.diff.as_deref(), Some("+hello"), "只改一个文件不带路径行");
        assert!(st.pending.contains_key("7"));
        apply(json!({"method":"serverRequest/resolved","params":{"threadId":"th1","requestId":7}}), &mut st, &mut t);
        assert!(t.snap.approval.is_none());
        apply(json!({"method":"item/agentMessage/delta","params":{"threadId":"th1","turnId":"u1","itemId":"m1","delta":"done"}}), &mut st, &mut t);
        apply(json!({"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"u1","status":"completed"}}}), &mut st, &mut t);
        let turn = t.snap.turn.clone().unwrap();
        assert_eq!(turn.status, "completed");
        assert_eq!(turn.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(t.snap.live_text.as_deref(), Some("done"));
    }

    #[test]
    fn codex_file_change_marks_whole_file_add_and_delete() {
        // app-server FileUpdateChange：kind 是 {type}，新建 / 删除的 diff 是文件原文
        let a = approval_from_tool(
            "fileChange",
            &json!({"changes":[
                {"path":"/w/a.txt","kind":{"type":"add"},"diff":"apple\nbanana\n"},
                {"path":"/w/b.txt","kind":{"type":"delete"},"diff":"old\n"},
                {"path":"/w/c.txt","kind":{"type":"update","move_path":null},"diff":"@@ -1 +1 @@\n-x\n+y\n"},
            ]}),
        );
        assert_eq!(
            a.diff.as_deref(),
            Some("*** /w/a.txt\n+apple\n+banana\n*** /w/b.txt\n-old\n*** /w/c.txt\n@@ -1 +1 @@\n-x\n+y\n")
        );
        // 已带符号的不再补
        assert_eq!(mark_whole_file("+hello", '+'), "+hello");
        assert_eq!(mark_whole_file("", '+'), "");
    }

    #[test]
    fn codex_joins_resumed_thread_from_loaded_list() {
        let mut st = CodexState::default();
        let ask = st.call("thread/loaded/list", json!({}), "loaded");
        let id = ask["id"].clone();
        let (evs, send) = map_codex(&json!({"id": id, "result": {"data": ["th9"], "nextCursor": null}}), &mut st);
        assert!(matches!(&evs[0], ChannelEvent::Session { id, .. } if id == "th9"));
        assert_eq!(send[0]["method"], "thread/resume");
        assert!(st.joined);
    }

    /// 新线程第一条消息前没有 rollout，resume 报错；线程转为 active 时再订一次（2026-10-20 端到端实测）
    #[test]
    fn codex_resubscribes_when_thread_becomes_active() {
        let mut st = CodexState::default();
        let (_, send) = map_codex(&json!({"method":"thread/started","params":{"thread":{"id":"th1"}}}), &mut st);
        let rid = send[0]["id"].clone();
        map_codex(&json!({"id": rid, "error": {"code": -32600, "message": "no rollout found for thread id th1"}}), &mut st);
        assert!(!st.subscribed);
        let (evs, send) = map_codex(
            &json!({"method":"thread/status/changed","params":{"threadId":"th1","status":{"type":"active","activeFlags":[]}}}),
            &mut st,
        );
        assert_eq!(evs, vec![ChannelEvent::TurnStart]);
        assert_eq!(send[0]["method"], "thread/resume");
        let rid = send[0]["id"].clone();
        map_codex(&json!({"id": rid, "result": {"thread": {"id": "th1", "path": "/r/x.jsonl"}}}), &mut st);
        assert!(st.subscribed);
        let (_, send) = map_codex(
            &json!({"method":"thread/status/changed","params":{"threadId":"th1","status":{"type":"active"}}}),
            &mut st,
        );
        assert!(send.is_empty(), "订上了就不再重复订");
        let (evs, _) = map_codex(
            &json!({"method":"thread/status/changed","params":{"threadId":"th1","status":{"type":"idle"}}}),
            &mut st,
        );
        assert!(matches!(evs[0], ChannelEvent::TurnEnd { .. }));
    }

    #[test]
    fn codebuddy_repl_tool_shows_code() {
        let a = approval_from_tool("REPL", &json!({"code": "return await Bash({ command: \"ls\" })"}));
        assert_eq!(a.kind, "execute");
        assert!(a.command.unwrap().contains("Bash"));
    }

    #[test]
    fn split_codex_args_routes_config_to_server() {
        let args: Vec<String> = [
            "resume", "abc", "-c", "model_provider=\"ccode\"", "-m", "gpt", "--no-daemon", "--enable", "x", "-s",
            "workspace-write",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let (server, tui) = split_codex_args(&args, 4242);
        // 恢复时权限参数改成 app-server 配置（远程 TUI 恢复时拒收）
        assert_eq!(
            server,
            vec!["-c", "model_provider=\"ccode\"", "--enable", "x", "-c", "sandbox_mode=\"workspace-write\""]
        );
        assert_eq!(
            tui,
            vec![
                "resume",
                "abc",
                "--remote",
                "ws://127.0.0.1:4242",
                "--remote-auth-token-env",
                "CCODE_CODEX_TOKEN",
                "-m",
                "gpt",
            ]
        );
        // 新开会话照旧让 TUI 带权限参数（端到端验过）
        let fresh: Vec<String> = ["-s", "workspace-write", "-a", "on-request"].iter().map(|s| s.to_string()).collect();
        let (server, tui) = split_codex_args(&fresh, 1);
        assert!(server.is_empty());
        assert!(tui.ends_with(&fresh));
        let full: Vec<String> = ["resume", "x", "--dangerously-bypass-approvals-and-sandbox"].iter().map(|s| s.to_string()).collect();
        let (server, _) = split_codex_args(&full, 1);
        assert_eq!(server, vec!["-c", "approval_policy=\"never\"", "-c", "sandbox_mode=\"danger-full-access\""]);
        let (_, tui) = split_codex_args(&["-m".to_string(), "x".to_string()], 1);
        assert_eq!(tui[0], "--remote");
    }

    #[test]
    fn merge_settings_hooks_inline_and_missing() {
        let hooks = json!({"hooks": {"Stop": []}});
        let mut args = vec!["--model".to_string(), "x".to_string()];
        assert!(merge_settings_hooks(&mut args, &hooks));
        assert_eq!(args[0], "--settings");
        assert_eq!(serde_json::from_str::<Value>(&args[1]).unwrap(), hooks);
        let mut args = vec!["--settings".to_string(), r#"{"env":{"A":"1"}}"#.to_string()];
        assert!(merge_settings_hooks(&mut args, &hooks));
        let v: Value = serde_json::from_str(&args[1]).unwrap();
        assert_eq!(v["env"]["A"], "1");
        assert!(v["hooks"]["Stop"].is_array());
    }

    #[test]
    fn merge_settings_hooks_rewrites_override_file() {
        let dir = std::env::temp_dir().join(format!("cc-chan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("claude-settings.json");
        std::fs::write(&f, r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"k"}}"#).unwrap();
        let mut args = vec!["--settings".to_string(), f.to_string_lossy().into_owned()];
        assert!(merge_settings_hooks(&mut args, &json!({"hooks": {"Stop": []}})));
        assert_eq!(args[1], f.to_string_lossy());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "k");
        assert!(v["hooks"].is_object());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn ws_frame_roundtrip_unmasks_and_joins_fragments() {
        // 客户端帧带掩码，按服务端视角解回原文
        let frame = ws_encode_text(br#"{"a":1}"#);
        let mut pongs = 0;
        let got = ws_read_message(&mut &frame[..], &mut |_| pongs += 1).unwrap().unwrap();
        assert_eq!(got, br#"{"a":1}"#);
        // 服务端分片（不带掩码）+ 中间夹一个 ping
        let mut data = vec![0x01, 3];
        data.extend_from_slice(b"abc");
        data.extend_from_slice(&[0x89, 0]);
        data.extend_from_slice(&[0x80, 2]);
        data.extend_from_slice(b"de");
        let got = ws_read_message(&mut &data[..], &mut |_| pongs += 1).unwrap().unwrap();
        assert_eq!(got, b"abcde");
        assert_eq!(pongs, 1);
        // 长度 126 档
        let long = vec![b'x'; 300];
        let frame = ws_encode_text(&long);
        let got = ws_read_message(&mut &frame[..], &mut |_| {}).unwrap().unwrap();
        assert_eq!(got.len(), 300);
    }

    #[test]
    fn approval_from_tool_shapes() {
        let a = approval_from_tool(
            "Edit",
            &json!({"file_path":"/w/a.rs","old_string":"x","new_string":"y"}),
        );
        assert_eq!((a.kind, a.path.as_deref(), a.old_text.as_deref(), a.new_text.as_deref()), ("edit", Some("/w/a.rs"), Some("x"), Some("y")));
        let a = approval_from_tool("run_shell_command", &json!({"command":"ls"}));
        assert_eq!(a.kind, "execute");
        let a = approval_from_tool("mcp__srv__tool", &json!({"q":"x"}));
        assert_eq!(a.kind, "other");
        assert!(a.detail.unwrap().contains("\"q\""));
        let long = "z".repeat(PREVIEW_CAP + 10);
        let a = approval_from_tool("Bash", &json!({ "command": long }));
        assert!(a.command.unwrap().contains("后面还有"));
    }

    fn tool(id: &str, name: &str, input: Value) -> ChannelEvent {
        ChannelEvent::ToolStart { call_id: Some(id.into()), name: name.into(), input }
    }

    fn end(id: &str) -> ChannelEvent {
        ChannelEvent::ToolEnd { call_id: Some(id.into()) }
    }

    fn notification() -> ChannelEvent {
        ChannelEvent::ApprovalAsked {
            request_id: None,
            call_id: None,
            name: None,
            input: Value::Null,
            replyable: false,
            detail: Some("Claude needs your permission to use Bash".into()),
        }
    }

    fn permission_request(name: &str, input: Value) -> ChannelEvent {
        ChannelEvent::ApprovalAsked {
            request_id: None,
            call_id: None,
            name: Some(name.into()),
            input,
            replyable: false,
            detail: None,
        }
    }

    /// Windows 上 Claude 的 hooks 后台跑（每个约一秒才落日志）：「等批准」先于它那个工具的 PreToolUse 到、
    /// 上一个工具的 PostToolUse 晚到，卡片仍要显示对的命令、不被晚到的结束撤掉
    #[test]
    fn async_hooks_tolerate_out_of_order_approval() {
        let mut t = tracker();
        t.async_hooks = true;
        let read = json!({"file_path": "/w/a.rs"});
        let bash = json!({"command": "echo mesa > mesa_probe.txt"});
        t.apply(ChannelEvent::TurnStart, 1);
        t.apply(tool("A", "Read", read.clone()), 2);
        t.apply(notification(), 3);
        let a = t.snap.approval.clone().unwrap();
        assert_eq!(a.command, None, "不拿上一个工具（读文件）充数");
        assert_eq!(a.detail.as_deref(), Some("Claude needs your permission to use Bash"));
        t.apply(end("A"), 4);
        assert!(t.snap.approval.is_some(), "晚到的上一个工具结束不撤卡");
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "awaiting_approval");
        t.apply(tool("B", "Bash", bash.clone()), 5);
        assert_eq!(t.snap.approval.as_ref().unwrap().command.as_deref(), Some("echo mesa > mesa_probe.txt"));
        t.apply(permission_request("Bash", bash.clone()), 6);
        assert_eq!(t.snap.approval.as_ref().unwrap().command.as_deref(), Some("echo mesa > mesa_probe.txt"));
        t.apply(end("B"), 7);
        assert!(t.snap.approval.is_none(), "对上的工具结束 = 答完");
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "running");
        t.apply(ChannelEvent::TurnEnd { reason: Some("end_turn".into()) }, 8);
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "completed");
    }

    /// 结束事件比开始事件先到：PermissionRequest 给了内容，PostToolUse 先到不算（还对不上），PreToolUse 晚到时对上 → 答完
    #[test]
    fn async_hooks_tool_end_before_start() {
        let mut t = tracker();
        t.async_hooks = true;
        let bash = json!({"command": "ls"});
        t.apply(ChannelEvent::TurnStart, 1);
        t.apply(permission_request("Bash", bash.clone()), 2);
        assert_eq!(t.snap.approval.as_ref().unwrap().command.as_deref(), Some("ls"));
        t.apply(notification(), 3);
        assert_eq!(t.snap.approval.as_ref().unwrap().command.as_deref(), Some("ls"), "一句话的提示不覆盖已有内容");
        t.apply(end("B"), 4);
        assert!(t.snap.approval.is_some());
        t.apply(tool("B", "Bash", bash), 5);
        assert!(t.snap.approval.is_none());
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "running");
        // 另一个不相干的工具开始不会凭空出卡
        t.apply(tool("C", "Read", json!({"file_path": "/x"})), 6);
        assert!(t.snap.approval.is_none());
    }

    /// 同步 hooks（macOS / Linux 与其余家）照旧：等批准时用上一个工具补内容
    #[test]
    fn sync_hooks_keep_last_tool_fallback() {
        let mut t = tracker();
        t.apply(ChannelEvent::TurnStart, 1);
        t.apply(tool("B", "Bash", json!({"command": "ls"})), 2);
        t.apply(notification(), 3);
        assert_eq!(t.snap.approval.as_ref().unwrap().command.as_deref(), Some("ls"));
        t.apply(end("B"), 4);
        assert!(t.snap.approval.is_none());
    }

    #[test]
    fn session_path_drops_windows_verbatim_prefix() {
        let mut t = tracker();
        t.apply(
            ChannelEvent::Session { id: "a".into(), path: Some(r"\\?\C:\Users\x\.codex\r.jsonl".into()), source: None },
            0,
        );
        assert_eq!(t.snap.transcript_path.as_deref(), Some(r"C:\Users\x\.codex\r.jsonl"));
        t.apply(ChannelEvent::Session { id: "a".into(), path: Some("/Users/x/r.jsonl".into()), source: None }, 1);
        assert_eq!(t.snap.transcript_path.as_deref(), Some("/Users/x/r.jsonl"), "POSIX 路径原样");
    }

    #[test]
    fn live_text_resets_each_turn() {
        let mut t = tracker();
        t.apply(ChannelEvent::TurnStart, 1);
        t.apply(ChannelEvent::TextDelta("一".into()), 1);
        t.apply(ChannelEvent::TurnEnd { reason: None }, 2);
        t.apply(ChannelEvent::TurnStart, 3);
        assert!(t.snap.live_text.is_none());
        assert_eq!(t.snap.turn.as_ref().unwrap().seq, 2);
    }
}

/// 端到端：真 CLI + 假网关（scripts/e2e-model-routing/gateway.py），跑 Mesa 自己的 prepare / 旁路读取 / 回复，
/// 看快照里会话、回合、审批是否都对得上。临时 HOME（Windows 另设 USERPROFILE / CODEX_HOME）+ 测试配置根，
/// 不碰真实会话目录与 Mesa 配置。三平台同一份（2026-10-20 Windows 补齐：起 CLI 走 process::pty_command 认 .cmd shim、
/// 收尾按进程树杀）。先起假网关并生成计划（见 scripts/e2e-model-routing/README.md「聊天层结构化旁路」），再：
/// `MESA_E2E_REAL_CLI=1 E2E_PLANS=/tmp/e2e-plans.json E2E_AGENT=qwen cargo test --lib e2e_channel -- --ignored --nocapture`
#[cfg(test)]
mod e2e {
    use super::*;
    use portable_pty::{native_pty_system, PtySize};

    const COPY: &[&str] = &[
        ".claude/settings.json", ".claude.json", ".codex/config.toml", ".grok/config.toml",
        ".qwen/settings.json", ".kimi-code/config.toml", ".config/opencode/opencode.json",
        ".gemini/settings.json", ".codebuddy/settings.json",
    ];

    struct Run {
        done: bool,
        last: ChannelSnapshot,
        statuses: Vec<String>,
        approval: Option<ApprovalDto>,
        answered: Option<String>,
        cleared: Option<(Option<String>, Option<String>, Option<String>)>,
        /// E2E_ARG_PROMPT：启动参数里的首条消息是否原样进了会话
        arg_prompt_ok: Option<bool>,
    }

    /// 拉起一次、发「跑命令」、按快照答审批，等这一轮走完；clear = 走完再发 /clear 看会话跟随
    #[allow(clippy::too_many_arguments)]
    fn run_once(
        agent: &str,
        bin: &Path,
        home: &Path,
        work: &Path,
        mut args: Vec<String>,
        env: &[(String, String)],
        env_remove: &[String],
        clear: bool,
        // 假网关见到历史里已有这条工具结果就直接回 done（接回那一轮不再跑命令）：只看回合走完
        need_probe: bool,
    ) -> Run {
        let cwd = work.to_string_lossy().into_owned();
        let (extra, prepared) = prepare(agent, Some("e2e-tab"), &cwd, bin, &mut args, env, env_remove);
        let prepared = prepared.expect("这家应当接上旁路");
        // E2E_ARG_PROMPT=1：首条消息照 Mesa 快速开聊的做法放进启动参数（位置参数，必须最后），
        // 带换行、引号、|、%变量%、^——Windows 经 .cmd 包装时这些会被 cmd 拆坏
        let arg_prompt = (std::env::var("E2E_ARG_PROMPT").is_ok()
            && matches!(agent, "claude-code" | "codebuddy"))
        .then(|| "TRIGGER_TOOL 跑一下\n第二行 \"a|b\" 100%PATH% x^2".to_string());
        if let Some(p) = &arg_prompt {
            args.push(p.clone());
        }
        println!("{agent}: 旁路 {}，参数 {:?}", prepared.kind, args);
        let pair = native_pty_system()
            .openpty(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = crate::process::pty_command(bin, &args);
        cmd.cwd(work);
        for (k, _) in std::env::vars() {
            if k.starts_with("CLAUDE_CODE_") || k.starts_with("ANTHROPIC_") || k == "CLAUDECODE"
                || k.to_lowercase().ends_with("_proxy")
            {
                cmd.env_remove(k);
            }
        }
        for k in env_remove {
            cmd.env_remove(k);
        }
        cmd.env("HOME", home);
        cmd.env("NO_PROXY", "127.0.0.1");
        cmd.env("TERM", "xterm-256color");
        cmd.env("GEMINI_CLI_TRUST_WORKSPACE", "true");
        for (k, v) in env.iter().chain(extra.iter()) {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        #[cfg(windows)]
        let child_pid = child.process_id();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let screen = Arc::new(Mutex::new(String::new()));
        {
            let (screen, writer) = (screen.clone(), writer.clone());
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    // 终端查询照 Mesa 的口径应答（src/terminal-protocols.ts 的子集）
                    let mut w = writer.lock().unwrap();
                    if chunk.contains("\x1b[c") || chunk.contains("\x1b[0c") {
                        let _ = w.write_all(b"\x1b[?1;2c");
                    }
                    if chunk.contains("\x1b[6n") {
                        let _ = w.write_all(b"\x1b[1;1R");
                    }
                    for q in ["\x1b]10;?", "\x1b]11;?"] {
                        if chunk.contains(q) {
                            let _ = w.write_all(format!("{}rgb:2828/2c2c/3434\x1b\\", &q[..5]).as_bytes());
                        }
                    }
                    drop(w);
                    let mut s = screen.lock().unwrap();
                    s.push_str(&chunk);
                    let len = s.len();
                    if len > 200_000 {
                        let cut = (len - 100_000..len).find(|i| s.is_char_boundary(*i)).unwrap();
                        s.drain(..cut);
                    }
                }
            });
        }
        let snaps: Arc<Mutex<Vec<ChannelSnapshot>>> = Arc::default();
        {
            let snaps = snaps.clone();
            start_with_sink("e2e-pty", prepared, Arc::new(move |s| {
                if let Some(s) = s {
                    snaps.lock().unwrap().push(s);
                }
            }));
        }
        let send = |bytes: &[u8]| {
            let mut w = writer.lock().unwrap();
            let _ = w.write_all(bytes);
            let _ = w.flush();
        };
        std::thread::sleep(Duration::from_secs(9));
        for _ in 0..4 {
            let text = screen.lock().unwrap().clone();
            if text.contains("Make auto mode") {
                send(b"\x1b");
            } else if text.contains("Yes, I accept") {
                send(b"\x1b[B");
                std::thread::sleep(Duration::from_millis(300));
                send(b"\r");
            } else if text.contains("Trust this folder") || text.contains("Do you trust") || text.contains("Trust folder only") {
                send(b"\r");
            } else {
                break;
            }
            screen.lock().unwrap().clear();
            std::thread::sleep(Duration::from_millis(2500));
        }
        // E2E_DELETE_SETTINGS=1：模拟网关连接的 --settings 覆盖文件被 60 秒清理删掉，看 hooks 还到不到
        if std::env::var("E2E_DELETE_SETTINGS").is_ok() {
            if let Some(i) = args.iter().position(|a| a == "--settings") {
                let p = Path::new(&args[i + 1]);
                if p.is_file() {
                    println!("{agent}: 删掉 --settings 文件 {}", p.display());
                    let _ = std::fs::remove_file(p);
                }
            }
        }
        let probe = work.join("mesa_probe.txt");
        let _ = std::fs::remove_file(&probe);
        if arg_prompt.is_none() {
            // E2E_PROMPT：换触发词（如 Codex 去掉 TRIGGER_ESC = 沙箱里直接跑、不走审批）
            let prompt = std::env::var("E2E_PROMPT").unwrap_or_else(|_| {
                if agent == "codex" { "TRIGGER_TOOL TRIGGER_ESC 跑一下" } else { "TRIGGER_TOOL 跑一下" }.to_string()
            });
            send(prompt.as_bytes());
            // E2E_SUBMIT_GAP_MS：正文与回车的间隔，照聊天层发送（pty_input 的提交间隔）复现「字留在输入框」
            let gap = std::env::var("E2E_SUBMIT_GAP_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(400);
            std::thread::sleep(Duration::from_millis(gap));
            send(b"\r");
        }
        let started = Instant::now();
        let mut answered = None;
        let mut approval = None;
        let mut done = false;
        while started.elapsed() < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_millis(300));
            let last = snaps.lock().unwrap().last().cloned();
            let Some(last) = last else { continue };
            if let (Some(a), None) = (&last.approval, &answered) {
                approval = Some(a.clone());
                if a.replyable {
                    let id = a.request_id.clone().unwrap();
                    let r = tauri::async_runtime::block_on(reply_impl("e2e-tab", &id, "allow"));
                    answered = Some(format!("聊天层回复（{r:?}）"));
                } else if started.elapsed() > Duration::from_secs(3) {
                    send(b"\r");
                    answered = Some("终端菜单回车".into());
                }
            }
            let ran = last.turn.as_ref().is_some_and(|t| t.status == "completed");
            // 新进程的状态机从第 0 轮起算：走完一轮就是发的这句（回放的旧轮不算回合）
            if ran && (!need_probe || probe.exists()) {
                done = true;
                break;
            }
        }
        let mut cleared = None;
        if done && clear {
            let before = snaps.lock().unwrap().last().cloned().unwrap_or_default();
            send(b"/clear");
            std::thread::sleep(Duration::from_millis(400));
            send(b"\r");
            let t0 = Instant::now();
            while t0.elapsed() < Duration::from_secs(15) {
                std::thread::sleep(Duration::from_millis(300));
                let last = snaps.lock().unwrap().last().cloned().unwrap_or_default();
                if last.session_seq > before.session_seq {
                    cleared = Some((before.transcript_path.clone(), last.transcript_path.clone(), last.session_source.clone()));
                    break;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(500));
        let all = snaps.lock().unwrap().clone();
        let mut statuses: Vec<String> = Vec::new();
        for s in &all {
            let x = s.turn.as_ref().map(|t| t.status.to_string()).unwrap_or("-".into());
            if statuses.last() != Some(&x) {
                statuses.push(x);
            }
        }
        if !done {
            let text = screen.lock().unwrap().clone();
            let tail: String = text.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
            println!("{agent}: 屏幕尾部\n{}", tail.replace('\x1b', "␛"));
        }
        // 会话文件里的旁证：首条消息是否原样到达（E2E_ARG_PROMPT）、Claude 记下的 hook 耗时与整轮用时
        let mut arg_prompt_ok = None;
        let transcript = all
            .iter()
            .find_map(|s| s.transcript_path.clone())
            .and_then(|p| std::fs::read_to_string(p).ok())
            .unwrap_or_default();
        for line in transcript.lines() {
            let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
            match v.get("subtype").and_then(|x| x.as_str()) {
                Some("stop_hook_summary") => println!("{agent}: Stop hook {}", v["hookInfos"]),
                Some("turn_duration") => println!("{agent}: 整轮用时 {} ms", v["durationMs"]),
                _ => {}
            }
            if let (Some(p), None) = (&arg_prompt, arg_prompt_ok) {
                if v.get("type").and_then(|x| x.as_str()) == Some("user")
                    || v.get("role").and_then(|x| x.as_str()) == Some("user")
                {
                    // Claude 是字符串，CodeBuddy 是文本块数组
                    let content = v.pointer("/message/content").or_else(|| v.get("content"));
                    let text = match content {
                        Some(Value::String(s)) => Some(s.clone()),
                        Some(Value::Array(a)) => Some(
                            a.iter()
                                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                                .collect::<Vec<_>>()
                                .join(""),
                        ),
                        _ => None,
                    };
                    if let Some(text) = text.filter(|t| t.contains("TRIGGER_TOOL")) {
                        arg_prompt_ok = Some(text.contains(p.as_str()));
                        if !text.contains(p.as_str()) {
                            println!("{agent}: 首条消息到达时变成了 {text:?}");
                        }
                    }
                }
            }
        }
        close_for_pty("e2e-pty");
        // Windows 上 PTY 子进程常是 cmd / node 包装，只杀顶层会把真 CLI 留下
        #[cfg(windows)]
        if let Some(pid) = child_pid {
            crate::pty::kill_process_tree(pid);
        }
        let _ = child.kill();
        let _ = child.wait();
        Run { done, last: all.last().cloned().unwrap_or_default(), statuses, approval, answered, cleared, arg_prompt_ok }
    }

    fn report(agent: &str, label: &str, r: &Run) {
        println!("{agent}{label}: 会话 {:?} 文件 {:?}", r.last.session_id, r.last.transcript_path);
        println!("{agent}{label}: 回合状态变化 {:?}", r.statuses);
        println!("{agent}{label}: 审批 {:?}", r.approval.as_ref().map(|a| (a.kind, a.command.clone(), a.replyable)));
        println!("{agent}{label}: 答法 {:?}；实时文字 {:?}", r.answered, r.last.live_text);
        if r.cleared.is_some() {
            println!("{agent}{label}: /clear 之后 {:?}", r.cleared);
        }
        if r.arg_prompt_ok.is_some() {
            println!("{agent}{label}: 启动参数里的首条消息原样到达 {:?}", r.arg_prompt_ok);
        }
    }

    /// E2E_CLEAR=1：走完再发 /clear 看会话跟随；E2E_RESUME=1：停掉后按 Mesa 的恢复参数接回这段对话再跑一轮
    #[test]
    #[ignore]
    fn e2e_channel() {
        let plans: Value = serde_json::from_str(
            &std::fs::read_to_string(std::env::var("E2E_PLANS").expect("E2E_PLANS")).unwrap(),
        )
        .unwrap();
        let agent = std::env::var("E2E_AGENT").expect("E2E_AGENT");
        let plan = &plans[&agent];
        let real_home = dirs::home_dir().unwrap();
        let home = std::env::temp_dir().join(format!("mesa-e2e-{}", uuid::Uuid::new_v4().simple()));
        let work = home.join("work");
        std::fs::create_dir_all(&work).unwrap();
        for rel in COPY {
            let src = real_home.join(rel);
            if src.is_file() {
                let dst = home.join(rel);
                std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
                std::fs::copy(&src, &dst).unwrap();
            }
        }
        let cj = home.join(".claude.json");
        if cj.is_file() {
            let mut d: Value = serde_json::from_str(&std::fs::read_to_string(&cj).unwrap()).unwrap();
            let real = crate::paths::strip_verbatim(std::fs::canonicalize(&work).unwrap());
            for p in [work.clone(), real] {
                let s = p.to_string_lossy().into_owned();
                // Windows 上 Claude 以正斜杠路径作项目键
                for key in [s.clone(), s.replace('\\', "/")] {
                    d["projects"][key.as_str()] = json!({ "hasTrustDialogAccepted": true });
                }
            }
            std::fs::write(&cj, d.to_string()).unwrap();
        }
        // 状态日志、旁路目录、hook 脚本都落进测试配置根（storage::config_root 的测试接缝，线程局部：
        // prepare 在本线程算好路径交给读取线程）
        let _config = crate::storage::TestConfigRoot::redirect_to(&home.join("mesa-config"));
        // 去掉 --settings 时，拷来的用户 settings.json 里的 env（自己配的网关地址与钥匙）会盖过进程环境变量，
        // 请求打到用户真实的服务上：只留假网关
        if std::env::var("E2E_DROP_SETTINGS").is_ok() {
            let us = home.join(".claude").join("settings.json");
            if let Ok(mut v) = std::fs::read_to_string(&us).map(|t| serde_json::from_str::<Value>(&t).unwrap_or(json!({}))) {
                if let Some(o) = v.as_object_mut() {
                    o.remove("env");
                }
                std::fs::write(&us, v.to_string()).unwrap();
            }
        }
        // unix 的 CLI 跟 HOME；Windows 的 Node / Bun 系跟 USERPROFILE，Codex（Rust）只认 CODEX_HOME
        std::env::set_var("HOME", &home);
        let strs = |v: &Value| -> Vec<String> {
            v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
        };
        let tier = std::env::var("E2E_TIER").unwrap_or_else(|_| "ask".into());
        let mut args = if plan["permission"][&tier].is_array() {
            strs(&plan["permission"][&tier])
        } else {
            strs(&plan["args"])
        };
        // E2E_DROP_SETTINGS=1：去掉网关连接的 --settings，模拟官方账号启动（没有覆盖文件，hooks 要另起一份）
        if std::env::var("E2E_DROP_SETTINGS").is_ok() {
            if let Some(i) = args.iter().position(|a| a == "--settings") {
                args.drain(i..(i + 2).min(args.len()));
            }
        }
        let mut env: Vec<(String, String)> = plan["env"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (p[0].as_str().unwrap().to_string(), p[1].as_str().unwrap().to_string()))
            .collect();
        let home_s = home.to_string_lossy().into_owned();
        env.push(("HOME".into(), home_s.clone()));
        if cfg!(windows) {
            env.push(("USERPROFILE".into(), home_s.clone()));
            env.push(("CODEX_HOME".into(), home.join(".codex").to_string_lossy().into_owned()));
        }
        // 只打本机假网关：Codex 的 app-server 也从这份环境起，代理变量要一并绕开
        env.push(("NO_PROXY".into(), "127.0.0.1".into()));
        env.push(("no_proxy".into(), "127.0.0.1".into()));
        for k in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"] {
            std::env::remove_var(k);
        }
        let env_remove = strs(&plan["env_remove"]);
        let spec = crate::agent_specs::agent_spec(&agent).unwrap();
        let bin = crate::agents::resolve_binary(spec.binary).expect("装了这家 CLI");
        let clear = std::env::var("E2E_CLEAR").is_ok();
        let first = run_once(&agent, &bin, &home, &work, args.clone(), &env, &env_remove, clear, true);
        report(&agent, "", &first);
        let mut resumed = None;
        if first.done && std::env::var("E2E_RESUME").is_ok() {
            let sid = first.last.session_id.clone().expect("有会话 id 才能接回");
            let (prepend, resume) = crate::agents::resume_args(&agent, &sid);
            let mut again = Vec::new();
            if prepend {
                again.extend(resume.iter().cloned());
            }
            again.extend(args.iter().cloned());
            if !prepend {
                again.extend(resume.iter().cloned());
            }
            let r = run_once(&agent, &bin, &home, &work, again, &env, &env_remove, false, false);
            report(&agent, "（接回）", &r);
            resumed = Some((sid, r));
        }
        let _ = std::fs::remove_dir_all(&home);
        assert!(first.last.session_id.is_some(), "旁路认出会话");
        assert!(first.done, "这一轮走完且命令确实跑了：{:?}", first.statuses);
        if std::env::var("E2E_ARG_PROMPT").is_ok() && matches!(agent.as_str(), "claude-code" | "codebuddy") {
            assert_eq!(first.arg_prompt_ok, Some(true), "启动参数里的首条消息原样到达");
        }
        if clear {
            let (a, b, src) = first.cleared.expect("/clear 后旁路报出新会话");
            assert_ne!(a, b);
            assert_eq!(src.as_deref(), Some("clear"));
        }
        if let Some((sid, r)) = resumed {
            assert!(r.done, "接回后这一轮也走完：{:?}", r.statuses);
            assert_eq!(r.last.session_id.as_deref(), Some(sid.as_str()), "接回的是同一段对话");
        }
    }
}
